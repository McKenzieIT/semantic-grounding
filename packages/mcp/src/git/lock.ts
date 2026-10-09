/**
 * The corpus write lock — one exclusive lock over the whole corpus repository
 * (ADR-0004 ruling 7).
 *
 * ## Why repo-wide rather than per-file
 *
 * Ruling 7 closed this: a commit has to serialize at the repository level anyway,
 * because the index is global. Per-file locks would still funnel into one `git commit`,
 * so the finer granularity buys nothing and costs a deadlock-ordering problem.
 *
 * ## Why the lock lives in the git dir
 *
 * `<gitDir>/sg-write.lock`, not somewhere in the worktree. A lock file inside the
 * worktree would be corpus content: it would make `git status --porcelain` report a
 * dirty tree, so the startup posture check (ruling 6) would trip over the server's own
 * artifact, and `git add -A` would stage the lock into the audit commit. The git dir is
 * outside the tree git tracks, which is exactly the property needed.
 *
 * The path is resolved from `git rev-parse --absolute-git-dir` rather than joined as
 * `<corpusRoot>/.git`. The two agree in the ordinary case, which is what ADR-0004 wrote
 * down; they differ when `.git` is a *file* (a linked worktree), where joining produces
 * a path whose parent is not a directory and every acquisition fails with ENOTDIR.
 * Asking git also puts the lock in the per-worktree git dir, which is the right unit:
 * the index and HEAD this lock protects are per-worktree too.
 *
 * ## Why hand-rolled instead of `proper-lockfile`
 *
 * #19 left the choice open with a vendor-first preference, but expressiveness decided
 * it rather than taste. Ruling 6's startup table has to distinguish *dirty + lock whose
 * owner is dead* (crash residue: recover) from *dirty + lock whose owner is alive*
 * (a second server: refuse). Answering that needs the **owner pid in the lock record**.
 * `proper-lockfile` judges staleness from the lockfile's mtime alone and records no
 * owner, so it cannot express the distinction ruling 6 is built on — the branch would
 * have to collapse into a timeout, turning "another server is running" into "wait 15
 * seconds, then stomp it". So: a JSON record created with an atomic exclusive open.
 *
 * ## Liveness, and what the two signals are each good for
 *
 * A lock is abandoned if its owner process is **gone** or its **heartbeat is stale**.
 * The pid check is precise but only meaningful on the host that created the lock (pids
 * are not portable, and a shared-filesystem corpus could be locked from elsewhere), so
 * the record carries a host and the pid check is skipped when it differs. Heartbeat age
 * is the portable fallback and the only cross-host signal, at the cost of depending on
 * roughly-agreeing clocks. A recycled pid defeats the first check and is caught by the
 * second; a suspended process defeats the second and is caught by the first.
 *
 * @module git/lock
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { LockTimeoutError } from '../errors.ts'

/** The lock filename inside the git dir. */
export const LOCK_FILENAME = 'sg-write.lock'

/**
 * What one lock file contains. Written once at acquisition; `heartbeat_at` is rewritten
 * in place by the owner's heartbeat.
 */
export interface LockRecord {
  /** The owning process id — ruling 6's "is the owner still alive?" signal. */
  readonly pid: number
  /** The host that created the lock; the pid above is only meaningful there. */
  readonly host: string
  /** The agent declared at startup, so a refusal can name who holds the corpus. */
  readonly agent_id: string
  /** Unique per acquisition: guards release against unlinking a lock we no longer own. */
  readonly token: string
  /** Epoch ms at acquisition. */
  readonly acquired_at: number
  /** Epoch ms of the last heartbeat; staleness is measured from here. */
  readonly heartbeat_at: number
}

/** Why {@link CorpusLock.inspect} considers a lock holder unusable, or `alive`. */
export type OwnerState =
  /** Owner process is running (or is on another host and heartbeating). */
  | 'alive'
  /** Same host, and no process holds that pid — a crashed owner. */
  | 'dead'
  /** Heartbeat older than the staleness window — a wedged or killed-and-recycled owner. */
  | 'expired'

/** Tunables for {@link CorpusLock}; every default is overridable per ruling 7 ("可配"). */
export interface CorpusLockOptions {
  /**
   * How long {@link CorpusLock.acquire} waits before raising {@link LockTimeoutError}.
   * Ruling 7 specifies "10s 量级，可配".
   */
  readonly timeoutMs?: number
  /** Poll interval while waiting. Queuing is waiting on the lock; there is no application queue. */
  readonly pollIntervalMs?: number
  /** How often the owner refreshes `heartbeat_at` while holding. */
  readonly heartbeatIntervalMs?: number
  /** Heartbeat age past which a holder is judged {@link OwnerState} `expired`. */
  readonly staleAfterMs?: number
}

/** Defaults: see each field's doc on {@link CorpusLockOptions}. */
const DEFAULTS = {
  timeoutMs: 10_000,
  pollIntervalMs: 50,
  // 2s heartbeat against a 15s staleness window: ~7 missed beats before a live holder
  // is misjudged, which tolerates a GC pause or a briefly suspended process, while
  // still releasing a crashed corpus in well under the time it takes an operator to
  // notice. Long batch commits (`beginBatch`, #21) hold the lock for many beats, which
  // is why staleness is measured from the heartbeat and not from `acquired_at`.
  heartbeatIntervalMs: 2_000,
  staleAfterMs: 15_000,
} as const

/** A held lock. Release is idempotent; the second call is a no-op. */
export interface LockHandle {
  /** The record written at acquisition. */
  readonly record: LockRecord
  /** Release this acquisition (decrements the reentrancy depth; unlinks at depth 0). */
  release(): void
}

/**
 * The repo-wide corpus write lock.
 *
 * **Reentrant within one instance, exclusive across processes.** Reentrancy is not a
 * convenience: the critical section spans read-merge-write *through* commit (ruling 7),
 * so `runAudited` takes the lock and the `recordTier2Write` nested inside it takes the
 * lock again. Without a depth counter that nesting is a guaranteed self-deadlock, and
 * the alternative — making `recordTier2Write` assume a caller already holds the lock —
 * silently drops serialization for any host that wires the recorder into a write path
 * that does not go through `runAudited`.
 */
export class CorpusLock {
  /** Absolute path of the lock file. */
  readonly path: string
  private readonly opts: Required<CorpusLockOptions>
  private readonly agentId: string
  private depth = 0
  private held: LockRecord | undefined
  private heartbeat: NodeJS.Timeout | undefined

  /**
   * @param gitDir - the repository's git dir (from `git rev-parse --absolute-git-dir`).
   * @param agentId - the agent declared at startup, recorded so a refusal can name the holder.
   * @param opts - timeout / poll / heartbeat / staleness overrides.
   */
  constructor(gitDir: string, agentId: string, opts: CorpusLockOptions = {}) {
    this.path = join(gitDir, LOCK_FILENAME)
    this.agentId = agentId
    this.opts = {
      timeoutMs: opts.timeoutMs ?? DEFAULTS.timeoutMs,
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs,
      staleAfterMs: opts.staleAfterMs ?? DEFAULTS.staleAfterMs,
    }
  }

  /** Whether this instance currently holds the lock. */
  get isHeld(): boolean {
    return this.depth > 0
  }

  /**
   * Read the lock file.
   * @returns the current {@link LockRecord}, or null when no lock is present or the file
   *   is unreadable/unparseable (a truncated record means a crash mid-write, which is
   *   indistinguishable from — and treated as — an abandoned lock).
   */
  read(): LockRecord | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return null
      const r = parsed as Partial<LockRecord>
      if (typeof r.pid !== 'number' || typeof r.token !== 'string' || typeof r.heartbeat_at !== 'number') return null
      return {
        pid: r.pid,
        host: typeof r.host === 'string' ? r.host : '',
        agent_id: typeof r.agent_id === 'string' ? r.agent_id : '',
        token: r.token,
        acquired_at: typeof r.acquired_at === 'number' ? r.acquired_at : r.heartbeat_at,
        heartbeat_at: r.heartbeat_at,
      }
    } catch {
      return null
    }
  }

  /**
   * Judge a lock holder — the signal ruling 6's startup table branches on.
   * @param record - the holder's record, from {@link read}.
   * @param now - epoch ms to measure heartbeat age against (injectable for tests).
   * @returns `dead` when the owner pid is gone on this host, `expired` when its
   *   heartbeat aged out, otherwise `alive`.
   */
  inspect(record: LockRecord, now: number = Date.now()): OwnerState {
    if (record.host === hostname() && !isProcessAlive(record.pid)) return 'dead'
    if (now - record.heartbeat_at > this.opts.staleAfterMs) return 'expired'
    return 'alive'
  }

  /**
   * Remove the lock if its holder is abandoned — the recovery half of ruling 6's
   * dirty+dead-lock branch, also used by {@link acquire} while polling.
   * @returns the record that was removed, or null when there was no lock or its holder
   *   is alive (in which case the lock is left strictly alone).
   */
  breakIfAbandoned(): LockRecord | null {
    if (!existsSync(this.path)) return null
    const record = this.read()
    // An unparseable record is itself evidence of a crash mid-acquisition; nothing can
    // be alive behind it, so it is removed rather than left to block writes forever.
    if (record === null) {
      rmSync(this.path, { force: true })
      return null
    }
    if (this.inspect(record) === 'alive') return null
    rmSync(this.path, { force: true })
    return record
  }

  /**
   * Acquire the lock, waiting for a live holder to release it.
   *
   * Reentrant: when this instance already holds the lock, the depth is incremented and
   * no filesystem work happens.
   * @returns a {@link LockHandle}; call `release()` exactly once per acquire.
   * @throws LockTimeoutError when a live holder keeps the lock past `timeoutMs`.
   */
  async acquire(): Promise<LockHandle> {
    if (this.depth > 0) {
      this.depth += 1
      // `held` is always set alongside depth > 0; the cast-free fallback keeps the
      // return type honest without an assertion.
      const record = this.held
      if (record === undefined) throw new Error('corpus lock depth > 0 with no record — unreachable')
      return { record, release: () => this.releaseOne() }
    }

    const deadline = Date.now() + this.opts.timeoutMs
    for (;;) {
      const record = this.tryCreate()
      if (record !== null) {
        this.depth = 1
        this.held = record
        this.startHeartbeat()
        return { record, release: () => this.releaseOne() }
      }
      // Someone holds it. Abandoned holders are cleared immediately rather than waited
      // out — a crashed writer must not cost the next one the full timeout.
      const broken = this.breakIfAbandoned()
      if (broken !== null) continue
      if (Date.now() >= deadline) {
        const holder = this.read()
        throw new LockTimeoutError(
          `corpus write lock held by ${describeHolder(holder)} for longer than ${this.opts.timeoutMs}ms — the corpus is contended; retry the tool call`,
          {
            lock: this.path,
            waited_ms: this.opts.timeoutMs,
            ...holder !== null ? { holder: { pid: holder.pid, host: holder.host, agent_id: holder.agent_id } } : {},
          },
        )
      }
      await sleep(this.opts.pollIntervalMs)
    }
  }

  /**
   * Run `fn` while holding the lock, releasing it on every path.
   * @param fn - the critical section — for this package, read-merge-write through commit.
   * @returns whatever `fn` resolves to.
   * @throws LockTimeoutError when the lock cannot be acquired; anything `fn` throws, unchanged.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const handle = await this.acquire()
    try {
      return await fn()
    } finally {
      handle.release()
    }
  }

  /**
   * Release unconditionally, whatever the reentrancy depth — for a shutdown handler.
   *
   * The process lifecycle belongs to the server entry point (#22), so no exit hook is
   * installed here; this is the mechanism that hook should call. Forgetting it degrades
   * safely rather than wedging the corpus: the abandoned lock is broken on the next
   * acquisition, or reported as crash residue by the startup posture check.
   */
  releaseSync(): void {
    this.depth = 0
    this.stopHeartbeat()
    this.unlinkIfOurs()
    this.held = undefined
  }

  /** Decrement the reentrancy depth, unlinking the lock file at depth 0. */
  private releaseOne(): void {
    if (this.depth === 0) return
    this.depth -= 1
    if (this.depth > 0) return
    this.stopHeartbeat()
    this.unlinkIfOurs()
    this.held = undefined
  }

  /**
   * Atomically create the lock file, or report that someone else holds it.
   * @returns the record written, or null when the file already existed (EEXIST).
   */
  private tryCreate(): LockRecord | null {
    const now = Date.now()
    const record: LockRecord = {
      pid: process.pid,
      host: hostname(),
      agent_id: this.agentId,
      token: randomUUID(),
      acquired_at: now,
      heartbeat_at: now,
    }
    try {
      // `wx` is an atomic create-or-fail (O_CREAT|O_EXCL): the kernel, not this code,
      // decides who wins a race between two servers starting at the same moment.
      writeFileSync(this.path, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o644 })
      return record
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        // The git dir exists in every supported posture (the startup check proved it),
        // so this is a repository whose git dir was removed underneath a running
        // server. Recreate the directory and let the next iteration try again rather
        // than failing a write for a reason the operator cannot act on.
        mkdirSync(dirname(this.path), { recursive: true })
        return null
      }
      throw e
    }
  }

  /** Rewrite `heartbeat_at` so a live holder is not judged `expired` mid-batch. */
  private beat(): void {
    const current = this.held
    if (current === undefined) return
    const next: LockRecord = { ...current, heartbeat_at: Date.now() }
    try {
      // A plain rewrite, not an atomic replace: only the owner writes this file, and a
      // torn record reads back as null, which the inspector already treats as abandoned.
      writeFileSync(this.path, `${JSON.stringify(next)}\n`, { mode: 0o644 })
      this.held = next
    } catch {
      // The lock file was removed or became unwritable underneath us. Nothing useful to
      // do from a timer: the release path verifies ownership by token, and the next
      // acquisition re-establishes the lock.
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    const timer = setInterval(() => this.beat(), this.opts.heartbeatIntervalMs)
    // Never let the heartbeat be the reason the process stays alive — a stdio server
    // exits when its client closes stdin, and an unreleased timer would hang that exit.
    timer.unref()
    this.heartbeat = timer
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
  }

  /**
   * Unlink the lock only when it still carries our token.
   *
   * A lock judged abandoned by another process (a long stop-the-world pause can do it)
   * has already been broken and possibly re-acquired by someone else. Unlinking
   * unconditionally would then delete *their* lock and let a third writer in.
   */
  private unlinkIfOurs(): void {
    const ours = this.held
    if (ours === undefined) return
    const current = this.read()
    if (current !== null && current.token !== ours.token) return
    rmSync(this.path, { force: true })
  }
}

/**
 * Whether a pid is a live process on this host.
 * @param pid - the process id to probe.
 * @returns true when a process holds the pid. Signal 0 delivers nothing and only runs
 *   the kernel's permission/existence check: `ESRCH` is the only answer meaning "gone",
 *   while `EPERM` means the process exists under another user and is very much alive.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Describe a lock holder for an operator-facing message.
 * @param record - the holder's record, or null when the lock vanished while reporting.
 * @returns a short human-readable holder description.
 */
function describeHolder(record: LockRecord | null): string {
  if (record === null) return 'another process'
  const who = record.agent_id !== '' ? `agent ${record.agent_id}` : 'an unnamed agent'
  return `pid ${record.pid} on ${record.host || 'an unknown host'} (${who})`
}

/**
 * @param ms - milliseconds to wait.
 * @returns a promise resolving after `ms`.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * The unified scope registry — ADR-0011 ruling 2's single persistent artifact
 * (`~/.semantic-grounding/scopes.yaml` by default, `--registry`/`SG_REGISTRY` to
 * override, [#51](https://github.com/McKenzieIT/semantic-grounding/issues/51)).
 *
 * ## Why a file next to the home directory, and not inside any corpus
 *
 * The registry is **collection-level** state: it names every scope, not any one
 * scope's runtime. #44's draft anchored it inside a member corpus's git dir; #45's
 * ruling 2 superseded that — `sg-pending/`/`sg-write.lock` are precedents for
 * *single-repository runtime* state and were being stretched to a different genus.
 * A per-user file is the same trade `~/.gitconfig` makes, with the same recorded
 * residue: two OS users registering the same repo may diverge (ADR-0011
 * Consequences, "known residue, no worse than the rejected alternatives").
 *
 * ## Concurrency, three layers deep
 *
 * 1. **In-process**: every mutating op runs inside a promise-chain mutex, so two
 *    interleaved `await`s in one process cannot read-modify-write past each other
 *    (the same failure shape `concurrent-write.spec.ts` pins for the corpus).
 * 2. **Cross-process**: a lockfile next to the registry (`<registry>.lock`,
 *    `O_EXCL`-created, stolen when older than a staleness window) serializes
 *    register/deregister-default mutations across processes — dsh's
 *    `scopes.yaml` arrangement, per the ruling.
 * 3. **Atomic replace**: writes go to a temp file and `rename()` over the target,
 *    so a reader never sees a torn table. Readers take no lock at all.
 *
 * `active:` at the top of the file is **the next process's default, nothing more**
 * (ruling 9): each process reads it once at startup and lives in memory after
 * that; `switch_scope` updates its own binding and, in passing, the default.
 * "Where I was last" is shared like a shell cwd; "where I am" is per-process.
 *
 * Structurally implements substrate's `ScopeRegistryLike` (`active`/`activeId`/
 * `get`) — duck-typed, deliberately **not** handed to `setScopeRegistry`:
 * ADR-0011 constant 8 keeps per-scope cores on static roots, so the substrate's
 * registry delegation stays unmounted (zero substrate changes).
 *
 * YAML is parsed with `js-yaml` directly rather than through the substrate's
 * barrel because the barrel exposes no generic loader (ADR-0003's allow-list is
 * locked) and constant 8 forbids adding one for this file — the registry is an
 * MCP-management concern, not a substrate contract.
 *
 * @module scope-registry
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import yaml from 'js-yaml'
import { dumpYaml } from '@semantic-grounding/substrate'
import { ScopeIdConflictError, ScopeNotFoundError, ScopePathConflictError } from './errors.ts'

/** The charset a scope id must carry (ADR-0011 constant 6): conservative, trailer- and path-safe. */
export const SCOPE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** One registered scope as the registry stores and hands it out (constant 3: five fields, no free-form metadata in v1). */
export interface ScopeEntry {
  readonly id: string
  /** The scope's corpus/semantic root, as an absolute realpath captured at registration. */
  readonly semanticRoot: string
  /** The corpus config's `project.name`, captured at registration — the human-readable name for digests. */
  readonly name: string
  /** ISO-8601 timestamp of the registration. */
  readonly registeredAt: string
  /** The agent id of the registering process. */
  readonly registeredBy: string
}

/** The whole registry file, as one immutable snapshot. */
export interface ScopeRegistryState {
  /** The next process's default scope id, or null when unset. */
  readonly active: string | null
  /** Every registered scope, keyed by id. */
  readonly scopes: ReadonlyMap<string, ScopeEntry>
}

/** What {@link ScopeRegistryFile.register} decided. */
export interface RegisterResult {
  readonly entry: ScopeEntry
  /** True when the id+realpath pair was already registered — no write happened (idempotent adoption). */
  readonly alreadyRegistered: boolean
}

/** Options for {@link ScopeRegistryFile}'s constructor. */
export interface ScopeRegistryFileOptions {
  /** How long a writer waits for the cross-process lockfile before failing (default 10s). */
  readonly lockTimeoutMs?: number
}

/** The parsed YAML shape on disk; `active: null` serializes as an explicit null. */
interface RegistryFileShape {
  active?: string | null
  scopes?: Readonly<Record<string, Readonly<{ semanticRoot: string; name: string; registeredAt: string; registeredBy: string }>>>
}

/** The default registry location — see the module header for why it is not per-corpus. */
export function defaultRegistryPath(): string {
  return join(homedir(), '.semantic-grounding', 'scopes.yaml')
}

/** Validate one id against the charset (constant 6); throws with the rule in the message. */
export function assertScopeIdShape(id: string, errorFactory: (message: string) => Error): void {
  if (id.length < 1 || id.length > 64 || !SCOPE_ID_PATTERN.test(id)) {
    throw errorFactory(
      `scope id ${JSON.stringify(id)} is not shaped /^[a-z0-9][a-z0-9-]*$/ (1-64 chars) — the id rides the X-SG-Scope trailer and paths, so the charset stays conservative (ADR-0011 constant 6)`,
    )
  }
}

/**
 * The registry file: load, register, and default-active persistence under the
 * three concurrency layers of the module header.
 */
export class ScopeRegistryFile {
  private readonly path: string
  private readonly lockTimeoutMs: number
  /** Promise-chain mutex: every mutating op awaits the previous one's completion first. */
  private chain: Promise<unknown> = Promise.resolve()

  /**
   * @param path - the registry file's absolute path (default {@link defaultRegistryPath};
   *   tests and e2e point this at a temp file — writing a real `~` from a test is how
   *   CI machines grow state).
   * @param opts - lock tuning.
   */
  constructor(path: string, opts: ScopeRegistryFileOptions = {}) {
    this.path = path
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 10_000
  }

  /** The registry file path, for banners and diagnostics. */
  get location(): string {
    return this.path
  }

  /** @returns the current state, read fresh — atomic rename means no torn reads, so readers take no lock. */
  read(): ScopeRegistryState {
    return this.parse(this.readFileOrEmpty())
  }

  /** substrate `ScopeRegistryLike.active()` — the in-file default, not any process's live binding. */
  active(): { readonly id: string; readonly semanticRoot: string } | undefined {
    const state = this.read()
    const entry = state.active !== null ? state.scopes.get(state.active) : undefined
    return entry !== undefined ? { id: entry.id, semanticRoot: entry.semanticRoot } : undefined
  }

  /** substrate `ScopeRegistryLike.activeId()`. */
  activeId(): string | undefined {
    return this.read().active ?? undefined
  }

  /** substrate `ScopeRegistryLike.get()`. */
  get(id: string): { readonly id: string; readonly semanticRoot: string } | undefined {
    const entry = this.read().scopes.get(id)
    return entry !== undefined ? { id: entry.id, semanticRoot: entry.semanticRoot } : undefined
  }

  /** Like {@link get} but returning the full entry; the management tools' own lookup. */
  getEntry(id: string): ScopeEntry | undefined {
    return this.read().scopes.get(id)
  }

  /**
   * Register a scope: 1:1 in both directions, idempotent for the same id+realpath.
   *
   * Runs posture and corpus loading nowhere — those are the caller's (the
   * `register_scope` tool's) job *before* calling, per constant 2's fail-fast-at-the-
   * door ordering: a broken corpus must not enter the table.
   * @param input - the id, the already-realpath-resolved root, the captured name, the registering agent.
   * @returns the entry and whether it was already present.
   * @throws ScopeIdConflictError / ScopePathConflictError on the 1:1 halves.
   */
  async register(input: Readonly<{ id: string; semanticRoot: string; name: string; registeredBy: string }>): Promise<RegisterResult> {
    return this.enqueue(async () => {
      const existing = this.parse(this.readFileOrEmpty())
      const byId = existing.scopes.get(input.id)
      if (byId !== undefined) {
        if (byId.semanticRoot === input.semanticRoot) {
          return { entry: byId, alreadyRegistered: true }
        }
        throw new ScopeIdConflictError(
          `scope id "${input.id}" is already registered to ${byId.semanticRoot} — one id, one corpus (ADR-0011's 1:1)`,
          { existing: { id: byId.id, semantic_root: byId.semanticRoot } },
        )
      }
      for (const other of existing.scopes.values()) {
        if (other.semanticRoot === input.semanticRoot) {
          throw new ScopePathConflictError(
            `a scope is already registered for ${input.semanticRoot} as "${other.id}" — one corpus, one id (ADR-0011's 1:1)`,
            { existing: { id: other.id, semantic_root: other.semanticRoot } },
          )
        }
      }
      const entry: ScopeEntry = {
        id: input.id,
        semanticRoot: input.semanticRoot,
        name: input.name,
        registeredAt: new Date().toISOString(),
        registeredBy: input.registeredBy,
      }
      const next: ScopeRegistryState = { active: existing.active, scopes: new Map(existing.scopes).set(entry.id, entry) }
      await this.writeLocked(next)
      return { entry, alreadyRegistered: false }
    })
  }

  /**
   * Persist the next-process default (ruling 9). `null` clears it.
   * @param id - the scope to make the default, or null.
   * @throws ScopeNotFoundError when a non-null id is not registered.
   */
  async setActive(id: string | null): Promise<void> {
    return this.enqueue(async () => {
      const existing = this.parse(this.readFileOrEmpty())
      if (id !== null && !existing.scopes.has(id)) {
        throw new ScopeNotFoundError(`scope "${id}" is not registered — register_scope it before it can be the default`, { scope_id: id })
      }
      if (existing.active === id) return
      await this.writeLocked({ active: id, scopes: existing.scopes })
    })
  }

  /** @returns the lockfile path paired with the registry file. */
  private get lockPath(): string {
    return `${this.path}.lock`
  }

  /** Run `op` after every previously queued op — the in-process mutex layer. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op, op)
    this.chain = next.catch(() => undefined)
    return next
  }

  /** Read and parse, treating ENOENT as an empty registry (first write creates the directory). */
  private readFileOrEmpty(): string {
    try {
      return readFileSync(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw e
    }
  }

  /** Parse the YAML text into one immutable state snapshot; shape violations fail loud (see the substrate's own corrupt-yaml stance). */
  private parse(text: string): ScopeRegistryState {
    let raw: RegistryFileShape | undefined
    if (text.trim() !== '') {
      raw = yaml.load(text) as RegistryFileShape
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`scope registry ${this.path} is not a mapping — refusing to guess (intranet-security: a silently rebuilt table could point a scope id at the wrong corpus)`)
      }
    }
    const scopes = new Map<string, ScopeEntry>()
    for (const [id, value] of Object.entries(raw?.scopes ?? {})) {
      if (value === null || typeof value !== 'object' || typeof value.semanticRoot !== 'string' || typeof value.name !== 'string') {
        throw new Error(`scope registry ${this.path} entry "${id}" is malformed — refusing to guess (intranet-security)`)
      }
      scopes.set(id, {
        id,
        semanticRoot: value.semanticRoot,
        name: value.name,
        registeredAt: typeof value.registeredAt === 'string' ? value.registeredAt : '',
        registeredBy: typeof value.registeredBy === 'string' ? value.registeredBy : '',
      })
    }
    const active = typeof raw?.active === 'string' ? raw.active : null
    return { active, scopes }
  }

  /**
   * Serialize + atomically replace the registry under the cross-process lockfile.
   *
   * The dump goes through the substrate's own `dumpYaml` (on the barrel, on
   * ADR-0003's allow-list) so the file's formatting is exactly the corpus YAML
   * house style; only parsing needed a direct `js-yaml` dependency (see the module
   * header).
   */
  private async writeLocked(state: ScopeRegistryState): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true })
    const payload = dumpYaml({
      active: state.active,
      scopes: Object.fromEntries([...state.scopes.values()].map(e => [e.id, {
        semanticRoot: e.semanticRoot,
        name: e.name,
        registeredAt: e.registeredAt,
        registeredBy: e.registeredBy,
      }])),
    })
    const lock = await this.acquireLockfile()
    try {
      const tmp = join(tmpdir(), `sg-scopes-${process.pid}-${Math.random().toString(36).slice(2)}.yaml`)
      writeFileSync(tmp, payload, 'utf8')
      renameSync(tmp, this.path)
    } finally {
      lock.release()
    }
  }

  /**
   * The cross-process lockfile layer: `O_EXCL`-create `<registry>.lock`, poll until
   * acquired or timed out, steal a stale holder. Held for the duration of one
   * read-modify-write — never across a process lifetime. The poll is a real
   * `setTimeout` await, not a sync sleep: a contending writer must not freeze the
   * event loop that in-flight tool requests live on.
   */
  private async acquireLockfile(): Promise<{ release: () => void }> {
    const started = Date.now()
    // Staleness well above any legitimate holder (one write is bytes long) but well
    // below "operator notices": a crashed holder cannot wedge the registry for a day.
    const staleAfterMs = 30_000
    for (;;) {
      try {
        const fd = openSync(this.lockPath, 'wx')
        try {
          writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`, 'utf8')
        } finally {
          closeSync(fd)
        }
        let released = false
        return {
          release: () => {
            if (released) return
            released = true
            try {
              unlinkSync(this.lockPath)
            } catch {
              // Already gone — a stale-stealing peer cleaned up; nothing to assert.
            }
          },
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        let stolen = false
        try {
          const age = Date.now() - statSync(this.lockPath).mtimeMs
          if (age > staleAfterMs) {
            unlinkSync(this.lockPath)
            stolen = true
          }
        } catch {
          // The holder released between EEXIST and stat — fall through to the poll.
        }
        if (stolen) continue // retry the acquire immediately; the steal is the old holder's problem
        if (Date.now() - started > this.lockTimeoutMs) {
          throw new Error(`scope registry ${this.path} stayed locked by another process for over ${this.lockTimeoutMs}ms — refusing to wait blind (the lockfile at ${this.lockPath} can be removed if its holder is dead)`)
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
  }
}

/** Whether a registered root still exists on disk — `list_scopes`' `reachable:false` is a visible dead entry, not a blocker. */
export function scopeEntryReachable(entry: ScopeEntry): boolean {
  return existsSync(entry.semanticRoot)
}

/**
 * ADR-0004 ruling 7 — the repo-wide corpus write lock.
 *
 * Two properties matter and they pull against each other: the lock must be **strictly
 * exclusive** across processes (or two writers interleave a read-merge-write and lose an
 * update), and it must **never outlive its owner** (or one crash wedges the corpus until
 * a human intervenes). The owner-liveness tests are the ones that earn the hand-rolled
 * implementation — see the module header on `src/git/lock.ts` for why `proper-lockfile`
 * cannot express them.
 *
 * @see docs/adr/0004-git-tier2-audit-backbone.md ruling 7
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LockTimeoutError } from '../src/errors.ts'
import { CorpusLock, LOCK_FILENAME, type LockRecord } from '../src/git/lock.ts'
import { createFixtureCorpus, type FixtureCorpus } from './helpers/fixture-corpus.ts'

let fixture: FixtureCorpus
let gitDir: string
let lockPath: string

beforeEach(() => {
  fixture = createFixtureCorpus()
  gitDir = join(fixture.root, '.git')
  lockPath = join(gitDir, LOCK_FILENAME)
})
afterEach(() => fixture.cleanup())

/**
 * A pid that is certainly dead: spawn a process that exits immediately, then reuse its
 * pid. Cheaper and far more reliable than hoping a large constant is unallocated.
 * @returns the pid of a process that has already exited.
 */
function deadPid(): number {
  const res = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
  if (res.pid === undefined) throw new Error('could not spawn a probe process')
  return res.pid
}

/**
 * Write a lock file by hand, standing in for another process's lock.
 * @param overrides - fields to set on the record.
 * @returns the record written.
 */
function plantLock(overrides: Partial<LockRecord> = {}): LockRecord {
  const now = Date.now()
  const record: LockRecord = {
    pid: process.pid,
    host: hostname(),
    agent_id: 'other-agent',
    token: 'planted-token',
    acquired_at: now,
    heartbeat_at: now,
    ...overrides,
  }
  writeFileSync(lockPath, `${JSON.stringify(record)}\n`, 'utf8')
  return record
}

describe('the lock lives in the git dir, not the worktree', () => {
  // Load-bearing, not tidiness: a lock inside the worktree would make
  // `git status --porcelain` report a dirty tree, so the startup posture check would
  // trip over the server's own artifact and `git add -A` would stage the lock into the
  // audit commit.
  it('puts the lock file under .git', async () => {
    const lock = new CorpusLock(gitDir, 'agent-1')
    expect(lock.path).toBe(lockPath)
    const handle = await lock.acquire()
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: fixture.root, encoding: 'utf8' })
    expect(status.stdout.trim()).toBe('')
    handle.release()
  })
})

describe('exclusivity', () => {
  it('blocks a second holder and times out', async () => {
    const mine = new CorpusLock(gitDir, 'agent-1')
    const theirs = new CorpusLock(gitDir, 'agent-2', { timeoutMs: 150, pollIntervalMs: 10 })
    const handle = await mine.acquire()
    try {
      await expect(theirs.acquire()).rejects.toThrow(LockTimeoutError)
    } finally {
      handle.release()
    }
  })

  it('names the holder in the timeout, so a stuck corpus is diagnosable', async () => {
    const mine = new CorpusLock(gitDir, 'writer-agent')
    const theirs = new CorpusLock(gitDir, 'agent-2', { timeoutMs: 100, pollIntervalMs: 10 })
    const handle = await mine.acquire()
    try {
      await expect(theirs.acquire()).rejects.toThrow(/writer-agent/)
    } finally {
      handle.release()
    }
  })

  // Ruling 7 made queuing "waiting on the lock itself", so a timeout means the corpus is
  // genuinely contended. Marking it retryable would turn that into an invisible loop.
  it('reports a lock timeout as not-retryable', async () => {
    const mine = new CorpusLock(gitDir, 'agent-1')
    const theirs = new CorpusLock(gitDir, 'agent-2', { timeoutMs: 80, pollIntervalMs: 10 })
    const handle = await mine.acquire()
    try {
      await theirs.acquire()
      expect.unreachable('should have timed out')
    } catch (e) {
      expect(e).toBeInstanceOf(LockTimeoutError)
      expect((e as LockTimeoutError).retryable).toBe(false)
    } finally {
      handle.release()
    }
  })

  it('lets the next holder in once released', async () => {
    const a = new CorpusLock(gitDir, 'agent-1')
    const b = new CorpusLock(gitDir, 'agent-2', { timeoutMs: 500, pollIntervalMs: 10 })
    ;(await a.acquire()).release()
    const second = await b.acquire()
    expect(second.record.agent_id).toBe('agent-2')
    second.release()
  })
})

describe('reentrancy', () => {
  // The critical section spans read-merge-write through commit, so `runAudited` holds
  // the lock while the nested `recordTier2Write` takes it again. Without a depth
  // counter that nesting is a guaranteed self-deadlock.
  it('re-enters within one instance without deadlocking', async () => {
    const lock = new CorpusLock(gitDir, 'agent-1', { timeoutMs: 200 })
    const outcome = await lock.withLock(async () => lock.withLock(async () => 'inner ran'))
    expect(outcome).toBe('inner ran')
  })

  it('releases the file only when the outermost holder releases', async () => {
    const lock = new CorpusLock(gitDir, 'agent-1')
    const outer = await lock.acquire()
    const inner = await lock.acquire()
    inner.release()
    expect(existsSync(lockPath)).toBe(true)
    expect(lock.isHeld).toBe(true)
    outer.release()
    expect(existsSync(lockPath)).toBe(false)
    expect(lock.isHeld).toBe(false)
  })
})

describe('owner liveness — the signal ruling 6 branches on', () => {
  it('judges a lock whose owner process is gone as dead', () => {
    const lock = new CorpusLock(gitDir, 'agent-1')
    const record = plantLock({ pid: deadPid() })
    expect(lock.inspect(record)).toBe('dead')
  })

  it('judges a live owner with a fresh heartbeat as alive', () => {
    const lock = new CorpusLock(gitDir, 'agent-1')
    expect(lock.inspect(plantLock())).toBe('alive')
  })

  // The second signal exists for the case the first cannot catch: a pid that was
  // recycled by an unrelated process, or an owner on another host.
  it('judges a live pid with an aged heartbeat as expired', () => {
    const lock = new CorpusLock(gitDir, 'agent-1', { staleAfterMs: 1_000 })
    const record = plantLock({ heartbeat_at: Date.now() - 60_000 })
    expect(lock.inspect(record)).toBe('expired')
  })

  it('breaks an abandoned lock and acquires immediately', async () => {
    plantLock({ pid: deadPid() })
    const lock = new CorpusLock(gitDir, 'agent-1', { timeoutMs: 100, pollIntervalMs: 10 })
    const handle = await lock.acquire()
    expect(handle.record.agent_id).toBe('agent-1')
    handle.release()
  })

  it('leaves a live holder lock strictly alone', () => {
    const planted = plantLock()
    const lock = new CorpusLock(gitDir, 'agent-1')
    expect(lock.breakIfAbandoned()).toBeNull()
    expect(existsSync(lockPath)).toBe(true)
    expect(lock.read()?.token).toBe(planted.token)
  })

  // A truncated record is itself evidence of a crash mid-acquisition: nothing can be
  // alive behind it, and treating it as live would block writes forever.
  it('treats an unparseable record as abandoned', async () => {
    writeFileSync(lockPath, '{ truncated', 'utf8')
    const lock = new CorpusLock(gitDir, 'agent-1', { timeoutMs: 100, pollIntervalMs: 10 })
    expect(lock.read()).toBeNull()
    const handle = await lock.acquire()
    expect(handle.record.agent_id).toBe('agent-1')
    handle.release()
  })
})

describe('release is token-guarded', () => {
  // A holder that was judged abandoned (a long stop-the-world pause can do it) has had
  // its lock broken and possibly re-acquired by someone else. Unlinking unconditionally
  // would delete *their* lock and admit a third writer.
  it('does not delete a lock that was re-acquired by someone else', async () => {
    const lock = new CorpusLock(gitDir, 'agent-1')
    const handle = await lock.acquire()
    const usurper = plantLock({ token: 'someone-elses-token' })
    handle.release()
    expect(existsSync(lockPath)).toBe(true)
    expect(lock.read()?.token).toBe(usurper.token)
  })
})

describe('heartbeat', () => {
  it('refreshes the record so a long hold is not judged expired', async () => {
    const lock = new CorpusLock(gitDir, 'agent-1', { heartbeatIntervalMs: 20 })
    const handle = await lock.acquire()
    const first = JSON.parse(readFileSync(lockPath, 'utf8')) as LockRecord
    await new Promise(r => setTimeout(r, 90))
    const later = JSON.parse(readFileSync(lockPath, 'utf8')) as LockRecord
    handle.release()
    expect(later.heartbeat_at).toBeGreaterThan(first.heartbeat_at)
    expect(later.token).toBe(first.token)
  })
})

describe('releaseSync', () => {
  // The mechanism a shutdown hook calls. The lifecycle belongs to the entry point
  // (#22), so no exit hook is installed here.
  it('releases whatever the reentrancy depth', async () => {
    const lock = new CorpusLock(gitDir, 'agent-1')
    await lock.acquire()
    await lock.acquire()
    lock.releaseSync()
    expect(existsSync(lockPath)).toBe(false)
    expect(lock.isHeld).toBe(false)
  })
})

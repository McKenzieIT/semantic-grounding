/**
 * ADR-0004 rulings 5 and 6 — the startup posture checks.
 *
 * #19's acceptance names this directly: "启动检查四情形各有断言". Ruling 6's table is a
 * decision tree over two observations (is the worktree dirty, and is there a lock whose
 * owner is alive), and the reason it is a tree rather than a single rule is that both
 * simple answers were rejected:
 *
 * - auto-clean any dirty tree → a human's uncommitted edit is data loss;
 * - refuse any dirty tree → crash residue wedges the corpus until a human intervenes.
 *
 * A dead lock is the evidence that separates the two, so each branch gets its own test.
 *
 * @see docs/adr/0004-git-tier2-audit-backbone.md rulings 5 and 6
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PostureRefusedError } from '../src/errors.ts'
import { LOCK_FILENAME, type LockRecord } from '../src/git/lock.ts'
import { assertCorpusIsRepoRoot, ensureStartupPosture, resolveRepoPaths } from '../src/git/posture.ts'
import { createFixtureCorpus, fixtureGit, type FixtureCorpus } from './helpers/fixture-corpus.ts'

let fixture: FixtureCorpus
/** Collected recovery log lines — asserted on, and kept off the real stderr. */
let logged: string[]

beforeEach(() => {
  fixture = createFixtureCorpus()
  logged = []
})
afterEach(() => fixture.cleanup())

/**
 * Run the posture check against the fixture with the log captured.
 * @param agentId - the agent id recorded in any lock created.
 * @returns the posture report.
 */
function check(agentId = 'agent-1') {
  return ensureStartupPosture({
    corpusRoot: fixture.root,
    agentId,
    logger: line => logged.push(line),
  })
}

/**
 * @returns the pid of a process that has already exited.
 */
function deadPid(): number {
  const res = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
  if (res.pid === undefined) throw new Error('could not spawn a probe process')
  return res.pid
}

/**
 * Plant a lock file, standing in for another process's lock.
 * @param overrides - fields to set on the record.
 */
function plantLock(overrides: Partial<LockRecord> = {}): void {
  const now = Date.now()
  const record: LockRecord = {
    pid: process.pid,
    host: hostname(),
    agent_id: 'crashed-agent',
    token: 'planted',
    acquired_at: now,
    heartbeat_at: now,
    ...overrides,
  }
  writeFileSync(join(fixture.root, '.git', LOCK_FILENAME), `${JSON.stringify(record)}\n`, 'utf8')
}

/** Dirty the worktree by modifying a tracked file. */
function dirtyTracked(): void {
  const p = join(fixture.root, 'tables', 'dws_order.yaml')
  writeFileSync(p, `${readFileSync(p, 'utf8')}\n# hand edit\n`, 'utf8')
}

// ── Ruling 5: the corpus is its own repository, rooted at its own root ────

describe('ruling 5 — corpus must be its own git repository root', () => {
  it('refuses a corpus that is not a git repository, with `git init` as the remedy', async () => {
    const plain = createFixtureCorpus({ git: false })
    try {
      await expect(ensureStartupPosture({ corpusRoot: plain.root, agentId: 'a' })).rejects.toThrow(PostureRefusedError)
      await expect(ensureStartupPosture({ corpusRoot: plain.root, agentId: 'a' })).rejects.toThrow(/git init/)
    } finally {
      plain.cleanup()
    }
  })

  it('refuses a corpus nested inside a larger repository', async () => {
    // `git rev-parse --show-toplevel` from a subdirectory returns the OUTER repo root,
    // so audit commits would land in that repository's history and `git add -A` would
    // stage the whole monorepo.
    const nested = join(fixture.root, 'sub-corpus')
    mkdirSync(join(nested, 'tables'), { recursive: true })
    writeFileSync(join(nested, 'config.yaml'), 'scope_id: nested\n', 'utf8')
    await expect(ensureStartupPosture({ corpusRoot: nested, agentId: 'a' })).rejects.toThrow(/not a repository root/)
  })

  // Measured before this code was written: `--show-toplevel` returns a fully resolved
  // path, and the OS temp dir is reached through a symlink on macOS (`/var` ->
  // `/private/var`). A string comparison here rejects legitimate corpora — every
  // fixture in this suite is symlinked, so the whole file would fail on a regression.
  it('accepts a corpus root reached through a symlink', async () => {
    const paths = await resolveRepoPaths(fixture.root)
    expect(paths.toplevel).not.toBe(fixture.root) // the premise this test guards
    expect(() => assertCorpusIsRepoRoot(fixture.root, paths)).not.toThrow()
  })
})

// ── Ruling 6: four postures, four answers ────────────────────────────────

describe('ruling 6 case 1 — clean worktree starts', () => {
  it('reports a clean posture', async () => {
    const report = await check()
    expect(report.posture).toBe('clean')
    expect(report.recovery).toBeUndefined()
  })

  it('allows an unborn HEAD — the audit history legitimately begins at the first commit', async () => {
    const fresh = createFixtureCorpus({ baselineCommit: false })
    try {
      // Nothing is committed, so every file is untracked: that IS a dirty tree, which
      // ruling 6 refuses without a lock to explain it. The posture is about the tree,
      // not about HEAD.
      await expect(ensureStartupPosture({ corpusRoot: fresh.root, agentId: 'a' })).rejects.toThrow(/uncommitted/)
      fixtureGit(['add', '-A'], fresh.root)
      fixtureGit(['commit', '--quiet', '-m', 'baseline'], fresh.root)
      const report = await ensureStartupPosture({ corpusRoot: fresh.root, agentId: 'a' })
      expect(report.posture).toBe('clean')
    } finally {
      fresh.cleanup()
    }
  })

  // Deliberately indifferent to the lock. A live lock over a clean tree is another
  // server mid-commit, and cross-process serialization is a supported mode (ruling 7) —
  // refusing here would forbid the concurrency the lock exists to provide.
  it('starts even when a live lock is present, because queuing is the design', async () => {
    plantLock()
    const report = await check()
    expect(report.posture).toBe('clean')
  })
})

describe('ruling 6 case 2 — dirty worktree, no lock: refuse', () => {
  it('refuses rather than discarding unexplained local changes', async () => {
    dirtyTracked()
    await expect(check()).rejects.toThrow(PostureRefusedError)
  })

  it('points at commit or stash', async () => {
    dirtyTracked()
    await expect(check()).rejects.toThrow(/git stash|git commit/)
  })

  it('leaves the change on disk untouched', async () => {
    dirtyTracked()
    const before = readFileSync(join(fixture.root, 'tables', 'dws_order.yaml'), 'utf8')
    await expect(check()).rejects.toThrow(PostureRefusedError)
    expect(readFileSync(join(fixture.root, 'tables', 'dws_order.yaml'), 'utf8')).toBe(before)
  })

  // An untracked file is how a crashed *create* looks, so it has to count as dirty —
  // otherwise `create_definition` residue would pass the check and get swept into the
  // next agent's commit.
  it('counts an untracked file as dirty', async () => {
    writeFileSync(join(fixture.root, 'tables', 'dws_abandoned.yaml'), 'table_name: dws_abandoned\n', 'utf8')
    await expect(check()).rejects.toThrow(/uncommitted/)
  })
})

describe('ruling 6 case 3 — dirty worktree behind an abandoned lock: recover', () => {
  it('restores to HEAD, releases the lock, and logs loudly', async () => {
    dirtyTracked()
    const pristine = fixtureGit(['show', 'HEAD:tables/dws_order.yaml'], fixture.root)
    plantLock({ pid: deadPid() })

    const report = await check()

    expect(report.posture).toBe('recovered')
    expect(report.recovery?.ownerState).toBe('dead')
    expect(report.recovery?.discarded.length).toBeGreaterThan(0)
    // Restored...
    expect(readFileSync(join(fixture.root, 'tables', 'dws_order.yaml'), 'utf8')).toBe(pristine)
    expect(fixtureGit(['status', '--porcelain'], fixture.root).trim()).toBe('')
    // ...lock released...
    expect(existsSync(join(fixture.root, '.git', LOCK_FILENAME))).toBe(false)
    // ...and loud: the operator must be able to see what was discarded, because this is
    // the one branch that destroys bytes.
    expect(logged.join('\n')).toMatch(/crash recovery/)
    expect(logged.join('\n')).toMatch(/dws_order\.yaml/)
  })

  it('removes a file the dead write created', async () => {
    // `git reset --hard` alone leaves untracked files behind, which is exactly the shape
    // a crashed `create_definition` produces.
    writeFileSync(join(fixture.root, 'tables', 'dws_half_written.yaml'), 'table_name: x\n', 'utf8')
    plantLock({ pid: deadPid() })
    const report = await check()
    expect(report.posture).toBe('recovered')
    expect(existsSync(join(fixture.root, 'tables', 'dws_half_written.yaml'))).toBe(false)
  })

  it('recovers behind an expired heartbeat too, not just a dead pid', async () => {
    dirtyTracked()
    plantLock({ heartbeat_at: Date.now() - 600_000 })
    const report = await ensureStartupPosture({
      corpusRoot: fixture.root,
      agentId: 'a',
      lock: { staleAfterMs: 1_000 },
      logger: line => logged.push(line),
    })
    expect(report.posture).toBe('recovered')
    expect(report.recovery?.ownerState).toBe('expired')
  })

  it('keeps ignored files, which were never part of the write', async () => {
    writeFileSync(join(fixture.root, '.gitignore'), 'scratch/\n', 'utf8')
    fixtureGit(['add', '-A'], fixture.root)
    fixtureGit(['commit', '--quiet', '-m', 'ignore scratch'], fixture.root)
    mkdirSync(join(fixture.root, 'scratch'), { recursive: true })
    writeFileSync(join(fixture.root, 'scratch', 'operator-notes.txt'), 'mine\n', 'utf8')
    dirtyTracked()
    plantLock({ pid: deadPid() })

    await check()

    // `git clean -fd` without `-x`: ignored paths belong to the operator.
    expect(existsSync(join(fixture.root, 'scratch', 'operator-notes.txt'))).toBe(true)
  })

  // Recovery means "restore to HEAD", which is undefined with no HEAD. Guessing here
  // would mean deleting files on the strength of an unparseable situation, so the check
  // refuses and hands the operator the one command that resolves it.
  it('refuses instead of guessing when there is no HEAD to restore to', async () => {
    const fresh = createFixtureCorpus({ baselineCommit: false })
    try {
      writeFileSync(join(fresh.root, '.git', LOCK_FILENAME), JSON.stringify({
        pid: deadPid(), host: hostname(), agent_id: 'crashed', token: 't',
        acquired_at: Date.now(), heartbeat_at: Date.now(),
      }), 'utf8')
      await expect(ensureStartupPosture({ corpusRoot: fresh.root, agentId: 'a', logger: () => {} }))
        .rejects.toThrow(/no commits/)
    } finally {
      fresh.cleanup()
    }
  })
})

describe('ruling 6 case 4 — dirty worktree, live lock: refuse (double-open guard)', () => {
  it('refuses while a peer write is in flight', async () => {
    dirtyTracked()
    plantLock({ pid: process.pid, agent_id: 'peer-agent' })
    await expect(check()).rejects.toThrow(PostureRefusedError)
    await expect(check()).rejects.toThrow(/already being written/)
  })

  it('names the holder and leaves its lock alone', async () => {
    dirtyTracked()
    plantLock({ pid: process.pid, agent_id: 'peer-agent' })
    await expect(check()).rejects.toThrow(/peer-agent/)
    expect(existsSync(join(fixture.root, '.git', LOCK_FILENAME))).toBe(true)
  })

  it('does not touch the in-flight write on disk', async () => {
    dirtyTracked()
    const inflight = readFileSync(join(fixture.root, 'tables', 'dws_order.yaml'), 'utf8')
    plantLock({ pid: process.pid })
    await expect(check()).rejects.toThrow(PostureRefusedError)
    expect(readFileSync(join(fixture.root, 'tables', 'dws_order.yaml'), 'utf8')).toBe(inflight)
  })
})

describe('refusals are actionable', () => {
  // A refusal without a remedy is how an operator concludes the tool is broken rather
  // than the deployment, so `remedy` is a required constructor argument.
  it('every refusal carries a remedy', async () => {
    const cases: Array<() => Promise<unknown>> = [
      async () => {
        const plain = createFixtureCorpus({ git: false })
        try {
          return await ensureStartupPosture({ corpusRoot: plain.root, agentId: 'a' })
        } finally {
          plain.cleanup()
        }
      },
      async () => {
        dirtyTracked()
        return check()
      },
    ]
    for (const run of cases) {
      await expect(run()).rejects.toSatisfy(
        e => e instanceof PostureRefusedError && e.remedy.length > 0 && typeof e.data.remedy === 'string',
      )
      fixtureGit(['checkout', '--', '.'], fixture.root)
    }
  })
})

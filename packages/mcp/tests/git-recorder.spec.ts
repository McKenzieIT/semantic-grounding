/**
 * ADR-0004 — the git Tier-2 recorder.
 *
 * "One auditable write = one commit", and the commit **is** the audit record. What these
 * tests pin, in the order #19's acceptance lists it: the trailer block round-trips
 * through git's own reader; `expected_version` mismatches are rejected inside the lock;
 * a commit that cannot be made leaves no trace in index or HEAD; and an idempotent write
 * produces no commit at all.
 *
 * They run against a real repository with real `git` subprocesses. A mocked git would
 * assert that this code calls the commands it calls, which is the one thing never in
 * doubt — every bug found while writing this module was in git's actual behaviour
 * (`restore --source=HEAD` on a path HEAD lacks, `--show-toplevel` returning a realpath,
 * the on-write enrichment hook dirtying the tree after the commit).
 *
 * @see docs/adr/0004-git-tier2-audit-backbone.md
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SemanticGroundingCore, type TableMeta } from '@semantic-grounding/substrate'
import { createHash } from 'node:crypto'
import {
  CommitFailedError,
  MissingAuditContextError,
  PostureRefusedError,
  StaleBaselineRejection,
} from '../src/errors.ts'
import { GitTier2Recorder, type AuditContext } from '../src/git/recorder.ts'
import { DEFAULT_SERVER_IDENTITY } from '../src/git/identity.ts'
import { createFixtureCorpus, fixtureGit, type FixtureCorpus } from './helpers/fixture-corpus.ts'

let fixture: FixtureCorpus

beforeEach(() => {
  fixture = createFixtureCorpus()
})
afterEach(() => fixture.cleanup())

/** A plausible agent-authored write context. */
const CTX: AuditContext = {
  tool: 'update_definition',
  target: 'dws_order',
  summary: '补充订单宽表的业务口径',
  derivation: 'agent',
  confidence: 0.9,
}

/**
 * Build a recorder against the fixture.
 * @param overrides - config overrides.
 * @returns the recorder.
 */
function recorder(overrides: Partial<ConstructorParameters<typeof GitTier2Recorder>[0]> = {}): GitTier2Recorder {
  return new GitTier2Recorder({
    corpusRoot: fixture.root,
    agentId: 'analyst-agent-7',
    scopeId: 'fixture',
    sessionId: 'sess-abc',
    clientName: 'vitest-client',
    lock: { timeoutMs: 2_000, pollIntervalMs: 10 },
    ...overrides,
  })
}

/**
 * Build a core wired to the recorder.
 * @param rec - the recorder to inject.
 * @param autoEnrich - whether the on-write enrichment hook runs (substrate default is true).
 * @returns the core.
 */
function core(rec: GitTier2Recorder, autoEnrich = false): SemanticGroundingCore {
  const c = new SemanticGroundingCore({ semanticRoot: fixture.root, autoEnrich })
  c.setTier2Recorder(rec)
  return c
}

/** @returns the fixture's commit subjects, newest first. */
function subjects(): string[] {
  const out = fixtureGit(['log', '--format=%s'], fixture.root).trim()
  return out === '' ? [] : out.split('\n')
}

/** @returns the sha256 of a table's raw bytes — the fingerprint a reader hands back. */
function fingerprint(table: string): string {
  return createHash('sha256')
    .update(readFileSync(join(fixture.root, 'tables', `${table}.yaml`), 'utf8'), 'utf-8')
    .digest('hex')
}

// ── One write, one commit ────────────────────────────────────────────────

describe('one auditable write = one commit', () => {
  it('commits the write and returns the sha', async () => {
    const rec = recorder()
    const res = await rec.runAudited(CTX, () => core(rec).updateTableMeta('dws_order', { description: '订单宽表' }))

    expect(res.value).toEqual({ ok: true, table_name: 'dws_order' })
    expect(res.changed).toBe(true)
    expect(res.files).toBe(1)
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(subjects()).toEqual(['update_definition(dws_order): 补充订单宽表的业务口径', 'corpus baseline'])
  })

  it('persists the written content in the commit, not just on disk', async () => {
    const rec = recorder()
    await rec.runAudited(CTX, () => core(rec).updateTableMeta('dws_order', { description: '订单宽表' }))
    expect(fixtureGit(['show', 'HEAD:tables/dws_order.yaml'], fixture.root)).toContain('订单宽表')
  })

  it('leaves the worktree clean, so the next write stages only its own change', async () => {
    const rec = recorder()
    await rec.runAudited(CTX, () => core(rec).updateTableMeta('dws_order', { description: 'x' }))
    expect(fixtureGit(['status', '--porcelain'], fixture.root).trim()).toBe('')
  })
})

// ── Ruling 9: identity ───────────────────────────────────────────────────

describe('ruling 9 — author is the agent, committer is the server', () => {
  it('splits the two identities', async () => {
    const rec = recorder()
    await rec.runAudited(CTX, () => core(rec).updateTableMeta('dws_order', { description: 'x' }))
    const [author, authorEmail, committer] = fixtureGit(['log', '-1', '--format=%an%n%ae%n%cn'], fixture.root)
      .trim()
      .split('\n')
    expect(author).toBe('analyst-agent-7')
    expect(authorEmail).toMatch(/^analyst-agent-7@agents\./)
    expect(committer).toBe(DEFAULT_SERVER_IDENTITY.name)
  })

  // The point of the split: agent-written history is separable from human-written
  // history by committer alone, with no naming convention and no trailer scan.
  it('separates agent writes from the human baseline commit by committer', async () => {
    const rec = recorder()
    await rec.runAudited(CTX, () => core(rec).updateTableMeta('dws_order', { description: 'x' }))
    const byServer = fixtureGit(['log', '--format=%s', `--committer=${DEFAULT_SERVER_IDENTITY.email}`], fixture.root).trim()
    expect(byServer.split('\n')).toEqual(['update_definition(dws_order): 补充订单宽表的业务口径'])
  })

  it('refuses to construct without a declared agent id', () => {
    expect(() => recorder({ agentId: '' })).toThrow(/audit trail/)
  })

  // The repository's own `user.name` is the human's and is deliberately not touched —
  // overwriting it would relabel the operator's own commits as agent writes.
  it('does not modify the repository git config', async () => {
    const before = fixtureGit(['config', 'user.name'], fixture.root).trim()
    const rec = recorder()
    await rec.runAudited(CTX, () => core(rec).updateTableMeta('dws_order', { description: 'x' }))
    expect(fixtureGit(['config', 'user.name'], fixture.root).trim()).toBe(before)
  })
})

// ── Ruling 10: trailers round-trip through git's own reader ──────────────

describe('ruling 10 — trailers round-trip', () => {
  it('reads back through git log --format=%(trailers), exactly as ADR-0004 verifies', async () => {
    const rec = recorder()
    await rec.runAudited(CTX, () => core(rec).updateTableMeta('dws_order', { description: 'x' }))

    // The ADR's own verification clause, run verbatim rather than paraphrased.
    const raw = fixtureGit(['log', '-1', '--format=%(trailers)'], fixture.root)
    expect(raw).toContain('X-SG-Schema: 1')
    expect(raw).toContain('X-SG-Tool: update_definition')
    expect(raw).toContain('X-SG-Derivation: agent')
    expect(raw).toContain('X-SG-Confidence: 0.9')
    expect(raw).toContain('X-SG-Agent: analyst-agent-7')
    expect(raw).toContain('X-SG-Client: vitest-client')
    expect(raw).toContain('X-SG-Scope: fixture')
    expect(raw).toContain('X-SG-Session: sess-abc')
  })

  it('answers a single-key query, which is how provenance is actually read', async () => {
    const rec = recorder()
    await rec.runAudited({ ...CTX, derivation: 'llm', confidence: 0.4 }, () =>
      core(rec).updateTableMeta('dws_order', { description: 'x' }))
    expect(fixtureGit(['log', '-1', '--format=%(trailers:key=X-SG-Derivation,valueonly)'], fixture.root).trim())
      .toBe('llm')
    expect(fixtureGit(['log', '-1', '--format=%(trailers:key=X-SG-Confidence,valueonly)'], fixture.root).trim())
      .toBe('0.4')
  })

  it('exposes the same values through the recorder readback helper', async () => {
    const rec = recorder()
    await rec.runAudited(CTX, () => core(rec).updateTableMeta('dws_order', { description: 'x' }))
    const trailers = await rec.readTrailers()
    expect(trailers).toMatchObject({
      Schema: '1',
      Tool: 'update_definition',
      Derivation: 'agent',
      Confidence: '0.9',
      Agent: 'analyst-agent-7',
    })
  })

  // `git log -p --follow` is the provenance answer ADR-0004's consequences promise, so
  // the parts it needs — content diff plus trailers on one commit — are asserted here.
  it('supports the git log -p --follow provenance query end to end', async () => {
    const rec = recorder()
    await rec.runAudited(CTX, () => core(rec).updateTableMeta('dws_order', { description: '订单宽表口径' }))
    const out = fixtureGit(
      ['log', '-p', '--follow', '--format=%an|%(trailers:key=X-SG-Derivation,valueonly)', '--', 'tables/dws_order.yaml'],
      fixture.root,
    )
    expect(out).toContain('analyst-agent-7|agent')
    // `dumpYaml` quotes only where YAML requires it, so a CJK scalar lands bare.
    expect(out).toContain('+description: 订单宽表口径')
  })
})

// ── Ruling 8: baseline freshness, checked inside the lock ────────────────

describe('ruling 8 — expected_version', () => {
  it('lets a write through when the baseline matches', async () => {
    const rec = recorder()
    const res = await rec.runAudited(CTX, () =>
      core(rec).updateTableMeta('dws_order', { description: 'x' }, { expected_version: fingerprint('dws_order') }))
    expect(res.changed).toBe(true)
  })

  it('rejects a stale baseline with a coded, retryable error', async () => {
    const rec = recorder()
    const stale = 'f'.repeat(64)
    try {
      await rec.runAudited(CTX, () =>
        core(rec).updateTableMeta('dws_order', { description: 'x' }, { expected_version: stale }))
      expect.unreachable('should have rejected the stale baseline')
    } catch (e) {
      expect(e).toBeInstanceOf(StaleBaselineRejection)
      // The one retryable error on this surface: re-read, then re-issue (ADR-0005
      // ruling 8's stale_baseline round trip).
      expect((e as StaleBaselineRejection).retryable).toBe(true)
    }
  })

  it('writes nothing and commits nothing when the baseline is stale', async () => {
    const rec = recorder()
    const before = readFileSync(join(fixture.root, 'tables', 'dws_order.yaml'), 'utf8')
    const head = fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()
    await expect(rec.runAudited(CTX, () =>
      core(rec).updateTableMeta('dws_order', { description: 'x' }, { expected_version: 'f'.repeat(64) })))
      .rejects.toThrow(StaleBaselineRejection)
    expect(readFileSync(join(fixture.root, 'tables', 'dws_order.yaml'), 'utf8')).toBe(before)
    expect(fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()).toBe(head)
    expect(fixtureGit(['status', '--porcelain'], fixture.root).trim()).toBe('')
  })

  it('closes the re-read-and-retry loop', async () => {
    const rec = recorder()
    // Someone else moved the definition after this caller read it.
    await rec.runAudited({ ...CTX, summary: '别人的写入' }, () =>
      core(rec).updateTableMeta('dws_order', { table_comment: 'moved' }))
    await expect(rec.runAudited(CTX, () =>
      core(rec).updateTableMeta('dws_order', { description: 'x' }, { expected_version: 'f'.repeat(64) })))
      .rejects.toThrow(StaleBaselineRejection)
    // Re-read, retry, succeed.
    const res = await rec.runAudited(CTX, () =>
      core(rec).updateTableMeta('dws_order', { description: 'x' }, { expected_version: fingerprint('dws_order') }))
    expect(res.changed).toBe(true)
  })
})

// ── Ruling 1 + ADR-0005 ruling 8: no commit for an idempotent write ─────

describe('idempotent write produces no commit', () => {
  it('reports changed:false and leaves HEAD where it was', async () => {
    const rec = recorder()
    await rec.runAudited(CTX, () => core(rec).updateTableMeta('dws_order', { description: '订单宽表' }))
    const head = fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()

    // Byte-identical re-write: `git add` stages nothing, so an empty commit here would
    // be audit noise claiming a change that did not happen.
    const again = await rec.runAudited(CTX, () => core(rec).updateTableMeta('dws_order', { description: '订单宽表' }))

    expect(again.changed).toBe(false)
    expect(again.files).toBe(0)
    expect(again.commit).toBe(head)
    expect(fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()).toBe(head)
  })
})

// ── Ruling 1: fail-loud, and leave no trace ─────────────────────────────

describe('a commit that cannot be made rolls back', () => {
  /**
   * Install a `pre-commit` hook that rejects every commit.
   *
   * Hooks are deliberately not bypassed (no `--no-verify`), so this is both the most
   * realistic way to fail a commit and a test of that decision: a hook that rejects a
   * write is a real audit failure, and D5 says the write must then not have happened.
   */
  function installFailingHook(): void {
    const hook = join(fixture.root, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho "policy: no\n" >&2\nexit 1\n', 'utf8')
    chmodSync(hook, 0o755)
  }

  it('raises CommitFailedError including git stderr', async () => {
    installFailingHook()
    const rec = recorder()
    try {
      await rec.runAudited(CTX, () => core(rec).updateTableMeta('dws_order', { description: 'x' }))
      expect.unreachable('the failing hook should have failed the commit')
    } catch (e) {
      expect(e).toBeInstanceOf(CommitFailedError)
      expect((e as CommitFailedError).message).toMatch(/policy: no/)
    }
  })

  // The recorder's half of ruling 1: raising asserts the write did not happen, so index
  // and HEAD must carry no trace. The substrate restores the definition's bytes; between
  // the two layers, disk ends at the pre-write state.
  it('leaves index, worktree and HEAD at the pre-write state', async () => {
    installFailingHook()
    const rec = recorder()
    const before = readFileSync(join(fixture.root, 'tables', 'dws_order.yaml'), 'utf8')
    const head = fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()

    await expect(rec.runAudited(CTX, () => core(rec).updateTableMeta('dws_order', { description: 'x' })))
      .rejects.toThrow(CommitFailedError)

    expect(fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()).toBe(head)
    expect(fixtureGit(['status', '--porcelain'], fixture.root).trim()).toBe('')
    expect(fixtureGit(['diff', '--cached', '--name-only'], fixture.root).trim()).toBe('')
    expect(readFileSync(join(fixture.root, 'tables', 'dws_order.yaml'), 'utf8')).toBe(before)
  })

  // The harder rollback: a *created* file has no HEAD content to restore from, so it has
  // to be unstaged and deleted. Measured while building this — `git restore
  // --source=HEAD` fails outright on a path HEAD does not contain.
  it('removes a file the failed write created, leaving nothing staged', async () => {
    const rec = recorder()
    const meta: TableMeta = {
      table_name: 'dws_brand_new',
      comment: 'new',
      partitions: [{ name: 'ds', type: 'string' }],
      columns: [{ name: 'shop_id', type: 'string', comment: '' }],
    }
    installFailingHook()
    await expect(rec.runAudited({ ...CTX, tool: 'create_definition', target: 'dws_brand_new' }, () =>
      core(rec).syncWrite([meta]))).rejects.toThrow(CommitFailedError)

    expect(fixtureGit(['status', '--porcelain'], fixture.root).trim()).toBe('')
    expect(fixtureGit(['diff', '--cached', '--name-only'], fixture.root).trim()).toBe('')
  })

  it('releases the corpus lock so the next write is not blocked', async () => {
    installFailingHook()
    const rec = recorder()
    await expect(rec.runAudited(CTX, () => core(rec).updateTableMeta('dws_order', { description: 'x' })))
      .rejects.toThrow(CommitFailedError)
    expect(rec.lock.isHeld).toBe(false)
    expect(rec.lock.read()).toBeNull()
  })
})

// ── The seam: a write with no declared intent is refused ────────────────

describe('a Tier-2 write with no audit context is refused', () => {
  // ADR-0005 ruling 8 rejected server-synthesized summaries, so the recorder cannot
  // invent the intent — and a commit whose stated basis is a fiction is worse than a
  // loud wiring error. This is what catches a host that wires the recorder but calls
  // the core method directly.
  it('throws MissingAuditContextError instead of inventing a summary', async () => {
    const rec = recorder()
    await expect(core(rec).updateTableMeta('dws_order', { description: 'x' }))
      .rejects.toThrow(MissingAuditContextError)
  })

  it('names runAudited as the fix', async () => {
    const rec = recorder()
    await expect(core(rec).updateTableMeta('dws_order', { description: 'x' })).rejects.toThrow(/runAudited/)
  })

  it('commits nothing, and the substrate rolls the write back', async () => {
    const rec = recorder()
    const before = readFileSync(join(fixture.root, 'tables', 'dws_order.yaml'), 'utf8')
    const head = fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()
    await expect(core(rec).updateTableMeta('dws_order', { description: 'x' }))
      .rejects.toThrow(MissingAuditContextError)
    expect(fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()).toBe(head)
    expect(readFileSync(join(fixture.root, 'tables', 'dws_order.yaml'), 'utf8')).toBe(before)
  })
})

// ── The derived-residue sweep ───────────────────────────────────────────

describe('on-write enrichment residue gets its own deterministic commit', () => {
  // Reproduced by probe before this behaviour existed: with `autoEnrich` on (the
  // substrate default), the on-write hook writes `dimension_refs` AFTER the audit
  // commit, via an `enrichAll*` call that passes no `Tier2Opts`. Left alone, the next
  // write's `git add -A` would stamp `Derivation: agent` on machine-derived content,
  // and the next startup would refuse on a dirty tree.
  it('commits the hook output separately, labelled deterministic', async () => {
    const rec = recorder()
    const res = await rec.runAudited(CTX, () =>
      core(rec, true).updateTableMeta('dws_order', { description: '订单宽表' }))

    expect(res.derivedCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(res.derivedCommit).not.toBe(res.commit)
    expect(fixtureGit(['status', '--porcelain'], fixture.root).trim()).toBe('')

    // The derived commit says deterministic; the agent's commit says agent. One trailer
    // cannot honestly carry both, which is why these are two commits.
    expect(await rec.readTrailers(res.derivedCommit)).toMatchObject({
      Tool: 'enrich_on_write',
      Derivation: 'deterministic',
      Confidence: '1',
    })
    expect(await rec.readTrailers(res.commit)).toMatchObject({ Derivation: 'agent' })
  })

  it('actually carries the derived content', async () => {
    const rec = recorder()
    const res = await rec.runAudited(CTX, () =>
      core(rec, true).updateTableMeta('dws_order', { description: '订单宽表' }))
    const derived = fixtureGit(['show', `${res.derivedCommit}:tables/dws_order.yaml`], fixture.root)
    expect(derived).toContain('dim_table: dim_shop')
    expect(derived).toContain('origin: deterministic')
  })

  it('makes no derived commit when the hook finds nothing', async () => {
    const noDim = createFixtureCorpus({ withDim: false })
    const saved = fixture
    fixture = noDim
    try {
      const rec = recorder()
      const res = await rec.runAudited(CTX, () =>
        core(rec, true).updateTableMeta('dws_order', { description: 'x' }))
      expect(res.derivedCommit).toBeUndefined()
      expect(fixtureGit(['status', '--porcelain'], noDim.root).trim()).toBe('')
    } finally {
      fixture = saved
      noDim.cleanup()
    }
  })
})

// ── Runtime continuation of ruling 6 ────────────────────────────────────

describe('a write over an already-dirty worktree is refused', () => {
  // Ruling 6 settled this at startup; `git add -A` makes it matter at every write.
  // Proceeding would stage an operator's uncommitted edit into the agent's commit,
  // attributing a human's work to a machine.
  it('refuses rather than committing someone else edit under the agent name', async () => {
    const p = join(fixture.root, 'tables', 'dws_order.yaml')
    writeFileSync(p, `${readFileSync(p, 'utf8')}\n# operator note\n`, 'utf8')
    const rec = recorder()
    await expect(rec.runAudited(CTX, () => core(rec).updateTableMeta('dws_order', { description: 'x' })))
      .rejects.toThrow(PostureRefusedError)
    expect(readFileSync(p, 'utf8')).toContain('# operator note')
  })
})

// ── Batch accounting ────────────────────────────────────────────────────

describe('batch write accounting', () => {
  // `syncWrite` records per table today (ADR-0004 ruling 3's "302 表 = 302 commit",
  // which `beginBatch` solves in #21). Until then the reported file count has to be the
  // sum across the window, not the last record's.
  it('counts every file written in one audited window', async () => {
    const rec = recorder()
    const metas: TableMeta[] = ['dws_a', 'dws_b', 'dws_c'].map(name => ({
      table_name: name,
      comment: name,
      partitions: [{ name: 'ds', type: 'string' }],
      columns: [{ name: 'shop_id', type: 'string', comment: '' }],
    }))
    const res = await rec.runAudited({ ...CTX, tool: 'create_definition', target: '3 tables' }, () =>
      core(rec).syncWrite(metas))

    expect(res.value.written).toBe(3)
    expect(res.files).toBe(3)
    expect(res.changed).toBe(true)
    expect(subjects().filter(s => s.startsWith('create_definition'))).toHaveLength(3)
  })
})

// ── beginBatch (#21): N audited writes become one commit ────────────────

describe('beginBatch: the reserved slot, implemented', () => {
  it('coalesces discoverRelations\' per-table writes into one commit, with real Files/Rounds', async () => {
    // This is exactly #21's run_enrichment compiling onto the unchanged discoverRelations
    // (`tier2` passthrough shipped with #18) — the absorption lives entirely in this
    // recorder, not in discoverRelations' own code.
    const rec = recorder()
    const res = await rec.runAudited({ ...CTX, tool: 'run_enrichment', target: 'all definitions' }, async () => {
      const batch = rec.beginBatch()
      const discovered = await core(rec).discoverRelations({ tier2: { recorder: rec } })
      if (discovered.written > 0) batch.record('run_enrichment', { round: 'relation' })
      return batch.end()
    })
    expect(res.changed).toBe(true)
    // Only dws_order's dimension_refs changed — one file, one commit, not one per table.
    expect(res.files).toBe(1)
    expect(subjects().filter(s => s.startsWith('run_enrichment'))).toHaveLength(1)
    expect(await rec.readTrailers(res.commit)).toMatchObject({ Files: '1', Rounds: '1', Derivation: 'agent' })
  })

  it('absorbs a recordTier2Write made while the batch is open — no commit until end()', async () => {
    const rec = recorder()
    const subjectsBefore = subjects().length
    const res = await rec.runAudited(CTX, async () => {
      const batch = rec.beginBatch()
      await core(rec).updateTableMeta('dws_order', { description: 'via absorbed write' })
      // The write already landed on disk (updateTableMeta's own atomicWrite), but no
      // commit should exist for it yet — recordTier2Write deferred to this batch.
      expect(subjects()).toHaveLength(subjectsBefore)
      batch.record('apply_enrichment', { round: 'relation' })
      return batch.end()
    })
    expect(res.changed).toBe(true)
    expect(res.files).toBe(1)
    expect(subjects()).toHaveLength(subjectsBefore + 1)
  })

  it('a batch that stages nothing makes no commit (ADR-0005 ruling 8 at batch granularity)', async () => {
    const rec = recorder()
    const subjectsBefore = subjects().length
    const res = await rec.runAudited(CTX, async () => {
      const batch = rec.beginBatch()
      // No writes at all — e.g. every apply_enrichment item verdicted idempotent/stale.
      return batch.end()
    })
    expect(res.changed).toBe(false)
    expect(res.files).toBe(0)
    expect(subjects()).toHaveLength(subjectsBefore)
  })

  it('abort() restores the worktree to the pre-batch HEAD, discarding every raw write made', async () => {
    const rec = recorder()
    const headBefore = fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()
    await expect(rec.runAudited(CTX, async () => {
      const batch = rec.beginBatch()
      writeFileSync(join(fixture.root, 'tables', 'dws_order.yaml'), 'garbage: true\n', 'utf8')
      await batch.abort()
      throw new Error('simulated failure after a batch write — the batch must still be undone')
    })).rejects.toThrow('simulated failure after a batch write')
    expect(fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()).toBe(headBefore)
    expect(fixtureGit(['status', '--porcelain'], fixture.root).trim()).toBe('')
  })

  it('throws MissingAuditContextError when called outside runAudited', () => {
    const rec = recorder()
    expect(() => rec.beginBatch()).toThrow(MissingAuditContextError)
  })
})

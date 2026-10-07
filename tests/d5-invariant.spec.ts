/**
 * ADR-0001 regression guard — the D5 Tier-2 audit invariant.
 *
 * > **Invariant (D5)**: any code path that mutates auditable state (definition
 * > writes, relation edges, enrichment applications with provenance) MUST
 * > either record the mutation via the wired `Tier2Recorder` or throw. Silent
 * > drop is not a valid outcome.
 *
 * Before slice 2 ② the recorder arrived via `ctx.get('audit')`, so "is audit
 * wired?" was a question about whether the host had mounted a service under the
 * name `'audit'`. The inversion makes it a setter, and ADR-0001's consequence
 * section is explicit that the naive translation — drop the lookup because the
 * core has no host context — silently downgrades the guarantee: "the behaviour
 * is preserved; the guarantee is lost".
 *
 * These tests are that guarantee's regression guard. They pin, for every
 * Service-level auditable write path, that an unwired recorder throws rather
 * than writing unrecorded — and that the only way to get audit-off behaviour is
 * to pass an explicit no-op recorder, making the downgrade code-visible.
 *
 * @see docs/adr/0001-d5-tier2-audit-invariant.md
 */
import { test, expect, describe, it, beforeEach, afterEach } from 'vitest'
import { SemanticGroundingCore, type TableMeta } from '../src/index.ts'
import type { Tier2Recorder } from '../src/io.ts'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'

/** The explicit no-op recorder a host must pass if it really means audit-off. */
const noopRecorder: Tier2Recorder = { recordTier2Write: () => 'noop-log-id' }

function newService(root = ''): SemanticGroundingCore {
  return new SemanticGroundingCore({ semanticRoot: root, autoEnrich: false })
}

const SAMPLE_META: TableMeta = {
  table_name: 'dws_d5_probe', comment: 'd5',
  partitions: [{ name: 'ds', type: 'string' }],
  columns: [{ name: 'server_id', type: 'string', comment: '区服ID' }],
}

// ── Every auditable mutation path throws with no recorder wired ──────────
// The three Service-level Tier-2 write methods. Each resolves `this.recorder()`
// while building its write options, i.e. BEFORE touching disk — so an unwired
// recorder cannot produce a partial, unrecorded write.
describe('D5 — auditable mutation with no recorder wired throws', () => {
  it('syncWrite throws', async () => {
    await expect(newService().syncWrite([SAMPLE_META])).rejects.toThrow(/D5/)
  })

  it('updateTableMeta throws', async () => {
    await expect(newService().updateTableMeta('any_table', { description: 'x' })).rejects.toThrow(/D5/)
  })

  it('updateEventMeta throws', async () => {
    await expect(newService().updateEventMeta('any.event', { description: 'x' })).rejects.toThrow(/D5/)
  })

  it('the throw names the invariant as non-disableable, not as a missing optional dep', async () => {
    // The message is the only thing telling an operator that this is a policy,
    // not a misconfiguration to be worked around.
    await expect(newService().syncWrite([SAMPLE_META])).rejects.toThrow(/non-disableable/)
  })

  it('throws even with an empty batch — the guarantee is about the path, not the payload', async () => {
    // A zero-row write still enters the auditable path. If this stopped
    // throwing it would mean the recorder is resolved lazily per-row, which is
    // exactly the shape that lets a partial write escape unrecorded.
    await expect(newService().syncWrite([])).rejects.toThrow(/D5/)
  })
})

// ── Read paths are unaffected ────────────────────────────────────────────
// D5 governs auditable *mutations*. A core that threw on reads too would be
// trivially "safe" and useless; this pins the boundary.
describe('D5 — read paths do not require a recorder', () => {
  it('reads work with no recorder wired', () => {
    const svc = newService()
    expect(() => svc.loadRetrievalCorpusAll()).not.toThrow()
    expect(() => svc.getRelationGraph()).not.toThrow()
    expect(() => svc.getRegistry().allKinds()).not.toThrow()
  })
})

// ── Audit-off must be an explicit, code-visible choice ───────────────────
describe('D5 — audit-off is reachable only by passing an explicit no-op recorder', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd5-'))
    mkdirSync(join(dir, 'tables'), { recursive: true })
    mkdirSync(join(dir, 'events'), { recursive: true })
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ scope_id: 'd5-test' }), 'utf8')
  })
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('a wired no-op recorder lets the write through', async () => {
    const svc = newService(dir)
    svc.setTier2Recorder(noopRecorder)
    const res = await svc.syncWrite([SAMPLE_META])
    expect(res.written).toBe(1)
  })

  it('the wired recorder actually receives the mutation', async () => {
    const calls: Array<{ tool: string }> = []
    const svc = newService(dir)
    svc.setTier2Recorder({
      recordTier2Write: (toolName: string) => { calls.push({ tool: toolName }); return 'log-id' },
    })
    await svc.syncWrite([SAMPLE_META])
    expect(calls.length).toBeGreaterThan(0)
  })

  it('clearing the recorder re-arms the throw', async () => {
    const svc = newService(dir)
    svc.setTier2Recorder(noopRecorder)
    await expect(svc.syncWrite([SAMPLE_META])).resolves.toBeTruthy()
    svc.setTier2Recorder(undefined)
    await expect(svc.syncWrite([SAMPLE_META])).rejects.toThrow(/D5/)
  })

  // ── KNOWN GAP (see issue #6) ──────────────────────────────────────────
  // ADR-0001 requires the core to throw "when a Tier-2 recording is required
  // but no recorder is wired, OR **when a wired recorder raises**". The first
  // half holds (the describe block above). The second half does NOT, and the
  // way it fails is worse than a missing throw.
  //
  // `syncWriteDefinitions` (io.ts) writes the YAML to disk and records the
  // audit *afterwards*, inside one try/catch whose handler pushes to `errors`:
  //
  //     await writeTable(...)                 // disk write lands
  //     opts.recorder.recordTier2Write(...)   // raises
  //     written += 1                          // never reached
  //   } catch (e) { errors.push(...) }        // swallowed
  //
  // Measured consequence, with a recorder that throws:
  //     returns  { written: 0, skipped: 0, errors: ['dws_unaudited: audit backend down'] }
  //     on disk  tables/dws_unaudited.yaml    ← EXISTS, unaudited
  //
  // So an auditable mutation reached source-of-truth with no audit record,
  // while the return value reports `written: 0`. That is the exact outcome D5
  // exists to forbid, plus a return value that misreports it.
  //
  // Not fixed here: this is a write/audit *atomicity* decision, not the ~10 LOC
  // inversion slice 2 scoped. Deliberately left as `it.fails` so the gap stays
  // visible and this test turns red the moment it is fixed.
  it.fails('a recorder that throws propagates — a failed recording is not a silent drop', async () => {
    const svc = newService(dir)
    svc.setTier2Recorder({
      recordTier2Write: () => { throw new Error('audit backend down') },
    })
    await expect(svc.syncWrite([SAMPLE_META])).rejects.toThrow(/audit backend down/)
  })
})

// ── The recorder is per-instance, not module-level ───────────────────────
// A single-process host embedding the core per tenant (the MCP management
// surface) must not have one tenant's recorder answer for another's writes.
test('D5 — each core instance carries its own recorder', async () => {
  const a = newService()
  const b = newService()
  a.setTier2Recorder(noopRecorder)
  // b was never wired: it must still throw even though a sibling instance is wired
  await expect(b.syncWrite([SAMPLE_META])).rejects.toThrow(/D5/)
})

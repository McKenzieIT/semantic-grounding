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
import { SemanticGroundingCore, writeTable, writeEventYaml } from '../src/index.ts'
import type { Tier2Recorder } from '../src/io.ts'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { fixtureEvent, fixtureTable } from './enrichment-fixtures.ts'

/** The explicit no-op recorder a host must pass if it really means audit-off. */
const noopRecorder: Tier2Recorder = { recordTier2Write: async () => 'noop-log-id' }

function newService(root = ''): SemanticGroundingCore {
  return new SemanticGroundingCore({ semanticRoot: root, autoEnrich: false })
}

// ── Every auditable mutation path throws with no recorder wired ──────────
// The Service-level Tier-2 write methods. Each resolves `this.recorder()`
// while building its write options, i.e. BEFORE touching disk — so an unwired
// recorder cannot produce a partial, unrecorded write.
describe('D5 — auditable mutation with no recorder wired throws', () => {
  it('updateTableMeta throws', async () => {
    await expect(newService().updateTableMeta('any_table', { description: 'x' })).rejects.toThrow(/D5/)
  })

  it('updateEventMeta throws, naming the invariant as non-disableable, not as a missing optional dep', async () => {
    // The message is the only thing telling an operator that this is a policy,
    // not a misconfiguration to be worked around.
    const err: unknown = await newService().updateEventMeta('any.event', { description: 'x' }).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/D5/)
    expect((err as Error).message).toMatch(/non-disableable/)
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
    const res = await svc.writeConceptYaml('付费', { name: '付费', description: 'x' })
    expect(res.ok).toBe(true)
  })

  it('the wired recorder actually receives the mutation', async () => {
    const calls: Array<{ tool: string }> = []
    const svc = newService(dir)
    svc.setTier2Recorder({
      recordTier2Write: async (toolName: string) => { calls.push({ tool: toolName }); return 'log-id' },
    })
    await svc.writeConceptYaml('付费', { name: '付费', description: 'x' })
    expect(calls.length).toBeGreaterThan(0)
  })

  it('clearing the recorder re-arms the throw', async () => {
    const svc = newService(dir)
    svc.setTier2Recorder(noopRecorder)
    await expect(svc.writeConceptYaml('付费', { name: '付费', description: 'x' })).resolves.toBeTruthy()
    svc.setTier2Recorder(undefined)
    await expect(svc.writeConceptYaml('暂缓', { name: '暂缓', description: 'x' })).rejects.toThrow(/D5/)
  })

  // The exacting closure instance: `updateTableMeta` UPDATING a file
  // that already carries a hand-written comment. The rollback must restore
  // the literal pre-write bytes — not a `yaml.dump` of the pre-merge parsed
  // object, which would already have dropped the comment during the initial
  // parse. Byte-identical disk content is the proof the restore uses the raw
  // snapshot, not a reconstruction.
  it('a recorder that throws on updateTableMeta leaves the file byte-identical to its pre-write state, hand-written comment included', async () => {
    const tf = join(dir, 'tables', 'dws_d5_probe.yaml')
    const doc = fixtureTable({
      table_name: 'dws_d5_probe', table_comment: 'd5',
      columns: [{ name: 'server_id', type: 'string', comment: '区服ID', role: 'dimension' }],
      partitions: [{ name: 'ds', type: 'string' }],
    })
    const original = '# hand-written note: do not remove\n'
      + yaml.dump(doc, { sortKeys: false, lineWidth: -1, noRefs: true, quotingType: '"' })
    writeFileSync(tf, original, 'utf8')
    const svc = newService(dir)
    svc.setTier2Recorder({
      recordTier2Write: async () => { throw new Error('audit backend down') },
    })
    await expect(svc.updateTableMeta('dws_d5_probe', { table_comment: 'updated' })).rejects.toThrow(/audit backend down/)
    expect(readFileSync(tf, 'utf8')).toBe(original) // comment survives — this was never re-dumped
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
  await expect(b.updateEventMeta('any.event', { description: 'x' })).rejects.toThrow(/D5/)
})

// ── #61: every audited write path rolls back on a recorder raise ──────────
// The guards above pin the Service-level paths (throw shape + updateTableMeta's
// byte-identical rollback); the io-level paths rolled back correctly only by
// courtesy of the ceremony being re-copied faithfully. #61 folded them all
// into io.ts's `auditedFileWrite` seam; this block pins every wiring the seam
// has (two call sites since the sync-write chain's removal, S1.4) — the
// recorder raise propagates and disk ends at its pre-write state, on both
// restore branches (create ⇒ the file is gone; update ⇒ the bytes are
// byte-identical, hand-written comment included) across the table/event/concept
// axis. Also pins #61's unified domain-failure face: writeTable validation
// failures are {ok:false}, never a throw.
describe('D5 — #61: every remaining audited write path rolls back on a recorder raise', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd5-61-'))
    mkdirSync(join(dir, 'tables'), { recursive: true })
    mkdirSync(join(dir, 'events', 'biz'), { recursive: true })
    mkdirSync(join(dir, 'concepts'), { recursive: true })
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ scope_id: 'd5-61' }), 'utf8')
  })
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  /** A recorder whose every recording raises — the D5 lower-half probe. */
  const exploding: Tier2Recorder = {
    recordTier2Write: async () => { throw new Error('audit backend down') },
  }

  /** The minimal schema-valid table payload (mirrors item-write's fixture). */
  const TABLE = fixtureTable({
    table_name: 'dws_probe', partitions: [{ name: 'ds', type: 'string' }],
  })

  it('writeTable (audited) — the raise propagates and the created file is rolled back to absent', async () => {
    const probe = join(dir, 'tables', 'dws_probe.yaml')
    await expect(writeTable(dir, 'dws_probe', TABLE, {}, { recorder: exploding })).rejects.toThrow(/audit backend down/)
    expect(existsSync(probe)).toBe(false)
  })

  it('writeTable (audited) — an overwrite rolls the file back to its byte-identical pre-write state', async () => {
    const probe = join(dir, 'tables', 'dws_probe.yaml')
    const original = '# hand-written note: do not remove\n'
      + yaml.dump(TABLE, { sortKeys: false, lineWidth: -1, noRefs: true, quotingType: '"' })
    writeFileSync(probe, original, 'utf8')
    await expect(writeTable(dir, 'dws_probe', { ...TABLE, description: 'overwritten' }, {}, { recorder: exploding })).rejects.toThrow(/audit backend down/)
    expect(readFileSync(probe, 'utf8')).toBe(original)
  })

  it('writeTable — a validation failure is {ok:false} (#61 unified face) with nothing on disk', async () => {
    const probe = join(dir, 'tables', 'bad.yaml')
    // `table_name` is the one field with no default — `{}` cannot validate
    const res = await writeTable(dir, 'bad', {}, {}, { recorder: exploding })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/Table validation failed/)
    expect(existsSync(probe)).toBe(false)
  })

  it('writeEventYaml (audited) — the raise propagates and the created _suggested file is rolled back to absent', async () => {
    const probe = join(dir, 'events', '_suggested', 'pay_probe.yaml')
    await expect(writeEventYaml(dir, 'pay_probe', 'name: pay_probe\ndescription: probe\n', { recorder: exploding })).rejects.toThrow(/audit backend down/)
    expect(existsSync(probe)).toBe(false)
  })

  it('updateEventMeta — the raise propagates and the file stays byte-identical', async () => {
    const probe = join(dir, 'events', 'biz', 'pay_probe.yaml')
    const original = '# hand-written note: do not remove\n'
      + yaml.dump(fixtureEvent({ name: 'pay_probe' }), { sortKeys: false, lineWidth: -1, noRefs: true, quotingType: '"' })
    writeFileSync(probe, original, 'utf8')
    const svc = new SemanticGroundingCore({ semanticRoot: dir, autoEnrich: false })
    svc.setTier2Recorder(exploding)
    await expect(svc.updateEventMeta('pay_probe', { description: 'overwritten' })).rejects.toThrow(/audit backend down/)
    expect(readFileSync(probe, 'utf8')).toBe(original)
  })

  it('writeConceptYaml — the raise propagates and the created file is rolled back to absent', async () => {
    const probe = join(dir, 'concepts', '付费.yaml')
    const svc = new SemanticGroundingCore({ semanticRoot: dir, autoEnrich: false })
    svc.setTier2Recorder(exploding)
    await expect(svc.writeConceptYaml('付费', { name: '付费', description: 'x' })).rejects.toThrow(/audit backend down/)
    expect(existsSync(probe)).toBe(false)
  })

  it('updateConceptMeta — the raise propagates and the file stays byte-identical', async () => {
    const probe = join(dir, 'concepts', '付费.yaml')
    const original = '# hand-written note: do not remove\nname: 付费\ndescription: 旧\n'
    writeFileSync(probe, original, 'utf8')
    const svc = new SemanticGroundingCore({ semanticRoot: dir, autoEnrich: false })
    svc.setTier2Recorder(exploding)
    await expect(svc.updateConceptMeta('付费', { description: '新' })).rejects.toThrow(/audit backend down/)
    expect(readFileSync(probe, 'utf8')).toBe(original)
  })
})

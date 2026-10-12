/**
 * Core concept write methods — domain-level contracts for `writeConceptYaml`,
 * `updateConceptMeta`, and the concept-side edge arms of `addRelation` /
 * `removeRelations` (#52 / ADR-0012, Q4(b) Update).
 *
 * Mirrors `item-write.spec.ts`'s shape: calls Core methods directly, pinning
 * the domain logic the MCP handlers thin to (schema + auditedWrite + Core
 * call + response formatting lives on the wire side).
 *
 * Coverage:
 * - writeConceptYaml: creates the file, validates, rejects invalid payloads.
 * - updateConceptMeta: read-merge-validate-write, properties round-trip, stale
 *   baseline, missing concept.
 * - addRelation(kind:'concept'|'table', edge-shaped relation): concept→concept
 *   and concept→table land on the subject; table→concept lands on the TARGET
 *   concept (storage-home asymmetry); idempotence; veto lift; missing
 *   subject/target; event refusal; join-shape refusal on a concept subject.
 * - removeRelations(…, edge-shaped relations): curated vs machine-derived veto
 *   routing, ensure-absent, reasserted always false, batch removal from a
 *   concept subject, table-subject multi-target split-the-call error, mixed
 *   join+edge batch rejection.
 * - StaleBaselineError propagation through all of the above.
 *
 * @see docs/adr/0012-concept-cold-start.md
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  SemanticGroundingCore,
  dumpYaml,
  StaleBaselineError,
  type Tier2Recorder,
} from '../src/index.ts'
import { definitionVersion } from '../src/io.ts'

const noopRecorder: Tier2Recorder = { recordTier2Write: async () => 'noop-log-id' }

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'concept-write-'))
  mkdirSync(join(root, 'tables'), { recursive: true })
  mkdirSync(join(root, 'concepts'), { recursive: true })
  writeFileSync(join(root, 'config.yaml'), dumpYaml({ scope_id: 'fixture' }), 'utf8')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeTable(name: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(root, 'tables', `${name}.yaml`), dumpYaml({
    table_name: name,
    table_comment: '',
    description: '',
    alt_labels: [],
    domains: [],
    granularity: '',
    engine: 'maxcompute',
    metrics: {},
    partitions: [{ name: 'ds', type: 'string' }],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    coverage: null,
    supersedes: [],
    disambiguation: null,
    primary_key: [],
    primary_key_unique: null,
    duplicate_sample: [],
    label_columns: [],
    freshness: '',
    dimension_refs: [],
    ...extra,
  }), 'utf8')
}

function writeConcept(name: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(root, 'concepts', `${name}.yaml`), dumpYaml({
    name,
    description: '',
    alt_labels: [],
    properties: {},
    related_refs: [],
    suppressed_alt_labels: [],
    suppressed_related_refs: [],
    ...extra,
  }), 'utf8')
}

function newCore(autoEnrich = false): SemanticGroundingCore {
  const core = new SemanticGroundingCore({ semanticRoot: root, scopeId: 'fixture', autoEnrich })
  core.setTier2Recorder(noopRecorder)
  return core
}

function ver(kind: 'table' | 'concept', name: string): string {
  const v = definitionVersion(root, kind, name)
  if (v === null) throw new Error(`no version for ${kind}/${name}`)
  return v
}

// ── writeConceptYaml ───────────────────────────────────────────────────────

describe('writeConceptYaml', () => {
  it('creates the concept file (name + description only — all else defaults)', async () => {
    const core = newCore()
    await core.writeConceptYaml('付费经济', { name: '付费经济', description: '充值消费相关' })
    const def = core.loadConceptDefinition('付费经济')
    expect(def?.name).toBe('付费经济')
    expect(def?.description).toBe('充值消费相关')
    expect(def?.alt_labels).toEqual([])
    expect(def?.properties).toEqual({})
    expect(def?.related_refs).toEqual([])
  })

  it('persists a free-form properties payload verbatim', async () => {
    const core = newCore()
    await core.writeConceptYaml('装备', { name: '装备', properties: { rarity: '传说', level_cap: 60, tradeable: false } })
    const def = core.loadConceptDefinition('装备')
    expect(def?.properties).toEqual({ rarity: '传说', level_cap: 60, tradeable: false })
  })

  it('rejects a payload that fails ConceptDefinitionSchema (missing name)', async () => {
    const core = newCore()
    // #61: write-path domain validation is {ok:false}, not a throw
    const res = await core.writeConceptYaml('x', { description: 'no name field' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/validation failed/i)
  })
})

// ── updateConceptMeta ──────────────────────────────────────────────────────

describe('updateConceptMeta', () => {
  it('shallow-merges description/pref_label over the existing concept', async () => {
    writeConcept('付费经济', { description: '旧描述' })
    const core = newCore()
    const res = await core.updateConceptMeta('付费经济', { description: '新描述', pref_label: '付费' }, { expected_version: ver('concept', '付费经济') })
    expect(res).toEqual({ ok: true, concept_name: '付费经济' })
    const def = core.loadConceptDefinition('付费经济')
    expect(def?.description).toBe('新描述')
    expect(def?.pref_label).toBe('付费')
  })

  it('round-trips a properties update', async () => {
    writeConcept('装备', { properties: { rarity: '普通' } })
    const core = newCore()
    await core.updateConceptMeta('装备', { properties: { rarity: '史诗', level_cap: 80 } }, { expected_version: ver('concept', '装备') })
    expect(core.loadConceptDefinition('装备')?.properties).toEqual({ rarity: '史诗', level_cap: 80 })
  })

  it('returns ok:false for a missing concept', async () => {
    const core = newCore()
    const res = await core.updateConceptMeta('nope', { description: 'x' }, {})
    expect(res).toEqual({ ok: false, error: expect.stringContaining('Concept not found') })
  })

  it('throws StaleBaselineError on version mismatch', async () => {
    writeConcept('付费经济')
    const core = newCore()
    await expect(core.updateConceptMeta('付费经济', { description: 'x' }, { expected_version: 'a'.repeat(64) })).rejects.toThrow(StaleBaselineError)
  })
})

// ── addRelation: concept-side edges (Q4(b)) ────────────────────────────────

describe('addRelation — concept-side edges', () => {
  it('concept→concept: edge lands on the SUBJECT concept\'s related_refs', async () => {
    writeConcept('付费经济')
    writeConcept('用户生命周期')
    const core = newCore()
    const res = await core.addRelation('concept', '付费经济', { target_kind: 'concept', name: '用户生命周期' }, ver('concept', '付费经济'))
    expect(res.added).toBe(true)
    const def = core.loadConceptDefinition('付费经济')
    expect(def?.related_refs).toEqual([{ target_kind: 'concept', target: '用户生命周期', derivation: '' }])
    expect(core.loadConceptDefinition('用户生命周期')?.related_refs).toEqual([])
  })

  it('concept→table: edge lands on the SUBJECT concept\'s related_refs', async () => {
    writeConcept('付费经济')
    writeTable('dws_pay')
    const core = newCore()
    const res = await core.addRelation('concept', '付费经济', { target_kind: 'table', name: 'dws_pay' }, ver('concept', '付费经济'))
    expect(res.added).toBe(true)
    expect(core.loadConceptDefinition('付费经济')?.related_refs).toEqual([{ target_kind: 'table', target: 'dws_pay', derivation: '' }])
  })

  it('table→concept: edge lands on the TARGET concept\'s related_refs, not on the table (storage-home asymmetry)', async () => {
    writeTable('dws_pay')
    writeConcept('付费经济')
    const core = newCore()
    const res = await core.addRelation('table', 'dws_pay', { target_kind: 'concept', name: '付费经济' }, ver('concept', '付费经济'))
    expect(res.added).toBe(true)
    expect(core.loadConceptDefinition('付费经济')?.related_refs).toEqual([{ target_kind: 'table', target: 'dws_pay', derivation: '' }])
    // The table definition itself carries no edge field.
    expect(core.loadTableDefinition('dws_pay')).not.toHaveProperty('related_refs')
  })

  it('table→concept: the TABLE\'s own fingerprint is the wrong baseline (expected_version must be the target concept\'s)', async () => {
    writeTable('dws_pay')
    writeConcept('付费经济')
    const core = newCore()
    await expect(core.addRelation('table', 'dws_pay', { target_kind: 'concept', name: '付费经济' }, ver('table', 'dws_pay'))).rejects.toThrow(StaleBaselineError)
  })

  it('is idempotent when the exact same edge is already present (added: false)', async () => {
    writeConcept('付费经济', { related_refs: [{ target_kind: 'concept', target: '用户生命周期' }] })
    writeConcept('用户生命周期')
    const core = newCore()
    const res = await core.addRelation('concept', '付费经济', { target_kind: 'concept', name: '用户生命周期' }, ver('concept', '付费经济'))
    expect(res.added).toBe(false)
    expect(res.unsuppressed).toBeUndefined()
  })

  it('lifts the veto when re-adding a suppressed edge (unsuppressed reports the key)', async () => {
    writeConcept('付费经济', { suppressed_related_refs: ['concept:用户生命周期'] })
    writeConcept('用户生命周期')
    const core = newCore()
    const res = await core.addRelation('concept', '付费经济', { target_kind: 'concept', name: '用户生命周期' }, ver('concept', '付费经济'))
    expect(res.added).toBe(true)
    expect(res.unsuppressed).toEqual(['concept:用户生命周期'])
    const def = core.loadConceptDefinition('付费经济')
    expect(def?.related_refs).toEqual([{ target_kind: 'concept', target: '用户生命周期', derivation: '' }])
    expect(def?.suppressed_related_refs).toEqual([])
  })

  it('veto key for a table target is the bare table name (no concept: prefix)', async () => {
    writeConcept('付费经济', { suppressed_related_refs: ['dws_pay'] })
    writeTable('dws_pay')
    const core = newCore()
    const res = await core.addRelation('concept', '付费经济', { target_kind: 'table', name: 'dws_pay' }, ver('concept', '付费经济'))
    expect(res.unsuppressed).toEqual(['dws_pay'])
  })

  it('throws when the target concept does not exist', async () => {
    writeConcept('付费经济')
    const core = newCore()
    await expect(core.addRelation('concept', '付费经济', { target_kind: 'concept', name: 'nope' }, ver('concept', '付费经济'))).rejects.toThrow(/Concept not found: nope/)
  })

  it('throws when the target table does not exist (concept subject)', async () => {
    writeConcept('付费经济')
    const core = newCore()
    await expect(core.addRelation('concept', '付费经济', { target_kind: 'table', name: 'nope' }, ver('concept', '付费经济'))).rejects.toThrow(/Table not found: nope/)
  })

  it('throws when the target concept does not exist (table subject)', async () => {
    writeTable('dws_pay')
    const core = newCore()
    await expect(core.addRelation('table', 'dws_pay', { target_kind: 'concept', name: 'nope' }, 'f'.repeat(64))).rejects.toThrow(/Concept not found: nope/)
  })

  it('refuses an event subject', async () => {
    const core = newCore()
    await expect(core.addRelation('event', 'pay_success', { target_kind: 'concept', name: 'x' }, 'f'.repeat(64))).rejects.toThrow(/not supported for events/)
  })

  it('refuses a join-shaped relation on a concept subject', async () => {
    writeConcept('付费经济')
    const core = newCore()
    await expect(core.addRelation('concept', '付费经济', { dim_table: 'dim_shop', join_keys: [{ dws_column: 'a', dim_column: 'b' }] }, ver('concept', '付费经济'))).rejects.toThrow(/not supported for concepts/)
  })

  it('throws StaleBaselineError on version mismatch', async () => {
    writeConcept('付费经济')
    writeConcept('用户生命周期')
    const core = newCore()
    await expect(core.addRelation('concept', '付费经济', { target_kind: 'concept', name: '用户生命周期' }, 'a'.repeat(64))).rejects.toThrow(StaleBaselineError)
  })
})

// ── removeRelations: concept-side edges (Q4(b)) ────────────────────────────

describe('removeRelations — concept-side edges', () => {
  it('curated removal: no veto (origin absent = agent-asserted)', async () => {
    writeConcept('付费经济', { related_refs: [{ target_kind: 'concept', target: '用户生命周期' }] })
    writeConcept('用户生命周期')
    const core = newCore()
    const res = await core.removeRelations('concept', '付费经济', [{ target_kind: 'concept', name: '用户生命周期' }], ver('concept', '付费经济'))
    expect(res.results).toEqual([
      { key: 'concept:用户生命周期', outcome: 'removed', suppressed: false, reasserted: false },
    ])
    const def = core.loadConceptDefinition('付费经济')
    expect(def?.related_refs).toEqual([])
    expect(def?.suppressed_related_refs).toEqual([])
  })

  it('machine-derived removal: veto recorded (suppressed: true)', async () => {
    writeConcept('付费经济', { related_refs: [{ target_kind: 'table', target: 'dws_pay', origin: 'deterministic', derivation: 'domains-match' }] })
    writeTable('dws_pay')
    const core = newCore()
    const res = await core.removeRelations('concept', '付费经济', [{ target_kind: 'table', name: 'dws_pay' }], ver('concept', '付费经济'))
    expect(res.results).toEqual([
      { key: 'dws_pay', outcome: 'removed', suppressed: true, reasserted: false },
    ])
    expect(core.loadConceptDefinition('付费经济')?.suppressed_related_refs).toContain('dws_pay')
  })

  it('ensure-absent: no matching edge → veto recorded', async () => {
    writeConcept('付费经济')
    writeConcept('用户生命周期')
    const core = newCore()
    const res = await core.removeRelations('concept', '付费经济', [{ target_kind: 'concept', name: '用户生命周期' }], ver('concept', '付费经济'))
    expect(res.results).toEqual([
      { key: 'concept:用户生命周期', outcome: 'absent', suppressed: true, reasserted: false },
    ])
  })

  it('reasserted is always false (concepts have no enrichment rounds, even with autoEnrich on)', async () => {
    writeConcept('付费经济', { related_refs: [{ target_kind: 'concept', target: '用户生命周期', origin: 'deterministic' }] })
    writeConcept('用户生命周期')
    const core = newCore(true)
    const res = await core.removeRelations('concept', '付费经济', [{ target_kind: 'concept', name: '用户生命周期' }], ver('concept', '付费经济'))
    expect(res.results[0]).toMatchObject({ reasserted: false })
  })

  it('batch removal from a concept subject: per-item verdicts', async () => {
    writeConcept('付费经济', { related_refs: [{ target_kind: 'concept', target: '用户生命周期' }] })
    writeConcept('用户生命周期')
    writeConcept('社交公会')
    const core = newCore()
    const res = await core.removeRelations('concept', '付费经济', [
      { target_kind: 'concept', name: '用户生命周期' },
      { target_kind: 'concept', name: '社交公会' },
    ], ver('concept', '付费经济'))
    expect(res.results).toHaveLength(2)
    expect(res.results[0]).toMatchObject({ key: 'concept:用户生命周期', outcome: 'removed', suppressed: false })
    expect(res.results[1]).toMatchObject({ key: 'concept:社交公会', outcome: 'absent', suppressed: true })
  })

  it('table subject: edges must all name the same target concept — splits the call otherwise', async () => {
    writeTable('dws_pay')
    writeConcept('付费经济')
    writeConcept('用户生命周期')
    const core = newCore()
    await expect(core.removeRelations('table', 'dws_pay', [
      { target_kind: 'concept', name: '付费经济' },
      { target_kind: 'concept', name: '用户生命周期' },
    ], 'f'.repeat(64))).rejects.toThrow(/split the call/)
  })

  it('table subject: single-target removal uses the target concept\'s baseline', async () => {
    writeTable('dws_pay')
    writeConcept('付费经济', { related_refs: [{ target_kind: 'table', target: 'dws_pay' }] })
    const core = newCore()
    const res = await core.removeRelations('table', 'dws_pay', [{ target_kind: 'concept', name: '付费经济' }], ver('concept', '付费经济'))
    expect(res.results).toEqual([
      { key: 'dws_pay', outcome: 'removed', suppressed: false, reasserted: false },
    ])
    expect(core.loadConceptDefinition('付费经济')?.related_refs).toEqual([])
  })

  it('rejects a batch mixing join-shaped relations with concept edges', async () => {
    writeConcept('付费经济', { related_refs: [{ target_kind: 'concept', target: '用户生命周期' }] })
    writeConcept('用户生命周期')
    const core = newCore()
    await expect(core.removeRelations('concept', '付费经济', [
      { target_kind: 'concept', name: '用户生命周期' },
      { dim_table: 'dim_shop', join_keys: [{ dws_column: 'a', dim_column: 'b' }] },
    ], ver('concept', '付费经济'))).rejects.toThrow(/cannot mix/)
  })

  it('refuses an event subject', async () => {
    const core = newCore()
    await expect(core.removeRelations('event', 'pay_success', [{ target_kind: 'concept', name: 'x' }], 'f'.repeat(64))).rejects.toThrow(/not supported for events/)
  })

  it('throws Error for a missing concept subject', async () => {
    const core = newCore()
    await expect(core.removeRelations('concept', 'nope', [{ target_kind: 'concept', name: 'x' }], 'f'.repeat(64))).rejects.toThrow(/Concept not found/)
  })

  it('throws StaleBaselineError on version mismatch', async () => {
    writeConcept('付费经济', { related_refs: [{ target_kind: 'concept', target: '用户生命周期' }] })
    writeConcept('用户生命周期')
    const core = newCore()
    await expect(core.removeRelations('concept', '付费经济', [{ target_kind: 'concept', name: '用户生命周期' }], 'a'.repeat(64))).rejects.toThrow(StaleBaselineError)
  })
})

// ── addAlias / removeAliases on concepts ────────────────────────────────────

describe('addAlias / removeAliases on a concept (AliasKindSchema parity)', () => {
  it('addAlias appends to a concept\'s alt_labels', async () => {
    writeConcept('付费经济')
    const core = newCore()
    const res = await core.addAlias('concept', '付费经济', '氪金', ver('concept', '付费经济'))
    expect(res.added).toBe(true)
    expect(core.loadConceptDefinition('付费经济')?.alt_labels).toContain('氪金')
  })

  it('removeAliases vetoes a concept alias (suppressed_alt_labels)', async () => {
    writeConcept('付费经济', { alt_labels: ['氪金'] })
    const core = newCore()
    const res = await core.removeAliases('concept', '付费经济', ['氪金'], ver('concept', '付费经济'))
    expect(res.results).toEqual([
      { key: '氪金', outcome: 'removed', suppressed: true, reasserted: false },
    ])
    const def = core.loadConceptDefinition('付费经济')
    expect(def?.alt_labels).not.toContain('氪金')
    expect(def?.suppressed_alt_labels).toContain('氪金')
  })
})

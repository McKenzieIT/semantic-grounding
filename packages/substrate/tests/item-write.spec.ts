/**
 * Core item write methods — domain-level contracts for `addAlias`, `removeAliases`,
 * `addRelation`, `removeRelations` (#49 / ticket #49).
 *
 * These tests call the Core methods directly (not through the MCP wire) — they pin
 * the domain logic that the MCP handlers thin to: schema + auditedWrite + Core call +
 * response formatting. The MCP wire tests (`intent-tools-items.spec.ts`) cover the
 * handler layer (error mapping, enrichment_health, response shape).
 *
 * Coverage:
 * - addAlias: basic add, idempotent, veto lift, events, missing def, stale version.
 * - removeAliases: removed/absent/idempotent verdicts, normalizeLabel, batch, ensure-absent.
 * - addRelation: basic add, idempotent, dim_table check, veto lift, events.
 * - removeRelations: curated (no veto), machine-derived (veto), ensure-absent, two-step dance.
 * - StaleBaselineError propagation through all four methods.
 * - Dual-field overlay hygiene: suppressed_* not introduced on defs that never had them.
 *
 * @see docs/adr/0005-mcp-tool-surface.md + docs/adr/0010-suppression.md
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import {
  SemanticGroundingCore,
  dumpYaml,
  StaleBaselineError,
  type Tier2Recorder,
} from '../src/index.ts'
import { definitionVersion } from '../src/io.ts'
import { suppressionJoinsUpdate } from '../src/item-write.ts'

const noopRecorder: Tier2Recorder = { recordTier2Write: async () => 'noop-log-id' }

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'item-write-'))
  mkdirSync(join(root, 'tables'), { recursive: true })
  mkdirSync(join(root, 'events', 'biz'), { recursive: true })
  writeFileSync(join(root, 'config.yaml'), dumpYaml({ scope_id: 'fixture' }), 'utf8')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Build a valid table YAML with the minimum fields the schema requires. */
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

function writeDim(name: string, pk: string): void {
  writeTable(name, {
    kind: 'dim',
    primary_key: [pk],
    label_columns: [`${name}_label`],
    granularity: '维表(非分区,全量参考,无时间维度)',
    freshness: 'static_reference',
    columns: [
      { name: pk, type: 'string', comment: '' },
      { name: `${name}_label`, type: 'string', comment: '' },
    ],
  })
}

/** Write a DWS table with the given columns + any extra fields. */
function writeDws(name: string, cols: Array<{ name: string; type: string }>, extra: Record<string, unknown> = {}): void {
  writeTable(name, {
    kind: 'dws',
    columns: cols.map(c => ({ ...c, comment: '', role: 'dimension' })),
    ...extra,
  })
}

function writeEvent(name: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(root, 'events', 'biz', `${name}.yaml`), dumpYaml({
    name,
    event_filter: '',
    description: '',
    alt_labels: [],
    domains: [],
    params_fields: {},
    metrics: {},
    disambiguation: [],
    external_refs: [],
    ...extra,
  }), 'utf8')
}

function newCore(autoEnrich = false): SemanticGroundingCore {
  const core = new SemanticGroundingCore({ semanticRoot: root, scopeId: 'fixture', autoEnrich })
  core.setTier2Recorder(noopRecorder)
  return core
}

function ver(kind: 'table' | 'event', name: string): string {
  const v = definitionVersion(root, kind, name)
  if (v === null) throw new Error(`no version for ${kind}/${name}`)
  return v
}

/** Read a table's raw YAML dict off disk — the byte-level lens. The zod-parsed
 * definitions cannot pin this: `.default([])` on the suppression fields makes
 * an absent field and an empty one parse identically, so "the file never had
 * a `suppressed_*`" is only observable here. (Same shape as
 * enrichment-work.spec.ts's readTableRaw — io.ts does not export one.) */
function readTableRaw(dir: string, name: string): Record<string, unknown> {
  return yaml.load(readFileSync(join(dir, 'tables', `${name}.yaml`), 'utf-8')) as Record<string, unknown>
}

const ORDER_COLS = [{ name: 'order_id', type: 'string' }]
const SHOP_COLS = [{ name: 'shop_id', type: 'string' }, { name: 'pay_amt', type: 'double' }]
const SHOP_REF = { dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }

// ── addAlias ─────────────────────────────────────────────────────────────

describe('addAlias', () => {
  it('appends a new alias to a table', async () => {
    writeDws('dws_pay', ORDER_COLS)
    const core = newCore()
    const res = await core.addAlias('table', 'dws_pay', '付费流水', ver('table', 'dws_pay'))
    expect(res.added).toBe(true)
    expect(core.loadTableDefinition('dws_pay')?.alt_labels).toContain('付费流水')
  })

  it('is idempotent when the alias is already present (added: false)', async () => {
    writeDws('dws_pay', ORDER_COLS, { alt_labels: ['付费流水'] })
    const core = newCore()
    const res = await core.addAlias('table', 'dws_pay', '付费流水', ver('table', 'dws_pay'))
    expect(res.added).toBe(false)
    expect(res.unsuppressed).toBeUndefined()
  })

  it('lifts the veto when re-adding a suppressed alias (unsuppressed reports the key)', async () => {
    writeDws('dws_pay', ORDER_COLS, { suppressed_alt_labels: ['付费流水'] })
    const core = newCore()
    const res = await core.addAlias('table', 'dws_pay', '付费流水', ver('table', 'dws_pay'))
    expect(res.added).toBe(true)
    expect(res.unsuppressed).toEqual(['付费流水'])
    const def = core.loadTableDefinition('dws_pay')
    expect(def?.alt_labels).toContain('付费流水')
    expect(def?.suppressed_alt_labels).not.toContain('付费流水')
  })

  it('covers events: addAlias on an event lands alt_labels', async () => {
    writeEvent('pay_success', { params_fields: { order_id: { type: 'string', description: '' } } })
    const core = newCore()
    const res = await core.addAlias('event', 'pay_success', '支付成功', ver('event', 'pay_success'))
    expect(res.added).toBe(true)
    expect(core.loadEventDefinition('pay_success')?.alt_labels).toContain('支付成功')
  })

  it('throws Error for a missing definition', async () => {
    const core = newCore()
    await expect(core.addAlias('table', 'nope', 'x', 'f'.repeat(64))).rejects.toThrow(/Table not found/)
  })

  it('throws StaleBaselineError on version mismatch', async () => {
    writeDws('dws_pay', ORDER_COLS)
    const core = newCore()
    await expect(core.addAlias('table', 'dws_pay', 'x', 'a'.repeat(64))).rejects.toThrow(StaleBaselineError)
  })
})

// ── removeAliases ────────────────────────────────────────────────────────

describe('removeAliases', () => {
  it('removes a present alias and records the veto (outcome: removed, suppressed: true)', async () => {
    writeDws('dws_pay', ORDER_COLS, { alt_labels: ['付费流水'] })
    const core = newCore()
    const res = await core.removeAliases('table', 'dws_pay', ['付费流水'], ver('table', 'dws_pay'))
    expect(res.results).toEqual([
      { key: '付费流水', outcome: 'removed', suppressed: true, reasserted: false },
    ])
    const def = core.loadTableDefinition('dws_pay')
    expect(def?.alt_labels).not.toContain('付费流水')
    expect(def?.suppressed_alt_labels).toContain('付费流水')
  })

  it('ensure-absent: absent alias gets vetoed (outcome: absent, suppressed: true)', async () => {
    writeDws('dws_pay', ORDER_COLS)
    const core = newCore()
    const res = await core.removeAliases('table', 'dws_pay', ['从未加过'], ver('table', 'dws_pay'))
    expect(res.results).toEqual([
      { key: '从未加过', outcome: 'absent', suppressed: true, reasserted: false },
    ])
    expect(core.loadTableDefinition('dws_pay')?.suppressed_alt_labels).toContain('从未加过')
  })

  it('idempotent: already absent AND already vetoed (outcome: idempotent, suppressed: false)', async () => {
    writeDws('dws_pay', ORDER_COLS, { suppressed_alt_labels: ['已否决'] })
    const core = newCore()
    const res = await core.removeAliases('table', 'dws_pay', ['已否决'], ver('table', 'dws_pay'))
    expect(res.results).toEqual([
      { key: '已否决', outcome: 'idempotent', suppressed: false, reasserted: false },
    ])
  })

  it('normalizeLabel: DAU added, dau removed → key matches on normalized form', async () => {
    writeDws('dws_pay', ORDER_COLS, { alt_labels: ['DAU'] })
    const core = newCore()
    const res = await core.removeAliases('table', 'dws_pay', ['dau'], ver('table', 'dws_pay'))
    expect(res.results[0]?.outcome).toBe('removed')
    expect(res.results[0]?.key).toBe('dau')
    expect(core.loadTableDefinition('dws_pay')?.alt_labels).not.toContain('DAU')
  })

  it('same-target batch: one call, per-item verdicts (removed + absent)', async () => {
    writeDws('dws_pay', ORDER_COLS, { alt_labels: ['别名甲'] })
    const core = newCore()
    const res = await core.removeAliases('table', 'dws_pay', ['别名甲', '不在场的乙'], ver('table', 'dws_pay'))
    expect(res.results).toHaveLength(2)
    expect(res.results[0]).toEqual({ key: '别名甲', outcome: 'removed', suppressed: true, reasserted: false })
    expect(res.results[1]).toEqual({ key: '不在场的乙', outcome: 'absent', suppressed: true, reasserted: false })
    const def = core.loadTableDefinition('dws_pay')
    expect(def?.suppressed_alt_labels).toEqual(expect.arrayContaining(['别名甲', '不在场的乙']))
  })

  it('throws Error for a missing definition', async () => {
    const core = newCore()
    await expect(core.removeAliases('table', 'nope', ['x'], 'f'.repeat(64))).rejects.toThrow(/Table not found/)
  })
})

// ── addRelation ──────────────────────────────────────────────────────────

describe('addRelation', () => {
  it('appends a relation (no origin/derivation on the stored entry — curated)', async () => {
    writeDim('dim_shop', 'shop_id')
    writeDws('dws_order', SHOP_COLS)
    const core = newCore()
    const res = await core.addRelation('table', 'dws_order', SHOP_REF, ver('table', 'dws_order'))
    expect(res.added).toBe(true)
    const ref = core.loadTableDefinition('dws_order')?.dimension_refs.find(r => r.dim_table === 'dim_shop')
    expect(ref).toBeDefined()
    expect(ref).not.toHaveProperty('origin')
  })

  it('is idempotent when the exact same relation is already present (added: false)', async () => {
    writeDim('dim_shop', 'shop_id')
    writeDws('dws_order', SHOP_COLS, {
      dimension_refs: [{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
    })
    const core = newCore()
    const res = await core.addRelation('table', 'dws_order', SHOP_REF, ver('table', 'dws_order'))
    expect(res.added).toBe(false)
    expect(res.unsuppressed).toBeUndefined()
  })

  it('throws when dim_table has no table definition (table kind)', async () => {
    writeDws('dws_order', SHOP_COLS)
    const core = newCore()
    await expect(core.addRelation('table', 'dws_order', SHOP_REF, ver('table', 'dws_order'))).rejects.toThrow(/Table not found: dim_shop/)
  })

  it('lifts veto when re-adding a suppressed dim_table (unsuppressed reports the key)', async () => {
    writeDim('dim_shop', 'shop_id')
    writeDws('dws_order', SHOP_COLS, { suppressed_dimension_refs: ['dim_shop'] })
    const core = newCore()
    const res = await core.addRelation('table', 'dws_order', SHOP_REF, ver('table', 'dws_order'))
    expect(res.added).toBe(true)
    expect(res.unsuppressed).toEqual(['dim_shop'])
    const def = core.loadTableDefinition('dws_order')
    expect(def?.dimension_refs.find(r => r.dim_table === 'dim_shop')).toBeDefined()
    expect(def?.suppressed_dimension_refs).toEqual([])
  })

  it('covers events: addRelation on an event lands external_refs (no dim_table check)', async () => {
    writeEvent('pay_success', {
      params_fields: { shop_id: { type: 'string', description: '' } },
    })
    const core = newCore()
    const res = await core.addRelation('event', 'pay_success', SHOP_REF, ver('event', 'pay_success'))
    expect(res.added).toBe(true)
    expect(core.loadEventDefinition('pay_success')?.external_refs.find(r => r.dim_table === 'dim_shop')).toBeDefined()
  })

  it('a different join_keys on the same dim_table is a distinct relation', async () => {
    writeDim('dim_shop', 'shop_id')
    writeDws('dws_order', SHOP_COLS)
    const core = newCore()
    await core.addRelation('table', 'dws_order', SHOP_REF, ver('table', 'dws_order'))
    const altRef = { dim_table: 'dim_shop', join_keys: [{ dws_column: 'pay_amt', dim_column: 'shop_id' }] }
    await core.addRelation('table', 'dws_order', altRef, ver('table', 'dws_order'))
    const refs = core.loadTableDefinition('dws_order')?.dimension_refs.filter(r => r.dim_table === 'dim_shop') ?? []
    expect(refs).toHaveLength(2)
  })
})

// ── removeRelations ──────────────────────────────────────────────────────

describe('removeRelations', () => {
  it('curated removal: no veto (suppressed: false) — origin absent = agent-asserted', async () => {
    writeDim('dim_shop', 'shop_id')
    writeDws('dws_order', [{ name: 'shop_id', type: 'string' }], {
      dimension_refs: [{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
    })
    const core = newCore()
    const res = await core.removeRelations('table', 'dws_order', [SHOP_REF], ver('table', 'dws_order'))
    expect(res.results).toEqual([
      { key: 'dim_shop', outcome: 'removed', suppressed: false, reasserted: false },
    ])
    const def = core.loadTableDefinition('dws_order')
    expect(def?.dimension_refs.find(r => r.dim_table === 'dim_shop')).toBeUndefined()
    expect(def?.suppressed_dimension_refs).toEqual([])
  })

  it('machine-derived removal: veto recorded (suppressed: true)', async () => {
    writeDim('dim_shop', 'shop_id')
    writeDws('dws_order', [{ name: 'shop_id', type: 'string' }], {
      dimension_refs: [{
        dim_table: 'dim_shop',
        join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }],
        origin: 'deterministic',
        derivation: 'pk-match',
      }],
    })
    const core = newCore()
    const res = await core.removeRelations('table', 'dws_order', [SHOP_REF], ver('table', 'dws_order'))
    expect(res.results).toEqual([
      { key: 'dim_shop', outcome: 'removed', suppressed: true, reasserted: false },
    ])
    const def = core.loadTableDefinition('dws_order')
    expect(def?.dimension_refs.find(r => r.dim_table === 'dim_shop')).toBeUndefined()
    expect(def?.suppressed_dimension_refs).toContain('dim_shop')
  })

  it('ensure-absent: no matching relation → veto recorded (outcome: absent, suppressed: true)', async () => {
    writeDws('dws_order', [{ name: 'shop_id', type: 'string' }])
    const core = newCore()
    const res = await core.removeRelations('table', 'dws_order', [SHOP_REF], ver('table', 'dws_order'))
    expect(res.results).toEqual([
      { key: 'dim_shop', outcome: 'absent', suppressed: true, reasserted: false },
    ])
    expect(core.loadTableDefinition('dws_order')?.suppressed_dimension_refs).toContain('dim_shop')
  })

  it('the curated two-step dance: first removal is reasserted by the hook; second removal vetoes for good', async () => {
    writeDim('dim_shop', 'shop_id')
    writeDws('dws_order', [{ name: 'shop_id', type: 'string' }])
    const core = newCore(true) // autoEnrich: true — on-write hook runs deterministic discovery.
    // Step 0: add a curated ref (no origin).
    await core.addRelation('table', 'dws_order', SHOP_REF, ver('table', 'dws_order'))
    expect(core.loadTableDefinition('dws_order')?.dimension_refs.find(r => r.dim_table === 'dim_shop')).toBeDefined()

    // Step 1: remove the curated ref — no veto (origin routing), so the on-write
    // hook re-derives it with origin deterministic. The receipt says reasserted: true.
    const first = await core.removeRelations('table', 'dws_order', [SHOP_REF], ver('table', 'dws_order'))
    expect(first.results).toEqual([
      { key: 'dim_shop', outcome: 'removed', suppressed: false, reasserted: true },
    ])
    expect(core.loadTableDefinition('dws_order')?.dimension_refs.find(r => r.dim_table === 'dim_shop')?.origin).toBe('deterministic')

    // Step 2: remove again — now machine-derived, the removal vetoes it, and the
    // hook's discovery is filtered. Gone for good.
    const second = await core.removeRelations('table', 'dws_order', [SHOP_REF], ver('table', 'dws_order'))
    expect(second.results).toEqual([
      { key: 'dim_shop', outcome: 'removed', suppressed: true, reasserted: false },
    ])
    const def = core.loadTableDefinition('dws_order')
    expect(def?.dimension_refs.find(r => r.dim_table === 'dim_shop')).toBeUndefined()
    expect(def?.suppressed_dimension_refs).toContain('dim_shop')
  })

  it('same-target batch: per-item verdicts for multiple relations', async () => {
    writeDim('dim_shop', 'shop_id')
    writeDim('dim_user', 'user_id')
    writeDws('dws_order', [{ name: 'shop_id', type: 'string' }], {
      dimension_refs: [{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
    })
    const core = newCore()
    const userRef = { dim_table: 'dim_user', join_keys: [{ dws_column: 'user_id', dim_column: 'user_id' }] }
    const res = await core.removeRelations('table', 'dws_order', [SHOP_REF, userRef], ver('table', 'dws_order'))
    expect(res.results).toHaveLength(2)
    expect(res.results[0]).toMatchObject({ key: 'dim_shop', outcome: 'removed', suppressed: false })
    expect(res.results[1]).toMatchObject({ key: 'dim_user', outcome: 'absent', suppressed: true })
  })

  it('throws Error for a missing definition', async () => {
    const core = newCore()
    await expect(core.removeRelations('table', 'nope', [SHOP_REF], 'f'.repeat(64))).rejects.toThrow(/Table not found/)
  })
})

// ── StaleBaselineError propagation ──────────────────────────────────────

describe('StaleBaselineError propagates through all four Core item methods', () => {
  const stale = 'stale'.repeat(13).slice(0, 64)

  it('addAlias throws StaleBaselineError on stale version', async () => {
    writeDws('dws_pay', ORDER_COLS)
    const core = newCore()
    await expect(core.addAlias('table', 'dws_pay', 'x', stale)).rejects.toThrow(StaleBaselineError)
  })

  it('removeAliases throws StaleBaselineError on stale version', async () => {
    writeDws('dws_pay', ORDER_COLS, { alt_labels: ['x'] })
    const core = newCore()
    await expect(core.removeAliases('table', 'dws_pay', ['x'], stale)).rejects.toThrow(StaleBaselineError)
  })

  it('addRelation throws StaleBaselineError on stale version', async () => {
    writeDim('dim_shop', 'shop_id')
    writeDws('dws_order', [{ name: 'shop_id', type: 'string' }])
    const core = newCore()
    await expect(core.addRelation('table', 'dws_order', SHOP_REF, stale)).rejects.toThrow(StaleBaselineError)
  })

  it('removeRelations throws StaleBaselineError on stale version', async () => {
    writeDws('dws_order', [{ name: 'shop_id', type: 'string' }])
    const core = newCore()
    await expect(core.removeRelations('table', 'dws_order', [SHOP_REF], stale)).rejects.toThrow(StaleBaselineError)
  })
})

// ── Dual-field overlay hygiene ──────────────────────────────────────────

describe('dual-field overlay hygiene', () => {
  it('addAlias does not introduce suppressed_alt_labels on a def that never had it (no-op path)', async () => {
    writeDws('dws_pay', ORDER_COLS, { alt_labels: ['已有'] })
    const core = newCore()
    const res = await core.addAlias('table', 'dws_pay', '已有', ver('table', 'dws_pay'))
    expect(res.added).toBe(false)
    // Raw lens: the parsed `.suppressed_alt_labels` is `.default([])`-masked
    // (absent parses to `[]`), which cannot pin the byte layer — the on-disk
    // dict must NOT carry the field at all.
    expect('suppressed_alt_labels' in readTableRaw(root, 'dws_pay')).toBe(false)
  })

  it('removeAliases introduces suppressed_alt_labels when the veto set changes', async () => {
    writeDws('dws_pay', ORDER_COLS, { alt_labels: ['活词'] })
    const core = newCore()
    await core.removeAliases('table', 'dws_pay', ['活词'], ver('table', 'dws_pay'))
    const def = core.loadTableDefinition('dws_pay')
    expect(def?.suppressed_alt_labels).toContain('活词')
    expect(def?.alt_labels).not.toContain('活词')
    // Raw-lens mirror: the veto field is really on disk, not a parsed default.
    expect('suppressed_alt_labels' in readTableRaw(root, 'dws_pay')).toBe(true)
  })
})

// ── Byte-stability gate quadrants (suppressionJoinsUpdate) ──────────────

describe('suppressionJoinsUpdate (byte-stability gate quadrants)', () => {
  // {list changed, unchanged} × {field on disk, absent} → join / join / join / skip.
  it('joins when the list changed and the field is absent from disk', () => {
    expect(suppressionJoinsUpdate({}, 'suppressed_alt_labels', [], ['新词'])).toBe(true)
  })

  it('joins when the list changed and the field exists on disk', () => {
    expect(suppressionJoinsUpdate({ suppressed_alt_labels: ['旧词'] }, 'suppressed_alt_labels', ['旧词'], ['旧词', '新词'])).toBe(true)
  })

  it('joins when unchanged but the field exists on disk (veto-lift to empty must persist)', () => {
    expect(suppressionJoinsUpdate({ suppressed_alt_labels: ['x'] }, 'suppressed_alt_labels', ['x'], ['x'])).toBe(true)
  })

  it('does not join when unchanged and absent from disk (no-op must not introduce)', () => {
    expect(suppressionJoinsUpdate({}, 'suppressed_alt_labels', [], [])).toBe(false)
  })
})

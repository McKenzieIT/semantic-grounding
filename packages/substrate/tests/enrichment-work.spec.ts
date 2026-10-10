/**
 * ADR-0006's LLM half: `listEnrichmentWork` / `applyEnrichmentResults` (`src/index.ts`,
 * wrapping `src/enrichment-work.ts`). Covers the Verification section's substrate-level
 * claims directly (work_id self-containment, lenient per-item verdicts, batch-level
 * idempotence); the full real-git versions of the same claims (one commit, restart
 * survival through an actual process boundary, inline `enrichment_health`) are
 * `packages/mcp/tests/enrichment-tools.spec.ts`'s job — this file never touches git.
 */
import { afterEach, describe, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { SemanticGroundingCore, type Tier2Batch, type Tier2RecordMeta, type Tier2Recorder } from '../src/index.ts'
import { dumpYaml } from '../src/io.ts'
import type { EventDefinition, TableDefinition } from '../src/types.ts'

// ── Fixture builders (mirrors tests/discover-relations.spec.ts's dimDoc/dwsDoc) ────

const dimDoc = (name: string, pk: string): TableDefinition => ({
  table_name: name, table_comment: '', description: `${name} 维度表`, alt_labels: [], domains: [],
  granularity: '', engine: 'maxcompute',
  columns: [{ name: pk, type: 'string', comment: 'pk', role: 'dimension' }, { name: `${pk}_name`, type: 'string', comment: 'name', role: 'dimension' }],
  metrics: {}, partitions: [], confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
  coverage: null, supersedes: [], disambiguation: null, kind: 'dim', primary_key: [pk], primary_key_unique: null,
  duplicate_sample: [], label_columns: [`${pk}_name`], freshness: 'static_reference', dimension_refs: [],
  suppressed_alt_labels: [], suppressed_dimension_refs: [],
})

const dwsDoc = (name: string, cols: Array<{ name: string; comment?: string }>, overrides: Partial<TableDefinition> = {}): TableDefinition => ({
  table_name: name, table_comment: '', description: `${name} dws`, alt_labels: [], domains: [],
  granularity: '', engine: 'maxcompute',
  columns: cols.map(c => ({ name: c.name, type: 'string', comment: c.comment ?? '', role: 'dimension' })),
  metrics: {}, partitions: [], confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
  coverage: null, supersedes: [], disambiguation: null, kind: 'dws', primary_key: [], primary_key_unique: null,
  duplicate_sample: [], label_columns: [], freshness: '', dimension_refs: [],
  suppressed_alt_labels: [], suppressed_dimension_refs: [],
  ...overrides,
})

const eventDoc = (name: string, fields: Record<string, { type: string; description: string }>, overrides: Partial<EventDefinition> = {}): EventDefinition => ({
  name, event_filter: '', description: `${name} 事件`, alt_labels: [], domains: [],
  params_fields: fields, metrics: {}, disambiguation: [], external_refs: [],
  confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' }, coverage: null,
  suppressed_alt_labels: [], suppressed_external_refs: [],
  ...overrides,
})

function newLayer(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sg-ew-'))
  mkdirSync(join(dir, 'tables'), { recursive: true })
  mkdirSync(join(dir, 'events', 'biz'), { recursive: true })
  writeFileSync(join(dir, 'config.yaml'), 'project:\n  name: t\n  scope_id: t\n')
  return dir
}
function writeTableFixture(dir: string, def: TableDefinition): void {
  writeFileSync(join(dir, 'tables', `${def.table_name}.yaml`), dumpYaml(def))
}
function writeEventFixture(dir: string, def: EventDefinition): void {
  writeFileSync(join(dir, 'events', 'biz', `${def.name}.yaml`), dumpYaml(def))
}
function readTableRaw(dir: string, name: string): Record<string, unknown> {
  return yaml.load(readFileSync(join(dir, 'tables', `${name}.yaml`), 'utf-8')) as Record<string, unknown>
}

/** A Tier2Recorder test double that implements `beginBatch`, tracking every
 * `recordTier2Write` and every batch's `record()` calls for assertions. */
function fakeRecorder(): {
  readonly recorder: Tier2Recorder
  readonly directWrites: Array<{ tool: string; payload: unknown }>
  readonly batchRecordCalls: Array<{ tool: string; payload: unknown }>
  readonly batchEnded: boolean[]
  readonly batchAborted: boolean[]
} {
  const directWrites: Array<{ tool: string; payload: unknown }> = []
  const batchRecordCalls: Array<{ tool: string; payload: unknown }> = []
  const batchEnded: boolean[] = []
  const batchAborted: boolean[] = []
  const recorder: Tier2Recorder = {
    async recordTier2Write(tool: string, payload: unknown) {
      directWrites.push({ tool, payload })
      return `direct-${directWrites.length}`
    },
    beginBatch(_meta?: Tier2RecordMeta): Tier2Batch {
      const items: Array<{ tool: string; payload: unknown }> = []
      return {
        record(tool: string, payload: unknown) {
          items.push({ tool, payload })
          batchRecordCalls.push({ tool, payload })
        },
        async end() {
          batchEnded.push(true)
          return items.length > 0 ? { commit: `batch-${batchEnded.length}`, files: items.length } : { commit: 'HEAD', files: 0 }
        },
        async abort() {
          batchAborted.push(true)
        },
      }
    },
  }
  return { recorder, directWrites, batchRecordCalls, batchEnded, batchAborted }
}

let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

// ── work_id: self-contained identity ────────────────────────────────────

describe('work_id self-containment', () => {
  test('a fresh work_id round-trips through independent core instances (no session state)', async () => {
    dir = newLayer()
    writeTableFixture(dir, dwsDoc('dws_order', [{ name: 'shop_id' }]))

    // "Server restart" at the substrate level: a brand new SemanticGroundingCore
    // instance, constructed after the first has already gone out of scope. Nothing
    // about work_id depends on any state the first instance held.
    const issuer = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await issuer.listEnrichmentWork()
    const item = work.find(w => w.target === 'dws_order' && w.gap.includes('alt_labels'))
    expect(item).toBeDefined()

    const applier = new SemanticGroundingCore({ semanticRoot: dir })
    const { recorder } = fakeRecorder()
    const res = await applier.applyEnrichmentResults([{ work_id: item!.work_id, text: '["订单宽表"]' }], recorder)
    expect(res.results[0]).toMatchObject({ verdict: 'applied', target: 'dws_order', round: 'alt_labels' })
  })

  test('a garbage work_id reports stale_baseline rather than throwing', async () => {
    dir = newLayer()
    writeTableFixture(dir, dwsDoc('dws_order', [{ name: 'shop_id' }]))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { recorder } = fakeRecorder()
    const res = await core.applyEnrichmentResults([{ work_id: 'not-a-real-work-id', text: 'anything' }], recorder)
    expect(res.results[0]).toMatchObject({ verdict: 'stale_baseline', target: '(unknown)' })
  })

  test('a work_id whose target no longer exists reports stale_baseline', async () => {
    dir = newLayer()
    writeTableFixture(dir, dwsDoc('dws_order', [{ name: 'shop_id' }]))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    const item = work[0]
    expect(item).toBeDefined()
    rmSync(join(dir, 'tables', 'dws_order.yaml'))
    const { recorder } = fakeRecorder()
    const res = await core.applyEnrichmentResults([{ work_id: item!.work_id, text: '["x"]' }], recorder)
    expect(res.results[0]?.verdict).toBe('stale_baseline')
  })

  test('a work_id whose target changed since issuance reports stale_baseline (not merged into)', async () => {
    dir = newLayer()
    writeTableFixture(dir, dwsDoc('dws_order', [{ name: 'shop_id' }]))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    const item = work.find(w => w.gap.includes('alt_labels'))
    expect(item).toBeDefined()

    // Someone else's edit lands between issuance and apply.
    writeTableFixture(dir, dwsDoc('dws_order', [{ name: 'shop_id' }], { description: 'edited after issuance' }))

    const { recorder } = fakeRecorder()
    const res = await core.applyEnrichmentResults([{ work_id: item!.work_id, text: '["订单宽表"]' }], recorder)
    expect(res.results[0]?.verdict).toBe('stale_baseline')
    // Not merged: alt_labels is untouched by the rejected apply.
    expect(readTableRaw(dir, 'dws_order').alt_labels).toEqual([])
  })

  test('peekEnrichmentWorkTarget resolves the target without applying or verifying the baseline', async () => {
    dir = newLayer()
    writeTableFixture(dir, dwsDoc('dws_order', [{ name: 'shop_id' }]))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    const item = work[0]
    expect(core.peekEnrichmentWorkTarget(item!.work_id)).toBe('dws_order')
    expect(core.peekEnrichmentWorkTarget('garbage')).toBeUndefined()
  })
})

// ── listEnrichmentWork: gap detection ────────────────────────────────────

describe('listEnrichmentWork: gap detection', () => {
  test('a DWS with empty dimension_refs + a DIM in inventory produces a relation work item', async () => {
    dir = newLayer()
    writeTableFixture(dir, dimDoc('dim_shop', 'shop_id'))
    writeTableFixture(dir, dwsDoc('dws_order', [{ name: 'shop_id' }]))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    const relationItem = work.find(w => w.target === 'dws_order' && w.gap.startsWith('dimension_refs'))
    expect(relationItem).toBeDefined()
    // ADR-0008: the row carries the gap, never the prompt — the prompt is a separate
    // batched fetch (pinned in the getEnrichmentPrompts block below).
    expect(Object.keys(relationItem!).sort()).toEqual(['gap', 'target', 'work_id'])
  })

  test('no DIM inventory at all suppresses relation work items entirely', async () => {
    dir = newLayer()
    writeTableFixture(dir, dwsDoc('dws_order', [{ name: 'shop_id' }]))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    expect(work.some(w => w.gap.startsWith('dimension_refs'))).toBe(false)
  })

  test('a DWS with existing dimension_refs produces no relation work item', async () => {
    dir = newLayer()
    writeTableFixture(dir, dimDoc('dim_shop', 'shop_id'))
    writeTableFixture(dir, dwsDoc('dws_order', [{ name: 'shop_id' }], {
      dimension_refs: [{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }], derivation: 'curated', origin: 'manual' }],
    }))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    expect(work.some(w => w.target === 'dws_order' && w.gap.startsWith('dimension_refs'))).toBe(false)
  })

  test('a DIM table never produces a relation work item', async () => {
    dir = newLayer()
    writeTableFixture(dir, dimDoc('dim_shop', 'shop_id'))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    expect(work.some(w => w.target === 'dim_shop' && w.gap.startsWith('dimension_refs'))).toBe(false)
    // alt_labels gap still applies to a DIM table (mirrors enrichAllTablesAltLabels,
    // which does not filter by kind).
    expect(work.some(w => w.target === 'dim_shop' && w.gap.startsWith('alt_labels'))).toBe(true)
  })

  test('events get relation + alt_labels work items, mirroring tables', async () => {
    dir = newLayer()
    writeTableFixture(dir, dimDoc('dim_shop', 'shop_id'))
    writeEventFixture(dir, eventDoc('pay_success', { shop_id: { type: 'string', description: '店铺ID' } }))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    expect(work.some(w => w.target === 'pay_success' && w.gap.startsWith('external_refs'))).toBe(true)
    expect(work.some(w => w.target === 'pay_success' && w.gap.startsWith('alt_labels'))).toBe(true)
  })

  test('tables/events filters restrict the scan (call-wide, ADR-0007)', async () => {
    dir = newLayer()
    writeTableFixture(dir, dimDoc('dim_shop', 'shop_id'))
    writeTableFixture(dir, dwsDoc('dws_a', [{ name: 'x' }]))
    writeTableFixture(dir, dwsDoc('dws_b', [{ name: 'x' }]))
    writeEventFixture(dir, eventDoc('pay_success', { shop_id: { type: 'string', description: '店铺ID' } }))
    const core = new SemanticGroundingCore({ semanticRoot: dir })

    // tables named -> ONLY those tables' gaps; the events dimension is out of the call.
    const tablesOnly = await core.listEnrichmentWork({ tables: ['dws_a'] })
    expect(tablesOnly.work.every(w => w.target === 'dws_a')).toBe(true)
    expect(tablesOnly.work.some(w => w.target === 'pay_success')).toBe(false)
    // events named -> the mirror: no table rows at all.
    const eventsOnly = await core.listEnrichmentWork({ events: ['pay_success'] })
    expect(eventsOnly.work.every(w => w.target === 'pay_success')).toBe(true)
    expect(eventsOnly.work.some(w => w.target === 'dws_b')).toBe(false)
    // both named -> both legs, each scoped.
    const both = await core.listEnrichmentWork({ tables: ['dws_b'], events: ['pay_success'] })
    expect(both.work.map(w => w.target).sort()).toEqual(['dws_b', 'dws_b', 'pay_success', 'pay_success'])
    // {} (or no keys) is the one full-corpus shape.
    const full = await core.listEnrichmentWork({})
    expect(full.work.some(w => w.target === 'dws_a')).toBe(true)
    expect(full.work.some(w => w.target === 'dws_b')).toBe(true)
    expect(full.work.some(w => w.target === 'pay_success')).toBe(true)
  })

  test('every work_id is unique per target+round even when issued in the same call', async () => {
    dir = newLayer()
    writeTableFixture(dir, dimDoc('dim_shop', 'shop_id'))
    writeTableFixture(dir, dwsDoc('dws_order', [{ name: 'shop_id' }]))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    const ids = new Set(work.map(w => w.work_id))
    expect(ids.size).toBe(work.length)
  })
})

// ── applyOneEnrichmentResult (via applyEnrichmentResults): the four verdicts ─────

describe('apply: the four verdicts', () => {
  test('applied: new relations are merged and written', async () => {
    dir = newLayer()
    writeTableFixture(dir, dimDoc('dim_shop', 'shop_id'))
    writeTableFixture(dir, dwsDoc('dws_order', [{ name: 'shop_id' }]))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    const item = work.find(w => w.gap.startsWith('dimension_refs'))
    expect(item).toBeDefined()
    const text = JSON.stringify([{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }], derivation: 'llm says so' }])
    const { recorder } = fakeRecorder()
    const res = await core.applyEnrichmentResults([{ work_id: item!.work_id, text }], recorder)
    expect(res.results[0]?.verdict).toBe('applied')
    const raw = readTableRaw(dir, 'dws_order')
    expect(raw.dimension_refs).toEqual([
      { dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }], derivation: 'llm says so', origin: 'llm' },
    ])
  })

  test('unparseable: text with nothing usable writes nothing', async () => {
    dir = newLayer()
    writeTableFixture(dir, dwsDoc('dws_order', [{ name: 'shop_id' }]))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    const item = work.find(w => w.gap.startsWith('alt_labels'))
    const { recorder } = fakeRecorder()
    const res = await core.applyEnrichmentResults([{ work_id: item!.work_id, text: 'not json at all' }], recorder)
    expect(res.results[0]?.verdict).toBe('unparseable')
    expect(readTableRaw(dir, 'dws_order').alt_labels).toEqual([])
  })

  test('idempotent: an answer that resolves to only the asset\'s own name adds nothing', async () => {
    dir = newLayer()
    writeTableFixture(dir, dwsDoc('dws_order', [{ name: 'shop_id' }], { pref_label: '订单宽表' }))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    const item = work.find(w => w.gap.startsWith('alt_labels'))
    expect(item).toBeDefined()
    // The "model" suggests exactly the table's own name and its pref_label — both
    // excluded (mirrors discoverAltLabelsFor's own exclusion set), so nothing is new.
    const { recorder } = fakeRecorder()
    const res = await core.applyEnrichmentResults([{ work_id: item!.work_id, text: '["dws_order", "订单宽表"]' }], recorder)
    expect(res.results[0]?.verdict).toBe('idempotent')
    expect(readTableRaw(dir, 'dws_order').alt_labels).toEqual([])
  })

  test('alt_labels round: a genuinely new label applies', async () => {
    dir = newLayer()
    writeTableFixture(dir, dwsDoc('dws_order', [{ name: 'shop_id' }]))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    const item = work.find(w => w.gap.startsWith('alt_labels'))
    const { recorder } = fakeRecorder()
    const res = await core.applyEnrichmentResults([{ work_id: item!.work_id, text: '["订单宽表", "pay order"]' }], recorder)
    expect(res.results[0]?.verdict).toBe('applied')
    expect(readTableRaw(dir, 'dws_order').alt_labels).toEqual(['订单宽表', 'pay order'])
  })

  test('event targets: relation and alt_labels rounds behave the same as tables', async () => {
    dir = newLayer()
    writeTableFixture(dir, dimDoc('dim_shop', 'shop_id'))
    writeEventFixture(dir, eventDoc('pay_success', { shop_id: { type: 'string', description: '店铺ID' } }))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    const relationItem = work.find(w => w.target === 'pay_success' && w.gap.startsWith('external_refs'))
    const { recorder } = fakeRecorder()
    const text = JSON.stringify([{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }], derivation: 'x' }])
    const res = await core.applyEnrichmentResults([{ work_id: relationItem!.work_id, text }], recorder)
    expect(res.results[0]?.verdict).toBe('applied')
  })
})

// ── applyEnrichmentResultsBatch: batch semantics ─────────────────────────

describe('apply: batch semantics', () => {
  test('one stale item does not poison the batch — the other still applies', async () => {
    dir = newLayer()
    writeTableFixture(dir, dwsDoc('dws_a', [{ name: 'x' }]))
    writeTableFixture(dir, dwsDoc('dws_b', [{ name: 'x' }]))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    const itemA = work.find(w => w.target === 'dws_a' && w.gap.startsWith('alt_labels'))
    const itemB = work.find(w => w.target === 'dws_b' && w.gap.startsWith('alt_labels'))
    expect(itemA).toBeDefined()
    expect(itemB).toBeDefined()

    // dws_a changes underneath the batch before apply runs.
    writeTableFixture(dir, dwsDoc('dws_a', [{ name: 'x' }], { description: 'changed' }))

    const { recorder, batchRecordCalls, batchEnded } = fakeRecorder()
    const res = await core.applyEnrichmentResults(
      [{ work_id: itemA!.work_id, text: '["alias-a"]' }, { work_id: itemB!.work_id, text: '["alias-b"]' }],
      recorder,
    )
    const byTarget = Object.fromEntries(res.results.map(r => [r.target, r]))
    expect(byTarget.dws_a?.verdict).toBe('stale_baseline')
    expect(byTarget.dws_b?.verdict).toBe('applied')
    expect(readTableRaw(dir, 'dws_a').alt_labels).toEqual([]) // rejected: untouched
    expect(readTableRaw(dir, 'dws_b').alt_labels).toEqual(['alias-b']) // landed
    // One round (alt_labels) was actually applied, so the batch records exactly once.
    expect(batchRecordCalls).toHaveLength(1)
    expect(batchEnded).toHaveLength(1)
  })

  test('a fully idempotent/stale/unparseable batch calls record() zero times', async () => {
    dir = newLayer()
    writeTableFixture(dir, dwsDoc('dws_a', [{ name: 'x' }], { pref_label: 'A表' }))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    const item = work.find(w => w.target === 'dws_a' && w.gap.startsWith('alt_labels'))
    const { recorder, batchRecordCalls } = fakeRecorder()
    const res = await core.applyEnrichmentResults(
      [
        { work_id: item!.work_id, text: '["A表"]' }, // idempotent (own pref_label)
        { work_id: 'garbage', text: 'anything' }, // stale_baseline (undecodable)
        { work_id: item!.work_id, text: 'not json' }, // unparseable
      ],
      recorder,
    )
    expect(res.results.map(r => r.verdict)).toEqual(['idempotent', 'stale_baseline', 'unparseable'])
    expect(batchRecordCalls).toHaveLength(0)
  })

  test('rounds recorded = distinct applied round kinds, not item count', async () => {
    dir = newLayer()
    writeTableFixture(dir, dimDoc('dim_shop', 'shop_id'))
    writeTableFixture(dir, dwsDoc('dws_a', [{ name: 'shop_id' }]))
    writeTableFixture(dir, dwsDoc('dws_b', [{ name: 'shop_id' }]))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    const relA = work.find(w => w.target === 'dws_a' && w.gap.startsWith('dimension_refs'))!
    const relB = work.find(w => w.target === 'dws_b' && w.gap.startsWith('dimension_refs'))!
    const altA = work.find(w => w.target === 'dws_a' && w.gap.startsWith('alt_labels'))!
    const relText = JSON.stringify([{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }], derivation: 'x' }])
    const { recorder, batchRecordCalls } = fakeRecorder()
    const res = await core.applyEnrichmentResults(
      [
        { work_id: relA.work_id, text: relText },
        { work_id: relB.work_id, text: relText },
        { work_id: altA.work_id, text: '["别名"]' },
      ],
      recorder,
    )
    expect(res.results.every(r => r.verdict === 'applied')).toBe(true)
    // Two distinct round kinds applied (relation + alt_labels) -> two record() calls,
    // despite three items having applied.
    expect(batchRecordCalls).toHaveLength(2)
    expect(new Set(batchRecordCalls.map(c => (c.payload as { round: string }).round))).toEqual(new Set(['relation', 'alt_labels']))
  })

  test('falls back to one recordTier2Write when the recorder has no beginBatch', async () => {
    dir = newLayer()
    writeTableFixture(dir, dwsDoc('dws_a', [{ name: 'x' }]))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    const item = work.find(w => w.target === 'dws_a' && w.gap.startsWith('alt_labels'))!
    const directWrites: Array<{ tool: string; payload: unknown }> = []
    const minimalRecorder: Tier2Recorder = {
      async recordTier2Write(tool, payload) {
        directWrites.push({ tool, payload })
        return 'sha'
      },
      // no beginBatch — the optional slot (ADR-0004 ruling 3) is genuinely absent here.
    }
    const res = await core.applyEnrichmentResults([{ work_id: item.work_id, text: '["新别名"]' }], minimalRecorder)
    expect(res.results[0]?.verdict).toBe('applied')
    expect(directWrites).toHaveLength(1)
    expect(directWrites[0]?.tool).toBe('apply_enrichment')
  })
})

// ── ADR-0007: dimension-filter door (unknown names, empty arrays) ────────────────

describe('dimension-filter door (ADR-0007)', () => {
  test('an unknown table name is rejected before any scan, listing every unknown name', async () => {
    dir = newLayer()
    writeTableFixture(dir, dwsDoc('dws_a', [{ name: 'x' }]))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    await expect(core.listEnrichmentWork({ tables: ['dws_a', 'typo_1', 'typo_2'] }))
      .rejects.toThrowError(/typo_1, typo_2/)
    // The rejection names the unknowns, never the corpus's full name list.
    const err = await core.listEnrichmentWork({ tables: ['typo_1'] }).catch(e => e) as { message: string; unknownTables: string[] }
    expect(err.message).not.toContain('dws_a')
    expect(err.unknownTables).toEqual(['typo_1'])
  })

  test('an unknown event name is rejected the same way, and both dimensions report together', async () => {
    dir = newLayer()
    writeTableFixture(dir, dwsDoc('dws_a', [{ name: 'x' }]))
    writeEventFixture(dir, eventDoc('pay_success', { shop_id: { type: 'string', description: '' } }))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const err = await core.listEnrichmentWork({ tables: ['nope_t'], events: ['nope_e1', 'nope_e2'] }).catch(
      e => e,
    ) as { message: string; unknownTables: string[]; unknownEvents: string[] }
    expect(err.message).toContain('nope_t')
    expect(err.message).toContain('nope_e1, nope_e2')
    expect(err.unknownTables).toEqual(['nope_t'])
    expect(err.unknownEvents).toEqual(['nope_e1', 'nope_e2'])
  })

  test('an empty array is rejected — omitting the key is the only "dimension not in this call"', async () => {
    dir = newLayer()
    writeTableFixture(dir, dwsDoc('dws_a', [{ name: 'x' }]))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    await expect(core.listEnrichmentWork({ tables: [] })).rejects.toThrowError(/empty dimension filter/)
    await expect(core.listEnrichmentWork({ events: [] })).rejects.toThrowError(/empty dimension filter/)
    // The discovery methods carry the same door.
    await expect(core.discoverRelations({ tables: [] })).rejects.toThrowError(/empty dimension filter/)
    await expect(core.discoverEventRelations({ events: ['nope'] })).rejects.toThrowError(/nope/)
    await expect(core.discoverAltLabels({ tables: ['nope'] })).rejects.toThrowError(/nope/)
    // Nothing was written by any rejected call.
    expect(readTableRaw(dir, 'dws_a').alt_labels).toEqual([])
  })
})

// ── ADR-0007: discoverAltLabels call-wide pair reading ───────────────────────────

describe('discoverAltLabels: call-wide legs (ADR-0007)', () => {
  test('tables named -> only the tables leg runs; events keep their empty alt_labels', async () => {
    dir = newLayer()
    // Descriptions crafted so the deterministic round finds exactly one label each.
    writeTableFixture(dir, dwsDoc('dws_a', [{ name: 'x' }], { description: '宽表（A表）' }))
    writeEventFixture(dir, eventDoc('pay_success', { shop_id: { type: 'string', description: '' } }, { description: '支付（支付成功）' }))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const res = await core.discoverAltLabels({ tables: ['dws_a'] })
    expect(res.enriched).toBe(1)
    expect(readTableRaw(dir, 'dws_a').alt_labels).toEqual(['A表'])
    // The events leg never ran — pay_success is untouched on disk.
    const evRaw = yaml.load(readFileSync(join(dir, 'events', 'biz', 'pay_success.yaml'), 'utf-8')) as Record<string, unknown>
    expect(evRaw.alt_labels).toEqual([])
  })

  test('events named -> the mirror; {} -> both legs', async () => {
    dir = newLayer()
    writeTableFixture(dir, dwsDoc('dws_a', [{ name: 'x' }], { description: '宽表（A表）' }))
    writeEventFixture(dir, eventDoc('pay_success', { shop_id: { type: 'string', description: '' } }, { description: '支付（支付成功）' }))
    const core = new SemanticGroundingCore({ semanticRoot: dir })

    const evOnly = await core.discoverAltLabels({ events: ['pay_success'] })
    expect(evOnly.enriched).toBe(1)
    expect(readTableRaw(dir, 'dws_a').alt_labels).toEqual([])

    const full = await core.discoverAltLabels({})
    expect(full.enriched).toBe(1) // dws_a gets its label; pay_success already has its own
    expect(readTableRaw(dir, 'dws_a').alt_labels).toEqual(['A表'])
  })
})

// ── ADR-0008: index shape, cap, and the prompt half ──────────────────────────────

describe('getEnrichmentPrompts (ADR-0008)', () => {
  test('a fresh work_id rebuilds its prompt from the current corpus', async () => {
    dir = newLayer()
    writeTableFixture(dir, dimDoc('dim_shop', 'shop_id'))
    writeTableFixture(dir, dwsDoc('dws_order', [{ name: 'shop_id' }]))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    const relationItem = work.find(w => w.target === 'dws_order' && w.gap.startsWith('dimension_refs'))!
    const prompts = await core.getEnrichmentPrompts([relationItem.work_id])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ work_id: relationItem.work_id, target: 'dws_order', round: 'relation', verdict: 'fresh' })
    expect(prompts[0]?.prompt).toContain('dws_order')
    expect(prompts[0]?.prompt).toContain('dim_shop')
  })

  test('an event alt_labels work_id gets its own prompt shape', async () => {
    dir = newLayer()
    writeEventFixture(dir, eventDoc('pay_success', { shop_id: { type: 'string', description: '店铺ID' } }))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    const item = work.find(w => w.target === 'pay_success' && w.gap.startsWith('alt_labels'))!
    const prompts = await core.getEnrichmentPrompts([item.work_id])
    expect(prompts[0]?.verdict).toBe('fresh')
    expect(prompts[0]?.prompt).toContain('pay_success')
  })

  test('stale is reported at fetch time under the same conditions apply checks', async () => {
    dir = newLayer()
    writeTableFixture(dir, dwsDoc('dws_a', [{ name: 'x' }]))
    writeTableFixture(dir, dwsDoc('dws_b', [{ name: 'x' }]))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    const itemA = work.find(w => w.target === 'dws_a' && w.gap.startsWith('alt_labels'))!
    const itemB = work.find(w => w.target === 'dws_b' && w.gap.startsWith('alt_labels'))!

    // dws_a changes underneath (target-changed staleness) and dws_b is deleted
    // (target-gone staleness) between listing and prompt fetch.
    writeTableFixture(dir, dwsDoc('dws_a', [{ name: 'x' }], { description: 'edited after listing' }))
    rmSync(join(dir, 'tables', 'dws_b.yaml'))

    const prompts = await core.getEnrichmentPrompts([itemA.work_id, itemB.work_id, 'garbage'])
    expect(prompts[0]).toMatchObject({ target: 'dws_a', verdict: 'stale_baseline' })
    expect(prompts[0]?.prompt).toBeUndefined()
    expect(prompts[1]).toMatchObject({ target: 'dws_b', verdict: 'stale_baseline' })
    expect(prompts[2]).toMatchObject({ target: '(unknown)', verdict: 'stale_baseline' })
  })

  test('a gap filled since listing stays fresh — managed fields are not in the fingerprint', async () => {
    dir = newLayer()
    writeTableFixture(dir, dimDoc('dim_shop', 'shop_id'))
    writeTableFixture(dir, dwsDoc('dws_order', [{ name: 'shop_id' }]))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const { work } = await core.listEnrichmentWork()
    const relationItem = work.find(w => w.target === 'dws_order' && w.gap.startsWith('dimension_refs'))!
    // The deterministic round fills the gap after listing: dimension_refs moves, but
    // the fingerprint (which strips the managed fields) does not — the question still
    // stands, and apply's merge is additive.
    await core.discoverRelations({ tables: ['dws_order'] })
    const prompts = await core.getEnrichmentPrompts([relationItem.work_id])
    expect(prompts[0]?.verdict).toBe('fresh')
  })
})

describe('work index cap (ADR-0008)', () => {
  test('the index caps at 1000 rows and reports total/truncated honestly', async () => {
    dir = newLayer()
    // 601 tables + 601 events -> 1202 rows total (each definition carries exactly one
    // gap here: alt_labels; no DIM inventory, so no relation gaps).
    for (let i = 0; i < 601; i++) writeTableFixture(dir, dwsDoc(`dws_bulk_${String(i).padStart(4, '0')}`, [{ name: 'x' }]))
    for (let i = 0; i < 601; i++) writeEventFixture(dir, eventDoc(`evt_bulk_${String(i).padStart(4, '0')}`, {}))
    const core = new SemanticGroundingCore({ semanticRoot: dir })
    const idx = await core.listEnrichmentWork({})
    expect(idx.total).toBe(1202)
    expect(idx.truncated).toBe(true)
    expect(idx.work).toHaveLength(1000)
    // Catalog order: the cap keeps the FIRST 1000 rows — all 601 tables plus the
    // first 399 events (directory-sorted), never a re-ordered or sampled subset.
    expect(idx.work[0]?.target).toBe('dws_bulk_0000')
    expect(idx.work.filter(w => w.target.startsWith('dws_'))).toHaveLength(601)
    expect(idx.work[999]?.target.startsWith('evt_')).toBe(true)
    // Under the cap: no truncation, total === rows.
    const small = await core.listEnrichmentWork({ events: ['evt_bulk_0000'] })
    expect(small).toMatchObject({ total: 1, truncated: false })
    expect(small.work).toHaveLength(1)
  })
})

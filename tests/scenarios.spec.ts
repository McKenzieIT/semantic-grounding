/**
 * P6b semantic-layer — the 4 P6 prototype scenarios ported to vitest + a
 * P13b-swap-reachability test. Proves: zod mirrors RBI pydantic (parse +
 * round-trip + canonicalize + DIM superRefine), ODPS-decoupled sync (stand-in
 * provider -> generate/merge YAML, analyst role preserved), write-tiers
 * (Tier-1 suggest->pending->approve; Tier-2 via a ctx.audit recorder), and
 * BasicIndex (lookup + ADR-0011 invalidate rebuild). The swap test shows the
 * substrate provides the EventDefinition.params_fields / TableDefinition.partitions
 * contract P13b makeCriticCtx consumes (the SemanticGroundingCore exposes these
 * via ctx.schema.load_*).
 *
 * Run: `pnpm vitest run packages/data/semantic-layer`
 */
import { test, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import {
  EventDefinitionSchema,
  TableDefinitionSchema,
  canonicalizeType,
  type TableMeta,
} from '../src/types.ts'
import {
  loadEventDefinition,
  loadTableDefinition,
  writeTable,
  writeEventYaml,
  updateTableMeta,
  syncWriteDefinitions,
  mergeChangedYaml,
  type Tier2Recorder,
} from '../src/io.ts'
import { BasicIndex } from '../src/basic-index.ts'
import { submit, load as loadPending, listing, discard, isValidId } from '../src/pending.ts'
import { StandInSchemaProvider } from '../src/index.ts'
import { makeCriticCtx } from '../src/vendor/nl2sql-types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

// Self-contained semantic-layer scope dir copied from fixtures + a scratch var/.
const SCRATCH = mkdtempSync(join(tmpdir(), 'p6b-semantic-'))
const LAYER = join(SCRATCH, '10000demo')
const VAR_PENDING = join(SCRATCH, 'var', 'pending_semantic')

function readFix(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}
function readLayerFile(rel: string): string {
  return readFileSync(join(LAYER, rel), 'utf8')
}
function resetLayer(): void {
  rmSync(LAYER, { recursive: true, force: true })
  mkdirSync(join(LAYER, 'tables'), { recursive: true })
  mkdirSync(join(LAYER, 'events', 'role_public'), { recursive: true })
  copyFileSync(join(FIXTURES, 'role_online.yaml'), join(LAYER, 'events', 'role_public', 'role.online.yaml'))
  copyFileSync(join(FIXTURES, 'dws_pay_order_di.yaml'), join(LAYER, 'tables', 'dws_pay_order_di.yaml'))
  copyFileSync(join(FIXTURES, 'dim_charm_info.yaml'), join(LAYER, 'tables', 'dim_charm_info.yaml'))
  writeFileSync(join(LAYER, 'config.yaml'), yaml.dump({ project: { name: 'game_demo', scope_id: '10000demo' } }), 'utf8')
  writeFileSync(join(LAYER, 'domains.yaml'), yaml.dump({ domains: ['付费经济', '装备道具'] }), 'utf8')
}
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

// a capturing ctx.audit double for Tier-2 (P6b Q4)
function mockRecorder(): { recorder: Tier2Recorder; calls: string[] } {
  const calls: string[] = []
  const recorder: Tier2Recorder = {
    recordTier2Write(toolName: string): string {
      calls.push(toolName)
      return 'log-id'
    },
  }
  return { recorder, calls }
}

test('S1 data-model fidelity — zod parse + round-trip + canonicalize + DIM superRefine', () => {
  const ev = EventDefinitionSchema.safeParse(yaml.load(readFix('role_online.yaml')))
  const dws = TableDefinitionSchema.safeParse(yaml.load(readFix('dws_pay_order_di.yaml')))
  const dim = TableDefinitionSchema.safeParse(yaml.load(readFix('dim_charm_info.yaml')))
  expect(ev.success).toBe(true)
  expect(dws.success).toBe(true)
  expect(dim.success).toBe(true)
  // canonicalize_type: bigint/int -> int; double -> decimal; string stays; parametrized preserved
  expect(canonicalizeType('bigint')).toBe('int')
  expect(canonicalizeType('int')).toBe('int')
  expect(canonicalizeType('double')).toBe('decimal')
  expect(canonicalizeType('string')).toBe('string')
  expect(canonicalizeType('array<int>')).toBe('array<int>')
  // round-trip: parse -> dump -> reparse -> deep-equal (zod mirrors pydantic model_validate)
  if (ev.success) {
    const dumped = yaml.dump(ev.data, { sortKeys: false, lineWidth: -1, noRefs: true })
    const reparsed = EventDefinitionSchema.parse(yaml.load(dumped))
    expect(ev.data).toEqual(reparsed)
  }
  if (dim.success) {
    const dumped = yaml.dump(dim.data, { sortKeys: false, lineWidth: -1, noRefs: true })
    const reparsed = TableDefinitionSchema.parse(yaml.load(dumped))
    expect(dim.data).toEqual(reparsed)
  }
  // malformed DIM (empty primary_key + label_columns) -> .superRefine rejects
  if (dim.success) {
    const malformed = { ...dim.data, primary_key: [], label_columns: [] }
    const bad = TableDefinitionSchema.safeParse(malformed)
    expect(bad.success).toBe(false)
  }
})

test('S2 ODPS-decoupled sync — stand-in provider -> TableMeta -> generate/merge YAML', async () => {
  resetLayer()
  const { recorder } = mockRecorder()
  const dwsMeta: TableMeta = {
    table_name: 'dws_new_pay_di',
    comment: '新付费日表',
    partitions: [{ name: 'ds', type: 'string' }],
    columns: [
      { name: 'order_id', type: 'string', comment: '订单号' },
      { name: 'pay_amt', type: 'double', comment: '金额' },
      { name: 'ds', type: 'string', comment: '分区' },
    ],
  }
  const dimMeta: TableMeta = {
    table_name: 'dim_new_item',
    comment: '新道具维表',
    partitions: [],
    columns: [
      { name: 'item_id', type: 'string', comment: '道具id' },
      { name: 'item_name', type: 'string', comment: '道具名' },
    ],
  }
  const provider = new StandInSchemaProvider({ dws_new_pay_di: dwsMeta, dim_new_item: dimMeta })
  const discovered = await provider.discover('10000demo')
  expect(discovered.length).toBe(2)
  // sync-write new DWS + DIM (DIM via dimTableNames)
  const r1 = await syncWriteDefinitions(LAYER, [dwsMeta], { recorder, scope_id: '10000demo' })
  expect(r1.written).toBe(1)
  const r2 = await syncWriteDefinitions(LAYER, [dimMeta], { recorder, scope_id: '10000demo', dimTableNames: new Set(['dim_new_item']) })
  expect(r2.written).toBe(1)
  // generate_dim_yaml inferred pk=[item_id] (first _id) + label_columns=[item_name]
  const written = loadTableDefinition(LAYER, 'dim_new_item')
  expect(written?.kind).toBe('dim')
  expect(written?.primary_key).toEqual(['item_id'])
  expect(written?.label_columns).toEqual(['item_name'])
  // merge_changed_yaml preserves analyst role corrections (pay_amt -> attribute kept)
  const existing = yaml.load(readLayerFile('tables/dws_new_pay_di.yaml')) as Record<string, unknown>
  const cols = existing.columns as Array<{ name: string; role?: string }>
  const payCol = cols.find(c => c.name === 'pay_amt')
  if (payCol !== undefined) payCol.role = 'attribute'
  const merged = mergeChangedYaml(existing, {
    ...dwsMeta,
    comment: '变更:新增列+类型改',
    columns: [...dwsMeta.columns, { name: 'coupon_amt', type: 'double', comment: '优惠券' }],
  })
  const mergedCols = merged.columns as Array<{ name: string; role?: string }>
  const mergedPay = mergedCols.find(c => c.name === 'pay_amt')
  expect(mergedPay?.role).toBe('attribute')
  const mergedCoupon = mergedCols.find(c => c.name === 'coupon_amt')
  expect(mergedCoupon?.role).toBe('measure')
})

test('S3 write-tiers — Tier-1 suggest->pending->approve; Tier-2 via ctx.audit recorder', async () => {
  resetLayer()
  const idx = new BasicIndex(LAYER)
  // Tier-1: suggest does NOT touch source-of-truth (the fixture event is already present)
  const content = yaml.dump({
    name: 'role.online', event_filter: "event = 'role.online'", description: 'suggest',
    params_fields: { roleId: { type: 'int', description: '角色id' } },
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
  }, { sortKeys: false, lineWidth: -1 })
  const rec = submit(VAR_PENDING, { kind: 'event_yaml', subject: 'role.online', content, scope_id: '10000demo' })
  expect(isValidId(rec.suggestion_id)).toBe(true)
  // approve consumes the queue: writeEventYaml + discard
  const loaded = loadPending(VAR_PENDING, rec.suggestion_id)
  expect(loaded).not.toBeNull()
  const res = await writeEventYaml(LAYER, 'role.online', loaded?.content ?? '')
  expect(res.ok).toBe(true)
  expect(discard(VAR_PENDING, rec.suggestion_id)).toBe(true)
  expect(listing(VAR_PENDING).length).toBe(0)
  expect(idx.lookupEvent('role.online')).not.toBeNull()
  // Tier-2: update_table_meta via ctx.audit recorder (D5 non-disableable)
  const { recorder, calls } = mockRecorder()
  const r = await updateTableMeta(LAYER, 'dws_pay_order_di', { granularity: '日增量，每行一笔' }, { recorder, scope_id: '10000demo' })
  expect(r.ok).toBe(true)
  expect(calls).toContain('update_table_meta')
})

test('S4 BasicIndex — lookup + ADR-0011 invalidate -> rebuild after write', async () => {
  resetLayer()
  const idx = new BasicIndex(LAYER)
  expect(idx.tableCount()).toBe(2) // dws_pay_order_di + dim_charm_info
  expect(idx.lookupTable('dws_pay_order_di')).not.toBeNull()
  expect(idx.tableCountByKind('dim')).toBe(1)
  // a NEW write -> invalidate fires -> next lookup rebuilds
  await writeTable(LAYER, 'dws_login_di', {
    table_name: 'dws_login_di', kind: 'dws',
    columns: [{ name: 'role_id', type: 'string', role: 'dimension' }],
    confirmation: { status: 'draft' },
  }, { skipValidation: true })
  expect(idx.tableCount()).toBe(3) // rebuilt from disk
  expect(idx.lookupTable('dws_login_di')).not.toBeNull()
})

test('freshness preprocess maps legacy Chinese value', () => {
  const parsed = TableDefinitionSchema.parse({
    table_name: 'dws_test_freshness',
    table_comment: '',
    description: '',
    domains: [],
    granularity: '',
    engine: 'maxcompute',
    columns: [],
    metrics: {},
    partitions: [],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    coverage: null,
    supersedes: [],
    disambiguation: null,
    kind: 'dws',
    primary_key: [],
    primary_key_unique: null,
    duplicate_sample: [],
    label_columns: [],
    freshness: '静态参考',
    alt_labels: [],
    dimension_refs: [],
  })
  expect(parsed.freshness).toBe('static_reference')
})

test('S5 P13b swap reachable — substrate provides params_fields/partitions for makeCriticCtx', () => {
  resetLayer()
  // ctx.schema.load_* wraps these substrate readers; the contract P13b swaps to.
  const ev = loadEventDefinition(LAYER, 'role.online')
  expect(ev).not.toBeNull()
  expect(Object.keys(ev?.params_fields ?? {}).length).toBeGreaterThan(0)
  const table = loadTableDefinition(LAYER, 'dws_pay_order_di')
  expect(table).not.toBeNull()
  const partitionCols = table?.partitions.map(p => p.name) ?? ['ds']
  // P13b makeCriticCtx consumes eventParams (params_fields) + partitionCols (partitions)
  const ctx = makeCriticCtx({
    candidateTables: ['dws_pay_order_di'],
    eventParams: ev?.params_fields ?? {},
    partitionCols,
  })
  expect(ctx.candidateTables.has('dws_pay_order_di')).toBe(true)
  expect(ctx.partitionCols.has('ds')).toBe(true)
  // event params include role_id (canonicalized from bigint -> int)
  expect(ctx.eventParams.has('role_id')).toBe(true)
})

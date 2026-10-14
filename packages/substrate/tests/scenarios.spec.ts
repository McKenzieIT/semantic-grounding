/**
 * P6b semantic-layer — the 3 P6 prototype scenarios ported to vitest + a
 * P13b-swap-reachability test. Proves: zod mirrors RBI pydantic (parse +
 * round-trip + canonicalize + DIM superRefine) and write-tiers
 * (Tier-1 suggest->pending->approve; Tier-2 via a ctx.audit recorder). The
 * swap test shows the substrate provides the EventDefinition.params_fields /
 * TableDefinition.partitions contract P13b makeCriticCtx consumes (the
 * SemanticGroundingCore exposes these via ctx.schema.load_*).
 *
 * Run: `pnpm vitest run packages/substrate`
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
} from '../src/types.ts'
import {
  loadEventDefinition,
  loadTableDefinition,
  writeEventYaml,
  updateTableMeta,
  type Tier2Recorder,
} from '../src/io.ts'
import { submit, load as loadPending, listing, discard, isValidId } from '../src/pending.ts'
import { makeCriticCtx } from '../src/vendor/nl2sql-types.ts'
import { fixtureEvent, fixtureTable } from './enrichment-fixtures.ts'

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
    async recordTier2Write(toolName: string): Promise<string> {
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

test('S3 write-tiers — Tier-1 suggest->pending->approve; Tier-2 via ctx.audit recorder', async () => {
  resetLayer()
  // Tier-1: suggest does NOT touch source-of-truth (the fixture event is already present)
  const content = yaml.dump(fixtureEvent({
    name: 'role.online', event_filter: "event = 'role.online'", description: 'suggest',
    params_fields: { roleId: { type: 'int', description: '角色id' } },
  }), { sortKeys: false, lineWidth: -1 })
  const rec = submit(VAR_PENDING, { kind: 'event_yaml', subject: 'role.online', content, scope_id: '10000demo' })
  expect(isValidId(rec.suggestion_id)).toBe(true)
  // approve consumes the queue: writeEventYaml + discard
  const loaded = loadPending(VAR_PENDING, rec.suggestion_id)
  expect(loaded).not.toBeNull()
  const res = await writeEventYaml(LAYER, 'role.online', loaded?.content ?? '')
  expect(res.ok).toBe(true)
  expect(discard(VAR_PENDING, rec.suggestion_id)).toBe(true)
  expect(listing(VAR_PENDING).length).toBe(0)
  // Tier-2: update_table_meta via ctx.audit recorder (D5 non-disableable)
  const { recorder, calls } = mockRecorder()
  const r = await updateTableMeta(LAYER, 'dws_pay_order_di', { granularity: '日增量，每行一笔' }, { recorder, scope_id: '10000demo' })
  expect(r.ok).toBe(true)
  expect(calls).toContain('update_table_meta')
})

test('freshness preprocess maps legacy Chinese value', () => {
  // The raw 静态参考 spelling is the schema INPUT (the preprocess maps it) —
  // overlaid outside `fixtureTable`'s typed parameter for exactly that reason.
  const parsed = TableDefinitionSchema.parse({
    ...fixtureTable({ table_name: 'dws_test_freshness' }),
    freshness: '静态参考',
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

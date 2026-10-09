/**
 * P2-impl registry unit tests — DataSourceRegistry + kind plugins.
 * G1/G2 aligned: schema field, toCorpusItem (reads alt_labels from def),
 * raw-based getId, CriticFields with Record, three relation types, MetricPlugin.
 */
import { test, expect } from 'vitest'
import yaml from 'js-yaml'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventDefinitionSchema, TableDefinitionSchema, MetricDefinitionSchema } from '../src/types.ts'
import { DataSourceRegistry } from '../src/registry.ts'
import { eventKindPlugin } from '../src/kinds/event-kind.ts'
import { tableKindPlugin } from '../src/kinds/table-kind.ts'
import { projectMetricCorpusItem, deriveMetricRelations } from '../src/metrics.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

function loadFixture<T>(name: string, schema: { parse: (v: unknown) => T }): T {
  const raw = yaml.load(readFileSync(join(FIXTURES, name), 'utf8'))
  return schema.parse(raw)
}

const EVENT_DEF = loadFixture('role_online.yaml', EventDefinitionSchema)
const DWS_DEF = loadFixture('dws_pay_order_di.yaml', TableDefinitionSchema)

// ── DataSourceRegistry ──────────────────────────────────────────────────

test('registry — register + getKind + allKinds', () => {
  const reg = new DataSourceRegistry()
  reg.register(eventKindPlugin)
  reg.register(tableKindPlugin)
  expect(reg.getKind('event')).toBe(eventKindPlugin)
  expect(reg.getKind('table')).toBe(tableKindPlugin)
  expect(reg.getKind('unknown')).toBeUndefined()
  expect(reg.allKinds().sort()).toEqual(['event', 'table'])
})

test('registry — duplicate kind throws', () => {
  const reg = new DataSourceRegistry()
  reg.register(eventKindPlugin)
  expect(() =>{  reg.register(eventKindPlugin) }).toThrow('already registered')
})

test('disposing a kind contribution removes only that registration and permits reload', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const ctx = new Context()
  const reg = new DataSourceRegistry()
  let disposeContribution: () => void = () => {}
  const contributor = (scope: InstanceType<typeof Context>) => {
    scope.effect(() => {
      disposeContribution = reg.register(eventKindPlugin)
      return disposeContribution
    })
  }
  try {
    const fiber = ctx.plugin(contributor)
    await fiber
    expect(reg.getKind('event')).toBe(eventKindPlugin)
    const oldDisposer = disposeContribution
    await fiber.dispose()
    expect(reg.allKinds()).toEqual([])
    const reloaded = ctx.plugin(contributor)
    await reloaded
    oldDisposer()
    oldDisposer()
    expect(reg.getKind('event')).toBe(eventKindPlugin)
    await reloaded.dispose()
    expect(reg.allPlugins()).toEqual([])
  } finally {
    await ctx.fiber.dispose()
  }
})

// ── eventKindPlugin — G1 aligned ────────────────────────────────────────

test('eventKindPlugin — schema field is EventDefinitionSchema', () => {
  expect(eventKindPlugin.schema).toBe(EventDefinitionSchema)
})

test('eventKindPlugin — getId from raw Record', () => {
  expect(eventKindPlugin.getId({ name: 'role.online' })).toBe('role.online')
  expect(eventKindPlugin.getId({ table_name: 'foo' })).toBeUndefined()
  expect(eventKindPlugin.getId({})).toBeUndefined()
})

test('eventKindPlugin — toCorpusItem enriches with params + alt_labels from definition', () => {
  const defWithAliases = { ...EVENT_DEF, alt_labels: ['上线', '登录'] }
  const item = eventKindPlugin.toCorpusItem(defWithAliases)
  expect(item).not.toBeNull()
  expect(item!.id).toBe('role.online')
  expect(item!.description).toContain('玩家上线')
  expect(item!.description).toContain('role_id')
  expect(item!.description).toContain('角色id')
  expect(item!.description).toContain('上线')
  expect(item!.description).toContain('登录')
})

test('eventKindPlugin — toCorpusItem works without alt_labels (no aliases injected)', () => {
  const item = eventKindPlugin.toCorpusItem(EVENT_DEF)
  expect(item!.id).toBe('role.online')
  expect(item!.description).toContain('role_id')
  expect(item!.description).not.toContain('登录')
})

test('eventKindPlugin — toPromptContext formats params table', () => {
  const ctx = eventKindPlugin.toPromptContext(EVENT_DEF)
  expect(ctx).toContain('Event: role.online')
  expect(ctx).toContain('| role_id |')
  expect(ctx).toContain('| level |')
  expect(ctx).toContain('int')
})

test('eventKindPlugin — toCriticContext returns full Record (G1 §D2)', () => {
  const ctx = eventKindPlugin.toCriticContext!(EVENT_DEF)
  expect(ctx.eventParams).toBeDefined()
  expect(Object.keys(ctx.eventParams!)).toContain('role_id')
  expect(Object.keys(ctx.eventParams!)).toContain('level')
  // Preserves the full ParamField object, not just keys
  expect((ctx.eventParams as Record<string, { type: string }>).role_id!.type).toBe('int')
})

test('eventKindPlugin — relations returns empty for no external_refs', () => {
  const rels = eventKindPlugin.relations(EVENT_DEF)
  expect(rels).toEqual([])
})

test('eventKindPlugin — relations maps external_refs with G2 types', () => {
  const defWithRefs = {
    ...EVENT_DEF,
    external_refs: [{
      dim_table: 'dim_charm_info',
      join_keys: [{ dws_column: 'charm_id', dim_column: 'charm_id' }],
      derivation: 'via charm',
    }],
  }
  const rels = eventKindPlugin.relations(defWithRefs)
  expect(rels).toHaveLength(1)
  expect(rels[0]).toBeDefined()
  expect(rels[0]!.type).toBe('joins')
  expect(rels[0]!.target).toBe('dim_charm_info')
  expect(rels[0]!.on).toBe('charm_id = charm_id')
  expect(rels[0]!.description).toBe('via charm')
})

// ── tableKindPlugin — G1 aligned ────────────────────────────────────────

test('tableKindPlugin — schema field is TableDefinitionSchema', () => {
  expect(tableKindPlugin.schema).toBe(TableDefinitionSchema)
})

test('tableKindPlugin — getId from raw Record', () => {
  expect(tableKindPlugin.getId({ table_name: 'dws_pay_order_di' })).toBe('dws_pay_order_di')
  expect(tableKindPlugin.getId({ name: 'foo' })).toBeUndefined()
  expect(tableKindPlugin.getId({})).toBeUndefined()
})

test('tableKindPlugin — toCorpusItem indexes name + comment + columns (A3)', () => {
  const item = tableKindPlugin.toCorpusItem(DWS_DEF)
  expect(item).not.toBeNull()
  expect(item!.id).toBe('dws_pay_order_di')
  expect(item!.description).toContain('dws_pay_order_di')
})

test('tableKindPlugin — toPromptContext formats columns table', () => {
  const ctx = tableKindPlugin.toPromptContext(DWS_DEF)
  expect(ctx).toContain('Table: dws_pay_order_di')
  expect(ctx).toContain('Kind: dws')
  expect(ctx).toContain('Engine: maxcompute')
  expect(ctx).toContain('| order_id |')
  expect(ctx).toContain('Partitions:')
  expect(ctx).toContain('ds')
})

test('tableKindPlugin — toCriticContext returns partitionCols (G1 §D3)', () => {
  const ctx = tableKindPlugin.toCriticContext!(DWS_DEF)
  expect(ctx.partitionCols).toEqual(['ds'])
})

test('tableKindPlugin — relations maps dimension_refs with G2 type', () => {
  const defWithRefs = {
    ...DWS_DEF,
    dimension_refs: [{
      dim_table: 'dim_charm_info',
      join_keys: [{ dws_column: 'charm_id', dim_column: 'charm_id' }],
      derivation: '',
    }],
  }
  const rels = tableKindPlugin.relations(defWithRefs)
  expect(rels).toHaveLength(1)
  expect(rels[0]).toBeDefined()
  expect(rels[0]!.type).toBe('joins')
  expect(rels[0]!.target).toBe('dim_charm_info')
  expect(rels[0]!.on).toBe('charm_id = charm_id')
})

// ── metric projection (M1: virtual kind:metric) ────────────────────────

const METRIC_DEF = MetricDefinitionSchema.parse({
  name: 'DAU',
  description: '日活跃用户数',
  domains: ['用户'],
  computation: {
    sql: "SELECT COUNT(DISTINCT user_id) FROM ods_login WHERE ds = '{{date}}'",
    metadata: { aggregation: 'count_distinct', field: 'user_id', source: 'ods_login', time_grain: 'daily' },
  },
  relations: [
    { type: 'derived_from', target: 'ods_login', description: '基于登录事件的用户去重' },
  ],
})

test('MetricDefinitionSchema — parses metric definition', () => {
  expect(METRIC_DEF.name).toBe('DAU')
  expect(METRIC_DEF.computation.sql).toContain('COUNT(DISTINCT')
})

test('projectMetricCorpusItem — produces retrievable item', () => {
  const item = projectMetricCorpusItem(METRIC_DEF)
  expect(item).not.toBeNull()
  expect(item.id).toBe('DAU')
  expect(item.description).toContain('日活跃用户数')
  expect(item.description).toContain('count_distinct')
})

test('deriveMetricRelations — returns derived_from (G2 type)', () => {
  const rels = deriveMetricRelations(METRIC_DEF)
  expect(rels).toHaveLength(1)
  expect(rels[0]).toBeDefined()
  expect(rels[0]!.type).toBe('derived_from')
  expect(rels[0]!.target).toBe('ods_login')
})

/**
 * P2-impl registry unit tests — DataSourceRegistry + kind plugins.
 * G1/G2 aligned: schema field, toCorpusItem (reads alt_labels from def),
 * raw-based getId, three relation types. Metric projection (M1 virtual
 * kind:metric) lives in metrics-derivation.spec / metrics.spec.
 */
import { test, expect } from 'vitest'
import yaml from 'js-yaml'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventDefinitionSchema, TableDefinitionSchema } from '../src/types.ts'
import { DataSourceRegistry } from '../src/registry.ts'
import { eventKindPlugin } from '../src/kinds/event-kind.ts'
import { tableKindPlugin } from '../src/kinds/table-kind.ts'

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

test('disposing a kind registration removes only that registration and permits re-register', () => {
  const reg = new DataSourceRegistry()
  const disposer = reg.register(eventKindPlugin)
  expect(reg.getKind('event')).toBe(eventKindPlugin)
  // The old disposer withdraws only its own registration and is idempotent.
  disposer()
  expect(reg.allKinds()).toEqual([])
  // Re-registering the same kind after disposal succeeds (reload permitted).
  const reDisposer = reg.register(eventKindPlugin)
  disposer() // re-calling the old disposer must not touch the new registration
  expect(reg.getKind('event')).toBe(eventKindPlugin)
  reDisposer()
  expect(reg.allPlugins()).toEqual([])
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
  expect(item!.id).toBe('event:role.online')
  expect(item!.description).toContain('玩家上线')
  expect(item!.description).toContain('role_id')
  expect(item!.description).toContain('角色id')
  expect(item!.description).toContain('上线')
  expect(item!.description).toContain('登录')
})

test('eventKindPlugin — toCorpusItem works without alt_labels (no aliases injected)', () => {
  const item = eventKindPlugin.toCorpusItem(EVENT_DEF)
  expect(item!.id).toBe('event:role.online')
  expect(item!.description).toContain('role_id')
  expect(item!.description).not.toContain('登录')
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
  expect(rels[0]!.target).toBe('table:dim_charm_info')
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
  expect(item!.id).toBe('table:dws_pay_order_di')
  expect(item!.description).toContain('dws_pay_order_di')
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
  expect(rels[0]!.target).toBe('table:dim_charm_info')
  expect(rels[0]!.on).toBe('charm_id = charm_id')
})

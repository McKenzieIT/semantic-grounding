/**
 * P4-impl critic-fields tests — validates registry-aggregated CriticFields path.
 * G1 aligned: CriticFields.eventParams is Record<string, unknown> (full params_fields).
 */
import { test, expect, afterAll, describe } from 'vitest'
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { loadEventDefinition, loadTableDefinition } from '../src/io.ts'
import { DataSourceRegistry, type CriticFields } from '../src/registry.ts'
import { eventKindPlugin } from '../src/kinds/event-kind.ts'
import { tableKindPlugin } from '../src/kinds/table-kind.ts'
import { makeCriticCtx } from '../src/vendor/nl2sql-types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const SCRATCH = mkdtempSync(join(tmpdir(), 'p4-critic-'))
const LAYER = join(SCRATCH, 'layer')

function resetLayer(): void {
  rmSync(LAYER, { recursive: true, force: true })
  mkdirSync(join(LAYER, 'tables'), { recursive: true })
  mkdirSync(join(LAYER, 'events', 'role_public'), { recursive: true })
  copyFileSync(join(FIXTURES, 'role_online.yaml'), join(LAYER, 'events', 'role_public', 'role.online.yaml'))
  copyFileSync(join(FIXTURES, 'dws_pay_order_di.yaml'), join(LAYER, 'tables', 'dws_pay_order_di.yaml'))
  copyFileSync(join(FIXTURES, 'dim_charm_info.yaml'), join(LAYER, 'tables', 'dim_charm_info.yaml'))
  writeFileSync(join(LAYER, 'config.yaml'), yaml.dump({ project: { name: 'test', scope_id: 'test' } }), 'utf8')
}
afterAll(() => { rmSync(SCRATCH, { recursive: true, force: true }) })

/** Replicate SemanticGroundingCore.buildCriticFields logic (no Cordis ctx needed). */
function buildCriticFields(semanticLayer: string, definitionNames: string[]): CriticFields {
  const registry = new DataSourceRegistry()
  registry.register(eventKindPlugin)
  registry.register(tableKindPlugin)
  const eventParams: Record<string, unknown> = {}
  const partitionCols: string[] = []
  for (const name of definitionNames) {
    const evDef = loadEventDefinition(semanticLayer, name)
    if (evDef) {
      const plugin = registry.getKind('event')
      if (plugin?.toCriticContext) {
        const ctx = plugin.toCriticContext(evDef)
        if (ctx.eventParams) Object.assign(eventParams, ctx.eventParams)
        if (ctx.partitionCols) partitionCols.push(...ctx.partitionCols)
      }
      continue
    }
    const tblDef = loadTableDefinition(semanticLayer, name)
    if (tblDef) {
      const plugin = registry.getKind('table')
      if (plugin?.toCriticContext) {
        const ctx = plugin.toCriticContext(tblDef)
        if (ctx.eventParams) Object.assign(eventParams, ctx.eventParams)
        if (ctx.partitionCols) partitionCols.push(...ctx.partitionCols)
      }
    }
  }
  return {
    ...(Object.keys(eventParams).length > 0 ? { eventParams } : {}),
    ...(partitionCols.length > 0 ? { partitionCols } : {}),
  }
}

describe('buildCriticFields — registry-aggregated critic context (G1 aligned)', () => {
  resetLayer()

  test('event-only returns eventParams as Record (G1 §D2)', () => {
    const fields = buildCriticFields(LAYER, ['role.online'])
    expect(fields.eventParams).toBeDefined()
    expect(Object.keys(fields.eventParams!)).toContain('role_id')
    expect(Object.keys(fields.eventParams!)).toContain('level')
    expect(Object.keys(fields.eventParams!)).toContain('server_id')
    expect(Object.keys(fields.eventParams!)).toContain('amount')
    // Full Record preserves type info (G1: eventParams is Record<string, unknown>)
    expect((fields.eventParams as Record<string, { type: string }>).role_id!.type).toBe('int')
    expect(fields.partitionCols).toBeUndefined()
  })

  test('table-only returns partitionCols', () => {
    const fields = buildCriticFields(LAYER, ['dws_pay_order_di'])
    expect(fields.partitionCols).toEqual(['ds'])
    expect(fields.eventParams).toBeUndefined()
  })

  test('DIM table with no partitions returns empty', () => {
    const fields = buildCriticFields(LAYER, ['dim_charm_info'])
    expect(fields.eventParams).toBeUndefined()
    expect(fields.partitionCols).toBeUndefined()
  })

  test('mixed event + table aggregates both axes', () => {
    const fields = buildCriticFields(LAYER, ['role.online', 'dws_pay_order_di'])
    expect(Object.keys(fields.eventParams!)).toContain('role_id')
    expect(fields.partitionCols).toEqual(['ds'])
  })

  test('unknown names are skipped gracefully', () => {
    const fields = buildCriticFields(LAYER, ['nonexistent'])
    expect(fields.eventParams).toBeUndefined()
    expect(fields.partitionCols).toBeUndefined()
  })

  test('empty input returns empty', () => {
    const fields = buildCriticFields(LAYER, [])
    expect(fields.eventParams).toBeUndefined()
    expect(fields.partitionCols).toBeUndefined()
  })
})

describe('buildCriticFields + makeCriticCtx compatibility', () => {
  resetLayer()

  test('event params feed into makeCriticCtx correctly', () => {
    const fields = buildCriticFields(LAYER, ['role.online'])
    const ctx = makeCriticCtx({
      candidateTables: ['dws_pay_order_di'],
      eventParams: fields.eventParams as Record<string, unknown>,
      partitionCols: fields.partitionCols ?? ['ds'],
    })
    expect(ctx.eventParams.has('role_id')).toBe(true)
    expect(ctx.eventParams.has('level')).toBe(true)
    expect(ctx.eventParams.has('amount')).toBe(true)
    expect(ctx.partitionCols.has('ds')).toBe(true)
  })

  test('table partition cols feed into makeCriticCtx correctly', () => {
    const fields = buildCriticFields(LAYER, ['dws_pay_order_di'])
    const ctx = makeCriticCtx({
      candidateTables: ['dws_pay_order_di'],
      eventParams: fields.eventParams ?? {},
      partitionCols: fields.partitionCols ?? ['ds'],
    })
    expect(ctx.partitionCols.has('ds')).toBe(true)
    expect(ctx.candidateTables.has('dws_pay_order_di')).toBe(true)
  })

  test('mixed aggregation produces valid CriticCtx', () => {
    const fields = buildCriticFields(LAYER, ['role.online', 'dws_pay_order_di'])
    const ctx = makeCriticCtx({
      candidateTables: ['dws_pay_order_di'],
      eventParams: fields.eventParams ?? {},
      partitionCols: fields.partitionCols ?? ['ds'],
    })
    expect(ctx.eventParams.has('role_id')).toBe(true)
    expect(ctx.partitionCols.has('ds')).toBe(true)
  })

  test('equivalence with S5 direct-access pattern', () => {
    const ev = loadEventDefinition(LAYER, 'role.online')!
    const table = loadTableDefinition(LAYER, 'dws_pay_order_di')!
    // Direct access (old path)
    const directCtx = makeCriticCtx({
      candidateTables: ['dws_pay_order_di'],
      eventParams: ev.params_fields,
      partitionCols: table.partitions.map(p => p.name),
    })
    // Registry-aggregated path (new)
    const fields = buildCriticFields(LAYER, ['role.online', 'dws_pay_order_di'])
    const registryCtx = makeCriticCtx({
      candidateTables: ['dws_pay_order_di'],
      eventParams: fields.eventParams ?? {},
      partitionCols: fields.partitionCols ?? ['ds'],
    })
    // Sets should be identical
    expect(registryCtx.eventParams).toEqual(directCtx.eventParams)
    expect(registryCtx.partitionCols).toEqual(directCtx.partitionCols)
    expect(registryCtx.candidateTables).toEqual(directCtx.candidateTables)
  })
})

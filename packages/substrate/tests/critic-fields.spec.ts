/**
 * makeCriticCtx compatibility tests — event params_fields and table partition
 * cols read directly off loaded definitions feed the critic context the same
 * way the S5 direct-access pattern always did.
 */
import { test, expect, afterAll, describe } from 'vitest'
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { loadEventDefinition, loadTableDefinition } from '../src/io.ts'
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

describe('makeCriticCtx compatibility — direct definition access', () => {
  resetLayer()

  test('event params feed into makeCriticCtx correctly', () => {
    const ctx = makeCriticCtx({
      candidateTables: ['dws_pay_order_di'],
      eventParams: loadEventDefinition(LAYER, 'role.online')!.params_fields,
      partitionCols: ['ds'],
    })
    expect(ctx.eventParams.has('role_id')).toBe(true)
    expect(ctx.eventParams.has('level')).toBe(true)
    expect(ctx.eventParams.has('amount')).toBe(true)
    expect(ctx.partitionCols.has('ds')).toBe(true)
  })

  test('table partition cols feed into makeCriticCtx correctly', () => {
    const ctx = makeCriticCtx({
      candidateTables: ['dws_pay_order_di'],
      eventParams: {},
      partitionCols: loadTableDefinition(LAYER, 'dws_pay_order_di')!.partitions.map(p => p.name),
    })
    expect(ctx.partitionCols.has('ds')).toBe(true)
    expect(ctx.candidateTables.has('dws_pay_order_di')).toBe(true)
  })

  test('mixed event + table inputs produce valid CriticCtx', () => {
    const ctx = makeCriticCtx({
      candidateTables: ['dws_pay_order_di'],
      eventParams: loadEventDefinition(LAYER, 'role.online')!.params_fields,
      partitionCols: loadTableDefinition(LAYER, 'dws_pay_order_di')!.partitions.map(p => p.name),
    })
    expect(ctx.eventParams.has('role_id')).toBe(true)
    expect(ctx.partitionCols.has('ds')).toBe(true)
  })
})

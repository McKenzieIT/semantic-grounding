/**
 * Metrics extraction (B5) tests — mechanical derivation of inline `metrics:`
 * blocks into MetricDefinitions (M1 virtual projection, no standalone YAMLs).
 * G3 §6 Phase 1 = deterministic.
 */
import { test, expect, describe, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  extractMetricsFromTable,
  extractMetricsFromTables,
  metricName,
  splitMetricName,
  inferAggregation,
} from '../src/metrics.ts'
import { MetricDefinitionSchema } from '../src/types.ts'
import { dumpYaml } from '../src/io.ts'
import type { TableDefinition, MetricDef } from '../src/types.ts'

function table(over: Partial<TableDefinition> = {}): TableDefinition {
  return {
    table_name: 'dws_pay_order_di',
    table_comment: 'pay orders',
    description: 'dws pay',
    domains: ['付费经济'],
    granularity: '',
    engine: 'maxcompute',
    columns: [{ name: 'order_id', type: 'string', comment: '', role: 'dimension' }],
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
    freshness: '',
    dimension_refs: [],
    ...over,
  } as TableDefinition
}

const mdef = (e: string, d = '', cv: MetricDef['caliber_variants'] = []): MetricDef => ({
  expression: e,
  description: d,
  alt_labels: [],
  caliber_variants: cv,
})

describe('metricName', () => {
  test('namespaces as <source>__<key>', () => {
    expect(metricName('dws_pay_order_di', 'pay_amt_sum')).toBe('dws_pay_order_di__pay_amt_sum')
  })
})

describe('splitMetricName', () => {
  test('splits <host>__<key> into host + key', () => {
    expect(splitMetricName('dws_order__total_amount')).toEqual({ host: 'dws_order', key: 'total_amount' })
  })
  test('splits on the LAST __ (host may itself contain __)', () => {
    expect(splitMetricName('a__b__c')).toEqual({ host: 'a__b', key: 'c' })
  })
  test('returns null when no __ separator', () => {
    expect(splitMetricName('nosep')).toBeNull()
  })
  test('returns null when __ is at the start (sep <= 0)', () => {
    expect(splitMetricName('__key')).toBeNull()
  })
})

describe('inferAggregation', () => {
  test('SUM(pay_amt) -> sum / pay_amt', () => {
    expect(inferAggregation('SUM(pay_amt)')).toEqual({ aggregation: 'sum', field: 'pay_amt' })
  })
  test('COUNT(*) -> count / *', () => {
    expect(inferAggregation('COUNT(*)')).toEqual({ aggregation: 'count', field: '*' })
  })
  test('COUNT(DISTINCT user_id) -> count_distinct / user_id', () => {
    expect(inferAggregation('COUNT(DISTINCT user_id)')).toEqual({ aggregation: 'count_distinct', field: 'user_id' })
  })
  test('lowercase + AVG/MIN/MAX', () => {
    expect(inferAggregation('avg(pay_amt)')).toEqual({ aggregation: 'avg', field: 'pay_amt' })
    expect(inferAggregation('min(ds)')).toEqual({ aggregation: 'min', field: 'ds' })
  })
  test('non-aggregate expression -> empty strings', () => {
    expect(inferAggregation('pay_amt / act_uv')).toEqual({ aggregation: '', field: '' })
  })
})

describe('extractMetricsFromTable', () => {
  test('one MetricDefinition per metrics entry', () => {
    const t = table({ metrics: { pay_amt_sum: mdef('SUM(pay_amt)', '总付费金额'), order_cnt: mdef('COUNT(*)', '订单数') } })
    const metrics = extractMetricsFromTable(t)
    expect(metrics).toHaveLength(2)
    expect(metrics.map(m => m.name).sort()).toEqual(['dws_pay_order_di__order_cnt', 'dws_pay_order_di__pay_amt_sum'])
  })

  test('maps expression -> computation.sql, source -> metadata.source', () => {
    const t = table({ metrics: { pay_amt_sum: mdef('SUM(pay_amt)', '总付费金额') } })
    const m = extractMetricsFromTable(t)[0]!
    expect(m.computation.sql).toBe('SUM(pay_amt)')
    expect(m.computation.metadata.source).toBe('dws_pay_order_di')
    expect(m.computation.metadata.aggregation).toBe('sum')
    expect(m.computation.metadata.field).toBe('pay_amt')
    expect(m.description).toBe('总付费金额')
    expect(m.domains).toEqual(['付费经济'])
    expect(m.kind).toBe('metric')
  })

  test('auto-establishes a derived_from relation to the source table', () => {
    const t = table({ metrics: { pay_amt_sum: mdef('SUM(pay_amt)') } })
    const m = extractMetricsFromTable(t)[0]!
    expect(m.relations).toHaveLength(1)
    expect(m.relations[0]!).toMatchObject({ type: 'derived_from', target: 'dws_pay_order_di' })
    expect(m.relations[0]!.description).toContain('dws_pay_order_di')
  })

  test('every emitted metric validates against MetricDefinitionSchema', () => {
    const t = table({ metrics: { a: mdef('SUM(x)'), b: mdef('COUNT(DISTINCT y)'), c: mdef('x/y') } })
    for (const m of extractMetricsFromTable(t)) {
      const r = MetricDefinitionSchema.safeParse(m)
      expect(r.success).toBe(true)
    }
  })

  test('table with no metrics -> empty array', () => {
    expect(extractMetricsFromTable(table())).toEqual([])
  })

  test('works for DIM tables too (e.g. row_count)', () => {
    const dim = table({ table_name: 'dim_charm_info', kind: 'dim', primary_key: ['charm_id'], label_columns: ['charm_name'], metrics: { row_count: mdef('COUNT(*)', '行数') } })
    const m = extractMetricsFromTable(dim)[0]!
    expect(m.name).toBe('dim_charm_info__row_count')
    expect(m.relations[0]!).toMatchObject({ type: 'derived_from', target: 'dim_charm_info' })
  })
})

// ── I/O: extractMetricsFromTables ───────────────────────────────────────

describe('metrics I/O', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'k11-metrics-'))
    writeFileSync(join(dir, 'config.yaml'), 'project:\n  name: t\n  scope_id: t\n')
    mkdirSync(join(dir, 'tables'), { recursive: true })
  })
  afterEach(() =>{  rmSync(dir, { recursive: true, force: true }) })

  test('extractMetricsFromTables reads tables/ and extracts inline metrics', () => {
    const t = table({ metrics: { pay_amt_sum: mdef('SUM(pay_amt)', '总付费金额') } })
    writeFileSync(join(dir, 'tables', 'dws_pay_order_di.yaml'), dumpYaml(t))
    const metrics = extractMetricsFromTables(dir)
    expect(metrics).toHaveLength(1)
    expect(metrics[0]!.name).toBe('dws_pay_order_di__pay_amt_sum')
  })
})

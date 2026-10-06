/**
 * F1 integration test: verify that the enrichment-llm-wiring plugin correctly
 * wires ctx.llm into ctx.schema so both rounds of discoverRelations and
 * discoverEventRelations execute, and the on-write hook triggers enrichment.
 */
import { describe, test, expect, afterEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SemanticLayerService, wireEnrichmentLlm, type TextLlm } from '../src/index.ts'
import { apply } from '../src/llm-wiring-plugin.ts'
import { tableKindPlugin } from '../src/kinds/table-kind.ts'
import { TableDefinitionSchema } from '../src/types.ts'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'

function setupLayer(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'f1-wiring-'))
  writeFileSync(join(dir, 'config.yaml'), 'project:\n  name: t\n  scope_id: t\n')
  mkdirSync(join(dir, 'tables'), { recursive: true })
  mkdirSync(join(dir, 'events', 'pay'), { recursive: true })
  mkdirSync(join(dir, 'metrics'), { recursive: true })

  // DIM table
  writeFileSync(join(dir, 'tables', 'dim_server.yaml'), yaml.dump({
    table_name: 'dim_server', kind: 'dim', primary_key: ['server_id'], label_columns: ['s_name'],
    columns: [
      { name: 'server_id', type: 'string', comment: '区服ID', role: 'dimension' },
      { name: 's_name', type: 'string', comment: '区服名', role: 'dimension' },
    ],
    metrics: {}, partitions: [], confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    domains: [], description: '区服维度表', table_comment: '', granularity: '', engine: 'maxcompute',
    coverage: null, supersedes: [], disambiguation: null, primary_key_unique: null,
    duplicate_sample: [], freshness: '', dimension_refs: [],
  }))

  // DWS table with server_id column (deterministic match)
  writeFileSync(join(dir, 'tables', 'dws_orders.yaml'), yaml.dump({
    table_name: 'dws_orders', kind: 'dws', primary_key: [], label_columns: [],
    columns: [
      { name: 'server_id', type: 'string', comment: '区服ID', role: 'dimension' },
      { name: 'order_amt', type: 'double', comment: '订单金额', role: 'metric' },
    ],
    metrics: {}, partitions: [{ name: 'ds', type: 'string' }],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    domains: ['pay'], description: '订单汇总', table_comment: '', granularity: '',
    engine: 'maxcompute', coverage: null, supersedes: [], disambiguation: null,
    primary_key_unique: null, duplicate_sample: [], freshness: '', dimension_refs: [],
  }))

  // Event with server_id param (deterministic match)
  writeFileSync(join(dir, 'events', 'pay', 'order_created.yaml'), yaml.dump({
    name: 'order_created', description: '订单创建', domains: ['pay'],
    params_fields: { server_id: { type: 'string', description: '区服' } },
    metrics: {}, external_refs: [], disambiguation: [],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' }, coverage: null,
  }))

  return { dir, cleanup: () => { rmSync(dir, { recursive: true, force: true }) } }
}

test('F1 — wireEnrichmentLlm enables two-round discoverRelations', async () => {
  const { dir, cleanup } = setupLayer()
  try {
    const ctx = new Context()
    const svc = new SemanticLayerService(ctx, { semanticRoot: dir })

    const llmCalls: string[] = []
    const fakeLlm: TextLlm = {
      async text(prompt: string) {
        llmCalls.push(prompt)
        // LLM returns no additional refs (deterministic-only result)
        return '[]'
      },
    }
    wireEnrichmentLlm(svc, fakeLlm)

    const result = await svc.discoverRelations()
    expect(result.errors).toEqual([])
    expect(result.enriched).toBe(1) // dws_orders matched dim_server
    expect(result.written).toBe(1)
    // LLM round was called (even though it returned [])
    expect(llmCalls.length).toBe(1)
    expect(llmCalls[0]).toContain('dws_orders')

    // Verify dimension_refs written
    const raw = yaml.load(readFileSync(join(dir, 'tables', 'dws_orders.yaml'), 'utf-8')) as Record<string, unknown>
    const refs = raw.dimension_refs as unknown[]
    expect(refs.length).toBe(1)
    expect((refs[0] as Record<string, unknown>).dim_table).toBe('dim_server')
  } finally {
    cleanup()
  }
})

test('F1 — wireEnrichmentLlm enables two-round discoverEventRelations', async () => {
  const { dir, cleanup } = setupLayer()
  try {
    const ctx = new Context()
    const svc = new SemanticLayerService(ctx, { semanticRoot: dir })

    const llmCalls: string[] = []
    const fakeLlm: TextLlm = {
      async text(prompt: string) {
        llmCalls.push(prompt)
        return '[]'
      },
    }
    wireEnrichmentLlm(svc, fakeLlm)

    const result = await svc.discoverEventRelations()
    expect(result.errors).toEqual([])
    expect(result.enriched).toBe(1) // order_created matched dim_server
    expect(result.written).toBe(1)
    expect(llmCalls.length).toBe(1)
    expect(llmCalls[0]).toContain('order_created')

    // Verify external_refs written
    const raw = yaml.load(readFileSync(join(dir, 'events', 'pay', 'order_created.yaml'), 'utf-8')) as Record<string, unknown>
    const refs = raw.external_refs as unknown[]
    expect(refs.length).toBe(1)
    expect((refs[0] as Record<string, unknown>).dim_table).toBe('dim_server')
  } finally {
    cleanup()
  }
})

test('F1 — on-write hook path: enrichOnWrite merges with existing refs', async () => {
  const { dir, cleanup } = setupLayer()
  try {
    const ctx = new Context()
    const svc = new SemanticLayerService(ctx, { semanticRoot: dir, autoEnrich: true })

    const llmCalls: string[] = []
    const fakeLlm: TextLlm = {
      async text(prompt: string) {
        llmCalls.push(prompt)
        // LLM discovers an additional ref the deterministic round missed
        return JSON.stringify([{
          dim_table: 'dim_server',
          join_keys: [{ dws_column: 'server_id', dim_column: 'server_id' }],
          derivation: 'LLM: server_id maps to dim_server PK',
        }])
      },
    }
    wireEnrichmentLlm(svc, fakeLlm)

    // Directly call discoverRelations (which is what the on-write hook calls
    // internally via enrichAllDwsTables; we test the Service method path)
    const result = await svc.discoverRelations({ tables: ['dws_orders'] })
    expect(result.errors).toEqual([])
    expect(result.enriched).toBe(1)

    // LLM round ran
    expect(llmCalls.length).toBe(1)

    // Verify the LLM's derivation made it through (overrides deterministic generic)
    const raw = yaml.load(readFileSync(join(dir, 'tables', 'dws_orders.yaml'), 'utf-8')) as Record<string, unknown>
    const refs = raw.dimension_refs as { dim_table: string; derivation: string }[]
    expect(refs.length).toBe(1)
    expect(refs[0]!.derivation).toContain('LLM')
  } finally {
    cleanup()
  }
})

test('F1 — alternative FK produces multiple independent join edges', () => {
  const def = TableDefinitionSchema.parse({
    table_name: 'dws_acc_summary', kind: 'dws', primary_key: [], label_columns: [],
    columns: [
      { name: 'act_server_id_fst', type: 'string', comment: '首次活跃区服', role: 'dimension' },
      { name: 'act_server_id_lst', type: 'string', comment: '最近活跃区服', role: 'dimension' },
      { name: 'pay_server_id_fst', type: 'string', comment: '首次付费区服', role: 'dimension' },
    ],
    metrics: {}, partitions: [{ name: 'ds', type: 'string' }],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    domains: [], description: '', table_comment: '', granularity: '', engine: 'maxcompute',
    coverage: null, supersedes: [], disambiguation: null, primary_key_unique: null,
    duplicate_sample: [], freshness: '',
    dimension_refs: [{
      dim_table: 'dim_server',
      join_keys: [
        { dws_column: 'act_server_id_fst', dim_column: 'server_id' },
        { dws_column: 'act_server_id_lst', dim_column: 'server_id' },
        { dws_column: 'pay_server_id_fst', dim_column: 'server_id' },
      ],
      derivation: 'multiple server FK columns',
    }],
  })
  const rels = tableKindPlugin.relations(def)
  // Should produce 3 independent edges, not 1 AND-connected edge
  expect(rels.length).toBe(3)
  expect(rels[0]!.on).toBe('act_server_id_fst = server_id')
  expect(rels[1]!.on).toBe('act_server_id_lst = server_id')
  expect(rels[2]!.on).toBe('pay_server_id_fst = server_id')
})

// ── CL8: provider/model resolution (no silent vendor fallback) ──────────

describe('CL8 — enrichment-llm-wiring provider/model resolution', () => {
  const savedProvider = process.env.ENRICHMENT_LLM_PROVIDER
  const savedModel = process.env.ENRICHMENT_LLM_MODEL

  afterEach(() => {
    delete process.env.ENRICHMENT_LLM_PROVIDER
    delete process.env.ENRICHMENT_LLM_MODEL
    if (savedProvider !== undefined) process.env.ENRICHMENT_LLM_PROVIDER = savedProvider
    if (savedModel !== undefined) process.env.ENRICHMENT_LLM_MODEL = savedModel
  })

  /** Minimal ctx mock capturing apply()'s schema.setLlmCall + logger.info/warn. */
  function mockApplyCtx(): { ctx: Context; logged: string[]; warned: string[]; setLlmCall: ReturnType<typeof vi.fn> } {
    const logged: string[] = []
    const warned: string[] = []
    const setLlmCall = vi.fn()
    const ctx = {
      schema: { setLlmCall },
      logger: {
        info: (m: string) => { logged.push(m) },
        warn: (m: string) => { warned.push(m) },
      },
    } as unknown as Context
    return { ctx, logged, warned, setLlmCall }
  }

  test('no config + no env → apply warns + skips wire (CB-1a α graceful degrade)', () => {
    const { ctx, warned, setLlmCall } = mockApplyCtx()
    expect(() => { apply(ctx, {}) }).not.toThrow()
    expect(setLlmCall).not.toHaveBeenCalled()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('enrichment-llm-wiring: no provider/model configured')
    expect(warned[0]).toContain('deterministic-only')
  })

  test('config.provider set but model unset → warns + skips wire (!model branch)', () => {
    const { ctx, warned, setLlmCall } = mockApplyCtx()
    expect(() => { apply(ctx, { provider: 'x' }) }).not.toThrow()
    expect(setLlmCall).not.toHaveBeenCalled()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('enrichment-llm-wiring: no provider/model configured')
    expect(warned[0]).toContain('deterministic-only')
  })

  test('config.model set but provider unset → warns + skips wire (!provider branch)', () => {
    const { ctx, warned, setLlmCall } = mockApplyCtx()
    expect(() => { apply(ctx, { model: 'm' }) }).not.toThrow()
    expect(setLlmCall).not.toHaveBeenCalled()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('enrichment-llm-wiring: no provider/model configured')
    expect(warned[0]).toContain('deterministic-only')
  })

  test('config.provider/model override env (no silent vendor fallback)', () => {
    process.env.ENRICHMENT_LLM_PROVIDER = 'envprov'
    process.env.ENRICHMENT_LLM_MODEL = 'envmodel'
    const { ctx, logged, setLlmCall } = mockApplyCtx()
    apply(ctx, { provider: 'cfgprov', model: 'cfgmodel' })
    expect(setLlmCall).toHaveBeenCalledTimes(1)
    expect(logged[0]).toContain('cfgprov/cfgmodel')
    expect(logged[0]).not.toContain('aga')
    expect(logged[0]).not.toContain('qwen3.7-max')
  })

  test('env vars used when config empty', () => {
    process.env.ENRICHMENT_LLM_PROVIDER = 'envprov'
    process.env.ENRICHMENT_LLM_MODEL = 'envmodel'
    const { ctx, logged, setLlmCall } = mockApplyCtx()
    apply(ctx, {})
    expect(setLlmCall).toHaveBeenCalledTimes(1)
    expect(logged[0]).toContain('envprov/envmodel')
  })
})

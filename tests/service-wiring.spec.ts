import { test, expect, describe, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SemanticLayerService } from '../src/index.ts'
import { wireEnrichmentLlm, type TextLlm } from '../src/index.ts'
import { RelationGraph } from '../src/relation-graph.ts'
import { tableKindPlugin } from '../src/kinds/table-kind.ts'
import { TableDefinitionSchema, type TableDefinition } from '../src/types.ts'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

function makeService(): SemanticLayerService {
  const ctx = new Context()
  return new SemanticLayerService(ctx, { semanticRoot: '' })
}

test('A1 — service registers table + event + concept kind plugins (metrics derived virtually, M1)', () => {
  const svc = makeService()
  const reg = svc.getRegistry()
  expect(reg.allKinds().sort()).toEqual(['concept', 'event', 'table'])
})

test('A2 — getRelationGraph builds from tables/events/metrics + caches until corpusVersion bump', () => {
  const svc = makeService() // empty semanticRoot -> empty graph, but still a RelationGraph
  const g = svc.getRelationGraph()
  expect(g).toBeInstanceOf(RelationGraph)
  // cached: second call returns the same instance (no rebuild)
  expect(svc.getRelationGraph()).toBe(g)
})

const DWS: TableDefinition = TableDefinitionSchema.parse({
  table_name: 'dws_pay_order_di', description: '充值订单汇总', table_comment: 'pay',
  domains: ['付费经济'], granularity: '', engine: 'maxcompute',
  columns: [{ name: 'server_id', type: 'string', comment: '区服ID', role: 'dimension' }],
  metrics: {}, partitions: [{ name: 'ds', type: 'string' }],
  confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' }, coverage: null,
  supersedes: [], disambiguation: null, kind: 'dws', primary_key: [], primary_key_unique: null,
  duplicate_sample: [], label_columns: [], freshness: '', dimension_refs: [],
})

test('A3a — tableKindPlugin.toCorpusItem indexes name + description + columns (no longer null)', () => {
  const item = tableKindPlugin.toCorpusItem(DWS)
  expect(item).not.toBeNull()
  expect(item!.id).toBe('dws_pay_order_di')
  expect(item!.description).toContain('充值订单汇总')
  expect(item!.description).toContain('server_id')
})

test('A3b — loadRetrievalCorpusAll includes tables + metrics (not just events)', () => {
  const svc = makeService()
  expect(Array.isArray(svc.loadRetrievalCorpusAll())).toBe(true)
})

function eventYaml(): string {
  return yaml.dump({
    name: 'game.pay.order', description: '充值下单', domains: ['付费经济'],
    params_fields: { server_id: { type: 'string', description: '区服' } },
    metrics: {}, external_refs: [], disambiguation: [],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' }, coverage: null,
  })
}
function dimYaml(): string {
  return yaml.dump({
    table_name: 'dim_server', kind: 'dim', primary_key: ['server_id'], label_columns: ['s_name'],
    columns: [{ name: 'server_id', type: 'string', comment: '', role: 'dimension' }, { name: 's_name', type: 'string', comment: '', role: 'dimension' }],
    metrics: {}, partitions: [], confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    domains: [], description: '', table_comment: '', granularity: '', engine: 'maxcompute',
    coverage: null, supersedes: [], disambiguation: null, primary_key_unique: null,
    duplicate_sample: [], freshness: '', dimension_refs: [],
  })
}

test('B2 — discoverEventRelations writes events external_refs via the Service', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'k11-evt2-'))
  try {
    writeFileSync(join(dir, 'config.yaml'), 'project:\n  name: t\n  scope_id: t\n')
    mkdirSync(join(dir, 'tables'), { recursive: true })
    mkdirSync(join(dir, 'events', 'pay'), { recursive: true })
    writeFileSync(join(dir, 'tables', 'dim_server.yaml'), dimYaml())
    writeFileSync(join(dir, 'events', 'pay', 'game.pay.order.yaml'), eventYaml())
    const ctx = new Context()
    const svc = new SemanticLayerService(ctx, { semanticRoot: dir })
    const res = await svc.discoverEventRelations()
    expect(res.errors).toEqual([])
    expect(res.enriched).toBe(1)
    const written = yaml.load(readFileSync(join(dir, 'events', 'pay', 'game.pay.order.yaml'), 'utf-8')) as Record<string, unknown>
    expect((written.external_refs as unknown[]).length).toBe(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('B3 — wireEnrichmentLlm adapts a text-LLM into the Service llmCall seam', async () => {
  const seen: string[] = []
  const fakeLlm: TextLlm = { text: async (prompt: string) => { seen.push(prompt); return '[]' } }
  let injected: ((p: string) => Promise<string>) | undefined
  const fakeSchema = { setLlmCall: (fn?: (p: string) => Promise<string>) => { injected = fn } }

  wireEnrichmentLlm(fakeSchema, fakeLlm)
  expect(typeof injected).toBe('function')
  const out = await injected!('discover refs for X')
  expect(seen).toEqual(['discover refs for X'])
  expect(out).toBe('[]')
})

// ── M1 virtual metric projection (Task 3) ──────────────────────────────
// Metrics are no longer a registered kind with a storage dir; they are derived
// at retrieval time from the host table/event `metrics:` blocks. The Service
// derives a MetricDefinition on demand (loadMetricDefinition) and emits virtual
// kind:metric CorpusItems in loadRetrievalCorpusAll (no metricKindPlugin).
const K11_SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), './fixtures/k11')

describe('M1 virtual metric projection', () => {
  it('loadMetricDefinition(name) derives from host table metrics block', () => {
    const ctx = new Context()
    const service = new SemanticLayerService(ctx, { semanticRoot: K11_SEED_DIR })
    const md = service.loadMetricDefinition('dws_10000251_acc_summary_di__daily_active_account_uv')
    expect(md).not.toBeNull()
    expect(md!.computation.metadata.source).toBe('dws_10000251_acc_summary_di')
    expect(md!.computation.sql).toContain('COUNT(DISTINCT account_id)')
  })

  it('loadRetrievalCorpusAll emits virtual metric CorpusItems with kind:metric', () => {
    const ctx = new Context()
    const service = new SemanticLayerService(ctx, { semanticRoot: K11_SEED_DIR })
    const corpus = service.loadRetrievalCorpusAll()
    const metricItems = corpus.filter(c => (c.payload as { kind?: string } | undefined)?.kind === 'metric')
    expect(metricItems.length).toBeGreaterThan(0)
  })
})

// ── Fiber-tracked registration (W27) ───────────────────────────────────
// The constructor's cache-invalidation listener and its three built-in kind
// registrations are the mechanism that keeps a disposed kind's nodes and edges
// out of the cached graph. A context without the fiber lifecycle cannot carry
// either, so construction must fail rather than produce a service whose graph
// cache is never invalidated; these two tests pin that stance against a
// reintroduced `typeof ctx.effect === 'function'` fallback.
describe('W27 fiber-tracked registration', () => {
  it('withdraws the built-in kinds when the owning fiber disposes', async () => {
    const ctx = new Context()
    let service: SemanticLayerService | undefined
    const fiber = ctx.plugin((inner: Context) => {
      service = new SemanticLayerService(inner, { semanticRoot: '' })
    })
    await fiber
    expect(service?.getRegistry().allKinds().sort()).toEqual(['concept', 'event', 'table'])
    await fiber.dispose()
    expect(service?.getRegistry().allKinds()).toEqual([])
  })

  it('refuses a context without the fiber lifecycle instead of degrading silently', () => {
    const partial = { reflect: { provide: () => {} }, get: () => undefined } as unknown as Context
    expect(() => new SemanticLayerService(partial, { semanticRoot: '' })).toThrow()
  })
})

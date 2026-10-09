/**
 * ADR-0005's five read tools — behaviour: `search_definitions`, `get_definition`,
 * `get_join_path`, `get_relations`, `resolve_alias`.
 *
 * @see docs/adr/0005-mcp-tool-surface.md
 */
import { afterEach, describe, expect, it } from 'vitest'
import { rankDefinitions, type SearchCandidate } from '../src/tools/read.ts'
import { buildIntentToolHarness, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
import { toolJson } from './helpers/inprocess-client.ts'

let h: IntentToolHarness | undefined
afterEach(() => h?.close())

describe('rankDefinitions (pure)', () => {
  const candidates: SearchCandidate[] = [
    { id: 'dws_order', kind: 'table', label: 'dws_order', domains: [], description: '订单宽表', altLabels: ['订单宽表'] },
    { id: 'dim_shop', kind: 'table', label: 'dim_shop', domains: [], description: '店铺维表', altLabels: [] },
    { id: 'game.pay.order', kind: 'event', label: 'game.pay.order', domains: [], description: '支付下单事件', altLabels: [] },
  ]

  it('ranks an exact id match first', () => {
    const hits = rankDefinitions('dws_order', candidates, 10)
    expect(hits[0]?.id).toBe('dws_order')
  })

  it('matches a Chinese alias via character-bigram overlap, with no tokenizer', () => {
    const hits = rankDefinitions('订单宽表', candidates, 10)
    expect(hits.map(h2 => h2.id)).toContain('dws_order')
  })

  it('returns nothing for a query with no overlap at all', () => {
    expect(rankDefinitions('zzz_no_match_zzz', candidates, 10)).toEqual([])
  })

  it('respects topK', () => {
    const hits = rankDefinitions('e', candidates, 1)
    expect(hits.length).toBeLessThanOrEqual(1)
  })

  it('never returns a version field — summaries are not a write precondition (ADR-0005 ruling 6)', () => {
    const hits = rankDefinitions('dws_order', candidates, 10)
    expect(hits[0]).not.toHaveProperty('version')
  })
})

describe('search_definitions (wired)', () => {
  it('finds dws_order by a partial query', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('search_definitions', { query: 'order' })
    const body = toolJson(res) as { hits: Array<{ id: string }> }
    expect(body.hits.map(x => x.id)).toContain('dws_order')
  })

  it('restricts to the given kinds', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('search_definitions', { query: 'dws_order', kinds: ['event'] })
    const body = toolJson(res) as { hits: Array<{ id: string }> }
    expect(body.hits.map(x => x.id)).not.toContain('dws_order')
  })

  it('caps results at top_k', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('search_definitions', { query: 'o', top_k: 1 })
    const body = toolJson(res) as { hits: unknown[] }
    expect(body.hits.length).toBeLessThanOrEqual(1)
  })
})

describe('get_definition — ADR-0005 ruling 6', () => {
  it('returns a table definition with its sha256 version fingerprint', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('get_definition', { kind: 'table', name: 'dws_order' })
    const body = toolJson(res) as { kind: string; name: string; definition: { table_name: string }; version: string }
    expect(body.kind).toBe('table')
    expect(body.definition.table_name).toBe('dws_order')
    expect(body.version).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the version round-trips as expected_version on a later update_definition', async () => {
    h = await buildIntentToolHarness()
    const read = toolJson(await h.client.callTool('get_definition', { kind: 'table', name: 'dws_order' })) as { version: string }
    const update = await h.client.callTool('update_definition', {
      kind: 'table',
      name: 'dws_order',
      fields: { description: '订单宽表（更新）' },
      summary: '补充描述',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: read.version,
    })
    const body = toolJson(update) as { changed: boolean }
    expect(body.changed).toBe(true)
  })

  it('errors with definition_not_found (-31021) for an unknown table', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('get_definition', { kind: 'table', name: 'nope' })
    expect(res.result?.['isError']).toBe(true)
    const body = toolJson(res)
    expect(body['code']).toBe(-31021)
    expect(body['name']).toBe('DefinitionNotFoundError')
  })

  it('loads a concept with a version fingerprint', async () => {
    h = await buildIntentToolHarness()
    // The fixture ships no concepts/ dir — create one directly, matching the convention
    // get_definition's fingerprinting relies on (concepts/<name>.yaml).
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { dumpYaml } = await import('@semantic-grounding/substrate')
    mkdirSync(join(h.fixture.root, 'concepts'), { recursive: true })
    writeFileSync(join(h.fixture.root, 'concepts', 'sales.yaml'), dumpYaml({ name: 'sales', description: '销售域' }), 'utf8')
    const res = await h.client.callTool('get_definition', { kind: 'concept', name: 'sales' })
    const body = toolJson(res) as { definition: { name: string }; version: string }
    expect(body.definition.name).toBe('sales')
    expect(body.version).toMatch(/^[0-9a-f]{64}$/)
  })

  it('loads a metric with no version (no backing file to fingerprint)', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('update_definition', {
      kind: 'table',
      name: 'dws_order',
      fields: { metrics: { gmv: { expression: 'sum(pay_amt)', description: '', alt_labels: [], caliber_variants: [] } } },
      summary: '补充指标',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: (toolJson(await h.client.callTool('get_definition', { kind: 'table', name: 'dws_order' })) as { version: string }).version,
    })
    const res = await h.client.callTool('get_definition', { kind: 'metric', name: 'dws_order__gmv' })
    const body = toolJson(res)
    expect(body['definition']).toBeDefined()
    expect(body).not.toHaveProperty('version')
  })
})

describe('get_join_path / get_relations / resolve_alias', () => {
  it('finds the join path from dws_order to dim_shop (the fixture\'s matching shop_id PK)', async () => {
    h = await buildIntentToolHarness({ autoEnrich: true })
    // Drive one write through the autoEnrich-on core so the deterministic relation
    // round populates dimension_refs — get_join_path reads the relation graph, which
    // is built from on-disk dimension_refs, not inferred live.
    await h.client.callTool('update_definition', {
      kind: 'table',
      name: 'dws_order',
      fields: { description: 'trigger enrichment' },
      summary: 'trigger',
      derivation: 'agent',
      confidence: 0.5,
      expected_version: (toolJson(await h.client.callTool('get_definition', { kind: 'table', name: 'dws_order' })) as { version: string }).version,
    })
    const res = await h.client.callTool('get_join_path', { from: 'dws_order', to: 'dim_shop' })
    const body = toolJson(res) as { found: boolean; path: string[] | null }
    expect(body.found).toBe(true)
    expect(body.path).toEqual(['dws_order', 'dim_shop'])
  })

  it('get_join_path reports found:false (not an error) for an unreachable pair', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('get_join_path', { from: 'dws_order', to: 'nonexistent_node' })
    expect(res.result?.['isError']).toBeUndefined()
    const body = toolJson(res) as { found: boolean; path: null }
    expect(body.found).toBe(false)
    expect(body.path).toBeNull()
  })

  it('get_relations lists direct edges, filterable by type', async () => {
    h = await buildIntentToolHarness({ autoEnrich: true })
    await h.client.callTool('update_definition', {
      kind: 'table',
      name: 'dws_order',
      fields: { description: 'trigger' },
      summary: 'trigger',
      derivation: 'agent',
      confidence: 0.5,
      expected_version: (toolJson(await h.client.callTool('get_definition', { kind: 'table', name: 'dws_order' })) as { version: string }).version,
    })
    const res = await h.client.callTool('get_relations', { target: 'dws_order', type: 'joins' })
    const body = toolJson(res) as { relations: Array<{ targetId: string; type: string }> }
    expect(body.relations.some(r => r.targetId === 'dim_shop' && r.type === 'joins')).toBe(true)
  })

  it('get_relations returns an empty list (not an error) for an unrelated node', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('get_relations', { target: 'nonexistent_node' })
    expect(res.result?.['isError']).toBeUndefined()
    const body = toolJson(res) as { relations: unknown[] }
    expect(body.relations).toEqual([])
  })

  it('resolve_alias finds a node by its alt_label', async () => {
    h = await buildIntentToolHarness()
    const current = toolJson(await h.client.callTool('get_definition', { kind: 'table', name: 'dws_order' })) as { version: string }
    await h.client.callTool('add_alias', {
      kind: 'table',
      name: 'dws_order',
      alias: '订单宽表',
      summary: '添加别名',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: current.version,
    })
    const res = await h.client.callTool('resolve_alias', { term: '订单宽表' })
    const body = toolJson(res) as { node_ids: string[] }
    expect(body.node_ids).toContain('dws_order')
  })

  it('resolve_alias returns an empty list (not an error) for an unknown term', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('resolve_alias', { term: 'completely unknown term' })
    expect(res.result?.['isError']).toBeUndefined()
    const body = toolJson(res) as { node_ids: unknown[] }
    expect(body.node_ids).toEqual([])
  })
})

/**
 * The memory read surface over the wire (#154 / ADR-0024 R1–R7 + ADR-0026
 * R2/R3 + ADR-0027 R4): the mounted keys on `get_definition` /
 * `get_join_path` / `get_relations` / `search_definitions`, the `data_window`
 * input, the orphan-annotated `definition_not_found`, and — pinning every one
 * of them — the zero-tax rule: a memory-free corpus keeps all five tools'
 * responses free of the new keys entirely.
 *
 * Runs through the real harness (fixture corpus, real git recorder, real
 * registrars), recording entries through `record_memory` first — the write
 * half's own spec (`intent-tools-memory.spec.ts`) owns that surface.
 *
 * @see docs/adr/0024-memory-read-surface.md
 * @see docs/adr/0026-dangling-memory-anchors.md
 * @see docs/adr/0027-contested-memories.md
 */
import { afterEach, describe, expect, it } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dumpYaml, loadTables } from '@semantic-grounding/substrate'
import { buildIntentToolHarness, tier2, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
import { fixtureGit, fixtureTable } from './helpers/fixture-corpus.ts'
import { toolJson, toolOutcome } from './helpers/inprocess-client.ts'

let h: IntentToolHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

/** Record entries through the real write door; fail-loud on rejection. */
async function record(harness: IntentToolHarness, memories: ReadonlyArray<Record<string, unknown>>): Promise<string[]> {
  const out = toolOutcome(await harness.client.callTool('record_memory', {
    scope_id: 'fixture',
    memories,
    summary: '记录',
    ...tier2('记录', 0.8),
  }))
  if (out.isError) throw new Error(`record_memory rejected: ${JSON.stringify(out.body)}`)
  return (out.body.results as ReadonlyArray<{ id: string }>).map(r => r.id)
}

async function getDefinition(harness: IntentToolHarness, args: Record<string, unknown>) {
  return toolJson(await harness.client.callTool('get_definition', args)) as Record<string, unknown>
}

/** Add the fixture's discoverable join via the item tool (curated origin). */
async function addShopJoin(harness: IntentToolHarness): Promise<void> {
  const version = toolJson(await harness.client.callTool('get_definition', { kind: 'table', name: 'dws_order' })) as { version: string }
  const out = toolOutcome(await harness.client.callTool('add_relation', {
    scope_id: 'fixture', kind: 'table', name: 'dws_order',
    relations: [{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
    summary: '补 join', ...tier2('补 join', 0.9), expected_version: version.version,
  }))
  if (out.isError) throw new Error('add_relation failed')
}

// ── Zero tax: a memory-free corpus keeps every response byte-identical ─────

describe('zero tax — no memory, no new keys', () => {
  it('all five read tools answer with exactly the pre-#154 keys on a memory-free corpus', async () => {
    h = await buildIntentToolHarness({ fixtureOpts: { withEvents: true } })
    // get_definition: {scope, kind, name, definition, version} — nothing else.
    const def = await getDefinition(h, { kind: 'table', name: 'dws_order' })
    expect(Object.keys(def).sort()).toEqual(['definition', 'kind', 'name', 'scope', 'version'])
    // search hits stay the six-field summary rows.
    const search = toolJson(await h.client.callTool('search_definitions', { query: 'order' })) as { hits: ReadonlyArray<Record<string, unknown>> }
    expect(search.hits.length).toBeGreaterThan(0)
    for (const hit of search.hits) {
      expect(Object.keys(hit).sort()).toEqual(['description', 'domains', 'id', 'kind', 'label', 'score'])
    }
    // join_path (even a found path mounts nothing) and relations rows.
    await addShopJoin(h)
    const path = toolJson(await h.client.callTool('get_join_path', { from: 'dws_order', to: 'dim_shop' })) as Record<string, unknown>
    expect(Object.keys(path).sort()).toEqual(['found', 'from', 'path', 'scope', 'to'])
    const rels = toolJson(await h.client.callTool('get_relations', { target: 'dws_order', type: 'joins' })) as { relations: ReadonlyArray<Record<string, unknown>> }
    expect(rels.relations.length).toBeGreaterThan(0)
    for (const row of rels.relations) {
      expect(row).not.toHaveProperty('memories')
      expect(row).not.toHaveProperty('memories_truncated')
    }
    // And the not-found arm stays the plain two-key data payload.
    const miss = toolOutcome(await h.client.callTool('get_definition', { kind: 'table', name: 'nope' }))
    expect(miss.isError).toBe(true)
    expect(miss.body.code).toBe(-31021)
    expect(Object.keys(miss.body.data as Record<string, unknown>).sort()).toEqual(['kind', 'name'])
    expect(miss.body.message).toBe('no table named "nope"')
  })
})

// ── The three seed cards over the wire ─────────────────────────────────────

describe('get_definition / search_definitions — the mounts', () => {
  it('the three seed cards surface where they anchor, and search counts agree with the click-through', async () => {
    h = await buildIntentToolHarness()
    await addShopJoin(h)
    const [e3, a3] = await record(h, [
      { type: 'inference', anchors: ['dws_order#shop_id'], body: '「2渠」即 shop_id。', basis: '列注释' },
      { type: 'practice', anchors: ['table:dws_order'], body: '大R 口径本次取 r_level 07–09。', basis: '本次自选口径', valid_from: '2026-10-16' },
    ])
    const [g3] = await record(h, [
      { type: 'incident', anchors: ['table:dws_order -joins-> table:dim_shop'], body: '上游未产出,当天指标偏低。', valid_from: '2026-10-01', valid_until: '2026-10-01' },
    ])
    const body = await getDefinition(h, { kind: 'table', name: 'dws_order' })
    expect((body.memories as ReadonlyArray<{ id: string; type: string; anchor: string }>).map(r => r.id)).toEqual([a3, e3])
    expect((body.memories as ReadonlyArray<{ anchor: string }>)[1]?.anchor).toBe('table:dws_order#shop_id')
    expect((body.edge_memories as ReadonlyArray<{ id: string; anchor: string }>)[0]).toMatchObject({ id: g3, anchor: 'table:dws_order -joins-> table:dim_shop' })
    // The other end sees the same edge entry (ADR-0024 R1: 边两端都挂).
    const dim = await getDefinition(h, { kind: 'table', name: 'dim_shop' })
    expect((dim.edge_memories as ReadonlyArray<{ id: string }>)[0]?.id).toBe(g3)
    // search → counts → get: the counts name exactly what the click-through shows.
    const search = toolJson(await h.client.callTool('search_definitions', { query: 'dws_order' })) as { hits: ReadonlyArray<{ id: string; memory_counts?: Record<string, number> }> }
    const hit = search.hits.find(x => x.id === 'table:dws_order')
    expect(hit?.memory_counts).toEqual({ inference: 1, practice: 1 })
    // A hit with nothing anchored carries no key at all.
    expect(search.hits.find(x => x.id === 'table:dim_shop')?.memory_counts).toBeUndefined()
  })

  it('G3′ three states through data_window: inside / outside / absent', async () => {
    h = await buildIntentToolHarness()
    await addShopJoin(h!)
    const [g3] = await record(h, [
      { type: 'incident', anchors: ['table:dws_order -joins-> table:dim_shop'], body: '2026-10-01 未产出。', valid_from: '2026-10-01', valid_until: '2026-10-01' },
    ])
    const at = async (window: { from: string; to: string } | undefined) => {
      const body = await getDefinition(h!, { kind: 'table', name: 'dws_order', ...(window !== undefined ? { data_window: window } : {}) })
      return (body.edge_memories as ReadonlyArray<{ id: string }> | undefined) ?? []
    }
    expect((await at({ from: '2026-10-01', to: '2026-10-01' })).map(r => r.id)).toEqual([g3])
    expect(await at({ from: '2026-10-02', to: '2026-10-03' })).toEqual([])
    // 不传窗:the response carries no edge_memories key when everything hides?
    // No — 不传窗不隐藏: the incident is visible by recency.
    expect((await at(undefined)).map(r => r.id)).toEqual([g3])
  })

  it('get_join_path / get_relations mount ≤3 per edge with the full anchor', async () => {
    h = await buildIntentToolHarness()
    await addShopJoin(h)
    await record(h, [
      { type: 'caveat', anchors: ['table:dws_order -joins-> table:dim_shop'], body: 'join 在 shop_id=0 放大 3 倍。' },
      { type: 'incident', anchors: ['table:dws_order -joins-> table:dim_shop'], body: '2026-10-01 延迟。', valid_from: '2026-10-01', valid_until: '2026-10-01' },
    ])
    const path = toolJson(await h.client.callTool('get_join_path', { from: 'dws_order', to: 'dim_shop' })) as { path: string[]; edge_memories: ReadonlyArray<{ anchor: string; type: string }> }
    expect(path.edge_memories).toHaveLength(2)
    for (const row of path.edge_memories) expect(row.anchor).toBe('table:dws_order -joins-> table:dim_shop')
    const rels = toolJson(await h.client.callTool('get_relations', { target: 'dws_order', type: 'joins' })) as { relations: ReadonlyArray<{ targetId: string; memories?: ReadonlyArray<{ anchor: string }> }> }
    const row = rels.relations.find(r => r.targetId === 'table:dim_shop')
    expect(row?.memories).toHaveLength(2)
    for (const m of row?.memories ?? []) expect(m.anchor).toBe('table:dws_order -joins-> table:dim_shop')
  })
})

// ── ADR-0026: dangling anchors over the wire ───────────────────────────────

describe('ADR-0026 R2/R3 — dangling anchors over the wire', () => {
  it('remove_relation: the caveat survives on BOTH ends marked relation_missing, the relation tools stop showing it, and re-adding clears the mark', async () => {
    h = await buildIntentToolHarness()
    await addShopJoin(h)
    const [caveat] = await record(h, [
      { type: 'caveat', anchors: ['table:dws_order -joins-> table:dim_shop'], body: '该 join 在 shop_id=0 放大 3 倍' },
    ])
    const version = toolJson(await h.client.callTool('get_definition', { kind: 'table', name: 'dws_order' })) as { version: string }
    const removed = toolOutcome(await h.client.callTool('remove_relation', {
      scope_id: 'fixture', kind: 'table', name: 'dws_order',
      relations: [{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
      summary: '删 join', ...tier2('删 join', 0.9), expected_version: version.version,
    }))
    expect(removed.isError).toBe(false)
    // Both ends still see it — marked.
    for (const name of ['dws_order', 'dim_shop']) {
      const body = await getDefinition(h, { kind: 'table', name })
      const edge = (body.edge_memories as ReadonlyArray<{ id: string; relation_missing?: true }>)[0]
      expect(edge).toMatchObject({ id: caveat, relation_missing: true })
    }
    // The relation tools do not list a dead edge (get_join_path: unreachable).
    const path = toolJson(await h.client.callTool('get_join_path', { from: 'dws_order', to: 'dim_shop' })) as Record<string, unknown>
    expect(path.found).toBe(false)
    expect(path).not.toHaveProperty('edge_memories')
    const rels = toolJson(await h.client.callTool('get_relations', { target: 'dws_order', type: 'joins' })) as { relations: unknown[] }
    expect(rels.relations).toEqual([])
    // 把边加回:the mark disappears (悬空读时现算).
    await addShopJoin(h)
    const restored = await getDefinition(h, { kind: 'table', name: 'dim_shop' })
    const edge = (restored.edge_memories as ReadonlyArray<{ id: string; relation_missing?: true }>)[0]
    expect(edge).toMatchObject({ id: caveat })
    expect(edge).not.toHaveProperty('relation_missing')
  })

  it('a hand-deleted node file turns definition_not_found into an orphan report; restoring the file restores the mount', async () => {
    h = await buildIntentToolHarness()
    // A second table with a memory on it, then the file vanishes git-side
    // (ADR-0026 Context: node deletion has no tool). The file lands as its
    // own commit first — record_memory's posture check refuses a dirty tree.
    const raw = loadTables(h!.fixture.root).find(t => t.table_name === 'dim_shop')?.raw
    if (raw === undefined) throw new Error('fixture dim missing')
    const dimExtra = () => writeFileSync(join(h!.fixture.root, 'tables', 'dim_extra.yaml'), dumpYaml(fixtureTable({
      ...raw as Record<string, unknown>,
      table_name: 'dim_extra',
    })), 'utf8')
    dimExtra()
    fixtureGit(['add', '-A'], h.fixture.root)
    fixtureGit(['commit', '--quiet', '-m', 'operator adds dim_extra'], h.fixture.root)
    const [orphan] = await record(h, [{ type: 'practice', anchors: ['table:dim_extra'], body: '口径', basis: '列注释' }])
    rmSync(join(h.fixture.root, 'tables', 'dim_extra.yaml'))

    const out = toolOutcome(await h.client.callTool('get_definition', { kind: 'table', name: 'dim_extra' }))
    expect(out.isError).toBe(true)
    expect(out.body.code).toBe(-31021)
    expect(out.body.message).toContain('仍有 1 条 memory 锚在它上面')
    const data = out.body.data as Record<string, unknown>
    expect(data.kind).toBe('table')
    expect(data.name).toBe('dim_extra')
    expect(data.orphaned_memories).toEqual([
      expect.objectContaining({ id: orphan, definition_missing: true, anchor: 'table:dim_extra' }),
    ])
    // 目标加回即恢复:the plain mount returns, no orphan keys anywhere.
    dimExtra()
    const back = await getDefinition(h, { kind: 'table', name: 'dim_extra' })
    expect((back.memories as ReadonlyArray<{ id: string }>)[0]?.id).toBe(orphan)
    expect(back).not.toHaveProperty('edge_memories')
  })
})

// ── ADR-0027 R4: contested over the wire ───────────────────────────────────

describe('ADR-0027 R4 — contested over the wire', () => {
  it('contested_with is bilateral, the companion travels cross-anchor with its own anchor, and counts include it', async () => {
    h = await buildIntentToolHarness()
    const [first] = await record(h, [
      { type: 'observation', anchors: ['table:dws_order'], body: 'join 后无放大。', valid_from: '2026-09-15', valid_until: '2026-10-15' },
    ])
    const [second] = await record(h, [
      { type: 'observation', anchors: ['table:dim_shop'], body: '放大 3 倍。', valid_from: '2026-09-01', valid_until: '2026-09-30', contradicts: [first] },
    ])
    // dws_order's mount carries both: its own entry plus the traveling
    // companion (anchored on dim_shop) right behind it, with its own anchor.
    const body = await getDefinition(h, { kind: 'table', name: 'dws_order' })
    const rows = body.memories as ReadonlyArray<{ id: string; anchor: string; contested_with?: string[] }>
    expect(rows.map(r => r.id)).toEqual([first, second])
    expect(rows[1]?.anchor).toBe('table:dim_shop')
    expect(rows[0]?.contested_with).toEqual([second])
    expect(rows[1]?.contested_with).toEqual([first])
    // Counts include the companion (R6 + ADR-0027 R4).
    const search = toolJson(await h.client.callTool('search_definitions', { query: 'dws_order' })) as { hits: ReadonlyArray<{ id: string; memory_counts?: Record<string, number> }> }
    expect(search.hits.find(x => x.id === 'table:dws_order')?.memory_counts).toEqual({ observation: 2 })
    // get_definition's description teaches the read-side rule from the same
    // regimen source (ADR-0027 R2 ③) — no _guidance on read tools (R7).
    const catalog = await h.client.listTools()
    const tool = (catalog.result?.['tools'] as ReadonlyArray<{ name: string; description?: string }>).find(t => t.name === 'get_definition')
    expect(tool?.description).toContain('contested_with')
  })

  it('wrong-hiding one side dissolves the pair on the read surface', async () => {
    h = await buildIntentToolHarness()
    const [x] = await record(h, [
      { type: 'observation', anchors: ['table:dws_order'], body: '无放大。', valid_from: '2026-09-15', valid_until: '2026-10-15' },
    ])
    await record(h, [
      { type: 'observation', anchors: ['table:dws_order'], body: '放大 3 倍。', valid_from: '2026-09-01', valid_until: '2026-09-30', contradicts: [x] },
    ])
    await record(h, [
      { type: 'observation', anchors: ['table:dws_order'], body: '复测:确无放大。', valid_from: '2026-10-01', valid_until: '2026-10-02', supersedes: [{ id: x, reason: 'wrong' }], basis: '覆盖重叠窗口的复测' },
    ])
    const body = await getDefinition(h, { kind: 'table', name: 'dws_order' })
    const rows = body.memories as ReadonlyArray<{ id: string; contested_with?: string[] }>
    expect(rows).toHaveLength(2) // the contested one and the adjudicating re-test
    for (const row of rows) expect(row.contested_with).toBeUndefined()
  })
})

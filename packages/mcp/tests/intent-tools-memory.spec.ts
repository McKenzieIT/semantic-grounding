/**
 * `record_memory` over the wire (#152 / ADR-0023 R9 + ADR-0026 R5 + ADR-0027),
 * and the three edge-removal receipts' `dangling_memories` arms.
 *
 * Runs through the real harness (fixture corpus, real git recorder, real
 * registrars) so every assertion is about the served surface: the single
 * commit per call, the server-written `recorded` block, the deterministic
 * NOOP's session scoping, the neighbors' per-case guidance, the coded
 * whole-batch rejection, and ADR-0026 R5's three reminder sites
 * (`remove_relation` per-edge rows, `update_definition`'s dropped domains,
 * `import_definitions`' dropped `dimension_refs`) — including the key's
 * absence on a memory-free corpus, which is what keeps those receipts
 * byte-identical when no memory exists.
 *
 * @see docs/adr/0023-memory-storage-shape-and-node-ids.md
 * @see docs/adr/0026-dangling-memory-anchors.md
 * @see docs/adr/0027-contested-memories.md
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { loadTables } from '@semantic-grounding/substrate'
import { buildIntentToolHarness, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
import { createFixtureCorpus, fixtureGit, fixtureTable, type FixtureCorpus } from './helpers/fixture-corpus.ts'
import { toolOutcome } from './helpers/inprocess-client.ts'

let h: IntentToolHarness | undefined
/** The owned harness's corpus (the cross-session test builds two harnesses over it). */
let corpus: FixtureCorpus | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
  corpus?.cleanup()
  corpus = undefined
})

const MEM_ID = /^mem-\d{8}-[a-z2-7]{8}$/

interface MemoryRow {
  readonly index: number
  readonly verdict: 'recorded' | 'idempotent'
  readonly id: string
  readonly neighbors: ReadonlyArray<{ readonly id: string; readonly summary: string; readonly guidance: string }>
}

function memoryYamls(root: string): Record<string, unknown>[] {
  const dir = join(root, 'memory')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith('.yaml')).sort()
    .map(f => yaml.load(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>)
}

async function callRecord(harness: IntentToolHarness, memories: ReadonlyArray<Record<string, unknown>>) {
  return toolOutcome(await harness.client.callTool('record_memory', {
    scope_id: 'fixture',
    memories,
    summary: '记录数据 memory',
    derivation: 'agent',
    confidence: 0.8,
  }))
}

function rowsOf(body: Record<string, unknown>): MemoryRow[] {
  return body.results as MemoryRow[]
}

// ── record_memory: the three seed cards, one commit, server provenance ─────

describe('record_memory — happy paths and the envelope', () => {
  it('lands the three seed cards (E3/A3/G3′) in one call, one commit, server-written recorded', async () => {
    h = await buildIntentToolHarness()
    const out = await callRecord(h, [
      { type: 'inference', anchors: ['dws_order#shop_id'], body: '「2渠」即 shop_id。', basis: '列注释' },
      { type: 'practice', anchors: ['table:dws_order'], body: '大R 口径本次取 r_level 07–09。', basis: '本次自选口径', valid_from: '2026-10-16' },
      { type: 'incident', anchors: ['dws_order'], body: '上游未产出,当天指标偏低。', valid_from: '2026-10-01', valid_until: '2026-10-01' },
    ])
    expect(out.isError).toBe(false)
    const body = out.body
    expect(body.changed).toBe(true)
    expect(typeof body.commit).toBe('string')
    expect(body.commit).not.toBe('')
    expect(body.enrichment_health).toBeUndefined()
    expect(body._guidance).toBeUndefined()
    const rows = rowsOf(body)
    expect(rows.map(r => r.verdict)).toEqual(['recorded', 'recorded', 'recorded'])
    for (const row of rows) expect(row.id).toMatch(MEM_ID)
    for (const row of rows) expect(row.neighbors).toEqual([])

    // One file per entry, server-stamped provenance (ADR-0023 R5): the agent
    // never sent session/agent — the server wrote them.
    const entries = memoryYamls(h.fixture.root)
    expect(entries).toHaveLength(3)
    const sessions = new Set<string>()
    for (const entry of entries) {
      expect(entry.id).toMatch(MEM_ID)
      expect((entry.recorded as Record<string, unknown>).agent).toBe('test-agent')
      sessions.add((entry.recorded as Record<string, unknown>).session as string)
    }
    expect(sessions.size).toBe(1) // one serving session stamped all three
    expect([...sessions][0]).toMatch(/^sg-/) // the process mint's shape

    // The commit's trailer names the same session (X-SG-Session).
    const trailers = await h.recorder.readTrailers(String(body.commit))
    expect(trailers.Session).toBe([...sessions][0])
  })

  it('repeats idempotently within one session: verdict idempotent, no new file, no commit', async () => {
    h = await buildIntentToolHarness()
    const draft = [{ type: 'observation', anchors: ['dws_order'], body: 'join 后行数 877 vs 873。', valid_from: '2026-10-15', valid_until: '2026-10-15' }]
    const first = await callRecord(h, draft)
    expect(first.body.changed).toBe(true)
    const headBefore = fixtureGit(['rev-parse', 'HEAD'], h.fixture.root)

    const second = await callRecord(h, draft)
    expect(second.isError).toBe(false)
    expect(second.body.changed).toBe(false)
    expect(rowsOf(second.body)[0]?.verdict).toBe('idempotent')
    expect(rowsOf(second.body)[0]?.id).toBe(rowsOf(first.body)[0]?.id)
    expect(memoryYamls(h.fixture.root)).toHaveLength(1)
    expect(fixtureGit(['rev-parse', 'HEAD'], h.fixture.root)).toBe(headBefore)
  })

  it('re-records the same content from a DIFFERENT session (replication evidence, ADR-0023 R9)', async () => {
    corpus = createFixtureCorpus()
    const a = await buildIntentToolHarness({ corpusRoot: corpus.root, sessionId: 'session-a' })
    const draft = [{ type: 'observation', anchors: ['dws_order'], body: '同一结论。', valid_from: '2026-10-15', valid_until: '2026-10-15' }]
    const first = await callRecord(a, draft)
    expect(rowsOf(first.body)[0]?.verdict).toBe('recorded')
    await a.close()

    const b = await buildIntentToolHarness({ corpusRoot: corpus.root, sessionId: 'session-b' })
    const second = await callRecord(b, draft)
    expect(second.body.changed).toBe(true)
    const row = rowsOf(second.body)[0]
    expect(row?.verdict).toBe('recorded')
    expect(row?.id).not.toBe(rowsOf(first.body)[0]?.id)
    const entries = memoryYamls(corpus.root)
    expect(entries).toHaveLength(2)
    // The neighbor channel carried the first entry to the second session
    // (ADR-0023 R9 + ADR-0027 R2 ②): id + summary + per-case guidance, and
    // the receipt-level note that an update should supersedes-reference.
    expect(row?.neighbors.map(n => n.id)).toEqual([rowsOf(first.body)[0]?.id])
    expect(row?.neighbors[0]?.guidance).toContain(rowsOf(first.body)[0]?.id as string)
    expect(row?.neighbors[0]?.guidance).toContain('outdated')
    expect(second.body.note).toEqual(expect.stringContaining('supersedes'))
    await b.close()
    h = undefined
  })

  it('rejects the whole batch naming the item — nothing written, no commit (整批原子)', async () => {
    h = await buildIntentToolHarness()
    const headBefore = fixtureGit(['rev-parse', 'HEAD'], h.fixture.root)
    const out = await callRecord(h, [
      { type: 'caveat', anchors: ['dws_order'], body: 'valid entry' },
      { type: 'incident', anchors: ['dws_order'], body: 'no window' },
      { type: 'caveat', anchors: ['table:missing'], body: 'bad anchor' },
    ])
    expect(out.isError).toBe(true)
    expect(out.body.code).toBe(-31025)
    expect((out.body.data as Record<string, unknown>).item_index).toBe(2)
    expect(out.body.message).toContain('item 2')
    expect(memoryYamls(h.fixture.root)).toEqual([])
    expect(fixtureGit(['rev-parse', 'HEAD'], h.fixture.root)).toBe(headBefore)
  })
})

// ── ADR-0026 R5: the three edge-removal reminders ──────────────────────────

/** Add the fixture's discoverable join via the item tool (curated origin). */
async function addShopJoin(harness: IntentToolHarness): Promise<void> {
  const version = harness.core.loadTableDefinitionWithVersion('dws_order')?.version
  if (version === undefined) throw new Error('fixture table missing')
  const out = toolOutcome(await harness.client.callTool('add_relation', {
    scope_id: 'fixture',
    kind: 'table',
    name: 'dws_order',
    relations: [{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
    summary: '补 join',
    derivation: 'agent',
    confidence: 0.9,
    expected_version: version,
  }))
  expect(out.isError).toBe(false)
}

function currentTableVersion(harness: IntentToolHarness, name: string): string {
  const v = harness.core.loadTableDefinitionWithVersion(name)?.version
  if (v === undefined) throw new Error(`table missing: ${name}`)
  return v
}

describe('ADR-0026 R5 — dangling_memories receipts', () => {
  it('remove_relation: a removed edge with an anchored memory counts it; a memory-free corpus keeps the key absent', async () => {
    h = await buildIntentToolHarness()
    await addShopJoin(h)
    const out = toolOutcome(await h.client.callTool('remove_relation', {
      scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      relations: [{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
      summary: '删 join',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: currentTableVersion(h, 'dws_order'),
    }))
    expect(out.isError).toBe(false)
    const rows = out.body.results as ReadonlyArray<Record<string, unknown>>
    // No memory yet: the row's key set is exactly the ItemVerdict four — the
    // receipt is byte-identical to the pre-memory surface.
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['key', 'outcome', 'reasserted', 'suppressed'])

    // Re-add the edge, anchor one memory on it, remove again.
    await addShopJoin(h)
    const mem = await callRecord(h, [{ type: 'caveat', anchors: ['table:dws_order -joins-> table:dim_shop'], body: '该 join 在 shop_id=0 放大 3 倍' }])
    expect(mem.isError).toBe(false)
    const out2 = toolOutcome(await h.client.callTool('remove_relation', {
      scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      relations: [{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
      summary: '再删 join',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: currentTableVersion(h, 'dws_order'),
    }))
    const rows2 = out2.body.results as ReadonlyArray<Record<string, unknown>>
    expect(rows2[0]).toMatchObject({ key: 'dim_shop', outcome: 'removed', dangling_memories: 1 })
  })

  it('update_definition dropping a domain reports the dying membership edges; keeping domains stays silent', async () => {
    h = await buildIntentToolHarness()
    // Mount dws_order under a concept, anchor a memory on the membership
    // edge, then unmount.
    const concept = toolOutcome(await h.client.callTool('create_definition', {
      scope_id: 'fixture',
      kind: 'concept',
      concept: { name: 'payment', description: '付费经济', alt_labels: [], properties: {} },
      summary: '建概念',
      derivation: 'agent',
      confidence: 0.9,
    }))
    expect(concept.isError).toBe(false)
    const mount = toolOutcome(await h.client.callTool('update_definition', {
      scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      fields: { domains: ['payment'] },
      summary: '挂域',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: currentTableVersion(h, 'dws_order'),
    }))
    expect(mount.isError).toBe(false)
    expect(mount.body.dangling_memories).toBeUndefined() // adding a domain kills nothing
    const mem = await callRecord(h, [{ type: 'caveat', anchors: ['concept:payment -related_to-> table:dws_order'], body: '挂在 membership 上的经验' }])
    expect(mem.isError).toBe(false)

    const unmount = toolOutcome(await h.client.callTool('update_definition', {
      scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      fields: { domains: [] },
      summary: '摘域',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: currentTableVersion(h, 'dws_order'),
    }))
    expect(unmount.isError).toBe(false)
    expect(unmount.body.dangling_memories).toBe(1)
  })

  it('import_definitions overwriting a table without its dimension_refs reports the dying join on that row', async () => {
    h = await buildIntentToolHarness()
    await addShopJoin(h)
    const mem = await callRecord(h, [{ type: 'caveat', anchors: ['table:dws_order -joins-> table:dim_shop'], body: 'join 坑' }])
    expect(mem.isError).toBe(false)

    // Re-import dws_order WITHOUT the dimension_refs entry: the payload must
    // be a full schema-valid table (mirroring the on-disk definition minus
    // the ref), and must differ from disk so it lands as `updated`.
    const onDisk = loadTables(h.fixture.root).find(t => t.table_name === 'dws_order')?.raw
    if (onDisk === undefined) throw new Error('fixture table missing')
    const payload = fixtureTable({
      table_name: 'dws_order',
      kind: 'dws',
      columns: [
        { name: 'shop_id', type: 'string', role: 'dimension', comment: '' },
        { name: 'pay_amt', type: 'double', role: 'measure', comment: '' },
      ],
      dimension_refs: [],
      domains: (onDisk.domains as string[] | undefined) ?? [],
    })
    const out = toolOutcome(await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: [{ kind: 'table', definition: payload }],
      summary: '重导入去掉 join',
      derivation: 'agent',
      confidence: 0.9,
    }))
    expect(out.isError).toBe(false)
    const rows = out.body.results as ReadonlyArray<Record<string, unknown>>
    expect(rows[0]).toMatchObject({ verdict: 'updated', dangling_memories: 1 })
    // And a no-memory twin run (same join on disk, nothing anchored on it)
    // keeps the key absent — the receipt stays byte-identical to the
    // pre-memory surface.
    const twin = await buildIntentToolHarness()
    await addShopJoin(twin)
    const twinOut = toolOutcome(await twin.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: [{ kind: 'table', definition: payload }],
      summary: '无 memory 的重导入',
      derivation: 'agent',
      confidence: 0.9,
    }))
    const twinRows = twinOut.body.results as ReadonlyArray<Record<string, unknown>>
    expect(twinRows[0]?.verdict).toBe('updated')
    expect(twinRows[0]).not.toHaveProperty('dangling_memories')
    await twin.close()
  })
})

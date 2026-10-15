/**
 * The verified query over the wire (#155 / ADR-0025 R1–R7): the
 * `create_verified_query` / `update_verified_query` pair, the read surface it
 * feeds (search / get_definition's `verified_queries` forward mount /
 * get_definition(kind:'query') with the ADR-0024 memory mount), and the
 * five refusal states the ticket pins.
 *
 * Runs through the real harness (fixture corpus, real git recorder, real
 * registrars), the same posture `intent-tools-promotion.spec.ts` takes:
 *
 * - **A3 正路一条龙**: practice memory → 晋升 (user-stated + `memory_ids`) →
 *   `promoted` 回指 in the SAME commit (X-SG-Evidence / X-SG-Memory trailers)
 *   → 读面折叠 (the practice surfaces on `get_definition(kind:'query')` as a
 *   folded `promoted` row) + the wide table carries `verified_queries`.
 * - **拒写五态**: replicated (door refusal pointing at
 *   `record_memory(type: practice)`), source-without-出处, a partition-date
 *   literal in the SQL (remedy: `${start_ds}`), a dangling `use`, and a
 *   stale `expected_version`.
 * - **改查询不改表指纹**: the used table's `version` is byte-identical across
 *   the query's create and update; the query's own moves.
 * - **零税**: a corpus with no queries keeps every read response free of
 *   query-derived keys (the byte-stability discipline of #154's mounts).
 *
 * @see docs/adr/0025-verified-query-shape-and-promotion.md
 * @see docs/adr/0023-memory-storage-shape-and-node-ids.md (the `promoted` append)
 * @see docs/adr/0024-memory-read-surface.md (the mount `get_definition(kind:'query')` takes)
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { buildIntentToolHarness, tier2, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
import { toolOutcome } from './helpers/inprocess-client.ts'

let h: IntentToolHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

/** The parameterized A3 SQL (dates as `${start_ds}`-style placeholders, R2). */
const A3_SQL = 'select ds, count(distinct shop_id) as retained from dws_order where pay_amt >= ${pay_threshold} and ds >= ${start_ds} and ds < ${end_ds} group by ds'

/** The shared create payload; per-test overrides ride `overrides`. */
function createInput(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    scope_id: 'fixture',
    name: 'big_r_retention',
    question: '大R 留存',
    alt_questions: ['高付费用户留存'],
    sql: A3_SQL,
    uses: ['table:dws_order#pay_amt'],
    description: '大R = 累计付费 ≥ 328 元(用户口述口径)',
    evidence: 'user-stated',
    ...tier2('A3 晋升:大R 留存口径', 0.9),
    ...overrides,
  }
}

/** Record one practice memory through the wire; fail-loud; returns its id. */
async function recordPracticeMemory(harness: IntentToolHarness, anchors: readonly string[], body: string): Promise<string> {
  const out = toolOutcome(await harness.client.callTool('record_memory', {
    scope_id: 'fixture',
    memories: [{ type: 'practice', anchors, body, basis: '用户在会话中口述' }],
    summary: '记录大R 口径 practice',
    derivation: 'agent',
    confidence: 0.8,
  }))
  if (out.isError) throw new Error(`record_memory failed: ${JSON.stringify(out.body)}`)
  return String((out.body.results as Array<{ readonly id: string }>)[0]?.id)
}

/** A recorded memory's parsed YAML on disk. */
function readMemory(root: string, id: string): Record<string, unknown> {
  return yaml.load(readFileSync(join(root, 'memory', `${id}.yaml`), 'utf8')) as Record<string, unknown>
}

/** `get_definition`'s parsed body. */
async function getDefinition(harness: IntentToolHarness, kind: string, name: string): Promise<Record<string, unknown>> {
  const out = toolOutcome(await harness.client.callTool('get_definition', { kind, name }))
  if (out.isError) throw new Error(`get_definition(${kind}:${name}) failed: ${JSON.stringify(out.body)}`)
  return out.body
}

// ── A3 正路一条龙 ─────────────────────────────────────────────────────────────

describe('verified query — A3 正路 (practice → 晋升 → promoted 回指 → 读面折叠)', () => {
  it('the whole chain lands: practice memory, user-stated promotion citing it, the same-commit back-pointer, and both read mounts', async () => {
    h = await buildIntentToolHarness()
    const root = h.fixture.root
    // 1. The practice memory the 口径 starts life as.
    const memId = await recordPracticeMemory(h, ['table:dws_order#pay_amt'], '大R = 累计付费 ≥ 328 元(阈值随季度未定,先按用户口述)。')
    // 2. The promotion: user-stated + the citation.
    const out = toolOutcome(await h.client.callTool('create_verified_query', createInput({ memory_ids: [memId] })))
    expect(out.isError).toBe(false)
    const body = out.body as { commit: string; changed: boolean; version: string; _guidance: string }
    expect(body.changed).toBe(true)
    // ADR-0025 R7: the receipt's one-sentence _guidance names the practice route.
    expect(body._guidance).toContain('record_memory(type: practice)')
    // The promotion commit's trailers: ② user-stated + the citation (the
    // #136 channel, X-SG-Memory rendered for a ①/② citation).
    const trailers = await h.recorder.readTrailers(body.commit)
    expect(trailers.Evidence).toBe('user-stated')
    expect(trailers['Evidence-Source']).toBeUndefined()
    expect(trailers.Memory).toBe(memId)
    // 3. The same-commit `promoted` 回指 onto the cited practice (ADR-0023 R6).
    const entry = readMemory(root, memId)
    expect(entry.promoted).toEqual([
      expect.objectContaining({ to: 'query:big_r_retention', session: expect.any(String) }),
    ])
    // 4a. The fold shows where the practice is ANCHORED — the wide table:
    //     a promoted row carries no body, takes no budget, names only its id.
    const table = await getDefinition(h, 'table', 'dws_order')
    const foldedRows = (table.memories as ReadonlyArray<Record<string, unknown>>) ?? []
    expect(foldedRows).toHaveLength(1)
    expect(foldedRows[0]).toMatchObject({ id: memId, type: 'practice', promoted: true })
    expect(foldedRows[0]).not.toHaveProperty('body')
    // 4b. The wide table's forward mount: the query by id + question, and the
    //     table YAML stores no back-link.
    expect(table.verified_queries).toEqual([{ id: 'query:big_r_retention', question: '大R 留存' }])
    const tableYaml = readFileSync(join(root, 'tables', 'dws_order.yaml'), 'utf8')
    expect(tableYaml).not.toContain('big_r_retention')
    // 4c. The query read: full text + version + the ADR-0024 mount for a
    //     memory anchored ON the query node (a verification caveat rides
    //     along; the table-anchored practice does not — anchors decide).
    const caveat = toolOutcome(await h.client.callTool('record_memory', {
      scope_id: 'fixture',
      memories: [{ type: 'caveat', anchors: ['query:big_r_retention'], body: '未在 pay_amt 含退款口径下复验。' }],
      summary: '记录查询的验证边界',
      derivation: 'agent',
      confidence: 0.7,
    }))
    if (caveat.isError) throw new Error(JSON.stringify(caveat.body))
    const caveatId = String((caveat.body.results as Array<{ readonly id: string }>)[0]?.id)
    const q = await getDefinition(h, 'query', 'big_r_retention')
    expect(q.version).toBe(body.version)
    expect(q.definition).toMatchObject({
      name: 'big_r_retention',
      question: '大R 留存',
      alt_questions: ['高付费用户留存'],
      uses: ['table:dws_order#pay_amt'],
    })
    expect((q.definition as { sql: string }).sql).toBe(A3_SQL)
    const qMemories = q.memories as ReadonlyArray<Record<string, unknown>>
    expect(qMemories).toHaveLength(1)
    expect(qMemories[0]).toMatchObject({ id: caveatId, type: 'caveat' })
    expect(qMemories[0]).toHaveProperty('body')
    expect(qMemories.map(m => m.id)).not.toContain(memId)
    // 4c. Search finds the query by its question and by 同问异说 — never by SQL.
    const byQuestion = toolOutcome(await h.client.callTool('search_definitions', { query: '大R 留存' }))
    expect((byQuestion.body.hits as Array<{ id: string }>).map(x => x.id)).toContain('query:big_r_retention')
    const byAlt = toolOutcome(await h.client.callTool('search_definitions', { query: '高付费用户留存' }))
    expect((byAlt.body.hits as Array<{ id: string }>).map(x => x.id)).toContain('query:big_r_retention')
    // (The SQL-never-indexed rule is pinned substrate-side, on the corpus
    // item's indexed text — bigram overlap makes a wire-level "not found by
    // SQL text" assertion meaningless.)
    // 4d. list_definitions lists it (kind 'query', ADR-0025 R6④).
    const list = toolOutcome(await h.client.callTool('list_definitions', { kinds: ['query'] }))
    expect((list.body.definitions as Array<{ id: string; kind: string }>).map(r => [r.kind, r.id])).toEqual([['query', 'query:big_r_retention']])
  })
})

// ── 拒写五态 ───────────────────────────────────────────────────────────────────

describe('verified query — 拒写五态', () => {
  it('replicated is refused at the door, pointing at record_memory(type: practice) (ADR-0025 R3)', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('create_verified_query', createInput({ evidence: 'replicated', memory_ids: ['mem-20260101-aaaaaaaa'] }))
    expect(res.result?.['isError']).toBe(true)
    const text = (res.result?.['content'] as Array<{ text: string }>)[0]?.text ?? ''
    expect(text).toContain('replicated')
    expect(text).toContain('record_memory(type: practice)')
    expect(h.core.loadQueryDefinition('big_r_retention')).toBeNull()
  })

  it('evidence "source" without evidence_source is refused', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('create_verified_query', createInput({ evidence: 'source' }))
    expect(res.result?.['isError']).toBe(true)
    const text = (res.result?.['content'] as Array<{ text: string }>)[0]?.text ?? ''
    expect(text).toContain('evidence_source')
    expect(h.core.loadQueryDefinition('big_r_retention')).toBeNull()
  })

  it('a partition-date literal in the SQL is refused with the ${start_ds} remedy (ADR-0025 R2)', async () => {
    h = await buildIntentToolHarness()
    for (const sql of [
      "select count(*) from dws_order where ds >= '2026-07-29'",
      'select count(*) from dws_order where ds = 20260729',
    ]) {
      const res = await h.client.callTool('create_verified_query', createInput({ sql }))
      expect(res.result?.['isError']).toBe(true)
      const text = (res.result?.['content'] as Array<{ text: string }>)[0]?.text ?? ''
      expect(text).toContain('${start_ds}')
    }
    // A non-date 8-digit number (a threshold) and the blessed placeholders stay clean.
    const clean = toolOutcome(await h.client.callTool('create_verified_query', createInput({ sql: 'select count(*) from dws_order where pay_amt >= 12345678 and ds >= ${start_ds}' })))
    expect(clean.isError).toBe(false)
    expect(h.core.loadQueryDefinition('big_r_retention')).not.toBeNull()
  })

  it('a dangling use refuses whole-call as a coded validation error, nothing written', async () => {
    h = await buildIntentToolHarness()
    const out = toolOutcome(await h.client.callTool('create_verified_query', createInput({ uses: ['table:no_such_table'] })))
    expect(out.isError).toBe(true)
    expect(out.body['code']).toBe(-31024)
    expect(String(out.body['message'])).toMatch(/anchor names no node/)
    expect(h.core.loadQueryDefinition('big_r_retention')).toBeNull()
  })

  it('update with a stale expected_version refuses as stale_baseline (−31002), nothing written', async () => {
    h = await buildIntentToolHarness()
    const created = toolOutcome(await h.client.callTool('create_verified_query', createInput()))
    if (created.isError) throw new Error(JSON.stringify(created.body))
    const out = toolOutcome(await h.client.callTool('update_verified_query', createInput({
      question: '大R 留存(修订)',
      expected_version: '0'.repeat(64),
    })))
    expect(out.isError).toBe(true)
    expect(out.body['code']).toBe(-31002)
    expect(h.core.loadQueryDefinition('big_r_retention')?.question).toBe('大R 留存')
  })
})

// ── update 正路 + 指纹 ────────────────────────────────────────────────────────

describe('verified query — update, and 改查询不改表指纹', () => {
  it('a full-payload update changes the QUERY fingerprint only; the used table keeps its expected_version', async () => {
    h = await buildIntentToolHarness()
    const tableBefore = String(await (await getDefinition(h, 'table', 'dws_order')).version)
    const created = toolOutcome(await h.client.callTool('create_verified_query', createInput()))
    if (created.isError) throw new Error(JSON.stringify(created.body))
    const queryV1 = String(created.body.version)
    expect(String((await getDefinition(h, 'table', 'dws_order')).version)).toBe(tableBefore)
    const updated = toolOutcome(await h.client.callTool('update_verified_query', createInput({
      sql: 'select ds, count(distinct shop_id) as retained from dws_order where pay_amt >= ${pay_threshold} * 2 and ds >= ${start_ds} and ds < ${end_ds} group by ds',
      expected_version: queryV1,
    })))
    if (updated.isError) throw new Error(JSON.stringify(updated.body))
    expect(String(updated.body.version)).not.toBe(queryV1)
    // The table's fingerprint survived both writes — uses is a forward
    // reference, and the table YAML stores no back-link.
    expect(String((await getDefinition(h, 'table', 'dws_order')).version)).toBe(tableBefore)
    expect((await getDefinition(h, 'table', 'dws_order')).verified_queries).toEqual([{ id: 'query:big_r_retention', question: '大R 留存' }])
  })

  it('create refuses an existing name; update refuses a missing one (the create/update door discipline)', async () => {
    h = await buildIntentToolHarness()
    const created = toolOutcome(await h.client.callTool('create_verified_query', createInput()))
    if (created.isError) throw new Error(JSON.stringify(created.body))
    const dup = toolOutcome(await h.client.callTool('create_verified_query', createInput({ summary: '重名创建' })))
    expect(dup.isError).toBe(true)
    expect(dup.body['code']).toBe(-31022)
    const missing = toolOutcome(await h.client.callTool('update_verified_query', createInput({ name: 'no_such_query', expected_version: '0'.repeat(64) })))
    expect(missing.isError).toBe(true)
    expect(missing.body['code']).toBe(-31021)
  })
})

// ── 零税:无 query 时各工具返回字节不变 ────────────────────────────────────────

describe('verified query — zero-tax on a query-free corpus', () => {
  it('get_definition carries no verified_queries key; search/list carry no query-kind rows (ADR-0025 零税)', async () => {
    h = await buildIntentToolHarness()
    const table = await getDefinition(h, 'table', 'dws_order')
    expect(table).not.toHaveProperty('verified_queries')
    // The full response text never mentions the key — the byte-stability pin.
    const tableText = JSON.stringify(table)
    expect(tableText).not.toContain('verified_queries')
    const concept = await getDefinition(h, 'table', 'dim_shop')
    expect(concept).not.toHaveProperty('verified_queries')
    const search = toolOutcome(await h.client.callTool('search_definitions', { query: 'o' }))
    expect(((search.body.hits as Array<{ kind: string }>).map(x => x.kind))).not.toContain('query')
    const list = toolOutcome(await h.client.callTool('list_definitions', {}))
    expect(((list.body.definitions as Array<{ kind: string }>).map(x => x.kind))).not.toContain('query')
  })
})

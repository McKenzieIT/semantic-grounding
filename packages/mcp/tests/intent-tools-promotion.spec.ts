/**
 * Promotion over the wire (#136 / ADR-0021 R5–R7, as revised by ADR-0023 R5/R6
 * and narrowed by ADR-0027 R6): the `evidence` input the five definition-write
 * tools carry, the `X-SG-Evidence` / `X-SG-Evidence-Source` / `X-SG-Memory`
 * trailers its commit renders, the ③ replicated server-side guard (a coded
 * whole-call refusal), and the same-commit `promoted` back-pointer append onto
 * every counting cited memory.
 *
 * Runs through the real harness (fixture corpus, real git recorder, real
 * registrars), the same posture `intent-tools-memory.spec.ts` takes — every
 * assertion is about the served surface:
 *
 * - **E3 (ADR-0028's zero-code adjudication)**: the 术语概念 promotion —
 *   `X-SG-Evidence: source`, 出处 = `dws_10000251_acc_summary_df` 的 `ch_id`
 *   列注释 — lands through `import_definitions` (the CLI-visible path, #132).
 * - **② user-stated** promotes through `add_alias` with the kind trailer and
 *   neither companion.
 * - **③ replicated** promotes through `add_alias` citing two memories recorded
 *   by different sessions on different UTC days: ONE commit carries the alias
 *   write AND both memory files' `promoted` append (ADR-0023 R6's 同一
 *   commit), with `X-SG-Memory` naming the citation.
 * - The **contested 拒路** (ADR-0027 R6): a citation touching a still-live
 *   `contradicts` pair refuses whole-call (`promotion_rejected`, −31026,
 *   `data.reason`), nothing written.
 *
 * @see docs/adr/0021-data-memory-layer-and-promotion.md
 * @see docs/adr/0023-memory-storage-shape-and-node-ids.md
 * @see docs/adr/0028-column-jargon-as-term-concepts.md
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { edgeAnchorOf } from '@semantic-grounding/substrate'
import { buildIntentToolHarness, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
import { createFixtureCorpus, fixtureGit, fixtureTable, type FixtureCorpus } from './helpers/fixture-corpus.ts'
import { toolOutcome } from './helpers/inprocess-client.ts'

let h: IntentToolHarness | undefined
/** The owned harness's corpus (the replicated tests build several harnesses over it). */
let corpus: FixtureCorpus | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
  corpus?.cleanup()
  corpus = undefined
})

interface MemoryRow {
  readonly index: number
  readonly verdict: 'recorded' | 'idempotent'
  readonly id: string
}

/** Record one memory through the wire; fail-loud on anything but success. */
async function recordOneMemory(harness: IntentToolHarness, memories: ReadonlyArray<Record<string, unknown>>): Promise<string> {
  const out = toolOutcome(await harness.client.callTool('record_memory', {
    scope_id: 'fixture',
    memories,
    summary: '记录数据 memory',
    derivation: 'agent',
    confidence: 0.8,
  }))
  if (out.isError) throw new Error(`record_memory failed: ${JSON.stringify(out.body)}`)
  const row = (out.body.results as MemoryRow[])[0]
  if (row === undefined) throw new Error('no row')
  return row.id
}

/** A recorded memory's parsed YAML on disk. */
function readMemory(root: string, id: string): Record<string, unknown> {
  return yaml.load(readFileSync(join(root, 'memory', `${id}.yaml`), 'utf8')) as Record<string, unknown>
}

/**
 * Re-stamp memory files' `recorded.at` and land the edit as its own commit —
 * the wire-side stand-in for "recorded on another UTC day" (`recorded.at` is
 * server-written now, so same-test second entries would share today) that
 * keeps the tree clean for the next audited write.
 */
function commitRestamps(root: string, ats: ReadonlyArray<{ readonly id: string; readonly at: string }>): void {
  for (const { id, at } of ats) {
    const entry = readMemory(root, id)
    const recorded = entry.recorded as Record<string, unknown>
    recorded.at = at
    writeFileSync(join(root, 'memory', `${id}.yaml`), yaml.dump(entry), 'utf8')
  }
  fixtureGit(['add', '-A'], root)
  fixtureGit(['commit', '--quiet', '-m', 'test: re-stamp recorded.at for replication'], root)
}

// ── ① source: the E3 术语概念 promotion (ADR-0028 — zero code, one test) ─────

describe('promotion — ① source', () => {
  it('E3: the 术语概念 promotion lands through import_definitions with X-SG-Evidence: source + the 出处 trailer (ADR-0028)', async () => {
    h = await buildIntentToolHarness()
    // ADR-0028 R2's two term concepts: 一级渠道 (ch_type) and 二级渠道 (ch_id),
    // the jargon columns' comment being the deterministic source.
    const out = toolOutcome(await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: [
        { kind: 'concept', definition: { name: '一级渠道', description: '渠道一级分类,对应列 ch_type。', alt_labels: ['1渠'], properties: { column: 'ch_type', recent_column: 'ch_type_lst' } } },
        { kind: 'concept', definition: { name: '二级渠道', description: '渠道二级分类,隶属一级渠道,对应列 ch_id。', alt_labels: ['2渠'], properties: { column: 'ch_id', recent_column: 'ch_id_lst', parent: '一级渠道', parent_column: 'ch_type' } } },
      ],
      summary: 'E3 晋升:列注释黑话 → 术语概念',
      derivation: 'agent',
      confidence: 0.9,
      evidence: { kind: 'source', source: 'dws_10000251_acc_summary_df 的 ch_id 列注释(渠道id,又叫2渠)' },
    }))
    expect(out.isError).toBe(false)
    const rows = out.body.results as ReadonlyArray<Record<string, unknown>>
    expect(rows.map(r => r.verdict)).toEqual(['created', 'created'])
    // The commit's evidence trailers: the kind, the 出处, and no memory citation.
    const trailers = await h.recorder.readTrailers(String(out.body.commit))
    expect(trailers.Evidence).toBe('source')
    expect(trailers['Evidence-Source']).toContain('ch_id')
    expect(trailers.Memory).toBeUndefined()
    // Both concepts are in the fact layer, aliases and properties as written.
    expect(h.core.loadConceptDefinition('二级渠道')).toMatchObject({ alt_labels: ['2渠'] })
    expect(h.core.loadConceptDefinition('一级渠道')).toMatchObject({ alt_labels: ['1渠'] })
  })
})

// ── ② user-stated: direct promotion, kind trailer only ───────────────────────

describe('promotion — ② user-stated', () => {
  it('add_alias with user-stated evidence lands with the kind trailer and neither companion', async () => {
    h = await buildIntentToolHarness()
    const version = h.core.loadTableDefinitionWithVersion('dws_order')?.version
    if (version === undefined) throw new Error('fixture table missing')
    const out = toolOutcome(await h.client.callTool('add_alias', {
      scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      labels: ['订单宽表'],
      summary: '用户口述别名晋升',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: version,
      evidence: { kind: 'user-stated' },
    }))
    expect(out.isError).toBe(false)
    const trailers = await h.recorder.readTrailers(String(out.body.commit))
    expect(trailers.Evidence).toBe('user-stated')
    expect(trailers['Evidence-Source']).toBeUndefined()
    expect(trailers.Memory).toBeUndefined()
    expect(h.core.loadTableDefinition('dws_order')?.alt_labels).toContain('订单宽表')
  })
})

// ── ③ replicated: the guard, the trailers, the same-commit back-pointer ──────

describe('promotion — ③ replicated', () => {
  it('promotes over two cross-session cross-day memories: ONE commit carries the alias write and both promoted appends (ADR-0023 R6)', async () => {
    corpus = createFixtureCorpus()
    // Session A records, session B re-records the same conclusion (replication
    // evidence is never deduplicated), the days are re-stamped apart.
    const a = await buildIntentToolHarness({ corpusRoot: corpus.root, sessionId: 'session-a' })
    const idA = await recordOneMemory(a, [{ type: 'observation', anchors: ['dws_order'], body: 'join 后行数 877 vs 873。', valid_from: '2026-10-13', valid_until: '2026-10-13' }])
    await a.close()
    const b = await buildIntentToolHarness({ corpusRoot: corpus.root, sessionId: 'session-b' })
    const idB = await recordOneMemory(b, [{ type: 'observation', anchors: ['dws_order'], body: 'join 后行数 877 vs 873。', valid_from: '2026-10-14', valid_until: '2026-10-14' }])
    await b.close()
    commitRestamps(corpus.root, [
      { id: idA, at: '2026-10-13T09:00:00.000Z' },
      { id: idB, at: '2026-10-14T22:00:00.000Z' },
    ])

    // Session C promotes the replicated conclusion into the fact layer.
    const c = await buildIntentToolHarness({ corpusRoot: corpus.root, sessionId: 'session-c' })
    h = c
    const version = c.core.loadTableDefinitionWithVersion('dws_order')?.version
    if (version === undefined) throw new Error('fixture table missing')
    const out = toolOutcome(await c.client.callTool('add_alias', {
      scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      labels: ['订单表'],
      summary: '复现晋升:两次独立观测同结论',
      derivation: 'agent',
      confidence: 0.85,
      expected_version: version,
      evidence: { kind: 'replicated', memories: [idA, idB] },
    }))
    expect(out.isError).toBe(false)
    // The trailers: the kind and the citation, no 出处 companion.
    const trailers = await c.recorder.readTrailers(String(out.body.commit))
    expect(trailers.Evidence).toBe('replicated')
    expect(trailers.Memory).toBe(`${idA} ${idB}`)
    expect(trailers['Evidence-Source']).toBeUndefined()
    // ONE commit carries the fact-layer write AND both memory files (the
    // same-commit rule): the commit's file list names all three.
    const files = fixtureGit(['show', '--name-only', '--format=', String(out.body.commit)], corpus.root).split('\n').filter(f => f !== '')
    expect(files).toEqual(expect.arrayContaining([`memory/${idA}.yaml`, `memory/${idB}.yaml`, 'tables/dws_order.yaml']))
    // Each counting memory gained the server-written back-pointer — object
    // identity only, stamped with the promoting session.
    for (const id of [idA, idB]) {
      const promoted = readMemory(corpus.root, id).promoted as ReadonlyArray<Record<string, unknown>>
      expect(promoted).toHaveLength(1)
      expect(promoted[0]).toMatchObject({ to: 'table:dws_order', session: 'session-c' })
      expect(typeof promoted[0]?.at).toBe('string')
    }
    expect(c.core.loadTableDefinition('dws_order')?.alt_labels).toContain('订单表')
  })

  it('a contested citation refuses whole-call (promotion_rejected −31026, reason contested), nothing written (ADR-0027 R6)', async () => {
    corpus = createFixtureCorpus()
    const a = await buildIntentToolHarness({ corpusRoot: corpus.root, sessionId: 'session-a' })
    const x = await recordOneMemory(a, [{ type: 'observation', anchors: ['dws_order'], body: '无放大。', valid_from: '2026-10-01', valid_until: '2026-10-10' }])
    await a.close()
    const b = await buildIntentToolHarness({ corpusRoot: corpus.root, sessionId: 'session-b' })
    const y = await recordOneMemory(b, [{ type: 'observation', anchors: ['dws_order'], body: '3x 放大。', valid_from: '2026-09-01', valid_until: '2026-09-30', contradicts: [x] }])
    const z = await recordOneMemory(b, [{ type: 'observation', anchors: ['dws_order'], body: '另一条同结论。', valid_from: '2026-10-05', valid_until: '2026-10-05' }])
    await b.close()
    commitRestamps(corpus.root, [
      { id: x, at: '2026-10-01T09:00:00.000Z' },
      { id: y, at: '2026-09-15T09:00:00.000Z' },
      { id: z, at: '2026-10-05T09:00:00.000Z' },
    ])

    const c = await buildIntentToolHarness({ corpusRoot: corpus.root, sessionId: 'session-c' })
    h = c
    const headBefore = fixtureGit(['rev-parse', 'HEAD'], corpus.root)
    const version = c.core.loadTableDefinitionWithVersion('dws_order')?.version
    if (version === undefined) throw new Error('fixture table missing')
    const out = toolOutcome(await c.client.callTool('add_alias', {
      scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      labels: ['不应落地'],
      summary: '引用争议条目的晋升',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: version,
      evidence: { kind: 'replicated', memories: [x, z] },
    }))
    expect(out.isError).toBe(true)
    expect(out.body.code).toBe(-31026)
    expect((out.body.data as Record<string, unknown>).reason).toBe('contested')
    // Actionable: the message names the contested pair.
    expect(out.body.message).toContain(x)
    expect(out.body.message).toContain(y)
    // Nothing written: no commit, no alias, no back-pointer.
    expect(fixtureGit(['rev-parse', 'HEAD'], corpus.root)).toBe(headBefore)
    expect(c.core.loadTableDefinition('dws_order')?.alt_labels).not.toContain('不应落地')
    expect(readMemory(corpus.root, x).promoted).toBeUndefined()
  })

  it('a same-session citation set refuses with reason same_session through the wire', async () => {
    corpus = createFixtureCorpus()
    const a = await buildIntentToolHarness({ corpusRoot: corpus.root, sessionId: 'session-a' })
    const p = await recordOneMemory(a, [{ type: 'observation', anchors: ['dws_order'], body: '第一条。', valid_from: '2026-10-01', valid_until: '2026-10-01' }])
    const q = await recordOneMemory(a, [{ type: 'observation', anchors: ['dws_order'], body: '第二条。', valid_from: '2026-10-02', valid_until: '2026-10-02' }])
    commitRestamps(corpus.root, [
      { id: p, at: '2026-10-01T09:00:00.000Z' },
      { id: q, at: '2026-10-02T09:00:00.000Z' },
    ])
    h = a
    const headBefore = fixtureGit(['rev-parse', 'HEAD'], corpus.root)
    const version = a.core.loadTableDefinitionWithVersion('dws_order')?.version
    if (version === undefined) throw new Error('fixture table missing')
    const out = toolOutcome(await a.client.callTool('add_alias', {
      scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      labels: ['不应落地'],
      summary: '同会话两条的晋升',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: version,
      evidence: { kind: 'replicated', memories: [p, q] },
    }))
    expect(out.isError).toBe(true)
    expect(out.body.code).toBe(-31026)
    expect((out.body.data as Record<string, unknown>).reason).toBe('same_session')
    expect(fixtureGit(['rev-parse', 'HEAD'], corpus.root)).toBe(headBefore)
  })
})

// ── The input door: the cross-kind rules reject at the schema ────────────────

describe('promotion — the evidence input door', () => {
  it('kind source without `source`, and memories on a non-replicated kind, are rejected as invalid input', async () => {
    h = await buildIntentToolHarness()
    const version = h.core.loadTableDefinitionWithVersion('dws_order')?.version
    if (version === undefined) throw new Error('fixture table missing')
    // The SDK's own zod door answers these (not the handler), so the result
    // text is prose, not the coded JSON body `toolOutcome` parses — read the
    // raw envelope and assert the rejection names the `evidence` field.
    const noSource = await h.client.callTool('add_alias', {
      scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      labels: ['订单宽表'],
      summary: '缺出处的 source 晋升',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: version,
      evidence: { kind: 'source' },
    })
    const noSourceShape = noSource.result as { readonly isError?: boolean; readonly content?: ReadonlyArray<{ readonly text?: string }> } | undefined
    expect(noSource.error).toBeUndefined()
    expect(noSourceShape?.isError).toBe(true)
    expect(noSourceShape?.content?.[0]?.text).toContain('evidence')

    const strayMemories = await h.client.callTool('add_alias', {
      scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      labels: ['订单宽表'],
      summary: '非 replicated 带 memories',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: version,
      evidence: { kind: 'user-stated', memories: ['mem-20260101-aaaaaaaa'] },
    })
    const strayShape = strayMemories.result as { readonly isError?: boolean; readonly content?: ReadonlyArray<{ readonly text?: string }> } | undefined
    expect(strayMemories.error).toBeUndefined()
    expect(strayShape?.isError).toBe(true)
    expect(strayShape?.content?.[0]?.text).toContain('evidence')
    // Neither call wrote: the alias never landed.
    expect(h.core.loadTableDefinition('dws_order')?.alt_labels).not.toContain('订单宽表')
  })
})

// ── The remaining three write tools' wire arms (#198 D: 2/5 → 5/5) ────────────
//
// import_definitions / add_alias are covered above; these complete the
// five-tool evidence door. Each carries at least one ① source and one ②
// user-stated arm over the wire (③ replicated's refusal semantics are pinned
// above; add_relation additionally gets one positive ③ arm because its
// promotion target is the canonical EDGE — the one `to` whose spelling the
// substrate's `edgeAnchorOf` seam (#198 A) now single-sources).

describe('promotion — create_definition over the wire', () => {
  it('table branch with ① source evidence: the kind + 出处 trailers, no citation, the definition landed', async () => {
    h = await buildIntentToolHarness()
    const out = toolOutcome(await h.client.callTool('create_definition', {
      scope_id: 'fixture',
      kind: 'table',
      table: fixtureTable({
        table_name: 'dws_promo_src',
        kind: 'dws',
        columns: [
          { name: 'shop_id', type: 'string', role: 'dimension', comment: '' },
          { name: 'pay_amt', type: 'double', role: 'measure', comment: '' },
        ],
      }),
      summary: '按 DDL 建宽表',
      derivation: 'agent',
      confidence: 0.9,
      evidence: { kind: 'source', source: 'DDL: dws_promo_src 建表语句' },
    }))
    expect(out.isError).toBe(false)
    const trailers = await h.recorder.readTrailers(String(out.body.commit))
    expect(trailers.Evidence).toBe('source')
    expect(trailers['Evidence-Source']).toContain('DDL')
    expect(trailers.Memory).toBeUndefined()
    expect(h.core.loadTableDefinition('dws_promo_src')).not.toBeNull()
  })

  it('concept branch with ② user-stated evidence: the kind trailer only', async () => {
    h = await buildIntentToolHarness()
    const out = toolOutcome(await h.client.callTool('create_definition', {
      scope_id: 'fixture',
      kind: 'concept',
      concept: { name: '夜间口径', description: '自然日 0 点后的订单口径。', alt_labels: ['夜单'] },
      summary: '用户口述术语',
      derivation: 'agent',
      confidence: 0.85,
      evidence: { kind: 'user-stated' },
    }))
    expect(out.isError).toBe(false)
    const trailers = await h.recorder.readTrailers(String(out.body.commit))
    expect(trailers.Evidence).toBe('user-stated')
    expect(trailers['Evidence-Source']).toBeUndefined()
    expect(trailers.Memory).toBeUndefined()
    expect(h.core.loadConceptDefinition('夜间口径')).toMatchObject({ alt_labels: ['夜单'] })
  })
})

describe('promotion — update_definition over the wire', () => {
  it('① source and ② user-stated land with their trailers, the baseline re-read between writes', async () => {
    h = await buildIntentToolHarness()
    const v1 = h.core.loadTableDefinitionWithVersion('dws_order')?.version
    if (v1 === undefined) throw new Error('fixture table missing')
    const first = toolOutcome(await h.client.callTool('update_definition', {
      scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      fields: { description: '按口径文档修订的描述。' },
      expected_version: v1,
      summary: '口径文档修订',
      derivation: 'agent',
      confidence: 0.9,
      evidence: { kind: 'source', source: '口径文档 v2 §3' },
    }))
    expect(first.isError).toBe(false)
    const t1 = await h.recorder.readTrailers(String(first.body.commit))
    expect(t1.Evidence).toBe('source')
    expect(t1['Evidence-Source']).toContain('口径文档')
    expect(t1.Memory).toBeUndefined()
    // Re-read the baseline rather than reuse the receipt's version: the write
    // itself (and, on a DWS, the on-write hook's derived dimension_refs after
    // it) moved the file past the sha the receipt stamped.
    const v2 = h.core.loadTableDefinitionWithVersion('dws_order')?.version
    if (v2 === undefined || v2 === v1) throw new Error('version did not move')
    const second = toolOutcome(await h.client.callTool('update_definition', {
      scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      fields: { description: '用户当面给出的描述。' },
      expected_version: v2,
      summary: '用户口述修订',
      derivation: 'agent',
      confidence: 0.85,
      evidence: { kind: 'user-stated' },
    }))
    expect(second.isError).toBe(false)
    const t2 = await h.recorder.readTrailers(String(second.body.commit))
    expect(t2.Evidence).toBe('user-stated')
    expect(t2['Evidence-Source']).toBeUndefined()
    expect(t2.Memory).toBeUndefined()
    expect(h.core.loadTableDefinition('dws_order')?.description).toBe('用户当面给出的描述。')
  })
})

describe('promotion — add_relation over the wire', () => {
  it('① source / ② user-stated land with their trailers and both joins on the definition', async () => {
    h = await buildIntentToolHarness()
    const v1 = h.core.loadTableDefinitionWithVersion('dws_order')?.version
    if (v1 === undefined) throw new Error('fixture table missing')
    const first = toolOutcome(await h.client.callTool('add_relation', {
      scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      relations: [{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
      summary: '按主键补 join',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: v1,
      evidence: { kind: 'source', source: 'DDL: dim_shop 主键 shop_id' },
    }))
    expect(first.isError).toBe(false)
    const t1 = await h.recorder.readTrailers(String(first.body.commit))
    expect(t1.Evidence).toBe('source')
    expect(t1['Evidence-Source']).toContain('DDL')
    expect(t1.Memory).toBeUndefined()
    // A second, DIFFERENT join carries the ② arm — re-asserting the same
    // relation would be idempotent, and an idempotent-only batch makes no
    // commit for the trailers to ride.
    const created = toolOutcome(await h.client.callTool('create_definition', {
      scope_id: 'fixture',
      kind: 'table',
      table: fixtureTable({
        table_name: 'dim_region',
        kind: 'dim',
        primary_key: ['shop_id'],
        label_columns: ['region_name'],
        columns: [
          { name: 'shop_id', type: 'string', role: 'dimension', comment: '' },
          { name: 'region_name', type: 'string', role: 'dimension', comment: '' },
        ],
      }),
      summary: '建第二维表',
      derivation: 'agent',
      confidence: 0.9,
    }))
    if (created.isError) throw new Error(`create_definition failed: ${JSON.stringify(created.body)}`)
    const v2 = h.core.loadTableDefinitionWithVersion('dws_order')?.version
    if (v2 === undefined) throw new Error('fixture table missing')
    const second = toolOutcome(await h.client.callTool('add_relation', {
      scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      relations: [{ dim_table: 'dim_region', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
      summary: '用户口述 join',
      derivation: 'agent',
      confidence: 0.85,
      expected_version: v2,
      evidence: { kind: 'user-stated' },
    }))
    expect(second.isError).toBe(false)
    const t2 = await h.recorder.readTrailers(String(second.body.commit))
    expect(t2.Evidence).toBe('user-stated')
    expect(t2['Evidence-Source']).toBeUndefined()
    expect(t2.Memory).toBeUndefined()
    expect((h.core.loadTableDefinition('dws_order')?.dimension_refs ?? []).map(r => r.dim_table)).toEqual(['dim_shop', 'dim_region'])
  })

  it('③ replicated names the canonical EDGE in its back-pointer — asserted against edgeAnchorOf (#198 A)', async () => {
    corpus = createFixtureCorpus()
    // The edge must exist before anything can anchor on it (the write door
    // refuses a dangling NEW anchor): session A lands the join plainly, then
    // records the first observation ON the edge.
    const a = await buildIntentToolHarness({ corpusRoot: corpus.root, sessionId: 'session-a' })
    const va = a.core.loadTableDefinitionWithVersion('dws_order')?.version
    if (va === undefined) throw new Error('fixture table missing')
    const landed = toolOutcome(await a.client.callTool('add_relation', {
      scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      relations: [{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
      summary: '补 join',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: va,
    }))
    if (landed.isError) throw new Error(`add_relation failed: ${JSON.stringify(landed.body)}`)
    const idA = await recordOneMemory(a, [{ type: 'observation', anchors: ['table:dws_order -joins-> table:dim_shop'], body: 'join 后行数 877 vs 873。', valid_from: '2026-10-13', valid_until: '2026-10-13' }])
    await a.close()
    const b = await buildIntentToolHarness({ corpusRoot: corpus.root, sessionId: 'session-b' })
    const idB = await recordOneMemory(b, [{ type: 'observation', anchors: ['table:dws_order -joins-> table:dim_shop'], body: 'join 后行数 877 vs 873。', valid_from: '2026-10-14', valid_until: '2026-10-14' }])
    await b.close()
    commitRestamps(corpus.root, [
      { id: idA, at: '2026-10-13T09:00:00.000Z' },
      { id: idB, at: '2026-10-14T22:00:00.000Z' },
    ])
    // Session C re-asserts the SAME relation — idempotent as a fact-layer
    // write, but the edge object is still affirmed (#136: `added` and
    // `idempotent` both promote), so the back-pointer names the edge anyway.
    const c = await buildIntentToolHarness({ corpusRoot: corpus.root, sessionId: 'session-c' })
    h = c
    const vc = c.core.loadTableDefinitionWithVersion('dws_order')?.version
    if (vc === undefined) throw new Error('fixture table missing')
    const out = toolOutcome(await c.client.callTool('add_relation', {
      scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      relations: [{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
      summary: '复现晋升:两次独立观测同结论',
      derivation: 'agent',
      confidence: 0.85,
      expected_version: vc,
      evidence: { kind: 'replicated', memories: [idA, idB] },
    }))
    expect(out.isError).toBe(false)
    expect((out.body.results as ReadonlyArray<{ outcome: string }>)[0]).toMatchObject({ outcome: 'idempotent' })
    const trailers = await c.recorder.readTrailers(String(out.body.commit))
    expect(trailers.Evidence).toBe('replicated')
    expect(trailers.Memory).toBe(`${idA} ${idB}`)
    // ADR-0023 R6: object identity includes edges — the promotion target is
    // the canonical edge string, asserted against the substrate seam's own
    // output rather than a hand copy of the spelling.
    const edge = edgeAnchorOf('table:dws_order', 'joins', 'table:dim_shop')
    for (const id of [idA, idB]) {
      const promoted = readMemory(corpus.root, id).promoted as ReadonlyArray<Record<string, unknown>>
      expect(promoted).toHaveLength(1)
      expect(promoted[0]).toMatchObject({ to: edge, session: 'session-c' })
      expect(typeof promoted[0]?.at).toBe('string')
    }
  })
})

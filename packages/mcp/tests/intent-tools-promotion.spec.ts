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
import { buildIntentToolHarness, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
import { createFixtureCorpus, fixtureGit, type FixtureCorpus } from './helpers/fixture-corpus.ts'
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

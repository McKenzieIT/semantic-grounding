/**
 * `_guidance` — #56 implementing #55's five-phase model (the ticket's own body
 * shipped a placeholder three-value spec; a comment posted after #55 closed
 * supersedes it with the real model this file tests).
 *
 * `maybeGuidance` is unit-tested directly against a stubbed snapshot — the only
 * way to reach DW's `seeding` phase and to control the enrichment-work queue
 * independently of a real corpus scan. The wiring is tested end-to-end through
 * the real tool surface, where the fixture's floor of two tables (with their DIM
 * join / alt_labels not yet filled in) means DW starts life in `backfill` and KG
 * — zero concepts — starts in `seeding`, so the base fixture already exercises
 * the "report whichever layer is more behind" rule (#55 R8) without any setup.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ScopeBinding } from '../src/binding.ts'
import { GUIDANCE_TOOL_NAMES } from '../src/tools/audited.ts'
import {
  DEFAULT_DW_THRESHOLD,
  DEFAULT_KG_THRESHOLD,
  evaluateLayers,
  guidanceFromEvaluation,
  maybeGuidance,
  type Guidance,
  type LayersEvaluation,
} from '../src/tools/guidance.ts'
import { playbookFromEvaluation } from '../src/tools/playbook.ts'
import { buildIntentToolHarness, tier2, versionOf, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
import { toolJson } from './helpers/inprocess-client.ts'

/** A snapshot stub carrying only what the evaluation reads (`evaluateLayers`,
 * #121 — the same surface `maybeGuidance` ever read): a flat node list (DW nodes
 * get an arbitrary non-`'concept'` kind, mirroring a table's open storage-kind
 * string) and a controllable enrichment-work total. */
function fakeSnapshot(opts: { readonly dw: number; readonly kg: number; readonly dwWorkTotal?: number }): ScopeBinding {
  const nodes = [
    ...Array.from({ length: opts.dw }, () => ({ kind: 'dws' })),
    ...Array.from({ length: opts.kg }, () => ({ kind: 'concept' })),
  ]
  return {
    core: {
      projectGraphNodes: () => nodes,
      listEnrichmentWork: async () => ({ work: [], total: opts.dwWorkTotal ?? 0, truncated: false }),
    },
  } as unknown as ScopeBinding
}

describe('maybeGuidance', () => {
  it('is seeding on both layers at zero definitions, tie-broken to DW\'s hint', async () => {
    const g = await maybeGuidance(fakeSnapshot({ dw: 0, kg: 0 }))
    expect(g).toMatchObject({
      phase: 'seeding',
      metrics: { dw: { count: 0, phase: 'seeding' }, kg: { count: 0, phase: 'seeding' } },
    })
    expect(g?.hint).toContain('数据仓库层(DW)')
  })

  it('reports KG seeding as the laggard over DW llm_supplement', async () => {
    const g = await maybeGuidance(fakeSnapshot({ dw: 5, kg: 0, dwWorkTotal: 0 }))
    expect(g).toMatchObject({
      phase: 'seeding',
      metrics: { dw: { count: 5, phase: 'llm_supplement' }, kg: { count: 0, phase: 'seeding' } },
    })
    expect(g?.hint).toContain('知识图谱层(KG)')
  })

  it('reports DW backfill as the laggard once KG is mature', async () => {
    const g = await maybeGuidance(fakeSnapshot({ dw: 5, kg: 5, dwWorkTotal: 3 }))
    expect(g).toMatchObject({
      phase: 'backfill',
      metrics: { dw: { count: 5, phase: 'backfill' }, kg: { count: 5, phase: 'mature' } },
    })
    expect(g?.hint).toContain('数据仓库层(DW)')
    expect(g?.hint).toContain('get_enrichment_work')
  })

  it('is undefined once both layers are mature at the default thresholds', async () => {
    expect(await maybeGuidance(fakeSnapshot({ dw: DEFAULT_DW_THRESHOLD, kg: DEFAULT_KG_THRESHOLD, dwWorkTotal: 0 }))).toBeUndefined()
  })

  it('seeding wins over any threshold override — a zero count is never "mature"', async () => {
    const g = await maybeGuidance(fakeSnapshot({ dw: 0, kg: 0 }), { dw: 0, kg: 0 })
    expect(g).toMatchObject({ metrics: { dw: { phase: 'seeding' }, kg: { phase: 'seeding' } } })
  })

  it('honors a custom per-layer threshold override', async () => {
    // Same counts, no override: default DW threshold (50) is nowhere near met.
    const atDefault = await maybeGuidance(fakeSnapshot({ dw: 3, kg: 5, dwWorkTotal: 0 }))
    expect(atDefault).toMatchObject({ phase: 'llm_supplement', metrics: { dw: { phase: 'llm_supplement' } } })
    // Override dw's threshold down to 3: the same count now reads as mature.
    expect(await maybeGuidance(fakeSnapshot({ dw: 3, kg: 5, dwWorkTotal: 0 }), { dw: 3 })).toBeUndefined()
  })
})

// ── #121: the single evaluation, and the two renderers it feeds ────────────────────

describe('evaluateLayers — the single evaluation (#121)', () => {
  it('scans the enrichment-work index exactly once — the one whole-corpus read both tools share', async () => {
    let scans = 0
    const snap = {
      core: {
        projectGraphNodes: () => [{ kind: 'dws' }, { kind: 'dws' }],
        listEnrichmentWork: async () => { scans += 1; return { work: [], total: 3, truncated: false } },
      },
    } as unknown as ScopeBinding
    const e = await evaluateLayers(snap)
    expect(scans).toBe(1)
    // The one scan fed both consumers of it: the phase decision...
    expect(e.dw.phase).toBe('backfill')
    // ...and the total the playbook's summary/coverage numbers ride on.
    expect(e.workRemaining).toBe(3)
  })

  it('resolves each layer to the threshold actually in effect — the only ?? DEFAULT application', async () => {
    const atDefault = await evaluateLayers(fakeSnapshot({ dw: 3, kg: 5, dwWorkTotal: 0 }))
    expect(atDefault.dw).toEqual({ count: 3, phase: 'llm_supplement', threshold: DEFAULT_DW_THRESHOLD })
    expect(atDefault.kg).toEqual({ count: 5, phase: 'mature', threshold: DEFAULT_KG_THRESHOLD })
    const overridden = await evaluateLayers(fakeSnapshot({ dw: 3, kg: 5, dwWorkTotal: 0 }), { dw: 3, kg: 6 })
    expect(overridden.dw).toEqual({ count: 3, phase: 'mature', threshold: 3 })
    expect(overridden.kg).toEqual({ count: 5, phase: 'llm_supplement', threshold: 6 })
  })

  it('judges the laggard once — ties read as DW', async () => {
    expect((await evaluateLayers(fakeSnapshot({ dw: 0, kg: 0 }))).laggard).toBe('dw')
    expect((await evaluateLayers(fakeSnapshot({ dw: 5, kg: 0, dwWorkTotal: 0 }))).laggard).toBe('kg')
    expect((await evaluateLayers(fakeSnapshot({ dw: 2, kg: 5, dwWorkTotal: 3 }))).laggard).toBe('dw')
  })
})

describe('the two renderers agree on one shared evaluation (#121 primary equivalence defense)', () => {
  /** Drive BOTH renderers from the SAME evaluation object and demand every phase
   * key matches — the fork #121 closed (playbook composing its own thresholds,
   * laggard rule, and scan) cannot reopen without this going red:
   * `overall_phase` vs `_guidance.phase`, `layers.*.phase` vs `metrics.*.phase`,
   * and the both-mature edge, where `_guidance` goes zero-tax and the playbook
   * reports mature outright. */
  function assertRenderersAgree(e: LayersEvaluation): void {
    const g = guidanceFromEvaluation(e)
    const pb = playbookFromEvaluation(e, { id: 'fixture', root: '/corpus' })
    if (g === undefined) {
      expect(pb.overall_phase).toBe('mature')
      expect(pb.layers.dw.phase).toBe('mature')
      expect(pb.layers.kg.phase).toBe('mature')
      return
    }
    expect(pb.overall_phase).toBe(g.phase)
    expect(pb.layers.dw.phase).toBe(g.metrics.dw.phase)
    expect(pb.layers.kg.phase).toBe(g.metrics.kg.phase)
  }

  it('agrees across the reachable state space — ties, either laggard, and both-mature', async () => {
    const states: ReadonlyArray<{ readonly dw: number; readonly kg: number; readonly dwWorkTotal?: number }> = [
      { dw: 0, kg: 0 },                                                       // both seeding, tie -> DW
      { dw: 5, kg: 0, dwWorkTotal: 0 },                                       // KG seeding is the laggard
      { dw: 2, kg: 0, dwWorkTotal: 3 },                                       // DW backfill is the laggard
      { dw: 5, kg: 5, dwWorkTotal: 3 },                                       // DW backfill over KG mature
      { dw: 3, kg: 1, dwWorkTotal: 0 },                                       // both llm_supplement, tie -> DW
      { dw: DEFAULT_DW_THRESHOLD, kg: DEFAULT_KG_THRESHOLD, dwWorkTotal: 0 }, // both mature, _guidance zero-tax
    ]
    for (const s of states) assertRenderersAgree(await evaluateLayers(fakeSnapshot(s)))
  })

  it('agrees under threshold overrides too — the effective thresholds are the evaluation\'s, once', async () => {
    assertRenderersAgree(await evaluateLayers(fakeSnapshot({ dw: 3, kg: 5, dwWorkTotal: 0 }), { dw: 3 }))
    assertRenderersAgree(await evaluateLayers(fakeSnapshot({ dw: 0, kg: 5, dwWorkTotal: 0 }), { dw: 3, kg: 6 }))
  })
})

let h: IntentToolHarness | undefined
afterEach(() => h?.close())

// #108's convergence: wiring used to be pinned per tool — seven hand-rolled
// assertions, one per write tool, each re-describing the same injection. The
// envelope (`writeReceipt`, tools/audited.ts) made the injection ONE piece of
// code, so the wiring is now pinned twice: once through the real surface (any
// guidance-carrying tool responds with `_guidance`), and once at the
// membership list itself — the explicit 7-name roster the envelope gates on.
describe('_guidance wiring — the write envelope, pinned once', () => {
  it('a write tool\'s response carries _guidance through the envelope (KG\'s empty concept layer is the laggard)', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('create_definition', { scope_id: 'fixture',
      kind: 'table',
      table: { table_name: 'dws_third', partitions: [{ name: 'ds', type: 'string' }], columns: [] },
      ...tier2('第三张表', 0.9),
    })
    const body = toolJson(res) as { _guidance?: Guidance }
    expect(body._guidance).toMatchObject({ phase: 'seeding', metrics: { dw: { count: 3 }, kg: { count: 0, phase: 'seeding' } } })
  })

  it('membership is the explicit 7-name roster — the enrichment verbs and read tools are not on it', () => {
    expect(GUIDANCE_TOOL_NAMES).toEqual([
      'create_definition', 'update_definition',
      'add_alias', 'remove_alias', 'add_relation', 'remove_relation',
      'import_definitions',
    ])
  })

  it('read tools never carry _guidance', async () => {
    h = await buildIntentToolHarness()
    const body = toolJson(await h.client.callTool('get_definition', { kind: 'table', name: 'dws_order' }))
    expect(body).not.toHaveProperty('_guidance')
  })
})

describe('_guidance — DW progress, observed through metrics while KG stays the reported laggard', () => {
  it('DW moves backfill -> llm_supplement as its enrichment gaps are closed by hand', async () => {
    h = await buildIntentToolHarness({ guidanceThreshold: { dw: 3 } })

    const r1 = toolJson(await h.client.callTool('add_alias', { scope_id: 'fixture',
      kind: 'table', name: 'dim_shop', labels: ['店铺维度'],
      ...tier2('补别名', 0.9), expected_version: await versionOf(h, 'dim_shop'),
    })) as { _guidance?: Guidance }
    expect(r1._guidance).toMatchObject({ phase: 'seeding', metrics: { dw: { count: 2, phase: 'backfill' } } })

    const r2 = toolJson(await h.client.callTool('add_alias', { scope_id: 'fixture',
      kind: 'table', name: 'dws_order', labels: ['订单宽表'],
      ...tier2('补别名', 0.9), expected_version: await versionOf(h, 'dws_order'),
    })) as { _guidance?: Guidance }
    expect(r2._guidance).toMatchObject({ phase: 'seeding', metrics: { dw: { count: 2, phase: 'backfill' } } })

    const r3 = toolJson(await h.client.callTool('add_relation', { scope_id: 'fixture',
      kind: 'table', name: 'dws_order',
      relations: [{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
      ...tier2('补关联，清空确定性缺口', 0.9), expected_version: await versionOf(h, 'dws_order'),
    })) as { _guidance?: Guidance }
    // The enrichment-work queue is now empty: DW exits backfill for llm_supplement
    // (count 2 is still below the overridden threshold of 3) — KG (seeding, rank 0)
    // is still more behind, so the top-level phase has not moved, but `metrics.dw`
    // shows the real progress underneath it.
    expect(r3._guidance).toMatchObject({ phase: 'seeding', metrics: { dw: { count: 2, phase: 'llm_supplement' }, kg: { count: 0, phase: 'seeding' } } })
  })
})

describe('_guidance — KG progress, observed as the reported laggard once DW is pinned mature', () => {
  it('KG moves seeding -> llm_supplement -> mature; _guidance vanishes once both layers are', async () => {
    h = await buildIntentToolHarness({ guidanceThreshold: { dw: 2, kg: 2 } })

    // Clear DW's two gaps and give it its one join so the enrichment-work queue
    // empties; at count 2 >= the overridden dw threshold of 2, DW lands on mature
    // and stays there — a fixed ceiling the rest of this test's KG moves are
    // compared against.
    await h.client.callTool('add_alias', { scope_id: 'fixture',
      kind: 'table', name: 'dim_shop', labels: ['店铺维度'],
      ...tier2('补别名', 0.9), expected_version: await versionOf(h, 'dim_shop'),
    })
    await h.client.callTool('add_alias', { scope_id: 'fixture',
      kind: 'table', name: 'dws_order', labels: ['订单宽表'],
      ...tier2('补别名', 0.9), expected_version: await versionOf(h, 'dws_order'),
    })
    const cleared = toolJson(await h.client.callTool('add_relation', { scope_id: 'fixture',
      kind: 'table', name: 'dws_order',
      relations: [{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
      ...tier2('补关联，清空确定性缺口', 0.9), expected_version: await versionOf(h, 'dws_order'),
    })) as { _guidance?: Guidance }
    expect(cleared._guidance).toMatchObject({ phase: 'seeding', metrics: { dw: { count: 2, phase: 'mature' }, kg: { count: 0, phase: 'seeding' } } })

    const firstConcept = toolJson(await h.client.callTool('create_definition', { scope_id: 'fixture',
      kind: 'concept',
      concept: { name: 'gmv', description: '成交总额' },
      ...tier2('首个概念', 0.9),
    })) as { _guidance?: Guidance }
    expect(firstConcept._guidance).toMatchObject({ phase: 'llm_supplement', metrics: { dw: { phase: 'mature' }, kg: { count: 1, phase: 'llm_supplement' } } })
    expect(firstConcept._guidance?.hint).toContain('知识图谱层(KG)')

    const secondConcept = toolJson(await h.client.callTool('create_definition', { scope_id: 'fixture',
      kind: 'concept',
      concept: { name: 'order_count', description: '订单数' },
      ...tier2('第二个概念，跨过 KG 阈值', 0.9),
    })) as { _guidance?: Guidance }
    // Both layers mature now: zero-tax, the key is absent entirely.
    expect(secondConcept).not.toHaveProperty('_guidance')
  })
})

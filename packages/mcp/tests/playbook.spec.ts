/**
 * `get_initialization_playbook` — #63 landing #55's R3/R7/R10/R13 on top of the
 * phase model #56 already shipped (`tools/guidance.ts`).
 *
 * Three groups, in acceptance order:
 *
 * 1. **The reuse contract** (#55's "接口不变" pin, restated in #63's 硬性复用
 *    约束): for the same corpus state, `layers.dw.phase`/`layers.kg.phase` equal
 *    what `_guidance.metrics` reports and `overall_phase` equals `_guidance.phase`.
 *    The comparison is direct — one write captures `_guidance` for the state it
 *    produced, then the playbook reads that same state before anything else
 *    writes — not two separately-tested outputs eyeballed against each other.
 * 2. **R10** — `scope_id` required, never silently re-routed: a missing id dies
 *    at the schema door; an unregistered (or unreachable) id is a *successful*
 *    `scope_registration` answer (R6 phase 1 is the registry's to observe — the
 *    one phase `_guidance` structurally cannot); a registered-but-inactive id is
 *    the −31064 refusal with a `switch_scope` remedy.
 * 3. **The R6 boundary walk** — the full evolution #55 sketched for the e2e gate:
 *    scope_registration → seeding → backfill → llm_supplement → mature, with the
 *    entry/exit conditions of the R6 table as the inputs, and the R3
 *    recommended-action table + R2 coverage indicators asserted at each stop.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Guidance } from '../src/tools/guidance.ts'
import type { InitializationPlaybook, PlaybookPhase } from '../src/tools/playbook.ts'
import { buildIntentToolHarness, tier2, versionOf, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
import { createFixtureCorpus } from './helpers/fixture-corpus.ts'
import { toolJson } from './helpers/inprocess-client.ts'

let h: IntentToolHarness | undefined
afterEach(() => h?.close())

/** Call the playbook tool and parse its body. */
async function playbookOf(scopeId: string): Promise<InitializationPlaybook> {
  if (h === undefined) throw new Error('harness not built')
  return toolJson(await h.client.callTool('get_initialization_playbook', { scope_id: scopeId })) as unknown as InitializationPlaybook
}

/** A parsed coded `isError` result (the `-31xxx` discrimination path #20 ruled). */
async function codedErrorOf(name: string, args: Readonly<Record<string, unknown>>): Promise<{ readonly code: number; readonly data: Record<string, unknown> }> {
  if (h === undefined) throw new Error('harness not built')
  const res = await h.client.callTool(name, args)
  expect(res.error).toBeUndefined()
  expect(res.result?.['isError']).toBe(true)
  return toolJson(res) as { code: number; data: Record<string, unknown> }
}

/** The gap-clearing trio that empties the base fixture's enrichment-work queue
 * (the same writes `guidance.spec.ts` drives, kept identical so the two specs
 * describe one journey, not two). */
async function clearDwGaps(): Promise<void> {
  if (h === undefined) throw new Error('harness not built')
  await h.client.callTool('add_alias', { scope_id: 'fixture', kind: 'table', name: 'dim_shop', alias: '店铺维度', ...tier2('补别名', 0.9), expected_version: await versionOf(h, 'dim_shop') })
  await h.client.callTool('add_alias', { scope_id: 'fixture', kind: 'table', name: 'dws_order', alias: '订单宽表', ...tier2('补别名', 0.9), expected_version: await versionOf(h, 'dws_order') })
  await h.client.callTool('add_relation', { scope_id: 'fixture', kind: 'table', name: 'dws_order', relation: { dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }, ...tier2('补关联，清空确定性缺口', 0.9), expected_version: await versionOf(h, 'dws_order') })
}

// ── 1. The reuse contract: playbook phases ARE _guidance's phases ────────────────────

describe('get_initialization_playbook — phase equivalence with _guidance (the reuse contract)', () => {
  it('same corpus state: layers.dw/kg.phase equal _guidance.metrics, overall_phase equals _guidance.phase', async () => {
    h = await buildIntentToolHarness()
    // The write's response carries _guidance for the state it PRODUCED; the
    // playbook then reads that same state (no write in between).
    const added = toolJson(await h.client.callTool('add_alias', { scope_id: 'fixture',
      kind: 'table', name: 'dws_order', alias: '订单宽表',
      ...tier2('补别名', 0.9), expected_version: await versionOf(h, 'dws_order'),
    })) as { _guidance?: Guidance }
    const pb = await playbookOf('fixture')
    expect(pb.layers.dw.phase).toBe(added._guidance?.metrics.dw.phase)
    expect(pb.layers.kg.phase).toBe(added._guidance?.metrics.kg.phase)
    expect(pb.overall_phase).toBe(added._guidance?.phase)
    // Not vacuous: this state really is DW backfill / KG seeding (the base
    // fixture's floor), so the equivalence has teeth.
    expect(pb.layers.dw.phase).toBe('backfill')
    expect(pb.layers.kg.phase).toBe('seeding')
    expect(pb.overall_phase).toBe('seeding')
  })

  it('equivalence holds mid-journey at overridden thresholds, and at both-mature — where _guidance is absent entirely (zero tax)', async () => {
    h = await buildIntentToolHarness({ guidanceThreshold: { dw: 2, kg: 2 } })
    await clearDwGaps()
    const firstConcept = toolJson(await h.client.callTool('create_definition', { scope_id: 'fixture',
      kind: 'concept', concept: { name: 'gmv', description: '成交总额' },
      ...tier2('首个概念', 0.9),
    })) as { _guidance?: Guidance }
    const mid = await playbookOf('fixture')
    expect(mid.layers.dw.phase).toBe(firstConcept._guidance?.metrics.dw.phase)
    expect(mid.layers.kg.phase).toBe(firstConcept._guidance?.metrics.kg.phase)
    expect(mid.overall_phase).toBe(firstConcept._guidance?.phase)

    const secondConcept = toolJson(await h.client.callTool('create_definition', { scope_id: 'fixture',
      kind: 'concept', concept: { name: 'order_count', description: '订单数' },
      ...tier2('第二个概念，跨过 KG 阈值', 0.9),
    })) as Record<string, unknown>
    // Both layers mature: _guidance's key is absent — the playbook's equivalent
    // statement is both layers reporting mature.
    expect(secondConcept).not.toHaveProperty('_guidance')
    const done = await playbookOf('fixture')
    expect(done.layers.dw.phase).toBe('mature')
    expect(done.layers.kg.phase).toBe('mature')
    expect(done.overall_phase).toBe('mature')
  })
})

// ── 2. R10: scope_id required, per-scope, never silently re-routed ───────────────────

describe('get_initialization_playbook — R10: scope_id is required and never silently re-routed', () => {
  it('a missing scope_id is rejected at the schema door, not defaulted', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('get_initialization_playbook', {})
    // The SDK's own zod door: an isError result naming the missing field (never a
    // silent default to any scope — R10 has no fallback path at all).
    expect(res.error).toBeUndefined()
    expect(res.result?.['isError']).toBe(true)
    const text = (res.result?.['content'] as Array<{ readonly text: string }>)[0]?.text
    expect(text).toContain('scope_id')
  })

  it('an unregistered scope_id is a successful scope_registration answer — R6 phase 1, not an error', async () => {
    h = await buildIntentToolHarness()
    const pb = await playbookOf('ghost')
    expect(pb.overall_phase).toBe('scope_registration')
    expect(pb.scope).toMatchObject({ id: 'ghost', root: null })
    expect(pb.layers.dw.phase).toBe('scope_registration')
    expect(pb.layers.kg.phase).toBe('scope_registration')
    // R3's phase-1 row is shared across layers (scope is corpus-level, R6); the
    // hint is #69's amendment of that row — the naming-confirmation soft
    // guidance (persistent identity), the same sentence the two bootstrap
    // descriptions in `scope.ts` carry.
    expect(pb.layers.dw.recommended_action).toEqual({ tool: 'register_scope', hint: 'scope_id 是持久身份（1:1 绑定 corpus、随每个 Tier-2 commit 进 git trailer、无改名工具）——注册前与用户确认命名' })
    expect(pb.layers.kg.recommended_action).toEqual(pb.layers.dw.recommended_action)
    expect(pb.summary).toMatchObject({ total_definitions: 0, dw_definitions: 0, kg_definitions: 0, enrichment_work_remaining: 0 })
    expect(pb.summary.message).toContain('scope_registration')
  })

  it('a registered-but-unreachable scope also lands scope_registration (R6: 不存在或不可达)', async () => {
    h = await buildIntentToolHarness()
    const goneRoot = join(tmpdir(), 'sg-gone-scope-does-not-exist')
    await h.deps.registry.register({ id: 'gone', semanticRoot: goneRoot, name: 'gone', registeredBy: 'test-agent' })
    const pb = await playbookOf('gone')
    expect(pb.overall_phase).toBe('scope_registration')
    expect(pb.scope.root).toBe(goneRoot)
    expect(pb.summary.message).toContain('不可达')
  })

  it('a registered, reachable, but inactive scope is refused scope_mismatch (-31064) with a switch_scope remedy', async () => {
    h = await buildIntentToolHarness()
    const other = createFixtureCorpus()
    try {
      await h.deps.registry.register({ id: 'other', semanticRoot: other.root, name: 'other', registeredBy: 'test-agent' })
      const payload = await codedErrorOf('get_initialization_playbook', { scope_id: 'other' })
      expect(payload.code).toBe(-31064)
      expect(String(payload.data['remedy'])).toContain('switch_scope')
    } finally {
      other.cleanup()
    }
  })
})

// ── 3. The R6 boundary walk: the full phase evolution ────────────────────────────────

describe('get_initialization_playbook — R6 boundary walk (scope_registration → seeding → backfill → llm_supplement → mature)', () => {
  it('both layers seeding on an empty corpus (entry: 该层定义数 = 0)', async () => {
    // An empty-but-valid corpus: config + the three dirs + a git baseline —
    // built by hand because the fixture always plants dws_order/dim_shop.
    const emptyRoot = mkdtempSync(join(tmpdir(), 'sg-empty-corpus-'))
    try {
      mkdirSync(join(emptyRoot, 'tables'), { recursive: true })
      mkdirSync(join(emptyRoot, 'events'), { recursive: true })
      writeFileSync(join(emptyRoot, 'config.yaml'), 'scope_id: fixture\n', 'utf8')
      const { execFileSync } = await import('node:child_process')
      execFileSync('git', ['init', '--quiet', '--initial-branch=main', '.'], { cwd: emptyRoot })
      execFileSync('git', ['add', '-A'], { cwd: emptyRoot })
      execFileSync('git', ['-c', 'user.name=Fixture Human', '-c', 'user.email=human@fixture.local', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'corpus baseline'], { cwd: emptyRoot })

      h = await buildIntentToolHarness({ corpusRoot: emptyRoot })
      const pb = await playbookOf('fixture')
      expect(pb.overall_phase).toBe('seeding')
      expect(pb.layers.dw).toMatchObject({ phase: 'seeding', coverage: { indicator: 'definitions', current: 0, target: 1 } })
      expect(pb.layers.kg).toMatchObject({ phase: 'seeding', coverage: { indicator: 'definitions', current: 0, target: 1 } })
      // R3's seeding row: import_definitions (DW, #54's not-yet-landed name, copied as
      // ruled) vs create_definition (KG).
      expect(pb.layers.dw.recommended_action).toEqual({ tool: 'import_definitions', hint: '批量导入表和事件定义建立数仓语义层' })
      expect(pb.layers.kg.recommended_action).toEqual({ tool: 'create_definition', hint: '注册游戏实体概念建立知识图谱' })

      // R6's seeding exit: ≥1 definition registered. One table moves DW out — and,
      // per ADR-0014's recorded R1 corollary, a fresh table immediately opens an
      // enrichment-work gap, so DW lands on backfill, not llm_supplement.
      await h.client.callTool('create_definition', { scope_id: 'fixture',
        kind: 'table',
        table: { table_name: 'dws_first', partitions: [{ name: 'ds', type: 'string' }], columns: [] },
        ...tier2('首张表', 0.9),
      })
      const seeded = await playbookOf('fixture')
      expect(seeded.layers.dw.phase).toBe('backfill')
      expect(seeded.layers.kg.phase).toBe('seeding')
      expect(seeded.overall_phase).toBe('seeding')
      expect(seeded.summary).toMatchObject({ dw_definitions: 1, kg_definitions: 0, total_definitions: 1 })
    } finally {
      await h?.close()
      h = undefined
      rmSync(emptyRoot, { recursive: true, force: true })
    }
  })

  it('the fixture journey: DW backfill → llm_supplement → mature and KG seeding → llm_supplement → mature, with the R3 actions at each stop', async () => {
    h = await buildIntentToolHarness({ guidanceThreshold: { dw: 3, kg: 2 } })

    // Stop 0 — DW backfill (entry: work queue non-empty), KG seeding (0 concepts).
    // KG is the more-behind layer, so overall_phase reports seeding. The base
    // fixture's queue is exactly three gaps: dim_shop alt_labels, dws_order
    // dimension_refs, dws_order alt_labels.
    const pb0 = await playbookOf('fixture')
    expect(pb0.layers.dw.phase).toBe('backfill')
    expect(pb0.layers.dw.recommended_action).toEqual({ tool: 'run_enrichment', hint: '运行确定性 enrichment 填充关联和别名' })
    expect(pb0.layers.dw.coverage).toEqual({ indicator: 'enrichment_work_remaining', current: 3, target: 0 })
    expect(pb0.layers.kg.phase).toBe('seeding')
    expect(pb0.overall_phase).toBe('seeding')
    expect(pb0.summary).toMatchObject({ dw_definitions: 2, kg_definitions: 0, total_definitions: 2 })
    expect(pb0.summary.enrichment_work_remaining).toBe(pb0.layers.dw.coverage.current)
    expect(pb0.summary.message).toContain('知识图谱层(KG)')

    // R6's backfill exit: work queue drained (by hand here — run_enrichment's
    // sweep is the tool's own e2e's business). DW lands on llm_supplement
    // (count 2 < the overridden 3); KG still seeding, still the laggard.
    await clearDwGaps()
    const pb1 = await playbookOf('fixture')
    expect(pb1.layers.dw.phase).toBe('llm_supplement')
    expect(pb1.layers.dw).toMatchObject({ coverage: { indicator: 'definitions', current: 2, target: 3 } })
    expect(pb1.layers.dw.recommended_action).toEqual({ tool: 'add_alias / add_relation / update_definition', hint: '补充 enrichment 无法确定性解决的语义 gap' })
    expect(pb1.layers.kg.phase).toBe('seeding')
    expect(pb1.overall_phase).toBe('seeding')
    expect(pb1.summary.enrichment_work_remaining).toBe(0)

    // R6's llm_supplement edges: KG crosses its threshold in two concept moves.
    await h.client.callTool('create_definition', { scope_id: 'fixture',
      kind: 'concept', concept: { name: 'gmv', description: '成交总额' },
      ...tier2('首个概念', 0.9),
    })
    const pb2 = await playbookOf('fixture')
    expect(pb2.layers.kg.phase).toBe('llm_supplement')
    expect(pb2.layers.kg).toMatchObject({ coverage: { indicator: 'definitions', current: 1, target: 2 } })
    expect(pb2.layers.kg.recommended_action).toEqual({ tool: 'create_definition / add_relation', hint: '扩展知识图谱实体和关系' })
    expect(pb2.layers.dw.phase).toBe('llm_supplement')
    expect(pb2.overall_phase).toBe('llm_supplement')

    await h.client.callTool('create_definition', { scope_id: 'fixture',
      kind: 'concept', concept: { name: 'order_count', description: '订单数' },
      ...tier2('第二个概念，跨过 KG 阈值', 0.9),
    })
    const pb3 = await playbookOf('fixture')
    expect(pb3.layers.kg.phase).toBe('mature')
    expect(pb3.layers.kg.recommended_action).toEqual({ tool: null, hint: '语义层初始化完成，持续维护中' })
    expect(pb3.layers.kg.coverage).toMatchObject({ indicator: 'definitions', current: 2, target: 2 })
    // DW (llm_supplement) is now the laggard — R8's same rule, seen from the other side.
    expect(pb3.layers.dw.phase).toBe('llm_supplement')
    expect(pb3.overall_phase).toBe('llm_supplement')
    expect(pb3.summary.message).toContain('数据仓库层(DW)')

    // DW's own mature edge (count reaches the threshold 3): one more table, then
    // clear the two gaps it opens (R1: state is derived live, so the new table
    // first re-enters backfill — ADR-0014's recorded corollary — and drains again).
    await h.client.callTool('create_definition', { scope_id: 'fixture',
      kind: 'table',
      table: { table_name: 'dws_third', partitions: [{ name: 'ds', type: 'string' }], columns: [{ name: 'shop_id', type: 'string', role: 'dimension', comment: '' }] },
      ...tier2('第三张表', 0.9),
    })
    const pb4 = await playbookOf('fixture')
    expect(pb4.layers.dw.phase).toBe('backfill')

    await h.client.callTool('add_relation', { scope_id: 'fixture',
      kind: 'table', name: 'dws_third',
      relation: { dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] },
      ...tier2('补关联，清空确定性缺口', 0.9), expected_version: await versionOf(h, 'dws_third'),
    })
    await h.client.callTool('add_alias', { scope_id: 'fixture',
      kind: 'table', name: 'dws_third', alias: '第三张宽表',
      ...tier2('补别名，清空最后一项缺口', 0.9), expected_version: await versionOf(h, 'dws_third'),
    })
    const pb5 = await playbookOf('fixture')
    expect(pb5.layers.dw.phase).toBe('mature')
    expect(pb5.layers.kg.phase).toBe('mature')
    expect(pb5.overall_phase).toBe('mature')
    expect(pb5.summary.message).toContain('两层均已成熟')
    expect(pb5.summary).toMatchObject({ dw_definitions: 3, kg_definitions: 2, total_definitions: 5, enrichment_work_remaining: 0 })
  })
})

// ── Shape sanity beyond the phases (R7 fields, the scope stamp) ─────────────────────

describe('get_initialization_playbook — R7 shape sanity', () => {
  it('carries the scope stamp and every R7 field, with phases from the five-name set', async () => {
    h = await buildIntentToolHarness()
    const pb = await playbookOf('fixture')
    expect(pb.scope.id).toBe('fixture')
    expect(typeof pb.scope.root).toBe('string')
    expect(pb.scope.root).toBeTruthy()
    const phases: readonly PlaybookPhase[] = ['scope_registration', 'seeding', 'backfill', 'llm_supplement', 'mature']
    for (const layer of [pb.layers.dw, pb.layers.kg]) {
      expect(phases).toContain(layer.phase)
      expect(Object.keys(layer.coverage).sort()).toEqual(['current', 'indicator', 'target'])
      expect(Object.keys(layer.recommended_action).sort()).toEqual(['hint', 'tool'])
      expect(typeof layer.recommended_action.hint).toBe('string')
    }
    expect(Object.keys(pb.summary).sort()).toEqual(['dw_definitions', 'enrichment_work_remaining', 'kg_definitions', 'message', 'total_definitions'])
  })
})

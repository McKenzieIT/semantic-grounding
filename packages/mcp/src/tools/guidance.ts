/**
 * The dynamic guidance injection point — #56 implementing #55's five-phase model.
 * (#56's own ticket body shipped a placeholder three-value spec; a comment posted
 * after #55 closed supersedes it with the real model below — see #56's resolution
 * comment for the correction.)
 *
 * Mechanism: an optional `_guidance` field on exactly the 7 write-tool responses
 * (create_definition, update_definition, add_alias, remove_alias, add_relation,
 * remove_relation, import_definitions — the explicit list `tools/audited.ts`'s
 * `GUIDANCE_TOOL_NAMES` owns), injected by `writeReceipt`, the write envelope's
 * single assembly point (#108). Read tools never get this field.
 *
 * Two layers track independently (#55 R4): DW (tables + events — the text-to-SQL
 * grounding assets) and KG (concepts — the knowledge-graph entity layer). Each
 * layer's phase is one of `seeding` → `backfill` → `llm_supplement` → `mature`.
 * #55's fifth name, `scope_registration`, is dropped from {@link GuidancePhase}:
 * by the time a write-tool handler runs, `requireSnapshot()` already proved the
 * scope is registered, so that phase is structurally unreachable here. `backfill`
 * only exists for DW — concepts have no enrichment rounds at all (ADR-0012, #46)
 * — so KG's sequence skips straight from `seeding` to `llm_supplement`.
 *
 * `_guidance.phase`/`.hint` report whichever layer is **more behind** (#55 R8);
 * `.metrics` carries both layers' own count + phase so a caller sees the full
 * picture, not just the laggard. Trigger (#55 R9): inject while *either* layer
 * hasn't reached `mature` — zero-tax (key absent, not null) once both have, the
 * same convention as `enrichment_health` (`audited.ts`).
 *
 * Maturity thresholds are per-layer and config-overridable (#55 R12):
 * `ServerConfig.guidanceThreshold` is {@link GuidanceThresholds}, defaulting to
 * DW={@link DEFAULT_DW_THRESHOLD} / KG={@link DEFAULT_KG_THRESHOLD} when absent.
 *
 * DW/KG counts come from `projectGraphNodes({includeDerived:false})` — the
 * schema-valid, graph-attached count (a malformed leftover YAML doesn't count as
 * progress), not `binding.ts`'s lenient `scopeCountsOrThrow` (the `switch_scope`
 * landing digest, which counts raw loader output without schema validation). A
 * concept node's `kind` is always the fixed literal `'concept'`
 * (`kinds/concept-kind.ts`); every other registered kind's node — today, a table
 * (whose `kind` is its own open storage kind, e.g. `dim`/`dws`, `kinds/table-kind.ts`)
 * or an event (fixed `'event'`) — is DW by elimination. DW's `backfill` check reads
 * `listEnrichmentWork({})` (no dimension filter = whole corpus), the same
 * deterministic gap index `get_enrichment_work` exposes — scanned exactly once per
 * evaluation, inside {@link evaluateLayers} (#121), which is the only reason it
 * (and therefore {@link maybeGuidance} and the playbook) is async.
 *
 * ## #121: one evaluation, two renderers
 *
 * #63 shared the phase *functions* with `tools/playbook.ts` by exporting them
 * (`layerCounts`/`dwPhase`/`kgPhase`/`PHASE_RANK`), but the playbook then
 * re-composed them — its own threshold-default application, its own copy of the
 * laggard rule, and a second `listEnrichmentWork({})` scan for the summary
 * numbers: a four-way fork the 00 review (#119 Q2) closed. {@link evaluateLayers}
 * is now the single evaluation: both layers' count/phase with the threshold
 * actually in effect, the laggard layer, and the work-queue total from ONE scan.
 * This module renders `_guidance` from it ({@link guidanceFromEvaluation}); the
 * playbook renders `{layers, summary, overall_phase}` from the same object
 * (`playbook.ts`'s `playbookFromEvaluation`). The two prose tables stay —
 * different audiences is a legitimate difference — but no judgment is duplicated
 * anymore: phase, laggard, and thresholds all come from one place, and the
 * equivalence is pinned by a unit assertion that drives both renderers from one
 * shared `LayersEvaluation` (`tests/guidance.spec.ts`). `dwPhase`/`kgPhase`/
 * `PHASE_RANK` went back to module-private with the fold (their export existed
 * for the playbook's own composition); `layerCounts` remains exported —
 * `tools/scope.ts` (#102) is its live consumer — and since #144 the per-kind
 * scan under it, {@link countNodesByKind}, is exported too (`tools/import.ts`'s
 * ratio-guard denominator), the one classification of graph nodes by kind.
 *
 * @module tools/guidance
 */
import type { ScopeBinding } from '../binding.ts'

/**
 * Per-layer maturity thresholds — `ServerConfig.guidanceThreshold`'s shape (#55
 * R12). Each side defaults independently when absent.
 */
export interface GuidanceThresholds {
  readonly dw?: number
  readonly kg?: number
}

/** DW maturity threshold when `GuidanceThresholds.dw` is absent (#55 R12). */
export const DEFAULT_DW_THRESHOLD = 50
/** KG maturity threshold when `GuidanceThresholds.kg` is absent (#55 R12). */
export const DEFAULT_KG_THRESHOLD = 5

/**
 * A layer's progress phase — #55's five names minus the structurally-unreachable
 * `scope_registration` (see this module's doc). `backfill` never appears for KG.
 */
export type GuidancePhase = 'seeding' | 'backfill' | 'llm_supplement' | 'mature'

/** One layer's reading: its raw definition count and derived phase. */
export interface LayerMetrics {
  readonly count: number
  readonly phase: GuidancePhase
}

/** The `_guidance` response field's shape. */
export interface Guidance {
  /** The more-behind of the two layers' phases (#55 R8). */
  readonly phase: GuidancePhase
  /** Free-text, human-readable (Chinese prose, matching existing convention),
   * naming which layer it addresses and the next concrete action. */
  readonly hint: string
  readonly metrics: Readonly<{ dw: LayerMetrics; kg: LayerMetrics }>
}

/** Lower rank = further behind — the single ranking table both tools' phases
 * order by; a second copy could drift into disagreeing with `_guidance` about
 * which layer is the laggard. Module-private since #121 folded its last external
 * reader (`playbook.ts`'s own laggard copy) into {@link evaluateLayers}. */
const PHASE_RANK: Readonly<Record<GuidancePhase, number>> = { seeding: 0, backfill: 1, llm_supplement: 2, mature: 3 }

/** DW's phase: `seeding` (no definitions) → `backfill` (deterministic relation /
 * alias gaps outstanding) → `llm_supplement` (gaps clear, count still below
 * threshold) → `mature` — a pure step over the work total {@link evaluateLayers}
 * already scanned (#121 moved the scan there: through #63/#120 this function
 * scanned for itself and `playbook.ts` scanned a second time for its summary).
 * Module-private since #121; the one phase derivation, shared, never forked. */
function dwPhase(count: number, threshold: number, workRemaining: number): GuidancePhase {
  if (count === 0) return 'seeding'
  if (workRemaining > 0) return 'backfill'
  return count < threshold ? 'llm_supplement' : 'mature'
}

/** KG's phase: `seeding` → `llm_supplement` → `mature` — `backfill` is skipped
 * (concepts have no enrichment rounds at all, ADR-0012/#46). Module-private
 * since #121 (its #63 export existed for the playbook's own composition), same
 * single-derivation rule as {@link dwPhase}. */
function kgPhase(count: number, threshold: number): GuidancePhase {
  if (count === 0) return 'seeding'
  return count < threshold ? 'llm_supplement' : 'mature'
}

/**
 * Per-kind node counts from one schema-valid, graph-attached scan — the
 * classification knowledge's single home (#144): a concept node's `kind` is
 * the fixed literal `'concept'` (`kinds/concept-kind.ts`), an event's is
 * `'event'`, and a table's is its own open storage kind (`dim`/`dws`,
 * `kinds/table-kind.ts`), so tables fall out by elimination. Exported because
 * two projections need different groupings of the same corpus fact: this
 * module's {@link layerCounts} (DW = tables + events vs KG = concepts) and
 * `tools/import.ts`'s ratio guard (ADR-0019 R6), whose denominator is
 * per-kind. `import.ts`'s own count used to be a by-elimination second copy;
 * the trick is documented once, here.
 */
export function countNodesByKind(snap: ScopeBinding): Readonly<Record<'table' | 'event' | 'concept', number>> {
  const nodes = snap.core.projectGraphNodes({ includeDerived: false })
  let tables = 0
  let events = 0
  let concepts = 0
  for (const node of nodes) {
    if (node.kind === 'concept') concepts += 1
    else if (node.kind === 'event') events += 1
    else tables += 1
  }
  return { table: tables, event: events, concept: concepts }
}

/** DW count (tables + events) and KG count (concepts) — a two-line projection
 * of {@link countNodesByKind}, the per-kind single source (#144). Still
 * exported for its own live consumer: `tools/scope.ts` (#102) reads this
 * layer-shaped derivation directly — the one count judgment, shared, never
 * forked. */
export function layerCounts(snap: ScopeBinding): { readonly dw: number; readonly kg: number } {
  const { table, event, concept } = countNodesByKind(snap)
  return { dw: table + event, kg: concept }
}

/** One layer's full evaluation: its metrics plus the threshold that actually
 * judged it — the override when given, #55 R12's default when not. The default
 * application lives in {@link evaluateLayers} alone (#121: the fork this closed
 * was two independent `?? DEFAULT_*` resolutions, one per tool). */
export interface EvaluatedLayer {
  readonly count: number
  readonly phase: GuidancePhase
  readonly threshold: number
}

/** One full corpus evaluation — #121's single judgment object. Both tools'
 * phase keys (and the playbook's coverage/summary numbers) come from here; the
 * renderers that consume it add wording and shape, never judgment. */
export interface LayersEvaluation {
  readonly dw: EvaluatedLayer
  readonly kg: EvaluatedLayer
  /** The more-behind layer (#55 R8): `PHASE_RANK[dw] <= PHASE_RANK[kg]`, the one
   * laggard rule in the package — ties read as DW, where equal phases make the
   * tie irrelevant to the value either renderer reports. */
  readonly laggard: 'dw' | 'kg'
  /** Outstanding deterministic enrichment work items, from the evaluation's one
   * and only `listEnrichmentWork({})` scan — the same total decides DW's
   * `backfill` and feeds the playbook's `enrichment_work_remaining`/coverage. */
  readonly workRemaining: number
}

/**
 * Evaluate both layers from the entry snapshot — #119 Q2's single evaluation
 * function (#121): thresholds resolve to their effective values here (the only
 * `?? DEFAULT_*` in the package), the laggard rule is judged here (the only
 * `PHASE_RANK` comparison), and the work index is scanned here, exactly once
 * (through #120 the guidance path scanned inside `dwPhase` and the playbook
 * scanned a second time for its summary). `guidance.ts` renders `_guidance`
 * from the result ({@link guidanceFromEvaluation}); `tools/playbook.ts` renders
 * its playbook from the same result — that shared object is what the
 * equivalence unit assertion pins.
 * @param snap - the entry snapshot (ADR-0011 ruling 1 — resolved at handler entry).
 * @param thresholds - per-layer overrides; each side defaults independently
 *   ({@link DEFAULT_DW_THRESHOLD}, {@link DEFAULT_KG_THRESHOLD}) when absent.
 */
export async function evaluateLayers(snap: ScopeBinding, thresholds?: GuidanceThresholds): Promise<LayersEvaluation> {
  const dwThreshold = thresholds?.dw ?? DEFAULT_DW_THRESHOLD
  const kgThreshold = thresholds?.kg ?? DEFAULT_KG_THRESHOLD
  const { dw: dwCount, kg: kgCount } = layerCounts(snap)
  // The evaluation's one whole-corpus scan (#121): the same total that decides
  // DW's `backfill` feeds the playbook's summary/coverage numbers.
  const { total: workRemaining } = await snap.core.listEnrichmentWork({})
  const dw: EvaluatedLayer = { count: dwCount, phase: dwPhase(dwCount, dwThreshold, workRemaining), threshold: dwThreshold }
  const kg: EvaluatedLayer = { count: kgCount, phase: kgPhase(kgCount, kgThreshold), threshold: kgThreshold }
  const laggard: 'dw' | 'kg' = PHASE_RANK[dw.phase] <= PHASE_RANK[kg.phase] ? 'dw' : 'kg'
  return { dw, kg, laggard, workRemaining }
}

/** The hint for one layer at one phase. `mature` is unreachable here —
 * {@link guidanceFromEvaluation} never selects a `mature` layer as the laggard — and
 * KG's `backfill` is unreachable per this module's doc; both are given a defined
 * (empty) string rather than throwing, so this stays a total function. */
function hintFor(layer: 'dw' | 'kg', phase: GuidancePhase): string {
  if (layer === 'dw') {
    switch (phase) {
      case 'seeding': return '数据仓库层(DW)尚无任何 table / event 定义，建议依据 DDL/文档用 create_definition 创建首批表与事件定义。'
      case 'backfill': return '数据仓库层(DW)已有定义但关系/别名尚不完整，建议用 get_enrichment_work 查看缺口，run_enrichment 做确定性补全后 apply_enrichment 应用结果。'
      case 'llm_supplement': return '数据仓库层(DW)确定性补全已完成，定义数仍低于成熟阈值，建议继续用 create_definition / add_alias / add_relation / update_definition 补充别名、关系与业务含义。'
      case 'mature': return ''
    }
  }
  switch (phase) {
    case 'seeding': return '知识图谱层(KG)尚无任何 concept 定义，建议为缺少单一归属资产的业务域词用 create_definition 创建 concept 定义。'
    case 'llm_supplement': return '知识图谱层(KG)已有少量 concept 定义，建议继续补充 concept 定义及 add_relation（如 related_to）以丰富知识图谱。'
    case 'backfill': return ''
    case 'mature': return ''
  }
}

/**
 * Render `_guidance` from one evaluation — the guidance half of #121's
 * one-evaluation/two-renderers split. Pure: every judgment (phases, laggard,
 * effective thresholds, the work total) already happened in
 * {@link evaluateLayers}; this only words and shapes it, or returns `undefined`
 * once both layers are `mature` (zero tax, #55 R9).
 */
export function guidanceFromEvaluation(e: LayersEvaluation): Guidance | undefined {
  if (e.dw.phase === 'mature' && e.kg.phase === 'mature') return undefined
  const laggard = e[e.laggard]
  return {
    phase: laggard.phase,
    hint: hintFor(e.laggard, laggard.phase),
    // Verbatim `{count, phase}` per layer: `metrics` predates the evaluation
    // carrying thresholds too, and #121 changes no response key.
    metrics: { dw: { count: e.dw.count, phase: e.dw.phase }, kg: { count: e.kg.count, phase: e.kg.phase } },
  }
}

/**
 * Compute `_guidance`, or `undefined` once both layers have reached `mature`:
 * {@link evaluateLayers} + {@link guidanceFromEvaluation}, nothing else (#121
 * collapsed the per-tool composition into that pair). Called by
 * `tools/audited.ts`'s `writeReceipt` — the write envelope's single injection
 * point for the 7 guidance-carrying tools (#55/#56's model; #108 folded the
 * per-handler `guidanceField` spread into the envelope).
 * @param snap - the entry snapshot (ADR-0011 ruling 1 — resolved at handler entry).
 * @param thresholds - per-layer overrides; each side defaults independently
 *   ({@link DEFAULT_DW_THRESHOLD}, {@link DEFAULT_KG_THRESHOLD}) when absent.
 */
export async function maybeGuidance(snap: ScopeBinding, thresholds?: GuidanceThresholds): Promise<Guidance | undefined> {
  return guidanceFromEvaluation(await evaluateLayers(snap, thresholds))
}

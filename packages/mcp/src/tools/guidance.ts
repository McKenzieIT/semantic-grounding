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
 * or an event (fixed `'event'`) — is DW by elimination. DW's `backfill` check reuses
 * `listEnrichmentWork({})` (no dimension filter = whole corpus), the same
 * deterministic gap index `get_enrichment_work` exposes — so {@link maybeGuidance}
 * is async.
 *
 * ## #63: the phase derivation is exported, not duplicated
 *
 * `layerCounts`/`dwPhase`/`kgPhase` (and `PHASE_RANK`) were module-private until
 * `get_initialization_playbook` (`tools/playbook.ts`, #63) needed them. #55's
 * resolution pinned the reuse rule — "`_guidance.phase` 调用本工具的阶段判断，接口
 * 不变" — so the playbook imports these instead of forking a second phase
 * derivation. They are exported for that one consumer; their signatures and
 * semantics are unchanged.
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

/** Lower rank = further behind. Exported for `tools/playbook.ts` (#63) — the
 * single ranking table both tools order phases by; a second copy could drift into
 * disagreeing with `_guidance` about which layer is the laggard. */
export const PHASE_RANK: Readonly<Record<GuidancePhase, number>> = { seeding: 0, backfill: 1, llm_supplement: 2, mature: 3 }

/** DW's phase: `seeding` (no definitions) → `backfill` (deterministic relation /
 * alias gaps outstanding) → `llm_supplement` (gaps clear, count still below
 * threshold) → `mature`. The `backfill` check is the only reason this function
 * (and therefore {@link maybeGuidance}) is async. Exported for
 * `tools/playbook.ts` (#63) — the one phase derivation, shared, never forked. */
export async function dwPhase(snap: ScopeBinding, count: number, threshold: number): Promise<GuidancePhase> {
  if (count === 0) return 'seeding'
  const work = await snap.core.listEnrichmentWork({})
  if (work.total > 0) return 'backfill'
  return count < threshold ? 'llm_supplement' : 'mature'
}

/** KG's phase: `seeding` → `llm_supplement` → `mature` — `backfill` is skipped
 * (concepts have no enrichment rounds at all, ADR-0012/#46). Exported for
 * `tools/playbook.ts` (#63), same single-derivation rule as {@link dwPhase}. */
export function kgPhase(count: number, threshold: number): GuidancePhase {
  if (count === 0) return 'seeding'
  return count < threshold ? 'llm_supplement' : 'mature'
}

/** DW count (tables + events) and KG count (concepts), split from one
 * schema-valid, graph-attached scan — see this module's doc for why a concept
 * node's fixed `kind` lets DW fall out "by elimination". Exported for
 * `tools/playbook.ts` (#63), same single-derivation rule as {@link dwPhase}. */
export function layerCounts(snap: ScopeBinding): { readonly dw: number; readonly kg: number } {
  const nodes = snap.core.projectGraphNodes({ includeDerived: false })
  const kg = nodes.filter(n => n.kind === 'concept').length
  return { dw: nodes.length - kg, kg }
}

/** The hint for one layer at one phase. `mature` is unreachable here —
 * {@link maybeGuidance} never selects a `mature` layer as the laggard — and
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
 * Compute `_guidance`, or `undefined` once both layers have reached `mature`.
 * Called by `tools/audited.ts`'s `writeReceipt` — the write envelope's single
 * injection point for the 7 guidance-carrying tools (#55/#56's model; #108
 * folded the per-handler `guidanceField` spread into the envelope).
 * @param snap - the entry snapshot (ADR-0011 ruling 1 — resolved at handler entry).
 * @param thresholds - per-layer overrides; each side defaults independently
 *   ({@link DEFAULT_DW_THRESHOLD}, {@link DEFAULT_KG_THRESHOLD}) when absent.
 */
export async function maybeGuidance(snap: ScopeBinding, thresholds?: GuidanceThresholds): Promise<Guidance | undefined> {
  const dwThreshold = thresholds?.dw ?? DEFAULT_DW_THRESHOLD
  const kgThreshold = thresholds?.kg ?? DEFAULT_KG_THRESHOLD
  const { dw: dwCount, kg: kgCount } = layerCounts(snap)
  const dw: LayerMetrics = { count: dwCount, phase: await dwPhase(snap, dwCount, dwThreshold) }
  const kg: LayerMetrics = { count: kgCount, phase: kgPhase(kgCount, kgThreshold) }
  if (dw.phase === 'mature' && kg.phase === 'mature') return undefined

  const dwIsLaggard = PHASE_RANK[dw.phase] <= PHASE_RANK[kg.phase]
  const phase = dwIsLaggard ? dw.phase : kg.phase
  const hint = dwIsLaggard ? hintFor('dw', dw.phase) : hintFor('kg', kg.phase)
  return { phase, hint, metrics: { dw, kg } }
}

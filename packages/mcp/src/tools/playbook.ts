/**
 * `get_initialization_playbook` — #63 landing the four #55 rulings `_guidance`
 * (#56) deliberately left to this tool's own execution ticket: R3 (the
 * `recommended_action` `{tool, hint}` hybrid), R7 (the full return shape), R10
 * (`scope_id` required, per-scope, no whole-registry aggregation), R13 (the
 * corpus-level `summary`). The phase *model* itself (R1/R2/R4/R5/R6/R8/R9/R12)
 * is not re-implemented here: this module imports `layerCounts`/`dwPhase`/
 * `kgPhase`/`PHASE_RANK` from `tools/guidance.ts` — #55's resolution pinned that
 * reuse ("`_guidance.phase` 调用本工具的阶段判断，接口不变"), so there is exactly
 * one phase derivation in this package and the equivalence is testable (see
 * `tests/playbook.spec.ts`'s first describe).
 *
 * ## Where this tool's view is wider than `_guidance`'s
 *
 * `scope_registration` — phase 1 of #55's five — is structurally unreachable at
 * `_guidance`'s injection point (ADR-0014's honest-fork note: `requireSnapshot()`
 * has already proved the scope bound by then). It is reachable *here*, and it is
 * the one phase the registry answers without a corpus: a `scope_id` the registry
 * has never seen, or one whose registered root has disappeared, answers with a
 * successful playbook in `scope_registration` whose recommended action is
 * `register_scope` — the exact first move of the e2e evolution path #55 sketched
 * ("scope 未注册 → 各阶段 → 成熟"). {@link PlaybookPhase} is therefore
 * `GuidancePhase | 'scope_registration'`: five names, per R7's `PhaseName`, the
 * divergence ADR-0014 already licensed for exactly these two tools.
 *
 * A scope that IS registered (and reachable) but is not this process's active
 * binding is refused with `scope_mismatch` (−31064) — the same convention family
 * the 8 commit-class tools use for their `scope_id` assertion (ADR-0011). The
 * alternative — quietly loading a corpus this process is not serving, or
 * silently redirecting to the active one — would put un-audited reads on a
 * scope the caller did not name. `switch_scope` is one call away and is the
 * agent's own act (ADR-0011 constant 1: registering/switching never happens as
 * a side effect).
 *
 * ## Shape notes the ADR records as reconciliations, not redesigns
 *
 * - **`summary`** carries both halves the sources ask for: R7's canonical
 *   numeric block (`total_definitions` / `dw_definitions` / `kg_definitions` /
 *   `enrichment_work_remaining` — also what R13's own text lists) plus a
 *   `message` field, the one-sentence corpus-level judgement #63's ticket asks
 *   for ("整体卡在哪一层、哪个阶段"). Dropping either half would contradict one
 *   of the two sources; carrying both contradicts neither.
 * - **`recommended_action.tool`** stays `string | null` exactly as R3 declared.
 *   Two #55 table cells name several tools (`add_alias / add_relation /
 *   update_definition`); they ride the one string verbatim as slash-separated
 *   alternatives rather than reshaping the field into an array — 照抄 the table,
 *   not a redesign. The DW `seeding` cell names `import_definitions`, which #54
 *   designed and #68 landed (tools/list 25→26): the name this table always
 *   ruled now resolves to a registered tool — the interim note (create_definition
 *   standing in) is retired; see ADR-0014's Update note and ADR-0013.
 * - **`scope.root`** is `string | null`: R7 drew the shape assuming a registered
 *   scope, while `scope_registration` by definition has no resolved root to
 *   report (a never-registered id has none at all).
 *
 * ## Cost note
 *
 * `dwPhase` internally lists enrichment work to decide `backfill`, and this
 * module lists it once more for `summary.enrichment_work_remaining` and the
 * coverage numbers. That second scan is deliberate: routing the number through
 * the shared derivation is what keeps the phase logic single-sourced, and this
 * is an occasional dashboard read, not a hot path.
 *
 * @module tools/playbook
 */
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { ScopeBinding } from '../binding.ts'
import { ScopeMismatchError, toToolErrorResult } from '../errors.ts'
import { scopeEntryReachable } from '../scope-registry.ts'
import type { ServerDeps, ToolRegistrar } from '../server.ts'
import { toolSuccess } from './audited.ts'
import {
  DEFAULT_DW_THRESHOLD,
  DEFAULT_KG_THRESHOLD,
  dwPhase,
  kgPhase,
  layerCounts,
  PHASE_RANK,
  type GuidancePhase,
  type GuidanceThresholds,
} from './guidance.ts'
import { ScopeIdSchema } from './shared.ts'

/** The playbook tool's single name. */
export const PLAYBOOK_TOOL_NAMES = ['get_initialization_playbook'] as const

/**
 * The playbook's phase name — #55 R7's `PhaseName`, all five values. `GuidancePhase`
 * (guidance.ts) is the four-value subset `_guidance` can structurally observe; the
 * divergence is ADR-0014's documented honest fork, not a second model.
 */
export type PlaybookPhase = GuidancePhase | 'scope_registration'

/**
 * #55 R3: the hybrid next-step — `tool` names the MCP tool to call next (an
 * agent dispatches on it directly), `hint` is the human-readable why. `tool` is
 * `null` only where no single tool applies (`mature`).
 */
export interface RecommendedAction {
  /** The next tool to call, or null when the stage has none (`mature`). */
  readonly tool: string | null
  /** Free text (Chinese prose, matching `guidance.ts`'s convention): why this. */
  readonly hint: string
}

/**
 * #55 R2: one phase's own core indicator — never a cross-stage weighted
 * composite (no objective weights exist; #55 R2's ruling). `current` reaching
 * `target` is the phase's exit condition (for `enrichment_work_remaining` the
 * target is 0: the queue drains).
 */
export interface PhaseCoverage {
  /** Which indicator this phase is measured by. */
  readonly indicator: 'definitions' | 'enrichment_work_remaining' | 'scope_registered'
  /** The indicator's current value. */
  readonly current: number
  /** The value that exits the phase. */
  readonly target: number
}

/** One layer's playbook entry. */
export interface PlaybookLayer {
  readonly phase: PlaybookPhase
  /** This phase's own core indicator (#55 R2). */
  readonly coverage: PhaseCoverage
  /** The next step for this layer (#55 R3). */
  readonly recommended_action: RecommendedAction
}

/**
 * #55 R7's numeric corpus block + #63's one-sentence judgement (see this
 * module's doc: carrying both is the reconciliation, dropping either half would
 * contradict one of the two sources).
 */
export interface PlaybookSummary {
  /** The corpus-level one-sentence judgement: which layer, which phase, what gate. */
  readonly message: string
  /** Schema-valid, graph-attached definitions across both layers. */
  readonly total_definitions: number
  /** Tables + events (the DW layer). */
  readonly dw_definitions: number
  /** Concepts (the KG layer). */
  readonly kg_definitions: number
  /** Outstanding deterministic enrichment work items (`get_enrichment_work`'s queue). */
  readonly enrichment_work_remaining: number
}

/** `get_initialization_playbook`'s response — #55 R7's shape verbatim in field names. */
export interface InitializationPlaybook {
  /** The scope this playbook describes. `root` is null for a never-registered id. */
  readonly scope: { readonly id: string; readonly root: string | null }
  /** The more-behind of the two layers' phases — `_guidance.phase`'s exact口径. */
  readonly overall_phase: PlaybookPhase
  readonly summary: PlaybookSummary
  readonly layers: { readonly dw: PlaybookLayer; readonly kg: PlaybookLayer }
}

/** The tool's input: `scope_id` only, required (#55 R10). */
const GetInitializationPlaybookInputSchema = z.object({
  scope_id: ScopeIdSchema.describe('The scope to report initialization progress for. Required — there is no whole-registry default view (R10): initialization is always about one concrete working context. Must name the scope this process is serving (the registry answers unregistered ids with the scope_registration phase; a registered-but-inactive one is refused with a switch_scope remedy).'),
})

/** The layer names the playbook reports. */
type LayerId = 'dw' | 'kg'

/**
 * #55 R3's reference table, transcribed verbatim — per (layer, phase): the tool
 * (slash-separated where the table names several; null for `mature`) and the
 * hint — one amendment: #69 widens the `scope_registration` hint into the
 * naming-confirmation soft guidance (the scope_id is a persistent identity;
 * confirm its naming with the user before registering — the same sentence
 * `scope.ts`'s two bootstrap descriptions carry). `kg`/`backfill` is
 * unreachable (concepts have no enrichment rounds, ADR-0012) but defined, so
 * this stays a total function.
 */
function recommendedActionFor(layer: LayerId, phase: PlaybookPhase): RecommendedAction {
  if (phase === 'scope_registration') {
    // #69's amendment of R3's bare "register_scope" row: the naming decision is
    // initialization's first human call, and the id is permanent — soft
    // guidance in the hint's wording only (no mechanism, no hard gate).
    return { tool: 'register_scope', hint: 'scope_id 是持久身份（1:1 绑定 corpus、随每个 Tier-2 commit 进 git trailer、无改名工具）——注册前与用户确认命名' }
  }
  if (phase === 'mature') {
    return { tool: null, hint: '语义层初始化完成，持续维护中' }
  }
  if (layer === 'dw') {
    switch (phase) {
      case 'seeding': return { tool: 'import_definitions', hint: '批量导入表和事件定义建立数仓语义层' }
      case 'backfill': return { tool: 'run_enrichment', hint: '运行确定性 enrichment 填充关联和别名' }
      case 'llm_supplement': return { tool: 'add_alias / add_relation / update_definition', hint: '补充 enrichment 无法确定性解决的语义 gap' }
    }
  }
  switch (phase) {
    case 'seeding': return { tool: 'create_definition', hint: '注册游戏实体概念建立知识图谱' }
    case 'backfill': return { tool: 'run_enrichment', hint: '运行确定性 enrichment 填充关联和别名' }
    case 'llm_supplement': return { tool: 'create_definition / add_relation', hint: '扩展知识图谱实体和关系' }
  }
}

/**
 * One phase's own core indicator (#55 R2): what `current`/`target` mean for
 * this phase, taken from the same numbers the shared phase derivation judged.
 */
function coverageFor(phase: PlaybookPhase, count: number, threshold: number, workRemaining: number): PhaseCoverage {
  if (phase === 'scope_registration') return { indicator: 'scope_registered', current: 0, target: 1 }
  if (phase === 'seeding') return { indicator: 'definitions', current: count, target: 1 }
  if (phase === 'backfill') return { indicator: 'enrichment_work_remaining', current: workRemaining, target: 0 }
  return { indicator: 'definitions', current: count, target: threshold }
}

/** The Chinese layer name `summary.message` and the guidance hints both use. */
const LAYER_LABEL: Readonly<Record<LayerId, string>> = { dw: '数据仓库层(DW)', kg: '知识图谱层(KG)' }

/** The corpus-level one-sentence judgement (#55 R13 / #63): laggard layer + phase + gate. */
function summaryMessage(laggard: LayerId, phase: PlaybookPhase, count: number, threshold: number, workRemaining: number): string {
  if (phase === 'scope_registration') return 'scope 尚未注册或不可达——整体处于 scope_registration 阶段，初始化尚未开始，先走 register_scope。'
  const label = LAYER_LABEL[laggard]
  switch (phase) {
    case 'seeding': return `整体最落后：${label} 处于 seeding 阶段——该层尚无任何定义。`
    case 'backfill': return `整体最落后：${label} 处于 backfill 阶段——仍有 ${workRemaining} 项确定性 enrichment 缺口待清。`
    case 'llm_supplement': return `整体最落后：${label} 处于 llm_supplement 阶段——定义数 ${count} 仍低于成熟阈值 ${threshold}。`
    case 'mature': return '两层均已成熟——初始化完成，语义层进入持续维护（mature 非终态）。'
  }
}

/** The `scope_registration` playbook the registry answers on its own — no corpus
 * to read, so every count is zero and the registry fact rides the message.
 * Both layers share the phase (#55 R6: scope is corpus-level, not per-layer). */
function unregisteredPlaybook(scopeId: string, registeredRoot: string | null, registeredButUnreachable: boolean): InitializationPlaybook {
  const layer: PlaybookLayer = {
    phase: 'scope_registration',
    coverage: coverageFor('scope_registration', 0, 0, 0),
    // R6's phase 1 is corpus-level (shared across layers): both layers'
    // recommended action is the same register_scope row of R3's table.
    recommended_action: recommendedActionFor('dw', 'scope_registration'),
  }
  return {
    scope: { id: scopeId, root: registeredRoot },
    overall_phase: 'scope_registration',
    summary: {
      message: registeredButUnreachable
        ? `scope "${scopeId}" 已注册但目录不可达——按 R6「不存在或不可达」计为 scope_registration，重新 register_scope 可修复。`
        : summaryMessage('dw', 'scope_registration', 0, 0, 0),
      total_definitions: 0,
      dw_definitions: 0,
      kg_definitions: 0,
      enrichment_work_remaining: 0,
    },
    layers: { dw: layer, kg: layer },
  }
}

/**
 * Compute the full playbook from the entry snapshot — the same counts, the same
 * phase functions, the same thresholds `maybeGuidance` reads.
 * @param snap - the entry snapshot (the scope this process is serving).
 * @param thresholds - per-layer overrides; each side defaults independently.
 * @param root - the scope's semantic root, for the response's `scope` stamp.
 */
async function playbookFromSnapshot(snap: ScopeBinding, thresholds: GuidanceThresholds | undefined, root: string): Promise<InitializationPlaybook> {
  const dwThreshold = thresholds?.dw ?? DEFAULT_DW_THRESHOLD
  const kgThreshold = thresholds?.kg ?? DEFAULT_KG_THRESHOLD
  const { dw: dwCount, kg: kgCount } = layerCounts(snap)
  const dwPhaseValue = await dwPhase(snap, dwCount, dwThreshold)
  const kgPhaseValue = kgPhase(kgCount, kgThreshold)
  // The queue length for the summary/coverage numbers. dwPhase just listed this
  // same index internally; see this module's doc for why the second read is the
  // right trade (one derivation, occasionally scanned twice).
  const { total: workRemaining } = await snap.core.listEnrichmentWork({})

  const layers = {
    dw: {
      phase: dwPhaseValue,
      coverage: coverageFor(dwPhaseValue, dwCount, dwThreshold, workRemaining),
      recommended_action: recommendedActionFor('dw', dwPhaseValue),
    },
    kg: {
      phase: kgPhaseValue,
      coverage: coverageFor(kgPhaseValue, kgCount, kgThreshold, workRemaining),
      recommended_action: recommendedActionFor('kg', kgPhaseValue),
    },
  }
  // `_guidance.phase`'s exact laggard rule, on the shared ranking table: the
  // more-behind layer, ties to DW (equal phases make the tie irrelevant to the
  // value; the message's layer label follows the same convention).
  const dwIsLaggard = PHASE_RANK[dwPhaseValue] <= PHASE_RANK[kgPhaseValue]
  const laggard: LayerId = dwIsLaggard ? 'dw' : 'kg'
  const laggardPhase = dwIsLaggard ? dwPhaseValue : kgPhaseValue
  const laggardCount = dwIsLaggard ? dwCount : kgCount
  const laggardThreshold = dwIsLaggard ? dwThreshold : kgThreshold
  return {
    scope: { id: snap.scopeId, root },
    overall_phase: laggardPhase,
    summary: {
      message: summaryMessage(laggard, laggardPhase, laggardCount, laggardThreshold, workRemaining),
      total_definitions: dwCount + kgCount,
      dw_definitions: dwCount,
      kg_definitions: kgCount,
      enrichment_work_remaining: workRemaining,
    },
    layers,
  }
}

/**
 * Registers `get_initialization_playbook` — a pure read (no lock, no recorder),
 * registered pure per the `ToolRegistrar` contract; every corpus/registry read
 * happens inside the handler.
 */
function registerGetInitializationPlaybook(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_initialization_playbook',
    {
      title: 'Get the initialization playbook',
      description: 'Initialization dashboard for one scope: the DW (tables/events) and KG (concepts) layers\' current phase (scope_registration → seeding → backfill → llm_supplement → mature), each layer\'s own coverage indicator, the recommended next tool, and a corpus-level summary — all derived live from the corpus state, never a cached snapshot. scope_id is required: an unregistered (or unreachable) id answers with the scope_registration phase and register_scope as the next step; a registered id this process is not serving is refused with a switch_scope remedy. The phase judgment is the exact one the write tools\' _guidance field reports, so the two can never disagree.',
      inputSchema: GetInitializationPlaybookInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        const snap = deps.bindings.snapshot()
        if (snap !== undefined && snap.scopeId === input.scope_id) {
          return toolSuccess(await playbookFromSnapshot(snap, deps.config.guidanceThreshold, snap.semanticRoot))
        }
        // Not the scope this process is serving. The registry alone decides which
        // of R6's two phase-1 entry conditions this is — "not in the registry" /
        // "registered but unreachable" answer with a scope_registration playbook,
        // "registered and reachable but not bound" is the −31064 refusal.
        const entry = deps.registry.getEntry(input.scope_id)
        if (entry === undefined) {
          return toolSuccess(unregisteredPlaybook(input.scope_id, null, false))
        }
        if (!scopeEntryReachable(entry)) {
          return toolSuccess(unregisteredPlaybook(input.scope_id, entry.semanticRoot, true))
        }
        throw new ScopeMismatchError(
          `playbook asked for scope "${input.scope_id}", which is registered but not the scope this process is serving${snap === undefined ? ' (no scope is active)' : ` ("${snap.scopeId}" is)`} — its corpus cannot be read without binding it, and binding is switch_scope's move, never a read's side effect`,
          {
            asserted_scope_id: input.scope_id,
            active_scope_id: snap?.scopeId ?? null,
            remedy: 'switch_scope to the scope you meant, then re-ask',
          },
        )
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

/** Registers the playbook tool family (one tool today). */
export const registerPlaybookTools: ToolRegistrar = (server, deps) => {
  registerGetInitializationPlaybook(server, deps)
}

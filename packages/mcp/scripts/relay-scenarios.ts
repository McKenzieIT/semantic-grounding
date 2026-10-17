/**
 * The three relay scenario cards as data (#156's ruling / #128's cards /
 * ADR-0028 R4's E3 revision) — the single source both relay consumers read:
 *
 * - `check-relay.ts` (opt-in, `pnpm relay`) drives the REAL relay from here:
 *   A's write prompt, B's (and the control's) question prompts, the L0/L1/L2
 *   judging rules, and the request-sequence recorder.
 * - `check-e2e-loop.ts`'s Phase 8 contract stub reads the replay keywords and
 *   the L0 trailer table, so the gate's keyword assertions can never drift
 *   from what the real relay judged against.
 *
 * The module is data only — no process spawning, no I/O — which is what keeps
 * it shareable between an opt-in external-LLM driver and the hermetic gate
 * (#157's boundary: the four gates never execute an external LLM call).
 *
 * It also owns the **pure judging primitives** over the cards (#179's window
 * assertion, #180's host-rejection boundary): both consumers and the unit
 * tests call them without a CLI in the loop. The driver's `judgeL1`
 * orchestrates them; this module just decides.
 *
 * @module relay-scenarios
 */

/** Which corpus a card runs over (#156's carrier ruling: E3+A3 k11, G3′ X63). */
export type RelayCorpus = 'k11-copy' | 'x63-10000354'

/** Which CLI harness drives a leg (#180: qodercli only — claude/codex retired,
 *  L3 is a manual QoderWork leg). */
export type RelayHost = 'qodercli'

/** A data-window the L1 judge enforces when present (#179's verdict: a window
 *  must fit inside the question's date range and the matching read's result
 *  must not contain the excluded memory). */
export interface RelayWindow {
  /** Inclusive lower bound, `YYYY-MM-DD`. */
  readonly from: string
  /** Inclusive upper bound, `YYYY-MM-DD`. */
  readonly to: string
  /** Memory id that MUST NOT appear in any tool result whose call carried
   *  a window that fits inside this one. Empty = no memory exclusion. */
  readonly excludeMemoryId: string
}

/** One B-side question with its L2 keyword verdicts (#129's rubric layer 2)
 *  and optional L1 window assertion (#179). */
export interface RelayQuestion {
  readonly id: string
  /** The question prompt. MUST NOT contain the answer keywords (#129's leak guard). */
  readonly prompt: string
  /** Every keyword here must appear in B's final answer. */
  readonly allOf: readonly string[]
  /** At least one keyword here must appear in B's final answer (empty = no anyOf rule). */
  readonly anyOf: readonly string[]
  /** No keyword here may appear in B's final answer (empty = no negative rule). */
  readonly negative: readonly string[]
  /** Optional L1 trajectory window assertion (#179). Empty = no window rule. */
  readonly window?: RelayWindow
}

/** The L0 trailer verdict per card — #156's per-card table, verbatim. */
export interface RelayL0 {
  /** The one promotion/evidence trailer the A-side commit must carry. */
  readonly must: 'evidence-source' | 'session-only'
}

/** The L1 trajectory verdict per card (#129's rubric layer 1). */
export interface RelayL1 {
  /** B must have called at least one of these SG read tools (reverse condition: answering
   * correctly without any tool call = leak = fail). */
  readonly readTools: readonly string[]
  /** Extra: B's trajectory (tool inputs AND tool results) must mention each of these
   * (E3's ADR-0028 R4 addition: the trajectory read `concept:二级渠道`). Empty = no extra rule. */
  readonly trajectoryMentions: readonly string[]
}

/** One relay scenario card. */
export interface RelayScenario {
  readonly id: 'e3' | 'a3' | 'g3'
  /** The #128 card this replays. */
  readonly card: string
  readonly corpus: RelayCorpus
  readonly harnessA: RelayHost
  readonly harnessB: RelayHost
  /** True if L3 is a manual QoderWork run on this card (#180: L3 = QoderWork
   *  manual, G3′ only). When false, no L3 runs and the driver prints the
   *  manual checklist at the end of the card. */
  readonly l3Manual: boolean
  /** A's write-side prompt (drives the L0 writes). */
  readonly promptA: string
  /** The control question (E3 only, ADR-0028 R4: pre-promotion, same wording, must NOT pass — else 换题). */
  readonly controlPrompt: string | undefined
  /** B's treatment questions (G3′ has in-window + out-of-window; the others have one). */
  readonly questions: readonly RelayQuestion[]
  readonly l0: RelayL0
  readonly l1: RelayL1
  /**
   * The keyword contract the e2e gate's frozen-replay leg asserts: replaying B's
   * recorded MCP request sequence must surface each keyword in SOME response
   * (#156: keyword hits, never response-body snapshots).
   */
  readonly replayKeywords: readonly string[]
}

/** The SG read tools whose presence in B's trajectory satisfies L1 (#129's list). */
const READ_TOOLS = ['search_definitions', 'get_definition', 'list_definitions', 'get_join_path', 'get_relations', 'resolve_alias'] as const

/** The 口径 A3 fixes in its prompt (shared with the L2/replay keywords — one constant, no drift). */
const A3_THRESHOLD = '500'

/** The G3′ incident day (a fixed past date inside B's in-window question's range). */
const G3_INCIDENT_DAY = '2026-10-10'

/** The shared scope-id the k11-copy corpus is registered under, in BOTH drivers — the real
 * relay's sandbox and the gate's Phase 8 probe. The frozen fixtures then replay verbatim
 * (B's recorded `scope_id` arguments already name this id; no remapping at replay). */
export const K11_RELAY_SCOPE_ID = 'k11-relay'

/** The X63 scope id G3′ runs against (#156: the real QoderWork-initialized corpus). */
export const X63_SCOPE_ID = '10000354'

/** The G3′ target table placeholder — substituted at runtime by `check-relay.ts`
 * (discovered from the real X63 corpus, or overridden via `SG_RELAY_G3_TARGET`). */
export const G3_TARGET_PLACEHOLDER = '<G3_TARGET_TABLE>'

// ── E3 — 内部黑话,直接晋升 (ADR-0028 R4) ───────────────────────────────────────

const E3_PROMPT_A = [
  '你在参与一个跨 agent 接力测试的写入腿(A 腿)。语义层由 semantic-grounding 的 MCP 服务(服务名 sg)提供;先用 list_scopes / get_scope 确认当前 scope,之后每次写工具调用都带正确的 scope_id。',
  '',
  '背景:业务方说「按 2渠 拆一下」,你从 dws_10000251_acc_summary_df 的列注释学到:c1 注释「渠道，又叫1渠」、c2 注释「渠道id，又叫2渠」。业务语义:一个一级渠道下有 1..N 个二级渠道。',
  '',
  '任务(按顺序,全部经 sg 的 MCP 工具完成):',
  '1. 用 import_definitions 一次性建两个概念(先不要带 alt_labels):',
  '   - 一级渠道:description「渠道一级分类,对应列 c1。」,properties {column: c1, recent_column: c1_lst};',
  '   - 二级渠道:description「渠道二级分类,隶属一级渠道,对应列 c2。」,properties {column: c2, recent_column: c2_lst, parent: 一级渠道, parent_column: c1}。',
  '   这次 import_definitions 调用要声明 evidence: {kind: "source", source: "dws_10000251_acc_summary_df 的 c1/c2 列注释(渠道，又叫1渠 / 渠道id，又叫2渠)"}。',
  '2. 用 add_alias 给 concept 一级渠道 加别名「1渠」,给 concept 二级渠道 加别名「2渠」。',
  '3. 用 add_relation 给 concept 二级渠道 加一条指向 concept 一级渠道 的 related_to 边,summary 里写「隶属上级:一级渠道(1:N),下钻时按 c1, c2 分组」。',
  '注意:本环境没有 create_definition 工具(已知宿主限制),不要尝试;import_definitions 的概念项字段名是 name。完成后报告你落了哪些 commit。',
].join('\n')

/** E3's B question (#183 — the third shape). The previous one, "「2渠」指什么?用哪
 *  张表的哪个字段拆?", was answerable with no concepts at all: `acc_summary_df.c2`
 *  carries the comment「渠道id，又叫2渠」and the churn table names the same column
 *  `c2`, so the control chained alias → column name → target table out of corpus
 *  text alone (1/3 leaked). Renaming columns (#182) or picking another table cannot
 *  close that: the alias→column mapping *is* the promotion's evidence source (L0
 *  `evidence-source`), so it lives in the corpus by construction.
 *  What the concept layer alone holds is the hierarchy the business gave A —
 *  一个一级渠道下有 1..N 个二级渠道, so a drill-down groups by c1 **and** c2 —
 *  and grep confirms no 一级/二级渠道, 隶属, or 1:N anywhere in k11. The question
 *  asks for that, so the control has to guess it to pass. */
const E3_PROMPT_B = '你是数据分析师。业务方要求:「按 2渠 拆一下昨天的流失账号数」。请先查语义层(semantic-grounding 的 MCP 服务,服务名 sg;先 list_scopes 看有哪些 scope,要用读工具确认)弄清「2渠」指什么、它和「1渠」之间是什么关系,再回答三点:(1) 用哪张表;(2) GROUP BY 要写哪些列;(3) 简述依据。'

// ── A3 — 「大R」没有阈值,口径进 memory (#128 A3 / ADR-0021) ──────────────────

const A3_PROMPT_A = [
  '你在参与一个跨 agent 接力测试的写入腿(A 腿)。语义层由 semantic-grounding 的 MCP 服务(服务名 sg)提供;先用 list_scopes / get_scope 确认当前 scope,之后写工具调用带正确的 scope_id。',
  '',
  '背景:业务方要「大R 留存」,但全语料没有一处定义「大R」是多少钱以上(概念「付费经济」的 alt_labels 里有「大R」,但无阈值)。本次会话业务方口述了口径。',
  '',
  `任务:把这条口径用 record_memory 记一条 practice memory:anchors 用 ["concept:付费经济"],body 写「大R 口径:累计付费 ≥ ${A3_THRESHOLD} 元(2026-10 业务口述,未书面确认)。」,basis 写「业务方在本次会话中口述」。`,
  '注意:本次只是记录 memory —— 不要把它写进某种定义,也不要创建已验证查询(口径尚未经人书面确认)。完成后报告 memory id。',
].join('\n')

const A3_PROMPT_B = '你是数据分析师。业务方要算「大R 留存」。请先查语义层(semantic-grounding 的 MCP 服务,服务名 sg;先 list_scopes,要用读工具确认)看有没有关于「大R」口径的记录,然后回答:大R 的口径是什么、阈值是多少?简述依据。'

// ── G3′ — 一次具体的未产出事故,永不晋升 (#128 G3′;X63 + qodercli,#156) ───────

function g3Prompts(target: string): { readonly a: string; readonly inWindow: string; readonly outWindow: string } {
  const a = [
    `你在参与一个跨 agent 接力测试的写入腿(A 腿)。语义层由 semantic-grounding 的 MCP 服务(服务名 sg)提供,当前 scope ${X63_SCOPE_ID}(X63-永测服);用 get_scope 确认后再写。`,
    '',
    `背景:${G3_INCIDENT_DAY} 当天上游未产出,${target} 当日分区为空、指标偏低。`,
    '',
    `任务:把这次事故用 record_memory 记一条 incident memory:anchors 用 ["table:${target}"],body 写「${G3_INCIDENT_DAY} 上游未产出,${target} 当日分区为空、指标偏低;跨期对比须排除或标注该日。」,valid_from "${G3_INCIDENT_DAY}"、valid_until "${G3_INCIDENT_DAY}"。`,
    '注意:incident 永不晋升 —— 不要写任何定义、不要建已验证查询。完成后报告 memory id。',
  ].join('\n')
  const inWindow = `你是数据分析师。我要看 ${target} 从 ${G3_INCIDENT_DAY.slice(5, 7)}-09 到 ${G3_INCIDENT_DAY.slice(5, 7)}-12 每日的指标趋势。请先查语义层(semantic-grounding 的 MCP 服务,服务名 sg;scope ${X63_SCOPE_ID},要用读工具确认,注意带上日期窗)这几天里有没有需要特别注意或排除的日期,再给结论和依据。`
  const outWindow = `你是数据分析师。我要看 ${target} 从 09-01 到 09-30 每日的指标趋势。请先查语义层(semantic-grounding 的 MCP 服务,服务名 sg;scope ${X63_SCOPE_ID},要用读工具确认,注意带上日期窗)看 ${target} 表的记忆层有没有需要特别注意或排除的日期(仅查本表记忆,不要扩展到其他表或全库),再给结论和依据。`
  return { a, inWindow, outWindow }
}

/** The G3′ prompts as functions of the runtime-discovered target table. */
export { g3Prompts }

/** The G3′ incident window (valid_from = valid_until = the incident day). */
export const G3_WINDOW = { from: G3_INCIDENT_DAY, to: G3_INCIDENT_DAY } as const

// ── The three cards ─────────────────────────────────────────────────────────────

/** E3 (k11, qodercli A/B, no script L3): jargon → term concepts, direct promotion. */
export const E3_SCENARIO: RelayScenario = {
  id: 'e3',
  card: 'E3｜内部黑话 —— 该立刻晋升的 memory(docs/data-memory-scenarios.md,ADR-0028 R4 增量)',
  corpus: 'k11-copy',
  harnessA: 'qodercli',
  harnessB: 'qodercli',
  l3Manual: false,
  promptA: E3_PROMPT_A,
  controlPrompt: E3_PROMPT_B,
  questions: [{
    id: 'e3-main',
    prompt: E3_PROMPT_B,
    // `allOf` keeps the operational answer (E3 is still "jargon → usable table.column");
    // `anyOf` is the discriminator — the 1:N hierarchy exists only on the concept A wrote
    // (description, `properties.parent`, and the `related_to` summary), never in k11 (#183).
    allOf: ['univ_acc_churn_di', 'c1', 'c2'],
    anyOf: ['1:N', '1..N', '一对多', '隶属'],
    negative: [],
  }],
  l0: { must: 'evidence-source' },
  l1: { readTools: READ_TOOLS, trajectoryMentions: ['二级渠道'] },
  replayKeywords: ['concept:二级渠道', 'c2'],
}

/** A3 (k11, qodercli A/B, no script L3): 口径一致性 — B must repeat A's threshold. */
export const A3_SCENARIO: RelayScenario = {
  id: 'a3',
  card: 'A3｜「大R」没有阈值 —— 口径一致性(docs/data-memory-scenarios.md)',
  corpus: 'k11-copy',
  harnessA: 'qodercli',
  harnessB: 'qodercli',
  l3Manual: false,
  promptA: A3_PROMPT_A,
  controlPrompt: undefined,
  questions: [{
    id: 'a3-main',
    prompt: A3_PROMPT_B,
    allOf: [A3_THRESHOLD],
    anyOf: [],
    negative: [],
  }],
  l0: { must: 'session-only' },
  l1: { readTools: READ_TOOLS, trajectoryMentions: [] },
  replayKeywords: [A3_THRESHOLD, 'memories'],
}

/** G3′ (X63, qodercli A/B, L3 = QoderWork manual — #180): time-bounded incident, in/out-window behaviour.
 *  The in-window question uses the full L2 surface; the out-of-window question uses #179's
 *  window assertion (data_window ⊆ 09-01..09-30 whose read result omits the incident memory). */
export const G3_SCENARIO: RelayScenario = {
  id: 'g3',
  card: 'G3′｜一次具体的未产出事故 —— 有失效时间,永不晋升(docs/data-memory-scenarios.md)',
  corpus: 'x63-10000354',
  harnessA: 'qodercli',
  harnessB: 'qodercli',
  l3Manual: true,
  // The G3′ prompts are target-table-dependent; check-relay substitutes and
  // judges from these rules. The placeholders below document the shape for readers.
  promptA: g3Prompts(G3_TARGET_PLACEHOLDER).a,
  controlPrompt: undefined,
  questions: [
    { id: 'g3-in-window', prompt: g3Prompts(G3_TARGET_PLACEHOLDER).inWindow, allOf: ['未产出'], anyOf: [G3_INCIDENT_DAY, `${G3_INCIDENT_DAY.slice(5, 7)}月${G3_INCIDENT_DAY.slice(8, 10)}`], negative: [] },
    { id: 'g3-out-window', prompt: g3Prompts(G3_TARGET_PLACEHOLDER).outWindow, allOf: [], anyOf: [], negative: [], window: { from: '2026-09-01', to: '2026-09-30', excludeMemoryId: '' } },
  ],
  l0: { must: 'session-only' },
  l1: { readTools: READ_TOOLS, trajectoryMentions: [] },
  replayKeywords: ['未产出', 'memories'],
}

/** All three cards, card order. */
export const RELAY_SCENARIOS: readonly RelayScenario[] = [E3_SCENARIO, A3_SCENARIO, G3_SCENARIO]

/** Look one card up by id. */
export function relayScenario(id: 'e3' | 'a3' | 'g3'): RelayScenario {
  const found = RELAY_SCENARIOS.find(s => s.id === id)
  if (found === undefined) throw new Error(`unknown relay scenario: ${id}`)
  return found
}

// ── Pure judging primitives ──────────────────────────────────────────────────────

/** One SG tool call the driver parsed from the host's stream — the shape every
 *  judge reads (#180 item 6: include the per-call result so the window
 *  assertion can see whether the matching read returned the incident memory). */
export interface RelaySgCall {
  readonly name: string
  readonly input: Record<string, unknown>
  /** Stringified `tool_result.content` block from the host. Empty when the
   *  host did not report a result for this call (truncated stream, CLI
   *  timeout, etc.). */
  readonly resultText: string
  /** True when the host marked this call as failed (`tool_result.is_error`). */
  readonly isError: boolean
}

/** The shape every judge reads (#180: `sgCalls` is richer than plain name+input). */
export interface RelayRun {
  readonly sgCalls: readonly RelaySgCall[]
  readonly trajectoryText: string
  readonly answer: string
  readonly credits: number | undefined
}

/** B's final-answer keyword verdict (#129's L2: allOf + anyOf + negative). */
export function judgeAnswer(question: RelayQuestion, answer: string): { readonly pass: boolean; readonly misses: readonly string[] } {
  const misses = question.allOf.filter(kw => !answer.includes(kw))
  if (question.anyOf.length > 0 && !question.anyOf.some(kw => answer.includes(kw))) misses.push(`(anyOf) ${question.anyOf.join(' | ')}`)
  const leaked = question.negative.filter(kw => answer.includes(kw))
  if (leaked.length > 0) misses.push(`(must-NOT-appear) ${leaked.join(' | ')}`)
  return { pass: misses.length === 0, misses }
}

/** L1 window assertion (#179): B must have called at least one read tool
 *  whose `data_window` argument fits inside the question's window and whose
 *  `resultText` does not name the excluded memory id. Returns `undefined`
 *  when the question declares no window (caller skips). */
export function judgeWindow(question: RelayQuestion, run: RelayRun): { readonly pass: boolean; readonly error: string | undefined } | undefined {
  if (question.window === undefined) return undefined
  const { from, to, excludeMemoryId } = question.window
  // Find reads whose data_window fits inside the question's window.
  const readsInRange: Array<{ readonly name: string; readonly window: { from: string; to: string }; readonly resultText: string }> = []
  for (const call of run.sgCalls) {
    const w = (call.input['data_window'] ?? call.input['dataWindow']) as unknown
    if (w === undefined || w === null) continue
    if (typeof w !== 'object') continue
    const wFrom = (w as Record<string, unknown>)['from']
    const wTo = (w as Record<string, unknown>)['to']
    if (typeof wFrom !== 'string' || typeof wTo !== 'string') continue
    if (wFrom < from || wTo > to) continue // window crosses outside the question's range
    readsInRange.push({ name: call.name, window: { from: wFrom, to: wTo }, resultText: call.resultText })
  }
  if (readsInRange.length === 0) {
    return { pass: false, error: `no SG read tool carried a data_window ⊆ ${from}..${to} (B either called no read tool, or called one without a window, or the window crossed outside the question's range)` }
  }
  if (excludeMemoryId !== '') {
    const leaks = readsInRange.filter(r => r.resultText.includes(excludeMemoryId))
    if (leaks.length === readsInRange.length) {
      // Every qualifying read contained the excluded memory — L1 fails.
      return { pass: false, error: `every SG read with data_window ⊆ ${from}..${to} returned a result containing memory ${excludeMemoryId} — the window did not filter it out` }
    }
    // Partial leak is allowed under #179's ruling: the question only requires "this call's
    // return did not contain the incident memory", i.e. at least one qualifying read is clean.
  }
  return { pass: true, error: undefined }
}

/** Substrings a host-generated rejection typically contains (#180 R4). The host
 *  rejects a tool call by setting `tool_result.is_error=true` with text like
 *  "Permission confirmation required…" or "approval required"; SG business
 *  errors never use these words. */
const HOST_REJECTION_MARKERS: readonly string[] = [
  'permission',
  'approval',
  'denied',
  'forbidden',
  'unauthorized',
]

/** True if a parsed call looks like the host refused to run it (as opposed
 *  to the SG server returning a business error). Matches any `is_error`
 *  result whose text hits one of the host-rejection markers. */
function isHostRejection(call: RelaySgCall): boolean {
  if (!call.isError) return false
  const needle = call.resultText.toLowerCase()
  return HOST_REJECTION_MARKERS.some(m => needle.includes(m))
}

/** Find the first host-rejection call in a run, returning its tool name and
 *  the rejection text. `undefined` when no rejection is present — caller
 *  should halt the run with an environment error rather than judge it as
 *  FAIL (#180 R4: host-layer rejection is not a B-leg quality signal). */
export function hostRejectionOf(run: RelayRun): { readonly tool: string; readonly text: string } | undefined {
  for (const call of run.sgCalls) {
    if (isHostRejection(call)) return { tool: call.name, text: call.resultText }
  }
  return undefined
}

/** The default A-leg model tier for qodercli runs (#180 R5: A is mechanical
 *  execution — record_memory / import_definitions — so a cheaper tier is
 *  fine). B leg and the control set no default and let qodercli's Auto pick;
 *  `SG_RELAY_QODER_MODEL` overrides everything for debugging only. */
export const A_LEG_DEFAULT_MODEL = 'Efficient'

/**
 * The three relay scenario cards as data (#156's ruling / #128's cards /
 * ADR-0028 R4's E3 revision) — the single source both relay consumers read:
 *
 * - `check-relay.ts` (opt-in, `pnpm relay`) drives the REAL relay from here:
 *   A's write prompt, B's (and the control's) question prompts, and the
 *   judges below; it owns only the legs and the git/fs extraction.
 * - `check-e2e-loop.ts`'s Phase 8 contract stub writes the cards' own payloads
 *   (E3's term concepts, A3's threshold, G3′'s window) and judges them with the
 *   SAME `judgeL0`, plus the replay keywords — so the gate can never drift from
 *   what the real relay judged against (#184).
 *
 * The driver orchestrates legs; this module owns L0/L1/L2 judging. It does no
 * I/O and spawns nothing — L0 reads the corpus through an injected
 * `RelayCorpusReader` and takes pre-parsed commits — which is what keeps it
 * shareable between an opt-in external-LLM driver and the hermetic gate
 * (#157's boundary: the four gates never execute an external LLM call).
 *
 * @module relay-scenarios
 */

/** Which corpus a card runs over (#156's carrier ruling: E3+A3 k11, G3′ X63). */
export type RelayCorpus = 'k11-copy' | 'x63-10000354'

/** A data-window the L1 judge enforces when present (#179's verdict: a window
 *  must fit inside the question's date range and the matching read's result
 *  must not contain the excluded memory). */
export interface RelayWindow {
  /** Inclusive lower bound, `YYYY-MM-DD`. */
  readonly from: string
  /** Inclusive upper bound, `YYYY-MM-DD`. */
  readonly to: string
  /** Memory id that MUST NOT appear in any tool result whose call carried
   *  a window that fits inside this one. Empty on the card (a runtime id);
   *  the driver fills it via `bindWindowExclusion` from A's written ids. */
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

/** One term concept E3's A leg lands (ADR-0028 R1/R2) — its import payload,
 *  its alias, and the column comment it was learned from (verbatim from k11). */
export interface RelayTermConcept {
  readonly name: string
  readonly alias: string
  readonly comment: string
  readonly description: string
  readonly properties: Readonly<Record<string, string>>
}

/** E3's whole promotion as data (#184 ruling 3): what A's prompt asks for, what
 *  the e2e stub writes, and what `judgeL0` checks landed — one source. */
export interface RelayPromotion {
  /** The table whose column comments are the promotion's `source` evidence. */
  readonly sourceTable: string
  readonly concepts: readonly RelayTermConcept[]
  /** The `related_to` edge A adds (`from` → `to`, both concept names). */
  readonly relation: { readonly from: string; readonly to: string; readonly summary: string }
  /** The `evidence.source` text the import declares. */
  readonly evidenceSource: string
}

/** The memory entry a session-only card's A leg must land. */
export interface RelayExpectedMemory {
  readonly type: 'practice' | 'incident'
  /** A substring some anchor must contain. `G3_TARGET_PLACEHOLDER` is replaced by
   *  the runtime target; left unsubstituted (no target known) it is not checked. */
  readonly anchorName: string
  /** A substring the body must contain (A3's threshold). */
  readonly bodyIncludes?: string
  /** The exact `valid_from` / `valid_until` (G3′'s incident day). */
  readonly window?: { readonly from: string; readonly to: string }
}

/** The L0 verdict per card — #156's per-card table plus what must have landed. */
export type RelayL0 =
  /** E3: the promotion commit carries `X-SG-Evidence: source`; no commit in the
   *  segment carries Session or Memory. */
  | { readonly must: 'evidence-source'; readonly promotion: RelayPromotion }
  /** A3/G3′: a `record_memory` commit carrying only `X-SG-Session`. */
  | { readonly must: 'session-only'; readonly memory: RelayExpectedMemory }

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

/** The 口径 A3 fixes in its prompt — also its L0 body check, L2/replay keywords,
 *  and the e2e stub's memory body (one constant, no drift). */
export const A3_THRESHOLD = '500'

/** The concept A3's practice memory anchors on (k11's `concept:付费经济`). */
const A3_CONCEPT = '付费经济'

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

/** The k11 table whose column comments carry the jargon (`c1`/`c2`, #182's rename). */
const E3_SOURCE_TABLE = 'dws_10000251_acc_summary_df'

const E3_CONCEPTS: readonly RelayTermConcept[] = [
  { name: '一级渠道', alias: '1渠', comment: '渠道，又叫1渠', description: '渠道一级分类,对应列 c1。', properties: { column: 'c1', recent_column: 'c1_lst' } },
  { name: '二级渠道', alias: '2渠', comment: '渠道id，又叫2渠', description: '渠道二级分类,隶属一级渠道,对应列 c2。', properties: { column: 'c2', recent_column: 'c2_lst', parent: '一级渠道', parent_column: 'c1' } },
]

/** E3's promotion payload (#184 ruling 3) — the prompt below is rendered from it. */
export const E3_PROMOTION: RelayPromotion = {
  sourceTable: E3_SOURCE_TABLE,
  concepts: E3_CONCEPTS,
  relation: { from: '二级渠道', to: '一级渠道', summary: '隶属上级:一级渠道(1:N),下钻时按 c1, c2 分组' },
  evidenceSource: `${E3_SOURCE_TABLE} 的 ${E3_CONCEPTS.map(c => c.properties['column']).join('/')} 列注释(${E3_CONCEPTS.map(c => c.comment).join(' / ')})`,
}

/** `{column: c1, recent_column: c1_lst}` — the prompt's rendering of a properties map. */
function renderProperties(properties: Readonly<Record<string, string>>): string {
  return `{${Object.entries(properties).map(([k, v]) => `${k}: ${v}`).join(', ')}}`
}

function e3PromptA(p: RelayPromotion): string {
  return [
    '你在参与一个跨 agent 接力测试的写入腿(A 腿)。语义层由 semantic-grounding 的 MCP 服务(服务名 sg)提供;先用 list_scopes / get_scope 确认当前 scope,之后每次写工具调用都带正确的 scope_id。',
    '',
    `背景:业务方说「按 2渠 拆一下」,你从 ${p.sourceTable} 的列注释学到:${p.concepts.map(c => `${c.properties['column']} 注释「${c.comment}」`).join('、')}。业务语义:一个一级渠道下有 1..N 个二级渠道。`,
    '',
    '任务(按顺序,全部经 sg 的 MCP 工具完成):',
    '1. 用 import_definitions 一次性建两个概念(先不要带 alt_labels):',
    ...p.concepts.map((c, i) => `   - ${c.name}:description「${c.description}」,properties ${renderProperties(c.properties)}${i === p.concepts.length - 1 ? '。' : ';'}`),
    `   这次 import_definitions 调用要声明 evidence: {kind: "source", source: "${p.evidenceSource}"}。`,
    `2. 用 add_alias 给 ${p.concepts.map(c => `concept ${c.name} 加别名「${c.alias}」`).join(',给 ')}。`,
    `3. 用 add_relation 给 concept ${p.relation.from} 加一条指向 concept ${p.relation.to} 的 related_to 边,summary 里写「${p.relation.summary}」。`,
    '注意:本环境没有 create_definition 工具(已知宿主限制),不要尝试;import_definitions 的概念项字段名是 name。完成后报告你落了哪些 commit。',
  ].join('\n')
}

const E3_PROMPT_A = e3PromptA(E3_PROMOTION)

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
  `背景:业务方要「大R 留存」,但全语料没有一处定义「大R」是多少钱以上(概念「${A3_CONCEPT}」的 alt_labels 里有「大R」,但无阈值)。本次会话业务方口述了口径。`,
  '',
  `任务:把这条口径用 record_memory 记一条 practice memory:anchors 用 ["concept:${A3_CONCEPT}"],body 写「大R 口径:累计付费 ≥ ${A3_THRESHOLD} 元(2026-10 业务口述,未书面确认)。」,basis 写「业务方在本次会话中口述」。`,
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
  l0: { must: 'evidence-source', promotion: E3_PROMOTION },
  l1: { readTools: READ_TOOLS, trajectoryMentions: ['二级渠道'] },
  replayKeywords: ['concept:二级渠道', 'c2'],
}

/** A3 (k11, qodercli A/B, no script L3): 口径一致性 — B must repeat A's threshold. */
export const A3_SCENARIO: RelayScenario = {
  id: 'a3',
  card: 'A3｜「大R」没有阈值 —— 口径一致性(docs/data-memory-scenarios.md)',
  corpus: 'k11-copy',
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
  l0: { must: 'session-only', memory: { type: 'practice', anchorName: A3_CONCEPT, bodyIncludes: A3_THRESHOLD } },
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
  l3Manual: true,
  // The G3′ prompts are target-table-dependent; check-relay substitutes and
  // judges from these rules. The placeholders below document the shape for readers.
  promptA: g3Prompts(G3_TARGET_PLACEHOLDER).a,
  controlPrompt: undefined,
  questions: [
    { id: 'g3-in-window', prompt: g3Prompts(G3_TARGET_PLACEHOLDER).inWindow, allOf: ['未产出'], anyOf: [G3_INCIDENT_DAY, `${G3_INCIDENT_DAY.slice(5, 7)}月${G3_INCIDENT_DAY.slice(8, 10)}`], negative: [] },
    { id: 'g3-out-window', prompt: g3Prompts(G3_TARGET_PLACEHOLDER).outWindow, allOf: [], anyOf: [], negative: [], window: { from: '2026-09-01', to: '2026-09-30', excludeMemoryId: '' } },
  ],
  l0: { must: 'session-only', memory: { type: 'incident', anchorName: G3_TARGET_PLACEHOLDER, window: G3_WINDOW } },
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

/** Fill a windowed question's empty `excludeMemoryId` with the first memory id
 *  the A leg wrote (#184 ruling 5): the card cannot pin a runtime id, so the
 *  driver binds it before judging B. A question with no window, an already
 *  filled slot, or no written id comes back unchanged. */
export function bindWindowExclusion(question: RelayQuestion, writtenMemoryIds: readonly string[]): RelayQuestion {
  const first = writtenMemoryIds[0]
  if (question.window === undefined || question.window.excludeMemoryId !== '' || first === undefined) return question
  return { ...question, window: { ...question.window, excludeMemoryId: first } }
}

/** L1: B called an SG read tool (zero tool calls + a correct answer = leak =
 * fail), plus the card's trajectory-mentions rule (E3: touched 二级渠道),
 * plus the current question's window assertion (#179, #182). */
export function judgeL1(scenario: RelayScenario, question: RelayQuestion, run: RelayRun): { readonly pass: boolean; readonly error: string | undefined } {
  if (!run.sgCalls.some(c => scenario.l1.readTools.includes(c.name))) {
    return { pass: false, error: `no SG read tool called (called: ${run.sgCalls.map(c => c.name).join(', ') || 'none'} — a correct answer without a read is a leak)` }
  }
  const trajectory = `${run.trajectoryText}\n${JSON.stringify(run.sgCalls.map(c => ({ name: c.name, input: c.input })))}`
  for (const mention of scenario.l1.trajectoryMentions) {
    if (!trajectory.includes(mention)) return { pass: false, error: `trajectory never mentions "${mention}"` }
  }
  // Window assertion for THIS question only (#179, #182: each B run asks one
  // question — don't apply other questions' window rules).
  if (question.window !== undefined) {
    const w = judgeWindow(question, run)
    if (w !== undefined && !w.pass) return { pass: false, error: `${question.id}: ${w.error}` }
  }
  return { pass: true, error: undefined }
}

/** One corpus commit as L0 reads it — the driver parses git `%(trailers)`, the
 *  e2e stub adapts the recorder's receipt; both strip the `X-SG-` prefix. */
export interface RelayCommit {
  readonly sha: string
  readonly subject: string
  readonly trailers: Readonly<Record<string, string>>
}

/** The corpus as L0 reads it (#184 ruling 2), relative to the semantic-layer root. */
export interface RelayCorpusReader {
  /** Parse one YAML file. */
  yaml(rel: string): unknown
  exists(rel: string): boolean
  /** The `memory/…` paths a commit touched. */
  memoryFilesOf(sha: string): readonly string[]
}

/** One card's L0 verdict. */
export interface RelayL0Result {
  readonly pass: boolean
  readonly commits: readonly RelayCommit[]
  readonly error: string | undefined
  /** Memory ids this card's A leg wrote — bound into the window exclusion and
   *  surfaced for the `--purge` guard. */
  readonly writtenMemoryIds: readonly string[]
}

/** Judge one card's L0 (#156's per-card table) over the commits of ITS segment
 *  only — callers sharing one git history across cards must cut it per card.
 *  `g3Target` replaces `G3_TARGET_PLACEHOLDER` in the expected anchor. */
export function judgeL0(scenario: RelayScenario, commits: readonly RelayCommit[], reader: RelayCorpusReader, g3Target?: string): RelayL0Result {
  const writtenMemoryIds: string[] = []
  const fail = (error: string): RelayL0Result => ({ pass: false, commits, error, writtenMemoryIds })
  const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value : []).map(String)
  const l0 = scenario.l0
  if (l0.must === 'evidence-source') {
    const { promotion } = l0
    const promo = commits.find(c => c.trailers['Evidence'] === 'source')
    if (promo === undefined) return fail('no commit carries X-SG-Evidence: source — the A leg did not declare the promotion')
    const child = promotion.concepts.find(c => c.name === promotion.relation.from)
    const column = child?.properties['column'] ?? ''
    if (!(promo.trailers['Evidence-Source'] ?? '').includes(column)) return fail(`X-SG-Evidence-Source does not name the ${column} column comment`)
    for (const c of commits) {
      if (c.trailers['Memory'] !== undefined) return fail(`commit ${c.sha.slice(0, 7)} carries X-SG-Memory (E3: 确定性直升,无 memory 引用)`)
      if (c.trailers['Session'] !== undefined) return fail(`commit ${c.sha.slice(0, 7)} carries X-SG-Session (E3 per #156: 仅 X-SG-Evidence: source)`)
    }
    for (const { name, alias } of promotion.concepts) {
      const rel = `concepts/${name}.yaml`
      if (!reader.exists(rel)) return fail(`${rel} not landed`)
      if (!strings(record(reader.yaml(rel))['alt_labels']).includes(alias)) return fail(`concept ${name} is missing its alias "${alias}"`)
    }
    const { from, to } = promotion.relation
    const refs = record(reader.yaml(`concepts/${from}.yaml`))['related_refs']
    if (!(Array.isArray(refs) ? refs : []).some(r => record(r)['target_kind'] === 'concept' && record(r)['target'] === to)) return fail(`concept ${from} has no related_to edge to ${to}`)
    return { pass: true, commits, error: undefined, writtenMemoryIds }
  }
  // A3 / G3′: a record_memory commit carrying ONLY X-SG-Session (never a promotion)
  const { memory } = l0
  const mem = commits.find(c => c.trailers['Tool'] === 'record_memory')
  if (mem === undefined) return fail('no record_memory commit landed')
  if (mem.trailers['Session'] === undefined) return fail('the record_memory commit carries no X-SG-Session')
  for (const c of commits) {
    if (c.trailers['Evidence'] !== undefined) return fail(`commit ${c.sha.slice(0, 7)} carries X-SG-Evidence (per #156: A3/G3′ 仅 X-SG-Session,不晋升)`)
    if (c.trailers['Memory'] !== undefined) return fail(`commit ${c.sha.slice(0, 7)} carries X-SG-Memory`)
  }
  const memoryFiles = reader.memoryFilesOf(mem.sha)
  if (memoryFiles.length === 0) return fail('no memory/ file found in the record_memory commit')
  const anchorName = memory.anchorName === G3_TARGET_PLACEHOLDER ? g3Target : memory.anchorName
  let sawExpected = false
  for (const rel of memoryFiles) {
    const entry = record(reader.yaml(rel))
    if (entry['type'] !== memory.type) continue
    if (anchorName !== undefined && !strings(entry['anchors']).some(a => a.includes(anchorName))) continue
    if (memory.bodyIncludes !== undefined && !(typeof entry['body'] === 'string' && entry['body'].includes(memory.bodyIncludes))) continue
    if (memory.window !== undefined && (entry['valid_from'] !== memory.window.from || entry['valid_until'] !== memory.window.to)) continue
    sawExpected = true
    if (entry['promoted'] !== undefined) return fail(`the ${memory.type} memory carries \`promoted\` (${scenario.id}: 不晋升)`)
    const idMatch = /memory\/(mem-[^/]+)\.yaml$/.exec(rel)
    if (idMatch?.[1] !== undefined) writtenMemoryIds.push(idMatch[1])
  }
  if (!sawExpected) return fail('no memory entry matches the card (type / anchors / window)')
  return { pass: true, commits, error: undefined, writtenMemoryIds }
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

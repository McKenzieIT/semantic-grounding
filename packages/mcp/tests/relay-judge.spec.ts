/**
 * Pure judges over the relay scenario cards (#157 opt-in script):
 * - `judgeAnswer` — L2 keyword verdicts (allOf / anyOf / negative).
 * - `judgeWindow` — L1 per-question window assertion (#179).
 * - `hostRejectionOf` — host-layer rejection detection (#180 R4).
 * - `judgeL0` / `judgeL1` / `bindWindowExclusion` — the L0 per-card table over
 *   pre-parsed commits + an injected corpus reader, the L1 trajectory judge,
 *   and the runtime exclusion binding (#184).
 *
 * These functions live in `scripts/relay-scenarios.ts` (the script-only
 * module both consumers share — no I/O, no process spawning).
 * The unit suite reaches them directly; the four gates never execute a
 * live qodercli invocation (#157's boundary).
 *
 * The ticket's 5 cases (#181 item 14):
 * - window present + empty result → pass
 * - no window → fail (no qualifying read)
 * - window spanning outside September → fail
 * - window + the answer-quoting self-check from #179 → pass
 * - host rejection → halts with an environment error rather than judging FAIL
 *
 * @module tests/relay-judge.spec
 */
import { describe, expect, it } from 'vitest'
import {
  A3_SCENARIO,
  A3_THRESHOLD,
  bindWindowExclusion,
  E3_PROMOTION,
  E3_SCENARIO,
  G3_SCENARIO,
  G3_WINDOW,
  hostRejectionOf,
  judgeAnswer,
  judgeL0,
  judgeL1,
  judgeWindow,
  type RelayCommit,
  type RelayCorpusReader,
  type RelayQuestion,
  type RelayRun,
  type RelaySgCall,
} from '../scripts/relay-scenarios.ts'

/** Build a minimal call matching `RelaySgCall`. */
function call(over: Partial<RelaySgCall> & { readonly name: string; readonly input: Record<string, unknown> }): RelaySgCall {
  return { resultText: '', isError: false, ...over }
}

/** Build a minimal run matching `RelayRun`. */
function run(sgCalls: readonly RelaySgCall[], extras: { readonly answer?: string; readonly trajectoryText?: string; readonly credits?: number } = {}): RelayRun {
  return {
    sgCalls,
    trajectoryText: extras.trajectoryText ?? '',
    answer: extras.answer ?? '',
    credits: extras.credits,
  }
}

describe('judgeAnswer (L2)', () => {
  const q: RelayQuestion = {
    id: 'q',
    prompt: 'p',
    allOf: ['foo'],
    anyOf: ['bar', 'baz'],
    negative: ['leak'],
  }

  it('passes when allOf is hit, anyOf is hit, and negative is absent', () => {
    expect(judgeAnswer(q, 'the foo answer and bar').pass).toBe(true)
  })

  it('fails when an allOf keyword is missing', () => {
    const r = judgeAnswer(q, 'just bar')
    expect(r.pass).toBe(false)
    expect(r.misses).toContain('foo')
  })

  it('fails when a negative keyword leaks in', () => {
    const r = judgeAnswer(q, 'foo bar leak')
    expect(r.pass).toBe(false)
    expect(r.misses.some(m => m.includes('leak'))).toBe(true)
  })
})

describe('judgeWindow (L1 per-question assertion, #179)', () => {
  const outWindowQuestion = G3_SCENARIO.questions.find(q => q.id === 'g3-out-window')
  if (outWindowQuestion === undefined) throw new Error('g3-out-window missing')
  // Inject the incident memory id for the tests below, as the driver does at
  // runtime via bindWindowExclusion (the card leaves it empty — a runtime id).
  const questionWithIncident: RelayQuestion = {
    ...outWindowQuestion,
    window: { ...(outWindowQuestion.window as NonNullable<RelayQuestion['window']>), excludeMemoryId: 'mem-20261010-incident' },
  }

  it('passes when at least one read with a data_window inside the range returns a clean result', () => {
    const r = run([
      call({ name: 'get_definition', input: { data_window: { from: '2026-09-01', to: '2026-09-30' } }, resultText: 'no incident here' }),
    ])
    const w = judgeWindow(questionWithIncident, r)
    expect(w).toBeDefined()
    expect(w?.pass).toBe(true)
  })

  it('fails when no read carried a data_window at all', () => {
    const r = run([
      call({ name: 'get_definition', input: {} }),
    ])
    const w = judgeWindow(questionWithIncident, r)
    expect(w).toBeDefined()
    expect(w?.pass).toBe(false)
    expect(w?.error).toMatch(/no SG read tool carried a data_window/)
  })

  it('fails when every qualifying read contains the excluded memory id', () => {
    const r = run([
      call({ name: 'get_definition', input: { data_window: { from: '2026-09-01', to: '2026-09-30' } }, resultText: 'the mem-20261010-incident leaked in' }),
    ])
    const w = judgeWindow(questionWithIncident, r)
    expect(w).toBeDefined()
    expect(w?.pass).toBe(false)
    expect(w?.error).toMatch(/memory mem-20261010-incident/)
  })

  it('fails when the data_window spans outside September', () => {
    const r = run([
      call({ name: 'get_definition', input: { data_window: { from: '2026-08-15', to: '2026-09-30' } }, resultText: 'clean' }),
    ])
    const w = judgeWindow(questionWithIncident, r)
    expect(w).toBeDefined()
    expect(w?.pass).toBe(false)
    expect(w?.error).toMatch(/crossed outside/)
  })

  it('returns undefined when the question declares no window (caller skips)', () => {
    const q: RelayQuestion = { id: 'q', prompt: 'p', allOf: [], anyOf: [], negative: [] }
    expect(judgeWindow(q, run([]))).toBeUndefined()
  })
})

describe('hostRejectionOf (#180 R4: env-error, never a FAIL)', () => {
  it('returns undefined when no call is marked as an error', () => {
    expect(hostRejectionOf(run([
      call({ name: 'search_definitions', input: {}, resultText: 'some result' }),
    ]))).toBeUndefined()
  })

  it('detects a host-layer permission rejection', () => {
    const r = run([
      call({ name: 'get_definition', input: {}, isError: true, resultText: 'Permission confirmation required but no interactive handler is available' }),
    ])
    const hit = hostRejectionOf(r)
    expect(hit).toBeDefined()
    expect(hit?.tool).toBe('get_definition')
  })

  it('does not mistake an SG business error for a host rejection', () => {
    const r = run([
      call({ name: 'get_definition', input: {}, isError: true, resultText: 'definition_not_found: no such table "foo"' }),
    ])
    expect(hostRejectionOf(r)).toBeUndefined()
  })
})

/** `E3_PROMPT_A` as it stood before the payload moved onto the card (#184 ruling 3):
 *  the rendered prompt must stay byte-identical, so the real relay's A leg is unchanged. */
const E3_PROMPT_A_FROZEN = [
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

describe('E3 payload on the card (#184 ruling 3)', () => {
  it('renders A\'s prompt byte-identical to the pre-#184 text', () => {
    expect(E3_SCENARIO.promptA).toBe(E3_PROMPT_A_FROZEN)
  })

  it('names the k11 fixture\'s real columns, never the retired ch_type/ch_id', () => {
    expect(E3_PROMOTION.concepts.map(c => c.properties['column'])).toEqual(['c1', 'c2'])
    expect(JSON.stringify(E3_PROMOTION)).not.toMatch(/ch_type|ch_id/)
  })
})

/** An in-memory corpus for judgeL0: path → parsed YAML, plus commit → memory files. */
function reader(files: Record<string, unknown>, memoryFiles: Record<string, readonly string[]> = {}): RelayCorpusReader {
  return {
    yaml: rel => files[rel],
    exists: rel => rel in files,
    memoryFilesOf: sha => memoryFiles[sha] ?? [],
  }
}

function commit(sha: string, trailers: Record<string, string>): RelayCommit {
  return { sha, subject: `subject ${sha}`, trailers }
}

describe('judgeL0 (#156 per-card table, #184 reader injection)', () => {
  const e3Files = (): Record<string, unknown> => ({
    'concepts/一级渠道.yaml': { name: '一级渠道', alt_labels: ['1渠'] },
    'concepts/二级渠道.yaml': { name: '二级渠道', alt_labels: ['2渠'], related_refs: [{ target_kind: 'concept', target: '一级渠道' }] },
  })
  const e3Commits = [
    commit('aaaaaaa1', { Tool: 'import_definitions', Evidence: 'source', 'Evidence-Source': E3_PROMOTION.evidenceSource }),
    commit('aaaaaaa2', { Tool: 'add_alias' }),
    commit('aaaaaaa3', { Tool: 'add_relation' }),
  ]

  it('E3 passes on the card\'s own payload', () => {
    const v = judgeL0(E3_SCENARIO, e3Commits, reader(e3Files()))
    expect(v.error).toBeUndefined()
    expect(v.pass).toBe(true)
  })

  it('E3 fails when any segment commit carries X-SG-Session (cross-segment pollution)', () => {
    const v = judgeL0(E3_SCENARIO, [...e3Commits, commit('aaaaaaa4', { Tool: 'record_memory', Session: 's1' })], reader(e3Files()))
    expect(v.pass).toBe(false)
    expect(v.error).toMatch(/X-SG-Session/)
  })

  it('E3 fails when the evidence source does not name the child concept\'s column', () => {
    const commits = [commit('aaaaaaa1', { Evidence: 'source', 'Evidence-Source': '某表的 ch_type 列注释' })]
    const v = judgeL0(E3_SCENARIO, commits, reader(e3Files()))
    expect(v.error).toMatch(/c2 column comment/)
  })

  it('E3 fails when the related_to edge is missing', () => {
    const files = e3Files()
    files['concepts/二级渠道.yaml'] = { name: '二级渠道', alt_labels: ['2渠'] }
    expect(judgeL0(E3_SCENARIO, e3Commits, reader(files)).error).toMatch(/no related_to edge/)
  })

  const a3Mem = 'memory/mem-20261017-aaaaaaaa.yaml'
  const a3Commits = [commit('bbbbbbb1', { Tool: 'record_memory', Session: 's1' })]

  it('A3 passes and reports the written memory id', () => {
    const files = { [a3Mem]: { type: 'practice', anchors: ['concept:付费经济'], body: `大R 口径:累计付费 ≥ ${A3_THRESHOLD} 元` } }
    const v = judgeL0(A3_SCENARIO, a3Commits, reader(files, { bbbbbbb1: [a3Mem] }))
    expect(v.pass).toBe(true)
    expect(v.writtenMemoryIds).toEqual(['mem-20261017-aaaaaaaa'])
  })

  it('A3 fails when the body lacks the card threshold, or a commit promotes', () => {
    const wrongBody = { [a3Mem]: { type: 'practice', anchors: ['concept:付费经济'], body: '大R 口径:累计付费 ≥ 1000 元' } }
    expect(judgeL0(A3_SCENARIO, a3Commits, reader(wrongBody, { bbbbbbb1: [a3Mem] })).error).toMatch(/no memory entry matches/)
    const right = { [a3Mem]: { type: 'practice', anchors: ['concept:付费经济'], body: `≥ ${A3_THRESHOLD}` } }
    const promoting = [...a3Commits, commit('bbbbbbb2', { Tool: 'create_verified_query', Evidence: 'user-stated', Memory: 'mem-20261017-aaaaaaaa' })]
    expect(judgeL0(A3_SCENARIO, promoting, reader(right, { bbbbbbb1: [a3Mem] })).error).toMatch(/X-SG-Evidence/)
  })

  const g3Mem = 'memory/mem-20261017-gggggggg.yaml'
  const g3Commits = [commit('ccccccc1', { Tool: 'record_memory', Session: 's2' })]
  const g3Entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    [g3Mem]: { type: 'incident', anchors: ['table:dws_target'], body: '未产出', valid_from: G3_WINDOW.from, valid_until: G3_WINDOW.to, ...over },
  })

  it('G3′ passes with the runtime target, and fails on another table\'s incident', () => {
    expect(judgeL0(G3_SCENARIO, g3Commits, reader(g3Entry(), { ccccccc1: [g3Mem] }), 'dws_target').writtenMemoryIds).toEqual(['mem-20261017-gggggggg'])
    expect(judgeL0(G3_SCENARIO, g3Commits, reader(g3Entry(), { ccccccc1: [g3Mem] }), 'dws_other').pass).toBe(false)
  })

  it('G3′ fails when the incident window is not the card\'s, or it carries promoted', () => {
    expect(judgeL0(G3_SCENARIO, g3Commits, reader(g3Entry({ valid_until: '2026-10-11' }), { ccccccc1: [g3Mem] }), 'dws_target').pass).toBe(false)
    expect(judgeL0(G3_SCENARIO, g3Commits, reader(g3Entry({ promoted: ['query:x'] }), { ccccccc1: [g3Mem] }), 'dws_target').error).toMatch(/promoted/)
  })
})

describe('bindWindowExclusion (#184 ruling 5)', () => {
  const outWindow = G3_SCENARIO.questions.find(q => q.id === 'g3-out-window')
  const inWindow = G3_SCENARIO.questions.find(q => q.id === 'g3-in-window')
  if (outWindow === undefined || inWindow === undefined) throw new Error('g3 questions missing')

  it('fills the empty slot with the first written id; leaves windowless questions and empty id lists alone', () => {
    expect(bindWindowExclusion(outWindow, ['mem-a', 'mem-b']).window?.excludeMemoryId).toBe('mem-a')
    expect(bindWindowExclusion(inWindow, ['mem-a'])).toBe(inWindow)
    expect(bindWindowExclusion(outWindow, [])).toBe(outWindow)
    expect(outWindow.window?.excludeMemoryId).toBe('')
  })

  it('never overwrites an already-filled slot', () => {
    const filled = bindWindowExclusion(outWindow, ['mem-a'])
    expect(bindWindowExclusion(filled, ['mem-b']).window?.excludeMemoryId).toBe('mem-a')
  })
})

describe('judgeL1 (#129 layer 1 + #179 window, #184 sinking)', () => {
  const outWindow = G3_SCENARIO.questions.find(q => q.id === 'g3-out-window')
  if (outWindow === undefined) throw new Error('g3-out-window missing')
  const e3Main = E3_SCENARIO.questions[0]
  if (e3Main === undefined) throw new Error('e3-main missing')
  const sept = { data_window: { from: '2026-09-01', to: '2026-09-30' } }

  it('fails a correct-looking answer with no SG read (leak)', () => {
    expect(judgeL1(E3_SCENARIO, e3Main, run([call({ name: 'list_scopes', input: {} })])).error).toMatch(/no SG read tool called/)
  })

  it('enforces the card\'s trajectory mention (E3: 二级渠道)', () => {
    expect(judgeL1(E3_SCENARIO, e3Main, run([call({ name: 'search_definitions', input: { query: '渠道' } })])).error).toMatch(/二级渠道/)
    expect(judgeL1(E3_SCENARIO, e3Main, run([call({ name: 'resolve_alias', input: { term: '2渠' } })], { trajectoryText: 'concept:二级渠道' })).pass).toBe(true)
  })

  it('the bound exclusion is live: a windowed read returning A\'s incident now fails', () => {
    const leaking = run([call({ name: 'get_definition', input: sept, resultText: 'mem-incident 未产出' })])
    expect(judgeL1(G3_SCENARIO, outWindow, leaking).pass).toBe(true) // card as-is: the exclusion sleeps
    expect(judgeL1(G3_SCENARIO, bindWindowExclusion(outWindow, ['mem-incident']), leaking).error).toMatch(/memory mem-incident/)
  })
})

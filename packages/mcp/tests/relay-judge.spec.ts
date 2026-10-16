/**
 * Pure judges over the relay scenario cards (#157 opt-in script):
 * - `judgeAnswer` — L2 keyword verdicts (allOf / anyOf / negative).
 * - `judgeWindow` — L1 per-question window assertion (#179).
 * - `hostRejectionOf` — host-layer rejection detection (#180 R4).
 *
 * These functions live in `scripts/relay-scenarios.ts` (the script-only,
 * data-only module both consumers share — no I/O, no process spawning).
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
  G3_SCENARIO,
  hostRejectionOf,
  judgeAnswer,
  judgeWindow,
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
  // Inject the incident memory id for the tests below (the card leaves it empty
  // to avoid pinning a runtime id).
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

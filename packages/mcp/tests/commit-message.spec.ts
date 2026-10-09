/**
 * ADR-0004 ruling 10 — the commit message shape.
 *
 * The audit record's readable half, and the half that is hardest to change later: a
 * trailer that stops parsing, or a tool name that changes meaning, rewrites the
 * semantics of every commit already in the corpus's history. These tests pin the format
 * so that change has to be deliberate.
 *
 * @see docs/adr/0004-git-tier2-audit-backbone.md ruling 10
 */
import { describe, expect, it } from 'vitest'
import {
  buildCommitMessage,
  buildSubject,
  buildTrailers,
  formatConfidence,
  TRAILER_SCHEMA_VERSION,
  type CommitContext,
} from '../src/git/message.ts'

const base: CommitContext = {
  tool: 'add_alias',
  target: 'dws_pay_order_di',
  summary: '添加别名「订单宽表」',
  derivation: 'agent',
  confidence: 0.85,
  agentId: 'analyst-agent-7',
  clientName: 'claude-code',
  scopeId: 'k11',
  sessionId: 'sess-01JD',
}

describe('subject — <tool>(<target>): <summary>', () => {
  it('renders the ruled format', () => {
    expect(buildSubject(base)).toBe('add_alias(dws_pay_order_di): 添加别名「订单宽表」')
  })

  // The trailer block is only recognised as git trailers when it is the message's LAST
  // paragraph. A newline anywhere in the subject pushes the trailers into a different
  // paragraph and they silently stop parsing — the failure mode is invisible until
  // someone tries to audit the history, which is exactly when it is too late.
  it('folds a multi-line summary onto one line', () => {
    const subject = buildSubject({ ...base, summary: 'first line\n\nsecond paragraph' })
    expect(subject).not.toContain('\n')
    expect(subject).toBe('add_alias(dws_pay_order_di): first line second paragraph')
  })

  it('truncates visibly rather than silently', () => {
    const subject = buildSubject({ ...base, summary: 'x'.repeat(500) })
    expect(subject.endsWith('…')).toBe(true)
  })
})

describe('trailers', () => {
  it('emits the ruled set, schema version first', () => {
    expect(buildTrailers(base)).toEqual([
      `X-SG-Schema: ${TRAILER_SCHEMA_VERSION}`,
      'X-SG-Tool: add_alias',
      'X-SG-Derivation: agent',
      'X-SG-Confidence: 0.85',
      'X-SG-Agent: analyst-agent-7',
      'X-SG-Client: claude-code',
      'X-SG-Scope: k11',
      'X-SG-Session: sess-01JD',
    ])
  })

  it('omits absent optional trailers instead of emitting them empty', () => {
    const lines = buildTrailers({
      tool: 'create_definition',
      target: 'dim_shop',
      summary: '新表首次落地',
      derivation: 'agent',
      confidence: 1,
      agentId: 'a1',
    })
    expect(lines.some(l => l.startsWith('X-SG-Client'))).toBe(false)
    expect(lines.some(l => l.startsWith('X-SG-Scope'))).toBe(false)
    expect(lines.some(l => l.startsWith('X-SG-Session'))).toBe(false)
    // These four are unconditional: the audit record is not interpretable without them.
    expect(lines.some(l => l.startsWith('X-SG-Schema'))).toBe(true)
    expect(lines.some(l => l.startsWith('X-SG-Tool'))).toBe(true)
    expect(lines.some(l => l.startsWith('X-SG-Derivation'))).toBe(true)
    expect(lines.some(l => l.startsWith('X-SG-Confidence'))).toBe(true)
  })

  // Batch-only trailers (ruling 10's "批量另加"). The format is settled here so #21's
  // `beginBatch` only has to add staging mechanics, not renegotiate the message shape.
  it('adds Files/Rounds for a batch commit', () => {
    const lines = buildTrailers({ ...base, files: 302, rounds: 2 })
    expect(lines).toContain('X-SG-Files: 302')
    expect(lines).toContain('X-SG-Rounds: 2')
  })

  it('keeps a trailer value on one line', () => {
    const lines = buildTrailers({ ...base, sessionId: 'a\nb' })
    expect(lines).toContain('X-SG-Session: a b')
  })
})

describe('confidence formatting', () => {
  it('keeps a plain value as written', () => {
    expect(formatConfidence(0.85)).toBe('0.85')
    expect(formatConfidence(1)).toBe('1')
    expect(formatConfidence(0)).toBe('0')
  })

  // `String(0.1 + 0.2)` is "0.30000000000000004". A trailer is read by humans auditing
  // history, and three decimals is already finer than a self-reported confidence means.
  it('rounds float noise away', () => {
    expect(formatConfidence(0.1 + 0.2)).toBe('0.3')
  })

  it('clamps out-of-range input instead of recording it', () => {
    expect(formatConfidence(1.5)).toBe('1')
    expect(formatConfidence(-2)).toBe('0')
    expect(formatConfidence(Number.NaN)).toBe('0')
  })
})

describe('full message', () => {
  it('separates subject and trailer block by exactly one blank line', () => {
    const message = buildCommitMessage(base)
    const [subject, blank, ...trailers] = message.trimEnd().split('\n')
    expect(subject).toBe('add_alias(dws_pay_order_di): 添加别名「订单宽表」')
    expect(blank).toBe('')
    // Every remaining line must be a trailer: git needs the last paragraph to be
    // trailers-only for `%(trailers)` to find them.
    expect(trailers.every(l => l.startsWith('X-SG-'))).toBe(true)
  })
})

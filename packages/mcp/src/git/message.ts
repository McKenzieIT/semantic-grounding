/**
 * Commit message assembly — the audit record's readable half (ADR-0004 ruling 10).
 *
 * ## Shape
 *
 * ```
 * add_alias(dws_pay_order_di): 添加别名「订单宽表」
 *
 * X-SG-Schema: 1
 * X-SG-Tool: add_alias
 * X-SG-Derivation: agent
 * X-SG-Confidence: 0.85
 * X-SG-Agent: analyst-agent-7
 * X-SG-Client: claude-code
 * X-SG-Scope: k11
 * X-SG-Session: 01JD...
 * ```
 *
 * Subject is `<tool>(<target>): <summary>` — the tool name is the audit verb, which is
 * why ADR-0005 treats renaming a tool as rewriting the history's semantics. Everything
 * machine-readable is a `X-SG-*` trailer, parsed back by git natively
 * (`git log --format='%(trailers:key=X-SG-Derivation,valueonly)'`) with no custom parser.
 *
 * Ruling 10 rejected a sidecar JSON file for the same reason ruling 5 rejected a JSONL
 * fallback recorder: it would split "what changed" from "why it changed" into two
 * datasets that can disagree. A trailer cannot drift from its commit.
 *
 * ## Two things that look like bugs and are not
 *
 * **`derivation` admits three values here, two at the tool layer.** The trailer domain is
 * `deterministic | llm | agent` (ruling 10), because server-internal enrichment rounds
 * commit as `deterministic`. The *tool* schema narrows to `agent | llm` (ADR-0005 ruling
 * 7): `deterministic` is a server-internal flow category, and exposing it to an agent
 * would hand it a way to label its own guess as a derived fact.
 *
 * **Everything is forced onto one line.** git recognises a trailer block only as the
 * message's last paragraph, so a newline inside a summary or a scope id would push the
 * trailers out of that paragraph and silently stop them parsing. Folding happens here,
 * once, rather than being an invariant every caller has to remember.
 *
 * @module git/message
 */

/** Trailer schema version — bumped only when the trailer set changes shape (ruling 10). */
export const TRAILER_SCHEMA_VERSION = 1

/** Prefix for every trailer this package writes. */
export const TRAILER_PREFIX = 'X-SG-'

/**
 * How a commit's content came to be, as recorded in `X-SG-Derivation`.
 *
 * - `deterministic` — a substrate enrichment round derived it; no model involved.
 * - `llm` — a model produced it (an enrichment work item completed by the agent's model).
 * - `agent` — the connecting agent asserted it as its own judgement.
 */
export type Derivation = 'deterministic' | 'llm' | 'agent'

/** The three legal `X-SG-Derivation` values, for validation at the edges. */
export const DERIVATIONS: readonly Derivation[] = ['deterministic', 'llm', 'agent']

/**
 * Everything one audit commit records. Assembled by the tool layer, which is the only
 * place that knows the *intent* behind a write.
 *
 * `summary`, `derivation` and `confidence` are all required rather than optional, which
 * pushes ADR-0005 ruling 7 into the type system: the ruling rejected an optional
 * confidence on the grounds that the trailer slot exists unconditionally, so "a rough
 * honest estimate" must beat "a default". A type that allows omission re-opens exactly
 * that door.
 */
export interface CommitContext {
  /** The intent tool that drove this write; becomes the subject's verb. */
  readonly tool: string
  /** What was written — a table/event name, or a short phrase for a multi-target write. */
  readonly target: string
  /** One line stating what changed and on what basis. Never server-synthesized (ADR-0005 ruling 8). */
  readonly summary: string
  /** How the content came to be; see {@link Derivation}. */
  readonly derivation: Derivation
  /** The caller's own confidence, 0–1. */
  readonly confidence: number
  /** The writing agent, as declared at startup (also the commit author). */
  readonly agentId: string
  /** The client application name, from `_meta.clientInfo.name` — reference only, not identity. */
  readonly clientName?: string
  /** The scope this corpus process serves (v1: one process, one scope). */
  readonly scopeId?: string
  /** The session this write belongs to, when the caller tracks one. */
  readonly sessionId?: string
  /** Files in this commit — batch commits only (`beginBatch`, #21). */
  readonly files?: number
  /** Enrichment rounds folded into this commit — batch commits only. */
  readonly rounds?: number
}

/**
 * Upper bound on the subject's summary. ADR-0005 validates 1–100 characters at the tool
 * layer; this is the recorder's own backstop against a non-tool caller, set generously
 * so it never fires on a legitimate summary. Truncation appends `…` rather than cutting
 * silently — a shortened audit summary must be visibly shortened.
 */
const MAX_SUMMARY_CHARS = 200

/** Upper bound on one trailer value, same reasoning as {@link MAX_SUMMARY_CHARS}. */
const MAX_TRAILER_CHARS = 200

/**
 * Collapse a value to a single clean line.
 * @param value - the raw text.
 * @param max - maximum characters before visible truncation.
 * @returns the text with all whitespace runs (newlines included) folded to single
 *   spaces, trimmed, and truncated with a trailing `…` when it exceeds `max`.
 */
function oneLine(value: string, max: number): string {
  const folded = value.replace(/\s+/g, ' ').trim()
  return folded.length <= max ? folded : `${folded.slice(0, max - 1)}…`
}

/**
 * Render the subject line: `<tool>(<target>): <summary>`.
 * @param ctx - the commit context.
 * @returns the single-line subject.
 */
export function buildSubject(ctx: Pick<CommitContext, 'tool' | 'target' | 'summary'>): string {
  const tool = oneLine(ctx.tool, 64)
  const target = oneLine(ctx.target, 128)
  const summary = oneLine(ctx.summary, MAX_SUMMARY_CHARS)
  return `${tool}(${target}): ${summary}`
}

/**
 * Format confidence for a trailer.
 * @param confidence - the caller's 0–1 confidence.
 * @returns the value clamped to 0–1 and rounded to 3 decimals. Rounding is for
 *   readability, not precision: `String(0.1 + 0.2)` is `"0.30000000000000004"`, and
 *   three decimals is already finer than a self-reported confidence means. A non-finite
 *   input becomes `0` — the honest reading of "the caller could not say".
 */
export function formatConfidence(confidence: number): string {
  if (!Number.isFinite(confidence)) return '0'
  const clamped = Math.min(1, Math.max(0, confidence))
  return String(Number(clamped.toFixed(3)))
}

/**
 * Build the `X-SG-*` trailer lines, in ruling 10's order.
 *
 * `Schema` leads so a reader knows the shape before interpreting the rest. Optional
 * trailers are omitted entirely when absent rather than emitted empty: `git log
 * --format='%(trailers:key=X-SG-Scope,valueonly)'` returns nothing either way, and an
 * empty value reads like a recorded blank rather than an absence.
 * @param ctx - the commit context.
 * @returns the trailer lines, without the separating blank line.
 */
export function buildTrailers(ctx: CommitContext): string[] {
  const lines: string[] = [
    `${TRAILER_PREFIX}Schema: ${TRAILER_SCHEMA_VERSION}`,
    `${TRAILER_PREFIX}Tool: ${oneLine(ctx.tool, MAX_TRAILER_CHARS)}`,
    `${TRAILER_PREFIX}Derivation: ${ctx.derivation}`,
    `${TRAILER_PREFIX}Confidence: ${formatConfidence(ctx.confidence)}`,
    `${TRAILER_PREFIX}Agent: ${oneLine(ctx.agentId, MAX_TRAILER_CHARS)}`,
  ]
  if (ctx.clientName !== undefined && ctx.clientName.trim() !== '') {
    lines.push(`${TRAILER_PREFIX}Client: ${oneLine(ctx.clientName, MAX_TRAILER_CHARS)}`)
  }
  if (ctx.scopeId !== undefined && ctx.scopeId.trim() !== '') {
    lines.push(`${TRAILER_PREFIX}Scope: ${oneLine(ctx.scopeId, MAX_TRAILER_CHARS)}`)
  }
  if (ctx.sessionId !== undefined && ctx.sessionId.trim() !== '') {
    lines.push(`${TRAILER_PREFIX}Session: ${oneLine(ctx.sessionId, MAX_TRAILER_CHARS)}`)
  }
  // Batch-only trailers (ruling 10's "批量另加"). The format is settled here so #21's
  // `beginBatch` adds staging mechanics and nothing about the message shape.
  if (ctx.files !== undefined) lines.push(`${TRAILER_PREFIX}Files: ${Math.max(0, Math.trunc(ctx.files))}`)
  if (ctx.rounds !== undefined) lines.push(`${TRAILER_PREFIX}Rounds: ${Math.max(0, Math.trunc(ctx.rounds))}`)
  return lines
}

/**
 * Assemble the full commit message: subject, blank line, trailer block.
 * @param ctx - the commit context.
 * @returns the message text, piped to `git commit -F -` (never passed as an argument,
 *   so a summary containing anything at all stays data).
 */
export function buildCommitMessage(ctx: CommitContext): string {
  return `${buildSubject(ctx)}\n\n${buildTrailers(ctx).join('\n')}\n`
}

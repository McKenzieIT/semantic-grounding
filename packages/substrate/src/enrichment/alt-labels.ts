/**
 * The alt_labels enrichment family's pure machinery (CL-1 Phase 3, G3
 * 同构): target projection, the two discovery rounds, the extractor
 * guardrail, and the union merge. Moved verbatim out of `enrichment.ts`
 * (map #64 / ticket #65) so the kind adapters in `table-adapter.ts` /
 * `event-adapter.ts` can build on it without cycling the barrel —
 * `enrichment.ts` re-exports every public name, so external import paths
 * are unchanged (ADR-0002).
 *
 * @module enrichment/alt-labels (internal; only `"."` is importable — see ADR-0002)
 */
import type { TableDefinition, EventDefinition } from '../types.ts'
import { normalizeLabel } from '../io.ts'
import type { LlmCall } from './types.ts'

// ── Types ───────────────────────────────────────────────────────────────

/** A definition summary for alt_labels enrichment (works for both tables and events). */
export interface AltLabelsTarget {
  readonly id: string
  readonly kind: 'table' | 'event'
  readonly description: string
  readonly domains: readonly string[]
  readonly columns?: ReadonlyArray<{ name: string; comment?: string }>
  readonly existingAltLabels: readonly string[]
  readonly existingPrefLabel: string | undefined
}

/** The sweep-level context the alt_labels adapters resolve in `prepare`:
 * the corpus-level veto word list (#37 §4), loaded once per sweep and unioned
 * with each definition's own `suppressed_alt_labels` at the veto stage. */
export interface AltLabelsSweepCtx {
  readonly corpusVetoes: ReadonlySet<string>
}

// ── Shared lenient JSON extraction ──────────────────────────────────────

/** Extract the outermost JSON array from an LLM response, tolerating ```json
 * fences and leading/trailing prose. Shared by this family's
 * `parseAltLabelsResponse` and (still) the relations family's `parseLlmRefs`
 * in `enrichment.ts` — exported module-level, never from the public barrel
 * (ADR-0002). #66 may relocate it next to its second consumer. */
export function extractJsonArray(text: string): unknown[] {
  // tolerate ```json fences and leading/trailing prose
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  t = fence?.[1]?.trim() ?? t
  const start = t.indexOf('[')
  const end = t.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) return []
  try {
    const parsed: unknown = JSON.parse(t.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// ── Extractor guardrail (#35 / #26, ADR-0009): 12 constant predicates + cap24 ──
//
// Precision-only machinery for the paren/quote text branches of
// `discoverAltLabelsDeterministic`: kill description-text fragments torn into
// "aliases" (#26's failure face — 28 fragments off one long description). ALL
// CONSTANTS, no config surface at any layer (#35 裁决 3, same logic as ADR-0008
// 裁决 4): rules that drift per-environment become an audit blind spot, the one
// knob-like parameter (the cap) measured insensitive (12→50 moves 0.8pp), and
// with measured zero false kills there is no beneficiary for configurability.
// Adjusting a rule is an ADR revision, not a tuning move.
//
// Measured on the full dogfood corpus (#33): 766 definitions → 4296 baseline
// candidates; this set kills 2193 (51.0%) with zero measured false kills (the
// 105-word survivor tail eyeballed; DAU / 现金券 survive). Deliberately NOT
// rules here: `partition-kv` (fully covered by operator-chars/digit-run, sole
// kill 0) and `substring-of-own-id` (kills tactic/charm/toy/rank — English
// system names assembled into the definition's own id, the most valuable alias
// class; pinned by guardrail.spec's F-word fixture).

/** cap24: candidates longer than 24 chars are sentences, not terms. The probe's
 * sole-kill list for the cap was 5/5 garbage (29–33-char ids/granularity
 * phrases); 12→50 moves the kill rate only 0.8pp, so the exact value is
 * deliberately un-tunable-precise. */
const GUARDRAIL_CAP = 24

/** = ≠ ⊇ ∈ { } < > … — assertion syntax, not a noun. */
const OPERATOR_CHARS = /[=≠≥≤⊇⊆⊃⊂∈∉∩∪<>{}[\]|&]/
/** ，、; — enumeration/separator punctuation. */
const SEPARATOR_CHARS = /[,，、;；]/
/** 。！？…： — sentence punctuation: the span was a sentence. */
const SENTENCE_PUNCT = /[。！？…：:]/
/** Any quote character — a candidate still carrying one means the extraction
 * regex matched across a quote boundary. */
const QUOTE_CHARS = /["'「」《》“”‘’]/
/** Storage/layer suffixes (df/di/mi/od/arch/dim/dws/…) read as "aliases" off
 * table names. English-only by measurement: no Chinese business word ends in
 * these. */
const LAYER_SUFFIX = /^_?(df|di|mi|od|arch|dim|dws|dwd|ads|ods|cbt\d?|test)$/i
/** Arrows and tilde ranges: oldLevel→newLevel, 成功率~93.4%. */
const ARROW_TILDE = /[→←⇒~～]/

/** snake/camel/dot/punct-stripped lowercase canon (column-name matching). */
const canonForm = (s: string): string => s.toLowerCase().replace(/[_\-.\s]/g, '')

/** The per-target context the one column-aware predicate needs. */
interface GuardrailCtx {
  /** canon forms of THIS definition's column / params_fields names. */
  readonly columnNamesCanon: ReadonlySet<string>
}

/**
 * Reject one paren/quote-branch candidate against the 12-predicate guardrail +
 * cap24 (#35 裁决 1). `column-name-canon` replaces #26's `own-column-name`
 * outright (the canon form is a strict superset, 859 ⊇ 793 — keeping both would
 * leave a rule that can never fire alone).
 * @param c - the extracted candidate (already trimmed).
 * @param ctx - the target's column-canon set.
 * @returns why the candidate is rejected, or `undefined` when it survives.
 */
function guardrailRejection(c: string, ctx: GuardrailCtx): string | undefined {
  if (/^[\d０-９.\s]+$/.test(c)) return 'pure digits'
  if (/\d{4,}/.test(c)) return 'digit run (date/id fragment)'
  if (OPERATOR_CHARS.test(c)) return 'operator characters'
  if (SEPARATOR_CHARS.test(c)) return 'separator characters'
  if (SENTENCE_PUNCT.test(c)) return 'sentence punctuation'
  if (QUOTE_CHARS.test(c)) return 'embedded quote character'
  if (/\s/.test(c) && c.length > 8) return 'spaced phrase'
  if (c.includes('/')) return 'slash enumeration'
  if (LAYER_SUFFIX.test(c)) return 'storage-layer suffix'
  if (ctx.columnNamesCanon.has(canonForm(c))) return 'own column name (canon)'
  if (c.includes('+')) return 'composite-key notation'
  if (ARROW_TILDE.test(c)) return 'arrow/tilde notation'
  if (c.length > GUARDRAIL_CAP) return `longer than cap ${GUARDRAIL_CAP}`
  return undefined
}

/** Properly paired quote spans — "…" / '…' / 「…」 / 《…》. The pre-#38 regex
 * (`["'「《]([^"'」》]+)["'」》]`) let any opener close with any closer, producing
 * cross-paired spans like `"你好」`; the pairs here mirror exactly (#33 输入 4). */
const QUOTE_PAIRS = /"([^"]+)"|'([^']+)'|「([^」]+)」|《([^》]+)》/g

/** Extract raw text-branch candidates (paren + paired-quote spans), in order. */
function* textCandidates(desc: string): Generator<string> {
  for (const m of desc.matchAll(/[（(]([^）)]+)[）)]/g)) {
    const term = m[1]?.trim()
    if (term) yield term
  }
  for (const m of desc.matchAll(QUOTE_PAIRS)) {
    const term = (m[1] ?? m[2] ?? m[3] ?? m[4])?.trim()
    if (term) yield term
  }
}

/**
 * Deterministic round for alt_labels discovery. Two INDEPENDENT code paths
 * (#35 裁决 4 — not one stream with an if):
 *
 * 1. Text branch — parenthesized and paired-quoted terms out of the description
 *    (the caller passes `description || table_comment` for tables), each gated
 *    by the 12-predicate + cap24 guardrail above.
 * 2. Domains branch — the controlled `domains` vocabulary, taken as-is with only
 *    the historical `>= 2` length floor. Deliberately NOT touched by the
 *    guardrail (no predicates, **no length cap** — the asymmetry is intentional;
 *    don't "fix" it): a controlled vocabulary is not description prose, and
 *    domain words an operator wants gone are vetoed by suppression
 *    (`suppressed_alt_labels` ∪ corpus `suppressions.yaml`), not by pattern rules.
 *
 * Column comments are NOT read here — they feed only the LLM round's prompt
 * (`buildAltLabelsPrompt`); this docstring claimed otherwise before #38 (a
 * premise #35's ruling 5 had to correct on the record).
 *
 * Returns only NEW labels (not already in existingAltLabels or existingPrefLabel).
 * @param target - target
 * @returns the result
 */
export function discoverAltLabelsDeterministic(target: AltLabelsTarget): string[] {
  const existing = new Set([
    ...target.existingAltLabels.map(normalizeLabel),
    ...(target.existingPrefLabel ? [normalizeLabel(target.existingPrefLabel)] : []),
    normalizeLabel(target.id),
  ])
  const seen = new Set(existing)
  const out: string[] = []
  const push = (c: string): void => {
    const key = normalizeLabel(c)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(c)
  }

  // Path 1: text candidates → guardrail (#35: 12 predicates + cap24).
  const ctx: GuardrailCtx = {
    columnNamesCanon: new Set((target.columns ?? []).map(c => canonForm(c.name))),
  }
  for (const term of textCandidates(target.description || '')) {
    if (term.length < 2) continue
    if (guardrailRejection(term, ctx) !== undefined) continue
    push(term)
  }

  // Path 2: domains — controlled vocabulary, guardrail-exempt by ruling (see above).
  for (const d of target.domains) {
    if (d.length >= 2) push(d)
  }
  return out
}

// ── Suppression filter (#36 / #37, ADR-0010): merge 前, deterministic or LLM alike ──

/** The per-definition alias veto set: the def's own `suppressed_alt_labels` keys
 * (normalized at read — hand-edited YAML may carry unnormalized spellings) unioned
 * with the corpus-level word list (#37 §4's filter union). Exported (module level,
 * not the public barrel) so the apply family builds the identical set the
 * deterministic rounds do, rather than a drifting copy. */
export function aliasVetoSet(perAsset: readonly string[], corpus: ReadonlySet<string>): Set<string> {
  const out = new Set(corpus)
  for (const k of perAsset) out.add(normalizeLabel(k))
  return out
}

/**
 * Build the LLM prompt for alt_labels discovery on one definition. Asks the
 * model to suggest alternative search labels (Chinese + English abbreviations)
 * based on the definition's description, columns/fields, and domains.
 * @param target - target
 * @returns the result
 */
export function buildAltLabelsPrompt(target: AltLabelsTarget): string {
  const lines: string[] = [
    'Suggest alternative search labels (alt_labels) for the following data asset definition.',
    'These labels help users find this asset using different terminology — synonyms, abbreviations, Chinese/English variants, business jargon.',
    '',
    `Asset: ${target.id} (${target.kind})`,
    `Description: ${target.description || '(none)'}`,
  ]
  if (target.domains.length > 0) {
    lines.push(`Domains: ${target.domains.join(', ')}`)
  }
  if (target.columns && target.columns.length > 0) {
    const colSummary = target.columns
      .filter(c => c.comment)
      .slice(0, 20)
      .map(c => `  - ${c.name}: ${c.comment}`)
      .join('\n')
    if (colSummary) {
      lines.push('Key columns:')
      lines.push(colSummary)
    }
  }
  if (target.existingAltLabels.length > 0) {
    lines.push(`Existing labels (do NOT repeat): ${target.existingAltLabels.join(', ')}`)
  }
  lines.push('')
  lines.push('Return ONLY a JSON array of strings — candidate alt_labels (2-50 chars each, 3-10 items).')
  lines.push('Rules: no duplicates; no repetition of the asset name itself; Chinese terms preferred when the description is Chinese; include English abbreviations if applicable; if no good candidates, return [].')
  return lines.join('\n')
}

/**
 * Parse the LLM response for alt_labels: extract a JSON array of strings.
 * Lenient — invalid items are dropped.
 * @param text - text
 * @returns the result
 */
export function parseAltLabelsResponse(text: string): string[] {
  const arr = extractJsonArray(text)
  const out: string[] = []
  for (const item of arr) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length >= 2 && trimmed.length <= 50) out.push(trimmed)
  }
  return out
}

/**
 * Merge new alt_labels into existing ones (dedupe by normalized form).
 * Preserves the order: existing first, then new.
 * @param existing - existing
 * @param added - added
 * @returns the result
 */
export function mergeAltLabels(existing: readonly string[], added: readonly string[]): string[] {
  const seen = new Set(existing.map(normalizeLabel))
  const out = [...existing]
  for (const label of added) {
    const key = normalizeLabel(label)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(label)
  }
  return out
}

/**
 * Discover alt_labels for one definition (two-round: deterministic + LLM).
 * Returns the candidate labels to ADD (already deduped against existing).
 * @param target - target
 * @param llmCall - llmCall
 * @returns the result
 */
export async function discoverAltLabelsFor(
  target: AltLabelsTarget,
  llmCall?: LlmCall,
): Promise<string[]> {
  const det = discoverAltLabelsDeterministic(target)
  if (!llmCall) return det
  let llm: string[] = []
  try {
    const prompt = buildAltLabelsPrompt(target)
    const text = await llmCall(prompt)
    llm = parseAltLabelsResponse(text)
  } catch {
    // best-effort: LLM failure leaves the deterministic seed intact
  }
  // Merge deterministic + LLM, dedupe against existing
  const existing = new Set([
    ...target.existingAltLabels.map(normalizeLabel),
    ...(target.existingPrefLabel ? [normalizeLabel(target.existingPrefLabel)] : []),
    normalizeLabel(target.id),
  ])
  const seen = new Set(existing)
  const out: string[] = []
  for (const label of [...det, ...llm]) {
    const key = normalizeLabel(label)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(label)
  }
  return out
}

/**
 * Build an AltLabelsTarget from a parsed TableDefinition. Exported (module-level only —
 * not on the root barrel, ADR-0002/0003) so `enrichment-work.ts`'s work-listing can
 * build the identical `AltLabelsTarget` the LLM round itself would, rather than a
 * second, drifting projection of `TableDefinition` → prompt input.
 */
export function tableToAltLabelsTarget(def: TableDefinition): AltLabelsTarget {
  return {
    id: def.table_name,
    kind: 'table',
    description: def.description || def.table_comment,
    domains: def.domains,
    columns: def.columns.map(c => ({ name: c.name, comment: c.comment })),
    existingAltLabels: def.alt_labels,
    existingPrefLabel: def.pref_label,
  }
}

/** Build an AltLabelsTarget from a parsed EventDefinition. Exported for the same reason as
 * {@link tableToAltLabelsTarget}. */
export function eventToAltLabelsTarget(def: EventDefinition): AltLabelsTarget {
  return {
    id: def.name,
    kind: 'event',
    description: def.description,
    domains: def.domains,
    columns: Object.entries(def.params_fields).map(([k, v]) => ({
      name: k,
      comment: v.description,
    })),
    existingAltLabels: def.alt_labels,
    existingPrefLabel: def.pref_label,
  }
}

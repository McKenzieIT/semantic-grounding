/**
 * AI-Native enrichment (B1/B2/CL-1) — discover DWS→DIM dimension relations +
 * discover alt_labels (SKOS aliases) for definitions.
 *
 * G3 design (resolved 2026-08-22):
 *  - Deterministic inference (no LLM): PK-name matching for relations,
 *    description/domains extraction for alt_labels.
 *  - Results merged + deduped; written directly (no approval).
 *  - The LLM half of enrichment is agent-driven (ADR-0006's ask-answer
 *    pair, `enrichment-work.ts`) — there is no in-process LLM callback.
 *
 * CL-1 Phase 3 (alt_labels enrichment):
 *  - Same pattern: deterministic extraction from description + domains (NOT
 *    column comments — those feed only the ask-answer prompt; corrected in
 *    #38, this header and the round's own docstring both claimed otherwise).
 *  - Targets all definition types (tables + events).
 *  - Merge preserves existing human-curated alt_labels.
 *
 * Map #64 / tickets #65 + #66: BOTH enrichment families now live in
 * `src/enrichment/` and run on the one sweep engine — the pure machinery in
 * `relations.ts` / `alt-labels.ts`, the kind adapters + sweep entry points in
 * `table-adapter.ts` / `event-adapter.ts` / `sweep.ts`, the adapter contract
 * in `types.ts`. This module stays the one import path (re-exports below), so
 * external contracts are unchanged (ADR-0002). What remains defined here is
 * the ADR-0007 dimension-filter door validation — corpus-door concern, not
 * pipeline machinery. #67 then deletes the leftover duplication and leaves
 * this file a pure barrel.
 *
 * Substrate discipline: this module imports ONLY the substrate (types/io) +
 * atomic-write — it does NOT import `@deepseek-ai/dsh-llm`. The semantic-layer
 * substrate stays zod + js-yaml only.
 *
 * @module enrichment (internal; only `"."` is importable — see ADR-0002)
 */
import { loadTables, loadEvents } from './io.ts'

// ── Dimension-filter door validation (ADR-0007, #28) ────────────────────

/**
 * A dimension filter (`tables` / `events`) was rejected at the door: it named
 * definitions that do not exist in the corpus, or it was an empty array. Thrown by
 * {@link assertKnownFilterNames} — the whole-call, fail-early rejection ADR-0007 rules
 * for the Core discovery/listing methods, BEFORE any scan, write, or commit.
 *
 * A substrate-side sibling of `io.ts`'s `StaleBaselineError`
 * (a contract violation the *caller* can act on), not a coded wire error: the MCP
 * layer maps this onto its own `-31040` `UnknownFilterNameError` (`packages/mcp/src/
 * errors.ts`), the same way every other substrate condition gets its wire shape at
 * the tool boundary. The message lists every unknown name and never the corpus's full name
 * list (a 579-item corpus would make the error itself a size problem — #30's whole
 * subject).
 */
export class UnknownFilterNamesError extends Error {
  /** The unknown `tables` names, in input order (empty when the rejection was not about tables). */
  readonly unknownTables: readonly string[]
  /** The unknown `events` names, in input order (empty when the rejection was not about events). */
  readonly unknownEvents: readonly string[]

  /**
   * @param message - the human-readable rejection, listing every offending name.
   * @param unknownTables - unknown `tables` names (defaults to none).
   * @param unknownEvents - unknown `events` names (defaults to none).
   */
  constructor(message: string, unknownTables: readonly string[] = [], unknownEvents: readonly string[] = []) {
    super(message)
    this.name = 'UnknownFilterNamesError'
    this.unknownTables = unknownTables
    this.unknownEvents = unknownEvents
  }
}

/**
 * Validate a dimension filter against the corpus before any scan runs (ADR-0007's
 * door): every named table/event must exist, and a present-but-empty array is
 * rejected too — an empty array has no adjudicated meaning at the Core layer (the
 * free functions below read `[]` as "no filter", and silently promoting that to a
 * full scan here would reintroduce exactly the silent-full-sweep #25 reported).
 * Omitting a key stays the one way to say "that dimension is not in this call";
 * `{}` (both omitted) says "everything".
 * @param semanticLayer - the semantic-layer directory path.
 * @param filter - the `{tables?, events?}` pair to validate; absent keys are not
 *   validated (nothing is asserted about a dimension the call did not name).
 * @throws UnknownFilterNamesError listing every unknown name (never the corpus's
 *   full name list), or explaining the empty-array rejection.
 */
export function assertKnownFilterNames(
  semanticLayer: string,
  filter: { readonly tables?: readonly string[]; readonly events?: readonly string[] },
): void {
  const emptyDims: string[] = []
  if (filter.tables !== undefined && filter.tables.length === 0) emptyDims.push('tables')
  if (filter.events !== undefined && filter.events.length === 0) emptyDims.push('events')
  if (emptyDims.length > 0) {
    throw new UnknownFilterNamesError(
      `empty dimension filter (${emptyDims.join(', ')}) — name at least one definition per dimension, or omit the key to leave that dimension out of the call`,
    )
  }
  const unknownTables = filter.tables !== undefined
    ? filter.tables.filter(n => !new Set(loadTables(semanticLayer).map(t => t.table_name)).has(n))
    : []
  const unknownEvents = filter.events !== undefined
    ? filter.events.filter(n => !new Set(loadEvents(semanticLayer).map(e => e.name)).has(n))
    : []
  if (unknownTables.length === 0 && unknownEvents.length === 0) return
  const parts: string[] = []
  if (unknownTables.length > 0) parts.push(`unknown table name(s): ${unknownTables.join(', ')}`)
  if (unknownEvents.length > 0) parts.push(`unknown event name(s): ${unknownEvents.join(', ')}`)
  throw new UnknownFilterNamesError(
    `dimension filter names definitions that do not exist in the corpus — ${parts.join('; ')} (filters are closed-set enumerations of corpus names; fix the names and retry)`,
    unknownTables,
    unknownEvents,
  )
}

// ── Map #64 / tickets #65 + #66: both enrichment families live in src/enrichment/ ──
// Everything below re-exports them so this module stays the one import path
// (ADR-0002): the free functions keep their byte-identical contracts, now as
// thin wrappers over the sweep engine; the seam itself (adapters, engine,
// adapter contract types) stays module-level — never on the root barrel
// (ADR-0003, ADR-0006 ruling 3). #67 then collapses the leftover duplication
// here, leaving this file a pure barrel.

export {
  type DimInventoryEntry,
  discoverRelationsDeterministic,
  mergeRefs,
  buildLlmPrompt,
  parseLlmRefs,
  discoverRelationsFor,
  buildDimInventory,
  discoverEventRelationsDeterministic,
  buildEventLlmPrompt,
  relationVetoSet,
} from './enrichment/relations.ts'
export {
  type AltLabelsTarget,
  discoverAltLabelsDeterministic,
  aliasVetoSet,
  buildAltLabelsPrompt,
  parseAltLabelsResponse,
  mergeAltLabels,
  discoverAltLabelsFor,
  tableToAltLabelsTarget,
  eventToAltLabelsTarget,
} from './enrichment/alt-labels.ts'
export {
  enrichAllTablesAltLabels,
  enrichAllDwsTables,
} from './enrichment/table-adapter.ts'
export {
  enrichAllEventsAltLabels,
  enrichAllEvents,
} from './enrichment/event-adapter.ts'
export { sweepEnrichment } from './enrichment/sweep.ts'
export {
  type EnrichmentKindAdapter,
  type MergeContext,
  type SweepOpts,
  type SweepPrepare,
  type SweepTarget,
  type ListedTarget,
  type EnrichmentWriteOutcome,
} from './enrichment/types.ts'

/**
 * The event kind adapters for the enrichment sweep engine (map #64): the
 * events mirror of `table-adapter.ts` — the alt_labels family (ticket #65's
 * first migration) and the relations family (ticket #66). The one structural
 * difference from tables is the write surface — events go through
 * `writeEventYaml`'s raw-edit path (dump the mutated raw dict to YAML text; no
 * schema validation, `loadEvents` validates on read), exactly as
 * `enrichAllEventsAltLabels` / `enrichAllEvents` always did.
 *
 * @module enrichment/event-adapter (internal; only `"."` is importable — see ADR-0002)
 */
import { EventDefinitionSchema, type EventDefinition, type DimensionRef } from '../types.ts'
import { dumpYaml, loadEvents, loadSuppressions, normalizeLabel, writeEventYaml, type Tier2Opts } from '../io.ts'
import {
  aliasVetoSet,
  discoverAltLabelsFor,
  eventToAltLabelsTarget,
  mergeAltLabels,
  type AltLabelsSweepCtx,
} from './alt-labels.ts'
import {
  buildDimInventory,
  discoverEventRelationsFor,
  existingEventRefs,
  relationsMerge,
  relationVetoSet,
  type RelationsSweepCtx,
} from './relations.ts'
import { sweepEnrichment } from './sweep.ts'
import type { EnrichmentKindAdapter, ListedTarget, SweepTarget } from './types.ts'
import type { LlmCall } from './types.ts'

/** The alt_labels adapter for events: the events mirror of
 * `tableAltLabelsAdapter` (gain-only writes, per-sweep corpus veto list,
 * union-merge, raw dict + dumpYaml write surface). */
export const eventAltLabelsAdapter: EnrichmentKindAdapter<EventDefinition, string, AltLabelsSweepCtx> = {
  kind: 'event',
  writePolicy: 'gain-only',
  prepare: semanticLayer => ({ context: { corpusVetoes: loadSuppressions(semanticLayer) } }),
  list(semanticLayer): readonly ListedTarget<EventDefinition, string>[] {
    return loadEvents(semanticLayer).map((e): ListedTarget<EventDefinition, string> => {
      const r = EventDefinitionSchema.safeParse(e.raw)
      return r.success
        ? { semanticLayer, name: e.name, raw: e.raw, def: r.data, existing: r.data.alt_labels }
        : { name: e.name, parseError: true }
    })
  },
  discover: (target: SweepTarget<EventDefinition, string>, _ctx: AltLabelsSweepCtx, llmCall?: LlmCall) =>
    discoverAltLabelsFor(eventToAltLabelsTarget(target.def), llmCall),
  veto: (target: SweepTarget<EventDefinition, string>, discovered: readonly string[], ctx: AltLabelsSweepCtx): readonly string[] => {
    // Suppression filter — the candidate exit (see tableAltLabelsAdapter).
    const vetoes = aliasVetoSet(target.def.suppressed_alt_labels, ctx.corpusVetoes)
    return vetoes.size === 0 ? discovered : discovered.filter(l => !vetoes.has(normalizeLabel(l)))
  },
  // Union merge, MergeContext ignored by design (map #64) — see tableAltLabelsAdapter.
  merge: (_target: SweepTarget<EventDefinition, string>, existing: readonly string[], discovered: readonly string[]): readonly string[] =>
    mergeAltLabels(existing, discovered),
  write: (target: SweepTarget<EventDefinition, string>, merged: readonly string[], tier2?: Tier2Opts) =>
    writeEventYaml(target.semanticLayer, target.name, dumpYaml({ ...target.raw, alt_labels: merged }), tier2),
}

/**
 * Enrich all events in a semantic layer with alt_labels: discover aliases and
 * write them back into each event's YAML. Two-round (deterministic + LLM).
 * Merges with existing alt_labels (never removes curated labels).
 *
 * @param semanticLayer - the semantic-layer directory path.
 * @param llmCall - optional LLM call for the semantic round.
 * @param events - optional event-name filter; omit/empty to enrich all.
 * @param tier2 - optional Tier-2 options (#18); passed, each event write
 *   below takes `writeEventYaml`'s audited write-and-record path.
 * @returns `enriched` (events gaining >=1 new label) + `written` + per-event `errors`.
 */
export async function enrichAllEventsAltLabels(
  semanticLayer: string,
  llmCall?: LlmCall,
  events?: readonly string[],
  tier2?: Tier2Opts,
): Promise<{ enriched: number; written: number; errors: string[] }> {
  return sweepEnrichment(eventAltLabelsAdapter, semanticLayer, { llmCall, names: events, tier2 })
}

// ── Relations family (map #64 / ticket #66) ─────────────────────────────

/** The relations adapter for events: the events mirror of
 * `tableRelationsAdapter` (always-write refresh mode, DIM inventory +
 * excludeColumnsFn resolved once per sweep in `prepare` with the empty
 * -inventory skip, origin-aware merge, raw dict + dumpYaml write surface —
 * only `external_refs` changes). */
export const eventRelationsAdapter: EnrichmentKindAdapter<EventDefinition, DimensionRef, RelationsSweepCtx<EventDefinition>> = {
  kind: 'event',
  writePolicy: 'always',
  prepare: (semanticLayer, opts) => {
    const dimInventory = buildDimInventory(semanticLayer)
    // GA-GT3 item 6: no DIM tables -> no joins possible for any event; skip
    // the per-event write loop (parallel to the table adapter). GA-GT3-6b: the
    // skip reason becomes the agent-visible `note` (forwarded through
    // discoverEventRelations so the agent sees why enriched/written are 0).
    if (dimInventory.length === 0) {
      return { skip: { reason: 'no DIM tables in scope, nothing to enrich' } }
    }
    return { context: { dimInventory, excludeColumnsFn: opts.excludeColumnsFn } }
  },
  list(semanticLayer): readonly ListedTarget<EventDefinition, DimensionRef>[] {
    // No kind filter on events (every parsed event is a target); parse
    // failures stay parse-error targets, never silently dropped.
    return loadEvents(semanticLayer).map((e): ListedTarget<EventDefinition, DimensionRef> => {
      const r = EventDefinitionSchema.safeParse(e.raw)
      return r.success
        ? { semanticLayer, name: e.name, raw: e.raw, def: r.data, existing: existingEventRefs(e.raw) }
        : { name: e.name, parseError: true }
    })
  },
  discover: (target: SweepTarget<EventDefinition, DimensionRef>, ctx: RelationsSweepCtx<EventDefinition>, llmCall?: LlmCall) =>
    discoverEventRelationsFor(target.def, ctx.dimInventory, llmCall, ctx.excludeColumnsFn?.(target.def)),
  veto: (target: SweepTarget<EventDefinition, DimensionRef>, discovered: readonly DimensionRef[]): readonly DimensionRef[] => {
    // Suppression filter — the events mirror of the table adapter's discovered
    // exit (445 of the 446 polluted definitions were events: day-one coverage).
    const vetoes = relationVetoSet(target.def.suppressed_external_refs)
    return vetoes.size === 0 ? discovered : discovered.filter(ref => !vetoes.has(ref.dim_table))
  },
  // MergeContext three-branch shared with the table adapter: see relationsMerge.
  merge: relationsMerge,
  write: (target: SweepTarget<EventDefinition, DimensionRef>, merged: readonly DimensionRef[], tier2?: Tier2Opts) =>
    writeEventYaml(target.semanticLayer, target.name, dumpYaml({ ...target.raw, external_refs: merged }), tier2),
}

/**
 * Enrich every event in a semantic layer: discover its DIM relations and write
 * them back into the event YAML's `external_refs`. Mirrors `enrichAllDwsTables`
 * (two-round; deterministic round always runs, LLM round runs only when a
 * `llmCall` is provided). Writes via `writeEventYaml` (raw-edit surface: read
 * the existing raw, inject `external_refs`, re-dump to YAML text, name-match
 * check; no schema validation — `loadEvents` validates on read).
 * `mergeExisting`: when true, discovered refs merge WITH the event's existing
 * `external_refs` (everything preserved, discovered unioned); default false —
 * replace (curated `manual`/`undefined` preserved, machine `deterministic`/`llm`
 * dropped so re-discovery refreshes them; GA-GT3 item 5, parallel to
 * `enrichAllDwsTables`). By default (`preserveCurated=true`) the replace is
 * origin-aware; `preserveCurated=false` is the escape-hatch (GA-GT3-5b) for the
 * rare blow-away-rebuild case: a raw full replace that drops ALL existing refs
 * (incl. curated manual/undefined) and writes only the freshly-discovered set.
 *
 * CL-18 Phase 2: `excludeColumnsFn` (optional) computes a per-event exclude
 * set and forwards it to `discoverEventRelationsFor` (parallel to
 * `enrichAllDwsTables`). The calling layer supplies the builder; the
 * substrate applies it opaquely.
 * @param semanticLayer - the semantic-layer directory path.
 * @param llmCall - optional one-shot LLM call for the semantic round.
 * @param events - optional event-name filter; omit/empty to enrich all events.
 * @param mergeExisting - when true, merge discovered with existing; default false.
 * @param excludeColumnsFn - optional per-event exclude-set builder (CL-18 Phase 2).
 * @param preserveCurated - when true (default), origin-aware replace (curated
 *   manual/undefined preserved, machine dropped); when false, raw full replace
 *   (ALL existing refs dropped, only discovered remain) — the escape-hatch for
 *   blow-away-rebuild (GA-GT3-5b). Ignored when `mergeExisting=true`.
 * @param tier2 - optional Tier-2 options (#18); passed, each event write
 *   below is demoted-to-primitive through `writeEventYaml`'s audited path
 *   instead of the default unaudited write.
 * @returns `enriched` (events gaining >=1 ref) + `written` (events updated) + per-event `errors`.
 */
export async function enrichAllEvents(
  semanticLayer: string,
  llmCall?: LlmCall,
  events?: readonly string[],
  mergeExisting = false,
  excludeColumnsFn?: (def: EventDefinition) => ReadonlySet<string> | undefined,
  preserveCurated = true,
  tier2?: Tier2Opts,
): Promise<{ enriched: number; written: number; errors: string[]; note?: string }> {
  return sweepEnrichment(eventRelationsAdapter, semanticLayer, {
    llmCall,
    names: events,
    mergeContext: { mergeExisting, preserveCurated },
    excludeColumnsFn,
    tier2,
  })
}

/**
 * The event kind adapter for the alt_labels pipeline family (map #64,
 * ticket #65's first migration): the events mirror of `table-adapter.ts`.
 * The one structural difference from tables is the write surface — events
 * go through `writeEventYaml`'s raw-edit path (dump the mutated raw dict to
 * YAML text; no schema validation, `loadEvents` validates on read), exactly
 * as `enrichAllEventsAltLabels` always did.
 *
 * @module enrichment/event-adapter (internal; only `"."` is importable — see ADR-0002)
 */
import { EventDefinitionSchema, type EventDefinition } from '../types.ts'
import { dumpYaml, loadEvents, loadSuppressions, normalizeLabel, writeEventYaml, type Tier2Opts } from '../io.ts'
import {
  aliasVetoSet,
  discoverAltLabelsFor,
  eventToAltLabelsTarget,
  mergeAltLabels,
  type AltLabelsSweepCtx,
} from './alt-labels.ts'
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

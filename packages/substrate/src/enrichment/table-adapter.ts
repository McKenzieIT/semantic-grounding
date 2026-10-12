/**
 * The table kind adapter for the alt_labels pipeline family (map #64,
 * ticket #65's first migration): everything `enrichAllTablesAltLabels` knew
 * about tables, expressed as {@link EnrichmentKindAdapter} stages over the
 * pure machinery in `alt-labels.ts`. The orchestration that used to wrap
 * these calls lives in `sweep.ts` now; the free function below is the
 * byte-identical public contract, kept as a thin wrapper.
 *
 * @module enrichment/table-adapter (internal; only `"."` is importable — see ADR-0002)
 */
import { TableDefinitionSchema, type TableDefinition } from '../types.ts'
import { loadTables, loadSuppressions, normalizeLabel, writeTable, type Tier2Opts } from '../io.ts'
import {
  aliasVetoSet,
  discoverAltLabelsFor,
  mergeAltLabels,
  tableToAltLabelsTarget,
  type AltLabelsSweepCtx,
} from './alt-labels.ts'
import { sweepEnrichment } from './sweep.ts'
import type { EnrichmentKindAdapter, ListedTarget, SweepTarget } from './types.ts'
import type { LlmCall } from './types.ts'

/** The alt_labels adapter for tables: gain-only writes (zero-commit
 * idempotency), corpus veto list resolved once per sweep in `prepare`,
 * union-merge that never removes a curated label, raw dict preserved
 * verbatim on write (only `alt_labels` changes). */
export const tableAltLabelsAdapter: EnrichmentKindAdapter<TableDefinition, string, AltLabelsSweepCtx> = {
  kind: 'table',
  writePolicy: 'gain-only',
  prepare: semanticLayer => ({ context: { corpusVetoes: loadSuppressions(semanticLayer) } }),
  list(semanticLayer): readonly ListedTarget<TableDefinition, string>[] {
    return loadTables(semanticLayer).map((t): ListedTarget<TableDefinition, string> => {
      const r = TableDefinitionSchema.safeParse(t.raw)
      return r.success
        ? { semanticLayer, name: t.table_name, raw: t.raw, def: r.data, existing: r.data.alt_labels }
        : { name: t.table_name, parseError: true }
    })
  },
  discover: (target: SweepTarget<TableDefinition, string>, _ctx: AltLabelsSweepCtx, llmCall?: LlmCall) =>
    discoverAltLabelsFor(tableToAltLabelsTarget(target.def), llmCall),
  veto: (target: SweepTarget<TableDefinition, string>, discovered: readonly string[], ctx: AltLabelsSweepCtx): readonly string[] => {
    // Suppression filter (#36 输入 2, ADR-0010): the candidate exit — AFTER
    // `discoverAltLabelsFor` (so the LLM round's suggestions are gated too),
    // BEFORE `mergeAltLabels`. All candidates vetoed ⇒ zero new labels ⇒ the
    // engine's gain-only branch leaves the file untouched (zero write, zero commit).
    const vetoes = aliasVetoSet(target.def.suppressed_alt_labels, ctx.corpusVetoes)
    return vetoes.size === 0 ? discovered : discovered.filter(l => !vetoes.has(normalizeLabel(l)))
  },
  // The union merge ignores the MergeContext by design (map #64): alt_labels
  // has no origin tracking, so there is no merge mode to switch on.
  merge: (_target: SweepTarget<TableDefinition, string>, existing: readonly string[], discovered: readonly string[]): readonly string[] =>
    mergeAltLabels(existing, discovered),
  write: (target: SweepTarget<TableDefinition, string>, merged: readonly string[], tier2?: Tier2Opts) =>
    writeTable(target.semanticLayer, target.name, { ...target.raw, alt_labels: merged }, {}, tier2),
}

/**
 * Enrich all tables in a semantic layer with alt_labels: discover aliases and
 * write them back into each table's YAML. Two-round (deterministic + LLM).
 * Merges with existing alt_labels (never removes curated labels).
 *
 * @param semanticLayer - the semantic-layer directory path.
 * @param llmCall - optional LLM call for the semantic round.
 * @param tables - optional table_name filter; omit/empty to enrich all.
 * @param tier2 - optional Tier-2 options (#18); passed, each table write
 *   below takes `writeTable`'s audited write-and-record path.
 * @returns `enriched` (tables gaining >=1 new label) + `written` + per-table `errors`.
 */
export async function enrichAllTablesAltLabels(
  semanticLayer: string,
  llmCall?: LlmCall,
  tables?: readonly string[],
  tier2?: Tier2Opts,
): Promise<{ enriched: number; written: number; errors: string[] }> {
  return sweepEnrichment(tableAltLabelsAdapter, semanticLayer, { llmCall, names: tables, tier2 })
}

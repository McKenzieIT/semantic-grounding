/**
 * The table kind adapters for the enrichment sweep engine (map #64): the
 * alt_labels pipeline family (ticket #65's first migration) and the relations
 * family (ticket #66), each expressed as an {@link EnrichmentKindAdapter}
 * stage set over the pure machinery in `alt-labels.ts` / `relations.ts`. The
 * orchestration that used to wrap these calls lives in `sweep.ts` now; the
 * free functions below are the byte-identical public contracts, kept as thin
 * wrappers.
 *
 * @module enrichment/table-adapter (internal; only `"."` is importable — see ADR-0002)
 */
import { TableDefinitionSchema, type TableDefinition, type DimensionRef } from '../types.ts'
import { loadTables, loadSuppressions, normalizeLabel, writeTable, type Tier2Opts } from '../io.ts'
import {
  aliasVetoSet,
  discoverAltLabelsFor,
  mergeAltLabels,
  tableToAltLabelsTarget,
  type AltLabelsSweepCtx,
} from './alt-labels.ts'
import {
  buildDimInventory,
  discoverRelationsFor,
  existingRefs,
  relationsMerge,
  relationVetoSet,
  type RelationsSweepCtx,
} from './relations.ts'
import { sweepEnrichment } from './sweep.ts'
import type { EnrichmentKindAdapter, ListedTarget, SweepTarget } from './types.ts'

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
  discover: (target: SweepTarget<TableDefinition, string>, _ctx: AltLabelsSweepCtx) =>
    discoverAltLabelsFor(tableToAltLabelsTarget(target.def)),
  veto: (target: SweepTarget<TableDefinition, string>, discovered: readonly string[], ctx: AltLabelsSweepCtx): readonly string[] => {
    // Suppression filter (#36 输入 2, ADR-0010): the candidate exit — AFTER
    // `discoverAltLabelsFor`, BEFORE `mergeAltLabels`. All candidates vetoed
    // ⇒ zero new labels ⇒ the engine's gain-only branch leaves the file
    // untouched (zero write, zero commit).
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
 * write them back into each table's YAML (deterministic round only — the LLM
 * half of enrichment lives in the agent-driven ask-answer pair). Merges with
 * existing alt_labels (never removes curated labels).
 *
 * @param semanticLayer - the semantic-layer directory path.
 * @param tables - optional table_name filter; omit/empty to enrich all.
 * @param tier2 - optional Tier-2 options (#18); passed, each table write
 *   below takes `writeTable`'s audited write-and-record path.
 * @returns `enriched` (tables gaining >=1 new label) + `written` + per-table `errors`.
 */
export async function enrichAllTablesAltLabels(
  semanticLayer: string,
  tables?: readonly string[],
  tier2?: Tier2Opts,
): Promise<{ enriched: number; written: number; errors: string[] }> {
  return sweepEnrichment(tableAltLabelsAdapter, semanticLayer, { names: tables, tier2 })
}

// ── Relations family (map #64 / ticket #66) ─────────────────────────────

/** The relations adapter for tables: always-write refresh mode (machine refs
 * are rewritten even when this round found nothing new, so stale machine refs
 * age out), DIM inventory + excludeColumnsFn resolved once per sweep in
 * `prepare` (empty inventory = whole-sweep skip with the agent-visible note),
 * origin-aware merge under the engine's MergeContext, raw dict preserved
 * verbatim on write (only `dimension_refs` changes). */
export const tableRelationsAdapter: EnrichmentKindAdapter<TableDefinition, DimensionRef, RelationsSweepCtx<TableDefinition>> = {
  kind: 'table',
  writePolicy: 'always',
  prepare: (semanticLayer, opts) => {
    const dimInventory = buildDimInventory(semanticLayer)
    // GA-GT3 item 6: no DIM tables -> no joins are possible for any table;
    // skip the per-table write loop entirely (avoids writing dimension_refs:[]
    // to every DWS + a misleading written:N report). GA-GT3-6b: the skip reason
    // becomes the agent-visible `note` (forwarded through discoverRelations ->
    // discover_relations tool result).
    if (dimInventory.length === 0) {
      return { skip: { reason: 'no DIM tables in scope, nothing to enrich' } }
    }
    return { context: { dimInventory, excludeColumnsFn: opts.excludeColumnsFn } }
  },
  list(semanticLayer): readonly ListedTarget<TableDefinition, DimensionRef>[] {
    // Parse-then-filter (#65 note): the `kind === 'dim'` exit runs AFTER the
    // schema parse — a parse-failed DIM still becomes a parse-error target
    // (the engine records `${name}: schema parse failed`), exactly the
    // pipeline's old order; filtering by kind first would swallow that error.
    const out: ListedTarget<TableDefinition, DimensionRef>[] = []
    for (const t of loadTables(semanticLayer)) {
      const r = TableDefinitionSchema.safeParse(t.raw)
      if (!r.success) {
        out.push({ name: t.table_name, parseError: true })
        continue
      }
      if (r.data.kind === 'dim') continue // only DWS
      out.push({ semanticLayer, name: t.table_name, raw: t.raw, def: r.data, existing: existingRefs(t.raw) })
    }
    return out
  },
  discover: (target: SweepTarget<TableDefinition, DimensionRef>, ctx: RelationsSweepCtx<TableDefinition>) =>
    discoverRelationsFor(target.def, ctx.dimInventory, ctx.excludeColumnsFn?.(target.def)),
  veto: (target: SweepTarget<TableDefinition, DimensionRef>, discovered: readonly DimensionRef[]): readonly DimensionRef[] => {
    // Suppression filter (#36 输入 2, ADR-0010): the discovered exit — a vetoed
    // `dim_table` never reaches merge, whichever round proposed it (a veto
    // constrains enrichment rounds, not just one of them).
    const vetoes = relationVetoSet(target.def.suppressed_dimension_refs)
    return vetoes.size === 0 ? discovered : discovered.filter(ref => !vetoes.has(ref.dim_table))
  },
  // MergeContext three-branch shared with the event adapter: see relationsMerge.
  merge: relationsMerge,
  // write raw + refs (preserves physical types / extra keys; writeTable validates)
  write: (target: SweepTarget<TableDefinition, DimensionRef>, merged: readonly DimensionRef[], tier2?: Tier2Opts) =>
    writeTable(target.semanticLayer, target.name, { ...target.raw, dimension_refs: merged }, {}, tier2),
}

/**
 * Enrich every DWS table (kind !== 'dim') in a semantic layer: discover its
 * DIM relations and write them back into the table YAML's `dimension_refs`.
 *
 * Writes preserve the raw file verbatim (physical types, extra keys) — only
 * `dimension_refs` is replaced/merged — because `writeTable` writes the passed
 * object after validating it (it does not rewrite canonicalized types). DIM
 * tables are left untouched. Per-table fail-tolerant: a thrown discover/write
 * becomes an error string rather than aborting the batch.
 *
 * `mergeExisting`: when `true`, discovered refs are merged WITH the table's
 * existing `dimension_refs` (everything preserved, discovered unioned) — used by
 * the on-write hook so auto-trigger can never wipe any existing join. When
 * `false` (default), replace: curated existing refs (`manual` / `undefined`)
 * are preserved and machine-generated ones (`deterministic` / `llm`) are
 * dropped so re-discovery can refresh them — used by the explicit
 * `discoverRelations` entry (re-discover, G3 direct-write). By default
 * (`preserveCurated=true`) the replace is origin-aware (GA-GT3 item 5);
 * `preserveCurated=false` is the escape-hatch (GA-GT3-5b) for the rare
 * blow-away-rebuild case: a raw full replace that drops ALL existing refs
 * (incl. curated manual/undefined) and writes only the freshly-discovered set.
 *
 * CL-18 Phase 2: `excludeColumnsFn` (optional) computes a per-target exclude
 * set from the target table's metadata (e.g. its partition columns) and
 * forwards it to `discoverRelationsFor` so partition-column PK matches (e.g.
 * `ds`-only DIM snapshots) do not generate noise JOIN relations. The calling
 * layer supplies this function; the substrate applies it opaquely.
 * @param semanticLayer - the semantic-layer directory path.
 * @param tables - optional table_name filter; omit or empty to enrich all DWS tables.
 * @param mergeExisting - when true, merge discovered refs with existing (preserve curated); default false (replace).
 * @param excludeColumnsFn - optional per-target exclude-set builder (CL-18 Phase 2).
 * @param preserveCurated - when true (default), origin-aware replace (curated
 *   manual/undefined preserved, machine dropped); when false, raw full replace
 *   (ALL existing refs dropped, only discovered remain) — the escape-hatch for
 *   blow-away-rebuild (GA-GT3-5b). Ignored when `mergeExisting=true`.
 * @param tier2 - optional Tier-2 options (#18); passed, each table write
 *   below is demoted-to-primitive through `writeTable`'s audited path
 *   instead of the default unaudited write. Not batched yet — one commit per
 *   table — until a recorder's `beginBatch` is wired through (#16).
 * @returns `enriched` (DWS tables that gained at least one ref) + `written` (DWS
 *   tables updated) + per-table `errors`.
 */
export async function enrichAllDwsTables(
  semanticLayer: string,
  tables?: readonly string[],
  mergeExisting = false,
  excludeColumnsFn?: (def: TableDefinition) => ReadonlySet<string> | undefined,
  preserveCurated = true,
  tier2?: Tier2Opts,
): Promise<{ enriched: number; written: number; errors: string[]; note?: string }> {
  return sweepEnrichment(tableRelationsAdapter, semanticLayer, {
    names: tables,
    mergeContext: { mergeExisting, preserveCurated },
    excludeColumnsFn,
    tier2,
  })
}

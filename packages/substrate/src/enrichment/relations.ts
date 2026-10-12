/**
 * The relations enrichment family's pure machinery (B1/B2, G3): DIM inventory
 * building, the two discovery rounds (deterministic exact-name PK match +
 * LLM-assisted), the origin-aware merge/replace strategies, and the relation
 * veto set. Moved verbatim out of `enrichment.ts` (map #64 / ticket #66) so
 * the relations kind adapters in `table-adapter.ts` / `event-adapter.ts` can
 * run on the sweep engine (`sweep.ts`) without cycling the barrel —
 * `enrichment.ts` re-exports every public name, so external import paths are
 * unchanged (ADR-0002).
 *
 * `extractJsonArray` (the fence/prose-tolerant JSON-array extractor) is
 * housed HERE — its origin is this family's `parseLlmRefs`; the alt_labels
 * family's `parseAltLabelsResponse` imports it from this module (it lived in
 * `alt-labels.ts` only while #65's first migration was alone in this
 * directory).
 *
 * @module enrichment/relations (internal; only `"."` is importable — see ADR-0002)
 */
import {
  TableDefinitionSchema,
  DimensionRefSchema,
  EventDefinitionSchema,
  type TableDefinition,
  type EventDefinition,
  type DimensionRef,
} from '../types.ts'
import { loadTables } from '../io.ts'
import type { LlmCall, MergeContext, SweepTarget } from './types.ts'

// ── Types ───────────────────────────────────────────────────────────────

/**
 * A DIM table summarized for relation discovery: its name, primary_key, a
 * description, and (optionally), its columns for richer LLM context.
 */
export interface DimInventoryEntry {
  readonly table_name: string
  readonly primary_key: readonly string[]
  readonly description: string
  readonly columns?: ReadonlyArray<{ name: string; comment?: string; type?: string }>
}

/**
 * The sweep-level context the relations adapters resolve in `prepare`
 * (map #64 / ticket #66): the layer's DIM inventory (the join candidates every
 * target is matched against) and the optional per-target exclude-set builder
 * (CL-18 Phase 2) threaded from the free function's runtime parameter. An
 * empty inventory never reaches a context — `prepare` returns
 * `{ skip: { reason } }` instead and the engine short-circuits the sweep.
 */
export interface RelationsSweepCtx<TDef> {
  readonly dimInventory: readonly DimInventoryEntry[]
  readonly excludeColumnsFn?: ((def: TDef) => ReadonlySet<string> | undefined) | undefined
}

// ── Shared lenient JSON extraction ──────────────────────────────────────

/** Extract the outermost JSON array from an LLM response, tolerating ```json
 * fences and leading/trailing prose. Shared by this family's `parseLlmRefs`
 * and the alt_labels family's `parseAltLabelsResponse` (`alt-labels.ts`
 * imports it from here) — exported module-level, never from the public
 * barrel (ADR-0002). */
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

// ── Round 1: deterministic (no LLM) ─────────────────────────────────────

/**
 * Deterministic round: for each DIM with a non-empty `primary_key`, emit a
 * DimensionRef for every DIM PK column whose name exactly matches a column on
 * the target DWS (G3 exact-name match). High-precision seed set; no LLM.
 *
 * CL-18 Phase 2: an optional `excludeColumns` set (typically the target
 * table's partition columns, e.g. `ds`/`pt`/`dt`) filters out noise JOIN
 * relations — a DIM whose PK is a partition column (e.g. an `_arch` snapshot
 * table keyed by `ds`) would otherwise match every DWS that carries that
 * partition column. The set is computed by the calling layer (see
 * `buildExcludeColumns` in the Service shell) so this substrate stays free of
 * any specific metadata-format assumption.
 * @param targetDef - the DWS table definition to find DIM joins for.
 * @param dimInventory - the DIM tables to match against.
 * @param excludeColumns - optional set of column names to exclude from PK matching (e.g. partition columns).
 * @returns one DimensionRef per DIM whose PK shares at least one non-excluded column name with the target.
 */
export function discoverRelationsDeterministic(
  targetDef: TableDefinition,
  dimInventory: readonly DimInventoryEntry[],
  excludeColumns?: ReadonlySet<string>,
): DimensionRef[] {
  const colNames = new Set(targetDef.columns.map(c => c.name))
  const refs: DimensionRef[] = []
  for (const dim of dimInventory) {
    const pks = dim.primary_key.filter(pk => colNames.has(pk) && !(excludeColumns?.has(pk)))
    if (pks.length === 0) continue
    refs.push({
      dim_table: dim.table_name,
      join_keys: pks.map(pk => ({ dws_column: pk, dim_column: pk })),
      derivation: `确定性：DWS 列 ${pks.join(', ')} 与 ${dim.table_name} 主键精确同名`,
      origin: 'deterministic',
    })
  }
  return refs
}

// ── Merge (dedupe by dim_table, union join_keys) ───────────────────────

// pair key = JSON.stringify([dws_column, dim_column]) — collision-proof: the
// JSON array form disambiguates ("a","bc") from ("ab","c"), unlike the
// separator-free concatenation that hashed both to "abc".
const pairKey = (k: { dws_column: string; dim_column: string }) => JSON.stringify([k.dws_column, k.dim_column])

// origin-based override priority: deterministic < llm < manual (undefined treated as manual).
const ORIGIN_PRIORITY: Record<string, number> = { deterministic: 0, llm: 1, manual: 2 }
function originPriority(origin: string | undefined): number {
  return origin != null ? (ORIGIN_PRIORITY[origin] ?? 2) : 2
}

/**
 * Merge two DimensionRef lists: dedupe by `dim_table`, unioning `join_keys`
 * (deduped by the dws|dim pair). The second list's `derivation` (and `origin`)
 * overrides the first's when the added ref has a strictly higher origin
 * priority — i.e. 'llm' overrides 'deterministic', 'manual' overrides both,
 * and `undefined` (legacy / human-curated) is treated as 'manual' (never
 * auto-overridden).
 * @param baseline - the first list (e.g. deterministic refs, or existing curated refs).
 * @param added - the second list (e.g. LLM refs, or newly-discovered refs).
 * @returns the merged, deduped DimensionRef list (baseline preserved + added unioned).
 */
export function mergeRefs(
  baseline: readonly DimensionRef[],
  added: readonly DimensionRef[],
): DimensionRef[] {
  const map = new Map<string, DimensionRef>()
  for (const r of baseline) {
    const keys = r.join_keys.map(k => ({ ...k }))
    map.set(r.dim_table, { dim_table: r.dim_table, join_keys: keys, derivation: r.derivation, origin: r.origin })
  }
  for (const r of added) {
    const ex = map.get(r.dim_table)
    if (ex) {
      const seen = new Set(ex.join_keys.map(pairKey))
      for (const k of r.join_keys) {
        const key = pairKey(k)
        if (!seen.has(key)) {
          ex.join_keys.push({ dws_column: k.dws_column, dim_column: k.dim_column })
          seen.add(key)
        }
      }
      // The empty-derivation backfill (no note yet -> take whatever shows up)
      // must not apply to a curated baseline (origin manual/undefined): that
      // tier is already max-priority and its silence is the point (an agent
      // asserted the join without writing a rationale), not a gap to fill.
      const exCurated = ex.origin === 'manual' || ex.origin == null
      if (r.derivation && (originPriority(r.origin) > originPriority(ex.origin) || (!ex.derivation && !exCurated))) {
        ex.derivation = r.derivation
        ex.origin = r.origin
      }
    } else {
      const keys = r.join_keys.map(k => ({ ...k }))
      map.set(r.dim_table, { dim_table: r.dim_table, join_keys: keys, derivation: r.derivation, origin: r.origin })
    }
  }
  return [...map.values()]
}

// ── Round 2: LLM-assisted ───────────────────────────────────────────────

/**
 * Build the LLM prompt for one target DWS: its columns (name + comment) +
 * description, plus the full DIM inventory (table_name + primary_key +
 * description). The model is asked to return a JSON array of DimensionRef.
 * @param targetDef - the DWS table definition.
 * @param dimInventory - the DIM tables to consider.
 * @returns the assembled prompt text.
 */
export function buildLlmPrompt(targetDef: TableDefinition, dimInventory: readonly DimInventoryEntry[]): string {
  const cols = targetDef.columns.map(c => `- ${c.name} (${c.type || 'string'}): ${c.comment || ''}`).join('\n')
  const dims = dimInventory
    .map(d => `- ${d.table_name} | PK: [${d.primary_key.join(', ')}] | ${d.description || ''}`)
    .join('\n')
  return [
    `Discover dimension (DIM) join relations for the DWS fact table \`${targetDef.table_name}\`.`,
    '',
    `DWS table: ${targetDef.table_name}`,
    `Description: ${targetDef.description || targetDef.table_comment || ''}`,
    'Columns:',
    cols,
    '',
    'DIM inventory (find joins where a DWS column is a foreign key to a DIM primary_key — exact name OR semantic equivalence):',
    dims,
    '',
    'Return ONLY a JSON array of objects: [{"dim_table":"<DIM table_name>","join_keys":[{"dws_column":"<DWS col>","dim_column":"<DIM pk col>"}],"derivation":"<one sentence justification>"}].',
    'Rules: join_keys non-empty; only high-confidence foreign-key joins; if none, return [].',
  ].join('\n')
}

/**
 * Parse + validate an LLM's textual response into DimensionRefs. Lenient: any
 * item failing `DimensionRefSchema` (e.g. empty join_keys) is dropped rather
 * than aborting the whole batch. Uses the fence/prose-tolerant array
 * extraction housed in this module (shared with the alt_labels round in
 * `alt-labels.ts`, which imports it from here).
 * @param text - the raw LLM response text.
 * @returns the valid DimensionRefs found in the response (empty when none/invalid).
 */
export function parseLlmRefs(text: string): DimensionRef[] {
  const arr = extractJsonArray(text)
  const refs: DimensionRef[] = []
  for (const item of arr) {
    const r = DimensionRefSchema.safeParse(item)
    if (r.success) refs.push({ ...r.data, origin: 'llm' })
  }
  return refs
}

/**
 * Discover dimension relations for one DWS table (G3 two-round strategy).
 * Round 1 (deterministic, no LLM) always runs; round 2 (LLM) runs only when
 * `llmCall` is provided and is best-effort (a thrown call or invalid JSON
 * degrades to round-1 results only).
 *
 * CL-18 Phase 2: `excludeColumns` (optional) is forwarded to the
 * deterministic round to filter out partition-column PK matches (noise JOINs).
 * @param targetDef - the DWS table definition.
 * @param dimInventory - the DIM tables to match against.
 * @param llmCall - optional one-shot LLM call for the semantic round.
 * @param excludeColumns - optional set of column names to exclude from deterministic PK matching.
 * @returns the merged DimensionRefs for the target.
 */
export async function discoverRelationsFor(
  targetDef: TableDefinition,
  dimInventory: readonly DimInventoryEntry[],
  llmCall?: LlmCall,
  excludeColumns?: ReadonlySet<string>,
): Promise<DimensionRef[]> {
  const det = discoverRelationsDeterministic(targetDef, dimInventory, excludeColumns)
  if (!llmCall) return det
  let llm: DimensionRef[] = []
  try {
    const text = await llmCall(buildLlmPrompt(targetDef, dimInventory))
    llm = parseLlmRefs(text)
  } catch {
    // best-effort: LLM round failure leaves the deterministic seed intact
  }
  return mergeRefs(det, llm)
}

// ── B2: batch enrich all DWS tables ────────────────────────────────────

/**
 * Build the DIM inventory from the layer's DIM tables (kind='dim').
 * @param semanticLayer - the semantic-layer directory path.
 * @returns the DIM inventory entries (table_name + primary_key + description + columns).
 */
export function buildDimInventory(semanticLayer: string): DimInventoryEntry[] {
  const out: DimInventoryEntry[] = []
  for (const t of loadTables(semanticLayer)) {
    const r = TableDefinitionSchema.safeParse(t.raw)
    if (!r.success || r.data.kind !== 'dim') continue
    out.push({
      table_name: r.data.table_name,
      primary_key: r.data.primary_key,
      description: r.data.description || r.data.table_comment,
      columns: r.data.columns.map(c => ({ name: c.name, comment: c.comment, type: c.type })),
    })
  }
  return out
}

/**
 * Read + validate the existing `dimension_refs` on a raw table dict (best-effort:
 * a non-array or invalid entry is dropped, mirroring the lenient scan).
 * Exported (module level, not the public barrel) for the relations table
 * adapter's `list` projection — the sweep target's `existing` items.
 * @param raw - the raw table dict (unparsed YAML).
 * @returns the valid existing DimensionRefs (empty when absent/invalid).
 */
export function existingRefs(raw: Record<string, unknown>): DimensionRef[] {
  const arr = raw.dimension_refs
  const out: DimensionRef[] = []
  if (!Array.isArray(arr)) return out
  for (const x of arr) {
    const v = DimensionRefSchema.safeParse(x)
    if (v.success) out.push(v.data)
  }
  return out
}

/** Read + validate the existing `external_refs` on a raw event dict (best-effort, mirrors existingRefs).
 * Exported for the relations event adapter's `list` projection. */
export function existingEventRefs(raw: Record<string, unknown>): DimensionRef[] {
  const arr = raw.external_refs
  const out: DimensionRef[] = []
  if (!Array.isArray(arr)) return out
  for (const x of arr) {
    const v = DimensionRefSchema.safeParse(x)
    if (v.success) out.push(v.data)
  }
  return out
}

/**
 * Origin-aware replace: the strategy used by the explicit `discoverRelations`
 * / `discoverEventRelations` entry (re-discover + replace). Keeps curated
 * existing refs — `manual` and `undefined` (legacy YAML written before the
 * `origin` field shipped, treated as manual per GA-I18N-1) — and drops
 * machine-generated ones — `deterministic` / `llm` — so a re-run can refresh
 * stale machine refs while never wiping a join the deterministic round cannot
 * rediscover. The kept-curated and freshly-discovered lists are then merged
 * via `mergeRefs` (union join_keys; curated derivation/origin preserved by
 * origin priority). GA-GT3 item 5 data-loss fix: the old replace branch
 * (`refs = discovered`) discarded all existing refs and wrote
 * `dimension_refs: []` with a misleading `enriched: 0`.
 * Exported (module level, not the public barrel) for the relations adapters'
 * `merge` stage (preserveCurated branch).
 * @param existing - the table's / event's existing validated refs (pre-write).
 * @param discovered - the freshly discovered refs (deterministic + optional LLM).
 * @returns curated existing preserved + machine-discovered refreshed, merged + deduped.
 */
export function originAwareReplaceRefs(
  existing: readonly DimensionRef[],
  discovered: readonly DimensionRef[],
): DimensionRef[] {
  // Position-preserving, not delegated to mergeRefs: mergeRefs appends any
  // dim_table missing from its baseline to the END of the result, so feeding
  // it a curated-only baseline (dropping machine refs before the call) would
  // make every refreshed machine ref jump to the tail even when its content
  // is byte-identical to before — a spurious reorder-only diff that breaks
  // sweep idempotency (two `discoverRelations` calls with nothing new to find
  // must produce the same array, not just the same set). Walking `existing`
  // once keeps curated refs verbatim in place and replaces each machine ref
  // in its own slot (or drops it, if this round no longer rediscovers it);
  // only a dim_table absent from `existing` altogether is new and goes to the end.
  const cloneRef = (r: DimensionRef): DimensionRef => ({
    dim_table: r.dim_table,
    join_keys: r.join_keys.map(k => ({ ...k })),
    derivation: r.derivation,
    origin: r.origin,
  })
  const discoveredByTable = new Map(discovered.map(r => [r.dim_table, r]))
  const result: DimensionRef[] = []
  for (const r of existing) {
    if (r.origin === 'manual' || r.origin == null) {
      result.push(cloneRef(r))
      continue
    }
    const fresh = discoveredByTable.get(r.dim_table)
    if (fresh) result.push(cloneRef(fresh)) // else: stale machine ref, not rediscovered -> dropped
  }
  const existingTables = new Set(existing.map(r => r.dim_table))
  for (const r of discovered) {
    if (!existingTables.has(r.dim_table)) result.push(cloneRef(r))
  }
  return result
}

// ── B1: event enrichment (mirror of the table round) ───────────────────

/**
 * The relations family's `merge` stage, shared verbatim by both kind adapters
 * (map #64; the #67 dedup collapsed the two mirror copies into this one):
 * the MergeContext three-branch. `mergeExisting=true` (the on-write hook's
 * never-wipe mode): merge everything — all existing preserved, discovered
 * unioned (`mergeRefs`). `false` + `preserveCurated=true` (default, the
 * explicit discoverRelations / discoverEventRelations entry): origin-aware
 * replace — keep curated (`manual`/`undefined`), drop machine
 * (`deterministic`/`llm`) so re-discovery refreshes stale machine refs
 * without wiping joins the deterministic round cannot rediscover (GA-GT3
 * item 5). `false` + `preserveCurated=false`: raw full replace — drop ALL
 * existing (incl. curated) and write only discovered (GA-GT3-5b
 * escape-hatch for blow-away-rebuild).
 */
export function relationsMerge<TDef>(
  _target: SweepTarget<TDef, DimensionRef>,
  existing: readonly DimensionRef[],
  discovered: readonly DimensionRef[],
  mergeContext: MergeContext,
): readonly DimensionRef[] {
  return mergeContext.mergeExisting
    ? mergeRefs(existing, discovered)
    : mergeContext.preserveCurated
      ? originAwareReplaceRefs(existing, discovered)
      : discovered
}

/**
 * Deterministic round for events: for each DIM with a non-empty `primary_key`,
 * emit a DimensionRef for every DIM PK column whose name exactly matches an
 * event `params_fields` key (the event param field is the foreign key).
 *
 * CL-18 Phase 2: an optional `excludeColumns` set filters out noise matches
 * (parallel to `discoverRelationsDeterministic` for DWS tables), so a DIM
 * keyed by a partition column does not match an event param of the same name.
 * @param eventDef - the event definition to find DIM joins for.
 * @param dimInventory - the DIM tables to match against.
 * @param excludeColumns - optional set of field names to exclude from PK matching (CL-18 Phase 2).
 * @returns one DimensionRef per DIM whose PK shares at least one non-excluded param-field name.
 */
export function discoverEventRelationsDeterministic(
  eventDef: EventDefinition,
  dimInventory: readonly DimInventoryEntry[],
  excludeColumns?: ReadonlySet<string>,
): DimensionRef[] {
  const fieldNames = new Set(Object.keys(eventDef.params_fields))
  const refs: DimensionRef[] = []
  for (const dim of dimInventory) {
    const pks = dim.primary_key.filter(pk => fieldNames.has(pk) && !(excludeColumns?.has(pk)))
    if (pks.length === 0) continue
    refs.push({
      dim_table: dim.table_name,
      join_keys: pks.map(pk => ({ dws_column: pk, dim_column: pk })),
      derivation: `确定性：事件字段 ${pks.join(', ')} 与 ${dim.table_name} 主键精确同名`,
      origin: 'deterministic',
    })
  }
  return refs
}

/**
 * Build the LLM prompt for one event: its params_fields (name + description) +
 * description, plus the DIM inventory. The model returns a JSON array of
 * DimensionRef (same schema as the DWS round).
 * @param eventDef - the event definition.
 * @param dimInventory - the DIM tables to consider.
 * @returns the assembled prompt text.
 */
export function buildEventLlmPrompt(eventDef: EventDefinition, dimInventory: readonly DimInventoryEntry[]): string {
  const fields = Object.entries(eventDef.params_fields)
    .map(([k, v]) => `- ${k} (${v.type || 'string'}): ${v.description || ''}`)
    .join('\n')
  const dims = dimInventory
    .map(d => `- ${d.table_name} | PK: [${d.primary_key.join(', ')}] | ${d.description || ''}`)
    .join('\n')
  return [
    `Discover dimension (DIM) join relations for the event \`${eventDef.name}\`.`,
    '',
    `Event: ${eventDef.name}`,
    `Description: ${eventDef.description || ''}`,
    'Params fields:',
    fields || '（无）',
    '',
    'DIM inventory (find joins where an event param field is a foreign key to a DIM primary_key — exact name OR semantic equivalence):',
    dims,
    '',
    'Return ONLY a JSON array of objects: [{"dim_table":"<DIM table_name>","join_keys":[{"dws_column":"<event field>","dim_column":"<DIM pk col>"}],"derivation":"<one sentence justification>"}].',
    'Rules: join_keys non-empty; only high-confidence foreign-key joins; if none, return [].',
  ].join('\n')
}

/**
 * Discover dimension relations for one event (two-round: deterministic + LLM).
 *
 * CL-18 Phase 2: `excludeColumns` (optional) is forwarded to the
 * deterministic round to filter out partition-column PK matches.
 * @param eventDef - the event definition.
 * @param dimInventory - the DIM tables to match against.
 * @param llmCall - optional one-shot LLM call for the semantic round.
 * @param excludeColumns - optional set of field names to exclude from deterministic PK matching.
 * @returns the merged DimensionRefs for the event.
 */
export async function discoverEventRelationsFor(
  eventDef: EventDefinition,
  dimInventory: readonly DimInventoryEntry[],
  llmCall?: LlmCall,
  excludeColumns?: ReadonlySet<string>,
): Promise<DimensionRef[]> {
  const det = discoverEventRelationsDeterministic(eventDef, dimInventory, excludeColumns)
  if (!llmCall) return det
  let llm: DimensionRef[] = []
  try {
    const text = await llmCall(buildEventLlmPrompt(eventDef, dimInventory))
    llm = parseLlmRefs(text)
  } catch {
    // best-effort: LLM round failure leaves the deterministic seed intact
  }
  return mergeRefs(det, llm)
}

// ── Suppression filter (#36 / #37, ADR-0010): merge 前, deterministic or LLM alike ──

/** A per-definition relation veto set: keys are `dim_table` names (verbatim — the
 * same key `mergeRefs` dedupes by). Corpus-level vetoes are alias-only (#37 §4).
 * Exported for the apply family and the relations adapters' `veto` stage —
 * same rationale as `aliasVetoSet` (`alt-labels.ts`). */
export function relationVetoSet(perAsset: readonly string[]): Set<string> {
  return new Set(perAsset)
}

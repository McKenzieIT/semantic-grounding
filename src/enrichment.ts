/**
 * AI-Native enrichment (B1/B2/CL-1) — discover DWS→DIM dimension relations +
 * discover alt_labels (SKOS aliases) for definitions.
 *
 * G3 design (resolved 2026-08-22):
 *  - Two-round strategy: (1) deterministic inference (no LLM);
 *    (2) LLM-assisted semantic supplement via an injectable `llmCall`.
 *  - Results merged + deduped; written directly (no approval).
 *  - `llmCall` is OPTIONAL: when absent, only the deterministic round runs.
 *
 * CL-1 Phase 3 (alt_labels enrichment):
 *  - Same two-round pattern: (1) deterministic extraction from description +
 *    column comments + domains; (2) LLM-suggested semantic aliases.
 *  - Targets all definition types (tables + events).
 *  - Merge preserves existing human-curated alt_labels.
 *
 * Substrate discipline: this module imports ONLY the substrate (types/io) +
 * atomic-write — it does NOT import `@deepseek-ai/dsh-llm`. The `llmCall`
 * adapter that wraps `ctx.llm` lives at the service/tool layer (B3/B4), so the
 * semantic-layer substrate stays zod + js-yaml only.
 *
 * @module @deepseek-ai/dsh-semantic-layer/src/enrichment
 */
import {
  TableDefinitionSchema,
  DimensionRefSchema,
  EventDefinitionSchema,
  type TableDefinition,
  type EventDefinition,
  type DimensionRef,
} from './types.ts'
import { loadTables, writeTable, loadEvents, writeEventYaml, dumpYaml } from './io.ts'

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
 * An injectable one-shot text LLM call (prompt in, text out). When omitted,
 * `discoverRelationsFor` runs the deterministic round only. Production wires
 * this to `ctx.llm` (B3/B4); the substrate stays free of the LLM dependency.
 */
export type LlmCall = (prompt: string) => Promise<string>

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
      if (r.derivation && (!ex.derivation || originPriority(r.origin) > originPriority(ex.origin))) {
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

function extractJsonArray(text: string): unknown[] {
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

/**
 * Parse + validate an LLM's textual response into DimensionRefs. Lenient: any
 * item failing `DimensionRefSchema` (e.g. empty join_keys) is dropped rather
 * than aborting the whole batch.
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
 * @param raw - the raw table dict (unparsed YAML).
 * @returns the valid existing DimensionRefs (empty when absent/invalid).
 */
function existingRefs(raw: Record<string, unknown>): DimensionRef[] {
  const arr = raw.dimension_refs
  const out: DimensionRef[] = []
  if (!Array.isArray(arr)) return out
  for (const x of arr) {
    const v = DimensionRefSchema.safeParse(x)
    if (v.success) out.push(v.data)
  }
  return out
}

/** Read + validate the existing `external_refs` on a raw event dict (best-effort, mirrors existingRefs). */
function existingEventRefs(raw: Record<string, unknown>): DimensionRef[] {
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
 * @param existing - the table's / event's existing validated refs (pre-write).
 * @param discovered - the freshly discovered refs (deterministic + optional LLM).
 * @returns curated existing preserved + machine-discovered refreshed, merged + deduped.
 */
function originAwareReplaceRefs(
  existing: readonly DimensionRef[],
  discovered: readonly DimensionRef[],
): DimensionRef[] {
  return mergeRefs(
    existing.filter(r => r.origin === 'manual' || r.origin == null),
    discovered,
  )
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
 * @param llmCall - optional one-shot LLM call for the semantic round.
 * @param tables - optional table_name filter; omit or empty to enrich all DWS tables.
 * @param mergeExisting - when true, merge discovered refs with existing (preserve curated); default false (replace).
 * @param excludeColumnsFn - optional per-target exclude-set builder (CL-18 Phase 2).
 * @param preserveCurated - when true (default), origin-aware replace (curated
 *   manual/undefined preserved, machine dropped); when false, raw full replace
 *   (ALL existing refs dropped, only discovered remain) — the escape-hatch for
 *   blow-away-rebuild (GA-GT3-5b). Ignored when `mergeExisting=true`.
 * @returns `enriched` (DWS tables that gained at least one ref) + `written` (DWS
 *   tables updated) + per-table `errors`.
 */
export async function enrichAllDwsTables(
  semanticLayer: string,
  llmCall?: LlmCall,
  tables?: readonly string[],
  mergeExisting = false,
  excludeColumnsFn?: (def: TableDefinition) => ReadonlySet<string> | undefined,
  preserveCurated = true,
): Promise<{ enriched: number; written: number; errors: string[]; note?: string }> {
  const dimInventory = buildDimInventory(semanticLayer)
  // GA-GT3 item 6: no DIM tables -> no joins are possible for any table; skip
  // the per-table write loop entirely (avoids writing dimension_refs:[] to every
  // DWS + a misleading written:N report). Curated refs are already on disk,
  // untouched. Under origin-aware replace (item 5) nothing would be destroyed
  // anyway; this is the efficiency + honest-reporting guard.
  if (dimInventory.length === 0) {
    // GA-GT3-6b: surface an agent-visible `note` (replaces console.warn, which
    // the agent cannot see) so callers/tooling understand why enriched/written
    // are 0 without scraping stderr. Curated dimension_refs are already on
    // disk, untouched. The note is forwarded up through discoverRelations ->
    // discover_relations tool result so the agent sees it inline.
    return { enriched: 0, written: 0, errors: [], note: 'no DIM tables in scope, nothing to enrich' }
  }
  const filter = tables !== undefined && tables.length > 0 ? new Set(tables) : undefined
  let enriched = 0
  let written = 0
  const errors: string[] = []
  for (const t of loadTables(semanticLayer)) {
    if (filter !== undefined && !filter.has(t.table_name)) continue
    const r = TableDefinitionSchema.safeParse(t.raw)
    if (!r.success) {
      errors.push(`${t.table_name}: schema parse failed`)
      continue
    }
    if (r.data.kind === 'dim') continue // only DWS
    try {
      const discovered = await discoverRelationsFor(r.data, dimInventory, llmCall, excludeColumnsFn?.(r.data))
      // mergeExisting=true (on-write hook): merge everything (preserve all existing,
      //   incl. machine).
      // mergeExisting=false (default, explicit discoverRelations): replace —
      //   preserveCurated=true (default): origin-aware — keep curated
      //     (manual/undefined), drop machine (deterministic/llm) so re-discovery
      //     refreshes stale machine refs without wiping joins the deterministic
      //     round cannot rediscover (GA-GT3 item 5 data-loss fix).
      //   preserveCurated=false: raw full replace — drop ALL existing (incl.
      //     curated) and write only discovered (GA-GT3-5b escape-hatch for
      //     blow-away-rebuild).
      const refs = mergeExisting
        ? mergeRefs(existingRefs(t.raw), discovered)
        : preserveCurated
          ? originAwareReplaceRefs(existingRefs(t.raw), discovered)
          : discovered
      // write raw + refs (preserves physical types / extra keys; writeTable validates)
      await writeTable(semanticLayer, t.table_name, { ...t.raw, dimension_refs: refs })
      written += 1
      if (refs.length > 0) enriched += 1
    } catch (e) {
      errors.push(`${t.table_name}: ${(e as Error).message}`)
    }
  }
  return { enriched, written, errors }
}

// ── B1: event enrichment (mirror of enrichAllDwsTables) ────────────────

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
 * @returns `enriched` (events gaining >=1 ref) + `written` (events updated) + per-event `errors`.
 */
export async function enrichAllEvents(
  semanticLayer: string,
  llmCall?: LlmCall,
  events?: readonly string[],
  mergeExisting = false,
  excludeColumnsFn?: (def: EventDefinition) => ReadonlySet<string> | undefined,
  preserveCurated = true,
): Promise<{ enriched: number; written: number; errors: string[]; note?: string }> {
  const dimInventory = buildDimInventory(semanticLayer)
  // GA-GT3 item 6: no DIM tables -> no joins possible for any event; skip the
  // per-event write loop (parallel to enrichAllDwsTables).
  if (dimInventory.length === 0) {
    // GA-GT3-6b: agent-visible `note` (replaces console.warn; parallel to
    // enrichAllDwsTables). Forwarded through discoverEventRelations so the
    // agent sees why enriched/written are 0 inline.
    return { enriched: 0, written: 0, errors: [], note: 'no DIM tables in scope, nothing to enrich' }
  }
  const filter = events !== undefined && events.length > 0 ? new Set(events) : undefined
  let enriched = 0
  let written = 0
  const errors: string[] = []
  for (const e of loadEvents(semanticLayer)) {
    if (filter !== undefined && !filter.has(e.name)) continue
    const r = EventDefinitionSchema.safeParse(e.raw)
    if (!r.success) {
      errors.push(`${e.name}: schema parse failed`)
      continue
    }
    try {
      const discovered = await discoverEventRelationsFor(r.data, dimInventory, llmCall, excludeColumnsFn?.(r.data))
      // mergeExisting=true (on-write hook — none for events today): merge everything.
      // mergeExisting=false (default, explicit discoverEventRelations): replace —
      //   preserveCurated=true (default): origin-aware — keep curated
      //     (manual/undefined), drop machine (deterministic/llm) so re-discovery
      //     refreshes stale machine refs without wiping curated joins (GA-GT3
      //     item 5 data-loss fix; parallel to enrichAllDwsTables).
      //   preserveCurated=false: raw full replace — drop ALL existing (incl.
      //     curated) and write only discovered (GA-GT3-5b escape-hatch for
      //     blow-away-rebuild; parallel to enrichAllDwsTables).
      const refs = mergeExisting
        ? mergeRefs(existingEventRefs(e.raw), discovered)
        : preserveCurated
          ? originAwareReplaceRefs(existingEventRefs(e.raw), discovered)
          : discovered
      const content = dumpYaml({ ...e.raw, external_refs: refs })
      const res = await writeEventYaml(semanticLayer, e.name, content)
      if (res.ok) {
        written += 1
        if (refs.length > 0) enriched += 1
      } else {
        errors.push(`${e.name}: ${res.error}`)
      }
    } catch (err) {
      errors.push(`${e.name}: ${(err as Error).message}`)
    }
  }
  return { enriched, written, errors }
}

// ── CL-1 Phase 3: alt_labels enrichment (G3 同构) ──────────────────────

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

/**
 * Deterministic round for alt_labels discovery: extract candidate aliases from
 * description, table_comment, column comments, and domains. No LLM needed.
 *
 * Heuristics:
 * - Chinese parenthesized terms in description/table_comment (e.g. "用户活跃度（DAU）" → "DAU")
 * - Quoted terms (single/double quotes, angle brackets) in description
 * - Domain names as-is (they're already business vocabulary)
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
  const candidates: string[] = []

  const desc = target.description || ''

  // Extract parenthesized terms: （xxx）or (xxx)
  for (const m of desc.matchAll(/[（(]([^）)]+)[）)]/g)) {
    const term = m[1]?.trim()
    if (term && term.length >= 2 && term.length <= 50) candidates.push(term)
  }

  // Extract quoted terms: "xxx" / 'xxx' / 「xxx」/ 《xxx》
  for (const m of desc.matchAll(/["'「《]([^"'」》]+)["'」》]/g)) {
    const term = m[1]?.trim()
    if (term && term.length >= 2 && term.length <= 50) candidates.push(term)
  }

  // Domains are business vocabulary — add directly
  for (const d of target.domains) {
    if (d.length >= 2) candidates.push(d)
  }

  // Dedupe against existing + self-id, then dedupe among candidates
  const seen = new Set(existing)
  const out: string[] = []
  for (const c of candidates) {
    const key = normalizeLabel(c)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

function normalizeLabel(s: string): string {
  return s.toLowerCase().trim()
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

/** Build an AltLabelsTarget from a parsed TableDefinition. */
function tableToAltLabelsTarget(def: TableDefinition): AltLabelsTarget {
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

/** Build an AltLabelsTarget from a parsed EventDefinition. */
function eventToAltLabelsTarget(def: EventDefinition): AltLabelsTarget {
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

/**
 * Enrich all tables in a semantic layer with alt_labels: discover aliases and
 * write them back into each table's YAML. Two-round (deterministic + LLM).
 * Merges with existing alt_labels (never removes curated labels).
 *
 * @param semanticLayer - the semantic-layer directory path.
 * @param llmCall - optional LLM call for the semantic round.
 * @param tables - optional table_name filter; omit/empty to enrich all.
 * @returns `enriched` (tables gaining >=1 new label) + `written` + per-table `errors`.
 */
export async function enrichAllTablesAltLabels(
  semanticLayer: string,
  llmCall?: LlmCall,
  tables?: readonly string[],
): Promise<{ enriched: number; written: number; errors: string[] }> {
  const filter = tables !== undefined && tables.length > 0 ? new Set(tables) : undefined
  let enriched = 0
  let written = 0
  const errors: string[] = []
  for (const t of loadTables(semanticLayer)) {
    if (filter !== undefined && !filter.has(t.table_name)) continue
    const r = TableDefinitionSchema.safeParse(t.raw)
    if (!r.success) {
      errors.push(`${t.table_name}: schema parse failed`)
      continue
    }
    try {
      const target = tableToAltLabelsTarget(r.data)
      const newLabels = await discoverAltLabelsFor(target, llmCall)
      if (newLabels.length === 0) continue
      const merged = mergeAltLabels(r.data.alt_labels, newLabels)
      await writeTable(semanticLayer, t.table_name, { ...t.raw, alt_labels: merged })
      written += 1
      enriched += 1
    } catch (e) {
      errors.push(`${t.table_name}: ${(e as Error).message}`)
    }
  }
  return { enriched, written, errors }
}

/**
 * Enrich all events in a semantic layer with alt_labels: discover aliases and
 * write them back into each event's YAML. Two-round (deterministic + LLM).
 * Merges with existing alt_labels (never removes curated labels).
 *
 * @param semanticLayer - the semantic-layer directory path.
 * @param llmCall - optional LLM call for the semantic round.
 * @param events - optional event-name filter; omit/empty to enrich all.
 * @returns `enriched` (events gaining >=1 new label) + `written` + per-event `errors`.
 */
export async function enrichAllEventsAltLabels(
  semanticLayer: string,
  llmCall?: LlmCall,
  events?: readonly string[],
): Promise<{ enriched: number; written: number; errors: string[] }> {
  const filter = events !== undefined && events.length > 0 ? new Set(events) : undefined
  let enriched = 0
  let written = 0
  const errors: string[] = []
  for (const e of loadEvents(semanticLayer)) {
    if (filter !== undefined && !filter.has(e.name)) continue
    const r = EventDefinitionSchema.safeParse(e.raw)
    if (!r.success) {
      errors.push(`${e.name}: schema parse failed`)
      continue
    }
    try {
      const target = eventToAltLabelsTarget(r.data)
      const newLabels = await discoverAltLabelsFor(target, llmCall)
      if (newLabels.length === 0) continue
      const merged = mergeAltLabels(r.data.alt_labels, newLabels)
      const content = dumpYaml({ ...e.raw, alt_labels: merged })
      const res = await writeEventYaml(semanticLayer, e.name, content)
      if (res.ok) {
        written += 1
        enriched += 1
      } else {
        errors.push(`${e.name}: ${res.error}`)
      }
    } catch (err) {
      errors.push(`${e.name}: ${(err as Error).message}`)
    }
  }
  return { enriched, written, errors }
}

/**
 * Enrich ALL definitions (tables + events) in a semantic layer with alt_labels.
 * Convenience wrapper: runs `enrichAllTablesAltLabels` + `enrichAllEventsAltLabels`.
 *
 * @param semanticLayer - the semantic-layer directory path.
 * @param llmCall - optional LLM call for the semantic round.
 * @param tables - optional table_name filter (omit to enrich all tables).
 * @param events - optional event-name filter (omit to enrich all events).
 * @returns combined `enriched` + `written` + `errors`.
 */
export async function discoverAltLabels(
  semanticLayer: string,
  llmCall?: LlmCall,
  tables?: readonly string[],
  events?: readonly string[],
): Promise<{ enriched: number; written: number; errors: string[] }> {
  const tRes = await enrichAllTablesAltLabels(semanticLayer, llmCall, tables)
  const eRes = await enrichAllEventsAltLabels(semanticLayer, llmCall, events)
  return {
    enriched: tRes.enriched + eRes.enriched,
    written: tRes.written + eRes.written,
    errors: [...tRes.errors, ...eRes.errors],
  }
}

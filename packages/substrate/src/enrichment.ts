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
 *    domains (NOT column comments — those feed only the LLM prompt; corrected
 *    in #38, this header and the round's own docstring both claimed otherwise);
 *    (2) LLM-suggested semantic aliases.
 *  - Targets all definition types (tables + events).
 *  - Merge preserves existing human-curated alt_labels.
 *
 * Substrate discipline: this module imports ONLY the substrate (types/io) +
 * atomic-write — it does NOT import `@deepseek-ai/dsh-llm`. The `llmCall`
 * adapter that wraps `ctx.llm` lives at the service/tool layer (B3/B4), so the
 * semantic-layer substrate stays zod + js-yaml only.
 *
 * @module enrichment (internal; only `"."` is importable — see ADR-0002)
 */
import {
  TableDefinitionSchema,
  DimensionRefSchema,
  EventDefinitionSchema,
  type TableDefinition,
  type EventDefinition,
  type DimensionRef,
} from './types.ts'
import { loadTables, writeTable, loadEvents, writeEventYaml, dumpYaml, loadSuppressions, type Tier2Opts } from './io.ts'

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

// ── Dimension-filter door validation (ADR-0007, #28) ────────────────────

/**
 * A dimension filter (`tables` / `events`) was rejected at the door: it named
 * definitions that do not exist in the corpus, or it was an empty array. Thrown by
 * {@link assertKnownFilterNames} — the whole-call, fail-early rejection ADR-0007 rules
 * for the Core discovery/listing methods, BEFORE any scan, write, or commit.
 *
 * A substrate-side sibling of `io.ts`'s `StaleBaselineError` / `WriteValidationError`
 * (a contract violation the *caller* can act on), not a coded wire error: the MCP
 * layer maps this onto its own `-31040` `UnknownFilterNameError` (`packages/mcp/src/
 * errors.ts`), the same way every other substrate condition gets its wire shape at the
 * tool boundary. The message lists every unknown name and never the corpus's full name
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
 * @param tier2 - optional Tier-2 options (#18); passed, each table write
 *   below is demoted-to-primitive through `writeTable`'s audited path
 *   instead of the default unaudited write. Not batched yet — one commit per
 *   table — until a recorder's `beginBatch` is wired through (#16).
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
  tier2?: Tier2Opts,
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
      const discoveredRaw = await discoverRelationsFor(r.data, dimInventory, llmCall, excludeColumnsFn?.(r.data))
      // Suppression filter (#36 输入 2, ADR-0010): the discovered exit — a vetoed
      // `dim_table` never reaches merge, whichever round proposed it (deterministic
      // or LLM: a veto constrains enrichment rounds, not just one of them).
      const vetoes = relationVetoSet(r.data.suppressed_dimension_refs)
      const discovered = vetoes.size === 0 ? discoveredRaw : discoveredRaw.filter(ref => !vetoes.has(ref.dim_table))
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
      await writeTable(semanticLayer, t.table_name, { ...t.raw, dimension_refs: refs }, {}, tier2)
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
      const discoveredRaw = await discoverEventRelationsFor(r.data, dimInventory, llmCall, excludeColumnsFn?.(r.data))
      // Suppression filter — the events mirror of enrichAllDwsTables's discovered
      // exit (445 of the 446 polluted definitions were events: day-one coverage).
      const vetoes = relationVetoSet(r.data.suppressed_external_refs)
      const discovered = vetoes.size === 0 ? discoveredRaw : discoveredRaw.filter(ref => !vetoes.has(ref.dim_table))
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
      const res = await writeEventYaml(semanticLayer, e.name, content, tier2)
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

function normalizeLabel(s: string): string {
  return s.toLowerCase().trim()
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

/** A per-definition relation veto set: keys are `dim_table` names (verbatim — the
 * same key `mergeRefs` dedupes by). Corpus-level vetoes are alias-only (#37 §4).
 * Exported for the apply family — same rationale as {@link aliasVetoSet}. */
export function relationVetoSet(perAsset: readonly string[]): Set<string> {
  return new Set(perAsset)
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
  const filter = tables !== undefined && tables.length > 0 ? new Set(tables) : undefined
  // Corpus-level veto word list (#37 §4): loaded once per sweep, unioned with each
  // definition's own suppressed_alt_labels at the candidate exit below.
  const corpusVetoes = loadSuppressions(semanticLayer)
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
      const discovered = await discoverAltLabelsFor(target, llmCall)
      // Suppression filter (#36 输入 2, ADR-0010): the candidate exit — AFTER
      // `discoverAltLabelsFor` (so the LLM round's suggestions are gated too),
      // BEFORE `mergeAltLabels`. All candidates vetoed ⇒ zero new labels ⇒ the
      // skip-write branch below leaves the file untouched (zero write, zero commit).
      const vetoes = aliasVetoSet(r.data.suppressed_alt_labels, corpusVetoes)
      const newLabels = vetoes.size === 0 ? discovered : discovered.filter(l => !vetoes.has(normalizeLabel(l)))
      if (newLabels.length === 0) continue
      const merged = mergeAltLabels(r.data.alt_labels, newLabels)
      await writeTable(semanticLayer, t.table_name, { ...t.raw, alt_labels: merged }, {}, tier2)
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
  const filter = events !== undefined && events.length > 0 ? new Set(events) : undefined
  // Corpus-level veto word list — the events mirror of enrichAllTablesAltLabels.
  const corpusVetoes = loadSuppressions(semanticLayer)
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
      const discovered = await discoverAltLabelsFor(target, llmCall)
      // Suppression filter — the candidate exit (see enrichAllTablesAltLabels).
      const vetoes = aliasVetoSet(r.data.suppressed_alt_labels, corpusVetoes)
      const newLabels = vetoes.size === 0 ? discovered : discovered.filter(l => !vetoes.has(normalizeLabel(l)))
      if (newLabels.length === 0) continue
      const merged = mergeAltLabels(r.data.alt_labels, newLabels)
      const content = dumpYaml({ ...e.raw, alt_labels: merged })
      const res = await writeEventYaml(semanticLayer, e.name, content, tier2)
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
 * @param tier2 - optional Tier-2 options (#18); forwarded verbatim to both
 *   `enrichAllTablesAltLabels` and `enrichAllEventsAltLabels`.
 * @returns combined `enriched` + `written` + `errors`.
 */
export async function discoverAltLabels(
  semanticLayer: string,
  llmCall?: LlmCall,
  tables?: readonly string[],
  events?: readonly string[],
  tier2?: Tier2Opts,
): Promise<{ enriched: number; written: number; errors: string[] }> {
  const tRes = await enrichAllTablesAltLabels(semanticLayer, llmCall, tables, tier2)
  const eRes = await enrichAllEventsAltLabels(semanticLayer, llmCall, events, tier2)
  return {
    enriched: tRes.enriched + eRes.enriched,
    written: tRes.written + eRes.written,
    errors: [...tRes.errors, ...eRes.errors],
  }
}

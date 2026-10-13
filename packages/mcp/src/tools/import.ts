/**
 * `import_definitions` — #68 landing #54's seven locked rulings (ADR-0013):
 * the bulk-seeding tool game-product initialization needs (~200 tables + ~200
 * events + ~50 concepts in one call; per-item `create_definition` round-trips
 * are the pattern this tool exists to retire). `create_definition`'s
 * discriminated-union write, scaled to a batch: three kinds, per-item
 * verdicts, one commit.
 *
 * ## The two phases (R4, `apply_enrichment`-shaped)
 *
 * - **Phase 1** (zero I/O writes): per-item strict zod `safeParse` + one
 *   cross-kind name `Set` (R2 — a repeated name in one batch is a duplicated
 *   section, not two definitions), then the existence/content read that sorts
 *   every surviving item into `created` / `updated` / `skipped` (R7). No
 *   cross-corpus checks — a `dimension_refs` gap is enrichment's design
 *   territory (`run_enrichment` reports it as work), not the import door's.
 * - **Phase 2** (inside `auditedWrite`): `beginBatch()` → per-item write riding
 *   the substrate's `auditedFileWrite` seam (`writeTable` / `writeEventYaml` /
 *   `core.writeConceptYaml` with `{recorder, scope_id}` — #61's post-ruling
 *   correction: ride the seam, never copy the ceremony) → one `batch.record()`
 *   per landed item → `end()`'s single commit, or zero commits when every item
 *   was idempotent. A thrown infrastructure failure aborts the batch whole;
 *   a per-item domain `{ok:false}` (theoretically unreachable — the tool
 *   schema and the write primitive validate against the same schema objects)
 *   stays in the verdict channel per R4's "坏项不中断批".
 *
 * ## Why the SDK-level item envelope is permissive (R1 reconciled with R4)
 *
 * #54's sketch drew the items array as a strict discriminated union, but a
 * strict union is validated by the SDK *before* the handler runs — one bad
 * item would reject the whole call, which is R4's all-batch-atomic outcome by
 * the back door. R4's verdict channel (`detail` carries "zod issue 或重名冲突")
 * requires the strict parse to happen per item, inside Phase 1. So the
 * envelope carries only the `kind` discriminant and an opaque `definition`,
 * `.describe()`d to point at `create_definition`'s advertised schema — the
 * strict shapes stay single-sourced, and one bad item costs exactly its own
 * verdict row.
 *
 * ## `updated` is a full-payload overwrite for tables/events, a read-merge-write for concepts
 *
 * The table/event compile targets are the raw-edit primitives
 * (`create_definition`'s own), so an item that differs from what is on disk
 * replaces the file wholesale: the batch is the agent's assertion that the dump
 * is truth (ADR-0012 R5 — transcription plus accountability is judgement), and
 * their refs (`dimension_refs` / `external_refs`) are ordinary `.loose()` payload
 * fields that ride the overwrite and are re-derivable by enrichment anyway.
 *
 * A concept `updated` is **not** an overwrite (ADR-0019 R2): it compiles to
 * `updateConceptMeta`'s read-merge-write — `{...disk eight keys, ...payload five
 * keys}` — so the item-verb fields the payload never owns (`related_refs`,
 * `suppressed_alt_labels`, `suppressed_related_refs`) survive the re-import from
 * disk. Concepts have no enrichment round (ADR-0012 / #46), so a dropped edge
 * has no deterministic re-derivation: the server-side preserve is the only line
 * of defense, and "import never writes edges" (ADR-0005 ruling 4) equally means
 * import must never erase them. The matching input-side half is R3: the concept
 * payload schema strips those three keys when present (a `get_definition` output
 * round-trips) while still rejecting genuinely unknown keys as typos.
 *
 * `skipped` asks "would this write be a no-op": tables/events compare the
 * zod-parsed payload against the loaded definition (both sides fully defaulted
 * by the same schema); concepts compare the five-key payload projection,
 * because a stored concept legitimately carries fields (`related_refs`,
 * `suppressed_*`) the create-shaped payload never had.
 *
 * ## The review surface: dry-run preview + mass-update guard (ADR-0018)
 *
 * There is no online second party at tool-call time (ADR-0004 — author=agent /
 * committer=server; humans audit post-hoc via `git log`), so the review face
 * "before this batch becomes source-of-truth" is two server-side facts, not an
 * approval queue:
 *
 * - **`dry_run:true`** runs Phase 1 and returns at the Phase-2 entrance — the
 *   same adjudication, per-item verdicts and summary, with `committed:false`
 *   and no audit window, no commit, no `_guidance`. A flag, not a second tool:
 *   Phase 1 is the single source of adjudication, and a flag exposes it with
 *   zero copying (and without growing `tools/list`).
 * - **The guard** keys on the `updated` bucket alone (a cold start is almost
 *   all `created` and must stay silent) and is a soft signal: a line in the
 *   response's `warnings` plus an annotation on the real write's commit
 *   subject, never a refusal — a hard cap is evaded by splitting the batch,
 *   and `.max(500)` already bounds runaway size. ADR-0019 R6's ratio guard
 *   (updated(kind)/existing(kind) per kind, with a small-corpus floor) rides
 *   the same two channels beside it.
 *
 * @module tools/import
 */
import { isDeepStrictEqual } from 'node:util'
import type { McpServer } from '@modelcontextprotocol/server'
import { dumpYaml, EventDefinitionSchema, TableDefinitionSchema, writeEventYaml, writeTable } from '@semantic-grounding/substrate'
import { z } from 'zod'
import type { ScopeBinding } from '../binding.ts'
import { toToolErrorResult } from '../errors.ts'
import type { ServerDeps, ToolRegistrar } from '../server.ts'
import { assertScopeMatch, auditedWrite, scopeStamp, toolSuccess, writeReceipt } from './audited.ts'
import { ConceptCreatePayloadSchema, ConfidenceSchema, CONCEPT_ITEM_VERB_KEYS, ScopeIdSchema, SummarySchema } from './shared.ts'

/** The bulk-import tool's single name (#54 R6 — intent-level, an `import_` verb joins the surface). */
export const IMPORT_TOOL_NAMES = ['import_definitions'] as const

/**
 * The mass-update guard's default count threshold (ADR-0018 R5: "default 建议
 * 50"). Lives here, beside its only consumer, for the same reason the guidance
 * thresholds live in `guidance.ts`: the `ServerConfig` field stays optional and
 * a test pins the default where the behaviour is.
 */
export const DEFAULT_MASS_UPDATE_WARN_THRESHOLD = 50

/** The kinds an import item may carry — `WritableKindSchema`'s three values, restated for this schema's own doc. */
type ImportKind = 'table' | 'event' | 'concept'

/**
 * One batch item's SDK-level envelope: the `kind` discriminant plus the
 * definition payload as an opaque value. See this module's doc for why the
 * strict per-kind parse is a Phase-1 concern, not an SDK-schema concern — the
 * `.describe()` strings are what keep the advertised shape discoverable.
 */
const ImportItemSchema = z.object({
  kind: z.enum(['table', 'event', 'concept'])
    .describe('Which definition layer this item seeds: table/event (the DW layer) or concept (the KG layer).'),
  definition: z.unknown()
    .describe('The complete definition payload for this kind — the exact schema create_definition validates for it (table → its `table` field, event → its `event` field, concept → its `concept` field). Validated per item: one invalid definition is an error verdict for that item alone; the rest of the batch proceeds.'),
}).strict()

/**
 * The tool's input — #54 R1's sketch verbatim in field names: batch-level
 * provenance at the top (100 tables from one DDL dump is one judgement, not
 * 100), `derivation` narrowed to `agent` (ADR-0012 R5 principle 1 —
 * transcription with accountability IS the caller's judgement; `llm` reports a
 * completion this tool has no way to attest), cap 500 enforced by zod so an
 * over-cap batch is a rejected call, never a silently truncated one (R3).
 */
const ImportDefinitionsInputSchema = z.object({
  scope_id: ScopeIdSchema,
  items: z.array(ImportItemSchema).min(1).max(500),
  summary: SummarySchema.describe('One line: what changed and on what basis — name the source (e.g. "imported from DDL dump"). Rides the single commit\'s subject; this is the batch\'s provenance record (ADR-0012 R5 principle 2).'),
  derivation: z.literal('agent')
    .describe('Must be "agent": importing means you transcribed the source and stand behind each item\'s applicability (ADR-0012 R5 — that is a judgement, not a derived fact).'),
  confidence: ConfidenceSchema,
  dry_run: z.boolean().optional()
    .describe('Read-only rehearsal (ADR-0018): run the Phase-1 adjudication — the exact per-item created/updated/skipped/error verdicts and batch summary a real call would produce — and return them WITHOUT opening the audit window, writing, or committing (the response says committed:false and carries no version fingerprints). For a large batch, or one that may overwrite existing definitions: preview with dry_run:true first, review the updated verdicts, then re-issue without it.'),
}).strict()

/** One item's verdict row — #54 R4's response shape. */
export interface ImportItemResult {
  /** The item's original `items` index, so a caller maps rows back to input. */
  readonly index: number
  readonly kind: ImportKind
  /** Best-effort name: the parsed definition's identity field, or `?` when zod never got that far. */
  readonly name: string
  readonly verdict: 'created' | 'updated' | 'skipped' | 'error'
  /** The item's backing-file sha256 fingerprint (#108's per-item write
   * receipt): present on every row whose file this call left settled —
   * `created`/`updated` from the write primitive, `skipped` resolved in-lock
   * (nothing was written, so the file's current fingerprint is the receipt);
   * `error` rows carry none (there is no settled file state to name). */
  readonly version?: string
  /** Present on `error` rows: the zod issue or the duplicate-name conflict. On
   * concept rows whose payload carried item-verb keys, a receipt of how many
   * were stripped and ignored (ADR-0019 R3) — `ignored N item-verb keys`. */
  readonly detail?: string
}

/** The counts block every result summary carries (R4). */
export interface ImportSummary {
  readonly created: number
  readonly updated: number
  readonly skipped: number
  readonly errors: number
}

/** Phase 1's product for one surviving item: everything Phase 2 needs to write it. */
interface StagedItem {
  readonly index: number
  readonly kind: ImportKind
  readonly name: string
  readonly verdict: 'created' | 'updated'
  readonly table?: z.infer<typeof TableDefinitionSchema>
  readonly event?: z.infer<typeof EventDefinitionSchema>
  readonly concept?: z.infer<typeof ConceptCreatePayloadSchema>
  /** Concepts only: how many of the three item-verb keys the raw payload
   * carried (stripped by the schema, receipted by the verdict row, ADR-0019 R3). */
  readonly ignoredItemVerbKeys?: number
}

/** Compact a zod error into one verdict-`detail` line: first issue's path + message. */
function firstIssue(err: z.ZodError): string {
  const issue = err.issues[0]
  if (issue === undefined) return err.message
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
  return `zod: ${path}: ${issue.message}`
}

/**
 * Count one verdict across rows — shared by the dry-run preview's summary and
 * the post-write summary, so both count from rows (never from Phase 1's sort
 * alone: a row IS the verdict of record).
 */
function countVerdict(rows: readonly ImportItemResult[], v: ImportItemResult['verdict']): number {
  return rows.filter(r => r.verdict === v).length
}

/** Best-effort identity from an unparseable payload — the row still needs a name to be readable. */
function rawName(kind: ImportKind, definition: unknown): string {
  const raw = definition as { table_name?: unknown; name?: unknown } | null | undefined
  const value = kind === 'table' ? raw?.table_name : raw?.name
  return typeof value === 'string' && value !== '' ? value : '?'
}

/**
 * Count how many of the three item-verb keys a raw concept payload carried —
 * the number the schema stripped and the verdict row receipts ("ignored N
 * item-verb keys", ADR-0019 R3). Counted from the raw input (not the parsed
 * output, where the keys are already gone), and only meaningful for concepts:
 * table/event refs are ordinary payload fields, not stripped anything.
 */
function ignoredItemVerbKeyCount(definition: unknown): number {
  if (typeof definition !== 'object' || definition === null) return 0
  const raw = definition as Record<string, unknown>
  let n = 0
  for (const key of CONCEPT_ITEM_VERB_KEYS) {
    if (key in raw) n += 1
  }
  return n
}

/**
 * Phase 1's per-item strict parse, as one tagged union so the kind and the
 * payload type travel together (a `schema` variable selected by `kind` parses
 * fine at runtime but leaves TypeScript holding the three output types as an
 * uncorrelated union).
 */
type ParsedItem =
  | { readonly ok: true; readonly kind: 'table'; readonly name: string; readonly table: z.infer<typeof TableDefinitionSchema> }
  | { readonly ok: true; readonly kind: 'event'; readonly name: string; readonly event: z.infer<typeof EventDefinitionSchema> }
  | { readonly ok: true; readonly kind: 'concept'; readonly name: string; readonly concept: z.infer<typeof ConceptCreatePayloadSchema> }
  | { readonly ok: false; readonly error: string }

function parseItem(kind: ImportKind, definition: unknown): ParsedItem {
  if (kind === 'table') {
    const r = TableDefinitionSchema.safeParse(definition)
    return r.success ? { ok: true, kind, name: r.data.table_name, table: r.data } : { ok: false, error: firstIssue(r.error) }
  }
  if (kind === 'event') {
    const r = EventDefinitionSchema.safeParse(definition)
    return r.success ? { ok: true, kind, name: r.data.name, event: r.data } : { ok: false, error: firstIssue(r.error) }
  }
  const r = ConceptCreatePayloadSchema.safeParse(definition)
  return r.success ? { ok: true, kind, name: r.data.name, concept: r.data } : { ok: false, error: firstIssue(r.error) }
}

/**
 * The R7 `skipped` question — "would writing this payload be a no-op?" — per
 * kind. Tables/events: deep-equal of the parsed payload against the loaded
 * definition (the same schema defaulted both sides, so omission and default
 * collapse to equal; an enrichment-touched file differs and correctly sorts to
 * `updated`). Concepts: the five-key projection of the loaded concept against
 * the payload — a stored concept carries `related_refs`/`suppressed_*` the
 * create-shaped payload never declares, and those must not manufacture a
 * phantom `updated` on an idempotent re-import.
 */
function wouldBeNoOp(kind: ImportKind, payload: unknown, existing: unknown): boolean {
  if (kind === 'table' || kind === 'event') {
    return isDeepStrictEqual(payload, existing)
  }
  const p = payload as z.infer<typeof ConceptCreatePayloadSchema>
  const e = existing as { readonly name: string; readonly description: string; readonly pref_label?: string; readonly alt_labels: readonly string[]; readonly properties: Record<string, unknown> }
  // `pref_label` joins the projection when either side declares it, so an
  // edge that exists on exactly one side is a real difference, and
  // `undefined` on both sides (isDeepStrictEqual distinguishes absent from
  // undefined keys) stays a no-op.
  const hasPref = p.pref_label !== undefined || e.pref_label !== undefined
  return isDeepStrictEqual(p, {
    name: e.name,
    description: e.description,
    alt_labels: e.alt_labels,
    properties: e.properties,
    ...hasPref ? { pref_label: e.pref_label } : {},
  })
}

// ── Ratio guard (ADR-0019 R6) ────────────────────────────────────────────────────────

/** Default ratio-guard threshold (ADR-0019 R6): a kind trips the soft WARN
 * when its `updated` share of its existing corpus exceeds 50%. */
export const DEFAULT_RATIO_GUARD_THRESHOLD = 0.5
/** Default small-corpus floor (ADR-0019 R6): below 10 existing definitions of
 * a kind the ratio is noise on a tiny denominator and only the absolute count
 * guard (ADR-0018, #104) applies — the ratio guard stays silent. */
export const DEFAULT_RATIO_GUARD_FLOOR = 10

/** One kind the ratio guard tripped on. */
export interface RatioGuardFinding {
  readonly kind: ImportKind
  readonly updated: number
  readonly existing: number
  /** `updated / existing`, already floored by the guard's precondition to exceed the threshold. */
  readonly ratio: number
  /** The threshold that was exceeded (for the message; reflects the effective config). */
  readonly threshold: number
}

/**
 * The ratio guard's denominator helper: how many definitions of each kind the
 * corpus already holds, counted **before** Phase 2 writes anything (the guard
 * runs at the Phase 2 entry, so the counts are the pre-batch corpus — an
 * `updated` item is by definition already inside its denominator).
 *
 * Counted from `projectGraphNodes({includeDerived:false})` — the schema-valid,
 * graph-attached scan — for the same reason `tools/guidance.ts`'s
 * `layerCounts` prefers it over raw loader output: a malformed leftover YAML
 * is not source-of-truth anyone is overwriting. A concept node's `kind` is the
 * fixed literal `'concept'` and an event's is `'event'`; a table's is its own
 * open storage kind (`dim`/`dws`), so tables fall out by elimination — the
 * same documented trick, per-kind this time.
 */
function existingKindCounts(snap: ScopeBinding): Readonly<Record<ImportKind, number>> {
  const nodes = snap.core.projectGraphNodes({ includeDerived: false })
  let tables = 0
  let events = 0
  let concepts = 0
  for (const node of nodes) {
    if (node.kind === 'concept') concepts += 1
    else if (node.kind === 'event') events += 1
    else tables += 1
  }
  return { table: tables, event: events, concept: concepts }
}

/**
 * The ADR-0019 R6 soft trigger, per kind: `updated(kind) / existing(kind)`
 * above the threshold AND `existing(kind)` at or above the small-corpus floor.
 * Soft by construction — the caller turns a finding into a response WARN plus
 * a commit-trailer annotation, never a rejection: the whole re-sync is one
 * `git revert`-able commit, and a hard refusal is trivially evaded by batch
 * splitting (the same reasoning ADR-0018 R4 gave the count guard).
 *
 * Deliberately self-contained against the ADR-0018 count guard (#104 lands it
 * separately over this same Phase 2 entry): own config field, own message, own
 * trailer segment — the two guards fire independently and compose additively.
 */
export function ratioGuardFindings(
  updatedByKind: Readonly<Record<ImportKind, number>>,
  existingByKind: Readonly<Record<ImportKind, number>>,
  threshold: number,
  floor: number,
): RatioGuardFinding[] {
  const findings: RatioGuardFinding[] = []
  for (const kind of ['table', 'event', 'concept'] as const) {
    const updated = updatedByKind[kind]
    const existing = existingByKind[kind]
    if (updated === 0 || existing < floor) continue
    const ratio = updated / existing
    if (ratio > threshold) findings.push({ kind, updated, existing, ratio, threshold })
  }
  return findings
}

/** One finding's `6/8 (75%)` fragment — shared by the WARN line and the trailer so they cannot drift apart. */
function ratioFragment(f: RatioGuardFinding): string {
  return `${f.updated}/${f.existing} (${Math.round(f.ratio * 100)}% > ${Math.round(f.threshold * 100)}%)`
}

/** The WARN line one finding contributes to the response's `warnings` block. */
function ratioWarnLine(f: RatioGuardFinding): string {
  return `ratio-guard (ADR-0019 R6): ${f.kind} ${ratioFragment(f)} — this re-import overwrites most of the existing ${f.kind} corpus; soft signal only (one git revert undoes the batch)`
}

/** The commit-trailer annotation all findings fold into, appended to the batch's intent target (ADR-0018 R4's channel). */
function ratioTrailer(findings: readonly RatioGuardFinding[]): string {
  return ` — ratio-guard: ${findings.map(f => `${f.kind} ${ratioFragment(f)}`).join(', ')}`
}

/**
 * Registers `import_definitions`.
 *
 * A commit-class write tool: `scope_id` asserted at entry (ADR-0011), one
 * `auditedWrite` window (lock + audit context), `beginBatch` inside it — the
 * exact structure `run_enrichment` settled for "N logical writes, one commit".
 */
function registerImportDefinitions(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'import_definitions',
    {
      title: 'Import a batch of definitions',
      description: 'Bulk-seed definitions for initialization: up to 500 items (table/event/concept mixed; there is no kind:"metric" item — metric candidates ride inline in their host table/event\'s `metrics` block) in one call, validated per item, landed as ONE commit (or zero when every item is idempotent). Each item gets a verdict — created / updated (payload differs from disk: full overwrite for table/event, read-merge-write for concept — a concept update preserves on-disk related_refs/suppressed_* because import never writes edges, ADR-0019 R2) / skipped (byte-equivalent, no commit) / error (bad schema or duplicate name in batch; does NOT abort the batch). A concept payload carrying related_refs / suppressed_alt_labels / suppressed_related_refs (e.g. a get_definition output fed straight back) has those keys stripped and ignored — the verdict row receipts "ignored N item-verb keys"; any other unknown key is a rejected typo (ADR-0019 R3). Provenance is batch-level: summary names the source, derivation must be "agent". No cross-corpus validation — dangling dimension_refs/domains are enrichment\'s to discover and report as work. Re-issuing the identical call is safe: all-skipped, no commit. For one definition, create_definition is the finer tool. Review surface (ADR-0018/0019): pass dry_run:true to rehearse the batch read-only (same verdicts and summary, nothing written — do this first for large batches or any re-import that may overwrite); two server-side guards then warn — never refusing — when a batch overwrites heavily: more than a configurable count of updated items (ADR-0018), or one kind\'s updated share of its existing corpus over a ratio threshold (default 50%, small-corpus floor 10; ADR-0019 R6). Both land a line in the response\'s `warnings` and annotate the commit subject for post-hoc git log review.',
      inputSchema: ImportDefinitionsInputSchema,
    },
    async (input, ctx) => {
      try {
        const snap = deps.bindings.requireSnapshot()
        assertScopeMatch(snap, input.scope_id)
        const root = snap.core.resolveScopeRoot()

        // ── Phase 1: pure adjudication, zero writes ──────────────────────────
        // Staged items do not get their row yet — Phase 2 owns created/updated
        // rows so a mid-batch domain failure can flip one to `error` without
        // leaving two rows for one index. Rows sort back to input order at the
        // end (staged writes interleave with Phase-1 skips in `results`).
        const results: ImportItemResult[] = []
        const staged: StagedItem[] = []
        const seen = new Map<string, number>()

        for (const [i, item] of input.items.entries()) {
          const parsed = parseItem(item.kind, item.definition)
          if (!parsed.ok) {
            results.push({ index: i, kind: item.kind, name: rawName(item.kind, item.definition), verdict: 'error', detail: parsed.error })
            continue
          }
          const name = parsed.name
          const firstIndex = seen.get(name)
          if (firstIndex !== undefined) {
            results.push({ index: i, kind: parsed.kind, name, verdict: 'error', detail: `duplicate name in batch: "${name}" already appeared at index ${firstIndex} (names dedupe across kinds)` })
            continue
          }
          seen.set(name, i)

          const existing = parsed.kind === 'table'
            ? snap.core.loadTableDefinition(name)
            : parsed.kind === 'event'
              ? snap.core.loadEventDefinition(name)
              : snap.core.loadConceptDefinition(name)
          const payload = parsed.kind === 'table' ? parsed.table : parsed.kind === 'event' ? parsed.event : parsed.concept
          // Concepts only: how many item-verb keys the schema stripped (R3's
          // receipt — the row tells the caller the keys were seen and ignored).
          const ignored = parsed.kind === 'concept' ? ignoredItemVerbKeyCount(item.definition) : 0
          if (existing !== null && wouldBeNoOp(parsed.kind, payload, existing)) {
            results.push({
              index: i, kind: parsed.kind, name, verdict: 'skipped',
              ...ignored > 0 ? { detail: `ignored ${ignored} item-verb keys (related_refs/suppressed_* are add_relation/add_alias territory)` } : {},
            })
            continue
          }
          staged.push({
            index: i,
            kind: parsed.kind,
            name,
            verdict: existing === null ? 'created' : 'updated',
            ...parsed.kind === 'table' ? { table: parsed.table } : parsed.kind === 'event' ? { event: parsed.event } : { concept: parsed.concept },
            ...ignored > 0 ? { ignoredItemVerbKeys: ignored } : {},
          })
        }

        const toWrite = staged.filter(s => s.verdict === 'created').length
        const toUpdate = staged.length - toWrite

        // ── Phase 2 entrance: the two batch-overwrite guards ────────────────
        // Both are soft signals, never refusals: a hard cap is trivially
        // evaded by splitting the batch, and `.max(500)` already bounds
        // runaway size. When tripped, each (a) puts a line in the response's
        // `warnings` — both this call's and the dry-run preview's, zero-tax
        // absent rather than an empty array — and (b) rides the intent
        // target, so the annotation lands in the real write's commit subject
        // where a post-hoc `git log` reader greps for it.
        let intentTarget = `${staged.length}/${input.items.length} items (${toWrite} created, ${toUpdate} updated)`
        const warnings: string[] = []

        // The mass-update guard (ADR-0018 R3/R4) keys on the `updated` bucket
        // alone — the danger a review surface exists for is "how much existing
        // source-of-truth does this batch overwrite", not "how many items" (a
        // cold start is almost all `created` and is this tool's raison d'être,
        // ADR-0013).
        const warnThreshold = deps.config.massUpdateWarnThreshold ?? DEFAULT_MASS_UPDATE_WARN_THRESHOLD
        if (toUpdate > warnThreshold) {
          const guardNote = `mass-update guard: ${toUpdate} updated exceeds threshold ${warnThreshold}`
          warnings.push(guardNote)
          intentTarget += `; ${guardNote}`
        }

        // The ratio guard (ADR-0019 R6): the corpus-relative soft trigger,
        // deliberately self-contained — own config field, own message, own
        // trailer segment — so the two fire independently. Cold start (all
        // `created`) never reaches the scan; below the floor the ratio is
        // noise on a tiny denominator and stays the count guard's call.
        if (toUpdate > 0) {
          const updatedByKind: Record<ImportKind, number> = { table: 0, event: 0, concept: 0 }
          for (const s of staged) {
            if (s.verdict === 'updated') updatedByKind[s.kind] += 1
          }
          const ratio = deps.config.massUpdateRatio
          const findings = ratioGuardFindings(
            updatedByKind,
            existingKindCounts(snap),
            ratio?.threshold ?? DEFAULT_RATIO_GUARD_THRESHOLD,
            ratio?.floor ?? DEFAULT_RATIO_GUARD_FLOOR,
          )
          if (findings.length > 0) {
            warnings.push(...findings.map(ratioWarnLine))
            intentTarget += ratioTrailer(findings)
          }
        }

        // ── ADR-0018 R2: the dry-run branch — Phase 1 has adjudicated, return ─
        if (input.dry_run === true) {
          // Read-only early return, BEFORE `auditedWrite`: no audit window, no
          // commit, no `_guidance` (that injection is a write-receipt fact).
          // The response is assembled read-tool style — scope stamp plus domain
          // — never through `writeReceipt`, whose `commit`/`changed` keys are
          // facts about a write that did not happen. No `version` anywhere:
          // fingerprints are post-write receipts (#108), and a skipped row's
          // in-lock resolution belongs to the window this branch never opens.
          // Staged rows get their verdict here because there is no Phase 2 to
          // own them — same adjudication, same rows a real call would land.
          // A tripped guard previews too: the rehearsal must predict the real
          // write's `warnings` exactly, or the preview is not a preview.
          const stagedRow = (s: StagedItem): ImportItemResult => ({ index: s.index, kind: s.kind, name: s.name, verdict: s.verdict })
          const preview = [...results, ...staged.map(stagedRow)].sort((a, b) => a.index - b.index)
          return toolSuccess({
            scope: scopeStamp(snap),
            committed: false,
            results: preview,
            staged: staged.map(stagedRow),
            summary: { created: countVerdict(preview, 'created'), updated: countVerdict(preview, 'updated'), skipped: countVerdict(preview, 'skipped'), errors: countVerdict(preview, 'error') },
            ...warnings.length > 0 ? { warnings } : {},
          })
        }

        // ── Phase 2: one audited window, one batch, one commit ───────────────
        const audited = await auditedWrite(
          snap,
          ctx,
          { tool: 'import_definitions', target: intentTarget, summary: input.summary, derivation: input.derivation, confidence: input.confidence },
          async () => {
            // Skipped rows' write receipts first, inside the lock: nothing is
            // written for them, so the receipt is the file's CURRENT
            // fingerprint — and the lock guarantees it cannot move between
            // here and the response (#108 / #107 Q3).
            for (const [i, row] of results.entries()) {
              if (row.verdict !== 'skipped') continue
              const current = row.kind === 'table'
                ? snap.core.loadTableDefinitionWithVersion(row.name)
                : row.kind === 'event'
                  ? snap.core.loadEventDefinitionWithVersion(row.name)
                  : snap.core.loadConceptDefinitionWithVersion(row.name)
              results[i] = { ...row, ...current?.version !== undefined ? { version: current.version } : {} }
            }
            const batch = snap.recorder.beginBatch()
            const tier2 = { recorder: snap.recorder, scope_id: snap.scopeId }
            try {
              for (const item of staged) {
                // #61's seam rule: each item rides `auditedFileWrite` via the raw
                // primitive with `tier2` — never a hand-copied ceremony. Inside
                // the open batch each primitive's `recordTier2Write` is absorbed;
                // `end()` stages the whole tree as the one commit.
                //
                // A concept `updated` does NOT compile to `writeConceptYaml`'s
                // wholesale overwrite: it takes `updateConceptMeta`'s Tier-2
                // read-merge-write (ADR-0019 R2) — same `auditedFileWrite` seam,
                // same batch absorption, same `version` receipt (#108) — so the
                // three item-verb keys on disk survive the re-import (concepts
                // have no enrichment round to re-derive a dropped edge). The
                // `created` branch keeps `writeConceptYaml`: there is no disk
                // state to merge over, and `updateConceptMeta` refuses a missing
                // file by design.
                const res = item.kind === 'table'
                  ? await writeTable(root, item.name, item.table, {}, tier2)
                  : item.kind === 'event'
                    ? await writeEventYaml(root, item.name, dumpYaml(item.event), tier2)
                    : item.verdict === 'updated'
                      ? await snap.core.updateConceptMeta(item.name, { ...item.concept })
                      : await snap.core.writeConceptYaml(item.name, item.concept)
                results.push(res.ok
                  ? {
                      index: item.index, kind: item.kind, name: item.name, verdict: item.verdict, version: res.version,
                      ...item.ignoredItemVerbKeys !== undefined ? { detail: `ignored ${item.ignoredItemVerbKeys} item-verb keys (related_refs/suppressed_* are add_relation/add_alias territory)` } : {},
                    }
                  : { index: item.index, kind: item.kind, name: item.name, verdict: 'error', detail: res.error })
                if (res.ok) batch.record('import_definitions', { kind: item.kind, name: item.name })
              }
              await batch.end()
              return undefined
            } catch (e) {
              await batch.abort()
              throw e
            }
          },
        )

        // Counted from the final rows, not from Phase 1's sort: a Phase-2
        // domain failure must not let the counts claim a write that did not land.
        const summary: ImportSummary = { created: countVerdict(results, 'created'), updated: countVerdict(results, 'updated'), skipped: countVerdict(results, 'skipped'), errors: countVerdict(results, 'error') }
        results.sort((a, b) => a.index - b.index)

        // No top-level `version`: one batch spans many files, so the
        // fingerprint rides each row — the envelope's `import` writePath
        // leaves it (and `enrichment_health`) absent by construction. A
        // tripped guard rides `domain` (ADR-0018 R4 / ADR-0019 R6): a
        // top-level observable soft signal, alongside the subject annotation
        // it already put there. `warnings` is zero-tax the same way — absent
        // unless a guard actually fired, never an empty array.
        return toolSuccess(await writeReceipt(snap, deps, audited, {
          tool: 'import_definitions',
          writePath: 'import',
          domain: { results, summary, ...warnings.length > 0 ? { warnings } : {} },
        }))
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

/** Registers the import tool family (one tool today). */
export const registerImportTools: ToolRegistrar = (server, deps) => {
  registerImportDefinitions(server, deps)
}

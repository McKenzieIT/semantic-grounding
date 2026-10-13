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
 * ## `updated` is a full-payload overwrite, and `skipped` is a deep-equal
 *
 * The compile targets are the three raw-edit primitives (`create_definition`'s
 * own), so an item that differs from what is on disk replaces the file
 * wholesale: the batch is the agent's assertion that the dump is truth
 * (ADR-0012 R5 — transcription plus accountability is judgement). A concept
 * re-imported with drifted content therefore replaces the file; edges the
 * payload does not carry (`related_refs` added since) are dropped, and the
 * `updated` verdict says so. `skipped` asks "would this write be a no-op":
 * tables/events compare the zod-parsed payload against the loaded definition
 * (both sides fully defaulted by the same schema); concepts compare the
 * five-key payload projection, because a stored concept legitimately carries
 * fields (`related_refs`, `suppressed_*`) the create-shaped payload never had.
 *
 * @module tools/import
 */
import { isDeepStrictEqual } from 'node:util'
import type { McpServer } from '@modelcontextprotocol/server'
import { dumpYaml, EventDefinitionSchema, TableDefinitionSchema, writeEventYaml, writeTable } from '@semantic-grounding/substrate'
import { z } from 'zod'
import { toToolErrorResult } from '../errors.ts'
import type { ServerDeps, ToolRegistrar } from '../server.ts'
import { assertScopeMatch, auditedWrite, toolSuccess, writeReceipt } from './audited.ts'
import { ConceptCreatePayloadSchema, ConfidenceSchema, ScopeIdSchema, SummarySchema } from './shared.ts'

/** The bulk-import tool's single name (#54 R6 — intent-level, an `import_` verb joins the surface). */
export const IMPORT_TOOL_NAMES = ['import_definitions'] as const

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
  /** Present on `error` rows: the zod issue or the duplicate-name conflict. */
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
}

/** Compact a zod error into one verdict-`detail` line: first issue's path + message. */
function firstIssue(err: z.ZodError): string {
  const issue = err.issues[0]
  if (issue === undefined) return err.message
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
  return `zod: ${path}: ${issue.message}`
}

/** Best-effort identity from an unparseable payload — the row still needs a name to be readable. */
function rawName(kind: ImportKind, definition: unknown): string {
  const raw = definition as { table_name?: unknown; name?: unknown } | null | undefined
  const value = kind === 'table' ? raw?.table_name : raw?.name
  return typeof value === 'string' && value !== '' ? value : '?'
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
      description: 'Bulk-seed definitions for initialization: up to 500 items (table/event/concept mixed; there is no kind:"metric" item — metric candidates ride inline in their host table/event\'s `metrics` block) in one call, validated per item, landed as ONE commit (or zero when every item is idempotent). Each item gets a verdict — created / updated (payload differs from disk: full overwrite, the batch is your assertion the dump is truth) / skipped (byte-equivalent, no commit) / error (bad schema or duplicate name in batch; does NOT abort the batch). Provenance is batch-level: summary names the source, derivation must be "agent". No cross-corpus validation — dangling dimension_refs/domains are enrichment\'s to discover and report as work. Re-issuing the identical call is safe: all-skipped, no commit. For one definition, create_definition is the finer tool.',
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
          if (existing !== null && wouldBeNoOp(parsed.kind, payload, existing)) {
            results.push({ index: i, kind: parsed.kind, name, verdict: 'skipped' })
            continue
          }
          staged.push({
            index: i,
            kind: parsed.kind,
            name,
            verdict: existing === null ? 'created' : 'updated',
            ...parsed.kind === 'table' ? { table: parsed.table } : parsed.kind === 'event' ? { event: parsed.event } : { concept: parsed.concept },
          })
        }

        const toWrite = staged.filter(s => s.verdict === 'created').length
        const toUpdate = staged.length - toWrite
        const intentTarget = `${staged.length}/${input.items.length} items (${toWrite} created, ${toUpdate} updated)`

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
                const res = item.kind === 'table'
                  ? await writeTable(root, item.name, item.table, {}, tier2)
                  : item.kind === 'event'
                    ? await writeEventYaml(root, item.name, dumpYaml(item.event), tier2)
                    : await snap.core.writeConceptYaml(item.name, item.concept)
                results.push(res.ok
                  ? { index: item.index, kind: item.kind, name: item.name, verdict: item.verdict, version: res.version }
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
        const count = (v: ImportItemResult['verdict']): number => results.filter(r => r.verdict === v).length
        const summary: ImportSummary = { created: count('created'), updated: count('updated'), skipped: count('skipped'), errors: count('error') }
        results.sort((a, b) => a.index - b.index)

        // No top-level `version`: one batch spans many files, so the
        // fingerprint rides each row — the envelope's `import` writePath
        // leaves it (and `enrichment_health`) absent by construction.
        return toolSuccess(await writeReceipt(snap, deps, audited, {
          tool: 'import_definitions',
          writePath: 'import',
          domain: { results, summary },
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

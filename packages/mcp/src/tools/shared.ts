/**
 * Shared pieces for ADR-0005's fifteen intent tools: the common Tier-2 parameter block,
 * the `update_definition` bounded-fields schema builder, the `version` fingerprint
 * (ADR-0004 ruling 8), the per-call `clientInfo` reader, and the Tier-1 pending-queue
 * path.
 *
 * Nothing here registers a tool — see `read.ts` / `write.ts` / `items.ts` /
 * `suggestions.ts` for the registrars that import from this module.
 *
 * @module tools/shared
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLIENT_INFO_META_KEY, type ServerContext } from '@modelcontextprotocol/server'
import { EventDefinitionSchema, TableDefinitionSchema, loadEvents } from '@semantic-grounding/substrate'
import { z } from 'zod'
import { DefinitionNotFoundError, DefinitionValidationError, UnsupportedUpdateFieldError } from '../errors.ts'
import type { GitTier2Recorder } from '../git/recorder.ts'

// ── Common Tier-2 parameter block (ADR-0005 ruling 7) ───────────────────────────────

/** `summary`: required on every Tier-2 tool, 1–100 characters — never server-synthesized (ruling 8). */
export const SummarySchema = z.string().min(1).max(100)
  .describe('One line: what changed and on what basis (1-100 characters). Becomes the commit subject; never invented by the server.')

/**
 * `derivation`: the trailer category, narrowed to the two values a *tool caller* may
 * honestly claim. `deterministic` is excluded on purpose — it names a server-internal
 * enrichment-round flow, and exposing it would hand a caller a way to label its own
 * guess as a derived fact (ADR-0005 ruling 7; the trailer domain itself has a third
 * value, `deterministic`, used only by the server's own on-write hook — see
 * `git/message.ts`).
 */
export const DerivationSchema = z.enum(['agent', 'llm'])
  .describe("How this content came to be: 'agent' (the calling agent's own judgement) or 'llm' (an LLM completion the agent is reporting). No default — a rough honest guess beats a silently-assumed one.")

/** `confidence`: required, no default (ruling 7: the trailer slot exists unconditionally). */
export const ConfidenceSchema = z.number().min(0).max(1)
  .describe("The caller's own confidence in this write, 0-1. Required rather than optional: an honest rough estimate beats a default standing in for an unknown.")

/**
 * `expected_version`: the sha256 fingerprint `get_definition` returned, required on
 * every update-class tool (`update_definition` / `add_alias` / `remove_alias` /
 * `add_relation` / `remove_relation`), omitted on `create_definition`, absent from
 * every Tier-1 tool (ADR-0005 ruling 7). A mismatch is rejected inside the corpus lock
 * as `stale_baseline` (ADR-0004 ruling 8) — re-read the definition and retry.
 */
export const ExpectedVersionSchema = z.string().regex(
  /^[0-9a-f]{64}$/,
  'expected_version must be the 64-character lowercase hex sha256 fingerprint get_definition returned',
).describe('The sha256 content fingerprint this write assumes the target still carries (from get_definition.version). A mismatch is rejected as stale_baseline: re-read and retry.')

/** The five Tier-2 fields every *create*-class tool shares (no `expected_version`). */
export const CREATE_COMMON_FIELDS = {
  summary: SummarySchema,
  derivation: DerivationSchema,
  confidence: ConfidenceSchema,
} as const

/** The common fields every *update*-class tool shares (adds the required baseline). */
export const UPDATE_COMMON_FIELDS = {
  ...CREATE_COMMON_FIELDS,
  expected_version: ExpectedVersionSchema,
} as const

// ── Kind discriminants ───────────────────────────────────────────────────────────────

/** The two kinds a tool may write (ADR-0005 ruling 2 and ruling 5: concept/metric have no write path in v1). */
export const WritableKindSchema = z.enum(['table', 'event'])

/** The four kinds `get_definition` / `search_definitions` may read — every registered built-in kind. */
export const ReadableKindSchema = z.enum(['table', 'event', 'concept', 'metric'])

// ── `add_relation` / `remove_relation` item shape ────────────────────────────────────

/** One `{dws_column, dim_column}` join-key pair — mirrors `DimensionKeyPairSchema` (not on the public barrel). */
export const JoinKeyInputSchema = z.object({
  dws_column: z.string().min(1),
  dim_column: z.string().min(1),
})

/**
 * The relation an agent asserts, as `add_relation` / `remove_relation` accept it.
 *
 * Deliberately missing two fields `DimensionRefSchema` has: `origin` (tool writes omit
 * it — ADR-0005 ruling 9, so the merge-priority machinery treats an agent-asserted ref
 * as curated and `enrichAll*`'s preserve-filter never overwrites it) and `derivation`
 * (ruling 10 — that field is a free-text join-basis note, a different concept from the
 * same-named trailer category above, and exposing both under one name is the
 * confusion ruling 10 refused; the agent's basis for the join belongs in `summary`).
 */
export const RelationRefInputSchema = z.object({
  dim_table: z.string().min(1),
  join_keys: z.array(JoinKeyInputSchema).min(1),
})
/** Parsed shape of {@link RelationRefInputSchema}. */
export type RelationRefInput = z.infer<typeof RelationRefInputSchema>

// ── `update_definition`'s bounded `fields` schema (ADR-0005 ruling 4) ───────────────

/**
 * Peel a top-level `.default(...)` off a field schema before making it `.optional()`.
 *
 * Why this exists, measured while building this file: zod applies a field's own
 * `.default()` whenever the key is *absent* from the parsed input, not only when it is
 * explicitly `undefined` — `.partial()` only wraps a field in `.optional()`, it does not
 * suppress that default. Every field on `TableDefinitionSchema` / `EventDefinitionSchema`
 * mirrors a pydantic model and carries one (lenient-parse heritage), so a naive
 * `.partial()` here would turn `update_definition({ fields: { description: 'x' } })`
 * into an `updates` object that *also* sets `alt_labels: []`, `dimension_refs: []`, and
 * every other defaulted field back to empty — silently wiping them on every partial
 * update. `.removeDefault()` strips that per field, so an omitted key stays genuinely
 * absent from the parsed result, which is the precondition for a safe shallow merge
 * over the existing YAML (`core.updateTableMeta` / `updateEventMeta`).
 * @param schema - one field's schema, as found on `TableDefinitionSchema.shape` / `EventDefinitionSchema.shape`.
 * @returns the same schema with any top-level default removed.
 */
function withoutDefault(schema: z.ZodType): z.ZodType {
  const maybeDefaulted = schema as unknown as { removeDefault?: () => z.ZodType }
  return typeof maybeDefaulted.removeDefault === 'function' ? maybeDefaulted.removeDefault() : schema
}

/**
 * Build `update_definition`'s per-kind `fields` schema from the kind's own full
 * definition schema, minus its identity field(s).
 *
 * Why derive rather than hand-list: ADR-0005 ruling 4 bounds `fields` to the kind's own
 * schema specifically so the advertised tool schema is never a hand-maintained second
 * copy that can drift from `TableDefinitionSchema` / `EventDefinitionSchema`. Deriving
 * from `.shape` (not re-declaring each sub-field) is what keeps it one source of truth.
 *
 * Why `z.object(schema.shape)` rather than `schema.omit(...)` directly: measured —
 * zod's `.omit()` throws ("cannot be used on object schemas containing refinements")
 * on `TableDefinitionSchema`, which carries the DIM `primary_key`/`label_columns`
 * `superRefine`. Rebuilding a plain `ZodObject` from `.shape` first drops the
 * refinement (irrelevant here — `fields` is a merge overlay, not a full definition,
 * and `updateTableMeta`/`updateEventMeta` re-validate the *merged* document against the
 * full schema, refinement included, before writing) and keeps every field's own type.
 *
 * `.strict()` rather than `.loose()`: a key that is neither an allowed field nor one of
 * `omitKeys` is a typo, and zod's own `unrecognized_keys` error is the right response —
 * silently stripping it (the default) would make a typo'd field vanish without a trace.
 * The two rejected categories ADR-0005 ruling 4 names get different treatment on
 * purpose: identity keys are `omit`-ed entirely (zod's generic "unrecognized key" is
 * adequate — there is no tool to redirect a rename to), while array-reference keys stay
 * *in* this schema (so zod accepts them) and are caught one level up, in the handler,
 * which is the only place that can attach the "use this tool instead" steer ruling 4
 * asks for (see {@link assertNoRedirectedFields}).
 * @param shape - the kind's full definition schema's `.shape` (`TableDefinitionSchema.shape` / `EventDefinitionSchema.shape`).
 * @param omitKeys - identity field name(s) to exclude entirely.
 * @returns a `.strict()` object schema: every other field, optional, default-stripped.
 */
function updatableFieldsSchema(shape: Readonly<Record<string, z.ZodType>>, omitKeys: ReadonlySet<string>): z.ZodObject<Record<string, z.ZodType>> {
  // A plain mutable record, not zod's own `ZodRawShape` (measured: that type carries a
  // *readonly* index signature in this zod version, so building one up key-by-key does
  // not typecheck) — `z.object()` accepts any `Record<string, z.ZodType>`.
  const next: Record<string, z.ZodType> = {}
  for (const [key, fieldSchema] of Object.entries(shape)) {
    if (omitKeys.has(key)) continue
    next[key] = withoutDefault(fieldSchema).optional()
  }
  return z.object(next).strict()
}

/** Table identity fields `update_definition` omits entirely (ADR-0005 ruling 4). */
const TABLE_IDENTITY_FIELDS = new Set(['table_name', 'kind'])
/** Event identity fields `update_definition` omits entirely. */
const EVENT_IDENTITY_FIELDS = new Set(['name'])

/** `update_definition(kind: 'table', ...)`'s bounded `fields` schema. */
export const TableFieldsSchema = updatableFieldsSchema(TableDefinitionSchema.shape, TABLE_IDENTITY_FIELDS)
/** `update_definition(kind: 'event', ...)`'s bounded `fields` schema. */
export const EventFieldsSchema = updatableFieldsSchema(EventDefinitionSchema.shape, EVENT_IDENTITY_FIELDS)

/** Array-reference field → the item-level tool pair that maintains it (ADR-0005 ruling 4's redirect), for tables. */
export const TABLE_ARRAY_REF_REDIRECT: Readonly<Record<string, string>> = {
  alt_labels: 'add_alias / remove_alias',
  dimension_refs: 'add_relation / remove_relation',
}
/** Array-reference field → the item-level tool pair that maintains it, for events. */
export const EVENT_ARRAY_REF_REDIRECT: Readonly<Record<string, string>> = {
  alt_labels: 'add_alias / remove_alias',
  external_refs: 'add_relation / remove_relation',
}

/**
 * Reject an array-reference field, pointing at the item-level tool that maintains it.
 *
 * This is the handler-side half of `update_definition`'s bounded `fields` schema: the
 * schema itself (built by {@link updatableFieldsSchema}) deliberately leaves
 * `alt_labels` / `dimension_refs` / `external_refs` in as ordinarily-typed optional
 * fields — rejecting them in zod would only produce a generic "unrecognized key"
 * message, with no way to attach the redirect ADR-0005 ruling 4 asks for.
 * @param fields - the already-parsed `fields` object (whichever keys the caller sent survive here).
 * @param redirect - the kind's array-reference redirect map ({@link TABLE_ARRAY_REF_REDIRECT} / {@link EVENT_ARRAY_REF_REDIRECT}).
 * @throws UnsupportedUpdateFieldError naming the first rejected field found and its replacement tool(s).
 */
export function assertNoRedirectedFields(fields: Readonly<Record<string, unknown>>, redirect: Readonly<Record<string, string>>): void {
  for (const [field, tools] of Object.entries(redirect)) {
    if (field in fields) {
      throw new UnsupportedUpdateFieldError(
        `update_definition does not accept "${field}": it is an array-reference field maintained item-by-item (ADR-0005 ruling 4) — use ${tools} instead`,
        { field, use_instead: tools },
      )
    }
  }
}

// ── Discriminating `updateTableMeta` / `updateEventMeta`'s non-throwing failure ─────

/** The shape `updateTableMeta` / `updateEventMeta` return — one success field name differs, the failure shape is identical. */
type UpdateResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

/**
 * Turn `updateTableMeta` / `updateEventMeta`'s non-throwing `{ok:false, error}` into
 * the right coded error — the substrate reports two genuinely different conditions
 * through that one string field, and ADR-0005 ruling 8 asks both to be discriminable.
 * @param result - whatever `core.updateTableMeta` / `core.updateEventMeta` resolved to.
 * @param kind - which kind was being updated (for the error's structured `data`).
 * @param name - the table_name / event name being updated.
 * @throws DefinitionNotFoundError when the substrate's message starts with
 *   `"Table not found"` / `"Event not found"` (the target vanished between this tool's
 *   own checks and the lock-protected write — see `write.ts` / `items.ts`).
 * @throws DefinitionValidationError for every other failure message (the merged
 *   document failed the kind's full schema).
 */
export function assertUpdateOk(result: UpdateResult, kind: 'table' | 'event', name: string): void {
  if (result.ok) return
  if (result.error.startsWith('Table not found') || result.error.startsWith('Event not found')) {
    throw new DefinitionNotFoundError(result.error, { kind, name })
  }
  throw new DefinitionValidationError(result.error, { kind, name })
}

// ── `version`: the sha256 content fingerprint (ADR-0004 ruling 8) ──────────────────

/**
 * @param content - the raw bytes a reader actually read.
 * @returns the sha256 hex fingerprint — identical to the one `checkExpectedVersion`
 *   (substrate `io.ts`, not on the public barrel) computes at write time, which is what
 *   makes a `get_definition` read-then-write round trip with `expected_version` work.
 */
function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

/**
 * The `version` fingerprint for a table definition: sha256 of the literal bytes at
 * `tables/<name>.yaml` — not a re-dump of the parsed object, which would not
 * byte-match (zod fills in defaults the file may not spell out). Exact and unambiguous:
 * `writeTable`/`updateTableMeta` compute the same path from the same two inputs.
 * @param root - the corpus root (`core.resolveScopeRoot()`).
 * @param name - the table's `table_name`.
 * @returns the hex fingerprint.
 */
export function fingerprintTable(root: string, name: string): string {
  return sha256Hex(readFileSync(join(root, 'tables', `${name}.yaml`), 'utf8'))
}

/**
 * The `version` fingerprint for a concept definition: sha256 of the literal bytes at
 * `concepts/<name>.yaml`. Concepts have no write path in v1 (ADR-0005 ruling 2), so no
 * tool ever checks this against an `expected_version` — it is reported for read
 * completeness and symmetry with table/event, not because a write consumes it today.
 * @param root - the corpus root.
 * @param name - the concept's `name`.
 * @returns the hex fingerprint.
 */
export function fingerprintConcept(root: string, name: string): string {
  return sha256Hex(readFileSync(join(root, 'concepts', `${name}.yaml`), 'utf8'))
}

/**
 * Find which `events/<domain>/` subdirectory holds an event, via the substrate's own
 * lenient scan (`loadEvents`, on the public barrel) — never a second, hand-rolled YAML
 * parse of this package's own.
 * @param root - the corpus root.
 * @param name - the event's `name`.
 * @returns the domain subdirectory name, or `undefined` when no event matches.
 */
export function findEventDomain(root: string, name: string): string | undefined {
  return loadEvents(root).find(e => e.name === name)?.domain
}

/**
 * The `version` fingerprint for an event definition: sha256 of the literal bytes at
 * `events/<domain>/<name>.yaml`.
 *
 * This is the one fingerprint that is not a single deterministic join: an event's
 * backing file is located by `findEventPath`'s *fast path* convention (filename equals
 * `<name>.yaml`), which is not on the public barrel. Every writer in this codebase
 * maintains that convention (`writeEventYaml` targets exactly this path for an existing
 * event, or `events/_suggested/<name>.yaml` for a new one), so this holds for every
 * machine-managed corpus. A corpus with a hand-renamed event file (the filename no
 * longer matching its own `name:` field) is a known, documented limitation: this throws
 * `ENOENT` — a loud internal fault (`toToolErrorResult` re-throws it, per this module's
 * header) rather than a silently wrong hash — and is flagged as Followup for whichever
 * ticket next touches read-path fingerprinting, rather than reproducing the substrate's
 * un-exported fallback scan here.
 * @param root - the corpus root.
 * @param name - the event's `name`.
 * @param domain - the domain subdirectory (from {@link findEventDomain}).
 * @returns the hex fingerprint.
 */
export function fingerprintEvent(root: string, name: string, domain: string): string {
  return sha256Hex(readFileSync(join(root, 'events', domain, `${name}.yaml`), 'utf8'))
}

// ── Per-call `clientInfo` (ADR-0005's 2026-10-09 addendum, second falsified premise) ─

/**
 * Read the calling client's self-reported name off the current request's envelope.
 *
 * `clientInfo` is per-request envelope data under the 2026-07-28 revision, not startup
 * data (#22's measurement: the `serveStdio` factory's ctx carries only `{era}`), so this
 * must be read fresh inside every tool handler and passed as `AuditContext.clientName`
 * — never cached at registration or construction time.
 *
 * `ctx.mcpReq.envelope`'s declared type is `Partial<RequestMetaEnvelope>`, and SDK
 * v2.3.1 declares `RequestMetaEnvelope` as the empty type `{}` ("a neutral hand-written
 * shape keyed by the public meta-key constants", per the SDK's own comment on that
 * alias) — so indexing it by {@link CLIENT_INFO_META_KEY} needs a widening cast under
 * this package's `strict`/`noUncheckedIndexedAccess` tsconfig; it is not a hole in this
 * file's own strictness. The value's shape is self-reported `Implementation`
 * (`{name, version, ...}` per the MCP spec) and is read defensively, never trusted for
 * anything beyond the `X-SG-Client` trailer (reference only, per ADR-0004 ruling 9).
 * @param ctx - the handler's `ServerContext` (the second callback parameter).
 * @returns the client's declared name, or `undefined` when the envelope carried none
 *   (a 2025-era connection, or a 2026-era request that omitted the optional key).
 */
export function clientNameFromEnvelope(ctx: ServerContext): string | undefined {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined
  const info = envelope?.[CLIENT_INFO_META_KEY]
  if (typeof info !== 'object' || info === null) return undefined
  const name = (info as { readonly name?: unknown }).name
  return typeof name === 'string' && name.trim() !== '' ? name : undefined
}

// ── Tier-1 pending queue location ────────────────────────────────────────────────────

/** The pending-queue directory name inside the git dir. */
export const PENDING_QUEUE_DIRNAME = 'sg-pending'

/**
 * Resolve the Tier-1 pending-queue directory for this process's corpus.
 *
 * `<gitDir>/sg-pending/`, not somewhere in the worktree — the exact reasoning
 * `git/lock.ts` already states for the corpus lock, applied to the same hazard: a
 * suggestion JSON file inside the worktree would be corpus *content*. `git status
 * --porcelain` would report it as an untracked, uncommitted change (`dirtyEntries`,
 * `git/posture.ts`, deliberately counts untracked files as dirt), so submitting a
 * suggestion would make the *next Tier-2 write* refuse with `PostureRefusedError` —
 * mistaking an agent's own suggestion for an operator's uncommitted edit. The git dir is
 * outside the tree git tracks, which is exactly the property both the lock and the
 * pending queue need, and reusing it needs no new corpus-level `.gitignore` entry this
 * package would otherwise have to ask the operator to add.
 *
 * Tier-1 never takes the corpus lock or writes a commit (GLOSSARY § write tier: "not an
 * auditable mutation; no recorder needed") — this only reads {@link GitTier2Recorder.ready}
 * for the git dir path, which is safe to call from a read-only tool.
 * @param recorder - this process's recorder (used only for its resolved git dir).
 * @returns the pending-queue directory's absolute path.
 */
export async function pendingQueueRoot(recorder: GitTier2Recorder): Promise<string> {
  const paths = await recorder.ready()
  return join(paths.gitDir, PENDING_QUEUE_DIRNAME)
}

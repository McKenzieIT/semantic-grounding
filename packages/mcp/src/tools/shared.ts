/**
 * Shared pieces for ADR-0005's intent families: the common Tier-2 parameter
 * block, the schema vocabulary (kinds, relation shapes, the bounded `fields`
 * builders), and the cross-family seams (definition loading, the array-field
 * redirect maps). Members whose one consumer is a single tool file belong in
 * that file — the ones briefly mis-homed here moved out to their consumers
 * (#145: the per-call `clientInfo` reader to `tools/audited.ts`, the Tier-1
 * pending-queue path to `tools/suggestions.ts`; #161: the update path's
 * apply/assert trio `applyFieldUpdate`/`ApplyResult`/`assertUpdateOk` to
 * `tools/write.ts`, whose `update_definition` handler is the trio's one
 * consumer).
 *
 * The `version` fingerprint helpers this module used to carry
 * (fingerprintTable/Concept/Event, findEventDomain) are retired: the read side of
 * ADR-0004 ruling 8's contract now lives in the substrate (`definitionVersion`,
 * `io.ts`, behind the Core class's `load*DefinitionWithVersion` methods), one
 * implementation shared with the write-side `checkExpectedVersion` instead of a
 * parallel copy that had already forked on hand-renamed event files.
 *
 * Nothing here registers a tool — see `read.ts` / `write.ts` / `items.ts` /
 * `suggestions.ts` for the registrars that import from this module. The one thing
 * added since (#115 / C3) is type-only: the `ToolFamily` descriptor-card interface
 * every family file's `X_TOOL_FAMILY` binds through, so each family keeps owning its
 * names and its registrar while `index.ts` composes the cards.
 *
 * @module tools/shared
 */
import { ConceptDefinitionSchema, EventDefinitionSchema, TableDefinitionSchema, type ConceptDefinition, type EventDefinition, type SemanticGroundingCore, type TableDefinition } from '@semantic-grounding/substrate'
import { z } from 'zod'
import { UnsupportedUpdateFieldError } from '../errors.ts'
import { SCOPE_ID_PATTERN } from '../scope-registry.ts'
import type { ToolRegistrar } from '../server.ts'

// ── Tool family descriptor (#115 / C3) ────────────────────────────────────────────

/**
 * One tool family's descriptor card: the family's own name constant bound to its own
 * registrar, both still defined and exported in the family's file — the card is pure
 * binding, a second home for neither key. `tools/index.ts` composes these cards into
 * every flat list the server consumes (`TOOL_NAMES` / `TOOL_REGISTRARS` and the intent
 * halves), so adding a family means exporting a card and taking one slot in one list,
 * never re-hand-gluing names against registrars somewhere else — the drift
 * `server.ts`'s former hand-written registrar mirror and the e2e gate's former
 * hand-listed step name both demonstrated before this type existed.
 *
 * The type lives here rather than `tools/index.ts` because every family file already
 * leans on this module, while `index.ts` imports the cards themselves — a type in
 * `index.ts` would force family → index → family import cycles. The `register` key's
 * type is `server.ts`'s {@link ToolRegistrar}, imported type-only above (erased at
 * compile time), matching the value-level direction that already exists:
 * `server.ts` → `tools/index.ts` → family files, never back at runtime.
 */
export interface ToolFamily {
  /** The family's tool-name constant (`X_TOOL_NAMES`) — the wire names `tools/list` reports. */
  readonly names: readonly string[]
  /** The family's registrar (`registerXTools`) — pure registration, per `ToolRegistrar`'s own contract. */
  readonly register: ToolRegistrar
}

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

/**
 * `scope_id`: the write assertion of ADR-0011's three-layer defense, required on the
 * 8 commit-class tools. Compared synchronously at handler entry against the snapshot
 * the handler bound — a mismatch is `scope_mismatch` (−31064), not a silent redirect.
 * The charset is the registry's own {@link SCOPE_ID_PATTERN} (constant 6), imported
 * rather than re-spelled — the rule's one home — conservative, trailer- and path-safe.
 */
export const ScopeIdSchema = z.string().regex(
  SCOPE_ID_PATTERN,
  'scope_id must match /^[a-z0-9][a-z0-9-]*$/ (1-64 chars) — it rides the X-SG-Scope trailer and paths',
).min(1).max(64)
  .describe('The scope this write asserts it is serving (from the tool response\'s scope.id, or list_scopes). Checked against the server\'s active scope at call entry: a mismatch means a switch happened after your read — switch_scope or re-read under the new scope.')

/** The five Tier-2 fields every *create*-class tool shares (no `expected_version`). */
export const CREATE_COMMON_FIELDS = {
  scope_id: ScopeIdSchema,
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

/**
 * The kinds a definition-level tool may write. ADR-0005 ruling 2 excluded
 * concept from every write path in v1; ADR-0012 (#46 R3) superseded that for
 * concepts — `create_definition`/`update_definition` accept `kind:'concept'`
 * (the trajectory-driven cold start registers domain terms that map to no
 * single asset). **metric stays excluded**: an inline `metrics:` block is a
 * derived read-only view with no backing file and no fingerprint.
 */
export const WritableKindSchema = z.enum(['table', 'event', 'concept'])

/** The four kinds `get_definition` / `search_definitions` may read — every registered built-in kind. */
export const ReadableKindSchema = z.enum(['table', 'event', 'concept', 'metric'])

/**
 * The kinds `add_alias` / `remove_alias` accept (ADR-0012 #46 R3's 枚举拆分:
 * the alias pair gets its own enum so it evolves independently of the
 * definition-level and relation surfaces). Concepts joined at the same time
 * the concept write path opened — alias semantics are isomorphic across all
 * three kinds (dual-field overlay, remove-is-veto, add-is-lift).
 */
export const AliasKindSchema = z.enum(['table', 'event', 'concept'])

/** The kinds `add_relation` / `remove_relation` may take as their SUBJECT. */
export const RelationSubjectKindSchema = z.enum(['table', 'event', 'concept'])

/**
 * The kinds a relation target may take. Q4(b) (#52) extended the target beyond
 * tables: a relation may now point at a concept. The legal subject×target
 * combinations are table/event→table (the historical join), concept→concept,
 * concept→table, and table→concept — event→concept is refused in the Core
 * (not one of Q4(b)'s three edges).
 */
export const RelationTargetKindSchema = z.enum(['table', 'concept'])

// ── Writable-definition loading seams (#144) ────────────────────────────────────────

/**
 * Load one writable kind's definition by name — the kind→`load*Definition`
 * dispatch, single-sourced (#144). Five call sites hand-wrote this three-way
 * ladder before (`write.ts`'s three create-side existence checks; `import.ts`'s
 * Phase-1 read and the WithVersion variant below), each re-pairing kind with
 * core method on its own. This is a *loading* seam, not `read.ts`'s
 * `get_definition` per-kind response dispatch — that path shapes output per
 * kind and stays where it is. Callers treat the result as the union they need:
 * an existence check tests it against null, and `import`'s no-op comparison
 * receives it as the `unknown` side of `isDeepStrictEqual`.
 * @param core - the serving snapshot's core (`snap.core`).
 * @param kind - {@link WritableKindSchema}'s three values.
 * @param name - the definition's identity key (`table_name` for tables, `name` otherwise).
 * @returns the parsed definition, or null when no definition of that kind matches.
 */
export function loadWritable(
  core: SemanticGroundingCore,
  kind: 'table' | 'event' | 'concept',
  name: string,
): TableDefinition | EventDefinition | ConceptDefinition | null {
  if (kind === 'table') return core.loadTableDefinition(name)
  if (kind === 'event') return core.loadEventDefinition(name)
  return core.loadConceptDefinition(name)
}

/**
 * {@link loadWritable}'s fingerprint-carrying half — the same dispatch over
 * the `load*DefinitionWithVersion` methods (ADR-0004 ruling 8's read side:
 * definition plus the sha256 of the exact file an update-class write checks
 * `expected_version` against). Its one caller today is `import`'s skipped-row
 * receipt, which reads the file's CURRENT `version` (nothing was written for a
 * skipped item, so the file's present fingerprint IS the receipt, #108) and
 * ignores the `definition` half.
 * @param core - the serving snapshot's core (`snap.core`).
 * @param kind - {@link WritableKindSchema}'s three values.
 * @param name - the definition's identity key (`table_name` for tables, `name` otherwise).
 * @returns the parsed definition and its `version` fingerprint, or null when
 *   no definition of that kind matches (or, per the substrate's own contract,
 *   thrown loudly when a definition loads but its backing file cannot be
 *   resolved).
 */
export function loadWritableWithVersion(
  core: SemanticGroundingCore,
  kind: 'table' | 'event' | 'concept',
  name: string,
): { readonly definition: TableDefinition | EventDefinition | ConceptDefinition; readonly version: string } | null {
  if (kind === 'table') return core.loadTableDefinitionWithVersion(name)
  if (kind === 'event') return core.loadEventDefinitionWithVersion(name)
  return core.loadConceptDefinitionWithVersion(name)
}

// ── `add_relation` / `remove_relation` item shape ────────────────────────────────────

/** One `{dws_column, dim_column}` join-key pair — mirrors `DimensionKeyPairSchema` (not on the public barrel). */
export const JoinKeyInputSchema = z.object({
  dws_column: z.string().min(1),
  dim_column: z.string().min(1),
})

/**
 * The relation an agent asserts, as `add_relation` / `remove_relation` accept
 * it — one of two shapes (a union, not a discriminated union: the historical
 * join shape carries no discriminator key and must keep accepting byte-old
 * callers):
 *
 * 1. A **join** (`dim_table` + `join_keys`) — the historical shape, for a
 * table or event subject pointing at a DIM table.
 *
 * 2. A **concept-side edge** (`target_kind` + `name`) — Q4(b) (#52): no join
 * semantics, for concept→concept, concept→table, and table→concept edges.
 *
 * Both shapes deliberately miss two fields `DimensionRefSchema` has: `origin`
 * (tool writes omit it — ADR-0005 ruling 9, so the merge-priority machinery
 * treats an agent-asserted ref as curated and `enrichAll*`'s preserve-filter
 * never overwrites it) and `derivation` (ruling 10 — that field is a
 * free-text join-basis note, a different concept from the same-named trailer
 * category above, and exposing both under one name is the confusion ruling 10
 * refused; the agent's basis for the relation belongs in `summary`).
 */
export const JoinRelationInputSchema = z.object({
  dim_table: z.string().min(1),
  join_keys: z.array(JoinKeyInputSchema).min(1),
})

/** One concept-side edge: the target's kind + its bare name (Q4(b)). */
export const ConceptEdgeInputSchema = z.object({
  target_kind: RelationTargetKindSchema,
  name: z.string().min(1),
})

export const RelationRefInputSchema = z.union([JoinRelationInputSchema, ConceptEdgeInputSchema])
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

/** Array-reference field → the item-level tool pair that maintains it (ADR-0005 ruling 4's redirect), for tables. The `suppressed_*` keys ride the same verbs (#38 / ADR-0010): a veto is born by remove and lifted by add, never written as a bare field. */
export const TABLE_ARRAY_REF_REDIRECT: Readonly<Record<string, string>> = {
  alt_labels: 'add_alias / remove_alias',
  dimension_refs: 'add_relation / remove_relation',
  suppressed_alt_labels: 'add_alias / remove_alias (vetoes are born by remove_*, lifted by add_* — never hand-written)',
  suppressed_dimension_refs: 'add_relation / remove_relation (vetoes are born by remove_*, lifted by add_* — never hand-written)',
}
/** Array-reference field → the item-level tool pair that maintains it, for events. */
export const EVENT_ARRAY_REF_REDIRECT: Readonly<Record<string, string>> = {
  alt_labels: 'add_alias / remove_alias',
  external_refs: 'add_relation / remove_relation',
  suppressed_alt_labels: 'add_alias / remove_alias (vetoes are born by remove_*, lifted by add_* — never hand-written)',
  suppressed_external_refs: 'add_relation / remove_relation (vetoes are born by remove_*, lifted by add_* — never hand-written)',
}
/** Array-reference field → the item-level tool pair that maintains it, for concepts
 * (ADR-0012 #46 R3 伴生点 1). Concepts have no dimension_refs/external_refs — their
 * declared edges live in `related_refs`, maintained by the same relation pair with a
 * `target_kind`-carrying shape (Q4(b)). */
export const CONCEPT_ARRAY_REF_REDIRECT: Readonly<Record<string, string>> = {
  alt_labels: 'add_alias / remove_alias',
  related_refs: 'add_relation / remove_relation (concept-side edges: {target_kind, name})',
  suppressed_alt_labels: 'add_alias / remove_alias (vetoes are born by remove_*, lifted by add_* — never hand-written)',
  suppressed_related_refs: 'add_relation / remove_relation (vetoes are born by remove_*, lifted by add_* — never hand-written)',
}

// ── `create_definition(kind:'concept')`'s payload + `update_definition`'s fields ─────

/**
 * The three item-verb keys a *stored* concept carries that the create-shaped
 * payload never owns (ADR-0005 ruling 4): the declared-edge home `related_refs`
 * plus its two suppression shadows. ADR-0019 R3's projection contract rules
 * their presence in a create/import payload **round-trip legality, not a typo** —
 * `get_definition` returns all eight keys, and feeding its output straight back
 * must not zod-fail — so the schema strips them and ignores them, while every
 * key outside the five describable fields + these three stays a genuinely
 * unknown key zod rejects. Exported so the import path can count how many it
 * stripped for its verdict receipt without a second copy of the list.
 */
export const CONCEPT_ITEM_VERB_KEYS = ['related_refs', 'suppressed_alt_labels', 'suppressed_related_refs'] as const

/**
 * `create_definition(kind:'concept')`'s payload — the R3 full-payload shape plus
 * Q4(b)'s `properties`. Strict on purpose (ADR-0012's constant: tool inputs are
 * bounded by the kind's declared fields — `.loose()` is corpus compatibility, the
 * tool face rejects stray keys), with one carve-out ADR-0019 R3 adds: the three
 * {@link CONCEPT_ITEM_VERB_KEYS} are *stripped* when present rather than
 * rejected — edges and vetoes are item-level verbs (add_relation / add_alias),
 * exactly as for tables/events, and a `get_definition` output carries them by
 * construction, so their presence is a legal round-trip, not a typo. Any other
 * stray key still is one, and zod answers it. `description` is required where
 * the substrate schema defaults it to `''`: a concept with no description
 * carries nothing the trajectory-driven cold start registered it FOR (the
 * term's meaning), and the search index would see a bare name.
 */
export const ConceptCreatePayloadSchema = z.preprocess(
  (raw) => {
    if (typeof raw !== 'object' || raw === null) return raw
    const next = { ...(raw as Record<string, unknown>) }
    for (const key of CONCEPT_ITEM_VERB_KEYS) delete next[key]
    return next
  },
  z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    pref_label: z.string().optional(),
    alt_labels: z.array(z.string()).default([]),
    properties: z.record(z.string(), z.unknown()).default({}),
  }).strict(),
).describe('The concept\'s five describable fields (name, description, pref_label?, alt_labels, properties). related_refs / suppressed_alt_labels / suppressed_related_refs are item-verb fields managed by add_relation / add_alias — present-implies-ignored (stripped) so a get_definition output round-trips; any other unknown key is a typo and is rejected.')
/** Parsed shape of {@link ConceptCreatePayloadSchema}. */
export type ConceptCreatePayload = z.infer<typeof ConceptCreatePayloadSchema>

/** Concept identity fields `update_definition` omits entirely (ADR-0005 ruling 4). */
const CONCEPT_IDENTITY_FIELDS = new Set(['name'])

/**
 * `update_definition(kind: 'concept', ...)`'s bounded `fields` schema — derived
 * from `ConceptDefinitionSchema.shape − {name}` the same way the table/event
 * fields schemas are (ADR-0005 ruling 4's one-source-of-truth rule), which
 * after Q4(b) yields: `description`, `pref_label`, `properties` (the free-form
 * entity attributes are a passthrough update field), plus the array-reference
 * keys the handler redirects (`alt_labels`, `related_refs`, `suppressed_*`).
 */
export const ConceptFieldsSchema = updatableFieldsSchema(ConceptDefinitionSchema.shape, CONCEPT_IDENTITY_FIELDS)

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

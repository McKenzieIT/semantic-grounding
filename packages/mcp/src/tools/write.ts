/**
 * ADR-0005's two definition-level write tools: `create_definition` and
 * `update_definition`.
 *
 * Both are Tier-2, both drive the audit seam through `auditedWrite`
 * (`tools/audited.ts` wraps `GitTier2Recorder.runAudited` — never call a
 * substrate write function directly: the lock has to wrap the call, and a
 * contextless write is refused, per `git/recorder.ts`'s module doc).
 * `create_definition` compiles to the raw-edit primitives `writeTable` /
 * `writeEventYaml` / `core.writeConceptYaml` with a recorder passed on every
 * call (ADR-0004 ruling 2, ADR-0005 ruling 5 — the recorder is mandatory, not
 * optional); `update_definition` compiles to `core.updateTableMeta` /
 * `core.updateEventMeta` / `core.updateConceptMeta` via `applyFieldUpdate`,
 * which is what gives it the on-write enrichment hook `create_definition`
 * deliberately does not get (see this file's `create_definition` section —
 * and concepts get no hook on either verb: they have no enrichment rounds,
 * ADR-0012).
 *
 * @module tools/write
 */
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import { EventDefinitionSchema, TableDefinitionSchema, dumpYaml, writeEventYaml, writeTable } from '@semantic-grounding/substrate'
import { z } from 'zod'
import type { ScopeBinding } from '../binding.ts'
import { DefinitionAlreadyExistsError, DefinitionNotFoundError, DefinitionValidationError, UnsupportedUpdateFieldError, isSubstrateNotFound } from '../errors.ts'
import type { ServerDeps, ToolRegistrar } from '../server.ts'
import { assertScopeMatch, auditedWrite, toolSuccess, writeReceipt } from './audited.ts'
import {
  CREATE_COMMON_FIELDS,
  ConceptCreatePayloadSchema,
  ConceptFieldsSchema,
  EventFieldsSchema,
  TableFieldsSchema,
  UPDATE_COMMON_FIELDS,
  loadWritable,
  type ToolFamily,
} from './shared.ts'

/** The two definition-level write tool names. */
export const WRITE_TOOL_NAMES = ['create_definition', 'update_definition'] as const

// ── create_definition ───────────────────────────────────────────────────────────────

const CreateDefinitionInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('table'), table: TableDefinitionSchema, ...CREATE_COMMON_FIELDS }),
  z.object({ kind: z.literal('event'), event: EventDefinitionSchema, ...CREATE_COMMON_FIELDS }),
  z.object({ kind: z.literal('concept'), concept: ConceptCreatePayloadSchema, ...CREATE_COMMON_FIELDS }),
])

/**
 * Registers `create_definition`.
 *
 * No `enrichment_health` in the response, and no on-write enrichment hook runs at all:
 * this compiles to the raw-edit primitives directly (`writeTable` / `writeEventYaml`),
 * never through `core.updateTableMeta` — the only method that
 * invokes `enrichOnWrite`. Routing a hand-built `TableDefinition` through the
 * core's batch sync-write entry (removed wholesale in S1.4) was the rejected
 * alternative (ADR-0005 ruling 5's "`sync_tables`":
 * that path treats its input as `SchemaProvider`-observed fact, and an agent's hand-
 * written payload passed through it would be provenance forgery). An agent that wants
 * join discovery on a table it just created can ask for it once #21's enrichment tools
 * land — Followup, not silently dropped.
 */
function registerCreateDefinition(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'create_definition',
    {
      title: 'Create a definition',
      description: 'Create a new table, event, or concept from a complete, schema-valid definition. Concepts are the knowledge-graph ontology/entity layer: register a domain term that maps to no single asset as kind:"concept" (name + description + pref_label/alt_labels + free-form `properties`); an asset term lands as a table/event (and may mount concepts later via update_definition fields.domains). A concept payload carrying related_refs / suppressed_alt_labels / suppressed_related_refs (a get_definition output fed straight back) has those keys ignored — they are item-verb fields owned by add_relation/add_alias (ADR-0019 R3); any other unknown key is rejected as a typo. There is no kind:"metric" — metric candidates are written inline into their host table/event\'s `metrics` block (the metric layer is a derived read view over those blocks, never a separate file). Refuses if the name already exists (use update_definition instead). The recorder is mandatory — every create_definition call is an audited commit.',
      inputSchema: CreateDefinitionInputSchema,
    },
    async (input, ctx: ServerContext) => {
      const snap = deps.bindings.requireSnapshot()
      assertScopeMatch(snap, input.scope_id)
      const root = snap.core.resolveScopeRoot()

      if (input.kind === 'table') {
        const name = input.table.table_name
        if (loadWritable(snap.core, 'table', name) !== null) {
          throw new DefinitionAlreadyExistsError(`table "${name}" already exists — use update_definition to change it`, { kind: 'table', name })
        }
        const res = await auditedWrite(
          snap,
          ctx,
          { tool: 'create_definition', target: name, summary: input.summary, derivation: input.derivation, confidence: input.confidence },
          async () => {
            const written = await writeTable(root, name, input.table, {}, { recorder: snap.recorder })
            // `writeTable` re-validates the payload; it was already validated
            // by this tool's zod schema, so reaching the `{ok:false}` branch
            // is this server's own bug, not a caller mistake.
            if (!written.ok) {
              throw new Error(`writeTable rejected a payload create_definition already validated: ${written.error}`)
            }
            return written
          },
        )
        return toolSuccess(await writeReceipt(snap, deps, res, {
          tool: 'create_definition',
          // 'create', not 'table': the create family compiles to the raw
          // primitives and never runs the on-write hook, so its receipt
          // carries no `enrichment_health` — ADR-0005 ruling 5's deliberate
          // asymmetry, preserved by the envelope's writePath gate.
          writePath: 'create',
          version: res.value.version,
        }))
      }

      if (input.kind === 'concept') {
        // The concept write path (ADR-0012): same refusal, same audit seam,
        // one deliberate difference from the table branch — no existence
        // race to note, because concepts have no on-write enrichment hook
        // anywhere downstream (no rounds exist to ask for one).
        const name = input.concept.name
        if (loadWritable(snap.core, 'concept', name) !== null) {
          throw new DefinitionAlreadyExistsError(`concept "${name}" already exists — use update_definition to change it`, { kind: 'concept', name })
        }
        const res = await auditedWrite(
          snap,
          ctx,
          { tool: 'create_definition', target: name, summary: input.summary, derivation: input.derivation, confidence: input.confidence },
          async () => {
            const written = await snap.core.writeConceptYaml(name, input.concept)
            if (!written.ok) {
              throw new Error(`writeConceptYaml rejected a payload create_definition already validated: ${written.error}`)
            }
            return written
          },
        )
        return toolSuccess(await writeReceipt(snap, deps, res, {
          tool: 'create_definition',
          writePath: 'create',
          version: res.value.version,
        }))
      }

      const name = input.event.name
      if (loadWritable(snap.core, 'event', name) !== null) {
        throw new DefinitionAlreadyExistsError(`event "${name}" already exists — use update_definition to change it`, { kind: 'event', name })
      }
      const res = await auditedWrite(
        snap,
        ctx,
        { tool: 'create_definition', target: name, summary: input.summary, derivation: input.derivation, confidence: input.confidence },
        async () => {
          const written = await writeEventYaml(root, name, dumpYaml(input.event), { recorder: snap.recorder })
          if (!written.ok) {
            // `writeEventYaml` re-parses its own `content` and re-checks the name
            // match; both are already guaranteed by this schema and `dumpYaml`, so
            // reaching here is this server's own bug, not a caller mistake.
            throw new Error(`writeEventYaml rejected a payload create_definition already validated: ${written.error}`)
          }
          return written
        },
      )
      return toolSuccess(await writeReceipt(snap, deps, res, {
        tool: 'create_definition',
        writePath: 'create',
        version: res.value.version,
      }))
    },
  )
}

// ── update_definition ───────────────────────────────────────────────────────────────

const UpdateDefinitionInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('table'), name: z.string().min(1), fields: TableFieldsSchema, ...UPDATE_COMMON_FIELDS }),
  z.object({ kind: z.literal('event'), name: z.string().min(1), fields: EventFieldsSchema, ...UPDATE_COMMON_FIELDS }),
  z.object({ kind: z.literal('concept'), name: z.string().min(1), fields: ConceptFieldsSchema, ...UPDATE_COMMON_FIELDS }),
])

// ── The update path's array-reference redirect apparatus (ADR-0005 ruling 4) ───────
// (moved from `tools/shared.ts` 2026-10-15 — same one-consumer rule as #145/#161:
// the `update_definition` handler below is this apparatus's one consumer. #161
// moved that handler's `assertUpdateOk` twin out and left these behind.)

/** Array-reference field → the item-level tool pair that maintains it (ADR-0005 ruling 4's redirect), for tables. The `suppressed_*` keys ride the same verbs (#38 / ADR-0010): a veto is born by remove and lifted by add, never written as a bare field. */
const TABLE_ARRAY_REF_REDIRECT: Readonly<Record<string, string>> = {
  alt_labels: 'add_alias / remove_alias',
  dimension_refs: 'add_relation / remove_relation',
  suppressed_alt_labels: 'add_alias / remove_alias (vetoes are born by remove_*, lifted by add_* — never hand-written)',
  suppressed_dimension_refs: 'add_relation / remove_relation (vetoes are born by remove_*, lifted by add_* — never hand-written)',
}
/** Array-reference field → the item-level tool pair that maintains it, for events. */
const EVENT_ARRAY_REF_REDIRECT: Readonly<Record<string, string>> = {
  alt_labels: 'add_alias / remove_alias',
  external_refs: 'add_relation / remove_relation',
  suppressed_alt_labels: 'add_alias / remove_alias (vetoes are born by remove_*, lifted by add_* — never hand-written)',
  suppressed_external_refs: 'add_relation / remove_relation (vetoes are born by remove_*, lifted by add_* — never hand-written)',
}
/** Array-reference field → the item-level tool pair that maintains it, for concepts
 * (ADR-0012 #46 R3 伴生点 1). Concepts have no dimension_refs/external_refs — their
 * declared edges live in `related_refs`, maintained by the same relation pair with a
 * `target_kind`-carrying shape (Q4(b)). */
const CONCEPT_ARRAY_REF_REDIRECT: Readonly<Record<string, string>> = {
  alt_labels: 'add_alias / remove_alias',
  related_refs: 'add_relation / remove_relation (concept-side edges: {target_kind, name})',
  suppressed_alt_labels: 'add_alias / remove_alias (vetoes are born by remove_*, lifted by add_* — never hand-written)',
  suppressed_related_refs: 'add_relation / remove_relation (vetoes are born by remove_*, lifted by add_* — never hand-written)',
}

/**
 * Reject an array-reference field, pointing at the item-level tool that maintains it.
 *
 * This is the handler-side half of `update_definition`'s bounded `fields` schema: the
 * schema itself (built by `tools/shared.ts`'s `updatableFieldsSchema`) deliberately
 * leaves `alt_labels` / `dimension_refs` / `external_refs` in as ordinarily-typed
 * optional fields — rejecting them in zod would only produce a generic "unrecognized
 * key" message, with no way to attach the redirect ADR-0005 ruling 4 asks for.
 * @param fields - the already-parsed `fields` object (whichever keys the caller sent survive here).
 * @param redirect - the kind's array-reference redirect map ({@link TABLE_ARRAY_REF_REDIRECT} / {@link EVENT_ARRAY_REF_REDIRECT}).
 * @throws UnsupportedUpdateFieldError naming the first rejected field found and its replacement tool(s).
 */
function assertNoRedirectedFields(fields: Readonly<Record<string, unknown>>, redirect: Readonly<Record<string, string>>): void {
  for (const [field, tools] of Object.entries(redirect)) {
    if (field in fields) {
      throw new UnsupportedUpdateFieldError(
        `update_definition does not accept "${field}": it is an array-reference field maintained item-by-item (ADR-0005 ruling 4) — use ${tools} instead`,
        { field, use_instead: tools },
      )
    }
  }
}

// ── The update path's field-apply trio (#161 / C16) ─────────────────────────────────
// (#161: moved from `tools/audited.ts` (`applyFieldUpdate`) and `tools/shared.ts`
// (`ApplyResult` / `assertUpdateOk`) — the `update_definition` handler below is
// the trio's one consumer.)

/** The one non-throwing write-result shape. The `update*Meta` family resolves
 * `{ok:true}` bare; the item-overlay apply path (`applyFieldUpdate`) resolves the
 * same shape plus the written file's `version` fingerprint (#108) — hence the
 * optional key: present on every apply result, absent on every meta-update result. */
export type ApplyResult = { readonly ok: true; readonly version?: string } | { readonly ok: false; readonly error: string }

/**
 * Apply one field overlay via `updateTableMeta` / `updateEventMeta` /
 * `updateConceptMeta`, dispatched by `kind`, with an explicit return type.
 *
 * Not a bare `kind === 'table' ? core.updateTableMeta(...) : core.updateEventMeta(...)`
 * inline inside the audit seam's `fn`: measured — `UpdateTableMetaResult` and
 * `UpdateEventMetaResult` differ only in their success branch's field name
 * (`table_name` vs `event_name`), and TypeScript infers the seam callback's
 * `T` from whichever branch it resolves first, then rejects the other branch
 * against that fixed `T`. An explicitly-typed wrapper (dropping the field
 * neither branch's caller reads) sidesteps the inference order entirely,
 * rather than annotating every call site.
 * @param snap - the entry snapshot.
 * @param kind - which Tier-2 method to call.
 * @param name - the table_name / event / concept name.
 * @param updates - the field overlay to shallow-merge over the existing YAML.
 * @param expectedVersion - the caller's baseline fingerprint
 *   (`expected_version`, checked inside the lock by the write path).
 * @returns `{ok:true, version}` on success (`version` = the written file's
 *   fingerprint as the whole write left it), or `{ok:false, error}` — never
 *   throws for a normal validation/not-found outcome.
 */
export async function applyFieldUpdate(
  snap: ScopeBinding,
  kind: 'table' | 'event' | 'concept',
  name: string,
  updates: Readonly<Record<string, unknown>>,
  expectedVersion: string,
): Promise<ApplyResult> {
  if (kind === 'table') {
    const res = await snap.core.updateTableMeta(name, updates, { expected_version: expectedVersion })
    return res.ok ? { ok: true, version: res.version } : res
  }
  if (kind === 'event') {
    const res = await snap.core.updateEventMeta(name, updates, { expected_version: expectedVersion })
    return res.ok ? { ok: true, version: res.version } : res
  }
  const res = await snap.core.updateConceptMeta(name, updates, { expected_version: expectedVersion })
  return res.ok ? { ok: true, version: res.version } : res
}

/**
 * Turn `updateTableMeta` / `updateEventMeta` / `updateConceptMeta`'s
 * non-throwing `{ok:false, error}` into the right coded error — the substrate
 * reports two genuinely different conditions through that one string field,
 * and ADR-0005 ruling 8 asks both to be discriminable.
 *
 * The not-found half of the discrimination is not spelled here: the three
 * message prefixes live in one place, `isSubstrateNotFound` (`errors.ts`'s
 * substrate→coded adapter family, #120/C5), shared with the thrown-error
 * adapter the item tools use — two hand-copied `startsWith` ladders used to
 * carry the same knowledge in parallel.
 * @param result - whatever `core.updateTableMeta` / `core.updateEventMeta` / `core.updateConceptMeta` resolved to.
 * @param kind - which kind was being updated (for the error's structured `data`).
 * @param name - the table_name / event / concept name being updated.
 * @throws DefinitionNotFoundError when the substrate's message is a not-found
 *   report (the target vanished between this tool's own checks and the
 *   lock-protected write — see `write.ts` / `items.ts`).
 * @throws DefinitionValidationError for every other failure message (the merged
 *   document failed the kind's full schema).
 */
export function assertUpdateOk(result: ApplyResult, kind: 'table' | 'event' | 'concept', name: string): void {
  if (result.ok) return
  if (isSubstrateNotFound(result.error)) {
    throw new DefinitionNotFoundError(result.error, { kind, name })
  }
  throw new DefinitionValidationError(result.error, { kind, name })
}

/** Registers `update_definition`. */
function registerUpdateDefinition(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'update_definition',
    {
      title: 'Update a definition',
      description: 'Shallow-merge scalar/object fields onto an existing table, event, or concept. Rejects identity fields (table_name/name/kind) and array-reference fields — tables/events: alt_labels/dimension_refs/external_refs; concepts: alt_labels/related_refs — use add_alias/remove_alias/add_relation/remove_relation for those. Concept fields: description, pref_label, properties (free-form entity attributes); a table mounts a concept via fields.domains. Table/event `metrics` merges as one whole block: shallow-merge is per top-level field, so changing a single metric means re-sending the entire `metrics` map (metrics have no per-key merge). Requires expected_version (from get_definition); a stale baseline is rejected for re-read-and-retry. Changing fields.domains unmounts the definition from the dropped concepts; memory entries anchored on those dying membership edges are reported as `dangling_memories: N` in the receipt (ADR-0026 R5: a reminder, never a block).',
      inputSchema: UpdateDefinitionInputSchema,
    },
    async (input, ctx: ServerContext) => {
      const snap = deps.bindings.requireSnapshot()
      assertScopeMatch(snap, input.scope_id)
      assertNoRedirectedFields(
        input.fields,
        input.kind === 'table' ? TABLE_ARRAY_REF_REDIRECT : input.kind === 'event' ? EVENT_ARRAY_REF_REDIRECT : CONCEPT_ARRAY_REF_REDIRECT,
      )
      // ADR-0026 R5's `update_definition` arm: when this call changes
      // `domains`, read the pre-write membership set here (a concurrent edit
      // would fail the write's own expected_version check, so this read cannot
      // silently describe the wrong baseline) — after the write lands, the
      // dropped concepts' membership edges are the dying anchors. Concept
      // subjects never reach this arm: their `fields` schema has no `domains`.
      let oldDomains: readonly string[] | undefined
      if (input.kind !== 'concept' && input.fields.domains !== undefined) {
        const prior = loadWritable(snap.core, input.kind, input.name) as { readonly domains?: readonly string[] } | null
        oldDomains = prior?.domains ?? []
      }
      const res = await auditedWrite(
        snap,
        ctx,
        { tool: 'update_definition', target: input.name, summary: input.summary, derivation: input.derivation, confidence: input.confidence },
        () => applyFieldUpdate(snap, input.kind, input.name, input.fields, input.expected_version),
      )
      assertUpdateOk(res.value, input.kind, input.name)
      // The dropped-concept membership edges: `concept:<domain> -related_to->
      // <node>`, the graph build's canonical group→member direction. Key stays
      // absent at 0 so a memory-free corpus keeps this receipt byte-identical.
      let danglingMemories: number | undefined
      if (oldDomains !== undefined) {
        const newDomains = input.fields.domains as readonly string[]
        const dropped = oldDomains.filter(d => !newDomains.includes(d))
        if (dropped.length > 0) {
          const node = input.kind === 'table' ? `table:${input.name}` : `event:${input.name}`
          const n = snap.core.countMemoriesOnEdges(dropped.map(d => ({ from: `concept:${d}`, type: 'related_to', to: node })))
          if (n > 0) danglingMemories = n
        }
      }
      return toolSuccess(await writeReceipt(snap, deps, res, {
        tool: 'update_definition',
        // `enrichment_health` rides the writePath asymmetry `writeReceipt`
        // owns: a table update ran the on-write hook and reports; an event
        // update has no hook, and a concept update has no rounds at all —
        // for either, the key stays absent (reporting health there would
        // only mirror whatever an earlier table write left behind).
        writePath: input.kind,
        ...res.value.ok ? { version: res.value.version } : {},
        domain: { ...danglingMemories !== undefined ? { dangling_memories: danglingMemories } : {} },
      }))
    },
  )
}

/** Registers both definition-level write tools. */
export const registerWriteTools: ToolRegistrar = (server, deps) => {
  registerCreateDefinition(server, deps)
  registerUpdateDefinition(server, deps)
}

/** The write family's descriptor card (#115): its names and registrar bound in one
 * place, for `tools/index.ts` to compose — never a second copy of either key. */
export const WRITE_TOOL_FAMILY: ToolFamily = { names: WRITE_TOOL_NAMES, register: registerWriteTools }

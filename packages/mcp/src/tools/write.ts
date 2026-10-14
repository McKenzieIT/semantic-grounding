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
import { DefinitionAlreadyExistsError } from '../errors.ts'
import type { ServerDeps, ToolRegistrar } from '../server.ts'
import { applyFieldUpdate, assertScopeMatch, auditedWrite, toolSuccess, writeReceipt } from './audited.ts'
import {
  CREATE_COMMON_FIELDS,
  CONCEPT_ARRAY_REF_REDIRECT,
  ConceptCreatePayloadSchema,
  ConceptFieldsSchema,
  EVENT_ARRAY_REF_REDIRECT,
  EventFieldsSchema,
  TABLE_ARRAY_REF_REDIRECT,
  TableFieldsSchema,
  UPDATE_COMMON_FIELDS,
  assertNoRedirectedFields,
  assertUpdateOk,
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

/** Registers `update_definition`. */
function registerUpdateDefinition(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'update_definition',
    {
      title: 'Update a definition',
      description: 'Shallow-merge scalar/object fields onto an existing table, event, or concept. Rejects identity fields (table_name/name/kind) and array-reference fields — tables/events: alt_labels/dimension_refs/external_refs; concepts: alt_labels/related_refs — use add_alias/remove_alias/add_relation/remove_relation for those. Concept fields: description, pref_label, properties (free-form entity attributes); a table mounts a concept via fields.domains. Table/event `metrics` merges as one whole block: shallow-merge is per top-level field, so changing a single metric means re-sending the entire `metrics` map (metrics have no per-key merge). Requires expected_version (from get_definition); a stale baseline is rejected for re-read-and-retry.',
      inputSchema: UpdateDefinitionInputSchema,
    },
    async (input, ctx: ServerContext) => {
      const snap = deps.bindings.requireSnapshot()
      assertScopeMatch(snap, input.scope_id)
      assertNoRedirectedFields(
        input.fields,
        input.kind === 'table' ? TABLE_ARRAY_REF_REDIRECT : input.kind === 'event' ? EVENT_ARRAY_REF_REDIRECT : CONCEPT_ARRAY_REF_REDIRECT,
      )
      const res = await auditedWrite(
        snap,
        ctx,
        { tool: 'update_definition', target: input.name, summary: input.summary, derivation: input.derivation, confidence: input.confidence },
        () => applyFieldUpdate(snap, input.kind, input.name, input.fields, input.expected_version),
      )
      assertUpdateOk(res.value, input.kind, input.name)
      return toolSuccess(await writeReceipt(snap, deps, res, {
        tool: 'update_definition',
        // `enrichment_health` rides the writePath asymmetry `writeReceipt`
        // owns: a table update ran the on-write hook and reports; an event
        // update has no hook, and a concept update has no rounds at all —
        // for either, the key stays absent (reporting health there would
        // only mirror whatever an earlier table write left behind).
        writePath: input.kind,
        ...res.value.ok ? { version: res.value.version } : {},
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

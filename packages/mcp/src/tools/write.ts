/**
 * ADR-0005's two definition-level write tools: `create_definition` and
 * `update_definition`.
 *
 * Both are Tier-2, both drive `GitTier2Recorder.runAudited` (never call a substrate
 * write function directly — the lock has to wrap the call, and a contextless write is
 * refused, per `git/recorder.ts`'s module doc). `create_definition` compiles to the
 * raw-edit primitives `writeTable` / `writeEventYaml` with a recorder passed on every
 * call (ADR-0004 ruling 2, ADR-0005 ruling 5 — the recorder is mandatory, not optional);
 * `update_definition` compiles to `core.updateTableMeta` / `core.updateEventMeta`, which
 * is what gives it the on-write enrichment hook `create_definition` deliberately does
 * not get (see this file's `create_definition` section).
 *
 * @module tools/write
 */
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import { EventDefinitionSchema, TableDefinitionSchema, dumpYaml, writeEventYaml, writeTable } from '@semantic-grounding/substrate'
import { z } from 'zod'
import { DefinitionAlreadyExistsError, toToolErrorResult } from '../errors.ts'
import type { ServerDeps, ToolRegistrar } from '../server.ts'
import {
  CREATE_COMMON_FIELDS,
  EVENT_ARRAY_REF_REDIRECT,
  EventFieldsSchema,
  TABLE_ARRAY_REF_REDIRECT,
  TableFieldsSchema,
  UPDATE_COMMON_FIELDS,
  assertNoRedirectedFields,
  assertUpdateOk,
  clientNameFromEnvelope,
} from './shared.ts'

/** The two definition-level write tool names. */
export const WRITE_TOOL_NAMES = ['create_definition', 'update_definition'] as const

// ── create_definition ───────────────────────────────────────────────────────────────

const CreateDefinitionInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('table'), table: TableDefinitionSchema, ...CREATE_COMMON_FIELDS }),
  z.object({ kind: z.literal('event'), event: EventDefinitionSchema, ...CREATE_COMMON_FIELDS }),
])

/**
 * Registers `create_definition`.
 *
 * No `enrichment_health` in the response, and no on-write enrichment hook runs at all:
 * this compiles to the raw-edit primitives directly (`writeTable` / `writeEventYaml`),
 * never through `core.syncWrite` / `core.updateTableMeta` — the only two methods that
 * invoke `enrichOnWrite`. Routing a hand-built `TableDefinition` through
 * `core.syncWrite` was the rejected alternative (ADR-0005 ruling 5's "`sync_tables`":
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
      description: 'Create a new table or event from a complete, schema-valid definition. Refuses if the name already exists (use update_definition instead). The recorder is mandatory — every create_definition call is an audited commit.',
      inputSchema: CreateDefinitionInputSchema,
    },
    async (input, ctx: ServerContext) => {
      try {
        const clientName = clientNameFromEnvelope(ctx)
        const root = deps.core.resolveScopeRoot()

        if (input.kind === 'table') {
          const name = input.table.table_name
          if (deps.core.loadTableDefinition(name) !== null) {
            throw new DefinitionAlreadyExistsError(`table "${name}" already exists — use update_definition to change it`, { kind: 'table', name })
          }
          const res = await deps.recorder.runAudited(
            {
              tool: 'create_definition',
              target: name,
              summary: input.summary,
              derivation: input.derivation,
              confidence: input.confidence,
              ...clientName !== undefined ? { clientName } : {},
            },
            () => writeTable(root, name, input.table, {}, { recorder: deps.recorder }),
          )
          return { content: [{ type: 'text', text: JSON.stringify({ commit: res.commit, changed: res.changed }) }] }
        }

        const name = input.event.name
        if (deps.core.loadEventDefinition(name) !== null) {
          throw new DefinitionAlreadyExistsError(`event "${name}" already exists — use update_definition to change it`, { kind: 'event', name })
        }
        const res = await deps.recorder.runAudited(
          {
            tool: 'create_definition',
            target: name,
            summary: input.summary,
            derivation: input.derivation,
            confidence: input.confidence,
            ...clientName !== undefined ? { clientName } : {},
          },
          async () => {
            const written = await writeEventYaml(root, name, dumpYaml(input.event), { recorder: deps.recorder })
            if (!written.ok) {
              // `writeEventYaml` re-parses its own `content` and re-checks the name
              // match; both are already guaranteed by this schema and `dumpYaml`, so
              // reaching here is this server's own bug, not a caller mistake.
              throw new Error(`writeEventYaml rejected a payload create_definition already validated: ${written.error}`)
            }
            return written
          },
        )
        return { content: [{ type: 'text', text: JSON.stringify({ commit: res.commit, changed: res.changed }) }] }
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

// ── update_definition ───────────────────────────────────────────────────────────────

const UpdateDefinitionInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('table'), name: z.string().min(1), fields: TableFieldsSchema, ...UPDATE_COMMON_FIELDS }),
  z.object({ kind: z.literal('event'), name: z.string().min(1), fields: EventFieldsSchema, ...UPDATE_COMMON_FIELDS }),
])

/** Registers `update_definition`. */
function registerUpdateDefinition(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'update_definition',
    {
      title: 'Update a definition',
      description: 'Shallow-merge scalar/object fields onto an existing table or event. Rejects identity fields (table_name/name/kind) and array-reference fields (alt_labels/dimension_refs/external_refs) — use add_alias/remove_alias/add_relation/remove_relation for those. Requires expected_version (from get_definition); a stale baseline is rejected for re-read-and-retry.',
      inputSchema: UpdateDefinitionInputSchema,
    },
    async (input, ctx: ServerContext) => {
      try {
        const clientName = clientNameFromEnvelope(ctx)
        const auditCtx = {
          tool: 'update_definition',
          target: input.name,
          summary: input.summary,
          derivation: input.derivation,
          confidence: input.confidence,
          ...clientName !== undefined ? { clientName } : {},
        }

        if (input.kind === 'table') {
          assertNoRedirectedFields(input.fields, TABLE_ARRAY_REF_REDIRECT)
          const res = await deps.recorder.runAudited(
            auditCtx,
            () => deps.core.updateTableMeta(input.name, input.fields, { expected_version: input.expected_version }),
          )
          assertUpdateOk(res.value, 'table', input.name)
          const enrichment_health = deps.core.getEnrichmentHealth()
          return { content: [{ type: 'text', text: JSON.stringify({ commit: res.commit, changed: res.changed, enrichment_health }) }] }
        }

        assertNoRedirectedFields(input.fields, EVENT_ARRAY_REF_REDIRECT)
        const res = await deps.recorder.runAudited(
          auditCtx,
          () => deps.core.updateEventMeta(input.name, input.fields, { expected_version: input.expected_version }),
        )
        assertUpdateOk(res.value, 'event', input.name)
        // No `enrichment_health` here, on purpose: `core.updateEventMeta` does not call
        // `enrichOnWrite` at all (the Core class's own doc on `discoverEventRelations` —
        // "no Service-level event-write path existed before updateEventMeta... the hook
        // lands with a future syncWriteEvents/updateEventMeta Service method", a gap
        // #18 closed for the write but not yet the hook). `getEnrichmentHealth()` would
        // only report whatever an unrelated *table* write before this one left behind —
        // inlining that here would misattribute it to this event update.
        return { content: [{ type: 'text', text: JSON.stringify({ commit: res.commit, changed: res.changed }) }] }
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

/** Registers both definition-level write tools. */
export const registerWriteTools: ToolRegistrar = (server, deps) => {
  registerCreateDefinition(server, deps)
  registerUpdateDefinition(server, deps)
}

/**
 * ADR-0005's four item-level write tools: `add_alias`, `remove_alias`, `add_relation`,
 * `remove_relation`.
 *
 * All four are the read-modify-write ruling 3 asks for: read the current array fresh
 * *inside* `runAudited`'s lock (never from a value computed before the call), compute
 * the new array, hand the whole array to `core.updateTableMeta` / `updateEventMeta` as
 * a single-field overlay. None ever replaces the array wholesale from stale state —
 * the read and the write are one lock-protected step, mirroring
 * `tests/helpers/concurrent-writer.ts`'s own pattern exactly (the lost-update shape
 * that test exists to catch).
 *
 * Idempotency falls out of this shape for free rather than needing a special case:
 * adding an alias that is already present, or removing one that is already absent,
 * computes the *same* array, so `core.updateTableMeta`'s write is byte-identical and
 * the recorder's own "nothing staged" check reports `changed: false` with no commit
 * (ADR-0005 ruling 8) — the general mechanism `git-recorder.spec.ts` already covers,
 * not a case this file re-implements.
 *
 * @module tools/items
 */
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import { loadEvents, loadTables } from '@semantic-grounding/substrate'
import { z } from 'zod'
import { DefinitionNotFoundError, toToolErrorResult } from '../errors.ts'
import type { ServerDeps, ToolRegistrar } from '../server.ts'
import {
  RelationRefInputSchema,
  UPDATE_COMMON_FIELDS,
  WritableKindSchema,
  assertUpdateOk,
  clientNameFromEnvelope,
  type RelationRefInput,
} from './shared.ts'

/** The four item-level tool names. */
export const ITEM_TOOL_NAMES = ['add_alias', 'remove_alias', 'add_relation', 'remove_relation'] as const

type Kind = 'table' | 'event'

/**
 * Read a definition's current `alt_labels`, fresh off disk, inside the caller's lock.
 * @param root - the corpus root.
 * @param kind - which storage layout to scan.
 * @param name - the table_name / event name.
 * @returns the current array (empty when the field is absent or malformed).
 * @throws DefinitionNotFoundError when no definition of this kind has this name.
 */
function readAltLabels(root: string, kind: Kind, name: string): readonly string[] {
  const raw = kind === 'table'
    ? loadTables(root).find(t => t.table_name === name)?.raw
    : loadEvents(root).find(e => e.name === name)?.raw
  if (raw === undefined) throw new DefinitionNotFoundError(`no ${kind} named "${name}"`, { kind, name })
  return Array.isArray(raw.alt_labels) ? raw.alt_labels.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Read a definition's current relation-ref array (`dimension_refs` for a table,
 * `external_refs` for an event), fresh off disk, inside the caller's lock. Entries are
 * returned verbatim (including `origin` / `derivation`, which this file never touches)
 * so a write-back that only appends/removes one entry leaves every other entry's own
 * provenance fields exactly as they were.
 * @param root - the corpus root.
 * @param kind - which storage layout to scan, and which field name applies.
 * @param name - the table_name / event name.
 * @returns the current array (empty when the field is absent or malformed).
 * @throws DefinitionNotFoundError when no definition of this kind has this name.
 */
function readRelationRefs(root: string, kind: Kind, name: string): readonly unknown[] {
  const raw = kind === 'table'
    ? loadTables(root).find(t => t.table_name === name)?.raw
    : loadEvents(root).find(e => e.name === name)?.raw
  if (raw === undefined) throw new DefinitionNotFoundError(`no ${kind} named "${name}"`, { kind, name })
  const field = kind === 'table' ? raw.dimension_refs : raw.external_refs
  return Array.isArray(field) ? field : []
}

/** The field `dimension_refs` (table) / `external_refs` (event) is called on each kind. */
function relationFieldName(kind: Kind): 'dimension_refs' | 'external_refs' {
  return kind === 'table' ? 'dimension_refs' : 'external_refs'
}

/** The shape every item tool needs back — success-field name (`table_name`/`event_name`) dropped, since none of them read it. */
type ApplyResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

/**
 * Apply one field overlay via `updateTableMeta` / `updateEventMeta`, dispatched by
 * `kind`, with an explicit return type.
 *
 * Not a bare `kind === 'table' ? core.updateTableMeta(...) : core.updateEventMeta(...)`
 * inline inside `runAudited`'s `fn`: measured — `UpdateTableMetaResult` and
 * `UpdateEventMetaResult` differ only in their success branch's field name
 * (`table_name` vs `event_name`), and TypeScript infers `runAudited<T>`'s `T` from
 * whichever branch it resolves first, then rejects the other branch against that fixed
 * `T`. An explicitly-typed wrapper (dropping the field neither branch's caller reads)
 * sidesteps the inference order entirely, rather than annotating every call site.
 * @param deps - the process-wide dependencies.
 * @param kind - which Tier-2 method to call.
 * @param name - the table_name / event name.
 * @param updates - the single-field overlay (`{ alt_labels: [...] }` or `{ dimension_refs: [...] }` / `{ external_refs: [...] }`).
 * @param expectedVersion - the caller's baseline fingerprint.
 * @returns `{ok:true}` on success, or `{ok:false, error}` — never throws for a normal validation/not-found outcome.
 */
async function applyFieldUpdate(
  deps: ServerDeps,
  kind: Kind,
  name: string,
  updates: Readonly<Record<string, unknown>>,
  expectedVersion: string,
): Promise<ApplyResult> {
  if (kind === 'table') {
    const res = await deps.core.updateTableMeta(name, updates, { expected_version: expectedVersion })
    return res.ok ? { ok: true } : res
  }
  const res = await deps.core.updateEventMeta(name, updates, { expected_version: expectedVersion })
  return res.ok ? { ok: true } : res
}

/**
 * @param a - one existing entry's `join_keys`, read verbatim off disk (unknown shape).
 * @param b - the tool input's own `join_keys`.
 * @returns whether every pair matches, in order — the simple, honest reading of
 *   "the exact same relation" (a different order is treated as a different relation
 *   rather than invisibly normalized).
 */
function sameJoinKeys(a: unknown, b: RelationRefInput['join_keys']): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false
  return a.every((raw, i) => {
    const expected = b[i]
    return typeof raw === 'object' && raw !== null
      && (raw as { readonly dws_column?: unknown }).dws_column === expected?.dws_column
      && (raw as { readonly dim_column?: unknown }).dim_column === expected?.dim_column
  })
}

/**
 * @param existing - one existing relation-ref entry, read verbatim off disk.
 * @param relation - the tool input's asserted relation.
 * @returns whether `existing` is structurally the same relation (same `dim_table`,
 *   same `join_keys` in the same order) — the identity `add_relation` / `remove_relation`
 *   key off, regardless of `origin` / `derivation` on the stored entry.
 */
function matchesRelation(existing: unknown, relation: RelationRefInput): boolean {
  if (typeof existing !== 'object' || existing === null) return false
  const e = existing as { readonly dim_table?: unknown; readonly join_keys?: unknown }
  return e.dim_table === relation.dim_table && sameJoinKeys(e.join_keys, relation.join_keys)
}

/** Common input shape for `add_alias` / `remove_alias`. */
const AliasInputSchema = z.object({
  kind: WritableKindSchema,
  name: z.string().min(1),
  alias: z.string().min(1),
  ...UPDATE_COMMON_FIELDS,
})

/** Common input shape for `add_relation` / `remove_relation`. */
const RelationInputSchema = z.object({
  kind: WritableKindSchema,
  name: z.string().min(1),
  relation: RelationRefInputSchema,
  ...UPDATE_COMMON_FIELDS,
})

/** Registers `add_alias`. */
function registerAddAlias(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'add_alias',
    {
      title: 'Add an alias',
      description: 'Append one alt_label to a table or event, read-modify-write inside the corpus lock. A no-op (changed:false, no commit) when the alias is already present.',
      inputSchema: AliasInputSchema,
    },
    async (input, ctx: ServerContext) => {
      try {
        const clientName = clientNameFromEnvelope(ctx)
        const root = deps.core.resolveScopeRoot()
        const res = await deps.recorder.runAudited(
          {
            tool: 'add_alias',
            target: input.name,
            summary: input.summary,
            derivation: input.derivation,
            confidence: input.confidence,
            ...clientName !== undefined ? { clientName } : {},
          },
          () => {
            const existing = readAltLabels(root, input.kind, input.name)
            const next = existing.includes(input.alias) ? existing : [...existing, input.alias]
            return applyFieldUpdate(deps, input.kind, input.name, { alt_labels: [...next] }, input.expected_version)
          },
        )
        assertUpdateOk(res.value, input.kind, input.name)
        const enrichment_health = input.kind === 'table' ? deps.core.getEnrichmentHealth() : undefined
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ commit: res.commit, changed: res.changed, ...enrichment_health !== undefined ? { enrichment_health } : {} }),
          }],
        }
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

/** Registers `remove_alias`. */
function registerRemoveAlias(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'remove_alias',
    {
      title: 'Remove an alias',
      description: 'Remove one alt_label from a table or event, read-modify-write inside the corpus lock. A no-op (changed:false, no commit) when the alias is already absent.',
      inputSchema: AliasInputSchema,
    },
    async (input, ctx: ServerContext) => {
      try {
        const clientName = clientNameFromEnvelope(ctx)
        const root = deps.core.resolveScopeRoot()
        const res = await deps.recorder.runAudited(
          {
            tool: 'remove_alias',
            target: input.name,
            summary: input.summary,
            derivation: input.derivation,
            confidence: input.confidence,
            ...clientName !== undefined ? { clientName } : {},
          },
          () => {
            const existing = readAltLabels(root, input.kind, input.name)
            const next = existing.filter(a => a !== input.alias)
            return applyFieldUpdate(deps, input.kind, input.name, { alt_labels: next }, input.expected_version)
          },
        )
        assertUpdateOk(res.value, input.kind, input.name)
        const enrichment_health = input.kind === 'table' ? deps.core.getEnrichmentHealth() : undefined
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ commit: res.commit, changed: res.changed, ...enrichment_health !== undefined ? { enrichment_health } : {} }),
          }],
        }
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

/** Registers `add_relation`. */
function registerAddRelation(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'add_relation',
    {
      title: 'Add a relation',
      description: 'Append one dimension/external relation (dim_table + join_keys) to a table or event, read-modify-write inside the corpus lock. Omits origin and derivation on write — the appended ref is treated as curated (ADR-0005 rulings 9-10); your basis for the join belongs in summary. A no-op when the exact same relation is already present.',
      inputSchema: RelationInputSchema,
    },
    async (input, ctx: ServerContext) => {
      try {
        const clientName = clientNameFromEnvelope(ctx)
        const root = deps.core.resolveScopeRoot()
        const field = relationFieldName(input.kind)
        const res = await deps.recorder.runAudited(
          {
            tool: 'add_relation',
            target: input.name,
            summary: input.summary,
            derivation: input.derivation,
            confidence: input.confidence,
            ...clientName !== undefined ? { clientName } : {},
          },
          () => {
            if (input.kind === 'table' && deps.core.loadTableDefinition(input.relation.dim_table) === null) {
              throw new DefinitionNotFoundError(
                `add_relation: dim_table "${input.relation.dim_table}" has no table definition — create it first`,
                { kind: 'table', name: input.relation.dim_table },
              )
            }
            const existing = readRelationRefs(root, input.kind, input.name)
            const alreadyPresent = existing.some(e => matchesRelation(e, input.relation))
            const next = alreadyPresent ? existing : [...existing, { dim_table: input.relation.dim_table, join_keys: input.relation.join_keys }]
            return applyFieldUpdate(deps, input.kind, input.name, { [field]: next }, input.expected_version)
          },
        )
        assertUpdateOk(res.value, input.kind, input.name)
        const enrichment_health = input.kind === 'table' ? deps.core.getEnrichmentHealth() : undefined
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ commit: res.commit, changed: res.changed, ...enrichment_health !== undefined ? { enrichment_health } : {} }),
          }],
        }
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

/** Registers `remove_relation`. */
function registerRemoveRelation(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'remove_relation',
    {
      title: 'Remove a relation',
      description: 'Remove one exactly-matching dimension/external relation (dim_table + join_keys) from a table or event, read-modify-write inside the corpus lock. A no-op when no entry matches exactly. Removing a machine-derived ref (origin deterministic/llm) does not persist — the next enrichment round will re-derive it; v1 has no tombstone (ADR-0005 Consequences).',
      inputSchema: RelationInputSchema,
    },
    async (input, ctx: ServerContext) => {
      try {
        const clientName = clientNameFromEnvelope(ctx)
        const root = deps.core.resolveScopeRoot()
        const field = relationFieldName(input.kind)
        const res = await deps.recorder.runAudited(
          {
            tool: 'remove_relation',
            target: input.name,
            summary: input.summary,
            derivation: input.derivation,
            confidence: input.confidence,
            ...clientName !== undefined ? { clientName } : {},
          },
          () => {
            const existing = readRelationRefs(root, input.kind, input.name)
            const next = existing.filter(e => !matchesRelation(e, input.relation))
            return applyFieldUpdate(deps, input.kind, input.name, { [field]: next }, input.expected_version)
          },
        )
        assertUpdateOk(res.value, input.kind, input.name)
        const enrichment_health = input.kind === 'table' ? deps.core.getEnrichmentHealth() : undefined
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ commit: res.commit, changed: res.changed, ...enrichment_health !== undefined ? { enrichment_health } : {} }),
          }],
        }
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

/** Registers all four item-level tools. */
export const registerItemTools: ToolRegistrar = (server, deps) => {
  registerAddAlias(server, deps)
  registerRemoveAlias(server, deps)
  registerAddRelation(server, deps)
  registerRemoveRelation(server, deps)
}

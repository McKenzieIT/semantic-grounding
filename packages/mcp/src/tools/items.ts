/**
 * ADR-0005's four item-level write tools: `add_alias`, `remove_alias`, `add_relation`,
 * `remove_relation`.
 *
 * #49 thinning: handlers are now **schema + auditedWrite + Core call + response
 * formatting**. All domain logic (normalizeLabel, read-modify-write, dual-field
 * overlay, origin routing, veto lift) lives in `SemanticGroundingCore` methods
 * (`addAlias`, `removeAliases`, `addRelation`, `removeRelations`). The handler's
 * only jobs are:
 * 1. Zod schema validation (input shape).
 * 2. `auditedWrite` wrapping (lock + audit context).
 * 3. Core method call (domain logic).
 * 4. Response formatting (`commit`, `changed`, `enrichment_health`, verdicts).
 * 5. Error mapping (Core `Error` → MCP `DefinitionNotFoundError`).
 *
 * @see docs/adr/0005-mcp-tool-surface.md + docs/adr/0010-suppression.md
 */
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { ScopeBinding } from '../binding.ts'
import { DefinitionNotFoundError, toToolErrorResult } from '../errors.ts'
import type { ServerDeps, ToolRegistrar } from '../server.ts'
import { assertScopeMatch, auditedWrite, enrichmentHealthAfter, scopeStamp, toolSuccess } from './audited.ts'
import {
  RelationRefInputSchema,
  UPDATE_COMMON_FIELDS,
  WritableKindSchema,
} from './shared.ts'

/** The four item-level tool names. */
export const ITEM_TOOL_NAMES = ['add_alias', 'remove_alias', 'add_relation', 'remove_relation'] as const

/** Map Core method's `Error("Table/Event not found: ...")` to `DefinitionNotFoundError`.
 * `StaleBaselineError` is already remapped to `StaleBaselineRejection` by `runAudited`. */
function mapCoreError(e: unknown, kind: 'table' | 'event', name: string): never {
  if (e instanceof Error) {
    const msg = e.message
    if (msg.startsWith('Table not found') || msg.startsWith('Event not found')) {
      throw new DefinitionNotFoundError(msg, { kind, name })
    }
  }
  throw e
}

/** The response JSON spine every item tool shares (ADR-0005 ruling 8), stamped with
 * the entry snapshot's scope (ADR-0011's response layer: a straddled response still
 * says which scope served it). */
function itemResponseBase(snap: ScopeBinding, res: { readonly commit: string; readonly changed: boolean }, enrichmentHealth: unknown): Record<string, unknown> {
  return {
    scope: scopeStamp(snap),
    commit: res.commit,
    changed: res.changed,
    ...enrichmentHealth !== undefined ? { enrichment_health: enrichmentHealth } : {},
  }
}

/** Common input shape for `add_alias` / `add_relation` (single-item — #37 §3 keeps
 * `add_*` single: no measured pain, nothing pre-built). */
const AddAliasInputSchema = z.object({
  kind: WritableKindSchema,
  name: z.string().min(1),
  alias: z.string().min(1),
  ...UPDATE_COMMON_FIELDS,
})

/** `remove_alias` input: same-target batch of labels (#37 §3 — the empty array is
 * closed at the door, map #27 precedent). Breaking reshape of ADR-0005's `alias`. */
const RemoveAliasInputSchema = z.object({
  kind: WritableKindSchema,
  name: z.string().min(1),
  labels: z.array(z.string().min(1)).min(1),
  ...UPDATE_COMMON_FIELDS,
})

/** Common input shape for `add_relation` (single). */
const AddRelationInputSchema = z.object({
  kind: WritableKindSchema,
  name: z.string().min(1),
  relation: RelationRefInputSchema,
  ...UPDATE_COMMON_FIELDS,
})

/** `remove_relation` input: same-target batch of relations (#37 §3). Breaking
 * reshape of ADR-0005's `relation`. */
const RemoveRelationInputSchema = z.object({
  kind: WritableKindSchema,
  name: z.string().min(1),
  relations: z.array(RelationRefInputSchema).min(1),
  ...UPDATE_COMMON_FIELDS,
})

/** Registers `add_alias`. */
function registerAddAlias(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'add_alias',
    {
      title: 'Add an alias',
      description: 'Append one alt_label to a table or event, read-modify-write inside the corpus lock. Adding back a suppressed label LIFTS its veto — removal is the veto, re-assertion is its mirror — and the receipt\'s `unsuppressed` lists the keys this call lifted (absent when none). A call that neither adds the label nor lifts a veto is a no-op (changed:false, no commit).',
      inputSchema: AddAliasInputSchema,
    },
    async (input, ctx: ServerContext) => {
      try {
        const snap = deps.bindings.requireSnapshot()
        assertScopeMatch(snap, input.scope_id)
        const res = await auditedWrite(
          snap,
          ctx,
          { tool: 'add_alias', target: input.name, summary: input.summary, derivation: input.derivation, confidence: input.confidence },
          () => snap.core.addAlias(input.kind, input.name, input.alias, input.expected_version),
        )
        const body = itemResponseBase(snap, res, enrichmentHealthAfter(snap, input.kind))
        if (res.value.unsuppressed) body['unsuppressed'] = res.value.unsuppressed
        return toolSuccess(body)
      } catch (e) {
        try { mapCoreError(e, input.kind, input.name) } catch (mapped) { return toToolErrorResult(mapped) }
      }
    },
  )
}

/** Registers `remove_alias`. */
function registerRemoveAlias(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'remove_alias',
    {
      title: 'Remove aliases (and veto their return)',
      description: 'Remove alt_labels from a table or event, read-modify-write inside the corpus lock — one locked write for the whole same-target batch. Every removal records a persistent suppression keyed on the label\'s normalized form: enrichment rounds (deterministic AND LLM) will never re-assert a suppressed label — removal IS the veto; it does not depend on the label being present (ensure-absent: pre-vetoing a word the rounds have not found yet). Per-item verdicts in `results`: `removed` (was present, now gone), `absent` (was not present; the veto this call records is the write), `idempotent` (absent and already vetoed — the only true no-op). `suppressed` says whether THIS call recorded the key\'s veto; `reasserted` says whether the same write\'s on-write hook immediately re-derived it (cannot happen for a vetoed label — it is reported per item so a receipt never has to be trusted on faith). Adding the label back (add_alias) lifts the veto.',
      inputSchema: RemoveAliasInputSchema,
    },
    async (input, ctx: ServerContext) => {
      try {
        const snap = deps.bindings.requireSnapshot()
        assertScopeMatch(snap, input.scope_id)
        const res = await auditedWrite(
          snap,
          ctx,
          { tool: 'remove_alias', target: input.name, summary: input.summary, derivation: input.derivation, confidence: input.confidence },
          () => snap.core.removeAliases(input.kind, input.name, input.labels, input.expected_version),
        )
        const body = itemResponseBase(snap, res, enrichmentHealthAfter(snap, input.kind))
        body['results'] = res.value.results
        return toolSuccess(body)
      } catch (e) {
        try { mapCoreError(e, input.kind, input.name) } catch (mapped) { return toToolErrorResult(mapped) }
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
      description: 'Append one dimension/external relation (dim_table + join_keys) to a table or event, read-modify-write inside the corpus lock. Omits origin and derivation on write — the appended ref is treated as curated (ADR-0005 rulings 9-10); your basis for the join belongs in summary. A no-op when the exact same relation is already present. Re-asserting a dim_table whose relations are suppressed LIFTS that veto (granularity: one dim_table per veto) — the receipt\'s `unsuppressed` names the lifted key when this call lifted one.',
      inputSchema: AddRelationInputSchema,
    },
    async (input, ctx: ServerContext) => {
      try {
        const snap = deps.bindings.requireSnapshot()
        assertScopeMatch(snap, input.scope_id)
        const res = await auditedWrite(
          snap,
          ctx,
          { tool: 'add_relation', target: input.name, summary: input.summary, derivation: input.derivation, confidence: input.confidence },
          () => snap.core.addRelation(input.kind, input.name, input.relation, input.expected_version),
        )
        const body = itemResponseBase(snap, res, enrichmentHealthAfter(snap, input.kind))
        if (res.value.unsuppressed) body['unsuppressed'] = res.value.unsuppressed
        return toolSuccess(body)
      } catch (e) {
        try { mapCoreError(e, input.kind, input.name) } catch (mapped) { return toToolErrorResult(mapped) }
      }
    },
  )
}

/** Registers `remove_relation`. */
function registerRemoveRelation(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'remove_relation',
    {
      title: 'Remove relations (machine-derived ones are vetoed)',
      description: 'Remove exactly-matching dimension/external relations (dim_table + join_keys) from a table or event, read-modify-write inside the corpus lock — one locked write for the whole same-target batch. Per-item verdicts in `results` with three facts: `outcome` (`removed` / `absent` / `idempotent`), `suppressed` (did THIS call record the veto), and `reasserted` (did the same write\'s on-write hook immediately re-derive it). Removal routes by the stored entry\'s origin (#37 §1): deleting a machine-derived ref (origin deterministic/llm) records a persistent suppression for that dim_table — enrichment rounds will never re-derive the join; deleting a curated ref (origin manual/absent: hand-added or agent-asserted) is a pure content correction, and if the deterministic round CAN re-derive that join it comes back in the same call (`reasserted: true`) — remove it again and THAT removal vetoes it. Removing an absent relation records the veto (ensure-absent: pre-veto a DIM you know is noise). Adding the dim_table back (add_relation) lifts the veto.',
      inputSchema: RemoveRelationInputSchema,
    },
    async (input, ctx: ServerContext) => {
      try {
        const snap = deps.bindings.requireSnapshot()
        assertScopeMatch(snap, input.scope_id)
        const res = await auditedWrite(
          snap,
          ctx,
          { tool: 'remove_relation', target: input.name, summary: input.summary, derivation: input.derivation, confidence: input.confidence },
          () => snap.core.removeRelations(input.kind, input.name, input.relations, input.expected_version),
        )
        const body = itemResponseBase(snap, res, enrichmentHealthAfter(snap, input.kind))
        body['results'] = res.value.results
        return toolSuccess(body)
      } catch (e) {
        try { mapCoreError(e, input.kind, input.name) } catch (mapped) { return toToolErrorResult(mapped) }
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

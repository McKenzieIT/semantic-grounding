/**
 * ADR-0005's four item-level write tools: `add_alias`, `remove_alias`, `add_relation`,
 * `remove_relation`.
 *
 * #49 thinning: handlers are now **schema + auditedWrite + Core call + response
 * formatting**. All domain logic (normalizeLabel, read-modify-write, dual-field
 * overlay, origin routing, veto lift) lives in `SemanticGroundingCore` methods
 * (`addAliases`, `removeAliases`, `addRelations`, `removeRelations` — #109
 * reshaped the add side to the same-target batch shape its removal twin
 * already had). The handler's only jobs are:
 * 1. Zod schema validation (input shape).
 * 2. `auditedWrite` wrapping (lock + audit context).
 * 3. Core method call (domain logic).
 * 4. Response formatting (`commit`, `changed`, `version`, `enrichment_health`, verdicts).
 *
 * Error mapping is not among the handler's jobs anymore: the substrate's
 * thrown plain `Error("Table not found: …")` is translated by `notFoundAsCoded`
 * (the errors.ts adapter family, #120/C5) at the one promise it can originate
 * from, and the server's chokepoint wrap shapes the coded error into the
 * `isError` result every handler used to hand-roll for itself.
 *
 * @see docs/adr/0005-mcp-tool-surface.md + docs/adr/0010-suppression.md
 */
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import { edgeAnchorOf } from '@semantic-grounding/substrate'
import { z } from 'zod'
import { notFoundAsCoded } from '../errors.ts'
import type { ServerDeps, ToolRegistrar } from '../server.ts'
import { assertScopeMatch, auditedWrite, toolSuccess, writeReceipt } from './audited.ts'
import { PROMOTION_EVIDENCE_DESCRIPTION, evidenceForIntent, withPromotionWrite } from './promotion.ts'
import {
  RelationRefInputSchema,
  UPDATE_COMMON_FIELDS,
  AliasKindSchema,
  PROMOTION_EVIDENCE_FIELD,
  RelationSubjectKindSchema,
  type ToolFamily,
} from './shared.ts'

/** The four item-level tool names. */
export const ITEM_TOOL_NAMES = ['add_alias', 'remove_alias', 'add_relation', 'remove_relation'] as const

/** `add_alias` input: same-target batch of labels — the add-side mirror of
 * `remove_alias`'s array (#37 §3 / #109 / #107 Q4: same thing, same name;
 * the empty array is closed at the door, map #27 precedent). Breaking
 * reshape of ADR-0005's single `alias`. */
const AddAliasInputSchema = z.object({
  kind: AliasKindSchema,
  name: z.string().min(1),
  labels: z.array(z.string().min(1)).min(1),
  ...UPDATE_COMMON_FIELDS,
  ...PROMOTION_EVIDENCE_FIELD,
})

/** `remove_alias` input: same-target batch of labels (#37 §3 — the empty array is
 * closed at the door, map #27 precedent). Breaking reshape of ADR-0005's `alias`. */
const RemoveAliasInputSchema = z.object({
  kind: AliasKindSchema,
  name: z.string().min(1),
  labels: z.array(z.string().min(1)).min(1),
  ...UPDATE_COMMON_FIELDS,
})

/** `add_relation` input: same-target batch of relations — the add-side
 * mirror of `remove_relation`'s array (#109 / #107 Q4). One shape per call:
 * joins and concept-side edges cannot mix (the Core refuses the mix —
 * different files, different baselines), and a table subject's edges must
 * all name the same target concept. */
const AddRelationInputSchema = z.object({
  kind: RelationSubjectKindSchema,
  name: z.string().min(1),
  relations: z.array(RelationRefInputSchema).min(1),
  ...UPDATE_COMMON_FIELDS,
  ...PROMOTION_EVIDENCE_FIELD,
})

/** `remove_relation` input: same-target batch of relations (#37 §3). Breaking
 * reshape of ADR-0005's `relation`. One shape per call: joins and concept-side
 * edges cannot mix (the Core refuses the mix — different files, different
 * baselines). */
const RemoveRelationInputSchema = z.object({
  kind: RelationSubjectKindSchema,
  name: z.string().min(1),
  relations: z.array(RelationRefInputSchema).min(1),
  ...UPDATE_COMMON_FIELDS,
})

/** Registers `add_alias`. */
function registerAddAlias(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'add_alias',
    {
      title: 'Add aliases (and lift their vetoes)',
      description: 'Append alt_labels to a table, event, or concept, read-modify-write inside the corpus lock — one locked write (one commit) for the whole same-target batch. Adding back a suppressed label LIFTS its veto — removal is the veto, re-assertion is its mirror. Per-item verdicts in `results`: `outcome` (`added` = this call landed the label or lifted its veto, either is a real change; `idempotent` = already present and not vetoed, the only true no-op) and `unsuppressed` (did THIS call lift that key\'s veto — adding a vetoed word is `added` AND `unsuppressed: true`, one boolean, never a third outcome). A batch where every row is idempotent makes no commit (changed:false). The receipt\'s `version` is the written file\'s fingerprint — feed it straight back as the next write\'s expected_version. ' + PROMOTION_EVIDENCE_DESCRIPTION,
      inputSchema: AddAliasInputSchema,
    },
    async (input, ctx: ServerContext) => {
      const snap = deps.bindings.requireSnapshot()
      assertScopeMatch(snap, input.scope_id)
      const res = await auditedWrite(
        snap,
        ctx,
        { tool: 'add_alias', target: input.name, summary: input.summary, derivation: input.derivation, confidence: input.confidence, ...evidenceForIntent(input.evidence) },
        // The promotion target is the SUBJECT definition (ADR-0023 R6's `to`
        // reaches object identity only) — whatever the rows' idempotence,
        // the object the conclusion was promoted into is this node.
        () => withPromotionWrite(snap, deps, input.evidence, () => [`${input.kind}:${input.name}`], () => snap.core.addAliases(input.kind, input.name, input.labels, input.expected_version)),
      ).catch((e: unknown) => notFoundAsCoded(e, input.kind, input.name))
      return toolSuccess(await writeReceipt(snap, deps, res, {
        tool: 'add_alias',
        writePath: input.kind,
        version: res.value.version,
        domain: { results: res.value.results },
      }))
    },
  )
}

/** Registers `remove_alias`. */
function registerRemoveAlias(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'remove_alias',
    {
      title: 'Remove aliases (and veto their return)',
      description: 'Remove alt_labels from a table, event, or concept, read-modify-write inside the corpus lock — one locked write for the whole same-target batch. Every removal records a persistent suppression keyed on the label\'s normalized form: enrichment rounds (deterministic AND LLM) will never re-assert a suppressed label — removal IS the veto; it does not depend on the label being present (ensure-absent: pre-vetoing a word the rounds have not found yet). Per-item verdicts in `results`: `removed` (was present, now gone), `absent` (was not present; the veto this call records is the write), `idempotent` (absent and already vetoed — the only true no-op). `suppressed` says whether THIS call recorded the key\'s veto; `reasserted` says whether the same write\'s on-write hook immediately re-derived it (cannot happen for a vetoed label, and never happens on concepts — they have no enrichment rounds — the field is reported per item so a receipt never has to be trusted on faith). Adding the label back (add_alias) lifts the veto.',
      inputSchema: RemoveAliasInputSchema,
    },
    async (input, ctx: ServerContext) => {
      const snap = deps.bindings.requireSnapshot()
      assertScopeMatch(snap, input.scope_id)
      const res = await auditedWrite(
        snap,
        ctx,
        { tool: 'remove_alias', target: input.name, summary: input.summary, derivation: input.derivation, confidence: input.confidence },
        () => snap.core.removeAliases(input.kind, input.name, input.labels, input.expected_version),
      ).catch((e: unknown) => notFoundAsCoded(e, input.kind, input.name))
      return toolSuccess(await writeReceipt(snap, deps, res, {
        tool: 'remove_alias',
        writePath: input.kind,
        version: res.value.version,
        domain: { results: res.value.results },
      }))
    },
  )
}

/** Registers `add_relation`. */
function registerAddRelation(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'add_relation',
    {
      title: 'Add relations (one landing file per batch)',
      description: 'Append relations to a table, event, or concept, read-modify-write inside the corpus lock — one locked write (one commit) for the whole same-target batch. Two shapes, one per call: a join (dim_table + join_keys) on a table/event subject, or a concept-side edge ({target_kind, name}) for the entity layer — concept→concept, concept→table, or table→concept (event subjects take joins only); the Core refuses a mix, and a table subject\'s edges must all name the SAME target concept — a batch spanning landing files is rejected whole with a split-the-call error. A concept-side edge lands on the concept\'s related_refs — for a table subject naming a concept target, that is the TARGET concept\'s file, so expected_version is that concept\'s fingerprint (from get_definition kind:"concept"); for a concept subject it is the subject\'s own. Omits origin and derivation on write — the appended ref is treated as curated (ADR-0005 rulings 9-10); your basis for the relation belongs in summary. Re-asserting a dim_table whose relations are suppressed LIFTS that veto (granularity: one dim_table per veto). Per-item verdicts in `results`: `outcome` (`added` = landed the relation or lifted the key\'s veto; `idempotent` = already present and not vetoed) and `unsuppressed` (did THIS call lift that key\'s veto). A fully-idempotent batch makes no commit; the receipt\'s `version` feeds the next write\'s expected_version. ' + PROMOTION_EVIDENCE_DESCRIPTION,
      inputSchema: AddRelationInputSchema,
    },
    async (input, ctx: ServerContext) => {
      const snap = deps.bindings.requireSnapshot()
      assertScopeMatch(snap, input.scope_id)
      const res = await auditedWrite(
        snap,
        ctx,
        { tool: 'add_relation', target: input.name, summary: input.summary, derivation: input.derivation, confidence: input.confidence, ...evidenceForIntent(input.evidence) },
        // A promoted relation's `to` is the canonical EDGE it lands
        // (ADR-0023 R6 — object identity includes edges), one anchor string
        // per input relation, derived the same way remove_relation's
        // dangling count derives its dying edges.
        () => withPromotionWrite(snap, deps, input.evidence, () => relationEdgesOf(input.kind, input.name, input.relations).map(e => edgeAnchorOf(e.from, e.type, e.to)), () => snap.core.addRelations(input.kind, input.name, input.relations, input.expected_version)),
      ).catch((e: unknown) => notFoundAsCoded(e, input.kind, input.name))
      return toolSuccess(await writeReceipt(snap, deps, res, {
        tool: 'add_relation',
        writePath: input.kind,
        version: res.value.version,
        domain: { results: res.value.results },
      }))
    },
  )
}

/** Registers `remove_relation`. */
function registerRemoveRelation(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'remove_relation',
    {
      title: 'Remove relations (machine-derived ones are vetoed)',
      description: 'Remove exactly-matching relations from a table, event, or concept, read-modify-write inside the corpus lock — one locked write for the whole same-target batch. Two shapes, one per call: joins (dim_table + join_keys) or concept-side edges ({target_kind, name}); the Core refuses a mix. Concept-edge removals write the home concept (a table subject\'s concept-target edge lives on the TARGET concept — expected_version is that concept\'s fingerprint) and have no enrichment rounds, so their `reasserted` is always false. Join removals route by the stored entry\'s origin (#37 §1): deleting a machine-derived ref (origin deterministic/llm) records a persistent suppression for that dim_table — enrichment rounds will never re-derive the join; deleting a curated ref (origin manual/absent: hand-added or agent-asserted) is a pure content correction, and if the deterministic round CAN re-derive that join it comes back in the same call (`reasserted: true`) — remove it again and THAT removal vetoes it. Per-item verdicts in `results` with three facts: `outcome` (`removed` / `absent` / `idempotent`), `suppressed` (did THIS call record the veto), and `reasserted`. Removing an absent relation records the veto (ensure-absent: pre-veto a DIM you know is noise). A `removed` row whose edge still carries memory entries reports `dangling_memories: N` — those entries lost their anchor target (ADR-0026 R5: a reminder, never a block; the entries stay, dangling is computed at read time). Adding the dim_table back (add_relation) lifts the veto.',
      inputSchema: RemoveRelationInputSchema,
    },
    async (input, ctx: ServerContext) => {
      const snap = deps.bindings.requireSnapshot()
      assertScopeMatch(snap, input.scope_id)
      const res = await auditedWrite(
        snap,
        ctx,
        { tool: 'remove_relation', target: input.name, summary: input.summary, derivation: input.derivation, confidence: input.confidence },
        () => snap.core.removeRelations(input.kind, input.name, input.relations, input.expected_version),
      ).catch((e: unknown) => notFoundAsCoded(e, input.kind, input.name))
      // ADR-0026 R5: every REMOVED edge's verdict row reports how many memory
      // entries were anchored on it (`dangling_memories`, key absent at 0 — a
      // memory-free corpus keeps this receipt byte-identical). Computed
      // post-write against the process-resident anchor index (ADR-0023 R1).
      const edges = relationEdgesOf(input.kind, input.name, input.relations)
      const results = res.value.results.map((row, i) => {
        if (row.outcome !== 'removed') return row
        const edge = edges[i]
        if (edge === undefined) return row
        const dangling = snap.core.countMemoriesOnEdges([edge])
        return dangling > 0 ? { ...row, dangling_memories: dangling } : row
      })
      return toolSuccess(await writeReceipt(snap, deps, res, {
        tool: 'remove_relation',
        writePath: input.kind,
        version: res.value.version,
        domain: { results },
      }))
    },
  )
}

/**
 * The canonical edge each input relation of a relation-batch call names
 * (ADR-0023 R4's grammar, the graph build's canonical logical direction:
 * asset→dim for joins, home-concept→target for declared edges). Two
 * consumers read the same derivation: `remove_relation`'s per-row
 * `dangling_memories` count (aligned with the verdict rows the Core returns —
 * row i ↔ relation i for join batches and concept-subject edge batches; a
 * table subject's whole edge batch collapses to the ONE stored edge, matching
 * the Core's single verdict row) and `add_relation`'s promotion `to` targets
 * (#136: one back-pointer per canonical edge, whatever the rows' verdicts —
 * both `added` and `idempotent` affirm the edge object).
 * @param kind - the batch's subject kind.
 * @param name - the subject table/event/concept name.
 * @param relations - the batch's input relations, in order.
 * @returns one canonical edge triple per input relation (empty for an empty batch).
 */
function relationEdgesOf(
  kind: 'table' | 'event' | 'concept',
  name: string,
  relations: ReadonlyArray<{ readonly target_kind?: 'table' | 'concept'; readonly dim_table?: string; readonly name?: string }>,
): ReadonlyArray<{ readonly from: string; readonly type: string; readonly to: string }> {
  const isEdgeBatch = relations[0]?.target_kind !== undefined
  if (!isEdgeBatch) {
    const from = kind === 'table' ? `table:${name}` : `event:${name}`
    return relations.map(rel => ({ from, type: 'joins', to: `table:${rel.dim_table}` }))
  }
  if (kind === 'concept') {
    return relations.map(rel => ({
      from: `concept:${name}`,
      type: 'related_to',
      to: rel.target_kind === 'concept' ? `concept:${rel.name}` : `table:${rel.name}`,
    }))
  }
  // A table subject's edge batch names ONE target concept (the Core's
  // split-the-call rule) and lands as ONE stored edge — one triple.
  const target = relations[0]?.name
  return target === undefined ? [] : [{ from: `concept:${target}`, type: 'related_to', to: `table:${name}` }]
}

/** Registers all four item-level tools. */
export const registerItemTools: ToolRegistrar = (server, deps) => {
  registerAddAlias(server, deps)
  registerRemoveAlias(server, deps)
  registerAddRelation(server, deps)
  registerRemoveRelation(server, deps)
}

/** The item-level family's descriptor card (#115): its names and registrar bound in
 * one place, for `tools/index.ts` to compose — never a second copy of either key. */
export const ITEM_TOOL_FAMILY: ToolFamily = { names: ITEM_TOOL_NAMES, register: registerItemTools }

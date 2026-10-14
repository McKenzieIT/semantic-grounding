/**
 * ADR-0005's read tools: `search_definitions`, `get_definition`, `get_join_path`,
 * `get_relations`, `resolve_alias` — plus ruling 6's sixth (#105 / ADR-0005's
 * 2026-10-14 Update): the `list_definitions` inventory index.
 *
 * All six are pure reads over the already-loaded `SemanticGroundingCore` — no lock, no
 * recorder, no `AuditContext`. Registration here is the same pure-registration contract
 * every `ToolRegistrar` must satisfy (`server.ts`'s module doc): the corpus reads happen
 * per call, inside each handler, never while `registerTool` itself runs.
 *
 * @module tools/read
 */
import type { McpServer } from '@modelcontextprotocol/server'
import type { GraphNodeProjection, SemanticGroundingCore } from '@semantic-grounding/substrate'
import { z } from 'zod'
import { DefinitionNotFoundError, toToolErrorResult } from '../errors.ts'
import type { ServerDeps, ToolRegistrar } from '../server.ts'
import { scopeStamp } from './audited.ts'
import { ReadableKindSchema, type ToolFamily } from './shared.ts'

/** The six read tool names — ADR-0005 ruling 6's five in listing order, then #105's `list_definitions` (read face five→six, 2026-10-14 Update). */
export const READ_TOOL_NAMES = [
  'search_definitions',
  'get_definition',
  'get_join_path',
  'get_relations',
  'resolve_alias',
  'list_definitions',
] as const

// ── search_definitions ───────────────────────────────────────────────────────────────

/** One candidate `search_definitions` ranks — the fields the scorer reads. */
export interface SearchCandidate {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly domains: readonly string[]
  readonly description: string
  readonly altLabels: readonly string[]
  readonly prefLabel?: string
}

/** One scored, ordered `search_definitions` result. */
export interface SearchHit {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly description: string
  readonly domains: readonly string[]
  readonly score: number
}

const MIN_GRAM_LENGTH = 2

/**
 * Character bigrams of a normalized string, for the overlap half of the score.
 *
 * Bigrams rather than whitespace tokens: this corpus's alt_labels and descriptions are
 * routinely Chinese (ADR-0005's own examples: `添加别名「订单宽表」`), which carries no
 * word-boundary whitespace a Latin tokenizer could split on. Character n-grams are a
 * standard, dependency-free stand-in for CJK segmentation and degrade gracefully to
 * substring-ish matching on Latin text too — this ticket's own call on ADR-0005 ruling
 * 6's "搜索…算法实现票自裁" ("implementation deferred to this ticket"), kept
 * deliberately simple (a thin host wrapper is not the place for a real IR engine); a
 * dogfood signal that it under- or over-matches is Followup, not a blocker here.
 * @param text - the text to gram (already lowercased by the caller).
 * @returns the set of overlapping 2-character windows, or a single-entry set for text
 *   shorter than {@link MIN_GRAM_LENGTH} (so a one-character query still matches something).
 */
function bigrams(text: string): ReadonlySet<string> {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length < MIN_GRAM_LENGTH) return collapsed === '' ? new Set() : new Set([collapsed])
  const out = new Set<string>()
  for (let i = 0; i <= collapsed.length - MIN_GRAM_LENGTH; i++) out.add(collapsed.slice(i, i + MIN_GRAM_LENGTH))
  return out
}

/**
 * Score one candidate against a query: bigram overlap (fraction of the query's own
 * grams found in the candidate's text) plus two precise bonuses — a full substring
 * match, and an exact id/label match — so a short, exact query (`"dws_order"`) ranks
 * its own table above a long description that merely shares a few bigrams with it.
 * @param queryNorm - the lowercased, trimmed query.
 * @param queryGrams - `queryNorm`'s own bigrams (computed once per search, not per candidate).
 * @param candidate - the candidate being scored.
 * @returns a non-negative score; 0 means no overlap at all.
 */
function score(queryNorm: string, queryGrams: ReadonlySet<string>, candidate: SearchCandidate): number {
  const idNorm = candidate.id.toLowerCase()
  const labelNorm = candidate.label.toLowerCase()
  const text = [
    candidate.id,
    candidate.label,
    ...candidate.domains,
    candidate.description,
    ...candidate.altLabels,
    candidate.prefLabel ?? '',
  ].filter(s => s !== '').join(' ').toLowerCase()

  if (queryGrams.size === 0) return 0
  let hits = 0
  for (const g of queryGrams) if (text.includes(g)) hits++
  let s = hits / queryGrams.size

  if (idNorm === queryNorm || labelNorm === queryNorm) s += 2
  else if (text.includes(queryNorm)) s += 1

  return s
}

/**
 * Rank every candidate against a query. Exported standalone (no `McpServer`/corpus
 * dependency) so the scoring behaviour has its own focused tests independent of the
 * registrar plumbing.
 * @param query - the search text (1+ characters; the tool schema enforces this).
 * @param candidates - every candidate in scope (already kind-filtered by the caller).
 * @param topK - the maximum number of hits to return.
 * @returns hits with `score > 0`, highest first, ties broken by `id` ascending for a stable order.
 */
export function rankDefinitions(query: string, candidates: readonly SearchCandidate[], topK: number): SearchHit[] {
  const queryNorm = query.toLowerCase().trim()
  const queryGrams = bigrams(queryNorm)
  return candidates
    .map(c => ({ c, s: score(queryNorm, queryGrams, c) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s || a.c.id.localeCompare(b.c.id))
    .slice(0, topK)
    .map(({ c, s }) => ({ id: c.id, kind: c.kind, label: c.label, description: c.description, domains: c.domains, score: s }))
}

/**
 * Project the live corpus into {@link SearchCandidate}s, by id.
 *
 * Zips `core.projectGraphNodes` (which carries `kind`/`label`/`domains`, keyed by the
 * same canonical id every kind plugin mints — `registry.ts`'s `RelationDef.target`
 * contract) with `core.loadRetrievalCorpusAll` (which carries the indexed description
 * and the original definition as `payload`). Both are synchronous reads over the same
 * on-disk state with no `await` between them, so the two calls cannot observe different
 * writes — safe to zip by id without a staleness race.
 * @param core - the entry snapshot's core (which corpus to project).
 * @returns every candidate the registry currently projects.
 */
function buildCandidates(core: SemanticGroundingCore): SearchCandidate[] {
  const nodesById = new Map<string, GraphNodeProjection>(
    core.projectGraphNodes({ includeDerived: true }).map(n => [n.id, n]),
  )
  const items = core.loadRetrievalCorpusAll()
  const out: SearchCandidate[] = []
  for (const item of items) {
    const node = nodesById.get(item.id)
    const payload = item.payload as { readonly alt_labels?: readonly string[]; readonly pref_label?: string } | undefined
    out.push({
      id: item.id,
      kind: node?.kind ?? 'unknown',
      label: node?.label ?? item.id,
      domains: node?.domains ?? [],
      description: item.description ?? '',
      altLabels: payload?.alt_labels ?? [],
      ...(payload?.pref_label !== undefined ? { prefLabel: payload.pref_label } : {}),
    })
  }
  return out
}

const SearchInputSchema = z.object({
  query: z.string().min(1).describe('Search text — a name, alias, or free-text description fragment. Matched by character n-gram overlap plus exact substring/id bonuses (CJK-friendly).'),
  top_k: z.number().int().min(1).max(50).optional().describe('Maximum number of hits to return (default 10).'),
  kinds: z.array(ReadableKindSchema).optional().describe('Restrict to these kinds; omit to search every kind.'),
})

/** Registers `search_definitions`. */
function registerSearchDefinitions(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'search_definitions',
    {
      title: 'Search definitions',
      description: 'Rank tables, events, concepts and metrics against a free-text query (names, aliases, descriptions). Does not return a version fingerprint — summaries are not a write precondition (ADR-0005 ruling 6); call get_definition for that.',
      inputSchema: SearchInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        const snap = deps.bindings.requireSnapshot()
        const kindFilter = input.kinds !== undefined ? new Set<string>(input.kinds) : undefined
        const candidates = buildCandidates(snap.core).filter(c => kindFilter === undefined || kindFilter.has(foldTableStorageKind(c.kind)))
        const hits = rankDefinitions(input.query, candidates, input.top_k ?? 10)
        return { content: [{ type: 'text', text: JSON.stringify({ scope: scopeStamp(snap), hits }) }] }
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

// ── get_definition ───────────────────────────────────────────────────────────────────

const GetDefinitionInputSchema = z.object({
  kind: ReadableKindSchema,
  name: z.string().min(1),
})

/** Registers `get_definition` — the only read tool that returns the `version` fingerprint. */
function registerGetDefinition(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_definition',
    {
      title: 'Get one definition',
      description: 'Load one table, event, concept or metric by name. Returns the sha256 content fingerprint as `version` for table/event/concept (pass it back as `expected_version` on a later write); metrics have no backing file and carry no version.',
      inputSchema: GetDefinitionInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        const snap = deps.bindings.requireSnapshot()
        // One fingerprint implementation for both sides of ADR-0004 ruling 8's
        // contract: each Core method resolves the very file the corresponding
        // write path's staleness check hashes (the MCP layer's former parallel
        // copy — filename-convention fingerprints plus a full-corpus
        // `loadEvents` scan to locate one event's domain — is retired with
        // this switch, and with it the hand-renamed-event-file ENOENT fork).
        if (input.kind === 'table') {
          const res = snap.core.loadTableDefinitionWithVersion(input.name)
          if (res === null) {
            throw new DefinitionNotFoundError(`no table named "${input.name}"`, { kind: 'table', name: input.name })
          }
          return { content: [{ type: 'text', text: JSON.stringify({ scope: scopeStamp(snap), kind: 'table', name: input.name, definition: res.definition, version: res.version }) }] }
        }
        if (input.kind === 'event') {
          const res = snap.core.loadEventDefinitionWithVersion(input.name)
          if (res === null) {
            throw new DefinitionNotFoundError(`no event named "${input.name}"`, { kind: 'event', name: input.name })
          }
          return { content: [{ type: 'text', text: JSON.stringify({ scope: scopeStamp(snap), kind: 'event', name: input.name, definition: res.definition, version: res.version }) }] }
        }
        if (input.kind === 'concept') {
          const res = snap.core.loadConceptDefinitionWithVersion(input.name)
          if (res === null) {
            throw new DefinitionNotFoundError(`no concept named "${input.name}"`, { kind: 'concept', name: input.name })
          }
          return { content: [{ type: 'text', text: JSON.stringify({ scope: scopeStamp(snap), kind: 'concept', name: input.name, definition: res.definition, version: res.version }) }] }
        }
        // kind === 'metric': derived from a host table/event's inline `metrics:` block,
        // not a standalone file (metrics.ts / GLOSSARY § definition) — there is no raw
        // byte artifact to fingerprint, and no write tool ever needs one for a metric.
        const definition = snap.core.loadMetricDefinition(input.name)
        if (definition === null) {
          throw new DefinitionNotFoundError(`no metric named "${input.name}"`, { kind: 'metric', name: input.name })
        }
        return { content: [{ type: 'text', text: JSON.stringify({ scope: scopeStamp(snap), kind: 'metric', name: input.name, definition }) }] }
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

// ── get_join_path ────────────────────────────────────────────────────────────────────

const GetJoinPathInputSchema = z.object({
  from: z.string().min(1).describe('Source node id (a table_name, event name, or `concept:<name>`).'),
  to: z.string().min(1).describe('Target node id.'),
})

/** Registers `get_join_path`. */
function registerGetJoinPath(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_join_path',
    {
      title: 'Find a join path',
      description: 'BFS shortest path over `joins`-type relations (undirected — every edge is walked both ways, so from/to may be swapped) between two node ids; `related_to` and other non-joins types never participate. Returns `path: null` when unreachable — not an error.',
      inputSchema: GetJoinPathInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        const snap = deps.bindings.requireSnapshot()
        const path = snap.core.getRelationGraph().findJoinPath(input.from, input.to)
        return { content: [{ type: 'text', text: JSON.stringify({ scope: scopeStamp(snap), from: input.from, to: input.to, found: path !== null, path }) }] }
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

// ── get_relations ────────────────────────────────────────────────────────────────────

const GetRelationsInputSchema = z.object({
  target: z.string().min(1).describe('Node id to list relations from (a table_name, event name, or `concept:<name>`).'),
  type: z.string().min(1).optional().describe('Restrict to this relation type (an open vocabulary — `joins`/`derived_from`/`related_to` or a kind-declared type); omit for all types.'),
})

/** Registers `get_relations`. */
function registerGetRelations(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_relations',
    {
      title: 'List direct relations',
      description: 'Direct relation-graph edges from one node, optionally filtered by type. Returns an empty list for an unknown or unrelated node — not an error.',
      inputSchema: GetRelationsInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        const snap = deps.bindings.requireSnapshot()
        const relations = snap.core.getRelationGraph().getRelated(input.target, input.type)
        return { content: [{ type: 'text', text: JSON.stringify({ scope: scopeStamp(snap), target: input.target, relations }) }] }
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

// ── resolve_alias ────────────────────────────────────────────────────────────────────

const ResolveAliasInputSchema = z.object({
  term: z.string().min(1).describe('The surface term a user typed — Chinese, English, or jargon.'),
})

/** Registers `resolve_alias`. */
function registerResolveAlias(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'resolve_alias',
    {
      title: 'Resolve an alias to node ids',
      description: 'Look up a surface term (pref_label or alt_labels) in the alias index. Returns an empty list when nothing matches — not an error.',
      inputSchema: ResolveAliasInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        const snap = deps.bindings.requireSnapshot()
        const nodeIds = snap.core.getRelationGraph().resolveAlias(input.term)
        return { content: [{ type: 'text', text: JSON.stringify({ scope: scopeStamp(snap), term: input.term, node_ids: nodeIds }) }] }
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

// ── list_definitions ─────────────────────────────────────────────────────────────────

/**
 * The inventory-index row cap (#105 ruling 3, on ADR-0008 ruling 4's precedent): a
 * code constant, deliberately NOT config — response sizing is a contract, not a
 * tuning knob. The 786-definition k11 flagship corpus fits under it untruncated.
 */
export const LIST_DEFINITIONS_CAP = 1000

/**
 * Projection kinds that belong to the readable `table` kind. A table node's graph
 * projection carries its STORAGE kind — `dws`/`dim`, the only values
 * `TableDefinitionSchema.kind`'s closed enum permits (`types.ts`), carried open on
 * the projection so a new table kind needs no gateway change (`table-kind.ts`) —
 * while the tool face's kind vocabulary is `ReadableKindSchema`'s
 * (`table`/`event`/`concept`/`metric`). Folding exactly these two keeps the `kinds`
 * filter speaking the declared vocabulary without forking the projection's open
 * one; every other projection kind passes through and is narrowed by its own name
 * once (and if) the readable enum grows to know it.
 */
const TABLE_STORAGE_KINDS: ReadonlySet<string> = new Set(['dws', 'dim'])

/**
 * Fold a projection kind into the `ReadableKind` vocabulary the `kinds` filters
 * speak — the one place the dws/dim → table fold is defined, consumed by both
 * read filters that narrow by kind (`search_definitions` per #117,
 * `list_definitions` per #112). Every other projection kind passes through
 * unchanged; ranked and inventory ROWS never go through it — they carry the
 * projection kind verbatim.
 */
function foldTableStorageKind(projectionKind: string): string {
  return TABLE_STORAGE_KINDS.has(projectionKind) ? 'table' : projectionKind
}

/** One `list_definitions` index row — the four fields an inventory needs, and nothing else (no `description`, no `version`). */
export interface DefinitionIndexRow {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly domains: readonly string[]
}

/**
 * Order rows by kind, then id — plain code-unit comparison, not `localeCompare`:
 * the ruling asks for an order audit comparisons can reproduce (#105 ruling 2),
 * and a locale-sensitive comparator would order CJK-bearing ids differently per
 * host. Search keeps its ranking order; list keeps this inventory order — two
 * orders coexisting, never mixed.
 */
function byKindThenId(a: GraphNodeProjection, b: GraphNodeProjection): number {
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Project the live corpus into `list_definitions`' deterministic inventory index.
 *
 * Exported standalone, same rule as {@link rankDefinitions}: the ordering/filter/cap
 * behaviour gets focused tests independent of the registrar plumbing. Rows carry
 * `{id, kind, label, domains}` only — including `description` is the shape #105
 * ruling 2 rejected on ADR-0008's index/detail precedent (k11's 786 rows would go
 * from ~2–3万 to 十几万 tokens); a row's description is `get_definition`'s to give.
 * `kind` rides the projection verbatim (`dws`/`dim` for tables — an inventory
 * wants the storage granularity, which is exactly the #93 audit lens), while the
 * `kinds` FILTER folds table storage kinds into `table` per
 * {@link TABLE_STORAGE_KINDS}.
 * @param nodes - the projection to index (`core.projectGraphNodes({includeDerived: true})` — derived metrics included, #105 ruling 6).
 * @param kinds - the caller's kind narrowing (already zod-validated), or undefined for every kind.
 * @param cap - the row cap (the handler passes {@link LIST_DEFINITIONS_CAP}; a parameter so tests can pin truncation without a 1001-definition corpus).
 * @returns `{total, truncated, definitions}` with `total` counting the POST-filter rows and `truncated` true exactly when rows were dropped.
 */
export function listDefinitionsIndex(
  nodes: readonly GraphNodeProjection[],
  kinds: readonly string[] | undefined,
  cap: number,
): { readonly total: number; readonly truncated: boolean; readonly definitions: readonly DefinitionIndexRow[] } {
  const filter = kinds !== undefined ? new Set(kinds) : undefined
  const rows = nodes
    .filter(n => filter === undefined || filter.has(foldTableStorageKind(n.kind)))
    .sort(byKindThenId)
  return {
    total: rows.length,
    truncated: rows.length > cap,
    definitions: rows.slice(0, cap).map(n => ({ id: n.id, kind: n.kind, label: n.label, domains: n.domains })),
  }
}

const ListDefinitionsInputSchema = z.object({
  kinds: z.array(ReadableKindSchema).optional().describe('Restrict to these kinds; omit to list every kind.'),
})

/** Registers `list_definitions`. */
function registerListDefinitions(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'list_definitions',
    {
      title: 'List definitions (inventory index)',
      description: 'Enumerate every definition in the active scope as a compact inventory index — one row {id, kind, label, domains} each, in deterministic kind-then-id order (an inventory order for audit comparability, not a search ranking), derived metrics included. Rows carry no description on purpose — an index stays cheap while a description per row would inflate a large corpus by an order of magnitude (ADR-0008\'s index/detail split); fetch a row\'s description via get_definition. Capped at 1000 rows with total and truncated alongside. Narrow with kinds (table/event/concept/metric; omit for every kind). Read-only; makes no commit.',
      inputSchema: ListDefinitionsInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        const snap = deps.bindings.requireSnapshot()
        const { total, truncated, definitions } = listDefinitionsIndex(
          snap.core.projectGraphNodes({ includeDerived: true }),
          input.kinds,
          LIST_DEFINITIONS_CAP,
        )
        return { content: [{ type: 'text', text: JSON.stringify({ scope: scopeStamp(snap), total, truncated, definitions }) }] }
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

/** Registers all six read tools. */
export const registerReadTools: ToolRegistrar = (server, deps) => {
  registerSearchDefinitions(server, deps)
  registerGetDefinition(server, deps)
  registerGetJoinPath(server, deps)
  registerGetRelations(server, deps)
  registerResolveAlias(server, deps)
  registerListDefinitions(server, deps)
}

/** The read family's descriptor card (#115): its names and registrar bound in one
 * place, for `tools/index.ts` to compose — never a second copy of either key. */
export const READ_TOOL_FAMILY: ToolFamily = { names: READ_TOOL_NAMES, register: registerReadTools }

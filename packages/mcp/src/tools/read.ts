/**
 * ADR-0005's five read tools: `search_definitions`, `get_definition`, `get_join_path`,
 * `get_relations`, `resolve_alias`.
 *
 * All five are pure reads over the already-loaded `SemanticGroundingCore` — no lock, no
 * recorder, no `AuditContext`. Registration here is the same pure-registration contract
 * every `ToolRegistrar` must satisfy (`server.ts`'s module doc): the corpus reads happen
 * per call, inside each handler, never while `registerTool` itself runs.
 *
 * @module tools/read
 */
import type { McpServer } from '@modelcontextprotocol/server'
import type { GraphNodeProjection } from '@semantic-grounding/substrate'
import { z } from 'zod'
import { DefinitionNotFoundError, toToolErrorResult } from '../errors.ts'
import type { ServerDeps, ToolRegistrar } from '../server.ts'
import {
  ReadableKindSchema,
  findEventDomain,
  fingerprintConcept,
  fingerprintEvent,
  fingerprintTable,
} from './shared.ts'

/** The five read tool names, in ADR-0005's listing order. */
export const READ_TOOL_NAMES = [
  'search_definitions',
  'get_definition',
  'get_join_path',
  'get_relations',
  'resolve_alias',
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
 * @param deps - the process-wide dependencies.
 * @returns every candidate the registry currently projects.
 */
function buildCandidates(deps: ServerDeps): SearchCandidate[] {
  const nodesById = new Map<string, GraphNodeProjection>(
    deps.core.projectGraphNodes({ includeDerived: true }).map(n => [n.id, n]),
  )
  const items = deps.core.loadRetrievalCorpusAll()
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
        const kindFilter = input.kinds !== undefined ? new Set<string>(input.kinds) : undefined
        const candidates = buildCandidates(deps).filter(c => kindFilter === undefined || kindFilter.has(c.kind))
        const hits = rankDefinitions(input.query, candidates, input.top_k ?? 10)
        return { content: [{ type: 'text', text: JSON.stringify({ hits }) }] }
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
        const root = deps.core.resolveScopeRoot()
        if (input.kind === 'table') {
          const definition = deps.core.loadTableDefinition(input.name)
          if (definition === null) {
            throw new DefinitionNotFoundError(`no table named "${input.name}"`, { kind: 'table', name: input.name })
          }
          const version = fingerprintTable(root, input.name)
          return { content: [{ type: 'text', text: JSON.stringify({ kind: 'table', name: input.name, definition, version }) }] }
        }
        if (input.kind === 'event') {
          const definition = deps.core.loadEventDefinition(input.name)
          if (definition === null) {
            throw new DefinitionNotFoundError(`no event named "${input.name}"`, { kind: 'event', name: input.name })
          }
          const domain = findEventDomain(root, input.name)
          if (domain === undefined) {
            // Loaded successfully above, so the event exists — but its backing file is
            // not where the fast-path convention expects it (see fingerprintEvent's
            // doc). A genuine internal inconsistency, not a "not found": stays loud.
            throw new Error(`event "${input.name}" loaded but its backing file could not be located under events/*/ (non-conventional filename?)`)
          }
          const version = fingerprintEvent(root, input.name, domain)
          return { content: [{ type: 'text', text: JSON.stringify({ kind: 'event', name: input.name, definition, version }) }] }
        }
        if (input.kind === 'concept') {
          const definition = deps.core.loadConceptDefinition(input.name)
          if (definition === null) {
            throw new DefinitionNotFoundError(`no concept named "${input.name}"`, { kind: 'concept', name: input.name })
          }
          const version = fingerprintConcept(root, input.name)
          return { content: [{ type: 'text', text: JSON.stringify({ kind: 'concept', name: input.name, definition, version }) }] }
        }
        // kind === 'metric': derived from a host table/event's inline `metrics:` block,
        // not a standalone file (metrics.ts / GLOSSARY § definition) — there is no raw
        // byte artifact to fingerprint, and no write tool ever needs one for a metric.
        const definition = deps.core.loadMetricDefinition(input.name)
        if (definition === null) {
          throw new DefinitionNotFoundError(`no metric named "${input.name}"`, { kind: 'metric', name: input.name })
        }
        return { content: [{ type: 'text', text: JSON.stringify({ kind: 'metric', name: input.name, definition }) }] }
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
      description: 'BFS shortest path over `joins`-type relations between two node ids. Returns `path: null` when unreachable — not an error.',
      inputSchema: GetJoinPathInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        const path = deps.core.getRelationGraph().findJoinPath(input.from, input.to)
        return { content: [{ type: 'text', text: JSON.stringify({ from: input.from, to: input.to, found: path !== null, path }) }] }
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
        const relations = deps.core.getRelationGraph().getRelated(input.target, input.type)
        return { content: [{ type: 'text', text: JSON.stringify({ target: input.target, relations }) }] }
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
        const nodeIds = deps.core.getRelationGraph().resolveAlias(input.term)
        return { content: [{ type: 'text', text: JSON.stringify({ term: input.term, node_ids: nodeIds }) }] }
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

/** Registers all five read tools. */
export const registerReadTools: ToolRegistrar = (server, deps) => {
  registerSearchDefinitions(server, deps)
  registerGetDefinition(server, deps)
  registerGetJoinPath(server, deps)
  registerGetRelations(server, deps)
  registerResolveAlias(server, deps)
}

/**
 * The verified query's substrate half (ADR-0025 / #155) — the same off-barrel
 * internal-module split `memory.ts` took for #152/#154: the write
 * orchestration (canonicalize `uses` through the memory layer's anchor
 * machinery, validate cited memory ids, hand the definition to io.ts's
 * create-family seam) and the read-side `verified_queries` scan
 * (`get_definition`'s forward-reference mount, ADR-0025 R6②) live here; the
 * Core class's methods are the public route, so the barrel's ADR-0003
 * name list does not grow.
 *
 * 「改查询不改表指纹」is structural here: `uses` is a one-way reference the
 * query file carries, and `verifiedQueriesForNode` derives the reverse view
 * by scanning the queries at read time — no table/event/concept YAML ever
 * records a back-link, so editing a query touches exactly one file's
 * fingerprint (its own content-sha, the `expected_version` baseline
 * `update_verified_query` checks — the fingerprint axis ADR-0019 R7 already
 * names).
 *
 * @module query (internal; only `"."` is importable — see ADR-0002)
 */
import { QueryDefinitionSchema, type QueryDefinition } from './types.ts'
import { loadQueryDefinitions } from './io.ts'
import {
  buildAnchorUniverse,
  canonicalizeAnchor,
  memoryAnchorIndexFor,
  EDGE_ANCHOR_PATTERN,
} from './memory.ts'

// ── Loading ────────────────────────────────────────────────────────────────────

/**
 * Load one verified-query definition by name.
 * @param root - the corpus root.
 * @param name - the query's `name` key.
 * @returns the parsed definition, or null when no query matches.
 */
export function loadQueryDefinition(root: string, name: string): QueryDefinition | null {
  return loadQueryDefinitions(root).find(q => q.name === name) ?? null
}

// ── Write orchestration ────────────────────────────────────────────────────────

/**
 * The agent-submitted verified-query draft — the stored shape's fields the
 * WRITER owns (`uses` arrives bare-or-prefixed and is canonicalized here).
 * Evidence and memory citation ride the tool layer's intent channel, not the
 * YAML (ADR-0025 R4: no `verified_by/at`; the promotion commit answers).
 */
export interface VerifiedQueryDraft {
  readonly name: string
  readonly question: string
  readonly alt_questions?: readonly string[] | undefined
  readonly sql: string
  readonly uses: readonly string[]
  readonly description?: string | undefined
}

/**
 * Prepare one draft into its stored form: canonicalize every `use` through
 * the memory layer's anchor resolution (ADR-0025 R6 — `uses` are ADR-0023
 * anchors and must EXIST at write time, columns included; bare names are
 * tolerated on input, canonical `<kind>:<名>` output; a bare name matching
 * nodes of two kinds is ambiguous), deduplicate, and schema-validate the
 * assembled definition. Zero writes — the caller hands the result to
 * `writeQueryYaml` only on the `{ok:true}` arm.
 * @param root - the corpus root (the anchor universe is derived per call,
 *   like every write-path read).
 * @param draft - the agent-submitted draft.
 * @returns the canonical definition, or the first rejection.
 */
export function prepareVerifiedQuery(
  root: string,
  draft: VerifiedQueryDraft,
): { readonly ok: true; readonly definition: QueryDefinition } | { readonly ok: false; readonly error: string } {
  const universe = buildAnchorUniverse(root)
  const uses: string[] = []
  const seen = new Set<string>()
  for (const raw of draft.uses) {
    const resolved = canonicalizeAnchor(raw, universe)
    if (!resolved.ok) {
      return { ok: false, error: `uses rejected (${resolved.reason}): ${resolved.detail}` }
    }
    if (seen.has(resolved.anchor)) continue
    seen.add(resolved.anchor)
    uses.push(resolved.anchor)
  }
  const assembled = {
    name: draft.name,
    question: draft.question,
    alt_questions: [...draft.alt_questions ?? []],
    sql: draft.sql,
    uses,
    ...(draft.description !== undefined ? { description: draft.description } : {}),
  }
  const parsed = QueryDefinitionSchema.safeParse(assembled)
  if (!parsed.success || parsed.data === undefined) {
    return { ok: false, error: `Query validation failed: ${parsed.error?.message ?? 'unknown'}` }
  }
  return { ok: true, definition: parsed.data }
}

/**
 * The cited memory ids a `create_/update_verified_query` call carries
 * (ADR-0025 R7: `memory_ids` 选填 — the practice entries this 口径 was
 * promoted FROM; the same-commit `promoted` append rides them). Validated
 * BEFORE the write so a dangling citation refuses the whole call with
 * nothing staged — the replicated-evidence guard (#136) is deliberately NOT
 * run here (replicated is refused at the tool door; a ①/② citation needs no
 * ≥2-distinct-session proof), existence is the only machine check.
 * @param root - the corpus root.
 * @param ids - the cited memory ids.
 * @returns the ids that name no stored entry, in citation order (empty = all exist).
 */
export function missingMemoryIds(root: string, ids: readonly string[]): readonly string[] {
  const index = memoryAnchorIndexFor(root)
  index.refresh(root)
  return ids.filter(id => index.get(id) === undefined)
}

// ── Read-side mount (ADR-0025 R6②) ────────────────────────────────────────────

/**
 * The `verified_queries` mount cap (ADR-0025 R6②: ≤5) — a code constant,
 * deliberately NOT config: response sizing is a contract, the same stance
 * `LIST_DEFINITIONS_CAP` and the memory budgets (8/5/3) take.
 */
export const VERIFIED_QUERIES_CAP = 5

/**
 * Does one query's canonical `uses` touch `nodeId`? Three match shapes,
 * mirroring how the memory layer reads anchors: the node itself, a column
 * fragment of it (a column anchor still belongs to its definition,
 * ADR-0023 R4), and an edge anchor with the node as either endpoint (the
 * edge-memory precedent — both ends see it). Bare `uses` in a hand-written
 * file do not resolve here; the write path always stores canonical.
 */
function queryTouchesNode(uses: readonly string[], nodeId: string): boolean {
  for (const use of uses) {
    if (use === nodeId) return true
    if (use.startsWith(`${nodeId}#`)) return true
    const edge = EDGE_ANCHOR_PATTERN.exec(use)
    if (edge !== null && (edge[1] === nodeId || edge[3] === nodeId)) return true
  }
  return false
}

/**
 * The forward-reference view ADR-0025 R6② rules for `get_definition` on a
 * table or concept: the queries whose `uses` touch `nodeId`, scanned from
 * `queries/` at read time (zero back-links stored anywhere), id-ascending
 * for a deterministic order, capped at {@link VERIFIED_QUERIES_CAP}. An
 * absent or empty `queries/` dir yields `[]` — the caller keeps the
 * `verified_queries` key absent so the response stays byte-identical
 * (零税).
 * @param root - the corpus root.
 * @param nodeId - the canonical node id (`table:<名>` / `concept:<名>`).
 * @returns `{id, question}` rows, ≤5.
 */
export function verifiedQueriesForNode(
  root: string,
  nodeId: string,
): ReadonlyArray<{ readonly id: string; readonly question: string }> {
  const out: Array<{ readonly id: string; readonly question: string }> = []
  for (const def of loadQueryDefinitions(root)) {
    if (!queryTouchesNode(def.uses, nodeId)) continue
    out.push({ id: `query:${def.name}`, question: def.question })
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out.slice(0, VERIFIED_QUERIES_CAP)
}

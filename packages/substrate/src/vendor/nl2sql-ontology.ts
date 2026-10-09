/**
 * P3 ontology integration helpers. Pure functions over a STRUCTURAL
 * `RelationGraphLike` (the semantic-layer `RelationGraph` satisfies it — no
 * runtime dep, mirroring the EventDefinitionLite/SchemaCorpusSource decoupling
 * discipline). C1 join-path injection, C2 declared-join pairs, C3 graph recall.
 *
 * @module @deepseek-ai/dsh-nl2sql-engine/src/ontology
 */

import type { RetrievalHit } from './nl2sql-bm25-linking.ts'

/** Structural edge (matches semantic-layer RelationEdge). */
export interface RelationGraphEdge {
  readonly targetId: string
  readonly type: string
  readonly on?: string
  readonly description?: string
}

/** Structural graph seam (matches semantic-layer RelationGraph). */
export interface RelationGraphLike {
  findJoinPath(sourceId: string, targetId: string): string[] | null
  getJoinCondition(sourceId: string, targetId: string): string | null
  getRelated(sourceId: string, type?: string): readonly RelationGraphEdge[]
  getDerived(sourceId: string): readonly RelationGraphEdge[]
}

/**
 * Build hard-constraint JOIN lines for every candidate pair the graph has a
 * join path for (C1). For a path A→…→B, each adjacent pair becomes
 * `A JOIN B ON <condition>` joined into one chain line per candidate pair.
 * @param candidateIds - the BM25 candidate data-source ids.
 * @param graph - the live relation graph.
 * @returns prompt constraint strings (e.g. `dws_pay JOIN dim_server ON server_id = server_id`).
 */
export function buildJoinConstraints(candidateIds: readonly string[], graph: RelationGraphLike): string[] {
  const out: string[] = []
  for (let i = 0; i < candidateIds.length; i++) {
    const a = candidateIds[i]
    if (a === undefined) continue
    for (let j = i + 1; j < candidateIds.length; j++) {
      const b = candidateIds[j]
      if (b === undefined) continue
      const path = graph.findJoinPath(a, b)
      if (path === null || path.length < 2) continue
      const segs: string[] = []
      for (let k = 0; k < path.length - 1; k++) {
        const src = path[k]
        const dst = path[k + 1]
        if (src === undefined || dst === undefined) continue
        const on = graph.getJoinCondition(src, dst)
        if (on) segs.push(`${src} JOIN ${dst} ON ${on}`)
      }
      if (segs.length > 0) out.push(segs.join(' ⟶ '))
    }
  }
  return out
}

/**
 * Build the set of declared JOIN pairs (C2 critic guard). A pair is "declared"
 * when the graph has a direct joins edge OR a join path between the two ids.
 * Pairs are normalized `a|b` (lowercased, sorted). The critic warns on any SQL
 * JOIN pair absent from this set (possible hallucination) — a warning, not an
 * error (does not block execution).
 * @param candidateIds - the BM25 candidate data-source ids.
 * @param graph - the live relation graph.
 * @returns the normalized declared-join pair set.
 */
export function buildDeclaredJoinPairs(candidateIds: readonly string[], graph: RelationGraphLike): Set<string> {
  const pairs = new Set<string>()
  const norm = (a: string, b: string) => [a.toLowerCase(), b.toLowerCase()].sort().join('|')
  for (const c of candidateIds) {
    for (const e of graph.getRelated(c, 'joins')) pairs.add(norm(c, e.targetId))
  }
  for (let i = 0; i < candidateIds.length; i++) {
    for (let j = i + 1; j < candidateIds.length; j++) {
      const a = candidateIds[i]
      const b = candidateIds[j]
      if (a === undefined || b === undefined) continue
      if (graph.findJoinPath(a, b) !== null) pairs.add(norm(a, b))
    }
  }
  return pairs
}

/**
 * Graph-enhanced recall (C3): for each BM25 hit, add 1-hop `joins` neighbors
 * (DIM tables) and `derived_from` targets (a metric's source table, or vice
 * versa) not already in the hit set. When `lookupDoc` is provided, expanded
 * hits carry the looked-up payload; otherwise payload is undefined (the prompt
 * renders the id when `payload?.description` is absent). Depth = 1 hop to
 * avoid noise. Capped at `topK`.
 * @param hits - the BM25 retrieval hits.
 * @param graph - the live relation graph.
 * @param topK - max candidates to return.
 * @param lookupDoc - optional payload lookup for graph-expanded neighbors.
 * @returns the expanded candidate list (original hits first, then graph neighbors).
 */
export function expandCandidates(
  hits: readonly RetrievalHit[],
  graph: RelationGraphLike,
  topK: number,
  lookupDoc?: (id: string) => import('./nl2sql-bm25-linking.ts').DataSourceDoc | undefined,
): readonly RetrievalHit[] {
  const seen = new Set(hits.map(h => h.id))
  const out: RetrievalHit[] = [...hits]
  for (const h of hits) {
    for (const e of graph.getRelated(h.id, 'joins')) {
      if (seen.has(e.targetId)) continue
      seen.add(e.targetId)
      out.push({ id: e.targetId, score: h.score * 0.5, payload: lookupDoc?.(e.targetId), mode: 'graph-expand' })
    }
    for (const e of graph.getDerived(h.id)) {
      if (seen.has(e.targetId)) continue
      seen.add(e.targetId)
      out.push({ id: e.targetId, score: h.score * 0.5, payload: lookupDoc?.(e.targetId), mode: 'graph-expand' })
    }
    // CL-2 D3: expand related_to edges only for concept-prefixed nodes
    if (h.id.startsWith('concept:')) {
      for (const e of graph.getRelated(h.id, 'related_to')) {
        if (seen.has(e.targetId)) continue
        seen.add(e.targetId)
        out.push({ id: e.targetId, score: h.score * 0.5, payload: lookupDoc?.(e.targetId), mode: 'graph-expand' })
      }
    }
  }
  return out.slice(0, topK)
}

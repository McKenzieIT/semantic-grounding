/**
 * In-memory relation graph — adjacency list over DataSource definitions.
 * G2 aligned: three relation types (joins/derived_from/related_to),
 * BFS join-path discovery, getDerived for lineage traversal.
 * CL-1 Phase 2: alias index for SKOS pref_label/alt_labels resolution.
 *
 * @module @deepseek-ai/dsh-semantic-layer/src/relation-graph
 */
import type { RelationDef } from './registry.ts'

/** An edge in the relation graph (stored in adjacency list per node). */
export interface RelationEdge {
  readonly targetId: string
  /** Open relation kind (W27: `joins` | `derived_from` | `related_to` or a kind-declared type). */
  readonly type: string
  readonly on?: string
  readonly description?: string
}

/** Alias data for a single node (pref_label + alt_labels from the definition). */
export interface NodeAliasData {
  readonly nodeId: string
  readonly prefLabel?: string | undefined
  readonly altLabels?: readonly string[] | undefined
}

/**
 * In-memory relation graph. Builds a bidirectional adjacency list from
 * RelationDef entries (plugin.relations() output + source id).
 * CL-1 Phase 2: also builds a reverse alias index from SKOS labels.
 */
export class RelationGraph {
  private adj = new Map<string, RelationEdge[]>()
  private aliasIndex = new Map<string, string[]>()
  private nodeAliases = new Map<string, string[]>()

  /**
   * Build the graph from source-tagged relation declarations and optional alias data.
   * Clears existing state. Stores bidirectional edges for traversal.
   * When aliasData is provided, builds the reverse alias index (normalized_alias → nodeIds).
   * @param entries - entries
   * @param aliasData - aliasData
   */
  build(entries: { sourceId: string; relations: RelationDef[] }[], aliasData?: readonly NodeAliasData[]): void {
    this.adj.clear()
    this.aliasIndex.clear()
    this.nodeAliases.clear()
    for (const { sourceId, relations } of entries) {
      for (const rel of relations) {
        this.addEdge(sourceId, {
          targetId: rel.target,
          type: rel.type,
          ...(rel.on ? { on: rel.on } : {}),
          ...(rel.description ? { description: rel.description } : {}),
        })
        this.addEdge(rel.target, {
          targetId: sourceId,
          type: rel.type,
          ...(rel.on ? { on: rel.on } : {}),
          ...(rel.description ? { description: rel.description } : {}),
        })
      }
    }
    if (aliasData) {
      for (const { nodeId, prefLabel, altLabels } of aliasData) {
        const labels: string[] = []
        if (prefLabel) labels.push(prefLabel)
        if (altLabels) labels.push(...altLabels)
        if (labels.length === 0) continue
        this.nodeAliases.set(nodeId, labels)
        for (const label of labels) {
          const key = normalizeAlias(label)
          if (!key) continue
          const list = this.aliasIndex.get(key)
          if (list) {
            if (!list.includes(nodeId)) list.push(nodeId)
          } else {
            this.aliasIndex.set(key, [nodeId])
          }
        }
      }
    }
  }

  private addEdge(source: string, edge: RelationEdge): void {
    const list = this.adj.get(source)
    if (list) {
      list.push(edge)
    } else {
      this.adj.set(source, [edge])
    }
  }

  /**
   * BFS shortest path over 'joins'-type edges only.
   * Returns the node-id path [source, ..., target] or null if unreachable.
   * @param sourceId - sourceId
   * @param targetId - targetId
   * @returns the result
   */
  findJoinPath(sourceId: string, targetId: string): string[] | null {
    if (sourceId === targetId) return [sourceId]
    if (!this.adj.has(sourceId)) return null

    const visited = new Set<string>([sourceId])
    const queue: { node: string; path: string[] }[] = [{ node: sourceId, path: [sourceId] }]

    while (queue.length > 0) {
      const next = queue.shift()
      if (next === undefined) break
      const { node, path } = next
      const edges = this.adj.get(node)
      if (!edges) continue
      for (const edge of edges) {
        if (edge.type !== 'joins') continue
        if (visited.has(edge.targetId)) continue
        const newPath = [...path, edge.targetId]
        if (edge.targetId === targetId) return newPath
        visited.add(edge.targetId)
        queue.push({ node: edge.targetId, path: newPath })
      }
    }
    return null
  }

  /**
   * Get directly related node ids (optionally filtered by relation type).
   * @param sourceId - sourceId
   * @param type - open relation kind to filter by (e.g. `joins`); omit for all.
   * @returns the result
   */
  getRelated(sourceId: string, type?: string): RelationEdge[] {
    const edges = this.adj.get(sourceId)
    if (!edges) return []
    if (type === undefined) return [...edges]
    return edges.filter(e => e.type === type)
  }

  /**
   * Get the join condition between two directly connected nodes, or null.
   * @param sourceId - sourceId
   * @param targetId - targetId
   * @returns the result
   */
  getJoinCondition(sourceId: string, targetId: string): string | null {
    const edges = this.adj.get(sourceId)
    if (!edges) return null
    const edge = edges.find(e => e.targetId === targetId && e.on)
    return edge?.on ?? null
  }

  /**
   * Get the derived-from chain: all nodes reachable via 'derived_from' edges
   * from the given source (G2 lineage traversal).
   * @param sourceId - sourceId
   * @returns the result
   */
  getDerived(sourceId: string): RelationEdge[] {
    const edges = this.adj.get(sourceId)
    if (!edges) return []
    return edges.filter(e => e.type === 'derived_from')
  }

  /**
   * Resolve a term to node ids via the alias index. Normalizes the input
   * and looks up the reverse index (normalized_alias → nodeIds).
   * Returns an empty array when no match is found.
   * @param term - term
   * @returns the result
   */
  resolveAlias(term: string): string[] {
    const key = normalizeAlias(term)
    if (!key) return []
    return this.aliasIndex.get(key) ?? []
  }

  /**
   * Get all aliases (pref_label + alt_labels) registered for a node.
   * Returns an empty array when the node has no aliases.
   * @param nodeId - nodeId
   * @returns the result
   */
  getAliases(nodeId: string): string[] {
    return this.nodeAliases.get(nodeId) ?? []
  }
}

/**
 * Normalize an alias for index lookup: lowercase + trim whitespace.
 * Returns empty string for blank inputs (caller skips).
 */
function normalizeAlias(label: string): string {
  return label.toLowerCase().trim()
}

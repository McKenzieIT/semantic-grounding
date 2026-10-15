/**
 * Query kind plugin — wraps QueryDefinition (the verified query, ADR-0025 R1)
 * into the DataSourceKindPlugin interface. A query is a graph node
 * (`query:<名>`, ADR-0023 R4's unified id scheme) so the memory layer's
 * anchoring and read-surface mounting apply to it unchanged, but it declares
 * NO relations: its `uses` are forward anchors into the fact layer (existence
 * is checked at write time by memory.ts's anchor machinery), not graph edges
 * — a query must never surface as a join path or a `get_relations` row.
 *
 * The search corpus indexes the question, the 同问异说 (`alt_questions`) and
 * the description — never the SQL text (ADR-0025 R6①; ADR-0022 R3's "SQL
 * 原文永不进索引" half, kept even though R2 now lets the SQL itself into the
 * fact layer as this kind's body). `resolve_alias` never returns a query:
 * the alias index reads `pref_label`/`alt_labels`, which this shape has
 * neither of, so `alt_questions` reach search only.
 *
 * @module kinds/query-kind (internal; only `"."` is importable — see ADR-0002)
 */
import { QueryDefinitionSchema, type QueryDefinition } from '../types.ts'
import type { DataSourceKindPlugin, RelationDef, CorpusItem, GraphNodeProjection } from '../registry.ts'

const QUERY_PREFIX = 'query:'

/** queryKindPlugin */
export const queryKindPlugin: DataSourceKindPlugin<QueryDefinition> = {
  kind: 'query',
  schema: QueryDefinitionSchema,
  storageDir: 'queries',

  getId(raw) {
    return typeof raw.name === 'string' && raw.name !== '' ? `${QUERY_PREFIX}${raw.name}` : undefined
  },

  toCorpusItem(def): CorpusItem | null {
    const parts: string[] = [def.name, def.question]
    for (const s of def.alt_questions) parts.push(s)
    if (def.description) parts.push(def.description)
    return {
      id: `${QUERY_PREFIX}${def.name}`,
      description: parts.join(' '),
    }
  },

  // Deliberately empty (see the module doc): `uses` are anchors, not edges —
  // a query contributes no adjacency to the relation graph.
  relations(_def): RelationDef[] {
    return []
  },

  toGraphNode(def): GraphNodeProjection {
    // No `domains`: a query joins no concept group, so the graph build derives
    // no membership edges for it either.
    return { id: `${QUERY_PREFIX}${def.name}`, kind: 'query', label: def.question, domains: [] }
  },
}

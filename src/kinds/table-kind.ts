/**
 * Table kind plugin — wraps TableDefinition into the DataSourceKindPlugin interface.
 * G1 §D2/D3 aligned: schema field, raw-based getId, CriticFields with partitionCols,
 * relations with G2 types.
 *
 * @module @deepseek-ai/dsh-semantic-layer/src/kinds/table-kind
 */
import { TableDefinitionSchema, type TableDefinition } from '../types.ts'
import type { DataSourceKindPlugin, RelationDef, CriticFields, CorpusItem, GraphNodeProjection } from '../registry.ts'
import { deriveMetricRelations, extractMetricsFromTable, metricGraphNode, projectMetricCorpusItem } from '../metrics.ts'
/** tableKindPlugin */
export const tableKindPlugin: DataSourceKindPlugin<TableDefinition> = {
  kind: 'table',
  schema: TableDefinitionSchema,
  storageDir: 'tables',

  // A table's inline `metrics:` block derives one virtual `metric` node each.
  derivedNodes: {
    derive: extractMetricsFromTable,
    toGraphNode: metricGraphNode,
    relations: deriveMetricRelations,
    toCorpusItem: projectMetricCorpusItem,
  },

  getId(raw) {
    return typeof raw.table_name === 'string' ? raw.table_name : undefined
  },

  toCorpusItem(def): CorpusItem | null {
    const parts: string[] = []
    parts.push(def.table_name)
    if (def.description) parts.push(def.description)
    if (def.table_comment) parts.push(def.table_comment)
    for (const col of def.columns) {
      parts.push(col.name)
      if (col.comment) parts.push(col.comment)
    }
    for (const s of def.alt_labels) parts.push(s)
    return {
      id: def.table_name,
      ...(parts.length > 0 ? { description: parts.join(' ') } : {}),
      payload: def,
    }
  },

  toPromptContext(def): string {
    const lines: string[] = []
    lines.push(`Table: ${def.table_name}`)
    if (def.table_comment) lines.push(`Comment: ${def.table_comment}`)
    if (def.description) lines.push(`Description: ${def.description}`)
    lines.push(`Kind: ${def.kind}`)
    lines.push(`Engine: ${def.engine}`)
    if (def.granularity) lines.push(`Granularity: ${def.granularity}`)
    if (def.domains.length > 0) lines.push(`Domains: ${def.domains.join(', ')}`)
    if (def.columns.length > 0) {
      lines.push('')
      lines.push('Columns:')
      lines.push('| Name | Type | Comment | Role |')
      lines.push('|------|------|---------|------|')
      for (const col of def.columns) {
        lines.push(`| ${col.name} | ${col.type || '-'} | ${col.comment || '-'} | ${col.role || '-'} |`)
      }
    }
    if (def.partitions.length > 0) {
      lines.push('')
      lines.push('Partitions:')
      for (const p of def.partitions) {
        lines.push(`  - ${p.name} (${p.type || 'string'})`)
      }
    }
    return lines.join('\n')
  },

  toCriticContext(def): CriticFields {
    return {
      partitionCols: def.partitions.map(p => p.name),
    }
  },

  toGraphNode(def): GraphNodeProjection {
    // A table's graph kind is its storage kind (`dws`/`dim`/…), carried open so
    // a new table kind needs no gateway change.
    return { id: def.table_name, kind: def.kind, label: def.table_name, domains: [...def.domains] }
  },

  relations(def): RelationDef[] {
    if (def.dimension_refs.length === 0) return []
    const out: RelationDef[] = []
    for (const ref of def.dimension_refs) {
      const byDimCol = new Map<string, { dws_column: string; dim_column: string }[]>()
      for (const k of ref.join_keys) {
        const group = byDimCol.get(k.dim_column) ?? []
        group.push(k)
        byDimCol.set(k.dim_column, group)
      }
      const hasAlternatives = [...byDimCol.values()].some(g => g.length > 1)
      if (!hasAlternatives) {
        out.push({
          type: 'joins' as const,
          target: ref.dim_table,
          on: ref.join_keys.map(k => `${k.dws_column} = ${k.dim_column}`).join(' AND '),
          ...(ref.derivation ? { description: ref.derivation } : {}),
        })
      } else {
        // Alternative FKs: each dws_column that maps to the same dim_column is
        // an independent join path. Group by composite key (all non-alternative
        // dim_columns) + one alternative at a time.
        const compositeKeys = [...byDimCol.entries()]
          .filter(([, g]) => g.length === 1)
          .map(([, g]) => {
            const k = g[0]
            return k ?? null
          })
          .filter((k): k is { dws_column: string; dim_column: string } => k !== null)
        const alternativeGroups = [...byDimCol.entries()]
          .filter(([, g]) => g.length > 1)
          .map(([, g]) => g)
        // Cartesian product across all alternative dim_columns: each emitted
        // join combines the composite keys with ONE alternative from EVERY
        // alternative group. A per-group loop would emit single-group edges
        // that omit the other alternative dim_columns (sl-5).
        let combos: { dws_column: string; dim_column: string }[][] = [compositeKeys]
        for (const group of alternativeGroups) {
          combos = combos.flatMap(combo => group.map(alt => [...combo, alt]))
        }
        for (const combo of combos) {
          out.push({
            type: 'joins' as const,
            target: ref.dim_table,
            on: combo.map(k => `${k.dws_column} = ${k.dim_column}`).join(' AND '),
            ...(ref.derivation ? { description: ref.derivation } : {}),
          })
        }
      }
    }
    return out
  },
}

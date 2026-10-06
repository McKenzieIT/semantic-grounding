/**
 * Concept kind plugin — wraps ConceptDefinition into the DataSourceKindPlugin interface.
 * CL-2: concepts are first-class graph nodes representing semantic domains.
 * Edges are derived from asset.domains (not declared by the concept itself).
 *
 * @module @deepseek-ai/dsh-semantic-layer/src/kinds/concept-kind
 */
import { ConceptDefinitionSchema, type ConceptDefinition } from '../types.ts'
import type { DataSourceKindPlugin, RelationDef, CorpusItem, GraphNodeProjection } from '../registry.ts'

const CONCEPT_PREFIX = 'concept:'

/** conceptKindPlugin */
export const conceptKindPlugin: DataSourceKindPlugin<ConceptDefinition> = {
  kind: 'concept',
  schema: ConceptDefinitionSchema,
  storageDir: 'concepts',

  // Concepts are the taxonomy: an asset joins a concept by naming it in its
  // own `domains`, and the graph build derives the related_to edge from that.
  grouping: {
    groupName: node => (node.id.startsWith(CONCEPT_PREFIX) ? node.id.slice(CONCEPT_PREFIX.length) : node.id),
    memberRelationType: 'related_to',
  },

  getId(raw) {
    return typeof raw.name === 'string' ? `concept:${raw.name}` : undefined
  },

  toCorpusItem(def): CorpusItem | null {
    const parts: string[] = [def.name]
    if (def.description) parts.push(def.description)
    if (def.pref_label) parts.push(def.pref_label)
    for (const s of def.alt_labels) parts.push(s)
    return {
      id: `concept:${def.name}`,
      description: parts.join(' '),
    }
  },

  toPromptContext(def): string {
    const lines: string[] = []
    lines.push(`Concept: ${def.name}`)
    if (def.description) lines.push(`Description: ${def.description}`)
    if (def.pref_label) lines.push(`Preferred Label: ${def.pref_label}`)
    if (def.alt_labels.length > 0) {
      lines.push(`Aliases: ${def.alt_labels.join(', ')}`)
    }
    return lines.join('\n')
  },

  relations(_def): RelationDef[] {
    return []
  },

  toGraphNode(def): GraphNodeProjection {
    // A concept is a first-class node id-prefixed `concept:` to keep it
    // distinct from an asset of the same name. It groups under its own name so
    // its `related_to` edges (derived from asset.domains) survive a domain
    // filter that scopes to that domain.
    return { id: `concept:${def.name}`, kind: 'concept', label: def.pref_label ?? def.name, domains: [def.name] }
  },
}

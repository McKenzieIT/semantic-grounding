/**
 * Concept kind plugin — wraps ConceptDefinition into the DataSourceKindPlugin interface.
 * CL-2: concepts are first-class graph nodes representing semantic domains.
 * Edges are derived from asset.domains (not declared by the concept itself).
 *
 * @module kinds/concept-kind (internal; only `"."` is importable — see ADR-0002)
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
    // Q4(b): free-form entity attributes join the indexed text — both their
    // keys and their primitive values, so a game term living only inside
    // `properties` (say an item's `rarity: 传说`) is still searchable. Objects
    // and arrays contribute nothing (a JSON blob in the index is noise, not
    // recall); nested terms belong in alt_labels or their own concept.
    for (const [key, value] of Object.entries(def.properties ?? {})) {
      parts.push(key)
      if (typeof value === 'string' && value !== '') parts.push(value)
      else if (typeof value === 'number' || typeof value === 'boolean') parts.push(String(value))
    }
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
    const props = Object.entries(def.properties ?? {})
    if (props.length > 0) {
      lines.push(`Properties: ${props.map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`).join(', ')}`)
    }
    return lines.join('\n')
  },

  // Q4(b) Update: concepts are the entity layer, not just the taxonomy — a
  // concept's own `related_refs` are declared entity-graph edges (concept→
  // concept, concept→table), projected as `related_to` with no join
  // condition. Asset-derived membership edges (asset.domains → this concept)
  // keep flowing through `grouping` below; the two sources can both produce a
  // related_to edge to the same node, which is redundant adjacency, not a
  // conflict — both claims are curated and the graph takes unions.
  relations(def): RelationDef[] {
    if (def.related_refs.length === 0) return []
    const out: RelationDef[] = []
    for (const ref of def.related_refs) {
      out.push({
        type: 'related_to' as const,
        target: ref.target_kind === 'concept' ? `concept:${ref.target}` : ref.target,
        ...(ref.derivation ? { description: ref.derivation } : {}),
      })
    }
    return out
  },

  toGraphNode(def): GraphNodeProjection {
    // A concept is a first-class node id-prefixed `concept:` to keep it
    // distinct from an asset of the same name. It groups under its own name so
    // its `related_to` edges (derived from asset.domains) survive a domain
    // filter that scopes to that domain.
    return { id: `concept:${def.name}`, kind: 'concept', label: def.pref_label ?? def.name, domains: [def.name] }
  },
}

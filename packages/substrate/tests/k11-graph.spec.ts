/**
 * K11 RelationGraph verification (B6) — builds the in-memory graph from the
 * REAL K11 dimension_refs (table-kind -> joins edges) + the extracted metrics
 * (metric-kind -> derived_from edges), asserting the graph carries both
 * relation types + reachable join paths. Runs after enrichment writes refs.
 *
 * Run: `npx vitest run packages/data/semantic-layer/tests/k11-graph.spec.ts`
 */
import { test, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RelationGraph } from '../src/relation-graph.ts'
import { tableKindPlugin } from '../src/kinds/table-kind.ts'
import { TableDefinitionSchema, type TableDefinition } from '../src/types.ts'
import { loadTables } from '../src/io.ts'
import { loadMetricDefinitions, deriveMetricRelations } from '../src/metrics.ts'
import type { RelationDef } from '../src/registry.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SEED = join(HERE, './fixtures/k11')

interface Entry { sourceId: string; relations: RelationDef[] }

function tableEntries(): Entry[] {
  return loadTables(SEED)
    .map(t => TableDefinitionSchema.safeParse(t.raw))
    .filter((r): r is { success: true; data: TableDefinition } => r.success)
    .map(r => ({ sourceId: r.data.table_name, relations: tableKindPlugin.relations(r.data) }))
}

function metricEntries(): Entry[] {
  return loadMetricDefinitions(SEED).map(m => ({ sourceId: m.name, relations: deriveMetricRelations(m) }))
}

test('K11 graph carries joins edges from DWS dimension_refs', () => {
  const entries = tableEntries()
  const g = new RelationGraph()
  g.build(entries)
  const joinEdges = entries.flatMap(e => e.relations.filter(r => r.type === 'joins'))
  expect(joinEdges.length).toBeGreaterThan(0)
})

test('K11 graph carries derived_from edges from extracted metrics', () => {
  const entries = metricEntries()
  const g = new RelationGraph()
  g.build(entries)
  const derived = entries.flatMap(e => e.relations.filter(r => r.type === 'derived_from'))
  expect(derived.length).toBeGreaterThan(0)
})

test('K11 graph: a DWS with dimension_refs reaches its DIM via findJoinPath', () => {
  const entries = tableEntries()
  const g = new RelationGraph()
  g.build(entries)
  const withRefs = entries.filter(e => e.relations.some(r => r.type === 'joins'))
  expect(withRefs.length).toBeGreaterThan(0)
  const sample = withRefs[0]!
  const related = g.getRelated(sample.sourceId, 'joins')
  expect(related.length).toBeGreaterThan(0)
  const dimTarget = related[0]!.targetId
  expect(g.findJoinPath(sample.sourceId, dimTarget)).not.toBeNull()
})

test('K11 graph: combined tables+metrics build with both relation types', () => {
  const g = new RelationGraph()
  g.build([...tableEntries(), ...metricEntries()])
  // spot-check a metric -> its source table (derived_from)
  const metrics = metricEntries()
  const sampleMetric = metrics.find(m => m.relations.some(r => r.type === 'derived_from'))
  expect(sampleMetric).toBeDefined()
  const derived = g.getDerived(sampleMetric!.sourceId)
  expect(derived.length).toBeGreaterThan(0)
})

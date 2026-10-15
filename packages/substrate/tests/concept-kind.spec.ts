/**
 * CL-2 concept-kind unit tests — ConceptDefinitionSchema, ConceptKindPlugin,
 * loadConcepts, graph builder concept→asset edges, domain reference validation,
 * and expandCandidates related_to expansion for concept: nodes.
 */
import { test, expect } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { ConceptDefinitionSchema } from '../src/types.ts'
import { conceptKindPlugin } from '../src/kinds/concept-kind.ts'
import { loadConcepts, loadConceptDefinition } from '../src/io.ts'
import { RelationGraph, type NodeAliasData } from '../src/relation-graph.ts'
import type { RelationDef } from '../src/registry.ts'

// ── ConceptDefinitionSchema ─────────────────────────────────────────────

test('ConceptDefinitionSchema — parses minimal concept', () => {
  const raw = { name: '付费经济' }
  const result = ConceptDefinitionSchema.parse(raw)
  expect(result.name).toBe('付费经济')
  expect(result.description).toBe('')
  expect(result.pref_label).toBeUndefined()
  expect(result.alt_labels).toEqual([])
})

test('ConceptDefinitionSchema — parses full concept with all fields', () => {
  const raw = {
    name: '用户生命周期',
    description: '注册、登录、活跃、留存相关',
    pref_label: '生命周期',
    alt_labels: ['lifecycle', 'LTV'],
  }
  const result = ConceptDefinitionSchema.parse(raw)
  expect(result.name).toBe('用户生命周期')
  expect(result.description).toBe('注册、登录、活跃、留存相关')
  expect(result.pref_label).toBe('生命周期')
  expect(result.alt_labels).toEqual(['lifecycle', 'LTV'])
})

test('ConceptDefinitionSchema — passthrough preserves extra fields', () => {
  const raw = { name: 'test', custom_field: 42 }
  const result = ConceptDefinitionSchema.parse(raw)
  expect((result as Record<string, unknown>).custom_field).toBe(42)
})

// ── ConceptKindPlugin ───────────────────────────────────────────────────

test('conceptKindPlugin — kind/storageDir', () => {
  expect(conceptKindPlugin.kind).toBe('concept')
  expect(conceptKindPlugin.storageDir).toBe('concepts')
})

test('conceptKindPlugin — getId returns concept:-prefixed id', () => {
  expect(conceptKindPlugin.getId({ name: '付费经济' })).toBe('concept:付费经济')
  expect(conceptKindPlugin.getId({ table_name: 'foo' })).toBeUndefined()
  expect(conceptKindPlugin.getId({})).toBeUndefined()
})

test('conceptKindPlugin — toCorpusItem produces searchable description', () => {
  const def = ConceptDefinitionSchema.parse({
    name: '付费经济',
    description: '充值、消费、商城购买',
    pref_label: '付费',
    alt_labels: ['payment', 'monetization'],
  })
  const item = conceptKindPlugin.toCorpusItem(def)
  expect(item).not.toBeNull()
  expect(item!.id).toBe('concept:付费经济')
  expect(item!.description).toContain('付费经济')
  expect(item!.description).toContain('充值、消费、商城购买')
  expect(item!.description).toContain('付费')
  expect(item!.description).toContain('payment')
  expect(item!.description).toContain('monetization')
})

test('conceptKindPlugin — relations returns empty array when related_refs is empty', () => {
  const def = ConceptDefinitionSchema.parse({ name: 'test' })
  expect(conceptKindPlugin.relations(def)).toEqual([])
})

// ── Q4(b): properties ────────────────────────────────────────────────────

test('ConceptDefinitionSchema — properties defaults to {} and accepts free-form data', () => {
  const bare = ConceptDefinitionSchema.parse({ name: 'test' })
  expect(bare.properties).toEqual({})
  const withProps = ConceptDefinitionSchema.parse({
    name: '装备',
    properties: { rarity: '传说', level_cap: 60, tradeable: false, nested: { a: 1 } },
  })
  expect(withProps.properties).toEqual({ rarity: '传说', level_cap: 60, tradeable: false, nested: { a: 1 } })
})

test('conceptKindPlugin — toCorpusItem indexes properties keys and primitive values', () => {
  const def = ConceptDefinitionSchema.parse({
    name: '装备',
    properties: { rarity: '传说', level_cap: 60, tradeable: false },
  })
  const item = conceptKindPlugin.toCorpusItem(def)
  expect(item!.description).toContain('rarity')
  expect(item!.description).toContain('传说')
  expect(item!.description).toContain('level_cap')
  expect(item!.description).toContain('60')
  expect(item!.description).toContain('tradeable')
  expect(item!.description).toContain('false')
})

test('conceptKindPlugin — toCorpusItem excludes object/array property values as index noise (keys still indexed)', () => {
  const def = ConceptDefinitionSchema.parse({
    name: '装备',
    properties: { tags: ['pvp', 'raid'], meta: { source: 'design-doc' }, rarity: '传说' },
  })
  const item = conceptKindPlugin.toCorpusItem(def)
  expect(item!.description).toContain('tags')
  expect(item!.description).toContain('meta')
  expect(item!.description).not.toContain('pvp')
  expect(item!.description).not.toContain('raid')
  expect(item!.description).not.toContain('design-doc')
})

test('conceptKindPlugin — toCorpusItem skips an empty-string property value', () => {
  const def = ConceptDefinitionSchema.parse({ name: '装备', properties: { note: '' } })
  const item = conceptKindPlugin.toCorpusItem(def)
  // The key is still indexed; only the empty value contributes nothing extra.
  expect(item!.description).toContain('note')
})

// ── Q4(b): relations() projects declared related_refs ──────────────────────

test('conceptKindPlugin — relations projects a concept→concept related_ref with the concept: prefix', () => {
  const def = ConceptDefinitionSchema.parse({
    name: '付费经济',
    related_refs: [{ target_kind: 'concept', target: '用户生命周期' }],
  })
  expect(conceptKindPlugin.relations(def)).toEqual([
    { type: 'related_to', target: 'concept:用户生命周期' },
  ])
})

test('conceptKindPlugin — relations projects a concept→table related_ref with a table:-prefixed target', () => {
  const def = ConceptDefinitionSchema.parse({
    name: '付费经济',
    related_refs: [{ target_kind: 'table', target: 'dws_pay' }],
  })
  expect(conceptKindPlugin.relations(def)).toEqual([
    { type: 'related_to', target: 'table:dws_pay' },
  ])
})

test('conceptKindPlugin — relations carries derivation through as description when present', () => {
  const def = ConceptDefinitionSchema.parse({
    name: '付费经济',
    related_refs: [{ target_kind: 'concept', target: '用户生命周期', derivation: '付费转化率依赖生命周期阶段' }],
  })
  expect(conceptKindPlugin.relations(def)).toEqual([
    { type: 'related_to', target: 'concept:用户生命周期', description: '付费转化率依赖生命周期阶段' },
  ])
})

test('conceptKindPlugin — relations projects every declared edge in a multi-edge concept', () => {
  const def = ConceptDefinitionSchema.parse({
    name: '付费经济',
    related_refs: [
      { target_kind: 'concept', target: '用户生命周期' },
      { target_kind: 'table', target: 'dws_pay' },
    ],
  })
  expect(conceptKindPlugin.relations(def)).toEqual([
    { type: 'related_to', target: 'concept:用户生命周期' },
    { type: 'related_to', target: 'table:dws_pay' },
  ])
})

test('conceptKindPlugin — toGraphNode projects a concept:-prefixed node (W27)', () => {
  const def = ConceptDefinitionSchema.parse({ name: '付费经济', pref_label: '付费' })
  const node = conceptKindPlugin.toGraphNode(def)
  expect(node).toEqual({ id: 'concept:付费经济', kind: 'concept', label: '付费', domains: ['付费经济'] })
})

test('conceptKindPlugin — toGraphNode label falls back to name without pref_label', () => {
  const def = ConceptDefinitionSchema.parse({ name: '战斗关卡' })
  expect(conceptKindPlugin.toGraphNode(def)?.label).toBe('战斗关卡')
})

// ── loadConcepts / loadConceptDefinition ────────────────────────────────

function setupTmpLayer(): string {
  const dir = join(tmpdir(), `concept-test-${Date.now()}`)
  mkdirSync(join(dir, 'concepts'), { recursive: true })
  writeFileSync(join(dir, 'concepts', '付费经济.yaml'), yaml.dump({
    name: '付费经济',
    description: '充值消费',
    pref_label: '付费',
    alt_labels: ['pay'],
  }))
  writeFileSync(join(dir, 'concepts', '战斗关卡.yaml'), yaml.dump({
    name: '战斗关卡',
    description: '副本PVP',
  }))
  return dir
}

test('loadConcepts — scans concepts/ dir', () => {
  const dir = setupTmpLayer()
  try {
    const concepts = loadConcepts(dir)
    expect(concepts.length).toBe(2)
    expect(concepts.map(c => c.name).sort()).toEqual(['付费经济', '战斗关卡'])
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('loadConcepts — returns empty when no concepts/ dir', () => {
  const dir = join(tmpdir(), `concept-empty-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  try {
    expect(loadConcepts(dir)).toEqual([])
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('loadConceptDefinition — finds by name', () => {
  const dir = setupTmpLayer()
  try {
    const def = loadConceptDefinition(dir, '付费经济')
    expect(def).not.toBeNull()
    expect(def!.name).toBe('付费经济')
    expect(def!.description).toBe('充值消费')
    expect(def!.alt_labels).toEqual(['pay'])
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('loadConceptDefinition — returns null for unknown', () => {
  const dir = setupTmpLayer()
  try {
    expect(loadConceptDefinition(dir, 'nonexistent')).toBeNull()
  } finally {
    rmSync(dir, { recursive: true })
  }
})

// ── Graph builder: concept→asset related_to edges ───────────────────────

test('concept nodes produce related_to edges via asset.domains', () => {
  const g = new RelationGraph()
  const entries: { sourceId: string; relations: RelationDef[] }[] = [
    { sourceId: 'dws_pay', relations: [] },
    { sourceId: 'event.login', relations: [] },
    { sourceId: 'concept:付费经济', relations: [{ type: 'related_to', target: 'dws_pay' }] },
    { sourceId: 'concept:用户生命周期', relations: [{ type: 'related_to', target: 'event.login' }] },
  ]
  g.build(entries)
  const payRelated = g.getRelated('concept:付费经济', 'related_to')
  expect(payRelated).toHaveLength(1)
  expect(payRelated[0]!.targetId).toBe('dws_pay')
  // Bidirectional
  const dwsRelated = g.getRelated('dws_pay', 'related_to')
  expect(dwsRelated).toHaveLength(1)
  expect(dwsRelated[0]!.targetId).toBe('concept:付费经济')
})

test('concept aliases enter the aliasIndex', () => {
  const g = new RelationGraph()
  const aliasData: NodeAliasData[] = [
    { nodeId: 'concept:付费经济', prefLabel: '付费', altLabels: ['payment', 'monetization'] },
  ]
  g.build([{ sourceId: 'concept:付费经济', relations: [] }], aliasData)
  expect(g.resolveAlias('付费')).toEqual(['concept:付费经济'])
  expect(g.resolveAlias('payment')).toEqual(['concept:付费经济'])
  expect(g.resolveAlias('monetization')).toEqual(['concept:付费经济'])
})

// ── expandCandidates: related_to expansion for concept: nodes ───────────

test('expandCandidates expands related_to for concept:-prefixed hits', async () => {
  // Dynamically import ontology to verify integration
  const { expandCandidates } = await import('../src/vendor/nl2sql-ontology.ts')
  type RelationGraphEdge = { targetId: string; type: string; on?: string }
  type RelationGraphLike = Parameters<typeof expandCandidates>[1]

  const adj = new Map<string, RelationGraphEdge[]>()
  adj.set('concept:付费经济', [{ targetId: 'dws_pay_order_di', type: 'related_to' }])
  adj.set('dws_pay_order_di', [{ targetId: 'concept:付费经济', type: 'related_to' }])

  const graph: RelationGraphLike = {
    findJoinPath: () => null,
    getJoinCondition: () => null,
    getRelated: (id: string, type?: string) => {
      const all = adj.get(id) ?? []
      return type ? all.filter(e => e.type === type) : all
    },
    getDerived: () => [],
  }

  const hits = [{ id: 'concept:付费经济', score: 1.0, payload: undefined, mode: 'bm25' as const }]
  const expanded = expandCandidates(hits, graph, 10)
  expect(expanded.length).toBe(2)
  expect(expanded[1]!.id).toBe('dws_pay_order_di')
  expect(expanded[1]!.score).toBe(0.5)
  expect(expanded[1]!.mode).toBe('graph-expand')
})

test('expandCandidates does NOT expand related_to for non-concept nodes', async () => {
  const { expandCandidates } = await import('../src/vendor/nl2sql-ontology.ts')
  type RelationGraphEdge = { targetId: string; type: string; on?: string }
  type RelationGraphLike = Parameters<typeof expandCandidates>[1]

  const adj = new Map<string, RelationGraphEdge[]>()
  adj.set('dws_pay', [{ targetId: 'concept:付费经济', type: 'related_to' }])
  adj.set('concept:付费经济', [{ targetId: 'dws_pay', type: 'related_to' }])

  const graph: RelationGraphLike = {
    findJoinPath: () => null,
    getJoinCondition: () => null,
    getRelated: (id: string, type?: string) => {
      const all = adj.get(id) ?? []
      return type ? all.filter(e => e.type === type) : all
    },
    getDerived: () => [],
  }

  const hits = [{ id: 'dws_pay', score: 1.0, payload: undefined, mode: 'bm25' as const }]
  const expanded = expandCandidates(hits, graph, 10)
  // Should NOT expand related_to because dws_pay is not concept:-prefixed
  expect(expanded.length).toBe(1)
  expect(expanded[0]!.id).toBe('dws_pay')
})

// ── Domain reference validation ─────────────────────────────────────────

test('K11 seed concepts cover all domains used by assets', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))
  const k11Root = resolve(HERE, './fixtures/k11')
  const concepts = loadConcepts(k11Root)
  expect(concepts.length).toBe(10)
  const names = new Set(concepts.map(c => c.name))
  expect(names.has('付费经济')).toBe(true)
  expect(names.has('战斗关卡')).toBe(true)
  expect(names.has('探索收集')).toBe(true)
  expect(names.has('用户生命周期')).toBe(true)
  expect(names.has('社交公会')).toBe(true)
  expect(names.has('系统监控')).toBe(true)
  expect(names.has('自定义')).toBe(true)
  expect(names.has('装备道具')).toBe(true)
  expect(names.has('角色成长')).toBe(true)
  expect(names.has('资源产销')).toBe(true)
})

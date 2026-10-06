/**
 * P3-impl relation graph tests — G2 aligned: three relation types,
 * bidirectional edges, BFS join-path, getDerived.
 * CL-1 Phase 2: alias index tests (resolveAlias, getAliases).
 */
import { test, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RelationGraph } from '../src/relation-graph.ts'
import { SemanticLayerService } from '../src/index.ts'
import type { RelationDef } from '../src/registry.ts'
import type { NodeAliasData } from '../src/relation-graph.ts'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'

function makeEntries(...tuples: [string, RelationDef[]][]): { sourceId: string; relations: RelationDef[] }[] {
  return tuples.map(([sourceId, relations]) => ({ sourceId, relations }))
}

// ── Build ───────────────────────────────────────────────────────────────

test('build populates adjacency from entries', () => {
  const g = new RelationGraph()
  g.build(makeEntries(
    ['A', [{ type: 'joins', target: 'B', on: 'id = id' }]],
  ))
  expect(g.getRelated('A')).toHaveLength(1)
  expect(g.getRelated('A')[0]!.targetId).toBe('B')
})

test('build stores bidirectional edges', () => {
  const g = new RelationGraph()
  g.build(makeEntries(
    ['A', [{ type: 'joins', target: 'B', on: 'x = x' }]],
  ))
  expect(g.getRelated('B')).toHaveLength(1)
  expect(g.getRelated('B')[0]!.targetId).toBe('A')
})

test('build clears existing state on rebuild', () => {
  const g = new RelationGraph()
  g.build(makeEntries(['A', [{ type: 'joins', target: 'B' }]]))
  g.build(makeEntries(['C', [{ type: 'joins', target: 'D' }]]))
  expect(g.getRelated('A')).toHaveLength(0)
  expect(g.getRelated('C')).toHaveLength(1)
})

// ── findJoinPath ────────────────────────────────────────────────────────

test('findJoinPath — identity', () => {
  const g = new RelationGraph()
  g.build([])
  expect(g.findJoinPath('A', 'A')).toEqual(['A'])
})

test('findJoinPath — direct edge', () => {
  const g = new RelationGraph()
  g.build(makeEntries(['A', [{ type: 'joins', target: 'B', on: 'x = x' }]]))
  expect(g.findJoinPath('A', 'B')).toEqual(['A', 'B'])
})

test('findJoinPath — A→B→C chain', () => {
  const g = new RelationGraph()
  g.build(makeEntries(
    ['A', [{ type: 'joins', target: 'B', on: 'a = a' }]],
    ['B', [{ type: 'joins', target: 'C', on: 'b = b' }]],
  ))
  expect(g.findJoinPath('A', 'C')).toEqual(['A', 'B', 'C'])
})

test('findJoinPath — reverse traversal', () => {
  const g = new RelationGraph()
  g.build(makeEntries(['A', [{ type: 'joins', target: 'B' }]]))
  expect(g.findJoinPath('B', 'A')).toEqual(['B', 'A'])
})

test('findJoinPath — disconnected returns null', () => {
  const g = new RelationGraph()
  g.build(makeEntries(
    ['A', [{ type: 'joins', target: 'B' }]],
    ['C', [{ type: 'joins', target: 'D' }]],
  ))
  expect(g.findJoinPath('A', 'D')).toBeNull()
})

test('findJoinPath — unknown source returns null', () => {
  const g = new RelationGraph()
  g.build([])
  expect(g.findJoinPath('X', 'Y')).toBeNull()
})

test('findJoinPath — ignores derived_from edges', () => {
  const g = new RelationGraph()
  g.build(makeEntries(['A', [{ type: 'derived_from', target: 'B' }]]))
  expect(g.findJoinPath('A', 'B')).toBeNull()
})

test('findJoinPath — ignores related_to edges', () => {
  const g = new RelationGraph()
  g.build(makeEntries(['A', [{ type: 'related_to', target: 'B' }]]))
  expect(g.findJoinPath('A', 'B')).toBeNull()
})

test('findJoinPath — shortest path in diamond', () => {
  const g = new RelationGraph()
  g.build(makeEntries(
    ['A', [{ type: 'joins', target: 'B' }, { type: 'joins', target: 'C' }]],
    ['B', [{ type: 'joins', target: 'D' }]],
    ['C', [{ type: 'joins', target: 'D' }]],
  ))
  const path = g.findJoinPath('A', 'D')
  expect(path).not.toBeNull()
  expect(path!.length).toBe(3) // A→B→D or A→C→D
})

// ── getRelated ──────────────────────────────────────────────────────────

test('getRelated — unknown node returns empty', () => {
  const g = new RelationGraph()
  g.build([])
  expect(g.getRelated('X')).toEqual([])
})

test('getRelated — unfiltered returns all types', () => {
  const g = new RelationGraph()
  g.build(makeEntries(['A', [
    { type: 'joins', target: 'B' },
    { type: 'derived_from', target: 'C' },
    { type: 'related_to', target: 'D' },
  ]]))
  expect(g.getRelated('A')).toHaveLength(3)
})

test('getRelated — filtered by type', () => {
  const g = new RelationGraph()
  g.build(makeEntries(['A', [
    { type: 'joins', target: 'B' },
    { type: 'derived_from', target: 'C' },
    { type: 'related_to', target: 'D' },
  ]]))
  expect(g.getRelated('A', 'joins')).toHaveLength(1)
  expect(g.getRelated('A', 'derived_from')).toHaveLength(1)
  expect(g.getRelated('A', 'related_to')).toHaveLength(1)
})

// ── getJoinCondition ────────────────────────────────────────────────────

test('getJoinCondition — direct edge', () => {
  const g = new RelationGraph()
  g.build(makeEntries(['A', [{ type: 'joins', target: 'B', on: 'x = x' }]]))
  expect(g.getJoinCondition('A', 'B')).toBe('x = x')
})

test('getJoinCondition — reverse edge', () => {
  const g = new RelationGraph()
  g.build(makeEntries(['A', [{ type: 'joins', target: 'B', on: 'x = x' }]]))
  expect(g.getJoinCondition('B', 'A')).toBe('x = x')
})

test('getJoinCondition — unconnected returns null', () => {
  const g = new RelationGraph()
  g.build(makeEntries(['A', [{ type: 'joins', target: 'B', on: 'x = x' }]]))
  expect(g.getJoinCondition('A', 'C')).toBeNull()
})

test('getJoinCondition — no on field returns null', () => {
  const g = new RelationGraph()
  g.build(makeEntries(['A', [{ type: 'joins', target: 'B' }]]))
  expect(g.getJoinCondition('A', 'B')).toBeNull()
})

// ── getDerived (G2 lineage) ─────────────────────────────────────────────

test('getDerived — returns derived_from edges', () => {
  const g = new RelationGraph()
  g.build(makeEntries(['metric_dau', [
    { type: 'derived_from', target: 'ods_login', description: '基于登录' },
    { type: 'joins', target: 'dim_server' },
  ]]))
  const derived = g.getDerived('metric_dau')
  expect(derived).toHaveLength(1)
  expect(derived[0]).toBeDefined()
  expect(derived[0]!.targetId).toBe('ods_login')
  expect(derived[0]!.type).toBe('derived_from')
})

test('getDerived — returns empty for no derived_from edges', () => {
  const g = new RelationGraph()
  g.build(makeEntries(['A', [{ type: 'joins', target: 'B' }]]))
  expect(g.getDerived('A')).toEqual([])
})

test('getDerived — unknown node returns empty', () => {
  const g = new RelationGraph()
  g.build([])
  expect(g.getDerived('X')).toEqual([])
})

// ── resolveAlias (CL-1 Phase 2) ────────────────────────────────────────

test('resolveAlias — exact match on alt_labels', () => {
  const g = new RelationGraph()
  const aliases: NodeAliasData[] = [
    { nodeId: 'dws_active_user_di', altLabels: ['DAU', '日活跃用户'] },
    { nodeId: 'role.online', altLabels: ['DAU', '在线'] },
  ]
  g.build([], aliases)
  const result = g.resolveAlias('dau')
  expect(result).toContain('dws_active_user_di')
  expect(result).toContain('role.online')
  expect(result).toHaveLength(2)
})

test('resolveAlias — case insensitive', () => {
  const g = new RelationGraph()
  const aliases: NodeAliasData[] = [
    { nodeId: 'dws_pay_order_di', altLabels: ['ARPPU', 'arppu'] },
  ]
  g.build([], aliases)
  expect(g.resolveAlias('ARPPU')).toEqual(['dws_pay_order_di'])
  expect(g.resolveAlias('arppu')).toEqual(['dws_pay_order_di'])
  expect(g.resolveAlias('Arppu')).toEqual(['dws_pay_order_di'])
})

test('resolveAlias — matches pref_label', () => {
  const g = new RelationGraph()
  const aliases: NodeAliasData[] = [
    { nodeId: 'dws_pay_order_di', prefLabel: '付费订单宽表', altLabels: ['付费'] },
  ]
  g.build([], aliases)
  expect(g.resolveAlias('付费订单宽表')).toEqual(['dws_pay_order_di'])
})

test('resolveAlias — no match returns empty', () => {
  const g = new RelationGraph()
  const aliases: NodeAliasData[] = [
    { nodeId: 'dws_active_user_di', altLabels: ['DAU'] },
  ]
  g.build([], aliases)
  expect(g.resolveAlias('nonexistent')).toEqual([])
})

test('resolveAlias — empty term returns empty', () => {
  const g = new RelationGraph()
  const aliases: NodeAliasData[] = [
    { nodeId: 'A', altLabels: ['x'] },
  ]
  g.build([], aliases)
  expect(g.resolveAlias('')).toEqual([])
  expect(g.resolveAlias('  ')).toEqual([])
})

test('resolveAlias — no duplicate nodeIds for same alias', () => {
  const g = new RelationGraph()
  const aliases: NodeAliasData[] = [
    { nodeId: 'A', prefLabel: 'foo', altLabels: ['foo'] },
  ]
  g.build([], aliases)
  expect(g.resolveAlias('foo')).toEqual(['A'])
})

// ── getAliases (CL-1 Phase 2) ──────────────────────────────────────────

test('getAliases — returns all labels for a node', () => {
  const g = new RelationGraph()
  const aliases: NodeAliasData[] = [
    { nodeId: 'dws_active_user_di', prefLabel: '活跃用户宽表', altLabels: ['DAU', '日活'] },
  ]
  g.build([], aliases)
  const result = g.getAliases('dws_active_user_di')
  expect(result).toContain('活跃用户宽表')
  expect(result).toContain('DAU')
  expect(result).toContain('日活')
  expect(result).toHaveLength(3)
})

test('getAliases — unknown node returns empty', () => {
  const g = new RelationGraph()
  g.build([], [])
  expect(g.getAliases('unknown')).toEqual([])
})

test('getAliases — node with no aliases returns empty', () => {
  const g = new RelationGraph()
  const aliases: NodeAliasData[] = [
    { nodeId: 'A', altLabels: [] },
  ]
  g.build([], aliases)
  expect(g.getAliases('A')).toEqual([])
})

// ── build clears alias index on rebuild ─────────────────────────────────

test('build clears alias index on rebuild', () => {
  const g = new RelationGraph()
  g.build([], [{ nodeId: 'A', altLabels: ['x'] }])
  expect(g.resolveAlias('x')).toEqual(['A'])
  g.build([], [{ nodeId: 'B', altLabels: ['y'] }])
  expect(g.resolveAlias('x')).toEqual([])
  expect(g.resolveAlias('y')).toEqual(['B'])
})

// ── alias index coexists with relation edges ────────────────────────────

test('alias index works alongside relation edges', () => {
  const g = new RelationGraph()
  const entries = makeEntries(['A', [{ type: 'joins', target: 'B', on: 'id = id' }]])
  const aliases: NodeAliasData[] = [
    { nodeId: 'A', altLabels: ['alpha'] },
    { nodeId: 'B', prefLabel: 'Beta' },
  ]
  g.build(entries, aliases)
  expect(g.resolveAlias('alpha')).toEqual(['A'])
  expect(g.resolveAlias('beta')).toEqual(['B'])
  expect(g.getRelated('A')).toHaveLength(1)
  expect(g.findJoinPath('A', 'B')).toEqual(['A', 'B'])
})

// ── CL-2 D2: dangling domain refs are skipped + warned, not thrown ──────
// A single dangling domain→concept ref previously aborted the ENTIRE graph
// build for ALL assets. It now skips that ref (warned + collected via
// getDanglingDomainRefs) and continues building edges for valid assets.

function makeDanglingLayer(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cl2-dangling-'))
  mkdirSync(join(dir, 'tables'), { recursive: true })
  mkdirSync(join(dir, 'concepts'), { recursive: true })
  writeFileSync(join(dir, 'config.yaml'), yaml.dump({ project: { name: 'test', scope_id: 'test' } }))
  // A valid concept 'pay'; the 'ghost' domain has NO concept definition.
  writeFileSync(join(dir, 'concepts', 'pay.yaml'), yaml.dump({ name: 'pay', description: 'payment domain' }))
  // Table with one valid domain (pay) + one dangling domain (ghost).
  writeFileSync(join(dir, 'tables', 'dws_order.yaml'), yaml.dump({
    table_name: 'dws_order',
    table_comment: 'orders',
    description: 'Order summary',
    domains: ['pay', 'ghost'],
    granularity: 'daily',
    columns: [{ name: 'order_id', type: 'string', comment: 'ID', role: 'dimension' }],
    metrics: {},
    partitions: [{ name: 'ds', type: 'string' }],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
  }))
  return dir
}

function makeCleanLayer(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cl2-clean-'))
  mkdirSync(join(dir, 'tables'), { recursive: true })
  mkdirSync(join(dir, 'concepts'), { recursive: true })
  writeFileSync(join(dir, 'config.yaml'), yaml.dump({ project: { name: 'test', scope_id: 'test' } }))
  writeFileSync(join(dir, 'concepts', 'pay.yaml'), yaml.dump({ name: 'pay', description: 'payment domain' }))
  writeFileSync(join(dir, 'tables', 'dws_order.yaml'), yaml.dump({
    table_name: 'dws_order',
    table_comment: 'orders',
    description: 'Order summary',
    domains: ['pay'],
    granularity: 'daily',
    columns: [{ name: 'order_id', type: 'string', comment: 'ID', role: 'dimension' }],
    metrics: {},
    partitions: [{ name: 'ds', type: 'string' }],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
  }))
  return dir
}

test('CL-2 D2 — dangling domain ref does NOT throw; valid assets still build; ref collected', () => {
  const dir = makeDanglingLayer()
  try {
    const ctx = new Context()
    const svc = new SemanticLayerService(ctx, { semanticRoot: dir })
    // Must NOT throw — the dangling 'ghost' ref is skipped + warned.
    const g = svc.getRelationGraph()
    // Valid domain 'pay' still gets its bidirectional related_to edge.
    const payEdges = g.getRelated('concept:pay', 'related_to')
    expect(payEdges.some(e => e.targetId === 'dws_order')).toBe(true)
    expect(g.getRelated('dws_order', 'related_to').some(e => e.targetId === 'concept:pay')).toBe(true)
    // The dangling 'ghost' concept node is NOT built (edge skipped).
    expect(g.getRelated('concept:ghost', 'related_to')).toEqual([])
    // The dangling ref is reported via the health-check surface.
    const refs = svc.getDanglingDomainRefs()
    expect(refs).toHaveLength(1)
    expect(refs[0]).toContain('dws_order')
    expect(refs[0]).toContain('ghost')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CL-2 D2 — clean layer (all domains resolve) reports zero dangling refs', () => {
  const dir = makeCleanLayer()
  try {
    const ctx = new Context()
    const svc = new SemanticLayerService(ctx, { semanticRoot: dir })
    svc.getRelationGraph()
    expect(svc.getDanglingDomainRefs()).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

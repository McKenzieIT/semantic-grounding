/**
 * Registry-driven graph projection across MULTIPLE registered kinds — the
 * extensibility path W27 exists to enable. The built-in kinds alone cannot
 * expose these defects: they are the only kinds present, so registration
 * order, id-namespace collisions, and per-kind hardcoding stay invisible.
 *
 * Fixtures register their kinds AFTER the three built-ins, in the order that
 * previously misrouted edges (prefixed-id kind first), because registry
 * iteration follows insertion order.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import { SemanticLayerService } from '../src/index.ts'
import type { CorpusItem, DataSourceKindPlugin, GraphNodeProjection, RelationDef, SchemaLike } from '../src/registry.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A raw `{ name, target?, domains? }` definition, the shape every fixture kind stores. */
interface NamedDefinition {
  readonly name: string
  readonly target?: string
  readonly domains?: readonly string[]
}

/**
 * Accepts only objects carrying a string `name`, so a fixture kind sharing a
 * storage dir with a built-in kind can be observed rejecting the built-in's
 * own definitions (and vice versa).
 */
function namedSchema(): SchemaLike<NamedDefinition> & { readonly seen: unknown[] } {
  const seen: unknown[] = []
  const check = (raw: unknown): NamedDefinition | undefined => {
    if (typeof raw !== 'object' || raw === null) return undefined
    const record = raw as Record<string, unknown>
    if (typeof record.name !== 'string') return undefined
    return {
      name: record.name,
      ...(typeof record.target === 'string' ? { target: record.target } : {}),
      ...(Array.isArray(record.domains) ? { domains: record.domains.filter((d): d is string => typeof d === 'string') } : {}),
    }
  }
  return {
    seen,
    parse(raw) {
      const parsed = check(raw)
      if (parsed === undefined) throw new Error('namedSchema: not a named definition')
      return parsed
    },
    safeParse(raw) {
      seen.push(raw)
      const parsed = check(raw)
      return parsed === undefined ? { success: false, error: 'not a named definition' } : { success: true, data: parsed }
    },
  }
}

interface FixtureKind extends DataSourceKindPlugin<NamedDefinition> {
  /** Raw objects this kind's own schema was asked to validate. */
  readonly seen: unknown[]
}

/**
 * A fixture kind whose node ids carry `idPrefix` (empty keeps the bare name),
 * so two kinds can hold a node of the same name and reveal whether edge
 * resolution routes to the wrong one.
 */
function fixtureKind(options: {
  readonly kind: string
  readonly storageDir: string
  readonly idPrefix?: string
  readonly relationType?: string
}): FixtureKind {
  const schema = namedSchema()
  const prefix = options.idPrefix ?? ''
  return {
    kind: options.kind,
    storageDir: options.storageDir,
    schema,
    seen: schema.seen,
    getId: raw => (typeof raw.name === 'string' ? `${prefix}${raw.name}` : undefined),
    toCorpusItem: (def): CorpusItem => ({ id: `${prefix}${def.name}`, description: def.name }),
    toPromptContext: def => def.name,
    relations: (def): RelationDef[] => (def.target === undefined
      ? []
      : [{ type: options.relationType ?? 'related_to', target: def.target }]),
    toGraphNode: (def): GraphNodeProjection => ({
      id: `${prefix}${def.name}`,
      kind: options.kind,
      label: def.name,
      domains: [...(def.domains ?? [])],
    }),
  }
}

/** A semantic-layer root with the fixture directories the caller names. */
function seedRoot(dirs: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'w27-graph-projection-'))
  roots.push(root)
  writeFileSync(join(root, 'config.yaml'), yaml.dump({ project: { name: 'test', scope_id: 'test' } }))
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true })
  return root
}

describe('relation targets across two registered kinds (C1)', () => {
  it('routes an edge to the node that owns the target id, not to a prefixed id of another kind', () => {
    const root = seedRoot(['alpha', 'beta'])
    // `x` exists twice: as the bare-id `alpha` node and inside the `beta`
    // namespace (`beta:x`). `src` declares its target as the bare id `x`.
    writeFileSync(join(root, 'alpha', 'x.yaml'), yaml.dump({ name: 'x' }))
    writeFileSync(join(root, 'alpha', 'src.yaml'), yaml.dump({ name: 'src', target: 'x' }))
    writeFileSync(join(root, 'beta', 'x.yaml'), yaml.dump({ name: 'x' }))

    const svc = new SemanticLayerService(new Context(), { semanticRoot: root, scopeId: '' })
    // `beta` first: the prefixed-id kind is visited before the bare-id kind.
    svc.getRegistry().register(fixtureKind({ kind: 'beta', storageDir: 'beta', idPrefix: 'beta:' }))
    svc.getRegistry().register(fixtureKind({ kind: 'alpha', storageDir: 'alpha' }))

    const graph = svc.getRelationGraph()
    expect(graph.getRelated('src').map(edge => edge.targetId)).toEqual(['x'])
    expect(graph.getRelated('x').map(edge => edge.targetId)).toEqual(['src'])
    // `beta:x` is a different node of a different kind; it owns no edge here.
    expect(graph.getRelated('beta:x')).toEqual([])
  })

  it('leaves an unresolvable target as declared so the gateway drops the edge instead of guessing', () => {
    const root = seedRoot(['alpha', 'beta'])
    writeFileSync(join(root, 'alpha', 'src.yaml'), yaml.dump({ name: 'src', target: 'x' }))
    writeFileSync(join(root, 'beta', 'x.yaml'), yaml.dump({ name: 'x' }))

    const svc = new SemanticLayerService(new Context(), { semanticRoot: root, scopeId: '' })
    svc.getRegistry().register(fixtureKind({ kind: 'beta', storageDir: 'beta', idPrefix: 'beta:' }))
    svc.getRegistry().register(fixtureKind({ kind: 'alpha', storageDir: 'alpha' }))

    const graph = svc.getRelationGraph()
    expect(graph.getRelated('src').map(edge => edge.targetId)).toEqual(['x'])
    expect(graph.getRelated('beta:x')).toEqual([])
  })
})

describe('a kind declaring a built-in storage dir (I7)', () => {
  /** `tables/` holds one real table plus one file only the widget kind accepts. */
  function seedSharedTablesDir(): { root: string; widget: FixtureKind; svc: SemanticLayerService } {
    const root = seedRoot(['tables'])
    writeFileSync(join(root, 'tables', 'orders.yaml'), yaml.dump({ table_name: 'orders', kind: 'dws', columns: [] }))
    writeFileSync(join(root, 'tables', 'widget-a.yaml'), yaml.dump({ name: 'widget-a' }))
    const svc = new SemanticLayerService(new Context(), { semanticRoot: root, scopeId: '' })
    const widget = fixtureKind({ kind: 'widget', storageDir: 'tables', idPrefix: 'widget:' })
    svc.getRegistry().register(widget)
    return { root, widget, svc }
  }

  it('parses that dir with its OWN schema, not the built-in kind schema that owns the directory name', () => {
    const { widget, svc } = seedSharedTablesDir()
    const nodes = svc.projectGraphNodes()
    // The widget kind sees the raw YAML objects and accepts only its own.
    expect(widget.seen).toContainEqual({ name: 'widget-a' })
    expect(nodes).toContainEqual({ id: 'widget:widget-a', kind: 'widget', label: 'widget-a', domains: [] })
    // It never receives the table definition, so it mints no node for it.
    expect(nodes.filter(node => node.kind === 'widget').map(node => node.id)).toEqual(['widget:widget-a'])
    // The built-in table kind still owns the table.
    expect(nodes.find(node => node.id === 'orders')?.kind).toBe('dws')
  })

  it('indexes that kind in the full retrieval corpus under its own id', () => {
    const { svc } = seedSharedTablesDir()
    const ids = svc.loadRetrievalCorpusAll().map(item => item.id)
    expect(ids).toContain('widget:widget-a')
    expect(ids).toContain('orders')
  })
})

describe('declared kind capabilities (I6)', () => {
  /** One derived definition: a part belonging to a gadget. */
  interface GadgetPart {
    readonly id: string
    readonly gadget: string
  }

  /** A gadget definition, optionally listing the parts it derives. */
  interface GadgetDefinition {
    readonly name: string
    readonly parts: readonly string[]
  }

  const gadgetSchema: SchemaLike<GadgetDefinition> = {
    parse(raw) {
      const record = raw as Record<string, unknown>
      if (typeof record.name !== 'string') throw new Error('gadgetSchema: no name')
      return {
        name: record.name,
        parts: Array.isArray(record.parts) ? record.parts.filter((p): p is string => typeof p === 'string') : [],
      }
    },
    safeParse(raw) {
      try {
        return { success: true, data: this.parse(raw) }
      } catch (error) {
        return { success: false, error }
      }
    },
  }

  /** A kind that derives one virtual `part` node per listed part. */
  const gadgetKind: DataSourceKindPlugin<GadgetDefinition> = {
    kind: 'gadget',
    storageDir: 'gadgets',
    schema: gadgetSchema,
    getId: raw => (typeof raw.name === 'string' ? `gadget:${raw.name}` : undefined),
    toCorpusItem: def => ({ id: `gadget:${def.name}`, description: def.name }),
    toPromptContext: def => def.name,
    relations: () => [],
    toGraphNode: def => ({ id: `gadget:${def.name}`, kind: 'gadget', label: def.name, domains: [] }),
    derivedNodes: {
      derive: (def): readonly GadgetPart[] => def.parts.map(id => ({ id, gadget: def.name })),
      toGraphNode: (part: GadgetPart): GraphNodeProjection => ({
        id: `part:${part.id}`, kind: 'part', label: part.id, domains: [],
      }),
      relations: (part: GadgetPart): RelationDef[] => [{ type: 'part_of', target: `gadget:${part.gadget}` }],
      toCorpusItem: (part: GadgetPart): CorpusItem => ({ id: `part:${part.id}`, description: part.id }),
    },
  }

  /** A kind whose nodes group other kinds' nodes by name. */
  const teamKind: DataSourceKindPlugin<NamedDefinition> = {
    ...fixtureKind({ kind: 'team', storageDir: 'teams', idPrefix: 'team:' }),
    toGraphNode: def => ({ id: `team:${def.name}`, kind: 'team', label: def.name, domains: [def.name] }),
    grouping: {
      groupName: node => node.id.slice('team:'.length),
      memberRelationType: 'staffs',
    },
  }

  it('lets a registered kind contribute derived nodes to the graph, its edges, and the corpus', () => {
    const root = seedRoot(['gadgets'])
    writeFileSync(join(root, 'gadgets', 'g1.yaml'), yaml.dump({ name: 'g1', parts: ['hinge'] }))
    const svc = new SemanticLayerService(new Context(), { semanticRoot: root, scopeId: '' })
    svc.getRegistry().register(gadgetKind)

    expect(svc.projectGraphNodes()).toContainEqual({ id: 'part:hinge', kind: 'part', label: 'hinge', domains: [] })
    expect(svc.getRelationGraph().getRelated('part:hinge')).toEqual([{ targetId: 'gadget:g1', type: 'part_of' }])
    expect(svc.loadRetrievalCorpusAll().map(item => item.id)).toContain('part:hinge')
  })

  it('lets a registered kind act as a grouping kind, deriving group edges and reporting unresolved names', () => {
    const root = seedRoot(['teams', 'workers'])
    writeFileSync(join(root, 'teams', 'alpha.yaml'), yaml.dump({ name: 'alpha' }))
    writeFileSync(join(root, 'workers', 'w1.yaml'), yaml.dump({ name: 'w1', domains: ['alpha'] }))
    writeFileSync(join(root, 'workers', 'w2.yaml'), yaml.dump({ name: 'w2', domains: ['ghost'] }))
    const svc = new SemanticLayerService(new Context(), { semanticRoot: root, scopeId: '' })
    svc.getRegistry().register(teamKind)
    svc.getRegistry().register(fixtureKind({ kind: 'worker', storageDir: 'workers', idPrefix: 'worker:' }))

    const graph = svc.getRelationGraph()
    expect(graph.getRelated('team:alpha')).toEqual([{ targetId: 'worker:w1', type: 'staffs' }])
    expect(graph.getRelated('worker:w1')).toEqual([{ targetId: 'team:alpha', type: 'staffs' }])
    // A grouping node names its own group, so it is never its own member.
    expect(graph.getRelated('team:alpha').some(edge => edge.targetId === 'team:alpha')).toBe(false)
    // An unresolved group name is skipped and reported, not fatal.
    expect(graph.getRelated('worker:w2')).toEqual([])
    expect(svc.getDanglingDomainRefs()).toEqual(['asset="worker:w2" domain="ghost"'])
  })
})

describe('skipping derived nodes the caller discards (I4)', () => {
  /** A table carrying one inline metric, so `metric` nodes are derivable. */
  function seedTableWithMetric(): SemanticLayerService {
    const root = seedRoot(['tables'])
    writeFileSync(join(root, 'tables', 'orders.yaml'), yaml.dump({
      table_name: 'orders', kind: 'dws', columns: [], metrics: { total: { expression: 'SUM(amount)' } },
    }))
    return new SemanticLayerService(new Context(), { semanticRoot: root, scopeId: '' })
  }

  it('projects derived nodes by default and omits them when not requested', () => {
    const svc = seedTableWithMetric()
    const withDerived = svc.projectGraphNodes().map(node => node.id)
    expect(withDerived).toContain('orders')
    expect(withDerived).toContain('orders__total')
    expect(svc.projectGraphNodes({ includeDerived: false }).map(node => node.id)).toEqual(['orders'])
  })

  it('never asks a kind to derive nodes the caller will discard', () => {
    const root = seedRoot(['gizmos'])
    writeFileSync(join(root, 'gizmos', 'g1.yaml'), yaml.dump({ name: 'g1' }))
    const svc = new SemanticLayerService(new Context(), { semanticRoot: root, scopeId: '' })
    let derivations = 0
    svc.getRegistry().register({
      ...fixtureKind({ kind: 'gizmo', storageDir: 'gizmos', idPrefix: 'gizmo:' }),
      derivedNodes: {
        derive: (def: NamedDefinition) => { derivations++; return [{ id: `${def.name}-shadow` }] },
        toGraphNode: (shadow: { id: string }) => ({ id: shadow.id, kind: 'shadow', label: shadow.id, domains: [] }),
        relations: () => [],
        toCorpusItem: () => null,
      },
    })

    expect(svc.projectGraphNodes({ includeDerived: false }).map(node => node.id)).toEqual(['gizmo:g1'])
    expect(derivations).toBe(0)
    expect(svc.projectGraphNodes().map(node => node.id)).toEqual(['gizmo:g1', 'g1-shadow'])
    expect(derivations).toBe(1)
  })
})

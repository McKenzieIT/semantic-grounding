/**
 * DataSourceRegistry — a typed plugin registry for semantic-layer data-source
 * kinds (G1 Decision B: DataSourceKindPlugin<T>). Each kind plugin declares how
 * to identify, index, format, and relate definitions of its type.
 *
 * Aligned with G1 §D2 interface design + G2 ontology decisions.
 *
 * @module @deepseek-ai/dsh-semantic-layer/src/registry
 */
// ── Shared types (G1 §D2) ──────────────────────────────────────────────

/** A unified corpus item for retrieval indexing (G1: type-agnostic). */
export interface CorpusItem {
  readonly id: string
  readonly description?: string
  readonly metrics?: Readonly<Record<string, unknown>>
  readonly payload?: unknown
}

/**
 * Aggregated critic-context fields from one or more definitions (G1 §D2).
 * Fields are optional — not all kinds provide all axes.
 */
export interface CriticFields {
  readonly eventParams?: Readonly<Record<string, unknown>>
  readonly partitionCols?: readonly string[]
}

/**
 * A relation declared by a data source (G1 §D2 + G2: three base types, OPEN).
 * Returned by plugin.relations(def); source is the definition that declared it.
 *
 * `type` is an open `string` (W27): the three base kinds (`joins`,
 * `derived_from`, `related_to`) cover the built-in kinds, but a kind
 * registered later may declare its own relation kind (e.g. `visualizes`)
 * without editing this union. The RelationGraph + Schema Gateway carry the
 * open `type` through to the client without a per-type switch.
 */
export interface RelationDef {
  /** Open relation kind — `joins` | `derived_from` | `related_to` or a kind-declared type. */
  readonly type: string
  /**
   * The canonical node id of the target data source — exactly the `id` its
   * owning kind mints in {@link DataSourceKindPlugin.toGraphNode}, including
   * any namespace prefix (`concept:sales`, not `sales`). The graph build stores
   * it verbatim: nothing maps a bare name onto a prefixed id, because two kinds
   * may hold a node of the same name and any such mapping would silently route
   * the edge to the wrong one. A target naming no projected node yields no
   * edge in the Schema Gateway projection rather than an error.
   */
  readonly target: string
  /** Join condition expression (e.g. "charm_id = charm_id"). */
  readonly on?: string
  /** Human-readable description of the relationship. */
  readonly description?: string
}

/**
 * A data source projected as one graph node (W27). Plain `string` id + open
 * `kind` — the Semantic Layer has no notion of cross-process branding; the
 * Schema Gateway brands `id` when it assembles the Remote `SemanticGraphNode`
 * at the wire boundary. Returned by `DataSourceKindPlugin.toGraphNode`.
 */
export interface GraphNodeProjection {
  /** Node identity (table_name, event name, `metric` name, or `concept:<name>`). */
  readonly id: string
  /** Open node kind (a client presentation key, never a closed union). */
  readonly kind: string
  /** Display label. */
  readonly label: string
  /** Domain(s)/group(s) the node belongs to. */
  readonly domains: readonly string[]
}

/**
 * Virtual definitions a kind derives from each of its own definitions, and how
 * to project them (W27). Declared by the kind so nothing in the projection
 * branches on a kind string: a kind registered later contributes derived nodes
 * the same way the built-ins do. `metric` is the shipped case — the `table` and
 * `event` kinds each derive one metric per inline `metrics:` entry.
 *
 * A derived definition is projected, related, and indexed exactly like a stored
 * one, including the canonical-id rule on {@link RelationDef.target}.
 */
export interface DerivedNodeContributor<T = unknown, D = unknown> {
  /** Derive one definition's virtual definitions; empty when it has none. */
  derive(def: T): readonly D[]
  /** Project one derived definition as a graph node, or `null` to keep it out of the graph. */
  toGraphNode(derived: D): GraphNodeProjection | null
  /** Relations one derived definition declares; empty array when it declares none. */
  relations(derived: D): RelationDef[]
  /** Corpus item for one derived definition, or `null` to skip retrieval indexing. */
  toCorpusItem(derived: D): CorpusItem | null
}

/**
 * Declares a kind whose nodes are taxonomy groups (W27): each node of this kind
 * names a group that nodes of OTHER kinds join by listing that name in
 * {@link GraphNodeProjection.domains}. The graph build derives one
 * group→member edge per resolved name and reports unresolved names through
 * `SemanticLayerService.getDanglingDomainRefs()` instead of aborting the build.
 *
 * A grouping node's own `domains` carry its group name, so nodes of a grouping
 * kind contribute no member references of their own — that would be a self-loop.
 * `concept` is the shipped case.
 */
export interface KindGrouping {
  /** The group name one node of this kind defines (`concept:sales` → `sales`). */
  groupName(node: GraphNodeProjection): string
  /** Relation type of each derived group→member edge. */
  readonly memberRelationType: string
}

// ── DataSourceKindPlugin<T> (G1 §D2) ───────────────────────────────────

/** Minimal schema interface (structurally matches zod schemas without hard dep). */
export interface SchemaLike<T> {
  parse(raw: unknown): T
  safeParse(raw: unknown): { success: boolean; data?: T; error?: unknown }
}

/**
 * A plugin that teaches the registry how to handle one kind of data source.
 * Generic over T (the definition shape — EventDefinition, TableDefinition, etc.).
 * G1 §D2 aligned: schema, terminology-aware toCorpusItem, raw-based getId.
 */
export interface DataSourceKindPlugin<T = unknown> {
  /** Unique kind identifier (e.g. 'event', 'table', 'metric'). */
  readonly kind: string

  /** Zod validation schema for this kind's definitions (G1 §D2). */
  readonly schema: SchemaLike<T>

  /** YAML storage subdirectory name (e.g. 'events', 'tables', 'metrics'). */
  readonly storageDir: string

  /**
   * Extract the canonical id from a raw (unparsed) YAML object (G1 §D2).
   * Returns undefined if the raw object doesn't have a valid id for this kind.
   */
  getId(raw: Record<string, unknown>): string | undefined

  /**
   * Project a definition to a corpus item for retrieval indexing (G1 §D2).
   * Returns null to skip indexing for this definition.
   */
  toCorpusItem(def: T): CorpusItem | null

  /** Format a definition into prompt context (for model-facing tools). */
  toPromptContext(def: T): string

  /** Extract critic-relevant fields from a definition (optional; not all kinds have critic logic). */
  toCriticContext?(def: T): CriticFields

  /**
   * Declare relations this definition has to other data sources (G2: required).
   * Return empty array when no relations exist.
   */
  relations(def: T): RelationDef[]

  /**
   * Project a definition to one semantic-graph node (W27), or `null` to declare
   * this definition is not a graph node. Each kind decides its own node id,
   * open `kind` string, label, and domains; the Schema Gateway iterates every
   * registered kind's `toGraphNode` to build the graph (no hand-written
   * per-kind loops), so a kind registered later reaches the graph without
   * editing the gateway.
   */
  toGraphNode(def: T): GraphNodeProjection | null

  /**
   * Virtual definitions this kind derives from each of its own definitions
   * (W27). Omit when the kind derives nothing.
   */
  readonly derivedNodes?: DerivedNodeContributor<T>

  /**
   * Declares this kind's nodes as taxonomy groups other kinds join through
   * `GraphNodeProjection.domains` (W27). Omit for an ordinary asset kind.
   */
  readonly grouping?: KindGrouping

  /**
   * Return an executable rule/SQL template (G2, MetricPlugin only — removed in M1b; retained as optional interface for backward-compat).
   * Optional — only metric-type plugins implement this.
   */
  toExecutableRule?(def: T): string | null
}

// ── DataSourceRegistry ──────────────────────────────────────────────────

/**
 * Registry of data-source kind plugins. Allows registration and lookup by kind string.
 */
export class DataSourceRegistry {
  private readonly plugins = new Map<string, DataSourceKindPlugin>()
  private readonly changeListeners = new Set<() => void>()

  /**
   * Register a listener invoked when a kind is added or removed. The
   * SemanticLayerService wires this to invalidate its relation-graph cache so
   * a disposed kind's nodes/edges do not linger (W27: disposer + cache
   * invalidation). Returns a disposer for this listener.
   * @param listener - a no-arg callback fired after a kind is added or removed.
   * @returns a disposer that removes this listener.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  /**
   * Register a kind plugin. Throws if the kind is already registered.
   * Install with `ctx.effect(() => registry.register(plugin))` so the
   * contribution's lifetime tracks the owning fiber.
   * @param plugin - the kind contribution.
   * @returns an idempotent disposer that removes only this registration and
   *  fires change listeners so cached projections (e.g. the relation graph)
   *  rebuild without the disposed kind.
   */
  register(plugin: DataSourceKindPlugin): () => void {
    if (this.plugins.has(plugin.kind)) {
      throw new Error(`DataSourceRegistry: kind "${plugin.kind}" is already registered`)
    }
    this.plugins.set(plugin.kind, plugin)
    let active = true
    const fire = () => { for (const fn of this.changeListeners) fn() }
    // Fire on add: a re-registered kind must invalidate the cached graph so its
    // nodes/edges flow through without a restart (W27 dispose + reload).
    fire()
    return () => {
      if (!active) return
      active = false
      this.plugins.delete(plugin.kind)
      // Fire on remove: a disposed kind must not linger in the cached graph.
      fire()
    }
  }

  /**
   *  Get a registered plugin by kind, or undefined if not registered.
   * @param kind - kind
   * @returns the result
   */
  getKind(kind: string): DataSourceKindPlugin | undefined {
    return this.plugins.get(kind)
  }

  /**
   *  Return all registered kind strings.
   * @returns the result
   */
  allKinds(): string[] {
    return [...this.plugins.keys()]
  }

  /**
   *  Return all registered plugins.
   * @returns the result
   */
  allPlugins(): DataSourceKindPlugin[] {
    return [...this.plugins.values()]
  }
}

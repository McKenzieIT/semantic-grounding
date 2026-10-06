/**
 * P6b semantic-layer — package entry. A Cordis `Service` shell (mounts via the
 * bundle patch as a capability-plugin row; declares the `ctx.schema` seam) +
 * the substrate exports consumers (P13b swap, sync-write, BasicIndex) use.
 *
 * P6b grilling (5 decisions, all = A):
 *  - Q1 package form: `packages/data/semantic-layer/` single package
 *    (@deepseek-ai/dsh-semantic-layer), group=data (mirrors audit/phase-gate/
 *    nl2sql-engine). load_* model-facing tools are DEFERRED separate tool
 *    packages (mirror tool-search-data-sources; preset already names them
 *    dsh-tool-load-table-definition / dsh-tool-load-event-definition).
 *  - Q2 seam scope: `ctx.schema` covers BOTH live-engine (discover/describe/sample)
 *    AND substrate definitions (loadEventDefinition/loadTableDefinition). P13b
 *    CriticGuardData swaps to `ctx.schema.load_*` (params_fields/partitions).
 *  - Q3 live-engine implementation: DEFERRED — P6b ships the Service Definition +
 *    substrate + a stand-in provider for sync demo/tests; the real query
 *    provider (query-maxcompute sidecar adding schema tools, or an independent
 *    schema-maxcompute provider) is a follow-up. discover/describe/sample throw
 *    "no provider" until mounted; the P13b swap only needs substrate definitions
 *    (no live engine), so it is unblocked.
 *  - Q4 Tier-2 audit: routes through `ctx.audit.recordTier2Write` (P8b real
 *    sqlite audit), NOT the prototype's flat JSON log (intranet-security-first
 *    unified audit trail). The substrate `Tier2Recorder` interface is satisfied
 *    by `ctx.audit`; Tier-2 writes fail-loud if audit is not mounted (D5
 *    "不可关").
 *  - grounded: zod (mirrors pydantic; schemastery has no .passthrough) + js-yaml
 *    substrate deps; reuse `@deepseek-ai/dsh-atomic-write` for atomic writes.
 *
 * G3 (AI-Native Enrichment, resolved 2026-08-22) implementation:
 *  - `discoverRelations(opts)` Service method: delegates to the substrate
 *    `enrichAllDwsTables` (two-round DWS→DIM discovery; `llmCall` injected via
 *    `setLlmCall`, optional — absent => deterministic round only).
 *  - on-write hook: after `syncWrite`/`updateTableMeta` write a DWS, re-run
 *    discovery + persist `dimension_refs` (best-effort, unaudited — auto-derived;
 *    gated by `autoEnrich`, default true). Substrate `writeTable` is used to
 *    persist, so the hook does NOT re-enter the Service write path (no recursion).
 *
 * @module @deepseek-ai/dsh-semantic-layer
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: makes `ctx.get('audit')` resolve to the Audit augmentation. The
// seam stays optional at runtime (Tier-2 writes fail-loud without it).
import type {} from '@deepseek-ai/dsh-audit'
import {
  syncWriteDefinitions as syncWriteDefinitionsFromLayer,
  updateTableMeta as updateTableMetaFromLayer,
  updateEventMeta as updateEventMetaFromLayer,
  loadEventDefinition as loadEventDefinitionFromLayer,
  loadTableDefinition as loadTableDefinitionFromLayer,
  loadRetrievalCorpus as loadRetrievalCorpusFromLayer,
  getCorpusVersion as getCorpusVersionFromLayer,
  type Tier2Recorder,
} from './io.ts'
import type { TableMeta, EventDefinition, TableDefinition, MetricDefinition } from './types.ts'
import { type CorpusVariant, type EventCorpusItem } from './corpus.ts'
import {
  enrichAllDwsTables as enrichAllDwsTablesFromLayer,
  enrichAllEvents as enrichAllEventsFromLayer,
  discoverAltLabels as discoverAltLabelsFromLayer,
  enrichAllTablesAltLabels as enrichAllTablesAltLabelsFromLayer,
  type LlmCall,
} from './enrichment.ts'
import { DataSourceRegistry, type CorpusItem, type GraphNodeProjection } from './registry.ts'
import { eventKindPlugin } from './kinds/event-kind.ts'
import { tableKindPlugin } from './kinds/table-kind.ts'
import { conceptKindPlugin } from './kinds/concept-kind.ts'
import { RelationGraph, type NodeAliasData } from './relation-graph.ts'
import { toMetricDefinition, splitMetricName } from './metrics.ts'
import { loadEvents, loadTables, loadConcepts, loadRawDir, loadConceptDefinition as loadConceptDefinitionFromLayer } from './io.ts'
import { EventDefinitionSchema, TableDefinitionSchema, ConceptDefinitionSchema } from './types.ts'
import { DefinitionSnapshot, captureSnapshot } from './snapshot.ts'

// ── logic exports (substrate; consumers + tests use directly) ───────────
export * from './types.ts'
// W11 C1: MVCC query snapshot — consistent point-in-time view during query execution.
export { DefinitionSnapshot, captureSnapshot, clearSnapshotCache, getSnapshotCacheSize, SNAPSHOT_CACHE_MAX } from './snapshot.ts'
export { RelationGraph, type NodeAliasData } from './relation-graph.ts'
export {
  dumpYaml,
  invalidateCaches,
  resolveSemanticLayer,
  loadConfig,
  loadDomains,
  loadEvents,
  loadTables,
  loadEventDefinition,
  loadTableDefinition,
  loadConcepts,
  loadConceptDefinition,
  loadRawDir,
  loadRetrievalCorpus,
  writeTable,
  writeEventYaml,
  updateTableMeta,
  updateEventMeta,
  inferRole,
  generateTableYaml,
  generateDimYaml,
  mergeColumns,
  mergeChangedYaml,
  syncWriteDefinitions,
  WriteValidationError,
  type RawEvent,
  type RawTable,
  type RawConcept,
  type Tier2Recorder,
  type Tier2Opts,
  type WriteEventYamlResult,
  type UpdateTableMetaResult,
} from './io.ts'
export { BasicIndex, type EventIndexEntry, type TableIndexEntry } from './basic-index.ts'
export { submit, load as loadPending, listing, discard, isValidId, type PendingSuggestion, type SubmitArgs } from './pending.ts'
export {
  buildRetrievalCorpus,
  type CorpusVariant,
  type EventCorpusItem,
  type EventCorpusInput,
} from './corpus.ts'
// G3: AI-Native enrichment substrate (B1/B2) + mechanical metrics extraction (B5).
// CL-1 Phase 3: alt_labels enrichment (G3 同構).
export {
  discoverRelationsDeterministic,
  mergeRefs,
  buildLlmPrompt,
  parseLlmRefs,
  discoverRelationsFor,
  buildDimInventory,
  enrichAllDwsTables,
  discoverEventRelationsDeterministic,
  buildEventLlmPrompt,
  discoverEventRelationsFor,
  enrichAllEvents,
  discoverAltLabelsDeterministic,
  buildAltLabelsPrompt,
  parseAltLabelsResponse,
  mergeAltLabels,
  discoverAltLabelsFor,
  enrichAllTablesAltLabels,
  enrichAllEventsAltLabels,
  discoverAltLabels,
  type AltLabelsTarget,
  type DimInventoryEntry,
  type LlmCall,
} from './enrichment.ts'
export {
  extractMetricsFromTable,
  extractMetricsFromEvent,
  extractMetricsFromTables,
  toMetricDefinition,
  metricName,
  splitMetricName,
  inferAggregation,
  loadMetricDefinitions,
  metricGraphNode,
} from './metrics.ts'
// W27: data-source kind registry contract (kinds, relations, graph projection).
export {
  DataSourceRegistry,
  type DataSourceKindPlugin,
  type SchemaLike,
  type CorpusItem,
  type CriticFields,
  type RelationDef,
  type GraphNodeProjection,
} from './registry.ts'

// ── SchemaProvider: live-engine schema source (P6b Q3 deferred) ───────────
// The real provider (query-maxcompute sidecar adding list/describe/sample
// tools, or an independent schema-maxcompute provider) is a follow-up. P6b
// ships this interface + a stand-in for sync demo/tests. discover/describe/
// sample on the Service throw "no provider" until one is mounted.
/** Live-engine schema source: discover/describe/sample tables for sync-write (P6b Q3 deferred; production mounts a real provider). */
export interface SchemaProvider {
  /** List tables in a scope (optionally filtered by kind). Real impl: maxc list + per-table describe. */
  discover(scopeId: string, kind?: string): Promise<readonly TableMeta[]>
  /** Describe one table's columns/partitions/comment. */
  describe(tableName: string): Promise<TableMeta | null>
  /** Sample N rows as formatted text. */
  sample(tableName: string, n?: number): Promise<string>
}

// ── ScopeRegistry: optional per-scope registry (P1) ───────────────────
// Structural — no static dep on @deepseek-ai/dsh-scope-registry, the same probe
// pattern as SchemaProvider above and tool-search-data-sources' SchemaCorpusSource.
// When the scope-registry plugin is mounted, semanticRoot/scopeId delegate to
// the active scope; otherwise the Service falls back to its static mount config.
/** Optional per-scope registry probed via `ctx.get('scopes')` (undefined when unmounted). */
interface ScopeRegistryLike {
  /** The active scope definition, or undefined when no scope is active. */
  active(): { readonly id: string; readonly semanticRoot: string } | undefined
  /** The active scope id, or undefined when no scope is active. */
  activeId(): string | undefined
  /** GA-GT1 Phase 2: resolve a scope by id for per-request scope (undefined when not found). */
  get(id: string): { readonly id: string; readonly semanticRoot: string } | undefined
}

// ── CL-18 Phase 2: partition-column exclude set (calling-layer metadata) ──
/**
 * CL-18 Phase 2: minimal fallback blocklist of partition column names used
 * when a target table has no `role: 'partition'` columns to drive a
 * data-driven exclude set. These three names are the standard MaxCompute
 * business-date partition spellings; hardcoding them keeps the substrate's
 * `discoverRelationsDeterministic` free of any specific metadata format while
 * still catching the common noise (a DIM keyed by `ds` matching every DWS).
 */
const DEFAULT_PARTITION_BLOCKLIST: readonly string[] = ['ds', 'pt', 'dt']

/**
 * CL-18 Phase 2: build the partition-column exclude set for a target table.
 *
 * Strategy (layered, per the ticket design):
 *  - **Data-driven (preferred)**: when the table has columns tagged
 *    `role: 'partition'`, those names form the exclude set. This is the
 *    high-precision path — it excludes exactly the partition columns the
 *    analyst declared for THIS table, including any custom partition names
 *    beyond `ds`/`pt`/`dt`.
 *  - **Fallback blocklist**: when the table has NO `role: 'partition'`
 *    columns (e.g. a sync-written table whose partition columns live in the
 *    separate `partitions` array rather than `columns`, or an unannotated
 *    dataset), fall back to the minimal `DEFAULT_PARTITION_BLOCKLIST`
 *    (`ds`/`pt`/`dt`). This still filters the common noise without depending
 *    on metadata annotations.
 *
 * The result is forwarded into `discoverRelationsFor` via
 * `enrichAllDwsTables`'s `excludeColumnsFn` so the deterministic PK match
 * skips partition columns (e.g. an `_arch` DIM snapshot keyed by `ds` no
 * longer matches every DWS carrying a `ds` column).
 * @param def - the target table definition.
 * @returns a set of column names to exclude from deterministic PK matching (never empty).
 */
export function buildExcludeColumns(def: TableDefinition): Set<string> {
  const partitionCols = def.columns.filter(c => c.role === 'partition').map(c => c.name)
  return partitionCols.length > 0 ? new Set(partitionCols) : new Set(DEFAULT_PARTITION_BLOCKLIST)
}

// ── ctx.schema Service Definition (Q2: covers live-engine + substrate) ───
/** Configuration for the `ctx.schema` Cordis Service (semantic-layer root + default scope id). */
export interface SemanticLayerConfig {
  /** Semantic-layer scope root (the dir with config.yaml/events/tables). */
  readonly semanticRoot?: string
  /** Default scope id for Tier-2 audit + schema discovery. */
  readonly scopeId?: string
  /** D2h: enrichment variant — 'params+term' (default, D2e-shipped) or
   * 'term-only' (D2g verdict (A) higher-recall). Mount-time config; switching
   * it remounts the Service (new WeakMap key -> fresh enriched linker), so it
   * is NOT part of the D2f corpusVersion cache key. */
  readonly corpusVariant?: CorpusVariant
  /** G3: auto-run DWS→DIM relation discovery after a Service write
   * (syncWrite/updateTableMeta). Default true (G3: core capability, not an
   * optional hook). Set false to suppress (e.g. during bulk sync). */
  readonly autoEnrich?: boolean
}

/** Resolved config: all cfg defaults applied ONCE in the constructor into a
 * typed object with REQUIRED fields (Cordis CONVENTIONS.md "no hardcoded
 * tunables" + "defaulting is an explicit `resolve(request): Spec` step, never
 * a hidden `?? default` inside run()"). Use sites read resolved fields — no
 * inline `?? default` tunables scattered across the implementation. Mirrors
 * the shell request→spec seam (docs/subsystems/shell.md) and the local
 * `resolveEnrichmentLlmConfig` pattern in llm-wiring-plugin.ts. */
export interface ResolvedSemanticLayerConfig {
  /** Semantic-layer scope root (the dir with config.yaml/events/tables); '' when unset. */
  readonly semanticRoot: string
  /** Default scope id for Tier-2 audit + schema discovery; '' when unset. */
  readonly scopeId: string
  /** D2h enrichment variant — 'params+term' (default, D2e-shipped) or 'term-only'. */
  readonly corpusVariant: CorpusVariant
  /** G3 auto-run DWS→DIM relation discovery after a Service write. Default true. */
  readonly autoEnrich: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    schema: SemanticLayerService
  }
}

/** CONVENTIONS.md "explicit resolve step": apply cfg defaults ONCE into a
 * typed resolved-config object (required fields), so run()-path use sites
 * carry no inline `?? default` tunables. This is the single defaulting point;
 * every other read uses `this.resolved.<field>` directly. Mirrors the
 * `resolveEnrichmentLlmConfig` pattern in llm-wiring-plugin.ts and the shell
 * request→spec seam (docs/subsystems/shell.md). */
function resolveSemanticLayerConfig(config: SemanticLayerConfig): ResolvedSemanticLayerConfig {
  return {
    semanticRoot: config.semanticRoot ?? '',
    scopeId: config.scopeId ?? '',
    corpusVariant: config.corpusVariant ?? 'params+term',
    autoEnrich: config.autoEnrich ?? true,
  }
}

/**
 * The semantic-layer Cordis `Service`. Owns the `ctx.schema` seam: substrate
 * definitions (load_*, sync-read) + live-engine schema (discover/describe/sample,
 * delegated to an injectable `SchemaProvider` — P6b Q3 deferred). Tier-2 writes
 * (syncWrite/updateTableMeta) route through `ctx.audit.recordTier2Write`.
 */
export class SemanticLayerService extends Service {
  static Config: z<SemanticLayerConfig> = z.object({
    semanticRoot: z.string().default(''),
    scopeId: z.string().default(''),
    corpusVariant: z.union(['params+term', 'term-only'] as const).default('params+term'),
    autoEnrich: z.boolean().default(true),
  })

  private readonly resolved: ResolvedSemanticLayerConfig
  private provider: SchemaProvider | undefined
  /** G3: injected one-shot LLM call for the semantic relation round (undefined => deterministic round only). */
  private llmCall: LlmCall | undefined

  private readonly registry = new DataSourceRegistry()

  /** P1: strictly-monotonic counter bumped when the active scope id changes
   * (detected lazily in corpusVersion() — no event listener, so the constructor
   * has no ctx side-effect and test stand-ins without ctx.on still construct).
   * Combined into corpusVersion() so the value changes on every scope switch —
   * including switch-BACK, where the new scope's per-path counter can otherwise
   * collide with the cached version and serve the wrong scope's corpus (the
   * silent semantic-layer leak tool-search-data-sources would otherwise hit). */
  private scopeEpoch = 0
  /** P1: the active scope id seen at the last corpusVersion() call. Drives lazy
   * switch-detection (undefined until the first call). */
  private lastScopeId: string | undefined
  /** P1: false until the first corpusVersion() call, so the first call records
   * the id without bumping (an unmounted scope-registry thus keeps epoch=0 =
   * unchanged pre-P1 behavior). */
  private hasObservedScope = false

  constructor(ctx: Context, config: SemanticLayerConfig) {
    super(ctx, 'schema')
    this.resolved = resolveSemanticLayerConfig(config)
    // W27: invalidate the relation-graph cache when a kind is added or removed
    // (fiber dispose/reload) so a disposed kind's nodes/edges do not linger.
    // The node projection (projectGraphNodes) is not cached — it iterates the
    // live registry — so only the edge-graph caches need clearing. Both the
    // listener and the built-in kind registrations go through `ctx.effect` so
    // their disposers track this service's fiber. `effect` is a reflect mixin
    // present on every Cordis context; a caller that cannot supply one fails
    // here rather than yielding a service whose graph cache never invalidates.
    ctx.effect(() => this.registry.onChange(() => {
      this.graphCache = undefined
      this.graphVersion = -1
      this.graphCacheByScope.clear()
    }))
    for (const p of [eventKindPlugin, tableKindPlugin, conceptKindPlugin]) {
      ctx.effect(() => this.registry.register(p))
    }
  }

  /**
   * P1: the optional scope-registry, probed by name (undefined when unmounted).
   *
   * Fail-loud: a corrupt `scopes.yaml` makes the registry's `load()` throw a
   * YAMLException, which propagates through `corpusVersion()` rather than
   * silently falling back to static config — a silent fallback could serve the
   * wrong scope's corpus (the exact leak this change prevents). The registry
   * writes atomically, so self-corruption is impossible; only external
   * tampering/disk failure trips this, and failing visibly is the
   * intranet-security-first choice. Locked by the corrupt-yaml test below.
   */
  private scopes(): ScopeRegistryLike | undefined {
    return this.ctx.get('scopes') as ScopeRegistryLike | undefined
  }

  /**
   * GA-GT1 Phase 2: resolve the semanticRoot for a (optional) scopeId.
   *  - scopeId undefined → active scope's root (current behavior; backward-compatible).
   *  - scopeId provided + registry mounted + scope found → that scope's root.
   *  - scopeId provided + registry mounted + scope NOT found → throw
   *    (intranet-security: refuse silent fallback to active scope to prevent
   *    cross-tenant corpus leak).
   *  - scopeId provided + registry unmounted → active/cfg root (test stand-in).
   * @param scopeId - optional scope id; omit for the active scope.
   * @returns the resolved semantic-layer root path.
   */
  private resolveRoot(scopeId?: string): string {
    if (scopeId === undefined) return this.semanticRoot
    const reg = this.scopes()
    if (reg === undefined) return this.semanticRoot // unmounted: fall back (test stand-in)
    const def = reg.get(scopeId)
    if (def !== undefined) return def.semanticRoot
    throw new Error(`ctx.schema: scope "${scopeId}" not found in registry (intranet-security: refusing silent fallback to prevent cross-tenant corpus leak)`)
  }

  /**
   * GA-GT1 Phase 5a: PUBLIC per-scope root-resolution seam. Delegates to the
   * private `resolveRoot` (4-branch semantics unchanged) so consumer packages
   * (tool-retrieve/tool-search-data-sources/tool-search-schema enrichedLinkers
   * + retrieval-inproc scopedRetrievers) can resolve a scope's root for the
   * #19/#22 root-check fix (5b adds `root` to the per-scope cache entry +
   * checks `entry.root === root` — parity with the Phase 2 I-1
   * `graphCacheByScope` root guard). Dormant in 5a: no consumer calls it yet;
   * the method is exposed now so 5b can wire it through `SchemaCorpusSource`.
   *
   * 4 branches (same as `resolveRoot`):
   *  - scopeId undefined → active scope's root (backward-compatible).
   *  - scopeId provided + registry mounted + scope found → that scope's root.
   *  - scopeId provided + registry mounted + scope NOT found → throw
   *    (intranet-security: refuse silent fallback to active scope to prevent
   *    cross-tenant corpus leak).
   *  - scopeId provided + registry unmounted → active/cfg root (test stand-in).
   * @param scopeId - optional scope id; omit for the active scope.
   * @returns the resolved semantic-layer root path.
   */
  resolveScopeRoot(scopeId?: string): string {
    return this.resolveRoot(scopeId)
  }

  /**
   * The live data-source-kind registry (events/tables/metrics plugins registered at construction).
   * @returns the live data-source-kind registry.
   */
  getRegistry(): DataSourceRegistry {
    return this.registry
  }

  private graphCache: RelationGraph | undefined
  private graphVersion = -1
  /** GA-GT1 Phase 2 (D4 β): per-scope cache (plain Map; LRU eviction deferred
   * to Phase 3/4 — scope count is small) for `getRelationGraph(scopeId)` —
   * layered ALONGSIDE the existing instance cache (the no-arg path is
   * unchanged). Keyed by scopeId; each entry ALSO records the `root` the graph
   * was built from + `corpusVersionForRoot(root)`, so the entry is invalidated
   * when the version changes OR the scope is re-registered with a different
   * `semanticRoot` (cross-tenant corpus leak guard — I-1: without the root
   * check a re-registration onto a never-written root keeps version=0=0 and
   * the cache would silently serve the OLD root's graph). Phase 3/4 cleanup
   * unifies the two cache paths. */
  private readonly graphCacheByScope = new Map<string, { graph: RelationGraph; version: number; root: string }>()
  /** CL-2 D2: dangling domain→concept refs collected during the last
   * getRelationGraph() build — assets whose `domains` reference a concept
   * name with no matching definition in concepts/. Such refs are SKIPPED
   * (warned) rather than aborting the build, so valid assets still get their
   * edges. Empty when all refs resolve (or no concepts are loaded). Exposed
   * via getDanglingDomainRefs() as a health-check surface. */
  private danglingDomainRefs: string[] = []

  /**
   * The live relation graph: bidirectional adjacency over every table's
   * `dimension_refs` (joins), every event's `external_refs` (joins), and every
   * metric's `relations` (derived_from). Cached; rebuilt when the layer's
   * corpus-version counter advances (a write bumps it via `invalidateCaches`).
   * Events only enter the graph once `enrichAllEvents` has written their
   * `external_refs` (Part B).
   *
   * GA-GT1 Phase 2 (D4 β): an optional `scopeId` resolves a per-request scope's
   * root (via `resolveRoot`); the no-arg path is unchanged (active scope, single
   * instance cache — backward-compatible). The scopeId path uses a separate
   * per-scope cache (`graphCacheByScope` — plain Map, LRU eviction deferred to
   * Phase 3/4) keyed by scopeId + root + `corpusVersionForRoot(root)`. The root
   * is part of the cache key so re-registering the scope with a different
   * `semanticRoot` invalidates the entry even when the new root's content
   * counter is still 0 (I-1: cross-tenant corpus leak guard). It is acceptable
   * that `getRelationGraph()` and `getRelationGraph(activeId)` produce separate
   * cache entries for the same active scope (data is identical; duplicate entry
   * is harmless — Phase 3/4 cleanup unifies the two paths).
   * @param scopeId - optional scope id; omit to use the active scope (backward-compatible).
   * @returns the cached `RelationGraph`, rebuilt when stale.
   */
  getRelationGraph(scopeId?: string): RelationGraph {
    if (scopeId === undefined) {
      // Existing no-arg path — single instance cache (backward-compatible; do not alter).
      if (this.graphCache !== undefined && this.graphVersion === this.corpusVersion()) {
        return this.graphCache
      }
      const g = this.buildGraph(this.semanticRoot)
      this.graphCache = g
      this.graphVersion = this.corpusVersion()
      return g
    }
    // GA-GT1 Phase 2: per-scope cache path — keyed by scopeId + root +
    // corpusVersionForRoot(root). The root is resolved ONCE (M-2: avoids a
    // duplicate resolveRoot/YAML read that corpusVersion(scopeId) would
    // otherwise re-run); the root is ALSO stored in the entry + checked on hit
    // so a re-registration that changes the scope's `semanticRoot` invalidates
    // the entry even when the new root's per-path content counter is still 0
    // (I-1: silent cross-tenant corpus leak guard).
    const root = this.resolveRoot(scopeId)
    const version = this.corpusVersionForRoot(root)
    const entry = this.graphCacheByScope.get(scopeId)
    if (entry !== undefined && entry.version === version && entry.root === root) {
      return entry.graph
    }
    const g = this.buildGraph(root)
    this.graphCacheByScope.set(scopeId, { graph: g, version, root })
    return g
  }

  /**
   * GA-GT1 Phase 2: build a fresh `RelationGraph` from `root` — the ~60-line
   * build body shared by both the no-arg + per-scope paths of
   * `getRelationGraph`, so the build logic is NOT duplicated. Pure w.r.t.
   * cache state — the caller assigns the result to the relevant cache slot.
   * Updates `danglingDomainRefs` as a build side-effect (same as pre-Phase-2).
   */
  private buildGraph(root: string): RelationGraph {
    const g = new RelationGraph()
    const entries: { sourceId: string; relations: import('./registry.ts').RelationDef[] }[] = []
    const aliasData: NodeAliasData[] = []
    const memberDomains: { sourceId: string; domains: string[] }[] = []
    const groups = new Map<string, { nodeId: string; memberRelationType: string }>()

    // W27: registry-driven relation + alias + group collection. Each registered
    // kind's definitions are loaded from `root` (scope-aware); its
    // `relations()`, `toGraphNode()`, and declared `derivedNodes` contribute
    // every edge and source id. Nothing here reads a kind string, so a kind
    // registered after build reaches the graph — including with derived nodes
    // and as a taxonomy group — without editing this loop.
    for (const plugin of this.registry.allPlugins()) {
      const grouping = plugin.grouping
      const derived = plugin.derivedNodes
      for (const def of this.loadKindDefinitions(plugin, root)) {
        const node = plugin.toGraphNode(def)
        if (node) {
          entries.push({ sourceId: node.id, relations: plugin.relations(def) })
          if (grouping === undefined) {
            // An ordinary node joins the groups its `domains` name.
            if (node.domains.length > 0) memberDomains.push({ sourceId: node.id, domains: [...node.domains] })
          } else {
            // A grouping node's `domains` carry its own group name, so it
            // defines a group instead of joining one (no self-loop).
            groups.set(grouping.groupName(node), { nodeId: node.id, memberRelationType: grouping.memberRelationType })
          }
        }
        // Alias index (structural: pref_label / alt_labels on any kind).
        const alias = graphAliasData(def, node?.id)
        if (alias) aliasData.push(alias)
        if (derived === undefined) continue
        for (const virtual of derived.derive(def)) {
          const virtualNode = derived.toGraphNode(virtual)
          if (virtualNode === null) continue
          entries.push({ sourceId: virtualNode.id, relations: derived.relations(virtual) })
          const virtualAlias = graphAliasData(virtual, virtualNode.id)
          if (virtualAlias) aliasData.push(virtualAlias)
        }
      }
    }

    // CL-2 D2: a domain naming no group is SKIPPED + warned rather than
    // aborting the whole build, so valid members still get their edges.
    // Collected refs are exposed via getDanglingDomainRefs() (health surface).
    this.danglingDomainRefs = []
    if (groups.size > 0) {
      for (const { sourceId, domains } of memberDomains) {
        for (const d of domains) {
          const group = groups.get(d)
          if (group === undefined) {
            const ref = `asset="${sourceId}" domain="${d}"`
            this.danglingDomainRefs.push(ref)
            this.ctx.logger.warn(`ctx.schema relation graph: dangling domain reference — ${ref} (no matching concept definition in concepts/; reference skipped)`)
            continue
          }
          entries.push({ sourceId: group.nodeId, relations: [{ type: group.memberRelationType, target: sourceId }] })
        }
      }
    }
    // `RelationDef.target` is already the canonical node id its owning kind
    // mints in `toGraphNode`, so the entries are built verbatim — no name
    // resolution. A target naming no projected node stays as declared and the
    // Schema Gateway drops the edge (both endpoints must be projected nodes).
    g.build(entries, aliasData)
    return g
  }

  /**
   * CL-2 D2: dangling domain→concept references collected during the last
   * `getRelationGraph()` build — assets whose `domains` reference a concept
   * name with no matching definition in concepts/. Such refs are skipped
   * (warned) rather than aborting the graph build, so valid assets still get
   * their edges. Empty when all domain refs resolve or no concepts are loaded.
   *
   * M-1: `danglingDomainRefs` is shared INSTANCE state — `buildGraph` is now
   * called by BOTH the no-arg + scopeId paths of `getRelationGraph`, so this
   * reflects the last build ACROSS ALL SCOPES (whichever `getRelationGraph`
   * call ran last), NOT a per-scope view. Per-scope keying of this health
   * surface is deferred to Phase 3/4 (scope count is small; the leak guard is
   * on the graph cache, not this health-check surface).
   * @returns a snapshot of the dangling refs (`asset="..." domain="..."`) from the last build (across all scopes).
   */
  getDanglingDomainRefs(): string[] {
    return [...this.danglingDomainRefs]
  }

  /**
   * Registry-driven full retrieval corpus: every registered kind's definitions
   * projected via its `toCorpusItem` (events + tables + metrics). Supersedes
   * the events-only `loadRetrievalCorpus()` for P3/P4 — tables + metrics MUST
   * be indexable so BM25 can hit a DIM table (join recall) or a metric
   * (Level 2 context injection). `loadRetrievalCorpus()` is unchanged (preserves the
   * D2e events-only measured behavior + its 445-item K11 test).
   * @returns the full corpus (events + tables + metrics) ready for Bm25Linker.
   */
  loadRetrievalCorpusAll(): CorpusItem[] {
    const out: CorpusItem[] = []
    for (const plugin of this.registry.allPlugins()) {
      const derived = plugin.derivedNodes
      for (const def of this.loadKindDefinitions(plugin)) {
        const item = plugin.toCorpusItem(def)
        if (item) out.push(item)
        if (derived === undefined) continue
        for (const virtual of derived.derive(def)) {
          const virtualItem = derived.toCorpusItem(virtual)
          if (virtualItem) out.push(virtualItem)
        }
      }
    }
    return out
  }

  /**
   * Read one built-in kind's bespoke storage layout: `events` domain subdirs,
   * the flat `tables` dir, or the flat `concepts` dir, each validated by the
   * schema that owns that layout. Keyed by the built-in plugin instance rather
   * than by its `storageDir` string, because a kind registered later may
   * declare the same directory name and must not be handed another kind's
   * parsed shape (see {@link loadKindDefinitions}). `root` selects the scope
   * root to read.
   */
  private loadBuiltinDefinitions(plugin: import('./registry.ts').DataSourceKindPlugin, root: string): readonly unknown[] | undefined {
    const out: unknown[] = []
    if (plugin === eventKindPlugin) {
      for (const e of loadEvents(root)) {
        const r = EventDefinitionSchema.safeParse(e.raw)
        if (r.success) out.push(r.data)
      }
      return out
    }
    if (plugin === tableKindPlugin) {
      for (const t of loadTables(root)) {
        const r = TableDefinitionSchema.safeParse(t.raw)
        if (r.success) out.push(r.data)
      }
      return out
    }
    if (plugin === conceptKindPlugin) {
      for (const c of loadConcepts(root)) {
        const r = ConceptDefinitionSchema.safeParse(c.raw)
        if (r.success) out.push(r.data)
      }
      return out
    }
    return undefined
  }

  /**
   * Registry-driven semantic-graph node projection (W27): every registered
   * kind's `toGraphNode` applied to each of its loaded definitions, followed by
   * the nodes those kinds derive through their declared `derivedNodes`
   * contributor (`metric` for `table` and `event`). Each kind contributes a node
   * or explicitly declines (`null`). Iterating the registry, rather than
   * hand-written per-kind loops, is what lets a kind registered later reach the
   * graph — with derived nodes included — without editing the projection.
   *
   * Uncached: it re-reads every registered kind's definitions from the ACTIVE
   * scope root on each call. The Schema Gateway threads a per-request `scopeId`
   * only to the relation-graph edge source, matching pre-W27 node-load behavior.
   * @param opts - `includeDerived` (default `true`) projects each kind's derived
   *  nodes; pass `false` to skip deriving nodes the caller discards.
   * @returns one projection per graph node: every registered kind's own nodes, then their derived nodes.
   */
  projectGraphNodes(opts: { readonly includeDerived?: boolean } = {}): GraphNodeProjection[] {
    const includeDerived = opts.includeDerived ?? true
    const out: GraphNodeProjection[] = []
    const derivedOut: GraphNodeProjection[] = []
    for (const plugin of this.registry.allPlugins()) {
      const derived = includeDerived ? plugin.derivedNodes : undefined
      for (const def of this.loadKindDefinitions(plugin)) {
        const node = plugin.toGraphNode(def)
        if (node) out.push(node)
        if (derived === undefined) continue
        for (const virtual of derived.derive(def)) {
          const virtualNode = derived.toGraphNode(virtual)
          if (virtualNode !== null) derivedOut.push(virtualNode)
        }
      }
    }
    out.push(...derivedOut)
    return out
  }

  /**
   * Load one kind's definitions from a scope root. Bespoke storage layouts
   * route through {@link loadBuiltinDefinitions}, selected by plugin identity.
   * Every other kind's dir is read generically (`loadRawDir` + the plugin's
   * OWN `schema.safeParse`), so a kind registered after build loads without a
   * hardcoded loader and keeps its own definition shape even when it declares
   * a directory name a built-in kind also uses. The `root` (W27) defaults to
   * the active scope root for `projectGraphNodes`; the relation-graph build
   * passes a per-scope root.
   */
  private loadKindDefinitions(plugin: import('./registry.ts').DataSourceKindPlugin, root: string = this.semanticRoot): readonly unknown[] {
    const builtin = this.loadBuiltinDefinitions(plugin, root)
    if (builtin !== undefined) return builtin
    const out: unknown[] = []
    for (const raw of loadRawDir(root, plugin.storageDir)) {
      const r = plugin.schema.safeParse(raw)
      if (r.success && r.data !== undefined) out.push(r.data)
    }
    return out
  }

  /**
   * Mount a live-engine schema provider (P6b Q3 deferred; follow-up mounts the real one).
   * @param provider - the provider to delegate discover/describe/sample to, or undefined to clear.
   */
  setSchemaProvider(provider: SchemaProvider | undefined): void {
    this.provider = provider
  }

  /**
   * G3: inject (or clear) the one-shot LLM call used by the semantic relation
   * round. When undefined, `discoverRelations` + the on-write hook run the
   * deterministic PK-name round only. Production wires this to `ctx.llm`
   * (BlockAssembler-assembled text); the substrate itself stays free of the
   * LLM dependency.
   * @param fn - the llmCall to use, or undefined to run deterministic-only.
   */
  setLlmCall(fn?: LlmCall): void {
    this.llmCall = fn
  }

  /**
   * G3: discover DWS→DIM dimension relations for the layer (or a subset when
   * `tables` is given) and write them back into each DWS table's
   * `dimension_refs`. Delegates to the substrate `enrichAllDwsTables` (two-round
   * strategy; deterministic round always runs, LLM round runs only when a
   * `llmCall` is injected via `setLlmCall`). No Tier-2 audit — this is the
   * explicit enrichment entry (used by the `discover_relations` agent tool +
   * batch seeding); the on-write hook is the auto path.
   *
   * GA-GT3-5b: `preserveCurated` (default `true`) toggles the replace strategy
   * when `mergeExisting=false` (the default): `true` = origin-aware replace
   * (curated manual/undefined preserved, machine dropped — PR #43); `false` =
   * raw full-replace escape-hatch (ALL existing refs dropped, only discovered
   * remain — for the rare blow-away-rebuild case). Additive: default behavior
   * unchanged.
   * @param opts - optional `tables` filter + `preserveCurated` toggle (default true).
   * @returns `enriched` (DWS gaining >=1 ref) + `written` (DWS updated) + per-table `errors`.
   */
  async discoverRelations(
    opts: { readonly tables?: readonly string[]; readonly preserveCurated?: boolean } = {},
  ): Promise<{ enriched: number; written: number; errors: string[]; note?: string }> {
    // CL-18 Phase 2: forward the partition-column exclude set so ds/pt/dt
    // partition-column PK matches do not generate noise JOIN relations.
    // GA-GT3-5b: forward preserveCurated (default true = origin-aware replace;
    // false = raw full-replace escape-hatch).
    return enrichAllDwsTablesFromLayer(
      this.semanticRoot,
      this.llmCall,
      opts.tables,
      false,
      buildExcludeColumns,
      opts.preserveCurated ?? true,
    )
  }

  /**
   * Discover event→DIM relations (parallel to `discoverRelations` for DWS
   * tables) and write them into each event's `external_refs`. Delegates to the
   * substrate `enrichAllEvents` (two-round; deterministic always runs, LLM
   * round runs only when a `llmCall` is injected via `setLlmCall`). No Tier-2
   * audit — explicit enrichment entry.
   *
   * NOTE: an on-write hook for events (parallel to `enrichOnWrite` for tables)
   * is deferred: there is no Service-level event-write path today (events are
   * written via the substrate `writeEventYaml` raw-edit surface, not a Service
   * method). The hook lands with a future `syncWriteEvents`/`updateEventMeta`
   * Service method.
   *
   * GA-GT3-5b: `preserveCurated` (default `true`) toggles the replace strategy
   * (parallel to `discoverRelations`): `true` = origin-aware replace (curated
   * manual/undefined preserved, machine dropped — PR #43); `false` = raw
   * full-replace escape-hatch (ALL existing refs dropped, only discovered
   * remain). Additive: default behavior unchanged.
   * @param opts - optional `events` filter + `preserveCurated` toggle (default true).
   * @returns `enriched` (events gaining >=1 ref) + `written` (events updated) + per-event `errors`.
   */
  async discoverEventRelations(
    opts: { readonly events?: readonly string[]; readonly preserveCurated?: boolean } = {},
  ): Promise<{ enriched: number; written: number; errors: string[]; note?: string }> {
    // GA-GT3-5b: forward preserveCurated (default true = origin-aware replace;
    // false = raw full-replace escape-hatch; parallel to discoverRelations).
    return enrichAllEventsFromLayer(this.semanticRoot, this.llmCall, opts.events, false, undefined, opts.preserveCurated ?? true)
  }

  /**
   * CL-1 Phase 3: discover alt_labels (SKOS aliases) for definitions in the
   * layer. Two-round strategy: deterministic extraction from description/columns/
   * domains + optional LLM semantic suggestions. Merges with existing labels
   * (never removes curated aliases).
   *
   * @param opts - optional filters: `tables` (table_names) and/or `events` (event names).
   * @returns combined `enriched` + `written` + `errors` across tables and events.
   */
  async discoverAltLabels(
    opts: { readonly tables?: readonly string[]; readonly events?: readonly string[] } = {},
  ): Promise<{ enriched: number; written: number; errors: string[] }> {
    return discoverAltLabelsFromLayer(this.semanticRoot, this.llmCall, opts.tables, opts.events)
  }

  /**
   * G3 on-write hook: after a Service write, re-run DWS→DIM discovery for the
   * just-written tables and persist `dimension_refs` (best-effort: a failure
   * is logged, never propagated — it must not fail the originating write).
   * Also runs alt_labels discovery for the written tables (CL-1 Phase 3).
   * Uses the substrate `enrichAllDwsTables` (which writes via substrate
   * `writeTable`), so the hook does NOT re-enter the Service write path. DIM
   * tables are skipped by `enrichAllDwsTables`. Gated by `autoEnrich`.
   * @param names - the table_names just written via syncWrite/updateTableMeta.
   */
  private async enrichOnWrite(names: readonly string[]): Promise<void> {
    if (!this.resolved.autoEnrich || names.length === 0) return
    try {
      // mergeExisting=true: the auto on-write hook MERGES discovered refs with
      // any existing dimension_refs (curated joins preserved) rather than
      // replacing — so auto-trigger can never wipe human-curated joins the
      // deterministic round does not rediscover (code-review B2).
      // CL-18 Phase 2: forward buildExcludeColumns so partition-column PK
      // matches (e.g. ds-only DIM snapshots) do not add noise JOIN relations.
      const res = await enrichAllDwsTablesFromLayer(this.semanticRoot, this.llmCall, names, true, buildExcludeColumns)
      if (res.errors.length > 0) {
        this.ctx.logger.warn(`ctx.schema on-write relation enrichment partial failures: ${res.errors.join('; ')}`)
      }
    } catch (e) {
      this.ctx.logger.warn(`ctx.schema on-write relation enrichment failed: ${(e as Error).message}`)
    }
    // CL-1 Phase 3: also discover alt_labels for the written tables
    try {
      const res = await enrichAllTablesAltLabelsFromLayer(this.semanticRoot, this.llmCall, names)
      if (res.errors.length > 0) {
        this.ctx.logger.warn(`ctx.schema on-write alt_labels enrichment partial failures: ${res.errors.join('; ')}`)
      }
    } catch (e) {
      this.ctx.logger.warn(`ctx.schema on-write alt_labels enrichment failed: ${(e as Error).message}`)
    }
  }

  /** The semantic-layer scope root (the dir with config.yaml/events/tables), or
   * empty string when unset. P1: delegates to `ctx.scopes.active().semanticRoot`
   * when the scope-registry is mounted; otherwise falls back to static config. */
  get semanticRoot(): string {
    const active = this.scopes()?.active()
    if (active !== undefined) return active.semanticRoot
    return this.resolved.semanticRoot
  }

  /** The default scope id for Tier-2 audit + schema discovery, or empty string
   * when unset. P1: delegates to `ctx.scopes.activeId()` when the scope-registry
   * is mounted; otherwise falls back to static config. */
  get scopeId(): string {
    const id = this.scopes()?.activeId()
    if (id !== undefined) return id
    return this.resolved.scopeId
  }

  /** D2h: the enrichment variant (mount-time config); 'params+term' (D2e-shipped) by default. */
  get corpusVariant(): CorpusVariant {
    return this.resolved.corpusVariant
  }

  // ── substrate definitions (P13b swap target: params_fields / partitions) ──
  /**
   * Load a validated event definition by name from the substrate.
   * @param name - the event `name` key to match.
   * @returns the parsed `EventDefinition`, or null when no event matches.
   */
  loadEventDefinition(name: string): EventDefinition | null {
    return loadEventDefinitionFromLayer(this.semanticRoot, name)
  }

  /**
   * Load a validated table definition by name from the substrate.
   * @param name - the table `table_name` key to match.
   * @param scopeId - GA-GT1 Phase 2: optional scope id; omit to use the active scope (backward-compatible).
   * @returns the parsed `TableDefinition`, or null when no table matches.
   */
  loadTableDefinition(name: string, scopeId?: string): TableDefinition | null {
    return loadTableDefinitionFromLayer(this.resolveRoot(scopeId), name)
  }

  /**
   * Load a validated metric definition by name from the substrate.
   * @param name - the metric `name` key to match (`<host>__<key>`).
   * @returns the parsed `MetricDefinition`, or null when no host table/event defines a metric with this name.
   */
  loadMetricDefinition(name: string): MetricDefinition | null {
    // M1 virtual projection: derive a metric on demand from its host table or
    // event `metrics:` block. The metric name is `<host>__<key>` (see
    // `metricName`); split via `splitMetricName` to recover the host + key,
    // then look the key up in the host's inline metrics block. No standalone
    // `metrics/*.yaml` files are read.
    const parts = splitMetricName(name)
    if (parts === null) return null
    const { host, key } = parts
    const table = loadTableDefinitionFromLayer(this.semanticRoot, host)
    if (table !== null) {
      const m = table.metrics[key]
      if (m !== undefined) return toMetricDefinition(host, key, m, table.domains)
    }
    const event = loadEventDefinitionFromLayer(this.semanticRoot, host)
    if (event !== null) {
      const m = event.metrics[key]
      if (m !== undefined) return toMetricDefinition(host, key, m, event.domains)
    }
    return null
  }

  /**
   * Load a validated concept definition by name from the substrate.
   * @param name - the concept `name` key to match.
   * @returns the parsed `ConceptDefinition`, or null when no concept matches.
   */
  loadConceptDefinition(name: string): import('./types.ts').ConceptDefinition | null {
    return loadConceptDefinitionFromLayer(this.semanticRoot, name)
  }

  /**
   * Build an enriched retrieval corpus from the substrate — each event's
   * `alt_labels` (SKOS aliases) + `params_fields` packed into the indexed
   * `description`. The `corpusVariant` config selects slices: 'params+term'
   * (default) packs both; 'term-only' packs aliases only.
   * @param scopeId - GA-GT1 Phase 2: optional scope id; omit to use the active scope (backward-compatible).
   * @returns enriched corpus items ready for `Bm25Linker` / `HybridRetriever` indexing.
   */
  loadRetrievalCorpus(scopeId?: string): readonly EventCorpusItem[] {
    return loadRetrievalCorpusFromLayer(this.resolveRoot(scopeId), this.corpusVariant)
  }

  // ── W11 C1: MVCC query snapshot ──────────────────────────────────────────

  /**
   * W11 C1: Capture a point-in-time snapshot of the semantic layer definitions.
   * The returned `DefinitionSnapshot` provides the same read API
   * (`loadTableDefinition`, `loadEventDefinition`, `loadMetricDefinition`,
   * `loadRetrievalCorpus`) but the data is pinned at the version when captured.
   * Subsequent `invalidateCaches()` calls (from management-session writes) do
   * NOT affect the returned snapshot. The next call to `acquireSnapshot` after
   * a write sees the new data.
   *
   * Cheap: if the corpus version has not changed since the last call, the
   * cached data arrays are reused (no disk re-scan).
   *
   * GA-GT1 Phase 2: an optional `scopeId` resolves a per-request scope's root
   * + corpus version (via `resolveRoot`/`corpusVersion(scopeId)`); the no-arg
   * path is unchanged (active scope — backward-compatible).
   * @param scopeId - optional scope id; omit to use the active scope (backward-compatible).
   * @returns a frozen `DefinitionSnapshot` pinned at the current corpus version.
   */
  acquireSnapshot(scopeId?: string): DefinitionSnapshot {
    return captureSnapshot(this.resolveRoot(scopeId), this.corpusVersion(scopeId), this.corpusVariant)
  }

  /**
   * W11 C1: Execute `fn` with a consistent snapshot — definitions do not
   * reload mid-execution even if `invalidateCaches` fires concurrently (e.g.
   * from a management-session write). The snapshot is acquired before `fn` and
   * released after (release is a no-op in v1; reserved for future GC).
   *
   * Usage (in the NL2SQL query engine):
   * ```ts
   * const sql = await ctx.schema.withSnapshot(async (snap) => {
   *   const table = snap.loadTableDefinition('dws_pay_order_di')
   *   const event = snap.loadEventDefinition('game.pay.order')
   *   // ... generate SQL using pinned definitions ...
   *   return generatedSql
   * })
   * ```
   *
   * @param fn - the async function to execute with a pinned snapshot.
   * @returns the value returned by `fn`.
   */
  async withSnapshot<T>(fn: (snap: DefinitionSnapshot) => Promise<T>): Promise<T> {
    const snap = this.acquireSnapshot()
    try {
      return await fn(snap)
    } finally {
      // v1: release is a no-op. Reserved for future reference-counted GC
      // (e.g. evicting old snapshot data when no in-flight queries hold it).
    }
  }

  /**
   * D2f (2026-08-21): the corpus-version counter for this layer - a monotonic
   * signal bumped by every writer via `invalidateCaches` (writeEventYaml /
   * writeTable / updateTableMeta / syncWriteDefinitions). Probed structurally
   * by `tool-search-data-sources` (no static dep) so its cached enriched
   * Bm25Linker rebuilds after a mid-session event edit instead of staying stale
   * until reboot (D2e-deferred cache-invalidation). Reads the per-path counter
   * for `this.semanticRoot` (0 until the first write).
   * @param scopeId - optional per-request scope; when omitted, the undefined (root) path's counter is read.
   * @returns the current corpus-version counter.
   */
  corpusVersion(scopeId?: string): number {
    if (scopeId !== undefined) {
      // GA-GT1 Phase 2: per-request scope path — the per-scope cache is keyed
      // by scopeId (switch-back collision is handled by keying, not by epoch),
      // so only the substrate's per-path content counter is needed here. The
      // epoch stays for the undefined path (Phase 4 removes it entirely). M-2:
      // delegates to corpusVersionForRoot(resolveRoot) so getRelationGraph
      // (scopeId) can share the resolveRoot result + avoid a duplicate
      // resolveRoot/YAML read (resolveRoot re-runs scopes()→ctx.get('scopes')
      // →reg.get→load()→readFileSync each call).
      return this.corpusVersionForRoot(this.resolveRoot(scopeId))
    }
    // P1: lazily detect an active-scope change (no event listener — keeps the
    // constructor free of ctx side-effects, so test stand-ins without ctx.on
    // still construct the Service). When the active scope id differs from the
    // last call, bump the epoch; the first call only records the id (no bump, so
    // an unmounted scope-registry keeps epoch=0 = unchanged pre-P1 behavior).
    //
    // Combine the epoch with the substrate's per-path content counter: the
    // consumer (tool-search-data-sources) caches its BM25 linker in a
    // WeakMap<instance, {version}> keyed by THIS instance + the number returned;
    // the instance is the same singleton across scope switches, so the number
    // alone must change on every switch — including switch-BACK, where the new
    // scope's per-path counter can otherwise collide with the cached value and
    // serve the wrong scope's corpus. 1e6 offsets the small per-path counter out
    // of the epoch's bits (per-path counters stay << 1e6; if a single path ever
    // reached 1e6 writes/session its value would collide with the next epoch's
    // zero-counter — reopening the stale-linker bug — so do not raise this
    // constant lightly; Number.MAX_SAFE_INTEGER allows ~9e9 switches).
    const currentId = this.scopes()?.activeId()
    if (this.hasObservedScope && currentId !== this.lastScopeId) {
      this.scopeEpoch++
    }
    this.lastScopeId = currentId
    this.hasObservedScope = true
    return this.scopeEpoch * 1_000_000 + getCorpusVersionFromLayer(this.semanticRoot)
  }

  /**
   * M-2: the corpus-version counter for a RESOLVED root — the substrate's
   * per-path content counter (0 until the first invalidateCaches on that
   * path). Factored out of the `corpusVersion(scopeId)` scopeId path so
   * `getRelationGraph(scopeId)` can resolve the root ONCE + reuse the version
   * without a second `resolveRoot` (which re-runs `scopes()`→
   * `ctx.get('scopes')`→`reg.get`→`load()`→`readFileSync`). The no-arg path
   * does NOT route here — it combines `scopeEpoch` + the active root's counter
   * inline (byte-for-byte unchanged).
   * @param root - the resolved semantic-layer root path.
   * @returns the per-path corpus-version counter for `root`.
   */
  private corpusVersionForRoot(root: string): number {
    return getCorpusVersionFromLayer(root)
  }

  // ── live-engine schema (deferred; throws until a provider is mounted) ──
  /**
   * List tables in a scope (optionally filtered by kind) via the mounted provider.
   * @param scopeId - the scope to discover tables in.
   * @param kind - optional kind filter forwarded to the provider.
   * @returns a readonly array of table metas, or throws when no provider is mounted.
   */
  async discover(scopeId: string, kind?: string): Promise<readonly TableMeta[]> {
    if (this.provider === undefined) {
      throw new Error('ctx.schema.discover: no live-engine schema provider mounted (P6b Q3 deferred; mount query-maxcompute schema provider or setSchemaProvider)')
    }
    return this.provider.discover(scopeId, kind)
  }

  /**
   * Describe one table's columns/partitions/comment via the mounted provider.
   * @param tableName - the table name to describe.
   * @returns the table's meta, or null when the table is unknown / no provider is mounted.
   */
  async describe(tableName: string): Promise<TableMeta | null> {
    if (this.provider === undefined) {
      throw new Error('ctx.schema.describe: no live-engine schema provider mounted (P6b Q3 deferred)')
    }
    return this.provider.describe(tableName)
  }

  /**
   * Sample N rows of a table as formatted text via the mounted provider.
   * @param tableName - the table name to sample.
   * @param n - optional row count to sample (provider default applies when omitted).
   * @returns the formatted sample text, or throws when no provider is mounted.
   */
  async sample(tableName: string, n?: number): Promise<string> {
    if (this.provider === undefined) {
      throw new Error('ctx.schema.sample: no live-engine schema provider mounted (P6b Q3 deferred)')
    }
    return this.provider.sample(tableName, n)
  }

  // ── Tier-2 persistent writes (via ctx.audit; D5 non-disableable) ──
  private recorder(): Tier2Recorder {
    const audit = this.ctx.get('audit')
    if (audit === undefined) {
      throw new Error('ctx.schema Tier-2 write requires ctx.audit (Tier-2 audit is non-disableable, D5; mount @deepseek-ai/dsh-audit)')
    }
    return audit
  }

  /**
   * Tier-2 persistent write: batch-generate/merge table YAML from pre-fetched
   * schema metas and write them to the substrate, recording each write via
   * `ctx.audit` (D5 non-disableable). Routes to `syncWriteDefinitions`. G3:
   * after the batch, the on-write hook re-runs DWS→DIM discovery for the
   * written tables (gated by `autoEnrich`).
   * @param tableMetas - the table metas to write (from discover/describe).
   * @param opts - optional dim-table-name set, existing-table map for merge, and scope id override.
   * @returns counts of written/skipped tables plus per-table error messages.
   */
  async syncWrite(
    tableMetas: readonly TableMeta[],
    opts: {
      readonly dimTableNames?: Set<string>
      readonly existingTables?: Map<string, Record<string, unknown>>
      readonly scopeId?: string
    } = {},
  ): Promise<{ written: number; skipped: number; errors: string[] }> {
    const res = await syncWriteDefinitionsFromLayer(this.resolveRoot(opts.scopeId), tableMetas, {
      recorder: this.recorder(),
      scope_id: opts.scopeId ?? this.scopeId,
      ...opts.dimTableNames !== undefined ? { dimTableNames: opts.dimTableNames } : {},
      ...opts.existingTables !== undefined ? { existingTables: opts.existingTables } : {},
    })
    if (this.resolved.autoEnrich) {
      const written = tableMetas.filter(m => m.table_name).map(m => m.table_name)
      await this.enrichOnWrite(written)
    }
    return res
  }

  /**
   * Tier-2 per-scope write: read-merge-validate-write a single table's meta
   * updates, recording the write via `ctx.audit` (D5 non-disableable). G3:
   * after the write, the on-write hook re-runs DWS→DIM discovery for the table
   * (gated by `autoEnrich`).
   * @param name - the table `table_name` to update.
   * @param updates - the field overrides merged over the existing table YAML.
   * @param opts - optional scope id override (default scope id is used when omitted).
   * @returns `{ ok: true, table_name }` on success, or `{ ok: false, error }` when the table is missing/malformed or validation fails.
   */
  async updateTableMeta(
    name: string,
    updates: Record<string, unknown>,
    opts: { readonly scopeId?: string } = {},
  ): Promise<{ ok: true; table_name: string } | { ok: false; error: string }> {
    const res = await updateTableMetaFromLayer(this.resolveRoot(opts.scopeId), name, updates, {
      recorder: this.recorder(),
      scope_id: opts.scopeId ?? this.scopeId,
    })
    if (res.ok && this.resolved.autoEnrich) {
      await this.enrichOnWrite([name])
    }
    return res
  }

  /**
   * Tier-2 per-scope write: read-merge-validate-write a single event's meta
   * updates, recording the write via `ctx.audit` (D5 non-disableable). Parallel
   * to `updateTableMeta` for the event substrate (A13 TOCTOU lost-update fix):
   * the substrate re-reads the latest on-disk event YAML at write time and
   * shallow-merges `updates` on top, so a concurrent edit between load+write
   * is no longer silently overwritten.
   *
   * The on-write event enrichment hook (parallel to `enrichOnWrite` for tables)
   * remains deferred — see the note on `discoverEventRelations`. This method
   * closes the "no Service-level event-write path" gap by routing through the
   * substrate `updateEventMeta` (Tier-2 audited) instead of the raw-edit
   * `writeEventYaml` surface.
   * @param name - the event `name` to update (must already exist on disk).
   * @param updates - the field overrides merged over the existing event YAML.
   * @param opts - optional scope id override (default scope id is used when omitted).
   * @returns `{ ok: true, event_name }` on success, or `{ ok: false, error }` when the event is missing/malformed or validation fails.
   */
  async updateEventMeta(
    name: string,
    updates: Record<string, unknown>,
    opts: { readonly scopeId?: string } = {},
  ): Promise<{ ok: true; event_name: string } | { ok: false; error: string }> {
    return updateEventMetaFromLayer(this.resolveRoot(opts.scopeId), name, updates, {
      recorder: this.recorder(),
      scope_id: opts.scopeId ?? this.scopeId,
    })
  }
}

/**
 * Stand-in live-engine schema provider (P6b Q3 deferred). Mirrors the P6
 * prototype's `schema-stub.mjs` fake tables so the decoupled sync flow
 * (discover -> TableMeta[] -> generate/merge YAML -> write) is demoable +
 * testable without the engine. Production mounts a real provider (follow-up).
 */
export class StandInSchemaProvider implements SchemaProvider {
  private readonly tables: Readonly<Record<string, TableMeta>>

  constructor(tables: Readonly<Record<string, TableMeta>>) {
    this.tables = tables
  }

  discover(_scopeId: string, kind?: string): Promise<readonly TableMeta[]> {
    const all = Object.values(this.tables)
    const filtered = kind === undefined ? all : all.filter(t => (t.comment ?? '').includes(kind))
    return Promise.resolve(filtered)
  }

  describe(tableName: string): Promise<TableMeta | null> {
    return Promise.resolve(this.tables[tableName] ?? null)
  }

  sample(tableName: string, n = 5): Promise<string> {
    return Promise.resolve(`(stand-in sample of ${tableName}, ${n} rows)`)
  }
}

/**
 * A text-only LLM seam: `text(prompt) -> string`. Production `ctx.llm`
 * (BlockAssembler-assembled text) satisfies this once mounted. Declared here
 * so the substrate + the wiring adapter stay free of the LLM dependency.
 */
export interface TextLlm {
  text(prompt: string): Promise<string>
}

/**
 * Wire a text-LLM into a schema service's enrichment `llmCall` seam. After
 * this, `discoverRelations` / `discoverEventRelations` / the on-write hook
 * run the LLM semantic round (absent => deterministic round only).
 *
 * Production (once the bundle mounts `ctx.schema` + `ctx.llm`):
 *   `wireEnrichmentLlm(ctx.schema, ctx.llm)`
 * The adapter wraps `llm.text` as the substrate's `LlmCall = (prompt) => Promise<string>`.
 * @param schema - the `SemanticLayerService` (or a structural `{ setLlmCall }` test double).
 * @param llm - the text-LLM to adapt.
 */
export function wireEnrichmentLlm(schema: { setLlmCall(fn?: (prompt: string) => Promise<string>): void }, llm: TextLlm): void {
  schema.setLlmCall(prompt => llm.text(prompt))
}

/**
 * Extract alias data (pref_label + alt_labels) structurally from any
 * definition object, so the relation graph's alias index works for a kind
 * registered after build without a per-kind field read. Returns `null` when
 * the def carries no aliases.
 * @param def - a parsed definition object (any kind — table, event, concept, metric, or a new kind).
 * @param nodeId - the node id this def's aliases should be indexed under.
 * @returns the alias data, or `null` when the def has no pref_label / alt_labels.
 */
function graphAliasData(def: unknown, nodeId: string | undefined): NodeAliasData | null {
  if (nodeId === undefined) return null
  if (typeof def !== 'object' || def === null) return null
  const d = def as Record<string, unknown>
  const prefLabel = typeof d.pref_label === 'string' ? d.pref_label : undefined
  const altRaw = d.alt_labels
  const altLabels = Array.isArray(altRaw) ? altRaw.filter((s): s is string => typeof s === 'string') : undefined
  if (!prefLabel && (!altLabels || altLabels.length === 0)) return null
  return { nodeId, prefLabel, altLabels }
}

export default SemanticLayerService

/**
 * The substrate's public entry — the one importable path (`"."`).
 *
 * `SemanticGroundingCore` is a **plain class**, not a plugin. It imports no host
 * framework and takes every collaborator through a setter:
 *
 *     const core = new SemanticGroundingCore({ semanticRoot, scopeId })
 *     core.setTier2Recorder(recorder)   // REQUIRED before any auditable write (D5)
 *     core.setSchemaProvider(provider)  // optional
 *     core.dispose()
 *
 * A host wraps it; it does not mount into a host. The dsh adapter is what
 * exposes it as a cordis `Service` under the `ctx.schema` seam and declares the
 * `Context` augmentation — none of that lives here. See GLOSSARY.md
 * § core / shell / adapter, and `scripts/check-core-purity.mjs` (the negation
 * test, now running with an empty shell allow-list).
 *
 * ## Enrichment (G3, resolved 2026-08-22)
 *
 *  - `discoverRelations(opts)` delegates to `enrichAllDwsTables` (DWS→DIM
 *    discovery, deterministic round only — the in-process LLM callback seam
 *    was removed in S1.2; the LLM half of enrichment is the agent-driven
 *    ask-answer loop below).
 *  - On-write hook: after `updateTableMeta` writes a DWS, discovery
 *    re-runs and persists `dimension_refs` (best-effort, unaudited because
 *    auto-derived; gated by `autoEnrich`, default true). It persists through the
 *    module-level `writeTable`, so the hook does **not** re-enter the class's
 *    write path — that is what keeps it from recursing.
 *
 * ## Enrichment's LLM half (ADR-0006, resolved 2026-10-09)
 *
 *  - `listEnrichmentWork(opts)` / `applyEnrichmentResults(results, recorder)` are the
 *    agent-driven ask-answer loop the MCP management surface's `get_enrichment_work` /
 *    `apply_enrichment` tools compile onto: a work item is a definition whose relation
 *    or alt_labels array is still empty, offered as a self-contained
 *    `{work_id, target, gap, prompt}` (the baseline fingerprint lives inside `work_id`,
 *    so a server restart between the two calls orphans nothing). This
 *    ask-answer pair is the only LLM form (S1.2 removed the in-process
 *    LLM callback that used to parallel it), and neither adds a name
 *    to this barrel (the pure prompt/parse/merge family stays in
 *    `enrichment-work.ts`, same as `enrichment.ts`'s).
 *  - `discoverRelations` / `discoverEventRelations` / `discoverAltLabels`'s existing
 *    `tier2` parameter (#18) now also composes with a recorder's `beginBatch`: when
 *    the `Tier2Recorder` passed in has an open batch (`GitTier2Recorder.beginBatch`,
 *    #21), every table/event write these make lands in that one commit instead of one
 *    commit per write — no change to these methods' own signatures or bodies, because
 *    the absorption lives in the recorder, not here. `run_enrichment` is what opens
 *    that batch before calling them.
 *
 * ## Historical context (no longer describes this file)
 *
 * This started life as `packages/data/semantic-layer/` inside
 * `deepseek-harness-da`, where it *was* a cordis `Service` shell. Two of that
 * era's decisions are worth keeping because they still explain the shape:
 *
 *  - **Live-engine reads are deferred.** `discover`/`describe`/`sample` throw
 *    "no provider" until a `SchemaProvider` is set; `StandInSchemaProvider`
 *    covers demo/tests. Definition reads never needed a live engine, which is
 *    why they were unblocked independently.
 *  - **Tier-2 audit is non-disableable (D5).** Originally the recorder was
 *    `ctx.audit`, found via the host; slice 2 ② made it a setter. The guarantee
 *    is unchanged — an auditable mutation with no recorder **throws** — and
 *    ADR-0001 is explicit that dropping the check instead would preserve the
 *    behaviour while losing the guarantee.
 *  - **zod, not schemastery**, for the domain model (schemastery has no
 *    `.passthrough`). schemastery only ever typed the cordis mount-time
 *    `static Config`, and left with the shell in slice 4a.
 *
 * @module . (the substrate's only importable path — see ADR-0002; the
 *          name-level allow-list of what this barrel re-exports is ADR-0003)
 */
// No host-framework import. Slice 2 ③ removed `{ Context, Service }` from
// '@deepseek-ai/cordis' and the `z` from '@deepseek-ai/schemastery' that only
// existed to type the cordis mount-time `static Config`. Both now live in the
// dsh adapter, which wraps this core as a cordis Service.
import {
  updateTableMeta as updateTableMetaFromLayer,
  updateEventMeta as updateEventMetaFromLayer,
  loadEventDefinition as loadEventDefinitionFromLayer,
  loadTableDefinition as loadTableDefinitionFromLayer,
  loadRetrievalCorpus as loadRetrievalCorpusFromLayer,
  getCorpusVersion as getCorpusVersionFromLayer,
  definitionVersion,
  type Tier2Recorder,
  type Tier2Opts,
} from './io.ts'
import type { TableMeta, EventDefinition, TableDefinition, MetricDefinition, ItemVerdict, AddVerdict } from './types.ts'
import { type CorpusVariant, type EventCorpusItem } from './corpus.ts'
import {
  enrichAllDwsTables as enrichAllDwsTablesFromLayer,
  enrichAllEvents as enrichAllEventsFromLayer,
  enrichAllEventsAltLabels as enrichAllEventsAltLabelsFromLayer,
  enrichAllTablesAltLabels as enrichAllTablesAltLabelsFromLayer,
  assertKnownFilterNames,
} from './enrichment.ts'
// ADR-0006: the LLM half of enrichment's agent-driven ask-answer loop
// (listEnrichmentWork / getEnrichmentPrompts / applyEnrichmentResults). The pure
// prompt-building, work_id encode/decode, and lenient-merge logic stays in
// enrichment-work.ts (internal, off the barrel — ADR-0002/0003); these class
// methods are thin wrappers, same split as discoverRelations wrapping
// enrichAllDwsTablesFromLayer. (The free `discoverAltLabels` combined wrapper is no
// longer called from here: ADR-0007's call-wide pair reading needs per-leg calls so
// an omitted dimension can be OUT of the call, which the combined wrapper's
// omit=everything contract cannot express — its own contract is unchanged.)
import { listEnrichmentWorkItems, fetchEnrichmentPrompts, applyEnrichmentResultsBatch, peekWorkIdTarget } from './enrichment-work.ts'
// #49's item-write ritual: the helper family + the six entry functions that
// the four public item methods below forward into — the same off-barrel
// internal-module split as enrichment-work.ts (ADR-0002/0003).
import { addItemAliases, removeItemAliases, addItemRelations, removeItemRelations, type ItemKind, type RelationInput } from './item-write.ts'
import { withReadEpoch } from './read-epoch.ts'
import { DataSourceRegistry, type CorpusItem, type GraphNodeProjection } from './registry.ts'
import { eventKindPlugin } from './kinds/event-kind.ts'
import { tableKindPlugin } from './kinds/table-kind.ts'
import { conceptKindPlugin } from './kinds/concept-kind.ts'
import { RelationGraph, type NodeAliasData } from './relation-graph.ts'
import { toMetricDefinition, splitMetricName } from './metrics.ts'
import { loadEvents, loadTables, loadConcepts, loadRawDir, loadConceptDefinition as loadConceptDefinitionFromLayer, writeConceptYaml as writeConceptYamlFromLayer, updateConceptMeta as updateConceptMetaFromLayer, type WriteConceptYamlResult } from './io.ts'
import { EventDefinitionSchema, TableDefinitionSchema, ConceptDefinitionSchema } from './types.ts'
import { DefinitionSnapshot, captureSnapshot } from './snapshot.ts'
import { buildExcludeColumns } from './io.ts'
import type { SchemaProvider } from './schema-provider.ts'

// ── logic exports (substrate; consumers + tests use directly) ───────────
// v0.1 name-level allow-list (ADR-0003): every name below carries recorded
// (a)/(b)/(c) evidence. The source modules still export their full internals —
// in-repo tests import them directly — but only this list is public. The
// 11 zod sub-model schemas + their inferred types stay in types.ts (internal):
// no public signature takes one, and z.infer expands in the shipped .d.ts.
export {
  EventDefinitionSchema,
  TableDefinitionSchema,
  ConceptDefinitionSchema,
  type TableDefinition,
  type EventDefinition,
  type ConceptDefinition,
  type MetricDefinition,
  type TableMeta,
  type ItemVerdict,
} from './types.ts'
// W11 C1: MVCC query snapshot — consistent point-in-time view during query execution.
// clearSnapshotCache / getSnapshotCacheSize / SNAPSHOT_CACHE_MAX stay in
// snapshot.ts (internal): own-JSDoc test utilities, no host consumer (ADR-0003).
export { DefinitionSnapshot, captureSnapshot } from './snapshot.ts'
export { RelationGraph, type NodeAliasData, type RelationEdge } from './relation-graph.ts'
export {
  dumpYaml,
  invalidateCaches,
  resolveSemanticLayer,
  loadConfig,
  loadEvents,
  loadTables,
  loadConcepts,
  writeTable,
  writeEventYaml,
  StaleBaselineError,
  type RawEvent,
  type RawTable,
  type RawConcept,
  type Tier2Recorder,
  type Tier2Opts,
  type Tier2Batch,
  type Tier2RecordMeta,
  type WriteTableResult,
  type WriteConceptYamlResult,
  type WriteEventYamlResult,
  type UpdateTableMetaResult,
  type UpdateEventMetaResult,
} from './io.ts'
// Off the barrel per ADR-0003, still exported from io.ts for in-repo tests:
// loadDomains (legacy domains.yaml, superseded by the concept kind),
// loadEventDefinition/loadTableDefinition/loadConceptDefinition (the core
// class exposes the same reads as methods), loadRawDir, loadRetrievalCorpus
// (core.loadRetrievalCorpus is the public route), and — off since S1.5 (#85) —
// updateTableMeta/updateEventMeta: Tier-2-audited writes whose public route
// is the Core class's same-named methods; the io functions stay for in-repo
// tests and the class's own wrappers.
export { submit, load as loadPending, listing, discard, type PendingSuggestion, type SubmitArgs } from './pending.ts'
// isValidId stays in pending.ts (internal, off since S1.5 #85): the pending
// store's own id rule has no host consumer — the MCP suggestion tools check
// existence through listing/lookup, not by validating id shape.
export {
  type CorpusVariant,
  type EventCorpusItem,
} from './corpus.ts'
// buildRetrievalCorpus + EventCorpusInput stay in corpus.ts (internal): the
// public corpus route is core.loadRetrievalCorpus (ADR-0003).
// G3: AI-Native enrichment substrate (B1/B2) + mechanical metrics extraction (B5).
// CL-1 Phase 3: alt_labels enrichment (G3 同構).
// The enrichment pipeline itself (enrichAll*, discover*Deterministic, the
// build*/parse*/merge* prompt internals, AltLabelsTarget/DimInventoryEntry) is
// convention-coupled (DWS→DIM typing, CJK label heuristics, k11-sized metric
// keys) with no production host consumer — off the public barrel per
// ADR-0002's convention clause. The public entry is the core class's
// discoverRelations / discoverEventRelations / discoverAltLabels.
// #31 (ADR-0007): on the barrel for the same reason #18 put 'StaleBaselineError'
// here (acceptance script's own evidence note) — the MCP host needs instanceof to
// tell the dimension-filter door rejection apart from every other discovery failure
// and map it onto its coded -31040 wire error, plus the one whole-call guard call
// that makes a fan-out (run_enrichment's three discovery methods) report BOTH
// dimensions' unknown names, not just the first leg's. ADR-0002 evidence class (b):
// a confirmed host requirement (the MCP management surface). Error class and guard
// only; the Core methods remain the public door for in-process hosts.
export { UnknownFilterNamesError, assertKnownFilterNames } from './enrichment.ts'
// The whole metrics projection family stays in metrics.ts (internal): the
// five formerly public projections (extractMetricsFromTable/extractMetricsFromEvent,
// deriveMetricRelations, projectMetricCorpusItem, loadMetricDefinitions) joined
// metricName/splitMetricName/inferAggregation/toMetricDefinition/metricGraphNode/
// extractMetricsFromTables off the barrel in S1.5 (#85) — the table/event kind
// plugins' derivedNodes + the Core class's registry-driven projections are the
// public route; no host ever imported the free functions (ADR-0003).
// W27: data-source kind registry contract (kinds, relations, graph projection).
export {
  DataSourceRegistry,
  type DataSourceKindPlugin,
  type SchemaLike,
  type CorpusItem,
  type RelationDef,
  type GraphNodeProjection,
  type DerivedNodeContributor,
  type KindGrouping,
} from './registry.ts'

// The three built-in kind plugins. On the public surface because registering a
// kind is the substrate's one extension point: a host composing its own
// registry needs the built-ins to compose *with*, and `retrieval-experiment`
// (dsh) builds a graph from exactly these three. Slice 3: these were reachable
// only through the deleted `exports["./src/*"]` wildcard.
export { tableKindPlugin } from './kinds/table-kind.ts'
export { eventKindPlugin } from './kinds/event-kind.ts'
export { conceptKindPlugin } from './kinds/concept-kind.ts'

// ── SchemaProvider: live-engine schema source (P6b Q3 deferred) ───────────
// Moved to ./schema-provider.ts in slice 5 so its test stand-in
// (StandInSchemaProvider) can live beside it without being on the public
// barrel (ADR-0003: test double, no host consumer). Re-exported here because
// setSchemaProvider's signature needs it and it is a documented extension seam.
export type { SchemaProvider } from './schema-provider.ts'

// ── On-write enrichment health (slice 2 ②) ────────────────────────────────
// The on-write enrichment hook is best-effort by design: a failure must not
// fail the originating write. Before slice 2 ② that meant its failures went to
// `ctx.logger.warn` and nowhere else — `enrichOnWrite` returns void, so the
// information had exactly one exit and that exit was a host log line.
//
// That is the wrong shape for this domain. A failed enrichment round means the
// definition is missing derived facts (`dimension_refs`, `alt_labels`) that
// retrieval and prompt-context projection depend on, so a consumer asking
// "is my understanding of this table complete?" could not find out. Provenance
// is supposed to answer "why is this field's value what it is"; "the round that
// would have filled it failed" is part of that answer.
//
// These records are now a structured health surface, mirroring the existing
// `getDanglingDomainRefs()` pattern: reset at the start of each hook run, read
// back via `getEnrichmentHealth()`.
/** Which deterministic+semantic enrichment round a health record came from. */
export type EnrichmentRound = 'relation' | 'alt_labels'
/** One failed (or partially failed) on-write enrichment round. */
export interface EnrichmentHealthEntry {
  /** The round that did not fully succeed. */
  readonly round: EnrichmentRound
  /** `'partial'` — the round ran and some tables failed; `'failed'` — the whole round threw. */
  readonly outcome: 'partial' | 'failed'
  /** The `table_name`s the round was asked to enrich. */
  readonly tables: readonly string[]
  /** Per-table error messages (`'partial'`), or the single thrown message (`'failed'`). */
  readonly errors: readonly string[]
}

// ── CL-18 Phase 2: partition-column exclude set ────────────────────────────
// buildExcludeColumns moved to ./io.ts in slice 5 (convention-coupled
// fallback list; off the public barrel per ADR-0003). Imported above for the
// discoverRelations exclude-columns seam.

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
   * (updateTableMeta). Default true (G3: core capability, not an
   * optional hook). Set false to suppress (e.g. during bulk sync). */
  readonly autoEnrich?: boolean
}

/** Resolved config: all cfg defaults applied ONCE in the constructor into a
 * typed object with REQUIRED fields (Cordis CONVENTIONS.md "no hardcoded
 * tunables" + "defaulting is an explicit `resolve(request): Spec` step, never
 * a hidden `?? default` inside run()"). Use sites read resolved fields — no
 * inline `?? default` tunables scattered across the implementation. Mirrors
 * the `resolveEnrichmentLlmConfig` pattern that moved out with the shell in
 * slice 4a (now in the dsh adapter). */
interface ResolvedSemanticLayerConfig {
  /** Semantic-layer scope root (the dir with config.yaml/events/tables); '' when unset. */
  readonly semanticRoot: string
  /** Default scope id for Tier-2 audit + schema discovery; '' when unset. */
  readonly scopeId: string
  /** D2h enrichment variant — 'params+term' (default, D2e-shipped) or 'term-only'. */
  readonly corpusVariant: CorpusVariant
  /** G3 auto-run DWS→DIM relation discovery after a Service write. Default true. */
  readonly autoEnrich: boolean
}

// The `ctx.schema` Context augmentation lives in the dsh adapter. Slice 2 ③
// moved it out of core and into `src/llm-wiring-plugin.ts`; slice 4a then moved
// that shell out of this package entirely. Declaring the seam from here would
// re-couple core to the host it no longer imports — which is exactly what
// `scripts/check-core-purity.mjs` now forbids with an empty allow-list.

/** CONVENTIONS.md "explicit resolve step": apply cfg defaults ONCE into a
 * typed resolved-config object (required fields), so run()-path use sites
 * carry no inline `?? default` tunables. This is the single defaulting point;
 * every other read uses `this.resolved.<field>` directly. */
function resolveSemanticLayerConfig(config: SemanticLayerConfig): ResolvedSemanticLayerConfig {
  return {
    semanticRoot: config.semanticRoot ?? '',
    scopeId: config.scopeId ?? '',
    corpusVariant: config.corpusVariant ?? 'params+term',
    autoEnrich: config.autoEnrich ?? true,
  }
}

/**
 * The semantic grounding core — a plain class with no host framework.
 *
 * Gives a text-to-SQL agent a typed, structured understanding of a data domain:
 * substrate definitions (load_*, sync-read), the relation graph and retrieval
 * corpus projections, provenance-carrying enrichment, and Tier-2 persistent
 * writes. Live-engine schema access (discover/describe/sample) is delegated to
 * an injectable `SchemaProvider` (P6b Q3 deferred).
 *
 * **Embedding.** Construct it, then wire the collaborators the host can supply.
 * Every seam is a setter; none is looked up by name:
 *
 * ```ts
 * const core = new SemanticGroundingCore({ semanticRoot, scopeId })
 * core.setTier2Recorder(recorder)    // REQUIRED before any auditable write (D5)
 * core.setSchemaProvider(provider)   // optional — discover/describe/sample throw without one
 * // ...
 * core.dispose()                     // releases the kind registrations + cache listener
 * ```
 *
 * Nothing above is cordis-specific, and the class imports no host framework
 * (slice 2 ③, map #1). A host adapts it by wrapping, not by being reached for:
 * the dsh adapter wraps this as a cordis `Service` exposing the `ctx.schema`
 * seam and forwards `ctx.audit` into the setters above.
 *
 * Instances are independent — the recorder and provider are per-instance
 * state — so one process can hold several cores over different corpora (the
 * MCP management-surface case, which the former `extends Service` made
 * impossible: a cordis context admits only one service under a given name).
 */
export class SemanticGroundingCore {
  /**
   * Run `fn` inside one read epoch (ADR-0015): while it runs, `loadTables` /
   * `loadEvents` share one per-layer memo instead of re-reading disk, keyed
   * `(this epoch) × (in-process corpusVersion)` — a write in between bumps the
   * version and forces a re-read, so post-write reads inside the same epoch
   * still see fresh bytes. A static, not an instance method, on purpose: the
   * epoch scopes a whole *tool call*, which may touch several cores (or none —
   * the scope-management tools), so it is module-level state that must not
   * pretend to belong to one instance. This is the MCP host's route to the
   * epoch; the substrate function itself (`src/read-epoch.ts`) stays off the
   * public barrel, whose name-level allow-list (ADR-0003) it does not touch.
   * @param fn - the call to wrap (sync or async; a Promise return passes
   *   through with the epoch attached to its continuations).
   * @returns whatever `fn` returns, unchanged.
   */
  static withReadEpoch<T>(fn: () => T): T {
    return withReadEpoch(fn)
  }

  private readonly resolved: ResolvedSemanticLayerConfig
  private provider: SchemaProvider | undefined
  /** D5: setter-injected Tier-2 recorder. Undefined is NOT "audit off" — every
   * auditable mutation throws until one is wired (ADR-0001). */
  private tier2Recorder: Tier2Recorder | undefined

  private readonly registry = new DataSourceRegistry()
  /** Disposers owned by this instance (registry listener + built-in kinds), released by `dispose()`. */
  private readonly disposers: Array<() => void> = []
  /** Health records from the most recent on-write enrichment run (reset per run). */
  private enrichmentHealth: EnrichmentHealthEntry[] = []

  constructor(config: SemanticLayerConfig) {
    this.resolved = resolveSemanticLayerConfig(config)
    // W27: invalidate the relation-graph cache when a kind is added or removed
    // so a withdrawn kind's nodes/edges do not linger. The node projection
    // (projectGraphNodes) is not cached — it iterates the live registry — so
    // only the edge-graph cache needs clearing.
    //
    // `registry.onChange` and `registry.register` each already return their own
    // disposer; the core collects them and surfaces them on `dispose()` rather
    // than handing them to a host effect system. Disposal is therefore a core
    // concept (the registry minted the disposers) and the host's only job is to
    // call `dispose()` when it tears the instance down.
    this.disposers.push(this.registry.onChange(() => {
      this.graphCache = undefined
      this.graphVersion = -1
    }))
    for (const p of [eventKindPlugin, tableKindPlugin, conceptKindPlugin]) {
      this.disposers.push(this.registry.register(p))
    }
  }

  /**
   * Release everything this instance registered: the relation-graph
   * cache-invalidation listener and the three built-in kind registrations.
   * Idempotent — a second call is a no-op.
   *
   * This replaces the `ctx.effect(...)` wrapping the registrations used to
   * carry (slice 2 ②). The behavioural guarantee is unchanged — after disposal
   * the registry holds no kinds — but the trigger moves from a host fiber
   * unloading to an explicit call, so the host owns the lifecycle boundary.
   */
  dispose(): void {
    // splice before running so a disposer that re-enters cannot double-run
    const pending = this.disposers.splice(0, this.disposers.length)
    for (const d of pending.reverse()) d()
  }

  /**
   * The semantic-layer root this core was constructed with (the per-scope
   * core's own root; mcp 的 write/import/enrichment 工具经此取根).
   * @returns the semantic-layer root path this instance was constructed with.
   */
  resolveScopeRoot(): string {
    return this.semanticRoot
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
   * @returns the cached `RelationGraph`, rebuilt when stale.
   */
  getRelationGraph(): RelationGraph {
    if (this.graphCache !== undefined && this.graphVersion === this.corpusVersion()) {
      return this.graphCache
    }
    const g = this.buildGraph(this.semanticRoot)
    this.graphCache = g
    this.graphVersion = this.corpusVersion()
    return g
  }

  /**
   * Build a fresh `RelationGraph` from `root` — the ~60-line build body behind
   * `getRelationGraph`'s cache. Pure w.r.t. cache state — the caller assigns
   * the result to the cache slot. Updates `danglingDomainRefs` as a build
   * side-effect.
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
            // Structured only: `getDanglingDomainRefs()` is the health surface.
            // The host-logger warn that used to sit here was pure duplication of
            // the line above (slice 2 ②).
            this.danglingDomainRefs.push(ref)
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
   * @returns a snapshot of the dangling refs (`asset="..." domain="..."`) from the last build.
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
   * G3: discover DWS→DIM dimension relations for the layer (or a subset when
   * `tables` is given) and write them back into each DWS table's
   * `dimension_refs`. Delegates to the substrate `enrichAllDwsTables`
   * (deterministic PK-name round only — the LLM half of enrichment is the
   * agent-driven ask-answer pair, not an in-process callback). No Tier-2
   * audit — this is the explicit enrichment entry (used by the
   * `discover_relations` agent tool + batch seeding); the on-write hook is
   * the auto path.
   *
   * GA-GT3-5b: `preserveCurated` (default `true`) toggles the replace strategy
   * when `mergeExisting=false` (the default): `true` = origin-aware replace
   * (curated manual/undefined preserved, machine dropped — PR #43); `false` =
   * raw full-replace escape-hatch (ALL existing refs dropped, only discovered
   * remain — for the rare blow-away-rebuild case). Additive: default behavior
   * unchanged.
   *
   * `tier2` (#18): optional Tier-2 options forwarded to `enrichAllDwsTables`,
   * which passes it on to every `writeTable` call this round makes. Passed,
   * this explicit enrichment round becomes an audited write (one commit per
   * table until a recorder's `beginBatch` is wired through — #16); omitted,
   * unchanged unaudited behavior.
   *
   * ADR-0007's door: a present `tables` filter must be non-empty and name only
   * tables that exist, checked before any scan or write (the free function this
   * wraps keeps its own omit/empty-means-everything contract for the on-write hook
   * and in-process hosts).
   * @param opts - optional `tables` filter + `preserveCurated` toggle (default true) + optional `tier2`.
   * @returns `enriched` (DWS gaining >=1 ref) + `written` (DWS updated) + per-table `errors`.
   * @throws UnknownFilterNamesError when `tables` is empty or names tables absent
   *   from the corpus.
   */
  async discoverRelations(
    opts: { readonly tables?: readonly string[]; readonly preserveCurated?: boolean; readonly tier2?: Tier2Opts } = {},
  ): Promise<{ enriched: number; written: number; errors: string[]; note?: string }> {
    // ADR-0007's door: a present `tables` filter must name at least one existing table,
    // rejected before any scan/write runs (the MCP handler only calls this method with
    // the tables dimension on — see `tools/enrichment.ts`'s gating).
    if (opts.tables !== undefined) assertKnownFilterNames(this.semanticRoot, { tables: opts.tables })
    // CL-18 Phase 2: forward the partition-column exclude set so ds/pt/dt
    // partition-column PK matches do not generate noise JOIN relations.
    // GA-GT3-5b: forward preserveCurated (default true = origin-aware replace;
    // false = raw full-replace escape-hatch).
    return enrichAllDwsTablesFromLayer(
      this.semanticRoot,
      opts.tables,
      false,
      buildExcludeColumns,
      opts.preserveCurated ?? true,
      opts.tier2,
    )
  }

  /**
   * Discover event→DIM relations (parallel to `discoverRelations` for DWS
   * tables) and write them into each event's `external_refs`. Delegates to the
   * substrate `enrichAllEvents` (deterministic round only — the LLM half is
   * the agent-driven ask-answer pair). No Tier-2 audit — explicit enrichment
   * entry.
   *
   * NOTE: an on-write hook for events (parallel to `enrichOnWrite` for tables)
   * is deferred: there is no Service-level event-write path today (events are
   * written via the substrate `writeEventYaml` raw-edit surface, not a Service
   * method). The hook lands with a future Service-level event-write method.
   *
   * GA-GT3-5b: `preserveCurated` (default `true`) toggles the replace strategy
   * (parallel to `discoverRelations`): `true` = origin-aware replace (curated
   * manual/undefined preserved, machine dropped — PR #43); `false` = raw
   * full-replace escape-hatch (ALL existing refs dropped, only discovered
   * remain). Additive: default behavior unchanged.
   *
   * `tier2` (#18): optional Tier-2 options forwarded to `enrichAllEvents`,
   * parallel to `discoverRelations`'s `tier2`.
   *
   * ADR-0007's door, parallel to `discoverRelations`'s: a present `events` filter
   * must be non-empty and name only events that exist, checked before any scan.
   * @param opts - optional `events` filter + `preserveCurated` toggle (default true) + optional `tier2`.
   * @returns `enriched` (events gaining >=1 ref) + `written` (events updated) + per-event `errors`.
   * @throws UnknownFilterNamesError when `events` is empty or names events absent
   *   from the corpus.
   */
  async discoverEventRelations(
    opts: { readonly events?: readonly string[]; readonly preserveCurated?: boolean; readonly tier2?: Tier2Opts } = {},
  ): Promise<{ enriched: number; written: number; errors: string[]; note?: string }> {
    // ADR-0007's door, parallel to discoverRelations's: a present `events` filter must
    // name at least one existing event, rejected before any scan/write.
    if (opts.events !== undefined) assertKnownFilterNames(this.semanticRoot, { events: opts.events })
    // GA-GT3-5b: forward preserveCurated (default true = origin-aware replace;
    // false = raw full-replace escape-hatch; parallel to discoverRelations).
    return enrichAllEventsFromLayer(this.semanticRoot, opts.events, false, undefined, opts.preserveCurated ?? true, opts.tier2)
  }

  /**
   * CL-1 Phase 3: discover alt_labels (SKOS aliases) for definitions in the
   * layer. Deterministic extraction from description/columns/domains (the
   * LLM half of enrichment is the agent-driven ask-answer pair). Merges with
   * existing labels (never removes curated aliases).
   *
   * ADR-0007 (call-wide dimension filter): naming `tables` puts ONLY the tables leg in
   * this call (events are not scanned), naming `events` the mirror, and omitting both
   * is the full corpus — the same semantics `run_enrichment` / `get_enrichment_work`
   * expose on the wire. A named dimension must be non-empty and name only existing
   * definitions, checked at the door before any scan.
   *
   * `tier2` (#18): optional Tier-2 options forwarded to both leg functions.
   * @param opts - optional dimension filters: `tables` (table_names) and/or `events`
   *   (event names), read call-wide; optional `tier2`.
   * @returns combined `enriched` + `written` + `errors` across the legs that ran.
   * @throws UnknownFilterNamesError when a named dimension filter is empty or names
   *   definitions absent from the corpus.
   */
  async discoverAltLabels(
    opts: { readonly tables?: readonly string[]; readonly events?: readonly string[]; readonly tier2?: Tier2Opts } = {},
  ): Promise<{ enriched: number; written: number; errors: string[] }> {
    // ADR-0007's door for whichever dimensions the call named.
    assertKnownFilterNames(this.semanticRoot, {
      ...opts.tables !== undefined ? { tables: opts.tables } : {},
      ...opts.events !== undefined ? { events: opts.events } : {},
    })
    // ADR-0007's call-wide pair reading, on the two per-leg free functions rather than
    // the combined `discoverAltLabels` wrapper: an omitted dimension is OUT of the call
    // unless both are omitted, in which case the call is the full corpus. The free
    // functions' own omit/empty-means-everything contracts are untouched (the on-write
    // hook and `{}` full-backfill callers keep relying on them) — this method is where
    // the narrower Core-layer semantics live.
    const bothOmitted = opts.tables === undefined && opts.events === undefined
    const tableRes = bothOmitted || opts.tables !== undefined
      ? await enrichAllTablesAltLabelsFromLayer(this.semanticRoot, opts.tables, opts.tier2)
      : { enriched: 0, written: 0, errors: [] as string[] }
    const eventRes = bothOmitted || opts.events !== undefined
      ? await enrichAllEventsAltLabelsFromLayer(this.semanticRoot, opts.events, opts.tier2)
      : { enriched: 0, written: 0, errors: [] as string[] }
    return {
      enriched: tableRes.enriched + eventRes.enriched,
      written: tableRes.written + eventRes.written,
      errors: [...tableRes.errors, ...eventRes.errors],
    }
  }

  /**
   * ADR-0006 ruling 3 (index shape revised by ADR-0008): list outstanding enrichment
   * work — definitions whose relation or alt_labels array is still empty on disk — as
   * an **index** of `{work_id, target, gap}` rows, capped at 1000 with `total` /
   * `truncated` alongside. The prompt a row stands for is NOT in the row: fetch it in
   * batches via {@link getEnrichmentPrompts}, then answer via
   * {@link applyEnrichmentResults}. Wraps `listEnrichmentWorkItems`
   * (`enrichment-work.ts`); the work_id-encoding logic stays there, parallel to how
   * `discoverRelations` wraps `enrichAllDwsTables`.
   *
   * ADR-0007 (call-wide dimension filter): naming `tables` lists ONLY those tables'
   * gaps (events are out of the call), naming `events` the mirror, omitting both lists
   * the whole corpus. A named dimension must be non-empty and name only existing
   * definitions, checked at the door before any scan.
   *
   * A read, not a write: unlike this method's `discover*` siblings, there is no
   * `tier2` parameter here at all, because {@link applyEnrichmentResults} — not this
   * method — is where ADR-0006 ruling 4's commit happens. `get_enrichment_work` (the
   * MCP tool compiling onto this method) is correspondingly a no-commit read tool.
   * @param opts - the `{tables?, events?}` dimension filter, read call-wide.
   * @returns `{work, total, truncated}` — the capped index rows plus the size metadata.
   * @throws UnknownFilterNamesError when a named dimension filter is empty or names
   *   definitions absent from the corpus.
   */
  async listEnrichmentWork(
    opts: { readonly tables?: readonly string[]; readonly events?: readonly string[] } = {},
  ): Promise<{
    readonly work: ReadonlyArray<{ readonly work_id: string; readonly target: string; readonly gap: string }>
    readonly total: number
    readonly truncated: boolean
  }> {
    return listEnrichmentWorkItems(this.semanticRoot, opts)
  }

  /**
   * ADR-0008's prompt half of the index/prompt split: rebuild, against the **current**
   * corpus, the prompts a batch of work_ids stand for. The listing stores only the
   * target's fingerprint, so the question is always re-derived — never a cached string
   * that could predate corpus changes.
   *
   * Lenient per item, mirroring {@link applyEnrichmentResults}'s verdict family: an
   * undecodable work_id, a target that no longer exists, or a fingerprint mismatch
   * (the target changed since the work was listed) verdicts `stale_baseline` for that
   * item alone — with the same re-fetch-and-retry remedy apply would give — and never
   * poisons its batch siblings. Reporting staleness at fetch time is deliberate: an
   * item failing any of those conditions is guaranteed to verdict `stale_baseline` at
   * apply too, so answering its prompt is wasted work.
   *
   * A read, not a write: no `tier2`, no commit — `get_enrichment_prompts` (the MCP
   * tool compiling onto this method) caps a batch at 10 work_ids at its zod schema;
   * this method itself processes whatever it is given.
   * @param workIds - the work_ids whose prompts to fetch (in input order).
   * @returns one `{work_id, target, round?, verdict, prompt?, detail}` outcome per
   *   input, `prompt` present exactly when `verdict` is `'fresh'`.
   */
  async getEnrichmentPrompts(
    workIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<{
    readonly work_id: string
    readonly target: string
    readonly round?: 'relation' | 'alt_labels'
    readonly verdict: 'fresh' | 'stale_baseline'
    readonly prompt?: string
    readonly detail: string
  }>> {
    return fetchEnrichmentPrompts(this.semanticRoot, workIds)
  }

  /**
   * ADR-0006 ruling 4: apply a batch of agent-supplied completions, each naming the
   * work item it answers by its self-contained `work_id`. Wraps
   * `applyEnrichmentResultsBatch` (`enrichment-work.ts`): in-lock per-item fingerprint
   * re-verification against the baseline embedded in each `work_id`, lenient parse,
   * curated-preserving merge (the same `mergeRefs` / `mergeAltLabels` the
   * deterministic round already uses), and a single `beginBatch` commit for the whole call —
   * one stale or unparseable item never blocks the others (see each item's own
   * `verdict`).
   *
   * `recorder` is **required**, unlike `discoverRelations`'s optional `tier2`: every
   * write this method can make is driven by an agent's own completion, which is a
   * Tier-2 write by construction (D5) — there is no legitimate unaudited caller for
   * this method the way dsh's batch-seeding is for `discoverRelations`.
   * @param results - the agent's `{work_id, text}` pairs, naming which work item each answers.
   * @param recorder - the Tier-2 recorder driving the batch commit.
   * @returns the per-item verdicts (`applied` / `idempotent` / `stale_baseline` /
   *   `unparseable`), in input order.
   */
  async applyEnrichmentResults(
    results: ReadonlyArray<{ readonly work_id: string; readonly text: string }>,
    recorder: Tier2Recorder,
  ): Promise<{
    readonly results: ReadonlyArray<{
      readonly work_id: string
      readonly target: string
      readonly round?: 'relation' | 'alt_labels'
      readonly verdict: 'applied' | 'idempotent' | 'stale_baseline' | 'unparseable'
      readonly detail: string
    }>
  }> {
    return applyEnrichmentResultsBatch(this.semanticRoot, results, recorder)
  }

  /**
   * Resolve a work_id's target name without applying anything (ADR-0005 ruling 1 /
   * ADR-0006 ruling 5): the `apply_enrichment` MCP tool's commit subject needs the
   * definition name *before* the audited write runs, and a `work_id` is otherwise
   * opaque at that point. Does not re-verify the baseline fingerprint — that check is
   * {@link applyEnrichmentResults}'s alone, via each item's own verdict; this is a
   * cosmetic peek for a commit subject, not a correctness gate.
   * @param work_id - a work_id, as issued by {@link listEnrichmentWork}.
   * @returns the target name, or undefined when the work_id does not decode.
   */
  peekEnrichmentWorkTarget(work_id: string): string | undefined {
    return peekWorkIdTarget(work_id)
  }

  /**
   * G3 on-write hook: after a Service write, re-run DWS→DIM discovery for the
   * just-written tables and persist `dimension_refs` (best-effort: a failure
   * is logged, never propagated — it must not fail the originating write).
   * Also runs alt_labels discovery for the written tables (CL-1 Phase 3).
   * Uses the substrate `enrichAllDwsTables` (which writes via substrate
   * `writeTable`), so the hook does NOT re-enter the Service write path. DIM
   * tables are skipped by `enrichAllDwsTables`. Gated by `autoEnrich`.
   * @param names - the table_names just written via updateTableMeta.
   */
  private async enrichOnWrite(names: readonly string[]): Promise<void> {
    if (!this.resolved.autoEnrich || names.length === 0) return
    // Reset per run, same as `danglingDomainRefs` per graph build: the surface
    // reports the health of the LAST write's enrichment, not an unbounded log.
    this.enrichmentHealth = []
    try {
      // mergeExisting=true: the auto on-write hook MERGES discovered refs with
      // any existing dimension_refs (curated joins preserved) rather than
      // replacing — so auto-trigger can never wipe human-curated joins the
      // deterministic round does not rediscover (code-review B2).
      // CL-18 Phase 2: forward buildExcludeColumns so partition-column PK
      // matches (e.g. ds-only DIM snapshots) do not add noise JOIN relations.
      const res = await enrichAllDwsTablesFromLayer(this.semanticRoot, names, true, buildExcludeColumns)
      if (res.errors.length > 0) {
        this.enrichmentHealth.push({ round: 'relation', outcome: 'partial', tables: [...names], errors: [...res.errors] })
      }
    } catch (e) {
      this.enrichmentHealth.push({ round: 'relation', outcome: 'failed', tables: [...names], errors: [(e as Error).message] })
    }
    // CL-1 Phase 3: also discover alt_labels for the written tables
    try {
      const res = await enrichAllTablesAltLabelsFromLayer(this.semanticRoot, names)
      if (res.errors.length > 0) {
        this.enrichmentHealth.push({ round: 'alt_labels', outcome: 'partial', tables: [...names], errors: [...res.errors] })
      }
    } catch (e) {
      this.enrichmentHealth.push({ round: 'alt_labels', outcome: 'failed', tables: [...names], errors: [(e as Error).message] })
    }
  }

  /**
   * The on-write enrichment health records from the most recent write, or an
   * empty array when the last hook run fully succeeded (or did not run).
   *
   * A non-empty result means the just-written definitions are missing derived
   * facts (`dimension_refs` from the relation round, `alt_labels` from the
   * alt-labels round). The originating write still succeeded — the hook is
   * best-effort by design and never propagates — so this surface is how a
   * caller finds out that its write landed with incomplete enrichment and
   * whether to retry the round or degrade.
   *
   * Replaces four `ctx.logger.warn` call sites (slice 2 ②) that were the sole
   * exit for this information.
   * @returns a snapshot of the last run's health records.
   */
  getEnrichmentHealth(): readonly EnrichmentHealthEntry[] {
    return [...this.enrichmentHealth]
  }

  /** The semantic-layer scope root (the dir with config.yaml/events/tables),
   * or empty string when unset. */
  get semanticRoot(): string {
    return this.resolved.semanticRoot
  }

  /** The default scope id for Tier-2 audit + schema discovery, or empty string
   * when unset. */
  get scopeId(): string {
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
   * @returns the parsed `TableDefinition`, or null when no table matches.
   */
  loadTableDefinition(name: string): TableDefinition | null {
    return loadTableDefinitionFromLayer(this.semanticRoot, name)
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
   * ADR-0004 ruling 8's read side: `loadTableDefinition` plus the sha256
   * content fingerprint of the exact file `updateTableMeta` / `writeTable`
   * check an `expected_version` against (`definitionVersion` — one
   * implementation serves both sides of the contract, which is the whole
   * point: the read a caller hands back as `expected_version` and the write's
   * staleness check can never disagree by construction). A read from this
   * method followed by a write passing `version` back is the round trip
   * ADR-0005's update-class tools are built on; `get_definition` (the MCP
   * tool compiling onto this method) is its wire surface.
   * @param name - the table `table_name` key to match.
   * @returns the parsed definition and its `version` fingerprint, or null when no table matches.
   * @throws an internal error when the table loads but its backing file does
   *   not resolve under `tables/` — a hand-renamed file, not a "not found";
   *   stays loud rather than reporting a definition no write could target.
   */
  loadTableDefinitionWithVersion(name: string): { readonly definition: TableDefinition; readonly version: string } | null {
    const definition = this.loadTableDefinition(name)
    if (definition === null) return null
    const version = definitionVersion(this.semanticRoot, 'table', name)
    if (version === null) {
      throw new Error(`table "${name}" loaded but its backing file could not be resolved under tables/ (non-conventional filename?)`)
    }
    return { definition, version }
  }

  /**
   * ADR-0004 ruling 8's read side for events, parallel to
   * {@link loadTableDefinitionWithVersion}: the fingerprint of the file
   * `writeEventYaml` / `updateEventMeta` target, resolved via
   * `findEventPath`'s name-matched scan (fallback included). The
   * loaded-but-unresolvable branch is unreachable in practice for events —
   * the loader and the path resolver match on the same `name` field — but
   * stays loud anyway rather than reporting a definition no write could
   * target; a hand-renamed event file fingerprints correctly here where the
   * MCP layer's former filename-convention copy threw ENOENT.
   * @param name - the event `name` key to match.
   * @returns the parsed definition and its `version` fingerprint, or null when no event matches.
   */
  loadEventDefinitionWithVersion(name: string): { readonly definition: EventDefinition; readonly version: string } | null {
    const definition = this.loadEventDefinition(name)
    if (definition === null) return null
    const version = definitionVersion(this.semanticRoot, 'event', name)
    if (version === null) {
      throw new Error(`event "${name}" loaded but its backing file could not be resolved under events/ (non-conventional filename?)`)
    }
    return { definition, version }
  }

  /**
   * ADR-0004 ruling 8's read side for concepts. Concepts have no write path
   * in v1 (ADR-0005 ruling 2), so no write ever consumes this fingerprint —
   * it is reported for read completeness and symmetry with table/event, the
   * same stance the MCP read surface held before this method absorbed it.
   * @param name - the concept `name` key to match.
   * @returns the parsed definition and its `version` fingerprint, or null when no concept matches.
   */
  loadConceptDefinitionWithVersion(name: string): { readonly definition: import('./types.ts').ConceptDefinition; readonly version: string } | null {
    const definition = this.loadConceptDefinition(name)
    if (definition === null) return null
    const version = definitionVersion(this.semanticRoot, 'concept', name)
    if (version === null) {
      throw new Error(`concept "${name}" loaded but its backing file could not be resolved under concepts/ (non-conventional filename?)`)
    }
    return { definition, version }
  }

  /**
   * Build an enriched retrieval corpus from the substrate — each event's
   * `alt_labels` (SKOS aliases) + `params_fields` packed into the indexed
   * `description`. The `corpusVariant` config selects slices: 'params+term'
   * (default) packs both; 'term-only' packs aliases only.
   * @returns enriched corpus items ready for `Bm25Linker` / `HybridRetriever` indexing.
   */
  loadRetrievalCorpus(): readonly EventCorpusItem[] {
    return loadRetrievalCorpusFromLayer(this.semanticRoot, this.corpusVariant)
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
   * @returns a frozen `DefinitionSnapshot` pinned at the current corpus version.
   */
  acquireSnapshot(): DefinitionSnapshot {
    return captureSnapshot(this.semanticRoot, this.corpusVersion(), this.corpusVariant)
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
   * writeTable / updateTableMeta). Probed structurally
   * by `tool-search-data-sources` (no static dep) so its cached enriched
   * Bm25Linker rebuilds after a mid-session event edit instead of staying stale
   * until reboot (D2e-deferred cache-invalidation). Reads the per-path counter
   * for `this.semanticRoot` (0 until the first write).
   * @returns the current corpus-version counter.
   */
  corpusVersion(): number {
    return getCorpusVersionFromLayer(this.semanticRoot)
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

  // ── Tier-2 persistent writes (setter-injected recorder; D5 non-disableable) ──
  /**
   * D5: inject the Tier-2 recorder. There is deliberately **no** way to turn
   * Tier-2 audit off — a host that wants audit-off behaviour must pass an
   * explicit no-op recorder that still satisfies the interface, making the
   * downgrade a deliberate, code-visible choice rather than a wiring accident
   * (ADR-0001).
   *
   * Setter-injected rather than looked up via `ctx.get('audit')` (slice 2 ②).
   * The guarantee is unchanged — an auditable mutation with no recorder still
   * throws — but the wiring is now legible at the call site instead of
   * depending on whether the host mounted something under the name `'audit'`.
   * @param recorder - the Tier-2 recorder, or undefined to clear (re-arming the throw).
   */
  setTier2Recorder(recorder: Tier2Recorder | undefined): void {
    this.tier2Recorder = recorder
  }

  /**
   * The wired Tier-2 recorder, or throw.
   *
   * **Invariant (D5)**: any code path that mutates auditable state MUST either
   * record the mutation via the wired `Tier2Recorder` or throw. Silent drop is
   * not a valid outcome (ADR-0001). This is the single chokepoint that enforces
   * it for the Service-level write methods.
   */
  private recorder(): Tier2Recorder {
    if (this.tier2Recorder === undefined) {
      throw new Error('semantic-grounding Tier-2 write requires a recorder (Tier-2 audit is non-disableable, D5; call setTier2Recorder — pass an explicit no-op recorder if you really mean audit-off)')
    }
    return this.tier2Recorder
  }

  /**
   * Tier-2 per-scope write: read-merge-validate-write a single table's meta
   * updates, recording the write via `ctx.audit` (D5 non-disableable). G3:
   * after the write, the on-write hook re-runs DWS→DIM discovery for the table
   * (gated by `autoEnrich`).
   * @param name - the table `table_name` to update.
   * @param updates - the field overrides merged over the existing table YAML.
   * @param opts - optional `expected_version` (#18, ADR-0004 ruling 8: sha256
   *   baseline checked against the on-disk fingerprint before the write
   *   lands; a mismatch throws `StaleBaselineError`).
   * @returns `{ ok: true, table_name, version }` on success (`version` = the
   *   file's sha256 fingerprint **as the whole write left it** — the on-write
   *   hook may rewrite the same file after the primitive's own write, so when
   *   the hook ran, the fingerprint is re-resolved after it; #108), or
   *   `{ ok: false, error }` when the table is missing/malformed or
   *   validation fails.
   */
  async updateTableMeta(
    name: string,
    updates: Record<string, unknown>,
    opts: { readonly expected_version?: string } = {},
  ): Promise<{ ok: true; table_name: string; version: string } | { ok: false; error: string }> {
    const res = await updateTableMetaFromLayer(this.semanticRoot, name, updates, {
      recorder: this.recorder(),
      scope_id: this.scopeId,
      ...opts.expected_version !== undefined ? { expected_version: opts.expected_version } : {},
    })
    if (!res.ok) return res
    if (this.resolved.autoEnrich) {
      await this.enrichOnWrite([name])
      // The hook's discovery may have rewritten this very file after the
      // primitive computed its fingerprint; the receipt must name the file as
      // the WHOLE write left it, or the caller's next expected_version write
      // would be rejected against a fingerprint that no longer exists. A
      // post-write null is unreachable (the file exists and the lock is held);
      // the primitive's value is the defensive floor.
      const after = definitionVersion(this.semanticRoot, 'table', name)
      return { ok: true, table_name: res.table_name, version: after ?? res.version }
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
   * @param opts - optional `expected_version` (#18, ADR-0004 ruling 8: sha256
   *   baseline checked against the on-disk fingerprint before the write
   *   lands; a mismatch throws `StaleBaselineError`).
   * @returns `{ ok: true, event_name, version }` on success (`version` = the
   *   written file's sha256 fingerprint, #108 — no on-write hook exists on
   *   this path, so the primitive's fingerprint is final), or
   *   `{ ok: false, error }` when the event is missing/malformed or
   *   validation fails.
   */
  async updateEventMeta(
    name: string,
    updates: Record<string, unknown>,
    opts: { readonly expected_version?: string } = {},
  ): Promise<{ ok: true; event_name: string; version: string } | { ok: false; error: string }> {
    return updateEventMetaFromLayer(this.semanticRoot, name, updates, {
      recorder: this.recorder(),
      scope_id: this.scopeId,
      ...opts.expected_version !== undefined ? { expected_version: opts.expected_version } : {},
    })
  }

  // ── Concept write methods (#52 / ADR-0012) ────────────────────────────────────
  //
  // The concept pair of `writeTable`/`updateTableMeta`, reached through the Core
  // class because the public barrel is name-locked (ADR-0002/0003 — the same
  // Core-method axis #31/#49 established). One deliberate asymmetry with the
  // table pair: NO on-write enrichment hook anywhere in this section — concepts
  // have no enrichment rounds (#46 measured 'concept' zero-hit in
  // enrichment*.ts), so there is nothing a hook could re-derive and no health
  // to report afterwards.

  /**
   * Validate-then-atomically-write one concept YAML (`concepts/<name>.yaml`),
   * recording the write via `ctx.audit` (D5 non-disableable) — `writeTable`'s
   * create-path ceremony for the concept layout, including ADR-0004 ruling 1's
   * snapshot-and-rollback on a recorder failure. The create verb:
   * `create_definition(kind:'concept')` compiles here; existence is the
   * handler's pre-check (the io primitive itself overwrites, exactly as
   * `writeTable` does).
   * @param name - the concept `name` (becomes the `<name>.yaml` filename).
   * @param data - the concept payload; validated against `ConceptDefinitionSchema` unless skipped.
   * @param opts - `{ skipValidation: true }` skips schema validation (for pre-validated generators).
   * @returns `{ ok: true, path }` on success, or `{ ok: false, error }` when
   *   schema validation rejects the payload (#61: the write paths' unified
   *   domain-failure face).
   */
  async writeConceptYaml(
    name: string,
    data: unknown,
    opts: { skipValidation?: boolean } = {},
  ): Promise<WriteConceptYamlResult> {
    return writeConceptYamlFromLayer(this.semanticRoot, name, data, opts, {
      recorder: this.recorder(),
      scope_id: this.scopeId,
    })
  }

  /**
   * Tier-2 per-scope write: read-merge-validate-write a single concept's meta
   * updates, recording the write via `ctx.audit` (D5 non-disableable) —
   * `updateTableMeta`'s ceremony for the concept layout (A13-style re-read at
   * write time, ADR-0004 ruling 1 rollback, ruling 8 expected_version).
   * No on-write enrichment hook: concepts have no rounds, so no hook and no
   * post-write health.
   * @param name - the concept `name` to update (must already exist on disk).
   * @param updates - the field overrides merged over the existing concept YAML.
   * @param opts - optional `expected_version` (sha256 baseline checked against
   *   the on-disk fingerprint before the write lands; a mismatch throws
   *   `StaleBaselineError`).
   * @returns `{ ok: true, concept_name, version }` on success (`version` = the
   *   written file's sha256 fingerprint, #108 — no on-write hook exists on
   *   this path, so the primitive's fingerprint is final), or
   *   `{ ok: false, error }` when the concept is missing/malformed or
   *   validation fails.
   */
  async updateConceptMeta(
    name: string,
    updates: Record<string, unknown>,
    opts: { readonly expected_version?: string } = {},
  ): Promise<{ ok: true; concept_name: string; version: string } | { ok: false; error: string }> {
    return updateConceptMetaFromLayer(this.semanticRoot, name, updates, {
      recorder: this.recorder(),
      scope_id: this.scopeId,
      ...opts.expected_version !== undefined ? { expected_version: opts.expected_version } : {},
    })
  }

  // ── Item-level write methods (#49 / ADR-0005 ruling 3, ADR-0010) ──────────────
  //
  // Four methods 1:1 corresponding to the four intent tools (`add_alias`,
  // `remove_alias`, `add_relation`, `remove_relation`). Each encapsulates the
  // full domain logic — dual-field overlay (content + suppression), veto
  // routing, in-lock reassertion check — so the MCP handlers thin to schema +
  // `runAudited` + Core call + response formatting.
  //
  // The handler's `auditedWrite` provides the lock (ruling 3's read-modify-write
  // inside the corpus lock); these methods do the read and the write inside that
  // lock. Core does NOT accept AuditIntent or recorder — the handler's
  // `auditedWrite` provides the ambient context; `this.updateTableMeta` /
  // `this.updateEventMeta` call `this.recorder()` which is the D5 chokepoint.
  //
  // `expected_version` is **required** (#48 grilling resolution Q1), not opts:
  // the handler always passes it from the tool input. `StaleBaselineError`
  // propagates from `updateTableMeta` / `updateEventMeta`; `Error("Table not
  // found: ...")` / `Error("Event not found: ...")` is thrown by these methods
  // for missing targets — the handler maps both to the appropriate MCP error.

  // Item-write ritual lives in ./item-write.ts (off-barrel internal module,
  // the same split as enrichment-work.ts); these forwards keep the
  // ADR-0002/0003 public method names. JSDoc: see the module. Each return
  // carries per-item verdicts (`results`) plus the written file's
  // fingerprint (`version`, #108) — the receipt keys the item tools inline
  // so a caller can chain its next write without a read-back.
  async addAliases(
    kind: ItemKind,
    name: string,
    labels: readonly string[],
    expectedVersion: string,
  ): Promise<{ readonly results: readonly AddVerdict[]; readonly version: string }> {
    return addItemAliases(this.semanticRoot, (k, n, u, v) => this.applyItemUpdate(k, n, u, v), kind, name, labels, expectedVersion)
  }

  async removeAliases(
    kind: ItemKind,
    name: string,
    labels: readonly string[],
    expectedVersion: string,
  ): Promise<{ readonly results: readonly ItemVerdict[]; readonly version: string }> {
    return removeItemAliases(this.semanticRoot, (k, n, u, v) => this.applyItemUpdate(k, n, u, v), kind, name, labels, expectedVersion)
  }

  async addRelations(
    kind: ItemKind,
    name: string,
    relations: readonly RelationInput[],
    expectedVersion: string,
  ): Promise<{ readonly results: readonly AddVerdict[]; readonly version: string }> {
    return addItemRelations(this.semanticRoot, (k, n, u, v) => this.applyItemUpdate(k, n, u, v), kind, name, relations, expectedVersion)
  }

  async removeRelations(
    kind: ItemKind,
    name: string,
    relations: readonly RelationInput[],
    expectedVersion: string,
  ): Promise<{ readonly results: readonly ItemVerdict[]; readonly version: string }> {
    return removeItemRelations(this.semanticRoot, (k, n, u, v) => this.applyItemUpdate(k, n, u, v), kind, name, relations, expectedVersion)
  }

  /**
   * Internal: dispatch `updateTableMeta` / `updateEventMeta` /
   * `updateConceptMeta` by kind and throw on failure. The item methods use
   * this instead of the non-throwing result shape — the handler's try/catch
   * maps thrown errors to MCP error responses. Resolves to the written
   * file's fingerprint (#108's write receipt): for a table this is the
   * post-hook value `updateTableMeta` re-resolved; for the hookless kinds it
   * is the primitive's own.
   */
  private async applyItemUpdate(
    kind: ItemKind,
    name: string,
    updates: Readonly<Record<string, unknown>>,
    expectedVersion: string,
  ): Promise<string> {
    if (kind === 'table') {
      const res = await this.updateTableMeta(name, updates, { expected_version: expectedVersion })
      if (!res.ok) throw new Error(res.error)
      return res.version
    }
    if (kind === 'event') {
      const res = await this.updateEventMeta(name, updates, { expected_version: expectedVersion })
      if (!res.ok) throw new Error(res.error)
      return res.version
    }
    const res = await this.updateConceptMeta(name, updates, { expected_version: expectedVersion })
    if (!res.ok) throw new Error(res.error)
    return res.version
  }
}

// StandInSchemaProvider moved to ./schema-provider.ts in slice 5 — off the
// public barrel (test double, no host consumer; ADR-0003), still exported
// from its module for in-repo tests.

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

export default SemanticGroundingCore

/**
 * W11 C1 — MVCC query snapshot.
 *
 * Provides snapshot isolation for the semantic layer: during a single query
 * execution the definition snapshot is locked — concurrent edits from a
 * management session (which call `invalidateCaches`) do not affect an in-flight
 * query. The next query after the edit sees the new version.
 *
 * Approach: version-stamped snapshot. `withSnapshot(fn)` captures the current
 * corpus version and eagerly loads all tables + events into a frozen
 * `DefinitionSnapshot`. The snapshot provides the same read API surface as the
 * service (`loadTableDefinition`, `loadEventDefinition`, `loadRetrievalCorpus`)
 * but from a pinned point in time.
 *
 * Cheap when reused: if the corpus version has not changed since the last
 * snapshot, the cached data arrays are shared (no re-scan). The module-level
 * cache is keyed by `(semanticRoot, version)`.
 *
 * @module @deepseek-ai/dsh-semantic-layer/src/snapshot
 */
import {
  loadEvents,
  loadTables,
  loadRetrievalCorpus,
  type RawEvent,
  type RawTable,
} from './io.ts'
import {
  EventDefinitionSchema,
  TableDefinitionSchema,
  type EventDefinition,
  type TableDefinition,
  type MetricDefinition,
} from './types.ts'
import { splitMetricName, toMetricDefinition } from './metrics.ts'
import type { EventCorpusItem, CorpusVariant } from './corpus.ts'

/**
 * A frozen point-in-time view of semantic layer definitions. Provides the same
 * read-only API surface as `SemanticLayerService` but the data is pinned at
 * the version captured when the snapshot was acquired — subsequent
 * `invalidateCaches()` calls do not affect it.
 */
export class DefinitionSnapshot {
  /** The corpus version at the time this snapshot was captured. */
  readonly version: number
  private readonly _tables: readonly RawTable[]
  private readonly _events: readonly RawEvent[]
  private readonly _corpus: readonly EventCorpusItem[]
  /** Lazily populated table-definition cache (by table_name). */
  private _tableDefCache: Map<string, TableDefinition | null> | undefined
  /** Lazily populated event-definition cache (by name). */
  private _eventDefCache: Map<string, EventDefinition | null> | undefined

  constructor(
    version: number,
    tables: readonly RawTable[],
    events: readonly RawEvent[],
    corpus: readonly EventCorpusItem[],
  ) {
    this.version = version
    this._tables = tables
    this._events = events
    this._corpus = corpus
  }

  /**
   * Load a validated table definition by name from the snapshot.
   * @param name - the table `table_name` key to match.
   * @returns the parsed `TableDefinition`, or null when no table matches.
   */
  loadTableDefinition(name: string): TableDefinition | null {
    if (this._tableDefCache === undefined) {
      this._tableDefCache = new Map()
    }
    if (this._tableDefCache.has(name)) return this._tableDefCache.get(name) ?? null
    for (const t of this._tables) {
      if (t.table_name === name) {
        const r = TableDefinitionSchema.safeParse(t.raw)
        if (r.success) {
          this._tableDefCache.set(name, r.data)
          return r.data
        }
        this._tableDefCache.set(name, null)
        return null
      }
    }
    this._tableDefCache.set(name, null)
    return null
  }

  /**
   * Load a validated event definition by name from the snapshot.
   * @param name - the event `name` key to match.
   * @returns the parsed `EventDefinition`, or null when no event matches.
   */
  loadEventDefinition(name: string): EventDefinition | null {
    if (this._eventDefCache === undefined) {
      this._eventDefCache = new Map()
    }
    if (this._eventDefCache.has(name)) return this._eventDefCache.get(name) ?? null
    for (const e of this._events) {
      if (e.name === name) {
        const r = EventDefinitionSchema.safeParse(e.raw)
        if (r.success) {
          this._eventDefCache.set(name, r.data)
          return r.data
        }
        this._eventDefCache.set(name, null)
        return null
      }
    }
    this._eventDefCache.set(name, null)
    return null
  }

  /**
   * Load a validated metric definition by name from the snapshot.
   * @param name - the metric `name` key to match (`<host>__<key>`).
   * @returns the parsed `MetricDefinition`, or null when no host defines it.
   */
  loadMetricDefinition(name: string): MetricDefinition | null {
    const parts = splitMetricName(name)
    if (parts === null) return null
    const { host, key } = parts
    const table = this.loadTableDefinition(host)
    if (table !== null) {
      const m = table.metrics[key]
      if (m !== undefined) return toMetricDefinition(host, key, m, table.domains)
    }
    const event = this.loadEventDefinition(host)
    if (event !== null) {
      const m = event.metrics[key]
      if (m !== undefined) return toMetricDefinition(host, key, m, event.domains)
    }
    return null
  }

  /**
   * The enriched retrieval corpus captured at snapshot time (events only,
   * D2e-compatible). Pinned — not affected by subsequent writes.
   * @returns the frozen corpus items.
   */
  loadRetrievalCorpus(): readonly EventCorpusItem[] {
    return this._corpus
  }

  /**
   * All raw tables captured in this snapshot.
   * @returns the frozen table list (unvalidated raw dicts).
   */
  get tables(): readonly RawTable[] {
    return this._tables
  }

  /**
   * All raw events captured in this snapshot.
   * @returns the frozen event list (unvalidated raw dicts).
   */
  get events(): readonly RawEvent[] {
    return this._events
  }
}

// ── Module-level snapshot cache (cheap reuse when version unchanged) ────
interface CachedSnapshot {
  version: number
  tables: readonly RawTable[]
  events: readonly RawEvent[]
  corpus: readonly EventCorpusItem[]
}
/** Upper bound on the number of distinct semanticRoots the module-level
 * snapshot cache retains. The cache is version-keyed and self-invalidating
 * per root, but an unbounded set of distinct roots (one per scope) could grow
 * without limit; this cap evicts the oldest entry (FIFO — Map preserves
 * insertion order) when exceeded. Present-root cache-hit semantics are
 * unchanged: a hit returns early (no eviction), so an actively-cached root is
 * never displaced by a re-capture of itself. */
export const SNAPSHOT_CACHE_MAX = 64
const _snapshotCache = new Map<string, CachedSnapshot>()

/**
 * Capture a `DefinitionSnapshot` for the given semantic-layer root. If the
 * corpus version has not changed since the last capture for this root, the
 * cached data arrays are reused (no disk re-scan).
 *
 * @param semanticRoot - the semantic-layer directory path.
 * @param serviceVersion - the service-level corpus version (includes scope epoch).
 * @param corpusVariant - the enrichment variant for the retrieval corpus.
 * @returns a fresh `DefinitionSnapshot` pinned at the current version.
 */
export function captureSnapshot(
  semanticRoot: string,
  serviceVersion: number,
  corpusVariant: CorpusVariant = 'params+term',
): DefinitionSnapshot {
  const cached = _snapshotCache.get(semanticRoot)
  if (cached !== undefined && cached.version === serviceVersion) {
    return new DefinitionSnapshot(cached.version, cached.tables, cached.events, cached.corpus)
  }
  // Eagerly load all definitions from disk (sync — matches existing io.ts pattern).
  const tables = loadTables(semanticRoot)
  const events = loadEvents(semanticRoot)
  const corpus = loadRetrievalCorpus(semanticRoot, corpusVariant)
  Object.freeze(tables)
  Object.freeze(events)
  Object.freeze(corpus)
  const entry: CachedSnapshot = { version: serviceVersion, tables, events, corpus }
  _snapshotCache.set(semanticRoot, entry)
  // Bounded FIFO eviction: when the cache exceeds the cap, drop the oldest
  // entry. Map preserves insertion order, so keys().next().value is the
  // oldest. The just-set root sits at the insertion-order tail, so the head
  // is always a distinct, defined key whenever the cap is exceeded.
  if (_snapshotCache.size > SNAPSHOT_CACHE_MAX) {
    const oldest = _snapshotCache.keys().next().value
    _snapshotCache.delete(oldest as string)
  }
  return new DefinitionSnapshot(serviceVersion, tables, events, corpus)
}

/**
 * Clear the module-level snapshot cache (for testing). Production code does
 * not need this — the cache is version-keyed and self-invalidating.
 */
export function clearSnapshotCache(): void {
  _snapshotCache.clear()
}

/**
 * The current number of cached snapshot entries (distinct semanticRoots).
 * Exported for test/health observation of the bounded cache (mirrors
 * `clearSnapshotCache`); production code does not need this — the cache is
 * version-keyed and self-invalidating per root.
 * @returns the number of entries currently in the module-level cache.
 */
export function getSnapshotCacheSize(): number {
  return _snapshotCache.size
}

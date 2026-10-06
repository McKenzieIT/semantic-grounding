/**
 * P6b semantic-layer substrate — BasicIndex (dep-free lookup accelerator).
 * Mirrors reverse-bi/libs/rbi-semantic/src/rbi_semantic/index.py:BasicIndex.
 *
 * "lookup accelerator, NOT a validation cache" — stores raw YAML dicts +
 * paths, NEVER model_validates at build. Wires ADR-0011 cache invalidation:
 * a write sets `_dirty`; the next lookup rebuilds from disk.
 *
 * @module @deepseek-ai/dsh-semantic-layer/src/basic-index
 */
import { loadEvents, loadTables, loadDomains, registerInvalidationHook } from './io.ts'

/** A raw event YAML dict plus the domain subdir it was scanned from (no validation at build). */
export interface EventIndexEntry {
  readonly raw: Record<string, unknown>
  readonly domain: string
}
/** A raw table YAML dict plus the file path it was scanned from (no validation at build). */
export interface TableIndexEntry {
  readonly path: string
  readonly raw: Record<string, unknown>
}

/** Dep-free lookup accelerator over a semantic-layer scope dir. */
export class BasicIndex {
  private readonly semanticLayer: string
  private _dirty = true
  private _events = new Map<string, EventIndexEntry>()
  private _tables = new Map<string, TableIndexEntry>()
  private _domains: Record<string, unknown> = {}
  /** ADR-0011: disposer for this index's invalidation hook (call `dispose()` to remove it). */
  private readonly _disposeHook: () => void

  constructor(semanticLayer: string) {
    this.semanticLayer = semanticLayer
    // ADR-0011: register this index's invalidation hook so writes trigger a rebuild.
    this._disposeHook = registerInvalidationHook((sl) => {
      // ADR-0011: only dirty THIS index's layer (a write to layer A must not
      // rebuild layer B's index). The disposer removes this index's hook so the
      // closure no longer pins the instance (call `dispose()` when done).
      if (sl === this.semanticLayer) this._dirty = true
    })
  }

  /** Remove this index's invalidation hook (call when the index is no longer used). */
  dispose(): void {
    this._disposeHook()
  }

  private _build(): void {
    this._events = new Map()
    this._tables = new Map()
    for (const e of loadEvents(this.semanticLayer)) {
      this._events.set(e.name, { raw: e.raw, domain: e.domain })
    }
    for (const t of loadTables(this.semanticLayer)) {
      this._tables.set(t.table_name, { path: t.path, raw: t.raw })
    }
    this._domains = loadDomains(this.semanticLayer)
    this._dirty = false
  }

  private _ensure(): void {
    if (this._dirty) this._build()
  }

  /**
   * Look up a single event by name, returning its raw dict + domain.
   * @param name - the event `name` key to match.
   * @returns the matching event entry, or null when the name is not indexed.
   */
  lookupEvent(name: string): EventIndexEntry | null {
    this._ensure()
    return this._events.get(name) ?? null
  }

  /**
   * Look up a single table by name, returning its raw dict + path.
   * @param name - the table `table_name` key to match.
   * @returns the matching table entry, or null when the name is not indexed.
   */
  lookupTable(name: string): TableIndexEntry | null {
    this._ensure()
    return this._tables.get(name) ?? null
  }

  /**
   * Count indexed events (triggers a rebuild when dirty).
   * @returns the number of events in the layer.
   */
  eventCount(): number {
    this._ensure()
    return this._events.size
  }

  /**
   * Count indexed tables (triggers a rebuild when dirty).
   * @returns the number of tables in the layer.
   */
  tableCount(): number {
    this._ensure()
    return this._tables.size
  }

  /**
   * Count indexed tables whose `kind` matches (defaults to `dws` when absent).
   * @param kind - the kind value to count (`dws` or `dim`).
   * @returns the number of tables whose kind equals `kind`.
   */
  tableCountByKind(kind: string): number {
    this._ensure()
    let n = 0
    for (const t of this._tables.values()) {
      const k = t.raw.kind
      const kindStr = typeof k === 'string' ? k : 'dws'
      if (kindStr === kind) n += 1
    }
    return n
  }

  /**
   * Enumerate every indexed event with its name merged into the entry.
   * @returns a fresh array of all event entries (name + raw + domain).
   */
  events(): Array<{ name: string } & EventIndexEntry> {
    this._ensure()
    return [...this._events.entries()].map(([name, v]) => ({ name, ...v }))
  }

  /**
   * Enumerate every indexed table entry.
   * @returns a fresh array of all table entries (path + raw).
   */
  tableEntries(): TableIndexEntry[] {
    this._ensure()
    return [...this._tables.values()]
  }

  /**
   * Return the parsed `domains.yaml` catalog (empty object when absent).
   * @returns the domains catalog map, or `{}` when the file is missing/malformed.
   */
  domainsCatalog(): Record<string, unknown> {
    this._ensure()
    return this._domains
  }
}

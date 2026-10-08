/**
 * Live-engine schema source (P6b Q3 deferred) + its test stand-in.
 *
 * `SchemaProvider` is the public half — the seam the core's
 * `discover`/`describe`/`sample` read from once a provider is mounted. It
 * lives in its own module (not `index.ts`) so the stand-in below can sit
 * beside it without the stand-in being on the public barrel:
 * `StandInSchemaProvider` mirrors the P6 prototype's `schema-stub.mjs` fake
 * tables so the decoupled sync flow (discover -> TableMeta[] -> generate/merge
 * YAML -> write) is demoable + testable without the engine. Production mounts
 * a real provider (follow-up). The stand-in is off the v0.1 public surface
 * (ADR-0003: test double, no host consumer); reachable in-repo via this module.
 *
 * @module schema-provider (internal; only `"."` is importable — see ADR-0002)
 */
import type { TableMeta } from './types.ts'

/** Live-engine schema source: discover/describe/sample tables for sync-write (P6b Q3 deferred; production mounts a real provider). */
export interface SchemaProvider {
  /** List tables in a scope (optionally filtered by kind). Real impl: maxc list + per-table describe. */
  discover(scopeId: string, kind?: string): Promise<readonly TableMeta[]>
  /** Describe one table's columns/partitions/comment. */
  describe(tableName: string): Promise<TableMeta | null>
  /** Sample N rows as formatted text. */
  sample(tableName: string, n?: number): Promise<string>
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

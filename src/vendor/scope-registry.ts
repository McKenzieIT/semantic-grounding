/**
 * Per-scope namespace registry (`ctx.scopes`). A runtime-mutable store of scope
 * definitions — each scope maps an id to a filesystem `semanticRoot` path plus
 * optional metadata (active provider, project name, etc.). The registry is
 * persisted to a YAML file on disk; the Cordis static config tells the service
 * WHERE to find the file (`registryPath`), while the file itself is the
 * runtime-mutable state that CLI / API / Web UI can read and write.
 *
 * Design decisions (semantic-layer map P1):
 * - Cordis config = WHERE the registry lives (static, set at bundle mount).
 * - Registry YAML = WHAT scopes exist + which is active (runtime-mutable).
 * - Scope = pure namespace; the id carries no semantics beyond being a key.
 * - Active scope is a per-process singleton; switching emits an event so
 *   consumers (SemanticLayerService, audit, query engine) can react.
 *
 * @module @deepseek-ai/dsh-scope-registry
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic, withFileLock } from './atomic-write.ts'
import * as yaml from 'js-yaml'

// ── Types ───────────────────────────────────────────────────────────────────

/** A single scope definition in the registry. */
export interface ScopeDefinition {
  /** Unique scope identifier (the namespace key). */
  readonly id: string
  /** Filesystem path to this scope's semantic-layer root (dir with config.yaml/events/tables). */
  readonly semanticRoot: string
  /**
   * Owning tenant id. Phase 1 OPTIONAL: an existing scope with no tenant on
   * disk reads back as `"default"` (D6: existing single scope = "default").
   */
  readonly tenant?: string
  /** Arbitrary metadata — active provider, project name, engine type, etc. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** On-disk shape of the scopes.yaml registry file. */
interface RegistryFile {
  active?: string
  scopes?: Record<string, { semanticRoot: string; tenant?: string; metadata?: Record<string, unknown> }>
}

// ── Config (static Cordis, set at bundle mount) ─────────────────────────────

/** ScopeRegistryConfig */
export interface ScopeRegistryConfig {
  /** Path to the scopes.yaml registry file. Empty = service is inert (no scopes). */
  readonly registryPath: string
}

// ── Cordis seam declaration ─────────────────────────────────────────────────

declare module '@deepseek-ai/cordis' {
  interface Context {
    scopes: ScopeRegistryService
  }
  interface Events {
    /**
     * Emitted after the set of registered scopes changes — a scope was added or
     * updated via register(), or removed via remove(). A pure active-scope
     * switch (setActive/clearActive) does not fire this event. Listeners may
     * re-read ctx.scopes.list() to refresh any cached view of the registry.
     * @mode emit
     */
    'scopes/changed': () => void
    /**
     * Emitted after the active scope id changes — via setActive(),
     * clearActive(), register() making the first scope active, or remove()
     * deactivating the previously active scope. Listeners may re-read
     * ctx.scopes.active() to react to the new selection.
     * @param scopeId - the new active scope id, or undefined when no scope is now active.
     * @mode emit
     */
    'scopes/active-changed': (scopeId: string | undefined) => void
  }
}

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * Scope registry Cordis service. Reads and writes a YAML file at `registryPath`
 * containing scope definitions and the active scope id. All mutations are
 * atomic (cross-process safe via file lock + atomic write).
 */
export class ScopeRegistryService extends Service {
  static Config: z<ScopeRegistryConfig> = z.object({
    registryPath: z.string().default(''),
  })

  private readonly registryPath: string

  constructor(ctx: Context, config: ScopeRegistryConfig) {
    super(ctx, 'scopes')
    this.registryPath = config.registryPath.startsWith('~/')
      ? homedir() + config.registryPath.slice(1)
      : config.registryPath
  }

  // ── Read API ────────────────────────────────────────────────────────────

  /**
   * All registered scopes, optionally filtered by tenant.
   *
   * Backward-compatible: an omitted `tenant` returns every scope (existing
   * no-arg callers are unaffected). A provided `tenant` returns only scopes
   * whose `tenant` equals it.
   *
   * @param tenant - optional tenant id to filter by; omit for all scopes.
   * @returns the matching scope definitions (empty when the registry is unset, missing, or has no match).
   */
  list(tenant?: string): readonly ScopeDefinition[] {
    const all = [...this.load().scopes.values()].map(s => this.withTenant(s))
    if (tenant === undefined) return all
    return all.filter(s => s.tenant === tenant)
  }

  /**
   * Get a scope by id. Returns undefined when not found.
   * @param id - the scope identifier to look up.
   * @returns the matching scope definition, or undefined when no scope has this id.
   */
  get(id: string): ScopeDefinition | undefined {
    const def = this.load().scopes.get(id)
    return def === undefined ? undefined : this.withTenant(def)
  }

  /**
   * Look up a scope belonging to a specific tenant.
   *
   * - `scopeId` provided → return the scope with that `id` IF it exists AND its
   *   `tenant === tenant`; otherwise `undefined`. (D3: 1:N tenants must pass scopeId.)
   * - `scopeId` omitted → return the single scope belonging to `tenant`:
   *   exactly 1 → return it; 0 → `undefined`; >1 → throw (ambiguous — 1:N
   *   tenants must pass scopeId). (D3: 1:1 may omit scopeId; 1:N requires it.)
   *
   * @param tenant - the tenant id whose scopes to look in.
   * @param scopeId - optional scope id; required when the tenant owns >1 scope.
   * @returns the matching scope definition, or undefined when no match exists.
   */
  forTenant(tenant: string, scopeId?: string): ScopeDefinition | undefined {
    const { scopes } = this.load()
    if (scopeId !== undefined) {
      const def = scopes.get(scopeId)
      if (!def) return undefined
      const resolved = this.withTenant(def)
      return resolved.tenant === tenant ? resolved : undefined
    }
    const owned: ScopeDefinition[] = []
    for (const d of scopes.values()) {
      const resolved = this.withTenant(d)
      if (resolved.tenant === tenant) owned.push(resolved)
    }
    if (owned.length === 0) return undefined
    if (owned.length > 1) {
      throw new Error(
        `ctx.scopes.forTenant: ambiguous - tenant "${tenant}" owns ${owned.length} scopes (${owned.map(s => s.id).join(', ')}); scopeId is required to disambiguate`,
      )
    }
    return owned[0]
  }

  /**
   * The currently active scope definition, or undefined if none is active.
   * @returns the active scope definition, or undefined when no scope is active.
   * @deprecated retained as compat fallback for unmigrated callers; Phase 4 / GA-GT1-cleanup removes
   */
  active(): ScopeDefinition | undefined {
    const { scopes, activeId } = this.load()
    // load() reports an activeId only when `scopes` already holds that key (it
    // gates on `scopes.has(parsed.active)`), so a separate "id set but
    // definition missing" arm can never run. Folding the lookup into the same
    // guard keeps the defensive undefined answer without that dead branch.
    const def = activeId === undefined ? undefined : scopes.get(activeId)
    return def === undefined ? undefined : this.withTenant(def)
  }

  /**
   * The currently active scope id, or undefined if none is active.
   * @returns the active scope id, or undefined when no scope is active.
   * @deprecated retained as compat fallback for unmigrated callers; Phase 4 / GA-GT1-cleanup removes
   */
  activeId(): string | undefined {
    return this.load().activeId
  }

  // ── Write API ───────────────────────────────────────────────────────────

  /**
   * Set the active scope by id. Throws if the scope does not exist in the registry.
   * @param id - the scope id to make active (must already be registered).
   * @deprecated retained as compat fallback for unmigrated callers; Phase 4 / GA-GT1-cleanup removes
   */
  async setActive(id: string): Promise<void> {
    this.ensureConfigured()
    await this.mutate((reg) => {
      if (!reg.scopes.has(id)) {
        throw new Error(`scope "${id}" not found in registry`)
      }
      reg.activeId = id
    })
    this.ctx.emit('scopes/active-changed', id)
  }

  /**
   * Clear the active scope (no scope is active).
   * @deprecated retained as compat fallback for unmigrated callers; Phase 4 / GA-GT1-cleanup removes
   */
  async clearActive(): Promise<void> {
    this.ensureConfigured()
    await this.mutate((reg) => { reg.activeId = undefined })
    this.ctx.emit('scopes/active-changed', undefined)
  }

  /**
   * Register (or update) a scope definition. If this is the first scope, it becomes active.
   * @param scope - the scope definition to register or update.
   */
  async register(scope: ScopeDefinition): Promise<void> {
    this.ensureConfigured()
    const becameActive = await this.mutate((reg) => {
      reg.scopes.set(scope.id, scope)
      if (reg.activeId === undefined) {
        reg.activeId = scope.id
        return true
      }
      return false
    })
    this.ctx.emit('scopes/changed')
    if (becameActive) this.ctx.emit('scopes/active-changed', scope.id)
  }

  /**
   * Remove a scope from the registry. If it was active, active becomes undefined.
   * @param id - the scope id to remove.
   */
  async remove(id: string): Promise<void> {
    this.ensureConfigured()
    const deactivated = await this.mutate((reg) => {
      reg.scopes.delete(id)
      if (reg.activeId === id) {
        reg.activeId = undefined
        return true
      }
      return false
    })
    this.ctx.emit('scopes/changed')
    if (deactivated) this.ctx.emit('scopes/active-changed', undefined)
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private ensureConfigured(): void {
    if (!this.registryPath) {
      throw new Error('ctx.scopes: registryPath not configured (set it in the bundle patch config)')
    }
  }

  /**
   * Resolve a scope's tenant to `"default"` when absent (D6: existing single
   * scope = "default"). The on-disk value stays raw (undefined) so a mutate()
   * round-trip preserves the original file shape; only the public read API
   * normalizes undefined → "default".
   */
  private withTenant(def: ScopeDefinition): ScopeDefinition {
    return def.tenant === undefined ? { ...def, tenant: 'default' } : def
  }

  /** Read registry from disk on every call (file is tiny; no cache needed). */
  private load(): { scopes: Map<string, ScopeDefinition>; activeId: string | undefined } {
    if (!this.registryPath) {
      return { scopes: new Map(), activeId: undefined }
    }
    if (!existsSync(this.registryPath)) {
      return { scopes: new Map(), activeId: undefined }
    }
    const raw = readFileSync(this.registryPath, 'utf-8')
    const parsed = yaml.load(raw) as RegistryFile | null
    if (!parsed || typeof parsed !== 'object') {
      return { scopes: new Map(), activeId: undefined }
    }
    const scopes = new Map<string, ScopeDefinition>()
    const rawScopes = parsed.scopes as Record<
      string,
      { semanticRoot?: unknown; tenant?: unknown; metadata?: unknown } | null | undefined
    > | undefined
    if (rawScopes) {
      for (const [id, def] of Object.entries(rawScopes)) {
        if (def && typeof def.semanticRoot === 'string') {
          scopes.set(id, {
            id,
            semanticRoot: def.semanticRoot,
            // Preserve the on-disk value as-is (string when set, undefined when
            // absent). The read API resolves undefined → "default" at the
            // boundary (see withTenant); keeping it raw here means a mutate()
            // round-trip re-writes the file in its original shape (no tenant
            // field stays absent) rather than upgrading every old entry.
            ...(typeof def.tenant === 'string' ? { tenant: def.tenant } : {}),
            ...(def.metadata ? { metadata: def.metadata as Record<string, unknown> } : {}),
          })
        }
      }
    }
    const activeId = typeof parsed.active === 'string' && scopes.has(parsed.active)
      ? parsed.active
      : undefined
    return { scopes, activeId }
  }

  /** Atomic read-modify-write cycle with cross-process file lock. */
  private async mutate<T>(
    fn: (reg: { scopes: Map<string, ScopeDefinition>; activeId: string | undefined }) => T,
  ): Promise<T> {
    return withFileLock(this.registryPath, async () => {
      const reg = this.load()
      const result = fn(reg)
      const fileContent = this.serialize(reg)
      await writeFileAtomic(this.registryPath, fileContent, {
        mode: 0o644,
        dirMode: 0o755,
      })
      return result
    })
  }

  /** Serialize registry state to YAML. */
  private serialize(
    reg: { scopes: Map<string, ScopeDefinition>; activeId: string | undefined },
  ): string {
    const scopes: NonNullable<RegistryFile['scopes']> = {}
    for (const [id, def] of reg.scopes) {
      scopes[id] = {
        semanticRoot: def.semanticRoot,
        // Include tenant only when set; omit when undefined so re-writing an
        // old file without tenant keeps the old (tenantless) shape.
        ...(def.tenant !== undefined ? { tenant: def.tenant } : {}),
        ...(def.metadata !== undefined ? { metadata: { ...def.metadata } } : {}),
      }
    }
    const obj: RegistryFile = {
      ...(reg.activeId !== undefined ? { active: reg.activeId } : {}),
      scopes,
    }
    return yaml.dump(obj, { sortKeys: true, lineWidth: 120 })
  }
}

export default ScopeRegistryService

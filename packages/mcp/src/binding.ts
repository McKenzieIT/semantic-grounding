/**
 * The entry-snapshot binding store — ADR-0011 ruling 1's concurrency model
 * ([#51](https://github.com/McKenzieIT/semantic-grounding/issues/51)).
 *
 * ## What this module owns
 *
 * MCP servers on this SDK dispatch handlers **un-serialized** (measured on
 * `@modelcontextprotocol/server@2.3.1`: `StdioServerTransport` pumps messages
 * synchronously and the protocol layer fires each handler on a detached
 * microtask — the next request enters before the previous one finishes; see #45's
 * resolution for both probes). v1's single hardcoded corpus had no global mutable
 * state, so that was invisible. `switch_scope` introduces one, and the ruling is:
 *
 * - every tool handler resolves its binding **synchronously at entry, before any
 *   `await`**, and uses that snapshot for the whole call;
 * - `switch_scope` is a plain pointer swap — atomic on a single-threaded runtime —
 *   and in-flight requests keep their old snapshot to the end: their writes land in
 *   the old scope's repo, with the old identity's trailers, and their responses
 *   carry the old stamp. The audit trail stays true through a switch;
 * - per-scope `{core, recorder}` instances are cached for the **process lifetime**
 *   and never disposed mid-flight (a disposed recorder under a straddling request is
 *   the `main.ts`-beforeExit failure shape). `disposeAll()` runs at `beforeExit`.
 *
 * Rejected in #45 and not reimplemented here: a global request mutex (kills read
 * concurrency, buys nothing — writes already serialize on the per-repo corpus
 * lock), a quiescence barrier (a slow read could block a switch indefinitely), and
 * "agents call tools one at a time anyway" (falsified by the probe above).
 *
 * No core is ever handed a scope registry (ADR-0011 constant 8): each
 * per-scope core gets its root statically at construction, which is what
 * keeps substrate changes at zero for this whole ticket.
 *
 * @module binding
 */
import { loadConcepts, loadEvents, loadTables, resolveSemanticLayer, SemanticGroundingCore } from '@semantic-grounding/substrate'
import { NoActiveScopeError, PostureRefusedError, ScopeNotFoundError, ScopeUnloadableError } from './errors.ts'
import { ensureStartupPosture, type PostureReport } from './git/posture.ts'
import { GitTier2Recorder } from './git/recorder.ts'
import type { CorpusLockOptions } from './git/lock.ts'
import type { ScopeEntry, ScopeRegistryFile } from './scope-registry.ts'

/** One resolved scope binding — the entry snapshot every handler carries. */
export interface ScopeBinding {
  /** The registry identity; rides the `X-SG-Scope` trailer and every response stamp. */
  readonly scopeId: string
  /** The scope's corpus/semantic root (a realpath captured at registration). */
  readonly semanticRoot: string
  /** The per-scope core, recorder already injected. */
  readonly core: SemanticGroundingCore
  /** The per-scope git recorder — drive writes through its `runAudited`. */
  readonly recorder: GitTier2Recorder
}

/** What {@link BindingStore.switchTo} did. */
export interface SwitchResult {
  readonly binding: ScopeBinding
  /** The previously active scope id, or null when nothing was active. */
  readonly switchedFrom: string | null
  /** Definition counts from the switched-to corpus — the "what did I land in" digest. */
  readonly counts: ScopeCounts
}

/** A corpus's definition counts, as `switch_scope` reports them. */
export interface ScopeCounts {
  readonly tables: number
  readonly events: number
  readonly concepts: number
}

/** Options for {@link BindingStore}'s constructor. */
export interface BindingStoreOptions {
  readonly registry: ScopeRegistryFile
  /** The process's agent id — every per-scope recorder is authored by it. */
  readonly agentId: string
  /** Corpus-lock tuning forwarded to posture and every recorder (ADR-0004 ruling 7). */
  readonly lock?: CorpusLockOptions
  /** Sink for posture recovery notices (ruling 6's loud recovery). */
  readonly logger?: (message: string) => void
  /**
   * Forwarded to every per-scope `SemanticGroundingCore` (default `true`, the
   * substrate's own default). No production call site has a reason to turn this
   * off; it exists so tests asserting "exactly one commit per call" can build a
   * store whose on-write hook does not fire.
   */
  readonly autoEnrich?: boolean
}

/**
 * The process-wide store of per-scope bindings plus the active pointer.
 *
 * Live state has exactly two mutation points, both a single synchronous
 * assignment (atomic on a single-threaded runtime): the pointer swap in
 * {@link switchTo}, and the guarded clear in {@link clearIfActive}. Everything
 * else is construction (cache-fill) or registry persistence. That is the whole
 * of the "atomic pointer replacement" ruling.
 */
export class BindingStore {
  private readonly registry: ScopeRegistryFile
  private readonly agentId: string
  private readonly lock: BindingStoreOptions['lock']
  private readonly logger: (message: string) => void
  private readonly autoEnrich: boolean
  /** Per-scope instances, cached for the process lifetime — switched-away entries stay (ruling 1). */
  private readonly cache = new Map<string, ScopeBinding>()
  /** The active binding. Written only by assignment (atomic), read only by {@link snapshot}. */
  private activeBinding: ScopeBinding | undefined

  /**
   * @param opts - see {@link BindingStoreOptions}.
   */
  constructor(opts: BindingStoreOptions) {
    this.registry = opts.registry
    this.agentId = opts.agentId
    this.lock = opts.lock
    this.logger = opts.logger ?? (() => {})
    this.autoEnrich = opts.autoEnrich ?? true
  }

  /**
   * The entry snapshot: read the active pointer synchronously.
   *
   * This is the call every definition-tool handler makes **first**, before any
   * `await` — the resolution being synchronous is what makes the snapshot immune
   * to a concurrent switch.
   * @returns the active binding, or undefined when no scope is active.
   */
  snapshot(): ScopeBinding | undefined {
    return this.activeBinding
  }

  /**
   * {@link snapshot} that refuses instead of returning undefined — the definition
   * tools' door. ADR-0011 ruling 3: with no active scope the honest answer is the
   * coded `no_active_scope` pointing at `switch_scope`, never a half-serving read.
   * @returns the active binding.
   * @throws NoActiveScopeError when nothing is active.
   */
  requireSnapshot(): ScopeBinding {
    const snap = this.activeBinding
    if (snap === undefined) {
      throw new NoActiveScopeError(
        'no active scope — this process has no scope bound (none was given via --scope, and the registry has no default or an unusable one)',
        { remedy: 'call switch_scope to bind one (register_scope first if it is not in the registry yet)' },
      )
    }
    return snap
  }

  /** The active scope id, or undefined — for banners and `get_scope`. */
  activeScopeId(): string | undefined {
    return this.activeBinding?.scopeId
  }

  /**
   * Switch: look the id up, re-run posture (constant 5 — cheap, and catches a moved
   * or dirtied directory since registration), lazily construct if this process has
   * never bound it, then atomically swap the pointer and persist the next-process
   * default (ruling 9's "switch updates its own binding and, in passing, the default").
   *
   * Construction is cached, but posture is **re-checked on every switch** — a cached
   * binding whose directory has since gone bad must refuse, not serve stale.
   * @param scopeId - the registry id to switch to.
   * @returns what the switch did.
   * @throws ScopeNotFoundError for an unknown id; #19's `posture_refused` (−31004)
   *   for a directory that no longer passes posture; ScopeUnloadableError when the
   *   corpus will not load.
   */
  async switchTo(scopeId: string): Promise<SwitchResult> {
    const entry = this.entryOrThrow(scopeId)
    await this.postureOrThrow(entry) // constant 5: every switch re-runs posture, cached or not
    const binding = await this.bindingFor(entry)
    const counts = this.countsOrThrow(entry)
    const switchedFrom = this.activeBinding?.scopeId ?? null
    this.activeBinding = binding // the atomic pointer swap — one assignment, nothing else
    await this.registry.setActive(scopeId)
    return { binding, switchedFrom, counts }
  }

  /**
   * The `--scope` startup path: bind eagerly and refuse the process if it cannot
   * be served (exit 78 semantics live in `main.ts`; this just throws the coded
   * error). Deliberately does **not** persist `active:` — an explicit per-process
   * flag is not a new default for every other process (the default changes only
   * through `switch_scope`, which is an agent's own act).
   * @param scopeId - the id from `--scope`.
   * @returns the bound snapshot.
   * @throws ScopeNotFoundError (id not in the table — the message points at
   *   `register_scope`), #19's `posture_refused`, or ScopeUnloadableError.
   */
  async bindStartup(scopeId: string): Promise<ScopeBinding> {
    const entry = this.entryOrThrow(scopeId)
    await this.postureOrThrow(entry)
    const binding = await this.bindingFor(entry)
    this.activeBinding = binding
    return binding
  }

  /**
   * The no-flag startup path: restore the registry's `active:` default if it has
   * one, degrading to "no active scope" when it cannot be served (the default is a
   * convenience, not an operator demand — unlike `--scope`, a stale default must
   * not kill the process; the management tools still work, and the first
   * definition-tool call will say `no_active_scope` with the remedy).
   * @returns the restored binding, or undefined when there was no default or it would not serve.
   */
  async restoreActive(): Promise<ScopeBinding | undefined> {
    const activeId = this.registry.read().active ?? undefined
    if (activeId === undefined) return undefined
    try {
      return await this.bindStartup(activeId)
    } catch (e) {
      this.logger(`[semantic-grounding] registry default scope "${activeId}" is not servable (${e instanceof Error ? e.message : String(e)}); serving with no active scope — switch_scope when ready`)
      return undefined
    }
  }

  /** Dispose every cached core — `beforeExit` only, never mid-flight (ruling 1). */
  disposeAll(): void {
    for (const binding of this.cache.values()) binding.core.dispose()
    this.cache.clear()
  }

  /**
   * Deregistration's live-state half (#72 ruling 4): when this process is serving
   * the named scope, drop the active binding so later calls answer
   * `no_active_scope` instead of writing into a corpus the registry just
   * delisted. A guarded single assignment — the same shape and atomicity as
   * `switchTo`'s pointer swap, synchronous, no awaits. The per-scope instance
   * cache is untouched: eviction stays ADR-0011's own Followup (驻留成本), and a
   * re-registered id switched back to reuses the cached instances. Another
   * process serving the scope is unreachable by design — "where I am" is
   * per-process (ruling 9); cross-process coordination is map #50's ruled-out
   * territory.
   * @param scopeId - the scope `deregister_scope` just removed from the registry.
   * @returns whether this process's binding named the scope.
   */
  clearIfActive(scopeId: string): boolean {
    if (this.activeBinding?.scopeId !== scopeId) return false
    this.activeBinding = undefined
    return true
  }

  /** The registry lookup shared by every entry point. */
  private entryOrThrow(scopeId: string): ScopeEntry {
    const entry = this.registry.getEntry(scopeId)
    if (entry === undefined) {
      throw new ScopeNotFoundError(
        `scope "${scopeId}" is not in the registry — nothing to bind`,
        { scope_id: scopeId, remedy: 'register_scope it first (get_scope_scaffold lays out the shell if the corpus does not exist yet)' },
      )
    }
    return entry
  }

  /** Posture, re-used from #19 — the same soft refusals with remedies, thrown as-is. */
  private async postureOrThrow(entry: ScopeEntry): Promise<PostureReport> {
    return ensureStartupPosture({ corpusRoot: entry.semanticRoot, agentId: this.agentId, ...this.lock !== undefined ? { lock: this.lock } : {}, logger: this.logger })
  }

  /** Cache-fill construction: posture passed, so build the recorder and core this process will reuse forever. */
  private async bindingFor(entry: ScopeEntry): Promise<ScopeBinding> {
    const cached = this.cache.get(entry.id)
    if (cached !== undefined) return cached
    let binding: ScopeBinding
    try {
      const report = await this.postureOrThrow(entry) // construction re-runs posture: the recorder wants its resolved paths
      const recorder = new GitTier2Recorder({
        corpusRoot: entry.semanticRoot,
        agentId: this.agentId,
        paths: report.paths,
        ...this.lock !== undefined ? { lock: this.lock } : {},
        scopeId: entry.id,
      })
      await recorder.ready()
      // autoEnrich at its real default (true) — the on-write hook's derived commit is
      // ADR-0004's 2026-10-09 ruling; see `main.ts`'s identical comment. Overridable
      // only by tests (BindingStoreOptions.autoEnrich) that assert exactly one commit
      // per call.
      const core = new SemanticGroundingCore({ semanticRoot: entry.semanticRoot, scopeId: entry.id, autoEnrich: this.autoEnrich })
      core.setTier2Recorder(recorder)
      binding = { scopeId: entry.id, semanticRoot: entry.semanticRoot, core, recorder }
    } catch (e) {
      if (e instanceof PostureRefusedError || e instanceof ScopeNotFoundError) throw e
      throw new ScopeUnloadableError(
        `scope "${entry.id}" passed posture but its corpus would not load (${e instanceof Error ? e.message : String(e)})`,
        { scope_id: entry.id, semantic_root: entry.semanticRoot },
      )
    }
    this.cache.set(entry.id, binding)
    return binding
  }

  /** Definition counts via the substrate's own loaders — the switch response's landing digest. */
  private countsOrThrow(entry: ScopeEntry): ScopeCounts {
    return scopeCountsOrThrow(entry)
  }
}

/** Load all three definition families off one scope's root, mapping failure to `scope_unloadable`. */
function scopeCountsOrThrow(entry: ScopeEntry): ScopeCounts {
  try {
    // The corpus may live at the root or a single child layer (GLOSSARY § corpus);
    // the substrate's own layout resolution decides, so these loads see what the
    // core will see.
    const layer = resolveSemanticLayer(entry.semanticRoot)
    return {
      tables: loadTables(layer).length,
      events: loadEvents(layer).length,
      concepts: loadConcepts(layer).length,
    }
  } catch (e) {
    throw new ScopeUnloadableError(
      `scope "${entry.id}" passed posture but its corpus would not load (${e instanceof Error ? e.message : String(e)})`,
      { scope_id: entry.id, semantic_root: entry.semanticRoot },
    )
  }
}

/**
 * Register-time full-load validation (constant 2): posture passed, so prove the
 * corpus actually loads — all three definition families, the substrate's own
 * loaders — **before** the entry enters the table. A broken config must fail at
 * the door, not at first switch.
 * @param semanticRoot - the realpath the tool resolved.
 * @throws ScopeUnloadableError when the corpus does not load.
 */
export function assertScopeLoadable(semanticRoot: string): void {
  try {
    const layer = resolveSemanticLayer(semanticRoot)
    loadTables(layer)
    loadEvents(layer)
    loadConcepts(layer)
  } catch (e) {
    throw new ScopeUnloadableError(
      `corpus at ${semanticRoot} does not load (${e instanceof Error ? e.message : String(e)}) — refusing to register a scope that cannot serve`,
      { semantic_root: semanticRoot },
    )
  }
}

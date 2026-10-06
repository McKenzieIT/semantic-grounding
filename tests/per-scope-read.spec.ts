/**
 * GA-GT1 Phase 2 (D4 β) — per-request scope on the SemanticLayerService READ
 * methods. The 5 substrate read methods (`loadTableDefinition`,
 * `getRelationGraph`, `acquireSnapshot`, `loadRetrievalCorpus`,
 * `corpusVersion`) each gain an OPTIONAL trailing `scopeId?` param; omitted,
 * they behave EXACTLY as before (active scope — backward-compatible). A
 * provided `scopeId` resolves that scope's `semanticRoot` via the mounted
 * scope-registry's `get(id)` (Phase 1), with a per-scope LRU layered
 * ALONGSIDE the existing instance cache for `getRelationGraph`.
 *
 * Coverage:
 *  (a) scopeId-provided resolves the correct scope's root when a multi-scope
 *      registry is mounted (active scope is the OTHER one — proves scopeId
 *      overrides active, not the reverse).
 *  (b) scopeId undefined → active scope (backward-compat — existing no-arg
 *      callers are unaffected).
 *  (c) per-scope LRU caches per scopeId + invalidates when
 *      `corpusVersion(scopeId)` changes (write → invalidateCaches bump); the
 *      other scope's cache entry is untouched.
 *  (d) scopeId-provided-but-not-found with registry mounted → throws
 *      (fail-loud — refuse silent fallback to active scope to prevent
 *      cross-tenant corpus leak).
 *  (e) registry unmounted + scopeId provided → falls back to the active/cfg
 *      root (test stand-in — no throw).
 *
 * Mounts the REAL ScopeRegistryService via direct construction (same pattern as
 * scope-delegation.spec.ts + scope-registry's own tests), sidestepping the
 * test-invariants `ctx.plugin` proxy. The SUT still probes via
 * `ctx.get('scopes')` — the production path.
 *
 * Run: `pnpm vitest run packages/data/semantic-layer/tests/per-scope-read.spec.ts`
 */
import { test, expect, describe, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SemanticLayerService, clearSnapshotCache } from '../src/index.ts'
import ScopeRegistryService from '../src/vendor/scope-registry.ts'
import { invalidateCaches } from '../src/io.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A minimal valid event yaml with a distinctive name + description per scope. */
function eventYaml(name: string, desc: string): string {
  return yaml.dump({
    name, description: desc, domains: ['test'],
    params_fields: { server_id: { type: 'string', description: '区服' } },
    metrics: {}, external_refs: [], disambiguation: [],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' }, coverage: null,
  })
}

/** A minimal valid table yaml with a distinctive table_name per scope. */
function tableYaml(tableName: string, desc: string): string {
  return yaml.dump({
    table_name: tableName,
    kind: 'dim',
    primary_key: ['server_id'],
    label_columns: ['server_id'],
    columns: [{ name: 'server_id', type: 'string', comment: '区服ID', role: 'dimension' }],
    metrics: {},
    partitions: [{ name: 'ds', type: 'string' }],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    domains: [],
    description: desc,
    table_comment: '',
    granularity: '',
    engine: 'maxcompute',
    coverage: null,
    supersedes: [],
    disambiguation: null,
    primary_key_unique: null,
    duplicate_sample: [],
    freshness: '',
    dimension_refs: [],
  })
}

/** A throwaway semantic-layer root: config.yaml + one distinctive event + table. */
function makeScopeDir(scopeId: string, eventName: string, tableName: string): string {
  const dir = mkdtempSync(join(tmpdir(), `p2-scope-${scopeId}-`))
  writeFileSync(join(dir, 'config.yaml'), `project:\n  name: ${scopeId}\n  scope_id: ${scopeId}\n`)
  mkdirSync(join(dir, 'events', 'test'), { recursive: true })
  writeFileSync(join(dir, 'events', 'test', `${eventName}.yaml`), eventYaml(eventName, `event for ${scopeId}`))
  mkdirSync(join(dir, 'tables'), { recursive: true })
  writeFileSync(join(dir, 'tables', `${tableName}.yaml`), tableYaml(tableName, `table for ${scopeId}`))
  return dir
}

/** A DWS table yaml with a dimension_ref to `dimTable` (produces a graph join edge
 *  so content assertions can tell K11 + X63 graphs apart — empty dimension_refs
 *  would leave the graph nodeless). */
function dwsTableYaml(dwsTable: string, dimTable: string): string {
  return yaml.dump({
    table_name: dwsTable,
    kind: 'dws',
    primary_key: ['server_id'],
    label_columns: ['server_id'],
    columns: [{ name: 'server_id', type: 'string', comment: '区服ID', role: 'dimension' }],
    metrics: {},
    partitions: [{ name: 'ds', type: 'string' }],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    domains: [],
    description: `dws table ${dwsTable}`,
    table_comment: '', granularity: '', engine: 'maxcompute', coverage: null,
    supersedes: [], disambiguation: null,
    primary_key_unique: null,
    duplicate_sample: [],
    freshness: '',
    dimension_refs: [{ dim_table: dimTable, join_keys: [{ dws_column: 'server_id', dim_column: 'server_id' }], derivation: '' }],
  })
}

/** Richer scope dir: config.yaml + event + a DWS table with a dimension_ref (the
 *  ref produces a distinguishable join edge in the relation graph). Used by the
 *  content-asserting tests (c)/(e)/(f). */
function makeScopeDirWithGraph(scopeId: string, eventName: string, dwsTable: string, dimTable: string): string {
  const dir = mkdtempSync(join(tmpdir(), `p2-scope-${scopeId}-`))
  writeFileSync(join(dir, 'config.yaml'), `project:\n  name: ${scopeId}\n  scope_id: ${scopeId}\n`)
  mkdirSync(join(dir, 'events', 'test'), { recursive: true })
  writeFileSync(join(dir, 'events', 'test', `${eventName}.yaml`), eventYaml(eventName, `event for ${scopeId}`))
  mkdirSync(join(dir, 'tables'), { recursive: true })
  writeFileSync(join(dir, 'tables', `${dwsTable}.yaml`), dwsTableYaml(dwsTable, dimTable))
  return dir
}

describe('GA-GT1 Phase 2 — SemanticLayerService per-request scopeId on read methods (D4 β)', () => {
  const tmps: string[] = []

  afterEach(() => {
    clearSnapshotCache()
    while (tmps.length) {
      const d = tmps.pop()!
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best-effort teardown */ }
    }
  })

  /** A context + real ScopeRegistryService (direct construct, registered under
   *  the 'scopes' name by the Service base constructor so `ctx.get('scopes')` resolves). */
  function setup(): { ctx: Context; scopes: ScopeRegistryService } {
    const ctx = new Context()
    const reg = mkdtempSync(join(tmpdir(), 'p2-scope-reg-')); tmps.push(reg)
    const scopes = new ScopeRegistryService(ctx, { registryPath: join(reg, 'scopes.yaml') })
    return { ctx, scopes }
  }

  // (a) scopeId-provided resolves the correct scope's root (active = the OTHER scope)
  test('(a) scopeId overrides active scope for loadTableDefinition / loadRetrievalCorpus / acquireSnapshot', async () => {
    const { ctx, scopes } = setup()
    const kRoot = makeScopeDir('10000251', 'k11.only_event', 'k11_only_table'); tmps.push(kRoot)
    const xRoot = makeScopeDir('10000334', 'x63.only_event', 'x63_only_table'); tmps.push(xRoot)
    await scopes.register({ id: '10000251', semanticRoot: kRoot })
    await scopes.register({ id: '10000334', semanticRoot: xRoot })
    // oxlint-disable-next-line typescript/no-deprecated -- active-scope API; no replacement until Phase 4 GA-GT1-cleanup
    await scopes.setActive('10000334') // X63 active — scopeId must override it
    const svc = new SemanticLayerService(ctx, { semanticRoot: kRoot })

    // loadTableDefinition(name, scopeId) resolves the named scope's root
    expect(svc.loadTableDefinition('k11_only_table', '10000251')).not.toBeNull() // K11 root
    expect(svc.loadTableDefinition('x63_only_table', '10000251')).toBeNull()      // K11 root has no x63 table
    expect(svc.loadTableDefinition('x63_only_table', '10000334')).not.toBeNull()  // X63 root
    expect(svc.loadTableDefinition('k11_only_table', '10000334')).toBeNull()      // X63 root has no k11 table

    // loadRetrievalCorpus(scopeId) resolves the named scope's event corpus
    const kCorpus = svc.loadRetrievalCorpus('10000251').map(c => c.id)
    expect(kCorpus).toContain('k11.only_event')
    expect(kCorpus).not.toContain('x63.only_event')
    const xCorpus = svc.loadRetrievalCorpus('10000334').map(c => c.id)
    expect(xCorpus).toContain('x63.only_event')
    expect(xCorpus).not.toContain('k11.only_event')

    // acquireSnapshot(scopeId) pins the named scope's root
    const kSnap = svc.acquireSnapshot('10000251')
    expect(kSnap.loadTableDefinition('k11_only_table')).not.toBeNull()
    expect(kSnap.loadTableDefinition('x63_only_table')).toBeNull()
  })

  // (b) scopeId undefined → active scope (backward-compatible)
  test('(b) no-arg reads resolve the ACTIVE scope (backward-compat — scopeId omitted)', async () => {
    const { ctx, scopes } = setup()
    const kRoot = makeScopeDir('10000251', 'k11.only_event', 'k11_only_table'); tmps.push(kRoot)
    const xRoot = makeScopeDir('10000334', 'x63.only_event', 'x63_only_table'); tmps.push(xRoot)
    await scopes.register({ id: '10000251', semanticRoot: kRoot })
    await scopes.register({ id: '10000334', semanticRoot: xRoot })
    // oxlint-disable-next-line typescript/no-deprecated -- active-scope API; no replacement until Phase 4 GA-GT1-cleanup
    await scopes.setActive('10000334') // X63 active
    const svc = new SemanticLayerService(ctx, { semanticRoot: kRoot })

    // No scopeId → active (X63) scope, NOT the cfg semanticRoot (kRoot)
    expect(svc.loadTableDefinition('x63_only_table')).not.toBeNull()
    expect(svc.loadTableDefinition('k11_only_table')).toBeNull()
    const corpus = svc.loadRetrievalCorpus().map(c => c.id)
    expect(corpus).toContain('x63.only_event')
    expect(corpus).not.toContain('k11.only_event')
    const snap = svc.acquireSnapshot()
    expect(snap.loadTableDefinition('x63_only_table')).not.toBeNull()
    expect(snap.loadTableDefinition('k11_only_table')).toBeNull()
  })

  // (c) per-scope LRU caches per scopeId + invalidates on corpusVersion(scopeId) change
  test('(c) getRelationGraph(scopeId) per-scope LRU: cache hit is identity-stable; invalidateCaches rebuilds; other scope untouched', async () => {
    const { ctx, scopes } = setup()
    const kRoot = makeScopeDirWithGraph('10000251', 'k11.only_event', 'k11_dws', 'k11_only_dim'); tmps.push(kRoot)
    const xRoot = makeScopeDirWithGraph('10000334', 'x63.only_event', 'x63_dws', 'x63_only_dim'); tmps.push(xRoot)
    await scopes.register({ id: '10000251', semanticRoot: kRoot })
    await scopes.register({ id: '10000334', semanticRoot: xRoot })
    // oxlint-disable-next-line typescript/no-deprecated -- active-scope API; no replacement until Phase 4 GA-GT1-cleanup
    await scopes.setActive('10000334')
    const svc = new SemanticLayerService(ctx, { semanticRoot: kRoot })

    // corpusVersion(scopeId) is the per-path content counter (no epoch on the scopeId path)
    const kV0 = svc.corpusVersion('10000251')
    const xV0 = svc.corpusVersion('10000334')
    expect(kV0).toBeGreaterThanOrEqual(0)
    expect(xV0).toBeGreaterThanOrEqual(0)

    // Cache hit: same instance across repeated calls for the same scopeId
    const g1 = svc.getRelationGraph('10000251')
    const g2 = svc.getRelationGraph('10000251')
    expect(g2).toBe(g1) // cached — no rebuild
    const x1 = svc.getRelationGraph('10000334')
    expect(x1).not.toBe(g1) // distinct scope → distinct graph instance
    // M-4: content correctness — K11 graph holds the K11-only join edge, not X63's; X63's is the reverse.
    expect(g1.findJoinPath('k11_dws', 'k11_only_dim')).not.toBeNull()
    expect(g1.findJoinPath('x63_dws', 'x63_only_dim')).toBeNull()
    expect(x1.findJoinPath('x63_dws', 'x63_only_dim')).not.toBeNull()
    expect(x1.findJoinPath('k11_dws', 'k11_only_dim')).toBeNull()

    // Invalidate K11's root only — bumps corpusVersion('10000251') but NOT '10000334'
    invalidateCaches(kRoot)
    const kV1 = svc.corpusVersion('10000251')
    const xV1 = svc.corpusVersion('10000334')
    expect(kV1).toBeGreaterThan(kV0) // K11 counter bumped → stale cache → rebuild
    expect(xV1).toBe(xV0)            // X63 counter unchanged → cache still valid

    // K11 rebuilt (new instance); X63 still cached (same instance)
    const g3 = svc.getRelationGraph('10000251')
    expect(g3).not.toBe(g1) // rebuilt after invalidation
    // M-4: rebuilt K11 graph still holds the K11-only join edge (content preserved across rebuild)
    expect(g3.findJoinPath('k11_dws', 'k11_only_dim')).not.toBeNull()
    const x2 = svc.getRelationGraph('10000334')
    expect(x2).toBe(x1) // X63 untouched by K11 invalidation
  })

  // (d) scopeId-provided-but-not-found + registry mounted → throws (fail-loud)
  test('(d) scopeId not found in mounted registry → throws (intranet-security: no silent fallback)', async () => {
    const { ctx, scopes } = setup()
    const kRoot = makeScopeDir('10000251', 'k11.only_event', 'k11_only_table'); tmps.push(kRoot)
    await scopes.register({ id: '10000251', semanticRoot: kRoot })
    // oxlint-disable-next-line typescript/no-deprecated -- active-scope API; no replacement until Phase 4 GA-GT1-cleanup
    await scopes.setActive('10000251')
    const svc = new SemanticLayerService(ctx, { semanticRoot: kRoot })

    // Every scopeId-accepting read must throw, not silently fall back to active
    expect(() => svc.loadTableDefinition('k11_only_table', 'nope-scope')).toThrow(/not found in registry/)
    expect(() => svc.loadRetrievalCorpus('nope-scope')).toThrow(/not found in registry/)
    expect(() => svc.acquireSnapshot('nope-scope')).toThrow(/not found in registry/)
    expect(() => svc.getRelationGraph('nope-scope')).toThrow(/not found in registry/)
    expect(() => svc.corpusVersion('nope-scope')).toThrow(/not found in registry/)
  })

  // (e) registry unmounted + scopeId provided → falls back to active/cfg root (no throw)
  test('(e) registry unmounted + scopeId provided → falls back to cfg root (test stand-in, no throw)', () => {
    const ctx = new Context() // no scope-registry mounted
    const kRoot = makeScopeDirWithGraph('10000251', 'k11.only_event', 'k11_dws', 'k11_only_dim'); tmps.push(kRoot)
    const svc = new SemanticLayerService(ctx, { semanticRoot: kRoot })

    // scopeId is provided but the registry is unmounted → resolveRoot falls back to cfg root
    expect(() => svc.loadRetrievalCorpus('any-scope-id')).not.toThrow()
    expect(() => svc.getRelationGraph('any-scope-id')).not.toThrow()
    expect(() => svc.corpusVersion('any-scope-id')).not.toThrow()
    expect(() => svc.acquireSnapshot('any-scope-id')).not.toThrow()
    // The fallback resolves the cfg root (K11), so K11's corpus/table are served
    const corpus = svc.loadRetrievalCorpus('any-scope-id').map(c => c.id)
    expect(corpus).toContain('k11.only_event')
    expect(svc.loadTableDefinition('k11_dws', 'any-scope-id')).not.toBeNull()
    // M-3: the graph also reflects the cfg root's content (the K11 DWS→dim join edge), not just "no throw"
    const g = svc.getRelationGraph('any-scope-id')
    expect(g.findJoinPath('k11_dws', 'k11_only_dim')).not.toBeNull()
  })

  // (f) I-1 regression: re-registering a scope with a different semanticRoot
  // invalidates the per-scope cache — no silent cross-tenant corpus leak.
  test('(f) I-1: re-registering scope with a different root rebuilds the graph (no cross-tenant leak)', async () => {
    const { ctx, scopes } = setup()
    const kRoot = makeScopeDirWithGraph('A', 'k11.only_event', 'k11_dws', 'k11_only_dim'); tmps.push(kRoot)
    const xRoot = makeScopeDirWithGraph('A', 'x63.only_event', 'x63_dws', 'x63_only_dim'); tmps.push(xRoot)
    // Register 'A' → K11 root; build + cache {root:kRoot, version:0}
    await scopes.register({ id: 'A', semanticRoot: kRoot })
    const svc = new SemanticLayerService(ctx, { semanticRoot: kRoot })
    const g1 = svc.getRelationGraph('A')
    expect(g1.findJoinPath('k11_dws', 'k11_only_dim')).not.toBeNull() // K11 content
    expect(g1.findJoinPath('x63_dws', 'x63_only_dim')).toBeNull()

    // Re-register 'A' → X63 root (same id, different tenant content). Both roots
    // were never written, so corpusVersionForRoot is 0 for each — without the root
    // check the cache would HIT (version 0===0) + serve g1 (K11) → cross-tenant leak.
    await scopes.register({ id: 'A', semanticRoot: xRoot })
    const g2 = svc.getRelationGraph('A')
    expect(g2.findJoinPath('x63_dws', 'x63_only_dim')).not.toBeNull() // X63 content (rebuilt from xRoot)
    expect(g2.findJoinPath('k11_dws', 'k11_only_dim')).toBeNull()      // K11-only content gone
    expect(g2).not.toBe(g1) // rebuilt — a fresh RelationGraph instance
  })

  // ── Phase 5a: resolveScopeRoot — the PUBLIC root-resolution seam ──────────
  // Exposed in 5a so consumer packages (enrichedLinkers/scopedRetrievers) can
  // resolve a scope's root for the #19/#22 root-check fix (5b adds `root` to
  // the per-scope cache entry). Delegates to the private resolveRoot; the 4
  // branches are identical to the Phase 2 tests above, just on the public seam.

  // (5a-a) scopeId undefined → active scope's semanticRoot
  test('(5a-a) resolveScopeRoot() returns the active scope semanticRoot', async () => {
    const { ctx, scopes } = setup()
    const kRoot = makeScopeDir('10000251', 'k11.only_event', 'k11_only_table'); tmps.push(kRoot)
    const xRoot = makeScopeDir('10000334', 'x63.only_event', 'x63_only_table'); tmps.push(xRoot)
    await scopes.register({ id: '10000251', semanticRoot: kRoot })
    await scopes.register({ id: '10000334', semanticRoot: xRoot })
    // oxlint-disable-next-line typescript/no-deprecated -- active-scope API; no replacement until Phase 4 GA-GT1-cleanup
    await scopes.setActive('10000334') // X63 active
    const svc = new SemanticLayerService(ctx, { semanticRoot: kRoot })

    // undefined scopeId → active (X63) root, NOT the cfg.semanticRoot
    expect(svc.resolveScopeRoot()).toBe(xRoot)
  })

  // (5a-b) scopeId provided + multi-scope registry mounted → named scope root
  test('(5a-b) resolveScopeRoot(scopeId) resolves the named scope root (active = other scope)', async () => {
    const { ctx, scopes } = setup()
    const kRoot = makeScopeDir('10000251', 'k11.only_event', 'k11_only_table'); tmps.push(kRoot)
    const xRoot = makeScopeDir('10000334', 'x63.only_event', 'x63_only_table'); tmps.push(xRoot)
    await scopes.register({ id: '10000251', semanticRoot: kRoot })
    await scopes.register({ id: '10000334', semanticRoot: xRoot })
    // oxlint-disable-next-line typescript/no-deprecated -- active-scope API; no replacement until Phase 4 GA-GT1-cleanup
    await scopes.setActive('10000334') // X63 active — scopeId overrides
    const svc = new SemanticLayerService(ctx, { semanticRoot: kRoot })

    expect(svc.resolveScopeRoot('10000251')).toBe(kRoot) // named K11 root
    expect(svc.resolveScopeRoot('10000334')).toBe(xRoot) // named X63 root
  })

  // (5a-c) scopeId provided + mounted + not found → throw fail-loud
  test('(5a-c) resolveScopeRoot(unknown) throws — no silent fallback to active', async () => {
    const { ctx, scopes } = setup()
    const kRoot = makeScopeDir('10000251', 'k11.only_event', 'k11_only_table'); tmps.push(kRoot)
    await scopes.register({ id: '10000251', semanticRoot: kRoot })
    // oxlint-disable-next-line typescript/no-deprecated -- active-scope API; no replacement until Phase 4 GA-GT1-cleanup
    await scopes.setActive('10000251')
    const svc = new SemanticLayerService(ctx, { semanticRoot: kRoot })

    expect(() => svc.resolveScopeRoot('nope-scope')).toThrow(/not found in registry/)
  })

  // (5a-d) registry unmounted + scopeId provided → cfg root fallback (no throw)
  test('(5a-d) resolveScopeRoot(scopeId) with registry unmounted → cfg root fallback (no throw)', () => {
    const ctx = new Context() // no scope-registry mounted
    const kRoot = makeScopeDirWithGraph('10000251', 'k11.only_event', 'k11_dws', 'k11_only_dim'); tmps.push(kRoot)
    const svc = new SemanticLayerService(ctx, { semanticRoot: kRoot })

    expect(() => svc.resolveScopeRoot('any-scope-id')).not.toThrow()
    expect(svc.resolveScopeRoot('any-scope-id')).toBe(kRoot)
  })
})

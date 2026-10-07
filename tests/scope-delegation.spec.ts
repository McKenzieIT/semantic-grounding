/**
 * P1 wiring — SemanticGroundingCore delegates semanticRoot/scopeId to the
 * optional `ctx.scopes` (scope-registry) and invalidates its corpus-version
 * signal on every scope switch. Mounts the REAL ScopeRegistryService via direct
 * construction (`new ScopeRegistryService(ctx, …)` — the same pattern
 * scope-registry's own tests use), sidestepping the test-invariants `ctx.plugin`
 * proxy that requires an `src/invariant.ts` companion semantic-layer lacks.
 * The SUT's getter still probes via `ctx.get('scopes')` — the production path.
 *
 * The fourth test is the correctness gate for the silent semantic-layer leak:
 * tool-search-data-sources caches its BM25 linker in a WeakMap<instance, version>,
 * and the instance is the same singleton across scope switches — so the version
 * number alone must change on EVERY switch, including switch-BACK, where the new
 * scope's per-path counter can otherwise collide with the cached value and serve
 * the wrong scope's corpus. A naive `invalidateCaches(newPath)` listener fails
 * that case; only a strictly-monotonic scope-switch epoch passes it.
 *
 * Run: `pnpm vitest run packages/data/semantic-layer/tests/scope-delegation.spec.ts`
 */
import { test, expect, describe, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SemanticGroundingCore } from '../src/index.ts'
import ScopeRegistryService from './fixtures/scope-registry.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'

/** Minimal event yaml; each scope gets a distinct event name so its corpus is
 *  unambiguously identifiable (a K11 corpus must never surface an X63-only event). */
function eventYaml(name: string, desc: string): string {
  return yaml.dump({
    name, description: desc, domains: ['test'],
    params_fields: { server_id: { type: 'string', description: '区服' } },
    metrics: {}, external_refs: [], disambiguation: [],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' }, coverage: null,
  })
}

/** A throwaway semantic-layer root (config.yaml + one distinctive event). */
function makeScopeDir(scopeId: string, eventName: string): string {
  const dir = mkdtempSync(join(tmpdir(), `scope-${scopeId}-`))
  writeFileSync(join(dir, 'config.yaml'), `project:\n  name: ${scopeId}\n  scope_id: ${scopeId}\n`)
  mkdirSync(join(dir, 'events', 'test'), { recursive: true })
  writeFileSync(join(dir, 'events', 'test', `${eventName}.yaml`), eventYaml(eventName, `event for ${scopeId}`))
  return dir
}

describe('SemanticGroundingCore ctx.scopes delegation (P1 wiring)', () => {
  const tmps: string[] = []

  afterEach(() => {
    while (tmps.length) {
      const d = tmps.pop()!
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best-effort teardown */ }
    }
  })

  /** A context + real ScopeRegistryService (direct construct, registered under
   *  the 'scopes' name by the Service base constructor so `ctx.get('scopes')` resolves). */
  function setup(): { ctx: Context; scopes: ScopeRegistryService } {
    const ctx = new Context()
    const reg = mkdtempSync(join(tmpdir(), 'scope-reg-'))
    tmps.push(reg)
    const scopes = new ScopeRegistryService(ctx, { registryPath: join(reg, 'scopes.yaml') })
    return { ctx, scopes }
  }

  test('semanticRoot + scopeId delegate to ctx.scopes.active() when scope-registry is mounted', async () => {
    const { ctx, scopes } = setup()
    const xRoot = makeScopeDir('10000334', 'x63.only_event'); tmps.push(xRoot)
    await scopes.register({ id: '10000334', semanticRoot: xRoot })
    const svc = new SemanticGroundingCore({ semanticRoot: '/static-fallback', scopeId: 'fallback' })
    svc.setScopeRegistry(scopes) // P1: setter-injected, no longer ctx.get(\'scopes\')
    expect(svc.semanticRoot).toBe(xRoot)
    expect(svc.scopeId).toBe('10000334')
  })

  test('semanticRoot + scopeId fall back to static config when scope-registry is unmounted', () => {
    const svc = new SemanticGroundingCore({ semanticRoot: '/static-fallback', scopeId: 'fallback' })
    expect(svc.semanticRoot).toBe('/static-fallback')
    expect(svc.scopeId).toBe('fallback')
  })

  test('switching active scope swaps the loaded corpus — K11 corpus never surfaces X63 events, and vice versa', async () => {
    const { ctx, scopes } = setup()
    const kRoot = makeScopeDir('10000251', 'k11.only_event'); tmps.push(kRoot)
    const xRoot = makeScopeDir('10000334', 'x63.only_event'); tmps.push(xRoot)
    await scopes.register({ id: '10000251', semanticRoot: kRoot })
    await scopes.register({ id: '10000334', semanticRoot: xRoot })
    const svc = new SemanticGroundingCore({ semanticRoot: kRoot })
    svc.setScopeRegistry(scopes) // P1: setter-injected, no longer ctx.get(\'scopes\')

    // K11 active → K11 corpus only
    const kCorpus = svc.loadRetrievalCorpusAll().map(c => c.id)
    expect(kCorpus).toContain('k11.only_event')
    expect(kCorpus).not.toContain('x63.only_event')

    // switch → X63 → X63 corpus only (never K11)
    // oxlint-disable-next-line typescript/no-deprecated -- active-scope API; no replacement until Phase 4 GA-GT1-cleanup
    await scopes.setActive('10000334')
    const xCorpus = svc.loadRetrievalCorpusAll().map(c => c.id)
    expect(xCorpus).toContain('x63.only_event')
    expect(xCorpus).not.toContain('k11.only_event')
  })

  test('corpusVersion changes on every scope switch — including switch-back (no stale-linker collision)', async () => {
    const { ctx, scopes } = setup()
    const kRoot = makeScopeDir('10000251', 'k11.only_event'); tmps.push(kRoot)
    const xRoot = makeScopeDir('10000334', 'x63.only_event'); tmps.push(xRoot)
    await scopes.register({ id: '10000251', semanticRoot: kRoot })
    await scopes.register({ id: '10000334', semanticRoot: xRoot })
    const svc = new SemanticGroundingCore({ semanticRoot: kRoot })
    svc.setScopeRegistry(scopes) // P1: setter-injected, no longer ctx.get(\'scopes\')

    const v0 = svc.corpusVersion()                  // K11 active
    // oxlint-disable-next-line typescript/no-deprecated -- active-scope API; no replacement until Phase 4 GA-GT1-cleanup
    await scopes.setActive('10000334')
    const v1 = svc.corpusVersion()                  // X63 active
    // oxlint-disable-next-line typescript/no-deprecated -- active-scope API; no replacement until Phase 4 GA-GT1-cleanup
    await scopes.setActive('10000251')              // switch BACK to K11
    const v2 = svc.corpusVersion()
    expect(v1).not.toBe(v0)
    expect(v2).not.toBe(v1) // switch-back MUST differ — the WeakMap collision bug
    expect(v2).not.toBe(v0)
  })

  test('a corrupt scopes.yaml makes corpusVersion() throw (fail-loud — never silently fall back to a possibly-wrong scope)', () => {
    const reg = mkdtempSync(join(tmpdir(), 'scope-reg-corrupt-')); tmps.push(reg)
    const registryPath = join(reg, 'scopes.yaml')
    // unterminated YAML flow sequence → yaml.load throws
    writeFileSync(registryPath, 'a: [1, 2\n', 'utf8')
    const ctx = new Context()
    const scopes = new ScopeRegistryService(ctx, { registryPath })
    const svc = new SemanticGroundingCore({ semanticRoot: '/whatever' })
    svc.setScopeRegistry(scopes) // P1: setter-injected, no longer ctx.get('scopes')
    expect(() => svc.corpusVersion()).toThrow()
  })
})

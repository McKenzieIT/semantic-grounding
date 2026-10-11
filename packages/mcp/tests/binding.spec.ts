/**
 * `BindingStore` — ADR-0011 ruling 1's concurrency model (#51): the entry-snapshot
 * resolution every write-tool handler relies on, the atomic pointer swap
 * `switchTo` performs, and the two startup paths (`bindStartup` for `--scope`,
 * `restoreActive` for the registry's default) degrading differently when their
 * target cannot be served.
 *
 * The five scope-management *tools* that wrap this store are tested at the
 * handler level in `scope-tools.spec.ts`; this file is the store's own contract,
 * built directly against a real `ScopeRegistryFile` and real fixture corpora (no
 * fake server, no transport — the thing under test has neither).
 *
 * @see docs/adr/0011-scope-management.md
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertScopeLoadable, BindingStore } from '../src/binding.ts'
import { NoActiveScopeError, ScopeNotFoundError, ScopeUnloadableError } from '../src/errors.ts'
import { ScopeRegistryFile } from '../src/scope-registry.ts'
import { createFixtureCorpus, fixtureGit, type FixtureCorpus } from './helpers/fixture-corpus.ts'

let registryDir: string
let registry: ScopeRegistryFile
let fixtureA: FixtureCorpus
let fixtureB: FixtureCorpus
let stores: BindingStore[]

beforeEach(() => {
  registryDir = mkdtempSync(join(tmpdir(), 'sg-binding-spec-'))
  registry = new ScopeRegistryFile(join(registryDir, 'scopes.yaml'))
  fixtureA = createFixtureCorpus()
  fixtureB = createFixtureCorpus()
  stores = []
})

afterEach(() => {
  for (const store of stores) store.disposeAll()
  fixtureA.cleanup()
  fixtureB.cleanup()
  rmSync(registryDir, { recursive: true, force: true })
})

/** A store wired to the shared registry, tracked for teardown disposal. */
function newStore(agentId = 'bot'): BindingStore {
  const store = new BindingStore({ registry, agentId, lock: { timeoutMs: 2_000, pollIntervalMs: 10 } })
  stores.push(store)
  return store
}

describe('snapshot / requireSnapshot', () => {
  it('snapshot() is undefined and requireSnapshot() refuses before any bind', () => {
    const store = newStore()
    expect(store.snapshot()).toBeUndefined()
    expect(() => store.requireSnapshot()).toThrow(NoActiveScopeError)
  })

  it('requireSnapshot throws NoActiveScopeError whose remedy names switch_scope', () => {
    const store = newStore()
    try {
      store.requireSnapshot()
      expect.unreachable('should have refused')
    } catch (e) {
      expect(e).toBeInstanceOf(NoActiveScopeError)
      expect(String((e as NoActiveScopeError).data['remedy'])).toContain('switch_scope')
    }
  })
})

describe('bindStartup — the --scope path', () => {
  it('binds the snapshot without persisting a registry default', async () => {
    await registry.register({ id: 'a', semanticRoot: fixtureA.root, name: 'a', registeredBy: 'bot' })
    const store = newStore()
    const binding = await store.bindStartup('a')
    expect(binding.scopeId).toBe('a')
    expect(store.snapshot()?.scopeId).toBe('a')
    // explicit --scope is a per-process flag, not a new default for every other process
    expect(registry.activeId()).toBeUndefined()
  })

  it('refuses an unregistered id, remedy pointing at register_scope', async () => {
    const store = newStore()
    try {
      await store.bindStartup('ghost')
      expect.unreachable('should have refused')
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeNotFoundError)
      expect(String((e as ScopeNotFoundError).data['remedy'])).toContain('register_scope')
    }
  })
})

describe('switchTo', () => {
  it('reports switchedFrom: null on the first switch, then the previous id on the next', async () => {
    await registry.register({ id: 'a', semanticRoot: fixtureA.root, name: 'a', registeredBy: 'bot' })
    await registry.register({ id: 'b', semanticRoot: fixtureB.root, name: 'b', registeredBy: 'bot' })
    const store = newStore()
    const first = await store.switchTo('a')
    expect(first.switchedFrom).toBeNull()
    const second = await store.switchTo('b')
    expect(second.switchedFrom).toBe('a')
  })

  it('persists the switched-to id as the registry\'s next-process default', async () => {
    await registry.register({ id: 'a', semanticRoot: fixtureA.root, name: 'a', registeredBy: 'bot' })
    const store = newStore()
    await store.switchTo('a')
    expect(registry.activeId()).toBe('a')
  })

  it('reports definition counts for the scope just landed in', async () => {
    await registry.register({ id: 'a', semanticRoot: fixtureA.root, name: 'a', registeredBy: 'bot' })
    const store = newStore()
    const { counts } = await store.switchTo('a')
    // default fixture: dws_order + dim_shop, no events, no concepts
    expect(counts).toEqual({ tables: 2, events: 0, concepts: 0 })
  })

  it('keeps a previously-resolved snapshot unchanged after a later switch (ruling 1)', async () => {
    await registry.register({ id: 'a', semanticRoot: fixtureA.root, name: 'a', registeredBy: 'bot' })
    await registry.register({ id: 'b', semanticRoot: fixtureB.root, name: 'b', registeredBy: 'bot' })
    const store = newStore()
    await store.switchTo('a')
    const held = store.requireSnapshot() // models an in-flight request's entry-time snapshot
    await store.switchTo('b')
    expect(held.scopeId).toBe('a')
    expect(store.requireSnapshot().scopeId).toBe('b')
  })

  it('reuses the cached core/recorder on a later switch back, rather than reconstructing', async () => {
    await registry.register({ id: 'a', semanticRoot: fixtureA.root, name: 'a', registeredBy: 'bot' })
    await registry.register({ id: 'b', semanticRoot: fixtureB.root, name: 'b', registeredBy: 'bot' })
    const store = newStore()
    const first = await store.switchTo('a')
    await store.switchTo('b')
    const back = await store.switchTo('a')
    expect(back.binding.core).toBe(first.binding.core)
    expect(back.binding.recorder).toBe(first.binding.recorder)
  })

  it('refuses switching to an id the registry has never seen', async () => {
    const store = newStore()
    await expect(store.switchTo('ghost')).rejects.toThrow(ScopeNotFoundError)
  })

  it('refuses switching into a scope whose directory has since gone dirty (posture re-checked on every switch)', async () => {
    await registry.register({ id: 'a', semanticRoot: fixtureA.root, name: 'a', registeredBy: 'bot' })
    const store = newStore()
    await store.switchTo('a') // first bind caches the posture-passing binding
    fixtureGit(['rm', '--quiet', '-r', 'tables'], fixtureA.root) // dirties the worktree, uncommitted
    await expect(store.switchTo('a')).rejects.toThrow(/uncommitted/i)
  })
})

describe('restoreActive — the no-flag startup path', () => {
  it('returns undefined when the registry has no default', async () => {
    const store = newStore()
    expect(await store.restoreActive()).toBeUndefined()
  })

  it('restores the registry default when it is servable', async () => {
    await registry.register({ id: 'a', semanticRoot: fixtureA.root, name: 'a', registeredBy: 'bot' })
    await registry.setActive('a')
    const store = newStore()
    const binding = await store.restoreActive()
    expect(binding?.scopeId).toBe('a')
    expect(store.snapshot()?.scopeId).toBe('a')
  })

  it('degrades to "no active scope" rather than throwing when the default has gone unservable', async () => {
    await registry.register({ id: 'a', semanticRoot: fixtureA.root, name: 'a', registeredBy: 'bot' })
    await registry.setActive('a')
    fixtureA.cleanup() // the registered root is now gone — the default cannot be served
    const logs: string[] = []
    const store = new BindingStore({ registry, agentId: 'bot', logger: m => logs.push(m) })
    stores.push(store)
    const binding = await store.restoreActive()
    expect(binding).toBeUndefined()
    expect(store.snapshot()).toBeUndefined()
    expect(logs.some(m => m.includes('a'))).toBe(true) // loud recovery (ruling 6), not a silent fallback
  })
})

describe('disposeAll', () => {
  it('clears the construction cache but leaves the active pointer alone', async () => {
    await registry.register({ id: 'a', semanticRoot: fixtureA.root, name: 'a', registeredBy: 'bot' })
    const store = newStore()
    await store.switchTo('a')
    store.disposeAll()
    expect(store.snapshot()?.scopeId).toBe('a')
  })
})

describe('assertScopeLoadable', () => {
  it('passes for a loadable corpus', () => {
    expect(() => assertScopeLoadable(fixtureA.root)).not.toThrow()
  })

  it('throws ScopeUnloadableError when the corpus directory will not even list (e.g. "tables" is a plain file, not a dir)', () => {
    const root = mkdtempSync(join(tmpdir(), 'sg-unloadable-'))
    try {
      writeFileSync(join(root, 'tables'), 'not a directory', 'utf8')
      expect(() => assertScopeLoadable(root)).toThrow(ScopeUnloadableError)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

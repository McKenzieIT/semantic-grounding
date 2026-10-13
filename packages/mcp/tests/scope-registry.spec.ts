/**
 * `ScopeRegistryFile` — ADR-0011 ruling 2's persistent artifact (#51), unit-tested
 * directly against a temp-file registry: register's 1:1 idempotency and both
 * conflict halves, deregister's pure-bookkeeping removal and default cascade
 * (#72), `setActive`'s persistence and `ScopeNotFoundError`, two
 * interleaved in-process registrations serializing through the promise-chain
 * mutex rather than losing one, and the malformed-file refusal.
 *
 * The scope-management *tools* (`register_scope` etc.) are tested at the handler
 * level in `scope-tools.spec.ts`; this file is the registry's own contract,
 * independent of any tool door.
 *
 * @see docs/adr/0011-scope-management.md
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScopeIdConflictError, ScopeNotFoundError, ScopePathConflictError } from '../src/errors.ts'
import { assertScopeIdShape, scopeEntryReachable, ScopeRegistryFile, type ScopeEntry } from '../src/scope-registry.ts'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sg-registry-spec-'))
  path = join(dir, 'scopes.yaml')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('register', () => {
  it('writes a new entry and reads it back', async () => {
    const registry = new ScopeRegistryFile(path)
    const { entry, alreadyRegistered } = await registry.register({ id: 'a', semanticRoot: '/corpora/a', name: 'Alpha', registeredBy: 'bot' })
    expect(alreadyRegistered).toBe(false)
    expect(entry).toMatchObject({ id: 'a', semanticRoot: '/corpora/a', name: 'Alpha', registeredBy: 'bot' })
    expect(registry.getEntry('a')).toMatchObject({ semanticRoot: '/corpora/a' })
    expect(registry.get('a')).toEqual({ id: 'a', semanticRoot: '/corpora/a' })
  })

  it('is idempotent for the same id and the same real path — no second write', async () => {
    const registry = new ScopeRegistryFile(path)
    const first = await registry.register({ id: 'a', semanticRoot: '/corpora/a', name: 'Alpha', registeredBy: 'bot' })
    const second = await registry.register({ id: 'a', semanticRoot: '/corpora/a', name: 'Alpha', registeredBy: 'other-bot' })
    expect(second.alreadyRegistered).toBe(true)
    // adoption, not overwrite: the second caller's name/registeredBy are discarded
    expect(second.entry).toEqual(first.entry)
  })

  it('refuses a second id for an already-registered path (the 1:1 path half)', async () => {
    const registry = new ScopeRegistryFile(path)
    await registry.register({ id: 'a', semanticRoot: '/corpora/shared', name: 'Alpha', registeredBy: 'bot' })
    await expect(registry.register({ id: 'b', semanticRoot: '/corpora/shared', name: 'Beta', registeredBy: 'bot' }))
      .rejects.toThrow(ScopePathConflictError)
    expect(registry.getEntry('b')).toBeUndefined()
  })

  it('refuses a second path for an already-registered id (the 1:1 id half)', async () => {
    const registry = new ScopeRegistryFile(path)
    await registry.register({ id: 'a', semanticRoot: '/corpora/a', name: 'Alpha', registeredBy: 'bot' })
    await expect(registry.register({ id: 'a', semanticRoot: '/corpora/a-moved', name: 'Alpha', registeredBy: 'bot' }))
      .rejects.toThrow(ScopeIdConflictError)
    expect(registry.getEntry('a')?.semanticRoot).toBe('/corpora/a')
  })

  it('carries the existing id/path in a conflict error\'s data', async () => {
    const registry = new ScopeRegistryFile(path)
    await registry.register({ id: 'a', semanticRoot: '/corpora/a', name: 'Alpha', registeredBy: 'bot' })
    try {
      await registry.register({ id: 'a', semanticRoot: '/corpora/other', name: 'Alpha', registeredBy: 'bot' })
      expect.unreachable('should have refused')
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeIdConflictError)
      expect((e as ScopeIdConflictError).data['existing']).toEqual({ id: 'a', semantic_root: '/corpora/a' })
    }
  })

  it('persists across a fresh ScopeRegistryFile instance pointed at the same path', async () => {
    const first = new ScopeRegistryFile(path)
    await first.register({ id: 'a', semanticRoot: '/corpora/a', name: 'Alpha', registeredBy: 'bot' })
    const second = new ScopeRegistryFile(path)
    expect(second.getEntry('a')).toMatchObject({ semanticRoot: '/corpora/a' })
  })
})

describe('setActive', () => {
  it('persists the default and activeId() reflects it', async () => {
    const registry = new ScopeRegistryFile(path)
    await registry.register({ id: 'a', semanticRoot: '/corpora/a', name: 'Alpha', registeredBy: 'bot' })
    expect(registry.activeId()).toBeUndefined()
    await registry.setActive('a')
    expect(registry.activeId()).toBe('a')
    expect(registry.active()).toEqual({ id: 'a', semanticRoot: '/corpora/a' })
  })

  it('refuses an id that is not registered', async () => {
    const registry = new ScopeRegistryFile(path)
    await expect(registry.setActive('ghost')).rejects.toThrow(ScopeNotFoundError)
    expect(registry.activeId()).toBeUndefined()
  })

  it('clears the default with null', async () => {
    const registry = new ScopeRegistryFile(path)
    await registry.register({ id: 'a', semanticRoot: '/corpora/a', name: 'Alpha', registeredBy: 'bot' })
    await registry.setActive('a')
    await registry.setActive(null)
    expect(registry.activeId()).toBeUndefined()
    expect(registry.active()).toBeUndefined()
  })
})

describe('deregister (#72)', () => {
  it('removes the entry and the lookup paths stop finding it', async () => {
    const registry = new ScopeRegistryFile(path)
    await registry.register({ id: 'a', semanticRoot: '/corpora/a', name: 'Alpha', registeredBy: 'bot' })
    const { entry, activeCleared } = await registry.deregister('a')
    expect(entry).toMatchObject({ id: 'a', semanticRoot: '/corpora/a' })
    expect(activeCleared).toBe(false)
    expect(registry.getEntry('a')).toBeUndefined()
    expect(registry.get('a')).toBeUndefined()
  })

  it('frees both 1:1 halves — the same path re-registers under a new id, the same id under a new path (the #69 rename exit)', async () => {
    const registry = new ScopeRegistryFile(path)
    await registry.register({ id: 'a', semanticRoot: '/corpora/a', name: 'Alpha', registeredBy: 'bot' })
    await registry.deregister('a')
    await expect(registry.register({ id: 'b', semanticRoot: '/corpora/a', name: 'Alpha', registeredBy: 'bot' })).resolves.toMatchObject({ alreadyRegistered: false })
    await registry.deregister('b')
    await expect(registry.register({ id: 'a', semanticRoot: '/corpora/a-elsewhere', name: 'Alpha', registeredBy: 'bot' })).resolves.toMatchObject({ alreadyRegistered: false })
  })

  it('clears the next-process default when it names the removed entry — no deliberately dangling default', async () => {
    const registry = new ScopeRegistryFile(path)
    await registry.register({ id: 'a', semanticRoot: '/corpora/a', name: 'Alpha', registeredBy: 'bot' })
    await registry.setActive('a')
    const { activeCleared } = await registry.deregister('a')
    expect(activeCleared).toBe(true)
    expect(registry.activeId()).toBeUndefined()
    expect(registry.active()).toBeUndefined()
  })

  it('leaves a default naming another scope alone', async () => {
    const registry = new ScopeRegistryFile(path)
    await registry.register({ id: 'a', semanticRoot: '/corpora/a', name: 'Alpha', registeredBy: 'bot' })
    await registry.register({ id: 'b', semanticRoot: '/corpora/b', name: 'Beta', registeredBy: 'bot' })
    await registry.setActive('b')
    const { activeCleared } = await registry.deregister('a')
    expect(activeCleared).toBe(false)
    expect(registry.activeId()).toBe('b')
  })

  it('refuses an id that was never registered — the −31061 condition, not a silent ok', async () => {
    const registry = new ScopeRegistryFile(path)
    await expect(registry.deregister('ghost')).rejects.toThrow(ScopeNotFoundError)
    expect(registry.read().scopes.size).toBe(0)
  })

  it('persists across a fresh ScopeRegistryFile instance pointed at the same path', async () => {
    const first = new ScopeRegistryFile(path)
    await first.register({ id: 'a', semanticRoot: '/corpora/a', name: 'Alpha', registeredBy: 'bot' })
    await first.register({ id: 'b', semanticRoot: '/corpora/b', name: 'Beta', registeredBy: 'bot' })
    await first.deregister('a')
    const second = new ScopeRegistryFile(path)
    expect(second.getEntry('a')).toBeUndefined()
    expect(second.getEntry('b')).toMatchObject({ semanticRoot: '/corpora/b' })
  })

  it('serializes an interleaved register/deregister through the promise-chain mutex rather than resurrecting an entry', async () => {
    const registry = new ScopeRegistryFile(path)
    await Promise.all([
      registry.register({ id: 'a', semanticRoot: '/corpora/a', name: 'Alpha', registeredBy: 'bot' }),
      registry.deregister('a'),
    ])
    expect(registry.read().scopes.size).toBe(0)
  })
})

describe('concurrency — the in-process promise-chain mutex', () => {
  it('serializes two interleaved registrations rather than losing one to a read-modify-write race', async () => {
    const registry = new ScopeRegistryFile(path)
    await Promise.all([
      registry.register({ id: 'a', semanticRoot: '/corpora/a', name: 'Alpha', registeredBy: 'bot' }),
      registry.register({ id: 'b', semanticRoot: '/corpora/b', name: 'Beta', registeredBy: 'bot' }),
    ])
    const state = registry.read()
    expect(state.scopes.size).toBe(2)
    expect(state.scopes.get('a')?.semanticRoot).toBe('/corpora/a')
    expect(state.scopes.get('b')?.semanticRoot).toBe('/corpora/b')
  })
})

describe('malformed registry file — refuses rather than silently rebuilding (intranet-security)', () => {
  it('refuses a file whose top level is not a mapping', () => {
    writeFileSync(path, '- just\n- a\n- list\n', 'utf8')
    const registry = new ScopeRegistryFile(path)
    expect(() => registry.read()).toThrow(/not a mapping/)
  })

  it('refuses a scope entry missing required fields', () => {
    writeFileSync(path, 'scopes:\n  bad:\n    registeredAt: "2026-01-01"\n', 'utf8')
    const registry = new ScopeRegistryFile(path)
    expect(() => registry.read()).toThrow(/malformed/)
  })

  it('treats a missing file as an empty registry rather than throwing', () => {
    const registry = new ScopeRegistryFile(join(dir, 'does-not-exist.yaml'))
    expect(registry.read()).toEqual({ active: null, scopes: new Map() })
  })
})

describe('assertScopeIdShape', () => {
  it.each(['a', 'a1', 'a-b-c', 'x'.repeat(64)])('accepts %s', (id) => {
    expect(() => assertScopeIdShape(id, m => new Error(m))).not.toThrow()
  })

  it.each(['', 'A', 'has space', '-leading-dash', 'under_score', 'x'.repeat(65)])('refuses %s', (id) => {
    expect(() => assertScopeIdShape(id, m => new Error(m))).toThrow(/not shaped/)
  })
})

describe('scopeEntryReachable', () => {
  it('is true for a directory that exists and false for one that has vanished', () => {
    const existing: ScopeEntry = { id: 'a', semanticRoot: dir, name: 'Alpha', registeredAt: '', registeredBy: 'bot' }
    expect(scopeEntryReachable(existing)).toBe(true)
    const gone: ScopeEntry = { ...existing, semanticRoot: join(dir, 'never-existed') }
    expect(scopeEntryReachable(gone)).toBe(false)
  })
})

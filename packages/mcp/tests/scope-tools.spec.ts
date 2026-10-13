/**
 * ADR-0011's five scope-management tools plus #72's `deregister_scope`
 * (`src/tools/scope.ts`) — the edge
 * and error paths the e2e gate's golden-path walk (`scripts/check-e2e-loop.ts`'s
 * "scope tools" step) does not exercise: the 1:1 conflict halves, idempotent
 * re-registration, the id-shape and posture/unloadable refusals, `reachable:false`
 * for a vanished directory, and `get_scope`/`switch_scope` naming an id the
 * registry has never seen. `deregister_scope`'s own door rules (#72): pure
 * bookkeeping for dead entries, the two cascade clears, and −31061 for unknown
 * ids.
 *
 * Handlers are invoked directly against a minimal fake `McpServer` that only
 * implements `registerTool` — the same harness shape `enrichment-tools.spec.ts`
 * uses, for the same reason: the registrar's wire-level seam (real zod
 * validation, real `tools/call` dispatch) is `server-startup.spec.ts`'s job; this
 * file is about what each handler actually does.
 *
 * @see docs/adr/0011-scope-management.md
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { BindingStore } from '../src/binding.ts'
import type { ServerConfig } from '../src/config.ts'
import { ScopeRegistryFile } from '../src/scope-registry.ts'
import type { ServerDeps } from '../src/server.ts'
import { registerScopeTools } from '../src/tools/scope.ts'
import { createFixtureCorpus, fixtureGit, type FixtureCorpus } from './helpers/fixture-corpus.ts'

type Handler = (args: unknown, extra?: unknown) => Promise<CallToolResult> | CallToolResult

/** Register the five scope tools against a fake server, capturing each handler by name. */
function captureScopeTools(deps: ServerDeps): Map<string, Handler> {
  const tools = new Map<string, Handler>()
  const fakeServer = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      tools.set(name, handler)
    },
  }
  registerScopeTools(fakeServer as unknown as Parameters<typeof registerScopeTools>[0], deps)
  return tools
}

/** Call a captured handler, asserting it did NOT produce a coded error result. */
async function callOk(tools: Map<string, Handler>, name: string, args: unknown): Promise<Record<string, unknown>> {
  const handler = tools.get(name)
  if (handler === undefined) throw new Error(`tool not registered: ${name}`)
  const result = await handler(args, {}) as CallToolResult
  const text = (result.content[0] as { text: string }).text
  if (result.isError === true) throw new Error(`expected success, got error result: ${text}`)
  return JSON.parse(text) as Record<string, unknown>
}

/** Call a captured handler, asserting it DID produce a coded error result, and return its body. */
async function callErr(tools: Map<string, Handler>, name: string, args: unknown): Promise<{ code: number; name: string; message: string; data: Record<string, unknown> }> {
  const handler = tools.get(name)
  if (handler === undefined) throw new Error(`tool not registered: ${name}`)
  const result = await handler(args, {}) as CallToolResult
  const text = (result.content[0] as { text: string }).text
  if (result.isError !== true) throw new Error(`expected an error result, got success: ${text}`)
  return JSON.parse(text) as { code: number; name: string; message: string; data: Record<string, unknown> }
}

let registryDir: string
let fixtureA: FixtureCorpus
let fixtureB: FixtureCorpus
let tools: Map<string, Handler>
let bindings: BindingStore

beforeEach(() => {
  registryDir = mkdtempSync(join(tmpdir(), 'sg-scope-tools-'))
  const registryPath = join(registryDir, 'scopes.yaml')
  const registry = new ScopeRegistryFile(registryPath)
  bindings = new BindingStore({ agentId: 'bot', registry, lock: { timeoutMs: 2_000, pollIntervalMs: 10 } })
  const config: ServerConfig = { registryPath, agentId: 'bot' }
  tools = captureScopeTools({ registry, bindings, config })
  fixtureA = createFixtureCorpus()
  fixtureB = createFixtureCorpus()
})

afterEach(() => {
  bindings.disposeAll()
  fixtureA.cleanup()
  fixtureB.cleanup()
  rmSync(registryDir, { recursive: true, force: true })
})

describe('get_scope_scaffold', () => {
  it('is pure knowledge — calling it registers nothing', async () => {
    const out = await callOk(tools, 'get_scope_scaffold', { scope_id: 'probe', path: fixtureA.root })
    expect(out['scope_id']).toBe('probe')
    expect((await callOk(tools, 'list_scopes', {}))['total']).toBe(0)
  })

  it('reports five ordered bootstrap steps ending in register_scope', async () => {
    const out = await callOk(tools, 'get_scope_scaffold', { scope_id: 'probe', path: fixtureA.root })
    const steps = out['steps'] as Array<Record<string, unknown>>
    expect(steps).toHaveLength(5)
    expect(steps[4]).toMatchObject({ tool: 'register_scope', args: { id: 'probe', path: fixtureA.root } })
  })

  it('strips trailing slashes off the path before templating it into the steps', async () => {
    const out = await callOk(tools, 'get_scope_scaffold', { scope_id: 'probe', path: `${fixtureA.root}///` })
    const serialized = JSON.stringify(out['steps'])
    expect(serialized).not.toContain('///')
    // JSON.stringify escapes the path's backslashes on Windows, so the raw root string
    // never appears in the serialized text there — assert its escaped form (#81).
    expect(serialized).toContain(JSON.stringify(fixtureA.root).slice(1, -1))
  })

  it('next_steps names the dry-run rehearsal before a bulk import lands (ADR-0018 discoverability)', async () => {
    // The remote agent's one bootstrap line is where the preview must surface:
    // nothing else in the surface tells it a batch can be rehearsed read-only
    // before it becomes source-of-truth.
    const out = await callOk(tools, 'get_scope_scaffold', { scope_id: 'probe', path: fixtureA.root })
    expect(String(out['next_steps'])).toContain('import_definitions')
    expect(String(out['next_steps'])).toContain('dry_run:true')
  })
})

describe('register_scope', () => {
  it('is idempotent for the same id and the same real path', async () => {
    const first = await callOk(tools, 'register_scope', { id: 'a', path: fixtureA.root })
    expect(first['already_registered']).toBe(false)
    const second = await callOk(tools, 'register_scope', { id: 'a', path: fixtureA.root })
    expect(second['already_registered']).toBe(true)
  })

  it('never switches — the active scope stays unbound after registering (ruling 3)', async () => {
    const out = await callOk(tools, 'register_scope', { id: 'a', path: fixtureA.root })
    expect(out['active_unchanged']).toBe(true)
    expect(bindings.snapshot()).toBeUndefined()
    expect((await callOk(tools, 'list_scopes', {}))['active']).toBeNull()
  })

  it('refuses a second id for an already-registered path (the 1:1 path half)', async () => {
    await callOk(tools, 'register_scope', { id: 'a', path: fixtureA.root })
    const err = await callErr(tools, 'register_scope', { id: 'b', path: fixtureA.root })
    expect(err.code).toBe(-31063)
    expect(err.name).toBe('ScopePathConflictError')
  })

  it('refuses a second path for an already-registered id (the 1:1 id half)', async () => {
    await callOk(tools, 'register_scope', { id: 'a', path: fixtureA.root })
    const err = await callErr(tools, 'register_scope', { id: 'a', path: fixtureB.root })
    expect(err.code).toBe(-31062)
    expect(err.name).toBe('ScopeIdConflictError')
  })

  it('refuses an id outside the charset before touching posture or the table', async () => {
    const err = await callErr(tools, 'register_scope', { id: 'Not_Valid!', path: fixtureA.root })
    expect(err.message).toContain('not shaped')
    expect((await callOk(tools, 'list_scopes', {}))['total']).toBe(0)
  })

  it('refuses a corpus that is not its own clean git repository (posture, #19\'s own code)', async () => {
    const notAGitRepo = createFixtureCorpus({ git: false })
    try {
      const err = await callErr(tools, 'register_scope', { id: 'dirty', path: notAGitRepo.root })
      expect(err.code).toBe(-31004)
      expect(err.name).toBe('PostureRefusedError')
    } finally {
      notAGitRepo.cleanup()
    }
  })

  it('refuses a corpus that passes posture but will not load', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sg-unloadable-'))
    try {
      // own clean git repo, but "tables" is a plain file — loadTables' readdirSync
      // throws ENOTDIR, which assertScopeLoadable turns into scope_unloadable.
      const { writeFileSync } = await import('node:fs')
      writeFileSync(join(root, 'tables'), 'not a directory', 'utf8')
      fixtureGit(['init', '--quiet', '--initial-branch=main', '.'], root)
      fixtureGit(['config', 'user.name', 'x'], root)
      fixtureGit(['config', 'user.email', 'x@x'], root)
      fixtureGit(['config', 'commit.gpgsign', 'false'], root)
      fixtureGit(['add', '-A'], root)
      fixtureGit(['commit', '--quiet', '-m', 'x'], root)
      const err = await callErr(tools, 'register_scope', { id: 'bad', path: root })
      expect(err.code).toBe(-31065)
      expect(err.name).toBe('ScopeUnloadableError')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('deregister_scope (#72)', () => {
  it('removes the entry and echoes it — pure bookkeeping, nothing switched anywhere', async () => {
    await callOk(tools, 'register_scope', { id: 'a', path: fixtureA.root })
    const out = await callOk(tools, 'deregister_scope', { scope_id: 'a' })
    expect(out['removed']).toMatchObject({ id: 'a', semantic_root: realpathSync(fixtureA.root) })
    expect(out['active_cleared']).toBe(false)
    expect(out['binding_cleared']).toBe(false)
    expect((await callOk(tools, 'list_scopes', {}))['total']).toBe(0)
  })

  it('is pure bookkeeping — a dead entry whose directory is gone is removable (no posture door)', async () => {
    await callOk(tools, 'register_scope', { id: 'dead', path: fixtureA.root })
    fixtureA.cleanup()
    const out = await callOk(tools, 'deregister_scope', { scope_id: 'dead' })
    expect((out['removed'] as Record<string, unknown>)['id']).toBe('dead')
  })

  it('clears the next-process default and this process\'s live binding when it was serving the scope', async () => {
    await callOk(tools, 'register_scope', { id: 'a', path: fixtureA.root })
    await callOk(tools, 'switch_scope', { scope_id: 'a' })
    const out = await callOk(tools, 'deregister_scope', { scope_id: 'a' })
    expect(out['active_cleared']).toBe(true)
    expect(out['binding_cleared']).toBe(true)
    expect(bindings.snapshot()).toBeUndefined()
    const listed = await callOk(tools, 'list_scopes', {})
    expect(listed['total']).toBe(0)
    expect(listed['active']).toBeNull()
  })

  it('refuses an id the registry has never seen — −31061, not a silent ok', async () => {
    const err = await callErr(tools, 'deregister_scope', { scope_id: 'ghost' })
    expect(err.code).toBe(-31061)
    expect(err.name).toBe('ScopeNotFoundError')
    expect(err.data['scope_id']).toBe('ghost')
  })

  it('frees both 1:1 halves — the #69 mis-named-id exit is deregister + re-register', async () => {
    await callOk(tools, 'register_scope', { id: 'wrong-name', path: fixtureA.root })
    await callOk(tools, 'deregister_scope', { scope_id: 'wrong-name' })
    const out = await callOk(tools, 'register_scope', { id: 'right-name', path: fixtureA.root })
    expect(out['already_registered']).toBe(false)
    expect((out['scope'] as Record<string, unknown>)['id']).toBe('right-name')
  })
})

describe('list_scopes', () => {
  it('starts empty', async () => {
    const out = await callOk(tools, 'list_scopes', {})
    expect(out).toMatchObject({ scopes: [], active: null, total: 0 })
  })

  it('reports reachable:false for a scope whose directory has vanished — a visible dead entry, not an error', async () => {
    await callOk(tools, 'register_scope', { id: 'a', path: fixtureA.root })
    fixtureA.cleanup()
    const out = await callOk(tools, 'list_scopes', {})
    const scopes = out['scopes'] as Array<{ id: string; reachable: boolean }>
    expect(scopes.find(s => s.id === 'a')?.reachable).toBe(false)
  })

  it('marks the actually-bound scope active, not just the registry default', async () => {
    await callOk(tools, 'register_scope', { id: 'a', path: fixtureA.root })
    await callOk(tools, 'switch_scope', { scope_id: 'a' })
    const out = await callOk(tools, 'list_scopes', {})
    // register_scope resolves the real path (macOS: /var/... is a symlink to
    // /private/var/...), so the stored root is realpathSync(fixtureA.root), not the
    // mkdtemp string itself.
    expect(out['active']).toMatchObject({ id: 'a', root: realpathSync(fixtureA.root) })
    const scopes = out['scopes'] as Array<{ id: string; is_active: boolean }>
    expect(scopes.find(s => s.id === 'a')?.is_active).toBe(true)
  })
})

describe('switch_scope', () => {
  it('refuses an id the registry has never seen, remedy pointing at register_scope', async () => {
    const err = await callErr(tools, 'switch_scope', { scope_id: 'ghost' })
    expect(err.code).toBe(-31061)
    expect(err.name).toBe('ScopeNotFoundError')
    expect(String(err.data['remedy'])).toContain('register_scope')
  })
})

describe('get_scope', () => {
  it('refuses when no scope_id is given and nothing is active', async () => {
    const err = await callErr(tools, 'get_scope', {})
    expect(err.code).toBe(-31061)
    expect(err.message).toContain('no active scope')
  })

  it('refuses a scope_id the registry has never seen', async () => {
    const err = await callErr(tools, 'get_scope', { scope_id: 'ghost' })
    expect(err.code).toBe(-31061)
  })

  it('describes a non-active registered scope without a serving stamp', async () => {
    await callOk(tools, 'register_scope', { id: 'a', path: fixtureA.root })
    const out = await callOk(tools, 'get_scope', { scope_id: 'a' })
    expect(out['is_active']).toBe(false)
    expect(out['serving']).toBeUndefined()
    // No corpus load for a scope you are not serving — the counts promise is the
    // active branch's alone (#102 6a).
    expect(out['counts']).toBeUndefined()
  })

  it('defaults to the active scope and adds the serving stamp when scope_id is omitted', async () => {
    await callOk(tools, 'register_scope', { id: 'a', path: fixtureA.root })
    await callOk(tools, 'switch_scope', { scope_id: 'a' })
    const out = await callOk(tools, 'get_scope', {})
    expect((out['scope'] as Record<string, unknown>)['id']).toBe('a')
    expect(out['is_active']).toBe(true)
    expect(out['serving']).toMatchObject({ id: 'a', root: realpathSync(fixtureA.root) })
    // The description's counts promise (#102 6a): the serving snapshot's counts via
    // layerCounts — fixtureA holds two tables (dws_order + dim_shop), no events,
    // no concepts, so dw=2 (tables+events) and kg=0.
    expect(out['counts']).toEqual({ dw: 2, kg: 0 })
  })
})

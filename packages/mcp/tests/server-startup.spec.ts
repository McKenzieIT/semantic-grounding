/**
 * The executable's process-level contract ([#22](https://github.com/McKenzieIT/semantic-grounding/issues/22);
 * re-ruled for the registry/scope model by ADR-0011, [#51](https://github.com/McKenzieIT/semantic-grounding/issues/51)).
 *
 * These spawn the real entry point rather than calling `runMain` in-process, because every
 * claim #22's acceptance makes is about a *process*: which exit code, how many bytes on
 * stdout, what the client reads back off the pipe. `config.spec.ts` covers the parsing
 * decisions in-process; this file covers how they are reported.
 *
 * **Why stdout byte counts are asserted everywhere.** stdout is the JSON-RPC channel. A
 * diagnostic written there is not a cosmetic problem — the client parses it as a protocol
 * message and reports a parse error, which is how a clear refusal ("your corpus is not a
 * git repository, run `git init`") becomes an opaque client-side failure. Asserting zero
 * bytes on every refusal path is the only way that stays true as the code grows.
 *
 * The posture matrix itself (ADR-0004 rulings 5 and 6, all four branches) is covered at
 * the unit level in `startup-posture.spec.ts` and is deliberately not re-tested here. What
 * is tested here is that the entry *surfaces* a refusal and a recovery correctly — now at
 * the three binding moments ADR-0011 moved posture to (`--scope`'s eager bind here;
 * `register_scope`/`switch_scope` are `tools/scope.ts`'s own coverage). Every test
 * below registers its scope **directly through `ScopeRegistryFile`**, not through the
 * `register_scope` tool — the registry's own `register()` runs no posture or load check
 * (that is deliberately the *tool's* job, per the registry module's own header), which is
 * exactly what lets a deployment-refusal test plant a bad corpus and prove *startup's*
 * posture re-check catches it, independent of whichever door the entry came through.
 *
 * @module tests/server-startup.spec
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/main.ts'
import { LOCK_FILENAME, type LockRecord } from '../src/git/lock.ts'
import { ScopeRegistryFile } from '../src/scope-registry.ts'
import { TOOL_NAMES } from '../src/tools/index.ts'
import { createFixtureCorpus, fixtureGit, type FixtureCorpus } from './helpers/fixture-corpus.ts'
import { freshFixtureRegistry } from './helpers/intent-tools-harness.ts'

const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const REGISTRAR_BIN = fileURLToPath(new URL('./helpers/registrar-server.ts', import.meta.url))

/** Every default-registrar tool name, in no particular order — the single-source
 * `TOOL_NAMES` composition (#68 folded this file's former hand-glued family list
 * into it, the same anti-drift rule `tools/index.ts` states). */
const ALL_DEFAULT_TOOL_NAMES = [...TOOL_NAMES]

/**
 * The environment to spawn with: the real one, minus this server's own variables.
 *
 * Scrubbed deliberately. An `SG_REGISTRY`/`SG_AGENT_ID` set in the developer's shell
 * would silently satisfy a test for the wrong reason, or point a spawned process at a
 * real `~/.semantic-grounding/scopes.yaml`.
 * @returns the scrubbed environment.
 */
function baseEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('SG_')) out[k] = v
  }
  return out
}

/** What one spawn produced. */
interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Spawn the entry point and wait for it to finish.
 * @param args - argv after the script.
 * @param opts - `input` piped to stdin (absent means stdin closes immediately, which the
 *   transport treats as the client hanging up), `env` additions, and `bin` to run the
 *   registrar fixture instead.
 * @returns the exit code and captured streams.
 */
function run(
  args: readonly string[],
  opts: { readonly input?: string; readonly env?: Record<string, string>; readonly bin?: string } = {},
): Run {
  const res = spawnSync(process.execPath, [opts.bin ?? BIN, ...args], {
    input: opts.input ?? '',
    encoding: 'utf8',
    env: { ...baseEnv(), ...opts.env ?? {} },
    timeout: 25_000,
  })
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** A `tools/list` request in the 2026-07-28 envelope. */
function modernToolsList(id = 1): string {
  return `${JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/list',
    params: {
      _meta: {
        // Both keys are required by the revision's envelope; omitting either is -32602.
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  })}\n`
}

/**
 * Parse the JSON-RPC responses off a captured stdout.
 * @param stdout - the captured stream.
 * @returns one object per non-blank line.
 */
function responses(stdout: string): Array<Record<string, unknown>> {
  return stdout.split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as Record<string, unknown>)
}

/** Registry temp dirs created by {@link freshRegistryPath}, torn down in `afterEach`. */
let liveRegistryDirs: string[] = []

/**
 * A throwaway registry file path, isolated from the real `~/.semantic-grounding`.
 * The file need not exist yet — `ScopeRegistryFile`/`main.ts` both treat ENOENT as
 * an empty registry. The temp-dir half of the shared fixture-deps recipe
 * (#122): this spawn-based file needs no `BindingStore`/`ServerConfig`, so it
 * takes only `freshFixtureRegistry()`'s paths.
 * @returns the registry path to pass as `--registry`.
 */
function freshRegistryPath(): string {
  const { registryDir, registryPath } = freshFixtureRegistry()
  liveRegistryDirs.push(registryDir)
  return registryPath
}

/**
 * Register one scope directly through the registry's own `register()` — deliberately
 * bypassing `register_scope`'s posture/load door, so a test can plant a scope entry
 * pointing at a corpus that would never pass that door, and prove startup's *own*
 * posture re-check (`BindingStore.bindStartup`) catches it independently.
 * @param registryPath - the registry file.
 * @param id - the scope id.
 * @param semanticRoot - the corpus root to register (not required to be valid yet).
 */
async function registerDirect(registryPath: string, id: string, semanticRoot: string): Promise<void> {
  const registry = new ScopeRegistryFile(registryPath)
  await registry.register({ id, semanticRoot, name: id, registeredBy: 'setup' })
}

let fixture: FixtureCorpus

beforeEach(() => {
  fixture = createFixtureCorpus()
})

afterEach(() => {
  fixture.cleanup()
  for (const dir of liveRegistryDirs) rmSync(dir, { recursive: true, force: true })
  liveRegistryDirs = []
})

// ── Usage errors: EX_USAGE (64) ──────────────────────────────────────────

describe('usage refusals exit 64 and say nothing on stdout', () => {
  it.each([
    ['no arguments at all — no agent id', [] as readonly string[]],
    ['the removed --corpus flag', ['--corpus', '/srv/c', '--agent-id', 'a']],
    ['an unknown flag', ['--agent-id', 'a', '--bogus']],
    ['a malformed lock timeout', ['--agent-id', 'a', '--lock-timeout-ms', '10s']],
  ])('%s', (_label, args) => {
    const r = run([...args, '--registry', freshRegistryPath()])
    expect(r.code).toBe(EXIT.usage)
    expect(r.stdout).toBe('')
    // The usage text comes with the failure, so a mis-registered server teaches its own
    // surface at the moment the operator sees it fail.
    expect(r.stderr).toContain('--agent-id')
  })

  it('prints help to stderr and exits 0', () => {
    const r = run(['--help'])
    expect(r.code).toBe(EXIT.ok)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('usage: sg-mcp')
    expect(r.stderr).toContain('register_scope')
  })
})

// ── Deployment refusals: EX_CONFIG (78) ──────────────────────────────────

describe('deployment refusals exit 78 and say nothing on stdout', () => {
  it('refuses a corpus that is not a git repository, naming the remedy', async () => {
    const plain = createFixtureCorpus({ git: false })
    try {
      const registryPath = freshRegistryPath()
      await registerDirect(registryPath, 'plain', plain.root)
      const r = run(['--scope', 'plain', '--agent-id', 'a', '--registry', registryPath])
      expect(r.code).toBe(EXIT.config)
      expect(r.stdout).toBe('')
      expect(r.stderr).toContain('git init')
    } finally {
      plain.cleanup()
    }
  })

  it('refuses a dirty worktree with no lock, and leaves the edit alone', async () => {
    const registryPath = freshRegistryPath()
    await registerDirect(registryPath, 'fixture', fixture.root) // registered while clean

    const p = join(fixture.root, 'tables', 'dws_order.yaml')
    const before = readFileSync(p, 'utf8')
    writeFileSync(p, `${before}\n# a human's uncommitted edit\n`, 'utf8')

    const r = run(['--scope', 'fixture', '--agent-id', 'a', '--registry', registryPath])
    expect(r.code).toBe(EXIT.config)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('git stash')
    // Ruling 6's reason, asserted rather than assumed: the refusal must not be a cleanup.
    expect(readFileSync(p, 'utf8')).toContain("a human's uncommitted edit")
  })

  it('refuses an agent id git cannot use as an identity, before any registry lookup', () => {
    const r = run(['--agent-id', 'bad<name>', '--registry', freshRegistryPath()])
    expect(r.code).toBe(EXIT.config)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('stripped by git')
  })

  it('refuses before the transport exists — a refusal is never a JSON-RPC error', () => {
    // The measured alternative: refusing from inside the serveStdio factory yields a
    // canned `-32603 Internal server error`, exit 0, the remedy lost to the onerror sink,
    // and the factory retried on every request. All four are visible right here.
    const r = run(['--agent-id', 'bad<name>', '--registry', freshRegistryPath()], { input: modernToolsList() })
    expect(r.code).toBe(EXIT.config)
    expect(r.stdout).toBe('')
    expect(r.stderr).not.toContain('-32603')
  })

  it('refuses an unregistered --scope id, naming it in the refusal', () => {
    const r = run(['--scope', 'never-registered', '--agent-id', 'a', '--registry', freshRegistryPath()])
    expect(r.code).toBe(EXIT.config)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('never-registered')
    expect(r.stderr).toContain('not in the registry')
  })
})

// ── Serving ──────────────────────────────────────────────────────────────

// SCOPE_TOOL_NAMES is ADR-0011's addition (#51): the five scope-management tools, on
// top of the pre-existing nineteen (ADR-0005's fifteen + ADR-0006's three + ADR-0008's
// one) — #72 added the family's sixth, `deregister_scope` — PLAYBOOK_TOOL_NAMES is
// #63's initialization dashboard,
// IMPORT_TOOL_NAMES is ADR-0013's bulk import (#68), #105's `list_definitions` made
// ADR-0005's reads six (#112), SCRATCH_TOOL_NAMES is
// ADR-0020's scratch home (#101), MEMORY_TOOL_NAMES is ADR-0023's memory write
// (#152), and QUERY_TOOL_NAMES is ADR-0025's verified-query pair (#155) —
// thirty-two default-registrar tools in total. None of the tools/list-only
// tests below need an active scope bound: every tool registers unconditionally, and
// only a definition-tool *call* without one would answer no_active_scope.

describe('serving', () => {
  it('answers a 2026-07-28 tools/list with all thirty-two default-registrar tools, in the revision\'s result shape', () => {
    const r = run(['--agent-id', 'analyst-bot', '--registry', freshRegistryPath()], { input: modernToolsList() })
    expect(r.code).toBe(EXIT.ok)

    const [res] = responses(r.stdout)
    expect(res).toBeDefined()
    const result = res?.['result'] as Record<string, unknown> | undefined
    // Zero tools was #22's own scope ("stdio transport 启动但零工具可用") — #20 landed
    // ADR-0005's fifteen, #21 landed ADR-0006's three, #31 added ADR-0008's fourth
    // (get_enrichment_prompts), #51 added ADR-0011's five scope tools. The exact
    // names/schemas are pinned in `tests/intent-tools*.spec.ts`, `tests/enrichment-tools.spec.ts`
    // and `tests/scope-tools.spec.ts`; this file's job is the protocol envelope, not the
    // catalog. The point of asserting the list exists at all rather than the method 404ing:
    // without an explicit `capabilities: { tools: {} }` the SDK answers -32601, which a client
    // cannot tell apart from a broken server.
    const tools = result?.['tools'] as Array<{ name: string }> | undefined
    expect(tools?.map(t => t.name).sort()).toEqual([...ALL_DEFAULT_TOOL_NAMES].sort())
    // Revision markers the 2025-era shape does not carry. Their presence is what proves
    // `serveStdio` is wired rather than a hand-connected transport, which answers the
    // same bytes in the wrong era.
    expect(result?.['resultType']).toBe('complete')
    expect(result?.['_meta']).toMatchObject({
      'io.modelcontextprotocol/serverInfo': { name: '@semantic-grounding/mcp' },
    })
  })

  it('answers the hosts\' connect-time probes (prompts/resources) with empty lists, never -32601', () => {
    // Measurement 5 (`src/server.ts`): hosts probe prompts/resources during capability
    // discovery, and the SDK's eager capability wiring is tools-only — without explicit
    // empty handlers both eras answered -32601, which QoderWork surfaced as a fatal
    // "MCP error -32601: Method not found" during the #23 dogfood. "Empty" and "broken"
    // must stay distinguishable. `ping` is deliberately not asserted here: modern-era
    // ping answers -32601 on SDK v2.3.1 (era-router miss, unre-registerable from our
    // side); legacy answers it — recorded, not fixed.
    const probe = (id: number, method: string, modern: boolean): string =>
      `${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: modern
          ? {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          }
          : {},
      })}\n`

    for (const modern of [true, false]) {
      const opening = modern
        ? ''
        : `${JSON.stringify({
          jsonrpc: '2.0',
          id: 90,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'probe-host', version: '1.0' } },
        })}\n`
      const r = run(['--agent-id', 'probe-agent', '--registry', freshRegistryPath()], {
        input: opening + probe(1, 'prompts/list', modern) + probe(2, 'resources/list', modern) + probe(3, 'resources/templates/list', modern),
      })
      expect(r.code).toBe(EXIT.ok)
      const byId = new Map(responses(r.stdout).filter(m => m['id'] !== undefined).map(m => [m['id'] as number, m]))
      const expectEmpty = (id: number, field: string): void => {
        const msg = byId.get(id)
        expect(msg?.['error']).toBeUndefined()
        expect((msg?.['result'] as Record<string, unknown>)?.[field]).toEqual([])
      }
      expectEmpty(1, 'prompts')
      expectEmpty(2, 'resources')
      expectEmpty(3, 'resourceTemplates')
    }
  })

  it('also serves a 2025-era client (legacy: \'serve\')', () => {
    // The deciding input: the dogfood host is QoderWork and peer office agents, whose era
    // we cannot check from here, and SDK v2.3.1 still calls 2025-11-25 its latest.
    const init = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'office-agent', version: '1.0' } },
    })}\n`
    const list = `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`

    const r = run(['--agent-id', 'analyst-bot', '--registry', freshRegistryPath()], { input: init + list })
    expect(r.code).toBe(EXIT.ok)

    const out = responses(r.stdout)
    expect(out).toHaveLength(2)
    expect((out[0]?.['result'] as Record<string, unknown>)?.['protocolVersion']).toBe('2025-11-25')
    // Same default-registrar tool set as the modern-era test above (all thirty-two).
    const legacyTools = (out[1]?.['result'] as Record<string, unknown>)?.['tools'] as Array<{ name: string }> | undefined
    expect(legacyTools?.map(t => t.name).sort()).toEqual([...ALL_DEFAULT_TOOL_NAMES].sort())
    // No `-32601`: the regression this guards is reusing one McpServer across the
    // factory's two measured calls, which answers a legacy `initialize` "Method not found"
    // because the modern binding permanently mutates the instance.
    expect(r.stdout).not.toContain('-32601')
  })

  it('answers every request on one pinned connection', () => {
    const input = modernToolsList(1) + modernToolsList(2) + modernToolsList(3)
    const r = run(['--agent-id', 'analyst-bot', '--registry', freshRegistryPath()], { input })
    expect(r.code).toBe(EXIT.ok)
    expect(responses(r.stdout)).toHaveLength(3)
  })

  it('builds the bound scope\'s corpus once even when the serving factory runs twice', async () => {
    // The banner prints once per startup, so its count is the number of times the
    // expensive half (corpus load, recorder, posture check) was constructed.
    //
    // Three sequential requests would NOT prove anything here — measured: the factory is
    // per-*connection*, so one connection enters it once however many requests arrive, and
    // the assertion would hold even with construction moved inside. The input below is the
    // path that does distinguish them: a modern `server/discover` optimistically builds a
    // probe instance, and a client that then falls back to legacy `initialize` causes the
    // probe to be discarded and a second instance built. Measured on this exact input, the
    // factory is entered **twice** — so an in-factory build would print two banners, load
    // the corpus twice, and construct two recorders over one corpus. A `--scope` is bound
    // here specifically so that risk is actually exercised (an unbound process has nothing
    // to double-construct).
    const registryPath = freshRegistryPath()
    await registerDirect(registryPath, 'fixture', fixture.root)

    const discover = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    })}\n`
    const init = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'office-agent', version: '1' } },
    })}\n`
    const list = `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })}\n`

    const r = run(['--scope', 'fixture', '--agent-id', 'analyst-bot', '--registry', registryPath], { input: discover + init + list })
    expect(r.code).toBe(EXIT.ok)
    expect(r.stderr.split('serving MCP over stdio').length - 1).toBe(1)
    // All three still answered, across the era switch — the second instance is a fresh
    // `McpServer` over the *same* core, which is what makes one build sufficient.
    expect(responses(r.stdout)).toHaveLength(3)
    expect(r.stdout).not.toContain('-32601')
  })

  it('exits 0 when the client closes stdin, without being told to', () => {
    // The MCP stdio binding expects a server to exit when its stdin closes. Nothing here
    // awaits "serving finished" — the SDK's handle exposes only `close()` — so this
    // asserts the process does not hang on an empty pipe.
    const r = run(['--agent-id', 'analyst-bot', '--registry', freshRegistryPath()])
    expect(r.code).toBe(EXIT.ok)
    expect(r.stdout).toBe('')
  })

  it('leaves the corpus untouched: no commit, no dirt', async () => {
    // Startup takes no write lock and makes no commit. If it did, every client restart
    // would add to the audit history, and ruling 6 would refuse the *next* startup.
    const registryPath = freshRegistryPath()
    await registerDirect(registryPath, 'fixture', fixture.root)
    const commitsBefore = fixtureGit(['rev-list', '--count', 'HEAD'], fixture.root).trim()
    const r = run(['--scope', 'fixture', '--agent-id', 'analyst-bot', '--registry', registryPath], { input: modernToolsList() })
    expect(r.code).toBe(EXIT.ok)
    expect(fixtureGit(['status', '--porcelain'], fixture.root)).toBe('')
    expect(fixtureGit(['rev-list', '--count', 'HEAD'], fixture.root).trim()).toBe(commitsBefore)
  })
})

// ── The startup banner ───────────────────────────────────────────────────

describe('startup banner', () => {
  it('reports the registry, the bound scope, the agent, and the derived commit author', async () => {
    const registryPath = freshRegistryPath()
    await registerDirect(registryPath, 'retail', fixture.root)
    const r = run(['--agent-id', 'analyst-bot', '--scope', 'retail', '--registry', registryPath], {
      input: modernToolsList(),
    })
    expect(r.code).toBe(EXIT.ok)
    expect(r.stderr).toContain(`registry:  ${registryPath}`)
    expect(r.stderr).toContain(`scope:     retail -> ${fixture.root}`)
    expect(r.stderr).toContain('agent:     analyst-bot')
    // The author email namespace an operator will see in `git log`, visible before the
    // first write rather than after it.
    expect(r.stderr).toMatch(/author:\s+analyst-bot <analyst-bot@agents\./)
  })

  it('reports no active scope instead of printing a blank, when none is bound', () => {
    const r = run(['--agent-id', 'a', '--registry', freshRegistryPath()], { input: modernToolsList() })
    expect(r.code).toBe(EXIT.ok)
    expect(r.stderr).toContain('no_active_scope')
  })

  it('reports the recovered posture after crash residue is restored', async () => {
    // Ruling 6 row 3, at the process level: residue behind a dead lock is restored and the
    // server starts. The unit-level matrix lives in startup-posture.spec.ts; what is
    // asserted here is that the recovery notice reaches stderr, so an operator can see a
    // recovery happened rather than inferring it from a quiet start.
    const registryPath = freshRegistryPath()
    await registerDirect(registryPath, 'fixture', fixture.root) // registered while clean

    writeFileSync(join(fixture.root, 'tables', 'dws_half_written.yaml'), 'table_name: x\n', 'utf8')
    const record: LockRecord = {
      // A pid that cannot be alive, on this host, so `inspect` returns 'dead'.
      pid: 2_147_483_646,
      host: hostname(),
      agent_id: 'crashed-agent',
      token: 'planted',
      acquired_at: Date.now() - 600_000,
      heartbeat_at: Date.now() - 600_000,
    }
    writeFileSync(join(fixture.root, '.git', LOCK_FILENAME), `${JSON.stringify(record)}\n`, 'utf8')

    const r = run(['--scope', 'fixture', '--agent-id', 'a', '--registry', registryPath], { input: modernToolsList() })
    expect(r.code).toBe(EXIT.ok)
    expect(r.stderr).toContain('crash recovery')
    expect(fixtureGit(['status', '--porcelain'], fixture.root)).toBe('')
  })
})

// ── Config carriers, at the process level ────────────────────────────────

describe('config carriers', () => {
  it('starts from environment variables alone', async () => {
    // The carrier insurance: we cannot verify whether QoderWork's MCP registration exposes
    // `args`, `env`, or both, and a server configurable only through the channel a host
    // happens not to offer is unusable for a reason the operator cannot see.
    const registryPath = freshRegistryPath()
    await registerDirect(registryPath, 'env-scope', fixture.root)
    const r = run([], {
      input: modernToolsList(),
      env: { SG_REGISTRY: registryPath, SG_AGENT_ID: 'env-bot', SG_SCOPE: 'env-scope' },
    })
    expect(r.code).toBe(EXIT.ok)
    expect(r.stderr).toContain('agent:     env-bot')
    expect(r.stderr).toContain('scope:     env-scope')
  })

  it('lets a flag win over its environment variable', () => {
    const registryPath = freshRegistryPath()
    const r = run(['--agent-id', 'flag-bot', '--registry', registryPath], {
      input: modernToolsList(),
      env: { SG_AGENT_ID: 'env-bot' },
    })
    expect(r.code).toBe(EXIT.ok)
    expect(r.stderr).toContain('agent:     flag-bot')
  })
})

// ── The seam #20 and #21 plug into ───────────────────────────────────────

describe('ToolRegistrar seam', () => {
  it('a registrar\'s tool reaches tools/list, with the capability pre-declared', () => {
    // #20 and #21's entire integration step is appending to `TOOL_REGISTRARS`. Declaring
    // `capabilities: { tools: {} }` for the zero-tool case and registering a tool later
    // could plausibly conflict — the SDK wires its tool handlers eagerly in the first case
    // and lazily in the second — so this asserts they compose. No scope needs to be bound:
    // the registrar seam is about tool registration, not corpus access.
    const r = run(['--agent-id', 'a', '--registry', freshRegistryPath()], {
      input: modernToolsList(),
      bin: REGISTRAR_BIN,
    })
    expect(r.code).toBe(EXIT.ok)
    const tools = (responses(r.stdout)[0]?.['result'] as { tools?: Array<{ name?: string }> } | undefined)?.tools
    expect(tools?.map(t => t.name)).toEqual(['seam_probe'])
    expect(r.stderr).toContain('tools:     1')
  })

  it('still refuses startup when a registrar is installed', () => {
    // Registering tools must not accidentally move the refusal behind the transport.
    const r = run(['--agent-id', 'bad<name>', '--registry', freshRegistryPath()], { bin: REGISTRAR_BIN })
    expect(r.code).toBe(EXIT.config)
    expect(r.stdout).toBe('')
  })
})

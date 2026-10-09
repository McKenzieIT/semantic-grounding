/**
 * The executable's process-level contract ([#22](https://github.com/McKenzieIT/semantic-grounding/issues/22)).
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
 * is tested here is that the entry *surfaces* a refusal and a recovery correctly.
 *
 * @module tests/server-startup.spec
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/main.ts'
import { LOCK_FILENAME, type LockRecord } from '../src/git/lock.ts'
import { createFixtureCorpus, fixtureGit, type FixtureCorpus } from './helpers/fixture-corpus.ts'

const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const REGISTRAR_BIN = fileURLToPath(new URL('./helpers/registrar-server.ts', import.meta.url))

/**
 * The environment to spawn with: the real one, minus this server's own variables.
 *
 * Scrubbed deliberately. An `SG_CORPUS` set in the developer's shell would silently
 * satisfy the "missing corpus" test and make it pass for the wrong reason.
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

let fixture: FixtureCorpus

beforeEach(() => {
  fixture = createFixtureCorpus()
})

afterEach(() => {
  fixture.cleanup()
})

// ── Usage errors: EX_USAGE (64) ──────────────────────────────────────────

describe('usage refusals exit 64 and say nothing on stdout', () => {
  it.each([
    ['no arguments at all', [] as readonly string[]],
    ['corpus without an agent id', ['--corpus', '/srv/c']],
    ['an unknown flag', ['--corpus', '/srv/c', '--agent-id', 'a', '--bogus']],
    ['a malformed lock timeout', ['--corpus', '/srv/c', '--agent-id', 'a', '--lock-timeout-ms', '10s']],
  ])('%s', (_label, args) => {
    const r = run(args)
    expect(r.code).toBe(EXIT.usage)
    expect(r.stdout).toBe('')
    // The usage text comes with the failure, so a mis-registered server teaches its own
    // surface at the moment the operator sees it fail.
    expect(r.stderr).toContain('--corpus')
  })

  it('prints help to stderr and exits 0', () => {
    const r = run(['--help'])
    expect(r.code).toBe(EXIT.ok)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('usage: sg-mcp')
  })
})

// ── Deployment refusals: EX_CONFIG (78) ──────────────────────────────────

describe('deployment refusals exit 78 and say nothing on stdout', () => {
  it('refuses a corpus that is not a git repository, naming the remedy', () => {
    const plain = createFixtureCorpus({ git: false })
    try {
      const r = run(['--corpus', plain.root, '--agent-id', 'a'])
      expect(r.code).toBe(EXIT.config)
      expect(r.stdout).toBe('')
      expect(r.stderr).toContain('git init')
    } finally {
      plain.cleanup()
    }
  })

  it('refuses a corpus nested inside a larger repository', () => {
    const nested = join(fixture.root, 'sub-corpus')
    mkdirSync(join(nested, 'tables'), { recursive: true })
    writeFileSync(join(nested, 'config.yaml'), 'scope_id: nested\n', 'utf8')
    const r = run(['--corpus', nested, '--agent-id', 'a'])
    expect(r.code).toBe(EXIT.config)
    expect(r.stderr).toContain('not a repository root')
  })

  it('refuses a dirty worktree with no lock, and leaves the edit alone', () => {
    const p = join(fixture.root, 'tables', 'dws_order.yaml')
    const before = readFileSync(p, 'utf8')
    writeFileSync(p, `${before}\n# a human's uncommitted edit\n`, 'utf8')

    const r = run(['--corpus', fixture.root, '--agent-id', 'a'])
    expect(r.code).toBe(EXIT.config)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('git stash')
    // Ruling 6's reason, asserted rather than assumed: the refusal must not be a cleanup.
    expect(readFileSync(p, 'utf8')).toContain("a human's uncommitted edit")
  })

  it('refuses an agent id git cannot use as an identity', () => {
    const r = run(['--corpus', fixture.root, '--agent-id', 'bad<name>'])
    expect(r.code).toBe(EXIT.config)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('stripped by git')
  })

  it('refuses before the transport exists — a refusal is never a JSON-RPC error', () => {
    // The measured alternative: refusing from inside the serveStdio factory yields a
    // canned `-32603 Internal server error`, exit 0, the remedy lost to the onerror sink,
    // and the factory retried on every request. All four are visible right here.
    const r = run(['--corpus', fixture.root, '--agent-id', 'bad<name>'], { input: modernToolsList() })
    expect(r.code).toBe(EXIT.config)
    expect(r.stdout).toBe('')
    expect(r.stderr).not.toContain('-32603')
  })
})

// ── Serving ──────────────────────────────────────────────────────────────

/** Every default-registrar tool `tools/list` must carry (#21's three — #20's land alongside). */
const ENRICHMENT_TOOL_NAMES = ['get_enrichment_work', 'apply_enrichment', 'run_enrichment']

describe('serving', () => {
  it('answers a 2026-07-28 tools/list with the default registrars\' tools and the revision\'s result shape', () => {
    const r = run(['--corpus', fixture.root, '--agent-id', 'analyst-bot'], { input: modernToolsList() })
    expect(r.code).toBe(EXIT.ok)

    const [res] = responses(r.stdout)
    expect(res).toBeDefined()
    const result = res?.['result'] as Record<string, unknown> | undefined
    // Zero tools was #22's own scope ("stdio transport 启动但零工具可用"); #21 appended
    // ADR-0006's three enrichment tools to the default `TOOL_REGISTRARS`, so the
    // real-executable list is no longer empty. `arrayContaining` rather than an exact
    // list — #20 appends ADR-0005's intent tools to the same array, and this test's own
    // point is the result *shape* (resultType/_meta below), not an exact tool census.
    expect(result?.['tools']).toEqual(
      expect.arrayContaining(ENRICHMENT_TOOL_NAMES.map(name => expect.objectContaining({ name }))),
    )
    // Revision markers the 2025-era shape does not carry. Their presence is what proves
    // `serveStdio` is wired rather than a hand-connected transport, which answers the
    // same bytes in the wrong era.
    expect(result?.['resultType']).toBe('complete')
    expect(result?.['_meta']).toMatchObject({
      'io.modelcontextprotocol/serverInfo': { name: '@semantic-grounding/mcp' },
    })
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

    const r = run(['--corpus', fixture.root, '--agent-id', 'analyst-bot'], { input: init + list })
    expect(r.code).toBe(EXIT.ok)

    const out = responses(r.stdout)
    expect(out).toHaveLength(2)
    expect((out[0]?.['result'] as Record<string, unknown>)?.['protocolVersion']).toBe('2025-11-25')
    // Same default-registrar tool set as the modern-era test above (#21's three).
    expect((out[1]?.['result'] as Record<string, unknown>)?.['tools']).toEqual(
      expect.arrayContaining(ENRICHMENT_TOOL_NAMES.map(name => expect.objectContaining({ name }))),
    )
    // No `-32601`: the regression this guards is reusing one McpServer across the
    // factory's two measured calls, which answers a legacy `initialize` "Method not found"
    // because the modern binding permanently mutates the instance.
    expect(r.stdout).not.toContain('-32601')
  })

  it('answers every request on one pinned connection', () => {
    const input = modernToolsList(1) + modernToolsList(2) + modernToolsList(3)
    const r = run(['--corpus', fixture.root, '--agent-id', 'analyst-bot'], { input })
    expect(r.code).toBe(EXIT.ok)
    expect(responses(r.stdout)).toHaveLength(3)
  })

  it('builds the corpus once even when the serving factory runs twice', () => {
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
    // the corpus twice, and construct two recorders over one corpus.
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

    const r = run(['--corpus', fixture.root, '--agent-id', 'analyst-bot'], { input: discover + init + list })
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
    const r = run(['--corpus', fixture.root, '--agent-id', 'analyst-bot'])
    expect(r.code).toBe(EXIT.ok)
    expect(r.stdout).toBe('')
  })

  it('leaves the corpus untouched: no commit, no dirt', () => {
    // Startup takes no write lock and makes no commit. If it did, every client restart
    // would add to the audit history, and ruling 6 would refuse the *next* startup.
    const commitsBefore = fixtureGit(['rev-list', '--count', 'HEAD'], fixture.root).trim()
    const r = run(['--corpus', fixture.root, '--agent-id', 'analyst-bot'], { input: modernToolsList() })
    expect(r.code).toBe(EXIT.ok)
    expect(fixtureGit(['status', '--porcelain'], fixture.root)).toBe('')
    expect(fixtureGit(['rev-list', '--count', 'HEAD'], fixture.root).trim()).toBe(commitsBefore)
  })
})

// ── The startup banner ───────────────────────────────────────────────────

describe('startup banner', () => {
  it('reports the resolved corpus, the agent, and the derived commit author', () => {
    const r = run(['--corpus', fixture.root, '--agent-id', 'analyst-bot', '--scope', 'retail'], {
      input: modernToolsList(),
    })
    expect(r.code).toBe(EXIT.ok)
    // The *resolved* toplevel, not the configured string. Every fixture here is reached
    // through a symlinked temp dir, so this also keeps the realpath handling honest.
    expect(r.stderr).toContain(fixtureGit(['rev-parse', '--show-toplevel'], fixture.root).trim())
    expect(r.stderr).toContain('posture:   clean')
    expect(r.stderr).toContain('agent:     analyst-bot')
    // The author email namespace an operator will see in `git log`, visible before the
    // first write rather than after it.
    expect(r.stderr).toMatch(/author:\s+analyst-bot <analyst-bot@agents\./)
    expect(r.stderr).toContain('scope:     retail')
  })

  it('says a scope was not configured instead of printing a blank', () => {
    const r = run(['--corpus', fixture.root, '--agent-id', 'a'], { input: modernToolsList() })
    expect(r.stderr).toContain('no X-SG-Scope trailer')
  })

  it('reports the recovered posture after crash residue is restored', () => {
    // Ruling 6 row 3, at the process level: residue behind a dead lock is restored and the
    // server starts. The unit-level matrix lives in startup-posture.spec.ts; what is
    // asserted here is that the report reaches the banner, so an operator can see a
    // recovery happened rather than inferring it from a quiet start.
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

    const r = run(['--corpus', fixture.root, '--agent-id', 'a'], { input: modernToolsList() })
    expect(r.code).toBe(EXIT.ok)
    expect(r.stderr).toContain('crash recovery')
    expect(r.stderr).toContain('posture:   recovered')
    expect(fixtureGit(['status', '--porcelain'], fixture.root)).toBe('')
  })
})

// ── Config carriers, at the process level ────────────────────────────────

describe('config carriers', () => {
  it('starts from environment variables alone', () => {
    // The carrier insurance: we cannot verify whether QoderWork's MCP registration exposes
    // `args`, `env`, or both, and a server configurable only through the channel a host
    // happens not to offer is unusable for a reason the operator cannot see.
    const r = run([], {
      input: modernToolsList(),
      env: { SG_CORPUS: fixture.root, SG_AGENT_ID: 'env-bot', SG_SCOPE: 'env-scope' },
    })
    expect(r.code).toBe(EXIT.ok)
    expect(r.stderr).toContain('agent:     env-bot')
    expect(r.stderr).toContain('scope:     env-scope')
  })

  it('lets a flag win over its environment variable', () => {
    const r = run(['--agent-id', 'flag-bot'], {
      input: modernToolsList(),
      env: { SG_CORPUS: fixture.root, SG_AGENT_ID: 'env-bot' },
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
    // and lazily in the second — so this asserts they compose.
    const r = run(['--corpus', fixture.root, '--agent-id', 'a'], {
      input: modernToolsList(),
      bin: REGISTRAR_BIN,
    })
    expect(r.code).toBe(EXIT.ok)
    const tools = (responses(r.stdout)[0]?.['result'] as { tools?: Array<{ name?: string }> } | undefined)?.tools
    expect(tools?.map(t => t.name)).toEqual(['seam_probe'])
    expect(r.stderr).toContain('tools:     1 registrar(s)')
  })

  it('still refuses startup when a registrar is installed', () => {
    // Registering tools must not accidentally move the refusal behind the transport.
    const r = run(['--corpus', fixture.root, '--agent-id', 'bad<name>'], { bin: REGISTRAR_BIN })
    expect(r.code).toBe(EXIT.config)
    expect(r.stdout).toBe('')
  })
})

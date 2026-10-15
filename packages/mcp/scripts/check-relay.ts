#!/usr/bin/env node
/**
 * The opt-in cross-agent relay driver (#157 / #156's ruling / #129's harness
 * research) — Destination ④'s REAL measurement, which by ruling never enters
 * the four gates: it spends external-LLM money, it is nondeterministic, and a
 * 401 from an upstream gateway must not paint a gate red (#81's
 * environment-red-is-skipIf doctrine, inverted: don't put the environment in
 * the gate at all).
 *
 * ## What it runs (the three cards, per #156)
 *
 * | card | corpus | A harness | B harness | L0 (#156's per-card table) |
 * |---|---|---|---|---|
 * | E3 | k11 fixture COPY in a temp sandbox, own temp registry | `claude -p --bare` | `claude -p --bare` (isolated) | promotion commit carries only `X-SG-Evidence: source` |
 * | A3 | same k11-copy shape | `claude -p --bare` | `claude -p --bare` | `record_memory` commit carries only `X-SG-Session` |
 * | G3′ | the REAL X63 scope `10000354` via the per-user registry | `qodercli` | `qodercli` | `record_memory` (incident) carries only `X-SG-Session` |
 *
 * E3 additionally runs ADR-0028 R4's 晋升前对照组: the same question against the
 * concept-free corpus must NOT pass — if it does, the scenario proves nothing
 * and the driver reports 换题 rather than a pass.
 *
 * ## Judging (#129's rubric)
 *
 * - L0 (deterministic, asserted here on the corpus git): the commit, its trailers,
 *   and the landed content per card.
 * - L1 (trajectory): B called at least one SG read tool (answering correctly
 *   with ZERO tool calls is a leak, judged FAIL); E3 additionally requires the
 *   trajectory to have touched `二级渠道`.
 * - L2 (answer keywords, allOf/anyOf/negative from `relay-scenarios.ts`).
 * - L3 (cross-host): one extra B run on the other harness (codex for the k11
 *   cards, claude for the qodercli card).
 * - N=5 B runs, pass ≥ ⌈0.8·N⌉ (#129: trajectory COUNTS are never asserted, only
 *   whether a read tool was called at all).
 *
 * ## Artifacts
 *
 * - `fixtures/relay/<id>.json` — B's recorded MCP request sequence from the
 *   first passing run (#156: this is exactly what the e2e gate's Phase 8
 *   replay leg consumes; until the first real run deposits it, that gate leg
 *   skips). COMMIT this file.
 * - `fixtures/relay/<id>-result.json` — the full result (pass rate, per-run
 *   trajectories, commit SHAs, costs). Git-ignored; paste into #157.
 *
 * ## Preflight fails loud, never silently skips
 *
 * Every leg names the CLI it needs, the env vars that authenticate it (all of
 * #129's findings), and the artifact path it could not find. Nothing degrades
 * into "ran fewer scenarios than asked".
 *
 * Run: `pnpm relay [--scenario e3|a3|g3|all] [--runs N] [--control-runs N]
 * [--skip-l3] [--keep]` — see `docs/relay-hitl.md` for the host-side runbook.
 *
 * @module check-relay
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import {
  G3_TARGET_PLACEHOLDER,
  G3_WINDOW,
  K11_RELAY_SCOPE_ID,
  X63_SCOPE_ID,
  judgeAnswer,
  relayScenario,
  type RelayHost,
  type RelayScenario,
} from './relay-scenarios.ts'

/** The mcp package root (`packages/mcp`) — sg-mcp is spawned from `src/bin.ts`. */
const MCP_ROOT = fileURLToPath(new URL('..', import.meta.url))
/** The repo root (workspace). */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
/** The k11 fixture (#128 P1's carrier for E3/A3). */
const K11_FIXTURE = fileURLToPath(new URL('../../substrate/tests/fixtures/k11/', import.meta.url))
/** Where the recorded fixtures + result artifacts land (Phase 8's replay reads here). */
const FIXTURE_DIR = join(MCP_ROOT, 'fixtures', 'relay')

// ── CLI surface ───────────────────────────────────────────────────────────────────

/** Parsed CLI options (flags + env overrides; see docs/relay-hitl.md). */
interface Options {
  readonly scenarios: readonly ('e3' | 'a3' | 'g3')[]
  readonly runs: number
  readonly controlRuns: number
  readonly skipL3: boolean
  readonly keep: boolean
  readonly tight: boolean
  readonly timeoutMs: number
}

function parseOptions(argv: readonly string[]): Options {
  const scenarios: ('e3' | 'a3' | 'g3')[] = []
  let runs = Number(process.env['SG_RELAY_RUNS'] ?? 5)
  let controlRuns = Number(process.env['SG_RELAY_CONTROL_RUNS'] ?? 3)
  let skipL3 = process.env['SG_RELAY_SKIP_L3'] === '1'
  let keep = false
  let tight = process.env['SG_RELAY_TIGHT'] !== '0'
  let timeoutMs = Number(process.env['SG_RELAY_TIMEOUT_MS'] ?? 300_000)
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--scenario') {
      const value = argv[i + 1] ?? 'all'
      if (value === 'all') scenarios.push('e3', 'a3', 'g3')
      else if (value === 'e3' || value === 'a3' || value === 'g3') scenarios.push(value)
      else throw new Error(`--scenario: expected e3|a3|g3|all, got "${value}"`)
      i += 1
    } else if (arg === '--runs') {
      runs = Number(argv[i + 1] ?? runs)
      i += 1
    } else if (arg === '--control-runs') {
      controlRuns = Number(argv[i + 1] ?? controlRuns)
      i += 1
    } else if (arg === '--skip-l3') {
      skipL3 = true
    } else if (arg === '--keep') {
      keep = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: pnpm relay [--scenario e3|a3|g3|all] [--runs N] [--control-runs N] [--skip-l3] [--keep]\nenv: SG_RELAY_RUNS / SG_RELAY_CONTROL_RUNS / SG_RELAY_SKIP_L3 / SG_RELAY_TIGHT / SG_RELAY_TIMEOUT_MS / SG_RELAY_CLAUDE / SG_RELAY_CODEX / SG_RELAY_QODERCLI / SG_RELAY_CLAUDE_MODEL / SG_RELAY_QODER_MODEL / SG_RELAY_QODER_FLAGS / SG_RELAY_G3_TARGET')
      process.exit(0)
    } else {
      throw new Error(`unknown flag: ${arg}`)
    }
  }
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer, got ${runs}`)
  if (!Number.isInteger(controlRuns) || controlRuns < 1) throw new Error(`--control-runs must be a positive integer, got ${controlRuns}`)
  return {
    scenarios: scenarios.length > 0 ? scenarios : ['e3', 'a3', 'g3'],
    runs, controlRuns, skipL3, keep, tight, timeoutMs,
  }
}

/** The binary name for a host, overridable per host (#129/#156's paths are per-machine). */
function binaryOf(host: RelayHost): string {
  if (host === 'claude') return process.env['SG_RELAY_CLAUDE'] ?? 'claude'
  if (host === 'codex') return process.env['SG_RELAY_CODEX'] ?? 'codex'
  return process.env['SG_RELAY_QODERCLI'] ?? join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '', '.qoder', 'bin', 'qodercli', 'qodercli')
}

/** `qodercli` lives outside PATH on the machines that have it (#156); fall back
 * to the bare name when the default absolute path does not exist. */
function resolveBinary(host: RelayHost): string {
  const bin = binaryOf(host)
  if (host === 'qodercli' && process.env['SG_RELAY_QODERCLI'] === undefined && !existsSync(bin)) return 'qodercli'
  return bin
}

// ── Process plumbing ──────────────────────────────────────────────────────────────

/** One parsed harness run: everything the judges read. */
interface ParsedRun {
  readonly sgCalls: ReadonlyArray<{ readonly name: string; readonly input: Record<string, unknown> }>
  readonly trajectoryText: string
  readonly answer: string
  readonly costUsd: number | undefined
}

/** One harness invocation's outcome. */
interface HostRun {
  readonly ok: boolean
  readonly parsed: ParsedRun
  readonly error: string | undefined
  readonly stdoutPath: string
  readonly durationMs: number
}

/** Run git in a corpus (#129's sandbox discipline: never the user's repos). */
function git(args: readonly string[], cwd: string): string {
  const res = spawnSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${res.stderr}`)
  return res.stdout
}

/** The SG tool surface, imported lazily — before it, the substrate-lib preflight
 * must have passed (the workspace dep resolves to `lib/`, CLAUDE.md's known pit). */
let sgToolNames: ReadonlySet<string> | undefined

/** Normalize a host-rendered MCP tool name to its SG name; `undefined` when the call was not SG. */
function sgCallOf(name: string, input: Record<string, unknown>): { readonly name: string; readonly input: Record<string, unknown> } | undefined {
  if (sgToolNames === undefined) throw new Error('SG tool surface not loaded')
  let normalized = name
  for (const prefix of ['mcp__sg__', 'sg__', 'sg/']) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length)
      break
    }
  }
  return sgToolNames.has(normalized) ? { name: normalized, input } : undefined
}

/** Parse one harness's JSONL stream (claude/qodercli's stream-json shape, then
 * codex's --json shape — #129 measured both; tool names arrive as `mcp__sg__x`,
 * `sg/x`, or bare, all normalized by {@link sgCallOf}). */
function parseStream(raw: string): ParsedRun {
  const calls: { name: string; input: Record<string, unknown> }[] = []
  let trajectoryText = ''
  let answer = ''
  let lastAssistantText = ''
  let costUsd: number | undefined
  const consumeCall = (name: unknown, input: unknown): void => {
    if (typeof name !== 'string') return
    const args = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>
    calls.push({ name, input: args })
  }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let evt: Record<string, unknown>
    try {
      evt = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue // harnesses interleave non-JSON notices on stdout; stderr is kept separately
    }
    // claude -p / qodercli --print stream-json shape
    if (evt['type'] === 'assistant' || evt['type'] === 'user') {
      const message = evt['message'] as Record<string, unknown> | undefined
      const content = message?.['content']
      if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block['type'] === 'tool_use') {
            consumeCall(block['name'], block['input'])
          } else if (block['type'] === 'text' && typeof block['text'] === 'string') {
            trajectoryText += `${block['text']}\n`
            if (evt['type'] === 'assistant') lastAssistantText = block['text']
          } else if (block['type'] === 'tool_result') {
            const c = block['content']
            trajectoryText += `${typeof c === 'string' ? c : JSON.stringify(c)}\n`
          }
        }
      }
    } else if (evt['type'] === 'result') {
      if (typeof evt['result'] === 'string') answer = evt['result']
      if (typeof evt['total_cost_usd'] === 'number') costUsd = evt['total_cost_usd']
    }
    // codex exec --json shape (#129's C leg: item.completed with .server/.tool)
    else if (evt['type'] === 'item.completed') {
      const item = evt['item'] as Record<string, unknown> | undefined
      if (item === undefined) continue
      if (typeof item['server'] === 'string' && typeof item['tool'] === 'string') {
        const rawArgs = item['arguments'] ?? item['input'] ?? item['args']
        if (typeof rawArgs === 'string') {
          try {
            consumeCall(`${item['server']}/${item['tool']}`, JSON.parse(rawArgs))
          } catch {
            consumeCall(`${item['server']}/${item['tool']}`, {})
          }
        } else {
          consumeCall(`${item['server']}/${item['tool']}`, rawArgs)
        }
      } else if (item['type'] === 'agent_message' && typeof item['text'] === 'string') {
        answer = item['text']
      }
    }
  }
  if (answer === '') answer = lastAssistantText
  return {
    sgCalls: calls.map(c => sgCallOf(c.name, c.input)).filter((c): c is { name: string; input: Record<string, unknown> } => c !== undefined),
    trajectoryText,
    answer,
    costUsd,
  }
}

/** The mcp-config file one harness leg gets (claude/qodercli's `--mcp-config`
 * shape; codex takes the same server inline via `-c`). */
function writeMcpConfig(path: string, agentId: string, registryPath: string, scopeId: string): void {
  writeFileSync(path, `${JSON.stringify({
    mcpServers: {
      sg: {
        command: process.execPath,
        args: [join(MCP_ROOT, 'src', 'bin.ts'), '--agent-id', agentId, '--registry', registryPath, '--scope', scopeId],
      },
    },
  }, null, 2)}\n`, 'utf8')
}

/** Run one harness leg (stdin ignored — #129's pit #1: both CLIs hang waiting on a tty stdin). */
async function runHost(host: RelayHost, args: readonly string[], cwd: string, stdoutPath: string, timeoutMs: number): Promise<HostRun> {
  const bin = resolveBinary(host)
  const started = Date.now()
  return await new Promise<HostRun>(resolve => {
    const child = spawn(bin, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (ok: boolean, error: string | undefined): void => {
      writeFileSync(stdoutPath, stdout, 'utf8')
      if (stderr.trim() !== '') writeFileSync(`${stdoutPath}.stderr.txt`, stderr, 'utf8')
      const parsed = parseStream(stdout)
      resolve({ ok: ok && parsed.answer.trim() !== '', parsed, error, stdoutPath, durationMs: Date.now() - started })
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      finish(false, `timed out after ${timeoutMs}ms`)
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', e => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, parsed: parseStream(stdout), error: `failed to spawn ${bin}: ${e.message}`, stdoutPath, durationMs: Date.now() - started })
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      finish(code === 0, code === 0 ? undefined : `exit=${code}${stderr.trim() !== '' ? `; stderr: ${stderr.trim().split('\n').slice(-5).join(' | ')}` : ''}`)
    })
  })
}

/** claude's isolation six-piece (#129 §2: --bare + strict-mcp + fresh process +
 * no-session-persistence + tmp cwd + prompt-without-answer-keywords; tight adds
 * `--setting-sources ""` which also neutralizes the settings env block — auth
 * must then come from real env vars, which the preflight checks). */
function claudeArgs(mcpConfig: string, prompt: string, tight: boolean, model: string | undefined): string[] {
  return [
    '-p', '--bare',
    ...model !== undefined ? ['--model', model] : [],
    ...tight ? ['--setting-sources', ''] : [],
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence',
    prompt,
  ]
}

/** qodercli's flags (#156 measured them aligned with `claude -p`). */
function qodercliArgs(mcpConfig: string, prompt: string): string[] {
  const extra = (process.env['SG_RELAY_QODER_FLAGS'] ?? '').split(' ').filter(s => s !== '')
  const model = process.env['SG_RELAY_QODER_MODEL']
  return [
    '--print',
    ...model !== undefined ? ['--model', model] : [],
    '--output-format', 'stream-json', '--verbose',
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    ...extra, prompt,
  ]
}

/** codex's flags (#129 §1.2 — note: NO --ignore-user-config, it takes auth with it). */
function codexArgs(registryPath: string, scopeId: string, agentId: string, cwd: string, prompt: string): string[] {
  const serverArgs = JSON.stringify([join(MCP_ROOT, 'src', 'bin.ts'), '--agent-id', agentId, '--registry', registryPath, '--scope', scopeId])
  return [
    'exec', '--ephemeral', '--skip-git-repo-check', '-C', cwd, '-s', 'read-only', '--json',
    '-c', `mcp_servers.sg.command="${process.execPath}"`,
    '-c', `mcp_servers.sg.args=${serverArgs}`,
    prompt,
  ]
}

/** One B-side invocation, whatever the host. */
async function askOnce(host: RelayHost, prompt: string, sandbox: RelaySandbox, opts: Options, tag: string): Promise<HostRun> {
  const outPath = join(sandbox.outDir, `${tag}.jsonl`)
  if (host === 'claude') return runHost('claude', claudeArgs(sandbox.mcpB, prompt, opts.tight, process.env['SG_RELAY_CLAUDE_MODEL']), sandbox.dir, outPath, opts.timeoutMs)
  if (host === 'qodercli') return runHost('qodercli', qodercliArgs(sandbox.mcpB, prompt), sandbox.dir, outPath, opts.timeoutMs)
  return runHost('codex', codexArgs(sandbox.registryPath, sandbox.scopeId, `relay-l3`, sandbox.dir, prompt), sandbox.dir, outPath, opts.timeoutMs)
}

// ── Sandbox ───────────────────────────────────────────────────────────────────────

/** One scenario's disposable world (k11 legs: own corpus copy + own registry;
 * the X63 leg borrows the real registry/corpus and only gets an output dir). */
interface RelaySandbox {
  readonly dir: string
  readonly outDir: string
  readonly registryPath: string
  readonly scopeId: string
  readonly mcpA: string
  readonly mcpB: string
  /** The corpus git root L0 judges on (k11 legs: the copy; X63: the real corpus). */
  readonly corpusRoot: string
  /** HEAD before the A leg — L0's `git rev-list baseline..HEAD`. */
  readonly baseline: string
  cleanup(): void
}

/** Build the k11-copy sandbox: fixture copy → git init → local identity →
 * hermetic line endings → gc off → baseline commit → mcp configs. The REAL
 * `~/.semantic-grounding/scopes.yaml` is never touched (#129's sandbox iron
 * rule — the k11 legs carry their own registry). */
function buildK11Sandbox(scenario: RelayScenario, registryPath: string): RelaySandbox {
  const dir = mkdtempSync(join(tmpdir(), `sg-relay-${scenario.id}-`))
  const corpusRoot = realpathSync(join(dir, 'corpus'))
  cpSync(K11_FIXTURE, corpusRoot, { recursive: true })
  git(['init', '--quiet', '--initial-branch=main', '.'], corpusRoot)
  git(['config', 'user.name', `relay-${scenario.id}`], corpusRoot)
  git(['config', 'user.email', `relay-${scenario.id}@relay.invalid`], corpusRoot)
  git(['config', 'commit.gpgsign', 'false'], corpusRoot)
  git(['config', 'core.autocrlf', 'false'], corpusRoot)
  git(['config', 'gc.auto', '0'], corpusRoot)
  git(['add', '-A'], corpusRoot)
  git(['commit', '--quiet', '-m', 'relay sandbox: k11 fixture baseline'], corpusRoot)
  const baseline = git(['rev-parse', 'HEAD'], corpusRoot).trim()
  writeMcpConfig(join(dir, 'mcp-a.json'), `relay-${scenario.id}-a`, registryPath, K11_RELAY_SCOPE_ID)
  writeMcpConfig(join(dir, 'mcp-b.json'), `relay-${scenario.id}-b`, registryPath, K11_RELAY_SCOPE_ID)
  const outDir = join(dir, 'out')
  mkdirSync(outDir, { recursive: true })
  return {
    dir, outDir, registryPath, scopeId: K11_RELAY_SCOPE_ID,
    mcpA: join(dir, 'mcp-a.json'), mcpB: join(dir, 'mcp-b.json'),
    corpusRoot, baseline,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** The X63 leg's world: outputs land in a temp dir; the registry and the corpus
 * are the REAL ones (#156's ruling — G3′ rides the QoderWork-initialized scope).
 * The incident memory this leg writes is a real, bounded, memory-layer-only
 * artifact: never a definition fingerprint, retirable via a supersedes entry. */
function buildX63Sandbox(scenario: RelayScenario, registryPath: string, corpusRoot: string): RelaySandbox {
  const dir = mkdtempSync(join(tmpdir(), `sg-relay-${scenario.id}-`))
  const outDir = join(dir, 'out')
  mkdirSync(outDir, { recursive: true })
  writeMcpConfig(join(dir, 'mcp-a.json'), `relay-${scenario.id}-a`, registryPath, X63_SCOPE_ID)
  writeMcpConfig(join(dir, 'mcp-b.json'), `relay-${scenario.id}-b`, registryPath, X63_SCOPE_ID)
  return {
    dir, outDir, registryPath, scopeId: X63_SCOPE_ID,
    mcpA: join(dir, 'mcp-a.json'), mcpB: join(dir, 'mcp-b.json'),
    corpusRoot, baseline: git(['rev-parse', 'HEAD'], corpusRoot).trim(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// ── L0 — the deterministic half, judged on the corpus git ─────────────────────────

/** One L0 finding. */
interface L0Result {
  readonly pass: boolean
  readonly commits: ReadonlyArray<{ readonly sha: string; readonly subject: string; readonly trailers: Record<string, string> }>
  readonly error: string | undefined
}

/** Read every commit since `baseline` with its full X-SG-* trailer map. */
function commitsSince(root: string, baseline: string): Array<{ sha: string; subject: string; trailers: Record<string, string> }> {
  const shas = git(['rev-list', '--reverse', '--max-count=50', `${baseline}..HEAD`], root).trim().split('\n').filter(s => s !== '')
  return shas.map(sha => {
    const subject = git(['log', '-1', '--format=%s', sha], root).trim()
    const block = git(['log', '-1', '--format=%(trailers)', sha], root)
    const trailers: Record<string, string> = {}
    for (const line of block.split('\n')) {
      const m = /^X-SG-([A-Za-z-]+): (.*)$/.exec(line.trim())
      if (m?.[1] !== undefined) trailers[m[1]] = m[2] ?? ''
    }
    return { sha, subject, trailers }
  })
}

/** Judge one card's L0 (#156's per-card table). */
function judgeL0(scenario: RelayScenario, root: string, baseline: string, g3Target: string | undefined): L0Result {
  const commits = commitsSince(root, baseline)
  const fail = (error: string): L0Result => ({ pass: false, commits, error })
  if (scenario.l0.must === 'evidence-source') {
    const promo = commits.find(c => c.trailers['Evidence'] === 'source')
    if (promo === undefined) return fail('no commit carries X-SG-Evidence: source — the A leg did not declare the promotion')
    if (!(promo.trailers['Evidence-Source'] ?? '').includes('ch_id')) return fail('X-SG-Evidence-Source does not name the ch_id column comment')
    for (const c of commits) {
      if (c.trailers['Memory'] !== undefined) return fail(`commit ${c.sha.slice(0, 7)} carries X-SG-Memory (E3: 确定性直升,无 memory 引用)`)
      if (c.trailers['Session'] !== undefined) return fail(`commit ${c.sha.slice(0, 7)} carries X-SG-Session (E3 per #156: 仅 X-SG-Evidence: source)`)
    }
    for (const [name, alias] of [['一级渠道', '1渠'], ['二级渠道', '2渠']] as const) {
      const path = join(root, 'concepts', `${name}.yaml`)
      if (!existsSync(path)) return fail(`concepts/${name}.yaml not landed`)
      const concept = yaml.load(readFileSync(path, 'utf8')) as Record<string, unknown>
      if (!(((concept['alt_labels'] as unknown[]) ?? []) as string[]).includes(alias)) return fail(`concept ${name} is missing its alias "${alias}"`)
    }
    const secondary = yaml.load(readFileSync(join(root, 'concepts', '二级渠道.yaml'), 'utf8')) as Record<string, unknown>
    const refs = (secondary['related_refs'] as Array<Record<string, unknown>>) ?? []
    if (!refs.some(r => r['target_kind'] === 'concept' && r['target'] === '一级渠道')) return fail('concept 二级渠道 has no related_to edge to 一级渠道')
    return { pass: true, commits, error: undefined }
  }
  // A3 / G3′: a record_memory commit carrying ONLY X-SG-Session (never a promotion)
  const mem = commits.find(c => c.trailers['Tool'] === 'record_memory')
  if (mem === undefined) return fail('no record_memory commit landed')
  if (mem.trailers['Session'] === undefined) return fail('the record_memory commit carries no X-SG-Session')
  for (const c of commits) {
    if (c.trailers['Evidence'] !== undefined) return fail(`commit ${c.sha.slice(0, 7)} carries X-SG-Evidence (per #156: A3/G3′ 仅 X-SG-Session,不晋升)`)
    if (c.trailers['Memory'] !== undefined) return fail(`commit ${c.sha.slice(0, 7)} carries X-SG-Memory`)
  }
  const memoryFiles = git(['diff-tree', '--no-commit-id', '--name-only', '-r', mem.sha], root).trim().split('\n').filter(f => f.startsWith('memory/'))
  if (memoryFiles.length === 0) return fail('no memory/ file found in the record_memory commit')
  let sawExpected = false
  for (const rel of memoryFiles) {
    const entry = yaml.load(readFileSync(join(root, rel), 'utf8')) as Record<string, unknown>
    if (scenario.id === 'a3') {
      if (entry['type'] !== 'practice') continue
      const anchors = ((entry['anchors'] as unknown[]) ?? []).map(String)
      const body = typeof entry['body'] === 'string' ? entry['body'] : ''
      if (!anchors.some(a => a.includes('付费经济')) || !body.includes('500')) continue
      sawExpected = true
      if (entry['promoted'] !== undefined) return fail('the practice memory already carries `promoted` (A3: 本次不升)')
    } else {
      if (entry['type'] !== 'incident') continue
      if (entry['valid_from'] !== G3_WINDOW.from || entry['valid_until'] !== G3_WINDOW.to) continue
      if (g3Target !== undefined && !(((entry['anchors'] as unknown[]) ?? []).map(String)).some(a => a.includes(g3Target))) continue
      sawExpected = true
      if (entry['promoted'] !== undefined) return fail('the incident memory carries `promoted` (G3′: 永不升)')
    }
  }
  if (!sawExpected) return fail('no memory entry matches the card (type / anchors / window)')
  return { pass: true, commits, error: undefined }
}

// ── L1 ────────────────────────────────────────────────────────────────────────────

/** L1: B called an SG read tool (zero tool calls + a correct answer = leak =
 * fail), plus the card's trajectory-mentions rule (E3: touched 二级渠道). */
function judgeL1(scenario: RelayScenario, run: HostRun): { readonly pass: boolean; readonly error: string | undefined } {
  if (!run.parsed.sgCalls.some(c => scenario.l1.readTools.includes(c.name))) {
    return { pass: false, error: `no SG read tool called (called: ${run.parsed.sgCalls.map(c => c.name).join(', ') || 'none'} — a correct answer without a read is a leak)` }
  }
  const trajectory = `${run.parsed.trajectoryText}\n${JSON.stringify(run.parsed.sgCalls)}`
  for (const mention of scenario.l1.trajectoryMentions) {
    if (!trajectory.includes(mention)) return { pass: false, error: `trajectory never mentions "${mention}"` }
  }
  return { pass: true, error: undefined }
}

// ── Preflight ─────────────────────────────────────────────────────────────────────

/** Everything a leg declared it needs — surfaced as ONE actionable error the
 * moment it is missing (never a silent skip). */
function preflight(scenarios: readonly RelayScenario[], opts: Options): void {
  const problems: string[] = []
  const substrateLib = join(REPO_ROOT, 'packages', 'substrate', 'lib', 'index.js')
  if (!existsSync(substrateLib)) {
    problems.push(`substrate not built (${substrateLib} missing) — run "pnpm -r build" first (CLAUDE.md: direct .ts runs resolve the workspace dep to lib/)`)
  }
  const hosts = new Set<RelayHost>()
  for (const s of scenarios) {
    hosts.add(s.harnessA)
    hosts.add(s.harnessB)
    if (!opts.skipL3) hosts.add(s.harnessL3)
  }
  for (const host of hosts) {
    const bin = resolveBinary(host)
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30_000 })
    if (probe.error !== undefined || probe.status !== 0) {
      problems.push(`${host} leg: CLI not runnable ("${bin}" ${probe.error !== undefined ? probe.error.message : `exited ${probe.status}`}) — install it or point SG_RELAY_${host.toUpperCase()} at the binary`)
      continue
    }
    if (host === 'claude') {
      const auth = process.env['ANTHROPIC_AUTH_TOKEN'] ?? process.env['ANTHROPIC_API_KEY']
      if (auth === undefined || auth === '') {
        problems.push("claude leg: neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY is in the env. #129 measured --bare authenticates with ANTHROPIC_AUTH_TOKEN (+ANTHROPIC_BASE_URL for a third-party gateway); if yours live only in ~/.claude/settings.json's env block, export them first (jq -r '.env.ANTHROPIC_AUTH_TOKEN' ~/.claude/settings.json) or set SG_RELAY_TIGHT=0 to let --bare read the settings env block")
      }
    }
  }
  if (scenarios.some(s => s.corpus === 'k11-copy') && !existsSync(K11_FIXTURE)) {
    problems.push(`k11 fixture missing at ${K11_FIXTURE} — the E3/A3 carrier (#128 P1)`)
  }
  if (problems.length > 0) {
    throw new Error(`relay preflight failed:\n  - ${problems.join('\n  - ')}`)
  }
}

// ── The driver ────────────────────────────────────────────────────────────────────

/** One treatment run's verdict. */
interface RunVerdict {
  readonly tag: string
  readonly host: RelayHost
  readonly ok: boolean
  readonly error: string | undefined
  readonly l1: { readonly pass: boolean; readonly error: string | undefined }
  readonly l2: ReadonlyArray<{ readonly question: string; readonly pass: boolean; readonly misses: readonly string[] }>
  readonly tools: readonly string[]
  readonly answerExcerpt: string
  readonly costUsd: number | undefined
  readonly durationMs: number
  readonly pass: boolean
}

/** The per-scenario result artifact (#157: pass rate / trajectory summary / commit SHAs). */
interface ScenarioResult {
  readonly scenario: string
  readonly card: string
  readonly corpus: string
  readonly ranAt: string
  readonly repoHead: string
  readonly l0: { readonly pass: boolean; readonly error: string | undefined; readonly commits: L0Result['commits'] }
  readonly control: { readonly runs: number; readonly passed: number; readonly valid: boolean } | undefined
  readonly treatment: { readonly runs: number; readonly passed: number; readonly verdicts: readonly RunVerdict[] }
  readonly l3: RunVerdict | undefined
  readonly passRate: string
  readonly threshold: string
  readonly verdict: 'PASS' | 'FAIL' | 'INVALID (换题 — the control passed pre-promotion)'
  readonly fixtureWritten: string | undefined
}

/** Substitute the G3′ target table into a prompt carrying the placeholder. */
function withG3Target(prompt: string, target: string): string {
  return prompt.split(G3_TARGET_PLACEHOLDER).join(target)
}

/** The semantic layer dir for a corpus root (io.ts's resolveSemanticLayer rule:
 * the root itself when it holds config.yaml, else the first child that does). */
function resolveLayerDir(semanticRoot: string): string {
  if (existsSync(join(semanticRoot, 'config.yaml'))) return semanticRoot
  for (const child of readdirSync(semanticRoot)) {
    const c = join(semanticRoot, child)
    if (existsSync(join(c, 'config.yaml'))) return c
  }
  throw new Error(`no config.yaml found under ${semanticRoot} — not a semantic-grounding corpus root`)
}

/** Discover the X63 target table: env override first, else the first `dws_*`
 * table file of the real corpus (a partitioned fact table — the G3′ shape). */
function discoverG3Target(semanticRoot: string): string {
  const override = process.env['SG_RELAY_G3_TARGET']
  if (override !== undefined && override !== '') return override
  const tablesDir = join(resolveLayerDir(semanticRoot), 'tables')
  if (!existsSync(tablesDir)) throw new Error(`X63 corpus has no tables/ at ${tablesDir} — set SG_RELAY_G3_TARGET to a real table name`)
  const names = readdirSync(tablesDir).filter(f => f.endsWith('.yaml') && f.startsWith('dws_')).sort()
  const first = names[0]
  if (first === undefined) throw new Error(`no dws_* table found in ${tablesDir} — set SG_RELAY_G3_TARGET to a real table name`)
  return first.slice(0, -'.yaml'.length)
}

async function runScenario(scenario: RelayScenario, opts: Options, repoHead: string): Promise<ScenarioResult> {
  console.log(`\n[relay] === ${scenario.id}: ${scenario.card} ===`)
  let g3Target: string | undefined
  let sandbox: RelaySandbox
  if (scenario.corpus === 'k11-copy') {
    const { ScopeRegistryFile } = await import('../src/scope-registry.ts')
    const registryDir = mkdtempSync(join(tmpdir(), `sg-relay-${scenario.id}-reg-`))
    const registryPath = join(registryDir, 'scopes.yaml')
    sandbox = buildK11Sandbox(scenario, registryPath)
    await new ScopeRegistryFile(registryPath).register({ id: K11_RELAY_SCOPE_ID, semanticRoot: sandbox.corpusRoot, name: K11_RELAY_SCOPE_ID, registeredBy: `relay-${scenario.id}` })
    console.log(`[relay]   sandbox: ${sandbox.dir} (own registry; the real ~/.semantic-grounding/scopes.yaml is untouched)`)
  } else {
    const { defaultRegistryPath, ScopeRegistryFile } = await import('../src/scope-registry.ts')
    const registryPath = defaultRegistryPath()
    const entry = new ScopeRegistryFile(registryPath).getEntry(X63_SCOPE_ID)
    if (entry === undefined) {
      throw new Error(`g3 leg: scope ${X63_SCOPE_ID} is not in the real registry (${registryPath}) — the X63-永测服 corpus must be registered on this machine first (see docs/relay-hitl.md)`)
    }
    g3Target = discoverG3Target(entry.semanticRoot)
    sandbox = buildX63Sandbox(scenario, registryPath, realpathSync(resolveLayerDir(entry.semanticRoot)))
    console.log(`[relay]   X63 scope ${X63_SCOPE_ID} at ${sandbox.corpusRoot}; G3′ target table: ${g3Target}`)
  }
  try {
    // ── A leg (the write) ──────────────────────────────────────────────────────
    const promptA = g3Target !== undefined ? withG3Target(scenario.promptA, g3Target) : scenario.promptA
    const aArgs = scenario.harnessA === 'claude'
      ? claudeArgs(sandbox.mcpA, promptA, opts.tight, process.env['SG_RELAY_CLAUDE_MODEL'])
      : qodercliArgs(sandbox.mcpA, promptA)
    console.log(`[relay]   A leg (${scenario.harnessA}) writing…`)
    const aRun = await runHost(scenario.harnessA, aArgs, sandbox.dir, join(sandbox.outDir, 'A.jsonl'), opts.timeoutMs)
    if (!aRun.ok) throw new Error(`A leg failed: ${aRun.error ?? 'unknown'}`)
    const l0 = judgeL0(scenario, sandbox.corpusRoot, sandbox.baseline, g3Target)
    console.log(`[relay]   L0 (commit+trailers on the corpus git): ${l0.pass ? 'PASS' : `FAIL — ${l0.error}`}`)
    for (const c of l0.commits) console.log(`[relay]     ${c.sha.slice(0, 7)} ${c.subject}`)

    // ── E3 control (ADR-0028 R4) ───────────────────────────────────────────────
    let control: ScenarioResult['control']
    if (scenario.controlPrompt !== undefined) {
      const question = scenario.questions[0]
      if (question === undefined) throw new Error('internal: control scenario without a question')
      let passed = 0
      for (let i = 1; i <= opts.controlRuns; i += 1) {
        const run = await askOnce(scenario.harnessB, scenario.controlPrompt, sandbox, opts, `ctrl-${i}`)
        const l2 = judgeAnswer(question, run.parsed.answer)
        const hit = run.ok && l2.pass
        if (hit) passed += 1
        console.log(`[relay]   control ${i}/${opts.controlRuns}: ${hit ? 'LEAK (answered correctly WITHOUT the concepts)' : 'ok (did not pass)'}${run.ok ? '' : ` [run error: ${run.error}]`}`)
      }
      control = { runs: opts.controlRuns, passed, valid: passed === 0 }
      if (passed > 0) console.log(`[relay]   control INVALID: ${passed}/${opts.controlRuns} passed pre-promotion — 换题 per ADR-0028 R4`)
    }

    // ── B legs (N runs × questions) ────────────────────────────────────────────
    const verdicts: RunVerdict[] = []
    let runPasses = 0
    let fixtureWritten: string | undefined
    for (let i = 1; i <= opts.runs; i += 1) {
      let runOk = true
      for (const question of scenario.questions) {
        const prompt = g3Target !== undefined ? withG3Target(question.prompt, g3Target) : question.prompt
        const run = await askOnce(scenario.harnessB, prompt, sandbox, opts, `B-${question.id}-${i}`)
        const l1 = judgeL1(scenario, run)
        const l2 = judgeAnswer(question, run.parsed.answer)
        const pass = run.ok && l1.pass && l2.pass
        if (!pass) runOk = false
        if (!run.ok && run.error !== undefined) console.log(`[relay]   run ${i} ${question.id}: HOST ERROR — ${run.error}`)
        console.log(`[relay]   run ${i}/${opts.runs} ${question.id}: L1=${l1.pass ? 'pass' : `FAIL(${l1.error})`} L2=${l2.pass ? 'pass' : `FAIL(${l2.misses.join('; ')})`} → ${pass ? 'PASS' : 'FAIL'}${run.parsed.costUsd !== undefined ? ` ($${run.parsed.costUsd.toFixed(4)})` : ''}`)
        verdicts.push({
          tag: `B-${question.id}-${i}`, host: scenario.harnessB, ok: run.ok, error: run.error,
          l1, l2: [{ question: question.id, pass: l2.pass, misses: l2.misses }],
          tools: run.parsed.sgCalls.map(c => c.name), answerExcerpt: run.parsed.answer.slice(0, 400),
          costUsd: run.parsed.costUsd, durationMs: run.durationMs, pass,
        })
        if (pass && fixtureWritten === undefined && question.id === scenario.questions[0]?.id) {
          // #156: freeze B's MCP request sequence from the first passing main-question run.
          mkdirSync(FIXTURE_DIR, { recursive: true })
          const fixturePath = join(FIXTURE_DIR, `${scenario.id}.json`)
          writeFileSync(fixturePath, `${JSON.stringify({
            scenario: scenario.id,
            corpus: scenario.corpus,
            recorded_from: `pnpm relay run ${new Date().toISOString()} (run ${i}, question ${question.id})`,
            scope_id: sandbox.scopeId,
            requests: run.parsed.sgCalls.map(c => ({ name: c.name, arguments: c.input })),
          }, null, 2)}\n`, 'utf8')
          fixtureWritten = fixturePath
          console.log(`[relay]   fixture recorded: ${fixturePath} (commit it — the e2e gate's replay leg goes live)`)
        }
      }
      if (runOk) runPasses += 1
    }

    // ── L3 (cross-host, one run over the main question) ────────────────────────
    let l3: RunVerdict | undefined
    if (!opts.skipL3) {
      const question = scenario.questions[0]
      if (question === undefined) throw new Error('internal: scenario without a question')
      const prompt = g3Target !== undefined ? withG3Target(question.prompt, g3Target) : question.prompt
      console.log(`[relay]   L3 cross-host leg (${scenario.harnessL3})…`)
      const run = await askOnce(scenario.harnessL3, prompt, sandbox, opts, 'L3')
      const l1 = judgeL1(scenario, run)
      const l2 = judgeAnswer(question, run.parsed.answer)
      const pass = run.ok && l1.pass && l2.pass
      console.log(`[relay]   L3: L1=${l1.pass ? 'pass' : `FAIL(${l1.error})`} L2=${l2.pass ? 'pass' : `FAIL(${l2.misses.join('; ')})`} → ${pass ? 'PASS' : 'FAIL'}`)
      l3 = {
        tag: 'L3', host: scenario.harnessL3, ok: run.ok, error: run.error, l1,
        l2: [{ question: question.id, pass: l2.pass, misses: l2.misses }],
        tools: run.parsed.sgCalls.map(c => c.name), answerExcerpt: run.parsed.answer.slice(0, 400),
        costUsd: run.parsed.costUsd, durationMs: run.durationMs, pass,
      }
    }

    const threshold = Math.ceil(opts.runs * 0.8)
    const controlValid = control?.valid ?? true
    const verdict: ScenarioResult['verdict'] = !controlValid
      ? 'INVALID (换题 — the control passed pre-promotion)'
      : l0.pass && runPasses >= threshold && (l3?.pass ?? false)
        ? 'PASS'
        : 'FAIL'
    return {
      scenario: scenario.id, card: scenario.card, corpus: scenario.corpus,
      ranAt: new Date().toISOString(), repoHead,
      l0: { pass: l0.pass, error: l0.error, commits: l0.commits },
      control,
      treatment: { runs: opts.runs, passed: runPasses, verdicts },
      l3,
      passRate: `${runPasses}/${opts.runs}`,
      threshold: `>=${threshold}/${opts.runs} (N=5 means >=4/5, #129)`,
      verdict,
      fixtureWritten,
    }
  } finally {
    if (opts.keep) console.log(`[relay]   --keep: sandbox retained at ${sandbox.dir}`)
    else sandbox.cleanup()
  }
}

// ── main ──────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2))
  console.log('[relay] semantic-grounding relay driver (#157/#156/#129) — opt-in, NEVER part of the four gates')
  console.log(`[relay] scenarios=${opts.scenarios.join(',')} runs=${opts.runs} controlRuns=${opts.controlRuns} skipL3=${opts.skipL3} tight=${opts.tight}`)
  const scenarios = opts.scenarios.map(id => relayScenario(id))
  preflight(scenarios, opts)

  // Lazy: everything under ../src resolves the substrate workspace dep to lib/.
  const { TOOL_NAMES } = await import('../src/tools/index.ts')
  sgToolNames = new Set(TOOL_NAMES)

  const repoHead = git(['rev-parse', 'HEAD'], REPO_ROOT).trim()
  const results: ScenarioResult[] = []
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, opts, repoHead))
  }

  mkdirSync(FIXTURE_DIR, { recursive: true })
  console.log('\n[relay] ── summary ──')
  let allPass = true
  for (const r of results) {
    console.log(`[relay] ${r.scenario}: ${r.verdict} (treatment ${r.passRate}, threshold ${r.threshold}; L0=${r.l0.pass ? 'pass' : 'FAIL'}${r.control !== undefined ? `; control ${r.control.passed}/${r.control.runs} leaked` : ''}${r.l3 !== undefined ? `; L3=${r.l3.pass ? 'pass' : 'FAIL'}` : ''})`)
    if (r.verdict !== 'PASS') allPass = false
    const resultPath = join(FIXTURE_DIR, `${r.scenario}-result.json`)
    writeFileSync(resultPath, `${JSON.stringify(r, null, 2)}\n`, 'utf8')
    console.log(`[relay]   result artifact: ${resultPath} (git-ignored — paste into #157)`)
  }
  console.log(`[relay] ${allPass ? 'ALL PASS' : 'NOT ALL PASS'} — repo HEAD ${repoHead}`)
  process.exitCode = allPass ? 0 : 1
}

main().catch((e: unknown) => {
  console.error(`[relay] FAILED: ${e instanceof Error ? e.message : String(e)}`)
  if (e instanceof Error && e.stack !== undefined) console.error(e.stack)
  process.exitCode = 1
})

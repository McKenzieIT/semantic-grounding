#!/usr/bin/env node
/**
 * The opt-in cross-agent relay driver (#157 / #156's ruling / #180's QoderWork +
 * qodercli rerouting) — Destination ④'s REAL measurement, which by ruling never
 * enters the four gates: it spends external-LLM money, it is nondeterministic,
 * and a 401 from an upstream gateway must not paint a gate red (#81's
 * environment-red-is-skipIf doctrine, inverted: don't put the environment in
 * the gate at all).
 *
 * ## What it runs (the three cards, per #156 / #180)
 *
 * | card | corpus | A harness | B harness | L0 (#156's per-card table) |
 * |---|---|---|---|---|
 * | E3 | k11 fixture COPY in a temp sandbox, own temp registry | `qodercli` (Efficient) | `qodercli` (Auto, N=5) | promotion commit carries only `X-SG-Evidence: source` |
 * | A3 | same k11-copy shape | `qodercli` (Efficient) | `qodercli` (Auto, N=5) | `record_memory` commit carries only `X-SG-Session` |
 * | G3′ | the REAL X63 scope `10000354` via the per-user registry | `qodercli` (Efficient) | `qodercli` (Auto, N=5) | `record_memory` (incident) carries only `X-SG-Session` |
 *
 * L3 is a **manual QoderWork run** on G3′ only (#180 R1/R3). The driver does
 * not spawn it; it prints a human-readable checklist at the end of the G3′
 * card that the operator runs inside QoderWork's GUI. The checklist is the
 * canonical evidence format (#180 R2). E3/A3 have no L3.
 *
 * E3 additionally runs ADR-0028 R4's 晋升前对照组: the same question against
 * the concept-free corpus must NOT pass — if it does, the scenario proves
 * nothing and the driver reports 换题 rather than a pass.
 *
 * ## Judging (#129's rubric, updated #179 + #180)
 *
 * - L0 (deterministic, on the corpus git): the commit, its trailers, and the
 *   landed content per card. This driver extracts commits + a corpus reader;
 *   `relay-scenarios.ts`'s `judgeL0` decides (#184 — the e2e stub calls the
 *   same judge).
 * - L1 (trajectory): B called at least one SG read tool (zero tool calls +
 *   correct answer = leak = fail). Per-question window assertion: a question
 *   that declares a `window` requires ≥1 read whose `data_window` fits
 *   inside the declared range and whose result omits the excluded memory id
 *   — the id A just wrote, bound by `bindWindowExclusion` before B runs.
 * - L2 (answer keywords, allOf/anyOf/negative from `relay-scenarios.ts`).
 * - N=5 B runs, pass ≥ ⌈0.8·N⌉ (#129).
 * - **Host-layer rejection** (e.g. `permission denied`, `approval required`)
 *   halts the run with an **environment error** rather than a FAIL (#180 R4).
 *   It is not counted in N=5 and does not deposit a fixture.
 *
 * ## Artifacts
 *
 * - `fixtures/relay/<id>.json` — B's recorded MCP request sequence from the
 *   first passing run (#156: this is exactly what the e2e gate's Phase 8
 *   replay leg consumes; until the first real run deposits it, that gate leg
 *   skips). COMMIT this file.
 * - `fixtures/relay/<id>-result.json` — the full result (pass rate, per-run
 *   trajectories, commit SHAs, credits). Git-ignored; paste into #157.
 *
 * ## Preflight fails loud, never silently skips
 *
 * Every leg names the CLI it needs and the artifact path it could not find.
 * Nothing degrades into "ran fewer scenarios than asked".
 *
 * Run: `pnpm relay [--scenario e3|a3|g3|all] [--runs N] [--control-runs N]
 * [--keep] [--purge <mem-id>[,…]]` — see `docs/relay-hitl.md` for the host-side
 * runbook.
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
  A_LEG_DEFAULT_MODEL,
  bindWindowExclusion,
  G3_TARGET_PLACEHOLDER,
  G3_WINDOW,
  hostRejectionOf,
  judgeAnswer,
  judgeL0,
  judgeL1,
  K11_RELAY_SCOPE_ID,
  relayScenario,
  X63_SCOPE_ID,
  type RelayCommit,
  type RelayCorpusReader,
  type RelayL0Result,
  type RelayRun,
  type RelaySgCall,
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
  readonly keep: boolean
  readonly tight: boolean
  readonly timeoutMs: number
  /** When non-empty, the driver runs --purge mode and exits: delete
   *  `memory/<id>.yaml` for each id, commit once. Guarded to only delete
   *  entries that match the G3′ card's incident signature. */
  readonly purgeIds: readonly string[]
}

function parseOptions(argv: readonly string[]): Options {
  const scenarios: ('e3' | 'a3' | 'g3')[] = []
  let runs = Number(process.env['SG_RELAY_RUNS'] ?? 5)
  let controlRuns = Number(process.env['SG_RELAY_CONTROL_RUNS'] ?? 3)
  let keep = false
  let tight = process.env['SG_RELAY_TIGHT'] !== '0'
  let timeoutMs = Number(process.env['SG_RELAY_TIMEOUT_MS'] ?? 300_000)
  let purgeIds: string[] = []
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
    } else if (arg === '--keep') {
      keep = true
    } else if (arg === '--purge') {
      const raw = argv[i + 1]
      if (raw === undefined || raw === '') throw new Error('--purge requires a comma-separated list of memory ids')
      purgeIds = raw.split(',').map(s => s.trim()).filter(s => s !== '')
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: pnpm relay [--scenario e3|a3|g3|all] [--runs N] [--control-runs N] [--keep] [--purge <mem-id>[,…]]\nenv: SG_RELAY_RUNS / SG_RELAY_CONTROL_RUNS / SG_RELAY_TIGHT / SG_RELAY_TIMEOUT_MS / SG_RELAY_QODERCLI / SG_RELAY_QODER_MODEL / SG_RELAY_QODER_FLAGS / SG_RELAY_G3_TARGET')
      process.exit(0)
    } else {
      throw new Error(`unknown flag: ${arg}`)
    }
  }
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer, got ${runs}`)
  if (!Number.isInteger(controlRuns) || controlRuns < 1) throw new Error(`--control-runs must be a positive integer, got ${controlRuns}`)
  return {
    scenarios: scenarios.length > 0 ? scenarios : ['e3', 'a3', 'g3'],
    runs, controlRuns, keep, tight, timeoutMs,
    purgeIds,
  }
}

/** The `qodercli` binary path (#180 — single harness now). Default lives
 *  outside PATH on the machines that have it; fall back to the bare name
 *  when the default absolute path does not exist. */
function resolveQodercliBinary(): string {
  const override = process.env['SG_RELAY_QODERCLI']
  if (override !== undefined) return override
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? ''
  const defaultPath = join(home, '.qoder', 'bin', 'qodercli', 'qodercli')
  if (existsSync(defaultPath)) return defaultPath
  return 'qodercli'
}

// ── Process plumbing ──────────────────────────────────────────────────────────────

/** One harness invocation's outcome. */
interface HostRun {
  readonly ok: boolean
  readonly parsed: RelayRun
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

/** Strip the host-specific MCP tool prefix from a raw tool name; returns the
 *  bare SG name when the call is SG, `undefined` otherwise. */
function stripPrefix(raw: string): string {
  for (const prefix of ['mcp__sg__', 'sg__', 'sg/']) {
    if (raw.startsWith(prefix)) return raw.slice(prefix.length)
  }
  return raw
}

/** Parse the `qodercli --output-format stream-json` stream (#180: the shape
 *  the probe on qodercli 1.1.28 matched — assistant/user events with
 *  `message.content[]` carrying `tool_use` and `tool_result` blocks, plus a
 *  terminal `result` event). Returns per-call results so the window
 *  assertion can see what each read returned (#179). */
function parseStream(raw: string): RelayRun {
  const calls = new Map<string, { name: string; input: Record<string, unknown>; resultText: string; isError: boolean }>()
  const orderedCalls: { name: string; input: Record<string, unknown>; resultText: string; isError: boolean }[] = []
  let trajectoryText = ''
  let answer = ''
  let lastAssistantText = ''
  let credits: number | undefined
  const consumeUse = (id: unknown, name: unknown, input: unknown): void => {
    if (typeof name !== 'string') return
    const args = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const entry = { name, input: args, resultText: '', isError: false }
    if (typeof id === 'string' && id !== '') calls.set(id, entry)
    orderedCalls.push(entry)
  }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let evt: Record<string, unknown>
    try {
      evt = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue // harnesses interleave non-JSON notices on stdout; stderr is kept separately
    }
    if (evt['type'] === 'assistant' || evt['type'] === 'user') {
      const message = evt['message'] as Record<string, unknown> | undefined
      const content = message?.['content']
      if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          const bType = block['type']
          if (bType === 'tool_use') {
            consumeUse(block['id'], block['name'], block['input'])
          } else if (bType === 'text' && typeof block['text'] === 'string') {
            trajectoryText += `${block['text']}\n`
            if (evt['type'] === 'assistant') lastAssistantText = block['text']
          } else if (bType === 'tool_result') {
            const toolId = block['tool_use_id']
            const c = block['content']
            const text = typeof c === 'string' ? c : JSON.stringify(c)
            const isError = block['is_error'] === true
            const entry = typeof toolId === 'string' ? calls.get(toolId) : undefined
            if (entry !== undefined) {
              entry.resultText = text
              entry.isError = isError
            } else {
              const last = orderedCalls[orderedCalls.length - 1]
              if (last !== undefined) {
                last.resultText = text
                last.isError = isError
              }
            }
            trajectoryText += `${text}\n`
          }
        }
      }
    } else if (evt['type'] === 'result') {
      if (typeof evt['result'] === 'string') answer = evt['result']
      // qodercli's total_cost_usd is always 0 (#180 R5) — read credits instead.
      if (typeof evt['total_credits'] === 'number') credits = evt['total_credits']
      else if (typeof evt['total_cost_usd'] === 'number') credits = evt['total_cost_usd']
    }
  }
  if (answer === '') answer = lastAssistantText
  const sgCalls: RelaySgCall[] = []
  for (const c of orderedCalls) {
    const bare = stripPrefix(c.name)
    if (sgToolNames === undefined) throw new Error('SG tool surface not loaded')
    if (!sgToolNames.has(bare)) continue
    sgCalls.push({ name: bare, input: c.input, resultText: c.resultText, isError: c.isError })
  }
  return { sgCalls, trajectoryText, answer, credits }
}

/** The mcp-config file a qodercli leg gets. */
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

/** Run one qodercli leg (stdin ignored — #129's pit #1: both CLIs hang waiting on a tty stdin). */
async function runHost(args: readonly string[], cwd: string, stdoutPath: string, timeoutMs: number): Promise<HostRun> {
  const bin = resolveQodercliBinary()
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

/** qodercli's flags (#156 measured them aligned with `claude -p`; #180 added
 *  `--permission-mode bypass_permissions` — without it, qodercli's default
 *  `acceptEdits` does not let MCP tool calls through, so L1 fails silently
 *  with tool_result.is_error=true on every SG call). `model` is per-leg:
 *  A defaults to Efficient (mechanical execution), B/control pass undefined
 *  to let qodercli's Auto pick (B is the measurement subject — lowering its
 *  tier would misattribute "model too weak" to "SG not useful"). */
function qodercliArgs(mcpConfig: string, prompt: string, model: string | undefined): string[] {
  const extra = (process.env['SG_RELAY_QODER_FLAGS'] ?? '').split(' ').filter(s => s !== '')
  const blanket = process.env['SG_RELAY_QODER_MODEL']
  const effective = blanket ?? model ?? 'Auto'
  return [
    '--print',
    '--permission-mode', 'bypass_permissions',
    '--output-format', 'stream-json',
    '--no-session-persistence',
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--model', effective,
    ...extra, prompt,
  ]
}

/** One B-side invocation. A and B differ only in the prompt + model tier. */
async function askOnce(prompt: string, sandbox: RelaySandbox, opts: Options, tag: string, model: string | undefined): Promise<HostRun> {
  const outPath = join(sandbox.outDir, `${tag}.jsonl`)
  return runHost(qodercliArgs(sandbox.mcpB, prompt, model), sandbox.dir, outPath, opts.timeoutMs)
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
  const corpusRoot = join(dir, 'corpus')
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
 * artifact: never a definition fingerprint, cleaned via `--purge <mem-id>`. */
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

// ── L0 extraction — the corpus git read for relay-scenarios' judgeL0 ─────────────

/** Read every commit since `baseline` with its full X-SG-* trailer map. */
function commitsSince(root: string, baseline: string): RelayCommit[] {
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

/** The corpus as `judgeL0` reads it: YAML/existence under the semantic-layer
 *  root, and the `memory/` paths a commit touched (git diff-tree). */
function corpusReader(root: string): RelayCorpusReader {
  return {
    yaml: rel => yaml.load(readFileSync(join(root, rel), 'utf8')),
    exists: rel => existsSync(join(root, rel)),
    memoryFilesOf: sha => git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha], root).trim().split('\n').filter(f => f.startsWith('memory/')),
  }
}

// ── Preflight ─────────────────────────────────────────────────────────────────────

/** Everything a leg declared it needs — surfaced as ONE actionable error the
 * moment it is missing (never a silent skip). */
function preflight(scenarios: readonly RelayScenario[], _opts: Options): void {
  const problems: string[] = []
  const substrateLib = join(REPO_ROOT, 'packages', 'substrate', 'lib', 'index.js')
  if (!existsSync(substrateLib)) {
    problems.push(`substrate not built (${substrateLib} missing) — run "pnpm -r build" first (CLAUDE.md: direct .ts runs resolve the workspace dep to lib/)`)
  }
  const bin = resolveQodercliBinary()
  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30_000 })
  if (probe.error !== undefined || probe.status !== 0) {
    problems.push(`qodercli leg: CLI not runnable ("${bin}" ${probe.error !== undefined ? probe.error.message : `exited ${probe.status}`}) — install it or point SG_RELAY_QODERCLI at the binary`)
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
  readonly ok: boolean
  readonly error: string | undefined
  /** True if this run was halted by a host-layer rejection (env error);
   *  such runs never count toward the pass-rate denominator (#180 R4). */
  readonly envError: boolean
  readonly l1: { readonly pass: boolean; readonly error: string | undefined }
  readonly l2: ReadonlyArray<{ readonly question: string; readonly pass: boolean; readonly misses: readonly string[] }>
  readonly tools: readonly string[]
  readonly answerExcerpt: string
  readonly credits: number | undefined
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
  readonly l0: { readonly pass: boolean; readonly error: string | undefined; readonly commits: RelayL0Result['commits']; readonly writtenMemoryIds: readonly string[] }
  readonly control: { readonly runs: number; readonly passed: number; readonly valid: boolean } | undefined
  /** `passed` counts ROUNDS (a round passes only when every question in it
   *  passes — that is what the N=5 threshold judges); `questionPasses`/`judged`
   *  count question-runs. For a 2-question card they are different units, so
   *  never render them as one fraction (#182). */
  readonly treatment: { readonly runs: number; readonly judged: number; readonly passed: number; readonly questionPasses: number; readonly envErrors: number; readonly verdicts: readonly RunVerdict[] }
  readonly manualL3: { readonly enabled: boolean; readonly scopeId: string; readonly corpusSha: string }
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

/** Print the manual L3 checklist (#180 R2): what the operator must do in
 *  QoderWork's GUI to produce the human-side evidence. */
function printManualL3Checklist(scenario: RelayScenario, g3Target: string | undefined, sandbox: RelaySandbox, corpusSha: string, writtenMemoryIds: readonly string[]): void {
  console.log(`\n[relay] === L3 manual checklist (${scenario.id}, QoderWork) ===`)
  console.log(`  1. 语料仓 commit SHA: ${corpusSha}`)
  console.log(`  2. 注册表 active scope: ${sandbox.scopeId}`)
  console.log(`  3. 用 QoderWork 开两个全新会话(A 一次、B 一次,不复用含 A 上下文的会话)。`)
  for (const question of scenario.questions) {
    const prompt = g3Target !== undefined ? withG3Target(question.prompt, g3Target) : question.prompt
    console.log(`  4. B 的 prompt (${question.id}):\n    ${prompt.split('\n').join('\n    ')}`)
    const window = bindWindowExclusion(question, writtenMemoryIds).window
    if (window !== undefined) {
      console.log(`     L1 窗口判据(与脚本 B 腿同一绑定,#184):须有一次读调用带 data_window ⊆ ${window.from}..${window.to},且该调用返回不含 memory ${window.excludeMemoryId || '(A 未写出 memory —— 排除断言无从绑定,先查 L0)'}`)
    }
  }
  console.log(`  5. 人工证据格式(写回 docs/relay-hitl.md §9,每条一次):`)
  console.log(`     - 语料仓 commit SHA + 当时注册表 active scope;`)
  console.log(`     - B 的 prompt 原文 + 最终回复原文;`)
  console.log(`     - SG 工具调用逐条:工具名、关键入参(尤其 data_window 的 from/to)、返回里是否出现锚定的 memory id;`)
  console.log(`     - L1 / L2 逐条判定,判据与脚本一致。`)
  console.log(`  6. 跑完最后一步清理(不自动执行): pnpm relay --purge <本回合写入的 mem-id>[,…]`)
  console.log(`     清理 §9 遗留的 mem-20261016-r6kgxn5a 也用同一口。`)
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
    // ── E3 control (ADR-0028 R4) ───────────────────────────────────────────────
    let control: ScenarioResult['control']
    if (scenario.controlPrompt !== undefined) {
      const question = scenario.questions[0]
      if (question === undefined) throw new Error('internal: control scenario without a question')
      let passed = 0
      for (let i = 1; i <= opts.controlRuns; i += 1) {
        const run = await askOnce(scenario.controlPrompt, sandbox, opts, `ctrl-${i}`, undefined)
        const l2 = judgeAnswer(question, run.parsed.answer)
        const hit = run.ok && l2.pass
        if (hit) passed += 1
        console.log(`[relay]   control ${i}/${opts.controlRuns}: ${hit ? 'LEAK (answered correctly WITHOUT the concepts)' : 'ok (did not pass)'}${run.ok ? '' : ` [run error: ${run.error}]`}`)
      }
      control = { runs: opts.controlRuns, passed, valid: passed === 0 }
      if (passed > 0) console.log(`[relay]   control INVALID: ${passed}/${opts.controlRuns} passed pre-promotion — 换题 per ADR-0028 R4`)
    }

    // ── A leg (the write) ──────────────────────────────────────────────────────
    const promptA = g3Target !== undefined ? withG3Target(scenario.promptA, g3Target) : scenario.promptA
    const aArgs = qodercliArgs(sandbox.mcpA, promptA, A_LEG_DEFAULT_MODEL)
    console.log(`[relay]   A leg (qodercli, model=${A_LEG_DEFAULT_MODEL}) writing…`)
    const aRun = await runHost(aArgs, sandbox.dir, join(sandbox.outDir, 'A.jsonl'), opts.timeoutMs)
    if (!aRun.ok) throw new Error(`A leg failed: ${aRun.error ?? 'unknown'}`)
    const l0 = judgeL0(scenario, commitsSince(sandbox.corpusRoot, sandbox.baseline), corpusReader(sandbox.corpusRoot), g3Target)
    console.log(`[relay]   L0 (commit+trailers on the corpus git): ${l0.pass ? 'PASS' : `FAIL — ${l0.error}`}`)
    for (const c of l0.commits) console.log(`[relay]     ${c.sha.slice(0, 7)} ${c.subject}`)
    if (l0.writtenMemoryIds.length > 0) {
      console.log(`[relay]   A wrote memory ids: ${l0.writtenMemoryIds.join(', ')} — pass these to \`--purge\` after the L3 manual run to clean the corpus.`)
    }

    // ── B legs (N runs × questions) ────────────────────────────────────────────
    const verdicts: RunVerdict[] = []
    let runPasses = 0
    let envErrors = 0
    let judged = 0
    let fixtureWritten: string | undefined
    for (let i = 1; i <= opts.runs; i += 1) {
      let runOk = true
      for (const cardQuestion of scenario.questions) {
        // The card leaves the window exclusion empty; bind A's memory id (#184 ruling 5).
        const question = bindWindowExclusion(cardQuestion, l0.writtenMemoryIds)
        const prompt = g3Target !== undefined ? withG3Target(question.prompt, g3Target) : question.prompt
        const run = await askOnce(prompt, sandbox, opts, `B-${question.id}-${i}`, undefined)
        // Host-layer rejection = environment error, never a FAIL (#180 R4).
        const rejection = hostRejectionOf(run.parsed)
        if (rejection !== undefined) {
          envErrors += 1
          verdicts.push({
            tag: `B-${question.id}-${i}`, ok: false, error: `host rejected ${rejection.tool}: ${rejection.text.slice(0, 200)}`,
            envError: true,
            l1: { pass: false, error: 'host rejection' },
            l2: [{ question: question.id, pass: false, misses: ['host rejection'] }],
            tools: [], answerExcerpt: '', credits: undefined, durationMs: run.durationMs, pass: false,
          })
          console.log(`[relay]   run ${i} ${question.id}: ENV ERROR — host rejected ${rejection.tool}: ${rejection.text.split('\n')[0]?.slice(0, 120) ?? ''}`)
          runOk = false
          continue
        }
        judged += 1
        const l1 = judgeL1(scenario, question, run.parsed)
        const l2 = judgeAnswer(question, run.parsed.answer)
        const pass = run.ok && l1.pass && l2.pass
        if (!pass) runOk = false
        if (!run.ok && run.error !== undefined) console.log(`[relay]   run ${i} ${question.id}: HOST ERROR — ${run.error}`)
        console.log(`[relay]   run ${i}/${opts.runs} ${question.id}: L1=${l1.pass ? 'pass' : `FAIL(${l1.error})`} L2=${l2.pass ? 'pass' : `FAIL(${l2.misses.join('; ')})`} → ${pass ? 'PASS' : 'FAIL'}${run.parsed.credits !== undefined ? ` (${run.parsed.credits.toFixed(3)} credits)` : ''}`)
        verdicts.push({
          tag: `B-${question.id}-${i}`, ok: run.ok, error: run.error,
          envError: false,
          l1, l2: [{ question: question.id, pass: l2.pass, misses: l2.misses }],
          tools: run.parsed.sgCalls.map(c => c.name), answerExcerpt: run.parsed.answer.slice(0, 400),
          credits: run.parsed.credits, durationMs: run.durationMs, pass,
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

    // ── L3: manual only ────────────────────────────────────────────────────────
    const corpusSha = git(['rev-parse', 'HEAD'], sandbox.corpusRoot).trim()
    if (scenario.l3Manual) {
      printManualL3Checklist(scenario, g3Target, sandbox, corpusSha, l0.writtenMemoryIds)
    } else {
      console.log(`[relay]   L3: not configured for this card (per #180 R3, only G3′ gets manual L3)`)
    }

    const threshold = Math.ceil(opts.runs * 0.8)
    const questionPasses = verdicts.filter(v => !v.envError && v.pass).length
    const controlValid = control?.valid ?? true
    const verdict: ScenarioResult['verdict'] = !controlValid
      ? 'INVALID (换题 — the control passed pre-promotion)'
      : l0.pass && runPasses >= threshold
        ? 'PASS'
        : 'FAIL'
    return {
      scenario: scenario.id, card: scenario.card, corpus: scenario.corpus,
      ranAt: new Date().toISOString(), repoHead,
      l0: { pass: l0.pass, error: l0.error, commits: l0.commits, writtenMemoryIds: l0.writtenMemoryIds },
      control,
      treatment: { runs: opts.runs, judged, passed: runPasses, questionPasses, envErrors, verdicts },
      manualL3: { enabled: scenario.l3Manual, scopeId: sandbox.scopeId, corpusSha },
      passRate: `${runPasses}/${opts.runs} rounds${scenario.questions.length > 1 ? ` (${questionPasses}/${judged} question-runs across ${scenario.questions.length} questions; a round passes only if every question does)` : ''} (env errors: ${envErrors})`,
      threshold: `>=${threshold}/${opts.runs} (N=5 means >=4/5, #129; env errors excluded)`,
      verdict,
      fixtureWritten,
    }
  } finally {
    if (opts.keep) console.log(`[relay]   --keep: sandbox retained at ${sandbox.dir}`)
    else sandbox.cleanup()
  }
}

// ── --purge mode ──────────────────────────────────────────────────────────────────

/** Verify one memory id matches the G3′ card's incident signature (type=incident,
 *  valid_from/valid_until = G3_WINDOW) before deleting. Returns a one-line
 *  reason if the entry does not match, `undefined` if it is safe to purge. */
function validatePurgeTarget(corpusRoot: string, id: string): string | undefined {
  const path = join(corpusRoot, 'memory', `${id}.yaml`)
  if (!existsSync(path)) return `memory/${id}.yaml not found in the corpus`
  const entry = yaml.load(readFileSync(path, 'utf8')) as Record<string, unknown>
  if (entry['type'] !== 'incident') return `memory/${id} is type=${String(entry['type'])}, not incident — only G3′ incident memories may be purged`
  if (entry['valid_from'] !== G3_WINDOW.from) return `memory/${id} valid_from=${String(entry['valid_from'])}, not ${G3_WINDOW.from}`
  if (entry['valid_until'] !== G3_WINDOW.to) return `memory/${id} valid_until=${String(entry['valid_until'])}, not ${G3_WINDOW.to}`
  return undefined
}

/** Run `--purge <ids>`: delete each memory/<id>.yaml and commit once. Guard
 *  = only delete entries matching the G3′ incident signature; refuses
 *  silently-bad ids rather than deleting them. */
async function runPurge(ids: readonly string[]): Promise<void> {
  console.log('[relay] --purge mode: deleting G3′ incident memories from the X63 corpus')
  const { defaultRegistryPath, ScopeRegistryFile } = await import('../src/scope-registry.ts')
  const registryPath = defaultRegistryPath()
  const entry = new ScopeRegistryFile(registryPath).getEntry(X63_SCOPE_ID)
  if (entry === undefined) {
    throw new Error(`--purge: scope ${X63_SCOPE_ID} is not in the real registry (${registryPath})`)
  }
  const corpusRoot = realpathSync(resolveLayerDir(entry.semanticRoot))
  const deleted: string[] = []
  for (const id of ids) {
    const reason = validatePurgeTarget(corpusRoot, id)
    if (reason !== undefined) {
      console.log(`[relay]   skip ${id}: ${reason}`)
      continue
    }
    const path = join(corpusRoot, 'memory', `${id}.yaml`)
    rmSync(path)
    deleted.push(id)
  }
  if (deleted.length === 0) {
    console.log('[relay]   nothing to delete')
    return
  }
  const baseline = git(['rev-parse', 'HEAD'], corpusRoot).trim()
  git(['add', '-A'], corpusRoot)
  git(['commit', '--quiet', '-m', `relay: purge ${deleted.length} incident memory(ies) after manual L3`,
    `--author=relay-purge <relay-purge@relay.invalid>`], corpusRoot)
  const head = git(['rev-parse', 'HEAD'], corpusRoot).trim()
  console.log(`[relay]   deleted ${deleted.length}: ${deleted.join(', ')}`)
  console.log(`[relay]   commit ${head.slice(0, 7)} (baseline ${baseline.slice(0, 7)})`)
}

// ── main ──────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2))
  console.log('[relay] semantic-grounding relay driver (#157/#156/#180) — opt-in, NEVER part of the four gates')
  console.log(`[relay] scenarios=${opts.scenarios.join(',')} runs=${opts.runs} controlRuns=${opts.controlRuns} keep=${opts.keep} purgeIds=${opts.purgeIds.length}`)

  // Lazy: everything under ../src resolves the substrate workspace dep to lib/.
  const { TOOL_NAMES } = await import('../src/tools/index.ts')
  sgToolNames = new Set(TOOL_NAMES)

  if (opts.purgeIds.length > 0) {
    await runPurge(opts.purgeIds)
    return
  }

  const scenarios = opts.scenarios.map(id => relayScenario(id))
  preflight(scenarios, opts)

  const repoHead = git(['rev-parse', 'HEAD'], REPO_ROOT).trim()
  const results: ScenarioResult[] = []
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, opts, repoHead))
  }

  mkdirSync(FIXTURE_DIR, { recursive: true })
  console.log('\n[relay] ── summary ──')
  let allPass = true
  for (const r of results) {
    console.log(`[relay] ${r.scenario}: ${r.verdict} (treatment ${r.passRate}, threshold ${r.threshold}; L0=${r.l0.pass ? 'pass' : 'FAIL'}${r.control !== undefined ? `; control ${r.control.passed}/${r.control.runs} leaked` : ''})`)
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

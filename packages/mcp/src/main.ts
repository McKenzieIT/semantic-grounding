/**
 * The executable's startup sequence ([#22](https://github.com/McKenzieIT/semantic-grounding/issues/22)).
 *
 * ## Everything that can refuse, refuses before the transport is connected
 *
 * ADR-0004 rulings 5, 6 and 9 all refuse *startup* rather than a write, and the ticket
 * asks for the same ("不要等到第一次工具调用才发现"). Three measurements make that a hard
 * requirement rather than a preference. If a posture refusal were raised from inside the
 * `serveStdio` factory instead:
 *
 * - the error is **swallowed**: the client receives a canned
 *   `-32603 "Internal server error"` and the refusal's own message — which carries the
 *   remedy — reaches only the `onerror` sink;
 * - the process exits **0**, so a supervisor or CI step sees success;
 * - the factory is **retried on every inbound request**, forever, because a throwing
 *   factory never pins an instance. Each retry would re-attempt the corpus load and the
 *   git lock.
 *
 * So the whole sequence below runs to completion first, and a refusal is an exit with a
 * non-zero code and a message on stderr. Measured: zero bytes on stdout in that path,
 * which matters because stdout is the JSON-RPC channel — a client that reads a diagnostic
 * there reports a parse error rather than the refusal.
 *
 * ## Exit codes
 *
 * `sysexits.h` values, so a wrapper script or CI step can tell the two failure classes
 * apart without parsing text: **64** (`EX_USAGE`) means the invocation is wrong — an
 * unknown flag, a missing `--corpus`, a malformed timeout; **78** (`EX_CONFIG`) means the
 * invocation was understood but the deployment is not serviceable — not a git repository,
 * not the repository root, a dirty worktree, an agent id git cannot use. The first is
 * fixed in the MCP client's registration, the second in the corpus or the environment.
 * **1** is reserved for a fault that is this server's own bug.
 *
 * @module main
 */
import { SemanticGroundingCore } from '@semantic-grounding/substrate'
import {
  ConfigError,
  HelpRequested,
  parseServerConfig,
  usage,
  type ServerConfig,
} from './config.ts'
import { SgApplicationError } from './errors.ts'
import { requireAgentId } from './git/identity.ts'
import { ensureStartupPosture, type PostureReport } from './git/posture.ts'
import { GitTier2Recorder } from './git/recorder.ts'
import { serve, SERVER_INFO, TOOL_REGISTRARS, type ServeOptions, type ServerDeps } from './server.ts'

/** Process exit codes; see this module's header for why these values. */
export const EXIT = {
  /** Nothing went wrong (`--help`). */
  ok: 0,
  /** A fault in this server rather than its inputs. */
  internal: 1,
  /** `EX_USAGE` — the invocation is malformed. */
  usage: 64,
  /** `EX_CONFIG` — the invocation parsed, but the corpus or identity is not serviceable. */
  config: 78,
} as const

/**
 * What {@link runMain} decided.
 *
 * A discriminated result rather than a bare exit code, because "now serving" is not an
 * exit status: the process must stay alive, held open by stdin, until the client closes
 * it. Collapsing that into `0` would make it indistinguishable from `--help`, and the
 * caller would exit out of a healthy server.
 */
export type MainOutcome =
  /** Startup succeeded and the transport is connected. The caller must NOT exit. */
  | { readonly kind: 'serving' }
  /** Startup ended. The caller should exit with `code`. */
  | { readonly kind: 'exit'; readonly code: number }

/** A writer for diagnostics. Always stderr in production; captured in tests. */
export type Log = (message: string) => void

/** Default log sink: stderr, one line at a time, never stdout. */
export const stderrLog: Log = message => {
  process.stderr.write(`${message}\n`)
}

/** What {@link startup} built. */
export interface StartupResult {
  /** The dependencies to hand {@link serve}. */
  readonly deps: ServerDeps
  /** What the posture check found and did (ADR-0004 ruling 6). */
  readonly report: PostureReport
}

/**
 * Run every check and build every collaborator, in the only order that works.
 *
 * The ordering is load-bearing, not stylistic:
 *
 * 1. **Identity before posture**, because `ensureStartupPosture` writes the agent id into
 *    any lock record it inspects or breaks — an unvalidated id would reach the lock file.
 *    It is also the cheapest check, so a typo fails without touching the repository.
 * 2. **Posture before the recorder**, so the recorder is constructed with `paths` already
 *    resolved. Its constructor is synchronous and otherwise has to guess the git dir as
 *    `<corpusRoot>/.git`; handing it the posture report's resolved paths skips the guess,
 *    which is what makes a linked worktree (where `.git` is a file) correct from
 *    construction rather than from the first `ready()`.
 * 3. **Recorder before the core**, because D5 (ADR-0001) means a core without a recorder
 *    throws on every auditable write. There is no window here in which the core exists and
 *    cannot audit.
 * @param config - the validated configuration.
 * @param log - sink for the posture check's loud recovery notice (ruling 6).
 * @returns the dependencies and the posture report.
 * @throws SgApplicationError for every refusal ADR-0004 rules — identity missing or
 *   unusable, corpus not a repository root, worktree dirty and not recoverable residue.
 */
export async function startup(config: ServerConfig, log: Log = stderrLog): Promise<StartupResult> {
  const agentId = requireAgentId(config.agentId)
  const lock = config.lockTimeoutMs !== undefined ? { timeoutMs: config.lockTimeoutMs } : {}

  const report = await ensureStartupPosture({ corpusRoot: config.corpusRoot, agentId, lock, logger: log })

  const recorder = new GitTier2Recorder({
    corpusRoot: config.corpusRoot,
    agentId,
    paths: report.paths,
    lock,
    ...config.scopeId !== undefined ? { scopeId: config.scopeId } : {},
  })
  await recorder.ready()

  // One value, two roles: see `ServerConfig.corpusRoot`. `autoEnrich` is left at its
  // default (true) deliberately — ADR-0004's 2026-10-09 update ruled that the derived
  // content the on-write hook produces gets its own `deterministic` commit rather than
  // being suppressed, so turning the hook off here would trade an honest second commit for
  // a corpus that silently stops deriving joins.
  const core = new SemanticGroundingCore({
    semanticRoot: config.corpusRoot,
    ...config.scopeId !== undefined ? { scopeId: config.scopeId } : {},
  })
  core.setTier2Recorder(recorder)

  return { deps: { core, recorder, config }, report }
}

/**
 * The startup banner, written to stderr before serving.
 *
 * Not decoration. Under an MCP client the server has no console of its own, no request log
 * an operator can see, and a tool list that is legitimately empty at this stage — so "did
 * it start, against which corpus, as whom" is otherwise unanswerable from the host side.
 * Printing the resolved corpus root and the derived commit author is what makes a wrong
 * `--corpus` or a surprising author visible at startup instead of in `git log` a week
 * later. It also states the tool count, so a client showing zero tools is confirmed rather
 * than suspected.
 * @param result - what {@link startup} produced.
 * @param registrars - the registrars about to be installed.
 * @returns the banner lines.
 */
export function startupBanner(result: StartupResult, registrars: readonly unknown[]): string[] {
  const { deps, report } = result
  const author = deps.recorder.authorIdentity
  const tools = registrars.length === 0
    ? '0 (skeleton — intent tools land in #20/#21)'
    : `${registrars.length} registrar(s)`
  return [
    `[semantic-grounding] ${SERVER_INFO.name} ${SERVER_INFO.version} serving MCP over stdio`,
    `[semantic-grounding]   corpus:    ${report.paths.toplevel}`,
    `[semantic-grounding]   posture:   ${report.posture}`,
    `[semantic-grounding]   agent:     ${deps.config.agentId}`,
    `[semantic-grounding]   author:    ${author.name} <${author.email}>`,
    `[semantic-grounding]   committer: ${deps.recorder.committerIdentity.name}`,
    `[semantic-grounding]   scope:     ${deps.config.scopeId ?? '(none — no X-SG-Scope trailer)'}`,
    `[semantic-grounding]   tools:     ${tools}`,
  ]
}

/**
 * Parse, validate, construct, and start serving.
 * @param argv - arguments after the script name (`process.argv.slice(2)`).
 * @param env - the process environment.
 * @param log - sink for diagnostics (stderr in production).
 * @param opts - serve options, for tests that supply their own transport or registrars.
 * @returns `{kind:'serving'}` once the transport is connected, or `{kind:'exit', code}`
 *   for help and every refusal. See {@link MainOutcome}.
 */
export async function runMain(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: Log = stderrLog,
  opts: ServeOptions = {},
): Promise<MainOutcome> {
  let config: ServerConfig
  try {
    config = parseServerConfig(argv, env)
  } catch (e) {
    if (e instanceof HelpRequested) {
      log(e.usage)
      return { kind: 'exit', code: EXIT.ok }
    }
    if (e instanceof ConfigError) {
      log(`[semantic-grounding] ${e.message}`)
      log('')
      log(usage())
      return { kind: 'exit', code: EXIT.usage }
    }
    throw e
  }

  let result: StartupResult
  try {
    result = await startup(config, log)
  } catch (e) {
    if (e instanceof SgApplicationError) {
      // The coded refusals: identity_missing (−31005) and posture_refused (−31004). Their
      // messages already carry the remedy, which is the whole point of refusing at startup
      // — the operator gets the fix, not just the symptom.
      log(`[semantic-grounding] refusing to start: ${e.message}`)
      return { kind: 'exit', code: EXIT.config }
    }
    throw e
  }

  const registrars = opts.registrars ?? TOOL_REGISTRARS
  for (const line of startupBanner(result, registrars)) log(line)

  serve(result.deps, opts)

  // Released when the event loop drains, which happens after the client closes stdin and
  // the transport fires its own `onclose`. Deliberately NOT hung off the server instance's
  // `onclose`: with `legacy: 'serve'` the factory can run twice (the `server/discover`
  // probe instance is closed when a client falls back to `initialize`), so disposing the
  // shared core there would hand the second, real instance a disposed core. `dispose()` is
  // idempotent, and `once` keeps a re-entrant `beforeExit` from mattering either way.
  process.once('beforeExit', () => {
    result.deps.core.dispose()
  })

  return { kind: 'serving' }
}

/**
 * The executable's startup sequence ([#22](https://github.com/McKenzieIT/semantic-grounding/issues/22);
 * re-ruled by ADR-0011, [#51](https://github.com/McKenzieIT/semantic-grounding/issues/51)).
 *
 * ## Everything that can refuse, refuses before the transport is connected
 *
 * ADR-0004 rulings 5, 6 and 9 all refuse *startup* rather than a write, and the
 * 2026-10-11 measurements behind ADR-0011 ruling 1 keep that property under the
 * new binding model: posture for an eagerly bound `--scope` runs here, in full,
 * before `serve()`. If it were raised from inside the `serveStdio` factory
 * instead:
 *
 * - the error is **swallowed**: the client receives a canned
 *   `-32603 "Internal server error"` and the refusal's own message — which carries
 *   the remedy — reaches only the `onerror` sink;
 * - the process exits **0**, so a supervisor or CI step sees success;
 * - the factory is **retried on every inbound request**, forever, because a throwing
 *   factory never pins an instance.
 *
 * ## What startup builds now
 *
 * No corpus is known at startup anymore (ruling 3 deleted `--corpus`): startup
 * builds the **registry** and the **binding store**, then binds at most one scope —
 * eagerly for `--scope` (refusing the process, exit 78, when it will not serve:
 * unknown id or failed posture both keep the fail-fast contract), or by restoring
 * the registry's `active:` default, which *degrades* instead of refusing (a stale
 * default is a convenience that went bad, not an operator demand; the management
 * tools still work and the first definition-tool call says `no_active_scope` with
 * its remedy). Scopes bound later arrive through `switch_scope`, whose lazy
 * construction and pointer swap live in `binding.ts`.
 *
 * ## Exit codes
 *
 * `sysexits.h` values, so a wrapper script or CI step can tell the two failure classes
 * apart without parsing text: **64** (`EX_USAGE`) means the invocation is wrong — an
 * unknown flag (including the removed `--corpus`), a missing `--agent-id`, a malformed
 * timeout; **78** (`EX_CONFIG`) means the invocation was understood but the deployment
 * is not serviceable — `--scope` naming an unregistered id, or a scope whose corpus
 * fails posture. The first is fixed in the MCP client's registration, the second in
 * the registry or the corpus. **1** is reserved for a fault that is this server's own
 * bug.
 *
 * @module main
 */
import {
  ConfigError,
  HelpRequested,
  parseServerConfig,
  usage,
  type ServerConfig,
} from './config.ts'
import { SgApplicationError } from './errors.ts'
import { requireAgentId } from './git/identity.ts'
import { BindingStore, type ScopeBinding } from './binding.ts'
import { ScopeRegistryFile } from './scope-registry.ts'
import { serve, SERVER_INFO, TOOL_REGISTRARS, type ServeOptions, type ServerDeps } from './server.ts'
import { TOOL_NAMES } from './tools/index.ts'

/** Process exit codes; see this module's header for why these values. */
export const EXIT = {
  /** Nothing went wrong (`--help`). */
  ok: 0,
  /** A fault in this server rather than its inputs. */
  internal: 1,
  /** `EX_USAGE` — the invocation is malformed. */
  usage: 64,
  /** `EX_CONFIG` — the invocation parsed, but the named scope or identity is not serviceable. */
  config: 78,
} as const

/**
 * What {@link runMain} decided.
 *
 * A discriminated result rather than a bare exit code, because "now serving" is not
 * an exit status: the process must stay alive, held open by stdin, until the client closes
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
  /**
   * The scope bound at startup — the `--scope` eager bind, or the registry's
   * `active:` default when it restored successfully. Undefined means serving with
   * no active scope (definition tools answer `no_active_scope` with their remedy).
   */
  readonly boot: ScopeBinding | undefined
}

/**
 * Run every check and build every collaborator, in the only order that works.
 *
 * The ordering is load-bearing, not stylistic:
 *
 * 1. **Identity before anything else**, because `ensureStartupPosture` writes the
 *    agent id into any lock record it inspects or breaks — an unvalidated id would
 *    reach the lock file. It is also the cheapest check, so a typo fails without
 *    touching the registry or any repository.
 * 2. **Registry before bindings**, because every binding path (eager `--scope`,
 *    default restore, later `switch_scope`) looks ids up in it.
 * 3. **Binding before serving**, so an eagerly demanded scope has its posture
 *    refusal raised here — before the transport exists to swallow it (see the
 *    module header).
 * @param config - the validated configuration.
 * @param log - sink for the posture check's loud recovery notice (ruling 6) and the
 *   degraded-default notice.
 * @returns the dependencies and the startup binding, if one was made.
 * @throws SgApplicationError for every refusal ADR-0004/0011 rule at startup —
 *   identity missing or unusable (exit 64/78 by class in {@link runMain}), or, for
 *   `--scope` only: unknown id / corpus not a serviceable repository root (exit 78).
 */
export async function startup(config: ServerConfig, log: Log = stderrLog): Promise<StartupResult> {
  const agentId = requireAgentId(config.agentId)
  const lock = config.lockTimeoutMs !== undefined ? { timeoutMs: config.lockTimeoutMs } : {}

  const registry = new ScopeRegistryFile(config.registryPath, config.lockTimeoutMs !== undefined ? { lockTimeoutMs: config.lockTimeoutMs } : {})
  const bindings = new BindingStore({ registry, agentId, lock, logger: log })

  // --scope is an operator demand: refuse the process when it will not serve.
  // No flag: restore the registry default, degrading to "no active scope" — a
  // stale convenience must not kill a server whose management tools still work.
  const boot = config.scopeId !== undefined
    ? await bindings.bindStartup(config.scopeId)
    : await bindings.restoreActive()

  return { deps: { registry, bindings, config }, boot }
}

/**
 * The startup banner, written to stderr before serving.
 *
 * Not decoration. Under an MCP client the server has no console of its own, no request log
 * an operator can see, and a legitimately-small tool list — so "did it start, against
 * which registry, bound to which scope, as whom" is otherwise unanswerable from the host
 * side. Printing the resolved registry path and the bound scope (or the explicit absence
 * of one) is what makes a wrong `--registry` or a surprising restore visible at startup
 * instead of in `git log` a week later. It also states the tool count, so a client showing
 * zero tools is confirmed rather than suspected.
 * @param result - what {@link startup} produced.
 * @param toolCount - how many tools the surface about to be served installs.
 * @returns the banner lines.
 */
export function startupBanner(result: StartupResult, toolCount: number): string[] {
  const { deps, boot } = result
  const tools = toolCount === 0
    ? '0 (skeleton)'
    : `${toolCount}`
  return [
    `[semantic-grounding] ${SERVER_INFO.name} ${SERVER_INFO.version} serving MCP over stdio`,
    `[semantic-grounding]   registry:  ${deps.config.registryPath}`,
    boot !== undefined
      ? `[semantic-grounding]   scope:     ${boot.scopeId} -> ${boot.semanticRoot}`
      : '[semantic-grounding]   scope:     (none — definition tools answer no_active_scope until switch_scope)',
    `[semantic-grounding]   agent:     ${deps.config.agentId}`,
    ...(boot !== undefined ? [
      `[semantic-grounding]   author:    ${boot.recorder.authorIdentity.name} <${boot.recorder.authorIdentity.email}>`,
      `[semantic-grounding]   committer: ${boot.recorder.committerIdentity.name}`,
    ] : []),
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
      // The coded refusals at startup: identity_missing (−31005) and posture_refused
      // (−31004) from #19's segment, plus ADR-0011's scope_not_found (−31061) for a
      // `--scope` the registry has never seen. Their messages already carry the
      // remedy, which is the whole point of refusing at startup — the operator gets
      // the fix, not just the symptom.
      log(`[semantic-grounding] refusing to start: ${e.message}`)
      return { kind: 'exit', code: EXIT.config }
    }
    throw e
  }

  const registrars = opts.registrars ?? TOOL_REGISTRARS
  // The banner reports tools, not registrar functions (#115): the default face
  // counts `TOOL_NAMES`; a custom face states its own count via `opts.toolCount`,
  // because a registrar list does not reveal how many tools it installs.
  for (const line of startupBanner(result, opts.toolCount ?? TOOL_NAMES.length)) log(line)

  serve(result.deps, opts)

  // Released when the event loop drains, which happens after the client closes stdin and
  // the transport fires its own `onclose`. Deliberately NOT hung off the server instance's
  // `onclose`: with `legacy: 'serve'` the factory can run twice (the `server/discover`
  // probe instance is closed when a client falls back to `initialize`), so disposing the
  // shared bindings there would hand the second, real instance disposed cores.
  // `disposeAll()` is idempotent, and `once` keeps a re-entrant `beforeExit` from
  // mattering either way. Per ADR-0011 ruling 1 this is the ONLY disposal moment:
  // switched-away bindings stay alive precisely so straddling requests cannot hold a
  // disposed object.
  process.once('beforeExit', () => {
    result.deps.bindings.disposeAll()
  })

  return { kind: 'serving' }
}

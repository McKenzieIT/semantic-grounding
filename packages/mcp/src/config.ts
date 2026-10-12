/**
 * The server's configuration surface — how the agent identity, the registry
 * location and the lock tuning reach the process
 * ([#22](https://github.com/McKenzieIT/semantic-grounding/issues/22); the flag
 * surface was re-ruled by ADR-0011 ruling 3, [#51](https://github.com/McKenzieIT/semantic-grounding/issues/51)).
 *
 * ## Why flags and environment variables, and not a config file
 *
 * ADR-0004 ruling 9 already settled the shape for the load-bearing value. Identity comes
 * from the **startup channel**, because under stdio the `command` / `args` / `env` an MCP
 * client registers is the only configuration channel that exists, and because a
 * corpus-level config file cannot express identity at all: two processes over one corpus
 * may be two different agents, and the file is per-corpus. Once `--agent-id` has to be a
 * flag, giving the registry path and lock timeout a *different* carrier buys nothing and
 * costs a second place to look.
 *
 * **Both flags and environment variables, flag wins.** ADR-0005 ruling 4 argues against
 * two doors ("双门即双险") — but that is about two *write paths to the corpus*, where the
 * second door lets a caller bypass the first one's defences. Config input has no such
 * asymmetry: the two carriers produce the same validated {@link ServerConfig} through the
 * same checks, so the only cost is a precedence rule, stated once here and tested. The
 * benefit is concrete and was the deciding input: the dogfood host is **QoderWork and
 * peer office agents**, not Claude Code, and we cannot verify today whether their MCP
 * registration UI exposes `args`, `env`, or both. A server that can only be configured
 * through the one channel a host happens not to offer is unusable for a reason the
 * operator cannot see.
 *
 * ## ADR-0011's re-ruling: no `--corpus`, four flags total
 *
 * `--corpus` named a corpus at the command line; `register_scope` names one as a tool
 * call. Two doors into one table is the exact shape ruling 4 refuses, and #45's ROI
 *盘点 found the compat matrix protecting nobody (e2e was going to be rewritten anyway,
 * dogfood re-registers once, CI does not exist). The surface is now:
 * `--agent-id` (required) · `--scope <id>` (optional eager bind) · `--registry <path>`
 * (optional, default `~/.semantic-grounding/scopes.yaml`) · `--lock-timeout-ms`. The
 * bootstrap door for a new corpus is the `register_scope` **tool**, full stop; posture
 * checks moved to the three binding moments (register / switch / `--scope`).
 *
 * ## What is deliberately not configurable
 *
 * - **Protocol era.** `legacy: 'serve'` is fixed, not a flag — see `server.ts`. v1 has no
 *   known need to refuse 2025-era clients, and an unused knob is a tested branch that
 *   earns nothing.
 * - **Lock poll / heartbeat / staleness.** ADR-0004 ruling 7 says the *timeout* is
 *   configurable ("默认 10s 量级可配"); the other three are tuned against each other in
 *   `lock.ts` (a 2s heartbeat against a 15s staleness window), so exposing them
 *   individually invites a combination that misjudges a live holder as dead.
 * - **A default scope id.** There is none (ADR-0011 constant 6): the registry's `active:`
 *   is the next process's default, an agent's `switch_scope` is the live one, and a
 *   command-line guess would be a third notion of "current" with no owner.
 *
 * @module config
 */
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { defaultRegistryPath } from './scope-registry.ts'
import type { GuidanceThresholds } from './tools/guidance.ts'

/** The executable's name, as it appears in usage text and error remedies. */
export const BIN_NAME = 'sg-mcp'

/**
 * Environment variable names, paired with the flag each one backs.
 *
 * Exported because the error messages name both carriers — an operator who set the
 * environment variable should not be told to pass a flag they cannot reach.
 */
export const ENV_VARS = {
  registry: 'SG_REGISTRY',
  agentId: 'SG_AGENT_ID',
  scope: 'SG_SCOPE',
  lockTimeoutMs: 'SG_LOCK_TIMEOUT_MS',
} as const

/** The validated startup configuration. */
export interface ServerConfig {
  /**
   * The scope registry file this process reads and writes, resolved to an absolute
   * path (default `~/.semantic-grounding/scopes.yaml`, ADR-0011 ruling 2).
   *
   * `--registry` / `SG_REGISTRY` exist primarily as **test/e2e isolation** — a gate
   * that runs the real `startup()` must never touch a real home directory — and
   * secondarily as an escape hatch for operators running isolated fleets.
   */
  readonly registryPath: string
  /** The writing agent, recorded as the commit author (ADR-0004 ruling 9). */
  readonly agentId: string
  /**
   * A scope to bind eagerly at startup, looked up in the registry with posture
   * re-checked; a refusal is an exit-78 (ADR-0011 ruling 4). Absent means the
   * registry's `active:` default is restored instead — degrading to "no active
   * scope" rather than exiting when it will not serve.
   */
  readonly scopeId?: string
  /** Corpus-lock acquisition timeout; absent means `lock.ts`'s 10s default. */
  readonly lockTimeoutMs?: number
  /**
   * Per-layer `_guidance` maturity thresholds (`tools/guidance.ts`): DW (tables +
   * events) and KG (concepts) track independently (#55 R4/R12), each reaching
   * `mature` at its own count. An absent side defaults to that module's
   * `DEFAULT_DW_THRESHOLD` (50) / `DEFAULT_KG_THRESHOLD` (5). No flag/env var:
   * ADR-0011 ruling 3 closed the CLI surface at four flags, and neither #55 nor
   * #56 asks for one — reachable today via `ServerConfig` construction (tests, a
   * future embedding host), not via the `sg-mcp` binary's argv.
   */
  readonly guidanceThreshold?: GuidanceThresholds
}

/**
 * A configuration input the server cannot start from.
 *
 * Deliberately **not** an `SgApplicationError`: that base class exists to carry a
 * JSON-RPC error code to a `tools/call` response, and a config error is raised before the
 * transport is connected, so it never reaches the wire. This is also why #22 needs no
 * slice of the `-31xxx` space that `errors.ts` partitions — its failures are process
 * exits, not protocol responses.
 *
 * Carries a `remedy` for the same reason {@link import('./errors.ts').PostureRefusedError}
 * does: refusing without saying what to run is how an operator concludes the tool is
 * broken rather than the invocation.
 */
export class ConfigError extends Error {
  /** The concrete flag, variable or value that resolves the refusal. */
  readonly remedy: string

  /**
   * @param message - what was wrong with the configuration.
   * @param remedy - the concrete change that fixes it.
   */
  constructor(message: string, remedy: string) {
    super(`${message} — ${remedy}`)
    this.name = new.target.name
    this.remedy = remedy
  }
}

/** Raised by {@link parseServerConfig} when `--help` was asked for. */
export class HelpRequested extends Error {
  /** The usage text to print. */
  readonly usage: string

  /**
   * @param usage - the text to write to stderr before exiting 0.
   */
  constructor(usage: string) {
    super('help requested')
    this.name = new.target.name
    this.usage = usage
  }
}

/** The flags {@link parseServerConfig} accepts, in `node:util` `parseArgs` form. */
const OPTIONS = {
  registry: { type: 'string' },
  'agent-id': { type: 'string' },
  scope: { type: 'string' },
  'lock-timeout-ms': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const

/**
 * Usage text, printed for `--help` and alongside every {@link ConfigError}.
 *
 * One string serves both so a mis-registered server teaches the operator its surface at
 * the moment they see the failure, rather than requiring a second, successful invocation
 * to discover it.
 * @returns the usage text, newline-terminated.
 */
export function usage(): string {
  return [
    `${BIN_NAME} — MCP server exposing semantic-grounding scopes to a working agent.`,
    '',
    'Every Tier-2 write becomes a git commit in the scope\'s corpus repository, authored',
    'by the declared agent (ADR-0004). Speaks MCP over stdio; stdout carries JSON-RPC',
    'only, and every diagnostic goes to stderr.',
    '',
    `usage: ${BIN_NAME} --agent-id <id> [options]`,
    '',
    'required:',
    `  --agent-id <id>          The writing agent, recorded as the commit author. No`,
    `                           default: a defaulted author is not an audit trail.`,
    `                           env: ${ENV_VARS.agentId}`,
    '',
    'optional:',
    `  --scope <id>             Bind this scope eagerly at startup: looked up in the`,
    `                           registry with posture re-checked; unusable = exit 78.`,
    `                           Without it the registry's active: default is restored,`,
    `                           and failing that the server serves with no active scope`,
    `                           (definition tools answer no_active_scope).`,
    `                           env: ${ENV_VARS.scope}`,
    `  --registry <path>        The scope registry file (default`,
    `                           ~/.semantic-grounding/scopes.yaml). Also test/e2e`,
    `                           isolation. env: ${ENV_VARS.registry}`,
    `  --lock-timeout-ms <n>    How long a write waits for the corpus lock before failing`,
    `                           (positive integer, default 10000).`,
    `                           env: ${ENV_VARS.lockTimeoutMs}`,
    `  -h, --help               Print this text.`,
    '',
    'A flag always wins over its environment variable.',
    '',
    'There is no --corpus: a new corpus enters through the register_scope tool (the',
    'get_scope_scaffold tool lays out the shell first if nothing exists yet).',
    '',
    'example MCP client registration:',
    '  {',
    `    "command": "${BIN_NAME}",`,
    '    "args": ["--agent-id", "analyst-bot"]',
    '  }',
    '',
  ].join('\n')
}

/**
 * Parse and validate the startup configuration.
 *
 * Validates *shape*, not deployment: whether a scope's corpus is a git repository, is
 * the repository root, and has a clean worktree is `posture.ts`'s job at the three
 * binding moments (register / switch / `--scope`, ADR-0011 ruling 3), and whether the
 * agent id is usable as a git ident is `identity.ts`'s. Keeping those out of here is
 * what makes the failure classes separable at the exit code — a missing flag is a usage
 * error, an unusable scope is a deployment error.
 * @param argv - the arguments after `node <script>` (i.e. `process.argv.slice(2)`).
 * @param env - the process environment.
 * @returns the validated {@link ServerConfig}.
 * @throws HelpRequested when `--help` or `-h` is present.
 * @throws ConfigError for an unknown flag (including the removed `--corpus`), a missing
 *   required value, or a malformed one.
 */
export function parseServerConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ServerConfig {
  let values: { [K in keyof typeof OPTIONS]?: string | boolean }
  try {
    values = parseArgs({ args: [...argv], options: OPTIONS, strict: true, allowPositionals: false }).values
  } catch (e) {
    // parseArgs' own messages are precise about *what* was wrong (unknown option, missing
    // argument, unexpected positional) and say nothing about this server, so they are
    // kept verbatim and given a remedy. The removed --corpus lands here too — strict
    // parsing rejects it as an unknown option, which is the clean break ruling 3 chose.
    throw new ConfigError((e as Error).message, `run \`${BIN_NAME} --help\` for the accepted flags (corpora enter via the register_scope tool, not --corpus)`)
  }

  if (values.help === true) throw new HelpRequested(usage())

  const agentId = pick(values['agent-id'], env[ENV_VARS.agentId])
  if (agentId === undefined) {
    throw new ConfigError(
      'no agent id given: the git audit backbone records the writing agent as the commit author, and a defaulted author is not an audit trail (ADR-0004 ruling 9)',
      `pass \`--agent-id <id>\` (or set ${ENV_VARS.agentId}) naming the agent that will write`,
    )
  }

  const registryPath = resolve(pick(values.registry, env[ENV_VARS.registry]) ?? defaultRegistryPath())
  const scopeId = pick(values.scope, env[ENV_VARS.scope])
  const lockTimeoutMs = parseLockTimeout(pick(values['lock-timeout-ms'], env[ENV_VARS.lockTimeoutMs]))

  return {
    // Resolved here, once, so every downstream message names the file actually used
    // rather than the relative string the operator typed.
    registryPath,
    agentId,
    ...scopeId !== undefined ? { scopeId } : {},
    ...lockTimeoutMs !== undefined ? { lockTimeoutMs } : {},
  }
}

/**
 * Resolve one setting from its two carriers.
 * @param flag - the parsed flag value, if the flag was passed.
 * @param envValue - the environment variable's value, if set.
 * @returns the flag when it carries a non-blank string, else the environment variable
 *   when it does, else undefined. A blank value counts as absent in both carriers: a
 *   client UI that renders an empty text field as `--scope ""` should mean "unset", not
 *   "a scope whose name is the empty string".
 */
function pick(flag: string | boolean | undefined, envValue: string | undefined): string | undefined {
  if (typeof flag === 'string' && flag.trim() !== '') return flag.trim()
  if (envValue !== undefined && envValue.trim() !== '') return envValue.trim()
  return undefined
}

/**
 * Validate the lock timeout.
 * @param raw - the value from either carrier, or undefined.
 * @returns the timeout in milliseconds, or undefined to take `lock.ts`'s default.
 * @throws ConfigError when the value is not a positive integer. Refused rather than
 *   clamped: a timeout silently reinterpreted is a corpus that blocks or fails for a
 *   duration nobody chose, and the operator who typed `10s` deserves to be told.
 */
function parseLockTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(
      `lock timeout ${JSON.stringify(raw)} is not a positive whole number of milliseconds`,
      `pass a value like \`--lock-timeout-ms 10000\` (10 seconds), or omit it for the default`,
    )
  }
  return n
}

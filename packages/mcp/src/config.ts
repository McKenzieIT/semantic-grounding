/**
 * The server's configuration surface — how a corpus, an agent identity and the lock
 * tuning reach the process ([#22](https://github.com/McKenzieIT/semantic-grounding/issues/22)).
 *
 * ## Why flags and environment variables, and not a config file
 *
 * ADR-0004 ruling 9 already settled the shape for the load-bearing value. Identity comes
 * from the **startup channel**, because under stdio the `command` / `args` / `env` an MCP
 * client registers is the only configuration channel that exists, and because a
 * corpus-level config file cannot express identity at all: two processes over one corpus
 * may be two different agents, and the file is per-corpus. Once `--agent-id` has to be a
 * flag, giving the corpus path and lock timeout a *different* carrier buys nothing and
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
 * operator cannot see. This is the same reasoning that picked `legacy: 'serve'` in
 * `server.ts`: compatibility insurance against an unverified host, at a cost measured to
 * be near zero.
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
 * - **Scope default from the corpus.** The corpus's own `config.yaml` carries a
 *   `scope_id`, but reading it here would need `readLayerConfig` on the substrate's root
 *   barrel — a new public name, under ADR-0002 rule (b), against ADR-0003's trimming
 *   direction — to default an audit *label*. Omitted instead: `buildTrailers` drops
 *   `X-SG-Scope` when the scope is blank, so the honest outcome of "nobody said" is a
 *   missing trailer rather than a guessed one.
 *
 * @module config
 */
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** The executable's name, as it appears in usage text and error remedies. */
export const BIN_NAME = 'sg-mcp'

/**
 * Environment variable names, paired with the flag each one backs.
 *
 * Exported because the error messages name both carriers — an operator who set the
 * environment variable should not be told to pass a flag they cannot reach.
 */
export const ENV_VARS = {
  corpus: 'SG_CORPUS',
  agentId: 'SG_AGENT_ID',
  scope: 'SG_SCOPE',
  lockTimeoutMs: 'SG_LOCK_TIMEOUT_MS',
} as const

/** The validated startup configuration. */
export interface ServerConfig {
  /**
   * The corpus repository root, resolved to an absolute path.
   *
   * One value serves two roles: the git backbone's `corpusRoot` (ADR-0004 ruling 5
   * requires it to *be* the repository root) and the substrate's `semanticRoot`. They are
   * the same directory by definition — GLOSSARY § corpus: "corpus root = repo root" — and
   * the substrate's `resolveSemanticLayer` accepts both corpus layouts from this one
   * value: `config.yaml` at the root, or in a single child subdirectory.
   */
  readonly corpusRoot: string
  /** The writing agent, recorded as the commit author (ADR-0004 ruling 9). */
  readonly agentId: string
  /** The scope this process serves; absent means no `X-SG-Scope` trailer. */
  readonly scopeId?: string
  /** Corpus-lock acquisition timeout; absent means `lock.ts`'s 10s default. */
  readonly lockTimeoutMs?: number
}

/**
 * A configuration input the server cannot start from.
 *
 * Deliberately **not** an `SgApplicationError`: that base class exists to carry a
 * JSON-RPC error code to a `tools/call` response, and a config error is raised before the
 * transport is connected, so it never reaches the wire. This is also why #22 needs no
 * slice of the `-31xxx` space that `errors.ts` partitions between #19, #20 and #21 — its
 * failures are process exits, not protocol responses.
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
  corpus: { type: 'string' },
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
    `${BIN_NAME} — MCP server exposing a semantic-grounding corpus to a working agent.`,
    '',
    'Every Tier-2 write becomes a git commit in the corpus repository, authored by the',
    'declared agent (ADR-0004). Speaks MCP over stdio; stdout carries JSON-RPC only, and',
    'every diagnostic goes to stderr.',
    '',
    `usage: ${BIN_NAME} --corpus <path> --agent-id <id> [options]`,
    '',
    'required:',
    `  --corpus <path>          Corpus repository root (also the semantic-layer root).`,
    `                           Must be its own git repository, rooted here. An absolute`,
    `                           path is strongly preferred: under stdio the MCP client`,
    `                           chooses the working directory, so a relative path resolves`,
    `                           against a directory you did not pick.`,
    `                           env: ${ENV_VARS.corpus}`,
    `  --agent-id <id>          The writing agent, recorded as the commit author. No`,
    `                           default: a defaulted author is not an audit trail.`,
    `                           env: ${ENV_VARS.agentId}`,
    '',
    'optional:',
    `  --scope <id>             Scope this process serves; recorded in the X-SG-Scope`,
    `                           commit trailer. Omitted means no such trailer.`,
    `                           env: ${ENV_VARS.scope}`,
    `  --lock-timeout-ms <n>    How long a write waits for the corpus lock before failing`,
    `                           (positive integer, default 10000).`,
    `                           env: ${ENV_VARS.lockTimeoutMs}`,
    `  -h, --help               Print this text.`,
    '',
    'A flag always wins over its environment variable.',
    '',
    'example MCP client registration:',
    '  {',
    `    "command": "${BIN_NAME}",`,
    '    "args": ["--corpus", "/srv/k11-semantic-layer", "--agent-id", "analyst-bot"]',
    '  }',
    '',
  ].join('\n')
}

/**
 * Parse and validate the startup configuration.
 *
 * Validates *shape*, not deployment: whether the corpus is a git repository, is the
 * repository root, and has a clean worktree is `posture.ts`'s job, and whether the agent
 * id is usable as a git ident is `identity.ts`'s. Keeping those out of here is what makes
 * the two failure classes separable at the exit code — a missing flag is a usage error,
 * an unusable corpus is a deployment error.
 * @param argv - the arguments after `node <script>` (i.e. `process.argv.slice(2)`).
 * @param env - the process environment.
 * @returns the validated {@link ServerConfig}.
 * @throws HelpRequested when `--help` or `-h` is present.
 * @throws ConfigError for an unknown flag, a missing required value, or a malformed one.
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
    // kept verbatim and given a remedy.
    throw new ConfigError((e as Error).message, `run \`${BIN_NAME} --help\` for the accepted flags`)
  }

  if (values.help === true) throw new HelpRequested(usage())

  const corpus = pick(values.corpus, env[ENV_VARS.corpus])
  if (corpus === undefined) {
    throw new ConfigError(
      'no corpus given, and the server has nothing to serve without one',
      `pass \`--corpus <path>\` (or set ${ENV_VARS.corpus}) to the corpus repository root`,
    )
  }

  const agentId = pick(values['agent-id'], env[ENV_VARS.agentId])
  if (agentId === undefined) {
    throw new ConfigError(
      'no agent id given: the git audit backbone records the writing agent as the commit author, and a defaulted author is not an audit trail (ADR-0004 ruling 9)',
      `pass \`--agent-id <id>\` (or set ${ENV_VARS.agentId}) naming the agent that will write`,
    )
  }

  const scopeId = pick(values.scope, env[ENV_VARS.scope])
  const lockTimeoutMs = parseLockTimeout(pick(values['lock-timeout-ms'], env[ENV_VARS.lockTimeoutMs]))

  return {
    // Resolved here, once, so every downstream message — and the posture check's
    // comparison against `git rev-parse --show-toplevel` — names the directory actually
    // used rather than the relative string the operator typed.
    corpusRoot: resolve(corpus),
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

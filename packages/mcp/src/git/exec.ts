/**
 * The git subprocess seam.
 *
 * Every git call in this package goes through here, for three reasons that each cost a
 * bug if skipped:
 *
 * 1. **No shell.** `execFile` with an argv array, never a command string — corpus paths,
 *    table names and agent-supplied summaries all reach git as arguments, and a shell in
 *    the middle turns a table named `a;rm -rf /` into an incident.
 * 2. **stdout is sacred.** The server speaks JSON-RPC over stdio (#14: stderr is the
 *    official log channel). A child's stdout is captured here and never forwarded, so no
 *    git progress line can land in the protocol stream.
 * 3. **Non-interactive.** `GIT_TERMINAL_PROMPT=0` plus a cleared askpass means git fails
 *    instead of blocking on a prompt no one can answer. A hung commit inside the corpus
 *    lock would wedge every other writer until the lock's timeout.
 *
 * Hooks are deliberately **not** bypassed (no `--no-verify`): a corpus repo's hooks are
 * the operator's policy, and a hook that rejects a commit is a real audit failure that
 * should roll the write back loudly, not a nuisance to route around.
 *
 * @module git/exec
 */
import { execFile } from 'node:child_process'

/** Outcome of one git invocation; `code` is 0 on success. */
export interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Thrown by {@link git} when a git invocation exits non-zero. */
export class GitCommandError extends Error {
  /** The argv passed to git (no shell was involved). */
  readonly args: readonly string[]
  /** The captured exit code and streams. */
  readonly result: GitResult

  /**
   * @param args - the argv passed to git.
   * @param result - the captured exit code and streams.
   */
  constructor(args: readonly string[], result: GitResult) {
    super(`git ${args.join(' ')} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`)
    this.name = 'GitCommandError'
    this.args = args
    this.result = result
  }
}

/**
 * Environment that makes git non-interactive and reproducible regardless of the
 * operator's shell. Locale is pinned so git's own messages (which this package parses in
 * only one place — `--porcelain`, which is locale-stable by design) and any stderr we
 * surface to an operator read consistently.
 */
const BASE_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  LC_ALL: 'C',
}

/** Options for a single git invocation. */
export interface GitOptions {
  /** Working directory; must be inside the corpus repository. */
  readonly cwd: string
  /** Extra environment (identity overrides for `commit` — see `identity.ts`). */
  readonly env?: Readonly<Record<string, string>>
  /** Text piped to git's stdin (used for `commit -F -`). */
  readonly stdin?: string
  /** Hard cap on one invocation; a local git command that outruns this is wedged. */
  readonly timeoutMs?: number
}

/**
 * Default per-invocation timeout. Local git operations on a corpus-sized repo are
 * milliseconds (ADR-0004's consequence note: "local commits are milliseconds against
 * LLM-paced tool calls"), so 30s is not a performance budget — it is the line past which
 * a call is presumed wedged rather than slow, because it is holding the corpus lock.
 */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Run git, tolerating a non-zero exit.
 *
 * Use this for the handful of commands whose exit code *is* the answer —
 * `diff --cached --quiet` (0 = nothing staged), `rev-parse --verify HEAD` (non-zero =
 * unborn). Everywhere else prefer {@link git}, which turns a failure into a throw.
 * @param args - git argv, e.g. `['status', '--porcelain']`.
 * @param opts - cwd, environment overrides, stdin, timeout.
 * @returns the exit code and captured streams.
 */
export async function gitTry(args: readonly string[], opts: GitOptions): Promise<GitResult> {
  return new Promise<GitResult>(resolve => {
    const child = execFile(
      'git',
      [...args],
      {
        cwd: opts.cwd,
        env: { ...process.env, ...BASE_ENV, ...opts.env ?? {} },
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        // `error.code` is the exit status for a normal non-zero exit, but a string
        // (`ETIMEDOUT`, `ENOENT`) when the process never ran or was killed. Normalise
        // both onto a numeric code so callers only ever branch on numbers; 1 is the
        // conservative stand-in because every caller treats non-zero as failure.
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolve({ code, stdout, stderr })
      },
    )
    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin)
    }
  })
}

/**
 * Run git and throw {@link GitCommandError} on a non-zero exit.
 * @param args - git argv.
 * @param opts - cwd, environment overrides, stdin, timeout.
 * @returns the captured streams (exit code was 0).
 * @throws GitCommandError when git exits non-zero, times out, or is not installed.
 */
export async function git(args: readonly string[], opts: GitOptions): Promise<GitResult> {
  const res = await gitTry(args, opts)
  if (res.code !== 0) throw new GitCommandError(args, res)
  return res
}

/**
 * Run git and return its trimmed stdout — the common shape for the `rev-parse` family.
 * @param args - git argv.
 * @param opts - cwd, environment overrides, stdin, timeout.
 * @returns stdout with surrounding whitespace removed.
 * @throws GitCommandError when git exits non-zero.
 */
export async function gitOut(args: readonly string[], opts: GitOptions): Promise<string> {
  return (await git(args, opts)).stdout.trim()
}

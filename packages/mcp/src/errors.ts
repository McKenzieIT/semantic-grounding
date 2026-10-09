/**
 * Application error codes for the MCP management surface.
 *
 * ## Why these numbers
 *
 * MCP's 2026-07-28 revision partitions the JSON-RPC reserved block: `-32000..-32019`
 * is legacy (new code must not allocate there), `-32020..-32099` is spec-only, and
 * **application-defined errors SHOULD be allocated outside the reserved range
 * `-32768..-32000` entirely** (#14 research, `basic/index.mdx` § Error Codes).
 * ADR-0004 ruling 7 and ADR-0005 ruling 8 both named the error *kinds* (lock timeout,
 * stale baseline, validation failure) and deferred the *values* to the implementation
 * ticket — this file, from [#19](https://github.com/McKenzieIT/semantic-grounding/issues/19).
 *
 * So: the `-31xxx` space, just above the reserved block, sub-partitioned the same way
 * MCP partitioned its own so the three implementation tickets never collide:
 *
 * | segment          | owner                                   |
 * |------------------|-----------------------------------------|
 * | `-31000..-31019` | git audit backbone — this file (#19)    |
 * | `-31020..-31039` | intent tool surface (#20, ADR-0005)     |
 * | `-31040..-31059` | enrichment tools (#21, ADR-0006)        |
 *
 * ## Why codes at all, in a layer that throws
 *
 * The recorder is called from inside the substrate (`Tier2Recorder`), which knows
 * nothing about JSON-RPC, so these errors propagate as plain exceptions and the tool
 * layer maps them to a `tools/call` error response. Carrying the code on the error
 * itself is what makes that mapping total rather than a growing `instanceof` ladder in
 * #20: anything that is an {@link SgApplicationError} has a code; anything else is an
 * internal fault and maps to a generic failure.
 *
 * `retryable` is on the base class because exactly one of these errors is worth an
 * automatic retry by the *calling agent* rather than a human: a stale baseline means
 * "re-read the target and try again" (ADR-0004 ruling 8). Lock timeout is deliberately
 * NOT retryable-by-contract — the queue is the lock itself (ruling 7), so a timeout
 * means the corpus is genuinely contended and silently retrying would hide that.
 *
 * @module errors
 */

/** The reserved JSON-RPC range application codes must avoid (MCP 2026-07-28). */
export const JSONRPC_RESERVED_RANGE = { min: -32768, max: -32000 } as const

/**
 * Error codes owned by the git audit backbone (#19), in the `-31000..-31019`
 * segment documented in this module's header.
 */
export const GIT_AUDIT_ERROR_CODES = {
  /** Corpus lock could not be acquired before the configured timeout (ADR-0004 ruling 7). */
  lock_timeout: -31001,
  /** `expected_version` did not match the bytes on disk inside the lock (ADR-0004 ruling 8). */
  stale_baseline: -31002,
  /** `git add`/`git commit` failed; the write was rolled back (ADR-0004 ruling 1). */
  commit_failed: -31003,
  /** Corpus is not its own git repository root, or its worktree posture is refused (rulings 5/6). */
  posture_refused: -31004,
  /** No agent identity was declared at startup, or it is unusable as a git ident (ruling 9). */
  identity_missing: -31005,
  /** `recordTier2Write` reached the recorder without an audit context (see `recorder.ts`). */
  missing_audit_context: -31006,
} as const

/** The union of codes this module allocates. */
export type GitAuditErrorCode = (typeof GIT_AUDIT_ERROR_CODES)[keyof typeof GIT_AUDIT_ERROR_CODES]

/**
 * Base class for errors that are part of this surface's contract — a condition the
 * caller can act on, as opposed to an internal fault. Carries the numeric code the
 * tool layer puts on the JSON-RPC error response.
 */
export class SgApplicationError extends Error {
  /** The application error code (outside the JSON-RPC reserved range). */
  readonly code: GitAuditErrorCode
  /** Whether the calling agent should re-read its inputs and retry without human help. */
  readonly retryable: boolean
  /** Structured detail for the error response; free-form per subclass. */
  readonly data: Readonly<Record<string, unknown>>

  /**
   * @param code - the application error code.
   * @param message - the human-readable, actionable message.
   * @param opts - `retryable` (default false) and structured `data` for the response.
   */
  constructor(
    code: GitAuditErrorCode,
    message: string,
    opts: { readonly retryable?: boolean; readonly data?: Readonly<Record<string, unknown>> } = {},
  ) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.retryable = opts.retryable ?? false
    this.data = opts.data ?? {}
  }
}

/**
 * The corpus lock was held by someone else for longer than the configured timeout.
 *
 * Not retryable by contract: queuing *is* waiting on the lock (ADR-0004 ruling 7), so
 * reaching the timeout means the corpus is genuinely contended — surfacing that beats
 * an invisible retry loop.
 */
export class LockTimeoutError extends SgApplicationError {
  /**
   * @param message - the actionable message (should name the holder and the waited duration).
   * @param data - structured detail: lock path, holder pid/agent, waited ms.
   */
  constructor(message: string, data?: Readonly<Record<string, unknown>>) {
    super(GIT_AUDIT_ERROR_CODES.lock_timeout, message, { ...data !== undefined ? { data } : {} })
  }
}

/**
 * The write's `expected_version` baseline no longer matches the target on disk.
 *
 * The one retryable error in this file: the agent re-reads the definition (picking up a
 * fresh `version` fingerprint) and re-issues the write (ADR-0004 ruling 8, surfaced to
 * tools as `stale_baseline` by ADR-0005 ruling 8).
 */
export class StaleBaselineRejection extends SgApplicationError {
  /**
   * @param message - the actionable message (should say "re-read and retry").
   * @param data - structured detail: target path, expected vs actual fingerprint.
   */
  constructor(message: string, data?: Readonly<Record<string, unknown>>) {
    super(GIT_AUDIT_ERROR_CODES.stale_baseline, message, {
      retryable: true,
      ...data !== undefined ? { data } : {},
    })
  }
}

/**
 * Staging or committing the audit record failed, so the write was rolled back.
 *
 * This is D5's fail-loud half made real (ADR-0001 update, ADR-0004 ruling 1): the
 * recorder raising is the statement "the write did not happen", and by the time this
 * surfaces both the index/worktree (here) and the definition's raw bytes (substrate)
 * are back at their pre-write state.
 */
export class CommitFailedError extends SgApplicationError {
  /**
   * @param message - the actionable message (should include git's own stderr).
   * @param data - structured detail: the git argv, exit code, stderr.
   */
  constructor(message: string, data?: Readonly<Record<string, unknown>>) {
    super(GIT_AUDIT_ERROR_CODES.commit_failed, message, { ...data !== undefined ? { data } : {} })
  }
}

/**
 * The corpus is not in a posture the git backbone can audit, and startup is refused:
 * not a git repository, not the repository *root*, or a dirty worktree that is not
 * recoverable crash residue (ADR-0004 rulings 5 and 6).
 *
 * Always carries a `remedy` — refusing without saying what to run is how an operator
 * concludes the tool is broken rather than the deployment.
 */
export class PostureRefusedError extends SgApplicationError {
  /** The concrete command or action that resolves the refusal. */
  readonly remedy: string

  /**
   * @param message - what was wrong with the corpus posture.
   * @param remedy - the concrete command or action that fixes it (e.g. `git init`).
   * @param data - structured detail: corpus root, toplevel, dirty entries, lock holder.
   */
  constructor(message: string, remedy: string, data?: Readonly<Record<string, unknown>>) {
    super(GIT_AUDIT_ERROR_CODES.posture_refused, `${message} — ${remedy}`, {
      data: { remedy, ...data ?? {} },
    })
    this.remedy = remedy
  }
}

/**
 * No usable agent identity was declared at startup (ADR-0004 ruling 9: identity comes
 * from the startup channel and its absence refuses the process, because an audit trail
 * whose author field is a default is not an audit trail).
 */
export class IdentityMissingError extends SgApplicationError {
  /**
   * @param message - what was missing or malformed about the declared identity.
   * @param data - structured detail: the offending value.
   */
  constructor(message: string, data?: Readonly<Record<string, unknown>>) {
    super(GIT_AUDIT_ERROR_CODES.identity_missing, message, { ...data !== undefined ? { data } : {} })
  }
}

/**
 * `recordTier2Write` was called without an ambient audit context — i.e. a Tier-2 write
 * reached the recorder outside `GitTier2Recorder.runAudited`.
 *
 * A wiring bug, raised loudly rather than papered over: ADR-0005 ruling 8 explicitly
 * rejected server-synthesized summaries ("只有字段回声，没有「依据什么」"), so the
 * recorder cannot invent the intent — and inventing it would put a commit in the audit
 * history whose stated basis is a fiction.
 */
export class MissingAuditContextError extends SgApplicationError {
  /**
   * @param message - names the tool whose write arrived contextless.
   * @param data - structured detail: tool name.
   */
  constructor(message: string, data?: Readonly<Record<string, unknown>>) {
    super(GIT_AUDIT_ERROR_CODES.missing_audit_context, message, { ...data !== undefined ? { data } : {} })
  }
}

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
 * Allocated so far in the `-31020..-31039` segment: `unsupported_update_field` −31020,
 * `definition_not_found` −31021, `definition_already_exists` −31022,
 * `suggestion_not_found` −31023, `validation_failed` −31024. `stale_baseline`,
 * `lock_timeout`, `commit_failed`, `posture_refused` and `missing_audit_context` are
 * **not** re-allocated here — a tool-layer write surfaces #19's own codes unchanged
 * (`runAudited`/`recordTier2Write` already throw {@link SgApplicationError} subclasses
 * carrying them), which is exactly what {@link toToolErrorResult} is generic over.
 *
 * ## The `-31xxx` code never rides the JSON-RPC wire for a tool-layer failure
 *
 * ADR-0005 ruling 8 named the error *kinds* a tool caller must be able to discriminate
 * (`stale_baseline`, lock timeout, validation failure) and deferred the mechanism to
 * this ticket (#20) — the deferral was forced by a premise ADR-0004's addendum had
 * recorded and #22's SDK probe then falsified: **`McpServer.registerTool`'s handler
 * wrapper catches every exception the handler throws and converts it to a
 * `{content:[…], isError:true}` *result*, discarding everything but `.message`.**
 * Measured directly against the installed `@modelcontextprotocol/server@2.3.1` (its
 * `tools/call` handler, `mcp-DIH4cS6P.mjs`):
 *
 * ```js
 * try {
 *   const result = await this.executeToolHandler(tool, args, ctx)
 *   ...
 * } catch (error) {
 *   if (error instanceof ProtocolError && error.code === ProtocolErrorCode.UrlElicitationRequired) throw error
 *   return this.createToolError(error instanceof Error ? error.message : String(error))
 * }
 * // createToolError(errorMessage) { return { content: [{ type: 'text', text: errorMessage }], isError: true } }
 * ```
 *
 * So a *thrown* {@link SgApplicationError} would not merely lose its `code` on the wire —
 * `createToolError` keeps only `.message`, so `.code`/`.retryable`/`.data` are **all**
 * discarded before a single byte is written. The only seam that puts a bare `-31xxx` on
 * the actual JSON-RPC `error.code` field is the low-level `server.server.setRequestHandler`
 * (bypassing `registerTool` entirely) — rejected here because it costs the zod schema
 * validation and the automatic `tools/list` registration `registerTool` gives for free
 * (and the already-tested "`capabilities:{tools:{}}` coexists with a later `registerTool`"
 * assertion the whole #20/#21 integration step rests on, `tests/server-startup.spec.ts`).
 *
 * The decision kept here: **keep `registerTool`**, and have every tool handler *catch*
 * its own errors and *return* — never throw — a structured `isError` result via
 * {@link toToolErrorResult}. Returning (rather than throwing) is what matters: a result a
 * handler returns reaches the wire through `projectCallToolResult` untouched, so the full
 * `{code, name, message, retryable, data}` payload this function builds survives inside
 * `content[0].text` as JSON. The `-31xxx` value is still meaningful — it is just read out
 * of that JSON by the calling agent, never off `error.code`. Two facts the SDK still gives
 * for free, confirmed by the same read: an **unknown tool name** throws before the
 * try/catch above even starts, so it still produces a genuine `-32602`; and the SDK's own
 * `outputSchema`/`structuredContent` feature (real in this version, unlike the error path)
 * is simply never declared by any tool below, so it never enters the picture.
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
 * ## `-31040..-31059` is reserved for #21, and allocates nothing
 *
 * ADR-0005's 2026-10-09 addendum (confirmed by #22's measurement) falsifies the premise
 * that funded this segment table: `McpServer.registerTool`'s handler exceptions are
 * caught by the SDK and turned into an `isError` **result**, with any `code` field
 * discarded — only the low-level `server.server.setRequestHandler` seam passes a numeric
 * code onto the wire. {@link toToolErrorResult} is this ticket's answer: carry the code
 * *inside* the `isError` result's JSON payload instead of on the JSON-RPC envelope, which
 * means a `-31xxx` value never actually reaches a client through `tools/call`, for either
 * this file's codes or this segment's. Measuring what `apply_enrichment` /
 * `run_enrichment` / `get_enrichment_work` can throw as a *whole-call* failure (as
 * opposed to a per-item verdict — see {@link toToolErrorResult}'s own doc) turns up
 * nothing enrichment-specific to code: a lock timeout, a commit failure, a dirty-tree
 * refusal and a missing audit context are all generic Tier-2 write failures #19 already
 * coded, and every per-item problem (`stale_baseline`, `unparseable`, a `work_id` that
 * fails to decode) is ADR-0006 ruling 4's non-error payload data, not an exception. So
 * this segment stays empty on purpose — the same outcome #22's addendum item 3 recorded
 * for its own startup-only segment ("分配表的确认而非缺口" — a confirmation of the
 * allocation table, not a gap). A future enrichment-specific failure that genuinely
 * needs a code allocates from `-31040` up; nothing here claims one could never exist.
 *
 * @module errors
 */
import type { CallToolResult } from '@modelcontextprotocol/server'

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
 * Error codes owned by the intent tool surface (#20), in the `-31020..-31039`
 * segment documented in this module's header.
 *
 * These are the genuinely *new* tool-layer conditions ADR-0005's ruling 8 asks to be
 * discriminable — "validation failure" in its three concrete tool-layer shapes. The
 * other two kinds ruling 8 names (`stale_baseline`, lock timeout) are **not**
 * reallocated here: they already arrive as coded {@link SgApplicationError} subclasses
 * out of `GitTier2Recorder.runAudited`/`recordTier2Write` (the `-31000..-31019`
 * segment), and {@link toToolErrorResult} is generic over any of them. Allocating a
 * second code for the same condition would give one failure two numbers.
 */
export const INTENT_TOOL_ERROR_CODES = {
  /** `update_definition` was asked to set an identity or array-reference field (ADR-0005 ruling 4). */
  unsupported_update_field: -31020,
  /** The named table/event/concept/metric does not exist. */
  definition_not_found: -31021,
  /** `create_definition` named a table/event that already exists. */
  definition_already_exists: -31022,
  /** The named Tier-1 suggestion id does not exist in the pending queue. */
  suggestion_not_found: -31023,
  /** The merged document failed re-validation against the kind's full definition schema. */
  validation_failed: -31024,
} as const

/** The union of codes this module allocates for the intent tool surface. */
export type IntentToolErrorCode = (typeof INTENT_TOOL_ERROR_CODES)[keyof typeof INTENT_TOOL_ERROR_CODES]

/**
 * Base class for errors that are part of this surface's contract — a condition the
 * caller can act on, as opposed to an internal fault. Carries the numeric code a tool
 * handler reads back out via {@link toToolErrorResult} (never the JSON-RPC wire's own
 * `error.code` for a tool-layer failure — see this module's header).
 *
 * `code`'s type is a plain `number` rather than a single ticket's own union
 * ({@link GitAuditErrorCode} / {@link IntentToolErrorCode}) because this one base class
 * is shared across all three `-31xxx` segments (git audit backbone #19, intent tools
 * #20 here, enrichment tools #21) — a subclass from any segment constructs the same
 * base with its own segment's literal.
 */
export class SgApplicationError extends Error {
  /** The application error code (outside the JSON-RPC reserved range). */
  readonly code: number
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
    code: number,
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

/**
 * `update_definition` was asked to set a field it does not accept: an identity field
 * (`table_name` / `name` / `kind`, immutable after creation) or an array-reference
 * field (`alt_labels` / `dimension_refs` / `external_refs`, maintained item-by-item so
 * two concurrent callers merging whole arrays cannot lose each other's entries —
 * ADR-0005 ruling 4). Array-reference rejections always carry `data.use_instead`
 * naming the item-level tool that does accept the field; identity rejections do not
 * (there is no tool that renames a definition or changes a table's dws/dim kind).
 */
export class UnsupportedUpdateFieldError extends SgApplicationError {
  /**
   * @param message - names the rejected field and, for an array-reference field, the tool to use instead.
   * @param data - structured detail: `field`, and `use_instead` when one applies.
   */
  constructor(message: string, data?: Readonly<Record<string, unknown>>) {
    super(INTENT_TOOL_ERROR_CODES.unsupported_update_field, message, { ...data !== undefined ? { data } : {} })
  }
}

/**
 * The named definition does not exist: `get_definition` was asked for a table / event /
 * concept / metric with no matching definition, or a write tool (`update_definition`,
 * `add_alias`, `remove_alias`, `add_relation`, `remove_relation`) was asked to modify
 * one. Not retryable in the `stale_baseline` sense — the fix is a different call
 * (`create_definition`, or re-checking the name via `search_definitions`), not a retry
 * of this one with fresh inputs.
 */
export class DefinitionNotFoundError extends SgApplicationError {
  /**
   * @param message - names the missing kind and name.
   * @param data - structured detail: `kind`, `name`.
   */
  constructor(message: string, data?: Readonly<Record<string, unknown>>) {
    super(INTENT_TOOL_ERROR_CODES.definition_not_found, message, { ...data !== undefined ? { data } : {} })
  }
}

/**
 * `create_definition` named a table or event that already has a definition on disk.
 * Refused rather than silently overwritten: creation and update are deliberately two
 * different tools with two different audit verbs (ADR-0005 ruling 2), so a `create`
 * that lands on an existing name is the caller's mistake to correct — with
 * `update_definition` — not this tool's to paper over.
 */
export class DefinitionAlreadyExistsError extends SgApplicationError {
  /**
   * @param message - names the kind and name that already exists.
   * @param data - structured detail: `kind`, `name`.
   */
  constructor(message: string, data?: Readonly<Record<string, unknown>>) {
    super(INTENT_TOOL_ERROR_CODES.definition_already_exists, message, { ...data !== undefined ? { data } : {} })
  }
}

/**
 * `get_suggestion` / `discard_suggestion` named a `suggestion_id` with no matching
 * entry in the Tier-1 pending queue (never submitted, already discarded, or
 * malformed — `isValidId` rejects anything that cannot be a real id before a lookup
 * is even attempted, which this error also covers).
 */
export class SuggestionNotFoundError extends SgApplicationError {
  /**
   * @param message - names the missing suggestion id.
   * @param data - structured detail: `suggestion_id`.
   */
  constructor(message: string, data?: Readonly<Record<string, unknown>>) {
    super(INTENT_TOOL_ERROR_CODES.suggestion_not_found, message, { ...data !== undefined ? { data } : {} })
  }
}

/**
 * The document that would result from this write failed re-validation against the
 * kind's full definition schema (`TableDefinitionSchema` / `EventDefinitionSchema`,
 * refinements included — e.g. a DIM table whose merged `primary_key` ends up empty).
 *
 * Distinct from {@link UnsupportedUpdateFieldError}: that one rejects a *field name*
 * before any write is attempted; this one is the kind's own schema rejecting the
 * *merged value* — `updateTableMeta` / `updateEventMeta` already compute this message
 * (ADR-0004/#18's `UpdateTableMetaResult`/`UpdateEventMetaResult`'s `{ok:false, error}`
 * branch) without throwing, so this class only gives it a code and a wire shape.
 */
export class DefinitionValidationError extends SgApplicationError {
  /**
   * @param message - the schema's own validation message (from `updateTableMeta`/`updateEventMeta`).
   * @param data - structured detail: `kind`, `name`.
   */
  constructor(message: string, data?: Readonly<Record<string, unknown>>) {
    super(INTENT_TOOL_ERROR_CODES.validation_failed, message, { ...data !== undefined ? { data } : {} })
  }
}

/**
 * Map a thrown error onto a `tools/call` result, per ADR-0005's 2026-10-09 addendum
 * (shared with #20, implemented independently here).
 *
 * `McpServer.registerTool` is kept rather than dropped to the low-level
 * `server.server.setRequestHandler` seam — the measured alternative — because the cost
 * of leaving `registerTool` (schema validation, `tools/list` auto-registration) is a
 * single `instanceof` check's width, paid once per tool, against the cost of hand-rolling
 * every tool's dispatch and input validation. The trade this function actually makes is
 * the OTHER option the addendum named: the error contract changes *shape*, not channel.
 * A coded failure is not a JSON-RPC error response (that would need `setRequestHandler`);
 * it is a normal `tools/call` **result** with `isError: true`, whose `content` carries the
 * code/name/message/retryable/data as a JSON string instead of prose. An agent that wants
 * to branch on `stale_baseline` parses `JSON.parse(result.content[0].text).code === -31002`
 * rather than reading a JSON-RPC `error.code` that the SDK would have discarded anyway.
 *
 * Every tool handler in this package wraps its body `try { ... } catch (e) { return
 * toToolErrorResult(e) }`. An error that is NOT an {@link SgApplicationError} — a bug in
 * this server, not a condition the caller can act on — is rethrown rather than wrapped:
 * the SDK's own handler-exception path still turns it into an `isError` result for the
 * client (measurement 1 of ADR-0005's addendum applies regardless of what this function
 * does), but it does so *without* this function pretending the fault was anticipated.
 * Swallowing it here into a coded-looking shape would misrepresent an internal fault as
 * part of the contract.
 *
 * This is distinct from `apply_enrichment`'s own **per-item** verdicts (`applied` /
 * `idempotent` / `stale_baseline` / `unparseable`): those are normal, non-error payload
 * data in a *successful* call's `results` array (ADR-0006 ruling 4) — one stale item
 * does not make the whole batch an error, so it never reaches this function. This
 * function is only for whole-call failures: a malformed batch, a lock timeout acquiring
 * the corpus lock, a dirty worktree refusing the write.
 * @param error - whatever the tool handler's body threw.
 * @returns a `CallToolResult` with `isError: true` and the coded failure as JSON text.
 * @throws the original error, unchanged, when it is not an {@link SgApplicationError}.
 */
export function toToolErrorResult(error: unknown): CallToolResult {
  if (error instanceof SgApplicationError) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({
          code: error.code,
          name: error.name,
          message: error.message,
          retryable: error.retryable,
          data: error.data,
        }),
      }],
    }
  }
  throw error // internal fault — stays loud, not masked as an anticipated tool result
}

/**
 * `@semantic-grounding/mcp` — the MCP management surface's host wiring.
 *
 * What exists today is the **git Tier-2 audit backbone**
 * ([#19](https://github.com/McKenzieIT/semantic-grounding/issues/19), ADR-0004): the
 * recorder that turns a Tier-2 write into a commit, the repo-wide lock that serializes
 * writes across processes, and the startup checks that refuse a corpus the backbone
 * cannot audit. The substrate ships no recorder by design — core takes one by setter —
 * so this package is where git enters the picture (ADR-0004 ruling 4: substrate changed
 * only its contract, took no new dependency, and left ADR-0003's name list alone).
 *
 * [#22](https://github.com/McKenzieIT/semantic-grounding/issues/22) added the second
 * half: the `sg-mcp` executable, its config surface, and the stdio server that carries
 * them, registering no tools of its own.
 * [#20](https://github.com/McKenzieIT/semantic-grounding/issues/20) appends ADR-0005's
 * fifteen intent tools (`src/tools/`) to `TOOL_REGISTRARS`, and
 * [#21](https://github.com/McKenzieIT/semantic-grounding/issues/21) (the three
 * enrichment tools and `beginBatch`, ADR-0006) appends the rest the same way.
 *
 * Every tool handler wraps its body in `try { ... } catch (e) { return
 * toToolErrorResult(e) }` — see that function's doc for why a *returned* `isError`
 * result is the only way `SgApplicationError`'s `code`/`retryable`/`data` survive
 * `registerTool`'s handler wrapper (measured against SDK v2.3.1: a *thrown* error is
 * reduced to its bare `.message`).
 *
 * ## Running it
 *
 * ```console
 * $ sg-mcp --corpus /srv/k11-semantic-layer --agent-id analyst-bot
 * ```
 *
 * Refuses to start — non-zero exit, nothing on stdout — when the corpus is not its own
 * git repository root, when its worktree is dirty in a way that is not recoverable crash
 * residue, or when no agent id was declared. See `main.ts` for the exit codes.
 *
 * ## Wiring it by hand
 *
 * ```ts
 * const report = await ensureStartupPosture({ corpusRoot, agentId })   // refuses, or recovers
 * const recorder = new GitTier2Recorder({ corpusRoot, agentId, paths: report.paths })
 * core.setTier2Recorder(recorder)
 *
 * const res = await recorder.runAudited(
 *   { tool: 'update_definition', target: 'dws_order', summary: '补充业务口径', derivation: 'agent', confidence: 0.9 },
 *   () => core.updateTableMeta('dws_order', { description: '…' }, { expected_version }),
 * )
 * ```
 *
 * Drive every Tier-2 write through `runAudited`, never by calling the core method
 * directly: the lock has to span read-merge-write through commit, and the recorder
 * refuses a write that arrives without the intent behind it. See `git/recorder.ts`.
 *
 * @module @semantic-grounding/mcp
 */

// ── Startup: config, the sequence, the stdio server (#22) ────────────────
export {
  BIN_NAME,
  ConfigError,
  ENV_VARS,
  HelpRequested,
  parseServerConfig,
  usage,
  type ServerConfig,
} from './config.ts'
export {
  EXIT,
  runMain,
  startup,
  startupBanner,
  stderrLog,
  type Log,
  type MainOutcome,
  type StartupResult,
} from './main.ts'
export {
  createServerFactory,
  serve,
  SERVER_INFO,
  TOOL_REGISTRARS,
  type ServeOptions,
  type ServerDeps,
  type ToolRegistrar,
} from './server.ts'

// ── Errors (the coded contract the tool surface maps onto JSON-RPC) ──────
export {
  GIT_AUDIT_ERROR_CODES,
  INTENT_TOOL_ERROR_CODES,
  JSONRPC_RESERVED_RANGE,
  SgApplicationError,
  CommitFailedError,
  DefinitionAlreadyExistsError,
  DefinitionNotFoundError,
  DefinitionValidationError,
  IdentityMissingError,
  LockTimeoutError,
  MissingAuditContextError,
  PostureRefusedError,
  StaleBaselineRejection,
  SuggestionNotFoundError,
  UnsupportedUpdateFieldError,
  toToolErrorResult,
  type GitAuditErrorCode,
  type IntentToolErrorCode,
} from './errors.ts'

// ── Intent tools (ADR-0005, #20) ──────────────────────────────────────────
export {
  INTENT_TOOL_NAMES,
  INTENT_TOOL_REGISTRARS,
} from './tools/index.ts'

// ── The recorder (ADR-0004) ─────────────────────────────────────────────
export {
  GitTier2Recorder,
  type AuditContext,
  type AuditedResult,
  type GitRecorderConfig,
  type RecordOutcome,
} from './git/recorder.ts'

// ── Startup posture (ADR-0004 rulings 5 and 6; consumed by #22) ──────────
export {
  assertCorpusIsRepoRoot,
  defaultPostureLogger,
  dirtyEntries,
  ensureStartupPosture,
  isUnbornHead,
  resolveRepoPaths,
  type PostureLogger,
  type PostureReport,
  type RepoPaths,
  type StartupPosture,
} from './git/posture.ts'

// ── The corpus lock (ADR-0004 ruling 7) ─────────────────────────────────
export {
  CorpusLock,
  LOCK_FILENAME,
  type CorpusLockOptions,
  type LockHandle,
  type LockRecord,
  type OwnerState,
} from './git/lock.ts'

// ── Commit identity and message shape (ADR-0004 rulings 9 and 10) ───────
export {
  agentIdentity,
  commitEnv,
  corpusNameFrom,
  requireAgentId,
  DEFAULT_AGENT_EMAIL_PATTERN,
  DEFAULT_SERVER_IDENTITY,
  type GitIdentity,
} from './git/identity.ts'
export {
  buildCommitMessage,
  buildSubject,
  buildTrailers,
  formatConfidence,
  DERIVATIONS,
  TRAILER_PREFIX,
  TRAILER_SCHEMA_VERSION,
  type CommitContext,
  type Derivation,
} from './git/message.ts'

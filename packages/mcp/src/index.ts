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
 * Still to come, each blocked on this ticket:
 * [#22](https://github.com/McKenzieIT/semantic-grounding/issues/22) stdio entry point
 * and config surface (it constructs `GitTier2Recorder` and runs `ensureStartupPosture`),
 * [#20](https://github.com/McKenzieIT/semantic-grounding/issues/20) the fifteen intent
 * tools (ADR-0005), [#21](https://github.com/McKenzieIT/semantic-grounding/issues/21)
 * the three enrichment tools and `beginBatch` (ADR-0006).
 *
 * ## Wiring it
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

// ── Errors (the coded contract the tool surface maps onto JSON-RPC) ──────
export {
  GIT_AUDIT_ERROR_CODES,
  JSONRPC_RESERVED_RANGE,
  SgApplicationError,
  CommitFailedError,
  IdentityMissingError,
  LockTimeoutError,
  MissingAuditContextError,
  PostureRefusedError,
  StaleBaselineRejection,
  type GitAuditErrorCode,
} from './errors.ts'

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

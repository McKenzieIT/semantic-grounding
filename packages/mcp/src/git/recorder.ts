/**
 * The git Tier-2 recorder — the implementation that makes D5 real end-to-end
 * (ADR-0001's 2026-10-08 update, ADR-0004).
 *
 * One auditable write = one commit. `git add` + `git commit` is a single atomic
 * write-and-record, which is what stops an unaudited write from being *expressible*: a
 * failed commit rolls the index and worktree back here, the substrate restores the
 * definition's raw bytes, and there is no third state.
 *
 * ## `runAudited` is the seam, not `recordTier2Write`
 *
 * The substrate's contract is `recordTier2Write(toolName, payload, opts)` — no summary,
 * no derivation, no confidence, because the substrate does not know the *intent* behind
 * a write. The tool layer does. And the critical section has to span read-merge-write
 * *through* commit (ADR-0004 ruling 7), which means the lock must be held *around* the
 * substrate call, not inside the recorder's callback. Both facts point at the same shape:
 *
 * ```ts
 * const res = await recorder.runAudited(
 *   { tool: 'add_alias', target: 'dws_order', summary: '补充口语别名', derivation: 'agent', confidence: 0.9 },
 *   () => core.updateTableMeta('dws_order', { alt_labels: [...] }, { expected_version }),
 * )
 * // res.value is the core's result; res.commit / res.changed answer ADR-0005's response contract
 * ```
 *
 * `runAudited` takes the lock and publishes the audit context; the nested
 * `recordTier2Write` the substrate fires re-enters the same lock (reentrant by instance)
 * and commits. `expected_version` is therefore checked *inside* the lock, which is what
 * ADR-0004 ruling 8 asks for and what #18's own contract note anticipated.
 *
 * A `recordTier2Write` that arrives with no ambient context **throws** rather than
 * inventing one. ADR-0005 ruling 8 rejected server-synthesized summaries ("只有字段回声,
 * 没有「依据什么」"), and a commit whose stated basis is a fiction is worse than a loud
 * wiring error.
 *
 * ## The derived-residue sweep, and why it exists
 *
 * Measured, not assumed: `SemanticGroundingCore.updateTableMeta` / `syncWrite` run the
 * on-write enrichment hook (`autoEnrich`, default **true**) *after* the Tier-2 record,
 * and that hook calls `enrichAll*` **without** `Tier2Opts`. On a corpus with a DIM table
 * whose primary key matches a DWS column, a probe showed `dimension_refs` landing on
 * disk after the audit commit, leaving the worktree dirty with machine-derived content
 * no commit covered. Left alone that costs two real failures:
 *
 * - the **next** write's `git add -A` sweeps those bytes into *its* commit, stamping
 *   `X-SG-Derivation: agent` on content a deterministic round produced — precisely the
 *   provenance corruption ruling 10's trailers exist to prevent;
 * - on restart the posture check finds dirty + no lock and **refuses startup**, so the
 *   server poisons its own next boot.
 *
 * The hook runs inside `fn()`, so the residue appears while `runAudited` still holds the
 * lock. It is committed there as a **separate** commit carrying
 * `X-SG-Derivation: deterministic` — never folded into the agent's commit, because one
 * trailer cannot honestly carry two derivations. Routing `enrichAll*` through the
 * recorder with `beginBatch` so one round is one commit by construction is ADR-0004
 * ruling 3's job and lands with #21; this keeps the invariant true until then.
 *
 * The sweep's summary *is* server-written, which looks like it contradicts ADR-0005
 * ruling 8 and does not: that ruling refuses to invent the basis of an **agent's**
 * write, where the reasoning lives only in the agent. A deterministic round's basis is
 * fully known to the server — the round, and the write that triggered it — so stating it
 * is reporting, not fabrication.
 *
 * @module git/recorder
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { StaleBaselineError } from '@semantic-grounding/substrate'
import type { Tier2RecordMeta, Tier2Recorder } from '@semantic-grounding/substrate'
import { CommitFailedError, MissingAuditContextError, PostureRefusedError, StaleBaselineRejection } from '../errors.ts'
import { git, gitOut, gitTry } from './exec.ts'
import { CorpusLock, type CorpusLockOptions } from './lock.ts'
import {
  agentIdentity,
  commitEnv,
  corpusNameFrom,
  DEFAULT_SERVER_IDENTITY,
  requireAgentId,
  type GitIdentity,
} from './identity.ts'
import { buildCommitMessage, type CommitContext, type Derivation } from './message.ts'
import { dirtyEntries, resolveRepoPaths, type RepoPaths } from './posture.ts'

/** Construction-time configuration, supplied by the server entry point (#22). */
export interface GitRecorderConfig {
  /** The corpus repository root (must be the repo root — ADR-0004 ruling 5). */
  readonly corpusRoot: string
  /** The writing agent, declared at startup; absence refuses construction (ruling 9). */
  readonly agentId: string
  /** The scope this process serves, recorded in `X-SG-Scope` (v1: one process, one scope). */
  readonly scopeId?: string
  /** Session id recorded in `X-SG-Session`, when the host tracks one. */
  readonly sessionId?: string
  /** Client application name from `_meta.clientInfo.name` — `X-SG-Client`, reference only. */
  readonly clientName?: string
  /** Override the agent email pattern (`{agent}` / `{corpus}` placeholders). */
  readonly agentEmailPattern?: string
  /** Override the corpus name used in the agent's email namespace (default: the root's base name). */
  readonly corpusName?: string
  /** Override the committer identity (default: {@link DEFAULT_SERVER_IDENTITY}). */
  readonly serverIdentity?: GitIdentity
  /** Lock timeout / poll / heartbeat / staleness overrides (ruling 7: "可配"). */
  readonly lock?: CorpusLockOptions
  /** Pre-resolved repository paths, when the caller already ran the posture check. */
  readonly paths?: RepoPaths
}

/** The per-call half of an audit record — what only the calling tool knows. */
export interface AuditContext {
  /** The intent tool driving this write; becomes the subject verb and `X-SG-Tool`. */
  readonly tool: string
  /** What is being written (a table/event name, or a phrase for a multi-target write). */
  readonly target: string
  /** One line: what changed and on what basis. */
  readonly summary: string
  /** How the content came to be. Tools may only pass `agent` or `llm` (ADR-0005 ruling 7). */
  readonly derivation: Derivation
  /** The caller's own confidence, 0–1. */
  readonly confidence: number
  /**
   * Per-call client application name, overriding the configured one.
   *
   * `clientInfo` is per-request envelope data under the 2026-07-28 revision, not a
   * startup-channel value (ADR-0005's 2026-10-09 addendum, #22's measurement:
   * `serveStdio`'s factory ctx carries only `{era}`, and `_meta['io.modelcontextprotocol/
   * clientInfo']` is readable only from inside a request handler, where it can also
   * legitimately differ request-to-request on one connection). This is the slot a tool
   * handler reads it into: pass `extra.mcpReq.envelope['io.modelcontextprotocol/
   * clientInfo']?.name` here, read fresh on every call, never cached at construction.
   */
  readonly clientName?: string
  /** Per-call session id, overriding the configured one. */
  readonly sessionId?: string
  /** Files in this commit — batch callers only (#21). */
  readonly files?: number
  /** Enrichment rounds folded into this commit — batch callers only (#21). */
  readonly rounds?: number
}

/** What one `recordTier2Write` did. */
export interface RecordOutcome {
  /** The commit sha, or the unchanged HEAD when nothing was staged (`''` on an unborn HEAD). */
  readonly commit: string
  /** False when the write was byte-identical and produced no commit (ADR-0005 ruling 8). */
  readonly changed: boolean
  /** How many files the commit carried. */
  readonly files: number
}

/** The result of {@link GitTier2Recorder.runAudited}. */
export interface AuditedResult<T> extends RecordOutcome {
  /** Whatever the wrapped substrate call returned. */
  readonly value: T
  /**
   * Set when the on-write enrichment hook wrote derived content that needed its own
   * `deterministic` commit — see this module's header on the residue sweep.
   */
  readonly derivedCommit?: string
}

/** One staged path and whether it exists in HEAD (decides how it is rolled back). */
interface StagedPath {
  readonly path: string
  readonly inHead: boolean
}

/**
 * Accumulates what happened inside one `runAudited` window.
 *
 * A window can produce more than one commit: `syncWrite` calls `recordTier2Write` once
 * per table (ADR-0004 ruling 3's "302 表 = 302 commit" problem, which `beginBatch` will
 * solve in #21). Summing here rather than keeping the last outcome is what makes the
 * reported `files` count true for a batch instead of always 1.
 */
interface AuditWindow {
  commits: string[]
  files: number
}

/**
 * Tier-2 recorder backed by the corpus repository's own git history.
 *
 * Fail-loud by construction: a commit that cannot be made raises, which the substrate
 * reads as "this write did not happen" and rolls back. That is the difference between
 * this recorder and a deliberately fail-silent one (dsh's `ctx.audit`) — same contract,
 * and only this one makes D5's second half mean anything (GLOSSARY § Tier-2 recorder).
 */
export class GitTier2Recorder implements Tier2Recorder {
  /** The corpus repository root. */
  readonly corpusRoot: string
  private readonly author: GitIdentity
  private readonly committer: GitIdentity
  private readonly cfg: GitRecorderConfig
  private readonly agentId: string
  private corpusLock: CorpusLock
  private paths: RepoPaths | undefined
  /** The ambient audit context published by `runAudited` for the duration of `fn`. */
  private current: AuditContext | undefined
  /** The accumulator for the innermost open `runAudited` window. */
  private window: AuditWindow | undefined

  /**
   * @param cfg - corpus root, agent identity, scope/session/client metadata, lock tuning.
   * @throws IdentityMissingError when no usable agent id was declared (ruling 9).
   */
  constructor(cfg: GitRecorderConfig) {
    this.cfg = cfg
    this.corpusRoot = cfg.corpusRoot
    this.agentId = requireAgentId(cfg.agentId)
    this.author = agentIdentity({
      agentId: this.agentId,
      corpusName: cfg.corpusName ?? corpusNameFrom(cfg.corpusRoot),
      ...cfg.agentEmailPattern !== undefined ? { emailPattern: cfg.agentEmailPattern } : {},
    })
    this.committer = cfg.serverIdentity ?? DEFAULT_SERVER_IDENTITY
    this.paths = cfg.paths
    // The lock path needs the git dir, which needs a subprocess. Construction stays
    // synchronous (the entry point builds this before anything is async-ready), so the
    // lock is created against the conventional path and re-pointed by `ready()` if git
    // reports a different git dir — the linked-worktree case `lock.ts` documents.
    this.corpusLock = new CorpusLock(cfg.paths?.gitDir ?? join(cfg.corpusRoot, '.git'), this.agentId, cfg.lock ?? {})
  }

  /** The repo-wide corpus write lock (ADR-0004 ruling 7). */
  get lock(): CorpusLock {
    return this.corpusLock
  }

  /** The commit author (the writing agent) — exposed for the startup banner and tests. */
  get authorIdentity(): GitIdentity {
    return this.author
  }

  /** The committer (this server) — exposed for the startup banner and tests. */
  get committerIdentity(): GitIdentity {
    return this.committer
  }

  /**
   * Resolve and cache the repository paths, re-pointing the lock when the git dir is not
   * `<corpusRoot>/.git` (a linked worktree).
   * @returns the repository's git dir and worktree root.
   * @throws PostureRefusedError when the corpus is not a git repository.
   */
  async ready(): Promise<RepoPaths> {
    if (this.paths !== undefined) return this.paths
    const paths = await resolveRepoPaths(this.corpusRoot)
    this.paths = paths
    if (paths.gitDir !== join(this.corpusRoot, '.git') && !this.corpusLock.isHeld) {
      this.corpusLock = new CorpusLock(paths.gitDir, this.agentId, this.cfg.lock ?? {})
    }
    return paths
  }

  /**
   * Run a substrate write under the corpus lock with an audit context published.
   *
   * This is the only correct way to drive a Tier-2 write against this recorder — see the
   * module header for why the seam is here and not in `recordTier2Write`.
   * @param ctx - the intent behind this write: tool, target, summary, derivation, confidence.
   * @param fn - the substrate call (a `SemanticGroundingCore` Tier-2 method).
   * @returns the call's own result plus the commit, whether anything changed, and the
   *   file count — ADR-0005 ruling 8's response contract minus `enrichment_health`,
   *   which the tool layer inlines from the Core it holds (#20).
   * @throws PostureRefusedError when the worktree is dirty before the write (see below).
   * @throws StaleBaselineRejection when `expected_version` no longer matches, re-mapped
   *   from the substrate's `StaleBaselineError` onto a coded, retryable error.
   * @throws LockTimeoutError, CommitFailedError, or whatever `fn` itself throws.
   */
  async runAudited<T>(ctx: AuditContext, fn: () => Promise<T>): Promise<AuditedResult<T>> {
    const paths = await this.ready()
    return this.lock.withLock(async () => {
      await this.assertCleanBeforeWrite(paths)
      const entryHead = await this.head()
      const previousCtx = this.current
      const previousWindow = this.window
      const window: AuditWindow = { commits: [], files: 0 }
      this.current = ctx
      this.window = window
      let value: T
      try {
        value = await fn()
      } catch (e) {
        throw remapStaleBaseline(e)
      } finally {
        this.current = previousCtx
        this.window = previousWindow
      }
      const derived = await this.commitDerivedResidue(ctx, paths)
      const last = window.commits.at(-1)
      return {
        value,
        commit: last ?? entryHead,
        changed: window.commits.length > 0,
        files: window.files,
        ...derived !== undefined ? { derivedCommit: derived } : {},
      }
    })
  }

  /**
   * Record one Tier-2 write as a commit. Called by the substrate from inside its write
   * paths; see the module header before calling it directly.
   * @param toolName - the substrate's own name for the write path (e.g. `update_table_meta`).
   * @param payload - the substrate's payload; unused for the message, which carries the
   *   calling tool's intent instead (ADR-0005 ruling 1 rejected field echoes as subjects).
   * @param opts - scope/session metadata the substrate forwards.
   * @returns the commit sha, or the unchanged HEAD when the write was a byte-identical
   *   no-op (ADR-0005 ruling 8: an idempotent write produces no commit).
   * @throws MissingAuditContextError when called outside {@link runAudited}.
   * @throws CommitFailedError when staging or committing fails; the index and worktree
   *   are restored first, so the substrate's own rollback lands on a clean slate.
   */
  async recordTier2Write(toolName: string, payload: unknown, opts?: Tier2RecordMeta): Promise<string> {
    const ctx = this.current
    if (ctx === undefined) {
      throw new MissingAuditContextError(
        `Tier-2 write "${toolName}" reached the git recorder with no audit context: wrap the substrate call in GitTier2Recorder.runAudited({ tool, target, summary, derivation, confidence }, ...). The recorder will not synthesize a summary — a commit whose stated basis is invented is worse than a loud wiring error (ADR-0005 ruling 8).`,
        { substrate_tool: toolName, payload_keys: payloadKeys(payload) },
      )
    }
    const paths = await this.ready()
    const outcome = await this.lock.withLock(() => this.stageAndCommit(this.commitContext(ctx, opts), paths))
    if (outcome.changed && this.window !== undefined) {
      this.window.commits.push(outcome.commit)
      this.window.files += outcome.files
    }
    return outcome.commit
  }

  /**
   * Merge the per-call context with construction-time metadata into the full commit
   * context. Scope/session prefer the substrate's forwarded values, which carry the
   * Core's active scope when the host overrode it per call. Client name mirrors the
   * session-id pattern: the per-call value (read from the request envelope by the tool
   * handler) wins over the configured one — which #22 deliberately leaves unset,
   * because a startup-time value would be a *process-wide* default standing in for
   * data that is legitimately per-request (this module's `clientName` field doc).
   * @param ctx - the per-call audit context.
   * @param opts - scope/session metadata forwarded by the substrate.
   * @returns the assembled {@link CommitContext}.
   */
  private commitContext(ctx: AuditContext, opts?: Tier2RecordMeta): CommitContext {
    const clientName = firstNonEmpty(ctx.clientName, this.cfg.clientName)
    const scopeId = firstNonEmpty(opts?.scope_id, this.cfg.scopeId)
    const sessionId = firstNonEmpty(opts?.session_id, ctx.sessionId, this.cfg.sessionId)
    return {
      tool: ctx.tool,
      target: ctx.target,
      summary: ctx.summary,
      derivation: ctx.derivation,
      confidence: ctx.confidence,
      agentId: this.agentId,
      ...clientName !== undefined ? { clientName } : {},
      ...scopeId !== undefined ? { scopeId } : {},
      ...sessionId !== undefined ? { sessionId } : {},
      ...ctx.files !== undefined ? { files: ctx.files } : {},
      ...ctx.rounds !== undefined ? { rounds: ctx.rounds } : {},
    }
  }

  /**
   * Stage the worktree and commit it as the audit record.
   *
   * Staging is `git add -A` over the whole worktree rather than a pathspec: ADR-0004
   * ruling 5 deferred narrowing commits by path, and the startup posture check plus
   * {@link assertCleanBeforeWrite} are what make the broad stage precise — the only
   * changes present are the ones this write just made.
   * @param ctx - the assembled commit context.
   * @param paths - the repository paths.
   * @returns the {@link RecordOutcome}.
   * @throws CommitFailedError after restoring the index and worktree.
   */
  private async stageAndCommit(ctx: CommitContext, paths: RepoPaths): Promise<RecordOutcome> {
    const cwd = paths.toplevel
    try {
      await git(['add', '-A'], { cwd })
    } catch (e) {
      throw new CommitFailedError(`failed to stage the Tier-2 write for ${ctx.target}: ${(e as Error).message}`, {
        tool: ctx.tool,
        target: ctx.target,
      })
    }
    const staged = await this.stagedPaths(cwd)
    if (staged.length === 0) {
      // Idempotent no-op (ADR-0005 ruling 8): adding an alias that already exists
      // rewrites identical bytes. An empty commit here would be audit-history noise
      // claiming a change that did not happen.
      return { commit: await this.head(), changed: false, files: 0 }
    }
    const message = buildCommitMessage(ctx)
    const res = await gitTry(['commit', '--quiet', '--file', '-'], {
      cwd,
      env: commitEnv(this.author, this.committer),
      stdin: message,
    })
    if (res.code !== 0) {
      // Fail-loud, and leave nothing behind: the substrate is about to restore the
      // definition's raw bytes, and it must not find a half-staged index underneath.
      await this.rollbackStaged(cwd, staged)
      throw new CommitFailedError(
        `failed to commit the Tier-2 audit record for ${ctx.tool}(${ctx.target}); the write has been rolled back: ${res.stderr.trim() || res.stdout.trim()}`,
        { tool: ctx.tool, target: ctx.target, exit_code: res.code, git_stderr: res.stderr.trim(), files: staged.map(s => s.path) },
      )
    }
    return { commit: await this.head(), changed: true, files: staged.length }
  }

  /**
   * Commit whatever the on-write enrichment hook left behind, as its own
   * `deterministic` commit. See the module header for why this exists.
   * @param ctx - the audit context of the write that triggered the hook.
   * @param paths - the repository paths.
   * @returns the derived commit's sha, or undefined when the hook wrote nothing.
   */
  private async commitDerivedResidue(ctx: AuditContext, paths: RepoPaths): Promise<string | undefined> {
    if ((await dirtyEntries(paths.toplevel)).length === 0) return undefined
    const outcome = await this.stageAndCommit({
      tool: 'enrich_on_write',
      target: ctx.target,
      summary: `${ctx.tool} 触发的确定性 enrichment 轮写回（dimension_refs / alt_labels）`,
      derivation: 'deterministic',
      // A deterministic round derives by construction rather than guessing, so 1 is the
      // honest value — not a default standing in for an unknown.
      confidence: 1,
      agentId: this.agentId,
      ...this.cfg.clientName !== undefined ? { clientName: this.cfg.clientName } : {},
      ...this.cfg.scopeId !== undefined ? { scopeId: this.cfg.scopeId } : {},
      ...this.cfg.sessionId !== undefined ? { sessionId: this.cfg.sessionId } : {},
    }, paths)
    return outcome.changed ? outcome.commit : undefined
  }

  /**
   * Refuse to write over a worktree that was already dirty.
   *
   * ADR-0004 ruling 6 settled this at startup; `git add -A` makes it matter at every
   * write too. Proceeding would stage an operator's uncommitted edit into the agent's
   * commit, attributing a human's work to a machine — the same mis-attribution ruling 6
   * refused to risk, and the same reason it rejected auto-cleaning ("人工手改不是数据丢失").
   * @param paths - the repository paths.
   * @throws PostureRefusedError when the worktree is dirty before this write.
   */
  private async assertCleanBeforeWrite(paths: RepoPaths): Promise<void> {
    const dirty = await dirtyEntries(paths.toplevel)
    if (dirty.length === 0) return
    throw new PostureRefusedError(
      `corpus ${paths.toplevel} has ${dirty.length} uncommitted change(s) that this write did not make, and an audit commit stages the whole worktree — committing now would attribute them to the writing agent`,
      'commit or stash the local changes in the corpus, then retry',
      { toplevel: paths.toplevel, dirty },
    )
  }

  /**
   * List staged paths, classified by whether HEAD has them.
   *
   * The classification decides the rollback strategy, and it is read per path rather
   * than inferred from `--name-status` letters: `git restore --source=HEAD` fails
   * outright on a path HEAD does not contain (measured), so getting this wrong turns a
   * rollback into a second error on top of the first.
   * @param cwd - the worktree root.
   * @returns the staged paths with their HEAD membership.
   */
  private async stagedPaths(cwd: string): Promise<StagedPath[]> {
    const out = (await git(['diff', '--cached', '--name-only', '-z'], { cwd })).stdout
    const names = out.split('\0').filter(n => n !== '')
    const classified: StagedPath[] = []
    for (const path of names) {
      const probe = await gitTry(['cat-file', '-e', `HEAD:${path}`], { cwd })
      classified.push({ path, inHead: probe.code === 0 })
    }
    return classified
  }

  /**
   * Undo staging after a failed commit, leaving index and worktree as HEAD describes
   * them — the recorder's half of ADR-0004 ruling 1's rollback (the substrate restores
   * the definition's raw bytes; these two layers each own one surface).
   * @param cwd - the worktree root.
   * @param staged - the paths this attempt staged.
   */
  private async rollbackStaged(cwd: string, staged: readonly StagedPath[]): Promise<void> {
    const known = staged.filter(s => s.inHead).map(s => s.path)
    const fresh = staged.filter(s => !s.inHead).map(s => s.path)
    if (known.length > 0) {
      await gitTry(['restore', '--staged', '--worktree', '--source=HEAD', '--', ...known], { cwd })
    }
    if (fresh.length > 0) {
      // Not in HEAD, so there is no content to restore: unstage, then remove the file
      // this write created. `git rm --cached` handles the unborn-HEAD case too, where
      // every staged path is new by definition.
      await gitTry(['rm', '--cached', '--quiet', '--force', '--', ...fresh], { cwd })
      for (const path of fresh) {
        rmSync(join(cwd, path), { force: true })
      }
    }
  }

  /**
   * @returns HEAD's sha, or `''` when the repository has no commits yet (a legal
   *   starting posture — the audit history's first commit creates HEAD).
   */
  private async head(): Promise<string> {
    const paths = await this.ready()
    const res = await gitTry(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: paths.toplevel })
    return res.code === 0 ? res.stdout.trim() : ''
  }

  /**
   * Read a commit's trailers back — the readback half of ADR-0004's verification
   * ("trailers round-trip through `git log --format=%(trailers)`"), useful to the
   * end-to-end gate and to anything auditing history.
   * @param commit - the commit-ish to read (default HEAD).
   * @returns the `X-SG-*` trailers as a key/value map, keys without the prefix.
   */
  async readTrailers(commit = 'HEAD'): Promise<Record<string, string>> {
    const paths = await this.ready()
    const out = await gitOut(['log', '-1', '--format=%(trailers:only=true,unfold=true)', commit], {
      cwd: paths.toplevel,
    })
    const trailers: Record<string, string> = {}
    for (const line of out.split('\n')) {
      const sep = line.indexOf(':')
      if (sep <= 0) continue
      const key = line.slice(0, sep).trim()
      if (!key.startsWith('X-SG-')) continue
      trailers[key.slice('X-SG-'.length)] = line.slice(sep + 1).trim()
    }
    return trailers
  }
}

/**
 * Re-map the substrate's `StaleBaselineError` onto this surface's coded, retryable
 * error, leaving every other failure untouched.
 * @param e - the error thrown by a substrate write.
 * @returns a {@link StaleBaselineRejection} for a stale baseline, otherwise `e` itself.
 */
function remapStaleBaseline(e: unknown): unknown {
  if (e instanceof StaleBaselineError) {
    return new StaleBaselineRejection(`${e.message} (stale baseline — re-read the definition and retry with its new version)`)
  }
  return e
}

/**
 * @param values - candidate strings, in priority order.
 * @returns the first non-empty one, or undefined.
 */
function firstNonEmpty(...values: ReadonlyArray<string | undefined>): string | undefined {
  for (const v of values) {
    if (v !== undefined && v.trim() !== '') return v
  }
  return undefined
}

/**
 * @param payload - the substrate's record payload.
 * @returns its top-level keys, for the diagnostic on a contextless write (the values
 *   can hold definition content and have no place in an error message).
 */
function payloadKeys(payload: unknown): string[] {
  return typeof payload === 'object' && payload !== null ? Object.keys(payload) : []
}

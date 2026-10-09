/**
 * Startup posture checks — the deployment shapes the git backbone can and cannot audit
 * (ADR-0004 rulings 5 and 6).
 *
 * Run once, at startup, before the server accepts a single tool call. Discovering that a
 * corpus is not a git repository on the *first write* would mean failing a call the
 * agent had every reason to expect to work, after the substrate already wrote the file.
 *
 * ## Ruling 5 — the corpus is its own repository, rooted at its own root
 *
 * Not a git repo at all: refused, because the audit record *is* the commit. A JSONL
 * fallback was considered and rejected, since it reintroduces the two-datasets-that-can
 * disagree problem that made git win in the first place.
 *
 * Nested in a larger repository: also refused. `git rev-parse --show-toplevel` from a
 * subdirectory returns the *outer* repository's root, so a corpus sitting inside a
 * monorepo would silently commit into that monorepo's history, mixing audit commits with
 * unrelated application history and putting `git add -A` in charge of the whole thing.
 * Comparing the corpus root against the toplevel catches exactly this.
 *
 * ## Ruling 6 — four postures, four answers
 *
 * | worktree | lock                | action                                               |
 * |----------|---------------------|------------------------------------------------------|
 * | clean    | (any)               | start                                                |
 * | dirty    | none                | refuse — a hand edit is not data to be thrown away   |
 * | dirty    | holder dead/expired | crash residue: restore to HEAD, release, log loudly  |
 * | dirty    | holder alive        | refuse — a second server is already writing          |
 *
 * The first row is deliberately indifferent to the lock. A live lock over a clean tree is
 * just another server mid-commit, and cross-process serialization is a *supported* mode
 * (ruling 7: "排队 = 等锁本身"), so refusing there would forbid the concurrency the lock
 * was built to provide.
 *
 * Ruling 6 also rejected both extremes: auto-cleaning any dirty tree (a human's
 * uncommitted edit is data loss) and refusing every dirty tree (crash residue would then
 * wedge the corpus permanently, needing manual recovery after every crash). The dead
 * lock is the evidence that distinguishes them.
 *
 * **The accepted edge case**, recorded in ADR-0004's consequences and documented here
 * because this is the code that does it: a human hand-edit that happens to coincide with
 * a stale lock left by a crashed writer is restored away. The alternative is a corpus
 * that needs a human after every crash, and the window is a crashed server plus an
 * uncommitted manual edit at the same moment.
 *
 * ## Why a clean tree is load-bearing, not hygiene
 *
 * ADR-0004 ruling 5 deferred narrowing commits with a pathspec, so the recorder stages
 * with `git add -A`. That is only precise because this check guarantees the tree held
 * nothing else when the server started — the posture check is what makes the staging
 * strategy sound.
 *
 * @module git/posture
 */
import { realpathSync } from 'node:fs'
import { PostureRefusedError } from '../errors.ts'
import { gitOut, gitTry } from './exec.ts'
import { CorpusLock, type LockRecord, type OwnerState } from './lock.ts'

/** Where a corpus repository's git metadata and working tree live. */
export interface RepoPaths {
  /** `git rev-parse --absolute-git-dir` — holds the corpus lock, outside the worktree. */
  readonly gitDir: string
  /** `git rev-parse --show-toplevel` — the working tree root, which must be the corpus root. */
  readonly toplevel: string
}

/** The posture found at startup, after any recovery. */
export type StartupPosture =
  /** Working tree was clean; nothing to do. */
  | 'clean'
  /** Crash residue was found behind an abandoned lock and restored to HEAD. */
  | 'recovered'

/** What {@link ensureStartupPosture} found and did. */
export interface PostureReport {
  readonly posture: StartupPosture
  readonly paths: RepoPaths
  /** Present when `posture` is `recovered`: what was discarded and whose lock proved it was residue. */
  readonly recovery?: {
    readonly discarded: readonly string[]
    readonly lockHolder: LockRecord | null
    readonly ownerState: OwnerState
  }
}

/** Sink for the loud log ruling 6 requires on recovery. */
export type PostureLogger = (message: string) => void

/**
 * Default logger: **stderr**, never stdout.
 *
 * The server speaks JSON-RPC over stdio, and #14's research confirms stderr is the
 * protocol's official log channel. A recovery notice on stdout would be parsed as a
 * malformed protocol message by the client.
 * @param message - the line to log.
 */
export const defaultPostureLogger: PostureLogger = message => {
  process.stderr.write(`${message}\n`)
}

/**
 * Resolve a corpus root to its repository paths.
 * @param corpusRoot - the configured corpus directory.
 * @returns the git dir and worktree toplevel.
 * @throws PostureRefusedError when `corpusRoot` is not inside a git repository, or does
 *   not exist.
 */
export async function resolveRepoPaths(corpusRoot: string): Promise<RepoPaths> {
  const probe = await gitTry(['rev-parse', '--absolute-git-dir', '--show-toplevel'], { cwd: corpusRoot })
  if (probe.code !== 0) {
    throw new PostureRefusedError(
      `corpus ${corpusRoot} is not a git repository, and the git history IS the audit record for every Tier-2 write (ADR-0004 ruling 5)`,
      `run \`git init\` in ${corpusRoot} and make an initial commit`,
      { corpus_root: corpusRoot, git_stderr: probe.stderr.trim() },
    )
  }
  const lines = probe.stdout.trim().split('\n')
  const gitDir = lines[0]?.trim() ?? ''
  const toplevel = lines[1]?.trim() ?? ''
  if (gitDir === '' || toplevel === '') {
    throw new PostureRefusedError(
      `could not resolve the git dir and worktree root for corpus ${corpusRoot}`,
      'check that the corpus path is a normal git working tree (not a bare repository)',
      { corpus_root: corpusRoot, stdout: probe.stdout },
    )
  }
  return { gitDir, toplevel }
}

/**
 * Enforce ruling 5: the corpus root must *be* the repository root.
 *
 * Compares canonical paths, not strings. `--show-toplevel` returns a fully resolved
 * path, so a corpus configured through a symlink — `/tmp/corpus` where `/tmp` is a
 * symlink to `/private/tmp`, the default on macOS — compares unequal as raw text while
 * naming the same directory. A string comparison here rejects legitimate corpora, which
 * measurement caught before this code existed.
 * @param corpusRoot - the configured corpus directory.
 * @param paths - the resolved repository paths.
 * @throws PostureRefusedError when the corpus is a subdirectory of a larger repository.
 */
export function assertCorpusIsRepoRoot(corpusRoot: string, paths: RepoPaths): void {
  const canonical = canonicalize(corpusRoot)
  const top = canonicalize(paths.toplevel)
  if (canonical === top) return
  throw new PostureRefusedError(
    `corpus ${corpusRoot} is not a repository root — it sits inside the repository at ${paths.toplevel}, so audit commits would land in that repository's history and \`git add -A\` would stage unrelated files (ADR-0004 ruling 5)`,
    `make the corpus its own repository (\`git init\` in ${corpusRoot}, with the corpus content no longer tracked by the outer repository), or point the server at ${paths.toplevel}`,
    { corpus_root: corpusRoot, canonical_corpus_root: canonical, toplevel: paths.toplevel },
  )
}

/**
 * Canonicalize a path for comparison.
 * @param path - the path to resolve.
 * @returns the realpath, or the input unchanged when it cannot be resolved (a
 *   nonexistent path is reported by the git probe with a better message than this
 *   helper could produce).
 */
function canonicalize(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * List the working tree's dirty entries.
 * @param cwd - any directory inside the repository.
 * @returns one entry per `git status --porcelain` line. Untracked files are included
 *   deliberately: a definition the substrate created but never committed is *untracked*,
 *   and that is precisely the crash residue ruling 6 exists to detect. `.gitignore` is
 *   honoured by git, so ignored build output never counts as dirt.
 */
export async function dirtyEntries(cwd: string): Promise<string[]> {
  const out = await gitOut(['status', '--porcelain'], { cwd })
  return out === '' ? [] : out.split('\n')
}

/**
 * Whether the repository has no commits yet.
 * @param cwd - any directory inside the repository.
 * @returns true when HEAD does not resolve. A fresh `git init` is allowed to start —
 *   committing onto an unborn HEAD creates the root commit, and the audit history
 *   legitimately begins there — but recovery cannot run without a HEAD to restore to.
 */
export async function isUnbornHead(cwd: string): Promise<boolean> {
  return (await gitTry(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd })).code !== 0
}

/**
 * Run the startup posture checks, recovering crash residue when a dead lock proves it.
 * @param opts - corpus root, the agent id recorded in any lock this creates, lock
 *   tuning (staleness window), and the logger for the loud recovery notice.
 * @returns the {@link PostureReport} describing what was found and done.
 * @throws PostureRefusedError for every posture ruling 5 or 6 refuses.
 */
export async function ensureStartupPosture(opts: {
  readonly corpusRoot: string
  readonly agentId: string
  readonly lock?: ConstructorParameters<typeof CorpusLock>[2]
  readonly logger?: PostureLogger
}): Promise<PostureReport> {
  const log = opts.logger ?? defaultPostureLogger
  const paths = await resolveRepoPaths(opts.corpusRoot)
  assertCorpusIsRepoRoot(opts.corpusRoot, paths)

  const dirty = await dirtyEntries(paths.toplevel)
  if (dirty.length === 0) {
    // Row 1: clean, whatever the lock says. A live lock here is a peer server mid-write,
    // which ruling 7 supports by design.
    return { posture: 'clean', paths }
  }

  const lock = new CorpusLock(paths.gitDir, opts.agentId, opts.lock ?? {})
  const holder = lock.read()

  if (holder === null) {
    // Row 2: dirty, no lock. Nothing identifies this as machine residue, so it is
    // treated as a human's uncommitted work and left strictly alone.
    throw new PostureRefusedError(
      `corpus ${paths.toplevel} has ${dirty.length} uncommitted change(s) and no write lock, so they cannot be attributed to a crashed write — the git audit backbone needs a clean tree at startup, and discarding unexplained local changes would be data loss (ADR-0004 ruling 6)`,
      'commit the changes (`git add -A && git commit`) or set them aside (`git stash`), then restart',
      { toplevel: paths.toplevel, dirty },
    )
  }

  const ownerState = lock.inspect(holder)
  if (ownerState === 'alive') {
    // Row 4: dirty, live lock. A peer server is mid-write; its partial worktree is not
    // residue, and starting here would mean two servers racing on one index.
    throw new PostureRefusedError(
      `corpus ${paths.toplevel} is already being written by pid ${holder.pid} on ${holder.host} (agent ${holder.agent_id || 'unnamed'}), whose write is still in flight`,
      'wait for that server to finish, or stop it before starting another on the same corpus',
      { toplevel: paths.toplevel, dirty, holder },
    )
  }

  // Row 3: dirty behind an abandoned lock — a write that died mid-flight. The residue is
  // by construction unaudited (its commit never happened), so restoring to HEAD is what
  // makes "an unaudited write is not expressible" true across a crash.
  if (await isUnbornHead(paths.toplevel)) {
    throw new PostureRefusedError(
      `corpus ${paths.toplevel} holds crash residue from pid ${holder.pid} behind an abandoned lock (owner ${ownerState}), but the repository has no commits, so there is no HEAD to restore to`,
      'inspect the files and make an initial commit yourself (`git add -A && git commit -m "corpus baseline"`), then restart',
      { toplevel: paths.toplevel, dirty, holder, owner_state: ownerState },
    )
  }

  log(
    `[semantic-grounding] crash recovery: corpus ${paths.toplevel} had ${dirty.length} uncommitted change(s) behind an abandoned write lock `
    + `(pid ${holder.pid} on ${holder.host}, agent ${holder.agent_id || 'unnamed'}, owner ${ownerState}). `
    + `These are residue from a write whose audit commit never landed, so they are being restored to HEAD. Discarding: ${dirty.join(' | ')}`,
  )
  // `reset --hard` restores tracked files; `clean -fd` removes files the dead write
  // created, which `reset` leaves behind. `-x` is deliberately NOT passed: ignored paths
  // are the operator's (build output, local tooling) and were never part of the write.
  await gitTry(['reset', '--hard', '--quiet', 'HEAD'], { cwd: paths.toplevel })
  await gitTry(['clean', '-fdq'], { cwd: paths.toplevel })
  lock.breakIfAbandoned()

  const remaining = await dirtyEntries(paths.toplevel)
  if (remaining.length > 0) {
    throw new PostureRefusedError(
      `corpus ${paths.toplevel} is still dirty after restoring to HEAD (${remaining.length} entry/entries remain), so the recovery did not reach a clean tree`,
      'inspect the repository by hand (`git status`) and resolve it, then restart',
      { toplevel: paths.toplevel, remaining },
    )
  }
  log(`[semantic-grounding] crash recovery complete: ${paths.toplevel} restored to HEAD, write lock released`)

  return {
    posture: 'recovered',
    paths,
    recovery: { discarded: dirty, lockHolder: holder, ownerState },
  }
}

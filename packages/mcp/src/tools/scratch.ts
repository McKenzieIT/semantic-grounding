/**
 * ADR-0020's scratch home — `acquire_scratch_dir`, the server-managed landing
 * place for an agent's exploration drafts
 * ([#92](https://github.com/McKenzieIT/semantic-grounding/issues/92) /
 * [#101](https://github.com/McKenzieIT/semantic-grounding/issues/101)).
 *
 * An agent exploring ODPS before writing back works in bash — SQL dumps,
 * re-probed schemas, drafted YAML. Dropped in the corpus worktree, any of that
 * dirties `git status --porcelain`, and both clean-worktree gates (startup
 * `posture.ts` / per-write `recorder.ts`) mistake the agent's own scratch for
 * an operator's uncommitted edit and REFUSE the next Tier-2 write — the exact
 * collision #90 pinned at `scope.ts`'s "agent-in-bash" root. The home lives at
 * `<gitDir>/sg-scratch/<run-id>/`, the same placement reasoning as
 * `sg-pending/` and `sg-write.lock` (`tools/suggestions.ts`): the git dir is
 * outside the tree git tracks, so scratch is invisible to the gates by
 * construction, not by `.gitignore` discipline.
 *
 * Cleanup is the **server's** job, not the agent's (#92: otherwise the seam
 * only moves the pollution). Each call creates one run directory — the unit of
 * one exploration episode, and the isolation unit between concurrent agents
 * on the same scope — and prunes the home down to the newest N run
 * directories (default 3, `ServerConfig.scratchRunsToKeep`). No TTL: with
 * prune-on-acquire, runs only accumulate while someone keeps exploring, and
 * "keep the last three explorations" is the whole retention story.
 *
 * Like the Tier-1 suggestion quartet this is **not an audited mutation**: no
 * commit, no corpus lock, no recorder write — the only thing borrowed from the
 * recorder is its resolved git-dir path (`tools/suggestions.ts#pendingQueueRoot`'s
 * pattern), which is safe from a tool that never touches source-of-truth.
 *
 * @module tools/scratch
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { GitTier2Recorder } from '../git/recorder.ts'
import type { ServerDeps, ToolRegistrar } from '../server.ts'
import { scopeStamp, toolSuccess } from './audited.ts'
import type { ToolFamily } from './shared.ts'

/** The scratch-home tool names. */
export const SCRATCH_TOOL_NAMES = ['acquire_scratch_dir'] as const

/** The scratch home's directory name inside the git dir — same family as `sg-pending` / `sg-write.lock`. */
export const SCRATCH_HOME_DIRNAME = 'sg-scratch'

/** How many run directories survive an acquire's prune (#92: 保留最近 N 次,默认 N=3). */
export const DEFAULT_SCRATCH_RUNS_TO_KEEP = 3

/**
 * A run id: UTC timestamp + 6-hex nonce (`20261014T093012Z_a1b2c3`). Human-readable
 * (when a run was started is visible at a glance in `ls`), and the nonce separates
 * two acquires inside the same second (two agents, or one agent that called twice).
 * Same shape family as `pending.ts`'s suggestion ids, minus the content hash (a run
 * has no content at birth). The GC orders runs by mtime, not by this name — ids from
 * one second differ only by their random nonce, so name order is not acquisition order.
 */
const RUN_ID_RE = /^[0-9]{8}T[0-9]{6}Z_[0-9a-f]{6}$/

/** What one `acquire_scratch_dir` call hands back. */
export interface ScratchRunReceipt {
  /** The new run's id (also its directory name inside the scratch home). */
  readonly run_id: string
  /** The run directory's absolute path — `cd` here in bash. */
  readonly path: string
  /** Ids of the run directories this call's prune removed, oldest first. */
  readonly pruned: readonly string[]
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function runStamp(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T`
    + `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

/**
 * Prune the scratch home down to `keep` run directories, current one included.
 *
 * The run this acquire just created never enters the candidate set — a directory
 * handed to the agent must survive the very call that handed it out, whatever
 * the other mtimes look like (a future-dated mtime from clock skew must not
 * recycle the brand-new run underneath its recipient). Among the rest, "newest"
 * is by modification time, not by name: run ids from the same second differ
 * only by their random nonce, so name order is not acquisition order. mtime
 * also means a run an agent is still writing into keeps getting bumped to the
 * new end — the GC retires least-recently-touched runs, protecting in-flight
 * exploration over mere birth order. Ties break by name, which is arbitrary
 * but deterministic.
 *
 * Only directories matching {@link RUN_ID_RE} are candidates — anything else an
 * operator or tool dropped in the home is left alone (the `isValidId` filter's
 * philosophy: the GC deletes what it knows it owns, never what it cannot
 * recognize). Deletion is best-effort per directory: a file an agent still has
 * open makes `rmSync` fail (notably on Windows), and a run that cannot be
 * deleted now simply stays for the next acquire to retry — boundedness holds
 * because every acquire re-prunes.
 */
function pruneScratchRuns(home: string, keep: number, currentRunId: string): string[] {
  const others = readdirSync(home, { withFileTypes: true })
    .filter(e => e.isDirectory() && RUN_ID_RE.test(e.name) && e.name !== currentRunId)
    .map(e => ({ name: e.name, mtimeMs: statSync(join(home, e.name)).mtimeMs }))
    .sort((a, b) => a.mtimeMs !== b.mtimeMs ? a.mtimeMs - b.mtimeMs : a.name.localeCompare(b.name))
  const excess = others.slice(0, Math.max(0, others.length - (Math.max(1, keep) - 1)))
  const pruned: string[] = []
  for (const run of excess) {
    try {
      rmSync(join(home, run.name), { recursive: true, force: true })
      pruned.push(run.name)
    } catch {
      // Locked (an agent still holds a file open) — retried on the next acquire.
    }
  }
  return pruned
}

/**
 * Create one new scratch run directory under `<gitDir>/sg-scratch/` and prune
 * the home — the whole server-side seam in one call (#92: server 按需建 +
 * 确定性 GC,不靠 agent 自觉).
 * @param recorder - this process's recorder for the bound scope (used only for
 *   its resolved git dir, like `tools/suggestions.ts#pendingQueueRoot`).
 * @param keep - how many run directories to retain (values below 1 clamp to 1 —
 *   the run being created must survive its own acquire).
 * @returns the receipt: the new run's id and path, and what the prune removed.
 */
export async function acquireScratchRun(
  recorder: GitTier2Recorder,
  keep: number,
): Promise<ScratchRunReceipt> {
  const paths = await recorder.ready()
  const home = join(paths.gitDir, SCRATCH_HOME_DIRNAME)
  const runId = `${runStamp(new Date())}_${randomBytes(3).toString('hex')}`
  const runPath = join(home, runId)
  mkdirSync(runPath, { recursive: true })
  return { run_id: runId, path: runPath, pruned: pruneScratchRuns(home, keep, runId) }
}

/** Registers `acquire_scratch_dir`. */
function registerAcquireScratchDir(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'acquire_scratch_dir',
    {
      title: 'Acquire a scratch directory for this exploration run',
      description: 'Get a fresh directory for this exploration episode\'s intermediate files (SQL dumps, re-probed schemas, drafted YAML, notes) and cd to it in bash. It lives inside the git dir, OUTSIDE the corpus worktree: files you drop there never dirty the worktree and never trip the clean-worktree gate that guards every Tier-2 write — so explore freely, then write back through the definition write tools as usual. Every call starts a new run directory (the unit one exploration is collected in; concurrent explorers stay isolated); the server garbage-collects, keeping only the most recent few runs (see `retention` in the response) — nothing in scratch is committed, audited, or durable. This replaces dropping exploration files anywhere in the corpus.',
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const snap = deps.bindings.requireSnapshot()
      const keep = deps.config.scratchRunsToKeep ?? DEFAULT_SCRATCH_RUNS_TO_KEEP
      const run = await acquireScratchRun(snap.recorder, keep)
      return toolSuccess({
        scope: scopeStamp(snap),
        run_id: run.run_id,
        path: run.path,
        retention: { keeps_last: Math.max(1, keep), pruned_run_ids: run.pruned },
      })
    },
  )
}

/** Registers the scratch-home tool. */
export const registerScratchTools: ToolRegistrar = (server, deps) => {
  registerAcquireScratchDir(server, deps)
}

/** The scratch-home family's descriptor card (#115): its names and registrar bound in
 * one place, for `tools/index.ts` to compose — never a second copy of either key. */
export const SCRATCH_TOOL_FAMILY: ToolFamily = { names: SCRATCH_TOOL_NAMES, register: registerScratchTools }

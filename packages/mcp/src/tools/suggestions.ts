/**
 * ADR-0005's Tier-1 suggestion quartet: `submit_suggestion`, `list_suggestions`,
 * `get_suggestion`, `discard_suggestion`.
 *
 * These compile onto the substrate's pending-queue functions (`submit` / `listing` /
 * `loadPending` / `discard`, `pending.ts`, public barrel) with no Tier-2 common
 * parameter block at all — no `summary`/`derivation`/`confidence`/`expected_version`,
 * no `GitTier2Recorder.runAudited`, no commit (ADR-0005 ruling 7: "Tier-1 无此参";
 * GLOSSARY § write tier: "not an auditable mutation; no recorder needed"). The only
 * thing borrowed from the recorder is its resolved git-dir path, to place the queue
 * outside the worktree — see {@link pendingQueueRoot}'s doc for why that placement is
 * load-bearing, not a style choice.
 *
 * Tier-1 has no `approve`: "approving" a suggestion means issuing the corresponding
 * Tier-2 write yourself (`update_definition` / `add_alias` / ...) and then calling
 * `discard_suggestion` on the entry that prompted it (GLOSSARY § pending queue).
 *
 * @module tools/suggestions
 */
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/server'
import { discard, listing, loadPending, submit } from '@semantic-grounding/substrate'
import { z } from 'zod'
import { SuggestionNotFoundError } from '../errors.ts'
import type { GitTier2Recorder } from '../git/recorder.ts'
import type { ServerDeps, ToolRegistrar } from '../server.ts'
import { scopeStamp, toolSuccess } from './audited.ts'
import type { ToolFamily } from './shared.ts'

// ── Tier-1 pending queue location ────────────────────────────────────────────────────
// (#145: moved from `tools/shared.ts` — this family is the queue path's one consumer.)

/** The pending-queue directory name inside the git dir. */
export const PENDING_QUEUE_DIRNAME = 'sg-pending'

/**
 * Resolve the Tier-1 pending-queue directory for this process's corpus.
 *
 * `<gitDir>/sg-pending/`, not somewhere in the worktree — the exact reasoning
 * `git/lock.ts` already states for the corpus lock, applied to the same hazard: a
 * suggestion JSON file inside the worktree would be corpus *content*. `git status
 * --porcelain` would report it as an untracked, uncommitted change (`dirtyEntries`,
 * `git/posture.ts`, deliberately counts untracked files as dirt), so submitting a
 * suggestion would make the *next Tier-2 write* refuse with `PostureRefusedError` —
 * mistaking an agent's own suggestion for an operator's uncommitted edit. The git dir is
 * outside the tree git tracks, which is exactly the property both the lock and the
 * pending queue need, and reusing it needs no new corpus-level `.gitignore` entry this
 * package would otherwise have to ask the operator to add.
 *
 * Tier-1 never takes the corpus lock or writes a commit (GLOSSARY § write tier: "not an
 * auditable mutation; no recorder needed") — this only reads {@link GitTier2Recorder.ready}
 * for the git dir path, which is safe to call from a read-only tool.
 * @param recorder - this process's recorder (used only for its resolved git dir).
 * @returns the pending-queue directory's absolute path.
 */
export async function pendingQueueRoot(recorder: GitTier2Recorder): Promise<string> {
  const paths = await recorder.ready()
  return join(paths.gitDir, PENDING_QUEUE_DIRNAME)
}

/** The four Tier-1 tool names. */
export const SUGGESTION_TOOL_NAMES = ['submit_suggestion', 'list_suggestions', 'get_suggestion', 'discard_suggestion'] as const

const SubmitSuggestionInputSchema = z.object({
  kind: z.string().min(1).describe('A free-text category for this suggestion (e.g. "alt_label", "dimension_ref") — the pending queue does not constrain it.'),
  subject: z.string().min(1).describe('What this suggestion is about, typically a table_name or event name.'),
  content: z.string().min(1).describe('The suggested content, in whatever shape `kind` implies.'),
  // #176: no `scope_id`/`tenant_id` here — ADR-0005 ruling 7's "no scope params on
  // Tier-1" was always the canon; these two were an early passthrough with zero
  // consumers repo-wide. zod's default strip means a legacy client still sending
  // them is silently tolerated, not rejected (pinned by the mcp spec).
  meta: z.record(z.string(), z.unknown()).optional(),
})

/** Registers `submit_suggestion`. */
function registerSubmitSuggestion(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'submit_suggestion',
    {
      title: 'Submit a Tier-1 suggestion',
      description: 'Record a suggestion in the pending queue. Not an audited mutation: no commit, no corpus lock, no source-of-truth write (polluting instructions beats polluting source-of-truth — src/pending.ts). Approving means issuing the corresponding Tier-2 write yourself, then discard_suggestion-ing this entry.',
      inputSchema: SubmitSuggestionInputSchema,
    },
    async (input) => {
      const snap = deps.bindings.requireSnapshot()
      const root = await pendingQueueRoot(snap.recorder)
      // Built explicitly, not `submit(root, input)`: zod leaves an omitted optional
      // key genuinely absent, but under this package's `exactOptionalPropertyTypes`
      // that is a different type from `SubmitArgs`'s `meta` optional — the key must
      // be omitted from the object literal entirely, not set to `undefined`.
      const suggestion = submit(root, {
        kind: input.kind,
        subject: input.subject,
        content: input.content,
        ...input.meta !== undefined ? { meta: input.meta } : {},
      })
      return toolSuccess({ scope: scopeStamp(snap), suggestion })
    },
  )
}

/** Registers `list_suggestions`. */
function registerListSuggestions(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'list_suggestions',
    {
      title: 'List Tier-1 suggestions',
      description: 'List every pending suggestion in the queue, oldest first.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const snap = deps.bindings.requireSnapshot()
      const root = await pendingQueueRoot(snap.recorder)
      const suggestions = listing(root)
      return toolSuccess({ scope: scopeStamp(snap), suggestions })
    },
  )
}

const SuggestionIdInputSchema = z.object({
  suggestion_id: z.string().min(1),
})

/** Registers `get_suggestion`. */
function registerGetSuggestion(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_suggestion',
    {
      title: 'Get one Tier-1 suggestion',
      description: 'Load one pending suggestion by id.',
      inputSchema: SuggestionIdInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const snap = deps.bindings.requireSnapshot()
      const root = await pendingQueueRoot(snap.recorder)
      const suggestion = loadPending(root, input.suggestion_id)
      if (suggestion === null) {
        throw new SuggestionNotFoundError(`no pending suggestion "${input.suggestion_id}"`, { suggestion_id: input.suggestion_id })
      }
      return toolSuccess({ scope: scopeStamp(snap), suggestion })
    },
  )
}

/** Registers `discard_suggestion`. */
function registerDiscardSuggestion(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'discard_suggestion',
    {
      title: 'Discard a Tier-1 suggestion',
      description: 'Remove one suggestion from the pending queue. This is the "approve" half of Tier-1 (GLOSSARY § pending queue): perform the corresponding Tier-2 write yourself first, then discard the suggestion that prompted it.',
      inputSchema: SuggestionIdInputSchema,
    },
    async (input) => {
      const snap = deps.bindings.requireSnapshot()
      const root = await pendingQueueRoot(snap.recorder)
      const ok = discard(root, input.suggestion_id)
      if (!ok) {
        throw new SuggestionNotFoundError(`no pending suggestion "${input.suggestion_id}"`, { suggestion_id: input.suggestion_id })
      }
      return toolSuccess({ scope: scopeStamp(snap), discarded: true, suggestion_id: input.suggestion_id })
    },
  )
}

/** Registers all four Tier-1 suggestion tools. */
export const registerSuggestionTools: ToolRegistrar = (server, deps) => {
  registerSubmitSuggestion(server, deps)
  registerListSuggestions(server, deps)
  registerGetSuggestion(server, deps)
  registerDiscardSuggestion(server, deps)
}

/** The Tier-1 suggestion family's descriptor card (#115): its names and registrar
 * bound in one place, for `tools/index.ts` to compose — never a second copy of either key. */
export const SUGGESTION_TOOL_FAMILY: ToolFamily = { names: SUGGESTION_TOOL_NAMES, register: registerSuggestionTools }

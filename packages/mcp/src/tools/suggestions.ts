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
import type { McpServer } from '@modelcontextprotocol/server'
import { discard, listing, loadPending, submit } from '@semantic-grounding/substrate'
import { z } from 'zod'
import { SuggestionNotFoundError, toToolErrorResult } from '../errors.ts'
import type { ServerDeps, ToolRegistrar } from '../server.ts'
import { pendingQueueRoot } from './shared.ts'

/** The four Tier-1 tool names. */
export const SUGGESTION_TOOL_NAMES = ['submit_suggestion', 'list_suggestions', 'get_suggestion', 'discard_suggestion'] as const

const SubmitSuggestionInputSchema = z.object({
  kind: z.string().min(1).describe('A free-text category for this suggestion (e.g. "alt_label", "dimension_ref") — the pending queue does not constrain it.'),
  subject: z.string().min(1).describe('What this suggestion is about, typically a table_name or event name.'),
  content: z.string().min(1).describe('The suggested content, in whatever shape `kind` implies.'),
  scope_id: z.string().min(1).optional(),
  tenant_id: z.string().min(1).optional(),
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
      try {
        const root = await pendingQueueRoot(deps.recorder)
        // Built explicitly, not `submit(root, input)`: zod leaves an omitted optional
        // key genuinely absent, but under this package's `exactOptionalPropertyTypes`
        // that is a different type from `SubmitArgs`'s `string | null` optionals — the
        // key must be omitted from the object literal entirely, not set to `undefined`.
        const suggestion = submit(root, {
          kind: input.kind,
          subject: input.subject,
          content: input.content,
          ...input.scope_id !== undefined ? { scope_id: input.scope_id } : {},
          ...input.tenant_id !== undefined ? { tenant_id: input.tenant_id } : {},
          ...input.meta !== undefined ? { meta: input.meta } : {},
        })
        return { content: [{ type: 'text', text: JSON.stringify({ suggestion }) }] }
      } catch (e) {
        return toToolErrorResult(e)
      }
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
      try {
        const root = await pendingQueueRoot(deps.recorder)
        const suggestions = listing(root)
        return { content: [{ type: 'text', text: JSON.stringify({ suggestions }) }] }
      } catch (e) {
        return toToolErrorResult(e)
      }
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
      try {
        const root = await pendingQueueRoot(deps.recorder)
        const suggestion = loadPending(root, input.suggestion_id)
        if (suggestion === null) {
          throw new SuggestionNotFoundError(`no pending suggestion "${input.suggestion_id}"`, { suggestion_id: input.suggestion_id })
        }
        return { content: [{ type: 'text', text: JSON.stringify({ suggestion }) }] }
      } catch (e) {
        return toToolErrorResult(e)
      }
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
      try {
        const root = await pendingQueueRoot(deps.recorder)
        const ok = discard(root, input.suggestion_id)
        if (!ok) {
          throw new SuggestionNotFoundError(`no pending suggestion "${input.suggestion_id}"`, { suggestion_id: input.suggestion_id })
        }
        return { content: [{ type: 'text', text: JSON.stringify({ discarded: true, suggestion_id: input.suggestion_id }) }] }
      } catch (e) {
        return toToolErrorResult(e)
      }
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

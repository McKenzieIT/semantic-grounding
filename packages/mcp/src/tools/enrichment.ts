/**
 * The enrichment tool family — `get_enrichment_work`, `get_enrichment_prompts`,
 * `apply_enrichment`, `run_enrichment` — the agent-driven ask-answer loop's MCP
 * surface (map #12's destination's LLM half, ADR-0006 ruling 1; the fourth tool and
 * the index/prompt split added by ADR-0008, #31). Registered through the
 * {@link ToolRegistrar} seam `server.ts` documents; see that module's header for the
 * four measured SDK behaviors this file must not contradict.
 *
 * ## The error-contract decision this file follows (ADR-0005's 2026-10-09 addendum)
 *
 * `McpServer.registerTool`'s handler exceptions are caught by the SDK and turned into
 * an `isError` **result** with any `code` discarded (measured on SDK v2.3.1 — see
 * `errors.ts`'s module header). This file keeps `registerTool` rather than dropping to
 * `server.server.setRequestHandler`, and every handler below ends
 * `catch (e) { return toScopeAwareToolError(e) }` / `catch (e) { return toToolErrorResult(e) }`
 * — the coded failure travels inside the `isError` result's JSON text instead of on
 * the JSON-RPC envelope. Anything that is not an {@link SgApplicationError} is
 * rethrown, so an actual bug in this file still surfaces loudly rather than being
 * reported as an anticipated failure.
 *
 * ## `clientInfo` is per-request, not per-process (same addendum)
 *
 * `GitRecorderConfig.clientName` is a construction-time value #22 deliberately leaves
 * unset, because `extra.mcpReq.envelope[CLIENT_INFO_META_KEY]` is per-request envelope
 * data that can change within one connection. The write handlers below get the fresh
 * read for free through `auditedWrite` (`tools/audited.ts`), which reads the envelope
 * per call and passes it as `AuditContext.clientName`, which `GitTier2Recorder`'s
 * `commitContext` prefers over the (normally absent) configured value.
 *
 * ## Dimension filters are call-wide (ADR-0007, #31)
 *
 * Both filter-taking tools share `scopeFilterSchema` and one semantics: naming a
 * dimension constrains the **whole call** — `run_enrichment(tables: [...])` sweeps
 * only those tables and does not touch events (the pre-#31 behavior swept every event
 * in the corpus, #25's 446-file incident); `get_enrichment_work(tables: [...])` lists
 * only those tables' gaps. An omitted dimension is out of the call; omitting both is
 * the one full-corpus shape (`{}`). Filters are closed-set enumerations of corpus
 * names: an empty array is refused by zod `min(1)`, and an unknown name is rejected at
 * the Core methods' door (before any scan, write, or commit) with a coded
 * `-31040` result listing every unknown name — never the silent empty list a typo
 * used to produce.
 *
 * ## Index/prompt split (ADR-0008, #31)
 *
 * `get_enrichment_work` answers "WHERE are the gaps" as an index of
 * `{work_id, target, gap}` rows (~68 tokens each, capped at 1000 with `total` /
 * `truncated` at the content JSON's top level); `get_enrichment_prompts` answers
 * "WHAT is the question" for a batch of up to 10 work_ids, rebuilding each prompt
 * against the current corpus. The two scales differ by two orders of magnitude —
 * triage wants the whole distribution cheap, answering wants a narrow batch — and
 * before the split one listing call returned 579 items / 25.9MB of prompt text
 * (#25's size incident).
 *
 * ## Tool-by-tool shape (ADR-0006 rulings 4–6, ADR-0008)
 *
 * - **`get_enrichment_work`** — a read; no commit, no `AuditContext`, not run through
 *   the audit seam. Its description tells the agent to call `run_enrichment` first,
 *   which is a convention (ADR-0006's Consequences explicitly: "指引不是协议"), not
 *   something this tool can enforce.
 * - **`get_enrichment_prompts`** — a read; pure forwarding to
 *   `core.getEnrichmentPrompts`. Per-item lenient verdicts mirror the apply family: a
 *   stale or malformed work_id reports `stale_baseline` for itself alone, never a
 *   thrown error.
 * - **`apply_enrichment`** — a write; `auditedWrite` (the `runAudited` wrapper in
 *   `tools/audited.ts`) drives `core.applyEnrichmentResults`, which opens its own
 *   `beginBatch` window (`enrichment-work.ts`) so N applied items land as one commit.
 *   `derivation` is hardcoded to `'llm'` here — ADR-0006 ruling 5 gives this tool no
 *   `derivation` *parameter* to override in the first place, by design ("server 恒盖
 *   Derivation: llm — 收自报开误报之门").
 * - **`run_enrichment`** — a write; `auditedWrite` wraps a `beginBatch` window spanning
 *   the legs the adjudicated scope turned on (unchanged since #18 in every other
 *   respect). They still believe they are making N independently-audited writes;
 *   `GitTier2Recorder.recordTier2Write`'s absorption branch (triggered by the open
 *   batch) is what turns that into one commit — see that method's own doc comment.
 *   `derivation` is hardcoded to `'deterministic'`: this tool takes no
 *   `derivation`/`confidence`/`summary` input at all, because a deterministic round's
 *   basis is fully known to the server (mirrors `commitDerivedResidue`'s own
 *   `confidence: 1` reasoning in `recorder.ts`). The commit subject is derived from
 *   the SAME adjudicated scope that gated the legs (ADR-0007's by-construction
 *   reconciliation: a leg the subject does not name never runs).
 *
 * @module tools/enrichment
 */
import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { assertKnownFilterNames, UnknownFilterNamesError } from '@semantic-grounding/substrate'
import { toToolErrorResult, UnknownFilterNameError } from '../errors.ts'
import { ScopeIdSchema } from './shared.ts'
import type { ToolRegistrar } from '../server.ts'
import { assertScopeMatch, auditedWrite, scopeStamp, toolSuccess, writeReceipt } from './audited.ts'

/** The enrichment family's four tool names (ADR-0006's three + ADR-0008's fourth). */
export const ENRICHMENT_TOOL_NAMES = [
  'get_enrichment_work',
  'get_enrichment_prompts',
  'apply_enrichment',
  'run_enrichment',
] as const

/** The prompt-batch cap (ADR-0008): zod-level, single-sourced here — 10 × ~8.3K-token
 * prompts ≈ 83K tokens, comfortably inside half a de-facto 200K-token window while
 * leaving room for the answer and the rest of the session. */
const PROMPT_BATCH_MAX = 10

/** The `tables`/`events` dimension-filter pair `get_enrichment_work` and
 * `run_enrichment` accept, zod-validated. `min(1)` refuses an empty array at the door:
 * omitting the key is the one way to say "that dimension is not in this call"
 * (ADR-0007) — an empty array used to mean "no filter" one layer down, which is
 * exactly the silent-full-sweep ambiguity #25 reported. */
const scopeFilterSchema = z.object({
  tables: z.array(z.string()).min(1).optional(),
  events: z.array(z.string()).min(1).optional(),
})

/** `run_enrichment`'s input: the call-wide filter pair plus the write assertion
 * (ADR-0011 — one of the 8 commit-class tools that must carry `scope_id`). */
const runEnrichmentInputSchema = scopeFilterSchema.extend({ scope_id: ScopeIdSchema })

/**
 * Build a `{tables?, events?}` options object from zod-parsed filter args, omitting
 * absent keys rather than setting them to `undefined` (`exactOptionalPropertyTypes`,
 * and `SemanticGroundingCore`'s own opts objects follow the same convention).
 * @param args - the zod-validated filter input.
 * @returns the options object to forward to a core method.
 */
function filterOpts(
  args: z.infer<typeof scopeFilterSchema>,
): { readonly tables?: readonly string[]; readonly events?: readonly string[] } {
  return {
    ...args.tables !== undefined ? { tables: args.tables } : {},
    ...args.events !== undefined ? { events: args.events } : {},
  }
}

/**
 * Map a handler error onto the error contract, translating the substrate's
 * dimension-filter door rejection (`UnknownFilterNamesError`, thrown by the Core
 * discovery/listing methods before any scan) into this surface's coded
 * {@link UnknownFilterNameError} so the `-31040` reaches the agent as a structured
 * `isError` result. Everything else flows to {@link toToolErrorResult} unchanged —
 * including the rethrow-this-is-a-bug behavior for non-`SgApplicationError` values.
 * @param e - whatever the handler body threw.
 * @returns the `isError` result to return.
 */
function toScopeAwareToolError(e: unknown): CallToolResult {
  if (e instanceof UnknownFilterNamesError) {
    return toToolErrorResult(new UnknownFilterNameError(e.message, {
      unknown_tables: [...e.unknownTables],
      unknown_events: [...e.unknownEvents],
    }))
  }
  return toToolErrorResult(e)
}

/**
 * Describe a `run_enrichment` call's adjudicated scope for the commit subject
 * (`run_enrichment(<target>)`). No ADR ruling pins this exact wording (ADR-0006
 * ruling 6 settles the tool's mechanism, not its subject text) — chosen for audit-log
 * legibility, parallel in spirit to ruling 5's `apply_enrichment` subject rule.
 * ADR-0007's same-source requirement: the caller passes the very scope object that
 * gated the legs, so the subject names a dimension only when that dimension's leg
 * actually ran, and "N table(s)" counts the names that leg was scoped to.
 * @param scope - the adjudicated `{tables?, events?}` scope (same object the handler gated on).
 * @returns a short phrase: `'all definitions'`, or e.g. `'3 table(s) + 1 event(s)'`.
 */
function describeRunEnrichmentScope(scope: { readonly tables?: readonly string[]; readonly events?: readonly string[] }): string {
  const parts: string[] = []
  if (scope.tables !== undefined) parts.push(`${scope.tables.length} table(s)`)
  if (scope.events !== undefined) parts.push(`${scope.events.length} event(s)`)
  return parts.length > 0 ? parts.join(' + ') : 'all definitions'
}

/**
 * Registers the enrichment tool family. Pure registration (no corpus read, no lock,
 * no I/O) — see `server.ts`'s `ToolRegistrar` doc for why that is load-bearing: a
 * registrar may run twice per process, and every inbound request if it throws.
 * @param server - the fresh server instance to register on.
 * @param deps - the registry/bindings/config this process serves (per-call scope via entry snapshots).
 */
export const registerEnrichmentTools: ToolRegistrar = (server, deps) => {
  server.registerTool(
    'get_enrichment_work',
    {
      title: 'Get enrichment work index',
      description:
        'List outstanding enrichment gaps as a compact index — definitions whose DIM-join relations or alt_labels are still empty — one row {work_id, target, gap} each, capped at 1000 rows with total and truncated alongside (when truncated, narrow by tables/events). Triage the index first, then fetch the actual question prompts for the rows you will answer via get_enrichment_prompts (batches of up to 10 work_ids) — the index deliberately carries no prompt text. Run run_enrichment first: a gap that a deterministic pass could now fill still shows up here until run_enrichment persists it. Dimension filters are call-wide: get_enrichment_work(tables:[...]) lists ONLY those tables (rows for the unnamed dimension are out of the call); omit both for the full corpus. Filters name existing corpus definitions exactly — an unknown name fails with an error listing it, never a silently empty index. Read-only; makes no commit.',
      inputSchema: scopeFilterSchema,
    },
    async (args, _extra) => {
      try {
        const snap = deps.bindings.requireSnapshot()
        // Pure forwarding: the call-wide pair reading, name validation, and the cap
        // all live in the Core method's contract (ADR-0007/0008).
        return toolSuccess({ scope: scopeStamp(snap), ...(await snap.core.listEnrichmentWork(filterOpts(args))) })
      } catch (e) {
        return toScopeAwareToolError(e)
      }
    },
  )

  server.registerTool(
    'get_enrichment_prompts',
    {
      title: 'Get enrichment prompts',
      description:
        'Fetch the LLM question prompts for a batch of up to 10 work_ids from get_enrichment_work\'s index — the index lists gaps without their prompts; this tool carries the actual question text. Prompts are rebuilt against the current corpus at fetch time: a work_id whose target changed, vanished, or no longer parses since listing returns verdict stale_baseline for that item alone (re-fetch the work instead of answering it — applying it later would reject as stale anyway). A stale or malformed item never poisons its batch siblings. Answer with apply_enrichment, feeding each work_id back with your completion text. Read-only; makes no commit.',
      inputSchema: z.object({
        work_ids: z.array(z.string()).min(1).max(PROMPT_BATCH_MAX),
      }),
    },
    async (args, _extra) => {
      try {
        const snap = deps.bindings.requireSnapshot()
        return toolSuccess({ scope: scopeStamp(snap), prompts: await snap.core.getEnrichmentPrompts(args.work_ids) })
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )

  server.registerTool(
    'apply_enrichment',
    {
      title: 'Apply enrichment answers',
      description:
        'Apply a batch of your own completions for work items from get_enrichment_work, one commit for the whole ' +
        'batch. Each result is independently re-verified against the target\'s current content before being ' +
        'merged — a target that changed since you fetched the work item reports verdict "stale_baseline" (re-fetch ' +
        'and retry) without affecting the other results in the batch. summary and confidence describe the batch ' +
        'as a whole, in your own words; derivation is always recorded as "llm".',
      inputSchema: z.object({
        scope_id: ScopeIdSchema,
        results: z.array(z.object({
          work_id: z.string().min(1),
          text: z.string(),
        })).min(1),
        summary: z.string().min(1).max(100),
        confidence: z.number().min(0).max(1),
      }),
    },
    async (args, extra) => {
      try {
        const snap = deps.bindings.requireSnapshot()
        assertScopeMatch(snap, args.scope_id)
        const first = args.results[0]
        const subject = args.results.length === 1 && first !== undefined
          ? snap.core.peekEnrichmentWorkTarget(first.work_id) ?? first.work_id
          : `${args.results.length} targets`
        const audited = await auditedWrite(
          snap,
          extra,
          {
            tool: 'apply_enrichment',
            target: subject,
            summary: args.summary,
            // Server-overridden, not client-supplied: this schema has no `derivation`
            // field at all (ADR-0006 ruling 5 — "server 恒盖 Derivation: llm"), so there
            // is nothing to override, only something to decide once, here.
            derivation: 'llm',
            confidence: args.confidence,
          },
          () => snap.core.applyEnrichmentResults(args.results, snap.recorder),
        )
        return toolSuccess(await writeReceipt(snap, deps, audited, {
          tool: 'apply_enrichment',
          writePath: 'round',
          domain: { results: audited.value.results },
        }))
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )

  server.registerTool(
    'run_enrichment',
    {
      title: 'Run deterministic enrichment',
      description:
        'Deterministic-only batch backfill: re-run DIM-join and alt_labels discovery and persist whatever the deterministic round finds, as one commit. No model involved — call this before get_enrichment_work so facts a deterministic pass can derive are not left for an LLM to guess at (and recorded as if guessed). DIM-join discovery only looks at `dim_*` dimension tables (kind: dim): a scope whose dimensions are inlined in DWS tables (no `dim_*` tables) finds no DIM-join work — an expected no-op, not a failure — while alt_labels discovery still runs off each definition\'s own description/columns. Concept `related_to` edges are never enriched; add_relation them by hand. Dimension filters are call-wide: run_enrichment(tables:[...]) sweeps ONLY those tables and does not touch events; run_enrichment(events:[...]) the mirror; omit both (or pass {}) to scan the full corpus. Filters name existing corpus definitions exactly — an unknown name fails before any scan or commit, with an error listing it. A run that finds nothing new makes no commit. If your client times out on this call, the server may still have finished and committed — re-issue the identical call: the idempotent changed:false result carries the commit sha, which is the receipt the timeout ate.',
      inputSchema: runEnrichmentInputSchema,
    },
    async (args, extra) => {
      try {
        const snap = deps.bindings.requireSnapshot()
        assertScopeMatch(snap, args.scope_id)
        // ADR-0007: one adjudication feeds the whole-call door, the leg gating, the
        // Core calls, AND the commit subject — the call and its audit trail cannot
        // disagree (the #25 finding was a subject that said "1 table(s)" over a
        // 446-file sweep).
        const scope = filterOpts(args)
        // The whole-call door, before the fan-out: this call spans three Core methods,
        // each of which would only validate its own dimension — guarding the full pair
        // up front is what makes the rejection list BOTH dimensions' unknown names in
        // one round trip (#28's "错误列全未知名").
        assertKnownFilterNames(snap.core.resolveScopeRoot(), scope)
        const full = scope.tables === undefined && scope.events === undefined
        const tablesOn = full || scope.tables !== undefined
        const eventsOn = full || scope.events !== undefined
        const audited = await auditedWrite(
          snap,
          extra,
          {
            tool: 'run_enrichment',
            target: describeRunEnrichmentScope(scope),
            summary: 'deterministic DIM-join + alt_labels discovery backfill',
            // Server-asserted, not agent-claimed: a deterministic round's basis is
            // fully known to the server (the round, and that it is this round) —
            // mirrors `commitDerivedResidue`'s own `derivation`/`confidence` in
            // recorder.ts, not an agent's self-report.
            derivation: 'deterministic',
            confidence: 1,
          },
          async () => {
            const batch = snap.recorder.beginBatch()
            const tier2 = {
              recorder: snap.recorder,
              scope_id: snap.scopeId,
            }
            try {
              // Only the legs the adjudicated scope turned on run, and only those
              // legs appear in the result — a leg that did not run has nothing to
              // report (ADR-0007's leftover-detail ruling: report the legs that ran).
              const relation: {
                tables?: Awaited<ReturnType<typeof snap.core.discoverRelations>>
                events?: Awaited<ReturnType<typeof snap.core.discoverEventRelations>>
              } = {}
              if (tablesOn) {
                relation.tables = await snap.core.discoverRelations({ ...scope.tables !== undefined ? { tables: scope.tables } : {}, tier2 })
                if (relation.tables.written > 0) batch.record('run_enrichment', { round: 'relation', kind: 'table' })
              }
              if (eventsOn) {
                relation.events = await snap.core.discoverEventRelations({ ...scope.events !== undefined ? { events: scope.events } : {}, tier2 })
                if (relation.events.written > 0) batch.record('run_enrichment', { round: 'relation', kind: 'event' })
              }
              const altLabels = await snap.core.discoverAltLabels({ ...scope, tier2 })
              if (altLabels.written > 0) batch.record('run_enrichment', { round: 'alt_labels' })
              await batch.end()
              return { relation, alt_labels: altLabels }
            } catch (e) {
              await batch.abort()
              throw e
            }
          },
        )
        return toolSuccess(await writeReceipt(snap, deps, audited, {
          tool: 'run_enrichment',
          writePath: 'round',
          domain: { summary: audited.value },
        }))
      } catch (e) {
        return toScopeAwareToolError(e)
      }
    },
  )
}

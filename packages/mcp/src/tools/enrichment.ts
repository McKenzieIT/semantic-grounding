/**
 * ADR-0006's three enrichment tools — `get_enrichment_work`, `apply_enrichment`,
 * `run_enrichment` — the agent-driven ask-answer loop's MCP surface (map #12's
 * destination's LLM half, ADR-0006 ruling 1). Registered through the
 * {@link ToolRegistrar} seam `server.ts` documents; see that module's header for the
 * four measured SDK behaviors this file must not contradict.
 *
 * ## The error-contract decision this file follows (ADR-0005's 2026-10-09 addendum)
 *
 * `McpServer.registerTool`'s handler exceptions are caught by the SDK and turned into
 * an `isError` **result** with any `code` discarded (measured on SDK v2.3.1 — see
 * `errors.ts`'s module header). This file keeps `registerTool` rather than dropping to
 * `server.server.setRequestHandler`, and every handler below ends `catch (e) { return
 * toToolErrorResult(e) }` — the coded failure travels inside the `isError` result's JSON
 * text instead of on the JSON-RPC envelope. `toToolErrorResult` rethrows anything that
 * is not an `SgApplicationError`, so an actual bug in this file still surfaces loudly
 * rather than being reported as an anticipated failure.
 *
 * ## `clientInfo` is per-request, not per-process (same addendum)
 *
 * `GitRecorderConfig.clientName` is a construction-time value #22 deliberately leaves
 * unset, because `extra.mcpReq.envelope[CLIENT_INFO_META_KEY]` is per-request envelope
 * data that can change within one connection. Every write handler below reads it fresh
 * from `extra` and passes it as `AuditContext.clientName`, which `GitTier2Recorder`'s
 * `commitContext` prefers over the (normally absent) configured value.
 *
 * ## Tool-by-tool shape (ADR-0006 rulings 4–6)
 *
 * - **`get_enrichment_work`** — a read; no commit, no `AuditContext`, not run through
 *   `runAudited`. Its description tells the agent to call `run_enrichment` first, which
 *   is a convention (ADR-0006's Consequences explicitly: "指引不是协议"), not something
 *   this tool can enforce.
 * - **`apply_enrichment`** — a write; `runAudited` wraps `core.applyEnrichmentResults`,
 *   which opens its own `beginBatch` window (`enrichment-work.ts`) so N applied items
 *   land as one commit. `derivation` is hardcoded to `'llm'` here — ADR-0006 ruling 5
 *   gives this tool no `derivation` *parameter* to override in the first place, by
 *   design ("server 恒盖 Derivation: llm — 收自报开误报之门").
 * - **`run_enrichment`** — a write; `runAudited` wraps a `beginBatch` window spanning
 *   up to three existing `discoverRelations` / `discoverEventRelations` /
 *   `discoverAltLabels` calls, unchanged since #18. They still believe they are making
 *   N independently-audited writes; `GitTier2Recorder.recordTier2Write`'s absorption
 *   branch (triggered by the open batch) is what turns that into one commit — see that
 *   method's own doc comment. `derivation` is hardcoded to `'deterministic'`: this tool
 *   takes no `derivation`/`confidence`/`summary` input at all, because a deterministic
 *   round's basis is fully known to the server (mirrors `commitDerivedResidue`'s own
 *   `confidence: 1` reasoning in `recorder.ts`).
 *
 * @module tools/enrichment
 */
import { z } from 'zod'
import { CLIENT_INFO_META_KEY, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server'
import { toToolErrorResult } from '../errors.ts'
import type { ToolRegistrar } from '../server.ts'

/**
 * Read the per-request client name from the 2026-07-28 envelope.
 *
 * Cast through `Record<string, unknown>` rather than typed property access: the SDK's
 * published `RequestMetaEnvelope` type carries no named properties (its real keys are
 * the `*_META_KEY` constants, read by bracket access, not dot access — a shape this
 * package cannot improve on by typing harder), and the SDK's own doc comment on
 * `CLIENT_INFO_META_KEY` says the value is self-reported and MUST NOT be relied on for
 * behavior or security decisions — so treating it as `unknown` and runtime-checking is
 * the materially correct position, not a workaround for a type that happens to be loose.
 * @param extra - the tool handler's second argument.
 * @returns the client's self-reported name, or undefined when absent, non-string, or malformed.
 */
function clientNameFromEnvelope(extra: ServerContext): string | undefined {
  const envelope = extra.mcpReq.envelope as Record<string, unknown> | undefined
  const info = envelope?.[CLIENT_INFO_META_KEY]
  if (typeof info !== 'object' || info === null) return undefined
  const name = (info as Record<string, unknown>).name
  return typeof name === 'string' && name.trim() !== '' ? name : undefined
}

/** Render a `CallToolResult` success payload as the SDK's `content: [{type:'text', text}]`
 * shape (no `structuredContent`/`outputSchema` — ADR-0005's addendum found no such
 * side-channel in this SDK version). @param payload - the JSON-serializable response body. */
function toolSuccess(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

/** The `tables`/`events` name-filter pair every tool below accepts, zod-validated. */
const scopeFilterSchema = z.object({
  tables: z.array(z.string()).optional(),
  events: z.array(z.string()).optional(),
})

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
 * Describe a `run_enrichment` call's scope for the commit subject
 * (`run_enrichment(<target>)`). No ADR ruling pins this exact wording (ruling 6 settles
 * the tool's mechanism, not its subject text) — chosen for audit-log legibility,
 * parallel in spirit to ruling 5's `apply_enrichment` subject rule.
 * @param tables - the table-name filter, if given.
 * @param events - the event-name filter, if given.
 * @returns a short phrase: `'all definitions'`, or e.g. `'3 table(s) + 1 event(s)'`.
 */
function describeRunEnrichmentScope(tables?: readonly string[], events?: readonly string[]): string {
  const parts: string[] = []
  if (tables !== undefined && tables.length > 0) parts.push(`${tables.length} table(s)`)
  if (events !== undefined && events.length > 0) parts.push(`${events.length} event(s)`)
  return parts.length > 0 ? parts.join(' + ') : 'all definitions'
}

/**
 * Registers ADR-0006's three enrichment tools. Pure registration (no corpus read, no
 * lock, no I/O) — see `server.ts`'s `ToolRegistrar` doc for why that is load-bearing: a
 * registrar may run twice per process, and every inbound request if it throws.
 * @param server - the fresh server instance to register on.
 * @param deps - the process-wide core/recorder/config this process serves.
 */
export const registerEnrichmentTools: ToolRegistrar = (server, deps) => {
  server.registerTool(
    'get_enrichment_work',
    {
      title: 'Get enrichment work',
      description:
        'List outstanding enrichment gaps — definitions whose DIM-join relations or alt_labels are still empty — ' +
        'each as a self-contained work item {work_id, target, gap, prompt} an LLM can answer. Run run_enrichment ' +
        'first: a gap that a deterministic pass could now fill (e.g. a DIM table onboarded after this DWS table ' +
        'was written) still shows up here until run_enrichment persists it, and this tool has no way to tell you ' +
        'that happened short of your having called it. Read-only; makes no commit.',
      inputSchema: scopeFilterSchema,
    },
    async (args, _extra) => {
      try {
        const work = await deps.core.listEnrichmentWork(filterOpts(args))
        return toolSuccess({ work })
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
        const first = args.results[0]
        const subject = args.results.length === 1 && first !== undefined
          ? deps.core.peekEnrichmentWorkTarget(first.work_id) ?? first.work_id
          : `${args.results.length} targets`
        const clientName = clientNameFromEnvelope(extra)
        const audited = await deps.recorder.runAudited(
          {
            tool: 'apply_enrichment',
            target: subject,
            summary: args.summary,
            // Server-overridden, not client-supplied: this schema has no `derivation`
            // field at all (ADR-0006 ruling 5 — "server 恒盖 Derivation: llm"), so there
            // is nothing to override, only something to decide once, here.
            derivation: 'llm',
            confidence: args.confidence,
            ...clientName !== undefined ? { clientName } : {},
          },
          () => deps.core.applyEnrichmentResults(args.results, deps.recorder),
        )
        return toolSuccess({
          results: audited.value.results,
          commit: audited.commit,
          changed: audited.changed,
          enrichment_health: deps.core.getEnrichmentHealth(),
        })
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
        'Deterministic-only batch backfill: re-run DIM-join and alt_labels discovery for every definition (or a ' +
        'tables/events-filtered subset) and persist whatever the deterministic round finds, as one commit. No ' +
        'model involved — call this before get_enrichment_work so facts a deterministic pass can derive are not ' +
        'left for an LLM to guess at (and recorded as if guessed). A run that finds nothing new makes no commit.',
      inputSchema: scopeFilterSchema,
    },
    async (args, extra) => {
      try {
        const clientName = clientNameFromEnvelope(extra)
        const audited = await deps.recorder.runAudited(
          {
            tool: 'run_enrichment',
            target: describeRunEnrichmentScope(args.tables, args.events),
            summary: 'deterministic DIM-join + alt_labels discovery backfill',
            // Server-asserted, not agent-claimed: a deterministic round's basis is
            // fully known to the server (the round, and that it is this round) —
            // mirrors `commitDerivedResidue`'s own `derivation`/`confidence` in
            // recorder.ts, not an agent's self-report.
            derivation: 'deterministic',
            confidence: 1,
            ...clientName !== undefined ? { clientName } : {},
          },
          async () => {
            const batch = deps.recorder.beginBatch()
            const tier2 = {
              recorder: deps.recorder,
              ...deps.config.scopeId !== undefined ? { scope_id: deps.config.scopeId } : {},
            }
            try {
              const scope = filterOpts(args)
              const relation = {
                tables: await deps.core.discoverRelations({ ...scope.tables !== undefined ? { tables: scope.tables } : {}, tier2 }),
                events: await deps.core.discoverEventRelations({ ...scope.events !== undefined ? { events: scope.events } : {}, tier2 }),
              }
              if (relation.tables.written > 0) batch.record('run_enrichment', { round: 'relation', kind: 'table' })
              if (relation.events.written > 0) batch.record('run_enrichment', { round: 'relation', kind: 'event' })
              const altLabels = await deps.core.discoverAltLabels({ ...scope, tier2 })
              if (altLabels.written > 0) batch.record('run_enrichment', { round: 'alt_labels' })
              await batch.end()
              return { relation, alt_labels: altLabels }
            } catch (e) {
              await batch.abort()
              throw e
            }
          },
        )
        return toolSuccess({
          commit: audited.commit,
          changed: audited.changed,
          enrichment_health: deps.core.getEnrichmentHealth(),
          summary: audited.value,
        })
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

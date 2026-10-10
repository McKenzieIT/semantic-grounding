/**
 * The write tools' shared prologue/epilogue — the ceremony every Tier-2 tool
 * handler repeated by hand before this module existed: read the calling
 * client's name off the request envelope, assemble the audit context
 * field-by-field, drive `GitTier2Recorder.runAudited`, and shape
 * `{commit, changed, …}` into a `tools/call` result. #20/#21/#38 landed eight
 * such handlers; this module is what their common half became.
 *
 * ## Why a module, not a convention
 *
 * Eight call sites is eight chances to get the ceremony subtly wrong, and the
 * ceremony is where the load-bearing facts live: `clientInfo` is per-request
 * envelope data under the 2026-07-28 revision — read fresh inside every
 * handler, never cached at registration or construction time (ADR-0005's
 * 2026-10-09 addendum); `summary`/`derivation`/`confidence` are
 * caller-supplied and never server-synthesized (ADR-0005 ruling 8 — the
 * recorder refuses a contextless write rather than inventing one); and the
 * lock has to wrap the substrate call, which is why `runAudited` — not
 * `recordTier2Write` — is the seam everything drives (ADR-0004's 2026-10-09
 * update). Collapsing the ceremony here is also where map #40's entry
 * snapshot binding is meant to land: when a handler must resolve the
 * per-request scope snapshot before touching the core (#45's 入口快照绑定),
 * this is the one place the tool layer feels it — the handlers themselves keep
 * compiling intent + payload and stay oblivious to which core instance served
 * the call.
 *
 * ## `enrichment_health` has exactly one home
 *
 * {@link enrichmentHealthAfter} is the single place that knows which write
 * paths ran the on-write enrichment hook: table writes
 * (`updateTableMeta`/`syncWrite` call `enrichOnWrite`) did, event writes
 * (`updateEventMeta`) did not — the event hook remains deferred, see the Core
 * class's own note on `discoverEventRelations` — and an enrichment round
 * (`apply_enrichment`/`run_enrichment`) always reports. Before this module
 * that knowledge was a `kind === 'table' ?` ternary copy-pasted across five
 * handlers, each with its own paraphrase of why.
 *
 * @module tools/audited
 */
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server'
import type { EnrichmentHealthEntry } from '@semantic-grounding/substrate'
import type { ServerDeps } from '../server.ts'
import type { Derivation } from '../git/message.ts'
import type { AuditedResult } from '../git/recorder.ts'
import { clientNameFromEnvelope } from './shared.ts'

/**
 * The per-call intent half of an audit record — the fields only the calling
 * tool knows (ADR-0005 rulings 7/8). `clientName` is deliberately absent: it
 * is per-request envelope data {@link auditedWrite} reads itself, never a
 * caller-supplied (or construction-time-cached) value.
 */
export interface AuditIntent {
  /** The intent tool driving this write; becomes the subject verb and `X-SG-Tool`. */
  readonly tool: string
  /** What is being written (a table/event name, or a phrase for a multi-target write). */
  readonly target: string
  /** One line: what changed and on what basis (1–100 chars, never server-synthesized). */
  readonly summary: string
  /** How the content came to be. Tools pass `agent`/`llm`; a deterministic round passes `deterministic`. */
  readonly derivation: Derivation
  /** The caller's own confidence, 0–1. */
  readonly confidence: number
}

/**
 * Drive one Tier-2 tool write through the recorder's audit seam: read the
 * calling client's name off this request's envelope, assemble the audit
 * context (conditionally spread — `exactOptionalPropertyTypes`, so an absent
 * client name stays absent from the context), and hand `fn` to `runAudited`,
 * whose lock wraps the substrate call. Callers never touch
 * `recordTier2Write` directly: a write arriving without an ambient context is
 * refused rather than given an invented summary (`git/recorder.ts`).
 * @param deps - the process-wide dependencies (`recorder` is the seam).
 * @param ctx - the handler's second callback parameter; the envelope is read
 *   fresh here, per call, per ADR-0005's 2026-10-09 addendum.
 * @param intent - what only the calling tool knows.
 * @param fn - the substrate call(s) to run inside the lock; its resolved value
 *   comes back as `value`.
 * @returns the recorder's `{commit, changed, value}` for the response body.
 */
export async function auditedWrite<T>(
  deps: ServerDeps,
  ctx: ServerContext,
  intent: AuditIntent,
  fn: () => Promise<T>,
): Promise<AuditedResult<T>> {
  const clientName = clientNameFromEnvelope(ctx)
  return deps.recorder.runAudited(
    { ...intent, ...clientName !== undefined ? { clientName } : {} },
    fn,
  )
}

/**
 * The one home for "did this write path run the on-write enrichment hook":
 * `'table'` did (`updateTableMeta`/`syncWrite` call `enrichOnWrite`), `'event'`
 * did not (`updateEventMeta` has no hook — deferred, see the Core class's own
 * note on `discoverEventRelations`), `'round'` always did
 * (`apply_enrichment`/`run_enrichment` enrich by definition).
 *
 * This used to be a `kind === 'table' ?` ternary copy-pasted across five
 * handlers. Reporting health for an *event* write would misattribute whatever
 * an earlier table write left behind — the failure mode this function exists
 * to make impossible to re-introduce by accident.
 * @param deps - the process-wide dependencies.
 * @param writePath - which write path just ran: the kind for the meta-update
 *   tools, or `'round'` for the enrichment tools.
 * @returns the health snapshot to inline, or `undefined` when the write path
 *   has no hook — a response key that must stay absent, never an empty array.
 */
export function enrichmentHealthAfter(
  deps: ServerDeps,
  writePath: 'table' | 'event' | 'round',
): readonly EnrichmentHealthEntry[] | undefined {
  if (writePath === 'event') return undefined
  return deps.core.getEnrichmentHealth()
}

/**
 * Render a `tools/call` success payload as the SDK's `content:
 * [{type:'text', text}]` shape. (`structuredContent`/`outputSchema` exist and
 * are wired in this SDK version — SEP-2106, per #29's dist-source read — but
 * no tool here declares an output schema: ADR-0008 keeps response metadata in
 * the content JSON's top level, a channel every host already consumes.)
 * @param payload - the JSON-serializable response body.
 */
export function toolSuccess(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

/** The shape every field-overlay write needs back — the success branch's field
 * name (`table_name`/`event_name`) is dropped, since no caller of this wrapper
 * reads it. */
type ApplyResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

/**
 * Apply one field overlay via `updateTableMeta` / `updateEventMeta`, dispatched
 * by `kind`, with an explicit return type.
 *
 * Not a bare `kind === 'table' ? core.updateTableMeta(...) : core.updateEventMeta(...)`
 * inline inside the audit seam's `fn`: measured — `UpdateTableMetaResult` and
 * `UpdateEventMetaResult` differ only in their success branch's field name
 * (`table_name` vs `event_name`), and TypeScript infers the seam callback's
 * `T` from whichever branch it resolves first, then rejects the other branch
 * against that fixed `T`. An explicitly-typed wrapper (dropping the field
 * neither branch's caller reads) sidesteps the inference order entirely,
 * rather than annotating every call site.
 * @param deps - the process-wide dependencies.
 * @param kind - which Tier-2 method to call.
 * @param name - the table_name / event name.
 * @param updates - the field overlay to shallow-merge over the existing YAML.
 * @param expectedVersion - the caller's baseline fingerprint
 *   (`expected_version`, checked inside the lock by the write path).
 * @returns `{ok:true}` on success, or `{ok:false, error}` — never throws for a
 *   normal validation/not-found outcome.
 */
export async function applyFieldUpdate(
  deps: ServerDeps,
  kind: 'table' | 'event',
  name: string,
  updates: Readonly<Record<string, unknown>>,
  expectedVersion: string,
): Promise<ApplyResult> {
  if (kind === 'table') {
    const res = await deps.core.updateTableMeta(name, updates, { expected_version: expectedVersion })
    return res.ok ? { ok: true } : res
  }
  const res = await deps.core.updateEventMeta(name, updates, { expected_version: expectedVersion })
  return res.ok ? { ok: true } : res
}

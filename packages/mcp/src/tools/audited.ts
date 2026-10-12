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
 * ceremony is where the load-bearing facts live: the **entry snapshot** is
 * resolved synchronously before any `await` and threaded through everything
 * else (ADR-0011 ruling 1 — a handler that straddles a `switch_scope` serves
 * the scope it bound at entry: writes land in that repo with that identity's
 * trailers, and the response carries that stamp); `clientInfo` is per-request
 * envelope data under the 2026-07-28 revision — read fresh inside every
 * handler, never cached at registration or construction time (ADR-0005's
 * 2026-10-09 addendum); `summary`/`derivation`/`confidence` are
 * caller-supplied and never server-synthesized (ADR-0005 ruling 8 — the
 * recorder refuses a contextless write rather than inventing one); and the
 * lock has to wrap the substrate call, which is why `runAudited` — not
 * `recordTier2Write` — is the seam everything drives (ADR-0004's 2026-10-09
 * update). #45 ruled this module the one place the tool layer feels the
 * snapshot binding: handlers resolve `deps.bindings.requireSnapshot()` once
 * at entry, hand it to {@link auditedWrite}, and stay oblivious to *which*
 * core instance served the call.
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
import type { ScopeBinding } from '../binding.ts'
import type { Derivation } from '../git/message.ts'
import type { AuditedResult } from '../git/recorder.ts'
import { ScopeMismatchError } from '../errors.ts'
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
 * Takes the **entry snapshot**, not `ServerDeps`: the binding was resolved
 * synchronously at the handler's entry (ADR-0011 ruling 1), and this seam
 * runs against exactly that scope's recorder — a `switch_scope` racing the
 * call cannot redirect the write.
 * @param snap - the entry snapshot the calling handler resolved.
 * @param ctx - the handler's second callback parameter; the envelope is read
 *   fresh here, per call, per ADR-0005's 2026-10-09 addendum.
 * @param intent - what only the calling tool knows.
 * @param fn - the substrate call(s) to run inside the lock; its resolved value
 *   comes back as `value`.
 * @returns the recorder's `{commit, changed, value}` for the response body.
 */
export async function auditedWrite<T>(
  snap: ScopeBinding,
  ctx: ServerContext,
  intent: AuditIntent,
  fn: () => Promise<T>,
): Promise<AuditedResult<T>> {
  const clientName = clientNameFromEnvelope(ctx)
  return snap.recorder.runAudited(
    { ...intent, ...clientName !== undefined ? { clientName } : {} },
    fn,
  )
}

/**
 * The write assertion of ADR-0011's three-layer defense: the 8 commit-class
 * tools carry a required `scope_id`, compared **synchronously at handler
 * entry** against the snapshot — an agent that read scope A, watched a switch
 * to B, and then wrote asserting A must be refused (the request arrived after
 * the switch; the truth is B).
 * @param snap - the entry snapshot.
 * @param assertedScopeId - the caller's `scope_id` argument.
 * @throws ScopeMismatchError when the assertion names a scope that is not the
 *   snapshot's.
 */
export function assertScopeMatch(snap: ScopeBinding, assertedScopeId: string): void {
  if (assertedScopeId !== snap.scopeId) {
    throw new ScopeMismatchError(
      `scope_id "${assertedScopeId}" does not match the active scope "${snap.scopeId}" this call bound at entry — the switch happened after your read; re-read under the new scope or switch back`,
      { asserted_scope_id: assertedScopeId, active_scope_id: snap.scopeId, remedy: 'switch_scope to the scope you meant, or update the assertion to the active scope' },
    )
  }
}

/**
 * The response stamp every definition tool inlines at its payload's top level
 * (`scope: {id, root}`, ADR-0011's stamp layer): self-describing responses, so
 * a straddled response arriving after a switch still says which scope served
 * it. Derived from the snapshot, never from live state.
 * @param snap - the entry snapshot.
 * @returns `{id, root}` for the response body.
 */
export function scopeStamp(snap: ScopeBinding): Readonly<{ id: string; root: string }> {
  return { id: snap.scopeId, root: snap.semanticRoot }
}

/**
 * The one home for "did this write path run the on-write enrichment hook":
 * `'table'` did (`updateTableMeta`/`syncWrite` call `enrichOnWrite`), `'event'`
 * did not (`updateEventMeta` has no hook — deferred, see the Core class's own
 * note on `discoverEventRelations`), `'concept'` did not either — concepts
 * have no enrichment rounds at all (ADR-0012 / #46 measured 'concept'
 * zero-hit in enrichment*.ts; reporting health for a concept write would be
 * the exact misattribution the event branch already refuses), and `'round'`
 * always did (`apply_enrichment`/`run_enrichment` enrich by definition).
 *
 * This used to be a `kind === 'table' ?` ternary copy-pasted across five
 * handlers. Reporting health for an *event* write would misattribute whatever
 * an earlier table write left behind — the failure mode this function exists
 * to make impossible to re-introduce by accident.
 * @param snap - the entry snapshot.
 * @param writePath - which write path just ran: the kind for the meta-update
 *   tools, or `'round'` for the enrichment tools.
 * @returns the health snapshot to inline, or `undefined` when the write path
 *   has no hook — a response key that must stay absent, never an empty array.
 */
export function enrichmentHealthAfter(
  snap: ScopeBinding,
  writePath: 'table' | 'event' | 'concept' | 'round',
): readonly EnrichmentHealthEntry[] | undefined {
  if (writePath === 'event' || writePath === 'concept') return undefined
  return snap.core.getEnrichmentHealth()
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
 * Apply one field overlay via `updateTableMeta` / `updateEventMeta` /
 * `updateConceptMeta`, dispatched by `kind`, with an explicit return type.
 *
 * Not a bare `kind === 'table' ? core.updateTableMeta(...) : core.updateEventMeta(...)`
 * inline inside the audit seam's `fn`: measured — `UpdateTableMetaResult` and
 * `UpdateEventMetaResult` differ only in their success branch's field name
 * (`table_name` vs `event_name`), and TypeScript infers the seam callback's
 * `T` from whichever branch it resolves first, then rejects the other branch
 * against that fixed `T`. An explicitly-typed wrapper (dropping the field
 * neither branch's caller reads) sidesteps the inference order entirely,
 * rather than annotating every call site.
 * @param snap - the entry snapshot.
 * @param kind - which Tier-2 method to call.
 * @param name - the table_name / event / concept name.
 * @param updates - the field overlay to shallow-merge over the existing YAML.
 * @param expectedVersion - the caller's baseline fingerprint
 *   (`expected_version`, checked inside the lock by the write path).
 * @returns `{ok:true}` on success, or `{ok:false, error}` — never throws for a
 *   normal validation/not-found outcome.
 */
export async function applyFieldUpdate(
  snap: ScopeBinding,
  kind: 'table' | 'event' | 'concept',
  name: string,
  updates: Readonly<Record<string, unknown>>,
  expectedVersion: string,
): Promise<ApplyResult> {
  if (kind === 'table') {
    const res = await snap.core.updateTableMeta(name, updates, { expected_version: expectedVersion })
    return res.ok ? { ok: true } : res
  }
  if (kind === 'event') {
    const res = await snap.core.updateEventMeta(name, updates, { expected_version: expectedVersion })
    return res.ok ? { ok: true } : res
  }
  const res = await snap.core.updateConceptMeta(name, updates, { expected_version: expectedVersion })
  return res.ok ? { ok: true } : res
}

/**
 * The promotion machinery's MCP half (#136 / ADR-0021 R5–R7, as revised by
 * ADR-0023 R5/R6 and narrowed by ADR-0027 R6) — the shared pieces the five
 * definition-write tools (`create_definition` / `update_definition` /
 * `add_alias` / `add_relation` / `import_definitions`) wire in, so none of
 * them re-derives the ceremony:
 *
 * - **The intent spread** ({@link evidenceForIntent}): the caller-declared
 *   `evidence` rides `AuditIntent` → `AuditContext` → `CommitContext`, the
 *   same per-call channel `sessionId` (#152) already takes — the trailers
 *   (`X-SG-Evidence` / `X-SG-Evidence-Source` / `X-SG-Memory`) are rendered
 *   by `git/message.ts` from that one thread.
 * - **The guard** ({@link guardReplicatedEvidence}): ③ replicated only. Runs
 *   inside the audit window (locked, before anything stages) and throws the
 *   coded `promotion_rejected` whole-call refusal on the substrate's first
 *   finding; ① source / ② user-stated are decisive on their own and pass
 *   through untouched.
 * - **The back-pointer append** ({@link appendPromotionBackpointers} /
 *   {@link withPromotionWrite}): the same-commit half of ADR-0023 R6. A
 *   replicated promotion wraps its write in one `beginBatch`, appends
 *   `promoted: [{to, at, session}]` onto every counting cited memory through
 *   `writeMemoryYaml`'s audited seam, and `end()` makes the single commit
 *   that carries both the fact-layer write and the memory-side appends. A
 *   throw anywhere aborts the batch whole (the recorder resets to HEAD), so
 *   a promotion never half-lands.
 * - **The promoting session** ({@link promotionSession}): the same identity
 *   `record_memory` stamps into `recorded.session` — the config's
 *   `sessionId` when the host set one, else this process's lazily-minted
 *   `sg-<uuid>` (one process ≈ one serving session under stdio, #152's
 *   ruling; the mint moved here when the definition tools needed it too).
 *
 * `to` semantics (ADR-0023 R6 leaves the batch case open; this is the
 * minimal rule, recorded in the ADR's Update): one back-pointer entry per
 * fact-layer object the call landed or affirmed — the single subject for the
 * four single-target tools (whatever their rows' idempotence: the object
 * identity and the promotion claim are both real), the canonical edge per
 * relation for `add_relation`, and per non-error item row for
 * `import_definitions` (an `error` row named an object that never came to
 * exist, so it gets no back-pointer). `to` never reaches below object
 * identity (ADR-0021 R3).
 *
 * @module tools/promotion
 */
import { randomUUID } from 'node:crypto'
import { PromotionRejectedError } from '../errors.ts'
import type { ScopeBinding } from '../binding.ts'
import type { PromotionEvidence } from '../git/message.ts'
import type { ServerDeps } from '../server.ts'
import { withAuditedBatch } from './audited.ts'
import type { PromotionEvidenceInput } from './shared.ts'

// ── The lazily-minted process session (moved from tools/memory.ts, #136) ─────────

/**
 * One session id for this server process's lifetime — `recorded.session`'s
 * default when `ServerConfig.sessionId` is unset, and the promoting session
 * a replicated promotion's `promoted` back-pointer carries. Under stdio no
 * host-tracked session exists to read (the 2026-07-28 revision is stateless),
 * and one process ≈ one serving session, so a startup mint is the honest
 * identity; tests and embedding hosts that need two distinguishable sessions
 * in one process set distinct `config.sessionId` values instead.
 */
let generatedProcessSession: string | undefined

/** The process-lifetime session mint (see {@link promotionSession}). */
function processMemorySession(): string {
  if (generatedProcessSession === undefined) {
    generatedProcessSession = `sg-${randomUUID()}`
  }
  return generatedProcessSession
}

/**
 * The session identity a promotion writes under: the config's `sessionId`
 * when the host declared one, else the process mint — the exact identity
 * `record_memory` stamps into `recorded.session`, so a memory recorded in
 * session X and promoted by the same server names session X in its
 * back-pointer.
 * @param deps - the server deps (the config's `sessionId`).
 */
export function promotionSession(deps: ServerDeps): string {
  return deps.config.sessionId ?? processMemorySession()
}

// ── The intent spread ─────────────────────────────────────────────────────────────

/**
 * The `evidence` an `AuditIntent` carries, as a spreadable fragment — absent
 * on every ordinary write so those intents (and their trailer blocks) are
 * byte-identical to before #136.
 * @param evidence - the caller-declared block, when this write is a promotion.
 */
export function evidenceForIntent(evidence: PromotionEvidenceInput | undefined): { readonly evidence?: PromotionEvidence } {
  return evidence === undefined ? {} : { evidence }
}

// ── The guard + the append ────────────────────────────────────────────────────────

/**
 * Run the server-side replication guard for one promotion call (③ only;
 * ① source / ② user-stated need no citation and pass through). Call this
 * INSIDE the audit window, before anything stages, so a refusal rejects the
 * whole call with nothing written.
 * @param snap - the entry snapshot (the serving core runs the check).
 * @param evidence - the caller-declared block.
 * @returns the counting (`effective`) cited ids for the back-pointer append —
 *   empty when this call is not a replicated promotion.
 * @throws PromotionRejectedError (`promotion_rejected`, −31026) with the
 *   substrate's actionable message (which id failed which rule) when the
 *   citation does not verify.
 */
export function guardReplicatedEvidence(snap: ScopeBinding, evidence: PromotionEvidenceInput | undefined): readonly string[] {
  if (evidence?.kind !== 'replicated') return []
  const check = snap.core.checkReplicatedEvidence(evidence.memories ?? [])
  if (!check.ok) {
    throw new PromotionRejectedError(check.error, { reason: check.reason, memories: evidence.memories ?? [] })
  }
  return check.effective
}

/**
 * Append the `promoted` back-pointer onto the cited memories (ADR-0023 R6):
 * one `{to, at, session}` per (counting memory × target), through the Core's
 * audited seam — call it inside an open `beginBatch` so the appends ride the
 * promotion's own commit. No-op for an empty citation or no targets.
 * @param snap - the entry snapshot.
 * @param deps - the server deps (the promoting session's config).
 * @param effective - the counting ids {@link guardReplicatedEvidence} returned.
 * @param tos - the promotion targets (canonical node ids / edge strings).
 */
export async function appendPromotionBackpointers(
  snap: ScopeBinding,
  deps: ServerDeps,
  effective: readonly string[],
  tos: readonly string[],
): Promise<void> {
  if (effective.length === 0 || tos.length === 0) return
  await snap.core.appendPromotionBackpointers(
    effective.flatMap(id => tos.map(to => ({ id, to }))),
    { session: promotionSession(deps) },
  )
}

/**
 * One single-target promotion write, orchestrated: guard inside the audit
 * window, then the write itself — and for ③ replicated, both the write and
 * the back-pointer append inside ONE `beginBatch`, so `end()`'s single commit
 * carries the fact-layer change and every memory-side `promoted` append
 * (ADR-0023 R6's 同一 commit). Non-replicated calls (① source, ②
 * user-stated, and ordinary writes with no `evidence` at all) run `fn`
 * exactly as their handler did before — no batch wrapper, byte-identical
 * commit shape.
 *
 * `fn` must throw rather than resolve on a write that did not land (every
 * wired caller's write path already does — the Core's update-family methods
 * throw, and create's branches throw on their `{ok:false}`): a resolved `fn`
 * means the promotion target is affirmed, and the appends follow.
 * @param snap - the entry snapshot.
 * @param deps - the server deps.
 * @param evidence - the caller-declared block, when this write is a promotion.
 * @param tosOf - the promotion targets, derived from the write's own result
 *   (the subject node id, or the landed edges) — one back-pointer per target.
 * @param fn - the wrapped substrate write(s).
 * @returns whatever `fn` resolved with.
 */
export async function withPromotionWrite<T>(
  snap: ScopeBinding,
  deps: ServerDeps,
  evidence: PromotionEvidenceInput | undefined,
  tosOf: (value: T) => readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const effective = guardReplicatedEvidence(snap, evidence)
  if (evidence?.kind !== 'replicated') return fn()
  return withAuditedBatch(snap, async (batch) => {
    const value = await fn()
    const tos = tosOf(value)
    await appendPromotionBackpointers(snap, deps, effective, tos)
    // One logical write: the promotion itself, its back-pointers included.
    batch.record('promote', { tos })
    return value
  })
}

// ── The description fragment the five tools render ────────────────────────────────

/**
 * The promotion paragraph the five definition-write tools append to their
 * descriptions (single source, the ADR-0027 R2 regimen-rendering precedent):
 * how an agent declares a promotion, and what the server does about it.
 */
export const PROMOTION_EVIDENCE_DESCRIPTION = 'Promotion (ADR-0021): when this write moves a verified conclusion out of the memory layer into the fact layer, declare `evidence` — kind "source" (a deterministic source: DDL / column comment / doc / code — name it in `source`), "user-stated" (a human stated it), or "replicated" (cite the memory ids in `memories`; the server verifies ≥2 counting entries from distinct sessions on distinct UTC days — incidents, contested entries and wrong-superseded ones never count — and appends a `promoted` back-pointer onto each cited memory in this commit). The commit carries X-SG-Evidence (and X-SG-Memory for a replication). Ordinary writes omit `evidence` entirely.'

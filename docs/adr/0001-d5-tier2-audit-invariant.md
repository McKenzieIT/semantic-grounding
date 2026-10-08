# ADR-0001: D5 Tier-2 audit invariant is a core-level invariant

- **Status**: accepted
- **Date**: 2026-10-07
- **Deciders**: McKenzieIT
- **Supersedes**: implicit D5 policy in `deepseek-harness-da` (src/index.ts:1092)

## Context

The upstream `deepseek-harness-da` semantic-layer enforces a **D5 policy**: Tier-2 audit
recording is fail-loud and non-disableable. Concretely, when a Tier-2 recorder is wired
into the host context (`ctx.get('audit')`) and a recording call fails, the layer throws
rather than silently dropping the event (see source `src/index.ts:1092`).

This is not an optional diagnostic: it is the guarantee that provenance-carrying mutations
to the semantic layer (definition writes, relation edges, enrichment applications) are
observable and auditable. The code comment in the upstream source calls this out as a
D5-level policy — Tier-2 audit cannot be turned off by a host, even by accident.

When extracting the semantic layer into a **host-neutral** core, the naive translation
is to drop the `ctx.get('audit')` lookup (because the new core has no host context).
Doing so silently downgrades the guarantee: a host that forgets to wire a recorder
produces a core that quietly forgets to record. The behaviour is preserved; the
guarantee is lost.

## Decision

The fail-loud behaviour is a **core-level invariant**, not a host concern.

The extracted core MUST throw when a Tier-2 recording is required but no recorder is
wired, OR when a wired recorder raises. The invariant is expressed as:

> **Invariant (D5)**: any code path that mutates auditable state (definition writes,
> relation edges, enrichment applications with provenance) MUST either record the
> mutation via the wired `Tier2Recorder` or throw. Silent drop is not a valid outcome.

Concretely:

- The core exposes a setter-injected `Tier2Recorder` (matching the existing
  `src/io.ts:38` interface shape).
- If no recorder is wired, the core throws on any auditable mutation. This is the
  same fail-loud behaviour the upstream enforces via `ctx.get('audit')` at
  `src/index.ts:1090`.
- A host that wants audit-off behaviour must explicitly pass a no-op recorder that
  still satisfies the type — making the downgrade a deliberate, code-visible choice,
  not a wiring accident.

## Consequences

- **Core test suite** must include a test that asserts throw-on-missing-recorder for
  every auditable mutation path. This is the regression guard.
- **Adapters** (dsh or otherwise) that previously relied on `ctx.get('audit')` to
  surface a recorder must now explicitly set it via the core's setter. The call site
  moves; the guarantee does not.
- **No silent downgrade path exists.** A host that wires nothing gets a loud failure,
  not a quiet core. This is the only way to preserve the D5 guarantee across the
  host boundary.

## Verification

The negation test for host neutrality (see map Destination) already requires that core
tests pass without `cordis` in `node_modules`. This ADR adds one additional assertion
to that suite: the auditable-mutation-throws-on-missing-recorder test.

## References

- Upstream source: `packages/data/semantic-layer/src/index.ts:1090-1092` (Tier-2 fail-loud throw)
- Upstream recorder interface: `packages/data/semantic-layer/src/io.ts:38`
- Map: `wayfinder:map` issue on this repo (to be created)
- Task: slice ticket on inverting Tier2Recorder (to be created)

## Update 2026-10-08 — the second half is mechanized

[#6](https://github.com/McKenzieIT/semantic-grounding/issues/6) (a wired recorder that
raises leaves an unaudited write on disk while the batch reports `written: 0`) is closed
by [map #12](https://github.com/McKenzieIT/semantic-grounding/issues/12) ticket
[#13](https://github.com/McKenzieIT/semantic-grounding/issues/13):

- The recorder contract is now **async** (`recordTier2Write(): Promise<string>`) — git
  commit is a subprocess and must not block the event loop.
- The Tier-2 write paths snapshot the pre-write **raw bytes** and restore them when a
  recorder raises (new files are deleted), then re-throw; in the batch path an audit
  failure rolls back the current table and aborts the batch (already-committed tables
  keep their own audits). The invariant text is unchanged — "either records or throws"
  — and gains a mechanically enforced corollary: **after a throw, disk is back at the
  pre-write state**; the third state (unaudited residue) is no longer expressible.
- A recorder that raises thereby **asserts the write did not happen**; it must leave
  index/HEAD untouched (the git recorder's own obligation, ADR-0004).
- Fail-silent recorders (dsh's `ctx.audit`) never raise, so they never trigger the
  rollback — their weaker semantics are a visible host choice, not a substrate failure.

Execution lands in
[#18](https://github.com/McKenzieIT/semantic-grounding/issues/18) (contract change +
test flip). The host-side recorder that makes raise-on-failure real is the git
recorder, specified in ADR-0004.

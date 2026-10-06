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

# Seed: MCP management-surface map

**Status**: seed only — not a map yet. Charting is its own session (`/wayfinder` with
the loose idea below). Recorded here so the facts established while resolving
[map #1](https://github.com/McKenzieIT/semantic-grounding/issues/1)'s slice 2 are not
lost between sessions.

**Why a separate map and not fog on map #1.** Map #1's Destination is the dsh tarball
cutover. The MCP surface sits past it, and map #1's Out-of-scope already listed "MCP
adapter". The wayfinder rule is that out-of-scope work never graduates — it returns
only if the destination is redrawn, and then as a *fresh effort*. Confirming MCP moved
slice ③'s priority forward; it did not make MCP part of map #1. This map starts from
the pure core map #1 delivers.

## The loose idea

Expose the semantic grounding substrate as an **MCP server**, so working agents (not
humans) maintain the semantic layer: read it for NL→SQL grounding, and write back the
definitions, relations and aliases they discover.

## What is already settled

These came out of map #1 slice 2 and should not be re-litigated:

- **Core is host-neutral and proven so.** A tarball install into an environment with
  no cordis loads, constructs, registers all three kinds, enforces D5, and disposes.
  `grep -c cordis lib/index.js` = 0. The MCP server embeds core as a plain class:
  `new SemanticGroundingCore(config)` + setters. No adapter needed on core's side.
- **Multiple cores per process works.** This was the decisive argument for removing
  `extends Service`: a cordis context admits exactly one service per name, so one
  context held exactly one semantic layer. Now each core instance carries its own
  recorder / scope registry / provider / LLM call, so one MCP process can serve
  several agents over several corpora.
- **Write is in scope, and write means Tier-2.** The whole point is that agents
  maintain the layer rather than humans hand-editing it. Tier-1 (`pending.ts`) is a
  *suggestion queue*, not an independent write path — it has no `approve`; approving
  means performing the corresponding Tier-2 write and discarding the entry. So the MCP
  server needs Tier-2, and therefore needs a `Tier2Recorder`.
- **Audit backbone direction: git.** Chosen, details not designed. See below.

## First ticket (blocking): the Tier-2 audit backbone

D5 (ADR-0001) admits no "wire it later": an auditable mutation without a recorder
throws. So the MCP server cannot ship before its recorder exists. Direction is
**git as the audit backbone**, for three reasons that reinforce each other:

1. **The corpus already lives in git.** dsh's `examples/k11-semantic-layer/`
   (`config.yaml` + `tables/` + `events/`) is version-controlled; the Tier-1 queue
   lives in `var/`, which is gitignored. That split already encodes "source-of-truth
   is versioned, runtime scratch is not".
2. **`git blame` *is* field-level provenance.** GLOSSARY defines provenance as "for
   any field on any definition, you can answer why this value is what it is".
   `git log -p --follow tables/<t>.yaml` answers it with author (which agent), time,
   and a commit message that can carry the derivation (deterministic vs LLM round,
   confidence). An independent JSONL audit stream makes the YAML state and the audit
   record two datasets that can disagree; git makes them one.
3. **branch/PR is the missing `approve` side.** `pending.ts` has no `approve`
   implementation. Agent writes a branch → opens a PR → an admin (human *or*
   higher-privilege agent) merges. The review mechanism comes for free, and "admin" was
   always a role rather than a person.

**Known costs to design against** (none disqualifying, all unresolved):

- `git commit` is not a low-latency synchronous op, and D5 means a failed commit must
  throw — so write failure rates rise under load.
- Several agents writing one corpus will hit git conflicts. Needs serialization, or
  per-scope repos, or both.
- The server needs repo write access plus a commit identity per agent.
- A deployment whose corpus is *not* a git repo needs a fallback recorder, or the
  deployment is unsupported. Decide which.

**It may also dissolve issue #6.** #6 is the D5 gap where the write path writes YAML
*then* records, leaving an unaudited file on disk if the recorder raises. With git,
`git add` + `git commit` is one atomic write-and-record, so the gap stops being
expressible. #6 was deliberately filed rather than fixed for this reason — fixing it
standalone risks building an atomicity mechanism the git recorder then replaces.
Resolve #6 *through* this ticket, not before it.

## Fog (not tickets yet)

- **Which tools does the server expose?** Read side (retrieve / relations / aliases /
  prompt-context) is clear enough. Write side has a real choice: expose Tier-2
  directly, or expose Tier-1 and let an admin agent perform the Tier-2 half? The
  `polluting source-of-truth >> polluting instructions` stance in `pending.ts` argues
  for a gate; "agents maintain the layer" argues against a human-shaped one. The
  resolution is probably an **automated** approve path, which is a design question of
  its own.
- **Scope/tenant model.** One core per scope, one per request, or a pool? Interacts
  with the `_invalidationHooks` global-broadcast hazard in map #1's Not-yet-specified
  (the one real multi-instance problem; `_corpusVersion` and `_snapshotCache` were
  checked and are root-keyed, hence safe).
- **Does the MCP server own enrichment?** Core's enrichment needs an LLM call
  (`setLlmCall`). dsh wires it from `ctx.llm` via `llm-wiring-plugin.ts`. The MCP
  server needs its own provider wiring, or it ships deterministic-only enrichment.
- **Transport and deployment shape** (stdio vs HTTP/SSE, process-per-tenant vs
  shared). Note: the "cordis logger would corrupt stdio JSON-RPC" concern was
  investigated and is **not** a real risk — `LoggerService` registers no exporter by
  default, so `ctx.logger.warn` writes 0 bytes to stdout. Recorded so nobody
  re-discovers it as a blocker.
- **Public API surface.** Depends on map #1's slice 3, which now has a note that the
  export rule must widen to "live dsh consumer **or** confirmed MCP need", with
  `pending.ts` / Tier-2 writes / `snapshot.ts` contested in MCP's favour.

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

  ⚠️ **This choice was posed over a two-tier model that does not match the code.**
  Found while resolving map #1's slice 3: there is a **third** write path, the
  *raw-edit surface* — `writeTable(semanticLayer, name, data, { skipValidation? })`
  and `writeEventYaml(semanticLayer, name, content)` take **no recorder parameter**,
  so they write corpus YAML with no audit record at all. Both are on the **public API
  surface**, so an MCP server gets an unaudited write door for free. This is *not*
  issue #6 (#6 is a *wired* recorder that raises); this is the absence of a recorder
  parameter. Internally it is deliberate for auto-derived facts (`enrichAll*` persists
  `dimension_refs` via `writeTable`, documented "best-effort, unaudited"); what is not
  deliberate is its publicness. dsh uses the same name for it and is migrating off:
  "routing through the substrate `updateEventMeta` (Tier-2 audited) **instead of the
  raw-edit `writeEventYaml` surface**"
  (`packages/extensions/tool-cordis/src/api-catalog.ts:2152`) — but `tool-revert-edit`
  still calls raw `writeTable`/`writeEventYaml` deliberately
  (`packages/data/tool-revert-edit/src/index.ts:191-203`), so it cannot simply be
  deleted. GLOSSARY § write tier now records all three paths honestly.

  **Two questions for this map, not map #1:** (1) should the raw-edit surface exist as
  a concept, or should auto-derived writes record through a recorder too? (2) should it
  be public? Note git-as-audit-backbone may dissolve both — under `git add` +
  `git commit`, "unaudited write" stops being expressible.

  Also corrected: GLOSSARY used to name `writeEventYaml` as the Tier-1 approve path,
  which meant **the documented approve path bypassed D5**. Fixed to `updateEventMeta` /
  `updateTableMeta` + `discard`. If this map builds an automated approve path, it must
  route through the audited pair.
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
- **Public API surface.** ✅ **Settled by map #1's slice 3** — see
  `docs/adr/0002-v01-public-surface-allow-list.md`. The contested items were a
  non-issue: `pending.ts` (Tier-1), Tier-2 writes and `snapshot.ts` were **already**
  on the root barrel, so nothing had to be added for MCP and nothing was withheld.
  The export rule's justification set is now three-source — live host consumer, or
  confirmed host need (MCP counts), or required to implement a documented extension
  point — with host consumption treated as *evidence* of domain need rather than its
  definition. No cross-map dependency remains: this map does not wait on map #1's
  surface work.

  One thing still lands here: **name-level curation of the root barrel** is its own
  ticket on map #1, blocked by slice 4 (dsh must resolve through `exports["."]` before
  a cut can be falsified). Convention-coupled names (`enrichAllDwsTables`,
  `DimensionKeyPair{dws_column,dim_column}`, the `maxcompute`/DWS-DIM defaults) are
  slated for exclusion there. If this map starts consuming such a name, say so on that
  ticket — it would promote the name under rule (b).

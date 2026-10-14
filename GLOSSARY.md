# Glossary

The single source of truth for domain terms used in this repo. Per the domain convention
(`docs/agents/domain.md`), agents and humans writing about this project use the words
defined here. If a term drifts, update this file — do not silently substitute a synonym.

---

## Core domain

### semantic grounding substrate (语义 grounding 底座)

This project. A **host-neutral** foundation that gives a text-to-SQL agent a typed,
structured understanding of a data domain — its entities, their relationships, and the
language users use to refer to them — without executing queries, rendering UI, or
discovering data. It is *grounding*, in the linguistic sense: it anchors an agent's
natural-language utterances to typed, auditable domain objects.

Grounding is the **read** half. The project is equally a **semantic layer management**
product: the agents that consume the layer are also the ones that maintain it, writing
back the definitions, relations and aliases they discover through the two-tier audited
[write path](#write-tier). "Management" is why [provenance](#provenance), the
[D5 invariant](#d5-invariant) and the [pending queue](#pending-queue) are core domain
concepts rather than operational detail — a layer that agents edit needs to answer
*who changed this, when, and on what evidence*.

It is **not** a metric engine (metric execution has been intentionally removed upstream).
It is **not** a data discovery portal.

It is **not** a `deepseek-harness-da` component. dsh is the first host; the MCP
management surface is the confirmed second. Host-neutrality is proven by the
[negation test](#negation-test), not by dsh's needs.

Internally it splits into [core](#core) (the domain; names no host) and
[shell](#shell) (the host-shaped edge). "Host-neutral" is a claim about core, proven
by the [negation test](#negation-test).

### kind

A type in the substrate's registry. A kind names a class of domain object — e.g.
`table`, `event`, `concept`, `column` — and declares the schema its definitions must
satisfy. The registry is typed: a definition is always *of* exactly one kind, and kind
membership is the primary axis along which retrieval, enrichment, and auditing operate.

### definition

A YAML-described instance of a kind. A definition carries the domain-facing identity
(name, aliases, provenance) and the kind-specific payload (schema for a table, fields
for an event, etc.). Definitions are the substrate's unit of storage, retrieval, and
mutation.

### relation

A directed, typed edge between two definitions. Relations form a graph over the
definitions in a corpus — e.g. `table --contains--> column`,
`event --references--> table`. Relations are first-class substrate objects (not
sidecar metadata), are themselves auditable, and drive both retrieval projections
and enrichment propagation.

### alias

An alternative surface name for a definition. Aliases are the primary bridge between
the language users actually use (Chinese, English, jargon, legacy names) and the
definition's canonical identity. Aliases feed the BM25 retrieval projection.

### corpus

A scoped collection of definitions and relations — the unit the substrate operates
on at runtime. A corpus is what gets loaded, indexed, searched, and enriched. The
k11 corpus (5.5 MB, 321 tables / 453 events / 10 concepts) is the reference fixture;
production deployments assemble their own. Under the MCP management surface a corpus
is its **own git repository** (corpus root = repo root): the [git recorder](#git-recorder)
makes commits the audit record, so the repo boundary and the corpus boundary coincide.

### cold start (冷启动)

How a newly registered, empty [corpus](#corpus) grows the [definitions](#definition)
it needs to support grounding — from an empty shell to a layer that answers reads.
Cold start is **trajectory-driven**: content is registered incrementally as it
surfaces in the consuming agent's working trajectory (a question naming an unknown
table, a DDL the agent reads), never pre-seeded as a bulk load. A term that maps to
a single asset lands as that asset's [aliases](#alias); a domain term that belongs
to no single asset lands as a concept — the ontology layer of the relation graph.
Content enters only through the audited [write path](#write-tier): a corpus may sit
empty, but it is never hand-filled behind the audit layer.

### enrichment

A deterministic, provenance-carrying transformation applied to a definition, driven
by the definition's kind and its position in the relation graph. Enrichment is how
the substrate propagates derived facts (e.g. a column inheriting a business glossary
tag from its parent table). Enrichment is deterministic: same inputs → same outputs,
always.

The LLM-assisted supplement is host-supplied, and the discipline never leaves the
substrate: an in-process host injects a completion callback, while the MCP
management surface offers outstanding gaps as [enrichment work](#enrichment-work)
for the connecting agent to complete (ADR-0006) — prompts, parsing, and the
merge rules stay inside either way.

### sweep engine (扫管引擎)

The parameterized sweep function (`sweepEnrichment`) that orchestrates enrichment
across all definitions of a given kind — iterate, discover, veto, merge, write,
collect errors. The engine holds the **编排** (orchestration); the per-kind logic
lives in an [EnrichmentKindAdapter](#enrichmentkindadapter). One engine, many
adapters: table/event today, concept tomorrow if ADR-0012's zero-hit measurement
changes. Designed in [#64](https://github.com/McKenzieIT/semantic-grounding/issues/64)
to collapse four mirrored pipelines (`enrichAllDwsTables` / `enrichAllEvents` /
`enrichAllTablesAltLabels` / `enrichAllEventsAltLabels`) into one function plus
kind-specific adapters.

### EnrichmentKindAdapter

The interface a kind implements to participate in the [sweep engine](#sweep-engine).
Composition, not extension: the adapter does not extend `DataSourceKindPlugin` (the
registry seam), because enrichment has concerns (load / write / prompt / veto / merge)
the registry plugin does not own. Mid-granularity — four required stage methods
(`discover` / `veto` / `merge` / `write`), an optional `prepare` that returns
`{ context?, skip? }`, plus the enumeration/projection seam: a required `list` (load +
schema-parse the kind's defs, project each one's `existing` enrichment items) and a
`writePolicy` data property (`'gain-only'` skips the write when a round found nothing
new — alt_labels' zero-commit idempotency; `'always'` rewrites every swept def —
relations' refresh mode). The `prepare.skip` path lets an adapter declare "this sweep
is meaningless" (e.g. relations adapter when no DIM tables exist) and short-circuit
the iteration. Designed in
[#64](https://github.com/McKenzieIT/semantic-grounding/issues/64), landed with the
alt_labels adapters in [#65](https://github.com/McKenzieIT/semantic-grounding/issues/65);
the table and event adapters live in `packages/substrate/src/enrichment/`.

### provenance

The record of where a definition's field value came from — authored in YAML, derived
by enrichment, or recorded from an LLM call. Provenance is what makes the substrate
auditable: for any field on any definition, you can answer "why is this value what
it is?".

Under the [git recorder](#git-recorder) the answer lives in the commit, not the YAML:
`X-SG-Derivation` / `X-SG-Confidence` trailers plus `git log -p --follow` say who wrote
a value and on what basis. YAML `origin` remains what it always was —
[enrichment](#enrichment) merge-priority machinery (undefined = curated = preserved by
rounds), not an authorship record. Two classes of concept in one neighborhood,
deliberately not aligned (ADR-0005). The negative counterpart —
[suppression](#suppression) — is a separate construct, not an `origin` value.

### suppression (持久否决)

Exists because enrichment is deterministic: remove a machine-derived alias and the
next round re-derives it — the write-delete loop. A suppression is **negative
knowledge** about a definition: a standing verdict that one specific candidate — an
[alias](#alias) on this definition, or a [relation](#relation) from it to a DIM —
must never be re-asserted by an [enrichment](#enrichment) round, deterministic or
LLM alike. It is per-asset and per-candidate ("never again *for this definition*");
a corpus-wide tier exists as a data path — a hand-edited word list at the corpus
root whose entries filter every definition's candidates — with no tool verb of its
own: corpus-wide veto needs the whole-corpus view an agent in conversation doesn't
have, so its write path is the curated hand-edit, and a Tier-2 verb stays deferred
until a live agent demonstrably needs one.

The boundary it draws is machine rounds, not writers: an operator hand-adding a
vetoed candidate back is a curated act with its own git history, not a violation.
This is [provenance](#provenance)'s boundary seen from the other side — `origin`
protects what is already asserted ("don't touch mine"), a suppression governs what
may be re-asserted ("don't bring me this again") — two constructs, deliberately not
one mechanism: SARIF v2.1.0 §3.35 separates `suppressions` from `provenance` on the
same result the same way, as ADR-0005 separates YAML `origin` from
`X-SG-Derivation`. A suppression is born by removal — deleting a machine-derivable
alias or relation is itself the veto, because the write-delete loop is what it
exists to stop — and dies by re-assertion: adding the word back lifts it. Both are
ordinary audited writes; the veto carries no state of its own to transition.
Storage is per-asset and key-only (a label's normalized form; a relation's DIM
table): the veto carries no provenance of its own — who vetoed, when and why are
answered by the [git recorder](#git-recorder)'s commit, like every other
[Tier-2](#write-tier) write. The name *tombstone* was weighed and rejected: in data
catalogs it is a storage-layer mechanism (later writes override it, it is forgotten
on a timer, it exists to propagate deletes to replicas), while a suppression is a
time-independent policy. No compaction or expiry — every catalog surveyed keeps
vetoes for good, and this corpus's measured ceiling (~2.7 vetoes per definition) is
far below any pressure that would justify one.

### memory (数据 memory)

An experiential record about one or more definitions that holds only within the context
that produced it: it carries a point in time, a partition or session context, or it is
not yet verified ("877 rows vs 873 distinct `order_id` on `ds=20260729`", "subject
inferred from the table name", "upstream did not produce on 20261003"). The dividing
line against a fact is a single test: **does it still hold outside the moment and
session that produced it, and has it been verified?** Both yes → it belongs in a
[definition](#definition); either no → it is a memory.

A memory is **not a definition and never part of one**: it lives in its own store,
anchors by identity to one or more definitions or [relations](#relation) (at least one),
and writing it changes no definition. The reference runs one way — the fact layer
holds no link back to its memories. So the model is two stores, not three: the **fact
layer**, seen through two views — the semantic layer (warehouse objects: tables,
events, metrics) and the knowledge graph (business concepts and their edges) — and the
**memory layer**. "Three layers" remains fine as a way to talk to users.

Five types, each with a fixed way out: **observation** (a dated measurement or
phenomenon; its conclusion may be [promoted](#promotion-晋升) once replicated, the
number never is), **caveat** (the range a fact was *not* verified over; never promoted,
superseded when the gap is re-verified, always shown alongside the fact it qualifies),
**inference** (an unverified judgement plus its basis; promoted once verified),
**practice** (an adopted 口径 or workaround; promoted as a verified query or metric
definition once a human states it), **incident** (a time-bounded event with a validity
window; never promoted, hidden once expired). Avoid *note*, *lesson* and *observation*
as synonyms for memory — the last is one of its types.

### promotion (晋升)

Writing a conclusion that has outgrown its context out of the [memory](#memory-数据-memory)
layer and into the fact layer. The agent promotes on its own — there is no approver —
but must declare the evidence, and only three kinds count: a **deterministic source**
(DDL, column comment, documentation, code), a **human stating it** in the conversation,
or **independent replication** — at least two memories from different sessions on
different days reaching the same conclusion, which the server checks rather than takes
on trust. A single observation, the agent's own inference, or a batch run vouching for
itself is not evidence. The first two kinds may promote directly with no memory in
between; replication by definition cites the memories it rests on. Promotion is an
ordinary audited write, and where it came from is answered by its commit, never by the
fact itself. Filling in a "confirmed by" field is not promotion.

### write receipt (写回执)

What a commit-class tool answers with, beyond the verdict: the envelope
`{scope, commit, changed, version?, enrichment_health?, _guidance?, …domain keys}`
every definition write returns — one shape, assembled in one place (the MCP
frontend's `writeReceipt`). `commit` + `changed` are the [git
recorder](#git-recorder)'s answers; `scope` is the entry snapshot's stamp
(ADR-0011's response layer); `enrichment_health` and `_guidance` are zero-tax
keys — present only on the write paths and tools they apply to, absent (never
`null`) otherwise; the domain keys (`results`, `unsuppressed` rows, `summary`)
are whatever only the calling tool knows.

The receipt's newest member is `version` — the sha256 fingerprint of the file
this write touched, **as the whole write left it** (the on-write enrichment hook
may rewrite the same file after the primitive's own write; the receipt names the
end state, or the caller's next `expected_version` write would be rejected
against a dead baseline). Feed it straight back as the next write's baseline and
the write → write loop closes with zero `get_definition` read-backs — the
measured pain (12+) the receipt exists to retire. A **no-op** receipt
(`changed: false`) still names the file's *current* fingerprint: the hash is
taken off the bytes just written, and a byte-stable no-op writes the same bytes —
so "nothing changed" and "here is the fresh baseline" are one answer, at zero
extra I/O. Non-definition write receipts ([enrichment](#enrichment) rounds) and
the import batch's top level (one commit spans many files) carry no `version`;
import answers per row instead.

## Runtime architecture

### registry

The typed container holding kinds and their definitions at runtime. The registry is
the substrate's runtime index; retrieval and enrichment both operate through it.

### scope

A runtime context key that selects which definitions and relations are visible to a
given operation. Scopes are how one substrate instance serves multiple logical
workloads (e.g. different business domains, different access levels) without
reloading.

### core

The substrate minus its shell: every module that models the domain and names no host
concept. Concretely, everything under `src/` except the files on the shell allow-list
in `scripts/check-core-purity.mjs`. Core is a plain class (`SemanticGroundingCore`)
plus the modules it composes — it imports no host framework, and takes every
collaborator (Tier-2 recorder, scope registry, schema provider, LLM call) through a
setter rather than looking one up.

"Core" and "substrate" are near-synonyms; prefer **core** when contrasting with the
shell or an adapter, and **substrate** when contrasting with the host or naming the
project as a whole.

### shell

The host-shaped edge of the package: the code whose job is *where the substrate
lives* rather than *what the domain means* — mounting, naming (`ctx.schema`),
service location, lifecycle, logging. A shell is supposed to name its host; that is
not a defect, it is the shell's purpose.

Distinguishing shell from core is what makes the host-neutrality claim precise. Before
slice 2, "remove cordis from core" sounded like a claim about ~5,000 LOC when it was a
claim about 14 lines in one file: the domain modules (`io.ts`, `enrichment.ts`,
`registry.ts`, `corpus.ts`, `relation-graph.ts`, `types.ts`, `snapshot.ts`,
`metrics.ts`, `kinds/*`) never named a host at all.

**`src/` now contains no shell at all.** The last one, `llm-wiring-plugin.ts` (a cordis
plugin), moved into the [dsh](#dsh) adapter in slice 4a, so
`scripts/check-core-purity.mjs` runs with an **empty** allow-list and the substrate's
`peerDependencies` is empty — `schemastery` and `dsh-llm` were only ever imported by
that one file, and `cordis` was type-only. Core and substrate are therefore the same
set of files today; the distinction stays in the glossary because a future host seam
would land as a shell again, and because the [negation test](#negation-test) is phrased
over it. The shell allow-list shrinking to empty was the
end state.

### adapter

A thin, host-specific package that wires the substrate's [core](#core) into a
particular host runtime — the [shell](#shell), extracted. One adapter per host.
Adapters are *outside* core and do not affect core's host-neutrality. The dsh adapter
is the first; others may follow. Core has no adapters as dependencies.

An adapter wraps; it is never reached for. The dsh adapter presents core as a Cordis
`Service` on the `ctx.schema` seam and forwards `ctx.audit` / `ctx.get('scopes')` into
core's setters. Core does not know an adapter exists.

### host

The runtime environment that embeds the substrate (e.g. `deepseek-harness-da` /
dsh, the MCP management surface, a standalone CLI). The substrate's host-neutrality
claim is that [core](#core) runs unchanged across hosts, proven by the
[negation test](#negation-test).

A host embeds core by constructing it and wiring its setters; it never mounts core
into itself and lets core reach back. Each core instance carries its own
collaborators, so one host process can hold several cores over different corpora.

### read epoch (读 epoch)

The caching scope for a single tool call's read path. Within one epoch, `loadTables`
and `loadEvents` return the same parsed arrays rather than re-reading disk; the epoch
ends when the call returns, so the next call gets a fresh read. ADR-0015.

The cache key is **composite**: `(per-call epoch) × (in-process corpusVersion)`. Both
halves are independently necessary:

- **`corpusVersion`** alone is an in-process monotonic counter bumped by
  `invalidateCaches` on every write. It cannot see writes from other processes — and
  the substrate runs under multi-process contention (`concurrent-write.spec.ts` spawns
  separate OS processes behind a pid-file lock). Process A caching on `corpusVersion`
  alone would serve stale data indefinitely after process B writes.
- **Per-call epoch** alone would let a later write inside the same call (e.g. pipeline
  3 of `run_enrichment` writing `alt_labels`) use a stale `raw` from before pipeline 1
  wrote `dimension_refs`, silently reverting the earlier write — the "whole-field
  overwrite loses concurrent edits" failure ADR-0004 ruling 8 names.

The epoch is provided via `AsyncLocalStorage` (`withReadEpoch(fn)` in
`src/read-epoch.ts`); `loadTables` / `loadEvents` check for an active epoch and either
return the memoised array or read straight from disk when none is open. The
no-epoch-when-open path is byte-identical to today, so any caller that does not enter
an epoch is unaffected.

Distinct from [`snapshot`](#snapshot), which pins definitions for the duration of a
single query for MVCC isolation and is currently a deferred capability (ADR-0005 ruling 6
refused snapshot handles on the MCP read surface; ADR-0017 parks it behind a trigger —
cross-call consistent-read requirements). The two caches have genuinely different
lifetime requirements; merging them would bend one correct semantic toward the other.

### snapshot

A frozen, point-in-time view of all definitions in a semantic layer, used for MVCC
isolation during a single query's execution. A snapshot pins the tables, events, and
retrieval corpus at the `corpusVersion` captured when it was acquired; subsequent
`invalidateCaches` calls do not affect a held snapshot. Public API on
`SemanticGroundingCore.withSnapshot(fn)`. ADR-0005 ruling 6 explicitly refused
snapshot handles on the MCP grounding read surface — snapshots serve dsh's
query-execution needs, not MCP's tool-call reads. Distinct from the
[`read epoch`](#read-epoch-读-epoch), which is a per-call cache for the read path
rather than an MVCC pin; the two have different lifetime requirements and are not
merged (ADR-0015 R9).

## Audit and tiers

### write tier

Which write path a mutation takes. The distinction is a *security* boundary, not an
implementation detail. Two tiers are **designed**; a third path exists in the code and
is named here because omitting it made this table read as a guarantee it does not give:

| | **Tier-1** | **Tier-2** | **write primitive** (raw-edit) |
|---|---|---|---|
| What an agent may do | **suggest** only | write source-of-truth directly | write source-of-truth directly |
| Where it lands | the [pending queue](#pending-queue) in `<gitDir>/sg-pending/` (inside the git dir, outside the worktree) | the corpus YAML under the semantic root | the corpus YAML under the semantic root |
| Audit | not an auditable mutation; no recorder needed | **required** — [D5](#d5-invariant) applies | **optional** — takes an optional `Tier2Opts`; without one the write has no substrate-level audit (the host's concern) |
| Disableable | yes (`disable_admin` can disable the whole layer) | **no** | n/a (records only when a recorder is passed) |
| Functions | `submit` / `load` / `listing` / `discard` | `updateTableMeta` / `updateEventMeta` / `syncWriteDefinitions` | `writeTable` / `writeEventYaml` |

**The raw-edit surface is the write primitive, not a gap.** `writeTable` and
`writeEventYaml` are the low-level functions the Tier-2 paths themselves compose
(`syncWriteDefinitions` writes through `writeTable`), so they cannot be deleted. Per
[#13](https://github.com/McKenzieIT/semantic-grounding/issues/13) they accept an
**optional** `Tier2Opts`: passed, the write takes the same atomic write-and-record path
as Tier-2 (commit trailer `Derivation: deterministic`); omitted, behaviour is unchanged
— an unaudited write whose audit is the host's responsibility. dsh relies on the
omitted form: its recorder is deliberately fail-silent, and `tool-revert-edit` writes
raw on purpose (a revert must not re-enrich; dsh's own audit store snapshots the
pre-revert state). Hosts running the [git recorder](#git-recorder) pass a recorder on
**every** write path they expose — under a git backbone an unaudited write is a dirty
worktree, which the startup checks refuse or restore. The historical "gap" framing (a
public, never-audited door) was retired by #13; publicness stays (live consumer +
ADR-0002's extension-point basis). Landed in
[#18](https://github.com/McKenzieIT/semantic-grounding/issues/18).

Under the MCP management surface the write paths appear as **intent tools** (ADR-0005):
definition-level `create_definition` / `update_definition`, entry-level `add_alias` /
`remove_alias` / `add_relation` / `remove_relation`, and the Tier-1 suggestion quartet
(`submit` / `list` / `get` / `discard_suggestion`) — thin wrappers that compile onto the
functions in this table and do their read-modify-write inside the corpus lock. The
raw-edit row never appears as a tool: `create_definition` routes through the primitives
with a recorder passed on every call (ADR-0004 ruling 2's constraint). Implemented in
[#20](https://github.com/McKenzieIT/semantic-grounding/issues/20) (`packages/mcp/src/tools/`),
alongside the six read-only intent tools (`search_definitions` / `get_definition` /
`get_join_path` / `get_relations` / `resolve_alias`, plus #105's inventory index
`list_definitions`) ADR-0005 also rules on. Tool-layer
errors are discriminated through a payload inside the `isError` result, not the
JSON-RPC `error.code` field — `toToolErrorResult`, `packages/mcp/src/errors.ts` —
because `registerTool`'s handler wrapper reduces any *thrown* error to its bare
`.message` (measured against SDK v2.3.1).

The stance behind the split is recorded in `src/pending.ts`: *"polluting
source-of-truth >> polluting instructions"*. A wrong definition in the corpus is
worse than a wrong instruction, because the corpus is consumed as fact, repeatedly
and silently — a bad join or alias yields a plausible SQL rather than an error.

**Tier-1 is not an independent write path.** It has no `approve` implementation: the
queue is consumed by calling a Tier-2 write and then discarding the suggestion
(`updateEventMeta` + `discard` for events, `updateTableMeta` + `discard` for tables).
Earlier revisions of this entry named `writeEventYaml` here; that was wrong — it is the
unaudited [raw-edit surface](#write-tier), so the approve path as documented bypassed
D5. A host that only exposes Tier-1 can accumulate
suggestions but can never update the semantic layer. Any host that must close the
loop needs Tier-2, and therefore needs a Tier-2 recorder.

### pending queue

The Tier-1 store of agent-authored suggestions (`src/pending.ts`): one JSON file per
suggestion under a directory `submit`/`listing`/`load`/`discard` take as an explicit
`root` parameter — originally `var/` in reverse-bi's `rbi-mcp` package, i.e. this
mechanism was designed for exactly the agent-over-MCP shape; `root` is a deployment
choice, not something `pending.ts` itself fixes.

Under the [git recorder](#git-recorder)'s host (`packages/mcp`, the Tier-1 suggestion
tools of [#20](https://github.com/McKenzieIT/semantic-grounding/issues/20)), `root` is
**`<gitDir>/sg-pending/`, not inside the corpus worktree** — the same placement, and the
same reason, as the [git recorder](#git-recorder)'s own write lock
(`<gitDir>/sg-write.lock`, `git/lock.ts`): a suggestion file living in the worktree
would be corpus *content*, so `git status --porcelain` would report it as an untracked,
uncommitted change, and the *next* Tier-2 write would refuse — mistaking an agent's own
suggestion for an operator's uncommitted edit (ADR-0004 ruling 6). The git dir is
outside the tree git tracks, which sidesteps this with no new corpus-level
`.gitignore` entry to ask an operator to add.

`submit` / `load` / `listing` / `discard` exist; **`approve` does not** — approving
means performing the corresponding [Tier-2](#write-tier) write and discarding the
queue entry. "Admin" in the approve gate is a *role*, not necessarily a human: it can
be a higher-privilege agent or an automated rule.

### Tier-2 recorder

The interface (see ADR-0001, `docs/adr/0001-d5-tier2-audit-invariant.md`) through
which the substrate records auditable mutations. The recorder is setter-injected
(`setTier2Recorder`) and is **per core instance**, so one host process serving several
corpora cannot have one tenant's recorder answer for another's writes.

The contract per
[#13](https://github.com/McKenzieIT/semantic-grounding/issues/13): `recordTier2Write`
is async — it returns `Promise<string>` — and **raising is the statement that the write
did not happen**: the substrate restores the pre-write raw bytes and propagates the
error. An optional `beginBatch()` slot lets a recorder coalesce many records into one
commit (for `enrichAll*` batch runs; the git recorder implements it, landing with map
#12's enrichment ticket).

Recorders divide by failure semantics, and the division is a host choice the substrate
cannot force: a **fail-loud** recorder (the [git recorder](#git-recorder), where commit
failure throws by construction) makes D5 real end-to-end; a **fail-silent** recorder
(dsh's `ctx.audit`, deliberately — a 留痕 failure must not break the business write)
never raises, so D5's second half never triggers and the host owns that trade.

There is deliberately no audit-off switch. A host that wants audit-off behaviour must
pass an explicit no-op recorder satisfying the interface, which makes the downgrade a
visible choice in code rather than a wiring accident.

### git recorder

The Tier-2 recorder implementation that uses the corpus repository's own git history as
the audit backbone — lives in `packages/mcp` (host wiring; core takes recorders by
setter and ships none), designed in
[#13](https://github.com/McKenzieIT/semantic-grounding/issues/13) / ADR-0004. One
auditable write = one commit: `git add` + `git commit` is a single atomic
write-and-record, which is what makes an unaudited write stop being expressible — a
raised commit rolls the worktree back and throws; there is no third state. The commit
**is** the audit record: author is the driving agent (declared at server startup,
`<id>@agents.<corpus>` namespace), committer is the server (separating agent-written
from human-written history at a glance), and the message is a one-line summary plus
`X-SG-*` trailers — derivation (`deterministic` / `llm` / `agent`), confidence, scope,
session — readable back via `git log -p --follow`. Cross-process serialization is one
exclusive lock over the whole corpus repo whose critical section spans read-merge-write
through commit; a stale baseline is caught by content fingerprint (sha256 of the bytes
the agent actually read) checked inside the lock. Deployment posture: the corpus root
must be its own git repository root, and a dirty worktree at startup is refused unless
a dead-owner lock identifies crashed-write residue, which is restored to HEAD.

Implemented in [#19](https://github.com/McKenzieIT/semantic-grounding/issues/19)
(`packages/mcp/src/git/`), where three details of using it became load-bearing. The
seam is **`runAudited(ctx, fn)`**, not the bare `recordTier2Write`: the lock has to wrap
the substrate call (so `expected_version` is checked inside it), and the intent — tool,
target, summary, derivation, confidence — is known only to the calling tool, so a write
arriving without one is refused rather than given an invented summary. An **idempotent
write produces no commit** (`changed: false`): re-writing identical bytes stages nothing,
and an empty commit would claim a change that did not happen. And a single agent write
can produce **two** commits, because the substrate's on-write enrichment hook writes
derived content after the audit commit; that residue is committed separately as
`enrich_on_write` with `X-SG-Derivation: deterministic`, never folded into the agent's
commit (ADR-0004's 2026-10-09 update; `beginBatch` makes it structural in #21).

### D5 invariant

The substrate's non-disableable audit guarantee: an auditable mutation either records
via the [Tier-2 recorder](#tier-2-recorder) or throws. Silent drop is not a valid
outcome. Named after the upstream `deepseek-harness-da` policy designation. Codified
as this repo's first core invariant in ADR-0001.

ADR-0001 states it in two halves — throw when **no** recorder is wired, **and** throw
when a **wired** recorder raises. The first half is enforced and regression-tested
(`tests/d5-invariant.spec.ts`). The second half is decided in
[#13](https://github.com/McKenzieIT/semantic-grounding/issues/13), closing
[#6](https://github.com/McKenzieIT/semantic-grounding/issues/6): the recorder contract
became async and the Tier-2 paths snapshot the pre-write **raw bytes**, restore them
when a recorder raises, and re-throw. After a failed write there is no third state
(an unaudited file on disk while the return value reports `written: 0`); disk is back
at the pre-write state. With the [git recorder](#git-recorder) this holds end-to-end:
commit failure throws by construction. A deliberately fail-silent recorder (dsh's
`ctx.audit`) remains a visible host choice — the substrate cannot force a recorder to
be honest, only make honesty the contract.

### dimension filter

The `tables`/`events` parameter pair `get_enrichment_work` and `run_enrichment` accept
(enforced identically by the four Core methods beneath them —
`discoverRelations` / `discoverEventRelations` / `discoverAltLabels` /
`listEnrichmentWork`). Naming either array constrains the **whole call** to that
dimension; the other, left unnamed, is **out of the call** — not swept at all. Naming
neither (`{}`) is the one full-corpus shape, carrying forward
[enrichment](#enrichment)'s "run a full sweep first" guidance (ADR-0006). An empty
array is rejected at the door (zod `min(1)`): the only way to say "this dimension is
not in this call" is to omit the key — an empty array previously fell through to a
`length > 0` check one layer down and meant the opposite (full sweep), which is
exactly the silent-full-sweep ambiguity that
[#25](https://github.com/McKenzieIT/semantic-grounding/issues/25) surfaced. Naming an
unknown table/event name is also rejected at the door, before any scan — the error
lists every unknown name across both dimensions, never the corpus's full name list
(ADR-0007).

Distinct from [scope](#scope): scope selects which definitions and relations an
entire core instance can see, wired once at the runtime level; a dimension filter
narrows a *single call*'s sweep within whatever scope is already wired, and carries
no state between calls. The two names were chosen apart deliberately so a filter is
never mistaken for a second, call-level scope mechanism.

### enrichment work

A unit of enrichment the substrate could not complete on its own: a definition with
a gap that survived the deterministic round (missing `alt_labels` / `dimension_refs`),
offered for completion as a self-contained unit. The LLM half of enrichment made
exchangeable: under the [MCP management surface](#write-tier) the connecting agent
lists outstanding work, fetches completions with its own model, and returns them for
an audited merge (ADR-0006); an in-process host supplies the same completions through
the injected callback instead.

The listing and the question text are two different sizes of the same fact, and
ADR-0008 splits them into two tools rather than one. `get_enrichment_work` (scopable
by a [dimension filter](#dimension-filter)) returns an **index** row per item —
`work_id`, `target`, `gap`, nothing else — cheap enough (~70 tokens) to list a whole
corpus's outstanding work in one call (capped at 1000 rows, with `total`/`truncated`
reported honestly rather than silently dropping the tail).
`get_enrichment_prompts(work_ids)` takes a small batch (≤10) of index rows an agent
has triaged and rebuilds the actual prompt text for each against the **current**
corpus. `work_id` embeds only a content fingerprint, never the prompt itself, so this
fetch — like apply — can report a target as `stale_baseline` if it changed since
listing. The fingerprint is what makes "the target changed since this work was
issued" detectable at both fetch and apply time — a stale item is reported, never
blindly answered against or merged into.

### enrichment health

The structured record of what the on-write [enrichment](#enrichment) hook failed to
derive, read back via `getEnrichmentHealth()`. Non-empty means the just-written
definitions are missing derived facts — `dimension_refs` from the relation round,
`alt_labels` from the alt-labels round — that retrieval and prompt-context projection
depend on.

The hook is best-effort by design and never fails the originating write, so this is
how a caller learns its write landed with incomplete grounding. It exists because
"the round that would have filled this field failed" is part of the answer to
[provenance](#provenance)'s question, and before slice 2 that answer had no exit other
than a host log line. Mirrors the older `getDanglingDomainRefs()` health surface:
reset per run, returned as a snapshot.

Distinct from the surface an agent works from: health is the per-run snapshot inlined
in write responses; the corpus-computed list of outstanding gaps is
[enrichment work](#enrichment-work).

## Project-level terms

### dsh

Abbreviation for `deepseek-harness-da`, the upstream Cordis-based agent harness from
which this substrate was extracted. dsh is the substrate's first host and its
reference integration. The upstream repo is read-only from this repo's perspective.

### map

A wayfinder charting effort scoped to a single destination. The map is an issue
(labelled `wayfinder:map`) whose body holds Destination / Notes / Decisions-so-far /
Not-yet-specified / Out-of-scope, and whose sub-issues are the tickets that resolve
the map. See `docs/agents/issue-tracker.md` § Wayfinding operations.

### negation test

The substrate's proof of host neutrality: **no file in core names a host concept** —
no host-framework import, no Context augmentation, no `extends Service`, no reach into
a host `ctx`. Enforced by `scripts/check-core-purity.mjs`, wired to `pretest`, with an
explicit allow-list of [shell](#shell) files each carrying its reason for exemption.

The test is *negative* — it proves neutrality by showing core does not depend on a
host, not by building a second adapter.

**It used to be formulated as "core's test suite passes with no `cordis` on
`node_modules`", and that formulation was retired in slice 2** because it gates a
*packaging* fact rather than a *design* fact, and is therefore satisfiable without the
property it claims to prove: slice 1 passed it by vendoring the host framework's source
into the repo while core still imported `@deepseek-ai/cordis` on line 40. The current
formulation cannot be satisfied that way.

Do not re-express this as a `node_modules` check. It has been empty of host frameworks
since slice 4a (`peerDependencies` went empty then, and the last host-framework
devDependencies — the vendored dsh stub's `@deepseek-ai/*` — went with map #88), which
is exactly the point: packaging facts drift, and a `node_modules` check would silently
flip from meaningful to vacuous, while the source-level formulation above does not.

### tarball acceptance

The packaging-level counterpart to the [negation test](#negation-test), enforced by
`scripts/check-tarball-acceptance.mjs` (`npm run acceptance`). The negation test reads
`src/`, which is **not shipped** (`files` is `lib/**`), so it says nothing about the
artifact a host installs. This one packs the tarball, installs it into a scratch
project with **no peers present**, and asserts over the resulting module graph that
the substrate loads, reads, enforces [D5](#d5), and disposes with no host available.

The two are complementary and neither subsumes the other: the negation test is a claim
about *source* (core names no host concept), this is a claim about *delivery* (what we
ship needs no host to run).

It asserts over **parsed import specifiers**, not file text. The proof slices 2 and 3
recorded — `grep -c cordis lib/index.js` = 0 — is weak in the same shape as slice 1's
vendoring. At the time, `lib/index.js` was a 4 KB re-export barrel and the substrate
lived in a rolldown chunk beside it, so a real `import` of a host framework *in the
chunk* would have left that grep at 0 — the gate would have stayed green through
exactly the regression it was meant to catch. (That chunk also matched `cordis` 4 times
in surviving JSDoc, which is why a substring grep is simultaneously too loose and too
tight.) Slice 4a's removal of the second build entry collapsed the build to a single
file, so the specific hiding place is gone — but the lesson is not, and the gate stays
specifier-based. **Do not reintroduce a text-grep formulation.**

Since slice 4a the assertion is one-sided and strictly stronger: **no shipped file
names a host framework, and `peerDependencies` is empty.** It previously had to be
two-sided — the root entry must load peerless *and* `./llm-wiring-plugin` must fail —
because that subpath was a cordis plugin and was *supposed* to name a host. Moving it
into the [adapter](#adapter) retired the exemption, so there is no longer a "but this
file is allowed to" clause. The gate also pins the retirement itself: the subpath must
be absent from `exports`, absent from the tarball, and resolve to
`ERR_PACKAGE_PATH_NOT_EXPORTED`.

### end-to-end gate

The behavioural counterpart to the [negation test](#negation-test) and [tarball
acceptance](#tarball-acceptance): a scripted MCP client walks map #12's Destination
loop — read grounding for a 问数 scenario, write back through the Tier-2 audited path,
land the writes as corpus git commits, answer provenance from `git log -p --follow` —
over the **real startup seams** (`parseServerConfig` → `startup()` → the same factory
`serveStdio` calls), not the hand-built deps the unit suite uses (which is the point:
248 tests prove the parts; this proves the assembled loop in its deployment shape,
`autoEnrich` on and all). Enforced by `packages/mcp/scripts/check-e2e-loop.ts` —
`pnpm e2e` at the package and the workspace root — wired as the third named gate.

It asserts ADR-0005/0006's §Verification claims as one continuous story: the
[two-commit shape](#git-recorder) (`enrich_on_write` residue), `stale_baseline`
re-read-retry, idempotent no-commit paths, the [preserve-filter](#write-tier), work_id
self-containment across a restart, the 2026-07-28 envelope markers over the real
executable (`resultType` / `_meta.serverInfo`; `ttlMs` / `cacheScope` are SHOULD-level
in the revision and only probed), and the LLM round with the client playing oracle —
no real LLM needed (ADR-0006 ruling 7's gate dividend). The half it cannot cover is the
real agent: which era the host opens in, tool-surface friction, write-delete loops.
That is the dogfood's job, recorded in `docs/mcp-dogfood.md`.

---

*If a term you want to use is not here, add it. If a term here conflicts with an
established term in your head, stop and report the drift rather than silently
substituting.*

### playbook (初始化手册)

A stateless tool (`get_initialization_playbook`) that computes initialization progress
from the corpus's current state in real time — returning the current phase, coverage
metrics, and recommended actions. The playbook is the **information layer**: it reports
where things stand but does not orchestrate. The agent freely decides when to call and
what to execute. Playbook complements [cold start](#cold-start) — cold start is the
content registration strategy (trajectory-driven), playbook is the progress visibility.

The phase model has five hardcoded phases (scope registration → seeding → backfill →
LLM supplement → mature), with status and coverage derived per-layer (DW and KG tracked
independently). "Mature" is the completion signal but not a terminal state: the semantic
layer continues to evolve, only the guidance injection stops.

Tool-level shape (landed [#63](https://github.com/McKenzieIT/semantic-grounding/issues/63),
ADR-0014): the tool takes a required `scope_id` (no whole-registry default view) and
returns `{ scope, overall_phase, summary, layers: { dw, kg } }` — `overall_phase` is the
more-behind layer's phase (the exact judgment `_guidance.phase` reports; one shared
derivation), each layer carries its phase, its own coverage indicator, and a
`recommended_action: { tool, hint }`; `summary` carries the corpus-level counts plus a
one-sentence judgement of where the scope stands. An unregistered (or unreachable)
scope id answers with the scope_registration phase rather than an error.

### batch import (批量导入)

The bulk-seeding write tool `import_definitions` (landed
[#68](https://github.com/McKenzieIT/semantic-grounding/issues/68), ADR-0013): up to 500
table/event/concept definitions in one call, batch-level provenance (one `summary` names
the source; `derivation` is agent-only), per-item verdicts (`created` / `updated` /
`skipped` / `error` — a bad item never aborts the batch), and a single commit (or zero,
when every item is idempotent). The validation boundary stops at "each definition is
schema-valid and the batch has no duplicate names" — cross-corpus reference gaps are
[enrichment](#enrichment) territory. This is the seeding-stage companion to
[cold start](#cold-start): cold start is the strategy, batch import is the mechanism
that makes 100-table registrations one judgement instead of 100 round trips.

### dry-run preview (预检)

A read-only rehearsal of a [batch import](#batch-import): calling `import_definitions`
with `dry_run: true` runs the Phase-1 adjudication — the per-item
`created` / `updated` / `skipped` / `error` verdicts plus the batch summary — and returns
them **without opening the audit window or writing a commit** (decided in ADR-0018;
implementation tracked in [#104](https://github.com/McKenzieIT/semantic-grounding/issues/104)).
The preview runs the *same* adjudication the real write performs, so what it reports is a
faithful rehearsal of what the write would do; it is how a definition set is inspected
*before* it becomes source-of-truth. Because no online second party exists at tool-call
time (author=agent / committer=server, humans audit post-hoc via `git log` — ADR-0004),
the preview is the agent's own pre-commit review channel. Advisory, not enforced — the
[mass-update guard](#mass-update-guard) is what gives large overwrites teeth.

### mass-update guard (批量覆盖守卫)

A deterministic, server-side signal that makes a large *overwrite* of existing
source-of-truth definitions deliberate and auditable (decided in ADR-0018; implementation
tracked in [#104](https://github.com/McKenzieIT/semantic-grounding/issues/104)). It keys
on the [batch import](#batch-import) `updated` verdict count — not the total and not
`created` — because the danger is how many existing definitions a batch overwrites, not
how many it adds: a [cold start](#cold-start) into an empty corpus is almost all `created`
and must not trip it, while a drifted re-import is almost all `updated`. When `updated`
exceeds a configured threshold the guard is a **soft signal**: it warns in the response
and annotates the batch commit's [provenance](#provenance) trailer so a post-hoc
`git log` reader lands on exactly the risky commits — it does **not** reject the write
(the 500-item cap already bounds runaway size, and a hard refusal is trivially evaded by
splitting the batch). The corpus-relative *ratio* form of this guard (what fraction of
the whole corpus a change touches) belongs to ODPS drift re-sync, not batch intake: it is
decided in ADR-0019 as the [ratio guard](#ratio-guard), a second independent soft trigger
that complements this count guard
([#94](https://github.com/McKenzieIT/semantic-grounding/issues/94)).

### passive drift discovery (被动漂移发现)

How ODPS schema drift is found under the single-host model (decided in ADR-0019;
implementation tracked in [#111](https://github.com/McKenzieIT/semantic-grounding/issues/111)).
The server never probes ODPS — it has no engine client ([#79](https://github.com/McKenzieIT/semantic-grounding/issues/79)).
Instead the connecting agent, which already holds ODPS access in its own trajectory,
re-probes the drifted schema into its [scratch home](#scratch-home)
(`<gitDir>/sg-scratch/`), regenerates the affected table/event
[definitions](#definition), and feeds them back through [batch import](#batch-import).
Drift is quantified *reactively* — by the Phase-1 `updated` verdicts (what the re-import
overwrote) plus the [ratio guard](#ratio-guard) — not by any server-side baseline diff.
The rejected alternative, a server-mounted schema provider that diffs ODPS itself, would
need an ODPS execution face the single-host server deliberately lacks (a server-asserted
table definition would be fabricated [provenance](#provenance); the live-engine `sync`
path stays deferred, ADR-0005 ruling 5).

### re-sync projection contract (可重导投影契约)

The round-trip guarantee that a definition read back by `get_definition` feeds straight
into `import_definitions` (decided in ADR-0019; implementation tracked in
[#111](https://github.com/McKenzieIT/semantic-grounding/issues/111)). The relation /
[suppression](#suppression) layer — the item-verb fields that only
[`add_relation`](#relation) / `add_alias` write, never create/import (ADR-0005 ruling 4) —
survives a re-import *per kind*, split on whether [enrichment](#enrichment) can
deterministically re-derive it. A [concept](#kind) has **no** enrichment round (zero-hit
across the enrichment sources, [#46](https://github.com/McKenzieIT/semantic-grounding/issues/46)),
so import **strips** those keys from the create payload rather than rejecting them (a
`get_definition` output is therefore re-importable) and **preserves** the on-disk ones on
an `updated` overwrite rather than dropping them (re-sync never silently loses edges). A
table / event carries its refs as ordinary `.loose()` payload fields that round-trip
losslessly via client-side merge, backstopped by enrichment's deterministic relation round
([enrichment work](#enrichment-work)) — so no server-side preserve. Genuinely-unknown keys
are still rejected as typos.

### ratio guard (占比守卫)

The corpus-relative companion to the [mass-update guard](#mass-update-guard) (decided in
ADR-0019; implementation tracked in
[#111](https://github.com/McKenzieIT/semantic-grounding/issues/111)). Where the count
guard trips on the absolute `updated` verdict count ("beyond the eyeball budget"), the
ratio guard trips on the per-kind fraction `updated(kind) / existing(kind)` ("what share of
the corpus a change touches — the blast radius"). The two fire **independently**, and both
are **soft** signals — a WARN plus a commit-[provenance](#provenance)-trailer annotation,
never a hard reject, because a whole re-sync is one `git revert`-able commit. A small-corpus
floor (default ~10) below which only the count guard applies keeps the ratio out of its
meaningless-on-a-tiny-corpus regime; threshold and floor live in `ServerConfig`, not the
substrate ([#79](https://github.com/McKenzieIT/semantic-grounding/issues/79)).

### scratch home (草稿家)

The server-managed landing place for an agent's exploration drafts — the SQL dumps,
re-probed schemas and drafted YAML of the explore-then-write-back loop (decided in
ADR-0020; landed with the `acquire_scratch_dir` tool in
[#101](https://github.com/McKenzieIT/semantic-grounding/issues/101)). It lives at
`<gitDir>/sg-scratch/<run-id>/`, the same family as the [pending queue](#pending-queue)'s
`sg-pending/` and the corpus lock: inside the git dir, **outside the worktree git
tracks**, so exploration junk is invisible to both clean-worktree gates by construction
— dropping drafts anywhere in the corpus worktree is what makes the next
[Tier-2](#write-tier) write refuse with a posture error, mistaking the agent's own
scratch for an operator's uncommitted edit. One `acquire_scratch_dir` call = one fresh
run directory (the unit an exploration is collected in; concurrent explorers stay
isolated), and cleanup is the **server's** job, not the agent's: every acquire prunes
the home to the newest N runs (default 3, `ServerConfig.scratchRunsToKeep`), retiring
the least-recently-touched — an in-flight run keeps bumping its own mtime — while never
touching anything it does not recognize as a run directory, and never recycling the run
its own call just handed out. Not an audited mutation: no commit, no corpus lock,
nothing durable — anything worth keeping must be written back into the corpus before
its run is retired.

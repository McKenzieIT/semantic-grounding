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

It is **not** a metric engine (metric execution has been intentionally removed upstream).
It is **not** a data discovery portal.

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
production deployments assemble their own.

### enrichment

A deterministic, provenance-carrying transformation applied to a definition, driven
by the definition's kind and its position in the relation graph. Enrichment is how
the substrate propagates derived facts (e.g. a column inheriting a business glossary
tag from its parent table). Enrichment is deterministic: same inputs → same outputs,
always.

### provenance

The record of where a definition's field value came from — authored in YAML, derived
by enrichment, or recorded from an LLM call. Provenance is what makes the substrate
auditable: for any field on any definition, you can answer "why is this value what
it is?".

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

Today the only shell file in `src/` is `llm-wiring-plugin.ts`, and it is a candidate
to move into the [dsh](#dsh) adapter. The shell allow-list shrinking to empty is the
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

## Audit and tiers

### write tier

Which of the two write paths a mutation takes. The distinction is a *security*
boundary, not an implementation detail, and the two tiers have opposite defaults:

| | **Tier-1** | **Tier-2** |
|---|---|---|
| What an agent may do | **suggest** only | write source-of-truth directly |
| Where it lands | the [pending queue](#pending-queue) in `var/` (gitignored runtime data) | the corpus YAML under the semantic root |
| Audit | not an auditable mutation; no recorder needed | **required** — [D5](#d5-invariant) applies |
| Disableable | yes (`disable_admin` can disable the whole layer) | **no** |

The stance behind the split is recorded in `src/pending.ts`: *"polluting
source-of-truth >> polluting instructions"*. A wrong definition in the corpus is
worse than a wrong instruction, because the corpus is consumed as fact, repeatedly
and silently — a bad join or alias yields a plausible SQL rather than an error.

**Tier-1 is not an independent write path.** It has no `approve` implementation: the
queue is consumed by calling a Tier-2 write and then discarding the suggestion
(`writeEventYaml` + `discard`). So a host that only exposes Tier-1 can accumulate
suggestions but can never update the semantic layer. Any host that must close the
loop needs Tier-2, and therefore needs a Tier-2 recorder.

### pending queue

The Tier-1 store of agent-authored suggestions (`src/pending.ts`): one JSON file per
suggestion under `var/`. Ported from reverse-bi's `rbi-mcp` package, i.e. this
mechanism was designed for exactly the agent-over-MCP shape.

`submit` / `load` / `listing` / `discard` exist; **`approve` does not** — approving
means performing the corresponding [Tier-2](#write-tier) write and discarding the
queue entry. "Admin" in the approve gate is a *role*, not necessarily a human: it can
be a higher-privilege agent or an automated rule.

### Tier-2 recorder

The interface (see ADR-0001, `docs/adr/0001-d5-tier2-audit-invariant.md`) through
which the substrate records auditable mutations. The recorder is setter-injected
(`setTier2Recorder`) and is **per core instance**, so one host process serving several
corpora cannot have one tenant's recorder answer for another's writes.

There is deliberately no audit-off switch. A host that wants audit-off behaviour must
pass an explicit no-op recorder satisfying the interface, which makes the downgrade a
visible choice in code rather than a wiring accident.

### D5 invariant

The substrate's non-disableable audit guarantee: an auditable mutation either records
via the [Tier-2 recorder](#tier-2-recorder) or throws. Silent drop is not a valid
outcome. Named after the upstream `deepseek-harness-da` policy designation. Codified
as this repo's first core invariant in ADR-0001.

ADR-0001 states it in two halves — throw when **no** recorder is wired, **and** throw
when a **wired** recorder raises. The first half is enforced and regression-tested
(`tests/d5-invariant.spec.ts`). The second half does **not** hold today: the write
path writes the YAML before recording, inside one `try` whose `catch` collects the
error, so a raising recorder leaves an unaudited file on disk while the return value
reports `written: 0`. Tracked as issue #6; it is a write/audit *atomicity* decision,
and may dissolve into the MCP map's choice of git as the audit backbone (where
`git add` + `git commit` is one atomic write-and-record).

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

Do not re-express this as a `node_modules` check. The core legitimately has a host
framework on `node_modules` — as an optional peer dependency, for the shell.

---

*If a term you want to use is not here, add it. If a term here conflicts with an
established term in your head, stop and report the drift rather than silently
substituting.*

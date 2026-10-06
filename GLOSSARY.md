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

### adapter

A thin, host-specific package that wires the substrate's core into a particular host
runtime. One adapter per host. Adapters are *outside* core and do not affect core's
host-neutrality. The dsh adapter is the first; others may follow. Core has no
adapters as dependencies.

### host

The runtime environment that embeds the substrate (e.g. `deepseek-harness-da` /
dsh, a future MCP server, a standalone CLI). The substrate's host-neutrality claim
is that core runs unchanged across hosts, proven by the negation test (core's test
suite passing with no host runtime on `node_modules`).

## Audit and tiers

### Tier-2 recorder

The interface (see ADR-0001, `docs/adr/0001-d5-tier2-audit-invariant.md`) through
which the substrate records auditable mutations. The recorder is setter-injected by
the host; the substrate's core-level invariant (D5) is that any auditable mutation
without a wired recorder throws rather than silently dropping the record.

### D5 invariant

The substrate's non-disableable audit guarantee: an auditable mutation either records
via the Tier-2 recorder or throws. Silent drop is not a valid outcome. Named after
the upstream `deepseek-harness-da` policy designation. Codified as this repo's first
core invariant in ADR-0001.

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

The substrate's proof of host neutrality: core's test suite passes with no host
runtime (`cordis`) on `node_modules`. The test is *negative* — it proves neutrality
by showing core does not depend on a host, not by building a second adapter. See
map Destination.

---

*If a term you want to use is not here, add it. If a term here conflicts with an
established term in your head, stop and report the drift rather than silently
substituting.*

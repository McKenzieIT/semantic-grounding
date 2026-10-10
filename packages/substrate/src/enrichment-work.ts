/**
 * The LLM half of enrichment, from the connecting agent's side of the ask-answer loop
 * (ADR-0006) — `listEnrichmentWorkItems` (the index of outstanding gaps, ADR-0008),
 * `fetchEnrichmentPrompts` (the question a row stands for, rebuilt from the current
 * corpus), and `applyOneEnrichmentResult` / `applyEnrichmentResultsBatch` (the
 * answer), wrapping the existing `buildLlmPrompt` / `parseLlmRefs` / `mergeRefs`
 * family (and its `alt_labels` mirror) around a self-contained `work_id`.
 * `SemanticGroundingCore.listEnrichmentWork` / `.getEnrichmentPrompts` /
 * `.applyEnrichmentResults` (`src/index.ts`) are thin wrappers over this module's
 * functions — the same split as `enrichAllDwsTables` (`enrichment.ts`) and
 * `core.discoverRelations`.
 *
 * ## Why a work_id has to be self-contained
 *
 * ADR-0006 ruling 1 chose an agent-driven tool loop over the two MRTR shapes
 * precisely because an MCP server has no session to hold a "pending question" in
 * between `get_enrichment_work` and `apply_enrichment` — the protocol is stateless per
 * request and a client may legitimately restart the server between the two calls
 * (ruling 4: "server 无会话状态，重启隔在 get/apply 之间不孤儿化"). So a `work_id` is not
 * a lookup key into server memory; it is a signed-free, opaque encoding of everything
 * {@link applyOneEnrichmentResult} needs to re-derive the question and re-verify its
 * premise: which definition (`kind` + target name), which round (`relation` /
 * `alt_labels`), and the content fingerprint the definition carried at issuance time —
 * exactly the role `expected_version` plays for the intent tools (ADR-0004 ruling 8),
 * just carried inside the token instead of as a sibling parameter (ADR-0006 ruling 5
 * explicitly rejected a parallel `expected_version` param as "同一基线两个入口").
 *
 * No cryptographic signing: a work_id is not a capability grant. An agent that could
 * fabricate one still only gets to assert "apply this text as round R for target T at
 * baseline H" — the fingerprint check still has to pass, and the write still goes
 * through the same validate-before-dump path every other write does. Forging a baseline
 * that happens to match current disk content is not meaningfully different from the
 * agent calling an intent tool directly with its own `derivation: 'agent'` claim, which
 * ADR-0005's free channel already allows.
 *
 * ## What "gap" means (GLOSSARY § enrichment work)
 *
 * {@link listEnrichmentWorkItems} reads the corpus **as it stands on disk** — a table's
 * `dimension_refs` is empty, or a definition's `alt_labels` is empty — rather than
 * running the deterministic round itself to predict whether it would find something.
 * That is deliberate (ADR-0006 ruling 6): deterministic derivability changes as the
 * corpus grows (onboarding `dim_shop` today can make yesterday's `dws_order`'s join
 * newly name-pairable), and the only honest way to keep this list from offering
 * deterministically-answerable gaps to an LLM is a real trigger surface
 * (`run_enrichment`) that actually *persists* what the deterministic round finds — not
 * a second, parallel "would it find something" prediction here that could silently
 * drift from what `run_enrichment` actually does. A caller that skips `run_enrichment`
 * sees those gaps here too; ADR-0006's own Consequences section accepts that as the
 * honest cost of a trigger that is a tool-description convention, not a protocol
 * requirement.
 *
 * ## Why apply is lenient per item (ADR-0006 ruling 4)
 *
 * `applyOneEnrichmentResult` never throws for a bad or stale input — it returns one of
 * four verdicts. `stale_baseline` covers every reason the premise no longer holds
 * (fingerprint mismatch, the target renamed or deleted, or the `work_id` failing to
 * decode at all — indistinguishable from "stale" without a session to blame, so all
 * three get the same "re-fetch work and retry" remedy). `unparseable` means the text
 * parsed to zero usable items (`parseLlmRefs` / `parseAltLabelsResponse` are already
 * lenient per-item; this is the all-of-them-dropped case). `idempotent` means something
 * parsed but every item was already present. Only `applied` writes. One bad item in a
 * batch never aborts the others — see `applyEnrichmentResultsBatch`.
 *
 * @module enrichment-work (internal; only `"."` is importable — see ADR-0002)
 */
import { createHash } from 'node:crypto'
import {
  TableDefinitionSchema,
  EventDefinitionSchema,
  type DimensionRef,
} from './types.ts'
import { loadTables, loadEvents, writeTable, writeEventYaml, dumpYaml, loadSuppressions } from './io.ts'
import type { Tier2Recorder } from './io.ts'
import {
  buildDimInventory,
  buildLlmPrompt,
  buildEventLlmPrompt,
  buildAltLabelsPrompt,
  parseLlmRefs,
  parseAltLabelsResponse,
  mergeRefs,
  mergeAltLabels,
  aliasVetoSet,
  relationVetoSet,
  tableToAltLabelsTarget,
  eventToAltLabelsTarget,
  assertKnownFilterNames,
  type DimInventoryEntry,
} from './enrichment.ts'

// ── work_id: self-contained identity ────────────────────────────────────

/** Which enrichment round a work item or applied result belongs to. Structurally
 * identical to `index.ts`'s `EnrichmentRound` (deliberately not imported from there —
 * `index.ts` imports *this* module, and a back-import would cycle the barrel). */
export type WorkRound = 'relation' | 'alt_labels'
/** Which storage kind a work item's target is. */
export type WorkKind = 'table' | 'event'

/** Bumped only if the work_id payload's shape changes; a mismatch decodes to `undefined`
 * (surfaced as `stale_baseline` — "re-fetch work and retry" is correct advice either way). */
const WORK_ID_SCHEMA_VERSION = 1
/** Human-legible prefix: "enrichment work, schema 1". Lets a reader (or a log line)
 * recognise a work_id at a glance without decoding it. */
const WORK_ID_PREFIX = 'ew1.'

interface WorkIdPayload {
  readonly v: typeof WORK_ID_SCHEMA_VERSION
  readonly k: WorkKind
  readonly r: WorkRound
  readonly t: string
  readonly h: string
}

/**
 * The three fields a round of this file's own merges can write. Excluded from the
 * staleness fingerprint (see {@link fingerprint}) on *both* sides of every comparison —
 * never just the current round's own field — so a `relation` work item's apply does not
 * retroactively stale an `alt_labels` work item issued from the same `listEnrichmentWork`
 * call for the *same* target (and vice versa). Both are common: a freshly-onboarded
 * table typically has every array empty at once, so both gaps are issued together.
 */
const ENRICHMENT_MANAGED_FIELDS = ['dimension_refs', 'external_refs', 'alt_labels'] as const

/**
 * sha256 hex fingerprint of a raw definition dict, over its canonical YAML dump with
 * every {@link ENRICHMENT_MANAGED_FIELDS} key stripped first.
 *
 * Excluding them is deliberate, not an oversight: the staleness check exists to catch
 * "the prompt's premise might have shifted" (columns, description, params_fields
 * changed), not to protect the specific array this round itself writes — the merge
 * functions (`mergeRefs` / `mergeAltLabels`) already read that array **fresh** at apply
 * time and only ever add to it, so they are safe to run against whatever the field
 * currently holds regardless of what it held at issuance. Without the exclusion, two
 * work items for the *same* target issued in the same `listEnrichmentWork` call (a
 * `relation` gap and an `alt_labels` gap are both commonly open on a freshly-onboarded
 * table) would make the second one `stale_baseline` purely because the first one's own
 * write — to an *unrelated* field — changed the file's dump. `writeTable`'s
 * `atomicWrite` re-dumps any non-string payload through `dumpYaml` on every write
 * (`enrichAllDwsTables` et al. already rely on this), so comparing dumps rather than
 * literal on-disk bytes is what makes the fingerprint track "the definition changed",
 * not "a human's incidental formatting changed".
 * @param raw - the definition's raw (unvalidated) dict, as `loadTables` / `loadEvents` return it.
 * @returns the sha256 hex digest of `dumpYaml(raw)` with the managed fields stripped.
 */
function fingerprint(raw: Record<string, unknown>): string {
  const stripped = { ...raw }
  for (const key of ENRICHMENT_MANAGED_FIELDS) delete stripped[key]
  return createHash('sha256').update(dumpYaml(stripped), 'utf-8').digest('hex')
}

/**
 * Encode a work item's identity into an opaque, self-contained token.
 * @param payload - kind, round, target name, and the baseline fingerprint at issuance time.
 * @returns the work_id string.
 */
function encodeWorkId(payload: Omit<WorkIdPayload, 'v'>): string {
  const full: WorkIdPayload = { v: WORK_ID_SCHEMA_VERSION, ...payload }
  return `${WORK_ID_PREFIX}${Buffer.from(JSON.stringify(full), 'utf-8').toString('base64url')}`
}

/**
 * Decode a work_id back into its payload.
 *
 * Returns `undefined` rather than throwing for anything that is not a value this
 * module issued at the current schema version: wrong prefix, invalid base64url or JSON,
 * an unknown schema version, or a structurally incomplete payload. See this module's
 * header for why every one of those causes maps onto the same `stale_baseline` verdict
 * at the call site rather than being distinguished.
 * @param workId - the token to decode.
 * @returns the decoded payload, or undefined.
 */
function decodeWorkId(workId: string): WorkIdPayload | undefined {
  if (!workId.startsWith(WORK_ID_PREFIX)) return undefined
  let parsed: unknown
  try {
    const text = Buffer.from(workId.slice(WORK_ID_PREFIX.length), 'base64url').toString('utf-8')
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const p = parsed as Record<string, unknown>
  if (p.v !== WORK_ID_SCHEMA_VERSION) return undefined
  if (p.k !== 'table' && p.k !== 'event') return undefined
  if (p.r !== 'relation' && p.r !== 'alt_labels') return undefined
  if (typeof p.t !== 'string' || p.t === '') return undefined
  if (typeof p.h !== 'string' || p.h === '') return undefined
  return { v: WORK_ID_SCHEMA_VERSION, k: p.k, r: p.r, t: p.t, h: p.h }
}

/**
 * Resolve a work_id's target name, with no other side effect.
 *
 * The `apply_enrichment` MCP tool's only legitimate reason to decode a work_id ahead
 * of {@link applyOneEnrichmentResult}: the commit subject (ADR-0005 ruling 1 — a
 * definition name, never a field echo; ADR-0006 ruling 5's "单项填定义名") needs the
 * target name *before* the audited write runs, and `work_id` is otherwise opaque at
 * that point. Does not verify the baseline fingerprint — a stale or fabricated
 * work_id's target name is just as valid a thing to put in a commit subject as a
 * fresh one's, and that check belongs solely to {@link applyOneEnrichmentResult}'s
 * verdict, not to this cosmetic peek.
 * @param workId - the token to peek at.
 * @returns the target name, or undefined when the token does not decode.
 */
export function peekWorkIdTarget(workId: string): string | undefined {
  return decodeWorkId(workId)?.t
}

// ── get_enrichment_work: list outstanding gaps ──────────────────────────

/**
 * The listing's hard row cap (ADR-0008): a code constant, not configuration — tuning
 * it is an ADR revision, not a config change. The fold it encodes: one index response
 * must fit comfortably inside half a de-facto 200K-token window (~68 tokens per row ×
 * 1000 ≈ 68K), while the corpus the flagship dogfood runs on (k11, 321 tables + 258
 * events) already needs 579 rows — a 500-row cap would truncate that triage listing.
 */
export const ENRICHMENT_WORK_INDEX_CAP = 1000

/**
 * One index row of outstanding enrichment work (ADR-0008's index/prompt split): the
 * identity and the question's *subject*, never the prompt itself. A row is ~68 tokens
 * (the 64-char `work_id` is most of it) against ~8.3K tokens for the prompt it stands
 * for — triage wants the whole distribution at that cheap size, answering wants a
 * narrow batch at the expensive one, and the two scales no longer share one response.
 */
export interface EnrichmentWorkItem {
  /** Self-contained identity: target + round + the fingerprint at issuance time. */
  readonly work_id: string
  /** The table_name or event name this gap is on. */
  readonly target: string
  /** What is missing, and on which field — see this module's header on "gap". */
  readonly gap: string
}

/** The index-shaped listing result (ADR-0008): capped rows plus the size metadata. */
export interface EnrichmentWorkIndex {
  /** The first {@link ENRICHMENT_WORK_INDEX_CAP} rows, in catalog order (tables then events). */
  readonly work: readonly EnrichmentWorkItem[]
  /** The full row count matching the filter, before the cap was applied. */
  readonly total: number
  /** `true` exactly when `total` exceeded the cap and rows were dropped. */
  readonly truncated: boolean
}

/**
 * List outstanding enrichment work across the layer as an index (ADR-0008): rows
 * `{work_id, target, gap}` for definitions whose relation or alt_labels array is still
 * empty on disk. The prompts those rows stand for are fetched separately, in batches,
 * via {@link fetchEnrichmentPrompts}.
 *
 * Dimension-filter semantics are call-wide (ADR-0007): naming tables constrains the
 * whole call and leaves the events dimension OUT of it (and vice versa); `{}` (or no
 * keys) is the one full-corpus shape. Unknown or empty-array filters are rejected at
 * the door via {@link assertKnownFilterNames} — before any scan.
 * @param semanticLayer - the semantic-layer directory path.
 * @param opts - the `{tables?, events?}` dimension filter (see ADR-0007).
 * @returns the capped index plus `total`/`truncated`.
 * @throws UnknownFilterNamesError when a named dimension filter is empty or names
 *   definitions absent from the corpus.
 */
export function listEnrichmentWorkItems(
  semanticLayer: string,
  opts: { readonly tables?: readonly string[]; readonly events?: readonly string[] } = {},
): EnrichmentWorkIndex {
  assertKnownFilterNames(semanticLayer, opts)
  // ADR-0007's call-wide pair reading: an omitted dimension is OUT of the call unless
  // both are omitted, in which case the call is the full corpus (`{}` = everything,
  // ADR-0006's "run the full backfill first" escape hatch).
  const bothOmitted = opts.tables === undefined && opts.events === undefined
  const tablesOn = bothOmitted || opts.tables !== undefined
  const eventsOn = bothOmitted || opts.events !== undefined
  const tableFilter = opts.tables !== undefined ? new Set(opts.tables) : undefined
  const eventFilter = opts.events !== undefined ? new Set(opts.events) : undefined
  // Built once: both the relation gap test (is there anything to even ask about?) and
  // every relation prompt need the same inventory `buildDimInventory` scans for.
  const dimInventory = buildDimInventory(semanticLayer)
  const items: EnrichmentWorkItem[] = []

  if (tablesOn) {
    for (const t of loadTables(semanticLayer)) {
      if (tableFilter !== undefined && !tableFilter.has(t.table_name)) continue
      const parsed = TableDefinitionSchema.safeParse(t.raw)
      if (!parsed.success) continue // lenient scan, mirrors enrichAllDwsTables
      const def = parsed.data
      const baseline = fingerprint(t.raw)

      // Relation gap: DIM tables have no dimension_refs field to speak of (enrichAllDwsTables
      // skips them for the same reason), and with no DIM inventory at all there is nothing
      // any round — deterministic or LLM — could find (mirrors enrichAllDwsTables's own
      // "no DIM tables in scope" short-circuit).
      if (def.kind !== 'dim' && dimInventory.length > 0 && def.dimension_refs.length === 0) {
        items.push({
          work_id: encodeWorkId({ k: 'table', r: 'relation', t: def.table_name, h: baseline }),
          target: def.table_name,
          gap: 'dimension_refs is empty: no DIM joins known for this DWS table',
        })
      }
      if (def.alt_labels.length === 0) {
        items.push({
          work_id: encodeWorkId({ k: 'table', r: 'alt_labels', t: def.table_name, h: baseline }),
          target: def.table_name,
          gap: 'alt_labels is empty: no alternate search labels known for this table',
        })
      }
    }
  }

  if (eventsOn) {
    for (const e of loadEvents(semanticLayer)) {
      if (eventFilter !== undefined && !eventFilter.has(e.name)) continue
      const parsed = EventDefinitionSchema.safeParse(e.raw)
      if (!parsed.success) continue
      const def = parsed.data
      const baseline = fingerprint(e.raw)

      if (dimInventory.length > 0 && def.external_refs.length === 0) {
        items.push({
          work_id: encodeWorkId({ k: 'event', r: 'relation', t: def.name, h: baseline }),
          target: def.name,
          gap: 'external_refs is empty: no DIM joins known for this event',
        })
      }
      if (def.alt_labels.length === 0) {
        items.push({
          work_id: encodeWorkId({ k: 'event', r: 'alt_labels', t: def.name, h: baseline }),
          target: def.name,
          gap: 'alt_labels is empty: no alternate search labels known for this event',
        })
      }
    }
  }

  return {
    work: items.length > ENRICHMENT_WORK_INDEX_CAP ? items.slice(0, ENRICHMENT_WORK_INDEX_CAP) : items,
    total: items.length,
    truncated: items.length > ENRICHMENT_WORK_INDEX_CAP,
  }
}

// ── get_enrichment_prompts: fetch the questions a row stands for ────────

/** One work_id's prompt outcome — lenient per item, mirroring the apply family below. */
export interface EnrichmentPromptItem {
  /** Echoes the input `work_id`, so the agent can match outcomes back to its own requests. */
  readonly work_id: string
  /** The target this work_id named, when decodable; `'(unknown)'` when it was not. */
  readonly target: string
  /** The round this work_id named, when decodable. */
  readonly round?: WorkRound
  /** `fresh` rebuilt the prompt; `stale_baseline` did not — same condition set, and the
   * same re-fetch-and-retry remedy, as {@link applyOneEnrichmentResult}'s verdict. */
  readonly verdict: 'fresh' | 'stale_baseline'
  /** The rebuilt prompt — present exactly when `verdict` is `fresh`. */
  readonly prompt?: string
  /** One line explaining the verdict. */
  readonly detail: string
}

/**
 * Rebuild the prompts for a batch of work_ids against the **current** corpus
 * (ADR-0008's prompt half of the index/prompt split — the listing stores only the
 * fingerprint, so the question is always re-derived, never cached).
 *
 * Staleness is reported here, at fetch time, under the same conditions apply will
 * later check (undecodable work_id, target gone, fingerprint mismatch, definition no
 * longer schema-valid): a work_id failing any of them is guaranteed to verdict
 * `stale_baseline` at apply, so answering its prompt is wasted work — reporting early
 * lets the agent skip straight to re-fetching the work. A gap that was *filled* since
 * listing (filling `dimension_refs`/`external_refs`/`alt_labels` does not move the
 * fingerprint — they are stripped from it, see {@link fingerprint}) stays `fresh` on
 * purpose: the question "what joins does this table have?" is not invalidated by
 * having some answers already, and apply's merge is additive.
 *
 * Lenient per item like the apply family: a bad work_id is one `stale_baseline`
 * outcome, never a thrown error, and never a poison pill for its batch siblings.
 * @param semanticLayer - the semantic-layer directory path.
 * @param workIds - the work_ids whose prompts to rebuild (the MCP tool caps a batch
 *   at 10; this function processes whatever it is given — the cap is wire governance,
 *   single-sourced in the tool's zod schema).
 * @returns one outcome per input work_id, in input order.
 */
export function fetchEnrichmentPrompts(
  semanticLayer: string,
  workIds: readonly string[],
): EnrichmentPromptItem[] {
  // The DIM inventory is needed only by `relation` items; built lazily so an
  // alt_labels-only batch never pays the full-tables scan.
  let inventory: DimInventoryEntry[] | undefined
  const dimInventory = (): readonly DimInventoryEntry[] => {
    inventory ??= buildDimInventory(semanticLayer)
    return inventory
  }
  return workIds.map(workId => {
    const payload = decodeWorkId(workId)
    if (payload === undefined) {
      return {
        work_id: workId,
        target: '(unknown)',
        verdict: 'stale_baseline',
        detail: 'work_id could not be decoded (malformed, a schema version this server does not know, or not issued by this server) — call get_enrichment_work again and retry with a fresh work_id',
      } as const
    }
    const { k: kind, r: round, t: target, h: baseline } = payload
    const base = { work_id: workId, target, round } as const

    if (kind === 'table') {
      const row = loadTables(semanticLayer).find(x => x.table_name === target)
      if (row === undefined) return { ...base, verdict: 'stale_baseline', detail: `table ${target} no longer exists in the corpus` }
      if (fingerprint(row.raw) !== baseline) return { ...base, verdict: 'stale_baseline', detail: staleSinceIssuanceDetail(target) }
      const parsed = TableDefinitionSchema.safeParse(row.raw)
      if (!parsed.success) return { ...base, verdict: 'stale_baseline', detail: `${target} no longer validates against the table schema` }
      const prompt = round === 'relation'
        ? buildLlmPrompt(parsed.data, dimInventory())
        : buildAltLabelsPrompt(tableToAltLabelsTarget(parsed.data))
      return { ...base, verdict: 'fresh', prompt, detail: `prompt rebuilt from the current corpus for the ${round} round` }
    }

    const row = loadEvents(semanticLayer).find(x => x.name === target)
    if (row === undefined) return { ...base, verdict: 'stale_baseline', detail: `event ${target} no longer exists in the corpus` }
    if (fingerprint(row.raw) !== baseline) return { ...base, verdict: 'stale_baseline', detail: staleSinceIssuanceDetail(target) }
    const parsed = EventDefinitionSchema.safeParse(row.raw)
    if (!parsed.success) return { ...base, verdict: 'stale_baseline', detail: `${target} no longer validates against the event schema` }
    const prompt = round === 'relation'
      ? buildEventLlmPrompt(parsed.data, dimInventory())
      : buildAltLabelsPrompt(eventToAltLabelsTarget(parsed.data))
    return { ...base, verdict: 'fresh', prompt, detail: `prompt rebuilt from the current corpus for the ${round} round` }
  })
}

// ── apply_enrichment: in-lock re-verification, lenient merge, write ─────

/** The outcome of applying one `{work_id, text}` pair (ADR-0006 ruling 4's four verdicts). */
export interface AppliedEnrichmentOutcome {
  /** Echoes the input `work_id`, so the agent can match outcomes back to its own requests. */
  readonly work_id: string
  /** The target this work_id named, when decodable; `'(unknown)'` when it was not. */
  readonly target: string
  /** The round this work_id named, when decodable. */
  readonly round?: WorkRound
  /** `applied` wrote; the other three did not — see this module's header. */
  readonly verdict: 'applied' | 'idempotent' | 'stale_baseline' | 'unparseable'
  /** One line explaining the verdict (what changed, or why nothing did). */
  readonly detail: string
}

type MergeOutcome<T> =
  | { readonly kind: 'unparseable'; readonly detail: string }
  | { readonly kind: 'idempotent'; readonly detail: string }
  | { readonly kind: 'applied'; readonly detail: string; readonly value: T }

/**
 * Canonical string form of a DimensionRef list, for the idempotence comparison —
 * `mergeRefs` can reorder `join_keys` and re-key the map, so comparing arrays directly
 * would report a no-op merge as a change.
 * @param refs - the refs to canonicalize.
 * @returns a JSON string stable under reordering of refs and of each ref's join_keys.
 */
function canonicalizeRefs(refs: readonly DimensionRef[]): string {
  const normalized = refs
    .map(r => ({
      dim_table: r.dim_table,
      join_keys: [...r.join_keys].map(k => `${k.dws_column}|${k.dim_column}`).sort(),
      derivation: r.derivation,
      origin: r.origin,
    }))
    .sort((a, b) => a.dim_table.localeCompare(b.dim_table))
  return JSON.stringify(normalized)
}

/**
 * Parse + merge an agent's completion for a `relation` work item.
 * @param text - the agent's completion text.
 * @param existing - the target's current `dimension_refs` / `external_refs`.
 * @returns `unparseable` (nothing usable in `text`), `idempotent` (parsed but no
 *   change), or `applied` (the new merged array to write).
 */
function mergeRelationText(
  text: string,
  existing: readonly DimensionRef[],
  suppressed: ReadonlySet<string>,
): MergeOutcome<DimensionRef[]> {
  const parsed = parseLlmRefs(text)
  if (parsed.length === 0) {
    return { kind: 'unparseable', detail: 'no usable DIM relation found in the supplied text' }
  }
  // Suppression filter (ADR-0010): a vetoed `dim_table` is not re-asserted by an
  // LLM answer either — a veto constrains enrichment rounds, "deterministic or LLM
  // alike". An answer whose every relation is vetoed is idempotent (nothing new
  // lands), not unparseable.
  const added = suppressed.size === 0 ? parsed : parsed.filter(r => !suppressed.has(r.dim_table))
  if (added.length === 0) {
    return { kind: 'idempotent', detail: 'every parsed relation names a dim_table suppressed on this definition — re-asserting it via add_relation (or a hand edit) lifts the veto' }
  }
  const merged = mergeRefs(existing, added)
  if (canonicalizeRefs(merged) === canonicalizeRefs(existing)) {
    return { kind: 'idempotent', detail: 'the parsed relation(s) already match the existing refs' }
  }
  return { kind: 'applied', detail: `merged ${added.length} parsed relation(s)`, value: merged }
}

/** Mirrors `enrichment.ts`'s private `normalizeLabel` (lowercased, trimmed) — not
 * exported there, and trivial enough that duplicating one line beats widening that
 * module's module-level export surface for it. */
function normalizeLabel(s: string): string {
  return s.toLowerCase().trim()
}

/**
 * Parse + merge an agent's completion for an `alt_labels` work item.
 *
 * Excludes the definition's own `id` (table_name / event name) and `pref_label` from
 * what counts as "new", mirroring `discoverAltLabelsFor`'s own exclusion set
 * (`enrichment.ts`) — an agent re-suggesting the asset's own name is not a new alias,
 * and without this exclusion it would always be `applied` on a `pref_label`-only
 * answer rather than correctly falling through to `idempotent`.
 * @param text - the agent's completion text.
 * @param existing - the target's current `alt_labels`.
 * @param id - the target's own name (table_name / event name).
 * @param prefLabel - the target's `pref_label`, if set.
 * @returns `unparseable`, `idempotent`, or `applied` (the new merged array to write).
 */
function mergeAltLabelsText(
  text: string,
  existing: readonly string[],
  id: string,
  prefLabel: string | undefined,
  suppressed: ReadonlySet<string>,
): MergeOutcome<string[]> {
  const added = parseAltLabelsResponse(text)
  if (added.length === 0) {
    return { kind: 'unparseable', detail: 'no usable alt_label found in the supplied text' }
  }
  const exclude = new Set([
    ...existing.map(normalizeLabel),
    ...(prefLabel !== undefined ? [normalizeLabel(prefLabel)] : []),
    normalizeLabel(id),
  ])
  // Suppression filter (ADR-0010): vetoed labels join the exclude set — an LLM
  // answer may not re-assert what a veto retired, same as the deterministic round.
  for (const k of suppressed) exclude.add(k)
  const uniqueAdded = added.filter(label => {
    const key = normalizeLabel(label)
    if (key === '' || exclude.has(key)) return false
    exclude.add(key)
    return true
  })
  if (uniqueAdded.length === 0) {
    return { kind: 'idempotent', detail: 'the parsed label(s) already match the existing alt_labels (or the definition\'s own name/pref_label), or are suppressed — re-adding via add_alias (or a hand edit) lifts a veto' }
  }
  const merged = mergeAltLabels(existing, uniqueAdded)
  return { kind: 'applied', detail: `added ${uniqueAdded.length} new alt_label(s)`, value: merged }
}

/** @param target - the target name. @returns the shared "changed since issuance" detail string. */
function staleSinceIssuanceDetail(target: string): string {
  return `${target} changed since this work item was issued — call get_enrichment_work again and retry with a fresh work_id`
}

/**
 * Apply one agent-supplied completion against the current corpus state.
 *
 * In-lock re-verification (when called, per the module this ships in, from inside
 * `GitTier2Recorder.runAudited`'s `fn`): re-reads the target fresh, recomputes its
 * fingerprint, and compares it to the baseline embedded in `work_id` *before* parsing or
 * merging anything, so a target that changed between issuance and apply is caught before
 * its stale content could be merged into. Never throws for a bad or stale `work_id` —
 * every failure mode is a verdict (see this module's header), so one bad item in a batch
 * cannot abort the others (`applyEnrichmentResultsBatch` relies on that).
 *
 * A successful merge writes immediately via `writeTable` / `writeEventYaml` **without**
 * `Tier2Opts` — a deliberately raw, unaudited write at this call. The audit commit is
 * the caller's job (`applyEnrichmentResultsBatch`'s `beginBatch` window), because ADR-0006
 * ruling 4 asks for one commit per *batch*, not per item; staging is `git add -A`
 * regardless of how many raw writes preceded it, so the eventual commit still covers
 * every file this function touched.
 * @param semanticLayer - the semantic-layer directory path.
 * @param work_id - the work item's self-contained identity (target + round + baseline).
 * @param text - the agent's completion text for the prompt this work_id was issued for.
 * @returns the per-item outcome.
 */
export async function applyOneEnrichmentResult(
  semanticLayer: string,
  work_id: string,
  text: string,
): Promise<AppliedEnrichmentOutcome> {
  const payload = decodeWorkId(work_id)
  if (payload === undefined) {
    return {
      work_id,
      target: '(unknown)',
      verdict: 'stale_baseline',
      detail: 'work_id could not be decoded (malformed, a schema version this server does not know, or not issued by this server) — call get_enrichment_work again and retry with a fresh work_id',
    }
  }
  const { k: kind, r: round, t: target, h: baseline } = payload
  const base = { work_id, target, round } as const

  if (kind === 'table') {
    const row = loadTables(semanticLayer).find(x => x.table_name === target)
    if (row === undefined) return { ...base, verdict: 'stale_baseline', detail: `table ${target} no longer exists in the corpus` }
    if (fingerprint(row.raw) !== baseline) return { ...base, verdict: 'stale_baseline', detail: staleSinceIssuanceDetail(target) }
    const parsed = TableDefinitionSchema.safeParse(row.raw)
    if (!parsed.success) return { ...base, verdict: 'stale_baseline', detail: `${target} no longer validates against the table schema` }
    const def = parsed.data
    // Suppression sets (ADR-0010) — the apply path is the LLM round's write
    // surface, gated exactly like the deterministic rounds.
    const corpusVetoes = loadSuppressions(semanticLayer)
    const outcome = round === 'relation'
      ? mergeRelationText(text, def.dimension_refs, relationVetoSet(def.suppressed_dimension_refs))
      : mergeAltLabelsText(text, def.alt_labels, def.table_name, def.pref_label, aliasVetoSet(def.suppressed_alt_labels, corpusVetoes))
    if (outcome.kind !== 'applied') return { ...base, verdict: outcome.kind, detail: outcome.detail }
    const field = round === 'relation' ? 'dimension_refs' : 'alt_labels'
    await writeTable(semanticLayer, target, { ...row.raw, [field]: outcome.value })
    return { ...base, verdict: 'applied', detail: outcome.detail }
  }

  const row = loadEvents(semanticLayer).find(x => x.name === target)
  if (row === undefined) return { ...base, verdict: 'stale_baseline', detail: `event ${target} no longer exists in the corpus` }
  if (fingerprint(row.raw) !== baseline) return { ...base, verdict: 'stale_baseline', detail: staleSinceIssuanceDetail(target) }
  const parsed = EventDefinitionSchema.safeParse(row.raw)
  if (!parsed.success) return { ...base, verdict: 'stale_baseline', detail: `${target} no longer validates against the event schema` }
  const def = parsed.data
  const corpusVetoes = loadSuppressions(semanticLayer)
  const outcome = round === 'relation'
    ? mergeRelationText(text, def.external_refs, relationVetoSet(def.suppressed_external_refs))
    : mergeAltLabelsText(text, def.alt_labels, def.name, def.pref_label, aliasVetoSet(def.suppressed_alt_labels, corpusVetoes))
  if (outcome.kind !== 'applied') return { ...base, verdict: outcome.kind, detail: outcome.detail }
  const field = round === 'relation' ? 'external_refs' : 'alt_labels'
  const content = dumpYaml({ ...row.raw, [field]: outcome.value })
  const res = await writeEventYaml(semanticLayer, target, content)
  if (!res.ok) return { ...base, verdict: 'stale_baseline', detail: res.error }
  return { ...base, verdict: 'applied', detail: outcome.detail }
}

/** One `{work_id, text}` pair, as `apply_enrichment` receives it from the agent. */
export interface EnrichmentResultInput {
  readonly work_id: string
  readonly text: string
}

/**
 * Apply a batch of agent-supplied completions as one commit (ADR-0006 ruling 4's
 * `beginBatch` requirement).
 *
 * Processes items **sequentially**, not in parallel: two results naming the same
 * target would otherwise both read the same pre-write "existing" array and each decide
 * independently whether to write, silently dropping whichever one lands second — the
 * same reason `enrichAllDwsTables`'s own per-table loop is sequential.
 *
 * `rounds` in the eventual trailer counts *distinct round kinds actually applied*, not
 * items: a batch of 5 `relation` items and 1 `alt_labels` item that all apply reports
 * `rounds: 2`, which is `GitTier2Recorder.beginBatch`'s own contract (callers decide
 * what one `record()` call means). A fully idempotent batch — every item verdicted
 * `idempotent` / `stale_baseline` / `unparseable` — calls `record()` zero times and
 * `batch.end()` reports no commit, matching ADR-0005 ruling 8's single-write rule at
 * batch granularity.
 * @param semanticLayer - the semantic-layer directory path.
 * @param results - the agent's `{work_id, text}` pairs.
 * @param recorder - the Tier-2 recorder. Required (unlike `discoverRelations`'s optional
 *   `tier2`): this function has no legitimate unaudited caller — its only consumer is
 *   the `apply_enrichment` MCP tool, and D5 makes that write Tier-2 by construction.
 * @returns the per-item outcomes, in input order.
 * @throws whatever `recorder.beginBatch`'s `end()` throws (e.g. a commit failure);
 *   aborts the open batch first, restoring every raw write this call made.
 */
export async function applyEnrichmentResultsBatch(
  semanticLayer: string,
  results: readonly EnrichmentResultInput[],
  recorder: Tier2Recorder,
): Promise<{ readonly results: readonly AppliedEnrichmentOutcome[] }> {
  const outcomes: AppliedEnrichmentOutcome[] = []
  const batch = recorder.beginBatch?.()
  try {
    for (const r of results) {
      outcomes.push(await applyOneEnrichmentResult(semanticLayer, r.work_id, r.text))
    }
    const appliedRounds = new Set(
      outcomes
        .filter(o => o.verdict === 'applied')
        .map(o => o.round)
        .filter((r): r is WorkRound => r !== undefined),
    )
    if (batch !== undefined) {
      for (const round of appliedRounds) batch.record('apply_enrichment', { round })
      await batch.end()
    } else if (appliedRounds.size > 0) {
      // Defensive fallback for a Tier2Recorder without `beginBatch` (the slot is
      // optional — ADR-0004 ruling 3). One `recordTier2Write` call still lands every
      // applied item's raw write in ONE commit, because staging is `git add -A`
      // regardless of how many writes preceded it; it just forgoes the batch's precise
      // `Files`/`Rounds` trailer accounting.
      await recorder.recordTier2Write('apply_enrichment', { applied_rounds: [...appliedRounds] })
    }
    return { results: outcomes }
  } catch (e) {
    if (batch !== undefined) await batch.abort()
    throw e
  }
}

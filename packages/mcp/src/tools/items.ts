/**
 * ADR-0005's four item-level write tools: `add_alias`, `remove_alias`, `add_relation`,
 * `remove_relation`.
 *
 * All four remain the read-modify-write ruling 3 asks for: read the current array fresh
 * *inside* `runAudited`'s lock (never from a value computed before the call), compute
 * the new array, hand the whole array to `core.updateTableMeta` / `updateEventMeta` as
 * a single-field overlay. None ever replaces the array wholesale from stale state —
 * the read and the write are one lock-protected step, mirroring
 * `tests/helpers/concurrent-writer.ts`'s own pattern exactly (the lost-update shape
 * that test exists to catch).
 *
 * #38 / ADR-0010 adds the suppression side (removal IS the veto, #37 §1): every
 * remove computes a **dual-field overlay** — the content array plus the def's
 * `suppressed_*` key array — in the SAME locked write (one commit, no `beginBatch`
 * needed), and every add computes the mirror overlay (adding back lifts the veto,
 * #37 §5). Idempotency therefore spans both fields: `changed` is whatever the git
 * recorder's window saw, and a call that changes neither the content array nor the
 * veto array is byte-identical — `changed: false`, no commit (ADR-0005 ruling 8,
 * unchanged). `remove_*` take arrays (`labels` / `relations`): same-target batch,
 * per-item verdicts in `results` (removed / absent / idempotent + `suppressed` +
 * `reasserted`); `reasserted` is judged in-lock — `updateTableMeta`'s on-write hook
 * has run and been re-read before the lock is released, so the receipt cannot lie
 * about the write-delete loop.
 *
 * @module tools/items
 */
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import { loadEvents, loadTables } from '@semantic-grounding/substrate'
import { z } from 'zod'
import { DefinitionNotFoundError, toToolErrorResult } from '../errors.ts'
import type { ServerDeps, ToolRegistrar } from '../server.ts'
import {
  RelationRefInputSchema,
  UPDATE_COMMON_FIELDS,
  WritableKindSchema,
  assertUpdateOk,
  clientNameFromEnvelope,
  type RelationRefInput,
} from './shared.ts'

/** The four item-level tool names. */
export const ITEM_TOOL_NAMES = ['add_alias', 'remove_alias', 'add_relation', 'remove_relation'] as const

type Kind = 'table' | 'event'

/** One per-item verdict row in a `remove_*` receipt (#37 §2/§3): what happened to
 * this key, whether THIS call recorded the veto for it, and whether the same
 * locked write's on-write enrichment hook re-asserted it anyway. */
interface RemoveItemVerdict {
  readonly key: string
  readonly outcome: 'removed' | 'absent' | 'idempotent'
  readonly suppressed: boolean
  readonly reasserted: boolean
}

/** Mirrors the substrate's private `normalizeLabel` (lowercased, trimmed) — the
 * alias suppression key form everywhere (#36 §1). Duplicated here (one line)
 * rather than widening the substrate's public barrel for it. */
function normalizeLabel(s: string): string {
  return s.toLowerCase().trim()
}

/**
 * Read a definition's raw dict, fresh off disk, inside the caller's lock.
 * @param root - the corpus root.
 * @param kind - which storage layout to scan.
 * @param name - the table_name / event name.
 * @returns the raw definition dict.
 * @throws DefinitionNotFoundError when no definition of this kind has this name.
 */
function readRawDefinition(root: string, kind: Kind, name: string): Record<string, unknown> {
  const raw = kind === 'table'
    ? loadTables(root).find(t => t.table_name === name)?.raw
    : loadEvents(root).find(e => e.name === name)?.raw
  if (raw === undefined) throw new DefinitionNotFoundError(`no ${kind} named "${name}"`, { kind, name })
  return raw
}

/** A `string[]` field read leniently off a raw dict (absent/malformed => `[]`). */
function stringArrayField(raw: Record<string, unknown>, field: string): string[] {
  const v = raw[field]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** An array-of-objects field read leniently off a raw dict (absent/malformed => `[]`). */
function objectArrayField(raw: Record<string, unknown>, field: string): unknown[] {
  const v = raw[field]
  return Array.isArray(v) ? v : []
}

/** Order-sensitive array equality — the byte-stability gate that decides whether a
 * suppression field joins the overlay at all (see the module header). */
function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * Read a definition's current `alt_labels`, fresh off disk, inside the caller's lock.
 * @param root - the corpus root.
 * @param kind - which storage layout to scan.
 * @param name - the table_name / event name.
 * @returns the current array (empty when the field is absent or malformed).
 * @throws DefinitionNotFoundError when no definition of this kind has this name.
 */
function readAltLabels(root: string, kind: Kind, name: string): readonly string[] {
  return stringArrayField(readRawDefinition(root, kind, name), 'alt_labels')
}

/** The suppression field name pairing each content field (#36 §1). */
function suppressionFieldName(kind: Kind, content: 'alt_labels' | 'relation'): 'suppressed_alt_labels' | 'suppressed_dimension_refs' | 'suppressed_external_refs' {
  if (content === 'alt_labels') return 'suppressed_alt_labels'
  return kind === 'table' ? 'suppressed_dimension_refs' : 'suppressed_external_refs'
}

/** The field `dimension_refs` (table) / `external_refs` (event) is called on each kind. */
function relationFieldName(kind: Kind): 'dimension_refs' | 'external_refs' {
  return kind === 'table' ? 'dimension_refs' : 'external_refs'
}

/** The shape every item tool needs back — success-field name (`table_name`/`event_name`) dropped, since none of them read it. */
type ApplyResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

/**
 * Apply one field overlay via `updateTableMeta` / `updateEventMeta`, dispatched by
 * `kind`, with an explicit return type.
 *
 * Not a bare `kind === 'table' ? core.updateTableMeta(...) : core.updateEventMeta(...)`
 * inline inside `runAudited`'s `fn`: measured — `UpdateTableMetaResult` and
 * `UpdateEventMetaResult` differ only in their success branch's field name
 * (`table_name` vs `event_name`), and TypeScript infers `runAudited<T>`'s `T` from
 * whichever branch it resolves first, then rejects the other branch against that fixed
 * `T`. An explicitly-typed wrapper (dropping the field neither branch's caller reads)
 * sidesteps the inference order entirely, rather than annotating every call site.
 * @param deps - the process-wide dependencies.
 * @param kind - which Tier-2 method to call.
 * @param name - the table_name / event name.
 * @param updates - the dual-field overlay (`{ alt_labels: [...] }` plus optionally the
 *   `suppressed_*` array — included only when it changed or already exists on disk,
 *   so a veto-free call never introduces the key).
 * @param expectedVersion - the caller's baseline fingerprint.
 * @returns `{ok:true}` on success, or `{ok:false, error}` — never throws for a normal validation/not-found outcome.
 */
async function applyFieldUpdate(
  deps: ServerDeps,
  kind: Kind,
  name: string,
  updates: Readonly<Record<string, unknown>>,
  expectedVersion: string,
): Promise<ApplyResult> {
  if (kind === 'table') {
    const res = await deps.core.updateTableMeta(name, updates, { expected_version: expectedVersion })
    return res.ok ? { ok: true } : res
  }
  const res = await deps.core.updateEventMeta(name, updates, { expected_version: expectedVersion })
  return res.ok ? { ok: true } : res
}

/**
 * @param a - one existing entry's `join_keys`, read verbatim off disk (unknown shape).
 * @param b - the tool input's own `join_keys`.
 * @returns whether every pair matches, in order — the simple, honest reading of
 *   "the exact same relation" (a different order is treated as a different relation
 *   rather than invisibly normalized).
 */
function sameJoinKeys(a: unknown, b: RelationRefInput['join_keys']): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false
  return a.every((raw, i) => {
    const expected = b[i]
    return typeof raw === 'object' && raw !== null
      && (raw as { readonly dws_column?: unknown }).dws_column === expected?.dws_column
      && (raw as { readonly dim_column?: unknown }).dim_column === expected?.dim_column
  })
}

/**
 * @param existing - one existing relation-ref entry, read verbatim off disk.
 * @param relation - the tool input's asserted relation.
 * @returns whether `existing` is structurally the same relation (same `dim_table`,
 *   same `join_keys` in the same order) — the identity `add_relation` / `remove_relation`
 *   key off, regardless of `origin` / `derivation` on the stored entry.
 */
function matchesRelation(existing: unknown, relation: RelationRefInput): boolean {
  if (typeof existing !== 'object' || existing === null) return false
  const e = existing as { readonly dim_table?: unknown; readonly join_keys?: unknown }
  return e.dim_table === relation.dim_table && sameJoinKeys(e.join_keys, relation.join_keys)
}

/** The response JSON spine every item tool shares (ADR-0005 ruling 8), as a plain
 * record so each registrar spreads its additive fields on top. */
function itemResponseBase(res: { readonly commit: string; readonly changed: boolean }, enrichmentHealth: unknown): Record<string, unknown> {
  return {
    commit: res.commit,
    changed: res.changed,
    ...enrichmentHealth !== undefined ? { enrichment_health: enrichmentHealth } : {},
  }
}

/** Common input shape for `add_alias` / `add_relation` (single-item — #37 §3 keeps
 * `add_*` single: no measured pain, nothing pre-built). */
const AddAliasInputSchema = z.object({
  kind: WritableKindSchema,
  name: z.string().min(1),
  alias: z.string().min(1),
  ...UPDATE_COMMON_FIELDS,
})

/** `remove_alias` input: same-target batch of labels (#37 §3 — the empty array is
 * closed at the door, map #27 precedent). Breaking reshape of ADR-0005's `alias`. */
const RemoveAliasInputSchema = z.object({
  kind: WritableKindSchema,
  name: z.string().min(1),
  labels: z.array(z.string().min(1)).min(1),
  ...UPDATE_COMMON_FIELDS,
})

/** Common input shape for `add_relation` (single). */
const AddRelationInputSchema = z.object({
  kind: WritableKindSchema,
  name: z.string().min(1),
  relation: RelationRefInputSchema,
  ...UPDATE_COMMON_FIELDS,
})

/** `remove_relation` input: same-target batch of relations (#37 §3). Breaking
 * reshape of ADR-0005's `relation`. */
const RemoveRelationInputSchema = z.object({
  kind: WritableKindSchema,
  name: z.string().min(1),
  relations: z.array(RelationRefInputSchema).min(1),
  ...UPDATE_COMMON_FIELDS,
})

/** Registers `add_alias`. */
function registerAddAlias(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'add_alias',
    {
      title: 'Add an alias',
      description: 'Append one alt_label to a table or event, read-modify-write inside the corpus lock. Adding back a suppressed label LIFTS its veto — removal is the veto, re-assertion is its mirror — and the receipt\'s `unsuppressed` lists the keys this call lifted (absent when none). A call that neither adds the label nor lifts a veto is a no-op (changed:false, no commit).',
      inputSchema: AddAliasInputSchema,
    },
    async (input, ctx: ServerContext) => {
      try {
        const clientName = clientNameFromEnvelope(ctx)
        const root = deps.core.resolveScopeRoot()
        const res = await deps.recorder.runAudited(
          {
            tool: 'add_alias',
            target: input.name,
            summary: input.summary,
            derivation: input.derivation,
            confidence: input.confidence,
            ...clientName !== undefined ? { clientName } : {},
          },
          async () => {
            const raw = readRawDefinition(root, input.kind, input.name)
            const existing = stringArrayField(raw, 'alt_labels')
            const key = normalizeLabel(input.alias)
            const present = existing.some(a => normalizeLabel(a) === key)
            const next = present ? existing : [...existing, input.alias]
            // The veto lift (remove the key from suppressed_alt_labels); the field
            // joins the overlay only when it changed or already exists on disk.
            const existingSup = stringArrayField(raw, 'suppressed_alt_labels')
            const wasVetoed = existingSup.some(s => normalizeLabel(s) === key)
            const nextSup = existingSup.filter(s => normalizeLabel(s) !== key)
            const updates: Record<string, unknown> = { alt_labels: next }
            if (!sameStringArray(existingSup, nextSup) || raw.suppressed_alt_labels !== undefined) {
              updates['suppressed_alt_labels'] = nextSup
            }
            const apply = await applyFieldUpdate(deps, input.kind, input.name, updates, input.expected_version)
            return { apply, unsuppressed: wasVetoed ? [key] : [] }
          },
        )
        assertUpdateOk(res.value.apply, input.kind, input.name)
        const enrichment_health = input.kind === 'table' ? deps.core.getEnrichmentHealth() : undefined
        const body = itemResponseBase(res, enrichment_health)
        if (res.value.unsuppressed.length > 0) body['unsuppressed'] = res.value.unsuppressed
        return { content: [{ type: 'text', text: JSON.stringify(body) }] }
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

/** Registers `remove_alias`. */
function registerRemoveAlias(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'remove_alias',
    {
      title: 'Remove aliases (and veto their return)',
      description: 'Remove alt_labels from a table or event, read-modify-write inside the corpus lock — one locked write for the whole same-target batch. Every removal records a persistent suppression keyed on the label\'s normalized form: enrichment rounds (deterministic AND LLM) will never re-assert a suppressed label — removal IS the veto; it does not depend on the label being present (ensure-absent: pre-vetoing a word the rounds have not found yet). Per-item verdicts in `results`: `removed` (was present, now gone), `absent` (was not present; the veto this call records is the write), `idempotent` (absent and already vetoed — the only true no-op). `suppressed` says whether THIS call recorded the key\'s veto; `reasserted` says whether the same write\'s on-write hook immediately re-derived it (cannot happen for a vetoed label — it is reported per item so a receipt never has to be trusted on faith). Adding the label back (add_alias) lifts the veto.',
      inputSchema: RemoveAliasInputSchema,
    },
    async (input, ctx: ServerContext) => {
      try {
        const clientName = clientNameFromEnvelope(ctx)
        const root = deps.core.resolveScopeRoot()
        const res = await deps.recorder.runAudited(
          {
            tool: 'remove_alias',
            target: input.name,
            summary: input.summary,
            derivation: input.derivation,
            confidence: input.confidence,
            ...clientName !== undefined ? { clientName } : {},
          },
          async () => {
            const raw = readRawDefinition(root, input.kind, input.name)
            const existing = stringArrayField(raw, 'alt_labels')
            const removalKeys = input.labels.map(normalizeLabel)
            const removalSet = new Set(removalKeys)
            const next = existing.filter(a => !removalSet.has(normalizeLabel(a)))
            // The veto side: union the normalized keys into suppressed_alt_labels
            // (verbatim existing entries first, new keys in input order).
            const existingSup = stringArrayField(raw, 'suppressed_alt_labels')
            const supSeen = new Set(existingSup.map(normalizeLabel))
            const nextSup = [...existingSup]
            for (const key of removalKeys) {
              if (!supSeen.has(key)) {
                supSeen.add(key)
                nextSup.push(key)
              }
            }
            const updates: Record<string, unknown> = { alt_labels: next }
            if (!sameStringArray(existingSup, nextSup) || raw.suppressed_alt_labels !== undefined) {
              updates['suppressed_alt_labels'] = nextSup
            }
            const apply = await applyFieldUpdate(deps, input.kind, input.name, updates, input.expected_version)
            // reasserted, in-lock (#37 §2): updateTableMeta's on-write hook has run
            // by the time applyFieldUpdate resolves; re-read and see what came back.
            const after = stringArrayField(readRawDefinition(root, input.kind, input.name), 'alt_labels')
            const results: RemoveItemVerdict[] = input.labels.map((label, i) => {
              const key = removalKeys[i] as string
              const present = existing.some(a => normalizeLabel(a) === key)
              const vetoNow = !new Set(existingSup.map(normalizeLabel)).has(key)
              const outcome = present ? 'removed' : (vetoNow ? 'absent' : 'idempotent')
              return { key, outcome, suppressed: vetoNow, reasserted: after.some(a => normalizeLabel(a) === key) }
            })
            return { apply, results }
          },
        )
        assertUpdateOk(res.value.apply, input.kind, input.name)
        const enrichment_health = input.kind === 'table' ? deps.core.getEnrichmentHealth() : undefined
        const body = itemResponseBase(res, enrichment_health)
        body['results'] = res.value.results
        return { content: [{ type: 'text', text: JSON.stringify(body) }] }
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

/** Registers `add_relation`. */
function registerAddRelation(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'add_relation',
    {
      title: 'Add a relation',
      description: 'Append one dimension/external relation (dim_table + join_keys) to a table or event, read-modify-write inside the corpus lock. Omits origin and derivation on write — the appended ref is treated as curated (ADR-0005 rulings 9-10); your basis for the join belongs in summary. A no-op when the exact same relation is already present. Re-asserting a dim_table whose relations are suppressed LIFTS that veto (granularity: one dim_table per veto) — the receipt\'s `unsuppressed` names the lifted key when this call lifted one.',
      inputSchema: AddRelationInputSchema,
    },
    async (input, ctx: ServerContext) => {
      try {
        const clientName = clientNameFromEnvelope(ctx)
        const root = deps.core.resolveScopeRoot()
        const field = relationFieldName(input.kind)
        const supField = suppressionFieldName(input.kind, 'relation')
        const res = await deps.recorder.runAudited(
          {
            tool: 'add_relation',
            target: input.name,
            summary: input.summary,
            derivation: input.derivation,
            confidence: input.confidence,
            ...clientName !== undefined ? { clientName } : {},
          },
          async () => {
            if (input.kind === 'table' && deps.core.loadTableDefinition(input.relation.dim_table) === null) {
              throw new DefinitionNotFoundError(
                `add_relation: dim_table "${input.relation.dim_table}" has no table definition — create it first`,
                { kind: 'table', name: input.relation.dim_table },
              )
            }
            const raw = readRawDefinition(root, input.kind, input.name)
            const existing = objectArrayField(raw, field)
            const alreadyPresent = existing.some(e => matchesRelation(e, input.relation))
            const next = alreadyPresent ? existing : [...existing, { dim_table: input.relation.dim_table, join_keys: input.relation.join_keys }]
            const key = input.relation.dim_table
            const existingSup = stringArrayField(raw, supField)
            const wasVetoed = existingSup.includes(key)
            const nextSup = existingSup.filter(k => k !== key)
            const updates: Record<string, unknown> = { [field]: next }
            if (!sameStringArray(existingSup, nextSup) || raw[supField] !== undefined) {
              updates[supField] = nextSup
            }
            const apply = await applyFieldUpdate(deps, input.kind, input.name, updates, input.expected_version)
            return { apply, unsuppressed: wasVetoed ? [key] : [] }
          },
        )
        assertUpdateOk(res.value.apply, input.kind, input.name)
        const enrichment_health = input.kind === 'table' ? deps.core.getEnrichmentHealth() : undefined
        const body = itemResponseBase(res, enrichment_health)
        if (res.value.unsuppressed.length > 0) body['unsuppressed'] = res.value.unsuppressed
        return { content: [{ type: 'text', text: JSON.stringify(body) }] }
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

/** Registers `remove_relation`. */
function registerRemoveRelation(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'remove_relation',
    {
      title: 'Remove relations (machine-derived ones are vetoed)',
      description: 'Remove exactly-matching dimension/external relations (dim_table + join_keys) from a table or event, read-modify-write inside the corpus lock — one locked write for the whole same-target batch. Per-item verdicts in `results` with three facts: `outcome` (`removed` / `absent` / `idempotent`), `suppressed` (did THIS call record the veto), and `reasserted` (did the same write\'s on-write hook immediately re-derive it). Removal routes by the stored entry\'s origin (#37 §1): deleting a machine-derived ref (origin deterministic/llm) records a persistent suppression for that dim_table — enrichment rounds will never re-derive the join; deleting a curated ref (origin manual/absent: hand-added or agent-asserted) is a pure content correction, and if the deterministic round CAN re-derive that join it comes back in the same call (`reasserted: true`) — remove it again and THAT removal vetoes it. Removing an absent relation records the veto (ensure-absent: pre-veto a DIM you know is noise). Adding the dim_table back (add_relation) lifts the veto.',
      inputSchema: RemoveRelationInputSchema,
    },
    async (input, ctx: ServerContext) => {
      try {
        const clientName = clientNameFromEnvelope(ctx)
        const root = deps.core.resolveScopeRoot()
        const field = relationFieldName(input.kind)
        const supField = suppressionFieldName(input.kind, 'relation')
        const res = await deps.recorder.runAudited(
          {
            tool: 'remove_relation',
            target: input.name,
            summary: input.summary,
            derivation: input.derivation,
            confidence: input.confidence,
            ...clientName !== undefined ? { clientName } : {},
          },
          async () => {
            const raw = readRawDefinition(root, input.kind, input.name)
            const existing = objectArrayField(raw, field)
            const next = existing.filter(e => !input.relations.some(r => matchesRelation(e, r)))
            // The veto side, routed by the removed entries' origins: a dim_table is
            // vetoed when any removed entry for it was machine-derived, or when
            // nothing matched at all (ensure-absent).
            const existingSup = stringArrayField(raw, supField)
            const nextSup = [...existingSup]
            const supSeen = new Set(existingSup)
            const info = input.relations.map(rel => {
              const key = rel.dim_table
              const matches = existing.filter(e => matchesRelation(e, rel))
              const present = matches.length > 0
              const machineRemoved = matches.some(e => {
                const origin = (e as { readonly origin?: unknown }).origin
                return origin === 'deterministic' || origin === 'llm'
              })
              const vetoNow = (machineRemoved || !present) && !supSeen.has(key)
              if (vetoNow) {
                supSeen.add(key)
                nextSup.push(key)
              }
              return { key, present, vetoNow }
            })
            const updates: Record<string, unknown> = { [field]: next }
            if (!sameStringArray(existingSup, nextSup) || raw[supField] !== undefined) {
              updates[supField] = nextSup
            }
            const apply = await applyFieldUpdate(deps, input.kind, input.name, updates, input.expected_version)
            // reasserted, in-lock (#37 §2): any ref with this dim_table that survived
            // the write (i.e. the on-write hook re-derived it) marks the dance.
            const afterRefs = objectArrayField(readRawDefinition(root, input.kind, input.name), field)
            const results: RemoveItemVerdict[] = info.map(({ key, present, vetoNow }) => ({
              key,
              outcome: present ? 'removed' : (vetoNow ? 'absent' : 'idempotent'),
              suppressed: vetoNow,
              reasserted: afterRefs.some(e => (e as { readonly dim_table?: unknown }).dim_table === key),
            }))
            return { apply, results }
          },
        )
        assertUpdateOk(res.value.apply, input.kind, input.name)
        const enrichment_health = input.kind === 'table' ? deps.core.getEnrichmentHealth() : undefined
        const body = itemResponseBase(res, enrichment_health)
        body['results'] = res.value.results
        return { content: [{ type: 'text', text: JSON.stringify(body) }] }
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

/** Registers all four item-level tools. */
export const registerItemTools: ToolRegistrar = (server, deps) => {
  registerAddAlias(server, deps)
  registerRemoveAlias(server, deps)
  registerAddRelation(server, deps)
  registerRemoveRelation(server, deps)
}

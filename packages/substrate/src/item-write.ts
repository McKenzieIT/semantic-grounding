/**
 * The item-level write rituals (#49 / ADR-0005 ruling 3, ADR-0010) — the home of
 * everything the Core class's four public item methods and its two concept-edge
 * internals do to disk. Previously the helper family + six methods lived inside
 * `src/index.ts`; extracted here so each piece of the ceremony has one home:
 *
 *  - the six entry functions (`addItemAlias` / `removeItemAliases` /
 *    `addItemRelation` / `removeItemRelations` + the two unexported
 *    concept-edge functions below them);
 *  - the byte-stability gate (`suppressionJoinsUpdate`, #36 §1);
 *  - the veto routing (`unionVetoKeys`, #37 §1);
 *  - the per-key receipt construction (`removalVerdict`, #37 §2);
 *  - the field pairing (`itemSuppressionFieldName` / `itemRelationFieldName`).
 *
 * ## The dual-field overlay
 *
 * Every write touches a content field (`alt_labels` / `dimension_refs` /
 * `external_refs` / `related_refs`) AND its `suppressed_*` veto field — removal
 * IS the veto, and adding lifts it. The gate is what keeps a no-op write from
 * ever introducing a `suppressed_*` onto a definition that never had one, which
 * is a byte-stability property: the file on disk must not churn when nothing
 * changed semantically.
 *
 * `SemanticGroundingCore.addAlias` / `.removeAliases` / `.addRelation` /
 * `.removeRelations` (`src/index.ts`) are one-line forwards into this module —
 * the class keeps the ADR-0002/0003 public method names; the write ritual lives
 * here. Off the public barrel for the same reason `enrichment-work.ts` is
 * (ADR-0002/0003): no host imports it by name, and the audited dispatch
 * (`applyItemUpdate` → `updateTableMeta` / `updateEventMeta` / `updateConceptMeta`
 * by kind) stays on the Core, threaded through as the `applyUpdate` seam.
 *
 * @module item-write (internal; only `"."` is importable — see ADR-0002)
 */
import {
  loadTables,
  loadEvents,
  loadConcepts,
  loadTableDefinition as loadTableDefinitionFromLayer,
  loadConceptDefinition as loadConceptDefinitionFromLayer,
  normalizeLabel,
} from './io.ts'
import type { AddVerdict, ItemVerdict } from './types.ts'

/** The kinds an item-level write may target — concepts joined the set when the
 * concept write path opened (#52 / ADR-0012); the alias semantics are isomorphic
 * and ride the same dual-field overlay. */
export type ItemKind = 'table' | 'event' | 'concept'

/** One relation as the item methods accept it: the historical asset→dim join
 * shape (`dim_table` + `join_keys`), or a concept-side edge (`target_kind` +
 * `name`, no join semantics — Q4(b) Update). The `target_kind?: undefined`
 * marker keeps the union discriminable without making legacy calls spell out
 * `target_kind: 'table'`. */
export type RelationInput =
  | { readonly target_kind?: undefined; readonly dim_table: string; readonly join_keys: readonly { readonly dws_column: string; readonly dim_column: string }[] }
  | { readonly target_kind: 'table' | 'concept'; readonly name: string }

/** The join-shaped bucket of a partitioned {@link RelationInput} batch: the
 * historical asset→dim join, routed down the table/event path. */
type JoinShapedRelation = { readonly dim_table: string; readonly join_keys: readonly { readonly dws_column: string; readonly dim_column: string }[] }

/** The concept-edge bucket of a partitioned {@link RelationInput} batch
 * (Q4(b)): `target_kind` + `name`, no join semantics. */
type ConceptEdgeInput = { readonly target_kind: 'table' | 'concept'; readonly name: string }

/** A declared concept edge as stored on the home concept's `related_refs`: the
 * input edge with its `name` rewritten to `target` — the edge's OTHER side
 * (see the concept-edge section below). */
type ConceptEdgeRecord = { readonly target_kind: 'table' | 'concept'; readonly target: string }

// ── Item-method helpers (#49) ─────────────────────────────────────────────────────
//
// Helpers for the item-level write entries (addAlias / removeAliases /
// addRelation / removeRelations + the concept-edge pair). Previously lived in
// the MCP tool layer (`packages/mcp/src/tools/items.ts`); converged at the
// substrate level so the domain logic has one home and the handlers thin to
// schema + auditedWrite + Core call + response formatting.

/** Is this relation a concept-side edge (Q4(b)), rather than an asset→dim join? */
function isConceptEdge(rel: RelationInput): rel is ConceptEdgeInput {
  return rel.target_kind !== undefined
}

/** The veto key for one declared concept edge: the graph-id form of its target
 * (`concept:<name>` for concept targets, the bare table name for table
 * targets) — collision-free between a table and a concept sharing a name. */
function conceptEdgeKey(edge: ConceptEdgeRecord): string {
  return edge.target_kind === 'concept' ? `concept:${edge.target}` : edge.target
}

/** Structural identity for a declared concept edge: same `target_kind` + same
 * `target`. No order or join-key component — an edge has neither. */
function itemMatchesConceptEdge(existing: unknown, edge: ConceptEdgeRecord): boolean {
  if (typeof existing !== 'object' || existing === null) return false
  const e = existing as { readonly target_kind?: unknown; readonly target?: unknown }
  return e.target_kind === edge.target_kind && e.target === edge.target
}

/** Read a definition's raw dict off disk (lenient — throws on missing target). */
function itemReadRawDef(root: string, kind: ItemKind, name: string): Record<string, unknown> {
  const raw = kind === 'table'
    ? loadTables(root).find(t => t.table_name === name)?.raw
    : kind === 'event'
      ? loadEvents(root).find(e => e.name === name)?.raw
      : loadConcepts(root).find(c => c.name === name)?.raw
  if (raw === undefined) throw new Error(`${kind === 'table' ? 'Table' : kind === 'event' ? 'Event' : 'Concept'} not found: ${name}`)
  return raw
}

/** A `string[]` field read leniently off a raw dict (absent/malformed → `[]`). */
function itemStringArray(raw: Record<string, unknown>, field: string): string[] {
  const v = raw[field]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** An `unknown[]` field read leniently off a raw dict (absent/malformed → `[]`). */
function itemObjectArray(raw: Record<string, unknown>, field: string): unknown[] {
  const v = raw[field]
  return Array.isArray(v) ? v : []
}

/** Order-sensitive `string[]` equality — the byte-stability gate for the dual-field overlay. */
function itemSameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** The suppression field name pairing each content field (#36 §1). */
function itemSuppressionFieldName(kind: ItemKind, content: 'alt_labels' | 'relation'): 'suppressed_alt_labels' | 'suppressed_dimension_refs' | 'suppressed_external_refs' | 'suppressed_related_refs' {
  if (content === 'alt_labels') return 'suppressed_alt_labels'
  if (kind === 'concept') return 'suppressed_related_refs'
  return kind === 'table' ? 'suppressed_dimension_refs' : 'suppressed_external_refs'
}

/** The relation content field name per kind. */
function itemRelationFieldName(kind: ItemKind): 'dimension_refs' | 'external_refs' | 'related_refs' {
  return kind === 'table' ? 'dimension_refs' : kind === 'event' ? 'external_refs' : 'related_refs'
}

/** Order-sensitive join-key comparison (dws_column + dim_column, pair-by-pair). */
function itemSameJoinKeys(
  a: unknown,
  b: readonly { readonly dws_column: string; readonly dim_column: string }[],
): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false
  return a.every((raw, i) => {
    const expected = b[i]
    return typeof raw === 'object' && raw !== null
      && (raw as { readonly dws_column?: unknown }).dws_column === expected?.dws_column
      && (raw as { readonly dim_column?: unknown }).dim_column === expected?.dim_column
  })
}

/**
 * Structural relation identity: same `dim_table` + same `join_keys` in the
 * same order. A different order is treated as a different relation rather than
 * invisibly normalized — the same order-sensitive precedent ADR-0010 ruling 5
 * applies to the byte-stability gate.
 */
function itemMatchesRelation(
  existing: unknown,
  relation: { readonly dim_table: string; readonly join_keys: readonly { readonly dws_column: string; readonly dim_column: string }[] },
): boolean {
  if (typeof existing !== 'object' || existing === null) return false
  const e = existing as { readonly dim_table?: unknown; readonly join_keys?: unknown }
  return e.dim_table === relation.dim_table && itemSameJoinKeys(e.join_keys, relation.join_keys)
}

/** The byte-stability gate for the dual-field overlay (#36 §1): the
 * suppression field joins the update only when the list changed or the
 * field already exists on disk — a no-op write must never introduce
 * `suppressed_*` onto a definition that never had one. */
export function suppressionJoinsUpdate(
  raw: Record<string, unknown>,
  supField: string,
  existingSup: readonly string[],
  nextSup: readonly string[],
): boolean {
  return !itemSameStringArray(existingSup, nextSup) || raw[supField] !== undefined
}

/** Veto routing shared by the three removal paths (#37 §1): grow the
 * suppression list with each item whose `shouldVeto` says THIS call records
 * the veto. `supKey` maps on-disk entries into the comparison keyspace —
 * `normalizeLabel` for aliases, identity for relations/concept edges. */
function unionVetoKeys<T>(
  existingSup: readonly string[],
  items: readonly T[],
  keyOf: (item: T) => string,
  shouldVeto: (item: T, alreadySuppressed: boolean) => boolean,
  supKey: (entry: string) => string = entry => entry,
): { nextSup: string[]; vetoed: ReadonlySet<T> } {
  const nextSup = [...existingSup]
  const supSeen = new Set(existingSup.map(supKey))
  const vetoed = new Set<T>()
  for (const item of items) {
    if (shouldVeto(item, supSeen.has(keyOf(item)))) {
      supSeen.add(keyOf(item))
      nextSup.push(keyOf(item))
      vetoed.add(item)
    }
  }
  return { nextSup, vetoed }
}

/** Per-key receipt for the removal methods (#37 §2): `outcome` and
 * `suppressed` derive from the same two signals — whether the key was
 * present, and whether THIS call records the veto. */
function removalVerdict(key: string, present: boolean, recordsVeto: boolean, reasserted: boolean): ItemVerdict {
  const outcome: ItemVerdict['outcome'] = present ? 'removed' : recordsVeto ? 'absent' : 'idempotent'
  return { key, outcome, suppressed: recordsVeto, reasserted }
}

/** The Core's audited kind dispatch (`applyItemUpdate`) as a callable seam:
 * routes `updateTableMeta` / `updateEventMeta` / `updateConceptMeta` by kind
 * and throws on failure, resolving to the written file's fingerprint
 * (#108's write receipt) so this module stays free of the class. */
export type ApplyItemUpdate = (kind: ItemKind, name: string, updates: Readonly<Record<string, unknown>>, expectedVersion: string) => Promise<string>

/**
 * Add aliases to a table, event, or concept, lifting each key's veto if
 * suppressed — the add-side mirror of `removeItemAliases`' same-target batch
 * (#109 / #107 Q4: one read, one dual-field overlay, one commit for the
 * whole labels array).
 *
 * Dual-field overlay: appends each not-yet-present label to `alt_labels`
 * (normalized-key identity) AND removes every added key from
 * `suppressed_alt_labels` (the veto lift, #37 §5). The suppression field
 * joins the overlay only when it changed or already exists on disk — never
 * introduces `suppressed_*` onto a definition that never had one when
 * nothing changed.
 *
 * Verdicts (#107 Q5 — two values and one boolean): `outcome` is `added`
 * when THIS call landed the label or lifted its veto (either is a real
 * change — adding a vetoed word is `added` AND `unsuppressed: true`, never
 * a third outcome), `idempotent` when the label was already present and not
 * vetoed. A batch where every row is idempotent writes byte-identical
 * content — no commit (`changed: false`).
 * @param root - the semantic-layer scope root this write targets.
 * @param applyUpdate - the Core's `applyItemUpdate` (audited kind dispatch, throws on failure).
 * @param kind - `'table'`, `'event'`, or `'concept'`.
 * @param name - the table_name / event name.
 * @param labels - the aliases to add (verbatim forms; normalized for comparison).
 * @param expectedVersion - the sha256 fingerprint from `get_definition`.
 * @returns per-item verdicts, plus the written file's `version` fingerprint
 *   (post-hook for tables, #108).
 * @throws Error when the target definition does not exist.
 * @throws StaleBaselineError when the fingerprint mismatches.
 */
export async function addItemAliases(
  root: string,
  applyUpdate: ApplyItemUpdate,
  kind: ItemKind,
  name: string,
  labels: readonly string[],
  expectedVersion: string,
): Promise<{ readonly results: readonly AddVerdict[]; readonly version: string }> {
  const raw = itemReadRawDef(root, kind, name)
  const existing = itemStringArray(raw, 'alt_labels')
  const supField = 'suppressed_alt_labels'
  const existingSup = itemStringArray(raw, supField)
  // In-order duplicate semantics, mirroring the removal paths: each label is
  // judged against the state the earlier labels in this same call left — the
  // first occurrence of a key does the adding/lifting, repeats read as
  // idempotent, and only the first reports the veto lift.
  let next = existing
  const supSeen = new Set(existingSup.map(normalizeLabel))
  const lifted = new Set<string>()
  const results: AddVerdict[] = labels.map(label => {
    const key = normalizeLabel(label)
    const present = next.some(a => normalizeLabel(a) === key)
    const wasVetoed = supSeen.has(key)
    if (!present) next = [...next, label]
    if (wasVetoed) {
      supSeen.delete(key)
      lifted.add(key)
    }
    return { key, outcome: !present || wasVetoed ? 'added' : 'idempotent', unsuppressed: wasVetoed }
  })
  const nextSup = existingSup.filter(s => !lifted.has(normalizeLabel(s)))
  const updates: Record<string, unknown> = { alt_labels: next }
  if (suppressionJoinsUpdate(raw, supField, existingSup, nextSup)) {
    updates[supField] = nextSup
  }
  const version = await applyUpdate(kind, name, updates, expectedVersion)
  return { results, version }
}

/**
 * Remove aliases from a table or event, recording persistent suppressions.
 *
 * Dual-field overlay: removes matching entries from `alt_labels` AND unions
 * the normalized keys into `suppressed_alt_labels` (the veto, #37 §1). Every
 * removal records a persistent suppression — removal IS the veto; it does not
 * depend on the label being present (ensure-absent: pre-vetoing a word the
 * enrichment rounds have not found yet).
 *
 * Per-item verdicts (#37 §2):
 * - `removed`: was present, now gone.
 * - `absent`: was not present; the veto THIS call records IS the write.
 * - `idempotent`: absent AND already vetoed — the only true no-op.
 *
 * `reasserted` is judged in-lock: `updateTableMeta`'s on-write enrichment
 * hook has run by the time the method resolves, so the receipt cannot lie
 * about the write-delete loop.
 * @param root - the semantic-layer scope root this write targets.
 * @param applyUpdate - the Core's `applyItemUpdate` (audited kind dispatch, throws on failure).
 * @param kind - `'table'`, `'event'`, or `'concept'`.
 * @param name - the table_name / event name.
 * @param labels - the labels to remove (verbatim; normalized for comparison).
 * @param expectedVersion - the sha256 fingerprint from `get_definition`.
 * @returns per-item verdicts, plus the written file's `version` fingerprint
 *   (post-hook for tables, #108).
 * @throws Error when the target definition does not exist.
 * @throws StaleBaselineError when the fingerprint mismatches.
 */
export async function removeItemAliases(
  root: string,
  applyUpdate: ApplyItemUpdate,
  kind: ItemKind,
  name: string,
  labels: readonly string[],
  expectedVersion: string,
): Promise<{ readonly results: readonly ItemVerdict[]; readonly version: string }> {
  const raw = itemReadRawDef(root, kind, name)
  const existing = itemStringArray(raw, 'alt_labels')
  const removalKeys = labels.map(normalizeLabel)
  const removalSet = new Set(removalKeys)
  const next = existing.filter(a => !removalSet.has(normalizeLabel(a)))
  // Veto side: union normalized keys into suppressed_alt_labels (the
  // normalized keyspace — alias vetoes compare by normalizeLabel).
  const supField = 'suppressed_alt_labels'
  const existingSup = itemStringArray(raw, supField)
  const { nextSup } = unionVetoKeys(
    existingSup,
    removalKeys,
    key => key,
    (_key, alreadySuppressed) => !alreadySuppressed,
    normalizeLabel,
  )
  const updates: Record<string, unknown> = { alt_labels: next }
  if (suppressionJoinsUpdate(raw, supField, existingSup, nextSup)) {
    updates[supField] = nextSup
  }
  const version = await applyUpdate(kind, name, updates, expectedVersion)
  // In-lock reassertion check: the on-write hook has run.
  const afterRaw = itemReadRawDef(root, kind, name)
  const after = itemStringArray(afterRaw, 'alt_labels')
  const results: ItemVerdict[] = labels.map((label, i) => {
    const key = removalKeys[i] as string
    const wasPresent = existing.some(a => normalizeLabel(a) === key)
    const wasAlreadyVetoed = existingSup.some(s => normalizeLabel(s) === key)
    // recordsVeto ≡ the old `suppressed: outcome !== 'idempotent'` across all
    // three quadrants: present → removed (true), absent+unvetoed → absent
    // (true), absent+vetoed → idempotent (false).
    return removalVerdict(key, wasPresent, wasPresent || !wasAlreadyVetoed, after.some(a => normalizeLabel(a) === key))
  })
  return { results, version }
}

/** Bucket a relation batch into its two shapes, refusing the mix up front
 * (Q6 / Q4(b)): concept edges and join-shaped relations write different files
 * with different baselines, so one call carries one shape. Shared verbatim by
 * the add and remove entries; `verbLabel` names the tool in the split-the-call
 * error — the two sides' texts differed by that word alone, previously
 * hand-copied per side.
 */
function partitionItemRelations(
  relations: readonly RelationInput[],
  verbLabel: 'add_relation' | 'remove_relation',
): { readonly edges: ConceptEdgeInput[]; readonly joins: JoinShapedRelation[] } {
  const edges: ConceptEdgeInput[] = []
  const joins: JoinShapedRelation[] = []
  for (const rel of relations) {
    if (isConceptEdge(rel)) edges.push(rel)
    else joins.push(rel)
  }
  if (edges.length > 0 && joins.length > 0) {
    throw new Error(`${verbLabel} cannot mix join-shaped relations with concept edges in one call — they write different files with different baselines; split the call`)
  }
  return { edges, joins }
}

/**
 * Add relations to a table or event, lifting each key's veto if suppressed —
 * `addItemAliases`' mirror over the relation fields (#109 / #107 Q4: one
 * read, one dual-field overlay, one commit for the whole batch).
 *
 * One shape per call (Q6): joins (`dim_table` + `join_keys`) or concept-side
 * edges (`{target_kind, name}`) — the Core refuses a mix with a
 * split-the-call error, exactly `removeItemRelations`' rule (different
 * files, different baselines).
 *
 * Dual-field overlay: appends each structurally-new relation (omitting
 * `origin` / `derivation` per ADR-0005 rulings 9–10, so entries are treated
 * as curated) AND removes each added `dim_table` key from the relation
 * suppression field (the veto lift; granularity: one dim_table per veto).
 *
 * Relation identity is structural: same `dim_table` + same `join_keys` in
 * the same order — a different order is a different relation rather than
 * invisibly normalized (ADR-0010 ruling 5's order-sensitive precedent).
 * Verdicts carry `ItemVerdict`'s add-side mirror shape (`AddVerdict`); a
 * fully-idempotent batch writes byte-identical content — no commit.
 * @param root - the semantic-layer scope root this write targets.
 * @param applyUpdate - the Core's `applyItemUpdate` (audited kind dispatch, throws on failure).
 * @param kind - `'table'`, `'event'` (join-shaped relations), or `'concept'` (concept-side edges).
 * @param name - the table_name / event / concept name.
 * @param relations - the joins or same-shape concept edges to add; the two shapes cannot mix in one call.
 * @param expectedVersion - the sha256 fingerprint from `get_definition`.
 * @returns per-item verdicts, plus the written file's `version` fingerprint
 *   — the fingerprint of the file this write touched (the HOME concept for
 *   a concept-side edge batch, the subject for joins), as the whole write
 *   left it (#108).
 * @throws Error when the target definition does not exist, when `kind === 'table'`
 *   and a `relation.dim_table` has no table definition, or when the batch
 *   mixes joins with concept edges.
 * @throws StaleBaselineError when the fingerprint mismatches.
 */
export async function addItemRelations(
  root: string,
  applyUpdate: ApplyItemUpdate,
  kind: ItemKind,
  name: string,
  relations: readonly RelationInput[],
  expectedVersion: string,
): Promise<{ readonly results: readonly AddVerdict[]; readonly version: string }> {
  // Partition first (Q6): one call carries one shape — the helper refuses the
  // mix; a concept-edge batch routes to the concept path, everything else
  // (joins only, by the mix rule) falls through to the join path.
  const { edges, joins } = partitionItemRelations(relations, 'add_relation')
  if (edges.length > 0) {
    return addItemConceptEdges(root, applyUpdate, kind, name, edges, expectedVersion)
  }
  if (kind === 'concept') {
    throw new Error('join-shaped relations (dim_table + join_keys) are not supported for concepts — a concept declares entity-layer edges with target_kind instead (Q4(b))')
  }
  // For tables, verify every distinct dim_table has its own definition —
  // checked per batch up front so a bad key rejects the whole call before
  // any write lands (same all-or-nothing door the partition's mix rule keeps).
  if (kind === 'table') {
    for (const rel of joins) {
      if (loadTableDefinitionFromLayer(root, rel.dim_table) === null) {
        throw new Error(`Table not found: ${rel.dim_table}`)
      }
    }
  }
  const field = itemRelationFieldName(kind)
  const supField = itemSuppressionFieldName(kind, 'relation')
  const raw = itemReadRawDef(root, kind, name)
  const existing = itemObjectArray(raw, field)
  // In-order duplicate semantics, mirroring the removal paths and
  // addItemAliases: the first structural occurrence does the adding, repeats
  // read as idempotent, and only the first row reports a dim_table's lift.
  let next = existing
  const existingSup = itemStringArray(raw, supField)
  const supSeen = new Set(existingSup)
  const results: AddVerdict[] = joins.map(rel => {
    const alreadyPresent = next.some(e => itemMatchesRelation(e, rel))
    const wasVetoed = supSeen.has(rel.dim_table)
    if (!alreadyPresent) next = [...next, { dim_table: rel.dim_table, join_keys: rel.join_keys }]
    if (wasVetoed) supSeen.delete(rel.dim_table)
    return { key: rel.dim_table, outcome: !alreadyPresent || wasVetoed ? 'added' : 'idempotent', unsuppressed: wasVetoed }
  })
  // `supSeen` holds the still-suppressed keys (each lift removes its key as
  // it happens), so what survives IS the next suppression list.
  const nextSup = existingSup.filter(k => supSeen.has(k))
  const updates: Record<string, unknown> = { [field]: next }
  if (suppressionJoinsUpdate(raw, supField, existingSup, nextSup)) {
    updates[supField] = nextSup
  }
  const version = await applyUpdate(kind, name, updates, expectedVersion)
  return { results, version }
}

/**
 * Remove relations from a table or event, routing the veto by the removed
 * entries' origin (#37 §1 / ADR-0010 ruling 3).
 *
 * Origin routing:
 * - **Machine-derived** (`origin === 'deterministic' | 'llm'`): removal records
 *   a persistent suppression for that `dim_table` — enrichment rounds will
 *   never re-derive the join.
 * - **Curated** (`origin === 'manual'` or absent — hand-added or agent-asserted):
 *   pure content correction, no veto. If the deterministic round CAN re-derive
 *   the join, it comes back in the same call (`reasserted: true`). Remove it
 *   again and THAT removal vetoes it (the "two-step dance").
 * - **Absent** (ensure-absent): removal records the veto — pre-vetoing a
 *   dim_table known to be noise, regardless of whether a relation exists now.
 *
 * Per-item verdicts carry three facts: `outcome`, `suppressed` (did THIS call
 * record the veto), and `reasserted` (did the same write's on-write hook
 * immediately re-derive it).
 * @param root - the semantic-layer scope root this write targets.
 * @param applyUpdate - the Core's `applyItemUpdate` (audited kind dispatch, throws on failure).
 * @param kind - `'table'`, `'event'` (join-shaped relations), or `'concept'` (concept-side edges).
 * @param name - the table_name / event / concept name.
 * @param relations - the relations to remove — joins (structural identity match) or same-shape concept edges; the two shapes cannot mix in one call.
 * @param expectedVersion - the sha256 fingerprint from `get_definition`.
 * @returns per-item verdicts, plus the written file's `version` fingerprint
 *   (the HOME concept for a concept-edge batch, the subject for joins; #108).
 * @throws Error when the target definition does not exist.
 * @throws StaleBaselineError when the fingerprint mismatches.
 */
export async function removeItemRelations(
  root: string,
  applyUpdate: ApplyItemUpdate,
  kind: ItemKind,
  name: string,
  relations: readonly RelationInput[],
  expectedVersion: string,
): Promise<{ readonly results: readonly ItemVerdict[]; readonly version: string }> {
  // Partition first (Q4(b)): one call carries one shape — the helper refuses
  // the mix; a concept-edge batch routes to the concept path, everything else
  // (joins only, by the mix rule) falls through to the join path.
  const { edges, joins } = partitionItemRelations(relations, 'remove_relation')
  if (edges.length > 0) {
    return removeItemConceptEdges(root, applyUpdate, kind, name, edges, expectedVersion)
  }
  if (kind === 'concept') {
    throw new Error('join-shaped relations (dim_table + join_keys) are not supported for concepts — a concept declares entity-layer edges with target_kind instead (Q4(b))')
  }
  const field = itemRelationFieldName(kind)
  const supField = itemSuppressionFieldName(kind, 'relation')
  const raw = itemReadRawDef(root, kind, name)
  const existing = itemObjectArray(raw, field)
  const next = existing.filter(e => !joins.some(r => itemMatchesRelation(e, r)))
  // Veto side, routed by origin: machine-derived or absent → veto; curated → no veto.
  const existingSup = itemStringArray(raw, supField)
  const items = joins.map(rel => {
    const matches = existing.filter(e => itemMatchesRelation(e, rel))
    const machineDerived = matches.some(e => {
      const origin = (e as { readonly origin?: unknown }).origin
      return origin === 'deterministic' || origin === 'llm'
    })
    return { key: rel.dim_table, present: matches.length > 0, machineDerived }
  })
  // Duplicate dim_tables in one call keep their in-order semantics: only the
  // first passing consultation records the veto — the second sees the key as
  // already suppressed.
  const { nextSup, vetoed } = unionVetoKeys(
    existingSup,
    items,
    item => item.key,
    (item, alreadySuppressed) => (item.machineDerived || !item.present) && !alreadySuppressed,
  )
  const updates: Record<string, unknown> = { [field]: next }
  if (suppressionJoinsUpdate(raw, supField, existingSup, nextSup)) {
    updates[supField] = nextSup
  }
  const version = await applyUpdate(kind, name, updates, expectedVersion)
  // In-lock reassertion check: any ref with this dim_table that survived the
  // write (i.e. the on-write hook re-derived it) marks the dance.
  const afterRefs = itemObjectArray(itemReadRawDef(root, kind, name), field)
  const results: ItemVerdict[] = items.map(item =>
    removalVerdict(item.key, item.present, vetoed.has(item), afterRefs.some(e => (e as { readonly dim_table?: unknown }).dim_table === item.key)),
  )
  return { results, version }
}

// ── Concept-side declared edges (Q4(b) Update / #52) ───────────────────────────
//
// Every declared concept edge has ONE storage home: a concept's own
// `related_refs`. A concept subject stores its edge on itself (概念→概念,
// 概念→表); a table subject's concept-target edge (表→概念) stores on the
// TARGET concept — the table schema has no edge field, and a second storage
// home for the same edge would recreate exactly the one-edge-two-datasets
// shape R3 refused. Consequence the tool layer documents: whenever a
// relation involves a concept, `expected_version` is the fingerprint of the
// CONCEPT file this write modifies (subject concept, or target concept for
// a table subject).

/** Resolve a concept-edge batch's storage home and its stored records (the
 * section note above): a concept subject owns the file and stores each edge's
 * OTHER side; a table subject's whole batch lands on the one shared target
 * concept as a single `table→concept` record. Shared verbatim by the add and
 * remove concept-edge entries — `verbLabel` names the tool in the
 * split-the-call error (the texts differed by that word alone, previously
 * hand-copied per side).
 *
 * `checkTargets` carries the pair's one real asymmetry: adding verifies every
 * declared target exists so a bad key rejects the batch whole (mirroring the
 * join path's per-batch dim check), while removal leaves targets unchecked —
 * an absent target is a not-present verdict, not an error.
 */
function resolveConceptEdgeHome(
  root: string,
  kind: ItemKind,
  name: string,
  edges: readonly ConceptEdgeInput[],
  verbLabel: 'add_relation' | 'remove_relation',
  opts: { readonly checkTargets: boolean },
): { readonly home: string; readonly records: ConceptEdgeRecord[] } {
  if (kind === 'event') {
    throw new Error('concept-target relations are not supported for events — the legal concept-side edges are concept→concept, concept→table, and table→concept (Q4(b))')
  }
  if (kind === 'concept') {
    if (opts.checkTargets) {
      for (const e of edges) {
        if (e.target_kind === 'concept' && loadConceptDefinitionFromLayer(root, e.name) === null) {
          throw new Error(`Concept not found: ${e.name}`)
        }
        if (e.target_kind === 'table' && loadTableDefinitionFromLayer(root, e.name) === null) {
          throw new Error(`Table not found: ${e.name}`)
        }
      }
    }
    return { home: name, records: edges.map(e => ({ target_kind: e.target_kind, target: e.name })) }
  }
  if (loadTableDefinitionFromLayer(root, name) === null) throw new Error(`Table not found: ${name}`)
  const targets = new Set(edges.map(e => e.name))
  if (targets.size !== 1) {
    throw new Error(`${verbLabel} from a table subject takes concept edges that all name the SAME target concept — each target concept is a different file with its own baseline; split the call`)
  }
  const first = edges[0]
  if (first === undefined) throw new Error('empty concept-edge batch')
  const home = first.name
  if (opts.checkTargets && loadConceptDefinitionFromLayer(root, home) === null) throw new Error(`Concept not found: ${home}`)
  return { home, records: [{ target_kind: 'table', target: name }] }
}

/**
 * Add declared concept edges to their home concept, lifting each key's veto
 * if suppressed — the batch form of the add-side dual-field overlay over
 * `related_refs` / `suppressed_related_refs` (#109).
 *
 * One batch touches ONE concept file (Q6): a concept subject's whole batch
 * lands on the subject (its edges may mix target kinds — 概念→概念 and
 * 概念→表 both store on the subject); a table subject's edges must all name
 * the SAME target concept (each target is a different file with its own
 * baseline), enforced with a split-the-call error that rejects the batch
 * whole before any write lands.
 *
 * Existence checks: the subject (concept or table) and — for a declared
 * target — the target concept must both exist; a concept→table edge's
 * target table must exist. Mirrors the join path's per-batch dim check.
 * @param root - the semantic-layer scope root this write targets.
 * @param applyUpdate - the Core's `applyItemUpdate` (audited kind dispatch, throws on failure).
 * @param kind - the SUBJECT kind: `'concept'` (edges land on it) or
 * `'table'` (edges land on the one shared target concept). `'event'` is
 * refused — the Q4(b) edge set is concept→concept / concept→table / table→concept.
 * @param name - the subject concept/table name.
 * @param edges - `{target_kind, name}` edges; for a table subject they must
 *   all name the same target concept.
 * @param expectedVersion - the sha256 fingerprint of the CONCEPT file this
 *   write modifies (the home concept — see the section note above).
 * @returns per-item verdicts, plus the home concept file's `version`
 *   fingerprint after this write (#108) — the same file the caller's
 *   `expected_version` named.
 * @throws Error when the subject or a declared target does not exist, when
 *   `kind === 'event'`, or when a table subject's edges name more than one
 *   target concept.
 * @throws StaleBaselineError when the fingerprint mismatches.
 */
async function addItemConceptEdges(
  root: string,
  applyUpdate: ApplyItemUpdate,
  kind: ItemKind,
  name: string,
  edges: readonly ConceptEdgeInput[],
  expectedVersion: string,
): Promise<{ readonly results: readonly AddVerdict[]; readonly version: string }> {
  // Adding checks every declared target (the helper's `checkTargets: true`) —
  // a bad key rejects the batch whole before any write lands.
  const { home, records } = resolveConceptEdgeHome(root, kind, name, edges, 'add_relation', { checkTargets: true })
  const raw = itemReadRawDef(root, 'concept', home)
  const existing = itemObjectArray(raw, 'related_refs')
  // In-order duplicate semantics: the first structural occurrence appends,
  // repeats read as idempotent, and only the first row reports a key's lift
  // (structural identity: target_kind + target — order-free, unlike joins).
  let next = existing
  const supField = 'suppressed_related_refs'
  const existingSup = itemStringArray(raw, supField)
  const supSeen = new Set(existingSup)
  const results: AddVerdict[] = records.map(record => {
    const key = conceptEdgeKey(record)
    const alreadyPresent = next.some(e => itemMatchesConceptEdge(e, record))
    const wasVetoed = supSeen.has(key)
    if (!alreadyPresent) next = [...next, record]
    if (wasVetoed) supSeen.delete(key)
    return { key, outcome: !alreadyPresent || wasVetoed ? 'added' : 'idempotent', unsuppressed: wasVetoed }
  })
  const nextSup = existingSup.filter(k => supSeen.has(k))
  const updates: Record<string, unknown> = { related_refs: next }
  if (suppressionJoinsUpdate(raw, supField, existingSup, nextSup)) {
    updates[supField] = nextSup
  }
  const version = await applyUpdate('concept', home, updates, expectedVersion)
  return { results, version }
}

/**
 * Remove declared concept edges from their home concept, routing the veto by
 * the stored entries' origin — `removeRelations`' exact semantics over
 * `related_refs` / `suppressed_related_refs`.
 *
 * One call touches ONE concept file: a concept subject's whole batch lands
 * on the subject; a table subject's edges must all name the same target
 * concept (in practice one — each target is a different file with its own
 * baseline), which is enforced with a split-the-call error.
 *
 * `reasserted` is always `false`: concepts have no enrichment rounds, so no
 * on-write hook can re-derive a just-removed edge — the verdict field stays
 * (receipt shape parity with the table/event path) and says so honestly.
 * @param root - the semantic-layer scope root this write targets.
 * @param applyUpdate - the Core's `applyItemUpdate` (audited kind dispatch, throws on failure).
 * @param kind - the SUBJECT kind (`'event'` refused, as `addItemConceptEdge`).
 * @param name - the subject concept/table name.
 * @param edges - the edges to remove (structural identity: target_kind + target).
 * @param expectedVersion - the sha256 fingerprint of the home CONCEPT file.
 * @returns per-item verdicts, plus the home concept file's `version`
 *   fingerprint after this write (#108).
 * @throws Error when the subject does not exist, when `kind === 'event'`,
 *   or when a table subject's edges name more than one target concept.
 * @throws StaleBaselineError when the fingerprint mismatches.
 */
async function removeItemConceptEdges(
  root: string,
  applyUpdate: ApplyItemUpdate,
  kind: ItemKind,
  name: string,
  edges: readonly ConceptEdgeInput[],
  expectedVersion: string,
): Promise<{ readonly results: readonly ItemVerdict[]; readonly version: string }> {
  // Removal leaves targets unchecked (`checkTargets: false`) — an absent
  // target is a not-present verdict, not an error.
  const { home, records } = resolveConceptEdgeHome(root, kind, name, edges, 'remove_relation', { checkTargets: false })
  const raw = itemReadRawDef(root, 'concept', home)
  const existing = itemObjectArray(raw, 'related_refs')
  const next = existing.filter(e => !records.some(r => itemMatchesConceptEdge(e, r)))
  // Veto side, routed by origin — identical to the table/event path:
  // machine-derived or absent → veto; curated → pure content correction.
  const supField = 'suppressed_related_refs'
  const existingSup = itemStringArray(raw, supField)
  const items = records.map(record => {
    const matches = existing.filter(e => itemMatchesConceptEdge(e, record))
    const machineDerived = matches.some(e => {
      const origin = (e as { readonly origin?: unknown }).origin
      return origin === 'deterministic' || origin === 'llm'
    })
    return { key: conceptEdgeKey(record), present: matches.length > 0, machineDerived }
  })
  // Same in-order duplicate-key semantics as removeItemRelations.
  const { nextSup, vetoed } = unionVetoKeys(
    existingSup,
    items,
    item => item.key,
    (item, alreadySuppressed) => (item.machineDerived || !item.present) && !alreadySuppressed,
  )
  const updates: Record<string, unknown> = { related_refs: next }
  if (suppressionJoinsUpdate(raw, supField, existingSup, nextSup)) {
    updates[supField] = nextSup
  }
  const version = await applyUpdate('concept', home, updates, expectedVersion)
  const results: ItemVerdict[] = items.map(item =>
    // reasserted is always false: concepts have no enrichment rounds — nothing can re-derive a vetoed edge.
    removalVerdict(item.key, item.present, vetoed.has(item), false),
  )
  return { results, version }
}

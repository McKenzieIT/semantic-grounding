/**
 * The data-memory layer's storage, anchor grammar, and in-process incremental
 * anchor index (ADR-0023 / #152; the write-side halves of ADR-0026 / ADR-0027).
 *
 * ## What lives here
 *
 * - **The stored entry shape** (`MemoryEntry` + the lenient read schema): corpus
 *   root `memory/<id>.yaml`, one file per entry, append-only — updates are new
 *   entries carrying `supersedes: [{id, reason}]`, the old file is never touched
 *   (ADR-0023 R2).
 * - **The id mint** (`mem-<YYYYMMDD>-<8 base32>`, ADR-0023 R3): date is the UTC
 *   write day (human-readable only), the 8 random base32 chars carry identity;
 *   creation is exclusive (existsSync re-check, re-mint on the astronomically
 *   unlikely collision).
 * - **The anchor grammar** (ADR-0023 R4): node `table:x` / column fragment
 *   `table:x#col` / edge `<起点id> -<类型>-> <终点id>` in the graph's canonical
 *   logical direction. Bare names are accepted on input wherever a prefix would
 *   be; canonical output always carries the prefix. Write-time existence is
 *   checked against a per-call anchor universe (every registered builtin kind's
 *   nodes, columns, and edges) — including columns (ADR-0026 keeps the R4 rule:
 *   a dangling *new* anchor is refused; only pre-existing entries may dangle).
 * - **The incremental anchor index** (ADR-0023 R1, the mandatory item): one
 *   process-resident index per corpus root. Every query first `stat`s the
 *   memory dir and re-parses ONLY the files whose mtime/size moved — #134's
 *   measurement (5000 entries: 941 ms full read vs 16 ms of stats) is why the
 *   cache exists, and stat-per-call is what lets it see another process's
 *   writes without violating ADR-0015 (nothing here rides the read-epoch memo).
 * - **Write orchestration** (`recordMemoryBatch`): whole-batch validation (any
 *   invalid item rejects the batch, naming the 1-based index), deterministic
 *   NOOP (same session + type + anchor set + normalized body), still-valid
 *   neighbors for the receipt, then the writes themselves through the caller's
 *   audited seam (one `beginBatch` commit per call at the MCP layer).
 *
 * Off the public barrel (ADR-0002/0003) — the same split as `item-write.ts` /
 * `enrichment-work.ts`: the Core class's `recordMemories` / `countMemoriesOnEdges`
 * methods are the public route, so the barrel's name-level allow-list does not grow.
 *
 * @module memory (internal; only `"."` is importable — see ADR-0002)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { loadConcepts, loadEvents, loadTables } from './io.ts'

// ── Types ────────────────────────────────────────────────────────────────────────

/** The five memory types (ADR-0021 R9), each with its own promotion exit. */
export type MemoryType = 'observation' | 'caveat' | 'inference' | 'practice' | 'incident'

/** The five type literals, for validation at the edges. */
export const MEMORY_TYPES: readonly MemoryType[] = ['observation', 'caveat', 'inference', 'practice', 'incident']

/** Why one entry supersedes another (ADR-0023 R2): `outdated` (old window still
 * shows in跨期对比) or `wrong` (permanently hidden, never counts as replication). */
export type MemorySupersedeReason = 'outdated' | 'wrong'

/** One `supersedes` declaration on a draft: which entry this one replaces, and why. */
export interface MemorySupersedeRef {
  readonly id: string
  readonly reason: MemorySupersedeReason
}

/** What an agent submits through `record_memory` — everything except the
 * server-owned fields (`id`, `recorded`, `promoted`). Optional fields admit
 * `undefined` explicitly: the MCP layer hands zod-parsed output straight
 * through, and zod infers `field?: T | undefined` (exactOptionalPropertyTypes). */
export interface MemoryDraft {
  readonly type: MemoryType
  readonly anchors: readonly string[]
  readonly body: string
  readonly basis?: string | undefined
  readonly valid_from?: string | undefined
  readonly valid_until?: string | undefined
  readonly supersedes?: readonly MemorySupersedeRef[] | undefined
  readonly contradicts?: readonly string[] | undefined
}

/** The server-written provenance block (ADR-0023 R5) — the agent cannot fill it. */
export interface MemoryRecorded {
  readonly session: string
  readonly agent: string
  readonly at: string
}

/** One stored memory entry (`memory/<id>.yaml`, parsed). `promoted` is the
 * #136 promotion append — read tolerantly here, never written by this module. */
export interface MemoryEntry {
  readonly id: string
  readonly type: MemoryType
  readonly anchors: readonly string[]
  readonly body: string
  readonly basis?: string
  readonly valid_from?: string
  readonly valid_until?: string
  readonly supersedes?: readonly MemorySupersedeRef[]
  readonly contradicts?: readonly string[]
  readonly recorded: MemoryRecorded
  readonly promoted?: readonly unknown[]
}

/** One still-valid same-anchor same-type entry the receipt offers as a neighbor
 * (ADR-0023 R9): its id plus a one-line body excerpt. The per-neighbor judgment
 * guidance text is rendered by the MCP layer from the single-source regimen. */
export interface MemoryNeighbor {
  readonly id: string
  readonly summary: string
}

/** One item's row in a `recordMemories` result. */
export interface MemoryRecordRow {
  /** The item's original `memories` index (0-based), so a caller maps rows back to input. */
  readonly index: number
  /** `recorded` (this call landed a new entry) or `idempotent` (the deterministic
   * NOOP hit — same session + type + anchor set + normalized body; ADR-0023 R9). */
  readonly verdict: 'recorded' | 'idempotent'
  /** The landed entry's id, or the matched existing entry's id on a NOOP. */
  readonly id: string
  /** Still-valid pre-existing same-type entries sharing ≥1 anchor (never the
   * row's own entry; empty when the anchor set is virgin territory). */
  readonly neighbors: readonly MemoryNeighbor[]
}

/** `SemanticGroundingCore.recordMemories`'s result — the #61 domain-failure face:
 * a validation failure is `{ok:false}` naming the 1-based item index (never a
 * throw; nothing was written), while infrastructure failures throw. */
export type RecordMemoriesResult =
  | { readonly ok: true; readonly results: readonly MemoryRecordRow[] }
  | { readonly ok: false; readonly error: string; readonly item_index: number }

/** A structured edge reference for `countMemoriesOnEdges` — from/to are canonical
 * node ids (`table:x` / `event:x` / `concept:x`), already prefixed. */
export interface MemoryEdgeAnchor {
  readonly from: string
  readonly type: string
  readonly to: string
}

// ── Id mint (ADR-0023 R3) ────────────────────────────────────────────────────────

/** `mem-<YYYYMMDD>-<8 lowercase base32>` — the id grammar every consumer matches. */
export const MEMORY_ID_PATTERN = /^mem-\d{8}-[a-z2-7]{8}$/

/** RFC 4648 base32, lowercase, no padding — the id alphabet ADR-0023 R3 names. */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** 8 random base32 chars (40 bits of `randomBytes`). */
function randomBase32Eight(): string {
  const bytes = randomBytes(5)
  let bits = 0n
  for (const b of bytes) bits = (bits << 8n) | BigInt(b)
  let out = ''
  for (let i = 0; i < 8; i++) {
    out += BASE32_ALPHABET[Number(bits & 31n)]
    bits >>= 5n
  }
  return out
}

/**
 * Mint one memory id: `mem-<YYYYMMDD>-<8 base32>`, the date being the UTC day of
 * the call (human-readable only — business validity is `valid_*`, never the id).
 * @param at - the timestamp whose UTC day lands in the id.
 * @returns a fresh id (uniqueness is enforced by the exclusive-create loop at
 *   write time, not by the mint).
 */
export function newMemoryId(at: Date = new Date()): string {
  const y = String(at.getUTCFullYear()).padStart(4, '0')
  const m = String(at.getUTCMonth() + 1).padStart(2, '0')
  const d = String(at.getUTCDate()).padStart(2, '0')
  return `mem-${y}${m}${d}-${randomBase32Eight()}`
}

/** Is `id` a well-formed memory id (the grammar ADR-0023 R3 fixed)? */
export function isMemoryId(id: string): boolean {
  return MEMORY_ID_PATTERN.test(id)
}

// ── Body normalization + excerpts ────────────────────────────────────────────────

/**
 * The deterministic NOOP's body form (ADR-0023 R9's「正文归一」): whitespace runs
 * collapsed to single spaces, trimmed — the same fold `git/message.ts` applies to
 * commit subjects, applied here so a re-wrapped YAML literal is still "the same
 * body" while any wording difference is not.
 */
export function normalizeMemoryBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim()
}

/** A neighbor's one-line excerpt: the normalized body's first 80 chars, visibly
 * truncated. Bound keeps receipts readable when bodies are long. */
function bodySummary(body: string): string {
  const norm = normalizeMemoryBody(body)
  return norm.length <= 80 ? norm : `${norm.slice(0, 79)}…`
}

// ── The lenient read shape (index loads) ─────────────────────────────────────────

/** Read one `memory/<id>.yaml` leniently — a broken or non-object file is skipped
 * (never poisons its siblings), same rule every loader in io.ts follows. */
function parseMemoryFile(path: string): MemoryEntry | null {
  let raw: unknown
  try {
    raw = yaml.load(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const { id, type, body } = r as { id?: unknown; type?: unknown; body?: unknown }
  if (typeof id !== 'string' || !isMemoryId(id)) return null
  if (typeof type !== 'string' || !(MEMORY_TYPES as readonly string[]).includes(type)) return null
  if (typeof body !== 'string') return null
  const anchors = Array.isArray(r.anchors) ? r.anchors.filter((a): a is string => typeof a === 'string') : []
  if (anchors.length === 0) return null
  const recorded = r.recorded
  if (typeof recorded !== 'object' || recorded === null) return null
  const rec = recorded as Record<string, unknown>
  if (typeof rec.session !== 'string' || typeof rec.agent !== 'string' || typeof rec.at !== 'string') return null
  return {
    id,
    type: type as MemoryType,
    anchors,
    body,
    ...typeof r.basis === 'string' ? { basis: r.basis } : {},
    ...typeof r.valid_from === 'string' ? { valid_from: r.valid_from } : {},
    ...typeof r.valid_until === 'string' ? { valid_until: r.valid_until } : {},
    ...Array.isArray(r.supersedes) ? { supersedes: r.supersedes.filter((s): s is MemorySupersedeRef =>
      typeof s === 'object' && s !== null && typeof (s as MemorySupersedeRef).id === 'string' && typeof (s as MemorySupersedeRef).reason === 'string') } : {},
    ...Array.isArray(r.contradicts) ? { contradicts: r.contradicts.filter((c): c is string => typeof c === 'string') } : {},
    recorded: { session: rec.session, agent: rec.agent, at: rec.at },
    ...Array.isArray(r.promoted) ? { promoted: r.promoted } : {},
  }
}

// ── The incremental anchor index (ADR-0023 R1) ───────────────────────────────────

/** Test-only parse counter (io-probes.ts's shape): measures how many YAML files
 * a code path actually re-parses, so the「只重解析变化文件」property is pinned by
 * a test rather than trusted. NOT exported from index.ts. */
let _memoryParses = 0
/** Test-only stat counter: `stat` calls per refresh (the always-paid cost). */
let _memoryStats = 0

/** Reset the test-only counters (spec-side). */
export function _memoryIndexProbeReset(): void {
  _memoryParses = 0
  _memoryStats = 0
}

/** Read the test-only counters (spec-side). */
export function _memoryIndexProbeCounts(): { parses: number; stats: number } {
  return { parses: _memoryParses, stats: _memoryStats }
}

/** One cached file: its stat fingerprint plus the parsed entry (null = unparsable). */
interface MemoryFileStamp {
  readonly mtimeMs: number
  readonly size: number
  readonly entry: MemoryEntry | null
}

/**
 * The process-resident anchor index over one corpus root's `memory/` dir
 * (ADR-0023 R1's mandatory incremental cache). Callers never construct one —
 * {@link memoryAnchorIndexFor} hands back the per-root singleton, so every
 * consumer in the process (the write path, the ADR-0026 dangling counts, and
 * later the read surface #154 / promotion guard #136) shares one stat budget.
 *
 * Refresh contract: every query path calls {@link refresh} first — `stat` each
 * file, re-parse only what moved (mtimeMs+size fingerprint), drop what vanished.
 * Cross-process visibility is exactly the stat: another process's write shows
 * up on the next refresh with no version counter in between (ADR-0015's
 * read-epoch memo is deliberately NOT consulted — memory reads are not
 * tables/events loader reads, and the epoch would only add staleness).
 */
export class MemoryAnchorIndex {
  private readonly stamps = new Map<string, MemoryFileStamp>()
  private readonly byId = new Map<string, MemoryEntry>()
  private readonly idsByAnchor = new Map<string, Set<string>>()
  /** Entries superseded with `wrong` — permanently hidden (ADR-0023 R2). */
  private readonly wrongHidden = new Set<string>()
  /** Live `contradicts` pairs, both directions (ADR-0027 R4's 双向现算). */
  private readonly contestedWith = new Map<string, Set<string>>()

  /**
   * Stat the memory dir and absorb what changed. Cheap by construction: the
   * per-call cost is one `stat` per file (16 ms at 5000, #134) and parses only
   * for new/moved files.
   * @param root - the corpus root (the dir holding `memory/`).
   * @returns whether anything changed (derived views were rebuilt).
   */
  refresh(root: string): boolean {
    const dir = join(root, 'memory')
    let names: string[] = []
    if (existsSync(dir)) {
      try {
        names = readdirSync(dir).filter(f => f.endsWith('.yaml'))
      } catch {
        names = []
      }
    }
    const present = new Set(names)
    let changed = false
    for (const name of [...this.stamps.keys()]) {
      if (!present.has(name)) {
        this.stamps.delete(name)
        changed = true
      }
    }
    for (const name of names) {
      const path = join(dir, name)
      let mtimeMs: number
      let size: number
      try {
        _memoryStats += 1
        const st = statSync(path)
        mtimeMs = st.mtimeMs
        size = st.size
      } catch {
        continue // raced away between readdir and stat — next refresh retries
      }
      const prev = this.stamps.get(name)
      if (prev !== undefined && prev.mtimeMs === mtimeMs && prev.size === size) continue
      _memoryParses += 1
      this.stamps.set(name, { mtimeMs, size, entry: parseMemoryFile(path) })
      changed = true
    }
    if (changed) this.rebuildDerived()
    return changed
  }

  /** Recompute the derived views from the cached entries — map-building over
   * in-memory data (µs at thousands of entries; #134 measured the cost in file
   * opens, not maps), so correctness never needs incremental map surgery. */
  private rebuildDerived(): void {
    this.byId.clear()
    this.idsByAnchor.clear()
    this.wrongHidden.clear()
    this.contestedWith.clear()
    for (const { entry } of this.stamps.values()) {
      if (entry === null) continue
      this.byId.set(entry.id, entry)
    }
    // wrong-hidden first: an entry any other entry supersedes with reason
    // `wrong` is permanently out (ADR-0023 R2). Single level by design — the
    // write path only ever names real ids, and a wrong→wrong chain is dead
    // territory either way.
    for (const entry of this.byId.values()) {
      for (const s of entry.supersedes ?? []) {
        if (s.reason === 'wrong') this.wrongHidden.add(s.id)
      }
    }
    for (const entry of this.byId.values()) {
      for (const anchor of entry.anchors) {
        let ids = this.idsByAnchor.get(anchor)
        if (ids === undefined) {
          ids = new Set<string>()
          this.idsByAnchor.set(anchor, ids)
        }
        ids.add(entry.id)
      }
    }
    // Live contested pairs: both ends exist, neither wrong-hidden (ADR-0027
    // R4 — a partner hidden by wrong dissolves the pair).
    for (const entry of this.byId.values()) {
      if (this.wrongHidden.has(entry.id)) continue
      for (const other of entry.contradicts ?? []) {
        if (other === entry.id) continue
        if (!this.byId.has(other) || this.wrongHidden.has(other)) continue
        let mine = this.contestedWith.get(entry.id)
        if (mine === undefined) {
          mine = new Set<string>()
          this.contestedWith.set(entry.id, mine)
        }
        mine.add(other)
        let theirs = this.contestedWith.get(other)
        if (theirs === undefined) {
          theirs = new Set<string>()
          this.contestedWith.set(other, theirs)
        }
        theirs.add(entry.id)
      }
    }
  }

  /** One entry by id, or undefined. */
  get(id: string): MemoryEntry | undefined {
    return this.byId.get(id)
  }

  /** Is this id permanently hidden (superseded `wrong`)? */
  isWrongHidden(id: string): boolean {
    return this.wrongHidden.has(id)
  }

  /** The entry's live contested partners (ADR-0027 R4's `contested_with`). */
  contestedWithOf(id: string): readonly string[] {
    return [...this.contestedWith.get(id) ?? []]
  }

  /**
   * The still-valid (non-wrong-hidden) entries anchored on ANY of `anchors`.
   * @param anchors - canonical anchor strings.
   */
  validEntriesAnchoredOnAny(anchors: readonly string[]): readonly MemoryEntry[] {
    const out: MemoryEntry[] = []
    const seen = new Set<string>()
    for (const anchor of anchors) {
      for (const id of this.idsByAnchor.get(anchor) ?? []) {
        if (this.wrongHidden.has(id) || seen.has(id)) continue
        seen.add(id)
        const entry = this.byId.get(id)
        if (entry !== undefined) out.push(entry)
      }
    }
    return out
  }

  /**
   * The deterministic NOOP's match (ADR-0023 R9): same session + same type +
   * same anchor set + same normalized body, among entries still visible. A
   * wrong-superseded identical entry does NOT match — re-asserting content that
   * was declared wrong is a new recording, not a no-op.
   * @param session - the calling session (recorded.session).
   * @param type - the draft's type.
   * @param anchors - the draft's canonical anchors.
   * @param bodyNorm - the draft's normalized body.
   */
  findIdempotent(session: string, type: MemoryType, anchors: readonly string[], bodyNorm: string): MemoryEntry | undefined {
    const wanted = [...anchors].sort().join('\u0000')
    for (const entry of this.validEntriesAnchoredOnAny(anchors)) {
      if (entry.type !== type) continue
      if (entry.recorded.session !== session) continue
      if (normalizeMemoryBody(entry.body) !== bodyNorm) continue
      if ([...entry.anchors].sort().join('\u0000') !== wanted) continue
      return entry
    }
    return undefined
  }
}

/** The per-root singleton index registry — one stat budget per corpus per process. */
const indexes = new Map<string, MemoryAnchorIndex>()

/**
 * The process-resident anchor index for one corpus root (creating it on first
 * use). Every consumer in the process shares the instance, which is what makes
 * the incremental cache pay for itself (ADR-0023 R1).
 * @param root - the corpus root (the dir holding `memory/`).
 */
export function memoryAnchorIndexFor(root: string): MemoryAnchorIndex {
  let index = indexes.get(root)
  if (index === undefined) {
    index = new MemoryAnchorIndex()
    indexes.set(root, index)
  }
  return index
}

// ── The anchor universe (write-time existence checks, ADR-0023 R4) ───────────────

/** Node-id prefixes the builtin kinds mint (`<kind>:<名>`, ADR-0023 R4). */
const NODE_PREFIXES: readonly string[] = ['table:', 'event:', 'concept:', 'metric:']

/**
 * Everything a write-time anchor check needs, derived per call from the same
 * loaders the graph build reads: every node id (incl. derived `metric:` nodes),
 * every column/param name per node, and every canonical edge string.
 *
 * The edge set mirrors `SemanticGroundingCore.buildGraph`'s canonical
 * direction: asset→dim (`joins`), concept→target (`related_to`, from
 * `related_refs`), and group→member (`concept:<domain> -related_to-> <asset>`,
 * from `domains`). Drift between the two derivations would surface as an
 * anchor that validates here but not in the graph (or vice versa) — kept in
 * one comment's reach rather than refactoring buildGraph open (minimal change;
 * reopening the build seam is #154's call if the read side needs the canonical
 * edge list too).
 */
export interface AnchorUniverse {
  readonly nodes: ReadonlySet<string>
  readonly columns: ReadonlyMap<string, ReadonlySet<string>>
  readonly edges: ReadonlySet<string>
}

/** String-string[] helper: read `raw[field]` as string[]. */
function stringArrayField(raw: Readonly<Record<string, unknown>>, field: string): readonly string[] {
  const v = raw[field]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** String keys of an object-valued field (metrics/params_fields), lenient. */
function objectKeysField(raw: Readonly<Record<string, unknown>>, field: string): readonly string[] {
  const v = raw[field]
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.keys(v) : []
}

/** `{name}` entries of an object/array-of-objects field, lenient. */
function nameEntriesField(raw: Readonly<Record<string, unknown>>, field: string): readonly string[] {
  const v = raw[field]
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const e of v) {
    if (typeof e === 'object' && e !== null) {
      const name = (e as { readonly name?: unknown }).name
      if (typeof name === 'string') out.push(name)
    } else if (typeof e === 'string') {
      out.push(e)
    }
  }
  return out
}

/**
 * Build the anchor universe for one corpus root — the write door's existence
 * check (ADR-0023 R4: anchors, columns included, must exist at write time).
 * Full-scan per call, like every other write-path read.
 * @param root - the corpus root.
 */
export function buildAnchorUniverse(root: string): AnchorUniverse {
  const nodes = new Set<string>()
  const columns = new Map<string, Set<string>>()
  const edges = new Set<string>()
  const addColumns = (node: string, names: readonly string[]): void => {
    let set = columns.get(node)
    if (set === undefined) {
      set = new Set<string>()
      columns.set(node, set)
    }
    for (const n of names) set.add(n)
  }
  // Concepts first: their names are the groups `domains` resolve against
  // (buildGraph skips a domain naming no concept — a dangling domain ref
  // contributes NO edge here either, so the universe never validates an
  // anchor to a group that does not exist).
  const conceptNames = new Set<string>()
  for (const c of loadConcepts(root)) {
    conceptNames.add(c.name)
    const node = `concept:${c.name}`
    nodes.add(node)
    for (const ref of c.raw.related_refs !== undefined && Array.isArray(c.raw.related_refs) ? c.raw.related_refs : []) {
      if (typeof ref === 'object' && ref !== null) {
        const r = ref as { readonly target_kind?: unknown; readonly target?: unknown; readonly name?: unknown }
        const kind = r.target_kind === 'concept' ? 'concept' : r.target_kind === 'table' ? 'table' : undefined
        const name = typeof r.target === 'string' ? r.target : typeof r.name === 'string' ? r.name : undefined
        if (kind !== undefined && name !== undefined) edges.add(`${node} -related_to-> ${kind}:${name}`)
      }
    }
  }
  for (const t of loadTables(root)) {
    const node = `table:${t.table_name}`
    nodes.add(node)
    addColumns(node, nameEntriesField(t.raw, 'columns'))
    addColumns(node, nameEntriesField(t.raw, 'partitions'))
    for (const key of objectKeysField(t.raw, 'metrics')) nodes.add(`metric:${t.table_name}__${key}`)
    for (const ref of t.raw.dimension_refs !== undefined && Array.isArray(t.raw.dimension_refs) ? t.raw.dimension_refs : []) {
      if (typeof ref === 'object' && ref !== null) {
        const dim = (ref as { readonly dim_table?: unknown }).dim_table
        if (typeof dim === 'string') edges.add(`${node} -joins-> table:${dim}`)
      }
    }
    for (const d of stringArrayField(t.raw, 'domains')) {
      if (conceptNames.has(d)) edges.add(`concept:${d} -related_to-> ${node}`)
    }
  }
  for (const e of loadEvents(root)) {
    const node = `event:${e.name}`
    nodes.add(node)
    addColumns(node, objectKeysField(e.raw, 'params_fields'))
    for (const key of objectKeysField(e.raw, 'metrics')) nodes.add(`metric:${e.name}__${key}`)
    for (const ref of e.raw.external_refs !== undefined && Array.isArray(e.raw.external_refs) ? e.raw.external_refs : []) {
      if (typeof ref === 'object' && ref !== null) {
        const dim = (ref as { readonly dim_table?: unknown }).dim_table
        if (typeof dim === 'string') edges.add(`${node} -joins-> table:${dim}`)
      }
    }
    for (const d of stringArrayField(e.raw, 'domains')) {
      if (conceptNames.has(d)) edges.add(`concept:${d} -related_to-> ${node}`)
    }
  }
  return { nodes, columns, edges }
}

/** Why an anchor did not resolve — the two failure modes a caller names differently. */
export type AnchorResolution =
  | { readonly ok: true; readonly anchor: string }
  | { readonly ok: false; readonly reason: 'not_found' | 'ambiguous'; readonly detail: string }

/** Resolve one bare node name against the universe: prefixed passes through when
 * it names a node; bare tries every kind prefix and must land on exactly one. */
function resolveNode(raw: string, universe: AnchorUniverse): { readonly node: string | null; readonly ambiguous: boolean } {
  if (raw.includes(':')) return { node: universe.nodes.has(raw) ? raw : null, ambiguous: false }
  const hits = NODE_PREFIXES.map(p => `${p}${raw}`).filter(id => universe.nodes.has(id))
  if (hits.length > 1) return { node: null, ambiguous: true }
  return { node: hits[0] ?? null, ambiguous: false }
}

/** The edge anchor's exact grammar: `<起点id> -<类型>-> <终点id>` (spaces around
 * the bracketed type, ADR-0023 R4's literal spelling). */
const EDGE_ANCHOR_PATTERN = /^(\S+)\s+-(\S+)->\s+(\S+)$/

/**
 * Canonicalize one anchor spelling against the universe (ADR-0023 R4): node /
 * `node#column` / edge, bare names tolerated on input, canonical output always
 * prefixed. Existence is part of resolution — a node, column, or edge that is
 * not in the universe does not resolve (`not_found`), and a bare name matching
 * nodes of two kinds is `ambiguous` (the mapping would silently route the
 * anchor to the wrong node, the exact failure R4's unified ids retired).
 * @param raw - the anchor as the agent wrote it.
 * @param universe - the write door's existence universe.
 */
export function canonicalizeAnchor(raw: string, universe: AnchorUniverse): AnchorResolution {
  const edgeMatch = EDGE_ANCHOR_PATTERN.exec(raw)
  if (edgeMatch !== null) {
    const from = resolveNode(edgeMatch[1] as string, universe)
    const to = resolveNode(edgeMatch[3] as string, universe)
    if (from.ambiguous || to.ambiguous) {
      return { ok: false, reason: 'ambiguous', detail: `bare endpoint matches nodes of more than one kind: ${raw}` }
    }
    if (from.node === null || to.node === null) {
      return { ok: false, reason: 'not_found', detail: `edge endpoint is not a node in the current graph: ${raw}` }
    }
    const anchor = `${from.node} -${edgeMatch[2]}-> ${to.node}`
    if (!universe.edges.has(anchor)) {
      return { ok: false, reason: 'not_found', detail: `edge does not exist in the current graph (canonical direction is <起点id> -<类型>-> <终点id>): ${raw}` }
    }
    return { ok: true, anchor }
  }
  const hashAt = raw.indexOf('#')
  if (hashAt > 0) {
    const nodePart = raw.slice(0, hashAt)
    const column = raw.slice(hashAt + 1)
    const resolved = resolveNode(nodePart, universe)
    if (resolved.ambiguous) return { ok: false, reason: 'ambiguous', detail: `bare node name matches more than one kind: ${raw}` }
    if (resolved.node === null) return { ok: false, reason: 'not_found', detail: `anchor names no node in the current graph: ${raw}` }
    const cols = universe.columns.get(resolved.node)
    if (cols === undefined || !cols.has(column)) {
      return { ok: false, reason: 'not_found', detail: `column "${column}" does not exist on ${resolved.node}: ${raw}` }
    }
    return { ok: true, anchor: `${resolved.node}#${column}` }
  }
  const resolved = resolveNode(raw, universe)
  if (resolved.ambiguous) return { ok: false, reason: 'ambiguous', detail: `bare name matches nodes of more than one kind: ${raw}` }
  if (resolved.node === null) return { ok: false, reason: 'not_found', detail: `anchor names no node in the current graph: ${raw}` }
  return { ok: true, anchor: resolved.node }
}

// ── Draft validation (ADR-0023 R7 + ADR-0026 R6 + ADR-0027 R3/R5) ───────────────

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Validate one draft's shape and per-type required/forbidden fields (ADR-0023
 * R7): incident/observation need the closed `valid_*` window; practice needs
 * `basis` and may carry only `valid_from`; inference needs `basis` and no
 * `valid_*`; caveat carries no `valid_*`. Structural checks only — anchor and
 * cross-entry checks need the universe/index and live one level up.
 * @param draft - the agent-submitted item.
 * @returns the first problem found, or undefined when the shape is legal.
 */
export function validateMemoryDraftShape(draft: MemoryDraft): string | undefined {
  // Structural floor for direct (non-MCP) callers — the tool schema already
  // guarantees these on the wire, but this module's contract stands alone.
  if (!(MEMORY_TYPES as readonly string[]).includes(draft.type)) {
    return `type must be one of ${MEMORY_TYPES.join(' / ')}, got "${String(draft.type)}"`
  }
  if (draft.anchors.length === 0) return 'anchors must carry at least one anchor (ADR-0023 R7)'
  const t = draft.type
  if (t === 'incident' || t === 'observation') {
    if (draft.valid_from === undefined) return `type "${t}" requires valid_from (a closed business-time window, ds granularity)`
    if (draft.valid_until === undefined) return `type "${t}" requires valid_until (a closed business-time window, ds granularity)`
  }
  if (t === 'practice' || t === 'inference') {
    if (draft.basis === undefined || draft.basis.trim() === '') return `type "${t}" requires basis`
  }
  if (t === 'inference' || t === 'caveat') {
    if (draft.valid_from !== undefined || draft.valid_until !== undefined) return `type "${t}" must not carry valid_from/valid_until`
  }
  if (t === 'practice' && draft.valid_until !== undefined) return `type "practice" must not carry valid_until (its only end mechanism is supersede)`
  for (const key of ['valid_from', 'valid_until'] as const) {
    const v = draft[key]
    if (v !== undefined && !DATE_PATTERN.test(v)) return `${key} must be a YYYY-MM-DD business date, got "${v}"`
  }
  return undefined
}

/**
 * The write seam one landed entry goes through — the Core binds this to
 * `writeMemoryYaml` with its Tier-2 recorder (io.ts's audited ceremony), so
 * this module stays free of recorder knowledge (the `applyUpdate` seam's exact
 * split, item-write.ts precedent). Resolves when the file is on disk; a throw
 * aborts the caller's batch (whole-batch rollback lives one level up).
 */
export type MemoryWriteSeam = (id: string, entry: Readonly<Record<string, unknown>>) => Promise<void>

/**
 * Record a batch of memory entries against one corpus root — the orchestration
 * behind `SemanticGroundingCore.recordMemories` (ADR-0023 R9 + ADR-0027's
 * write-side halves):
 *
 * 1. refresh the anchor index; build the anchor universe (full scan);
 * 2. validate EVERY item — shape, per-type rules, anchor existence (columns
 *    included), `supersedes` id existence (NO check on the referenced entry's
 *    own anchors, ADR-0026 R6), `contradicts` four checks (exists / not wrong /
 *    not self / no overlap with `supersedes`, ADR-0027 R3), and the contested-
 *    wrong `basis` guard (ADR-0027 R5). The FIRST failure rejects the whole
 *    batch (`item_index` is 1-based) with nothing written;
 * 3. per item: the deterministic NOOP match, then the still-valid neighbors
 *    (same type, ≥1 shared anchor, pre-existing only);
 * 4. write each non-NOOP entry through `write` (sequential; the MCP layer's
 *    `beginBatch` folds them into one commit — a seam throw aborts that batch).
 *
 * @param root - the corpus root (the dir holding `memory/`).
 * @param drafts - the agent-submitted items, in input order.
 * @param opts - the server-written provenance (`session`/`agent` — ADR-0023 R5)
 *   and the audited write seam.
 * @returns per-item rows, or the first item's rejection.
 */
export async function recordMemoryBatch(
  root: string,
  drafts: readonly MemoryDraft[],
  opts: { readonly session: string; readonly agent: string; readonly write: MemoryWriteSeam },
): Promise<RecordMemoriesResult> {
  const index = memoryAnchorIndexFor(root)
  index.refresh(root)
  const universe = buildAnchorUniverse(root)
  const at = new Date().toISOString()

  // ── Phase 1: whole-batch validation, zero writes (整批原子) ─────────────
  const canonicalAnchors: string[][] = []
  for (const [i, draft] of drafts.entries()) {
    const reject = (reason: string): RecordMemoriesResult => ({ ok: false, error: `item ${i + 1}: ${reason}`, item_index: i + 1 })
    const shapeError = validateMemoryDraftShape(draft)
    if (shapeError !== undefined) return reject(shapeError)
    if (draft.body.trim() === '') return reject('body must be a non-empty string')
    const anchors: string[] = []
    const seen = new Set<string>()
    for (const raw of draft.anchors) {
      const resolved = canonicalizeAnchor(raw, universe)
      if (!resolved.ok) return reject(`anchor rejected (${resolved.reason}): ${resolved.detail}`)
      if (seen.has(resolved.anchor)) continue
      seen.add(resolved.anchor)
      anchors.push(resolved.anchor)
    }
    canonicalAnchors.push(anchors)
    for (const s of draft.supersedes ?? []) {
      if (!isMemoryId(s.id)) return reject(`supersedes id "${s.id}" is not a well-formed memory id (mem-<YYYYMMDD>-<8 base32>)`)
      const target = index.get(s.id)
      if (target === undefined) return reject(`supersedes id "${s.id}" does not exist`)
      if (s.reason === 'wrong' && index.contestedWithOf(s.id).length > 0 && (draft.basis === undefined || draft.basis.trim() === '')) {
        return reject(`superseding contested entry "${s.id}" as wrong requires basis (ADR-0027 R5: the adjudication must be traceable to evidence)`)
      }
    }
    for (const c of draft.contradicts ?? []) {
      if (!isMemoryId(c)) return reject(`contradicts id "${c}" is not a well-formed memory id (mem-<YYYYMMDD>-<8 base32>)`)
      const target = index.get(c)
      if (target === undefined) return reject(`contradicts id "${c}" does not exist`)
      if (index.isWrongHidden(c)) return reject(`contradicts id "${c}" is superseded wrong — a hidden entry cannot be contested`)
      if ((draft.supersedes ?? []).some(s => s.id === c)) return reject(`id "${c}" appears in both supersedes and contradicts — replacing and contesting are exclusive (ADR-0027 R3)`)
    }
  }

  // ── Phase 2: NOOP matches + neighbors (from the pre-call snapshot) ──────
  // Rows are staged verdict-first and re-keyed after the writes land, so the
  // minted id of a `recorded` row can join its final shape (the id is only
  // knowable at write time — ADR-0023 R3's exclusive-create loop).
  const staged = drafts.map((draft, i) => {
    const anchors = canonicalAnchors[i] as string[]
    const bodyNorm = normalizeMemoryBody(draft.body)
    const match = index.findIdempotent(opts.session, draft.type, anchors, bodyNorm)
    const neighbors = index
      .validEntriesAnchoredOnAny(anchors)
      .filter(entry => entry.type === draft.type && entry.id !== match?.id)
      // Capped so a hot anchor's receipt stays readable — the read surface
      // (#154) owns full listing; this is the judgment-time channel.
      .slice(0, 8)
      .map(entry => ({ id: entry.id, summary: bodySummary(entry.body) }))
    return { index: i, anchors, match, neighbors, id: undefined as string | undefined }
  })

  // ── Phase 3: the writes (sequential; MCP's beginBatch = one commit) ─────
  const memoryDir = join(root, 'memory')
  for (const item of staged) {
    if (item.match !== undefined) continue
    const draft = drafts[item.index] as MemoryDraft
    const entry: Record<string, unknown> = {
      id: '',
      type: draft.type,
      anchors: item.anchors,
      body: draft.body,
      ...draft.basis !== undefined ? { basis: draft.basis } : {},
      ...draft.valid_from !== undefined ? { valid_from: draft.valid_from } : {},
      ...draft.valid_until !== undefined ? { valid_until: draft.valid_until } : {},
      ...draft.supersedes !== undefined ? { supersedes: draft.supersedes } : {},
      ...draft.contradicts !== undefined ? { contradicts: draft.contradicts } : {},
      recorded: { session: opts.session, agent: opts.agent, at },
    }
    // 独占创建、撞号换号重试 (ADR-0023 R3): mint until the path is free.
    let id = newMemoryId()
    for (let attempts = 0; attempts < 8 && existsSync(join(memoryDir, `${id}.yaml`)); attempts += 1) {
      id = newMemoryId()
    }
    entry.id = id
    await opts.write(id, entry)
    item.id = id
  }

  // The index will re-stat on next use; nothing to do here.
  return {
    ok: true,
    results: staged.map(item => ({
      index: item.index,
      verdict: item.match !== undefined ? 'idempotent' as const : 'recorded' as const,
      id: item.match !== undefined ? item.match.id : item.id as string,
      neighbors: item.neighbors,
    })),
  }
}

/**
 * Count the still-visible memory entries anchored on any of `edges` — the
 * ADR-0026 R5 `dangling_memories` number the three edge-removal receipts
 * carry. Wrong-hidden entries do not count (a permanently hidden entry cannot
 * dangle meaningfully). Distinct entries, so an entry anchored on two dying
 * edges counts once.
 * @param root - the corpus root.
 * @param edges - canonical edge triples (`from`/`to` prefixed node ids).
 */
export function countMemoriesOnEdges(root: string, edges: readonly MemoryEdgeAnchor[]): number {
  if (edges.length === 0) return 0
  const index = memoryAnchorIndexFor(root)
  index.refresh(root)
  const anchors = edges.map(e => `${e.from} -${e.type}-> ${e.to}`)
  return index.validEntriesAnchoredOnAny(anchors).length
}

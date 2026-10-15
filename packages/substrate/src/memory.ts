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
 * - **The replicated-promotion guard** (`checkReplicatedEvidence`) and the
 *   `promoted` back-pointer append (`appendMemoryPromotions`): the server-side
 *   halves of ADR-0021 R5–R7 (#136). The guard verifies what a ③ replication
 *   citation must satisfy machine-checkably (existence, no incidents, no live
 *   contested pairs, ≥2 counting after wrong-exclusion, distinct sessions,
 *   distinct UTC days); the append is R2 append-only's one exception, written
 *   only by the server, in the promoting write's own commit.
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
import { loadConcepts, loadEvents, loadRawDir, loadTables } from './io.ts'
import { QueryDefinitionSchema } from './types.ts'

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
 * #136 promotion back-pointer — server-appended only (ADR-0023 R6), read
 * tolerantly here. */
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
  /** Entries superseded with `outdated` by a still-visible successor — hidden
   * without a query window, shown when the window covers the old segment
   * (ADR-0024 R3). A declaration from a wrong-hidden superseder does not count:
   * a retracted entry cannot keep its predecessor out. */
  private readonly outdatedHidden = new Set<string>()
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
    this.outdatedHidden.clear()
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
      // An outdated supersession only holds while its declaring successor is
      // itself visible — wrong-hiding the successor retracts the claim, and
      // the predecessor comes back (the read regime re-checks windows on top).
      if (this.wrongHidden.has(entry.id)) continue
      for (const s of entry.supersedes ?? []) {
        if (s.reason === 'outdated') this.outdatedHidden.add(s.id)
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

  /** How many parsed entries the index currently holds — the read surface's
   * zero-tax gate (an empty memory dir skips every per-call universe build). */
  size(): number {
    return this.byId.size
  }

  /** Is this id permanently hidden (superseded `wrong`)? */
  isWrongHidden(id: string): boolean {
    return this.wrongHidden.has(id)
  }

  /** Is this id superseded `outdated` by a still-visible successor (hidden
   * without a window, shown when the query window covers its old segment)? */
  isOutdatedHidden(id: string): boolean {
    return this.outdatedHidden.has(id)
  }

  /** Every distinct anchor string some cached entry carries — the site
   * enumerations (dead column fragments, dead edges) read this, since the
   * anchor universe can only enumerate what is ALIVE. */
  allAnchors(): string[] {
    return [...this.idsByAnchor.keys()]
  }

  /** The edge anchors (`<a> -<type-> <b>`) in which `node` names either
   * endpoint — live or dangling; existence is the caller's universe check. */
  edgeAnchorsTouching(node: string): string[] {
    const out: string[] = []
    for (const anchor of this.idsByAnchor.keys()) {
      if (!EDGE_ANCHOR_PATTERN.test(anchor)) continue
      if (anchor.startsWith(`${node} `) || anchor.endsWith(` ${node}`)) out.push(anchor)
    }
    return out
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

/** Node-id prefixes the builtin kinds mint (`<kind>:<名>`, ADR-0023 R4). The
 * verified-query kind (#155 / ADR-0025 R1) mints `query:` — a memory may
 * anchor on a query the same way it anchors on any graph node. */
const NODE_PREFIXES: readonly string[] = ['table:', 'event:', 'concept:', 'metric:', 'query:']

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
  // Verified queries (#155 / ADR-0025 R1): graph nodes like any other kind, so
  // a memory may anchor on `query:<名>`. They contribute no columns and no
  // edges — a query's `uses` are its own forward anchors, validated on the
  // query write path (query.ts), never graph adjacency.
  for (const raw of loadRawDir(root, 'queries')) {
    const r = QueryDefinitionSchema.safeParse(raw)
    if (r.success && r.data !== undefined && typeof r.data.name === 'string') {
      nodes.add(`query:${r.data.name}`)
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
 * the bracketed type, ADR-0023 R4's literal spelling). Exported for query.ts,
 * whose read-side `verified_queries` mount parses stored `uses` edge anchors
 * with the same grammar. */
export const EDGE_ANCHOR_PATTERN = /^(\S+)\s+-(\S+)->\s+(\S+)$/

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
function validateMemoryDraftShape(draft: MemoryDraft): string | undefined {
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

// ── The replicated-promotion guard + back-pointer append (#136) ──────────────────
// ADR-0021 R5–R7 (as amended by ADR-0023 R5 and ADR-0027 R6): promotion is an
// ordinary Tier-2 write declaring its evidence; the ③ replicated arm cites
// memory ids and the SERVER verifies the replication before the write may
// land, then appends the `promoted` back-pointer onto every cited entry in the
// same commit (ADR-0023 R6 — the only sanctioned edit to a written memory
// file, server-only). ① source / ② user-stated touch neither half: they are
// decisive evidence on their own and cite nothing.

/** Why a replicated-evidence citation was refused — each reason names its own
 * remedy in the error text, so the calling agent can act on it. */
export type ReplicationFailureReason = 'not_found' | 'incident' | 'contested' | 'too_few' | 'same_session' | 'same_day'

/** `checkReplicatedEvidence`'s result: the counting (effective) cited ids on
 * success, or the first refusal and its actionable message. */
export type ReplicationCheckResult =
  | { readonly ok: true; readonly effective: readonly string[] }
  | { readonly ok: false; readonly reason: ReplicationFailureReason; readonly error: string }

/**
 * A cited `recorded.at`'s UTC day — the unit ADR-0021 R6's「不同日期」counts
 * in. `recorded.at` is server-written ISO, so the parse always succeeds in
 * practice; the raw-string fallback keeps a hand-edited file from throwing on
 * a comparison that only needs day granularity.
 */
function utcDayOf(at: string): string {
  const t = Date.parse(at)
  return Number.isNaN(t) ? at.slice(0, 10) : new Date(t).toISOString().slice(0, 10)
}

/**
 * The server-side replication guard (ADR-0021 R6 as revised by ADR-0023 R5,
 * plus ADR-0021 R7's incident ban and ADR-0027 R6's contested ban) — the one
 * check ③ replicated promotion does not take on trust:
 *
 * 1. every cited id must be a well-formed, existing memory;
 * 2. no cited entry may be an `incident` (ADR-0021 R7 — incidents never
 *    promote, whatever else cites them);
 * 3. no cited entry may carry a still-live `contested_with` pair (ADR-0027
 *    R6 — name the pair, tell the caller to adjudicate first; only the cited
 *    entries are examined, never the whole anchor);
 * 4. citations superseded `wrong` do not COUNT (ADR-0021's 2026-10-14 update)
 *    — they are dropped, not rejected, and the survivors must still be ≥2;
 * 5. the counting entries' `recorded.session` values must be pairwise
 *    distinct, and their `recorded.at` UTC days pairwise distinct too.
 *
 * 「结论相同」stays the citing agent's judgment (ADR-0027 R1 — the server
 * never reads bodies for meaning); this guard verifies only what is
 * machine-checkable.
 * @param root - the corpus root (the dir holding `memory/`).
 * @param memoryIds - the cited memory ids, in citation order (duplicates collapse).
 * @returns the counting ids, or the first refusal with its actionable message.
 */
export function checkReplicatedEvidence(root: string, memoryIds: readonly string[]): ReplicationCheckResult {
  const index = memoryAnchorIndexFor(root)
  index.refresh(root)
  const cited = [...new Set(memoryIds)]
  for (const id of cited) {
    if (!isMemoryId(id)) {
      return { ok: false, reason: 'not_found', error: `cited memory id "${id}" is not a well-formed memory id (mem-<YYYYMMDD>-<8 base32>) — copy the ids from the receipt or the memory files` }
    }
    const entry = index.get(id)
    if (entry === undefined) {
      return { ok: false, reason: 'not_found', error: `cited memory "${id}" does not exist in this corpus` }
    }
    if (entry.type === 'incident') {
      return { ok: false, reason: 'incident', error: `cited memory "${id}" is an incident — incidents never promote (ADR-0021 R7); cite the observation/practice entries the conclusion rests on instead` }
    }
    const contested = index.contestedWithOf(id)
    if (contested.length > 0) {
      return { ok: false, reason: 'contested', error: `cited memory "${id}" is contested with ${contested.join(', ')} (still-live contradicts pair, ADR-0027 R6) — adjudicate first: supersede the loser as wrong with the required basis, then re-issue the promotion citing the survivor` }
    }
  }
  const excluded = cited.filter(id => index.isWrongHidden(id))
  const effective = cited.filter(id => !index.isWrongHidden(id))
  if (effective.length < 2) {
    return {
      ok: false,
      reason: 'too_few',
      error: `replicated evidence needs at least 2 counting memories; ${excluded.length > 0 ? `of the cited ids ${excluded.join(', ')} ${excluded.length === 1 ? 'is' : 'are'} superseded wrong and never count, and ` : ''}only ${effective.length} ${effective.length === 1 ? 'counts' : 'count'} (ADR-0021 R6)`,
    }
  }
  const bySession = new Map<string, string[]>()
  const byDay = new Map<string, string[]>()
  for (const id of effective) {
    const entry = index.get(id)
    if (entry === undefined) continue // unreachable: effective ⊆ cited, all resolved above
    const sessionIds = bySession.get(entry.recorded.session) ?? []
    sessionIds.push(id)
    bySession.set(entry.recorded.session, sessionIds)
    const day = utcDayOf(entry.recorded.at)
    const dayIds = byDay.get(day) ?? []
    dayIds.push(id)
    byDay.set(day, dayIds)
  }
  for (const [session, ids] of bySession) {
    if (ids.length > 1) {
      return { ok: false, reason: 'same_session', error: `cited memories ${ids.join(', ')} were all recorded in one session ("${session}") — replication requires independent sessions (ADR-0021 R6); cite entries recorded by different sessions` }
    }
  }
  for (const [day, ids] of byDay) {
    if (ids.length > 1) {
      return { ok: false, reason: 'same_day', error: `cited memories ${ids.join(', ')} were all recorded on the same UTC day (${day}) — replication requires different days (ADR-0021 R6)` }
    }
  }
  return { ok: true, effective }
}

/** One promotion back-pointer target: the fact-layer object a replication
 * promoted its conclusion into — `to` only ever names object identity
 * (ADR-0021 R3), a canonical node id or edge string. */
export interface MemoryPromotionAppend {
  readonly id: string
  readonly to: string
}

/**
 * Append the `promoted` back-pointer onto the cited memory files
 * (ADR-0023 R6 — R2 append-only's ONE exception, and the only write to an
 * already-written memory file the server performs): each cited entry gains
 * `{to, at, session}` per promotion target, in one read-append-write per file
 * through the caller's audited seam — inside an open `beginBatch` the writes
 * are absorbed, so the promotion commit carries both the fact-layer write and
 * every back-pointer (the "same commit" the ruling asks for).
 *
 * The caller runs {@link checkReplicatedEvidence} first and passes its
 * `effective` ids — a wrong-hidden citation gets no back-pointer (it did not
 * count). Nothing is re-validated here; the ids were just verified.
 * @param root - the corpus root (the dir holding `memory/`).
 * @param appends - the (id, to) pairs to append, in order.
 * @param opts - the promoting session (server-written) and the audited write seam.
 */
export async function appendMemoryPromotions(
  root: string,
  appends: readonly MemoryPromotionAppend[],
  opts: { readonly session: string; readonly write: MemoryWriteSeam },
): Promise<void> {
  if (appends.length === 0) return
  const at = new Date().toISOString()
  const byId = new Map<string, string[]>()
  for (const { id, to } of appends) {
    const tos = byId.get(id) ?? []
    tos.push(to)
    byId.set(id, tos)
  }
  for (const [id, tos] of byId) {
    const path = join(root, 'memory', `${id}.yaml`)
    let raw: unknown
    try {
      raw = yaml.load(readFileSync(path, 'utf-8'))
    } catch (e) {
      throw new Error(`cannot read memory "${id}" to append its promotion back-pointer: ${(e as Error).message}`)
    }
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`memory file "${id}.yaml" is not a YAML mapping; the promotion back-pointer cannot be appended`)
    }
    const entry = raw as Record<string, unknown>
    const promoted = Array.isArray(entry.promoted) ? [...entry.promoted] : []
    for (const to of [...new Set(tos)]) promoted.push({ to, at, session: opts.session })
    entry.promoted = promoted
    await opts.write(id, entry)
  }
  // The anchor index re-stats on next use; nothing to do here (the #152 pattern).
}

// ── The read surface (ADR-0024 R1–R7 / #154 + ADR-0026 R2–R4 + ADR-0027 R4) ──────

/**
 * The query's business-date window (ADR-0024 R2, ds granularity): `from`/`to`
 * are inclusive YYYY-MM-DD bounds of the data the QUESTION is about — never
 * "today", never the ask date.
 */
export interface MemoryDataWindow {
  readonly from: string
  readonly to: string
}

/** One surfaced memory entry — the row every mounted read returns. `body` is
 * the full stored body (ADR-0024 R4: budgets count entries, never truncate
 * text); a promoted entry instead surfaces folded (`promoted: true`, no body,
 * no budget, not counted — R3). `anchor` is the site anchor verbatim (R5):
 * column fragments stay `table:x#col`, edges stay `<起点id> -<类型-> <终点id>`,
 * and a cross-anchor contested partner carries its OWN anchor (ADR-0027 R4). */
export interface MemoryViewEntry {
  readonly id: string
  readonly type: MemoryType
  readonly anchor: string
  /** The full stored body (R4: budgets count entries, never truncate text).
   * Absent exactly on folded promoted rows — reference only. */
  readonly body?: string
  readonly valid_from?: string
  readonly valid_until?: string
  readonly basis?: string
  readonly contested_with?: readonly string[]
  readonly column_missing?: true
  readonly relation_missing?: true
  readonly definition_missing?: true
  readonly promoted?: true
}

/** Per-type counts of visible budgeted entries that did not fit the budget
 * (ADR-0024 R4) — only non-zero types, absent when nothing was dropped. */
export type MemoryTruncatedCounts = Readonly<Record<string, number>>

/** `get_definition`'s mounted view (ADR-0024 R1): the node's own memories
 * (node + column anchors) and the touching edges' memories, two independent
 * budgets (8 / 5 — R4's `dim_server` split: a heavily-joined dimension's edge
 * notes cannot crowd out its own 口径). */
export interface NodeMemoriesView {
  readonly memories: readonly MemoryViewEntry[]
  readonly memories_truncated?: MemoryTruncatedCounts
  readonly edge_memories: readonly MemoryViewEntry[]
  readonly edge_memories_truncated?: MemoryTruncatedCounts
}

/** The not-found path's orphan list (ADR-0026 R3): entries anchored on a
 * definition that no longer exists, each `definition_missing: true`. */
export interface OrphanedMemoriesView {
  readonly orphaned_memories: readonly MemoryViewEntry[]
  readonly orphaned_memories_truncated?: MemoryTruncatedCounts
}

/** One relation-tool edge's mounted view (`get_join_path` / `get_relations`
 * rows, budget 3 per edge). */
export interface EdgeMemoriesView {
  readonly entries: readonly MemoryViewEntry[]
  readonly truncated?: MemoryTruncatedCounts
}

/** One unordered edge reference for the relation tools: `a`/`b` are resolved
 * node ids; the canonical anchor spelling is whichever direction the index
 * holds (the graph is walked undirected, anchors are directional). */
export interface MemoryEdgePair {
  readonly a: string
  readonly b: string
  readonly type: string
}

/**
 * The read budgets — code constants, not config (ADR-0024 R4, on
 * `LIST_DEFINITIONS_CAP`'s precedent): response sizing is a contract.
 */
export const MEMORY_NODE_BUDGET = 8
export const MEMORY_EDGE_BUDGET = 5
export const MEMORY_RELATION_BUDGET = 3

/** Display order within a mounted list (ADR-0024 R4): caveat first (always
 * shown, budget-free — ADR-0021 R8), then the budgeted priority
 * practice > incident > inference > observation. */
const READ_TYPE_ORDER: Readonly<Record<MemoryType, number>> = {
  caveat: 0,
  practice: 1,
  incident: 2,
  inference: 3,
  observation: 4,
}

/** The one visibility regime input the composition needs beyond the index. */
interface ReadRegime {
  readonly index: MemoryAnchorIndex
  readonly window: MemoryDataWindow | undefined
}

/** Do the entry's validity bounds and the query window intersect? Missing
 * bounds are open; YYYY-MM-DD strings compare correctly as code units. */
function segmentsIntersect(from: string | undefined, until: string | undefined, w: MemoryDataWindow): boolean {
  if (until !== undefined && until < w.from) return false
  if (from !== undefined && from > w.to) return false
  return true
}

/**
 * One entry's visibility under the regime (ADR-0024 R3, revised ADR-0021 R9):
 * `hidden` (wrong — excluded before this is even called; or filtered by the
 * window; or an outdated predecessor with no covering window), `folded`
 * (promoted non-empty: always shown as a reference, never budgeted or
 * counted), or `budgeted` (occupies the cap).
 */
function visibilityOf(entry: MemoryEntry, regime: ReadRegime): 'hidden' | 'budgeted' | 'folded' {
  if ((entry.promoted?.length ?? 0) > 0) return 'folded'
  const outdated = regime.index.isOutdatedHidden(entry.id)
  const { window } = regime
  if (window === undefined) return outdated ? 'hidden' : 'budgeted'
  // With a window: incident/observation must intersect it; an outdated
  // predecessor shows when the window reaches into its old segment
  // (跨期对比 — the old 口径 is the right one for the old period).
  if (outdated) return segmentsIntersect(entry.valid_from, entry.valid_until, window) ? 'budgeted' : 'hidden'
  if (entry.type === 'incident' || entry.type === 'observation') {
    return segmentsIntersect(entry.valid_from, entry.valid_until, window) ? 'budgeted' : 'hidden'
  }
  return 'budgeted'
}

/** The entry's contested partners that are themselves visible in this regime
 * (ADR-0027 R4: a partner hidden by wrong or by outdated-in-this-regime
 * dissolves the pair; a partner outside the data window is not pulled). */
function liveContestedOf(entry: MemoryEntry, regime: ReadRegime): readonly MemoryEntry[] {
  const out: MemoryEntry[] = []
  for (const id of regime.index.contestedWithOf(entry.id)) {
    const partner = regime.index.get(id)
    if (partner === undefined) continue
    if (visibilityOf(partner, regime) === 'hidden') continue
    out.push(partner)
  }
  return out
}

/** Sort key half: recency is `valid_until` (missing → `valid_from`), else the
 * recorded date — the "when was this true OF" axis, falling back to "when was
 * it written" (ADR-0024 R4). YYYY-MM-DD vs an ISO date's day prefix compare
 * correctly as code units. */
function recencyKeyOf(entry: MemoryEntry): string {
  return entry.valid_until ?? entry.valid_from ?? entry.recorded.at.slice(0, 10)
}

/** The mounted lists' order: type priority, then recency new→old, then a
 * deterministic id tiebreak. */
function compareForDisplay(a: MemoryEntry, b: MemoryEntry): number {
  const pa = READ_TYPE_ORDER[a.type]
  const pb = READ_TYPE_ORDER[b.type]
  if (pa !== pb) return pa - pb
  const ra = recencyKeyOf(a)
  const rb = recencyKeyOf(b)
  if (ra !== rb) return ra < rb ? 1 : -1
  const aa = a.recorded.at
  const ab = b.recorded.at
  if (aa !== ab) return aa < ab ? 1 : -1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** What one mounting site knows about itself: the anchors that bind entries
 * to it, whether a given anchor's target is still alive (drives `column_missing` /
 * `relation_missing` and the live-anchor preference), the budget, and whether
 * every row is by construction dangling (the orphan list). */
interface MountSite {
  readonly anchors: ReadonlySet<string>
  readonly isLive: (anchor: string) => boolean
  readonly cap: number
  readonly definitionMissing?: boolean
}

/** The anchor an entry surfaces with at this site (ADR-0024 R5): among the
 * entry's anchors that bind to the site, prefer a LIVE column fragment (most
 * specific, R5's own example shape), then any live anchor, then dead ones —
 * stored order within a tier. A pulled contested partner that matches no site
 * anchor carries its own first anchor (ADR-0027 R4's 跨锚点 rule). */
function siteAnchorFor(entry: MemoryEntry, site: MountSite): string {
  const matching = entry.anchors.filter(a => site.anchors.has(a))
  if (matching.length === 0) return entry.anchors[0] ?? ''
  const isColumn = (a: string): boolean => a.includes('#')
  const tier = (a: string): number => {
    const live = site.isLive(a)
    if (live && isColumn(a)) return 0
    if (live) return 1
    if (isColumn(a)) return 2
    return 3
  }
  let best = matching[0] as string
  let bestTier = tier(best)
  for (const a of matching.slice(1)) {
    const t = tier(a)
    if (t < bestTier) {
      best = a
      bestTier = t
    }
  }
  return best
}

/** One composed site's result: the shown rows plus the per-type overflow. */
interface SiteComposition {
  readonly shown: readonly MemoryViewEntry[]
  readonly truncated: MemoryTruncatedCounts | undefined
}

/** Render one shown entry as its row (zero-tax key discipline: optional keys
 * are spread only when they apply). */
function viewEntryOf(
  entry: MemoryEntry,
  anchor: string,
  site: MountSite,
  contested: readonly string[],
): MemoryViewEntry {
  const folded = (entry.promoted?.length ?? 0) > 0
  const deadColumn = anchor.includes('#') && !site.isLive(anchor)
  const deadEdge = EDGE_ANCHOR_PATTERN.test(anchor) && !site.isLive(anchor)
  return {
    id: entry.id,
    type: entry.type,
    anchor,
    ...folded ? { promoted: true as const } : { body: entry.body },
    ...entry.valid_from !== undefined ? { valid_from: entry.valid_from } : {},
    ...entry.valid_until !== undefined ? { valid_until: entry.valid_until } : {},
    ...entry.basis !== undefined ? { basis: entry.basis } : {},
    ...contested.length > 0 ? { contested_with: contested } : {},
    ...deadColumn ? { column_missing: true as const } : {},
    ...deadEdge ? { relation_missing: true as const } : {},
    ...site.definitionMissing === true ? { definition_missing: true as const } : {},
  }
}

/**
 * Compose one mounting site (ADR-0024 R3/R4 + ADR-0027 R4):
 *
 * 1. filter candidates to the regime's visibility — wrong never reaches here
 *    (the index queries already exclude it), promoted entries fold outside the
 *    budget, caveats are always shown and never budgeted;
 * 2. order by type priority then recency; caveat rows ride ahead of the
 *    budgeted seeds without consuming cap slots;
 * 3. contested companions travel (伙伴随行): every SHOWN entry pulls its
 *    visible partners immediately after itself, transitively — companions may
 *    exceed the cap, and nothing beyond the cap is dropped while one of its
 *    shown entries contests it, so a pair is never split by truncation;
 * 4. everything visible-and-budgeted that did not surface is reported per
 *    type in `truncated`.
 *
 * @param candidates - still-valid entries anchored on ≥1 site anchor
 *   (wrong-hidden already excluded, deduplicated).
 * @param regime - the index + query window.
 * @param site - the site's anchors, liveness, budget, and orphan marking.
 */
function composeSite(
  candidates: readonly MemoryEntry[],
  regime: ReadRegime,
  site: MountSite,
): SiteComposition {
  const visible = candidates.filter(e => visibilityOf(e, regime) !== 'hidden')
  // Sorted once; caveat rows are part of the same order (READ_TYPE_ORDER 0)
  // but never consume budget slots.
  const ordered = [...visible].sort(compareForDisplay)
  const caveats = ordered.filter(e => e.type === 'caveat')
  const budgeted = ordered.filter(e => e.type !== 'caveat' && visibilityOf(e, regime) === 'budgeted')
  const folded = ordered.filter(e => visibilityOf(e, regime) === 'folded')

  const shownEntries: MemoryEntry[] = []
  const shownIds = new Set<string>()
  // Seeds: the budgeted head, plus every caveat and folded row (both ride
  // outside the cap but are "shown", so their partners travel).
  const seeds = [...budgeted.slice(0, site.cap), ...caveats, ...folded]
  // 伙伴紧随排名高者: walk the seed order, emitting each seed then its
  // not-yet-shown partners (and recursively theirs — a partner being shown
  // pulls in turn). Caveats lead the display order, so re-walk `ordered` for
  // seed sequencing: every ordered entry that is a seed emits first-come.
  const isSeed = new Set(seeds.map(e => e.id))
  const emit = (entry: MemoryEntry): void => {
    if (shownIds.has(entry.id)) return
    shownIds.add(entry.id)
    shownEntries.push(entry)
  }
  for (const entry of ordered) {
    if (!isSeed.has(entry.id)) continue
    emit(entry)
    // Pull this entry's partners right behind it (breadth-first closure).
    const queue = [...liveContestedOf(entry, regime)]
    while (queue.length > 0) {
      const partner = queue.shift() as MemoryEntry
      if (shownIds.has(partner.id)) continue
      emit(partner)
      queue.push(...liveContestedOf(partner, regime))
    }
  }

  const shown = shownEntries.map(entry => viewEntryOf(
    entry,
    siteAnchorFor(entry, site),
    site,
    liveContestedOf(entry, regime).map(p => p.id),
  ))
  // Overflow = visible budgeted entries that did not surface — companions
  // pulled over the cap are shown, so they are NOT overflow (ADR-0027 R4).
  const overflow = new Map<string, number>()
  for (const e of budgeted) {
    if (shownIds.has(e.id)) continue
    overflow.set(e.type, (overflow.get(e.type) ?? 0) + 1)
  }
  return {
    shown,
    truncated: overflow.size > 0 ? Object.fromEntries([...overflow.entries()].sort(([a], [b]) => a < b ? -1 : 1)) : undefined,
  }
}

/** The empty view — the zero-tax arm every caller spreads conditionally. */
const EMPTY_NODE_VIEW: NodeMemoriesView = { memories: [], edge_memories: [] }

/**
 * Is one edge anchor's relation currently walkable — declared in the anchor
 * universe AND both endpoint nodes alive? The universe mirrors the graph's
 * declarations (a `dimension_refs` entry survives its target file's deletion),
 * but ADR-0026 R2's `relation_missing` marks exactly the entries whose edge
 * target no longer exists, so the read side demands both halves.
 */
function edgeIsLive(universe: AnchorUniverse, anchor: string): boolean {
  if (!universe.edges.has(anchor)) return false
  const m = EDGE_ANCHOR_PATTERN.exec(anchor)
  if (m === null) return false
  return universe.nodes.has(m[1] as string) && universe.nodes.has(m[3] as string)
}

/** The query options every read-surface entry point takes. */
export interface MemoryReadOptions {
  readonly data_window?: MemoryDataWindow | undefined
}

/**
 * `get_definition`'s mount (ADR-0024 R1): the node's own memories (node +
 * column anchors, `metric:` nodes exact — no host-table bleed, no columns) and
 * every touching edge's memories (live or dangling — ADR-0026 R2), two
 * independent budgets. Empty when the corpus holds no memory at all.
 * @param root - the corpus root.
 * @param nodeId - the canonical `<kind>:<名>` node id.
 * @param opts - the query window.
 */
export function readNodeMemoriesView(root: string, nodeId: string, opts: MemoryReadOptions = {}): NodeMemoriesView {
  const index = memoryAnchorIndexFor(root)
  index.refresh(root)
  if (index.size() === 0) return EMPTY_NODE_VIEW
  const universe = buildAnchorUniverse(root)
  const regime: ReadRegime = { index, window: opts.data_window }
  const isLiveNodeAnchor = (anchor: string): boolean => {
    const hashAt = anchor.indexOf('#')
    if (hashAt > 0) {
      const cols = universe.columns.get(anchor.slice(0, hashAt))
      return cols !== undefined && cols.has(anchor.slice(hashAt + 1))
    }
    if (EDGE_ANCHOR_PATTERN.test(anchor)) return edgeIsLive(universe, anchor)
    return universe.nodes.has(anchor)
  }

  // The node site: the node itself, its live columns, and the column
  // fragments the index still remembers (their columns may be gone — those
  // surface with column_missing, ADR-0024 R5's 降级 arm).
  const nodeAnchors = new Set<string>([nodeId])
  const columnPrefix = `${nodeId}#`
  for (const anchor of index.allAnchors()) {
    if (anchor.startsWith(columnPrefix)) nodeAnchors.add(anchor)
  }
  const columns = universe.columns.get(nodeId)
  if (columns !== undefined) for (const col of columns) nodeAnchors.add(`${nodeId}#${col}`)
  const nodeSite = composeSite(index.validEntriesAnchoredOnAny([...nodeAnchors]), regime, {
    anchors: nodeAnchors,
    isLive: isLiveNodeAnchor,
    cap: MEMORY_NODE_BUDGET,
  })

  // The edge site: every index edge anchor touching the node — including
  // dangling ones (ADR-0026 R2: a removed relation's memories stay on both
  // ends, marked; a fully-missing edge with one surviving end hangs there).
  // Metric nodes take no edges (ADR-0024 R1).
  let edgeSite: SiteComposition = { shown: [], truncated: undefined }
  if (!nodeId.startsWith('metric:')) {
    const touching = index.edgeAnchorsTouching(nodeId)
    if (touching.length > 0) {
      edgeSite = composeSite(index.validEntriesAnchoredOnAny(touching), regime, {
        anchors: new Set(touching),
        isLive: isLiveNodeAnchor,
        cap: MEMORY_EDGE_BUDGET,
      })
    }
  }

  return {
    memories: nodeSite.shown,
    ...nodeSite.truncated !== undefined ? { memories_truncated: nodeSite.truncated } : {},
    edge_memories: edgeSite.shown,
    ...edgeSite.truncated !== undefined ? { edge_memories_truncated: edgeSite.truncated } : {},
  }
}

/**
 * The not-found path's orphan list (ADR-0026 R3): entries anchored on a
 * definition that no longer exists — the node itself, its column fragments
 * (all dead now), and edges whose OTHER endpoint is dead too (an edge with a
 * surviving end hangs there instead, R2). Visibility / budget / ordering
 * follow the node mount's rules; every row carries `definition_missing: true`.
 * @param root - the corpus root.
 * @param nodeId - the canonical node id the caller could not load.
 * @param opts - the query window.
 */
export function readOrphanedMemoriesView(root: string, nodeId: string, opts: MemoryReadOptions = {}): OrphanedMemoriesView {
  const index = memoryAnchorIndexFor(root)
  index.refresh(root)
  if (index.size() === 0) return { orphaned_memories: [] }
  const universe = buildAnchorUniverse(root)
  const regime: ReadRegime = { index, window: opts.data_window }
  const anchors = new Set<string>([nodeId])
  const columnPrefix = `${nodeId}#`
  for (const anchor of index.allAnchors()) {
    if (anchor.startsWith(columnPrefix)) anchors.add(anchor)
  }
  // Dead-both-ends edges only: with a surviving far end the entry hangs there.
  for (const anchor of index.edgeAnchorsTouching(nodeId)) {
    const m = EDGE_ANCHOR_PATTERN.exec(anchor)
    if (m === null) continue
    const other = m[1] === nodeId ? m[3] : m[1]
    if (!universe.nodes.has(other as string)) anchors.add(anchor)
  }
  const site = composeSite(index.validEntriesAnchoredOnAny([...anchors]), regime, {
    anchors,
    isLive: () => false,
    cap: MEMORY_NODE_BUDGET,
    definitionMissing: true,
  })
  return {
    orphaned_memories: site.shown,
    ...site.truncated !== undefined ? { orphaned_memories_truncated: site.truncated } : {},
  }
}

/**
 * `search_definitions`' per-hit counts (ADR-0024 R6 + ADR-0027 R4): per-type
 * counts of the entries `get_definition` would show on the node in the
 * NO-window regime — wrong / outdated-old-segment / folded-promoted excluded,
 * caveats and traveling contested companions included — so「搜索见 3 条、
 * 点进去见 3 条」. Counts the node's own site only (not edge memories: a
 * different budget and list). Uncapped by design: beyond the budget the
 * detail view says so with its own truncated counters.
 * @param root - the corpus root.
 * @param nodeIds - canonical node ids of the ranked hits.
 * @returns per-node per-type counts; nodes with nothing to show are absent.
 */
export function memoryCountsByNode(root: string, nodeIds: readonly string[]): ReadonlyMap<string, Readonly<Record<string, number>>> {
  const out = new Map<string, Readonly<Record<string, number>>>()
  const index = memoryAnchorIndexFor(root)
  index.refresh(root)
  if (index.size() === 0 || nodeIds.length === 0) return out
  const regime: ReadRegime = { index, window: undefined }
  for (const nodeId of nodeIds) {
    const anchors = new Set<string>([nodeId])
    const columnPrefix = `${nodeId}#`
    for (const anchor of index.allAnchors()) {
      if (anchor.startsWith(columnPrefix)) anchors.add(anchor)
    }
    // cap = everything: counts want the full visible set, not the head.
    const composed = composeSite(index.validEntriesAnchoredOnAny([...anchors]), regime, {
      anchors,
      isLive: () => true,
      cap: Number.MAX_SAFE_INTEGER,
    })
    const counts = new Map<string, number>()
    for (const entry of composed.shown) {
      if (entry.promoted === true) continue
      counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1)
    }
    if (counts.size > 0) {
      out.set(nodeId, Object.fromEntries([...counts.entries()].sort(([a], [b]) => a < b ? -1 : 1)))
    }
  }
  return out
}

/**
 * The relation tools' per-edge mount (ADR-0024 R1: ≤3 per edge): resolves the
 * pair's canonical anchor spelling(s) from the index — the graph is walked
 * undirected while anchors carry the graph's logical direction — and composes
 * each edge's site. The edges themselves come from the live graph, so no
 * `relation_missing` can arise here.
 * @param root - the corpus root.
 * @param pairs - the response's edges as unordered endpoint pairs + type.
 * @param opts - the query window.
 * @returns one view per input pair, input order.
 */
export function readEdgeMemoriesForPairs(
  root: string,
  pairs: readonly MemoryEdgePair[],
  opts: MemoryReadOptions = {},
): readonly EdgeMemoriesView[] {
  const index = memoryAnchorIndexFor(root)
  index.refresh(root)
  if (index.size() === 0 || pairs.length === 0) return pairs.map(() => ({ entries: [] as const }))
  const regime: ReadRegime = { index, window: opts.data_window }
  return pairs.map(pair => {
    const anchors = [`${pair.a} -${pair.type}-> ${pair.b}`, `${pair.b} -${pair.type}-> ${pair.a}`]
    const site = composeSite(index.validEntriesAnchoredOnAny(anchors), regime, {
      anchors: new Set(anchors),
      isLive: () => true,
      cap: MEMORY_RELATION_BUDGET,
    })
    return {
      entries: site.shown,
      ...site.truncated !== undefined ? { truncated: site.truncated } : {},
    }
  })
}

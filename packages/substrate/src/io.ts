/**
 * P6b semantic-layer substrate — reader/writer/sync.
 * Mirrors reverse-bi/libs/rbi-semantic/src/rbi_semantic/{reader,writer,sync}.py.
 *
 * All functions take an explicit `semanticLayer` path (dependency injection, no
 * module globals for the layer root). Atomic write reuses
 * `@deepseek-ai/dsh-atomic-write` (`writeFileAtomic`: temp+wx+rename, mode
 * stamped through) — the prototype's hand-rolled `openSync/fsync/renameSync` is
 * replaced. Tier-2 audit routes through `ctx.audit.recordTier2Write` via the
 * `Tier2Recorder` interface (P6b grilling Q4; the prototype's flat JSON
 * `auditLog` is removed). Readers are sync (readFileSync, fast lookup); writers
 * are async (writeFileAtomic).
 *
 * ADR-0004 / #18 (2026-10-09): `Tier2Recorder.recordTier2Write` is async
 * (`Promise<string>` — the git recorder's commit is a subprocess call) and a
 * recorder that raises is the statement "this write did not happen": the
 * two Tier-2 paths below (`updateTableMeta` / `updateEventMeta`)
 * snapshot the pre-write raw bytes — never a
 * parse-then-re-dump, which would drop hand-written YAML comments — and
 * restore them verbatim on a recorder failure before re-throwing (a file this
 * write created is deleted instead of restored). `writeTable`/`writeEventYaml`
 * take the same optional `Tier2Opts`: passed, the raw-edit surface is demoted
 * to a write primitive that takes the identical atomic write-and-record path;
 * omitted, both are unchanged byte-for-byte (ADR-0004 ruling 2).
 *
 * @module io (internal; only `"."` is importable — see ADR-0002)
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { writeFileAtomic } from './vendor/atomic-write.ts'
import {
  EventDefinitionSchema,
  TableDefinitionSchema,
  ConceptDefinitionSchema,
  QueryDefinitionSchema,
  type EventDefinition,
  type TableDefinition,
  type ConceptDefinition,
  type QueryDefinition,
  type TableMeta,
} from './types.ts'
import {
  buildRetrievalCorpus,
  isPlainObject,
  type CorpusVariant,
  type EventCorpusInput,
  type EventCorpusItem,
} from './corpus.ts'
// read-epoch.ts must not import this module (cycle: it is the store this
// module's loaders memo through — ADR-0015's one-direction dependency).
import { currentReadEpoch } from './read-epoch.ts'
// The test-only parse counter's increment — io-probes.ts's only production
// caller (its reset/get pair is spec-side; #123 / C8.5 moved it out of here).
import { _countReadYamlParse } from './io-probes.ts'

/**
 * Identity/scope metadata attached to one Tier-2 record (`recordTier2Write`'s
 * `opts`), or supplied to `beginBatch` as the per-batch default every
 * `record()` call in that batch inherits unless it overrides a field.
 */
export interface Tier2RecordMeta {
  readonly scope_id?: string
  readonly session_id?: string
  readonly tenant_id?: string
  readonly user_id?: string
}

/**
 * Tier-2 recorder contract — `ctx.audit` satisfies this (P6b grilling Q4).
 *
 * ADR-0004 ruling 1 / #18: async (`Promise<string>` — the git recorder's
 * commit is a subprocess call, and must not block the event loop). Raising is
 * the recorder's statement that the write did NOT happen: the Tier-2 write
 * paths restore the pre-write raw bytes and re-throw (see the module doc
 * above). A recorder that raises therefore must leave its own index/HEAD
 * untouched (the git recorder's own obligation — ADR-0004).
 */
export interface Tier2Recorder {
  recordTier2Write(
    toolName: string,
    payload: unknown,
    opts?: Tier2RecordMeta,
  ): Promise<string>

  /**
   * Reserved batch slot (ADR-0004 ruling 3): coalesce the writes of one
   * logical round (e.g. an `enrichAll*` pass over N definitions) into a
   * single commit instead of N. Declared now so the contract is stable;
   * **no implementation ships with #18** — the git recorder's batch support
   * lands with the enrichment write-back ticket (#16). A recorder that does
   * not support batching simply omits this method; every caller must treat
   * it as optional and fall back to per-write `recordTier2Write` calls.
   * @param meta - optional per-batch default scope/session/tenant/user,
   *   inherited by every `record()` call in the batch unless overridden.
   * @returns a `Tier2Batch` handle the caller stages writes onto.
   */
  beginBatch?(meta?: Tier2RecordMeta): Tier2Batch
}

/**
 * A single-commit batch handle from `Tier2Recorder.beginBatch` (ADR-0004
 * ruling 3; reserved slot — implementation lands with #16). `record` stages
 * one logical write (same arguments as `recordTier2Write`) without
 * committing; `end` commits everything staged so far as one commit; `abort`
 * discards the batch and restores every staged file to its pre-batch state —
 * the batch-level shape of the same guarantee the audited write paths give a
 * single table (ADR-0004 ruling 1).
 */
export interface Tier2Batch {
  /** Stage one write into this batch (does not commit). */
  record(toolName: string, payload: unknown, opts?: Tier2RecordMeta): void
  /** Commit every staged write as one commit. */
  end(): Promise<{ commit: string; files: number }>
  /** Discard the batch: restore every staged file to its pre-batch state. */
  abort(): Promise<void>
}

/** Tier-2 write options: the recorder (ctx.audit) and optional scope id. */
export interface Tier2Opts {
  /** ctx.audit (or a test double) — required; Tier-2 audit is non-disableable (D5 "不可关"). */
  readonly recorder: Tier2Recorder
  readonly scope_id?: string
  /**
   * ADR-0004 ruling 8: sha256 content fingerprint (hex) the caller expects
   * the write target to currently carry — the hash of the raw bytes it last
   * read. Checked against the actual on-disk bytes immediately before this
   * write commits; a mismatch throws `StaleBaselineError` instead of
   * writing, which is the single-process stand-in for "inside the lock"
   * until the git recorder's repo-wide lock (#19) wraps the whole call. Omit
 * for a create-only write — there is no prior baseline to go stale (#15
 * decides which MCP tools require it).
 */
  readonly expected_version?: string
}

// ── YAML dump (mirrors RBI _LiteralDumper: literal block |, sort_keys=False) ──
/**
 * Dump a value to YAML (mirrors RBI `_LiteralDumper`: literal block style, sort_keys=False).
 * @param obj - the value to serialize.
 * @returns the YAML text (no refs, double-quote strings, unbounded line width).
 */
export function dumpYaml(obj: unknown): string {
  return yaml.dump(obj, { sortKeys: false, lineWidth: -1, noRefs: true, quotingType: '"' })
}
function readYaml(path: string): unknown {
  _countReadYamlParse() // the probe's one-line increment (#123/C8.5; io-probes.ts)
  return yaml.load(readFileSync(path, 'utf-8'))
}

// ── Test-only parse counter (ticket 01-probe) ─────────────────────────────
// Moved to io-probes.ts (#123 / C8.5): measures how many YAML reads a given
// code path triggers. NOT exported from index.ts (the acceptance script pins
// the public barrel name-by-name); specs import the reset/get pair directly
// from io-probes.ts. Only the increment call above stays in production code.

// ── Atomic write (mirrors writer._atomic_write via @deepseek-ai/dsh-atomic-write) ──
const YAML_MODE = 0o644
/**
 * Serialize, atomically write, and return the write receipt's fingerprint
 * (#108 / ADR-0004 ruling 8's extension): the sha256 of the exact bytes just
 * written — the same value `definitionVersion` would read back and
 * `checkExpectedVersion` will compare on the caller's NEXT `expected_version`
 * write, because the write is utf-8 text end-to-end. Hashing the content
 * already in hand (never a post-write re-read) is what keeps the receipt
 * free: a no-op write re-serializes the same object to the same bytes, so its
 * `version` IS the file's current fingerprint without any extra I/O.
 * @param path - the file to write.
 * @param obj - the value to serialize (a string is written verbatim).
 * @returns the written file's sha256 hex fingerprint.
 */
async function atomicWrite(path: string, obj: unknown): Promise<string> {
  const text = typeof obj === 'string' ? obj : dumpYaml(obj)
  await writeFileAtomic(path, text, { mode: YAML_MODE })
  return sha256Hex(text)
}

// D2f: per-path corpus-version counter bumped on every invalidateCaches call.
// A cached enriched Bm25Linker (tool-search-data-sources, keyed by ctx.schema)
// probes SemanticGroundingCore.corpusVersion() and rebuilds on a mismatch, so a
// mid-session event edit (writeEventYaml -> invalidateCaches) no longer leaves
// the enriched linker stale until reboot (D2e-deferred cache-invalidation).
// Path-scoped: a write to layer A bumps only A's counter. Table writes
// (writeTable/updateTableMeta) also bump it — the corpus
// (events + terminology) is unaffected, so this over-invalidates (one rebuild
// after a write burst); correct and rare vs distinguishing event vs table writes
// at the chokepoint. No static dep: tool-search reads this structurally.
const _corpusVersion = new Map<string, number>()
/**
 * The corpus-version counter for a semantic-layer path (monotonic; 0 until the
 * first invalidateCaches). Probed structurally by tool-search-data-sources.
 * @param semanticLayer - the semantic-layer directory path.
 * @returns the current corpus-version counter (0 when no write has invalidated).
 */
export function getCorpusVersion(semanticLayer: string): number {
  return _corpusVersion.get(semanticLayer) ?? 0
}
/**
 * Bump the per-path corpus-version counter for `semanticLayer` (ADR-0011).
 * Read-side caches key on it — the ADR-0015 loader memo's composite key turns
 * stale into a miss, and the enriched-Bm25Linker probe rebuilds on a mismatch.
 * @param semanticLayer - the semantic-layer path being invalidated.
 */
export function invalidateCaches(semanticLayer: string): void {
  _corpusVersion.set(semanticLayer, (_corpusVersion.get(semanticLayer) ?? 0) + 1)
}

// ── Reader (mirrors reader.py: lenient scan, strict validate-on-match) ──
/**
 * Resolve the semantic-layer dir from a root: returns the root itself when it
 * holds `config.yaml`, otherwise the first child subdir that does (falls back
 * to the root when none matches).
 * @param semanticRoot - the root path to resolve from (empty string passes through).
 * @returns the resolved semantic-layer directory path.
 */
export function resolveSemanticLayer(semanticRoot: string): string {
  if (!semanticRoot) return semanticRoot
  if (existsSync(join(semanticRoot, 'config.yaml'))) return semanticRoot
  for (const child of readdirSync(semanticRoot).sort()) {
    const c = join(semanticRoot, child)
    try {
      if (statSync(c).isDirectory() && existsSync(join(c, 'config.yaml'))) return c
    } catch {
      // not a directory or inaccessible — skip
    }
  }
  return semanticRoot
}
/**
 * Read and parse the layer's `config.yaml` (the caller is responsible for ensuring it exists).
 * @param semanticLayer - the semantic-layer directory path.
 * @returns the parsed config map.
 */
export function loadConfig(semanticLayer: string): Record<string, unknown> {
  return readYaml(join(semanticLayer, 'config.yaml')) as Record<string, unknown>
}
/**
 * Read and parse the layer's `domains.yaml` catalog (lenient: missing/malformed => `{}`).
 * @param semanticLayer - the semantic-layer directory path.
 * @returns the parsed domains map, or `{}` when the file is absent or not an object.
 */
export function loadDomains(semanticLayer: string): Record<string, unknown> {
  const p = join(semanticLayer, 'domains.yaml')
  if (!existsSync(p)) return {}
  try {
    const d = readYaml(p)
    // Array/object contract: a YAML array parses as an object (`typeof === 'object'`)
    // but is NOT a valid domains map. Reject arrays explicitly so a malformed
    // domains.yaml (a list, not a map) degrades to `{}` rather than silently
    // casting index keys to strings.
    return isPlainObject(d) ? d : {}
  } catch {
    // malformed/missing domains.yaml — degrade to {} so callers get a stable map
    return {}
  }
}

/**
 * Read the corpus-level suppression word list (`suppressions.yaml` at the layer
 * root, #37 §4): a hand-edited `alt_labels: string[]` whose entries filter every
 * definition's alias candidates ahead of merge, unioned with each definition's own
 * `suppressed_alt_labels`. Lenient exactly like {@link loadDomains}: a missing,
 * malformed, or wrongly-shaped file degrades to an empty set rather than throwing —
 * the write path is the curated hand-edit, so there is no tooling to keep it honest.
 * Keys are stored in the same normalized form alias vetoes use everywhere
 * (lowercased + trimmed), so an uppercase entry in the YAML vetoes a lowercase
 * candidate; non-string entries are dropped.
 * @param semanticLayer - the semantic-layer directory path.
 * @returns the normalized corpus-level veto keys (empty when absent/malformed).
 */
/**
 * The canonical normalization form for alias / suppression keys: lowercased
 * and trimmed. One implementation serves every consumer — substrate enrichment
 * filters, enrichment-work merge, MCP item handlers, the Core item methods
 * (#49 — the three private copies that had drifted across the codebase converge
 * here as the veto-key contract's single source of truth), the relation
 * graph's alias index, and `loadSuppressions` below (#147 — the fourth
 * private copy, relation-graph's `normalizeAlias`, imports this instead of
 * re-deriving the form; the inline expression here reads through it too).
 * @param s - the raw label string.
 * @returns the normalized key form.
 */
export function normalizeLabel(s: string): string {
  return s.toLowerCase().trim()
}

export function loadSuppressions(semanticLayer: string): ReadonlySet<string> {
  const p = join(semanticLayer, 'suppressions.yaml')
  if (!existsSync(p)) return new Set()
  try {
    const d = readYaml(p)
    if (!isPlainObject(d)) return new Set()
    const list = d.alt_labels
    if (!Array.isArray(list)) return new Set()
    const out = new Set<string>()
    for (const entry of list) {
      if (typeof entry !== 'string') continue
      const key = normalizeLabel(entry)
      if (key !== '') out.add(key)
    }
    return out
  } catch {
    return new Set()
  }
}

/** A scanned event: its `name`, raw YAML dict, and the domain subdir it lived in (unvalidated). */
export interface RawEvent {
  readonly name: string
  readonly raw: Record<string, unknown>
  readonly domain: string
}
/**
 * Scan the layer's `events/` subdirs (lenient: broken/non-object/unnamed YAML
 * files are skipped) and collect every event with its domain.
 * @param semanticLayer - the semantic-layer directory path.
 * @returns a fresh array of raw events (name + raw + domain), oldest-first within each domain.
 */
export function loadEvents(semanticLayer: string): RawEvent[] {
  return readThroughEpoch(semanticLayer, 'events', scanEvents)
}
/** `loadEvents`'s direct disk scan — the R3 no-epoch path, verbatim. */
function scanEvents(semanticLayer: string): RawEvent[] {
  const eventsDir = join(semanticLayer, 'events')
  const out: RawEvent[] = []
  if (!existsSync(eventsDir)) return out
  for (const domainDir of readdirSync(eventsDir).sort()) {
    const dp = join(eventsDir, domainDir)
    try {
      if (!statSync(dp).isDirectory()) continue
    } catch {
      continue
    }
    for (const f of readdirSync(dp).sort()) {
      if (!f.endsWith('.yaml') || f === '_index.yaml') continue
      try {
        const raw = readYaml(join(dp, f))
        if (typeof raw !== 'object' || raw === null) continue
        const r = raw as Record<string, unknown>
        const name = r.name
        if (typeof name !== 'string') continue
        out.push({ name, raw: r, domain: domainDir })
      } catch {
        continue // lenient: YAML-broken file skipped, doesn't poison others
      }
    }
  }
  return out
}
/** A scanned table: its file path, `table_name`, and raw YAML dict (unvalidated). */
export interface RawTable {
  readonly path: string
  readonly table_name: string
  readonly raw: Record<string, unknown>
}
/**
 * Scan the layer's `tables/` dir (lenient: broken/non-object/unnamed YAML
 * files are skipped; `_`-prefixed files ignored) and collect every table.
 * @param semanticLayer - the semantic-layer directory path.
 * @returns a fresh array of raw tables (path + table_name + raw), name-sorted.
 */
export function loadTables(semanticLayer: string): RawTable[] {
  return readThroughEpoch(semanticLayer, 'tables', scanTables)
}
/** `loadTables`'s direct disk scan — the R3 no-epoch path, verbatim. */
function scanTables(semanticLayer: string): RawTable[] {
  const tdir = join(semanticLayer, 'tables')
  const out: RawTable[] = []
  if (!existsSync(tdir)) return out
  for (const f of readdirSync(tdir).sort()) {
    if (!f.endsWith('.yaml') || f.startsWith('_')) continue
    try {
      const raw = readYaml(join(tdir, f))
      if (typeof raw !== 'object' || raw === null) continue
      const r = raw as Record<string, unknown>
      const tn = r.table_name
      if (typeof tn !== 'string') continue
      out.push({ path: join(tdir, f), table_name: tn, raw: r })
    } catch {
      continue
    }
  }
  return out
}

// ── Read epoch (ADR-0015): loader memo keyed (epoch × corpusVersion) ──────
// The epoch half of the composite key is the store instance itself (see
// read-epoch.ts — one fresh store per withReadEpoch call, never shared across
// epochs); this helper owns the other two coordinates:
// - the `(semanticLayer, kind)` string tells two loaders apart on the same
//   layer — a layer's tables and its events must never collide on one memo
//   slot, or loadEvents would hand back loadTables' array;
// - the per-entry `version` snapshot is validated against the LIVE
//   `_corpusVersion` counter on every access, so any write's bump (R8:
//   bump-completeness is auditedFileWrite's by-design guarantee, #75) turns
//   the entry into a miss mid-epoch and the loader re-reads from disk.
// Callers that never open an epoch take the `scan` path directly — R3:
// byte-identical to pre-ADR-0015 behavior, one existing behavior unchanged.
/**
 * Read one loader family through the open epoch's memo (ADR-0015 R1): hit only
 * when the entry's recorded corpusVersion still equals the live counter, else
 * direct-read and write the fresh entry back.
 *
 * **Deliberate boundary — concepts and plugin kinds stay OUTSIDE the epoch**
 * (#119's Q3 no-go, 2026-10-14): the `kind` union below is exactly `'tables'
 * | 'events'` on purpose. `loadConcepts` and the registry-driven plugin path
 * (`loadRawDir`, W27) never route through this memo — they re-scan on every
 * call, generation or no generation. That is a ruled boundary, not an
 * oversight: k11 measured 10 concepts with zero symptoms and zero red tests,
 * so folding them in would trade gate churn + an ADR-0015 addendum + a new
 * generation nail for zero user-visible benefit. Reopen triggers (recorded in
 * the same ruling): a batch-shaped concept write path landing (bulk import /
 * LLM batch writes), or the corpus growing past 100 concepts; the go-plan
 * (extend the union, gate `loadConcepts`/`loadRawDir`, addendum) hangs off
 * those. R6/R7 (mtime validation / cross-process caching) stay untouched
 * either way.
 *
 * @param semanticLayer - the semantic-layer directory path.
 * @param kind - which loader family the memo slot belongs to (`tables`/`events`).
 * @param scan - the direct disk scan (today's loader body, verbatim).
 * @returns the memoised array on a hit, otherwise the scan's fresh array.
 */
function readThroughEpoch<T>(semanticLayer: string, kind: 'tables' | 'events', scan: (semanticLayer: string) => T): T {
  const epoch = currentReadEpoch()
  if (epoch === undefined) return scan(semanticLayer) // R3: no epoch — direct read
  const version = _corpusVersion.get(semanticLayer) ?? 0
  const key = `${semanticLayer}\u0000${kind}`
  const hit = epoch.memo.get(key)
  // io.ts-side narrowing of read-epoch.ts's loose `unknown`: the only writer
  // of `data` slots is this function, storing exactly what `scan` returned —
  // RawTable[] for 'tables', RawEvent[] for 'events'.
  if (hit !== undefined && hit.version === version) return hit.data as T
  const out = scan(semanticLayer)
  epoch.memo.set(key, { version, data: out })
  return out
}
/**
 * Load a validated event definition by name (strict validate-on-match; lenient scan).
 * @param semanticLayer - the semantic-layer directory path.
 * @param name - the event `name` key to match.
 * @returns the parsed `EventDefinition`, or null when no event matches.
 */
export function loadEventDefinition(semanticLayer: string, name: string): EventDefinition | null {
  for (const e of loadEvents(semanticLayer)) {
    if (e.name === name) return EventDefinitionSchema.parse(e.raw)
  }
  return null
}
/**
 * Load a validated table definition by name (strict validate-on-match; lenient scan).
 * @param semanticLayer - the semantic-layer directory path.
 * @param name - the table `table_name` key to match.
 * @returns the parsed `TableDefinition`, or null when no table matches.
 */
export function loadTableDefinition(semanticLayer: string, name: string): TableDefinition | null {
  for (const t of loadTables(semanticLayer)) {
    if (t.table_name === name) return TableDefinitionSchema.parse(t.raw)
  }
  return null
}

// ── Concepts (CL-2) ────────────────────────────────────────────────────
/** A scanned concept: its `name` and raw YAML dict (unvalidated). */
export interface RawConcept {
  readonly name: string
  readonly raw: Record<string, unknown>
}
/**
 * Scan the layer's `concepts/` dir (lenient: broken/non-object/unnamed YAML
 * files are skipped) and collect every concept.
 * @param semanticLayer - the semantic-layer directory path.
 * @returns a fresh array of raw concepts (name + raw), name-sorted.
 */
export function loadConcepts(semanticLayer: string): RawConcept[] {
  const cdir = join(semanticLayer, 'concepts')
  const out: RawConcept[] = []
  if (!existsSync(cdir)) return out
  for (const f of readdirSync(cdir).sort()) {
    if (!f.endsWith('.yaml') || f.startsWith('_')) continue
    try {
      const raw = readYaml(join(cdir, f))
      if (typeof raw !== 'object' || raw === null) continue
      const r = raw as Record<string, unknown>
      const n = r.name
      if (typeof n !== 'string') continue
      out.push({ name: n, raw: r })
    } catch {
      continue
    }
  }
  return out
}
/**
 * Load a validated concept definition by name.
 * @param semanticLayer - the semantic-layer directory path.
 * @param name - the concept `name` key to match.
 * @returns the parsed `ConceptDefinition`, or null when no concept matches.
 */
export function loadConceptDefinition(semanticLayer: string, name: string): ConceptDefinition | null {
  for (const c of loadConcepts(semanticLayer)) {
    if (c.name === name) return ConceptDefinitionSchema.parse(c.raw)
  }
  return null
}

/**
 * Generic flat scan of `<semanticLayer>/<dir>/*.yaml` returning each file's raw
 * object dict (lenient: broken/non-object YAML and `_`-prefixed files skipped).
 * The kind-agnostic reader for storage dirs without a bespoke loader — used by
 * the registry-driven graph projection (W27) so a kind registered after build
 * can load its definitions without a hardcoded per-kind loader. Bespoke layouts
 * (events' domain subdirs, tables) keep their own loaders.
 * @param semanticLayer - the semantic-layer directory path.
 * @param dir - the storage subdirectory name.
 * @returns a fresh array of raw object dicts, filename-sorted.
 */
export function loadRawDir(semanticLayer: string, dir: string): Record<string, unknown>[] {
  const d = join(semanticLayer, dir)
  const out: Record<string, unknown>[] = []
  if (!existsSync(d)) return out
  for (const f of readdirSync(d).sort()) {
    if (!f.endsWith('.yaml') || f.startsWith('_')) continue
    try {
      const raw = readYaml(join(d, f))
      if (typeof raw !== 'object' || raw === null) continue
      out.push(raw as Record<string, unknown>)
    } catch {
      continue
    }
  }
  return out
}

/**
 * Load every schema-valid verified-query definition from one corpus root's
 * `queries/` dir (one file per query, ADR-0025 R1). The single typed view of
 * that dir: the write/read orchestration (query.ts) and the anchor universe's
 * query-node scan (memory.ts) both consume this loader, so it lives here
 * beside `loadRawDir` — the one module both may import without a cycle
 * (query.ts already imports memory.ts, so the enumeration cannot live there;
 * M3-②/#198: was duplicated at both call sites). The kind plugin's generic
 * flat-dir read loads the same layout for the graph/corpus projections.
 * Lenient per file, like every loader here.
 * @param semanticLayer - the corpus root (the dir holding `queries/`).
 * @returns the parsed definitions, filename order (deterministic).
 */
export function loadQueryDefinitions(semanticLayer: string): QueryDefinition[] {
  const out: QueryDefinition[] = []
  for (const raw of loadRawDir(semanticLayer, 'queries')) {
    const r = QueryDefinitionSchema.safeParse(raw)
    if (r.success && r.data !== undefined) out.push(r.data)
  }
  return out
}

// semantic-layer-9: isPlainObject imported from ./corpus.ts above (was a byte-identical private dup here).
/**
 * Project a scanned `RawEvent` to the corpus-input shape (name + description +
 * params_fields + metrics; `domain` dropped — not indexed). Lenient: malformed
 * fields are omitted rather than thrown so a broken event never poisons the
 * corpus (mirrors the lenient `loadEvents` scan).
 * @param e - the scanned raw event (name + raw dict + domain subdir).
 * @returns the event projected to the fields the retrieval corpus indexes.
 */
function eventCorpusInput(e: RawEvent): EventCorpusInput {
  const raw = e.raw
  const pf = raw.params_fields
  const metrics = raw.metrics
  const al = raw.alt_labels
  return {
    name: e.name,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(isPlainObject(pf) ? { params_fields: pf as Record<string, { description?: string }> } : {}),
    ...(Array.isArray(al) ? { alt_labels: al as string[] } : {}),
    ...(isPlainObject(metrics) ? { metrics: metrics } : {}),
  }
}
/**
 * Build an enriched retrieval corpus from the substrate. Each event's
 * `alt_labels` (SKOS aliases) + params_fields are packed into the indexed
 * description. Lenient: an unreadable events/ scan degrades to an empty
 * corpus rather than throwing.
 * @param semanticLayer - the semantic-layer directory path (with `events/`).
 * @param variant - which slices to pack: 'params+term' (default) or 'term-only'.
 * @returns enriched corpus items ready for `Bm25Linker` / `HybridRetriever` indexing.
 */
export function loadRetrievalCorpus(
  semanticLayer: string,
  variant: CorpusVariant = 'params+term',
): readonly EventCorpusItem[] {
  let events: readonly EventCorpusInput[] = []
  try {
    events = loadEvents(semanticLayer).map(eventCorpusInput)
  } catch {
    // unreadable events/ scan -> no events indexed this boot
  }
  return buildRetrievalCorpus(events, variant)
}
function findEventPath(semanticLayer: string, name: string): string | null {
  const eventsDir = join(semanticLayer, 'events')
  if (!existsSync(eventsDir)) return null
  for (const domainDir of readdirSync(eventsDir).sort()) {
    const dp = join(eventsDir, domainDir)
    const candidate = join(dp, `${name}.yaml`)
    if (existsSync(candidate)) {
      try {
        const raw = readYaml(candidate) as Record<string, unknown> | null
        if (raw !== null && raw.name === name) return candidate
      } catch {
        // fall through to broad scan
      }
    }
  }
  for (const domainDir of readdirSync(eventsDir).sort()) {
    const dp = join(eventsDir, domainDir)
    try {
      if (!statSync(dp).isDirectory()) continue
    } catch {
      continue
    }
    for (const f of readdirSync(dp).sort()) {
      if (!f.endsWith('.yaml') || f === '_index.yaml') continue
      try {
        const raw = readYaml(join(dp, f)) as Record<string, unknown> | null
        if (raw !== null && raw.name === name) return join(dp, f)
      } catch {
        // lenient
      }
    }
  }
  return null
}

// ── Tier-2 rollback + baseline freshness (ADR-0004 rulings 1 + 8; #18) ───
/**
 * Thrown by a Tier-2 write path when `Tier2Opts.expected_version` is given
 * and does not match the sha256 of the bytes actually on disk at write time.
 * A stale baseline, not a schema-validation failure (ADR-0004 ruling 8): the
 * caller read the target, computed its basis, and the target has since
 * changed underneath it. The write never lands when this throws — the
 * caller should re-read the target and retry with a fresh `expected_version`.
 */
export class StaleBaselineError extends Error {}

/** sha256 content fingerprint of raw text, hex-encoded (ADR-0004 ruling 8: the
 * `version` a reader hands back is this hash of the bytes it actually read). */
function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

/**
 * ADR-0004 ruling 8: when `expectedVersion` is given, compare it against the
 * sha256 of `actualRaw` — the raw bytes on disk right now, read immediately
 * before this write — and throw `StaleBaselineError` on mismatch. Checked at
 * write time against the freshest read rather than trusting a value the
 * caller computed earlier, which is the single-process stand-in for "inside
 * the lock" until the git recorder's repo-wide lock (#19) wraps the call. A
 * no-op when `expectedVersion` is undefined (the common, baseline-free case).
 * @param target - the file path being written (for the error message only).
 * @param expectedVersion - the caller's claimed sha256 baseline, or undefined to skip the check.
 * @param actualRaw - the raw bytes actually on disk right now.
 */
function checkExpectedVersion(target: string, expectedVersion: string | undefined, actualRaw: string): void {
  if (expectedVersion === undefined) return
  const actual = sha256Hex(actualRaw)
  if (actual !== expectedVersion) {
    throw new StaleBaselineError(
      `stale baseline for ${target}: expected_version=${expectedVersion} but the on-disk content hashes to ${actual} — re-read and retry`,
    )
  }
}

/**
 * The read-side half of ADR-0004 ruling 8's fingerprint contract: the sha256 of
 * a definition's **backing file's literal bytes**, resolved by the same path
 * logic the write-side check uses — `checkExpectedVersion` hashes the bytes at
 * exactly the path this function resolves (`tables/<name>.yaml` for a table,
 * the file `writeEventYaml`/`updateEventMeta` would target for an event), which
 * is what makes a `load*DefinitionWithVersion` read followed by an
 * `expected_version` write round-trip. One implementation for both sides of the
 * contract, on purpose: the MCP read path previously carried its own copy of
 * this resolution (fingerprints by filename convention, an event's domain
 * located via a full `loadEvents` scan) and the two had already diverged — a
 * hand-renamed event file made the copy throw ENOENT while `findEventPath`'s
 * fallback scan, used here, still resolves the very file the writer checks
 * against. Concepts resolve by the same filename convention as tables
 * (`concepts/<name>.yaml`) — now the write-side path too, since ADR-0012
 * opened `writeConceptYaml`/`updateConceptMeta` (superseding ADR-0005 ruling
 * 2's concept-write exclusion).
 * @param semanticLayer - the semantic-layer directory path.
 * @param kind - which storage layout to resolve against.
 * @param name - the table_name / event name / concept name.
 * @returns the sha256 hex fingerprint of the resolved file's bytes, or null
 *   when no backing file resolves for that name — the caller decides whether
 *   null means "not found" or a loud internal inconsistency (a definition that
 *   loads while its file does not resolve is the latter).
 */
export function definitionVersion(semanticLayer: string, kind: 'table' | 'event' | 'concept' | 'query', name: string): string | null {
  const target = kind === 'table'
    ? join(semanticLayer, 'tables', `${name}.yaml`)
    : kind === 'concept'
      ? join(semanticLayer, 'concepts', `${name}.yaml`)
      : kind === 'query'
        ? join(semanticLayer, 'queries', `${name}.yaml`)
        : findEventPath(semanticLayer, name)
  if (target === null || !existsSync(target)) return null
  return sha256Hex(readFileSync(target, 'utf-8'))
}

/**
 * A target file's state immediately before a Tier-2 write, captured so a
 * recorder failure can restore it exactly (ADR-0004 ruling 1): the literal
 * pre-write bytes when the file already existed, or `existed: false` when
 * this write would create it (rollback then deletes rather than restoring
 * content out of nothing). Raw text, never parse-then-re-dump — a
 * hand-written YAML file's comments live only in these bytes.
 */
interface RawSnapshot {
  readonly existed: boolean
  readonly raw: string
}
/**
 * Capture `path`'s pre-write {@link RawSnapshot}.
 * @param path - the file about to be written.
 * @returns the pre-write snapshot (`existed: false, raw: ''` when `path` does not exist yet).
 */
function snapshotRaw(path: string): RawSnapshot {
  if (!existsSync(path)) return { existed: false, raw: '' }
  return { existed: true, raw: readFileSync(path, 'utf-8') }
}
/**
 * Restore `path` to a pre-write {@link RawSnapshot}: atomically rewrite the
 * captured raw bytes when the file existed before the write, or delete the
 * file when the write created it. The statement a Tier-2 recorder failure
 * makes is "the write did not happen" (ADR-0004 ruling 1 / GLOSSARY § Tier-2
 * recorder) — after this call, disk is back at the pre-write state, so there
 * is no third state (an unaudited file on disk while the caller's return
 * value reports no write).
 * @param path - the file to restore.
 * @param snapshot - the pre-write snapshot captured by {@link snapshotRaw}.
 */
async function restoreRaw(path: string, snapshot: RawSnapshot): Promise<void> {
  if (snapshot.existed) {
    await writeFileAtomic(path, snapshot.raw, { mode: YAML_MODE })
  } else {
    await rm(path, { force: true })
  }
}

// ── Writer (mirrors writer.py: validate-before-dump, atomic, invalidate) ──
/**
 * The outcome a seam callback reports back to {@link auditedFileWrite}:
 * `committed` when the write landed (the seam goes on to invalidate caches and
 * record), or the domain `error` when it did not — a callback that has not
 * written anything aborts the transaction, and the error surfaces as the
 * caller's `{ok:false}`, never as a recorder rollback.
 */
type AuditedFileWriteOutcome<T> = { readonly committed: true; readonly value: T } | { readonly committed: false; readonly error: string }
/**
 * The one audited write-and-record transaction every Tier-2 file write in this
 * module drives (#61): snapshot the pre-write raw bytes, check the caller's
 * `expected_version` against them (ADR-0004 ruling 8 — the freshest read,
 * the single-process stand-in for "inside the lock"), run the write,
 * invalidate caches, record via the Tier-2 recorder — and when the recorder
 * raises, restore the snapshot and re-throw (ruling 1 / D5: the statement is
 * "the write did not happen"; disk ends at the pre-write state, never a third
 * unaudited-residue state). Seven write paths previously carried this
 * ceremony as hand-maintained copies — #52's concept pair was the sixth and
 * seventh pair of hands (`updateConceptMeta`'s own doc said "updateTableMeta's
 * exact ceremony"), each new path re-copying the ~15-line rollback half with
 * no test pinning it.
 *
 * The `write` callback receives the pre-write {@link RawSnapshot} so the
 * read-merge-validate paths (the `update*Meta` family, A13) merge on exactly
 * the bytes the version check compared. A callback returning
 * `{committed: false}` leaves disk untouched and records nothing — that is the
 * domain-failure exit, the caller's `{ok:false}`.
 * @param semanticLayer - the semantic-layer directory path (for cache invalidation).
 * @param target - the file about to be written.
 * @param tier2 - the recorder + optional scope id + optional `expected_version`.
 * @param write - the write itself: receives the snapshot, writes the file,
 *   reports whether it committed.
 * @param record - the audit record's verb and subject.
 * @returns the callback's outcome — committed outcomes have been recorded;
 *   aborted outcomes are passed through untouched.
 */
async function auditedFileWrite<T>(
  semanticLayer: string,
  target: string,
  tier2: Tier2Opts,
  write: (before: RawSnapshot) => Promise<AuditedFileWriteOutcome<T>>,
  record: { readonly verb: string; readonly subject: Record<string, unknown> },
): Promise<AuditedFileWriteOutcome<T>> {
  const before = snapshotRaw(target)
  checkExpectedVersion(target, tier2.expected_version, before.raw)
  const outcome = await write(before)
  if (!outcome.committed) return outcome
  invalidateCaches(semanticLayer)
  try {
    await tier2.recorder.recordTier2Write(record.verb, record.subject, tier2.scope_id !== undefined ? { scope_id: tier2.scope_id } : {})
  } catch (e) {
    await restoreRaw(target, before)
    invalidateCaches(semanticLayer)
    throw e
  }
  return outcome
}
/**
 * The create-family write result every `write*Yaml`/`writeTable` primitive
 * returns through the {@link writeDefinitionFile} seam: `{ok, path, version}`
 * on success (`version` — the write receipt's sha256 fingerprint, #108), or
 * the domain `error` when the caller's pre-validation rejected the payload.
 * Structurally identical to the three public result types
 * (`WriteTableResult` / `WriteEventYamlResult` / `WriteConceptYamlResult`),
 * which stay the exported spellings (ADR-0003 barrel pins them by name).
 */
type WriteFileOutcome = { ok: true; path: string; version: string } | { ok: false; error: string }
/**
 * The one write-dispatch seam every create-shaped writer in this module drives
 * (#123 / C8.2): `tier2` absent → the raw-edit half (atomicWrite +
 * invalidateCaches + the version receipt); `tier2` present → the audited
 * write-and-record transaction via {@link auditedFileWrite} (snapshot,
 * `expected_version` check, rollback-on-recorder-failure) with a committed
 * callback that just writes the bytes. Before this seam, `writeTable` /
 * `writeEventYaml` / `writeConceptYaml` each carried both halves as a
 * verbatim hand copy — three copies of the same dispatch (#119's ruling
 * verified them token-identical), each new kind re-copying them.
 *
 * Layering with `auditedFileWrite`, on purpose — the write ceremony's three
 * tiers, none tearing the others: `auditedFileWrite` stays the generic
 * audited TRANSACTION both family seams' audited arms drive; this seam is
 * the CREATE family's raw-or-audited DISPATCH (payload already validated,
 * path already resolved); `updateMetaFile` is the symmetric UPDATE half —
 * read-merge-validate inside the transaction's `before`-callback, merging on
 * exactly the snapshotted bytes the version check compared. Every write path
 * in the module now reaches the disk through exactly one family seam, and
 * every audited one through `auditedFileWrite`.
 *
 * The `version` receipt stays computed inline in both halves (never a
 * post-write re-read) — the no-op-write-fingerprint property #108 pinned.
 * @param semanticLayer - the semantic-layer directory path (for cache invalidation).
 * @param target - the resolved file path to write.
 * @param bytes - the payload (a string is written verbatim; anything else is YAML-dumped).
 * @param tier2 - optional Tier-2 options; present selects the audited half.
 * @param record - the audit record's verb and subject (audited half only).
 * @returns `{ok: true, path, version}` or `{ok: false, error}` — the caller's
 *   declared result type, structurally.
 */
async function writeDefinitionFile(
  semanticLayer: string,
  target: string,
  bytes: unknown,
  tier2: Tier2Opts | undefined,
  record: { readonly verb: string; readonly subject: Record<string, unknown> },
): Promise<WriteFileOutcome> {
  if (tier2 === undefined) {
    const version = await atomicWrite(target, bytes)
    invalidateCaches(semanticLayer)
    return { ok: true, path: target, version }
  }
  const outcome = await auditedFileWrite(semanticLayer, target, tier2,
    async () => ({ committed: true as const, value: { path: target, version: await atomicWrite(target, bytes) } }),
    record)
  return outcome.committed ? { ok: true, ...outcome.value } : { ok: false, error: outcome.error }
}
/**
 * Result of writing table YAML: `{ ok: true, path, version }` on success
 * (`version` — the written file's sha256 fingerprint, #108's write-receipt
 * extension of ADR-0004 ruling 8), or `{ ok: false, error }` when the payload
 * fails `TableDefinitionSchema` validation (#61: the write paths' unified
 * domain-failure face — the caller fixes the payload and retries.
 * `StaleBaselineError` and recorder failures still throw; those are not
 * payload problems).
 */
export type WriteTableResult = { ok: true; path: string; version: string } | { ok: false; error: string }
/**
 * Validate-then-atomically-write a table YAML (mirrors writer.write_table),
 * invalidating caches on success. The write primitive (the MCP
 * `create_definition` tool compiles onto it): a caller may demote this
 * raw-edit surface
 * to an audited write by passing `tier2` (ADR-0004 ruling 2) — the same
 * atomic write-and-record path a Tier-2 call takes, snapshot-and-rollback
 * included. Omitting `tier2` leaves behavior byte-for-byte unchanged: an
 * unaudited write whose audit (if any) is the caller's responsibility.
 * @param semanticLayer - the semantic-layer directory path.
 * @param name - the table `table_name` (becomes the `<name>.yaml` filename).
 * @param data - the table payload; validated against `TableDefinitionSchema` unless skipped.
 * @param opts - `{ skipValidation: true }` skips schema validation (for pre-validated generators).
 * @param tier2 - optional Tier-2 options; passed, this write takes the
 *   audited write-and-record path (optional `expected_version` checked
 *   first; a recorder failure restores the pre-write bytes and rethrows).
 * @returns `{ ok: true, path, version }` on success (`version` = the written
 *   file's sha256 fingerprint — feed it straight back as the next write's
 *   `expected_version`), or `{ ok: false, error }` when schema validation
 *   rejects the payload.
 */
export async function writeTable(
  semanticLayer: string,
  name: string,
  data: unknown,
  opts: { skipValidation?: boolean } = {},
  tier2?: Tier2Opts,
): Promise<WriteTableResult> {
  if (!opts.skipValidation) {
    const r = TableDefinitionSchema.safeParse(data)
    if (!r.success) return { ok: false, error: `Table validation failed: ${r.error.message}` }
  }
  const tablesPath = join(semanticLayer, 'tables')
  const target = join(tablesPath, `${name}.yaml`)
  return writeDefinitionFile(semanticLayer, target, data, tier2, { verb: 'write_table', subject: { table_name: name } })
}
/**
 * Result of writing event YAML: either `{ ok: true, path, version }` on
 * success (`version` = the written file's sha256 fingerprint, #108) or
 * `{ ok: false, error }` when the YAML is unparseable/not-an-object or its
 * `name` does not match `name`.
 */
export type WriteEventYamlResult = { ok: true; path: string; version: string } | { ok: false; error: string }
// writeEventYaml = raw-edit surface (mirrors writer.write_event_yaml used by approve_event_yaml):
// no model_validate (the write IS the repair surface; load validates on read). Name-match check.
/**
 * Raw-edit surface for event YAML: parse the content, verify its `name` matches,
 * then atomically write it to the discovered event path (or
 * `events/_suggested/<name>.yaml` when new). No schema validation — the write
 * IS the repair surface; `loadEvents` validates on read. The write primitive:
 * a caller may demote this raw-edit surface to an audited write by passing
 * `tier2` (ADR-0004 ruling 2) — the same atomic write-and-record path a
 * Tier-2 call takes, snapshot-and-rollback included. Omitting `tier2` leaves
 * behavior byte-for-byte unchanged.
 * @param semanticLayer - the semantic-layer directory path.
 * @param name - the event `name` the content must declare.
 * @param content - the raw YAML text to write verbatim.
 * @param tier2 - optional Tier-2 options; passed, this write takes the
 *   audited write-and-record path (optional `expected_version` checked
 *   first; a recorder failure restores the pre-write bytes and rethrows).
 * @returns `{ ok: true, path, version }` on success (`version` = the written
 *   file's sha256 fingerprint), or `{ ok: false, error }` describing the
 *   parse/name-mismatch failure.
 */
export async function writeEventYaml(
  semanticLayer: string,
  name: string,
  content: string,
  tier2?: Tier2Opts,
): Promise<WriteEventYamlResult> {
  let defn: unknown
  try {
    defn = yaml.load(content)
  } catch (e) {
    return { ok: false, error: `YAML parse failed: ${(e as Error).message}` }
  }
  if (typeof defn !== 'object' || defn === null) return { ok: false, error: 'YAML is not an object' }
  const r = defn as Record<string, unknown>
  const yamlName = r.name
  if (typeof yamlName !== 'string' || yamlName !== name) {
    return { ok: false, error: `name mismatch: YAML name=${String(yamlName)} vs event_name=${name}` }
  }
  const target = findEventPath(semanticLayer, name) ?? join(semanticLayer, 'events', '_suggested', `${name}.yaml`)
  return writeDefinitionFile(semanticLayer, target, content, tier2, { verb: 'write_event_yaml', subject: { event_name: name } })
}
// ── updateMetaFile: the update family's one read-merge-validate seam (#142 / C10) ──
// The create family's ceremony was collected into writeDefinitionFile above
// (#123 / C8.2); the update trio below carried the same disease on the other
// half of the family — three ~19-line read-merge-validate callback bodies,
// verbatim siblings apart from five per-kind facts. Those five facts ride a
// descriptor; the ceremony lives here, once.

/**
 * The structural slice of a definition schema this seam needs: `safeParse` on
 * `unknown` reporting a readable `message` on failure. All three definition
 * schemas (types.ts) satisfy it structurally — the same trick as registry.ts's
 * `SchemaLike`, kept local because io.ts is the write side and wants the
 * failure arm typed, not `unknown`.
 */
interface SafeParseReporting {
  safeParse(raw: unknown): { success: true } | { success: false; error: { message: string } }
}
/**
 * The five points one `update*Meta` primitive differs from its siblings on
 * (C10: the descriptor is data, the ceremony is behavior — a future kind's
 * update primitive is one descriptor plus a 3-line public function, not a
 * re-copy of the ceremony):
 * 1. target resolution — tables/concepts a fixed `join`; events through
 *    `findEventPath`'s domain-subdir scan;
 * 2. the not-found / malformed label (`Table` / `Event` / `Concept`);
 * 3. the schema the merged document must re-validate against;
 * 4. the audit record's verb and subject key;
 * 5. the ok-receipt's result key (`table_name` / `event_name` / `concept_name`).
 */
interface UpdateMetaDescriptor {
  /** Resolves the update target; `null` is the not-found exit (this is an UPDATE, not a create — a concurrently deleted file must not be silently re-created). */
  readonly resolveTarget: (semanticLayer: string, name: string) => string | null
  /** The kind label for the `${label} not found` / `${label} malformed` error spellings (byte-stable API — callers match on them). */
  readonly label: string
  /** Full-schema validation of the merged document before the write. */
  readonly schema: SafeParseReporting
  /** The Tier-2 audit record's verb (its subject is `{[subjectKey]: name, updates}`). */
  readonly verb: string
  /** The audit subject's entity key. */
  readonly subjectKey: string
  /** The ok-receipt's entity key — one of the three public result types' named keys. */
  readonly resultKey: 'table_name' | 'event_name' | 'concept_name'
}
/**
 * The update family's committed receipt — `{name, version}` re-keyed under
 * the kind's result key, so `updateMetaFile` returns exactly the calling
 * public function's own result type, structurally (the three exported
 * `Update*MetaResult` types stay the exported spellings).
 */
type MetaUpdateOk<K extends 'table_name' | 'event_name' | 'concept_name'> = { ok: true; version: string } & Record<K, string>
/**
 * Resolve `path` when the file exists on disk, `null` when it does not — the
 * fixed-layout siblings' (tables/concepts) `resolveTarget`; events resolve
 * through `findEventPath`, whose `null` already means "not found".
 * @param path - the candidate file path.
 * @returns `path`, or `null` when no such file exists.
 */
function existingFile(path: string): string | null {
  return existsSync(path) ? path : null
}
/**
 * The one read-merge-validate-write ceremony every Tier-2 meta update in
 * this module drives (#142 / C10 — the UPDATE half of the collection
 * `writeDefinitionFile` started for the create family): resolve the target
 * (not-found is the caller's `{ok:false}` domain exit, before the
 * transaction opens), re-read the LATEST on-disk bytes inside the audited
 * transaction, shallow-merge the caller's `updates` over them,
 * full-schema-validate the merged document, atomically write it, and hand
 * the receipt back re-keyed under the descriptor's result key.
 *
 * Everything the siblings share lives here and nowhere else: the A13
 * re-read-merge-write (merge on exactly the snapshotted bytes the
 * `expected_version` check compared), ADR-0004 ruling 1's snapshot +
 * recorder-failure rollback (inherited wholesale from `auditedFileWrite`),
 * and ruling 8 / #108's write receipt — `version` is `atomicWrite`'s return
 * value computed inline, never a post-write re-read, so a byte-stable no-op
 * write's receipt IS the file's current fingerprint. The three error
 * spellings (`not found` / `malformed` / `Validation failed after update`)
 * are byte-stable API.
 * @param semanticLayer - the semantic-layer directory path.
 * @param name - the entity's name (also the audit subject's value).
 * @param updates - the field overrides shallow-merged over the on-disk YAML.
 * @param opts - the recorder + optional scope id + optional `expected_version` used for the Tier-2 audit record.
 * @param kind - the five-point per-kind descriptor.
 * @returns the calling kind's own result shape: `{ok: true, <resultKey>: name, version}` or `{ok: false, error}`.
 */
async function updateMetaFile<K extends 'table_name' | 'event_name' | 'concept_name'>(
  semanticLayer: string,
  name: string,
  updates: Record<string, unknown>,
  opts: Tier2Opts,
  kind: UpdateMetaDescriptor & { readonly resultKey: K },
): Promise<MetaUpdateOk<K> | { ok: false; error: string }> {
  const target = kind.resolveTarget(semanticLayer, name)
  if (target === null) return { ok: false, error: `${kind.label} not found: ${name}` }
  const outcome = await auditedFileWrite(semanticLayer, target, opts, async (before) => {
    const data = yaml.load(before.raw)
    if (typeof data !== 'object' || data === null) return { committed: false, error: `${kind.label} malformed: ${name}` }
    const merged: Record<string, unknown> = { ...(data as Record<string, unknown>), ...updates }
    const r = kind.schema.safeParse(merged)
    if (!r.success) return { committed: false, error: `Validation failed after update: ${r.error.message}` }
    const version = await atomicWrite(target, merged)
    return { committed: true, value: { name, version } }
  }, { verb: kind.verb, subject: { [kind.subjectKey]: name, updates } })
  return outcome.committed
    ? { ok: true as const, [kind.resultKey]: outcome.value.name, version: outcome.value.version } as MetaUpdateOk<K>
    : { ok: false, error: outcome.error }
}

// Tier-2 per-scope persistent write: read-merge-validate-write + audit (mirrors writer.update_table_meta).
// D5 contract: "Tier-2 不可关" — audit is NON-OPTIONAL. The `recorder` (ctx.audit)
// records the Tier-2 audit (hash, not body); omitting it is a fail-loud programmer error.
/**
 * The tables entry of the update family's five-point descriptor (C10): fixed
 * `tables/<name>.yaml` layout, `Table` error labels, `TableDefinitionSchema`
 * re-validation, `update_table_meta` audit verb over a `table_name` subject,
 * `table_name` as the ok-receipt's key.
 */
const TABLE_META_DESCRIPTOR = {
  resolveTarget: (semanticLayer: string, name: string) => existingFile(join(semanticLayer, 'tables', `${name}.yaml`)),
  label: 'Table',
  schema: TableDefinitionSchema,
  verb: 'update_table_meta',
  subjectKey: 'table_name',
  resultKey: 'table_name',
} as const satisfies UpdateMetaDescriptor
/**
 * Result of a Tier-2 table-meta update: `{ ok: true, table_name, version }` on
 * success (`version` = the written file's sha256 fingerprint, #108 — a
 * byte-stable no-op write re-serializes to the same bytes, so the fingerprint
 * returned IS the file's current one), or `{ ok: false, error }` when the
 * table is missing/malformed or post-merge validation fails.
 */
export type UpdateTableMetaResult = { ok: true; table_name: string; version: string } | { ok: false; error: string }
/**
 * Tier-2 per-scope write: read-merge-validate-write a single table's meta
 * updates and record the write via `opts.recorder` (D5 non-disableable
 * audit). ADR-0004 ruling 1 / #18: the pre-write raw bytes are snapshotted
 * before the write lands, so a recorder failure can restore the file exactly
 * (disk ends at the pre-write state, not a third unaudited-residue state)
 * before the error propagates. ADR-0004 ruling 8: an optional
 * `opts.expected_version` is checked against the on-disk content fingerprint
 * before the write lands; a mismatch throws `StaleBaselineError` instead.
 * @param semanticLayer - the semantic-layer directory path.
 * @param name - the table `table_name` to update (must already exist on disk).
 * @param updates - the field overrides merged over the existing table YAML.
 * @param opts - the recorder + optional scope id + optional `expected_version` used for the Tier-2 audit record.
 * @returns `{ ok: true, table_name, version }` on success, or `{ ok: false, error }` when the table is missing/malformed or validation fails.
 */
export async function updateTableMeta(
  semanticLayer: string,
  name: string,
  updates: Record<string, unknown>,
  opts: Tier2Opts,
): Promise<UpdateTableMetaResult> {
  return updateMetaFile(semanticLayer, name, updates, opts, TABLE_META_DESCRIPTOR)
}

/**
 * The events entry of the update family's five-point descriptor (C10):
 * `findEventPath` domain-subdir resolution, `Event` error labels,
 * `EventDefinitionSchema` re-validation, `update_event_meta` audit verb over
 * an `event_name` subject, `event_name` as the ok-receipt's key.
 */
const EVENT_META_DESCRIPTOR = {
  resolveTarget: findEventPath,
  label: 'Event',
  schema: EventDefinitionSchema,
  verb: 'update_event_meta',
  subjectKey: 'event_name',
  resultKey: 'event_name',
} as const satisfies UpdateMetaDescriptor

// A13 (TOCTOU lost-update): Tier-2 per-scope event-meta update — read-merge-
// validate-write, parallel to `updateTableMeta`. The event branch of
// `edit_definition` previously dumped the full `merged` dict (computed from a
// stale `existing` load) via `writeEventYaml`, silently reverting any
// concurrent edit to a non-patched field between load+write. Mirrors
// `updateTableMeta`'s re-read-merge-write: re-read the LATEST on-disk event
// YAML at write time, shallow-merge the caller's `updates` on top, validate,
// write. Locates the event file via `findEventPath` (events live in
// `events/<domain>/<name>.yaml`, not a fixed `tables/<name>.yaml` path); a
// missing file is an error (this is an UPDATE, not a create — a concurrently
// deleted event must not be silently re-created here).
/**
 * Result of a Tier-2 event-meta update: `{ ok: true, event_name, version }` on
 * success (`version` = the written file's sha256 fingerprint, #108), or
 * `{ ok: false, error }` when the event is missing/malformed or post-merge
 * validation fails.
 */
export type UpdateEventMetaResult = { ok: true; event_name: string; version: string } | { ok: false; error: string }
/**
 * Tier-2 per-scope write: read-merge-validate-write a single event's meta
 * updates and record the write via `opts.recorder` (D5 non-disableable audit).
 * Mirrors `updateTableMeta` for the event substrate (A13 TOCTOU fix), including
 * ADR-0004 ruling 1's pre-write raw-byte snapshot + recorder-failure rollback
 * and ruling 8's optional `opts.expected_version` staleness check.
 * @param semanticLayer - the semantic-layer directory path.
 * @param name - the event `name` to update (must already exist on disk).
 * @param updates - the field overrides merged over the existing event YAML.
 * @param opts - the recorder + optional scope id + optional `expected_version` used for the Tier-2 audit record.
 * @returns `{ ok: true, event_name, version }` on success, or `{ ok: false, error }` when the event is missing/malformed or validation fails.
 */
export async function updateEventMeta(
  semanticLayer: string,
  name: string,
  updates: Record<string, unknown>,
  opts: Tier2Opts,
): Promise<UpdateEventMetaResult> {
  return updateMetaFile(semanticLayer, name, updates, opts, EVENT_META_DESCRIPTOR)
}

// ── Concept write primitives (#52 / ADR-0012: the concept write path opened) ──
// Mirrors the table pair shape-for-shape: `writeConceptYaml` is the validate-
// then-atomically-write create primitive (the counterpart of `writeTable`),
// `updateConceptMeta` the Tier-2 read-merge-validate-write (the counterpart of
// `updateTableMeta`). Differences from the table pair are all consequences of
// what a concept IS: no on-write enrichment anywhere (concepts have no
// enrichment rounds — #46 verified 'concept' zero-hit in enrichment*.ts), and
// the target file is the fixed `concepts/<name>.yaml` (same convention
// `definitionVersion` already resolves for the read side).
/**
 * Result of a Tier-2 concept-meta update: `{ ok: true, concept_name, version }`
 * on success (`version` = the written file's sha256 fingerprint, #108), or
 * `{ ok: false, error }` when the concept is missing/malformed or post-merge
 * validation fails.
 */
export type UpdateConceptMetaResult = { ok: true; concept_name: string; version: string } | { ok: false; error: string }
/**
 * Result of writing concept YAML: `{ ok: true, path, version }` on success
 * (`version` = the written file's sha256 fingerprint, #108), or
 * `{ ok: false, error }` when the payload fails `ConceptDefinitionSchema`
 * validation (#61: same unified domain-failure face as `WriteTableResult`).
 */
export type WriteConceptYamlResult = { ok: true; path: string; version: string } | { ok: false; error: string }
/**
 * Validate-then-atomically-write a concept YAML (`concepts/<name>.yaml`),
 * invalidating caches on success — `writeTable`'s exact shape applied to the
 * concept layout. The concept write primitive (#52 / ADR-0012): passing
 * `tier2` takes the audited write-and-record path (snapshot-and-rollback on a
 * recorder failure, ADR-0004 ruling 1); omitting it leaves the raw-edit
 * surface whose audit is the caller's responsibility.
 * @param semanticLayer - the semantic-layer directory path.
 * @param name - the concept `name` (becomes the `<name>.yaml` filename).
 * @param data - the concept payload; validated against `ConceptDefinitionSchema` unless skipped.
 * @param opts - `{ skipValidation: true }` skips schema validation (for pre-validated generators).
 * @param tier2 - optional Tier-2 options; passed, this write takes the audited
 *   write-and-record path. The seam checks `expected_version` when one is
 *   supplied, but no caller ever supplies one here — create is the only
 *   concept verb that calls this primitive, and create is baseline-free by
 *   construction (ADR-0005 ruling 7), so the check stays dormant on this path.
 * @returns `{ ok: true, path, version }` on success (`version` = the written
 *   file's sha256 fingerprint), or `{ ok: false, error }` when schema
 *   validation rejects the payload.
 */
export async function writeConceptYaml(
  semanticLayer: string,
  name: string,
  data: unknown,
  opts: { skipValidation?: boolean } = {},
  tier2?: Tier2Opts,
): Promise<WriteConceptYamlResult> {
  if (!opts.skipValidation) {
    const r = ConceptDefinitionSchema.safeParse(data)
    if (!r.success) return { ok: false, error: `Concept validation failed: ${r.error.message}` }
  }
  const target = join(semanticLayer, 'concepts', `${name}.yaml`)
  return writeDefinitionFile(semanticLayer, target, data, tier2, { verb: 'write_concept_yaml', subject: { concept_name: name } })
}
// ── Memory write primitive (ADR-0023 / #152) ─────────────────────────────────
// The data-memory layer's create primitive: `memory/<id>.yaml`, one file per
// entry, append-only (updates are new entries via `supersedes` — never an
// overwrite). Rides the SAME create-family seam (`writeDefinitionFile`) as the
// three definition kinds, so the audited arm inherits ADR-0004 ruling 1's
// snapshot-and-rollback and ruling 3's `beginBatch` absorption for free — #61's
// "ride the seam, never copy the ceremony" rule, applied to the fourth storage
// family. Validation is the caller's (memory.ts's own schema — this primitive
// is the raw-edit half exactly like `writeEventYaml`'s relationship to event
// schemas). Off the public barrel (ADR-0003): the Core class's `recordMemories`
// is the public route, same as the item-write forwards.
/**
 * Result of writing one memory entry: `{ ok: true, path, version }` on success
 * (`version` — the written file's sha256 fingerprint, #108's write-receipt
 * convention), or `{ ok: false, error }` from the write seam (unreachable for
 * a pre-validated entry — kept for the family's uniform face).
 */
export type WriteMemoryYamlResult = { ok: true; path: string; version: string } | { ok: false; error: string }
/**
 * Atomically write one memory entry to `memory/<id>.yaml`, invalidating caches
 * on success — `writeTable`/`writeConceptYaml`'s exact shape applied to the
 * memory layout. Passing `tier2` takes the audited write-and-record path
 * (`record_memory` verb over a `memory_id` subject); inside an open
 * `beginBatch` the per-file record is absorbed and the batch's `end()` makes
 * the one commit ADR-0023 R1 asks for (one write call = one commit).
 * Exclusive-create is the CALLER's loop (memory.ts re-mints on collision) —
 * like `writeTable`, this primitive itself overwrites whatever is at the path.
 * @param semanticLayer - the semantic-layer directory path.
 * @param id - the entry id (becomes `<id>.yaml`; well-formedness was checked upstream).
 * @param data - the parsed entry payload (serialized with the module's YAML dumper).
 * @param tier2 - optional Tier-2 options; present selects the audited half.
 * @returns `{ ok: true, path, version }` or `{ ok: false, error }`.
 */
export async function writeMemoryYaml(
  semanticLayer: string,
  id: string,
  data: unknown,
  tier2?: Tier2Opts,
): Promise<WriteMemoryYamlResult> {
  const target = join(semanticLayer, 'memory', `${id}.yaml`)
  return writeDefinitionFile(semanticLayer, target, data, tier2, { verb: 'record_memory', subject: { memory_id: id } })
}

// ── Verified-query write primitive (ADR-0025 / #155) ────────────────────────
// The query kind's create primitive: `queries/<name>.yaml`, one file per query.
// Rides the SAME create-family seam (`writeDefinitionFile`) as the definition
// kinds and memory, so the audited arm inherits ADR-0004 ruling 1's
// snapshot-and-rollback, ruling 8's `expected_version` staleness check (the
// update verb's baseline — the fingerprint axis ADR-0019 R7 names), and ruling
// 3's `beginBatch` absorption. The query-specific domain validation (canonical
// `uses` existence via the anchor universe, cited memory ids) is the caller's
// (query.ts's `prepareVerifiedQuery`/`missingMemoryIds` — the Core's
// `writeVerifiedQuery` is the public route), exactly like `writeMemoryYaml`'s
// relationship to memory.ts's schema. Off the public barrel (ADR-0003).
/**
 * Result of writing one verified query: `{ ok: true, path, version }` on
 * success (`version` — the written file's sha256 fingerprint, #108's
 * write-receipt convention), or `{ ok: false, error }` when the payload fails
 * `QueryDefinitionSchema` validation.
 */
export type WriteQueryYamlResult = { ok: true; path: string; version: string } | { ok: false; error: string }
/**
 * Validate-then-atomically-write one verified-query YAML
 * (`queries/<name>.yaml`), invalidating caches on success — `writeTable` /
 * `writeConceptYaml`'s exact shape applied to the query layout. The
 * `create_verified_query` / `update_verified_query` tool pair compiles here:
 * create passes no `expected_version` (baseline-free by construction), update
 * passes the `get_definition(kind:'query')` fingerprint (a mismatch throws
 * `StaleBaselineError` inside the seam). Like `writeTable`, this primitive
 * itself overwrites — existence is the tool handler's pre-check.
 * @param semanticLayer - the semantic-layer directory path.
 * @param name - the query `name` (becomes the `<name>.yaml` filename).
 * @param data - the query payload; validated against `QueryDefinitionSchema` unless skipped.
 * @param opts - `{ skipValidation: true }` skips schema validation (for pre-validated generators).
 * @param tier2 - optional Tier-2 options; present selects the audited half.
 * @returns `{ ok: true, path, version }` or `{ ok: false, error }`.
 */
export async function writeQueryYaml(
  semanticLayer: string,
  name: string,
  data: unknown,
  opts: { skipValidation?: boolean } = {},
  tier2?: Tier2Opts,
): Promise<WriteQueryYamlResult> {
  if (!opts.skipValidation) {
    const r = QueryDefinitionSchema.safeParse(data)
    if (!r.success) return { ok: false, error: `Query validation failed: ${r.error.message}` }
  }
  const target = join(semanticLayer, 'queries', `${name}.yaml`)
  return writeDefinitionFile(semanticLayer, target, data, tier2, { verb: 'write_query_yaml', subject: { query_name: name } })
}

/**
 * The concepts entry of the update family's five-point descriptor (C10):
 * fixed `concepts/<name>.yaml` layout, `Concept` error labels,
 * `ConceptDefinitionSchema` re-validation, `update_concept_meta` audit verb
 * over a `concept_name` subject, `concept_name` as the ok-receipt's key.
 */
const CONCEPT_META_DESCRIPTOR = {
  resolveTarget: (semanticLayer: string, name: string) => existingFile(join(semanticLayer, 'concepts', `${name}.yaml`)),
  label: 'Concept',
  schema: ConceptDefinitionSchema,
  verb: 'update_concept_meta',
  subjectKey: 'concept_name',
  resultKey: 'concept_name',
} as const satisfies UpdateMetaDescriptor
/**
 * Tier-2 per-scope write: read-merge-validate-write a single concept's meta
 * updates and record the write via `opts.recorder` (D5 non-disableable audit).
 * `updateTableMeta`'s exact ceremony for the concept layout: pre-write raw-byte
 * snapshot + recorder-failure rollback (ADR-0004 ruling 1), optional
 * `opts.expected_version` staleness check against the on-disk fingerprint
 * (ruling 8), full-schema validation of the merged document before the write.
 * Concepts have no on-write enrichment hook — there is no round that could
 * re-derive concept content (#46), so the caller's post-write health question
 * does not arise.
 * @param semanticLayer - the semantic-layer directory path.
 * @param name - the concept `name` to update (must already exist on disk).
 * @param updates - the field overrides merged over the existing concept YAML.
 * @param opts - the recorder + optional scope id + optional `expected_version` used for the Tier-2 audit record.
 * @returns `{ ok: true, concept_name, version }` on success, or `{ ok: false, error }` when the concept is missing/malformed or validation fails.
 */
export async function updateConceptMeta(
  semanticLayer: string,
  name: string,
  updates: Record<string, unknown>,
  opts: Tier2Opts,
): Promise<UpdateConceptMetaResult> {
  return updateMetaFile(semanticLayer, name, updates, opts, CONCEPT_META_DESCRIPTOR)
}

// ── CL-18 Phase 2: partition-column exclude set (calling-layer metadata) ───
// Moved here from index.ts in slice 5: convention-coupled (the fallback list
// hardcodes the standard MaxCompute business-date partition spellings), so it
// is off the v0.1 public barrel (ADR-0003) while staying reachable in-repo.
/**
 * CL-18 Phase 2: minimal fallback blocklist of partition column names used
 * when a target table has no `role: 'partition'` columns to drive a
 * data-driven exclude set. These three names are the standard MaxCompute
 * business-date partition spellings; hardcoding them keeps the substrate's
 * `discoverRelationsDeterministic` free of any specific metadata format while
 * still catching the common noise (a DIM keyed by `ds` matching every DWS).
 */
const DEFAULT_PARTITION_BLOCKLIST: readonly string[] = ['ds', 'pt', 'dt']

/**
 * CL-18 Phase 2: build the partition-column exclude set for a target table.
 *
 * Strategy (layered, per the ticket design):
 *  - **Data-driven (preferred)**: when the table has columns tagged
 *    `role: 'partition'`, those names form the exclude set. This is the
 *    high-precision path — it excludes exactly the partition columns the
 *    analyst declared for THIS table, including any custom partition names
 *    beyond `ds`/`pt`/`dt`.
 *  - **Fallback blocklist**: when the table has NO `role: 'partition'`
 *    columns (e.g. a sync-written table whose partition columns live in the
 *    separate `partitions` array rather than `columns`, or an unannotated
 *    dataset), fall back to the minimal `DEFAULT_PARTITION_BLOCKLIST`
 *    (`ds`/`pt`/`dt`). This still filters the common noise without depending
 *    on metadata annotations.
 *
 * The result is forwarded into `discoverRelationsFor` via
 * `enrichAllDwsTables`'s `excludeColumnsFn` so the deterministic PK match
 * skips partition columns (e.g. an `_arch` DIM snapshot keyed by `ds` no
 * longer matches every DWS carrying a `ds` column).
 * @param def - the target table definition.
 * @returns a set of column names to exclude from deterministic PK matching (never empty).
 */
export function buildExcludeColumns(def: TableDefinition): Set<string> {
  const partitionCols = def.columns.filter(c => c.role === 'partition').map(c => c.name)
  return partitionCols.length > 0 ? new Set(partitionCols) : new Set(DEFAULT_PARTITION_BLOCKLIST)
}

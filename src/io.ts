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
 * @module io (internal; only `"."` is importable — see ADR-0002)
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { writeFileAtomic } from './vendor/atomic-write.ts'
import {
  EventDefinitionSchema,
  TableDefinitionSchema,
  ConceptDefinitionSchema,
  type EventDefinition,
  type TableDefinition,
  type ConceptDefinition,
  type TableMeta,
} from './types.ts'
import {
  buildRetrievalCorpus,
  isPlainObject,
  type CorpusVariant,
  type EventCorpusInput,
  type EventCorpusItem,
} from './corpus.ts'

/** Tier-2 recorder contract — `ctx.audit` satisfies this (P6b grilling Q4). */
export interface Tier2Recorder {
  recordTier2Write(
    toolName: string,
    payload: unknown,
    opts?: {
      readonly scope_id?: string
      readonly session_id?: string
      readonly tenant_id?: string
      readonly user_id?: string
    },
  ): string
}

/** Tier-2 write options: the recorder (ctx.audit) and optional scope id. */
export interface Tier2Opts {
  /** ctx.audit (or a test double) — required; Tier-2 audit is non-disableable (D5 "不可关"). */
  readonly recorder: Tier2Recorder
  readonly scope_id?: string
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
  return yaml.load(readFileSync(path, 'utf-8'))
}

// ── Atomic write (mirrors writer._atomic_write via @deepseek-ai/dsh-atomic-write) ──
const YAML_MODE = 0o644
async function atomicWrite(path: string, obj: unknown): Promise<void> {
  const text = typeof obj === 'string' ? obj : dumpYaml(obj)
  await writeFileAtomic(path, text, { mode: YAML_MODE })
}

// ── Cache-invalidation hooks (ADR-0011 contract) ─────────────────────────
const _invalidationHooks: Array<(semanticLayer: string) => void> = []
/**
 * Register a cache-invalidation hook fired by `invalidateCaches` (ADR-0011).
 * @param hook - the callback invoked with the semantic-layer path being invalidated.
 * @returns the result
 */
export function registerInvalidationHook(hook: (semanticLayer: string) => void): () => void {
  _invalidationHooks.push(hook)
  return () => {
    const i = _invalidationHooks.indexOf(hook)
    if (i >= 0) _invalidationHooks.splice(i, 1)
  }
}

// D2f: per-path corpus-version counter bumped on every invalidateCaches call.
// A cached enriched Bm25Linker (tool-search-data-sources, keyed by ctx.schema)
// probes SemanticGroundingCore.corpusVersion() and rebuilds on a mismatch, so a
// mid-session event edit (writeEventYaml -> invalidateCaches) no longer leaves
// the enriched linker stale until reboot (D2e-deferred cache-invalidation).
// Path-scoped: a write to layer A bumps only A's counter. Table writes
// (writeTable/updateTableMeta/syncWriteDefinitions) also bump it — the corpus
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
 * Fire every registered invalidation hook for `semanticLayer` (best-effort: a broken hook cannot block the write).
 * @param semanticLayer - the semantic-layer path being invalidated.
 */
export function invalidateCaches(semanticLayer: string): void {
  _corpusVersion.set(semanticLayer, (_corpusVersion.get(semanticLayer) ?? 0) + 1)
  for (const hook of _invalidationHooks) {
    try {
      hook(semanticLayer)
    } catch {
      // best-effort — a broken hook must not block the write
    }
  }
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

// ── Writer (mirrors writer.py: validate-before-dump, atomic, invalidate) ──
/** Error thrown by `writeTable` when `TableDefinitionSchema.safeParse` rejects the payload (unless `skipValidation` is set). */
export class WriteValidationError extends Error {}
/**
 * Validate-then-atomically-write a table YAML (mirrors writer.write_table),
 * invalidating caches on success.
 * @param semanticLayer - the semantic-layer directory path.
 * @param name - the table `table_name` (becomes the `<name>.yaml` filename).
 * @param data - the table payload; validated against `TableDefinitionSchema` unless skipped.
 * @param opts - `{ skipValidation: true }` skips schema validation (for pre-validated generators).
 * @returns the absolute path of the written `<name>.yaml` under `tables/`.
 */
export async function writeTable(
  semanticLayer: string,
  name: string,
  data: unknown,
  opts: { skipValidation?: boolean } = {},
): Promise<string> {
  if (!opts.skipValidation) {
    const r = TableDefinitionSchema.safeParse(data)
    if (!r.success) throw new WriteValidationError(`Table validation failed: ${r.error.message}`)
  }
  const tablesPath = join(semanticLayer, 'tables')
  const target = join(tablesPath, `${name}.yaml`)
  await atomicWrite(target, data)
  invalidateCaches(semanticLayer)
  return target
}
/**
 * Result of writing event YAML: either `{ ok: true, path }` on success or
 * `{ ok: false, error }` when the YAML is unparseable/not-an-object or its
 * `name` does not match `name`.
 */
export type WriteEventYamlResult = { ok: true; path: string } | { ok: false; error: string }
// writeEventYaml = raw-edit surface (mirrors writer.write_event_yaml used by approve_event_yaml):
// no model_validate (the write IS the repair surface; load validates on read). Name-match check.
/**
 * Raw-edit surface for event YAML: parse the content, verify its `name` matches,
 * then atomically write it to the discovered event path (or
 * `events/_suggested/<name>.yaml` when new). No schema validation — the write
 * IS the repair surface; `loadEvents` validates on read.
 * @param semanticLayer - the semantic-layer directory path.
 * @param name - the event `name` the content must declare.
 * @param content - the raw YAML text to write verbatim.
 * @returns `{ ok: true, path }` on success, or `{ ok: false, error }` describing the parse/name-mismatch failure.
 */
export async function writeEventYaml(
  semanticLayer: string,
  name: string,
  content: string,
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
  await atomicWrite(target, content)
  invalidateCaches(semanticLayer)
  return { ok: true, path: target }
}
// Tier-2 per-scope persistent write: read-merge-validate-write + audit (mirrors writer.update_table_meta).
// D5 contract: "Tier-2 不可关" — audit is NON-OPTIONAL. The `recorder` (ctx.audit)
// records the Tier-2 audit (hash, not body); omitting it is a fail-loud programmer error.
/**
 * Result of a Tier-2 table-meta update: `{ ok: true, table_name }` on success,
 * or `{ ok: false, error }` when the table is missing/malformed or post-merge
 * validation fails.
 */
export type UpdateTableMetaResult = { ok: true; table_name: string } | { ok: false; error: string }
/**
 * Tier-2 per-scope write: read-merge-validate-write a single table's meta
 * updates and record the write via `opts.recorder` (D5 non-disableable audit).
 * @param semanticLayer - the semantic-layer directory path.
 * @param name - the table `table_name` to update (must already exist on disk).
 * @param updates - the field overrides merged over the existing table YAML.
 * @param opts - the recorder + optional scope id used for the Tier-2 audit record.
 * @returns `{ ok: true, table_name }` on success, or `{ ok: false, error }` when the table is missing/malformed or validation fails.
 */
export async function updateTableMeta(
  semanticLayer: string,
  name: string,
  updates: Record<string, unknown>,
  opts: Tier2Opts,
): Promise<UpdateTableMetaResult> {
  const tf = join(semanticLayer, 'tables', `${name}.yaml`)
  if (!existsSync(tf)) return { ok: false, error: `Table not found: ${name}` }
  const data = readYaml(tf)
  if (typeof data !== 'object' || data === null) return { ok: false, error: `Table malformed: ${name}` }
  const merged: Record<string, unknown> = { ...(data as Record<string, unknown>), ...updates }
  const r = TableDefinitionSchema.safeParse(merged)
  if (!r.success) return { ok: false, error: `Validation failed after update: ${r.error.message}` }
  await atomicWrite(tf, merged)
  invalidateCaches(semanticLayer)
  opts.recorder.recordTier2Write('update_table_meta', { table_name: name, updates }, opts.scope_id !== undefined ? { scope_id: opts.scope_id } : {})
  return { ok: true, table_name: name }
}

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
 * Result of a Tier-2 event-meta update: `{ ok: true, event_name }` on success,
 * or `{ ok: false, error }` when the event is missing/malformed or post-merge
 * validation fails.
 */
export type UpdateEventMetaResult = { ok: true; event_name: string } | { ok: false; error: string }
/**
 * Tier-2 per-scope write: read-merge-validate-write a single event's meta
 * updates and record the write via `opts.recorder` (D5 non-disableable audit).
 * Mirrors `updateTableMeta` for the event substrate (A13 TOCTOU fix).
 * @param semanticLayer - the semantic-layer directory path.
 * @param name - the event `name` to update (must already exist on disk).
 * @param updates - the field overrides merged over the existing event YAML.
 * @param opts - the recorder + optional scope id used for the Tier-2 audit record.
 * @returns `{ ok: true, event_name }` on success, or `{ ok: false, error }` when the event is missing/malformed or validation fails.
 */
export async function updateEventMeta(
  semanticLayer: string,
  name: string,
  updates: Record<string, unknown>,
  opts: Tier2Opts,
): Promise<UpdateEventMetaResult> {
  const ef = findEventPath(semanticLayer, name)
  if (ef === null) return { ok: false, error: `Event not found: ${name}` }
  const data = readYaml(ef)
  if (typeof data !== 'object' || data === null) return { ok: false, error: `Event malformed: ${name}` }
  const merged: Record<string, unknown> = { ...(data as Record<string, unknown>), ...updates }
  const r = EventDefinitionSchema.safeParse(merged)
  if (!r.success) return { ok: false, error: `Validation failed after update: ${r.error.message}` }
  await atomicWrite(ef, merged)
  invalidateCaches(semanticLayer)
  opts.recorder.recordTier2Write('update_event_meta', { event_name: name, updates }, opts.scope_id !== undefined ? { scope_id: opts.scope_id } : {})
  return { ok: true, event_name: name }
}

// ── Sync-write (mirrors rbi_semantic/sync.py: YAML-write-only, receives pre-fetched schema dicts) ──
// ODPS-DECOUPLED: receives TableMeta[] (from ctx.schema.discover/describe) and writes YAML.
// Does NOT touch ODPS — that lives in the query-engine MaxCompute sidecar (P4 / ⑤a).
const MEASURE_TYPES = new Set(['BIGINT', 'INT', 'DOUBLE', 'FLOAT', 'DECIMAL'])
const MEASURE_SUFFIXES = ['_count', '_cnt', '_sum', '_amt', '_amount', '_avg', '_total', '_num']
const LABEL_SUFFIXES = ['_name', '_desc', '_label', '_title']
type MergeColumn = { name: string; type: string; role?: string; comment?: string }
/**
 * Infer a column's semantic role (dimension/measure/attribute) from its name + type (mirrors RBI infer_role).
 * @param col - the column with optional `name`/`type` (defaults apply when absent).
 * @returns the inferred role: `dimension`, `measure`, or `attribute`.
 */
export function inferRole(col: { name?: string; type?: string }): string {
  const t = (col.type ?? '').toUpperCase()
  const n = (col.name ?? '').toLowerCase()
  if (n === 'ds' || n === 'dt' || n === 'date') return 'dimension'
  if (n.endsWith('_id')) return 'dimension'
  if (MEASURE_TYPES.has(t) && MEASURE_SUFFIXES.some(s => n.endsWith(s))) return 'measure'
  if (t === 'STRING') return 'dimension'
  if (MEASURE_TYPES.has(t)) return 'measure'
  return 'attribute'
}
/**
 * Generate a DWS (fact) table YAML skeleton from a table meta (mirrors sync.generate_table_yaml).
 * @param meta - the table meta (name + columns + partitions + comment) to generate from.
 * @returns a draft `TableDefinition`-shaped dict (confirmation=draft, empty description/granularity).
 */
export function generateTableYaml(meta: TableMeta): Record<string, unknown> {
  const columns = meta.columns.map(c => ({ name: c.name, type: c.type, comment: c.comment ?? '', role: inferRole(c) }))
  return {
    table_name: meta.table_name,
    table_comment: meta.comment ?? '',
    description: '',
    domains: [],
    granularity: '',
    columns,
    metrics: {},
    partitions: meta.partitions.map(p => ({ name: p.name, type: p.type })),
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
  }
}
/**
 * Generate a DIM (dimension) table YAML skeleton from a table meta, deriving
 * `primary_key` (first `*_id` column) and `label_columns` (string columns
 * ending in label suffixes) for `.superRefine` validation (mirrors sync.generate_dim_yaml).
 * @param meta - the table meta to generate the dimension table from.
 * @returns a draft DIM `TableDefinition`-shaped dict (kind='dim', confirmation=draft).
 */
export function generateDimYaml(meta: TableMeta): Record<string, unknown> {
  const columns = meta.columns.map(c => ({ name: c.name, type: c.type, comment: c.comment ?? '', role: inferRole(c) }))
  const pkCol = meta.columns.find(c => c.name.endsWith('_id'))
  const primaryKey = pkCol !== undefined ? [pkCol.name] : []
  const labelColumns = meta.columns
    .filter(c => c.type.toUpperCase() === 'STRING' && LABEL_SUFFIXES.some(s => c.name.toLowerCase().endsWith(s)))
    .map(c => c.name)
  return {
    table_name: meta.table_name,
    table_comment: meta.comment ?? '',
    description: '',
    domains: [],
    kind: 'dim',
    primary_key: primaryKey,
    primary_key_unique: null,
    label_columns: labelColumns,
    freshness: 'static_reference',
    granularity: '维表(非分区,全量参考,无时间维度)',
    columns,
    metrics: {},
    partitions: meta.partitions.map(p => ({ name: p.name, type: p.type })),
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
  }
}
// merge_columns: preserve analyst role corrections (existing role overrides inferred).
/**
 * Merge new table-meta columns over existing columns, preserving analyst role
 * corrections (an existing `role` overrides the inferred role; a missing
 * column is inferred fresh). Mirrors sync.merge_columns.
 * @param existingCols - the existing columns carrying analyst role overrides.
 * @param newMetaCols - the freshly-fetched columns to merge over.
 * @returns the merged columns (each with a non-empty `role` and `comment`).
 */
export function mergeColumns(
  existingCols: ReadonlyArray<MergeColumn>,
  newMetaCols: ReadonlyArray<{ name: string; type: string; comment?: string | null | undefined }>,
): Array<{ name: string; type: string; role: string; comment: string }> {
  const existing = new Map(existingCols.map(c => [c.name, c]))
  const out: Array<{ name: string; type: string; role: string; comment: string }> = []
  for (const col of newMetaCols) {
    const old = existing.get(col.name)
    if (old !== undefined) {
      out.push({ name: col.name, type: col.type, role: old.role || inferRole(col), comment: col.comment ?? old.comment ?? '' })
    } else {
      out.push({ name: col.name, type: col.type, role: inferRole(col), comment: col.comment ?? '' })
    }
  }
  return out
}
/**
 * Merge a freshly-fetched table meta into an existing table YAML: overwrite
 * `columns` (via `mergeColumns`) when present and always refresh `partitions`.
 * @param existing - the existing table YAML dict.
 * @param newMeta - the freshly-fetched table meta to merge in.
 * @returns a new merged dict (shallow-copy of `existing` with refreshed `columns`/`partitions`).
 */
export function mergeChangedYaml(existing: Record<string, unknown>, newMeta: TableMeta): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing }
  const existingColsRaw = existing.columns
  if (newMeta.columns.length > 0 && Array.isArray(existingColsRaw)) {
    out.columns = mergeColumns(existingColsRaw, newMeta.columns)
  }
  out.partitions = newMeta.partitions.map(p => ({ name: p.name, type: p.type }))
  return out
}
// sync_write_definitions: batch write a list of TableMeta (mirrors rbi_semantic.sync.sync_write_definitions).
// D5: sync-write = ops/admin Tier-2, "不可关" — audit is NON-OPTIONAL (recorder required).
/**
 * Tier-2 batch sync-write: for each table meta, generate (or merge when an
 * existing entry is supplied) the table YAML and write it via `writeTable`,
 * recording each write through `opts.recorder` (D5 non-disableable audit).
 * Tables are independently fail-tolerant: a thrown write becomes an error
 * string rather than aborting the batch.
 * @param semanticLayer - the semantic-layer directory path.
 * @param tableMetas - the table metas to write (metas with empty `table_name` are skipped).
 * @param opts - the recorder, optional dim-table-name set (generates DIM YAML), and optional existing-table map (merges).
 * @returns counts of `written`/`skipped` plus a per-table `errors` list.
 */
export async function syncWriteDefinitions(
  semanticLayer: string,
  tableMetas: readonly TableMeta[],
  opts: Tier2Opts & {
    readonly dimTableNames?: Set<string>
    readonly existingTables?: Map<string, Record<string, unknown>>
  },
): Promise<{ written: number; skipped: number; errors: string[] }> {
  let written = 0
  let skipped = 0
  const errors: string[] = []
  const dimTableNames = opts.dimTableNames ?? new Set<string>()
  const existingTables = opts.existingTables ?? new Map<string, Record<string, unknown>>()
  for (const meta of tableMetas) {
    const tname = meta.table_name
    if (!tname) {
      skipped += 1
      continue
    }
    try {
      let doc: Record<string, unknown>
      let isDim = false
      const existing = existingTables.get(tname)
      if (existing !== undefined) {
        doc = mergeChangedYaml(existing, meta)
      } else if (dimTableNames.has(tname)) {
        doc = generateDimYaml(meta)
        isDim = true
      } else {
        doc = generateTableYaml(meta)
      }
      // DIM path validates against .superRefine (pk + label_columns) — do NOT silently
      // emit primary_key:[] / label_columns:[] that fails .superRefine on read.
      // DWS/merge keep skipValidation (generation pre-validates; DWS has no kind constraint).
      await writeTable(semanticLayer, tname, doc, { skipValidation: !isDim })
      opts.recorder.recordTier2Write('sync_write_definitions', { table_name: tname }, opts.scope_id !== undefined ? { scope_id: opts.scope_id } : {})
      written += 1
    } catch (e) {
      errors.push(`${tname}: ${(e as Error).message}`)
    }
  }
  return { written, skipped, errors }
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

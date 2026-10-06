/**
 * Metrics extraction (B5) — mechanical, deterministic projection of inline
 * `metrics:` blocks (Record<string, MetricDef>) on table/event definitions
 * into derived MetricDefinitions (kind=metric). M1 virtual projection: no
 * standalone `metrics/*.yaml` files are written or read — every metric is
 * derived at retrieval time from its host table/event's `metrics:` block.
 *
 * G3 §6: Phase 1 = mechanical extraction (no LLM). Each entry → one derived
 * metric; a `derived_from` relation to the source table is auto-established.
 *
 * @module @deepseek-ai/dsh-semantic-layer/src/metrics
 */
import {
  TableDefinitionSchema,
  EventDefinitionSchema,
  type TableDefinition,
  type EventDefinition,
  type MetricDef,
  type MetricDefinition,
} from './types.ts'
import type { GraphNodeProjection } from './registry.ts'
import { loadTables, loadEvents } from './io.ts'

// ── helpers (best-effort, deterministic) ───────────────────────────────

const AGG_RE = /^\s*(COUNT_DISTINCT|COUNT|SUM|AVG|MIN|MAX)\s*\((.*)\)\s*$/i

/**
 * Infer the aggregation verb + field from a metric expression (best-effort).
 * `SUM(pay_amt)` → `{ aggregation: 'sum', field: 'pay_amt' }`; `COUNT(*)` →
 * `{ aggregation: 'count', field: '*' }`; `COUNT(DISTINCT user_id)` →
 * `{ aggregation: 'count_distinct', field: 'user_id' }`. Unknown expressions
 * yield empty strings (the expression is still preserved in `computation.sql`).
 * @param expression - the metric expression (e.g. `SUM(pay_amt)`).
 * @returns the inferred aggregation verb + field (empty when not inferable).
 */
export function inferAggregation(expression: string): { aggregation: string; field: string } {
  const m = AGG_RE.exec(expression)
  if (!m) return { aggregation: '', field: '' }
  let agg = (m[1] ?? '').toLowerCase()
  let field = (m[2] ?? '').trim()
  const dm = /^DISTINCT\s+(.+)$/i.exec(field)
  if (agg === 'count' && dm) {
    agg = 'count_distinct'
    field = (dm[1] ?? '').trim()
  }
  return { aggregation: agg, field }
}

const SEP = '__'

/**
 * Build the unique metric name for one (source, metric-key) pair, namespaced
 * `<source>__<key>` so shared keys (e.g. `row_count`) do not collide across
 * the 321 tables.
 * @param source - the table/event name the metric was extracted from.
 * @param key - the metric key in the source's `metrics:` record.
 * @returns the namespaced metric name.
 */
export function metricName(source: string, key: string): string {
  return `${source}${SEP}${key}`
}

/**
 * Split a namespaced metric name (`<source>__<key>`, as built by {@link metricName})
 * back into its host source + key. Splits on the LAST `__` so a source or key
 * that itself contains `__` is handled (the trailing segment is the key).
 * Returns null when the name has no `__` separator or it sits at the start
 * (no host). The inverse of {@link metricName}.
 *
 * Used by `SemanticLayerService.loadMetricDefinition` and
 * `DefinitionSnapshot.loadMetricDefinition` to recover the host + key from a
 * metric name and look the key up in the host's inline `metrics:` block (M1
 * virtual projection — no standalone `metrics/*.yaml` files are read).
 * @param name - the namespaced metric name.
 * @returns `{ host, key }` or null when the name is not a `<host>__<key>` pair.
 */
export function splitMetricName(name: string): { host: string; key: string } | null {
  const sep = name.lastIndexOf(SEP)
  if (sep <= 0) return null
  return { host: name.slice(0, sep), key: name.slice(sep + SEP.length) }
}

/**
 * Convert one inline MetricDef (from a table/event `metrics:` block) into a
 * standalone MetricDefinition. `expression` → `computation.sql`,
 * `source` → `computation.metadata.source`, and a `derived_from` relation to
 * the source is auto-established (B5 "自动建立 derived_from 关系").
 *
 * Carries the host block's `caliber_variants` onto the derived metric so the
 * planner retains its Type B disambiguation signal (M1c: restores signal lost
 * when metrics were flattened to standalone YAMLs).
 * @param source - the table/event name the metric was extracted from.
 * @param key - the metric key in the source's `metrics:` record.
 * @param def - the inline metric definition (expression + description + caliber_variants).
 * @param domains - the source's domains, copied onto the metric.
 * @returns a MetricDefinition (kind=metric) ready for virtual projection.
 */
export function toMetricDefinition(
  source: string,
  key: string,
  def: MetricDef,
  domains: readonly string[],
): MetricDefinition {
  const { aggregation, field } = inferAggregation(def.expression)
  return {
    kind: 'metric',
    name: metricName(source, key),
    description: def.description,
    alt_labels: [...def.alt_labels],
    domains: [...domains],
    caliber_variants: [...def.caliber_variants],
    computation: {
      sql: def.expression,
      metadata: {
        aggregation,
        field,
        source,
        time_grain: '',
      },
    },
    relations: [
      {
        type: 'derived_from',
        target: source,
        on: '',
        description: `机械提取自 ${source} 的 metrics 块（key=${key}）`,
      },
    ],
  }
}

/**
 *  Project a derived MetricDefinition to a kind:metric CorpusItem for BM25 indexing.
 * @param def - def
 * @returns the result
 */
export function projectMetricCorpusItem(def: MetricDefinition): { id: string; description?: string; payload: MetricDefinition } {
  const parts: string[] = []
  if (def.description) parts.push(def.description)
  if (def.computation.metadata.aggregation) parts.push(def.computation.metadata.aggregation)
  if (def.computation.metadata.field) parts.push(def.computation.metadata.field)
  return {
    id: def.name,
    ...(parts.length > 0 ? { description: parts.join(' ') } : {}),
    payload: def,
  }
}

/**
 *  Derive relation edges for a metric (derived_from → source; plus any explicit).
 * @param def - def
 * @returns the result
 */
export function deriveMetricRelations(def: MetricDefinition): { type: 'joins' | 'derived_from' | 'related_to'; target: string; on?: string; description?: string }[] {
  return def.relations.map(r => ({
    type: r.type, target: r.target,
    ...(r.on ? { on: r.on } : {}),
    ...(r.description ? { description: r.description } : {}),
  }))
}

/**
 * Extract MetricDefinitions from one parsed table definition (one per
 * `metrics:` entry). Pure: no I/O.
 * @param def - the parsed table definition.
 * @returns a MetricDefinition per `metrics:` entry (empty when none).
 */
export function extractMetricsFromTable(def: TableDefinition): MetricDefinition[] {
  const out: MetricDefinition[] = []
  for (const [key, mdef] of Object.entries(def.metrics)) {
    out.push(toMetricDefinition(def.table_name, key, mdef, def.domains))
  }
  return out
}

/**
 * Extract MetricDefinitions from one parsed event definition (one per
 * `metrics:` entry). Pure: no I/O.
 * @param def - the parsed event definition.
 * @returns a MetricDefinition per `metrics:` entry (empty when none).
 */
export function extractMetricsFromEvent(def: EventDefinition): MetricDefinition[] {
  const out: MetricDefinition[] = []
  for (const [key, mdef] of Object.entries(def.metrics)) {
    out.push(toMetricDefinition(def.name, key, mdef, def.domains))
  }
  return out
}

/**
 * Extract all MetricDefinitions from a semantic layer: every table's +
 * event's `metrics:` blocks. Pure: returns the definitions, does not write.
 * Lenient: tables/events that fail schema parse are skipped (mirrors the
 * lenient `loadTables`/`loadEvents` scans).
 * @param semanticLayer - the semantic-layer directory path.
 * @returns every extracted MetricDefinition (one per `metrics:` entry).
 */
export function extractMetricsFromTables(semanticLayer: string): MetricDefinition[] {
  const out: MetricDefinition[] = []
  for (const t of loadTables(semanticLayer)) {
    const r = TableDefinitionSchema.safeParse(t.raw)
    if (!r.success) continue
    out.push(...extractMetricsFromTable(r.data))
  }
  for (const e of loadEvents(semanticLayer)) {
    const r = EventDefinitionSchema.safeParse(e.raw)
    if (!r.success) continue
    out.push(...extractMetricsFromEvent(r.data))
  }
  return out
}

/**
 * Derive every metric definition at retrieval time from the semantic layer's
 * table + event `metrics:` blocks (M1 virtual projection — no standalone
 * `metrics/*.yaml` files are read). Each inline `metrics:` entry becomes one
 * MetricDefinition via {@link extractMetricsFromTables}. Pure derivation
 * (mechanical, deterministic) replaces the prior read-from-disk scan.
 * @param semanticLayer - the semantic-layer directory path.
 * @returns the derived MetricDefinitions (empty when no table/event has metrics).
 */
export function loadMetricDefinitions(semanticLayer: string): MetricDefinition[] {
  return extractMetricsFromTables(semanticLayer)
}

/**
 * Project one derived metric as a `metric` graph node (W27). `metric` is not a
 * registered kind — metrics are virtual, derived from host table/event
 * `metrics:` blocks — so the `table` and `event` kinds reach the graph with
 * them through their declared `derivedNodes` contributor, which uses this as
 * its `toGraphNode`.
 * @param def - a derived metric definition.
 * @returns the `metric`-kind graph node for that metric.
 */
export function metricGraphNode(def: MetricDefinition): GraphNodeProjection {
  return {
    id: def.name,
    kind: 'metric',
    label: def.name,
    domains: [...def.domains],
  }
}

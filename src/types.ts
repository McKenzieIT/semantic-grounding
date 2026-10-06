/**
 * P6b semantic-layer substrate — zod schemas mirroring RBI pydantic.
 *
 * Source of truth for the mirrored shapes: reverse-bi/libs/rbi-core/src/rbi_core/models/semantic.py
 * (EventDefinition / TableDefinition + sub-models). Every model is _Loose
 * (extra='allow') => zod `.passthrough()` so unknown keys round-trip
 * (forward-compat, mirrors RBI A1 round-trip needs). `canonicalizeType` mirrors
 * RBI canonicalize_type (physical -> DB-agnostic logical).
 *
 * P6b grilling: zod (NOT schemastery — schemastery has no `.passthrough`, and
 * mirroring pydantic `extra=allow` / `model_validator` / `canonicalize_type`
 * requires zod's `.passthrough` / `.refine` / `.superRefine` / `.transform`).
 * Substrate deps = zod + js-yaml only (P6 D2).
 *
 * Schemas are named `XxxSchema` (the zod schema value) + `Xxx` (the inferred
 * type) so consumers (P13b swap) import the type for `params_fields` /
 * `partitions` access without colliding with the schema value.
 *
 * @module @deepseek-ai/dsh-semantic-layer/src/types
 */
import { z } from 'zod'

// ── Canonical logical type vocabulary (A2) ──────────────────────────────
// reverse-bi normalizes physical type spellings to a small DB-agnostic set so
// the LLM never sees dialect noise (bigint vs int8). Mirrors
// rbi_core/models/semantic.py:_CANONICAL_TYPE_MAP.
const CANONICAL_TYPE_MAP: Readonly<Record<string, string>> = {
  int: 'int', integer: 'int', bigint: 'int', tinyint: 'int', smallint: 'int', long: 'int',
  int2: 'int', int4: 'int', int8: 'int', serial: 'int',
  decimal: 'decimal', numeric: 'decimal', number: 'decimal', float: 'decimal', double: 'decimal',
  real: 'decimal', float4: 'decimal', float8: 'decimal',
  string: 'string', text: 'string', varchar: 'string', char: 'string', bpchar: 'string',
  bool: 'bool', boolean: 'bool',
  date: 'datetime', datetime: 'datetime', timestamp: 'datetime', timestamptz: 'datetime',
  json: 'json', jsonb: 'json', object: 'json', map: 'json', struct: 'json',
  array: 'array', list: 'array',
  binary: 'binary', bytea: 'binary', varbinary: 'binary',
}

/**
 * Mirrors canonicalize_type: complex/parametrized types (array<...>, map<...>,
 * struct<...>, decimal(p,s)) preserved verbatim; unknown scalars pass through.
 * @param raw - the physical type spelling to canonicalize (empty string passes through).
 * @returns the canonical logical type, or the verbatim input for complex/unknown types.
 */
export function canonicalizeType(raw: string): string {
  if (!raw) return raw
  const t = raw.trim()
  if (t.includes('<') || t.includes('(')) return t
  return CANONICAL_TYPE_MAP[t.toLowerCase()] ?? t
}

// pydantic field_validator(mode="before") on type => zod .transform
// (post-parse canonicalize; input "bigint" -> stored "int", round-trips canonicalized).
// .default('') mirrors RBI ParamField/ColumnDef/PartitionDef `type: str = ""`
// (RBI accepts an omitted type; without .default zod would reject it).
const canonType = () => z.string().default('').transform(canonicalizeType)

// ── Sub-models (all _Loose => .passthrough()) ───────────────────────────
/** Zod schema for a table/event confirmation record (status + confirmed_by + confirmed_at); mirrors RBI Confirmation. */
export const ConfirmationSchema = z.object({
  status: z.string().default('draft'),
  confirmed_by: z.string().default(''),
  confirmed_at: z.string().default(''),
}).loose()
/** Inferred type of {@link ConfirmationSchema} (status + confirmed_by + confirmed_at). */
export type Confirmation = z.infer<typeof ConfirmationSchema>

/** Zod schema for a coverage report (scenarios + limitations + status); mirrors RBI CoverageDef. */
export const CoverageDefSchema = z.object({
  scenarios: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  coverage_status: z.string().default('draft'),
}).loose()
/** Inferred type of {@link CoverageDefSchema} (scenarios + limitations + coverage_status). */
export type CoverageDef = z.infer<typeof CoverageDefSchema>

/** Zod schema for a supersession record (an upstream table this one replaces + when/advantage); mirrors RBI SupersedesDef. */
export const SupersedesDefSchema = z.object({
  source: z.string(),
  when: z.string().default(''),
  advantage: z.string().default(''),
}).loose()
/** Inferred type of {@link SupersedesDefSchema} (source + when + advantage). */
export type SupersedesDef = z.infer<typeof SupersedesDefSchema>

/** Zod schema for a single event parameter field (canonicalized type + description); mirrors RBI ParamField. */
export const ParamFieldSchema = z.object({
  type: canonType(),
  description: z.string().default(''),
}).loose()
/** Inferred type of {@link ParamFieldSchema} (canonicalized type + description). */
export type ParamField = z.infer<typeof ParamFieldSchema>

/** Zod schema for a caliber variant (id + description + default flag); mirrors RBI CaliberVariant. */
export const CaliberVariantSchema = z.object({
  id: z.string(),
  description: z.string().default(''),
  default: z.boolean().default(false),
}).loose()
/** Inferred type of {@link CaliberVariantSchema} (id + description + default). */
export type CaliberVariant = z.infer<typeof CaliberVariantSchema>

// MetricDef: model_validator — at most one default caliber_variant.
/**
 * Zod schema for a metric definition (expression + description + caliber
 * variants), refined so at most one variant may declare `default`; mirrors RBI MetricDef.
 */
export const MetricDefSchema = z.object({
  expression: z.string().default(''),
  description: z.string().default(''),
  alt_labels: z.array(z.string()).default([]),
  caliber_variants: z.array(CaliberVariantSchema).default([]),
}).loose().refine(
  m => m.caliber_variants.filter(v => v.default).length <= 1,
  { message: 'a metric may declare at most one default caliber_variant' },
)
/** Inferred type of {@link MetricDefSchema} (expression + description + caliber_variants). */
export type MetricDef = z.infer<typeof MetricDefSchema>

/** Metric computation metadata (derived from the embedded metric's expression). */
const MetricComputationSchema = z.object({
  sql: z.string().default(''),
  metadata: z.object({
    aggregation: z.string().default(''),
    field: z.string().default(''),
    source: z.string().default(''),
    time_grain: z.string().default(''),
  }).loose().default({ aggregation: '', field: '', source: '', time_grain: '' }),
}).loose()

/** Zod schema for a metric relation (type + target + join-on + description). */
const MetricRelationSchema = z.object({
  type: z.enum(['joins', 'derived_from', 'related_to']),
  target: z.string(),
  on: z.string().default(''),
  description: z.string().default(''),
}).loose()

/**
 * The derived MetricDefinition — produced at retrieval time from a table/event
 * embedded `metrics:` block (NOT loaded from a standalone YAML file). Carries
 * `caliber_variants` (M1c: planner Type B disambiguation signal).
 */
export const MetricDefinitionSchema = z.object({
  kind: z.literal('metric').default('metric'),
  name: z.string(),
  description: z.string().default(''),
  pref_label: z.string().optional(),
  alt_labels: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
  computation: MetricComputationSchema.default({ sql: '', metadata: { aggregation: '', field: '', source: '', time_grain: '' } }),
  relations: z.array(MetricRelationSchema).default([]),
  // at-most-one-default invariant enforced upstream by MetricDefSchema (derived artifact trusts host validation)
  caliber_variants: z.array(CaliberVariantSchema).default([]),
}).loose()

/** Inferred type of {@link MetricDefinitionSchema} — the derived metric produced at retrieval time. */
export type MetricDefinition = z.infer<typeof MetricDefinitionSchema>

/** Zod schema for an event disambiguation rule (event + trigger + distinction); mirrors RBI Disambiguation. */
export const DisambiguationSchema = z.object({
  event: z.string(),
  trigger: z.string().default(''),
  distinction: z.string().default(''),
}).loose()
/** Inferred type of {@link DisambiguationSchema} (event + trigger + distinction). */
export type Disambiguation = z.infer<typeof DisambiguationSchema>

/** Zod schema for a table's default terminology map (term name -> term text); mirrors RBI TableTermDefaults. */
export const TableTermDefaultsSchema = z.object({
  term_defaults: z.record(z.string(), z.string()).default({}),
}).loose()
/** Inferred type of {@link TableTermDefaultsSchema} (term_defaults map). */
export type TableTermDefaults = z.infer<typeof TableTermDefaultsSchema>

/** Zod schema for a dimension key-pair (dws_column <-> dim_column join key); mirrors RBI DimensionKeyPair. */
export const DimensionKeyPairSchema = z.object({
  dws_column: z.string(),
  dim_column: z.string(),
}).loose()
/** Inferred type of {@link DimensionKeyPairSchema} (dws_column + dim_column). */
export type DimensionKeyPair = z.infer<typeof DimensionKeyPairSchema>

// DimensionRef: model_validator — join_keys must contain >= 1 pair.
/**
 * Zod schema for an external dimension reference (dim_table + join_keys +
 * derivation), refined so `join_keys` must contain at least one pair; mirrors RBI DimensionRef.
 */
export const DimensionRefSchema = z.object({
  dim_table: z.string(),
  join_keys: z.array(DimensionKeyPairSchema),
  derivation: z.string().default(''),
  origin: z.enum(['deterministic', 'llm', 'manual']).optional(),
}).loose().refine(
  d => d.join_keys.length > 0,
  { message: 'join_keys must contain at least one key pair' },
)
/** Inferred type of {@link DimensionRefSchema} (dim_table + join_keys + derivation). */
export type DimensionRef = z.infer<typeof DimensionRefSchema>

// ── EventDefinition (埋点) ──────────────────────────────────────────────
/**
 * Zod schema for an event definition (埋点: name + params_fields + metrics +
 * disambiguation + external_refs + confirmation + coverage); mirrors RBI EventDefinition.
 */
export const EventDefinitionSchema = z.object({
  name: z.string(),
  event_filter: z.string().default(''),
  description: z.string().default(''),
  pref_label: z.string().optional(),
  alt_labels: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
  params_fields: z.record(z.string(), ParamFieldSchema).default({}),
  metrics: z.record(z.string(), MetricDefSchema).default({}),
  disambiguation: z.array(DisambiguationSchema).default([]),
  external_refs: z.array(DimensionRefSchema).default([]),
  confirmation: ConfirmationSchema.default({ status: 'draft', confirmed_by: '', confirmed_at: '' }),
  coverage: CoverageDefSchema.nullable().default(null),
}).loose()
/** Inferred type of {@link EventDefinitionSchema} (the parsed event-definition shape). */
export type EventDefinition = z.infer<typeof EventDefinitionSchema>

// ── TableDefinition (表) ────────────────────────────────────────────────
/** Zod schema for a single table column (name + canonicalized type + comment + role); mirrors RBI ColumnDef. */
export const ColumnDefSchema = z.object({
  name: z.string(),
  type: canonType(),
  comment: z.string().default(''),
  role: z.string().default(''),
}).loose()
/** Inferred type of {@link ColumnDefSchema} (name + type + comment + role). */
export type ColumnDef = z.infer<typeof ColumnDefSchema>

/** Zod schema for a single table partition (name + canonicalized type); mirrors RBI PartitionDef. */
export const PartitionDefSchema = z.object({
  name: z.string(),
  type: canonType(),
}).loose()
/** Inferred type of {@link PartitionDefSchema} (name + type). */
export type PartitionDef = z.infer<typeof PartitionDefSchema>

// TableDefinition: model_validator _kind_constraints — DIM requires primary_key + label_columns.
/**
 * Zod schema for a table definition (表: name + columns + metrics + partitions
 * + kind + primary_key + label_columns + dimension_refs + confirmation +
 * coverage + supersedes + disambiguation), refined so DIM-kind tables must
 * declare a non-empty `primary_key` and `label_columns`; mirrors RBI TableDefinition.
 */
export const TableDefinitionSchema = z.object({
  table_name: z.string(),
  /**
   * Per-table engine project override for table-name qualification (self-evolution #3a).
   *
   * When present, `ctx.query.qualifyTable(tableName, project)` lets this table's
   * qualified name resolve to `<project>.<table>` — winning over the query
   * provider's `Config.defaultProject` (cordis.patch.yml fills `ieu_cdm`).
   * This is how the self-evolution loop applies a user-supplied project after a
   * TABLE_NOT_FOUND: `update_table_config` writes `project` here, the search
   * corpus reloads, and the next query qualifies against the override.
   * `.loose()` already passthrough'd this key; declaring it typed lets
   * `findTable`/consumers read `t.project` as a parsed string (not unknown).
   */
  project: z.string().optional(),
  table_comment: z.string().default(''),
  description: z.string().default(''),
  pref_label: z.string().optional(),
  alt_labels: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
  granularity: z.string().default(''),
  engine: z.string().default('maxcompute'),
  columns: z.array(ColumnDefSchema).default([]),
  metrics: z.record(z.string(), MetricDefSchema).default({}),
  partitions: z.array(PartitionDefSchema).default([]),
  confirmation: ConfirmationSchema.default({ status: 'draft', confirmed_by: '', confirmed_at: '' }),
  coverage: CoverageDefSchema.nullable().default(null),
  supersedes: z.array(SupersedesDefSchema).default([]),
  disambiguation: TableTermDefaultsSchema.nullable().default(null),
  kind: z.enum(['dws', 'dim']).default('dws'),
  primary_key: z.array(z.string()).default([]),
  primary_key_unique: z.boolean().nullable().default(null),
  duplicate_sample: z.array(z.record(z.string(), z.string())).default([]),
  label_columns: z.array(z.string()).default([]),
  freshness: z.preprocess(
    v => v === '静态参考' ? 'static_reference' : v,
    z.enum(['static_reference', 'T+1', '']).default(''),
  ),
  dimension_refs: z.array(DimensionRefSchema).default([]),
}).loose().superRefine((t, ctx) => {
  if (t.kind === 'dim') {
    if (t.primary_key.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'DIM 表 primary_key 不能为空' })
    }
    if (t.label_columns.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'DIM 表 label_columns 不能为空' })
    }
  }
})
/** Inferred type of {@link TableDefinitionSchema} (the parsed table-definition shape). */
export type TableDefinition = z.infer<typeof TableDefinitionSchema>

// ── TableMeta (the schema-dict shape DataSourceConnector returns; not a
//    semantic definition, but the input to sync-write). Mirrors
//    rbi-semantic/sync.py:TableMeta + connectors/base.py:TableMeta. ─────────
/** Zod schema for a single connector column meta (name + type + optional comment); mirrors RBI TableMeta's column shape. */
export const ColumnMetaSchema = z.object({
  name: z.string(),
  type: z.string(),
  comment: z.string().optional().nullable(),
})
/** Inferred type of {@link ColumnMetaSchema} (name + type + optional comment). */
export type ColumnMeta = z.infer<typeof ColumnMetaSchema>

/** Zod schema for a single connector partition meta (name + type); mirrors RBI TableMeta's partition shape. */
export const PartitionMetaSchema = z.object({ name: z.string(), type: z.string() })
/** Inferred type of {@link PartitionMetaSchema} (name + type). */
export type PartitionMeta = z.infer<typeof PartitionMetaSchema>

/**
 * Zod schema for the schema-dict shape a `DataSourceConnector` returns (the
 * input to sync-write, not a semantic definition): table_name + columns +
 * partitions + optional comment. Mirrors rbi-semantic/sync.py:TableMeta.
 */
export const TableMetaSchema = z.object({
  table_name: z.string(),
  columns: z.array(ColumnMetaSchema).default([]),
  partitions: z.array(PartitionMetaSchema).default([]),
  comment: z.string().optional().nullable(),
}).loose()
/** Inferred type of {@link TableMetaSchema} (the connector-returned table-meta shape). */
export type TableMeta = z.infer<typeof TableMetaSchema>

// ── ConceptDefinition (CL-2: domain/concept as graph node) ──────────────
/**
 * Zod schema for a concept definition (CL-2: first-class entity in concepts/ dir).
 * Concepts represent semantic domains as explicit graph nodes; asset.domains
 * values are validated against concept names at load time.
 */
export const ConceptDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  pref_label: z.string().optional(),
  alt_labels: z.array(z.string()).default([]),
}).loose()
/** Inferred type of {@link ConceptDefinitionSchema}. */
export type ConceptDefinition = z.infer<typeof ConceptDefinitionSchema>

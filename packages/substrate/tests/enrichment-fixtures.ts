/**
 * Shared fixtures for the whole substrate test surface (map #64 / #67, widened
 * by #122): `fixtureTable` / `fixtureEvent` are the single source every spec
 * seeds table and event definitions from — the ONE place a new
 * `TableDefinitionSchema` / `EventDefinitionSchema` field lands (mirroring
 * packages/mcp's `fixtureTable` precedent), so a spec passes only the
 * load-bearing overrides its behaviour actually depends on, never a hand-built
 * full field set. `dws` remains the enrichment-domain preset (`fixtureTable`
 * plus the `dws_pay_order_di` shape the join/alt-label assertions in
 * `enrichment.spec.ts` / `sweep.spec.ts` are calibrated against). Test-only
 * module, never shipped (nothing here reaches the barrel; ADR-0002/0003).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { dumpYaml } from '../src/io.ts'
import { EventDefinitionSchema, type EventDefinition, type TableDefinition } from '../src/types.ts'

/**
 * Build a schema-valid table definition: every field `TableDefinitionSchema`
 * knows about, spelled out once over a neutral all-defaults base — this
 * function is the whole edit radius when the schema grows a required field
 * (#122: was thirteen per-spec hand-assembled full field sets).
 * @param over - load-bearing overrides (a real fixture always names its `table_name`).
 * @returns the table definition.
 */
export function fixtureTable(over: Partial<TableDefinition> = {}): TableDefinition {
  return {
    table_name: '',
    table_comment: '',
    description: '',
    domains: [],
    granularity: '',
    engine: 'maxcompute',
    columns: [],
    metrics: {},
    partitions: [],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    coverage: null,
    supersedes: [],
    disambiguation: null,
    kind: 'dws',
    primary_key: [],
    primary_key_unique: null,
    duplicate_sample: [],
    label_columns: [],
    freshness: '',
    alt_labels: [],
    dimension_refs: [],
    suppressed_alt_labels: [],
    suppressed_dimension_refs: [],
    ...over,
  }
}

/**
 * The enrichment-domain preset: `fixtureTable` plus the `dws_pay_order_di`
 * shape the deterministic join round (`role_id`/`server_id` columns against
 * `dimServerYaml`'s PK) and alt-label round (the two commented columns, domain
 * 付费经济) are calibrated against.
 * @param over - load-bearing overrides on top of the preset.
 * @returns the table definition.
 */
export function dws(over: Partial<TableDefinition> = {}): TableDefinition {
  return fixtureTable({
    table_name: 'dws_pay_order_di',
    table_comment: 'pay',
    description: 'pay orders dws',
    domains: ['付费经济'],
    columns: [
      { name: 'order_id', type: 'string', comment: '', role: 'dimension' },
      { name: 'role_id', type: 'string', comment: '角色ID', role: 'dimension' },
      { name: 'server_id', type: 'string', comment: '区服ID', role: 'dimension' },
    ],
    ...over,
  })
}

/**
 * Build a schema-valid event definition, parsed through
 * `EventDefinitionSchema` so the fixture and the loader agree on every default
 * (the parse also catches fixture drift the moment a schema field changes —
 * this is the event-side single source `fixtureTable` is the table-side one).
 * @param over - load-bearing overrides (a real fixture always names its `name`).
 * @returns the event definition.
 */
export function fixtureEvent(over: Partial<EventDefinition> = {}): EventDefinition {
  return EventDefinitionSchema.parse({
    name: '',
    event_filter: '',
    description: '',
    alt_labels: [],
    domains: [],
    params_fields: {},
    metrics: {},
    disambiguation: [],
    external_refs: [],
    suppressed_alt_labels: [],
    suppressed_external_refs: [],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    coverage: null,
    ...over,
  })
}

/**
 * The enrichment-domain event preset: `fixtureEvent` plus the `game.pay.order`
 * shape the deterministic event-join round (`role_id`/`server_id` params
 * against the DIM inventories) and alt-label round (domain 付费经济) are
 * calibrated against — the event-side twin of {@link dws}.
 * @param over - load-bearing overrides on top of the preset.
 * @returns the event definition.
 */
export function event(over: Partial<EventDefinition> = {}): EventDefinition {
  return fixtureEvent({
    name: 'game.pay.order',
    description: '玩家充值下单',
    domains: ['付费经济'],
    params_fields: {
      role_id: { type: 'string', description: '角色ID' },
      server_id: { type: 'string', description: '区服ID' },
      amount: { type: 'int', description: '金额' },
    },
    ...over,
  })
}

/** The one DIM every relations fixture joins against (PK server_id). */
export function dimServerYaml(): string {
  return dumpYaml(fixtureTable({
    table_name: 'dim_server', kind: 'dim', primary_key: ['server_id'], label_columns: ['s_name'],
    columns: [
      { name: 'server_id', type: 'string', comment: '', role: 'dimension' },
      { name: 's_name', type: 'string', comment: '', role: 'dimension' },
    ],
  }))
}

/** An empty seeded layer: config.yaml + tables/ + events/pay/ + events/social/. */
export function makeLayer(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(dir, 'config.yaml'), 'project:\n  name: t\n  scope_id: t\n')
  mkdirSync(join(dir, 'tables'), { recursive: true })
  mkdirSync(join(dir, 'events', 'pay'), { recursive: true })
  mkdirSync(join(dir, 'events', 'social'), { recursive: true })
  return dir
}

/** Read a written definition back as the raw dict (post-sweep assertions). */
export function readYaml(path: string): Record<string, unknown> {
  return yaml.load(readFileSync(path, 'utf-8')) as Record<string, unknown>
}

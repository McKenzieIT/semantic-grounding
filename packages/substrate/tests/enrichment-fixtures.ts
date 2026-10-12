/**
 * Shared fixtures for the enrichment tests (map #64 / #67): the dws / event /
 * DIM builders both the pure-machinery specs (`enrichment.spec.ts`,
 * `alt-labels-enrichment.spec.ts`) and the sweep-engine spec (`sweep.spec.ts`)
 * seed from — one fixture per KIND, not one per mirror pipeline. Test-only
 * module, never shipped (nothing here reaches the barrel; ADR-0002/0003).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { dumpYaml } from '../src/io.ts'
import { EventDefinitionSchema, type EventDefinition, type TableDefinition } from '../src/types.ts'

export function dws(over: Partial<TableDefinition> = {}): TableDefinition {
  return {
    table_name: 'dws_pay_order_di',
    table_comment: 'pay',
    description: 'pay orders dws',
    domains: ['付费经济'],
    granularity: '',
    engine: 'maxcompute',
    columns: [
      { name: 'order_id', type: 'string', comment: '', role: 'dimension' },
      { name: 'role_id', type: 'string', comment: '角色ID', role: 'dimension' },
      { name: 'server_id', type: 'string', comment: '区服ID', role: 'dimension' },
    ],
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

export function event(over: Partial<EventDefinition> = {}): EventDefinition {
  return EventDefinitionSchema.parse({
    name: 'game.pay.order',
    description: '玩家充值下单',
    domains: ['付费经济'],
    params_fields: {
      role_id: { type: 'string', description: '角色ID' },
      server_id: { type: 'string', description: '区服ID' },
      amount: { type: 'int', description: '金额' },
    },
    metrics: {}, external_refs: [], disambiguation: [],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' }, coverage: null,
    ...over,
  })
}

/** The one DIM every relations fixture joins against (PK server_id). */
export function dimServerYaml(): string {
  return dumpYaml({
    table_name: 'dim_server', kind: 'dim', primary_key: ['server_id'], label_columns: ['s_name'],
    columns: [{ name: 'server_id', type: 'string', comment: '', role: 'dimension' }, { name: 's_name', type: 'string', comment: '', role: 'dimension' }],
    metrics: {}, partitions: [], confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    domains: [], description: '', table_comment: '', granularity: '', engine: 'maxcompute',
    coverage: null, supersedes: [], disambiguation: null, primary_key_unique: null,
    alt_labels: [], duplicate_sample: [], freshness: '', dimension_refs: [],
  })
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

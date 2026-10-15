/**
 * The shared k11-style corpus builders for the data-memory layer's two domain
 * specs — `memory.spec.ts` (write half, ADR-0023 / #152) and
 * `memory-read.spec.ts` (read half, ADR-0024 / #154) mirror the same E3-card
 * table / dimension / concept / event shapes, so they live here once, the
 * `fixtureTable` convention of `enrichment-fixtures.ts` applied to the
 * memory fixtures.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dumpYaml, SemanticGroundingCore, type Tier2Recorder } from '../src/index.ts'
import { fixtureTable } from './enrichment-fixtures.ts'

export const noopRecorder: Tier2Recorder = { recordTier2Write: async () => 'noop-log-id' }

/** A Core over the given root with a no-op recorder, as both memory specs build it. */
export function newMemoryCore(root: string): SemanticGroundingCore {
  const core = new SemanticGroundingCore({ semanticRoot: root, scopeId: 'fixture', autoEnrich: false })
  core.setTier2Recorder(noopRecorder)
  return core
}

/** The E3-card table: a DWS whose `ch_id` column carries the 「2渠」黑话. */
export function writeAccTable(root: string): void {
  writeFileSync(join(root, 'tables', 'dws_acc.yaml'), dumpYaml(fixtureTable({
    table_name: 'dws_acc',
    kind: 'dws',
    columns: [
      { name: 'ch_id', type: 'string', comment: '渠道id,又叫 2渠', role: 'dimension' },
      { name: 'ch_type', type: 'string', comment: '渠道,又叫 1渠', role: 'dimension' },
      { name: 'pay_amt', type: 'decimal', comment: '充值金额', role: 'measure' },
    ],
    dimension_refs: [{ dim_table: 'dim_shop', derivation: '', join_keys: [{ dws_column: 'ch_id', dim_column: 'shop_id' }] }],
    domains: ['payment'],
  })), 'utf8')
}

export function writeShopDim(root: string): void {
  writeFileSync(join(root, 'tables', 'dim_shop.yaml'), dumpYaml(fixtureTable({
    table_name: 'dim_shop',
    kind: 'dim',
    columns: [{ name: 'shop_id', type: 'string', comment: '渠道id', role: 'dimension' }],
    primary_key: ['shop_id'],
    label_columns: ['shop_id'],
  })), 'utf8')
}

export function writePaymentConcept(root: string): void {
  writeFileSync(join(root, 'concepts', 'payment.yaml'), dumpYaml({
    name: 'payment',
    description: '付费经济',
    alt_labels: ['大R', '高付费'],
    properties: {},
    related_refs: [],
    suppressed_alt_labels: [],
    suppressed_related_refs: [],
  }), 'utf8')
}

export function writePayEvent(root: string): void {
  mkdirSync(join(root, 'events', 'game'), { recursive: true })
  writeFileSync(join(root, 'events', 'game', 'pay.order.yaml'), dumpYaml({
    name: 'pay.order',
    event_filter: '',
    description: '支付下单',
    alt_labels: [],
    domains: [],
    params_fields: { pay_amt: { type: 'decimal', description: '金额' } },
    metrics: {},
    external_refs: [],
    suppressed_alt_labels: [],
    suppressed_external_refs: [],
  }), 'utf8')
}

/**
 * The full corpus: table + dim + concept, plus the pay.order event when
 * `withEvent` (the write-half spec's corpus carries it; the read half never
 * needed it, so its shape is kept byte-identical).
 */
export function fullCorpus(root: string, withEvent = false): void {
  writeAccTable(root)
  writeShopDim(root)
  writePaymentConcept(root)
  if (withEvent) writePayEvent(root)
}

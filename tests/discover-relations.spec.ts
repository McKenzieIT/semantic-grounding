/**
 * discoverRelations Service method + on-write hook (B3) — `ctx.schema`
 * enrichment entry. G3: discoverRelations delegates to the substrate
 * `enrichAllDwsTables`; the on-write hook fires after syncWrite/updateTableMeta
 * (gated by autoEnrich). No Tier-2 audit for the enrichment itself (auto-derived).
 */
import { test, expect, describe, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { SemanticLayerService, buildExcludeColumns, type Tier2Recorder } from '../src/index.ts'
import { dumpYaml } from '../src/io.ts'
import { discoverRelationsDeterministic, type DimInventoryEntry } from '../src/enrichment.ts'
import type { TableDefinition, TableMeta } from '../src/types.ts'

const dimDoc = (name: string, pk: string): TableDefinition => ({
  table_name: name, table_comment: '', description: `${name} 维度表`, alt_labels: [], domains: [],
  granularity: '', engine: 'maxcompute',
  columns: [{ name: pk, type: 'string', comment: 'pk', role: 'dimension' }, { name: `${pk}_name`, type: 'string', comment: 'name', role: 'dimension' }],
  metrics: {}, partitions: [], confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
  coverage: null, supersedes: [], disambiguation: null, kind: 'dim', primary_key: [pk], primary_key_unique: null,
  duplicate_sample: [], label_columns: [`${pk}_name`], freshness: 'static_reference', dimension_refs: [],
})

const dwsDoc = (name: string, cols: Array<{ name: string; comment?: string }>): TableDefinition => ({
  table_name: name, table_comment: '', description: `${name} dws`, alt_labels: [], domains: [],
  granularity: '', engine: 'maxcompute',
  columns: cols.map(c => ({ name: c.name, type: 'string', comment: c.comment ?? '', role: 'dimension' })),
  metrics: {}, partitions: [], confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
  coverage: null, supersedes: [], disambiguation: null, kind: 'dws', primary_key: [], primary_key_unique: null,
  duplicate_sample: [], label_columns: [], freshness: '', dimension_refs: [],
})

function newLayer(...dws: Array<{ name: string; cols: Array<{ name: string; comment?: string }> }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'k11-b3-'))
  writeFileSync(join(dir, 'config.yaml'), 'project:\n  name: t\n  scope_id: t\n')
  mkdirSync(join(dir, 'tables'), { recursive: true })
  writeFileSync(join(dir, 'tables', 'dim_server.yaml'), dumpYaml(dimDoc('dim_server', 'server_id')))
  for (const d of dws) writeFileSync(join(dir, 'tables', `${d.name}.yaml`), dumpYaml(dwsDoc(d.name, d.cols)))
  return dir
}
function readRefs(dir: string, name: string): unknown[] {
  const f = readFileSync(join(dir, 'tables', `${name}.yaml`), 'utf-8')
  return ((yaml.load(f) as Record<string, unknown>).dimension_refs as unknown[]) ?? []
}

const noopRecorder: Tier2Recorder = { recordTier2Write: () => 'log-id' }

describe('ctx.schema.discoverRelations (B3)', () => {
  let dir: string
  beforeEach(() => {}) // dir set per-test below
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  test('discoverRelations writes dimension_refs into DWS tables (deterministic round, no llmCall)', async () => {
    dir = newLayer({ name: 'dws_pay', cols: [{ name: 'server_id', comment: '区服ID' }] })
    const ctx = new Context()
    const schema = new SemanticLayerService(ctx, { semanticRoot: dir })
    const res = await schema.discoverRelations()
    expect(res.written).toBe(1)
    expect(res.enriched).toBe(1)
    expect(readRefs(dir, 'dws_pay')).toHaveLength(1)
  })

  test('discoverRelations with tables? filter enriches only the named tables', async () => {
    dir = newLayer({ name: 'dws_a', cols: [{ name: 'server_id' }] }, { name: 'dws_b', cols: [{ name: 'server_id' }] })
    const ctx = new Context()
    const schema = new SemanticLayerService(ctx, { semanticRoot: dir })
    const res = await schema.discoverRelations({ tables: ['dws_a'] })
    expect(res.written).toBe(1)
    expect(readRefs(dir, 'dws_a')).toHaveLength(1)
    expect(readRefs(dir, 'dws_b')).toHaveLength(0)
  })

  test('discoverRelations preserves pre-existing curated refs on a DWS (origin-aware replace, GA-GT3 item 5)', async () => {
    // The agent-invoked discover_relations tool runs in replace mode
    // (mergeExisting=false, hardcoded in SemanticLayerService.discoverRelations).
    // Before GA-GT3 item 5, a re-discovery discarded ALL existing dimension_refs
    // — including hand-curated joins the deterministic round cannot rediscover —
    // and wrote dimension_refs: [] with a misleading enriched:0. Origin-aware
    // replace (landed in the substrate) now preserves curated manual/undefined
    // refs end-to-end through the Service, while refreshing deterministic ones.
    dir = mkdtempSync(join(tmpdir(), 'gt3-svc-'))
    writeFileSync(join(dir, 'config.yaml'), 'project:\n  name: t\n  scope_id: t\n')
    mkdirSync(join(dir, 'tables'), { recursive: true })
    writeFileSync(join(dir, 'tables', 'dim_server.yaml'), dumpYaml(dimDoc('dim_server', 'server_id')))
    // DWS with a server_id FK (rediscoverable) + a curated manual ref (not
    // rediscoverable: dim_curated is not in the layer's DIM inventory).
    const dws = {
      ...dwsDoc('dws_pay', [{ name: 'server_id', comment: '区服ID' }]),
      dimension_refs: [
        { dim_table: 'dim_curated', join_keys: [{ dws_column: 'curated_id', dim_column: 'curated_id' }], derivation: 'curated by analyst' },
        { dim_table: 'dim_server', join_keys: [{ dws_column: 'server_id', dim_column: 'server_id' }], derivation: 'stale', origin: 'deterministic' },
      ],
    }
    writeFileSync(join(dir, 'tables', 'dws_pay.yaml'), dumpYaml(dws))

    const ctx = new Context()
    const schema = new SemanticLayerService(ctx, { semanticRoot: dir })
    const res = await schema.discoverRelations()
    expect(res.written).toBe(1)
    const refs = readRefs(dir, 'dws_pay') as Array<{ dim_table: string; origin?: string; derivation: string }>
    const byDim = Object.fromEntries(refs.map(r => [r.dim_table, r]))
    // curated (undefined-origin legacy manual) ref survives the agent re-discovery:
    expect(byDim.dim_curated).toBeDefined()
    expect(byDim.dim_curated!.derivation).toBe('curated by analyst')
    // deterministic ref refreshed (derivation reset to 确定性):
    expect(byDim.dim_server).toBeDefined()
    expect(byDim.dim_server!.derivation).toContain('确定性')
  })
})

describe('ctx.schema on-write hook (B3, G3 auto-trigger)', () => {
  let dir: string
  beforeEach(() => {})
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  test('syncWrite of a DWS triggers the on-write hook -> dimension_refs written', async () => {
    dir = newLayer()
    const ctx = new Context()
    ctx.provide('audit', noopRecorder as never)
    const schema = new SemanticLayerService(ctx, { semanticRoot: dir })
    const meta: TableMeta = {
      table_name: 'dws_pay', comment: 'pay',
      partitions: [{ name: 'ds', type: 'string' }],
      columns: [{ name: 'server_id', type: 'string', comment: '区服ID' }, { name: 'pay_amt', type: 'double', comment: '金额' }],
    }
    const res = await schema.syncWrite([meta])
    expect(res.written).toBe(1)
    // hook fired: the just-written DWS now has dimension_refs (deterministic: server_id matches dim_server PK)
    expect(readRefs(dir, 'dws_pay')).toHaveLength(1)
  })

  test('autoEnrich=false suppresses the on-write hook', async () => {
    dir = newLayer()
    const ctx = new Context()
    ctx.provide('audit', noopRecorder as never)
    const schema = new SemanticLayerService(ctx, { semanticRoot: dir, autoEnrich: false })
    const meta: TableMeta = { table_name: 'dws_pay', comment: 'pay', partitions: [], columns: [{ name: 'server_id', type: 'string', comment: '区服ID' }] }
    await schema.syncWrite([meta])
    expect(readRefs(dir, 'dws_pay')).toHaveLength(0) // hook suppressed
  })
})

// ── CL-18 Phase 2: excludeColumns (partition-column noise filtering) ─────

/**
 * Substrate-level tests for the `excludeColumns` parameter on
 * `discoverRelationsDeterministic`. The set is computed by the calling layer
 * (see `buildExcludeColumns` in the Service shell) from target-table
 * metadata; the substrate applies it opaquely to filter out partition-column
 * PK matches (the CL-18 `ds`-only noise JOIN).
 */
describe('CL-18 Phase 2: discoverRelationsDeterministic excludeColumns', () => {
  // Minimal builders — independent of the B3 `dwsDoc`/`dimDoc` helpers so the
  // column `role` annotations can be controlled precisely per case.
  const mkDws = (name: string, cols: Array<{ name: string; role?: string }>): TableDefinition => ({
    table_name: name, table_comment: '', description: '', alt_labels: [], domains: [],
    granularity: '', engine: 'maxcompute',
    columns: cols.map(c => ({ name: c.name, type: 'string', comment: '', role: c.role ?? 'dimension' })),
    metrics: {}, partitions: [], confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    coverage: null, supersedes: [], disambiguation: null, kind: 'dws', primary_key: [],
    primary_key_unique: null, duplicate_sample: [], label_columns: [], freshness: '',
    dimension_refs: [],
  })

  const mkDim = (name: string, pks: readonly string[]): DimInventoryEntry => ({
    table_name: name, primary_key: pks, description: `${name} 维度表`,
  })

  test('ds-only PK match + excludeColumns contains ds → zero refs (noise skipped)', () => {
    // DWS carries a `ds` partition column; a DIM snapshot keyed only by `ds`
    // would previously match every such DWS (the CL-18 noise). With the exclude
    // set containing `ds`, the deterministic round skips it entirely.
    const dws = mkDws('dws_pay', [{ name: 'ds', role: 'partition' }])
    const dims = [mkDim('dim_arch_ds', ['ds'])]
    const refs = discoverRelationsDeterministic(dws, dims, new Set(['ds']))
    expect(refs).toHaveLength(0)
  })

  test('mixed match (business_key + ds) + excludeColumns contains ds → business_key kept, ds skipped', () => {
    // DWS has a real business FK `server_id` AND a partition `ds`; the DIM
    // inventory has both a server DIM (PK server_id) and an _arch snapshot
    // (PK ds). Only the server DIM ref should survive — the ds-only match is
    // filtered while the genuine business-key join is preserved.
    const dws = mkDws('dws_pay', [
      { name: 'server_id', role: 'dimension' },
      { name: 'ds', role: 'partition' },
    ])
    const dims = [mkDim('dim_server', ['server_id']), mkDim('dim_arch_ds', ['ds'])]
    const refs = discoverRelationsDeterministic(dws, dims, new Set(['ds']))
    expect(refs).toHaveLength(1)
    expect(refs[0]!.dim_table).toBe('dim_server')
    expect(refs[0]!.join_keys).toEqual([{ dws_column: 'server_id', dim_column: 'server_id' }])
  })

  test('no excludeColumns (backward compat) → behavior unchanged (ds-only match still produced)', () => {
    // Regression guard: omitting `excludeColumns` preserves the pre-CL-18
    // behavior — a ds-only DIM match IS produced (the deterministic round does
    // not filter partition columns when no exclude set is supplied). This
    // proves the filter is opt-in and existing callers see no change.
    const dws = mkDws('dws_pay', [{ name: 'ds', role: 'partition' }])
    const dims = [mkDim('dim_arch_ds', ['ds'])]
    const refs = discoverRelationsDeterministic(dws, dims)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.dim_table).toBe('dim_arch_ds')
    expect(refs[0]!.join_keys).toEqual([{ dws_column: 'ds', dim_column: 'ds' }])
  })

  test("buildExcludeColumns: role:'partition'-driven path excludes exactly the partition columns", () => {
    // Data-driven path: when the table annotates partition columns via
    // `role: 'partition'`, those names (and ONLY those) form the exclude set.
    const withPartitionRoles = mkDws('dws_a', [
      { name: 'ds', role: 'partition' },
      { name: 'pt', role: 'partition' },
      { name: 'server_id', role: 'dimension' },
    ])
    const excl = buildExcludeColumns(withPartitionRoles)
    expect(excl.has('ds')).toBe(true)
    expect(excl.has('pt')).toBe(true)
    expect(excl.has('server_id')).toBe(false) // business FK not excluded
    // A custom partition column is included; the standard ds/pt/dt are NOT
    // added when the data-driven path fires (the set is precise, not a
    // superset of the blocklist).
    const custom = mkDws('dws_b', [{ name: 'biz_date', role: 'partition' }])
    const exclCustom = buildExcludeColumns(custom)
    expect(exclCustom.has('biz_date')).toBe(true)
    expect(exclCustom.has('ds')).toBe(false)
  })

  test('buildExcludeColumns: no role annotations → fallback blocklist [ds, pt, dt]', () => {
    // Fallback path: when the table has NO `role: 'partition'` columns
    // (e.g. unannotated or sync-written where partition cols live in the
    // separate `partitions` array), the minimal blocklist is used so the
    // common noise is still caught.
    const noRoles = mkDws('dws_c', [
      { name: 'ds', role: 'dimension' },
      { name: 'server_id', role: 'dimension' },
    ])
    const excl = buildExcludeColumns(noRoles)
    expect(excl.has('ds')).toBe(true)
    expect(excl.has('pt')).toBe(true)
    expect(excl.has('dt')).toBe(true)
    expect(excl.has('server_id')).toBe(false)
  })
})

/**
 * Service-level wiring test: proves `ctx.schema.discoverRelations()` actually
 * forwards `buildExcludeColumns` into the substrate `enrichAllDwsTables` so a
 * ds-only DIM snapshot does not produce a noise JOIN for a DWS carrying a `ds`
 * partition column, while a genuine business-key DIM (server_id) is kept.
 */
describe('CL-18 Phase 2: ctx.schema.discoverRelations forwards excludeColumns (wiring)', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  test('a ds-only DIM snapshot does not match a DWS carrying a ds partition column', async () => {
    // Layer: dim_server (PK server_id) + dim_arch_ds (PK ds, the _arch
    // snapshot noise shape) + dws_pay (columns: ds[partition] + server_id).
    // The Service must forward buildExcludeColumns so the deterministic round
    // keeps dim_server and skips dim_arch_ds.
    dir = mkdtempSync(join(tmpdir(), 'cl18-wiring-'))
    writeFileSync(join(dir, 'config.yaml'), 'project:\n  name: t\n  scope_id: t\n')
    mkdirSync(join(dir, 'tables'), { recursive: true })
    writeFileSync(join(dir, 'tables', 'dim_server.yaml'), dumpYaml(dimDoc('dim_server', 'server_id')))
    writeFileSync(join(dir, 'tables', 'dim_arch_ds.yaml'), dumpYaml(dimDoc('dim_arch_ds', 'ds')))
    const dws = {
      ...dwsDoc('dws_pay', [{ name: 'ds' }, { name: 'server_id' }]),
      columns: [
        { name: 'ds', type: 'string', comment: '业务日期', role: 'partition' },
        { name: 'server_id', type: 'string', comment: '区服ID', role: 'dimension' },
      ],
    }
    writeFileSync(join(dir, 'tables', 'dws_pay.yaml'), dumpYaml(dws))

    const ctx = new Context()
    const schema = new SemanticLayerService(ctx, { semanticRoot: dir })
    const res = await schema.discoverRelations()
    const refs = readRefs(dir, 'dws_pay') as Array<{ dim_table: string }>
    // dim_server (PK server_id) matches; dim_arch_ds (PK ds) is filtered out.
    expect(refs).toHaveLength(1)
    expect(refs[0]!.dim_table).toBe('dim_server')
    expect(res.written).toBe(1)
  })
})

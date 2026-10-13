/**
 * ADR-0004 ruling 8's round trip through the Core class: the `version` a
 * `load*DefinitionWithVersion` read returns is the same sha256
 * `checkExpectedVersion` compares at write time (one implementation —
 * `definitionVersion`, `io.ts` — serves both sides), so a read followed by a
 * write passing `version` back as `expected_version` succeeds, and any byte
 * change in between is rejected as `StaleBaselineError`. Also pins the
 * retired MCP-side fork: a hand-renamed event file (filename ≠ its `name:`
 * field) fingerprints correctly via `findEventPath`'s fallback scan, where the
 * tool layer's former filename-convention copy threw ENOENT.
 */
import { afterEach, describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  SemanticGroundingCore,
  dumpYaml,
  StaleBaselineError,
  type Tier2Recorder,
} from '../src/index.ts'
// S1.5 (#85): the Tier-2-audited meta writers are off the barrel — the Core
// class's same-named methods are the public route; this spec drives the io
// free functions directly because it pins the version round trip underneath
// the class's wrappers.
import { updateTableMeta, updateEventMeta } from '../src/io.ts'
import type { EventDefinition, TableDefinition } from '../src/types.ts'

// Mirrors tests/enrichment-work.spec.ts's builders (the minimal schema-valid shapes).
const dwsDoc = (name: string): TableDefinition => ({
  table_name: name, table_comment: '', description: `${name} dws`, alt_labels: [], domains: [],
  granularity: '', engine: 'maxcompute',
  columns: [{ name: 'order_id', type: 'string', comment: '', role: 'dimension' }],
  metrics: {}, partitions: [], confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
  coverage: null, supersedes: [], disambiguation: null, kind: 'dws', primary_key: [], primary_key_unique: null,
  duplicate_sample: [], label_columns: [], freshness: '', dimension_refs: [],
  suppressed_alt_labels: [], suppressed_dimension_refs: [],
})

const eventDoc = (name: string): EventDefinition => ({
  name, event_filter: '', description: `${name} 事件`, alt_labels: [], domains: [],
  params_fields: {}, metrics: {}, disambiguation: [], external_refs: [],
  confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' }, coverage: null,
  suppressed_alt_labels: [], suppressed_external_refs: [],
})

const HEX64 = /^[0-9a-f]{64}$/

let dir: string | undefined
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

function newLayer(): string {
  dir = mkdtempSync(join(tmpdir(), 'sg-version-'))
  mkdirSync(join(dir, 'tables'), { recursive: true })
  mkdirSync(join(dir, 'events', 'biz'), { recursive: true })
  mkdirSync(join(dir, 'concepts'), { recursive: true })
  writeFileSync(join(dir, 'config.yaml'), 'project:\n  name: t\n  scope_id: t\n')
  return dir
}

/** A Tier-2 recorder stand-in: records nothing, raises never — the audit shape
 * is not under test here, only the fingerprint round trip. */
const recorder: Tier2Recorder = { recordTier2Write: async () => 'stub' }

describe('loadTableDefinitionWithVersion round trip', () => {
  test('version → updateTableMeta(expected_version) succeeds', async () => {
    const layer = newLayer()
    writeFileSync(join(layer, 'tables', 'dws_order.yaml'), dumpYaml(dwsDoc('dws_order')))
    const core = new SemanticGroundingCore({ semanticRoot: layer })

    const res = core.loadTableDefinitionWithVersion('dws_order')
    expect(res).not.toBeNull()
    expect(res?.version).toMatch(HEX64)

    const updated = await updateTableMeta(layer, 'dws_order', { description: '改一版' }, { recorder, expected_version: res!.version })
    expect(updated).toEqual({ ok: true, table_name: 'dws_order' })
  })

  test('bytes change between read and write → StaleBaselineError', async () => {
    const layer = newLayer()
    writeFileSync(join(layer, 'tables', 'dws_order.yaml'), dumpYaml(dwsDoc('dws_order')))
    const core = new SemanticGroundingCore({ semanticRoot: layer })
    const { version } = core.loadTableDefinitionWithVersion('dws_order')!

    // A comment changes the bytes without touching the parsed content: the
    // rejection below is purely the fingerprint's, which is the point.
    writeFileSync(join(layer, 'tables', 'dws_order.yaml'), `${dumpYaml(dwsDoc('dws_order'))}\n# touched\n`)

    await expect(updateTableMeta(layer, 'dws_order', { description: '改一版' }, { recorder, expected_version: version }))
      .rejects.toBeInstanceOf(StaleBaselineError)
  })

  test('unknown name → null', () => {
    const layer = newLayer()
    const core = new SemanticGroundingCore({ semanticRoot: layer })
    expect(core.loadTableDefinitionWithVersion('nope')).toBeNull()
  })
})

describe('loadEventDefinitionWithVersion round trip', () => {
  test('version → updateEventMeta(expected_version) succeeds', async () => {
    const layer = newLayer()
    writeFileSync(join(layer, 'events', 'biz', 'evt_click.yaml'), dumpYaml(eventDoc('evt_click')))
    const core = new SemanticGroundingCore({ semanticRoot: layer })

    const res = core.loadEventDefinitionWithVersion('evt_click')
    expect(res).not.toBeNull()
    expect(res?.version).toMatch(HEX64)

    const updated = await updateEventMeta(layer, 'evt_click', { description: '改一版' }, { recorder, expected_version: res!.version })
    expect(updated).toEqual({ ok: true, event_name: 'evt_click' })
  })

  test('bytes change between read and write → StaleBaselineError', async () => {
    const layer = newLayer()
    writeFileSync(join(layer, 'events', 'biz', 'evt_click.yaml'), dumpYaml(eventDoc('evt_click')))
    const core = new SemanticGroundingCore({ semanticRoot: layer })
    const { version } = core.loadEventDefinitionWithVersion('evt_click')!

    writeFileSync(join(layer, 'events', 'biz', 'evt_click.yaml'), `${dumpYaml(eventDoc('evt_click'))}\n# touched\n`)

    await expect(updateEventMeta(layer, 'evt_click', { description: '改一版' }, { recorder, expected_version: version }))
      .rejects.toBeInstanceOf(StaleBaselineError)
  })

  test('hand-renamed event file still fingerprints (the retired MCP-side ENOENT fork)', () => {
    const layer = newLayer()
    // Filename ≠ the event's own `name:` field — findEventPath's fallback scan
    // resolves it, and the fingerprint is of the file the writer would target.
    const renamed = join(layer, 'events', 'biz', 'renamed_file.yaml')
    writeFileSync(renamed, dumpYaml(eventDoc('evt_click')))
    const core = new SemanticGroundingCore({ semanticRoot: layer })

    const res = core.loadEventDefinitionWithVersion('evt_click')
    expect(res?.version).toMatch(HEX64)
    expect(res?.version).toBe(createHash('sha256').update(readFileSync(renamed, 'utf-8'), 'utf-8').digest('hex'))
  })

  test('unknown name → null', () => {
    const layer = newLayer()
    const core = new SemanticGroundingCore({ semanticRoot: layer })
    expect(core.loadEventDefinitionWithVersion('nope')).toBeNull()
  })
})

describe('loadConceptDefinitionWithVersion', () => {
  test('version reported for read completeness (no write path in v1)', () => {
    const layer = newLayer()
    writeFileSync(join(layer, 'concepts', 'c_order.yaml'), dumpYaml({ name: 'c_order', description: '订单概念', alt_labels: [] }))
    const core = new SemanticGroundingCore({ semanticRoot: layer })

    const res = core.loadConceptDefinitionWithVersion('c_order')
    expect(res).not.toBeNull()
    expect(res?.version).toMatch(HEX64)
    expect(core.loadConceptDefinitionWithVersion('nope')).toBeNull()
  })
})

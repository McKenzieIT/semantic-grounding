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
 *
 * #108 extended the same fingerprint to the WRITE side: every write primitive
 * resolves to the sha256 of the file as the whole write left it, so the
 * read → write → receipt → next-write loop closes with zero intermediate
 * reads (`get_definition` read-backs were the measured pain this retired).
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
import { definitionVersion, updateTableMeta, updateEventMeta, writeTable } from '../src/io.ts'
import type { EventDefinition, TableDefinition } from '../src/types.ts'
import { fixtureEvent, fixtureTable } from './enrichment-fixtures.ts'

// Mirrors tests/enrichment-work.spec.ts's builders (the minimal schema-valid shapes).
const dwsDoc = (name: string): TableDefinition => fixtureTable({
  table_name: name, description: `${name} dws`,
  columns: [{ name: 'order_id', type: 'string', comment: '', role: 'dimension' }],
})

/** The DIM half of the on-write hook fixture (mirrors discover-relations.spec). */
const dimDoc = (name: string, pk: string): TableDefinition => fixtureTable({
  ...dwsDoc(name),
  description: `${name} 维度表`,
  columns: [
    { name: pk, type: 'string', comment: 'pk', role: 'dimension' },
    { name: `${pk}_name`, type: 'string', comment: 'name', role: 'dimension' },
  ],
  kind: 'dim', primary_key: [pk], label_columns: [`${pk}_name`], freshness: 'static_reference',
})

const eventDoc = (name: string): EventDefinition => fixtureEvent({
  name, description: `${name} 事件`,
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
    expect(updated.ok).toBe(true)
    if (updated.ok) {
      // #108: the write receipt's fingerprint is exactly what the read side
      // reports next — hand it straight back as the following write's baseline.
      expect(updated.version).toMatch(HEX64)
      expect(updated.version).toBe(core.loadTableDefinitionWithVersion('dws_order')?.version)
      const chained = await updateTableMeta(layer, 'dws_order', { description: '改两版' }, { recorder, expected_version: updated.version })
      expect(chained.ok).toBe(true)
    }
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
    expect(updated.ok).toBe(true)
    if (updated.ok) {
      expect(updated.version).toMatch(HEX64)
      expect(updated.version).toBe(core.loadEventDefinitionWithVersion('evt_click')?.version)
    }
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

describe('write receipts (#108 — version as the write side\'s answer)', () => {
  test('writeTable resolves to the written file\'s fingerprint', async () => {
    const layer = newLayer()
    const written = await writeTable(layer, 'dws_new', dwsDoc('dws_new'), {}, { recorder })
    expect(written.ok).toBe(true)
    if (written.ok) {
      expect(written.version).toMatch(HEX64)
      expect(written.version).toBe(definitionVersion(layer, 'table', 'dws_new'))
    }
  })

  test('a byte-stable no-op updateTableMeta returns the CURRENT fingerprint', async () => {
    const layer = newLayer()
    writeFileSync(join(layer, 'tables', 'dws_order.yaml'), dumpYaml(dwsDoc('dws_order')))
    const before = definitionVersion(layer, 'table', 'dws_order')
    expect(before).not.toBeNull()

    // An empty overlay re-serializes the same object to the same bytes: no
    // semantic change, no commit — and the receipt still names the file's
    // current fingerprint (#107 Q2's "no-op 恒返当前指纹", zero extra I/O).
    const updated = await updateTableMeta(layer, 'dws_order', {}, { recorder, expected_version: before! })
    expect(updated.ok).toBe(true)
    if (updated.ok) expect(updated.version).toBe(before)
  })

  test('Core.updateTableMeta\'s receipt names the POST-hook fingerprint — the on-write hook may rewrite the same file', async () => {
    const layer = newLayer()
    // dws_pay carries server_id; dim_server keys on it — the autoEnrich hook's
    // DIM-join discovery writes dimension_refs into dws_pay AFTER the meta
    // write lands, moving the very file the primitive just fingerprinted.
    writeFileSync(join(layer, 'tables', 'dim_server.yaml'), dumpYaml(dimDoc('dim_server', 'server_id')))
    writeFileSync(join(layer, 'tables', 'dws_pay.yaml'), dumpYaml(dwsDoc('dws_pay')))
    const core = new SemanticGroundingCore({ semanticRoot: layer })
    core.setTier2Recorder(recorder)

    const before = definitionVersion(layer, 'table', 'dws_pay')
    expect(before).not.toBeNull()
    const res = await core.updateTableMeta('dws_pay', { description: '改一版' }, { expected_version: before! })
    expect(res.ok).toBe(true)
    if (res.ok) {
      const after = definitionVersion(layer, 'table', 'dws_pay')
      expect(after).not.toBe(before)
      // The receipt names the file as the WHOLE write left it (primitive +
      // hook), not as the primitive alone left it — otherwise the caller's
      // next baseline write would be rejected against a dead fingerprint.
      expect(res.version).toBe(after)
      // And that receipt round-trips as the next write's baseline.
      const chained = await core.updateTableMeta('dws_pay', { description: '再改一版' }, { expected_version: res.version })
      expect(chained.ok).toBe(true)
    }
  })
})

/**
 * The data-memory layer's domain contracts (ADR-0023 / #152, write-side halves
 * of ADR-0026 / ADR-0027): `SemanticGroundingCore.recordMemories` /
 * `countMemoriesOnEdges` and the incremental anchor index `memory.ts` owns.
 *
 * Mirrors `concept-write.spec.ts`'s shape — Core methods called directly with
 * a no-op recorder, pinning the domain logic the MCP handler thins to.
 *
 * Coverage:
 * - the three scenario cards' happy paths (E3 inference / A3 practice / G3′
 *   incident, `docs/data-memory-scenarios.md` §6): files land under `memory/`,
 *   `recorded` is server-written, anchors canonicalize bare → prefixed.
 * - per-type required/forbidden fields (ADR-0023 R7) reject with the item index.
 * - anchor existence (node / column / edge, ADR-0023 R4) rejects.
 * - `supersedes` existence check only — a referenced entry whose own anchors
 *   dangle is fine (ADR-0026 R6).
 * - deterministic NOOP vs cross-session re-record (ADR-0023 R9).
 * - neighbors (same type + shared anchor, still valid) and wrong-hiding.
 * - `contradicts` four checks + the contested-wrong `basis` guard (ADR-0027).
 * - the incremental index: stat-every-file, parse-only-what-moved, sees writes
 *   this process did not make (ADR-0023 R1).
 * - `countMemoriesOnEdges` (ADR-0026 R5's substrate half).
 *
 * @see docs/adr/0023-memory-storage-shape-and-node-ids.md
 * @see docs/adr/0026-dangling-memory-anchors.md
 * @see docs/adr/0027-contested-memories.md
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { SemanticGroundingCore, dumpYaml, type Tier2Recorder } from '../src/index.ts'
import {
  MEMORY_ID_PATTERN,
  _memoryIndexProbeCounts,
  _memoryIndexProbeReset,
  memoryAnchorIndexFor,
  type MemoryDraft,
} from '../src/memory.ts'
import { fixtureTable } from './enrichment-fixtures.ts'

const noopRecorder: Tier2Recorder = { recordTier2Write: async () => 'noop-log-id' }

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memory-'))
  mkdirSync(join(root, 'tables'), { recursive: true })
  mkdirSync(join(root, 'concepts'), { recursive: true })
  mkdirSync(join(root, 'events'), { recursive: true })
  writeFileSync(join(root, 'config.yaml'), dumpYaml({ scope_id: 'fixture' }), 'utf8')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The E3-card table: a DWS whose `ch_id` column carries the 「2渠」黑话. */
function writeAccTable(extra: Record<string, unknown> = {}): void {
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
    ...extra,
  })), 'utf8')
}

function writeShopDim(): void {
  writeFileSync(join(root, 'tables', 'dim_shop.yaml'), dumpYaml(fixtureTable({
    table_name: 'dim_shop',
    kind: 'dim',
    columns: [{ name: 'shop_id', type: 'string', comment: '渠道id', role: 'dimension' }],
    primary_key: ['shop_id'],
    label_columns: ['shop_id'],
  })), 'utf8')
}

function writePaymentConcept(): void {
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

function writePayEvent(): void {
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

function fullCorpus(): void {
  writeAccTable()
  writeShopDim()
  writePaymentConcept()
  writePayEvent()
}

function newCore(): SemanticGroundingCore {
  const core = new SemanticGroundingCore({ semanticRoot: root, scopeId: 'fixture', autoEnrich: false })
  core.setTier2Recorder(noopRecorder)
  return core
}

function memoryFiles(): string[] {
  const dir = join(root, 'memory')
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.yaml')).sort() : []
}

function readMemoryYaml(id: string): Record<string, unknown> {
  return yaml.load(readFileSync(join(root, 'memory', `${id}.yaml`), 'utf8')) as Record<string, unknown>
}

/** Record one entry and return its row (fail-loud on rejection). */
async function recordOne(core: SemanticGroundingCore, draft: MemoryDraft, session = 's1'): Promise<{ id: string; neighbors: { id: string }[] }> {
  const res = await core.recordMemories([draft], { session, agent: 'test-agent' })
  if (!res.ok) throw new Error(`recordMemories rejected: ${res.error}`)
  const row = res.results[0]
  if (row === undefined) throw new Error('no row')
  return { id: row.id, neighbors: row.neighbors.map(n => ({ id: n.id })) }
}

// ── The three scenario cards' happy paths (§6 of the cards doc) ─────────────

describe('recordMemories — the three seed cards (E3 / A3 / G3′)', () => {
  it('E3 (内部黑话 → inference): lands one file, server-written recorded, canonical anchors', async () => {
    fullCorpus()
    const core = newCore()
    const { id } = await recordOne(core, {
      type: 'inference',
      anchors: ['dws_acc', 'dws_acc#ch_id'], // bare name + column fragment
      body: '业务说「2渠」指 ch_id(渠道id);「1渠」指 ch_type。黑话此前只活在列注释里。',
      basis: 'dws_acc 列注释:ch_type=渠道(1渠)、ch_id=渠道id(2渠)',
    })
    expect(id).toMatch(MEMORY_ID_PATTERN)
    expect(memoryFiles()).toEqual([`${id}.yaml`])
    const entry = readMemoryYaml(id)
    // ADR-0023 R4: bare in, prefixed out — and the index counts the anchor on
    // the parent definition (the column is display-nearness, not a node).
    expect(entry.anchors).toEqual(['table:dws_acc', 'table:dws_acc#ch_id'])
    expect(entry.type).toBe('inference')
    expect(entry.valid_from).toBeUndefined()
    // R5: recorded is server-written — session/agent come from opts, at is ISO.
    expect(entry.recorded).toMatchObject({ session: 's1', agent: 'test-agent' })
    expect(typeof (entry.recorded as Record<string, unknown>).at).toBe('string')
    expect(entry.id).toBe(id)
  })

  it('A3 (大R口径 → practice): basis + optional valid_from land', async () => {
    fullCorpus()
    const core = newCore()
    const { id } = await recordOne(core, {
      type: 'practice',
      anchors: ['concept:payment'],
      body: '「大R 留存」本次口径:r_level ∈ 07–09 视为大R;语料无阈值定义,本次自选。',
      basis: '本次自选口径:业务仅说「大R」,全语料无一处定义金额/档位',
      valid_from: '2026-10-16',
    })
    const entry = readMemoryYaml(id)
    expect(entry.valid_from).toBe('2026-10-16')
    expect(entry.valid_until).toBeUndefined()
  })

  it('G3′ (未产出事故 → incident): closed window lands; edge anchors resolve canonically', async () => {
    fullCorpus()
    const core = newCore()
    const { id } = await recordOne(core, {
      type: 'incident',
      anchors: ['table:dws_acc -joins-> table:dim_shop'],
      body: '2026-10-01 上游未产出,当天指标偏低,跨期对比须排除或标注该日。',
      valid_from: '2026-10-01',
      valid_until: '2026-10-01',
    })
    const entry = readMemoryYaml(id)
    expect(entry.anchors).toEqual(['table:dws_acc -joins-> table:dim_shop'])
  })
})

// ── Per-type field rules (ADR-0023 R7) ──────────────────────────────────────

describe('recordMemories — per-type required/forbidden fields', () => {
  it('incident without valid_until rejects, naming the 1-based item index', async () => {
    fullCorpus()
    const core = newCore()
    const res = await core.recordMemories([
      { type: 'caveat', anchors: ['dws_acc'], body: 'ok entry' },
      { type: 'incident', anchors: ['dws_acc'], body: 'no window', valid_from: '2026-10-01' },
    ], { session: 's1', agent: 'test-agent' })
    expect(res).toMatchObject({ ok: false, item_index: 2 })
    if (!res.ok) expect(res.error).toContain('item 2')
    // 整批原子: the valid first item did not land either.
    expect(memoryFiles()).toEqual([])
  })

  it('practice without basis rejects; inference with valid_from rejects', async () => {
    fullCorpus()
    const core = newCore()
    const a = await core.recordMemories([{ type: 'practice', anchors: ['dws_acc'], body: 'x' }], { session: 's1', agent: 'a' })
    expect(a).toMatchObject({ ok: false, item_index: 1 })
    const b = await core.recordMemories([{ type: 'inference', anchors: ['dws_acc'], body: 'x', basis: 'y', valid_from: '2026-10-01' }], { session: 's1', agent: 'a' })
    expect(b).toMatchObject({ ok: false, item_index: 1 })
  })
})

// ── Anchor existence (ADR-0023 R4) ──────────────────────────────────────────

describe('recordMemories — write-time anchor existence', () => {
  it('a missing node, a missing column, and a missing/reversed edge each reject the batch', async () => {
    fullCorpus()
    const core = newCore()
    for (const anchors of [['table:nope'], ['dws_acc#no_such_col'], ['table:dim_shop -joins-> table:dws_acc']]) {
      const res = await core.recordMemories([{ type: 'caveat', anchors, body: 'x' }], { session: 's1', agent: 'a' })
      expect(res).toMatchObject({ ok: false, item_index: 1 })
    }
    expect(memoryFiles()).toEqual([])
  })

  it('an event column fragment and a concept node resolve (prefixed output)', async () => {
    fullCorpus()
    const core = newCore()
    const { id } = await recordOne(core, { type: 'caveat', anchors: ['pay.order#pay_amt', 'payment'], body: 'x' })
    expect(readMemoryYaml(id).anchors).toEqual(['event:pay.order#pay_amt', 'concept:payment'])
  })
})

// ── supersedes (ADR-0026 R6) ────────────────────────────────────────────────

describe('recordMemories — supersedes', () => {
  it('a non-existent target rejects; an existing one lands with the reference', async () => {
    fullCorpus()
    const core = newCore()
    const miss = await core.recordMemories([{ type: 'practice', anchors: ['dws_acc'], body: 'x', basis: 'b', supersedes: [{ id: 'mem-20260101-aaaaaaaa', reason: 'outdated' }] }], { session: 's1', agent: 'a' })
    expect(miss).toMatchObject({ ok: false, item_index: 1 })

    const first = await recordOne(core, { type: 'practice', anchors: ['dws_acc'], body: 'old rule', basis: 'b' })
    const second = await recordOne(core, {
      type: 'practice', anchors: ['dws_acc'], body: 'new rule', basis: 'b2',
      supersedes: [{ id: first.id, reason: 'outdated' }],
    })
    expect(readMemoryYaml(second.id).supersedes).toEqual([{ id: first.id, reason: 'outdated' }])
  })

  it('supersedes a DANGLING entry succeeds — the referenced entry\'s anchors are not re-checked (ADR-0026 R6)', async () => {
    fullCorpus()
    const core = newCore()
    // The doomed table and one memory anchored on it.
    writeFileSync(join(root, 'tables', 'dws_old.yaml'), dumpYaml(fixtureTable({
      table_name: 'dws_old', kind: 'dws',
      columns: [{ name: 'x', type: 'string', comment: '', role: 'dimension' }],
    })), 'utf8')
    const dangling = await recordOne(core, { type: 'practice', anchors: ['table:dws_old'], body: 'about to dangle', basis: 'b' })
    // The anchor target disappears (git-side removal — no tool, ADR-0026 Context).
    rmSync(join(root, 'tables', 'dws_old.yaml'))
    // The new entry's OWN anchors must exist; the superseded one's may not.
    const res = await core.recordMemories([{
      type: 'practice', anchors: ['dws_acc'], body: 'replacement', basis: 'b2',
      supersedes: [{ id: dangling.id, reason: 'outdated' }],
    }], { session: 's1', agent: 'a' })
    expect(res.ok).toBe(true)
  })
})

// ── NOOP vs cross-session (ADR-0023 R9) ─────────────────────────────────────

describe('recordMemories — deterministic NOOP vs cross-session re-record', () => {
  it('same session + type + anchor set + normalized body = idempotent; a different session re-records', async () => {
    fullCorpus()
    const core = newCore()
    const draft: MemoryDraft = {
      type: 'observation',
      anchors: ['dws_acc', 'dim_shop'],
      body: 'ds=20261015 实测:join 后行数 877 vs 873 distinct id。',
      valid_from: '2026-10-15',
      valid_until: '2026-10-15',
    }
    const first = await recordOne(core, draft, 'session-a')
    expect(first.neighbors).toEqual([])
    // Same session, same content (whitespace re-wrapped) → NOOP, same id.
    const res = await core.recordMemories([{ ...draft, body: `ds=20261015 实测:join 后行数 877  vs  873 distinct id。` }], { session: 'session-a', agent: 'test-agent' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.results[0]).toMatchObject({ verdict: 'idempotent', id: first.id })
    }
    expect(memoryFiles()).toHaveLength(1)
    // A different session, same content → a NEW entry (replication evidence).
    const other = await recordOne(core, draft, 'session-b')
    expect(other.id).not.toBe(first.id)
    expect(memoryFiles()).toHaveLength(2)
  })

  it('neighbors: a same-type sibling on a shared anchor appears; a wrong-superseded one does not', async () => {
    fullCorpus()
    const core = newCore()
    const a = await recordOne(core, { type: 'practice', anchors: ['dws_acc'], body: 'rule one', basis: 'b' }, 's1')
    expect(a.neighbors).toEqual([])
    const b = await recordOne(core, { type: 'practice', anchors: ['dws_acc'], body: 'rule two', basis: 'b' }, 's2')
    expect(b.neighbors.map(n => n.id)).toEqual([a.id])
    // Wrong-hide a: its neighbors slot empties (the superseding entry itself
    // is a legitimate new neighbor — same anchor, same type, still valid).
    await recordOne(core, {
      type: 'practice', anchors: ['dws_acc'], body: 'rule one was wrong', basis: 'evidence',
      supersedes: [{ id: a.id, reason: 'wrong' }],
    }, 's3')
    const c = await recordOne(core, { type: 'practice', anchors: ['dws_acc'], body: 'rule three', basis: 'b' }, 's4')
    expect(c.neighbors.map(n => n.id)).not.toContain(a.id)
    expect(c.neighbors.map(n => n.id)).toContain(b.id)
    expect(c.neighbors).toHaveLength(2)
  })
})

// ── contradicts + the contested-wrong basis guard (ADR-0027) ────────────────

describe('recordMemories — contradicts (ADR-0027 R3/R5)', () => {
  it('the four checks: exists, not wrong, not self-overlapping with supersedes', async () => {
    fullCorpus()
    const core = newCore()
    const x = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: 'no amplification', valid_from: '2026-09-15', valid_until: '2026-10-15' }, 's1')
    // (1) nonexistent id
    const r1 = await core.recordMemories([{ type: 'observation', anchors: ['dws_acc'], body: 'y', valid_from: '2026-09-15', valid_until: '2026-10-15', contradicts: ['mem-20260101-bbbbbbbb'] }], { session: 's2', agent: 'a' })
    expect(r1).toMatchObject({ ok: false, item_index: 1 })
    // (2) same id in supersedes and contradicts
    const r2 = await core.recordMemories([{
      type: 'observation', anchors: ['dws_acc'], body: 'y', valid_from: '2026-09-15', valid_until: '2026-10-15',
      supersedes: [{ id: x.id, reason: 'outdated' }], contradicts: [x.id],
    }], { session: 's2', agent: 'a' })
    expect(r2).toMatchObject({ ok: false, item_index: 1 })
    // (3) legal declaration lands, and the index carries the pair both ways.
    const y = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: '3x amplification', valid_from: '2026-09-01', valid_until: '2026-09-30', contradicts: [x.id] }, 's2')
    const index = memoryAnchorIndexFor(root)
    index.refresh(root)
    expect(index.contestedWithOf(x.id)).toEqual([y.id])
    expect(index.contestedWithOf(y.id)).toEqual([x.id])
    // (4) wrong-hidden id cannot be contested.
    const z = await recordOne(core, { type: 'practice', anchors: ['dws_acc'], body: 'to be hidden', basis: 'b' }, 's3')
    await recordOne(core, { type: 'practice', anchors: ['dws_acc'], body: 'hide it', basis: 'e', supersedes: [{ id: z.id, reason: 'wrong' }] }, 's4')
    const r4 = await core.recordMemories([{ type: 'practice', anchors: ['dws_acc'], body: 'q', basis: 'b', contradicts: [z.id] }], { session: 's5', agent: 'a' })
    expect(r4).toMatchObject({ ok: false, item_index: 1 })
  })

  it('superseding a CONTESTED entry as wrong without basis rejects; with basis it lands (ADR-0027 R5)', async () => {
    fullCorpus()
    const core = newCore()
    const x = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: 'no amplification', valid_from: '2026-09-15', valid_until: '2026-10-15' }, 's1')
    await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: '3x amplification', valid_from: '2026-09-01', valid_until: '2026-09-30', contradicts: [x.id] }, 's2')
    const rejected = await core.recordMemories([{
      type: 'observation', anchors: ['dws_acc'], body: 'settled: no amplification', valid_from: '2026-10-01', valid_until: '2026-10-02',
      supersedes: [{ id: x.id, reason: 'wrong' }],
    }], { session: 's3', agent: 'a' })
    expect(rejected).toMatchObject({ ok: false, item_index: 1 })
    if (!rejected.ok) expect(rejected.error).toContain('basis')
    const accepted = await core.recordMemories([{
      type: 'observation', anchors: ['dws_acc'], body: 'settled: no amplification', valid_from: '2026-10-01', valid_until: '2026-10-02',
      supersedes: [{ id: x.id, reason: 'wrong' }], basis: '覆盖重叠窗口的复测,证伪放大结论',
    }], { session: 's3', agent: 'a' })
    expect(accepted.ok).toBe(true)
    // The pair dissolved once one end is wrong-hidden.
    const index = memoryAnchorIndexFor(root)
    index.refresh(root)
    expect(index.contestedWithOf(x.id)).toEqual([])
  })
})

// ── The incremental anchor index (ADR-0023 R1) ──────────────────────────────

describe('MemoryAnchorIndex — stat-only refresh, parse-only-what-moved', () => {
  it('re-parses nothing when no file moved, parses exactly the moved/new files otherwise', async () => {
    fullCorpus()
    const core = newCore()
    const a = await recordOne(core, { type: 'caveat', anchors: ['dws_acc'], body: 'one' }, 's1')
    const b = await recordOne(core, { type: 'caveat', anchors: ['dim_shop'], body: 'two' }, 's1')
    const index = memoryAnchorIndexFor(root)
    index.refresh(root)
    expect(index.get(a.id)).toBeDefined()
    expect(index.get(b.id)).toBeDefined()

    _memoryIndexProbeReset()
    index.refresh(root)
    // Two files → two stats, zero parses (cumulative since the reset).
    expect(_memoryIndexProbeCounts()).toEqual({ parses: 0, stats: 2 })

    // A third file lands "from another process" (plain fs, no index knowledge):
    // the next refresh stats all three, parses exactly the new one, sees it.
    const foreignId = 'mem-20261016-zzzzzzzz'
    writeFileSync(join(root, 'memory', `${foreignId}.yaml`), dumpYaml({
      id: foreignId, type: 'caveat', anchors: ['table:dws_acc'], body: 'foreign',
      recorded: { session: 'other-process', agent: 'other', at: '2026-10-16T00:00:00Z' },
    }), 'utf8')
    index.refresh(root)
    // 2 + 3 stats (one refresh over three files), exactly 1 new parse.
    expect(_memoryIndexProbeCounts()).toEqual({ parses: 1, stats: 5 })
    expect(index.get(foreignId)?.recorded.session).toBe('other-process')

    // A removal is absorbed too (hand-git delete).
    rmSync(join(root, 'memory', `${foreignId}.yaml`))
    index.refresh(root)
    expect(index.get(foreignId)).toBeUndefined()
  })
})

// ── countMemoriesOnEdges (ADR-0026 R5's substrate half) ─────────────────────

describe('countMemoriesOnEdges', () => {
  it('counts still-visible entries anchored on the dying edge, and 0 without memories', async () => {
    fullCorpus()
    const core = newCore()
    expect(core.countMemoriesOnEdges([{ from: 'table:dws_acc', type: 'joins', to: 'table:dim_shop' }])).toBe(0)
    await recordOne(core, { type: 'caveat', anchors: ['table:dws_acc -joins-> table:dim_shop'], body: 'join pitfall' }, 's1')
    await recordOne(core, { type: 'caveat', anchors: ['table:dws_acc'], body: 'table-level, not the edge' }, 's1')
    expect(core.countMemoriesOnEdges([{ from: 'table:dws_acc', type: 'joins', to: 'table:dim_shop' }])).toBe(1)
    // Wrong-hiding the entry drops the count (a hidden entry cannot dangle).
    const edgeEntry = memoryAnchorIndexFor(root)
    const files = memoryFiles()
    edgeEntry.refresh(root)
    const targetId = files.map(f => readMemoryYaml(f.replace('.yaml', ''))).find(e => Array.isArray(e.anchors) && (e.anchors as string[]).some(a => a.includes(' -joins-> ')))?.id as string
    await recordOne(core, {
      type: 'caveat', anchors: ['dws_acc'], body: 'retraction',
      supersedes: [{ id: targetId, reason: 'wrong' }],
    }, 's2')
    expect(core.countMemoriesOnEdges([{ from: 'table:dws_acc', type: 'joins', to: 'table:dim_shop' }])).toBe(0)
  })
})

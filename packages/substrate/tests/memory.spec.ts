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
 * - the replicated-promotion guard's every arm (#136 / ADR-0021 R6/R7 +
 *   ADR-0027 R6): distinct-session distinct-day 正路, same-session / same-day /
 *   wrong-excluded-too-few / incident / contested 拒路 — and the `promoted`
 *   back-pointer append (ADR-0023 R6): append-only per file, server-stamped
 *   `{to, at, session}`, visible to the anchor index.
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
import { SemanticGroundingCore, dumpYaml } from '../src/index.ts'
import {
  MEMORY_ID_PATTERN,
  _memoryIndexProbeCounts,
  _memoryIndexProbeReset,
  memoryAnchorIndexFor,
  type MemoryDraft,
} from '../src/memory.ts'
import { fixtureTable } from './enrichment-fixtures.ts'
import { fullCorpus, newMemoryCore } from './memory-fixtures.ts'


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
    fullCorpus(root, true)
    const core = newMemoryCore(root)
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
    fullCorpus(root, true)
    const core = newMemoryCore(root)
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
    fullCorpus(root, true)
    const core = newMemoryCore(root)
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
    fullCorpus(root, true)
    const core = newMemoryCore(root)
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
    fullCorpus(root, true)
    const core = newMemoryCore(root)
    const a = await core.recordMemories([{ type: 'practice', anchors: ['dws_acc'], body: 'x' }], { session: 's1', agent: 'a' })
    expect(a).toMatchObject({ ok: false, item_index: 1 })
    const b = await core.recordMemories([{ type: 'inference', anchors: ['dws_acc'], body: 'x', basis: 'y', valid_from: '2026-10-01' }], { session: 's1', agent: 'a' })
    expect(b).toMatchObject({ ok: false, item_index: 1 })
  })
})

// ── Anchor existence (ADR-0023 R4) ──────────────────────────────────────────

describe('recordMemories — write-time anchor existence', () => {
  it('a missing node, a missing column, and a missing/reversed edge each reject the batch', async () => {
    fullCorpus(root, true)
    const core = newMemoryCore(root)
    for (const anchors of [['table:nope'], ['dws_acc#no_such_col'], ['table:dim_shop -joins-> table:dws_acc']]) {
      const res = await core.recordMemories([{ type: 'caveat', anchors, body: 'x' }], { session: 's1', agent: 'a' })
      expect(res).toMatchObject({ ok: false, item_index: 1 })
    }
    expect(memoryFiles()).toEqual([])
  })

  it('an event column fragment and a concept node resolve (prefixed output)', async () => {
    fullCorpus(root, true)
    const core = newMemoryCore(root)
    const { id } = await recordOne(core, { type: 'caveat', anchors: ['pay.order#pay_amt', 'payment'], body: 'x' })
    expect(readMemoryYaml(id).anchors).toEqual(['event:pay.order#pay_amt', 'concept:payment'])
  })
})

// ── supersedes (ADR-0026 R6) ────────────────────────────────────────────────

describe('recordMemories — supersedes', () => {
  it('a non-existent target rejects; an existing one lands with the reference', async () => {
    fullCorpus(root, true)
    const core = newMemoryCore(root)
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
    fullCorpus(root, true)
    const core = newMemoryCore(root)
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
    fullCorpus(root, true)
    const core = newMemoryCore(root)
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
    fullCorpus(root, true)
    const core = newMemoryCore(root)
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
    fullCorpus(root, true)
    const core = newMemoryCore(root)
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
    fullCorpus(root, true)
    const core = newMemoryCore(root)
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
    fullCorpus(root, true)
    const core = newMemoryCore(root)
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
    fullCorpus(root, true)
    const core = newMemoryCore(root)
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

// ── The replicated-promotion guard + back-pointer append (#136) ─────────────

/**
 * Re-stamp one memory file's `recorded.at` — the test stand-in for "recorded
 * on another UTC day" (`recorded.at` is server-written now, so a same-test
 * second entry would share today's date). Plain fs, the same "another
 * process's write" posture the index tests take.
 */
function reStampRecordedAt(id: string, at: string): void {
  const entry = readMemoryYaml(id)
  const recorded = entry.recorded as Record<string, unknown>
  recorded.at = at
  writeFileSync(join(root, 'memory', `${id}.yaml`), dumpYaml(entry), 'utf8')
}

describe('checkReplicatedEvidence — the ③ server-side guard (ADR-0021 R6/R7 + ADR-0027 R6)', () => {
  it('two counting entries from distinct sessions on distinct UTC days verify', async () => {
    fullCorpus(root, true)
    const core = newMemoryCore(root)
    const a = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: 'join 后行数 877。', valid_from: '2026-10-01', valid_until: '2026-10-01' }, 'session-a')
    const b = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: 'join 后行数 877。', valid_from: '2026-10-02', valid_until: '2026-10-02' }, 'session-b')
    reStampRecordedAt(a.id, '2026-10-01T09:00:00.000Z')
    reStampRecordedAt(b.id, '2026-10-02T10:00:00.000Z')
    const check = core.checkReplicatedEvidence([a.id, b.id])
    expect(check).toEqual({ ok: true, effective: [a.id, b.id] })
  })

  it('same-session citations reject naming the two ids; same-day citations reject naming the shared day', async () => {
    fullCorpus(root, true)
    const core = newMemoryCore(root)
    const a = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: 'first', valid_from: '2026-10-01', valid_until: '2026-10-01' }, 'session-a')
    const b = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: 'second', valid_from: '2026-10-02', valid_until: '2026-10-02' }, 'session-a')
    expect(b.id).not.toBe(a.id) // distinct bodies: no deterministic NOOP
    reStampRecordedAt(b.id, '2026-10-02T10:00:00.000Z') // distinct day, SAME session
    const sameSession = core.checkReplicatedEvidence([a.id, b.id])
    expect(sameSession).toMatchObject({ ok: false, reason: 'same_session' })
    if (!sameSession.ok) {
      expect(sameSession.error).toContain(a.id)
      expect(sameSession.error).toContain(b.id)
    }

    const c = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: 'third', valid_from: '2026-10-03', valid_until: '2026-10-03' }, 'session-c')
    const d = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: 'fourth', valid_from: '2026-10-04', valid_until: '2026-10-04' }, 'session-d')
    // Both re-stamped onto the SAME UTC day (different clocks, one calendar day).
    reStampRecordedAt(c.id, '2026-10-05T01:00:00.000Z')
    reStampRecordedAt(d.id, '2026-10-05T23:00:00.000Z')
    const sameDay = core.checkReplicatedEvidence([c.id, d.id])
    expect(sameDay).toMatchObject({ ok: false, reason: 'same_day' })
    if (!sameDay.ok) {
      expect(sameDay.error).toContain(c.id)
      expect(sameDay.error).toContain('2026-10-05')
    }
  })

  it('a wrong-superseded citation does not count — it drops, and the survivors must still be ≥2', async () => {
    fullCorpus(root, true)
    const core = newMemoryCore(root)
    const a = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: 'first', valid_from: '2026-10-01', valid_until: '2026-10-01' }, 'session-a')
    const b = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: 'second', valid_from: '2026-10-02', valid_until: '2026-10-02' }, 'session-b')
    const doomed = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: 'third', valid_from: '2026-10-03', valid_until: '2026-10-03' }, 'session-c')
    reStampRecordedAt(a.id, '2026-10-01T09:00:00.000Z')
    reStampRecordedAt(b.id, '2026-10-02T09:00:00.000Z')
    await recordOne(core, {
      type: 'observation', anchors: ['dws_acc'], body: 'retraction', valid_from: '2026-10-04', valid_until: '2026-10-04',
      supersedes: [{ id: doomed.id, reason: 'wrong' }],
    }, 'session-d')
    // Two counting + one wrong-hidden → ok, and the wrong one is NOT `effective`.
    const okCheck = core.checkReplicatedEvidence([a.id, doomed.id, b.id])
    expect(okCheck).toEqual({ ok: true, effective: [a.id, b.id] })
    // One counting + one wrong-hidden → too_few, naming the excluded id.
    const few = core.checkReplicatedEvidence([a.id, doomed.id])
    expect(few).toMatchObject({ ok: false, reason: 'too_few' })
    if (!few.ok) expect(few.error).toContain(doomed.id)
  })

  it('an incident citation rejects outright (ADR-0021 R7 — incidents never promote)', async () => {
    fullCorpus(root, true)
    const core = newMemoryCore(root)
    const a = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: 'x', valid_from: '2026-10-01', valid_until: '2026-10-01' }, 'session-a')
    const inc = await recordOne(core, { type: 'incident', anchors: ['dws_acc'], body: '上游未产出。', valid_from: '2026-10-02', valid_until: '2026-10-02' }, 'session-b')
    const check = core.checkReplicatedEvidence([a.id, inc.id])
    expect(check).toMatchObject({ ok: false, reason: 'incident' })
    if (!check.ok) expect(check.error).toContain(inc.id)
  })

  it('a contested citation rejects naming the pair and the adjudication remedy (ADR-0027 R6)', async () => {
    fullCorpus(root, true)
    const core = newMemoryCore(root)
    const x = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: 'no amplification', valid_from: '2026-09-15', valid_until: '2026-10-15' }, 'session-a')
    const y = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: '3x amplification', valid_from: '2026-09-01', valid_until: '2026-09-30', contradicts: [x.id] }, 'session-b')
    const other = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: 'x', valid_from: '2026-10-01', valid_until: '2026-10-01' }, 'session-c')
    const check = core.checkReplicatedEvidence([x.id, other.id])
    expect(check).toMatchObject({ ok: false, reason: 'contested' })
    if (!check.ok) {
      expect(check.error).toContain(x.id)
      expect(check.error).toContain(y.id)
      expect(check.error).toContain('adjudicate')
    }
    // ① source / ② user-stated are not this guard's business — only the
    // citation goes through it, and the caller never reaches here without one.
    expect(core.checkReplicatedEvidence(['mem-20260101-aaaaaaaa'])).toMatchObject({ ok: false, reason: 'not_found' })
  })
})

describe('appendPromotionBackpointers — the same-commit `promoted` append (ADR-0023 R6)', () => {
  it('appends {to, at, session} onto each cited file, leaving every other field untouched', async () => {
    fullCorpus(root, true)
    const core = newMemoryCore(root)
    const a = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: 'join 后行数 877。', valid_from: '2026-10-01', valid_until: '2026-10-01' }, 'session-a')
    const b = await recordOne(core, { type: 'practice', anchors: ['concept:payment'], body: '口径。', basis: 'basis' }, 'session-b')
    reStampRecordedAt(a.id, '2026-10-01T09:00:00.000Z')
    reStampRecordedAt(b.id, '2026-10-02T09:00:00.000Z')
    const check = core.checkReplicatedEvidence([a.id, b.id])
    if (!check.ok) throw new Error(`guard rejected: ${check.error}`)
    await core.appendPromotionBackpointers(
      check.effective.flatMap(id => [id, id].map(() => ({ id, to: 'concept:payment' }))),
      { session: 'session-promote' },
    )
    for (const id of [a.id, b.id]) {
      const entry = readMemoryYaml(id)
      const promoted = entry.promoted as ReadonlyArray<Record<string, unknown>>
      expect(promoted).toHaveLength(1) // duplicate (id,to) pairs collapse per file
      expect(promoted[0]).toMatchObject({ to: 'concept:payment', session: 'session-promote' })
      expect(typeof promoted[0]?.at).toBe('string')
      // Append-only: everything the entry was is still exactly what it was.
      expect(entry.body).toBeDefined()
      expect((entry.recorded as Record<string, unknown>).session).toBe(id === a.id ? 'session-a' : 'session-b')
    }
    // A second promotion to a different target appends, never replaces.
    await core.appendPromotionBackpointers([{ id: a.id, to: 'table:dws_acc' }], { session: 'session-promote-2' })
    const again = readMemoryYaml(a.id).promoted as ReadonlyArray<Record<string, unknown>>
    expect(again).toHaveLength(2)
    expect(again[1]).toMatchObject({ to: 'table:dws_acc', session: 'session-promote-2' })
    // The anchor index sees the appended files on its next refresh.
    const index = memoryAnchorIndexFor(root)
    index.refresh(root)
    expect((index.get(a.id)?.promoted as unknown[] | undefined)?.length).toBe(2)
  })
})

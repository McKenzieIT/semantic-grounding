/**
 * The data-memory read surface's domain contracts (ADR-0024 / #154, read-side
 * halves of ADR-0026 R2–R4 + ADR-0027 R4): `readDefinitionMemories` /
 * `readOrphanedMemories` / `memoryCountsByNode` / `readEdgeMemories`.
 *
 * Mirrors `memory.spec.ts`'s fixture shape (the write half's own spec) — Core
 * methods called directly over a hand-built corpus, pinning the visibility /
 * budget / ordering / contested-companion rules the MCP read tools spread.
 *
 * Coverage:
 * - the three scenario cards' read-side happy paths (E3 inference with the
 *   column anchor · A3 practice first · G3′ incident on the edge, both ends).
 * - G3′'s three states: inside the window / outside it / no window.
 * - budgets 8 / 5 / 3, type priority, recency, `*_truncated` per type; the
 *   caveat always-shown-never-budgeted arm.
 * - the `dim_server` split: many join edges cannot crowd out the dimension's
 *   own `memories`.
 * - wrong / outdated (both window arms) / promoted-fold visibility.
 * - contested: bidirectional `contested_with`, companion travel over the cap,
 *   cross-anchor pull with the companion's own anchor, counts including
 *   companions, wrong/outdated dissolving the pair.
 * - dangling: a removed relation's entries stay on both ends marked
 *   `relation_missing`; a deleted node yields `orphaned_memories` with
 *   `definition_missing`; restoring the target restores the live mount.
 * - `memoryCountsByNode` agrees with the no-window mount; empty layer = empty
 *   views (the zero-tax substrate arm).
 *
 * @see docs/adr/0024-memory-read-surface.md
 * @see docs/adr/0026-dangling-memory-anchors.md
 * @see docs/adr/0027-contested-memories.md
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dumpYaml, SemanticGroundingCore } from '../src/index.ts'
import type { MemoryDraft, MemoryViewEntry } from '../src/memory.ts'
import { fixtureTable } from './enrichment-fixtures.ts'
import { fullCorpus, newMemoryCore, writeAccTable, writePaymentConcept, writeShopDim } from './memory-fixtures.ts'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memory-read-'))
  mkdirSync(join(root, 'tables'), { recursive: true })
  mkdirSync(join(root, 'concepts'), { recursive: true })
  mkdirSync(join(root, 'events'), { recursive: true })
  writeFileSync(join(root, 'config.yaml'), dumpYaml({ scope_id: 'fixture' }), 'utf8')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function recordOne(core: SemanticGroundingCore, draft: MemoryDraft, session = 's1'): Promise<string> {
  const res = await core.recordMemories([draft], { session, agent: 'test-agent' })
  if (!res.ok) throw new Error(`recordMemories rejected: ${res.error}`)
  return res.results[0]?.id as string
}

/** The mount's rows condensed to `[type, anchor]` for shape-level asserts. */
function shape(rows: readonly MemoryViewEntry[]): string[] {
  return rows.map(r => `${r.type}@${r.anchor}`)
}

// ── The three scenario cards, read side ────────────────────────────────────

describe('readDefinitionMemories — the three seed cards (E3 / A3 / G3′)', () => {
  it('E3: the inference surfaces on dws_acc with the column fragment as its anchor', async () => {
    fullCorpus(root)
    const core = newMemoryCore(root)
    const id = await recordOne(core, {
      type: 'inference',
      anchors: ['dws_acc', 'dws_acc#ch_id'],
      body: '业务说「2渠」指 ch_id;「1渠」指 ch_type。',
      basis: 'dws_acc 列注释',
    })
    const view = core.readDefinitionMemories('table:dws_acc')
    expect(view.memories).toHaveLength(1)
    const row = view.memories[0] as MemoryViewEntry
    expect(row.id).toBe(id)
    // R5: the column fragment is the site's most specific live anchor — the
    // anchor surfaces verbatim (`table:dws_acc#ch_id`), never re-invented.
    expect(row.anchor).toBe('table:dws_acc#ch_id')
    expect(row.body).toContain('2渠')
    expect(row.basis).toBe('dws_acc 列注释')
    expect(row).not.toHaveProperty('column_missing')
    expect(view.edge_memories).toEqual([])
    expect(view).not.toHaveProperty('memories_truncated')
  })

  it('A3: the practice surfaces on the concept, ranked ahead of lower types', async () => {
    fullCorpus(root)
    const core = newMemoryCore(root)
    const practice = await recordOne(core, {
      type: 'practice',
      anchors: ['concept:payment'],
      body: '「大R 留存」本次口径:r_level ∈ 07–09 视为大R。',
      basis: '本次自选口径',
      valid_from: '2026-10-16',
    })
    const observation = await recordOne(core, {
      type: 'observation',
      anchors: ['concept:payment'],
      body: 'ds=20261015 大R 行数 877。',
      valid_from: '2026-10-15',
      valid_until: '2026-10-15',
    })
    const view = core.readDefinitionMemories('concept:payment')
    expect(view.memories.map(r => r.id)).toEqual([practice, observation])
    expect(view.memories[1]?.valid_until).toBe('2026-10-15')
  })

  it('G3′: the incident surfaces in BOTH ends\' edge_memories with the edge anchor', async () => {
    fullCorpus(root)
    const core = newMemoryCore(root)
    const id = await recordOne(core, {
      type: 'incident',
      anchors: ['table:dws_acc -joins-> table:dim_shop'],
      body: '2026-10-01 上游未产出,当天指标偏低,跨期对比须排除或标注该日。',
      valid_from: '2026-10-01',
      valid_until: '2026-10-01',
    })
    for (const node of ['table:dws_acc', 'table:dim_shop']) {
      const view = core.readDefinitionMemories(node)
      expect(view.memories).toEqual([])
      expect(shape(view.edge_memories)).toEqual([`incident@table:dws_acc -joins-> table:dim_shop`])
      expect(view.edge_memories[0]?.id).toBe(id)
      expect(view.edge_memories[0]).not.toHaveProperty('relation_missing')
    }
  })
})

// ── G3′'s three states (ADR-0024 R2/R3) ────────────────────────────────────

describe('readDefinitionMemories — the data window\'s three states', () => {
  async function incidentOnEdge(core: SemanticGroundingCore): Promise<string> {
    return recordOne(core, {
      type: 'incident',
      anchors: ['table:dws_acc -joins-> table:dim_shop'],
      body: '2026-10-01 上游未产出。',
      valid_from: '2026-10-01',
      valid_until: '2026-10-01',
    })
  }

  it('inside the window: visible; outside: hidden; no window: visible', async () => {
    fullCorpus(root)
    const core = newMemoryCore(root)
    const id = await incidentOnEdge(core)
    const at = (window: { from: string; to: string } | undefined) =>
      core.readDefinitionMemories('table:dws_acc', window !== undefined ? { data_window: window } : {}).edge_memories
    expect(at({ from: '2026-10-01', to: '2026-10-01' }).map(r => r.id)).toEqual([id])
    expect(at({ from: '2026-10-02', to: '2026-10-03' })).toEqual([])
    // 没有窗就不按今天隐藏 —— ADR-0021 R9's revision.
    expect(at(undefined).map(r => r.id)).toEqual([id])
  })

  it('an observation outside the window hides on the node site too', async () => {
    fullCorpus(root)
    const core = newMemoryCore(root)
    await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: '九月实测', valid_from: '2026-09-01', valid_until: '2026-09-30' })
    expect(core.readDefinitionMemories('table:dws_acc', { data_window: { from: '2026-10-01', to: '2026-10-02' } }).memories).toEqual([])
    expect(core.readDefinitionMemories('table:dws_acc').memories).toHaveLength(1)
  })
})

// ── Budgets, ordering, truncation (ADR-0024 R4) ────────────────────────────

describe('readDefinitionMemories — budget, ordering, truncation', () => {
  it('caps memories at 8, reports overflow per type, orders practice > incident > inference > observation', async () => {
    fullCorpus(root)
    const core = newMemoryCore(root)
    for (let i = 0; i < 5; i++) {
      await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: `obs ${i}`, valid_from: `2026-09-0${i + 1}`, valid_until: `2026-09-0${i + 1}` }, `s-obs-${i}`)
    }
    for (let i = 0; i < 3; i++) {
      await recordOne(core, { type: 'inference', anchors: ['dws_acc'], body: `inf ${i}`, basis: '列注释' }, `s-inf-${i}`)
    }
    const practice = await recordOne(core, { type: 'practice', anchors: ['dws_acc'], body: 'practice rule', basis: '口径' })
    const incident = await recordOne(core, { type: 'incident', anchors: ['dws_acc'], body: 'incident on node', valid_from: '2026-10-01', valid_until: '2026-10-01' })
    const view = core.readDefinitionMemories('table:dws_acc')
    expect(view.memories).toHaveLength(8)
    // Type priority leads: practice, incident, then inferences (recency within
    // type), then observations — the 9th+ visible observation is the overflow.
    expect(view.memories.map(r => r.id).slice(0, 2)).toEqual([practice, incident])
    expect(view.memories.filter(r => r.type === 'inference')).toHaveLength(3)
    expect(view.memories.filter(r => r.type === 'observation')).toHaveLength(3)
    expect(view.memories_truncated).toEqual({ observation: 2 })
  })

  it('a caveat is always shown and never occupies budget', async () => {
    fullCorpus(root)
    const core = newMemoryCore(root)
    for (let i = 0; i < 8; i++) {
      await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: `obs ${i}`, valid_from: '2026-09-01', valid_until: '2026-09-01' }, `s${i}`)
    }
    const caveat = await recordOne(core, { type: 'caveat', anchors: ['dws_acc'], body: '主键唯一性只在单分区上验过' })
    const view = core.readDefinitionMemories('table:dws_acc', { data_window: { from: '2026-10-01', to: '2026-10-02' } })
    // The window hides all eight observations; the caveat is unconditional.
    expect(view.memories.map(r => r.id)).toEqual([caveat])
    const noWindow = core.readDefinitionMemories('table:dws_acc')
    expect(noWindow.memories).toHaveLength(9) // 8 budgeted + the caveat outside
    expect(noWindow.memories[0]?.id).toBe(caveat) // caveat leads the order
    expect(noWindow).not.toHaveProperty('memories_truncated')
  })

  it('the dim_server split: six join edges cannot crowd out the dimension\'s own memories', async () => {
    writeShopDim(root)
    writePaymentConcept(root)
    const core = newMemoryCore(root)
    // Six DWS tables each joined to dim_shop, one incident per join edge
    // (caveats would bypass the budget — 恒展示不占预算 — so the cap needs a
    // budgeted type here).
    for (let i = 0; i < 6; i++) {
      const name = `dws_${i}`
      writeFileSync(join(root, 'tables', `${name}.yaml`), dumpYaml(fixtureTable({
        table_name: name,
        kind: 'dws',
        columns: [{ name: 'shop_id', type: 'string', comment: '', role: 'dimension' }],
        dimension_refs: [{ dim_table: 'dim_shop', derivation: '', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
      })), 'utf8')
      await recordOne(core, { type: 'incident', anchors: [`table:${name} -joins-> table:dim_shop`], body: `join 坑 ${i}`, valid_from: `2026-10-0${i + 1}`, valid_until: `2026-10-0${i + 1}` }, `s${i}`)
    }
    const own = await recordOne(core, { type: 'practice', anchors: ['dim_shop'], body: '维表口径:shop_id 即渠道id', basis: '列注释' })
    const view = core.readDefinitionMemories('table:dim_shop')
    // Own site: untouched by the six edges (R4's分栏独立预算).
    expect(view.memories.map(r => r.id)).toEqual([own])
    expect(view.memories_truncated).toBeUndefined()
    // Edge site: capped at 5 (recency keeps 10-01..10-05), overflow reported.
    expect(view.edge_memories).toHaveLength(5)
    expect(view.edge_memories_truncated).toEqual({ incident: 1 })
  })

  it('readEdgeMemories caps at 3 per edge for the relation tools', async () => {
    fullCorpus(root)
    const core = newMemoryCore(root)
    for (let i = 0; i < 4; i++) {
      await recordOne(core, { type: 'incident', anchors: ['table:dws_acc -joins-> table:dim_shop'], body: `坑 ${i}`, valid_from: `2026-10-0${i + 1}`, valid_until: `2026-10-0${i + 1}` }, `s${i}`)
    }
    const [view] = core.readEdgeMemories([{ a: 'table:dws_acc', b: 'table:dim_shop', type: 'joins' }])
    expect(view).toBeDefined()
    expect(view?.entries).toHaveLength(3)
    expect(view?.truncated).toEqual({ incident: 1 })
    // The undirected pair resolves the canonical anchor either way.
    const [flipped] = core.readEdgeMemories([{ a: 'table:dim_shop', b: 'table:dws_acc', type: 'joins' }])
    expect(flipped?.entries).toHaveLength(3)
  })
})

// ── Visibility: wrong / outdated / promoted (ADR-0024 R3) ──────────────────

describe('readDefinitionMemories — wrong / outdated / promoted', () => {
  it('wrong is permanently hidden; outdated hides without a window and shows when the window covers the old segment', async () => {
    fullCorpus(root)
    const core = newMemoryCore(root)
    const old = await recordOne(core, { type: 'practice', anchors: ['dws_acc'], body: '旧口径:大R ≥ 328', basis: 'b', valid_from: '2026-07-01' }, 's1')
    const wrong = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: '错的观察', valid_from: '2026-09-01', valid_until: '2026-09-01' }, 's1')
    await recordOne(core, {
      type: 'practice', anchors: ['dws_acc'], body: '新口径:大R ≥ 500', basis: 'b2', valid_from: '2026-10-01',
      supersedes: [{ id: old, reason: 'outdated' }],
    }, 's2')
    await recordOne(core, {
      type: 'observation', anchors: ['dws_acc'], body: '修正观察', valid_from: '2026-09-01', valid_until: '2026-09-01',
      supersedes: [{ id: wrong, reason: 'wrong' }],
    }, 's2')

    const noWindow = core.readDefinitionMemories('table:dws_acc')
    expect(noWindow.memories.map(r => r.id)).not.toContain(old) // outdated hidden
    expect(noWindow.memories.map(r => r.id)).not.toContain(wrong) // wrong hidden
    expect(noWindow.memories.filter(r => r.type === 'practice')).toHaveLength(1) // only现行

    // The window covering last quarter resurrects the old 口径 alongside the current one.
    const q3 = core.readDefinitionMemories('table:dws_acc', { data_window: { from: '2026-07-15', to: '2026-07-20' } })
    expect(q3.memories.map(r => r.id)).toContain(old)
    expect(q3.memories.filter(r => r.type === 'practice')).toHaveLength(2)
    // The wrong one stays out even inside its window.
    const sept = core.readDefinitionMemories('table:dws_acc', { data_window: { from: '2026-09-01', to: '2026-09-01' } })
    expect(sept.memories.map(r => r.id)).not.toContain(wrong)
  })

  it('a promoted entry folds: reference row, no body, no budget, not counted', async () => {
    fullCorpus(root)
    const core = newMemoryCore(root)
    const promoted = await recordOne(core, { type: 'practice', anchors: ['dws_acc'], body: '已晋升口径', basis: '用户明说' })
    // The #136 promotion append, hand-placed the way the promotion path will write it.
    const { readFileSync, writeFileSync: wf } = await import('node:fs')
    const yaml = await import('js-yaml')
    const path = join(root, 'memory', `${promoted}.yaml`)
    const entry = yaml.load(readFileSync(path, 'utf8')) as Record<string, unknown>
    wf(path, dumpYaml({ ...entry, promoted: [{ by: 'test', at: '2026-10-16' }] }), 'utf8')
    for (let i = 0; i < 8; i++) {
      await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: `obs ${i}`, valid_from: '2026-09-01', valid_until: '2026-09-01' }, `s${i}`)
    }
    const view = core.readDefinitionMemories('table:dws_acc')
    const folded = view.memories.find(r => r.id === promoted)
    expect(folded).toBeDefined()
    expect(folded?.promoted).toBe(true)
    expect(folded).not.toHaveProperty('body')
    // Folded does not occupy budget: all eight observations still fit.
    expect(view.memories.filter(r => r.type === 'observation')).toHaveLength(8)
    expect(view).not.toHaveProperty('memories_truncated')
    // And R6: counts exclude it.
    expect(core.memoryCountsByNode(['table:dws_acc']).get('table:dws_acc')).toEqual({ observation: 8 })
  })
})

// ── Contested companions (ADR-0027 R4) ─────────────────────────────────────

describe('readDefinitionMemories — contested companions', () => {
  it('contested_with is bidirectional; the companion travels over the cap, right behind its partner', async () => {
    fullCorpus(root)
    const core = newMemoryCore(root)
    // Recency is staged so exactly ONE of the pair earns a budget slot: x is
    // the newest observation, y the oldest — without companion travel y would
    // be the first dropped.
    const x = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: '无放大', valid_from: '2026-11-15', valid_until: '2026-11-30' }, 's1')
    const y = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: '放大 3 倍', valid_from: '2026-09-01', valid_until: '2026-09-30', contradicts: [x] }, 's2')
    for (let i = 0; i < 8; i++) {
      await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: `obs ${i}`, valid_from: `2026-10-0${i + 1}`, valid_until: `2026-10-0${i + 1}` }, `s${i}`)
    }
    const view = core.readDefinitionMemories('table:dws_acc')
    const ids = view.memories.map(r => r.id)
    // x earned slot 1; y travels right behind it — the list exceeds the cap
    // with companions only (ADR-0027 R4).
    expect(view.memories.length).toBe(9)
    expect(ids.indexOf(y)).toBe(ids.indexOf(x) + 1)
    expect(ids.filter(id => id !== x && id !== y)).toHaveLength(7)
    // Each contested row names the other.
    expect(view.memories.find(r => r.id === x)?.contested_with).toEqual([y])
    expect(view.memories.find(r => r.id === y)?.contested_with).toEqual([x])
    // Overflow counted only the NON-companion observation (10 candidates:
    // 8 budgeted + x + the traveling y).
    expect(view.memories_truncated).toEqual({ observation: 1 })
  })

  it('a cross-anchor companion is pulled in with its own anchor, and counted (R6 + ADR-0027 R4)', async () => {
    fullCorpus(root)
    const core = newMemoryCore(root)
    const here = await recordOne(core, { type: 'practice', anchors: ['dws_acc'], body: '口径 A', basis: 'b' }, 's1')
    const there = await recordOne(core, {
      type: 'practice', anchors: ['dim_shop'], body: '口径 B(相反)', basis: 'b',
      contradicts: [here],
    }, 's2')
    const view = core.readDefinitionMemories('table:dws_acc')
    expect(view.memories.map(r => r.id).sort()).toEqual([here, there].sort())
    const companion = view.memories.find(r => r.id === there)
    // 跨锚点随行: the companion carries its OWN anchor.
    expect(companion?.anchor).toBe('table:dim_shop')
    expect(companion?.contested_with).toEqual([here])
    // Counts include the traveling companion — on both nodes.
    expect(core.memoryCountsByNode(['table:dws_acc']).get('table:dws_acc')).toEqual({ practice: 2 })
    expect(core.memoryCountsByNode(['table:dim_shop']).get('table:dim_shop')).toEqual({ practice: 2 })
  })

  it('wrong-hiding or outdated-hiding a partner dissolves the pair', async () => {
    fullCorpus(root)
    const core = newMemoryCore(root)
    const x = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: '无放大', valid_from: '2026-09-15', valid_until: '2026-10-15' }, 's1')
    const y = await recordOne(core, { type: 'observation', anchors: ['dws_acc'], body: '放大 3 倍', valid_from: '2026-09-01', valid_until: '2026-09-30', contradicts: [x] }, 's2')
    // Adjudicate: y loses with evidence (basis required, ADR-0027 R5).
    await recordOne(core, {
      type: 'observation', anchors: ['dws_acc'], body: '复测:确无放大', valid_from: '2026-10-01', valid_until: '2026-10-02',
      supersedes: [{ id: y, reason: 'wrong' }], basis: '覆盖重叠窗口的复测',
    }, 's3')
    const after = core.readDefinitionMemories('table:dws_acc')
    expect(after.memories.find(r => r.id === x)?.contested_with).toBeUndefined()
    expect(after.memories.map(r => r.id)).not.toContain(y)

    // The outdated arm: x superseded outdated goes hidden without a window,
    // dissolving its pairs in that regime; a standing pair is the control.
    await recordOne(core, {
      type: 'observation', anchors: ['dws_acc'], body: '新测量:轻微放大', valid_from: '2026-10-03', valid_until: '2026-10-04',
      supersedes: [{ id: x, reason: 'outdated' }],
    }, 's4')
    const fresh = await recordOne(core, {
      type: 'observation', anchors: ['dws_acc'], body: '与旧口径相反', valid_from: '2026-09-20', valid_until: '2026-09-25',
      contradicts: [x],
    }, 's5')
    const control = await recordOne(core, {
      type: 'observation', anchors: ['dws_acc'], body: '新测量:无放大', valid_from: '2026-10-03', valid_until: '2026-10-04',
      contradicts: [fresh],
    }, 's6')
    const noWindow = core.readDefinitionMemories('table:dws_acc')
    // x is outdated-hidden without a window → its pair dissolved...
    expect(noWindow.memories.find(r => r.id === x)).toBeUndefined()
    expect(noWindow.memories.find(r => r.id === fresh)?.contested_with).toEqual([control])
    // ...while the standing (fresh, control) pair survives; and a window
    // covering x's old segment brings x — and its pair — back.
    const withWindow = core.readDefinitionMemories('table:dws_acc', { data_window: { from: '2026-09-20', to: '2026-09-25' } })
    expect(withWindow.memories.find(r => r.id === x)?.contested_with).toEqual([fresh])
    expect(withWindow.memories.find(r => r.id === fresh)?.contested_with).toEqual([x])
  })
})

// ── Dangling anchors (ADR-0026 R2–R4) ──────────────────────────────────────

describe('readDefinitionMemories / readOrphanedMemories — dangling anchors', () => {
  it('a removed relation\'s entry stays on both ends with relation_missing; restoring the edge clears the mark', async () => {
    fullCorpus(root)
    const core = newMemoryCore(root)
    const id = await recordOne(core, { type: 'caveat', anchors: ['table:dws_acc -joins-> table:dim_shop'], body: '该 join 在 shop_id=0 放大 3 倍' })
    // The edge dies the tool way: dws_acc loses its dimension_ref.
    writeFileSync(join(root, 'tables', 'dws_acc.yaml'), dumpYaml(fixtureTable({
      table_name: 'dws_acc',
      kind: 'dws',
      columns: [
        { name: 'ch_id', type: 'string', comment: '渠道id,又叫 2渠', role: 'dimension' },
        { name: 'ch_type', type: 'string', comment: '渠道,又叫 1渠', role: 'dimension' },
        { name: 'pay_amt', type: 'decimal', comment: '充值金额', role: 'measure' },
      ],
      domains: ['payment'],
    })), 'utf8')
    for (const node of ['table:dws_acc', 'table:dim_shop']) {
      const view = core.readDefinitionMemories(node)
      expect(view.edge_memories).toHaveLength(1)
      expect(view.edge_memories[0]?.id).toBe(id)
      expect(view.edge_memories[0]?.relation_missing).toBe(true)
      // 照常占预算与排序 — it IS the edge site's content.
      expect(view.edge_memories[0]?.anchor).toBe('table:dws_acc -joins-> table:dim_shop')
    }
    // Restoring the edge (the target back) restores the plain mount — 悬空读时现算.
    writeAccTable(root)
    const restored = core.readDefinitionMemories('table:dim_shop')
    expect(restored.edge_memories[0]?.id).toBe(id)
    expect(restored.edge_memories[0]).not.toHaveProperty('relation_missing')
  })

  it('a deleted column surfaces as a downgraded row with column_missing', async () => {
    fullCorpus(root)
    const core = newMemoryCore(root)
    const id = await recordOne(core, { type: 'caveat', anchors: ['dws_acc#pay_amt'], body: '该列曾有空值' })
    writeFileSync(join(root, 'tables', 'dws_acc.yaml'), dumpYaml(fixtureTable({
      table_name: 'dws_acc',
      kind: 'dws',
      columns: [
        { name: 'ch_id', type: 'string', comment: '渠道id,又叫 2渠', role: 'dimension' },
        { name: 'ch_type', type: 'string', comment: '渠道,又叫 1渠', role: 'dimension' },
      ],
      dimension_refs: [{ dim_table: 'dim_shop', derivation: '', join_keys: [{ dws_column: 'ch_id', dim_column: 'shop_id' }] }],
      domains: ['payment'],
    })), 'utf8')
    const view = core.readDefinitionMemories('table:dws_acc')
    // Falls back to the definition rather than being lost — marked.
    expect(view.memories).toHaveLength(1)
    expect(view.memories[0]?.id).toBe(id)
    expect(view.memories[0]?.anchor).toBe('table:dws_acc#pay_amt')
    expect(view.memories[0]?.column_missing).toBe(true)
  })

  it('a multi-anchor entry with a live anchor displays normally — only the dangling anchor would mark (ADR-0026 R4)', async () => {
    fullCorpus(root)
    const core = newMemoryCore(root)
    const id = await recordOne(core, { type: 'caveat', anchors: ['dws_acc', 'dws_acc#pay_amt'], body: '该表口径成立,该列曾有空值' })
    writeFileSync(join(root, 'tables', 'dws_acc.yaml'), dumpYaml(fixtureTable({
      table_name: 'dws_acc',
      kind: 'dws',
      columns: [
        { name: 'ch_id', type: 'string', comment: '', role: 'dimension' },
        { name: 'ch_type', type: 'string', comment: '', role: 'dimension' },
      ],
      dimension_refs: [{ dim_table: 'dim_shop', derivation: '', join_keys: [{ dws_column: 'ch_id', dim_column: 'shop_id' }] }],
      domains: ['payment'],
    })), 'utf8')
    const view = core.readDefinitionMemories('table:dws_acc')
    expect(view.memories).toHaveLength(1)
    expect(view.memories[0]?.id).toBe(id)
    // The node anchor resolves — normal display through it, no downgrade mark.
    expect(view.memories[0]?.anchor).toBe('table:dws_acc')
    expect(view.memories[0]).not.toHaveProperty('column_missing')
  })

  it('a deleted node yields orphaned_memories with definition_missing; edges with a surviving end hang there instead', async () => {
    fullCorpus(root)
    const core = newMemoryCore(root)
    const onNode = await recordOne(core, { type: 'practice', anchors: ['table:dim_shop'], body: '维表口径', basis: '列注释' })
    const onEdge = await recordOne(core, { type: 'caveat', anchors: ['table:dws_acc -joins-> table:dim_shop'], body: 'join 坑' })
    rmSync(join(root, 'tables', 'dim_shop.yaml'))
    const orphan = core.readOrphanedMemories('table:dim_shop')
    // The node-anchored entry orphans here; the edge entry hangs on the
    // SURVIVING end (dws_acc) instead — ADR-0026 R2.
    expect(orphan.orphaned_memories.map(r => r.id)).toEqual([onNode])
    expect(orphan.orphaned_memories[0]?.definition_missing).toBe(true)
    expect(orphan.orphaned_memories[0]?.anchor).toBe('table:dim_shop')
    const survivor = core.readDefinitionMemories('table:dws_acc')
    expect(survivor.edge_memories.map(r => r.id)).toEqual([onEdge])
    expect(survivor.edge_memories[0]?.relation_missing).toBe(true)
    expect(survivor.edge_memories[0]).not.toHaveProperty('definition_missing')
    // Restoring the file un-orphans: the normal mount comes back, marks gone.
    writeShopDim(root)
    const restored = core.readDefinitionMemories('table:dim_shop')
    expect(restored.memories.map(r => r.id)).toEqual([onNode])
    expect(restored.memories[0]).not.toHaveProperty('definition_missing')
    expect(restored.edge_memories[0]).not.toHaveProperty('relation_missing')
  })
})

// ── Counts agree with the mount; the empty-layer zero-tax arm ──────────────

describe('memoryCountsByNode + the zero-tax arm', () => {
  it('counts match the no-window mount per type, and metric nodes take exact anchors only', async () => {
    fullCorpus(root)
    writeFileSync(join(root, 'tables', 'dws_acc.yaml'), dumpYaml(fixtureTable({
      table_name: 'dws_acc',
      kind: 'dws',
      columns: [
        { name: 'ch_id', type: 'string', comment: '', role: 'dimension' },
        { name: 'pay_amt', type: 'decimal', comment: '', role: 'measure' },
      ],
      metrics: { gmv: { expression: 'sum(pay_amt)', description: '', alt_labels: [], caliber_variants: [] } },
      dimension_refs: [{ dim_table: 'dim_shop', derivation: '', join_keys: [{ dws_column: 'ch_id', dim_column: 'shop_id' }] }],
      domains: ['payment'],
    })), 'utf8')
    const core = newMemoryCore(root)
    await recordOne(core, { type: 'inference', anchors: ['dws_acc#ch_id'], body: '黑话', basis: '列注释' })
    await recordOne(core, { type: 'practice', anchors: ['dws_acc'], body: '口径', basis: 'b' })
    await recordOne(core, { type: 'caveat', anchors: ['table:dws_acc -joins-> table:dim_shop'], body: 'join 坑' })
    await recordOne(core, { type: 'practice', anchors: ['metric:dws_acc__gmv'], body: '指标口径', basis: 'b' })
    // Node site counts (the edge entry is a different list, R6's click-through).
    expect(core.memoryCountsByNode(['table:dws_acc']).get('table:dws_acc')).toEqual({ inference: 1, practice: 1 })
    // The metric node counts only its exact anchors — no host bleed (R1).
    expect(core.memoryCountsByNode(['metric:dws_acc__gmv']).get('metric:dws_acc__gmv')).toEqual({ practice: 1 })
    const metricView = core.readDefinitionMemories('metric:dws_acc__gmv')
    expect(metricView.memories).toHaveLength(1)
    expect(metricView.edge_memories).toEqual([])
  })

  it('an empty memory layer yields empty views everywhere (the substrate zero-tax arm)', async () => {
    fullCorpus(root)
    const core = newMemoryCore(root)
    expect(core.readDefinitionMemories('table:dws_acc')).toEqual({ memories: [], edge_memories: [] })
    expect(core.readOrphanedMemories('table:nope')).toEqual({ orphaned_memories: [] })
    expect(core.memoryCountsByNode(['table:dws_acc']).size).toBe(0)
    expect(core.readEdgeMemories([{ a: 'table:dws_acc', b: 'table:dim_shop', type: 'joins' }])).toEqual([{ entries: [] }])
  })
})

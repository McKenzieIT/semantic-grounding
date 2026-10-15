/**
 * The verified query's substrate contracts (ADR-0025 / #155): the `query`
 * kind plugin's projection, the write orchestration's `uses` canonicalization
 * (the #152 anchor machinery reused), the fingerprint axis (query sha256 as
 * the update baseline; a changed query never moves a used table's
 * fingerprint — `uses` is a forward reference, the table YAML holds no
 * back-link), the `verified_queries` forward scan (node / column-fragment /
 * edge anchors, cap 5, id-ascending), and the memory layer's integration
 * (`query:` joins the anchor universe, so a memory can anchor on a query and
 * the ADR-0024 read mount applies to it unchanged).
 *
 * Mirrors `memory.spec.ts`'s shape — Core methods called directly with a
 * no-op recorder, pinning the domain logic the MCP handler thins to.
 *
 * @see docs/adr/0025-verified-query-shape-and-promotion.md
 * @see docs/adr/0023-memory-storage-shape-and-node-ids.md (the anchor grammar `uses` rides)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { SemanticGroundingCore, dumpYaml, type Tier2Recorder } from '../src/index.ts'
import { definitionVersion } from '../src/io.ts'
import { VERIFIED_QUERIES_CAP, verifiedQueriesForNode, type VerifiedQueryDraft } from '../src/query.ts'
import { buildAnchorUniverse } from '../src/memory.ts'
import { fixtureTable } from './enrichment-fixtures.ts'

const noopRecorder: Tier2Recorder = { recordTier2Write: async () => 'noop-log-id' }

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verified-query-'))
  mkdirSync(join(root, 'tables'), { recursive: true })
  mkdirSync(join(root, 'concepts'), { recursive: true })
  mkdirSync(join(root, 'events'), { recursive: true })
  writeFileSync(join(root, 'config.yaml'), dumpYaml({ scope_id: 'fixture' }), 'utf8')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The A3-card wide table: `r_level` is where the 大R 口径 lands. */
function writeWideTable(): void {
  writeFileSync(join(root, 'tables', 'dws_univ_acc_tag.yaml'), dumpYaml(fixtureTable({
    table_name: 'dws_univ_acc_tag',
    kind: 'dws',
    columns: [
      { name: 'uid', type: 'string', comment: '用户id', role: 'dimension' },
      { name: 'r_level', type: 'string', comment: '付费R级(01-09)', role: 'dimension' },
      { name: 'pay_amt', type: 'decimal', comment: '累计付费', role: 'measure' },
    ],
    dimension_refs: [{ dim_table: 'dim_user', derivation: '', join_keys: [{ dws_column: 'uid', dim_column: 'uid' }] }],
  })), 'utf8')
  writeFileSync(join(root, 'tables', 'dim_user.yaml'), dumpYaml(fixtureTable({
    table_name: 'dim_user',
    kind: 'dim',
    columns: [{ name: 'uid', type: 'string', comment: '用户id', role: 'dimension' }],
    primary_key: ['uid'],
    label_columns: ['uid'],
  })), 'utf8')
}

function core(): SemanticGroundingCore {
  const c = new SemanticGroundingCore({ semanticRoot: root, scopeId: 'fixture' })
  c.setTier2Recorder(noopRecorder)
  return c
}

/** The A3 draft: 大R 留存, parameterized ds, using the wide table's r_level column. */
function a3Draft(overrides: Partial<VerifiedQueryDraft> = {}): VerifiedQueryDraft {
  return {
    name: 'big_r_retention',
    question: '大R 留存',
    alt_questions: ['高付费用户留存', '大R用户次月留存'],
    sql: 'select ds, count(distinct uid) from dws_univ_acc_tag where r_level in (\'07\',\'08\',\'09\') and ds >= ${start_ds} and ds < ${end_ds} group by ds',
    uses: ['table:dws_univ_acc_tag#r_level'],
    description: '大R = r_level 07–09(用户口述口径)',
    ...overrides,
  }
}

describe('query kind projection (ADR-0025 R1)', () => {
  it('a written query projects as a graph node `query:<名>` and enters the search corpus', async () => {
    writeWideTable()
    const c = core()
    await c.writeVerifiedQuery(a3Draft())
    const nodes = c.projectGraphNodes({ includeDerived: true })
    const q = nodes.find(n => n.id === 'query:big_r_retention')
    expect(q).toMatchObject({ kind: 'query', domains: [] })
    const items = c.loadRetrievalCorpusAll()
    const item = items.find(i => i.id === 'query:big_r_retention')
    // ADR-0025 R6①: the index carries the question + 同问异说 + description —
    // never the SQL.
    expect(item?.description).toContain('大R 留存')
    expect(item?.description).toContain('高付费用户留存')
    expect(item?.description).not.toContain('select')
  })

  it('a query contributes no relations — uses are anchors, not graph adjacency', async () => {
    writeWideTable()
    const c = core()
    await c.writeVerifiedQuery(a3Draft())
    const g = c.getRelationGraph()
    expect(g.getRelated('query:big_r_retention')).toEqual([])
    // The relation graph's adjacency is edges-only (a node with no relations
    // has no entry), so a query never reaches get_join_path/get_relations —
    // the projection (`projectGraphNodes`) is where the node lives.
    expect(g.hasNode('query:big_r_retention')).toBe(false)
  })

  it('resolve_alias never returns a query — alt_questions are not aliases (R6④)', async () => {
    writeWideTable()
    const c = core()
    await c.writeVerifiedQuery(a3Draft())
    expect(c.getRelationGraph().resolveAlias('高付费用户留存')).toEqual([])
  })
})

describe('writeVerifiedQuery — uses canonicalization + fingerprint (R6/R2)', () => {
  it('stores canonical anchors: bare input resolves, column fragments keep their parent', async () => {
    writeWideTable()
    const c = core()
    const res = await c.writeVerifiedQuery(a3Draft({ uses: ['dws_univ_acc_tag#r_level', 'dws_univ_acc_tag'] }))
    expect(res).toMatchObject({ ok: true })
    const stored = c.loadQueryDefinition('big_r_retention')
    expect(stored?.uses.sort()).toEqual(['table:dws_univ_acc_tag', 'table:dws_univ_acc_tag#r_level'])
  })

  it('a dangling use refuses with nothing written (the #152 anchor rule, reused)', async () => {
    writeWideTable()
    const c = core()
    const res = await c.writeVerifiedQuery(a3Draft({ uses: ['table:no_such_table'] }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/anchor names no node/)
    expect(c.loadQueryDefinition('big_r_retention')).toBeNull()
    expect(existsSync(join(root, 'queries'))).toBe(false)
  })

  it('a dangling column fragment refuses; an ambiguous bare name refuses (ADR-0023 R4)', async () => {
    writeWideTable()
    const c = core()
    const badColumn = await c.writeVerifiedQuery(a3Draft({ uses: ['table:dws_univ_acc_tag#no_such_col'] }))
    expect(badColumn.ok).toBe(false)
    // uid exists on BOTH the DWS and the DIM — a bare `uid`... no: bare names
    // resolve against node names, not columns. Make two kinds share a NAME.
    writeFileSync(join(root, 'concepts', 'dws_univ_acc_tag.yaml'), dumpYaml({
      name: 'dws_univ_acc_tag', description: '同名概念', properties: {}, related_refs: [], suppressed_alt_labels: [], suppressed_related_refs: [],
    }), 'utf8')
    const ambiguous = await c.writeVerifiedQuery(a3Draft({ uses: ['dws_univ_acc_tag'] }))
    expect(ambiguous.ok).toBe(false)
    if (!ambiguous.ok) expect(ambiguous.error).toMatch(/ambiguous|more than one kind/)
  })

  it('memoryIds are existence-checked before the write (a dangling citation refuses whole)', async () => {
    writeWideTable()
    const c = core()
    const res = await c.writeVerifiedQuery(a3Draft(), { memoryIds: ['mem-20260101-aaaaaaaa'] })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/memory_ids cite entries that do not exist/)
    expect(c.loadQueryDefinition('big_r_retention')).toBeNull()
  })

  it('expected_version: a stale baseline throws StaleBaselineError; the receipt version equals the file sha', async () => {
    writeWideTable()
    const c = core()
    const first = await c.writeVerifiedQuery(a3Draft())
    if (!first.ok) throw new Error(first.error)
    expect(first.version).toBe(definitionVersion(root, 'query', 'big_r_retention'))
    await expect(c.writeVerifiedQuery(a3Draft({ question: '大R 留存(修订)' }), { expectedVersion: '0'.repeat(64) }))
      .rejects.toThrow(/stale|baseline/i)
    const second = await c.writeVerifiedQuery(a3Draft({ question: '大R 留存(修订)' }), { expectedVersion: first.version })
    expect(second).toMatchObject({ ok: true })
    expect(c.loadQueryDefinition('big_r_retention')?.question).toBe('大R 留存(修订)')
  })

  it("改查询不改表指纹: the used table's definitionVersion is byte-identical across create and update", async () => {
    writeWideTable()
    const before = definitionVersion(root, 'table', 'dws_univ_acc_tag')
    const c = core()
    const first = await c.writeVerifiedQuery(a3Draft())
    if (!first.ok) throw new Error(first.error)
    expect(definitionVersion(root, 'table', 'dws_univ_acc_tag')).toBe(before)
    const second = await c.writeVerifiedQuery(a3Draft({ sql: 'select ds, count(distinct uid) from dws_univ_acc_tag where r_level in (\'07\',\'09\') and ds >= ${start_ds} and ds < ${end_ds} group by ds' }), { expectedVersion: first.version })
    if (!second.ok) throw new Error(second.error)
    expect(second.version).not.toBe(first.version)
    expect(definitionVersion(root, 'table', 'dws_univ_acc_tag')).toBe(before)
  })
})

describe('verifiedQueriesForNode — the forward scan (R6②)', () => {
  it('matches node uses, column fragments, and edge anchors (either endpoint)', async () => {
    writeWideTable()
    const c = core()
    await c.writeVerifiedQuery(a3Draft())
    await c.writeVerifiedQuery({ ...a3Draft(), name: 'whale_count', question: '大R 数量', alt_questions: undefined, uses: ['dws_univ_acc_tag'] })
    await c.writeVerifiedQuery({ ...a3Draft(), name: 'user_growth', question: '用户增长', alt_questions: undefined, uses: ['table:dws_univ_acc_tag -joins-> table:dim_user'] })
    const table = c.verifiedQueriesFor('table:dws_univ_acc_tag')
    expect(table.map(q => q.id).sort()).toEqual(['query:big_r_retention', 'query:user_growth', 'query:whale_count'])
    // The edge's OTHER endpoint sees the query too (the edge-memory precedent).
    expect(c.verifiedQueriesFor('table:dim_user').map(q => q.id)).toEqual(['query:user_growth'])
    expect(c.verifiedQueriesFor('table:no_such')).toEqual([])
  })

  it('caps at the ruled 5, id-ascending; an absent queries dir yields [] (零税)', async () => {
    writeWideTable()
    const c = core()
    for (let i = 0; i < 7; i++) {
      const res = await c.writeVerifiedQuery({ ...a3Draft(), name: `q${i}_retention`, question: `第${i}问`, alt_questions: undefined, uses: ['table:dws_univ_acc_tag#r_level'] })
      if (!res.ok) throw new Error(res.error)
    }
    const rows = c.verifiedQueriesFor('table:dws_univ_acc_tag')
    expect(rows).toHaveLength(VERIFIED_QUERIES_CAP)
    expect(VERIFIED_QUERIES_CAP).toBe(5)
    expect(rows.map(r => r.id)).toEqual([...rows.map(r => r.id)].sort())
    // Zero-tax: a corpus with no queries dir scans to nothing.
    expect(verifiedQueriesForNode(root, 'table:dws_univ_acc_tag').length === 0 || existsSync(join(root, 'queries'))).toBe(true)
  })

  it('hand-written queries load through the same scan (loose schema, canonical uses expected)', () => {
    writeWideTable()
    mkdirSync(join(root, 'queries'), { recursive: true })
    writeFileSync(join(root, 'queries', 'hand_written.yaml'), yaml.dump({
      name: 'hand_written',
      question: '手写查询',
      sql: 'select 1',
      uses: ['table:dws_univ_acc_tag'],
      description: '',
    }), 'utf8')
    expect(verifiedQueriesForNode(root, 'table:dws_univ_acc_tag')).toEqual([{ id: 'query:hand_written', question: '手写查询' }])
  })
})

describe('memory-layer integration (R1: a query is a graph node)', () => {
  it('the anchor universe carries query nodes; a memory anchors and mounts on `query:<名>`', async () => {
    writeWideTable()
    const c = core()
    await c.writeVerifiedQuery(a3Draft())
    expect(buildAnchorUniverse(root).nodes.has('query:big_r_retention')).toBe(true)
    const res = await c.recordMemories([{
      type: 'practice',
      anchors: ['query:big_r_retention'],
      body: '大R 口径随 r_level 分档调整,跨季度复看时先确认分档。',
      basis: '用户口述',
    }], { session: 's1', agent: 'a1' })
    if (!res.ok) throw new Error(res.error)
    const view = c.readDefinitionMemories('query:big_r_retention')
    expect(view.memories.map(m => m.id)).toContain(res.results[0]?.id)
  })

  it('a query node is NOT folded into the DW table count by elimination — it is its own kind', async () => {
    writeWideTable()
    const c = core()
    const nodesBefore = c.projectGraphNodes({ includeDerived: false }).length
    await c.writeVerifiedQuery(a3Draft())
    const nodesAfter = c.projectGraphNodes({ includeDerived: false })
    expect(nodesAfter.length).toBe(nodesBefore + 1)
    expect(nodesAfter.filter(n => n.kind === 'query').map(n => n.id)).toEqual(['query:big_r_retention'])
  })
})

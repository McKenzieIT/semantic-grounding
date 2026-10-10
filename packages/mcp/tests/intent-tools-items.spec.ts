/**
 * ADR-0005's four item-level write tools — behaviour: `add_alias`, `remove_alias`,
 * `add_relation`, `remove_relation`. All four are read-modify-write-single-item
 * (ruling 3): this file's idempotency assertions are the "no whole-array replace"
 * claim made observable.
 *
 * #38 / ADR-0010 reshape: `remove_*` take arrays (`labels` / `relations`, #37 §3
 * — same-target batch, one locked write, per-item verdicts) and every removal
 * carries the suppression side (dual-field overlay): removing machine-derivable
 * content IS the veto; `add_*` re-adding is the lift (#37 §1/§5).
 *
 * @see docs/adr/0005-mcp-tool-surface.md + docs/adr/0010-suppression.md
 */
import { afterEach, describe, expect, it } from 'vitest'
import { buildIntentToolHarness, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
import { toolJson } from './helpers/inprocess-client.ts'

let h: IntentToolHarness | undefined
afterEach(() => h?.close())

async function version(name: string): Promise<string> {
  if (h === undefined) throw new Error('harness not built')
  return (toolJson(await h.client.callTool('get_definition', { kind: 'table', name })) as { version: string }).version
}

/** One per-item verdict row as `remove_*` receipts return them (#37 §2). */
interface ItemVerdict {
  readonly key: string
  readonly outcome: 'removed' | 'absent' | 'idempotent'
  readonly suppressed: boolean
  readonly reasserted: boolean
}

describe('add_alias / remove_alias', () => {
  it('appends a new alias', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('add_alias', {
      kind: 'table', name: 'dws_order', alias: '订单宽表',
      summary: '添加别名「订单宽表」', derivation: 'agent', confidence: 0.9,
      expected_version: await version('dws_order'),
    })
    expect((toolJson(res) as { changed: boolean }).changed).toBe(true)
    expect(h.core.loadTableDefinition('dws_order')?.alt_labels).toContain('订单宽表')
  })

  it('is a no-op (changed:false, no new commit) when the alias is already present', async () => {
    h = await buildIntentToolHarness()
    const first = await h.client.callTool('add_alias', {
      kind: 'table', name: 'dws_order', alias: '订单宽表',
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const firstCommit = (toolJson(first) as { commit: string }).commit

    const second = await h.client.callTool('add_alias', {
      kind: 'table', name: 'dws_order', alias: '订单宽表',
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const secondBody = toolJson(second) as { commit: string; changed: boolean }
    expect(secondBody.changed).toBe(false)
    expect(secondBody.commit).toBe(firstCommit)
  })

  it('removes an existing alias AND records the veto — the key lands in suppressed_alt_labels', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('add_alias', {
      kind: 'table', name: 'dws_order', alias: '临时别名',
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const res = await h.client.callTool('remove_alias', {
      kind: 'table', name: 'dws_order', labels: ['临时别名'],
      summary: '移除别名', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const body = toolJson(res) as { changed: boolean; results: ItemVerdict[] }
    expect(body.changed).toBe(true)
    expect(body.results).toEqual([{ key: '临时别名', outcome: 'removed', suppressed: true, reasserted: false }])
    const def = h.core.loadTableDefinition('dws_order')
    expect(def?.alt_labels).not.toContain('临时别名')
    expect(def?.suppressed_alt_labels).toContain('临时别名')
  })

  it('removing an absent alias is a veto write (ensure-absent), not a no-op; the repeat is the true no-op', async () => {
    h = await buildIntentToolHarness()
    const v1 = await version('dws_order')
    const first = toolJson(await h.client.callTool('remove_alias', {
      kind: 'table', name: 'dws_order', labels: ['从未添加过'],
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: v1,
    })) as { changed: boolean; results: ItemVerdict[] }
    expect(first.changed).toBe(true)
    expect(first.results).toEqual([{ key: '从未添加过', outcome: 'absent', suppressed: true, reasserted: false }])
    expect(h.core.loadTableDefinition('dws_order')?.suppressed_alt_labels).toContain('从未添加过')

    const second = toolJson(await h.client.callTool('remove_alias', {
      kind: 'table', name: 'dws_order', labels: ['从未添加过'],
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })) as { changed: boolean; results: ItemVerdict[] }
    expect(second.changed).toBe(false)
    expect(second.results).toEqual([{ key: '从未添加过', outcome: 'idempotent', suppressed: false, reasserted: false }])
  })

  it('matching and veto keys are the normalized form: adding DAU, removing dau, removes it', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('add_alias', {
      kind: 'table', name: 'dws_order', alias: 'DAU',
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const res = await h.client.callTool('remove_alias', {
      kind: 'table', name: 'dws_order', labels: ['dau'],
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const body = toolJson(res) as { results: ItemVerdict[] }
    expect(body.results).toEqual([{ key: 'dau', outcome: 'removed', suppressed: true, reasserted: false }])
    expect(h.core.loadTableDefinition('dws_order')?.alt_labels).not.toContain('DAU')
  })

  it('same-target batch: one locked write, one commit, per-item verdicts (removed + absent in one call)', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('add_alias', {
      kind: 'table', name: 'dws_order', alias: '别名甲',
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const before = toolJson(await h.client.callTool('get_definition', { kind: 'table', name: 'dws_order' })) as { version: string }
    const res = await h.client.callTool('remove_alias', {
      kind: 'table', name: 'dws_order', labels: ['别名甲', '不在场的乙'],
      summary: '批量清理别名', derivation: 'agent', confidence: 0.9, expected_version: before.version,
    })
    const body = toolJson(res) as { changed: boolean; results: ItemVerdict[] }
    expect(body.changed).toBe(true)
    expect(body.results).toEqual([
      { key: '别名甲', outcome: 'removed', suppressed: true, reasserted: false },
      { key: '不在场的乙', outcome: 'absent', suppressed: true, reasserted: false },
    ])
    const def = h.core.loadTableDefinition('dws_order')
    expect(def?.alt_labels).not.toContain('别名甲')
    expect(def?.suppressed_alt_labels).toEqual(expect.arrayContaining(['别名甲', '不在场的乙']))
  })

  it('add back lifts the veto: unsuppressed reports the lifted key, the veto key leaves the YAML', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('remove_alias', {
      kind: 'table', name: 'dws_order', labels: ['订单宽表'],
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    expect(h.core.loadTableDefinition('dws_order')?.suppressed_alt_labels).toContain('订单宽表')

    const res = await h.client.callTool('add_alias', {
      kind: 'table', name: 'dws_order', alias: '订单宽表',
      summary: '加回（撤销否决）', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const body = toolJson(res) as { changed: boolean; unsuppressed?: string[] }
    expect(body.changed).toBe(true)
    expect(body.unsuppressed).toEqual(['订单宽表'])
    const def = h.core.loadTableDefinition('dws_order')
    expect(def?.alt_labels).toContain('订单宽表')
    expect(def?.suppressed_alt_labels).not.toContain('订单宽表')
  })

  it('a removed alias no longer resolves (retrieval hygiene: the veto is not an index)', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('add_alias', {
      kind: 'table', name: 'dws_order', alias: '订单宽表',
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    expect(((toolJson(await h.client.callTool('resolve_alias', { term: '订单宽表' })) as { node_ids: string[] }).node_ids)).toContain('dws_order')
    await h.client.callTool('remove_alias', {
      kind: 'table', name: 'dws_order', labels: ['订单宽表'],
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const resolved = toolJson(await h.client.callTool('resolve_alias', { term: '订单宽表' })) as { node_ids: string[] }
    expect(resolved.node_ids).toEqual([])
  })

  it('errors with definition_not_found for a table that does not exist', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('add_alias', {
      kind: 'table', name: 'nope', alias: 'x',
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: 'f'.repeat(64),
    })
    expect(res.result?.['isError']).toBe(true)
    expect(toolJson(res)['code']).toBe(-31021)
  })

  it('two aliases added back-to-back both survive (read-modify-write, never a whole-array replace from stale state)', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('add_alias', {
      kind: 'table', name: 'dws_order', alias: '别名一',
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    await h.client.callTool('add_alias', {
      kind: 'table', name: 'dws_order', alias: '别名二',
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const labels = h.core.loadTableDefinition('dws_order')?.alt_labels ?? []
    expect(labels).toContain('别名一')
    expect(labels).toContain('别名二')
  })

  it('events are covered day one: remove_alias on an event lands suppressed_alt_labels (map #27 fixture-blindspot lesson)', async () => {
    h = await buildIntentToolHarness({ fixtureOpts: { withEvents: true } })
    const v = (toolJson(await h.client.callTool('get_definition', { kind: 'event', name: 'pay_success' })) as { version: string }).version
    const res = await h.client.callTool('remove_alias', {
      kind: 'event', name: 'pay_success', labels: ['支付成功'],
      summary: '预否决事件别名', derivation: 'agent', confidence: 0.9, expected_version: v,
    })
    const body = toolJson(res) as { changed: boolean; results: ItemVerdict[] }
    expect(body.changed).toBe(true)
    expect(body.results[0]).toMatchObject({ key: '支付成功', outcome: 'absent', suppressed: true })
    expect(h.core.loadEventDefinition('pay_success')?.suppressed_alt_labels).toContain('支付成功')
  })
})

describe('add_relation / remove_relation', () => {
  it('appends a relation with no origin and no derivation field on the stored entry', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('add_relation', {
      kind: 'table', name: 'dws_order',
      relation: { dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] },
      summary: '补充店铺维度关联', derivation: 'agent', confidence: 0.85,
      expected_version: await version('dws_order'),
    })
    expect((toolJson(res) as { changed: boolean }).changed).toBe(true)
    const ref = h.core.loadTableDefinition('dws_order')?.dimension_refs.find(r => r.dim_table === 'dim_shop')
    expect(ref).toBeDefined()
    expect(ref).not.toHaveProperty('origin')
  })

  it('refuses when dim_table has no table definition of its own', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('add_relation', {
      kind: 'table', name: 'dws_order',
      relation: { dim_table: 'dim_does_not_exist', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] },
      summary: 'x', derivation: 'agent', confidence: 0.9,
      expected_version: await version('dws_order'),
    })
    expect(res.result?.['isError']).toBe(true)
    const body = toolJson(res)
    expect(body['code']).toBe(-31021)
    expect(body['name']).toBe('DefinitionNotFoundError')
  })

  it('is a no-op when the exact same relation already exists', async () => {
    h = await buildIntentToolHarness()
    const relation = { dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }
    const first = await h.client.callTool('add_relation', {
      kind: 'table', name: 'dws_order', relation,
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const firstCommit = (toolJson(first) as { commit: string }).commit
    const second = await h.client.callTool('add_relation', {
      kind: 'table', name: 'dws_order', relation,
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const secondBody = toolJson(second) as { changed: boolean; commit: string }
    expect(secondBody.changed).toBe(false)
    expect(secondBody.commit).toBe(firstCommit)
  })

  it('a different join_keys on the same dim_table is a distinct relation, not a duplicate', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('add_relation', {
      kind: 'table', name: 'dws_order',
      relation: { dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] },
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    await h.client.callTool('add_relation', {
      kind: 'table', name: 'dws_order',
      relation: { dim_table: 'dim_shop', join_keys: [{ dws_column: 'pay_amt', dim_column: 'shop_id' }] },
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const refs = h.core.loadTableDefinition('dws_order')?.dimension_refs.filter(r => r.dim_table === 'dim_shop') ?? []
    expect(refs).toHaveLength(2)
  })

  it('removes an exactly-matching relation (curated: no veto, suppressed:false)', async () => {
    h = await buildIntentToolHarness()
    const relation = { dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }
    await h.client.callTool('add_relation', {
      kind: 'table', name: 'dws_order', relation,
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const res = await h.client.callTool('remove_relation', {
      kind: 'table', name: 'dws_order', relations: [relation],
      summary: '撤回关联', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const body = toolJson(res) as { changed: boolean; results: ItemVerdict[] }
    expect(body.changed).toBe(true)
    // agent-asserted refs are curated (origin omitted, ADR-0005 ruling 9): a pure
    // content correction, no veto recorded (#37 §1's origin routing).
    expect(body.results).toEqual([{ key: 'dim_shop', outcome: 'removed', suppressed: false, reasserted: false }])
    const def = h.core.loadTableDefinition('dws_order')
    expect(def?.dimension_refs.find(r => r.dim_table === 'dim_shop')).toBeUndefined()
    expect(def?.suppressed_dimension_refs).toEqual([])
  })

  it('removing a non-matching (absent) relation records the veto (ensure-absent)', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('remove_relation', {
      kind: 'table', name: 'dws_order',
      relations: [{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const body = toolJson(res) as { changed: boolean; results: ItemVerdict[] }
    expect(body.changed).toBe(true)
    expect(body.results).toEqual([{ key: 'dim_shop', outcome: 'absent', suppressed: true, reasserted: false }])
    expect(h.core.loadTableDefinition('dws_order')?.suppressed_dimension_refs).toContain('dim_shop')
  })

  // FLIPPED in #38 (was the write-delete loop's regression guard, ADR-0005
  // Consequences): removal now records the veto, the same-call on-write hook's
  // discovered set is filtered, and the ref stays deleted. ADR-0010 supersedes
  // the "no tombstone in v1" note via ADR-0005's Update section.
  it('removing a machine-derived (deterministic) ref persists — the veto blocks the same call\'s on-write hook', async () => {
    h = await buildIntentToolHarness({ autoEnrich: true })
    // Trigger the deterministic round: dim_shop's PK (shop_id) matches dws_order's own column.
    await h.client.callTool('update_definition', {
      kind: 'table', name: 'dws_order', fields: { description: 'trigger enrichment' },
      summary: 'trigger', derivation: 'agent', confidence: 0.5, expected_version: await version('dws_order'),
    })
    expect(h.core.loadTableDefinition('dws_order')?.dimension_refs.find(r => r.dim_table === 'dim_shop')?.origin).toBe('deterministic')

    const res = await h.client.callTool('remove_relation', {
      kind: 'table', name: 'dws_order',
      relations: [{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
      summary: '移除自动推导的关联', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const body = toolJson(res) as { changed: boolean; results: ItemVerdict[] }
    expect(body.results).toEqual([{ key: 'dim_shop', outcome: 'removed', suppressed: true, reasserted: false }])
    // 未回灌：the ref the hook would have re-derived in this same locked call stays gone.
    const def = h.core.loadTableDefinition('dws_order')
    expect(def?.dimension_refs.find(r => r.dim_table === 'dim_shop')).toBeUndefined()
    expect(def?.suppressed_dimension_refs).toContain('dim_shop')
  })

  it('the curated two-step dance: first removal of a curated-but-derivable ref is reasserted by the hook; the second removal vetoes it for good', async () => {
    h = await buildIntentToolHarness({ autoEnrich: true })
    // A curated ref (origin omitted) whose join the deterministic round CAN re-derive.
    const relation = { dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }
    await h.client.callTool('add_relation', {
      kind: 'table', name: 'dws_order', relation,
      summary: '人工补充关联', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    // Step 1: remove the curated ref — no veto (origin routing), so the same call's
    // on-write hook re-derives it with origin deterministic. The receipt says so.
    const first = toolJson(await h.client.callTool('remove_relation', {
      kind: 'table', name: 'dws_order', relations: [relation],
      summary: '撤回', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })) as { results: ItemVerdict[] }
    expect(first.results).toEqual([{ key: 'dim_shop', outcome: 'removed', suppressed: false, reasserted: true }])
    expect(h.core.loadTableDefinition('dws_order')?.dimension_refs.find(r => r.dim_table === 'dim_shop')?.origin).toBe('deterministic')

    // Step 2: remove again — the ref is now machine-derived, the removal vetoes it,
    // and the hook's discovery is filtered. Gone for good, discoverably.
    const second = toolJson(await h.client.callTool('remove_relation', {
      kind: 'table', name: 'dws_order', relations: [relation],
      summary: '再撤回（落否决）', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })) as { changed: boolean; results: ItemVerdict[] }
    expect(second.results).toEqual([{ key: 'dim_shop', outcome: 'removed', suppressed: true, reasserted: false }])
    const def = h.core.loadTableDefinition('dws_order')
    expect(def?.dimension_refs.find(r => r.dim_table === 'dim_shop')).toBeUndefined()
    expect(def?.suppressed_dimension_refs).toContain('dim_shop')
  })

  it('add_relation re-asserting a vetoed dim_table lifts the veto (unsuppressed)', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('remove_relation', {
      kind: 'table', name: 'dws_order',
      relations: [{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    expect(h.core.loadTableDefinition('dws_order')?.suppressed_dimension_refs).toContain('dim_shop')

    const res = await h.client.callTool('add_relation', {
      kind: 'table', name: 'dws_order',
      relation: { dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] },
      summary: '加回（撤销否决）', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const body = toolJson(res) as { changed: boolean; unsuppressed?: string[] }
    expect(body.changed).toBe(true)
    expect(body.unsuppressed).toEqual(['dim_shop'])
    const def = h.core.loadTableDefinition('dws_order')
    expect(def?.dimension_refs.find(r => r.dim_table === 'dim_shop')).toBeDefined()
    expect(def?.suppressed_dimension_refs).toEqual([])
  })
})

describe('update_definition rejects the suppression key fields', () => {
  it('rejects suppressed_alt_labels with the coded redirect to the item-level tools (-31020)', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('update_definition', {
      kind: 'table', name: 'dws_order',
      fields: { suppressed_alt_labels: ['x'] },
      summary: 'should be rejected', derivation: 'agent', confidence: 0.9,
      expected_version: await version('dws_order'),
    })
    expect(res.result?.['isError']).toBe(true)
    const body = toolJson(res)
    expect(body['code']).toBe(-31020)
    expect(body['name']).toBe('UnsupportedUpdateFieldError')
    const data = body['data'] as { use_instead?: string }
    expect(data.use_instead).toContain('remove_alias')
  })

  it('rejects suppressed_dimension_refs / suppressed_external_refs the same way', async () => {
    h = await buildIntentToolHarness()
    const table = await h.client.callTool('update_definition', {
      kind: 'table', name: 'dws_order',
      fields: { suppressed_dimension_refs: ['dim_x'] },
      summary: 'should be rejected', derivation: 'agent', confidence: 0.9,
      expected_version: await version('dws_order'),
    })
    expect(toolJson(table)['code']).toBe(-31020)
    expect((toolJson(table)['data'] as { use_instead?: string }).use_instead).toContain('remove_relation')

    h = await buildIntentToolHarness({ fixtureOpts: { withEvents: true } })
    const event = await h.client.callTool('update_definition', {
      kind: 'event', name: 'pay_success',
      fields: { suppressed_external_refs: ['dim_x'] },
      summary: 'should be rejected', derivation: 'agent', confidence: 0.9,
      expected_version: (toolJson(await h.client.callTool('get_definition', { kind: 'event', name: 'pay_success' })) as { version: string }).version,
    })
    expect(toolJson(event)['code']).toBe(-31020)
    expect((toolJson(event)['data'] as { use_instead?: string }).use_instead).toContain('remove_relation')
  })
})

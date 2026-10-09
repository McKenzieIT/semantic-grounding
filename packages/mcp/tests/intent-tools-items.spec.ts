/**
 * ADR-0005's four item-level write tools — behaviour: `add_alias`, `remove_alias`,
 * `add_relation`, `remove_relation`. All four are read-modify-write-single-item
 * (ruling 3): this file's idempotency assertions are the "no whole-array replace"
 * claim made observable.
 *
 * @see docs/adr/0005-mcp-tool-surface.md
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

  it('removes an existing alias', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('add_alias', {
      kind: 'table', name: 'dws_order', alias: '临时别名',
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const res = await h.client.callTool('remove_alias', {
      kind: 'table', name: 'dws_order', alias: '临时别名',
      summary: '移除别名', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    expect((toolJson(res) as { changed: boolean }).changed).toBe(true)
    expect(h.core.loadTableDefinition('dws_order')?.alt_labels).not.toContain('临时别名')
  })

  it('removing an absent alias is a no-op (changed:false)', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('remove_alias', {
      kind: 'table', name: 'dws_order', alias: '从未添加过',
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    expect((toolJson(res) as { changed: boolean }).changed).toBe(false)
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

  it('removes an exactly-matching relation', async () => {
    h = await buildIntentToolHarness()
    const relation = { dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }
    await h.client.callTool('add_relation', {
      kind: 'table', name: 'dws_order', relation,
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const res = await h.client.callTool('remove_relation', {
      kind: 'table', name: 'dws_order', relation,
      summary: '撤回关联', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    expect((toolJson(res) as { changed: boolean }).changed).toBe(true)
    expect(h.core.loadTableDefinition('dws_order')?.dimension_refs.find(r => r.dim_table === 'dim_shop')).toBeUndefined()
  })

  it('removing a non-matching relation is a no-op (changed:false)', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('remove_relation', {
      kind: 'table', name: 'dws_order',
      relation: { dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] },
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    expect((toolJson(res) as { changed: boolean }).changed).toBe(false)
  })

  it('removing a machine-derived (deterministic) ref does not persist — the write\'s own on-write hook re-derives it (ADR-0005 Consequences — no tombstone in v1)', async () => {
    h = await buildIntentToolHarness({ autoEnrich: true })
    // Trigger the deterministic round: dim_shop's PK (shop_id) matches dws_order's own column.
    await h.client.callTool('update_definition', {
      kind: 'table', name: 'dws_order', fields: { description: 'trigger enrichment' },
      summary: 'trigger', derivation: 'agent', confidence: 0.5, expected_version: await version('dws_order'),
    })
    expect(h.core.loadTableDefinition('dws_order')?.dimension_refs.find(r => r.dim_table === 'dim_shop')?.origin).toBe('deterministic')

    await h.client.callTool('remove_relation', {
      kind: 'table', name: 'dws_order',
      relation: { dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] },
      summary: '移除自动推导的关联', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    // Measured, not merely documented: `core.updateTableMeta`'s own on-write hook
    // (autoEnrich, triggered by this same remove_relation call) re-derives the ref
    // immediately — "下一轮 enrichment 会重新推导回来" (ADR-0005 Consequences) turns
    // out to mean *this* call's own hook, not only some later one. v1 ships no
    // persistent negation/tombstone; the agent-visible effect of this remove_relation
    // call is therefore none, which is the whole point of the ADR's note.
    expect(h.core.loadTableDefinition('dws_order')?.dimension_refs.find(r => r.dim_table === 'dim_shop')?.origin).toBe('deterministic')
  })
})

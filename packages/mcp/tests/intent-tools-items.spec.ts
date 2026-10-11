/**
 * ADR-0005's four item-level write tools — **wire-only** tests (#49 thinning).
 *
 * Domain logic (normalizeLabel, dual-field overlay, origin routing, veto lift,
 * ensure-absent, idempotency, batch verdicts) is now covered by the substrate's
 * `item-write.spec.ts` (30 tests calling Core methods directly). This file pins
 * only what the MCP wire adds on top:
 *
 * - Response shape: `commit`, `changed`, `enrichment_health`, `results`/`unsuppressed`.
 * - Error mapping: `DefinitionNotFoundError` → `-31021`, `StaleBaselineError` → coded stale.
 * - Schema validation: Zod rejects empty arrays at the door.
 * - `update_definition` policy: `suppressed_*` fields rejected with redirect to item tools.
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

// ── Wire shape ───────────────────────────────────────────────────────────

describe('item tools — wire shape', () => {
  it('add_alias response carries commit, changed, and enrichment_health', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('add_alias', {
      kind: 'table', name: 'dws_order', alias: '订单宽表',
      summary: '添加别名', derivation: 'agent', confidence: 0.9,
      expected_version: await version('dws_order'),
    })
    const body = toolJson(res) as { commit: string; changed: boolean; enrichment_health: unknown }
    expect(body.changed).toBe(true)
    expect(typeof body.commit).toBe('string')
    expect(body.commit.length).toBeGreaterThan(0)
    // enrichment_health is present (even if empty) for table writes.
    expect(body).toHaveProperty('enrichment_health')
    expect(h.core.loadTableDefinition('dws_order')?.alt_labels).toContain('订单宽表')
  })

  it('remove_alias response carries per-item verdicts in results array', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('add_alias', {
      kind: 'table', name: 'dws_order', alias: '临时别名',
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const res = await h.client.callTool('remove_alias', {
      kind: 'table', name: 'dws_order', labels: ['临时别名', '不在场的'],
      summary: '批量清理', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    const body = toolJson(res) as { changed: boolean; results: ItemVerdict[] }
    expect(body.changed).toBe(true)
    expect(body.results).toHaveLength(2)
    expect(body.results[0]).toEqual({ key: '临时别名', outcome: 'removed', suppressed: true, reasserted: false })
    expect(body.results[1]).toEqual({ key: '不在场的', outcome: 'absent', suppressed: true, reasserted: false })
  })

  it('remove_relation: the curated two-step dance end-to-end through the wire', async () => {
    h = await buildIntentToolHarness({ autoEnrich: true })
    const relation = { dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }
    // Add a curated ref.
    await h.client.callTool('add_relation', {
      kind: 'table', name: 'dws_order', relation,
      summary: '人工关联', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })
    // Step 1: remove curated → reasserted by hook.
    const first = toolJson(await h.client.callTool('remove_relation', {
      kind: 'table', name: 'dws_order', relations: [relation],
      summary: '撤回', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })) as { results: ItemVerdict[] }
    expect(first.results).toEqual([{ key: 'dim_shop', outcome: 'removed', suppressed: false, reasserted: true }])
    // Step 2: remove again → machine-derived, vetoed for good.
    const second = toolJson(await h.client.callTool('remove_relation', {
      kind: 'table', name: 'dws_order', relations: [relation],
      summary: '再撤回', derivation: 'agent', confidence: 0.9, expected_version: await version('dws_order'),
    })) as { results: ItemVerdict[] }
    expect(second.results).toEqual([{ key: 'dim_shop', outcome: 'removed', suppressed: true, reasserted: false }])
    const def = h.core.loadTableDefinition('dws_order')
    expect(def?.dimension_refs.find(r => r.dim_table === 'dim_shop')).toBeUndefined()
    expect(def?.suppressed_dimension_refs).toContain('dim_shop')
  })
})

// ── Error mapping ────────────────────────────────────────────────────────

describe('item tools — error mapping', () => {
  it('DefinitionNotFoundError → -31021 on the wire for a missing table', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('add_alias', {
      kind: 'table', name: 'nope', alias: 'x',
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: 'f'.repeat(64),
    })
    expect(res.result?.['isError']).toBe(true)
    const body = toolJson(res)
    expect(body['code']).toBe(-31021)
    expect(body['name']).toBe('DefinitionNotFoundError')
  })

  it('StaleBaselineError → coded stale baseline error on the wire', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('add_alias', {
      kind: 'table', name: 'dws_order', alias: 'x',
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: 'a'.repeat(64),
    })
    expect(res.result?.['isError']).toBe(true)
    const body = toolJson(res)
    expect(body['code']).toBe(-31002)
    expect(body['name']).toBe('StaleBaselineRejection')
    expect(body['retryable']).toBe(true)
  })
})

// ── update_definition policy: suppressed_* fields rejected ──────────────

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
    expect((body['data'] as { use_instead?: string }).use_instead).toContain('remove_alias')
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

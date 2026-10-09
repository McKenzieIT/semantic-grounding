/**
 * ADR-0005's two definition-level write tools — behaviour: `create_definition`,
 * `update_definition`. Covers the brief's explicit minimums: idempotent no-op,
 * `enrichment_health` inlined, and the preserve-filter regression (an origin-omitted
 * tool write survives a subsequent `discoverRelations` / `enrichAll*` pass).
 *
 * @see docs/adr/0005-mcp-tool-surface.md
 */
import { afterEach, describe, expect, it } from 'vitest'
import { buildIntentToolHarness, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
import { fixtureGit } from './helpers/fixture-corpus.ts'
import { toolJson } from './helpers/inprocess-client.ts'

let h: IntentToolHarness | undefined
afterEach(() => h?.close())

async function currentVersion(name: string): Promise<string> {
  if (h === undefined) throw new Error('harness not built')
  const body = toolJson(await h.client.callTool('get_definition', { kind: 'table', name })) as { version: string }
  return body.version
}

describe('create_definition — ADR-0005 ruling 5', () => {
  it('creates a new table, auditing a commit, with no enrichment_health key', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('create_definition', {
      kind: 'table',
      table: {
        table_name: 'dws_brand_new',
        table_comment: 'new',
        partitions: [{ name: 'ds', type: 'string' }],
        columns: [{ name: 'shop_id', type: 'string', role: 'dimension' }],
      },
      summary: '首次落地',
      derivation: 'agent',
      confidence: 0.9,
    })
    const body = toolJson(res) as { commit: string; changed: boolean }
    expect(body.changed).toBe(true)
    expect(body.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(body).not.toHaveProperty('enrichment_health')
    expect(h.core.loadTableDefinition('dws_brand_new')).not.toBeNull()
  })

  it('the commit subject carries the tool name as its verb (ADR-0004 ruling 10)', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('create_definition', {
      kind: 'table',
      table: { table_name: 'dws_second', partitions: [{ name: 'ds', type: 'string' }], columns: [] },
      summary: '首次落地',
      derivation: 'agent',
      confidence: 0.9,
    })
    const subjects = fixtureGit(['log', '--format=%s'], h.fixture.root).trim().split('\n')
    expect(subjects[0]).toBe('create_definition(dws_second): 首次落地')
  })

  it('refuses with definition_already_exists (-31022) rather than silently overwriting', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('create_definition', {
      kind: 'table',
      table: { table_name: 'dws_order', partitions: [{ name: 'ds', type: 'string' }], columns: [] },
      summary: 'duplicate',
      derivation: 'agent',
      confidence: 0.9,
    })
    expect(res.result?.['isError']).toBe(true)
    const body = toolJson(res)
    expect(body['code']).toBe(-31022)
    expect(body['name']).toBe('DefinitionAlreadyExistsError')
  })

  it('creates a new event', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('create_definition', {
      kind: 'event',
      event: { name: 'game.pay.order', description: '支付下单', params_fields: {} },
      summary: '首次落地',
      derivation: 'agent',
      confidence: 0.8,
    })
    const body = toolJson(res) as { changed: boolean }
    expect(body.changed).toBe(true)
    expect(h.core.loadEventDefinition('game.pay.order')).not.toBeNull()
  })

  it('rejects a DIM table missing primary_key/label_columns via zod, before the handler runs (generic SDK message, not the structured JSON contract)', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('create_definition', {
      kind: 'table',
      table: { table_name: 'dim_broken', kind: 'dim', partitions: [], columns: [] },
      summary: 'broken',
      derivation: 'agent',
      confidence: 0.9,
    })
    expect(res.result?.['isError']).toBe(true)
    const text = (res.result?.['content'] as Array<{ text: string }>)[0]?.text ?? ''
    // The SDK's own generic path (zod input validation failing before executeToolHandler
    // runs) — a plain string, not this surface's `{code,name,message,...}` JSON.
    expect(() => JSON.parse(text)).toThrow()
    expect(text).toMatch(/Invalid arguments|validation/i)
  })
})

describe('update_definition — ADR-0005 ruling 4', () => {
  it('updates an allowed field and inlines enrichment_health', async () => {
    h = await buildIntentToolHarness({ autoEnrich: true })
    const res = await h.client.callTool('update_definition', {
      kind: 'table',
      name: 'dws_order',
      fields: { description: '订单宽表' },
      summary: '补充描述',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: await currentVersion('dws_order'),
    })
    const body = toolJson(res) as { commit: string; changed: boolean; enrichment_health: unknown[] }
    expect(body.changed).toBe(true)
    expect(Array.isArray(body.enrichment_health)).toBe(true)
  })

  it('rejects a stale baseline as a coded, retryable error (-31002)', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('update_definition', {
      kind: 'table',
      name: 'dws_order',
      fields: { description: 'x' },
      summary: 'stale attempt',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: 'f'.repeat(64),
    })
    expect(res.result?.['isError']).toBe(true)
    const body = toolJson(res)
    expect(body['code']).toBe(-31002)
    expect(body['name']).toBe('StaleBaselineRejection')
    expect(body['retryable']).toBe(true)
  })

  it('the re-read-and-retry loop actually works', async () => {
    h = await buildIntentToolHarness()
    const stale = await h.client.callTool('update_definition', {
      kind: 'table', name: 'dws_order', fields: { description: 'first' },
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: 'f'.repeat(64),
    })
    expect(stale.result?.['isError']).toBe(true)
    const fresh = await h.client.callTool('update_definition', {
      kind: 'table', name: 'dws_order', fields: { description: 'first' },
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await currentVersion('dws_order'),
    })
    expect((toolJson(fresh) as { changed: boolean }).changed).toBe(true)
  })

  it('rejects an array-reference field with a coded redirect to the item-level tool (-31020)', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('update_definition', {
      kind: 'table',
      name: 'dws_order',
      // zod accepts this syntactically (alt_labels stays a typed field) — the handler
      // is what redirects it, per ADR-0005 ruling 4's "报错指路对应 intent 工具".
      fields: { alt_labels: ['x'] },
      summary: 'should be rejected',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: await currentVersion('dws_order'),
    })
    expect(res.result?.['isError']).toBe(true)
    const body = toolJson(res)
    expect(body['code']).toBe(-31020)
    expect(body['name']).toBe('UnsupportedUpdateFieldError')
    expect((body['data'] as { use_instead?: string }).use_instead).toContain('add_alias')
  })

  it('rejects an identity field via the SDK\'s own generic zod rejection (unrecognized key, not JSON)', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('update_definition', {
      kind: 'table',
      name: 'dws_order',
      fields: { table_name: 'renamed' },
      summary: 'should be rejected',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: await currentVersion('dws_order'),
    })
    expect(res.result?.['isError']).toBe(true)
    const text = (res.result?.['content'] as Array<{ text: string }>)[0]?.text ?? ''
    expect(() => JSON.parse(text)).toThrow()
    expect(text.toLowerCase()).toMatch(/unrecognized/)
  })

  it('surfaces a post-merge schema validation failure as a coded error (-31024), distinct from an unsupported field', async () => {
    h = await buildIntentToolHarness()
    // dim_shop is DIM-kind; emptying primary_key fails TableDefinitionSchema's own
    // superRefine on the *merged* document — a value problem, not a field-name problem.
    const res = await h.client.callTool('update_definition', {
      kind: 'table',
      name: 'dim_shop',
      fields: { primary_key: [] },
      summary: 'break the DIM invariant',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: await currentVersion('dim_shop'),
    })
    expect(res.result?.['isError']).toBe(true)
    const body = toolJson(res)
    expect(body['code']).toBe(-31024)
    expect(body['name']).toBe('DefinitionValidationError')
  })

  it('errors with definition_not_found (-31021) for an unknown table', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('update_definition', {
      kind: 'table',
      name: 'nope',
      fields: { description: 'x' },
      summary: 'x',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: 'f'.repeat(64),
    })
    expect(res.result?.['isError']).toBe(true)
    expect(toolJson(res)['code']).toBe(-31021)
  })

  it('is idempotent: the identical write twice reports changed:false and makes no second commit', async () => {
    h = await buildIntentToolHarness()
    const first = await h.client.callTool('update_definition', {
      kind: 'table', name: 'dws_order', fields: { description: '订单宽表' },
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await currentVersion('dws_order'),
    })
    const firstBody = toolJson(first) as { commit: string; changed: boolean }
    expect(firstBody.changed).toBe(true)

    const second = await h.client.callTool('update_definition', {
      kind: 'table', name: 'dws_order', fields: { description: '订单宽表' },
      summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await currentVersion('dws_order'),
    })
    const secondBody = toolJson(second) as { commit: string; changed: boolean }
    expect(secondBody.changed).toBe(false)
    expect(secondBody.commit).toBe(firstBody.commit)
  })

  it('threads the per-call clientInfo into the X-SG-Client trailer (ADR-0005\'s 2026-10-09 addendum)', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool(
      'update_definition',
      { kind: 'table', name: 'dws_order', fields: { description: 'x' }, summary: 'x', derivation: 'agent', confidence: 0.9, expected_version: await currentVersion('dws_order') },
      { name: 'qoderwork', version: '1.0' },
    )
    const trailers = await h.recorder.readTrailers()
    expect(trailers['Client']).toBe('qoderwork')
  })
})

describe('preserve-filter regression — an origin-omitted tool write survives enrichAll* (ADR-0005 ruling 9, Verification)', () => {
  it('a dimension_ref added via add_relation (origin omitted) is not clobbered by a later discoverRelations pass', async () => {
    h = await buildIntentToolHarness()
    // A second DIM with no column-name overlap with dws_order, so the deterministic
    // round finds nothing for it on its own — isolates the assertion to "did the agent's
    // own entry survive" rather than "did enrichment also independently find it".
    await h.client.callTool('create_definition', {
      kind: 'table',
      table: {
        table_name: 'dim_other',
        kind: 'dim',
        primary_key: ['other_id'],
        label_columns: ['other_name'],
        columns: [{ name: 'other_id', type: 'string' }, { name: 'other_name', type: 'string' }],
      },
      summary: '新增维表',
      derivation: 'agent',
      confidence: 0.9,
    })

    await h.client.callTool('add_relation', {
      kind: 'table',
      name: 'dws_order',
      relation: { dim_table: 'dim_other', join_keys: [{ dws_column: 'pay_amt', dim_column: 'other_id' }] },
      summary: '人工补充的关联',
      derivation: 'agent',
      confidence: 0.7,
      expected_version: await currentVersion('dws_order'),
    })

    // Read back through the core's own validated loader (DimensionRefSchema's `origin`
    // is `.optional()` with no `.default()`, so an absent key in the YAML stays absent
    // after parsing) rather than a second, hand-rolled YAML parse in this test file.
    const before = h.core.loadTableDefinition('dws_order')
    const addedRef = before?.dimension_refs.find(r => r.dim_table === 'dim_other')
    expect(addedRef).toBeDefined()
    expect(addedRef).not.toHaveProperty('origin')

    // The enrichAll* pass map #12 / ADR-0005's Verification section calls out.
    await h.core.discoverRelations({ tables: ['dws_order'] })

    const after = h.core.loadTableDefinition('dws_order')
    const survivingRef = after?.dimension_refs.find(r => r.dim_table === 'dim_other')
    expect(survivingRef).toBeDefined()
    expect(survivingRef).not.toHaveProperty('origin')
  })
})

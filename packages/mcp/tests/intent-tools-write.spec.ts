/**
 * ADR-0005's two definition-level write tools — behaviour: `create_definition`,
 * `update_definition`. Covers the brief's explicit minimums: idempotent no-op,
 * `enrichment_health` inlined, and the preserve-filter regression (an origin-omitted
 * tool write survives a subsequent `discoverRelations` / `enrichAll*` pass).
 *
 * Also the write family's wire-error representative (#169/C8): every registered
 * tool rides the same chokepoint error wrap, so the coded wire contract is pinned
 * once here on the write side rather than per tool file.
 *
 * @see docs/adr/0005-mcp-tool-surface.md
 */
import { afterEach, describe, expect, it } from 'vitest'
import { buildIntentToolHarness, tier2, versionOf, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
import { fixtureGit } from './helpers/fixture-corpus.ts'
import { toolJson } from './helpers/inprocess-client.ts'

let h: IntentToolHarness | undefined
afterEach(() => h?.close())

describe('create_definition — ADR-0005 ruling 5', () => {
  it('creates a new table, auditing a commit, with no enrichment_health key', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('create_definition', { scope_id: 'fixture',
      kind: 'table',
      table: {
        table_name: 'dws_brand_new',
        table_comment: 'new',
        partitions: [{ name: 'ds', type: 'string' }],
        columns: [{ name: 'shop_id', type: 'string', role: 'dimension' }],
      },
      ...tier2('首次落地', 0.9),
    })
    const body = toolJson(res) as { commit: string; changed: boolean }
    expect(body.changed).toBe(true)
    expect(body.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(body).not.toHaveProperty('enrichment_health')
    expect(h.core.loadTableDefinition('dws_brand_new')).not.toBeNull()
  })

  it('the commit subject carries the tool name as its verb (ADR-0004 ruling 10)', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('create_definition', { scope_id: 'fixture',
      kind: 'table',
      table: { table_name: 'dws_second', partitions: [{ name: 'ds', type: 'string' }], columns: [] },
      ...tier2('首次落地', 0.9),
    })
    const subjects = fixtureGit(['log', '--format=%s'], h.fixture.root).trim().split('\n')
    expect(subjects[0]).toBe('create_definition(dws_second): 首次落地')
  })

  it('refuses with definition_already_exists (-31022) rather than silently overwriting', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('create_definition', { scope_id: 'fixture',
      kind: 'table',
      table: { table_name: 'dws_order', partitions: [{ name: 'ds', type: 'string' }], columns: [] },
      ...tier2('duplicate', 0.9),
    })
    expect(res.result?.['isError']).toBe(true)
    const body = toolJson(res)
    expect(body['code']).toBe(-31022)
    expect(body['name']).toBe('DefinitionAlreadyExistsError')
  })

  it('creates a new event', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('create_definition', { scope_id: 'fixture',
      kind: 'event',
      event: { name: 'game.pay.order', description: '支付下单', params_fields: {} },
      ...tier2('首次落地', 0.8),
    })
    const body = toolJson(res) as { changed: boolean }
    expect(body.changed).toBe(true)
    expect(h.core.loadEventDefinition('game.pay.order')).not.toBeNull()
  })

  it('rejects a DIM table missing primary_key/label_columns via zod, before the handler runs (generic SDK message, not the structured JSON contract)', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('create_definition', { scope_id: 'fixture',
      kind: 'table',
      table: { table_name: 'dim_broken', kind: 'dim', partitions: [], columns: [] },
      ...tier2('broken', 0.9),
    })
    expect(res.result?.['isError']).toBe(true)
    const text = (res.result?.['content'] as Array<{ text: string }>)[0]?.text ?? ''
    // The SDK's own generic path (zod input validation failing before executeToolHandler
    // runs) — a plain string, not this surface's `{code,name,message,...}` JSON.
    expect(() => JSON.parse(text)).toThrow()
    expect(text).toMatch(/Invalid arguments|validation/i)
  })

  it('creates a concept whose payload carries item-verb keys: stripped and ignored, never written (ADR-0019 R3)', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('create_definition', { scope_id: 'fixture',
      kind: 'concept',
      concept: {
        name: 'item_verb_strip',
        description: 'a concept that arrives carrying round-trip residue',
        // All three item-verb keys present and NON-empty: the strip must ignore
        // them (create never writes edges), not merge them in.
        related_refs: [{ target_kind: 'table', name: 'dim_shop' }],
        suppressed_alt_labels: ['弃用旧称'],
        suppressed_related_refs: [],
      },
      ...tier2('首次落地', 0.9),
    })
    const body = toolJson(res) as { changed: boolean }
    expect(body.changed).toBe(true)
    const stored = h.core.loadConceptDefinition('item_verb_strip')
    expect(stored).not.toBeNull()
    // Ignored means absent from the write: the stored file carries the schema's
    // empty defaults, not the payload's smuggled values.
    expect(stored?.related_refs).toEqual([])
    expect(stored?.suppressed_alt_labels).toEqual([])
    expect(stored?.suppressed_related_refs).toEqual([])
  })
})

describe('update_definition — ADR-0005 ruling 4', () => {
  it('updates an allowed field and inlines enrichment_health', async () => {
    h = await buildIntentToolHarness({ autoEnrich: true })
    const res = await h.client.callTool('update_definition', { scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      fields: { description: '订单宽表' },
      ...tier2('补充描述', 0.9),
      expected_version: await versionOf(h, 'dws_order'),
    })
    const body = toolJson(res) as { commit: string; changed: boolean; enrichment_health: unknown[] }
    expect(body.changed).toBe(true)
    expect(Array.isArray(body.enrichment_health)).toBe(true)
  })

  it('rejects a stale baseline as a coded, retryable error (-31002)', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('update_definition', { scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      fields: { description: 'x' },
      ...tier2('stale attempt', 0.9),
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
    const stale = await h.client.callTool('update_definition', { scope_id: 'fixture',
      kind: 'table', name: 'dws_order', fields: { description: 'first' },
      ...tier2('x', 0.9), expected_version: 'f'.repeat(64),
    })
    expect(stale.result?.['isError']).toBe(true)
    const fresh = await h.client.callTool('update_definition', { scope_id: 'fixture',
      kind: 'table', name: 'dws_order', fields: { description: 'first' },
      ...tier2('x', 0.9), expected_version: await versionOf(h, 'dws_order'),
    })
    expect((toolJson(fresh) as { changed: boolean }).changed).toBe(true)
  })

  it('rejects an array-reference field with a coded redirect to the item-level tool (-31020)', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('update_definition', { scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      // zod accepts this syntactically (alt_labels stays a typed field) — the handler
      // is what redirects it, per ADR-0005 ruling 4's "报错指路对应 intent 工具".
      fields: { alt_labels: ['x'] },
      ...tier2('should be rejected', 0.9),
      expected_version: await versionOf(h, 'dws_order'),
    })
    expect(res.result?.['isError']).toBe(true)
    const body = toolJson(res)
    expect(body['code']).toBe(-31020)
    expect(body['name']).toBe('UnsupportedUpdateFieldError')
    expect((body['data'] as { use_instead?: string }).use_instead).toContain('add_alias')
  })

  it('rejects an identity field via the SDK\'s own generic zod rejection (unrecognized key, not JSON)', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('update_definition', { scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      fields: { table_name: 'renamed' },
      ...tier2('should be rejected', 0.9),
      expected_version: await versionOf(h, 'dws_order'),
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
    const res = await h.client.callTool('update_definition', { scope_id: 'fixture',
      kind: 'table',
      name: 'dim_shop',
      fields: { primary_key: [] },
      ...tier2('break the DIM invariant', 0.9),
      expected_version: await versionOf(h, 'dim_shop'),
    })
    expect(res.result?.['isError']).toBe(true)
    const body = toolJson(res)
    expect(body['code']).toBe(-31024)
    expect(body['name']).toBe('DefinitionValidationError')
  })

  it('errors with definition_not_found (-31021) for an unknown table', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('update_definition', { scope_id: 'fixture',
      kind: 'table',
      name: 'nope',
      fields: { description: 'x' },
      ...tier2('x', 0.9),
      expected_version: 'f'.repeat(64),
    })
    expect(res.result?.['isError']).toBe(true)
    expect(toolJson(res)['code']).toBe(-31021)
  })

  it('is idempotent: the identical write twice reports changed:false and makes no second commit', async () => {
    h = await buildIntentToolHarness()
    const first = await h.client.callTool('update_definition', { scope_id: 'fixture',
      kind: 'table', name: 'dws_order', fields: { description: '订单宽表' },
      ...tier2('x', 0.9), expected_version: await versionOf(h, 'dws_order'),
    })
    const firstBody = toolJson(first) as { commit: string; changed: boolean }
    expect(firstBody.changed).toBe(true)

    const second = await h.client.callTool('update_definition', { scope_id: 'fixture',
      kind: 'table', name: 'dws_order', fields: { description: '订单宽表' },
      ...tier2('x', 0.9), expected_version: await versionOf(h, 'dws_order'),
    })
    const secondBody = toolJson(second) as { commit: string; changed: boolean }
    expect(secondBody.changed).toBe(false)
    expect(secondBody.commit).toBe(firstBody.commit)
  })

  it('threads the per-call clientInfo into the X-SG-Client trailer (ADR-0005\'s 2026-10-09 addendum)', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool(
      'update_definition',
      { scope_id: 'fixture', kind: 'table', name: 'dws_order', fields: { description: 'x' }, ...tier2('x', 0.9), expected_version: await versionOf(h, 'dws_order') },
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
    await h.client.callTool('create_definition', { scope_id: 'fixture',
      kind: 'table',
      table: {
        table_name: 'dim_other',
        kind: 'dim',
        primary_key: ['other_id'],
        label_columns: ['other_name'],
        columns: [{ name: 'other_id', type: 'string' }, { name: 'other_name', type: 'string' }],
      },
      ...tier2('新增维表', 0.9),
    })

    await h.client.callTool('add_relation', { scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      relations: [{ dim_table: 'dim_other', join_keys: [{ dws_column: 'pay_amt', dim_column: 'other_id' }] }],
      ...tier2('人工补充的关联', 0.7),
      expected_version: await versionOf(h, 'dws_order'),
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

describe('write receipts — the version round-trip closes without a read-back (#108)', () => {
  it('chains create → update → add_alias → idempotent add_alias on receipt versions alone', async () => {
    h = await buildIntentToolHarness()
    // Zero get_definition calls below: every baseline is the previous
    // response's `version` — the measured pain this receipt retired.
    const created = toolJson(await h.client.callTool('create_definition', { scope_id: 'fixture',
      kind: 'table',
      table: { table_name: 'dws_chain', partitions: [{ name: 'ds', type: 'string' }], columns: [] },
      ...tier2('首次落地', 0.9),
    })) as { version: string }
    expect(created.version).toMatch(/^[0-9a-f]{64}$/)

    const updated = toolJson(await h.client.callTool('update_definition', { scope_id: 'fixture',
      kind: 'table', name: 'dws_chain', fields: { description: '链式回执' },
      ...tier2('补充描述', 0.9), expected_version: created.version,
    })) as { version: string; changed: boolean }
    expect(updated.changed).toBe(true)
    expect(updated.version).toMatch(/^[0-9a-f]{64}$/)
    expect(updated.version).not.toBe(created.version)

    const aliased = toolJson(await h.client.callTool('add_alias', { scope_id: 'fixture',
      kind: 'table', name: 'dws_chain', labels: ['链式表'],
      ...tier2('加别名', 0.9), expected_version: updated.version,
    })) as { version: string; changed: boolean }
    expect(aliased.changed).toBe(true)
    expect(aliased.version).not.toBe(updated.version)

    // The idempotent repeat: no commit, and the receipt still names the
    // file's CURRENT fingerprint (#107 Q2/Q3's "no-op 恒返当前指纹").
    const repeat = toolJson(await h.client.callTool('add_alias', { scope_id: 'fixture',
      kind: 'table', name: 'dws_chain', labels: ['链式表'],
      ...tier2('再加同名别名', 0.9), expected_version: aliased.version,
    })) as { version: string; changed: boolean }
    expect(repeat.changed).toBe(false)
    expect(repeat.version).toBe(aliased.version)
  })
})

/**
 * Enrichment (B1/B2) pure-machinery tests — discoverRelationsDeterministic /
 * discoverEventRelationsDeterministic (deterministic PK-name round), mergeRefs
 * (origin-priority union), discoverRelationsFor (two-round merge), prompt
 * building + parseLlmRefs. The sweep orchestration over these (the four free
 * functions on the sweep engine) lives in sweep.spec.ts, parameterized per
 * kind (map #64 / #67); fixtures are shared via enrichment-fixtures.ts.
 */
import { test, expect, describe } from 'vitest'
import {
  discoverRelationsDeterministic,
  mergeRefs,
  discoverRelationsFor,
  buildLlmPrompt,
  discoverEventRelationsDeterministic,
  buildEventLlmPrompt,
  parseLlmRefs,
  type DimInventoryEntry,
} from '../src/enrichment.ts'
import { DimensionRefSchema } from '../src/types.ts'
import { dws, event } from './enrichment-fixtures.ts'

const DIM_SERVER: DimInventoryEntry = { table_name: 'dim_10000251_server_info', primary_key: ['server_id'], description: '区服维度表' }
const DIM_ROLE: DimInventoryEntry = { table_name: 'dim_10000251_role_info', primary_key: ['role_id'], description: '角色维度表' }
const DIM_EMPTY: DimInventoryEntry = { table_name: 'dim_10000251_x', primary_key: [], description: 'no pk' }

describe('discoverRelationsDeterministic', () => {
  test('matches DWS columns to DIM primary_key by exact name', () => {
    const refs = discoverRelationsDeterministic(dws(), [DIM_SERVER, DIM_ROLE])
    expect(refs).toHaveLength(2)
    const byDim = Object.fromEntries(refs.map(r => [r.dim_table, r]))
    expect(byDim.dim_10000251_server_info!.join_keys).toEqual([{ dws_column: 'server_id', dim_column: 'server_id' }])
    expect(byDim.dim_10000251_role_info!.join_keys).toEqual([{ dws_column: 'role_id', dim_column: 'role_id' }])
  })

  test('derivation marks the match as deterministic', () => {
    const [r] = discoverRelationsDeterministic(dws(), [DIM_SERVER])
    expect(r!.derivation).toContain('确定性')
    expect(r!.derivation).toContain('server_id')
    expect(r!.origin).toBe('deterministic')
  })

  test('dims with empty primary_key are skipped', () => {
    const refs = discoverRelationsDeterministic(dws(), [DIM_EMPTY, DIM_SERVER])
    expect(refs).toHaveLength(1)
    expect(refs[0]!.dim_table).toBe('dim_10000251_server_info')
  })

  test('composite PK matches only the columns present in the DWS', () => {
    const dim: DimInventoryEntry = { table_name: 'dim_c', primary_key: ['server_id', 'missing_col'], description: '' }
    const [r] = discoverRelationsDeterministic(dws(), [dim])
    expect(r!.join_keys).toEqual([{ dws_column: 'server_id', dim_column: 'server_id' }])
  })

  test('emitted refs validate against DimensionRefSchema', () => {
    for (const r of discoverRelationsDeterministic(dws(), [DIM_SERVER, DIM_ROLE])) {
      expect(DimensionRefSchema.safeParse(r).success).toBe(true)
    }
  })
})

describe('mergeRefs', () => {
  test('dedupes by dim_table, unions join_keys', () => {
    const det = [{ dim_table: 'dim_s', join_keys: [{ dws_column: 'server_id', dim_column: 'server_id' }], derivation: '确定性', origin: 'deterministic' as const }]
    const llm = [
      { dim_table: 'dim_s', join_keys: [{ dws_column: 'srv_id', dim_column: 'server_id' }], derivation: 'llm: 语义匹配', origin: 'llm' as const },
      { dim_table: 'dim_new', join_keys: [{ dws_column: 'x', dim_column: 'x' }], derivation: 'llm only', origin: 'llm' as const },
    ]
    const merged = mergeRefs(det, llm)
    expect(merged).toHaveLength(2)
    const s = merged.find(m => m.dim_table === 'dim_s')!
    expect(s.join_keys).toHaveLength(2)
    expect(s.derivation).toBe('llm: 语义匹配') // LLM derivation preferred over deterministic
    expect(s.origin).toBe('llm')
  })

  test('keeps deterministic ref when LLM has nothing for that dim', () => {
    const merged = mergeRefs([{ dim_table: 'd', join_keys: [{ dws_column: 'a', dim_column: 'a' }], derivation: '确定性', origin: 'deterministic' as const }], [])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.join_keys).toHaveLength(1)
    expect(merged[0]!.origin).toBe('deterministic')
  })

  test('origin=undefined (legacy) is not overridden by llm', () => {
    const legacy = [{ dim_table: 'dim_s', join_keys: [{ dws_column: 'a', dim_column: 'a' }], derivation: 'curated by analyst' }]
    const llm = [{ dim_table: 'dim_s', join_keys: [{ dws_column: 'b', dim_column: 'b' }], derivation: 'llm suggested', origin: 'llm' as const }]
    const merged = mergeRefs(legacy, llm)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.derivation).toBe('curated by analyst') // legacy (undefined origin) not overridden
    expect(merged[0]!.origin).toBeUndefined()
    expect(merged[0]!.join_keys).toHaveLength(2) // join_keys still unioned
  })

  test('origin=undefined (curated, e.g. add_relation) with NO derivation yet is still not overridden by a lower-priority rediscovery (#38 "curated two-step dance" premise: the entry must stay curated through its own on-write hook, or no first-removal-without-veto is ever observable)', () => {
    const curated = [{ dim_table: 'dim_s', join_keys: [{ dws_column: 'a', dim_column: 'a' }], derivation: '' }]
    const det = [{ dim_table: 'dim_s', join_keys: [{ dws_column: 'a', dim_column: 'a' }], derivation: '确定性：a 与 dim_s 主键精确同名', origin: 'deterministic' as const }]
    const merged = mergeRefs(curated, det)
    expect(merged[0]!.origin).toBeUndefined()
    expect(merged[0]!.derivation).toBe('')
  })

  test('origin=manual is not overridden by llm or deterministic', () => {
    const manual = [{ dim_table: 'dim_s', join_keys: [{ dws_column: 'a', dim_column: 'a' }], derivation: 'manual', origin: 'manual' as const }]
    const llm = [{ dim_table: 'dim_s', join_keys: [{ dws_column: 'a', dim_column: 'a' }], derivation: 'llm says', origin: 'llm' as const }]
    const merged = mergeRefs(manual, llm)
    expect(merged[0]!.derivation).toBe('manual')
    expect(merged[0]!.origin).toBe('manual')
  })

  test('origin=deterministic is overridden by llm', () => {
    const det = [{ dim_table: 'dim_s', join_keys: [{ dws_column: 'a', dim_column: 'a' }], derivation: 'det', origin: 'deterministic' as const }]
    const llm = [{ dim_table: 'dim_s', join_keys: [{ dws_column: 'a', dim_column: 'a' }], derivation: 'llm', origin: 'llm' as const }]
    const merged = mergeRefs(det, llm)
    expect(merged[0]!.derivation).toBe('llm')
    expect(merged[0]!.origin).toBe('llm')
  })

  test('origin=llm is overridden by manual', () => {
    const llm = [{ dim_table: 'dim_s', join_keys: [{ dws_column: 'a', dim_column: 'a' }], derivation: 'llm', origin: 'llm' as const }]
    const manual = [{ dim_table: 'dim_s', join_keys: [{ dws_column: 'a', dim_column: 'a' }], derivation: 'manual', origin: 'manual' as const }]
    const merged = mergeRefs(llm, manual)
    expect(merged[0]!.derivation).toBe('manual')
    expect(merged[0]!.origin).toBe('manual')
  })
})

describe('discoverRelationsFor', () => {
  test('without llmCall -> deterministic round only', async () => {
    const refs = await discoverRelationsFor(dws(), [DIM_SERVER])
    expect(refs).toHaveLength(1)
    expect(refs[0]!.dim_table).toBe('dim_10000251_server_info')
  })

  test('with mock llmCall -> merges LLM refs with deterministic', async () => {
    const llmCall = async () => JSON.stringify([
      { dim_table: 'dim_10000251_server_info', join_keys: [{ dws_column: 'srv_id', dim_column: 'server_id' }], derivation: 'llm semantic' },
      { dim_table: 'dim_10000251_charm_info', join_keys: [{ dws_column: 'charm_id', dim_column: 'charm_id' }], derivation: 'llm new' },
    ])
    const refs = await discoverRelationsFor(dws(), [DIM_SERVER], llmCall)
    expect(refs).toHaveLength(2)
    const s = refs.find(r => r.dim_table === 'dim_10000251_server_info')!
    expect(s.join_keys).toHaveLength(2) // deterministic server_id + llm srv_id
  })

  test('llmCall throwing -> graceful, deterministic round returned', async () => {
    const llmCall = async () => { throw new Error('boom') }
    const refs = await discoverRelationsFor(dws(), [DIM_SERVER], llmCall)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.derivation).toContain('确定性')
    expect(refs[0]!.origin).toBe('deterministic')
  })

  test('llmCall returning invalid JSON -> graceful, deterministic round returned', async () => {
    const llmCall = async () => 'not json {{{'
    const refs = await discoverRelationsFor(dws(), [DIM_SERVER], llmCall)
    expect(refs).toHaveLength(1)
  })

  test('buildLlmPrompt includes target columns + dim inventory', () => {
    const prompt = buildLlmPrompt(dws(), [DIM_SERVER])
    expect(prompt).toContain('dws_pay_order_di')
    expect(prompt).toContain('server_id')
    expect(prompt).toContain('dim_10000251_server_info')
  })
})


describe('discoverEventRelationsDeterministic', () => {
  test('matches event param fields to DIM primary_key by exact name', () => {
    const refs = discoverEventRelationsDeterministic(event(), [DIM_SERVER, DIM_ROLE])
    expect(refs).toHaveLength(2)
    const byDim = Object.fromEntries(refs.map(r => [r.dim_table, r]))
    expect(byDim.dim_10000251_server_info!.join_keys).toEqual([{ dws_column: 'server_id', dim_column: 'server_id' }])
  })

  test('derivation marks the match as deterministic', () => {
    const [r] = discoverEventRelationsDeterministic(event(), [DIM_SERVER])
    expect(r!.derivation).toContain('确定性')
    expect(r!.origin).toBe('deterministic')
  })
})

describe('buildEventLlmPrompt', () => {
  test('includes event name + params + dim inventory', () => {
    const p = buildEventLlmPrompt(event(), [DIM_SERVER])
    expect(p).toContain('game.pay.order')
    expect(p).toContain('server_id')
    expect(p).toContain('dim_10000251_server_info')
  })
})

describe('parseLlmRefs', () => {
  test('stamps origin=llm on all parsed refs', () => {
    const refs = parseLlmRefs('[{"dim_table":"d","join_keys":[{"dws_column":"a","dim_column":"a"}],"derivation":"test"}]')
    expect(refs).toHaveLength(1)
    expect(refs[0]!.origin).toBe('llm')
  })
})

describe('mergeRefs — empty derivation fill', () => {
  test('fills empty derivation from added ref even when origin priority is not higher', () => {
    const baseline = [{ dim_table: 'dim_s', join_keys: [{ dws_column: 'a', dim_column: 'a' }], derivation: '', origin: 'llm' as const }]
    const added = [{ dim_table: 'dim_s', join_keys: [{ dws_column: 'a', dim_column: 'a' }], derivation: 'filled by lower', origin: 'deterministic' as const }]
    const merged = mergeRefs(baseline, added)
    expect(merged[0]!.derivation).toBe('filled by lower')
    expect(merged[0]!.origin).toBe('deterministic')
  })
})

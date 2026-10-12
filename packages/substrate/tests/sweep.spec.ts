/**
 * Sweep-engine tests (map #64 / ticket #67): the subject is `sweepEnrichment`,
 * not any one pipeline. Two halves:
 *
 * 1. Engine invariants over a synthetic adapter (no filesystem): the engine's
 *    own contract — prepare-skip short-circuit, filter-before-parse-error,
 *    gain-only zero-commit idempotency, counter semantics, error strings,
 *    opts pass-through — proven to hold for ANY adapter, which is the point
 *    of folding the four mirror pipelines onto one engine.
 *
 * 2. The four real pipelines parameterized per family over the table/event
 *    kind (`describe.each`): one test body + the kind's case (free function +
 *    fixture + refs key). This replaces the mirror-pipeline describes that
 *    used to live in enrichment.spec.ts / alt-labels-enrichment.spec.ts — the
 *    fixtures exist once per family, and every behavior now runs on both
 *    kinds (escape-hatch / mergeExisting were table-only before only because
 *    the event mirror had never been written).
 */
import { test, expect, describe, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  sweepEnrichment,
  enrichAllDwsTables,
  enrichAllEvents,
  enrichAllTablesAltLabels,
  enrichAllEventsAltLabels,
  type LlmCall,
  type EnrichmentKindAdapter,
} from '../src/enrichment.ts'
import { dumpYaml, type Tier2Opts } from '../src/io.ts'
import { dws, event, dimServerYaml, makeLayer, readYaml } from './enrichment-fixtures.ts'

// ── 1. Engine invariants (synthetic adapter, no filesystem) ──────────────

interface SynthDef {
  readonly label: string
}

/** A minimal recording adapter kit: two targets (`a`, `b`), every stage call
 * captured; any stage overridable per test. No filesystem involved. */
function synthKit() {
  const calls: string[] = []
  const discovers: Array<{ name: string; ctx: unknown; llm: unknown }> = []
  const merges: Array<{ name: string; existing: readonly string[]; discovered: readonly string[]; mergeContext: unknown }> = []
  const writes: Array<{ name: string; items: readonly string[]; tier2: unknown }> = []
  const target = (name: string) => ({ semanticLayer: '/x', name, raw: {}, def: { label: name }, existing: [] as string[] })
  const adapter = (
    over: Partial<EnrichmentKindAdapter<SynthDef, string, undefined>> = {},
  ): EnrichmentKindAdapter<SynthDef, string, undefined> => ({
    kind: 'table',
    writePolicy: 'always',
    list: () => [target('a'), target('b')],
    discover: async (t, ctx, llmCall) => {
      discovers.push({ name: t.name, ctx, llm: llmCall })
      calls.push(`discover:${t.name}`)
      return ['new']
    },
    veto: (_t, d) => d,
    merge: (t, existing, discovered, mergeContext) => {
      merges.push({ name: t.name, existing, discovered, mergeContext })
      return [...existing, ...discovered]
    },
    write: async (t, items, tier2) => {
      writes.push({ name: t.name, items, tier2 })
      calls.push(`write:${t.name}`)
      return { ok: true, path: `${t.name}.yaml` }
    },
    ...over,
  })
  return { calls, discovers, merges, writes, target, adapter }
}

describe('sweepEnrichment — engine invariants (synthetic adapter)', () => {
  test('prepare skip short-circuits: zero counts + note, nothing listed/discovered/written', async () => {
    const k = synthKit()
    const res = await sweepEnrichment(k.adapter({ prepare: () => ({ skip: { reason: 'nothing in scope' } }) }), '/ignored')
    expect(res).toEqual({ enriched: 0, written: 0, errors: [], note: 'nothing in scope' })
    expect(k.calls).toEqual([])
  })

  test('names filter: non-named defs skipped; omitted or empty names = every def', async () => {
    const named = await sweepEnrichment(synthKit().adapter(), '/x', { names: ['a'] })
    expect(named.written).toBe(1)
    const empty = await sweepEnrichment(synthKit().adapter(), '/x', { names: [] })
    expect(empty.written).toBe(2)
    const omitted = await sweepEnrichment(synthKit().adapter(), '/x')
    expect(omitted.written).toBe(2)
  })

  test('the filter runs BEFORE the parse-error recording: a filtered-out parse-failed def contributes no error', async () => {
    const k = synthKit()
    const res = await sweepEnrichment(
      k.adapter({ list: () => [k.target('a'), { name: 'b', parseError: true }] }),
      '/x',
      { names: ['a'] },
    )
    expect(res.errors).toEqual([])
  })

  test('a parse-failed def records `${name}: schema parse failed` and never reaches discover', async () => {
    const k = synthKit()
    const res = await sweepEnrichment(
      k.adapter({ list: () => [{ name: 'bad', parseError: true }, k.target('good')] }),
      '/x',
    )
    expect(res.errors).toEqual(['bad: schema parse failed'])
    expect(k.calls).toEqual(['discover:good', 'write:good'])
  })

  test("gain-only policy skips the write when the post-veto discovery is empty — #37's zero-commit idempotency", async () => {
    const k = synthKit()
    const res = await sweepEnrichment(k.adapter({ writePolicy: 'gain-only', veto: () => [] }), '/x')
    expect(res).toEqual({ enriched: 0, written: 0, errors: [] })
    expect(k.calls.filter(c => c.startsWith('write:'))).toEqual([])
  })

  test('counters: written counts successful writes; enriched only when the merged list is non-empty (always-policy refresh)', async () => {
    const k = synthKit()
    const res = await sweepEnrichment(k.adapter({ discover: async () => [], merge: () => [] }), '/x')
    expect(res).toEqual({ enriched: 0, written: 2, errors: [] })
  })

  test("a write's {ok:false} becomes `${name}: ${error}` and the batch continues", async () => {
    const k = synthKit()
    const res = await sweepEnrichment(
      k.adapter({ write: async t => (t.name === 'a' ? { ok: false, error: 'nope' } : { ok: true, path: 'b.yaml' }) }),
      '/x',
    )
    expect(res).toEqual({ enriched: 1, written: 1, errors: ['a: nope'] })
  })

  test('a thrown stage becomes `${name}: ${message}` and the batch continues', async () => {
    const k = synthKit()
    const res = await sweepEnrichment(
      k.adapter({ discover: async t => { if (t.name === 'a') throw new Error('boom'); return ['new'] } }),
      '/x',
    )
    expect(res.errors).toEqual(['a: boom'])
    expect(res.written).toBe(1) // b still processed
  })

  test('mergeContext defaults to { mergeExisting: false, preserveCurated: true } when opts omit it', async () => {
    const k = synthKit()
    await sweepEnrichment(k.adapter(), '/x')
    expect(k.merges.map(m => m.mergeContext)).toEqual([
      { mergeExisting: false, preserveCurated: true },
      { mergeExisting: false, preserveCurated: true },
    ])
  })

  test('opts pass-through: llmCall → discover, tier2 → write (verbatim identity)', async () => {
    const k = synthKit()
    const llmCall: LlmCall = async () => '[]'
    const tier2 = { recorder: {} } as Tier2Opts
    await sweepEnrichment(k.adapter(), '/x', { llmCall, tier2 })
    expect(k.discovers.map(d => d.llm)).toEqual([llmCall, llmCall])
    expect(k.writes.map(w => w.tier2)).toEqual([tier2, tier2])
  })

  test('prepare-resolved context is threaded to discover and veto (the TCtx promise)', async () => {
    const ctx = { corpus: ['x'] }
    const got: unknown[] = []
    const adapter: EnrichmentKindAdapter<{ n: string }, string, { corpus: string[] }> = {
      kind: 'event',
      writePolicy: 'always',
      prepare: () => ({ context: ctx }),
      list: () => [{ semanticLayer: '/x', name: 'a', raw: {}, def: { n: 'a' }, existing: [] }],
      discover: async (_t, c) => { got.push(['discover', c]); return [] },
      veto: (_t, d, c) => { got.push(['veto', c]); return d },
      merge: (_t, e, d) => [...e, ...d],
      write: async t => ({ ok: true, path: `${t.name}.yaml` }),
    }
    await sweepEnrichment(adapter, '/x')
    expect(got).toEqual([['discover', ctx], ['veto', ctx]])
  })
})

// ── 2. The real pipelines, parameterized per family over the kind ────────

/** The shared curated-refs fixture for the merge-mode tests: dim_other
 * (undefined origin = legacy curated), dim_manual (explicit manual),
 * dim_server (stale deterministic — the only one the deterministic round can
 * rediscover, via the target's server_id column/param). */
const CURATED_REFS = [
  { dim_table: 'dim_other', join_keys: [{ dws_column: 'other_id', dim_column: 'other_id' }], derivation: 'curated by analyst' },
  { dim_table: 'dim_manual', join_keys: [{ dws_column: 'm_id', dim_column: 'm_id' }], derivation: 'manual join', origin: 'manual' as const },
  { dim_table: 'dim_server', join_keys: [{ dws_column: 'server_id', dim_column: 'server_id' }], derivation: 'stale deterministic', origin: 'deterministic' as const },
]

interface RefOut {
  dim_table: string
  join_keys: unknown[]
  origin?: string
  derivation: string
}

/** The free functions' common shape as the tests drive them (the
 * excludeColumnsFn slot is never exercised here — passing `undefined`
 * through it keeps both kinds' signatures assignable to one case type). */
type RelationsRun = (
  semanticLayer: string,
  llmCall?: LlmCall,
  names?: readonly string[],
  mergeExisting?: boolean,
  excludeColumnsFn?: undefined,
  preserveCurated?: boolean,
) => Promise<{ enriched: number; written: number; errors: string[]; note?: string }>

interface RelationsCase {
  readonly title: string
  readonly run: RelationsRun
  readonly targetName: string
  readonly writeTarget: (dir: string, refs?: typeof CURATED_REFS) => void
  readonly targetPath: (dir: string) => string
  readonly writeSecond: (dir: string) => void
  readonly secondPath: (dir: string) => string
  readonly refsKey: 'dimension_refs' | 'external_refs'
  /** The kind-specific "the rest of the file survives verbatim" assertion. */
  readonly assertPreserved: (raw: Record<string, unknown>) => void
}

const relationsKinds: readonly RelationsCase[] = [
  {
    title: 'enrichAllDwsTables × tableRelationsAdapter',
    run: enrichAllDwsTables,
    targetName: 'dws_pay',
    writeTarget: (dir, refs) =>
      writeFileSync(join(dir, 'tables', 'dws_pay.yaml'), dumpYaml({
        ...dws({
          table_name: 'dws_pay',
          columns: [{ name: 'server_id', type: 'BIGINT', comment: '区服ID', role: 'dimension' }],
        }),
        dimension_refs: refs ?? [],
      })),
    targetPath: dir => join(dir, 'tables', 'dws_pay.yaml'),
    writeSecond: dir =>
      writeFileSync(join(dir, 'tables', 'dws_b.yaml'), dumpYaml(
        dws({ table_name: 'dws_b', columns: [{ name: 'server_id', type: 'string', comment: '', role: 'dimension' }] }))),
    secondPath: dir => join(dir, 'tables', 'dws_b.yaml'),
    refsKey: 'dimension_refs',
    // writeTable writes the passed raw dict: the BIGINT physical spelling
    // survives verbatim (it canonicalizes to int on parse — must not round-trip).
    assertPreserved: raw => {
      expect((raw.columns as Array<{ type: string }>)[0]!.type).toBe('BIGINT')
    },
  },
  {
    title: 'enrichAllEvents × eventRelationsAdapter',
    run: enrichAllEvents,
    targetName: 'game.pay.order',
    writeTarget: (dir, refs) =>
      writeFileSync(join(dir, 'events', 'pay', 'game.pay.order.yaml'), dumpYaml({ ...event(), external_refs: refs ?? [] })),
    targetPath: dir => join(dir, 'events', 'pay', 'game.pay.order.yaml'),
    writeSecond: dir =>
      writeFileSync(join(dir, 'events', 'pay', 'game.pay.other.yaml'), dumpYaml(event({ name: 'game.pay.other' }))),
    secondPath: dir => join(dir, 'events', 'pay', 'game.pay.other.yaml'),
    refsKey: 'external_refs',
    // writeEventYaml re-dumps the raw dict: untouched keys survive verbatim.
    assertPreserved: raw => {
      expect(raw.description).toBe('玩家充值下单')
    },
  },
]

describe.each(relationsKinds)('sweepEnrichment — relations ($title)', k => {
  let dir: string
  beforeEach(() => { dir = makeLayer('k67-sweep-rel-') })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const writeDim = () => writeFileSync(join(dir, 'tables', 'dim_server.yaml'), dimServerYaml())
  const refsOf = () => readYaml(k.targetPath(dir))[k.refsKey] as RefOut[]

  test('writes the family refs key + preserves the rest of the file verbatim', async () => {
    writeDim()
    k.writeTarget(dir)
    const res = await k.run(dir)
    expect(res.errors).toEqual([])
    expect(res.enriched).toBe(1)
    const refs = refsOf()
    expect(refs).toHaveLength(1)
    expect(refs[0]!.dim_table).toBe('dim_server')
    k.assertPreserved(readYaml(k.targetPath(dir)))
  })

  test('with mock llmCall → LLM refs merge with the deterministic round', async () => {
    writeDim()
    k.writeTarget(dir)
    const llmCall = async () => JSON.stringify([
      { dim_table: 'dim_server', join_keys: [{ dws_column: 'srv_id', dim_column: 'server_id' }], derivation: 'llm semantic' },
    ])
    const res = await k.run(dir, llmCall)
    expect(res.enriched).toBe(1)
    const s = refsOf().find(r => r.dim_table === 'dim_server')!
    expect(s.join_keys).toHaveLength(2) // deterministic server_id + llm srv_id
  })

  test('names filter enriches only the named defs', async () => {
    writeDim()
    k.writeTarget(dir)
    k.writeSecond(dir)
    const res = await k.run(dir, undefined, [k.targetName])
    expect(res.written).toBe(1)
    expect(refsOf()).toHaveLength(1)
    expect((readYaml(k.secondPath(dir))[k.refsKey] as unknown[])).toHaveLength(0) // filtered out → untouched
  })

  test('replace mode (default) preserves manual + undefined (curated) refs while refreshing deterministic ones', async () => {
    writeDim()
    k.writeTarget(dir, CURATED_REFS)
    const res = await k.run(dir) // default mergeExisting=false (replace), preserveCurated=true
    expect(res.written).toBe(1)
    const refs = refsOf()
    const byDim = Object.fromEntries(refs.map(r => [r.dim_table, r]))
    expect(refs).toHaveLength(3) // dim_other + dim_manual preserved, dim_server refreshed
    // undefined-origin legacy curated ref survives untouched:
    expect(byDim.dim_other!.derivation).toBe('curated by analyst')
    expect(byDim.dim_other!.origin).toBeUndefined()
    // explicit manual ref survives untouched:
    expect(byDim.dim_manual!.derivation).toBe('manual join')
    expect(byDim.dim_manual!.origin).toBe('manual')
    // deterministic existing ref dropped & re-discovered fresh:
    expect(byDim.dim_server!.derivation).toContain('确定性')
    expect(byDim.dim_server!.origin).toBe('deterministic')
  })

  test('mergeExisting=true preserves curated refs the deterministic round does not rediscover', async () => {
    writeDim()
    k.writeTarget(dir, CURATED_REFS)
    const res = await k.run(dir, undefined, undefined, true)
    expect(res.written).toBe(1)
    const dimTables = refsOf().map(r => r.dim_table).sort()
    expect(dimTables).toEqual(['dim_manual', 'dim_other', 'dim_server']) // curated kept + dim_server rediscovered
  })

  test('preserveCurated=false (escape-hatch) drops curated refs for a raw full replace (GA-GT3-5b)', async () => {
    writeDim()
    k.writeTarget(dir, CURATED_REFS)
    // 6th positional param preserveCurated=false -> raw full replace
    const res = await k.run(dir, undefined, undefined, false, undefined, false)
    expect(res.written).toBe(1)
    const refs = refsOf()
    // only the rediscovered dim_server remains; curated dim_other + dim_manual DROPPED
    expect(refs).toHaveLength(1)
    expect(refs[0]!.dim_table).toBe('dim_server')
    expect(refs[0]!.derivation).toContain('确定性')
    expect(refs[0]!.origin).toBe('deterministic')
  })

  test('empty DIM inventory short-circuits: written:0, file untouched on disk (GA-GT3 item 6)', async () => {
    k.writeTarget(dir, CURATED_REFS) // no DIM written
    const before = readFileSync(k.targetPath(dir), 'utf-8')
    const res = await k.run(dir)
    expect(res.written).toBe(0)
    expect(res.enriched).toBe(0)
    expect(res.errors).toEqual([])
    expect(readFileSync(k.targetPath(dir), 'utf-8')).toBe(before) // curated refs already on disk, untouched
  })

  test('empty DIM inventory returns the agent-visible note, NOT console.warn [GA-GT3-6b]', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    k.writeTarget(dir)
    const res = await k.run(dir)
    expect(res.note).toBe('no DIM tables in scope, nothing to enrich')
    expect(res.written).toBe(0)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

type AltRun = (
  semanticLayer: string,
  llmCall?: LlmCall,
  names?: readonly string[],
) => Promise<{ enriched: number; written: number; errors: string[] }>

interface AltCase {
  readonly title: string
  readonly run: AltRun
  readonly writeTarget: (dir: string, extra?: Record<string, unknown>) => void
  readonly targetPath: (dir: string) => string
  readonly writeSecond: (dir: string) => void
  readonly secondName: string
  readonly secondPath: (dir: string) => string
  /** The deterministic round's expected labels for the default target. */
  readonly expectedLabels: readonly string[]
}

const altKinds: readonly AltCase[] = [
  {
    title: 'enrichAllTablesAltLabels × tableAltLabelsAdapter',
    run: enrichAllTablesAltLabels,
    writeTarget: (dir, extra = {}) =>
      writeFileSync(join(dir, 'tables', 'dws_active_user_di.yaml'), dumpYaml({
        table_name: 'dws_active_user_di',
        table_comment: '',
        description: '日活跃用户宽表（DAU）',
        domains: ['活跃'],
        columns: [{ name: 'user_id', type: 'string', comment: '用户ID' }],
        kind: 'dws',
        primary_key: [],
        label_columns: [],
        alt_labels: [],
        ...extra,
      })),
    targetPath: dir => join(dir, 'tables', 'dws_active_user_di.yaml'),
    writeSecond: dir =>
      writeFileSync(join(dir, 'tables', 'dws_pay_order_di.yaml'), dumpYaml({
        table_name: 'dws_pay_order_di',
        table_comment: '',
        description: '付费订单（充值）',
        domains: [],
        columns: [],
        kind: 'dws',
        primary_key: [],
        label_columns: [],
        alt_labels: [],
      })),
    secondName: 'dws_pay_order_di',
    secondPath: dir => join(dir, 'tables', 'dws_pay_order_di.yaml'),
    expectedLabels: ['DAU', '活跃'],
  },
  {
    title: 'enrichAllEventsAltLabels × eventAltLabelsAdapter',
    run: enrichAllEventsAltLabels,
    writeTarget: (dir, extra = {}) =>
      writeFileSync(join(dir, 'events', 'social', 'social.friend_chat.yaml'), dumpYaml({
        name: 'social.friend_chat',
        description: '好友互动事件（聊天）',
        domains: ['社交'],
        params_fields: { friend_id: { type: 'string', description: '好友ID' } },
        alt_labels: [],
        ...extra,
      })),
    targetPath: dir => join(dir, 'events', 'social', 'social.friend_chat.yaml'),
    writeSecond: dir =>
      writeFileSync(join(dir, 'events', 'social', 'social.gift_send.yaml'), dumpYaml({
        name: 'social.gift_send',
        description: '赠送礼物（送礼）',
        domains: ['经济'],
        params_fields: {},
        alt_labels: [],
      })),
    secondName: 'social.gift_send',
    secondPath: dir => join(dir, 'events', 'social', 'social.gift_send.yaml'),
    expectedLabels: ['聊天', '社交'],
  },
]

describe.each(altKinds)('sweepEnrichment — alt_labels ($title)', k => {
  let dir: string
  beforeEach(() => { dir = makeLayer('k67-sweep-alt-') })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const labelsOf = () => readYaml(k.targetPath(dir)).alt_labels as string[]

  test('enriches with deterministic labels (parenthesized terms + domains)', async () => {
    k.writeTarget(dir)
    const res = await k.run(dir)
    expect(res.enriched).toBe(1)
    expect(res.written).toBe(1)
    expect(res.errors).toEqual([])
    for (const l of k.expectedLabels) expect(labelsOf()).toContain(l)
  })

  test('preserves existing alt_labels and appends new (union merge never removes curated)', async () => {
    k.writeTarget(dir, { alt_labels: ['existing'] })
    const res = await k.run(dir)
    expect(res.enriched).toBe(1)
    const labels = labelsOf()
    expect(labels[0]).toBe('existing')
    for (const l of k.expectedLabels) expect(labels).toContain(l)
  })

  test('gain-only: no discoverable labels → zero writes, file untouched on disk', async () => {
    k.writeTarget(dir, { description: 'plain and boring', domains: [] })
    const before = readFileSync(k.targetPath(dir), 'utf-8')
    const res = await k.run(dir)
    expect(res.enriched).toBe(0)
    expect(res.written).toBe(0)
    expect(readFileSync(k.targetPath(dir), 'utf-8')).toBe(before)
  })

  test('names filter enriches only the named defs', async () => {
    k.writeTarget(dir)
    k.writeSecond(dir)
    const res = await k.run(dir, undefined, [k.secondName])
    expect(res.enriched).toBe(1)
    expect((readYaml(k.targetPath(dir)).alt_labels as string[]).length).toBe(0) // filtered out → untouched
  })

  test('LLM round supplements the deterministic labels when provided', async () => {
    k.writeTarget(dir)
    const llmCall = async () => '["新标签甲", "新标签乙"]'
    const res = await k.run(dir, llmCall)
    expect(res.enriched).toBe(1)
    for (const l of ['新标签甲', '新标签乙']) expect(labelsOf()).toContain(l)
  })
})

// ── Table-only by construction: DIM defs exist only in the tables corpus ──
// The table relations adapter's `list` filters kind==='dim' out AFTER the
// schema parse (a parse-failed DIM still errors — the parse-then-filter order
// #65 pinned); events have no kind dimension, so no event mirror exists.

describe('tableRelationsAdapter.list — DIM defs are not sweep targets', () => {
  let dir: string
  beforeEach(() => { dir = makeLayer('k67-sweep-dim-') })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  test('a parseable DIM is not enriched (only DWS tables are targets)', async () => {
    writeFileSync(join(dir, 'tables', 'dim_server.yaml'), dimServerYaml())
    const res = await enrichAllDwsTables(dir)
    expect(res.enriched).toBe(0)
    expect(res.written).toBe(0)
  })

  test('a parse-failed DIM still records its schema error (parse-then-filter, not filter-then-parse)', async () => {
    writeFileSync(join(dir, 'tables', 'dim_bad.yaml'), dumpYaml({ table_name: 'dim_bad', kind: 'dim' }))
    writeFileSync(join(dir, 'tables', 'dim_server.yaml'), dimServerYaml())
    const res = await enrichAllDwsTables(dir)
    expect(res.errors).toEqual(['dim_bad: schema parse failed'])
  })
})

/**
 * ADR-0006/0008's four enrichment tools (`get_enrichment_work` /
 * `get_enrichment_prompts` / `apply_enrichment` / `run_enrichment`,
 * `src/tools/enrichment.ts`), driven end to end through the real registration and
 * dispatch path: `buildIntentToolHarness` (production's default registrars — all
 * nineteen tools) plus an `InProcessClient`, so the SDK's real zod `inputSchema`
 * validation runs on every call, the same seam an agent's traffic crosses.
 *
 * These cover ADR-0006's Verification section claims directly: a `work_id` survives a
 * server restart (modeled as a second, independently-constructed harness over the same
 * corpus — new recorder, core, server, and client, nothing carried over, which is the
 * entirety of what "restart" means when there is no session state to lose, map #12's
 * own stateless-protocol framing); one stale item in a batch does not poison the
 * others; a fully idempotent batch produces no commit; `apply_enrichment`'s response
 * carries per-item verdict + commit + changed + inline `enrichment_health`; and
 * `run_enrichment` removes deterministically-derivable gaps from the work list.
 *
 * History: this file used to invoke the handlers directly against a ~120-line private
 * capture harness, because `buildIntentToolHarness` hard-coded the fifteen intent
 * registrars and the enrichment family could not register there (#21's gap). #57 made
 * the harness mirror production's registrars and moved this file onto it. One
 * direct-handler slice is deliberately retained below: it pins the below-zod doors —
 * a `tables: []` reaching the Core door intact, and the zod objects themselves via
 * `safeParse` — where bypassing the wire gate is the point.
 *
 * `autoEnrich` is on here (as it was, by the class default, under this file's
 * pre-#57 hand-built deps, and as the e2e gate's real `startup()` runs it): these
 * tests count commits over writes the on-write hook observes.
 *
 * @see docs/adr/0006-enrichment-agent-driven.md
 * @see docs/adr/0007-dimension-filter-semantics.md
 * @see docs/adr/0008-enrichment-work-response-sizing.md
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLIENT_INFO_META_KEY, type CallToolResult } from '@modelcontextprotocol/server'
import { SemanticGroundingCore, loadEvents, loadTables } from '@semantic-grounding/substrate'
import type { ServerConfig } from '../src/config.ts'
import { GitTier2Recorder } from '../src/git/recorder.ts'
import type { ServerDeps } from '../src/server.ts'
import { registerEnrichmentTools } from '../src/tools/enrichment.ts'
import { buildIntentToolHarness, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
import { commitExternalEdit, createFixtureCorpus, fixtureGit, type FixtureCorpus } from './helpers/fixture-corpus.ts'
import { toolJson } from './helpers/inprocess-client.ts'

// ── Main path: real registrars, real zod dispatch, real envelope ────────────────────

let fixture: FixtureCorpus
const openHarnesses: IntentToolHarness[] = []

beforeEach(() => { fixture = createFixtureCorpus() }) // withDim: true (default) — dws_order + dim_shop, shop_id-joinable
afterEach(async () => {
  for (const h of openHarnesses.splice(0)) await h.close()
  fixture.cleanup()
})

/**
 * Serve a corpus through a production-shaped harness — all nineteen tools, autoEnrich
 * on. The root is borrowed (`corpusRoot`), so `close()` tears down only the client;
 * the directory's lifecycle belongs to its owner (the module fixture, or a test's own
 * `createFixtureCorpus`).
 * @param root - the corpus root to serve (default the module fixture).
 * @returns the harness, closed automatically by `afterEach`.
 */
async function serve(root: string = fixture.root): Promise<IntentToolHarness> {
  const h = await buildIntentToolHarness({ corpusRoot: root, autoEnrich: true })
  openHarnesses.push(h)
  return h
}

/** One `tools/call` outcome as the tests read it: the isError flag plus the parsed body. */
interface Outcome {
  readonly isError: boolean
  readonly body: Record<string, unknown>
}

/**
 * Call a tool through the client — real zod validation, real envelope, real
 * `toToolErrorResult` shaping (an error payload parses the same as a success body).
 * @param h - the harness to call through.
 * @param name - the tool name.
 * @param args - schema-valid tool input.
 * @param clientName - optional per-call client name (ADR-0005's addendum), carried the
 *   real way: as the envelope's `clientInfo`.
 * @returns the outcome.
 */
async function call(
  h: IntentToolHarness,
  name: string,
  args: Readonly<Record<string, unknown>>,
  clientName?: string,
): Promise<Outcome> {
  const res = await h.client.callTool(name, args, clientName !== undefined ? { name: clientName } : undefined)
  return { isError: res.result?.['isError'] === true, body: toolJson(res) }
}

// ── Retained direct-handler slice: the below-zod doors ──────────────────────────────

/** The minimal shape this file needs from a tool handler. */
type Handler = (args: unknown, extra: unknown) => Promise<CallToolResult> | CallToolResult

/**
 * Register the enrichment tool family against a fake server that only implements
 * `registerTool`, capturing each handler by name. The registrar itself is pure
 * registration (`server.ts`'s own contract), so this is a faithful exercise of it.
 *
 * The retained slice's reason to exist: handlers called DIRECTLY with raw args skip
 * the SDK's zod `inputSchema` validation, which is exactly what the below-zod pins
 * need — a `tables: []` must be refused by the Core door even when the wire gate is
 * absent, and the zod-level gates (`min(1)`, the prompt batch cap) are pinned against
 * the captured `inputSchema` objects themselves.
 * @param deps - the process-wide deps the registrar closes over.
 * @returns the tool handlers, keyed by name, and each tool's registered config.
 */
function captureTools(deps: ServerDeps): Map<string, Handler> {
  capturedConfigs.clear()
  const tools = new Map<string, Handler>()
  const fakeServer = {
    registerTool: (name: string, config: unknown, handler: Handler) => {
      tools.set(name, handler)
      capturedConfigs.set(name, config as { readonly inputSchema?: { safeParse(input: unknown): { success: boolean } } })
    },
  }
  registerEnrichmentTools(fakeServer as unknown as Parameters<typeof registerEnrichmentTools>[0], deps)
  return tools
}

/** The registered tool configs (`description` / `inputSchema`), keyed by tool name. */
const capturedConfigs = new Map<string, { readonly inputSchema?: { safeParse(input: unknown): { success: boolean } } }>()

/**
 * Build a minimal `ServerContext`-shaped `extra`, carrying only what
 * `clientNameFromEnvelope` (`tools/enrichment.ts`) reads.
 * @param clientName - the client name to report via the envelope, or omit for none.
 * @returns the fake `extra` second handler argument.
 */
function fakeExtra(clientName?: string): unknown {
  return {
    mcpReq: {
      envelope: clientName !== undefined ? { [CLIENT_INFO_META_KEY]: { name: clientName, version: '1.0' } } : {},
    },
  }
}

/**
 * Call a captured tool directly (below-zod) and parse its JSON response text.
 * @param tools - the captured handlers.
 * @param name - the tool name.
 * @param args - the tool's input.
 * @returns the raw `CallToolResult` and, when present, the parsed first text block.
 */
async function callTool(
  tools: Map<string, Handler>,
  name: string,
  args: unknown,
): Promise<{ readonly result: CallToolResult; readonly body: Record<string, unknown> }> {
  const handler = tools.get(name)
  if (handler === undefined) throw new Error(`tool not registered: ${name}`)
  const result = await handler(args, fakeExtra())
  const block = result.content[0]
  const text = block !== undefined && 'text' in block ? (block as { text: string }).text : undefined
  return { result, body: text !== undefined ? JSON.parse(text) : {} }
}

/**
 * Build the `ServerDeps` a registrar needs, over a corpus — the same construction
 * `main.ts`'s `startup()` performs, minus the posture check (the corpus is already a
 * clean repo).
 * @param corpusRoot - the corpus to serve.
 * @param overrides - `ServerConfig` field overrides.
 * @returns the deps, plus the recorder/core directly for assertions.
 */
function buildDeps(
  corpusRoot: string,
  overrides: Partial<ServerConfig> = {},
): { readonly deps: ServerDeps; readonly recorder: GitTier2Recorder; readonly core: SemanticGroundingCore } {
  const config: ServerConfig = { corpusRoot, agentId: 'analyst-bot', ...overrides }
  const recorder = new GitTier2Recorder({
    corpusRoot,
    agentId: config.agentId,
    lock: { timeoutMs: 2_000, pollIntervalMs: 10 },
    ...config.scopeId !== undefined ? { scopeId: config.scopeId } : {},
  })
  const core = new SemanticGroundingCore({ semanticRoot: corpusRoot })
  core.setTier2Recorder(recorder)
  return { deps: { core, recorder, config }, recorder, core }
}

// ── get_enrichment_work ───────────────────────────────────────────────────

describe('get_enrichment_work', () => {
  it('lists the fixture\'s relation and alt_labels gaps, with no commit', async () => {
    const h = await serve()
    const before = fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()
    const { isError, body } = await call(h, 'get_enrichment_work', {})
    expect(isError).toBe(false)
    const work = body.work as Array<{ target: string; gap: string; work_id: string; prompt: string }>
    expect(work.some(w => w.target === 'dws_order' && w.gap.startsWith('dimension_refs'))).toBe(true)
    expect(work.some(w => w.target === 'dws_order' && w.gap.startsWith('alt_labels'))).toBe(true)
    expect(work.some(w => w.target === 'dim_shop' && w.gap.startsWith('alt_labels'))).toBe(true)
    expect(fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()).toBe(before)
    expect(fixtureGit(['status', '--porcelain'], fixture.root).trim()).toBe('')
  })

  it('honors a tables filter', async () => {
    const h = await serve()
    const { body } = await call(h, 'get_enrichment_work', { tables: ['dim_shop'] })
    const work = body.work as Array<{ target: string }>
    expect(work.every(w => w.target === 'dim_shop')).toBe(true)
    expect(work.length).toBeGreaterThan(0)
  })
})

// ── apply_enrichment ──────────────────────────────────────────────────────

describe('apply_enrichment', () => {
  it('a work_id survives a server restart: a fresh server over the same corpus can still apply it', async () => {
    const first = await serve()
    const listed = await call(first, 'get_enrichment_work', {})
    const item = (listed.body.work as Array<{ target: string; gap: string; work_id: string }>)
      .find(w => w.target === 'dws_order' && w.gap.startsWith('alt_labels'))
    expect(item).toBeDefined()

    // "Restart": a second, independently-constructed harness — new recorder, core,
    // server, and client — over the same corpus, nothing carried over from `first`,
    // proving work_id's self-containment rather than any in-memory cache.
    await first.close()
    const second = await serve()
    const { isError, body } = await call(second, 'apply_enrichment', {
      results: [{ work_id: item!.work_id, text: '["订单宽表"]' }],
      summary: '补充订单宽表别名',
      confidence: 0.9,
    })
    expect(isError).toBe(false)
    const results = body.results as Array<{ work_id: string; target: string; verdict: string }>
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ work_id: item!.work_id, target: 'dws_order', verdict: 'applied' })
    // Full response contract (ADR-0005 ruling 8, inherited by ADR-0006): commit + changed
    // + inline enrichment_health, alongside the per-item verdicts.
    expect(body.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(body.changed).toBe(true)
    expect(body.enrichment_health).toEqual([])
  })

  it('one stale item does not poison the batch — the other still lands, in one commit', async () => {
    const h = await serve()
    const listed = await call(h, 'get_enrichment_work', {})
    const work = listed.body.work as Array<{ target: string; gap: string; work_id: string }>
    const itemOrder = work.find(w => w.target === 'dws_order' && w.gap.startsWith('alt_labels'))
    const itemShop = work.find(w => w.target === 'dim_shop' && w.gap.startsWith('alt_labels'))
    expect(itemOrder).toBeDefined()
    expect(itemShop).toBeDefined()

    // dws_order changes underneath (committed, so the tree is clean when apply runs —
    // an *uncommitted* dirty tree is a different refusal, tested separately below).
    commitExternalEdit(fixture, 'dws_order', { description: 'edited by someone else after issuance' })
    const commitsBefore = Number(fixtureGit(['rev-list', '--count', 'HEAD'], fixture.root).trim())

    const { body } = await call(h, 'apply_enrichment', {
      results: [
        { work_id: itemOrder!.work_id, text: '["订单宽表"]' },
        { work_id: itemShop!.work_id, text: '["店铺维度"]' },
      ],
      summary: '批量补充别名',
      confidence: 0.85,
    })
    const byTarget = Object.fromEntries((body.results as Array<{ target: string; verdict: string }>).map(r => [r.target, r.verdict]))
    expect(byTarget.dws_order).toBe('stale_baseline')
    expect(byTarget.dim_shop).toBe('applied')
    expect(body.changed).toBe(true)

    // Exactly one new commit for the whole batch — the stale rejection added none.
    const commitsAfter = Number(fixtureGit(['rev-list', '--count', 'HEAD'], fixture.root).trim())
    expect(commitsAfter).toBe(commitsBefore + 1)
    const trailers = await h.recorder.readTrailers()
    expect(trailers.Derivation).toBe('llm')
    expect(trailers.Files).toBe('1')
  })

  it('a fully idempotent batch produces no new commit', async () => {
    const h = await serve()
    const listed = await call(h, 'get_enrichment_work', {})
    const item = (listed.body.work as Array<{ target: string; gap: string; work_id: string }>)
      .find(w => w.target === 'dim_shop' && w.gap.startsWith('alt_labels'))
    expect(item).toBeDefined()

    const before = fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()
    // "dim_shop" is the table's own name — excluded from what counts as new, so this
    // resolves to zero genuinely new labels (idempotent), not a write.
    const { body } = await call(h, 'apply_enrichment', {
      results: [{ work_id: item!.work_id, text: '["dim_shop"]' }],
      summary: 'no-op answer',
      confidence: 0.5,
    })
    expect((body.results as Array<{ verdict: string }>)[0]?.verdict).toBe('idempotent')
    expect(body.changed).toBe(false)
    expect(fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()).toBe(before)
    expect(fixtureGit(['status', '--porcelain'], fixture.root).trim()).toBe('')
  })

  it('records the per-request clientInfo as X-SG-Client, not any construction-time value', async () => {
    const h = await serve() // no clientName at construction time
    const listed = await call(h, 'get_enrichment_work', {})
    const item = (listed.body.work as Array<{ target: string; gap: string; work_id: string }>)
      .find(w => w.target === 'dws_order' && w.gap.startsWith('alt_labels'))
    const { body } = await call(h, 'apply_enrichment', {
      results: [{ work_id: item!.work_id, text: '["订单宽表"]' }],
      summary: 'x',
      confidence: 0.5,
    }, 'my-test-client')
    const trailers = await h.recorder.readTrailers(body.commit as string)
    expect(trailers.Client).toBe('my-test-client')
  })

  it('server always overrides derivation to "llm", regardless of batch size', async () => {
    const h = await serve()
    const listed = await call(h, 'get_enrichment_work', {})
    const item = (listed.body.work as Array<{ target: string; gap: string; work_id: string }>)
      .find(w => w.target === 'dws_order' && w.gap.startsWith('alt_labels'))
    const { body } = await call(h, 'apply_enrichment', {
      results: [{ work_id: item!.work_id, text: '["订单宽表"]' }],
      summary: 'single item subject check',
      confidence: 0.7,
    })
    const trailers = await h.recorder.readTrailers(body.commit as string)
    expect(trailers.Derivation).toBe('llm')
    // Single-item subject names the definition (ADR-0006 ruling 5), not a field echo.
    const subject = fixtureGit(['log', '-1', '--format=%s'], fixture.root).trim()
    expect(subject).toBe('apply_enrichment(dws_order): single item subject check')
  })

  it('a dirty worktree refusal surfaces as a coded isError result, not a thrown exception', async () => {
    const h = await serve()
    const listed = await call(h, 'get_enrichment_work', {})
    const item = (listed.body.work as Array<{ target: string; gap: string; work_id: string }>)
      .find(w => w.target === 'dws_order' && w.gap.startsWith('alt_labels'))

    // An *uncommitted* edit — the dirty-tree refusal, distinct from the committed
    // "changed since issuance" case above.
    const p = join(fixture.root, 'tables', 'dws_order.yaml')
    writeFileSync(p, `${readFileSync(p, 'utf8')}\n# uncommitted operator edit\n`, 'utf8')

    const { isError, body } = await call(h, 'apply_enrichment', {
      results: [{ work_id: item!.work_id, text: '["订单宽表"]' }],
      summary: 'x',
      confidence: 0.5,
    })
    expect(isError).toBe(true)
    expect(body.code).toBe(-31004) // posture_refused (#19's segment — reused, not reallocated; errors.ts's own doc)
    expect(body.name).toBe('PostureRefusedError')
    expect(body.retryable).toBe(false)
  })
})

// ── run_enrichment ────────────────────────────────────────────────────────

describe('run_enrichment', () => {
  it('persists the deterministic join, removing it from get_enrichment_work afterward', async () => {
    const h = await serve()
    const before = (await call(h, 'get_enrichment_work', {})).body.work as Array<{ target: string; gap: string }>
    expect(before.some(w => w.target === 'dws_order' && w.gap.startsWith('dimension_refs'))).toBe(true)

    const { isError, body } = await call(h, 'run_enrichment', {})
    expect(isError).toBe(false)
    expect(body.changed).toBe(true)
    expect(body.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(body.enrichment_health).toEqual([])

    const after = (await call(h, 'get_enrichment_work', {})).body.work as Array<{ target: string; gap: string }>
    expect(after.some(w => w.target === 'dws_order' && w.gap.startsWith('dimension_refs'))).toBe(false)
    // alt_labels gaps are untouched by run_enrichment (no model, nothing deterministic
    // to derive there) — they are still exactly where they were.
    expect(after.some(w => w.target === 'dws_order' && w.gap.startsWith('alt_labels'))).toBe(true)

    const trailers = await h.recorder.readTrailers(body.commit as string)
    expect(trailers.Derivation).toBe('deterministic')
  })

  it('a second call with nothing new to find makes no commit', async () => {
    const h = await serve()
    await call(h, 'run_enrichment', {})
    const before = fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()
    const { body } = await call(h, 'run_enrichment', {})
    expect(body.changed).toBe(false)
    expect(fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()).toBe(before)
  })

  it('a tables filter scopes the sweep', async () => {
    const h = await serve()
    const { body } = await call(h, 'run_enrichment', { tables: ['dim_shop'] })
    // dim_shop is a DIM (no dimension_refs field of its own) and has no DIM inventory
    // to join against itself, so a filter naming only it finds nothing to persist.
    expect(body.changed).toBe(false)
  })
})

// ── dimension filters are call-wide (ADR-0007, #31) ──────────────────────────────
//
// #25's incident, pinned: `run_enrichment(tables:["dws_10000251_com_pay_order_df"])`
// committed a subject reading "1 table(s)" over a trailer reading Files=446 — the
// tables filter scoped the tables leg while the events leg, unspecified, swept the
// whole corpus. These tests run on an events-bearing fixture (`withEvents: true`) for
// exactly that reason: on the events-free default fixture, "events were not swept"
// is unfalsifiable (the pre-#31 suite's blind spot — its tables-filter test passed
// green while the spill was live in production).
describe('dimension filter semantics (ADR-0007)', () => {
  it('a tables filter does NOT sweep events — one named table, one file, the event untouched', async () => {
    const f = createFixtureCorpus({ withEvents: true })
    try {
      const h = await serve(f.root)
      const commitsBefore = Number(fixtureGit(['rev-list', '--count', 'HEAD'], f.root).trim())
      const { isError, body } = await call(h, 'run_enrichment', { tables: ['dws_order'] })
      expect(isError).toBe(false)
      expect(body.changed).toBe(true)
      expect(Number(fixtureGit(['rev-list', '--count', 'HEAD'], f.root).trim())).toBe(commitsBefore + 1)
      const trailers = await h.recorder.readTrailers(body.commit as string)
      expect(trailers.Files).toBe('1') // dws_order.yaml only — never events/biz/pay_success.yaml
      // THE pin: the events dimension was out of the call, so its gap is intact.
      const evt = loadEvents(f.root).find(e => e.name === 'pay_success')
      expect(evt?.raw.external_refs).toEqual([])
      // Subject same-source: names the dimension that ran, and only it.
      const subject = fixtureGit(['log', '-1', '--format=%s'], f.root).trim()
      expect(subject.startsWith('run_enrichment(1 table(s)):')).toBe(true)
      // The result reports only the legs that ran (#28's leftover-detail ruling).
      const relation = (body.summary as Record<string, unknown>).relation as Record<string, unknown>
      expect(relation.tables).toBeDefined()
      expect(relation.events).toBeUndefined()
    } finally {
      f.cleanup()
    }
  })

  it('an events filter is the mirror: the table side is never scanned', async () => {
    const f = createFixtureCorpus({ withEvents: true })
    try {
      const h = await serve(f.root)
      const { isError, body } = await call(h, 'run_enrichment', { events: ['pay_success'] })
      expect(isError).toBe(false)
      expect(body.changed).toBe(true)
      const trailers = await h.recorder.readTrailers(body.commit as string)
      expect(trailers.Files).toBe('1') // the event yaml only
      // The table leg never ran: dws_order's relation gap is intact.
      const dws = loadTables(f.root).find(t => t.table_name === 'dws_order')
      expect(dws?.raw.dimension_refs).toEqual([])
      const subject = fixtureGit(['log', '-1', '--format=%s'], f.root).trim()
      expect(subject.startsWith('run_enrichment(1 event(s)):')).toBe(true)
      const relation = (body.summary as Record<string, unknown>).relation as Record<string, unknown>
      expect(relation.events).toBeDefined()
      expect(relation.tables).toBeUndefined()
    } finally {
      f.cleanup()
    }
  })

  it('{} (or no keys) is the one full-corpus shape: both dimensions swept, one commit', async () => {
    const f = createFixtureCorpus({ withEvents: true })
    try {
      const h = await serve(f.root)
      const { body } = await call(h, 'run_enrichment', {})
      expect(body.changed).toBe(true)
      const trailers = await h.recorder.readTrailers(body.commit as string)
      expect(trailers.Files).toBe('2') // dws_order.yaml + events/biz/pay_success.yaml
      const dwsRefs = loadTables(f.root).find(t => t.table_name === 'dws_order')?.raw.dimension_refs
      const evtRefs = loadEvents(f.root).find(e => e.name === 'pay_success')?.raw.external_refs
      expect((dwsRefs as unknown[]).length).toBeGreaterThan(0)
      expect((evtRefs as unknown[]).length).toBeGreaterThan(0)
      const subject = fixtureGit(['log', '-1', '--format=%s'], f.root).trim()
      expect(subject.startsWith('run_enrichment(all definitions):')).toBe(true)
    } finally {
      f.cleanup()
    }
  })

  it('get_enrichment_work honors the same call-wide reading on its index', async () => {
    const f = createFixtureCorpus({ withEvents: true })
    try {
      const h = await serve(f.root)
      const tablesOnly = await call(h, 'get_enrichment_work', { tables: ['dws_order'] })
      const rows = tablesOnly.body.work as Array<{ target: string }>
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every(r => r.target === 'dws_order')).toBe(true)
      expect((tablesOnly.body.total as number)).toBe(rows.length)
      expect(tablesOnly.body.truncated).toBe(false)
      const eventsOnly = await call(h, 'get_enrichment_work', { events: ['pay_success'] })
      expect((eventsOnly.body.work as Array<{ target: string }>).every(r => r.target === 'pay_success')).toBe(true)
      const full = await call(h, 'get_enrichment_work', {})
      const targets = (full.body.work as Array<{ target: string }>).map(r => r.target)
      expect(targets).toContain('dws_order')
      expect(targets).toContain('pay_success')
    } finally {
      f.cleanup()
    }
  })

  it('an unknown filter name is a coded -31040 isError result listing every unknown name, with zero commits', async () => {
    const f = createFixtureCorpus({ withEvents: true })
    try {
      const h = await serve(f.root)
      const headBefore = fixtureGit(['rev-parse', 'HEAD'], f.root).trim()
      for (const tool of ['run_enrichment', 'get_enrichment_work'] as const) {
        const { isError, body } = await call(h, tool, { tables: ['dws_typo_a', 'dws_typo_b'], events: ['evt_typo'] })
        expect(isError).toBe(true)
        expect(body.code).toBe(-31040)
        expect(body.name).toBe('UnknownFilterNameError')
        expect(body.retryable).toBe(false)
        expect(body.message).toContain('dws_typo_a, dws_typo_b')
        expect(body.message).toContain('evt_typo')
        expect((body.data as Record<string, unknown>).unknown_tables).toEqual(['dws_typo_a', 'dws_typo_b'])
        // The door fired before any scan: nothing committed, tree clean.
        expect(fixtureGit(['rev-parse', 'HEAD'], f.root).trim()).toBe(headBefore)
        expect(fixtureGit(['status', '--porcelain'], f.root).trim()).toBe('')
      }
    } finally {
      f.cleanup()
    }
  })

  it('an empty filter array is refused — omitting the key is the only "not in this call" (below-zod, direct handler)', async () => {
    const f = createFixtureCorpus({ withEvents: true })
    try {
      // The retained direct-handler slice: the client path cannot carry `tables: []`
      // past the SDK's zod gate (`min(1)`, pinned against the schema below) — this
      // pin is the door UNDER that gate, the Core method's own refusal.
      const { deps } = buildDeps(f.root)
      const tools = captureTools(deps)
      const { result, body } = await callTool(tools, 'run_enrichment', { tables: [] })
      expect(result.isError).toBe(true)
      expect(body.code).toBe(-31040)
      expect(body.message).toContain('empty dimension filter')
    } finally {
      f.cleanup()
    }
  })
})

// ── zod schema gates: min(1) on filters, the 10-work_id prompt batch cap ─────────

describe('zod schema gates (ADR-0007/0008)', () => {
  it('the shared filter schema refuses empty arrays and accepts named or omitted dimensions', async () => {
    const f = createFixtureCorpus()
    try {
      const { deps } = buildDeps(f.root)
      captureTools(deps)
      const schema = capturedConfigs.get('run_enrichment')?.inputSchema
      expect(schema).toBeDefined()
      expect(schema!.safeParse({}).success).toBe(true)
      expect(schema!.safeParse({ tables: ['dws_order'] }).success).toBe(true)
      expect(schema!.safeParse({ tables: [], events: ['x'] }).success).toBe(false)
      expect(schema!.safeParse({ events: [] }).success).toBe(false)
      // The listing tool shares the very same schema instance — one change, both doors.
      expect(capturedConfigs.get('get_enrichment_work')?.inputSchema).toBe(schema)
    } finally {
      f.cleanup()
    }
  })

  it('get_enrichment_prompts accepts 1–10 work_ids and refuses 0 or 11', async () => {
    const f = createFixtureCorpus()
    try {
      const { deps } = buildDeps(f.root)
      captureTools(deps)
      const schema = capturedConfigs.get('get_enrichment_prompts')?.inputSchema
      expect(schema).toBeDefined()
      const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `ew1.${i}`)
      expect(schema!.safeParse({ work_ids: ids(1) }).success).toBe(true)
      expect(schema!.safeParse({ work_ids: ids(10) }).success).toBe(true)
      expect(schema!.safeParse({ work_ids: ids(11) }).success).toBe(false)
      expect(schema!.safeParse({ work_ids: [] }).success).toBe(false)
    } finally {
      f.cleanup()
    }
  })
})

// ── get_enrichment_prompts (ADR-0008's prompt half) ──────────────────────────────

describe('get_enrichment_prompts', () => {
  it('index → prompts → apply: the split loop end to end, over an event target', async () => {
    const f = createFixtureCorpus({ withEvents: true })
    try {
      const h = await serve(f.root)
      const { body: indexBody } = await call(h, 'get_enrichment_work', {})
      const rows = indexBody.work as Array<{ work_id: string; target: string; gap: string }>
      // Index rows are exactly the ruled shape — no prompt field rides along.
      const row = rows.find(r => r.target === 'pay_success' && r.gap.startsWith('alt_labels'))
      expect(row).toBeDefined()
      expect(Object.keys(row!).sort()).toEqual(['gap', 'target', 'work_id'])

      const { isError, body } = await call(h, 'get_enrichment_prompts', { work_ids: [row!.work_id] })
      expect(isError).toBe(false)
      const prompts = body.prompts as Array<{ work_id: string; target: string; round?: string; verdict: string; prompt?: string }>
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toMatchObject({ work_id: row!.work_id, target: 'pay_success', round: 'alt_labels', verdict: 'fresh' })
      expect(prompts[0]?.prompt).toContain('pay_success')

      const applied = await call(h, 'apply_enrichment', {
        results: [{ work_id: row!.work_id, text: '["支付成功"]' }],
        summary: '补事件别名',
        confidence: 0.8,
      })
      expect((applied.body.results as Array<{ verdict: string }>)[0]?.verdict).toBe('applied')
      expect(loadEvents(f.root).find(e => e.name === 'pay_success')?.raw.alt_labels).toEqual(['支付成功'])
    } finally {
      f.cleanup()
    }
  })

  it('stale and malformed work_ids verdict stale_baseline per item, without prompts', async () => {
    const f = createFixtureCorpus({ withEvents: true })
    try {
      const h = await serve(f.root)
      const { body: indexBody } = await call(h, 'get_enrichment_work', {})
      const rows = indexBody.work as Array<{ work_id: string; target: string; gap: string }>
      const orderRow = rows.find(r => r.target === 'dws_order' && r.gap.startsWith('alt_labels'))!
      const eventRow = rows.find(r => r.target === 'pay_success' && r.gap.startsWith('alt_labels'))!

      // dws_order changes underneath its issued work_id (committed, so the tree is clean).
      commitExternalEdit(f, 'dws_order', { description: 'operator edit after listing' })

      const { body } = await call(h, 'get_enrichment_prompts', {
        work_ids: [orderRow.work_id, eventRow.work_id, 'not-a-work-id'],
      })
      const prompts = body.prompts as Array<{ target: string; verdict: string; prompt?: string }>
      expect(prompts[0]).toMatchObject({ target: 'dws_order', verdict: 'stale_baseline' })
      expect(prompts[0]?.prompt).toBeUndefined()
      expect(prompts[1]).toMatchObject({ target: 'pay_success', verdict: 'fresh' })
      expect(prompts[2]).toMatchObject({ target: '(unknown)', verdict: 'stale_baseline' })
    } finally {
      f.cleanup()
    }
  })
})

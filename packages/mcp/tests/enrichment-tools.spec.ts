/**
 * ADR-0006's three enrichment tools (`get_enrichment_work` / `apply_enrichment` /
 * `run_enrichment`, `src/tools/enrichment.ts`), driven end to end through the real
 * `GitTier2Recorder` + `SemanticGroundingCore` + a real git-backed fixture corpus.
 *
 * These cover ADR-0006's Verification section claims directly: a `work_id` survives a
 * server restart (modeled here as two independently-constructed core/recorder pairs,
 * since that is the entirety of what "restart" means when there is no session state to
 * lose — map #12's own stateless-protocol framing); one stale item in a batch does not
 * poison the others; a fully idempotent batch produces no commit; `apply_enrichment`'s
 * response carries per-item verdict + commit + changed + inline `enrichment_health`;
 * and `run_enrichment` removes deterministically-derivable gaps from the work list.
 *
 * Tool handlers are invoked directly against a minimal fake `McpServer` that only
 * implements `registerTool` (capturing the callback) — the registrar itself is
 * `server-startup.spec.ts`'s "ToolRegistrar seam" tests' job (real process, real wire);
 * this file is about what each handler actually *does*, which is cheaper and more
 * precise to drive in-process while still exercising the real recorder and real git.
 *
 * @see docs/adr/0006-enrichment-agent-driven.md
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLIENT_INFO_META_KEY, type CallToolResult } from '@modelcontextprotocol/server'
import { SemanticGroundingCore, dumpYaml, loadEvents, loadTables } from '@semantic-grounding/substrate'
import type { ServerConfig } from '../src/config.ts'
import { GitTier2Recorder } from '../src/git/recorder.ts'
import type { ServerDeps } from '../src/server.ts'
import { registerEnrichmentTools } from '../src/tools/enrichment.ts'
import { createFixtureCorpus, fixtureGit, type FixtureCorpus } from './helpers/fixture-corpus.ts'

// ── Harness: capture registerTool's callbacks without a real McpServer/transport ────

/** The minimal shape this file needs from a tool handler. */
type Handler = (args: unknown, extra: unknown) => Promise<CallToolResult> | CallToolResult

/**
 * Register the enrichment tool family against a fake server that only implements
 * `registerTool`, capturing each handler by name. The registrar itself is pure
 * registration (`server.ts`'s own contract), so this is a faithful exercise of it.
 *
 * Note the harness calls handlers DIRECTLY with raw args — the SDK's zod
 * `inputSchema` validation does not run on this path (the in-process client and the
 * spawned-process tests cover that seam). That is deliberate: it lets these tests pin
 * the Core-layer door (`unknown_filter_name` for empty/unknown filters reaches the
 * handler intact here) while the schema-level gates (`min(1)`, the prompt batch cap)
 * are pinned against the captured `inputSchema` objects themselves.
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
 * Call a captured tool and parse its JSON response text.
 * @param tools - the captured handlers.
 * @param name - the tool name.
 * @param args - the tool's input.
 * @param clientName - optional per-call client name (ADR-0005's addendum).
 * @returns the raw `CallToolResult` and, when present, the parsed first text block.
 */
async function callTool(
  tools: Map<string, Handler>,
  name: string,
  args: unknown,
  clientName?: string,
): Promise<{ readonly result: CallToolResult; readonly body: Record<string, unknown> }> {
  const handler = tools.get(name)
  if (handler === undefined) throw new Error(`tool not registered: ${name}`)
  const result = await handler(args, fakeExtra(clientName))
  const block = result.content[0]
  const text = block !== undefined && 'text' in block ? (block as { text: string }).text : undefined
  return { result, body: text !== undefined ? JSON.parse(text) : {} }
}

/**
 * Build the `ServerDeps` a registrar needs, over a fixture corpus — the same
 * construction `main.ts`'s `startup()` performs, minus the posture check (the fixture
 * is already a clean repo).
 * @param fixture - the fixture corpus to serve.
 * @param overrides - `ServerConfig` field overrides.
 * @returns the deps, plus the recorder/core directly for assertions.
 */
function buildDeps(
  fixture: FixtureCorpus,
  overrides: Partial<ServerConfig> = {},
): { readonly deps: ServerDeps; readonly recorder: GitTier2Recorder; readonly core: SemanticGroundingCore } {
  const config: ServerConfig = { corpusRoot: fixture.root, agentId: 'analyst-bot', ...overrides }
  const recorder = new GitTier2Recorder({
    corpusRoot: fixture.root,
    agentId: config.agentId,
    lock: { timeoutMs: 2_000, pollIntervalMs: 10 },
    ...config.scopeId !== undefined ? { scopeId: config.scopeId } : {},
  })
  const core = new SemanticGroundingCore({ semanticRoot: fixture.root })
  core.setTier2Recorder(recorder)
  return { deps: { core, recorder, config }, recorder, core }
}

/**
 * Commit a direct edit to a table's YAML — "an operator changed this between issuance
 * and apply", landed as its own commit so the tree is clean afterward (a dirty,
 * *uncommitted* edit would instead trip `assertCleanBeforeWrite`, which is a different
 * scenario this file tests separately).
 * @param fixture - the fixture corpus.
 * @param tableName - the table to edit.
 * @param changes - fields to merge over the table's current raw dict.
 */
function commitExternalEdit(fixture: FixtureCorpus, tableName: string, changes: Record<string, unknown>): void {
  const raw = loadTables(fixture.root).find(t => t.table_name === tableName)?.raw
  if (raw === undefined) throw new Error(`fixture table not found: ${tableName}`)
  const p = join(fixture.root, 'tables', `${tableName}.yaml`)
  writeFileSync(p, dumpYaml({ ...raw, ...changes }), 'utf8')
  fixtureGit(['add', '-A'], fixture.root)
  fixtureGit(['commit', '--quiet', '-m', 'operator edit'], fixture.root)
}

let fixture: FixtureCorpus
beforeEach(() => { fixture = createFixtureCorpus() }) // withDim: true (default) — dws_order + dim_shop, shop_id-joinable
afterEach(() => fixture.cleanup())

// ── get_enrichment_work ───────────────────────────────────────────────────

describe('get_enrichment_work', () => {
  it('lists the fixture\'s relation and alt_labels gaps, with no commit', async () => {
    const { deps } = buildDeps(fixture)
    const tools = captureTools(deps)
    const before = fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()
    const { result, body } = await callTool(tools, 'get_enrichment_work', {})
    expect(result.isError).toBeUndefined()
    const work = body.work as Array<{ target: string; gap: string; work_id: string; prompt: string }>
    expect(work.some(w => w.target === 'dws_order' && w.gap.startsWith('dimension_refs'))).toBe(true)
    expect(work.some(w => w.target === 'dws_order' && w.gap.startsWith('alt_labels'))).toBe(true)
    expect(work.some(w => w.target === 'dim_shop' && w.gap.startsWith('alt_labels'))).toBe(true)
    expect(fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()).toBe(before)
    expect(fixtureGit(['status', '--porcelain'], fixture.root).trim()).toBe('')
  })

  it('honors a tables filter', async () => {
    const { deps } = buildDeps(fixture)
    const tools = captureTools(deps)
    const { body } = await callTool(tools, 'get_enrichment_work', { tables: ['dim_shop'] })
    const work = body.work as Array<{ target: string }>
    expect(work.every(w => w.target === 'dim_shop')).toBe(true)
    expect(work.length).toBeGreaterThan(0)
  })
})

// ── apply_enrichment ──────────────────────────────────────────────────────

describe('apply_enrichment', () => {
  it('a work_id survives a server restart: a freshly-constructed deps pair can still apply it', async () => {
    const first = buildDeps(fixture)
    const toolsBeforeRestart = captureTools(first.deps)
    const { body: workBody } = await callTool(toolsBeforeRestart, 'get_enrichment_work', {})
    const item = (workBody.work as Array<{ target: string; gap: string; work_id: string }>)
      .find(w => w.target === 'dws_order' && w.gap.startsWith('alt_labels'))
    expect(item).toBeDefined()

    // "Restart": brand new core + recorder over the same corpus, nothing carried over
    // from `first` — proving work_id's self-containment rather than any in-memory cache.
    const second = buildDeps(fixture)
    const toolsAfterRestart = captureTools(second.deps)
    const { result, body } = await callTool(toolsAfterRestart, 'apply_enrichment', {
      results: [{ work_id: item!.work_id, text: '["订单宽表"]' }],
      summary: '补充订单宽表别名',
      confidence: 0.9,
    })
    expect(result.isError).toBeUndefined()
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
    const { deps, recorder } = buildDeps(fixture)
    const tools = captureTools(deps)
    const { body: workBody } = await callTool(tools, 'get_enrichment_work', {})
    const work = workBody.work as Array<{ target: string; gap: string; work_id: string }>
    const itemOrder = work.find(w => w.target === 'dws_order' && w.gap.startsWith('alt_labels'))
    const itemShop = work.find(w => w.target === 'dim_shop' && w.gap.startsWith('alt_labels'))
    expect(itemOrder).toBeDefined()
    expect(itemShop).toBeDefined()

    // dws_order changes underneath (committed, so the tree is clean when apply runs —
    // an *uncommitted* dirty tree is a different refusal, tested separately below).
    commitExternalEdit(fixture, 'dws_order', { description: 'edited by someone else after issuance' })
    const commitsBefore = Number(fixtureGit(['rev-list', '--count', 'HEAD'], fixture.root).trim())

    const { body } = await callTool(tools, 'apply_enrichment', {
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
    const trailers = await recorder.readTrailers()
    expect(trailers.Derivation).toBe('llm')
    expect(trailers.Files).toBe('1')
  })

  it('a fully idempotent batch produces no new commit', async () => {
    const { deps } = buildDeps(fixture)
    const tools = captureTools(deps)
    const { body: workBody } = await callTool(tools, 'get_enrichment_work', {})
    const item = (workBody.work as Array<{ target: string; gap: string; work_id: string }>)
      .find(w => w.target === 'dim_shop' && w.gap.startsWith('alt_labels'))
    expect(item).toBeDefined()

    const before = fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()
    // "dim_shop" is the table's own name — excluded from what counts as new, so this
    // resolves to zero genuinely new labels (idempotent), not a write.
    const { body } = await callTool(tools, 'apply_enrichment', {
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
    const { deps, recorder } = buildDeps(fixture) // no clientName at construction time
    const tools = captureTools(deps)
    const { body: workBody } = await callTool(tools, 'get_enrichment_work', {})
    const item = (workBody.work as Array<{ target: string; gap: string; work_id: string }>)
      .find(w => w.target === 'dws_order' && w.gap.startsWith('alt_labels'))
    const { body } = await callTool(
      tools,
      'apply_enrichment',
      { results: [{ work_id: item!.work_id, text: '["订单宽表"]' }], summary: 'x', confidence: 0.5 },
      'my-test-client',
    )
    const trailers = await recorder.readTrailers(body.commit as string)
    expect(trailers.Client).toBe('my-test-client')
  })

  it('server always overrides derivation to "llm", regardless of batch size', async () => {
    const { deps, recorder } = buildDeps(fixture)
    const tools = captureTools(deps)
    const { body: workBody } = await callTool(tools, 'get_enrichment_work', {})
    const item = (workBody.work as Array<{ target: string; gap: string; work_id: string }>)
      .find(w => w.target === 'dws_order' && w.gap.startsWith('alt_labels'))
    const { body } = await callTool(tools, 'apply_enrichment', {
      results: [{ work_id: item!.work_id, text: '["订单宽表"]' }],
      summary: 'single item subject check',
      confidence: 0.7,
    })
    const trailers = await recorder.readTrailers(body.commit as string)
    expect(trailers.Derivation).toBe('llm')
    // Single-item subject names the definition (ADR-0006 ruling 5), not a field echo.
    const subject = fixtureGit(['log', '-1', '--format=%s'], fixture.root).trim()
    expect(subject).toBe('apply_enrichment(dws_order): single item subject check')
  })

  it('a dirty worktree refusal surfaces as a coded isError result, not a thrown exception', async () => {
    const { deps } = buildDeps(fixture)
    const tools = captureTools(deps)
    const { body: workBody } = await callTool(tools, 'get_enrichment_work', {})
    const item = (workBody.work as Array<{ target: string; gap: string; work_id: string }>)
      .find(w => w.target === 'dws_order' && w.gap.startsWith('alt_labels'))

    // An *uncommitted* edit — the dirty-tree refusal, distinct from the committed
    // "changed since issuance" case above.
    const p = join(fixture.root, 'tables', 'dws_order.yaml')
    writeFileSync(p, `${readFileSync(p, 'utf8')}\n# uncommitted operator edit\n`, 'utf8')

    const { result } = await callTool(tools, 'apply_enrichment', {
      results: [{ work_id: item!.work_id, text: '["订单宽表"]' }],
      summary: 'x',
      confidence: 0.5,
    })
    expect(result.isError).toBe(true)
    const block = result.content[0]
    const payload = JSON.parse((block as { text: string }).text) as { code: number; name: string; retryable: boolean }
    expect(payload.code).toBe(-31004) // posture_refused (#19's segment — reused, not reallocated; errors.ts's own doc)
    expect(payload.name).toBe('PostureRefusedError')
    expect(payload.retryable).toBe(false)
  })
})

// ── run_enrichment ────────────────────────────────────────────────────────

describe('run_enrichment', () => {
  it('persists the deterministic join, removing it from get_enrichment_work afterward', async () => {
    const { deps, recorder } = buildDeps(fixture)
    const tools = captureTools(deps)
    const before = (await callTool(tools, 'get_enrichment_work', {})).body.work as Array<{ target: string; gap: string }>
    expect(before.some(w => w.target === 'dws_order' && w.gap.startsWith('dimension_refs'))).toBe(true)

    const { result, body } = await callTool(tools, 'run_enrichment', {})
    expect(result.isError).toBeUndefined()
    expect(body.changed).toBe(true)
    expect(body.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(body.enrichment_health).toEqual([])

    const after = (await callTool(tools, 'get_enrichment_work', {})).body.work as Array<{ target: string; gap: string }>
    expect(after.some(w => w.target === 'dws_order' && w.gap.startsWith('dimension_refs'))).toBe(false)
    // alt_labels gaps are untouched by run_enrichment (no model, nothing deterministic
    // to derive there) — they are still exactly where they were.
    expect(after.some(w => w.target === 'dws_order' && w.gap.startsWith('alt_labels'))).toBe(true)

    const trailers = await recorder.readTrailers(body.commit as string)
    expect(trailers.Derivation).toBe('deterministic')
  })

  it('a second call with nothing new to find makes no commit', async () => {
    const { deps } = buildDeps(fixture)
    const tools = captureTools(deps)
    await callTool(tools, 'run_enrichment', {})
    const before = fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()
    const { body } = await callTool(tools, 'run_enrichment', {})
    expect(body.changed).toBe(false)
    expect(fixtureGit(['rev-parse', 'HEAD'], fixture.root).trim()).toBe(before)
  })

  it('a tables filter scopes the sweep', async () => {
    const { deps } = buildDeps(fixture)
    const tools = captureTools(deps)
    const { body } = await callTool(tools, 'run_enrichment', { tables: ['dim_shop'] })
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
      const { deps, recorder } = buildDeps(f)
      const tools = captureTools(deps)
      const commitsBefore = Number(fixtureGit(['rev-list', '--count', 'HEAD'], f.root).trim())
      const { result, body } = await callTool(tools, 'run_enrichment', { tables: ['dws_order'] })
      expect(result.isError).toBeUndefined()
      expect(body.changed).toBe(true)
      expect(Number(fixtureGit(['rev-list', '--count', 'HEAD'], f.root).trim())).toBe(commitsBefore + 1)
      const trailers = await recorder.readTrailers(body.commit as string)
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
      const { deps, recorder } = buildDeps(f)
      const tools = captureTools(deps)
      const { result, body } = await callTool(tools, 'run_enrichment', { events: ['pay_success'] })
      expect(result.isError).toBeUndefined()
      expect(body.changed).toBe(true)
      const trailers = await recorder.readTrailers(body.commit as string)
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
      const { deps, recorder } = buildDeps(f)
      const tools = captureTools(deps)
      const { body } = await callTool(tools, 'run_enrichment', {})
      expect(body.changed).toBe(true)
      const trailers = await recorder.readTrailers(body.commit as string)
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
      const { deps } = buildDeps(f)
      const tools = captureTools(deps)
      const tablesOnly = await callTool(tools, 'get_enrichment_work', { tables: ['dws_order'] })
      const rows = tablesOnly.body.work as Array<{ target: string }>
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every(r => r.target === 'dws_order')).toBe(true)
      expect((tablesOnly.body.total as number)).toBe(rows.length)
      expect(tablesOnly.body.truncated).toBe(false)
      const eventsOnly = await callTool(tools, 'get_enrichment_work', { events: ['pay_success'] })
      expect((eventsOnly.body.work as Array<{ target: string }>).every(r => r.target === 'pay_success')).toBe(true)
      const full = await callTool(tools, 'get_enrichment_work', {})
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
      const { deps } = buildDeps(f)
      const tools = captureTools(deps)
      const headBefore = fixtureGit(['rev-parse', 'HEAD'], f.root).trim()
      for (const tool of ['run_enrichment', 'get_enrichment_work'] as const) {
        const { result, body } = await callTool(tools, tool, { tables: ['dws_typo_a', 'dws_typo_b'], events: ['evt_typo'] })
        expect(result.isError).toBe(true)
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

  it('an empty filter array is refused — omitting the key is the only "not in this call"', async () => {
    const f = createFixtureCorpus({ withEvents: true })
    try {
      const { deps } = buildDeps(f)
      const tools = captureTools(deps)
      // The direct-handler path carries [] straight to the Core door (the SDK's zod
      // gate refuses it earlier on the wire — pinned below against the schema).
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
      const { deps } = buildDeps(f)
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
      const { deps } = buildDeps(f)
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
      const { deps } = buildDeps(f)
      const tools = captureTools(deps)
      const { body: indexBody } = await callTool(tools, 'get_enrichment_work', {})
      const rows = indexBody.work as Array<{ work_id: string; target: string; gap: string }>
      // Index rows are exactly the ruled shape — no prompt field rides along.
      const row = rows.find(r => r.target === 'pay_success' && r.gap.startsWith('alt_labels'))
      expect(row).toBeDefined()
      expect(Object.keys(row!).sort()).toEqual(['gap', 'target', 'work_id'])

      const { result, body } = await callTool(tools, 'get_enrichment_prompts', { work_ids: [row!.work_id] })
      expect(result.isError).toBeUndefined()
      const prompts = body.prompts as Array<{ work_id: string; target: string; round?: string; verdict: string; prompt?: string }>
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toMatchObject({ work_id: row!.work_id, target: 'pay_success', round: 'alt_labels', verdict: 'fresh' })
      expect(prompts[0]?.prompt).toContain('pay_success')

      const applied = await callTool(tools, 'apply_enrichment', {
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
      const { deps } = buildDeps(f)
      const tools = captureTools(deps)
      const { body: indexBody } = await callTool(tools, 'get_enrichment_work', {})
      const rows = indexBody.work as Array<{ work_id: string; target: string; gap: string }>
      const orderRow = rows.find(r => r.target === 'dws_order' && r.gap.startsWith('alt_labels'))!
      const eventRow = rows.find(r => r.target === 'pay_success' && r.gap.startsWith('alt_labels'))!

      // dws_order changes underneath its issued work_id (committed, so the tree is clean).
      commitExternalEdit(f, 'dws_order', { description: 'operator edit after listing' })

      const { body } = await callTool(tools, 'get_enrichment_prompts', {
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

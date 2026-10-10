/**
 * map #12's end-to-end acceptance gate — Part A of
 * [#23](https://github.com/McKenzieIT/semantic-grounding/issues/23): a scripted MCP
 * client walks the Destination's three steps over the **real deployment seams** and
 * asserts the whole loop is falsifiable.
 *
 * ## What "real seams" means here, and why that is this gate's whole value
 *
 * The 248-test suite drives tools over hand-built deps (`tests/helpers/intent-tools-harness.ts`)
 * with `autoEnrich: false` and no posture check. This script goes through
 * `parseServerConfig` → `startup()` — identity validation, startup posture, recorder
 * construction, `autoEnrich` at its real default (true) — then the same
 * `createServerFactory` `serveStdio` calls. Every ADR-0005/0006 §Verification claim the
 * unit specs already pin per-piece (schema snapshots in `intent-tools-catalog.spec.ts`,
 * recorder mechanics in `git-recorder.spec.ts`) is walked here once more *as one
 * continuous story*, which is what the Destination asks the gate to prove: read →
 * audited write → commit → `git log -p --follow` provenance.
 *
 * ## Shape (ruled in #23, 2026-10-09)
 *
 * A standalone script aligned with substrate's two gates (`check-core-purity.mjs` /
 * `check-tarball-acceptance.mjs`), wired as `pnpm e2e` at the package and the workspace
 * root — the repo's established shape for a named arbiter check. It runs under plain
 * `node` (type stripping, like `bin.ts` and the test helpers), so no build step and no
 * test runner: sequential narrative, one exit code.
 *
 * ## What each phase proves
 *
 * - **Catalog** — all 18 tool names over the wire (detailed schema pinning stays in the
 *   catalog spec; a second copy here would be a maintenance surface with no new claim).
 * - **问数 read path** — the corpus cannot yet answer "订单表怎么关联店铺维表" (no join,
 *   no alias), which is the state that motivates the writes.
 * - **Dimension filters (#31, ADR-0007)** — call-wide semantics on the real seams: the
 *   coded `-31040` unknown-name door (both dimensions' unknowns, one round trip, zero
 *   commits), an events-scoped run leaving the table side untouched, and a
 *   tables-scoped run leaving the event side untouched — #25's 446-file spill, pinned
 *   on an events-bearing corpus (the pre-#31 suite's fixture had no events, which is
 *   exactly why the spill was invisible to it).
 * - **create + deterministic round** — `run_enrichment` absorbs N logical writes into
 *   one commit (Files/Rounds trailers) and empties the deterministic gaps from the work
 *   list (ADR-0006 ruling 6's honesty), after which the read path *can* answer the
 *   scenario.
 * - **update/alias/relation writes** — the `stale_baseline` re-read-retry loop (error
 *   discriminated per #20's ruling: parse the `isError` result's JSON, never
 *   JSON-RPC `error.code`), the idempotent no-commit path, inline `enrichment_health`,
 *   and the **two-commit shape** (agent commit + `enrich_on_write` residue — ADR-0004's
 *   2026-10-09 update) whose merge must preserve the agent's origin-less curated ref
 *   (ADR-0005 ruling 9's preserve-filter regression, riding a round that actually
 *   writes the target).
 * - **LLM half, self-oracle** — the CI client plays the oracle with canned completions
 *   (ADR-0006 ruling 7's gate dividend: no real LLM needed): the full index → prompts →
 *   apply chain over ADR-0008's split (stale reported early at prompt-fetch time), a
 *   work_id issued before a full `startup()` restart still applies (self-containment),
 *   one stale item doesn't poison its batch, an all-nothing batch makes no commit.
 * - **Provenance** — `git log -p --follow` literally executed and asserted: author vs
 *   committer separation, all three Derivation classes, the alias line visible in the
 *   diff of the commit that added it.
 * - **2026-07-28 envelope** — asserted over the *real executable* (`src/bin.ts` over
 *   stdio), because the in-process client path deliberately answers in the 2025-era
 *   result shape (`server.ts` measurement 1); `resultType` + `_meta.serverInfo` are the
 *   markers that prove the era wasn't diluted. `ttlMs`/`cacheScope` are SHOULD-level
 *   cache hints in the revision — their presence is probed and reported, not asserted.
 *
 * @module check-e2e-loop
 */
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dumpYaml, loadTables } from '@semantic-grounding/substrate'
import { parseServerConfig } from '../src/config.ts'
import { startup } from '../src/main.ts'
import { createServerFactory, SERVER_INFO } from '../src/server.ts'
import { INTENT_TOOL_NAMES } from '../src/tools/index.ts'
import { ENRICHMENT_TOOL_NAMES } from '../src/tools/enrichment.ts'
import { buildServer } from '../tests/helpers/intent-tools-harness.ts'
import { createFixtureCorpus, fixtureGit, fixtureTable, type FixtureCorpus } from '../tests/helpers/fixture-corpus.ts'
import { connectInProcess, toolJson, type InProcessClient } from '../tests/helpers/inprocess-client.ts'

/** The writing agent this gate declares at startup — the commit author (ADR-0004 ruling 9). */
const AGENT_ID = 'e2e-gate-agent'
/** The client name sent per-request in the envelope — the X-SG-Client trailer's source. */
const CLIENT_NAME = 'sg-e2e-gate'
/** ADR-0006's three + ADR-0008's fourth (`get_enrichment_prompts`), from the
 * registrar's own name constant — the same single-source rule `tools/index.ts`
 * documents for `INTENT_TOOL_NAMES`. */
const ALL_TOOL_NAMES = [...INTENT_TOOL_NAMES, ...ENRICHMENT_TOOL_NAMES]
/** sha256 hex, the shape of every `version` / `expected_version`. */
const SHA256 = /^[0-9a-f]{64}$/

/** The log sink `startup()` gets: collected, printed only when the gate fails. */
const startupLog: string[] = []

let stepNumber = 0
/** Announce one narrative step; the number doubles as failure context. */
function step(name: string): void {
  stepNumber += 1
  console.log(`[e2e] step ${stepNumber}: ${name}`)
}

/** One work item as `get_enrichment_work` returns it. */
interface WorkItem {
  readonly work_id: string
  readonly target: string
  readonly gap: string
}

/** One per-item verdict as `apply_enrichment` returns them. */
interface Verdict {
  readonly work_id: string
  readonly target: string
  readonly verdict: string
}

/**
 * Call a tool through the in-process client and parse its JSON body.
 *
 * Passes the gate's client name on every call, so every write commit carries
 * `X-SG-Client: sg-e2e-gate` — asserted later via the recorder's own trailer reader.
 */
async function call(client: InProcessClient, name: string, args: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
  return toolJson(await client.callTool(name, args, { name: CLIENT_NAME }))
}

/**
 * Call a tool whose *contract* failure is a coded `isError` result, and return the
 * decoded payload — the discrimination path #20 ruled (`toToolErrorResult` returns
 * rather than throws; the `-31xxx` code lives in the result's JSON text, never on
 * JSON-RPC `error.code`). Asserts exactly that shape on the way in.
 */
async function callCodedError(
  client: InProcessClient,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<{ readonly code: number; readonly name: string; readonly retryable: boolean; readonly message: string }> {
  const response = await client.callTool(name, args, { name: CLIENT_NAME })
  assert.equal(response.error, undefined, `${name} must fail as an isError RESULT, not a JSON-RPC error (#20's ruling)`)
  assert.equal((response.result as { readonly isError?: boolean } | undefined)?.isError, true, `${name} was expected to fail`)
  const payload = toolJson(response) as { code: number; name: string; retryable: boolean; message: string }
  assert.equal(typeof payload.code, 'number', 'coded error payload carries a numeric code')
  return payload
}

/** Read a string field out of a parsed tool body, with the field named in the failure. */
function fieldString(body: Readonly<Record<string, unknown>>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string') {
    throw new Error(`response field "${key}" must be a string, got: ${JSON.stringify(body)}`)
  }
  return value
}

/** The common Tier-2 write parameters every gate write carries (ADR-0005 ruling 7). */
function tier2(summary: string, confidence: number): Readonly<Record<string, unknown>> {
  return { summary, derivation: 'agent', confidence }
}

/** Fixture columns with the `comment` field `TableDefinitionSchema` re-validates on update. */
function columns(...specs: ReadonlyArray<readonly [string, string, string]>): ReadonlyArray<Record<string, unknown>> {
  return specs.map(([name, type, role]) => ({ name, type, role, comment: '' }))
}

/** A schema-valid DIM fixture table (primary key + label columns are load-bearing for the kind's refinement). */
function dimTable(table_name: string, primaryKey: string, labelColumn: string): Record<string, unknown> {
  return fixtureTable({
    table_name,
    kind: 'dim',
    primary_key: [primaryKey],
    label_columns: [labelColumn],
    granularity: '维表(非分区,全量参考,无时间维度)',
    freshness: 'static_reference',
    columns: columns([primaryKey, 'string', 'dimension'], [labelColumn, 'string', 'dimension']),
  })
}

/** Commit a direct YAML edit as "an operator changed this between issuance and apply" — committed, so the tree stays clean. */
function commitExternalEdit(fixture: FixtureCorpus, tableName: string, changes: Readonly<Record<string, unknown>>): void {
  const raw = loadTables(fixture.root).find(t => t.table_name === tableName)?.raw
  assert.ok(raw !== undefined, `fixture table not found: ${tableName}`)
  writeFileSync(join(fixture.root, 'tables', `${tableName}.yaml`), dumpYaml({ ...raw, ...changes }), 'utf8')
  fixtureGit(['add', '-A'], fixture.root)
  fixtureGit(['commit', '--quiet', '-m', 'operator edit between issuance and apply'], fixture.root)
}

/** One booted server: the real startup result plus a connected in-process client. */
interface Boot {
  readonly client: InProcessClient
  /** Tear the client down and dispose the core — "process restart" for a stateless server. */
  shutdown(): Promise<void>
}

/** Boot through the real `startup()` seam and connect one client with all 18 tools. */
async function boot(corpusRoot: string): Promise<Boot> {
  const config = parseServerConfig(['--corpus', corpusRoot, '--agent-id', AGENT_ID, '--scope', 'fixture'], {})
  const result = await startup(config, line => startupLog.push(line))
  const server = await buildServer(createServerFactory(result.deps))
  const client = await connectInProcess(server)
  return {
    client,
    async shutdown() {
      await client.close()
      result.deps.core.dispose()
    },
  }
}

// ── The gate ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // withDim + withEvents: dws_order + joinable dim_shop + pay_success (an event whose
  // shop_id param joins dim_shop) — the events dimension has to be VISIBLE for the
  // dimension-filter phase to prove a tables-scoped call does not sweep it.
  const fixture = createFixtureCorpus({ withEvents: true })
  const root = fixture.root
  const head = (): string => fixtureGit(['rev-parse', 'HEAD'], root).trim()
  const commitCount = (): number => Number(fixtureGit(['rev-list', '--count', 'HEAD'], root).trim())
  const trailersOf = async (commit: string): Promise<Record<string, string>> => {
    // git's own trailer interpolation (the same read path `git/identity.ts` designs for
    // humans), prefix stripped for the same key shape the recorder's readTrailers returns.
    const out = fixtureGit(['log', '-1', '--format=%(trailers:only=true,unfold=true)', commit], root)
    const map: Record<string, string> = {}
    for (const line of out.split('\n')) {
      const sep = line.indexOf(':')
      if (sep <= 0) continue
      map[line.slice(0, sep).replace(/^X-SG-/, '')] = line.slice(sep + 1).trim()
    }
    return map
  }

  let active: Boot | undefined
  try {
    // ── Phase 0 — boot through the real startup seam ────────────────────────────────
    step('startup(): posture check, identity, recorder, core — the deployment shape')
    const boot1 = await boot(root)
    active = boot1
    const client = boot1.client
    assert.equal(fixtureGit(['status', '--porcelain'], root).trim(), '', 'fixture must start clean')

    // ── Phase 1 — catalog over the wire ─────────────────────────────────────────────
    step('tools/list: all nineteen tools (ADR-0005 fifteen + ADR-0006 three + ADR-0008 one)')
    {
      const listed = (await client.listTools()).result?.['tools'] as Array<{ name: string; description?: string; inputSchema?: { type?: string } }>
      assert.deepEqual(listed.map(t => t.name).sort(), [...ALL_TOOL_NAMES].sort(), 'exactly the ruled tool surface')
      for (const tool of listed) {
        assert.equal(tool.inputSchema?.type, 'object', `${tool.name} advertises an object inputSchema`)
        assert.ok(typeof tool.description === 'string' && tool.description.length > 0, `${tool.name} has a description (schema is prompt)`)
      }
    }

    // ── Phase 2 — 问数 read path: the corpus cannot answer it yet ────────────────────
    step('read path: no alias, no join yet — the scenario the writes will fix')
    {
      const aliasBefore = await call(client, 'resolve_alias', { term: '订单宽表' })
      assert.deepEqual(aliasBefore['node_ids'], [], 'an unknown alias resolves to an empty list, not an error')

      const search = await call(client, 'search_definitions', { query: 'order' })
      const hits = search['hits'] as Array<{ id: string; score: number }>
      assert.ok(hits !== undefined && hits.length > 0, 'search finds something for "order"')
      assert.equal(hits[0]?.id, 'dws_order', 'the exact-substring bonus ranks dws_order first')

      const got = await call(client, 'get_definition', { kind: 'table', name: 'dws_order' })
      assert.match(fieldString(got, 'version'), SHA256, 'get_definition is the only tool returning the fingerprint')
      const def = got['definition'] as Record<string, unknown>
      assert.deepEqual(def['dimension_refs'], [], 'no join derived yet')

      const path = await call(client, 'get_join_path', { from: 'dws_order', to: 'dim_shop' })
      assert.equal(path['found'], false, 'unreachable is a result (path:null), not an error')
      assert.equal(path['path'], null)
      const related = await call(client, 'get_relations', { target: 'dws_order' })
      assert.deepEqual(related['relations'], [], 'no relations yet')
    }


    // ── Phase 2.5 — dimension filters: call-wide, door-rejected (#31, ADR-0007) ────
    step('dimension filter door: unknown names -> coded -31040, both dimensions listed, zero commits')
    {
      const before = commitCount()
      const rejected = await callCodedError(client, 'run_enrichment', { tables: ['dws_nope'], events: ['evt_nope_a', 'evt_nope_b'] })
      assert.equal(rejected.code, -31040, 'unknown_filter_name (the enrichment segment\'s first allocation)')
      assert.equal(rejected.name, 'UnknownFilterNameError')
      assert.equal(rejected.retryable, false)
      assert.ok(rejected.message.includes('dws_nope') && rejected.message.includes('evt_nope_a, evt_nope_b'),
        `the door lists BOTH dimensions' unknown names in one round trip: ${rejected.message}`)
      assert.equal(commitCount(), before, 'the door fires before any scan — nothing committed')

      const rejectedRead = await callCodedError(client, 'get_enrichment_work', { tables: ['dws_nope'] })
      assert.equal(rejectedRead.code, -31040, 'the read side shares the door — no silently empty index for a typo')
    }

    step('run_enrichment(events:[...]) sweeps only the event; run_enrichment(tables:[...]) only the table')
    {
      // The mirror pair, each on the pristine corpus: the named leg writes exactly one
      // file, the unnamed dimension is untouched on disk.
      const before = commitCount()
      const evRun = await call(client, 'run_enrichment', { events: ['pay_success'] })
      assert.equal(evRun['changed'], true)
      assert.equal(commitCount(), before + 1)
      assert.equal((await trailersOf(fieldString(evRun, 'commit')))['Files'], '1', 'only events/biz/pay_success.yaml')
      const orderAfterEvRun = (await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }))['definition'] as Record<string, unknown>
      assert.deepEqual(orderAfterEvRun['dimension_refs'], [], 'the tables leg never ran — the #25 spill, inverted and pinned')
      const evSubject = fixtureGit(['log', '-1', '--format=%s'], root).trim()
      assert.ok(evSubject.startsWith('run_enrichment(1 event(s)):'), `subject names the dimension that ran: ${evSubject}`)
      assert.ok(!evSubject.includes('table'), 'and never the one that did not')
      const evSummary = (evRun['summary'] as Record<string, unknown>)['relation'] as Record<string, unknown>
      assert.ok(evSummary['events'] !== undefined && evSummary['tables'] === undefined, 'the result reports only the legs that ran')

      // The tables-scoped mirror on the still-gapped dws_order: the tables leg runs,
      // the events leg does not — pay_success's alt_labels gap (which no deterministic
      // round can fill) survives exactly as it was. #25's incident inverted and pinned:
      // one named table, one file, the event side untouched.
      const beforeT = commitCount()
      const tRun = await call(client, 'run_enrichment', { tables: ['dws_order'] })
      assert.equal(tRun['changed'], true)
      assert.equal(commitCount(), beforeT + 1)
      assert.equal((await trailersOf(fieldString(tRun, 'commit')))['Files'], '1', 'only tables/dws_order.yaml')
      const evtAfter = (await call(client, 'get_definition', { kind: 'event', name: 'pay_success' }))['definition'] as Record<string, unknown>
      assert.deepEqual(evtAfter['alt_labels'], [], 'the events dimension was out of the call — its gap is intact')
      assert.ok(((evtAfter['external_refs'] as unknown[]) ?? []).length > 0, 'and the refs the events run DID fill are still there')
      const tSubject = fixtureGit(['log', '-1', '--format=%s'], root).trim()
      assert.ok(tSubject.startsWith('run_enrichment(1 table(s)):'), `subject names the dimension that ran: ${tSubject}`)
      assert.ok(!tSubject.includes('event'), 'and never the one that did not')
      const tSummary = (tRun['summary'] as Record<string, unknown>)['relation'] as Record<string, unknown>
      assert.ok(tSummary['tables'] !== undefined && tSummary['events'] === undefined, 'the result reports only the legs that ran')
    }

    // ── Phase 3 — create + deterministic round ──────────────────────────────────────
    step('create_definition(dws_pay_flow): one audited commit, no on-write hook')
    let payFlowCommit: string
    {
      const before = commitCount()
      const created = await call(client, 'create_definition', {
        kind: 'table',
        table: fixtureTable({
          table_name: 'dws_pay_flow',
          kind: 'dws',
          columns: columns(['shop_id', 'string', 'dimension'], ['pay_amt', 'double', 'measure']),
        }),
        ...tier2('新表首次落地：支付流水明细', 0.9),
      })
      assert.equal(created['changed'], true)
      payFlowCommit = fieldString(created, 'commit')
      assert.match(payFlowCommit, /^[0-9a-f]{40}$/)
      assert.equal(commitCount(), before + 1, 'create compiles to the write primitive — exactly one commit, no enrichment residue')
      assert.equal((await trailersOf(payFlowCommit))['Tool'], 'create_definition')
    }

    step('run_enrichment: N logical writes absorbed into one deterministic commit (Files/Rounds)')
    {
      const before = commitCount()
      const run = await call(client, 'run_enrichment', {})
      assert.equal(run['changed'], true)
      assert.deepEqual(run['enrichment_health'], [], 'healthy round reports no failures inline')
      const runCommit = fieldString(run, 'commit')
      assert.equal(commitCount(), before + 1, 'ONE commit for the whole full sweep (beginBatch absorption)')
      const trailers = await trailersOf(runCommit)
      assert.equal(trailers['Tool'], 'run_enrichment')
      assert.equal(trailers['Derivation'], 'deterministic')
      // Phase 2.5 already filled dws_order and pay_success; {} sweeps everything, so
      // this commit carries exactly the still-gapped file: dws_pay_flow.yaml. Rounds
      // is leg-level, not file-level: the full sweep's events leg re-derives
      // pay_success's already-correct external_refs (origin-aware replace recomputes
      // the same refs, written+=1, but the bytes on disk do not change, so it never
      // reaches Files) alongside the tables leg's genuine first-time dws_pay_flow
      // join — two record() calls, one real file.
      assert.equal(trailers['Files'], '1', 'dws_pay_flow.yaml — the only still-gapped definition')
      assert.equal(trailers['Rounds'], '2', 'the table relation round (dws_pay_flow, new) + the event relation round (pay_success, re-derived no-op)')

      const work = (await call(client, 'get_enrichment_work', {}))['work'] as WorkItem[]
      assert.ok(work.every(w => !w.gap.startsWith('dimension_refs')), 'work list is honest: no deterministic-derivable gaps remain (ADR-0006 ruling 6)')
      assert.ok(work.some(w => w.gap.startsWith('alt_labels')), 'LLM work remains (deterministic round cannot fill aliases)')

      // The read path can now answer the 问数 scenario.
      const path = await call(client, 'get_join_path', { from: 'dws_order', to: 'dim_shop' })
      assert.equal(path['found'], true, 'the derived join is now walkable')
      const walked = path['path'] as string[]
      assert.ok(walked.includes('dws_order') && walked.includes('dim_shop'), `join path spans both ends: ${JSON.stringify(walked)}`)
      const related = await call(client, 'get_relations', { target: 'dws_order' })
      assert.ok(((related['relations'] as unknown[])).length > 0, 'dws_order has relations now')
      const payFlow = (await call(client, 'get_definition', { kind: 'table', name: 'dws_pay_flow' }))['definition'] as Record<string, unknown>
      const refs = payFlow['dimension_refs'] as Array<{ dim_table: string }>
      assert.ok(refs?.some(r => r.dim_table === 'dim_shop'), 'deterministic round filled dws_pay_flow→dim_shop')
    }

    // ── Phase 4 — update / alias / relation writes ─────────────────────────────────
    step('update_definition + stale_baseline: coded isError result, re-read, retry succeeds')
    {
      const v1 = fieldString(await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }), 'version')
      const updated = await call(client, 'update_definition', {
        kind: 'table', name: 'dws_order',
        fields: { description: '订单域宽表：按日聚合计单与支付' },
        expected_version: v1,
        ...tier2('补业务描述', 0.85),
      })
      assert.equal(updated['changed'], true)
      assert.ok(Array.isArray(updated['enrichment_health']), 'table write responses inline enrichment_health (ADR-0005 ruling 8)')

      const stale = await callCodedError(client, 'update_definition', {
        kind: 'table', name: 'dws_order',
        fields: { description: 'written against a dead baseline' },
        expected_version: v1, // the pre-update fingerprint — dead now
        ...tier2('stale on purpose', 0.5),
      })
      assert.equal(stale.code, -31002, 'stale_baseline')
      assert.equal(stale.retryable, true, 'the one retryable error: re-read and retry')
      assert.equal(stale.name, 'StaleBaselineRejection')

      const v2 = fieldString(await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }), 'version')
      assert.notEqual(v2, v1, 'the re-read picks up a fresh fingerprint')
      const retried = await call(client, 'update_definition', {
        kind: 'table', name: 'dws_order',
        fields: { description: '订单域宽表：按日聚合计单与支付（重试后落盘）' },
        expected_version: v2,
        ...tier2('stale 后重读重试', 0.85),
      })
      assert.equal(retried['changed'], true, 'the retry loop closes')
    }

    step('add_alias: commit + 问数 answered; the repeat is a no-commit idempotent no-op')
    {
      const v3 = fieldString(await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }), 'version')
      const added = await call(client, 'add_alias', {
        kind: 'table', name: 'dws_order', alias: '订单宽表',
        expected_version: v3,
        ...tier2('添加别名「订单宽表」', 0.9),
      })
      assert.equal(added['changed'], true)
      assert.ok(Array.isArray(added['enrichment_health']))
      const resolved = await call(client, 'resolve_alias', { term: '订单宽表' })
      assert.ok(((resolved['node_ids'] as string[]) ?? []).includes('dws_order'), 'the 问数 scenario now resolves its alias')

      const v4 = fieldString(await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }), 'version')
      const before = commitCount()
      const repeat = await call(client, 'add_alias', {
        kind: 'table', name: 'dws_order', alias: '订单宽表',
        expected_version: v4,
        ...tier2('重复添加同一别名', 0.9),
      })
      assert.equal(repeat['changed'], false, 'idempotent no-op reports changed:false')
      assert.equal(commitCount(), before, 'and produces no commit (ADR-0005 ruling 8)')
    }

    step('add_relation(dws_order→dim_region): agent-asserted ref with origin omitted (curated)')
    {
      const created = await call(client, 'create_definition', {
        kind: 'table',
        table: dimTable('dim_region', 'region_id', 'region_name'),
        ...tier2('新维度表：区域', 0.9),
      })
      assert.equal(created['changed'], true)

      const v5 = fieldString(await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }), 'version')
      const related = await call(client, 'add_relation', {
        kind: 'table', name: 'dws_order',
        relation: { dim_table: 'dim_region', join_keys: [{ dws_column: 'region_id', dim_column: 'region_id' }] },
        expected_version: v5,
        ...tier2('订单表挂区域维度（业务口径）', 0.8),
      })
      assert.equal(related['changed'], true)
      const trailers = await trailersOf(fieldString(related, 'commit'))
      assert.equal(trailers['Tool'], 'add_relation')
      assert.equal(trailers['Derivation'], 'agent')
    }

    step('two-commit shape: agent write + enrich_on_write residue, curated ref survives the merge')
    {
      // dim_pay's primary key matches dws_order.pay_amt, so the on-write hook (real
      // startup leaves autoEnrich on) has something to derive on the next meta write.
      const created = await call(client, 'create_definition', {
        kind: 'table',
        table: dimTable('dim_pay', 'pay_amt', 'pay_name'),
        ...tier2('新维度表：支付方式', 0.9),
      })
      assert.equal(created['changed'], true)

      const v6 = fieldString(await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }), 'version')
      const before = commitCount()
      const updated = await call(client, 'update_definition', {
        kind: 'table', name: 'dws_order',
        fields: { description: '订单域宽表：触发派生残留的更新' },
        expected_version: v6,
        ...tier2('再补一版描述', 0.85),
      })
      assert.equal(updated['changed'], true)
      assert.equal(commitCount(), before + 2, 'one agent write, two commits (ADR-0004 2026-10-09 addendum ①)')
      const agentCommit = fieldString(updated, 'commit')
      assert.equal(agentCommit, fixtureGit(['rev-parse', 'HEAD~1'], root).trim(), 'the response names the agent commit; the residue landed after it')
      assert.equal((await trailersOf(agentCommit))['Tool'], 'update_definition')
      const residue = await trailersOf(head())
      assert.equal(residue['Tool'], 'enrich_on_write', 'derived residue gets its own honest commit, never folded')
      assert.equal(residue['Derivation'], 'deterministic')

      const def = (await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }))['definition'] as Record<string, unknown>
      const refs = def['dimension_refs'] as Array<{ dim_table: string }>
      const names = refs?.map(r => r.dim_table) ?? []
      assert.ok(names.includes('dim_shop'), 'round-1 derived ref still there')
      assert.ok(names.includes('dim_region'), 'agent-asserted origin-less ref survived the merge (preserve-filter, ADR-0005 ruling 9)')
      assert.ok(names.includes('dim_pay'), 'the residue round added its own derivation')

      // The on-write hook only sweeps the *written* table; the full sweep sees the
      // cross-table derivation it could not (ADR-0006 ruling 6's own rationale — a
      // newly onboarded DIM makes yesterday's tables joinable by name).
      const before2 = commitCount()
      const sweep = await call(client, 'run_enrichment', {})
      assert.equal(sweep['changed'], true, 'dws_pay_flow→dim_pay was waiting for the full sweep')
      const payFlowRefs = ((await call(client, 'get_definition', { kind: 'table', name: 'dws_pay_flow' }))['definition'] as Record<string, unknown>)['dimension_refs'] as Array<{ dim_table: string }>
      assert.ok(payFlowRefs?.some(r => r.dim_table === 'dim_pay'), 'the sweep derived the cross-table join')
      assert.equal(commitCount(), before2 + 1)
      const rerun = await call(client, 'run_enrichment', {})
      assert.equal(rerun['changed'], false, 'and now genuinely nothing is left to derive')
      assert.equal(commitCount(), before2 + 1, 'an idempotent run makes no commit')
    }

    // ── Phase 5 — the LLM half, self-oracle, across a real restart ──────────────────
    step('issue LLM work, walk the index → prompts → apply chain, restart via a second startup(), apply the pre-restart work_id')
    let dimShopStale: WorkItem
    {
      const idx = await call(client, 'get_enrichment_work', {})
      const work = idx['work'] as WorkItem[]
      // ADR-0008's index half: rows are exactly {work_id, target, gap} — no prompt
      // text rides the listing — with the size metadata at the content JSON's top level.
      const sample = work[0] as Record<string, unknown> | undefined
      assert.ok(sample !== undefined && Object.keys(sample).sort().join(',') === 'gap,target,work_id',
        `index rows are gap/target/work_id only, got: ${JSON.stringify(sample)}`)
      assert.equal(idx['total'], work.length, 'total at the content top level')
      assert.equal(idx['truncated'], false, 'small corpus, no truncation')

      const payFlowItem = work.find(w => w.target === 'dws_pay_flow' && w.gap.startsWith('alt_labels'))
      assert.ok(payFlowItem !== undefined, 'dws_pay_flow has an alt_labels gap for the oracle to answer')
      dimShopStale = work.find(w => w.target === 'dim_shop' && w.gap.startsWith('alt_labels')) as WorkItem
      assert.ok(dimShopStale !== undefined, 'dim_shop has one too (it will go stale on purpose)')

      // ADR-0008's prompt half: the question is a separate batched fetch, rebuilt from
      // the current corpus — fetched here BEFORE the restart, applied after it, which
      // double-proves nothing about the loop lives in server memory.
      const promptRes = await call(client, 'get_enrichment_prompts', { work_ids: [payFlowItem.work_id] })
      const prompts = promptRes['prompts'] as Array<{ target: string; verdict: string; prompt?: string }>
      assert.deepEqual(prompts.map(p => [p.target, p.verdict]), [['dws_pay_flow', 'fresh']], 'a fresh work_id verdicts fresh')
      assert.ok(prompts[0]?.prompt?.includes('dws_pay_flow') === true, 'the prompt is the actual question text')

      // "Restart": for a stateless server this is exactly a new process — a fresh
      // startup() over the same corpus, nothing carried over but the corpus and git.
      await active.shutdown()
      const boot2 = await boot(root)
      active = boot2
      const client2 = boot2.client

      const applied = await call(client2, 'apply_enrichment', {
        results: [{ work_id: payFlowItem.work_id, text: '["支付流水"]' }],
        summary: '补充支付流水中文名',
        confidence: 0.8,
      })
      const verdicts = applied['results'] as Verdict[]
      assert.deepEqual(verdicts.map(v => [v.target, v.verdict]), [['dws_pay_flow', 'applied']], 'pre-restart work_id applied post-restart (self-contained)')
      assert.equal(applied['changed'], true)
      assert.ok(Array.isArray(applied['enrichment_health']))
      const trailers = await trailersOf(fieldString(applied, 'commit'))
      assert.equal(trailers['Tool'], 'apply_enrichment')
      assert.equal(trailers['Derivation'], 'llm', 'server-overridden, never client-claimed (ADR-0006 ruling 5)')
      assert.equal(trailers['Confidence'], '0.8')
      const subject = fixtureGit(['log', '-1', '--format=%s'], root).trim()
      assert.equal(subject, 'apply_enrichment(dws_pay_flow): 补充支付流水中文名', 'single-item subject names the definition')
      const def = (await call(client2, 'get_definition', { kind: 'table', name: 'dws_pay_flow' }))['definition'] as Record<string, unknown>
      assert.ok(((def['alt_labels'] as string[]) ?? []).includes('支付流水'), 'the oracle answer landed on disk')
    }

    step('one stale item does not poison the batch; an empty-answer batch makes no commit')
    {
      const client2 = (active as Boot).client
      // dim_shop changes underneath its issued work_id — committed, so the tree stays clean.
      commitExternalEdit(fixture, 'dim_shop', { description: 'operator edit after issuance' })
      // ADR-0008's early-stale ruling: the prompt fetch re-checks the same conditions
      // apply will, so the agent learns "don't bother answering this one" BEFORE
      // spending a completion on it. A malformed work_id gets the same lenient verdict.
      const stalePrompts = (await call(client2, 'get_enrichment_prompts', { work_ids: [dimShopStale.work_id, 'not-a-work-id'] }))['prompts'] as Array<{ target: string; verdict: string; prompt?: string }>
      assert.deepEqual(stalePrompts.map(p => [p.target, p.verdict, p.prompt === undefined]), [
        ['dim_shop', 'stale_baseline', true],
        ['(unknown)', 'stale_baseline', true],
      ], 'stale and malformed work_ids report stale_baseline per item, prompt omitted')
      const work = (await call(client2, 'get_enrichment_work', {}))['work'] as WorkItem[]
      const fresh = work.find(w => w.target === 'dim_region' && w.gap.startsWith('alt_labels'))
      assert.ok(fresh !== undefined, 'dim_region still has its gap — fresh item for the same batch')

      const before = commitCount()
      const batch = await call(client2, 'apply_enrichment', {
        results: [
          { work_id: dimShopStale.work_id, text: '["店铺维度"]' },
          { work_id: fresh.work_id, text: '["区域维度"]' },
        ],
        summary: '批量补别名，一项过期',
        confidence: 0.7,
      })
      const byTarget = new Map(((batch['results'] as Verdict[])).map(v => [v.target, v.verdict]))
      assert.equal(byTarget.get('dim_shop'), 'stale_baseline', 'the edited target is reported, never blindly merged')
      assert.equal(byTarget.get('dim_region'), 'applied', 'its sibling landed anyway')
      assert.equal(batch['changed'], true)
      assert.equal(commitCount(), before + 1, 'one commit for the whole batch — the stale rejection added none')

      // A fully idempotent batch: the fresh dim_shop work item re-issued, answered with
      // the table's own name (nothing new to merge).
      const reissued = ((await call(client2, 'get_enrichment_work', {}))['work'] as WorkItem[]).find(w => w.target === 'dim_shop' && w.gap.startsWith('alt_labels'))
      assert.ok(reissued !== undefined, 'the stale gap re-issues with a fresh fingerprint')
      const noop = await call(client2, 'apply_enrichment', {
        results: [{ work_id: reissued.work_id, text: '["dim_shop"]' }],
        summary: '空答案批次',
        confidence: 0.5,
      })
      assert.equal((noop['results'] as Verdict[])[0]?.verdict, 'idempotent', 'an answer adding nothing new is idempotent, not applied')
      assert.equal(noop['changed'], false)
      assert.equal(commitCount(), before + 1, 'no new commit (ADR-0006 ruling 4)')
    }

    // ── Phase 6 — provenance: git log answers who/when/on-what-basis ───────────────
    step('provenance: git log -p --follow, author vs committer, all three derivations')
    {
      // Author is the declared agent, committer is the server — separable at a glance,
      // and distinct from the fixture's human baseline commit.
      const identities = fixtureGit(['log', '--format=%an|%cn'], root).trim().split('\n')
      assert.ok(identities.every(line => line === `Fixture Human|Fixture Human` || line === `${AGENT_ID}|semantic-grounding-mcp`),
        `agent/server vs human identity split, got: ${JSON.stringify(identities)}`)

      // All three derivation classes exist in the walked history.
      const all = fixtureGit(['log', '--format=%(trailers:key=X-SG-Derivation,valueonly)'], root)
      for (const kind of ['agent', 'deterministic', 'llm']) {
        assert.ok(all.split('\n').map(s => s.trim()).includes(kind), `history records Derivation: ${kind}`)
      }

      // The Destination's literal claim, executed: --follow over one file's whole life.
      const story = fixtureGit(['log', '-p', '--follow', '--', 'tables/dws_pay_flow.yaml'], root)
      assert.ok(story.includes('X-SG-Tool: create_definition') && story.includes('X-SG-Derivation: agent'), 'the create commit carries its basis')
      assert.ok(story.includes('X-SG-Tool: apply_enrichment') && story.includes('X-SG-Derivation: llm'), 'the LLM round carries its basis')
      assert.ok(story.includes(`Author: ${AGENT_ID} <`), 'the author names the agent')
      assert.ok(story.includes('支付流水'), 'the diff shows the value the LLM round added')

      // The per-request client name rode along on every write (ADR-0005's addendum).
      const clientTrailers = fixtureGit(['log', '--format=%(trailers:key=X-SG-Client,valueonly)'], root)
      assert.ok(clientTrailers.split('\n').map(s => s.trim()).includes(CLIENT_NAME), 'X-SG-Client records the calling client')
    }

    // ── Phase 7 — the 2026-07-28 envelope, over the real executable ────────────────
    step('spawn sg-mcp (src/bin.ts): 2026-07-28 envelope markers on a real tools/call')
    {
      const PROTOCOL = 'io.modelcontextprotocol/protocolVersion'
      const CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
      const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
      const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo'

      const child = spawn(process.execPath, ['src/bin.ts', '--corpus', root, '--agent-id', 'envelope-probe'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), // packages/mcp — src/bin.ts and its deps resolve from here
        stdio: ['pipe', 'pipe', 'inherit'],
      })
      if (child.stdout === null || child.stdin === null) throw new Error('spawn failed to provide stdio pipes')
      const stdout = child.stdout
      const stdin = child.stdin
      const response: Promise<Record<string, unknown>> = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('spawned sg-mcp did not answer within 10s')), 10_000)
        let buffer = ''
        stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8')
          const newline = buffer.indexOf('\n')
          if (newline >= 0) {
            const line = buffer.slice(0, newline).trim()
            if (line !== '') {
              clearTimeout(timer)
              resolve(JSON.parse(line) as Record<string, unknown>)
            }
          }
        })
        child.on('error', e => reject(e))
      })
      stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'search_definitions', arguments: { query: 'order' },
          _meta: {
            [PROTOCOL]: '2026-07-28', [CAPABILITIES]: {}, [CLIENT_INFO]: { name: CLIENT_NAME, version: '1.0' },
          },
        },
      })}\n`)
      const answer = await response
      const result = answer['result'] as Record<string, unknown>
      assert.equal(answer['error'], undefined, 'the probe call succeeds')
      assert.equal(result?.['resultType'], 'complete', '2026-07-28 result shape, not the 2025-era one (server.ts measurement 1)')
      const meta = result?.['_meta'] as Record<string, unknown>
      assert.equal((meta?.[SERVER_INFO_KEY] as { name?: string })?.name, SERVER_INFO.name, '_meta.serverInfo present')
      // SHOULD-level cache hints (research §3): probed and reported, not asserted.
      console.log(`[e2e]   envelope probe: ttlMs=${JSON.stringify(result?.['ttlMs'])} cacheScope=${JSON.stringify(result?.['cacheScope'])}`)
      stdin.end()
      const code: number = await new Promise(resolve => child.on('exit', resolve))
      assert.equal(code, 0, 'sg-mcp exits cleanly when the client closes stdin')
    }

    assert.equal(fixtureGit(['status', '--porcelain'], root).trim(), '', 'the corpus tree ends clean — every write committed, nothing swept')
    console.log(`[e2e] PASSED — ${stepNumber} steps, map #12 Destination loop walked end to end`)
  } finally {
    await active?.shutdown()
    fixture.cleanup()
    if (startupLog.length > 0 && process.env['SG_E2E_VERBOSE'] === '1') {
      console.log('[e2e] startup log:', startupLog.join('\n'))
    }
  }
}

main().catch((e: unknown) => {
  console.error(`[e2e] FAILED at step ${stepNumber}`)
  if (startupLog.length > 0) console.error('[e2e] startup log:\n' + startupLog.join('\n'))
  console.error(e)
  process.exitCode = 1
})

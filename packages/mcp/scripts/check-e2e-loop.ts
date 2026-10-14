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
 * - **Catalog** — the full tool catalog over the wire (detailed schema pinning stays in the
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
 * - **suppression: delete doesn't come back** (#38, ADR-0010) — `remove_relation` on a
 *   machine-derived ref vetoes it immediately, and the veto survives not just the
 *   on-write hook but a full `run_enrichment({})` sweep; a curated-but-rederivable ref
 *   takes the "two-step dance" (first removal records no veto and the SAME write's
 *   on-write hook brings it right back machine-derived; the second removal, now seeing
 *   a machine-derived entry, vetoes it for good); `add_relation` lifts a veto either way.
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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseServerConfig } from '../src/config.ts'
import { startup } from '../src/main.ts'
import { createServerFactory, SERVER_INFO } from '../src/server.ts'
import { TOOL_NAMES } from '../src/tools/index.ts'
import { ScopeRegistryFile } from '../src/scope-registry.ts'
import { buildServer, tier2 } from '../tests/helpers/intent-tools-harness.ts'
import { commitExternalEdit, createFixtureCorpus, fixtureGit, fixtureTable } from '../tests/helpers/fixture-corpus.ts'
import { connectInProcess, toolJson, type InProcessClient } from '../tests/helpers/inprocess-client.ts'

/** The writing agent this gate declares at startup — the commit author (ADR-0004 ruling 9). */
const AGENT_ID = 'e2e-gate-agent'
/** The client name sent per-request in the envelope — the X-SG-Client trailer's source. */
const CLIENT_NAME = 'sg-e2e-gate'
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

/** One relation-ref entry read back off disk — just enough shape to find a
 * dim_table and inspect its origin (curated vs machine-derived). */
interface RelationRefLike {
  readonly dim_table: string
  readonly join_keys: unknown
  readonly origin?: string
}

/** One per-item verdict as `remove_alias` / `remove_relation` return them (#38 §2/§3). */
interface RemoveVerdict {
  readonly key: string
  readonly outcome: string
  readonly suppressed: boolean
  readonly reasserted: boolean
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

/** One booted server: the real startup result plus a connected in-process client. */
interface Boot {
  readonly client: InProcessClient
  /** Read a commit's `X-SG-*` trailers through the booted recorder's own read path. */
  readonly trailersOf: (commit: string) => Promise<Record<string, string>>
  /** Tear the client down and dispose the core — "process restart" for a stateless server. */
  shutdown(): Promise<void>
}

/** Boot through the real `startup()` seam — `--registry`/`--scope` (ADR-0011), never the removed `--corpus` — and connect one client over the full tool surface. */
async function boot(opts: { readonly registryPath: string; readonly scopeId?: string; readonly agentId?: string }): Promise<Boot> {
  const args = ['--agent-id', opts.agentId ?? AGENT_ID, '--registry', opts.registryPath]
  if (opts.scopeId !== undefined) args.push('--scope', opts.scopeId)
  const config = parseServerConfig(args, {})
  const result = await startup(config, line => startupLog.push(line))
  const server = await buildServer(createServerFactory(result.deps))
  const client = await connectInProcess(server)
  return {
    client,
    trailersOf: commit => result.deps.bindings.requireSnapshot().recorder.readTrailers(commit),
    async shutdown() {
      await client.close()
      result.deps.bindings.disposeAll()
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

  let active: Boot | undefined
  const registryDir = mkdtempSync(join(tmpdir(), 'sg-e2e-registry-'))
  const registryPath = join(registryDir, 'scopes.yaml')
  try {
    // Registered directly against the registry file (ADR-0011: `register()` runs no
    // posture/load check itself — that is the `register_scope` tool's own door) so
    // Phase 0 proves *startup's own* posture re-check, not the tool's.
    const registry = new ScopeRegistryFile(registryPath)
    await registry.register({ id: 'fixture', semanticRoot: root, name: 'fixture', registeredBy: AGENT_ID })

    // ── Phase 0 — boot through the real startup seam ────────────────────────────────
    step('startup(): posture check, identity, recorder, core — the deployment shape')
    const boot1 = await boot({ registryPath, scopeId: 'fixture' })
    active = boot1
    const client = boot1.client
    assert.equal(fixtureGit(['status', '--porcelain'], root).trim(), '', 'fixture must start clean')

    // ── Phase 1 — catalog over the wire ─────────────────────────────────────────────
    step('tools/list: the full default tool catalog (ADR-0005 intent + ADR-0006/0008 enrichment + ADR-0011 scope + #63 playbook + ADR-0013 import)')
    {
      const listed = (await client.listTools()).result?.['tools'] as Array<{ name: string; description?: string; inputSchema?: { type?: string } }>
      assert.deepEqual(listed.map(t => t.name).sort(), [...TOOL_NAMES].sort(), 'exactly the ruled tool surface')
      for (const tool of listed) {
        assert.equal(tool.inputSchema?.type, 'object', `${tool.name} advertises an object inputSchema`)
        assert.ok(typeof tool.description === 'string' && tool.description.length > 0, `${tool.name} has a description (schema is prompt)`)
      }
    }

    // ── Phase 1.5 — 探索草稿的家 (ADR-0020 / #92) ────────────────────────────────────
    step('scratch home: acquire_scratch_dir lands outside the worktree, junk never dirties posture, and a Tier-2 write still goes through')
    {
      const acquired = await call(client, 'acquire_scratch_dir', {})
      const runId = fieldString(acquired, 'run_id')
      const scratchPath = fieldString(acquired, 'path')
      assert.match(runId, /^[0-9]{8}T[0-9]{6}Z_[0-9a-f]{6}$/, 'run id = UTC stamp + 6-hex nonce')
      assert.equal((acquired['retention'] as Record<string, unknown>)?.['keeps_last'], 3, 'default retention keeps the last three runs')
      const gitDir = fixtureGit(['rev-parse', '--absolute-git-dir'], root).trim()
      assert.equal(scratchPath, join(gitDir, 'sg-scratch', runId), 'the run lives inside the git dir, outside the worktree git tracks')
      // The exploration half: intermediate junk dropped in bash, into the acquired run.
      writeFileSync(join(scratchPath, 'odps-reprobe.sql'), '-- dws_order schema re-probe draft\n')
      writeFileSync(join(scratchPath, 'dws_order.draft.yaml'), 'table_name: dws_order\n')
      assert.equal(fixtureGit(['status', '--porcelain'], root).trim(), '', 'scratch junk is invisible to both clean-worktree gates')
      // The write-back half: a Tier-2 write still lands — no PostureRefusedError. The
      // event kind deliberately: `updateEventMeta` runs no on-write enrichment hook
      // (the event hook remains deferred), so this write derives nothing, and the
      // description carries no bracketed/quoted terms — the deterministic alt-label
      // extractor must find nothing in it (the fixture's own contract for this event).
      const v = fieldString(await call(client, 'get_definition', { kind: 'event', name: 'pay_success' }), 'version')
      const written = await call(client, 'update_definition', {
        scope_id: 'fixture',
        kind: 'event',
        name: 'pay_success',
        fields: { description: '支付成功事件探索草稿后写回' },
        expected_version: v,
        ...tier2('探索草稿后写回', 0.9),
      })
      assert.equal(written['changed'], true, 'the Tier-2 write succeeds with scratch junk on disk')
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
      assert.match(fieldString(got, 'version'), SHA256, 'get_definition returns the fingerprint (since #108, every definition write receipt does too)')
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
      const rejected = await callCodedError(client, 'run_enrichment', { scope_id: 'fixture', tables: ['dws_nope'], events: ['evt_nope_a', 'evt_nope_b'] })
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
      const evRun = await call(client, 'run_enrichment', { scope_id: 'fixture', events: ['pay_success'] })
      assert.equal(evRun['changed'], true)
      assert.equal(commitCount(), before + 1)
      assert.equal((await active.trailersOf(fieldString(evRun, 'commit')))['Files'], '1', 'only events/biz/pay_success.yaml')
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
      const tRun = await call(client, 'run_enrichment', { scope_id: 'fixture', tables: ['dws_order'] })
      assert.equal(tRun['changed'], true)
      assert.equal(commitCount(), beforeT + 1)
      assert.equal((await active.trailersOf(fieldString(tRun, 'commit')))['Files'], '1', 'only tables/dws_order.yaml')
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
      const created = await call(client, 'create_definition', { scope_id: 'fixture',
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
      assert.equal((await active.trailersOf(payFlowCommit))['Tool'], 'create_definition')
    }

    step('run_enrichment: N logical writes absorbed into one deterministic commit (Files/Rounds)')
    {
      const before = commitCount()
      const run = await call(client, 'run_enrichment', { scope_id: 'fixture' })
      assert.equal(run['changed'], true)
      assert.deepEqual(run['enrichment_health'], [], 'healthy round reports no failures inline')
      const runCommit = fieldString(run, 'commit')
      assert.equal(commitCount(), before + 1, 'ONE commit for the whole full sweep (beginBatch absorption)')
      const trailers = await active.trailersOf(runCommit)
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
      const updated = await call(client, 'update_definition', { scope_id: 'fixture',
        kind: 'table', name: 'dws_order',
        fields: { description: '订单域宽表：按日聚合计单与支付' },
        expected_version: v1,
        ...tier2('补业务描述', 0.85),
      })
      assert.equal(updated['changed'], true)
      assert.ok(Array.isArray(updated['enrichment_health']), 'table write responses inline enrichment_health (ADR-0005 ruling 8)')

      const stale = await callCodedError(client, 'update_definition', {
        scope_id: 'fixture',
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
      const retried = await call(client, 'update_definition', { scope_id: 'fixture',
        kind: 'table', name: 'dws_order',
        fields: { description: '订单域宽表：按日聚合计单与支付（重试后落盘）' },
        expected_version: v2,
        ...tier2('stale 后重读重试', 0.85),
      })
      assert.equal(retried['changed'], true, 'the retry loop closes')
    }

    step('add_alias (batch): two labels ONE commit; the receipt\'s version chains the next write with zero read-backs')
    {
      const v3 = fieldString(await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }), 'version')
      const before = commitCount()
      const added = await call(client, 'add_alias', { scope_id: 'fixture',
        kind: 'table', name: 'dws_order', labels: ['订单宽表', '宽表_订单'],
        expected_version: v3,
        ...tier2('批量添加别名「订单宽表」「宽表_订单」', 0.9),
      })
      assert.equal(added['changed'], true)
      assert.ok(Array.isArray(added['enrichment_health']))
      assert.equal(commitCount(), before + 1, 'TWO labels, ONE commit — the same-target batch collapse is visible in git history (#109)')
      assert.deepEqual(
        (added['results'] as Array<Record<string, unknown>>)?.map(r => [r['key'], r['outcome'], r['unsuppressed']]),
        [['订单宽表', 'added', false], ['宽表_订单', 'added', false]],
        'per-row verdicts in input order (#107 Q5)',
      )
      const resolved = await call(client, 'resolve_alias', { term: '订单宽表' })
      assert.ok(((resolved['node_ids'] as string[]) ?? []).includes('dws_order'), 'the 问数 scenario now resolves its alias')

      // #107 Q7 invariant ②: the receipt's version IS the next write's
      // baseline — no get_definition between the writes; the loop closes on
      // receipts alone, and a no-op receipt still names the current
      // fingerprint.
      const receiptV = fieldString(added, 'version')
      assert.match(receiptV, SHA256)
      const before2 = commitCount()
      const repeat = await call(client, 'add_alias', { scope_id: 'fixture',
        kind: 'table', name: 'dws_order', labels: ['订单宽表'],
        expected_version: receiptV,
        ...tier2('重复添加同一别名', 0.9),
      })
      assert.equal(repeat['changed'], false, 'idempotent no-op reports changed:false')
      assert.equal(commitCount(), before2, 'and produces no commit (ADR-0005 ruling 8)')
      assert.equal(fieldString(repeat, 'version'), receiptV, 'the no-op receipt names the file\'s current fingerprint')
    }

    step('add_relation(dws_order→dim_region): agent-asserted ref with origin omitted (curated)')
    {
      const created = await call(client, 'create_definition', { scope_id: 'fixture',
        kind: 'table',
        table: dimTable('dim_region', 'region_id', 'region_name'),
        ...tier2('新维度表：区域', 0.9),
      })
      assert.equal(created['changed'], true)

      const v5 = fieldString(await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }), 'version')
      const related = await call(client, 'add_relation', { scope_id: 'fixture',
        kind: 'table', name: 'dws_order',
        relations: [{ dim_table: 'dim_region', join_keys: [{ dws_column: 'region_id', dim_column: 'region_id' }] }],
        expected_version: v5,
        ...tier2('订单表挂区域维度（业务口径）', 0.8),
      })
      assert.equal(related['changed'], true)
      const trailers = await active.trailersOf(fieldString(related, 'commit'))
      assert.equal(trailers['Tool'], 'add_relation')
      assert.equal(trailers['Derivation'], 'agent')
    }

    step('two-commit shape: agent write + enrich_on_write residue, curated ref survives the merge')
    {
      // dim_pay's primary key matches dws_order.pay_amt, so the on-write hook (real
      // startup leaves autoEnrich on) has something to derive on the next meta write.
      const created = await call(client, 'create_definition', { scope_id: 'fixture',
        kind: 'table',
        table: dimTable('dim_pay', 'pay_amt', 'pay_name'),
        ...tier2('新维度表：支付方式', 0.9),
      })
      assert.equal(created['changed'], true)

      const v6 = fieldString(await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }), 'version')
      const before = commitCount()
      const updated = await call(client, 'update_definition', { scope_id: 'fixture',
        kind: 'table', name: 'dws_order',
        fields: { description: '订单域宽表：触发派生残留的更新' },
        expected_version: v6,
        ...tier2('再补一版描述', 0.85),
      })
      assert.equal(updated['changed'], true)
      assert.equal(commitCount(), before + 2, 'one agent write, two commits (ADR-0004 2026-10-09 addendum ①)')
      const agentCommit = fieldString(updated, 'commit')
      assert.equal(agentCommit, fixtureGit(['rev-parse', 'HEAD~1'], root).trim(), 'the response names the agent commit; the residue landed after it')
      assert.equal((await active.trailersOf(agentCommit))['Tool'], 'update_definition')
      const residue = await active.trailersOf(head())
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
      const sweep = await call(client, 'run_enrichment', { scope_id: 'fixture' })
      assert.equal(sweep['changed'], true, 'dws_pay_flow→dim_pay was waiting for the full sweep')
      const payFlowRefs = ((await call(client, 'get_definition', { kind: 'table', name: 'dws_pay_flow' }))['definition'] as Record<string, unknown>)['dimension_refs'] as Array<{ dim_table: string }>
      assert.ok(payFlowRefs?.some(r => r.dim_table === 'dim_pay'), 'the sweep derived the cross-table join')
      assert.equal(commitCount(), before2 + 1)
      const rerun = await call(client, 'run_enrichment', { scope_id: 'fixture' })
      assert.equal(rerun['changed'], false, 'and now genuinely nothing is left to derive')
      assert.equal(commitCount(), before2 + 1, 'an idempotent run makes no commit')
    }

    // ── Phase 4.5 — suppression: delete doesn't come back (#38, ADR-0010) ──────────
    step('remove_relation vetoes a machine-derived ref; a full sweep (not just the on-write hook) still respects it; add_relation lifts it')
    {
      const before1 = (await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }))['definition'] as Record<string, unknown>
      const payRef = (before1['dimension_refs'] as RelationRefLike[]).find(r => r.dim_table === 'dim_pay')
      assert.ok(payRef !== undefined, 'dim_pay is on dws_order from the residue round')
      assert.equal(payRef.origin, 'deterministic', 'precondition: this ref is machine-derived, not curated')

      const v1 = fieldString(await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }), 'version')
      const removed = await call(client, 'remove_relation', { scope_id: 'fixture',
        kind: 'table', name: 'dws_order',
        relations: [{ dim_table: 'dim_pay', join_keys: payRef.join_keys }],
        expected_version: v1,
        ...tier2('下线订单表到支付方式维度的关联', 0.9),
      })
      assert.equal(removed['changed'], true)
      assert.deepEqual(removed['results'] as RemoveVerdict[], [{ key: 'dim_pay', outcome: 'removed', suppressed: true, reasserted: false }],
        'machine-derived removal vetoes immediately — the on-write hook (same write) does not bring it back')

      const afterRemove = (await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }))['definition'] as Record<string, unknown>
      assert.ok(!(afterRemove['dimension_refs'] as RelationRefLike[]).some(r => r.dim_table === 'dim_pay'), 'dim_pay gone from the content array')
      assert.ok((afterRemove['suppressed_dimension_refs'] as string[]).includes('dim_pay'), 'dim_pay recorded in the veto array')

      // The real "delete doesn't come back" proof: not just the on-write hook — a FULL
      // sweep over the whole corpus, which would otherwise rediscover dim_pay by its
      // still-matching column name, also respects the veto (shared relationVetoSet
      // filter inside enrichAllDwsTables, #38 slice 3).
      const beforeSweep = commitCount()
      const sweep = await call(client, 'run_enrichment', { scope_id: 'fixture' })
      assert.equal(sweep['changed'], false, 'nothing left to derive — the veto, not an accident of scope, is why')
      assert.equal(commitCount(), beforeSweep, 'and therefore no commit')
      const afterSweep = (await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }))['definition'] as Record<string, unknown>
      assert.ok(!(afterSweep['dimension_refs'] as RelationRefLike[]).some(r => r.dim_table === 'dim_pay'), 'dim_pay still absent after a full sweep')

      // Adding it back lifts the veto (#37 §5).
      const v2 = fieldString(await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }), 'version')
      const readded = await call(client, 'add_relation', { scope_id: 'fixture',
        kind: 'table', name: 'dws_order',
        relations: [{ dim_table: 'dim_pay', join_keys: payRef.join_keys }],
        expected_version: v2,
        ...tier2('恢复订单表到支付方式维度的关联', 0.9),
      })
      assert.equal(readded['changed'], true)
      assert.deepEqual(readded['results'], [{ key: 'dim_pay', outcome: 'added', unsuppressed: true }],
        'add_relation reports the veto it lifted in its verdict row (#107 Q5: the top-level key is gone)')
      const afterReadd = (await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }))['definition'] as Record<string, unknown>
      assert.ok((afterReadd['dimension_refs'] as RelationRefLike[]).some(r => r.dim_table === 'dim_pay'), 'dim_pay back on the table')
      assert.ok(!(afterReadd['suppressed_dimension_refs'] as string[]).includes('dim_pay'), 'and its veto lifted')
    }

    step('curated two-step dance: a curated-but-rederivable ref survives one removal (reasserted), the SECOND removal vetoes it for good — even through a full sweep')
    {
      // dws_order gets a new column (channel_id) with no DIM to match it yet, so
      // dim_channel's creation and the column's arrival are sequenced independently —
      // no on-write hook can jump ahead of the curated add_relation below.
      const current = (await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }))['definition'] as Record<string, unknown>
      const v1 = fieldString(await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }), 'version')
      const addedColumn = await call(client, 'update_definition', { scope_id: 'fixture',
        kind: 'table', name: 'dws_order',
        fields: { columns: [...current['columns'] as unknown[], { name: 'channel_id', type: 'string', role: 'dimension', comment: '' }] },
        expected_version: v1,
        ...tier2('订单表新增渠道字段', 0.9),
      })
      assert.equal(addedColumn['changed'], true)

      const created = await call(client, 'create_definition', { scope_id: 'fixture',
        kind: 'table',
        table: dimTable('dim_channel', 'channel_id', 'channel_name'),
        ...tier2('新维度表：渠道', 0.9),
      })
      assert.equal(created['changed'], true)

      // Curated assert: origin omitted. This write's OWN on-write hook will also find
      // dim_channel deterministically (channel_id now matches on both sides) — the
      // merge must keep it curated (the preserve-filter fix, #38 slice 2), or this
      // scenario could never get off the ground.
      const v2 = fieldString(await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }), 'version')
      const relationInput = { dim_table: 'dim_channel', join_keys: [{ dws_column: 'channel_id', dim_column: 'channel_id' }] }
      const curated = await call(client, 'add_relation', { scope_id: 'fixture',
        kind: 'table', name: 'dws_order',
        relations: [relationInput],
        expected_version: v2,
        ...tier2('订单表挂渠道维度（业务口径，先于确定性轮次手动认领）', 0.8),
      })
      assert.equal(curated['changed'], true)
      const afterCurate = (await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }))['definition'] as Record<string, unknown>
      const channelRef1 = (afterCurate['dimension_refs'] as RelationRefLike[]).find(r => r.dim_table === 'dim_channel')
      assert.ok(channelRef1 !== undefined, 'dim_channel attached')
      assert.equal(channelRef1.origin, undefined, 'stays curated through its own on-write hook (the collision this scenario needs)')

      // First removal: present, curated (not machine-derived) -> no veto. But the SAME
      // write's on-write hook deterministically rediscovers it (channel_id still
      // matches) -> reasserted:true. This is the dance's first step.
      const v3 = fieldString(await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }), 'version')
      const firstRemoval = await call(client, 'remove_relation', { scope_id: 'fixture',
        kind: 'table', name: 'dws_order',
        relations: [relationInput],
        expected_version: v3,
        ...tier2('移除渠道维度关联（第一次）', 0.7),
      })
      assert.deepEqual(firstRemoval['results'] as RemoveVerdict[], [{ key: 'dim_channel', outcome: 'removed', suppressed: false, reasserted: true }],
        'curated removal records no veto; the deterministic round brings it right back in the same write')

      const afterFirst = (await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }))['definition'] as Record<string, unknown>
      const channelRef2 = (afterFirst['dimension_refs'] as RelationRefLike[]).find(r => r.dim_table === 'dim_channel')
      assert.ok(channelRef2 !== undefined, 'dim_channel is back')
      assert.equal(channelRef2.origin, 'deterministic', 'this time it came back machine-derived, not curated')

      // Second removal: now present AND machine-derived -> vetoes for good.
      const v4 = fieldString(await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }), 'version')
      const secondRemoval = await call(client, 'remove_relation', { scope_id: 'fixture',
        kind: 'table', name: 'dws_order',
        relations: [relationInput],
        expected_version: v4,
        ...tier2('移除渠道维度关联（第二次，坐实否决）', 0.7),
      })
      assert.deepEqual(secondRemoval['results'] as RemoveVerdict[], [{ key: 'dim_channel', outcome: 'removed', suppressed: true, reasserted: false }],
        'the second removal catches it machine-derived -> vetoes it, and this time the on-write hook honors the veto')

      // Full-sweep proof, not just the on-write hook.
      const beforeSweep = commitCount()
      const sweep = await call(client, 'run_enrichment', { scope_id: 'fixture' })
      assert.equal(sweep['changed'], false, 'the full sweep finds nothing to do — dim_channel stays vetoed')
      assert.equal(commitCount(), beforeSweep)
      const afterSweep = (await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }))['definition'] as Record<string, unknown>
      assert.ok(!(afterSweep['dimension_refs'] as RelationRefLike[]).some(r => r.dim_table === 'dim_channel'), 'dim_channel absent after a full sweep')
      assert.ok((afterSweep['suppressed_dimension_refs'] as string[]).includes('dim_channel'), 'the veto is on record')

      // Lift it.
      const v5 = fieldString(await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }), 'version')
      const relifted = await call(client, 'add_relation', { scope_id: 'fixture',
        kind: 'table', name: 'dws_order',
        relations: [relationInput],
        expected_version: v5,
        ...tier2('重新认领渠道维度关联', 0.8),
      })
      assert.deepEqual(relifted['results'], [{ key: 'dim_channel', outcome: 'added', unsuppressed: true }])
    }

    // ── Phase 4.5 — the concept write path (ADR-0012 / Q4(b)) ───────────────────────
    step('create_definition(kind:concept) ×2, properties round-trip, concept-edge storage-home asymmetry, read path hits concept: nodes')
    {
      const created1 = await call(client, 'create_definition', {
        scope_id: 'fixture',
        kind: 'concept',
        concept: { name: '订单生命周期', description: '订单从下单到完成的生命周期阶段', properties: { domain: '交易' } },
        ...tier2('新概念：订单生命周期', 0.9),
      })
      assert.equal(created1['changed'], true)
      assert.match(fieldString(created1, 'commit'), /^[0-9a-f]{40}$/)

      const created2 = await call(client, 'create_definition', {
        scope_id: 'fixture',
        kind: 'concept',
        concept: { name: '渠道', description: '订单来源渠道的实体概念' },
        ...tier2('新概念：渠道', 0.9),
      })
      assert.equal(created2['changed'], true)

      const lifecycle = (await call(client, 'get_definition', { kind: 'concept', name: '订单生命周期' }))['definition'] as Record<string, unknown>
      assert.deepEqual(lifecycle['properties'], { domain: '交易' }, 'Q4(b) properties round-trip through create_definition')

      // Storage-home asymmetry, live and over the wire: a TABLE subject's
      // CONCEPT-target edge is written to the target concept's own file — tables
      // have no edge field at all — so the baseline this write races against is
      // 订单生命周期's fingerprint, never dws_order's own. Prove the wrong
      // baseline really is wrong before proving the right one works.
      const dwsOrderVersion = fieldString(await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }), 'version')
      const wrongBaseline = await callCodedError(client, 'add_relation', {
        scope_id: 'fixture',
        kind: 'table', name: 'dws_order',
        relations: [{ target_kind: 'concept', name: '订单生命周期' }],
        expected_version: dwsOrderVersion, // dws_order's OWN fingerprint — the wrong file for this write
        ...tier2('table→concept 边，故意传错 baseline', 0.8),
      })
      assert.equal(wrongBaseline.code, -31002, 'stale_baseline — dws_order\'s fingerprint never matches the concept file this write actually touches')
      assert.equal(wrongBaseline.name, 'StaleBaselineRejection')
      assert.equal(wrongBaseline.retryable, true)

      const lifecycleV1 = fieldString(await call(client, 'get_definition', { kind: 'concept', name: '订单生命周期' }), 'version')
      const tableToConcept = await call(client, 'add_relation', {
        scope_id: 'fixture',
        kind: 'table', name: 'dws_order',
        relations: [{ target_kind: 'concept', name: '订单生命周期' }],
        expected_version: lifecycleV1, // the TARGET concept's fingerprint — the right file
        ...tier2('table→concept 边：dws_order 归属订单生命周期', 0.8),
      })
      assert.equal(tableToConcept['changed'], true)
      const afterTableEdge = (await call(client, 'get_definition', { kind: 'concept', name: '订单生命周期' }))['definition'] as Record<string, unknown>
      const lifecycleRefs1 = afterTableEdge['related_refs'] as Array<{ target_kind: string; target: string }>
      assert.ok(lifecycleRefs1.some(r => r.target_kind === 'table' && r.target === 'dws_order'), 'the edge landed on the CONCEPT file, not on dws_order')
      const dwsOrderAfter = (await call(client, 'get_definition', { kind: 'table', name: 'dws_order' }))['definition'] as Record<string, unknown>
      assert.equal(dwsOrderAfter['related_refs'], undefined, 'tables have no edge field at all — nothing to find there')

      // concept→concept and concept→table: no asymmetry when the subject already
      // owns the file — both land on the SUBJECT concept itself.
      const lifecycleV2 = fieldString(await call(client, 'get_definition', { kind: 'concept', name: '订单生命周期' }), 'version')
      const conceptToConcept = await call(client, 'add_relation', {
        scope_id: 'fixture',
        kind: 'concept', name: '订单生命周期',
        relations: [{ target_kind: 'concept', name: '渠道' }],
        expected_version: lifecycleV2,
        ...tier2('concept→concept 边：订单生命周期 关联 渠道', 0.8),
      })
      assert.equal(conceptToConcept['changed'], true)

      const channelV1 = fieldString(await call(client, 'get_definition', { kind: 'concept', name: '渠道' }), 'version')
      const conceptToTable = await call(client, 'add_relation', {
        scope_id: 'fixture',
        kind: 'concept', name: '渠道',
        relations: [{ target_kind: 'table', name: 'dws_pay_flow' }],
        expected_version: channelV1,
        ...tier2('concept→table 边：渠道 关联 dws_pay_flow', 0.8),
      })
      assert.equal(conceptToTable['changed'], true)

      // Clean removal, no two-step dance: concepts have no on-write enrichment
      // hook, so a curated edge's removal is final on the FIRST call — contrast
      // with the table/event suppression dance two phases up.
      const channelV2 = fieldString(await call(client, 'get_definition', { kind: 'concept', name: '渠道' }), 'version')
      const removed = await call(client, 'remove_relation', {
        scope_id: 'fixture',
        kind: 'concept', name: '渠道',
        relations: [{ target_kind: 'table', name: 'dws_pay_flow' }],
        expected_version: channelV2,
        ...tier2('移除 concept→table 边', 0.7),
      })
      assert.deepEqual(removed['results'] as RemoveVerdict[], [{ key: 'dws_pay_flow', outcome: 'removed', suppressed: false, reasserted: false }],
        'curated concept-edge removal is clean and final on the first call — no on-write hook to bring it back')

      // add_alias / resolve_alias on a concept — AliasKindSchema parity, live.
      const lifecycleV3 = fieldString(await call(client, 'get_definition', { kind: 'concept', name: '订单生命周期' }), 'version')
      const aliasAdded = await call(client, 'add_alias', {
        scope_id: 'fixture',
        kind: 'concept', name: '订单生命周期', labels: ['订单周期'],
        expected_version: lifecycleV3,
        ...tier2('概念别名：订单周期', 0.85),
      })
      assert.equal(aliasAdded['changed'], true)
      const aliasResolved = await call(client, 'resolve_alias', { term: '订单周期' })
      assert.ok(((aliasResolved['node_ids'] as string[]) ?? []).includes('concept:订单生命周期'), 'the alias resolves to the concept\'s graph id')

      // ADR-0012's own Verification bar: the read path hits a `concept:` node.
      const searchHit = await call(client, 'search_definitions', { query: '订单生命周期' })
      const hits = searchHit['hits'] as Array<{ id: string; kind: string }>
      assert.ok(hits.some(h => h.id === 'concept:订单生命周期' && h.kind === 'concept'), `search_definitions ranks the concept: ${JSON.stringify(hits)}`)

      const relatedFromConcept = await call(client, 'get_relations', { target: 'concept:订单生命周期' })
      const relEdges = relatedFromConcept['relations'] as Array<{ type: string; targetId: string }>
      assert.ok(relEdges.some(r => r.type === 'related_to' && r.targetId === 'concept:渠道'), 'get_relations walks the concept→concept edge')
      assert.ok(relEdges.some(r => r.type === 'related_to' && r.targetId === 'dws_order'), 'get_relations walks the table→concept edge too (bare table id, no prefix)')

      // get_join_path's BFS only ever walks `joins`-type edges (relation-graph.ts) —
      // a concept's own edges project as `related_to` (CL-2's taxonomy layer, not a
      // join graph), so a concept endpoint is handled cleanly (found:false, never an
      // error, and never a false positive).
      const joinFromConcept = await call(client, 'get_join_path', { from: 'concept:订单生命周期', to: 'dim_shop' })
      assert.equal(joinFromConcept['found'], false, 'concept edges are related_to, not joins — get_join_path correctly reports unreachable rather than erroring')
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
      const boot2 = await boot({ registryPath, scopeId: 'fixture' })
      active = boot2
      const client2 = boot2.client

      const applied = await call(client2, 'apply_enrichment', {
        scope_id: 'fixture',
        results: [{ work_id: payFlowItem.work_id, text: '["支付流水"]' }],
        summary: '补充支付流水中文名',
        confidence: 0.8,
      })
      const verdicts = applied['results'] as Verdict[]
      assert.deepEqual(verdicts.map(v => [v.target, v.verdict]), [['dws_pay_flow', 'applied']], 'pre-restart work_id applied post-restart (self-contained)')
      assert.equal(applied['changed'], true)
      assert.ok(Array.isArray(applied['enrichment_health']))
      const trailers = await active.trailersOf(fieldString(applied, 'commit'))
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
        scope_id: 'fixture',
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
        scope_id: 'fixture',
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

    // ── Phase 6.5 — ADR-0011 scope tools, over the real wire ───────────────────────
    // A fully independent fixture, registry and boot (no --scope, no shared `active`)
    // — switching scopes on the MAIN flow's live server would silently redirect its
    // later reads/writes to the wrong corpus, so this never touches `client`/`root`.
    step('scope tools: scaffold → register → list → switch → get → deregister, each a real tools/call')
    {
      const scopeFixture = createFixtureCorpus({ withEvents: false })
      const scopeRegistryDir = mkdtempSync(join(tmpdir(), 'sg-e2e-registry-'))
      const scopeRegistryPath = join(scopeRegistryDir, 'scopes.yaml')
      const probeBoot = await boot({ registryPath: scopeRegistryPath, agentId: 'scope-probe-agent' })
      try {
        const probeClient = probeBoot.client

        const scaffold = await call(probeClient, 'get_scope_scaffold', { scope_id: 'probe', path: scopeFixture.root })
        assert.equal(scaffold['scope_id'], 'probe')
        assert.ok(Array.isArray(scaffold['steps']) && (scaffold['steps'] as unknown[]).length === 5, 'five bootstrap steps')
        assert.ok(typeof scaffold['next_steps'] === 'string' && (scaffold['next_steps'] as string).length > 0, 'carries the ADR-0012 R4 content-bootstrap line')

        const registered = await call(probeClient, 'register_scope', { id: 'probe', path: scopeFixture.root })
        assert.equal(registered['already_registered'], false, 'first registration is fresh')
        assert.equal(registered['active_unchanged'], true, 'registering never switches (ruling 3)')
        assert.equal((registered['scope'] as Record<string, unknown>)['id'], 'probe')

        const listed = await call(probeClient, 'list_scopes', {})
        const scopes = listed['scopes'] as Array<{ id: string; is_active: boolean }>
        assert.ok(scopes.some(s => s.id === 'probe' && s.is_active === false), 'registered but not yet active')
        assert.equal(listed['active'], null, 'no active scope bound at boot (no --scope flag)')

        const switched = await call(probeClient, 'switch_scope', { scope_id: 'probe' })
        assert.equal((switched['scope'] as Record<string, unknown>)['id'], 'probe')
        assert.equal(switched['switched_from'], null, 'nothing was active before this switch')

        const described = await call(probeClient, 'get_scope', {})
        assert.equal((described['scope'] as Record<string, unknown>)['id'], 'probe', 'no scope_id defaults to the now-active scope')
        assert.equal(described['is_active'], true)
        assert.ok(described['serving'] !== undefined, 'the response-layer stamp for the scope actually being served')

        // #72: deregister while serving — both cascade halves observable at once
        // (switch persisted `active: probe` and this process's binding is live).
        const deregistered = await call(probeClient, 'deregister_scope', { scope_id: 'probe' })
        assert.equal((deregistered['removed'] as Record<string, unknown>)['id'], 'probe')
        assert.equal(deregistered['active_cleared'], true, 'the next-process default named it and was cleared')
        assert.equal(deregistered['binding_cleared'], true, 'this process was serving it and the live binding dropped')
        const afterDeregister = await call(probeClient, 'list_scopes', {})
        assert.equal(afterDeregister['total'], 0)
        assert.equal(afterDeregister['active'], null)
      } finally {
        await probeBoot.shutdown()
        scopeFixture.cleanup()
        rmSync(scopeRegistryDir, { recursive: true, force: true })
      }
    }

    // ── Phase 6.6 — the initialization playbook (#63, ADR-0014), over the real wire ─
    // Its own fixture/registry/boot (same isolation rule as Phase 6.5): the probe
    // walks #55's e2e sketch — "scope 未注册 → 各阶段 → 成熟" — compressed to the
    // stops a live server observes in one gate run, plus the reuse contract
    // (playbook phases equal _guidance's on the same corpus state).
    step('initialization playbook: scope_registration before register, real two-layer phases after switch, equivalence with _guidance')
    {
      const pbFixture = createFixtureCorpus({ withEvents: false })
      const pbRegistryDir = mkdtempSync(join(tmpdir(), 'sg-e2e-registry-'))
      const pbRegistryPath = join(pbRegistryDir, 'scopes.yaml')
      const pbBoot = await boot({ registryPath: pbRegistryPath, agentId: 'playbook-probe-agent' })
      try {
        const pbClient = pbBoot.client

        // Before registration: phase 1 of the five — a successful answer, not an
        // error (R6: scope 不存在), whose recommended action is register_scope (R3).
        const before = await call(pbClient, 'get_initialization_playbook', { scope_id: 'pb-probe' })
        assert.equal(before['overall_phase'], 'scope_registration')
        assert.equal((before['scope'] as Record<string, unknown>)['root'], null)
        const beforeDw = ((before['layers'] as Record<string, Record<string, unknown>>)['dw']) as Record<string, unknown>
        assert.equal(beforeDw['phase'], 'scope_registration')
        assert.deepEqual(beforeDw['recommended_action'], { tool: 'register_scope', hint: 'scope_id 是持久身份（1:1 绑定 corpus、随每个 Tier-2 commit 进 git trailer、无改名工具）——注册前与用户确认命名' })

        // Register + switch: the corpus is the standard two-table fixture, so DW
        // starts life in backfill (three deterministic gaps) and KG — zero
        // concepts — in seeding, which is the laggard (R8's rule).
        await call(pbClient, 'register_scope', { id: 'pb-probe', path: pbFixture.root })
        await call(pbClient, 'switch_scope', { scope_id: 'pb-probe' })
        const live = await call(pbClient, 'get_initialization_playbook', { scope_id: 'pb-probe' })
        assert.equal(live['overall_phase'], 'seeding')
        const layers = live['layers'] as Record<string, Record<string, unknown>>
        assert.equal(layers['dw']?.['phase'], 'backfill')
        assert.equal(layers['kg']?.['phase'], 'seeding')
        assert.deepEqual(layers['dw']?.['recommended_action'], { tool: 'run_enrichment', hint: '运行确定性 enrichment 填充关联和别名' })
        const summary = live['summary'] as Record<string, unknown>
        assert.deepEqual(
          { dw: summary['dw_definitions'], kg: summary['kg_definitions'], total: summary['total_definitions'], work: summary['enrichment_work_remaining'] },
          { dw: 2, kg: 0, total: 2, work: 3 },
        )
        assert.ok(typeof summary['message'] === 'string' && (summary['message'] as string).includes('知识图谱层(KG)'), 'the corpus-level judgement names the laggard layer')

        // The reuse contract, observed on one state: the write's _guidance reports
        // the state it produced; the playbook then reads that same state.
        const aliased = await call(pbClient, 'add_alias', { scope_id: 'pb-probe',
          kind: 'table', name: 'dws_order', labels: ['订单宽表'],
          ...tier2('补别名', 0.9), expected_version: fieldString(await call(pbClient, 'get_definition', { kind: 'table', name: 'dws_order' }), 'version'),
        })
        const guidance = aliased['_guidance'] as { phase: string; metrics: { dw: { phase: string }; kg: { phase: string } } }
        const after = await call(pbClient, 'get_initialization_playbook', { scope_id: 'pb-probe' })
        const afterLayers = after['layers'] as Record<string, Record<string, unknown>>
        assert.equal(afterLayers['dw']?.['phase'], guidance.metrics.dw.phase)
        assert.equal(afterLayers['kg']?.['phase'], guidance.metrics.kg.phase)
        assert.equal(after['overall_phase'], guidance.phase)
      } finally {
        await pbBoot.shutdown()
        pbFixture.cleanup()
        rmSync(pbRegistryDir, { recursive: true, force: true })
      }
    }

    // ── Phase 6.7 — bulk import (#68, ADR-0013), over the real wire ────────────────
    // Same isolation rule as 6.5/6.6 (own fixture/registry/boot): the initialization
    // move this tool exists for — a mixed three-kind batch, per-item verdicts, one
    // commit — then the idempotent re-issue and the drift update, all against a
    // young corpus so `_guidance` rides the write response too.
    step('import_definitions: mixed batch one commit, per-item verdicts, idempotent re-issue, drift update')
    {
      const impFixture = createFixtureCorpus({ withEvents: false })
      const impRegistryDir = mkdtempSync(join(tmpdir(), 'sg-e2e-registry-'))
      const impRegistryPath = join(impRegistryDir, 'scopes.yaml')
      const impBoot = await boot({ registryPath: impRegistryPath, agentId: 'import-probe-agent' })
      try {
        const impClient = impBoot.client
        await call(impClient, 'register_scope', { id: 'imp-probe', path: impFixture.root })
        await call(impClient, 'switch_scope', { scope_id: 'imp-probe' })
        const impCount = (): number => Number(fixtureGit(['rev-list', '--count', 'HEAD'], impFixture.root).trim())

        // One batch, three kinds, two pre-planted error rows (a DIM failing its
        // superRefine, a cross-kind duplicate) that must not abort the four good
        // items — #54 R4's "坏项不中断批" over the wire.
        const batch = (payComment: string): Readonly<Record<string, unknown>> => ({
          scope_id: 'imp-probe',
          items: [
            { kind: 'table', definition: { table_name: 'dws_seed_pay', table_comment: payComment, partitions: [{ name: 'ds', type: 'string' }], columns: [{ name: 'pay_id', type: 'string', role: 'dimension' }] } },
            { kind: 'table', definition: { table_name: 'dim_seed_item', kind: 'dim', primary_key: ['item_id'], label_columns: ['item_name'], columns: [{ name: 'item_id', type: 'string', role: 'dimension' }, { name: 'item_name', type: 'string', role: 'dimension' }] } },
            { kind: 'event', definition: { name: 'game.seed.draw', description: '抽卡', params_fields: {} } },
            { kind: 'concept', definition: { name: 'seed_rarity', description: '稀有度' } },
            { kind: 'table', definition: { table_name: 'dim_seed_broken', kind: 'dim', columns: [] } },
            { kind: 'concept', definition: { name: 'seed_rarity', description: '重名' } },
          ],
          summary: 'imported from DDL dump', derivation: 'agent', confidence: 0.9,
        })

        const before = impCount()
        const first = await call(impClient, 'import_definitions', batch('seed v1'))
        assert.equal(first['changed'], true)
        assert.deepEqual(first['summary'], { created: 4, updated: 0, skipped: 0, errors: 2 })
        const rows = first['results'] as Array<{ index: number; verdict: string; detail?: string }>
        assert.deepEqual(rows.map(r => [r.index, r.verdict]), [[0, 'created'], [1, 'created'], [2, 'created'], [3, 'created'], [4, 'error'], [5, 'error']])
        assert.match(rows[4]?.detail ?? '', /zod:/, 'the DIM superRefine failure surfaces as its own verdict row')
        assert.match(rows[5]?.detail ?? '', /duplicate name in batch/, 'as does the cross-kind duplicate')
        // N logical writes, ONE commit, with the batch trailers to show for it.
        assert.equal(impCount(), before + 1)
        const subject = fixtureGit(['log', '-1', '--format=%s'], impFixture.root).trim()
        assert.match(subject, /^import_definitions\(4\/6 items \(4 created, 0 updated\)\): imported from DDL dump$/)
        const trailers = await impBoot.trailersOf(fieldString(first, 'commit'))
        assert.equal(trailers['Tool'], 'import_definitions')
        assert.equal(trailers['Files'], '4')
        assert.equal(trailers['Rounds'], '4')
        // The 7th write tool carries `_guidance` (#53 option D; young corpus ⇒ injected).
        assert.ok(first['_guidance'] !== undefined, 'an initializing corpus gets the guidance field on import too')
        // The imports are first-class corpus citizens: the read path sees them.
        const drawn = await call(impClient, 'get_definition', { kind: 'event', name: 'game.seed.draw' })
        assert.equal(fieldString(drawn, 'version').length, 64)

        // Idempotent re-issue: the same four items skip, the same two error rows
        // repeat (they are payload facts, not corpus state), and nothing commits.
        const second = await call(impClient, 'import_definitions', batch('seed v1'))
        assert.equal(second['changed'], false)
        assert.deepEqual(second['summary'], { created: 0, updated: 0, skipped: 4, errors: 2 })
        assert.equal(impCount(), before + 1, 'zero new commits — beginBatch end() saw a clean tree')

        // Drift: one item's content moved on — updated, full overwrite, one commit.
        const third = await call(impClient, 'import_definitions', batch('seed v2'))
        assert.equal(third['changed'], true)
        assert.deepEqual(third['summary'], { created: 0, updated: 1, skipped: 3, errors: 2 })
        assert.equal(impCount(), before + 2)
        const pay = (await call(impClient, 'get_definition', { kind: 'table', name: 'dws_seed_pay' }))['definition'] as Record<string, unknown>
        assert.equal(pay['table_comment'], 'seed v2')
        assert.equal(fixtureGit(['status', '--porcelain'], impFixture.root).trim(), '', 'the import fixture ends clean')
      } finally {
        await impBoot.shutdown()
        impFixture.cleanup()
        rmSync(impRegistryDir, { recursive: true, force: true })
      }
    }

    // ── Phase 7 — the 2026-07-28 envelope, over the real executable ────────────────
    step('spawn sg-mcp (src/bin.ts): 2026-07-28 envelope markers on a real tools/call')
    {
      const PROTOCOL = 'io.modelcontextprotocol/protocolVersion'
      const CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
      const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
      const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo'

      const child = spawn(process.execPath, ['src/bin.ts', '--agent-id', 'envelope-probe', '--registry', registryPath, '--scope', 'fixture'], {
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
    rmSync(registryDir, { recursive: true, force: true })
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

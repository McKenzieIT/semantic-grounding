/**
 * Ticket 01-probe: measure the real YAML parse counts of MCP read paths on
 * the k11 fixture (321 tables, 445 events, 10 concepts). The probe has veto
 * power over the entire read-epoch map — if measured cost is negligible,
 * the map closes as Out of scope.
 *
 * Method: a test-only counter on `readYaml` (io-probes.ts since #123 / C8.5 —
 * io.ts keeps only the one-line increment), reset before each measurement,
 * read after. No production behavior changes.
 *
 * ## Exact pins retired → bandwidth invariants (#123 / C8.5)
 *
 * The probe originally pinned `toBe(K11_TABLES)` / `toBe(K11_EVENT_READS)` on
 * the single-definition reads. Those were snapshots of one implementation, not
 * truths — any legitimate loader reshuffle would break them while the property
 * that matters held. What the spec asserts now are the TRUE invariants, the
 * shapes #119's Q4 ruling named: a per-definition bound (≤2 reads for the
 * write/fast-path resolutions) and a whole-operation bound (≤20× corpus for a
 * full round), with `K11_TABLES` / `K11_EVENT_READS` kept as the BANDWIDTH
 * OPERATORS (the multipliers a bound is phrased in), never as equality
 * targets. A regression to the ADR-0016 pathology class (262× broad-scan)
 * fails these just as loudly.
 *
 * @module tests/read-count-probe
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { _resetReadYamlCount, _getReadYamlCount } from '../src/io-probes.ts'
import {
  loadTables,
  loadEvents,
  loadTableDefinition,
  loadEventDefinition,
  loadConfig,
  writeEventYaml,
  definitionVersion,
} from '../src/io.ts'
import { assertKnownFilterNames } from '../src/enrichment.ts'
import { listEnrichmentWorkItems, fetchEnrichmentPrompts } from '../src/enrichment-work.ts'
import { SemanticGroundingCore } from '../src/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const K11 = join(HERE, './fixtures/k11')

/**
 * The k11 fixture's known counts (verified by k11-seed.spec.ts):
 * - 321 tables (162 DWS + 159 DIM)
 * - 445 events loaded successfully (453 files - 7 _index - 1 malformed)
 * - 10 concepts
 *
 * Note: loadEvents performs 446 readYaml calls (453 files - 7 _index = 446
 * files attempted; the 1 malformed file still triggers readYaml but fails
 * to parse). The 445 figure is successfully loaded events, not reads.
 *
 * #123 / C8.5: these constants are BANDWIDTH OPERATORS now, not equality
 * targets — bounds below are phrased as multiples of them ("≤ 2 × one
 * kind-corpus scan", "≤ 20 × one full corpus"), so a legitimate loader
 * reshuffle that changes the exact count by a scan's worth stays green while
 * the pathology class (an unbounded fan-out per definition) still trips red.
 */
const K11_TABLES = 321
const K11_EVENTS_LOADED = 445
const K11_EVENT_READS = 446
const K11_CONCEPTS = 10

// Known table names from the k11 fixture (for assertKnownFilterNames test)
const KNOWN_TABLE_NAMES = [
  'dws_10000251_univ_role_act_di',
  'dws_10000251_acc_summary_df',
  'dws_10000251_acc_summary_di',
  'dws_10000251_active_code_info',
  'dws_10000251_algo_role_act_pay_df',
  'dim_10000251_auto_event_cfg_info',
  'dim_10000251_auto_pvp_rank_info',
  'dim_10000251_autobi_conf2_od',
  'dim_10000251_business_analysis_recharge',
  'dim_10000251_card_pool_info',
]

/** One full-corpus parse = one loadTables + one loadEvents call (in readYaml count). */
const ONE_FULL_CORPUS = K11_TABLES + K11_EVENT_READS

/**
 * Run a measurement: reset counter, execute fn, return the count.
 */
function measure(fn: () => void | Promise<void>): number {
  _resetReadYamlCount()
  const result = fn()
  // Handle both sync and async
  if (result instanceof Promise) {
    throw new Error('measure() does not support async — use measureAsync()')
  }
  return _getReadYamlCount()
}

async function measureAsync(fn: () => Promise<void>): Promise<number> {
  _resetReadYamlCount()
  await fn()
  return _getReadYamlCount()
}

/** Results accumulator — printed in the afterAll-style summary at the end. */
const results: Array<{ path: string; count: number; fullCorpusEquiv: string; notes: string }> = []

function record(path: string, count: number, notes: string): void {
  const equiv = (count / ONE_FULL_CORPUS).toFixed(2)
  results.push({ path, count, fullCorpusEquiv: `${equiv}×`, notes })
}

// ── Sanity: verify the fixture loads correctly ────────────────────────────

describe('k11 fixture sanity', () => {
  it('loads 321 tables and 445 events', () => {
    const tables = loadTables(K11)
    const events = loadEvents(K11)
    expect(tables).toHaveLength(K11_TABLES)
    expect(events).toHaveLength(K11_EVENTS_LOADED)
  })
})

// ── Path 1: get_enrichment_work (full listing) ────────────────────────────

describe('path 1: get_enrichment_work (full listing)', () => {
  it('measures YAML parse count for listEnrichmentWorkItems({})', () => {
    const count = measure(() => {
      listEnrichmentWorkItems(K11, {})
    })
    record(
      'get_enrichment_work (full)',
      count,
      `assertKnownFilterNames({}) skips both dims (0 reads) + buildDimInventory (loadTables=${K11_TABLES}) + loadTables (${K11_TABLES}) + loadEvents (${K11_EVENT_READS})`,
    )
    // Expected: buildDimInventory(321) + loadTables(321) + loadEvents(445) = 1087
    console.log(`  [probe] get_enrichment_work (full): ${count} YAML reads (${(count / ONE_FULL_CORPUS).toFixed(2)}× full corpus)`)
    expect(count).toBeGreaterThan(0)
  })
})

// ── Path 2: get_enrichment_prompts (~5 work_ids) ─────────────────────────

describe('path 2: get_enrichment_prompts', () => {
  it('measures YAML parse count for ~5 work_ids', () => {
    // First, get some real work_ids from a listing (use a broader filter to ensure enough items)
    _resetReadYamlCount()
    const listing = listEnrichmentWorkItems(K11, {})
    // Take the first 5 work_ids (mix of table and event, relation and alt_labels)
    const workIds = listing.work.slice(0, 5).map(w => w.work_id)

    const count = measure(() => {
      fetchEnrichmentPrompts(K11, workIds)
    })
    record(
      `get_enrichment_prompts (${workIds.length} items)`,
      count,
      `each table work_id calls loadTables(${K11_TABLES}); each event work_id calls loadEvents(${K11_EVENT_READS}); relation items also trigger buildDimInventory (loadTables, lazy-once)`,
    )
    console.log(`  [probe] get_enrichment_prompts (${workIds.length} items): ${count} YAML reads (${(count / ONE_FULL_CORPUS).toFixed(2)}× full corpus)`)
    expect(count).toBeGreaterThan(0)
  })
})

// ── Path 3: assertKnownFilterNames (~10 known table names) ────────────────

describe('path 3: assertKnownFilterNames', () => {
  it('measures YAML parse count for 10 known table names', () => {
    const count = measure(() => {
      assertKnownFilterNames(K11, { tables: KNOWN_TABLE_NAMES })
    })
    record(
      'assertKnownFilterNames (10 tables)',
      count,
      `new Set(loadTables(...)) INSIDE .filter() predicate — N names × loadTables(${K11_TABLES}) reads`,
    )
    // Expected: 10 × 321 = 3210 (the loadTables is inside the .filter() predicate)
    console.log(`  [probe] assertKnownFilterNames (10 tables): ${count} YAML reads (${(count / ONE_FULL_CORPUS).toFixed(2)}× full corpus)`)
    expect(count).toBeGreaterThan(0)
  })
})

// ── Path 4: get_definition (single table) ────────────────────────────────

describe('path 4: get_definition (single table)', () => {
  it('measures YAML parse count for loadTableDefinition', () => {
    const count = measure(() => {
      const def = loadTableDefinition(K11, 'dws_10000251_univ_role_act_di')
      expect(def).not.toBeNull()
    })
    record(
      'get_definition (single table)',
      count,
      `loadTableDefinition → loadTables(${K11_TABLES}).find() + schema parse (no extra readYaml)`,
    )
    // Today: exactly one full tables scan (321 = K11_TABLES). The asserted
    // invariant is the BANDWIDTH, not the exact count (#123 / C8.5): reading
    // ONE definition may cost at most 2× its own kind corpus — an
    // implementation that scans twice stays green, an unbounded fan-out (the
    // ADR-0016 broad-scan pathology class) trips red.
    console.log(`  [probe] get_definition (single table): ${count} YAML reads (${(count / ONE_FULL_CORPUS).toFixed(2)}× full corpus)`)
    expect(count).toBeLessThanOrEqual(2 * K11_TABLES)
  })

  it('measures YAML parse count for loadEventDefinition', () => {
    const count = measure(() => {
      const def = loadEventDefinition(K11, 'game.role.online')
      expect(def).not.toBeNull()
    })
    record(
      'get_definition (single event)',
      count,
      `loadEventDefinition → loadEvents(${K11_EVENT_READS}).find() + schema parse`,
    )
    console.log(`  [probe] get_definition (single event): ${count} YAML reads (${(count / ONE_FULL_CORPUS).toFixed(2)}× full corpus)`)
    // Today: exactly one full events scan (446 = K11_EVENT_READS). Bandwidth
    // invariant, same as the table branch above (#123 / C8.5): ≤ 2× the kind
    // corpus for a single-definition read.
    expect(count).toBeLessThanOrEqual(2 * K11_EVENT_READS)
  })
})

// ── Path 5: run_enrichment single round ───────────────────────────────────

describe('path 5: run_enrichment (one full invocation)', () => {
  it('measures YAML parse count for discoverRelations (table relations sweep only)', async () => {
    // Copy k11 to tmpdir so writes don't modify the fixture
    const tmp = mkdtempSync(join(tmpdir(), 'sg-probe-'))
    cpSync(K11, tmp, { recursive: true })
    try {
      const core = new SemanticGroundingCore({ semanticRoot: tmp, scopeId: 'probe' })

      const count = await measureAsync(async () => {
        await core.discoverRelations({})
      })
      record(
        'run_enrichment: discoverRelations (tables only)',
        count,
        `prepare: buildDimInventory(loadTables=${K11_TABLES}) + list: loadTables(${K11_TABLES}); no LLM round`,
      )
      // Expected: 321 + 321 = 642
      console.log(`  [probe] discoverRelations (tables only): ${count} YAML reads (${(count / ONE_FULL_CORPUS).toFixed(2)}× full corpus)`)
      expect(count).toBeGreaterThan(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('measures YAML parse count for full run_enrichment equivalent (all 4 pipelines)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sg-probe-full-'))
    cpSync(K11, tmp, { recursive: true })
    try {
      const core = new SemanticGroundingCore({ semanticRoot: tmp, scopeId: 'probe' })

      // Mirror the MCP run_enrichment handler: discoverRelations + discoverEventRelations + discoverAltLabels
      _resetReadYamlCount()
      await core.discoverRelations({})
      const afterRel = _getReadYamlCount()
      console.log(`    [diag] after discoverRelations: ${afterRel} reads`)

      await core.discoverEventRelations({})
      const afterEvtRel = _getReadYamlCount()
      console.log(`    [diag] after discoverEventRelations: ${afterEvtRel} reads (cumulative)`)

      await core.discoverAltLabels({})
      const count = _getReadYamlCount()
      console.log(`    [diag] after discoverAltLabels: ${count} reads (cumulative)`)
      record(
        'run_enrichment (full: relations + event-relations + alt_labels)',
        count,
        `discoverRelations(${afterRel}) + discoverEventRelations(+${afterEvtRel - afterRel}) + discoverAltLabels(+${count - afterEvtRel}). ADR-0016 (#80): findEventPath fast-path now hits on filename=name — pre-migration this was ~100371 reads in each of discoverEventRelations/discoverAltLabels (99% broad-scan), a 262.56× corpus baseline.`,
      )
      console.log(`  [probe] run_enrichment (full): ${count} YAML reads (${(count / ONE_FULL_CORPUS).toFixed(2)}× full corpus, vs 262.56× pre-ADR-0016 baseline)`)
      // ADR-0016 regression guard: the pathology this fixed was a full
      // broad-scan of the event tree on every write (262.56× corpus). 20×
      // leaves headroom for unrelated cost growth while still failing loudly
      // if findEventPath's fast path stops hitting.
      expect(count).toBeLessThan(20 * ONE_FULL_CORPUS)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 60_000)
})

// ── Path 6: search_definitions / get_join_path / get_relations / resolve_alias ──

describe('path 6: graph/search paths', () => {
  it('measures YAML parse count for getRelationGraph (first call, cache cold)', () => {
    const core = new SemanticGroundingCore({ semanticRoot: K11, scopeId: 'probe' })
    const count = measure(() => {
      core.getRelationGraph()
    })
    record(
      'getRelationGraph (cold cache)',
      count,
      `buildGraph → loadKindDefinitions for each plugin: loadEvents(${K11_EVENT_READS}) + loadTables(${K11_TABLES}) + loadConcepts(${K11_CONCEPTS})`,
    )
    console.log(`  [probe] getRelationGraph (cold): ${count} YAML reads (${(count / ONE_FULL_CORPUS).toFixed(2)}× full corpus)`)
    expect(count).toBeGreaterThan(0)
  })

  it('measures YAML parse count for getRelationGraph (second call, cache warm)', () => {
    const core = new SemanticGroundingCore({ semanticRoot: K11, scopeId: 'probe' })
    // Warm the cache
    core.getRelationGraph()
    const count = measure(() => {
      core.getRelationGraph()
    })
    record(
      'getRelationGraph (warm cache)',
      count,
      `cached by corpusVersion — zero reads on hit`,
    )
    console.log(`  [probe] getRelationGraph (warm): ${count} YAML reads`)
    expect(count).toBe(0)
  })

  it('measures YAML parse count for loadRetrievalCorpusAll (search_definitions candidate build)', () => {
    const core = new SemanticGroundingCore({ semanticRoot: K11, scopeId: 'probe' })
    // search_definitions calls buildCandidates(core) which calls:
    // 1. core.projectGraphNodes({ includeDerived: true }) → getRelationGraph() → buildGraph
    // 2. core.loadRetrievalCorpusAll() → loadKindDefinitions for each plugin
    const count = measure(() => {
      core.projectGraphNodes({ includeDerived: true })
      core.loadRetrievalCorpusAll()
    })
    record(
      'search_definitions (buildCandidates, cold)',
      count,
      `projectGraphNodes (UNCACHED, 777 reads: loadKindDefinitions × 3 plugins) + loadRetrievalCorpusAll (777 reads: same). Graph cache irrelevant — projectGraphNodes re-reads every call.`,
    )
    console.log(`  [probe] search_definitions (cold): ${count} YAML reads (${(count / ONE_FULL_CORPUS).toFixed(2)}× full corpus)`)
    expect(count).toBeGreaterThan(0)
  })

  it('measures YAML parse count for search_definitions with warm graph cache', () => {
    const core = new SemanticGroundingCore({ semanticRoot: K11, scopeId: 'probe' })
    // Warm the graph cache
    core.getRelationGraph()
    _resetReadYamlCount()
    // Now measure just the search call (graph cache warm, but loadRetrievalCorpusAll is NOT cached)
    const count = measure(() => {
      core.projectGraphNodes({ includeDerived: true })
      core.loadRetrievalCorpusAll()
    })
    record(
      'search_definitions (graph cache warm)',
      count,
      `graph cached (0 reads for getRelationGraph), BUT projectGraphNodes is UNCACHED (777 reads) + loadRetrievalCorpusAll also uncached (777 reads) = 1554 regardless`,
    )
    console.log(`  [probe] search_definitions (warm graph): ${count} YAML reads (${(count / ONE_FULL_CORPUS).toFixed(2)}× full corpus)`)
    expect(count).toBeGreaterThan(0)
  })
})

// ── Path 7: write-path fast-path hit (ADR-0016 / #80) ─────────────────────

describe('path 7: write-path fast-path hit (ADR-0016)', () => {
  it('writeEventYaml resolves via fast path: ≤2 YAML reads', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sg-probe-write-'))
    cpSync(K11, tmp, { recursive: true })
    try {
      const name = 'game.role.online'
      const raw = readFileSync(join(tmp, 'events/account', `${name}.yaml`), 'utf-8')
      const count = await measureAsync(async () => {
        const result = await writeEventYaml(tmp, name, raw)
        expect(result.ok).toBe(true)
      })
      record(
        'writeEventYaml (fast-path hit)',
        count,
        'ADR-0016 R1/R6: filename=name post-migration — findEventPath hits its candidate on the first readYaml, zero broad-scan reads',
      )
      console.log(`  [probe] writeEventYaml (fast-path hit): ${count} YAML reads`)
      expect(count).toBeLessThanOrEqual(2)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('definitionVersion(event) resolves via fast path: ≤2 YAML reads', () => {
    const count = measure(() => {
      const v = definitionVersion(K11, 'event', 'game.role.online')
      expect(v).not.toBeNull()
    })
    record(
      'definitionVersion(event, fast-path hit)',
      count,
      'ADR-0016 R1/R6: the Tier-2 write-gate fingerprint path (findEventPath) hits fast path post-migration',
    )
    console.log(`  [probe] definitionVersion(event, fast-path hit): ${count} YAML reads`)
    expect(count).toBeLessThanOrEqual(2)
  })
})

// ── Summary ──────────────────────────────────────────────────────────────

describe('probe summary', () => {
  it('prints the results table', () => {
    console.log('\n═══ READ-COUNT PROBE RESULTS ═══')
    console.log(`Fixture: k11 (${K11_TABLES} tables, ${K11_EVENTS_LOADED} events loaded / ${K11_EVENT_READS} reads, ${K11_CONCEPTS} concepts)`)
    console.log(`One full-corpus parse = ${ONE_FULL_CORPUS} YAML reads\n`)
    console.log('Path'.padEnd(55) + 'Reads'.padStart(8) + 'Corpus×'.padStart(10) + '  Notes')
    console.log('─'.repeat(120))
    for (const r of results) {
      console.log(
        r.path.padEnd(55) +
        String(r.count).padStart(8) +
        r.fullCorpusEquiv.padStart(10) +
        '  ' + r.notes,
      )
    }
    console.log('─'.repeat(120))

    // Classify each path
    for (const r of results) {
      const ratio = r.count / ONE_FULL_CORPUS
      let severity: string
      if (r.count <= 2) severity = 'NEGLIGIBLE'
      else if (ratio <= 2) severity = 'MODERATE'
      else severity = 'PATHOLOGICAL'
      console.log(`  ${severity.padEnd(14)} ${r.path}: ${r.count} reads (${r.fullCorpusEquiv} corpus)`)
    }
    console.log('')
  })
})

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
 * ## #174 slimming — the scale is the signal
 *
 * #174 deleted the measurements whose bandwidth truth already lives elsewhere
 * (paths 1-3: read-epoch.spec:82-146 pins them exactly in and out of an epoch,
 * stronger than the >0 bounds here; the k11 sanity block: k11-seed.spec:36-44)
 * and moved path 5, the run_enrichment pipeline rehearsal, to a ~1/3 mirror
 * subset of k11 — pipeline cost is near-linear in corpus size, and path 5's
 * assertions are ratio-shaped against the subset's OWN full-corpus size, so
 * the 20× ADR-0016 band means exactly what it meant on full k11. Everything
 * else stays FULL k11: the probe's yardstick is the signal, and shrinking the
 * measured paths themselves would gut the probe's reason to exist.
 *
 * @module tests/read-count-probe
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { _resetReadYamlCount, _getReadYamlCount } from '../src/io-probes.ts'
import {
  loadTableDefinition,
  loadEventDefinition,
  loadConfig,
  writeEventYaml,
  definitionVersion,
} from '../src/io.ts'
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

/** One full-corpus parse = one loadTables + one loadEvents call (in readYaml count). */
const ONE_FULL_CORPUS = K11_TABLES + K11_EVENT_READS

/**
 * Build a ~1/3 mirror subset of the k11 fixture into `dst` (#174 4c).
 *
 * Path 5's pipelines are near-linear in corpus size, so a third of the
 * mirror-shaped fixture rehearses them at a third of the cost. The mirror is
 * preserved exactly — same directories, same file shapes, `_index.yaml`
 * manifests kept (inert on read, kept so the write path finds them), every
 * third file of each sorted listing taken. The returned counts are the
 * subset's OWN kind-corpus sizes, so ratio assertions phrased against them
 * carry the same relative strength they carried on full k11.
 * @param dst - an existing empty directory.
 * @returns the number of table files copied and the number of event readYaml
 * attempts the subset will cost (non-index event YAMLs copied — the one
 * malformed file included if selected, since readYaml fires before the
 * lenient parse skip).
 */
function copyK11Third(dst: string): { tables: number; eventReads: number } {
  cpSync(join(K11, 'config.yaml'), join(dst, 'config.yaml'))
  cpSync(join(K11, 'domains.yaml'), join(dst, 'domains.yaml'))

  mkdirSync(join(dst, 'tables'), { recursive: true })
  const selectedTables = readdirSync(join(K11, 'tables')).filter(f => f.endsWith('.yaml')).sort().filter((_, i) => i % 3 === 0)
  for (const f of selectedTables) {
    cpSync(join(K11, 'tables', f), join(dst, 'tables', f))
  }

  let eventReads = 0
  mkdirSync(join(dst, 'events'), { recursive: true })
  for (const domain of readdirSync(join(K11, 'events')).sort()) {
    mkdirSync(join(dst, 'events', domain), { recursive: true })
    const files = readdirSync(join(K11, 'events', domain)).filter(f => f.endsWith('.yaml')).sort()
    for (const [i, f] of files.entries()) {
      if (f === '_index.yaml') {
        cpSync(join(K11, 'events', domain, f), join(dst, 'events', domain, f))
        continue
      }
      if (i % 3 === 0) {
        cpSync(join(K11, 'events', domain, f), join(dst, 'events', domain, f))
        eventReads++
      }
    }
  }

  cpSync(join(K11, 'concepts'), join(dst, 'concepts'), { recursive: true })
  return { tables: selectedTables.length, eventReads }
}

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

/** Results accumulator. #174 (C3) removed the zero-assertion summary printer that used to consume it; the per-test record() calls stay as a structured ledger (each test also console.logs its own measurement inline). */
const results: Array<{ path: string; count: number; fullCorpusEquiv: string; notes: string }> = []

function record(path: string, count: number, notes: string): void {
  const equiv = (count / ONE_FULL_CORPUS).toFixed(2)
  results.push({ path, count, fullCorpusEquiv: `${equiv}×`, notes })
}

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
    // A ~1/3 mirror subset of k11 in a tmpdir (#174 4c): writes don't modify
    // the fixture, and the pipeline's near-linear cost doesn't dominate the
    // file. Ratios below are against the SUBSET's own one-corpus size.
    const tmp = mkdtempSync(join(tmpdir(), 'sg-probe-'))
    const sub = copyK11Third(tmp)
    const oneCorpus = sub.tables + sub.eventReads
    try {
      const core = new SemanticGroundingCore({ semanticRoot: tmp, scopeId: 'probe' })

      const count = await measureAsync(async () => {
        await core.discoverRelations({})
      })
      record(
        'run_enrichment: discoverRelations (tables only, 1/3 subset)',
        count,
        `prepare: buildDimInventory(loadTables=${sub.tables}) + list: loadTables(${sub.tables}); no LLM round`,
      )
      console.log(`  [probe] discoverRelations (tables only, 1/3 subset): ${count} YAML reads (${(count / oneCorpus).toFixed(2)}× subset corpus)`)
      expect(count).toBeGreaterThan(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('measures YAML parse count for full run_enrichment equivalent (all 4 pipelines)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sg-probe-full-'))
    const sub = copyK11Third(tmp)
    const oneCorpus = sub.tables + sub.eventReads
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
        'run_enrichment (full: relations + event-relations + alt_labels, 1/3 subset)',
        count,
        `discoverRelations(${afterRel}) + discoverEventRelations(+${afterEvtRel - afterRel}) + discoverAltLabels(+${count - afterEvtRel}). ADR-0016 (#80): findEventPath fast-path now hits on filename=name — pre-migration the broad-scan pathology measured ~100371 reads per sweep on full k11, a 262.56× CORPUS ratio; ratios are scale-free, so the same guard trips on the subset.`,
      )
      console.log(`  [probe] run_enrichment (full, 1/3 subset): ${count} YAML reads (${(count / oneCorpus).toFixed(2)}× subset corpus, vs 262.56× pre-ADR-0016 baseline)`)
      // ADR-0016 regression guard: the pathology this fixed was a full
      // broad-scan of the event tree on every write (262.56× corpus). 20×
      // leaves headroom for unrelated cost growth while still failing loudly
      // if findEventPath's fast path stops hitting. #174 4c: the band is the
      // subset's own one-corpus size (tables + event reads actually copied),
      // so its relative strength is exactly the full-k11 band's.
      expect(count).toBeLessThan(20 * oneCorpus)
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

    // Warm leg (#174 C12, folded in from what was its own test with a fresh
    // core instance): the cold leg above already filled the graph cache via
    // projectGraphNodes → getRelationGraph, so this explicit warm call is the
    // free 0-read proof of that. The property being measured: a warm GRAPH
    // cache does not help — projectGraphNodes and loadRetrievalCorpusAll
    // re-read their inputs every call regardless.
    core.getRelationGraph()
    const warm = measure(() => {
      core.projectGraphNodes({ includeDerived: true })
      core.loadRetrievalCorpusAll()
    })
    record(
      'search_definitions (graph cache warm)',
      warm,
      `graph cached (0 reads for getRelationGraph), BUT projectGraphNodes is UNCACHED (777 reads) + loadRetrievalCorpusAll also uncached (777 reads) = 1554 regardless`,
    )
    console.log(`  [probe] search_definitions (warm graph): ${warm} YAML reads (${(warm / ONE_FULL_CORPUS).toFixed(2)}× full corpus)`)
    expect(warm).toBeGreaterThan(0)
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

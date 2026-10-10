#!/usr/bin/env node
/**
 * Tarball acceptance: proof that what we *ship* is the host-neutral substrate.
 *
 * ## Why this exists alongside `check-core-purity.mjs`
 *
 * The purity gate reads `src/`. It proves a **design** fact: no core source
 * file names a host concept. It says nothing about the artifact a host actually
 * installs, because `src/` is not shipped (`files` is `lib/**` only).
 *
 * This gate reads the **tarball**. It proves the packaging fact the map's
 * acceptance criterion rests on: a host can install this package with no
 * plugin framework present and the substrate loads, constructs, reads, and
 * enforces its invariants.
 *
 * ## Why not `grep -c cordis lib/index.js`
 *
 * That is the proof slices 2 and 3 recorded, and it is weak in two ways that
 * matter — it is the same shape of error as slice 1's vendoring:
 *
 * 1. **It greps the wrong file.** `lib/index.js` is a 4 KB re-export barrel;
 *    the substrate is in a rolldown chunk beside it (`lib/src-*.js`). The
 *    chunk currently matches `cordis` 4 times — all four in surviving JSDoc.
 *    A *real* `import ... from '@deepseek-ai/cordis'` in the chunk would have
 *    left `grep -c cordis lib/index.js` at 0. The gate would have stayed green
 *    through exactly the regression it was supposed to catch.
 * 2. **Substring, not specifier.** It cannot tell a comment from an import, so
 *    it is simultaneously too loose (above) and too tight (a mention of the
 *    word in a doc comment turns it red for no reason).
 *
 * So this gate parses **import specifiers** out of every shipped `.js` and
 * `.d.ts`, and asserts over the module graph instead of over file text.
 *
 * ## No shipped entry may name a host framework
 *
 * This used to be a weaker, two-sided claim. While the substrate still shipped
 * `./llm-wiring-plugin` — a cordis plugin, and the one entry that was
 * *supposed* to name a host framework — the gate asserted that the root entry
 * loaded without peers and the shell entry failed, so that a shell which
 * started loading peerless (host framework bundled in) or a root entry that
 * stopped loading (shell leaked into the core graph) both went red.
 *
 * Slice 4a moved that plugin into the dsh adapter, so the exemption is gone
 * and the assertion collapses into something strictly stronger: **nothing in
 * the tarball names a host framework, and `peerDependencies` is empty.** There
 * is no longer a "but this file is allowed to" clause to argue about — which is
 * the same reason `scripts/check-core-purity.mjs` now runs with an empty
 * allow-list.
 *
 * Run: `node scripts/check-tarball-acceptance.mjs`
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** Host frameworks that must not appear in the core module graph. */
const HOST_FRAMEWORKS = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/cosmokit']

const failures = []
const notes = []
function check(label, fn) {
  try {
    const detail = fn()
    console.error(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
  } catch (err) {
    failures.push({ label, message: err.message })
    console.error(`  ✗ ${label}\n      ${err.message.split('\n').join('\n      ')}`)
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

/**
 * Static + dynamic import specifiers of a built ESM file.
 * Deliberately specifier-level: a `cordis` mention in a comment is not an edge.
 */
function importsOf(source) {
  const out = new Set()
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) for (const m of source.matchAll(re)) out.add(m[1])
  return out
}

const isBare = s => !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('node:')
const bareRoot = s => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0])

const work = mkdtempSync(join(tmpdir(), 'sg-tarball-'))
const packDir = join(work, 'pack')
const scratch = join(work, 'scratch')
mkdirSync(packDir, { recursive: true })
mkdirSync(scratch, { recursive: true })

try {
  console.error('\n── 1. build + pack ─────────────────────────────────────────')
  execFileSync('npm', ['run', '--silent', 'build'], { cwd: ROOT, stdio: 'pipe' })
  const packed = execFileSync('npm', ['pack', '--pack-destination', packDir, '--silent'], {
    cwd: ROOT, encoding: 'utf8',
  }).trim().split('\n').pop()
  const tgz = join(packDir, packed)

  const entries = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
    .trim().split('\n').map(p => p.replace(/^package\//, '')).sort()

  check('tarball ships only built artifacts + manifest', () => {
    const stray = entries.filter(e => !e.startsWith('lib/') && e !== 'package.json')
    assert(stray.length === 0, `unexpected entries: ${stray.join(', ')}`)
    return `${entries.length} entries`
  })
  check('tarball ships no src/ entry', () => {
    const src = entries.filter(e => e.startsWith('src/'))
    assert(src.length === 0, `src/ leaked into the tarball: ${src.join(', ')}`)
    return 'exports["./src/*"] is dead outside the workspace, as ADR-0002 measured'
  })
  check('every declared exports subpath is present in the tarball', () => {
    const missing = []
    for (const [sub, target] of Object.entries(PKG.exports)) {
      for (const p of typeof target === 'string' ? [target] : Object.values(target)) {
        const rel = p.replace(/^\.\//, '')
        if (!entries.includes(rel)) missing.push(`${sub} → ${p}`)
      }
    }
    assert(missing.length === 0, `declared but not shipped: ${missing.join(', ')}`)
    return `${Object.keys(PKG.exports).length} subpaths`
  })

  console.error('\n── 2. install into a scratch dir with no peers ──────────────')
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({
    name: 'sg-tarball-acceptance', version: '1.0.0', type: 'module', private: true,
  }, null, 2))
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', tgz], {
    cwd: scratch, stdio: 'pipe',
  })

  check('no host framework anywhere in the installed tree', () => {
    const nm = join(scratch, 'node_modules')
    const found = []
    const walk = (dir, depth) => {
      if (depth > 3) return
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        if (HOST_FRAMEWORKS.some(h => h.endsWith(`/${e.name}`) || h === e.name)) found.push(join(relative(nm, dir), e.name))
        else walk(join(dir, e.name), depth + 1)
      }
    }
    walk(nm, 0)
    assert(found.length === 0, `host framework installed: ${found.join(', ')}`)
    const top = readdirSync(nm).filter(d => !d.startsWith('.'))
    return `installed: ${top.join(', ')}`
  })

  console.error('\n── 3. negation test over the shipped module graph ──────────')
  const installed = join(scratch, 'node_modules', PKG.name)
  const shipped = new Map()
  for (const e of entries.filter(e => e.endsWith('.js') || e.endsWith('.d.ts'))) {
    shipped.set(e, readFileSync(join(installed, e), 'utf8'))
  }

  /** Walk the graph from an entry, following only relative edges. */
  function graphFrom(entry) {
    const seen = new Set(), bare = new Set()
    const queue = [entry]
    while (queue.length) {
      const file = queue.pop()
      if (seen.has(file) || !shipped.has(file)) continue
      seen.add(file)
      for (const spec of importsOf(shipped.get(file))) {
        if (isBare(spec)) { bare.add(spec); continue }
        if (spec.startsWith('.')) {
          let resolved = join(dirname(file), spec)
          if (!shipped.has(resolved)) {
            const dts = resolved.replace(/\.js$/, '.d.ts')
            if (file.endsWith('.d.ts') && shipped.has(dts)) resolved = dts
          }
          queue.push(resolved)
        }
      }
    }
    return { files: seen, bare }
  }

  const coreJs = graphFrom('lib/index.js')
  check('core runtime graph names no host framework', () => {
    const bad = [...coreJs.bare].filter(s => HOST_FRAMEWORKS.includes(bareRoot(s)))
    assert(bad.length === 0, `core imports host framework: ${bad.join(', ')}`)
    return `${coreJs.files.size} files, bare deps: ${[...coreJs.bare].sort().join(', ')}`
  })
  check('core type graph names no host framework', () => {
    const coreDts = graphFrom('lib/index.d.ts')
    const bad = [...coreDts.bare].filter(s => HOST_FRAMEWORKS.includes(bareRoot(s)))
    assert(bad.length === 0, `core .d.ts references host framework: ${bad.join(', ')}`)
    return `types resolve with only: ${[...coreDts.bare].sort().join(', ') || '(nothing)'}`
  })
  check('every bare specifier in the shipped graph is a declared dependency', () => {
    const declared = new Set([
      ...Object.keys(PKG.dependencies ?? {}),
      ...Object.keys(PKG.peerDependencies ?? {}),
      ...Object.keys(PKG.optionalDependencies ?? {}),
    ])
    const undeclared = new Map()
    for (const [file, source] of shipped) {
      for (const spec of importsOf(source)) {
        if (!isBare(spec)) continue
        const root = bareRoot(spec)
        if (!declared.has(root)) {
          if (!undeclared.has(root)) undeclared.set(root, [])
          undeclared.get(root).push(file)
        }
      }
    }
    assert(undeclared.size === 0, [...undeclared].map(([d, fs]) =>
      `'${d}' imported by ${fs.join(', ')} but absent from dependencies/peerDependencies`).join('\n'))
    return `${declared.size} declared, all satisfied`
  })

  console.error('\n── 4. the substrate actually works with no host present ────')
  const layer = join(scratch, 'layer')
  mkdirSync(join(layer, 'tables'), { recursive: true })
  mkdirSync(join(layer, 'events', 'probe'), { recursive: true })
  mkdirSync(join(layer, 'concepts'), { recursive: true })
  writeFileSync(join(layer, 'tables', 'dws_probe_di.yaml'), [
    'table_name: dws_probe_di',
    'comment: tarball acceptance probe table',
    'kind: dws',
    'engine: maxcompute',
    'partitions:', '  - name: ds', '    type: string',
    'columns:',
    '  - name: server_id', '    type: string', '    comment: 区服ID',
    '  - name: pay_amt', '    type: double', '    comment: 付费金额',
    '',
  ].join('\n'))
  writeFileSync(join(layer, 'events', 'probe', 'pay_success.yaml'), [
    'name: probe.pay.success',
    "event_filter: event = 'probe.pay.success'",
    'description: tarball acceptance probe event',
    'domain: probe',
    'params_fields:',
    '  serverId:', '    type: int', '    description: 游戏服id',
    '  payAmount:', '    type: double', '    description: 付费金额',
    '',
  ].join('\n'))

  const probe = join(scratch, 'probe.mjs')
  writeFileSync(probe, `
import assert from 'node:assert/strict'
import * as mod from '${PKG.name}'
import def from '${PKG.name}'

const { SemanticGroundingCore, tableKindPlugin, eventKindPlugin, conceptKindPlugin,
        DataSourceRegistry, loadTables, loadEvents, WriteValidationError } = mod

assert.equal(typeof SemanticGroundingCore, 'function', 'SemanticGroundingCore is exported')
assert.equal(def, SemanticGroundingCore, 'default export is the core class')
assert.equal(mod.SemanticLayerService, undefined, 'no SemanticLayerService back-compat alias (slice 2 ③)')
assert.equal(mod.getCorpusVersion, undefined, 'getCorpusVersion stays off the barrel (ADR-0002 (a))')
assert.equal(mod.registerInvalidationHook, undefined, 'registerInvalidationHook withheld (known multi-instance hazard)')

// ADR-0003: the v0.1 name-level allow-list, pinned exactly. Adding a name to
// src/index.ts without recorded (a)/(b)/(c) evidence turns this red; removing
// one does too. Type-only names are pinned by the ADR's table, not here
// (Object.keys cannot see them).
//
// #18 (ADR-0004 ruling 8) added 'StaleBaselineError': the error a write path
// throws when an expected_version baseline no longer matches the on-disk
// fingerprint, on the barrel for the same reason 'WriteValidationError' (its
// sibling error type) already was — a caller needs instanceof to tell
// "stale, re-read and retry" apart from every other write failure. The two
// new reserved-batch-slot types ('Tier2Batch', 'Tier2RecordMeta') are
// type-only and so do not appear in this runtime list (see the note above).
//
// #31 (ADR-0007) added 'UnknownFilterNamesError' + 'assertKnownFilterNames':
// the dimension-filter door — the Core discovery/listing methods throw the
// error before any scan runs (a host needs instanceof to map it onto a coded
// wire failure; StaleBaselineError precedent, evidence class (b)), and a
// fan-out caller (the MCP host's run_enrichment, three discovery methods)
// calls the guard once up front so the rejection lists BOTH dimensions'
// unknown names, not just the first leg's.
const EXPECTED_RUNTIME_NAMES = [
  'ConceptDefinitionSchema', 'DataSourceRegistry', 'DefinitionSnapshot', 'EventDefinitionSchema',
  'RelationGraph', 'SemanticGroundingCore', 'StaleBaselineError', 'TableDefinitionSchema',
  'UnknownFilterNamesError', 'WriteValidationError', 'assertKnownFilterNames', 'captureSnapshot',
  'conceptKindPlugin', 'deriveMetricRelations', 'discard',
  'dumpYaml', 'eventKindPlugin', 'extractMetricsFromEvent', 'extractMetricsFromTable',
  'invalidateCaches', 'isValidId', 'listing', 'loadConcepts', 'loadConfig', 'loadEvents',
  'loadMetricDefinitions', 'loadPending', 'loadTables', 'projectMetricCorpusItem',
  'resolveSemanticLayer', 'submit', 'tableKindPlugin', 'updateEventMeta', 'updateTableMeta',
  'wireEnrichmentLlm', 'writeEventYaml', 'writeTable',
].sort()
const names = Object.keys(mod).sort()
assert.deepEqual(names, [...EXPECTED_RUNTIME_NAMES, 'default'].sort(),
  'barrel runtime surface must equal the ADR-0003 allow-list (37 names + default), got: ' + names.join(', '))
// Headline names that must STAY off the barrel (ADR-0002/0003: convention-
// coupled, test utilities, internals). getCorpusVersion / registerInvalidationHook
// / SemanticLayerService are asserted separately above and not repeated here.
for (const absent of [
  'enrichAllDwsTables', 'discoverRelationsDeterministic', 'discoverEventRelationsDeterministic',
  'buildDimInventory', 'buildLlmPrompt', 'buildEventLlmPrompt', 'buildAltLabelsPrompt',
  'parseLlmRefs', 'parseAltLabelsResponse', 'mergeRefs', 'mergeAltLabels',
  'discoverAltLabels', 'discoverRelationsFor', 'discoverEventRelationsFor', 'discoverAltLabelsFor',
  'enrichAllEvents', 'enrichAllTablesAltLabels', 'enrichAllEventsAltLabels',
  'DimensionRefSchema', 'CaliberVariantSchema', 'metricName', 'splitMetricName',
  'inferAggregation', 'toMetricDefinition', 'metricGraphNode', 'extractMetricsFromTables',
  'buildExcludeColumns', 'inferRole', 'generateTableYaml', 'generateDimYaml',
  'ConfirmationSchema', 'CoverageDefSchema', 'SupersedesDefSchema', 'ParamFieldSchema',
  'MetricDefSchema', 'MetricDefinitionSchema', 'DisambiguationSchema', 'TableTermDefaultsSchema',
  'DimensionKeyPairSchema', 'PartitionDefSchema', 'ColumnMetaSchema', 'PartitionMetaSchema',
  'ColumnDefSchema', 'TableMetaSchema', 'canonicalizeType',
  'StandInSchemaProvider', 'clearSnapshotCache', 'getSnapshotCacheSize', 'SNAPSHOT_CACHE_MAX',
  'BasicIndex', 'buildRetrievalCorpus', 'isPlainObject',
  'loadDomains', 'loadRawDir', 'loadEventDefinition', 'loadTableDefinition', 'loadConceptDefinition',
  'loadRetrievalCorpus', 'mergeColumns', 'mergeChangedYaml', 'syncWriteDefinitions',
]) {
  assert.equal(mod[absent], undefined, absent + ' must stay off the barrel (ADR-0003)')
}

// reads work with no host
const tables = loadTables(${JSON.stringify(layer)})
assert.equal(tables.length, 1, 'loadTables reads the probe table')
assert.equal(tables[0].table_name, 'dws_probe_di')
const events = loadEvents(${JSON.stringify(layer)})
assert.equal(events.length, 1, 'loadEvents reads the probe event')

// construct + register all three kinds
const core = new SemanticGroundingCore({ semanticRoot: ${JSON.stringify(layer)}, autoEnrich: false })
const registry = new DataSourceRegistry()
const disposers = [tableKindPlugin, eventKindPlugin, conceptKindPlugin].map(p => registry.register(p))
assert.deepEqual(registry.allKinds().sort(), ['concept', 'event', 'table'], 'all three kind plugins register')
assert.equal(registry.getKind('table'), tableKindPlugin, 'getKind resolves the built-in table kind')

// W27: the disposer a host fiber must own — the contract the dsh adapter bridges
// via ctx.effect. Withdrawing a kind must actually withdraw it.
disposers[2]()
assert.deepEqual(registry.allKinds().sort(), ['event', 'table'], 'disposing a kind withdraws only that registration')

// D5: an auditable mutation with no recorder wired must throw, not write
await assert.rejects(
  () => core.updateTableMeta('dws_probe_di', { description: 'x' }),
  /D5/,
  'D5 holds end-to-end in the tarball: unwired recorder throws',
)

// the only way to audit-off is an explicit no-op recorder — code-visible by design
// #18: recordTier2Write is async (Promise<string>) in the contract; this
// double returns one to match, though 'await'-ing a plain value works too.
const recorded = []
core.setTier2Recorder({ recordTier2Write: async (...a) => { recorded.push(a); return 'probe-log-id' } })
await core.updateTableMeta('dws_probe_di', { description: 'tarball acceptance' })
assert.equal(recorded.length, 1, 'a wired recorder receives the Tier-2 write')

const graph = core.getRelationGraph()
assert.ok(graph, 'relation graph builds')
assert.equal(typeof core.corpusVersion(), 'number', 'corpusVersion() is the method dsh should use')

core.dispose()
console.log('probe-ok ' + names.length)
`)

  check('root entry loads, constructs, reads, enforces D5, disposes', () => {
    const out = execFileSync(process.execPath, [probe], { cwd: scratch, encoding: 'utf8', stdio: 'pipe' })
    const m = out.match(/probe-ok (\d+)/)
    assert(m, `probe did not report success:\n${out}`)
    return `${m[1]} runtime names on the barrel; D5 enforced with no host present`
  })

  console.error('\n── 5. subpath discipline + no host framework anywhere ──────')
  check('"./src/*" is not exported (clean error, not silent miss)', () => {
    let code = ''
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e',
        `await import('${PKG.name}/src/io.ts')`], { cwd: scratch, stdio: 'pipe' })
    } catch (err) { code = `${err.stderr ?? ''}` }
    assert(/ERR_PACKAGE_PATH_NOT_EXPORTED/.test(code),
      `expected ERR_PACKAGE_PATH_NOT_EXPORTED, got:\n${code.slice(0, 400)}`)
    return 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  })
  check('the retired shell subpath is gone', () => {
    // Slice 4a moved `llm-wiring-plugin` into the dsh adapter. Assert the
    // subpath is actually retired rather than merely unused: a stale `exports`
    // entry pointing at a file the build no longer emits would otherwise sit
    // there until some host tried to mount it.
    assert(!('./llm-wiring-plugin' in PKG.exports),
      'package.json still declares the "./llm-wiring-plugin" subpath')
    const stale = entries.filter(e => e.includes('llm-wiring-plugin'))
    assert(stale.length === 0, `tarball still ships: ${stale.join(', ')}`)
    let code = ''
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e',
        `await import('${PKG.name}/llm-wiring-plugin')`], { cwd: scratch, stdio: 'pipe' })
    } catch (err) { code = `${err.stderr ?? ''}` }
    assert(/ERR_PACKAGE_PATH_NOT_EXPORTED/.test(code),
      `expected ERR_PACKAGE_PATH_NOT_EXPORTED, got:\n${code.slice(0, 400)}`)
    return `exports is down to ${Object.keys(PKG.exports).join(' + ')}`
  })
  check('NO shipped file names a host framework (no exemptions left)', () => {
    const offenders = []
    for (const [file, source] of shipped) {
      const bad = [...importsOf(source)].filter(s => HOST_FRAMEWORKS.includes(bareRoot(s)))
      if (bad.length) offenders.push(`${file} → ${bad.join(', ')}`)
    }
    assert(offenders.length === 0, offenders.join('\n'))
    return `${shipped.size} shipped files, zero host-framework imports`
  })
  check('peerDependencies is empty — the substrate needs no host', () => {
    const peers = Object.keys(PKG.peerDependencies ?? {})
    assert(peers.length === 0,
      `the substrate declares peers it should not need: ${peers.join(', ')}. ` +
      'schemastery and dsh-llm existed only for the shell that moved to the adapter in slice 4a; ' +
      'cordis was type-only. If one is genuinely needed again, that is a host coupling — say why.')
    return 'zero peers; runtime deps are ' + Object.keys(PKG.dependencies ?? {}).join(' + ')
  })
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.error('')
if (failures.length) {
  console.error(`✗ tarball acceptance FAILED — ${failures.length} check(s)\n`)
  for (const f of failures) console.error(`  ${f.label}\n    ${f.message}`)
  console.error('\nSee map #1 (Destination) and GLOSSARY.md § negation test.\n')
  process.exit(1)
}
for (const n of notes) console.error(`  ! ${n}`)
console.error('✓ tarball acceptance: the shipped artifact is a host-neutral substrate\n')

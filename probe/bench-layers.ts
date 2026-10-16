/**
 * #178 probe A — in-process, per-layer breakdown of what `get_definition` does,
 * compared against `list_definitions` / `get_scope`'s corpus work.
 *
 * Imports the substrate SOURCE (not lib/) so the two internal probe counters are
 * reachable: `_getReadYamlCount` (io-probes.ts — one tick per YAML file parsed) and
 * `_memoryIndexProbeCounts` (memory.ts — stats/parses per refresh). Every timed
 * iteration opens a FRESH read epoch, which is exactly what the MCP server does per
 * tool call (`server.ts` epochWrapped → `SemanticGroundingCore.withReadEpoch`).
 */
import { SemanticGroundingCore } from '../packages/substrate/src/index.ts'
import { _getReadYamlCount, _resetReadYamlCount } from '../packages/substrate/src/io-probes.ts'
import { _memoryIndexProbeCounts, _memoryIndexProbeReset } from '../packages/substrate/src/memory.ts'
import { definitionVersion } from '../packages/substrate/src/io.ts'
import { buildCorpus, dirStats } from './corpus.mjs'

const N = Number(process.env.PROBE_N ?? 25)
const WARMUP = 5

interface Sample { readonly ms: number; readonly yaml: number }

function stats(xs: number[]): { p50: number; p90: number; mean: number; min: number } {
  const s = [...xs].sort((a, b) => a - b)
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))] as number
  return { p50: q(0.5), p90: q(0.9), mean: s.reduce((a, b) => a + b, 0) / s.length, min: s[0] as number }
}
const r2 = (x: number): number => Math.round(x * 100) / 100

/** Time one closure, also reporting how many YAML files it parsed. */
function timed<T>(fn: () => T): { out: T; sample: Sample } {
  _resetReadYamlCount()
  const t0 = performance.now()
  const out = fn()
  const ms = performance.now() - t0
  return { out, sample: { ms, yaml: _getReadYamlCount() } }
}

interface LayerRun {
  readonly load: Sample[]
  readonly version: Sample[]
  readonly memories: Sample[]
  readonly queries: Sample[]
  readonly whole: number[]
}

function runGetDefinition(core: SemanticGroundingCore, root: string, kind: 'table' | 'event', name: string, window: boolean): LayerRun {
  const acc: LayerRun = { load: [], version: [], memories: [], queries: [], whole: [] }
  const opts = window ? { data_window: { from: '2026-09-01', to: '2026-09-30' } } : {}
  for (let i = 0; i < N + WARMUP; i++) {
    // One fresh epoch per iteration = one MCP tool call.
    const row = SemanticGroundingCore.withReadEpoch(() => {
      const t0 = performance.now()
      // layer 1+2: the definition load and its sha256 fingerprint, as
      // `load{Table,Event}DefinitionWithVersion` performs them.
      const a = timed(() => kind === 'table' ? core.loadTableDefinition(name) : core.loadEventDefinition(name))
      const b = timed(() => definitionVersion(root, kind, name))
      // layer 3: ADR-0024 read surface (+ ADR-0026 dangling + ADR-0027 contested)
      const c = timed(() => core.readDefinitionMemories(`${kind}:${name}`, opts))
      // layer 4: ADR-0025 verified queries via forward `uses` scan (table/concept only)
      const d = kind === 'table' ? timed(() => core.verifiedQueriesFor(`table:${name}`)) : { out: [], sample: { ms: 0, yaml: 0 } }
      const whole = performance.now() - t0
      return { a: a.sample, b: b.sample, c: c.sample, d: d.sample, whole }
    })
    if (i < WARMUP) continue
    acc.load.push(row.a); acc.version.push(row.b); acc.memories.push(row.c); acc.queries.push(row.d); acc.whole.push(row.whole)
  }
  return acc
}

function summarizeLayer(name: string, ss: readonly Sample[]): Record<string, unknown> {
  return { layer: name, ...stats(ss.map(s => s.ms)), yaml_parses: ss[0]?.yaml ?? 0 }
}

function timeTool(label: string, core: SemanticGroundingCore, fn: () => unknown): Record<string, unknown> {
  const xs: number[] = []
  let yaml = 0
  for (let i = 0; i < N + WARMUP; i++) {
    const row = SemanticGroundingCore.withReadEpoch(() => timed(fn))
    if (i < WARMUP) continue
    xs.push(row.sample.ms)
    yaml = row.sample.yaml
  }
  return { tool: label, ...stats(xs), yaml_parses: yaml }
}

const variants = [
  { label: 'mem=0,q=0 (零 memory 语料)', memories: 0, queries: 0 },
  { label: 'mem=12,q=5 (X63 接力实测量级)', memories: 12, queries: 5 },
  { label: 'mem=100,q=20', memories: 100, queries: 20 },
  { label: 'mem=500,q=50', memories: 500, queries: 50 },
]

const out: Record<string, unknown>[] = []
for (const v of variants) {
  const root = `/tmp/sg178-corpus-m${v.memories}`
  const built = buildCorpus({ root, tables: 61, events: 110, memories: v.memories, queries: v.queries, withGit: false })
  const size = dirStats(root)
  const core = new SemanticGroundingCore({ semanticRoot: root, scopeId: 'probe-x63' })
  const table = built.tableNames[0] as string
  const event = built.eventNames[0] as string

  _memoryIndexProbeReset()
  // cold: the very first call in the process pays the memory index build
  const cold = SemanticGroundingCore.withReadEpoch(() => {
    const t0 = performance.now()
    core.loadTableDefinition(table)
    definitionVersion(root, 'table', table)
    core.readDefinitionMemories(`table:${table}`, {})
    core.verifiedQueriesFor(`table:${table}`)
    return performance.now() - t0
  })
  const coldIdx = _memoryIndexProbeCounts()
  _memoryIndexProbeReset()

  const tbl = runGetDefinition(core, root, 'table', table, false)
  const tblWin = runGetDefinition(core, root, 'table', table, true)
  const evt = runGetDefinition(core, root, 'event', event, false)
  const warmIdx = _memoryIndexProbeCounts()

  const list = timeTool('list_definitions (projectGraphNodes includeDerived)', core, () => core.projectGraphNodes({ includeDerived: true }))
  const scope = timeTool('get_scope (countNodesByKind = projectGraphNodes no-derived)', core, () => core.projectGraphNodes({ includeDerived: false }).length)

  out.push({
    variant: v.label,
    corpus: { root, files: size.files, bytes: size.bytes, tables: 61, events: 110, concepts: 10, memories: v.memories, queries: v.queries },
    get_definition_table: {
      whole: { ...stats(tbl.whole) },
      layers: [
        summarizeLayer('1 corpus 文件 I/O + YAML 解析 (loadTableDefinition)', tbl.load),
        summarizeLayer('2 指纹 sha256 (definitionVersion)', tbl.version),
        summarizeLayer('3 memory 投影 (ADR-0024/0026/0027)', tbl.memories),
        summarizeLayer('4 verified_queries (ADR-0025 uses 正扫)', tbl.queries),
      ],
    },
    get_definition_table_with_window: { whole: { ...stats(tblWin.whole) }, memories_layer: summarizeLayer('3 memory 投影 (带 data_window)', tblWin.memories) },
    get_definition_event: {
      whole: { ...stats(evt.whole) },
      layers: [
        summarizeLayer('1 corpus 文件 I/O + YAML 解析 (loadEventDefinition)', evt.load),
        summarizeLayer('2 指纹 sha256', evt.version),
        summarizeLayer('3 memory 投影', evt.memories),
      ],
    },
    comparisons: [list, scope],
    cold_first_call_ms: r2(cold),
    memory_index: { cold: coldIdx, warm_total_over_runs: warmIdx },
  })
  console.error(`[probe] variant done: ${v.label}`)
}

console.log(JSON.stringify(out, null, 2))

/**
 * #178 probe E — how the per-call cost scales with corpus size, so "how much to
 * optimize" is answered against the trajectory rather than today's single point.
 * X63 today = 171 definitions; k11 (the biggest corpus this repo has) = 774.
 */
import { SemanticGroundingCore } from '../packages/substrate/src/index.ts'
import { definitionVersion } from '../packages/substrate/src/io.ts'
import { buildCorpus } from './corpus.mjs'

const N = 15, WARMUP = 3
const r2 = (x: number): number => Math.round(x * 100) / 100
function p50(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return r2(s[Math.floor(s.length / 2)] as number) }

const scales = [
  { label: 'X63 实测规模 61 表 + 110 事件 = 171', tables: 61, events: 110 },
  { label: '2× 规模 122 表 + 220 事件 = 342', tables: 122, events: 220 },
  { label: 'k11 全量 321 表 + 453 事件 = 774', tables: 321, events: 453 },
]

const out = []
for (const s of scales) {
  const root = `/tmp/sg178-scale-${s.tables}`
  const built = buildCorpus({ root, tables: s.tables, events: s.events, memories: 12, queries: 5, withGit: false })
  const core = new SemanticGroundingCore({ semanticRoot: root, scopeId: 'probe-x63' })
  const table = built.tableNames[0] as string
  const run = (fn: () => unknown): number => {
    const xs: number[] = []
    for (let i = 0; i < N + WARMUP; i++) {
      const t = SemanticGroundingCore.withReadEpoch(() => { const t0 = performance.now(); fn(); return performance.now() - t0 })
      if (i >= WARMUP) xs.push(t)
    }
    return p50(xs)
  }
  core.readDefinitionMemories(`table:${table}`, {}) // warm the process-resident memory index
  const withMem = run(() => {
    core.loadTableDefinition(table)
    definitionVersion(root, 'table', table)
    core.readDefinitionMemories(`table:${table}`, {})
    core.verifiedQueriesFor(`table:${table}`)
  })
  const rootNoMem = `${root}-nomem`
  const builtNoMem = buildCorpus({ root: rootNoMem, tables: s.tables, events: s.events, memories: 0, queries: 0, withGit: false })
  const coreNoMem = new SemanticGroundingCore({ semanticRoot: rootNoMem, scopeId: 'probe-x63' })
  const tableNoMem = builtNoMem.tableNames[0] as string
  const noMem = run(() => {
    coreNoMem.loadTableDefinition(tableNoMem)
    definitionVersion(rootNoMem, 'table', tableNoMem)
    coreNoMem.readDefinitionMemories(`table:${tableNoMem}`, {})
    coreNoMem.verifiedQueriesFor(`table:${tableNoMem}`)
  })
  const list = run(() => core.projectGraphNodes({ includeDerived: true }))
  out.push({ scale: s.label, definitions: s.tables + s.events, get_definition_table_with_memory_ms: withMem, get_definition_table_zero_memory_ms: noMem, list_definitions_ms: list })
  console.error(`[probe] scale done: ${s.label}`)
}
console.log(JSON.stringify(out, null, 2))

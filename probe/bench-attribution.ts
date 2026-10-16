/**
 * #178 probe C — attribution inside the memory projection, and the upside of the one
 * candidate fix.
 *
 * Probe A showed `readDefinitionMemories` costs ~23 ms on a table read once the corpus
 * holds ANY memory. This splits that number: `buildAnchorUniverse` (memory.ts) calls
 * loadConcepts + loadTables + loadEvents + loadRawDir('queries') on EVERY read, and only
 * the tables/events halves can ride the ADR-0015 read epoch — which on a *table* read is
 * a miss for events, because a table read otherwise never touches events/.
 *
 * The "shared scan" row simulates the fix: if the universe (or its loaders) were cached
 * per (root × corpusVersion) instead of rebuilt per call, the projection would only pay
 * the set/map building. Measured by pre-warming the epoch, which is the same arithmetic.
 */
import { SemanticGroundingCore } from '../packages/substrate/src/index.ts'
import { buildAnchorUniverse } from '../packages/substrate/src/memory.ts'
import { loadConcepts, loadEvents, loadRawDir, loadTables, definitionVersion } from '../packages/substrate/src/io.ts'
import { buildCorpus } from './corpus.mjs'

const N = Number(process.env.PROBE_N ?? 25)
const WARMUP = 5
const r3 = (x: number): number => Math.round(x * 1000) / 1000
function p50(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return r3(s[Math.floor(s.length / 2)] as string as unknown as number)
}
function bench(fn: () => unknown): number {
  const xs: number[] = []
  for (let i = 0; i < N + WARMUP; i++) {
    const t = SemanticGroundingCore.withReadEpoch(() => {
      const t0 = performance.now()
      fn()
      return performance.now() - t0
    })
    if (i >= WARMUP) xs.push(t)
  }
  return p50(xs)
}

const root = '/tmp/sg178-attr'
const built = buildCorpus({ root, tables: 61, events: 110, memories: 12, queries: 5, withGit: false })
const core = new SemanticGroundingCore({ semanticRoot: root, scopeId: 'probe-x63' })
const table = built.tableNames[0] as string

// Warm the memory anchor index once (process-resident; steady state is what a long-lived
// MCP server sees).
core.readDefinitionMemories(`table:${table}`, {})

const rows: Record<string, unknown>[] = []
rows.push({ step: 'loadTables (61 表 YAML)', p50_ms: bench(() => loadTables(root)) })
rows.push({ step: 'loadEvents (110 事件 YAML)', p50_ms: bench(() => loadEvents(root)) })
rows.push({ step: 'loadConcepts (10 概念 YAML，epoch 外)', p50_ms: bench(() => loadConcepts(root)) })
rows.push({ step: "loadRawDir('queries') (5 已验证查询，epoch 外)", p50_ms: bench(() => loadRawDir(root, 'queries')) })
rows.push({ step: 'buildAnchorUniverse 全量（冷 epoch = 真实每次调用）', p50_ms: bench(() => buildAnchorUniverse(root)) })
rows.push({
  step: 'buildAnchorUniverse（表/事件已在本 epoch 读过 = 只剩建表开销）',
  p50_ms: bench(() => { loadTables(root); loadEvents(root); return buildAnchorUniverse(root) }) - bench(() => { loadTables(root); loadEvents(root) }),
})
rows.push({ step: 'readDefinitionMemories（冷 epoch = 现状）', p50_ms: bench(() => core.readDefinitionMemories(`table:${table}`, {})) })
rows.push({
  step: 'readDefinitionMemories（表/事件扫描已共享 = 修好后的量级）',
  p50_ms: bench(() => { loadTables(root); loadEvents(root); return core.readDefinitionMemories(`table:${table}`, {}) }) - bench(() => { loadTables(root); loadEvents(root) }),
})
rows.push({ step: 'verifiedQueriesFor（queries/ 第二次解析）', p50_ms: bench(() => core.verifiedQueriesFor(`table:${table}`)) })

// What a whole get_definition(table) call costs today vs. with the scan shared.
const today = bench(() => {
  core.loadTableDefinition(table)
  definitionVersion(root, 'table', table)
  core.readDefinitionMemories(`table:${table}`, {})
  core.verifiedQueriesFor(`table:${table}`)
})
const sharedScanFloor = bench(() => {
  // the floor if the whole corpus read were cached across calls: only the work that is
  // genuinely per-call (fingerprint + projection composition) remains
  definitionVersion(root, 'table', table)
})

// Payload shape: the biggest table in the sample, as the agent receives it.
let biggest = { name: '', bytes: 0 }
for (const name of built.tableNames) {
  const def = core.loadTableDefinition(name)
  const bytes = JSON.stringify(def ?? {}).length
  if (bytes > biggest.bytes) biggest = { name, bytes }
}

console.log(JSON.stringify({
  corpus: { root, tables: 61, events: 110, concepts: 10, memories: 12, queries: 5 },
  attribution: rows,
  whole_get_definition_table_ms: r3(today),
  fingerprint_only_floor_ms: r3(sharedScanFloor),
  biggest_table_payload: biggest,
}, null, 2))

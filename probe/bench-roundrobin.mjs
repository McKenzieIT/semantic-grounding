/**
 * #178 probe F — the ticket's actual claim, A/B'd fairly: one live stdio server,
 * get_definition / get_scope / list_definitions / search_definitions interleaved
 * round-robin so machine drift hits every tool equally.
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildCorpus } from './corpus.mjs'

const W = '/Users/mckenzie/workspace/sg-research-178'
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 30)
const WARMUP = 3
const round2 = (x) => Math.round(x * 100) / 100

const root = '/tmp/sg178-rr'
const scopeId = 'probe-x63'
const built = buildCorpus({ root, tables: 61, events: 110, memories: 12, queries: 5, withGit: true, scopeId })
const registry = '/tmp/sg178-rr-registry.yaml'
writeFileSync(registry, `active: ${scopeId}\nscopes:\n  ${scopeId}:\n    semanticRoot: ${root}\n    name: ${scopeId}\n    registeredAt: '2026-10-16T00:00:00Z'\n    registeredBy: probe\n`, 'utf8')

const child = spawn(process.execPath, [join(W, 'packages/mcp/src/bin.ts')], {
  env: { ...process.env, SG_REGISTRY: registry, SG_SCOPE: scopeId, SG_AGENT_ID: 'probe-agent' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let stderr = ''
child.stderr.setEncoding('utf8'); child.stderr.on('data', d => { stderr += d })
let buf = ''
const pending = new Map()
let nextId = 1
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.id !== undefined && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); r({ m, bytes: line.length }) }
  }
})
const send = (method, params) => new Promise((res) => {
  const id = nextId++
  pending.set(id, res)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})

await send('initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'sg178-rr', version: '0.0.1' } })
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')

const table = built.tableNames[0]
const calls = {
  'get_definition(table,+data_window)': { name: 'get_definition', arguments: { kind: 'table', name: table, data_window: { from: '2026-09-01', to: '2026-09-30' } } },
  'get_definition(table)': { name: 'get_definition', arguments: { kind: 'table', name: table } },
  get_scope: { name: 'get_scope', arguments: {} },
  list_definitions: { name: 'list_definitions', arguments: {} },
  search_definitions: { name: 'search_definitions', arguments: { query: '付费 渠道 留存' } },
}
const acc = Object.fromEntries(Object.keys(calls).map(k => [k, { ms: [], bytes: 0 }]))
for (let r = 0; r < ROUNDS + WARMUP; r++) {
  for (const [label, params] of Object.entries(calls)) {
    const t0 = performance.now()
    const { m, bytes } = await send('tools/call', params)
    const ms = performance.now() - t0
    if (m.error) throw new Error(label + ': ' + JSON.stringify(m.error) + stderr)
    if (r < WARMUP) continue
    acc[label].ms.push(ms); acc[label].bytes = bytes
  }
}
const out = Object.entries(acc).map(([label, v]) => {
  const s = [...v.ms].sort((a, b) => a - b)
  return {
    call: label,
    p50: round2(s[Math.floor(s.length / 2)]),
    p90: round2(s[Math.floor(s.length * 0.9)]),
    min: round2(s[0]),
    max: round2(s[s.length - 1]),
    response_bytes: v.bytes,
  }
})
console.log(JSON.stringify({ rounds: ROUNDS, corpus: { root, tables: 61, events: 110, memories: 12, queries: 5 }, results: out }, null, 2))
child.kill()
process.exit(0)

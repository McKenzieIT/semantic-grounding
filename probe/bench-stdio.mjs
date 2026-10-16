/**
 * #178 probe B — the same tools over the REAL deployment seam: `src/bin.ts` spawned as a
 * child process, newline-delimited JSON-RPC over stdio, exactly what QoderWork/qodercli
 * drive. Measures per-call wall clock as the CLIENT sees it (transport + handler) and the
 * response payload size, so the transport layer can be told apart from the read path.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildCorpus, dirStats } from './corpus.mjs'

const W = '/Users/mckenzie/workspace/sg-research-178'
const N = Number(process.env.PROBE_N ?? 20)
const WARMUP = 3

class StdioClient {
  constructor(child) {
    this.child = child
    this.buf = ''
    this.pending = new Map()
    this.nextId = 1
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      this.buf += chunk
      let nl
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (line === '') continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, bytes } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          resolve({ msg, bytes: line.length })
        }
      }
    })
  }

  send(method, params) {
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(payload + '\n')
    })
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
}

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b)
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { p50: round(q(0.5)), p90: round(q(0.9)), mean: round(s.reduce((a, b) => a + b, 0) / s.length), min: round(s[0]), max: round(s[s.length - 1]) }
}
const round = (x) => Math.round(x * 100) / 100

async function runVariant(label, memories, queries) {
  const root = `/tmp/sg178-stdio-m${memories}`
  const scopeId = 'probe-x63'
  const built = buildCorpus({ root, tables: 61, events: 110, memories, queries, withGit: true, scopeId })
  const registry = `/tmp/sg178-registry-m${memories}.yaml`
  mkdirSync(dirname(registry), { recursive: true })
  writeFileSync(registry, [
    `active: ${scopeId}`,
    'scopes:',
    `  ${scopeId}:`,
    `    semanticRoot: ${root}`,
    `    name: ${scopeId}`,
    "    registeredAt: '2026-10-16T00:00:00Z'",
    '    registeredBy: probe',
    '',
  ].join('\n'), 'utf8')

  const t0 = performance.now()
  const child = spawn(process.execPath, [join(W, 'packages/mcp/src/bin.ts')], {
    env: { ...process.env, SG_REGISTRY: registry, SG_SCOPE: scopeId, SG_AGENT_ID: 'probe-agent' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', d => { stderr += d })
  const client = new StdioClient(child)

  const init = await client.send('initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'sg178-probe', version: '0.0.1' },
  })
  client.notify('notifications/initialized', {})
  const startupMs = performance.now() - t0
  if (init.msg.error) throw new Error('initialize failed: ' + JSON.stringify(init.msg.error) + ' stderr=' + stderr)

  const table = built.tableNames[0]
  const event = built.eventNames[0]
  const calls = [
    ['get_definition(table)', { name: 'get_definition', arguments: { kind: 'table', name: table } }],
    ['get_definition(table,+data_window)', { name: 'get_definition', arguments: { kind: 'table', name: table, data_window: { from: '2026-09-01', to: '2026-09-30' } } }],
    ['get_definition(event)', { name: 'get_definition', arguments: { kind: 'event', name: event } }],
    ['get_scope', { name: 'get_scope', arguments: {} }],
    ['list_definitions', { name: 'list_definitions', arguments: {} }],
    ['search_definitions', { name: 'search_definitions', arguments: { query: '付费 渠道 留存' } }],
    ['resolve_alias', { name: 'resolve_alias', arguments: { term: 'ds' } }],
  ]

  const results = []
  for (const [label2, params] of calls) {
    const xs = []
    let bytes = 0
    let firstMs = null
    let errored = null
    for (let i = 0; i < N + WARMUP; i++) {
      const s = performance.now()
      const { msg, bytes: b } = await client.send('tools/call', params)
      const ms = performance.now() - s
      if (msg.error) { errored = JSON.stringify(msg.error).slice(0, 200); break }
      if (msg.result?.isError) { errored = JSON.stringify(msg.result?.content?.[0]?.text ?? '').slice(0, 300) }
      if (i === 0) firstMs = round(ms)
      if (i < WARMUP) continue
      xs.push(ms)
      bytes = b
    }
    results.push({ call: label2, ...(xs.length ? stats(xs) : {}), first_call_ms: firstMs, response_bytes: bytes, error: errored })
  }

  child.stdin.end()
  child.kill()
  return { variant: label, corpus: { root, ...dirStats(root), memories, queries }, startup_to_initialized_ms: round(startupMs), results, stderr_head: stderr.split('\n').slice(0, 6) }
}

const out = []
out.push(await runVariant('mem=0,q=0 (零 memory 语料)', 0, 0))
console.error('[probe] stdio variant 1 done')
out.push(await runVariant('mem=12,q=5 (X63 接力实测量级)', 12, 5))
console.error('[probe] stdio variant 2 done')
out.push(await runVariant('mem=100,q=20', 100, 20))
console.error('[probe] stdio variant 3 done')
console.log(JSON.stringify(out, null, 2))
process.exit(0)

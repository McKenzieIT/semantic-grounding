/**
 * #178 probe D — the cost floor of a stat-validated corpus cache (the shape ADR-0023 R1
 * already uses for the memory anchor index), measured at X63 scale: one readdir + one
 * stat per definition file vs. the full YAML re-parse the read path does today.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = '/tmp/sg178-attr'
const N = 50

function walkFiles(dir) {
  const out = []
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walkFiles(p))
    else if (e.name.endsWith('.yaml')) out.push(p)
  }
  return out
}

const files = [...walkFiles(join(root, 'tables')), ...walkFiles(join(root, 'events')), ...walkFiles(join(root, 'concepts')), ...walkFiles(join(root, 'queries'))]
const xs = []
for (let i = 0; i < N; i++) {
  const t0 = performance.now()
  const list = [...walkFiles(join(root, 'tables')), ...walkFiles(join(root, 'events')), ...walkFiles(join(root, 'concepts')), ...walkFiles(join(root, 'queries'))]
  let n = 0
  for (const f of list) { const st = statSync(f); n += st.size + st.mtimeMs }
  xs.push(performance.now() - t0)
}
xs.sort((a, b) => a - b)
console.log(JSON.stringify({
  files: files.length,
  readdir_plus_stat_p50_ms: Math.round(xs[Math.floor(xs.length / 2)] * 1000) / 1000,
  readdir_plus_stat_min_ms: Math.round(xs[0] * 1000) / 1000,
}, null, 2))

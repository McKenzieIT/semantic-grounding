/**
 * #178 probe: build a synthetic corpus at X63 scale (61 tables + 110 events = 171 DW
 * definitions) by sampling the k11 fixture, plus N memory entries and Q verified queries.
 *
 * Real X63 (scope 10000354) lives in its own repository and is NOT available on this
 * machine — k11 (321 tables / 453 events, same shape, same generator) sampled down to
 * X63's counts is the stand-in. Per-file sizes are reported so the substitution is auditable.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const W = '/Users/mckenzie/workspace/sg-research-178'
export const K11 = join(W, 'packages/substrate/tests/fixtures/k11')

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Deterministic pseudo-random so every run builds the identical corpus. */
function mulberry32(seed) {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * @param opts {{root:string, tables:number, events:number, memories:number, queries:number, withGit?:boolean, scopeId?:string}}
 */
export function buildCorpus(opts) {
  const { root, tables, events, memories, queries } = opts
  const scopeId = opts.scopeId ?? 'probe-x63'
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'tables'), { recursive: true })
  mkdirSync(join(root, 'concepts'), { recursive: true })

  // ── tables: first N of k11's, name-sorted (deterministic)
  const tableFiles = readdirSync(join(K11, 'tables')).filter(f => f.endsWith('.yaml')).sort().slice(0, tables)
  const tableNames = []
  for (const f of tableFiles) {
    cpSync(join(K11, 'tables', f), join(root, 'tables', f))
    tableNames.push(f.replace(/\.yaml$/, ''))
  }

  // ── events: first M across domain dirs, preserving the domain subdir layout
  const eventNames = []
  let taken = 0
  for (const domain of readdirSync(join(K11, 'events')).sort()) {
    const dp = join(K11, 'events', domain)
    if (!statSync(dp).isDirectory()) continue
    for (const f of readdirSync(dp).filter(x => x.endsWith('.yaml') && x !== '_index.yaml').sort()) {
      if (taken >= events) break
      mkdirSync(join(root, 'events', domain), { recursive: true })
      cpSync(join(dp, f), join(root, 'events', domain, f))
      eventNames.push(f.replace(/\.yaml$/, ''))
      taken += 1
    }
    if (taken >= events) break
  }

  // ── concepts: all of k11's (10)
  for (const f of readdirSync(join(K11, 'concepts')).filter(x => x.endsWith('.yaml'))) {
    cpSync(join(K11, 'concepts', f), join(root, 'concepts', f))
  }
  cpSync(join(K11, 'domains.yaml'), join(root, 'domains.yaml'))
  writeFileSync(join(root, 'config.yaml'), `scope_id: ${scopeId}\nproject:\n  name: ${scopeId}\n`, 'utf8')

  // ── memory/<id>.yaml, hand-written in the stored shape (ADR-0023 R1/R3/R5).
  // Spread over node, column and edge anchors so the read projection does real work.
  if (memories > 0) mkdirSync(join(root, 'memory'), { recursive: true })
  const rnd = mulberry32(178)
  const types = ['observation', 'practice', 'incident', 'inference', 'caveat']
  const b32 = 'abcdefghijklmnopqrstuvwxyz234567'
  for (let i = 0; i < memories; i++) {
    let suffix = ''
    for (let k = 0; k < 8; k++) suffix += b32[Math.floor(rnd() * 32)]
    const id = `mem-2026091${i % 10}-${suffix}`
    const type = types[i % types.length]
    const t = tableNames[i % tableNames.length]
    const e = eventNames[i % eventNames.length]
    // every 3rd entry anchors on a column fragment, every 5th on an edge
    const anchors = i % 5 === 4
      ? [`table:${t} -joins-> table:${tableNames[(i + 1) % tableNames.length]}`]
      : i % 3 === 0
        ? [`table:${t}#ds`]
        : i % 2 === 0 ? [`table:${t}`] : [`event:${e}`]
    const windowed = type === 'incident' || type === 'observation'
    writeFileSync(join(root, 'memory', `${id}.yaml`), [
      `id: ${id}`,
      `type: ${type}`,
      'anchors:',
      ...anchors.map(a => `- ${JSON.stringify(a)}`),
      `body: ${JSON.stringify(`第 ${i} 条 probe memory：口径/坑位正文，长度接近真实条目的一两句话描述。`)}`,
      `basis: ${JSON.stringify('probe 合成证据')}`,
      ...windowed ? [`valid_from: '2026-09-0${(i % 9) + 1}'`, `valid_until: '2026-09-${10 + (i % 19)}'`] : [],
      'recorded:',
      `  session: probe-session-${i % 7}`,
      '  agent: probe-agent',
      `  at: '2026-09-${String((i % 28) + 1).padStart(2, '0')}T08:00:00Z'`,
    ].join('\n') + '\n', 'utf8')
  }

  // ── queries/<name>.yaml (ADR-0025 R1): uses anchors on the first tables
  if (queries > 0) mkdirSync(join(root, 'queries'), { recursive: true })
  for (let i = 0; i < queries; i++) {
    const name = `vq_probe_${String(i).padStart(3, '0')}`
    const uses = [`table:${tableNames[i % tableNames.length]}`, `table:${tableNames[(i + 3) % tableNames.length]}`]
    writeFileSync(join(root, 'queries', `${name}.yaml`), [
      `name: ${name}`,
      `question: ${JSON.stringify(`探针问题 ${i}：上个月付费用户的渠道留存怎么算`)}`,
      'alt_questions:',
      `- ${JSON.stringify(`同问异说 ${i}`)}`,
      `sql: ${JSON.stringify(`SELECT ds, COUNT(1) FROM ${uses[0].slice(6)} WHERE ds BETWEEN \${from} AND \${to} GROUP BY ds`)}`,
      'uses:',
      ...uses.map(u => `- ${JSON.stringify(u)}`),
      `description: ${JSON.stringify('probe 合成已验证查询')}`,
    ].join('\n') + '\n', 'utf8')
  }

  if (opts.withGit !== false) {
    git(['init', '--quiet', '--initial-branch=main', '.'], root)
    git(['config', 'user.name', 'Probe Human'], root)
    git(['config', 'user.email', 'probe@local'], root)
    git(['config', 'commit.gpgsign', 'false'], root)
    git(['config', 'gc.auto', '0'], root)
    git(['add', '-A'], root)
    git(['commit', '--quiet', '-m', 'probe corpus baseline'], root)
  }

  return { root, tableNames, eventNames, scopeId }
}

/** Total bytes + file count under a dir (for the corpus-size report). */
export function dirStats(dir) {
  let bytes = 0, files = 0
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else { bytes += st.size; files += 1 }
    }
  }
  walk(dir)
  return { bytes, files }
}

/** PROTOTYPE — #37 §3 作用域裁决的实测输入：存活的垃圾词有多少是跨定义重复的。
 *  「如果同一个垃圾词在 300 张表上各否决一遍，per-definition 就是个笑话」—— 这是那个数。 */
import { readFileSync } from 'node:fs'
const data = JSON.parse(readFileSync('/tmp/sg-guardrail-probe/out/probe-data.json', 'utf8'))
const rows = data.rows as Array<{ t: string; d: string; k: string; s: string; x: string; l: number; r: string[]; f: string[] }>
const CAP = 24
const ON = new Set(data.rules.filter((r: any) => r.on).map((r: any) => r.id))
const kb = (r: any) => { const o = r.r.filter((id: string) => ON.has(id)); if (r.l > CAP) o.push(`len>${CAP}`); return o }
const surv = rows.filter(r => kb(r).length === 0)

// 每个存活词覆盖多少个不同定义
const defsPerWord = new Map<string, Set<string>>()
for (const r of surv) {
  if (!defsPerWord.has(r.t)) defsPerWord.set(r.t, new Set())
  defsPerWord.get(r.t)!.add(r.d)
}
const spread = [...defsPerWord.entries()].map(([t, s]) => ({ t, n: s.size })).sort((a, b) => b.n - a.n)

const bucket = (lo: number, hi: number) => spread.filter(x => x.n >= lo && x.n <= hi)
const occOf = (ws: { t: string }[]) => { const set = new Set(ws.map(w => w.t)); return surv.filter(r => set.has(r.t)).length }

console.log(`存活合计 ${surv.length} 次 / ${spread.length} 个不同的词`)
console.log(`平均每个词出现在 ${(surv.length / spread.length).toFixed(2)} 个定义上\n`)

console.log('| 覆盖定义数 | 词种 | 占词种 | 这些词的出现次数 | 占全部存活 |')
console.log('|---|---:|---:|---:|---:|')
for (const [lo, hi, label] of [[1, 1, '只 1 个定义（纯局部）'], [2, 4, '2–4'], [5, 19, '5–19'], [20, 99, '20–99'], [100, 1e9, '≥100（全库级）']] as const) {
  const b = bucket(lo, hi as number)
  const occ = occOf(b)
  console.log(`| ${label} | ${b.length} | ${((b.length / spread.length) * 100).toFixed(1)}% | ${occ} | ${((occ / surv.length) * 100).toFixed(1)}% |`)
}

console.log('\n── 跨定义最广的 20 个存活词 ──')
for (const x of spread.slice(0, 20)) {
  const src = [...new Set(surv.filter(r => r.t === x.t).map(r => r.s))].join('+')
  console.log(`  ${String(x.n).padStart(4)} 个定义  [${src.padEnd(6)}] ${JSON.stringify(x.t)}`)
}

// 去掉 domain 分支后再看一遍（domain 已裁「保留」，必然全库重复）
const nd = surv.filter(r => r.s !== 'domain')
const ndDefs = new Map<string, Set<string>>()
for (const r of nd) { if (!ndDefs.has(r.t)) ndDefs.set(r.t, new Set()); ndDefs.get(r.t)!.add(r.d) }
const ndSpread = [...ndDefs.entries()].map(([t, s]) => ({ t, n: s.size })).sort((a, b) => b.n - a.n)
console.log(`\n── 只看正文抽取（扣掉 domain 分支）──`)
console.log(`${nd.length} 次 / ${ndSpread.length} 个词；其中只出现在 1 个定义上的: ${ndSpread.filter(x => x.n === 1).length} 个词 (${((ndSpread.filter(x => x.n === 1).length / ndSpread.length) * 100).toFixed(1)}%)`)
console.log(`覆盖 ≥5 个定义的: ${ndSpread.filter(x => x.n >= 5).length} 个词，合计出现 ${occOf(ndSpread.filter(x => x.n >= 5)) } 次`)
console.log('最广的 12 个:')
for (const x of ndSpread.slice(0, 12)) console.log(`  ${String(x.n).padStart(4)} 个定义  ${JSON.stringify(x.t)}`)

/** PROTOTYPE — final consolidated numbers for the #33 writeup. Every figure in the
 *  resolution comment comes from here, so nothing in the prose is estimated. */
import { readFileSync } from 'node:fs'
const data = JSON.parse(readFileSync('/tmp/sg-guardrail-probe/out/probe-data.json', 'utf8'))
const rows = data.rows as Array<{
  t: string; d: string; k: string; s: string; x: string; l: number; r: string[]; ra: string[]; f: string[]
}>
const CAP = 24
const ON = new Set(data.rules.filter((r: any) => r.on).map((r: any) => r.id))
const ORIG = new Set(data.rules.filter((r: any) => r.tier === 'orig').map((r: any) => r.id))
const NAME_ID = new Set(['own-column-name', 'column-name-canon'])
const kb = (r: any, on: Set<string>, cap: number) => {
  const o = r.r.filter((id: string) => on.has(id))
  if (r.l > cap) o.push(`len>${cap}`)
  return o
}
const pct = (n: number) => `${((n / rows.length) * 100).toFixed(1)}%`
const bar = (s: string) => `\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`

console.log(bar('A. 基线'))
console.log(`定义 ${data.meta.tables} 表 + ${data.meta.events} 事件 = ${data.meta.tables + data.meta.events}`)
console.log(`候选 ${rows.length}  (paren ${data.meta.bySource.paren} / quote ${data.meta.bySource.quote} / domain ${data.meta.bySource.domain})`)
console.log(`长度 ${JSON.stringify(data.meta.lengthPct)}`)
console.log(`保真 decompose==线上抽取器: ${data.meta.fidelity.checked - data.meta.fidelity.failures}/${data.meta.fidelity.checked}`)

console.log(bar('B. 只开 #26 原始 9 条 + cap24'))
const killOrig = rows.filter(r => kb(r, ORIG, CAP).length > 0)
console.log(`killed ${killOrig.length} (${pct(killOrig.length)})   survived ${rows.length - killOrig.length}`)

console.log(bar('C. 原始 9 条 + 实测新增 A-E + cap24（本票建议）'))
const killed = rows.filter(r => kb(r, ON, CAP).length > 0)
const surv = rows.filter(r => kb(r, ON, CAP).length === 0)
console.log(`killed ${killed.length} (${pct(killed.length)})   survived ${surv.length} (${pct(surv.length)})`)
console.log(`新增 A-E 的净贡献: +${killed.length - killOrig.length}`)

console.log(bar('D. 逐规则归因（independently toggleable，sole=独杀）'))
for (const m of data.rules as any[]) {
  const hits = rows.filter(r => r.r.includes(m.id))
  const sole = rows.filter(r => { const k = kb(r, m.tier === 'rejected' ? new Set([...ON, m.id]) : ON, CAP); return k.length === 1 && k[0] === m.id })
  const cjk = new Set(hits.filter(r => /[一-龥]/.test(r.t)).map(r => r.t)).size
  console.log(
    `${m.tier.padEnd(9)} ${m.id.padEnd(20)} hits=${String(hits.length).padStart(4)} sole=${String(sole.length).padStart(4)} ` +
      `含中文词种=${String(cjk).padStart(3)} ${sole.length === 0 && m.tier !== 'rejected' ? '← 完全冗余' : ''}`,
  )
}
const soleLen = rows.filter(r => { const k = kb(r, ON, CAP); return k.length === 1 && k[0] === `len>${CAP}` })
console.log(`${'cap'.padEnd(9)} ${`len>${CAP}`.padEnd(20)} hits=${String(rows.filter(r => r.l > CAP).length).padStart(4)} sole=${String(soleLen.length).padStart(4)}`)

console.log(bar('E. 疑似假阴性'))
const biz = killed.filter(r => r.f.length > 0)
const nameOnly = biz.filter(r => kb(r, ON, CAP).every((k: string) => NAME_ID.has(k)))
const review = biz.filter(r => !kb(r, ON, CAP).every((k: string) => NAME_ID.has(k)))
console.log(`业务形状的被杀候选 ${biz.length} occ / ${new Set(biz.map(r => r.t)).size} 词`)
console.log(`  其中纯同一性(就是本定义自己的列名) ${nameOnly.length} occ / ${new Set(nameOnly.map(r => r.t)).size} 词 ` +
  `— 含中文的 ${new Set(nameOnly.filter(r => /[一-龥]/.test(r.t)).map(r => r.t)).size} 个`)
console.log(`  需人工过目 ${review.length} occ / ${new Set(review.map(r => r.t)).size} 词`)

console.log(bar('F. 票里点名必须存活的词'))
for (const w of ['DAU', 'GMV', 'T+1', '现金券', 'ARPU', 'LTV', '留存率', '客单价']) {
  const cand = rows.filter(r => r.t === w)
  if (cand.length === 0) { console.log(`  ${w.padEnd(6)} 从来不是候选（在描述里是白文，不在括号/引号/domains 内）→ 护栏无关`); continue }
  const dead = cand.filter(r => kb(r, ON, CAP).length > 0)
  console.log(`  ${w.padEnd(6)} 候选 ${cand.length} 次，存活 ${cand.length - dead.length}，被杀 ${dead.length}` +
    (dead.length ? ` by [${[...new Set(dead.flatMap(r => kb(r, ON, CAP)))].join(',')}]` : ' ✓'))
}

console.log(bar('G. #36 否决权规模：护栏生效后仍会被重抽的剩余量'))
const sBy = (s: string) => surv.filter(r => r.s === s)
console.log(`存活合计 ${surv.length} occ / ${new Set(surv.map(r => r.t)).size} 词种`)
for (const s of ['domain', 'paren', 'quote']) {
  console.log(`  ${s.padEnd(7)} ${String(sBy(s).length).padStart(4)} occ / ${String(new Set(sBy(s).map(r => r.t)).size).padStart(4)} 词种`)
}
const domWords = [...new Set(surv.filter(r => r.s === 'domain').map(r => r.t))]
console.log(`  domain 分支只有 ${domWords.length} 个词: ${domWords.join(' / ')}`)
console.log(`\n否决集规模: 按 (定义,label) 键 ≈ ${surv.length} 条；按 label 全局键 ≈ ${new Set(surv.map(r => r.t)).size} 条`)

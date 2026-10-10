/** PROTOTYPE — emits the data-driven sections of the findings doc. */
import { readFileSync, writeFileSync } from 'node:fs'
const data = JSON.parse(readFileSync('/tmp/sg-guardrail-probe/out/probe-data.json', 'utf8'))
const rows = data.rows as Array<{ t: string; d: string; k: string; s: string; x: string; l: number; r: string[]; f: string[] }>
const CAP = 24
const ON = new Set(data.rules.filter((r: any) => r.on).map((r: any) => r.id))
const NAME_ID = new Set(['own-column-name', 'column-name-canon'])
const kb = (r: any, on = ON, cap = CAP) => {
  const o = r.r.filter((id: string) => on.has(id))
  if (r.l > cap) o.push(`len>${cap}`)
  return o
}
const cjkWords = (rs: typeof rows) => new Set(rs.filter(r => /[一-龥]/.test(r.t)).map(r => r.t)).size
const out: string[] = []

// ── per-rule attribution table ──
out.push('| 规则 | 判据 | 命中 | 独杀 | 命中里含中文的词种 | 评 |')
out.push('|---|---|---:|---:|---:|---|')
for (const m of data.rules as any[]) {
  const on = m.tier === 'rejected' ? new Set([...ON, m.id]) : ON
  const hits = rows.filter(r => r.r.includes(m.id))
  const sole = rows.filter(r => { const k = kb(r, on); return k.length === 1 && k[0] === m.id })
  const tier = m.tier === 'orig' ? '#26 原有' : m.tier === 'proposed' ? '**本票新增**' : '**实测否决**'
  out.push(`| \`${m.id}\` | ${m.label} | ${hits.length} | ${sole.length} | ${cjkWords(hits)} | ${tier}${m.tier !== 'rejected' && sole.length === 0 ? ' · 完全冗余' : ''} |`)
}
const lenHits = rows.filter(r => r.l > CAP)
const lenSole = rows.filter(r => { const k = kb(r); return k.length === 1 && k[0] === `len>${CAP}` })
out.push(`| \`len>${CAP}\` | 长度上限 | ${lenHits.length} | ${lenSole.length} | ${cjkWords(lenHits)} | 长度 |`)
out.push('')

// ── length cap sweep ──
out.push('### 长度上限扫描（其余规则全开）')
out.push('')
out.push('| cap | 该阈值命中 | 其中没有任何别的规则能抓到 | 合计杀掉 |')
out.push('|---:|---:|---:|---:|')
for (const cap of [12, 16, 20, 24, 28, 32, 40, 50]) {
  const hits = rows.filter(r => r.l > cap).length
  const sole = rows.filter(r => { const k = kb(r, ON, cap); return k.length === 1 && k[0] === `len>${cap}` }).length
  const tot = rows.filter(r => kb(r, ON, cap).length > 0).length
  out.push(`| ${cap} | ${hits} | ${sole} | ${tot} (${((tot / rows.length) * 100).toFixed(1)}%) |`)
}
out.push('')

// ── full reviewable FN list ──
const killed = rows.filter(r => kb(r).length > 0)
const biz = killed.filter(r => r.f.length > 0)
const nameOnly = biz.filter(r => kb(r).every((k: string) => NAME_ID.has(k)))
const review = biz.filter(r => !kb(r).every((k: string) => NAME_ID.has(k)))
out.push('### 需人工过目的疑似假阴性全表')
out.push('')
out.push(`业务形状的被杀候选 ${biz.length} 次 / ${new Set(biz.map(r => r.t)).size} 个词。其中 ${nameOnly.length} 次 / ${new Set(nameOnly.map(r => r.t)).size} 个词是**纯同一性命中**（这个词就是本定义自己的某个列名），该类含中文的词 **${cjkWords(nameOnly)}** 个，故不计入误杀。剩下 **${review.length} 次 / ${new Set(review.map(r => r.t)).size} 个词**是全部需要人眼看的量，列全如下：`)
out.push('')
out.push('| 次数 | 候选词 | 被哪条规则杀 | 原始上下文 |')
out.push('|---:|---|---|---|')
const byTerm = new Map<string, { n: number; rules: Set<string>; ctx: string }>()
for (const r of review) {
  const e = byTerm.get(r.t) ?? { n: 0, rules: new Set<string>(), ctx: r.x }
  e.n++
  for (const k of kb(r)) e.rules.add(k)
  byTerm.set(r.t, e)
}
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
for (const [t, e] of [...byTerm.entries()].sort((a, b) => b[1].n - a[1].n)) {
  out.push(`| ${e.n} | \`${esc(t)}\` | ${[...e.rules].map(r => `\`${r}\``).join(' ')} | ${esc(e.ctx.slice(0, 100))} |`)
}
out.push('')

// ── survivors ──
const surv = rows.filter(r => kb(r).length === 0)
out.push('### 护栏生效后仍会被重抽的剩余量（#36 的否决集规模）')
out.push('')
out.push('| 来源分支 | 存活次数 | 存活词种 | 说明 |')
out.push('|---|---:|---:|---|')
for (const [s, note] of [['domain', '`domains` 字段逐项入候选，全库只有 10 个词'], ['paren', '描述里的括号夹注'], ['quote', '描述里的引号夹注']] as const) {
  const b = surv.filter(r => r.s === s)
  out.push(`| ${s} | ${b.length} | ${new Set(b.map(r => r.t)).size} | ${note} |`)
}
out.push(`| **合计** | **${surv.length}** | **${new Set(surv.map(r => r.t)).size}** | 否决集：按 (定义,label) 键 ≈ ${surv.length} 条；按 label 全局键 ≈ ${new Set(surv.map(r => r.t)).size} 条 |`)
out.push('')
const domWords = [...new Set(surv.filter(r => r.s === 'domain').map(r => r.t))]
  .map(w => ({ w, n: surv.filter(r => r.s === 'domain' && r.t === w).length }))
  .sort((a, b) => b.n - a.n)
out.push(`domain 分支的全部 10 个词：${domWords.map(d => `\`${d.w}\`×${d.n}`).join('、')}`)
out.push('')

writeFileSync('/tmp/sg-guardrail-probe/out/readme-sections.md', out.join('\n'))
console.log(`wrote out/readme-sections.md (${out.length} lines)`)

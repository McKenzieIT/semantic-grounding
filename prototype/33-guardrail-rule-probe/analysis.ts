/**
 * PROTOTYPE — throwaway. Reads out/probe-data.json and prints the views #35 rules on.
 *
 * Three questions this answers that the raw counts don't:
 *  1. Is there a REAL false negative? (my first FN heuristic over-flagged every
 *     English column name; strip own-column-name kills and see what's left)
 *  2. What survives the guardrail — i.e. what junk still gets through, and what
 *     is the permanent re-extraction surface the veto mechanism must cover (#36)?
 *  3. Which rules are redundant, and where should the length cap actually sit?
 */
import { readFileSync } from 'node:fs'

interface Row {
  t: string // term
  d: string // defId
  k: 'table' | 'event'
  s: 'paren' | 'quote' | 'domain'
  x: string // context
  l: number // length
  r: string[] // rule ids that reject it
  f: string[] // FN flags
}
const data = JSON.parse(readFileSync('/tmp/sg-guardrail-probe/out/probe-data.json', 'utf8')) as {
  meta: Record<string, unknown>
  rules: { id: string; label: string; why: string }[]
  rows: Row[]
}
const rows = data.rows
const CAP = 24
const killedBy = (r: Row) => (r.l > CAP ? [...r.r, `len>${CAP}`] : r.r)
const isKilled = (r: Row) => killedBy(r).length > 0

const bar = (s: string) => `\n${'─'.repeat(78)}\n${s}\n${'─'.repeat(78)}`

// ── 1. length cap sweep ──────────────────────────────────────────────────
console.log(bar('1. LENGTH CAP SWEEP — what each cap adds on top of the other rules'))
const otherRulesKill = (r: Row) => r.r.length > 0
for (const cap of [12, 16, 20, 24, 30, 40, 50]) {
  const uniquelyByLen = rows.filter(r => r.l > cap && !otherRulesKill(r)).length
  const total = rows.filter(r => r.l > cap || otherRulesKill(r)).length
  console.log(
    `  cap ${String(cap).padStart(2)}: kills ${String(rows.filter(r => r.l > cap).length).padStart(4)} total, ` +
      `${String(uniquelyByLen).padStart(4)} that NO other rule catches  → combined kill ${total} (${((total / rows.length) * 100).toFixed(1)}%)`,
  )
}

// ── 2. rule redundancy ──────────────────────────────────────────────────
console.log(bar('2. RULE REDUNDANCY — sole-killer count is the rule\'s real contribution'))
const allRuleIds = [...data.rules.map(r => r.id), `len>${CAP}`]
for (const id of allRuleIds) {
  const hits = rows.filter(r => killedBy(r).includes(id))
  const sole = hits.filter(r => killedBy(r).length === 1)
  const label = data.rules.find(r => r.id === id)?.label ?? '长度上限'
  console.log(
    `  ${id.padEnd(19)} ${label.padEnd(10)} total=${String(hits.length).padStart(4)}  sole=${String(sole.length).padStart(4)}  ` +
      (sole.length === 0 ? '← REDUNDANT, fully subsumed' : ''),
  )
}

// ── 3. the genuinely reviewable false-negative list ─────────────────────
console.log(bar('3. FALSE NEGATIVES — excluding own-column-name kills (those are column names, not aliases)'))
const fnCandidates = rows.filter(r => {
  const k = killedBy(r)
  if (k.length === 0) return false
  if (k.length === 1 && k[0] === 'own-column-name') return false // a column name is not a business alias
  return r.f.length > 0
})
const byTerm = new Map<string, { n: number; rules: Set<string>; flags: string[]; ctx: string; defs: Set<string> }>()
for (const r of fnCandidates) {
  const e = byTerm.get(r.t) ?? { n: 0, rules: new Set<string>(), flags: r.f, ctx: r.x, defs: new Set<string>() }
  e.n++
  e.defs.add(r.d)
  for (const k of killedBy(r)) e.rules.add(k)
  byTerm.set(r.t, e)
}
console.log(`  ${fnCandidates.length} occurrences / ${byTerm.size} distinct terms flagged as business-looking\n`)
for (const [t, e] of [...byTerm.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 45)) {
  console.log(`  ${String(e.n).padStart(3)}× ${JSON.stringify(t)}`)
  console.log(`        killed-by=[${[...e.rules].join(',')}]  flags=[${e.flags.join('|')}]`)
  console.log(`        ctx: ${e.ctx.slice(0, 110)}`)
}

// ── 4. own-column-name, reviewed on its own ─────────────────────────────
console.log(bar('4. own-column-name — the biggest rule; is it ever killing a real business word?'))
const ocn = rows.filter(r => killedBy(r).includes('own-column-name'))
const ocnSole = ocn.filter(r => killedBy(r).length === 1)
console.log(`  kills ${ocn.length} (${ocnSole.length} that no other rule would catch)`)
const cjk = ocnSole.filter(r => /[一-龥]/.test(r.t))
console.log(`  of those, containing CJK (a Chinese column name would be the risky case): ${cjk.length}`)
if (cjk.length) for (const r of cjk.slice(0, 15)) console.log(`    ${JSON.stringify(r.t)} in ${r.d}`)
const ocnDistinct = new Set(ocnSole.map(r => r.t))
console.log(`  distinct terms: ${ocnDistinct.size}; sample: ${[...ocnDistinct].slice(0, 25).map(s => JSON.stringify(s)).join(', ')}`)

// ── 5. survivors: what still gets through ───────────────────────────────
console.log(bar('5. SURVIVORS — what the guardrail still lets in (the #36 veto surface)'))
const surv = rows.filter(r => !isKilled(r))
const sBy = { paren: 0, quote: 0, domain: 0 } as Record<string, number>
for (const r of surv) sBy[r.s]++
console.log(`  ${surv.length} survivors — paren=${sBy.paren} quote=${sBy.quote} domain=${sBy.domain}`)

const domainTerms = new Map<string, number>()
for (const r of rows.filter(x => x.s === 'domain')) domainTerms.set(r.t, (domainTerms.get(r.t) ?? 0) + 1)
console.log(`\n  domain branch: ${domainTerms.size} DISTINCT words over ${sBy.domain} occurrences`)
console.log(`  (已裁「保留」⇒ 永远会被重抽 ⇒ 这是否决权必须覆盖的常驻面)`)
for (const [t, n] of [...domainTerms.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`    ${String(n).padStart(4)}× ${t}`)

console.log(`\n  top surviving non-domain terms by breadth (generic ⇒ pollutes retrieval):`)
const survTerm = new Map<string, Set<string>>()
for (const r of surv.filter(x => x.s !== 'domain')) {
  if (!survTerm.has(r.t)) survTerm.set(r.t, new Set())
  survTerm.get(r.t)!.add(r.d)
}
for (const [t, defs] of [...survTerm.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 30))
  console.log(`    ${String(defs.size).padStart(4)} defs  ${JSON.stringify(t)}`)

console.log(`\n  longest survivors (junk that slipped the net):`)
for (const r of [...surv].sort((a, b) => b.l - a.l).slice(0, 25))
  console.log(`    len=${String(r.l).padStart(2)} ${JSON.stringify(r.t)}  [${r.s}] ${r.d}`)

console.log(`\n  survivors containing digits / underscore / slash (suspicious shapes no rule caught):`)
const suspicious = surv.filter(r => /[\d_/]/.test(r.t))
console.log(`    ${suspicious.length} occurrences, ${new Set(suspicious.map(r => r.t)).size} distinct`)
const suspDistinct = new Map<string, number>()
for (const r of suspicious) suspDistinct.set(r.t, (suspDistinct.get(r.t) ?? 0) + 1)
for (const [t, n] of [...suspDistinct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30))
  console.log(`    ${String(n).padStart(3)}× ${JSON.stringify(t)}`)

// ── 6. per-definition load ──────────────────────────────────────────────
console.log(bar('6. PER-DEFINITION LOAD — before vs after the guardrail'))
const perDefBefore = new Map<string, number>()
const perDefAfter = new Map<string, number>()
for (const r of rows) perDefBefore.set(r.d, (perDefBefore.get(r.d) ?? 0) + 1)
for (const r of surv) perDefAfter.set(r.d, (perDefAfter.get(r.d) ?? 0) + 1)
const avg = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0) / 766
console.log(`  avg candidates per definition: before=${avg(perDefBefore).toFixed(1)}  after=${avg(perDefAfter).toFixed(1)}`)
const worstBefore = [...perDefBefore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
console.log(`  worst offenders before → after:`)
for (const [d, n] of worstBefore) console.log(`    ${String(n).padStart(3)} → ${String(perDefAfter.get(d) ?? 0).padStart(3)}  ${d}`)

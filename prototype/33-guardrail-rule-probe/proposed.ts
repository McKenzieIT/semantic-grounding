/**
 * PROTOTYPE — throwaway. Quantifies three ADDITIONAL rules the survivor tail exposed,
 * so #35 rules on numbers instead of suggestions.
 *
 *  A. `/` as a separator        — slash-joined field enumerations are the single
 *                                 largest surviving junk class
 *  B. storage-layer suffix tokens — `_df` / `_di` / `_arch` / `_od` / `_mi` …
 *  C. own-column-name with snake/camel normalization — `role_id` in prose vs
 *     `roleId` in params_fields currently slips through
 *
 * For each: kill count, what it uniquely adds, and whether it touches anything
 * that looks like a real business alias.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SG = '/Users/mckenzie/workspace/semantic-grounding/packages/substrate/src'
const CORPUS = join(homedir(), 'sg-dogfood-corpus')

const { loadTables, loadEvents } = await import(`${SG}/io.ts`)
const { TableDefinitionSchema, EventDefinitionSchema } = await import(`${SG}/types.ts`)

interface Row {
  t: string
  d: string
  k: 'table' | 'event'
  s: 'paren' | 'quote' | 'domain'
  x: string
  l: number
  r: string[]
  f: string[]
}
const data = JSON.parse(readFileSync('/tmp/sg-guardrail-probe/out/probe-data.json', 'utf8')) as {
  rows: Row[]
}
const CAP = 24
const currentlyKilled = (r: Row) => r.r.length > 0 || r.l > CAP

// ── field-name index per definition, for rule C ──────────────────────────
/** snake_case / camelCase / dotted → a comparable bare token */
const canon = (s: string) => s.toLowerCase().replace(/[_\-.\s]/g, '')
const fieldsByDef = new Map<string, Set<string>>()
for (const t of loadTables(CORPUS)) {
  try {
    const def = TableDefinitionSchema.parse(t.raw)
    fieldsByDef.set(def.table_name, new Set(def.columns.map((c: { name: string }) => canon(c.name))))
  } catch {}
}
for (const e of loadEvents(CORPUS)) {
  try {
    const def = EventDefinitionSchema.parse(e.raw)
    fieldsByDef.set(def.name, new Set(Object.keys(def.params_fields).map(canon)))
  } catch {}
}

// ── the three proposed rules ─────────────────────────────────────────────
const LAYER_SUFFIX = /^_?(df|di|mi|od|arch|dim|dws|dwd|ads|ods|cbt\d?|test)$/i

const PROPOSED: { id: string; label: string; test: (r: Row) => boolean }[] = [
  {
    id: 'A:slash-separator',
    label: '`/` 也算分隔符',
    test: r => r.t.includes('/'),
  },
  {
    id: 'B:layer-suffix',
    label: '分层/存储后缀标记',
    test: r => LAYER_SUFFIX.test(r.t.trim()),
  },
  {
    id: 'C:column-name-canon',
    label: 'own-column-name 加 snake/camel 归一',
    test: r => {
      const f = fieldsByDef.get(r.d)
      return f ? f.has(canon(r.t)) : false
    },
  },
]

const bar = (s: string) => `\n${'─'.repeat(78)}\n${s}\n${'─'.repeat(78)}`
console.log(bar('PROPOSED ADDITIONS — measured against the 2596 current survivors'))

const survivors = data.rows.filter(r => !currentlyKilled(r))
console.log(`current: ${data.rows.length} candidates, ${survivors.length} survive the 9 rules + cap ${CAP}\n`)

for (const p of PROPOSED) {
  const all = data.rows.filter(p.test)
  const newKills = survivors.filter(p.test)
  const distinct = new Set(newKills.map(r => r.t))
  console.log(`${p.id}  (${p.label})`)
  console.log(`  matches ${all.length} candidates overall; ADDS ${newKills.length} new kills (${distinct.size} distinct terms)`)
  const samples = [...new Map(newKills.map(r => [r.t, r])).values()].slice(0, 12)
  for (const s of samples) console.log(`    ${JSON.stringify(s.t)}  [${s.s}] ${s.d}`)
  // does it touch anything that looks like a genuine Chinese business alias?
  const risky = [...distinct].filter(t => /^[一-龥]{2,6}$/.test(t))
  console.log(`  pure-Chinese 2-6 char terms hit (the false-negative risk class): ${risky.length}${risky.length ? ' → ' + risky.map(x => JSON.stringify(x)).join(', ') : ''}`)
  console.log()
}

// ── combined effect ─────────────────────────────────────────────────────
const anyProposed = (r: Row) => PROPOSED.some(p => p.test(r))
const afterAll = data.rows.filter(r => !currentlyKilled(r) && !anyProposed(r))
console.log(bar('COMBINED'))
console.log(`  before guardrail:            ${data.rows.length}`)
console.log(`  after current 9 rules + cap: ${survivors.length}  (kill ${(((data.rows.length - survivors.length) / data.rows.length) * 100).toFixed(1)}%)`)
console.log(`  after + A/B/C:               ${afterAll.length}  (kill ${(((data.rows.length - afterAll.length) / data.rows.length) * 100).toFixed(1)}%)`)

const bySrc = { paren: 0, quote: 0, domain: 0 } as Record<string, number>
for (const r of afterAll) bySrc[r.s]++
console.log(`  final survivors by branch: domain=${bySrc.domain} paren=${bySrc.paren} quote=${bySrc.quote}`)

console.log(`\n  final surviving non-domain terms, by breadth (what an agent would still have to veto):`)
const byTerm = new Map<string, Set<string>>()
for (const r of afterAll.filter(x => x.s !== 'domain')) {
  if (!byTerm.has(r.t)) byTerm.set(r.t, new Set())
  byTerm.get(r.t)!.add(r.d)
}
for (const [t, defs] of [...byTerm.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 25))
  console.log(`    ${String(defs.size).padStart(4)} defs  ${JSON.stringify(t)}`)

console.log(`\n  longest final survivors:`)
for (const r of [...afterAll].sort((a, b) => b.l - a.l).slice(0, 15))
  console.log(`    len=${String(r.l).padStart(2)} ${JSON.stringify(r.t)}  [${r.s}] ${r.d}`)

// ── the veto-surface number for #36 ─────────────────────────────────────
console.log(bar('#36 VETO SURFACE — what the guardrail can never cover'))
const domainDistinct = new Set(data.rows.filter(r => r.s === 'domain').map(r => r.t))
console.log(`  domain words: ${domainDistinct.size} distinct over ${data.rows.filter(r => r.s === 'domain').length} occurrences`)
console.log(`    (已裁「保留」⇒ 每轮 enrichment 都会重抽 ⇒ 否决权唯一能挡的面)`)
console.log(`  non-domain survivors after A/B/C: ${bySrc.paren + bySrc.quote} occurrences, ${byTerm.size} distinct terms`)
console.log(`  ⇒ 否决集若按 (定义, 标签) 对存储，最坏规模 ≈ ${afterAll.length} 条；按标签全局存储 ≈ ${domainDistinct.size + byTerm.size} 条`)

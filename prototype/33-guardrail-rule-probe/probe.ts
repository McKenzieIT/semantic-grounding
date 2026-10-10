/**
 * PROTOTYPE — throwaway probe for #33.
 *
 * Question: what do the candidate rejection rules actually kill on the real corpus,
 * and do they kill any genuine business aliases (false negatives)?
 *
 * Method:
 *  1. Load all tables + events from ~/sg-dogfood-corpus with the REAL substrate loaders.
 *  2. Recompute the alt_labels candidate set from DESCRIPTION TEXT, with
 *     existingAltLabels stripped — the corpus was polluted by 3cef160, so reading
 *     alt_labels' current value would measure the output, not the input (#33 note).
 *  3. Attribute each candidate to its extraction branch (paren / quote / domain) by
 *     replicating the branches verbatim, then ASSERT the union reproduces the real
 *     `discoverAltLabelsDeterministic` exactly. Attribution cannot drift from shipped code.
 *  4. Cross-check against recorded reality: 3cef160 appended alt_labels to 445 events
 *     that had none and never touched their descriptions, so a faithful baseline must
 *     reproduce their current alt_labels exactly.
 *  5. Apply rules, emit per-rule attributed kill set + suspected-false-negative list.
 *
 * Run: cd /tmp/sg-guardrail-probe && ../../<substrate>/node_modules/.bin/tsx probe.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SG = '/Users/mckenzie/workspace/semantic-grounding/packages/substrate/src'
const CORPUS = join(homedir(), 'sg-dogfood-corpus')
const OUT = '/tmp/sg-guardrail-probe/out'

const { loadTables, loadEvents } = await import(`${SG}/io.ts`)
const { TableDefinitionSchema, EventDefinitionSchema } = await import(`${SG}/types.ts`)
const { discoverAltLabelsDeterministic, tableToAltLabelsTarget, eventToAltLabelsTarget } =
  await import(`${SG}/enrichment.ts`)

const { RULES, tooLong, looksLikeBusinessTerm, canon } = await import('./rules.ts')
type RuleCtx = import('./rules.ts').RuleCtx

/** Rules measured and rejected (they kill real aliases) are excluded from the default verdict. */
const ACTIVE = RULES.filter((r: { tier: string }) => r.tier !== 'rejected')

// ── extractor replication, branch by branch (verbatim from enrichment.ts:721) ──

const normalizeLabel = (s: string) => s.toLowerCase().trim()

interface Sourced {
  readonly term: string
  readonly source: 'paren' | 'quote' | 'domain'
  /** surrounding description text, for human judgement */
  readonly context: string
}

function snippet(desc: string, index: number, len: number): string {
  const a = Math.max(0, index - 45)
  const b = Math.min(desc.length, index + len + 45)
  return (a > 0 ? '…' : '') + desc.slice(a, b).replace(/\s+/g, ' ') + (b < desc.length ? '…' : '')
}

/** Replicates discoverAltLabelsDeterministic, but tags each candidate with its branch. */
function decompose(target: {
  id: string
  description: string
  domains: readonly string[]
  existingAltLabels: readonly string[]
  existingPrefLabel: string | undefined
}): Sourced[] {
  const existing = new Set([
    ...target.existingAltLabels.map(normalizeLabel),
    ...(target.existingPrefLabel ? [normalizeLabel(target.existingPrefLabel)] : []),
    normalizeLabel(target.id),
  ])
  const candidates: Sourced[] = []
  const desc = target.description || ''

  for (const m of desc.matchAll(/[（(]([^）)]+)[）)]/g)) {
    const term = m[1]?.trim()
    if (term && term.length >= 2 && term.length <= 50)
      candidates.push({ term, source: 'paren', context: snippet(desc, m.index ?? 0, m[0].length) })
  }
  for (const m of desc.matchAll(/["'「《]([^"'」》]+)["'」》]/g)) {
    const term = m[1]?.trim()
    if (term && term.length >= 2 && term.length <= 50)
      candidates.push({ term, source: 'quote', context: snippet(desc, m.index ?? 0, m[0].length) })
  }
  for (const d of target.domains) {
    if (d.length >= 2) candidates.push({ term: d, source: 'domain', context: `domains: ${d}` })
  }

  const seen = new Set(existing)
  const out: Sourced[] = []
  for (const c of candidates) {
    const key = normalizeLabel(c.term)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

// ── load the corpus ──────────────────────────────────────────────────────

interface Def {
  readonly id: string
  readonly kind: 'table' | 'event'
  readonly file: string
  readonly target: ReturnType<typeof tableToAltLabelsTarget>
  readonly currentAltLabels: readonly string[]
  readonly columnNames: ReadonlySet<string>
  readonly columnNamesCanon: ReadonlySet<string>
}

const defs: Def[] = []
const parseErrors: { file: string; err: string }[] = []

for (const t of loadTables(CORPUS)) {
  try {
    const def = TableDefinitionSchema.parse(t.raw)
    const target = tableToAltLabelsTarget(def)
    defs.push({
      id: def.table_name,
      kind: 'table',
      file: `tables/${def.table_name}.yaml`,
      target,
      currentAltLabels: def.alt_labels,
      columnNames: new Set(def.columns.map(c => c.name.toLowerCase())),
      columnNamesCanon: new Set(def.columns.map(c => canon(c.name))),
    })
  } catch (e) {
    parseErrors.push({ file: t.path, err: String(e).slice(0, 200) })
  }
}
for (const e of loadEvents(CORPUS)) {
  try {
    const def = EventDefinitionSchema.parse(e.raw)
    const target = eventToAltLabelsTarget(def)
    defs.push({
      id: def.name,
      kind: 'event',
      file: `events/${e.domain}/*.yaml`,
      target,
      currentAltLabels: def.alt_labels,
      columnNames: new Set(Object.keys(def.params_fields).map(k => k.toLowerCase())),
      columnNamesCanon: new Set(Object.keys(def.params_fields).map(canon)),
    })
  } catch (err) {
    parseErrors.push({ file: `events/${e.domain}/${e.name}`, err: String(err).slice(0, 200) })
  }
}

console.log(`loaded: ${defs.filter(d => d.kind === 'table').length} tables, ${defs.filter(d => d.kind === 'event').length} events`)
if (parseErrors.length) console.log(`parse errors: ${parseErrors.length}`)

// ── baseline: pristine extraction (pollution stripped) + fidelity assertions ──

interface Candidate extends Sourced {
  readonly defId: string
  readonly kind: 'table' | 'event'
}

const baseline: Candidate[] = []
let fidelityChecked = 0
const fidelityFailures: string[] = []
const groundTruth = { checked: 0, exact: 0, mismatches: [] as { id: string; expected: string[]; got: string[] }[] }

for (const d of defs) {
  // Strip the polluted output; keep pref_label + id (genuine extractor dedupe inputs).
  const pristine = { ...d.target, existingAltLabels: [] as string[] }

  const real: string[] = discoverAltLabelsDeterministic(pristine)
  const mine = decompose(pristine)

  // FIDELITY: my branch decomposition must reproduce the shipped extractor exactly.
  fidelityChecked++
  const mineTerms = mine.map(c => c.term)
  if (JSON.stringify(mineTerms) !== JSON.stringify(real)) {
    fidelityFailures.push(`${d.id}: real=${JSON.stringify(real)} mine=${JSON.stringify(mineTerms)}`)
  }

  // GROUND TRUTH: events polluted by 3cef160 had no alt_labels before and their
  // descriptions were untouched ⇒ current alt_labels must equal the pristine extraction.
  if (d.kind === 'event' && d.currentAltLabels.length > 0) {
    groundTruth.checked++
    if (JSON.stringify([...d.currentAltLabels]) === JSON.stringify(real)) groundTruth.exact++
    else groundTruth.mismatches.push({ id: d.id, expected: [...d.currentAltLabels], got: real })
  }

  for (const c of mine) baseline.push({ ...c, defId: d.id, kind: d.kind })
}

console.log(`\nFIDELITY: ${fidelityChecked - fidelityFailures.length}/${fidelityChecked} definitions reproduce the shipped extractor exactly`)
if (fidelityFailures.length) {
  console.log('  FAILURES (first 5):')
  for (const f of fidelityFailures.slice(0, 5)) console.log(`   ${f}`)
}
console.log(`GROUND TRUTH (events with recorded alt_labels): ${groundTruth.exact}/${groundTruth.checked} exact match vs what 3cef160 actually wrote`)
if (groundTruth.mismatches.length) {
  console.log('  MISMATCHES (first 5):')
  for (const m of groundTruth.mismatches.slice(0, 5))
    console.log(`   ${m.id}\n     on disk: ${JSON.stringify(m.expected)}\n     probe:   ${JSON.stringify(m.got)}`)
}

console.log(`\nBASELINE: ${baseline.length} candidates across ${defs.length} definitions`)
const bySource = { paren: 0, quote: 0, domain: 0 }
for (const c of baseline) bySource[c.source]++
console.log(`  by branch: paren=${bySource.paren} quote=${bySource.quote} domain=${bySource.domain}`)

// length histogram — #35 picks the cap off this
const lens = baseline.map(c => c.term.length).sort((a, b) => a - b)
const pct = (p: number) => lens[Math.min(lens.length - 1, Math.floor((lens.length * p) / 100))]
console.log(`  length: min=${lens[0]} p50=${pct(50)} p75=${pct(75)} p90=${pct(90)} p95=${pct(95)} p99=${pct(99)} max=${lens[lens.length - 1]}`)

// ── apply rules ──────────────────────────────────────────────────────────

const LEN_CAP_DEFAULT = 24

interface Verdict {
  readonly c: Candidate
  /** ids of every rule that would reject it (not just the first) */
  readonly killedBy: string[]
  readonly fnFlags: string[]
}

const verdicts: Verdict[] = baseline.map(c => {
  const ctx: RuleCtx = {
    defId: c.defId,
    kind: c.kind,
    columnNames: defs.find(d => d.id === c.defId)!.columnNames,
    columnNamesCanon: defs.find(d => d.id === c.defId)!.columnNamesCanon,
    source: c.source,
  }
  const killedBy = ACTIVE.filter(r => r.reject(c.term, ctx)).map(r => r.id)
  if (tooLong(c.term, LEN_CAP_DEFAULT)) killedBy.push(`len>${LEN_CAP_DEFAULT}`)
  return { c, killedBy, fnFlags: killedBy.length > 0 ? looksLikeBusinessTerm(c.term) : [] }
})

const killed = verdicts.filter(v => v.killedBy.length > 0)
const survived = verdicts.filter(v => v.killedBy.length === 0)

console.log(`\nWITH ALL RULES (len cap ${LEN_CAP_DEFAULT}):`)
console.log(`  killed:   ${killed.length} (${((killed.length / baseline.length) * 100).toFixed(1)}%)`)
console.log(`  survived: ${survived.length} (${((survived.length / baseline.length) * 100).toFixed(1)}%)`)

console.log(`\nPER-RULE kill counts (a candidate can be hit by several):`)
const perRule = new Map<string, number>()
const soloRule = new Map<string, number>()
for (const v of killed) {
  for (const r of v.killedBy) perRule.set(r, (perRule.get(r) ?? 0) + 1)
  if (v.killedBy.length === 1) soloRule.set(v.killedBy[0]!, (soloRule.get(v.killedBy[0]!) ?? 0) + 1)
}
for (const r of [...ACTIVE.map(x => x.id), `len>${LEN_CAP_DEFAULT}`]) {
  console.log(`  ${r.padEnd(20)} total=${String(perRule.get(r) ?? 0).padStart(5)}  sole-killer=${String(soloRule.get(r) ?? 0).padStart(5)}`)
}

// survivors by source — the permanent re-extraction surface for #36
const survBySource = { paren: 0, quote: 0, domain: 0 }
for (const v of survived) survBySource[v.c.source]++
console.log(`\nSURVIVORS by branch (= what the veto mechanism must still cover, #36):`)
console.log(`  domain=${survBySource.domain}  paren=${survBySource.paren}  quote=${survBySource.quote}`)
const survDistinctDefs = new Set(survived.map(v => v.c.defId)).size
console.log(`  distinct definitions with ≥1 surviving candidate: ${survDistinctDefs}/${defs.length}`)

// ── suspected false negatives ────────────────────────────────────────────

const fns = killed.filter(v => v.fnFlags.length > 0)
console.log(`\nSUSPECTED FALSE NEGATIVES: ${fns.length} killed candidates look like real business terms`)
const fnByTerm = new Map<string, { count: number; rules: Set<string>; flags: string[]; sample: string }>()
for (const v of fns) {
  const k = v.c.term
  const e = fnByTerm.get(k) ?? { count: 0, rules: new Set<string>(), flags: v.fnFlags, sample: v.c.context }
  e.count++
  for (const r of v.killedBy) e.rules.add(r)
  fnByTerm.set(k, e)
}
console.log(`  (${fnByTerm.size} distinct terms)`)
for (const [term, e] of [...fnByTerm.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 40)) {
  console.log(`  ${String(e.count).padStart(4)}× ${JSON.stringify(term)}  killed-by=[${[...e.rules].join(',')}]  flags=[${e.flags.join('|')}]`)
}

// the named must-survive words, checked explicitly
console.log(`\n#33 NAMED MUST-SURVIVE WORDS — do they appear, and what happens to them?`)
for (const w of ['DAU', 'GMV', 'T+1', '现金券', 'ARPU', 'LTV', '留存率', '客单价']) {
  const hits = verdicts.filter(v => v.c.term.toLowerCase() === w.toLowerCase())
  if (hits.length === 0) {
    console.log(`  ${w.padEnd(8)} — not extracted anywhere in the corpus (n/a)`)
  } else {
    const dead = hits.filter(h => h.killedBy.length > 0)
    console.log(`  ${w.padEnd(8)} — ${hits.length} occurrence(s), ${dead.length} killed ${dead.length ? `by [${[...new Set(dead.flatMap(d => d.killedBy))].join(',')}]` : '✓ survives'}`)
  }
}

// ── emit data for the HTML viewer ────────────────────────────────────────

mkdirSync(OUT, { recursive: true })
const data = {
  meta: {
    corpus: CORPUS,
    tables: defs.filter(d => d.kind === 'table').length,
    events: defs.filter(d => d.kind === 'event').length,
    parseErrors: parseErrors.length,
    fidelity: { checked: fidelityChecked, failures: fidelityFailures.length },
    groundTruth: { checked: groundTruth.checked, exact: groundTruth.exact, mismatches: groundTruth.mismatches.length },
    baselineTotal: baseline.length,
    bySource,
    lengthPct: { min: lens[0], p50: pct(50), p75: pct(75), p90: pct(90), p95: pct(95), p99: pct(99), max: lens[lens.length - 1] },
    lenCapDefault: LEN_CAP_DEFAULT,
  },
  rules: RULES.map(r => ({ id: r.id, label: r.label, why: r.why, tier: r.tier, on: r.on })),
  // one row per candidate, with per-rule booleans so the viewer can re-filter live
  rows: baseline.map(c => {
    const ctx: RuleCtx = {
      defId: c.defId,
      kind: c.kind,
      columnNames: defs.find(d => d.id === c.defId)!.columnNames,
      columnNamesCanon: defs.find(d => d.id === c.defId)!.columnNamesCanon,
      source: c.source,
    }
    return {
      t: c.term,
      d: c.defId,
      k: c.kind,
      s: c.source,
      x: c.context,
      l: c.term.length,
      r: RULES.filter(r => r.reject(c.term, ctx)).map(r => r.id),
      ra: ACTIVE.filter(r => r.reject(c.term, ctx)).map(r => r.id),
      f: looksLikeBusinessTerm(c.term),
    }
  }),
  groundTruthMismatches: groundTruth.mismatches.slice(0, 50),
  fidelityFailures: fidelityFailures.slice(0, 50),
}
writeFileSync(join(OUT, 'probe-data.json'), JSON.stringify(data))
console.log(`\nwrote ${OUT}/probe-data.json (${(JSON.stringify(data).length / 1024 / 1024).toFixed(2)} MB)`)

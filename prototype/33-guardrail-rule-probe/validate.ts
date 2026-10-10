/**
 * PROTOTYPE — throwaway. Full-loop validation for #33.
 *
 * Replays 3cef160 against git history: for each of the 445 event files it touched,
 * take the alt_labels as they were at 3cef160^, run the REAL extractor + the REAL
 * mergeAltLabels, and assert the result equals what is on disk today.
 *
 * If this is 445/445, the probe's baseline is not a reimplementation guess — it
 * reproduces a recorded, audited enrichment sweep exactly.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SG = '/Users/mckenzie/workspace/semantic-grounding/packages/substrate/src'
const CORPUS = join(homedir(), 'sg-dogfood-corpus')
const SWEEP = '3cef160'

const yaml = (await import('js-yaml')).default
const { loadEvents } = await import(`${SG}/io.ts`)
const { EventDefinitionSchema } = await import(`${SG}/types.ts`)
const { discoverAltLabelsDeterministic, eventToAltLabelsTarget, mergeAltLabels } = await import(
  `${SG}/enrichment.ts`
)

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: CORPUS, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

// the authoritative list of files the sweep touched
const touched = git('show', '--name-only', '--format=', SWEEP)
  .split('\n')
  .map(s => s.trim())
  .filter(s => s.startsWith('events/') && s.endsWith('.yaml'))

console.log(`${SWEEP} touched ${touched.length} event files`)

// current on-disk state, keyed by event name
const current = new Map<string, { raw: Record<string, unknown>; domain: string }>()
for (const e of loadEvents(CORPUS)) current.set(e.name, { raw: e.raw, domain: e.domain })

let exact = 0
const mismatches: { path: string; pre: string[]; expected: string[]; onDisk: string[] }[] = []
const skipped: string[] = []

for (const path of touched) {
  // state BEFORE the sweep
  let before: Record<string, unknown>
  try {
    before = yaml.load(git('show', `${SWEEP}^:${path}`)) as Record<string, unknown>
  } catch {
    skipped.push(`${path} (not at ${SWEEP}^)`)
    continue
  }
  const name = before?.name
  if (typeof name !== 'string') {
    skipped.push(`${path} (no name)`)
    continue
  }
  const cur = current.get(name)
  if (!cur) {
    skipped.push(`${path} (gone from HEAD)`)
    continue
  }

  const preLabels: string[] = Array.isArray(before.alt_labels)
    ? (before.alt_labels as string[])
    : []

  // Replay the sweep with the REAL functions, on the description as it was then.
  const defBefore = EventDefinitionSchema.parse(before)
  const target = eventToAltLabelsTarget(defBefore)
  const discovered: string[] = discoverAltLabelsDeterministic(target)
  const expected: string[] = mergeAltLabels(preLabels, discovered)

  const onDisk: string[] = Array.isArray(cur.raw.alt_labels) ? (cur.raw.alt_labels as string[]) : []

  if (JSON.stringify(expected) === JSON.stringify(onDisk)) exact++
  else mismatches.push({ path, pre: preLabels, expected, onDisk })
}

console.log(`\nREPLAY: ${exact}/${touched.length - skipped.length} event files reproduce exactly`)
console.log(`  (pre-existing curated labels preserved by the real mergeAltLabels)`)
if (skipped.length) console.log(`  skipped: ${skipped.length} — ${skipped.slice(0, 5).join('; ')}`)
if (mismatches.length) {
  console.log(`\nMISMATCHES: ${mismatches.length}`)
  for (const m of mismatches.slice(0, 10)) {
    console.log(`  ${m.path}`)
    console.log(`    pre:      ${JSON.stringify(m.pre)}`)
    console.log(`    expected: ${JSON.stringify(m.expected)}`)
    console.log(`    on disk:  ${JSON.stringify(m.onDisk)}`)
  }
} else {
  console.log(`\n✓ No mismatches. The probe's extractor baseline is exact against recorded history.`)
}

// how many of the 445 had pre-existing curated labels the sweep had to merge with?
const withPre = touched.filter(p => {
  try {
    const b = yaml.load(git('show', `${SWEEP}^:${p}`)) as Record<string, unknown>
    return Array.isArray(b?.alt_labels) && (b.alt_labels as unknown[]).length > 0
  } catch {
    return false
  }
}).length
console.log(`\nevents that already had curated alt_labels before the sweep: ${withPre}/${touched.length}`)

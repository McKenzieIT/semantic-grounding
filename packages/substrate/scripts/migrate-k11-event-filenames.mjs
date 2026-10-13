#!/usr/bin/env node
/**
 * One-time migration (ADR-0016 / #80): rename k11 event fixture files from
 * the inherited dsh underscore convention to the canonical dot-name —
 * filename = the event's own `name` field, dot-separated, verbatim. Domain
 * directories are untouched (ADR-0016: domain is a manual classification,
 * not a function of `name`). Not meant to run more than once; kept for the
 * audit trail of exactly how the 446 files were renamed.
 *
 * `name` is pulled via a top-level-anchored regex rather than a full YAML
 * parse so the one pre-existing malformed fixture (a duplicate-key YAML
 * error, unrelated to this migration — ADR-0016 does not touch file
 * *content*) still migrates instead of aborting the run.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EVENTS_DIR = join(ROOT, 'tests/fixtures/k11/events')
const NAME_RE = /^name:\s*(.+)$/m

function extractName(filePath) {
  const text = readFileSync(filePath, 'utf-8')
  const m = NAME_RE.exec(text)
  if (m === null) throw new Error(`no top-level 'name:' field: ${filePath}`)
  let v = m[1].trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  return v
}

const domains = readdirSync(EVENTS_DIR).filter((d) => statSync(join(EVENTS_DIR, d)).isDirectory())

/** @type {Array<{ oldPath: string, newPath: string, name: string }>} */
const plan = []
/** name -> first file seen with that name (ADR-0016 R5: global uniqueness) */
const seen = new Map()

for (const domain of domains) {
  const dir = join(EVENTS_DIR, domain)
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.yaml') || file === '_index.yaml') continue
    const oldPath = join(dir, file)
    const name = extractName(oldPath)
    const prior = seen.get(name)
    if (prior !== undefined) {
      throw new Error(
        `ADR-0016 R5 violated — duplicate event name '${name}': ${prior} and ${oldPath}. Aborting before any rename.`,
      )
    }
    seen.set(name, oldPath)
    const newPath = join(dir, `${name}.yaml`)
    if (newPath !== oldPath) plan.push({ oldPath, newPath, name })
  }
}

console.log(`${seen.size} event files scanned (name uniqueness OK), ${plan.length} need renaming.`)

for (const { oldPath, newPath } of plan) {
  execFileSync('git', ['mv', oldPath, newPath])
}

console.log(`Migrated ${plan.length} files to canonical dot-name filenames.`)

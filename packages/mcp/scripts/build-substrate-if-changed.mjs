#!/usr/bin/env node
/**
 * #174 4d: skip the substrate rebuild in `pretest` when nothing it consumes
 * has changed.
 *
 * The unconditional rebuild cost a measured 5-6s of every `pnpm ... run test`
 * of this package even when `packages/substrate/src` was byte-identical to
 * the previous run. tsdown has no incremental mode, so a naive mtime guard
 * would happily serve a stale `lib/` (sources touched-but-identical, or a
 * `lib/` overwritten after the last build) — the hash guards below are the
 * correctness backstop:
 *
 * - SKIP only when (a) the source manifest (every file under
 *   `substrate/src`, plus `tsdown.config.ts` and `package.json`) hashes
 *   identical to the stamp written by the last build, mtimeMs+size acting
 *   only as a per-file fast path to skip re-hashing, AND (b) every output
 *   file (`lib/**\/*.js` + `.d.ts`) still hashes to what that build produced.
 * - Anything else — edited source, new/deleted file, missing or rewritten
 *   `lib/` — falls through to a full rebuild and a fresh stamp.
 *
 * The stamp lives under the workspace root's `node_modules/.cache`, so it is
 * never committed and a fresh checkout (or an install that clears the cache)
 * simply builds, exactly as the old pretest did.
 */
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SUBSTRATE = resolve(HERE, '../..', 'substrate')
const STAMP = resolve(HERE, '../../..', 'node_modules', '.cache', 'sg-mcp-pretest', 'substrate-stamp.json')

/** Source inputs a substrate build consumes (relative to the substrate package). */
const SRC_INPUTS = ['src', 'tsdown.config.ts', 'package.json']
/** Output globs' extensions under lib/ that get hashed back after a build. */
const OUTPUT_EXTENSIONS = new Set(['.js', '.d.ts'])

const sha256 = buf => createHash('sha256').update(buf).digest('hex')

/** Recursively collect files under dir (relative paths, sorted). */
function walkFiles(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full, base))
    else if (entry.isFile()) out.push(relative(base, full).replaceAll('\\', '/'))
  }
  return out
}

/** Manifest of a file set: relpath -> { mtimeMs, size, sha256 } (mtime/size are a re-hash fast path only). */
function manifestOf(root, relPaths) {
  const manifest = {}
  for (const rel of relPaths) {
    const st = statSync(join(root, rel))
    manifest[rel] = { m: st.mtimeMs, s: st.size, h: sha256(readFileSync(join(root, rel))) }
  }
  return manifest
}

/** True when every entry of `now` matches `stamped` (fast path: mtime+size; backstop: sha256). */
function manifestUnchanged(stamped, now) {
  const keys = new Set([...Object.keys(stamped ?? {}), ...Object.keys(now)])
  for (const key of keys) {
    const a = stamped?.[key]
    const b = now[key]
    if (a === undefined || b === undefined) return false
    if (a.m === b.m && a.s === b.s) continue
    if (a.h !== b.h) return false
  }
  return true
}

function listSourceInputs() {
  const rels = []
  for (const input of SRC_INPUTS) {
    const full = join(SUBSTRATE, input)
    if (!existsSync(full)) continue
    if (statSync(full).isDirectory()) {
      for (const f of walkFiles(full)) rels.push(`${input}/${f}`)
    } else {
      rels.push(input)
    }
  }
  return rels
}

function listOutputs() {
  const lib = join(SUBSTRATE, 'lib')
  if (!existsSync(lib)) return []
  return walkFiles(lib).filter(f => OUTPUT_EXTENSIONS.has(f.slice(f.lastIndexOf('.'))))
}

function readStamp() {
  try {
    return JSON.parse(readFileSync(STAMP, 'utf8'))
  } catch {
    return null
  }
}

function writeStamp(srcManifest, outputManifest) {
  mkdirSync(join(STAMP, '..'), { recursive: true })
  writeFileSync(STAMP, `${JSON.stringify({ v: 1, src: srcManifest, out: outputManifest }, null, 0)}\n`, 'utf8')
}

// ── main ──────────────────────────────────────────────────────────────────

const stamp = readStamp()
const srcNow = manifestOf(SUBSTRATE, listSourceInputs())
const outNow = manifestOf(join(SUBSTRATE, 'lib'), listOutputs())

if (stamp?.v === 1 && manifestUnchanged(stamp.src, srcNow) && manifestUnchanged(stamp.out, outNow)) {
  console.log('[pretest] substrate unchanged (src + lib hashes match the last build) — skipping rebuild')
  process.exit(0)
}

const reason = stamp === null
  ? 'no stamp (fresh checkout or cleared cache)'
  : !manifestUnchanged(stamp.src, srcNow)
    ? 'substrate sources changed'
    : 'substrate lib/ missing or rewritten'
console.log(`[pretest] rebuilding substrate (${reason})`)

// Same command the old pretest ran, through a shell: `pnpm` on Windows is a
// .cmd shim that execFileSync-without-shell cannot resolve.
execSync('pnpm --filter @semantic-grounding/substrate run build', {
  cwd: resolve(HERE, '..'),
  stdio: 'inherit',
})

// A clean stamp of what this build consumed and produced. If tsdown emitted
// nothing for some input class, the empty out-manifest still verifies "still
// nothing" on the next run.
const outFresh = manifestOf(join(SUBSTRATE, 'lib'), listOutputs())
rmSync(STAMP, { force: true })
writeStamp(srcNow, outFresh)
console.log('[pretest] substrate rebuilt and stamped')

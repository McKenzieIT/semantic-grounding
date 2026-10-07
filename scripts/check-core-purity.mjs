#!/usr/bin/env node
/**
 * The negation test: proof that the substrate core is host-neutral.
 *
 * ## Why this shape
 *
 * The original formulation was "core's test suite passes with no `cordis` on
 * `node_modules`". That gate is **gameable, and was gamed**: slice 1 satisfied
 * it by copying 4086 lines of cordis/schemastery/cosmokit source into
 * `vendor-deps/` and aliasing the package specifiers at it. `node_modules` was
 * clean, 269 tests were green, and `src/index.ts` still had
 * `import { Context, Service } from '@deepseek-ai/cordis'` at the top. The
 * letter was satisfied; the spirit was not.
 *
 * The problem is that it gates a *packaging* fact (what the package manager
 * installed) when the property worth protecting is a *design* fact: the core
 * does not name host concepts. Slice 2 ① then had to put cordis back on
 * `node_modules` — as the published package, for the one shell file that
 * legitimately needs it — which would have turned the old gate permanently red
 * for the wrong reason.
 *
 * So this gate checks the design property directly: no file in `src/` outside
 * an explicit shell allow-list may name a host framework or reach for a host
 * context. That is not satisfiable by vendoring, it is true today, and it goes
 * red exactly when someone reintroduces host coupling into the substrate —
 * which is the regression actually worth catching.
 *
 * ## The allow-list is the point
 *
 * Every entry is a file that is *supposed* to be host-shaped, and each one is a
 * candidate to move into the dsh adapter package (slice 4). The list shrinking
 * to empty is the end state; it is not expected to grow. Adding an entry is a
 * deliberate decision to accept host coupling in `src/`, so it needs a reason
 * written next to it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

/**
 * Files permitted to name a host framework, with the reason each is exempt.
 * Paths are `/`-separated and relative to `src/`.
 */
const SHELL_ALLOWLIST = new Map([
  ['llm-wiring-plugin.ts',
    'The cordis plugin that adapts ctx.llm into the core\'s TextLlm setter and ' +
    'declares the ctx.schema / ctx.llm Context augmentations. This IS the host ' +
    'shell; it ships as its own build entry and is the first candidate to move ' +
    'into the dsh adapter package (slice 4).'],
])

/** Host symbols that must not appear in the substrate core. */
const FORBIDDEN = [
  {
    name: 'cordis import',
    re: /^\s*import\s[^\n]*['"]@deepseek-ai\/cordis['"]/m,
    why: 'the core must not import the host framework',
  },
  {
    name: 'schemastery import',
    re: /^\s*import\s[^\n]*['"]@deepseek-ai\/schemastery['"]/m,
    why: 'schemastery exists here only to type cordis mount-time `static Config`; the domain model uses zod',
  },
  {
    name: 'cordis module augmentation',
    re: /^\s*declare module\s+['"]@deepseek-ai\/cordis['"]/m,
    why: 'declaring a ctx seam re-couples the core to the host it no longer imports',
  },
  {
    name: 'extends Service',
    re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+\s+extends\s+Service\b/m,
    why: 'a cordis Service can only exist once per context name, which forbids multiple cores per process',
  },
  {
    name: 'host context access',
    // `this.ctx.` / `ctx.get(` / `ctx.effect(` / `ctx.logger` as real code.
    re: /^(?!\s*(?:\*|\/\/|\/\*)).*(?:\bthis\.ctx\b|\bctx\.get\s*\(|\bctx\.effect\s*\(|\bctx\.logger\b)/m,
    why: 'the core takes its collaborators via setters, it does not reach into a host context',
  },
]

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) out.push(...walk(abs))
    else if (/\.(ts|mts|cts)$/.test(entry)) out.push(abs)
  }
  return out
}

const violations = []
let checked = 0

for (const abs of walk(SRC)) {
  const rel = relative(SRC, abs).split(sep).join('/')
  if (SHELL_ALLOWLIST.has(rel)) continue
  checked += 1
  const source = readFileSync(abs, 'utf8')
  for (const rule of FORBIDDEN) {
    const m = rule.re.exec(source)
    if (!m) continue
    const line = source.slice(0, m.index).split('\n').length
    violations.push({ file: `src/${rel}`, line, rule, snippet: m[0].trim().slice(0, 100) })
  }
}

const shells = [...SHELL_ALLOWLIST.keys()].map(f => `src/${f}`)

if (violations.length > 0) {
  console.error('\n✗ negation test FAILED — host coupling found in the substrate core\n')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.rule.name}`)
    console.error(`    ${v.snippet}`)
    console.error(`    why this is forbidden: ${v.rule.why}\n`)
  }
  console.error('If this file is genuinely a host shell, add it to SHELL_ALLOWLIST in')
  console.error('scripts/check-core-purity.mjs with a reason — but prefer moving the')
  console.error('coupling into the host adapter instead. See map #1 and GLOSSARY.md')
  console.error('§ negation test.\n')
  process.exit(1)
}

console.error(
  `✓ negation test: ${checked} core file(s) in src/ name no host framework ` +
  `(shell allow-list: ${shells.length ? shells.join(', ') : 'empty'})`,
)

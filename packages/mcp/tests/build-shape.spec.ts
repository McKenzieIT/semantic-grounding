/**
 * What the build has to produce for `package.json`'s `bin` to work, and for the two
 * dependencies to stay out of the bundle.
 *
 * Both claims rest on build-tool behaviour rather than on code in this repo — tsdown
 * preserves a shebang and marks `dependencies` external by default — which is exactly the
 * kind of thing that changes under you on a minor version bump. Asserted rather than
 * trusted, per `tsdown.config.ts`'s own note.
 *
 * Runs the build itself so the assertion is about a *fresh* artifact. `lib/` is gitignored
 * and no other test reads it, so building here has no effect anyone else can see.
 *
 * @module tests/build-shape.spec
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const LIB = join(PKG_ROOT, 'lib')

/** Every `.js` the build emitted, concatenated — the bundle may be split into chunks. */
let emitted = ''

beforeAll(() => {
  execFileSync('pnpm', ['run', 'build'], { cwd: PKG_ROOT, stdio: 'pipe' })
  const names = execFileSync('ls', [LIB], { encoding: 'utf8' }).split('\n').filter(n => n.endsWith('.js'))
  emitted = names.map(n => readFileSync(join(LIB, n), 'utf8')).join('\n')
}, 120_000)

describe('the sg-mcp executable', () => {
  it('keeps its shebang, so `bin` resolves to something runnable', () => {
    expect(readFileSync(join(LIB, 'bin.js'), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
  })

  it('is executable', () => {
    // tsdown chmods entries that carry a shebang. Without the bit, a client's `command`
    // fails with EACCES before any of this server's own diagnostics can run.
    expect(statSync(join(LIB, 'bin.js')).mode & 0o111).toBeGreaterThan(0)
  })
})

describe('dependencies stay external', () => {
  it.each([
    ['@semantic-grounding/substrate', 'SemanticGroundingCore'],
    ['@modelcontextprotocol/server', 'McpServer'],
    // #20 + #21: this package's own tools (ADR-0005's fifteen in `tools/`, ADR-0006's
    // three in `tools/enrichment.ts`) build real `inputSchema`s (zod objects), so zod
    // joined `dependencies` for a legitimate first-party reason — not just a transitive
    // one through the SDK or the substrate. It stays external for the same reason the
    // other two do; tsdown's default externalize-`dependencies` treatment needs no
    // `tsdown.config.ts` change, which is exactly what this case proves.
    ['zod', 'z'],
  ])('imports %s rather than bundling it', (specifier, _symbol) => {
    expect(emitted).toContain(`from "${specifier}"`)
  })

  it('does not inline the substrate, which would duplicate its module-level state', () => {
    // `io.ts`'s invalidation-hook list is module-level and global. Two copies of the
    // substrate in one process means two hook lists, and a cache that is invalidated in
    // one and stale in the other — the hazard map #12's fog records.
    expect(emitted).not.toContain('registerInvalidationHook =')
  })

  it('does not inline the MCP SDK', () => {
    expect(emitted).toContain('from "@modelcontextprotocol/server/stdio"')
  })
})

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
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const LIB = join(PKG_ROOT, 'lib')

/** Every `.js` the build emitted, concatenated — the bundle may be split into chunks. */
let emitted = ''

beforeAll(() => {
  // pnpm is `pnpm.cmd` on Windows, and child_process cannot exec a `.cmd` without a
  // shell — spawn through one there (#81). The simple, space-free argv makes the
  // shell-joined form safe.
  execFileSync('pnpm', ['run', 'build'], { cwd: PKG_ROOT, stdio: 'pipe', shell: process.platform === 'win32' })
  const names = readdirSync(LIB).filter(n => n.endsWith('.js'))
  emitted = names.map(n => readFileSync(join(LIB, n), 'utf8')).join('\n')
}, 120_000)

describe('the sg-mcp executable', () => {
  it('keeps its shebang, so `bin` resolves to something runnable', () => {
    expect(readFileSync(join(LIB, 'bin.js'), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
  })

  // Windows has no execute bit — statSync reports 0o666 there — so this POSIX-only
  // gate cannot run there (#81); the shebang assertion above still does.
  it.skipIf(process.platform === 'win32')('is executable', () => {
    // tsdown chmods entries that carry a shebang. Without the bit, a client's `command`
    // fails with EACCES before any of this server's own diagnostics can run.
    expect(statSync(join(LIB, 'bin.js')).mode & 0o111).toBeGreaterThan(0)
  })
})

describe('dependencies stay external', () => {
  it.each([
    ['@semantic-grounding/substrate', 'SemanticGroundingCore'],
    ['@modelcontextprotocol/server', 'McpServer'],
    // #20 + #21: this package's own tools — every tool file under `tools/`, the
    // enrichment family included — build real `inputSchema`s (zod objects), so zod
    // joined `dependencies` for a legitimate first-party reason — not just a transitive
    // one through the SDK or the substrate. It stays external for the same reason the
    // other two do; tsdown's default externalize-`dependencies` treatment needs no
    // `tsdown.config.ts` change, which is exactly what this case proves.
    ['zod', 'z'],
  ])('imports %s rather than bundling it', (specifier, _symbol) => {
    expect(emitted).toContain(`from "${specifier}"`)
  })

  it('does not inline the MCP SDK', () => {
    expect(emitted).toContain('from "@modelcontextprotocol/server/stdio"')
  })
})

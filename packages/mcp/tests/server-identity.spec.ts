/**
 * `SERVER_INFO` must not drift from the package manifest.
 *
 * `SERVER_INFO` is a literal rather than a runtime read of `package.json`, because the
 * built bundle's relationship to that file is a build-tool detail and a read that falls
 * back on failure would report a confident wrong version. The cost of that choice is
 * exactly this drift risk, and this is the test that pays it — the version reaches every
 * client as `_meta.serverInfo`, which is what an operator quotes in a bug report.
 *
 * @module tests/server-identity.spec
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SERVER_INFO } from '../src/server.ts'

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string }

describe('SERVER_INFO', () => {
  it('matches the package name', () => {
    expect(SERVER_INFO.name).toBe(manifest.name)
  })

  it('matches the package version', () => {
    expect(SERVER_INFO.version).toBe(manifest.version)
  })
})

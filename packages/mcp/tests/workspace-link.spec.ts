import { describe, expect, test } from 'vitest'
import { SemanticGroundingCore } from '@semantic-grounding/substrate'

/**
 * Scaffold smoke test (issue #17). Proves the workspace:* dependency on
 * @semantic-grounding/substrate resolves at both typecheck and runtime,
 * before any real MCP tool exists to exercise it. Replace once #19/#20/#21
 * add real tool tests.
 */
describe('packages/mcp workspace link', () => {
  test('resolves @semantic-grounding/substrate via workspace protocol', () => {
    expect(typeof SemanticGroundingCore).toBe('function')
  })
})

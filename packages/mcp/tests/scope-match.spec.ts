/**
 * `assertScopeMatch` — ADR-0011's write-door assertion (#51): the 8 commit-class
 * tools carry a required `scope_id`, compared **synchronously at handler entry**
 * against the snapshot bound when the call started. Every write-tool spec in this
 * suite passes a `scope_id` that already matches its fixture binding, so none of
 * them exercises the mismatch path — this file pins it directly, against the
 * function itself.
 *
 * @see docs/adr/0011-scope-management.md
 */
import { describe, expect, it } from 'vitest'
import type { ScopeBinding } from '../src/binding.ts'
import { ScopeMismatchError } from '../src/errors.ts'
import { assertScopeMatch } from '../src/tools/audited.ts'

/** A snapshot stub carrying only what `assertScopeMatch` reads. */
function fakeSnapshot(scopeId: string): ScopeBinding {
  return { scopeId } as unknown as ScopeBinding
}

describe('assertScopeMatch', () => {
  it('passes silently when the asserted id matches the snapshot bound at entry', () => {
    expect(() => assertScopeMatch(fakeSnapshot('a'), 'a')).not.toThrow()
  })

  it('refuses a scope_id that disagrees with the snapshot — the switch happened after the read', () => {
    expect(() => assertScopeMatch(fakeSnapshot('a'), 'b')).toThrow(ScopeMismatchError)
  })

  it('carries both ids and a remedy pointing at switch_scope or re-reading, at the segment\'s own code', () => {
    try {
      assertScopeMatch(fakeSnapshot('a'), 'b')
      expect.unreachable('should have refused')
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeMismatchError)
      const err = e as ScopeMismatchError
      expect(err.code).toBe(-31064)
      expect(err.data['asserted_scope_id']).toBe('b')
      expect(err.data['active_scope_id']).toBe('a')
      expect(String(err.data['remedy'])).toContain('switch_scope')
    }
  })
})

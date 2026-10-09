/**
 * ADR-0004 ruling 9 — commit identity.
 *
 * The ruling's load-bearing clause is "缺失拒启": a missing agent id refuses the
 * process. The failure it prevents is quiet — a defaulted author would make every
 * agent's writes look identical in `git log`, and nothing downstream could tell that
 * apart from the truth — so these tests pin the refusal rather than the happy path.
 *
 * @see docs/adr/0004-git-tier2-audit-backbone.md ruling 9
 */
import { describe, expect, it } from 'vitest'
import { IdentityMissingError } from '../src/errors.ts'
import {
  agentIdentity,
  commitEnv,
  corpusNameFrom,
  DEFAULT_SERVER_IDENTITY,
  requireAgentId,
} from '../src/git/identity.ts'

describe('agent id is required at startup', () => {
  it('refuses when absent', () => {
    expect(() => requireAgentId(undefined)).toThrow(IdentityMissingError)
  })

  it('refuses when blank', () => {
    expect(() => requireAgentId('   ')).toThrow(IdentityMissingError)
  })

  it('names the policy, not a missing optional setting', () => {
    // An operator who reads "not an audit trail" looks for the startup flag; one who
    // reads "agentId is undefined" looks for a way to make the check go away.
    expect(() => requireAgentId(undefined)).toThrow(/audit trail/)
  })

  // git silently strips `<`, `>` and newlines from an ident, so an id containing them
  // would attribute commits to a name nobody configured. Rejecting at startup turns a
  // corrupted audit history into a refused boot.
  it('refuses characters git would strip from an ident', () => {
    expect(() => requireAgentId('agent<7>')).toThrow(IdentityMissingError)
    expect(() => requireAgentId('agent\n7')).toThrow(IdentityMissingError)
  })

  it('accepts and trims a usable id', () => {
    expect(requireAgentId('  analyst-agent-7 ')).toBe('analyst-agent-7')
  })
})

describe('author identity', () => {
  it('namespaces the email under agents.<corpus>', () => {
    expect(agentIdentity({ agentId: 'analyst-7', corpusName: 'k11' })).toEqual({
      name: 'analyst-7',
      email: 'analyst-7@agents.k11',
    })
  })

  it('honours a configured pattern', () => {
    expect(agentIdentity({ agentId: 'a1', corpusName: 'k11', emailPattern: '{agent}.{corpus}@example.com' }).email)
      .toBe('a1.k11@example.com')
  })

  it('refuses a pattern that produces an unusable email', () => {
    expect(() => agentIdentity({ agentId: 'a1', corpusName: 'k11', emailPattern: '' })).toThrow(IdentityMissingError)
  })
})

describe('corpus name derivation', () => {
  it('uses the directory base name, lowercased', () => {
    expect(corpusNameFrom('/srv/corpora/K11')).toBe('k11')
  })

  // A corpus directory can be named anything a filesystem accepts, including CJK. An
  // email domain cannot, and an unusable email fails every commit — so the name is
  // sanitized rather than passed through.
  it('sanitizes characters an email domain cannot carry', () => {
    expect(corpusNameFrom('/srv/语义层 corpus')).toBe('corpus')
    expect(corpusNameFrom('/srv/语义层')).toBe('corpus')
  })
})

describe('author/committer split', () => {
  it('stamps the agent as author and the server as committer', () => {
    const env = commitEnv({ name: 'a7', email: 'a7@agents.k11' }, DEFAULT_SERVER_IDENTITY)
    expect(env.GIT_AUTHOR_NAME).toBe('a7')
    expect(env.GIT_AUTHOR_EMAIL).toBe('a7@agents.k11')
    expect(env.GIT_COMMITTER_NAME).toBe(DEFAULT_SERVER_IDENTITY.name)
  })

  // Dates are git's, not the caller's: the audit history wants when the write landed,
  // and a settable timestamp is a settable audit record.
  it('sets no commit date', () => {
    const env = commitEnv({ name: 'a', email: 'a@b' }, DEFAULT_SERVER_IDENTITY)
    expect(Object.keys(env).some(k => k.includes('DATE'))).toBe(false)
  })
})

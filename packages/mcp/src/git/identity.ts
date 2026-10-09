/**
 * Commit identity — who the audit history says wrote a definition (ADR-0004 ruling 9).
 *
 * ## The split, and what it buys
 *
 * **Author is the agent, committer is the server.** git carries two identities per
 * commit and most tooling shows only the author, so the pair is free storage for the
 * one distinction an operator needs constantly: `git log --format=%cn` separates
 * agent-written history from hand-written history at a glance, without a naming
 * convention or a trailer scan, while `git log --author` and `git blame` attribute
 * fields to the agent that actually wrote them.
 *
 * ## Where identity comes from, and why absence refuses startup
 *
 * From the **startup channel**, not the protocol. MCP's `_meta.clientInfo` is the client
 * *application* name (Claude Code, Cursor), which is not the writing agent, and the
 * 2026-07-28 revision is stateless with no session identity to borrow — so under stdio
 * the command/args/env the client registers is the only configuration channel that
 * exists (#14, ruling 9). A corpus-level config file cannot express it either, since two
 * processes on one corpus may be two different agents.
 *
 * Absence therefore refuses the process rather than defaulting. A default author is
 * worse than no audit trail: `git log` would show a uniform fictitious name over writes
 * from different agents, and nothing downstream could tell that apart from the truth.
 *
 * **Boundary condition, as ADR-0004 states it:** identity-from-startup holds exactly
 * while one process serves one agent. A long-running multi-tenant service takes identity
 * from request credentials instead — out of map #12's scope, and a fresh effort rather
 * than an amendment here.
 *
 * @module git/identity
 */
import { basename } from 'node:path'
import { IdentityMissingError } from '../errors.ts'

/** A git identity: the name and email that land in an author/committer field. */
export interface GitIdentity {
  readonly name: string
  readonly email: string
}

/**
 * Default email pattern for the agent author. `{agent}` and `{corpus}` are substituted;
 * the `agents.` namespace keeps agent addresses from ever colliding with a real person's
 * (ruling 9), and the corpus suffix makes the same agent id distinguishable across
 * corpora in an aggregated history.
 */
export const DEFAULT_AGENT_EMAIL_PATTERN = '{agent}@agents.{corpus}'

/**
 * Default committer — the server itself. Not configurable per-write: the committer field
 * answers "which software made this commit", and letting a caller set it would collapse
 * the agent/human distinction the split exists to provide.
 */
export const DEFAULT_SERVER_IDENTITY: GitIdentity = {
  name: 'semantic-grounding-mcp',
  email: 'mcp@semantic-grounding',
}

/**
 * Characters git rejects or that would corrupt an ident line. git itself strips `<`, `>`
 * and newlines from idents, so a name containing them silently becomes a different
 * author than the one configured — rejecting loudly at startup beats discovering it in
 * the audit history.
 */
const IDENT_FORBIDDEN = /[<>\n\r]/

/**
 * Validate a declared agent id.
 * @param agentId - the value from the startup channel, possibly absent or malformed.
 * @returns the trimmed agent id.
 * @throws IdentityMissingError when absent, blank, or unusable as a git ident.
 */
export function requireAgentId(agentId: string | undefined): string {
  if (agentId === undefined || agentId.trim() === '') {
    throw new IdentityMissingError(
      'no agent identity declared at startup: the git audit backbone records the writing agent as the commit author, and a defaulted author is not an audit trail (ADR-0004 ruling 9) — declare the agent id on the server command line / environment',
    )
  }
  const trimmed = agentId.trim()
  if (IDENT_FORBIDDEN.test(trimmed)) {
    throw new IdentityMissingError(
      `agent id ${JSON.stringify(agentId)} cannot be used as a git identity: "<", ">" and newlines are stripped by git, which would silently attribute commits to a different name`,
      { agent_id: agentId },
    )
  }
  return trimmed
}

/**
 * Derive the corpus name used in the agent's email namespace.
 * @param corpusRoot - the corpus repository root.
 * @returns the directory's base name, lowercased, with characters invalid in an email
 *   domain replaced by `-` (a corpus directory may be named anything, including CJK,
 *   and an unusable email makes every commit fail).
 */
export function corpusNameFrom(corpusRoot: string): string {
  const base = basename(corpusRoot).toLowerCase()
  const cleaned = base.replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'corpus' : cleaned
}

/**
 * Build the agent's author identity.
 * @param opts - the validated agent id, the corpus name for the email namespace, and an
 *   optional pattern override (`{agent}` / `{corpus}` placeholders).
 * @returns the author {@link GitIdentity}.
 * @throws IdentityMissingError when the pattern produces something unusable as an ident.
 */
export function agentIdentity(opts: {
  readonly agentId: string
  readonly corpusName: string
  readonly emailPattern?: string
}): GitIdentity {
  const pattern = opts.emailPattern ?? DEFAULT_AGENT_EMAIL_PATTERN
  const email = pattern.replaceAll('{agent}', opts.agentId).replaceAll('{corpus}', opts.corpusName)
  if (email.trim() === '' || IDENT_FORBIDDEN.test(email)) {
    throw new IdentityMissingError(
      `agent email pattern ${JSON.stringify(pattern)} produced an unusable git email ${JSON.stringify(email)}`,
      { pattern, email },
    )
  }
  return { name: opts.agentId, email }
}

/**
 * The environment that stamps author and committer onto one `git commit`.
 *
 * Passed per-invocation rather than written into the repository's config: the config is
 * the operator's, shared with their own `git commit`s in the same corpus, and mutating
 * it would re-label human writes as agent writes — destroying the very distinction
 * ruling 9's split exists to record.
 *
 * Commit dates are left to git (the invocation time), which is what the audit history
 * wants: when the write landed, not a timestamp a caller could set.
 * @param author - the writing agent's identity.
 * @param committer - the server's identity.
 * @returns environment variables for {@link import('./exec.ts').git}.
 */
export function commitEnv(author: GitIdentity, committer: GitIdentity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
  }
}

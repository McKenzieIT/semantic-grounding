/**
 * Shared setup for the intent tools: a fixture corpus, a real `GitTier2Recorder` +
 * `SemanticGroundingCore` wired together, a server instance with the tool registrars
 * applied, and an {@link InProcessClient} connected to it.
 *
 * By default the server mirrors production exactly — {@link TOOL_REGISTRARS}, all
 * nineteen tools — so a new tool is testable here the moment it is registered, with no
 * second harness to build (the gap #21 had to fill privately). Pass `registrars` to
 * narrow deliberately.
 *
 * @module tests/helpers/intent-tools-harness
 */
import type { McpServer } from '@modelcontextprotocol/server'
import { SemanticGroundingCore } from '@semantic-grounding/substrate'
import { GitTier2Recorder } from '../../src/git/recorder.ts'
import { createServerFactory, TOOL_REGISTRARS, type ServerDeps, type ToolRegistrar } from '../../src/server.ts'
import { createFixtureCorpus, type FixtureCorpus, type FixtureCorpusOptions } from './fixture-corpus.ts'
import { connectInProcess, toolJson, type InProcessClient } from './inprocess-client.ts'

/**
 * Build one server instance from a factory, the way `serveStdio` does — `McpServerFactory`
 * takes a `{era}` context and may return synchronously or asynchronously (`server.ts`'s
 * own factory always does the former, always with a plain `McpServer`; both are handled
 * here rather than assumed, since this is the one place these tests reach past `serve()`
 * to call a factory directly).
 */
export async function buildServer(factory: ReturnType<typeof createServerFactory>): Promise<McpServer> {
  return (await factory({ era: 'modern' })) as McpServer
}

/** Options for {@link buildIntentToolHarness}. */
export interface IntentToolHarnessOptions {
  /** The declared agent id (default `'test-agent'`). */
  readonly agentId?: string
  /** Whether the on-write enrichment hook runs (default `false` — most tool tests want exactly one commit per call). */
  readonly autoEnrich?: boolean
  /** Fixture corpus options, forwarded to `createFixtureCorpus`. */
  readonly fixtureOpts?: FixtureCorpusOptions
  /**
   * Tool registrars to install (default `TOOL_REGISTRARS` — the production surface,
   * all nineteen tools). The pre-#57 default was `INTENT_TOOL_REGISTRARS` (fifteen),
   * which left the enrichment family untestable here and spawned a private second
   * harness in `enrichment-tools.spec.ts`.
   */
  readonly registrars?: readonly ToolRegistrar[]
  /**
   * Serve an existing corpus root instead of building a fresh fixture. `close()` then
   * only tears down the client — the directory's lifecycle belongs to its owner. This
   * is how the restart tests build a second server over the same corpus.
   */
  readonly corpusRoot?: string
}

/** One built harness. */
export interface IntentToolHarness {
  readonly fixture: FixtureCorpus
  readonly deps: ServerDeps
  readonly recorder: GitTier2Recorder
  readonly core: SemanticGroundingCore
  readonly client: InProcessClient
  /** Close the client and the server's transport, then remove the fixture corpus (unless `corpusRoot` was borrowed). */
  close(): Promise<void>
}

/**
 * Build one end-to-end harness: fixture corpus → recorder → core → server (production's
 * default registrars, all nineteen tools, unless narrowed) → connected in-process client.
 * @param opts - see {@link IntentToolHarnessOptions}.
 * @returns the harness.
 */
export async function buildIntentToolHarness(opts: IntentToolHarnessOptions = {}): Promise<IntentToolHarness> {
  const ownsFixture = opts.corpusRoot === undefined
  const fixture = ownsFixture
    ? createFixtureCorpus(opts.fixtureOpts)
    : { root: opts.corpusRoot, cleanup: () => {} }
  const agentId = opts.agentId ?? 'test-agent'
  const recorder = new GitTier2Recorder({
    corpusRoot: fixture.root,
    agentId,
    scopeId: 'fixture',
    lock: { timeoutMs: 5_000, pollIntervalMs: 10 },
  })
  await recorder.ready()
  const core = new SemanticGroundingCore({ semanticRoot: fixture.root, scopeId: 'fixture', autoEnrich: opts.autoEnrich ?? false })
  core.setTier2Recorder(recorder)
  const deps: ServerDeps = {
    core,
    recorder,
    config: { corpusRoot: fixture.root, agentId, scopeId: 'fixture' },
  }
  const server = await buildServer(createServerFactory(deps, opts.registrars ?? TOOL_REGISTRARS))
  const client = await connectInProcess(server)
  return {
    fixture,
    deps,
    recorder,
    core,
    client,
    async close() {
      await client.close()
      if (ownsFixture) fixture.cleanup()
    },
  }
}

/**
 * The common Tier-2 write parameters every intent write tool carries (ADR-0005
 * ruling 7): `derivation` is always `'agent'` in tests because the tools under test
 * are the agent-driven ones. Absorbs the triple re-typed ~60× across the write/item
 * suites; the call itself stays explicit at each site.
 * @param summary - the audit summary.
 * @param confidence - the audit confidence.
 * @returns the three fields to spread into a tool call.
 */
export function tier2(summary: string, confidence: number): Readonly<Record<string, unknown>> {
  return { summary, derivation: 'agent', confidence }
}

/**
 * The current `version` (content fingerprint) of a definition, as `get_definition`
 * reports it — the value `expected_version` must carry (ADR-0004 ruling 8's
 * read-then-write loop). One shared copy of what `version()`/`currentVersion()` used
 * to re-implement per spec file.
 * @param h - a built harness.
 * @param name - the definition's name.
 * @param kind - the definition's kind (default `'table'`).
 * @returns the version string to pass as `expected_version`.
 */
export async function versionOf(h: IntentToolHarness, name: string, kind: 'table' | 'event' | 'concept' | 'metric' = 'table'): Promise<string> {
  const body = toolJson(await h.client.callTool('get_definition', { kind, name })) as { version: string }
  return body.version
}

/**
 * Shared setup for ADR-0005's fifteen intent tools: a fixture corpus, a real
 * `GitTier2Recorder` + `SemanticGroundingCore` wired together, a server instance with
 * `INTENT_TOOL_REGISTRARS` applied, and an {@link InProcessClient} connected to it.
 *
 * @module tests/helpers/intent-tools-harness
 */
import type { McpServer } from '@modelcontextprotocol/server'
import { SemanticGroundingCore } from '@semantic-grounding/substrate'
import { GitTier2Recorder } from '../../src/git/recorder.ts'
import { createServerFactory, type ServerDeps } from '../../src/server.ts'
import { INTENT_TOOL_REGISTRARS } from '../../src/tools/index.ts'
import { createFixtureCorpus, type FixtureCorpus, type FixtureCorpusOptions } from './fixture-corpus.ts'
import { connectInProcess, type InProcessClient } from './inprocess-client.ts'

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
}

/** One built harness. */
export interface IntentToolHarness {
  readonly fixture: FixtureCorpus
  readonly deps: ServerDeps
  readonly recorder: GitTier2Recorder
  readonly core: SemanticGroundingCore
  readonly client: InProcessClient
  /** Close the client and the server's transport, then remove the fixture corpus. */
  close(): Promise<void>
}

/**
 * Build one end-to-end harness: fixture corpus → recorder → core → server (all
 * fifteen intent tools registered) → connected in-process client.
 * @param opts - see {@link IntentToolHarnessOptions}.
 * @returns the harness.
 */
export async function buildIntentToolHarness(opts: IntentToolHarnessOptions = {}): Promise<IntentToolHarness> {
  const fixture = createFixtureCorpus(opts.fixtureOpts)
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
  const server = await buildServer(createServerFactory(deps, [...INTENT_TOOL_REGISTRARS]))
  const client = await connectInProcess(server)
  return {
    fixture,
    deps,
    recorder,
    core,
    client,
    async close() {
      await client.close()
      fixture.cleanup()
    },
  }
}

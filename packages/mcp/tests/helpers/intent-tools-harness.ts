/**
 * Shared setup for ADR-0005's fifteen intent tools: a fixture corpus, registered and
 * bound as the active scope through the real {@link ScopeRegistryFile}/{@link
 * BindingStore} (ADR-0011, #51 — there is no more process-wide `core`/`recorder`), a
 * server instance with `INTENT_TOOL_REGISTRARS` applied, and an {@link InProcessClient}
 * connected to it.
 *
 * The registry lives at a temp file, never `defaultRegistryPath()` — a test that wrote
 * a real `~/.semantic-grounding/scopes.yaml` would grow state on every CI machine that
 * ever ran it.
 *
 * @module tests/helpers/intent-tools-harness
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/server'
import type { SemanticGroundingCore } from '@semantic-grounding/substrate'
import { BindingStore } from '../../src/binding.ts'
import type { GitTier2Recorder } from '../../src/git/recorder.ts'
import { ScopeRegistryFile } from '../../src/scope-registry.ts'
import { createServerFactory, type ServerDeps } from '../../src/server.ts'
import { INTENT_TOOL_REGISTRARS } from '../../src/tools/index.ts'
import { createFixtureCorpus, type FixtureCorpus, type FixtureCorpusOptions } from './fixture-corpus.ts'
import { connectInProcess, type InProcessClient } from './inprocess-client.ts'

/** The scope id every harness-built fixture registers and binds under — matches the fixture's own `config.yaml`. */
export const HARNESS_SCOPE_ID = 'fixture'

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
  /** The fixture scope's core — `deps.bindings.requireSnapshot().core`, for direct assertions. */
  readonly core: SemanticGroundingCore
  /** The fixture scope's recorder — `deps.bindings.requireSnapshot().recorder`. */
  readonly recorder: GitTier2Recorder
  readonly client: InProcessClient
  /** Close the client and the server's transport, then remove the fixture corpus and registry. */
  close(): Promise<void>
}

/**
 * Build one end-to-end harness: fixture corpus → registered + bound as the active scope
 * → server (all fifteen intent tools registered) → connected in-process client.
 * @param opts - see {@link IntentToolHarnessOptions}.
 * @returns the harness.
 */
export async function buildIntentToolHarness(opts: IntentToolHarnessOptions = {}): Promise<IntentToolHarness> {
  const fixture = createFixtureCorpus(opts.fixtureOpts)
  const agentId = opts.agentId ?? 'test-agent'
  const registryDir = mkdtempSync(join(tmpdir(), 'sg-registry-'))
  const registryPath = join(registryDir, 'scopes.yaml')

  const registry = new ScopeRegistryFile(registryPath)
  await registry.register({ id: HARNESS_SCOPE_ID, semanticRoot: fixture.root, name: HARNESS_SCOPE_ID, registeredBy: agentId })
  const bindings = new BindingStore({ registry, agentId, autoEnrich: opts.autoEnrich ?? false })
  await bindings.bindStartup(HARNESS_SCOPE_ID)

  const deps: ServerDeps = {
    registry,
    bindings,
    config: { registryPath, agentId, scopeId: HARNESS_SCOPE_ID },
  }
  const server = await buildServer(createServerFactory(deps, [...INTENT_TOOL_REGISTRARS]))
  const client = await connectInProcess(server)
  const snap = bindings.requireSnapshot()
  return {
    fixture,
    deps,
    core: snap.core,
    recorder: snap.recorder,
    client,
    async close() {
      await client.close()
      bindings.disposeAll()
      fixture.cleanup()
      rmSync(registryDir, { recursive: true, force: true })
    },
  }
}

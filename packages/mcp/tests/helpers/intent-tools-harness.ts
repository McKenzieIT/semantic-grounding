/**
 * Shared setup for the intent tools: a fixture corpus, registered and bound as the
 * active scope through the real {@link ScopeRegistryFile}/{@link BindingStore}
 * (ADR-0011, #51 — there is no more process-wide `core`/`recorder`), a server instance
 * with the tool registrars applied, and an {@link InProcessClient} connected to it.
 *
 * The registry lives at a temp file, never `defaultRegistryPath()` — a test that wrote
 * a real `~/.semantic-grounding/scopes.yaml` would grow state on every CI machine that
 * ever ran it.
 *
 * By default the server mirrors production exactly — {@link TOOL_REGISTRARS}, all
 * twenty-four tools — so a new tool is testable here the moment it is registered, with
 * no second harness to build (the gap #21 had to fill privately). Pass `registrars` to
 * narrow deliberately.
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
import { createServerFactory, TOOL_REGISTRARS, type ServerDeps, type ToolRegistrar } from '../../src/server.ts'
import type { GuidanceThresholds } from '../../src/tools/guidance.ts'
import { createFixtureCorpus, type FixtureCorpus, type FixtureCorpusOptions } from './fixture-corpus.ts'
import { connectInProcess, toolJson, type InProcessClient } from './inprocess-client.ts'

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
  /**
   * Tool registrars to install (default `TOOL_REGISTRARS` — the production surface,
   * all twenty-four tools). The pre-#57 default was `INTENT_TOOL_REGISTRARS` (fifteen),
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
  /** `_guidance` per-layer threshold override (default: `guidance.ts`'s
   * `DEFAULT_DW_THRESHOLD`/`DEFAULT_KG_THRESHOLD`, 50/5). */
  readonly guidanceThreshold?: GuidanceThresholds
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
  /** Close the client and the server's transport, then remove the fixture corpus (unless `corpusRoot` was borrowed) and the registry. */
  close(): Promise<void>
}

/**
 * Build one end-to-end harness: fixture corpus → registered + bound as the active scope
 * → server (production's default registrars, all twenty-four tools, unless narrowed)
 * → connected in-process client.
 * @param opts - see {@link IntentToolHarnessOptions}.
 * @returns the harness.
 */
export async function buildIntentToolHarness(opts: IntentToolHarnessOptions = {}): Promise<IntentToolHarness> {
  const ownsFixture = opts.corpusRoot === undefined
  const fixture = ownsFixture
    ? createFixtureCorpus(opts.fixtureOpts)
    : { root: opts.corpusRoot, cleanup: () => {} }
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
    config: {
      registryPath,
      agentId,
      scopeId: HARNESS_SCOPE_ID,
      ...opts.guidanceThreshold !== undefined ? { guidanceThreshold: opts.guidanceThreshold } : {},
    },
  }
  const server = await buildServer(createServerFactory(deps, opts.registrars ?? TOOL_REGISTRARS))
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
      if (ownsFixture) fixture.cleanup()
      rmSync(registryDir, { recursive: true, force: true })
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

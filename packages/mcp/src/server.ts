/**
 * The stdio server: how a `SemanticGroundingCore` and its git recorder become an MCP
 * server ([#22](https://github.com/McKenzieIT/semantic-grounding/issues/22)).
 *
 * This module itself registers **no tools** — #20 (ADR-0005's fifteen intent
 * tools, `./tools/index.ts`) and #21 (ADR-0006's three enrichment tools,
 * `./tools/enrichment.ts`) both append to {@link TOOL_REGISTRARS} below.
 * Before either landed, the server answered `tools/list` with an empty list —
 * serving, with nothing to offer.
 *
 * Every shape here was settled by measuring SDK v2.3.1 rather than reading its docs, and
 * four of those measurements contradicted what the map had recorded. They are written up
 * on #22; the four that constrain *this file* are:
 *
 * **1. `serveStdio` is mandatory, and the alternative fails silently.** The obvious
 * wiring — `new McpServer(...).connect(new StdioServerTransport())` — does not error on a
 * 2026-07-28 request. It answers it, in 2025-era result shape: no `resultType`, no
 * `ttlMs`, no `cacheScope`, no `_meta.serverInfo`, and the SDK's own rev-2026
 * `decodeResult` rejects exactly that ("servers implementing protocol revision 2026-07-28
 * MUST include it"). `server/discover` returns `-32601`. Envelope validation and version
 * negotiation do not run at all. Accepting the bytes and replying in the wrong era is a
 * worse failure than refusing, so the hand-wired transport is not an option.
 *
 * **2. A fresh `McpServer` per factory call, never a shared one.** Returning a singleton
 * works on the happy path and then corrupts silently. Binding an instance to the modern
 * era mutates it permanently — `_supportedProtocolVersions` is appended to, a
 * `server/discover` handler is installed, the codec is pinned to rev-2026 where
 * `initialize` is not a method — and `close()` does not undo any of it. Measured: with
 * `legacy: 'serve'`, a `server/discover` probe followed by a legacy `initialize` fallback
 * calls the factory twice, and a reused instance answers the second one `-32601 Method
 * not found`. The instance is cheap; the Core behind it is not, which is why only the
 * instance is per-call.
 *
 * **3. The expensive object is built by the caller, outside the factory.** The factory is
 * per-*connection*, not per-request — so a burst of requests enters it once, and "build it
 * inside" looks fine under the obvious test. Three measured paths break it anyway. Two
 * call the factory more than once: the discover/legacy fallback above (twice), and a
 * *throwing* factory, which never pins and is therefore retried on **every** inbound
 * request, unbounded. The third is subtler and was found while trying to falsify this
 * claim: an `async` factory doing slow work races the end of stdin, and requests still in
 * flight when the client's pipe closes are **aborted and never answered** — a factory that
 * loaded a corpus answered zero of three piped requests while reporting success.
 * {@link ServerDeps} is constructed by `main.ts` before serving and closed over here, so
 * all three are harmless.
 *
 * **4. The `tools` capability must be declared even with zero tools.** The SDK wires the
 * tool request handlers eagerly when `capabilities.tools` is present and otherwise lazily
 * on the first `registerTool`. A zero-tool server that omits it answers `tools/list` with
 * `-32601 Method not found` — indistinguishable, from the client side, from a broken
 * server. Declared unconditionally, it answers `{"tools":[]}`.
 *
 * @module server
 */
import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server'
import { serveStdio, type ServeStdioOptions, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'
import type { SemanticGroundingCore } from '@semantic-grounding/substrate'
import type { ServerConfig } from './config.ts'
import type { GitTier2Recorder } from './git/recorder.ts'
// Value import (not `import type`): `TOOL_REGISTRARS` needs the real arrays /
// functions at runtime. Every tool file's own import of `ServerDeps` /
// `ToolRegistrar` back from this module is `import type`-only (erased at
// compile time), so this does not create a runtime import cycle — only
// `tools/index.ts` / `tools/enrichment.ts` → this module's *types*, never the
// reverse at the value level.
import { INTENT_TOOL_REGISTRARS } from './tools/index.ts'
import { registerEnrichmentTools } from './tools/enrichment.ts'

/**
 * The MCP server's identity, as reported in `_meta.serverInfo`.
 *
 * `version` is a literal rather than a read of `package.json`: the built bundle's
 * relationship to that file is a build-tool detail, and a runtime read that falls back on
 * failure would report a confident wrong version. `tests/server-identity.spec.ts` asserts
 * this equals the manifest, so drift fails CI instead of reaching an operator.
 */
export const SERVER_INFO = {
  name: '@semantic-grounding/mcp',
  version: '0.0.1',
} as const

/**
 * Everything a tool needs, built once per process.
 *
 * The `recorder` is passed alongside the `core` rather than reached through it: the
 * substrate takes a recorder by setter and never hands it back, and the tool layer needs
 * `runAudited` directly — it is the seam that holds the lock around the substrate call and
 * supplies the intent the recorder refuses to invent (ADR-0004's 2026-10-09 update).
 */
export interface ServerDeps {
  /** The semantic layer, with the recorder already injected. */
  readonly core: SemanticGroundingCore
  /** The git audit recorder; drive every Tier-2 write through its `runAudited`. */
  readonly recorder: GitTier2Recorder
  /** The validated startup configuration. */
  readonly config: ServerConfig
}

/**
 * A function that registers tools on one freshly-created server instance.
 *
 * This is the seam #20 and #21 plug into, and it is a *function over an instance* rather
 * than the shared instance #22's ticket text anticipated ("把工具注册函数接到这里导出的
 * `Server` 实例上"). The correction is forced by measurement 2 in this module's header:
 * there is no single long-lived `McpServer` to export, because reusing one across the
 * factory's two measured calls corrupts it silently. A registrar runs once per instance,
 * so both calls get a fully-equipped server.
 *
 * Registrars must be **pure registration** — no corpus reads, no lock acquisition, no
 * I/O. They may run twice per process (measurement 2) and, if a registrar throws, per
 * inbound request (measurement 3).
 * @param server - the fresh server instance to register on.
 * @param deps - the process-wide dependencies to close over.
 */
export type ToolRegistrar = (server: McpServer, deps: ServerDeps) => void

/**
 * The registrars the executable installs, in order.
 *
 * #22 shipped this empty ("stdio transport 启动但零工具可用" was its acceptance
 * criterion). #20 appends ADR-0005's fifteen intent tools (`INTENT_TOOL_REGISTRARS`,
 * `./tools/index.ts`) and #21 appends ADR-0006's three enrichment tools
 * (`registerEnrichmentTools`, `./tools/enrichment.ts`) — appending here was the
 * whole integration step the seam was built for.
 */
export const TOOL_REGISTRARS: readonly ToolRegistrar[] = [...INTENT_TOOL_REGISTRARS, registerEnrichmentTools]

/**
 * Build the factory `serveStdio` calls to get a server instance.
 * @param deps - the process-wide dependencies, already constructed.
 * @param registrars - tool registrars to run on each instance (default
 *   {@link TOOL_REGISTRARS}).
 * @returns a factory producing a fresh, fully-registered {@link McpServer} per call.
 */
export function createServerFactory(
  deps: ServerDeps,
  registrars: readonly ToolRegistrar[] = TOOL_REGISTRARS,
): McpServerFactory {
  return () => {
    const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } })
    for (const register of registrars) register(server, deps)
    return server
  }
}

/** Options for {@link serve}. */
export interface ServeOptions {
  /** Tool registrars to install (default {@link TOOL_REGISTRARS}). */
  readonly registrars?: readonly ToolRegistrar[]
  /** Sink for the SDK's out-of-band errors (default: a line on stderr). */
  readonly onerror?: (error: Error) => void
  /** Transport override, for tests that drive the server over a pair of streams. */
  readonly transport?: ServeStdioOptions['transport']
}

/**
 * Serve MCP over stdio.
 *
 * **`legacy: 'serve'`** — 2025-era clients are served as well as 2026-07-28 ones. The
 * Destination says "遵循 2026-07-28 修订", and this follows it: the modern envelope,
 * discovery and result shapes are what the CI gate asserts. Serving the older opening as
 * well is a superset, and it is insurance against an unverified host. SDK v2.3.1's own
 * `LATEST_PROTOCOL_VERSION` is `2025-11-25` and it exports no public constant naming
 * `2026-07-28` at all, so most hosts in the field today almost certainly open in the older
 * era; the dogfood host is QoderWork and peer office agents, whose era we cannot check
 * from here. Refusing would present as an empty tool list and an opaque `-32022`, with no
 * corpus load on the server side to even confirm it started.
 *
 * Measured cost of `'serve'` over `'reject'`: the discover-then-fallback path calls the
 * factory a second time. Because {@link ServerDeps} is built outside the factory, that
 * second call creates only another cheap `McpServer` — one corpus load, one lock, either
 * way. Not exposed as a flag: v1 has no known need to refuse 2025-era clients, and
 * `'reject'` is a one-word change here if that ever arrives.
 * @param deps - the process-wide dependencies, already constructed.
 * @param opts - see {@link ServeOptions}.
 * @returns the SDK's handle; `close()` tears the connection down.
 */
export function serve(deps: ServerDeps, opts: ServeOptions = {}): StdioServerHandle {
  const onerror = opts.onerror ?? ((error: Error) => {
    // stderr, never stdout: stdout is the JSON-RPC channel and a diagnostic written
    // there is a protocol violation the client reports as a parse error.
    process.stderr.write(`[semantic-grounding] ${error.message}\n`)
  })
  return serveStdio(createServerFactory(deps, opts.registrars), {
    legacy: 'serve',
    onerror,
    ...opts.transport !== undefined ? { transport: opts.transport } : {},
  })
}

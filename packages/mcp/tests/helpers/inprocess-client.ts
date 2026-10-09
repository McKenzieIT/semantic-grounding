/**
 * A minimal in-process MCP client over `InMemoryTransport`, for exercising
 * `registerTool`'s real dispatch (`tools/call` / `tools/list`) without a subprocess.
 *
 * This is not a mock of SDK behaviour: `server.connect()`, the real `tools/call`
 * handler, real zod `inputSchema` validation, and the real `isError` result shaping
 * all run exactly as they do under `tests/server-startup.spec.ts`'s spawned-process
 * tests — only the transport differs (`InMemoryTransport` instead of a stdio pipe),
 * which is what makes this fast enough to use per-assertion across fifteen tools'
 * worth of tests. The SDK ships no public `Client` class in this workspace (that lives
 * in a separate `@modelcontextprotocol/client` package this repo does not depend on
 * — adding it for test ergonomics alone was not worth a new dependency), so the far
 * end of the linked pair is this file's own minimal request/response matcher.
 *
 * @module tests/helpers/inprocess-client
 */
import { InMemoryTransport, type JSONRPCMessage, type McpServer } from '@modelcontextprotocol/server'

/** A JSON-RPC response, loosely typed for test assertions (success XOR error). */
export interface JsonRpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly result?: Record<string, unknown>
  readonly error?: { readonly code: number; readonly message: string }
}

/** A client-declared `clientInfo`, as the 2026-07-28 envelope carries it. */
export interface ClientInfo {
  readonly name: string
  readonly version?: string
}

/** One connected in-process client. */
export interface InProcessClient {
  /**
   * Send a `tools/call` for `name`, 2026-07-28-enveloped.
   * @param name - the registered tool name.
   * @param args - the tool's `arguments`.
   * @param clientInfo - when given, carried as the envelope's
   *   `io.modelcontextprotocol/clientInfo` — what `clientNameFromEnvelope` reads.
   */
  callTool(name: string, args: Readonly<Record<string, unknown>>, clientInfo?: ClientInfo): Promise<JsonRpcResponse>
  /** Send a `tools/list`. */
  listTools(): Promise<JsonRpcResponse>
  /** Close both ends of the linked pair. */
  close(): Promise<void>
}

const PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion'
const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities'
const CLIENT_INFO_KEY = 'io.modelcontextprotocol/clientInfo'

/**
 * Connect an already-built `McpServer` instance over a linked `InMemoryTransport`
 * pair and return a tiny client over the far end.
 * @param server - a server instance (e.g. `createServerFactory(deps, registrars)()`), not yet connected.
 * @returns the connected {@link InProcessClient}.
 */
export async function connectInProcess(server: McpServer): Promise<InProcessClient> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const pending = new Map<number, (msg: JsonRpcResponse) => void>()
  clientTransport.onmessage = (message) => {
    const msg = message as unknown as JsonRpcResponse
    const resolve = pending.get(msg.id)
    if (resolve !== undefined) {
      pending.delete(msg.id)
      resolve(msg)
    }
  }
  // `connect()` starts the transport it is given; the client side is not a `Client`
  // instance, so this harness starts it itself (`Transport.start`'s own doc).
  await clientTransport.start()
  await server.connect(serverTransport)

  let nextId = 1
  async function request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = nextId++
    const promise = new Promise<JsonRpcResponse>(resolve => pending.set(id, resolve))
    await clientTransport.send({ jsonrpc: '2.0', id, method, params } as unknown as JSONRPCMessage)
    return promise
  }

  return {
    callTool(name, args, clientInfo) {
      return request('tools/call', {
        name,
        arguments: args,
        _meta: {
          [PROTOCOL_VERSION_KEY]: '2026-07-28',
          [CLIENT_CAPABILITIES_KEY]: {},
          ...clientInfo !== undefined ? { [CLIENT_INFO_KEY]: clientInfo } : {},
        },
      })
    },
    listTools() {
      return request('tools/list', {
        _meta: { [PROTOCOL_VERSION_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_KEY]: {} },
      })
    },
    async close() {
      await clientTransport.close()
      await serverTransport.close()
    },
  }
}

/**
 * Parse one tool result's `content[0].text` as JSON — the convention every tool in
 * `src/tools/` uses for both success payloads and (via `toToolErrorResult`) coded
 * error payloads.
 * @param response - a `callTool` response.
 * @returns the parsed JSON body.
 * @throws if the response carries a JSON-RPC `error` (a genuinely non-tool-layer
 *   failure — e.g. an unknown tool name) rather than a tool result.
 */
export function toolJson(response: JsonRpcResponse): Record<string, unknown> {
  if (response.error !== undefined) {
    throw new Error(`expected a tool result, got a JSON-RPC error: ${JSON.stringify(response.error)}`)
  }
  const content = response.result?.['content'] as Array<{ readonly type: string; readonly text: string }> | undefined
  const text = content?.[0]?.text
  if (typeof text !== 'string') throw new Error(`tool result carried no text content: ${JSON.stringify(response.result)}`)
  return JSON.parse(text) as Record<string, unknown>
}

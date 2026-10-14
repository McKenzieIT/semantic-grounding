/**
 * The tool-layer error contract this ticket settles (ADR-0005's 2026-10-09 addendum,
 * "本票不裁，留 #20 作裁决"): `errors.ts`'s `toToolErrorResult`.
 *
 * Convention, restated for whoever reads this file to apply it to a new tool (#21
 * included): a handler simply throws, and the server's chokepoint wrap
 * (`server.ts`'s `epochWrapped`, #120/C5) pipes the rejected handler Promise
 * through `toToolErrorResult` — the one wrap every registered tool passes
 * through, so no tool author can forget it. The function returns an
 * `isError: true` `CallToolResult` whose `content[0].text` is
 * `JSON.stringify({code, name, message, retryable, data})` for any
 * {@link SgApplicationError}, and *re-throws* anything else (an internal fault stays
 * loud). The `-31xxx` code lives inside that JSON string — it never rides the
 * JSON-RPC `error.code` field for a tool-layer failure.
 *
 * The tests under "measured against the real SDK" are this ticket's version of
 * the probe `docs/agents/decision-framing.md` asks for before relying on a premise:
 * each one would fail if SDK v2.3.1's `registerTool` ever stopped behaving the way
 * ADR-0004/0005's addenda record.
 *
 * The "substrate→coded boundary adapters" group pins the #120/C5 adapter family:
 * the one place the substrate's plain `Error("Table not found: …")` and plural
 * `UnknownFilterNamesError` become coded MCP errors.
 *
 * @see docs/adr/0005-mcp-tool-surface.md (2026-10-09 addendum)
 * @see docs/adr/0004-git-tier2-audit-backbone.md (2026-10-09 addendum)
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/server'
import { UnknownFilterNamesError } from '@semantic-grounding/substrate'
import {
  DefinitionNotFoundError,
  isSubstrateNotFound,
  notFoundAsCoded,
  StaleBaselineRejection,
  SgApplicationError,
  toToolErrorResult,
  UnknownFilterNameError,
  unknownFilterNamesAsCoded,
} from '../src/errors.ts'
import { createServerFactory } from '../src/server.ts'
import type { ToolRegistrar } from '../src/server.ts'
import { buildIntentToolHarness, buildServer, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
import { connectInProcess, toolJson } from './helpers/inprocess-client.ts'

let h: IntentToolHarness | undefined
afterEach(() => h?.close())

describe('toToolErrorResult (unit)', () => {
  it('turns an SgApplicationError into an isError result carrying code/name/message/retryable/data', () => {
    const err = new StaleBaselineRejection('stale — re-read and retry', { target: 'dws_order' })
    const result = toToolErrorResult(err)
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0]?.text
    expect(JSON.parse(text ?? '')).toEqual({
      code: -31002,
      name: 'StaleBaselineRejection',
      message: 'stale — re-read and retry',
      retryable: true,
      data: { target: 'dws_order' },
    })
  })

  it('re-throws anything that is not an SgApplicationError — an internal fault stays loud', () => {
    const bug = new TypeError('this server has a bug')
    expect(() => toToolErrorResult(bug)).toThrow(bug)
  })

  it('re-throws a plain thrown string too', () => {
    expect(() => toToolErrorResult('not even an Error')).toThrow('not even an Error')
  })
})

describe('measured against the real SDK (registerTool, SDK v2.3.1)', () => {
  it('an unknown tool name still produces a genuine JSON-RPC -32602 — never masked as a tool result', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('this_tool_does_not_exist', {})
    expect(res.error).toBeDefined()
    expect(res.error?.code).toBe(-32602)
    expect(res.result).toBeUndefined()
  })

  it('a tool that RETURNS toToolErrorResult(e) survives with its full structured payload, and the JSON-RPC error field is absent', async () => {
    h = await buildIntentToolHarness()
    // get_definition on an unknown name is a real production tool hitting this exact path.
    const res = await h.client.callTool('get_definition', { kind: 'table', name: 'nope' })
    expect(res.error).toBeUndefined() // never on the wire's own error.code for a tool-layer failure
    expect(res.result?.['isError']).toBe(true)
    const body = toolJson(res)
    expect(body).toMatchObject({ code: -31021, name: 'DefinitionNotFoundError', retryable: false })
    expect(body['data']).toBeDefined()
  })

  it('a tool whose handler THROWS an SgApplicationError gets the full structured payload via the chokepoint — field-for-field what the per-handler catch used to return (#120/C5)', async () => {
    // A throwaway registrar standing in for ANY registered tool that fails the
    // contract — async like every real handler, so its throw is a rejected
    // Promise riding the chokepoint's mapping chain. This is the single-point
    // assertion: one wrap covers every existing and future tool, and the
    // payload is asserted EQUAL to toToolErrorResult's own output — the exact
    // bytes the per-handler `catch { return toToolErrorResult(e) }` shapes
    // produced before #120 collapsed them into the chokepoint.
    const coded = new StaleBaselineRejection('stale — re-read and retry', { target: 'dws_order' })
    const throwingRegistrar: ToolRegistrar = (server: McpServer) => {
      server.registerTool(
        'throws_directly',
        { description: 'throws an SgApplicationError without catching it' },
        async () => {
          throw coded
        },
      )
    }
    h = await buildIntentToolHarness()
    const server = await buildServer(createServerFactory(h.deps, [throwingRegistrar]))
    const client = await connectInProcess(server)
    const res = await client.callTool('throws_directly', {})
    await client.close()

    expect(res.error).toBeUndefined() // never on the wire's own error.code for a tool-layer failure
    expect(res.result?.['isError']).toBe(true)
    // Field-for-field equality with the handwritten path's output — the
    // acceptance bar "公开面零变化" operationalized.
    expect(res.result).toEqual(toToolErrorResult(coded))
    const text = (res.result?.['content'] as Array<{ text: string }>)[0]?.text ?? ''
    expect(JSON.parse(text)).toEqual({
      code: -31002,
      name: 'StaleBaselineRejection',
      message: 'stale — re-read and retry',
      retryable: true,
      data: { target: 'dws_order' },
    })
  })

  it('a tool whose async handler throws a NON-SgApplicationError still surfaces as the SDK\'s bare-message isError result — an internal fault stays loud and uncoded', async () => {
    const bugRegistrar: ToolRegistrar = (server: McpServer) => {
      server.registerTool(
        'has_a_bug',
        { description: 'throws a plain TypeError' },
        async () => {
          throw new TypeError('this server has a bug')
        },
      )
    }
    h = await buildIntentToolHarness()
    const server = await buildServer(createServerFactory(h.deps, [bugRegistrar]))
    const client = await connectInProcess(server)
    const res = await client.callTool('has_a_bug', {})
    await client.close()

    expect(res.error).toBeUndefined() // still the "isError result" family, not a JSON-RPC error
    expect(res.result?.['isError']).toBe(true)
    const text = (res.result?.['content'] as Array<{ text: string }>)[0]?.text ?? ''
    // `createToolError(error.message)` — a bare string, not this surface's JSON
    // contract: the chokepoint rethrows what toToolErrorResult refuses to wrap.
    expect(() => JSON.parse(text)).toThrow()
    expect(text).toBe('this server has a bug')
  })
})

describe('the substrate→coded boundary adapters (#120/C5)', () => {
  it('notFoundAsCoded maps the substrate\'s plain not-found Error onto DefinitionNotFoundError, message and data intact', () => {
    const thrown = new Error('Table not found: dws_order')
    expect(() => notFoundAsCoded(thrown, 'table', 'dws_order')).toThrowError(DefinitionNotFoundError)
    try {
      notFoundAsCoded(thrown, 'table', 'dws_order')
    } catch (coded) {
      const err = coded as DefinitionNotFoundError
      expect(err.message).toBe('Table not found: dws_order')
      expect(err.code).toBe(-31021)
      expect(err.data).toEqual({ kind: 'table', name: 'dws_order' })
    }
  })

  it('notFoundAsCoded rethrows a matching-kind Error with a different message unchanged — and non-Error values too', () => {
    const stale = new StaleBaselineRejection('re-read and retry') // an Error, but not a not-found message
    expect(() => notFoundAsCoded(stale, 'table', 'x')).toThrow(stale)
    expect(() => notFoundAsCoded('not even an Error', 'table', 'x')).toThrow('not even an Error')
  })

  it('isSubstrateNotFound answers for all three kinds\' prefixes and nothing else', () => {
    expect(isSubstrateNotFound('Table not found: dws_order')).toBe(true)
    expect(isSubstrateNotFound('Event not found: order_created')).toBe(true)
    expect(isSubstrateNotFound('Concept not found: order')).toBe(true)
    expect(isSubstrateNotFound('Table found')).toBe(false)
    expect(isSubstrateNotFound('Event validation failed')).toBe(false)
  })

  it('unknownFilterNamesAsCoded maps the substrate\'s plural door rejection onto the coded singular with both dimensions\' payload', () => {
    const thrown = new UnknownFilterNamesError('unknown names: dws_py, evt_x', ['dws_py'], ['evt_x'])
    expect(() => unknownFilterNamesAsCoded(thrown)).toThrowError(UnknownFilterNameError)
    try {
      unknownFilterNamesAsCoded(thrown)
    } catch (coded) {
      const err = coded as UnknownFilterNameError
      expect(err.code).toBe(-31040)
      expect(err.message).toBe('unknown names: dws_py, evt_x')
      expect(err.data).toEqual({ unknown_tables: ['dws_py'], unknown_events: ['evt_x'] })
    }
  })

  it('unknownFilterNamesAsCoded rethrows everything else unchanged', () => {
    const stale = new StaleBaselineRejection('re-read and retry')
    expect(() => unknownFilterNamesAsCoded(stale)).toThrow(stale)
    expect(() => unknownFilterNamesAsCoded(new Error('Table not found: x'))).toThrowError(Error)
  })
})

describe('SgApplicationError subclasses carry the code toToolErrorResult reads', () => {
  it.each([
    ['StaleBaselineRejection', -31002, true],
  ] as const)('%s is code %i, retryable %s', (_name, code, retryable) => {
    const err = new StaleBaselineRejection('x')
    expect(err.code).toBe(code)
    expect(err.retryable).toBe(retryable)
    expect(err).toBeInstanceOf(SgApplicationError)
  })
})

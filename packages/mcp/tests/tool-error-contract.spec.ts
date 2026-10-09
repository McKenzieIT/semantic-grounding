/**
 * The tool-layer error contract this ticket settles (ADR-0005's 2026-10-09 addendum,
 * "本票不裁，留 #20 作裁决"): `errors.ts`'s `toToolErrorResult`.
 *
 * Convention, restated for whoever reads this file to apply it to a new tool (#21
 * included): every tool handler wraps its body
 * `try { ... } catch (e) { return toToolErrorResult(e) }`. The function returns an
 * `isError: true` `CallToolResult` whose `content[0].text` is
 * `JSON.stringify({code, name, message, retryable, data})` for any
 * {@link SgApplicationError}, and *re-throws* anything else (an internal fault stays
 * loud). The `-31xxx` code lives inside that JSON string — it never rides the
 * JSON-RPC `error.code` field for a tool-layer failure.
 *
 * The three tests under "measured against the real SDK" are this ticket's version of
 * the probe `docs/agents/decision-framing.md` asks for before relying on a premise:
 * each one would fail if SDK v2.3.1's `registerTool` ever stopped behaving the way
 * ADR-0004/0005's addenda record.
 *
 * @see docs/adr/0005-mcp-tool-surface.md (2026-10-09 addendum)
 * @see docs/adr/0004-git-tier2-audit-backbone.md (2026-10-09 addendum)
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/server'
import { StaleBaselineRejection, SgApplicationError, toToolErrorResult } from '../src/errors.ts'
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

  it('a tool that THROWS the same error directly (bypassing toToolErrorResult) loses everything but the bare message — this is why every handler returns, never throws', async () => {
    // A throwaway registrar standing in for a handler that forgot the try/catch
    // convention — contrasted against the test above, which hits the real
    // `get_definition` production code path for the RETURN case.
    const throwingRegistrar: ToolRegistrar = (server: McpServer) => {
      server.registerTool(
        'throws_directly',
        { description: 'throws an SgApplicationError without catching it' },
        () => {
          throw new StaleBaselineRejection('stale — re-read and retry', { target: 'dws_order' })
        },
      )
    }
    h = await buildIntentToolHarness()
    const server = await buildServer(createServerFactory(h.deps, [throwingRegistrar]))
    const client = await connectInProcess(server)
    const res = await client.callTool('throws_directly', {})
    await client.close()

    expect(res.error).toBeUndefined() // still the "isError result" family, not a JSON-RPC error
    expect(res.result?.['isError']).toBe(true)
    const text = (res.result?.['content'] as Array<{ text: string }>)[0]?.text ?? ''
    // `createToolError(error.message)` — a bare string, not this surface's JSON contract.
    expect(() => JSON.parse(text)).toThrow()
    expect(text).toBe('stale — re-read and retry')
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

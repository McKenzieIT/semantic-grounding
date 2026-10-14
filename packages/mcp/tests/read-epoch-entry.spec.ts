/**
 * ADR-0015's MCP-side entry proof (#77): a tool handler installed through the
 * normal `ToolRegistrar` seam runs inside one read epoch, because
 * `createServerFactory` hands every registrar an epoch-entering server whose
 * `registerTool` wraps the handler (server.ts's chokepoint — every tool file
 * itself is untouched).
 *
 * Observable without any test-only counter (the `readYaml` probe lives in the
 * substrate's io.ts, unreachable from this package by design — ADR-0002's
 * `.`-only import rule): inside one epoch, two `loadTables` calls return the
 * SAME array instance (the memo); outside one, they are distinct arrays. A
 * probe tool that loads twice and reports `a === b` is therefore a direct
 * yes/no on "did this call enter an epoch", end-to-end through the SDK's
 * `tools/call` machinery.
 *
 * @module tests/read-epoch-entry
 */
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { loadTables } from '@semantic-grounding/substrate'
import { buildIntentToolHarness, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
import { toolJson } from './helpers/inprocess-client.ts'
import type { ToolRegistrar } from '../src/server.ts'

let h: IntentToolHarness | undefined
afterEach(() => h?.close())

/** A registrar installing one probe tool: two loads, one identity report. */
const epochProbeRegistrar: ToolRegistrar = (server, _deps) => {
  server.registerTool(
    'epoch_probe',
    {
      title: 'Read-epoch entry probe',
      description: 'Calls loadTables twice on the fixture corpus and reports whether the two results are the same array instance — true iff the handler ran inside one read epoch (ADR-0015).',
      inputSchema: z.object({ root: z.string() }),
    },
    async (input) => {
      const a = loadTables(input.root)
      const b = loadTables(input.root)
      return { content: [{ type: 'text', text: JSON.stringify({ sameArray: a === b, tables: a.length }) }] }
    },
  )
}

describe('the server factory enters a read epoch per tool call (ADR-0015)', () => {
  it('a handler installed through the registrar seam sees one memoised corpus', async () => {
    h = await buildIntentToolHarness({ registrars: [epochProbeRegistrar] })
    const res = await h.client.callTool('epoch_probe', { root: h.fixture.root })
    const body = toolJson(res) as { sameArray: boolean; tables: number }
    // The fixture corpus really has tables, so the probe is not vacuous.
    expect(body.tables).toBeGreaterThan(0)
    // Two loads inside the handler returned the same array instance: the
    // chokepoint wrapped the call in withReadEpoch and the memo answered the
    // second load. Outside an epoch these are always distinct arrays.
    expect(body.sameArray).toBe(true)
  })
})

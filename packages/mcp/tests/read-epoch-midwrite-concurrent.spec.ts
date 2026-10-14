/**
 * #120/C5's epoch-semantics supplements to ADR-0015's MCP-side entry proof:
 * the two pins that ticket's adjudication called for that did not yet exist
 * at the MCP layer (`read-epoch-entry.spec.ts` — the existing generation pins
 * — stayed byte-for-byte untouched). Both drive through the same chokepoint
 * the error-mapping change now also threads a Promise chain through
 * (`epochWrapped`, server.ts): the wraps below would only fail if that chain
 * detached the epoch from the handler's continuations, which is the red line
 * "epoch 语义逐字节不变" operationalizes.
 *
 * 1. **Write-mid-epoch state** — a tool call that writes mid-call must have
 *    its own next read re-parsed from disk (the composite cache key's version
 *    half — R8), and the re-parsed entry itself memo-hits for the load after
 *    that. The substrate-level twin is `read-epoch.spec.ts` group 6; this pin
 *    exercises it across `await`s through the real `tools/call` machinery.
 *
 * 2. **Concurrent reads** — two tool calls in flight at once each keep their
 *    own epoch attached across their own awaits (the memo still answers each
 *    call's second load), with no cross-call interference: the epoch's
 *    identity is the store instance, one per `withReadEpoch` call, so
 *    concurrent calls never share one (ADR-0015's design note).
 *
 * @module tests/read-epoch-midwrite-concurrent
 */
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { loadTables, writeTable } from '@semantic-grounding/substrate'
import { buildIntentToolHarness, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
import { toolJson } from './helpers/inprocess-client.ts'
import type { ToolRegistrar } from '../src/server.ts'

let h: IntentToolHarness | undefined
afterEach(() => h?.close())

/** The fixture's seed dws table — cloning its raw under a new name is a payload
 * `writeTable` is guaranteed to validate, so the write (and its cache bump) lands. */
const PROBE_SOURCE = 'dws_order'
const PROBE_NAME = 'dws_epoch_midwrite_probe'

/** A registrar installing the two probes (#120/C5's supplement pins). */
const epochPinsRegistrar: ToolRegistrar = (server, _deps) => {
  server.registerTool(
    'epoch_midwrite_probe',
    {
      title: 'Read-epoch mid-write probe',
      description: 'Loads the corpus, writes one new table, loads twice more — reporting whether the post-write load re-parsed and whether that re-parse then memo-hits.',
      inputSchema: z.object({ root: z.string() }),
    },
    async (input) => {
      const before = loadTables(input.root)
      const src = before.find(t => t.table_name === PROBE_SOURCE)?.raw
      const res = await writeTable(input.root, PROBE_NAME, { ...src, table_name: PROBE_NAME })
      const after = loadTables(input.root)
      const after2 = loadTables(input.root)
      return { content: [{ type: 'text', text: JSON.stringify({
        wrote: res.ok,
        beforeCount: before.length,
        afterCount: after.length,
        afterHasProbe: after.some(t => t.table_name === PROBE_NAME),
        reParsed: after !== before,
        reParsedMemoHits: after2 === after,
      }) }] }
    },
  )

  server.registerTool(
    'epoch_reader_probe',
    {
      title: 'Read-epoch concurrent-reader probe',
      description: 'Loads the corpus, waits, loads again — reporting whether the two loads returned the same array instance (the call\'s own epoch stayed attached across its await).',
      inputSchema: z.object({ root: z.string() }),
    },
    async (input) => {
      const a = loadTables(input.root)
      // Long enough for a sibling call issued alongside this one to interleave
      // its own loads/waits on the same microtask pool.
      await new Promise(resolve => setTimeout(resolve, 40))
      const b = loadTables(input.root)
      return { content: [{ type: 'text', text: JSON.stringify({ sameWithinCall: a === b, count: b.length }) }] }
    },
  )
}

describe('the chokepoint keeps epoch semantics across its Promise chain (#120/C5)', () => {
  it('a write mid-call invalidates that same call\'s memo — next read re-parses, then memo-hits', async () => {
    h = await buildIntentToolHarness({ registrars: [epochPinsRegistrar] })
    const res = await h.client.callTool('epoch_midwrite_probe', { root: h.fixture.root })
    const body = toolJson(res) as {
      wrote: boolean; beforeCount: number; afterCount: number; afterHasProbe: boolean
      reParsed: boolean; reParsedMemoHits: boolean
    }
    expect(body.wrote).toBe(true)
    expect(body.afterHasProbe).toBe(true)
    expect(body.afterCount).toBe(body.beforeCount + 1)
    // The write's corpusVersion bump turned the memo entry into a miss even
    // though this same call filled it (R8) — a fresh array, not the memo's.
    expect(body.reParsed).toBe(true)
    // And the re-parsed entry itself answers the third load: still one epoch.
    expect(body.reParsedMemoHits).toBe(true)
  })

  it('two concurrent calls each keep their own epoch across their own awaits', async () => {
    h = await buildIntentToolHarness({ registrars: [epochPinsRegistrar] })
    const [one, two] = await Promise.all([
      h.client.callTool('epoch_reader_probe', { root: h.fixture.root }),
      h.client.callTool('epoch_reader_probe', { root: h.fixture.root }),
    ])
    const a = toolJson(one) as { sameWithinCall: boolean; count: number }
    const b = toolJson(two) as { sameWithinCall: boolean; count: number }
    // Each call's second load hit its own call's memo — the epoch survived the
    // interleave (outside an epoch, or detached from it, these are fresh arrays).
    expect(a.sameWithinCall).toBe(true)
    expect(b.sameWithinCall).toBe(true)
    expect(a.count).toBe(b.count)
  })
})

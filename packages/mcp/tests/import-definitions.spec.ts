/**
 * `import_definitions` — #68 landing #54's seven rulings (ADR-0013): the
 * two-phase per-item-verdict batch import. Pinned here: the single-commit
 * shape (Files/Rounds trailers), the four verdicts' triggers (created /
 * updated / skipped / error), cross-kind in-batch name dedup, the permissive
 * SDK envelope keeping one bad item from rejecting the whole call, the 500
 * cap, and the `derivation: 'agent'` narrowing.
 *
 * @see docs/adr/0013-batch-definition-import.md
 */
import { afterEach, describe, expect, it } from 'vitest'
import { buildIntentToolHarness, versionOf, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
import { fixtureGit } from './helpers/fixture-corpus.ts'
import { toolJson } from './helpers/inprocess-client.ts'

let h: IntentToolHarness | undefined
afterEach(() => h?.close())

/** The response body this spec reads back. */
interface ImportBody {
  readonly commit: string
  readonly changed: boolean
  readonly results: Array<{ index: number; kind: string; name: string; verdict: string; version?: string; detail?: string }>
  readonly summary: { created: number; updated: number; skipped: number; errors: number }
  readonly _guidance?: unknown
  readonly version?: string
}

/** One fresh table payload — the minimal shape `TableDefinitionSchema` accepts. */
function table(name: string, comment = 'imported'): Record<string, unknown> {
  return { table_name: name, table_comment: comment, partitions: [{ name: 'ds', type: 'string' }], columns: [{ name: 'id', type: 'string', role: 'dimension' }] }
}

/** One fresh event payload. */
function event(name: string): Record<string, unknown> {
  return { name, description: 'imported event', params_fields: {} }
}

/** One fresh concept payload. */
function concept(name: string, description = 'imported concept'): Record<string, unknown> {
  return { name, description }
}

/** The batch-level provenance block every import call carries. */
function provenance(summary: string): Record<string, unknown> {
  return { summary, derivation: 'agent', confidence: 0.9 }
}

function commitCount(harness: IntentToolHarness): number {
  return Number(fixtureGit(['rev-list', '--count', 'HEAD'], harness.fixture.root).trim())
}

/** A verdict row by input index — fails the test loudly if the row is missing. */
function row(body: ImportBody, index: number): ImportBody['results'][number] {
  const found = body.results.find(r => r.index === index)
  if (found === undefined) throw new Error(`no verdict row for index ${index}`)
  return found
}

function lastMessage(harness: IntentToolHarness): string {
  return fixtureGit(['log', '-1', '--format=%B'], harness.fixture.root)
}

describe('import_definitions — ADR-0013 (#54 seven rulings)', () => {
  it('R5/R4: mixed three-kind batch lands as ONE commit, verdicts created, rows in input order', async () => {
    h = await buildIntentToolHarness()
    const before = commitCount(h)
    const res = await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: [
        { kind: 'table', definition: table('dws_seed_a') },
        { kind: 'event', definition: event('game.seed.b') },
        { kind: 'concept', definition: concept('seed_item') },
      ],
      ...provenance('imported from DDL dump'),
    })
    const body = toolJson(res) as unknown as ImportBody
    expect(res.result?.['isError']).toBeFalsy()
    expect(body.changed).toBe(true)
    expect(body.summary).toEqual({ created: 3, updated: 0, skipped: 0, errors: 0 })
    expect(body.results.map(r => [r.index, r.kind, r.verdict])).toEqual([
      [0, 'table', 'created'],
      [1, 'event', 'created'],
      [2, 'concept', 'created'],
    ])
    // One commit for three logical writes — R4's whole point.
    expect(commitCount(h)).toBe(before + 1)
    // #108's per-item write receipts: every landed row carries the sha of the
    // file it wrote, while the batch top level carries none (one commit spans
    // many files — there is no single fingerprint to name).
    for (const r of body.results) {
      expect(r.version).toMatch(/^[0-9a-f]{64}$/)
      expect(r.version).toBe(await versionOf(h, r.name, r.kind as 'table' | 'event' | 'concept'))
    }
    expect(body).not.toHaveProperty('version')
    const msg = lastMessage(h)
    expect(msg).toMatch(/^import_definitions\(3\/3 items \(3 created, 0 updated\)\): imported from DDL dump$/m)
    expect(msg).toMatch(/X-SG-Tool: import_definitions/)
    expect(msg).toMatch(/X-SG-Derivation: agent/)
    expect(msg).toMatch(/X-SG-Files: 3/m)
    expect(msg).toMatch(/X-SG-Rounds: 3/m)
    // All three landed where their kinds live.
    expect(h.core.loadTableDefinition('dws_seed_a')).not.toBeNull()
    expect(h.core.loadEventDefinition('game.seed.b')).not.toBeNull()
    expect(h.core.loadConceptDefinition('seed_item')).not.toBeNull()
    // The 7th write tool carries `_guidance` (#53 option D's mechanism; #54's T3 dependency).
    expect(body._guidance).toBeDefined()
  })

  it('R7: re-issuing the identical batch is all-skipped, zero commits, and the concept row is not a phantom update', async () => {
    h = await buildIntentToolHarness()
    const batch = {
      scope_id: 'fixture',
      items: [
        { kind: 'table', definition: table('dws_seed_c') },
        { kind: 'concept', definition: concept('seed_weapon', 'a weapon') },
      ],
      ...provenance('imported from DDL dump'),
    }
    await h.client.callTool('import_definitions', batch)
    const before = commitCount(h)
    const head = fixtureGit(['rev-parse', 'HEAD'], h.fixture.root).trim()
    const res = await h.client.callTool('import_definitions', batch)
    const body = toolJson(res) as unknown as ImportBody
    expect(body.changed).toBe(false)
    expect(body.summary).toEqual({ created: 0, updated: 0, skipped: 2, errors: 0 })
    expect(body.results.every(r => r.verdict === 'skipped')).toBe(true)
    // #108: a skipped row's receipt is the file's CURRENT fingerprint —
    // nothing was written, so that fingerprint is the row's whole truth,
    // and it round-trips straight into a later write's expected_version.
    expect(row(body, 0).version).toBe(await versionOf(h, 'dws_seed_c'))
    expect(row(body, 1).version).toBe(await versionOf(h, 'seed_weapon', 'concept'))
    // Zero commits — `end()`'s idempotent branch — and the returned sha is the
    // unchanged HEAD (the timeout-receipt convention run_enrichment documents).
    expect(commitCount(h)).toBe(before)
    expect(body.commit).toBe(head)
    // A stored concept carries defaulted `related_refs`/`suppressed_*` the
    // create-shaped payload never declares; the five-key projection must not
    // read them as drift.
    const stored = h.core.loadConceptDefinition('seed_weapon')
    expect(stored?.related_refs).toEqual([])
  })

  it('R7/R4: an existing definition with different content is `updated` — full-payload overwrite, still one commit', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('create_definition', {
      scope_id: 'fixture', kind: 'table',
      table: table('dws_seed_d', 'original comment'),
      summary: 'first landing', derivation: 'agent', confidence: 0.9,
    })
    const before = commitCount(h)
    const res = await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: [
        { kind: 'table', definition: table('dws_seed_d', 'imported comment') },
        { kind: 'table', definition: table('dws_seed_e') },
      ],
      ...provenance('imported from DDL dump'),
    })
    const body = toolJson(res) as unknown as ImportBody
    expect(body.summary).toEqual({ created: 1, updated: 1, skipped: 0, errors: 0 })
    expect(body.results.map(r => [r.name, r.verdict])).toEqual([
      ['dws_seed_d', 'updated'],
      ['dws_seed_e', 'created'],
    ])
    expect(commitCount(h)).toBe(before + 1)
    expect(h.core.loadTableDefinition('dws_seed_d')?.table_comment).toBe('imported comment')
  })

  it('R2/R4: one zod-bad item and one cross-kind duplicate get error rows; the rest of the batch lands', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: [
        { kind: 'table', definition: table('dws_seed_f') },
        // DIM superRefine failure — the strict parse Phase 1 owns.
        { kind: 'table', definition: { table_name: 'dim_broken', kind: 'dim', columns: [] } },
        { kind: 'concept', definition: concept('dup_seed') },
        // Same name, other kind — R2's one cross-kind Set.
        { kind: 'table', definition: table('dup_seed') },
        { kind: 'event', definition: event('game.seed.g') },
      ],
      ...provenance('imported from DDL dump'),
    })
    const body = toolJson(res) as unknown as ImportBody
    expect(body.changed).toBe(true)
    expect(body.summary).toEqual({ created: 3, updated: 0, skipped: 0, errors: 2 })
    const bad = row(body, 1)
    expect(bad.verdict).toBe('error')
    expect(bad.name).toBe('dim_broken')
    expect(bad.detail).toMatch(/zod:/)
    const dup = row(body, 3)
    expect(dup.verdict).toBe('error')
    expect(dup.detail).toMatch(/duplicate name in batch.*index 2/s)
    // The three good items landed despite the two bad rows.
    expect(h.core.loadTableDefinition('dws_seed_f')).not.toBeNull()
    expect(h.core.loadConceptDefinition('dup_seed')).not.toBeNull()
    expect(h.core.loadEventDefinition('game.seed.g')).not.toBeNull()
  })

  it('R3: over-cap (501 items) is a rejected call, not a truncation — the SDK zod door, before the handler', async () => {
    h = await buildIntentToolHarness()
    const before = commitCount(h)
    const items = Array.from({ length: 501 }, (_, i) => ({ kind: 'table' as const, definition: table(`dws_cap_${i}`) }))
    const res = await h.client.callTool('import_definitions', { scope_id: 'fixture', items, ...provenance('over cap') })
    expect(res.result?.['isError']).toBe(true)
    const text = (res.result?.['content'] as Array<{ text: string }>)[0]?.text ?? ''
    expect(() => JSON.parse(text)).toThrow()
    expect(text).toMatch(/too_many_items|less than or equal to 500|invalid_arguments|validation/i)
    expect(commitCount(h)).toBe(before)
  })

  it('R1: derivation is narrowed to "agent" at the schema door', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: [{ kind: 'table', definition: table('dws_seed_h') }],
      summary: 's', derivation: 'llm', confidence: 0.9,
    })
    expect(res.result?.['isError']).toBe(true)
    const text = (res.result?.['content'] as Array<{ text: string }>)[0]?.text ?? ''
    expect(() => JSON.parse(text)).toThrow()
  })

  it('R1: a stray key in the item envelope is rejected (strict envelope), and an empty items array too', async () => {
    h = await buildIntentToolHarness()
    const stray = await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: [{ kind: 'table', definition: table('dws_seed_i'), note: 'typo' }],
      ...provenance('s'),
    })
    expect(stray.result?.['isError']).toBe(true)
    const empty = await h.client.callTool('import_definitions', { scope_id: 'fixture', items: [], ...provenance('s') })
    expect(empty.result?.['isError']).toBe(true)
  })

  it('scope_mismatch (−31064): the batch asserts the scope it read, like every commit-class tool', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('import_definitions', {
      scope_id: 'other-scope',
      items: [{ kind: 'table', definition: table('dws_seed_j') }],
      ...provenance('s'),
    })
    expect(res.result?.['isError']).toBe(true)
    const body = toolJson(res) as { code: number; name: string }
    expect(body.code).toBe(-31064)
    expect(body.name).toBe('ScopeMismatchError')
  })
})

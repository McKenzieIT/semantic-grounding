/**
 * `import_definitions` — #68 landing #54's seven rulings (ADR-0013): the
 * two-phase per-item-verdict batch import. Pinned here: the single-commit
 * shape (Files/Rounds trailers), the four verdicts' triggers (created /
 * updated / skipped / error), cross-kind in-batch name dedup, the permissive
 * SDK envelope keeping one bad item from rejecting the whole call, the 500
 * cap, and the `derivation: 'agent'` narrowing. #104 later pinned ADR-0018's
 * review surface on the same tool: the `dry_run` read-only rehearsal and the
 * `updated`-keyed mass-update guard. The ADR-0019 describe block below pins
 * the re-sync policy layered on top (#111): the concept read-merge-write
 * (R2), the round-trip projection contract (R3), table/event round-trip
 * unchanged (R4), and the ratio guard (R6).
 *
 * @see docs/adr/0013-batch-definition-import.md
 * @see docs/adr/0018-batch-intake-review-surface.md
 * @see docs/adr/0019-odps-resync-policy.md
 */
import { afterEach, describe, expect, it } from 'vitest'
import { buildIntentToolHarness, tier2, versionOf, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
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
  /** Present only when a batch-overwrite guard tripped (zero-tax: absent, never empty). */
  readonly warnings?: readonly string[]
}

/** The dry-run branch's response body (ADR-0018 R2) — a read-tool shape, not a write receipt. */
interface DryRunBody {
  readonly committed: boolean
  readonly results: Array<{ index: number; kind: string; name: string; verdict: string; version?: string; detail?: string }>
  readonly staged: Array<{ index: number; kind: string; name: string; verdict: string; version?: string }>
  readonly summary: { created: number; updated: number; skipped: number; errors: number }
  /** Same guard lines a real write would carry — the preview must predict them exactly. */
  readonly warnings?: readonly string[]
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

describe('import_definitions — ADR-0018 (#104 dry-run preview + mass-update guard)', () => {
  it('R2: dry_run:true returns Phase 1\'s verdicts read-only — zero commits, HEAD still, no write-receipt keys, no _guidance, no version anywhere', async () => {
    h = await buildIntentToolHarness()
    // Seed two tables: one to overwrite (updated), one to re-import verbatim (skipped).
    for (const [name, comment] of [['dws_dry_a', 'v1'], ['dws_dry_c', 'v1']] as const) {
      await h.client.callTool('create_definition', {
        scope_id: 'fixture', kind: 'table',
        table: table(name, comment),
        summary: 'seed', derivation: 'agent', confidence: 0.9,
      })
    }
    const before = commitCount(h)
    const head = fixtureGit(['rev-parse', 'HEAD'], h.fixture.root).trim()
    const res = await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: [
        { kind: 'table', definition: table('dws_dry_a', 'v2') }, // would update
        { kind: 'table', definition: table('dws_dry_b') }, // would create
        { kind: 'table', definition: table('dws_dry_c', 'v1') }, // would skip
        { kind: 'table', definition: { table_name: 'dim_broken', kind: 'dim', columns: [] } }, // error
      ],
      ...provenance('preview only'),
      dry_run: true,
    })
    const body = toolJson(res) as unknown as DryRunBody
    expect(res.result?.['isError']).toBeFalsy()
    // Read-only branch: the preview says committed:false and carries none of the
    // audit envelope's facts (no commit sha, no changed flag, no _guidance —
    // the audit window never opened, so those keys would be lies).
    expect(body.committed).toBe(false)
    expect(body).not.toHaveProperty('commit')
    expect(body).not.toHaveProperty('changed')
    expect(body).not.toHaveProperty('_guidance')
    // The full four-verdict spectrum, in input order, from the same Phase-1
    // adjudication a real call runs.
    expect(body.results.map(r => [r.index, r.verdict])).toEqual([
      [0, 'updated'], [1, 'created'], [2, 'skipped'], [3, 'error'],
    ])
    expect(body.summary).toEqual({ created: 1, updated: 1, skipped: 1, errors: 1 })
    // Staged = exactly what a real write would land (its will-write list).
    expect(body.staged.map(s => [s.index, s.name, s.verdict])).toEqual([
      [0, 'dws_dry_a', 'updated'], [1, 'dws_dry_b', 'created'],
    ])
    // #108 semantics: version is a post-write receipt — nothing was written, so
    // no row (staged or skipped) carries one.
    for (const r of [...body.results, ...body.staged]) expect(r).not.toHaveProperty('version')
    // Zero commits, HEAD untouched, disk untouched.
    expect(commitCount(h)).toBe(before)
    expect(fixtureGit(['rev-parse', 'HEAD'], h.fixture.root).trim()).toBe(head)
    expect(h.core.loadTableDefinition('dws_dry_b')).toBeNull()
    expect(h.core.loadTableDefinition('dws_dry_a')?.table_comment).toBe('v1')
    // A preview of a non-tripping batch carries no warnings key (zero-tax: absent, not empty).
    expect(body).not.toHaveProperty('warnings')
  })

  it('Verification: dry_run and the same call without it return item-for-item identical verdicts — the preview is a faithful rehearsal', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('create_definition', {
      scope_id: 'fixture', kind: 'table',
      table: table('dws_parity_a', 'v1'),
      summary: 'seed', derivation: 'agent', confidence: 0.9,
    })
    const batch = {
      scope_id: 'fixture',
      items: [
        { kind: 'table', definition: table('dws_parity_a', 'v2') },
        { kind: 'table', definition: table('dws_parity_b') },
        { kind: 'event', definition: event('game.parity.b') },
        { kind: 'concept', definition: concept('parity_item') },
        { kind: 'concept', definition: concept('parity_item') }, // duplicate name
        { kind: 'table', definition: { table_name: 'dim_broken', kind: 'dim', columns: [] } }, // zod error
      ],
      ...provenance('parity probe'),
    }
    const dry = toolJson(await h.client.callTool('import_definitions', { ...batch, dry_run: true })) as unknown as DryRunBody
    const real = toolJson(await h.client.callTool('import_definitions', batch)) as unknown as ImportBody
    // The five-tuple (index, kind, name, verdict, detail) is identical row for
    // row — `version` is the one write-time fact; verdicts and the item-verb
    // strip receipt are Phase 1's, so the preview carries them too.
    expect(dry.results.map(r => [r.index, r.kind, r.name, r.verdict, r.detail ?? null]))
      .toEqual(real.results.map(r => [r.index, r.kind, r.name, r.verdict, r.detail ?? null]))
    expect(dry.summary).toEqual(real.summary)
    // And the real rows now carry the receipts the preview correctly lacked.
    expect(real.results.filter(r => r.verdict === 'created' || r.verdict === 'updated').every(r => r.version !== undefined)).toBe(true)
  })

  it('R3: a cold start (all created, 60 > default threshold 50) trips nothing — the guard keys on updated, not size', async () => {
    h = await buildIntentToolHarness()
    const items = Array.from({ length: 60 }, (_, i) => ({ kind: 'table' as const, definition: table(`dws_cold_${i}`) }))
    const res = await h.client.callTool('import_definitions', { scope_id: 'fixture', items, ...provenance('cold start 60') })
    const body = toolJson(res) as unknown as ImportBody
    expect(body.summary).toEqual({ created: 60, updated: 0, skipped: 0, errors: 0 })
    expect(body).not.toHaveProperty('warnings')
    expect(lastMessage(h)).not.toContain('mass-update')
  })

  it('R3/R4: 51 updated (default threshold 50) warns and annotates the commit subject — and still lands; exactly 50 stays silent', async () => {
    h = await buildIntentToolHarness()
    const names = Array.from({ length: 51 }, (_, i) => `dws_ovw_${i}`)
    const seed = await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: names.map(n => ({ kind: 'table' as const, definition: table(n, 'v1') })),
      ...provenance('seed v1'),
    })
    expect((toolJson(seed) as unknown as ImportBody)).not.toHaveProperty('warnings')
    const before = commitCount(h)

    // 51 updated > 50: the response warns, the subject is annotated, the write lands.
    const res = await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: names.map(n => ({ kind: 'table' as const, definition: table(n, 'v2') })),
      ...provenance('re-import v2'),
    })
    const body = toolJson(res) as unknown as ImportBody
    expect(res.result?.['isError']).toBeFalsy() // soft signal, never a refusal
    expect(body.changed).toBe(true)
    expect(body.summary).toEqual({ created: 0, updated: 51, skipped: 0, errors: 0 })
    // Both guards fire independently on this batch (integration semantic):
    // the count guard (51 > 50) AND the ratio guard (51/53 tables, 96% > 50%).
    expect(body.warnings).toHaveLength(2)
    expect(body.warnings?.[0]).toMatch(/^mass-update guard: 51 updated exceeds threshold 50$/)
    expect(body.warnings?.[1]).toMatch(/ratio-guard \(ADR-0019 R6\): table 51\/53 \(96% > 50%\)/)
    expect(commitCount(h)).toBe(before + 1)
    const msg = lastMessage(h)
    expect(msg).toMatch(/; mass-update guard: 51 updated exceeds threshold 50/)
    expect(msg).toMatch(/ — ratio-guard: table 51\/53 \(96% > 50%\)/)
    // The annotation is the post-hoc reader's grep handle (ADR-0018 R4 role ③).
    expect(msg).toMatch(/X-SG-Tool: import_definitions/)

    // Exactly 50 is AT the count threshold, not over it: the count guard is
    // silent (the ratio guard still speaks — 50/53 is 94%).
    const at = await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: names.slice(0, 50).map(n => ({ kind: 'table' as const, definition: table(n, 'v3') })),
      ...provenance('re-import v3'),
    })
    const atBody = toolJson(at) as unknown as ImportBody
    expect(atBody.summary).toEqual({ created: 0, updated: 50, skipped: 0, errors: 0 })
    expect(atBody.warnings?.some(w => w.startsWith('mass-update guard:'))).toBeFalsy()
    expect(lastMessage(h)).not.toContain('mass-update')
  })

  it('R5: the threshold is configurable, and the dry-run preview carries the same warnings the real write would get', async () => {
    h = await buildIntentToolHarness({ massUpdateWarnThreshold: 2 })
    const names = ['dws_thr_a', 'dws_thr_b', 'dws_thr_c']
    await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: names.map(n => ({ kind: 'table' as const, definition: table(n, 'v1') })),
      ...provenance('seed v1'),
    })
    const v2 = { scope_id: 'fixture', items: names.map(n => ({ kind: 'table' as const, definition: table(n, 'v2') })), ...provenance('re-import v2') }
    const dry = toolJson(await h.client.callTool('import_definitions', { ...v2, dry_run: true })) as unknown as DryRunBody
    expect(dry.committed).toBe(false)
    expect(dry.warnings?.[0]).toMatch(/^mass-update guard: 3 updated exceeds threshold 2$/)
    const real = toolJson(await h.client.callTool('import_definitions', v2)) as unknown as ImportBody
    expect(real.warnings?.[0]).toMatch(/^mass-update guard: 3 updated exceeds threshold 2$/)
    expect(lastMessage(h)).toMatch(/mass-update guard: 3 updated exceeds threshold 2/)
  })
})

describe('import_definitions — ADR-0019 (#111 re-sync projection + concept preserve + ratio guard)', () => {
  /** Plant the full item-verb layer on a concept: one declared edge (related_refs)
   * plus one vetoed alias (suppressed_alt_labels), both via the item-verb tools
   * that own them — the state an `updated` overwrite must not erase. */
  async function plantEdges(name: string): Promise<void> {
    await h!.client.callTool('add_relation', {
      scope_id: 'fixture', kind: 'concept', name,
      relations: [{ target_kind: 'table', name: 'dim_shop' }],
      expected_version: await versionOf(h!, name, 'concept'),
      ...tier2('declare the edge', 0.9),
    })
    await h!.client.callTool('remove_alias', {
      scope_id: 'fixture', kind: 'concept', name, labels: ['弃用旧称'],
      expected_version: await versionOf(h!, name, 'concept'),
      ...tier2('veto the stale label', 0.9),
    })
  }

  it('R2: a concept `updated` preserves on-disk related_refs/suppressed_* — the data-loss regression', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: [{ kind: 'concept', definition: concept('drift_concept', 'v1 meaning') }],
      ...provenance('seed'),
    })
    await plantEdges('drift_concept')
    const before = h.core.loadConceptDefinition('drift_concept')
    expect(before?.related_refs).toHaveLength(1)
    expect(before?.suppressed_alt_labels).toEqual(['弃用旧称'])

    // The drifted re-import: five describable keys changed, item-verb keys absent.
    const res = await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: [{ kind: 'concept', definition: concept('drift_concept', 'v2 meaning after ODPS drift') }],
      ...provenance('re-sync after drift'),
    })
    const body = toolJson(res) as unknown as ImportBody
    expect(body.summary).toEqual({ created: 0, updated: 1, skipped: 0, errors: 0 })
    const after = h.core.loadConceptDefinition('drift_concept')
    // The overwrite landed on the describable layer…
    expect(after?.description).toBe('v2 meaning after ODPS drift')
    // …and the item-verb layer survived it (R2: import never writes edges, so it
    // must never erase them — concepts have no enrichment round to re-derive a
    // dropped edge; before #111 this read back [] and the veto was gone).
    expect(after?.related_refs).toEqual(before?.related_refs)
    expect(after?.suppressed_alt_labels).toEqual(['弃用旧称'])
    // #108's receipt still names the merged file: updateConceptMeta's version
    // is the written sha, exactly what a later expected_version needs.
    expect(row(body, 0).version).toBe(await versionOf(h, 'drift_concept', 'concept'))
  })

  it('R3: a get_definition concept output feeds straight back — no zod failure, keys stripped and receipted', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: [{ kind: 'concept', definition: concept('roundtrip_c', 'v1 meaning') }],
      ...provenance('seed'),
    })
    await plantEdges('roundtrip_c')
    const read = toolJson(await h.client.callTool('get_definition', { kind: 'concept', name: 'roundtrip_c' })) as {
      readonly definition: Record<string, unknown>
    }
    // get_definition's output carries all eight keys — the exact object #94's
    // dogfood could not feed back.
    expect('related_refs' in read.definition).toBe(true)
    expect('suppressed_alt_labels' in read.definition).toBe(true)
    expect('suppressed_related_refs' in read.definition).toBe(true)

    // Unmodified re-feed: five-key projection equal → skipped (idempotent), with
    // the strip receipt on the row.
    const same = toolJson(await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: [{ kind: 'concept', definition: read.definition }],
      ...provenance('round-trip, unchanged'),
    })) as unknown as ImportBody
    expect(same.summary).toEqual({ created: 0, updated: 0, skipped: 1, errors: 0 })
    expect(row(same, 0).detail).toBe('ignored 3 item-verb keys (related_refs/suppressed_* are add_relation/add_alias territory)')

    // Drifted re-feed (description changed, item-verb keys still riding along
    // from the get_definition output): updated, edges preserved.
    const changed = toolJson(await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: [{ kind: 'concept', definition: { ...read.definition, description: 'v2 meaning after drift' } }],
      ...provenance('round-trip, drifted'),
    })) as unknown as ImportBody
    expect(changed.summary).toEqual({ created: 0, updated: 1, skipped: 0, errors: 0 })
    expect(row(changed, 0).detail).toMatch(/^ignored 3 item-verb keys/)
    expect(h.core.loadConceptDefinition('roundtrip_c')?.related_refs).toHaveLength(1)
  })

  it('R3: a genuinely unknown concept key is still REJECTED — typo-catching does not regress', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: [{ kind: 'concept', definition: { ...concept('typo_c'), relted_refs: [] } }],
      ...provenance('s'),
    })
    const body = toolJson(res) as unknown as ImportBody
    expect(body.summary).toEqual({ created: 0, updated: 0, skipped: 0, errors: 1 })
    expect(row(body, 0).detail).toMatch(/zod:.*[Uu]nrecognized key/)
  })

  it('R4: table round-trip is unchanged — inline dimension_refs survive the full-payload overwrite', async () => {
    h = await buildIntentToolHarness()
    // Seed with an inline dimension_ref (the K11 shape: refs ride the payload).
    await h.client.callTool('create_definition', {
      scope_id: 'fixture', kind: 'table',
      table: table('dws_rt', 'v1 comment'),
      summary: 'seed', derivation: 'agent', confidence: 0.9,
    })
    await h.client.callTool('add_relation', {
      scope_id: 'fixture', kind: 'table', name: 'dws_rt',
      relations: [{ dim_table: 'dim_shop', join_keys: [{ dws_column: 'shop_id', dim_column: 'shop_id' }] }],
      expected_version: await versionOf(h, 'dws_rt'),
      ...tier2('declare the join', 0.9),
    })
    const read = toolJson(await h.client.callTool('get_definition', { kind: 'table', name: 'dws_rt' })) as {
      readonly definition: Record<string, unknown>
    }
    // The get_definition output (dimension_refs riding inline, `.loose()`
    // round-trip) fed straight back with a drifted comment: full overwrite for
    // tables/events, refs are payload fields — behavior deliberately unchanged.
    const res = await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: [{ kind: 'table', definition: { ...read.definition, table_comment: 'v2 comment' } }],
      ...provenance('re-sync'),
    })
    const body = toolJson(res) as unknown as ImportBody
    expect(body.summary).toEqual({ created: 0, updated: 1, skipped: 0, errors: 0 })
    const after = h.core.loadTableDefinition('dws_rt')
    expect(after?.table_comment).toBe('v2 comment')
    expect(after?.dimension_refs).toHaveLength(1)
  })

  it('R6: cold start (all created) is silent — no warnings key, no trailer', async () => {
    h = await buildIntentToolHarness({ fixtureOpts: { withDim: false } })
    const res = await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: [0, 1, 2, 3].map(i => ({ kind: 'table' as const, definition: table(`dws_cold_${i}`) })),
      ...provenance('cold start'),
    })
    const body = toolJson(res) as unknown as ImportBody
    expect(body.summary).toEqual({ created: 4, updated: 0, skipped: 0, errors: 0 })
    expect(body).not.toHaveProperty('warnings')
    expect(lastMessage(h)).not.toMatch(/ratio-guard/)
  })

  it('R6: drift over the default threshold WARNs and annotates the commit trailer (default 50%/floor 10 pinned)', async () => {
    h = await buildIntentToolHarness({ fixtureOpts: { withDim: false } })
    // Existing tables after seeding: 1 fixture + 11 seeded = 12 (≥ floor 10).
    await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: Array.from({ length: 11 }, (_, i) => ({ kind: 'table' as const, definition: table(`dws_ratio_${i}`) })),
      ...provenance('seed the corpus'),
    })
    // Update 8 of 12 = 67% > 50% at the DEFAULT config — the guard fires.
    const res = await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: Array.from({ length: 8 }, (_, i) => ({ kind: 'table' as const, definition: table(`dws_ratio_${i}`, 'drifted comment') })),
      ...provenance('re-sync after drift'),
    })
    const body = toolJson(res) as unknown as ImportBody
    expect(body.summary).toEqual({ created: 0, updated: 8, skipped: 0, errors: 0 })
    expect(body.warnings).toHaveLength(1)
    expect(body.warnings?.[0]).toMatch(/ratio-guard \(ADR-0019 R6\): table 8\/12 \(67% > 50%\)/)
    // The trailer rides the commit subject via the intent target — the post-hoc
    // git-log reader's grep handle (same channel ADR-0018 R4 chose).
    const msg = lastMessage(h)
    expect(msg).toMatch(/import_definitions\(8\/8 items \(0 created, 8 updated\) — ratio-guard: table 8\/12 \(67% > 50%\)\)/)
  })

  it('R6: below the default threshold (4/12 = 33%) stays silent', async () => {
    h = await buildIntentToolHarness({ fixtureOpts: { withDim: false } })
    await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: Array.from({ length: 11 }, (_, i) => ({ kind: 'table' as const, definition: table(`dws_quiet_${i}`) })),
      ...provenance('seed the corpus'),
    })
    const res = await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: Array.from({ length: 4 }, (_, i) => ({ kind: 'table' as const, definition: table(`dws_quiet_${i}`, 'drifted comment') })),
      ...provenance('re-sync after drift'),
    })
    const body = toolJson(res) as unknown as ImportBody
    expect(body.summary).toEqual({ created: 0, updated: 4, skipped: 0, errors: 0 })
    expect(body).not.toHaveProperty('warnings')
    expect(lastMessage(h)).not.toMatch(/ratio-guard/)
  })

  it('R6: below the default floor (6 existing) stays silent even at 100% — small corpora are the count guard\'s call', async () => {
    h = await buildIntentToolHarness({ fixtureOpts: { withDim: false } })
    await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: Array.from({ length: 5 }, (_, i) => ({ kind: 'table' as const, definition: table(`dws_floor_${i}`) })),
      ...provenance('seed the corpus'),
    })
    const res = await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: Array.from({ length: 5 }, (_, i) => ({ kind: 'table' as const, definition: table(`dws_floor_${i}`, 'drifted comment') })),
      ...provenance('re-sync after drift'),
    })
    const body = toolJson(res) as unknown as ImportBody
    // 5/6 = 83% > 50%, but existing 6 < floor 10: ratio over a tiny corpus is
    // noise, only the absolute count guard (ADR-0018, #104) applies.
    expect(body.summary).toEqual({ created: 0, updated: 5, skipped: 0, errors: 0 })
    expect(body).not.toHaveProperty('warnings')
  })

  it('R6: both knobs are configurable — threshold 1 never trips, floor 5 lets the small corpus trip', async () => {
    // threshold 1: 8/12 = 67% no longer exceeds it.
    h = await buildIntentToolHarness({ fixtureOpts: { withDim: false }, massUpdateRatio: { threshold: 1 } })
    await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: Array.from({ length: 11 }, (_, i) => ({ kind: 'table' as const, definition: table(`dws_cfg_${i}`) })),
      ...provenance('seed the corpus'),
    })
    const quiet = toolJson(await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: Array.from({ length: 8 }, (_, i) => ({ kind: 'table' as const, definition: table(`dws_cfg_${i}`, 'drifted comment') })),
      ...provenance('re-sync after drift'),
    })) as unknown as ImportBody
    expect(quiet.summary).toEqual({ created: 0, updated: 8, skipped: 0, errors: 0 })
    expect(quiet).not.toHaveProperty('warnings')
  })

  it('R6: a lower floor lets the small corpus evaluate and trip (floor is a real knob)', async () => {
    // floor 5: the 5/6 corpus from the floor test now evaluates and trips.
    h = await buildIntentToolHarness({ fixtureOpts: { withDim: false }, massUpdateRatio: { floor: 5 } })
    await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: Array.from({ length: 5 }, (_, i) => ({ kind: 'table' as const, definition: table(`dws_cfg2_${i}`) })),
      ...provenance('seed the corpus'),
    })
    const loud = toolJson(await h.client.callTool('import_definitions', {
      scope_id: 'fixture',
      items: Array.from({ length: 5 }, (_, i) => ({ kind: 'table' as const, definition: table(`dws_cfg2_${i}`, 'drifted comment') })),
      ...provenance('re-sync after drift'),
    })) as unknown as ImportBody
    expect(loud.warnings?.[0]).toMatch(/table 5\/6 \(83% > 50%\)/)
  })
})

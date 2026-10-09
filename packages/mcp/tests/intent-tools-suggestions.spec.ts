/**
 * ADR-0005's Tier-1 suggestion quartet — behaviour: `submit_suggestion`,
 * `list_suggestions`, `get_suggestion`, `discard_suggestion`.
 *
 * The load-bearing regression this file exists for: the pending queue lives at
 * `<gitDir>/sg-pending/`, *not* inside the worktree (`tools/shared.ts`'s
 * `pendingQueueRoot` doc — the same hazard `git/lock.ts` already states for the
 * corpus lock). If it lived in the worktree instead, `submit_suggestion` would leave
 * an untracked file `git status --porcelain` reports as dirty, and the *next* Tier-2
 * write would refuse with `PostureRefusedError` — mistaking an agent's own suggestion
 * for an operator's uncommitted edit. This file asserts that never happens.
 *
 * @see docs/adr/0005-mcp-tool-surface.md
 */
import { afterEach, describe, expect, it } from 'vitest'
import { buildIntentToolHarness, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
import { fixtureGit } from './helpers/fixture-corpus.ts'
import { toolJson } from './helpers/inprocess-client.ts'

let h: IntentToolHarness | undefined
afterEach(() => h?.close())

describe('submit_suggestion / list_suggestions / get_suggestion / discard_suggestion', () => {
  it('submits a suggestion and reads it back by id', async () => {
    h = await buildIntentToolHarness()
    const submitRes = await h.client.callTool('submit_suggestion', {
      kind: 'alt_label',
      subject: 'dws_order',
      content: '订单宽表',
    })
    const submitted = toolJson(submitRes) as { suggestion: { suggestion_id: string; kind: string; subject: string; content: string } }
    expect(submitted.suggestion.subject).toBe('dws_order')

    const getRes = await h.client.callTool('get_suggestion', { suggestion_id: submitted.suggestion.suggestion_id })
    const got = toolJson(getRes) as { suggestion: { content: string } }
    expect(got.suggestion.content).toBe('订单宽表')
  })

  it('lists every submitted suggestion, oldest first', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('submit_suggestion', { kind: 'alt_label', subject: 'a', content: '1' })
    await h.client.callTool('submit_suggestion', { kind: 'alt_label', subject: 'b', content: '2' })
    const res = await h.client.callTool('list_suggestions', {})
    const body = toolJson(res) as { suggestions: Array<{ subject: string }> }
    expect(body.suggestions.map(s => s.subject)).toEqual(['a', 'b'])
  })

  it('errors with suggestion_not_found (-31023) for an unknown id', async () => {
    h = await buildIntentToolHarness()
    const res = await h.client.callTool('get_suggestion', { suggestion_id: '20260101T000000Z_deadbeef_0000' })
    expect(res.result?.['isError']).toBe(true)
    const body = toolJson(res)
    expect(body['code']).toBe(-31023)
    expect(body['name']).toBe('SuggestionNotFoundError')
  })

  it('discards a suggestion, which then reads back as not found', async () => {
    h = await buildIntentToolHarness()
    const submitted = (toolJson(await h.client.callTool('submit_suggestion', { kind: 'x', subject: 'y', content: 'z' })) as {
      suggestion: { suggestion_id: string }
    }).suggestion
    const discardRes = await h.client.callTool('discard_suggestion', { suggestion_id: submitted.suggestion_id })
    expect(toolJson(discardRes)['discarded']).toBe(true)

    const getRes = await h.client.callTool('get_suggestion', { suggestion_id: submitted.suggestion_id })
    expect(getRes.result?.['isError']).toBe(true)
    expect(toolJson(getRes)['code']).toBe(-31023)
  })

  it('discarding twice errors the second time with suggestion_not_found', async () => {
    h = await buildIntentToolHarness()
    const submitted = (toolJson(await h.client.callTool('submit_suggestion', { kind: 'x', subject: 'y', content: 'z' })) as {
      suggestion: { suggestion_id: string }
    }).suggestion
    await h.client.callTool('discard_suggestion', { suggestion_id: submitted.suggestion_id })
    const second = await h.client.callTool('discard_suggestion', { suggestion_id: submitted.suggestion_id })
    expect(second.result?.['isError']).toBe(true)
    expect(toolJson(second)['code']).toBe(-31023)
  })

  it('never touches source-of-truth, never commits, and is not an audited mutation', async () => {
    h = await buildIntentToolHarness()
    const commitsBefore = fixtureGit(['rev-list', '--count', 'HEAD'], h.fixture.root).trim()
    await h.client.callTool('submit_suggestion', { kind: 'alt_label', subject: 'dws_order', content: '订单宽表' })
    expect(fixtureGit(['rev-list', '--count', 'HEAD'], h.fixture.root).trim()).toBe(commitsBefore)
  })
})

describe('the pending queue does not dirty the corpus worktree', () => {
  it('leaves `git status --porcelain` empty after submit_suggestion', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('submit_suggestion', { kind: 'alt_label', subject: 'dws_order', content: '订单宽表' })
    expect(fixtureGit(['status', '--porcelain'], h.fixture.root).trim()).toBe('')
  })

  it('a Tier-2 write still succeeds after a suggestion was submitted — the posture check never mistakes it for an uncommitted edit', async () => {
    h = await buildIntentToolHarness()
    await h.client.callTool('submit_suggestion', { kind: 'alt_label', subject: 'dws_order', content: '订单宽表' })

    const versionRes = toolJson(await h.client.callTool('get_definition', { kind: 'table', name: 'dws_order' })) as { version: string }
    const res = await h.client.callTool('update_definition', {
      kind: 'table',
      name: 'dws_order',
      fields: { description: '订单宽表' },
      summary: '补充描述',
      derivation: 'agent',
      confidence: 0.9,
      expected_version: versionRes.version,
    })
    expect(res.result?.['isError']).toBeUndefined()
    expect((toolJson(res) as { changed: boolean }).changed).toBe(true)
  })

  it('the pending-queue directory lives under .git, not the worktree', async () => {
    h = await buildIntentToolHarness()
    const submitted = (toolJson(await h.client.callTool('submit_suggestion', { kind: 'x', subject: 'y', content: 'z' })) as {
      suggestion: { suggestion_id: string }
    }).suggestion
    const paths = await h.recorder.ready()
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    expect(existsSync(join(paths.gitDir, 'sg-pending', `${submitted.suggestion_id}.json`))).toBe(true)
  })
})

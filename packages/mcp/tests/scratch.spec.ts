/**
 * ADR-0020's scratch home — behaviour: `acquire_scratch_dir`
 * ([#92](https://github.com/McKenzieIT/semantic-grounding/issues/92) /
 * [#101](https://github.com/McKenzieIT/semantic-grounding/issues/101)).
 *
 * The load-bearing regression this file exists for is the same one the
 * suggestion quartet's spec pins for `sg-pending/`: the scratch home lives at
 * `<gitDir>/sg-scratch/`, *not* inside the worktree. The agent works in bash —
 * SQL dumps, re-probed schemas, drafted YAML — and any of that dropped in the
 * corpus worktree leaves an untracked file `git status --porcelain` reports as
 * dirty, making the *next* Tier-2 write refuse with `PostureRefusedError`
 * (both clean-worktree gates, `posture.ts` / `recorder.ts`). This file asserts
 * exploration junk in the acquired run directory never does that.
 *
 * The second contract is the GC: #92 ruled cleanup the **server's** job (a seam
 * that relies on agent discipline only moves the pollution), so every acquire
 * prunes the home to the newest N run directories (default 3), touching only
 * directories whose names match the run-id format — never anything it cannot
 * recognize.
 *
 * @see docs/adr/0020-agent-scratch-home.md
 */
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildIntentToolHarness, tier2, type IntentToolHarness } from './helpers/intent-tools-harness.ts'
import { fixtureGit } from './helpers/fixture-corpus.ts'
import { toolJson } from './helpers/inprocess-client.ts'

let h: IntentToolHarness | undefined
afterEach(() => h?.close())

/** One acquire's response body, as this file reads it back. */
type AcquireBody = {
  readonly run_id: string
  readonly path: string
  readonly retention: { readonly keeps_last: number; readonly pruned_run_ids: readonly string[] }
}

async function acquire(h: IntentToolHarness): Promise<AcquireBody> {
  return toolJson(await h.client.callTool('acquire_scratch_dir', {})) as AcquireBody
}

/**
 * Pin a run directory's mtime `seconds` offset from now (negative = into the
 * past), one distinct tick per call. The GC orders runs by mtime, and a tight
 * acquire loop can land inside the filesystem's clock granularity — spacing
 * the mtimes makes "newest" a property the test chose, not one it hoped the
 * clock provided.
 */
function age(h: IntentToolHarness, body: AcquireBody, seconds: number): void {
  const at = new Date(Date.now() + seconds * 1000)
  utimesSync(body.path, at, at)
}

describe('acquire_scratch_dir — placement', () => {
  it('returns a run id and an existing directory directly under <gitDir>/sg-scratch/', async () => {
    h = await buildIntentToolHarness()
    const body = await acquire(h)
    expect(body.run_id).toMatch(/^[0-9]{8}T[0-9]{6}Z_[0-9a-f]{6}$/)
    const paths = await h.recorder.ready()
    expect(body.path).toBe(join(paths.gitDir, 'sg-scratch', body.run_id))
    expect(existsSync(body.path)).toBe(true)
    expect(readdirSync(join(paths.gitDir, 'sg-scratch'))).toContain(body.run_id)
  })

  it('is not an audited mutation: no commit, no trailer, no corpus content touched', async () => {
    h = await buildIntentToolHarness()
    const before = fixtureGit(['rev-list', '--count', 'HEAD'], h.fixture.root).trim()
    await acquire(h)
    expect(fixtureGit(['rev-list', '--count', 'HEAD'], h.fixture.root).trim()).toBe(before)
  })
})

describe('the scratch home does not dirty the corpus worktree', () => {
  it('leaves `git status --porcelain` empty with exploration junk inside the run directory', async () => {
    h = await buildIntentToolHarness()
    const body = await acquire(h)
    writeFileSync(join(body.path, 'probe.sql'), '-- exploration draft, ODPS re-probe\n')
    writeFileSync(join(body.path, 'dws_order.draft.yaml'), 'table_name: dws_order\n')
    expect(fixtureGit(['status', '--porcelain'], h.fixture.root).trim()).toBe('')
  })

  it('a Tier-2 write still succeeds with scratch junk on disk — neither clean-worktree gate mistakes it for an uncommitted edit', async () => {
    h = await buildIntentToolHarness()
    const body = await acquire(h)
    writeFileSync(join(body.path, 'probe.sql'), '-- exploration draft\n')

    const versionRes = toolJson(await h.client.callTool('get_definition', { kind: 'table', name: 'dws_order' })) as { version: string }
    const res = await h.client.callTool('update_definition', {
      scope_id: 'fixture',
      kind: 'table',
      name: 'dws_order',
      fields: { description: '订单宽表（探索后写回）' },
      expected_version: versionRes.version,
      ...tier2('探索后写回', 0.9),
    })
    expect(res.result?.['isError']).toBeUndefined()
    expect((toolJson(res) as { changed: boolean }).changed).toBe(true)
  })
})

describe('acquire_scratch_dir — the server-side GC (#92: cleanup is the server\'s job)', () => {
  it('keeps only the newest three run directories (the default), reporting what it pruned', async () => {
    h = await buildIntentToolHarness()
    const paths = await h.recorder.ready()
    const home = join(paths.gitDir, 'sg-scratch')
    // Four pre-existing run directories with spaced past mtimes. The GC's unit
    // of work is the directory layout, so these are laid out directly — driving
    // them through the tool would prune mid-setup (every acquire prunes) before
    // the aging lands.
    const names = ['20260101T000000Z_000001', '20260101T000001Z_000002', '20260101T000002Z_000003', '20260101T000003Z_000004']
    const base = Date.now() - 60_000
    names.forEach((name, i) => {
      const dir = join(home, name)
      mkdirSync(dir, { recursive: true })
      const at = new Date(base + i * 10_000)
      utimesSync(dir, at, at)
    })
    const fifth = await acquire(h)
    expect(fifth.retention.keeps_last).toBe(3)
    expect(fifth.retention.pruned_run_ids).toEqual([names[0], names[1]])
    expect(readdirSync(home).sort()).toEqual([names[2], names[3], fifth.run_id].sort())
  })

  it('orders by mtime, not by birth: a touched old run survives over an untouched newer one', async () => {
    h = await buildIntentToolHarness({ scratchRunsToKeep: 2 })
    const first = await acquire(h)
    const second = await acquire(h)
    // Bump the OLD run's mtime past the second one's — the GC protects the run an
    // agent is still writing into over mere birth order.
    age(h, first, 60)
    const third = await acquire(h)
    expect(third.retention.pruned_run_ids).toEqual([second.run_id])
    const paths = await h.recorder.ready()
    expect(readdirSync(join(paths.gitDir, 'sg-scratch')).sort()).toEqual([first.run_id, third.run_id].sort())
  })

  it('never recycles the run its own acquire just handed out, even against a future-dated sibling', async () => {
    h = await buildIntentToolHarness({ scratchRunsToKeep: 1 })
    const first = await acquire(h)
    age(h, first, 3600) // clock-skew shape: an old run whose mtime is an hour in the future
    const second = await acquire(h)
    expect(second.retention.pruned_run_ids).toEqual([first.run_id])
    const paths = await h.recorder.ready()
    expect(readdirSync(join(paths.gitDir, 'sg-scratch'))).toEqual([second.run_id])
    expect(existsSync(second.path)).toBe(true)
  })

  it('honours ServerConfig.scratchRunsToKeep as the retention override', async () => {
    h = await buildIntentToolHarness({ scratchRunsToKeep: 1 })
    const first = await acquire(h)
    const second = await acquire(h)
    expect(second.retention.keeps_last).toBe(1)
    expect(second.retention.pruned_run_ids).toEqual([first.run_id])
    const paths = await h.recorder.ready()
    expect(readdirSync(join(paths.gitDir, 'sg-scratch'))).toEqual([second.run_id])
  })

  it('never prunes anything in the scratch home it does not recognize as a run directory', async () => {
    h = await buildIntentToolHarness()
    const paths = await h.recorder.ready()
    const home = join(paths.gitDir, 'sg-scratch')
    mkdirSync(join(home, 'operator-notes'), { recursive: true })
    writeFileSync(join(home, 'README.txt'), 'not a run\n')
    for (let i = 0; i < 4; i++) await acquire(h)
    expect(existsSync(join(home, 'operator-notes'))).toBe(true)
    expect(existsSync(join(home, 'README.txt'))).toBe(true)
  })

  it('two acquires inside the same second get distinct run ids (the nonce)', async () => {
    h = await buildIntentToolHarness()
    const a = await acquire(h)
    const b = await acquire(h)
    expect(a.run_id).not.toBe(b.run_id)
  })
})

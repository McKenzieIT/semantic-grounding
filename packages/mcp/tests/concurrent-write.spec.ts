/**
 * ADR-0004 ruling 7 — cross-process serialization, the integration half.
 *
 * #19's first acceptance item: "两进程并发写同一 fixture corpus 的集成测试（锁串行 +
 * 无丢更新）". Real OS processes, not two instances in one event loop — the lock's whole
 * claim is about processes, and an in-process test would exercise the reentrancy counter
 * instead of the lock file.
 *
 * ## The two things being proven
 *
 * **Serialized.** Writes queue on the lock, so the audit history is a clean chain: N
 * writes produce N commits, each with one parent, and the index is never shared.
 *
 * **No lost update.** Each writer appends its own label to `alt_labels` inside its own
 * `runAudited` window. Shallow-merging a whole array field is precisely the hole
 * ADR-0004 ruling 8 describes ("整字段覆盖丢别人的改动"): unserialized, two writers both
 * read `[]`, both write a one-element array, and a label disappears with no error
 * raised anywhere. Every label surviving is the observable form of the guarantee.
 *
 * @see docs/adr/0004-git-tier2-audit-backbone.md ruling 7
 */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadTables } from '@semantic-grounding/substrate'
import { createFixtureCorpus, fixtureGit, type FixtureCorpus } from './helpers/fixture-corpus.ts'

const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'concurrent-writer.ts')

let fixture: FixtureCorpus

beforeEach(() => {
  fixture = createFixtureCorpus()
})
afterEach(() => fixture.cleanup())

/** One worker's outcome. */
interface WorkerResult {
  readonly label: string
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Spawn one writer process.
 * @param label - the alias this writer appends (also its agent id suffix).
 * @param jitterMs - how long it waits between reading and writing, widening the race.
 * @returns the worker's exit code and streams.
 */
function spawnWriter(label: string, jitterMs: number): Promise<WorkerResult> {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      [WORKER, fixture.root, `agent-${label}`, label, String(jitterMs)],
      { encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolve({ label, code, stdout, stderr })
      },
    )
  })
}

/** @returns the alias list currently on `dws_order`. */
function altLabels(): string[] {
  const table = loadTables(fixture.root).find(t => t.table_name === 'dws_order')
  const raw = table?.raw.alt_labels
  return Array.isArray(raw) ? raw.map(String) : []
}

describe('two processes writing one corpus', () => {
  it('serializes them and loses neither update', async () => {
    const results = await Promise.all([spawnWriter('订单宽表', 60), spawnWriter('交易明细', 60)])

    for (const r of results) {
      expect(r.code, `worker ${r.label} failed: ${r.stderr}`).toBe(0)
    }
    // Both labels survive. Unserialized, one of these is silently gone.
    expect(altLabels().sort()).toEqual(['交易明细', '订单宽表'])
    // Two writes, two commits — the lock serialized rather than merged or dropped.
    expect(fixtureGit(['log', '--format=%s'], fixture.root).trim().split('\n')).toHaveLength(3)
  }, 60_000)

  it('records each write under its own agent, so provenance survives contention', async () => {
    await Promise.all([spawnWriter('甲', 40), spawnWriter('乙', 40)])
    const authors = fixtureGit(['log', '--format=%an', '-2'], fixture.root).trim().split('\n').sort()
    expect(authors).toEqual(['agent-乙', 'agent-甲'])
  }, 60_000)
})

describe('four processes writing one corpus', () => {
  // Four rather than two because the failure mode is probabilistic: with two writers an
  // unlocked implementation can get lucky, and with four it essentially cannot.
  it('keeps every update and leaves one commit per write', async () => {
    const labels = ['a', 'b', 'c', 'd']
    const results = await Promise.all(labels.map((l, i) => spawnWriter(l, 25 + i * 10)))

    for (const r of results) {
      expect(r.code, `worker ${r.label} failed: ${r.stderr}`).toBe(0)
    }
    expect(altLabels().sort()).toEqual(labels)
    expect(fixtureGit(['log', '--format=%s'], fixture.root).trim().split('\n')).toHaveLength(labels.length + 1)
  }, 90_000)

  it('leaves the corpus clean and unlocked afterwards', async () => {
    await Promise.all(['a', 'b', 'c', 'd'].map((l, i) => spawnWriter(l, 20 + i * 5)))
    expect(fixtureGit(['status', '--porcelain'], fixture.root).trim()).toBe('')
    // A writer that exits without releasing would leave the next startup to recover it;
    // a writer that exits normally should leave nothing behind at all.
    expect(fixtureGit(['log', '--format=%H', '-1'], fixture.root).trim()).toMatch(/^[0-9a-f]{40}$/)
  }, 90_000)

  // The audit history has to be a chain, not a tangle: each commit with exactly one
  // parent is what makes `git log -p --follow` a readable provenance answer.
  it('produces a linear history', async () => {
    await Promise.all(['a', 'b', 'c', 'd'].map((l, i) => spawnWriter(l, 20 + i * 5)))
    const parentCounts = fixtureGit(['log', '--format=%p'], fixture.root)
      .trim()
      .split('\n')
      .map(line => (line.trim() === '' ? 0 : line.trim().split(/\s+/).length))
    expect(parentCounts.filter(c => c > 1)).toHaveLength(0)
  }, 90_000)
})

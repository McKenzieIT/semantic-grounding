/**
 * A standalone writer process, for the cross-process lock test.
 *
 * Run as `node tests/helpers/concurrent-writer.ts <corpusRoot> <agentId> <label> <jitterMs>`.
 * Node strips the types natively, so this needs no build step and no test runner — which
 * is the point: ADR-0004 ruling 7's lock is a **cross-process** guarantee, and a test
 * that stays inside one process would only exercise the reentrancy counter.
 *
 * (The whole package avoids TypeScript's parameter-property shorthand so these sources
 * run under plain `node`; strip-only mode rejects it, as measured while writing this.)
 *
 * ## What it does, and why that shape
 *
 * Read `alt_labels`, wait, then write back `[...previous, myLabel]` — all **inside** one
 * `runAudited` window. That is the read-modify-write ADR-0005 ruling 3 puts inside the
 * server lock, and it is deliberately the lost-update shape: two unserialized writers
 * both read `[]`, both write a one-element array, and one label vanishes with no error
 * anywhere. The jitter widens the window so an unlocked implementation fails reliably
 * rather than occasionally.
 *
 * Exits 0 on success, 1 with the error on stderr otherwise.
 *
 * @module tests/helpers/concurrent-writer
 */
import { SemanticGroundingCore, loadTables } from '@semantic-grounding/substrate'
import { GitTier2Recorder } from '../../src/git/recorder.ts'

const [corpusRoot, agentId, label, jitterRaw] = process.argv.slice(2)

if (corpusRoot === undefined || agentId === undefined || label === undefined) {
  process.stderr.write('usage: concurrent-writer.ts <corpusRoot> <agentId> <label> [jitterMs]\n')
  process.exit(2)
}

const jitterMs = Number(jitterRaw ?? '40')

/**
 * @param ms - milliseconds to wait.
 * @returns a promise resolving after `ms`.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const recorder = new GitTier2Recorder({
  corpusRoot,
  agentId,
  scopeId: 'fixture',
  // Generous: every writer queues behind every other, and the point of the test is that
  // they serialize rather than that they are fast.
  lock: { timeoutMs: 60_000, pollIntervalMs: 15 },
})
// autoEnrich off so the commit count is exactly one per write — the derived-residue
// commit has its own tests, and here it would only blur the serialization assertion.
const core = new SemanticGroundingCore({ semanticRoot: corpusRoot, autoEnrich: false })
core.setTier2Recorder(recorder)

try {
  const result = await recorder.runAudited(
    {
      tool: 'add_alias',
      target: 'dws_order',
      summary: `添加别名 ${label}`,
      derivation: 'agent',
      confidence: 0.8,
    },
    async () => {
      // Read inside the lock. Reading outside it is the bug this test exists to catch.
      const table = loadTables(corpusRoot).find(t => t.table_name === 'dws_order')
      if (table === undefined) throw new Error('fixture corpus has no dws_order table')
      const existing = Array.isArray(table.raw.alt_labels) ? table.raw.alt_labels : []
      await sleep(jitterMs)
      return core.updateTableMeta('dws_order', { alt_labels: [...existing, label] })
    },
  )
  process.stdout.write(`${JSON.stringify({ label, commit: result.commit, changed: result.changed })}\n`)
  process.exit(0)
} catch (e) {
  process.stderr.write(`${label}: ${(e as Error).message}\n`)
  process.exit(1)
}

/**
 * Regression spec for ticket 02-bump-audit: asserts that every public write
 * primitive bumps `getCorpusVersion(semanticLayer)` after a successful write.
 *
 * Background: `corpusVersion` is a per-path monotonic counter bumped by
 * `invalidateCaches`. The live `getRelationGraph` cache depends on it, but
 * until this spec there was no assertion that *every* write path bumps. A
 * missing bump would silently serve stale data from the cache indefinitely.
 *
 * Audit result (2026-10-13): all 7 public write primitives route through
 * `auditedFileWrite` (io.ts:707), which calls `invalidateCaches` at line 717
 * (after successful write) and 722 (after recorder-failure rollback). So the
 * invariant holds by construction — this spec pins it.
 *
 * @module bump-completeness (test-only; not on barrel)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  dumpYaml,
  getCorpusVersion,
  invalidateCaches,
  loadEvents,
  loadTables,
  updateConceptMeta,
  updateEventMeta,
  updateTableMeta,
  writeConceptYaml,
  writeEventYaml,
  writeTable,
} from '../src/io.ts'
const noopTier2 = () => ({
  recorder: {
    recordTier2Write: async () => {},
  } as any,
})

/** Build a minimal corpus fixture with one table + one event + one concept. */
function buildFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'bump-audit-'))
  mkdirSync(join(root, 'tables'))
  mkdirSync(join(root, 'events', 'default'), { recursive: true })
  mkdirSync(join(root, 'concepts'))
  // One table
  writeFileSync(
    join(root, 'tables', 't1.yaml'),
    dumpYaml({ table_name: 't1', kind: 'dws', columns: [{ name: 'id', type: 'bigint' }] }),
  )
  // One event
  writeFileSync(
    join(root, 'events', 'default', 'e1.yaml'),
    dumpYaml({ name: 'e1', description: 'test event' }),
  )
  // One concept
  writeFileSync(
    join(root, 'concepts', 'c1.yaml'),
    dumpYaml({ name: 'c1', description: 'test concept' }),
  )
  return root
}

describe('bump-completeness: every write primitive bumps getCorpusVersion', () => {
  it('writeTable bumps corpusVersion on success', async () => {
    const root = buildFixture()
    try {
      const v0 = getCorpusVersion(root)
      await writeTable(root, 't2', {
        table_name: 't2',
        kind: 'dws',
        columns: [{ name: 'id', type: 'bigint' }],
      }, {}, noopTier2())
      const v1 = getCorpusVersion(root)
      expect(v1).toBeGreaterThan(v0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writeEventYaml bumps corpusVersion on success', async () => {
    const root = buildFixture()
    try {
      const v0 = getCorpusVersion(root)
      await writeEventYaml(root, 'e2', dumpYaml({
        name: 'e2',
        description: 'second event',
      }), noopTier2())
      const v1 = getCorpusVersion(root)
      expect(v1).toBeGreaterThan(v0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('updateTableMeta bumps corpusVersion on success', async () => {
    const root = buildFixture()
    try {
      const v0 = getCorpusVersion(root)
      await updateTableMeta(root, 't1', { description: 'updated' }, noopTier2())
      const v1 = getCorpusVersion(root)
      expect(v1).toBeGreaterThan(v0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('updateEventMeta bumps corpusVersion on success', async () => {
    const root = buildFixture()
    try {
      const v0 = getCorpusVersion(root)
      await updateEventMeta(root, 'e1', { description: 'updated event' }, noopTier2())
      const v1 = getCorpusVersion(root)
      expect(v1).toBeGreaterThan(v0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writeConceptYaml bumps corpusVersion on success', async () => {
    const root = buildFixture()
    try {
      const v0 = getCorpusVersion(root)
      await writeConceptYaml(root, 'c2', {
        name: 'c2',
        description: 'second concept',
      }, {}, noopTier2())
      const v1 = getCorpusVersion(root)
      expect(v1).toBeGreaterThan(v0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('updateConceptMeta bumps corpusVersion on success', async () => {
    const root = buildFixture()
    try {
      const v0 = getCorpusVersion(root)
      await updateConceptMeta(root, 'c1', { description: 'updated concept' }, noopTier2())
      const v1 = getCorpusVersion(root)
      expect(v1).toBeGreaterThan(v0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('invalidateCaches bumps corpusVersion (baseline assertion)', () => {
    const root = buildFixture()
    try {
      const v0 = getCorpusVersion(root)
      invalidateCaches(root)
      const v1 = getCorpusVersion(root)
      expect(v1).toBeGreaterThan(v0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('corpusVersion is independent per path (no cross-path leak)', () => {
    const rootA = buildFixture()
    const rootB = buildFixture()
    try {
      const vA0 = getCorpusVersion(rootA)
      const vB0 = getCorpusVersion(rootB)
      invalidateCaches(rootA)
      const vA1 = getCorpusVersion(rootA)
      const vB1 = getCorpusVersion(rootB)
      expect(vA1).toBeGreaterThan(vA0)
      expect(vB1).toBe(vB0) // rootB untouched
    } finally {
      rmSync(rootA, { recursive: true, force: true })
      rmSync(rootB, { recursive: true, force: true })
    }
  })
})

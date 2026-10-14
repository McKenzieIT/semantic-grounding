/**
 * Ticket 04-epoch-impl: ADR-0015's path assertions — the exact YAML-parse
 * counts of the MCP read paths once every tool call runs inside one read
 * epoch (`withReadEpoch`), measured on the k11 fixture (321 tables, 445
 * events loaded / 446 event file reads, 10 concepts) with the same test-only
 * `readYaml` counter the 01-probe landed (`_resetReadYamlCount` /
 * `_getReadYamlCount`, io-probes.ts since #123 / C8.5 — io.ts keeps only the
 * increment). Where the probe could only observe
 * (count > 0), these pin the post-epoch numbers exactly.
 *
 * Six groups per the ADR's 路径断言 (positive paths fold to 1× full corpus;
 * the negative groups pin that the memo neither leaks across epochs nor
 * survives a write), plus the R3 control (no-epoch reads return exactly what
 * epoch reads return) and the nested-epoch reuse rule.
 *
 * @module tests/read-epoch
 */
import { describe, it, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { _resetReadYamlCount, _getReadYamlCount } from '../src/io-probes.ts'
import { loadTables, loadEvents, loadTableDefinition, writeTable } from '../src/io.ts'
import { withReadEpoch } from '../src/read-epoch.ts'
import { assertKnownFilterNames } from '../src/enrichment.ts'
import { listEnrichmentWorkItems, fetchEnrichmentPrompts } from '../src/enrichment-work.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const K11 = join(HERE, './fixtures/k11')

/**
 * k11's known counts (k11-seed.spec.ts; same constants as read-count-probe):
 * 321 tables, 445 events loaded (453 files - 7 _index - 1 malformed), and
 * loadEvents performs 446 readYaml calls (453 - 7 _index; the malformed file
 * still reads). One full-corpus parse = one loadTables + one loadEvents.
 */
const K11_TABLES = 321
const K11_EVENT_READS = 446
const ONE_FULL_CORPUS = K11_TABLES + K11_EVENT_READS // 767

// Real table names from the k11 fixture (same list as the probe spec).
const KNOWN_TABLE_NAMES = [
  'dws_10000251_univ_role_act_di',
  'dws_10000251_acc_summary_df',
  'dws_10000251_acc_summary_di',
  'dws_10000251_active_code_info',
  'dws_10000251_algo_role_act_pay_df',
  'dim_10000251_auto_event_cfg_info',
  'dim_10000251_auto_pvp_rank_info',
  'dim_10000251_autobi_conf2_od',
  'dim_10000251_business_analysis_recharge',
  'dim_10000251_card_pool_info',
]

/** Reset the readYaml counter, run fn (sync), return the count it produced. */
function measure(fn: () => void): number {
  _resetReadYamlCount()
  fn()
  return _getReadYamlCount()
}

/** Async measure(): write tests go through `await writeTable` inside the epoch. */
async function measureAsync(fn: () => Promise<void>): Promise<number> {
  _resetReadYamlCount()
  await fn()
  return _getReadYamlCount()
}

/**
 * Decode a work_id's kind (`ew1.` prefix + base64url JSON `{v,k,r,t,h}` — the
 * encoding enrichment-work.ts itself uses) so the prompts group can pick a
 * batch that exercises BOTH loader families.
 */
function workIdKind(id: string): 'table' | 'event' {
  const payload = JSON.parse(Buffer.from(id.slice('ew1.'.length), 'base64url').toString('utf-8')) as { k: 'table' | 'event' }
  return payload.k
}

// ── Group 1: get_enrichment_work (full listing) ───────────────────────────

describe('ADR-0015 路径断言 1: get_enrichment_work N 项 (epoch 内)', () => {
  it('folds buildDimInventory + the table loop + the event loop into one full-corpus parse', () => {
    const count = measure(() => {
      withReadEpoch(() => {
        const listing = listEnrichmentWorkItems(K11, {})
        expect(listing.work.length).toBeGreaterThan(0)
      })
    })
    // Probe measured 1088 outside the epoch (321 + 321 + 446); inside, the
    // three loadTables share one memo slot and loadEvents scans once: 767.
    expect(count).toBe(ONE_FULL_CORPUS)
  })
})

// ── Group 2: get_enrichment_prompts (≤10 items) ───────────────────────────

describe('ADR-0015 路径断言 2: get_enrichment_prompts ≤10 项 (epoch 内)', () => {
  it('folds per-item loadTables().find() / loadEvents().find() into one full-corpus parse', () => {
    // Pick a mixed batch (probe methodology: ids from a real listing) — a
    // tables-only batch would never touch loadEvents and the 1×-full-corpus
    // assertion would be vacuous.
    const listing = listEnrichmentWorkItems(K11, {})
    const tableIds = listing.work.filter(w => workIdKind(w.work_id) === 'table').slice(0, 5).map(w => w.work_id)
    const eventIds = listing.work.filter(w => workIdKind(w.work_id) === 'event').slice(0, 5).map(w => w.work_id)
    expect(tableIds.length).toBeGreaterThan(0)
    expect(eventIds.length).toBeGreaterThan(0)
    const workIds = [...tableIds, ...eventIds]
    expect(workIds.length).toBeLessThanOrEqual(10)

    const count = measure(() => {
      withReadEpoch(() => {
        fetchEnrichmentPrompts(K11, workIds)
      })
    })
    // Probe measured 2.09× for 5 items; inside the epoch every table lookup
    // (plus the lazy buildDimInventory the relation round triggers) shares
    // the tables memo and every event lookup the events memo: 767.
    expect(count).toBe(ONE_FULL_CORPUS)
  })
})

// ── Group 3: assertKnownFilterNames (10 names) ────────────────────────────

describe('ADR-0015 路径断言 3: assertKnownFilterNames 10 名 (epoch 内)', () => {
  it('folds the N in-predicate full scans into one tables parse', () => {
    const count = measure(() => {
      withReadEpoch(() => {
        assertKnownFilterNames(K11, { tables: KNOWN_TABLE_NAMES })
      })
    })
    // The `new Set(loadTables(...))` sits INSIDE the .filter() predicate —
    // one full tables scan per name outside an epoch. Inside, the first
    // predicate pass fills the memo and the other nine hit it: 321.
    expect(count).toBe(K11_TABLES)
  })

  it('control — the same call outside any epoch still pays N full scans', () => {
    const count = measure(() => {
      assertKnownFilterNames(K11, { tables: KNOWN_TABLE_NAMES })
    })
    // 10 × 321: the pathological pre-epoch shape the probe measured (4.19×).
    expect(count).toBe(10 * K11_TABLES)
    expect(count).toBeGreaterThan(K11_TABLES)
  })
})

// ── Group 4: single definition lookup ─────────────────────────────────────

describe('ADR-0015 路径断言 4: 单条定义 lookup (loadTableDefinition, epoch 内)', () => {
  it('two lookups in one epoch share the one full-tables parse', () => {
    const count = measure(() => {
      withReadEpoch(() => {
        const a = loadTableDefinition(K11, KNOWN_TABLE_NAMES[0]!)
        const b = loadTableDefinition(K11, KNOWN_TABLE_NAMES[1]!)
        expect(a).not.toBeNull()
        expect(b).not.toBeNull()
      })
    })
    // A single lookup is already at the 1× floor (the probe's measurement);
    // the second lookup is what the epoch folds from 642 to 321.
    expect(count).toBe(K11_TABLES)
  })
})

// ── Group 5: memo must not leak across epochs ─────────────────────────────

describe('ADR-0015 路径断言 5 (反面): 跨 epoch 不泄漏', () => {
  it('two separate epochs each re-parse the full corpus', () => {
    const count = measure(() => {
      withReadEpoch(() => {
        loadTables(K11)
        loadEvents(K11)
      })
      withReadEpoch(() => {
        loadTables(K11)
        loadEvents(K11)
      })
    })
    // The epoch's identity is the store instance — each withReadEpoch call
    // opens a fresh memo, so the second epoch re-reads: 2 × 767.
    expect(count).toBe(2 * ONE_FULL_CORPUS)
  })
})

// ── Group 6: a write inside the epoch must invalidate the memo ────────────

describe('ADR-0015 路径断言 6: epoch 内 writeTable 后必须重解析', () => {
  it('bump → composite-key miss → re-parse, and the post-write read sees the new content', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sg-epoch-'))
    cpSync(K11, tmp, { recursive: true })
    try {
      // A payload guaranteed to validate: a real k11 table's raw, cloned
      // under a new name (the write must succeed or nothing bumps).
      const src = loadTables(tmp).find(t => t.table_name === KNOWN_TABLE_NAMES[0]!)
      expect(src).toBeDefined()
      const probeName = 'dws_epoch_write_probe_di'
      const payload = { ...src!.raw, table_name: probeName, description: 'epoch write-invalidation probe' }

      const count = await measureAsync(async () => {
        await withReadEpoch(async () => {
          const before = loadTables(tmp)
          expect(before.find(t => t.table_name === probeName)).toBeUndefined()

          const res = await writeTable(tmp, probeName, payload)
          expect(res.ok).toBe(true) // writeTable → invalidateCaches → bump

          // Post-write load inside the SAME epoch: the entry's stored version
          // no longer matches the live counter → miss → re-parse from disk.
          const after = loadTables(tmp)
          const hit = after.find(t => t.table_name === probeName)
          expect(hit).toBeDefined()
          expect(hit?.raw.description).toBe('epoch write-invalidation probe')

          // And the re-parsed entry itself memo-hits: a third load adds no reads.
          const after2 = loadTables(tmp)
          expect(after2.find(t => t.table_name === probeName)).toBeDefined()
        })
      })
      // Pre-write scan (321) + post-write re-parse (322 — the written file
      // itself joined the corpus); the third load = 0.
      expect(count).toBe(2 * K11_TABLES + 1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 60_000)
})

// ── R3 control: no-epoch reads and epoch reads return the same data ───────

describe('R3 对照: 无 epoch 时返回数据与 epoch 内一致', () => {
  it('loadTables/loadEvents deep-equal their epoch-memoised results', () => {
    const directTables = loadTables(K11)
    const epochTables = withReadEpoch(() => loadTables(K11))
    expect(epochTables).toEqual(directTables)
    expect(epochTables).toHaveLength(K11_TABLES)

    const directEvents = loadEvents(K11)
    const epochEvents = withReadEpoch(() => loadEvents(K11))
    expect(epochEvents).toEqual(directEvents)
  })

  it('within one epoch, repeated loads return the same memoised array instance', () => {
    // The aliasing R4/R5 signed off on: readers never mutate the loader's
    // arrays (all seven write sites spread-copy), so sharing the instance is
    // the memo working, not a hazard.
    const same = withReadEpoch(() => {
      const a = loadTables(K11)
      const b = loadTables(K11)
      return a === b
    })
    expect(same).toBe(true)
    // Outside an epoch every call scans fresh — distinct instances.
    expect(loadTables(K11)).not.toBe(loadTables(K11))
  })
})

// ── Nested epochs reuse the already-open store ────────────────────────────

describe('嵌套 withReadEpoch 复用同一 epoch', () => {
  it('a nested epoch does not fork a second memo', () => {
    const count = measure(() => {
      withReadEpoch(() => {
        loadTables(K11)
        withReadEpoch(() => {
          loadTables(K11) // would re-scan if the inner call opened its own store
        })
        loadEvents(K11)
      })
    })
    expect(count).toBe(ONE_FULL_CORPUS)
  })
})

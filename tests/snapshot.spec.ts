/**
 * W11 C1 — MVCC query snapshot tests.
 *
 * Verifies:
 *  (a) A snapshot pins definitions even after invalidateCaches is called.
 *  (b) A new snapshot acquired after invalidation sees new data.
 *  (c) withSnapshot() wrapper provides isolation during async execution.
 *  (d) Snapshot reuses cached data when version is unchanged (cheap).
 */
import { test, expect, describe, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SemanticLayerService, DefinitionSnapshot, captureSnapshot, clearSnapshotCache, getSnapshotCacheSize, SNAPSHOT_CACHE_MAX } from '../src/index.ts'
import { invalidateCaches } from '../src/io.ts'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeLayer(): string {
  const dir = mkdtempSync(join(tmpdir(), 'w11-snap-'))
  mkdirSync(join(dir, 'tables'), { recursive: true })
  mkdirSync(join(dir, 'events', 'pay'), { recursive: true })
  writeFileSync(join(dir, 'config.yaml'), yaml.dump({ project: { name: 'test', scope_id: 'test' } }))
  writeFileSync(join(dir, 'tables', 'dws_order.yaml'), yaml.dump({
    table_name: 'dws_order',
    table_comment: 'orders v1',
    description: 'Order summary v1',
    domains: ['pay'],
    granularity: 'daily',
    columns: [{ name: 'order_id', type: 'string', comment: 'ID', role: 'dimension' }],
    metrics: {},
    partitions: [{ name: 'ds', type: 'string' }],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
  }))
  writeFileSync(join(dir, 'events', 'pay', 'game.pay.yaml'), yaml.dump({
    name: 'game.pay',
    description: 'Payment event v1',
    domains: ['pay'],
    params_fields: { amount: { type: 'double', description: 'pay amount' } },
    metrics: {},
    external_refs: [],
    disambiguation: [],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    coverage: null,
  }))
  return dir
}

function makeService(root: string): SemanticLayerService {
  const ctx = new Context()
  return new SemanticLayerService(ctx, { semanticRoot: root })
}

let layerDir: string | undefined

afterEach(() => {
  clearSnapshotCache()
  if (layerDir) {
    rmSync(layerDir, { recursive: true, force: true })
    layerDir = undefined
  }
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('W11 C1 — MVCC snapshot isolation', () => {
  test('(a) snapshot pins definitions: invalidateCaches + file edit does not affect held snapshot', () => {
    layerDir = makeLayer()
    const svc = makeService(layerDir)

    // Acquire snapshot with v1 data
    const snap = svc.acquireSnapshot()
    expect(snap).toBeInstanceOf(DefinitionSnapshot)
    const table = snap.loadTableDefinition('dws_order')
    expect(table).not.toBeNull()
    expect(table!.description).toBe('Order summary v1')

    const event = snap.loadEventDefinition('game.pay')
    expect(event).not.toBeNull()
    expect(event!.description).toBe('Payment event v1')

    // Simulate a management-session write: overwrite file + invalidate caches
    writeFileSync(join(layerDir, 'tables', 'dws_order.yaml'), yaml.dump({
      table_name: 'dws_order',
      table_comment: 'orders v2',
      description: 'Order summary v2',
      domains: ['pay'],
      granularity: 'daily',
      columns: [{ name: 'order_id', type: 'string', comment: 'ID', role: 'dimension' }],
      metrics: {},
      partitions: [{ name: 'ds', type: 'string' }],
      confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    }))
    invalidateCaches(layerDir)

    // The held snapshot STILL sees v1 (MVCC isolation)
    const tableAfter = snap.loadTableDefinition('dws_order')
    expect(tableAfter).not.toBeNull()
    expect(tableAfter!.description).toBe('Order summary v1')
  })

  test('(b) new snapshot after invalidation sees updated data', () => {
    layerDir = makeLayer()
    const svc = makeService(layerDir)

    // First snapshot sees v1
    const snap1 = svc.acquireSnapshot()
    expect(snap1.loadTableDefinition('dws_order')!.description).toBe('Order summary v1')

    // Write v2 + invalidate
    writeFileSync(join(layerDir, 'tables', 'dws_order.yaml'), yaml.dump({
      table_name: 'dws_order',
      table_comment: 'orders v2',
      description: 'Order summary v2',
      domains: ['pay'],
      granularity: 'daily',
      columns: [{ name: 'order_id', type: 'string', comment: 'ID', role: 'dimension' }],
      metrics: {},
      partitions: [{ name: 'ds', type: 'string' }],
      confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    }))
    invalidateCaches(layerDir)

    // New snapshot sees v2
    const snap2 = svc.acquireSnapshot()
    expect(snap2.loadTableDefinition('dws_order')!.description).toBe('Order summary v2')
    expect(snap2.version).toBeGreaterThan(snap1.version)
  })

  test('(c) withSnapshot provides isolation during async execution', async () => {
    layerDir = makeLayer()
    const svc = makeService(layerDir)

    const result = await svc.withSnapshot(async (snap) => {
      // Read v1 inside the snapshot scope
      const t = snap.loadTableDefinition('dws_order')
      expect(t!.description).toBe('Order summary v1')

      // Simulate a concurrent write mid-execution
      writeFileSync(join(layerDir!, 'tables', 'dws_order.yaml'), yaml.dump({
        table_name: 'dws_order',
        table_comment: 'orders v3',
        description: 'Order summary v3',
        domains: ['pay'],
        granularity: 'daily',
        columns: [{ name: 'order_id', type: 'string', comment: 'ID', role: 'dimension' }],
        metrics: {},
        partitions: [{ name: 'ds', type: 'string' }],
        confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
      }))
      invalidateCaches(layerDir!)

      // Still sees v1 inside the snapshot
      const t2 = snap.loadTableDefinition('dws_order')
      expect(t2!.description).toBe('Order summary v1')

      return 'query-complete'
    })

    expect(result).toBe('query-complete')

    // After withSnapshot, a new snapshot sees v3
    const snap = svc.acquireSnapshot()
    expect(snap.loadTableDefinition('dws_order')!.description).toBe('Order summary v3')
  })

  test('(d) snapshot reuses cached arrays when version is unchanged (cheap)', () => {
    layerDir = makeLayer()
    const svc = makeService(layerDir)

    const snap1 = svc.acquireSnapshot()
    const snap2 = svc.acquireSnapshot()

    // Same version => same underlying data arrays (reused from cache)
    expect(snap1.version).toBe(snap2.version)
    expect(snap1.tables).toBe(snap2.tables)
    expect(snap1.events).toBe(snap2.events)
  })

  test('snapshot.loadEventDefinition returns null for unknown event', () => {
    layerDir = makeLayer()
    const svc = makeService(layerDir)
    const snap = svc.acquireSnapshot()
    expect(snap.loadEventDefinition('nonexistent')).toBeNull()
  })

  test('snapshot.loadTableDefinition returns null for unknown table', () => {
    layerDir = makeLayer()
    const svc = makeService(layerDir)
    const snap = svc.acquireSnapshot()
    expect(snap.loadTableDefinition('nonexistent')).toBeNull()
  })

  test('snapshot.loadMetricDefinition works for inline metrics', () => {
    layerDir = makeLayer()
    // Write a table with a metric
    writeFileSync(join(layerDir, 'tables', 'dws_order.yaml'), yaml.dump({
      table_name: 'dws_order',
      table_comment: 'orders',
      description: 'Order summary',
      domains: ['pay'],
      granularity: 'daily',
      columns: [
        { name: 'order_id', type: 'string', comment: 'ID', role: 'dimension' },
        { name: 'amount', type: 'double', comment: 'Amount', role: 'measure' },
      ],
      metrics: {
        total_amount: { expression: 'SUM(amount)', description: 'Total order amount' },
      },
      partitions: [{ name: 'ds', type: 'string' }],
      confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    }))
    invalidateCaches(layerDir)

    const svc = makeService(layerDir)
    const snap = svc.acquireSnapshot()
    const m = snap.loadMetricDefinition('dws_order__total_amount')
    expect(m).not.toBeNull()
    expect(m!.computation.sql).toContain('SUM(amount)')
  })

  test('snapshot.loadRetrievalCorpus returns pinned corpus', () => {
    layerDir = makeLayer()
    const svc = makeService(layerDir)
    const snap = svc.acquireSnapshot()
    const corpus = snap.loadRetrievalCorpus()
    expect(Array.isArray(corpus)).toBe(true)
    // The fixture has one event (game.pay)
    expect(corpus.length).toBe(1)
    expect(corpus[0]!.id).toBe('game.pay')
  })

  test('withSnapshot propagates exceptions from fn', async () => {
    const svcLocal = makeService(layerDir!)
    await expect(
      svcLocal.withSnapshot(async () => { throw new Error('boom') }),
    ).rejects.toThrow('boom')
  })

  test('CL14 — cache bounded: caps size at SNAPSHOT_CACHE_MAX and re-scans evicted roots', () => {
    clearSnapshotCache()
    // Capture root0 first; save its tables-array reference (the cached version).
    const root0 = makeLayer()
    const snap0a = captureSnapshot(root0, 0, 'params+term')
    const tables0a = snap0a.tables
    // Capture MAX more distinct roots — evicts root0 (the oldest) once over cap.
    const roots = [root0]
    for (let i = 0; i < SNAPSHOT_CACHE_MAX; i++) {
      const root = makeLayer()
      roots.push(root)
      captureSnapshot(root, 0, 'params+term')
    }
    // Cache never exceeds the cap.
    expect(getSnapshotCacheSize()).toBe(SNAPSHOT_CACHE_MAX)
    // root0 was evicted — re-capturing re-scans from disk (fresh arrays, not
    // the cached reference). Contrast test (d): a hit reuses the same array.
    const snap0b = captureSnapshot(root0, 0, 'params+term')
    expect(snap0b.tables).not.toBe(tables0a)
    // The re-scanned data is still correct.
    expect(snap0b.loadTableDefinition('dws_order')!.description).toBe('Order summary v1')
    // A still-cached root (the last captured) reuses its arrays (cache hit).
    const last = roots[roots.length - 1]!
    const snapLast1 = captureSnapshot(last, 0, 'params+term')
    const snapLast2 = captureSnapshot(last, 0, 'params+term')
    expect(snapLast1.tables).toBe(snapLast2.tables)
    // cleanup
    clearSnapshotCache()
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })
})

/**
 * Corpus enrichment — the pure projection from semantic-layer events (with
 * alt_labels) to a retrieval corpus. Packs `params_fields` (field name + field
 * description) + `alt_labels` (SKOS aliases) into the indexed `description`;
 * does NOT index `domain` (probe refuted it).
 *
 * Run: `pnpm vitest run packages/data/semantic-layer`
 */
import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import {
  buildRetrievalCorpus,
  type EventCorpusInput,
} from '../src/corpus.ts'
import { loadRetrievalCorpus, invalidateCaches, getCorpusVersion } from '../src/io.ts'
import { SemanticLayerService } from '../src/index.ts'
import { Context } from '@deepseek-ai/cordis'



// ── buildRetrievalCorpus: pack description + params_fields + alt_labels ──────

test('buildRetrievalCorpus packs event desc + params_fields(name+desc) + alt_labels; exact composition + payload carries original', () => {
  const events: EventCorpusInput[] = [{
    name: 'recharge',
    description: '充值',
    params_fields: {
      roleId: { description: '角色id' },
      money: { description: '充值金额' },
    },
    alt_labels: ['氪金', '充值', '付费'],
    metrics: { recharge_cnt: {} },
  }]
  const corpus = buildRetrievalCorpus(events)
  expect(corpus).toHaveLength(1)
  const item = corpus[0]!
  expect(item.id).toBe('recharge')
  expect(item.description).toBe('充值 roleId 角色id money 充值金额 氪金 充值 付费')
  expect(item.metrics).toEqual({ recharge_cnt: {} })
  expect(item.payload).toBe(events[0])
})

test('buildRetrievalCorpus does NOT index domain — domain never enters the corpus text', () => {
  const events: EventCorpusInput[] = [{ name: 'item.add', description: '道具产出' }]
  const item = buildRetrievalCorpus(events)[0]!
  expect(item.description).toBe('道具产出')
  expect(item.description).not.toContain('付费经济')
})

test('buildRetrievalCorpus omits empty param descriptions (field name only) and missing alt_labels', () => {
  const events: EventCorpusInput[] = [{
    name: 'shop.buy',
    description: '商城购买',
    params_fields: { count: { description: '' }, gold: {} },
  }]
  const item = buildRetrievalCorpus(events)[0]!
  expect(item.description).toBe('商城购买 count gold')
})

test('buildRetrievalCorpus handles events with no description/params/alt_labels (empty description, not undefined)', () => {
  const events: EventCorpusInput[] = [{ name: 'bare.event' }]
  const item = buildRetrievalCorpus(events)[0]!
  expect(item.id).toBe('bare.event')
  expect(item.description).toBe('')
  expect(item.metrics).toBeUndefined()
})

test('buildRetrievalCorpus projects multiple events preserving order', () => {
  const events: EventCorpusInput[] = [
    { name: 'role.online', description: '玩家上线', params_fields: { roleId: { description: '角色id' } }, alt_labels: ['日活'] },
    { name: 'recharge', description: '充值' },
  ]
  const corpus = buildRetrievalCorpus(events)
  expect(corpus.map(c => c.id)).toEqual(['role.online', 'recharge'])
  expect(corpus[0]!.description).toBe('玩家上线 roleId 角色id 日活')
  expect(corpus[1]!.description).toBe('充值')
})

// ── loadRetrievalCorpus: io wiring (events with alt_labels -> enriched corpus) ─

test('loadRetrievalCorpus(semanticLayer) reads events with alt_labels and enriches', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'd2e-io-'))
  const layer = join(scratch, '10000demo')
  mkdirSync(join(layer, 'events', 'role_public'), { recursive: true })
  // Write event with alt_labels
  const eventYaml = yaml.dump({
    name: 'role.online',
    event_filter: "event = 'role.online'",
    description: '玩家上线',
    domains: ['用户生命周期'],
    alt_labels: ['日活', 'DAU'],
    params_fields: {
      role_id: { type: 'bigint', description: '角色id' },
      amount: { type: 'double', description: '充值金额' },
    },
    metrics: {},
    disambiguation: [],
    external_refs: [],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    coverage: null,
  })
  writeFileSync(join(layer, 'events', 'role_public', 'role.online.yaml'), eventYaml)
  writeFileSync(join(layer, 'config.yaml'), 'project:\n  name: demo\n  scope_id: 10000demo\n')
  try {
    const corpus = loadRetrievalCorpus(layer)
    expect(corpus).toHaveLength(1)
    const item = corpus[0]!
    expect(item.id).toBe('role.online')
    expect(item.description).toContain('玩家上线')
    expect(item.description).toContain('role_id')
    expect(item.description).toContain('角色id')
    expect(item.description).toContain('amount')
    expect(item.description).toContain('充值金额')
    expect(item.description).toContain('日活')
    expect(item.description).toContain('DAU')
    expect(item.description).not.toContain('用户生命周期')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('loadRetrievalCorpus returns [] when semanticLayer has no events (no throw)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'd2e-empty-'))
  const layer = join(scratch, '10000demo')
  mkdirSync(layer, { recursive: true })
  writeFileSync(join(layer, 'config.yaml'), 'project:\n  name: demo\n')
  try {
    expect(loadRetrievalCorpus(layer)).toEqual([])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('buildRetrievalCorpus skips params_fields whose value is not a plain object (mirrors probe; no stray field-name token)', () => {
  const events = [{
    name: 'e',
    params_fields: { good: { description: 'x' }, bad: 'not-an-object', arr: [1, 2] },
  } as unknown as EventCorpusInput]
  const item = buildRetrievalCorpus(events)[0]!
  expect(item.description).toBe('good x')
})

// ── D2f corpus-version counter (cache-invalidation signal) ─────────────────
test('getCorpusVersion bumps after invalidateCaches(semanticLayer); independent per path', () => {
  const pa = '/d2f-counter-test-A'
  const pb = '/d2f-counter-test-B'
  const a0 = getCorpusVersion(pa)
  const b0 = getCorpusVersion(pb)
  invalidateCaches(pa)
  expect(getCorpusVersion(pa)).toBe(a0 + 1)
  expect(getCorpusVersion(pb)).toBe(b0)
  invalidateCaches(pa)
  invalidateCaches(pb)
  expect(getCorpusVersion(pa)).toBe(a0 + 2)
  expect(getCorpusVersion(pb)).toBe(b0 + 1)
})

// ── D2f Service corpusVersion() ──
test('SemanticLayerService.corpusVersion() reflects invalidateCaches(semanticRoot)', () => {
  const layer = '/d2f-svc-version-test'
  const svc = new SemanticLayerService(new Context(), { semanticRoot: layer, scopeId: '' })
  const before = svc.corpusVersion()
  invalidateCaches(layer)
  expect(svc.corpusVersion()).toBe(before + 1)
})

// ── D2h corpus variant (term-only vs params+term) ──────────────────────────
test('buildRetrievalCorpus variant="term-only" packs desc + alt_labels but NOT params_fields', () => {
  const events: EventCorpusInput[] = [{
    name: 'item.add',
    description: '添加道具',
    params_fields: { itemId: { description: '道具id' }, count: { description: '数量' } },
    alt_labels: ['道具产出', '道具增加'],
  }]
  const item = buildRetrievalCorpus(events, 'term-only')[0]!
  expect(item.description).toBe('添加道具 道具产出 道具增加')
  expect(item.description).not.toContain('道具id')
  expect(item.description).not.toContain('数量')
  expect(item.description).not.toContain('itemId')
  expect(item.description).not.toContain('count')
})

test('buildRetrievalCorpus variant="params+term" (default) packs desc + params_fields + alt_labels', () => {
  const events: EventCorpusInput[] = [{
    name: 'item.add',
    description: '添加道具',
    params_fields: { itemId: { description: '道具id' } },
    alt_labels: ['道具产出'],
  }]
  const def = buildRetrievalCorpus(events)
  expect(def[0]!.description).toBe('添加道具 itemId 道具id 道具产出')
  const explicit = buildRetrievalCorpus(events, 'params+term')
  expect(explicit[0]!.description).toBe(def[0]!.description)
})

test('loadRetrievalCorpus(layer, "term-only") packs alt_labels but NOT params_fields', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'd2h-io-term-'))
  const layer = join(scratch, '10000demo')
  mkdirSync(join(layer, 'events', 'role_public'), { recursive: true })
  const eventYaml = yaml.dump({
    name: 'role.online',
    event_filter: "event = 'role.online'",
    description: '玩家上线',
    alt_labels: ['日活', 'DAU'],
    params_fields: {
      role_id: { type: 'bigint', description: '角色id' },
      amount: { type: 'double', description: '充值金额' },
    },
    metrics: {},
  })
  writeFileSync(join(layer, 'events', 'role_public', 'role.online.yaml'), eventYaml)
  writeFileSync(join(layer, 'config.yaml'), 'project:\n  name: demo\n  scope_id: 10000demo\n')
  try {
    const termOnly = loadRetrievalCorpus(layer, 'term-only')
    expect(termOnly).toHaveLength(1)
    expect(termOnly[0]!.description).toContain('日活')
    expect(termOnly[0]!.description).toContain('DAU')
    expect(termOnly[0]!.description).not.toContain('角色id')
    expect(termOnly[0]!.description).not.toContain('充值金额')
    expect(termOnly[0]!.description).not.toContain('role_id')
    expect(termOnly[0]!.description).not.toContain('amount')
    const def = loadRetrievalCorpus(layer)
    expect(def[0]!.description).toContain('角色id')
    expect(def[0]!.description).toContain('充值金额')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('SemanticLayerService.loadRetrievalCorpus() honors corpusVariant config', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'd2h-svc-variant-'))
  const layer = join(scratch, '10000demo')
  mkdirSync(join(layer, 'events', 'role_public'), { recursive: true })
  const eventYaml = yaml.dump({
    name: 'role.online',
    event_filter: "event = 'role.online'",
    description: '玩家上线',
    alt_labels: ['日活', 'DAU'],
    params_fields: {
      role_id: { type: 'bigint', description: '角色id' },
      amount: { type: 'double', description: '充值金额' },
    },
    metrics: {},
  })
  writeFileSync(join(layer, 'events', 'role_public', 'role.online.yaml'), eventYaml)
  writeFileSync(join(layer, 'config.yaml'), 'project:\n  name: demo\n  scope_id: 10000demo\n')
  try {
    // Separate contexts: each service registers itself as `schema`.
    const termSvc = new SemanticLayerService(new Context(), { semanticRoot: layer, scopeId: '', corpusVariant: 'term-only' })
    const termCorpus = termSvc.loadRetrievalCorpus()
    expect(termCorpus[0]!.description).toContain('日活')
    expect(termCorpus[0]!.description).not.toContain('角色id')
    expect(termSvc.corpusVariant).toBe('term-only')
    const defSvc = new SemanticLayerService(new Context(), { semanticRoot: layer, scopeId: '' })
    const defCorpus = defSvc.loadRetrievalCorpus()
    expect(defCorpus[0]!.description).toContain('角色id')
    expect(defSvc.corpusVariant).toBe('params+term')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

/**
 * CL-1 Phase 3 — alt_labels enrichment tests: discoverAltLabelsDeterministic,
 * buildAltLabelsPrompt, parseAltLabelsResponse, mergeAltLabels,
 * discoverAltLabelsFor, enrichAllTablesAltLabels, enrichAllEventsAltLabels.
 */
import { test, expect, describe, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import {
  discoverAltLabelsDeterministic,
  buildAltLabelsPrompt,
  parseAltLabelsResponse,
  mergeAltLabels,
  discoverAltLabelsFor,
  enrichAllTablesAltLabels,
  enrichAllEventsAltLabels,
  discoverAltLabels,
  type AltLabelsTarget,
} from '../src/enrichment.ts'
import { dumpYaml } from '../src/io.ts'

// ── Deterministic round ──────────────────────────────────────────────────

describe('discoverAltLabelsDeterministic', () => {
  test('extracts parenthesized terms from description', () => {
    const target: AltLabelsTarget = {
      id: 'dws_active_user_di',
      kind: 'table',
      description: '日活跃用户宽表（DAU），记录每日活跃状态',
      domains: [],
      columns: [],
      existingAltLabels: [],
      existingPrefLabel: undefined,
    }
    const labels = discoverAltLabelsDeterministic(target)
    expect(labels).toContain('DAU')
  })

  test('extracts Chinese parenthesized terms', () => {
    const target: AltLabelsTarget = {
      id: 'dws_pay_order_di',
      kind: 'table',
      description: '付费订单明细表（付费流水）',
      domains: [],
      columns: [],
      existingAltLabels: [],
      existingPrefLabel: undefined,
    }
    const labels = discoverAltLabelsDeterministic(target)
    expect(labels).toContain('付费流水')
  })

  test('extracts quoted terms', () => {
    const target: AltLabelsTarget = {
      id: 'event_login',
      kind: 'event',
      description: '用户登录事件，也称为"签到"行为',
      domains: [],
      columns: [],
      existingAltLabels: [],
      existingPrefLabel: undefined,
    }
    const labels = discoverAltLabelsDeterministic(target)
    expect(labels).toContain('签到')
  })

  test('includes domains as labels', () => {
    const target: AltLabelsTarget = {
      id: 'dws_social_interaction_di',
      kind: 'table',
      description: '社交互动宽表',
      domains: ['社交', '互动'],
      columns: [],
      existingAltLabels: [],
      existingPrefLabel: undefined,
    }
    const labels = discoverAltLabelsDeterministic(target)
    expect(labels).toContain('社交')
    expect(labels).toContain('互动')
  })

  test('dedupes against existing alt_labels', () => {
    const target: AltLabelsTarget = {
      id: 'dws_active_user_di',
      kind: 'table',
      description: '日活跃用户宽表（DAU）',
      domains: ['活跃'],
      columns: [],
      existingAltLabels: ['DAU', '活跃'],
      existingPrefLabel: undefined,
    }
    const labels = discoverAltLabelsDeterministic(target)
    expect(labels).not.toContain('DAU')
    expect(labels).not.toContain('活跃')
  })

  test('dedupes against existingPrefLabel', () => {
    const target: AltLabelsTarget = {
      id: 'dws_active_user_di',
      kind: 'table',
      description: '日活跃用户宽表（日活）',
      domains: [],
      columns: [],
      existingAltLabels: [],
      existingPrefLabel: '日活',
    }
    const labels = discoverAltLabelsDeterministic(target)
    expect(labels).not.toContain('日活')
  })

  test('dedupes against the id itself', () => {
    const target: AltLabelsTarget = {
      id: 'DAU',
      kind: 'table',
      description: '指标（DAU）',
      domains: [],
      columns: [],
      existingAltLabels: [],
      existingPrefLabel: undefined,
    }
    const labels = discoverAltLabelsDeterministic(target)
    expect(labels).not.toContain('DAU')
    expect(labels).not.toContain('dau')
  })

  test('skips too-short and too-long terms', () => {
    const target: AltLabelsTarget = {
      id: 'test',
      kind: 'table',
      description: '概览（X）和详情（' + 'A'.repeat(60) + '）',
      domains: [],
      columns: [],
      existingAltLabels: [],
      existingPrefLabel: undefined,
    }
    const labels = discoverAltLabelsDeterministic(target)
    expect(labels).not.toContain('X')
    expect(labels.every(l => l.length <= 50)).toBe(true)
  })

  test('returns empty when no extractable content', () => {
    const target: AltLabelsTarget = {
      id: 'dws_foo',
      kind: 'table',
      description: 'A simple table',
      domains: [],
      columns: [],
      existingAltLabels: [],
      existingPrefLabel: undefined,
    }
    const labels = discoverAltLabelsDeterministic(target)
    expect(labels).toEqual([])
  })
})

// ── buildAltLabelsPrompt ─────────────────────────────────────────────────

describe('buildAltLabelsPrompt', () => {
  test('includes asset id, kind, description', () => {
    const target: AltLabelsTarget = {
      id: 'dws_pay_order_di',
      kind: 'table',
      description: '付费订单明细',
      domains: ['付费经济'],
      columns: [{ name: 'order_id', comment: '订单号' }],
      existingAltLabels: ['付费流水'],
      existingPrefLabel: undefined,
    }
    const prompt = buildAltLabelsPrompt(target)
    expect(prompt).toContain('dws_pay_order_di')
    expect(prompt).toContain('table')
    expect(prompt).toContain('付费订单明细')
    expect(prompt).toContain('付费经济')
    expect(prompt).toContain('order_id')
    expect(prompt).toContain('订单号')
    expect(prompt).toContain('付费流水')
    expect(prompt).toContain('JSON array')
  })
})

// ── parseAltLabelsResponse ───────────────────────────────────────────────

describe('parseAltLabelsResponse', () => {
  test('parses a clean JSON array of strings', () => {
    const labels = parseAltLabelsResponse('["DAU", "日活", "活跃用户"]')
    expect(labels).toEqual(['DAU', '日活', '活跃用户'])
  })

  test('handles fenced JSON', () => {
    const labels = parseAltLabelsResponse('```json\n["付费流水", "充值"]\n```')
    expect(labels).toEqual(['付费流水', '充值'])
  })

  test('drops non-string items', () => {
    const labels = parseAltLabelsResponse('[123, "valid", null, "also valid"]')
    expect(labels).toEqual(['valid', 'also valid'])
  })

  test('drops too-short strings', () => {
    const labels = parseAltLabelsResponse('["A", "OK", "valid term"]')
    expect(labels).toEqual(['OK', 'valid term'])
  })

  test('returns empty on invalid JSON', () => {
    expect(parseAltLabelsResponse('not json at all')).toEqual([])
  })

  test('returns empty on empty array', () => {
    expect(parseAltLabelsResponse('[]')).toEqual([])
  })
})

// ── mergeAltLabels ───────────────────────────────────────────────────────

describe('mergeAltLabels', () => {
  test('appends new labels preserving existing order', () => {
    const merged = mergeAltLabels(['DAU', '日活'], ['活跃', '月活'])
    expect(merged).toEqual(['DAU', '日活', '活跃', '月活'])
  })

  test('dedupes case-insensitively', () => {
    const merged = mergeAltLabels(['dau', 'DAU'], ['Dau', '月活'])
    expect(merged).toEqual(['dau', 'DAU', '月活'])
  })

  test('preserves existing even if duplicated in added', () => {
    const merged = mergeAltLabels(['日活'], ['日活', '月活'])
    expect(merged).toEqual(['日活', '月活'])
  })
})

// ── discoverAltLabelsFor (two-round) ─────────────────────────────────────

describe('discoverAltLabelsFor', () => {
  const target: AltLabelsTarget = {
    id: 'dws_active_user_di',
    kind: 'table',
    description: '日活跃用户宽表（DAU）',
    domains: ['活跃'],
    columns: [],
    existingAltLabels: [],
    existingPrefLabel: undefined,
  }

  test('deterministic only when no llmCall', async () => {
    const labels = await discoverAltLabelsFor(target)
    expect(labels).toContain('DAU')
    expect(labels).toContain('活跃')
  })

  test('LLM round supplements deterministic', async () => {
    const llmCall = async () => '["月活用户", "MAU"]'
    const labels = await discoverAltLabelsFor(target, llmCall)
    expect(labels).toContain('DAU')
    expect(labels).toContain('活跃')
    expect(labels).toContain('月活用户')
    expect(labels).toContain('MAU')
  })

  test('LLM failure degrades gracefully to deterministic', async () => {
    const llmCall = async () => { throw new Error('LLM unavailable') }
    const labels = await discoverAltLabelsFor(target, llmCall)
    expect(labels).toContain('DAU')
    expect(labels).toContain('活跃')
  })

  test('dedupes LLM results against existing + deterministic', async () => {
    const targetWithExisting: AltLabelsTarget = {
      ...target,
      existingAltLabels: ['MAU'],
    }
    const llmCall = async () => '["MAU", "新标签"]'
    const labels = await discoverAltLabelsFor(targetWithExisting, llmCall)
    expect(labels).not.toContain('MAU')
    expect(labels).toContain('新标签')
  })
})

// ── enrichAllTablesAltLabels (filesystem integration) ────────────────────

describe('enrichAllTablesAltLabels', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'alt-labels-'))
    mkdirSync(join(root, 'tables'), { recursive: true })
  })
  afterEach(() =>{  rmSync(root, { recursive: true, force: true }) })

  function writeTableYaml(name: string, extra: Record<string, unknown> = {}) {
    const def = {
      table_name: name,
      table_comment: '',
      description: '日活跃用户宽表（DAU）',
      domains: ['活跃'],
      columns: [{ name: 'user_id', type: 'string', comment: '用户ID' }],
      kind: 'dws',
      primary_key: [],
      label_columns: [],
      alt_labels: [],
      ...extra,
    }
    writeFileSync(join(root, 'tables', `${name}.yaml`), dumpYaml(def))
  }

  test('enriches a table with deterministic labels', async () => {
    writeTableYaml('dws_active_user_di')
    const res = await enrichAllTablesAltLabels(root)
    expect(res.enriched).toBe(1)
    expect(res.written).toBe(1)
    expect(res.errors).toEqual([])
    const raw = yaml.load(readFileSync(join(root, 'tables', 'dws_active_user_di.yaml'), 'utf8')) as Record<string, unknown>
    const labels = raw.alt_labels as string[]
    expect(labels).toContain('DAU')
    expect(labels).toContain('活跃')
  })

  test('preserves existing alt_labels and appends new', async () => {
    writeTableYaml('dws_active_user_di', { alt_labels: ['existing'] })
    const res = await enrichAllTablesAltLabels(root)
    expect(res.enriched).toBe(1)
    const raw = yaml.load(readFileSync(join(root, 'tables', 'dws_active_user_di.yaml'), 'utf8')) as Record<string, unknown>
    const labels = raw.alt_labels as string[]
    expect(labels[0]).toBe('existing')
    expect(labels).toContain('DAU')
  })

  test('skips tables with no discoverable labels', async () => {
    writeTableYaml('dws_boring', { description: 'plain table', domains: [] })
    const res = await enrichAllTablesAltLabels(root)
    expect(res.enriched).toBe(0)
    expect(res.written).toBe(0)
  })

  test('filters by table name', async () => {
    writeTableYaml('dws_active_user_di')
    writeTableYaml('dws_pay_order_di', { description: '付费订单（充值）' })
    const res = await enrichAllTablesAltLabels(root, undefined, ['dws_pay_order_di'])
    expect(res.enriched).toBe(1)
    expect(res.written).toBe(1)
    // dws_active_user_di should be untouched
    const raw = yaml.load(readFileSync(join(root, 'tables', 'dws_active_user_di.yaml'), 'utf8')) as Record<string, unknown>
    expect((raw.alt_labels as string[]).length).toBe(0)
  })

  test('LLM round supplements when provided', async () => {
    writeTableYaml('dws_active_user_di')
    const llmCall = async () => '["日活数据", "每日活跃"]'
    const res = await enrichAllTablesAltLabels(root, llmCall)
    expect(res.enriched).toBe(1)
    const raw = yaml.load(readFileSync(join(root, 'tables', 'dws_active_user_di.yaml'), 'utf8')) as Record<string, unknown>
    const labels = raw.alt_labels as string[]
    expect(labels).toContain('日活数据')
    expect(labels).toContain('每日活跃')
  })
})

// ── enrichAllEventsAltLabels ─────────────────────────────────────────────

describe('enrichAllEventsAltLabels', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'alt-labels-evt-'))
    mkdirSync(join(root, 'events', 'social'), { recursive: true })
  })
  afterEach(() =>{  rmSync(root, { recursive: true, force: true }) })

  function writeEventYaml(name: string, extra: Record<string, unknown> = {}) {
    const def = {
      name,
      description: '好友互动事件（聊天）',
      domains: ['社交'],
      params_fields: { friend_id: { type: 'string', description: '好友ID' } },
      alt_labels: [],
      ...extra,
    }
    writeFileSync(join(root, 'events', 'social', `${name}.yaml`), dumpYaml(def))
  }

  test('enriches an event with deterministic labels', async () => {
    writeEventYaml('social.friend_chat')
    const res = await enrichAllEventsAltLabels(root)
    expect(res.enriched).toBe(1)
    expect(res.written).toBe(1)
    const raw = yaml.load(readFileSync(join(root, 'events', 'social', 'social.friend_chat.yaml'), 'utf8')) as Record<string, unknown>
    const labels = raw.alt_labels as string[]
    expect(labels).toContain('聊天')
    expect(labels).toContain('社交')
  })

  test('filters by event name', async () => {
    writeEventYaml('social.friend_chat')
    writeEventYaml('social.gift_send', { description: '赠送礼物（送礼）', domains: ['经济'] })
    const res = await enrichAllEventsAltLabels(root, undefined, ['social.gift_send'])
    expect(res.enriched).toBe(1)
    // friend_chat untouched
    const raw = yaml.load(readFileSync(join(root, 'events', 'social', 'social.friend_chat.yaml'), 'utf8')) as Record<string, unknown>
    expect((raw.alt_labels as string[]).length).toBe(0)
  })
})

// ── discoverAltLabels (combined) ─────────────────────────────────────────

describe('discoverAltLabels', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'alt-labels-all-'))
    mkdirSync(join(root, 'tables'), { recursive: true })
    mkdirSync(join(root, 'events', 'social'), { recursive: true })
  })
  afterEach(() =>{  rmSync(root, { recursive: true, force: true }) })

  test('enriches both tables and events', async () => {
    writeFileSync(join(root, 'tables', 'dws_active.yaml'), dumpYaml({
      table_name: 'dws_active',
      description: '日活（DAU）',
      domains: [],
      columns: [],
      kind: 'dws',
      primary_key: [],
      label_columns: [],
      alt_labels: [],
    }))
    writeFileSync(join(root, 'events', 'social', 'social.chat.yaml'), dumpYaml({
      name: 'social.chat',
      description: '聊天事件（即时通讯）',
      domains: ['社交'],
      params_fields: {},
      alt_labels: [],
    }))
    const res = await discoverAltLabels(root)
    expect(res.enriched).toBe(2)
    expect(res.written).toBe(2)
    expect(res.errors).toEqual([])
  })
})

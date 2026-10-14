/**
 * CL-1 Phase 3 — alt_labels pure-machinery tests: discoverAltLabelsDeterministic,
 * buildAltLabelsPrompt, parseAltLabelsResponse, mergeAltLabels,
 * discoverAltLabelsFor. The sweep orchestration (enrichAllTablesAltLabels /
 * enrichAllEventsAltLabels on the sweep engine) lives in sweep.spec.ts,
 * parameterized per kind (map #64 / #67); the combined discoverAltLabels
 * wrapper is retired (#160 — the Core method assembles the per-leg calls
 * itself, ADR-0007).
 */
import { test, expect, describe } from 'vitest'
import {
  discoverAltLabelsDeterministic,
  buildAltLabelsPrompt,
  parseAltLabelsResponse,
  mergeAltLabels,
  discoverAltLabelsFor,
  type AltLabelsTarget,
} from '../src/enrichment.ts'

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

// ── discoverAltLabelsFor (deterministic round) ───────────────────────────

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

  test('deterministic round (the LLM half lives in the ask-answer pair)', async () => {
    const labels = await discoverAltLabelsFor(target)
    expect(labels).toContain('DAU')
    expect(labels).toContain('活跃')
  })
})

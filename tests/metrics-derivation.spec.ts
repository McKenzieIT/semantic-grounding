import { describe, it, expect } from 'vitest'
import { toMetricDefinition, projectMetricCorpusItem, deriveMetricRelations } from '../src/metrics.ts'

describe('metric derivation (M1 virtual projection)', () => {
  const mdef = { expression: 'COUNT(DISTINCT account_id)', description: 'DAU', alt_labels: [], caliber_variants: [] }
  const md = toMetricDefinition('dws_acc_di', 'dau', mdef, ['用户生命周期'])

  it('carries caliber_variants from host block (M1c: restores Type B signal)', () => {
    const withCaliber = { expression: 'SUM(x)', description: 'r', alt_labels: [], caliber_variants: [{ id: 'by_total', description: 'total', default: true }] }
    const r = toMetricDefinition('t', 'win_rate', withCaliber, [])
    expect(r.caliber_variants).toHaveLength(1)
    expect(r.caliber_variants[0]!.id).toBe('by_total')
  })

  it('projectMetricCorpusItem produces a kind:metric CorpusItem with description', () => {
    const item = projectMetricCorpusItem(md)
    expect(item).not.toBeNull()
    expect(item.id).toBe('dws_acc_di__dau')
    expect(item.description).toContain('DAU')
    expect((item.payload as { kind: string }).kind).toBe('metric')
  })

  it('deriveMetricRelations returns derived_from edge to source', () => {
    const rels = deriveMetricRelations(md)
    expect(rels).toHaveLength(1)
    expect(rels[0]!.type).toBe('derived_from')
    expect(rels[0]!.target).toBe('dws_acc_di')
  })
})

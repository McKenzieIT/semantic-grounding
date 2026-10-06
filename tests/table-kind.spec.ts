/**
 * tableKindPlugin.relations() — dimension_ref → RelationDef edge building.
 * sl-5: when a dimension_ref has 2+ alternative dim_columns (each with
 * multiple dws_column mappings), the emitted join edges must be the cartesian
 * product (one alternative from EVERY group, combined with composite keys) —
 * not per-group single-key edges that omit the other alternative dim_column.
 *
 * Regression guards: the single-alternative-group case (one alt dim_column)
 * and the composite-key + one-group case must stay unchanged.
 */
import { test, expect, describe } from 'vitest'
import { tableKindPlugin } from '../src/kinds/table-kind.ts'
import type { TableDefinition } from '../src/types.ts'

function mkTable(dimension_refs: TableDefinition['dimension_refs']): TableDefinition {
  return {
    table_name: 'dws_x', table_comment: '', description: '', alt_labels: [], domains: [],
    granularity: '', engine: 'maxcompute',
    columns: [{ name: 'a', type: 'string', comment: '', role: 'dimension' }],
    metrics: {}, partitions: [],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    coverage: null, supersedes: [], disambiguation: null, kind: 'dws', primary_key: [],
    primary_key_unique: null, duplicate_sample: [], label_columns: [], freshness: '',
    dimension_refs,
  }
}

describe('tableKindPlugin.relations — alternative FKs (sl-5)', () => {
  test('2 alternative dim_columns emit cross-product join edges', () => {
    const refs = [{
      dim_table: 'dim_xz',
      derivation: '',
      join_keys: [
        { dws_column: 'a', dim_column: 'x' },
        { dws_column: 'b', dim_column: 'x' },
        { dws_column: 'c', dim_column: 'z' },
        { dws_column: 'd', dim_column: 'z' },
      ],
    }]
    const rels = tableKindPlugin.relations(mkTable(refs))
    const ons = rels.map(r => r.on ?? '').sort()
    expect(ons).toEqual([
      'a = x AND c = z',
      'a = x AND d = z',
      'b = x AND c = z',
      'b = x AND d = z',
    ])
  })

  test('3 alternative dim_columns emit 2x2x2 cross-product (each edge has all 3 keys)', () => {
    const refs = [{
      dim_table: 'dim_xzw',
      derivation: '',
      join_keys: [
        { dws_column: 'a', dim_column: 'x' },
        { dws_column: 'b', dim_column: 'x' },
        { dws_column: 'c', dim_column: 'z' },
        { dws_column: 'd', dim_column: 'z' },
        { dws_column: 'e', dim_column: 'w' },
        { dws_column: 'f', dim_column: 'w' },
      ],
    }]
    const rels = tableKindPlugin.relations(mkTable(refs))
    expect(rels).toHaveLength(8)
    for (const r of rels) {
      expect((r.on ?? '').split(' AND ')).toHaveLength(3)
    }
    expect(rels.map(r => r.on).sort()).toContain('a = x AND c = z AND e = w')
  })

  test('single alternative group — one edge per alt (unchanged, regression guard)', () => {
    const refs = [{
      dim_table: 'dim_x',
      derivation: '',
      join_keys: [
        { dws_column: 'a', dim_column: 'x' },
        { dws_column: 'b', dim_column: 'x' },
      ],
    }]
    const rels = tableKindPlugin.relations(mkTable(refs))
    expect(rels.map(r => r.on ?? '').sort()).toEqual(['a = x', 'b = x'])
  })

  test('composite key + one alternative group — composite key on every edge (regression guard)', () => {
    const refs = [{
      dim_table: 'dim_xy',
      derivation: '',
      join_keys: [
        { dws_column: 'k', dim_column: 'y' },
        { dws_column: 'a', dim_column: 'x' },
        { dws_column: 'b', dim_column: 'x' },
      ],
    }]
    const rels = tableKindPlugin.relations(mkTable(refs))
    expect(rels.map(r => r.on ?? '').sort()).toEqual(['k = y AND a = x', 'k = y AND b = x'])
  })
})

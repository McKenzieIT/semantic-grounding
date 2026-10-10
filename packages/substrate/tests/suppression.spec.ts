/**
 * 持久否决（suppression，#36/#37 裁决）的 substrate 契约：
 *
 * - 过滤点在 merge 前（#36 输入 2）：别名轮 = discoverAltLabelsFor 之后、mergeAltLabels
 *   之前；关系轮 = discovered 出口。零候选 → 零写入零 commit（天然不产 churn）。
 * - corpus 级词表 `suppressions.yaml`（#37 §4）：lenient 读照 domains.yaml，过滤器
 *   并集（per-asset ∪ corpus），键 = normalizeLabel 词形。
 * - apply 家族（applyOneEnrichmentResult）同过否决集——suppression 约束的是
 *   「enrichment 轮，deterministic or LLM alike」（GLOSSARY suppression 词条）。
 * - `suppressed_*` 构造上不进 BM25 投影（#36 输入 5，防回归钉）。
 *
 * @see docs/adr/0010-suppression.md（本票落盘）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import {
  enrichAllTablesAltLabels,
  enrichAllEventsAltLabels,
  enrichAllDwsTables,
  enrichAllEvents,
} from '../src/enrichment.ts'
import { dumpYaml, loadSuppressions, loadRetrievalCorpus } from '../src/io.ts'
import { EventDefinitionSchema, TableDefinitionSchema } from '../src/types.ts'
import { applyOneEnrichmentResult, listEnrichmentWorkItems } from '../src/enrichment-work.ts'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'suppression-'))
  mkdirSync(join(root, 'tables'), { recursive: true })
  mkdirSync(join(root, 'events', 'biz'), { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeTableYaml(name: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(root, 'tables', `${name}.yaml`), dumpYaml({
    table_name: name,
    description: '',
    domains: [],
    columns: [],
    kind: 'dws',
    primary_key: [],
    label_columns: [],
    alt_labels: [],
    ...extra,
  }))
}

function writeDimYaml(name: string, pk: string): void {
  writeFileSync(join(root, 'tables', `${name}.yaml`), dumpYaml({
    table_name: name,
    description: '',
    domains: [],
    kind: 'dim',
    primary_key: [pk],
    label_columns: [`${pk}_name`],
    columns: [{ name: pk, type: 'string', comment: '' }, { name: `${pk}_name`, type: 'string', comment: '' }],
  }))
}

function writeEventYaml(name: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(root, 'events', 'biz', `${name}.yaml`), dumpYaml({
    name,
    description: '',
    domains: [],
    params_fields: {},
    alt_labels: [],
    ...extra,
  }))
}

function readTable(name: string): Record<string, unknown> {
  return yaml.load(readFileSync(join(root, 'tables', `${name}.yaml`), 'utf8')) as Record<string, unknown>
}

function readEvent(name: string): Record<string, unknown> {
  return yaml.load(readFileSync(join(root, 'events', 'biz', `${name}.yaml`), 'utf8')) as Record<string, unknown>
}

// ── schema（#36 §1：可选数组字段，key-only） ─────────────────────────────

describe('suppressed_* schema 字段', () => {
  it('表/事件各自解析三个否决字段，缺省为空数组', () => {
    const t = TableDefinitionSchema.parse({ table_name: 'x' })
    expect(t.suppressed_alt_labels).toEqual([])
    expect(t.suppressed_dimension_refs).toEqual([])
    const e = EventDefinitionSchema.parse({ name: 'evt' })
    expect(e.suppressed_alt_labels).toEqual([])
    expect(e.suppressed_external_refs).toEqual([])
    const t2 = TableDefinitionSchema.parse({ table_name: 'x', suppressed_alt_labels: ['付费'], suppressed_dimension_refs: ['dim_user'] })
    expect(t2.suppressed_alt_labels).toEqual(['付费'])
    expect(t2.suppressed_dimension_refs).toEqual(['dim_user'])
  })
})

// ── corpus 级词表（#37 §4） ─────────────────────────────────────────────

describe('loadSuppressions（lenient 读照 domains.yaml）', () => {
  it('缺失/畸形退空集', () => {
    expect(loadSuppressions(root).size).toBe(0)
    writeFileSync(join(root, 'suppressions.yaml'), dumpYaml({ alt_labels: 'not-a-list' }))
    expect(loadSuppressions(root).size).toBe(0)
    writeFileSync(join(root, 'suppressions.yaml'), dumpYaml(['a', 'b']))
    expect(loadSuppressions(root).size).toBe(0)
    writeFileSync(join(root, 'suppressions.yaml'), 'alt_labels: [unclosed')
    expect(loadSuppressions(root).size).toBe(0)
  })

  it('合法词表按 normalizeLabel 归一，非字符串项丢弃', () => {
    writeFileSync(join(root, 'suppressions.yaml'), dumpYaml({ alt_labels: ['DAU', '自定义', 42, null, '现金券'] }))
    const set = loadSuppressions(root)
    expect([...set].sort()).toEqual(['dau', '现金券', '自定义'])
  })
})

// ── 别名轮过滤（表 + 事件） ─────────────────────────────────────────────

describe('别名轮 merge 前过否决集', () => {
  it('表：per-asset 键滤掉被否决候选，未否决候选照常落地，否决键原样保留', async () => {
    writeTableYaml('dws_pay', { description: '付费订单（充值）（现金券）', suppressed_alt_labels: ['充值'] })
    const res = await enrichAllTablesAltLabels(root)
    expect(res.enriched).toBe(1)
    const labels = readTable('dws_pay').alt_labels as string[]
    expect(labels).toContain('现金券')
    expect(labels).not.toContain('充值')
    expect(readTable('dws_pay').suppressed_alt_labels).toEqual(['充值'])
  })

  it('表：corpus 词表与 per-asset 并集；全部候选被否决 ⇒ 零写入（written 0）', async () => {
    writeTableYaml('dws_pay', { description: '付费订单（充值）（现金券）', suppressed_alt_labels: ['充值'] })
    writeFileSync(join(root, 'suppressions.yaml'), dumpYaml({ alt_labels: ['现金券'] }))
    const res = await enrichAllTablesAltLabels(root)
    expect(res.enriched).toBe(0)
    expect(res.written).toBe(0)
    expect(readTable('dws_pay').alt_labels).toEqual([])
  })

  it('表：corpus 词表单独生效（domain 词不动代码的唯一全库杀闸的读侧）', async () => {
    // 唯一候选是 domain 词（描述无可抽内容）——词表单独就能把整个定义拉回零写入。
    writeTableYaml('dws_pay', { description: '付费订单宽表', domains: ['自定义'] })
    writeFileSync(join(root, 'suppressions.yaml'), dumpYaml({ alt_labels: ['自定义'] }))
    const res = await enrichAllTablesAltLabels(root)
    expect(res.enriched).toBe(0)
    expect(res.written).toBe(0)
    expect(readTable('dws_pay').alt_labels).toEqual([])
  })

  it('事件：镜像过滤（445/446 污染面在 events——day one 盖住）', async () => {
    writeEventYaml('biz.pay', { description: '支付事件（付款）（红包）', suppressed_alt_labels: ['付款'] })
    const res = await enrichAllEventsAltLabels(root)
    expect(res.enriched).toBe(1)
    const labels = readEvent('biz.pay').alt_labels as string[]
    expect(labels).toContain('红包')
    expect(labels).not.toContain('付款')
  })
})

// ── 关系轮过滤（表 + 事件） ─────────────────────────────────────────────

describe('关系轮 discovered 出口过否决集', () => {
  it('表：被否决的 dim_table 不回灌，未否决的照常推导；复跑字节稳定（零 churn）', async () => {
    writeDimYaml('dim_user', 'user_id')
    writeDimYaml('dim_role', 'role_id')
    writeTableYaml('dws_pay', {
      columns: [
        { name: 'user_id', type: 'string', comment: '' },
        { name: 'role_id', type: 'string', comment: '' },
      ],
      suppressed_dimension_refs: ['dim_user'],
    })
    await enrichAllDwsTables(root)
    const refs = readTable('dws_pay').dimension_refs as Array<{ dim_table: string }>
    expect(refs.map(r => r.dim_table)).toEqual(['dim_role'])
    const bytes = readFileSync(join(root, 'tables', 'dws_pay.yaml'), 'utf8')
    await enrichAllDwsTables(root)
    expect(readFileSync(join(root, 'tables', 'dws_pay.yaml'), 'utf8')).toBe(bytes)
  })

  it('事件：suppressed_external_refs 镜像过滤', async () => {
    writeDimYaml('dim_user', 'user_id')
    writeDimYaml('dim_role', 'role_id')
    writeEventYaml('biz.pay', {
      params_fields: {
        user_id: { type: 'string', description: '' },
        role_id: { type: 'string', description: '' },
      },
      suppressed_external_refs: ['dim_user'],
    })
    await enrichAllEvents(root)
    const refs = readEvent('biz.pay').external_refs as Array<{ dim_table: string }>
    expect(refs.map(r => r.dim_table)).toEqual(['dim_role'])
  })
})

// ── apply 家族（LLM 轮 alike） ──────────────────────────────────────────

describe('apply_enrichment 的答案同过否决集', () => {
  it('别名：被否决词不落地（idempotent），混合答案只落未否决词', async () => {
    writeTableYaml('dws_apply', { description: '付费订单（充值）', suppressed_alt_labels: ['充值'] })
    const idx = listEnrichmentWorkItems(root, { tables: ['dws_apply'] })
    const item = idx.work.find(w => w.target === 'dws_apply' && w.gap.startsWith('alt_labels'))
    expect(item).toBeDefined()
    const rejected = await applyOneEnrichmentResult(root, item!.work_id, '["充值"]')
    expect(rejected.verdict).toBe('idempotent')
    expect(readTable('dws_apply').alt_labels ?? []).toEqual([])
    // 重新拿 fresh work_id（答案没落地，gap 仍在，但 baseline 没变 ⇒ 同 id 可复用）
    const mixed = await applyOneEnrichmentResult(root, item!.work_id, '["充值","付费流水"]')
    expect(mixed.verdict).toBe('applied')
    expect(readTable('dws_apply').alt_labels).toEqual(['付费流水'])
  })

  it('关系：被否决的 dim_table 答案不落地', async () => {
    writeDimYaml('dim_user', 'user_id')
    writeTableYaml('dws_rel', {
      columns: [{ name: 'user_id', type: 'string', comment: '' }],
      dimension_refs: [],
      suppressed_dimension_refs: ['dim_user'],
    })
    const idx = listEnrichmentWorkItems(root, { tables: ['dws_rel'] })
    const item = idx.work.find(w => w.target === 'dws_rel' && w.gap.startsWith('dimension_refs'))
    expect(item).toBeDefined()
    const outcome = await applyOneEnrichmentResult(
      root,
      item!.work_id,
      '[{"dim_table":"dim_user","join_keys":[{"dws_column":"user_id","dim_column":"user_id"}]}]',
    )
    expect(outcome.verdict).toBe('idempotent')
    expect(readTable('dws_rel').dimension_refs ?? []).toEqual([])
  })
})

// ── 检索投影（#36 输入 5：构造上不进 BM25 折叠） ────────────────────────

describe('被否决的词检索不到（投影防回归钉）', () => {
  it('suppressed_* 不进 loadRetrievalCorpus 的任何一层（description 与 payload）', () => {
    writeEventYaml('biz.pay', { description: '支付事件', alt_labels: ['活词'], suppressed_alt_labels: ['死词'] })
    const items = loadRetrievalCorpus(root)
    const item = items.find(i => i.id === 'biz.pay')
    expect(item).toBeDefined()
    expect(item!.description).toContain('活词')
    expect(JSON.stringify(item)).not.toContain('死词')
  })
})

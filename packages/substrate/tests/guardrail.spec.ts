/**
 * #35 裁决的抽取器护栏契约：12 条谓词 + cap24，只作用 paren/quote 正文分支；
 * `domains` 分支显式旁路（#35 裁决 4，两条独立代码路径）；引号正则配对修正
 * （#33 输入 4）；`substring-of-own-id`（规则 F）实测否决——由 F 类词钉住。
 *
 * 全常量、零配置面（#35 裁决 3，照 ADR-0008 裁决 4 同一逻辑）：任何阈值或
 * 谓词的调整走 ADR 修订，不走环境旋钮。
 *
 * @see docs/adr/0009-extractor-guardrail.md（本票落盘）
 * @see #33 实测：766 定义 → 4296 候选，规则集杀 2193（51.0%），误杀实测 0
 */
import { describe, expect, it } from 'vitest'
import { discoverAltLabelsDeterministic, type AltLabelsTarget } from '../src/enrichment.ts'

const target = (over: Partial<AltLabelsTarget> = {}): AltLabelsTarget => ({
  id: 'dws_probe_di',
  kind: 'table',
  description: '',
  domains: [],
  columns: [],
  existingAltLabels: [],
  existingPrefLabel: undefined,
  ...over,
})

/** Run one description through the deterministic round, text branch only (no domains). */
const fromDesc = (description: string, over: Partial<AltLabelsTarget> = {}): readonly string[] =>
  discoverAltLabelsDeterministic(target({ description, ...over }))

describe('guardrail kill set（12 谓词 + cap24，paren/quote 分支）', () => {
  it('pure-digits：纯数字候选（含全角）被杀', () => {
    expect(fromDesc('批量拉取表（１２３）与明细表（123）')).toEqual([])
  })

  it('digit-run：含 ≥4 位连续数字的候选被杀', () => {
    expect(fromDesc('跑批记录（批次20260720号）')).toEqual([])
  })

  it('operator-chars：含运算/集合符号的候选被杀', () => {
    expect(fromDesc('过滤条件（a≠b）')).toEqual([])
  })

  it('separator-chars：含逗号/顿号/分号的候选被杀', () => {
    expect(fromDesc('等级枚举（vip，svip）')).toEqual([])
  })

  it('sentence-punct：含句读的候选被杀', () => {
    expect(fromDesc('说明片段（这是半句话。）')).toEqual([])
  })

  it('unbalanced-quote：内部残留引号的候选被杀', () => {
    expect(fromDesc('描述（残留“引号）后续')).toEqual([])
  })

  it('inner-space-phrase：含空格且长 >8 的候选被杀', () => {
    expect(fromDesc('粒度说明（每个账号 user_id 每天一行）')).toEqual([])
  })

  it('slash-separator：斜杠枚举串被杀（#26 存活侧最大垃圾类）', () => {
    expect(fromDesc('等级分层（等级/vip/战力/经验）')).toEqual([])
  })

  it('layer-suffix：分层/存储后缀被杀', () => {
    expect(fromDesc('存储分层（_df）与汇总层（dws）')).toEqual([])
  })

  it('column-name-canon：列名 snake/camel 归一后命中被杀（取代 own-column-name，非并存）', () => {
    // 描述写 role_id，列名是 roleId —— 归一版是严格超集（#33：859 ⊇ 793）
    const cols = [{ name: 'roleId', comment: '' }]
    expect(fromDesc('角色标识（role_id）', { columns: cols })).toEqual([])
    expect(fromDesc('角色标识（roleId）', { columns: cols })).toEqual([])
  })

  it('plus-operator：复合主键记法被杀', () => {
    expect(fromDesc('复合键（role_id+battle_id）')).toEqual([])
  })

  it('arrow-tilde：箭头/波浪号记法被杀', () => {
    expect(fromDesc('等级迁移（oldLevel→newLevel）')).toEqual([])
  })

  it('cap24：长度 >24 的正文候选被杀，=24 存活（阈值实测不敏感：12→50 仅 0.8pp）', () => {
    expect(fromDesc(`超长碎片（${'长'.repeat(25)}）`)).toEqual([])
    expect(fromDesc(`业务全称（${'好'.repeat(24)}）`)).toEqual([`${'好'.repeat(24)}`])
  })
})

describe('guardrail 假阴性守卫（#35 裁决 2：词表三钉，故意小）', () => {
  // 词表纪律（#33 输入 1 + #35 裁决 2）：必须用**真实候选词**。
  // `GMV` / `T+1` 全库 0 次候选（描述里是白文，不在括号/引号/domains 内）——
  // 拿它们写守卫断言是永真空断言：护栏无论怎么改都不会让断言变红，还会让人
  // 误以为覆盖了。别把它们加回来。
  it('DAU（英文缩写）：真实候选 3 次全存活的形状，必须仍被抽到', () => {
    expect(fromDesc('日活跃用户宽表（DAU），按日聚合')).toContain('DAU')
  })

  it('现金券（中文业务词）：真实候选存活的形状，必须仍被抽到', () => {
    expect(fromDesc('营销活动（现金券）发放记录')).toContain('现金券')
  })

  it('tactic（F 类词，自身 id 子串）：substring-of-own-id 已实测否决，谁加回 F 守卫立刻红', () => {
    // #33/#35：F 规则独杀 92 条全是 tactic/charm/toy/rank 类英文系统名——定义 id
    // 本身就由它们拼成，恰是最有价值的别名类。本断言就是那条否决的可执行形态。
    expect(fromDesc('战斗 tactic 策略（tactic）', { id: 'dim_tactic_rank' })).toContain('tactic')
  })
})

describe('domains 分支显式旁路（#35 裁决 4：受控词表，护栏零触碰）', () => {
  it('会被正文护栏杀掉的 domain 词照常入库（含长度上限与全部谓词）', () => {
    const labels = discoverAltLabelsDeterministic(target({
      description: '宽表',
      domains: ['T+1', 'dws', 'x'.repeat(30)],
    }))
    expect(labels).toContain('T+1') // plus-operator 在正文分支会杀它
    expect(labels).toContain('dws') // layer-suffix 同
    expect(labels).toContain('x'.repeat(30)) // cap24 同 —— 无长度上限是有意的
  })

  it('domains 仍保留历史上的 >=2 门槛', () => {
    const labels = discoverAltLabelsDeterministic(target({ description: '', domains: ['A', 'AB'] }))
    expect(labels).toEqual(['AB'])
  })
})

describe('引号正则配对修正（#33 输入 4：开合字符类不再跨配对）', () => {
  it('跨配对区间不再产出候选：" 开、」闭', () => {
    expect(fromDesc('他说"你好」就走了')).toEqual([])
  })

  it('正确配对的四种引号照常抽取', () => {
    expect(fromDesc('关卡「汉家军阵」与称号『无』')).toContain('汉家军阵')
    expect(fromDesc('所谓"付费经济"口径')).toContain('付费经济')
    expect(fromDesc("俗称'砍单'")).toContain('砍单')
    expect(fromDesc('出自《充值宝典》')).toContain('充值宝典')
  })
})

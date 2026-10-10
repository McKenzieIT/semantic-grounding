/**
 * PROTOTYPE — throwaway. Candidate rejection rules for #33 / #35.
 *
 * Each rule is an independent predicate: `reject(candidate, ctx) => boolean`.
 * `tier` records where the rule came from and what the measurement said about it:
 *   'orig'      — listed in #26
 *   'proposed'  — exposed by the survivor tail in this probe, measured safe
 *   'rejected'  — measured and REJECTED: it kills real business aliases
 * Nothing here is production code; the point is to see the kill set, not to ship it.
 */

export interface RuleCtx {
  readonly defId: string
  readonly kind: 'table' | 'event'
  /** column / params_fields names of THIS definition, lowercased verbatim */
  readonly columnNames: ReadonlySet<string>
  /** same, with snake/camel/dot punctuation stripped — for the canon variant */
  readonly columnNamesCanon: ReadonlySet<string>
  readonly source: 'paren' | 'quote' | 'domain'
}

export interface Rule {
  readonly id: string
  readonly label: string
  readonly why: string
  readonly tier: 'orig' | 'proposed' | 'rejected'
  /** on by default in the viewer */
  readonly on: boolean
  readonly reject: (c: string, ctx: RuleCtx) => boolean
}

const OPERATOR_CHARS = /[=≠≥≤⊇⊆⊃⊂∈∉∩∪<>{}[\]|&]/
const SEPARATOR_CHARS = /[,，、;；]/
const SENTENCE_PUNCT = /[。！？…：:]/
const QUOTE_CHARS = /["'「」《》“”‘’]/
const LAYER_SUFFIX = /^_?(df|di|mi|od|arch|dim|dws|dwd|ads|ods|cbt\d?|test)$/i

export const canon = (s: string) => s.toLowerCase().replace(/[_\-.\s]/g, '')

export const RULES: readonly Rule[] = [
  // ── 原 #26 列的候选规则 ──────────────────────────────────────────────
  {
    id: 'pure-digits',
    label: '纯数字',
    why: '候选全是数字 —— 实测仅 6 条命中、独杀 1 条，近乎空转',
    tier: 'orig',
    on: true,
    reject: c => /^[\d０-９.\s]+$/.test(c),
  },
  {
    id: 'partition-kv',
    label: '分区/赋值式',
    why: 'ds=20260720 这类 key=value —— 实测 127 条全被 operator-chars / digit-run 覆盖，独杀 0，完全冗余',
    tier: 'orig',
    on: true,
    reject: c => /^[A-Za-z_][\w.]*\s*=\s*\S+$/.test(c),
  },
  {
    id: 'digit-run',
    label: '长数字串(≥4)',
    why: '含连续 4 位以上数字 —— 日期、ID、实测计数',
    tier: 'orig',
    on: true,
    reject: c => /\d{4,}/.test(c),
  },
  {
    id: 'operator-chars',
    label: '含运算符',
    why: '含 = ≠ ⊇ ∈ { } < > 等运算/集合符号 ⇒ 是断言不是名词',
    tier: 'orig',
    on: true,
    reject: c => OPERATOR_CHARS.test(c),
  },
  {
    id: 'separator-chars',
    label: '含分隔符(，、;)',
    why: '含逗号/顿号/分号 ⇒ 列举或整句',
    tier: 'orig',
    on: true,
    reject: c => SEPARATOR_CHARS.test(c),
  },
  {
    id: 'sentence-punct',
    label: '含句读',
    why: '含句号/问号/冒号/省略号 ⇒ 整句被撕进来',
    tier: 'orig',
    on: true,
    reject: c => SENTENCE_PUNCT.test(c),
  },
  {
    id: 'unbalanced-quote',
    label: '引号不配对',
    why: '候选内部残留引号 ⇒ 抽取正则跨引号误配（开闭字符类不对称）',
    tier: 'orig',
    on: true,
    reject: c => QUOTE_CHARS.test(c),
  },
  {
    id: 'inner-space-phrase',
    label: '含空格且长>8',
    why: '含空白且偏长 ⇒ 短语/断句而非术语',
    tier: 'orig',
    on: true,
    reject: c => /\s/.test(c) && c.length > 8,
  },
  {
    id: 'own-column-name',
    label: '是本定义的列名',
    why: '候选等于本表/本事件自己的列名 —— dogfood 里 agent 以此理由删过 pay_type / recharge_id。独杀 793，全规则里最大的一条',
    tier: 'orig',
    on: true,
    reject: (c, ctx) => ctx.columnNames.has(c.toLowerCase().trim()),
  },

  // ── 实测暴露、量过安全的补充规则 ─────────────────────────────────────
  {
    id: 'slash-separator',
    label: 'A `/` 也算分隔符',
    why: '斜杠连写的字段枚举（等级/vip/战力/经验）是现存护栏漏掉的最大一类垃圾 —— 补 241 杀，纯中文业务词风险 0',
    tier: 'proposed',
    on: true,
    reject: c => c.includes('/'),
  },
  {
    id: 'layer-suffix',
    label: 'B 分层/存储后缀',
    why: '_df / _di / _mi / _arch / dim / dws 这类分层标记被当成别名 —— 补 169 杀（仅 7 个不同词），风险 0',
    tier: 'proposed',
    on: true,
    reject: c => LAYER_SUFFIX.test(c.trim()),
  },
  {
    id: 'column-name-canon',
    label: 'C 列名 snake/camel 归一',
    why: '正文写 role_id、params_fields 是 roleId，现状漏杀 —— 归一后补 66 杀，风险 0',
    tier: 'proposed',
    on: true,
    reject: (c, ctx) => ctx.columnNamesCanon.has(canon(c)),
  },
  {
    id: 'plus-operator',
    label: 'D `+` 复合键记法',
    why: 'role_id+battle_id、设备ID+区服+日期 等复合主键记法 —— 补 13 杀。代价：理论上会误杀 T+1，但全库实测 T+1 出现 0 次',
    tier: 'proposed',
    on: true,
    reject: c => c.includes('+'),
  },
  {
    id: 'arrow-tilde',
    label: 'E 箭头/波浪号',
    why: 'oldLevel→newLevel、成功率~93.4%、1~5星战斗技id —— 补 4 杀，风险 0',
    tier: 'proposed',
    on: true,
    reject: c => /[→←⇒~～]/.test(c),
  },

  // ── 实测否决的规则 ─────────────────────────────────────────────────
  {
    id: 'substring-of-own-id',
    label: 'F 是自身 id 的子串【实测否决】',
    why: '✗ 否决：听起来有道理（别把自己的名字当别名），实测却杀掉 tactic / charm / toy / rank / conquest / homeland —— 这些正是英文系统名这一最有价值的别名类，因为定义 id 本身就是由它们拼出来的',
    tier: 'rejected',
    on: false,
    reject: (c, ctx) => {
      const id = canon(ctx.defId)
      const t = canon(c)
      return t.length >= 6 && id.includes(t)
    },
  },
]

export function tooLong(c: string, cap: number): boolean {
  return c.length > cap
}

// ── suspected-false-negative heuristics ──────────────────────────────────

const BUSINESS_MORPHEME =
  /(券|卡|档|率|额|值|比|量|金|费|价|数|池|服|区|档位|用户|玩家|角色|账号|订单|充值|付费|留存|活跃|流失|转化|客单|日活|月活|周活|新增|回流|礼包|道具|装备|关卡|副本|战力|等级)/
const LATIN_TOKEN = /^[A-Za-z][A-Za-z0-9+\-_.]{0,11}$/

export const MUST_SURVIVE = ['DAU', 'GMV', 'T+1', '现金券']

export function looksLikeBusinessTerm(c: string): string[] {
  const flags: string[] = []
  const t = c.trim()
  if (MUST_SURVIVE.some(m => m.toLowerCase() === t.toLowerCase())) flags.push('#33 点名必须存活')
  if (LATIN_TOKEN.test(t)) flags.push('英文/拉丁缩写形状')
  if (BUSINESS_MORPHEME.test(t) && t.length <= 12) flags.push('含业务词素且短')
  if (/^[一-龥]{2,6}$/.test(t)) flags.push('纯中文 2-6 字')
  return flags
}

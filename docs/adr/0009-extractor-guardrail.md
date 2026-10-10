# ADR-0009: 抽取器护栏 —— 12 条常量谓词 + cap24，domains 显式旁路

- **Status**: accepted
- **Date**: 2026-10-10
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0006（本票收紧的 `discoverAltLabelsDeterministic` 由 0006 新增）、
  ADR-0008 裁决 4（全常量不开配置面的同一先例逻辑）、
  [map #32](https://github.com/McKenzieIT/semantic-grounding/issues/32)、
  实测票 [#33](https://github.com/McKenzieIT/semantic-grounding/issues/33)、
  裁决票 [#35](https://github.com/McKenzieIT/semantic-grounding/issues/35)、
  执行票 [#38](https://github.com/McKenzieIT/semantic-grounding/issues/38)

## Context

`discoverAltLabelsDeterministic` 的 paren/quote 正文分支把描述里括号、引号夹注当候选别名抽出——
这是 #26 的失败面：一条长描述能被撕成一堆句子残渣、枚举串、字段同名回声，当「别名」写回
`alt_labels`，污染检索与展示。#26 已经加了 9 条拒收规则，但调校从未经全库验证——哪条规则在
真正干活、哪条是死代码、cap 阈值选 12 是不是拍脑袋，都是悬而未决的操作性前提。

[map #32](https://github.com/McKenzieIT/semantic-grounding/issues/32) 把「护栏够不够」列为待实测
的核事实——护栏杀伤的尺寸直接决定 #36/#37 的持久否决权要扛多大的剩余量（见
[ADR-0010](./0010-persistent-suppression.md)）。[#33](https://github.com/McKenzieIT/semantic-grounding/issues/33)
在全库 766 个定义（321 表 + 445 事件）上重算基线，用两道独立硬校验锚定数据可信度（分支归因复刻
766/766 全等；线上真实污染写入 `3cef160` 回放 445/445 全等）：4296 条候选（paren 3315 / quote 59 /
domain 922），逐规则独杀归因 + 一份需人眼过目的疑似假阴性全表 + 一次长度上限扫描，产物是一张可拨
开关的差集表（探针分支 `prototype/33-guardrail-rule-probe` @ `f648e42`/`bce87c4`，只读语料、
`packages/` 下零改动）。

实测关键事实：原始 9 条规则只杀 1700/4296（39.6%）；其中 `partition-kv` 独杀 0（被已有规则全
覆盖，纯死代码）；105 个需人眼过目的疑似假阴性词逐条读完**无一真业务别名**（`DAU`/`现金券`全部
存活）；长度上限从 12 调到 50，总杀伤只移动 0.8 个百分点（最像需要调的参数反而最不敏感）；
`domains` 分支全库仅 10 个词但**永远被重抽**（受控词表,不是描述正文撕出来的垃圾，不该套文本护栏）；
一条「别名是不是自身 id 的子串」的候选规则独杀 92 条看起来很有产出，但杀的是 `tactic`/`charm`/
`toy` 这类最有价值的英文系统名别名（它们本就是 id 由它们拼出来的，子串关系是因果颠倒）。
[#35](https://github.com/McKenzieIT/semantic-grounding/issues/35) 在这份实测数据上五轮裁决。

## Decision

| # | 维度 | 裁决 | 关闭的取舍 |
|---|---|---|---|
| 1 | 规则集 | **12 条常量谓词 + cap24**，杀 2193/4296（51.0%），误杀实测 0。保留 #26 原有 7 条（pure-digits / digit-run / operator-chars / separator-chars / sentence-punct / unbalanced-quote / inner-space-phrase）；新增 5 条（slash-separator / layer-suffix / column-name-canon / plus-operator / arrow-tilde）；砍 `partition-kv`（独杀 0）；`column-name-canon` **取代**（非并存）原 `own-column-name`——归一化版本是严格超集（859 ⊇ 793），并存会留一条永不独立生效的死分支。 | 不扩规则集（放弃把 39.6% 提到 51.0% 的空间）；采纳「自身 id 子串」规则（会损失 tactic / mission 一类系统名别名） |
| 2 | 假阴性容忍线 | **偏杀**，不建不对称权衡机制。守卫 fixture 词表**三钉且故意小**：`DAU`（英文缩写，真实候选，3 处出现全存活）+ `现金券`（中文业务词，真实候选存活）+ 一个被否的 F 类词 `tactic`（钉死「不要重新加回自身 id 子串规则」）。 | 本票曾设想的误杀/漏杀不对称定价机制——前提不成立：候选文本本就在 `description` 里被 BM25 索引，杀候选对召回零损失，别名的职能收窄到展示/对照，没有代价要权衡 |
| 3 | 配置面 | **全常量**，不在任何层级开配置面；调整走 ADR 修订，不是运行期旋钮。三条独立依据同时成立：规则漂移是新的审计盲区（commit 记了「改了什么」却不记「当时哪套规则在裁」）；最像需要配置的参数（cap）实测最不敏感（12→50 仅移动 0.8pp）；12 条规则误杀实测 0，没有受益方要为可配置性买单。 | YAML/env 可配置规则集或 cap 阈值 |
| 4 | domains 分支 | **显式旁路**：护栏（含长度上限）只作用于 paren/quote 正文分支；`domains` 分支不受任何规则触碰，维持历史 `>= 2` 长度门槛；两条独立代码路径，不是同一条流水线里加一个 if。全库 10 个 domain 词永远被重新发现，是否回灌正式交给持久否决权回答（见 [ADR-0010](./0010-persistent-suppression.md)）。 | 对 domains 施加同一套文本护栏（domains 是受控词表不是撕出来的垃圾，施加「斜杠枚举」「操作符字符」一类规则无的放矢，且会误杀操作员刻意保留的受控词） |
| 5 | LLM 轮范围 | **维持现状**：确定性轮只吃 `description`（或 `table_comment` 回退）+ `domains`；列注释唯一入口是 LLM 轮的 prompt，不受护栏约束。过程中纠正了一条曾经写错的票面前提（曾误记「确定性轮也吃列注释」，模块 docstring 也曾这样写，一并修复）。 | 砍列注释输入（会造成召回回归——列注释是语料里最富的人写术语源）；给 LLM 轮也套同一套护栏（类目错配，护栏是为筛"描述正文撕出来的候选"设计的，不是为筛受控词表或 LLM 产物设计的） |

**被否掉的路**（记录免重探）：

- **不对称误杀/漏杀权衡机制**（裁决 2 原计划）——前提不成立：杀候选对 BM25 召回零损失，别名的
  职能是展示/对照不是检索通路；105 词人眼表零误杀，没有代价可权衡，机制无的放矢。
- **规则集 / cap 可配置化**（裁决 3）——会把"规则漂移"变成新的审计盲区，而且最像需要配置的
  参数实测最不敏感。
- **"别名是自身 id 子串"规则**——独杀数字（92）看起来诱人，实测杀的是 `tactic` / `charm` /
  `toy` / `rank` / `mission` 一类英文系统名，恰恰是最有价值的别名类；子串关系是因果颠倒（id 是
  由它们拼出来的，不是它们碰巧是 id 的碎片）。
- **对 `domains` 分支施加护栏**（裁决 4）——受控词表没有护栏要防的失败面（没有句子残渣、没有
  枚举撕裂）；domains 词的去留是持久否决权的职责，不是护栏的。
- **把列注释并入确定性轮的输入**——会制造召回回归，且与 LLM 轮重复覆盖同一来源。

## Consequences

- `discoverAltLabelsDeterministic` 的 paren/quote 分支杀伤率从 39.6% 提升到 51.0%
  （4296 条候选杀 2193），误杀实测维持 0；存活的 2103 条（去重后 711 个词）是
  [ADR-0010](./0010-persistent-suppression.md) 持久否决权要扛的实测规模，不是未知上限。
- `domains` 分支的 10 个词（922 次出现）永远被重新发现——护栏不解决、也不打算解决这个问题；
  它们回灌与否现在由持久否决权回答。
- 三处顺带发现在本票一并修复，不改变上面五条裁决的任何结论：引号正则改严格配对
  （`"…"` / `'…'` / `「…」` / `《…》`，不再跨配对撑出假候选）；`own-column-name` 被
  `column-name-canon` 取代而非并存；模块 docstring 的「确定性轮读列注释」错误记述一并纠正。
- 一个顺带发现未在本票解决，记录在案：括号夹注内部若嵌着一个该独立抽出的干净别名（例如
  `关卡名，如"汉家军阵"`里的"汉家军阵"），抽取器目前不会把它单独抽出——这是抽取器的召回缺陷，
  护栏不制造也不解决。
- 长度上限只作用于 paren/quote 两支；`domains` 分支从来没有长度上限（裁决 4 的旁路使这个不
  对称是有意的，不是遗漏）。
- dsh 不受影响：护栏是 substrate 内部的纯函数谓词链，不改变 `discoverAltLabelsDeterministic`
  的签名或调用约定。

## Verification

- 单测（`packages/substrate/tests/guardrail.spec.ts`）：
  - `guardrail kill set（12 谓词 + cap24，paren/quote 分支）`——12 条规则逐条杀伤钉死，含
    `column-name-canon` 取代 `own-column-name` 而非并存的断言，以及 cap24 边界（=24 存活，
    >24 被杀）。
  - `guardrail 假阴性守卫（#35 裁决 2：词表三钉，故意小）`——`DAU` / `现金券` / `tactic` 三词
    固定存活。
  - `domains 分支显式旁路（#35 裁决 4：受控词表，护栏零触碰）`——会被正文护栏杀掉的 domain 词
    照常入库，含长度上限与全部谓词均不触碰该分支。
  - `引号正则配对修正（#33 输入 4：开合字符类不再跨配对）`——跨配对区间不再产出假候选，四种
    引号各自正确配对照常抽取。
- 回归依据：#33 探针分支（`prototype/33-guardrail-rule-probe` @ `f648e42`/`bce87c4`）的
  766/766 分支归因复刻 + 445/445 线上污染写入回放，是本票数字的可审计出处（探针只读语料，
  `packages/` 下零改动，已核 `git diff` 为空）。

## References

- 实测票全记录：[#33](https://github.com/McKenzieIT/semantic-grounding/issues/33)（探针分支
  `prototype/33-guardrail-rule-probe`：逐规则归因表、105 词假阴性全表、可拨开关的差集报告、
  445/445 线上回放证明）
- 裁决票全记录：[#35](https://github.com/McKenzieIT/semantic-grounding/issues/35)
- 落地执行票：[#38](https://github.com/McKenzieIT/semantic-grounding/issues/38)
- 行为依据：`packages/substrate/src/enrichment.ts:751`（guardrail 区块起点注释）、`:774`
  （`GUARDRAIL_CAP`）、`:810`（`guardrailRejection`，12 条谓词判定）、`:830`（`QUOTE_PAIRS`，
  严格配对正则）、`:866`（`discoverAltLabelsDeterministic`，两条独立路径：正文分支过护栏，
  domains 分支旁路）
- GLOSSARY：无新词条——护栏是既有 `discoverAltLabelsDeterministic` 契约内部的精度机制，不是
  新领域概念

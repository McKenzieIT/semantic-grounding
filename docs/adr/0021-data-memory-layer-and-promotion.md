# ADR-0021: 数据 memory 层与晋升规则 —— 两个存储 × 事实层两个视角、单向锚定、证据三类

- **Status**: accepted
- **Date**: 2026-10-14
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0005（provenance 在 commit 不在 YAML —— R2 trailer 溯源的根据）、ADR-0012
  （概念 = KG ontology 结构层；本 ADR 不重开语义层/KG 划分）、ADR-0018（R1 无在线第二方 ——
  R3 自晋升的约束来源）、ADR-0004（`X-SG-Session` trailer —— R3 复现守卫的计数依据）、map
  [#125](https://github.com/McKenzieIT/semantic-grounding/issues/125)、决策票
  [#130](https://github.com/McKenzieIT/semantic-grounding/issues/130)（五轮 grilling，canonical
  裁决来源）、前件 [#126](https://github.com/McKenzieIT/semantic-grounding/issues/126)（竞品：
  memory 与被确认事实恒为两个物理存储）/
  [#127](https://github.com/McKenzieIT/semantic-grounding/issues/127)（k11 实测 446/453 事件 +
  107/321 表把带日期实测写进自由文本；三休眠槽零消费者）/
  [#128](https://github.com/McKenzieIT/semantic-grounding/issues/128)（九张场景卡
  `docs/data-memory-scenarios.md`；114 张表 `analyst_confirmed` 由跑批 agent 确认）

## Context

SG 今天只有一种存储单位 —— definition（`table` / `event` / `concept`；`metric` 是表内
`metrics:` 块的派生只读视图）。语义层（table/event）与知识图谱（concept + 概念侧边）在存储上
同构：同一 corpus git 仓、同样参与定义指纹、同走 Tier-2 审计写。它们按**描述对象**分，不按
**可信度**分。

经验性、带语境的知识（「20260729 单日实测 cnt=355」「由表名 acc 推断」「某天上游未产出」）
没有落点，只能挤进定义的自由文本：复测即改定义指纹，ADR-0018/0019 漂移守卫误判为定义更新；
推断与实锤并排、读者分不清；ETL 运维类时点事件连挤都挤不进（k11 零命中）。而唯一现成的
「已确认」标记 `confirmation.confirmed_by` 已被跑批 agent 自填成噪声（#128 额外发现 1）。

## Decision

| # | 维度 | 裁决 | 关闭的取舍 |
|---|---|---|---|
| R1 | 分界判据 | 一条内容**离开产生它的时间点与会话仍成立、且已核实** → 事实；带时间点 / 带分区或会话语境 / 未核实推断，任一成立 → **memory**。九张场景卡全部可切，A2 证明「已核实」一条不可省 | 只看是否带时间点（A2 推断会被误判为事实） |
| R2 | 模型表述 | **两个物理存储 × 事实层两个视角**：事实层 = 语义层（数仓对象）+ KG（业务概念），划分沿用 ADR-0012 不重开；memory 层独立存储，**不是 definition、不参与定义指纹、必须进 git**（pending queue 不跨克隆，#127 已排除）。对用户仍可讲「三层」，ADR 与代码按两存储建模 | 三个独立存储（KG 与语义层的问题不在可信度，拆分无收益）；memory 作第四种 kind / 塞进 concept properties（#126 不借鉴） |
| R3 | 结构独立 | memory **只按身份锚定事实层，不依赖其结构**（不记文件路径、字段位置）→ 语义层与 KG 可各自演进数据结构（类型化边、多跳、SLA 字段…）而不影响本 ADR。锚点须能指向**边**，不只节点 | 按位置引用（事实层改结构即全体失效） |
| R4 | 引用方向 | **单向**：每条 memory 带 **≥1** 个锚点（定义 id 或边）；事实层 YAML **不存任何反向链接**，「某定义有哪些 memory」由读面按锚点索引现查；晋升溯源进 commit trailer（`X-SG-Memory: <id…>`），不进 YAML | 双向链接（每写一条 memory 改一次定义指纹，即要消灭的问题本身）；零锚点 memory（挂不上既有读结果，#126/#129 已证 agent 不会自觉召回） |
| R5 | 晋升主体 | **agent 自晋升**，无审批人（继承 ADR-0018 R1）。晋升是一次普通 Tier-2 写 + trailer `X-SG-Evidence` | 人审 / 提案箱（ADR-0018 R1 已否） |
| R6 | 晋升证据 | 只认三类：**① source** 确定性来源（DDL / 列注释 / 文档 / 代码，trailer 写明出处）· **② user-stated** 人在会话中明说 · **③ replicated** 独立复现 —— ≥2 条 memory、**不同会话且不同日期**、结论相同，**服务端守卫按 `X-SG-Session` 核验，不满足拒写**。①② 可**不经 memory 直接晋升**；③ 必须引用 memory id。不可作依据：单次观测、本会话自推断、跑批 agent 自我确认 | 只填确认字段（k11 的 114 张「伪确认」）；全部自申报不核验（重复观测最易滥用，须机器数） |
| R7 | 永不晋升 | 带 `valid_until` 的时点事实（incident）；测量值本身（结论可升，数字不升） | — |
| R8 | 部分晋升 | 结论进事实层，**验证边界留作 caveat 类 memory**，事实层**不加标记**；caveat **不受读面挂载预算截断、恒展示**；补验通过后新 observation 与原记录构成 ③，caveat 被 supersede（不删） | 写进 `coverage.limitations`（边界本身按 R1 是 memory，补验即改指纹，重演 E1 污染） |
| R9 | 类型 | 五类，各有固定晋升出路：**observation**（带时点测量/现象 → 结论经 ③ 升为属性）· **caveat**（验证边界 → 不升，被补验取代）· **inference**（未核实判断 + 依据 → 经 ①/② 升）· **practice**（口径、绕坑手法 → 经 ② 升为已验证查询或指标口径）· **incident**（带有效期的时点事件 → 永不升，过期后读面默认隐藏）。无 `alias_hint` 类：别名有确定性来源，按 R6 直接晋升 | 无类型自由文本（读面无法排序，回到 k11 一大段描述）；`alias_hint` 中转类（空转） |

## Consequences

- 事实层指纹只因事实变化而变；漂移守卫对「复测」「补验」不再误报。
- 读面要新建「按锚点查 memory」的索引（建图时顺带），以及一条类型优先级规则（caveat 恒展示、
  过期 incident 隐藏）—— 具体挂载预算与挂在哪些读工具归后续决策票。
- 三个休眠槽（`confirmation` / `coverage` / `supersedes`）按 R1 装的多为 memory 内容，**倾向退役或
  改作 memory 载体**而非复活为事实字段；裁决归存储形状票。
- 锚点 id 今天不统一（concept 带 `concept:` 前缀、table/event 裸名，`kinds/*-kind.ts`），relation
  无 id —— R3/R4 的前置工作，归存储形状票。
- 锚点目标被改名/删除时 memory 的去向未定，可能使 KG 管理缺口「删除/合并/改名」转热（map #125 fog）。
- k11 存量污染（446 事件 + 107 表的带日期自由文本）是否迁移为 memory 未定（map #125 fog）。

# ADR-0028: 列级黑话的落点 —— 术语概念记「术语 → 列」，不加列级 `alt_labels`、不连表

- **Status**: accepted
- **Date**: 2026-10-16
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0012（概念写路径 + `properties` + `related_refs` —— R1/R3 的载体）、ADR-0017 S1（substrate 公共面
  勿加宽 —— 否列级 `alt_labels`）、ADR-0018（定义指纹与漂移守卫 —— 否列级 `alt_labels` 的成本项）、ADR-0021（判据与
  source 证据 —— R1）、ADR-0022 R6（KG 强 schema 移出本图 —— R2）、ADR-0023 R4（锚点：概念是图节点，列片段不是 ——
  R1）、#132（判别联合 inputSchema 在 Claude Code CLI 不可见 —— Consequences）、#156（E3 剧本 —— R4）、map
  [#125](https://github.com/McKenzieIT/semantic-grounding/issues/125)、决策票
  [#159](https://github.com/McKenzieIT/semantic-grounding/issues/159)（五轮 grilling，canonical 裁决来源）

## Context

剧本卡 E3（`docs/data-memory-scenarios.md`）：业务方说「按 2渠 拆一下」，A 从列注释学到 `ch_id` =「渠道id，又叫2渠」，
别名应立即晋升。票面原以为晋升目标是**列别名**，但列今天没有 `alt_labels`。本票核验（k11 实测，2026-10-15）：

- **「黑话查不到」只对一半**：表的检索文本已含每列列名 + 列注释（`kinds/table-kind.ts:32-36`），
  `search_definitions("2渠")` 已命中 8 张表（整串 2.00），「按2渠拆」也命中（0.33 居首）；`resolve_alias("2渠")` → `[]`。
  能搜到「哪几张表」，定位不到「哪一列」，精确别名查不到。
- **黑话不属于某一列**：「又叫1渠 / 又叫2渠」原样出现在 8 张表的 `ch_type` / `ch_id` 注释；`ch_type` 在 26 张表、`ch_id`
  在 18 张表，另 10 张表的 `ch_id` 注释只写「渠道id」（含 `univ_acc_churn_di` 等流失表）。k11 无任何渠道概念（10 个
  concept 全是业务域）。
- **用户裁定业务语义**：一个一级渠道下有 1..N 个二级渠道，2渠 是 1渠 的下一级。
- 概念侧边今天只投影为 `related_to`（`kinds/concept-kind.ts:58-68`），只带自由文本 `derivation`，无层级边类型。

## Decision

| # | 维度 | 裁决 | 关闭的取舍 |
|---|---|---|---|
| R1 | 落点 | 列级黑话晋升为 **术语概念**（KG 事实，非 memory —— 离开会话与时点仍成立、列注释即 source 证据）。A 被问住的过程才是 memory。概念是图节点，可作锚点（ADR-0023 R4） | 列级 `alt_labels` 新字段（改表 schema、指纹 / 漂移守卫、enrichment、别名索引、`resolve_alias` 返回形状五处；列片段非图节点；同词 8 表各写一遍）；降为 caveat / practice 不晋升（确定、可复用、无时效，按 ADR-0021 判据应升；#156 定 E3 为唯一直升卡） |
| R2 | 粒度与层级 | 层级不同即分概念：`concept:一级渠道`（`alt_labels: [1渠]`，`properties: {column: ch_type, recent_column: ch_type_lst}`）、`concept:二级渠道`（`alt_labels: [2渠]`，`properties: {column: ch_id, recent_column: ch_id_lst, parent: 一级渠道, parent_column: ch_type}`）。父子关系 = 一条 `related_to` 边（二级 → 一级），方向与基数写进 `derivation`（「隶属上级：一级渠道（1:N），下钻时按 ch_type, ch_id 分组」）+ `properties` 结构化字段。**不加层级边类型** | 合成一个 `concept:渠道`（只适用于名称/编号关系，用户已否）；SKOS `broader` 等新边类型（KG 强 schema，ADR-0022 R6 移出本图，剧本无遍历场景） |
| R3 | 不连表 | 术语概念**只记「术语 → 列」**，找表交给 agent 按列名检索（`search_definitions("ch_id")`，表检索文本本就含列名）。前提：同名列同义（k11 各表 `ch_id` 为同一套渠道编码）；子串噪声（`vip_ch_type`）可接受，agent 读 `get_definition` 自辨 | 概念连全部含列的表（44 条边，新表接入须补边、漏补即静默漏表）；只连注释带别名的 8 张（漏 10–18 张，行为取决于当初谁写了注释） |
| R4 | E3 判定 | B 的题目落在**注释不带别名的表**：「按 2渠 拆一下昨天的流失账号数」→ 须用 `dws_10000251_univ_acc_churn_di.ch_id`。加**晋升前对照组**（同题、无概念语料）必须不过，否则换题。L1 轨迹读过 `concept:二级渠道`；L2 答案同时含 `univ_acc_churn_di` 与 `ch_id` | 原卡题目（2渠 落在带别名的表：晋升前 search + 列注释即可过，证明不了晋升作用） |

## Consequences

- 晋升（#136）：E3 无代码改动；补一条测试 —— `X-SG-Evidence: source`（出处 = `dws_10000251_acc_summary_df` 的 `ch_id`
  列注释）的概念晋升正常写入。
- 接力 e2e（#157）：新题目 + 对照组 + L1/L2 判定。**A 的写入路径**：`create_definition` 仍为判别联合（`write.ts:44`），在
  Claude Code CLI 不可见（#132），E3 的 A 腿在 `claude -p` 上须走 `import_definitions`（顶层 object、接受 `kind: concept`）
  + `add_relation` / `add_alias`；下游不得假设 A 用 `create_definition`。
- 场景卡 E3 按 R4 改写（`docs/data-memory-scenarios.md`）。
- **Followup**：同类黑话（其他列注释里的「又叫X」）的批量发现归工程图（map #125 Out of scope）；本 ADR 只定落点形状。

## Update 2026-10-16（[#180](https://github.com/McKenzieIT/semantic-grounding/issues/180) 接力宿主重排后）

接力实测宿主从「Claude Code CLI + codex + qodercli 三宿主」收为「QoderWork（GUI 人工）+ qodercli（脚本）」（[#180](https://github.com/McKenzieIT/semantic-grounding/issues/180) R1/R3，落地于 [#181](https://github.com/McKenzieIT/semantic-grounding/issues/181)）。原 Consequences 里 E3 A 腿走 `import_definitions` 的理由 —— 「`create_definition` 在 `claude -p` 上不可见」—— **前提已失效**：qodercli 1.1.28 实测 32 个 SG 工具全可见，两个判别联合工具（`create_definition` / `update_definition`）一个不少（[#180](https://github.com/McKenzieIT/semantic-grounding/issues/180) 探针实证）。

**结论维持，理由更换**：E3 A 腿**仍走 `import_definitions`**（改动为零、风险为零），但按 `docs/agents/decision-framing.md` 「优先级改变时点名改变它的输入」，理由从「宿主不可见」换为**规避判别联合形状的宿主风险** —— 哪天又换一个会静默丢弃 oneOf-only inputSchema 的宿主，E3 会以极难排查的方式失败，`import_definitions` 顶层 object 形态对宿主形状不敏感。

[#132](https://github.com/McKenzieIT/semantic-grounding/issues/132) 的跨宿主样本随之修正为**一负两正**：一负 = Claude Code CLI 2.1.263（静默丢弃）、两正 = QoderWork + qodercli 1.1.28（均可见）。防回潮断言（每个 inputSchema 须有顶层 `properties`）继续保留。

## Update 2026-10-17（[#183](https://github.com/McKenzieIT/semantic-grounding/issues/183)：R4 的对照组判据改形）

R4 原定「B 的题目落在**注释不带别名的表**」。两次真跑证明这个条件**选错了泄漏通道**，对照组仍过（2026-10-16 第二跑：control 1/3 leaked，treatment 5/5 PASS）。

**实测的泄漏链**（k11 现状核验，2026-10-17）：`search_definitions("2渠")` → `dws_10000251_acc_summary_df.c2`「渠道id，又叫2渠」→ 得到列名 `c2` → `search_definitions("流失账号")` → `dws_10000251_univ_acc_churn_di`（`alt_labels` 含「流失账号」）→ 该表有同名列 `c2`。全程不碰概念层，两个 L2 关键词全中。

**为什么换表、改注释都堵不住**：

- 目标表注释**本来就不带别名**（`c1`「渠道」/`c2`「渠道id」），R4 的条件早已满足 —— 泄漏不走注释，走**列名**。
- 而列名正是概念 `properties.column` 的值，对照组和晋升组命中的是同一个字符串；把目标表的列改名就同时打断了晋升组。
- 根因是结构性的：R1 要求晋升带 `source` 证据（列注释），**别名→列的映射按定义就在语料里**。凡是以这个映射为答案的问句，对照组都能答。

**改判**：判据移到**只有概念层才有的事实**上 —— 用户在 R2 裁定、A 腿从业务方得到的层级语义「一个一级渠道下有 1..N 个二级渠道，下钻时按 `c1, c2` 分组」。全语料 grep 核验：k11 无「一级渠道/二级渠道/隶属/1:N」（仅有无关的「二级页签」「变更一级原因」与 JOIN 扇出告警里的「一对多」）。新判据：

| 位置 | 新值 |
|---|---|
| B 问句 | 「按 2渠 拆一下昨天的流失账号数」+ 它和 1渠 什么关系 + GROUP BY 写哪些列 |
| L2 `allOf` | `univ_acc_churn_di`、`c1`、`c2` |
| L2 `anyOf` | `1:N` \| `1..N` \| `一对多` \| `隶属` |
| L1 | 不变（轨迹读过 `concept:二级渠道`） |

顺带把 R2 的 `related_to` 边纳入实测覆盖（[#159](https://github.com/McKenzieIT/semantic-grounding/issues/159) 裁了这条边，此前无真跑验过）。R4 表格里的 `ch_id` 为 [#182](https://github.com/McKenzieIT/semantic-grounding/issues/182) 改名前的旧列名，今读作 `c2`。

**残余风险（记录，由对照组实跑量）**：「1渠/2渠 = 一级/二级渠道」属游戏行业常识，对照组有可能靠世界知识猜中而非查到。L2 是子串判定，分不清「查到」与「猜到」；只能靠 3 轮对照组实跑的命中率来判。若仍泄漏，下一步不是再改问句，而是认定 E3 这张卡在「纯 source 证据」约束下无法构造干净对照组。

## 被否掉的路（记录免重探）

- **「列注释里的黑话 SG 完全查不到」**：全文检索已覆盖列注释，缺的是「术语 → 列」的精确映射；不再以「查不到」立论。
- **按注释里的「又叫X」启发式自动入别名索引**：自由文本解析，误判即错误别名；晋升由 agent 带证据显式写入。

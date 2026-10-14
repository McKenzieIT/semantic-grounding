# ADR-0024: memory 读面挂载 —— 搭既有读结果的便车、可选查询时间窗、分栏预算

- **Status**: accepted
- **Date**: 2026-10-15
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0021（memory 层；R8 caveat 恒展示、R9 incident 过期隐藏 —— 本 ADR R3 修订后者措辞）、
  ADR-0023（存储形状；R2 outdated/wrong、R4 锚点、R6 `promoted`、R7 `valid_*` = 业务时间 —— 本 ADR 的输入）、
  ADR-0005 ruling 6（六个读工具）、#105（`list_definitions` 索引不带 description —— R1 不挂的同一契约）、
  `tools/guidance.ts`（`_guidance` 仅写工具 —— R6）、map [#125](https://github.com/McKenzieIT/semantic-grounding/issues/125)、
  决策票 [#135](https://github.com/McKenzieIT/semantic-grounding/issues/135)（五轮 grilling，canonical 裁决来源）、
  前件 [#126](https://github.com/McKenzieIT/semantic-grounding/issues/126) / [#129](https://github.com/McKenzieIT/semantic-grounding/issues/129)
  （无产品依赖 agent 自觉召回；B 的真实轨迹 = search → get）

## Context

ADR-0021 定了 memory 不新开召回工具、挂在既有读结果上（零税键），caveat 恒展示、过期 incident 隐藏；
ADR-0023 定了存储与锚点。没定挂在哪几个工具、挂多少、按什么排、「过期」相对什么。两条前提经本票核实：

- **六个读工具均无时间窗入参**（`tools/read.ts`：`get_definition` 只收 `{kind, name}`）。ADR-0023 要求可见性
  按**查询涉及的数据时间窗**判、不按今天 —— 今天服务端拿不到这个窗。
- **`_guidance` 只挂 7 个写工具**（`guidance.ts:7-11`「Read tools never get this field」），语义是语料初始化阶段。

## Decision

| # | 维度 | 裁决 | 关闭的取舍 |
|---|---|---|---|
| R1 | 挂哪些工具 | **`get_definition` = 主挂载点**，全文：锚在本节点（含列片段）的 `memories` + 以本节点为任一端的边锚点 `edge_memories`。**`get_join_path` / `get_relations`**：路径 / 列表中每条边挂该边锚点全文。**`search_definitions`**：每个 hit 只挂按类型计数 `memory_counts`，不带正文。**`resolve_alias` / `list_definitions` 不挂**。均为零税键（无 memory 时键缺省）。metric 只挂锚在 `metric:<表>__<键>` 的条目、不连带宿主表、无 `edge_memories` | 新开召回工具（#126/#129：agent 不会自觉召回）；边 memory 只挂关系工具（B 可能不调就直接写 SQL）；`list_definitions` 挂计数（破 #105 索引契约）；search hit 带正文（10 行即撑爆） |
| R2 | 查询时间窗 | `get_definition` / `get_join_path` / `get_relations` 加**可选** `data_window: {from, to}`（ds 粒度），描述写明「问题涉及具体日期时传入」。`search_definitions` 不加 | 拿今天作参照（ADR-0023 已否）；默认窗如「近 30 天」（仍以今天为参照）；必填（破既有调用） |
| R3 | 可见性 | **传窗**：incident / observation 与窗相交才展示，否则隐藏；被 outdated 取代的旧条目在窗覆盖其旧段时展示。**不传窗**：incident / observation **不隐藏**，按新近度进预算；outdated 旧条目隐藏、只展示现行。任何情况下 `wrong` 永久隐藏、`promoted` 非空折叠且不占预算、caveat 恒展示且不占预算。**修订 ADR-0021 R9**：「过期后读面默认隐藏」→「查询窗外隐藏；未给窗时不隐藏，按新近度占预算」 | 不传窗时按字面隐藏过期 incident（只能拿今天参照，G3′ 在 B 不传窗时直接失败 —— #129 已证参数用不用靠描述引导、无保证） |
| R4 | 预算与排序 | `memories` 上限 **8**、`edge_memories` 上限 **5**，各自独立计；关系工具每条边上限 **3**。按条数计、正文不截断；代码常量、不开配置（同 `LIST_DEFINITIONS_CAP`：响应体量是契约）。类型优先级 **practice > incident > inference > observation**；同类型内有 `valid_*` 的按 `valid_until`（缺则 `valid_from`）新→旧，无的按 `recorded.at` 新→旧。超出只给 `memories_truncated` / `edge_memories_truncated` 按类型计数，**不新开工具** | 单一预算（`dim_server` 这类被几十张表 join 的维表会被别表的 join 坑刷满、自身口径被挤掉）；observation 优先（测量值结论多半已晋升，原始数字价值最低） |
| R5 | 列片段 | 每条原样输出 `anchor`（如 `table:x#ch_id`）；**不参与排序**（`get_definition` 无「关心哪一列」的信号，ADR-0023 R4「列作排序依据」在此无可用输入）；列已删的降级条目带 `column_missing: true` | 列锚点优先（无依据的偏置） |
| R6 | 计数一致性 | `memory_counts` 只数 `get_definition` **不传窗时可见**的条目（排除 wrong / 已折叠 promoted / outdated 旧段；caveat 计入），保证「搜索见 3 条、点进去见 3 条」 | 数全部存储条目（计数与所见不符，B 学会不信计数） |
| R7 | `_guidance` | **不挂**读工具、不兼做 memory 提示 | 兜底「本定义有 N 条 memory」（R1 已覆盖每个入口；一字段两种语义、扩到读工具，重演 #121 收掉的判断分叉） |

## Consequences

- 三张剧本种子卡在 B 的最短轨迹（search → get）上 L1 可达：A3 的 practice 排首位；G3′ 的 incident 在传窗与
  不传窗两种情况都出现、传窗时窗内外行为不同；边上的 join 坑无论是否调关系工具都可见。
- 读面依赖 ADR-0023 R1 的常驻锚点索引（#152）与统一节点 id（#151）；边锚点按逻辑方向认身份，两端 id 即可查。
- **Followup**：若 #129 L1 轨迹实测显示 B 看到 `memory_counts` 不跟进 `get_definition`，再议提示；预算常量
  8 / 5 / 3 按实测调；`data_window` 是否也用于定义加载侧的其他过滤不在本图。

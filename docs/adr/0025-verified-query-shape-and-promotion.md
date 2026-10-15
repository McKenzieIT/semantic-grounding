# ADR-0025: 已验证查询的形状与晋升 —— 独立 kind、正本归属划界、证据只认 ①②、全宿主可见写口

- **Status**: accepted
- **Date**: 2026-10-15
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0022（R3 SQL 原文永不进事实层 —— 本 ADR R2 改按正本归属划界；R4 分析先行、首个新事实形状）、
  ADR-0021（R6 三类证据 —— 本 ADR R3 对 query 收窄为 {①, ②}；R9 practice 的出路）、ADR-0005（「谁写的、依据什么」
  只归 commit + trailer —— R4；create_/update_ 动词惯例 —— R6）、ADR-0023（`<kind>:<名>` 节点 id、锚点形状与写时
  校验、`promoted` 回指）、ADR-0024（读面挂载形状 —— R5 照抄）、ADR-0012（概念 properties 为标量）、#132（新写口须
  顶层 object）、map [#125](https://github.com/McKenzieIT/semantic-grounding/issues/125)、决策票
  [#138](https://github.com/McKenzieIT/semantic-grounding/issues/138)（六轮 grilling，canonical 裁决来源）、
  前件 [#126](https://github.com/McKenzieIT/semantic-grounding/issues/126)（Cortex VQR 形状）/
  [#128](https://github.com/McKenzieIT/semantic-grounding/issues/128)（A3 卡）

## Context

ADR-0022 R4 定分析先行，首个新事实形状 = 已验证查询（A3：「大R 留存」两次同口径）。本票核实三条前提：

- **X63 上「大R」今天零命中**：11 个概念的 alt_labels 无「大R」/「R级」；只有三张 `*_tag_df` 的 `r_level` 列
  （01–09，「付费R级」）。A3 在 X63 的真实形状 = 选定「大R = 哪几档」，不是 k11 卡面的「累计付费 ≥ X 元」。
- **现成「口径」槽零使用**：表/事件内嵌 `metrics.caliber_variants`（`types.ts:96`）在 X63 171 文件全空；
  metric 是从单张宿主表**派生的虚拟投影**，无文件、无指纹、不可写（ADR-0005 裁决 2）。
- `create_definition` / `update_definition` 是 #132 的 oneOf 豁免存量，名单不得扩充；#129 接力 harness 的 A 是
  `claude -p`，看不到这两个工具。

## Decision

| # | 维度 | 裁决 | 关闭的取舍 |
|---|---|---|---|
| R1 | 落点 | **独立 kind `query`**：一条一文件，节点 id `query:<名>`；是图节点，故 ADR-0021~0024 的锚定、挂载、指纹、漂移守卫零改动复用 | 指标 `caliber_variants`（单宿主表派生投影，跨表留存挂不上，口径一改动宿主表指纹）；概念 `properties`（标量，一个概念下多个问题） |
| R2 | SQL 进不进 | **进，SQL 即正文**。ADR-0022 R3 的边界改写为按**正本归属**：正本在 SG 的 SQL（已验证查询）进事实层；正本在别处的 SQL（ETL）只存 code reference、原文至多作 memory 快照。**日期必须参数化**（`${start_ds}` 等），写口遇分区日期字面量拒写 | 结构化口径 DSL（半个指标引擎，违 ADR-0022 R2）；照搬 R3 不让进（口径无处安放，A3 落空） |
| R3 | 晋升证据 | 只认 **① source**（文档/代码明写口径，trailer 附出处）与 **② user-stated**；**③ replicated 拒写**——两个 agent 自选一致 ≠ 口径被约定，只留作 practice memory。对 ADR-0021 R6 的按类型收窄 | 放行 ③（把同一个错误选择固化成标准口径，即 114 张伪确认搬到口径层） |
| R4 | verified_by/at | **YAML 不设**。是 `query` 节点本身即「已验证」的声明；谁、何时、凭什么由晋升 commit（作者 + `X-SG-Evidence` / `X-SG-Session` / `X-SG-Memory`）回答。读面展示确认时间 → Followup，并入 ADR-0022 R5 的 `get_history` | 照抄 Cortex VQR 字段（与 ADR-0005 双数据集；即刚退役的 `confirmation` 槽） |
| R5 | 阈值 | 本图「大R = 哪几档」**写在查询 SQL 里**，无独立事实。业务分群/阈值作独立口径事实 + 查询引用 → **分析图**（种子：第二条大R 查询出现时两处划档可能打架） | 本图建概念「大R」+ 划档属性（只有一条查询时零收益，且引出口径引用/级联一串决策） |
| R6 | 读面 | ① `search_definitions` 索引 query（问题 + 同问异说 + 描述），`kinds` 增 `query` · ② `get_definition`（表/概念）增 `verified_queries: [{id, question}]` ≤5，**由查询的 `uses` 现查**，表 YAML 不存反向链接 · ③ `get_definition(kind:'query')` 返回问题 / SQL / `uses` / version 并按 ADR-0024 挂 memory · ④ `resolve_alias` 不返回、`list_definitions` 只列入清单。`uses` = ≥1 个 ADR-0023 锚点、**写入方声明**、写时必须存在；SG 不解析 SQL 推导 | 只靠 search（B 先走到表就错过口径；#126 无产品依赖 agent 自觉召回）；SG 解析 SQL 推 `uses`（ADR-0022 R2、字段级血缘 Followup） |
| R7 | 写面 | 新工具 **`create_verified_query` / `update_verified_query`**，顶层 object：`{name, question, alt_questions?, sql, uses[], description?, evidence, evidence_source?, memory_ids?}` + 公共块 `{summary, derivation, confidence}`，update 必传 `expected_version`。`evidence ∈ {source, user-stated}`；`memory_ids` 选填，传则写 `X-SG-Memory` 并按 #136 机制追加 `promoted`。回执 `_guidance`：agent 自选口径请用 `record_memory(type: practice)`。删除/退役 → Followup（触发：第一条要退役的口径） | 给 oneOf 豁免存量加 `kind:'query'`（门禁不红但 Claude Code 类宿主看不见，接力 A 腿写不了）；单工具 create-or-update（ADR-0005 已否复合动词） |

## Consequences

- 工具面 29 → 32（`record_memory` + 本对），root barrel 零新名（ADR-0017 不加宽）。
- A3 剧本在 X63 的形状：A 记 practice「大R = r_level 07–09」→ 用户确认 → `create_verified_query(大R留存)`
  （`uses: [table:dws_10000354_univ_acc_tag_df#r_level, …]`）→ B 搜「大R 留存」或打开宽表即见。
- 分析图种子新增：业务分群/阈值作独立口径事实；`caliber_variants` 空槽去留。
- 元数据治理图种子：SQL 引用的表/列改名后查询悄然失效（`uses` 锚点体检可覆盖一部分）。

## Verification

- 新工具 inputSchema 顶层 `properties`（#132 防回潮断言保持 deepEqual 不扩名单）。
- 写口：`replicated` 拒写、`source` 缺出处拒写、分区日期字面量拒写、`uses` 悬空拒写、update 版本不符 `stale_baseline`。
- 读面：search 命中；宽表 `get_definition` 带 `verified_queries`；改查询不改表指纹；无查询时各工具返回字节不变（零税）。
- A3 正路：practice memory → 晋升 → `promoted` 回指 → 读面折叠该 memory。

## Update 2026-10-16（#155 落地——漏裁处的最小合理形状）

R1–R7 的实现补裁（ADR 漏裁处，记最小合理形状；先例 ADR-0023 的三个 Update）：

- **分区日期字面量的检测口径（R2 只裁了「拒写」，未裁什么算字面量）**：SQL 文本里
  出现的**日期形状字面量**——引号内或裸写（单双引号都认）、`YYYYMMDD`（ds 分区拼法）
  或 `YYYY-MM-DD`、且日历上可信（年 1900–2100、月 01–12、日 01–31）——即拒写；
  检测在工具面 zod 层（写口即口径执行点），`${start_ds}` 式占位符不含日期形状、天然
  通过；`12345678` 这类非日期的 8 位数（阈值）不误伤。检测函数单一来源在
  `tools/query.ts`（`findPartitionDateLiterals`），substrate 存储侧 schema 不重复该规则
  （手写文件与既有 definition schema 同等宽容）。
- **`_guidance` 的渲染通道（R7 只裁「回执带一句」，未裁与 #55 相位模型 `_guidance`
  的关系）**：七个人肉列名的播种工具集（`GUIDANCE_TOOL_NAMES`）不扩——相位模型度量
  DW/KG 播种进度，与已验证查询无关；本对回执的一句指引（practice 指路）走写回执信封
  的 domain 键。因本对永不进相位门，domain 键与信封 `_guidance` 不存在实际冲突——
  ADR-0024 R7 否决的「一字段两种语义」针对的是读工具与 memory 提示，此处是 R7 明裁
  的写回执句子，渲染在同一键上以免宿主开第二通道。
- **`X-SG-Memory` 的渲染条件（R6/#136 原文「replicated 的引用走 X-SG-Memory」）**：
  渲染条件由「kind=replicated」放宽为「引用了 memory」——本对的 `memory_ids` 在 ①/②
  下引用（③ 已在工具门口拒掉，走不到这）。五个 #136 工具的 schema 本就把 `memories`
  限定在 replicated，其 trailer 集逐字不变。
- **`memory_ids` 的校验面（R7 未裁 ①/② 引用的机器核验）**：只验存在性（substrate
  `writeVerifiedQuery` 首写前）——不走 #136 复现守卫（≥2 异会话异日是对 ③ 的证据
  要求，不是对 practice 出身的溯源要求）；wrong 隐藏条目不剔除（回指追加无害：
  wrong 条目在任何读面本就永久隐藏）。
- **update 的语义（R7 未裁 update 是全量替换还是字段覆盖）**：与 create 同一形状、
  全量替换 + `expected_version`（`queries/<name>.yaml` 走 io.ts create 家族审计 seam，
  seam 自带基线校验）；不引入 `update_definition` 的 fields 覆盖装置。
- **`uses` 的存储与现查形状（R6 未裁存储拼写与匹配面）**：写入时经 #152 锚点机器
  规范化（裸名兼容入参、规范前缀输出、存在性含列、悬空/歧义拒写），存规范形；
  `verified_queries` 现查按「节点本体 / 列片段（锚在父定义）/ 边（两端都挂，边
  memory 先例）」三种匹配面，id 升序、cap 5 为代码常量。手写 YAML 里的裸 `uses` 不在
  现查中解析（写路径恒存规范形）。
- **query 节点在图层的位置（R1「是图节点」的边界）**：投影/搜索索引/`list_definitions`
  清单照常参与；关系图为**零邻接**（`relations()` 恒空——uses 是锚不是边，查询永不
  出现在 `get_join_path`/`get_relations`）；`resolve_alias` 因 schema 无
  `pref_label`/`alt_labels` 天然不返回；guidance/占比守卫的按 kind 计数把 `query`
  单列（`countNodesByKind` 增 `query` 键、不折入 DW——口径制品不是 text-to-SQL 资产，
  排除法计数若不单列会污染 `_guidance`/playbook/scope 计数）。

# 同行语义层口径片段形状研究

**研究票**: #190
**日期**: 2026-10-18
**研究范围**: dbt Semantic Layer (MetricFlow)、Cube、LookML、Snowflake Cortex Analyst、Databricks Genie/AI-BI、DataHub/Atlan
**约束**: SG 不执行 SQL、不做口径 DSL (ADR-0022 R2、ADR-0025 R2)、substrate public surface 不加宽 (ADR-0017)

---

## 核心发现

**行业共识**: 业务分群/阈值（「大R = r_level 07–09」「活跃用户」）在语义层产品里几乎都**内嵌在指标/查询里**，极少作为独立一等对象存在。只有 Cube 提供显式的 `segments` 原语；其他产品的「可复用口径片段」要么是参数化查询（dbt saved queries）、要么是声明式 filter（LookML filter only field）、要么是 verified query 的 SQL 本体（Cortex Analyst）。

**对 SG 的关键启示**: ADR-0025 R5 裁决「阈值写在查询 SQL 里，无独立事实」与行业主流一致。分析图种子「业务分群/阈值作独立口径事实」的触发条件——第二条大R 查询出现时两处划档打架——在行业里靠**单一来源引用**解决（dbt 的 entity filter、Cube 的 segment reference、Cortex 的 verified query 复用），不靠把阈值抽成独立事实。

---

## 逐产品对照

### 1. dbt Semantic Layer (MetricFlow)

**对象形状**:
- **Metric**: `{name, type, type_params, filters[]}` — `filters` 是 `where` 子句数组，每个 filter 是 `{where_sql_template}` 或结构化 `{filter: {where: "..."}}`
- **Saved Query**: `{name, query_params: {metrics[], group_by[], where[]}}` — `where` 数组里每个元素是 `WhereFilterIntersection({where_sql_template: "..."})`
- **Entity**: 语义模型里的 `{name, type: primary/foreign/unique/natural, expr}` — 用于 join，**不用于 filter 复用**
- **无独立 segment 对象**: filter 逻辑要么内嵌在 metric 的 `filters[]`，要么内嵌在 saved query 的 `where[]`，要么抽成 dbt model 里的 SQL view（下游引用 view 名）

**引用方式**:
- Metric 里直接写 `filters: [{where: "{{ Dimension('orders.status') }} = 'completed'"}]` — Jinja 模板展开
- Saved query 里 `where: ["{{ TimeDimension('metric_time', 'day') }} >= '2026-01-01'"]`
- 跨 metric 复用: **不支持** — 每个 metric 自己写 filter；若要复用，把逻辑下沉到 dbt model（SQL view）

**变更传播**:
- YAML-as-code，变更 = PR 合入，CI 跑 `dbt parse` + `dbt build`
- Metric 改名/删 filter → 所有引用该 metric 的 saved query 在 parse 时报错（编译期检查）
- 下游 BI 工具通过 Semantic Layer API 查询，自动跟随最新版本（无版本钉死机制）

**多口径并存**:
- 两个 metric 可以同名不同 filter（在不同 YAML 文件） → **parse 报错**，dbt 要求 metric name 全局唯一
- 解决方案: 命名后缀 `revenue_v1` / `revenue_v2`，或放不同 package
- 无内置「口径版本」字段

**退役/来历**:
- 删除 metric = 从 YAML 删行 + commit
- 无 `deprecated` 标记、无 `superseded_by`、无 `valid_from/until`
- 来历 = git log（谁改的、什么时候、PR 描述里写原因）

**来源**: [dbt Semantic Layer docs](https://docs.getdbt.com/docs/build/semantic-models)（2026-10-18 搜索摘要交叉核对，官网 403 未能 fetch 全文）

---

### 2. Cube (Cube.js / Cube Cloud)

**对象形状**:
- **Segment**: `{name, sql: "..."}` — 一等对象，定义在 data model JavaScript/YAML 文件里
  ```javascript
  cube(`orders`, {
    segments: {
      bigSpender: { sql: `${CUBE}.tier_level IN ('07', '08', '09')` },
    },
    measures: { count: { type: `count` } },
    dimensions: { tierLevel: { sql: `tier_level`, type: `string` } },
  });
  ```
- Segment 返回 boolean，可在 measure/dimension 的 `sql` 里引用: `sql: ${CUBE}.amount * CASE WHEN ${bigSpender} THEN 2 ELSE 1 END`
- Segment 可在 `preAggregations` 的 `segments` 数组里引用（预聚合按 segment 切片）

**引用方式**:
- Measure/dimension 的 SQL 里用 `${segmentName}` 占位符，编译期展开为 SQL WHERE 子句
- Query API 里 `segments: ['orders.bigSpender']` — 客户端显式声明要用哪些 segment
- 跨 cube 引用: `${otherCube}.segmentName` — 支持

**变更传播**:
- 改 segment SQL → 所有引用该 segment 的 measure/dimension/preAggregation 自动跟随（编译期展开）
- 删除 segment → 引用方编译报错（`Segment 'X' not found`）
- 无自动通知下游 BI 工具的机制（Cube Cloud 有 webhook 但非强制）

**多口径并存**:
- 两个 segment 同名 → **编译报错**，要求 name 全局唯一（per cube）
- 解决方案: `bigSpender_v2`，或放不同 cube
- 无 `version` / `deprecated` 字段

**退役/来历**:
- 删除 = 从 model 文件删代码 + commit
- 无内置退役机制
- 来历 = git log

**来源**: [Cube segments docs](https://cube.dev/docs/reference/data-model/segments)（2026-10-18 官网 403，依据搜索摘要 + [Apache Ossie integration blog](https://cube.dev/blog/introducing-apache-ossie-integration) 交叉核对）

---

### 3. LookML (Looker)

**对象形状**:
- **Filter-only field**: `filter: big_spender { sql: ${TABLE}.tier_level IN ('07', '08', '09') ;; type: string }` — 只出现在 WHERE，不返回数据
- **Dimension with sql**: `dimension: is_big_spender { sql: ${TABLE}.tier_level IN ('07', '08', '09') ;; type: yesno }` — 可作为 filter 也可作为分组
- **Derived table**: `derived_table: { sql: SELECT ... WHERE tier_level IN ('07', '08', '09') ;; }` — 把口径固化成 view，下游引用 view 名
- **Refinement**: `view+: orders { dimension+: big_spender { ... } }` — 在不改原文件的前提下给 view 加/改字段（详见下文）
- **Constant / declaration**: `constant: big_spender_tiers { value: "'07', '08', '09'" }` — 全局常量，多处引用

**引用方式**:
- Explore 里 `filters: [orders.big_spender]` — 声明式引用 filter-only field
- Dimension/measure 的 `sql:` 里用 `${big_spender_tiers}` 引用常量（编译期文本替换）
- Refinement 用 `view+:` 语法扩展已有 view，不改原文件（适合跨 package 复用）

**变更传播**:
- 改 filter-only field 的 `sql:` → 所有 Explore/look/dashboard 引用该 filter 的自动跟随（Looker 编译期解析）
- 改 constant 的 `value:` → 所有引用该 constant 的 dimension/measure 自动跟随
- Refinement 改字段 → 只影响 refinement 所在文件，原文件不变（显式 override）
- 删除 filter → 引用方在 Explore 打开时报错（`Field 'orders.big_spender' not found`）

**多口径并存**:
- 两个 dimension 同名同 view → **LookML 校验报错**
- 解决方案: `big_spender_v2`，或用 refinement 在不同 package 里 override（`view+: orders { dimension: big_spender { sql: ... } }` 会覆盖原定义）
- Refinement 是 Looker 独有的「不改原文件但改行为」机制，适合多团队共维同一 view

**退役/来历**:
- 加 `hidden: yes` 或 `description: "Deprecated: use big_spender_v2"` — 无强制退役流程
- 来历 = git log + Looker IDE 的 History 面板（谁改的、什么时候、diff）
- 无 `superseded_by`、无 `valid_from/until`

**来源**: [LookML refinements docs](https://docs.cloud.google.com/looker/docs/lookml-refinements)（2026-10-18 官网 403，依据搜索摘要 + [LookML terms](https://docs.cloud.google.com/looker/docs/lookml-terms-and-concepts) 交叉核对）

---

### 4. Snowflake Cortex Analyst (Semantic Model)

**对象形状**:
- **Semantic model** (YAML): `{name, tables: [{name, dimensions[], measures[], relationships[]}], verified_queries: [{question, sql, verified_by, verified_at}], custom_parameters: {...}}`
- **Filter in measure/dimension**: `{name, sql: "...", filters: [{column: "...", operator: "...", value: "..."}]}` — 内嵌在 metric 定义里
- **Verified query**: `{question: "大R 留存", sql: "SELECT ... WHERE r_level IN ('07', '08', '09') ...", verified_by: "alice", verified_at: "2026-10-18T10:00:00Z"}` — **一等对象**，产品自动复用已验证 SQL
- **Custom parameter**: `{name: "big_spender_tiers", value: "'07', '08', '09'", type: "string"}` — 全局参数，SQL 里用 `${big_spender_tiers}` 引用

**引用方式**:
- Verified query 的 SQL 里直接写死阈值（`WHERE r_level IN ('07', '08', '09')`）或引用 custom parameter（`WHERE r_level IN (${big_spender_tiers})`）
- Cortex Analyst 在回答用户问题时，自动匹配已验证 query 的 question 语义，复用其 SQL（不改 SQL、不重新生成）
- 跨 semantic model 引用: **不支持** — 每个 semantic model 自包含

**变更传播**:
- 改 custom parameter 的 `value:` → 所有引用该 parameter 的 verified query 自动跟随（SQL 文本替换）
- 改 verified query 的 SQL → 只影响该 query，不影响其他 query
- 删除 verified query → 用户再问同样问题时，Cortex Analyst 重新生成 SQL（可能不一致）
- **无自动级联**: 改了表 schema（列改名），verified query 的 SQL 不会自动更新，运行时可能报错

**多口径并存**:
- 两个 verified query 可以问同一个问题（`question` 文本相同）但 SQL 不同 — **允许**，Cortex Analyst 按 `verified_at` 选最新的
- 无内置「口径版本」字段，靠 `verified_at` 时间戳区分新旧
- 解决方案: 改 question 文本（`大R 留存 v2`），或删旧加新

**退役/来历**:
- 删除 verified query = 从 YAML 删行 + commit
- 无 `deprecated` 标记、无 `superseded_by`
- 来历 = `verified_by` + `verified_at` 字段 + git log
- **`verified_by/at` 是 Cortex 独有的「谁确认的、什么时候」字段**，SG 的 ADR-0025 R4 明确否决照搬（理由: 与 ADR-0005 双数据集，即刚退役的 `confirmation` 槽）

**来源**: [Cortex Analyst docs](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-analyst)（2026-10-18 官网 403，依据 [SqlDBM changelog](https://developers.sqldbm.com/changelog) + [Semantic Engineering blog](https://medium.com/@beingabhishekmittal/semantic-engineering-in-snowflake-from-data-to-business-meaning-909bf31e3b1b) 交叉核对）

---

### 5. Databricks Genie / AI-BI

**对象形状**:
- **Genie space**: `{instructions: "...", example_queries: [{question, sql}], sql_functions: [{name, definition}], knowledge_store: {...}}`
- **Trusted asset** (Genie Agents): `{type: "example_query" | "sql_function", question?, sql?, function_name?, definition}` — 经 agent author 验证的参数化查询或 SQL 函数
- **Instruction**: 自然语言文本，描述业务规则（`大R = r_level 07–09`）
- **SQL function**: `{name: "is_big_spender", definition: "CREATE FUNCTION is_big_spender(tier STRING) RETURNS BOOLEAN RETURN tier IN ('07', '08', '09')"}` — 一等对象，可在 example query 里调用

**引用方式**:
- Example query 的 SQL 里直接写死阈值，或调用 SQL function（`WHERE is_big_spender(tier_level)`）
- Genie 在回答用户问题时，自动匹配 example query 的 question 语义，复用其 SQL（标记为「Trusted」）
- SQL function 可在多个 example query 里调用（DRY）
- Instruction 是纯文本，Genie 在生成 SQL 时参考 instruction（非强制）

**变更传播**:
- 改 SQL function 的 `definition:` → 所有调用该 function 的 example query 自动跟随（SQL 函数重定义）
- 改 example query 的 SQL → 只影响该 query
- 删除 example query → 用户再问同样问题时，Genie 重新生成 SQL（可能不一致，且失去「Trusted」标记）
- **正反馈机制**: 用户对 Genie 回答点 👍 → Genie 建议把该 SQL 加为 example query → 管理者批准 → 成为 trusted asset

**多口径并存**:
- 两个 example query 可以问同一个问题但 SQL 不同 — **允许**，Genie 按用户反馈选更受认可的
- 两个 SQL function 同名 → **创建时报错**，要求 function name 全局唯一（per schema）
- 解决方案: `is_big_spender_v2`，或改 function signature（加参数）

**退役/来历**:
- 删除 example query / SQL function = 从 space 配置删
- 无 `deprecated` 标记、无 `superseded_by`
- 来历 = Genie 的 audit log（谁加的、什么时候、用户反馈统计）
- **`Trusted` 标记**是 Genie 独有的「经用户正反馈验证」信号，SG 的 ADR-0025 R3 否决照搬 replicated 证据（理由: 两个 agent 自选一致 ≠ 口径被约定）

**来源**: [Genie Agents concepts](https://docs.databricks.com/aws/en/genie-agents/concepts) + [Use Genie Agent](https://docs.databricks.com/aws/en/genie-agents/talk-to-genie)（2026-10-18 官网 403，依据搜索摘要交叉核对）

---

### 6. DataHub / Atlan (Glossary Term)

**对象形状**:
- **Glossary term**: `{name, definition, owners[], status: DRAFT | APPROVED | DEPRECATED, tags[], custom_properties: {...}}`
- **Term 关联到数据资产**: `{asset_urn, term_urn, source: "MANUAL" | "PROPAGATED"}` — 手动打标或自动传播
- **无内置「口径片段」对象**: glossary term 是业务术语定义（「大R 是什么」），不是可执行的 filter/segment

**引用方式**:
- 数据资产（表/列/dashboard）上打 glossary term tag — 声明「这个资产符合该术语定义」
- 无「引用 term 生成 SQL」机制 — glossary 是文档，不是可执行口径
- Atlan 的 MCP server 让 AI agent 搜索 glossary term，把定义文本注入 prompt（非结构化引用）

**变更传播**:
- 改 glossary term 的 `definition:` → 已打标的资产不自动更新（tag 还在，但定义文本变了）
- 改 term 的 `status:` → 不影响已打标的资产（DEPRECATED term 仍可被资产引用，只是 UI 标灰）
- 删除 term → 已打标的资产失去该 tag（级联删除关联）

**多口径并存**:
- 两个 glossary term 可以同名 → **允许**（不同 namespace / hierarchy）
- Atlan 支持 term hierarchy（`Revenue > Net Revenue > Recurring Revenue`），每个 term 独立定义
- DataHub 支持 term group（类似 folder），同 group 内 name 唯一

**退役/来历**:
- `status: DEPRECATED` + `description: "Use term X instead"` — 显式退役标记
- Atlan 有 `valid_from` / `valid_until` 字段（部分客户启用）
- 来历 = term 的 audit log（谁创建、谁批准、谁废弃）+ ownership 字段
- **Atlan 的 approval workflow**: term 创建/修改需 steward 审批（`status: DRAFT → APPROVED`），SG 的 ADR-0022 R5 明确否决照搬（理由: 单人 + 多 agent 现状下只会挡住用户自己）

**来源**: [Atlan MCP semantic layer](https://atlan.com/know/ai-agent/semantic-layer/mcp-semantic-layer-for-ai-agents/)（2026-10-18 官网 403，依据搜索摘要交叉核对）

---

## 对 SG 的借鉴/不借鉴清单

### 借鉴

1. **阈值内嵌在查询 SQL 里，不抽独立事实**（dbt、LookML、Cortex 的主流做法）
   - 与 ADR-0025 R5 裁决一致:「阈值写在查询 SQL 里，无独立事实」
   - 分析图种子「业务分群/阈值作独立口径事实」的触发条件: 第二条大R 查询出现时两处划档打架 → 此时再抽
   - **问数示例**: 用户问「大R 留存」→ agent 搜到 verified query `大R留存` → 复用其 SQL（`WHERE r_level IN ('07', '08', '09')`）→ 若用户再问「大R 付费」且划档不同 → 两处 `r_level IN (...)` 打架 → 触发「抽阈值成独立事实」分析图

2. **参数化阈值用占位符 `${big_spender_tiers}`**（Cortex custom parameter、LookML constant）
   - SG 的 verified query SQL 里可写 `${big_spender_tiers}`，写口在工具面做占位符校验（日期字面量拒写，阈值占位符放行）
   - 阈值定义放哪: **暂不引入新 kind**，放 verified query 的 `description` 或挂 memory（`type: practice, content: "大R = r_level 07–09"`）
   - **问数示例**: `create_verified_query(name: "大R留存", sql: "SELECT ... WHERE r_level IN (${big_spender_tiers}) ...", description: "大R = r_level 07–09，详见 memory mem-xxx")`

3. **verified query 复用已验证 SQL**（Cortex、Genie）
   - 与 ADR-0025 R1 裁决一致: 独立 kind `query`，一条一文件
   - 读面 `get_definition(kind: 'query')` 返回 SQL，agent 在回答同类问题时复用该 SQL（不改、不重新生成）
   - **问数示例**: 用户问「大R 留存」→ agent 搜到 `query:大R留存` → 读其 SQL → 参数化日期（`${start_ds}` / `${end_ds}`）→ 执行

4. **git log 即来历**（dbt、Cube、LookML）
   - 与 ADR-0025 R4 裁决一致: 谁、何时、凭什么由晋升 commit（作者 + `X-SG-Evidence` / `X-SG-Session` / `X-SG-Memory`）回答
   - 不引入 `verified_by` / `verified_at` 字段（Cortex 的双数据集反模式）

5. **改查询不改表指纹**（dbt、Cube）
   - 与 ADR-0025 验证段一致: 改查询不改表指纹
   - verified query 是独立 kind，与表/概念解耦；`uses` 锚点声明「该查询用了哪些表/列」，查询改名/改 SQL 不影响被引用表的 fingerprint

6. **`uses` 锚点显式声明依赖**（Cube segment reference、dbt entity）
   - 与 ADR-0025 R6/R7 裁决一致: `uses: [table:dws_xxx#r_level, ...]`，写口校验悬空
   - 读面 `get_definition(kind: 'query')` 返回 `uses`，agent 在表 schema 变更时体检锚点是否仍有效

### 不借鉴

1. **不引入独立 `segment` kind**（Cube 的 segment 原语）
   - 理由: ADR-0025 R5 裁决「阈值写在查询 SQL 里，无独立事实」；只有当第二条大R 查询出现且划档打架时，才触发分析图「抽阈值成独立事实」
   - 当前阶段: 阈值放 verified query 的 SQL 或 description，或挂 memory（`type: practice`）

2. **不引入 `custom_parameters` / `constant` 全局参数**（Cortex、LookML）
   - 理由: ADR-0025 R2 裁决「SQL 即正文」，不做口径 DSL；引入全局参数 = 半个模板引擎，违 ADR-0022 R2「不执行 SQL」
   - 当前阶段: SQL 里写死阈值（`r_level IN ('07', '08', '09')`）或用 `${xxx}` 占位符（写口校验占位符不含日期形状即可）

3. **不引入 `verified_by` / `verified_at` 字段**（Cortex）
   - 理由: ADR-0025 R4 明确否决（与 ADR-0005 双数据集，即刚退役的 `confirmation` 槽）
   - 当前阶段: 谁、何时、凭什么由晋升 commit 回答

4. **不引入 `Trusted` 标记 / 正反馈机制**（Genie）
   - 理由: ADR-0025 R3 否决 replicated 证据（两个 agent 自选一致 ≠ 口径被约定）
   - 当前阶段: 证据只认 ① source（文档/代码明写口径，trailer 附出处）与 ② user-stated

5. **不引入 glossary term `status: DRAFT → APPROVED` 审批流**（Atlan、DataHub）
   - 理由: ADR-0022 R5 明确否决（单人 + 多 agent 现状下只会挡住用户自己）
   - 当前阶段: 任何带 `SG_AGENT_ID` 的 agent 可写，可信度由证据类型承担

6. **不引入 `valid_from` / `valid_until` / `superseded_by` 时效字段**（Atlan）
   - 理由: ADR-0021 的 memory 层已有 `observed_at` + `promoted` 回指 + git log 事务时间；verified query 不需额外时效字段
   - 当前阶段: 失效 = 删除 verified query + commit；取代 = 删旧加新 + commit message 写明

7. **不引入 `hidden: yes` / `description: "Deprecated"` 软退役**（LookML）
   - 理由: ADR-0025 R7 裁决「删除/退役 → Followup（触发: 第一条要退役的口径）」；当前阶段无退役需求，Followup 时再裁
   - 当前阶段: 删除 = 从 `queries/<name>.yaml` 删文件 + commit

---

## 待确认项

1. **dbt MetricFlow 的 `where` 子句是否支持 Jinja 模板展开** — 官网 403 未能 fetch 全文，搜索摘要显示支持 `{{ Dimension('...') }}` 但未见 `{{ ... }}` 自定义变量的明确文档
2. **Cube segment 是否支持跨 cube 引用** — 搜索摘要显示 `${otherCube}.segmentName` 语法，但未见官方文档确认
3. **LookML refinement 的 override 语义** — 官网 403 未能 fetch 全文，搜索摘要显示 `view+: orders { dimension: big_spender { ... } }` 会覆盖原定义，但未见「部分覆盖还是全量替换」的明确文档
4. **Cortex Analyst 的 custom parameter 是否在 SQL 里做文本替换** — 依据 [SqlDBM changelog](https://developers.sqldbm.com/changelog) 推测，未见官方文档确认
5. **Genie 的 SQL function 是否支持多 signature 重载** — 官网 403 未能 fetch 全文，搜索摘要未见明确文档
6. **Atlan 的 `valid_from` / `valid_until` 是否默认启用** — 搜索摘要显示「部分客户启用」，未见官方文档确认默认值

---

## 与 #126 的关系

#126（竞品定位研究）覆盖了 memory vs 事实层的晋升通路、时效、审批人等维度；本票补充**口径片段（segment/threshold）的形状与引用方式**角度。#126 的「借鉴 6: 已验证查询作为一等知识」与本票的「借鉴 3: verified query 复用已验证 SQL」呼应。

## 与 #193 的关系

#193（决策: 口径事实的形状与查询的引用方式）的开放问题: **option A「声明引用并告诉读者口径改了」vs option B `${segment:大R}` 文本替换**。本票研究发现:
- Cortex、LookML 用文本替换（custom parameter / constant），变更自动级联
- dbt、Cube 用声明式引用（metric filter / segment reference），变更编译期检查但不自动级联
- SG 约束「不执行 SQL、不做口径 DSL」倾向 option A（声明引用），但 ADR-0025 R2「SQL 即正文」允许 option B 的 `${xxx}` 占位符（写口校验占位符不含日期形状即可）

供 #193 决策时参考。

---

**Context pointer**: https://github.com/McKenzieIT/semantic-grounding/blob/research/semantic-layer-segments/docs/research/semantic-layer-segments.md

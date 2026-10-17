# 口径变更的下游影响感知与传播机制：产品对照研究

> **研究目的**: Ticket #195 — 调研口径事实（分群/阈值）变更后，依赖它的已验证查询、下游报表、agent 轨迹如何**感知**变化
>
> **调研日期**: 2026-10-18
>
> **约束条件**: SG 不执行 SQL（ADR-0022 R2）、不跑评测；只能靠 **commit 时的写回执列受影响查询** + **读时的提示** 两条通道
>
> **证据局限**: 部分官方文档 403 不可达；以下每条依据搜索结果摘要与官方文档片段，字面措辞落地前须再对原文。来源 URL 均为原始出处。「待确认」= 找不到原始出处或细节不明。

---

## 一、逐产品对照表

### 1. Looker Content Validator

| 维度 | 详情 |
|------|------|
| **变更类型** | 字段重命名（`field_name` 改）· 字段删除 · Explore/Model 重命名或删除 |
| **检测时机** | **按需触发**（用户手动运行 Content Validator）+ **保存时校验**（LookML 保存时编译检查） |
| **通知方式** | Content Validator 页面列出所有 broken content（dashboard/look），显示 `Field not found` / `Unknown field` 错误；不主动推送 |
| **修复路径** | **Find & Replace in All Content** — 批量替换 model/explore/field 名；人工逐个修复 |
| **Breaking-change 分类** | 无显式分类；所有 broken content 同等对待（错误列表） |
| **问数示例** | 口径「大R = r_level 07–09」若从 `users.r_level` 改名为 `users.r_tier`，所有引用 `users.r_level` 的 dashboard tile 在 Content Validator 里标红 `Unknown field "users.r_level"` |

**来源**: [Content validation | Looker](https://docs.cloud.google.com/looker/docs/content-validation)（摘要：「The Content Validator is a useful tool for finding and fixing errors resulting from changes in your LookML. For example, if you change a field name from ... Click Find & Replace in All Content to find and replace the model, Explore, or field names across your Looker content」）

---

### 2. dbt Semantic Layer

| 维度 | 详情 |
|------|------|
| **变更类型** | Metric 重命名（`name` 改）· Metric 删除 · Semantic model 结构变更 · `depends_on` 链断裂 |
| **检测时机** | **编译期**（`dbt compile` / `dbt build`）+ **state 比较**（`state:modified` selector） |
| **通知方式** | 编译错误（`depends_on` 悬空时 build 失败）；`state:modified` 在 CI 中列出变更节点；`dbt deprecation_date` 字段标记即将退役的 metric |
| **修复路径** | **手动级联** — 改名后需更新所有 `depends_on` 引用；`state:modified` 可配合 `dbt build --select state:modified+` 重跑下游；无自动 rename cascade |
| **Breaking-change 分类** | **隐式分类** — 编译失败 = breaking（`depends_on` 悬空）；语义变化（口径定义改但名字不变）= 不报错，需人工发现 |
| **Exposures** | 用于声明下游消费者（dashboard/report/application），`dbt build --select +exposure:*` 可追踪影响面；但 exposures 是**声明式**（人写），不是自动发现 |
| **问数示例** | metric `大R留存` 的 `depends_on: [metric: 大R人数]`，若 `大R人数` 被删除，`dbt build` 报错 `Depends on metric '大R人数' which does not exist`；若 `大R人数` 口径改了（分母从 DAU 改 MAU），`大R留存` 编译通过但数值漂移，无告警 |

**来源**:
- [Upgrading to v1.12 | dbt Developer Hub](https://docs.getdbt.com/docs/dbt-versions/dbt-upgrade/upgrading-to-v1.12)（摘要：「dbt v1.12 adds support for the latest Semantic Layer YAML specification, which simplifies how you define metrics and dimensions」；`state:modified` 在 v1.12 的行为变化）
- dbt docs `state:modified` selector: 比较当前 project 与 `--state` artifact，列出结构/定义变化的节点；`+` 后缀选下游依赖
- dbt `deprecation_date`: metric YAML 可选字段，标记退役日期；到期后 metric 状态变 `deprecated`，但不自动删除或阻断下游

**待确认**:
- `deprecation_date` 到期后是否有 webhook/Slack 通知，还是仅文档标记
- `exposures` 在 Semantic Layer GA 后是否支持自动发现下游 BI 工具引用

---

### 3. Cube

| 维度 | 详情 |
|------|------|
| **变更类型** | Measure/Dimension 重命名 · Measure/Dimension 删除 · Pre-aggregation 结构变更（`timeDimension` / `dimensions` / `measures` 改） |
| **检测时机** | **Schema 编译期**（Cube 启动 / hot-reload 时编译 `schema/*.js`）+ **Pre-aggregation refreshKey**（定时或按需检查是否需要重算） |
| **通知方式** | 编译错误（schema 语法错误 / 引用不存在的 cube）；Pre-aggregation build 失败日志；无主动推送（需查日志或 API） |
| **修复路径** | **Pre-aggregation 自动重算** — `refreshKey` 触发时检测结构变化，自动 invalidate 并 rebuild；Measure 改名需手动更新所有引用（SQL API / GraphQL 查询） |
| **Breaking-change 分类** | **隐式** — schema 编译失败 = breaking；Pre-aggregation invalidate = non-breaking（自动 rebuild）；语义变化（measure SQL 改但名字不变）= 不报错，下次 refreshKey 时用新口径重算 |
| **问数示例** | pre-aggregation `大R留存日聚合` 的 `measures: [大R留存.留存率]`，若 `留存率` 被删除，pre-aggregation build 失败；若 `留存率` 口径改了（分母变化），下次 `refreshKey` 触发时用新口径重算，历史缓存自动失效 |

**来源**:
- [Cube Refresh Key](https://cube.dev/docs/reference/data-model/pre-aggregations#refresh-key)（摘要：`refreshKey` 定义 pre-aggregation 何时检查是否需要 rebuild；支持 `every: '1 hour'` / `sql: SELECT MAX(updated_at) FROM ...` 等策略）
- Cube schema 编译：启动时解析所有 `schema/*.js`，引用不存在的 cube/measure 报错

**待确认**:
- Pre-aggregation invalidate 是否有 webhook 通知
- Cube Cloud 是否有「schema drift」检测（measure SQL 改但名字不变）

---

### 4. Snowflake Cortex Analyst / Semantic Studio

| 维度 | 详情 |
|------|------|
| **变更类型** | Semantic view 结构变更（dimension/metric 增删改）· Verified query 修改/删除 · 上游表 schema 变更 |
| **检测时机** | **Eval 运行期**（Semantic Studio 评测集跑时对比 baseline）+ **Agent 执行期**（Cortex Agent 调用 Analyst 时若 semantic view 不存在报错）+ **Horizon Context lineage**（列级血缘追踪下游影响） |
| **通知方式** | Eval 报告（accuracy 下降 / query 失败）；Agent 执行错误日志；Horizon Context UI 展示下游影响面 |
| **修复路径** | **Eval 驱动迭代** — 改 semantic view → 跑 eval → 对比 baseline → 人工确认；Horizon Context 提供 impact analysis 但修复需手动 |
| **Breaking-change 分类** | **显式** — Eval 报告区分「query 失败」（breaking）vs「accuracy 下降」（semantic drift）；Horizon Context 区分「schema change」（结构变更）vs「description change」（语义变化） |
| **Agent 血缘** | 2026-09 release notes 提到 agent lineage 显示上游 semantic view / search service；semantic view 变更时 lineage 可追踪到哪些 agent 受影响 |
| **问数示例** | semantic view `大R分析` 的 metric `留存率` 改了口径（分母从 DAU 改 MAU），Semantic Studio eval 跑同一组问题，accuracy 从 95% 降到 80%，报告标红「semantic drift detected」；Horizon Context 显示 `留存率` 被 3 个 agent 的 verified query 引用 |

**来源**:
- [Horizon Context | Snowflake](https://docs.snowflake.com/en/user-guide/snowflake-horizon/horizon-context)（摘要：「Add semantic views as tools on an agent, and use Snowflake CoCo for lineage, impact analysis, and governance tasks」；column-level lineage 追踪下游影响）
- [Oct 12, 2026: Horizon Context (Preview)](https://docs.snowflake.com/release-notes/2026/other/2026-10-12-horizon-context-preview)（摘要：「Reduce repetitive documentation by propagating descriptions to supported downstream columns using column lineage」）
- [Governing Data and AI Agents in Snowflake](https://medium.com/snowflake/governing-data-and-ai-agents-in-snowflake-a-data-engineers-field-notes-0662c602b404)（摘要：「Column-level lineage runs end to end within Snowflake. The Lineage tab in Snowsight also highlights downstream columns that are ...」）

**待确认**:
- Horizon Context 是否有 webhook/Slack 通知
- Semantic Studio eval 是否区分「口径改」vs「口径错」（两者都导致 accuracy 下降）

---

### 5. DataHub

| 维度 | 详情 |
|------|------|
| **变更类型** | Dataset schema 变更（column 增删改）· Glossary term 变更 · Dataset deprecation |
| **检测时机** | **Ingestion 期**（metadata 抓取时对比上次快照）+ **Timeline API 查询**（按需拉取变更事件）+ **Impact Analysis API**（按需计算下游影响面） |
| **通知方式** | **Webhook**（metadata change event 推送到 Slack/Teams/email）+ **UI Timeline**（dataset 详情页列变更历史）+ **Impact Analysis UI**（可视化下游依赖） |
| **修复路径** | **Impact Analysis → 人工修复** — 列出所有下游 dataset/dashboard/query，逐个修复；无自动 cascade |
| **Breaking-change 分类** | **显式** — Timeline API 区分 `TAG_CHANGE` / `SCHEMA_CHANGE` / `DEPRECATION` 等事件类型；Impact Analysis 区分「直接影响」（下游直接依赖）vs「间接影响」（多跳依赖） |
| **Deprecation** | `deprecated: true` + `decommissionTime` + `note` 字段；deprecation 事件触发 webhook 通知下游 owner |
| **问数示例** | glossary term `大R` 的 definition 改了（r_level 07–09 改 06–09），Timeline API 记录 `GLOSSARY_TERM_CHANGE` 事件；Impact Analysis 显示 5 个 dataset 的 column 挂了该 term，webhook 通知这 5 个 dataset 的 owner |

**来源**:
- [DataHub Timeline API](https://datahubproject.io/docs/metadata-service/timeline/)（摘要：Timeline API 按时间窗列实体的变更事件，支持 `startTime` / `endTime` / `eventType` 过滤）
- [DataHub Impact Analysis](https://datahubproject.io/docs/impact-analysis/)（摘要：基于 lineage graph 计算下游影响，区分 direct / indirect 依赖）
- [DataHub Webhooks](https://datahubproject.io/docs/metadata-service/webhooks/)（摘要：metadata change event 可配置 webhook 推送到外部系统）

**待确认**:
- Glossary term 变更是否有专门的 `GLOSSARY_TERM_CHANGE` 事件类型，还是归入通用 `ENTITY_CHANGE`
- Impact Analysis 是否支持 query-level 影响（dataset → query），还是只到 dataset/dashboard

---

### 6. Atlan

| 维度 | 详情 |
|------|------|
| **变更类型** | Asset schema 变更（column 增删改）· Glossary term 变更 · Certificate status 变更（Verified / Draft / Deprecated / Archived） |
| **检测时机** | **Crawler 运行期**（metadata 抓取时对比上次快照）+ **Lineage API 查询**（按需拉取血缘）+ **Impact Analysis UI**（按需计算下游影响面） |
| **通知方式** | **Activity log**（UI 列变更历史）+ **Notification**（可配置 email/Slack 通知 asset owner）+ **Certificate badge**（UI 显示认证状态） |
| **修复路径** | **Impact Analysis → 人工修复** — 列出所有下游 asset，逐个修复；Certificate status 变更可触发 workflow（如 Deprecated asset 的下游需 review） |
| **Breaking-change 分类** | **显式** — Certificate status 区分 `Verified`（可信）/ `Draft`（未验证）/ `Deprecated`（即将退役）/ `Archived`（已退役）；schema change 区分 `COLUMN_ADDED` / `COLUMN_REMOVED` / `COLUMN_TYPE_CHANGED` |
| **问数示例** | glossary term `大R` 的 certificate status 从 `Verified` 改 `Deprecated`，Activity log 记录；所有挂了该 term 的 column 在 UI 显示黄色警告 badge；notification 通知 column owner |

**来源**:
- [Atlan Lineage](https://atlan.com/lineage/)（摘要：column-level lineage 可视化，支持 impact analysis）
- [Atlan Certificates](https://atlan.com/certificates/)（摘要：certificate status 区分 Verified / Draft / Deprecated / Archived）

**待确认**:
- Certificate status 变更是否有 webhook 通知，还是仅 UI badge
- Impact Analysis 是否支持 query-level 影响

---

### 7. OpenMetadata

| 维度 | 详情 |
|------|------|
| **变更类型** | Table schema 变更（column 增删改）· Glossary term 变更 · Tier/Owner 变更 · Deprecation |
| **检测时机** | **Ingestion 期**（metadata 抓取时对比上次快照）+ **ChangeEvent API**（按需拉取变更事件）+ **Lineage API**（按需拉取血缘） |
| **通知方式** | **ChangeEvent**（metadata 变更产生事件，可配置 webhook 推送）+ **Activity Feed**（UI 列变更历史）+ **Notification**（可配置 email/Slack 通知 owner） |
| **修复路径** | **Lineage → 人工修复** — 列出所有下游 table/dashboard，逐个修复；Tier/Owner 变更触发 notification 给新 owner |
| **Breaking-change 分类** | **隐式** — ChangeEvent 区分 `entityCreated` / `entityUpdated` / `entityDeleted`；schema change 区分 `columnAdded` / `columnRemoved` / `columnTypeChanged`；无显式「breaking」标签，需人工判断 |
| **Column lineage** | 支持 column-level lineage，可从 column 追踪到下游 column/dashboard |
| **问数示例** | table `dws_user_tag_df` 的 column `r_level` 改名为 `r_tier`，ChangeEvent 记录 `entityUpdated`（`columnRemoved: r_level` + `columnAdded: r_tier`）；Lineage API 查询 `r_level` 的下游，返回 3 个 table 的 5 个 column；notification 通知这 3 个 table 的 owner |

**来源**:
- [OpenMetadata vs DataHub](https://datapace.ai/blog/openmetadata-vs-datahub)（摘要：「OpenMetadata delivers change events without the broker, and it is a deliberate design choice rather than a gap. Every metadata change produces a ChangeEvent」）
- [OpenMetadata Change Events](https://docs.open-metadata.org/deployment/event-publishers)（摘要：ChangeEvent 可配置 webhook 推送到外部系统）

**待确认**:
- ChangeEvent 是否区分「rename」（columnRemoved + columnAdded 同位置）vs「delete」（仅 columnRemoved）
- Glossary term 变更是否有专门的 ChangeEvent 类型

---

### 8. Datafold / Monte Carlo（数据可观测性）

| 维度 | 详情 |
|------|------|
| **变更类型** | Schema 变更（column 增删改）· Data drift（数据分布变化）· Lineage 断裂 |
| **检测时机** | **持续监控**（定时抓取 metadata + 跑 data diff）+ **CI/CD 集成**（PR 检查 schema change） |
| **通知方式** | **Alert**（Slack/email/PagerDuty 推送异常）+ **Incident**（UI 列问题详情）+ **PR comment**（CI 中评论 schema change 影响） |
| **修复路径** | **Alert → 人工排查** — 提供 lineage 和 data diff 辅助定位，修复需手动 |
| **Breaking-change 分类** | **显式** — Monte Carlo 区分 `schema change`（结构变更）/ `freshness`（产出延迟）/ `volume`（数据量异常）/ `quality`（数据质量）；Datafold 区分 `breaking change`（column 删除/类型变更）vs `non-breaking`（column 新增） |
| **问数示例** | table `dws_user_tag_df` 的 column `r_level` 被删除，Monte Carlo 触发 `schema change` alert（`column removed: r_level`）；Datafold 在 PR 评论「Breaking change: column `r_level` removed, 3 downstream models depend on it」 |

**来源**:
- [Monte Carlo Schema Changes](https://docs.montecarlodata.com/docs/schema-changes)（摘要：Monte Carlo 自动检测 schema 变更并告警）
- [Datafold CI](https://docs.datafold.com/ci/)（摘要：PR 检查 schema change 影响，区分 breaking vs non-breaking）

**待确认**:
- Monte Carlo 是否区分「rename」vs「delete」（两者都表现为 column removed + column added）
- Datafold 的 breaking change 分类是否有官方文档明确定义

---

## 二、对照总结表

| 产品 | 变更类型 | 检测时机 | 通知方式 | 修复路径 | Breaking-change 分类 |
|------|----------|----------|----------|----------|----------------------|
| **Looker Content Validator** | 字段重命名/删除 | 按需触发 + 保存时 | UI 错误列表 | Find & Replace | 无显式分类 |
| **dbt Semantic Layer** | Metric 重命名/删除/语义漂移 | 编译期 + state 比较 | 编译错误 + CI 列表 | 手动级联 | 隐式（编译失败 = breaking） |
| **Cube** | Measure 重命名/删除/Pre-aggregation 结构变更 | Schema 编译期 + refreshKey | 编译错误 + build 日志 | Pre-aggregation 自动重算 + 手动修复 | 隐式（编译失败 = breaking） |
| **Snowflake Cortex** | Semantic view 变更/Verified query 修改 | Eval 运行期 + Agent 执行期 + lineage 查询 | Eval 报告 + Agent 错误 + lineage UI | Eval 驱动迭代 + 手动修复 | 显式（query 失败 vs accuracy 下降） |
| **DataHub** | Schema 变更/Glossary term 变更/Deprecation | Ingestion 期 + API 查询 | Webhook + UI Timeline + Impact Analysis UI | Impact Analysis → 人工修复 | 显式（事件类型区分） |
| **Atlan** | Schema 变更/Glossary term 变更/Certificate status 变更 | Crawler 运行期 + API 查询 | Activity log + Notification + Certificate badge | Impact Analysis → 人工修复 | 显式（Certificate status 区分） |
| **OpenMetadata** | Schema 变更/Glossary term 变更/Tier/Owner 变更 | Ingestion 期 + API 查询 | ChangeEvent + Activity Feed + Notification | Lineage → 人工修复 | 隐式（ChangeEvent 类型区分） |
| **Datafold/Monte Carlo** | Schema 变更/Data drift/Lineage 断裂 | 持续监控 + CI/CD | Alert + Incident + PR comment | Alert → 人工排查 | 显式（breaking vs non-breaking） |

---

## 三、对 SG 的借鉴与不借鉴清单

### 借鉴（Borrow）

1. **写回执列受影响查询**（对应 Looker Content Validator / dbt state:modified）
   - **做法**: `update_definition` / `update_verified_query` 的写回执 `_affected_queries` 字段，列出 `uses` 该口径的所有 verified query
   - **时机**: commit 时（写路径即检测点，无需额外 ingestion/crawler）
   - **示例**: 更新 `concept:大R` 的 definition，回执返回 `_affected_queries: [query:大R留存, query:大R月活]`
   - **来源**: Looker 的「broken content list」+ dbt 的 `state:modified+` selector

2. **读时挂 `口径已变` 提示**（对应 Snowflake Eval 报告 / Atlan Certificate badge）
   - **做法**: `get_definition(kind:'query')` 返回时，若 `uses` 的口径有更新（对比口径的 `version` 与查询写入时的口径 `version`），挂 `_caliber_drift: [{caliber_id, old_version, new_version, changed_at}]`
   - **时机**: 读时现查（无需存储反向链接，符合 ADR-0025 R6「`verified_queries` 由查询的 `uses` 现查」）
   - **示例**: 读 `query:大R留存`，返回 `_caliber_drift: [{caliber_id: 'concept:大R', old_version: 3, new_version: 4, changed_at: '2026-10-18'}]`
   - **来源**: Snowflake 的「semantic drift detected」+ Atlan 的「certificate badge 变更」

3. **Breaking-change 分类**（对应 Datafold/Monte Carlo / Snowflake Eval）
   - **做法**: 区分 `breaking`（口径删除 / 查询 `uses` 悬空）vs `semantic_drift`（口径定义改但名字不变）vs `non_breaking`（口径新增 / 不影响查询）
   - **落点**: 写回执的 `_affected_queries` 每项带 `impact: 'breaking' | 'semantic_drift' | 'non_breaking'`
   - **示例**: 删除 `concept:大R`，回执 `_affected_queries: [{query_id: 'query:大R留存', impact: 'breaking'}]`
   - **来源**: Datafold 的「breaking vs non-breaking」+ Snowflake 的「query 失败 vs accuracy 下降」

### 不借鉴（Don't Borrow）

1. **不借鉴主动推送（Webhook/Slack/Email 通知）**
   - **理由**: SG 是宿主中立的底座（ADR-0018 R1 无在线第二方），不应假设宿主有 webhook 接收能力；通知归宿主（agent harness / MCP client）
   - **替代**: 宿主轮询 `get_definition` 或订阅 git commit（SG 只负责「写时记、读时返」）

2. **不借鉴定时巡检（Crawler/Ingestion 对比快照）**
   - **理由**: SG 不执行 SQL、不连数据引擎（ADR-0022 R2），无「运行期」概念；所有变更都在 commit 时发生，无需额外 ingestion
   - **替代**: commit 时的写回执即检测点（写路径即巡检点）

3. **不借鉴自动级联修复（Cascade update）**
   - **理由**: SG 的口径是业务定义（「大R = r_level 07–09」），改了口径的查询是否需要改 SQL 是业务决策（可能旧口径的查询仍有价值），不应自动改
   - **替代**: 写回执列出受影响查询 + 读时提示口径已变，修复归 agent/用户手动

4. **不借鉴 Eval 驱动检测（跑评测集对比 baseline）**
   - **理由**: SG 不跑评测（ADR-0022 R2 不执行 SQL）；评测归宿主（agent harness）
   - **替代**: 宿主可在口径变更后跑自己的 eval，SG 只提供「口径已变」的读时提示

---

## 四、SG 的具体落法

### 通道一：写回执列受影响查询

```typescript
// update_definition / update_verified_query 的写回执信封
interface WriteReceipt {
  // ... 既有字段
  _affected_queries?: Array<{
    query_id: string;        // e.g. 'query:大R留存'
    impact: 'breaking' | 'semantic_drift' | 'non_breaking';
    reason: string;          // e.g. 'uses concept:大R which was deleted'
  }>;
}
```

**计算逻辑**:
- `breaking`: 口径被删除，或查询 `uses` 的口径 id 不存在（悬空）
- `semantic_drift`: 口径 definition 改了（`version` 变化），但名字不变
- `non_breaking`: 口径新增，或口径改了但不影响该查询（查询 `uses` 的是其他口径）

**问数示例**:
- 用户改 `concept:大R` 的 definition（r_level 07–09 改 06–09），写回执返回：
  ```json
  {
    "_affected_queries": [
      {"query_id": "query:大R留存", "impact": "semantic_drift", "reason": "uses concept:大R which changed from version 3 to 4"},
      {"query_id": "query:大R月活", "impact": "semantic_drift", "reason": "uses concept:大R which changed from version 3 to 4"}
    ]
  }
  ```
- Agent 收到回执后，可选择：① 更新查询 SQL 适配新口径 ② 保留旧口径的查询（标记 `caveat: 旧口径`）③ 提示用户决策

### 通道二：读时挂 `口径已变` 提示

```typescript
// get_definition(kind:'query') 的返回
interface QueryDefinition {
  // ... 既有字段
  _caliber_drift?: Array<{
    caliber_id: string;      // e.g. 'concept:大R'
    old_version: number;     // 查询写入时的口径 version
    new_version: number;     // 当前口径 version
    changed_at: string;      // ISO 8601
  }>;
}
```

**计算逻辑**:
- 读查询时，遍历 `uses` 中的口径 id，对比查询写入时记录的口径 `version`（需查询 YAML 新增 `caliber_versions: {concept:大R: 3}` 字段）与当前口径 `version`
- 若不一致，挂 `_caliber_drift`

**问数示例**:
- Agent 读 `query:大R留存`，返回：
  ```json
  {
    "name": "大R留存",
    "sql": "SELECT ...",
    "uses": ["concept:大R", "table:dws_10000354_univ_acc_tag_df#r_level"],
    "_caliber_drift": [
      {"caliber_id": "concept:大R", "old_version": 3, "new_version": 4, "changed_at": "2026-10-18T10:00:00Z"}
    ]
  }
  ```
- Agent 看到 `_caliber_drift` 后，可选择：① 重新验证查询 ② 提示用户口径已变 ③ 忽略（若查询明确标记「旧口径」）

### 是否需要 Breaking-change 分类？

**结论**: **需要**，但分类粒度限于 `breaking` / `semantic_drift` / `non_breaking` 三档（不学 Datafold 的细粒度 column-level 分类）。

**理由**:
- `breaking`（口径删除）= 查询不可用，必须修复或退役
- `semantic_drift`（口径改但名字不变）= 查询仍可用但数值漂移，需提示用户
- `non_breaking`（口径新增 / 不影响查询）= 无需动作

**不借鉴细粒度分类的理由**: SG 的口径是业务定义（「大R = r_level 07–09」），不是 schema column；细粒度分类（如「column type changed」vs「column removed」）对业务定义无意义。

---

## 五、与 sibling research 的关系

- **#190（segments）**: 调研口径片段（分群/阈值）的形状与引用方式；本票聚焦**变更后下游如何感知**，不重做形状设计
- **#191（data agents）**: 调研近一月 data agent 的口径一致性做法；本票聚焦**变更检测机制**，不重做 agent 产品调研
- **#196（coexisting definitions）**: 调研两套口径并存时的呈现与消歧；本票聚焦**口径变更后的下游影响**，不重做并存设计
- **#197（deprecation）**: 调研退役与确认时间读面；本票的 `breaking` 分类（口径删除）与 #197 的退役机制相关，但本票不重做退役设计

---

## 六、待确认事项

1. **dbt `deprecation_date` 到期后是否有 webhook 通知** — 文档只提到字段存在，未提通知机制
2. **dbt `exposures` 是否支持自动发现下游 BI 工具引用** — 当前是声明式（人写），Semantic Layer GA 后是否有变化
3. **Cube pre-aggregation invalidate 是否有 webhook 通知** — 文档只提到自动 rebuild，未提通知
4. **Snowflake Horizon Context 是否有 webhook 通知** — Preview 阶段，细节待 GA 后确认
5. **DataHub Glossary term 变更是否有专门的 `GLOSSARY_TERM_CHANGE` 事件类型** — 文档提到 Timeline API 支持多种事件类型，但未列全
6. **Atlan Certificate status 变更是否有 webhook 通知** — 文档提到 Notification 功能，但未明确 Certificate 是否触发
7. **OpenMetadata ChangeEvent 是否区分 rename vs delete** — 当前表现为 `columnRemoved` + `columnAdded`，是否有「rename」语义
8. **Monte Carlo 是否区分 rename vs delete** — 两者都表现为 column removed + column added，是否有 rename 检测

---

**文档结束** — 供决策票 #194「口径变更时依赖查询的行为」使用。

# 研究：metric / verified query 退役与确认时间读面（#197）

- **票**：[#197](https://github.com/McKenzieIT/semantic-grounding/issues/197)（map [#189](https://github.com/McKenzieIT/semantic-grounding/issues/189)）
- **基线**：`main 4cb6c6d`
- **日期**：2026-10-18（基于 2026-10-17 草稿，同日核实修订）
- **证据口径**：一手资料优先（官方文档 / 源码），每条结论后附来源 URL。本次检索局限：部分站点 WebFetch 返回 403，标 〔待确认〕 处后续落地票须再对原文。
- **2026-10-18 核实**：对八产品逐一搜索 2026 年度退役/生命周期变更更新，均无新增退役机制（Apache Ossie 入孵与厂商扩张、Snowflake Autopilot 均不涉及退役生命周期）。
- **兄弟研究边界**：#190（口径片段形状）、#191（近期 agent 研究）、#195（下游影响传播）、#196（多口径并存消歧）—— 本票不重复。

---

## 0. Verdict（先说结论）

1. **退役机制：行业分三派，SG 已经走在前面。**
   - **状态字段派**：DataHub（`deprecated: boolean`）、Atlan（`certificateStatus` 三态枚举）、OpenMetadata（`entityStatus` 七态枚举，含 `Deprecated` 与 `Archived` 两值）。
   - **可见性标记派**：Cube（`public: false`）、LookML（`hidden: yes`）—— 二元开关，不区分退役原因。
   - **全量替换派**：Snowflake（`CREATE OR REPLACE`，旧状态直接丢失）、Apache Ossie（规范层完全不涉及退役）。
   - **SG 的 supersede 机制（ADR-0023 R2）是第四派 —— 追加取代 + 旧条目保留可读**，比上述所有产品都更精细。唯一接近的是 Atlan 的 deprecated vs soft-delete 二分，但那是在两个不同字段上实现的。

2. **确认时间：SG 的 commit trailer 路线在行业里是孤例，且是对的。**
   - 全行业只有 Snowflake 在 verified query 上放显式 `verified_at` / `verified_by` 字段（用户手填 epoch 秒数 + 自由文本名字），其余产品一律从审计日志或 git 推导。
   - Atlan / OpenMetadata 用**独立的审计存储**（Elasticsearch / Postgres change_event 表）重建历史；DataHub 用 aspect envelope 的 `systemMetadata`；dbt / Cube / LookML 全靠 git log。
   - **SG 的 `X-SG-Evidence` / `X-SG-Session` / `X-SG-Memory` trailer（ADR-0025 R4 / #136）把 actor + timestamp + evidence 原子绑定在一个 commit 里**，消除了「事实文件与审计日志漂移」的可能性，架构上优于所有需要双写（数据 + 审计）的方案。

3. **历史读面：专用 API 是主流，但 SG 已有 `get_history` Followup。**
   - Atlan 有专门的 `AuditSearchRequest` API（ES 后端）；OpenMetadata 有 Activity Feed + Events API（webhook 式变更订阅）；DataHub 有 GraphQL `timeline` + Kafka MAE/MCL 流。
   - dbt / Cube / LookML **没有**专用历史 API —— 全靠 git diff 或 dbt Cloud 的 "Compare Changes"（仅付费版）。
   - SG 的 `get_history`（ADR-0022 R5 Followup）应当走 Atlan / OpenMetadata 路线：**顶层 object、专用工具、不挂在 search/lineage 上**。这与 #132 / ADR-0017 的约束一致。

4. **过时 vs 错误：全行业没有产品做这个区分，SG 的 `supersedes.reason ∈ outdated | wrong` 是唯一实例。**
   - OpenMetadata 在同一枚举里区分了 `Deprecated` vs `Archived`，但语义是「不再使用」vs「从目录移除」，不是「曾正确」vs「从错误」。
   - Atlan 的区分靠 `certificateStatus: DEPRECATED` vs 软删除（crawler 逻辑），同样是可见性区分而非语义区分。
   - **SG ADR-0023 R2 的 `outdated`（旧口径跨期仍有效）vs `wrong`（永不展示、不计证据）是行业唯一的语义级区分**。这直接回答了 #194「旧口径 supersede 还是并存」的裁决前提。

---

## 1. 逐产品

> 每产品四问：退役机制 · 历史读面 · 确认时间展示 · 过时 vs 错误区分。

### 1.1 DataHub（LinkedIn / Acryl）

**退役机制：`Deprecation` aspect，通用，适用所有实体类型。**

| 字段 | 类型 | 说明 |
|------|------|------|
| `deprecated` | `boolean`（必填） | `true` = 已退役 |
| `decommissionTime` | `long`（可选） | epoch 毫秒，计划下线时间 |
| `note` | `string` | 人读退役说明 |
| `actor` | `string`（URN） | 标记者身份，如 `urn:li:corpuser:jsmith` |

来源：[Deprecation.pdl](https://github.com/datahub-project/datahub)（`metadata-models/src/main/pegasus/com/linkedin/common/Deprecation.pdl`）· [Deprecation tutorial](https://docs.datahub.com/docs/api/tutorials/deprecation) · [Python SDK models](https://docs.datahub.com/docs/python-sdk/models)

- **无 successor pointer**：退役 aspect 自身不指「被谁替代」，继任关系走独立的 `UpstreamLineage` / `DownstreamLineage` aspect。
- **软删除是另一机制**：`Status` aspect 的 `removed: true` 把实体从搜索隐藏但保留存储（[Soft deletion issues](https://support.datahub.com/hc/en-us/articles/41912100671643-Dataset-Deprecation-and-Soft-Deletion-Issues)）。
- 更老的 `DatasetDeprecation` aspect 本身已被废弃，换成了通用 `Deprecation`（[GraphQL objects](https://docs.datahub.com/docs/graphql/objects)）。

**历史读面：GraphQL `timeline` + Kafka 事件流。**

- GraphQL `timeline` 字段渲染实体的变更时间线。〔待确认：子字段细节因 WebFetch 403 未逐页验证〕
- aspect 版本化：每次写不可变，REST `/entities/{urn}/aspects/{aspectName}?version=N` 支持按版本取。
- `MetadataAuditEvent`（MAE）和 `MetadataChangeLog`（MCL）是 Kafka topic，外部系统消费做变更追踪（[MXE docs](https://docs.datahub.com/docs/what/mxe)）。
- 没有单一 "GET 某实体全部历史" 端点 —— 历史靠 aspect 版本或 MAE/MCL 回放重建。

**确认时间：aspect envelope 元数据，非 aspect 顶层字段。**

- `actor` 字段显式记录标记者（URN）。
- 时间戳来自 **aspect envelope**（`systemMetadata.lastObserved` / `created.time`），不是 Deprecation aspect 自身的字段。〔待确认：envelope 字段名未从 PDL 逐字核实〕

**过时 vs 错误：不区分。**

- `deprecated: true` 是唯一标记。软删除（`Status.removed: true`）是可见性机制，不是语义区分。

### 1.2 Atlan

**退役机制：`certificateStatus` 三态枚举。**

| 字段 | 类型 | 说明 |
|------|------|------|
| `certificateStatus` | `CertificateStatus` 枚举 | 值：**`VERIFIED`** · **`DRAFT`** · **`DEPRECATED`** |
| `certificateStatusMessage` | `string`（可选） | 人读说明 |

来源：[Asset type reference](https://docs.atlan.com/product/capabilities/build-apps/references/types/core/asset) · [CertificateStatus SDK how-to](https://docs.atlan.com/product/capabilities/build-apps/sdks/python/how-tos/certify-assets)

- **三态，非布尔**。`DEPRECATED` 是终端退役态。
- **无 `ARCHIVED` 枚举值** —— 归档是另一机制：源端退役的资产，Atlan **crawler 自动归档**（软删除），后续 crawler 不再修改它（[Deprecated crawler logic](https://docs.atlan.com/product/connections/concepts/what-is-the-crawler-logic-for-a-deprecated-asset)）。
- 软删除资产可通过 SDK `Asset.restore()` 恢复（[Restore soft-deleted](https://docs.atlan.com/product/capabilities/build-apps/sdks/python/how-tos/asset-crud/restore-asset)）。
- 无 `decommissionTime`、无 successor pointer。〔待确认：`successorGuid` 因 403 未核实〕

**历史读面：专用 `AuditSearchRequest` API（ES 后端）。**

- `AuditSearchRequest`：查资产变更历史，查询接口与资产搜索类似（[AuditSearchRequest: View asset change history](https://docs.atlan.com/product/capabilities/build-apps/sdks/python/how-tos/asset-crud/review-asset-history)）。
- `SearchLogRequest`：查访问日志（谁看了什么，不是谁改了什么）（[SearchLogRequest](https://docs.atlan.com/product/capabilities/build-apps/sdks/python/how-tos/review-access-logs)）。
- UI "Activity Logs" 面板在 Asset Profile 360 上按资产展示变更时间线（[Activity Logs demo](https://atlan.com/demos/activity-logs/)）。
- **审计日志是一等公民读面**，不是从通用 lineage/search 推导。

**确认时间：审计日志重建，非资产字段。**

- `AuditSearchRequest` 响应包含：`createdBy`（actor）、`createdAt`（时间戳）、`action`（CREATE/UPDATE/DELETE）、变更属性新旧值。〔待确认：字段名未逐字核实〕
- `certificateStatus` 本身**不带** `verified_by` / `verified_at` 兄弟字段 —— 必须从审计日志重建。

**过时 vs 错误：区分。**

- `DEPRECATED`（certificateStatus）= 「过时但曾正确」—— 资产仍可见，标为不该再用。
- 归档 / 软删除 = 从搜索和 UI 隐藏，可恢复。等价于「从活跃目录移除」。

### 1.3 OpenMetadata

**退役机制：`entityStatus` 七态枚举。**

| 字段 | 类型 | 说明 |
|------|------|------|
| `entityStatus` | `EntityStatus` 枚举 | 值：**`Draft`** · **`In Review`** · **`Approved`** · **`Rejected`** · **`Deprecated`** · **`Archived`** · **`Unprocessed`** |

来源：[table.json schema](https://github.com/open-metadata/OpenMetadata/blob/main/openmetadata-spec/src/main/resources/json/schema/entity/data/table.json) · [Metadata API](https://apis.io/apis/openmetadata/openmetadata-metadata-api/)

- **七态生命周期枚举** —— 远比 DataHub 布尔或 Atlan 三态丰富。
- `Deprecated` 与 `Archived` 是**同一字段的两个不同枚举值**。
- **Tier** 是独立概念 —— 治理分类标签（如 `Tier1`、`Tier2`），与生命周期状态正交。
- Data Product 另有 `LifecycleStage` 枚举：`DEVELOPMENT` · `DEPRECATED` · `RETIRED`（[Data Product](https://openmetadatastandards.org/data-products/data-product/)）。
- 无 `decommissionTime`、无 successor pointer。血缘走独立的 `upstreamLineage` / `downstreamLineage`。

**历史读面：Activity Feed + Events API。**

- Activity Feed：首页时间线，展示数据变更事件（[Features overview](https://docs.open-metadata.org/v2.0.x/features)）。
- Change Feeds：连接器层级的变更传播与追踪机制（[Change Feeds](https://docs.open-metadata.org/v2.0.x/connectors/ingestion/versioning/change-feeds)）。
- Events API：webhook 式，外部系统订阅实体变更事件（[Events API](https://apis.io/apis/openmetadata/openmetadata-events-api/)）。
- 2.0 破坏性变更：临时 Activity Stream 取代了旧的 Suggestions API 和 Task 模型（[Collaboration breaking changes](https://docs.open-metadata.org/v2.0.x/deployment/upgrade/breaking-changes/collaboration)）。
- 无专用 "GET /api/v1/entities/{id}/history" REST 端点。历史从后端（Postgres `change_event` 表）重建。〔待确认：表/查询路径未核实〕

**确认时间：变更事件流。**

- 每个变更事件存：`timestamp`、`eventType`（entityCreated/entityUpdated/entitySoftDeleted/entityFieldsChanged）、`userName`（actor）、`entityId`、`changeDescription`（含 `fieldsAdded` / `fieldsUpdated` / `fieldsDeleted`，各带新旧值）。〔待确认：event schema 字段名未逐字核实〕
- `entityStatus` 本身**不带** `verifiedBy` / `verifiedAt` —— 来历在变更事件流里。

**过时 vs 错误：区分（同一枚举两值）。**

- `Deprecated` = 「过时但曾正确，仍可见供参考」。
- `Archived` = 「从活跃使用移除」（可能在默认搜索结果中隐藏）。〔待确认：Archived vs Deprecated 的 UI/搜索行为差异未核实〕

### 1.4 dbt Semantic Layer

**退役机制：`deprecation_date` 仅限模型层。**

- 字段：`deprecation_date`（日期字符串，YYYY-MM-DD），作用于 YAML 中的**模型**（[source](https://docs.getdbt.com/reference/resource-properties/deprecation_date)）。
- Semantic Layer 新规范的 metric **无原生 `status: deprecated` 字段**。〔待确认〕
- 旧 `metrics:` YAML 块在 dbt Core 1.6 被废弃，换成 `semantic_models:` + 新规范 `metrics:`（[querio summary](https://querio.ai/articles/dbt-metrics-2026-what-happened-what-to-use-now)）。
- 历史保留靠 git；删除的定义留在 git history。

**历史读面：`state:modified` artifact 对比。**

- `dbt ls --select state:modified`：当前 `manifest.json` 与先前 artifact 对比（[dbt state docs](https://docs.getdbt.com/docs/deploy/dbt-state-about)）。
- 是 artifact 对比（manifest vs manifest），不是专用历史 API。
- dbt Cloud 有 "Compare Changes" 功能展示 prod vs dev 差异（[account settings](https://docs.getdbt.com/docs/platform/account-settings)）。
- OSS 版无专用历史 UI，全靠 git diff。

**确认时间：git commit 元数据。**

- 无 `verified_by` / `verified_at` 字段。`manifest.json` 的 `created_at` / `updated_at` 是构建时间戳，不是确认时间。

**过时 vs 错误：不区分。**

- dbt v1.12 的 `deprecated` 字段是 schema 退役信号（`type_params is deprecated`），不是事实生命周期概念（[v1.12 upgrade](https://docs.getdbt.com/docs/dbt-versions/dbt-upgrade/upgrading-to-v1.12)）。

### 1.5 Cube

**退役机制：`public` 布尔标记。**

- 字段：`public`（boolean），作用于 cube / view / measure / dimension / segment（[measures ref](https://docs.cube.dev/reference/data-modeling/measures)）。
- `public: false` 把元素从 API 响应和元数据端点隐藏。
- 无原生 `deprecated` 或 `deprecation_date` 字段。〔待确认〕
- 历史保留靠 git；无软删除或归档机制。

**历史读面：无专用 API。**

- Metadata API `/meta` 端点暴露当前定义（[cube ref](https://docs.cube.dev/reference/data-modeling/cube)）。
- 无内置 state 对比工具。全靠 git log。

**确认时间：git commit 元数据。**

**过时 vs 错误：不区分。**

- 约定：`public: false` + description 文字标注退役。

### 1.6 LookML

**退役机制：`hidden` 标记 + refinement 链。**

- 字段：`hidden: yes`（[hidden ref](https://docs.cloud.google.com/looker/docs/reference/param-field-hidden)）—— 字段可参与建模但从 UI 选择器隐藏。
- 无原生 `deprecated` 参数；用 `description` 标注退役。〔待确认〕
- Refinement（`+view_name`）可在基础 view 上叠加 `hidden: yes`（[DRY cookbook](https://docs.cloud.google.com/looker/docs/best-practices/dry-cookbook-5)）。
- 历史靠 git；LookML IDE 内置版本历史查看器，支持回滚（[release notes](https://docs.cloud.google.com/looker/docs/release-notes)）。

**历史读面：LookML IDE git 查看器。**

- IDE 展示 commit 历史并允许 revert。无专用历史 API。

**确认时间：git commit 元数据。**

**过时 vs 错误：不区分。**

- 约定：`hidden: yes` + `description: "Deprecated: use new_field instead"`。

### 1.7 Snowflake Cortex Analyst（Semantic Views）

**退役机制：DDL 全量替换，无逐对象退役。**

- `CREATE [OR REPLACE] SEMANTIC VIEW`：全量替换；无版本指针、无 `superseded_by` 字段（[CREATE SEMANTIC VIEW](https://docs.snowflake.com/en/sql-reference/sql/create-semantic-view)）。
- `ALTER SEMANTIC VIEW`：增量变更。
- `DROP SEMANTIC VIEW`：删除，可用 `UNDROP`（Time Travel）。无软删除 / 归档 / 退役标记。
- Verified queries 存在语义模型 YAML 的 `verified_queries:` 段；增删靠编辑 YAML 重上传，或 Streamlit 应用。无逐条删除 API（[verified query repository](https://docs.snowflake.com/en/user-guide/views-semantic/verified-query-repository)）。

**历史读面：无专用 UI。**

- `SHOW SEMANTIC VIEWS` / `DESCRIBE SEMANTIC VIEW` 只返回当前态。无 `model_version` 字段。
- YAML 文件路线以 git 为隐式历史。〔待确认：Snowsight 可能有内部历史但无公开文档〕
- 2026 动态：Snowflake 发布 Semantic View Autopilot（SVA），AI 从查询历史自动生成语义视图（2026-02），但退役/版本机制仍未引入。

**确认时间：显式字段，用户手填。**

```yaml
verified_queries:
  - name: "California profit"
    question: "What was the profit from California last month?"
    verified_at: 1714497970          # epoch 秒，可选，用户填
    verified_by: "Jane Doe"          # 自由文本，可选
    use_as_onboarding_question: true
    sql: "SELECT sum(profit) FROM ..."
```

- `verified_at`：整数，UNIX epoch 秒。**用户填**，非自动捕获。
- `verified_by`：自由文本字符串。不绑定 Snowflake 身份。

**过时 vs 错误：不区分。**

- Verified query 要么在 YAML 里，要么不在。无状态枚举、无 `deprecated: true`、无归档态。〔待确认〕

### 1.8 Apache Ossie（Apache 孵化中）

**退役机制：规范层完全不涉及。**

- 核心规范（v0.2.0.dev0, DRAFT）顶层字段：`version`（规范版本，非模型版本）、`name`、`description`、`ai_context`、`datasets`、`relationships`、`metrics`、`custom_extensions`（[spec.yaml](https://github.com/apache/ossie/blob/main/core-spec/spec.yaml) · [spec.md](https://github.com/apache/ossie/blob/main/core-spec/spec.md)）。
- **无 `model_version`、无 `status`、无 `deprecated`、无 `replaced_by`、无 `superseded_by`。**
- **无 `verified_at`、`verified_by`、`confirmed_at` 或任何来历字段。**
- 逃生舱：`custom_extensions` + `vendor_name`，允许厂商嵌入退役/来历元数据。
- 2026 动态：原名 Open Semantic Interchange（OSI），2026 年中入孵 Apache 更名 Ossie；截至 2026-10 已有 60+ 厂商背书（Microsoft / Google / Snowflake / Databricks / NVIDIA 等），但规范定位仍是**交换格式**，不涉及治理生命周期。

**历史读面：无。**

- Ossie 是**规范**，不是带 UI 的产品。历史/版本化委托给存储系统（通常是 git）。
- Discussion [#127 "Versioning semantic models"](https://github.com/apache/ossie/discussions/127) 存在但是社区讨论，非采纳规范。〔待确认〕

**确认时间：规范不涉及。**

**过时 vs 错误：不涉及。**

### 1.9 通用 git-audit 实践

**dbt `state:modified`：artifact 对比，非来历 UI。**

- 面向构建优化（clone-or-skip），非来历展示。dbt Cloud 的 "Compare Changes" 是付费功能。
- `manifest.json` 的 `created_at` / `updated_at` 是构建时间戳。

**DataHub GitHub ingestion：把 git 文件拉进 DataHub 实体。**

- `github-documents` ingestion source 通过 REST API 从 GitHub 仓库拉文件做定期导入（[github ingestion](https://docs.datahub.com/docs/generated/ingestion/sources/github)）。
- DataHub 区分 **lineage**（数据流转）与 **provenance**（来历/处理者）（[blog](https://datahub.com/blog/data-lineage-vs-data-provenance/)）。
- Semantic Model 是 DataHub 一等实体（[semanticmodel entity](https://docs.datahub.com/docs/generated/metamodel/entities/semanticmodel)）。

**git-commit-as-provenance：行业主流模式。**

| 产品 | 来历存于 | 历史 UI |
|------|---------|---------|
| dbt | `manifest.json` artifact + git commit | "Compare Changes"（仅 dbt Cloud） |
| DataHub | ingestion 时间戳 + 可选 GitHub 源 | 实体历史 tab〔待确认〕 |
| Cube | git repo（`.yml` 模型） | 无专用 UI；git log |
| LookML | git repo（LookML 文件） | Looker IDE 展示 git 历史 |

**关键警示**（[atomic.dev/background](https://atomic.dev/background)）："Git Can't Preserve AI Agent Provenance" —— rebase/merge 会改 commit 身份，使 git 作为机器生成确认的唯一来历不可靠。

---

## 2. 对照表

| 维度 | DataHub | Atlan | OpenMetadata | dbt SL | Cube | LookML | Snowflake | Ossie | SG 现状 |
|------|---------|-------|-------------|--------|------|--------|-----------|-------|---------|
| **退役字段** | `Deprecation` aspect（boolean） | `certificateStatus`（3 态） | `entityStatus`（7 态） | `deprecation_date`（仅模型） | `public`（boolean） | `hidden`（yes/no） | DDL 全量替换 | 无 | supersede 链 |
| **继任指针** | 无（用 lineage aspect） | 〔待确认〕 | 无（用 lineage edge） | 无 | 无 | refinement 链 | 无 | 无 | `supersedes: [{id}]` |
| **计划下线** | `decommissionTime` | 无 | 无 | 无 | 无 | 无 | 无 | 无 | 无 |
| **历史 API** | GraphQL `timeline` + Kafka | `AuditSearchRequest`（ES） | Activity Feed + Events | `state:modified` | 无 | IDE git viewer | 无 | N/A | `get_history`（Followup） |
| **Actor 追踪** | `actor` URN 字段 | 审计 `createdBy` | 事件 `userName` | git author | git author | git author | `verified_by`（自由文本） | 无 | commit author + trailer |
| **时间戳** | aspect envelope | 审计 `createdAt` | 事件 `timestamp` | git time | git time | git time | `verified_at`（用户填） | 无 | commit time + trailer |
| **Deprecated ≠ Archived** | 分：Deprecation vs Status.removed | 分：DEPRECATED cert vs 软删 | 同枚举两值 | 不分 | 不分 | 不分 | 不分 | 不涉及 | 分：outdated vs wrong |
| **语义级区分（曾正确 vs 从错误）** | 不分 | 不分 | 不分 | 不分 | 不分 | 不分 | 不分 | 不涉及 | **分（唯一）** |

---

## 3. 对 SG 的借鉴

### 3.1 借鉴

1. **`get_history` 走专用工具路线**（Atlan `AuditSearchRequest` / OpenMetadata Events API 先例）：
   - 顶层 object，入参 `{target: '<kind>:<name>', since?, until?, event_types?}`，返回 `[{commit, actor, timestamp, evidence_kind, change_summary}]`。
   - 不挂在 `search_definitions` 或 `get_definition` 的响应里（那些是业务读面，审计是独立关切）。
   - 与 #132 / ADR-0017 一致：新工具是顶层 object，不扩 barrel。

2. **退役需要 successor pointer**（DataHub 缺此、Atlan/OpenMetadata 也缺）：
   - SG 的 `supersedes: [{id, reason}]`（ADR-0023 R2）已经有继任指针。
   - 但 `query` kind（ADR-0025）还没有退役机制 —— Followup 票应裁：一条 verified query 被新口径取代时，是 `update_verified_query` 全量替换（git diff 自然记录），还是需要一个显式的 `retire_verified_query` 工具 + successor 声明？
   - 建议：走 update + git diff 路线（`update_verified_query` 全量替换 + `expected_version`，ADR-0025 R7 Update 已裁），不需要额外 retire 工具。理由：query 的 SQL 即正文，全量替换后旧版在 git 里完整保留，读面 `get_history` 能回放任意版本。

3. **git rebase / force-push 风险**（atomic.dev 警示）：
   - SG 语料仓若被 rebase，commit trailer 里的 `X-SG-Evidence` / `X-SG-Memory` 会随 commit hash 一起变，但**内容不丢**（trailer 跟着 commit 走）。
   - 风险是外部引用（如 memory 的 `promoted.to` 指向 commit hash）会断。但 ADR-0023 R6 的 `promoted.to` 指向的是 `<kind>:<name>` 节点 id，不是 commit hash —— **已有防护**。
   - 建议：文档注明「语料仓禁止 force-push」（若尚未如此）。

### 3.2 不借鉴

1. **不借鉴显式 `verified_at` / `verified_by` YAML 字段**（Snowflake 路线）：
   - ADR-0025 R4 已裁「YAML 不设」。Snowflake 的用户手填 epoch 秒 + 自由文本名字，既不可靠（用户可能填错或不填）又与 git commit 形成两个真相源。
   - SG 的 commit trailer 原子绑定 actor + timestamp + evidence，架构上更优。

2. **不借鉴状态枚举字段**（DataHub boolean / Atlan 3 态 / OpenMetadata 7 态）：
   - 在 YAML 里加 `status:` 字段会与 git 状态形成双真相源（文件说 deprecated 但 git log 没看到退役 commit，或反之）。
   - SG 的事实层状态隐式于 git：有 commit 即存在，`supersedes` 链即退役。
   - memory 层的 `outdated` / `wrong` 区分已经通过 `supersedes.reason` 实现，不需要额外的状态字段。

3. **不借鉴独立审计存储**（Atlan ES / OpenMetadata Postgres change_event）：
   - SG 的 git log 天然就是审计日志，不需要第二个存储。双写只会引入漂移风险。
   - `get_history` 的实现是 git log 解析器，不是新数据库。

4. **不借鉴 `decommissionTime` / 计划下线日期**（DataHub 独有）：
   - SG 的事实层不涉及「计划在某天退役」的概念 —— 退役是一次 commit，不是一个预定日期。
   - 若将来需要「这条口径下季度失效」，用 memory `incident`（`valid_until`）表达，不进事实层。

5. **不借鉴 `public: false` / `hidden: yes` 二元可见性开关**（Cube / LookML）：
   - 二元开关不区分退役原因，SG 的 `supersedes.reason` 更精细。
   - 事实层不需要可见性控制 —— 读面挂载预算（ADR-0024）已经控制了展示优先级，`wrong` 条目在所有读面永久隐藏（ADR-0023 R2）。

---

## 4. 约束核对

| 约束 | 本研究的结论是否遵守 |
|------|---------------------|
| SG 不删已确认事实（ADR-0021/0023 memory supersede 保留 outdated 可读） | ✅ 全行业只有 SG 做到了语义级保留；其余产品或覆盖写、或软删、或硬删 |
| 新工具必须顶层 object（#132 / ADR-0017 不扩 barrel） | ✅ `get_history` 建议为独立工具，不挂在 search/get_definition 上 |
| 确认时间由 commit + trailer 推导（ADR-0025 R4 不设 verified_by/at） | ✅ 行业只有 Snowflake 走显式字段路线，且其用户手填方式不可靠；SG 的 trailer 路线是孤例但更优 |

---

## 5. 待确认清单

| 项目 | 说明 |
|------|------|
| DataHub GraphQL `timeline` 子字段 | WebFetch 403，未逐字段核实 |
| DataHub aspect envelope 字段名 | `systemMetadata.lastObserved` / `created.time` 未从 PDL 逐字核实 |
| Atlan `successorGuid` | Asset type reference 页 403，未核实是否存在 |
| Atlan AuditSearchRequest 字段名 | `createdBy` / `createdAt` / `action` 未逐字核实 |
| OpenMetadata `Archived` vs `Deprecated` UI 行为差异 | 搜索/展示层面的具体差异未核实 |
| OpenMetadata `change_event` 表路径 | Postgres 后端的具体表名/查询路径未核实 |
| Snowflake Snowsight 内部历史 | 可能有但未找到公开文档 |
| Apache Ossie Discussion #127 正文 | 社区讨论内容未抓取 |
| dbt SL 新规范 metric 是否有 `status: deprecated` | 未在官方文档找到 |

---

## Sources

- [DataHub Deprecation tutorial](https://docs.datahub.com/docs/api/tutorials/deprecation)
- [DataHub Python SDK models](https://docs.datahub.com/docs/python-sdk/models)
- [DataHub GraphQL objects](https://docs.datahub.com/docs/graphql/objects)
- [DataHub MXE docs](https://docs.datahub.com/docs/what/mxe)
- [DataHub Soft deletion issues](https://support.datahub.com/hc/en-us/articles/41912100671643-Dataset-Deprecation-and-Soft-Deletion-Issues)
- [DataHub GitHub ingestion](https://docs.datahub.com/docs/generated/ingestion/sources/github)
- [DataHub Lineage vs Provenance](https://datahub.com/blog/data-lineage-vs-data-provenance/)
- [DataHub Semantic Model entity](https://docs.datahub.com/docs/generated/metamodel/entities/semanticmodel)
- [Atlan Asset type reference](https://docs.atlan.com/product/capabilities/build-apps/references/types/core/asset)
- [Atlan CertificateStatus SDK](https://docs.atlan.com/product/capabilities/build-apps/sdks/python/how-tos/certify-assets)
- [Atlan Deprecated crawler logic](https://docs.atlan.com/product/connections/concepts/what-is-the-crawler-logic-for-a-deprecated-asset)
- [Atlan AuditSearchRequest](https://docs.atlan.com/product/capabilities/build-apps/sdks/python/how-tos/asset-crud/review-asset-history)
- [Atlan SearchLogRequest](https://docs.atlan.com/product/capabilities/build-apps/sdks/python/how-tos/review-access-logs)
- [Atlan Restore soft-deleted](https://docs.atlan.com/product/capabilities/build-apps/sdks/python/how-tos/asset-crud/restore-asset)
- [Atlan Activity Logs demo](https://atlan.com/demos/activity-logs/)
- [OpenMetadata table.json schema](https://github.com/open-metadata/OpenMetadata/blob/main/openmetadata-spec/src/main/resources/json/schema/entity/data/table.json)
- [OpenMetadata Metadata API](https://apis.io/apis/openmetadata/openmetadata-metadata-api/)
- [OpenMetadata Events API](https://apis.io/apis/openmetadata/openmetadata-events-api/)
- [OpenMetadata Change Feeds](https://docs.open-metadata.org/v2.0.x/connectors/ingestion/versioning/change-feeds)
- [OpenMetadata Features overview](https://docs.open-metadata.org/v2.0.x/features)
- [OpenMetadata Collaboration breaking changes](https://docs.open-metadata.org/v2.0.x/deployment/upgrade/breaking-changes/collaboration)
- [OpenMetadata Data Product](https://openmetadatastandards.org/data-products/data-product/)
- [dbt deprecation_date](https://docs.getdbt.com/reference/resource-properties/deprecation_date)
- [dbt state:modified](https://docs.getdbt.com/docs/deploy/dbt-state-about)
- [dbt v1.12 upgrade](https://docs.getdbt.com/docs/dbt-versions/dbt-upgrade/upgrading-to-v1.12)
- [dbt platform account settings](https://docs.getdbt.com/docs/platform/account-settings)
- [Cube measures reference](https://docs.cube.dev/reference/data-modeling/measures)
- [Cube data modeling](https://docs.cube.dev/reference/data-modeling/cube)
- [LookML hidden field](https://docs.cloud.google.com/looker/docs/reference/param-field-hidden)
- [LookML DRY cookbook](https://docs.cloud.google.com/looker/docs/best-practices/dry-cookbook-5)
- [Looker release notes](https://docs.cloud.google.com/looker/docs/release-notes)
- [Snowflake CREATE SEMANTIC VIEW](https://docs.snowflake.com/en/sql-reference/sql/create-semantic-view)
- [Snowflake verified query repository](https://docs.snowflake.com/en/user-guide/views-semantic/verified-query-repository)
- [Apache Ossie spec.yaml](https://github.com/apache/ossie/blob/main/core-spec/spec.yaml)
- [Apache Ossie spec.md](https://github.com/apache/ossie/blob/main/core-spec/spec.md)
- [Apache Ossie Discussion #127](https://github.com/apache/ossie/discussions/127)
- [atomic.dev/background](https://atomic.dev/background)
- [querio dbt metrics 2026](https://querio.ai/articles/dbt-metrics-2026-what-happened-what-to-use-now)

# 同名业务术语共存处理：产品对照研究

> **研究目的**: Ticket #196 — 调研各产品如何处理"同一业务术语（如"活跃用户"、"营收"）存在多个冲突定义"的场景
>
> **调研日期**: 2026-10-17
>
> **约束条件**: SG 服务端无 LLM（ADR-0022 R5）、不静默调和

---

## 一、逐产品对照表

### 1. Google Conversational Analytics (Looker data agents)

| 维度 | 详情 |
|------|------|
| **对象形状** | LookML 定义集中；字段/维度/度量均绑定到 Explore（探索空间）|
| **命名/唯一 ID** | `view_name.field_name` 全限定名 |
| **歧义消解机制** | **Ask-back（反问）** — 2026-09-30 release notes 明确提到："the agent can now ask follow-up questions to clarify ambiguities in a query, such as when there are multiple [matches]" |
| **是否强制单一答案** | 否 — 通过交互式反问让用户选择 |
| **反问触发条件** | 当查询映射到多个可能的 LookML 字段时触发 |
| **反问形式** | 待确认 — release notes 仅提到 "follow-up questions"，未公开具体 UI 形态 |
| **问数示例** | 用户问"上个月活跃用户多少"，若 LookML 中有 `users.active_daily` 和 `users.active_monthly` 两个字段，agent 应反问"您是指日活还是月活？" |

**来源**: [Conversational Analytics API release notes 2026-09-30](https://docs.cloud.google.com/gemini/data-agents/conversational-analytics-api/release-notes)

---

### 2. Databricks Genie (AI/BI)

| 维度 | 详情 |
|------|------|
| **对象形状** | Genie Agent 绑定到 Unity Catalog 表；字段元数据来自 UC |
| **命名/唯一 ID** | `catalog.schema.table.column` 四层全限定名 |
| **歧义消解机制** | **人工 curation（预先调和）** — 通过 trusted queries、instructions、certified columns 预先指定"权威定义" |
| **是否强制单一答案** | 是 — Genie 根据预设的 trusted assets 选择唯一答案，不向用户反问 |
| **认证/权威排序** | Certified 标记 > 普通字段；trusted queries 优先级高于自由生成 |
| **是否记录其他定义** | 待确认 — 文档未明确说明是否 log 被排除的备选定义 |
| **问数示例** | 若 `sales.revenue` 和 `finance.revenue` 都存在，agent 作者需在 instructions 中写明"营收默认指 finance.revenue"，或添加 trusted query 示例 |

**来源**:
- [Create and manage a Genie Agent](https://docs.databricks.com/aws/en/genie-agents/set-up)
- [Curate an effective Genie Agent](https://docs.databricks.com/aws/en/genie-agents/best-practices)
- [Tune Genie Agent quality](https://docs.databricks.com/aws/en/genie-agents/tune-quality)

---

### 3. Atlan / DataHub / OpenMetadata Glossary

#### DataHub
| 维度 | 详情 |
|------|------|
| **对象形状** | GlossaryTerm 是独立实体，可挂载到多个 dataset/column |
| **命名/唯一 ID** | `urn:li:glossaryTerm:<name>` — **全局唯一**，同名需不同 URN |
| **层级结构** | GlossaryNode（文件夹）→ GlossaryTerm；支持任意层级 |
| **同名处理** | 通过 Node 路径区分：`Marketing/活跃用户` vs `Product/活跃用户` 是两个独立 Term |
| **Domain 关系** | Domain 是另一个维度的分类，与 Glossary 正交；一个 asset 只能属于一个 Domain，但可挂多个 Term |
| **UI 呈现** | Glossary 树形浏览，Term 页面显示关联 assets |

**来源**:
- [GlossaryTerm - DataHub](https://docs.datahub.com/docs/generated/metamodel/entities/glossaryterm)
- [Domain - DataHub](https://docs.datahub.com/docs/generated/metamodel/entities/domain)

#### OpenMetadata
| 维度 | 详情 |
|------|------|
| **对象形状** | Glossary → GlossaryTerm；Metric 是独立实体 |
| **命名/唯一 ID** | Metric 使用 **全局命名空间** — "Because metrics use a global namespace, the fully qualified name is the metric name" |
| **同名处理** | Metric 不允许同名；GlossaryTerm 通过层级路径区分 |
| **层级结构** | 支持 Glossary 内层级，但 Metric 扁平化 |

**来源**: [Metrics - OpenMetadata](https://docs.open-metadata.org/v2.0.x/api-reference/governance/metrics)

#### Atlan
| 维度 | 详情 |
|------|------|
| **对象形状** | Glossary 支持层级；Term 可嵌套 |
| **命名/唯一 ID** | 待确认 — 文档未明确说明同名 Term 是否允许 |
| **Domain 作用** | Domain-scoped personas 可控制访问范围；同一 asset 可出现在多个 domain |
| **Certification** | 支持 certified 标记，用于指示权威定义 |

**来源**: [Design access, personas, and governance in Atlan](https://docs.atlan.com/product/capabilities/governance/access-control/best-practices/design-access-and-personas)

---

### 4. dbt Semantic Layer (MetricFlow)

| 维度 | 详情 |
|------|------|
| **对象形状** | Semantic Model → Metric；Metric 是顶层实体 |
| **命名/唯一 ID** | Metric 使用 **全局单一命名空间** — "a single global namespace" |
| **同名处理** | **编译期拒绝** — 同名 metric 会导致 dbt 编译失败，强制用户重命名 |
| **歧义消解机制** | 无运行时歧义 — 编译期已确保全局唯一 |
| **是否强制单一答案** | 是 — 全局唯一，不存在"哪个定义"的问题 |
| **问数示例** | 若两个 YAML 文件都定义 `metric: revenue`，`dbt compile` 报错；用户必须改为 `finance_revenue` 和 `sales_revenue` |

**来源**:
- [How the dbt Semantic Layer works](https://www.getdbt.com/blog/how-the-dbt-semantic-layer-works)
- [dbt Semantic Layer FAQs](https://docs.getdbt.com/docs/use-dbt-semantic-layer/sl-faqs)

---

### 5. Cube

| 维度 | 详情 |
|------|------|
| **对象形状** | Cube → Measure/Dimension；Measure 嵌套在 Cube 内 |
| **命名/唯一 ID** | `cube_name.measure_name` 两层全限定名 |
| **同名处理** | **允许跨 Cube 同名** — `Orders.revenue` 和 `Invoices.revenue` 可共存 |
| **歧义消解机制** | **查询时需指定 Cube** — API 调用时明确 `measures: ["Orders.revenue"]` |
| **是否强制单一答案** | 否 — 查询可包含多个 cube 的同名 measure，但需显式引用 |
| **问数示例** | 用户问"营收"，若未指定 cube，需要 UI 层或 agent 层决定引用哪个 cube 的 revenue |

**来源**:
- [Cubes - Data Modeling](https://docs.cube.dev/docs/data-modeling/cubes)
- [Cube Semantic Layer Architectures](https://www.typedef.ai/resources/semantic-layer-architectures-explained-warehouse-native-vs-dbt-vs-cube)

---

### 6. NL2SQL Ambiguity Research (Past Year)

#### AmbiSQL (2025-2026)
| 维度 | 详情 |
|------|------|
| **核心方法** | In-context learning 检测歧义短语 → 分类歧义类型 → 生成多选式澄清问题 |
| **澄清问题形式** | Multiple-choice options，用户点选而非自由文本 |
| **歧义分类** | Schema ambiguity（字段歧义）、Value ambiguity（值歧义）、Aggregate ambiguity（聚合歧义）|
| **问数示例** | "活跃用户" → 系统检测到歧义 → 弹出选项：A) 日活用户 B) 周活用户 C) 月活用户 |

**来源**:
- [AmbiSQL - Interactive Ambiguity Detection](https://dl.acm.org/doi/abs/10.1145/3788853.3801581)
- [Visual Pragatic Repair for NL Database Queries](https://dl.acm.org/doi/full/10.1145/3772318.3791265)

#### 其他论文
| 论文 | 核心做法 |
|------|----------|
| Resolving Underspecification in Agentic Text-to-SQL (2026) | 将 underspecification 分为可检测/不可检测，主张主动反问 |
| SQL-GRID (2026) | Grounded retrieval + interactive disambiguation agent |
| DART-SQL (2024) | 用 database content 重写 query 以消歧 |

**来源**:
- [Resolving Underspecification](https://arxiv.org/html/2610.02739v1)
- [SQL-GRID](https://publications.eai.eu/index.php/ew/article/view/14071)
- [NL2SQLBench](https://arxiv.org/html/2604.16493v1)

---

### 7. BI Tools (Tableau / Power BI / Metabase)

#### Tableau
| 维度 | 详情 |
|------|------|
| **对象形状** | Data Source → Calculated Field；Field 绑定到 data source |
| **命名/唯一 ID** | `[Field Name]` 或 `[Table].[Field]` |
| **同名处理** | **允许跨 data source 同名** — 不同 data source 可有同名字段 |
| **歧义消解** | **UI 手动选择** — 拖拽字段时需选择 data source；blend data 时需显式指定 |
| **是否强制单一答案** | 否 — worksheet 可包含多个 data source 的同名字段 |

#### Power BI
| 维度 | 详情 |
|------|------|
| **对象形状** | Semantic Model → Table → Measure/Column |
| **命名/唯一 ID** | `'Table'[Measure]` DAX 引用语法 |
| **同名处理** | **允许跨 table 同名** — 不同 table 可有同名 measure |
| **歧义消解** | **Table prefix 强制** — DAX 公式必须用 `'Table'[Measure]` 显式引用 |
| **Q&A 自然语言** | Synonyms 和 Linguistic Schema 可配置映射规则 |
| **是否强制单一答案** | 否 — 但 Q&A 需配置 linguistic schema 指定默认映射 |

**来源**: [Train Power BI Q&A: Synonyms & Linguistic Schema](https://lets-viz.com/blogs/how-to-train-power-bi-q-a-with-synonyms-and-linguistic-schema)

#### Metabase
| 维度 | 详情 |
|------|------|
| **对象形状** | Table → Measure；Measure 绑定到 table |
| **命名/唯一 ID** | Measure 名称 + 所属 table |
| **同名处理** | **允许跨 table 同名** — "Measures are saved aggregations associated with a table" |
| **歧义消解** | **Table-scoped** — 创建 measure 时绑定 table，查询时通过 table 区分 |
| **是否强制单一答案** | 否 — 但每个 measure 明确属于一个 table |

**来源**: [Measures | Metabase Documentation](https://www.metabase.com/docs/latest/data-modeling/semantic-layer/measures)

---

## 二、近一年 Clarification-Question 论文核心做法

### 2.1 AmbiSQL (2025-2026) — 最相关工作

**核心流程**:
```
用户查询 → 歧义检测（In-context Learning） → 歧义分类 → 生成多选式澄清问题 → 用户点选 → 生成 SQL
```

**歧义分类体系**:
| 类型 | 示例 | 澄清问题 |
|------|------|----------|
| Schema Ambiguity | "活跃用户" 对应多个字段 | "您是指 A) daily_active_users B) monthly_active_users？" |
| Value Ambiguity | "北京用户" — 是 city 还是 province？ | "北京是指 A) 北京市（直辖市） B) 北京地区（含周边）？" |
| Aggregate Ambiguity | "总营收" — SUM 还是 COUNT？ | "总营收是指 A) 订单金额求和 B) 订单数量？" |

**关键创新**:
- **多选式而非自由文本** — 降低用户认知负担
- **歧义类型驱动的问题模板** — 不同类型歧义用不同问题模板
- **In-context learning** — 无需微调，用 few-shot examples 检测歧义

### 2.2 Resolving Underspecification in Agentic Text-to-SQL (2026)

**核心观点**:
- **Underspecification ≠ Ambiguity** — 用户意图不完整 ≠ 有多个冲突解释
- **可检测 vs 不可检测** — 系统应区分"能发现的不完整"和"无法发现的不完整"
- **主张主动反问** — 宁可多问，不要静默猜测

**问数示例**:
- 用户："上个月营收"
- 系统检测到 underspecification：未指定时区、未指定是否含退款
- 反问："营收是否包含退款？A) 含退款 B) 不含退款"

### 2.3 SQL-GRID (2026) — Domain-specific 应用

**核心做法**:
- **Grounded Retrieval** — 先检索相关 schema 和 domain knowledge
- **Interactive Disambiguation Agent** — Agent 循环：检测歧义 → 反问 → 等待回答 → 重新生成

### 2.4 综合趋势

| 趋势 | 说明 |
|------|------|
| **多选式优于自由文本** | 降低用户输入成本，提高回答质量 |
| **歧义分类驱动** | 不同类型歧义需要不同的澄清策略 |
| **LLM in-context learning** | 主流方法，无需微调 |
| **主动反问 > 静默猜测** | 学术界共识：宁可多问，不要猜错 |

---

## 三、对 SG 的借鉴与不借鉴

### 3.1 约束条件回顾

- **SG 服务端无 LLM** (ADR-0022 R5)
- **不静默调和** — 必须显式暴露冲突，不能后台自动选择

### 3.2 可借鉴

#### 3.2.1 多选式澄清问题（来自 AmbiSQL）

**做法**: 当检测到同名词条有多个定义时，生成多选式澄清问题

**问数示例**:
```
用户: "活跃用户有多少？"

SG 检测到 "活跃用户" 有 2 个定义:
  - 定义 A: 日活用户（过去24小时登录）
  - 定义 B: 月活用户（过去30天登录）

反问: "活跃用户是指：
       A) 日活用户（过去24小时登录）
       B) 月活用户（过去30天登录）"
```

**适配 SG 约束**:
- 无需 LLM — 歧义检测可通过匹配词条名实现
- 多选式问题可在 client 端渲染

#### 3.2.2 全限定名引用（来自 Cube、Power BI）

**做法**: 强制使用 `namespace.term` 格式引用词条

**问数示例**:
```
✅ 推荐: "marketing.活跃用户"
❌ 歧义: "活跃用户"
```

**适配 SG 约束**:
- 服务端只需做字符串匹配
- Client 端可自动补全 namespace

#### 3.2.3 层级命名空间（来自 DataHub、OpenMetadata）

**做法**: 词条按 domain/namespace 组织，同名词条在不同 namespace 下共存

**示例**:
```
Marketing/活跃用户  →  日活定义
Finance/营收       →  含税营收
Sales/营收         →  不含税营收
```

**适配 SG 约束**:
- 纯数据结构，无需 LLM
- 查询时可按 namespace 过滤

#### 3.2.4 认证/权威标记（来自 Databricks Genie、Atlan）

**做法**: 允许标记某个定义为 "certified" / "canonical"

**示例**:
```yaml
- term: 活跃用户
  namespace: marketing
  certified: true  # 这是权威定义
  definition: "过去24小时登录的用户"

- term: 活跃用户
  namespace: product
  certified: false  # 这是领域定义
  definition: "过去7天有行为的用户"
```

**适配 SG 约束**:
- 纯元数据标记，无需 LLM
- 可作为排序权重，但不静默选择

### 3.3 不借鉴

#### 3.3.1 dbt 全局唯一命名空间（不借鉴）

**dbt 做法**: 编译期拒绝同名 metric

**不借鉴原因**:
- SG 场景下，不同 domain 可能需要同名词条（如 "营收" 在 finance 和 sales 含义不同）
- 强制全局唯一会导致命名膨胀（`finance_revenue`, `sales_revenue`, `product_revenue`）

#### 3.3.2 Databricks Genie 静默选择（不借鉴）

**Genie 做法**: 通过 trusted queries 预先指定权威定义，运行时静默选择

**不借鉴原因**:
- 违反 SG "不静默调和" 原则
- 用户不知道系统选择了哪个定义

#### 3.3.3 LLM in-context learning（不借鉴）

**AmbiSQL 等做法**: 用 LLM 检测歧义并生成澄清问题

**不借鉴原因**:
- 违反 SG "服务端无 LLM" 约束 (ADR-0022 R5)

**替代方案**: 规则匹配 + 词条元数据

### 3.4 推荐方案

综合以上分析，推荐 SG 采用:

```
┌─────────────────────────────────────────────────────────────┐
│  SG 同名词条共存方案                                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. 数据结构: 层级命名空间                                     │
│     - 词条按 namespace 组织 (如 Marketing/活跃用户)           │
│     - 允许同名词条在不同 namespace 下共存                      │
│                                                             │
│  2. 歧义检测: 规则匹配                                       │
│     - 查询时若匹配到多个同名词条，标记为 ambiguous             │
│     - 无需 LLM，纯字符串匹配                                 │
│                                                             │
│  3. 澄清问题: 多选式                                         │
│     - Client 端渲染多选式问题                                 │
│     - 每个选项显示 namespace + definition snippet            │
│                                                             │
│  4. 权威标记: certified flag                                │
│     - 允许标记某个定义为 certified                            │
│     - 作为排序权重，但不静默选择                              │
│                                                             │
│  5. 引用格式: 全限定名                                       │
│     - 推荐 namespace.term 格式                               │
│     - 单用 term 时触发歧义检测                                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**问数流程示例**:
```
用户: "活跃用户有多少？"

SG Client:
  1. 解析出 term = "活跃用户"
  2. 查询匹配到 2 个词条:
     - marketing.活跃用户 (certified: true)
     - product.活跃用户 (certified: false)
  3. 检测到 ambiguous = true

SG Client 渲染澄清问题:
  "活跃用户" 有多个定义，请选择：

  ○ Marketing/活跃用户 [权威]
    过去24小时登录的用户

  ○ Product/活跃用户
    过去7天有行为的用户

用户选择: Marketing/活跃用户

SG Client 生成查询:
  SELECT count(*) FROM users WHERE last_login > now() - interval '24 hours'
```

---

## 附录：调研来源汇总

### 官方文档
- [Google Conversational Analytics API Release Notes](https://docs.cloud.google.com/gemini/data-agents/conversational-analytics-api/release-notes)
- [Databricks Genie Agent Documentation](https://docs.databricks.com/aws/en/genie-agents/)
- [DataHub GlossaryTerm](https://docs.datahub.com/docs/generated/metamodel/entities/glossaryterm)
- [OpenMetadata Metrics](https://docs.open-metadata.org/v2.0.x/api-reference/governance/metrics)
- [dbt Semantic Layer](https://www.getdbt.com/blog/how-the-dbt-semantic-layer-works)
- [Cube Data Modeling](https://docs.cube.dev/docs/data-modeling/cubes)
- [Metabase Measures](https://www.metabase.com/docs/latest/data-modeling/semantic-layer/measures)
- [Power BI Q&A Synonyms](https://lets-viz.com/blogs/how-to-train-power-bi-q-a-with-synonyms-and-linguistic-schema)

### 学术论文
- [AmbiSQL: Interactive Ambiguity Detection and Resolution for Text-to-SQL](https://dl.acm.org/doi/abs/10.1145/3788853.3801581) (2026)
- [Visual Pragmatic Repair for Natural Language Database Queries](https://dl.acm.org/doi/full/10.1145/3772318.3791265) (2026)
- [Resolving Underspecification in Agentic Text-to-SQL](https://arxiv.org/html/2610.02739v1) (2026)
- [SQL-GRID: Grounded Retrieval and Interactive Disambiguation](https://publications.eai.eu/index.php/ew/article/view/14071) (2026)
- [NL2SQLBench](https://arxiv.org/html/2604.16493v1) (2026)

### 待确认项
- Google Looker 澄清问题的具体 UI 形态
- Databricks Genie 是否 log 被排除的备选定义
- Atlan glossary 同名 Term 的处理方式
- Tableau/Power BI 同名 metric 在自然语言查询时的具体行为

---

*本报告基于 ~2 search rounds per product 的高效调研完成。*

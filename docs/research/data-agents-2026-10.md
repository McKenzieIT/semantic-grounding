# 研究：近一月前沿数据分析 Agent 如何保证口径一致（2026-09-17 → 2026-10-17）

- 票：#191（map #189 分析图）· 日期：2026-10-17 · 只记相对 #126（2026-10-14 竞品 memory 研究）的增量
- **证据局限**：WebFetch 全站 403、本机 curl 不可用；以下每条依据搜索结果摘要（日期取自结果页），字面措辞落地前须再对原文。来源 URL 均为原始出处。
- 标签：「近一月新发」= 发布日期落在窗口内；「既有能力」= 窗口前已有（窗口内仅文档更新或二手讨论）；「待确认」= 找不到原始出处或日期。

## Verdict

1. 「同问同数」行业共识没变：**语义层（把口径写成机器可读的模型）+ 已验证查询（golden query）+ 评测集**。近一月无新机制，只是各家把这套上下文**通过 MCP 外送**给任意 agent（Genie One MCP GA）。
2. 近一月真正的新信号在**冲突处理**，且出现两派：Databricks「按权威/认证**自动调和**」（用户看不到另一套口径）vs Google「有歧义就**问回用户**」。SG 的「分歧可见」应站后者。
3. 分群/阈值在产品里是语义层/本体里的**具名过滤/规则**，agent 只读；写与背书归模型 owner/管理员认证。唯一让 agent 自写口径的是论文 EvoOntology（带证据节点、版本化）。
4. 行业在往**可移植的语义模型标准**收敛（Apache Ossie，微软/谷歌 10-01 加入）——提示 SG 口径事实应是能导出的普通数据，但不必现在对齐格式。

## 近月动态清单

| # | 对象 | 内容（问数例子说明） | 日期 | 来源 | 标签 |
|---|---|---|---|---|---|
| 1 | Databricks Genie One MCP GA | 外部 agent（ChatGPT/Claude/Cursor）经 MCP 拿 Genie 的业务上下文；「识别正确定义与来源，**按权威与认证调和冲突**」，并按用户权限执行。例：两张表都有「活跃用户」，取已认证 metric view 那套，另一套不提示 | 2026-09-22 | https://www.databricks.com/blog/genie-one-mcp-now-generally-available ；https://www.databricks.com/blog/genie-one-mcp-give-any-ai-agent-right-business-context | 近一月新发 |
| 2 | Databricks Genie Ontology | 统一上下文层：显式建模知识（metric views、governed pages、domains）+ 自动抽取知识；用于解析业务术语、指标定义、表关系 | 发布于 2026 Data+AI Summit（6 月）；10-08 官方博客复述 | https://www.databricks.com/blog/ai-powered-analytics-building-data-visualizations-natural-language-vs-sql ；https://www.analytics8.com/blog/databricks-genie-ontology-giving-ai-business-context/（09-29，二手） | 既有能力 |
| 3 | Databricks Genie Agents（原 Genie spaces） | trusted assets = 示例 SQL + SQL 函数，命中即「答案来自已验证逻辑」；benchmarks 测试题集；每 agent ≤50 张表/metric view | 文档 2026-10-09 更新 | https://docs.databricks.com/aws/en/genie-agents/tune-quality ；https://docs.databricks.com/aws/en/genie-agents/concepts | 既有能力（#126 已覆盖；改名时间待确认） |
| 4 | Google Conversational Analytics API | Looker 数据源的 data agent **遇歧义可追问澄清**（摘要：「such as when there are multiple ...」后文截断）。例：问「上月大R 留存」，模型里有两个「大R」字段时先问用哪个 | 2026-09-30 | https://docs.cloud.google.com/gemini/data-agents/conversational-analytics-api/release-notes | 近一月新发（全文待确认） |
| 5 | Looker Explore data agents | verified queries（又称 golden queries）作 agent 上下文；建议每 agent 30–50 对问答 | 文档 2026-10-09 更新 | https://docs.cloud.google.com/looker/docs/conversational-analytics-looker-data-agents | 既有能力 |
| 6 | Apache Ossie（原 Open Semantic Interchange） | 跨平台交换语义模型的开放规范；微软、谷歌加入贡献 | 2026-10-01（入孵 2026-06-22） | https://www.cio.com/article/4229751/ ；https://www.techzine.eu/news/data-management/144719/ | 近一月新发（加入事件） |
| 7 | Snowflake Ossie 入门指南 | 「营收」定义在 Ossie 里写一次，编译成 semantic view 供 Cortex Analyst 用 | 约 2026-10-13 | https://www.snowflake.com/en/developers/guides/getting-started-with-apache-osi/ | 近一月新发 |
| 8 | Snowflake Cortex Agents | Secure agents GA（规格对仅 USAGE 角色不可见）；agent 血缘显示上游 semantic view / search service | GA 2026-09-16；血缘 2026-09（日期待确认） | https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-secure ；https://dev.classmethod.jp/articles/snowflake-latest-info-202609/ | 既有能力（差一天出窗）/ 待确认 |
| 9 | Snowflake 社区实践 | 从 Feedback Table 取差评对话交给 LLM，产出 semantic view 改进建议，人再改 | 2026-09-30 | https://zenn.dev/finatext/articles/swtt-2026-growing-semantic-view | 近一月新发（社区，非官方） |
| 10 | Microsoft Fabric data agent | 口径归语义模型侧「Prep data for AI」（AI data schema / AI instructions / **Verified Answers**），data agent 读取并遵守；agent 自身 instructions 不放定义 | MS Learn 2026-09-30 更新；Serra 解读 2026-10-01 | https://learn.microsoft.com/en-us/fabric/data-science/data-agent-add-datasources ；https://www.jamesserra.com/archive/2026/10/prep-data-for-ai-vs-fabric-data-agent-instructions-what-goes-where/ | 既有能力 |
| 11 | Fabric IQ（FabCon Europe） | Fabric IQ 进 Copilot Chat/Cowork GA；Ontology（预览）一次定义实体/关系/规则/指标；data agent 预览返回 ≤1000 行 | 2026-09-29 | https://community.fabric.microsoft.com/blog/fbc_fabricupdatesblogs/fabric-september-2026-feature-summary/5325825 | 近一月新发（Ontology 细节待确认） |
| 12 | OpenAI Data agent（ChatGPT Work） | 连 Snowflake/BigQuery/Databricks 等；以语义层为据：关键实体、指标定义、过滤条件、已知坑 | 2026-09-10 | 仅社交帖：https://www.youtube.com/watch?v=bbNTY8O0GTY | 既有能力（出窗 7 天）；官方页待确认 |
| 13 | EvoOntology（论文 + 开源） | 本体作 MCP 服务：schema / content / tool 三层；content 层节点 = Terms / Mappings / Constraints / **Evidence**；版本化，**由执行轨迹自我演化** | 2026-09-21 | https://huggingface.co/papers/2609.15779 （arXiv 2609.15779）；https://github.com/RolfLobo/evoontology | 近一月新发 |
| 14 | ExperienceIndex（论文） | 以「制品」为锚的 agent 经验层，复用先前推理轨迹 | 2026-10-07 | https://arxiv.org/html/2610.10091v1 | 近一月新发（边缘相关） |
| 15 | HarnessSQL（论文） | 在有状态 harness 内训练 SQL agent | 2026-10-08 | https://arxiv.org/html/2610.12274v1 | 近一月新发（边缘相关） |
| 16 | Hex / ThoughtSpot Spotter / Julius | 两轮搜索未找到窗口内一手更新；Hex Context Studio 为 2026-01 | — | https://learn.hex.tech/changelog | 待确认 |

## 四问对照

- **同问同数靠什么**：语义层（Genie metric views / Snowflake semantic views / Fabric 语义模型 / LookML）+ 已验证查询（trusted assets / VQR / verified answers / golden queries）+ benchmarks。新动向只是分发：经 MCP 让任意宿主读到同一份。
- **分群/阈值能否被 agent 读写**：在语义层/本体里作具名过滤或规则，agent **只读**。例：「大R = r_level 7–9」写在模型里，agent 调用不改。窗口内无产品开放 agent 写入。
- **冲突与变更怎么呈现**：冲突两派（#1 自动调和 vs #4 追问）。变更：只见 Snowflake agent 血缘（#8），无「口径已变」提示给用户的一手证据——待确认。
- **谁能写/晋升、谁背书**：模型 owner / 管理员认证（certified metric view、verified answer 作者、agent 创建者）。agent 侧仅 EvoOntology 自写，社区实践（#9）是 LLM 出建议、人改。

## 共性模式

1. **口径上移**：定义住在语义层/本体，不住在 agent 提示词（#2、#10、#11）。
2. **已验证查询是确定性锚**，数量刻意受限（Looker 建议 30–50）。
3. **冲突处理分叉**：静默排序 vs 问回用户。
4. **上下文外送**：MCP 把语义层送给任意宿主（#1；dbt MCP 接 Cortex 亦同）。
5. **标准化**：Ossie 让「写一次、多处编译」成为行业方向。
6. **自进化仍停留在研究与社区**；产品侧背书恒为在线人工认证。

## 对 SG 分析图的借鉴

| 目标 | 借鉴 | SG 落法（守 ADR-0021/0022/0025） |
|---|---|---|
| 口径单源 | 定义在一处，查询引用（#2、#7、#10） | 「大R」作独立口径事实节点，已验证查询 `uses` 引用其 id；口径正文存为不透明文本/SQL 片段，SG 只存不展开、不编译 |
| 分歧可见 | Google 追问（#4），**不学**Databricks 静默调和（#1） | 两套已确认口径并存时读面成对返回（可复用 ADR-0027 contested「成对不拆」），由宿主 agent 问用户：「大R 有 7–9 档和 8–9 档两种口径，用哪个？」 |
| 生命周期 | Evidence 作一等节点（#13）；版本化 | 证据与来历仍走 commit trailer（ADR-0025 R4），读面经 `get_history` 展示确认时间；退役不删、留取代链 |
| 验收 | benchmarks（#3） | A4 接力卡即 benchmark：改划档后 B 在两条查询上拿到新口径或被告知已变 |
| 分发 | MCP 外送上下文（#1） | 印证 ADR-0024/0025 读面挂载：口径挂在 `get_definition`/`search_definitions` 结果上 |
| 指令 vs 定义 | 定义不进 agent 指令（#10） | practice memory ≠ 口径；口径只经 ①source / ②user-stated 晋升 |

## 不借鉴

- 按权威/认证静默调和冲突（违「分歧可见」）。
- 认证角色/在线审批人（ADR-0018 R1、ADR-0022 R5）。
- agent 自进化口径或 LLM 依反馈自动改口径（ADR-0025 R3 拒 replicated）。
- 编译口径到 semantic view / metric view 或任何指标引擎、口径 DSL（ADR-0022 R2、ADR-0025 R2）。
- SG 自跑 benchmark 执行 SQL（SG 不执行 SQL；由宿主 agent 跑）。
- 现在就对齐 Ossie 格式（留作 Followup：口径事实可导出即可）。

## 相对 #126 的增量

#126 已有：Cortex VQR、Genie 指令/示例 SQL/benchmarks/Trusted、dbt SL、DataHub/OM 提案流。本次新增：Genie One MCP 冲突调和策略、Google 追问澄清、Apache Ossie 收敛、Fabric IQ Ontology、OpenAI Data agent、EvoOntology 证据节点 + 自进化。

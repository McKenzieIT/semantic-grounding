# 研究：agent memory 与 data agent 记忆的竞品模式（#126）

- **票**：[#126](https://github.com/McKenzieIT/semantic-grounding/issues/126)（map [#125](https://github.com/McKenzieIT/semantic-grounding/issues/125)）
- **基线**：`main 4745e83`
- **日期**：2026-10-14
- **证据口径**：一手资料优先（官方文档 / 论文 / 源码 README），每条结论后附来源 URL。
  **本次检索的局限**：会话内 WebFetch 对所有站点返回 HTTP 403，原文无法当场逐页重读，本机 curl 抽查也没能完成。条目依据两部分：
  ① 官方文档 / 论文 / 源码截至 2026 年中的内容（研究者已知版本）；
  ② 当日搜索引擎对官方页面的摘要交叉核对，命中处标 〔当日摘要核对〕。
  工具名、字段名这类「字面」事实，后续落地若要依赖，**落地票须再对一次原文**。标 〔待核原文〕 处尤其如此：DataHub / OpenMetadata / Cognee 的 MCP 工具名迭代最快。

---

## 0. Verdict（先说结论）

1. **行业里「memory」与「被确认事实」几乎都是两个物理存储，不是同一存储里的两个状态值。**
   - 通用 agent memory 产品（MCP memory server、Claude memory tool、Mem0、Letta、Cognee）**只有 memory 一层**，没有「确认事实」层。
   - data agent 产品（Cortex Analyst、Genie、dbt SL、DataHub/OpenMetadata）**几乎只有事实一层**，即人策展的语义模型或词表。「memory」只以 **反馈 → 建议 → 人审 → 进入策展层** 的通路出现。
   - **两层都有、且给出晋升通路的，只有 data 侧的「建议/提案」机制**：Genie 反馈触发的 SQL snippet 建议、Cortex VQR 建议、DataHub/OpenMetadata 的提案与术语状态机。它们一律预设在线审批人，而这正是 SG ADR-0018 R1 明确拒绝的前提。
2. **时效与矛盾**：只有 Zep/Graphiti 做到了**双时间轴 + 失效不删除 + 溯源到原始 episode**。Mem0 的 graph 变体做到「矛盾边标 invalid」。其余产品要么覆盖写，要么硬删，要么靠人。SG 的 git 已经白送了「事务时间」（T′）与完整历史，**只差「有效时间」与「被谁取代」两个字段**。
3. **读取触发**：凡是对效果敏感的产品，都不信任 agent 会主动去读。
   - Claude memory tool 由平台**强制注入**「先看 memory 目录」的系统提示。
   - Letta 让 core memory **常驻上下文**。
   - Genie / Cortex 由**产品自身装配上下文**，agent 不决定读不读。
   - 纯工具调用式召回（MCP memory、Graphiti MCP、OpenMemory）都要靠宿主 system prompt 叮嘱。

   SG 是 MCP server，控制不了宿主 prompt，**最可靠的落点是「挂在既有读结果上」**：让 `get_definition` / `search_definitions` / `get_join_path` 的响应携带相关 memory，而不是新开一个「请记得来查」的召回工具。
4. **类型化**：通用 memory 普遍弱类型（字符串观察 / 文本块 / 自由三元组）。data 侧是**强类型，且类型直接对应用途**（同义词、JOIN、度量表达式、已验证 SQL、自由文本指令）。SG 的 memory 应走 data 侧路线：**少量枚举类型，每个类型对应一个晋升目标**。例如 join 提示 → relation；别名 → alias；口径 → concept 或表描述；已验证 SQL → 「验证查询」物。

---

## 1. 逐产品

> 每个产品按票面六问作答：存什么 · 谁写 · memory→事实分层/晋升 · 时效与矛盾 · 读取触发 · MCP 工具面。

### 1.1 Anthropic MCP memory server（`modelcontextprotocol/servers/src/memory`）

- **存什么**：本地 JSONL 文件里的知识图谱，三种对象：
  - **Entity**：`name` 唯一标识、`entityType`、`observations: string[]`；
  - **Relation**：`from` / `to` / `relationType`，README 要求主动语态；
  - **Observation**：挂在实体上的原子字符串事实。

  无时间戳、无来源、无置信度，类型字段都是自由字符串。
- **谁写**：agent 自写，无审核。
- **分层/晋升**：无。
- **时效/矛盾**：无内建机制。冲突靠 agent 先删观察再加观察；同名实体与重复关系在创建时静默跳过。
- **读取触发**：工具调用。README 给出一段推荐 system prompt：会话开始先说 "Remembering..." 并检索图谱；对话中留意身份 / 行为 / 偏好 / 目标 / 关系五类信息并写回。**引导完全交给宿主。**
- **工具面**：9 个细粒度 CRUD 工具：`create_entities` / `create_relations` / `add_observations` / `delete_entities` / `delete_observations` / `delete_relations` / `read_graph` / `search_nodes`（子串匹配）/ `open_nodes`。〔当日摘要核对：issue #5153〕
- 来源：<https://github.com/modelcontextprotocol/servers/tree/main/src/memory> · <https://www.npmjs.com/package/@modelcontextprotocol/server-memory> · <https://github.com/modelcontextprotocol/servers/issues/5153>

### 1.2 Claude memory tool（API 工具 `memory_20250818`）

- **存什么**：`/memories` 目录下的任意文件，**无类型**。
- **谁写**：模型自写。工具是 client-side：存储由应用方实现，Anthropic 只定义命令协议，共 6 个命令：`view` / `create` / `str_replace` / `insert` / `delete` / `rename`。
- **分层/晋升**：无。
- **时效/矛盾**：无内建机制。文档要求应用方自己做路径穿越防护、控制大小、定期清理长期未访问的文件，并警惕 memory 投毒。
- **读取触发**：**平台强制注入**。启用工具后，系统提示里会自动加入 "IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE"，并要求「假设上下文随时会被重置」。常与 context editing 配合使用。
- **对 SG 的含义**：这说明 Anthropic 自己判断，不强制引导，模型就不会可靠地先读 memory。SG 无法改宿主的系统提示，只能在自己的响应里挂内容。
- 来源：<https://docs.claude.com/en/docs/agents-and-tools/tool-use/memory-tool> · <https://www.anthropic.com/news/context-management>

### 1.3 Mem0（含 graph memory，arXiv:2504.19413）

- **存什么**：基础版是一句话一条的事实，带 metadata 与作用域（`user_id` / `agent_id` / `run_id`）。Mem0ᵍ 额外存带类型的实体与关系三元组。
- **谁写**：**服务端 LLM 自动抽取**，分两阶段。抽取阶段：输入最新一轮消息、会话摘要和近期消息，产出候选事实。更新阶段：对每条候选检索 top-s 相似的旧记忆，再由 LLM 在 ADD / UPDATE / DELETE / NOOP 中选一个操作。〔当日摘要核对〕
- **分层/晋升**：无。平台版只有 `immutable`、`expiration_date`、类别、custom instructions 等写入策略旋钮。〔待核原文〕
- **时效/矛盾**：基础版由 LLM 覆盖或删除，`history` 保留变更记录；Mem0ᵍ 把矛盾的旧关系标为 invalid，不做物理删除。
- **读取触发**：宿主在调用 LLM 前先 `search`，再把结果注入 prompt。
- **工具面**：SDK 有 `add` / `search` / `get_all` / `get` / `update` / `delete` / `history`；OpenMemory MCP 只开 4 个粗动词：`add_memories` / `search_memory` / `list_memories` / `delete_all_memories`。
- 来源：<https://arxiv.org/abs/2504.19413> · <https://docs.mem0.ai/open-source/features/graph-memory> · <https://docs.mem0.ai/platform/features/memory-history> · <https://github.com/mem0ai/mem0/tree/main/openmemory>

### 1.4 Zep / Graphiti（arXiv:2501.13956）

- **存什么**：三层子图。
  - Episode 子图：原始输入，无损保留；
  - 语义实体子图：实体，以及边上的一句话事实；
  - Community 子图：实体聚类后的摘要。

  可用 Pydantic 自定义实体类型与边类型。
- **谁写**：服务端 LLM 抽取，并做实体消解（embedding + 全文检索 + LLM 判同）。
- **溯源**：episodic edge 把每个事实连回产生它的 episode。
- **时效/矛盾（本组最强）**：双时间轴。
  - 时间线 T 记事件时间：`valid_at` / `invalid_at`；
  - 时间线 T′ 记事务时间：`created_at` / `expired_at`。

  新事实与旧边矛盾、且时间重叠时，旧边的 `invalid_at` 被设为新边的 `valid_at`：失效但不删除，可以回答「某时刻什么为真」。〔当日摘要核对〕
- **策展值保护**：2026-10-09 changelog：实体类型可声明 `identity_properties`，后续 episode 不再覆盖已非空的 identity 属性值。这与 SG 的 curated `origin` 同构。〔当日摘要核对〕
- **分层/晋升**：无。episode 到事实是抽取，不是晋升。
- **读取触发**：Zep 侧 `memory.get` 返回拼好的 context block（带有效期的事实 + 实体摘要），由宿主注入。Graphiti 侧是混合检索：余弦 + BM25 + BFS，再加多种重排。
- **工具面（Graphiti MCP）**：`add_memory`（异步入队）/ `search_nodes` / `search_memory_facts` / `get_episodes` / `get_entity_edge` / `delete_entity_edge` / `delete_episode` / `clear_graph`，`group_id` 作命名空间。`add_memory` 已核对（issue #1995 / #1991），其余工具名〔待核原文〕。
- 来源：<https://arxiv.org/abs/2501.13956> · <https://github.com/getzep/graphiti> · <https://github.com/getzep/graphiti/tree/main/mcp_server> · <https://help.getzep.com/changelog/2026/10/9>

### 1.5 Letta（原 MemGPT，arXiv:2310.08560）

- **存什么**：
  - Core memory 由 memory blocks 组成：`label` / `value` / `limit` / `description` / `read_only`，**常驻上下文**，可跨 agent 共享；
  - Archival memory：向量 passages；
  - Recall memory：对话历史。
- **谁写**：agent 自写，用 `memory_replace` / `memory_insert` / `memory_rethink` / `archival_memory_insert`。`read_only` 块由开发者写。sleep-time agent（arXiv:2504.13171）在后台整理 memory。Letta Code 的 MemFS 是 git 版本化的 memory 文件系统。〔当日摘要核对〕
- **分层/晋升**：分层依据是是否常驻上下文，不是可信度。`read_only` 是唯一接近「事实」的标记。
- **时效/矛盾**：无内建机制。
- **读取触发**：core 常驻，不需要读的决定；archival 与 recall 靠工具调用。
- 来源：<https://docs.letta.com/guides/agents/memory-blocks> · <https://arxiv.org/abs/2310.08560> · <https://arxiv.org/abs/2504.13171> · <https://github.com/letta-ai/letta-code>

### 1.6 Cognee

- **存什么**：图 + 向量。管线是 `add` → `cognify`（抽实体与关系、做 embedding 和摘要）→ `memify`（后处理增强）→ `search`（多种 search type）。
- **类型化**：可用 Pydantic `DataPoint` 或 OWL/RDF ontology 约束抽取。〔当日摘要核对〕
- **谁写**：服务端管线自动抽取，无人审。
- **分层/晋升**：无。ontology 只约束抽取，不是晋升门。
- **时效**：有带时间的抽取模式；没有公开的矛盾裁决机制。
- **工具面（cognee-mcp）**：粗粒度管线动词：`cognify` / `search` / `list_data` / `delete` / `prune` / `cognify_status`。〔待核原文〕
- 来源：<https://docs.cognee.ai> · <https://github.com/topoteretes/cognee> · <https://www.cognee.ai/custom-ontology-rag-retrieval>

### 1.7 Snowflake Cortex Analyst（semantic model / semantic view + VQR）

- **存什么**：语义模型，包含 logical tables、dimensions / time_dimensions / facts / metrics / filters、relationships、synonyms、sample_values 和 custom instructions；外加 **verified_queries**，字段为 `name` / `question` / `sql` / **`verified_by`** / **`verified_at`** / `use_as_onboarding_question`。〔字段名待核原文〕
- **谁写**：人策展。另有从使用日志生成 VQR 候选、供管理者采纳的建议流。〔待核原文〕
- **memory vs 事实**：整份语义模型都是事实。「verified」是对单条 SQL 的显式背书（谁、何时），是本组最干净的确认标记。Snowflake 还能从 verified queries 泛化，用来优化语义视图。〔当日摘要核对〕
- **时效**：语义视图有版本，Semantic Studio 提供 git 与 CI/CD；没有条目级有效期。
- **读取触发**：产品自动处理。问题与某条 VQR 相近时，复用或改编那条 SQL，并在响应里标注用了哪条 verified query。
- **工具面**：问答 API；托管 MCP 只把它暴露为 text-to-SQL 工具，不是记忆面。
- 来源：<https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-analyst/verified-query-repository> · <https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-analyst/semantic-model-spec> · <https://www.snowflake.com/en/blog/semantic-studio-ga/>

### 1.8 Databricks Genie（Genie space / Genie Agent）

- **存什么**：
  - instructions：自由文本；
  - example SQL：可带参数；
  - UC SQL functions：与 example SQL 一起合称 trusted assets；
  - knowledge store：表 / 列描述、同义词、JOIN 关系、SQL expressions（measures / filters / dimensions）。〔当日摘要核对〕
- **谁写**：space 编辑者。
- **晋升**：用户正反馈如果涉及 join 或 SQL 表达式，Genie 会向管理者建议新的 SQL snippet，管理者审批后才进入 knowledge store。〔当日摘要核对："suggest new SQL snippets ... to agent managers for review and approval"〕另有 benchmarks（问题 + 标准 SQL）做回归测试。
- **读取触发**：产品自动装配。命中 trusted asset 时，回答标「Trusted」。
- 来源：<https://docs.databricks.com/aws/en/genie-agents/tune-quality> · <https://docs.databricks.com/gcp/en/genie-agents/talk-to-genie> · <https://docs.databricks.com/aws/en/genie-agents/set-up>

### 1.9 dbt Semantic Layer（MetricFlow）

- **存什么**：YAML-as-code，包括 semantic_models、metrics（simple / ratio / cumulative / derived / conversion）和 saved_queries。
- **谁写 / 晋升**：人写；唯一的晋升方式是 PR 合入，没有 memory 层。
- **时效**：git 历史。
- **工具面（dbt MCP）**：只读：`list_metrics` / `get_dimensions` / `get_entities` / `get_dimension_values` / `query_metrics` / `get_metrics_compiled_sql` / `list_saved_queries`，外加 discovery 类工具。〔当日摘要核对〕
- 来源：<https://docs.getdbt.com/docs/build/semantic-models> · <https://docs.getdbt.com/docs/build/saved-queries> · <https://github.com/dbt-labs/dbt-mcp>

### 1.10 DataHub / OpenMetadata

- **存什么**：business glossary（术语、术语组、术语间关系），术语挂到资产上，以及资产的 documentation。
- **晋升**：
  - DataHub 用 **Proposals**：对资产提议加 tag / term / 文档，有权限者 accept 或 reject，提案是独立对象。
  - OpenMetadata 给术语设**状态机**：Draft → In Review → Approved / Rejected，另有 Deprecated；配了 reviewers 的术语必须经审批。Tasks 可以建议描述或标签，接受即落地。〔当日摘要核对：issue #35293〕
- **时效**：版本历史；没有条目级有效期；矛盾靠人解决。
- **工具面**：MCP 以搜索 / 取实体 / 血缘为主，加上受开关控制的少量写工具。〔待核原文〕
- 来源：<https://docs.datahub.com/docs/glossary/business-glossary> · <https://docs.datahub.com/docs/managed-datahub/approval-workflows> · <https://github.com/acryldata/mcp-server-datahub> · <https://docs.open-metadata.org/latest/how-to-guides/data-governance/glossary> · <https://github.com/open-metadata/OpenMetadata/issues/35293>

---

## 2. 横向对照表

| 产品 | 类型化 | 谁写 | 晋升 | 时效 / 矛盾 | 读取触发 | 工具面 |
|---|---|---|---|---|---|---|
| MCP memory | 弱 | agent | 无 | 硬删 | 宿主 prompt | 9 个 CRUD |
| Claude memory tool | 无 | 模型 | 无 | 应用方清理 | **强制注入** | 1 工具 6 命令 |
| Mem0 / Mem0ᵍ | 弱 / 中 | 服务端 LLM | 无 | LLM 对账；ᵍ 标 invalid | 宿主检索注入 | 4 个粗动词 |
| Zep / Graphiti | 可自定义 | 服务端 LLM | 无 | **双时间轴、失效不删、溯源** | context block / 检索 | 约 8 个 |
| Letta | 块 label | agent + 后台 | 无（仅 read_only） | 无 | **常驻** | 块编辑 + 档案 |
| Cognee | ontology | 服务端管线 | 无 | 带时间抽取 | 检索 | 管线动词 |
| Cortex Analyst | 强 + VQR | 人 | 日志建议 → 人采纳 | 视图版本 | **产品自动** | 问答 API |
| Genie | 强 | 人 | 反馈 → 建议 → 批准 | 无 | **产品自动**，标 Trusted | 问答 API |
| dbt SL | 强 | 人 | PR | git | 工具 | 只读 |
| DataHub / OM | 中强 | 人 + 自动化 | 提案 / 状态机 + 审批人 | 版本 | UI / 工具 | 读为主 |

---

## 3. 对照 SG 现有部件

| SG 部件 | 现状 | 行业对应 | 观察 |
|---|---|---|---|
| definition + git Tier-2 审计 | 一次写 = 一个 commit，trailer 记 derivation / confidence / scope / session（ADR-0004、GLOSSARY「git recorder」） | dbt SL、Cortex 语义模型 | 事实层已是行业强形态，还多出机器可读的作者与依据；git 白送 T′ 和历史。 |
| concept `properties` + `related_refs`（`related_to`，ADR-0012 Q4(b)） | 无谓词类型、无时间、无来源 | MCP memory server | 形状最像通用 memory 图。这是警示：不要把 memory 写进这里。 |
| suppression（ADR-0010） | 负知识；删除即诞生、重加即撤销；key-only；只约束机器轮 | Mem0ᵍ invalid、Graphiti `invalid_at` | 已有「否定事实需持久化，谁 / 何时 / 为何由 commit 答」的哲学，memory 失效可以沿用。 |
| curated `origin` | 机器轮不覆盖 curated 值 | Zep `identity_properties` | 行业共识，事实层已具备。 |
| pending queue（`packages/substrate/src/pending.ts`） | 自由文本 content；落 `<gitDir>/sg-pending/`，不进 git、不跨克隆；approve 故意未建 | Genie / Cortex 建议、DataHub 提案、OM Draft | 形状像提案箱，但 ① 无法跨机接力；② 自由文本无法机械晋升；③ ADR-0018 R1 已否在线审批人。 |
| scratch home（ADR-0020） | 会被 GC 的草稿 | 会话级 working memory | 不能当 memory 存储。 |
| `_guidance` / playbook（ADR-0014） | 在响应里注入引导 | Claude 强制注入、Zep context block | SG 唯一可用的「强制读」通道。 |
| dry-run + 守卫（ADR-0018/0019） | agent 自查 + 确定性软守卫 + 事后 `git log` | — | 这是「谁来审」的既定答案，晋升应复用这一套。 |

---

## 4. 对 SG 最该借鉴的 7 条（按 ROI 排序）

1. **事实与 memory 物理分存，晋升是一次带背书的显式写**（Cortex VQR、Genie trusted assets）。晋升 = 一次 Tier-2 写，commit trailer 引用 memory id，memory 自身记 `promoted_to`。读面上打两种不同标记，让 agent B 分得清「确认事实」和「前人经验」。
2. **memory 锚定到定义 id，挂在既有读结果上**。`get_definition` / `search_definitions` / `get_join_path` 附带相关 memory，用零税键：没有就不出现。这是 map ④「B 必须经 SG 读到」最可靠的机制，优先于新开召回工具。
3. **episode 级溯源**（Graphiti）。每条 memory 记 `session`（沿用 `X-SG-Session` 口径）、`observed_at` 和证据指针；晋升后的事实 commit 引用 memory id。
4. **失效不删除 + 有效时间 + 取代链**（Graphiti、Mem0ᵍ）。只加 valid-time 一侧的 `valid_from?` / `valid_until?` / `superseded_by?`；事务时间交给 git。被取代的条目保留，读面默认不挂。
5. **少量枚举类型，类型即晋升目标**（Genie knowledge store、Cortex 字段划分）：`pitfall`（不晋升）/ `join_hint` → relation / `alias_hint` → alias / `definition_hint` → concept 或表描述 / `verified_query`。自由文本兜底类型可以有，但不可晋升。
6. **已验证查询作为一等知识**（Cortex VQR、Genie example SQL、dbt saved queries），形如 `{question, sql, tables, verified_by, verified_at}`。先作为 memory 类型起步。
7. **写时对账**（Mem0 的四种操作）。服务端只做确定性的同锚点、同类型、文本相近检索，由连接 agent 选 ADD / UPDATE / SUPERSEDE / NOOP，避免同一个坑被记 N 遍。这与 ADR-0006 一致。

**附带一条验收侧借鉴**：Genie benchmarks 可以直接作 ④ 接力 e2e 的判定范式：看 B 的 SQL 是否用了 memory 指向的 join 键或口径。

## 5. 明确不该借鉴

1. **服务端 LLM 自动抽取**（Mem0 / Zep / Cognee）。违背 ADR-0006 与「polluting source-of-truth >> polluting instructions」。
2. **LLM 自动改写或删除事实层**。自动失效只允许用在 memory 层。
3. **无类型 / 无时间 / 无来源的自由图**。不要把 memory 塞进 concept `properties` / `related_refs`。
4. **常驻上下文的 blocks**（Letta）。SG 控制不了宿主上下文。
5. **在线审批人 / reviewer / 收件箱**（DataHub、OpenMetadata、Genie managers）。ADR-0018 R1 已否。可以借状态名和「提案是独立对象」这一点，不借在线审批门。
6. **文件编辑器式写口**（Claude memory tool）。等价于 ADR-0012 否决的「手写 YAML 绕过审计」。
7. **用硬删处理矛盾**。改用 supersede。
8. **向量库 / 社区摘要 / embedding 自动合并**。ROI 不足，且合并判断不可审计。
9. **把 pending queue 原样当 memory 存储**。它不进 git、不跨克隆。若担心「每条 memory 一个 commit 过重」：Letta MemFS 也选了 git，commit 本身廉价，真正要控的是单次会话的写次数（可用 overlay 合并或会话末批量写，留决策票裁）。

## 6. 留给下游决策票（#130 / #131）的开放问题

- memory 是新 kind，还是 definition 的侧字段？本研究倾向独立条目 + 锚点 id 列表，因为一条 memory 常跨多张表。
- 晋升用新动词 `promote_memory`，还是用「Tier-2 写 + 引用 memory id」的约定参数？
- 读面挂载的预算与排序：类型优先，限有效期内，且未被取代。
- `verified_query` 最终是独立 kind，还是长期作为 memory 类型？

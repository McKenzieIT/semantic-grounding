# 研究：SG 的 KG 层与语义层耦合现状盘点（#127）

- **票**：[#127](https://github.com/McKenzieIT/semantic-grounding/issues/127)（map [#125](https://github.com/McKenzieIT/semantic-grounding/issues/125)）
- **基线**：`main 4745e83`（worktree `research/kg-inventory`）
- **日期**：2026-10-14
- **证据口径**：全部锚点当日对现行代码复核。**不采信 ADR 行号**——ADR-0012 引用 `index.ts:2098`/`:2165`，而 `index.ts` 现为 1548 行，两函数已随 #98（map #95）迁入 `item-write.ts`（见 §1.⑦ 的「ADR 锚点漂移」）。
- 路径除注明外均相对 `packages/substrate/src/` 或 `packages/mcp/src/`。

---

## 0. Verdict

1. **七项初判全部确证，但其中两项需要重要修正**：
   - **⑤（无观察/事实层）确证，而且比初判更尖锐**：memory **今天已经在被写入事实层**——k11 语料里 **446/453 个事件**、**107/321 张表**把带日期的一次性实测塞进自由文本（`20260729 单日实测 cnt=355 / role_uv=111`、`唯一性在 ds='20250331' 单分区实测通过 (r=d=670)，未跨全部分区验证`）。不是「还没有人写 memory」，是**没地方放，所以混进了事实层**。这是 map #125 立论的最强实证。
   - **⑥（无时效）在「什么都没有」这一层面被部分证伪**：table/event schema 里**已存在三个休眠槽**——`confirmation{status, confirmed_by, confirmed_at}`、`coverage{scenarios, limitations, coverage_status}`、`supersedes{source, when, advantage}`。它们可经 `update_definition` 写、由 `get_definition` 原样返回，但**生产侧零读取**。`confirmed_by/confirmed_at` 恰是 #126 建议借鉴的 Cortex VQR `verified_by/verified_at` 形状。**概念没有这三个槽**。
2. **KG 层在唯一的真实语料里近乎空载**：10 个概念全是光杆分类节点（name/description/pref_label/alt_labels），**related_refs = 0、properties = 0**。ADR-0012 Q4(b) 建的实体层机器（概念侧三种边 + 自由属性）**零生产使用**。「补齐 KG 缺口」的 ROI 必须在这个事实上重算——缺口是真的，但目前没有任何语料在撞这些缺口。
3. **两处文档与行为漂移**（均不影响正确性，但会误导下游设计）：
   - `ConceptDefinitionSchema` 文档说 domains「at load time」校验（`types.ts:367-368`），实际是**图构建期的副作用**：命名不存在概念的 domain 被跳过并记入 `danglingDomainRefs`（`index.ts:525-540`），**从不拒绝写入**。且 `getDanglingDomainRefs()`（`index.ts:559`）**在 packages/mcp 里零调用**——一个 agent 看不见的死健康面。
   - `getDerived()` 文档说「all nodes reachable ... lineage traversal」（`relation-graph.ts:153-155`），实现是**单跳 filter**（`:158-162`）。
   - 另：`kinds/concept-kind.ts:4` 的文件头仍写「Edges are derived from asset.domains (not declared by the concept itself)」，被同文件 `:51-57` 的 Q4(b) 注释自我推翻。
4. **关系图是无向的**（`relation-graph.ts:50-61` 每条边双向入邻接表）。这对 ① 的补齐方式有硬约束：带谓词的边（「导致」「属于」）天然有向，**加类型不是加一个字段，要同时决定方向语义**。

---

## 1. 七项缺口核实

| # | 缺口 | 结论 | 锚点 | 补齐的最小触点 |
|---|---|---|---|---|
| ① | 边无类型 | **确证** | `types.ts:356-361` `RelatedRefSchema` 仅 `target_kind/target/derivation/origin`；`kinds/concept-kind.ts:58-69` 的 `relations()` 在 `:63` 硬编码 `type: 'related_to'` | substrate 内部（schema + kind plugin）+ MCP 工具层（`add_relation` 入参）。**附带决策**：图无向（`relation-graph.ts:50-61`），谓词需同时定方向 |
| ② | 节点无类型、`properties` 不校验 | **确证** | `types.ts:383-397` 无 entityType；`:390` `properties: z.record(z.string(), z.unknown()).default({})`；索引只吃原始值，对象/数组丢弃（`concept-kind.ts:40-44`） | substrate 内部（schema）+ MCP（concept create/update payload）。ADR-0012 原文即「deliberately unvalidated until a second real product needs strong schema」——触发条件未到 |
| ③ | 只看一跳 | **确证，且比初判更广** | `getRelated` 单跳（`relation-graph.ts:132-137`）；**`getDerived` 也是单跳**（`:158-162`），其文档却称 lineage 可达遍历；唯一多跳是 `findJoinPath`（`:101-125`），且 `:115` 只走 `joins` | substrate 内部（新遍历方法）+ MCP（新工具或扩 `get_relations` 加 `depth`）。概念边恒 `related_to`，结构性不进 join path |
| ④ | 无删除/合并/改名 | **确证** | 工具面 29 个，无 `delete_definition`/rename/merge（`tools/*.ts` 的 `*_TOOL_NAMES`）；Core 公共写方法仅 `updateTableMeta`/`updateEventMeta`/`writeConceptYaml`/`updateConceptMeta`/`addAliases`/`removeAliases`/`addRelations`/`removeRelations`（`index.ts:1304-1484`）；`io.ts` 唯一 `rm`（`:705`）是 D5 回滚路径 | MCP 工具层 + substrate 内部新原语。**ADR-0017 约束**：原语留内部，勿上 barrel |
| ⑤ | 无观察/事实层 | **确证（且已被绕过）** | 无任何 kind 承载「某时某地观察到」；实证：446/453 事件 + 107/321 表把带日期实测写进 `description`/`coverage.limitations`（见 §4） | 新 kind / 新存储（substrate 内部 + MCP 工具层）。这是 map #125 的主线缺口 |
| ⑥ | 无时效 | **确证（活机制），但「什么都没有」证伪** | 活机制确无；但 `ConfirmationSchema{status,confirmed_by,confirmed_at}`（`types.ts:61-65`，挂载 `:224`/`:281`）、`CoverageDefSchema`（`:70-74`）、`SupersedesDefSchema{source,when,advantage}`（`:79-82`，挂载 `:283`）**已在 table/event schema 里**，可写可读、**生产零消费**（全仓 grep `confirmation` 在 `packages/*/src` 除 types.ts 外仅一条无关注释）。概念三槽全无。`pending.ts:33` 另有 `submitted_at` | 多数在 MCP 层给语义（槽已存在）；概念侧要加槽则进 substrate schema |
| ⑦ | event 不能作 KG 边端点 | **确证（两侧）** | 目标侧：`types.ts:357` `target_kind: z.enum(['table','concept'])`；主语侧：`item-write.ts:590-592`（`addConceptEdge`）与 `:680-682`（`removeConceptEdges`）对 `kind === 'event'` 抛错 | substrate 内部（schema + item-write 两处）+ MCP（`RelationTargetKindSchema`）。**ADR 锚点漂移**：ADR-0012 引用的 `index.ts:2098/:2165` 已失效，函数随 #98 迁入 `item-write.ts` |

---

## 2. 语义层 ↔ KG 耦合点

### 2.1 `domains` 挂载与「校验」的真相

- 声明位：`TableDefinitionSchema.domains`（`types.ts:275`）、`EventDefinitionSchema`（同形）、概念自身经 `toGraphNode` 把 `domains` 设为自己的名字（`concept-kind.ts:71-77`）。
- **所谓 load-time 校验不存在**。真实行为在 `buildGraph`（`index.ts:481-549`）：
  - 非 grouping 节点把 `domains` 作为「要加入的组名」收集（`:502`）；
  - grouping 节点（概念）用 `grouping.groupName` 注册成组（`:506`）；
  - 命名不存在组的 domain → **跳过 + 记录**，`danglingDomainRefs.push(...)`（`:530-537`），注释明写「SKIPPED + warned rather than aborting」。
- 因此：**写入一个指向不存在概念的 domain 不会被拒绝**，图构建继续，其它边照常生成。
- `getDanglingDomainRefs()`（`index.ts:559-560`）是唯一健康面，**MCP 层零调用**（全仓 grep 在 `packages/mcp/src` 无命中）。对 agent 而言这个质量信号等于不存在——**治理面（#131）可直接取用的现成缺口**。

### 2.2 grouping / memberRelationType

- `concept-kind.ts:21-24`：`groupName` 剥掉 `concept:` 前缀；`memberRelationType: 'related_to'`。
- 组成员边在 `index.ts:539` 生成：`{sourceId: group.nodeId, relations:[{type: memberRelationType, target: sourceId}]}`——即**从概念指向资产**，再由 `g.build` 双向落盘。
- 两个来源（`domains` 派生 + 概念自身 `related_refs`）可对同一对节点各产一条 `related_to`，`concept-kind.ts:54-57` 明示这是冗余邻接而非冲突，图取并集。

### 2.3 `related_to` vs `joins`

- 三种关系类型（`relation-graph.ts:3`）：`joins` / `derived_from` / `related_to`，外加 kind 自声明的开放类型。
- `findJoinPath` 只走 `joins`（`:115`）→ **概念永远不进 join path**（ADR-0012 已记为诚实的结构限制）。
- `getDerived` 只 filter `derived_from` 且**单跳**（`:158-162`）。
- 建图双向（`:50-61`），`get_join_path` 的「无向」语义由此而来（与 #102 对该工具 description 的补注一致）。

### 2.4 读面对 concept 的覆盖

| 工具 | 覆盖概念 | 锚点 |
|---|---|---|
| `search_definitions` | 是 | `ReadableKindSchema = ['table','event','concept','metric']`（`tools/shared.ts:127`）；过滤经 `foldTableStorageKind`（`tools/read.ts:184-185`、`:354`） |
| `list_definitions` | 是 | `tools/read.ts:401`（同折算） |
| `get_definition` | 是，返回整份 definition（含三个休眠槽） | `tools/read.ts:231-237` |
| `resolve_alias` | 是（别名索引对任何 kind 结构性生效） | `relation-graph.ts:171-175` + 建图期 `graphAliasData` |
| `get_relations` | 是，但单跳 | `relation-graph.ts:132-137` |
| `get_join_path` | **否**（结构性） | `relation-graph.ts:115` |

### 2.5 DW/KG 双层拆法

`tools/guidance.ts:122-126`：

```ts
const nodes = snap.core.projectGraphNodes({ includeDerived: false })
const kg = nodes.filter(n => n.kind === 'concept').length
return { dw: nodes.length - kg, kg }
```

排除法——KG = `kind === 'concept'` 的节点数，DW = 其余。`playbook` 复用同一推导（#55/#63 的「阶段推导单一来源」）。**含义**：今天 SG 对「KG 层」的全部量化认知就是「概念数」；边数、属性数、边类型分布都不在任何度量里。

---

## 3. 可复用半成品能否承载「数据 memory」

| 部件 | 形状 | 能否承载 | 代价 / 结论 |
|---|---|---|---|
| **pending queue**（`pending.ts`） | `{suggestion_id, kind, subject, content, submitted_at, scope_id, tenant_id, meta}`（`:28-36`）——**形状惊人地接近一条 memory**（已有自由 kind、锚点 subject、正文、时间戳、meta） | **形状可借，存储不可用** | 落 `<gitDir>/sg-pending/`（`:10-12`），**不进 git、不跨克隆**——直接违背 Destination ④「B 换机器仍读得到」。与 #126「不借鉴：pending queue 原样当存储」一致。**建议**：借 record 形状，换存储归宿（进 worktree 受 Tier-2 审计） |
| **suppression**（ADR-0010） | key-only 否定知识，无 per-item provenance，作者由 commit 承载（`types.ts:218-223`） | 仅承载「否定」 | 与「失效不删」同构，但 key-only 装不下 memory 正文。可作 memory 失效语义的**先例**，不是载体 |
| **scratch home**（ADR-0020） | `<gitDir>/sg-scratch/<run-id>/`，prune 保 N=3 | **否** | 构造上会被 GC，定义上是草稿 |
| **provenance**（trailer） | `X-SG-Session`（`mcp/src/git/message.ts:16`、`recorder.ts:92`）、`X-SG-Derivation`、`X-SG-Confidence`、`X-SG-Agent`、`X-SG-Client`、`X-SG-Scope` | **半成品，可直接兑现 #126 借鉴 ③** | session 溯源在 **commit 级**已经有了；但要按「这条 memory 来自哪次会话」读取，得 `git log` 查，不是字段读。若 memory 需要字段级 session，仍要在 record 上加 |
| **concept `properties`** | 自由 `Record<string, unknown>`，索引只吃原始值（`concept-kind.ts:40-44`） | 技术上可，**不应** | #126 明确「别把 memory 塞进 concept properties/related_refs」。且实测使用量为 **0** |
| **三个休眠槽**（本票新发现） | `confirmation{status,confirmed_by,confirmed_at}` / `coverage{scenarios,limitations,coverage_status}` / `supersedes{source,when,advantage}` | **是最接近「已验证事实」标记的现成件** | 已可写（`update_definition` 的 `fields`，经 `updatableFieldsSchema`，`tools/shared.ts:265/267`）、已可读（`get_definition` 返回整份），**只缺语义与消费者**。`confirmed_by/at` ≡ Cortex VQR `verified_by/at`。**概念侧没有**，要对齐需加槽 |

---

## 4. 真实语料画像（实测）

**注意**：本机 **无 `~/.semantic-grounding/scopes.yaml`**（目录不存在），即**没有任何已注册的真实 scope**。唯一可测语料是仓内测试夹具 `packages/substrate/tests/fixtures/k11/`。

| 指标 | 数值 |
|---|---|
| tables | **321** |
| events | **453**（按 `domain` 分 7 个子目录） |
| concepts | **10** |
| 概念含 `related_refs` | **0** |
| 概念含 `properties` | **0** |
| 概念含非空 `alt_labels` | 4 |
| 概念含非空 `description` | 10 |
| 表声明非空 `domains` | **162 / 321** |
| 事件声明 `domains` | **446 / 453** |
| 表含 `dimension_refs` | 162（其中有条目 126） |
| 表含非空 `supersedes` | 8 |
| **事件把带日期实测写进自由文本** | **446 / 453** |
| **表把带日期实测写进自由文本** | **107 / 321** |

两条原样抄录的「被迫写进事实层的 memory」：

> （event `game.rogue.choosetreasure` 的 `description` 尾句）
> `…分析主体为 role_id（角色），20260729 单日实测 cnt=355 / role_uv=111 / acc_uv=110 / server_uv=45。`

> （table `dim_10000251_knight_level_grade_info_arch` 的 `coverage.limitations`）
> `唯一性在 ds='20250331' 单分区实测通过 (r=d=670)，未跨全部分区验证`

这两条都带**观察日期 + 观察值 + 适用边界**，全部是 episodic 的，全部混在应当稳定的定义文本里。它们证明：
- memory 的需求是**真实且高频**的（90%+ 的事件定义在干这件事）；
- 今天的后果是**事实层被污染**——定义的 `version` 指纹会因一次新实测而变，漂移守卫（ADR-0018/0019）会把「又测了一次」当成定义更新；
- `coverage.limitations` 事实上已被当作 memory 字段使用——它的 schema 位置（`types.ts:70-74`）与语义（「本定义的局限」）跟「某次观察的边界」只有一线之隔。

---

## 5. 给下游决策票的输入

**给 #130（三层模型与晋升规则）**：
1. **memory 不是新需求，是存量污染**。三层模型的第一件事可能不是「发明 memory」，而是「把 446 个事件描述里的实测切出来」。迁移口径应进 #130 议程。
2. **`coverage.limitations` 与 memory 的边界**要显式裁：哪些是「定义的固有局限」（留事实层），哪些是「某次观察的边界」（进 memory）。
3. **三个休眠槽的处置**：`confirmation` 作为晋升后的「已验证」标记直接兑现 #126 借鉴 ①/⑥，成本近零；但概念侧要不要对齐加槽，是模型问题。
4. **ROI 重算输入**：KG 实体层（related_refs/properties）零使用 → ①②③⑦ 四项缺口当前无语料在撞；⑤⑥ 才是热的。

**给 #131（工作流定位）**：
1. 治理面有一个现成且零成本的缺口：`getDanglingDomainRefs()` 已算好质量信号，**agent 读不到**。
2. DW/KG 的全部度量只有「概念个数」，治理侧若要「KG 健康度」，今天无从谈起。
3. `confirmation.status` 的 `draft` 默认值在 321+453 份定义里全未被推进过——「谁确认、何时确认」在数据治理语境里是天然议题。

**不要在下游重做的事（本票已证）**：
- 不必再查 ADR-0012 的 `index.ts` 行号，已漂移，以 `item-write.ts:590/:680` 为准。
- 不必再问「pending queue 能不能直接当 memory 存储」——不能，因为不进 git。
- 不必再问「概念现在有多少边」——零。

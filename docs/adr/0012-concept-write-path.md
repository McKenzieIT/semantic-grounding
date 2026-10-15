# ADR-0012: 语义层内容冷启动——轨迹驱动注册与概念写路径

- **Status**: accepted
- **Date**: 2026-10-12
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0005（裁决 2 concept 排除被本 ADR supersede、裁决 4 派生字段、裁决
  9/10 provenance 哲学）、ADR-0011（常数 9 scaffold 接缝在此对齐）、
  [map #40](https://github.com/McKenzieIT/semantic-grounding/issues/40)、
  [#42](https://github.com/McKenzieIT/semantic-grounding/issues/42)/
  [#43](https://github.com/McKenzieIT/semantic-grounding/issues/43)/
  [#44](https://github.com/McKenzieIT/semantic-grounding/issues/44)/
  [#45](https://github.com/McKenzieIT/semantic-grounding/issues/45)、
  [#46](https://github.com/McKenzieIT/semantic-grounding/issues/46)（五轮 grilling + 对抗性复核，
  本 ADR 的 canonical 设计来源）、执行票
  [#52](https://github.com/McKenzieIT/semantic-grounding/issues/52)

## Context

壳生命周期经 ADR-0011 落定（scaffold → register → switch）后，新 scope 面临内容问题：空
corpus 到可用 grounding 之间，种子定义从哪来、经什么写路径、带什么 provenance。#46 五轮
grilling + 一次对抗性复核裁了五件事，核正了票面候选表的两处前提：`syncWriteDefinitions`
不是导入工具的现成底座（输入是 `TableMeta[]`，引擎观测形状，`io.ts:964`——「MCP 未暴露」
是 ADR-0005 裁决 5 拒绝 agent 手搓形状的直接后果，非遗漏）；作者路原非全量可用（concept
无任何写路径——ADR-0005 裁决 2，`WritableKindSchema=['table','event']`，substrate 无
`writeConcept*`/`updateConcept*`，实测零命中）。

## Decision

采纳 #46 的全部五项裁决（下表为该票 resolution 的原始记录，保留作历史存档）：

| # | 维度 | 裁决 | 关闭的取舍 |
|---|---|---|---|
| 1 | 冷启动模型 | **轨迹驱动**：内容随消费 agent 工作轨迹增量注册（词 miss → 依据 DDL/文档 create_definition），不预铺种子；批量导入=Followup | 前置种子批/导入工具（无真实买主；syncWriteDefinitions 是 TableMeta 形状，暴露即违裁决 5） |
| 2 | 概念层 | **写路径开门**：概念=知识图谱 ontology 结构层，非索引页 | 接受为洞+触发条件（被推翻：结构层缺位不是软退化） |
| 3 | 概念写面 | **零新工具名**：create/update 加 kind:'concept'（fields 派生）；AliasKindSchema 拆分；relation 两工具不扩；substrate +2 原语；工具面零新名 | 概念独立动词（审计动词表无语义增益）；关系同扩（R3 原判：同一条边两个数据集）；bash 手写概念 YAML（绕 Tier-2 审计，制度化旁路） |
| 4 | scaffold 引导 | **next_steps=自包含一行**：五要素+两禁止；读工具不加 miss 指路（跨会话持久引导归宿主 prompt） | 结构化管线（scaffold 变内容手册，违 ADR-0011 常数 9）；文档指针（无处可指且会漂） |
| 5 | 导入 provenance（预录） | derivation=agent 不开第四值；来源进 commit summary 无新 trailer 槽；YAML `origin` 照旧省略；跨 corpus 复制=导入用法 | derivation='import'（运输机制非判断来源）；X-SG-Source 槽位（依据归 summary，裁决 10 同款） |

裁决三经「复核三修」定稿：补 ADR-0005 Update（裁决 2 原排除条款被本 ADR supersede，metric
排除维持——宿主内嵌 `metrics:` 块的派生只读视图，无后备文件无指纹，`read.ts:241-249`
"no write tool ever needs one"，排除有理由不是欠账）；mcp 执行清单补四处伴生点
（`CONCEPT_ARRAY_REF_REDIRECT`、`applyFieldUpdate` 第三分支、`assertUpdateOk` kind
联合放宽、`enrichmentHealthAfter` 概念分支返 `undefined`）；四条工具 description
重写（原写死「table or event」）。

### Q4(b) 对 R3 的修正：properties 扩展 + 概念侧关系开门

执行票 #52 在落地 R3 期间，追加了一轮独立裁决（Q4(b)，为游戏知识图谱实体层服务），
**修正了 R3 对 `add_relation`/`remove_relation` 的原判**：

- `ConceptDefinitionSchema` 新增 `properties: Record<string, unknown>`（`.default({})`，
  自由字段，不做 schema 校验——条件是第二个游戏产品需要强 schema 时升级）。
- `properties` 的 key/value 并入 `search_definitions` 的 bigram 索引（提升游戏术语召回），
  但不参与 enrichment 的 deterministic 推导（概念本就无 enrichment 轮次）。
- `add_relation`/`remove_relation` **扩到概念侧**——R3 原判「不扩」的依据是「概念的边由
  资产 `domains` 派生，概念侧再开声明入口=同一条边两个数据集」；Q4(b) 的输入变化是实体层
  需要概念间关系（概念→概念），这不是 `domains` 能表达的（`domains` 只表达表→概念的
  挂载），R3 的「同一条边两个数据集」顾虑在这个新边形上不成立——`RelatedRefSchema` 是
  这类边唯一的声明入口，不存在第二个数据集。`RelationTargetKindSchema` 扩至
  `['table', 'concept']`；三种合法边：概念→概念、概念→表、表→概念（event 作为
  subject/target 两边都被拒——事件没有实体层语义）。

本节记录为 R3 的 dated amendment，不改写上表的历史记录——见下方 Update 段落。

初始化路径（落地顺序）：term miss → `create_definition`（资产词建表/事件带别名；域词建
concept；表经 `fields.domains` 挂概念）→ `run_enrichment` 确定轮 →
`get_enrichment_work`/`apply_enrichment` LLM 轮 → 读路径命中。引导唯一落点 =
`get_scope_scaffold` 的 `next_steps` 一行（R4，由 ADR-0011/#51 落地）。**Supersede
ADR-0005 裁决 2 的 concept 排除条款**（metric 排除维持）。

## Consequences

- substrate **+2 原语**：`writeConceptYaml`（`io.ts:910`，对齐 `writeTable`：校验+原子写+
  recorder 必传）、`updateConceptMeta`（`io.ts:955`，对齐 `updateTableMeta`：锁内读改写
  +合并后全量校验）；`SemanticGroundingCore`（`index.ts:492`）暴露两者的包装方法
  （`writeConceptYaml` 于 `index.ts:1735`、`updateConceptMeta` 于 `index.ts:1760`），以及
  两个新的私有方法 `addConceptEdge`（`index.ts:2098`）/`removeConceptEdges`
  （`index.ts:2165`），服务 Q4(b) 的概念侧关系。
- 工具面**零新工具名**：`create_definition`/`update_definition`/`add_alias`/
  `remove_alias`/`add_relation`/`remove_relation` 六个既有工具全部获得 concept 支持；
  `tools/list` 返回的工具总数不受本票影响（本分支 `pnpm e2e` Step 2 报告 19 个工具，
  含 ADR-0005 原十五 + ADR-0006 三 + ADR-0008 一；与 #51 的 5 个 scope 管理工具合并后
  预期为 24，与 #46 的「工具面保持」判断一致）。
- `AliasKindSchema`/`RelationSubjectKindSchema` 拆为 `['table', 'event', 'concept']`
  （`shared.ts:93`/`:96`）；`RelationTargetKindSchema` 为 `['table', 'concept']`
  （`shared.ts:105`，Q4(b) 的落点——`'event'` 不是合法边目标）。`RelationRefInputSchema`
  （`shared.ts:146`）是 `JoinRelationInputSchema`（`shared.ts:135`，legacy 的
  `{dim_table, join_keys}` 形状，无判别字段，向后兼容既有调用）与
  `ConceptEdgeInputSchema`（`shared.ts:141`，新形状 `{target_kind, name}`）的联合，经
  `target_kind !== undefined` 判别。
- `ConceptCreatePayloadSchema`（`shared.ts:265`，strict，要求非空 `description`）与
  `ConceptFieldsSchema`（`shared.ts:286`，派生自 `ConceptDefinitionSchema.shape −
  {name}`）是 create/update 两工具 concept 分支的输入面；`CONCEPT_ARRAY_REF_REDIRECT =
  {alt_labels, suppressed_alt_labels, related_refs, suppressed_related_refs}`
  （`shared.ts:244`）接入 `update_definition` 的放行字段三值 ternary
  （`write.ts:157`），拒绝经 `add_alias`/`remove_alias`/`add_relation`/`remove_relation`
  才能改的字段走直接 `fields` 覆盖。
- **概念边的存储归属是单一且不对称的**：每条声明的概念边只有一个存储家——概念 subject
  自己持有（概念→概念、概念→表）；表 subject 的概念目标边存在**目标概念**自己身上
  （表没有边字段）。因此任何涉及概念的关系写入，`expected_version` 必须是写入会修改的
  那个概念文件的指纹——表 subject 场景下这是目标概念的指纹，不是被命名 subject 的指纹。
  `addConceptEdge`/`removeConceptEdges` 的实现（`index.ts:2098`/`:2165`）与其文档注释
  明确记录了这一点；e2e Step 14 对此做了专门的反面验证（见下）。
- **概念永远不会获得机器派生的边**：概念没有 enrichment 轮次/on-write hook（实测
  `enrichment.ts`/`enrichment-work.ts` 对 `'concept'` 零命中），所以经工具面写入的每条
  概念边在构造上都是 curated 的——`removeConceptEdges` 的机器派生否决分支在概念上结构性
  不可达，一次移除即是最终移除（`reasserted` 恒为 `false`），不像表/事件的两步否决舞步。
- `get_join_path` 的 BFS（`relation-graph.ts`）只走 `type === 'joins'` 的边；概念边
  （`RelatedRefSchema`）投射为 `related_to`（`concept-kind.ts:73` 的 `relations(def)`），
  从不是 `joins`，所以概念端点永远不能参与 join path——这是诚实的结构性限制，不是 bug：
  任何以概念为根的 `get_join_path` 查询正确返回 `found:false`。
- `enrichmentHealthAfter`（`audited.ts:115`）对 `writePath === 'concept'` 返回
  `undefined`（与 `'event'` 同一分支）——概念响应不带 `enrichment_health` 键，避免误报
  一个不存在的 round 的健康状态。`applyFieldUpdate`（`audited.ts:161`）与
  `assertUpdateOk`（`shared.ts:331`）的 kind 联合放宽为 `'table' | 'event' | 'concept'`。
- `create_definition`（`write.ts:91`）、`update_definition`、`add_alias`、`add_relation`、
  `remove_relation` 五个工具的 description 重写，不再写死「table or event」，并明确记录
  概念边的三种合法形与存储归属（`items.ts` 中 `add_relation`/`remove_relation` 的
  description 原文即是本节「存储归属」段落的工具面措辞）。
- `RelatedRefSchema`（`types.ts:356`）与扩展后的 `ConceptDefinitionSchema`
  （`types.ts:383`，新增 `properties`/`related_refs`/`suppressed_related_refs`）均
  `.loose()`——语料兼容是既有的 `.loose()` 哲学，工具侧输入仍 strict。
`properties`/`related_refs` 的索引面在 `concept-kind.ts` 的 `toCorpusItem`（`:30`）
完成。〔2026-10-13（#86，ADR-0017 / S1.6）：原并列的 `toPromptContext`（`:51`）已随
kinds 插件面整删，索引面唯一落点为 `toCorpusItem`。〕
- dsh 不受影响：substrate 的对外契约只新增两个原语和若干类型字段，不改变既有方法签名。

## Verification

- 单测：substrate 全量 `pnpm test`——27 个文件，424/424 通过，含新增
  `tests/concept-write.spec.ts`（33 tests：`writeConceptYaml`/`updateConceptMeta`、
  `addConceptEdge`/`removeConceptEdges` 的存储归属不对称、stale baseline 的重读重试、
  curated 边一次移除即终、三种合法边形+event 拒绝）与新增 `tests/concept-kind.spec.ts`
  （30 tests：`toGraphNode`/`relations(def)`/`toCorpusItem` 的
  properties 索引与 `related_to` 投射；原并列的 `toPromptContext` 测试段 4 例已随
  #86 删，现 26 tests）。mcp 全量 `pnpm test`——17 个文件，255/255 通过
  （含既有文件对六个工具 concept 分支的回归覆盖）。
- e2e（`packages/mcp/scripts/check-e2e-loop.ts`）：Step 14（`:675`）新增，走
  `create_definition(kind:'concept')` ×2、properties 读写回环、一次刻意的错误 baseline
  演示（命中 `StaleBaselineRejection`，`-31002`，证明存储归属不对称——用被命名 subject
  的指纹而非目标概念的指纹会被拒）、一次正确的表→概念边写入（证明边落在概念文件上，
  `dws_order` 自己的 definition 不带 `related_refs` 字段）、概念→概念与概念→表边、
  一次性移除（对照表/事件两步否决舞步显式断言）、`add_alias`/`resolve_alias` 在概念上的
  对等覆盖，以及三条读路径断言：`search_definitions` 对 `concept:` id 的排名命中、
  `get_relations` 走通两类概念边、`get_join_path` 对概念根查询诚实返回
  `found:false`（断言并注释了原因：概念边是 `related_to` 不是 `joins`）。全量
  `pnpm e2e` 报告 **18/18 步通过**。
- 门禁：两个包的 typecheck/test 全绿；substrate 的 acceptance（5 段全绿，host-neutral
  substrate 不受本票影响）；mcp 的 e2e（18/18）。四个有效门禁对两个包均确认绿，本票
  仅改了测试/e2e 脚本与生产代码，无门禁回归。

## References

- 设计来源：[#46](https://github.com/McKenzieIT/semantic-grounding/issues/46) 的
  resolution（五轮 grilling + 对抗性复核 + 前提核正 + 非问题清单，ADR-0012 草案的
  canonical 出处）
- 执行票：[#52](https://github.com/McKenzieIT/semantic-grounding/issues/52)（R3 落地 +
  Q4(b) properties/关系扩展）
- 行为依据：`packages/substrate/src/io.ts:910`（`writeConceptYaml`）、`:955`
  （`updateConceptMeta`）、`packages/substrate/src/index.ts:399`（`RelationInput`
  联合类型）、`:404`（`isConceptEdge`）、`:411`（`conceptEdgeKey`）、`:417`
  （`itemMatchesConceptEdge`）、`:492`（`SemanticGroundingCore` 类）、`:1735`
  （Core `writeConceptYaml` 包装）、`:1760`（Core `updateConceptMeta` 包装）、
  `:2098`（`addConceptEdge`，存储归属不对称的实现与文档）、`:2165`
  （`removeConceptEdges`，`reasserted` 恒 `false` 的实现与文档）、
  `packages/substrate/src/types.ts:356`（`RelatedRefSchema`）、`:383`
  （`ConceptDefinitionSchema`，Q4(b) 的 `properties`/`related_refs` 落点）、
  `packages/substrate/src/kinds/concept-kind.ts:30`（`toCorpusItem`）、`:58`
  （`relations(def)`，`related_to` 投射；原 `:51` `toPromptContext` 引用已随 #86 删）、
  `packages/mcp/src/tools/shared.ts:81`（`WritableKindSchema`）、`:93`
  （`AliasKindSchema`）、`:96`（`RelationSubjectKindSchema`）、`:105`
  （`RelationTargetKindSchema`，Q4(b) 的落点）、`:135`（`JoinRelationInputSchema`）、
  `:141`（`ConceptEdgeInputSchema`）、`:146`（`RelationRefInputSchema`）、`:244`
  （`CONCEPT_ARRAY_REF_REDIRECT`）、`:265`（`ConceptCreatePayloadSchema`）、`:286`
  （`ConceptFieldsSchema`）、`:331`（`assertUpdateOk`）、
  `packages/mcp/src/tools/write.ts:91`（`create_definition` 的 concept 分支）、`:157`
  （三值 ternary 的放行字段路由）、`packages/mcp/src/tools/items.ts:36`
  （`mapCoreError` 的 concept 分支）、`:74`（`AddRelationInputSchema`）、`:85`
  （`RemoveRelationInputSchema`）、`packages/mcp/src/tools/audited.ts:115`
  （`enrichmentHealthAfter` 的 concept 分支）、`:161`（`applyFieldUpdate`）、
  `packages/mcp/scripts/check-e2e-loop.ts:675`（e2e Step 14 的真实 wire 序列）
- GLOSSARY：cold start（冷启动）词条随 #46 落盘（已入库）

## Update 2026-10-12 — #52 落地：properties 扩展 + 概念侧关系（Q4(b)）

本节记录 #52 对本 ADR 原始裁决三（R3）的修正，供后续读者定位「关系工具不扩到概念」这一
原判在何处、因何被改。

- **R3 原判**（上方 Decision 表第 3 行）：`add_relation`/`remove_relation` 不扩，理由是
  概念的边由资产 `domains` 派生，概念侧再开声明入口会制造「同一条边两个数据集」。
- **Q4(b) 的输入变化**：#52 的落地场景是游戏知识图谱的实体层——需要概念与概念之间的
  关系（如「买量」关联「大盘」），这不是 `domains`（只表达表→概念挂载）能承载的语义，
  R3 原判担心的「两个数据集」在这个新边形上不成立：`ConceptDefinitionSchema.related_refs`
  是概念间关系唯一的声明入口，没有第二个数据集与它竞争。
- **裁决**：`RelationTargetKindSchema` 由隐含的 `['table']` 扩为
  `['table', 'concept']`（`shared.ts:105`）；`add_relation`/`remove_relation` 接受
  `{target_kind, name}` 形的概念边输入（`ConceptEdgeInputSchema`，`shared.ts:141`）；
  三种合法边——概念→概念、概念→表、表→概念；`event` 作 subject 或 target 均被拒
  （`index.ts:2098`/`:2165` 的 `kind === 'event'` 分支显式 throw）。
- **同时落地**：`ConceptDefinitionSchema` 新增 `properties: Record<string, unknown>`
  （`.default({})`，`types.ts:383`）——自由字段，不做 schema 校验，升级条件是第二个
  游戏产品需要强 schema；`properties` 的 key/value 并入 `search_definitions` 的
  bigram 索引（`concept-kind.ts:30` 的 `toCorpusItem`），但不参与 enrichment 的
  deterministic 推导（概念本就无 enrichment 轮次，`audited.ts:115`）。
- **工具面影响**：仍是零新工具名——`add_relation`/`remove_relation` 本身不变，只是
  `RelationTargetKindSchema`/`RelationRefInputSchema` 的判别联合多了一个分支；
  `update_definition(kind:'concept')` 的放行字段列表新增 `properties`
  （`CONCEPT_ARRAY_REF_REDIRECT`，`shared.ts:244`，与 `related_refs`/
  `suppressed_related_refs` 一起走重定向，经 `add_relation`/`remove_relation`
  而非直接覆盖）。
- 本次 Update 不改写上方原始 Decision 表（R3 行按 #46 当时的裁决逐字保留作历史记录），
  仅记录后续票对该行的 supersede——与 ADR-0005 的四段既有 Update 同构。

## Update 2026-10-15 — #161：update 路径三件套迁 `write.ts`（锚点注记）

本文 Consequences 与 References 两处以 file:line 引用的 `applyFieldUpdate`（原
`audited.ts:161`）与 `assertUpdateOk`（原 `shared.ts:331`，连同 `ApplyResult`）已随
[#161](https://github.com/McKenzieIT/semantic-grounding/issues/161)（巡检第三轮 C16）迁至
`packages/mcp/src/tools/write.ts`——`update_definition` 的单消费者文件。上文行号按落笔
时历史记录保留不动，符号现址以 `write.ts` 内检索为准。

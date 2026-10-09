# ADR-0003: v0.1 root barrel 的名级白名单（148 → 67）

- **Status**: accepted
- **Date**: 2026-10-08
- **Deciders**: McKenzieIT
- **Ticket**: [slice 5: curate the root barrel at name level before the first stable release](https://github.com/McKenzieIT/semantic-grounding/issues/7)

## Context

[ADR-0002](./0002-v01-public-surface-allow-list.md) 定下两级白名单的**规则**（(a) 具名活
消费点 / (b) 已确认 host 需求 / (c) 文档化扩展点所必需 + 约定耦合条款），把 name 级的执行
留给本票，并说明为什么必须排在 slice 4 之后：dsh 切到 tarball 之前，它的 typecheck 不经过
`exports["."]`，任何裁剪都不可证伪。slice 4b 已把 dsh 切到 vendored tarball
（`02ec2105a0`），barrel 现在是真实解析路径，裁剪可证伪。

**窗口仍然开着**：`@semantic-grounding/substrate` 在两个 registry 均 E404、无 git tag。
alpha 发布**不**关窗；首个稳定（非 alpha）发布才关。

**裁剪前的消费基线（实测，dsh @ `02ec2105a0`）**：静态具名导入 39 名（`as` 别名归并后），
动态 `await import('@semantic-grounding/substrate')` 再贡献 4 名——`writeTable`、
`writeEventYaml`（`tool-revert-edit/src/index.ts:197,202`）、`dumpYaml`（×3）、
`invalidateCaches`（`tool-edit-definition`）。**动态形态是 slice 3 量法看不见的**：#7 曾把
后两名列为可砍候选，实测后翻转 KEEP。教训并入证据标准：量依赖必须同时量静态与动态 import。

## Decision

root barrel（`src/index.ts`）从 **148 名（95 runtime + 53 type）裁到 67 名（34 runtime +
33 type，另加 `default`）**。规则照 ADR-0002 不变，本票明确三条适用口径：

1. **(a) 只认生产消费点。** dsh 的测试/脚本级消费不算 (a)：#7 自己的基线表就把「生产消费」
   与「仅测试/脚本消费」分栏，后者照 (b)/(c) 逐个判。消费方是 k11 一次性回填脚本和
   prototype probe 时，那是迁移工具的依赖记录，不是域需求证据。
2. **签名闭包属于公共面。** 被**保留**名字的公共签名所引用的类型必须保留——`TableMeta`
   出现在 core `discover`/`describe`/`syncWrite` 签名里，`Tier2Opts` 是 `updateTableMeta`
   的参数型，`EventCorpusItem` 是 `core.loadRetrievalCorpus` 的返回型，皆保留。裁类型只裁
   没有任何保留签名引用的。
3. **zod 子模型不公共。** 16 个组合用 schema 值与 11 个 infer 子型不上 barrel：没有公共
   函数以它们为参/返，且 `z.infer` 在发行版 `.d.ts` 里展开，消费方不需要具名。顶层三
   Schema（Table/Event/Concept Definition）例外——(a) 生产消费，是 parse 入口。

约定耦合条款在此兑现：`enrichAllDwsTables`、`buildDimInventory`、
`DimensionKeyPair{dws_column,dim_column}`、`buildExcludeColumns`、`inferRole`、
`generateDimYaml`（中文粒度字面量）、`discoverAltLabelsDeterministic`（CJK 括号启发式）、
`metricName/splitMetricName`（按 k11 321 表定尺寸）、`CaliberVariant`（口径直译）整族下
barrel——它们在 dsh 侧只剩测试/脚本消费，(a) 不成立（口径 1）。公共入口改为 core 类的
`discoverRelations` / `discoverEventRelations` / `discoverAltLabels` 方法。

### 保留名单（67 + default，逐组举证）

| 组 | 名字 | 依据 |
|---|---|---|
| 核心 | `SemanticGroundingCore`（+`default`）、`DataSourceRegistry`、`RelationGraph`、`WriteValidationError`、`SemanticLayerConfig` | (a)：dsh 8 文件直引/`as` 别名、4 文件、6 文件、3 文件；`DataSourceRegistry`/`WriteValidationError`/`SemanticLayerConfig` 另为 `getRegistry()` 返回型、Tier-2 写抛出型、构造参数（口径 2） |
| 读 API | `loadTables`、`loadEvents`、`loadConcepts`、`loadConfig`、`loadMetricDefinitions`、`resolveSemanticLayer`、`RawEvent`/`RawTable`/`RawConcept` | (a)：6/5/2/3/2 个生产文件；`resolveSemanticLayer` 为弱 (a)（dsh wayfinder prototype）+ 域中心（多 scope 根解析，MCP 多租户入口）；Raw* 为 loader 返回型（口径 2） |
| 校验入口 | `TableDefinitionSchema`、`EventDefinitionSchema`、`ConceptDefinitionSchema`、`TableDefinition`/`EventDefinition`/`ConceptDefinition`/`MetricDefinition`/`TableMeta` | (a)：6/5/2 个生产文件；类型为 core `load*Definition`/`discover`/`describe`/`syncWrite` 签名（口径 2） |
| kind 扩展点 | `tableKindPlugin`、`eventKindPlugin`、`conceptKindPlugin`、`DataSourceKindPlugin`、`SchemaLike`、`CriticFields`、`DerivedNodeContributor`、`KindGrouping`、`CorpusItem`、`RelationDef`、`GraphNodeProjection`、`RelationEdge`、`NodeAliasData` | (c)：注册 kind 是唯一文档化扩展点（ADR-0002）；(a)：三个 plugin + `DataSourceKindPlugin`（adapter）+ `RelationDef`/`NodeAliasData`（`retrieval-experiment/src/graph-snapshot.ts`）；其余为扩展点接口/core 图方法签名（口径 2） |
| 指标投影 | `extractMetricsFromTable`、`extractMetricsFromEvent`、`deriveMetricRelations`、`projectMetricCorpusItem` | (a)：`graph-snapshot.ts:12-15`（且经 `tsconfig.host.json` 的 gate 锚定） |
| 写路径 | `updateTableMeta`、`updateEventMeta`、`writeTable`、`writeEventYaml`、`dumpYaml`、`invalidateCaches`、`Tier2Recorder`、`Tier2Opts`、`WriteEventYamlResult`、`UpdateTableMetaResult`、`UpdateEventMetaResult` | (a)：`updateTableMeta` 生产、`writeTable`/`writeEventYaml`/`dumpYaml`/`invalidateCaches` 生产**动态**导入；`updateEventMeta` 为 (b)（GLOSSARY § write tier 文档化的 Tier-2 approve 路径，与 `updateTableMeta` 成对）；其余为签名闭包（口径 2）。raw-edit 面的公共性问题是 MCP map 的雾，不在本票 |
| Tier-1 队列 | `submit`、`loadPending`、`listing`、`discard`、`isValidId`、`PendingSuggestion`、`SubmitArgs` | (b)：MCP 管理面已确认需要建议队列（`docs/mcp-map-seed.md`） |
| 快照 | `captureSnapshot`、`DefinitionSnapshot` | (b)：MCP 已确认；且为 core `acquireSnapshot`/`withSnapshot` 签名（口径 2） |
| LLM seam | `LlmCall`、`TextLlm`、`wireEnrichmentLlm` | (c)：`setLlmCall` 的参数型（ADR-0002 (c)）；(a)：`TextLlm`/`wireEnrichmentLlm` 由 adapter `llm-wiring-plugin.ts` 具名消费（#7 修正 #2） |
| 配置与健康 | `CorpusVariant`、`EventCorpusItem`、`EnrichmentRound`、`EnrichmentHealthEntry`、`SchemaProvider` | 口径 2：`SemanticLayerConfig`/`corpusVariant` getter、`core.loadRetrievalCorpus` 返回、`getEnrichmentHealth()`（slice 2 ② 的结构化健康面）、`setSchemaProvider`；(c)：`SchemaProvider` 是文档化 seam（实现移至 `src/schema-provider.ts`，本模块只 re-export 型） |

### 裁掉名单（81 = 61 runtime + 20 type）

- **约定耦合 enrichment 管道（20 fn + 4 型）**：`enrichAllDwsTables`、`enrichAllEvents`、
  `enrichAllTablesAltLabels`、`enrichAllEventsAltLabels`、`discoverRelationsFor`、
  `discoverRelationsDeterministic`、`discoverEventRelationsFor`、
  `discoverEventRelationsDeterministic`、`discoverAltLabels`、`discoverAltLabelsFor`、
  `discoverAltLabelsDeterministic`、`buildDimInventory`、`buildLlmPrompt`、
  `buildEventLlmPrompt`、`buildAltLabelsPrompt`、`parseLlmRefs`、`parseAltLabelsResponse`、
  `mergeRefs`、`mergeAltLabels`、`AltLabelsTarget`、`DimInventoryEntry`、
  `DimensionKeyPair`、`DimensionRef`、`CaliberVariant`。dsh 仅剩测试/脚本消费（回填脚本、
  seed 脚本、prototype），口径 1 下 (a) 不成立。
- **约定耦合 io/metrics（8 fn）**：`buildExcludeColumns`（搬至 `src/io.ts`，core 内部经
  `discoverRelations` 继续使用）、`inferRole`、`generateTableYaml`、`generateDimYaml`、
  `metricName`、`splitMetricName`、`DimensionRefSchema`、`CaliberVariantSchema`。
- **zod 子模型（16 值 + 11 型）**：`ConfirmationSchema`…`TableMetaSchema` 及对应 infer 型
  （全列见 acceptance gate 的 must-absent 断言与 `src/types.ts`）。
- **测试工具（4）**：`clearSnapshotCache`、`getSnapshotCacheSize`、`SNAPSHOT_CACHE_MAX`
  （own-JSDoc："for testing…production code does not need this"）、`StandInSchemaProvider`
  （测试替身，移至 `src/schema-provider.ts`）。
- **无消费者内部件（13 fn + 5 型）**：`loadDomains`（legacy `domains.yaml`，被 concept
  kind 取代）、`loadRawDir`、`loadEventDefinition`/`loadTableDefinition`/`loadConceptDefinition`
  与 `loadRetrievalCorpus`（core 同名方法是公共路由）、`buildRetrievalCorpus`、
  `EventCorpusInput`、`BasicIndex`/`EventIndexEntry`/`TableIndexEntry`、`mergeColumns`、
  `mergeChangedYaml`、`syncWriteDefinitions`（P6b sync 流，无消费者；MCP map 起票时按 (b)
  重审）、`canonicalizeType`、`inferAggregation`、`toMetricDefinition`、`metricGraphNode`、
  `extractMetricsFromTables`、`isPlainObject`、`ResolvedSemanticLayerConfig`（仅 private 使用）。

所有被裁名字**仍在源模块导出**，本仓测试经 `../src/<module>.ts` 直达（裁剪前后 276 passed
+ 1 expected-fail 不变）；`default` 导出保留（dsh e2e 与 acceptance gate 锚定）。

## Consequences

- **acceptance gate 钉死名单**：`scripts/check-tarball-acceptance.mjs` 从 `>= 90` 计数断言
  升级为 **34+default 的 deepEqual 精确断言 + 61 个 must-absent 断言**——无证据加名立刻红，
  误删也立刻红。type 级名单由本 ADR 表格钉住（`Object.keys` 看不见型）。
- **dsh 升级断点是已知的且被 pin 隔离**：dsh 的 `pnpm-workspace.yaml` override 钉住
  `alpha.2` tarball，今天没有任何 dsh gate 变红。升级到 `alpha.3` 时 4 个测试/脚本文件
  需小改（回填脚本 5 名、seed-event-external-refs 1 名、d2c probes ×2 的
  `loadRetrievalCorpus`），已记录在 dsh 升级 pointer ticket。生产代码**零改动**。
- **MCP map 的晋升通道**：本 map 关闭后按用户方向下一程是 MCP 管理面
  （`docs/mcp-map-seed.md`）。若 MCP 需要某个被裁名字（例如 `syncWriteDefinitions`、
  raw-edit 面、`loadRetrievalCorpus` 模块函数），按 (b) 重新举证加回——alpha 发布不关窗，
  首个稳定版才关。
- **publish 是独立 effort**（map #1 Out-of-scope）：本票只 bump 版本到 `0.1.6-alpha.3`
  并产出 tarball，不发布。发布 alpha 不影响本 ADR 的免费裁剪窗口。
- 版本 bump `0.1.6-alpha.2` → `0.1.6-alpha.3`；tarball 76.1KB → 62.6KB。

## Update 2026-10-09 — #18 落地：barrel +3（34→35 runtime、type +2）

[#18](https://github.com/McKenzieIT/semantic-grounding/issues/18) 执行 ADR-0004 的 substrate
契约改动时，按本 ADR 口径 2（签名闭包属于公共面）新增三个名字，证据如下：

- **`StaleBaselineError`**（runtime，34→35）：`expected_version` 基线过期时写路径抛出的
  专用错误类型（ADR-0004 裁决 8）。证据同 `WriteValidationError` 的既有先例——调用方需要
  `instanceof` 把「基线过期，重读重试」与其他写失败区分开，两者是同一张表上的兄弟错误类型。
  `scripts/check-tarball-acceptance.mjs` 的 `EXPECTED_RUNTIME_NAMES` 已同步到 35。
- **`Tier2Batch`、`Tier2RecordMeta`**（type-only，不计入 runtime 断言——`Object.keys` 看不见
  型）：`Tier2Recorder.beginBatch?`（ADR-0004 裁决 3 的预留槽位，实现随 #16）的返回型，与
  `recordTier2Write`/`beginBatch` 共用的 opts 型。口径 2：`Tier2Recorder` 本身是保留名字，
  它新增方法的签名引用的型必须保留。

三者均落在 `src/io.ts`，由 `src/index.ts` re-export；本次新增不改变裁掉名单。

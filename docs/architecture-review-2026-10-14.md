# 2026-10-14 架构巡检报告（第二轮 · improve-codebase-architecture）· 两轴合并版

**基线** `main 2913c26`（首轮 C1–C8 收官后的门禁实测：typecheck 双包 0 / substrate 450 / mcp 446 pass + 1 skip〔**勘误：实为 447+1skip——#124 口径未计 #132 防回潮断言 +1**〕/ e2e 22〔banner 29〕/ catalog 29 / barrel 27，工具面 29）。**巡检进行中并发会话四笔落地**：`1b5c528`（#130 → ADR-0021 数据 memory 层与晋升规则 + GLOSSARY memory/promotion 词条）、`00674b8`/`8fc075a`（#130 关票与场景卡回填）、`5d9b653`（**#137 开票 + 首轮报告收束删除**——本文件即其继任，旧文全文 `git show 2913c26:docs/architecture-review-2026-10-13.md` 可回查）、`faf4962`（#137 六件清：S4 余三件 + S3 余三件全部落地）。本报告承前口径按「#137 已落地」收束；faf4962 后本会话复跑双包 typecheck 0 错（全套门禁未重跑，基线数字引用 2913c26 实测）。扫描按热点加权（近 30 commit churn：mcp `tools/import.ts`/`read.ts`/`shared.ts`/`scratch.ts`、substrate `index.ts`/`io.ts`、e2e 脚本），三路并行子代理走查（substrate / mcp / 测试+脚本+文档）+ 主会话 rg 亲验全部 Strong 级发现的消费者证据。

**已排除**（不重提）：首轮 C1–C8 全部落地关图（map #95 / #106 / #113 / #118）；S1 单宿主收窄（map #88，ADR-0017）；S3/S4 余件已随 [#137](https://github.com/McKenzieIT/semantic-grounding/issues/137) 落地（faf4962）；ADR / map Out-of-scope 记录在案项——C8.1 concepts 进 epoch（no-go，重开触发器 = concept 写路径批量化或 concepts>100）、index.ts 进一步分块（硬顶 1550，**现 1548 临界，见事实注记**）、epoch 外自由函数治理、epoch 可观测性、注销缓存淘汰、多 session 协调、跨 scope 参考、域模板、run_enrichment 编排下沉、snapshot.ts / schema-provider.ts（ADR-0017 暂缓区，重开按 ADR-0003(b) 重新举证）；KG / memory 方向票线（map #125：#130 已关产出 ADR-0021，前沿 #131/#134，#135/#136 被挡——休眠槽 `confirmation`/`coverage`/`supersedes`、`confirmed_by`、domains 校验语义、ETL 运维落点等归该线，结构巡检不重提）。

**术语**沿用 codebase-design 词表：module / interface / depth / seam / adapter / leverage / locality；deep = 小 interface 背后大行为，shallow = interface 复杂度接近 implementation。

## 候选总览

| # | 候选 | 区域 | 强度 |
|---|---|---|---|
| C9 | `loadBuiltinDefinitions` kind↔schema 双声明收敛（schema 半边归 plugin） | substrate | **Strong（首推之一）· 已开图**（[map #139](https://github.com/McKenzieIT/semantic-grounding/issues/139)，frontier = 裁决票 [#140](https://github.com/McKenzieIT/semantic-grounding/issues/140)，执行 [#141](https://github.com/McKenzieIT/semantic-grounding/issues/141)） |
| C10 | `update*Meta` 三联体 read-merge-validate 手抄收 seam（update 家族半区） | substrate | **Strong（首推之一）· 已开图**（map #139，执行 [#142](https://github.com/McKenzieIT/semantic-grounding/issues/142)、终验 [#143](https://github.com/McKenzieIT/semantic-grounding/issues/143)） |
| C11 | import 写域三件：R3 收据文案三抄 / 分类知识两处家 / writable 装载梯子五现场 | mcp | Worth exploring（一域一票可清）· **已开票**（[#144](https://github.com/McKenzieIT/semantic-grounding/issues/144)） |
| C12 | `tools/shared.ts` 两个单消费者成员迁出（clientNameFromEnvelope → audited / pendingQueueRoot → suggestions） | mcp | Worth exploring（顺手批）· **已开票**（[#145](https://github.com/McKenzieIT/semantic-grounding/issues/145)） |
| C13 | e2e 读惯例两 helper（versionOf/definition 手抄 ×19+×19）+ 阶段重号等三小件 | 测试拓扑 | Worth exploring · **已开票**（[#146](https://github.com/McKenzieIT/semantic-grounding/issues/146)） |
| C14 | substrate 小卫生批：item-write 两对镜像 helper 化 / Core 四连抄闭包 / normalizeAlias 第四份 / paramsText 微件 | substrate | Worth exploring（按触发挑）· **已开票**（[#147](https://github.com/McKenzieIT/semantic-grounding/issues/147)） |
| S2 | A 类死码承前复核刷新：mcp 四件 + substrate 三件直删级，vendor/nl2sql 等三件收窄拍板项 | 混合 | 直删级免费 · 拍板项归 grilling——**用户裁决本轮不开票**（另 effort，刷新证据在 §S2） |
| S3 | 文档/散文漂移新增七件（README flag 面 4→7 / GLOSSARY 守卫词条 trailer→subject / catalog spec 自述对不上账等） | docs | 修字（一票批）· **已开票**（[#148](https://github.com/McKenzieIT/semantic-grounding/issues/148)） |
| S4 | ~~小粒度整合 + 段位挪用~~ | mcp | **收束：已随 #137 落地（faf4962）** |
| S5 | 新增：#137 连带暴露——scope-id 字符集知识两处家 + `assertScopeIdShape` 退役 | mcp | **Strong**（deletion test 直接过）· **已开票**（[#149](https://github.com/McKenzieIT/semantic-grounding/issues/149)） |

Speculative 尾巴（不占编号，随最近落地票顺手）：dry_run 响应 `staged` 键与 `results` 零信息增量（import.ts:509-515，#104 昨落契约、有钉，现在是改它最便宜的时刻）；scratch 的 `Math.max(1, keep)` 钳制双写（scratch.ts:108/:160）；`ratioTrailer` 命名沿用被勘误措辞（归 S3 同票）。

---

## C9 · `loadBuiltinDefinitions`：kind↔schema 双声明收敛（Strong）

**文件**：`packages/substrate/src/index.ts:598-622`（三分支各 ~8 行）· `:118`（`EventDefinitionSchema`/`TableDefinitionSchema`/`ConceptDefinitionSchema` 三值 import）· `kinds/` 三插件（`schema` 字段）。参照系：registry 插件 seam（ADR-0003）与 `loadKindDefinitions` 的注册驱动循环。

**Before** —— 每个内置 kind 插件已携带自己的 `schema`，而 `loadBuiltinDefinitions` 又按插件身份分支、各自 import **同一批 schema 对象**再做 `safeParse` 循环（:602/609/616 用的就是 `plugin.schema` 本尊——kinds/*.ts 从 types.ts import 同一 schema 赋值）。同一知识（kind ↔ schema 绑定）在 plugin 与这里声明了两次。C8.3 在档的「身份分派」里：**loader 半边是 events domain 子目录布局的硬根因**（io.ts:504-509 `loadRawDir` JSDoc 自认 "bespoke layouts keep their own loaders"），得保留；**schema 半边是纯冗余**。

**After（plain english）** —— 函数退化为「按身份取 loader」（event→loadEvents / table→loadTables / concept→loadConcepts / 其余 undefined），parse 循环统一走 `plugin.schema.safeParse`；`:118` 三值 import 删（`:129-132` 的公开 re-export 走 types.ts 直通，不受影响）。大白话：一个 kind 用哪个 schema 校验，只由它的插件说一次。

- locality：新 kind 注册时 kind↔schema 绑定一处声明；
- index.ts 净缩 ~15 行——对 1548/1550 临界（map #95 硬顶）是直接减压；
- deletion test：schema 知识是去重非搬家（plugin.schema 已在）；
- 公开面零变化（Core 私有方法；barrel 三 Schema 名走 :129 直通）。

**ADR**：无冲突——ADR-0002/0003 名单不动；「后注册 kind 不改这里就能上图」的宣称（index.ts:587-597/662-678）从「只对扁平布局成立」向真话逼近一步（loader 身份仍在此处，宣称完整兑现需 events 布局改造，不在本候选）。

## C10 · `update*Meta` 三联体：read-merge-validate 手抄收 seam（Strong）

**文件**：`packages/substrate/src/io.ts:958-976`（`updateTableMeta`）· `:1008-1026`（`updateEventMeta`）· `:1101-1119`（`updateConceptMeta`）。参照系：C8.2 `writeDefinitionFile`（io.ts:820，**create** 家族 seam）+ io.ts:741-744 注释自认的 `auditedFileWrite` 抄写史（"Seven write paths previously carried this ceremony as hand-maintained copies"）。

**Before** —— 三个 ~19 行回调体逐行同构：`yaml.load(before.raw)` → object 守卫 → spread merge → `safeParse` → `atomicWrite` → `{name, version}`；差异仅 5 点描述符（目标路径解析 / not-found 措辞 `Table|Event|Concept not found` / schema / verb+subject / 结果键 `table_name|event_name|concept_name`）。C8.2 把 **create** 家族（writeTable/writeEventYaml/writeConceptYaml）收进了 `writeDefinitionFile`，**update** 家族是六写原语内部重复仪式的残留半区——同一疾病、同一文件、两次巡检各治一半。

**After（plain english）** —— 私有 `updateMetaFile`（描述符参数：layer、resolveTarget、label、schema、verb、subjectKey），三个公开函数各剩 3-4 行；签名、结果类型、错误字符串逐字保留。

- locality：merge+校验仪式一处定义；
- leverage：未来 kind 加 update 原语改一处；
- test：`version-roundtrip.spec.ts:76-144` 按公开函数钉，测试零改动；
- deletion test：集中（描述符是数据、仪式是行为）。

**ADR**：无冲突——与 `auditedFileWrite` 分层不撕裂（后者保持通用审计事务层，`update*Meta` 是 meta 族原语内部收拢，io.ts:802-808 分层注释自洽）；ADR-0004 裁决 8 的写回执语义（version = 所写字节指纹）逐字不动。

## C11 · import 写域三件：同构知识多份（Worth exploring，一域一票可清）

**文件**：`packages/mcp/src/tools/import.ts`（603 行，#104/#111/#112 落地后的最大新浅模块嫌疑）+ `write.ts` + `guidance.ts`。

1. **R3 收据文案三抄** —— `ignored N item-verb keys (related_refs/suppressed_* are add_relation/add_alias territory)` 同一字面量在 import.ts:427（Phase-1 skip 行）、:507（dry-run stagedRow）、:565（Phase-2 落盘行）三处 spread 手写。这是 ADR-0019 R3 的**线上契约格式**，三处各自演化即收据分叉。After：模块内 `itemVerbDetail(n)` 一个家，三处调用。
2. **分类知识两处家** —— `existingKindCounts`（import.ts:307-326，ratio 守卫分母）与 `layerCounts`（guidance.ts:138，#63/#121 建立的单源）各自 `projectGraphNodes({includeDerived:false})` + 同一套 by-elimination 分类戏法（concept 节点 kind 恒字面量 / event 恒 `'event'` / table 是开放存储 kind 落差集），**两侧注释互相点名**（import.ts:308-313 "the same documented trick, per-kind this time"）。After：guidance.ts（分类知识的现居所）导出 per-kind 版 `countNodesByKind`，`layerCounts` 退为两行投影，`existingKindCounts` 删除改消费；scope.ts:301 的 `counts: layerCounts(...)` 行为不变。
3. **writable 装载梯子五现场** —— `loadTableDefinition / loadEventDefinition / loadConceptDefinition` 的三元分派梯子在 write.ts:82/117/140（create 存在性检查 ×3）、import.ts:416-419（Phase-1 读）、import.ts:533-536（WithVersion 变体，skipped 收据读）五个现场手写；第 4 个可写 kind 落地时要找全五处。After：tools/shared.ts 两个小 seam `loadWritable(core, kind, name)` / `loadWritableWithVersion(...)`（返回 `{definition[,version]} | null`）。「skipped 收据 = 文件当前指纹」的语义注释留在 import 调用点。read.ts:218-232 是 `get_definition` 的 per-kind 分发（一 kind 一支，合法分派，不在内）。

**ADR**：无冲突——ADR-0019 R6 的 per-kind 分母语义原样（C11② 只合并推导不合并守卫）；ADR-0012 三 kind 词表不动。

## C12 · `tools/shared.ts`：两个单消费者成员迁出（Worth exploring，顺手批）

**文件**：`tools/shared.ts:435`（`clientNameFromEnvelope`，唯一消费者 `audited.ts:109`）· `:446/:468`（`PENDING_QUEUE_DIRNAME` + `pendingQueueRoot`，唯一家族消费者 `suggestions.ts` ×4 调用；scratch.ts:28/:126 仅注释引用其 pattern）。

**Before** —— #108（clientName 读取收进 auditedWrite）与 #120 之后，这两个成员从「跨家族」变「单家族」，留在 shared 名不副实；shared.ts（468 行）正驻 7 类成员，有向「什么都放」垃圾抽屉漂的迹象。

**After（plain english）** —— `clientNameFromEnvelope` 迁 audited.ts；`pendingQueueRoot` + `PENDING_QUEUE_DIRNAME` 迁 suggestions.ts；scratch 注释改指模块路径。「shared = 跨家族」的隐含契约恢复为真。机械、零行为。

**ADR**：无冲突（ADR-0005 addendum 的 clientInfo 语义随函数走；ADR-0011 的 sg-pending 门外布局不动）。

## C13 · e2e 读惯例：两 helper + 三小件（Worth exploring）

**文件**：`packages/mcp/scripts/check-e2e-loop.ts`（1206 行，全仓最大单文件）。

**Before** —— ① `fieldString(await call(client, 'get_definition', {kind, name}), 'version')` 版本读取手拼 **19 次**——harness 已有单点 `versionOf`（tests/helpers/intent-tools-harness.ts:255-258，spec 侧 25+ 消费），e2e 侧是它的手抄镜像；② `(...)['definition'] as Record<string, unknown>` 读体 **19 次**；③ `commitCount()`（:254）与 Phase 6.7 `impCount()`（:1079）同式重定义；④ 阶段号重号：两个「Phase 4.5」（:592 suppression / :731 concept write path）。

**After（plain english）** —— 脚本内 `baselineOf(client, kind, name)` 与 `definitionOf(...)` 两个三行 helper（或把 harness `versionOf` 核心参数化双端共享）；阶段号顺手顺一遍。**不提议** per-phase helper 大拆或步进数据表：22 步各自是唯一叙事（镜像对、两步舞、跨重启 work_id…），抽表只会把断言与叙事撕开——#122 收编 `withProbeScope`/`decodeResult` 之外，这就是 e2e 的全部残留。

**ADR**：无冲突（e2e 头注自述「detailed schema pinning stays in the catalog spec」的分工不动）。

## C14 · substrate 小卫生批（Worth exploring，按触发挑）

1. **item-write 两对 add/remove 镜像**：edges/joins 分桶前奏（split + 混批报错 + concept 拒绝）在 add/remove 各一份（item-write.ts:390-416 ↔ 482-498，error 文案仅工具名不同，靠手抄同步）；concept-edge 的 home/records 解析两份近镜像（:596-620 ↔ 683-698，remove 是 add 的严格子集）。→ 私有 `partitionItemRelations(rels, verbLabel)` 与 `resolveConceptEdgeHome(...)`。**两份非三份、有真差异点需 flag 参数化**，故 Worth exploring 而非 Strong。
2. **Core 四 item 前转闭包 4 连抄**：`(k, n, u, v) => this.applyItemUpdate(k, n, u, v)` 同一 eta-expansion 在 index.ts:1463/1472/1481/1490 手抄四次 → 一个绑定成员。纯卫生，但处于 1550 临界文件，每行净减都算数。
3. **normalizeAlias 第四份**：relation-graph.ts:192-194 与 io.ts:280-282 `normalizeLabel` 同为 `toLowerCase().trim()`——io.ts:271-277 JSDoc 宣称「One implementation serves every consumer」（#49 三处抄本收敛史）已被证伪；最低限度修 doc 宣称，或 import 复用（io→relation-graph 无环）。
4. （微）event-kind `toCorpusItem` 与 corpus.ts:69-79 的「哪些 params_fields 片段入索引文本」规则两处平行——输出上下文不同，抽象代价不小，Speculative。

**ADR**：均无冲突（模块内重构；ADR-0005 R3 / ADR-0010 语义不动）。

---

## S2 · A 类死码（承前复核刷新——另 effort 待开票，#137 Out of scope 明记）

### 直删级七件（零/近零行为损失，一票可清）

| 条目 | 位置 | 证据（rg 亲验） |
|---|---|---|
| `AuditContext.files`/`.rounds` | mcp git/recorder.ts:133-136 定义、:519-520 条件展开 | **比首轮票面更死**：batch 路径 :456 直接在 `CommitContext` 上填 `{...built, files: staged.length, rounds: recordCount}` 绕过 ctx；`AuditIntent`（audited.ts:70-81）无此两字段，测试构造点全无——「batch callers only (#21)」注释描述的是从未走通的通道。`CommitContext.files/rounds` 与 X-SG-Files/Rounds trailer 线格式**保留**。barrel type 面（src/index.ts:118 `type AuditContext`）一行说明的收窄 |
| `WritableKindSchema` | mcp tools/shared.ts:124 | 零消费者；唯一提及是 import.ts:107 注释自认 "restated for this schema's own doc"——所谓共享词表本身已死，`ImportKind` 自带枚举 |
| `ScopeRegistryFile.location` getter | mcp scope-registry.ts:137-140 | 零消费者；banner 用 `config.registryPath`（main.ts:165），config 解析时已 resolve |
| barrel `DERIVATIONS` | mcp git/message.ts:60 → src/index.ts:163 | src/tests/e2e/scripts 全零消费者（`Derivation` **类型**活着，audited.ts:57 等多处）——**七件中唯一动 barrel**（27→26，v01 公共面收窄需票面声明；仓内无常驻 barrel 枚举测试，删名无测试涟漪） |
| `toExecutableRule` | substrate registry.ts:168-172 | 全仓唯一出现 = 声明行；注释自认 "removed in M1b; retained for backward-compat"（= 首轮 C8.3 第 3 条，窗口内免费删裁决兑现） |
| devDeps `@standard-schema/spec` + `tsx` | substrate package.json:40/:45 | 两名全仓（除 node_modules/lock）唯一出现 = 声明行；scripts 是 `node scripts/*.mjs` + vitest |
| `loadDomains` | substrate io.ts:242-256 | 导出仅 k11-seed.spec.ts:70-71 消费（断言「非空对象」无行为价值）；index.ts:170 注释自认 "legacy domains.yaml, superseded by the concept kind"；连带 tests/README.md 两行 + io.ts:262 JSDoc |

### 收窄拍板项（grilling 议题单，与首轮 S1 集群同型）

- **vendor/nl2sql 三件套（601 行）** `substrate/src/vendor/`：生产零消费（src 内唯一 vendor import 是 io.ts:33 `atomic-write`，**活依赖不在内**），但 3 个 spec 消费——critic-fields.spec:13 / scenarios.spec:31（`makeCriticCtx`）/ concept-kind.spec:283,310（动态 import `expandCandidates`）。删前需先决定 concept 图扩展语义钉（concept-kind.spec:283-330）搬去哪。连带：`RelationGraph.getDerived`/`getJoinCondition`（relation-graph.ts:145-150/:158-162）生产消费仅 vendor/nl2sql-ontology（自身死）——若 vendor 删，此二者升格纯测试面并票。
- **`getId`（registry.ts:128-132，首轮 C8.3 余项）**：接口**必选**成员、三实现、生产零消费、消费仅测试 8 断言——与 `toExecutableRule` 可并票「registry 残留成员清理」；最强保留理由是「新 kind 须声明 raw-id 抽取」的契约提醒，但通用加载路径（index.ts:674-676 loadRawDir+plugin.schema）根本不调它。
- **弱 A `getDanglingDomainRefs`（index.ts:559-561）**：维持弱 A（删则损失 dangling 观察面 + 简化 buildGraph skip-and-collect；与 #131 治理票联动，#137 开票已注记）。
- **`written` 计数器诚实性**（2026-10-14 followup 审计折入）：sweep 引擎回执的 `written` 按成功调用计数、非内容变化计数（sweep.ts:46 注释自认、:91 `written += 1`）——map #27/#32 两次 Out of scope 承诺「未来另开票」从未开。裁决面：改诚实计数（回执语义变化需钉）或维持现状、JSDoc/GLOSSARY 写明口径。
- **`update_definition` per-key merge**（同审计折入）：#102 记 known limitation（`metrics` 整块 shallow-merge），map #106 Out of scope「可另议」未议。裁决面：进 #106 收过的写回执面做 per-key merge，或维持 known limitation 记档。

### 遗留对账补遗（2026-10-14 followup 审计——一行记录级，随 S2 开票处置）

审计范围：15 张已关 map（#1/#12/#27/#32/#40/#47/#50/#64/#73/#88/#89/#95/#106/#113/#118）的 Out of scope / Followup 逐条对账。除下列外，全部已解、已被本报告候选承接、或带触发器合规停放。

- **抽取器召回缺陷**（map #32 Out of scope「留作 fresh effort」未开）：括注内真正好的别名（「关卡名，如“汉家军阵”」式）永远抽不到——护栏只治精确率不治召回。S2 只裁「列档还是开票」。
- **`search_definitions` 的 `projectGraphNodes` 未缓存**（map #73 Out of scope）：每次调用 2× 解析、无触发器无票。列档或随未来 perf effort。
- **「其它 list 面工具响应尺寸」判 moot**（map #27「另开票」）：search 有 `top_k ≤ 50` 上限（read.ts:168）、响应结构性有界——不开票，判闭理由记录在案即可。
- **死触发器三条**：npm 发布 `@semantic-grounding/substrate`（#1/#12/#32/#40 四处记录，触发器「dsh 下次发版」已被 #79 独立发展裁决杀死——有意废止则四处注记或收口票一次说明）；server 侧 LLM provider 接线（#12，已被 ADR-0017 删 LLM seam 事实废止）；epoch 外自由函数治理（#73/#88，触发器「活的非 MCP 调用方」S1 单宿主后已死）。
- **`getDanglingDomainRefs` 联动更新**：上文拍板项写「与 #131 治理票联动」——#131 已关（ADR-0022：元数据治理 = SG 自身作检查器），依赖已清，可随 grilling 直接裁。

## S3 · 文档/散文漂移（新增七件——承前件已随 #137 清零）

1. **README.md:63-71「flag 面共四个」+ 表 4 行**——config.ts:215-224 OPTIONS 已 **7** 个 string flag（`--mass-update-warn-threshold` / `--mass-update-ratio-threshold` / `--mass-update-ratio-floor` 三缺，usage :262-280 逐一有文档）。README 是 #70 专门立的接入面文档，三个新 flag（#104/#111，ADR-0018 R5 / ADR-0019 R6 落地）一条没进。**Strong**。
2. **docs/mcp-dogfood.md:34-39 更正块同病**——自称「现行 flag 面」仍列四个，比 README 静态表格更误导（读者当权威面）。同票批。
3. **GLOSSARY.md:755（mass-update guard）/ :806（ratio guard）守卫标注写「commit's provenance trailer」**——代码真相是拼进 `intentTarget` → commit **subject**（import.ts:448-452 注释明说 "the annotation lands in the real write's commit subject"），ADR-0018 Update（0018 文 :130-132）已自我勘误但词汇表没跟；ADR-0019 Update :159 的「trailer 骑 intent target 通道」可顺带勘误。**Strong**（GLOSSARY 是两词条读者第一落点）。
4. **`ratioTrailer` 符号名沿用被勘误措辞**——import.ts:357（"shared by the WARN line and the trailer"）/ :366-369（"The commit-trailer annotation"），与同文件 :448-452 的正确注释自相矛盾；改名 `ratioSubjectNote` 或同类。随 3 一票。
5. **「248-test suite」×2**——check-e2e-loop.ts:9 / GLOSSARY:675，现值 mcp 447+1skip。数字形逃过 #116 的单词形清扫（词表是 twenty-four/twenty-six/registrar 词组）；改派生表述（"the unit suite"），与 S3/C3 已确立的「派生表述不写死数」判例一致。**Strong**。
6. **计数散文残存三处**——enrichment-tools.spec.ts:6/:67「(all) nineteen tools」、inprocess-client.ts:9「across fifteen tools' worth of tests」、**shared.ts:2「ADR-0005's fifteen intent tools」（现在时模块自述；现值 29 / ADR-0005 家族 16）**；改「all default-registrar tools」/「across the tool surface」/「ADR-0005's intent families」派生措辞（#115/#116 同款）。src/index.ts:16 的「#20 appends fifteen」是票史叙述可留。
7. **catalog spec 自述对不上账 ×2**——intent-tools-catalog.spec.ts:3-7 头注释枚举求和 **24** ≠ 「twenty-nine total today」（整族漏 ADR-0011 的六个 scope 工具，只点名了 #72 的 deregister）；:68 it 标题「sixteen + four + ADR-0011's six + playbook + import + #72's deregister + scratch」求和 **30** ≠ `toHaveLength(29)`（deregister 被双计——「five + #72's sixth」时代的残形）。该文件单一职责就是 catalog 对账，自述却对不上账。**Strong**（文字错、断言本身对）。

## S4 · 收束——已随 #137 落地（faf4962）

`ApplyResult`/`UpdateResult` 近形合一（shared.ts 导出、version 可选兼容 meta-update 裸 `{ok:true}`）、`countsOrThrow` fold、scope.ts 不可达字符集门删除（zod `ScopeIdSchema` 先拦 + 错段位）+ dogfood 派生表述/三处占位/四处旧路径头注。首轮 S4 六件至此全部清零（三小件随 #123、余三件随 #137）。

## S5 · 新增：#137 连带暴露——scope-id 字符集知识两处家（Strong）

**文件**：`scope-registry.ts:53`（`SCOPE_ID_PATTERN`）· `:108-114`（`assertScopeIdShape`）↔ `tools/shared.ts:94-97`（`ScopeIdSchema` 内联 regex）。

**Before** —— #137 删掉 scope.ts 的不可达字符集门后，`assertScopeIdShape` 与 `SCOPE_ID_PATTERN` 变为**仅测试消费**（scope-registry.spec.ts:20/:207-213；scope-tools.spec.ts:166 是注释）；而字符集知识同时活在 `ScopeIdSchema` 的内联 regex——ADR-0011 constant 6 现在有两处家，#137 刚落的 scope.ts:149-151「gate lives in zod」注释只是半个真话。

**After（plain english）** —— `ScopeIdSchema` 从 scope-registry import `SCOPE_ID_PATTERN`（tools→scope-registry 方向已有先例 scope.ts:56，无环）；删 `assertScopeIdShape` 与其 spec describe。ADR-0011 constant 6 单点化。

- deletion test：一次通过（零生产消费者）；
- 趁 #137 记忆新鲜，独立小票即可。

---

## 两轴重叠对照

| 本轮 | 关联 | 相同内容 | 处置 |
|---|---|---|---|
| C9 | 首轮 C8.3 | `loadBuiltinDefinitions` 身份分派 | C9 收 **schema 半边**（纯冗余）；loader 半边（events 子目录硬根因）留待布局改造；`getId` 归 S2 registry 残留成员清理票 |
| C11② | C6 / #121 | `layerCounts` 是 #63/#121 建立的单源，import.ts 的 `existingKindCounts` 是第二家 | 归 **C11**（消费 per-kind 版，守卫本身不动——双守卫独立触发是 #111 裁决） |
| C13 | 首轮 C7 | e2e 残留 | C7 收编 `withProbeScope`/`decodeResult` 后的全部剩余，同域不新开图 |
| S5 | S4 / #137 | scope-id 字符集门 | #137 删门后**新暴露**，独立新件非残项 |
| S3-5/6 | 首轮 S3 / C3 / #116 | 工具数散文清扫 | 数字形（248、nineteen/fifteen）不在 #116 单词形词表内，补漏性质 |

## 简化轴否决清单（查过，勿重查）

**本轮新增**：双守卫周边仪式合并——import.ts:336-339 码内注释自裁 "Deliberately self-contained — own config field, own message, own trailer segment"，残留同构实测每守卫 ~2 行，不过线；`registerEnrichmentTools` barrel 导出（enrichment-tools.spec:128 消费，v01 白名单名）；barrel 错误类不对称（scope/enrichment 时代类不在 barrel）——零消费者，ADR-0002 判据本就只收活消费点；config.ts:67 type-only `import { GuidanceThresholds }`（config→tools 层次倒味）——无环无摩擦；**check-relay.ts「新脚本」不存在**（mcp scripts/ 仅四件，CLAUDE.md #129 的 opt-in 是规划未出生，防后续巡检按「已存在脚本」走查）；captureTools 镜像（enrichment-tools.spec:119-131 ↔ scope-tools.spec:35-44，~10 行 fake 捕获器，抽象损叙述独立性）；fixtureConcept builder（单消费者 concept-write.spec:58-68，deletion test = 搬家）；mcp-map-seed.md（4 处 ADR/docs 引用 + 头注自认历史记录，map #12 史料锚点）；concurrent-writer.ts / registrar-server.ts helpers（进程面测试无法 in-process 收编）；vendor/atomic-write.ts（**活依赖**，io.ts:33）；GLOSSARY 已删机制词条干净（sync-write / scope-epoch / LLM seam 零命中）；第 5 位手拼绑定配方**无**（buildFixtureDeps 恰 4 位消费）、手拼定义字段**无残留**（`confirmation: { status: 'draft'` 标记全仓唯 fixtures 两单点）、it.skipIf 残留唯 build-shape win32（#81 裁定的 POSIX-only 门）；server-startup.spec:261「pre-existing nineteen」票史叙述算术自洽不列；substrate enrichment.ts:26-27 自注「#67 then deletes…pure barrel」已兑现属过时自注（随最近 substrate 票顺手改）；tests/README.md:2-3「20 spec files, 269 tests」陈旧（随 S2-loadDomains 或 S3 票顺手）；mcp 29 工具描述与实现对照抽查**无新 #133 级漂移**（import dry_run/双守卫、list_definitions cap、scratch retention、get_scope counts、items verdict 词表逐一核过）。

**首轮清单全部照册未重查**：errors 18 错误类发射点、flag×env 双通道（README 契约——但注意 S3-1：flag **名单**本身漂了）、posture 三时机 + assertCleanBeforeWrite、pending.ts/metrics.ts 活、substrate registry.ts 与 mcp scope-registry.ts 非重复、recorder 的 sessionId/agentEmailPattern 等 setter（barrel embedding 面 + trailer 线格式）、CorpusLock.releaseSync（关机半边）、CorpusLockOptions 三调参（config.ts 明文裁决）、invalidateCaches/corpusVersion（ADR-0015 活依赖，io.ts:188-206 实锚）、check-core-purity（空白名单纯不变量门）、check-tarball-acceptance（ADR-0003 活执行器，npm-ENOENT 是环境坑）、migrate-k11-event-filenames（审计轨迹）、read-count-probe 超时非缺陷、#129 判定不入四门禁。

## 事实注记（不作为候选）

- **index.ts 1548 / 硬顶 1550 临界**（map #95 Out of scope 分块复查触发带的余量 2 行）——本轮不按触发器重提；C9（净缩 ~15）+ C14②（4 行）落地即退回安全带。
- **#127「domains 所谓加载时校验」钉位**：唯一解析点 index.ts:526-542（buildGraph 内 miss → `danglingDomainRefs` 收集 + continue，注释自认 "SKIPPED (warned) rather than aborting the build"）；文档宣称面 registry.ts:88-103（KindGrouping JSDoc）+ index.ts:447-453；写路径零校验（types.ts:151/213/275 `domains` 纯字符串数组，全部写原语与 merge 无 domains 概念）。归 #131 治理票线，结构巡检不重提。
- snapshot.ts / schema-provider.ts 暂缓区照旧（`withSnapshot` finally 自认 no-op、`acquireSnapshot`/`Core.getRegistry()` 生产零消费——仅记录，ADR-0017 重开条款未触发）。
- kinds/ 插件 seam 复核：derivedNodes 三 kind 已单源 metrics.ts 四函数、grouping 仅 concept、**无该抽未抽的插件间镜像**（除 C14④ 微件）；C8.5 io-probes 与 C2 `resolveEnrichmentWork` 落点无新漂移；C8.2 `writeDefinitionFile` 三调用点（io.ts:881/930/1083）无新漂移。

## 首推

**C9 + C10 并图**（substrate 双深化第二弹，照 map #95 体例）：两个都 Strong、都净减行数（index.ts 1548 临界直接减压）、公开面零变化（Core 签名 / barrel / 工具面不动）、仓内先例齐——C9 是 enrichment-work.ts 式「知识归插件」的延伸，C10 是 writeDefinitionFile 描述符 seam 的 update 家族对称半区，验收可全按 #97/#100 已立的模式（rg 单点 + 公开签名逐字 diff + 既有 spec 零改动全绿）。

**快赢热身序**：S2 直删级七件一票（唯一注意点 DERIVATIONS 是 barrel 27→26，票面声明即可）；S3 新增七件照 #114 Q4「六处终版清单」体例一票修；S5 单独小票趁 #137 记忆新鲜。**拍板项一张 grilling**：vendor/nl2sql 601 行（concept 图扩展语义钉去向）+ getId（与 toExecutableRule 并票 registry 残留成员清理）+ getDanglingDomainRefs（与 #131 联动）——逐项「能力放弃」清单就是议题单。

**C11–C14 为下一档**：各自独立、按触发挑；C11 与 C12 同域（mcp tools/）可并一票，C13/C14 独立。

## 健康区清单（勿重扫）

首轮清单全部延续（sweep engine + types / enrichment.ts 门卫 / read-epoch.ts / auditedFileWrite seam / definitionVersion 指纹往返 / registry 三条核心消费循环 / D5 chokepoint / epoch Proxy / binding.ts 入口快照 / scope-registry 三层并发 / lock 双信号 / posture 四格表 / config 双载波 / errors.ts 段位账本 / audited.ts / items.ts / read.ts / fixture-corpus / harness / TOOL_NAMES 三道门对账 / e2e 真 startup 形状）。**本轮新增**：

- `X_TOOL_FAMILY` 九家族描述符派生链（map #113：names↔registrars 漂移结构上不可能；banner toolCount 参数化）。
- `epochWrapped` 门内错误映射 + not-found adapter 家族 + 错误契约测试一处盖全部（map #118 C5）。
- `evaluateLayers` 单点 + guidance/playbook 双渲染器共享同一评估（C6）；`layerCounts` 仍是计数推导唯一活源（C11② 是给 import 侧消费，不是搬走它）。
- `writeReceipt` 信封（11 调用点收编、两处已裁决不对称参数化保留）+ `withAuditedBatch`（C4 / C8.4）。
- `writeDefinitionFile` 写分发 seam（C8.2，三调用点）；io-probes 三件套 + 带宽不变量（C8.5）。
- `item-write.ts`（gate 四象限直测 + hygiene raw 透镜）与 `resolveEnrichmentWork`（fetch/apply 双端单源，stale detail 单源）——C1/C2 落地形状复核无新漂移。
- `fixtureTable`/`fixtureEvent` + `buildFixtureDeps` + `freshFixtureRegistry` + `withProbeScope` + `decodeResult` 双出口（C7）——第 5 位手拼配方与手拼字段复核为零。
- #132 防回潮断言（ONEOF_GRANDFATHERED 只减不增，intent-tools-catalog.spec:76-90）。
- mcp 描述面（29 工具 .describe() 与实现对照）本轮抽查无新 #133 级漂移。

---

*证据均带 file:line：代码证据锚 `main 2913c26` 已提交树（substrate 侧 = faf4962 树，#137 未触 substrate src）；mcp 侧 `shared.ts`/`binding.ts`/`scope.ts`/`audited.ts` 的行号已按 faf4962 刷新，其余文件两树同址。门禁基线引用 2913c26 实测（faf4962 后本会话仅复跑 typecheck 双包 0）。*

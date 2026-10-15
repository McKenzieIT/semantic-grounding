# 2026-10-15 架构巡检报告（第三轮 · improve-codebase-architecture）· 两轴合并版

**基线** `main b5c86df`，四门禁当日亲跑全绿：typecheck 双包 0 / substrate **450**（28 文件）/ mcp **437+1skip**（27 文件）/ e2e **22**（banner 29）——与 CLAUDE.md 基线节逐字吻合。前两轮已收官，报告均已删除：首轮全文 `git show 2913c26:docs/architecture-review-2026-10-13.md`、第二轮全文 `git show b5c86df:docs/architecture-review-2026-10-14.md` 可回查，**本文件即第三任**。扫描按热点加权：六票批（#144–#149）与 map #139 刚收 seam 的落点做「收后残件」复核，外加前两轮从未深查的面（substrate `src/enrichment/` 子目录六件 1469 行、metrics.ts、corpus.ts、pending.ts、kinds/、read-epoch.ts、io-probes.ts；mcp git/ 六件、errors.ts、config.ts、binding.ts、server.ts、main.ts）。三路并行子代理（substrate / mcp / 测试+脚本+文档）+ 主会话 rg 亲验全部 Strong 与 Worth exploring 级发现的消费者证据——其中一件子代理提报被主会话**证伪**（RelationGraph 读面，见否决清单），一件修正（K3 广告面 diff 实为零，见 C16②）。

**总判**：本轮**无 Strong 级结构候选**。两轮收割后，代码面的主病（浅 module / 手抄仪式 / 同一知识多份家）已稀薄到卫生级；新发现集中在三类——①「面收窄」卫生批两票（C15/C16，均 Worth exploring、公开面零触碰或纯换装零 diff）；②S2 死码册**补遗**四件（用户已裁另 effort，本轮只补证据不重裁）；③六票批连带锚点残件与散文漂移一票修字批（S6，内含 2 件 Strong 级事实错误）。真正的结构前沿在 KG/memory 票线（map #125，frontier #151），不在巡检轴——见「首推」节明示。**三票收束（同日）**：C15/C16/S6 已落地（终态 substrate 449），详见候选总览行标、各节首核验注记与首推收束注记。

**已排除**（不重提）：承前两轮全部——首轮 C1–C8、S1（map #88/#95/#106/#113/#118）；S3/S4 余件（#137）；C9/C10（map #139）；C11–C14（#144–#147）；S5（#149）；第二轮否决清单与 ADR/map Out-of-scope 停放项照册（C8.1 concepts 进 epoch、index.ts 分块硬顶 1550〔现 1537，余量 13〕、epoch 外自由函数、epoch 可观测性、注销缓存淘汰、多 session、跨 scope 参考、域模板、run_enrichment 编排下沉、snapshot.ts/schema-provider.ts 暂缓区）；**S2 死码七件+拍板项**（用户裁决另 effort——本轮只补册，见 §S2 补遗）；Speculative 尾巴两件（dry_run `staged` 键 / scratch 钳制双写——现状核实**均未动**，import.ts:497 现址、scratch.ts:108/:160）；KG/memory 票线一切主题（map #125：frontier #151，#136/#152/#154/#155 被挡；ADR-0021..0026 的 memory 存储/晋升/读面/已验证查询/悬空锚点/休眠槽/图节点 id 归该线）。

## 候选总览

| # | 候选 | 区域 | 强度 |
|---|---|---|---|
| C15 | enrichment 收编面死名批：自由 `discoverAltLabels` 合并包装器（生产死码）+ 收编面六个零消费名（四适配器值 / `SweepResult` / `discoverEventRelationsFor`，连带 :159 整行 `sweepEnrichment`） | substrate | **Worth exploring（首推之一）· 已落地**（[#160](https://github.com/McKenzieIT/semantic-grounding/issues/160)，2026-10-15 `d66a13a`：合并器+六死名删〔combined describe 实为 1 it，substrate 450→449〕；**sweepEnrichment 留存 = 本报告证据勘误**，见节首注记） |
| C16 | update 路径三件套错居迁 `write.ts`（`applyFieldUpdate`/`assertUpdateOk`/`ApplyResult`）+ `apply_enrichment` Tier-2 参数约束两行手抄改单家 | mcp | **Worth exploring（首推之一，#145 体例）· 已落地**（[#161](https://github.com/McKenzieIT/semantic-grounding/issues/161)，2026-10-15 `582cb39`：字节级迁移 + 约束单家化；**广告面「零 diff」口径勘误为 +2 description 键**，见节首注记） |
| S2 补遗 | 死码册新增：`JSONRPC_RESERVED_RANGE`（**Strong 单件**，零消费者）/ `INTENT_TOOL_NAMES`+`INTENT_TOOL_REGISTRARS` / `loadMetricDefinitions` 别名 / `TableMetaSchema` export 死键 | 混合 | **并入 S2 议题单（用户已裁另 effort），不独立开票** |
| S6 | 文档/锚点漂移新增批 13 件：spec 自述对账 ×2（Strong）· ADR 锚点死符号/迁家残件 ×3 · 头注路径/行号锚/时态 ×3 · metrics 文档债 ×3 · tests/README 计数 · enrichment.ts 自注第二实例 | docs | Strong 2 + 修字 11（一票批，#148 体例）· **已落地**（[#162](https://github.com/McKenzieIT/semantic-grounding/issues/162)，2026-10-15 `ebf0e99`：13 件全清 rg 旧值清零；第 5 件实测锚 `itemSuppressionFieldName`） |

Speculative 尾巴（不占编号）：承前两件未动（dry_run `staged` 键、scratch 钳制双写）+ 本轮新增三件——`SCOPE_ID_PATTERN` 错误文案第二家（shared.ts:98，#149 刚钉稳的线）、config 四联数值校验器同构（config.ts:386-460）、`subjectKey`≡`resultKey` 恒等对（io.ts:976-978）——详见尾注。

---

## C15 · enrichment 收编面死名批（Worth exploring）

> **落地核验（2026-10-15，合入 `d66a13a`）**：自由 `discoverAltLabels` 本体 + combined describe（实测 **1 个 it**，substrate 450→**449**）+ 六死名（四适配器值 / `SweepResult` / `discoverEventRelationsFor`）全删；sweep.ts 头注诚实化照处方；barrel index.ts 零 diff、must-stay-absent 名单原样成立；四门禁 worktree 与合入态两跑全绿（mcp 437+1skip / e2e 22 不变）。**本节证据勘误**：原文称「:159 整行可删——sweepEnrichment 的消费者同样全在家族内直连」**不成立**——`tests/sweep.spec.ts:23` 经 `../src/enrichment.ts` 具名 import `sweepEnrichment`，引擎不变量 describe（:73-172）内 ~15 处直呼，该 spec 头注自认 subject 即它。该名**留存**（#160 worktree 裁量按「证据错则停」预案执行，主会话抽验确认）；若日后要收，需先迁 sweep.spec 的 import 落点，超出本票改动面。

**文件**：`packages/substrate/src/enrichment/sweep.ts:114-127`（自由 `discoverAltLabels` 本体）· `src/enrichment.ts:133`（`discoverEventRelationsFor` re-export）· `:149-157`（四适配器值 re-export）· `:159`（`sweepEnrichment, discoverAltLabels, type SweepResult` 整行 re-export）· 唯一消费者 `tests/alt-labels-enrichment.spec.ts:19/:254-284`（combined describe）。

**Before** —— 两层死面叠着：

1. **合并包装器**：13 行的「表+事件别名双扫合并」便利入口，生产调用方已被 ADR-0007 判死——call-wide 维度语义需要 per-leg 调用（省略维度 = 该维度 OUT），合并器的 omit=everything 契约无法表达；`index.ts:101-104` 码内自认 "The free `discoverAltLabels` combined wrapper is no longer called from here"。Core.discoverAltLabels（index.ts:785）亲自组两条 per-leg 调用。全仓唯一调用点 = spec :284 一处（主会话亲验：MCP run_enrichment 路径走的是 Core 类方法，read-count-probe.spec:255 的提及是类方法叙事）。
2. **收编面死名**：「本模块是唯一 import 路径」（ADR-0002）的收编面上，`tableAltLabelsAdapter`/`tableRelationsAdapter`/`eventAltLabelsAdapter`/`eventRelationsAdapter` 四个值与 `SweepResult`/`discoverEventRelationsFor` 两个名**没有任何人从这里拿过**——适配器唯二消费者是各自同文件内的 `sweepEnrichment(xxxAdapter, …)` 直连（table-adapter.ts:83/:192、event-adapter.ts:78/:166），sweep.spec 的命中全是 `describe.each` 标题字符串（实际驱动走 `enrichAll*` 自由函数）；`SweepResult` 零具名 import；`discoverEventRelationsFor` 家族内直连（event-adapter.ts:23/:113），与表侧兄弟 `discoverRelationsFor`（被 tests/enrichment.spec.ts:14 经收编面消费）不对称。连带：`enrichment.ts:159` 整行三名可删（`sweepEnrichment` 的消费者同样全在家族内直连）。

**After（plain english）** —— 删合并包装器（连带 spec 的 combined describe）+ 收编面收窄到活名。大白话：表/事件各自的 per-leg 函数就是全部真相，没人走的门就拆掉，牌子上只留活着的名字。

- deletion test：**集中**——per-leg 函数、sweep 引擎、适配器全部原位不动，纯减名字和一层零行为包装；
- 公开面零触碰：这些名本就不在 barrel（check-tarball-acceptance.mjs:326 的 must-stay-**absent** 列表钉着，删后缺席仍成立）——barrel 27+default 不动；
- substrate 基线随 spec 删件下修（450 − combined describe 实测 it 数，票面声明）。

**ADR**：无冲突——ADR-0002/0006 ruling 3 的 seam 设计（adapters+engine 模块级、永不上根 barrel）不动，收的只是收编面的展示名。sweep.ts:10-11 头注「free functions are the public contract…dsh depend on them」对**合并器这一个函数**不成立（包 exports 仅 `.`，dsh 只能走 barrel；on-write hook 依赖的是 `enrichAll*` 家族）——拆门时该行注释顺带诚实化。

## C16 · update 路径三件套错居 + Tier-2 参数约束手抄（Worth exploring，#145 体例顺手批）

> **落地核验（2026-10-15，合入 `582cb39`）**：三件套字节级迁 write.ts（迁体对基线 `cmp` 逐字节相同；audited.ts 回归纯仪式面、shared.ts 头注口径改窄并记 #145/#161 两次迁出史）；约束换装 SummarySchema/ConfidenceSchema import 消费；ADR-0012 末尾补 dated Update（行号历史保留）；errors.ts:607 假锚 3 词修正随票（#145 先例连带）。四门禁两跑全绿（四数字不变）。**本节口径勘误**：原文「纯换装零 tools/list 广告面 diff——SummarySchema 本体不带 .describe」**不成立**——`SummarySchema`/`ConfidenceSchema` 定义自带 `.describe`（shared.ts:59-60/:74-75，zod 4.6.5 toJSONSchema 会输出 description）。real wire 探针（McpServer + InMemoryTransport + 构建产物 `tools/list`）实测：约束面逐字相同，唯一差异 = apply_enrichment 广告**新增 2 个 description 键**（内容 = 单家原文）——方向是对齐其余 commit-class 工具的既有统一口径（add_alias/import_definitions 等同侪本就带此二 description），catalog/e2e 零涟漪。票面预期错、结构目标（约束单家化）完整达成。

**文件**：`packages/mcp/src/tools/audited.ts:372`（`applyFieldUpdate`）· `tools/shared.ts:438`（`ApplyResult` 类型）· `:460`（`assertUpdateOk`）· 唯一生产消费者 `tools/write.ts:196/:198`（update_definition handler）；另 `tools/enrichment.ts:237-238`（约束手抄）↔ `tools/shared.ts:59/:74`（`SummarySchema`/`ConfidenceSchema` 单家）。

**Before** —— #145 刚把 audited.ts/shared.ts 清成「纯仪式 / 跨家族」，两处残留：

1. **三件套错居**：`applyFieldUpdate` 的 JSDoc 自述其存在是绕 `auditedWrite` 泛型对三元表达式推断的 workaround——一个**单工具的**类型推断细节驻在仪式面；`assertUpdateOk` 与其类型 `ApplyResult` 驻在 shared.ts，违反该文件「Every member here is cross-family by contract」的头注宣称（audited.ts:60 对 `ApplyResult` 的 import 仅为 `applyFieldUpdate` 签名服务）——#145 治过的病在 letter 上复发。主会话亲验：三符号生产消费各一处、均在 write.ts。
2. **约束手抄**：ADR-0005 ruling 7 的公共 Tier-2 参数块（summary 1–100 / confidence 0–1）单家在 shared.ts，29 个工具里 `apply_enrichment` 是唯一手抄现场，且**同一个 input 对象**的 `scope_id` 用的是 import 来的 `ScopeIdSchema`——同块两种口径，界若改它静默漂移。

**After（plain english）** —— 三符号迁 write.ts（update_definition 的工具文件自己拥有它的 update 分发与失败判别；audited.ts 回归纯仪式面，shared.ts 头注口径改窄）；两行改 import `SummarySchema`/`ConfidenceSchema`。**主会话修正子代理口径**：纯换装**零 tools/list 广告面 diff**——`SummarySchema` 裸用不带 `.describe`（shared.ts:105 同款先例；import.ts:134 的文案是该调用点自加，非换装必带），zod JSON Schema 输出逐字相同。

- deletion test：①是搬家非删除（#145 移动类同款），判据是模块契约恢复为真；②过（去重非删行为，约束零变化）；
- 机械、字节级可迁、零测试涟漪（tests/scripts 零直接 import，主会话亲验）。

**ADR**：ADR-0012 以 file:line 引过两处位置（:114-115 audited.ts:161 / shared.ts:331、:175-180）——行号本已漂（现址 :372/:460），迁移时顺改内容锚或加一行 Update 注记，票面声明即可。

## S2 补遗 · 死码册新增四件（并入 S2 议题单，用户已裁另 effort——不重裁不独立开票）

| 条目 | 位置 | 证据（主会话 rg 亲验） |
|---|---|---|
| `JSONRPC_RESERVED_RANGE` | mcp errors.ts:133 → barrel src/index.ts:91 | 全仓唯二行（定义+re-export），**零消费者**——区间知识已在 errors.ts 头注散文，码段分配全以字面量完成。**Strong 直删级单件**（连「公共面保留」故事都没有） |
| `INTENT_TOOL_NAMES` / `INTENT_TOOL_REGISTRARS` | mcp tools/index.ts:69/:72 → barrel :111-112 | 派生完即无人读；唯一提及 = harness :147 历史注释（pre-#57 叙事）。保留论据「intent 子面 embedding host」与 DERIVATIONS 同型，归 S2 拍板 |
| `loadMetricDefinitions` | substrate metrics.ts:223 | 纯别名包装（真身 `extractMetricsFromTables`），本体 = 1 行 return + 12 行 JSDoc；唯一消费 k11-graph.spec.ts:16/:32；index.ts:205 注释自认 S1.5 后 "no host ever imported the free functions"——与册上 `loadDomains` **完全同型** |
| `TableMetaSchema` export 键 | substrate types.ts:333 | 值零消费者（仅 :340 `z.infer` 类型锚 + tarball 缺席断言 :334）；微件捎带一词 |

barrel 面合计：DERIVATIONS（册上原件）+ 新三名 → S2 开票时 **27+default → 23**，v01 公共面收窄票面声明。

**子代理提报、主会话证伪、不入册**：RelationGraph 读面（findJoinPath/getRelated/resolveAlias/getAliases）+ `Core.getRelationGraph()` 曾被报「纯测试面」——实为**生产活面**：mcp read.ts:269/:294/:318 三工具（get_join_path / get_related / resolve_alias）直接消费（子代理 rg 漏检，主会话补验抓回）。graphCache/graphVersion/danglingDomainRefs 收集链随之全部健康。S2 册原有「getDerived/getJoinCondition 生产消费仅 vendor」两条不受影响。

## S6 · 文档/锚点漂移新增批（13 件——一票修字，#148 体例）

> **落地核验（2026-10-15，合入 `ebf0e99`）**：13 件全清、rg 逐项旧值清零、纯修字零断言改动。第 5 件实测锚 = `item-write.ts:128 itemSuppressionFieldName`（票面未给符号，落地时 rg 定位；同行 items.ts 行号锚改内容锚）；带日期 ADR Update 史料「30 tests」/check-core-purity「269」（本报告明文史料豁免）/k11 活断言「321」/上游仓 examples/ 记述按票面豁免保留；第 1/12 件派生表述落位（防 #160 计数下修的跨票陈旧预判成立）。本票分支基线 450（合入终态 449 系 #160 所致）。

**Strong（事实错误，导读者）**：

1. **intent-tools-items.spec.ts:6-7「30 tests」** —— 实测 `item-write.spec.ts` = **40** its（零 it.each，静态数即运行数；#109/#122/#147 追加未跟，头注写定于 #49）。跨文件计数断言式自述，读者会低估 10 个测。改派生表述。
2. **playbook.spec.ts:5「Three groups」** —— 实际 **四** 个 describe：:298 `R7 shape sanity` 不在头注枚举内，出生即漏（与头注同源 #63 `0ee4a08`）。补第 4 条或改派生措辞。

**Worth exploring（ADR 锚点——六票批连带）**：

3. **ADR-0020:41/:84 仍指 `tools/shared.ts#pendingQueueRoot`** —— #145 已迁 `tools/suggestions.ts:56`（代码注释已改、ADR 没跟）；按名索骥去 shared.ts 找放置论证会扑空。一词修订。
4. **ADR-0011:138/:228 仍引已退役的 `assertScopeIdShape`** —— #149 删除后全 src 零命中；ADR-0011 已有 Update 节先例，#149 未追加。死符号引用（比行号漂移重一档）。补一小节 Update。
5. **ADR-0010:108 引死符号 `suppressionFieldName`（items.ts:111）** —— 全仓零命中，生死于 #49（item 语义沉 Core）；同行其余锚符号仍活仅行号漂。改指现居所（substrate item-write.ts 否决字段映射）或加〔已迁〕注记。

**Worth exploring（spec/注释漂移）**：

6. **k11-seed.spec.ts:3 头注指向不存在的 `examples/k11-semantic-layer/`** —— 实际加载 `tests/fixtures/k11`（:23），仓内无 examples/ 目录，移植残留。一词。
7. **bump-completeness.spec.ts:10-12 行号锚漂** —— `io.ts:707/717/722` → 实际 **763/774/779**（C8.2/C10 收 seam 插行所致）；行为宣称仍真。改内容锚或刷新。
8. **server-startup.spec.ts:18-19「future coverage」时态已兑现** —— scope-tools.spec 已覆盖 register/switch；「将来时」自注同 enrichment.ts:26-27 genre。一词。

**Speculative（文档债，与已知顺手件并批）**：

9. **metrics.ts:71-73 JSDoc 引幽灵类** —— "Used by `SemanticLayerService.loadMetricDefinition`…"：`SemanticLayerService` 全仓零定义（tarball :264 钉 absent）；真消费者是 Core.loadMetricDefinition（index.ts:1035）+ snapshot.ts:123。宣称半边不符。
10. **enrichment.ts:120-121 过时自注第二实例** —— 已知顺手件只记了 :26-27（"#67 then deletes…pure barrel"将来时）；:120-121 同句在收编块前又写一遍。修票需两处同改，否则只清一半。
11. **metrics.ts:55「the 321 tables」硬计数** —— S3 家族 substrate 侧新实例（#148 七件全在 mcp/docs）；同文件区隔壁 enrichment.ts:50 还有「579-item corpus」（#30 溯源叙述）。改派生表述或带日期实测口径。

**已知顺手件并册（现状核实未动）**：

12. tests/README.md:2-3「20 spec files, 269 tests」→ 现值 **28 文件 / 450 测**（当日亲跑）。
13. substrate src/enrichment.ts:26-27 过时自注（与第 10 件同票两处同改）。

---

## 两轴重叠对照

| 本轮 | 关联 | 相同内容 | 处置 |
|---|---|---|---|
| C15 | S2 `loadDomains` / `toExecutableRule` | 单 spec 消费者 + 码内自认过时的直删级 | 归 **C15** 独立票（含行为 spec describe 删除，比 S2 直删件多一步基线下修声明） |
| C16① | C12/#145 | 单消费者成员错居、「跨家族」契约违反复发 | 归 **C16**（#145 体例机械迁） |
| S6 | #148/S3 | 计数散文、自述对账、过时自注 | 同型批，照 #148 体例一票修 |
| S2 补遗 | S2 册 DERIVATIONS 判据 | 「连自家模块都不消费」 | 并册，S2 开票时带上（barrel 27→23 票面声明） |

## 简化轴否决清单（查过，勿重查）

**本轮新增**：

- **RelationGraph 读面 + `Core.getRelationGraph()` 纯测试面**（子代理提报）——**主会话证伪**：read.ts:269/:294/:318 三工具生产消费（get_join_path / get_related / resolve_alias）；vendor/nl2sql-ontology 的消费归 S2 册 vendor 项自身。图读面、graphCache、danglingDomainRefs 收集链全部健康。
- table/event 适配器镜像收拢——差异全是真 per-kind 知识（写面原语、DWS-only 过滤、字段名、parse-then-filter 顺序），map #64 seam 设计意图；「no DIM tables in scope」文案两抄属适配器数据各安其家。
- sweep.ts 引擎（127 行单入口、四条引擎不变量全在体内）——deep module，文档宣称与形状逐条相符。
- kinds/ 三插件 derivedNodes 布线同构——装配数据非知识重复（承二轮事实注记，复核仍真）；`getId` 归 S2 册。
- binding.ts `scopeCountsOrThrow`(:305) ↔ `assertScopeLoadable`(:332) 两现场载入梯子——返回值不同、错误前缀刻意分家（register 时无 scope id 可名）、lenient/schema-valid 双轨文档化（guidance.ts:32-35）。
- switchTo 里 Core 构造后再载三族——性能/行为注记非结构轴。
- write.ts create_definition 三分支——存在检查半区已被 #144 `loadWritable` 收走，剩余是各 kind 原语+错误文案的真差异。
- read.ts `TABLE_STORAGE_KINDS` 枚举 vs guidance by-elimination——filter 要前向兼容未知 kind、count 要默认桶，双向各有 JSDoc 论证；substrate 枚举不在 barrel（ADR-0003 锁）无法 import。
- errors.ts 段位账本散文头（:24-36）与四张码表——18 类发射点逐项对账（intent 五/enrichment 一/scope 六/git 六）全对上、无空段无失配，不立件。
- recorder.ts 全文（726 行）——无浅 module；`commitDerivedResidue` 手拼 CommitContext 是 derived commit 刻意不渗 per-call 值的语义差异，合并需先裁「确定性 commit 带哪些 trailer」非免费。
- barrel 其余名（TRAILER_PREFIX、三张错误码表、posture/identity 块）——外部 embedding 面语义（全仓零 `from '@semantic-grounding/mcp'`），不满足 DERIVATIONS「连自家模块都不消费」判据。
- shared.ts 等模块「导出无仓内消费者」词表/构建件批（DerivationSchema、ExpectedVersionSchema、RelationTarget 族 schemas、ratioGuardFindings、SCOPE_SCAFFOLD_NEXT_STEPS、scratch 全套、enrichment-work.ts 的 CAP/WorkRound/WorkKind）——价值在一处定义而非多处 import，去 export 是零行为卫生批，低于噪音线。
- `enrichAll*` 家族、metrics 投影家族（inferAggregation…extractMetricsFrom{Table,Event}）、corpus.ts（buildRetrievalCorpus 活、isPlainObject 三家消费、头注 No-runtime-dep 自明）、pending.ts 四操作、read-epoch.ts、io-probes.ts——全活，消费链完整。
- posture.ts:203 `ConstructorParameters<typeof CorpusLock>[2]` 代具名 Options——一行润色级。
- scope.ts:158 register 门 `logger: () => {}` 吞掉裁决 6 的响亮恢复日志——行为观察非简化轴，列档 grilling/行为线。
- import.ts 三处 verdict row 塑形——键集真不同，#144 已收同构半边。
- **29 工具 .describe() 新批次抽查（write 三件 / read 五件 / playbook / suggestions 四件 / scope 六件 / enrichment 四件）无 #133 级漂移**（run 的 kind:dim 门+分区列排除+非空 PK 共列名 = relations.ts:106/:260 亲核；suggestions oldest-first = pending.ts:138 亲核）。
- 测试拓扑：mcp 全 spec 无重名 helper（versionOf/tier2/toolJson/toolOutcome/fixtureTable 均单点住 helpers/）；e2e 阶段号 0–7 无重号（4.5/4.6 已改）；step 22 处；commitCount(root) 参数化带 #146 出处注。
- 文档面对账全中：仓根 README 7 flag 行与 config.ts OPTIONS 逐一（缺省 50/0.5/10）、CLAUDE.md 基线节六数字、mcp-dogfood 更正块、GLOSSARY 全词条、multi-machine-corpus、data-memory-scenarios 代码事实（list_definitions 返回形、check-relay 未出生）、docs/agents/ 四件。
- 脚本四件自述诚实：check-core-purity「269 tests」为 slice-1 史料豁免；check-tarball-acceptance EXPECTED_RUNTIME_NAMES 27+default 对账 ✓；migrate-k11 一次性审计轨迹。

**前两轮清单全部照册未重查**（`git show b5c86df:docs/architecture-review-2026-10-14.md` 否决清单两段）。

## 事实注记（不作为候选）

- **域范围勘误**：`src/enrichment/` 子目录（六文件 1469 行：relations 479 / alt-labels 323 / table-adapter 198 / event-adapter 172 / types 170 / sweep 127）在前两轮的盘点面里隐没——`enrichment.ts`（168 行）只是它的收编 barrel，前两轮健康区只覆盖了「sweep engine + types」；本轮全量扫入（健康面见下）。
- **脚本面勘误**：mcp scripts/ 实为**一件**（check-e2e-loop.ts，现 **1231** 行非 1206——#146 收编净增）；第二轮否决清单「mcp scripts/ 仅四件」应读作全仓 arbiter 脚本四件（mcp 1 + substrate 3）。
- **ADR-0011 双编号系列**：代码 "constant 6"（溯源 #45 设计常数 #6 = charset）与 ADR-0011 自己的裁决表编号（裁决 10，:227「常数 10」）并存、同指一条 regex——#149 未引入新漂移，记档不列件。
- **ADR-0012 行号锚漂**（audited.ts:161→:372、shared.ts:331→:460）——纯行号漂由环境坑「内容 rg 为准」覆盖；C16 若迁移则连带符号居所变化，票面带 Update 注记。
- index.ts **1537** / 硬顶 1550（余量 13，安全带内）。
- Speculative 新三件详注：**K4** `ScopeIdPattern` 文案——shared.ts:98 zod message 硬编码 regex 文本而 :97 才 import 了真身（#149「文案逐字不动」保下来的线，动需票面声明）；**K5** config 四联校验器（parseLockTimeout/parseWarnThreshold/parseRatioThreshold/parseRatioFloor，config.ts:386-460 各 ~13 行同骨架）——每件 JSDoc 各钉一条 ADR 裁决（R5 为何 0 合法、拒而不钳、单位教训），seam 化会把裁决挪离执法点，等第 5 个 flag 出现再启；**D** `UpdateMetaDescriptor.subjectKey`≡`resultKey` 三描述符恒等对（io.ts:976-978/:1060/:1106/:1217）——两键分属审计线与公开回执面（ADR-0005/#106），恒等是约定非必然，保留两字段是对两个面的诚实表达。

## 首推

> **收束注记（2026-10-15）**：处方三票全部落地——#160 `d66a13a` / #161 `582cb39` / #162 `ebf0e99`（subagent worktree 三路并行、主会话串行合入；终态基线 typecheck 双包 0 / substrate **449**〔#160 删 1 直测〕/ mcp 437+1skip / e2e 22〔banner 29〕，合入态亲跑）。两处本报告证据/口径勘误随落地入档（C15 `sweepEnrichment` 收编面消费实证留存、C16 广告面 +2 description 键对齐 commit-class 口径，见各节首注记）。唯 S2 补遗四件待用户另 effort 开票时并入（barrel 27→23 票面声明）。

> **残件复核批（2026-10-15，#163 `55003ee`）**：code-simplifier 双 subagent 对三日审计窗口（`e6607fa..c602434`，99 文件 +6580/−5292）做「收后残件」全量复核——#160 漏网类型半区（enrichment.ts 六死类型 re-export 删；sweepEnrichment 勘误边界守住）/ #161 漏网孪生（`assertNoRedirectedFields`+三 `*_ARRAY_REF_REDIRECT` 迁 write.ts，「shared = 跨家族」契约归真）/ #122 孤儿 helper `readLayerFile` 删；主会话中央核验拦 subagent 两笔越线（误删 sweepEnrichment、utf8 顺手改）；四门禁亲跑四绿逐字对基线。报告项三件已开票处置（2026-10-15）：registry.ts:172 `toExecutableRule?` 退役（ADR-0003 Update 随票；:110 行并提的 `loadDomains` 经 #163 复核分家为活件不动）→ [#171](https://github.com/McKenzieIT/semantic-grounding/issues/171)；mcp shared.ts 头注 9 文件枚举（#162 遗留）+ ADR-0017 :10/:53 死链修字批 → [#172](https://github.com/McKenzieIT/semantic-grounding/issues/172)。两票已同日关票落地：#171 `24d7b06` / #172 `ac0402b`（同会话连跑，四门禁对基线逐字不动；acceptance 亲跑死于已知 npm-ENOENT 环境坑〔断言前〕，#171 名单主张改 `lib/index.d.ts` 层实证——类型名在册、字段 0 处）。

**本轮不开结构图**——无 Strong 级结构候选，两轮收割后巡检轴的 ROI 已让位于 KG/memory 票线（map #125，frontier #151 → #152 → #136/#154 → #155：图节点 id 统一、memory 存储+record_memory、晋升 trailer、读面挂载、已验证查询，ADR-0021..0026 全部已裁待落地）。处方三票，全部 standalone 体例：

1. **C15 + C16 两票**（可 subagent worktree 并行，照 #144–#149 体例）：验收全按 rg 单点 + 既有 spec 零改动全绿 + 公开面零变化（C15 barrel 缺席断言原样过 / C16 广告面零 diff 亲验口径）；C15 带 substrate 基线下修声明，C16 带 ADR-0012 锚点 Update 注记。
2. **S6 一票修字批**（照 #148 体例，13 件清单即票面）。
3. **S2 补遗四件不开票**——待用户另 effort 开 S2 时并入议题单（barrel 27→23 票面声明 + INTENT_* 双名与 DERIVATIONS 同拍）。

## 健康区清单（勿重扫）

前两轮清单全部延续（见 `git show b5c86df:docs/architecture-review-2026-10-14.md` 健康区两段）。**本轮新增**：

- enrichment/ 家族：sweep.ts 引擎（单入口四不变量）、relations.ts / alt-labels.ts 纯函数面、table/event 适配器（差异 = 真 per-kind 知识）。
- metrics.ts 投影家族全活（kind 插件 derivedNodes + index.ts + snapshot.ts 消费链）；corpus.ts、pending.ts、read-epoch.ts、io-probes.ts。
- mcp git/ 六件：exec 三函数 seam、lock 双信号、posture 四格表、message 折行单点、recorder 分层注释自洽（726 行无浅 module）、identity。
- errors.ts 段位账本：18 类发射点逐项对账无空段无失配。
- RelationGraph 读面（子代理误报证伪后确认健康：三 mcp 工具生产消费）。
- 29 工具描述面新批次抽查（六族）无漂移；CLAUDE.md 基线节六数字对账全中；e2e 阶段号/步数叙事零漂移。

---

*证据均带 file:line，锚 `main b5c86df` 已提交树。Strong 与 Worth exploring 级发现全部经主会话 rg 亲验（含一次证伪、一次口径修正）；S6-7/S6-8 与 Speculative 三件为子代理证据 + 主会话抽核。四门禁当日亲跑全绿，四数字与 CLAUDE.md 对账见文首基线；第二轮报告已随本轮删除，回查方式见文首。*

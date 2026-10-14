# ADR-0005: MCP tool surface —— intent 工具、审计原语、trailer 独扛 authorship

- **Status**: accepted
- **Date**: 2026-10-09
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0002（公共面规则——本票零新名，规则集未动用）、ADR-0004（裁决 8 指纹基线、裁决 10 subject 模式的输入）、[map #12](https://github.com/McKenzieIT/semantic-grounding/issues/12)、设计票 [#15](https://github.com/McKenzieIT/semantic-grounding/issues/15)

## Context

map #12 的目的地要求工作 agent 经 MCP 读 grounding、经 Tier-2 审计写路径写回 definition /
relation / alias。#13 落定了审计主干（ADR-0004），其中三项输入留给本票：`expected_version`
的强制面、`X-SG-Derivation` / `X-SG-Confidence` 的取值域、工具名进 commit subject 所隐含的
命名设计。工具面是 agent 的全部 UX，也是审计史可读性的第一现场——名字一旦进 commit subject，
再改就是在改写历史的语义。十项裁决，各关闭一个取舍：

| # | 维度 | 裁决 | 关闭的取舍 |
|---|---|---|---|
| 1 | 塑形 | **intent 工具集**：packages/mcp 薄包装、一意图一工具、zod 收紧 schema；barrel 函数不透传；raw 原语（writeTable/writeEventYaml）**不作工具出现** | 透传面——agent 的 schema 即提示词，任意 updates dict 出错率高；`update_table_meta(dws_order): updates={…}` 在 git log 里是噪音，裁决 10 落空 |
| 2 | 写侧清单 | definition 级 `create_definition` / `update_definition` + 条目级 `add_alias` / `remove_alias` / `add_relation` / `remove_relation` + Tier-1 四件套 `submit_suggestion` / `list_suggestions` / `get_suggestion` / `discard_suggestion`，共十 | 复合 `set_*(op)` 动词（subject 语义模糊：增和删在审计史里就该是两种 commit）；concept 写路径（无 Tier-2 函数、无写原语——v1 全程只读，与 Q2 边界一致） |
| 3 | 条目级语义 | add/remove 在 **server 锁内**做读改写（append / 移除单条），不暴露全量数组替换 | agent 侧 read-modify-write：浅合并整字段覆盖会在两次调用之间砸掉并发写入——恰是整仓锁防不住的那类丢更新（ADR-0004 裁决 8 所指） |
| 4 | 有界通用 | `update_definition` 的 fields 以 zod 枚举收界：**拒绝**身份字段（table_name/name/kind）与数组引用字段（alt_labels / dimension_refs / external_refs——报错指路对应 intent 工具）；其余 kind schema 字段放行 | 「任意 updates dict」的第二扇门：双门即双险，条目级防线可被绕过 |
| 5 | 创建路径 | `create_definition(kind: table\|event)` 编译到 writeTable/writeEventYaml + **必传** recorder（ADR-0004 裁决 2 的「MCP host 全链路必传」，#18 后形态）；输入 schema 复用 `TableDefinitionSchema` / `EventDefinitionSchema` | `sync_tables`：TableMeta 断言引擎观测，agent 手搓 = provenance 造假，随 live-engine 接入（S1.3 暂缓项，触发条件见 ADR-0017；原措辞「SchemaProvider 接线·未来宿主姿态」已勘误）另行成票；concept 创建同裁决 2 排除 |
| 6 | 读侧清单 | `search_definitions(query, top_k?, kinds?)` / `get_definition(kind, name)` / `get_join_path(from, to)` / `get_relations(target, type?)` / `resolve_alias(term)`，共五；**version（sha256 指纹）只在 get_definition 返回**——搜索摘要不作写前提 | 复合 context 工具（三原语可组合，stdio 往返便宜）；list 全量倾倒（321 表 verbatim 非 agent 所需）；快照句柄（2026-07-28 协议无状态 + 写已串行，grounding 读不需要 MVCC；〔2026-10-13 立项根勘误，ADR-0017：原「那是 dsh 执行查询的需要」受众已断——拒绝理由自立于前两点，snapshot 记 S1.1 暂缓项，触发条件 = 跨调用一致性读需求立项〕） |
| 7 | 公共参数块 | 五个 Tier-2 工具统一 `{summary(必, 1–100 字符), derivation(枚举 agent\|llm, 必, 无默认), confidence(必, float 0–1), expected_version}`；expected_version **更新类必传 / 创建免传 / Tier-1 无此参**（采纳 #13 建议，落到五个更新类工具）；工具**无 scope 参数**（charting：v1 一进程一 corpus 一 scope） | derivation 全三值（`deterministic` 是 server 内部流类别，工具面不可达——给 agent 开误报之门）；可选 confidence（trailer 槽位无条件存在，宁要如实粗估不要缺省） |
| 8 | 响应契约 | 统一 `{commit, changed, enrichment_health?}`：`changed:false` = 幂等空转（alias 已存在等）**不产 commit**；`enrichment_health` 内联自 `getEnrichmentHealth()`（刚写完即见，无竞态）；错误可判别：`stale_baseline`（锁内指纹不符，重读重试）/ 锁超时 / 校验失败，码值归实现票（研究票定段：JSON-RPC 保留区外） | 独立 health 读工具（存在竞态且多一次往返）；server 自拼 summary（只有字段回声，没有「依据什么」） |
| 9 | origin 语义 | 工具写**省略** YAML `origin`——undefined 在合并优先级（`ORIGIN_PRIORITY ?? 2`）与 preserve-filter（`origin === 'manual' \|\| null`）两处**实测**按 curated 对待，agent 精选 ref 今日即获「不被轮覆盖」保护，零 substrate 改动；authorship 只归 trailer | 枚举加 `'agent'`：preserve-filter 精确匹配 manual/null，天真扩展反被轮吃掉；复用 `'manual'`：语义漂移；YAML 再记 authorship：状态与历史两个可不一致的数据集（裁决 4/5 反对的形状） |
| 10 | 名字冲突 | 工具参数 `derivation` 专指 trailer 类别；`DimensionRef.derivation`（YAML 自由文本依据注记）**不开**工具参数，agent 依据进 commit summary | 同名双写：agent 困惑 + trailer 枚举与自由文本互相污染 |

## Decision

采纳全部十项。工具面 = **读五 + 写十共十五个 intent 工具**，动词层级为 definition 级
`create_`/`update_`、条目级 `add_`/`remove_`；Tier-2 编译目标全部是既有 core 方法
（`writeTable` / `writeEventYaml` 公共原语 + `updateTableMeta` / `updateEventMeta` 等 Core
同名方法；〔2026-10-13 口径勘误，ADR-0017：原「既有公共面」的 barrel 自由函数形态已随
S1.5/#85 收名留码，编译目标与行为未变〕），Tier-1 编译到 pending 四件套——**root barrel
零新名，ADR-0002 规则集未动用**。

两个概念澄清随本票固化（GLOSSARY 同步）：YAML `origin` 是 **enrichment 合并优先级机制**，
trailer `X-SG-Derivation` 是**提交归属类别**——两者同名相邻实为两类概念，对齐它们是范畴错误；
git backbone 下「谁写的、依据什么」由 commit + trailer + `git log -p --follow` 回答，YAML 不重复记录。

## Consequences

- commit subject 的 `<tool>` 段即审计动词表：`create_definition(dim_shop): 新表首次落地`、
  `add_alias(dws_order): 添加别名「订单宽表」`——十五个名字就是审计史的动词表，改名=改写历史语义。
- `remove_relation` 删 round 出身（deterministic/llm）的 ref **不持久**：下一轮 enrichment 会
  重新推导回来（deterministic 的必然重加）。agent 持久否决权（tombstone / 负知识）是新机制，
  v1 不做；**触发条件：dogfood 中出现 agent 与 enrichment 轮的写-删循环时成票**。
- Followup（各有触发条件，不预做）：复合 `get_context`（dogfood 摩擦显著时）、
  `list_definitions` 全量（审计扫描类场景出现时）、`sync_tables`（live-engine 接入立项时，
  S1.3 暂缓项——原「SchemaProvider 接线时」措辞已勘误，ADR-0017）。
- dsh 不受影响：工具面全在 packages/mcp，substrate 契约零改动（对照 ADR-0004 的 #1–#3）。

## Verification

- 门禁脚本断言：十五个工具名与 input/output schema 快照；`stale_baseline` 错误的重读重试回路；
  幂等路径 `changed:false` 且无新 commit；写响应内联 `enrichment_health`；工具写省略 origin 的
  ref 经一轮 `enrichAll*` 后存活（preserve-filter 语义回归）。
- 真 agent dogfood 覆盖问数读路径（search → get → join_path / resolve_alias）与三写回。

## References

- 设计票 grilling 全记录：[#15](https://github.com/McKenzieIT/semantic-grounding/issues/15)
- 行为依据：`src/enrichment.ts:100-103`（origin 优先级）、`:317`（preserve-filter）、
  `src/io.ts:509/555`（浅合并实测）、`src/types.ts:190-198`（DimensionRefSchema）
- 协议约束（工具名字符集、错误码段位、无状态语义）：#14 研究，
  `research/mcp-2026-07-28-spec` 分支 → `docs/research/mcp-2026-07-28-spec.md`
- GLOSSARY：write tier、provenance、git recorder

## Update 2026-10-09 — #22 实测推翻两条输入（工具层错误码、clientInfo 来源）

落 [#22](https://github.com/McKenzieIT/semantic-grounding/issues/22)（server 骨架）时对
MCP TS SDK v2.3.1 做了实测探针，三条与本 ADR / ADR-0004 相关的前提需要更正。**都不是新裁决，
是前提证伪**——按本仓证据标准（`docs/agents/decision-framing.md`：执行前验证前提，含本仓 ticket
与 resolution 里记录的前提），记在这里是因为 #20 的会话会读本 ADR，不更正就会按已证伪的前提实现。

**1. `registerTool` 无法把错误码送上线。** 裁决 8 定了「错误可判别：`stale_baseline` / 锁超时 /
校验失败，码值归实现票」，ADR-0004 的 2026-10-09 addendum 据此把 `-31020..-31039` 分给 #20。
实测：`McpServer.registerTool` 的处理器抛出的**任何**异常都被 SDK 捕获并转成
`{content:[…], isError:true}` 的**结果**，`code` 字段被丢弃——携带 `code` 的 `ProtocolError(-31001)`、
`-32602`、裸 `Error` 三者在线上**完全无法区分**。能把 `-31xxx` 原样送上线的只有低层 seam
`server.server.setRequestHandler(...)`（实测原样透出 `{"code":-31001,…}`，不被消毒）。
另有两条相关事实：SDK 无 `McpError`，码值类是 `ProtocolError`；未知工具名**仍**产生真的 `-32602`。

给 #20 的后果（本票不裁，留 #20 作裁决）：要么工具错误改走 `setRequestHandler` 自行注册（代价：
绕开 `registerTool` 的 schema 校验与 `tools/list` 自动登记），要么错误契约改形状（判别信息进
`isError` 结果的结构化载荷，`-31xxx` 只服务非工具层）。**不可**直接按「抛 `SgApplicationError`
即得 `-31xxx` 错误响应」实现——那是今天读 ADR-0004 addendum 会得出的结论，而它是错的。

**2. `clientInfo` 是逐请求信封数据，不是启动通道数据。** ADR-0004 裁决 9 说
「clientInfo/session/scope 进 trailer」，`GitRecorderConfig.clientName` 据此做成了构造参数。
实测：`serveStdio` 工厂收到的 ctx **只有** `{era}`——无 clientInfo、无协议版本、无 scope、无
凭据（`authInfo`/`requestInfo` 是 HTTP 专用，stdio 永不填）。client 名字出现在**每次请求**的
`extra.mcpReq.envelope['io.modelcontextprotocol/clientInfo']`，且在**同一条连接上逐请求可变**
（实测两个名字由同一实例服务），并且是可选键（信封必填项只有 protocolVersion 与
clientCapabilities）。

给 #20 的后果：`X-SG-Client` 要如实，必须由工具处理器逐调用读信封、随 `AuditContext` 传进
`runAudited`——而 `AuditContext` 今天**没有** `clientName` 字段（只有 `sessionId` 覆盖槽）。
#22 因此**不**在启动时填 `clientName`：构造期填死一个值，等于把「某次请求的 client」冒充成
「本进程的 client」，正是裁决 9 拒绝默认身份的同一类失真。

**3. #22 不占 `-31xxx` 段位，这是分配表的确认而非缺口。** 配置与启动姿态的拒绝全部发生在
transport 连接**之前**，表现为进程退出码（`64` EX_USAGE / `78` EX_CONFIG），永不上线；所以
`config.ts` 的 `ConfigError` 故意**不**继承 `SgApplicationError`（那个基类的存在理由就是携带上线
的码值）。分段表保持 #19 / #20 / #21 三段不变。

## Update 2026-10-10 — #29 勘误：`structuredContent`/`outputSchema` 在 SDK v2.3.1 真实存在

落 [#31](https://github.com/McKenzieIT/semantic-grounding/issues/31)（map #27 执行票）时，研究票
[#29](https://github.com/McKenzieIT/semantic-grounding/issues/29)（喂 #30 的尺寸治理裁决）对 SDK
v2.3.1 dist 源码做了针对性探针，产出一条与此前操作性前提相抵触的实测事实。**不是新裁决，是前提
证伪**——与上一条 2026-10-09 Update 同一性质，记在这里是因为任何想用 `structuredContent`/
`outputSchema` 作元数据旁路的未来票都会先读本 ADR 的既往记录。

**`structuredContent` / `outputSchema` 在本 SDK era 真实存在且接线。** 本 ADR 与 ADR-0006 此前
对错误通道、响应契约的讨论（包括上一条 2026-10-09 Update 第 1 条对 `registerTool` 处理器输出的
分析）只枚举了 `content`/`isError` 两个字段，隐含了「`CallToolResult` 没有其他可用字段」的操作
性前提——这条前提是错的。实测（SDK v2.3.1 dist 源码一手）：SEP-2106 §4.3 的 text-fallback 条款、
era codec `projectCallToolResult`、`ToolSchema.outputSchema` 三处均确认该通道存在并接线。

**不改变裁决 8（响应契约统一 `{commit, changed, enrichment_health?}`，走 content JSON）**，也不
改变 ADR-0008（#31 新增，enrichment work 响应尺寸治理）裁决 2 的「元数据走 content JSON 顶层」。
两处裁决拒绝旁路通道的理由从来不是「通道不存在」，而是宿主消费链路未经实测、ADR-0006 的宿主中立
约束只依赖 `tools/call` 的最弱 client 形状——通道事实的更正不影响这些理由的有效性。本仓当前
`toolSuccess` 只发 `content` 文本，行为不受本勘误影响。

## Update 2026-10-10 — #38 落地：持久否决权（ADR-0010）+ 抽取器护栏收紧（ADR-0009）

落 [#38](https://github.com/McKenzieIT/semantic-grounding/issues/38)。本 ADR 的 Consequences
把 `remove_relation` 删 round 出身 ref 不持久的问题写成了一条带触发条件的 Followup——「agent 持久
否决权（tombstone / 负知识）是新机制，v1 不做；触发条件：dogfood 中出现 agent 与 enrichment 轮的
写-删循环时成票」。map #32 的 dogfood 踩中了这个条件：同一张表上 agent 连续 24 次删除同一个机器
派生的 ref，每次都被下一轮 enrichment 重新加回，没有任何回执告诉 agent 这是徒劳的。**不是前提
证伪，是触发条件已满足**——与上面两条 2026-10-09/2026-10-10 Update 不同性质，机制现在已经落地，
分两张新 ADR 记录，原 Consequences 段落原文保留不改，指向如下。

**1. 抽取器护栏收紧，先把问题规模缩小（[ADR-0009](./0009-extractor-guardrail.md)）。**
`discoverAltLabelsDeterministic` 的候选生成规则从 9 条扩到 12 条常量谓词 + cap24，全库候选杀伤率
从 39.6% 提到 51.0%，误杀实测 0。这一步先于否决权：护栏杀伤后存活的候选规模，才是否决权要扛的
实测剩余量，不是未知上限。

**2. 持久否决权（suppression）落地（[ADR-0010](./0010-persistent-suppression.md)）。**
存储是 per-asset YAML 字段（`suppressed_alt_labels`/`suppressed_dimension_refs`/
`suppressed_external_refs`），key-only、无条目级 provenance——否决记录本身不答谁/何时/为何，
这些问题仍由 git commit 回答，与本 ADR 裁决 9 的 provenance-in-commit 哲学完全同构。表达面是
**隐式**的：删除一条机器可再生内容本身就是否决的诞生动作，不需要新动词；撤销是 `add_*` 把词
加回去，同样不需要新动词。工具面因此**零净新增**——15 个工具（本 ADR 原裁决数）经 #20/#21/#29
一路演进到 19 个之后，第一次没有再长出新名字；`remove_alias`/`remove_relation` 的参数改数组
（破坏性改形），响应新增逐项 `outcome`/`suppressed`/`reasserted` 与 `add_*` 的 `unsuppressed`，
`update_definition` 的字段拒绝列表（本 ADR 裁决 4 的重定向机制）新增 3 个 `suppressed_*` 键。

**门禁全绿**（分支 `fix/38-suppression-and-guardrail`）：substrate typecheck 0 错 / test 342
passed（24 files，含新增 `guardrail.spec.ts` 20 + `suppression.spec.ts` 12）/ negation-test 过 /
acceptance 过；mcp typecheck 0 错 / test 270 passed（17 files，`intent-tools-items.spec.ts` 覆盖
扩容后仍全绿）；e2e 新增步骤覆盖「删除→否决→重新加回→解除否决」与「起落两步」两条序列。

## Update 2026-10-11 — #49 落地：条目级写语义沉进 Core，工具层薄化

落 [#49](https://github.com/McKenzieIT/semantic-grounding/issues/49)（map #47 执行票）。
**不是新裁决，是裁决 3 的结构化落地**——读改写（read-modify-write inside corpus lock）的
实现位置从 MCP 工具处理器搬进了 `SemanticGroundingCore` 的四个方法
（`addAlias`/`removeAliases`/`addRelation`/`removeRelations`），处理器本身薄到只剩
schema 校验 + `auditedWrite` 包装 + Core 调用 + 响应格式化。

**裁决 3 的双层结构现在显式了。** 原裁决说「add/remove 在 server 锁内做读改写」，落地时
读改写的全部领域逻辑（`normalizeLabel` 归一化、双字段 overlay 计算、origin 路由、否决
解除、逐项裁决）都写在 MCP 的 `items.ts` 里。#49 把它分成两层：Core 方法持有领域逻辑
（读 raw dict → 计算 overlay → 调 `updateTableMeta`/`updateEventMeta`），处理器只持有
协议逻辑（Zod schema → `auditedWrite` 提供锁 → Core 调用 → 响应格式化 → 错误映射）。
`auditedWrite` 的 `runAudited` 仍然提供锁，Core 方法在锁内完成读和写——裁决 3 的「锁内
读改写」不变，只是读改写本身有了自己的家。

**`normalizeLabel` 三处归一。** 此前 `normalizeLabel` 有三份拷贝（`enrichment.ts`、
`enrichment-work.ts`、`items.ts`），各自独立演进会漂移。#49 把它收成 `io.ts` 的单一导出，
三处消费同一个实现——与 ADR-0002 的「零新名」哲学同构，只是这次是收敛而非约束。

**测试迁移。** 领域测试从 MCP 的 `intent-tools-items.spec.ts` 迁到 substrate 的
`item-write.spec.ts`（30 tests，直接调 Core 方法，不经 MCP 线）；MCP 线测试瘦到 7 个
wire-only 断言（响应形状、错误码映射、schema 校验、`update_definition` 的 `suppressed_*`
重定向）。两层测试各测自己的层——领域逻辑不因协议层改动而重跑，协议层改动不因领域逻辑
扩展而膨胀。

门禁全绿：substrate typecheck 0 错 / test 380 passed（26 files）；mcp typecheck 0 错 /
test 270 passed（17 files）。

## Update 2026-10-12 — #52 落地：裁决 2 的 concept 排除条款被 ADR-0012 supersede

落 [#52](https://github.com/McKenzieIT/semantic-grounding/issues/52)（map #40 执行票）。
**不是前提证伪，是裁决已被后续 ADR 正式推翻**——裁决 2 原文「concept 写路径（无 Tier-2
函数、无写原语——v1 全程只读，与 Q2 边界一致）」在 [#46](https://github.com/McKenzieIT/semantic-grounding/issues/46)
的五轮 grilling 中被重新审视：概念层被重新定位为知识图谱的 ontology 结构层而非索引页附录，
结构层缺位不再被视为可接受的软退化。本条记录供后续读者定位「concept 排除」这句话出自何处、
何时、因何被推翻——完整的裁决记录见 **[ADR-0012](./0012-concept-write-path.md)**。

**裁决 2 的 metric 排除部分维持不变**，不受本次 supersede 影响：宿主内嵌 `metrics:` 块是
派生只读视图，无后备文件、无指纹，`read.ts:241-249` 的 "no write tool ever needs one" 仍然
成立——排除有理由，不是欠账的另一半。

substrate 新增两个原语（`writeConceptYaml`/`updateConceptMeta`，对齐 `writeTable`/
`updateTableMeta` 的既有形状）；工具面延续本 ADR 裁决 1 的「零新工具名」——`create_definition`/
`update_definition`/`add_alias`/`remove_alias`/`add_relation`/`remove_relation` 六个既有
工具加 `kind:'concept'` 分支，`tools/list` 的工具总数不受影响。细节、Q4(b) 对
`add_relation`/`remove_relation` 的后续修正、门禁结果见 ADR-0012 自身的 Update 段落。

## Update 2026-10-13 — ADR-0017 勘误三处（裁决 5/6 措辞、Decision 编译目标口径）

随 [ADR-0017](./0017-first-party-frontend-exclusivity.md)（第一方前端独占）落地三处勘误：

1. **裁决 5 与 Consequences 的「SchemaProvider 接线（未来宿主姿态）」**措辞改
   「live-engine 接入（S1.3 暂缓项，触发条件见 ADR-0017）」——「未来宿主姿态」预设了
   宿主进程内 import substrate 的形态，该形态已随前提总纲退役。
2. **裁决 6 拒绝快照句柄的立项根**：「那是 dsh 执行查询的需要」受众已断。拒绝理由自立于
   两点（2026-07-28 协议无状态 + 写已串行），结论不变；snapshot 子系统记 **S1.1 暂缓项**
   （触发条件：跨调用一致性读需求〔多工具事务 / diff 类工具〕立项时重开，按 ADR-0003 (b)
   重新举证）。snapshot 代码、`captureSnapshot`/`DefinitionSnapshot` barrel 名、GLOSSARY
   snapshot 词条零改动（暂缓区边界）。
3. **Decision 的「Tier-2 编译目标全部是既有公共面」**口径勘误为 core 方法：barrel 自由
   函数形态（`updateTableMeta`/`updateEventMeta`）已随 S1.5/#85 收名留码，工具编译目标
   （Core 同名方法）与行为未变。

## Update 2026-10-14 — 裁决 6 的「version 只在 get_definition 返回」句扩为两处（#108 / map #106，核验新发现）

裁决 6 括注「**version（sha256 指纹）只在 get_definition 返回**——搜索摘要不作写前提」钉的是指纹契约的读侧。
[#108](https://github.com/McKenzieIT/semantic-grounding/issues/108) 开了第二处：每个 definition
**写回执**同样携带该键（语义见 ADR-0004 的 2026-10-14 Update——no-op 恒返当前指纹、回执命名整个写的终态）。
裁决 6 真正的拒绝项——搜索摘要不带 version、读面不作写前提——维持不变；被 supersede 的只有句中的「只在」。

## Update 2026-10-14 — #109 落地：add_* 升级同 target 批量，与 remove_* 完全对称

`add_alias` / `add_relation` 入参从单数 `alias` / `relation` reshape 为 `labels` /
`relations`（`z.array(...).min(1)` 门口收死空数组；breaking 零兼容——旧单数调用收 zod
校验错，map #27 / #37 §3 先例），Core 转发面同步 `addAlias→addAliases` /
`addRelation→addRelations`（仍四方法，不加名）。回执 `results` 逐行
`{key, outcome: added|idempotent, unsuppressed}`——两值一布尔：加一个被否决的键是
`added` **且** `unsuppressed:true`，不是第三种 outcome；顶层 `unsuppressed` 键移除。
同 target 批量 = 一次双字段 overlay 单 commit，不经 `beginBatch`——ADR-0010 裁决 5
「一次定义一个 commit 是诚实的审计粒度」直接继承；join 与 concept 边混批、表主体
跨落点文件批，整批拒绝（写前，可读错误指路拆批）。原「#37 §3 keeps `add_*`
single: no measured pain」的立场，被 [#103](https://github.com/McKenzieIT/semantic-grounding/issues/103)
的 measured pain（add_alias 31+ / add_relation 4 次串行写）推翻而重开。

## Update 2026-10-14 — #105 裁决：读面清单五扩六（`list_definitions` 索引形），Consequences 的 list Followup 兑现

[#105](https://github.com/McKenzieIT/semantic-grounding/issues/105)（map #89）兑现了 Consequences
里挂着触发条件的那条 Followup——「`list_definitions` 全量（审计扫描类场景出现时）」。触发条件由
map #89 的工作流前提踩中：接手无 manifest 的预存 scope（单宿主 MCP + 远程 agent 形态下语料在
服务端，agent 没有 bash-ls 语料目录这条路）+ #93 裁定的事后 git 审计需要「这 scope 里现在有什么」
的库存视线；实测规模（dogfood 182 / k11 786 定义）> search 的 `top_k ≤ 50` 硬顶。七项裁决
（grilling 一轮全签）：

1. **新增 `list_definitions(kinds?)`**——第 28 个工具；`kinds` 复用 search 的缩围语义，无其他
   参数；`list_*` 命名对齐管理面先例（list_scopes / list_suggestions）。
2. **索引行 `{id, kind, label, domains}`，不含 description**——ADR-0008 索引/题面分离判例（含
   描述会把 k11 786 行从 ~2–3 万 token 撑到十几万）；描述走 `get_definition`。确定性排序
   kind、id 字典序（审计对比要可复现；search 是排名序、list 是库存序，两序并存不混）。
3. **cap 1000 行代码常量 + `total` + `truncated`**（非配置面）——ADR-0008 裁决 4 判例；k11 786
   < 1000 旗舰语料不截断。
4. **`top_k ≤ 50` 不动**——枚举是 list 的职责；search 的 top_k 是「排名截断」非库存通道，撑到
   786 等于让 search 兼职 dump，ADR-0008 裁决 1 已拒绝「top_k 兼管清单」（两个变窄旋钮语义不同）。
5. **分页不重开**——`tools/call` 协议层无分页通道（#29 SDK 源码实测），ADR-0008 已裁，免重探。
6. **编译目标 = 既有 `projectGraphNodes`**（Core 公共方法，`read.ts` 的 `buildCandidates` 已走
   同路，含 derived metrics）——**零 substrate 改动**，#79「勿反向加宽」无虞。
7. **记录形态 = 本 Update，不开新 ADR**——单工具增量不够「真取舍 + 难逆转」的开新 ADR 门槛
   （#108 / #109 的 Update 先例）；GLOSSARY「five read-only intent tools」句随执行落地改六。

裁决 6 的读面清单由五扩六（工具总数 27→28）；当年拒绝的「**verbatim 全量倾倒**（321 表原文非
agent 所需）」维持拒绝——索引行不是 verbatim definition，被拒形状与被采纳形状不同物。执行见
[#112](https://github.com/McKenzieIT/semantic-grounding/issues/112)。

### #112 执行核正（2026-10-14）

七项如裁兑现，零 substrate 改动；一处实现层核正随落地记下（前提核验新发现，非裁决偏离）：

裁决 1 的「`kinds` 复用 search 的缩围语义」按**声明语义**（`ReadableKind` 数组缩围）兑现时，
实测发现 search 的**实现**把过滤域对到了图投影 kind——表节点投影携带的是存储 kind
（`def.kind` ∈ {`dws`,`dim`}，`table-kind.ts:48`），而 `ReadableKindSchema` 的 `table` 在该域上
无命中，即 `search_definitions(kinds:['table'])` 今日实际返回空（潜在词汇错配，无测试钉住，
本票不修、维持原行为——修 search 是未经裁决的行为变更，另票 [#117](https://github.com/McKenzieIT/semantic-grounding/issues/117)
处理）。`list_definitions` 的
过滤域因此折算：`dws`/`dim` → `table`（恰为 `TableDefinitionSchema.kind` 封闭枚举的全部取值，
`types.ts:285`，折算集合收在 `read.ts` 的 `TABLE_STORAGE_KINDS`），其余投影 kind 直通；索引行的
`kind` 仍逐字携带投影 kind（`dws`/`dim` 进清单——库存视线正要存储粒度，#93 审计透镜），由
mcp spec 钉死「过滤器折算、行不折算」。

门禁全绿（分支 `wf/112`）：typecheck 双包 0 错 / substrate test **450 恒定**（28 files，零改动）/
mcp test **385 pass + 1 skip**（25 files，较基线 +10：catalog 27→28 名单 + list_definitions
形态钉死 + kinds 过滤·total/truncated·cap 截断·确定性排序·derived metrics 在列·索引行四字段）
/ e2e **21 步**（不加步：catalog 相位经 `TOOL_NAMES` 自动纳入 28 名 reconciliation，行为面无
启动缝特异性，由 mcp spec 钉死）。GLOSSARY「five read-only intent tools」句已改六；「库存清单」
词条经 domain-modeling 三条件现场裁**不加**（单用例术语，未达复现条件；索引/题面分离语义已有
GLOSSARY「enrichment work」词条与 ADR-0008 承载）。合入 main `417d1a4`（与 #104/#111 同批
集成分支复跑四门禁：typecheck 双包 0 / substrate 450 / mcp **420+1skip** / e2e 21 / catalog 28）。

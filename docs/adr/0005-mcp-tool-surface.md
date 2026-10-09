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
| 5 | 创建路径 | `create_definition(kind: table\|event)` 编译到 writeTable/writeEventYaml + **必传** recorder（ADR-0004 裁决 2 的「MCP host 全链路必传」，#18 后形态）；输入 schema 复用 `TableDefinitionSchema` / `EventDefinitionSchema` | `sync_tables`：TableMeta 断言引擎观测，agent 手搓 = provenance 造假，随 SchemaProvider 接线（未来宿主姿态）另行成票；concept 创建同裁决 2 排除 |
| 6 | 读侧清单 | `search_definitions(query, top_k?, kinds?)` / `get_definition(kind, name)` / `get_join_path(from, to)` / `get_relations(target, type?)` / `resolve_alias(term)`，共五；**version（sha256 指纹）只在 get_definition 返回**——搜索摘要不作写前提 | 复合 context 工具（三原语可组合，stdio 往返便宜）；list 全量倾倒（321 表 verbatim 非 agent 所需）；快照句柄（2026-07-28 协议无状态 + 写已串行，grounding 读不需要 MVCC——那是 dsh 执行查询的需要） |
| 7 | 公共参数块 | 五个 Tier-2 工具统一 `{summary(必, 1–100 字符), derivation(枚举 agent\|llm, 必, 无默认), confidence(必, float 0–1), expected_version}`；expected_version **更新类必传 / 创建免传 / Tier-1 无此参**（采纳 #13 建议，落到五个更新类工具）；工具**无 scope 参数**（charting：v1 一进程一 corpus 一 scope） | derivation 全三值（`deterministic` 是 server 内部流类别，工具面不可达——给 agent 开误报之门）；可选 confidence（trailer 槽位无条件存在，宁要如实粗估不要缺省） |
| 8 | 响应契约 | 统一 `{commit, changed, enrichment_health?}`：`changed:false` = 幂等空转（alias 已存在等）**不产 commit**；`enrichment_health` 内联自 `getEnrichmentHealth()`（刚写完即见，无竞态）；错误可判别：`stale_baseline`（锁内指纹不符，重读重试）/ 锁超时 / 校验失败，码值归实现票（研究票定段：JSON-RPC 保留区外） | 独立 health 读工具（存在竞态且多一次往返）；server 自拼 summary（只有字段回声，没有「依据什么」） |
| 9 | origin 语义 | 工具写**省略** YAML `origin`——undefined 在合并优先级（`ORIGIN_PRIORITY ?? 2`）与 preserve-filter（`origin === 'manual' \|\| null`）两处**实测**按 curated 对待，agent 精选 ref 今日即获「不被轮覆盖」保护，零 substrate 改动；authorship 只归 trailer | 枚举加 `'agent'`：preserve-filter 精确匹配 manual/null，天真扩展反被轮吃掉；复用 `'manual'`：语义漂移；YAML 再记 authorship：状态与历史两个可不一致的数据集（裁决 4/5 反对的形状） |
| 10 | 名字冲突 | 工具参数 `derivation` 专指 trailer 类别；`DimensionRef.derivation`（YAML 自由文本依据注记）**不开**工具参数，agent 依据进 commit summary | 同名双写：agent 困惑 + trailer 枚举与自由文本互相污染 |

## Decision

采纳全部十项。工具面 = **读五 + 写十共十五个 intent 工具**，动词层级为 definition 级
`create_`/`update_`、条目级 `add_`/`remove_`；Tier-2 编译目标全部是既有公共面
（`updateTableMeta` / `updateEventMeta` / `writeTable` / `writeEventYaml` + class 方法），
Tier-1 编译到 pending 四件套——**root barrel 零新名，ADR-0002 规则集未动用**。

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
  `list_definitions` 全量（审计扫描类场景出现时）、`sync_tables`（SchemaProvider 接线时）。
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

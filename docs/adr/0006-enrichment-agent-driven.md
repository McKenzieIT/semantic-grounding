# ADR-0006: enrichment 的 LLM 半边 —— agent 驱动出题-答题回路，MRTR 出局

- **Status**: accepted
- **Date**: 2026-10-09
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0002（公共面规则——本票零新 barrel 名，规则集未动用）、ADR-0004（裁决 3 beginBatch 槽位、裁决 8 指纹基线、裁决 10 trailer 模式的输入）、ADR-0005（裁决 7 derivation 枚举、裁决 8 幂等无 commit / health 内联的继承）、[map #12](https://github.com/McKenzieIT/semantic-grounding/issues/12)、设计票 [#16](https://github.com/McKenzieIT/semantic-grounding/issues/16)

## Context

map #12 的 charting 裁决「LLM 半边由接入 agent 经 MCP 承担、server 零 provider」原本押在 sampling
回调上；研究票 #14 推翻了载体——Sampling 特性在 2026-07-28 被弃用（新实现 SHOULD NOT 采纳），其
官方迁移路径（server 直连 provider）又与零 provider 裁决冲突。本票在协议内候选中裁机制，连带裁
降级、provenance、落盘与缺口暴露。本票另入册一条贯穿约束：**宿主中立**——机制不得依赖任何特定
宿主（含 Claude Code）的行为策略，依赖面只用 2026-07-28 core 协议的 `tools/call` / `tools/list`
（不依赖任何 optional 特性）；CI 门禁的脚本 client 是最弱 client（无 LLM），兼容它就是「支持大多
数 agent」的下界。

代码事实（裁决 2 的依据）：core 的 LLM 轮是纯函数三件套——`buildLlmPrompt` / `parseLlmRefs` /
`mergeRefs`（alt_labels 家族同构）夹着一个可注入的 `llmCall: string → Promise<string>`。「LLM
半边」字面上就是给定提示词、回一段补全——普通工具即可承载，不需要特殊协议通道。

七项裁决，各关闭一个取舍：

| # | 维度 | 裁决 | 关闭的取舍 |
|---|---|---|---|
| 1 | 通道 | **agent 驱动工具回路**；MRTR 两款出局——sampling 形状踩弃用线（client 还须声明弃用的 `sampling` capability，与 Destination「遵循 2026-07-28」直接顶撞）；elicitation 形状把「enrichment 是否发生」押给宿主路由策略（渲染给人还是交给 agent，宿主说了算，不在我们契约内）、form 载机器补全语义扭、302 表批量须 requestState 分页 | server 侧编排（MRTR 重试内原子完成）vs 客户端编排（工具回路）——后者把并发正确性交给 #13/#15 已裁的锁内指纹基线 + stale_baseline 重读重试，零新增机制 |
| 2 | 纪律归属 | **出题-答题**：提示词/解析/合并留在 core，agent 只出补全；intent 工具（`add_alias` 等 + `derivation: "llm"` 自报）并行作自由通道 | agent 自由发挥（只给缺口清单、agent 自己发明直接 intent 写回）——把 substrate 的领域质量要求转嫁给任意 agent 的能力下界，质量与宿主模型强耦合，与宿主中立约束相反 |
| 3 | 编译目标 | **新增 core class 方法对 `listEnrichmentWork()` / `applyEnrichmentResults()`**（封装 build*/parse*/merge* 家族 + work_id 签发与锁内复核）；`run_enrichment` 编译到既有 `discoverRelations` / `discoverEventRelations` / `discoverAltLabels` class 方法（欠 #18 的 recorder 透传）；纯函数家族保持 substrate 内部 | 提升纯函数上 root barrel（ADR-0002(b) confirmed host need 立据本可用）——公共面 +8 个约定耦合名、提示词格式成稳定 API，与 ADR-0003 裁剪方向顶牛；工具契约（{work_id, target, gap, prompt} 字符串进出）已是更好的封装边界 |
| 4 | 写面形状 | `apply_enrichment({results: [{work_id, text}], summary, confidence})`：work_id **自包含**（编码 target + 轮次 + 签发时 sha256 指纹 = expected_version；server 无会话状态，重启隔在 get/apply 之间不孤儿化）；锁内逐项指纹复核 → 容错解析 → 保 curated 合并 → 写原语 + recorder，**beginBatch 收拢单 commit**；逐项 verdict（applied / idempotent / stale_baseline / unparseable），一项 stale 不毒死整批；全批幂等空转无 commit | 逐项 apply（302 commit 洪水，#13 裁决 3 已否的形状）；整批原子失败（agent 重试放大）；server 内存会话句柄（协议无状态、client 可重启 server） |
| 5 | provenance | 参数块**两缺**：无 derivation（server 恒盖 `Derivation: llm`——类别 server 已知，收自报开误报之门）、无 expected_version（已内嵌 work_id，显式传 = 同一基线两个入口）；confidence **批级一个、agent 估、必传无默认**（逐项值无 commit 级落点，且实测会被无差别填）；subject `apply_enrichment(<target>): <summary>`，target 段单项填定义名、多项填 `<N> targets`；trailer 零新键（`Files` / `Rounds` 承 #13 裁决 10） | derivation 自报（#15 裁决 7 砍枚举的同一逻辑）；逐项 confidence；server 自拼 summary（#15 裁决 8 已拒「只有回声、没有依据」） |
| 6 | 触发面 | **`run_enrichment`**：deterministic-only 批量回填，单 beginBatch commit（`Derivation/Rounds: deterministic`），幂等无 commit；「先 run_enrichment 再取 work」写进工具 description——deterministic 可推导性随后加定义变化（今天 onboard `dim_shop`，昨天的 `dws_*` 表 dimension_refs 就变成名字可配对），没有触发面这些缺口会流进提示词让 LLM 答成本该 deterministic 的事实，**审计史失真**；events 今天没有 on-write hook（Service 级事件写路径缺失），批量是其唯一 deterministic 通道 | 不设工具、宿主外跑批——MCP corpus 没有「外」（dsh 是进程内自跑的另一宿主姿态） |
| 7 | 降级 | 降级不是模式，是「client 不调用哪半边」：非 LLM client 天然退 deterministic-only（on-write hook + `run_enrichment` 照常），**零 capability 协商**；CI 脚本 client 可自扮 oracle（get work → 预制文本 → apply）断言 LLM 轮全程 | capability 探测与协商（每引入一种能力面就多一种降级矩阵） |

## Decision

采纳全部七项。工具面 **15 → 18**：+ `get_enrichment_work` / `apply_enrichment` / `run_enrichment`
（ADR-0005 的「十五」是本票前的快照，不回头改写）。`setLlmCall` seam 在 MCP host 不接线、dsh 继续
进程内使用——**同一 seam、两种宿主姿态**：进程内宿主塞回调，MCP 宿主把回调拆成一对工具。
substrate 侧新增 `listEnrichmentWork` / `applyEnrichmentResults` 两个 core class 方法（公共面经 core
实例，root barrel 零新名，ADR-0002 规则集未动用）；`discover*` 家族 class 方法补 recorder 透传随
#18。

## Consequences

- commit 动词表 +2（读工具无 commit）：`apply_enrichment(...)` / `run_enrichment(...)` 进 subject。
- work 清单的诚实性依赖 `run_enrichment` 可触发（裁决 6 的失真论证）；「先 run 再取 work」是指引
  不是协议——懒 agent 跳过 run 时，deterministic 可推导的缺口照常进 work 清单，LLM 答了会被如实
  记成 llm（不静默纠正）。
- intent 工具的自由通道与 work/apply 并存：强 agent 可绕开出题-答题直接 `add_alias`
  （`derivation: "llm"` 自报），机器纪律是质量加成不是笼子。
- dsh 不受影响：进程内姿态继续 `setLlmCall`；substrate 变更仅 class 方法新增与 `discover*`
  透传（随 #18，无既有契约破坏）。
- 门禁红利：LLM 轮可被脚本 client 全程走完，端到端门禁不依赖真 LLM 即可断言写路径；真 agent
  dogfood 另验读路径与三写回。

## Verification

- 门禁脚本断言：work_id 跨 server 重启仍可 apply（自包含）；一项 stale 时其余项照常落盘且该项
  verdict = stale_baseline；全批幂等无新 commit；apply 响应逐项 verdict + commit + changed + 内联
  `enrichment_health`；`run_enrichment` 后 work 清单不含 deterministic 可推导项。
- 真 agent dogfood 覆盖：create_definition → run_enrichment → get_enrichment_work →
  apply_enrichment 全回路，`git log -p --follow` 断言 `Derivation: llm` 与 Files/Rounds trailer。

## References

- 设计票 grilling 全记录：[#16](https://github.com/McKenzieIT/semantic-grounding/issues/16)
- 协议事实（Sampling 弃用、MRTR 语义、无状态重启、elicitation 宿主语义）：#14 研究，
  `research/mcp-2026-07-28-spec` 分支 → `docs/research/mcp-2026-07-28-spec.md`
- 行为依据：`src/enrichment.ts`（buildLlmPrompt/parseLlmRefs/mergeRefs 家族、llmCall 可选、
  best-effort 轮次）、`src/index.ts:150-157`（公共入口 = class 方法、纯函数 off-barrel 的
  convention 条款）、`src/index.ts:795-838`（discoverRelations 显式入口今日无审计）
- GLOSSARY：enrichment、enrichment work（新）、enrichment health、write tier

## Update 2026-10-09 — 实现落地：beginBatch、两个 apply merge-correctness fix、`-31040` 段留空

落 [#21](https://github.com/McKenzieIT/semantic-grounding/issues/21)。ADR-0004 的 2026-10-09 addendum
第 6 条（`beginBatch` 槽位实现）留了 dangling reference 指向本节，此处补齐，避免悬空。

**1. `beginBatch` 落地（ADR-0004 裁决 3 槽位，#18 只留了类型）。**
`GitTier2Recorder.beginBatch()` 返回 `Tier2Batch`：`record()` 是 caller 计数簿记钩（git 无独立的
"何为一轮"概念，调用方自己的调用计数即 `X-SG-Rounds`）；`end()` 先 `git add -A` 学真实文件数再
委托既有 `stageAndCommit`（多一次冗余 add，不维护第二条 commit 路径）；`abort()` 回滚到 pre-batch
HEAD。关键是 `recordTier2Write` 的新**吸收分支**：batch 开着时（`batchDepth > 0`，像锁一样可重入），
每个本会单独 commit 的 `Tier2Opts` 写返回廉价 no-op（返回 head）。这让 `run_enrichment` 调**未改动的**
#18 `discoverRelations`/`discoverEventRelations`/`discoverAltLabels`（仍照传 `tier2`）在一个 beginBatch
窗口内得**一个** commit 而非每表一个——enrichAll* 家族永不知道 batching 存在，recorder 是唯一知情者。
`apply_enrichment` 内部也开自己的 beginBatch（`applyEnrichmentResultsBatch`）收拢整批。

**2. 两个 apply 路径的 merge-correctness fix（实现中发现）。**
- 一个 work_id 的 round 不 stale **同 target 上兄弟 work_id 的 round**——同一定义上并发多个 work item
  时，先 apply 的改基底，后 apply 的指纹不符；裁该项 `stale_baseline`，不毒死兄弟项。
- agent 重提一个 asset 自己已有的名字应 resolve 为 `idempotent` 而非 `applied`——否则幂等重放被记成
  新写入，污染审计史的"改了什么"。

**3. `-31040..-31059` 段留空（确认，非缺口）。** enrichment 没有 whole-call 失败需要单独码值：
lock timeout / commit failure / dirty-tree refusal / missing audit context 全是 #19 已编码的通用 Tier-2
写失败；per-item verdict（`stale_baseline`/`unparseable`/work_id 解码失败）是裁决 4 的**非错误 payload
数据**（一项 stale 不毒死整批，不到 `toToolErrorResult`）。与 #22 addendum 第 3 条同构（"分配表的确认
而非缺口"）。未来若出现真正 enrichment-specific 的 whole-call 失败，从 `-31040` 起分配。

**4. 错误契约 `toToolErrorResult`（ADR-0005 2026-10-09 addendum，与 #20 同一份 spec 各自独立实现）。**
`packages/mcp/src/errors.ts`：**返回而非抛出**——实测 `registerTool` 处理器若抛出，SDK 会 catch 成
只剩裸字符串（比 addendum 记录的"只丢 code"更彻底）；只有**返回**一个 `{isError:true, content:[...]}`
结果，完整 JSON 才经 `projectCallToolResult` 原样上线。`-31xxx` 码值活在 `content[0].text` 的 JSON 里，
永不上 JSON-RPC 的 `error.code` 字段。非 `SgApplicationError` 异常原样重抛（内部故障不伪装成工具结果）。
`SgApplicationError.code` 类型放宽为 `number`（三票共用基类，各自构造自己段位）。

**5. `clientInfo` 逐请求线路（同 addendum 第二条）。** `AuditContext` 加 `clientName?`，
`commitContext()` 改 `firstNonEmpty(ctx.clientName, this.cfg.clientName)` 镜 sessionId；每个写工具处理器
`clientNameFromEnvelope(extra)` 逐请求读 `extra.mcpReq.envelope[CLIENT_INFO_META_KEY]`。

**门禁全绿**（main 上 #20 + #21 合并后）：substrate typecheck / test(299+) / negation / acceptance 全过；
mcp typecheck 0 错 / test 248 passed（17 files，含 intent-tools 84 + tool-error-contract +
enrichment-tools + git-recorder 33 + server-startup/build-shape/config 等）。

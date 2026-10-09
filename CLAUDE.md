# Semantic Grounding

## Agent skills

### Issue tracker

Issue 追踪在 GitHub（McKenzieIT/semantic-grounding），通过 `gh` CLI 操作。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用五个标准 triage 状态标签（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）+ 两个分类标签（bug / enhancement）。详见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文布局（根目录 `GLOSSARY.md` + `docs/adr/`）。详见 `docs/agents/domain.md`。

### Decision framing

架构决策的呈现方式（ROI 优先、不列无效选项、唯一最优解时按 ROI 切片）、讨论语域
（中文 + 问数/数据工程实际场景 + 专有名词通俗解释）、以及证据标准（**执行前先验证前提，
包括本仓 ticket 和 resolution 里记录的前提**——slice 1 的记录就被证伪过）。
详见 `docs/agents/decision-framing.md`。

### Active map

**[map #12：MCP 管理面](https://github.com/McKenzieIT/semantic-grounding/issues/12)**（2026-10-08
charted）。目的地：`packages/mcp` 的 MCP server（遵循 2026-07-28 协议修订）过端到端门禁——agent 经
MCP 读 grounding、经 Tier-2 审计写路径写回，落成 corpus git 仓库的 commit，`git log` 可答
provenance。charting 裁决与每会话必读见 map body。票态：#14 协议研究（已关：TS SDK v2、
Sampling/Roots/Logging 已弃用→机制在 #16 重开）、#13 git Tier-2 recorder 设计（已关：十项裁决
成文 ADR-0004 + ADR-0001 addendum，GLOSSARY write-tier/D5/git-recorder 词条已改；#6 随之交叉关闭）。
#15 tool surface 已关：十项裁决成文 **ADR-0005**（十五 intent 工具〔读五写十〕、expected_version
更新必传/创建免传、derivation 枚举 agent|llm、工具写省略 YAML origin〔origin=合并优先级 vs
Derivation=提交归属，两类概念〕、零新 barrel 名；GLOSSARY write tier/provenance 词条已改）。
#16 enrichment 机制已关：七项裁决成文 **ADR-0006**——agent 驱动出题-答题回路（MRTR 两款出局：
sampling 形状踩弃用线、elicitation 形状押宿主路由策略），宿主中立入册（脚本 client = 最弱
client 下界），工具面 15→18（+get_enrichment_work / apply_enrichment / run_enrichment），
纪律留 core（新增 listEnrichmentWork / applyEnrichmentResults class 方法、discover* 补 recorder
透传随 #18、零新 barrel 名；GLOSSARY enrichment 词条改 + enrichment work 新词条）。
#17 workspace 化已关：单包 → pnpm workspace，`src/`/`tests`/`scripts` 迁入 `packages/substrate`
（包名/exports 不变），`packages/mcp` 建空脚手架（未引入 MCP SDK，留给 #22）；两道门禁脚本零
改动（用 `import.meta.url` 算路径，非 CWD/硬编码）。commit `07ce9d3`。#18 substrate 契约升级
已关：ADR-0004 七项落地——recorder 异步化、Tier-2 三路径 + 写原语原始字节回滚（**#6 执行
关闭**）、syncWriteDefinitions 改回滚当前表 + 中止批次、expected_version/StaleBaselineError、
enrichAll*/Core 方法 Tier2Opts 透传、beginBatch 预留槽位（仅类型）；StaleBaselineError 上公开
barrel（ADR-0003 名单 34→35，addendum 记录）。commit `2656864`。两票分支经 git 的
rename-aware merge **无冲突**合入 main，合入后重跑全量门禁（typecheck/278+1 测试/
negation-test/acceptance）确认绿。Fog「server 骨架与配置面」graduate 为
[#22](https://github.com/McKenzieIT/semantic-grounding/issues/22)（task，被 #19 挡；#20/#21
新增阻塞于 #22——工具注册需先有骨架可挂）。
#19 git recorder 实现已关：ADR-0004 裁决 4–7/9/10 + 启动四情形落在 `packages/mcp/src/git/`
（substrate 零改动，裁决 4 端到端成立）；seam 是 **`runAudited(ctx, fn)`**（锁须包住基底调用，
intent 只有工具层知道——无 context 的 `recordTier2Write` 抛错不自拼 summary）。三处实测修正
入 **ADR-0004 的 2026-10-09 addendum**：①`autoEnrich` 默认 true，on-write enrichment 钩子在
审计 commit **之后**无 `Tier2Opts` 写盘（probe 实测），故一次 agent 写可能产**两个** commit
（另提 `enrich_on_write` / `Derivation: deterministic`，不与 agent commit 合并；`beginBatch`
在 #21 使其结构化）；②`--show-toplevel` 返回 realpath，裁决 5 须比规范化路径（按字符串比会错拒
软链配置的合法 corpus）；③裁决 6 延伸到每次写（暂存是 `add -A`，脏树上的写按原理由拒绝）。
锁手写而非 proper-lockfile：裁决 6 要属主 pid，后者只按 mtime 判陈旧、表达不出「脏+死锁 vs
脏+活锁」。错误码分段 -31000..-31019（本票）/ -31020..-31039（#20）/ -31040..-31059（#21），
仅 `stale_baseline` retryable。91 测试含四个真实 writer **进程**争用，且对「锁被摘掉」做过
反证（丢更新断言会失败）。commit `b4fd070`。
#22 server 骨架与配置面已关：`sg-mcp` 可执行入口 + 配置面 + stdio server 落在 `packages/mcp`
（`config.ts`/`main.ts`/`server.ts`/`bin.ts`），零 intent 工具，commit `3dbc717`。形状全由实测
定下，**四条已记录前提被推翻**：①stdio 在 `./stdio` 子路径，且手接 transport 对 2026-07-28 请求
按 2025 形状**静默作答** → 必须用 `serveStdio`；②SDK 的 `LATEST_PROTOCOL_VERSION` 是 2025-11-25，
`2026-07-28` 无公开常量；③**不能有「那个 `Server` 实例」**（复用单例在 discover→legacy 回退路径
静默损坏）→ seam 是 **`ToolRegistrar = (server, deps) => void` + `TOOL_REGISTRARS`**；④零工具也
必须显式声明 `capabilities:{tools:{}}`。自裁两项：配置载体 = **CLI flag + 环境变量回退、flag
优先**（决定性输入：dogfood 宿主是 **QoderWork 等办公 agent**，非 Claude Code，其注册面是否暴露
args/env 无法核实），**`legacy:'serve'`** 两 era 都服务（Core/锁/recorder 建在工厂之外，实测各
一次，代价为零）。拒绝一律在 transport 连接**之前**、stdout **零字节**、退出码 64 EX_USAGE /
78 EX_CONFIG。56 新测试（合计 147），四条载重断言全做反证（其中「只构造一次」原断言**无鉴别力**
——工厂 per-connection——已改用 discover→legacy 输入）。
**#20（已关，`b4d0d2e`）** ADR-0005 十五 intent 工具（读五/写十）落地 `packages/mcp/src/tools/`（read/write/items/suggestions/shared），挂 `TOOL_REGISTRARS`，root barrel 零新名。错误契约 **`toToolErrorResult`（errors.ts）返回非抛出**——实测 `registerTool` 抛出被 SDK catch 成只剩裸字符串（比 ADR-0005 addendum 记录的「只丢 code」更彻底），`-31xxx` 码值活 `isError` 结果的 JSON content 里、永不上 JSON-RPC `error.code`；`-31020..-31024` 五码值（unsupported_update_field/definition_not_found/definition_already_exists/suggestion_not_found/validation_failed，stale_baseline/锁超时复用 #19）；clientInfo 逐请求线路（`AuditContext.clientName` + `commitContext` firstNonEmpty 镜 sessionId）；`update_definition` 用 zod omit+removeDefault 派生有界 fields；pending 队列落 `<gitDir>/sg-pending/` 防脏树。84 新测试（合计 232）。
**#21（已关，`e245aaf`）** ADR-0006 七项落地——substrate 新增 `enrichment-work.ts`（internal，off-barrel）+ `listEnrichmentWork`/`applyEnrichmentResults` class 方法对 + work_id 自包含（kind+target+round+sha256 指纹=expected_version，server 无会话、重启不孤儿化）；packages/mcp 三工具（15→18）`get_enrichment_work`/`apply_enrichment`/`run_enrichment`；**`beginBatch` 机制**（ADR-0004 裁决3 槽位真正实现，#18 只留类型——`GitTier2Recorder.beginBatch` 返 `Tier2Batch`，`recordTier2Write` 的 `batchDepth` 吸收分支让 N 逻辑写→1 commit，enrichAll* 家族永不知 batching 存在）；`toToolErrorResult` 与 #20 同一份 spec 各自独立实现；**`-31040` 段故意留空**（enrichment 无 whole-call 失败需单独码值，per-item verdict 是非错误 payload）；两个 apply merge-correctness fix（work_id round 不 stale 同 target 兄弟项；agent 重提 asset 自己名字→idempotent 非 applied）。
两票合并入 main `547fb4f`（4 冲突 + recorder.ts `clientName` 去重已解，如 #17/#18 那次并行无碍），门禁全绿（mcp 248 测试 / substrate 299+ / negation / acceptance）；ADR-0006 的 2026-10-09 addendum 补齐 `cd12846`（beginBatch 落地、两个 fix、`-31040` 段留空——补 ADR-0004 addendum 第6条的 dangling reference）。
Frontier：**[#23](https://github.com/McKenzieIT/semantic-grounding/issues/23)（端到端验收门禁，task）**——原被 #20+#21 挡，现两票关闭解除阻塞，是 map 唯一 frontier。问题已能精确陈述（断言清单照搬 ADR-0005/0006 的 Verification 节，底座是 #19 的 `fixture-corpus.ts` + #22 的 `registrar-server.ts` + #20/#21 的工具），只是还不能动手；待裁随票记：门禁脚本的落位形状。错误断言**已跟随 #20 裁决**（判别靠解析 `toToolErrorResult` 的 `isError` 结果 JSON content，不照抄 `-31xxx` 上 JSON-RPC `error.code`）。**Not yet specified 仍只剩一项**：agent 持久否决权（tombstone），触发条件是 dogfood 出现写-删循环。所以**到 Destination 的路已清**：#23 一票即终点。
dsh 深耕暂停。遗留两件、
各有去处：dsh 升级 substrate alpha.3 的全部断点在
[#11](https://github.com/McKenzieIT/semantic-grounding/issues/11)（低优先，随 dsh 下次升级一并
处理）；发布 `@semantic-grounding/substrate` 是 dsh 下次发版的阻塞前置（map #1 Out of scope
记录，届时作 fresh effort，alpha 发布不关 ADR-0003 的裁剪窗口）。

前一张 map #1（extract semantic grounding substrate）已随
[slice 5](https://github.com/McKenzieIT/semantic-grounding/issues/7) 关闭：Destination 在
slice 4b 达成（dsh 对 tarball 安装启动并过门禁，PR dsh#187），slice 5 把 root barrel 名级白名单
落地（ADR-0003，148 → 67，acceptance gate 以精确名单断言钉死）。

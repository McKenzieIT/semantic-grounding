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

- **map [#189](https://github.com/McKenzieIT/semantic-grounding/issues/189) 分析图——口径仲裁者做实**（2026-10-17 charting，本图带执行）：口径单源 · 分歧可见 · 生命周期 · `caliber_variants` 处置 · A4 接力验收。**第一轮 research（BI/SQL 栈对照材料，全关）**：#191（`0111d4f`）· #195（`ecb4c54`）· #196（`8e2d9c8`）· #197（`875541e`）· #190（`9154d52`，**与终点 ① 张力**——行业阈值几乎都内嵌在 SQL 里）。**第二轮 agent-facing research（已开票、待派 subagent）**：#201（生产 agent 消费口径）/ #202（agent 栈口径失败模式）/ #203（caliber schema 形状），均 blocked by #193。**#193 须等第二轮齐后再开 grilling**，同时看两套材料。**Q3 已裁（2026-10-18）**：路线 A「独立 caliber 事实」——原 ADR-0025 R5「阈值写在 SQL 里」在「多条大R 查询」前提下不再成立，将在 #193 改写。#192（场景采集 HITL）待与用户做；#194 等 #193。
- 最近关图 map #125 于 2026-10-17 关闭，见下方索引；其完整子票账本 `git show d11a698:CLAUDE.md` 可回查。

### 当前基线

2026-10-17 关图亲跑（HEAD `d11a698`）确认；2026-10-16 起（map #125 落地批 #152/#136/#154/#155/#157 + 接力三票 #179/#180/#181 后勘误）：**typecheck 双包 0 / substrate 487 / mcp 503+1skip**（2026-10-18 #198：intent-tools-promotion +5、intent-tools-memory-read 跨边折叠 +1；10-17 基线亲复核 = 497+1skip〔总 498，含 build-shape win32 条件 skip〕；2026-10-17 勘误：#183 skip 转 live → 483、#184 relay-judge.spec +15 → 498；沿革自 2026-10-15 的 432/434+1skip：#152 memory.spec +15 → 447、#136 memory.spec +6 → 453；mcp #152 +10 → 444+1skip、#136 +6 → 450+1skip；worktree 并行 #154 substrate memory-read.spec +20 → 473、mcp +9 → 453+1skip；#155 substrate verified-query.spec +14 → 487、mcp +12 → 471+1skip；#157 零测试面变化〔e2e 门禁步进 22→23〕；code-review 修复批 `de05471`/`e48e29e` 零漂移；#181 relay-judge.spec +11 → **482+1skip**；mcp 旁注：concurrent-write.spec「四进程写一语料」满载偶发 1 败、单跑与全量复跑均零复现，与 import-definitions 2 守卫超时同款环境计时抖动留观）**/ e2e 23 / catalog spec 32 工具断言（文件 39 测）/ barrel 28+default（2026-10-18 #198 `edgeAnchorOf` 上桶）/ 工具面 32（沿革：#152 `record_memory` 29→30、#155 `create_/update_verified_query` 30→32，banner/e2e 全派生零硬编码）**。门禁数字漂移时以当日亲跑为准并勘误本节。

**分层门禁（map #164 · #168 Q6 定形）**：票内层 = 改动包及其下游 + typecheck 双包；合入 / 关图 / 收尾层 = 四门禁全量（typecheck 双包 / substrate / mcp / e2e）；e2e 仅合入层跑，不进迭代圈。

### 环境坑

- gh 2.102 keyring 认证（auth 异常先 `gh auth status` 自查）。
- acceptance 脚本 npm-ENOENT（Windows 坑）——barrel/catalog 对账改对 tsdown 构建产物手工 deepEqual，先例 #61/#87/#123。
- 直跑 .ts 需先 `pnpm -r build`（substrate `lib/` 是 workspace 解析目标，否则 ERR_MODULE_NOT_FOUND）。
- 并发会话开工先 `git fetch` + rebase；**rebase 后 CLAUDE.md 引用的合入 sha 要勘误**。
- read-count-probe 重载超时偶发非缺陷（判环境性：干净 HEAD 复现同败才立案）。
- `import-definitions.spec.ts` R3/R4 mass-update 守卫（"51 updated default threshold 50"）30s 超时复现于隔离跑（`git diff 2b5a87f 0839697 -- packages/mcp/tests/import-definitions.spec.ts` 空，与 #181 零接触）——#174 提速批留观的环境计时抖动，非缺陷；全量套跑中 10s 左右过，单跑超时。**已解（`ced7fbb` 2026-10-17）**：真凶 = 守卫对真 git 语料 ~33s 超出 vitest 30s 默认，显式 90s（同 concurrent-write.spec 先例）——非环境抖动，留观了结。
- 行号锚以 rg 内容定位为准（历史行号会随插入漂移，#148 先例）。

### 关票仪式

后续关票 CLAUDE.md **只添/改一行**（票号 + 一句话结论 + 落点 sha），完整票史叙事不回填——正典载体是票面 resolution 与 CLAUDE.md 自身 git 历史（`git log -p CLAUDE.md`）。

### 已关图与 standalone 票索引

一行一图/一票，正典 = 各票 resolution + `git log -p CLAUDE.md`；压缩前全量账本 `git show ac9db29:CLAUDE.md` 可回查。

- **map [#1](https://github.com/McKenzieIT/semantic-grounding/issues/1)** extract semantic grounding substrate——substrate 从 dsh 抽出成包：slice 4b tarball 安装过门禁（PR dsh#187），slice 5 root barrel 名级白名单（ADR-0003，148→67，acceptance 精确名单钉死）。
- **map [#12](https://github.com/McKenzieIT/semantic-grounding/issues/12)** MCP 管理面——agent 经 MCP 读 grounding、Tier-2 审计写回、`git log` 答 provenance；CI 第三道门禁 `pnpm e2e` + QoderWork 真 agent dogfood（`docs/mcp-dogfood.md`）双面验收；开出 #24/#25/#26。
- **map [#27](https://github.com/McKenzieIT/semantic-grounding/issues/27)** enrichment 维度语义与响应尺寸——维度过滤 call-wide 语义（ADR-0007）+ 索引/题面分离与第 19 工具 `get_enrichment_prompts`（ADR-0008）；#25 关票。
- **map [#32](https://github.com/McKenzieIT/semantic-grounding/issues/32)** agent 持久否决权与抽取器护栏——`suppression` per-asset YAML（ADR-0009/0010）+ 12 谓词 cap24 护栏 + 445 events 语料清理；#24/#26 关票。
- **map [#40](https://github.com/McKenzieIT/semantic-grounding/issues/40)** scope 能力边界与初始化路径——MCP 管 scope 知识层+注册层不管基础设施；统一注册表+入口快照绑定+删 `--corpus`（ADR-0011）；轨迹驱动冷启动+概念写路径（ADR-0012）。
- **map [#47](https://github.com/McKenzieIT/semantic-grounding/issues/47)** item 写语义沉 Core——四 item 写工具领域语义沉 Core 方法契约层、工具恢复薄包装、写-删循环两半同包测试（ADR-0005/0010 Update）。
- **map [#50](https://github.com/McKenzieIT/semantic-grounding/issues/50)** MCP 初始化 toolkit——scope 管理+概念 properties+`import_definitions`+playbook 动态指引（ADR-0011/0012/0013/0014 accepted），工具面 19→26、e2e 17→21。
- **[#57](https://github.com/McKenzieIT/semantic-grounding/issues/57)** 测试 harness 统一——`buildIntentToolHarness` 镜像 `TOOL_REGISTRARS`、`TOOL_NAMES` 单一来源（catalog+e2e 双门对账）。
- **[#61](https://github.com/McKenzieIT/semantic-grounding/issues/61)** io.ts 写路径收 seam+错误面归一——七条 audited write-and-record 收 `auditedFileWrite`，错误三段式 `{ok:false}`/`StaleBaselineError`/基础设施。
- **map [#64](https://github.com/McKenzieIT/semantic-grounding/issues/64)** enrichment 扫管引擎——四条镜像管线折成 sweep engine + table/event 双 adapter，自由函数契约逐字节不变（1206→170 行）；候选票 #59 随图关闭。
- **[#69](https://github.com/McKenzieIT/semantic-grounding/issues/69)/[#70](https://github.com/McKenzieIT/semantic-grounding/issues/70)/[#71](https://github.com/McKenzieIT/semantic-grounding/issues/71)** toolkit 真实初始化三反馈——scope_id 软引导三句 / 仓根 README 接入面 / `docs/multi-machine-corpus.md` 部署拓扑 A 零代码。
- **[#72](https://github.com/McKenzieIT/semantic-grounding/issues/72)** `deregister_scope` 五裁决——第 27 工具；纯注册表操作（零 posture/零 corpus 写）；幂等=报错（−31061）。
- **map [#73](https://github.com/McKenzieIT/semantic-grounding/issues/73)** read-epoch——MCP 只读路径一次调用一次解析（ADR-0015），代表路径全 1.00×；删 BasicIndex+registerInvalidationHook；源票 #60 随图关闭。
- **[#79](https://github.com/McKenzieIT/semantic-grounding/issues/79)/[#80](https://github.com/McKenzieIT/semantic-grounding/issues/80)** findEventPath 写路径 bug——事件文件名下划线→点号（ADR-0016），446 fixture 一次性 `git mv`，run_enrichment 262×→4.00×。
- **[#81](https://github.com/McKenzieIT/semantic-grounding/issues/81)** Windows 测试密闭化——存量 7+1 一次清零（全在测试代码），全平台门禁全绿基线自此始。
- **map [#88](https://github.com/McKenzieIT/semantic-grounding/issues/88)** S1 单宿主收窄——删 LLM seam/sync-write 链/scope-epoch + barrel 36→27（ADR-0017 accepted + 十张 ADR 体检修复）；源票 #82 随图关闭。
- **map [#89](https://github.com/McKenzieIT/semantic-grounding/issues/89)** scope 管理面增强——探索草稿隔离（`acquire_scratch_dir`，ADR-0020）+ 批量纳入评审（ADR-0018）+ 漂移再同步（ADR-0019）+ 枚举读面 `list_definitions`；工具面→29。
- **map [#95](https://github.com/McKenzieIT/semantic-grounding/issues/95)** C1+C2 substrate 双深化——item 写 overlay 收 `src/item-write.ts`（index.ts 2021→1517）+ fetch/apply 收 `resolveEnrichmentWork`；公开面零变化。
- **[#102](https://github.com/McKenzieIT/semantic-grounding/issues/102)** dogfood 快修——`get_scope` 补 `counts:{dw,kg}` + 三处工具描述澄清。
- **map [#106](https://github.com/McKenzieIT/semantic-grounding/issues/106)** C4 写响应信封——`writeReceipt` 单点 + 写后 version 回执（no-op 恒返现指纹）+ add_* 同 target 批量（ADR-0004/0005 Update）；源票 #103 随图关闭。
- **map [#113](https://github.com/McKenzieIT/semantic-grounding/issues/113)** C3 工具家族描述符单一来源——九家族 `ToolFamily{names,register}` 绑定派生四常量、banner 报工具数；S3 散文六处一票修。
- **[#117](https://github.com/McKenzieIT/semantic-grounding/issues/117)** search `kinds:['table']` 词汇错配——`foldTableStorageKind` 过滤器折算、行不折算（ADR-0005 补记）。
- **map [#118](https://github.com/McKenzieIT/semantic-grounding/issues/118)** C5–C8 收尾批——错误映射进 `epochWrapped` chokepoint（29 处手抄清零）+ `evaluateLayers` 单点 + 测试拓扑三尾巴 + 写分发/探针/响应形状收单点；公开面零变化。
- **[#137](https://github.com/McKenzieIT/semantic-grounding/issues/137)** 巡检 S4/S3 余件清理批——`ApplyResult` 合一 / `countsOrThrow` 委托删 /「13 步」派生表述等六件。
- **map [#139](https://github.com/McKenzieIT/semantic-grounding/issues/139)** C9+C10 双深化第二弹——`loadBuiltinDefinitions` 认人/验货分家（plugin.schema.safeParse 唯一循环）+ `update*Meta` 收私有 `updateMetaFile` seam；公开面零变化。
- **#144–#149 第二轮巡检 standalone 六票批**（2026-10-15 subagent worktree 六路并行落地、主会话串行合入，合入 sha 均为 rebase 后终 sha）：[#144](https://github.com/McKenzieIT/semantic-grounding/issues/144) `91ecbd0` import 写域三件收 seam（`itemVerbDetail` 单点/`countNodesByKind` 单家/`loadWritable` 两 seam 五现场）、[#145](https://github.com/McKenzieIT/semantic-grounding/issues/145) `f4b2301` shared.ts 两单消费者成员迁出（「shared = 跨家族」契约恢复为真）、[#146](https://github.com/McKenzieIT/semantic-grounding/issues/146) `06aa57a` e2e 读惯例收敛（`baselineOf`/`definitionOf` 收编手抄镜像，第二 Phase 4.5 改 4.6）、[#147](https://github.com/McKenzieIT/semantic-grounding/issues/147) `aa92d76` substrate 卫生批三件归一、[#148](https://github.com/McKenzieIT/semantic-grounding/issues/148) `75f16ca` 巡检散文漂移七件清、[#149](https://github.com/McKenzieIT/semantic-grounding/issues/149) `7c9df42` scope-id 单点化（`assertScopeIdShape` 退役，mcp 基线 447+1skip→437+1skip）；docs 收尾 `cad0816`。**S2 死码用户裁决本轮不开票**（另 effort）。
- **[#150](https://github.com/McKenzieIT/semantic-grounding/issues/150)** CLAUDE.md 票史账本 compact——已关图一行一图、常设小节抽出（基线/环境坑/一行关票）、活跃图 #125 细节保留；压缩前 blob `ac9db29` 可 `git show` 回查，随本 commit 落地已解。
- **#160–#162 第三轮巡检 standalone 三票批**（2026-10-15 subagent worktree 三路并行落地、主会话串行合入，报告 `docs/architecture-review-2026-10-15.md` 行标与节首核验注记已落）：[#160](https://github.com/McKenzieIT/semantic-grounding/issues/160) `d66a13a` enrichment 收编面死名批（自由 `discoverAltLabels` 合并器退役 + 六死名清〔四适配器值/SweepResult/discoverEventRelationsFor〕；**sweepEnrichment 留存 = 巡检证据勘误**〔sweep.spec:23 经收编面消费〕；substrate 450→**449**）、[#161](https://github.com/McKenzieIT/semantic-grounding/issues/161) `582cb39` update 三件套迁 write.ts + apply_enrichment 约束去手抄（广告面 **+2 description 键对齐 commit-class 口径**——巡检「零 diff」口径勘误；errors.ts:607 假锚 3 词修正随票）、[#162](https://github.com/McKenzieIT/semantic-grounding/issues/162) `ebf0e99` 巡检 §S6 文档/锚点漂移 13 件清（含 ADR-0011 补 #149 Update 节、ADR-0010 死符号改指 `itemSuppressionFieldName` 实测锚）。
- **[#163](https://github.com/McKenzieIT/semantic-grounding/issues/163)** 审计残件清理批 `55003ee`——code-simplifier 双 subagent 复核三日审计窗口（`e6607fa..c602434` 99 文件）：#160 漏网类型半区六死 re-export / #161 漏网孪生守卫装置迁 write.ts / #122 孤儿 helper 删；主会话中央核验拦 subagent 两笔越线（误删 sweepEnrichment 撞 c602434 勘误、utf8 顺手改）；门禁四绿对基线；报告项三件未动（`toExecutableRule?` 需 ADR-0003 修订 / shared.ts 头注枚举 / ADR-0017 死链）。
- **[#171](https://github.com/McKenzieIT/semantic-grounding/issues/171)/[#172](https://github.com/McKenzieIT/semantic-grounding/issues/172) #163 报告项处置两票**（2026-10-15 同会话连跑）：#171 `24d7b06` `toExecutableRule?` 死可选字段退役（ADR-0003 Update 2026-10-15 随票——名级白名单不动、向后兼容保留期结束 = 全仓零实现零消费实证；acceptance 亲跑死于已知 npm-ENOENT 环境坑〔断言前〕，名单主张改 `lib/index.d.ts` 层实证〔类型名在册/字段 0 处〕；:110 并提的 `loadDomains` 分家为活件不动）、#172 `ac0402b` 漂移修字批两件（shared.ts 头注 4/9 枚举改派生表述〔#115 先例〕+ ADR-0017 :10/:53 死链改 `git show 2913c26` 回查形式）；四门禁对基线逐字不动。
- **map [#164](https://github.com/McKenzieIT/semantic-grounding/issues/164) 测试套件减负关图**（2026-10-15 subagent worktree 三路并行落地、主会话中央核验后串行合入；**push 前经 rebase 过并发 #151**——三票 sha 为 rebase 后终 sha，substrate 自 450 起算 449→431）：[#169](https://github.com/McKenzieIT/semantic-grounding/issues/169) `2d9f921` mcp 删并批 A（C4/C8/C15/C16+D3 修字，437→**432+1skip**）、[#173](https://github.com/McKenzieIT/semantic-grounding/issues/173) `96c17f5` substrate 删并批 B（九件+D1/D2 修字，450→437·**C13 多条目 fetch 混批景亲验 parity 未盖留件**）、[#174](https://github.com/McKenzieIT/semantic-grounding/issues/174) `b9a0599` 提速批 C（4a fixture git 模板仓库 per-worker 复用+gc.auto=0、4b R3 冷启 60→6、4c read-count-probe path5 三分子集、4d pretest hash 守卫跳过、4e maxWorkers=8 + 同文件删并 −6 至 431；**mcp 墙钟 53.2s→38.3s、substrate 16s→8.2s、全量一轮 85–90s→~64s**）；合入收尾 `a277268`（基线勘误+分层门禁两档落盘）、[#170](https://github.com/McKenzieIT/semantic-grounding/issues/170) 终验关图 `bcd143a` + rebase 勘误随本 commit（删件 rg 清零 14 串、覆盖方五处抽查、基线口径一致 431/432+1skip、rebase 后四门禁复跑全绿）。**留观**：mcp 单测偶发失败三观测零复现（#174 落地时 + 合入首跑 + #151 侧 import-definitions 2 守卫超时旁注，复跑均全绿）；**交接 S2**：`src/index.ts:16` 生产头注 "fifteen" 计数漂移（本图边界只动测试文件）。
- **#175/#176/#177 code-review 批**（2026-10-15 mcp 包两轴状态审阅〔Standards/Spec 并行 subagent〕+ 对抗性核验后三票同日 worktree 并行落地、主会话串行合入；**push 前经 rebase 过并发 #158 docs 关图批**——三票 sha 为 rebase 后终 sha；核验亦证伪三条：binding loader seam〔#137 勘定〕、write/items 再收 seam〔#47 薄包装口径〕、deregister_scope `binding_cleared` 键〔票 #72 resolution 正典有记〕）：[#175](https://github.com/McKenzieIT/semantic-grounding/issues/175) `45c9cca` mcp 卫生批（recorder `AuditContext.files`/`.rounds` 死字段退役〔11 intent 字面量五键零 setter、commitContext spread 恒空、`beginBatch.end` 自算唯一真源，#171 先例同构〕+ binding.ts `scope_unloadable` 文案二抄收 `scopeUnloadableError` 单点〔#137 双函数分离不动〕，mcp 零漂移）、[#176](https://github.com/McKenzieIT/semantic-grounding/issues/176) `e776c26` submit_suggestion 参数面退役（**裁决=退役非补档**：ADR-0005 裁决 7 canon、全仓零消费、#171/#88 先例；工具面+substrate `SubmitArgs`/`PendingSuggestion` 双面清零，存量容忍两面钉死 substrate +1/mcp +2 → **432/434+1skip**，ADR-0005 Update + GLOSSARY pending queue 记档；io.ts `Tier2RecordMeta.tenant_id` 系 Tier-2 audit 元数据面未动）、[#177](https://github.com/McKenzieIT/semantic-grounding/issues/177) `e7a8595` 散文漂移批（server.ts barrel「36-name」旧数改 ADR-0003 锚派生表述、index.ts fifteen/three 计数漂移改 `INTENT_TOOL_FAMILIES` 派生+`beginBatch` 纠正为 recorder 机制非注册工具〔**map #164 交接 S2 fifteen 件随本票清账**〕、GLOSSARY:464 Tier-1 四件套补真名）；docs 收尾随本 commit。合入层四门禁当日亲跑全绿（rebase 前后各一轮）：typecheck 双 0 / substrate 432（7.4s）/ mcp 434+1skip（34.9s）/ e2e 22（banner tools: 29 确认）。
- **map [#125](https://github.com/McKenzieIT/semantic-grounding/issues/125)** SG 短期方向（2026-10-14 → 10-17，本图带执行）——三层模型+晋升规则（ADR-0021，配套 0023–0028）· 四类工作流定位（ADR-0022）· memory 存储/读面/晋升守卫/已验证查询落地（工具面 29→32）· 跨 agent 接力实测：`pnpm relay` 三卡脚本腿全绿（A3 5/5 · E3 5/5+对照 0/3 · G3′ 4/5）+ G3′ 跨宿主人工 L3 PASS（`docs/relay-hitl.md` §9）；replicated 实跑移 Out of scope（#187 not planned，前提证伪）；后续：#186 死码批、#178 读路径缓存建议、四类工作流专属 map。
- **[#186](https://github.com/McKenzieIT/semantic-grounding/issues/186)** 接力线死码与陈旧指针九件+第十件清（第四轮巡检 D1，2026-10-17，落地 `5c2c106`）——`SG_RELAY_TIGHT` 死选项·`RelayHost`/`harnessA/B`/`stdoutPath` 死字段·k11 git init 配方三抄收 `initFixtureGit(root,{name,email},baselineMessage)` 一处（e2e 直接复用；check-relay preflight 后动态 import 不绕 substrate-lib 可行动报错）·r6kgxn5a/「paste into #157」/「回放腿仍 skip」陈旧指针清·L3 清单第 2 行改读注册表真实 active（≠目标 scope 时打切 active 提示）；四门禁对基线零漂移（typecheck 双 0/487/498/23）。
- **[#198](https://github.com/McKenzieIT/semantic-grounding/issues/198) M3+T1 合一落地 `780d87c`（rebase 后终 sha）**——`edgeAnchorOf` 构串 seam 收九处裸模板（universe ×5 · canonicalizeAnchor · countMemoriesOnEdges · 对偶 pair · mcp add_relation 晋升目标）；barrel 27→28（ADR-0003 class (b) Update + acceptance 名单同步）；queries 枚举沉 io.ts `loadQueryDefinitions`（loadRawDir 单点、解 import 环）；`siteAnchorsOfNode` 三读面入口收一；evidence wire 2/5→5/5（create_definition table ①/concept ② · update ①② · add_relation ①②+③ 边锚点直断 seam 输出）；get_join_path 跨边折叠直测（跨边合流+键排序）；变异抽查（seam 改一空格 → 2 红）已回绿；四门禁亲跑 typecheck 双 0 / substrate 487 / mcp 503+1skip / e2e 23。
- **在飞 standalone（第四轮巡检余项，2026-10-17 晚开票）**：[#199](https://github.com/McKenzieIT/semantic-grounding/issues/199) M1「锚点宇宙从 registry 插件投影派生 + kind 前缀单源」（**blocked by #198 已解**〔`780d87c` 落地，可开工〕；parity 钉成员一致、性能同口径复测不劣化；与 #188 同函数体**不并行开工**）、[#200](https://github.com/McKenzieIT/semantic-grounding/issues/200) D1 残件三件（sgToolNames 参数化进单测面/X63 注册表解析两抄收一/runbook 互抄收口；只动 check-relay+relay-hitl，不急）。M2 = 既有 [#188](https://github.com/McKenzieIT/semantic-grounding/issues/188) 低优先级停放（票面已定方案 B：单定义贡献函数+按锚点裁剪读路径，naive 缓存经 ADR-0015 R6 否掉；勿重开）。图外另线在飞：map [#189](https://github.com/McKenzieIT/semantic-grounding/issues/189) 分析图（口径仲裁者做实，子票 #190–#197）与 [#185](https://github.com/McKenzieIT/semantic-grounding/issues/185)，均非架构线勿并票。

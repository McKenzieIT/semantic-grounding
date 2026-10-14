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

**map [#125](https://github.com/McKenzieIT/semantic-grounding/issues/125)（SG 短期方向——语义层 · 知识图谱 · 数据 memory 三层模型与工作流定位；charting 于 2026-10-14）开放中**，Destination（①三层领域模型 + memory→事实晋升规则落 ADR+GLOSSARY ②SG 在数据工程/分析/治理三类工作流的定位 ③按 ROI 选定的 KG 管理缺口 + memory 读写面落地四门禁全绿 ④**跨 agent 接力实测**——A 经 MCP 写 memory、B 零上下文经 SG 读到并改变行为，剧本固化可重复）。**本图带执行**（用户裁决：方向探索·讨论·决策·实施测试一张图）；验收以 ④ 为准（否决「仅工具面 e2e」）。承接已关 map #89 Out of scope 的「KG 强 schema」等议题。

已解子票（一行一票，详票 resolution 与 ADR）：

- **[#126](https://github.com/McKenzieIT/semantic-grounding/issues/126)**（research）：竞品 memory 模式——memory 与被确认事实恒为两个物理存储；晋升通路全预设在线审批人（ADR-0018 R1 已否）；无产品依赖 agent 自觉读 memory → SG 应挂既有读结果零税键；七借鉴/九不借鉴。
- **[#127](https://github.com/McKenzieIT/semantic-grounding/issues/127)**（research）：KG 层+语义层耦合盘点——七项缺口全部确证；⑤ memory 今天已在污染事实层（k11 带日期实测写进自由文本，复测即改指纹、漂移守卫误判）；⑥「什么都没有」证伪——table/event 三休眠槽 `confirmation`/`coverage`/`supersedes` 零消费者，`confirmed_by/at` 恰是 Cortex VQR 形状；治理缺口留 #131。
- **[#129](https://github.com/McKenzieIT/semantic-grounding/issues/129)**（research）：接力实测三腿真跑通（`claude -p --bare` 写口径落 commit / B 全新隔离会话自发调读工具命中 / `codex exec` 跨厂商同样读到）；`--bare` 挡 CLAUDE.md 但仍读 settings env 块需叠 `--setting-sources`；L0–L3 判定 N=5 ≥4/5；**不入四门禁**，改 opt-in `check-relay.ts`。
- **[#128](https://github.com/McKenzieIT/semantic-grounding/issues/128)**（task·HITL 五轮）：九张场景卡落 `docs/data-memory-scenarios.md`（工程 E1-E3 / 分析 A1-A3 / ETL 运维 G1′-G3′）；前提 **P1 载体 = k11 夹具复制 scope**、**P2 治理侧 SG 是经验库非检查器**；晋升三档浮现（永不/部分/立即）；ETL 运维知识在 SG 零落点；对 #130 硬约束——晋升若只写个 `confirmed_by`，与 114 张机器批次号确认的表无异。
- **[#132](https://github.com/McKenzieIT/semantic-grounding/issues/132)**（bug → 实测**降级为跨宿主兼容性**）：顶层 `z.discriminatedUnion` 编译出无顶层 `properties` 的 oneOf-only inputSchema，Claude Code CLI 2.1.263 静默丢弃；用户真实宿主（QoderWork + 当前 pod）两工具均可见 → ③ memory 写面不受阻挡；遗留价值：新写口勿沿用判别联合 + 防回潮断言（每个 inputSchema 须有顶层 `properties`）。
- **[#130](https://github.com/McKenzieIT/semantic-grounding/issues/130)**（grilling 五轮）→ ADR-0021 + GLOSSARY `memory`/`promotion`：两个物理存储 × 事实层两视角（语义层/KG 不重开）；判据「离开产生它的时间点与会话仍成立且已核实 → 事实，否则 memory」；memory 单向按身份锚定、事实层零反向链接、溯源进 trailer `X-SG-Memory`；agent 自晋升、证据 source/user-stated/replicated（≥2 条异会话异日）；五类型 observation/caveat（恒展示）/inference/practice/incident（永不升）。
- **[#131](https://github.com/McKenzieIT/semantic-grounding/issues/131)**（grilling 六轮）→ ADR-0022 + GLOSSARY `verified query`/`code reference`/`metadata governance`：四类定位（工程=带坑位标注的数据字典 / 分析=口径仲裁者 / **元数据治理=SG 自身作检查器** / ETL 运维=值班日志+血缘地图）；不连任何数据引擎；导航索引不存制品、SQL 原文永不进；优先级 分析→工程→元数据治理→ETL 运维；**本图收缩**——Destination ②→四类、③→ADR-0021 共用原语+已验证查询，四类深度工作各开专属 map（原 fog「KG 缺口取舍/治理读面/存量污染/命名约定」迁入种子）。
- **[#134](https://github.com/McKenzieIT/semantic-grounding/issues/134)**（grilling 九轮）→ [ADR-0023](docs/adr/0023-memory-storage-shape-and-node-ids.md) memory 存储形状+统一节点 id：`memory/<id>.yaml` 一条一文件**只追加**（5000 条全量读 941 ms vs stat 16 ms → 进程内增量缓存为必须项）；id `mem-<YYYYMMDD>-<8 位 base32>`；**图节点 id 统一 `<kind>:<名>`**（语料零迁移）；锚点=节点/列片段/边、写入时必须存在；更新=新条目 `supersedes{id, reason}`；三休眠槽退役；写工具 `record_memory` 顶层 object、整批原子。graduate #151/#152/#153。
- **[#135](https://github.com/McKenzieIT/semantic-grounding/issues/135)**（grilling 五轮）→ [ADR-0024](docs/adr/0024-memory-read-surface.md) 读面挂载：`get_definition` 挂 `memories` 8 / `edge_memories` 5 分栏独立预算（边两端都挂）；可选 `data_window: {from,to}` 传窗相交过滤、不传窗不隐藏按新近度；排序 practice>incident>inference>observation；`_guidance` 不挂读工具。graduate #154。
- **[#138](https://github.com/McKenzieIT/semantic-grounding/issues/138)**（grilling 六轮）→ [ADR-0025](docs/adr/0025-verified-query-shape-and-promotion.md) 已验证查询：独立 kind `query`、SQL 即正文（日期强制参数化）；证据只认 source/user-stated、replicated 拒写；读面 search 索引 + get_definition 挂 `verified_queries` ≤5；写面 `create_/update_verified_query`（#155 落地后工具面 29→32）。graduate #155。

**frontier = {#151, #153}**。blocked 关系：[#151](https://github.com/McKenzieIT/semantic-grounding/issues/151) id 统一+休眠槽退役（task）→ [#152](https://github.com/McKenzieIT/semantic-grounding/issues/152) memory 存储+`record_memory`（task）→ [#136](https://github.com/McKenzieIT/semantic-grounding/issues/136) 晋升 trailer+复现守卫（票面已按 ADR-0023 改写，含 E3 列别名缺口）；[#153](https://github.com/McKenzieIT/semantic-grounding/issues/153) 锚点目标改名/删除时 memory 去向（grilling）；[#154](https://github.com/McKenzieIT/semantic-grounding/issues/154) 读面挂载落地（task，blocked by #151/#152）；[#155](https://github.com/McKenzieIT/semantic-grounding/issues/155) 已验证查询落地（task，blocked by #136/#154）。fog：锚点改名/删除已票化 #153；存量污染/命名约定/KG 缺口取舍/治理读面随 #131 迁入四类深度工作专属 map 种子（Out of scope，触发另起）。

### 当前基线

2026-10-15 起（#149 后）：**typecheck 双包 0 / substrate 450 / mcp 437+1skip**（#149 删 `assertScopeIdShape` 10 直测，旧值 447+1skip）**/ e2e 22 / catalog spec 29 工具断言（文件 35 测）/ barrel 27+default / 工具面 29**。门禁数字漂移时以当日亲跑为准并勘误本节。

### 环境坑

- gh 2.102 keyring 认证（auth 异常先 `gh auth status` 自查）。
- acceptance 脚本 npm-ENOENT（Windows 坑）——barrel/catalog 对账改对 tsdown 构建产物手工 deepEqual，先例 #61/#87/#123。
- 直跑 .ts 需先 `pnpm -r build`（substrate `lib/` 是 workspace 解析目标，否则 ERR_MODULE_NOT_FOUND）。
- 并发会话开工先 `git fetch` + rebase；**rebase 后 CLAUDE.md 引用的合入 sha 要勘误**。
- read-count-probe 重载超时偶发非缺陷（判环境性：干净 HEAD 复现同败才立案）。
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

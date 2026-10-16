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
- **[#153](https://github.com/McKenzieIT/semantic-grounding/issues/153)**（grilling 三轮）→ [ADR-0026](docs/adr/0026-dangling-memory-anchors.md) 悬空锚点：票面「import 改名」前提证伪（import 只新建；节点删除/concept 合并无工具，仅 git 手工）；memory **不迁移不拦截、悬空读时现算**；边悬空仍挂两端 `edge_memories` 带 `relation_missing`；节点悬空 `definition_not_found` 错误 data 附 `orphaned_memories`；三处删边回执 `dangling_memories`；supersede 不校验被引条目锚点。下游并入 #152/#154。
- **[#151](https://github.com/McKenzieIT/semantic-grounding/issues/151)**（task）：ADR-0023 R4 节点 id 统一 `<kind>:<名>` + R8 三休眠槽（`confirmation`/`coverage`/`supersedes`）退役落地仓库代码，四门禁全绿；票面夹带的 X63 一次性清理同步完成——scope 10000354 下 171 条定义（61 表+110 事件）经 QoderWork 逐条 `get_definition`→摘除三键→`import_definitions` 回填，171/171 命中退役判据，commit `d0dc1f1`（该 commit 在 X63 自身独立仓库，不在本仓历史）。
- **[#156](https://github.com/McKenzieIT/semantic-grounding/issues/156)**（grilling 三轮）：剧本三卡全跑（E3+A3+G3′）但不原样搬 X63（本票实测证伪——X63 语料零黑话/零大R命中）；E3+A3 留 k11（#129 harness）、G3′ 换乘 X63（`qodercli`，实测可脚本化、直连 `--mcp-config` 不经 GUI 临时网关）。L0 按卡定表——E3 直升（仅 `X-SG-Evidence:source`）、A3/G3′ 仅写 memory 不升（仅 `X-SG-Session`）；**已知缺口**三卡无一触发 `X-SG-Memory`+`promoted`，graduate 为 #125 新 fog。契约替身进现有 `e2e` 门禁（不开新门禁），录 B 的 MCP 请求序列、断言响应含关键词而非响应体快照，等首次 `pnpm relay` 跑通后 fixture 落地再转 live；真接力维持 #129 裁决不进四门禁。

- **[#158](https://github.com/McKenzieIT/semantic-grounding/issues/158)**（grilling 六轮）→ [ADR-0027](docs/adr/0027-contested-memories.md) + GLOSSARY `contested`：服务端不判断「相反」，**由接入 agent 判断、服务端只认 `contradicts` 声明**；判断规程单一来源，渲染进 `record_memory` 描述 + 回执逐例指引 + `get_definition` 描述；读面 `contested_with` 成对不拆；agent 凭证据自裁（争议条目判 wrong 须写 `basis`）；争议挡 ③ 晋升。落点 `143309e`；「SG agent skills 系列」入 map Out of scope 种子。
- **[#159](https://github.com/McKenzieIT/semantic-grounding/issues/159)**（grilling 五轮）→ [ADR-0028](docs/adr/0028-column-jargon-as-term-concepts.md) + GLOSSARY `term concept`：列级黑话晋升为**术语概念**（KG 事实），不加列级 `alt_labels`；`concept:一级渠道`（1渠→`ch_type`）/`concept:二级渠道`（2渠→`ch_id`，`related_to` 隶属 1:N）；只记「术语→列」不连表、agent 按列名找表；E3 题目换到注释无别名的流失表 + 晋升前对照组；E3 的 A 腿在 `claude -p` 上走 `import_definitions`（`create_definition` 仍判别联合不可见）。
- **[#152](https://github.com/McKenzieIT/semantic-grounding/issues/152)**（task，subagent 落地 `7c47ade`〔rebase 后终 sha，票面 resolution 记 32d4487〕）：ADR-0023 R1–R3/R5/R7/R9 + ADR-0026 R5/R6 写侧 + ADR-0027 写侧增量——substrate 内部模块 `memory.ts`（off-barrel、Core 方法轴 `recordMemories`/`countMemoriesOnEdges`、barrel 零新名）+ 增量缓存锚点索引（stat 指纹仅重解析变化文件、跨进程可见不破 ADR-0015、wrong/contested 视图）+ 第 30 工具 `record_memory`（顶层 object、整批原子、一次一 commit、同会话 NOOP 零 commit、邻居回执附规程逐例指引）；三处删边回执 `dangling_memories`。
- **[#136](https://github.com/McKenzieIT/semantic-grounding/issues/136)**（task，worktree 并行落地、合入 `d5abbbc`〔resolution 记 ecd847d〕）：ADR-0021 R5–R7 晋升机制——五定义写工具可选 `evidence` 入参 → 三 trailer（`X-SG-Evidence`/`-Source`/`X-SG-Memory`）；replicated 复现守卫在 substrate（≥2 条、session 互异、UTC 日互异、wrong 不计、incident 拒、contested 拒指名对子，`promotion_rejected:-31026`）；`promoted` 回指 `withPromotionWrite` 同一 commit 追加；E3 零代码只补测试（#159 裁决）；ADR-0021/0023 补 Update、GLOSSARY `promotion` 更新。
- **[#154](https://github.com/McKenzieIT/semantic-grounding/issues/154)**（task，worktree 并行落地、合入 `4e15088`〔resolution 记 fd8680b〕）：ADR-0024 R1–R7 + ADR-0026 R2–R4 读侧 + ADR-0027 R4——投影沉 substrate（四 Core 读方法）；get_definition 分栏 8/5、关系工具每边 ≤3、search 只挂 `memory_counts`、resolve_alias/list 不挂、零税字节不变；`data_window` 加三读工具；wrong/outdated/promoted/caveat 可见性与排序；悬空读时现算（`relation_missing`/`orphaned_memories`/加回即恢复）；contested 随行传递闭包超预算不拆对。
- **[#155](https://github.com/McKenzieIT/semantic-grounding/issues/155)**（task，subagent 落地 `b1f0f4c`〔resolution 记 6256121〕）：ADR-0025 R1–R7——第 4 内建 kind `query`（content-sha 进 ADR-0019 指纹轴、SQL 永不进搜索、零图邻接）；写口 `create_/update_verified_query`（工具面 30→32、replicated 入口拒指路 `record_memory`、分区日期字面量拒写、memory_ids 同 commit `promoted` 回指、回执 `_guidance`）；读面表/概念挂 `verified_queries` ≤5 由 uses 现查、零税字节不变；ADR-0025 补 Update 七条、GLOSSARY 两词条。
- **[#157](https://github.com/McKenzieIT/semantic-grounding/issues/157)**（task，subagent 落地 AFK 部分 `b590001` + code-review P1 修复 `de05471` / P2 卫生批 `e48e29e`，**票由用户手关 2026-10-16**、resolution 汇总已补〔#117 先例〕）：`check-relay.ts` opt-in `pnpm relay` 三卡驱动（k11 复制沙箱 / X63 qodercli、L0–L3、N=5 ≥⌈0.8N⌉、E3 对照组须不过否则换题、CLI 缺席逐腿可行动报错）+ 契约替身/L0 断言进 e2e（22→23，含 `X-SG-Memory`+`promoted` 组合腿）+ HITL 清单 `docs/relay-hitl.md`；**真实接力实跑移交用户另一环境**（本机无 claude/codex/qodercli 与认证）。

- **[#179](https://github.com/McKenzieIT/semantic-grounding/issues/179)**（grilling 一轮）：G3′ 窗口外腿判据从答案措辞搬到工具轨迹——删 `negative` 三词，改为按题的 L1 断言（`data_window` ⊆ 九月且返回不含事故 memory）；否收紧 prompt / 维持现状；人工实测按新判据重判、不重跑。graduate #181（blocked by #180）。

**frontier = {[#180](https://github.com/McKenzieIT/semantic-grounding/issues/180)}；[#181](https://github.com/McKenzieIT/semantic-grounding/issues/181) 被 #180 阻塞**（2026-10-16 首次真实接力人工实跑后重算；#179 关票后再算）：用户裁决后续接力只用 QoderWork（人工）+ qodercli（脚本），弃用 Claude Code / codex → #180（grilling：三卡宿主重排、L3 含义、人工证据格式；含 `qodercliArgs()` 的 `--verbose` 在 qodercli 1.1.28 不被认的前置缺陷）；G3′ 经 QoderWork 人工跑 L0 PASS（X63 语料 `a2663d8`）/ 窗口内 PASS / 窗口外 L2 FAIL（B 自证对照把窗口外事故原文写进答案）→ #179（grilling：收紧 prompt / 放宽 negative / 维持）。记录见 `docs/relay-hitl.md` §9。两票定后再跑三卡、fixture 存证、对账 Destination ①–④ 关闭 map #125。图外旁证 **[#178](https://github.com/McKenzieIT/semantic-grounding/issues/178)（research，未挂本图，已关）**：「`get_definition` 比别的读工具慢」前提**证伪**（30 轮交替打点 p50 39.05ms，反而最快，五读工具同处 30–45ms 带——每个都每次重解析整个语料）；真瓶颈 = ADR-0026 读时悬空判定把 `memory.ts:577` `buildAnchorUniverse` 的写门全扫挂上读路径（X63 量级 memory 层 23.21ms/125 次额外 YAML 解析，归因重复扫描 ~29.6ms vs 真实投影 ~3.1ms，由语料规模而非 memory 条数驱动）；建议**低优先级不插队**——读路径语料缓存按 ADR-0023 R1 的 stat 口径跨调用失效（ADR-0015 R6/R7 明文 reopen 路径，`io.ts:416-417`；不得只用进程内 `corpusVersion`，会丢 ADR-0015 R3 跨进程正确性），预期 ~31→~10ms 且五读工具同步受益。findings 见分支 `research/get-definition-latency`（`360f92a`，`docs/get-definition-latency-2026-10-16.md` + 6 支探针）。fog：接力 e2e 复现证据卡（replicated 晋升需跨日期历史 fixture + 独立复测，待真实接力跑通后具体化，见 #125 Not yet specified）；存量污染/命名约定/KG 缺口取舍/治理读面随 #131 迁入四类深度工作专属 map 种子（Out of scope，触发另起）。

### 当前基线

2026-10-16 起（map #125 落地批 #152/#136/#154/#155/#157 后勘误）：**typecheck 双包 0 / substrate 487 / mcp 471+1skip**（沿革自 2026-10-15 的 432/434+1skip：#152 memory.spec +15 → 447、#136 memory.spec +6 → 453；mcp #152 +10 → 444+1skip、#136 +6 → 450+1skip；worktree 并行 #154 substrate memory-read.spec +20 → 473、mcp +9 → 453+1skip；#155 substrate verified-query.spec +14 → 487、mcp +12 → 471+1skip；#157 零测试面变化〔e2e 门禁步进 22→23〕；code-review 修复批 `de05471`/`e48e29e` 零漂移；mcp 旁注：concurrent-write.spec「四进程写一语料」满载偶发 1 败、单跑与全量复跑均零复现，与 import-definitions 2 守卫超时同款环境计时抖动留观）**/ e2e 23 / catalog spec 32 工具断言（文件 39 测）/ barrel 27+default / 工具面 32（沿革：#152 `record_memory` 29→30、#155 `create_/update_verified_query` 30→32，banner/e2e 全派生零硬编码）**。门禁数字漂移时以当日亲跑为准并勘误本节。

**分层门禁（map #164 · #168 Q6 定形）**：票内层 = 改动包及其下游 + typecheck 双包；合入 / 关图 / 收尾层 = 四门禁全量（typecheck 双包 / substrate / mcp / e2e）；e2e 仅合入层跑，不进迭代圈。

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
- **#160–#162 第三轮巡检 standalone 三票批**（2026-10-15 subagent worktree 三路并行落地、主会话串行合入，报告 `docs/architecture-review-2026-10-15.md` 行标与节首核验注记已落）：[#160](https://github.com/McKenzieIT/semantic-grounding/issues/160) `d66a13a` enrichment 收编面死名批（自由 `discoverAltLabels` 合并器退役 + 六死名清〔四适配器值/SweepResult/discoverEventRelationsFor〕；**sweepEnrichment 留存 = 巡检证据勘误**〔sweep.spec:23 经收编面消费〕；substrate 450→**449**）、[#161](https://github.com/McKenzieIT/semantic-grounding/issues/161) `582cb39` update 三件套迁 write.ts + apply_enrichment 约束去手抄（广告面 **+2 description 键对齐 commit-class 口径**——巡检「零 diff」口径勘误；errors.ts:607 假锚 3 词修正随票）、[#162](https://github.com/McKenzieIT/semantic-grounding/issues/162) `ebf0e99` 巡检 §S6 文档/锚点漂移 13 件清（含 ADR-0011 补 #149 Update 节、ADR-0010 死符号改指 `itemSuppressionFieldName` 实测锚）。
- **[#163](https://github.com/McKenzieIT/semantic-grounding/issues/163)** 审计残件清理批 `55003ee`——code-simplifier 双 subagent 复核三日审计窗口（`e6607fa..c602434` 99 文件）：#160 漏网类型半区六死 re-export / #161 漏网孪生守卫装置迁 write.ts / #122 孤儿 helper 删；主会话中央核验拦 subagent 两笔越线（误删 sweepEnrichment 撞 c602434 勘误、utf8 顺手改）；门禁四绿对基线；报告项三件未动（`toExecutableRule?` 需 ADR-0003 修订 / shared.ts 头注枚举 / ADR-0017 死链）。
- **[#171](https://github.com/McKenzieIT/semantic-grounding/issues/171)/[#172](https://github.com/McKenzieIT/semantic-grounding/issues/172) #163 报告项处置两票**（2026-10-15 同会话连跑）：#171 `24d7b06` `toExecutableRule?` 死可选字段退役（ADR-0003 Update 2026-10-15 随票——名级白名单不动、向后兼容保留期结束 = 全仓零实现零消费实证；acceptance 亲跑死于已知 npm-ENOENT 环境坑〔断言前〕，名单主张改 `lib/index.d.ts` 层实证〔类型名在册/字段 0 处〕；:110 并提的 `loadDomains` 分家为活件不动）、#172 `ac0402b` 漂移修字批两件（shared.ts 头注 4/9 枚举改派生表述〔#115 先例〕+ ADR-0017 :10/:53 死链改 `git show 2913c26` 回查形式）；四门禁对基线逐字不动。
- **map [#164](https://github.com/McKenzieIT/semantic-grounding/issues/164) 测试套件减负关图**（2026-10-15 subagent worktree 三路并行落地、主会话中央核验后串行合入；**push 前经 rebase 过并发 #151**——三票 sha 为 rebase 后终 sha，substrate 自 450 起算 449→431）：[#169](https://github.com/McKenzieIT/semantic-grounding/issues/169) `2d9f921` mcp 删并批 A（C4/C8/C15/C16+D3 修字，437→**432+1skip**）、[#173](https://github.com/McKenzieIT/semantic-grounding/issues/173) `96c17f5` substrate 删并批 B（九件+D1/D2 修字，450→437·**C13 多条目 fetch 混批景亲验 parity 未盖留件**）、[#174](https://github.com/McKenzieIT/semantic-grounding/issues/174) `b9a0599` 提速批 C（4a fixture git 模板仓库 per-worker 复用+gc.auto=0、4b R3 冷启 60→6、4c read-count-probe path5 三分子集、4d pretest hash 守卫跳过、4e maxWorkers=8 + 同文件删并 −6 至 431；**mcp 墙钟 53.2s→38.3s、substrate 16s→8.2s、全量一轮 85–90s→~64s**）；合入收尾 `a277268`（基线勘误+分层门禁两档落盘）、[#170](https://github.com/McKenzieIT/semantic-grounding/issues/170) 终验关图 `bcd143a` + rebase 勘误随本 commit（删件 rg 清零 14 串、覆盖方五处抽查、基线口径一致 431/432+1skip、rebase 后四门禁复跑全绿）。**留观**：mcp 单测偶发失败三观测零复现（#174 落地时 + 合入首跑 + #151 侧 import-definitions 2 守卫超时旁注，复跑均全绿）；**交接 S2**：`src/index.ts:16` 生产头注 "fifteen" 计数漂移（本图边界只动测试文件）。
- **#175/#176/#177 code-review 批**（2026-10-15 mcp 包两轴状态审阅〔Standards/Spec 并行 subagent〕+ 对抗性核验后三票同日 worktree 并行落地、主会话串行合入；**push 前经 rebase 过并发 #158 docs 关图批**——三票 sha 为 rebase 后终 sha；核验亦证伪三条：binding loader seam〔#137 勘定〕、write/items 再收 seam〔#47 薄包装口径〕、deregister_scope `binding_cleared` 键〔票 #72 resolution 正典有记〕）：[#175](https://github.com/McKenzieIT/semantic-grounding/issues/175) `45c9cca` mcp 卫生批（recorder `AuditContext.files`/`.rounds` 死字段退役〔11 intent 字面量五键零 setter、commitContext spread 恒空、`beginBatch.end` 自算唯一真源，#171 先例同构〕+ binding.ts `scope_unloadable` 文案二抄收 `scopeUnloadableError` 单点〔#137 双函数分离不动〕，mcp 零漂移）、[#176](https://github.com/McKenzieIT/semantic-grounding/issues/176) `e776c26` submit_suggestion 参数面退役（**裁决=退役非补档**：ADR-0005 裁决 7 canon、全仓零消费、#171/#88 先例；工具面+substrate `SubmitArgs`/`PendingSuggestion` 双面清零，存量容忍两面钉死 substrate +1/mcp +2 → **432/434+1skip**，ADR-0005 Update + GLOSSARY pending queue 记档；io.ts `Tier2RecordMeta.tenant_id` 系 Tier-2 audit 元数据面未动）、[#177](https://github.com/McKenzieIT/semantic-grounding/issues/177) `e7a8595` 散文漂移批（server.ts barrel「36-name」旧数改 ADR-0003 锚派生表述、index.ts fifteen/three 计数漂移改 `INTENT_TOOL_FAMILIES` 派生+`beginBatch` 纠正为 recorder 机制非注册工具〔**map #164 交接 S2 fifteen 件随本票清账**〕、GLOSSARY:464 Tier-1 四件套补真名）；docs 收尾随本 commit。合入层四门禁当日亲跑全绿（rebase 前后各一轮）：typecheck 双 0 / substrate 432（7.4s）/ mcp 434+1skip（34.9s）/ e2e 22（banner tools: 29 确认）。

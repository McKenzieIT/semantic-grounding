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

**map [#40](https://github.com/McKenzieIT/semantic-grounding/issues/40)（MCP 管理面的 scope 能力边界与初始化路径）已关闭**，Destination（scope 能力边界 + 壳/内容双初始化路径的 ADR 级设计产出）经五张子票全解达成：
[能力边界](https://github.com/McKenzieIT/semantic-grounding/issues/42)（grilling，已解：MCP 管 scope 知识层+注册层、不管基础设施执行；MCP 非 harness）、
[需求场景](https://github.com/McKenzieIT/semantic-grounding/issues/43)（research，已解：三层模型——基础设施/注册表/运行时；substrate 已就绪但 MCP 未接 `setScopeRegistry()`）、
[一进程一 scope 松绑](https://github.com/McKenzieIT/semantic-grounding/issues/44)（grilling，已解：server 绑注册表不绑目录，`--corpus` 可选〔此条与「注册表在 git dir 内」经 #45 supersede〕；scope↔目录双向 1:1；三层隔离防线——读盖戳/写断言/切换 digest；trailer 从 registry identity 派生）、
[具体设计方案](https://github.com/McKenzieIT/semantic-grounding/issues/45)（grilling，已解：**四裁决**+9 设计常数——①**入口快照绑定**〔前置实测：SDK v2.3.1 同连接请求**不串行**，源码+行为双证；handler 入口同步解析绑定快照，switch=原子指针置换，per-scope 实例切走不 dispose〕②**统一注册表** `~/.semantic-grounding/scopes.yaml`〔`--registry`/`SG_REGISTRY` 覆盖·测试隔离、文件锁+原子写、`active:`=下一进程缺省〕③**删除 `--corpus`**〔无用户清断，引导唯一门=`register_scope`，flag 面收敛 `--agent-id`/`--scope`/`--registry`/`--lock-timeout-ms`，posture 移至 register/switch/`--scope` 三时机 fail-fast〕④**trailer 恒由 registry identity 派生**；错误段 `-31060..-31065`；substrate **零改动**（per-scope core，`setScopeRegistry` 不调用）；工具面 19→24；ADR-0011 草案全文在 resolution、落盘归执行 effort）、
[语义层内容冷启动](https://github.com/McKenzieIT/semantic-grounding/issues/46)（grilling，已解：**轨迹驱动冷启动**——仅作者路（词 miss → 依据 DDL/文档 create_definition，不预铺种子），批量导入=Followup 带触发条件+provenance 预录（derivation=agent、来源进 summary、无新 trailer 槽）；**概念写路径开门**〔概念=知识图谱 ontology 层〕——零新工具名：create/update 加 kind:'concept'、AliasKindSchema 拆分、relation 两工具不扩、substrate +2 原语（writeConceptYaml/updateConceptMeta）、supersede ADR-0005 裁决 2 的 concept 排除〔metric 维持〕、4 条 description 重写；scaffold `next_steps`=自包含一行〔五要素两禁止〕；对抗性复核三修〔ADR-0005 Update/mcp 4 伴生点/description〕并入；票面前提两处核正〔syncWriteDefinitions 是 TableMeta 形状非导入底座、概念原无任何写路径〕；ADR-0012 草案全文在 resolution）。**map 随本票关闭**：Destination 达成，执行另起 fresh effort，ADR-0011/0012 随执行落盘 accepted；GLOSSARY 新增 cold start 词条。

**map [#50](https://github.com/McKenzieIT/semantic-grounding/issues/50)（MCP 初始化 toolkit——scope + 概念 properties + 批量导入 + playbook 动态指引）进行中**——Destination：任意远程 agent 经 MCP 为任意新产品初始化完整语义层（数仓语义层 + 游戏知识图谱双层）：scope 管理（ADR-0011）、概念注册与 properties 扩展（ADR-0012 + Q4(b)）、批量定义导入（#46 R1 触发条件已到）、初始化 playbook 与动态指引（Q5(b₂)）。Toolkit 是平台能力非工作流——编排权留使用者，平台只提供原语 + 软引导。前置 map #47 已关（#49 落地后的干净 Core 基础）。六张子票：
[动态指引实现方式](https://github.com/McKenzieIT/semantic-grounding/issues/53)（grilling，已解：**选项 D**——playbook 工具（#55 另裁 API）+ 写工具响应级条件注入（仅 6 个写工具、注入点 `auditedWrite` 响应组装后、`_guidance: {phase, hint, metrics}` JSON 结构化、非初始化时字段完全消失零 tax、触发先用 definition count 阈值默认 10、#55 阶段模型落地后升级接口不变））、
[scope 管理工具落地](https://github.com/McKenzieIT/semantic-grounding/issues/51)（task，已解：**全部落地**——五工具〔tools/list 19→24〕+ `scopes.yaml` 统一注册表 + 入口快照绑定 + `scope_id` 必填〔−31064〕+ 删 `--corpus`；ADR-0011 accepted 落盘；substrate 零改动；4 新 spec 52 tests；合入 main `f66c787`〔已 push 2026-10-12〕）、
[概念写路径落地](https://github.com/McKenzieIT/semantic-grounding/issues/52)（task，已解：**全部落地**——substrate +2 原语〔`writeConceptYaml`/`updateConceptMeta`〕、六工具 `kind:'concept'` 分支零新工具名、Q4(b) `properties` + 概念侧关系〔三种边 + 存储归宿：table→concept 落 TARGET 概念文件〕、curated 边移除首调即终局；ADR-0012 accepted 落盘 + ADR-0005 Update supersede 段〔metric 排除维持〕；`concept-write.spec.ts` 33 tests；合入 main `708b00e`〔已 push 2026-10-12〕——与 #51 合并交叉面两真冲突 + e2e step 14 `scope_id` auto-merge 盲区当场修复，细节在票 resolution）。
[批量导入工具设计](https://github.com/McKenzieIT/semantic-grounding/issues/54)（grilling，待 HITL：输入形状/校验/尺寸上限/部分失败语义/provenance 四原则）、
[初始化 playbook 设计](https://github.com/McKenzieIT/semantic-grounding/issues/55)（grilling，待 HITL：阶段模型/覆盖率指标/双层进度/完成度定义——**#56 的 blocker**）、
[动态指引落地](https://github.com/McKenzieIT/semantic-grounding/issues/56)（task，blocked by #55：`_guidance` 注入 + 触发条件 + e2e 阈值边界转换步）。

**map [#47](https://github.com/McKenzieIT/semantic-grounding/issues/47)（item 写语义沉进 Core——suppression 写半边回家）已关闭**，Destination（item 写语义沉 Core 方法契约层 + 工具恢复薄包装 + 写-删循环两半同包测试）经两张子票全解达成。原 Destination 细目：四个 item 级写工具的领域语义（双字段覆盖、否决并集/撤销、ensure-absent、origin 路由、锁内重读判 `reasserted`、关系同一性、`normalizeLabel` 键归一化）从 MCP 工具层沉进 Core 方法契约层；工具恢复 ADR-0005 本意的薄包装（schema + `runAudited` + 转发）；写-删循环两半（写侧语义/读侧轮次过滤）同包同 interface 测试。来源 2026-10-11 架构走查（证据 file:line 全记 map Notes：`normalizeLabel` 三份漂移风险〔enrichment.ts:898 / enrichment-work.ts:506 / mcp items.ts:60〕、items.ts 各约 100 行/工具的否决政策建立在 `updateTableMeta` 浅覆盖接口上）。两张子票：
[接口裁决](https://github.com/McKenzieIT/semantic-grounding/issues/48)（grilling，已解：**四裁决**——①四个 Core 方法 1:1 对应四个 intent 工具，verdict 复用 ADR-0010 形状，Core 不接 AuditIntent/recorder（handler 的 `auditedWrite` 提供 ambient context）②recorder 靠 ambient context 与 ADR-0005 ruling 3 相容且更好实现其本意（原子性升级为方法级保证），落 ADR-0005 Update 段③enrichment_health 条件性留工具层（MCP 响应协议关注点非 domain）④domain 测试迁 substrate `item-write.spec.ts`、wire 测试留 MCP，顺序：substrate 双跑→迁 handler→精简 MCP；run_enrichment 编排下沉列 Followup（触发：dsh 需要同 round 时成票）；零新 ADR、零新 GLOSSARY 词条）、
[落地](https://github.com/McKenzieIT/semantic-grounding/issues/49)（task，已解：**全部落地**——四个 Core item 方法持有全部领域逻辑；items.ts 薄到 schema+auditedWrite+Core 调用+响应格式化；`normalizeLabel` 归一 io.ts；ItemVerdict 走 barrel 类型面；substrate `item-write.spec.ts` 30 tests + MCP wire 7 tests；ADR-0005/0010 Update 段落落盘；落 main `5d42157`〔已 push 2026-10-12〕。**落地勘误**：WIP 曾把 `normalizeLabel` 误上根 barrel 运行时面，acceptance 37 名白名单证伪——越界导出已删（ADR-0003 锁死维持），四道门禁复跑全绿；另 `concurrent-write.spec.ts` 在两轮门禁叠加时出现过一次「nothing to commit」失败，隔离复跑 5/5 绿，判定负载抖动非缺陷，留痕）。两张前置已 2026-10-11 落 main〔已 push 2026-10-12〕：`52691c7` 工具层 audited-call 深模块（8 写 handler 仪式收敛进 `tools/audited.ts`、`clientNameFromEnvelope` 全包唯一份）、`f73cd78` version 指纹收进 Core 读路径（`io.ts` `definitionVersion`+Core 三 `*WithVersion` 方法、shared.ts 指纹四函数退役、手改名 event 文件 ENOENT 分叉消失、新 spec `version-roundtrip.spec.ts`）；门禁全绿（typecheck 双包 / substrate+mcp 全量单测 / acceptance barrel 零改动 / e2e 17 步）。

**map [#32](https://github.com/McKenzieIT/semantic-grounding/issues/32)（agent 持久否决权与抽取器护栏）已关闭**，Destination（持久否决权成立 + 抽取器护栏落地 + 语料清理 + #24/#26 关票）经七张子票全解达成：
[护栏规则全库实测](https://github.com/McKenzieIT/semantic-grounding/issues/33)（prototype，已解：766 定义 → 基线候选 4296；12 谓词 + cap24 杀 51.0%，误杀 0）、
[负知识 prior art](https://github.com/McKenzieIT/semantic-grounding/issues/34)（research，已解：定名 `suppression`，SARIF §3.35 同构）、
[护栏裁决](https://github.com/McKenzieIT/semantic-grounding/issues/35)（grilling，已解：12 谓词 + cap24，全常量，domains 旁路）、
[存储形状](https://github.com/McKenzieIT/semantic-grounding/issues/36)（grilling，已解：per-asset YAML + 另立构件 `suppression`）、
[工具面](https://github.com/McKenzieIT/semantic-grounding/issues/37)（grilling，已解：全零新工具，删除即否决 + ensure-absent + corpus 词表）、
[修落地](https://github.com/McKenzieIT/semantic-grounding/issues/38)（task，已解：合入 main `4d7748b`，新 ADR-0009/0010）、
[语料清理与护栏全库复测](https://github.com/McKenzieIT/semantic-grounding/issues/39)（task，已解：445 events revert 3cef160 + _di/_df 补录 30 条 suppression + enrichment 自证活体闭环）。**#24/#26 关票**。

**map #27（enrichment 工具维度语义与响应尺寸治理）已关闭**，Destination（维度过滤语义统一+
work listing 尺寸治理+盲区钉死+#25 关票）经四张子票全解达成：
[过滤语义裁决](https://github.com/McKenzieIT/semantic-grounding/issues/28)（grilling，已解：call-wide——
指定任一维即约束整个调用/未指定=不扫/`{}`=全量；空数组 zod `min(1)` 收死；未知名门口 coded error；
语义落 Core 方法契约层，自由函数/on-write hook/dsh 零改动；subject 同源对账；新 ADR-0007 + 词条
`dimension filter`）、
[MCP 大响应与分页惯例](https://github.com/McKenzieIT/semantic-grounding/issues/29)（research，chart 会话已解：
`tools/call` 无协议级分页，生态收敛 = cap + `total`/`truncated` + 过滤缩围；附带发现 `structuredContent`
在 SDK v2.3.1 真实存在，ADR-0005 勘误已落盘）、[work listing 尺寸治理形状](https://github.com/McKenzieIT/semantic-grounding/issues/30)
（grilling，已解：**索引/题面分离**——listing 改索引形 `{work_id, target, gap}`（cap 1000 行）+ `total`/`truncated`
走 content JSON 顶层、新增第 19 工具 `get_enrichment_prompts(work_ids≤10)` 按批取题面；折法=单次响应最坏 ≤
半窗（200K 级）；翻页/top_k/structuredContent/保留内嵌〔triage 死胡同——缺口分布只有 listing 知道，猜名撞
#28 coded error〕全否；新 ADR-0008 + GLOSSARY `enrichment work` 修订）、
[修落地](https://github.com/McKenzieIT/semantic-grounding/issues/31)（task，三票结论落代码：Core 契约层
call-wide 过滤 + 索引/题面分离 + 第 19 工具 + events fixture 钉盲区 + e2e 扩步（19 工具）+ 工具 description
重写 + ADR-0007/ADR-0008/ADR-0005 勘误；全量测试绿（368/368）+ `pnpm e2e` 绿（19/19），合入 main
`1ba8b58`）。**[#25](https://github.com/McKenzieIT/semantic-grounding/issues/25) 关票**。k11 清理归 #26、
tombstone 归 #24（map #27 Out of scope 记录）。附带发现（范围外，留痕于 #31 关票评论）：
`enrichAllDwsTables`/`enrichAllEvents` 的 `written` 计数器统计调用次数非内容变化次数——substrate 既有
行为，未来若需收紧另开票。

**map #12（MCP 管理面）已关闭**，Destination（agent 经 MCP 读 grounding、经 Tier-2 审计写回、
`git log` 答 provenance）经两面验收：CI 第三道门禁 **`pnpm e2e`**（`packages/mcp/scripts/check-e2e-loop.ts`，
13 步走真实 `startup()` 形状；GLOSSARY **end-to-end gate** 词条）+ QoderWork 真 agent dogfood
（**`docs/mcp-dogfood.md`** 全记录：五读工具全调用、三写回 + 幂等零 commit + stale_baseline
重读重试活体闭环、`git log -p --follow` 对账零出入、两 commit 形状复现、author=agent /
committer=server 身位分离成立）。dogfood 首连 -32601 已修（宿主连接期探测 prompts/resources
list，SDK 声明能力不接线〔tools-only〕——显式空 handler，mcp 249 测试）。发现开三张后续
issue（needs-triage）：**[#24](https://github.com/McKenzieIT/semantic-grounding/issues/24)**
tombstone（写-删循环 domain 变体实锤：remove→同锁回灌→指纹回退）、**[#25](https://github.com/McKenzieIT/semantic-grounding/issues/25)**
enrichment 维度过滤（1 表 subject / Files=446）+ work listing 尺寸上限（579 项 / 25.9MB）、
**[#26](https://github.com/McKenzieIT/semantic-grounding/issues/26)** 抽取器护栏（长描述括引
片段撕成 28 条「别名」）。
dsh 深耕暂停。遗留两件、
各有去处：dsh 升级 substrate alpha.3 的全部断点在
[#11](https://github.com/McKenzieIT/semantic-grounding/issues/11)（低优先，随 dsh 下次升级一并
处理）；发布 `@semantic-grounding/substrate` 是 dsh 下次发版的阻塞前置（map #1 Out of scope
记录，届时作 fresh effort，alpha 发布不关 ADR-0003 的裁剪窗口）。

前一张 map #1（extract semantic grounding substrate）已随
[slice 5](https://github.com/McKenzieIT/semantic-grounding/issues/7) 关闭：Destination 在
slice 4b 达成（dsh 对 tarball 安装启动并过门禁，PR dsh#187），slice 5 把 root barrel 名级白名单
落地（ADR-0003，148 → 67，acceptance gate 以精确名单断言钉死）。

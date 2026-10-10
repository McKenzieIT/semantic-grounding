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

**map [#32](https://github.com/McKenzieIT/semantic-grounding/issues/32)（agent 持久否决权与抽取器护栏）**
—— 驱动 [#24](https://github.com/McKenzieIT/semantic-grounding/issues/24)（tombstone）+
[#26](https://github.com/McKenzieIT/semantic-grounding/issues/26)（抽取器护栏）修落地。Destination：
enrichment 轮不再重断言 agent 已删内容（relation / alias 两变体全盖）+ 抽取器不再把描述碎片撕成别名 +
`~/sg-dogfood-corpus` 446 个受污染定义清干净 + 新 ADR/GLOSSARY + 门禁绿（含新增「删了不回灌」e2e 步）+
**#24/#26 关票**。执行进图（覆盖 plan-only 默认）。真宿主 dogfood 复验在 Out of scope（机制正确性 CI
可证，护栏假阴性离线全库 diff 覆盖面更宽）。七张子票：[#33](https://github.com/McKenzieIT/semantic-grounding/issues/33)
护栏规则全库实测（prototype，**已解**：766 定义 → 基线候选 4296；#26 原始 9 条规则 + cap24 杀 39.6%，
补 5 条实测安全规则到 51.0%，**误杀实测为 0**〔需人眼过目 105 词无一真别名；`DAU`/`现金券` 存活〕；
**否决集 ≈ 2103 条 / 全局去重 711 词**——已核事实 ⑧ 窄机制支可达且不需压实；作用域强双峰〔577 词
81.2% 纯局部 vs 14 词承载 55.9% 出现量 → 两级作用域各管一头，corpus 级用例是具名词表枚举非正则模式〕；
`partition-kv` 完全冗余、长度上限几乎不影响结果〔cap 12→50 仅动 0.8pp〕、规则「不抽自身 id 子串」实测否决；
探针分支 `prototype/33-guardrail-rule-probe`，`out/report.html` 可拨规则）→
[#35](https://github.com/McKenzieIT/semantic-grounding/issues/35) 护栏裁决；
[#34](https://github.com/McKenzieIT/semantic-grounding/issues/34) 负知识 prior art（research，**已解**：
定名推荐 **`suppression`**〔SARIF v2.1.0 OASIS §3.35，`kind:"external"` 规范原文即「再次出现即忽略」；
SARIF 把 `suppressions` 与 `provenance` 分置两属性，与本仓 `origin` / `X-SG-Derivation` 刻意非对齐同构
→ 倾向另立构件而非扩写 `origin`〕；`tombstone` 已被 DataHub/OpenMetadata 以存储层原义占用且语义不对
〔后写覆盖、约 10 天后遗忘、为向副本传播删除而存在〕；存储形状 `inSource`/`external` 由 SARIF 标准化，
第三条「根本不存」是数据目录主流，`external` 硬前置是**键**〔SARIF 指纹 / SKOS-XL 给标签铸 URI，即裸
字符串 `alt_labels` 无逻辑身份的标准解〕；撤销普遍支持、**无一家压实**；**空白**：四家数据目录无一在机器
写入权威状态**之后**建立持久否决〔闸门都在写入前〕，本仓 `enrichOnWrite`「先写后治」在先例里独特——
可抄词汇与生命周期机械、抄不到形状；全文 `research/negative-knowledge-prior-art` 分支
`docs/research/negative-knowledge-prior-art.md`）+ #35 →
[#36](https://github.com/McKenzieIT/semantic-grounding/issues/36) 领域语义与存储形状
→ [#37](https://github.com/McKenzieIT/semantic-grounding/issues/37) 作用域/批量/工具面 →
[#38](https://github.com/McKenzieIT/semantic-grounding/issues/38) 修落地 →
[#39](https://github.com/McKenzieIT/semantic-grounding/issues/39) 语料清理 + 全库复测 + 关票。
**当前 frontier：#35（grilling，HITL）**，其余全被阻塞。
**注 1**：map #27 Notes 记的「子代理通道暂不可用」已过期，2026-10-10 实探已复通。
**注 2**（#33 更正的两处前提，下游票不要再按原文用）：① 语料是 321 表 + **446** events 而非 453
——`events/` 是二级目录，453 个 YAML 里 7 个是 loader 跳过的 `_index.yaml`；map #32 验收口径 ② 已更正。
② 验收口径原点名的 `GMV` / `T+1` **全库从来不是候选**（描述里是白文，不在括号/引号/`domains` 内），
拿它们写假阴性守卫断言会是永真空断言，已从口径移除，守卫词表改用 `DAU` / `现金券`。
③ `discoverAltLabelsDeterministic` 的 docstring 称确定性轮吃列注释，**实际不吃**（只吃 `description`
或 `table_comment` + `domains`，列注释只在 LLM 轮 prompt 里）——#35 票面第 5 条原建立在此前提上，已在票内更正。

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

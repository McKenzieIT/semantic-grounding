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

**无活跃 map** —— 所有 map 已关闭。

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

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

**map #27（enrichment 工具维度语义与响应尺寸治理）进行中**——驱动
[#25](https://github.com/McKenzieIT/semantic-grounding/issues/25) 修落地（执行进图，收口=门禁绿+关 #25）。
四张子票：[过滤语义裁决](https://github.com/McKenzieIT/semantic-grounding/issues/28)（grilling）、
[MCP 大响应与分页惯例](https://github.com/McKenzieIT/semantic-grounding/issues/29)（research，chart 会话已解：
`tools/call` 无协议级分页，生态收敛 = cap + `total`/`truncated` + 过滤缩围；附带发现 `structuredContent`
在 SDK v2.3.1 真实存在，ADR-0005 addendum 待勘误）、[work listing 尺寸治理形状](https://github.com/McKenzieIT/semantic-grounding/issues/30)
（grilling，blocked by #29）、[修落地](https://github.com/McKenzieIT/semantic-grounding/issues/31)（task，
blocked by #28、#30）。k11 清理归 #26、tombstone 归 #24（map #27 Out of scope 记录）。

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

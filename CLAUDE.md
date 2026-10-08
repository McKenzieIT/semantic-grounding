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
Frontier：#17 workspace 化（task）、#18 substrate 契约升级（task：recorder 异步化、Tier-2 回滚、
写原语可选 Tier2Opts、beginBatch 槽位）；#19 git recorder 实现（task，被 #18+#17 挡）；#15 tool
surface、#16 enrichment 机制（设计票，已解锁，输入见各自评论区引 #13）。dsh 深耕暂停。遗留两件、
各有去处：dsh 升级 substrate alpha.3 的全部断点在
[#11](https://github.com/McKenzieIT/semantic-grounding/issues/11)（低优先，随 dsh 下次升级一并
处理）；发布 `@semantic-grounding/substrate` 是 dsh 下次发版的阻塞前置（map #1 Out of scope
记录，届时作 fresh effort，alpha 发布不关 ADR-0003 的裁剪窗口）。

前一张 map #1（extract semantic grounding substrate）已随
[slice 5](https://github.com/McKenzieIT/semantic-grounding/issues/7) 关闭：Destination 在
slice 4b 达成（dsh 对 tarball 安装启动并过门禁，PR dsh#187），slice 5 把 root barrel 名级白名单
落地（ADR-0003，148 → 67，acceptance gate 以精确名单断言钉死）。

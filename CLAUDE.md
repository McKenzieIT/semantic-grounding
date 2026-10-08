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

**没有活跃 map**（2026-10-08）。map #1（extract semantic grounding substrate）已随
[slice 5](https://github.com/McKenzieIT/semantic-grounding/issues/7) 关闭：Destination 在
slice 4b 达成（dsh 对 tarball 安装启动并过门禁，PR dsh#187），slice 5 把 root barrel
名级白名单落地（ADR-0003，148 → 67，acceptance gate 以精确名单断言钉死）。

**下一程（用户方向，2026-10-08）：MCP 管理面**——按 `docs/mcp-map-seed.md` 起新 wayfinder
map（charting 是独立会话）；dsh 深耕暂停。遗留两件、各有去处：dsh 升级 substrate
alpha.3 的全部断点在 [#11](https://github.com/McKenzieIT/semantic-grounding/issues/11)
（低优先，随 dsh 下次升级一并处理）；发布 `@semantic-grounding/substrate` 是 dsh 下次发版
的阻塞前置（map #1 Out of scope 记录，届时作 fresh effort，alpha 发布不关 ADR-0003 的
裁剪窗口）。

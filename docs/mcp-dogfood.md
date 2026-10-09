# MCP dogfood — 真 agent 挂 stdio 的实测记录

**Status: pending** — 记录模板与清单已就位（2026-10-09，#23 Part A 落地时建篇）；下面各节
「记录」处待真 agent 跑过后填写。本篇是 [#23](https://github.com/McKenzieIT/semantic-grounding/issues/23)
Part B 的落点（裁决：dogfood 记录进 docs/，resolution 链接此处），也是 map #12 Destination
「另做一次真 agent dogfood」的验收材料。

脚本化的一半（Part A，CI 可跑、无 LLM）已由 `pnpm e2e` 承担：
`packages/mcp/scripts/check-e2e-loop.ts`，13 步走完读→写→commit→provenance 回路。
本篇只记**真 agent** 才能测出的东西。

## 为什么宿主是 QoderWork 等办公 agent（而不是 Claude Code）

2026-10-09 更正（原 Destination 记 Claude Code）：dogfood 宿主应是接入后的真实使用者——
办公场景的 agent。#22 为此留了两处余量：配置载体 CLI flag + 环境变量双通道、协议
`legacy:'serve'` 两个 era 都服务。宿主的注册面是否暴露 args/env、开口用哪个 era，
都是**未核实**的前提——dogfood 的第一步就是把它测出来。

## 第 0 步：抓宿主的开场报文（判定协议 era）

#23 原文：「值得先抓一次它的开场报文（走 `server/discover` + modern 信封，还是 legacy
`initialize`）。」最省事的抓法是注册一个 tee 包装，stdin 落盘后再交给 server：

```json
{
  "command": "sh",
  "args": ["-c",
    "tee /tmp/sg-dogfood-open.jsonl | node /绝对路径/packages/mcp/src/bin.ts --corpus /绝对路径/corpus --agent-id dogfood-agent"]
}
```

连上后看 `/tmp/sg-dogfood-open.jsonl` 首行：`"method":"server/discover"` 即 2026-07-28
modern era；`"method":"initialize"` 即 2025 legacy era（`legacy:'serve'` 下同样可用）。
确认后可改回直接注册 `node …/src/bin.ts --corpus … --agent-id …`（Node ≥ 22.18 直跑 .ts；
或先 `pnpm -r build` 后用 `node …/packages/mcp/lib/bin.js`）。

**记录：**（era + 开场原文关键行）

## 覆盖清单（与 ADR-0005 §Verification 的 dogfood 条目对齐）

1. **问数读路径**：让 agent 回答一个真实问数场景——「订单表要关联哪张维表、用户说
   “订单宽表”指哪张表」，走 `search_definitions` → `get_definition` → `get_join_path` /
   `get_relations` / `resolve_alias`。
2. **三写回**（Destination 原文：definition / relation / alias 各一条）：
   `create_definition` 或 `update_definition` 一条、`add_relation` 一条、`add_alias` 一条
   （真实业务内容，不是 hello world），全程经 Tier-2 审计写路径。
3. **可选加餐**：`run_enrichment` → `get_enrichment_work` → `apply_enrichment` 的
   出题-答题回路（agent 用自己的模型答题）。
4. 每次写后 `git log -p --follow` 抽查一条：author 是 agent、trailer 载明依据。

**记录：**（每项：成功/失败、agent 的原话或截图要点、git log 摘录）

## 观察点（fog 的触发条件挂在这）

- **写-删循环**：agent `remove_relation` 删掉机器推导的 ref 后，下一轮 enrichment 又推
  回来、agent 再删——出现即 tombstone（agent 持久否决权）成票（ADR-0005 Consequences、
  map #12 Not yet specified 仅存项）。
- **摩擦**：工具面是否够用（`get_context` 复合工具的 Followup 触发条件）、搜索召回
  质量（bigram 打分的 Followup 触发条件）、enrichment work 的 prompt 是否好答。
- **宿主兼容**：era、clientInfo 逐请求变化是否出现在 `X-SG-Client`、`legacy:'serve'`
  的回退是否真的被走到。

**记录：**

## 结论

**记录：**（Destination 是否达成的一句判词 + 需要成票/成 Followup 的事项清单）

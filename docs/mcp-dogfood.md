# MCP dogfood — 真 agent 挂 stdio 的实测记录

**Status: done（2026-10-10）** —— QoderWork 全程跑完读写回路 + enrichment 段，Destination 判定达成；四项发现开 A/B/C 三张 issue（编号见文末）。本篇是 [#23](https://github.com/McKenzieIT/semantic-grounding/issues/23)
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

## 实测记录（进行中）

**2026-10-09，首次连接尝试（QoderWork，stdio，命令 + 环境变量注册）**：宿主连接即报
`MCP error -32601: Method not found`。复现（两 era 全序列探测，`/tmp` 探针）：`prompts/list`、
`resources/list`、`resources/templates/list` 在两个 era 都 -32601——这是宿主连接期的标准能力
发现探测。根因在 SDK v2.3.1：「声明能力即接线」只对 tools 生效（构造器
`if (capabilities.tools) setToolRequestHandlers()`），prompts/resources 的 list handler 只随
`registerPrompt`/`registerResource` 挂，而本 server 从不调用二者——声明了能力也没有 handler。
**已修**（`server.ts` 测量 5）：声明 `prompts`/`resources`（`listChanged:false`）+ 显式注册空
handler（`prompts:[]` / `resources:[]` / `resourceTemplates:[]`）——「空」与「坏」必须可区分，
与 #22 测量 4（零工具也声明 `tools:{}`）同一裁决的延伸；回归测试落 `server-startup.spec.ts`
（mcp 249 测试）。**遗留实测未修**：modern era `ping` 在 SDK v2.3.1 答 -32601（era 路由层
miss；string handler 已存在，重注册被 `assertCanSetRequestHandler` 拒），legacy era ping 正常——
记录在案，待有宿主依赖 modern ping 再议。era 判定：待 QoderWork 复连后按上节抓取。

**记录（读路径，2026-10-10）**：问数场景「上个月付费用户的充值情况」——agent 首选
`dws_10000251_com_pay_order_di`，并主动区分孪生表 `dws_10000251_com_pay_order_df`
（日全量快照）——di/df 增量/全量语义答对；给出关联维表 `dim_10000251_com_recharge_info` /
`dim_10000251_com_order_detail_info` / `dim_10000251_server_info`，**JOIN 关联经业务判断
正确**。宿主工具调用面板显示**五个读工具全部被真实调用**（Resolve Alias / Search
Definitions / Get Relations / Get JOIN Path / Get Definitions）——真查语义层，非模型幻觉
作答。读路径零 commit、树干净（读不拿锁，设计行为）。**era**：直连注册未抓取（无 tee），
QoderWork 详情页未见 protocolVersion 显示——记「未测」（`legacy:'serve'` 两 era 均服务，
不阻塞）。**配置形态实测**：env-only 注册（SG_CORPUS/SG_AGENT_ID/SG_SCOPE，argv 零参数）
——#22 双通道设计的决定性输入在真实宿主上成立。

**记录（写路径 + 副作用，2026-10-10）**：三写回全落，agent 自述与 git 对账一致：

| commit | 动词 | Derivation / conf | 内容 |
|---|---|---|---|
| `756c9bb` | update_definition | agent / 0.8 | 补问数口径描述 |
| `198d5be` | enrich_on_write | deterministic / 1 | hook 写回 dimension_refs + alt_labels（两 commit 形状活体） |
| `d9ba1be` | add_relation | agent / 0.7 | **领域判断**：拒绝直连 `dim_com_recharge_info`（_di 表无 recharge_id 列，JOIN 不成立），改加 role_id→`dws_10000251_univ_role_tag_df` |
| `f0badb5` | enrich_on_write | deterministic / 1 | add_relation 同样触发 hook |
| （无 commit） | add_alias | — | 幂等 no-op：别名已被 hook 提前抽入，changed:false 零 commit |

- **stale_baseline 回路活体闭环**：agent 原话「写操作改变了指纹，加关联前重新读一次拿最新 version」——重读重试在真宿主自主发生。
- **身位分离**：四条 commit 全部 author=qoderwork-pilot / committer=semantic-grounding-mcp。
- **X-SG-Client 缺席**：QoderWork 请求信封未带 clientInfo（optional 键）→ trailer 诚实缺席，符合设计（「没人说就是没有」，config.ts 同款语义）。
- agent 一次「无意义循环」后自恢复；中途主动向用户交代副作用与改判理由（关联目标从礼包维表改为角色宽表）——审计 summary 与自述一致。

**⚠️ 发现（tombstone fog 触发条件以广义形式命中）**：on-write hook 的 deterministic
alt-labels 抽取（`enrichment.ts` `discoverAltLabelsDeterministic`：括引片段 + domains）
把长分析型描述撕成「别名」——`_di` 表 alt_labels 从 3 条（氪金/充值/付费）涨到 28 条，
20+ 条垃圾（`ds=20260720`、纯数字、`现金,cnt=384,amt=773500分`、整句结论）。且 **hook 在
每次 update 类写都重触发**、抽取源是描述正文：remove_alias 清掉后，只要描述还在、下一次
写就再抽回——**enrichment 轮与 agent 的写-删循环，alt_labels 变体**（fog 原文是 relation
ref 变体）。规避顺序：先净描述（update 写干净文本，hook 无可抽）再清别名，顺序反了会在
同一次写内即时回填。两个候选修法独立成立：①tombstone（agent 持久否决权，map #12 fog
原文）；②substrate 抽取器质量护栏（长度/数字占比/含分隔符拒收）——收票时一轮问 graduate。

## 观察点（fog 的触发条件挂在这）

- **写-删循环**：agent `remove_relation` 删掉机器推导的 ref 后，下一轮 enrichment 又推
  回来、agent 再删——出现即 tombstone（agent 持久否决权）成票（ADR-0005 Consequences、
  map #12 Not yet specified 仅存项）。
- **摩擦**：工具面是否够用（`get_context` 复合工具的 Followup 触发条件）、搜索召回
  质量（bigram 打分的 Followup 触发条件）、enrichment work 的 prompt 是否好答。
- **宿主兼容**：era、clientInfo 逐请求变化是否出现在 `X-SG-Client`、`legacy:'serve'`
  的回退是否真的被走到。

**记录：**

**记录（清理 + 打地鼠，2026-10-10）**：25 commits（1 描述重写〔无括引干净文本〕+ 24 条
remove_alias）全 audited；23 条碎片清除，4 个业务别名保留。**写-删循环 domain 变体实锤**：
`付费经济` / `用户生命周期` 同时是本表 `domains` 字段值——remove_alias 后 hook 在**同一次锁内**
从 domains 回灌（git 链：`26fdc32` remove(付费经济) → `fd4ad3f` enrich_on_write 回写），
agent 并观察到**指纹回退**（60d47c13… → 4dd62262…：remove 未持久，内容被还原）。裁决：
domain-as-alias **接受**（召回有益，agent 同判：与正文碎片性质不同）；洞 = agent 无持久
否决权 → **issue A（tombstone）**，批量否决语义在该票一并称量（24 条逐删 + 打地鼠的归宿）。

**记录（enrichment 段，2026-10-10）**：单表 `run_enrichment(tables:[_df])` —— **subject
「1 table(s)」 vs trailer 「Files=446」**：tables 维度进了 subject 却没约束住 discovery 的
全维度——**events 未指定 = 全量扫 445 个事件**；客户端超时但 server 侧完成（`3cef160`
落盘），回执丢失。`get_enrichment_work` 回 **579 项 / 25.9MB**（全库 321 表 + 258 事件；
_df 无缺口故不在列：dimension_refs 5 条 deterministic、alt_labels 非空）；listing 侧
tables filter 是否同样失效**待首探**（两版 stdio 探针未保活成功，非结论）。apply_enrichment
**正确地未被调用**：无 work_id，agent 拒绝硬造——工具契约在真宿主成立。全库 sweep 后多表
alt_labels 被污染（_df 18 条含碎片）。→ **issue B（过滤语义 + 响应尺寸）**、**issue C（抽取
器护栏）**。

## 结论

**Destination 达成**（2026-10-10）。三步回路经真宿主（QoderWork，stdio，env-only 注册）全程
走通：问数读路径五工具全调用、di/df 孪生表语义答对、JOIN 经业务判断正确；三写回 + 幂等
no-op + stale_baseline 重读重试**活体闭环**；`git log -p --follow` / trailers 对账 agent 自述
**零出入**（author=agent / committer=server 身位分离全程成立）。四项发现：①写-删循环
（tombstone 触发，domain 变体，指纹回退铁证）②enrichment 维度过滤缺陷（1 表 subject /
446 files）③work listing 无尺寸上限（579 项 / 25.9MB）④抽取器撕碎长描述。①→issue A、
②③→issue B、④→issue C（编号见 #23 resolution）。era 记「未测」（信封无 clientInfo、宿主
详情页无版本显示；`legacy:'serve'` 双 era 服务，不阻塞）；X-SG-Client 因同因诚实缺席。
LLM 半边（get_work→apply）真宿主无对象可演（所选表无缺口），由 CI 门禁 `pnpm e2e` 覆盖。

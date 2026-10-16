# get_definition 读延迟实测定位（#178）

- **Date**: 2026-10-16
- **Ticket**: [#178](https://github.com/McKenzieIT/semantic-grounding/issues/178) research —— SG MCP `get_definition` 实测延迟偏高，需定位瓶颈
- **分支**: `research/get-definition-latency`（一次性探针分支，不进 main，不动生产代码）
- **探针**: `probe/*.ts|mjs|sh`，原始数据 `probe/results/*.json`
- **Relates to**: ADR-0015（读 epoch 缓存键）、ADR-0023（memory 存储形状 + 锚点增量索引）、
  ADR-0024（memory 读面挂载）、ADR-0025（verified queries）、ADR-0026（悬空锚点）、ADR-0027（争议闭包）

---

## 0. 结论先行

1. **票面前提不成立**：在 X63 量级语料上，服务端 `get_definition` **不比** `get_scope` / `list_definitions` 慢。
   同一个活着的 stdio server 上轮转打点（probe F），`get_definition` 反而是这几个工具里最快的一档：
   39.05ms（带 `data_window`）/ 39.42ms vs `get_scope` 41.55ms / `list_definitions` 43.55ms /
   `search_definitions` 49.23ms。五个读工具挤在同一个 30–45ms 带里。
2. **真实瓶颈是 memory 投影层**，但它不是 `get_definition` 独有的病：语料里只要有 **≥1 条 memory**，
   `get_definition(table)` 就从 6.83ms 跳到 30.49ms（**4.5×**），其中 23.21ms 花在 `buildAnchorUniverse`
   对**整个语料的重新全量扫描**上（表读一次还要再解析 110 个事件 + 10 个概念 + 5 个查询 = 125 份 YAML）。
   真正的投影计算只占 ~3.1ms，**~29.6ms / 30.9ms 是纯重复扫描**。
3. **要不要优化：要，但不急**。可省 ~20–30ms/次，对比 agent 一次往返的秒级开销可以忽略；
   但这条路径对语料规模**线性**（171 定义 40.8ms → 774 定义 165.4ms），且修复形状是 ADR-0015 R6/R7
   早就记录在案的 reopen 项（stat 口径跨进程缓存）。建议开一张 **低优先级 enhancement 票**，
   触发条件：语料过 ~500 定义，或批量逐条读（如 #151 那种 171 连读）成为常规动作。
4. **被证伪的若干猜测**（详见 §5）：MCP 传输、git 子进程、sha256 指纹、`data_window` 参数、
   memory 条数——都不是瓶颈，逐条有数。

---

## 1. 测量环境与免责

| 项 | 值 |
| --- | --- |
| 机器 | 用户 Mac（本仓所在机），node v25.9.0、pnpm 10.33.3、git 2.49.0 |
| 构建 | `pnpm install --frozen-lockfile` + `pnpm -r build`，均 exit 0（`probe/setup.sh`） |
| 语料 | **X63（10000354）真实语料不在本机**，用 k11 语料采样到 X63 实测口径：**61 表 + 110 事件 = 171 DW 定义**，外加 10 概念、domains/config，再按变量注入 memory / queries |
| 计时 | `performance.now()`，每点 50 次（probe A/B）/ 30 轮（probe F）取 p50/p90 |
| 口径 | 每次迭代开一个**全新** `withReadEpoch`，等价于一次真实 MCP 工具调用（`packages/mcp/src/server.ts:178` 对每个 handler 做 epoch 包裹） |

**免责**：
- X63 真实语料缺席，所有数字来自**同口径合成语料**（文件数、定义数对齐 X63，字段形状取自 k11 真实定义）。
  绝对值会随磁盘/机器波动，**层间比例**与**趋势**是本文的结论载体。
- 跑间方差存在：probe E（规模曲线）整体比 probe A 高约 25%（机器当时更忙）。
  跨 probe 比较请只看同一个 probe 内部的相对关系。

---

## 2. 代码路径（被测的是什么）

`get_definition(table)` 一次调用做四件事（`packages/mcp/src/tools/read.ts:276` `registerGetDefinition`，
表分支 `read.ts:297-307`）：

| 层 | 入口 | 实现 |
| --- | --- | --- |
| ① corpus I/O + 解析 | `core.loadTableDefinitionWithVersion()` `packages/substrate/src/index.ts:1118` | `loadTables()` 全目录扫描 → `.find()`，走 epoch memo（`io.ts:424` `readThroughEpoch`，仅 `'tables' \| 'events'`） |
| ② 指纹 | 同上（内部 `definitionVersion`，`io.ts:677`） | 解析回源文件 + `readFileSync` + sha256（ADR-0004 ruling 8） |
| ③ memory 投影 | `core.readDefinitionMemories()` `index.ts:1662` → `memory.ts:1418` `readNodeMemoriesView` | 锚点索引 refresh → **`buildAnchorUniverse(root)`** → ADR-0024 分栏预算 / ADR-0026 悬空判定 / ADR-0027 争议闭包 |
| ④ verified_queries | `core.verifiedQueriesFor()` `index.ts:1828` → `query.ts:178` | `loadQueryDefinitions()`（`query.ts:41`）= `loadRawDir(root,'queries')` + zod，再按 `uses` 正扫（ADR-0025，≤5） |

关键结构事实（读码所得，后被计数器证实）：

- `memory.ts:1418-1422`：`index.size() === 0` 时**提前返回** `EMPTY_NODE_VIEW`——这就是"零 memory 语料 6.8ms"的原因；
  一旦有第一条 memory，后面的全量扫描就无条件发生。
- `memory.ts:577` `buildAnchorUniverse` 的注释写得很清楚：
  > "Build the anchor universe for one corpus root — **the write door's existence check** (ADR-0023 R4…).
  > **Full-scan per call, like every other write-path read.**"

  它是为**写门**设计的全扫helper；ADR-0026 把读时悬空判定挂上来之后，这个 per-call 全扫就长在了**读**路径上。
  而 ADR-0024 的标题恰恰是"**搭既有读结果的便车**"——设计意图与实现之间的缺口就在这里。
- `buildAnchorUniverse` 内部依次 `loadConcepts` + `loadTables` + `loadEvents` + `loadRawDir(root,'queries')`。
  其中 `loadConcepts` / `loadRawDir` **按 ADR-0015 的明文裁决不在 epoch memo 内**
  （`io.ts:405-417` 的 "Deliberate boundary" 段，#119 Q3 no-go），`loadEvents` 在 memo 内但**表读时必然 miss**。
- `queries/` 在一次调用里被解析**两遍**：`buildAnchorUniverse` 一遍、`verifiedQueriesForNode` 一遍。

---

## 3. 按层拆耗时（probe A：进程内，`probe/bench-layers.ts` → `probe/results/layers.json`）

`get_definition(table)` p50，单位 ms，`yaml` = 该层触发的 YAML 解析次数（`io-probes.ts` 计数器）：

| 语料变量 | 整体 | ① I/O+解析 | ② 指纹 | ③ memory 投影 | ④ verified_q |
| --- | ---: | ---: | ---: | ---: | ---: |
| mem=0, q=0 | **6.83** | 6.717 (61) | 0.083 (0) | **0.008** (0) | 0.005 (0) |
| mem=12, q=5（X63 接力量级） | **30.49** | 6.629 (61) | 0.085 (0) | **23.211 (125)** | 0.439 (5) |
| mem=100, q=20 | 32.84 | 6.626 (61) | 0.092 (0) | 24.758 (140) | 1.351 (20) |
| mem=500, q=50 | 38.51 | 6.747 (61) | 0.090 (0) | 28.405 (170) | 3.188 (50) |

读法：

- **第 3 层吃掉 76% 的调用耗时**，且它的 125 次额外解析 = 110 事件 + 10 概念 + 5 查询，
  一次都不属于"读一张表"本该做的事。
- **耗时由语料规模驱动，不由 memory 条数驱动**：memory 从 12 → 500（41×），第 3 层只从 23.2 → 28.4ms。
  ADR-0023 R1 的增量锚点索引是有效的——探针计数显示 90 次热调用累计 **1080 次 stat、0 次重解析**。
- 交叉印证"重扫的是另一半语料"：`get_definition(event)` 在 mem=12 时第 3 层只要 8.66ms / 76 次解析
  （= 61 表 + 10 概念 + 5 查询，事件那一半已被 ① 读进 epoch）。表读付事件的账，事件读付表的账。
- 同语料下的对照：`list_definitions` 31.79ms（186 解析）、`get_scope` 30.98ms（186 解析）——
  **它们也在每次调用重扫全语料**，只是重扫一次而不是一次半。

---

## 4. 归因与"修好之后"的量级（probe C：`probe/bench-attribution.ts` → `probe/results/attribution.json`）

把第 3 层拆开，并用"预热 epoch"模拟修复后的形态（mem=12, q=5）：

| 步骤 | p50 (ms) |
| --- | ---: |
| `loadTables`（61 表 YAML） | 6.701 |
| `loadEvents`（110 事件 YAML） | **21.919** |
| `loadConcepts`（10 概念，epoch 外） | 0.651 |
| `loadRawDir('queries')`（5 查询，epoch 外） | 0.374 |
| `buildAnchorUniverse` 冷 epoch（= 现状每次调用） | **30.952** |
| `buildAnchorUniverse` 表/事件已在本 epoch 读过（= 只剩建索引开销） | **3.043** |
| `readDefinitionMemories` 冷（现状） | **30.867** |
| `readDefinitionMemories` 扫描共享后（修好后的量级） | **3.139** |
| `verifiedQueriesFor`（`queries/` 的第二遍解析） | 0.385 |
| 纯指纹地板（resolve + read + sha256） | 0.046 |

**结论**：30.9ms 里 ~29.6ms 是重复扫描，~3.1ms 才是 ADR-0024/0026/0027 的真实投影成本。

stat 地板（probe D，`probe/results/statfloor.json`）：186 个文件 `readdir + stat` p50 **1.111ms**（min 0.886），
相对 ~29ms 的全量解析便宜 **~25×**——即"用 stat 校验、命中就不重解析"的缓存形状在本量级上**成本可忽略**。

---

## 5. 非问题（证伪记录）

| 猜测 | 实测 | 判定 |
| --- | --- | --- |
| MCP stdio 传输慢 | stdio ≈ 进程内：31.10 vs 30.49ms（mem=12）；零 memory 7.31 vs 6.83ms | ✗ 传输 ≲1ms |
| 响应体大 | `get_definition` 2370 B（k11 最大表 3708 B）；`list_definitions` **123 240 B** 也只贵 ~1ms | ✗ |
| 读路径起 git 子进程 | `packages/substrate/src` 与 `read.ts`/`scope.ts` 全无 `execFile`/`spawn`；stdio 与进程内持平也佐证无子进程 | ✗ |
| 指纹 sha256 贵 | 0.083–0.092ms（表）/ 0.30ms（事件，文件大） | ✗ |
| `data_window` 参数贵 | 30.26 vs 30.49ms（probe A）；probe F 39.05 vs 39.42ms——**带窗口甚至更快**，在噪声内 | ✗ |
| memory 条数多导致慢 | 12 → 500 条，第 3 层 23.2 → 28.4ms；增量索引 0 次重解析 | ✗（ADR-0023 R1 有效） |
| 冷启动是主因 | server `startup → initialized` 253ms（热）/ 655ms（冷）；首调 15–67ms | △ 若宿主频繁重启子进程，这是**唯一**能看到数百毫秒的地方，但与单次工具调用无关 |

### 5.1 票面比较前提的公平复测（probe F：`probe/bench-roundrobin.mjs` → `probe/results/roundrobin.json`）

同一个活着的 stdio server、同一份语料（61 表 / 110 事件 / 12 memory / 5 查询）、30 轮**交替**打点，
消除"谁先跑谁占便宜"的顺序偏差：

| 调用 | p50 | p90 | min | max | resp |
| --- | ---: | ---: | ---: | ---: | ---: |
| `get_definition(table, +data_window)` | **39.05** | 45.06 | 34.20 | 45.65 | 2 370 B |
| `get_definition(table)` | **39.42** | 44.33 | 34.19 | 70.87 | 2 370 B |
| `get_scope` | 41.55 | 61.80 | 34.76 | 131.28 | 373 B |
| `list_definitions` | 43.55 | 50.12 | 38.02 | 56.12 | 123 233 B |
| `search_definitions` | 49.23 | 78.47 | 43.20 | 104.09 | 3 887 B |

**`get_definition` 没有比对照工具慢，反而最快。** 那么接力中"慢"的体感从哪来？诚实的候选解释：

1. **连读放大**：逐条读 171 个定义 = 171 × ~40ms ≈ 7s 的纯服务端时间，外加每次一个模型往返——
   体感归因到"这个工具慢"，实际是调用次数。
2. **宿主重启 MCP 子进程**：每次重启 253–655ms（§5 冷启动行）。
3. **宿主/LLM 侧处理**：`get_definition` 返回的是需要被模型通读的定义正文，
   而 `get_scope` 返回 373 B。服务端耗时相近，端到端体感不同。
4. **对照系被 `resolve_alias` 锚定**：它 p50 **0.08ms**（不读语料，唯一真正"瞬时"的读工具）。
   跟它比，任何读语料的工具都"慢"。

---

## 6. 规模曲线（probe E：`probe/bench-scaling.ts` → `probe/results/scaling.json`）

| 规模 | 定义数 | `get_definition(table)` 有 memory | 无 memory | `list_definitions` |
| --- | ---: | ---: | ---: | ---: |
| X63 实测（61 表 + 110 事件） | 171 | 40.80 | 8.94 | 39.39 |
| 2×（122 表 + 220 事件） | 342 | 72.85 | 21.88 | 77.44 |
| k11 全量（321 表 + 453 事件） | 774 | 165.40 | 54.73 | 166.11 |

线性（略超线性）。注意本 probe 整体比 probe A 高约 25%（机器更忙），趋势可信、绝对值勿跨 probe 比。

---

## 7. 要不要优化、优化到什么程度

| 方案 | 改动面 | 实测可省 | ROI 判断 |
| --- | --- | --- | --- |
| **A. 读路径语料缓存（stat 口径跨调用失效）** —— 对 `loadTables`/`loadEvents`/`loadConcepts`/`loadRawDir` 做进程常驻缓存，用 ADR-0023 R1 已经在用的 stat-per-file 形状校验 | substrate `io.ts`（+ ADR-0015 addendum） | memory 层 30.9 → ~3.1ms；`get_definition` ~31 → **~10ms**；`get_scope`/`list_definitions`/`search` 同步受益（它们也是每调用全扫） | **最高**。stat 地板 1.1ms vs 解析 29ms（25×）。且 ADR-0015 R6/R7 明文把 "mtime validation / cross-process caching" 留作未动项（`io.ts:416-417`），这是**既有记录的 reopen 路径**，不是新发明 |
| **B. 按锚点裁剪 universe** —— 读路径只需校验"索引里真实存在的那些锚点"是否 live，不需要整库 columns；可做成 O(锚点) 而非 O(语料) | substrate `memory.ts` | 表读免掉 110 个事件解析（21.9ms）中的绝大部分 | 中。与 A 部分重叠；若做了 A，B 的边际收益小。注意正确性坑：边锚点可能从 event 指向 table，裁剪必须按索引里出现的锚点反查，不能按"本 kind"裁 |
| **C. 一次调用内 `queries/` 只解析一次** | substrate（把 queries 纳入 epoch memo） | 0.37–3.19ms（随 queries 数） | 低但近乎零成本，可搭 A 的车 |
| **D. 不做** | —— | —— | 当前 171 定义下，省下的 20–30ms 对 agent 秒级往返不可见 |

**裁决**：**开票，低优先级，不插队。** 理由：

- 今天不疼（#178 的"慢"在服务端不复现，§5.1）；
- 但方向正确且 ROI 清楚（A 一处改动让**全部五个读工具**各省 20–30ms，并且随语料线性放大）；
- 触发升优先级的条件写进票里：**单 scope 语料过 ~500 定义**，或**批量逐条读成为常规动作**
  （#151 那种一次 171 连读 = ~7s 纯服务端时间），或 **memory 条数过 ~1000 导致第 3 层基线抬高**。

### 建议的后续票（描述，**本票不创建**）

> **类型**：enhancement / optimization（substrate），优先级低
> **标题**：读路径语料缓存 —— 以 stat 口径跨调用复用 `loadTables`/`loadEvents`/`loadConcepts`/`loadRawDir`
> **动机**：#178 实测，X63 量级下每次读工具调用都全量重解析语料；`get_definition(table)` 30.9ms 里
> ~29.6ms 是重复扫描，真实投影仅 ~3.1ms。
> **范围**：`packages/substrate/src/io.ts` 的四个 loader 家族；缓存键 = 语料目录 + 全量 stat 指纹
> （size+mtime，形状照抄 ADR-0023 R1 的锚点索引）；**不得**只用进程内 `corpusVersion`——
> 那会丢掉 ADR-0015 R3 关心的跨进程正确性（别的进程改了文件，本进程计数器不动）。
> 顺带把 `queries/` 的双重解析合一。
> **验收**：`get_definition(table)` @171 定义 ≤12ms（现 ~31ms）；`get_scope` / `list_definitions` 同步下降；
> 跨进程写入后下一次读必须看到新内容（新增回归用例）；需 ADR-0015 addendum 记录 R6/R7 的落地。
> **不做**：不碰 ADR-0024/0026/0027 的投影语义；不改任何读工具的响应形状。

---

## 8. 复现

```bash
git worktree add ../sg-research-178 research/get-definition-latency
cd ../sg-research-178
bash probe/setup.sh                                   # install + build
node probe/bench-layers.ts      > probe/results/layers.json       # A 按层
node probe/bench-stdio.mjs      > probe/results/stdio.json        # B stdio 全链路
node probe/bench-attribution.ts > probe/results/attribution.json  # C 归因 + 修复模拟
node probe/bench-statfloor.mjs  > probe/results/statfloor.json    # D stat 地板
node probe/bench-scaling.ts     > probe/results/scaling.json      # E 规模曲线
node probe/bench-roundrobin.mjs > probe/results/roundrobin.json   # F 公平 A/B
```

`probe/corpus.mjs` 负责按 k11 采样生成 X63 量级语料（可调 memory / queries 条数）。
探针为一次性产物，仅存在于本分支，不进 main。

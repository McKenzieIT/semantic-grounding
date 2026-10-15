# ADR-0027: 相反 memory 的最低行为 —— agent 判断、`contradicts` 声明、成对不拆、凭证据裁决、争议挡复现晋升

- **Status**: accepted
- **Date**: 2026-10-15
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0021（R5 自晋升无审批人、R6 replicated 证据 —— 本 ADR R6 收窄后者）、ADR-0023（R2 只追加 /
  outdated·wrong、R7 `basis`、R9 回执附邻居 —— R2/R5 的形状与载体来源）、ADR-0024（R3 可见性、R4 预算、R5 每条输出
  `anchor`、R6 计数一致、R7 `_guidance` 不挂读工具 —— R4 在其上加伙伴随行）、ADR-0026（R6 supersede 不校验锚点 ——
  R3 不校验锚点重叠的先例）、ADR-0018 R1（无在线第二方 —— R5）、#126（服务端 LLM 判语义不借鉴 —— R1）、map
  [#125](https://github.com/McKenzieIT/semantic-grounding/issues/125)、决策票
  [#158](https://github.com/McKenzieIT/semantic-grounding/issues/158)（六轮 grilling，canonical 裁决来源）

## Context

同一锚点上两条仍有效的 memory 结论相反、谁也没 supersede 谁：会话 1 记 observation「`dws_pay` join `dim_channel`
在 server_id=0 放大 3 倍」（测量窗 0901–0930），会话 2 记「无放大」（0915–1015）；或两条 practice「大R = r_level
07–09」与「08–09」。ADR-0024 R4 的预算（`memories` 8、observation 排末位）可能只放进一边，B 静默采信。

- memory 正文是自由文本；服务端**没有独立 agent / LLM**。确定性识别「相反」只有关键词规则一条路，「放大 / 无放大」
  只差一个否定词、「07–09 / 08–09」连否定词都没有 —— 不可行。
- `record_memory` 尚未落地（#152 open、仓内零 `record_memory`）；ADR-0023 R9 已定回执附同锚点同类型邻居。
- 今天能把指引送到 agent 面前的渠道：工具描述（每个宿主 `tools/list` 必载）· 写回执（判断时刻）· MCP
  `instructions`（`server.ts` 未用，宿主是否注入未实测）· prompts / 规程读工具（须主动调，#126/#129 证 agent 不会）·
  SKILL.md（须宿主侧安装，零上下文 B 换宿主即无）。

## Decision

| # | 维度 | 裁决 | 关闭的取舍 |
|---|---|---|---|
| R1 | 谁判断「相反」 | **接入的 agent 判断，服务端永不从正文推断**；服务端只认显式声明。SG 的职责是**教 agent 判断与更新**：判断规程是 SG 交付物的一部分 | 服务端 LLM 判断（#126 不借鉴、服务端无 LLM）；关键词规则（误判即错标争议）；结构化结论字段确定性比对（只覆盖 observation，等于重开 ADR-0023 R7） |
| R2 | 规程载体 | 规程**单一来源**，按判断时刻渲染：① `record_memory` 工具描述放判断树主干；② 回执 `neighbors` 每个邻居附逐例指引（「与 mem-… 同锚点同类型：结论相同即复现证据，正常写；更新用 outdated；旧条目错用 wrong；相反说不清用 contradicts」）；③ `get_definition` 工具描述一句读时指引（R4）。MCP `instructions` 简版视 QoderWork / Claude Code 是否注入的实测再定（#152 实测）。**不开规程读工具 / prompt、不依赖装 skill** | 规程读工具或 prompt（agent 不主动调，工具面 +1）；只发 SKILL.md（B 未装即零）；`_guidance` 挂读工具（破 ADR-0024 R7） |
| R3 | 声明形状 | 新条目可选字段 **`contradicts: [mem-id…]`**，与 `supersedes` 并列、语义分离：supersedes =「我取代它、它退场」，contradicts =「我与它相反、两条仍有效、未裁决」。声明只能写在**带实质结论的新条目**上（只追加），读时索引双向现算。确定性校验：被引 id 存在、非 wrong、非自身、同一 id 不同时出现在 supersedes 与 contradicts。**不校验锚点重叠、允许跨类型**。规程判断树：observation 测量窗**不重叠 → 不算相反**（数据变了，两条都成立）；结论相同 → 复现证据、不加声明；有证据证明旧条目错 → `supersedes: wrong`；相反且说不清谁对 → `contradicts`，正文写明差异点（窗 / 口径 / 过滤），并**列上回执邻居中全部同结论条目**（R6 守卫靠它） | 复用 supersedes 加 `reason: disputed`（混淆取代与并存，读面 / 守卫 / 预算都按 reason 分叉）；独立「声明」条目（无实质结论的 memory） |
| R4 | 读面呈现 | 每条有争议的可见条目带 **`contested_with: [mem-id…]`**（双向现算；伙伴被 wrong 或被 outdated 隐藏即解除）。可见性照 ADR-0024 R3（伙伴在 `data_window` 外不拉）。**预算对伙伴让路**：一方进预算，伙伴强制随行、可超 8 / 5 / 3 上限，超额只能是伙伴；伙伴紧随排名高者。**跨锚点也拉进来**（今天无按 id 取 memory 的工具），各自带 `anchor`。`memory_counts` 计入随行伙伴（ADR-0024 R6）。`get_definition` 工具描述写明：「带 `contested_with` 的是未裁决分歧，不要只采信一方；向用户并列呈现差异点，或按 `record_memory` 规程裁决」 | 争议条目全免预算（无上界）；只标记不改预算（看得到 `contested_with` 找不到对方） |
| R5 | 裁决 | **agent 凭证据自裁，无审批人**，用户是证据来源之一不是关卡。写法 = 新条目 `supersedes: [{id: 输方, reason: wrong}]`。证据：确定性来源（DDL / 文档 / 代码）· 用户明说 · 覆盖重叠窗口且说清对方错在哪的新测量；不算证据：多数票、本会话推断、「较新的那条」。**唯一守卫**：以 wrong 取代一条有争议条目时 `basis` 必填，否则拒写（服务端不判证据真假，只保证有据可查；非争议 wrong 不受影响）。读到**未声明**的矛盾：并列呈现给用户、不只采信一方；自己有测量或证据才按 R3 判断树写新条目。无人裁决即持续成对展示，不设超时 | 只有用户能裁（单人 + 多 agent 现状下争议永远堆积，重开 ADR-0018 R1）；不裁只呈现（读面越来越吵） |
| R6 | 与晋升守卫 | **③ replicated 晋升引用的任一 memory 带仍有效 `contested_with` → 拒写**，指明哪一对、提示先按 R5 消解。只查被引条目、不扫全锚点。**① source / ② user-stated 照常直升**（本身即决定性证据）；规程要求晋升后以同一证据把输方 supersede 为 wrong（晋升与写 memory 分属两工具，不强制跨工具事务）。被引但未被点名的同结论条目靠 R3「列上全部同结论邻居」补位。裁决后赢方连同同结论条目照常可凑 ③ | 不挡（两票对一票即晋升，伪确认重演 k11 114 张）；锚点上任何争议挡所有晋升（误伤无关结论、① 硬证据被拖住） |

## Consequences

- 写面（#152）：`contradicts` 字段与四条校验；争议 wrong 的 `basis` 守卫；规程模块 + 工具描述 + 回执逐例指引；实测宿主
  是否注入 `instructions`。
- 读面（#154）：`contested_with` 双向索引（复用 ADR-0023 R1 常驻锚点索引）、伙伴随行与跨锚点拉取、`memory_counts`
  计入伙伴、`get_definition` 描述。
- 晋升守卫（#136）：R6 拒写分支。
- 口径层面的冲突呈现（第二条大R 查询与第一条划档打架等）仍归分析图（map #125 Out of scope）。
- **Followup**：同一规程来源导出 SKILL.md，归「SG agent skills 系列」专属 map（map #125 Out of scope 种子）。

## 被否掉的路（记录免重探）

- **「服务端可确定性识别相反」**：自由文本正文下不成立（见 Context）；不再探。

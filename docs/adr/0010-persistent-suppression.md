# ADR-0010: 持久否决权（suppression）—— 隐式表达、per-asset 存储、零新工具面

- **Status**: accepted
- **Date**: 2026-10-10
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0005 Consequences 的「tombstone / 负知识，v1 不做」段落（本 ADR 是其
  触发条件成票后的落地，见该票 "Update 2026-10-10 — #38" 节）、
  [ADR-0009](./0009-extractor-guardrail.md)（护栏杀伤后存活的候选规模是本票要扛的实测剩余量）、
  [map #32](https://github.com/McKenzieIT/semantic-grounding/issues/32)、
  裁决票 [#36](https://github.com/McKenzieIT/semantic-grounding/issues/36)（存储形状与边界）、
  裁决票 [#37](https://github.com/McKenzieIT/semantic-grounding/issues/37)（作用域、批量与工具面）、
  执行票 [#38](https://github.com/McKenzieIT/semantic-grounding/issues/38)

## Context

ADR-0005 裁决时已经预见这个问题，但判断「v1 不做」：`remove_relation` 删掉一条机器轮
（deterministic/llm）出身的 ref 不持久，下一轮 enrichment 会把它重新推导回来（deterministic
的分支是必然重加）。该票把触发条件写死在 Consequences 里——「dogfood 中出现 agent 与
enrichment 轮的写-删循环时成票」。map #32 的 dogfood 实测了这个条件：一张表上 agent 连续
24 次删除同一个机器派生的 ref，每次都被下一轮 enrichment 重新加回，没有任何回执告诉 agent
「这是徒劳的」。

[#36](https://github.com/McKenzieIT/semantic-grounding/issues/36) 先裁了存储形状、命名与跟
`origin`/curated 的边界三件事；[#37](https://github.com/McKenzieIT/semantic-grounding/issues/37)
在 #36 的裁决之上，用一份作用域实测数据（577 个否决候选词里 81.2% 只出现在单一定义上；
按出现量排序的前 20 个跨定义词全部是受控词表枚举或正文模板复读，不是需要正则表达的「模式」）
再裁了表达面、批量语义、作用域边界与工具面六件事。两票合起来回答「要不要做」之外的全部
「怎么做」。

## Decision

| # | 维度 | 裁决 | 关闭的取舍 |
|---|---|---|---|
| 1 | 存储落点 | **per-asset YAML 字段，key-only，无条目级 provenance**：别名侧 `suppressed_alt_labels: string[]`（表与事件同形），关系侧表用 `suppressed_dimension_refs`、事件用 `suppressed_external_refs`（key = `dim_table` 字符串，与 `mergeRefs` 自己的去重键同形）。否决记录本身不答「谁、何时、为何否决」——这些问题由该次写入的 git commit 回答，与其他一切 Tier-2 写同构（ADR-0005 裁决 9 的 provenance-in-commit 哲学）。叠加一张 corpus 级词表（见第 4 行）。 | 注入 seam（把真正的否决集推给调用方决定存不存——只是把问题挪了位置，没有解决「真身存在哪」）；从 git 历史派生否决集（与 substrate 零 git 依赖的定位冲突；历史改写会静默改写否决集；「删过一次」和「永不再见」在语义上并不等价） |
| 2 | 定名与范畴边界 | 新构件命名 **suppression（持久否决）**，不塞进 `origin` 枚举：`origin` 是**排序**机制（谁的写入优先合并），suppression 是**闸门**机制（候选压根不许进入候选集），范畴不同、机制不该合并（SARIF v2.1.0 §3.35 把 `suppressions` 和 `provenance` 分成同一结果上的两个独立字段，与 ADR-0005 让 YAML `origin` 和 `X-SG-Derivation` 刻意不对齐同构）。GLOSSARY 新增 Core domain 词条 `suppression`；`provenance` 词条尾部追加一句指向它。 | 命名 `tombstone`——数据目录语境下这个词已经有具体技术含义（后写覆盖、按时间遗忘、存在目的是向下游传播删除），与本仓需要的「时间无关的标准策略」语义冲突 |
| 3 | 诞生与生命周期——表达面 | **隐式**：删除一条机器可再生的内容本身就是否决的诞生动作，不需要显式「否决」动词或参数。别名侧裸 `string[]` 没有 origin 可分流，恒记否决。关系侧按被删 ref 的 `origin` 分流：machine-derived（deterministic/llm）或缺省 ⇒ 一次锁内写同时记「删除内容」与「否决键」（一个 commit）；curated-origin（manual/undefined——人手改的和 agent 调 `add_relation` 加的都算，照 ADR-0005 裁决 9「一视同仁地当 curated」的先例）⇒ 纯内容纠偏，不记否决。「起落两步」由此而生：curated-但-deterministic-可重新推导的 ref 第一次删除后，会被同一调用的 on-write hook 立刻以 deterministic 身份加回；第二次删除才真正落否决——这个过程通过回执可见（见第 5 行）。撤销镜像诞生：`add_*` 重新加回同一个词/关系就是撤销，不是另一个动词（见第 6 行）。 | 显式否决机制（`permanent: true` 参数或独立的 `reject_alias` 工具）——这类设计把「行为正确」押注在「agent 读过工具描述并记得多传一个参数」上，而 dogfood 已经证明 agent 连续 24 次失败删除都没有察觉异常，没有指纹回退信号可依赖；把既有（但错误）的行为直接改成正确行为是严格更优的路径 |
| 4 | 作用域 | **per-asset 为主**（577 个候选否决词里 81.2% 只出现在一个定义上，agent 在对话中就能观察到的范围覆盖绝大多数情形），叠加一张**语料根级 `suppressions.yaml`**——具名词表（`alt_labels: string[]`，key = `normalizeLabel` 归一化形式），**不是正则/模式表**：实测前 20 个跨定义高频词全部是受控词表枚举或正文模板复读，零个真正需要模式表达的用例。过滤器在读侧消费 per-asset 集合与词表的**并集**；词表的写路径是**手改**（curated，git 自证），不开新 Tier-2 动词——全库范围的判断需要全库视角，这正是运营者做全库 diff 探针时才有，对话中的 agent 不具备。 | 把否决设计成能扛任意数量垃圾串的通用机制或支持正则模式（实测零需求，会制造一个没人用的配置面——与 ADR-0009 裁决 3 的「没有受益方不设配置面」同一逻辑） |
| 5 | 回执与批量 | `remove_alias`/`remove_relation` 的 `labels`/`relations` 参数改**数组**（破坏性改形，旧单字符串调用方会收到 zod 校验错误），同目标多项在**一次**锁内读-改-写完成，响应 `results: [{key, outcome, suppressed, reasserted}]`（`outcome ∈ removed │ absent │ idempotent`，`key` 是存储形的键——归一化别名或 `dim_table` 名）。`suppressed` 答「这次调用是否记录了这个键的否决」；`reasserted`（锁内即时重读判定，零竞态）答「同一次写的 on-write hook 是否立刻把它加回来」——因为 dogfood 已经证明 agent 不会重读工具描述，回执是唯一可靠的教学回路。连带裁决（ensure-absent）：删除一个**已经不存在**的词/关系仍然记否决——语义是「这个候选永不该属于这里」，不取决于当下是否存在；真正的幂等空操作要求「已不存在 **且** 已被否决」。`add_alias`/`add_relation` 响应新增可选字段 `unsuppressed: string[]`，列出本次调用解除的否决键。同目标批量用双字段 overlay 天然压成一次 commit，**不需要 `beginBatch`**（beginBatch 只在跨目标多笔独立写时才有意义，本票原计划的假设被结构性取代）；跨目标批量清理不开新工具（dogfood 的痛点是一张表上 24 次提交，不是多张表；一次定义一个 commit 是诚实的审计粒度，跨定义批量清理列为 Followup）。stale baseline 使整批调用失败，不是逐项失败（单目标单锁单基线，与 `apply_enrichment` 跨目标逐项判 stale 结构不同）。 | 显式 opt-in 否决标记（见第 3 行，同一否决）；跨目标批量清理工具（没有实测痛点撑它，留 Followup）；逐项各自判定 staleness（本票是单目标单锁，不是 `apply_enrichment` 式的跨目标聚合） |
| 6 | 工具面 | **19 个工具不变，零新动词**——否决的诞生、解除、批量、全库范围四件事全部挂在既有动词上。`update_definition` 的字段拒绝列表新增 3 个 `suppressed_*` 键，重定向到 `add_*`/`remove_*`（错误码 `-31020 unsupported_update_field`，ADR-0005 裁决 4 的重定向先例）：否决键永远由动词产生，不接受手写覆盖。读侧零改动——`get_definition` 自然带出新字段；检索（corpus.ts 的 BM25 折叠）**不**投影被否决的词，这一点已在 #36 裁定，本票钉成回归测试。`pnpm e2e` 的工具计数断言不受影响。 | 新增独立否决/解除动词；给 `get_definition`/搜索链路开否决专属读接口（既有读路径已经覆盖，不需要新表面） |
| 7 | events 覆盖 | **day one 覆盖**，表与事件同一裁决、同时落地，三条独立理由同时成立：线上污染事故 `3cef160` 污染的 446 条定义里 445 条是事件——不盖事件，清理会自败；成本≈0（字段与路径形状镜像表，无额外设计）；真正的不对称（关系否决的批次时机）是 #37 的裁决范畴，不是「是否覆盖事件」这个问题本身。 | 先做表、事件列 Followup（成本不对称到几乎不存在，没有理由分期） |
| 8 | 边界 | 否决**只约束机器轮**（deterministic + llm），不约束人：运营者手改 YAML 把一个被否决的词重新加回去是 curated 行为（git 自证，照 ADR-0005 一贯哲学），不是对否决机制的违反。多写者场景下的权限与告警列为 Followup——v1 单写者模型下没有触发条件（镜像 ADR-0005 裁决 7 的既有先例）。 | 对「人手改回被否决词」施加额外校验或告警（v1 单写者模型下无受益方，且会把「闸门」语义错误地延伸到人类编辑） |

**被否掉的路**（记录免重探，不与上表重复）：

- **注入 seam**（第 1 行）——只是把「否决集真身存在哪」的问题挪了位置，没有回答它。
- **从 git 历史派生否决集**（第 1 行）——与 substrate 零 git 依赖的定位冲突；历史改写会静默
  改写语义；「删过一次」不等于「判定为永不再见」。
- **塞进 `origin` 枚举 / 命名 `tombstone`**（第 2 行）——范畴不同的机制不该合并存储；
  `tombstone` 在数据目录语境下已有冲突的具体含义。
- **显式否决标记（`permanent: true` / 独立 `reject_alias` 工具）**（第 3 行）——押注在
  agent 会读工具描述并记得多传参数，dogfood 已反证。
- **跨目标批量清理工具 / `beginBatch` 式跨写聚合**（第 5 行）——没有实测痛点撑它；同目标
  场景被双字段 overlay 结构性取代，不是没做而是不需要。
- **把语料级词表设计成支持正则模式**（第 4 行）——零实测用例需要模式表达。
- **对人类编辑否决集施加额外校验/告警**（第 8 行）——v1 单写者模型下无触发条件。

## Consequences

- `remove_alias`/`remove_relation` 的参数形状从单字符串变成数组——这是一次**破坏性改形**，
  任何旧的单字符串调用方（包括本仓 `packages/mcp/tests/intent-tools-items.spec.ts` 与
  `packages/mcp/scripts/check-e2e-loop.ts` 里的既有调用）都已在本票内同步更新。
- 之前「删除会被下一轮 enrichment 重新加回」的行为（ADR-0005 原裁决下的已知限制）现在被
  否决机制堵住：护栏（ADR-0009）杀伤后存活的 711 个去重候选词是本机制的实测剩余量，不是
  未知上限。
- `get_definition` 返回体新增 `suppressed_alt_labels`/`suppressed_dimension_refs`/
  `suppressed_external_refs` 三个字段（表/事件各两个），检索路径不投影这些词——曾经的
  「删了又回来」失败面现在有确定性回答：「删了，而且不会再回来」。
- 「起落两步」是本机制的已知形状，不是缺陷：curated-但-deterministic-可重新推导的 ref 第一次
  删除会被同一调用的 on-write hook 立刻加回，第二次删除才真正生效——回执里的 `reasserted`
  字段让这一步可见，agent（或人）不需要靠猜测或反复试探来发现这个行为。
- 语料级 `suppressions.yaml` 的写路径是纯手改——没有 Tier-2 审计记录（它不是条目级知识写入，
  是运营者对受控词表的直接编辑，性质更接近 `domains.yaml`）；这个决定本身被 #37 的作用域数据
  支撑，但如果未来真的出现一个对话中的 agent 需要全库视角的场景，这里需要重新评估。
- dsh 不受影响：否决机制完全在 substrate（schema 字段 + 过滤函数）与 mcp（工具参数/响应
  形状）两包内部，不改变外部契约之外的任何东西。

## Verification

- 单测（`packages/substrate/tests/suppression.spec.ts`）：
  - `suppressed_* schema 字段`——表/事件各两个字段的 zod 默认值与类型。
  - `loadSuppressions（lenient 读照 domains.yaml）`——缺省/畸形文件读成空集，不抛错。
  - `别名轮 merge 前过否决集`——`aliasVetoSet` 对确定性与 LLM 两条产出路径同样生效。
  - `关系轮 discovered 出口过否决集`——`relationVetoSet` 在 `mergeRefs` 之前拦截。
  - `apply_enrichment 的答案同过否决集`——agent 批准的 work item 答案如果落在否决集里同样
    被拦。
  - `被否决的词检索不到（投影防回归钉）`——钉死 #36 的检索不投影裁决。
- 单测（`packages/mcp/tests/intent-tools-items.spec.ts`）：覆盖 `remove_alias`/`remove_relation`
  的数组化参数、逐项 `outcome`/`suppressed`/`reasserted` 判定、「起落两步」场景（curated-可
  重新推导 ref 的两次删除）、`add_*` 的 `unsuppressed` 回执、events 覆盖、`update_definition`
  对三个 `suppressed_*` 键的 `-31020` 重定向。
- e2e（`packages/mcp/scripts/check-e2e-loop.ts` Steps 12/13）：`dim_pay` 的
  删除→否决→重新加回→解除否决全序列；`dim_channel` 的「起落两步」+ 全量扫描后仍保持否决的
  序列——跑在真实 corpus 锁与真实 enrichment 轮之上，不是单测的 mock 层。
- 回归依据：#37 的作用域实测数据（577 词/81.2% 单定义独占；按出现量排序前 20 的跨定义词
  全部是枚举非模式）是第 4 行裁决的可审计出处。

## References

- 裁决票全记录：[#36](https://github.com/McKenzieIT/semantic-grounding/issues/36)（存储形状、
  命名、与 origin/curated 的边界、events 覆盖）、
  [#37](https://github.com/McKenzieIT/semantic-grounding/issues/37)（表达面、回执、批量、
  作用域、撤销、工具面）
- 落地执行票：[#38](https://github.com/McKenzieIT/semantic-grounding/issues/38)
- 行为依据：`packages/substrate/src/types.ts:222-223`（事件 schema `suppressed_alt_labels`/
  `suppressed_external_refs`）、`:296-297`（表 schema `suppressed_alt_labels`/
  `suppressed_dimension_refs`）、`packages/substrate/src/enrichment.ts:909`（`aliasVetoSet`）、
  `:918`（`relationVetoSet`）、`packages/substrate/src/io.ts:266`（`loadSuppressions`，读
  `suppressions.yaml`）、`packages/mcp/src/tools/items.ts:111`（`suppressionFieldName`，三个
  否决字段名与 kind/content 的映射）、`:293`（`remove_alias` 注册，描述文本含 ensure-absent
  与回执语义）、`:421`（`remove_relation` 注册）、`packages/mcp/src/tools/shared.ts:177-188`
  （`TABLE_ARRAY_REF_REDIRECT`/`EVENT_ARRAY_REF_REDIRECT` 的 `suppressed_*` 重定向项）、
  `packages/mcp/src/errors.ts:159`（`unsupported_update_field: -31020`）
- 前置历史依据：ADR-0005 Consequences 原始段落（`remove_relation` 不持久、触发条件写死
  「dogfood 中出现写-删循环时成票」）、ADR-0005 裁决 9（curated 与 provenance-in-commit 哲学，
  本票的「起落两步」curated 分流直接继承）
- 外部先例：SARIF v2.1.0 §3.35（`suppressions` 与 `provenance` 分离存储于同一 result）
- GLOSSARY：新增 Core domain 词条 `suppression`；`provenance` 词条尾部追加指向它的一句

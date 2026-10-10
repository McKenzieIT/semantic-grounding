# ADR-0007: dimension filter 语义 —— call-wide 约束、空数组收死、未知名门口拒绝

- **Status**: accepted
- **Date**: 2026-10-10
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0006（本票收紧的四个 Core 方法——`discoverRelations` / `discoverEventRelations`
  / `discoverAltLabels` / `listEnrichmentWork`——皆由 0006 新增）、[map #27](https://github.com/McKenzieIT/semantic-grounding/issues/27)、
  裁决票 [#28](https://github.com/McKenzieIT/semantic-grounding/issues/28)、
  [#25](https://github.com/McKenzieIT/semantic-grounding/issues/25)（本票回应的 dogfood 事故）、
  [#31](https://github.com/McKenzieIT/semantic-grounding/issues/31)（执行票）

## Context

[#25](https://github.com/McKenzieIT/semantic-grounding/issues/25) dogfood 事故：
`run_enrichment(tables:["dws_10000251_com_pay_order_df"])` 的 commit subject 是「1 table(s)」——
声明口径——trailer 却是 `Files=446`——执行口径。两个口径不一致：`tables` 维度确实约束了，但
`events`（未指定）被 discovery 按「全量」扫了 445 个事件。后果：真宿主客户端超时（回执丢失，
server 侧实际完成，commit 已落 `3cef160`）；446 个定义的 `alt_labels` 在一次「单表」调用里被全库
污染。

[#28](https://github.com/McKenzieIT/semantic-grounding/issues/28) grilling 核验的代码事实：
`run_enrichment` handler 把 scope 拆给三个 discovery 各吃各的维度——`discoverRelations` 只吃
`tables`、`discoverEventRelations` 只吃 `events`、`discoverAltLabels` 都吃；substrate 五处原语
同型 `length > 0` 判读（未指定=全量）；`[]`（空数组）现与「未指定」同义（也=全量）；未知表名/
事件名静默 no-op（filter 匹配不到，循环体不进——`get_enrichment_work(tables:["dws_py"])` 回空
列表，agent 误报「无缺口」）；commit subject 报的是**传入的 filter**，不是**实际扫描的范围**
（`describeRunEnrichmentScope` 只回声参数）。附加发现：tables-only 调用把全库事件扫了**两遍**——
`discoverEventRelations`（无 events filter）一遍 + `discoverAltLabels` 的 events 腿
（`events: undefined`）又一遍。

## Decision

| # | 维度 | 裁决 | 关闭的取舍 |
|---|---|---|---|
| 1 | 根语义（call-wide） | 指定任一维度即约束**整个调用**；未指定维度=**不扫**；两者都不指定=全量（`{}` 保持 ADR-0006「先跑全量回填」的指引语义）。`get_enrichment_work` 同一裁决。 | 「onboard dim_shop 后想刷全库事件配对」走 `{}`——本就是 ADR-0006 指引的第一步，不需要「未指定=全量」兜底 |
| 2 | 空数组 | zod `min(1)` 收死，门口 coded error。`scopeFilterSchema` 两工具共享，一处改动双收口。表达「不扫」的唯一正途=省略键。 | `[]` 在 substrate 一层之下曾经=「无过滤」=全量；与裁决 1 的「省略=不扫」语义相撞，必须二选一 |
| 3 | 未知名 | 门口 coded error、提前失败——discovery 启动前校验，零写入零 commit；错误**列全未知名**（不列全库名，防响应爆尺寸）。 | 静默 no-op（现状）：`get_enrichment_work(tables:["dws_py"])` 误报「无缺口」的假阴性整类；名字过滤是闭集枚举，未知成员按定义是调用方 bug |
| 4 | 语义落点 | **Core 方法契约层**：`discoverRelations` / `discoverEventRelations` / `discoverAltLabels` / `listEnrichmentWork` 四个 Core 方法收 call-wide 语义 + 名字校验进门；**自由函数原语契约一字不动**（`enrichAllDwsTables` 等的 omit/empty=全量保留）。MCP handler 退成纯转发 + 两个 relation 方法的调用门控（该维 on 才调）。 | 自由函数层收紧：会把 omit=全量从每一层一起拆掉，on-write hook 与全量回填当场断；MCP handler 层自持语义：需 Core 新增腿级 API（永久维护面），且 dsh 升级后长出第二套「过滤」定义 |
| 5 | subject 执行口径 | `describeRunEnrichmentScope` 改吃**同一份裁好的 scope**（各腿 on/off/all 算一次，调用与 subject 同源）——「N table(s)」与 trailer `Files=N` 按构造对账；措辞维持 `${n} table(s)` 现状。 | 两个口径各算各的（现状）：声明与执行可以不一致，正是 #25 的根因 |
| 6 | 词条与 ADR | 新 **ADR-0007**（本票）；GLOSSARY 新词条 `dimension filter`，与 `scope` / SG_Scope（多负载可见性）分离命名。 | 埋进 ADR-0006 addendum：0006 裁的是机制，没裁过滤；本裁决五条新契约各有自己的权衡，形状与「勘误」类 addendum（ADR-0005 的先例）不同 |

**被否掉的路**（记录免重探）：

- **自由函数层收紧过滤语义**——会把 omit/empty=全量从每一层（`enrichAllDwsTables` 等）一起拆掉，
  on-write hook 与 dsh 的全量回填用法当场断；且全仓生产调用方只有 MCP handler 一处用得到收紧后的
  语义，收紧了错的那一层。
- **MCP handler 层自持语义**（不动 Core，在 handler 里拦截后转发）——需要 Core 新增腿级 API 才能
  表达「只跑这一条腿」，这是一个永久维护面；dsh 升级后看见的还是旧的 Core 契约，长出第二套「过滤」
  定义，两套语义漂移只是时间问题。

## Consequences

- commit subject 的 `<N> table(s)/<N> event(s)` 段现在与 trailer `Files=N` 构造同源——两个口径不
  可能再分叉，#25 的根因类错误在类型层面消失。
- `run_enrichment(tables:[x])` 不再双扫事件：`discoverEventRelations` 与 `discoverAltLabels` 的
  events 腿现在共享同一次「events 是否在本次调用中」判断。
- 自由函数原语（`enrichAllDwsTables` 等）的 omit/empty=全量契约不变——dsh 的全量回填用法、
  on-write hook 零改动。
- `get_enrichment_work` 继承同一扇门：未知名/空数组在**索引**调用上与**写**调用上报同一类错误，
  agent 不需要分别学两套校验规则。
- events 维度仍无 on-write hook（ADR-0006 裁决 6 已记录的既有事实，本票未改变）——`run_enrichment`
  仍是其唯一 deterministic 批量通道，只是现在「调用了哪条腿」不再模糊。

## Verification

- 门禁脚本（`packages/mcp/scripts/check-e2e-loop.ts`，Phase 2.5）：未知名门口断言（两维度未知名在
  一条消息里列全、零 commit）；`run_enrichment(events:[...])` 只扫事件腿、`run_enrichment(tables:
  [...])` 只扫表腿（subject 与 trailer 对账）。
- 单测（`packages/substrate/tests/enrichment-work.spec.ts`「dimension-filter door (ADR-0007)」/
  「discoverAltLabels: call-wide legs (ADR-0007)」describe 块）：空数组门、未知名门（含双维度合并
  报告）、tables-only 调用下 events 腿零改动（含 fixture 必须含至少一个 events 定义——此前这是单
  测盲区，正是 #25 的失手处）。

## References

- 裁决票全记录：[#28](https://github.com/McKenzieIT/semantic-grounding/issues/28)
- 本票回应的事故：[#25](https://github.com/McKenzieIT/semantic-grounding/issues/25)
- 落盘执行票：[#31](https://github.com/McKenzieIT/semantic-grounding/issues/31)
- 行为依据：`packages/substrate/src/enrichment.ts:165`（`UnknownFilterNamesError`）、`:198`
  （`assertKnownFilterNames`）；`packages/substrate/src/index.ts:873`（`discoverRelations`）、`:924`
  （`discoverEventRelations`）、`:954`（`discoverAltLabels`）、`:1003`（`listEnrichmentWork`）——四处
  调用门口校验；`packages/mcp/src/tools/enrichment.ts:137`（`scopeFilterSchema`）、`:189`
  （`describeRunEnrichmentScope`）
- 错误码：`packages/mcp/src/errors.ts:182-192`
  （`ENRICHMENT_TOOL_ERROR_CODES.unknown_filter_name = -31040`）、`:449`（`UnknownFilterNameError`）
- GLOSSARY：`dimension filter`（新）、`scope`、enrichment work

# ADR-0014: 初始化阶段模型与双层独立进度

- **Status**: accepted
- **Date**: 2026-10-12
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0011（`scope_id` 必填模式的参照）、ADR-0012（概念从无 enrichment
  轮次这一结构性事实的同源证据）、[map #50](https://github.com/McKenzieIT/semantic-grounding/issues/50)、
  [#53](https://github.com/McKenzieIT/semantic-grounding/issues/53)（动态指引传递机制裁决：
  仅 6 写工具注入、`_guidance: {phase, hint, metrics}` JSON 形状、零 tax——本 ADR 的直接前提）、
  [#55](https://github.com/McKenzieIT/semantic-grounding/issues/55)（阶段模型/覆盖率指标/
  双层进度/完成度定义十四裁决，本 ADR 的 canonical 设计来源）、执行票
  [#56](https://github.com/McKenzieIT/semantic-grounding/issues/56)

## Context

`#53` 锁定了 `_guidance` 的传递机制（6 个写工具响应级条件注入、`auditedWrite` 组装后的
注入点、JSON 结构化格式、非初始化时零 tax），但把阶段枚举和触发条件都留成了临时占位：
`phase` 只有 `empty/early/complete` 三值，触发条件是裸的 definition count 阈值（默认
10）。`#53` 自己的裁决记录写明了升级路径：「待 #55 阶段模型落地后升级」。

`#56`（本 ADR 的执行票）最初按它自己 ticket body 里的占位 spec 实现并测试完毕——这个
占位 spec 正是 `#53` 遗留的三值枚举 + 单一阈值。`#55` 关闭后，有人在 `#56` 上补了一条
评论，明确指出 ticket body 已经过期，真正的模型是 `#55` 的十四裁决。本 ADR 记录的就是
`#55` 十四裁决中 `_guidance` 落地直接消费的那部分，以及 `#56` 据此重做之后的落地事实。

## Decision

采纳 `#55` 十四项裁决中，`_guidance` 落地直接消费的八项（R1/R2/R4/R5/R6/R8/R9/R12）：

| # | 维度 | 裁决 |
|---|---|---|
| R1 | 阶段模型 | 5 阶段硬编码骨架 + 状态实时派生：`scope_registration → seeding → backfill → llm_supplement → mature` |
| R2 | 覆盖率指标 | 阶段内指标，不做跨阶段加权综合（没有客观权重依据） |
| R4 | 双层进度 | DW（表 + 事件）与 KG（概念）各自独立跑阶段机，从不合并——合并会掩盖「DW 100% + KG 0%」被误读成「50% 成熟」这类失真 |
| R5 | 完成度定义 | `mature` = 初始化完成信号（guidance 注入在此停止），但非终态——语义层随业务持续生长 |
| R6 | 阶段边界 | `seeding`: 该层定义数 = 0；`backfill`: 该层的 enrichment work 队列非空（按层过滤；KG 结构上无 enrichment 维度，恒空，故 KG 的阶段机跳过这一步）；`llm_supplement`: 队列空且定义数 < 阈值；`mature`: 定义数 ≥ 阈值，无 exit |
| R8 | phase 枚举 | `_guidance.phase` 直接复用 playbook 阶段名（不是独立的简化枚举），取两层中较落后者 |
| R9 | 触发条件 | 裸 count 阈值退役；顶层触发条件改为「任一层未达 `mature` 即注入」——count 比较下沉为每层内部判断自己 phase 的依据，不再是触发条件本身 |
| R12 | 成熟阈值 | 分层默认 DW=50 / KG=5；`ServerConfig.guidanceThreshold: {dw?: number, kg?: number}` 可覆盖 |

`#55` 的另外四项裁决——R3（`recommended_action` 的 `{tool, hint}` 混合结构）、R7
（`get_initialization_playbook` 的完整返回形状）、R10（playbook 的 `scope_id` 必填）、
R13（corpus 级 `summary`）——描述的是**尚未实现**的 `get_initialization_playbook`
工具本身（`#55` resolution「实现落点」段点名的 `packages/mcp/src/tools/playbook.ts`）。
`_guidance` 字段的形状早被 `#53` 锁定为 `{phase, hint, metrics}`——`hint` 是裸字符串，
没有独立的 `tool` 字段——所以 R3 的混合结构不适用于本 ADR 落地的这一半。这四项裁决留在
`#55` 本身等候各自的执行票核验，不是本 ADR 的遗漏。

### 对 R1/R8 的收窄：`scope_registration` 在 `_guidance` 的类型里结构性不可达

`_guidance` 只注入 6 个写工具的响应（`create_definition`/`update_definition`/
`add_alias`/`remove_alias`/`add_relation`/`remove_relation`）。任何写工具的 handler
跑到注入点之前，`requireSnapshot()`（`binding.ts`）已经证明 scope 已注册且已绑定——这个
注入点结构上永远不可能观测到 `scope_registration` 阶段。`GuidancePhase`
（`guidance.ts:65`）据此收窄为 4 个值（`seeding | backfill | llm_supplement | mature`），
比 R7 设想的 playbook `PhaseName`（5 值，含 `scope_registration`）少一个。这是两个前提
条件不同的工具之间诚实的分叉，不是对 R8「别发明简化枚举」的违背——R8 反对的是意义被压缩
的简化枚举，不是要求两个工具的 TS 类型逐字相同。

## Consequences

- 新文件 `packages/mcp/src/tools/guidance.ts`：导出 `GuidanceThresholds`/
  `DEFAULT_DW_THRESHOLD`(50)/`DEFAULT_KG_THRESHOLD`(5)/`GuidancePhase`/`LayerMetrics`/
  `Guidance`/`maybeGuidance`/`guidanceField`；`dwPhase`/`kgPhase`/`layerCounts`/
  `hintFor`/`PHASE_RANK` 保持模块内私有。没有新增 Core/substrate API 面。
- DW/KG 拆分机制：`layerCounts`（`guidance.ts:107`）用
  `projectGraphNodes({includeDerived: false})`（`substrate/src/index.ts:894`）取全部
  节点，`kind === 'concept'` 的记为 KG（概念节点的 `kind` 恒为字面量 `'concept'`，
  `concept-kind.ts:15`），其余按排除法记为 DW——因为表节点的 `kind` 是它自己的开放存储
  种类字符串（如 `dim`/`dws`，取自 `def.kind`，`table-kind.ts:83`），不是字面量
  `'table'`；event 节点固定为 `'event'`（`event-kind.ts:15`）。「正面匹配表」在这个
  字段形状下行不通，「排除法算 DW」是唯一可靠的拆分方式。
- `dwPhase`（`guidance.ts:90`）复用 `Core.listEnrichmentWork({})`
  （`substrate/src/index.ts:1119`，无过滤即扫全量 tables + events）判断 backfill 队列
  是否非空。KG 层（`kgPhase`，`guidance.ts:99`）结构上直接跳过这一步，不是遗漏——概念
  从无 enrichment 轮次是既有的结构性事实（ADR-0012 Consequences 已记录同一事实：
  `enrichment.ts`/`enrichment-work.ts` 对 `'concept'` 零命中）。
- `listEnrichmentWork` 是真实 I/O 的 async 方法，所以 `maybeGuidance`/`guidanceField`
  必须是 async（`guidance.ts:140`/`:161`）。这一异步性沿调用链上溯：
  `itemResponseBase`（`items.ts:51`）由同步改 async，四个 item 工具调用点加 `await`
  （`items.ts:117/146/175/204`）；`write.ts` 的四处（`:91-92/:110-111/:133-134/
  :180-186`）同样先 `await` 再展开。读工具从不调用这条链，`_guidance` 永不出现在读
  响应里。
- `ServerConfig.guidanceThreshold`（`config.ts:106`）形状由裸 `number` 改为
  `GuidanceThresholds = {dw?: number, kg?: number}`；缺省一侧各自回落模块常量。没有
  新增 flag/env var——ADR-0011 裁决 3 已把 CLI 面收口在四个 flag，`#55`/`#56` 都没有
  要求开新口子；`ServerConfig` 构造仍是唯一入口（测试、未来的宿主嵌入）。
- 零 tax 维持（延续 `#53` 的裁决）：两层都到 `mature` 时 `maybeGuidance` 返回
  `undefined`，`guidanceField` 展开为 `{}`，`_guidance` 键整体从响应里消失，不是
  `null`——与 `enrichment_health` 同一 convention（`audited.ts`）。
- 可见但正确的行为，值得记录以免被当成 bug：新建一张没有列/没有 join key 重叠的空表
  定义，会让 DW 层重新进入 `backfill`——因为该表立刻产生新的 enrichment work gap。
  这是 R1「状态实时派生、非缓存快照」的直接推论：每次写都重新计算，不记忆「曾经到过
  `mature`」。
- `GLOSSARY.md` 的 `playbook (初始化手册)` 词条（commit `8fe4a07`，随 `#55` 落盘）在
  本票落地前已经完整描述了这个模型（五阶段名逐字一致、双层独立、「mature 非终态，只是
  guidance 注入停止」）。核对后确认与本票实现零冲突，词条未改动。

## Verification

- mcp 全量 `pnpm test`：22 个文件，336/336 通过，含新增 `tests/guidance.spec.ts`
  （12 tests）——6 个针对 `maybeGuidance` 的受控单测（双 0 计数的 tie-break 倾向 DW、
  KG 的 `seeding` 压过 DW 的 `llm_supplement`、DW 的 `backfill` 压过 KG 的 `mature`、
  默认阈值下两层都 `mature` 时返回 `undefined`、阈值覆盖不能绕过 `seeding`、按层
  自定义阈值覆盖）；6 个经真实 fixture + 真实 `listEnrichmentWork` 的 e2e（6 个写工具
  在默认阈值下全部携带 `_guidance`、读工具绝不携带、DW 侧 `backfill → llm_supplement`
  的真实推进、KG 侧 `seeding → llm_supplement → mature` 且两层都 `mature` 后
  `_guidance` 从响应里完全消失）。
- substrate 全量 `pnpm test`：27 个文件，424/424 通过（本票未改动 substrate 任何
  文件，回归确认零影响）。
- typecheck：`pnpm --filter @semantic-grounding/mcp typecheck` 与仓库级
  `pnpm -r run typecheck` 均干净通过。
- 门禁：两个包的 typecheck/test 全绿；本票未涉及 e2e 脚本改动（6 个写工具原有的 wire
  形状不变，只多一个条件性字段），现有 e2e 覆盖不需要新增步骤。

## References

- 设计来源：[#55](https://github.com/McKenzieIT/semantic-grounding/issues/55) 的
  resolution（十四裁决，R1/R2/R4/R5/R6/R8/R9/R12 是本 ADR 落地的部分，R3/R7/R10/R13
  等 `get_initialization_playbook` 落地时核验）
- 机制裁决：[#53](https://github.com/McKenzieIT/semantic-grounding/issues/53)
  （`_guidance` 的传递机制与 JSON 形状）
- 执行票：[#56](https://github.com/McKenzieIT/semantic-grounding/issues/56)（本 ADR
  的落地点；ticket 自身 body 文本是落地前的占位 spec，`#55` 关闭后的一条评论
  supersede 了它，详见该票 resolution）
- 行为依据：`packages/mcp/src/tools/guidance.ts`（新文件）、
  `packages/mcp/src/config.ts:57,106`、
  `packages/mcp/src/tools/write.ts:27,91-92,110-111,133-134,180-186`、
  `packages/mcp/src/tools/items.ts:24,51,57,117,146,175,204`、
  `packages/mcp/tests/helpers/intent-tools-harness.ts`、
  `packages/substrate/src/index.ts:894`（`projectGraphNodes`）、`:1119`
  （`listEnrichmentWork`）、`packages/substrate/src/kinds/concept-kind.ts:15`、
  `packages/substrate/src/kinds/event-kind.ts:15`、
  `packages/substrate/src/kinds/table-kind.ts:83`
- GLOSSARY：`playbook (初始化手册)` 词条随 `#55` 落盘（commit `8fe4a07`），本票核对
  后确认其描述覆盖本 ADR 的模型，未改动

跟进：`get_initialization_playbook` 工具（R3/R7/R10/R13 的落地点）尚未开票——map #50
随 `#56` 关票追加该子票。该票应复用本 ADR 的 `layerCounts`/`dwPhase`/`kgPhase`
（`guidance.ts`，当前模块内私有，未导出），而不是重新实现一套阶段判断逻辑。

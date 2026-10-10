# ADR-0008: enrichment work 响应尺寸治理 —— 索引/题面分离、cap、新工具

- **Status**: accepted
- **Date**: 2026-10-10
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0006（本票拆分的 `get_enrichment_work` 由 0006 新增；work_id 自包含指纹机制
  继承不变）、ADR-0007（缩围依赖的过滤语义）、[map #27](https://github.com/McKenzieIT/semantic-grounding/issues/27)、
  裁决票 [#30](https://github.com/McKenzieIT/semantic-grounding/issues/30)、
  研究票 [#29](https://github.com/McKenzieIT/semantic-grounding/issues/29)、
  [#25](https://github.com/McKenzieIT/semantic-grounding/issues/25)（本票回应的 dogfood 事故）、
  [#31](https://github.com/McKenzieIT/semantic-grounding/issues/31)（执行票）

## Context

[#25](https://github.com/McKenzieIT/semantic-grounding/issues/25) dogfood 事故第二条：
`get_enrichment_work` 的单表过滤调用返回**全库 579 项 / 25.9MB**（约 4.8M tokens），宿主只能落盘
临时文件再翻——对任何宿主都是一个 DoS 面。

[#29](https://github.com/McKenzieIT/semantic-grounding/issues/29) 研究票实地事实（SDK v2.3.1 dist
源码一手实测）：

- `tools/call` **没有协议级分页**；`nextCursor` 只挂在 `ListTools`/`ListPrompts`/`ListResources`/
  `ListResourceTemplates` 四个 Result schema 上，`tools/call` 请求/响应两侧都没有 cursor 字段。
- `CallToolResult = {content, structuredContent?, isError?}`，无分页字段。
- 生态收敛做法：server 自设上限（cap + `total`/`truncated`）+ 过滤参数缩围，不依赖客户端截断。

[#30](https://github.com/McKenzieIT/semantic-grounding/issues/30) grilling 前提实测（k11 语料，
321 表与 dogfood 记录同数）：159 张 dim 表，`buildLlmPrompt` 的 DIM 候选清单块（名字|主键|描述）
**31.3KB，每个 relation 项内嵌的这份清单逐字相同**；alt_labels 题面只含目标自身 ~2-5KB。579 项 /
25.9MB ≈ 几百份相同的 31KB + 各目标内容。索引行（仅 `work_id` + `target` + `gap`）≈270B≈68
tokens——`work_id` 的 64 字符指纹是大头。e2e oracle 按 `work_id`+`gap` 匹配答题、从不消费 prompt
内容——载荷分离的爆炸半径从一开始就可控。

## Decision

| # | 维度 | 裁决 | 关闭的取舍 |
|---|---|---|---|
| 1 | 上限机制 | **cap + `total` + `truncated:true` + ADR-0007 缩围**。 | 翻页：协议无分页通道（#29 实测），自造 cursor 稳定性自担——work 清单随语料演进（agent 每答一批就变），偏移会跳项/重项；`top_k`：清单无排序语义（目录序），「前 k 个」是任意截断，与缩围功能重叠 |
| 2 | 元数据位置 | 走 **content JSON 顶层**（`total`/`truncated` 与 `work` 平级），不用 `structuredContent`。 | `structuredContent` 载元数据：宿主消费链路未测（#29 明确警告），且 ADR-0006 的宿主中立约束只依赖 `tools/call` 的最弱形状——通道是否存在不是这条裁决的理由（见下方 ADR-0005 勘误） |
| 3 | 索引/题面分离 | `get_enrichment_work` 改索引形 `{work_id, target, gap}`（**不含 prompt**）；新增第 19 个工具 `get_enrichment_prompts(work_ids)` 按批取题面。 | 保留内嵌只上低 cap：triage 死胡同——`{}` 回前 10 项 + `total:579`，看不全缺口分布也问不出名字，而 ADR-0007 裁完后 agent 缩围必须先知道「哪些定义有缺口」，这个信息只存在于 listing（猜名撞 ADR-0007 的未知名 coded error） |
| 4 | cap 数值 | 索引 **1000 行**；题面批 **`min(1)`/`max(10)` 个 work_id**。两者相差两个数量级（索引~68 tokens/行、题面~8.3K tokens/项），折法=单次响应最坏 token ≤ 半窗（de-facto 200K 级）：10×8.3K≈83K（40% 窗，留答题+会话余量）、1000×68≈68K。cap 是**代码常量**，非配置面。 | 配置化 cap：要调走 ADR 修订，不开配置面——避免「cap 随环境漂移」成为新的审计盲区；索引下界被真实语料钉死（k11 需 579 行，cap 500 会截断旗舰语料 triage） |
| 5 | ADR 与 GLOSSARY | 新开 **ADR-0008**（本票，#28 分簇先例：addendum 只作勘误、不同关注簇分开开）。GLOSSARY `enrichment work` 词条**修订**（prompt 移出 item 描述、题面另取）——**不加新词条**：分离不产生新概念，只是把「清单」和「题面」两个已有事实拆开。 | 新词条 `enrichment prompt`：题面不是新领域概念，是既有「work item 的提示词部分」换了个取出方式 |

**被否掉的路**（记录免重探）：

- **翻页**（offset/cursor）——协议无通道（#29 SDK 源码确证），自造语义的稳定性自担：work 清单的
  内容随 agent 答题推进而变化，偏移量会跳项或重复项。
- **`top_k`**——清单无排序语义（现状是目录序），「前 k 个」是任意截断，且与 ADR-0007 的
  tables/events 缩围功能重叠（两个「变窄」旋钮，语义却不同）。
- **`structuredContent` 载元数据**——通道本身真实存在（见下文 ADR-0005 勘误），但宿主侧的消费
  链路从未实测过，先例（ADR-0006 的宿主中立约束）要求只依赖最弱 client 形状。
- **方案 B：保留内嵌只上 cap**——triage 死胡同，见裁决 3。
- **方案 A2：`include_prompts` 布尔**——一个工具两种响应形状、两套 cap，默认值两难：默认 `true`
  保行为兼容则 DoS 仍是默认路径；默认 `false` 则契约修订的量其实一点没少（和直接拆成两个工具一样
  多的改动，却换来一个更难描述的 schema）。
- **方案 A3：复用 `tables`/`events` 过滤参数兼管响应形状**——一个参数两种含义，ADR-0007 刚把这两
  个参数定义为「扫描范围」，再让它们隐式切换响应形状对 agent 不友好（同一个参数在不同上下文有不
  同效果，文档负担和出错率都上升）。

### ADR-0005 勘误（随本票记录，详见该 ADR 的 "Update 2026-10-10" 节）

[#29](https://github.com/McKenzieIT/semantic-grounding/issues/29) 的附带发现：
`structuredContent`/`outputSchema` 在 SDK v2.3.1 真实存在且接线（SEP-2106 §4.3 的 text-fallback
条款、era codec `projectCallToolResult`、`ToolSchema.outputSchema` 均在 dist 源码中实测确认）。
这是一条**记录性勘误**，纠正此前实现 #19–#22 期间形成的一条操作性前提，**不改变本票裁决 2**——
裁决 2 拒绝 `structuredContent` 的理由本就是「宿主消费链路未测」，不是「通道不存在」，通道事实
的更正不影响该理由的有效性。

## Consequences

- `get_enrichment_work` 的响应形状从「全量清单 + 内嵌题面」变成「cap 1000 行索引」——触发缩围
  （旧行为：agent 收到 25.9MB，别无选择只能自己截断或落盘）的调用现在在门口就看见 `truncated:
  true` + `total`，按 ADR-0007 的 tables/events 缩围重取。
- 新增 agent 工作流步骤：**索引 triage → 按批取题面 → apply → （若 stale）缩围重取**——比旧的
  「取 work → 直接 apply」多一跳，工具 description 需要教这个顺序（随 #31 落地）。
- `get_enrichment_prompts` 按**当前语料**重建题面（而非回放签发时缓存的文本）——baseline 只存
  指纹不存内容，所以一个 work_id 签发后、语料被别的调用改动过，取题面时可能已经是
  `stale_baseline`（与 apply 用的是同一指纹判据，行为对称，agent 只需学一套「baseline 过期」
  语义）。
- work_id 本身不瘦身——它是 apply 的钥匙（ADR-0006 裁决 4），索引行的 68 tokens 里指纹占大头，
  这是自包含设计的必然代价，不是本票留下的尺寸账。
- dsh 不受影响：索引/题面分离只发生在 MCP 工具面；dsh 的进程内 `setLlmCall` 路径不经过
  `get_enrichment_work`/`get_enrichment_prompts`，两个新 Core 层方法只服务 MCP handler。

## Verification

- 单测（`packages/substrate/tests/enrichment-work.spec.ts`「work index cap (ADR-0008)」/
  「getEnrichmentPrompts (ADR-0008)」describe 块）：索引在 1000 行截断且 `total`/`truncated` 如实
  （用 1202 行语料钉住边界，不采样不重排）；题面批对新鲜/过期/垃圾 work_id 的逐项 verdict。
- 门禁脚本（`check-e2e-loop.ts` Phase 5）：真实 `startup()` 走一遍「索引 → `get_enrichment_prompts`
  批取 → apply」全链，断言索引行形状恰为 `{work_id, target, gap}` 三键、`total` 与 `truncated` 落
  在 content JSON 顶层、题面的 `stale`/`fresh` verdict 跨一次重启仍自包含。

## References

- 裁决票全记录：[#30](https://github.com/McKenzieIT/semantic-grounding/issues/30)
- 研究票全记录：[#29](https://github.com/McKenzieIT/semantic-grounding/issues/29)（findings 分支
  `research/mcp-large-tool-results` @ `9368871`）
- 本票回应的事故：[#25](https://github.com/McKenzieIT/semantic-grounding/issues/25)
- 落盘执行票：[#31](https://github.com/McKenzieIT/semantic-grounding/issues/31)
- 行为依据：`packages/substrate/src/enrichment-work.ts:217`（`ENRICHMENT_WORK_INDEX_CAP = 1000`）、
  `:261`（`listEnrichmentWorkItems`）、`:334-336`（cap/total/truncated 构造）、`:382`
  （`fetchEnrichmentPrompts`）；`packages/mcp/src/tools/enrichment.ts`（`get_enrichment_prompts`
  工具注册、`PROMPT_BATCH_MAX = 10`）
- GLOSSARY：`enrichment work`（修订）、`dimension filter`

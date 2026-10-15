# ADR-0017: 第一方前端独占 —— substrate 公共面的唯一接入形态

- **Status**: accepted
- **Date**: 2026-10-13
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0002（(a)/(c) 判据证据渠道修订，见其 2026-10-13 修订）、ADR-0003（LLM seam 退役 + S1.5 八名收编 + 活条款转历史，见其 2026-10-13 Update）、ADR-0005（裁决 5/6 立项根勘误）、ADR-0006（「同一 seam、两种宿主姿态」被本 ADR 推翻）、ADR-0007（dsh 系理由措辞移除）、ADR-0011（裁决 8 seam 保留面终结）、ADR-0015（R3/R9 受众与 snapshot 措辞）、ADR-0016（同日独立发展前提的先例裁决）、[源票 #82](https://github.com/McKenzieIT/semantic-grounding/issues/82)、map [#88](https://github.com/McKenzieIT/semantic-grounding/issues/88)（执行：#83/#84/#85/#86 代码票 + #87 本 ADR 落盘票）

## Context

2026-10-13 [#79](https://github.com/McKenzieIT/semantic-grounding/issues/79) 裁决 semantic-grounding 独立发展、不再以 dsh 兼容为约束（ADR-0016 已按该前提落事件文件名迁移）。同日双轴巡检（首轮巡检报告已随 5d9b653 收束删除，全文 `git show 2913c26:docs/architecture-review-2026-10-13.md` 可回查，§S1）实证：dsh 姿态面集群六块的 ADR 保留理由原文都是「为 dsh 保留」，而 mcp 生产面（src + scripts）对它们 rg 亲验**零消费**——客户已不存在，代码/测试/barrel 名单/GLOSSARY 词条仍在全额维护（合计约 1200-1500 行 + 公共面收缩）。[#82](https://github.com/McKenzieIT/semantic-grounding/issues/82) 同日三轮 grilling 确认前提总纲与六项裁决；map #88 五张线性票执行（#83 `abef1d2` / #84 `3561278` / #85 `ba66229` / #86 `294a1aa`，均 2026-10-13 合入 main），本 ADR 随关图票 #87 直接 accepted 落盘。

## Decision

### 前提总纲（接入形态）

- **接入形态 = 第一方前端独占**。MCP 是现有前端；CLI + skills 是可能的后续第一方前端。
- **永不与 harness 耦合**：harness（含 dsh）一律经前端使用 substrate，不再存在「宿主进程内直接 import substrate」的形态。
- substrate 公共面在仓内的唯一消费者 = **mcp（及将来的第一方 CLI）**。ADR-0002 判据 (a)（具名活消费点）的证据渠道相应改为**第一方前端的具名消费**；判据 (b)（已确认 host 需求）的「host」= mcp / 第一方 CLI。

### 删留判据（用户钦定）

只有「**当前无价值 + 持续消耗注意力/开发成本**」的面才删；判断有后续价值的挂触发条件暂缓。

### 六项裁决（#82 grilling 2026-10-13 用户确认；本表为 canonical 出处）

| 项 | 对象 | 裁决 | 理由 / 触发条件 |
|---|---|---|---|
| S1.1 | snapshot 子系统 | **暂缓** | 触发：跨调用一致性读需求（多工具事务 / diff 类工具）立项时重开；justification 从「dsh 面」改为暂缓项（ADR-0005 裁决 6 / ADR-0015 R9 勘误随本 ADR） |
| S1.2 | LLM 回调 seam | **删**（#83） | ask-answer 工具对（`get_enrichment_work` / `get_enrichment_prompts` / `apply_enrichment`）为唯一 LLM 形态；进程内回调只服务已死直连形态，且自动写盘绕过 Tier-2 审计 |
| S1.3 | SchemaProvider / live-engine 三件套 | **暂缓** | 触发：live-engine 接入立项时重开 |
| S1.4 | sync-write 链 | **删**（#84） | 批量入口已由 import_definitions（provenance + 审计 + verdict，ADR-0013）更好覆盖；MCP 面显式拒绝过（`tools/write.ts:58`）；ADR-0003 复审窗已关、无人认领 |
| S1.5 | barrel 收窄 | **八名收名留码**（#85） | 巡检九名中 `loadRetrievalCorpus` 核验为本就 off barrel，实际收编八名；源模块导出全保留，公共路由 = kind 插件 `derivedNodes` + Core 同名方法 |
| S1.6 | scope-epoch 机制 | **删**（#86） | 多 scope 服务由 mcp 层 BindingStore + per-scope core + `switch_scope` 实现并验证；substrate 级多租户永不启用（ADR-0011 裁决 8 的保留前提随前提总纲失效） |

### 暂缓区（重开须重新举证）

- **S1.1 snapshot 子系统**：跨调用一致性读需求（多工具事务 / diff 类工具）立项时重开，按 ADR-0003 判据 (b) 重新举证。
- **S1.3 SchemaProvider / live-engine**：live-engine 接入立项时重开，按 ADR-0003 判据 (b) 重新举证。

两块的现状 justification（「为 dsh 保留」）已随前提总纲失效；**暂缓 ≠ 保留原判**——重开时以新需求举证，不以 dsh 举证。

## Consequences

- 十张 ADR Update/勘误随本图落地（0002/0003/0004/0005/0006/0007/0008/0011/0012/0015）；0001/0009/0010/0013/0014/0016 零改动。
- 公共面收敛的可观测账：barrel runtime **27 + default**（acceptance deepEqual 钉死）；`@deepseek-ai` 在 package.json + pnpm-lock.yaml 清零；rg 八符号（`setLlmCall|wireEnrichmentLlm|TextLlm|syncWrite\b|setScopeRegistry|ScopeRegistryLike|toPromptContext|toCriticContext`）代码+测试清零（ADR / GLOSSARY / 巡检报告历史记录保留）。工具面 **27 恒定**（全部删除在 substrate/mcp 内部面）。
- snapshot 子系统与 SchemaProvider 三件套**完全不动**（暂缓区边界）：`snapshot.spec.ts`、`captureSnapshot`/`DefinitionSnapshot` barrel 名、GLOSSARY snapshot 词条照旧；snapshot 活消费者照旧深引 io.ts。
- 「永不与 harness 耦合」是单向门：将来任何 harness 集成需求，答案恒是「经第一方前端」，不是重开 substrate 宿主面。

## References

- 源票：[#82](https://github.com/McKenzieIT/semantic-grounding/issues/82)（票面即规范：前提总纲、六项裁决、工作清单、边界、验收全文存目，随 map #88 关闭）
- 执行：map [#88](https://github.com/McKenzieIT/semantic-grounding/issues/88) + #83/#84/#85/#86（代码票）/ #87（本 ADR + 十张 Update + GLOSSARY + 终局验收）
- 巡检证据：首轮巡检报告全文 `git show 2913c26:docs/architecture-review-2026-10-13.md` 可回查（§S1，防重查存档；报告本体已随 5d9b653 收束删除）
- 先例：ADR-0016（同日独立发展前提的首个裁决——事件文件名迁移而非适配）

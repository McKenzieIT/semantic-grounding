# ADR-0013: 批量定义导入——逐项裁决与校验边界

- **Status**: accepted
- **Date**: 2026-10-12
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0005（工具面契约：provenance 三字段、裁决 9 的 origin 省略、裁决 5
  对引擎观测形状的拒绝）、ADR-0004（裁决 3 的 `beginBatch` 批量槽——本 ADR 是它的第二个
  非 enrichment 消费者）、ADR-0012（R5 批量导入 provenance 预录四原则；概念写路径——
  concept 分支的编译目标）、ADR-0014（playbook R3 表把 `import_definitions` 定为 DW
  seeding 的 recommended_action）、
  [map #50](https://github.com/McKenzieIT/semantic-grounding/issues/50)、设计票
  [#54](https://github.com/McKenzieIT/semantic-grounding/issues/54)（七裁决，本 ADR 的
  canonical 设计来源）、执行票 [#68](https://github.com/McKenzieIT/semantic-grounding/issues/68)

## Context

游戏产品初始化 = 100+ 表需要注册；逐条 `create_definition` 的往返成本不可接受（#46 R1 的
Followup 触发条件「首个真实批量种子场景」随 #52 概念注册路径落地而到达）。#54 经 grilling
锁定了七项裁决（输入形状、校验边界、尺寸上限、部分失败语义、概念支持、工具名、幂等性），
并预留本 ADR 编号记录其中够门槛的三件事：逐项裁决 vs 全批原子的 trade-off、不做跨 corpus
校验的理由、工具名的审计语义。

两个裁决后的新事实影响了落地面，均已在 #54 票面以评论补录：

1. **#61 的 seam 收敛**：io.ts 七条写路径的 audited write-and-record 仪式已收进单一
   `auditedFileWrite` seam，写路径错误面归一（领域失败 = `{ok:false}`）。批量导入的逐条
   写入骑 seam 而不是抄仪式。
2. **#63 的计数核正**：tools/list 实际 25（#54 票面「24→25」的前提证伪——当时
   `import_definitions` 未落地）。本 ADR 落地后 25→26。

## Decision

采纳 #54 七裁决，外加执行票核验中定下的五处执行级细节。

### 七裁决（#54 原文）

| # | 维度 | 裁决 |
|---|---|---|
| R1 | 输入形状 | JSON + zod：`scope_id` + `items`（三种 definition schema 复用，`kind` 判别）+ **batch 级 provenance**（`summary`/`derivation`/`confidence` 放顶层不逐 item——100 张表出自同一份 DDL 是同一判断）。排除 YAML 数组（双重编码）与目录路径（远程 agent 不能写 server 文件系统） |
| R2 | 校验边界 | Phase 1 = zod `safeParse`（每 item）+ 批内 name 去重（**跨 kind**，一个 `Set` 收死）。不做 `dimension_refs`/`domains`/`related_refs` 存在性校验——那是 enrichment 的设计职责（`run_enrichment` 的 deterministic 轮发现 gap 并报告为 work） |
| R3 | 尺寸上限 | cap 500（zod `.max(500)`），超限**报错不截断**——静默截断 = 数据丢失。瓶颈在 agent 输出 token 非 server 处理 |
| R4 | 部分失败语义 | 逐项裁决、两阶段：Phase 1 纯校验零 IO 分流 → Phase 2 `beginBatch` 批写入单 commit。verdict `created|updated|skipped|error`，坏项不中断批（99 张好表不为 1 张坏表陪葬）。零 commit（全 idempotent）或单 commit |
| R5 | 概念导入 | table + event + concept 三 kind 同时支持——双层语义层的初始化需要表和概念同批注册；排除 concept = 在概念侧复活逐条往返 |
| R6 | 工具名 | `import_definitions`（intent-level；导入 ≠ 批量创建——工具实际做 create+update+skip）。新增 `import_` 动词到工具面，tools/list 25→26 |
| R7 | 幂等性 | 已存在且内容相同 = `skipped`（不进 Phase 2）；不同 = `updated`。幂等不报错，与 `syncWriteDefinitions` 的 `skipped` 计数器、`apply_enrichment` 的 `idempotent` verdict 同源 |

provenance 符合 ADR-0012 R5 四原则：`derivation = agent`（转抄并对适用性负责就是判断，
不开第四值——schema 收窄为 `z.literal('agent')`）；来源进 commit summary（`summary` 字段
就是来源陈述位）；YAML `origin` 照旧省略（ADR-0005 裁决 9：省略即获 curated 保护）；跨
corpus 复制 = 导入的用法之一，不立第三机制。

### 执行级细节（#68 落定时锁定）

1. **R1×R4 调和——SDK 层 envelope 保持 permissive**。#54 草图的 items 是严格
   discriminated union，但严格 union 由 SDK 在 handler 之前整调用校验——一个坏项拒绝全批，
   正是 R4 从后门放回来的全批原子。R4 的 verdict 通道（`detail` 装载 zod issue）要求严格
   解析发生在 Phase 1 逐项做。故 envelope 只带 `kind` 判别 + `definition: unknown`，
   `.describe()` 指向 `create_definition` 已广告的 schema——严格形状仍单一来源，一个坏项
   只花费它自己那一行 verdict。
2. **`updated` = 全量覆写**。编译目标就是 `create_definition` 同源的三个 raw 原语
   （`writeTable`/`writeEventYaml`/`core.writeConceptYaml`），因此与盘上内容不同的项整文件
   替换：batch 是 agent 对「dump 即真相」的断言。concept 重导入漂移会替换文件，payload 未
   携带的 `related_refs` 边随之丢失——verdict 如实报 `updated`，这是声明过的语义不是静默
   丢失。`updated` 不走 `update_definition` 的浅合并路径：合并会静默保留 dump 已删除的字段
   （如 DDL 里删掉的列），对初始化场景是错误答案。
3. **`skipped` = 「这次写入会不会是 no-op」**，按 kind 取比对口径：table/event 比对
   zod-parsed 载荷与已载入定义的 deep-equal（同一 schema 在两侧都物化默认值，缺省与默认
   塌缩为相等；被 enrichment 触碰过的文件自然不等、正确落入 `updated`）；concept 比对
   payload 五键投影（`name`/`description`/`pref_label`/`alt_labels`/`properties`）——存量
   concept 合法携带 create 形 payload 从不声明的 `related_refs`/`suppressed_*`，它们不得
   在幂等重导入上制造幻影 `updated`。
4. **`commit` 恒返回**（零变化时 = 当时 HEAD）：沿用 `run_enrichment` 已成文的
   timeout-receipt 惯例——客户端超时后原样重发，幂等应答携带的 sha 就是「那笔已落」的收据。
5. **`_guidance` 注入第 7 个写工具**（#54 依赖段 T3 的悬问「导入结果是否需要附加指引」就此
   落定：注入）。机制完全复用 #53 选项 D（`auditedWrite` 响应组装后 `guidanceField` 展
   开）；导入是 seeding 阶段的主力写路径，恰恰是最该收到阶段指引的调用。

### 落地形状

- 新文件 `packages/mcp/src/tools/import.ts`（`IMPORT_TOOL_NAMES` + `registerImportTools`，
  按 playbook 家族同款方式并入 `TOOL_NAMES`/`TOOL_REGISTRARS` 单一来源组合）。
- Phase 2 与 `run_enrichment` 同构：`auditedWrite` → `beginBatch()` → 逐项
  `{recorder, scope_id}` 骑 seam → 每落盘一项 `batch.record()` → `end()` 单 commit；异常
  `batch.abort()` 后穿透（基础设施故障仍整批回滚——`runAudited` 的锁与
  `assertCleanBeforeWrite` 保证 abort 的 `reset --hard` 只会撤掉本批的写入）。
- Phase 2 的领域失败（`{ok:false}`）走 verdict 通道不中断批——理论不可达（工具 schema 与
   写原语校验的是同一批 schema 对象），通道存在正是为了「99 不陪葬」对任意失败形态成立。
- `enrichment_health` 键恒缺：raw 原语不跑 on-write hook（`create_definition` 同口径），
   逐项混批没有单一 kind 可归属的健康面。

## Consequences

- 初始化剧本（ADR-0014 R3 表）闭环：DW seeding 的 recommended_action
  `import_definitions` 从前瞻引用变为在册工具；playbook.ts 的 interim 注记与 ADR-0014 的
  前瞻引用注记随本 ADR 追记兑现。
- 工具面 25→26；catalog 断言 `toHaveLength(26)` 减速带随改；e2e 20→21 步。
- `_guidance` 注入面从 6 写工具扩到 7——机制零改动，`guidance.ts` 模块文档随之更正。
- `server-startup.spec.ts` 原先手工拼接的 `ALL_DEFAULT_TOOL_NAMES` 家族列表（正是
  `tools/index.ts` 文档反对的 anti-drift 模式）随本次收编为直接引用 `TOOL_NAMES`。
- 批内跨 kind 重名在 Phase 1 拒绝（第二个同名项 error verdict）：同名不同 kind 物理上可共存
  （不同目录），但同一批里同名几乎必然是 agent 复制段错误，且会污染双层归属。
- `derivation` 在本工具收窄为 `agent`——`llm` 不可选（本工具没有途径为「一份完成稿」作证），
  与 ADR-0012 R5「不开第四值」同一条推理线。

## Verification

- `tests/import-definitions.spec.ts`（8 tests）：混合三 kind 单 commit（subject/trailer
  Files=4/Rounds=4 直接断言）、幂等重发全 skipped 零 commit、漂移 `updated` 全量覆写、
  坏项（DIM superRefine 失败）与跨 kind 重名各自 error verdict 不中断批、501 超限整调用
  拒绝、`derivation:'llm'` 拒绝、envelope 严格键、`scope_mismatch`（−31064）。
- `tests/intent-tools-catalog.spec.ts`：26 名对账 + import 的 schema 面（必填五字段、
  minItems/maxItems、`derivation.const === 'agent'`、permissive envelope）。
- `tests/guidance.spec.ts`：第 7 写工具注入位 + 落库后的真实阶段（DW backfill 为 laggard）。
- e2e 21 步：独立 fixture/registry/boot，三连发（首发 4 created + 2 error 单 commit →
  等批重发全 skipped 零 commit → 漂移 1 updated 单 commit），末尾树干净断言。

## References

- 设计票：[#54](https://github.com/McKenzieIT/semantic-grounding/issues/54)（七裁决
  resolution + #61 后置补论 + #63 计数核正）
- provenance 原则：ADR-0012 R5（#46 resolution 预录）
- 批量槽：ADR-0004 裁决 3；第二个消费者先例：`run_enrichment`（`tools/enrichment.ts`）
- 执行票：[#68](https://github.com/McKenzieIT/semantic-grounding/issues/68)

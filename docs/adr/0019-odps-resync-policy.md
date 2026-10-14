# ADR-0019: ODPS schema 更新/漂移的再同步口径 —— 被动发现 + 关系层分治保全 + 占比守卫

- **Status**: accepted
- **Date**: 2026-10-14
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0013（`import_definitions` 批量门 —— 再同步必经之门；其 Phase 1
  零写裁决即漂移 diff，R2「不做跨 corpus 引用存在性校验、划归 enrichment」是本 ADR R5 的直接
  依据）、ADR-0004（Tier-2 单 commit / content-sha 乐观并发指纹 / 一次 re-sync 一个
  `git revert`-able commit 的审计骨架 + author=agent·committer=server 身份模型）、ADR-0005
  （工具面契约；ruling 4：`dimension_refs`/`external_refs`/`related_refs`/`suppressed_*` 是
  item-verb 字段，永不经 create/import 手写 —— 本 ADR R2/R3「import 不写边、故不得删边」的
  根据；ruling 5：`sync_tables` 随 live-engine 接入另行成票、服务端手搓 TableMeta = provenance
  造假 —— 本 ADR R1 否决服务端主动 diff 的根据）、ADR-0006（`run_enrichment` 确定性回填 + work
  队列；concept 零命中 —— 本 ADR R2/R4 分治的命脉）、ADR-0010（suppression 持久化：
  `suppressed_*` 的 provenance-in-commit）、ADR-0012（concept write path）、ADR-0018
  （姊妹篇：批量纳入评审面的**按 `updated` 计数**覆盖守卫；本 ADR R6 的**占比**守卫与之互补、
  同为软信号，ADR-0018 已前向把 ratio 形态划归本票）、map
  [#89](https://github.com/McKenzieIT/semantic-grounding/issues/89)、决策票
  [#94](https://github.com/McKenzieIT/semantic-grounding/issues/94)（canonical 设计来源，五点
  grilling + McKenzieIT dogfood 证据）、执行票
  [#111](https://github.com/McKenzieIT/semantic-grounding/issues/111)、调研前件
  [#90](https://github.com/McKenzieIT/semantic-grounding/issues/90)（三缺口 file:line）、
  [#91](https://github.com/McKenzieIT/semantic-grounding/issues/91)（竞品 prior-art）、方向前提
  [#79](https://github.com/McKenzieIT/semantic-grounding/issues/79)（MCP 单宿主、服务端不执行
  infra）、[#92](https://github.com/McKenzieIT/semantic-grounding/issues/92)（探索草稿的家
  `<gitDir>/sg-scratch/`）

## Context

map #89 缺口 (c)：ODPS schema 变化后的**更新/漂移再同步**无管理口径。#90 实测服务端现状：
**无 ODPS 客户端**（仅 `types.ts:277` 标签 + **未挂载**的 schema-provider seam，`index.ts:1570`
的 `setSchemaProvider` / `ctx.schema.discover` 抛 "no live-engine schema provider mounted"）；
config 存快照无版本；唯一 fingerprint 是**写并发用**的 content-sha256（`read.ts`），与上游漂移
无关。

#94 的 McKenzieIT dogfood 评论（另一环境经 `sg-mcp init` 的真实轨迹，已核当前 `main` 源码）暴露
一条**再同步必经的契约裂缝**：`get_definition` 的输出字段 ⊋ `import_definitions` 的输入白名单
—— `get_definition` 返回 concept 的全 8 键（含派生的 `related_refs` / `suppressed_alt_labels` /
`suppressed_related_refs`），而把输出原样喂回 `import_definitions`，concept 会 **zod 硬失败**
（"Unrecognized keys"）。根因：`ConceptCreatePayloadSchema` 是 `.strict()` 的 5 键
（`shared.ts:277-283`），而 `TableDefinitionSchema` / `EventDefinitionSchema` 是 `.loose()`，故
硬失败**仅发生在 concept**。漂移后再同步必然把定义重新喂回 `import_definitions`，这条 round-trip
恒经该契约 —— 故本票在定「再同步口径」时顺带定**可重导投影契约**（#94 problem ⑤）。

几项既定前提收窄了解空间（五点 grilling 逐一对现源码验证）：

1. **服务端不执行 infra**（#79）：MCP 单宿主，engine/LLM 两半属连接的 agent；服务端无 ODPS
   client，`sync_tables` 已 deferred（ADR-0005 ruling 5），服务端自断 TableMeta = provenance
   造假。任何「服务端主动 diff ODPS」都要先造一个本模型里不存在的服务端 ODPS 执行面。
2. **item-verb 字段永不经 import 写**（ADR-0005 ruling 4）：边与 suppression 由
   `add_relation` / `remove_relation` / `add_alias` / `remove_alias`（→ `updateConceptMeta` /
   `updateTableMeta` 读-合-写）产生/提升；`import_definitions` 从不写这些字段。推论：import
   既不写边，就**不得删边**。import 自己的 `wouldBeNoOp` 对 concept 比的正是五键投影（"a stored
   concept legitimately carries fields the create-shaped payload never had"）—— 即 skip 侧
   已承认「边不归我管」，而 write 侧（`import.ts:287` 的 `writeConceptYaml` 整体覆写）却把边删掉，
   自相矛盾。
3. **concept 无 enrichment 轮**（ADR-0006 / #46）：对现源码核实 —— `concept` 在
   `enrichment.ts` / `enrichment-work.ts` / `tools/enrichment.ts` **三文件零命中**；
   `related_refs` 在 enrichment 零命中。故 concept 边一旦丢失**没有任何确定性机制能重导**。
4. **table/event 关系可确定性重导**：`dimension_refs` 在 `enrichment-work.ts` 有 9 处 ——
   enrichment 的确定性关系轮按列名配对，DWS 空 `dimension_refs` + inventory 有 DIM → 产出 relation
   work item（`enrichment-work.spec.ts`）。且 K11 真实语料的 table YAML **普遍内联携带非空
   `dimension_refs`**，`.loose()`（`types.ts` 收口）保证其无损往返、ADR-0013 R2 照写不校验。
5. **import Phase 1 已是漂移 diff**：Phase 1 零写裁决按 content-sha 比对回
   `created|updated|skipped`（`import.ts` ~224–267）；`updated` 桶 = 被覆写的既有 source-of-truth
   = 漂移量。一次 re-sync 一个 `git revert`-able commit（ADR-0004）。

## Decision

再同步口径 = **被动轨迹驱动发现 + 关系层按 kind 分治保全 + 漂移分解进现有面 + 占比软守卫 + 无 schema 指纹**。
分治的分水岭是一条经验事实：**该关系层能否被 enrichment 确定性重导**。

| # | 维度 | 裁决 |
|---|---|---|
| R1 | 发现 = 被动轨迹驱动 | 服务端永不碰 ODPS。漂移由 agent 在自己轨迹里 re-probe：把漂移 schema 拉进 `<gitDir>/sg-scratch/<run-id>/`（worktree 外，#92，server 确定性 GC 留最近 3）→ regen 受影响 table/event 定义 → 经 `import_definitions` 回灌。漂移量 = Phase 1 的 `updated` verdicts + 占比守卫（R6）量化。否决服务端 `SchemaProvider` 主动 diff（见否决项）。 |
| R2 | concept 写侧 = 服务端保全 | `import.ts:287` 的 concept `updated` 分支由 `writeConceptYaml`（`io.ts:990`，整体 `atomicWrite` → 丢盘上 `related_refs` / `suppressed_*`）改走 **read-merge-write**，复用 `updateConceptMeta`（`io.ts:1028`，Tier-2 读-合-验-写）的合并语义：`{ ...盘上 8 键, ...新 payload 5 键 }`，describe-able 5 键被覆写、3 个 item-verb 键从盘上保全。理由：import 不写边（前提 2）就不得删边；且 concept 边不可重导（前提 3），丢了就没了，服务端保全是唯一防线。`created` 分支（无盘上文件）维持 `writeConceptYaml`。 |
| R3 | 投影入侧 = strict→strip 三键、仍拒未知键 | `ConceptCreatePayloadSchema`（`shared.ts:277-283`）由 `.strict()` 改为 **strip 三个已知 item-verb 键**（`related_refs` / `suppressed_alt_labels` / `suppressed_related_refs`）**、仍 REJECT 真正未知键**。这是对 `shared.ts:270-277` 既有设计意图（"edges are item-verb… a stray key is a typo zod answers"）的**精炼而非推翻**：区分「已知 item-verb 键 present = round-trip 合法、剥离忽略」与「未知键 = typo、zod 照拒」。一处改，`create_definition` 与 `import_definitions` 同享；工具 `.describe()` 声明三键 item-verb 托管、present-即-忽略；verdict `detail` 回执 "ignored N item-verb keys"。R2 已先保全数据，故此处剥离安全。 |
| R4 | table/event 写侧 = 不服务端保全 | `dimension_refs` / `external_refs` **是** payload 字段（`.loose()`，K11 内联携带、ADR-0013 R2 照写），`get_definition`→客户端合并→回灌 loose 无损往返；就算 agent 合并手滑丢，enrichment 确定性关系轮**自动重导**（前提 4）。故靠客户端合并 + enrichment 自愈，**不**加服务端保全 —— 与 concept 的不对称是**原则性的**：谁不可重导谁才需服务端保全。反面：若对 table 也「import 忽略 payload 内联 refs」，会清空 K11 种子的 `dimension_refs`、回归既有表播种/round-trip 行为。 |
| R5 | 善后 = 分解进现有面，无一等漂移产物 | 漂移不是特殊 change，就是「上游驱动的 `updated`」。其语义善后（新列缺描述/ref、改名删列留 dangling/missing ref）与任何 enrichment gap **同形**。drift = Phase 1 `updated` verdicts（变了啥）+ 占比 WARN（blast radius）+ `run_enrichment`（缺口 / 可重导派生自愈）。ADR-0006 已把「定义缺派生事实 = work」收敛到 `run_enrichment`，ADR-0013 R2 已把 `dimension_refs` 存在性判给 enrichment、不给 import 门。不设第二套「漂移队列」—— agent 不关心一个 gap 来自 cold-start 还是 drift。 |
| R6 | blast-radius = 占比软守卫 | 在 ADR-0018 的**绝对 `updated` 计数**守卫**之上**加一个独立软触发：按 kind 的占比 `updated(kind) / existing(kind)`（绝对 = 「超出肉眼预算」，占比 = 「动了 corpus 多大比例 / 爆炸半径」）。超阈 → WARN + 复用 `import.ts:267` intentTarget 的 commit trailer（对齐 ADR-0018 R4），**不硬拒** —— 整次 re-sync 一个 `git revert`-able commit，WARN+trailer+revert 足矣；硬拒会逼出一套 override 机制、与「approve 故意未实现」的 ethos 冲突。默认全落 `ServerConfig`（`config.ts`）可调：按 kind 分母、阈值 50%、小语料 floor ~10（之下只绝对守卫生效，占比对小 corpus 无意义）。 |
| R7 | 版本 = 不引入 schema 指纹 | 不新增 schema 指纹 / epoch。被动发现（R1）下服务端无 ODPS baseline 可比，指纹唯一消费者是 agent，而它 re-probe 时 live schema 已在手、Phase 1 零写判定（content-sha 比对、`wouldBeNoOp`）本身就是漂移 diff（前提 5），再加指纹是冗余第二套。版本已存在：每定义 content-sha（`expected_version` / ADR-0004）+ git commit 历史（一次 re-sync 一个可 revert commit = schema 时间线）。我们是**语义字典、不是 schema 镜像**：唯一「content-sha 抓不到而指纹能抓」的，是「改上游但不改生成定义」的漂移 —— 那恰是**语义无关**的漂移，字典正确地说「没变」；追它就是把 semantic-grounding 降格成 schema registry（非其职、撞 face-restraint）。 |

### 否决项

- **服务端 `SchemaProvider` 主动 diff（R1 的 A 面）**：否决。服务端无 ODPS client、`discover()`
  抛 "P6b Q3 deferred"、sync-write 已在架构巡检 S1 删除、`sync_tables` deferred（ADR-0005
  ruling 5）、违 #79、服务端自断 TableMeta = provenance 造假。被动轨迹驱动用 agent 自己轨迹里
  已有的 ODPS access + Phase 1 现成裁决零成本达成同一「发现漂移」目的。
- **`get_definition` 可重导模式/视图（R3 的选项 3，McKenzieIT 评论选项 3）**：否决。它新增读面
  （撞 ADR-0005 面克制 / #79），且 default 响应仍是「输出喂不回去」的陷阱，还要在读面复制投影逻辑。
  R2 已保全数据、R3 已让默认 round-trip 闭合，视图无必要。
- **一等漂移产物 / 队列（R5 的 A 面）**：否决。与 enrichment gap 报告重复、要 agent 维护两套
  队列、撞 face-restraint；而表 refs 的确定性轮本就把漂移丢的那部分自愈回现有队列。
- **schema 指纹 / 全局 epoch（R7 的 B/C 面）**：否决。Phase 1 + git 已是 diff 与版本；指纹对
  被动发现无消费者、对语义字典抓的是无关漂移。
- **统一「所有 kind 都服务端保全 + import 忽略 payload item-verb 键」（R4 的 i 面）**：否决。它会
  清空 K11 表种子的内联 `dimension_refs`、回归既有 table 播种/round-trip；且 table refs 可
  enrichment 重导、本不需服务端兜底。保全只给**不可重导**的 concept。

### 实现落点

- `packages/mcp/src/tools/import.ts`：`:287` 的 concept `updated` 分支改走 `updateConceptMeta`
  读-合-写（R2，`created` 维持 `writeConceptYaml`）；Phase 2 入口在 ADR-0018 count 守卫之上加按
  kind 占比软触发，超阈 WARN + 并入 `:267` intentTarget 的 commit trailer（R6）。
- `packages/mcp/src/tools/shared.ts`：`:277-283` 的 `ConceptCreatePayloadSchema` 由 `.strict()`
  改为 strip 三个已知 item-verb 键、REJECT 未知键（R3）；`.describe()` 补白名单与 item-verb 说明。
- `packages/mcp/src/config.ts`：`ServerConfig` 加占比阈值 + 小语料 floor 字段 + `parseServerConfig`
  解析（flag / env）（R6）。
- **复用既有 substrate 公共面**（`updateConceptMeta` 已是公共 Tier-2 seam，`io.ts:1028`），
  **不新增 substrate 公共面**（#79）。table/event 写侧与 substrate 不动（R4）。

执行见 [#111](https://github.com/McKenzieIT/semantic-grounding/issues/111)。

## Consequences

- concept round-trip 闭合：`get_definition` 的输出喂回 `import_definitions` 不再 zod 硬失败，且
  `updated` 覆写不再静默丢边 —— 一条 data-loss 路径（前提 2 的自相矛盾）被堵死。
- 同一投影契约修好也**解除 #93 dry-run 的 round-trip 阻碍**（McKenzieIT 交叉指针）：dry-run 的
  generate-then-diff 必须能把定义过一遍 `import_definitions`，concept 不再硬失败后该路打通。
- table/event 再同步靠「客户端合并 + enrichment 确定性自愈 + git-revert + 占比守卫」四重网，
  不加服务端面；漂移善后全程走已有 enrichment 队列，无新工单形态。
- 占比守卫叠在 ADR-0018 count 守卫上，二者同为软信号 + commit trailer，组成「绝对预算 + 相对爆炸
  半径」两道独立触发；冷启动（全 `created`、小 corpus）两道皆静默。
- 版本/漂移检测沿用 content-sha + git log + Phase 1，无新构造。
- GLOSSARY 新增 `passive drift discovery (被动漂移发现)` / `re-sync projection contract
  (可重导投影契约)` / `ratio guard (占比守卫)`；并更新 `mass-update guard` 词条的 ratio 指针至
  本 ADR。
- **scope 边界**：live-engine 接入后「服务端是否挂载 `SchemaProvider` 做主动发现」仍 deferred
  （ADR-0005 ruling 5 的 `sync_tables` 另行成票轨道），本 ADR 只定**当前单宿主**下的被动口径，不为
  其预留服务端执行面。

## Verification（执行票 #111 的验收门，待落地补 Update）

- concept `updated` 覆写后，盘上既有 `related_refs` / `suppressed_alt_labels` /
  `suppressed_related_refs` **保全**（新增回归，钉死 data-loss）。
- `get_definition` 的 concept 输出**原样**喂回 `import_definitions` 不再 zod 硬失败（round-trip
  闭合）；而**真正未知键仍被 REJECT**（typo-catching 不回归）。
- table / event round-trip 行为不变：内联 `dimension_refs` / `external_refs` 照写照存。
- 占比守卫：冷启动（全 `created` / 小 corpus < floor）**静默**；漂移（`updated` 占比超阈）WARN +
  commit trailer 带占比标注；阈值 / floor 可经 `ServerConfig` / flag / env 配置且 default 有测试
  钉死；与 ADR-0018 count 守卫**各自独立触发**。
- substrate / mcp 全量 test、e2e、双包 typecheck 不红（对标 ADR-0016 基线）；不新增 tools/list
  条目；不新增 substrate 公共面导出。

## Update — #111 落地（2026-10-14）

合入 main `c741c5d`（wf 分支原 `901c117`，与 #104 同批集成分支复跑四门禁：typecheck 双包 0 /
substrate 450 / mcp **420+1skip** / e2e 21 步 / tools/list 27 不变；substrate 零改动——R2 走既有
`updateConceptMeta` 公共 Tier-2 seam，不新增公共面）。Verification 各条全数兑现：concept
`updated` 后盘上三 item-verb 键保全（data-loss 回归钉死，行级 version 回执与 get_definition
闭合）、`get_definition` 输出原样回灌不再 zod 硬失败（round-trip 闭合）、真未知键仍拒、
table/event `.loose()` round-trip 不变、占比守卫冷启动/floor 静默 + 超阈 WARN+trailer + 阈值
可配且 default 钉死。执行核正两则：

1. **R6 分母口径**：`existing(kind)` = `projectGraphNodes({includeDerived:false})` 的
   schema-valid 图内计数（沿用 guidance `layerCounts` 既定口径，拒计 malformed 残留；表节点
   kind 是开放存储 kind，按排除法归 table）。守卫在 Phase 2 入口、写前计数，分母天然含本次
   updated 项。
2. **WARN 通道与 ADR-0018 统一**：占比守卫信号落响应顶层 `warnings: string[]`（零税缺席），
   标注骑 intent target 通道、落 commit subject（ADR-0018 R4 同通道；「commit trailer」措辞
   勘误同 ADR-0018 Update 3——机制实落 subject，subject 同样可 `git log --grep` 命中）；与
   count 守卫各自独立触发，集成后同一批可双标注（51/53 场景有测试钉死）。锚点漂移
   （`import.ts:287`→305、`io.ts:1028`→1055 等，#108/#109 所致）语义核实一致。

## References

- 决策票：[#94](https://github.com/McKenzieIT/semantic-grounding/issues/94)（五点 grilling
  resolution：R1 被动发现 / R2 concept 保全 / R3 strict→strip 投影 / R4 table-event 客户端合并 /
  R5 分解漂移 / R6 占比守卫 / R7 无指纹）+ McKenzieIT dogfood 证据（concept round-trip 硬失败）
- 执行票：[#111](https://github.com/McKenzieIT/semantic-grounding/issues/111)
- 姊妹票：[#93](https://github.com/McKenzieIT/semantic-grounding/issues/93) / ADR-0018（count
  守卫；本 ADR 占比守卫与之互补）
- 调研：[#90](https://github.com/McKenzieIT/semantic-grounding/issues/90)（缺口 file:line）、
  [#91](https://github.com/McKenzieIT/semantic-grounding/issues/91)（竞品 prior-art）
- 前提：[#79](https://github.com/McKenzieIT/semantic-grounding/issues/79)（单宿主）、
  [#92](https://github.com/McKenzieIT/semantic-grounding/issues/92)（scratch 家）
- map：[#89](https://github.com/McKenzieIT/semantic-grounding/issues/89)

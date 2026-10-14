# ADR-0026: 锚点目标消失时 memory 的最低行为 —— 不迁移不拦截、读时现算悬空、撞上旧名时交出

- **Status**: accepted
- **Date**: 2026-10-15
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0023（R2 只追加、R4 锚点形状与写时校验、列删降级 —— 本 ADR 把降级推广到节点与边）、
  ADR-0024（R1 `edge_memories` 按端点挂载、R3/R4 可见性与预算、R5 `column_missing` —— 本 ADR R2/R3 照抄其形状）、
  ADR-0010 R5（回执即教学回路 —— R4 的先例）、ADR-0022 / map #125 Out of scope（元数据治理图的体检读面）、
  map [#125](https://github.com/McKenzieIT/semantic-grounding/issues/125)、决策票
  [#153](https://github.com/McKenzieIT/semantic-grounding/issues/153)（三轮 grilling，canonical 裁决来源）

## Context

ADR-0023 R4 定了锚点形状，列被删已裁为降级到表级锚点；节点或边的目标改名、合并、删除未定。票面三个例子经
核对（`packages/mcp/src/tools/*.ts` 29 个工具 + substrate 写路径 grep `unlink`/`rename`/`merge`）：

- **改名不存在**：`import_definitions` 只有 created / updated / skipped（`import.ts:384`），新 DDL 进来是**新建**
  `dws_b`，`dws_a` 原样保留 —— 锚在 `dws_a` 上的 memory 不悬空，只是目标过时（元数据治理问题）。
- **concept 合并、节点删除均无工具**：节点消失的唯一途径是 git 里手工删改 YAML，不经任何 SG 写路径。
- **边消失有三条工具路径**：`remove_relation`；`update_definition` 改 `domains`；`import_definitions` 对表整份
  覆盖时 `dimension_refs` 少了一条。
- `DefinitionNotFoundError` 经 `isError` 结果把完整 JSON（含 data）作文本交给 agent（`errors.ts:553-582`）。

故「跟随迁移」无事件可跟、「拒绝删除」无工具可拦（git 手工删除也拦不住）。

## Decision

| # | 维度 | 裁决 | 关闭的取舍 |
|---|---|---|---|
| R1 | 原则 | memory 文件**永不因目标变化而改写**，也**不阻止**目标删除。**悬空**（锚点目标在当前图中不存在）在读时现算、不落盘：目标被加回来即自动恢复 | 跟随迁移（无改名事件；与 ADR-0023 R2 只追加冲突）；拒绝删除（无删除工具可拦，git 手工删拦不住；memory 无权否决事实层修正）；悬空落盘（加回后要补写） |
| R2 | 边悬空 | 照常出现在两端节点 `get_definition` 的 `edge_memories`，带 `relation_missing: true`，照常占预算与排序（ADR-0024 R4）；`get_join_path` / `get_relations` 因边已不在而自然不展示。一端节点也消失时挂在存活一端 | 随边一起不可见（join 删了坑点也没了）；在关系工具里展示已删的边（等于继续推荐它） |
| R3 | 节点悬空 | `get_definition` 对已不存在的 id 照常 `definition_not_found`（错误码与语义不变），错误 data 附 `orphaned_memories`（可见性 / 预算 / 排序沿用 ADR-0024 R3/R4），每条 `definition_missing: true`；message 加一句「该定义已不存在，仍有 N 条 memory 锚在它上面」。`search_definitions` 不为不存在的定义出 hit | 改为成功响应（破既有错误契约）；新开悬空列表工具（元数据治理图的体检读面，map #125 Out of scope） |
| R4 | 多锚点 | 任一锚点可解析即在该处正常展示，悬空锚点各自带标记 | 任一锚点悬空即整条降级 |
| R5 | 删除时回执 | `remove_relation` 每条被删边的结果、`update_definition` 改掉 `domains`、`import_definitions` 覆盖丢掉 `dimension_refs` 的条目结果附 `dangling_memories: N`（N = 0 时键缺省）。只提醒不拦截；git 手工删除无此提醒 | 不提醒（删边者不知经验将失去落点）；拦截（违 R1） |
| R6 | supersede 悬空条目 | 新条目 `supersedes` 可引用任意已有 id，**不检查被引条目的锚点是否存在**；新条目自身锚点仍按 ADR-0023 R4 必须存在。改名的表达即：锚在新目标上的 practice supersede 旧目标上的条目 | 新条目可继承被取代条目的悬空锚点（给 R4 开例外，只服务「撤回无活目标的 memory」—— Followup 归元数据治理图） |

## Consequences

- 读面（#154）新增：`edge_memories` 的边存在性检查与 `relation_missing`；not-found 路径查锚点索引附
  `orphaned_memories`。均复用 ADR-0023 R1 常驻锚点索引。
- 写面（#152 / 既有写工具）新增：`record_memory` 的 supersede 不校验被引条目锚点；三处删边回执附
  `dangling_memories`。
- 「全库悬空 memory 体检与修复」「撤回无活目标的 memory」仍归元数据治理图。
- 改名 / 合并若将来开了工具，届时再议是否在其回执中提示 R6 的 supersede 写法；不预先设计。

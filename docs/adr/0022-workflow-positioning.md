# ADR-0022: SG 在四类工作流中的定位 —— 导航索引不存制品、证据代替角色、按工作流拆图

- **Status**: accepted
- **Date**: 2026-10-14
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0019（R1 服务端不碰 ODPS —— 本 ADR R2 推广为不连任何数据引擎）、ADR-0018
  （R1 无在线第二方 —— R5 不设角色的根据）、ADR-0021（memory 层与晋升证据 —— R5 以证据代替身份、
  R3 SQL 快照归 memory）、ADR-0012（`derived_from` 边 —— R3 血缘载体）、map
  [#125](https://github.com/McKenzieIT/semantic-grounding/issues/125)、决策票
  [#131](https://github.com/McKenzieIT/semantic-grounding/issues/131)（六轮 grilling，canonical
  裁决来源）、前件 [#126](https://github.com/McKenzieIT/semantic-grounding/issues/126)（竞品定位）/
  [#127](https://github.com/McKenzieIT/semantic-grounding/issues/127) /
  [#128](https://github.com/McKenzieIT/semantic-grounding/issues/128)（九张场景卡，P2「治理侧是经验库」）

## Context

#128 确认用户日常的「数据治理」是 ETL 运维（查倾斜、查产出），SG 在其中只记结论。#131 讨论中
用户指出另有一类治理——SG 自身定义的健康（悬空 `domains`、114 张伪确认、X63 61 张 `kind` 停在
导入默认值、`partition_keys` 写在 schema 外、`_df`/`_di` 约定抄十几份）——同样需要，且不能被「改名/
删除」一项涵盖。另：用户 ETL SQL 存在 DataWorks，但 SG 不应绑定任何调度平台；本机 DataWorks 读
代码通路当前未授权（`~/.dataworks/.env` 无 token，2026-10-14 实测）。真实载体 X63 的事实层污染远轻
于 k11（表 1/61、事件 14/110 带实测/推断文字，2026-10-14 实测），`derived_from` 边为 0。

## Decision

| # | 维度 | 裁决 | 关闭的取舍 |
|---|---|---|---|
| R1 | 四类定位 | **工程** = 带坑位标注的数据字典（caveat/observation 挂在定义上）· **分析** = 口径仲裁者（同一问题两次同一个数，载体为已验证查询）· **元数据治理** = SG **自身作检查器**（被检对象是 corpus，只有 SG 看得到其内部结构）· **数据治理（ETL 运维）** = 值班日志 + 血缘地图（被检对象是数仓数据，agent 在外部检查，SG 只记结论与波及面） | 三类定位（漏元数据治理）；治理 = 「审计底座」（git 审计是四类共用底座，不是某类工作流的价值） |
| R2 | 共同不碰 | 不连任何数据引擎（ODPS / MySQL / …）· 不执行 SQL · 不调度、不告警（SG 不知道「现在」该产出什么，事故由 agent 发现后写入）· 不解析字段级血缘 | 仅「不碰 ODPS」（平台专属表述） |
| R3 | 血缘与 ETL | SG 存**导航索引**、不存**权威制品**：表级血缘进事实层（复用 `derived_from`，证据 = ADR-0021 R6 ① source，trailer 写 code reference + 当时 SQL 哈希）；加工摘要（粒度 / 去重口径 / 主要过滤 / 调度频率）+ **不透明 code reference** `{system, locator}` 作事实字段，SG 只存不解引用、不绑定任何平台；**SQL 原文永不进事实层**；权威源读不到时 SQL 可作**证据快照挂 memory**（observation，带抓取时间与哈希）；字段级血缘 → Followup | 存 SQL 原文（副本必漂移，ETL 每改一次即改指纹，重演 E1 污染；治理最怕拿旧逻辑查新问题）；连表级血缘也押后（G3′「上游缺数波及谁」无从回答） |
| R4 | 优先级 | **分析 → 工程 → 元数据治理 → 数据治理（ETL 运维）**——用户裁决（痛点排序：「两次问数对不上」最痛）；主会话原推荐治理先行（零落点、日常真实积累），被此输入改判。元数据治理先于 ETL 运维：memory 一旦锚定，悬空随写入量增长 | 治理先行（主会话推荐，被用户否） |
| R5 | 权限与审计 | **不引入角色、不设审批人**：任何带 `SG_AGENT_ID` 的 agent 可写，可信度由 ADR-0021 R6 证据类型承担（跑批自确认不是证据，故 114 张伪确认式的病无需角色来治）；审计 = git log + trailer（人读）；agent 侧审计读工具（`get_history`）→ Followup；角色 / ACL → Out of scope（多人共用 scope 时重画 destination） | 角色分权（单人 + 多 agent 现状下只会挡住用户自己） |
| R6 | 拆图 | map #125 收缩为：四类定位 + ADR-0021 共用原语落地（存储形状 / 读面挂载 / 晋升守卫）+ 分析首切片（已验证查询）+ 以 A3 为主线的接力实测。四类工作流的深度工作**各开专属 map**，按 R4 顺序开 | 一张图装四类（验收形态各异，一个接力剧本验不完）；共用原语也拆出（四图互等） |

## 与竞品的差异

通用 memory 产品只有 memory 层且不懂数仓对象；data agent 产品只有策展事实层、晋升预设在线审批人
（#126）。SG = 两层都有、memory 按身份锚定数仓定义、agent 凭证据自晋升——故能挂在既有读结果上，
不依赖 agent 自觉召回。

## Consequences

- 已验证查询成为第一个新事实形状，归决策票「已验证查询的形状与晋升」。
- KG 缺口「多跳」不再冷：表级血缘落地后 ETL 运维需要它，但随数据治理图排在最后。
- 元数据治理图的种子问题：悬空引用 · 伪确认 · draft 不可发现 · 字段停在导入默认值 · 写错位置
  （`partition_keys` vs `partitions`）· 事实重复（命名约定归宿）· 锚点目标改名/删除。
- 本机 DataWorks 读代码通路未授权不阻塞任何裁决：code reference 在源不可读时仍成立，SQL 走 memory 快照。

# ADR-0023: memory 存储形状与统一节点 id —— 一条一文件只追加、`<kind>:<名>` 锚点、三休眠槽退役

- **Status**: accepted
- **Date**: 2026-10-14
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0021（本 ADR 是其 R2–R4/R6/R8/R9 的物理落地；R6 核验依据由本 ADR R5 修订）、
  ADR-0005（provenance 在 commit —— R5 为何对 memory 不适用）、ADR-0010 R5（同目标批量一次 commit、
  回执即教学回路 —— R9 的先例）、ADR-0015（read epoch 每次调用重读 —— R1 增量缓存的约束来源）、
  ADR-0017（S1 公共面收窄 —— R3 **不**与之冲突，见被否掉的路）、ADR-0022 R3（表级血缘 ——
  R8 `supersedes` 槽的归宿）、map [#125](https://github.com/McKenzieIT/semantic-grounding/issues/125)、
  决策票 [#134](https://github.com/McKenzieIT/semantic-grounding/issues/134)（九轮 grilling，canonical
  裁决来源）、#132（顶层 `oneOf` inputSchema 被 Claude Code 类宿主静默丢弃 —— R9 形状约束）

## Context

ADR-0021 定了 memory 是独立存储、不是 definition、不进指纹、必须进 git、按身份单向锚定 ≥1 个定义或
边、五类型。没定它物理上长什么样。四个前提经本票实测：

- **文件打开是成本大头**（本机 Mac，js-yaml）：5000 条一条一文件全量读+建锚点索引 941 ms、20000 条
  4330 ms；同样 5000 条合成单文件仅解析 32 ms；5000 次 `stat` 16 ms。今天每次工具调用都按 ADR-0015
  重读语料（k11 786 定义已 375 ms/次）。
- **节点 id 不统一**：concept 带 `concept:` 前缀，table/event 裸名（`kinds/*-kind.ts`），`registry.ts:36-40`
  注明不同 kind 可同名；边无 id，join 以 `dim_table` 为键（ADR-0010 否决粒度），同对表可有多条备选 FK 路径。
- **统一 id 的改造量**（临时 worktree 实测，已删）：3 个 kind 插件各 2–3 行；substrate 12/450、mcp 7/448
  测试失败，均为裸名断言或「工具按裸名找节点」的真实适配点；**语料 YAML 零迁移**（`dim_table` 等字段
  带类型，前缀由插件建图时拼）。
- **三休眠槽**：X63 171 个定义 `confirmation` 全为物化默认值 `draft`/空、`coverage.limitations` 全空、
  `supersedes` 61 张全 `[]`；k11 443 `analyst_confirmed`（跑批自填）、153 条非空 limitations、22 张非空
  supersedes（内容为「替代了某手写查询」= 加工来源）；生产代码零消费。schema 均 `.loose()`。

## Decision

| # | 维度 | 裁决 | 关闭的取舍 |
|---|---|---|---|
| R1 | 落点与粒度 | 语料根 `memory/<id>.yaml`，**一条一文件**，与 `tables/` `events/` `concepts/` 并列。**进程内增量缓存为必须项**：常驻锚点索引，每次调用只 `stat`、只重解析变过的文件（仍能看到别的进程新写入，不破 ADR-0015）。一次写调用一个 commit，可批量 | 按锚点聚合（多锚点要么重复要么选主锚点，并发会话撞同一文件）；按会话分片（单条维护要改共享文件）；无缓存（数千条时每次调用 +1 s） |
| R2 | 只追加 | memory 文件写成后**不改**；更新一律是**新条目** `supersedes: [{id, reason}]`，`reason ∈ outdated │ wrong`。outdated：旧条目有效期止于新条目 `valid_from`，查询时间窗覆盖旧段时仍展示（跨季度对比时旧季度用旧口径）；wrong：所有读面永久隐藏、复现守卫不计。改错别字亦走 wrong。硬删只用于泄露敏感信息，人工 git，不开工具 | 原地编辑（丢旧口径，跨期对比算错；并发冲突；审计靠翻 git）；supersede 不分原因（错误在跨期查询里冒出，或过时与错误一起藏） |
| R3 | memory id | `mem-<YYYYMMDD>-<8 位小写 base32 随机>`（日期 = 写入日 UTC，仅供人读），独占创建、撞号换号重试。业务有效期只看 `valid_*` | 自增序号（跨克隆撞号）；内容哈希（同结论异会话被合并，R6 ③ 永远凑不够）；纯 UUID（人读不出时间） |
| R4 | 节点 id 与锚点 | **图节点 id 统一为 `<kind>:<名>`**：`table:` / `event:` / `concept:` / `metric:<表>__<键>`（table 用定义 kind，不用存储 kind `dws`/`dim`）。memory 锚点直接用它：节点 `table:x`；**列片段** `table:x#col` / `event:x#param`（索引上仍算锚在父定义，列只作就近展示与排序依据；列被删 → 降级为表级锚点并标「列已不存在」，不丢）；**边** `<起点id> -<类型>-> <终点id>`，按逻辑方向认身份（与存在哪个文件无关），同对节点多条备选路径合为一个锚点、键细节进正文；边不带列片段。写入时锚点（含列）必须存在，否则拒写。接收 id 的工具入参兼容裸名与前缀，输出一律带前缀 | 只在 memory 层定义写法、图不动（每个写 memory 的 agent 永久承担裸名↔前缀翻译，写错即拒）；列升为图节点（超出本图 destination）；边写成结构化对象（字符串∪对象嵌套联合在宿主上未验证） |
| R5 | 来源信息 | 服务端创建时写 `recorded: {session, agent, at}` 进 memory YAML，agent 不可自填；commit trailer 照写。复现守卫与读面都读 `recorded`。**修订 ADR-0021 R6**：「服务端按 `X-SG-Session` 核验」→「按 memory 的 `recorded.session` 核验」 | 只在 trailer（substrate 零 git 依赖，读面看不到；squash 合并多会话 trailer 使计数失真）。ADR-0005 的理由（改指纹、堆满定义）对不可改、无指纹的 memory 不成立 |
| R6 | 晋升回指 | R2 的**唯一例外**：晋升写入时服务端在同一 commit 往被引用 memory **追加** `promoted: [{to: <锚点id>, at, session}]`；只追加、只由服务端写。`to` 只到对象身份不到字段（ADR-0021 R3）。读面见 `promoted` 折叠，默认不占预算 | 只在 trailer（读面看不到，squash 丢失）；不记（重复展示；wrong 撤回时找不到已晋升的事实） |
| R7 | 条目字段 | `id` · `type` · `anchors[≥1]` · `body`（自由文本）· `basis` · `valid_from` · `valid_until` · `supersedes` · `recorded` · `promoted`。`valid_*` = **业务时间**（这句话对数据世界哪段时间成立，ds 粒度），非写入时间。按类型：**incident** from+until 必填（闭区间），未结束的写当前估计、续期用 outdated supersede；**observation** from+until 必填（测量窗）；**practice** 只可填 from、`basis` 必填；**inference** `basis` 必填、不填 `valid_*`；**caveat** 不填 `valid_*`。结束一条只有一种机制（incident/observation 靠 until，其余靠 supersede）。写入时校验，缺字段拒写并指明 | 全可选（回到 k11 日期混进正文）；practice 可写 until（两套结束机制）；未结束 incident 可不填 until（忘关即永远展示） |
| R8 | 三休眠槽 | `confirmation` / `coverage` / `supersedes` **全部退役**：从 table/event schema 删、不再物化默认值。职能归宿：确认 → trailer `X-SG-Evidence` + 已验证查询自带 `verified_by/at`；limitations → caveat memory（ADR-0021 R8）；supersedes → 表级血缘 + 加工摘要（ADR-0022 R3，ETL 运维图）。**X63 一次显式清理 commit**（全默认空值，零损失；commit 主题注明，免 ADR-0018 批量更新守卫误读为定义更新）；**k11 非空旧内容不动**，靠 loose 透传保留，待工程图「存量污染迁移」 | 改作 memory 载体留在定义 YAML（违 ADR-0021 R2/R4，改指纹）；保留（「全是 draft」零信息量却让 agent 以为不可信 —— #129 B 已在复述它；与 caveat 形成两个落点） |
| R9 | 写工具 | 单工具 `record_memory({memories: [{type, anchors, body, basis?, valid_from?, valid_until?, supersedes?}], summary?})`：**顶层 object、运行时按 `type` 分派**（#132；防回潮断言已在门禁）。整批原子，任一条不合法整批拒写并指明第几条；**无 `expected_version`**（只新建、无指纹）。supersede 是新条目字段，不单开工具。**写时对账**：确定性 NOOP 仅当「同会话 + 同类型 + 锚点集相同 + 正文归一后相同」（回执 `idempotent`），跨会话相同内容一律新建（那是复现证据）；回执附**邻居**——同锚点同类型仍有效的已有条目（id + 摘要）+「若为更新请 supersedes 引用」。晋升不在此工具（#136），读工具归 #135 | 服务端不分会话按内容去重（吞复现证据）；`supersede_memory` 另开（多一种出错方式）；服务端 LLM 判语义重复（#126 不借鉴） |

## Consequences

- 三张剧本种子卡 E3 / A3 / G3′ 试装通过（#134 resolution），无残余需塞进正文。
- 试装暴露：E3 的晋升目标是**列别名**，但列今天无 `alt_labels` —— 归 #136 / #138。
- 锚点目标被改名/删除（节点或边，非列）时 memory 的最低行为未定 —— 本 ADR 定了 id 形状，该问题已可
  精确陈述，graduate 为决策票。
- 读面（#135）新增输入：列片段就近展示、`promoted` 折叠、outdated 与 wrong 展示规则不同、按查询时间窗
  判 incident/observation/outdated 的可见性。
- Followup：R1 的增量缓存同样可用于定义加载（今天 375 ms/次），不在本图。

## 被否掉的路（记录免重探）

- **「统一节点 id 与 S1 收窄方向冲突」**：本票 Q3 首轮的论据，**撤回**。S1 / ADR-0017 是不再为外部宿主
  加宽 substrate 公共面；改插件内部的 id 铸造规则不新增导出、不服务外部宿主，与之无关。
- **「统一 id 需要语料迁移」**：实测零 YAML 迁移。

## Update 2026-10-15（ADR-0025 / #138）

- **R8「确认 → 已验证查询自带 `verified_by/at`」作废**：ADR-0025 R4 裁定 `query` YAML 不设 `verified_by/at`——
  是 `query` 节点本身即「已验证」的声明，谁、何时、凭什么由晋升 commit（作者 + `X-SG-Evidence` / `X-SG-Session` /
  `X-SG-Memory`）回答。确认的归宿收窄为 trailer `X-SG-Evidence`。

## Update 2026-10-15（ADR-0026 / #153）

- Consequences 中「锚点目标被改名/删除（节点或边）时 memory 的最低行为未定」已由 ADR-0026 裁定：memory 不迁移、
  不拦截删除，悬空读时现算（R4 的列删降级推广到节点与边）。R4「写入时锚点必须存在」不变；R9 的 `supersedes`
  不校验被引条目的锚点是否仍存在。

## Update 2026-10-15（ADR-0027 / #158）

- **R7 条目字段 +`contradicts: [mem-id…]`**（可选）：与本条结论相反、仍有效、未裁决的已有条目；校验被引 id 存在、
  非 wrong、非自身、不与 `supersedes` 重叠，不校验锚点重叠。以 `wrong` 取代一条有争议条目时 `basis` 必填。
- **R9 回执邻居附逐例判断指引**，`record_memory` 工具描述承载判断树主干（规程单一来源）；服务端仍不做语义判断。

## Update 2026-10-16（#136 落地——R6 批量晋升的 `to` 语义）

R6 裁了 `promoted: [{to, at, session}]` 的形状与「同一 commit、只由服务端追加」，未裁**一次晋升写多个目标**时 `to`
怎么取。落地取最小合理语义：**每个「落地或被确认」的事实层对象各追加一条**——

- `import_definitions`：非 `error` 的行（created / updated / skipped——三者都确认了该对象承载此结论；error 行
  命名的对象从未诞生，不追加）；
- 四个单目标工具（create/update_definition、add_alias）：subject 的规范节点 id，不论该写的行是否幂等
  （对象身份与晋升主张都为真）；`add_relation`：每条输入 relation 的规范边串（`<起点> -<类型>-> <终点>`，
  与 remove_relation 悬空计数同一次派生）。

配套两则：被引但 wrong 不计的条目**不追加**（它没参与计数）；追加经 `writeMemoryYaml` 的审计 seam 落在晋升
自身的 `beginBatch` commit 内（与 R6「同一 commit」的实现面）。

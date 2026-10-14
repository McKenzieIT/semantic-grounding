# ADR-0020: agent 探索草稿的家 —— worktree 外 `<gitDir>/sg-scratch/` + server 确定性 GC + `acquire_scratch_dir`

- **Status**: accepted
- **Date**: 2026-10-14
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0004（裁决 6 的两道 clean-worktree 门 —— 启动 `posture.ts` 与每写
  `recorder.ts`，本 ADR 的存在理由）、ADR-0011（scope 生命周期与绑定；裁决 3 锁死的四 flag
  CLI 面 —— R3 的 retention 旋钮走 `ServerConfig` 不开 flag 的根据）、ADR-0005（工具面;
  Tier-1 suggestion 四件套的「非审计变更」先例 —— R4 的根据）、ADR-0013（`import_definitions`
  —— 探索产物的写回之门）、ADR-0019（姊妹篇：其「被动漂移发现」词条前向引用本家的
  `<gitDir>/sg-scratch/`，本 ADR 兑现该引用）、map
  [#89](https://github.com/McKenzieIT/semantic-grounding/issues/89)、决策票
  [#92](https://github.com/McKenzieIT/semantic-grounding/issues/92)（canonical 裁决来源，
  含点解 vs 统一 work-area 的根决策）、执行票
  [#101](https://github.com/McKenzieIT/semantic-grounding/issues/101)、调研前件
  [#90](https://github.com/McKenzieIT/semantic-grounding/issues/90)（缺口 (a) 的 file:line
  证据：两道门 + 探索草稿无 worktree 外落点 + agent-in-bash 根因）、
  [#91](https://github.com/McKenzieIT/semantic-grounding/issues/91)（竞品 prior-art：数据目录
  系不存 scratch、语义层 as code 用分支+PR）
- **编号勘误**: #101 票面写「ADR-0017」；charting 时 0017–0019 尚空，后经 map #88（0017）、
  #93（0018）、#94（0019）占用，本 ADR 顺延为 **0020**。

## Context

map #89 缺口 (a)：agent 的探索/草稿工作（ODPS re-probe 的 SQL 产物、起草中的 YAML、笔记）
没有指定的家。#90 以 file:line 钉死现状：**两道** clean-worktree 门（启动
`posture.ts:210-227` 与每写 `recorder.ts:592`，untracked 文件同样计脏 `posture.ts:172-178`），
探索草稿无任何 worktree 外落点，而「探索→写回」的主路把 infra 划给 agent-in-bash
（`scope.ts:88`）。agent 往 corpus worktree 里随手一放，下一次 Tier-2 写就被
`PostureRefusedError` 拒掉 —— 服务器把 agent 自己的草稿误认成操作员的未提交编辑。

#91 的竞品结论：数据目录系（DataHub/OpenMetadata/Atlan）**不存 scratch**；语义层 as code
（dbt/Cube/Looker）用**分支+PR**。但分支不免门：未跟踪草稿在任何 branch 上都让
`git status --porcelain` 变脏 —— branch 的价值在「提案变更的 staging/评审」（#93 已另裁），
与 scratch 正交。

## Decision

### R1 · 位置：worktree 外 `<gitDir>/sg-scratch/<run-id>/`

与 `<gitDir>/sg-pending/`、`sg-write.lock` 同族（`tools/shared.ts#pendingQueueRoot` 的放置
论证全文适用）：git dir 在 git 追踪的树**之外**，落在里面的文件对 `git status --porcelain`
不可见 —— 对两道门**构造性免疫**，不依赖 `.gitignore` 完备、不惧 `clean -fdx`。

否决 **in-worktree `.gitignore` 隐形区**：只挡已知忽略模式，agent 往 corpus 根随手写仍污染、
仍触门。否决 **branch/worktree-per-cycle 作为 scratch 方案**：见 Context —— 分支不免门。

### R2 · 生命周期：server 确定性 GC，不靠 agent 自觉

#92 根裁决：清理归 server，否则 seam 只是把污染搬了个家。每次调用 `acquire_scratch_dir`
创建一个 run 子目录（一次探索的收集单位，并发探索者的隔离单位），**同一调用内**把 home
修剪到最新 N 个（含刚创建者）。参数与细节：

- **N 默认 3**，落 `ServerConfig.scratchRunsToKeep`（无 flag/env —— ADR-0011 裁决 3 锁死
  CLI 四 flag，`guidanceThreshold` 同款先例：旋钮为测试与嵌入宿主而存在）。
- **排序按 mtime，非名字**：同秒创建的 run id 仅差随机 nonce，字典序≠先后序；mtime 还使
  「agent 仍在写入的旧 run」持续顶新 —— GC 退休**最久未触碰**者，保护在途探索于出生序之上。
- **当前 run 永不进自己 acquire 的修剪候选**：时钟偏斜造出的未来 mtime 不得当场回收刚发给
  agent 的目录。
- **只删认得的**：仅名字匹配 run-id 格式（`YYYYMMDDTHHMMSSZ_<6hex>`）的目录进候选，
  操作员/他工具放进 home 的任何东西不碰（`isValidId` 过滤哲学）。
- **删除 best-effort**：文件被占用（Windows 常见）删不掉就留给下一次 acquire 重试 ——
  每次 acquire 都重新修剪，有界性不因单次失败破。
- **无 TTL**：prune-on-acquire 下 run 只在有人探索时增长，「保留最近 N 次探索」即完整故事。

### R3 · 交付：第 29 个工具 `acquire_scratch_dir`（零参）

#92 把「scaffold `next_steps` 输出 vs 专门 tool」留给执行票。裁**专门工具**，否决
scaffold：scaffold 是注册**前**的纯知识工具（不知 gitDir、零副作用），而探索发生在**已绑定**
scope 上且反复发生（map Notes：反复的探索→更新是主路）—— 交付面与生命周期不匹配。工具
形状：

- 零入参（`z.object({}).strict()`）；响应 `{scope, run_id, path, retention: {keeps_last,
  pruned_run_ids}}`；每次调用 = 新 run（忘了路径就再取一个，GC 兜底；并发探索者天然隔离）。
- 落地序实录：#105 已裁的 `list_definitions`（第 28 个，`#112`）先于本票合入，故
  `acquire_scratch_dir` 为第 **29** 个工具，catalog 28→**29**（减速带断言随改）——两票并行
  落地，工具序号由合入序决定，非裁决内容。
- 工具族描述符双面（`TOOL_NAMES` / `TOOL_REGISTRARS`）各一处接入，家族名
  `SCRATCH_TOOL_NAMES`。

### R4 · 非审计变更：Tier-1 同款姿态

不 commit、不取 corpus 锁、不走 recorder 写路径 —— 从 recorder 只借 gitDir 路径解析
（`pendingQueueRoot` 同款，read-only 工具亦可安全调用）。响应仍带 scope stamp
（ADR-0011 的自描述层）：跨 switch 迟到的响应仍能说清自己服务的是哪个 scope。

### R5 · substrate 零改动

seam 全部住在 mcp 包（`tools/scratch.ts`：seam + 工具；`config.ts`：retention 旋钮）。
「勿反向加宽」substrate 公共面（map Notes / S1 方向）：不新增 barrel 导出、不动 io 层。

## Consequences

- 探索→写回主路（#94 被动漂移发现的第一步「re-probe 进草稿家」）有了指定落点；
  ADR-0019 词条的前向引用兑现。
- 工具面 28→29（#112 的 `list_definitions` 先行落地为第 28）：catalog / server-startup
  两 spec 计数与散文随改；e2e 新增一步
  「探索→写回」（acquire → 放垃圾 → porcelain 仍净 → Tier-2 写仍落），21→22 步。
  README 的工具数契约行本已滞后（写 26、#112 后实 28），归 C3 清理票直接改到终值（本票后
  29）。
- `pending.ts` 头注的 `var/` 文档漂移（#90 surfaced，票面顺手项）随本票修正为
  `<gitDir>/sg-pending/`。
- GC 退休的是「最久未触碰」的 run：agent 若需长存归档，须在探索结束当下自行把产物写回
  corpus（Tier-2）或带走 —— scratch 的契约就是易逝。

## Verification

- `tests/scratch.spec.ts`：放置（`<gitDir>/sg-scratch/<run_id>` 精确路径 + id 格式）、
  非审计（commit 数不变）、门外免疫（junk 后 `git status --porcelain` 空 + Tier-2 写仍
  `changed: true`）、GC 有界（保 3 修剪报告精确）、mtime 序（老而活跃压过新而闲置）、
  当前 run 免回收（未来 mtime 兄弟在场）、旋钮（`scratchRunsToKeep: 1`）、不识者不删、
  同秒 nonce 唯一。
- `tests/intent-tools-catalog.spec.ts`：28 名对账 + scratch 工具 schema/描述断言。
- e2e step 3（探索→写回全环）。四门禁 + catalog 28 + barrel 27 恒定。

## References

- 决策票 #92 resolution（canonical：位置/GC/点解三裁决 + 根决策「点解 vs 统一 work-area」）
- 执行票 #101 resolution（微裁决记录：mtime 序、当前 run 免回收、未来 mtime 时钟偏斜形状）
- `packages/mcp/src/tools/scratch.ts`（seam + 工具，模块头注释承载设计意图）

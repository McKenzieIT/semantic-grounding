# ADR-0018: 批量纳入的评审面 —— dry-run 预检 + 覆盖守卫（无在线第二方）

- **Status**: accepted
- **Date**: 2026-10-13
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0013（批量导入七裁决；本 ADR 给 `import_definitions` 补「成为
  source-of-truth 前」的评审面，其 Phase 1 裁决通道即预检的复用点）、ADR-0004（裁决 6
  clean-worktree 两道门 + author=agent / committer=server 身份模型；本 ADR「无在线第二方 +
  事后 `git log` 审计」直接继承）、ADR-0005（工具面契约；dry-run 作 flag 而非新工具 =
  不扩 tools/list，R2 的依据）、ADR-0012（R5 provenance 四原则；R7 不改它）、ADR-0014
  （`_guidance` 五阶段注入；预检只读分支不注入）、map
  [#89](https://github.com/McKenzieIT/semantic-grounding/issues/89)、决策票
  [#93](https://github.com/McKenzieIT/semantic-grounding/issues/93)（canonical 设计来源，
  三轮 grilling）、执行票
  [#104](https://github.com/McKenzieIT/semantic-grounding/issues/104)、姊妹决策票
  [#94](https://github.com/McKenzieIT/semantic-grounding/issues/94)（ODPS 漂移再同步——
  占比阈值守卫划归此票）、调研前件
  [#90](https://github.com/McKenzieIT/semantic-grounding/issues/90)（三缺口 file:line）、
  [#91](https://github.com/McKenzieIT/semantic-grounding/issues/91)（竞品 prior-art）

## Context

map #89 缺口 (b)：`import_definitions`（ADR-0013）单 commit 批量落盘，校验仅「schema 合法 +
批内不重名」，**成为 source-of-truth 前无任何评审门**。#90 实测：k11 冷启动 786 YAML /
1–2 commit 一次性落地，事后无评审面。#91 竞品三类治理：语义层 as code（dbt/Cube/Looker）用
分支+PR（Looker Dev/Prod 最干净）；数据目录（DataHub/OpenMetadata/Atlan）用软发布态
（Draft/Verified）+ 提案审批（DataHub 写原语 = MCP = Metadata Change Proposal）；KG
（TerminusDB）用 git-for-data diff/merge。#92 已裁「探索草稿点解落 worktree 外」，并把
**branch-staging 作为本票一等候选**移交 #93。

几项既定前提收窄了解空间（#93 三轮 grilling 逐一验证）：

1. **无在线人**（ADR-0004 + map #12）：author=agent / committer=server；工具调用时没有在线
   的第二方可同步审批，人**事后**读 `git log -p --follow` 审计。任何「commit 前在线评审」都
   要先造一个本模型里不存在的在线角色。
2. **Phase 1 裁决通道已存在**（`import.ts` ~224–267 的裁决段）：Phase 1 是**零写**纯裁决——
   逐项 `safeParse` + 跨 kind 重名 `Set` + 存在性读 → 分流 `created|updated|skipped|error`
   （verdict 联合见 `import.ts:108`，存在性判定 `import.ts:260`），产出 `results` 行 +
   `staged`；**之后**才进 `auditedWrite` 开审计窗（`import.ts:273`）。预检 =「跑完 Phase 1
   即返回」，复用率 100%。
3. **`.max(500)` 硬帽子已在**（`import.ts:94`）：runaway loop 的 blast radius 已被 cap 挡住；
   评审面要防的不是「失控条数」，是「覆盖了多少既有 source-of-truth」。
4. **方向前提（#79）**：MCP 单宿主、独立发展、substrate 公共面只收窄不加宽——评审面全部落
   `packages/mcp`（`config.ts` 的 `ServerConfig` + `import.ts`），不碰 substrate 公共面。

## Decision

评审面 = **dry-run 预检 + 按 `updated` 计的覆盖守卫 + 事后 git 审计**，**无 commit 前在线第二方**。

| # | 维度 | 裁决 |
|---|---|---|
| R1 | 无在线第二方 | 不引入 commit 前的在线审批人 / 提案箱。评审 role 由三者分担：① agent 自看预检输出；② 服务端确定性守卫；③ 人事后读 `git log`。继承 ADR-0004 身份模型，不新造在线角色。否决 #91 的「角色评审提案箱」（DataHub MCP 式）——它预设在线审批方，本模型没有。 |
| R2 | dry-run = `import_definitions` 的 flag | 加 `dry_run?: boolean`（default false）。为真时跑完 Phase 1 返回 verdict，**在开 `auditedWrite` 审计窗之前早返回**——不开窗、不 commit、不注入 `_guidance`（只读分支）。否决独立 `preview_import` 工具：Phase 1 是裁决的单一来源，flag 零复制地暴露它（预检「近乎免费」的全部理由），独立工具要么抄 Phase 1（漂移风险）要么为不漂移先抽 seam（比 flag 重）；且不扩 tools/list（ADR-0005 面克制）。「写工具有时不写」的别扭用「预检在开窗前早返回、文档标明只读分支」收。 |
| R3 | 守卫按 `updated` 桶计，不按总数 / `created` | 危险的不是「条数多」是「覆盖多」。冷启动几乎全 `created`（空 corpus 灌入，不毁旧物，正是 `import_definitions` 的立身之本，ADR-0013），绝不该报警；真正的 fat-finger / 漂移再同步几乎全 `updated`（既有 source-of-truth 被整文件覆写，ADR-0013 执行细则 2）。守卫键 = `updated` 计数，`created`/`skipped` 不触发。该桶 Phase 1 已算好（`import.ts:260`、`ImportSummary` 见 `import.ts:305`）。 |
| R4 | 软信号，不硬拒 | 超阈值只 (a) 响应里 WARN + (b) 给该 batch commit 打 provenance 标注（骑 `import.ts:267` 已有的 intent target 通道，该通道本就带 `(N created, M updated)` 计数）。**不**硬拒。理由：硬拒打死合法冷启动；条数硬拒被「拆成两个 400 条批」轻松绕过；本模型无在线人从 abort 获益。守卫的活不是「拦」是「把危险 commit 在 `git log` 里标亮给事后审计角色 ③ 看」。`.max(500)` 仍是防失控的硬帽子。 |
| R5 | 阈值配置 | 条数阈值（default 建议 50，实现时核）落 `packages/mcp/src/config.ts` 的 `ServerConfig`（`--mass-update-warn-threshold` / env，由 `parseServerConfig` 解析），**不碰 substrate**（#79）。 |
| R6 | 粒度 = 双层现成 | 预检回逐项 verdict（`results[]`）+ 整批 summary 计数（`ImportSummary`）；守卫作用在整批 `updated` 计。partial-apply 维持 ADR-0013 R4 现状（坏项不中断、好项照落单 commit）。不新增粒度机制。 |
| R7 | provenance 不变 | batch 级 `summary` / `derivation=agent`（ADR-0012 R5 / ADR-0013 R1）照旧；预检只读、不写、不记 provenance；守卫标注是对**真写** commit trailer 的附加，不改 provenance 四原则。 |

### 否决项（竞品候选的本仓裁决）

- **branch-staging（#92 移交的一等候选 / dbt·Looker Dev-Prod + KG git-for-data）**：否决。
  它预设「分支上评审再 merge」的在线评审节奏；本模型无在线人，且 #92 已裁「点解、不建统一
  branch work-area」——再为评审开第二 worktree / 分支与该裁决冲突。dry-run 用 Phase 1 的现成
  裁决零成本达到「成为 source-of-truth 前先看变更」的同一目的。
- **硬拒阈值守卫（DataHub `fail_safe_threshold`）**：否决为硬拒形态（见 R4）；其「大改即报警」
  的内核以**软信号 + 按 `updated` 计**保留。
- **软发布态（`confirmation.status` 复活 / DataHub Draft-Verified）**：**降为条件性 Followup**。
  现 `confirmation.status` 字段 vestigial（#90/#91 记：schema 在、无 reader / search /
  enrichment / playbook 尊重它、k11 全 corpus 为 `draft`）；复活它要造 read-path filter +
  全量 draft 迁移悬崖，为「成为 source-of-truth 前可审计」这个本票目标**并非必需**（dry-run 已
  达成）。触发条件：出现「需要机器可查的发布状态分层（如只对 Verified 定义开放某读面）」的真实
  场景再立票。

### 实现落点

- `packages/mcp/src/tools/import.ts`：`ImportInput` 加 `dry_run?: boolean`；Phase 1 后、
  `auditedWrite`（`import.ts:273`）前插早返回分支（返回 `results`/`staged`/`summary` +
  `committed:false`）。守卫：Phase 2 入口按 `summary.updated` 比阈值，超限则 WARN 入响应 + 把
  覆盖标注并入 `import.ts:267` 的 intentTarget（成为 commit trailer 的一部分）。
- `packages/mcp/src/config.ts`：`ServerConfig` 加可选阈值字段 + `parseServerConfig` 解析
  （flag / env）。
- 可发现性：`import_definitions` 的 `.describe()` + scaffold `next_steps` 提及「大批先
  `dry_run:true` 预检」——让远程 agent 发现预检（接 map #89 的 scaffold-coherence fog）。
- **不碰** substrate 公共面（#79）。

执行见 [#104](https://github.com/McKenzieIT/semantic-grounding/issues/104)。

## Consequences

- `import_definitions` 从「单 commit 直落」升为「可先 `dry_run:true` 预检、守卫对大覆盖标亮」
  的两段式；冷启动路径零摩擦（全 `created`、守卫静默）。
- tools/list 不变（flag 非新工具，ADR-0005 面克制）；`_guidance` 注入面不变（预检只读分支不注入）。
- 事后审计角色 ③（人读 `git log`）得到抓手：`grep` commit trailer 的覆盖标注即定位危险 commit
  ——正是审 786 条 draft 的人要的。
- GLOSSARY 新增 `dry-run preview (预检)`、`mass-update guard (批量覆盖守卫)` 两词。
- 可发现性读面另立 [#105](https://github.com/McKenzieIT/semantic-grounding/issues/105)：#93
  裁定评审走预检（预演**待纳入批**），**不依赖**对既有 corpus 的全量枚举，二者解耦——枚举需求
  独立成票。
- **scope 边界**：按**整个 corpus 占比**的 ratio 漂移守卫（「动了 500 表里的 60%」）**不在本票**
  ——ratio 对空 corpus 无意义（冷启动 = 100%），其主场是 corpus 已有货的 ODPS 漂移再同步，划归
  **#94**（该票本就 scope 了「阈值守卫 + schema 指纹 / 版本」）。本票只落**按 `updated` 计的
  count 守卫原语**；#94 在其上加占比策略。

## Verification（执行票 #104 的验收门，待落地补 Update）

- `dry_run:true` 跑完 Phase 1 即返回、**零 commit**（HEAD 不动）、不开审计窗、不注入
  `_guidance`；返回体含逐项 verdict + summary。
- `dry_run:true` 与同参 `dry_run:false` 的 verdict 分流**逐项一致**（预检 = 真写的忠实预演，
  单一来源不漂移）。
- 冷启动大批（全 `created`，如 300+）守卫**静默**；覆盖型批（`updated` 超阈值）WARN + commit
  trailer 带覆盖标注。
- 阈值可经 `ServerConfig` / flag / env 配置；default 行为有测试钉死。
- substrate / mcp 全量 test、e2e、双包 typecheck 不红（对标 ADR-0016 基线）。
- 不新增 tools/list 条目（catalog 断言不变）。

## Update — #104 落地（2026-10-14）

合入 main `660f80d`（集成分支复跑四门禁：typecheck 双包 0 / substrate 450 / mcp **420+1skip** /
e2e 21 步 / tools/list 27 不变）。Verification 各条全数兑现：dry 零 commit 不开窗不注入、dry vs
真写 verdict 逐项一致、冷启动 60 created 静默、51 超阈 WARN+标注而恰好 50 静默（严格 `>` 钉死）、
阈值 flag/env/default 测试钉死（0 合法、负/小数拒绝带 remedy）。执行核正三则：

1. **锚点漂移**（#108/#109 所致，语义锚成立）：`auditedWrite` 调用点与 `intentTarget` 通道行号
   较本 ADR 落稿时下移；dry_run 早返回与守卫仍精确插在「Phase 1 后、audit 窗前」「intent
   target 通道」两语义锚上。
2. **WARN 通道形状**（与 #111 集成统一）：守卫信号落响应顶层 `warnings: string[]`（零税缺席，
   恒非空数组）；dry_run 预检与真写共享同一组守卫行——预检必须精确预言真写的告警，否则预检
   不是预检。ADR-0019 R6 的占比守卫同通道并列，双守卫独立触发（51/53 场景双标注有测试钉死）。
3. **「commit trailer」措辞**：被裁机制（「骑 `import.ts` 的 intent target 通道」）实际落
   commit **subject**（`buildSubject` 的 `<tool>(<target>): <summary>` 形），subject 同样可
   `git log --grep` 命中；本 ADR 的 trailer 措辞按宽泛描述理解，机制以裁决原文的通道为准。

## References

- 决策票：[#93](https://github.com/McKenzieIT/semantic-grounding/issues/93)（三轮 grilling
  resolution：Q1 无在线第二方 / Q2 `dry_run` flag / Q3 `updated`-计软守卫）
- 执行票：[#104](https://github.com/McKenzieIT/semantic-grounding/issues/104)
- 姊妹票：[#94](https://github.com/McKenzieIT/semantic-grounding/issues/94)（占比漂移守卫归属）
- 可发现性读面：[#105](https://github.com/McKenzieIT/semantic-grounding/issues/105)
- 调研：[#90](https://github.com/McKenzieIT/semantic-grounding/issues/90)（缺口 file:line）、
  [#91](https://github.com/McKenzieIT/semantic-grounding/issues/91)（竞品 prior-art）
- map：[#89](https://github.com/McKenzieIT/semantic-grounding/issues/89)

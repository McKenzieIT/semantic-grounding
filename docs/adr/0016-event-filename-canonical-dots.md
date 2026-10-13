# ADR-0016: 事件文件名自有规范 —— 文件名 = 点名（迁移而非适配）

- **Status**: proposed（落地随实现分票转 accepted）
- **Date**: 2026-10-13
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0015（R10 写门不触碰；本 bug 由其 01-probe 发现并分票）、[源票 #79](https://github.com/McKenzieIT/semantic-grounding/issues/79)、[#74](https://github.com/McKenzieIT/semantic-grounding/issues/74)（01-probe 实测）、map [#73](https://github.com/McKenzieIT/semantic-grounding/issues/73)

## Context

源票 #79（map #73 关图分票）：`run_enrichment` 一次调用 262× 全库解析（k11 = 766 文件），99% 来自写路径 `findEventPath`（io.ts）——每写一个 event 做一次全事件库扫描（#74 探针：单次 `writeEventYaml` = 445 events 全扫）。根因：event name 点分层（`game.role.backup.rollback`），落盘 filename 下划线（`role_backup_rollback.yaml`），fast path 由 name 直推 path 的候选**永不命中**。

2026-10-13 关票会话补充验证：

- **下划线推导规律 446/446 全中**：k11 全部 446 个事件文件（不含 `_index.yaml`）符合「name 去首段（`game.`）、点换下划线 = 文件名」——这是上游 dsh writer 的落盘约定，零例外。
- **domain 目录从 name 推不出来**：`game.role.backup.rollback` 在 `account/`、`game.battle.quit` 在 `battle/`——归域是人工分类，不是 name 的函数。任何「由 name 直推完整路径」的方案都不成立，逐 domain 目录探测（k11 = 7 目录 × `existsSync`）是成本下限。
- **迁移爆炸半径实测为零**：测试代码无任何一处硬编码 k11 下划线事件文件名（`version-roundtrip` 等全为自建小语料，其名单段名 `evt_click` 本来就 fast path 命中）；读路径（`loadEvents` 全扫 + 按 `name` 字段校验）与 `_index.yaml`（按域列 name+description，不含文件路径）均文件名无关。
- **前提变更（本裁决的支点）**：semantic-grounding 独立发展，不再以 dsh 兼容为约束——语料格式主权归本 repo，dsh writer 的下划线落盘约定降级为「待迁移的遗留数据」。经裁决确认：**不存在 repo 之外、必须直读又不迁移的语料**。

## Decision

| # | 维度 | 裁决 |
|---|---|---|
| R1 | 自有规范 | **事件文件名 = 事件 `name` 本体**（点分层原样：`events/<domain>/game.role.backup.rollback.yaml`）。文件名由 name 直接推导，fast path 按设计命中而非靠运气；与 `_suggested/<name>.yaml` 新事件路径天然一致，全库自洽 |
| R2 | 迁移而非双探测 | k11 fixture 一次性 `git mv` 446 文件到位。否决「fast path 补下划线推导候选」——独立前提下它只服务「不迁移的外部旧语料」，而该语料经裁决不存在；为一份已废弃规范永久背代码不值。若未来真出现不迁移的重负载语料，再作后手切片评估 |
| R3 | 否决 name→path 缓存 | 票面候选 B，两个死因：① `writeEventYaml` 每写必 `invalidateCaches` bump → 262 连写 = 262 次缓存重建，除非再发明「写后回填」；② `findEventPath` 同时是 Tier-2 写门指纹（`definitionVersion`）的取路径方式——ADR-0015 R10 特意不碰的面上，新增缓存失效 = 把「漏失效→写错文件」的正确性风险背到写门上 |
| R4 | 兜底扫描保留 | `findEventPath` 的全库 broad-scan 原样保留：手改名文件、未迁移语料照常读写（正确性不押规范），只是慢。fast path 命中后照旧 readYaml 核对 `name` 字段（verify-on-match 语义不变） |
| R5 | name 全库唯一 | 迁移脚本断言事件 `name` 全库唯一——「文件名 = name」的前置不变量，违反即 fail loud（`version-roundtrip` 已有手改名兜底用例守 R4） |
| R6 | `findEventPath` 零改动 | 现有 fast path 候选（`events/<domain>/<name>.yaml`）即 R1 规范的探测式——迁移落地即自然命中。本 ADR 不改 io.ts 逻辑，只迁数据 |

### 实现落点

- 一次性迁移脚本：k11 fixture 446 文件 `git mv` 至点名列，断言 name 唯一（R5）
- 无 TS 逻辑改动：`findEventPath` / `loadEvents` / 写门 `definitionVersion` 全部原样

### 路径断言（钉住验收）

- 单次 `writeEventYaml` / `definitionVersion`(event) 解析次数 ≤2（fast path 命中：1 次候选 readYaml 核对 name，0 次扫描）
- `run_enrichment` 探针重测，对比 262× 基线（具体值随实现分票落测）
- `version-roundtrip` 手改名兜底用例不回归（R4）

## Consequences

- 语义层语料格式自有：事件文件名不再继承 dsh 约定；表（`tables/<name>.yaml`）与概念（`concepts/<name>.yaml`）本就「文件名 = name」，R1 使事件与之对齐
- domain 目录仍为人工分类（不可由 name 推导），fast path 逐 domain 目录探测——k11 规模（7 目录）成本可忽略
- `_index.yaml` 不受迁移影响（不含文件路径）；新事件仍落 `events/_suggested/<name>.yaml`，与 R1 一致
- 外部旧语料（若未来出现）走兜底扫描：正确、慢——触发 R2 的后手切片评估
- GLOSSARY 不动：文件名规范是格式约定，非领域术语

## Verification

- substrate 全量 `pnpm test` 不红（基线 479）
- mcp 全量 `pnpm test` 不红（基线 345 pass）
- `pnpm e2e` 不红（基线 21 步）
- typecheck 双包干净
- 路径断言（上节）随实现分票落地

## References

- 源票：[#79](https://github.com/McKenzieIT/semantic-grounding/issues/79)（2026-10-13 关票裁决：独立发展前提重排修法，M 迁移胜出）
- 实测：[#74](https://github.com/McKenzieIT/semantic-grounding/issues/74)（01-probe 度量探针，262× / 99% 证据）
- 谱系：map [#73](https://github.com/McKenzieIT/semantic-grounding/issues/73)（读 epoch，ADR-0015 五子票全解关图时分票本议题）、ADR-0015 R10（写门路径与缓存裁决的分界）
- 实现分票：见 #79 resolution（ready-for-agent）

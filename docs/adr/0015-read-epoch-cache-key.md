# ADR-0015: 读 epoch 缓存键 —— `(per-call epoch) × 进程内 corpusVersion`

- **Status**: accepted
- **Date**: 2026-10-13
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0004 裁决 8（写门指纹 `definitionVersion` 走 `readFileSync`，不经 loader —— 本裁决不触碰）、ADR-0005 裁决 6（拒绝快照句柄进 MCP 读面，MVCC 划给 dsh —— 与本裁决互补）、ADR-0006 裁决 4（`work_id` 自包含指纹，`fingerprint(raw)` 吃 loader 输出 —— 本裁决的硬约束）、ADR-0010（持久否决权，`registerInvalidationHook` 曾为 BasicIndex 而设 —— 本裁决随删）、[源票 #60](https://github.com/McKenzieIT/semantic-grounding/issues/60)、map `read-epoch`

## Context

源票 #60（Speculative 架构巡检候选 C7）报告：`run_enrichment` 一次调用 ≥10 次全库 YAML 解析（766 文件级），`loadTables`/`loadEvents` 在 substrate src 内 26 处调用位，包里两个缓存抽象一个死码一个闲置 —— 「缺的 module 已经被发明了两次半」。

2026-10-13 charting 实测三处前提证伪：

1. **ADR-0004 裁决 8 不是本图的红线**：写门指纹走 `definitionVersion`（io.ts:615）→ `readFileSync` 单文件字面字节，事件路径由 `findEventPath` 自己扫目录，全程不经 loader。
2. **真边界在另一套指纹上**：`enrichment-work.ts:149` 的 `fingerprint(raw)` 哈希 `dumpYaml(raw)`，`raw` 来自 `loadTables().find()` —— 它吃 loader 输出，是 ADR-0006 裁决 4「逐项指纹复核」的支点。故源票「正确性不受影响」对 memo 形态**不成立**：缓存键一旦漏掉一次 bump，`apply_enrichment` 的 stale 写会被放过。
3. **「两个缓存抽象一个死码一个闲置」是三个，且性质各异**：①`BasicIndex` 生产引用零，且 `index.ts:176` 已降级为 internal ②`snapshot.ts` 在 `index.d.ts` 公共面上，且 ADR-0005 裁决 6 把 MVCC 划给「dsh 执行查询的需要」 ③`corpusVersion`-keyed per-scope LRU（`getRelationGraph`）是活的，`per-scope-read.spec.ts` 实测覆盖。

charting 同时核实：

- **`concurrent-write.spec.ts` / `corpus-lock.spec.ts` 拉起独立 OS 进程抢同一份语料**（pid 文件锁串行化）。进程 A 缓存、进程 B 写，A 的进程内计数器永不 bump → 无限期供应过期语料。
- **写位形状全是 `{ ...raw, field: value }`**（7 处 spread 复制，无一处就地改 `raw`）：别名风险实测为零，但跨写整文档重写的丢写风险真实（ADR-0004 裁决 8 点名的「整字段覆盖丢别人的改动」）。
- **01-probe 实测**：`assertKnownFilterNames`（10 名）= 4.19× 全库解析、`get_enrichment_prompts`（5 项）= 2.09×、`search_definitions` = 2.03×。epoch 可把这些折到 ~1×。`run_enrichment` 262× 的 99% 是写路径 `findEventPath` bug（event name 用点、filename 用下划线，fast path 永不命中），与本图正交，另开 sibling ticket。
- **语料规模 321 表**（k11 fixture，与 ADR-0005 裁决 6 的「321 表」一致）。

## Decision

| # | 维度 | 裁决 |
|---|---|---|
| R1 | 键复合 | `(per-call epoch) × 进程内 corpusVersion`，两半各有可证的必要性（见 Context） |
| R2 | epoch 提供方式 | `AsyncLocalStorage` 环境式，substrate 内一处进入（`withReadEpoch(fn)`） |
| R3 | 未开 epoch 时行为 | `loadTables` / `loadEvents` 与今天逐字节相同（缓存纯增量开关），dsh 宿主不进入 epoch 则完全不受影响 |
| R4 | 写位形状前提 | `{ ...raw, field: value }` 展开复制是复合键成立的必要前提；写位若就地改 `raw`，epoch 共享对象会丢写 |
| R5 | 别名风险实测 | 7 处写位全部 spread，无就地改 —— memo 共享对象的最大顾虑不存在 |
| R6 | 否决 mtime 校验式跨调用缓存 | 同秒内两次写在某些文件系统上测不出，「错过一次写」的后果是丢写而非变慢 —— 拿正确性换性能，方向错 |
| R7 | 否决 `corpusVersion` 单独做键 | 进程内计数器看不见跨进程写，`concurrent-write.spec.ts` 实测 |
| R8 | 否决纯 per-call epoch | 写位之间隔写（`run_enrichment` 四管线各 4 次 `writeTable` / `writeEventYaml`），纯 per-call epoch 会让管线 N 用管线 N-1 之前的旧 `raw` 重写，静默丢写 |
| R9 | 不合并 `snapshot.ts` | snapshot 是 ADR-0005 裁决 6 背书的公共 dsh 面（MVCC），键在 `corpusVersion` 上 —— 对它自己的用例是正确的；两套缓存生命周期需求真的不同，合并会把一条正确语义拗向另一条 |
| R10 | 不触碰 ADR-0004 裁决 8 | 写门指纹走 `definitionVersion` → `readFileSync` 不经 loader，本裁决独立 |

### 实现落点

- 新建 `packages/substrate/src/read-epoch.ts`：`withReadEpoch<T>(fn: () => T): T`，使用 `AsyncLocalStorage<{ corpusVersion: number }>`
- `io.ts:311` (`loadTables`) / `io.ts:350` (`loadEvents`) 检查环境里有无开着的 epoch：有 epoch 时 `(epochKey, corpusVersion)` 复合键命中 memo 返回；无 epoch 时直读
- memo 是 io.ts 内部的 `Map<string, { version: number, data: RawTable[] | RawEvent[] }>`，keyed on `semanticLayer`
- MCP handler 入口 chokepoint（`packages/mcp/src/server.ts`）一处进入；24 个 handler 不动
- 随删 `BasicIndex`（`packages/substrate/src/basic-index.ts`，147 行）+ `registerInvalidationHook`（io.ts:156-175）+ `scenarios.spec.ts` S4 用例 + `build-shape.spec.ts:64` 反向断言 —— 公共面成本零（两者都已是 internal）

### 路径断言（test-only，钉住验收）

- `get_enrichment_work` N 项 → 解析次数 = 1（epoch 内复用）
- `get_enrichment_prompts` ≤10 项 → 解析次数 = 1
- `assertKnownFilterNames` N 名 → 解析次数 = 1（epoch 内 fold 掉 N 次谓词内全库解析）
- 单条 `get_definition` → 解析次数 = 1
- 跨 epoch（两次 `withReadEpoch` 之间）→ 解析次数 = 2（memo 不泄漏）
- epoch 内一次 `writeTable` 后，下次 `loadTables` 必须重新解析（`invalidateCaches` bump `corpusVersion` → 复合键 miss → 重解析）

## Consequences

- 26 处调用位一行不改；缓存完全内聚在 `io.ts` + `read-epoch.ts` + `server.ts` handler chokepoint
- 未开 epoch 时行为与今天逐字节相同 —— dsh 宿主、自由函数、单测都不受影响
- `run_enrichment` 的全库解析次数**不在本裁决范围**：门(1) + `assertKnownFilterNames`(N) + 四管线(4) 这些 `loadTables` 调用彼此之间都隔着写，复合键下全部 miss —— 缓存在这条路上无能为力。它是 map #64 扫管引擎的收益（四条管线折成一条，`loadTables` 自然 4→1）。
- **bump 完备性由 `auditedFileWrite` 设计保证**（02-bump-audit 实测无遗漏，`bump-completeness.spec.ts` 8 tests 全绿），不是本裁决要新增的 invariant
- **snapshot.ts 继续独立存在**：dsh MVCC 的缓存，与本裁决的 MCP 读 epoch 生命周期需求不同，不合并
- 新增 GLOSSARY 词条 `读 epoch` / `read epoch`

## Verification

- substrate 全量 `pnpm test` 不红（基线 431+，本票新增 read-epoch 断言若干）
- mcp 全量 `pnpm test` 不红（基线 310+）
- `pnpm e2e` 不红（基线 20 步）
- acceptance barrel 36 名对照过（BasicIndex 不在名单上，删除零公共面成本）
- `bump-completeness.spec.ts` 8 tests 全绿（02-bump-audit 落地）
- `read-count-probe.spec.ts` 13 tests 全绿（01-probe 落地；epoch 落地后重跑断言解析次数）
- typecheck 双包干净

## References

- 源票：[#60](https://github.com/McKenzieIT/semantic-grounding/issues/60)（C7 corpus 读上下文，Speculative——已随图关闭）
- 地图：[#73](https://github.com/McKenzieIT/semantic-grounding/issues/73)（2026-10-13 自本地 `.scratch/` 迁入 GitHub issues，五子票全解关图）
- 子票：[#74](https://github.com/McKenzieIT/semantic-grounding/issues/74)（01-probe 度量探针）、[#75](https://github.com/McKenzieIT/semantic-grounding/issues/75)（02-bump-audit bump 完备性审计）、[#76](https://github.com/McKenzieIT/semantic-grounding/issues/76)（03-adr-0015 本 ADR）、[#77](https://github.com/McKenzieIT/semantic-grounding/issues/77)（04-epoch-impl 实现）、[#78](https://github.com/McKenzieIT/semantic-grounding/issues/78)（05-cleanup 删 BasicIndex，关图票）
- 关联 map：[#64](https://github.com/McKenzieIT/semantic-grounding/issues/64)（扫管引擎，与本图完全正交、可并行）
- 代码落点（预期）：`packages/substrate/src/read-epoch.ts`（新文件）、`packages/substrate/src/io.ts:311,350`（`loadTables` / `loadEvents` 内嵌 epoch 检查）、`packages/mcp/src/server.ts`（handler chokepoint）
- 写路径分票：[#79](https://github.com/McKenzieIT/semantic-grounding/issues/79)（findEventPath fast path 永不命中——01-probe 发现的 run_enrichment 262× 主因，与本 ADR 正交）

## Update — #77 / #78（2026-10-13 落地）

Status `proposed` → `accepted`（随 #76 关票记录，#77 落地兑现）。实现 commits：#77 `c1663ee` / #78 `5f226ce`，均合入 main。

**与「实现落点」草图的两处偏差**（R1 裁决为本，草图让位）：

1. **epoch store = per-epoch memo 实例**（`{ memo: Map<layer\0kind, {version, data}> }`），非草图的 `{ corpusVersion: number }`——corpusVersion 是 per-layer 的 Map，单数数字既表达不了多层版本也钉不住跨 epoch 隔离；「跨 epoch 解析次数 = 2」断言由 store 新生即隔离来保证，版本核对在每次访问时对活 `_corpusVersion` 做
2. **memo 键 `(semanticLayer, kind)` 复合**——裸 `semanticLayer` 键会让 `loadEvents` 命中 tables 的数组

其余按图落地：`readThroughEpoch` 无 epoch 直读（R3 逐字节相同）；mcp 侧 chokepoint 为 `createServerFactory` 内 `epochEnteringServer` Proxy 拦 `registerTool` 包 `cb`，26 个工具调用位零改动；mcp 取用经 `SemanticGroundingCore.withReadEpoch` 静态委托（barrel 36 名零变化）。`invalidateCaches` 本体与 `_corpusVersion` bump 保留（#78 删 hook 时明确为复合键活依赖）。

**路径断言实测**（k11，全库 767 readYaml）：work listing / prompts / filter names / 单条 lookup 全部 **1.00×**（filter names 对照 epoch 外 10×）；跨 epoch 2× 不泄漏；epoch 内 `writeTable` 后复合键 miss 重解析；另有经真实 `tools/call` 的 epoch 进入证明（`mcp/tests/read-epoch-entry.spec.ts`）。门禁终态：substrate 479 绿（480 − 删除的 S4 一条）/ mcp 345 pass（超 #61 留档 7 环境失败名单零个）/ e2e 21 步 / typecheck 双包 0 / barrel 36 名构建产物逐字节不变。

# map: substrate 读 epoch — MCP 只读路径一次调用一次解析

Type: map
Label: wayfinder:map
Destination: MCP 的只读调用路径上，一次工具调用只解析语料一次

## Destination

**MCP 的只读调用路径上，一次工具调用只解析语料一次。**

实现形态：`loadTables` / `loadEvents` 内部的「**读 epoch**」缓存，键为 `(per-call epoch) × 进程内 corpusVersion`。26 处调用位一行不改；**未开 epoch 时行为与今天逐字节相同**（缓存是纯增量开关）。随之删除 `BasicIndex` + `registerInvalidationHook`，包内只留一套读缓存抽象。

按路径定标（替代源票 #60 那条已被证伪的全局数字）：`get_enrichment_work` / `get_enrichment_prompts` / `assertKnownFilterNames` / 单条 `get_definition` 各一条解析次数断言。

**本图可被第一张票否决**：票 01 的探针若实测显示只读路径的解析成本已可忽略，本图的正确结局是整体关掉、记进 Out of scope，而不是重构。这是 Speculative 定位应有的收尾方式。

## Notes

- **本图带执行**（显式覆写 wayfinder「只规划不施工」默认）：ticket 落 main。先例 map #64 / #65 / #66。
- **MCP-first（用户裁决 2026-10-13）**：后续不再考虑适配 dsh，先把 MCP 作为完整服务做好。`snapshot.ts` / `withSnapshot` 是 dsh 的面，整体出范围。
- **新 ADR 编号是 0015**：0013 已被 #54（批量导入）预占，0014 是 initialization-phase-model。
- **Skills**：engineering skills consume GLOSSARY.md + ADRs；domain-modeling（票 03 要产 ADR-0015 + GLOSSARY「读 epoch」词条——GLOSSARY 现无任何缓存/epoch 术语）。
- **硬约束**：未开 epoch 时 `loadTables` / `loadEvents` 行为与今天逐字节相同。
- **原计划的 #67 阻塞边已不需要**：charting 时预期「改 enrichment 内部的票阻塞在 #67」，但 epoch 使 `assertKnownFilterNames` 的谓词提升变得无必要（N 次全库解析在 epoch 内自动折成 1 次），本图**无票编辑 enrichment 内部**，与 map #64 完全正交、可并行。
- **源票 #60 的三条前提已被 charting 证伪**，详见 Decisions。

## Decisions so far

<!-- 索引：一行一条，charting 裁决无链接，ticket 关闭后追加带链接的行 -->

### 形态与范围

- **目的地形态**：带执行，ticket 落 main（map #64 同构先例；验收标准是可度量的运行时行为，脱离代码无从判定）
- **范围有序**：性能先定型，读面整洁（抽象处置）在后——性能方案一旦定下，BasicIndex 有没有活儿干就自动有了答案；反序会提前关掉选项
- **与 map #64 排序**：并行，无阻塞边（见 Notes，预期的 #67 依赖已自行消解）
- **先量再改**：第一张票是解析计数探针，且它有权否决整图

### 新鲜度边界（本图的全部智力内容）

- **`corpusVersion` 单独做键不成立**：它是**进程内**计数器，看不见别的进程的写。`concurrent-write.spec.ts` / `corpus-lock.spec.ts` 实测拉起独立 OS 进程抢同一份语料（pid 文件锁串行化）；进程 A 缓存、进程 B 写，A 永不 bump → 无限期供应过期语料。这也正是写门指纹坚持 `readFileSync` 直读的原因（io.ts:615）
- **纯 per-call epoch 也不成立——会静默丢写**：写位形状全是 `{ ...raw, field: value }`，即从可能过期的基底整文档重写。`run_enrichment` 里管线 1 写完 `dimension_refs`，管线 3（enrichment.ts:1112）若用 epoch 内旧 `t.raw` 写 `alt_labels`，会把 `dimension_refs` 写回旧值——正是 ADR-0004 裁决 8 点名的「整字段覆盖丢别人的改动」
- **故键是复合的**：`(per-call epoch) × 进程内 corpusVersion`。写 bump → epoch 内失效，不丢写；调用结束 epoch 销毁 → 关掉跨进程过期窗口。**两半各有可证的必要性**
- **mtime 校验式跨调用缓存被否**：同秒内两次写在某些文件系统上测不出，「错过一次写」的后果是丢写而非变慢——拿正确性换性能，方向错
- **epoch 由 AsyncLocalStorage 环境式提供**，substrate 内一处进入；`loadTables` 查环境里有无开着的 epoch，**没有就直读**。否掉「24 个 handler 逐个包」（把正确性押在「下一个人记得」上——ADR-0010 已记录过同类赌注输掉的实测）与「Core 方法入口」（漏掉 `run_enrichment` / `assertKnownFilterNames` 等自由函数路径）
- **形态选 loader 层 memo 而非 per-call 显式穿参**：26 处调用位零改动，而显式穿参只惠及亲手穿过的几处（严格更多代码换严格更少覆盖）；票面红线 2「上下文不得跨锁存活」随之**变成设计本身**而非须遵守的纪律

### 源票 #60 票面前提的三处证伪

- **ADR-0004 裁决 8 不是本图的红线**：写门指纹走 `definitionVersion`（io.ts:615）→ `readFileSync` 单文件字面字节，事件路径由 `findEventPath` 自己扫目录，**全程不经 loader**。票面把它列为红线是误判
- **真边界在另一套指纹上**：`enrichment-work.ts:149` 的 `fingerprint(raw)` 哈希 `dumpYaml(raw)`，`raw` 来自 `loadTables().find()`——它**吃 loader 输出**，是 ADR-0006 裁决 4「逐项指纹复核」的支点。故票面「正确性不受影响」对 memo 形态**不成立**
- **「两个缓存抽象一个死码一个闲置」是三个，且性质各异**：①`BasicIndex` 生产引用确实为零，且 `index.ts:176` 已将其**降级为 internal**（删除零公共面成本，比票面以为的更便宜）②`snapshot.ts` **不是闲置**——在 `index.d.ts` 公共面上，且 ADR-0005 裁决 6 明确拒绝过快照句柄进 MCP 读面、把 MVCC 划给「dsh 执行查询的需要」③`corpusVersion`-keyed per-scope LRU（`getRelationGraph`）是**活的**，`per-scope-read.spec.ts` 实测覆盖

### 其他已核实事实

- **别名风险实测为零**：7 处写位全是 `{ ...raw, field: value }` 展开复制（enrichment.ts:535/727/1112/1165、enrichment-work.ts:147/615/632），**无一处就地改 `raw`**——memo 共享对象的最大顾虑不存在
- **`registerInvalidationHook` 也是 internal**：io.ts 导出但 `src/index.ts` 未再导出，`mcp/tests/build-shape.spec.ts:64` 还反向断言它不该被 emit，唯一使用者是 BasicIndex → 两者一并删，公共面成本零
- **`assertKnownFilterNames` 比票面更差**：`new Set(loadTables(...))` 写在 `.filter()` **谓词内部**（enrichment.ts:218/221），是**每个 filter 名一次全库解析**，不是「每次调用一次」
- **语料规模 321 表**（k11 fixture，与 ADR-0005 裁决 6 的「321 表」一致）；一次全库解析 = 321 次读 + YAML parse
- **bump 完备性当前无人看守**：`invalidateCaches` 在 io.ts 有 5 处调用位（706/711/757/811/966），但「每条写路径都 bump」**没有任何测试钉住**，而活的 relation-graph LRU 已在依赖它 → 可能是**今天就存在的 bug**，故票 02 独立于本图成立

## Open tickets

<!-- 当前未关闭的子 ticket，按阻塞关系排序 -->

- [02-bump-audit](issues/02-bump-audit.md) — **前沿**（task，AFK）：`invalidateCaches` bump 完备性审计 + 回归锁，独立于本图成立
- [03-adr-0015](issues/03-adr-0015.md) — **前沿**（grilling，HITL）：ADR-0015 + GLOSSARY 词条（01-probe 已解，实测数字可用）
- [04-epoch-impl](issues/04-epoch-impl.md) — 被 03 阻塞（task，AFK）：AsyncLocalStorage epoch + loader memo + 路径断言
- [05-cleanup](issues/05-cleanup.md) — 被 04 阻塞（task，AFK）：删 BasicIndex + registerInvalidationHook

### 01-probe 实测（2026-10-13）

- **本图不否决**：读路径成本真实（1-4× 每调用），epoch 有实收益
- **`assertKnownFilterNames` 最差**：10 个 filter 名 → 4.19× 全库解析，O(N) 线性增长，epoch 可折到 ~1×
- **`get_enrichment_prompts` 次差**：5 项 → 2.09×，epoch 可折到 ~1×
- **`search_definitions` 病理**：2× 每调用，但根因是 `projectGraphNodes` 显式未缓存（与 epoch 正交）
- **`run_enrichment` 262× 是写路径 bug 而非读路径问题**：99% 来自 `findEventPath`（io.ts:801）每写一次全事件库扫描——event name 用点（`account.role.backup.rollback`）而 filename 用下划线（`role_backup_rollback.yaml`），fast path 永不命中。本图不能修，**另开 sibling ticket**
- **`get_definition` 单条 lookup 已是下限**：321/446 reads = 1 次全扫，epoch 帮不上（name→file 索引才能帮，那是另一条优化）
- **源票 #60「≥10 次全库解析」的实测**：大幅超出（262×），但根因是写路径 `findEventPath` 扫描，不是源票预想的读路径重复读

## Not yet specified

<!-- 已知但尚不能精确 ticket 化的雾区 -->

- **epoch 外的自由函数路径要不要单独治理**：`assertKnownFilterNames` 的谓词内全库解析等，在未开 epoch 时仍是 N 次解析。MCP 全路径都会在 epoch 内，所以这条的**存在性**取决于 MCP-first 之后还有没有非 MCP 调用者活下来——现在判断不了，等票 04 落地后看 epoch 覆盖率。
- **读 epoch 的可观测性**：命中/未命中计数要不要接到 `enrichment_health` 之类的既有回执上长期暴露。票 01 的探针会先产出这些数字，但「该不该长期暴露、暴露在哪」要等 epoch 落地后看实际噪声水平。

## Out of scope

<!-- 范围之外（非「尚不够锐」）；不会毕业 -->

- **`run_enrichment` 的全库解析次数**：门(1) + `assertKnownFilterNames`(N) + 四条管线(4) 这些 `loadTables` 调用**彼此之间都隔着写**，复合键下全部 miss——缓存在这条路上无能为力。它是 map #64 扫管引擎的收益（四条管线折成一条，`loadTables` 自然 4→1）。源票 #60 把验收标准写在这个靶子上是写错了靶。
- **name→entry 索引 / 6 处 `.find()` 的 O(corpus) 扫描**：#60 把「O(corpus)」当一个成本，实际是两个——解析语料（321 次读+parse，昂贵）与扫一遍数组（321 次字符串比较，可忽略）。后者在前者被缓存之后不配一层抽象。
- **`snapshot.ts` / `withSnapshot` / dsh 适配**：ADR-0005 裁决 6 把 MVCC 划给 dsh；且 snapshot 的 `corpusVersion` 键**对它自己的用例是正确的**（MVCC 要的就是钉住一个版本，跨进程过期对它不是 bug 而是定义）。两套缓存生命周期需求真的不同，合并会把一条正确语义拗向另一条。叠加用户 MCP-first 裁决，整体出范围。
- **mtime 校验式跨调用缓存**：见 Decisions（拿正确性换性能）。
- **`findEventPath` 写路径 bug（262× 全库解析）**：io.ts:801，每写一个 event 做一次全事件库扫描。根因：event name 用点、filename 用下划线，fast path 永不命中。独立于本图，且**impact 更高**（run_enrichment 99% 成本在此）。另开 sibling ticket 处理——可能修法：filename convention 改点、或 name→path 缓存。
- **`search_definitions` 的 `projectGraphNodes` 未缓存**：2× 每调用，与 epoch 正交，需要自己的缓存层。

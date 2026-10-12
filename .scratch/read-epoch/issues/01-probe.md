Type: research
Status: resolved

## Answer

**Probe completed 2026-10-13. Verdict: the map should proceed.**

### Results Table

Fixture: k11 (321 tables, 445 events, 10 concepts). One full-corpus parse = 767 YAML reads.

| # | Path | Reads | Corpus × | Severity | Epoch Helps? |
|---|------|-------|----------|----------|-------------|
| 1 | `get_enrichment_work` (full listing) | 1,088 | 1.42× | Moderate | Yes → 1× |
| 2 | `get_enrichment_prompts` (5 items) | 1,605 | 2.09× | Pathological | Yes → ~1× |
| 3 | `assertKnownFilterNames` (10 tables) | 3,210 | 4.19× | **Pathological** | Yes → ~1× |
| 4a | `get_definition` (single table) | 321 | 0.42× | Moderate | No (1 scan is minimum) |
| 4b | `get_definition` (single event) | 446 | 0.58× | Moderate | No (1 scan is minimum) |
| 5a | `run_enrichment`: discoverRelations (tables only) | 642 | 0.84× | Moderate | Yes → ~0.5× |
| 5b | `run_enrichment` (full: all 4 pipelines) | **201,384** | **262.56×** | **CATASTROPHIC** | Partially (write-path bug) |
| 6a | `getRelationGraph` (cold cache) | 777 | 1.01× | Moderate | Already cached |
| 6b | `getRelationGraph` (warm cache) | 0 | 0.00× | Negligible | N/A |
| 6c | `search_definitions` (cold) | 1,554 | 2.03× | Pathological | Partially |
| 6d | `search_definitions` (warm graph) | 1,554 | 2.03× | Pathological | Partially |
| 6e | `get_join-path` / `get_relations` / `resolve_alias` | same as 6a/6b | — | — | Already cached via graph |

### Critical Discovery: `findEventPath` is the real monster

The `run_enrichment` full result (201,384 reads) is **99% write-path, not read-path**:

- `discoverRelations` (tables only): **642 reads** — as predicted (2 × loadTables)
- `discoverEventRelations`: **100,371 reads** — expected ~767, got 100K+
- `discoverAltLabels` (tables + events): **100,371 reads** — same pattern

**Root cause**: `writeEventYaml` (io.ts:801) calls `findEventPath` which does a full event-corpus scan per write. The fast path (`events/<domain>/<name>.yaml`) never matches because event names use dots (`account.role.backup.rollback`) but filenames use underscores (`role_backup_rollback.yaml`). So the fallback full scan (446 reads) runs for every event write. With 445 events × ~223 average reads per scan (stops at match) = ~99,604 reads per pipeline that writes events.

This is a **write-path bug**, separate from the read-path issue the epoch addresses. The read-epoch cannot fix it.

### Source ticket #60 verdict

The "≥10 full-corpus parses" claim is **vastly exceeded** (262× for full run_enrichment), but for a reason #60 didn't anticipate: the write-path `findEventPath` scans, not read-path re-reads. The read-path alone (642 for discoverRelations) is under 1× full corpus.

### Verdict on the effort

**The map should proceed, but with expanded scope awareness.**

1. **Read paths justify the epoch** (paths 1-3, 6c-6d): `assertKnownFilterNames` at 4.19× for 10 names is the worst read-path offender and scales linearly. `get_enrichment_prompts` at 2.09× for 5 items is also pathological. The epoch would reduce these to ~1×.
2. **`findEventPath` is a separate, larger issue** (path 5b): 262× for run_enrichment, 99% from write-path scans. This needs its own ticket — possibly fixing the filename convention or caching the name→path mapping. It's orthogonal to the read-epoch.
3. **`search_definitions` has an uncached `projectGraphNodes`** (path 6c-6d): 2× per call regardless of graph cache. The epoch would help the `loadRetrievalCorpusAll` half; the `projectGraphNodes` half needs its own cache.
4. **`get_definition` single-item reads** (path 4): 321/446 reads per single definition lookup is the minimum cost of a full-scan `.find()`. The epoch would NOT help here (one call = one scan = already optimal without a name index). A name→file index would, but that's a different optimization.

### Deliverables

- `packages/substrate/src/io.ts` — test-only `_readYamlCount` counter + `_resetReadYamlCount()` / `_getReadYamlCount()` exports (NOT on barrel, build-shape.spec.ts verified clean)
- `packages/substrate/tests/read-count-probe.spec.ts` — 13 tests covering all target paths

**先量再改**：在不动 `loadTables` / `loadEvents` 的前提下，量出 MCP 关键只读路径的**真实全库解析次数**。

**目标路径**（按预期收益排序）：

1. `get_enrichment_work` — N 项的 listing，`fingerprint(raw)` 吃 loader 输出
2. `get_enrichment_prompts` — ≤10 项的题面重建，`getEnrichmentPrompts` 内部 `loadTables().find()` / `loadEvents().find()` 各一次全库
3. `assertKnownFilterNames` — `new Set(loadTables(...))` 写在 `.filter()` **谓词内部**（enrichment.ts:218/221），每个 filter 名一次全库解析，实测比源票 #60 描述的「每次调用一次」更差
4. `get_definition`（单条）— `loadTableDefinition` / `loadEventDefinition` 是 `loadTables().find()` + 单条 parse
5. `search_definitions` / `get_join_path` / `get_relations` / `resolve_alias` — 这些走的是不同路径（graph/search index），可能不受影响，**实测确认**

**量法**：

- 在 `readYaml`（io.ts:142）埋计数探针（test-only export，不进生产），spec 里断言每个目标路径的解析次数
- 同时量 `run_enrichment` 单轮完整执行（门 1 + filter 校验 + 四管线）的解析次数，**印证源票 #60 的「≥10 次」数字**
- 把结果写进一个 fixture spec（可被未来实现票断言），fixture 语料 = k11（321 表，与 ADR-0005 裁决 6 一致）

**有权否决整图**：

如果实测结果全在可接受范围（比如单条 `get_definition` 只有 1 次、`get_enrichment_work` 也只有 1 次——那就说明缓存的收益不存在），本图应当整体关掉、记进 Out of scope，而不是重构 26 处调用位。

**交付**：

- `packages/substrate/tests/read-count-probe.spec.ts`（或类似名）
- 一份结果表（路径 × 解析次数）贴进 ticket 的 resolution
- 对本图其余四张票的存活判断

**前置**：无。本票是前沿。

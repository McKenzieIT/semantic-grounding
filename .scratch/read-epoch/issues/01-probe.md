Type: research
Status: open

## Question

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

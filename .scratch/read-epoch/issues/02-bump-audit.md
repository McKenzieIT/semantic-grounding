Type: task
Status: open

## Question

**`invalidateCaches` bump 完备性审计 + 回归锁。**

`corpusVersion` 是进程内计数器，**活的** `getRelationGraph` per-scope LRU 已经在依赖它（`per-scope-read.spec.ts` 实测覆盖）。但「每条写路径都 bump」**没有任何测试钉住**——可能是**今天就存在的 bug**。

**审计范围**：

1. 穷举 `packages/substrate/src/io.ts` 所有公共写原语（`writeTable` / `writeEventYaml` / `updateTableMeta` / `updateEventMeta` / `writeConceptYaml` / `updateConceptMeta` / `syncWriteDefinitions` / `addAlias*` / `removeAlias*` / `addRelation*` / `removeRelation*` / `applyEnrichment` 等——按 io.ts 真实导出为准）
2. 穷举 `packages/mcp/src/` 所有可能写语料的路径（`tools/write.ts` / `tools/enrichment.ts` / `tools/items.ts` / `tools/suggestions.ts`）
3. 断言每一个都调 `invalidateCaches(semanticLayer)`，漏的补上
4. 加一个**回归 spec**：每条写原语执行后，`getCorpusVersion(root)` 必须 bump（test-only helper 暴露 `readYaml` 计数器，或直接断言 `corpusVersion`）

**独立于本图成立**：

本票的价值不依赖本图后续任何一步——哪怕票 04 最后选了 per-call 上下文，甚至哪怕整图被票 01 否掉，它都该落地。

**交付**：

- 一份审计表（写原语 × 是否 bump × 备注）贴进 ticket 的 resolution
- 回归 spec（test-only，不进生产）
- 如有遗漏，补 commit

**前置**：无。本票与 01-probe 同为前沿，可并行。

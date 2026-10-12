Type: task
Status: resolved

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

## Answer

**Audit 2026-10-13: 所有 7 个公共写原语都通过 `auditedFileWrite` 调用 `invalidateCaches`。无遗漏。**

### 审计表

| 写原语 | 调用 `auditedFileWrite` | `auditedFileWrite` 调用 `invalidateCaches` | 备注 |
|--------|------------------------|------------------------------------------|------|
| `writeTable` (io.ts:753) | ✓ | ✓ (717 成功后 / 722 回滚后) | — |
| `writeEventYaml` (io.ts:801) | ✓ | ✓ (822 tier2=undef 分支 / 717 via auditedFileWrite) | 两条路径都覆盖 |
| `updateTableMeta` (io.ts:854) | ✓ | ✓ (717 via auditedFileWrite) | — |
| `updateEventMeta` (io.ts:903) | ✓ | ✓ (717 via auditedFileWrite) | — |
| `writeConceptYaml` (io.ts:963) | ✓ | ✓ (717 via auditedFileWrite) | — |
| `updateConceptMeta` (io.ts:1001) | ✓ | ✓ (717 via auditedFileWrite) | — |
| `syncWriteDefinitions` (io.ts:1155) | ✓ | ✓ (717 via auditedFileWrite, 循环体内) | — |

`auditedFileWrite` (io.ts:707) 是单点 seam: 每次成功写后 bump (717), 每次 recorder 失败回滚后也 bump (722)。

### 回归 spec

`packages/substrate/tests/bump-completeness.spec.ts` — 8 tests:
- 7 个写原语各一条断言 (`v1 > v0`)
- 1 条基线断言 (`invalidateCaches` 直接调用)
- 1 条跨路径隔离断言 (root A bump, root B 不动)

全绿。

### MCP 层审计

`packages/mcp/src/tools/` 所有写路径 (`write.ts` / `enrichment.ts` / `items.ts` / `suggestions.ts`) 都通过 substrate 的 7 个公共写原语, 不自己写文件, 故自动覆盖。

### 原预期 vs 实测

原以为本票会发现「今天就存在的 bug」(至少一条写路径漏 bump)。实测无 bug — `auditedFileWrite` 的设计 (由 #61 落地) 已经把 bump 完备性由构造保证。本票仍值回归锁: 未来若新增写原语绕开 `auditedFileWrite`, spec 会立刻红。

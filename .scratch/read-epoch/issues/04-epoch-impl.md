Type: task
Status: open
Blocked by: 01-probe, 03-adr-0015

## Question

**读 epoch 实现：AsyncLocalStorage + loader memo + 路径断言。**

按 ADR-0015 落地，分三步：

### 步骤 1：AsyncLocalStorage epoch 基础设施（substrate 内一处进入）

- 新建 `packages/substrate/src/read-epoch.ts`：`withReadEpoch<T>(fn: () => T): T`，使用 `AsyncLocalStorage<{ corpusVersion: number }>`
- `loadTables` / `loadEvents`（io.ts:311/350）检查环境里有无开着的 epoch：
  - **有 epoch**：`(epochKey, corpusVersion)` 复合键，命中 memo 返回
  - **无 epoch**：直读（与今天逐字节相同）
- memo 是 io.ts 内部的 `Map<string, { version: number, data: RawTable[] | RawEvent[] }>`，keyed on `semanticLayer`

### 步骤 2：MCP handler 入口一处进入

- MCP server 启动处（`packages/mcp/src/server.ts`）的 handler chokepoint 包一层 `withReadEpoch`
- 24 个 handler 不动，单点进入
- **验证**：未包的路径（dsh / 自由函数）行为与今天逐字节相同

### 步骤 3：路径断言（test-only，钉住验收）

- 把票 01-probe 的计数器提升为正式断言
- 新建 `packages/substrate/tests/read-epoch.spec.ts`：
  - `get_enrichment_work` N 项 → 解析次数 = 1（epoch 内复用）
  - `get_enrichment_prompts` ≤10 项 → 解析次数 = 1
  - `assertKnownFilterNames` N 名 → 解析次数 = 1（epoch 内 fold 掉 N 次谓词内全库解析）
  - 单条 `get_definition` → 解析次数 = 1
- 同时补一条**反面断言**：跨 epoch（两次 `withReadEpoch` 之间）解析次数 = 2（memo 不泄漏）
- 补一条**写位失效断言**：epoch 内一次 `writeTable` 后，下次 `loadTables` 必须重新解析（`invalidateCaches` bump `corpusVersion` → 复合键 miss → 重解析）

**交付**：

- `packages/substrate/src/read-epoch.ts`
- `io.ts` 改动（`loadTables` / `loadEvents` 内嵌 epoch 检查）
- `packages/mcp/src/server.ts` handler chokepoint 改动
- `packages/substrate/tests/read-epoch.spec.ts`（正面 + 反面 + 写位失效三组断言）
- 既有 368+ 测试不红

**前置**：票 01-probe（实测数字）+ 票 03-adr-0015（裁决面锁死）。

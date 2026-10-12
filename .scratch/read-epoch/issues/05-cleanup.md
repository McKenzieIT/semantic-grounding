Type: task
Status: open
Blocked by: 04-epoch-impl

## Question

**删除 BasicIndex + registerInvalidationHook 收尾。**

读 epoch 落地后，包内应当只留一套读缓存抽象——BasicIndex 是长寿实例缓存，生命周期恰好是复合键要避免的那一种（per-instance dirty flag，既不是 per-call 也看不见跨进程）。

**删除项**：

1. `packages/substrate/src/basic-index.ts`（147 行）
2. `index.ts:176` 的 internal 注释（BasicIndex 不再存在）
3. `registerInvalidationHook`（io.ts:156-175 附近，导出 + hook 列表 + 触发点）
4. `scenarios.spec.ts` S4 BasicIndex 用例（约 30 行）
5. `build-shape.spec.ts:64` 的反向断言（`registerInvalidationHook` 不再被 emit——删掉这条断言，因为名字本身已不存在）
6. 任何还引用 BasicIndex / registerInvalidationHook 的文档（grep 确认）

**公共面成本**：

- `BasicIndex` 已被 `index.ts:176` 降级为 internal，未在 `src/index.ts` 再导出 → 删除零公共面成本
- `registerInvalidationHook` 在 io.ts 导出但 `src/index.ts` 未再导出，且 `build-shape.spec.ts:64` 反向断言它不该被 emit → 删除零公共面成本

**验收**：

- 全量测试不红（substrate 431 + mcp 310 + e2e 19 步基线）
- acceptance barrel 36 名对照过（BasicIndex 不在名单上）
- GLOSSARY 不引 BasicIndex（确认）

**交付**：

- 删除文件 + 调整引用
- 验证门禁全绿

**前置**：票 04-epoch-impl（epoch 必须先落地，BasicIndex 才有替代）。

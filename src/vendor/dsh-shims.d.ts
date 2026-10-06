/**
 * Ambient module shims for `@deepseek-ai/dsh-audit` and `@deepseek-ai/dsh-llm`.
 *
 * Neither package is published to a registry this repo can reach, and neither
 * is needed at runtime by the substrate's own build or test suite:
 *
 *  - `dsh-audit` is imported as an empty type-only import
 *    (`import type {} from '@deepseek-ai/dsh-audit'`) — the substrate never
 *    references a symbol from it. The ambient `declare module` below lets
 *    `tsc` resolve the specifier; the import is erased, so no runtime copy
 *    is needed.
 *
 *  - `dsh-llm` is dynamically imported (`await import('@deepseek-ai/dsh-llm')`)
 *    inside `llm-wiring-plugin.ts`'s deferred `textLlm.text()` path — a path
 *    no test in this repo exercises (the LLM wiring tests bypass `apply()`
 *    via `wireEnrichmentLlm(svc, fakeLlm)`, or hit `apply()`'s no-provider
 *    early-return). The shim types `BlockAssembler`/`createUserMessage`
 *    precisely enough for `tsc` to typecheck the plugin; `ctx.llm.stream` is
 *    typed via the cordis Context augmentation below.
 *
 * Slice 2 keeps these shims (the inversions remove the `ctx.audit`/`ctx.llm`
 * lookups from core, not these type seams). Slice 4's dsh-side cutover makes
 * the real packages available from the host's own node_modules.
 */
declare module '@deepseek-ai/dsh-audit' {}

declare module '@deepseek-ai/dsh-llm' {
  export class BlockAssembler {
    push(chunk: unknown): void
    blocks(): Array<{ type: string; text: string }>
  }
  export function createUserMessage(opts: {
    content: Array<{ type: 'text'; text: string }>
    source: { kind: string; plugin: string }
  }): unknown
}

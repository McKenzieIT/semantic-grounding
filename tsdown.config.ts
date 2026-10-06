import { defineConfig } from 'tsdown'

/**
 * Standalone build for the semantic-grounding substrate.
 *
 * Two entries: the main substrate (`src/index.ts`) and the enrichment LLM
 * wiring plugin (`src/llm-wiring-plugin.ts`). The plugin is a separate entry
 * so a host can mount the Cordis plugin without reaching into `./src/*`.
 *
 * `external` keeps the host-framework deps (`@deepseek-ai/cordis`,
 * `schemastery`, `cosmokit`) out of the bundle — the host provides them.
 * The vendored `atomic-write` source IS bundled (it lives in `src/vendor/`).
 *
 * tsdown emits ESM + `.d.ts` in one pass; `tsc --noEmit` (see `typecheck`
 * script) is the typecheck gate.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/llm-wiring-plugin.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/cosmokit',
  ],
})

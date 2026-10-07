import { defineConfig } from 'tsdown'

/**
 * Standalone build for the semantic-grounding substrate.
 *
 * **One entry.** `src/llm-wiring-plugin.ts` was the second one — a cordis
 * plugin, and the last host-shaped file in `src/`. Slice 4a moved it into the
 * dsh adapter, which is where a cordis plugin belongs; the substrate no longer
 * ships a host-framework entry at all. That is why `exports` is down to `"."`
 * + `"./package.json"` and why `peerDependencies` is empty.
 *
 * `external` is retained as a guard, not a need: nothing under `src/` imports
 * a host framework any more (`scripts/check-core-purity.mjs` enforces it with
 * an empty allow-list), so these three would never be bundled regardless.
 * Keeping them listed makes a reintroduction fail loudly at build time instead
 * of silently inlining a host framework into the substrate.
 * The vendored `atomic-write` source IS bundled (it lives in `src/vendor/`).
 *
 * tsdown emits ESM + `.d.ts` in one pass; `tsc --noEmit` (see `typecheck`
 * script) is the typecheck gate.
 */
export default defineConfig({
  entry: ['src/index.ts'],
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

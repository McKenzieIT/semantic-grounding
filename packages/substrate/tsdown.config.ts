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
 * src/ has zero host imports — guarded by `scripts/check-core-purity.mjs`
 * (empty allow-list) + `tsc --noEmit` — and the host-framework dependency
 * trace was fully removed in S1.6, so there is no `external` list to keep.
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
})

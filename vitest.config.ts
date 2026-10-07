import { defineConfig } from 'vitest/config'

/**
 * Minimal standalone vitest config.
 *
 * Tests import the substrate via relative paths (`../src/...`), so no alias is
 * needed for the substrate itself. The host framework (`@deepseek-ai/cordis`
 * and its `schemastery`/`cosmokit` siblings) resolves from `node_modules` like
 * any other dependency — slice 2 ① replaced slice 1's `vendor-deps/` source
 * copy with the published packages, so typecheck and runtime share one module
 * identity without `paths`/`resolve.alias` plumbing.
 *
 * Only the host-facing shell (`src/llm-wiring-plugin.ts`) and the tests that
 * exercise it still touch cordis; the substrate core is host-symbol-free (see
 * the `pretest` core-purity gate in package.json).
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})

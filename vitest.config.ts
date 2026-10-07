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
 * Nothing under `src/` touches cordis any more — slice 4a moved the last
 * host-facing shell (`src/llm-wiring-plugin.ts`) into the dsh adapter, so the
 * `pretest` core-purity gate runs with an empty allow-list. cordis survives
 * here as a **devDependency only**, for the handful of tests that mount the
 * core under a real host fiber (`service-wiring`, `per-scope-read`,
 * `scope-delegation`, `registry`, and the `scope-registry` fixture) — proving
 * the substrate *works* under a host is not the same as *depending* on one.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})

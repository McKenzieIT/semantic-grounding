import { defineConfig } from 'vitest/config'

/**
 * Minimal standalone vitest config.
 *
 * Tests import the substrate via relative paths (`../src/...`), so no alias is
 * needed for the substrate itself, and no test mounts a host framework: the
 * fiber-mounting specs left with S1.6's removal of the scope-registry
 * delegation, so the suite has no host-framework dependency at all. The
 * `pretest` core-purity gate (`scripts/check-core-purity.mjs`) keeps it that
 * way with an empty allow-list.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // ADR-0008's 1000-row cap test deliberately materializes 1200+ fixture
    // definitions to force truncation; under the full suite's parallel worker
    // contention that single test runs measurably slower than solo (#167
    // re-measured the amplification at ~1.5×, correcting the 3–4× figure this
    // comment used to carry). The default 5000ms clips both it and unrelated
    // files scheduled alongside it — a global bump, not a per-test override,
    // since the amplifier is suite-wide contention, not this one test being
    // slow in isolation.
    testTimeout: 20_000,
  },
})

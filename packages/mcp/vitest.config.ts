import { defineConfig } from 'vitest/config'

/**
 * Minimal standalone vitest config, mirroring packages/substrate's.
 *
 * `tests/helpers/` is excluded by the `*.spec.ts` pattern, which matters here because
 * `helpers/concurrent-writer.ts` is an executable run by `node` in a child process (the
 * cross-process lock test) and would otherwise be collected as a suite and run itself.
 *
 * Timeouts are raised from vitest's 5s default: this suite builds a real git repository
 * per test and the cross-process cases spawn four writers that queue on the corpus lock.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})

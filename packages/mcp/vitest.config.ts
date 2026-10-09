import { defineConfig } from 'vitest/config'

/**
 * Minimal standalone vitest config, mirroring packages/substrate's. Only one
 * spec exists today — a scaffold smoke test proving the workspace:* link to
 * @semantic-grounding/substrate resolves (see tests/workspace-link.spec.ts).
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})

import { defineConfig } from 'vitest/config'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Minimal standalone vitest config.
 *
 * Tests import the substrate via relative paths (`../src/...`), so no alias is
 * needed for the substrate itself. The host-framework deps
 * (`@deepseek-ai/cordis`, `schemastery`, `cosmokit`) resolve to the vendored
 * SOURCE under `vendor-deps/` via `resolve.alias` — both the exact package
 * specifier and any `/<subpath>` deep import. This keeps a single module
 * identity between typecheck (tsconfig `paths`) and test runtime, and lets
 * vite compile the cordis source the tests actually exercise (`new Context()`).
 */
const vendorAlias = (pkg: string) => [
  { find: new RegExp(`^@deepseek-ai/${pkg}$`), replacement: resolve(__dirname, `vendor-deps/${pkg}/index.ts`) },
  { find: new RegExp(`^@deepseek-ai/${pkg}/`), replacement: resolve(__dirname, `vendor-deps/${pkg}/`) },
]

export default defineConfig({
  resolve: {
    alias: [
      ...vendorAlias('cordis'),
      ...vendorAlias('schemastery'),
      ...vendorAlias('cosmokit'),
    ],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})

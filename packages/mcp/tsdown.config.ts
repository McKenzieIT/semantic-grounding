import { defineConfig } from 'tsdown'

/**
 * Empty-scaffold build (issue #17).
 *
 * `src/index.ts` has no exports yet — there is no tool surface to bundle
 * until #19/#20/#21 land. No `external` guard is declared because nothing
 * here imports a host framework or the (not-yet-added) MCP SDK; add one if
 * either shows up. Mirrors `packages/substrate/tsdown.config.ts`'s shape so
 * both packages build the same way once real code lands.
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

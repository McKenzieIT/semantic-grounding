import { defineConfig } from 'tsdown'

/**
 * Build for the MCP host wiring.
 *
 * `@semantic-grounding/substrate` is a real dependency and stays external — the package
 * is installed alongside, and bundling it would ship two copies of the substrate (and of
 * its module-level caches) to any consumer that also depends on it directly.
 *
 * No host framework is imported here and the MCP SDK is still absent — it arrives with
 * the stdio entry point (#22), which is also when an `external` entry for it is worth
 * adding. The git recorder shells out to `git` rather than linking a git library, so
 * there is nothing else to keep out of the bundle.
 *
 * Mirrors `packages/substrate/tsdown.config.ts`'s shape so both packages build the same
 * way.
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

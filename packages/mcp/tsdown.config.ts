import { defineConfig } from 'tsdown'

/**
 * Build for the MCP host wiring.
 *
 * `@semantic-grounding/substrate` is a real dependency and stays external — the package
 * is installed alongside, and bundling it would ship two copies of the substrate (and of
 * its module-level caches) to any consumer that also depends on it directly.
 *
 * `@modelcontextprotocol/server` arrived with the stdio entry point (#22) and stays
 * external for the same reason: it is a declared dependency, installed alongside, and
 * bundling it would duplicate the SDK for any consumer that also depends on it. Both are
 * externalized by tsdown's default treatment of `dependencies`, so neither needs an
 * explicit `external` entry — `tests/build-shape.spec.ts` asserts that rather than
 * trusting it. No host framework is imported here, and the git recorder shells out to
 * `git` rather than linking a git library, so there is nothing else to keep out.
 *
 * Two entries: the library barrel, and `bin.ts` for the `sg-mcp` executable named in
 * `package.json`'s `bin`. The shebang on `bin.ts` is preserved into `lib/bin.js`.
 *
 * Mirrors `packages/substrate/tsdown.config.ts`'s shape so both packages build the same
 * way.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})

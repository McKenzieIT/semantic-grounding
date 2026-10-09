/**
 * A server started with one tool registered, for the {@link ToolRegistrar} seam test.
 *
 * Run as `node tests/helpers/registrar-server.ts --corpus <root> --agent-id <id>`. Node
 * strips the types, so this needs no build step and no test runner in scope — the same
 * arrangement as `concurrent-writer.ts`, and for the same reason: the thing under test is
 * a *process* contract. A registrar that worked in-process but produced no `tools/list`
 * entry over the real transport would pass an in-process test and fail #20.
 *
 * What it proves, specifically: declaring `capabilities: { tools: {} }` up front for the
 * zero-tool case (measurement 4 in `src/server.ts`) does **not** stop a later
 * `registerTool` from landing. Those two could plausibly conflict — the SDK wires its tool
 * handlers eagerly when the capability is declared and lazily on first registration
 * otherwise — so #20's whole integration step rests on them composing.
 *
 * @module tests/helpers/registrar-server
 */
import { runMain } from '../../src/main.ts'
import type { ToolRegistrar } from '../../src/server.ts'

/** Registers a single trivial tool, so `tools/list` has something to show. */
const echoRegistrar: ToolRegistrar = (server, deps) => {
  server.registerTool(
    'seam_probe',
    { description: `registered by a ToolRegistrar over corpus ${deps.config.corpusRoot}` },
    () => ({ content: [{ type: 'text' as const, text: 'seam ok' }] }),
  )
}

const outcome = await runMain(
  process.argv.slice(2),
  process.env,
  message => process.stderr.write(`${message}\n`),
  { registrars: [echoRegistrar] },
)

if (outcome.kind === 'exit') process.exit(outcome.code)

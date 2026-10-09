#!/usr/bin/env node
/**
 * The `sg-mcp` executable — what an MCP client registers as its `command`.
 *
 * Deliberately almost empty. Everything testable lives in `main.ts`, which takes `argv`
 * and `env` as parameters and *returns* its decision instead of exiting, so the startup
 * sequence can be driven in-process by a unit test. This file is the only place that
 * touches `process`, and the only place that can exit.
 *
 * Runs under plain `node` with no build step (node strips the types), which is how
 * `tests/server-startup.spec.ts` spawns it. The whole package avoids TypeScript's
 * parameter-property shorthand for that reason — strip-only mode rejects it (ADR-0004's
 * 2026-10-09 update, carried over from `tests/helpers/concurrent-writer.ts`).
 *
 * @module bin
 */
import { EXIT, runMain, stderrLog } from './main.ts'

/**
 * Report a fault that is this server's own bug and exit.
 *
 * Never reached for a bad corpus or a malformed flag — those are refusals `main.ts`
 * returns an exit code for. This is the "we broke" path, and it is loud: a stack trace on
 * stderr beats a terse message, because the reader is whoever has to fix this package.
 * @param reason - the thrown value.
 */
function fatal(reason: unknown): never {
  const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
  stderrLog(`[semantic-grounding] internal fault: ${detail}`)
  process.exit(EXIT.internal)
}

// Registered before anything runs, so a rejection from inside the serving phase — long
// after the top-level await has resolved — still exits non-zero. Node's default for an
// unhandled rejection is already a non-zero exit, but not one of ours, and the message
// would not name this server.
process.on('unhandledRejection', fatal)

try {
  const outcome = await runMain(process.argv.slice(2), process.env, stderrLog)
  if (outcome.kind === 'exit') process.exit(outcome.code)
  // Otherwise: serving. Nothing further to do — the open stdin holds the event loop, and
  // the transport closes itself when the client closes its end of the pipe, after which
  // the process exits naturally with 0. There is nothing to await: the SDK's stdio handle
  // exposes only `close()`, with no "serving finished" promise and no `onClose`.
} catch (e) {
  fatal(e)
}

/**
 * ADR-0005's fifteen intent tools — the `#20` half of the `ToolRegistrar` seam
 * `server.ts` declares (`#21`'s three enrichment tools are the other half).
 *
 * `INTENT_TOOL_REGISTRARS` is what `server.ts` appends to `TOOL_REGISTRARS`; each
 * registrar it combines is itself pure registration (no corpus read, no lock, no I/O —
 * every one of the four sub-registrars this re-exports already satisfies that, see
 * their own module docs).
 *
 * @module tools
 */
import type { ToolRegistrar } from '../server.ts'
import { ITEM_TOOL_NAMES, registerItemTools } from './items.ts'
import { READ_TOOL_NAMES, registerReadTools } from './read.ts'
import { SUGGESTION_TOOL_NAMES, registerSuggestionTools } from './suggestions.ts'
import { WRITE_TOOL_NAMES, registerWriteTools } from './write.ts'

/**
 * Every intent tool name this ticket registers, grouped the way ADR-0005 lists them
 * (read five, then the two definition-level writes, then the four item-level writes,
 * then the Tier-1 quartet) — ten write tools plus five read tools, fifteen total.
 *
 * Derived from each tool file's own name constant rather than hand-listed again here,
 * so a future tool addition changes one file and this list follows automatically —
 * the same reasoning `errors.ts`'s code maps use for "allocated so far" rather than a
 * hand-synced duplicate.
 */
export const INTENT_TOOL_NAMES = [
  ...READ_TOOL_NAMES,
  ...WRITE_TOOL_NAMES,
  ...ITEM_TOOL_NAMES,
  ...SUGGESTION_TOOL_NAMES,
] as const

/** The registrars `server.ts`'s `TOOL_REGISTRARS` appends for this ticket. */
export const INTENT_TOOL_REGISTRARS: readonly ToolRegistrar[] = [
  registerReadTools,
  registerWriteTools,
  registerItemTools,
  registerSuggestionTools,
]

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
import { ENRICHMENT_TOOL_NAMES } from './enrichment.ts'
import { ITEM_TOOL_NAMES, registerItemTools } from './items.ts'
import { PLAYBOOK_TOOL_NAMES } from './playbook.ts'
import { READ_TOOL_NAMES, registerReadTools } from './read.ts'
import { SCOPE_TOOL_NAMES } from './scope.ts'
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

/**
 * Every tool name the server registers — ADR-0005's fifteen intent tools plus
 * ADR-0006/0008's four enrichment tools plus ADR-0011's five scope tools plus
 * #55/#63's playbook tool. This is the single source for anything that needs
 * "the whole surface" as a list (the catalog spec's `tools/list`
 * reconciliation, the e2e gate's inventory check): compose from here, never
 * hand-glue the families again — the hand-glued copy in
 * `check-e2e-loop.ts` drifted to a "18 tools" comment the first time a tool
 * was added. #51 merged the scope family in under this same rule: the
 * composition grew by one import, no hand-list anywhere. #63 added the
 * playbook family the same way.
 *
 * Mirrors `server.ts`'s `TOOL_REGISTRARS` (`[...INTENT_TOOL_REGISTRARS,
 * registerEnrichmentTools, registerScopeTools, registerPlaybookTools]`) family
 * by family. The catalog spec asserts `tools/list` (over the default
 * registrars) equals this list, so a name constant and a registration that
 * disagree fail a test rather than shipping two different surfaces to
 * production and tests respectively.
 */
export const TOOL_NAMES = [
  ...INTENT_TOOL_NAMES,
  ...ENRICHMENT_TOOL_NAMES,
  ...SCOPE_TOOL_NAMES,
  ...PLAYBOOK_TOOL_NAMES,
] as const

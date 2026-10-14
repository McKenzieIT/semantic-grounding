/**
 * The tool catalog's single composition point (#115 / C3): every family file owns a
 * two-key descriptor card (`X_TOOL_FAMILY`, `ToolFamily` in `./shared.ts` — its own
 * `X_TOOL_NAMES` constant bound to its own `registerXTools` registrar, both still
 * defined and exported there), and this module is the only place those cards become
 * the flat lists the rest of the server consumes. `INTENT_TOOL_FAMILIES` is
 * ADR-0005's four intent families (#20's half of the `ToolRegistrar` seam
 * `server.ts` declares); `TOOL_FAMILIES` adds the five that followed. The four
 * constants below are all `flatMap`/`map` over those two lists — no tool name and no
 * registrar is hand-listed here, so adding a family means exporting its card and
 * taking one slot, and every consumer (`server.ts`'s served surface, the startup
 * banner's tool count, the catalog spec's `tools/list` reconciliation, the e2e gate's
 * inventory check) follows automatically — the hand-glued copies that used to live in
 * `server.ts` and `check-e2e-loop.ts` each drifted the first time a tool was added.
 *
 * Each registrar this composes is pure registration (no corpus read, no lock, no I/O
 * — every family file's own module doc states the same contract), which is why
 * composing them costs nothing beyond the import.
 *
 * @module tools
 */
import type { ToolRegistrar } from '../server.ts'
import { ENRICHMENT_TOOL_FAMILY } from './enrichment.ts'
import { IMPORT_TOOL_FAMILY } from './import.ts'
import { ITEM_TOOL_FAMILY } from './items.ts'
import { PLAYBOOK_TOOL_FAMILY } from './playbook.ts'
import { READ_TOOL_FAMILY } from './read.ts'
import { SCOPE_TOOL_FAMILY } from './scope.ts'
import { SCRATCH_TOOL_FAMILY } from './scratch.ts'
import { SUGGESTION_TOOL_FAMILY } from './suggestions.ts'
import { WRITE_TOOL_FAMILY } from './write.ts'

/**
 * ADR-0005's four intent families (#20): the read family (ruling 6's five plus
 * #105's `list_definitions`), the two definition-level writes, the four item-level
 * writes, and the Tier-1 suggestion quartet.
 */
export const INTENT_TOOL_FAMILIES = [
  READ_TOOL_FAMILY,
  WRITE_TOOL_FAMILY,
  ITEM_TOOL_FAMILY,
  SUGGESTION_TOOL_FAMILY,
] as const

/**
 * Every family the default surface serves: the four intent families plus the five
 * that followed — ADR-0006/0008's enrichment tools (#21), ADR-0011's scope
 * management plus #72's deregister (#51), #63's initialization playbook, ADR-0013's
 * bulk import (#68), and ADR-0020's scratch home (#101). #51, #63, #68 and #101 each
 * merged a family in under this same rule: the composition grew by one import and
 * one slot, no hand-list anywhere.
 */
export const TOOL_FAMILIES = [
  ...INTENT_TOOL_FAMILIES,
  ENRICHMENT_TOOL_FAMILY,
  SCOPE_TOOL_FAMILY,
  PLAYBOOK_TOOL_FAMILY,
  IMPORT_TOOL_FAMILY,
  SCRATCH_TOOL_FAMILY,
] as const

/**
 * Every intent tool name, derived — the families' own name constants flat-mapped in
 * ADR-0005's listing order (reads, definition-level writes, item-level writes, the
 * Tier-1 quartet). A future tool addition changes its family file and this follows
 * automatically — the same reasoning `errors.ts`'s code maps use for "allocated so
 * far" rather than a hand-synced duplicate.
 */
export const INTENT_TOOL_NAMES: readonly string[] = INTENT_TOOL_FAMILIES.flatMap(family => family.names)

/** The intent families' registrars, derived. */
export const INTENT_TOOL_REGISTRARS: readonly ToolRegistrar[] = INTENT_TOOL_FAMILIES.map(family => family.register)

/**
 * Every tool name the default surface serves, derived from `TOOL_FAMILIES` — the
 * single list for anything that needs "the whole surface" (the catalog spec's
 * `tools/list` reconciliation, the e2e gate's inventory check, the startup banner's
 * tool count). The registrar side of the same composition is `TOOL_REGISTRARS`
 * below, which `server.ts` imports and serves; the catalog spec asserts `tools/list`
 * (over the default registrars) equals this list, so a name constant and a
 * registration that disagree fail a test rather than shipping two different
 * surfaces to production and tests respectively.
 */
export const TOOL_NAMES: readonly string[] = TOOL_FAMILIES.flatMap(family => family.names)

/** Every registrar the default surface runs, in family order — the one list `server.ts` imports. */
export const TOOL_REGISTRARS: readonly ToolRegistrar[] = TOOL_FAMILIES.map(family => family.register)

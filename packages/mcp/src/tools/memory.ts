/**
 * `record_memory` — ADR-0023 R9's single write tool for the data-memory layer
 * (#152), plus ADR-0027's judgment regimen in its one home.
 *
 * ## Shape (#132's constraint)
 *
 * Top-level **object** inputSchema with a shared `memories` array — the five
 * types' *required/forbidden* fields differ, and that dispatch happens at
 * runtime in the substrate (`memory.ts`'s per-type validation), never as a
 * top-level `discriminatedUnion`/`oneOf`: #132 measured that Claude Code-class
 * hosts silently drop a `oneOf`-only schema, and the catalog spec's #132 guard
 * pins `record_memory` under the every-tool-has-top-level-`properties` rule.
 *
 * ## One call, one commit
 *
 * `auditedWrite` (lock + audit context) with `withAuditedBatch` inside — the
 * exact structure `import_definitions` settled: each entry lands through
 * `writeMemoryYaml`'s audited seam (absorbed while the batch is open), and
 * `end()` makes the single commit. A fully-idempotent call stages nothing and
 * commits nothing (`changed:false`). Any invalid item throws the coded
 * `memory_invalid` error from inside the window BEFORE the first write — the
 * batch aborts on a clean tree and the receipt names the 1-based item index.
 *
 * ## The judgment regimen is a module, not prose (ADR-0027 R2)
 *
 * `MEMORY_JUDGMENT_REGIMEN` / {@link neighborJudgmentGuidance} /
 * {@link MEMORY_SUPERSEDE_NOTE} are the single source the tool description, the
 * receipt's per-neighbor guidance, and (#154, when it lands) `get_definition`'s
 * read-side note all render from — the server never judges "contrary" itself;
 * it teaches the judging agent.
 *
 * @module tools/memory
 */
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { MemoryRecordError } from '../errors.ts'
import type { ServerDeps, ToolRegistrar } from '../server.ts'
import { assertScopeMatch, auditedWrite, toolSuccess, withAuditedBatch, writeReceipt } from './audited.ts'
import { promotionSession } from './promotion.ts'
import { CREATE_COMMON_FIELDS, type ToolFamily } from './shared.ts'

/** The memory family's single tool name. */
export const MEMORY_TOOL_NAMES = ['record_memory'] as const

// ── The judgment regimen (ADR-0027 R2 — 单一来源, rendered at judgment moments) ──

/**
 * The regimen's trunk, as the `record_memory` description renders it: how an
 * agent decides between recording normally, superseding, and declaring
 * `contradicts`. The server never makes this judgment (ADR-0027 R1) — this
 * text is the deliverable that teaches the agent to.
 */
export const MEMORY_JUDGMENT_REGIMEN = [
  'Before writing, compare your conclusion against the same-anchor same-type entries this receipt will list as neighbors:',
  '(1) observation windows that do NOT overlap are not contrary — the data changed, both entries stand; record normally.',
  '(2) same conclusion → replication evidence: record normally, no declaration.',
  '(3) the entry is outdated (still true of its window, no longer the operating rule) → supersedes with reason "outdated".',
  '(4) you have evidence the old entry is WRONG (deterministic source: DDL/docs/code; the user said so; or a new measurement covering the overlapping window that names where the old one fails) → supersedes with reason "wrong"; superseding a CONTESTED entry as wrong additionally requires basis.',
  '(5) contrary and you cannot say who is right → contradicts naming that entry, and state the difference (window / 口径 / filter) in your body; list every same-conclusion neighbor too.',
  'Evidence that does NOT count: majority vote, your own session\'s inference, "the newer one".',
  'Reading an UNDECLARED contradiction: present both sides to the user; record your own entry only per this tree.',
].join(' ')

/**
 * One neighbor's per-case guidance (ADR-0027 R2 ②): the trunk's decision list
 * compressed to the entry at hand, so the receipt teaches at the moment of
 * judgment rather than pointing back at the tool description.
 * @param id - the neighbor's memory id.
 * @returns the guidance line that neighbor's receipt entry carries.
 */
export function neighborJudgmentGuidance(id: string): string {
  return `same anchor & type as ${id}: same conclusion = replication evidence, record normally; it is outdated → supersedes reason "outdated"; you have evidence it is wrong → supersedes reason "wrong" (basis required when it is contested); contrary and undecidable → contradicts it and state the difference (window / 口径 / filter) in your body`
}

/**
 * The receipt-level update reminder (ADR-0023 R9's「若为更新请 supersedes 引用」):
 * inlined only when at least one row saw a neighbor, zero-tax absent otherwise.
 */
export const MEMORY_SUPERSEDE_NOTE = 'if this write is actually an update, re-issue it with supersedes referencing the entry it replaces (the neighbors above are the candidates)'

// ── The session identity (the mint lives in tools/promotion.ts since #136) ──────

// `recorded.session`'s default and a replicated promotion's `promoted.session`
// are one identity — `promotionSession(deps)` is the single route both take.

// ── Input schema (top-level object, runtime type dispatch — #132) ───────────────

/**
 * One memory entry as the tool accepts it: every field of the stored shape the
 * AGENT owns (the substrate stamps `id` / `recorded` / `promoted` itself,
 * ADR-0023 R3/R5). The per-type required/forbidden rules (incident and
 * observation need the closed `valid_*` window; practice needs `basis` and
 * takes no `valid_until`; inference needs `basis` and no `valid_*`; caveat
 * takes no `valid_*`) are enforced at runtime by the substrate — the schema
 * deliberately declares the union of fields so each type stays describable in
 * one place while the dispatch stays out of the top level.
 */
const MemoryItemInputSchema = z.object({
  type: z.enum(['observation', 'caveat', 'inference', 'practice', 'incident'])
    .describe('observation = a measured phenomenon (needs its measurement window valid_from+valid_until; the conclusion may promote, the number never does) · caveat = a verification boundary (no valid_*) · inference = an unverified judgement with its basis (basis required, no valid_*) · practice = a 口径/绕坑手法 (basis required; valid_from optional, never valid_until) · incident = a bounded point-in-time fact (valid_from+valid_until required, closed window; never promotes).'),
  anchors: z.array(z.string().min(1)).min(1)
    .describe('Identity anchors into the fact layer (ADR-0023 R4), ≥1, each must EXIST at write time: a node ("table:dws_pay", "event:pay.order", "concept:付费经济", "metric:<host>__<key>" — bare names accepted, canonical output is prefixed), a column fragment ("table:dws_pay#ch_id" / "event:pay.order#param" — the column must exist), or an edge in the graph\'s canonical logical direction ("<起点id> -joins-> <终点id>" / "-related_to-> "). Multiple alternative join paths between one node pair are one anchor; the key details belong in body.'),
  body: z.string().min(1)
    .describe('The entry\'s free-text substance. For a contradicts declaration, state the difference (window / 口径 / filter) here.'),
  basis: z.string().optional()
    .describe('Why you hold this true (source, measurement, user statement). Required for practice and inference; required when superseding a CONTESTED entry as wrong (ADR-0027 R5).'),
  valid_from: z.string().optional()
    .describe('Business-time start (YYYY-MM-DD, ds granularity — the time the statement is true OF, not the write time).'),
  valid_until: z.string().optional()
    .describe('Business-time end (YYYY-MM-DD). incident: required, write the current estimate while open, extend via an outdated supersede. observation: required (the measurement window).'),
  supersedes: z.array(z.object({
    id: z.string().min(1).describe('The memory id this entry replaces (mem-<YYYYMMDD>-<8 base32>).'),
    reason: z.enum(['outdated', 'wrong']).describe('outdated = true of its window, replaced going forward (still shown in跨期对比); wrong = never shown again, never counts as replication.'),
  })).optional()
    .describe('Updates are NEW entries that reference what they replace (the old file is never edited). The referenced id must exist; its own anchors are NOT re-checked (superseding a dangling entry is the sanctioned way to retire it, ADR-0026 R6).'),
  contradicts: z.array(z.string().min(1)).optional()
    .describe('Entries whose conclusion is contrary to yours while both stay valid and undecided (ADR-0027). Each id must exist, must not be wrong-hidden, must not also appear in supersedes; anchor overlap is NOT required.'),
}).strict()

/** The tool's input — #132's top-level object: batch-level provenance + the shared items array. */
const RecordMemoryInputSchema = z.object({
  ...CREATE_COMMON_FIELDS,
  memories: z.array(MemoryItemInputSchema).min(1)
    .describe('The entries to record, in order. The batch is atomic: any invalid item rejects the whole call naming its 1-based index, and nothing is written. An entry identical to one you recorded THIS session (same type, same anchor set, same normalized body) is a no-op (verdict "idempotent"); the same content from a DIFFERENT session is always a new entry — that is replication evidence, never deduplicated.'),
}).strict()

/** Registers `record_memory`. */
function registerRecordMemory(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'record_memory',
    {
      title: 'Record data memories',
      description: `Record experiential, contextual knowledge as memory entries — one append-only YAML file per entry under memory/, never part of a definition's fingerprint (ADR-0021/0023). What belongs here: point-in-time measurements, unverified inferences, 口径/绕坑 practices, bounded incidents, verification caveats — anything that does not survive "still true outside its moment and session, and verified" unchanged. What does NOT: confirmed facts belong in definitions (create/update_definition); fixing a typo in a definition is not a memory. One call = one commit for the whole batch. The receipt lists, for every entry, its still-valid same-anchor same-type neighbors — read them before assuming you are first. ${MEMORY_JUDGMENT_REGIMEN}`,
      inputSchema: RecordMemoryInputSchema,
    },
    async (input, ctx: ServerContext) => {
      const snap = deps.bindings.requireSnapshot()
      assertScopeMatch(snap, input.scope_id)
      // Server-written provenance (ADR-0023 R5): the agent cannot fill
      // `recorded` — the session is the config's, or this process's own mint;
      // the agent is the startup-declared writing agent (the commit author).
      const session = promotionSession(deps)
      const agent = deps.config.agentId
      const target = `${input.memories.length} ${input.memories.length === 1 ? 'entry' : 'entries'}`

      const audited = await auditedWrite(
        snap,
        ctx,
        { tool: 'record_memory', target, summary: input.summary, derivation: input.derivation, confidence: input.confidence, sessionId: session },
        () => withAuditedBatch(snap, async (batch) => {
          const res = await snap.core.recordMemories(input.memories, { session, agent })
          // The `{ok:false}` arm is validation-only (nothing was written — the
          // substrate validates the whole batch before its first write), so
          // throwing here aborts a batch that staged nothing and surfaces the
          // coded whole-call rejection the contract asks for.
          if (!res.ok) throw new MemoryRecordError(res.error, { item_index: res.item_index })
          for (const row of res.results) {
            if (row.verdict === 'recorded') batch.record('record_memory', { id: row.id })
          }
          return res
        }),
      )

      const results = audited.value.results.map(row => ({
        index: row.index,
        verdict: row.verdict,
        id: row.id,
        neighbors: row.neighbors.map(neighbor => ({
          id: neighbor.id,
          summary: neighbor.summary,
          guidance: neighborJudgmentGuidance(neighbor.id),
        })),
      }))
      const anyNeighbor = results.some(row => row.neighbors.length > 0)
      return toolSuccess(await writeReceipt(snap, deps, audited, {
        tool: 'record_memory',
        writePath: 'memory',
        domain: {
          results,
          ...anyNeighbor ? { note: MEMORY_SUPERSEDE_NOTE } : {},
        },
      }))
    },
  )
}

/** Registers the memory family (one tool today). */
export const registerMemoryTools: ToolRegistrar = (server, deps) => {
  registerRecordMemory(server, deps)
}

/** The memory family's descriptor card (#115): its names and registrar bound in
 * one place, for `tools/index.ts` to compose — never a second copy of either key. */
export const MEMORY_TOOL_FAMILY: ToolFamily = { names: MEMORY_TOOL_NAMES, register: registerMemoryTools }

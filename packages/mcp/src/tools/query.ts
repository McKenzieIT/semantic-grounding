/**
 * `create_verified_query` / `update_verified_query` — ADR-0025 R7's write
 * pair (the verified query is Destination ③'s analysis-first fact shape:
 * what a practice memory becomes once a human states the 口径 or a source
 * fixes it). Tool 31 and 32 of the surface.
 *
 * ## Shape (#132's constraint, honored by construction)
 *
 * Both are top-level **object** inputSchemas with flat fields (ADR-0025 R7
 * names the shape once for the pair: `{name, question, alt_questions?, sql,
 * uses[], description?, evidence, evidence_source?, memory_ids?}` + the
 * Tier-2 common block) — never a `discriminatedUnion`/`oneOf`, so the #132
 * guard's every-tool-has-top-level-`properties` rule covers them naturally.
 * The update verb adds the required `expected_version` and is a full-payload
 * replace: the pair shares one schema body, and a query is small enough that
 * the ADR's single listed shape IS the update shape (no fields-overlay
 * apparatus — that is `update_definition`'s apparatus, not this pair's).
 *
 * ## Evidence narrowed to ①② (ADR-0025 R3)
 *
 * `evidence` is required (writing a verified query IS a promotion claim) and
 * only ① `source` (with `evidence_source` naming the deterministic source)
 * and ② `user-stated` count. ③ `replicated` is refused AT THE DOOR — the
 * #136 server-side guard is deliberately not run (two agents independently
 * choosing the same 口径 is not agreement), and the refusal message points
 * at `record_memory(type: practice)` as where that 口径 belongs until a
 * human states it or a source fixes it.
 *
 * ## memory_ids → same-commit `promoted` (the #136 mechanism, reused)
 *
 * `memory_ids` is optional (the practice entries this 口径 was promoted
 * FROM). Absent, the call is a plain single write (no batch wrapper — the
 * commit shape matches any ordinary create). Present, the write and the
 * `promoted: [{to, at, session}]` appends onto every cited memory land in
 * ONE `beginBatch` commit (ADR-0023 R6), with the citation riding the
 * `X-SG-Memory` trailer — `appendPromotionBackpointers` and
 * `evidenceForIntent` are the #136 machinery, unchanged. The substrate's
 * `writeVerifiedQuery` validates the cited ids (existence only) before its
 * first write, so the append cannot hit a missing file.
 *
 * ## Receipts
 *
 * The receipt carries `version` (the query file's sha256 — the update verb's
 * next baseline) and a one-sentence `_guidance` (ADR-0025 R7: the
 * practice-memory pointer). That `_guidance` is the pair's own — NOT the
 * phase-model `_guidance` the seven seeding tools' receipts carry
 * (`GUIDANCE_TOOL_NAMES`); it rides the write envelope's domain keys, which
 * is sanctioned because the pair never enters the phase gate (ADR-0024 R7's
 * "one field, two semantics" refusal was about read tools and memory hints —
 * this is the ADR-0025 R7-ruled write-receipt sentence, rendered at the
 * same key so hosts need no second channel).
 *
 * @module tools/query
 */
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { ScopeBinding } from '../binding.ts'
import { DefinitionAlreadyExistsError, DefinitionNotFoundError, DefinitionValidationError } from '../errors.ts'
import type { ServerDeps, ToolRegistrar } from '../server.ts'
import { assertScopeMatch, auditedWrite, toolSuccess, withAuditedBatch, writeReceipt } from './audited.ts'
import { appendPromotionBackpointers, evidenceForIntent } from './promotion.ts'
import { CREATE_COMMON_FIELDS, UPDATE_COMMON_FIELDS, type PromotionEvidenceInput, type ToolFamily } from './shared.ts'

/** The verified-query family's two tool names, verb order matching the definition pair's convention. */
export const QUERY_TOOL_NAMES = ['create_verified_query', 'update_verified_query'] as const

// ── Partition-date-literal detection (ADR-0025 R2) ────────────────────────────

/**
 * Candidate date-shaped literals in SQL text, quoted or bare. The 口径 (the
 * landed detection rule, recorded in ADR-0025's Update): a string literal
 * (single- or double-quoted) or a bare token matching `YYYYMMDD` (the ds
 * partition spelling) or `YYYY-MM-DD`, ANYWHERE in the SQL — a date-shaped
 * literal is presumed to be a partition date, because a verified query is
 * written for any period, never the one it was first run on. Non-date
 * numbers (a `10000000` threshold, a 10-digit timestamp) do not match; the
 * blessed parameter form `${start_ds}` contains no date-shaped literal.
 */
const DATE_LITERAL_CANDIDATES: readonly RegExp[] = [
  /(['"])(\d{4}-\d{2}-\d{2})\1/g,
  /(['"])(\d{8})\1/g,
  /(?<![\w.])(\d{4}-\d{2}-\d{2})(?![\w.])/g,
  /(?<![\w.])(\d{8})(?![\w.])/g,
]

/**
 * Is one candidate a plausible calendar date? Keeps an 8-digit threshold
 * like `12345678` (month 34) out of the refusal — only year 1900–2100,
 * month 01–12, day 01–31 count. February nuances and real calendar length
 * are deliberately not modeled: the parameterization rule is about shape,
 * not about which dates exist.
 */
function plausibleCalendarDate(candidate: string): boolean {
  const dashed = candidate.includes('-')
  const year = Number(candidate.slice(0, 4))
  const month = Number(dashed ? candidate.slice(5, 7) : candidate.slice(4, 6))
  const day = Number(dashed ? candidate.slice(8, 10) : candidate.slice(6, 8))
  return year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31
}

/**
 * Find the partition-date literals in a SQL text (ADR-0025 R2's refusal
 * input): every date-shaped literal — quoted or bare, `YYYYMMDD` or
 * `YYYY-MM-DD`, calendar-plausible — in first-occurrence order, deduplicated.
 * Exported standalone so the detection口径 has its own focused tests, the
 * same rule `rankDefinitions` follows.
 * @param sql - the query's SQL body.
 * @returns the offending literals (empty = clean, parameterized SQL).
 */
export function findPartitionDateLiterals(sql: string): string[] {
  const seen = new Set<string>()
  for (const pattern of DATE_LITERAL_CANDIDATES) {
    pattern.lastIndex = 0
    for (const match of sql.matchAll(pattern)) {
      const candidate = match[2] ?? match[1]
      if (candidate === undefined) continue
      if (plausibleCalendarDate(candidate)) seen.add(candidate)
    }
  }
  return [...seen]
}

/**
 * The zod half of ADR-0025 R2: a `sql` carrying a partition-date literal is
 * refused with the parameterization remedy.
 */
function assertNoPartitionDateLiterals(sql: string, ctx: z.RefinementCtx): void {
  const found = findPartitionDateLiterals(sql)
  if (found.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: `sql contains partition-date literal(s) ${found.join(', ')} — a verified query is written for any period, never the one it was first run on: parameterize them (e.g. \${start_ds}) and let the caller bind the window (ADR-0025 R2)`,
    })
  }
}

// ── Input schemas ─────────────────────────────────────────────────────────────

/**
 * The query payload fields both verbs share (flat at the top level,
 * ADR-0025 R7's one shape). `uses` is the writer-declared forward reference:
 * ≥1 anchor into the fact layer, bare-or-prefixed, existence-checked at
 * write time against the current graph (the `record_memory` anchor rule —
 * a dangling use refuses the call).
 */
const VERIFIED_QUERY_FIELDS = {
  name: z.string().min(1)
    .describe('The query\'s identity key (becomes queries/<name>.yaml and the node id query:<name>). No rename tool — choose it once.'),
  question: z.string().min(1)
    .describe('The business question this query answers, in the words an analyst would search for (e.g. "大R 留存").'),
  alt_questions: z.array(z.string().min(1)).optional()
    .describe('同问异说 — other phrasings of the same question, indexed for search. Not aliases: resolve_alias never returns a query (ADR-0025 R6④).'),
  sql: z.string().min(1).superRefine(assertNoPartitionDateLiterals)
    .describe('The SQL itself — it IS the body (the 正本 lives here, ADR-0025 R2). Partition dates MUST be parameterized (e.g. ${start_ds}); a date literal (20260729, \'2026-07-29\') is refused.'),
  uses: z.array(z.string().min(1)).min(1)
    .describe('The fact-layer anchors this query runs over (ADR-0025 R6, the record_memory anchor grammar), ≥1, writer-declared (SG never parses the SQL to derive them), each must EXIST at write time: a node ("table:dws_x"), a column fragment ("table:dws_x#r_level" — the column must exist), or an edge ("table:a -joins-> table:b"). Bare names accepted, canonical prefixed form stored.'),
  description: z.string().optional()
    .describe('Optional free-text context (what the 口径 chose and why it holds).'),
  evidence: z.enum(['source', 'user-stated', 'replicated'])
    .describe('What licenses this verified query (ADR-0025 R3, narrowed to two): "source" = a deterministic source fixes the 口径 (DDL / column comment / doc / code — name it in evidence_source), "user-stated" = a human stated it in the conversation. "replicated" is REFUSED: two agents independently choosing the same 口径 is not agreement — record it as practice memory via record_memory(type: practice) and promote once a human states it or a source fixes it.'),
  evidence_source: z.string().min(1).optional()
    .describe('Required iff evidence="source": where the deterministic source is, named concretely (e.g. "dws_x.r_level 的列注释"). Rides the X-SG-Evidence-Source trailer.'),
  memory_ids: z.array(z.string().min(1)).optional()
    .describe('Optional: the practice memory ids (mem-<YYYYMMDD>-<8 base32>) this 口径 was promoted from. The commit carries X-SG-Memory and each cited memory gains a promoted back-pointer to query:<name> in the same commit (the #136 mechanism). Existence-checked; no replication proof required for ①/②.'),
} as const

/**
 * The cross-field rules one flat shape cannot express in field schemas
 * (ADR-0025 R3/R7): ③ replicated refused at the door with the practice
 * pointer; ① source must name its 出处; the 出处 belongs to ① alone.
 */
function verifiedQueryEvidenceRules(v: { readonly evidence: string; readonly evidence_source?: string | undefined; readonly memory_ids?: readonly string[] | undefined }, ctx: z.RefinementCtx): void {
  if (v.evidence === 'replicated') {
    ctx.addIssue({
      code: 'custom',
      message: 'evidence "replicated" cannot license a verified query (ADR-0025 R3: a 口径 is agreed, not observed — two agents independently choosing the same one is replication, not verification). Record the 口径 as a practice memory via record_memory(type: practice) and promote it once a human states it or a deterministic source fixes it.',
    })
  }
  if (v.evidence === 'source' && v.evidence_source === undefined) {
    ctx.addIssue({ code: 'custom', message: 'evidence "source" requires evidence_source — name where the deterministic source is (DDL / column comment / documentation / code)' })
  }
  if (v.evidence !== 'source' && v.evidence_source !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'evidence_source only applies to evidence "source"' })
  }
}

/** `create_verified_query`'s input — the flat payload + the create-class common block (no expected_version). */
const CreateVerifiedQueryInputSchema = z.object({
  ...CREATE_COMMON_FIELDS,
  ...VERIFIED_QUERY_FIELDS,
}).strict().superRefine(verifiedQueryEvidenceRules)

/** `update_verified_query`'s input — the same flat payload + the update-class common block (expected_version required; the payload replaces the stored query wholesale). */
const UpdateVerifiedQueryInputSchema = z.object({
  ...UPDATE_COMMON_FIELDS,
  ...VERIFIED_QUERY_FIELDS,
}).strict().superRefine(verifiedQueryEvidenceRules)

// ── The shared handler body ──────────────────────────────────────────────────

/** The receipt's one-sentence `_guidance` (ADR-0025 R7): where a self-chosen 口径 belongs. */
const VERIFIED_QUERY_GUIDANCE = 'A 口径 you chose yourself is not verified yet (two agents agreeing is not agreement): record it via record_memory(type: practice) and promote it here once a human states it or a deterministic source fixes it.'

/** The flat tool input as the shared body reads it back. */
interface VerifiedQueryInput {
  readonly name: string
  readonly question: string
  readonly alt_questions?: readonly string[] | undefined
  readonly sql: string
  readonly uses: readonly string[]
  readonly description?: string | undefined
  readonly evidence: 'source' | 'user-stated' | 'replicated'
  readonly evidence_source?: string | undefined
  readonly memory_ids?: readonly string[] | undefined
  readonly summary: string
  readonly derivation: 'agent' | 'llm'
  readonly confidence: number
}

/**
 * The flat `evidence`/`evidence_source`/`memory_ids` fields folded onto the
 * #136 per-call intent channel's block — same trailers (`X-SG-Evidence`,
 * `X-SG-Evidence-Source`, `X-SG-Memory`), same `AuditIntent.evidence` route.
 * ③ never reaches here (the schema refused it at the door).
 */
function queryEvidenceForIntent(input: VerifiedQueryInput): PromotionEvidenceInput {
  return {
    kind: input.evidence,
    ...input.evidence === 'source' && input.evidence_source !== undefined ? { source: input.evidence_source } : {},
    ...input.memory_ids !== undefined ? { memories: [...input.memory_ids] } : {},
  }
}

/** The Core write's outcome union, as the narrowing assertion below reads it. */
type QueryWriteOutcome = { readonly ok: true; readonly version: string } | { readonly ok: false; readonly error: string }

/**
 * The `{ok:false}` arm → the coded error, INSIDE the wrapped fn so a
 * refused write can never be followed by a `promoted` append (the
 * `assertUpdateOk`-inside-`fn` pattern #136 established). Asserts rather
 * than throws-and-returns so the caller's `version` read narrows.
 */
function assertQueryWriteOk(result: QueryWriteOutcome, name: string): asserts result is { readonly ok: true; readonly version: string } {
  if (result.ok) return
  throw new DefinitionValidationError(result.error, { kind: 'query', name })
}

/**
 * The draft the Core takes, assembled once (exactOptionalPropertyTypes: an
 * absent optional stays absent, never an explicit undefined).
 */
function draftOf(input: VerifiedQueryInput): { readonly name: string; readonly question: string; readonly sql: string; readonly uses: readonly string[]; readonly alt_questions?: readonly string[]; readonly description?: string } {
  return {
    name: input.name,
    question: input.question,
    sql: input.sql,
    uses: input.uses,
    ...input.alt_questions !== undefined ? { alt_questions: input.alt_questions } : {},
    ...input.description !== undefined ? { description: input.description } : {},
  }
}

/**
 * The pair's shared body: audit window over (optionally) one batch — the
 * query write through the Core's validated seam, and when `memory_ids` is
 * present, the `promoted` back-pointer appends inside the SAME commit.
 */
async function landVerifiedQuery(
  snap: ScopeBinding,
  deps: ServerDeps,
  ctx: ServerContext,
  tool: 'create_verified_query' | 'update_verified_query',
  input: VerifiedQueryInput,
  expectedVersion: string | undefined,
) {
  const memoryIds = input.memory_ids ?? []
  const draft = draftOf(input)
  return auditedWrite(
    snap,
    ctx,
    { tool, target: input.name, summary: input.summary, derivation: input.derivation, confidence: input.confidence, ...evidenceForIntent(queryEvidenceForIntent(input)) },
    async () => {
      if (memoryIds.length === 0) {
        // No citation: a plain single write, no batch wrapper — the commit
        // shape matches any ordinary create/update byte for byte.
        const res = await snap.core.writeVerifiedQuery(draft, expectedVersion !== undefined ? { expectedVersion } : {})
        assertQueryWriteOk(res, input.name)
        return res
      }
      // ADR-0023 R6's 同一 commit: the query write AND every cited memory's
      // `promoted` append land in one beginBatch commit (the #136 mechanism;
      // the substrate validated the ids before its first write).
      return withAuditedBatch(snap, async (batch) => {
        const res = await snap.core.writeVerifiedQuery(draft, { ...expectedVersion !== undefined ? { expectedVersion } : {}, memoryIds })
        assertQueryWriteOk(res, input.name)
        await appendPromotionBackpointers(snap, deps, [...memoryIds], [`query:${input.name}`])
        // One logical write: the promotion itself, its back-pointers included.
        batch.record('promote', { tos: [`query:${input.name}`] })
        return res
      })
    },
  )
}

// ── create_verified_query ─────────────────────────────────────────────────────

function registerCreateVerifiedQuery(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'create_verified_query',
    {
      title: 'Create a verified query',
      description: 'Promote a 口径 into the fact layer as a verified query (ADR-0025): a business question paired with the SQL that answers it, stored as its own definition kind (queries/<name>.yaml, node id query:<name>) so two agents asking the same question a week apart get the same number. The SQL is the body and dates are parameterized (${start_ds}); `uses` names the fact-layer anchors it runs over (writer-declared, existence-checked). Evidence only counts as "source" (name it in evidence_source) or "user-stated" — "replicated" is refused: record a self-chosen 口径 as practice memory (record_memory) instead. cite memory_ids when promoting FROM practice entries: the commit carries X-SG-Memory and each cited memory gains a promoted back-pointer in the same commit. searchable immediately (search_definitions indexes the question, alt_questions and description; get_definition on a used table/concept lists it under verified_queries).',
      inputSchema: CreateVerifiedQueryInputSchema,
    },
    async (input, ctx: ServerContext) => {
      const snap = deps.bindings.requireSnapshot()
      assertScopeMatch(snap, input.scope_id)
      if (snap.core.loadQueryDefinition(input.name) !== null) {
        throw new DefinitionAlreadyExistsError(`query "${input.name}" already exists — use update_verified_query to change it`, { kind: 'query', name: input.name })
      }
      const res = await landVerifiedQuery(snap, deps, ctx, 'create_verified_query', input, undefined)
      return toolSuccess(await writeReceipt(snap, deps, res, {
        tool: 'create_verified_query',
        writePath: 'query',
        version: res.value.version,
        domain: { _guidance: VERIFIED_QUERY_GUIDANCE },
      }))
    },
  )
}

// ── update_verified_query ─────────────────────────────────────────────────────

function registerUpdateVerifiedQuery(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'update_verified_query',
    {
      title: 'Update a verified query',
      description: 'Replace one verified query\'s payload wholesale (ADR-0025 R7: one shape for the pair — every field you omit reverts to its default, so re-send the full question/alt_questions/sql/uses/description). Requires expected_version from get_definition(kind:\'query\'); a stale baseline is rejected as stale_baseline — re-read and retry. The same evidence rules as create apply (source with its 出处, or user-stated; replicated refused). Changing the query changes the QUERY\'s fingerprint only — never a used table\'s (uses is a forward reference; tables store no back-link), so a table\'s expected_version survives this call. memory_ids re-cites practice entries for promoted back-pointers in the same commit.',
      inputSchema: UpdateVerifiedQueryInputSchema,
    },
    async (input, ctx: ServerContext) => {
      const snap = deps.bindings.requireSnapshot()
      assertScopeMatch(snap, input.scope_id)
      if (snap.core.loadQueryDefinition(input.name) === null) {
        throw new DefinitionNotFoundError(`no query named "${input.name}"`, { kind: 'query', name: input.name })
      }
      const res = await landVerifiedQuery(snap, deps, ctx, 'update_verified_query', input, input.expected_version)
      return toolSuccess(await writeReceipt(snap, deps, res, {
        tool: 'update_verified_query',
        writePath: 'query',
        version: res.value.version,
        domain: { _guidance: VERIFIED_QUERY_GUIDANCE },
      }))
    },
  )
}

/** Registers the verified-query family. */
export const registerQueryTools: ToolRegistrar = (server, deps) => {
  registerCreateVerifiedQuery(server, deps)
  registerUpdateVerifiedQuery(server, deps)
}

/** The verified-query family's descriptor card (#115): its names and registrar bound in
 * one place, for `tools/index.ts` to compose — never a second copy of either key. */
export const QUERY_TOOL_FAMILY: ToolFamily = { names: QUERY_TOOL_NAMES, register: registerQueryTools }

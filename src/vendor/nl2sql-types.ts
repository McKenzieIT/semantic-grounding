/**
 * P13b NL→SQL engine — types. Ported from the throwaway
 * `prototypes/p13-nl2sql-engine/types.mjs` to production TS.
 *
 * Consumes the P6 semantic-layer substrate's `EventDefinition.params_fields` /
 * `TableDefinition.partitions` as the critic's guard-data source (the local
 * `CriticGuardData` interface stands in for P6 production until P5b/P6b ship —
 * P13b grilling Q1; the swap is additive, seam contract unchanged).
 *
 * `QueryOutcome` 3-state aligns with P4 `packages/query/query/src/types.ts`
 * (done+result_id / running+instance_id / failed+error+failureKind). Production
 * runtime consumes the real `ctx.query` `QueryOutcome` via the agent loop (P7b);
 * the eval runner (P13b grilling Q3) uses the local 3-state shape against the
 * stand-in ODPS.
 *
 * `GateResult` aligns with P7 `phases.py:33` — the critic hangs on P7's
 * `sql_syntax_gate` slot at `agent/turn-stopping` (P13b grilling Q2: critic
 * logic + `GateResult` live HERE in `packages/data/nl2sql-engine/`; P7b's phase-gate
 * slot delegates to `critiqueSql`).
 *
 * @module @deepseek-ai/dsh-nl2sql-engine/src/types
 */

// ── config (ported from RBI v2-baseline.md §1 + phases.py + §5) ──────────
// LOCKSTEP NOTE: MAX_SQL_PER_TURN + MAX_FEEDBACK_RETRIES are rendered into the
// GENERATION prompt as literals (src/prompt.ts). Production enforcement of the
// same budgets lives in the phase-gate's PipelineConfig (max_executions_per_turn
// / max_llm_calls_per_turn). These constants MUST be kept in lockstep with
// PipelineConfig — if the gate's enforced budgets change, update these prompt-
// displayed literals to match, else the model sees stale guidance that diverges
// from the enforced gate. (Adherence: No-hardcoded-tunables — conservative note
// path; sourcing them from a shared Config field is deferred to avoid new wiring.)
export const MAX_SQL_PER_TURN = 8 // v2-baseline.md:5 exploration budget (phases.py:124 max_executions_per_turn)
/** Max self-correction retries before honest decline (v2-baseline.md §5). */
export const MAX_FEEDBACK_RETRIES = 2 // v2-baseline.md §5: self-correct N times then decline

// ── GateResult (aligns P7 phases.py:33) ───────────────────────────────────
/** The phase-gate verdict (aligns P7 phases.py:33): pass/fail + reason. */
export class GateResult {
  constructor(public readonly passed: boolean, public readonly reason: string | null = null) {}

  /**
   * Construct a passing gate result.
   *
   * @param reason - Optional pass reason (null when none).
   * @returns A passing GateResult.
   */
  static pass(reason: string | null = null): GateResult {
    return new GateResult(true, reason)
  }

  /**
   * Construct a failing gate result.
   *
   * @param reason - The failure reason.
   * @returns A failing GateResult.
   */
  static fail(reason: string): GateResult {
    return new GateResult(false, reason)
  }
}

// ── Critic finding (方案 1+4) ─────────────────────────────────────────────
// severity: error → GateResult.fail; warning → GateResult.pass + reason; fail-open → pass
/** The severity of a critic finding (error → fail; warning → pass + reason). */
export type CriticSeverity = 'error' | 'warning'

/** A single critic finding: rule id, severity, and human-readable message. */
export class CriticFinding {
  constructor(
    public readonly rule: string,
    public readonly severity: CriticSeverity,
    public readonly message: string,
  ) {}
}

// ── QueryOutcome 3-state (aligns P4 packages/query/query/src/types.ts:38-41) ─
/** The 3-state ODPS query outcome: done+result_id / running+instance_id / failed+error+failureKind. */
export interface QueryOutcome {
  readonly state: 'done' | 'running' | 'failed'
  readonly result_id?: string
  readonly rows?: unknown[]
  readonly instance_id?: string
  readonly stage?: string
  readonly error?: string
  readonly failureKind?: string
  readonly sql?: string
}

// ── FailureKind — normalized lower_snake (code-review-low fix #4: the P13
//    prototype carried mixed-case values — `parse_failed`/`cost_exceeded`
//    lower but `TABLE_NOT_FOUND`/`SEMANTIC_MISMATCH` upper; consumers compare
//    against the constants, so normalizing the values is safe as long as the
//    stand-in + scenarios use the constants, which they do.) ────────────────
/** Normalized lower_snake failure-kind constants (code-review-low fix #4). */
export const FailureKind = Object.freeze({
  PARSE_FAILED: 'parse_failed',
  TABLE_NOT_FOUND: 'table_not_found',
  FIELD_NOT_FOUND: 'field_not_found',
  SEMANTIC_MISMATCH: 'semantic_mismatch',
  PERMISSION_DENIED: 'permission_denied',
  COST_EXCEEDED: 'cost_exceeded',
} as const)
/** The union of all FailureKind constant values. */
export type FailureKind = (typeof FailureKind)[keyof typeof FailureKind]

// §3 阶段D: recoverable → rewrite + retry (must not repeat same SQL; near-dup gate)
/** Recoverable failure kinds → rewrite + retry (must not repeat same SQL; near-dup gate). */
export const RECOVERABLE_FAILURES: readonly FailureKind[] = Object.freeze([
  FailureKind.PARSE_FAILED,
  FailureKind.COST_EXCEEDED,
])
// §3 阶段D: unrecoverable → §5 honest decline (does not consume a retry)
/** Unrecoverable failure kinds → honest decline (does not consume a retry). */
export const UNRECOVERABLE_FAILURES: readonly FailureKind[] = Object.freeze([
  FailureKind.TABLE_NOT_FOUND,
  FailureKind.FIELD_NOT_FOUND,
  FailureKind.SEMANTIC_MISMATCH,
  FailureKind.PERMISSION_DENIED,
])

// ── EvalCase da-fresh schema (aligns G2: borrows only result_value + match_mode + turns;
//    rbi BI-specific fields not reused — G2 review F1) ─────────────────────
/** The 5 EXECUTION match-mode constants (scalar exact / set exact / set subset / value close / null check). */
export const MatchMode = Object.freeze({
  SCALAR_EXACT: 'scalar_exact', // result-set row[0] cell[0] numeric strict equal
  SET_EXACT: 'set_exact', // result-set row set fully equal
  SET_SUBSET: 'set_subset', // result-set is a subset of expected
  VALUE_CLOSE: 'value_close', // numeric close (|actual-expected| < eps)
  NULL_CHECK: 'null_check', // decline / NULL (honest-decline scenario)
} as const)
/** The union of all MatchMode constant values. */
export type MatchMode = (typeof MatchMode)[keyof typeof MatchMode]

// ── Critic guard context (from P6 substrate + retrieval results; NOT conventions) ─
// candidateTables: search_data_sources (BM25 linking) candidate table-name set
// eventParams: EventDefinition.params_fields field-name set (GET_JSON_OBJECT field ∈ params guard)
// partitionCols: TableDefinition.partitions column names (ds-required guard; empty = non-partition DIM, no ds)
/** The critic guard context: candidate tables, event params, and partition cols (from P6 substrate + retrieval). */
export interface CriticCtx {
  readonly candidateTables: Set<string>
  readonly eventParams: Set<string>
  readonly partitionCols: Set<string>
  /** P3 C2: normalized `a|b` pairs the graph declares; undefined => rule skipped (no-op). */
  readonly declaredJoinPairs?: Set<string>
}

/** Options for constructing a critic guard context. */
export interface MakeCriticCtxOptions {
  readonly candidateTables?: readonly string[]
  readonly eventParams?: Record<string, unknown>
  readonly partitionCols?: readonly string[]
  /** P3 C2: declared-join pair set (absent => undeclared-JOIN rule skipped). */
  readonly declaredJoinPairs?: Set<string>
}

/**
 * Build a critic guard context from the P6 substrate + retrieval results:
 * candidate tables, event params, and partition columns (all lowercased).
 *
 * @param options - The guard-data options (candidateTables, eventParams, partitionCols; each defaults to empty).
 * @returns The constructed critic context.
 */
export function makeCriticCtx(options: MakeCriticCtxOptions = {}): CriticCtx {
  const { candidateTables = [], eventParams = {}, partitionCols = [], declaredJoinPairs } = options
  return {
    candidateTables: new Set(candidateTables.map(t => t.toLowerCase())),
    eventParams: new Set(Object.keys(eventParams).map(f => f.toLowerCase())),
    partitionCols: new Set(partitionCols.map(p => p.toLowerCase())),
    ...(declaredJoinPairs !== undefined ? { declaredJoinPairs } : {}),
  }
}

/**
 * The enrichment sweep engine (map #64, ticket #65): ONE iteration body where
 * `enrichment.ts` grew four mirror copies. The engine owns the orchestration
 * and NOTHING kind-specific — name filtering, per-def try/catch discipline,
 * the counter/error-string contract, the two whole-sweep behaviors every
 * family shares (prepare-skip, gain-only write idempotency). Everything that
 * varies by kind or pipeline lives in the {@link EnrichmentKindAdapter}
 * (types.ts) the caller passes in.
 *
 * The free functions with outside dependents are the `enrichAll*` entry
 * points in the adapter files — on-write hooks call them in-process, and dsh
 * (the package exports only `"."`) reaches them through the barrel. The
 * engine here has no such dependents: the adapter files consume it directly,
 * and this module never appears on the public barrel (ADR-0002, ADR-0006
 * ruling 3).
 *
 * @module enrichment/sweep (internal; only `"."` is importable — see ADR-0002)
 */
import type { EnrichmentKindAdapter, SweepOpts } from './types.ts'

/** What one sweep run reports — the shape all four pipeline wrappers always
 * returned (`note` only ever set by a prepare-skip, GA-GT3-6b). */
export interface SweepResult {
  readonly enriched: number
  readonly written: number
  readonly errors: string[]
  readonly note?: string
}

/**
 * Run one enrichment sweep over a kind adapter (map #64's 扫管引擎): prepare →
 * (skip short-circuit) → list → per def [filter → parse-error → discover →
 * veto → (gain-only: zero-gain skip) → merge → write] → counters/errors.
 *
 * Engine-owned invariants, carried verbatim from the four pipelines so the
 * wrappers' contracts hold byte-identically:
 * - `prepare` runs once, before any listing; its throw propagates (setup was
 *   never inside the per-def try), its `skip` returns
 *   `{ enriched: 0, written: 0, errors: [], note: reason }` untouched on disk.
 * - A parse-failed def records `${name}: schema parse failed` and stops there.
 * - The name filter (`names` omit/empty = all) is checked before the parse
 *   error, exactly as the pipelines ordered it.
 * - `writePolicy: 'gain-only'` skips def + write + commit when the post-veto
 *   discovery is empty (alt_labels' zero-commit idempotency, #37).
 * - Counters: a successful write counts `written`; `enriched` counts
 *   successful writes whose merged list is non-empty — for the gain-only
 *   families that is every write (a write implies a gain), for the
 *   always-write relations family it is the "gained >=1 ref" report the
 *   explicit discoverRelations entry always gave.
 * - A write's `{ ok: false }` becomes `${name}: ${error}`; a thrown stage
 *   becomes `${name}: ${message}` — the batch never aborts.
 * @param adapter - the kind adapter driving this sweep.
 * @param semanticLayer - the semantic-layer directory path.
 * @param opts - names filter, merge context (default
 *   `{ mergeExisting: false, preserveCurated: true }`), tier2 (forwarded
 *   verbatim to write), excludeColumnsFn (forwarded to `prepare` only — the
 *   relations adapters park it in their sweep context).
 * @returns the sweep report.
 */
export async function sweepEnrichment<TDef, TItem, TCtx>(
  adapter: EnrichmentKindAdapter<TDef, TItem, TCtx>,
  semanticLayer: string,
  opts: SweepOpts<TDef> = {},
): Promise<SweepResult> {
  const prep = adapter.prepare?.(semanticLayer, opts)
  if (prep?.skip) {
    return { enriched: 0, written: 0, errors: [], note: prep.skip.reason }
  }
  // Invariant (types.ts): a non-undefined TCtx obliges prepare to resolve a
  // context — the stage signatures type it as present on that promise.
  const ctx = prep?.context as TCtx | undefined
  const mergeContext = opts.mergeContext ?? { mergeExisting: false, preserveCurated: true }
  const filter = opts.names !== undefined && opts.names.length > 0 ? new Set(opts.names) : undefined
  let enriched = 0
  let written = 0
  const errors: string[] = []
  for (const listed of adapter.list(semanticLayer)) {
    if (filter !== undefined && !filter.has(listed.name)) continue
    if (listed.parseError) {
      errors.push(`${listed.name}: schema parse failed`)
      continue
    }
    try {
      const discovered = await adapter.discover(listed, ctx as TCtx)
      const kept = adapter.veto(listed, discovered, ctx as TCtx)
      if (adapter.writePolicy === 'gain-only' && kept.length === 0) continue
      const merged = adapter.merge(listed, listed.existing, kept, mergeContext)
      const res = await adapter.write(listed, merged, opts.tier2)
      if (res.ok) {
        written += 1
        if (merged.length > 0) enriched += 1
      } else {
        errors.push(`${listed.name}: ${res.error}`)
      }
    } catch (e) {
      errors.push(`${listed.name}: ${(e as Error).message}`)
    }
  }
  return { enriched, written, errors }
}

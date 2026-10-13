/**
 * The kind-adapter contract for the enrichment sweep engine (map #64, ticket
 * #65). The four mirror pipelines `enrichment.ts` grew (`enrichAllDwsTables`
 * / `enrichAllEvents` / `enrichAllTablesAltLabels` / `enrichAllEventsAltLabels`)
 * are being folded, family by family, onto ONE engine (`sweep.ts`) driven by a
 * per-kind adapter: the engine owns the orchestration (iteration, name filter,
 * counters, error strings, try/catch discipline), the adapter owns the
 * kind+pipeline specifics (how to list/parse defs, how to discover, veto,
 * merge, write).
 *
 * Composition, NOT plugin extension: `DataSourceKindPlugin` (kinds/) is the
 * registry's read-projection seam; this interface is internal to the
 * enrichment sweep. Nothing about it reaches the public barrel (ADR-0002;
 * ADR-0006 ruling 3 — pure functions and their plumbing stay off `index.ts`).
 *
 * The free-function surface is the contract, byte-identical through the
 * migration (on-write hooks and dsh depend on it); the adapter/engine split
 * below is entirely internal. The relations family (#66) must fit this
 * interface without reshaping it — that fitness is what #65's alt_labels
 * first migration exists to prove.
 *
 * @module enrichment/types (internal; only `"."` is importable — see ADR-0002)
 */
import type { Tier2Opts } from '../io.ts'

/**
 * The merge semantics a sweep runs under, threaded by the engine into
 * {@link EnrichmentKindAdapter.merge}. The ADAPTER decides what these mean
 * for its pipeline: the relations family reads both flags (merge-existing =
 * the on-write hook's never-wipe mode; preserve-curated = the origin-aware
 * replace default, GA-GT3 item 5 / 5b), the alt_labels family ignores them
 * (its merge is a plain union that never removes a curated label).
 */
export interface MergeContext {
  readonly mergeExisting: boolean
  readonly preserveCurated: boolean
}

/**
 * What a sweep-level `prepare` returned: resolved cross-target context, or a
 * whole-sweep skip. The engine turns `skip` into
 * `{ enriched: 0, written: 0, errors: [], note: reason }` without touching a
 * single file — the relations family uses this for "no DIM tables in scope,
 * nothing to enrich" (GA-GT3 item 6); an alt_labels sweep never skips.
 */
export interface SweepPrepare<TCtx> {
  readonly context?: TCtx
  readonly skip?: { readonly reason: string }
}

/**
 * One sweep candidate that parsed: everything every adapter stage may need —
 * the semantic-layer root (write needs it), the def's corpus name (error
 * strings, write addressing), the raw YAML dict (write preserves it
 * verbatim; the relations merge reads refs off it), the parsed definition,
 * and the pipeline's existing enrichment items (what `merge` unions into).
 */
export interface SweepTarget<TDef, TItem> {
  /** Discriminant: this target parsed (the parse-error variant sets `true`). */
  readonly parseError?: false
  readonly semanticLayer: string
  readonly name: string
  readonly raw: Record<string, unknown>
  readonly def: TDef
  readonly existing: readonly TItem[]
}

/** One sweep candidate whose YAML failed its definition schema. The engine
 * records `${name}: schema parse failed` and moves on — the same
 * fail-tolerant per-def discipline the four pipelines always had. */
export type ListedTarget<TDef, TItem> = SweepTarget<TDef, TItem> | { readonly name: string; readonly parseError: true }

/**
 * Write outcome an adapter's {@link EnrichmentKindAdapter.write} returns —
 * structurally `io.ts`'s `WriteTableResult` / `WriteEventYamlResult`
 * (`{ ok: true, path }` on success, `{ ok: false, error }` on a domain
 * rejection), so both write primitives' results pass through unchanged.
 */
export type EnrichmentWriteOutcome = { ok: true; path: string } | { ok: false; error: string }

/**
 * Options for one engine run. Fields are `| undefined` so wrappers can
 * forward their own optional parameters verbatim (exactOptionalPropertyTypes).
 * Generic over the def type so the relations family's `excludeColumnsFn`
 * (ticket #66, CL-18 Phase 2) keeps its per-kind parameter type end-to-end —
 * a pure passthrough slot: the engine hands `opts` to `prepare` and nothing
 * else; the relations adapters move the function from here into their sweep
 * context and apply it in `discover`.
 */
export interface SweepOpts<TDef = unknown> {
  /** Optional definition-name filter; omit/empty = every definition of the kind. */
  readonly names?: readonly string[] | undefined
  /** Merge semantics threaded into `merge`; defaults to `{ mergeExisting: false, preserveCurated: true }`. */
  readonly mergeContext?: MergeContext | undefined
  /** Optional Tier-2 options; forwarded to the adapter's `write`. */
  readonly tier2?: Tier2Opts | undefined
  /** Optional per-def exclude-set builder (CL-18 Phase 2, relations only): the
   * calling layer computes a target's noise-JOIN exclusion (e.g. its partition
   * columns) from the target's metadata; the adapter forwards it to its
   * deterministic round. */
  readonly excludeColumnsFn?: ((def: TDef) => ReadonlySet<string> | undefined) | undefined
}

/**
 * A kind adapter: everything one enrichment pipeline family knows about its
 * kind, minus the orchestration. Four stages (`discover` → `veto` → `merge`
 * → `write`, map #64 中粒度裁决) + the sweep-level `prepare` + the
 * listing/projection seam (`list`). Two invariant obligations:
 *
 * - a non-`undefined` `TCtx` requires `prepare` to return a `context` — the
 *   engine types the stage ctx as `TCtx` on the strength of that promise;
 * - `list` must parse-then-project in corpus order and keep parse-failed
 *   defs as parse-error targets (never drop them silently) — the engine's
 *   error list is the contract.
 */
export interface EnrichmentKindAdapter<TDef, TItem, TCtx = undefined> {
  /** Which corpus kind this adapter sweeps — diagnostics/readout only today. */
  readonly kind: 'table' | 'event'
  /**
   * Write policy: `'gain-only'` skips the write (and the commit) entirely
   * when the post-veto discovery is empty — the alt_labels family's
   * zero-commit idempotency (#37: an all-vetoed round leaves files
   * untouched). `'always'` writes every swept def — the relations family's
   * refresh mode (machine refs are rewritten even when this round found
   * nothing new, so stale machine refs age out). Drives the engine's only
   * pipeline-family branch.
   */
  readonly writePolicy: 'gain-only' | 'always'
  /**
   * Sweep-level setup: build cross-target context once (the alt_labels
   * family loads the corpus veto word list here; the relations family builds
   * its DIM inventory + excludeColumnsFn here, #66) or skip the whole sweep
   * with an agent-visible reason. Runs before any def is listed; a throw propagates
   * (the pipelines always ran their setup outside the per-def try).
   */
  prepare?(semanticLayer: string, opts: SweepOpts<TDef>): SweepPrepare<TCtx>
  /**
   * List this kind's sweep candidates: load the corpus, schema-parse each
   * def, project `existing` (what `merge` unions into). Corpus order; a
   * parse failure becomes a parse-error target, not a dropped def.
   */
  list(semanticLayer: string): readonly ListedTarget<TDef, TItem>[]
  /**
   * Stage 1 — discover candidate enrichment items for one target
   * (deterministic round only — the LLM half of enrichment lives in the
   * agent-driven ask-answer pair, `enrichment-work.ts`, not in-process).
   */
  discover(target: SweepTarget<TDef, TItem>, ctx: TCtx): Promise<readonly TItem[]>
  /**
   * Stage 2 — the suppression exit (#36 输入 2, ADR-0010): filter the
   * discovered candidates. Runs AFTER discovery and BEFORE the merge,
   * whichever round proposed an item. Receives the sweep ctx (the
   * alt_labels veto needs the corpus word list; the relations veto is
   * per-def only).
   */
  veto(target: SweepTarget<TDef, TItem>, discovered: readonly TItem[], ctx: TCtx): readonly TItem[]
  /**
   * Stage 3 — merge the kept candidates into the target's existing items
   * under the passed {@link MergeContext}; the adapter alone decides what
   * the flags mean for its family (see MergeContext).
   */
  merge(target: SweepTarget<TDef, TItem>, existing: readonly TItem[], discovered: readonly TItem[], mergeContext: MergeContext): readonly TItem[]
  /**
   * Stage 4 — persist the merged items for one target (writeTable /
   * writeEventYaml under the hood, raw dict preserved verbatim so only the
   * enrichment key changes). `tier2` present = the audited write-and-record
   * path (ADR-0004 ruling 2).
   */
  write(target: SweepTarget<TDef, TItem>, merged: readonly TItem[], tier2?: Tier2Opts): Promise<EnrichmentWriteOutcome>
}

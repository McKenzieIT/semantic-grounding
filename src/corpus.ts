/**
 * Corpus enrichment — pure projection from semantic-layer events to a retrieval
 * corpus. Packs `params_fields` (field name + field description) + `alt_labels`
 * (SKOS aliases from definition) into the indexed `description`; does NOT index
 * `domain` (probe refuted it).
 *
 * The output shape (`EventCorpusItem`) is structurally identical to the
 * retrieval sinks — `DataSourceDoc` (nl2sql-engine `Bm25Linker`) and
 * `RetrievalCorpusItem` (retrieval-inproc `HybridRetriever`): all are
 * `{ id, description?, metrics?, payload? }`. No runtime dep on either: the
 * `Bm25Linker`/`HybridRetriever` `buildCorpus` applies field weights as token
 * repetition over this shape, so a richer `description` raises recall without
 * touching `FIELD_WEIGHTS`.
 *
 * @module @deepseek-ai/dsh-semantic-layer/src/corpus
 */

/** Event projected to the fields the retrieval corpus indexes — a subset of
 * `RawEvent.raw` / `EventDefinition`. `domain` is deliberately absent: it is
 * not indexed (probe refuted it). */
export interface EventCorpusInput {
  /** Event name (becomes the corpus `id`). */
  readonly name: string
  /** Short human description; indexed ×1 (per the sink's description field weight). */
  readonly description?: string
  /** Per-field `{ type, description }`; the field name + description are packed
   * into the indexed text — this is where the rich semantic content lives. */
  readonly params_fields?: Readonly<Record<string, { readonly description?: string }>>
  /** SKOS altLabel aliases from the definition's `alt_labels` field. */
  readonly alt_labels?: readonly string[]
  /** Metric definitions keyed by name; the metric names are carried through for
   * the sink to index (×1 / ×4 per the sink's metric field weight). */
  readonly metrics?: Readonly<Record<string, unknown>>
}



/** A corpus item the retriever indexes (DataSourceDoc / RetrievalCorpusItem-shaped). */
export interface EventCorpusItem {
  /** Unique identifier (event name); repeated by the sink's `id`/`name` field weight. */
  readonly id: string
  /** Enriched description (event desc + params_fields name+desc + terminology
   * slang); repeated by the sink's description field weight. */
  readonly description?: string
  /** Metric definitions keyed by name; each name is repeated by the sink's metric field weight. */
  readonly metrics?: Readonly<Record<string, unknown>>
  /** Opaque payload — the original event (short description + params_fields) carried through to the hit. */
  readonly payload?: unknown
}



/**
 * Is `v` a plain (non-array, non-null) object? Used to guard unvalidated raw
 * YAML field values (a `params_fields` entry that is a string/array/null is
 * skipped, mirroring the probe's `if not isinstance(fdef, dict): continue`).
 * @param v - the value to test.
 * @returns true when `v` is a non-null, non-array object.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Build the per-field params text: each field name + (non-empty) field
 * description, space-joined. Mirrors probe_hypotheses.py `params_text`; a
 * non-object field value is skipped entirely (no stray field-name token).
 */
function paramsText(paramsFields: Readonly<Record<string, { readonly description?: string }>> | undefined): string {
  if (!paramsFields) return ''
  const out: string[] = []
  for (const [fname, fdef] of Object.entries(paramsFields)) {
    if (!isPlainObject(fdef)) continue // mirror probe: non-dict field value -> skip
    out.push(fname)
    const d = (fdef as { description?: unknown }).description
    if (typeof d === 'string' && d) out.push(d)
  }
  return out.join(' ')
}

/** D2h (2026-08-21): the enrichment variant — which slices of each event pack
 * into the indexed `description`. `params+term` (default, the D2e-shipped form)
 * packs the event description + params_fields (field name + desc) + terminology
 * slang; `term-only` packs the event description + terminology slang ONLY
 * (drops params_fields — the D2g verdict (A) higher-recall form on the shipped
 * Bm25Linker: 77.0% strict vs params+term 68.1% on 113 gold; best
 * term@topK=20 = 85.0%). `params-only` is NOT shipped (D2g measured it 63.7%
 * strict, strictly worse than params+term 68.1% + degenerate with
 * params+term-on-no-slang); a future ticket can add it as a non-breaking enum
 * extension. The variant is a mount-time SemanticLayerConfig choice (not
 * mid-session); switching it remounts the Service (new WeakMap key -> fresh
 * enriched linker), so it is NOT part of the D2f corpusVersion cache key. */
export type CorpusVariant = 'params+term' | 'term-only'

/**
 * Build an enriched retrieval corpus from semantic-layer events. Each item's
 * `description` packs the event description + alt_labels (SKOS aliases from
 * the definition); `params+term` (default) ALSO packs params_fields (field
 * name + field description). `term-only` drops params_fields. `domain` is NOT
 * indexed (probe refuted it). The original event is carried as `payload`.
 * @param events - the events to project (RawEvent.raw / EventDefinition subset).
 * @param variant - which slices to pack: 'params+term' (default, shipped) or 'term-only'.
 * @returns corpus items ready for `Bm25Linker` / `HybridRetriever` indexing.
 */
export function buildRetrievalCorpus(
  events: readonly EventCorpusInput[],
  variant: CorpusVariant = 'params+term',
): readonly EventCorpusItem[] {
  return events.map((ev) => {
    const parts: string[] = []
    if (ev.description) parts.push(ev.description)
    if (variant !== 'term-only') {
      const pt = paramsText(ev.params_fields)
      if (pt) parts.push(pt)
    }
    if (ev.alt_labels) for (const s of ev.alt_labels) parts.push(s)
    return {
      id: ev.name,
      description: parts.join(' '),
      ...(ev.metrics !== undefined ? { metrics: ev.metrics } : {}),
      payload: ev,
    }
  })
}

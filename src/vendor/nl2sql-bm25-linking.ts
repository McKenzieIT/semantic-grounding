/**
 * P13b NL→SQL engine — BM25 schema-linking retrieval.
 *
 * First-pass BM25-only (P13 grilling Q2: AGA provides no embedding model — T2
 * live-probe confirmed 2026-08-20; vector-side upgrade = user self-deploys an
 * embedder via P5 `ctx.retrieval` once P5b ships; seam contract unchanged, P13
 * engine logic unchanged). rank-bm25 `BM25Okapi` direct-translation (reverse-bi
 * `libs/rbi-retrieval` uses `rank_bm25.BM25Okapi` + `unified_search._FIELD_WEIGHTS`).
 * CJK tokenizer is a minimal bigram+unigram stand-in (production: nodejieba /
 * P5 seam tokenizer).
 *
 * P13b grilling Q1: this declares a LOCAL `RetrievalLinker` interface (the
 * contract P5 `ctx.retrieval` will satisfy) + a thin in-process `Bm25Linker`
 * default — it does NOT declare the `ctx.retrieval` Service Definition (that
 * belongs to P5; P13b swaps to the real seam when P5b ships, additive).
 *
 * code-review-low fix #6: the P13 prototype `RetrievalSeamStub.retrieve`
 * re-found the dataSource by id after the BM25 hit already carried the payload;
 * the `Bm25Linker` uses the hit's payload directly (no redundant lookup).
 *
 * @module @deepseek-ai/dsh-nl2sql-engine/src/bm25-linking
 */

export interface DataSourceDoc {
  readonly id: string
  readonly description?: string
  readonly metrics?: Record<string, unknown>
  readonly payload?: unknown
}

/**
 * A single retrieval hit: the matched data-source id, its BM25 score, the
 * source payload (when present), and the mode that produced the hit.
 */
export interface RetrievalHit {
  readonly id: string
  readonly score: number
  readonly payload: DataSourceDoc | undefined
  readonly mode: string
}

/**
 * Local retrieval contract — the P5 `ctx.retrieval` seam will satisfy this
 * shape (`retrieve(query, { topK, mode }) → hits`). P13b consumes the local
 * `Bm25Linker` default until P5b ships the real provider (additive swap).
 */
export interface RetrievalLinker {
  retrieve(query: string, opts?: { readonly topK?: number; readonly mode?: string }): readonly RetrievalHit[]
}

/**
 * Minimal CJK tokenizer (prototype; production: nodejieba / P5 seam tokenizer).
 *
 * Splits underscore-joined identifiers into sub-tokens so that queries like
 * "acc summary" match table names like `dws_10000251_acc_summary_df`.
 *
 * @param text - The text to tokenize (ASCII words lowercased + CJK unigram/bigram).
 * @returns The token list (empty when the input is empty).
 */
export function tokenize(text: string): string[] {
  if (!text) return []
  const tokens: string[] = []
  const ascii = text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
  for (const raw of ascii) {
    const lower = raw.toLowerCase()
    tokens.push(lower)
    if (lower.includes('_')) {
      const parts = lower.split('_').filter(p => p.length > 0)
      if (parts.length > 1) tokens.push(...parts)
    }
  }
  const cjk = text.match(/[一-鿿぀-ゟ゠-ヿ]+/g) ?? []
  for (const seg of cjk) {
    for (const ch of seg) tokens.push(ch) // unigram
    if (seg.length > 1) {
      for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.substring(i, i + 2)) // bigram
    }
  }
  return tokens
}

interface CorpusEntry {
  readonly id: string
  readonly text: string
  readonly payload: DataSourceDoc
}

/**
 * BM25Okapi (k1=1.5, b=0.75; Lucene-style idf `log(1+x)` kept non-negative,
 * avoiding the rank_bm25 epsilon floor). Direct translation of the P13
 * prototype `bm25-linking.mjs`.
 */
export class BM25Okapi {
  private readonly k1: number
  private readonly b: number
  private readonly docs: string[][]
  private readonly names: string[]
  private readonly fields: DataSourceDoc[]
  private readonly avgdl: number
  private readonly idf: Record<string, number>

  constructor(corpus: readonly CorpusEntry[], { k1 = 1.5, b = 0.75 }: { k1?: number; b?: number } = {}) {
    this.k1 = k1
    this.b = b
    this.docs = corpus.map(d => tokenize(d.text))
    this.names = corpus.map(d => d.id)
    this.fields = corpus.map(d => d.payload)
    const n = this.docs.length
    const totalLen = this.docs.reduce((s, d) => s + d.length, 0)
    this.avgdl = n ? totalLen / n : 1
    const df: Record<string, number> = {}
    for (const doc of this.docs) {
      const seen = new Set(doc)
      for (const t of seen) df[t] = (df[t] ?? 0) + 1
    }
    this.idf = {}
    for (const [t, d] of Object.entries(df)) {
      this.idf[t] = Math.log(1 + (n - d + 0.5) / (d + 0.5))
    }
  }

  private score(queryTokens: readonly string[], idx: number): number {
    const doc = this.docs[idx]
    if (!doc) return 0
    const docLen = doc.length
    const tf: Record<string, number> = {}
    for (const t of doc) tf[t] = (tf[t] ?? 0) + 1
    let s = 0
    for (const t of queryTokens) {
      const idf = this.idf[t]
      const tfT = tf[t]
      if (idf == null || tfT == null) continue
      const denom = tfT + this.k1 * (1 - this.b + this.b * (docLen / this.avgdl))
      s += (idf * (tfT * (this.k1 + 1))) / denom
    }
    return s
  }

  /**
   * Score every corpus document against the query and return the top-K hits.
   *
   * @param query - The natural-language query to score against the corpus.
   * @param topK - Maximum number of hits to return (default 10).
   * @returns Scored hits (score > 0), best-first, each carrying its payload.
   */
  search(query: string, topK = 10): readonly { id: string; score: number; payload: DataSourceDoc }[] {
    const q = tokenize(query)
    const scores = this.docs.map((_, i) => ({ idx: i, score: this.score(q, i) }))
    scores.sort((a, b) => b.score - a.score)
    const out: { id: string; score: number; payload: DataSourceDoc }[] = []
    for (const s of scores.filter(s => s.score > 0).slice(0, topK)) {
      const id = this.names[s.idx]
      const payload = this.fields[s.idx]
      if (id === undefined || payload === undefined) continue
      out.push({ id, score: s.score, payload })
    }
    return out
  }
}

/** Per-field weights: name x3 / description x1 (prototype; RBI unified_search aligns on P5b swap). */
const FIELD_WEIGHTS = { name: 3, description: 1 } as const

/**
 * Build the BM25 corpus from data-source docs (name weighted x3 / description x1 / metrics x1).
 *
 * @param dataSources - The data-source documents to index.
 * @returns Corpus entries ready for `BM25Okapi` construction.
 */
export function buildCorpus(dataSources: readonly DataSourceDoc[]): readonly CorpusEntry[] {
  return dataSources.map((d) => {
    const parts: string[] = []
    for (let i = 0; i < FIELD_WEIGHTS.name; i++) parts.push(d.id) // name ×3
    if (d.description) parts.push(d.description) // description ×1
    if (d.metrics) for (const m of Object.keys(d.metrics)) parts.push(m) // metric ×1 (prototype simplification)
    return { id: d.id, text: parts.join(' '), payload: d }
  })
}

/**
 * Compute a name-match bonus: what fraction of the query's ASCII tokens appear
 * as sub-tokens of the table id? Prefix matches (≥2 chars) also count.
 * Returns a score in [0, 1] representing coverage. (nl2sql-engine-9: JSDoc
 * said ≥3 but the code branches on qt.length >= 2.)
 */
function nameMatchCoverage(queryAsciiTokens: readonly string[], tableId: string): number {
  if (queryAsciiTokens.length === 0) return 0
  const nameParts = tableId.toLowerCase().split(/[_.]/).filter(p => p.length > 0)
  let matched = 0
  for (const qt of queryAsciiTokens) {
    if (nameParts.includes(qt)) {
      matched++
    } else if (qt.length >= 2) {
      if (nameParts.some(p => p.startsWith(qt))) matched++
    }
  }
  return matched / queryAsciiTokens.length
}

/**
 * Bonus for consecutive query tokens appearing as adjacent name parts.
 * "role account" in `role_account_inner` → consecutive (positions 2,3).
 * "role account" in `game_role_backup_account_uv` → scattered (positions 1,4).
 */
function consecutiveMatchBonus(queryAsciiTokens: readonly string[], tableId: string): number {
  if (queryAsciiTokens.length < 2) return 0
  const nameParts = tableId.toLowerCase().split(/[_.]/).filter(p => p.length > 0)
  let maxConsec = 0
  for (let start = 0; start <= nameParts.length - queryAsciiTokens.length; start++) {
    let run = 0
    for (let qi = 0; qi < queryAsciiTokens.length; qi++) {
      const part = nameParts[start + qi]
      const qt = queryAsciiTokens[qi]
      if (qt === undefined) break
      if (part === qt || (qt.length >= 2 && part !== undefined && part.startsWith(qt))) {
        run++
      } else {
        break
      }
    }
    if (run > maxConsec) maxConsec = run
  }
  return maxConsec / queryAsciiTokens.length
}

/** Bonus multiplier for name-match coverage (applied on top of BM25 score). */
const NAME_MATCH_BONUS = 15

/**
 * Thin in-process BM25 linker (P13b Q1 default). Uses the hit's payload
 * directly (code-review-low #6). Swap for the P5 `ctx.retrieval` provider when
 * P5b ships — the `RetrievalLinker` contract is unchanged.
 *
 * Hybrid mode: BM25 base score + name-match bonus so that queries containing
 * table-name fragments (e.g. "biz role tag") reliably surface the target table
 * even when CJK description tokens create noise.
 */
export class Bm25Linker implements RetrievalLinker {
  private readonly bm25: BM25Okapi
  private readonly dataSources: readonly DataSourceDoc[]

  constructor(dataSources: readonly DataSourceDoc[]) {
    this.dataSources = dataSources
    this.bm25 = new BM25Okapi(buildCorpus(dataSources))
  }

  /**
   * Retrieve candidate data-source hits for a natural-language query.
   *
   * @param query - The natural-language query to link against the corpus.
   * @param options - Optional retrieval tuning (`topK` result cap; `mode` tag stamped onto every hit).
   * @returns Ranked retrieval hits carrying each candidate's payload.
   */
  retrieve(
    query: string,
    options: { readonly topK?: number; readonly mode?: string } = {},
  ): readonly RetrievalHit[] {
    const { topK = 5, mode = 'bm25-only' } = options
    const queryAscii = (query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).map(s => s.toLowerCase())
    // BM25 pass: fetch generous pool
    const bm25Hits = this.bm25.search(query, Math.max(topK * 10, 50))
    const bm25Ids = new Set(bm25Hits.map(h => h.id))

    // Name-match pass: scan full corpus for high-coverage items missed by BM25.
    // Consecutive match (query tokens form adjacent name parts) gets a large bonus
    // to distinguish e.g. `role_account_inner` from `game_role_..._account_uv`.
    const maxBm25 = bm25Hits[0]?.score ?? 0
    const nameHits: { id: string; score: number; payload: DataSourceDoc }[] = []
    if (queryAscii.length >= 2) {
      for (const ds of this.dataSources) {
        if (bm25Ids.has(ds.id)) continue
        const cov = nameMatchCoverage(queryAscii, ds.id)
        const consec = consecutiveMatchBonus(queryAscii, ds.id)
        if (cov >= 0.8 && consec >= 0.5) {
          nameHits.push({ id: ds.id, score: maxBm25 + (cov + consec) * NAME_MATCH_BONUS, payload: ds })
        }
      }
    }

    // Merge and re-rank (BM25 items also get coverage + consecutive bonus)
    const merged = [
      ...bm25Hits.map((h) => {
        const cov = nameMatchCoverage(queryAscii, h.id)
        const consec = consecutiveMatchBonus(queryAscii, h.id)
        return { ...h, score: h.score + (cov + consec) * NAME_MATCH_BONUS }
      }),
      ...nameHits,
    ]
    merged.sort((a, b) => b.score - a.score)
    const seen = new Set<string>()
    const out: RetrievalHit[] = []
    for (const h of merged) {
      if (seen.has(h.id)) continue
      seen.add(h.id)
      out.push({ id: h.id, score: h.score, payload: h.payload, mode })
      if (out.length >= topK) break
    }
    return out
  }
}

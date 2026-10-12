/**
 * The read epoch — ADR-0015's per-call loader memo scope (#77).
 *
 * A "read epoch" is the caching scope for a single tool call's read path:
 * within one epoch, `loadTables` / `loadEvents` (io.ts) return the same parsed
 * arrays instead of re-reading disk, and the epoch ends when the wrapped call
 * returns — the next call reads fresh. The cache key is **composite**
 * (ADR-0015 R1): `(per-call epoch) × (in-process corpusVersion)`. Both halves
 * have proven necessity:
 *
 * - `corpusVersion` alone cannot see writes from other processes
 *   (`concurrent-write.spec.ts`), so caching on it alone would serve stale
 *   data indefinitely.
 * - a pure per-call epoch would let a later write inside the same call (e.g.
 *   `run_enrichment` pipeline 3) reuse a stale `raw` from before pipeline 1's
 *   write — the whole-field-overwrite lost-write ADR-0004 ruling 8 names. The
 *   version half re-checked on every access (io.ts compares the memo entry
 *   against the live `_corpusVersion` counter) makes a mid-epoch write a
 *   guaranteed miss, which is R8.
 *
 * Design note — the epoch's identity IS the store instance. Every
 * {@link withReadEpoch} call that is not nested opens a fresh store holding a
 * fresh memo `Map`; when the call returns, the store (and its memo) becomes
 * unreachable, so nothing can leak across epochs by construction — there is no
 * epoch counter to bump and no cross-epoch entry to age out. The memo entry
 * carries the `corpusVersion` the data was read at, but that stored number is
 * only a comparison snapshot: correctness lives in io.ts re-reading the live
 * global counter on every access, never in the store alone. Nested
 * `withReadEpoch` calls reuse the already-open store (an epoch inside an epoch
 * is the same epoch — otherwise an inner call would fork a second view of the
 * corpus inside one logical tool call).
 *
 * R3: a caller that never opens an epoch gets today's behavior byte-for-byte
 * — io.ts checks {@link currentReadEpoch} and reads straight from disk when it
 * returns `undefined`. dsh (which uses its own `snapshot` MVCC, ADR-0015 R9)
 * and free-function callers are therefore untouched.
 *
 * This module must not import io.ts (cycle: io.ts imports this for the store).
 * The memo entry's `data` stays loose (`unknown`) here; io.ts, the only writer
 * of entries, narrows it to `RawTable[] | RawEvent[]` on read. The function is
 * not on the public barrel (ADR-0003's 36-name allow-list is untouched); the
 * MCP host reaches it as `SemanticGroundingCore.withReadEpoch`.
 *
 * @module read-epoch (internal; see ADR-0015)
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * One memo entry in an open epoch: the parsed data plus the `corpusVersion`
 * counter value it was read at. The stored `version` is a comparison snapshot
 * only — io.ts validates it against the live global counter on every access,
 * so a mid-epoch `invalidateCaches` bump (any write) turns the entry into a
 * miss even though the store still holds it.
 */
export interface ReadEpochMemoEntry {
  readonly version: number
  readonly data: unknown
}

/**
 * The store one {@link withReadEpoch} call opens. The instance itself is the
 * epoch identity: two `withReadEpoch` calls never share a store, so their
 * memos cannot cross-contaminate. `memo` is keyed by io.ts's composite
 * `(semanticLayer, kind)` string.
 */
export interface ReadEpochStore {
  readonly memo: Map<string, ReadEpochMemoEntry>
}

// Environment-style provision (ADR-0015 R2): one AsyncLocalStorage for the
// process; `run` propagates the store through every await started inside the
// wrapped call, which is what lets an async tool handler's post-await loader
// calls still see the epoch.
const readEpochStorage = new AsyncLocalStorage<ReadEpochStore>()

/**
 * Run `fn` inside one read epoch (ADR-0015): every `loadTables` / `loadEvents`
 * call made while `fn` runs (including across `await`s started inside it)
 * shares one per-`semanticLayer` memo, so repeated full-corpus scans within a
 * single tool call collapse to the first one. A write in between bumps
 * `corpusVersion`, which invalidates exactly the affected layer's entry (R8).
 * Nested calls reuse the already-open epoch.
 * @param fn - the call to wrap (sync or async; a Promise return passes through
 *   with the epoch still attached to its continuations).
 * @returns whatever `fn` returns, unchanged.
 */
export function withReadEpoch<T>(fn: () => T): T {
  // Nested epoch = the same epoch. Opening a second store here would give the
  // inner call a stale-memo-free view while the outer call keeps serving its
  // own memo — two views of one corpus inside one logical call.
  if (readEpochStorage.getStore() !== undefined) return fn()
  return readEpochStorage.run({ memo: new Map() }, fn)
}

/**
 * The read epoch currently open on this async path, if any.
 * @returns the open epoch's store, or `undefined` when no epoch is open —
 *   io.ts's no-epoch fast path (R3, byte-identical to pre-ADR-0015 behavior).
 */
export function currentReadEpoch(): ReadEpochStore | undefined {
  return readEpochStorage.getStore()
}

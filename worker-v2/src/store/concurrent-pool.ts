/**
 * BOUNDED-CONCURRENCY POOL FOR R2 READS.
 *
 * WHY THIS EXISTS. The derive-verdicts step died on production run
 * v2r_01m04jhrymz7wh490kq5jxke65 after timing out at 180s on all three retries. The root
 * cause: every sequential per-catalogue-entry R2 fetch loop (listCatalog, loadArtifactBytes,
 * auditEvidence) runs at ~46ms per GET, so a 14+ batch real walk with ~3,400 subrequests
 * could not finish before the 3-minute cap. The sequential shape does not have to be
 * sequential — R2 tolerates high read concurrency — but unbounded concurrency would spike
 * memory and could hit connection limits on the runtime.
 *
 * THE BOUND. 24 concurrent R2 GETs is chosen because:
 *   - Cloudflare Workers hold a single-threaded V8 isolate; concurrency here means
 *     interleaved I/O, not threads. The runtime handles many outstanding fetches well, but
 *     each outstanding response holds a buffer until the caller reads it.
 *   - R2 is regional and low-latency from a Worker in the same account; 24 in-flight reads
 *     drain a 1,700-entry catalogue in ~70 round-trips instead of 1,700, bringing a 156s
 *     sequential scan down to ~3–4s wall clock.
 *   - The subrequest COUNT is unchanged: the same number of GETs are issued, just overlapped.
 *
 * THE CONTRACT.
 *   1. RESULTS ARE RETURNED IN INPUT ORDER. Callers that depend on ordering (the observation
 *      ledger, the evidence audit's priority list) get the same order they had with the
 *      sequential loop.
 *   2. EVERY INTEGRITY CHECK STILL RUNS PER ENTRY. The pool parallelises the I/O wait, not
 *      the validation; each entry's hash check / binding assertion runs inside its own task.
 *   3. ONE FAILURE PROPAGATES LOUDLY. A rejected task rejects the whole pool rather than
 *      being silently dropped. The pool does not swallow exceptions.
 */

/**
 * The default concurrency bound for R2 read fan-outs.
 *
 * Not a tuned constant for one survey's size — it is a property of the runtime: how many
 * I/O-blocked promises a single-threaded V8 isolate can keep in flight without meaningful
 * memory pressure. A survey of any size benefits equally from overlapping its R2 round-trips.
 */
export const R2_READ_CONCURRENCY = 24;

/**
 * Map an array through an async function with at most `concurrency` tasks in flight at once.
 * Results are returned in the same order as the input array.
 *
 * If any task rejects, the pool stops launching new tasks and rejects with that error once
 * all in-flight tasks have settled. The first rejection wins; subsequent rejections are not
 * swallowed but the first is the one the caller sees.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  if (concurrency < 1) {
    throw new Error(
      `mapConcurrent: concurrency must be >= 1, got ${concurrency}`,
    );
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: { error: unknown } | null = null;

  const runNext = async (): Promise<void> => {
    while (nextIndex < items.length && firstError === null) {
      const i = nextIndex++;
      // eslint-disable-next-line no-await-in-loop — intentional: each worker awaits one
      // task at a time while other workers proceed in parallel.
      try {
        results[i] = await fn(items[i]!, i);
      } catch (err) {
        if (firstError === null) firstError = { error: err };
        return;
      }
    }
  };

  // Launch `concurrency` workers. Each one grabs the next index from the shared counter,
  // so the pool is work-stealing rather than pre-partitioned: a slow task on one worker
  // does not starve items assigned to that partition.
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runNext(),
  );
  await Promise.all(workers);

  // TypeScript's control-flow analysis cannot track that `firstError` was mutated inside
  // the async `runNext` closure across the `await`. Cast to defeat the incorrect narrowing
  // to `never` — the runtime value IS `{ error: unknown } | null` at this point.
  const settled = firstError as { error: unknown } | null;
  if (settled !== null) throw settled.error;
  return results;
}

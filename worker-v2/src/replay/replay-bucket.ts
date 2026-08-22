/**
 * REPLAY WRITE FENCE — wraps a real R2Bucket so reads pass through untouched and
 * every write has its key rewritten from the source run prefix to the replay run prefix.
 *
 * THE INVARIANT: any write that would land outside the replay prefix, or any DELETE at
 * all, throws loudly. A replay must never mutate the source run's data or any other
 * run's data.
 *
 * Reads pass through because the source run's artifacts (evidence catalogue, blob store,
 * contract revisions, plans, execution progress) must all be readable by the judging
 * stages. The replay run's own writes (observations, record, judgement, report) land
 * under the replay prefix and are readable on subsequent stages.
 */

type PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob;

const RUN_KEY_PREFIX = "v2/runs/";
const REPORT_KEY_PREFIX = "v2/reports/";

/**
 * Thrown when a replay write would escape the fenced prefix.
 * Never caught — it is a bug in the replay harness.
 */
export class ReplayFenceViolation extends Error {
  constructor(key: string, reason: string) {
    super(
      `ReplayBucket refused: ${reason}. Key: ${JSON.stringify(key)}. ` +
        "The replay fence exists to prevent writes to the source run's data.",
    );
    this.name = "ReplayFenceViolation";
  }
}

/**
 * Thrown when a replay attempts to delete anything.
 */
export class ReplayDeleteForbidden extends Error {
  constructor(keys: string | string[]) {
    const display = Array.isArray(keys) ? keys.join(", ") : keys;
    super(
      `ReplayBucket forbids all deletes. Attempted keys: ${display}. ` +
        "A replay never deletes — it only reads existing data and writes under the replay prefix.",
    );
    this.name = "ReplayDeleteForbidden";
  }
}

/**
 * Rewrite a key from the source run prefix to the replay run prefix.
 * Keys that belong to neither the source run's run-scoped nor report-scoped
 * namespaces (e.g. cross-run contract revisions, evidence blobs) are LEFT
 * UNTOUCHED on reads and REFUSED on writes.
 */
function rewriteKey(
  key: string,
  sourceRunId: string,
  replayRunId: string,
): string | null {
  const sourceRunPrefix = `${RUN_KEY_PREFIX}${sourceRunId}/`;
  const replayRunPrefix = `${RUN_KEY_PREFIX}${replayRunId}/`;
  if (key.startsWith(sourceRunPrefix)) {
    return replayRunPrefix + key.slice(sourceRunPrefix.length);
  }
  const sourceReportPrefix = `${REPORT_KEY_PREFIX}${sourceRunId}/`;
  const replayReportPrefix = `${REPORT_KEY_PREFIX}${replayRunId}/`;
  if (key.startsWith(sourceReportPrefix)) {
    return replayReportPrefix + key.slice(sourceReportPrefix.length);
  }
  // Keys under the replay run prefix are already correct (reads of own writes).
  if (key.startsWith(replayRunPrefix) || key.startsWith(replayReportPrefix)) {
    return key;
  }
  return null; // Not a run-scoped key — pass-through for reads, refuse for writes.
}

export interface ReplayBucketOptions {
  sourceRunId: string;
  replayRunId: string;
}

/**
 * Wrap a real R2Bucket with a replay fence.
 *
 * READS: pass through to the underlying bucket untouched. When a read targets
 * the replay run prefix, it reads the replay's own writes. When it targets the
 * source run prefix or any cross-run key, it reads the original data.
 *
 * WRITES: every put has its key rewritten from the source run prefix to the replay
 * run prefix. A write to a cross-run key (contract revision, evidence blob) is
 * refused — those are immutable and shared, so the replay must not touch them.
 *
 * DELETES: all deletes throw.
 */
export function wrapReplayBucket(
  bucket: R2Bucket,
  opts: ReplayBucketOptions,
): R2Bucket {
  const { sourceRunId, replayRunId } = opts;

  if (!replayRunId.startsWith("replay-")) {
    throw new ReplayFenceViolation(
      replayRunId,
      "replay run id must start with 'replay-'",
    );
  }

  const replayRunPrefix = `${RUN_KEY_PREFIX}${replayRunId}/`;
  const replayReportPrefix = `${REPORT_KEY_PREFIX}${replayRunId}/`;

  function assertReplayWrite(key: string): string {
    const rewritten = rewriteKey(key, sourceRunId, replayRunId);
    if (rewritten === null) {
      // Cross-run keys (contracts, evidence blobs) are immutable/shared.
      // The tail stages do not write new ones, but if they try, refuse.
      throw new ReplayFenceViolation(
        key,
        "write targets a cross-run key that is not within the source or replay run prefix",
      );
    }
    // Final guard: the rewritten key must land under the replay prefix.
    if (!rewritten.startsWith(replayRunPrefix) && !rewritten.startsWith(replayReportPrefix)) {
      throw new ReplayFenceViolation(
        key,
        `rewritten key ${JSON.stringify(rewritten)} does not start with the replay run prefix`,
      );
    }
    return rewritten;
  }

  const wrapped: R2Bucket = {
    async head(key: string) {
      // Try replay prefix first (own writes), fall back to real key.
      const rewritten = rewriteKey(key, sourceRunId, replayRunId);
      if (rewritten && rewritten !== key) {
        const result = await bucket.head(rewritten);
        if (result) return result;
      }
      return bucket.head(key);
    },

    async get(key: string, options?: R2GetOptions) {
      // Try replay prefix first (own writes), fall back to real key.
      const rewritten = rewriteKey(key, sourceRunId, replayRunId);
      if (rewritten && rewritten !== key) {
        const result = await bucket.get(rewritten, options);
        if (result) return result;
      }
      return bucket.get(key, options);
    },

    async put(key: string, value: PutValue, options?: R2PutOptions) {
      const target = assertReplayWrite(key);
      return bucket.put(target, value, options);
    },

    async delete(_keys: string | string[]) {
      throw new ReplayDeleteForbidden(_keys);
    },

    async list(options: R2ListOptions = {}) {
      // List operations pass through — the stages need to list the source run's catalogue.
      // For listing the replay run's own writes, the prefix will already be correct.
      return bucket.list(options);
    },

    async createMultipartUpload(key: string, options?: R2MultipartOptions) {
      const target = assertReplayWrite(key);
      return bucket.createMultipartUpload(target, options);
    },

    resumeMultipartUpload(key: string, uploadId: string) {
      const target = assertReplayWrite(key);
      return bucket.resumeMultipartUpload(target, uploadId);
    },
  };

  return wrapped;
}

/**
 * Rewrite the runId fields in a checkpoint so the tail stages write under the
 * replay prefix. The checkpoint is seeded from the source run and then mutated
 * to reference the replay run id.
 */
export function rewriteCheckpointForReplay(
  checkpointText: string,
  sourceRunId: string,
  replayRunId: string,
): string {
  // Simple string replacement is safe here because the run id appears as a JSON
  // string value and run ids are alphanumeric with underscores — no regex special chars.
  return checkpointText.replaceAll(sourceRunId, replayRunId);
}

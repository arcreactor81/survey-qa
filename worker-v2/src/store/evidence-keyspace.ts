/**
 * PHYSICAL R2 KEYSPACE BOUNDARY.
 *
 * Code inside the Worker uses one stable, logical key vocabulary (`v2/...`). The
 * production deployment stores those keys verbatim. An evaluation arm stores the same
 * logical keys below its configured physical root (`v2/arms/<arm>/...`). Keeping the
 * translation at the binding boundary has two important properties:
 *
 *   1. a forgotten hand-built `v2/...` key cannot escape an arm into production; and
 *   2. list/delete/multipart operations receive the same guard as ordinary reads/writes.
 *
 * THE DECLARED ASSUMPTION: this adapter recognises exactly two deployment topologies:
 * production (`v2/`) and an isolated experiment arm (`v2/arms/<slug>/`). A future
 * topology must be added deliberately. Treating an arbitrary descendant such as
 * `v2/runs/` as a namespace would place an experiment inside production run state, so
 * unknown shapes fail closed.
 */

import { NamespaceViolation, V2_PREFIX, assertV2Key } from "../keys";
import type { Env } from "../types/env";

const ARM_PHYSICAL_PREFIX = /^v2\/arms\/[a-z0-9][a-z0-9_-]{0,63}\/$/;
const RESERVED_ARM_ROOT = `${V2_PREFIX}arms/`;
const SCOPED_PREFIX = Symbol("survey-qa-v2-evidence-prefix");

type PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob;
type ScopedBucket = R2Bucket & { readonly [SCOPED_PREFIX]?: string };

/** A namespace error with the deployment/configuration reason left intact for operators. */
export class EvidenceKeyspaceViolation extends NamespaceViolation {
  constructor(value: string, reason: string) {
    super(value);
    this.name = "EvidenceKeyspaceViolation";
    this.message =
      `survey-qa-v2 refused the evidence keyspace value ${JSON.stringify(value)}: ${reason}. ` +
      `The R2 bucket is shared, so an unknown namespace must fail closed.`;
  }
}

/** Validate the physical root supplied by Wrangler. There is deliberately no default. */
export function configuredEvidencePrefix(env: Pick<Env, "V2_PREFIX">): string {
  const prefix = env.V2_PREFIX;
  if (prefix === V2_PREFIX) return prefix;
  if (ARM_PHYSICAL_PREFIX.test(prefix)) return prefix;
  throw new EvidenceKeyspaceViolation(
    prefix,
    `V2_PREFIX must be exactly ${JSON.stringify(V2_PREFIX)} or match ${ARM_PHYSICAL_PREFIX}`,
  );
}

/**
 * Reject physical arm paths supplied as logical keys. Without this check a caller could
 * accidentally double-prefix a key; in production it could also reach an arm directly.
 */
function assertLogicalKey(key: string): string {
  assertV2Key(key);
  if (key.startsWith(RESERVED_ARM_ROOT)) {
    throw new EvidenceKeyspaceViolation(
      key,
      `${JSON.stringify(RESERVED_ARM_ROOT)} is a physical deployment namespace, not a logical artifact path`,
    );
  }
  return key;
}

function physicalKey(prefix: string, logicalKey: string): string {
  const key = assertLogicalKey(logicalKey);
  return prefix + key.slice(V2_PREFIX.length);
}

function physicalPrefix(prefix: string, logicalPrefix?: string): string {
  if (logicalPrefix === undefined || logicalPrefix === "" || logicalPrefix === V2_PREFIX) return prefix;
  return physicalKey(prefix, logicalPrefix);
}

function logicalKey(prefix: string, physical: string): string {
  if (!physical.startsWith(prefix)) {
    throw new EvidenceKeyspaceViolation(
      physical,
      `R2 returned an object outside configured prefix ${JSON.stringify(prefix)}`,
    );
  }
  return assertV2Key(V2_PREFIX + physical.slice(prefix.length));
}

/** Preserve the native R2 object while projecting its physical key back to the logical key. */
function scopedObject<T extends R2Object | null>(prefix: string, object: T): T {
  if (object === null) return object;
  return new Proxy(object, {
    get(target, property) {
      if (property === "key") return logicalKey(prefix, target.key);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}

function scopedMultipart(prefix: string, upload: R2MultipartUpload): R2MultipartUpload {
  return {
    get key() {
      return logicalKey(prefix, upload.key);
    },
    get uploadId() {
      return upload.uploadId;
    },
    uploadPart(partNumber, value, options) {
      return upload.uploadPart(partNumber, value, options);
    },
    abort() {
      return upload.abort();
    },
    async complete(uploadedParts) {
      return scopedObject(prefix, await upload.complete(uploadedParts));
    },
  };
}

/**
 * Scope every R2 operation to one validated physical namespace. Returned object keys stay
 * logical so stored pointers remain portable between production and experiment arms.
 */
export function scopeEvidenceBucket(bucket: R2Bucket, prefix: string): R2Bucket {
  // Validate even when a caller invokes this helper directly rather than through the Env
  // helper. Reusing an already-scoped bucket with a different prefix is a programming bug.
  configuredEvidencePrefix({ V2_PREFIX: prefix } as Pick<Env, "V2_PREFIX">);
  const existing = (bucket as ScopedBucket)[SCOPED_PREFIX];
  if (existing !== undefined) {
    if (existing !== prefix) {
      throw new EvidenceKeyspaceViolation(
        prefix,
        `an R2 binding already scoped to ${JSON.stringify(existing)} cannot be re-scoped`,
      );
    }
    return bucket;
  }

  const scoped: ScopedBucket = {
    [SCOPED_PREFIX]: prefix,
    async head(key: string) {
      return scopedObject(prefix, await bucket.head(physicalKey(prefix, key)));
    },
    async get(key: string, options?: R2GetOptions) {
      return scopedObject(prefix, await bucket.get(physicalKey(prefix, key), options));
    },
    async put(key: string, value: PutValue, options?: R2PutOptions) {
      return scopedObject(prefix, await bucket.put(physicalKey(prefix, key), value, options));
    },
    async delete(keys: string | string[]) {
      const translated = Array.isArray(keys)
        ? keys.map((key) => physicalKey(prefix, key))
        : physicalKey(prefix, keys);
      return bucket.delete(translated);
    },
    async list(options: R2ListOptions = {}) {
      const translated: R2ListOptions = {
        ...options,
        prefix: physicalPrefix(prefix, options.prefix),
        ...(options.startAfter === undefined
          ? {}
          : { startAfter: physicalKey(prefix, options.startAfter) }),
      };
      const page = await bucket.list(translated);
      const base = {
        objects: page.objects.map((object) => scopedObject(prefix, object)),
        delimitedPrefixes: page.delimitedPrefixes.map((item) => logicalKey(prefix, item)),
      };
      return page.truncated
        ? { ...base, truncated: true as const, cursor: page.cursor }
        : { ...base, truncated: false as const };
    },
    async createMultipartUpload(key: string, options?: R2MultipartOptions) {
      return scopedMultipart(prefix, await bucket.createMultipartUpload(physicalKey(prefix, key), options));
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      return scopedMultipart(prefix, bucket.resumeMultipartUpload(physicalKey(prefix, key), uploadId));
    },
  };
  return scoped;
}

/** Return an Env whose shared EVIDENCE binding cannot leave its declared namespace. */
export function scopeEvidenceEnv<T extends Pick<Env, "EVIDENCE" | "V2_PREFIX">>(env: T): T {
  const prefix = configuredEvidencePrefix(env);
  const EVIDENCE = scopeEvidenceBucket(env.EVIDENCE, prefix);
  if (EVIDENCE === env.EVIDENCE) return env;
  return { ...env, EVIDENCE };
}

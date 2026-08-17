/**
 * APPEND-ONLY DURABILITY FOR VISUAL PERCEPTION.
 *
 * A paid inference is a two-receipt protocol:
 *
 *   1. write the immutable claim BEFORE issuing the provider request;
 *   2. write the immutable, normalized outcome after the request settles.
 *
 * A claim without an outcome is deliberately `indeterminate`, never "not started". A Workflow
 * retry therefore has no API signal with which to repurchase a request whose provider may already
 * have billed it. Operators may resolve that state explicitly; automated recovery may not guess.
 *
 * Grounded observations and reconciliations are stored as immutable epoch results. A finalized
 * manifest is built only from stored epoch results and owns mechanically derived totals. None of
 * these objects contains screenshot bytes or an unbounded/raw provider response.
 */

import type { OptionMembershipReconciliation } from "../vision/reconcile";
import { allowedNotAttemptedPreflightReference } from "../vision/provider-failure";
import {
  computePairedEvidenceSha256,
  computeVisualInferenceCacheKey,
  computeVisualObservationCacheKey,
} from "../vision/observe";
import {
  VISUAL_PROMPT_VERSION,
  VISUAL_RESPONSE_SCHEMA_VERSION,
  forbiddenDecisionFields,
  validateModelVisualInventory,
} from "../vision/schema";
import type {
  GroundedTextReading,
  ModelVisualInventory,
  NormalizedBounds,
  QuoteGrounding,
  VisionCallTelemetry,
  VisualCaptureGeometry,
  VisualCaptureIdentity,
  VisualControlRegion,
  VisualInventory,
  VisualMessageRegion,
  VisualObservationArtifact,
  VisualObservationLimitation,
  VisualObservationSink,
  VisualObservationSinkInput,
  VisualOptionGroup,
  VisualOptionRegion,
  VisualQuestionRegion,
} from "../vision/types";
import { canonicalJson, sha256Hex } from "./hash";

const enc = new TextEncoder();
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const HASH = /^[0-9a-f]{64}$/;
const INFERENCE_CACHE_KEY = /^visual-inference\/sha256\/([0-9a-f]{64})$/;
const OBSERVATION_CACHE_KEY = /^visual-observation\/sha256\/([0-9a-f]{64})$/;
const MAX_KEY_CHARS = 1_024;
const MAX_SEGMENTS = 64;
const MAX_SEGMENT_CHARS = 160;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_EPOCHS = 20_000;
const MAX_TEXT = 4_000;
const MAX_DETAIL = 1_000;

export const VISUAL_INFERENCE_CLAIM_SCHEMA_VERSION = "survey-qa-visual-inference-claim/1.0.0" as const;
export const VISUAL_INFERENCE_OUTCOME_SCHEMA_VERSION = "survey-qa-visual-inference-outcome/1.0.0" as const;
export const GROUNDED_VISUAL_EPOCH_SCHEMA_VERSION = "survey-qa-grounded-visual-epoch/1.0.0" as const;
export const VISUAL_RUN_MANIFEST_SCHEMA_VERSION = "survey-qa-visual-run-manifest/1.0.0" as const;

export interface VisualStorageKeyRef {
  /** Caller-built R2 key. Prefix policy belongs in src/keys.ts, not here. */
  key: string;
  /** The one SHA-256 segment embedded in `key`. */
  digest: string;
}

export interface VisualInferenceStorageKeys {
  digest: string;
  claimKey: string;
  outcomeKey: string;
}

export interface VisualInferenceClaimReceipt {
  schemaVersion: typeof VISUAL_INFERENCE_CLAIM_SCHEMA_VERSION;
  kind: "survey-qa-visual-inference-claim";
  inferenceCacheKey: string;
  callId: string;
  claimedAt: string;
  request: {
    screenshotSha256: string;
    mediaType: "image/png";
    pixelWidth: number;
    pixelHeight: number;
    provider: string;
    model: string;
    transport: string;
    configurationSha256: string;
    prompt: { version: string; sha256: string };
    responseSchema: { version: string; sha256: string };
  };
}

export type VisualInferenceOutcomeResult =
  | {
      state: "observed";
      inventory: ModelVisualInventory;
      responseSha256: string;
    }
  | {
      state: "timeout" | "unavailable" | "malformed";
      inventory: null;
      responseSha256: string | null;
      failure: { kind: string; count: number; detail: string };
    };

export interface VisualInferenceOutcomeReceipt {
  schemaVersion: typeof VISUAL_INFERENCE_OUTCOME_SCHEMA_VERSION;
  kind: "survey-qa-visual-inference-outcome";
  inferenceCacheKey: string;
  callId: string;
  settledAt: string;
  result: VisualInferenceOutcomeResult;
  telemetry: VisionCallTelemetry | null;
}

export type VisualInferenceState =
  | {
      state: "unstarted";
      /** This is the ONLY state that authorizes a new paid request. */
      issueNew: true;
      claim: null;
      outcome: null;
    }
  | {
      state: "settled";
      issueNew: false;
      claim: VisualInferenceClaimReceipt;
      outcome: VisualInferenceOutcomeReceipt;
    }
  | {
      state: "indeterminate";
      issueNew: false;
      claim: VisualInferenceClaimReceipt;
      outcome: null;
      reason: "claim-present-outcome-absent";
    }
  | {
      state: "corrupt";
      issueNew: false;
      claim: null;
      outcome: null;
      reason: string;
    };

export interface GroundedVisualEpochResult {
  schemaVersion: typeof GROUNDED_VISUAL_EPOCH_SCHEMA_VERSION;
  kind: "survey-qa-grounded-visual-epoch";
  finalizedAt: string;
  epochDigest: string;
  inferenceDigest: string;
  observationContentSha256: string;
  reconciliationContentSha256: string;
  observation: VisualObservationArtifact;
  reconciliation: OptionMembershipReconciliation;
  counts: {
    observationLimitations: number;
    facts: number;
    conflicts: number;
    reconciliationLimitations: number;
  };
}

export interface StoredGroundedVisualEpoch {
  storage: VisualStorageKeyRef;
  contentSha256: string;
  result: GroundedVisualEpochResult;
}

export interface StoredOptionMembershipReconciliation {
  storage: VisualStorageKeyRef;
  contentSha256: string;
  reconciliation: OptionMembershipReconciliation;
}

export interface VisualRunManifestEntry {
  epochDigest: string;
  inferenceDigest: string;
  epochResultKey: string;
  epochResultSha256: string;
  observationCacheKey: string;
  inferenceCacheKey: string;
  epochId: string;
  readState: VisualObservationArtifact["readState"];
  counts: {
    questionRegions: number;
    optionGroups: number;
    options: number;
    controls: number;
    messages: number;
    observationLimitations: number;
    facts: number;
    conflicts: number;
    reconciliationLimitations: number;
  };
}

export interface VisualRunManifest {
  schemaVersion: typeof VISUAL_RUN_MANIFEST_SCHEMA_VERSION;
  kind: "survey-qa-visual-run-manifest";
  runId: string;
  finalizedAt: string;
  entries: VisualRunManifestEntry[];
  totals: {
    epochs: number;
    observedEpochs: number;
    nonObservedEpochs: number;
    questionRegions: number;
    optionGroups: number;
    options: number;
    controls: number;
    messages: number;
    observationLimitations: number;
    facts: number;
    conflicts: number;
    reconciliationLimitations: number;
  };
}

export interface PreparedVisualRunManifest {
  manifest: VisualRunManifest;
  canonicalBytes: Uint8Array;
  contentSha256: string;
  epochs: StoredGroundedVisualEpoch[];
}

export class VisualStorageValidationError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "VisualStorageValidationError";
  }
}

export class VisualStorageImmutabilityError extends Error {
  constructor(readonly key: string) {
    super(`visual storage object ${key} already exists with different bytes; append-only write refused`);
    this.name = "VisualStorageImmutabilityError";
  }
}

export class VisualStorageCorruptionError extends Error {
  constructor(readonly key: string, detail: string) {
    super(`visual storage object ${key} is corrupt: ${detail}`);
    this.name = "VisualStorageCorruptionError";
  }
}

/**
 * Read both inference receipts as one state machine. `issueNew` is true only when both keys
 * are absent. Any malformed, unpaired, or uncertain state is fail-closed.
 */
export async function readVisualInferenceState(
  bucket: R2Bucket,
  keys: VisualInferenceStorageKeys,
): Promise<VisualInferenceState> {
  let normalizedKeys: VisualInferenceStorageKeys;
  try {
    normalizedKeys = validateInferenceKeys(keys);
  } catch (error) {
    return corruptState(errorMessage(error));
  }

  let claimStored: Uint8Array | null;
  let outcomeStored: Uint8Array | null;
  try {
    [claimStored, outcomeStored] = await Promise.all([
      readObjectBytes(bucket, normalizedKeys.claimKey),
      readObjectBytes(bucket, normalizedKeys.outcomeKey),
    ]);
  } catch (error) {
    return corruptState(errorMessage(error));
  }
  if (claimStored === null && outcomeStored === null) {
    return { state: "unstarted", issueNew: true, claim: null, outcome: null };
  }
  if (claimStored === null) return corruptState("outcome receipt exists without its prerequisite claim receipt");

  let claim: VisualInferenceClaimReceipt;
  try {
    claim = await parseCanonicalObject(
      claimStored,
      normalizedKeys.claimKey,
      (value) => normalizeInferenceClaim(value, normalizedKeys.digest),
    );
  } catch (error) {
    return corruptState(errorMessage(error));
  }

  if (outcomeStored === null) {
    return {
      state: "indeterminate",
      issueNew: false,
      claim,
      outcome: null,
      reason: "claim-present-outcome-absent",
    };
  }

  try {
    const outcome = await parseCanonicalObject(
      outcomeStored,
      normalizedKeys.outcomeKey,
      (value) => normalizeInferenceOutcome(value, claim, normalizedKeys.digest),
    );
    return { state: "settled", issueNew: false, claim, outcome };
  } catch (error) {
    return corruptState(errorMessage(error));
  }
}

/** Append the pre-purchase receipt. An outcome-without-claim object is never repaired in place. */
export async function claimVisualInference(
  bucket: R2Bucket,
  keys: VisualInferenceStorageKeys,
  receipt: VisualInferenceClaimReceipt,
): Promise<"stored" | "reused"> {
  const normalizedKeys = validateInferenceKeys(keys);
  const existingClaim = await readObjectBytes(bucket, normalizedKeys.claimKey);
  if (existingClaim === null && (await readObjectBytes(bucket, normalizedKeys.outcomeKey)) !== null) {
    throw new VisualStorageCorruptionError(
      normalizedKeys.outcomeKey,
      "an outcome receipt exists without a claim; refusing to legitimize it retroactively",
    );
  }
  const normalized = await normalizeInferenceClaim(receipt, normalizedKeys.digest);
  return putCanonicalImmutable(bucket, normalizedKeys.claimKey, normalized);
}

/** Append a normalized outcome only after a valid, matching claim exists. */
export async function settleVisualInference(
  bucket: R2Bucket,
  keys: VisualInferenceStorageKeys,
  receipt: VisualInferenceOutcomeReceipt,
): Promise<"stored" | "reused"> {
  const normalizedKeys = validateInferenceKeys(keys);
  const claimBytes = await readObjectBytes(bucket, normalizedKeys.claimKey);
  if (claimBytes === null) {
    throw new VisualStorageCorruptionError(normalizedKeys.outcomeKey, "cannot settle an inference without its claim");
  }
  const claim = await parseCanonicalObject(
    claimBytes,
    normalizedKeys.claimKey,
    (value) => normalizeInferenceClaim(value, normalizedKeys.digest),
  );
  const normalized = await normalizeInferenceOutcome(receipt, claim, normalizedKeys.digest);
  return putCanonicalImmutable(bucket, normalizedKeys.outcomeKey, normalized);
}

/** Build the closed epoch record; every derived digest and total is server-owned. */
export async function createGroundedVisualEpochResult(input: {
  finalizedAt: string;
  observation: VisualObservationArtifact;
  reconciliation: OptionMembershipReconciliation;
}): Promise<GroundedVisualEpochResult> {
  const finalizedAt = isoTimestamp(input.finalizedAt, "$.finalizedAt");
  const observation = await normalizeVisualObservationArtifact(input.observation);
  if (observation.cacheKey === null || observation.inferenceCacheKey === null) {
    invalid("$.observation", "a persisted epoch requires non-null observation and inference cache identities");
  }
  const reconciliation = normalizeOptionMembershipReconciliation(input.reconciliation, observation);
  const epochDigest = digestFromCacheKey(observation.cacheKey, OBSERVATION_CACHE_KEY, "$.observation.cacheKey");
  const inferenceDigest = digestFromCacheKey(
    observation.inferenceCacheKey,
    INFERENCE_CACHE_KEY,
    "$.observation.inferenceCacheKey",
  );
  const observationContentSha256 = await sha256Hex(canonicalJson(observation));
  const reconciliationContentSha256 = await sha256Hex(canonicalJson(reconciliation));
  return {
    schemaVersion: GROUNDED_VISUAL_EPOCH_SCHEMA_VERSION,
    kind: "survey-qa-grounded-visual-epoch",
    finalizedAt,
    epochDigest,
    inferenceDigest,
    observationContentSha256,
    reconciliationContentSha256,
    observation,
    reconciliation,
    counts: {
      observationLimitations: observation.counts.limitations,
      facts: reconciliation.counts.facts,
      conflicts: reconciliation.counts.conflicts,
      reconciliationLimitations: reconciliation.counts.limitations,
    },
  };
}

export async function persistGroundedVisualEpoch(
  bucket: R2Bucket,
  storage: VisualStorageKeyRef,
  value: GroundedVisualEpochResult,
): Promise<StoredGroundedVisualEpoch> {
  const result = await normalizeGroundedVisualEpoch(value);
  const normalizedStorage = validateStorageKey(storage, result.epochDigest, "epoch storage key");
  await putCanonicalImmutable(bucket, normalizedStorage.key, result);
  const canonicalBytes = enc.encode(canonicalJson(result));
  return {
    storage: normalizedStorage,
    contentSha256: await sha256Hex(canonicalBytes),
    result,
  };
}

export async function readGroundedVisualEpoch(
  bucket: R2Bucket,
  storage: VisualStorageKeyRef,
): Promise<StoredGroundedVisualEpoch | null> {
  const normalizedStorage = validateStorageKey(storage, storage.digest, "epoch storage key");
  const bytes = await readObjectBytes(bucket, normalizedStorage.key);
  if (bytes === null) return null;
  const result = await parseCanonicalObject(bytes, normalizedStorage.key, normalizeGroundedVisualEpoch);
  if (result.epochDigest !== normalizedStorage.digest) {
    throw new VisualStorageCorruptionError(normalizedStorage.key, "epoch digest does not bind the storage key");
  }
  return {
    storage: normalizedStorage,
    contentSha256: await sha256Hex(bytes),
    result,
  };
}

/**
 * Persist deterministic reconciliation independently from the combined epoch record. A coverage
 * row can therefore prove that it re-read the observer output, reconciliation output, and their
 * closed combination instead of attesting an in-memory transition that never became durable.
 */
export async function persistOptionMembershipReconciliation(
  bucket: R2Bucket,
  storage: VisualStorageKeyRef,
  observationValue: VisualObservationArtifact,
  reconciliationValue: OptionMembershipReconciliation,
): Promise<StoredOptionMembershipReconciliation> {
  const observation = await normalizeVisualObservationArtifact(observationValue);
  if (observation.cacheKey === null) {
    invalid("$.observation.cacheKey", "a persisted reconciliation requires an observation cache identity");
  }
  const epochDigest = digestFromCacheKey(
    observation.cacheKey,
    OBSERVATION_CACHE_KEY,
    "$.observation.cacheKey",
  );
  const normalizedStorage = validateStorageKey(storage, epochDigest, "reconciliation storage key");
  const reconciliation = normalizeOptionMembershipReconciliation(reconciliationValue, observation);
  const canonicalBytes = enc.encode(canonicalJson(reconciliation));
  await putBytesImmutable(bucket, normalizedStorage.key, canonicalBytes);
  return {
    storage: normalizedStorage,
    contentSha256: await sha256Hex(canonicalBytes),
    reconciliation,
  };
}

export async function readOptionMembershipReconciliation(
  bucket: R2Bucket,
  storage: VisualStorageKeyRef,
  observationValue: VisualObservationArtifact,
): Promise<StoredOptionMembershipReconciliation | null> {
  const observation = await normalizeVisualObservationArtifact(observationValue);
  if (observation.cacheKey === null) {
    invalid("$.observation.cacheKey", "a reconciliation read requires an observation cache identity");
  }
  const epochDigest = digestFromCacheKey(
    observation.cacheKey,
    OBSERVATION_CACHE_KEY,
    "$.observation.cacheKey",
  );
  const normalizedStorage = validateStorageKey(storage, epochDigest, "reconciliation storage key");
  const bytes = await readObjectBytes(bucket, normalizedStorage.key);
  if (bytes === null) return null;
  const reconciliation = await parseCanonicalObject(
    bytes,
    normalizedStorage.key,
    (value) => normalizeOptionMembershipReconciliation(value, observation),
  );
  return {
    storage: normalizedStorage,
    contentSha256: await sha256Hex(bytes),
    reconciliation,
  };
}

/**
 * Build a content-addressed final manifest. Entries are sorted and totals are computed from the
 * validated epoch records; callers cannot attest their own coverage totals.
 */
export async function prepareVisualRunManifest(input: {
  runId: string;
  finalizedAt: string;
  epochs: StoredGroundedVisualEpoch[];
}): Promise<PreparedVisualRunManifest> {
  const runId = boundedString(input.runId, "$.runId", 200);
  const finalizedAt = isoTimestamp(input.finalizedAt, "$.finalizedAt");
  const epochValues = asArray(input.epochs, "$.epochs", MAX_MANIFEST_EPOCHS);
  const epochs: StoredGroundedVisualEpoch[] = [];
  for (let index = 0; index < epochValues.length; index += 1) {
    const epoch = await normalizeStoredEpoch(epochValues[index], `$.epochs[${index}]`);
    if (epoch.result.observation.input.capture.runId !== runId) {
      invalid(`$.epochs[${index}].result.observation.input.capture.runId`, "does not match manifest runId");
    }
    epochs.push(epoch);
  }
  epochs.sort((a, b) => a.result.epochDigest.localeCompare(b.result.epochDigest));
  ensureUnique(epochs.map((item) => item.result.epochDigest), "$.epochs", "epoch digest");
  ensureUnique(epochs.map((item) => item.storage.key), "$.epochs", "epoch result key");

  const entries = epochs.map(manifestEntryFromEpoch);
  const totals = manifestTotals(entries);
  const manifest: VisualRunManifest = {
    schemaVersion: VISUAL_RUN_MANIFEST_SCHEMA_VERSION,
    kind: "survey-qa-visual-run-manifest",
    runId,
    finalizedAt,
    entries,
    totals,
  };
  const canonicalBytes = enc.encode(canonicalJson(manifest));
  return {
    manifest,
    canonicalBytes,
    contentSha256: await sha256Hex(canonicalBytes),
    epochs,
  };
}

/** Verify every referenced epoch still exists byte-for-byte, then append the final index. */
export async function finalizeVisualRunManifest(
  bucket: R2Bucket,
  storage: VisualStorageKeyRef,
  prepared: PreparedVisualRunManifest,
): Promise<"stored" | "reused"> {
  const normalized = await normalizePreparedManifest(prepared);
  const normalizedStorage = validateStorageKey(storage, normalized.contentSha256, "manifest storage key");
  await Promise.all(
    normalized.epochs.map(async (epoch) => {
      const current = await readGroundedVisualEpoch(bucket, epoch.storage);
      if (current === null) {
        throw new VisualStorageCorruptionError(epoch.storage.key, "manifest references a missing epoch result");
      }
      if (current.contentSha256 !== epoch.contentSha256) {
        throw new VisualStorageCorruptionError(epoch.storage.key, "manifest epoch content digest changed");
      }
    }),
  );
  return putCanonicalImmutable(bucket, normalizedStorage.key, normalized.manifest);
}

export async function readVisualRunManifest(
  bucket: R2Bucket,
  storage: VisualStorageKeyRef,
): Promise<VisualRunManifest | null> {
  const normalizedStorage = validateStorageKey(storage, storage.digest, "manifest storage key");
  const bytes = await readObjectBytes(bucket, normalizedStorage.key);
  if (bytes === null) return null;
  if ((await sha256Hex(bytes)) !== normalizedStorage.digest) {
    throw new VisualStorageCorruptionError(normalizedStorage.key, "manifest bytes do not match the key digest");
  }
  return parseCanonicalObject(bytes, normalizedStorage.key, normalizeVisualRunManifest);
}

/**
 * R2 adapter for the observer's sink boundary. The caller supplies the repository key builder;
 * this module independently revalidates its path and digest binding before the immutable write.
 */
export function createR2VisualObservationSink(
  bucket: R2Bucket,
  storageForEpochDigest: (epochDigest: string) => VisualStorageKeyRef,
): VisualObservationSink {
  return {
    async persist(input: VisualObservationSinkInput): Promise<void> {
      const artifact = await normalizeVisualObservationArtifact(input.artifact);
      if (artifact.cacheKey === null || artifact.inferenceCacheKey === null) {
        invalid("$.artifact.cacheKey", "R2 sink cannot persist an artifact without cache identities");
      }
      if (input.cacheKey !== artifact.cacheKey || input.inferenceCacheKey !== artifact.inferenceCacheKey) {
        invalid("$", "sink identity fields do not match the normalized artifact");
      }
      const epochDigest = digestFromCacheKey(artifact.cacheKey, OBSERVATION_CACHE_KEY, "$.artifact.cacheKey");
      const storage = validateStorageKey(storageForEpochDigest(epochDigest), epochDigest, "observation storage key");
      const canonicalBytes = enc.encode(canonicalJson(artifact));
      const contentSha256 = await sha256Hex(canonicalBytes);
      if (input.contentSha256 !== contentSha256) {
        invalid("$.contentSha256", "declared content digest does not match the normalized artifact");
      }
      if (!(input.canonicalBytes instanceof Uint8Array) || !equalBytes(input.canonicalBytes, canonicalBytes)) {
        invalid("$.canonicalBytes", "bytes are not the exact canonical encoding of the normalized artifact");
      }
      await putBytesImmutable(bucket, storage.key, canonicalBytes);
    },
  };
}

export async function readVisualObservationArtifact(
  bucket: R2Bucket,
  storage: VisualStorageKeyRef,
): Promise<VisualObservationArtifact | null> {
  const normalizedStorage = validateStorageKey(storage, storage.digest, "observation storage key");
  const bytes = await readObjectBytes(bucket, normalizedStorage.key);
  if (bytes === null) return null;
  const artifact = await parseCanonicalObject(bytes, normalizedStorage.key, normalizeVisualObservationArtifact);
  if (artifact.cacheKey === null) {
    throw new VisualStorageCorruptionError(normalizedStorage.key, "stored observation has no epoch cache identity");
  }
  const digest = digestFromCacheKey(artifact.cacheKey, OBSERVATION_CACHE_KEY, "$.cacheKey");
  if (digest !== normalizedStorage.digest) {
    throw new VisualStorageCorruptionError(normalizedStorage.key, "observation cache identity does not bind the key");
  }
  return artifact;
}

// -------------------------------------------------------------------------------------
// Receipt normalization
// -------------------------------------------------------------------------------------

async function normalizeInferenceClaim(value: unknown, expectedDigest: string): Promise<VisualInferenceClaimReceipt> {
  rejectDecisionFields(value, "$claim");
  const root = object(value, "$claim", [
    "schemaVersion",
    "kind",
    "inferenceCacheKey",
    "callId",
    "claimedAt",
    "request",
  ]);
  literal(root.schemaVersion, VISUAL_INFERENCE_CLAIM_SCHEMA_VERSION, "$claim.schemaVersion");
  literal(root.kind, "survey-qa-visual-inference-claim", "$claim.kind");
  const inferenceCacheKey = cacheKey(root.inferenceCacheKey, INFERENCE_CACHE_KEY, "$claim.inferenceCacheKey");
  const digest = digestFromCacheKey(inferenceCacheKey, INFERENCE_CACHE_KEY, "$claim.inferenceCacheKey");
  if (digest !== expectedDigest) invalid("$claim.inferenceCacheKey", "digest does not bind the storage keys");
  const callId = boundedString(root.callId, "$claim.callId", 200);
  if (callId !== `visual-${digest.slice(-32)}`) invalid("$claim.callId", "does not derive from the inference identity");
  const claimedAt = isoTimestamp(root.claimedAt, "$claim.claimedAt");
  const request = object(root.request, "$claim.request", [
    "screenshotSha256",
    "mediaType",
    "pixelWidth",
    "pixelHeight",
    "provider",
    "model",
    "transport",
    "configurationSha256",
    "prompt",
    "responseSchema",
  ]);
  const screenshotSha256 = hash(request.screenshotSha256, "$claim.request.screenshotSha256");
  literal(request.mediaType, "image/png", "$claim.request.mediaType");
  const pixelWidth = positiveInteger(request.pixelWidth, "$claim.request.pixelWidth", 100_000);
  const pixelHeight = positiveInteger(request.pixelHeight, "$claim.request.pixelHeight", 100_000);
  const provider = boundedString(request.provider, "$claim.request.provider", 200);
  const model = boundedString(request.model, "$claim.request.model", 300);
  const transport = boundedString(request.transport, "$claim.request.transport", 200);
  const configurationSha256 = hash(request.configurationSha256, "$claim.request.configurationSha256");
  const prompt = versionHash(request.prompt, "$claim.request.prompt");
  const responseSchema = versionHash(request.responseSchema, "$claim.request.responseSchema");
  literal(prompt.version, VISUAL_PROMPT_VERSION, "$claim.request.prompt.version");
  literal(responseSchema.version, VISUAL_RESPONSE_SCHEMA_VERSION, "$claim.request.responseSchema.version");
  const recomputed = await computeVisualInferenceCacheKey({
    screenshotSha256,
    pixelWidth,
    pixelHeight,
    provider,
    model,
    configurationSha256,
    promptSha256: prompt.sha256,
    responseSchemaSha256: responseSchema.sha256,
  });
  if (recomputed !== inferenceCacheKey) {
    invalid("$claim.inferenceCacheKey", "request fields do not re-derive the paid inference identity");
  }
  return {
    schemaVersion: VISUAL_INFERENCE_CLAIM_SCHEMA_VERSION,
    kind: "survey-qa-visual-inference-claim",
    inferenceCacheKey,
    callId,
    claimedAt,
    request: {
      screenshotSha256,
      mediaType: "image/png",
      pixelWidth,
      pixelHeight,
      provider,
      model,
      transport,
      configurationSha256,
      prompt,
      responseSchema,
    },
  };
}

async function normalizeInferenceOutcome(
  value: unknown,
  claim: VisualInferenceClaimReceipt,
  expectedDigest: string,
): Promise<VisualInferenceOutcomeReceipt> {
  rejectDecisionFields(value, "$outcome");
  const root = object(value, "$outcome", [
    "schemaVersion",
    "kind",
    "inferenceCacheKey",
    "callId",
    "settledAt",
    "result",
    "telemetry",
  ]);
  literal(root.schemaVersion, VISUAL_INFERENCE_OUTCOME_SCHEMA_VERSION, "$outcome.schemaVersion");
  literal(root.kind, "survey-qa-visual-inference-outcome", "$outcome.kind");
  const inferenceCacheKey = cacheKey(root.inferenceCacheKey, INFERENCE_CACHE_KEY, "$outcome.inferenceCacheKey");
  if (digestFromCacheKey(inferenceCacheKey, INFERENCE_CACHE_KEY, "$outcome.inferenceCacheKey") !== expectedDigest) {
    invalid("$outcome.inferenceCacheKey", "digest does not bind the storage keys");
  }
  if (inferenceCacheKey !== claim.inferenceCacheKey) invalid("$outcome.inferenceCacheKey", "does not match claim");
  const callId = boundedString(root.callId, "$outcome.callId", 200);
  if (callId !== claim.callId) invalid("$outcome.callId", "does not match claim");
  const settledAt = isoTimestamp(root.settledAt, "$outcome.settledAt");
  const resultObject = objectAtLeast(root.result, "$outcome.result");
  const state = oneOf(resultObject.state, ["observed", "timeout", "unavailable", "malformed"] as const, "$outcome.result.state");
  let result: VisualInferenceOutcomeResult;
  let notAttempted = false;
  if (state === "observed") {
    exactKeys(resultObject, "$outcome.result", ["state", "inventory", "responseSha256"]);
    const parsed = validateModelVisualInventory(resultObject.inventory);
    if (!parsed.ok) invalid(`$outcome.result.inventory${parsed.issue.path.slice(1)}`, parsed.issue.code);
    const responseSha256 = hash(resultObject.responseSha256, "$outcome.result.responseSha256");
    if ((await sha256Hex(canonicalJson(parsed.value))) !== responseSha256) {
      invalid("$outcome.result.responseSha256", "does not hash the normalized model inventory");
    }
    result = { state: "observed", inventory: parsed.value, responseSha256 };
  } else {
    exactKeys(resultObject, "$outcome.result", ["state", "inventory", "responseSha256", "failure"]);
    if (resultObject.inventory !== null) invalid("$outcome.result.inventory", "must be null for a non-observed outcome");
    const responseSha256 = nullableHash(resultObject.responseSha256, "$outcome.result.responseSha256");
    const failureObject = object(resultObject.failure, "$outcome.result.failure", ["kind", "count", "detail"]);
    const failure = {
      kind: boundedString(failureObject.kind, "$outcome.result.failure.kind", 200),
      count: positiveInteger(failureObject.count, "$outcome.result.failure.count", 1_000_000),
      detail: boundedStringAllowEmpty(failureObject.detail, "$outcome.result.failure.detail", MAX_DETAIL),
    };
    const declaresNotAttempted =
      failure.kind === "provider-not-attempted" ||
      failure.kind.startsWith("provider-not-attempted:");
    notAttempted = persistedNotAttemptedPreflightReference(failure.kind) !== null;
    if (declaresNotAttempted && !notAttempted) {
      invalid(
        "$outcome.result.failure.kind",
        "unknown or malformed provider-not-attempted preflight tuple",
      );
    }
    result = { state, inventory: null, responseSha256, failure };
  }
  const telemetry = root.telemetry === null ? null : normalizeTelemetry(root.telemetry, "$outcome.telemetry");
  if (state === "observed" && telemetry === null) {
    invalid("$outcome.telemetry", "an observed provider response must carry call telemetry");
  }
  if (notAttempted && (state !== "unavailable" || telemetry !== null)) {
    invalid(
      "$outcome.result.failure.kind",
      "a not-attempted receipt must be unavailable and carry null telemetry",
    );
  }
  if (telemetry !== null) {
    if (telemetry.callId !== claim.callId || telemetry.provider !== claim.request.provider) {
      invalid("$outcome.telemetry", "call/provider identity does not match the claim");
    }
    // `telemetry.model` is the provider-REPORTED model, not the requested model. Preserve a
    // drift verbatim so the observer can name `model-identity-mismatch`; rejecting it here
    // would strand the pre-call claim, erase the evidence of substitution, and turn a settled
    // paid request into an indeterminate one. The requested identity remains sealed in `claim`.
  }
  return {
    schemaVersion: VISUAL_INFERENCE_OUTCOME_SCHEMA_VERSION,
    kind: "survey-qa-visual-inference-outcome",
    inferenceCacheKey,
    callId,
    settledAt,
    result,
    telemetry,
  };
}

function persistedNotAttemptedPreflightReference(
  failureKind: string,
): { category: string; code: string } | null {
  const match =
    /^provider-not-attempted:([a-z0-9][a-z0-9-]{0,99}):([a-z0-9][a-z0-9-]{0,99})$/.exec(
      failureKind,
    );
  return match === null
    ? null
    : allowedNotAttemptedPreflightReference(match[1], match[2]);
}

// -------------------------------------------------------------------------------------
// Grounded observation validation
// -------------------------------------------------------------------------------------

export async function normalizeVisualObservationArtifact(value: unknown): Promise<VisualObservationArtifact> {
  rejectDecisionFields(value, "$observation");
  const root = object(value, "$observation", [
    "schemaVersion",
    "kind",
    "createdAt",
    "readState",
    "inferenceCacheKey",
    "cacheKey",
    "input",
    "provenance",
    "inventory",
    "limitations",
    "counts",
  ]);
  literal(root.schemaVersion, "survey-qa-visual-observation/1.0.0", "$observation.schemaVersion");
  literal(root.kind, "survey-qa-visual-observation", "$observation.kind");
  const createdAt = isoTimestamp(root.createdAt, "$observation.createdAt");
  const readState = oneOf(
    root.readState,
    ["observed", "input-invalid", "timeout", "unavailable", "malformed"] as const,
    "$observation.readState",
  );
  const inferenceCacheKey = nullableCacheKey(root.inferenceCacheKey, INFERENCE_CACHE_KEY, "$observation.inferenceCacheKey");
  const cacheKeyValue = nullableCacheKey(root.cacheKey, OBSERVATION_CACHE_KEY, "$observation.cacheKey");
  if ((inferenceCacheKey === null) !== (cacheKeyValue === null)) {
    invalid("$observation", "inference and epoch cache identities must be null or present together");
  }
  if (readState === "input-invalid" && inferenceCacheKey !== null) {
    invalid("$observation.inferenceCacheKey", "input-invalid observations must not claim a paid inference identity");
  }
  if (readState !== "input-invalid" && inferenceCacheKey === null) {
    invalid("$observation.inferenceCacheKey", "a provider-stage observation requires a paid inference identity");
  }

  const input = normalizeObservationInput(root.input, "$observation.input");
  const provenance = normalizeObservationProvenance(root.provenance, "$observation.provenance");
  const inventory = normalizeVisualInventory(root.inventory, "$observation.inventory", input);
  const limitations = array(root.limitations, "$observation.limitations", 1_000, normalizeObservationLimitation);
  const emptyInventoryLimitations = limitations.filter(
    (limitation) => limitation.kind === "model-inventory-empty-despite-paired-content",
  );
  if (emptyInventoryLimitations.length > 0) {
    const limitation = emptyInventoryLimitations[0]!;
    if (
      emptyInventoryLimitations.length !== 1 ||
      limitation.count !== 1 ||
      limitation.scope !== "grounding" ||
      readState !== "observed"
    ) {
      invalid(
        "$observation.limitations",
        "model-inventory-empty-despite-paired-content must be one counted grounding limitation on an observed read",
      );
    }
    if (
      inventory.questionRegions.length !== 0 ||
      inventory.optionGroups.length !== 0 ||
      inventory.controls.length !== 0 ||
      inventory.messages.length !== 0 ||
      inventory.visualLimitations.length !== 0
    ) {
      invalid(
        "$observation.inventory",
        "model-inventory-empty-despite-paired-content requires the exact unqualified empty inventory",
      );
    }
  }
  const countsObject = object(root.counts, "$observation.counts", [
    "questionRegions",
    "optionGroups",
    "options",
    "controls",
    "messages",
    "modelReportedVisualLimitations",
    "metadataGroundedQuotes",
    "visualOnlyQuotes",
    "limitations",
  ]);
  const counts = {
    questionRegions: nonnegativeInteger(countsObject.questionRegions, "$observation.counts.questionRegions", 100_000),
    optionGroups: nonnegativeInteger(countsObject.optionGroups, "$observation.counts.optionGroups", 100_000),
    options: nonnegativeInteger(countsObject.options, "$observation.counts.options", 1_000_000),
    controls: nonnegativeInteger(countsObject.controls, "$observation.counts.controls", 100_000),
    messages: nonnegativeInteger(countsObject.messages, "$observation.counts.messages", 100_000),
    modelReportedVisualLimitations: nonnegativeInteger(
      countsObject.modelReportedVisualLimitations,
      "$observation.counts.modelReportedVisualLimitations",
      1_000_000,
    ),
    metadataGroundedQuotes: nonnegativeInteger(
      countsObject.metadataGroundedQuotes,
      "$observation.counts.metadataGroundedQuotes",
      1_000_000,
    ),
    visualOnlyQuotes: nonnegativeInteger(countsObject.visualOnlyQuotes, "$observation.counts.visualOnlyQuotes", 1_000_000),
    limitations: nonnegativeInteger(countsObject.limitations, "$observation.counts.limitations", 1_000_000),
  };
  const quoteKinds = inventoryQuotes(inventory).map((item) => item.grounding.kind);
  const expectedCounts = {
    questionRegions: inventory.questionRegions.length,
    optionGroups: inventory.optionGroups.length,
    options: inventory.optionGroups.reduce((sum, group) => sum + group.options.length, 0),
    controls: inventory.controls.length,
    messages: inventory.messages.length,
    modelReportedVisualLimitations: inventory.visualLimitations.reduce((sum, item) => sum + item.count, 0),
    metadataGroundedQuotes: quoteKinds.filter((kind) => kind === "paired-accessibility-exact").length,
    visualOnlyQuotes: quoteKinds.filter((kind) => kind === "visual-only").length,
    limitations: limitations.reduce((sum, item) => sum + item.count, 0),
  };
  assertSameCounts(counts, expectedCounts, "$observation.counts");

  if (inferenceCacheKey !== null && cacheKeyValue !== null) {
    const recomputedInference = await computeVisualInferenceCacheKey({
      screenshotSha256: input.screenshotSha256,
      pixelWidth: input.geometry.screenshotPixelWidth,
      pixelHeight: input.geometry.screenshotPixelHeight,
      provider: provenance.model.provider,
      model: provenance.model.requestedModel,
      configurationSha256: provenance.model.configurationSha256,
      promptSha256: provenance.prompt.sha256,
      responseSchemaSha256: provenance.responseSchema.sha256,
    });
    if (recomputedInference !== inferenceCacheKey) {
      invalid("$observation.inferenceCacheKey", "artifact fields do not re-derive the inference identity");
    }
    const recomputedObservation = await computeVisualObservationCacheKey({
      screenshotSha256: input.screenshotSha256,
      pairedEvidenceSha256: input.pairedEvidenceSha256,
      provider: provenance.model.provider,
      model: provenance.model.requestedModel,
      configurationSha256: provenance.model.configurationSha256,
      promptSha256: provenance.prompt.sha256,
      responseSchemaSha256: provenance.responseSchema.sha256,
    });
    if (recomputedObservation !== cacheKeyValue) {
      invalid("$observation.cacheKey", "artifact fields do not re-derive the epoch grounding identity");
    }
  }

  const recomputedPair = await computePairedEvidenceSha256({
    capture: input.capture,
    geometry: input.geometry,
    screen: input.screen,
    accessibility: input.accessibility,
  });
  if (recomputedPair !== input.pairedEvidenceSha256) {
    invalid("$observation.input.pairedEvidenceSha256", "capture channels do not re-derive the pairing digest");
  }

  if (provenance.call !== null) {
    if (inferenceCacheKey === null) invalid("$observation.provenance.call", "call telemetry requires an inference identity");
    const digest = digestFromCacheKey(inferenceCacheKey, INFERENCE_CACHE_KEY, "$observation.inferenceCacheKey");
    if (provenance.call.callId !== `visual-${digest.slice(-32)}`) {
      invalid("$observation.provenance.call.callId", "does not derive from inference identity");
    }
    if (
      provenance.call.provider !== provenance.model.provider ||
      provenance.call.model !== provenance.model.requestedModel
    ) {
      invalid("$observation.provenance.call", "telemetry provider/model does not match provenance model");
    }
  }

  return {
    schemaVersion: "survey-qa-visual-observation/1.0.0",
    kind: "survey-qa-visual-observation",
    createdAt,
    readState,
    inferenceCacheKey,
    cacheKey: cacheKeyValue,
    input,
    provenance,
    inventory,
    limitations,
    counts,
  };
}

function normalizeObservationInput(value: unknown, path: string): VisualObservationArtifact["input"] {
  const root = object(value, path, [
    "screenshotEvidenceId",
    "screenshotSha256",
    "screen",
    "accessibility",
    "pairedEvidenceSha256",
    "capture",
    "geometry",
  ]);
  return {
    screenshotEvidenceId: boundedString(root.screenshotEvidenceId, `${path}.screenshotEvidenceId`, 500),
    screenshotSha256: hash(root.screenshotSha256, `${path}.screenshotSha256`),
    screen: normalizeMetadataBinding(root.screen, `${path}.screen`),
    accessibility: normalizeMetadataBinding(root.accessibility, `${path}.accessibility`),
    pairedEvidenceSha256: hash(root.pairedEvidenceSha256, `${path}.pairedEvidenceSha256`),
    capture: normalizeCapture(root.capture, `${path}.capture`),
    geometry: normalizeGeometry(root.geometry, `${path}.geometry`),
  };
}

function normalizeMetadataBinding(
  value: unknown,
  path: string,
): VisualObservationArtifact["input"]["screen"] {
  const root = objectAtLeast(value, path);
  const state = oneOf(root.state, ["captured", "unavailable"] as const, `${path}.state`);
  if (state === "captured") {
    exactKeys(root, path, ["state", "evidenceId", "contentSha256"]);
    return {
      state,
      evidenceId: boundedString(root.evidenceId, `${path}.evidenceId`, 500),
      contentSha256: hash(root.contentSha256, `${path}.contentSha256`),
    };
  }
  exactKeys(root, path, ["state", "failure"]);
  const failure = object(root.failure, `${path}.failure`, ["kind", "count", "detail"]);
  return {
    state,
    failure: {
      kind: boundedString(failure.kind, `${path}.failure.kind`, 200),
      count: positiveInteger(failure.count, `${path}.failure.count`, 1_000_000),
      detail: boundedStringAllowEmpty(failure.detail, `${path}.failure.detail`, MAX_DETAIL),
    },
  };
}

function normalizeCapture(value: unknown, path: string): VisualCaptureIdentity {
  const root = object(value, path, ["runId", "attemptId", "pathId", "stepIndex", "slot", "epochId", "scope"]);
  const scopeObject = objectAtLeast(root.scope, `${path}.scope`);
  const kind = oneOf(scopeObject.kind, ["viewport", "tile"] as const, `${path}.scope.kind`);
  let scope: VisualCaptureIdentity["scope"];
  if (kind === "viewport") {
    exactKeys(scopeObject, `${path}.scope`, ["kind", "tileIndex", "tileCount"]);
    if (scopeObject.tileIndex !== null || scopeObject.tileCount !== null) {
      invalid(`${path}.scope`, "viewport scope requires null tile coordinates");
    }
    scope = { kind, tileIndex: null, tileCount: null };
  } else {
    exactKeys(scopeObject, `${path}.scope`, ["kind", "tileIndex", "tileCount"]);
    const tileIndex = nonnegativeInteger(scopeObject.tileIndex, `${path}.scope.tileIndex`, 100_000);
    const tileCount = positiveInteger(scopeObject.tileCount, `${path}.scope.tileCount`, 100_000);
    if (tileIndex >= tileCount) invalid(`${path}.scope.tileIndex`, "must be less than tileCount");
    scope = { kind, tileIndex, tileCount };
  }
  return {
    runId: boundedString(root.runId, `${path}.runId`, 200),
    attemptId: boundedString(root.attemptId, `${path}.attemptId`, 200),
    pathId: boundedString(root.pathId, `${path}.pathId`, 200),
    stepIndex: stepOrdinal(root.stepIndex, `${path}.stepIndex`, 1_000_000),
    slot: boundedString(root.slot, `${path}.slot`, 100),
    epochId: boundedString(root.epochId, `${path}.epochId`, 200),
    scope,
  };
}

function normalizeGeometry(value: unknown, path: string): VisualCaptureGeometry {
  const root = object(value, path, [
    "source",
    "viewportCssWidth",
    "viewportCssHeight",
    "screenshotPixelWidth",
    "screenshotPixelHeight",
    "deviceScaleFactor",
    "scrollX",
    "scrollY",
  ]);
  const source = oneOf(root.source, ["browser", "configured-fallback"] as const, `${path}.source`);
  const geometry: VisualCaptureGeometry = {
    source,
    viewportCssWidth: positiveInteger(root.viewportCssWidth, `${path}.viewportCssWidth`, 100_000),
    viewportCssHeight: positiveInteger(root.viewportCssHeight, `${path}.viewportCssHeight`, 100_000),
    screenshotPixelWidth: positiveInteger(root.screenshotPixelWidth, `${path}.screenshotPixelWidth`, 200_000),
    screenshotPixelHeight: positiveInteger(root.screenshotPixelHeight, `${path}.screenshotPixelHeight`, 200_000),
    deviceScaleFactor: nullablePositiveFinite(root.deviceScaleFactor, `${path}.deviceScaleFactor`, 100),
    scrollX: nullableFinite(root.scrollX, `${path}.scrollX`, 10_000_000),
    scrollY: nullableFinite(root.scrollY, `${path}.scrollY`, 10_000_000),
  };
  if (source === "configured-fallback") {
    if (geometry.deviceScaleFactor !== null || geometry.scrollX !== null || geometry.scrollY !== null) {
      invalid(path, "configured fallback geometry must name unknown DPR and scroll values as null");
    }
  } else if (geometry.deviceScaleFactor === null || geometry.scrollX === null || geometry.scrollY === null) {
    invalid(path, "browser geometry requires measured DPR and scroll values");
  }
  return geometry;
}

function normalizeObservationProvenance(
  value: unknown,
  path: string,
): VisualObservationArtifact["provenance"] {
  const root = object(value, path, ["model", "prompt", "responseSchema", "call"]);
  const model = object(root.model, `${path}.model`, [
    "provider",
    "requestedModel",
    "reportedModel",
    "transport",
    "configurationSha256",
  ]);
  const normalizedModel = {
    provider: boundedString(model.provider, `${path}.model.provider`, 200),
    requestedModel: boundedString(model.requestedModel, `${path}.model.requestedModel`, 300),
    reportedModel: nullableBoundedString(model.reportedModel, `${path}.model.reportedModel`, 300),
    transport: boundedString(model.transport, `${path}.model.transport`, 200),
    configurationSha256: hash(model.configurationSha256, `${path}.model.configurationSha256`),
  };
  const prompt = versionHash(root.prompt, `${path}.prompt`);
  const responseSchema = versionHash(root.responseSchema, `${path}.responseSchema`);
  literal(prompt.version, VISUAL_PROMPT_VERSION, `${path}.prompt.version`);
  literal(responseSchema.version, VISUAL_RESPONSE_SCHEMA_VERSION, `${path}.responseSchema.version`);
  let call: VisualObservationArtifact["provenance"]["call"] = null;
  if (root.call !== null) {
    const callObject = objectAtLeast(root.call, `${path}.call`);
    exactKeys(callObject, `${path}.call`, [
      "callId",
      "provider",
      "model",
      "providerRequestId",
      "gatewayLogId",
      "inputTokens",
      "outputTokens",
      "costUsd",
      "usageSource",
      "attempts",
      "latencyMs",
      "responseSha256",
    ]);
    call = {
      ...normalizeTelemetry(callObject, `${path}.call`),
      responseSha256: nullableHash(callObject.responseSha256, `${path}.call.responseSha256`),
    };
  }
  return { model: normalizedModel, prompt, responseSchema, call };
}

function normalizeTelemetry(value: unknown, path: string): VisionCallTelemetry {
  const root = objectAtLeast(value, path);
  const telemetryKeys = [
    "callId",
    "provider",
    "model",
    "providerRequestId",
    "gatewayLogId",
    "inputTokens",
    "outputTokens",
    "costUsd",
    "usageSource",
    "attempts",
    "latencyMs",
  ];
  const allowed = new Set([...telemetryKeys, "responseSha256"]);
  for (const key of Object.keys(root)) {
    if (!allowed.has(key)) invalid(path, `unknown field ${JSON.stringify(key)}`);
  }
  for (const key of telemetryKeys) {
    if (!Object.prototype.hasOwnProperty.call(root, key)) invalid(path, `missing field ${JSON.stringify(key)}`);
  }
  return {
    callId: boundedString(root.callId, `${path}.callId`, 200),
    provider: boundedString(root.provider, `${path}.provider`, 200),
    model: boundedString(root.model, `${path}.model`, 300),
    providerRequestId: nullableBoundedString(root.providerRequestId, `${path}.providerRequestId`, 500),
    gatewayLogId: nullableBoundedString(root.gatewayLogId, `${path}.gatewayLogId`, 500),
    inputTokens: nullableNonnegativeInteger(root.inputTokens, `${path}.inputTokens`, 1_000_000_000),
    outputTokens: nullableNonnegativeInteger(root.outputTokens, `${path}.outputTokens`, 1_000_000_000),
    costUsd: nullableNonnegativeFinite(root.costUsd, `${path}.costUsd`, 1_000_000),
    usageSource: oneOf(
      root.usageSource,
      ["provider-reported", "gateway-reported", "configured-rate", "unavailable"] as const,
      `${path}.usageSource`,
    ),
    attempts: positiveInteger(root.attempts, `${path}.attempts`, 100),
    latencyMs: nonnegativeFinite(root.latencyMs, `${path}.latencyMs`, 86_400_000),
  };
}

function normalizeVisualInventory(
  value: unknown,
  path: string,
  input: VisualObservationArtifact["input"],
): VisualInventory {
  const root = object(value, path, ["questionRegions", "optionGroups", "controls", "messages", "visualLimitations"]);
  const questionRegions = array(root.questionRegions, `${path}.questionRegions`, 200, (item, itemPath) => {
    const question = object(item, itemPath, ["localId", "text"]);
    return {
      localId: boundedString(question.localId, `${itemPath}.localId`, 200),
      text: normalizeGroundedReading(question.text, `${itemPath}.text`, input),
    } satisfies VisualQuestionRegion;
  });
  const optionGroups = array(root.optionGroups, `${path}.optionGroups`, 200, (item, itemPath) => {
    const group = object(item, itemPath, ["localId", "questionRegionId", "selectionAppearance", "bounds", "options"]);
    const options = array(group.options, `${itemPath}.options`, 200, (optionValue, optionPath) => {
      const option = object(optionValue, optionPath, ["localId", "text", "markAppearance"]);
      return {
        localId: boundedString(option.localId, `${optionPath}.localId`, 200),
        text: normalizeGroundedReading(option.text, `${optionPath}.text`, input),
        markAppearance: oneOf(
          option.markAppearance,
          ["appears-selected", "appears-unselected", "appears-indeterminate", "unknown"] as const,
          `${optionPath}.markAppearance`,
        ),
      } satisfies VisualOptionRegion;
    });
    ensureUnique(options.map((option) => option.localId), `${itemPath}.options`, "localId");
    return {
      localId: boundedString(group.localId, `${itemPath}.localId`, 200),
      questionRegionId: nullableBoundedString(group.questionRegionId, `${itemPath}.questionRegionId`, 200),
      selectionAppearance: oneOf(
        group.selectionAppearance,
        ["appears-single", "appears-multiple", "unknown"] as const,
        `${itemPath}.selectionAppearance`,
      ),
      bounds: normalizeBounds(group.bounds, `${itemPath}.bounds`),
      options,
    } satisfies VisualOptionGroup;
  });
  const controls = array(root.controls, `${path}.controls`, 300, (item, itemPath) => {
    const control = object(item, itemPath, [
      "localId",
      "kind",
      "text",
      "availabilityAppearance",
      "selectionAppearance",
      "bounds",
    ]);
    return {
      localId: boundedString(control.localId, `${itemPath}.localId`, 200),
      kind: oneOf(
        control.kind,
        ["button", "text-entry", "select", "link", "option-control", "other"] as const,
        `${itemPath}.kind`,
      ),
      text: control.text === null ? null : normalizeGroundedReading(control.text, `${itemPath}.text`, input),
      availabilityAppearance: oneOf(
        control.availabilityAppearance,
        ["appears-enabled", "appears-disabled", "unknown"] as const,
        `${itemPath}.availabilityAppearance`,
      ),
      selectionAppearance: oneOf(
        control.selectionAppearance,
        ["appears-selected", "appears-unselected", "appears-indeterminate", "not-applicable", "unknown"] as const,
        `${itemPath}.selectionAppearance`,
      ),
      bounds: normalizeBounds(control.bounds, `${itemPath}.bounds`),
    } satisfies VisualControlRegion;
  });
  const messages = array(root.messages, `${path}.messages`, 200, (item, itemPath) => {
    const message = object(item, itemPath, ["localId", "kind", "text"]);
    return {
      localId: boundedString(message.localId, `${itemPath}.localId`, 200),
      kind: oneOf(message.kind, ["instruction", "validation", "progress", "other"] as const, `${itemPath}.kind`),
      text: normalizeGroundedReading(message.text, `${itemPath}.text`, input),
    } satisfies VisualMessageRegion;
  });
  const visualLimitations = array(root.visualLimitations, `${path}.visualLimitations`, 200, (item, itemPath) => {
    const limitation = object(item, itemPath, ["kind", "count", "bounds"]);
    return {
      kind: oneOf(
        limitation.kind,
        ["clipped", "occluded", "blurred", "too-small", "unreadable", "offscreen-indicator", "ambiguous-grouping"] as const,
        `${itemPath}.kind`,
      ),
      count: positiveInteger(limitation.count, `${itemPath}.count`, 1_000_000),
      bounds: limitation.bounds === null ? null : normalizeBounds(limitation.bounds, `${itemPath}.bounds`),
    };
  });
  ensureUnique(questionRegions.map((item) => item.localId), `${path}.questionRegions`, "localId");
  ensureUnique(optionGroups.map((item) => item.localId), `${path}.optionGroups`, "localId");
  ensureUnique(controls.map((item) => item.localId), `${path}.controls`, "localId");
  ensureUnique(messages.map((item) => item.localId), `${path}.messages`, "localId");
  return { questionRegions, optionGroups, controls, messages, visualLimitations };
}

function normalizeGroundedReading(
  value: unknown,
  path: string,
  input: VisualObservationArtifact["input"],
): GroundedTextReading {
  const root = object(value, path, ["quote", "alternatives", "readability", "modelConfidence", "bounds"]);
  return {
    quote: root.quote === null ? null : normalizeGroundedQuote(root.quote, `${path}.quote`, input),
    alternatives: array(root.alternatives, `${path}.alternatives`, 5, (item, itemPath) =>
      normalizeGroundedQuote(item, itemPath, input),
    ),
    readability: oneOf(root.readability, ["read", "uncertain", "unreadable"] as const, `${path}.readability`),
    modelConfidence: finiteRange(root.modelConfidence, `${path}.modelConfidence`, 0, 1),
    bounds: normalizeBounds(root.bounds, `${path}.bounds`),
  };
}

function normalizeGroundedQuote(
  value: unknown,
  path: string,
  input: VisualObservationArtifact["input"],
): { value: string; grounding: QuoteGrounding } {
  const root = object(value, path, ["value", "grounding"]);
  const groundingObject = objectAtLeast(root.grounding, `${path}.grounding`);
  const kind = oneOf(
    groundingObject.kind,
    ["paired-accessibility-exact", "visual-only"] as const,
    `${path}.grounding.kind`,
  );
  let grounding: QuoteGrounding;
  if (kind === "visual-only") {
    exactKeys(groundingObject, `${path}.grounding`, ["kind", "sourcePaths", "evidenceSha256"]);
    const sourcePaths = array(groundingObject.sourcePaths, `${path}.grounding.sourcePaths`, 0, () => "");
    if (sourcePaths.length !== 0) invalid(`${path}.grounding.sourcePaths`, "visual-only grounding must have no metadata path");
    const hashes = array(groundingObject.evidenceSha256, `${path}.grounding.evidenceSha256`, 1, hash);
    if (hashes.length !== 1 || hashes[0] !== input.screenshotSha256) {
      invalid(`${path}.grounding.evidenceSha256`, "visual-only grounding must name exactly the screenshot digest");
    }
    grounding = { kind, sourcePaths: [], evidenceSha256: [hashes[0]] };
  } else {
    exactKeys(groundingObject, `${path}.grounding`, ["kind", "sourcePaths", "evidenceSha256"]);
    const sourcePaths = nonemptyArray(groundingObject.sourcePaths, `${path}.grounding.sourcePaths`, 100, (item, itemPath) =>
      boundedString(item, itemPath, 1_000),
    );
    const hashes = nonemptyArray(groundingObject.evidenceSha256, `${path}.grounding.evidenceSha256`, 100, hash);
    if (input.accessibility.state !== "captured") {
      invalid(`${path}.grounding.evidenceSha256`, "accessibility grounding does not bind the paired AX artifact");
    }
    const accessibilitySha256 = input.accessibility.contentSha256;
    if (hashes.some((item) => item !== accessibilitySha256)) {
      invalid(`${path}.grounding.evidenceSha256`, "accessibility grounding does not bind the paired AX artifact");
    }
    grounding = { kind, sourcePaths, evidenceSha256: hashes };
  }
  return { value: boundedString(root.value, `${path}.value`, MAX_TEXT), grounding };
}

const OBSERVATION_LIMITATION_KINDS = [
  "input-screenshot-hash-mismatch",
  "input-screen-hash-mismatch",
  "input-accessibility-hash-mismatch",
  "input-pair-hash-mismatch",
  "input-capture-metadata-malformed",
  "input-capture-geometry-fallback",
  "input-screen-metadata-unavailable",
  "input-accessibility-metadata-unavailable",
  "input-json-unreadable",
  "input-screenshot-format-unsupported",
  "input-screenshot-dimensions-mismatch",
  "model-timeout",
  "model-unavailable",
  "model-identity-mismatch",
  "model-call-identity-mismatch",
  "model-response-malformed",
  "model-response-forbidden-decision-field",
  "model-region-reference-unbound",
  "model-region-not-metadata-grounded",
  "model-inventory-empty-despite-paired-content",
  "visual-observation-persistence-unavailable",
] as const;

function normalizeObservationLimitation(value: unknown, path: string): VisualObservationLimitation {
  const root = objectAtLeast(value, path);
  const hasProviderFailure = Object.prototype.hasOwnProperty.call(root, "providerFailure");
  exactKeys(
    root,
    path,
    hasProviderFailure
      ? ["kind", "count", "scope", "detail", "providerFailure"]
      : ["kind", "count", "scope", "detail"],
  );
  const kind = oneOf(root.kind, OBSERVATION_LIMITATION_KINDS, `${path}.kind`);
  const normalized = {
    kind,
    count: positiveInteger(root.count, `${path}.count`, 1_000_000),
    scope: oneOf(root.scope, ["input", "call", "response", "grounding", "persistence"] as const, `${path}.scope`),
    detail: boundedStringAllowEmpty(root.detail, `${path}.detail`, MAX_DETAIL),
  };
  if (!hasProviderFailure) return normalized;
  if (kind !== "model-unavailable" && kind !== "model-timeout") {
    invalid(`${path}.providerFailure`, "is permitted only on a provider call limitation");
  }
  const providerFailure = object(root.providerFailure, `${path}.providerFailure`, ["category", "code"]);
  const category = providerFailureSegment(providerFailure.category, `${path}.providerFailure.category`);
  const code = providerFailureSegment(providerFailure.code, `${path}.providerFailure.code`);
  return { ...normalized, providerFailure: { category, code } };
}

function providerFailureSegment(value: unknown, path: string): string {
  const segment = boundedString(value, path, 100);
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(segment)) {
    invalid(path, "must be a closed lowercase failure segment");
  }
  return segment;
}

// -------------------------------------------------------------------------------------
// Reconciliation validation and cross-binding
// -------------------------------------------------------------------------------------

const RECONCILIATION_LIMITATION_KINDS = [
  "visual-read-not-observed",
  "visual-question-reference-unbound",
  "visual-question-reference-nonunique",
  "visual-question-text-unreadable",
  "visual-question-text-ambiguous",
  "visual-question-label-nonunique",
  "visual-group-id-nonunique",
  "visual-groups-for-question-nonunique",
  "visual-option-id-nonunique",
  "visual-option-text-unreadable",
  "visual-option-text-ambiguous",
  "visual-option-label-nonunique",
  "visual-group-ambiguity-reported",
  "accessibility-capture-unavailable",
  "accessibility-reading-not-supplied",
  "accessibility-pair-mismatch",
  "accessibility-reading-truncated",
  "accessibility-question-group-nonunique",
  "accessibility-option-label-nonunique",
  "screen-capture-unavailable",
  "screen-reading-not-supplied",
  "screen-pair-mismatch",
  "channel-disagreement",
  "model-visual-limitation",
] as const;

export function normalizeOptionMembershipReconciliation(
  value: unknown,
  observation: VisualObservationArtifact,
): OptionMembershipReconciliation {
  rejectDecisionFields(value, "$reconciliation");
  const root = object(value, "$reconciliation", [
    "schemaVersion",
    "kind",
    "scope",
    "source",
    "facts",
    "conflicts",
    "limitations",
    "counts",
  ]);
  literal(root.schemaVersion, "survey-qa-option-membership-perception/1.0.0", "$reconciliation.schemaVersion");
  literal(root.kind, "survey-qa-option-membership-perception", "$reconciliation.kind");
  literal(root.scope, "visible-positive-membership-only", "$reconciliation.scope");
  const sourceObject = object(root.source, "$reconciliation.source", [
    "screenshotEvidenceId",
    "screenshotSha256",
    "pairedEvidenceSha256",
    "epochId",
  ]);
  const source = {
    screenshotEvidenceId: boundedString(sourceObject.screenshotEvidenceId, "$reconciliation.source.screenshotEvidenceId", 500),
    screenshotSha256: hash(sourceObject.screenshotSha256, "$reconciliation.source.screenshotSha256"),
    pairedEvidenceSha256: hash(sourceObject.pairedEvidenceSha256, "$reconciliation.source.pairedEvidenceSha256"),
    epochId: boundedString(sourceObject.epochId, "$reconciliation.source.epochId", 200),
  };
  if (
    source.screenshotEvidenceId !== observation.input.screenshotEvidenceId ||
    source.screenshotSha256 !== observation.input.screenshotSha256 ||
    source.pairedEvidenceSha256 !== observation.input.pairedEvidenceSha256 ||
    source.epochId !== observation.input.capture.epochId
  ) {
    invalid("$reconciliation.source", "does not bind the grounded observation epoch");
  }

  const facts = array(root.facts, "$reconciliation.facts", 100_000, (item, path) =>
    normalizeMembershipFact(item, path, observation),
  );
  const conflicts = array(root.conflicts, "$reconciliation.conflicts", 100_000, (item, path) =>
    normalizeChannelConflict(item, path, observation),
  );
  const limitations = array(root.limitations, "$reconciliation.limitations", 10_000, (item, path) => {
    const limitation = object(item, path, ["kind", "channel", "count", "detail"]);
    return {
      kind: oneOf(limitation.kind, RECONCILIATION_LIMITATION_KINDS, `${path}.kind`),
      channel: oneOf(limitation.channel, ["visual", "accessibility", "screen", "cross-channel"] as const, `${path}.channel`),
      count: positiveInteger(limitation.count, `${path}.count`, 1_000_000),
      detail: boundedStringAllowEmpty(limitation.detail, `${path}.detail`, MAX_DETAIL),
    };
  });
  const countsObject = object(root.counts, "$reconciliation.counts", [
    "visualGroupsSeen",
    "facts",
    "conflicts",
    "limitations",
  ]);
  const counts = {
    visualGroupsSeen: nonnegativeInteger(countsObject.visualGroupsSeen, "$reconciliation.counts.visualGroupsSeen", 100_000),
    facts: nonnegativeInteger(countsObject.facts, "$reconciliation.counts.facts", 1_000_000),
    conflicts: nonnegativeInteger(countsObject.conflicts, "$reconciliation.counts.conflicts", 1_000_000),
    limitations: nonnegativeInteger(countsObject.limitations, "$reconciliation.counts.limitations", 1_000_000),
  };
  assertSameCounts(
    counts,
    {
      visualGroupsSeen: observation.inventory.optionGroups.length,
      facts: facts.length,
      conflicts: conflicts.length,
      limitations: limitations.reduce((sum, item) => sum + item.count, 0),
    },
    "$reconciliation.counts",
  );
  return {
    schemaVersion: "survey-qa-option-membership-perception/1.0.0",
    kind: "survey-qa-option-membership-perception",
    scope: "visible-positive-membership-only",
    source,
    facts,
    conflicts,
    limitations,
    counts,
  };
}

function normalizeMembershipFact(
  value: unknown,
  path: string,
  observation: VisualObservationArtifact,
): OptionMembershipReconciliation["facts"][number] {
  const root = object(value, path, ["kind", "question", "group", "option", "source", "support"]);
  literal(root.kind, "option-membership", `${path}.kind`);
  const questionObject = object(root.question, `${path}.question`, [
    "text",
    "visualRegionId",
    "bounds",
    "modelConfidence",
    "quoteGrounding",
  ]);
  const groupObject = object(root.group, `${path}.group`, [
    "visualRegionId",
    "bounds",
    "selectionAppearance",
  ]);
  const optionObject = object(root.option, `${path}.option`, [
    "text",
    "visualRegionId",
    "bounds",
    "modelConfidence",
    "markAppearance",
    "quoteGrounding",
  ]);
  const question = {
    text: boundedString(questionObject.text, `${path}.question.text`, MAX_TEXT),
    visualRegionId: boundedString(questionObject.visualRegionId, `${path}.question.visualRegionId`, 200),
    bounds: normalizeBounds(questionObject.bounds, `${path}.question.bounds`),
    modelConfidence: finiteRange(questionObject.modelConfidence, `${path}.question.modelConfidence`, 0, 1),
    quoteGrounding: normalizeQuoteGrounding(questionObject.quoteGrounding, `${path}.question.quoteGrounding`, observation.input),
  };
  const group = {
    visualRegionId: boundedString(groupObject.visualRegionId, `${path}.group.visualRegionId`, 200),
    bounds: normalizeBounds(groupObject.bounds, `${path}.group.bounds`),
    selectionAppearance: oneOf(
      groupObject.selectionAppearance,
      ["appears-single", "appears-multiple", "unknown"] as const,
      `${path}.group.selectionAppearance`,
    ),
  };
  const option = {
    text: boundedString(optionObject.text, `${path}.option.text`, MAX_TEXT),
    visualRegionId: boundedString(optionObject.visualRegionId, `${path}.option.visualRegionId`, 200),
    bounds: normalizeBounds(optionObject.bounds, `${path}.option.bounds`),
    modelConfidence: finiteRange(optionObject.modelConfidence, `${path}.option.modelConfidence`, 0, 1),
    markAppearance: oneOf(
      optionObject.markAppearance,
      ["appears-selected", "appears-unselected", "appears-indeterminate", "unknown"] as const,
      `${path}.option.markAppearance`,
    ),
    quoteGrounding: normalizeQuoteGrounding(optionObject.quoteGrounding, `${path}.option.quoteGrounding`, observation.input),
  };
  assertFactVisualBinding(question, group, option, observation, path);

  const sourceObject = object(root.source, `${path}.source`, [
    "screenshotEvidenceId",
    "screenshotSha256",
    "pairedEvidenceSha256",
    "epochId",
    "stepIndex",
    "slot",
    "observationCacheKey",
    "screen",
  ]);
  const screen = normalizeScreenPairing(sourceObject.screen, `${path}.source.screen`, observation);
  const source = {
    screenshotEvidenceId: boundedString(sourceObject.screenshotEvidenceId, `${path}.source.screenshotEvidenceId`, 500),
    screenshotSha256: hash(sourceObject.screenshotSha256, `${path}.source.screenshotSha256`),
    pairedEvidenceSha256: hash(sourceObject.pairedEvidenceSha256, `${path}.source.pairedEvidenceSha256`),
    epochId: boundedString(sourceObject.epochId, `${path}.source.epochId`, 200),
    stepIndex: stepOrdinal(sourceObject.stepIndex, `${path}.source.stepIndex`, 1_000_000),
    slot: boundedString(sourceObject.slot, `${path}.source.slot`, 100),
    observationCacheKey: nullableCacheKey(sourceObject.observationCacheKey, OBSERVATION_CACHE_KEY, `${path}.source.observationCacheKey`),
    screen,
  };
  if (
    source.screenshotEvidenceId !== observation.input.screenshotEvidenceId ||
    source.screenshotSha256 !== observation.input.screenshotSha256 ||
    source.pairedEvidenceSha256 !== observation.input.pairedEvidenceSha256 ||
    source.epochId !== observation.input.capture.epochId ||
    source.stepIndex !== observation.input.capture.stepIndex ||
    source.slot !== observation.input.capture.slot ||
    source.observationCacheKey !== observation.cacheKey
  ) {
    invalid(`${path}.source`, "does not bind the exact observation epoch");
  }

  const supportObject = object(root.support, `${path}.support`, ["visual", "accessibility"]);
  literal(supportObject.visual, "question-group-option-exact", `${path}.support.visual`);
  const accessibility = normalizeAccessibilitySupport(
    supportObject.accessibility,
    `${path}.support.accessibility`,
    observation,
  );
  return {
    kind: "option-membership",
    question,
    group,
    option,
    source,
    support: { visual: "question-group-option-exact", accessibility },
  };
}

function assertFactVisualBinding(
  question: OptionMembershipReconciliation["facts"][number]["question"],
  group: OptionMembershipReconciliation["facts"][number]["group"],
  option: OptionMembershipReconciliation["facts"][number]["option"],
  observation: VisualObservationArtifact,
  path: string,
): void {
  const observedQuestion = observation.inventory.questionRegions.find((item) => item.localId === question.visualRegionId);
  const observedGroup = observation.inventory.optionGroups.find((item) => item.localId === group.visualRegionId);
  const observedOption = observedGroup?.options.find((item) => item.localId === option.visualRegionId);
  if (!observedQuestion || !observedGroup || !observedOption) invalid(path, "fact cites an unknown visual region");
  if (observedGroup.questionRegionId !== observedQuestion.localId) invalid(path, "fact group is not bound to its question region");
  const questionQuote = observedQuestion.text.quote;
  const optionQuote = observedOption.text.quote;
  if (
    questionQuote === null ||
    optionQuote === null ||
    question.text !== questionQuote.value ||
    option.text !== optionQuote.value ||
    canonicalJson(question.bounds) !== canonicalJson(observedQuestion.text.bounds) ||
    canonicalJson(group.bounds) !== canonicalJson(observedGroup.bounds) ||
    canonicalJson(option.bounds) !== canonicalJson(observedOption.text.bounds) ||
    question.modelConfidence !== observedQuestion.text.modelConfidence ||
    option.modelConfidence !== observedOption.text.modelConfidence ||
    canonicalJson(question.quoteGrounding) !== canonicalJson(questionQuote.grounding) ||
    canonicalJson(option.quoteGrounding) !== canonicalJson(optionQuote.grounding) ||
    group.selectionAppearance !== observedGroup.selectionAppearance ||
    option.markAppearance !== observedOption.markAppearance
  ) {
    invalid(path, "fact content does not exactly project the cited visual regions");
  }
}

function normalizeScreenPairing(
  value: unknown,
  path: string,
  observation: VisualObservationArtifact,
): OptionMembershipReconciliation["facts"][number]["source"]["screen"] {
  const root = objectAtLeast(value, path);
  const state = oneOf(root.state, ["paired", "unavailable", "not-supplied", "pair-mismatch"] as const, `${path}.state`);
  if (state === "paired") {
    exactKeys(root, path, ["state", "evidenceId", "contentSha256"]);
    const paired = {
      state,
      evidenceId: boundedString(root.evidenceId, `${path}.evidenceId`, 500),
      contentSha256: hash(root.contentSha256, `${path}.contentSha256`),
    };
    if (
      observation.input.screen.state !== "captured" ||
      paired.evidenceId !== observation.input.screen.evidenceId ||
      paired.contentSha256 !== observation.input.screen.contentSha256
    ) {
      invalid(path, "paired screen provenance does not match observation input");
    }
    return paired;
  }
  exactKeys(root, path, ["state"]);
  return { state };
}

function normalizeAccessibilitySupport(
  value: unknown,
  path: string,
  observation: VisualObservationArtifact,
): OptionMembershipReconciliation["facts"][number]["support"]["accessibility"] {
  const root = objectAtLeast(value, path);
  const state = oneOf(
    root.state,
    [
      "group-and-option-exact",
      "option-label-exact-without-group",
      "not-aligned",
      "ambiguous",
      "unavailable",
      "not-supplied",
      "pair-mismatch",
      "truncated",
    ] as const,
    `${path}.state`,
  );
  if (state === "group-and-option-exact") {
    exactKeys(root, path, ["state", "evidenceId", "contentSha256", "groupPath", "optionPath"]);
    const supported = {
      state,
      evidenceId: boundedString(root.evidenceId, `${path}.evidenceId`, 500),
      contentSha256: hash(root.contentSha256, `${path}.contentSha256`),
      groupPath: boundedString(root.groupPath, `${path}.groupPath`, 1_000),
      optionPath: boundedString(root.optionPath, `${path}.optionPath`, 1_000),
    };
    assertAccessibilityBinding(supported.evidenceId, supported.contentSha256, observation, path);
    return supported;
  }
  if (state === "option-label-exact-without-group") {
    exactKeys(root, path, ["state", "evidenceId", "contentSha256", "optionPath"]);
    const supported = {
      state,
      evidenceId: boundedString(root.evidenceId, `${path}.evidenceId`, 500),
      contentSha256: hash(root.contentSha256, `${path}.contentSha256`),
      optionPath: boundedString(root.optionPath, `${path}.optionPath`, 1_000),
    };
    assertAccessibilityBinding(supported.evidenceId, supported.contentSha256, observation, path);
    return supported;
  }
  exactKeys(root, path, ["state"]);
  return { state };
}

function assertAccessibilityBinding(
  evidenceId: string,
  contentSha256: string,
  observation: VisualObservationArtifact,
  path: string,
): void {
  if (
    observation.input.accessibility.state !== "captured" ||
    evidenceId !== observation.input.accessibility.evidenceId ||
    contentSha256 !== observation.input.accessibility.contentSha256
  ) {
    invalid(path, "AX support does not match the paired accessibility artifact");
  }
}

function normalizeChannelConflict(
  value: unknown,
  path: string,
  observation: VisualObservationArtifact,
): OptionMembershipReconciliation["conflicts"][number] {
  const root = object(value, path, [
    "kind",
    "channel",
    "question",
    "option",
    "groupVisualRegionId",
    "visualSource",
    "otherChannel",
  ]);
  literal(root.kind, "channel-disagreement", `${path}.kind`);
  literal(root.channel, "accessibility", `${path}.channel`);
  const questionObject = object(root.question, `${path}.question`, ["text", "visualRegionId"]);
  const optionObject = object(root.option, `${path}.option`, ["text", "visualRegionId"]);
  const visualSourceObject = object(root.visualSource, `${path}.visualSource`, ["screenshotEvidenceId", "screenshotSha256"]);
  const otherObject = object(root.otherChannel, `${path}.otherChannel`, [
    "evidenceId",
    "contentSha256",
    "questionPath",
    "observedOptionPaths",
    "observedOptionNames",
  ]);
  const question = {
    text: boundedString(questionObject.text, `${path}.question.text`, MAX_TEXT),
    visualRegionId: boundedString(questionObject.visualRegionId, `${path}.question.visualRegionId`, 200),
  };
  const option = {
    text: boundedString(optionObject.text, `${path}.option.text`, MAX_TEXT),
    visualRegionId: boundedString(optionObject.visualRegionId, `${path}.option.visualRegionId`, 200),
  };
  const groupVisualRegionId = boundedString(root.groupVisualRegionId, `${path}.groupVisualRegionId`, 200);
  const observedQuestion = observation.inventory.questionRegions.find((item) => item.localId === question.visualRegionId);
  const observedGroup = observation.inventory.optionGroups.find((item) => item.localId === groupVisualRegionId);
  const observedOption = observedGroup?.options.find((item) => item.localId === option.visualRegionId);
  if (
    !observedQuestion ||
    !observedGroup ||
    !observedOption ||
    observedGroup.questionRegionId !== observedQuestion.localId ||
    observedQuestion.text.quote?.value !== question.text ||
    observedOption.text.quote?.value !== option.text
  ) {
    invalid(path, "conflict does not bind known visual question/group/option regions");
  }
  const visualSource = {
    screenshotEvidenceId: boundedString(visualSourceObject.screenshotEvidenceId, `${path}.visualSource.screenshotEvidenceId`, 500),
    screenshotSha256: hash(visualSourceObject.screenshotSha256, `${path}.visualSource.screenshotSha256`),
  };
  if (
    visualSource.screenshotEvidenceId !== observation.input.screenshotEvidenceId ||
    visualSource.screenshotSha256 !== observation.input.screenshotSha256
  ) {
    invalid(`${path}.visualSource`, "does not bind observation screenshot");
  }
  const otherChannel = {
    evidenceId: boundedString(otherObject.evidenceId, `${path}.otherChannel.evidenceId`, 500),
    contentSha256: hash(otherObject.contentSha256, `${path}.otherChannel.contentSha256`),
    questionPath: boundedString(otherObject.questionPath, `${path}.otherChannel.questionPath`, 1_000),
    observedOptionPaths: array(otherObject.observedOptionPaths, `${path}.otherChannel.observedOptionPaths`, 1_000, (item, itemPath) =>
      boundedString(item, itemPath, 1_000),
    ),
    observedOptionNames: array(otherObject.observedOptionNames, `${path}.otherChannel.observedOptionNames`, 1_000, (item, itemPath) =>
      boundedString(item, itemPath, MAX_TEXT),
    ),
  };
  assertAccessibilityBinding(otherChannel.evidenceId, otherChannel.contentSha256, observation, `${path}.otherChannel`);
  return {
    kind: "channel-disagreement",
    channel: "accessibility",
    question,
    option,
    groupVisualRegionId,
    visualSource,
    otherChannel,
  };
}

function normalizeQuoteGrounding(
  value: unknown,
  path: string,
  input: VisualObservationArtifact["input"],
): QuoteGrounding {
  return normalizeGroundedQuote({ value: "binding-check", grounding: value }, path.replace(/\.quoteGrounding$/, ""), input).grounding;
}

// -------------------------------------------------------------------------------------
// Epoch and manifest validation
// -------------------------------------------------------------------------------------

async function normalizeGroundedVisualEpoch(value: unknown): Promise<GroundedVisualEpochResult> {
  rejectDecisionFields(value, "$epoch");
  const root = object(value, "$epoch", [
    "schemaVersion",
    "kind",
    "finalizedAt",
    "epochDigest",
    "inferenceDigest",
    "observationContentSha256",
    "reconciliationContentSha256",
    "observation",
    "reconciliation",
    "counts",
  ]);
  literal(root.schemaVersion, GROUNDED_VISUAL_EPOCH_SCHEMA_VERSION, "$epoch.schemaVersion");
  literal(root.kind, "survey-qa-grounded-visual-epoch", "$epoch.kind");
  const rebuilt = await createGroundedVisualEpochResult({
    finalizedAt: isoTimestamp(root.finalizedAt, "$epoch.finalizedAt"),
    observation: root.observation as VisualObservationArtifact,
    reconciliation: root.reconciliation as OptionMembershipReconciliation,
  });
  if (hash(root.epochDigest, "$epoch.epochDigest") !== rebuilt.epochDigest) invalid("$epoch.epochDigest", "derived value mismatch");
  if (hash(root.inferenceDigest, "$epoch.inferenceDigest") !== rebuilt.inferenceDigest) invalid("$epoch.inferenceDigest", "derived value mismatch");
  if (hash(root.observationContentSha256, "$epoch.observationContentSha256") !== rebuilt.observationContentSha256) {
    invalid("$epoch.observationContentSha256", "derived value mismatch");
  }
  if (hash(root.reconciliationContentSha256, "$epoch.reconciliationContentSha256") !== rebuilt.reconciliationContentSha256) {
    invalid("$epoch.reconciliationContentSha256", "derived value mismatch");
  }
  const counts = object(root.counts, "$epoch.counts", [
    "observationLimitations",
    "facts",
    "conflicts",
    "reconciliationLimitations",
  ]);
  assertSameCounts(
    {
      observationLimitations: nonnegativeInteger(counts.observationLimitations, "$epoch.counts.observationLimitations", 1_000_000),
      facts: nonnegativeInteger(counts.facts, "$epoch.counts.facts", 1_000_000),
      conflicts: nonnegativeInteger(counts.conflicts, "$epoch.counts.conflicts", 1_000_000),
      reconciliationLimitations: nonnegativeInteger(
        counts.reconciliationLimitations,
        "$epoch.counts.reconciliationLimitations",
        1_000_000,
      ),
    },
    rebuilt.counts,
    "$epoch.counts",
  );
  return rebuilt;
}

async function normalizeStoredEpoch(value: unknown, path: string): Promise<StoredGroundedVisualEpoch> {
  const root = object(value, path, ["storage", "contentSha256", "result"]);
  const result = await normalizeGroundedVisualEpoch(root.result);
  const storage = validateStorageKey(root.storage, result.epochDigest, `${path}.storage`);
  const contentSha256 = hash(root.contentSha256, `${path}.contentSha256`);
  if ((await sha256Hex(canonicalJson(result))) !== contentSha256) {
    invalid(`${path}.contentSha256`, "does not hash the normalized epoch result");
  }
  return { storage, contentSha256, result };
}

function manifestEntryFromEpoch(epoch: StoredGroundedVisualEpoch): VisualRunManifestEntry {
  const observation = epoch.result.observation;
  if (observation.cacheKey === null || observation.inferenceCacheKey === null) {
    invalid("$.epochs", "stored epoch has null cache identity");
  }
  return {
    epochDigest: epoch.result.epochDigest,
    inferenceDigest: epoch.result.inferenceDigest,
    epochResultKey: epoch.storage.key,
    epochResultSha256: epoch.contentSha256,
    observationCacheKey: observation.cacheKey,
    inferenceCacheKey: observation.inferenceCacheKey,
    epochId: observation.input.capture.epochId,
    readState: observation.readState,
    counts: {
      questionRegions: observation.counts.questionRegions,
      optionGroups: observation.counts.optionGroups,
      options: observation.counts.options,
      controls: observation.counts.controls,
      messages: observation.counts.messages,
      observationLimitations: epoch.result.counts.observationLimitations,
      facts: epoch.result.counts.facts,
      conflicts: epoch.result.counts.conflicts,
      reconciliationLimitations: epoch.result.counts.reconciliationLimitations,
    },
  };
}

function manifestTotals(entries: VisualRunManifestEntry[]): VisualRunManifest["totals"] {
  return entries.reduce<VisualRunManifest["totals"]>(
    (totals, entry) => {
      totals.epochs += 1;
      if (entry.readState === "observed") totals.observedEpochs += 1;
      else totals.nonObservedEpochs += 1;
      totals.questionRegions += entry.counts.questionRegions;
      totals.optionGroups += entry.counts.optionGroups;
      totals.options += entry.counts.options;
      totals.controls += entry.counts.controls;
      totals.messages += entry.counts.messages;
      totals.observationLimitations += entry.counts.observationLimitations;
      totals.facts += entry.counts.facts;
      totals.conflicts += entry.counts.conflicts;
      totals.reconciliationLimitations += entry.counts.reconciliationLimitations;
      return totals;
    },
    {
      epochs: 0,
      observedEpochs: 0,
      nonObservedEpochs: 0,
      questionRegions: 0,
      optionGroups: 0,
      options: 0,
      controls: 0,
      messages: 0,
      observationLimitations: 0,
      facts: 0,
      conflicts: 0,
      reconciliationLimitations: 0,
    },
  );
}

async function normalizePreparedManifest(value: PreparedVisualRunManifest): Promise<PreparedVisualRunManifest> {
  const root = object(value, "$preparedManifest", ["manifest", "canonicalBytes", "contentSha256", "epochs"]);
  const manifest = normalizeVisualRunManifest(root.manifest);
  if (!(root.canonicalBytes instanceof Uint8Array)) invalid("$preparedManifest.canonicalBytes", "must be Uint8Array");
  const canonicalBytes = enc.encode(canonicalJson(manifest));
  if (!equalBytes(root.canonicalBytes, canonicalBytes)) {
    invalid("$preparedManifest.canonicalBytes", "does not encode the normalized manifest exactly");
  }
  const contentSha256 = hash(root.contentSha256, "$preparedManifest.contentSha256");
  if ((await sha256Hex(canonicalBytes)) !== contentSha256) invalid("$preparedManifest.contentSha256", "digest mismatch");
  const epochs: StoredGroundedVisualEpoch[] = [];
  const epochValues = asArray(root.epochs, "$preparedManifest.epochs", MAX_MANIFEST_EPOCHS);
  for (let index = 0; index < epochValues.length; index += 1) {
    epochs.push(await normalizeStoredEpoch(epochValues[index], `$preparedManifest.epochs[${index}]`));
  }
  const rebuilt = await prepareVisualRunManifest({ runId: manifest.runId, finalizedAt: manifest.finalizedAt, epochs });
  if (canonicalJson(rebuilt.manifest) !== canonicalJson(manifest)) invalid("$preparedManifest.manifest", "entries/totals do not re-derive from epochs");
  if (rebuilt.contentSha256 !== contentSha256) invalid("$preparedManifest.contentSha256", "rebuilt digest mismatch");
  return { manifest, canonicalBytes, contentSha256, epochs };
}

function normalizeVisualRunManifest(value: unknown): VisualRunManifest {
  rejectDecisionFields(value, "$manifest");
  const root = object(value, "$manifest", ["schemaVersion", "kind", "runId", "finalizedAt", "entries", "totals"]);
  literal(root.schemaVersion, VISUAL_RUN_MANIFEST_SCHEMA_VERSION, "$manifest.schemaVersion");
  literal(root.kind, "survey-qa-visual-run-manifest", "$manifest.kind");
  const entries = array(root.entries, "$manifest.entries", MAX_MANIFEST_EPOCHS, normalizeManifestEntry);
  const sorted = [...entries].sort((a, b) => a.epochDigest.localeCompare(b.epochDigest));
  if (canonicalJson(entries) !== canonicalJson(sorted)) invalid("$manifest.entries", "entries are not canonically sorted");
  ensureUnique(entries.map((item) => item.epochDigest), "$manifest.entries", "epochDigest");
  ensureUnique(entries.map((item) => item.epochResultKey), "$manifest.entries", "epochResultKey");
  const totalsObject = object(root.totals, "$manifest.totals", [
    "epochs",
    "observedEpochs",
    "nonObservedEpochs",
    "questionRegions",
    "optionGroups",
    "options",
    "controls",
    "messages",
    "observationLimitations",
    "facts",
    "conflicts",
    "reconciliationLimitations",
  ]);
  const totals: VisualRunManifest["totals"] = {
    epochs: nonnegativeInteger(totalsObject.epochs, "$manifest.totals.epochs", MAX_MANIFEST_EPOCHS),
    observedEpochs: nonnegativeInteger(totalsObject.observedEpochs, "$manifest.totals.observedEpochs", MAX_MANIFEST_EPOCHS),
    nonObservedEpochs: nonnegativeInteger(totalsObject.nonObservedEpochs, "$manifest.totals.nonObservedEpochs", MAX_MANIFEST_EPOCHS),
    questionRegions: nonnegativeInteger(totalsObject.questionRegions, "$manifest.totals.questionRegions", 10_000_000),
    optionGroups: nonnegativeInteger(totalsObject.optionGroups, "$manifest.totals.optionGroups", 10_000_000),
    options: nonnegativeInteger(totalsObject.options, "$manifest.totals.options", 100_000_000),
    controls: nonnegativeInteger(totalsObject.controls, "$manifest.totals.controls", 10_000_000),
    messages: nonnegativeInteger(totalsObject.messages, "$manifest.totals.messages", 10_000_000),
    observationLimitations: nonnegativeInteger(
      totalsObject.observationLimitations,
      "$manifest.totals.observationLimitations",
      100_000_000,
    ),
    facts: nonnegativeInteger(totalsObject.facts, "$manifest.totals.facts", 100_000_000),
    conflicts: nonnegativeInteger(totalsObject.conflicts, "$manifest.totals.conflicts", 100_000_000),
    reconciliationLimitations: nonnegativeInteger(
      totalsObject.reconciliationLimitations,
      "$manifest.totals.reconciliationLimitations",
      100_000_000,
    ),
  };
  assertSameCounts(totals, manifestTotals(entries), "$manifest.totals");
  return {
    schemaVersion: VISUAL_RUN_MANIFEST_SCHEMA_VERSION,
    kind: "survey-qa-visual-run-manifest",
    runId: boundedString(root.runId, "$manifest.runId", 200),
    finalizedAt: isoTimestamp(root.finalizedAt, "$manifest.finalizedAt"),
    entries,
    totals,
  };
}

function normalizeManifestEntry(value: unknown, path: string): VisualRunManifestEntry {
  const root = object(value, path, [
    "epochDigest",
    "inferenceDigest",
    "epochResultKey",
    "epochResultSha256",
    "observationCacheKey",
    "inferenceCacheKey",
    "epochId",
    "readState",
    "counts",
  ]);
  const epochDigest = hash(root.epochDigest, `${path}.epochDigest`);
  const inferenceDigest = hash(root.inferenceDigest, `${path}.inferenceDigest`);
  const observationCacheKey = cacheKey(root.observationCacheKey, OBSERVATION_CACHE_KEY, `${path}.observationCacheKey`);
  const inferenceCacheKey = cacheKey(root.inferenceCacheKey, INFERENCE_CACHE_KEY, `${path}.inferenceCacheKey`);
  if (digestFromCacheKey(observationCacheKey, OBSERVATION_CACHE_KEY, `${path}.observationCacheKey`) !== epochDigest) {
    invalid(`${path}.epochDigest`, "does not bind observation cache identity");
  }
  if (digestFromCacheKey(inferenceCacheKey, INFERENCE_CACHE_KEY, `${path}.inferenceCacheKey`) !== inferenceDigest) {
    invalid(`${path}.inferenceDigest`, "does not bind inference cache identity");
  }
  validateStorageKey({ key: root.epochResultKey, digest: epochDigest }, epochDigest, `${path}.epochResultKey`);
  const countsObject = object(root.counts, `${path}.counts`, [
    "questionRegions",
    "optionGroups",
    "options",
    "controls",
    "messages",
    "observationLimitations",
    "facts",
    "conflicts",
    "reconciliationLimitations",
  ]);
  return {
    epochDigest,
    inferenceDigest,
    epochResultKey: boundedString(root.epochResultKey, `${path}.epochResultKey`, MAX_KEY_CHARS),
    epochResultSha256: hash(root.epochResultSha256, `${path}.epochResultSha256`),
    observationCacheKey,
    inferenceCacheKey,
    epochId: boundedString(root.epochId, `${path}.epochId`, 200),
    readState: oneOf(
      root.readState,
      ["observed", "input-invalid", "timeout", "unavailable", "malformed"] as const,
      `${path}.readState`,
    ),
    counts: {
      questionRegions: nonnegativeInteger(countsObject.questionRegions, `${path}.counts.questionRegions`, 100_000),
      optionGroups: nonnegativeInteger(countsObject.optionGroups, `${path}.counts.optionGroups`, 100_000),
      options: nonnegativeInteger(countsObject.options, `${path}.counts.options`, 1_000_000),
      controls: nonnegativeInteger(countsObject.controls, `${path}.counts.controls`, 100_000),
      messages: nonnegativeInteger(countsObject.messages, `${path}.counts.messages`, 100_000),
      observationLimitations: nonnegativeInteger(
        countsObject.observationLimitations,
        `${path}.counts.observationLimitations`,
        1_000_000,
      ),
      facts: nonnegativeInteger(countsObject.facts, `${path}.counts.facts`, 1_000_000),
      conflicts: nonnegativeInteger(countsObject.conflicts, `${path}.counts.conflicts`, 1_000_000),
      reconciliationLimitations: nonnegativeInteger(
        countsObject.reconciliationLimitations,
        `${path}.counts.reconciliationLimitations`,
        1_000_000,
      ),
    },
  };
}

// -------------------------------------------------------------------------------------
// R2 append-only primitives and scalar parsers
// -------------------------------------------------------------------------------------

function validateInferenceKeys(value: unknown): VisualInferenceStorageKeys {
  const root = object(value, "$keys", ["digest", "claimKey", "outcomeKey"]);
  const digest = hash(root.digest, "$keys.digest");
  const claim = validateStorageKey({ key: root.claimKey, digest }, digest, "$keys.claimKey");
  const outcome = validateStorageKey({ key: root.outcomeKey, digest }, digest, "$keys.outcomeKey");
  if (claim.key === outcome.key) invalid("$keys", "claim and outcome keys must differ");
  return { digest, claimKey: claim.key, outcomeKey: outcome.key };
}

function validateStorageKey(value: unknown, expectedDigest: string, path: string): VisualStorageKeyRef {
  const root = object(value, path, ["key", "digest"]);
  const digest = hash(root.digest, `${path}.digest`);
  if (digest !== expectedDigest) invalid(`${path}.digest`, "does not match the bound content/cache digest");
  const key = boundedString(root.key, `${path}.key`, MAX_KEY_CHARS);
  if (key.startsWith("/") || key.endsWith("/") || key.includes("\\") || /[\u0000-\u001f\u007f]/u.test(key)) {
    invalid(`${path}.key`, "must be a canonical relative R2 path without slash edges, backslashes, or controls");
  }
  if (key.normalize("NFC") !== key) invalid(`${path}.key`, "must be NFC-normalized");
  const segments = key.split("/");
  if (segments.length === 0 || segments.length > MAX_SEGMENTS) invalid(`${path}.key`, "has an invalid segment count");
  for (const segment of segments) {
    if (segment.length === 0 || segment.length > MAX_SEGMENT_CHARS || segment === "." || segment === "..") {
      invalid(`${path}.key`, "contains an empty, dot, or oversized segment");
    }
  }
  if (segments.filter((segment) => segment === digest).length !== 1) {
    invalid(`${path}.key`, "must contain its declared digest as exactly one complete path segment");
  }
  return { key, digest };
}

async function putCanonicalImmutable(
  bucket: R2Bucket,
  key: string,
  value: unknown,
): Promise<"stored" | "reused"> {
  return putBytesImmutable(bucket, key, enc.encode(canonicalJson(value)));
}

async function putBytesImmutable(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
): Promise<"stored" | "reused"> {
  if (bytes.byteLength > MAX_JSON_BYTES) invalid("$", "normalized visual object exceeds the storage byte cap");
  const written = await bucket.put(key, bytes, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written !== null) return "stored";
  const existing = await readObjectBytes(bucket, key);
  if (existing !== null && equalBytes(existing, bytes)) return "reused";
  throw new VisualStorageImmutabilityError(key);
}

async function readObjectBytes(bucket: R2Bucket, key: string): Promise<Uint8Array | null> {
  const objectBody = await bucket.get(key);
  if (objectBody === null) return null;
  if (!Number.isFinite(objectBody.size) || objectBody.size < 0 || objectBody.size > MAX_JSON_BYTES) {
    throw new VisualStorageCorruptionError(key, "object size is outside the bounded JSON envelope");
  }
  const bytes = new Uint8Array(await objectBody.arrayBuffer());
  if (bytes.byteLength !== objectBody.size) {
    throw new VisualStorageCorruptionError(key, "declared and read byte sizes differ");
  }
  return bytes;
}

async function parseCanonicalObject<T>(
  bytes: Uint8Array,
  key: string,
  normalize: (value: unknown) => T | Promise<T>,
): Promise<T> {
  let decoded: string;
  let parsed: unknown;
  try {
    decoded = fatalUtf8.decode(bytes);
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new VisualStorageCorruptionError(key, "bytes are not strict UTF-8 JSON");
  }
  let normalized: T;
  try {
    normalized = await normalize(parsed);
  } catch (error) {
    throw new VisualStorageCorruptionError(key, boundedError(error));
  }
  if (canonicalJson(normalized) !== decoded) {
    throw new VisualStorageCorruptionError(key, "bytes are not the canonical closed encoding");
  }
  return normalized;
}

function corruptState(reason: string): VisualInferenceState {
  return { state: "corrupt", issueNew: false, claim: null, outcome: null, reason: bounded(reason, 700) };
}

function rejectDecisionFields(value: unknown, path: string): void {
  const found = forbiddenDecisionFields(value);
  const local = findKeys(value, new Set(["expected", "requirement", "verified", "contradicted", "answer"]));
  const combined = [...found, ...local];
  if (combined.length > 0) invalid(path, `decision-bearing field rejected at ${combined[0]}`);
}

function findKeys(value: unknown, forbidden: Set<string>, path = "$"): string[] {
  const found: string[] = [];
  const visit = (current: unknown, currentPath: string): void => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${currentPath}/${index}`));
    } else if (isRecord(current)) {
      for (const [key, child] of Object.entries(current)) {
        const childPath = `${currentPath}/${key}`;
        if (forbidden.has(key.toLowerCase())) found.push(childPath);
        visit(child, childPath);
      }
    }
  };
  visit(value, path);
  return found;
}

function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  const root = objectAtLeast(value, path);
  exactKeys(root, path, keys);
  return root;
}

function objectAtLeast(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(path, "must be a plain JSON object");
  return value;
}

function exactKeys(root: Record<string, unknown>, path: string, keys: readonly string[]): void {
  const expected = new Set(keys);
  for (const key of Object.keys(root)) if (!expected.has(key)) invalid(path, `unknown field ${JSON.stringify(key)}`);
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(root, key)) invalid(path, `missing field ${JSON.stringify(key)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function array<T>(
  value: unknown,
  path: string,
  max: number,
  parse: (item: unknown, path: string) => T,
): T[] {
  const source = asArray(value, path, max);
  return source.map((item, index) => parse(item, `${path}[${index}]`));
}

function nonemptyArray<T>(
  value: unknown,
  path: string,
  max: number,
  parse: (item: unknown, path: string) => T,
): T[] {
  const parsed = array(value, path, max, parse);
  if (parsed.length === 0) invalid(path, "must not be empty");
  return parsed;
}

function asArray(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(path, `must be an array with at most ${max} entries`);
  return value;
}

function boundedString(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !wellFormed(value)) {
    invalid(path, `must be a non-empty well-formed string of at most ${max} characters`);
  }
  return value;
}

function boundedStringAllowEmpty(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.length > max || !wellFormed(value)) {
    invalid(path, `must be a well-formed string of at most ${max} characters`);
  }
  return value;
}

function nullableBoundedString(value: unknown, path: string, max: number): string | null {
  return value === null ? null : boundedString(value, path, max);
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function hash(value: unknown, path: string): string {
  if (typeof value !== "string" || !HASH.test(value)) invalid(path, "must be a lowercase SHA-256 hex digest");
  return value;
}

function nullableHash(value: unknown, path: string): string | null {
  return value === null ? null : hash(value, path);
}

function cacheKey(value: unknown, pattern: RegExp, path: string): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid(path, "has an invalid cache identity shape");
  return value;
}

function nullableCacheKey(value: unknown, pattern: RegExp, path: string): string | null {
  return value === null ? null : cacheKey(value, pattern, path);
}

function digestFromCacheKey(value: string, pattern: RegExp, path: string): string {
  const match = pattern.exec(value);
  if (!match?.[1]) invalid(path, "does not contain a SHA-256 cache digest");
  return match[1];
}

function versionHash(value: unknown, path: string): { version: string; sha256: string } {
  const root = object(value, path, ["version", "sha256"]);
  return {
    version: boundedString(root.version, `${path}.version`, 300),
    sha256: hash(root.sha256, `${path}.sha256`),
  };
}

function isoTimestamp(value: unknown, path: string): string {
  const text = boundedString(value, path, 40);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) invalid(path, "must be a canonical ISO-8601 instant");
  return text;
}

function normalizeBounds(value: unknown, path: string): NormalizedBounds {
  const root = object(value, path, ["x", "y", "width", "height"]);
  const bounds = {
    x: finiteRange(root.x, `${path}.x`, 0, 1),
    y: finiteRange(root.y, `${path}.y`, 0, 1),
    width: positiveFinite(root.width, `${path}.width`, 1),
    height: positiveFinite(root.height, `${path}.height`, 1),
  };
  if (bounds.x + bounds.width > 1 + Number.EPSILON || bounds.y + bounds.height > 1 + Number.EPSILON) {
    invalid(path, "bounds extend beyond the normalized screenshot");
  }
  return bounds;
}

function positiveInteger(value: unknown, path: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > max) {
    invalid(path, `must be an integer in [1, ${max}]`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, path: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    invalid(path, `must be an integer in [0, ${max}]`);
  }
  return value;
}

/**
 * Step ordinals are whole steps (k) or the walker's recovery interleave (k + 0.5): the driver
 * records the recovery it runs after a blocked step as `stepIndex + 0.5` by design. Accept
 * exactly the writer's domain — halves and nothing finer.
 */
function stepOrdinal(value: unknown, path: string, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max ||
    !Number.isSafeInteger(value * 2)
  ) {
    invalid(path, `must be a whole or half step ordinal in [0, ${max}]`);
  }
  return value;
}

function nullableNonnegativeInteger(value: unknown, path: string, max: number): number | null {
  return value === null ? null : nonnegativeInteger(value, path, max);
}

function finiteRange(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    invalid(path, `must be finite and in [${min}, ${max}]`);
  }
  return value;
}

function positiveFinite(value: unknown, path: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) {
    invalid(path, `must be finite and in (0, ${max}]`);
  }
  return value;
}

function nullablePositiveFinite(value: unknown, path: string, max: number): number | null {
  return value === null ? null : positiveFinite(value, path, max);
}

function nonnegativeFinite(value: unknown, path: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    invalid(path, `must be finite and in [0, ${max}]`);
  }
  return value;
}

function nullableNonnegativeFinite(value: unknown, path: string, max: number): number | null {
  return value === null ? null : nonnegativeFinite(value, path, max);
}

function nullableFinite(value: unknown, path: string, absoluteMax: number): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > absoluteMax) {
    invalid(path, `must be null or finite with absolute value <= ${absoluteMax}`);
  }
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) invalid(path, `must be one of ${allowed.join(", ")}`);
  return value as T[number];
}

function literal<T extends string>(value: unknown, expected: T, path: string): asserts value is T {
  if (value !== expected) invalid(path, `must equal ${JSON.stringify(expected)}`);
}

function ensureUnique(values: string[], path: string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) invalid(path, `duplicate ${label} ${JSON.stringify(value)}`);
    seen.add(value);
  }
}

function inventoryQuotes(inventory: VisualInventory): Array<{ value: string; grounding: QuoteGrounding }> {
  const readings: GroundedTextReading[] = [
    ...inventory.questionRegions.map((item) => item.text),
    ...inventory.optionGroups.flatMap((group) => group.options.map((option) => option.text)),
    ...inventory.controls.flatMap((control) => (control.text === null ? [] : [control.text])),
    ...inventory.messages.map((message) => message.text),
  ];
  return readings.flatMap((reading) => [
    ...(reading.quote === null ? [] : [reading.quote]),
    ...reading.alternatives,
  ]);
}

function assertSameCounts(
  actual: Record<string, number>,
  expected: Record<string, number>,
  path: string,
): void {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (actual[key] !== expectedValue) invalid(`${path}.${key}`, `declares ${actual[key]} but recomputes to ${expectedValue}`);
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let different = 0;
  for (let index = 0; index < a.byteLength; index += 1) different |= a[index]! ^ b[index]!;
  return different === 0;
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown visual storage error";
}

function boundedError(error: unknown): string {
  return bounded(errorMessage(error), 700);
}

function invalid(path: string, detail: string): never {
  throw new VisualStorageValidationError(path, detail);
}

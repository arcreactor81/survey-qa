/**
 * ONE SERIAL, TARGET-NEUTRAL VISUAL SHADOW EPOCH.
 *
 * This stage consumes one row from the immutable visual-work denominator. It never receives a
 * document requirement and never emits a verdict. The only semantic readers are the visual
 * inventory and the independently captured, closed AX tree; screen/DOM JSON contributes pairing
 * provenance only.
 *
 * Paid work is retry-safe: exact capture bytes are reloaded first, an absent inference is
 * admitted against both global and visual-only caps, and DurableVisionClient writes a claim
 * before crossing the provider boundary. Every settled attempt is committed to the strict usage
 * ledger before an observation can advance. There are no retries or provider fallbacks here.
 */

import {
  visualEpochObservationKey,
  visualEpochReconciliationKey,
  visualGroundedEpochKey,
  visualInferenceClaimKey,
  visualInferenceDigest,
  visualInferenceOutcomeKey,
  visualObservationDigest,
} from "../../keys";
import type { Fence } from "../../store/checkpoint";
import { canonicalJson, sha256Hex } from "../../store/hash";
import {
  createGroundedVisualEpochResult,
  createR2VisualObservationSink,
  persistGroundedVisualEpoch,
  persistOptionMembershipReconciliation,
  readGroundedVisualEpoch,
  readOptionMembershipReconciliation,
  readVisualInferenceState,
  readVisualObservationArtifact,
  type StoredGroundedVisualEpoch,
  type StoredOptionMembershipReconciliation,
  type VisualInferenceState,
  type VisualInferenceStorageKeys,
  type VisualStorageKeyRef,
} from "../../store/vision";
import {
  commitVisualInferenceAccountingStrict,
  preflightVisualInferenceStrict,
  releaseUnattemptedVisualInferenceReservationStrict,
} from "../../store/usage";
import type { VisualWorkEpochRow } from "../../store/visual-work";
import type { Env } from "../../types/env";
import {
  DurableVisionClient,
  VisualInferencePurchaseBlockedError,
  visualInferenceAccountingEvent,
  visualInferenceNotAttemptedEvent,
  visualInferenceReceiptWasNotAttempted,
} from "../../vision/durable-client";
import {
  loadVisualEpochInput,
  type LoadedVisualEpochInput,
  type VisualEpochInputLimitation,
} from "../../vision/epoch-input";
import {
  computeVisualInferenceCacheKey,
  computeVisualObservationCacheKey,
  observeVisualPage,
  VisualObservationPersistenceError,
  visualPromptSha256,
  visualResponseSchemaSha256,
} from "../../vision/observe";
import {
  configuredVisionCostUsd,
  maximumVisionCallCostUsd,
} from "../../vision/providers/cost";
import { reconcileOptionMembership } from "../../vision/reconcile";
import type {
  VisionClient,
  VisionModelSpec,
  VisualCaptureIdentity,
  VisualObservationArtifact,
  VisualObservationLimitationKind,
  VisualObservationSink,
  VisualObservationSinkInput,
  VisualReadState,
} from "../../vision/types";

const MAX_VISUAL_CALLS = 10_000;
const MAX_VISUAL_USD = 1_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;

export interface VisualEpochRolloutLimits {
  /** Independent per-run visual purchase count; never inferred from the global model cap. */
  maximumCalls: number;
  /** Independent per-run visual spend ceiling in USD. */
  maximumUsd: number;
  /** The one observer/provider deadline. This stage adds no retry deadline. */
  timeoutMs: number;
}

export interface ProcessVisualEpochInput {
  env: Env;
  runId: string;
  fence: Fence;
  /** One row from a previously stored and re-read VisualWorkManifest. */
  row: VisualWorkEpochRow;
  rollout: VisualEpochRolloutLimits;
  /** Exactly the explicitly selected adapter. No selector or fallback exists in this stage. */
  client: VisionClient;
  model: VisionModelSpec;
  /** Clock injection exists for deterministic Workflow replay tests and immutable timestamps. */
  now?: () => Date;
}

export interface VisualEpochWorkIdentity {
  walkOrdinal: number;
  epochOrdinal: number;
  pathId: string;
  attemptId: string;
  epochId: string;
  stepIndex: number;
  slot: string;
  cacheInputIdentity: string;
}

export interface VisualEpochInputIneligibleResult {
  state: "input-ineligible";
  work: VisualEpochWorkIdentity;
  limitation: VisualEpochInputLimitation;
}

export interface VisualEpochStoredResult {
  state: "stored";
  work: VisualEpochWorkIdentity;
  capture: VisualCaptureIdentity;
  model: VisionModelSpec;
  readState: VisualReadState;
  inference: {
    cacheKey: string;
    digest: string;
    claimKey: string;
    outcomeKey: string;
    durableState: "settled";
  };
  observation: {
    cacheKey: string;
    storage: VisualStorageKeyRef;
    contentSha256: string;
    limitations: number;
    /** Exact named observation limitations retained for fail-closed coverage projection. */
    limitationKinds: VisualObservationLimitationKind[];
  };
  reconciliation: {
    storage: VisualStorageKeyRef;
    contentSha256: string;
    facts: number;
    conflicts: number;
    limitations: number;
  };
  groundedEpoch: {
    storage: VisualStorageKeyRef;
    contentSha256: string;
  };
}

export type ProcessVisualEpochResult =
  | VisualEpochInputIneligibleResult
  | VisualEpochStoredResult;

export type VisualEpochProcessingErrorCode =
  | "rollout-limits-invalid"
  | "loaded-work-identity-invalid"
  | "observation-not-stored"
  | "observation-missing-after-write"
  | "observation-identity-mismatch"
  | "observation-inference-state-mismatch"
  | "inference-state-not-settled"
  | "reconciliation-missing-after-write"
  | "reconciliation-identity-mismatch"
  | "grounded-epoch-missing-after-write"
  | "grounded-epoch-identity-mismatch";

/** Stable, secret-free stage errors. Imported storage/admission/accounting errors propagate as-is. */
export class VisualEpochProcessingError extends Error {
  constructor(readonly code: VisualEpochProcessingErrorCode) {
    super(`visual epoch processing stopped: ${code}`);
    this.name = "VisualEpochProcessingError";
  }
}

class DeferredVisualObservationSink implements VisualObservationSink {
  private captured: VisualObservationSinkInput | null = null;

  async persist(input: VisualObservationSinkInput): Promise<void> {
    if (this.captured !== null) {
      throw new VisualEpochProcessingError("observation-identity-mismatch");
    }
    this.captured = input;
  }

  take(): VisualObservationSinkInput {
    if (this.captured === null) {
      throw new VisualEpochProcessingError("observation-not-stored");
    }
    return this.captured;
  }
}

/**
 * Process one manifest-authorized capture epoch. Loader ineligibility is the sole ordinary
 * non-purchase result. Every other failure is fatal to the caller's serial shadow wave.
 */
export async function processVisualEpoch(
  input: ProcessVisualEpochInput,
): Promise<ProcessVisualEpochResult> {
  // This is deliberately first. A denominator row that cannot bind its exact bytes must not
  // touch rollout policy, checkpoint admission/accounting, durable inference state, or a model.
  const loaded = await loadVisualEpochInput(input.env, input.runId, input.row);
  const work = workIdentity(input.row);
  if (loaded.state === "ineligible") {
    return { state: "input-ineligible", work, limitation: loaded.limitation };
  }
  assertLoadedWorkIdentity(work);

  const rollout = normalizeRollout(input.rollout);
  const identities = await deriveEpochIdentities(loaded, input.model);
  const inferenceKeys = inferenceStorageKeys(input.runId, identities.inferenceCacheKey);
  const observationStorage = observationStorageRef(input.runId, identities.observationCacheKey);
  const reconciliationStorage = reconciliationStorageRef(
    input.runId,
    identities.observationCacheKey,
  );
  const groundedStorage = groundedStorageRef(input.runId, identities.observationCacheKey);

  const durableClient = new DurableVisionClient({
    bucket: input.env.EVIDENCE,
    client: input.client,
    model: input.model,
    storageKeys: (cacheKey) => inferenceStorageKeys(input.runId, cacheKey),
    admitNewPurchase: async (request, model) => {
      const ceiling = maximumVisionCallCostUsd(request, model);
      await preflightVisualInferenceStrict(input.env, input.runId, input.fence, {
        callId: request.callId,
        inferenceCacheKey: request.inferenceCacheKey,
        provider: model.provider,
        model: model.model,
        maximumCostUsd: ceiling.maximumCostUsd,
        maximumVisualCalls: rollout.maximumCalls,
        maximumVisualUsd: rollout.maximumUsd,
      });
    },
    accountSettledAttempt: async (event) => {
      await commitVisualInferenceAccountingStrict(input.env, input.runId, input.fence, event);
    },
    accountNotAttempted: async (event) => {
      await releaseUnattemptedVisualInferenceReservationStrict(
        input.env,
        input.runId,
        input.fence,
        event,
      );
    },
    estimateCostUsd: (telemetry, model) => configuredVisionCostUsd(telemetry, model),
    now: input.now,
  });

  // A stored observation is already downstream of a settled + accounted durable attempt. Re-read
  // it instead of rebuilding timestamped bytes on Workflow replay. A NEW observer result is held
  // in memory first: observeVisualPage's outer deadline can win while DurableVisionClient is
  // still settling. Writing that provisional timeout would permanently conflict with the later
  // observed replay under the same immutable key.
  let observation = await readVisualObservationArtifact(input.env.EVIDENCE, observationStorage);
  let deferredSinkInput: VisualObservationSinkInput | null = null;
  if (observation === null) {
    const deferredSink = new DeferredVisualObservationSink();
    const observed = await observeVisualPage(loaded.input, input.model, {
      client: durableClient,
      sink: deferredSink,
      now: input.now,
      timeoutMs: rollout.timeoutMs,
    });
    if (observed.persistence !== "stored" || observed.artifact.cacheKey === null) {
      throw new VisualEpochProcessingError("observation-not-stored");
    }
    deferredSinkInput = deferredSink.take();
    if (observed.artifact.cacheKey !== identities.observationCacheKey) {
      throw new VisualEpochProcessingError("observation-identity-mismatch");
    }
    if (
      deferredSinkInput.cacheKey !== identities.observationCacheKey ||
      deferredSinkInput.inferenceCacheKey !== identities.inferenceCacheKey ||
      canonicalJson(deferredSinkInput.artifact) !== canonicalJson(observed.artifact)
    ) {
      throw new VisualEpochProcessingError("observation-identity-mismatch");
    }
    observation = observed.artifact;
  }
  assertObservationIdentity(observation, loaded, input.model, identities);

  const inferenceState = await readVisualInferenceState(input.env.EVIDENCE, inferenceKeys);
  assertSettledInference(inferenceState, loaded, input.model, identities);
  assertObservationMatchesOutcome(observation, inferenceState.outcome.result.state);
  // Close the observer-deadline/accounting race explicitly. Rebuilding the deterministic event
  // from the re-read settled receipt is idempotent, starts no provider work, and refuses to
  // advance if strict accounting is unavailable.
  if (visualInferenceReceiptWasNotAttempted(inferenceState.outcome)) {
    await releaseUnattemptedVisualInferenceReservationStrict(
      input.env,
      input.runId,
      input.fence,
      visualInferenceNotAttemptedEvent(input.model, inferenceState.outcome),
    );
  } else {
    await commitVisualInferenceAccountingStrict(
      input.env,
      input.runId,
      input.fence,
      visualInferenceAccountingEvent(input.model, inferenceState.outcome),
    );
  }

  if (deferredSinkInput !== null) {
    const durableSink = createR2VisualObservationSink(
      input.env.EVIDENCE,
      (epochDigest) => observationStorageRefFromDigest(input.runId, epochDigest),
    );
    try {
      await durableSink.persist(deferredSinkInput);
    } catch {
      throw new VisualObservationPersistenceError();
    }
    const rereadObservation = await readVisualObservationArtifact(
      input.env.EVIDENCE,
      observationStorage,
    );
    if (rereadObservation === null) {
      throw new VisualEpochProcessingError("observation-missing-after-write");
    }
    if (canonicalJson(rereadObservation) !== canonicalJson(observation)) {
      throw new VisualEpochProcessingError("observation-identity-mismatch");
    }
    observation = rereadObservation;
  }
  const observationContentSha256 = await sha256Hex(canonicalJson(observation));

  const reconciliation = reconcileOptionMembership({
    observation,
    // Screen carries evidence identity only. No DOM/screen text crosses this boundary.
    screen: loaded.screen,
    accessibility: loaded.accessibility,
  });
  const persistedReconciliation = await persistOptionMembershipReconciliation(
    input.env.EVIDENCE,
    reconciliationStorage,
    observation,
    reconciliation,
  );
  const rereadReconciliation = await readOptionMembershipReconciliation(
    input.env.EVIDENCE,
    reconciliationStorage,
    observation,
  );
  if (rereadReconciliation === null) {
    throw new VisualEpochProcessingError("reconciliation-missing-after-write");
  }
  assertReconciliationIdentity(persistedReconciliation, rereadReconciliation, reconciliation);

  // finalizedAt is intentionally stored only on first creation. A Workflow replay reuses the
  // immutable combined result instead of trying to overwrite it with a new clock value.
  let grounded = await readGroundedVisualEpoch(input.env.EVIDENCE, groundedStorage);
  if (grounded === null) {
    const value = await createGroundedVisualEpochResult({
      // The durable settlement timestamp is stable across Workflow replay. A fresh wall-clock
      // value here would make two otherwise identical first writers race with different bytes.
      finalizedAt: inferenceState.outcome.settledAt,
      observation,
      reconciliation: rereadReconciliation.reconciliation,
    });
    await persistGroundedVisualEpoch(input.env.EVIDENCE, groundedStorage, value);
    grounded = await readGroundedVisualEpoch(input.env.EVIDENCE, groundedStorage);
    if (grounded === null) {
      throw new VisualEpochProcessingError("grounded-epoch-missing-after-write");
    }
  }
  assertGroundedIdentity(
    grounded,
    observation,
    observationContentSha256,
    rereadReconciliation,
    identities,
  );

  return {
    state: "stored",
    work,
    capture: observation.input.capture,
    model: { ...input.model },
    readState: observation.readState,
    inference: {
      cacheKey: identities.inferenceCacheKey,
      digest: inferenceKeys.digest,
      claimKey: inferenceKeys.claimKey,
      outcomeKey: inferenceKeys.outcomeKey,
      durableState: "settled",
    },
    observation: {
      cacheKey: identities.observationCacheKey,
      storage: observationStorage,
      contentSha256: observationContentSha256,
      limitations: observation.counts.limitations,
      limitationKinds: [...new Set(observation.limitations.map((limitation) => limitation.kind))],
    },
    reconciliation: {
      storage: rereadReconciliation.storage,
      contentSha256: rereadReconciliation.contentSha256,
      facts: rereadReconciliation.reconciliation.counts.facts,
      conflicts: rereadReconciliation.reconciliation.counts.conflicts,
      limitations: rereadReconciliation.reconciliation.counts.limitations,
    },
    groundedEpoch: {
      storage: grounded.storage,
      contentSha256: grounded.contentSha256,
    },
  };
}

interface EpochIdentities {
  promptSha256: string;
  responseSchemaSha256: string;
  inferenceCacheKey: string;
  observationCacheKey: string;
}

async function deriveEpochIdentities(
  loaded: LoadedVisualEpochInput,
  model: VisionModelSpec,
): Promise<EpochIdentities> {
  const [promptSha256, responseSchemaSha256] = await Promise.all([
    visualPromptSha256(),
    visualResponseSchemaSha256(),
  ]);
  const inferenceCacheKey = await computeVisualInferenceCacheKey({
    screenshotSha256: loaded.input.screenshot.contentSha256,
    pixelWidth: loaded.input.geometry.screenshotPixelWidth,
    pixelHeight: loaded.input.geometry.screenshotPixelHeight,
    provider: model.provider,
    model: model.model,
    configurationSha256: model.configurationSha256,
    promptSha256,
    responseSchemaSha256,
  });
  const observationCacheKey = await computeVisualObservationCacheKey({
    screenshotSha256: loaded.input.screenshot.contentSha256,
    pairedEvidenceSha256: loaded.input.pairedEvidenceSha256,
    provider: model.provider,
    model: model.model,
    configurationSha256: model.configurationSha256,
    promptSha256,
    responseSchemaSha256,
  });
  return { promptSha256, responseSchemaSha256, inferenceCacheKey, observationCacheKey };
}

function inferenceStorageKeys(runId: string, cacheKey: string): VisualInferenceStorageKeys {
  return {
    digest: visualInferenceDigest(cacheKey),
    claimKey: visualInferenceClaimKey(runId, cacheKey),
    outcomeKey: visualInferenceOutcomeKey(runId, cacheKey),
  };
}

function observationStorageRef(runId: string, cacheKey: string): VisualStorageKeyRef {
  return {
    key: visualEpochObservationKey(runId, cacheKey),
    digest: visualObservationDigest(cacheKey),
  };
}

function observationStorageRefFromDigest(runId: string, digest: string): VisualStorageKeyRef {
  return observationStorageRef(runId, `visual-observation/sha256/${digest}`);
}

function reconciliationStorageRef(runId: string, cacheKey: string): VisualStorageKeyRef {
  return {
    key: visualEpochReconciliationKey(runId, cacheKey),
    digest: visualObservationDigest(cacheKey),
  };
}

function groundedStorageRef(runId: string, cacheKey: string): VisualStorageKeyRef {
  return {
    key: visualGroundedEpochKey(runId, cacheKey),
    digest: visualObservationDigest(cacheKey),
  };
}

function assertObservationIdentity(
  observation: VisualObservationArtifact,
  loaded: LoadedVisualEpochInput,
  model: VisionModelSpec,
  identities: EpochIdentities,
): void {
  const expectedScreen = pairedBinding(loaded.input.screen);
  const expectedAccessibility = pairedBinding(loaded.input.accessibility);
  if (
    observation.cacheKey !== identities.observationCacheKey ||
    observation.inferenceCacheKey !== identities.inferenceCacheKey ||
    observation.input.screenshotEvidenceId !== loaded.input.screenshot.evidenceId ||
    observation.input.screenshotSha256 !== loaded.input.screenshot.contentSha256 ||
    observation.input.pairedEvidenceSha256 !== loaded.input.pairedEvidenceSha256 ||
    canonicalJson(observation.input.screen) !== canonicalJson(expectedScreen) ||
    canonicalJson(observation.input.accessibility) !== canonicalJson(expectedAccessibility) ||
    canonicalJson(observation.input.capture) !== canonicalJson(loaded.input.capture) ||
    canonicalJson(observation.input.geometry) !== canonicalJson(loaded.input.geometry) ||
    observation.provenance.model.provider !== model.provider ||
    observation.provenance.model.requestedModel !== model.model ||
    observation.provenance.model.transport !== model.transport ||
    observation.provenance.model.configurationSha256 !== model.configurationSha256 ||
    observation.provenance.prompt.sha256 !== identities.promptSha256 ||
    observation.provenance.responseSchema.sha256 !== identities.responseSchemaSha256
  ) {
    throw new VisualEpochProcessingError("observation-identity-mismatch");
  }
}

function assertSettledInference(
  state: VisualInferenceState,
  loaded: LoadedVisualEpochInput,
  model: VisionModelSpec,
  identities: EpochIdentities,
): asserts state is Extract<VisualInferenceState, { state: "settled" }> {
  if (state.state === "indeterminate") {
    throw new VisualInferencePurchaseBlockedError("claim-indeterminate");
  }
  if (state.state === "corrupt") {
    throw new VisualInferencePurchaseBlockedError("storage-corrupt");
  }
  if (state.state !== "settled") {
    throw new VisualEpochProcessingError("inference-state-not-settled");
  }
  const request = state.claim.request;
  if (
    state.claim.inferenceCacheKey !== identities.inferenceCacheKey ||
    state.outcome.inferenceCacheKey !== identities.inferenceCacheKey ||
    request.screenshotSha256 !== loaded.input.screenshot.contentSha256 ||
    request.pixelWidth !== loaded.input.geometry.screenshotPixelWidth ||
    request.pixelHeight !== loaded.input.geometry.screenshotPixelHeight ||
    request.provider !== model.provider ||
    request.model !== model.model ||
    request.transport !== model.transport ||
    request.configurationSha256 !== model.configurationSha256 ||
    request.prompt.sha256 !== identities.promptSha256 ||
    request.responseSchema.sha256 !== identities.responseSchemaSha256
  ) {
    throw new VisualEpochProcessingError("inference-state-not-settled");
  }
}

function assertObservationMatchesOutcome(
  observation: VisualObservationArtifact,
  outcomeState: "observed" | "timeout" | "unavailable" | "malformed",
): void {
  if (observation.readState !== outcomeState) {
    throw new VisualEpochProcessingError("observation-inference-state-mismatch");
  }
}

function assertReconciliationIdentity(
  persisted: StoredOptionMembershipReconciliation,
  reread: StoredOptionMembershipReconciliation,
  expected: ReturnType<typeof reconcileOptionMembership>,
): void {
  if (
    persisted.storage.key !== reread.storage.key ||
    persisted.storage.digest !== reread.storage.digest ||
    persisted.contentSha256 !== reread.contentSha256 ||
    canonicalJson(reread.reconciliation) !== canonicalJson(expected)
  ) {
    throw new VisualEpochProcessingError("reconciliation-identity-mismatch");
  }
}

function assertGroundedIdentity(
  grounded: StoredGroundedVisualEpoch,
  observation: VisualObservationArtifact,
  observationContentSha256: string,
  reconciliation: StoredOptionMembershipReconciliation,
  identities: EpochIdentities,
): void {
  const expectedEpochDigest = visualObservationDigest(identities.observationCacheKey);
  const expectedInferenceDigest = visualInferenceDigest(identities.inferenceCacheKey);
  if (
    grounded.storage.digest !== expectedEpochDigest ||
    grounded.result.epochDigest !== expectedEpochDigest ||
    grounded.result.inferenceDigest !== expectedInferenceDigest ||
    grounded.result.observationContentSha256 !== observationContentSha256 ||
    grounded.result.reconciliationContentSha256 !== reconciliation.contentSha256 ||
    canonicalJson(grounded.result.observation) !== canonicalJson(observation) ||
    canonicalJson(grounded.result.reconciliation) !== canonicalJson(reconciliation.reconciliation)
  ) {
    throw new VisualEpochProcessingError("grounded-epoch-identity-mismatch");
  }
}

function pairedBinding(
  value: LoadedVisualEpochInput["input"]["screen"],
): VisualObservationArtifact["input"]["screen"] {
  return value.state === "captured"
    ? { state: "captured", evidenceId: value.evidenceId, contentSha256: value.contentSha256 }
    : { state: "unavailable", failure: { ...value.failure } };
}

function workIdentity(row: VisualWorkEpochRow): VisualEpochWorkIdentity {
  const missing = "<unavailable>";
  return {
    walkOrdinal: Number.isSafeInteger(row.walkOrdinal) && row.walkOrdinal >= 0 ? row.walkOrdinal : -1,
    epochOrdinal: Number.isSafeInteger(row.epochOrdinal) && row.epochOrdinal >= 0 ? row.epochOrdinal : -1,
    pathId: typeof row.pathId === "string" && row.pathId.length > 0 ? row.pathId : missing,
    attemptId: typeof row.attemptId === "string" && row.attemptId.length > 0 ? row.attemptId : missing,
    epochId: typeof row.epochId === "string" && row.epochId.length > 0 ? row.epochId : missing,
    stepIndex: Number.isSafeInteger(row.stepIndex) && row.stepIndex >= 0 ? row.stepIndex : -1,
    slot: typeof row.slot === "string" && row.slot.length > 0 ? row.slot : missing,
    // The strict loader rejects null/malformed values before a provider boundary. The explicit
    // placeholder keeps an ineligible row countable without inventing a valid cache identity.
    cacheInputIdentity:
      typeof row.cacheInputIdentity === "string" && row.cacheInputIdentity.length > 0
        ? row.cacheInputIdentity
        : "<unavailable>",
  };
}

function assertLoadedWorkIdentity(work: VisualEpochWorkIdentity): void {
  if (
    work.walkOrdinal < 0 ||
    work.epochOrdinal < 0 ||
    work.stepIndex < 0 ||
    work.pathId === "<unavailable>" ||
    work.attemptId === "<unavailable>" ||
    work.epochId === "<unavailable>" ||
    work.slot === "<unavailable>" ||
    work.cacheInputIdentity === "<unavailable>"
  ) {
    throw new VisualEpochProcessingError("loaded-work-identity-invalid");
  }
}

function normalizeRollout(value: VisualEpochRolloutLimits): VisualEpochRolloutLimits {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).sort().join("\u0000") !== ["maximumCalls", "maximumUsd", "timeoutMs"].sort().join("\u0000") ||
    !Number.isSafeInteger(value.maximumCalls) || value.maximumCalls < 1 || value.maximumCalls > MAX_VISUAL_CALLS ||
    typeof value.maximumUsd !== "number" || !Number.isFinite(value.maximumUsd) ||
    value.maximumUsd <= 0 || value.maximumUsd > MAX_VISUAL_USD ||
    !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < MIN_TIMEOUT_MS || value.timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new VisualEpochProcessingError("rollout-limits-invalid");
  }
  return { ...value };
}

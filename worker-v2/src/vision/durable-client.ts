/**
 * RETRY-SAFE PAID VISUAL INFERENCE.
 *
 * Workflow step replay is not an inference cache. A provider may charge a request and the
 * isolate may die before the step result becomes durable. This wrapper therefore writes an
 * immutable claim before it crosses the provider boundary and an immutable outcome afterwards.
 * Only a completely absent claim+outcome pair authorizes a call. Claim-only, corrupt, and
 * conflicting state are named refusals; none is silently repurchased.
 *
 * The wrapper inventories pixels only. It does not receive a document expectation or author a
 * verdict. A deterministic, idempotent accounting callback is invoked for every settled attempt
 * before the outcome is released to the observer.
 */

import {
  VISUAL_INFERENCE_CLAIM_SCHEMA_VERSION,
  VISUAL_INFERENCE_OUTCOME_SCHEMA_VERSION,
  VisualStorageImmutabilityError,
  claimVisualInference,
  readVisualInferenceState,
  settleVisualInference,
  type VisualInferenceClaimReceipt,
  type VisualInferenceOutcomeReceipt,
  type VisualInferenceOutcomeResult,
  type VisualInferenceStorageKeys,
} from "../store/vision";
import { canonicalJson, sha256Hex } from "../store/hash";
import { computeVisualInferenceCacheKey } from "./observe";
import {
  allowedNotAttemptedPreflightReference,
  coherentNotAttemptedPreflightReference,
} from "./provider-failure";
import { forbiddenDecisionFields, validateModelVisualInventory } from "./schema";
import {
  VisionProviderUnavailableError,
  type VisionCallTelemetry,
  type VisionClient,
  type VisionClientOutcome,
  type VisionClientRequest,
  type VisionModelSpec,
} from "./types";

const INFERENCE_CACHE_KEY = /^visual-inference\/sha256\/([0-9a-f]{64})$/;

export interface VisualInferenceAccountingEvent {
  /** Deterministic and stable across Workflow replay. */
  eventId: string;
  callId: string;
  inferenceCacheKey: string;
  requestedProvider: string;
  requestedModel: string;
  reportedModel: string | null;
  resultState: VisualInferenceOutcomeResult["state"];
  inputTokens: number | null;
  outputTokens: number | null;
  /** `null` is explicitly unknown and must never be folded into zero. */
  costUsd: number | null;
  usageSource: VisionCallTelemetry["usageSource"];
  attempts: number;
  settledAt: string;
}

export interface VisualInferenceNotAttemptedEvent {
  /** Same deterministic identity as the reservation, but never a paid usage event. */
  eventId: string;
  callId: string;
  inferenceCacheKey: string;
  requestedProvider: string;
  requestedModel: string;
  settledAt: string;
}

export interface DurableVisionClientDependencies {
  bucket: R2Bucket;
  client: VisionClient;
  model: VisionModelSpec;
  storageKeys: (inferenceCacheKey: string) => VisualInferenceStorageKeys;
  /** Strict budget/call-cap admission. Invoked only for fully absent durable state. */
  admitNewPurchase: (request: VisionClientRequest, model: VisionModelSpec) => Promise<void>;
  /** Strict/idempotent ledger writer. A rejection prevents the observation from advancing. */
  accountSettledAttempt: (event: VisualInferenceAccountingEvent) => Promise<void>;
  /** Strict/idempotent release of a reservation proven not to have crossed the paid boundary. */
  accountNotAttempted: (event: VisualInferenceNotAttemptedEvent) => Promise<void>;
  /** Optional rate calculation. It may return null, which is preserved as unknown. */
  estimateCostUsd?: (
    telemetry: VisionCallTelemetry,
    model: VisionModelSpec,
  ) => number | null | Promise<number | null>;
  now?: () => Date;
}

/** A durable state that deliberately refuses another provider purchase. */
export class VisualInferencePurchaseBlockedError extends VisionProviderUnavailableError {
  constructor(readonly reason: "claim-indeterminate" | "storage-corrupt" | "claim-race") {
    super(`visual inference purchase blocked: ${reason}`);
    this.name = "VisualInferencePurchaseBlockedError";
  }
}

/** Replays as a timeout while retaining any telemetry the provider returned. */
class DurableVisualTimeoutError extends VisionProviderUnavailableError {
  constructor(persistedKind: string, telemetry: VisionCallTelemetry | null) {
    super("visual inference timed out", telemetry);
    this.name = "TimeoutError";
    const reference = persistedProviderReference("provider-timeout", persistedKind);
    if (reference !== null) Object.assign(this, providerReferenceFields(reference));
  }
}

export class DurableVisionClient implements VisionClient {
  constructor(private readonly dependencies: DurableVisionClientDependencies) {}

  async observe(request: VisionClientRequest, signal: AbortSignal): Promise<VisionClientOutcome> {
    await assertRequestIdentity(request, this.dependencies.model);
    const keys = this.dependencies.storageKeys(request.inferenceCacheKey);
    const initial = await readVisualInferenceState(this.dependencies.bucket, keys);

    if (initial.state === "settled") return this.replay(request, initial.outcome);
    if (initial.state === "indeterminate") {
      throw new VisualInferencePurchaseBlockedError("claim-indeterminate");
    }
    if (initial.state === "corrupt") {
      throw new VisualInferencePurchaseBlockedError("storage-corrupt");
    }

    // Admission belongs after the durable lookup (cached outcomes cost nothing) and before the
    // immutable claim/provider boundary. Concurrent admissible callers are still serialized by
    // the conditional claim write below; only its winner may purchase.
    await this.dependencies.admitNewPurchase(request, this.dependencies.model);
    const claim = this.claimFor(request);
    let disposition: "stored" | "reused";
    try {
      disposition = await claimVisualInference(this.dependencies.bucket, keys, claim);
    } catch (error) {
      if (!(error instanceof VisualStorageImmutabilityError)) throw error;
      // A concurrent claimant won with different timestamp bytes. It is never safe for the
      // loser to call. Treat the conditional-write conflict exactly like a reused claim.
      disposition = "reused";
    }
    if (disposition !== "stored") {
      // Reusing a pre-call receipt never authorizes another purchase. Re-read because the
      // winning writer may already have settled between our first read and this point.
      const raced = await readVisualInferenceState(this.dependencies.bucket, keys);
      if (raced.state === "settled") return this.replay(request, raced.outcome);
      throw new VisualInferencePurchaseBlockedError(
        raced.state === "corrupt" ? "storage-corrupt" : raced.state === "indeterminate" ? "claim-indeterminate" : "claim-race",
      );
    }

    let receipt: VisualInferenceOutcomeReceipt | null = null;
    let providerOutcome: VisionClientOutcome | null = null;
    try {
      providerOutcome = await this.dependencies.client.observe(request, signal);
    } catch (error) {
      const telemetry =
        error instanceof VisionProviderUnavailableError && error.telemetry !== null
          ? await this.withEstimatedCost(error.telemetry)
          : null;
      receipt = this.receiptForFailure(request, error, telemetry);
    }

    if (providerOutcome !== null) {
      // Cost-policy and local normalization failures are outside the provider boundary. Let
      // them fail loudly and leave the already-written claim indeterminate; rewriting either
      // as "provider unavailable" would lie about a request that actually returned.
      const telemetry = await this.withEstimatedCost(providerOutcome.telemetry);
      receipt = await this.receiptForProviderOutcome(request, providerOutcome.content, telemetry);
    }
    if (receipt === null) throw new Error("visual inference settled without an outcome receipt");

    await settleVisualInference(this.dependencies.bucket, keys, receipt);
    return this.replay(request, receipt);
  }

  private claimFor(request: VisionClientRequest): VisualInferenceClaimReceipt {
    return {
      schemaVersion: VISUAL_INFERENCE_CLAIM_SCHEMA_VERSION,
      kind: "survey-qa-visual-inference-claim",
      inferenceCacheKey: request.inferenceCacheKey,
      callId: request.callId,
      claimedAt: this.nowIso(),
      request: {
        screenshotSha256: request.screenshot.contentSha256,
        mediaType: "image/png",
        pixelWidth: request.screenshot.pixelWidth,
        pixelHeight: request.screenshot.pixelHeight,
        provider: this.dependencies.model.provider,
        model: this.dependencies.model.model,
        transport: this.dependencies.model.transport,
        configurationSha256: this.dependencies.model.configurationSha256,
        prompt: { version: request.prompt.version, sha256: request.prompt.sha256 },
        responseSchema: {
          version: request.responseSchema.version,
          sha256: request.responseSchema.sha256,
        },
      },
    };
  }

  private async receiptForProviderOutcome(
    request: VisionClientRequest,
    content: unknown,
    telemetry: VisionCallTelemetry,
  ): Promise<VisualInferenceOutcomeReceipt> {
    let result: VisualInferenceOutcomeResult;
    const reportedModelMismatch = telemetry.model !== this.dependencies.model.model;
    const forbidden = reportedModelMismatch ? [] : forbiddenDecisionFields(content);
    const parsed = reportedModelMismatch || forbidden.length > 0
      ? null
      : validateModelVisualInventory(content);
    if (reportedModelMismatch) {
      // The requested model is part of the inference-cache identity, while telemetry.model is
      // the provider-reported identity. Preserve and account the paid receipt, but classify its
      // content as malformed at this durable boundary. If we stored it as `observed`, the outer
      // observer would (correctly) reject the drift as `malformed` and the epoch processor would
      // see two contradictory durable states on every replay.
      result = {
        state: "malformed",
        inventory: null,
        responseSha256: null,
        failure: {
          kind: "model-identity-mismatch",
          count: 1,
          detail: "Provider telemetry reported a model other than the requested model; response content was discarded.",
        },
      };
    } else if (parsed !== null && parsed.ok) {
      result = {
        state: "observed",
        inventory: parsed.value,
        responseSha256: await sha256Hex(canonicalJson(parsed.value)),
      };
    } else {
      result = {
        state: "malformed",
        inventory: null,
        responseSha256: null,
        failure: {
          kind: forbidden.length > 0 ? "forbidden-decision-field" : "closed-schema-rejection",
          count: Math.max(1, forbidden.length),
          detail:
            forbidden.length > 0
              ? "Provider content contained a decision-bearing field and was discarded."
              : "Provider content did not satisfy the closed visual inventory schema.",
        },
      };
    }
    return this.outcomeReceipt(request, result, telemetry);
  }

  private receiptForFailure(
    request: VisionClientRequest,
    error: unknown,
    telemetry: VisionCallTelemetry | null,
  ): VisualInferenceOutcomeReceipt {
    const notAttempted = coherentNotAttemptedPreflightReference(error);
    const timedOut =
      notAttempted === null &&
      (signalLikeTimeout(error) ||
        (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")));
    return this.outcomeReceipt(
      request,
      {
        state: timedOut ? "timeout" : "unavailable",
        inventory: null,
        responseSha256: null,
        failure: {
          kind:
            notAttempted !== null
              ? persistedProviderKind("provider-not-attempted", notAttempted)
              : timedOut
                ? stableProviderTimeoutKind(error)
                : stableProviderFailureKind(error),
          count: 1,
          // Never persist raw provider/credential exception text.
          detail:
            notAttempted !== null
              ? "The adapter rejected the request before crossing the paid provider boundary."
              : timedOut
                ? "The provider attempt did not settle before its deadline."
                : "The provider attempt did not return a usable response.",
        },
      },
      telemetry,
    );
  }

  private outcomeReceipt(
    request: VisionClientRequest,
    result: VisualInferenceOutcomeResult,
    telemetry: VisionCallTelemetry | null,
  ): VisualInferenceOutcomeReceipt {
    return {
      schemaVersion: VISUAL_INFERENCE_OUTCOME_SCHEMA_VERSION,
      kind: "survey-qa-visual-inference-outcome",
      inferenceCacheKey: request.inferenceCacheKey,
      callId: request.callId,
      settledAt: this.nowIso(),
      result,
      telemetry,
    };
  }

  private async replay(
    request: VisionClientRequest,
    receipt: VisualInferenceOutcomeReceipt,
  ): Promise<VisionClientOutcome> {
    if (receipt.callId !== request.callId || receipt.inferenceCacheKey !== request.inferenceCacheKey) {
      throw new VisualInferencePurchaseBlockedError("storage-corrupt");
    }
    const declaresNotAttempted =
      receipt.result.state !== "observed" &&
      (receipt.result.failure.kind === "provider-not-attempted" ||
        receipt.result.failure.kind.startsWith("provider-not-attempted:"));
    const notAttempted =
      receipt.result.state === "unavailable"
        ? persistedNotAttemptedPreflightReference(receipt.result.failure.kind)
        : null;
    if (declaresNotAttempted && notAttempted === null) {
      throw new VisualInferencePurchaseBlockedError("storage-corrupt");
    }
    if (notAttempted === null) {
      await this.dependencies.accountSettledAttempt(
        visualInferenceAccountingEvent(this.dependencies.model, receipt),
      );
    } else {
      if (receipt.telemetry !== null) {
        throw new VisualInferencePurchaseBlockedError("storage-corrupt");
      }
      await this.dependencies.accountNotAttempted(
        visualInferenceNotAttemptedEvent(this.dependencies.model, receipt),
      );
    }

    if (receipt.result.state === "timeout") {
      throw new DurableVisualTimeoutError(receipt.result.failure.kind, receipt.telemetry);
    }
    if (receipt.result.state === "unavailable") {
      throw replayedProviderUnavailableError(receipt.result.failure.kind, receipt.telemetry);
    }
    if (receipt.result.state === "malformed") {
      if (receipt.telemetry === null) {
        throw new VisualInferencePurchaseBlockedError("storage-corrupt");
      }
      // Null deliberately reaches the observer's closed validator and becomes `malformed`.
      return { content: null, telemetry: receipt.telemetry };
    }
    if (receipt.telemetry === null) {
      throw new VisualInferencePurchaseBlockedError("storage-corrupt");
    }
    return { content: receipt.result.inventory, telemetry: receipt.telemetry };
  }

  private async withEstimatedCost(telemetry: VisionCallTelemetry): Promise<VisionCallTelemetry> {
    if (telemetry.costUsd !== null || this.dependencies.estimateCostUsd === undefined) return telemetry;
    const estimated = await this.dependencies.estimateCostUsd(telemetry, this.dependencies.model);
    if (estimated === null) return telemetry;
    if (typeof estimated !== "number" || !Number.isFinite(estimated) || estimated < 0) {
      throw new Error("visual cost estimator returned an invalid amount");
    }
    return { ...telemetry, costUsd: estimated, usageSource: "configured-rate" };
  }

  private nowIso(): string {
    return (this.dependencies.now?.() ?? new Date()).toISOString();
  }
}

/**
 * Preserve an adapter's closed, non-secret failure classification without retaining arbitrary
 * provider exception text. Unknown/malformed references collapse to the generic limitation.
 * This keeps the durable receipt useful when a paid call fails while preventing an upstream
 * object from smuggling unbounded or credential-bearing fields into R2.
 */
function stableProviderFailureKind(error: unknown): string {
  return stableProviderReferenceKind("provider-unavailable", error);
}

function stableProviderTimeoutKind(error: unknown): string {
  return stableProviderReferenceKind("provider-timeout", error);
}

function stableProviderReferenceKind(prefix: string, error: unknown): string {
  if (!(error instanceof VisionProviderUnavailableError)) return prefix;
  try {
    const reference = error as { providerFailureCategory?: unknown; providerFailureCode?: unknown };
    const category = safeFailureSegment(reference.providerFailureCategory);
    const code = safeFailureSegment(reference.providerFailureCode);
    if (category === null || code === null) return prefix;
    return persistedProviderKind(prefix, { category, code });
  } catch {
    return prefix;
  }
}

function safeFailureSegment(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,99}$/.test(value) ? value : null;
}

function replayedProviderUnavailableError(
  persistedKind: string,
  telemetry: VisionCallTelemetry | null,
): VisionProviderUnavailableError {
  const failure = new VisionProviderUnavailableError("visual inference unavailable", telemetry);
  const notAttempted = persistedNotAttemptedPreflightReference(persistedKind);
  if (notAttempted !== null) {
    return Object.assign(failure, {
      ...providerReferenceFields(notAttempted),
      providerFailurePhase: "preflight",
      providerCallAttempted: false,
    } as const);
  }
  const reference = persistedProviderReference("provider-unavailable", persistedKind);
  if (reference === null) return failure;
  // Only the two already-normalized path segments are reconstructed. The original exception,
  // message, stack, arbitrary fields, and provider payload were never persisted and cannot be
  // recreated during replay.
  return Object.assign(failure, providerReferenceFields(reference));
}

function persistedProviderKind(
  prefix: "provider-unavailable" | "provider-timeout" | "provider-not-attempted" | string,
  reference: { category: string; code: string },
): string {
  const combined = `${prefix}:${reference.category}:${reference.code}`;
  // Stored failure kinds are capped at 200 characters. A safe component pair that does not fit
  // must collapse before settlement; otherwise a paid call can leave only an indeterminate claim.
  return combined.length <= 200 ? combined : prefix;
}

function persistedProviderReference(
  prefix: "provider-unavailable" | "provider-timeout",
  persistedKind: string,
): { category: string; code: string } | null {
  const match = new RegExp(
    `^${prefix}:([a-z0-9][a-z0-9-]{0,99}):([a-z0-9][a-z0-9-]{0,99})$`,
  ).exec(persistedKind);
  return match === null ? null : { category: match[1]!, code: match[2]! };
}

function persistedNotAttemptedPreflightReference(
  persistedKind: string,
): { category: string; code: string } | null {
  const match =
    /^provider-not-attempted:([a-z0-9][a-z0-9-]{0,99}):([a-z0-9][a-z0-9-]{0,99})$/.exec(
      persistedKind,
    );
  return match === null
    ? null
    : allowedNotAttemptedPreflightReference(match[1], match[2]);
}

function providerReferenceFields(reference: { category: string; code: string }): {
  providerFailureCategory: string;
  providerFailureCode: string;
} {
  return {
    providerFailureCategory: reference.category,
    providerFailureCode: reference.code,
  };
}

/**
 * Rebuild the deterministic strict-ledger event from a normalized durable receipt.
 *
 * Exported so a downstream durability stage can close the narrow race where its own deadline
 * wins while this client's provider cleanup is still settling. Re-committing this event is
 * idempotent; it never authorizes a provider request.
 */
export function visualInferenceAccountingEvent(
  model: VisionModelSpec,
  receipt: VisualInferenceOutcomeReceipt,
): VisualInferenceAccountingEvent {
  const telemetry = receipt.telemetry;
  const digest = INFERENCE_CACHE_KEY.exec(receipt.inferenceCacheKey)?.[1];
  if (digest === undefined) throw new VisualInferencePurchaseBlockedError("storage-corrupt");
  return {
    eventId: `visual-model-call/sha256/${digest}`,
    callId: receipt.callId,
    inferenceCacheKey: receipt.inferenceCacheKey,
    requestedProvider: model.provider,
    requestedModel: model.model,
    reportedModel: telemetry?.model ?? null,
    resultState: receipt.result.state,
    inputTokens: telemetry?.inputTokens ?? null,
    outputTokens: telemetry?.outputTokens ?? null,
    costUsd: telemetry?.costUsd ?? null,
    usageSource: telemetry?.usageSource ?? "unavailable",
    attempts: telemetry?.attempts ?? 1,
    settledAt: receipt.settledAt,
  };
}

export function visualInferenceNotAttemptedEvent(
  model: VisionModelSpec,
  receipt: VisualInferenceOutcomeReceipt,
): VisualInferenceNotAttemptedEvent {
  const digest = INFERENCE_CACHE_KEY.exec(receipt.inferenceCacheKey)?.[1];
  if (digest === undefined) throw new VisualInferencePurchaseBlockedError("storage-corrupt");
  if (
    receipt.result.state !== "unavailable" ||
    persistedNotAttemptedPreflightReference(receipt.result.failure.kind) === null ||
    receipt.telemetry !== null
  ) {
    throw new VisualInferencePurchaseBlockedError("storage-corrupt");
  }
  return {
    eventId: `visual-model-call/sha256/${digest}`,
    callId: receipt.callId,
    inferenceCacheKey: receipt.inferenceCacheKey,
    requestedProvider: model.provider,
    requestedModel: model.model,
    settledAt: receipt.settledAt,
  };
}

export function visualInferenceReceiptWasNotAttempted(
  receipt: VisualInferenceOutcomeReceipt,
): boolean {
  return (
    receipt.result.state === "unavailable" &&
    receipt.telemetry === null &&
    persistedNotAttemptedPreflightReference(receipt.result.failure.kind) !== null
  );
}

async function assertRequestIdentity(request: VisionClientRequest, model: VisionModelSpec): Promise<void> {
  const match = INFERENCE_CACHE_KEY.exec(request.inferenceCacheKey);
  if (match === null || request.callId !== `visual-${match[1]!.slice(-32)}`) {
    throw new VisionProviderUnavailableError("visual inference request identity is malformed");
  }
  const derived = await computeVisualInferenceCacheKey({
    screenshotSha256: request.screenshot.contentSha256,
    pixelWidth: request.screenshot.pixelWidth,
    pixelHeight: request.screenshot.pixelHeight,
    provider: model.provider,
    model: model.model,
    configurationSha256: model.configurationSha256,
    promptSha256: request.prompt.sha256,
    responseSchemaSha256: request.responseSchema.sha256,
  });
  if (derived !== request.inferenceCacheKey) {
    throw new VisionProviderUnavailableError("visual inference request identity does not re-derive");
  }
}

function signalLikeTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = "name" in error ? (error as { name?: unknown }).name : null;
  return name === "AbortError" || name === "TimeoutError";
}

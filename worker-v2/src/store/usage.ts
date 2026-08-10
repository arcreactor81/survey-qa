/**
 * USAGE TRACKING — records every model call and browser session as an immutable event
 * and updates the cumulative counters that the four budget caps read.
 *
 * `capExceeded()` in run-workflow.ts checks `usage.modelCalls.used`, `usage.cost.usedUsd`,
 * `usage.toolCalls.used` and `usage.wallClock.usedMilliseconds` before every execution
 * batch. Without events pushing data to those counters, the caps are structural guards
 * with nothing behind them.
 *
 * Browser telemetry remains best-effort. Paid extraction model calls fail loudly, and paid
 * visual inference uses a separate post-run CAS ledger so neither path can create silent
 * headroom or revise the already-finalized core checkpoint.
 */

import type { Env } from "../types/env";
import type {
  BrowserSessionUsageEvent,
  ModelCallUsageEvent,
  Usage,
  UsageEvent,
  VisualModelCallUsageEvent,
  VisualUsageCost,
  VisualUsageResultState,
} from "../types/contracts";
import type {
  VisualInferenceAccountingEvent,
  VisualInferenceNotAttemptedEvent,
} from "../vision/durable-client";
import { visualUsageLedgerKey } from "../keys";
import { OwnershipLost } from "../types/contracts";
import { canonicalJson, sha256Hex } from "./hash";
import { loadCheckpoint, updateCheckpoint, type Fence } from "./checkpoint";

export type { UsageEvent, VisualModelCallUsageEvent, VisualUsageCost };

const USD_MICRO_SCALE = 1_000_000;

export function modelUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): ModelCallUsageEvent {
  return { kind: "model-call", model, inputTokens, outputTokens, costUsd, at: new Date().toISOString() };
}

export function browserUsage(): BrowserSessionUsageEvent {
  return { kind: "browser-session", at: new Date().toISOString() };
}

/**
 * WALL-CLOCK TICK — the only writer of `usage.wallClock.usedMilliseconds`.
 *
 * Before this function existed, the wall-clock cap was enforced against a counter nothing
 * ever incremented: `capExceeded` read `usedMilliseconds` and every value stayed 0, so
 * `wall-clock-cap` was structurally incapable of firing — a cap that cannot fail. Each
 * tick writes the elapsed time since the run started, so the cap finally has a number to
 * compare. The checkpoint carries `startedAtMs` so the write is a pure recomputation and
 * never drifts with retries (a replacement instance recomputes from the same origin).
 *
 * THIS MUST NEVER FAIL THE PIPELINE, same as pushUsage.
 */
export async function tickWallClock(env: Env, runId: string, fence: Fence): Promise<void> {
  try {
    await updateCheckpoint(
      env,
      runId,
      (d) => {
        const w = d.usage.wallClock;
        if (!w.startedAtMs) w.startedAtMs = Date.now();
        w.usedMilliseconds = Math.max(w.usedMilliseconds, Date.now() - w.startedAtMs);
      },
      { progressed: true, fence },
    );
  } catch (err) {
    console.error(`wall-clock tick failed for ${runId}:`, err);
  }
}

/** Browser telemetry remains best-effort because it cannot create model-spend headroom. */
export async function pushUsage(
  env: Env,
  runId: string,
  fence: Fence,
  events: BrowserSessionUsageEvent[],
): Promise<void> {
  if (events.length === 0) return;
  try {
    await updateCheckpoint(
      env,
      runId,
      (d) => {
        d.usage.events = [...(d.usage.events ?? []), ...events];
        for (const e of events) {
          if (e.kind === "browser-session") {
            d.usage.browserSessions.used += 1;
            d.usage.toolCalls.used += 1;
          }
        }
      },
      { progressed: true, fence },
    );
  } catch (err) {
    console.error(`usage push failed for ${runId}:`, err);
  }
}

/**
 * Fail-loud writer for every pre-visual paid model call. A successful extraction step cannot
 * leave the shared allowance understated: the model result and this fenced CAS either both
 * complete, or the stage throws and the post-report visual child is never launched.
 */
export async function pushModelUsageStrict(
  env: Env,
  runId: string,
  fence: Fence,
  events: ModelCallUsageEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const normalized = events.map((event, index): ModelCallUsageEvent => {
    if (!isRecord(event) || event.kind !== "model-call") {
      invalid(`modelEvents[${index}]`, "expected a model-call event");
    }
    exactKeys(event, `modelEvents[${index}]`, [
      "kind", "model", "inputTokens", "outputTokens", "costUsd", "at",
    ]);
    const at = identityString(event.at, `modelEvents[${index}].at`, 100);
    assertIsoTimestamp(at, `modelEvents[${index}].at`);
    return {
      kind: "model-call",
      model: identityString(event.model, `modelEvents[${index}].model`, 300),
      inputTokens: nonnegativeSafeInteger(event.inputTokens, `modelEvents[${index}].inputTokens`),
      outputTokens: nonnegativeSafeInteger(event.outputTokens, `modelEvents[${index}].outputTokens`),
      costUsd: nonnegativeFinite(event.costUsd, `modelEvents[${index}].costUsd`),
      at,
    };
  });
  const checkpoint = await updateCheckpoint(
    env,
    runId,
    (draft) => {
      assertUsageCounters(draft.usage);
      if (draft.usage.paidModelAccounting?.mode !== "fail-loud-v2-micro-ceiling") {
        invalid(
          "paidModelAccounting",
          "shared model usage is not on the conservative fail-loud accounting path",
        );
      }
      draft.usage.events = [...draft.usage.events, ...normalized];
      let usedMicros = storedConservativeUsdMicros(
        draft.usage.cost.usedUsd,
        "cost.usedUsd",
      );
      for (const event of normalized) {
        if (draft.usage.modelCalls.used === Number.MAX_SAFE_INTEGER) {
          invalid("modelCalls.used", "cannot increment beyond the safe integer range");
        }
        draft.usage.modelCalls.used += 1;
        const eventMicros = conservativeUsdMicros(
          event.costUsd,
          `modelEvents.costUsd`,
        );
        if (usedMicros > Number.MAX_SAFE_INTEGER - eventMicros) {
          invalid("cost.usedUsd", "conservative micro-dollar total exceeds the safe integer range");
        }
        usedMicros += eventMicros;
      }
      // Events retain their calculated cost. The cap counter is deliberately the sum of each
      // paid call's upward micro-dollar envelope, so no repeated tail can become headroom.
      draft.usage.cost.usedUsd = usedMicros / USD_MICRO_SCALE;
    },
    { progressed: true, fence },
  );
  if (checkpoint === null) throw new StrictUsageCheckpointMissing(runId);
}

export class StrictUsageCheckpointMissing extends Error {
  constructor(runId: string) {
    super(`strict usage checkpoint is missing for run ${runId}`);
    this.name = "StrictUsageCheckpointMissing";
  }
}

// ---------------------------------------------------------------------------
// STRICT PAID-VISUAL USAGE
// ---------------------------------------------------------------------------

const INFERENCE_KEY = /^visual-inference\/sha256\/([0-9a-f]{64})$/;
const CALL_ID = /^visual-([0-9a-f]{32})$/;
const EVENT_ID = /^visual-model-call\/sha256\/([0-9a-f]{64})$/;
const KNOWN_COST_SOURCES = new Set(["provider-reported", "gateway-reported", "configured-rate"]);
const UNKNOWN_COST_REASONS = new Set([
  "provider-not-reported",
  "transport-no-cost-telemetry",
  "attempt-outcome-uncertain",
]);
const VISUAL_RESULT_STATES = new Set(["observed", "malformed", "timeout", "unavailable"]);
const VISUAL_USAGE_SOURCES = new Set([
  "provider-reported",
  "gateway-reported",
  "configured-rate",
  "unavailable",
]);
const VISUAL_USAGE_LEDGER_SCHEMA_VERSION = "survey-qa-visual-usage/1.0.0" as const;
const VISUAL_USAGE_LEDGER_KIND = "survey-qa-visual-usage" as const;
const VISUAL_RESERVATION_SCHEMA_VERSION = "survey-qa-visual-reservation/1.0.0" as const;
const VISUAL_RESERVATION_KIND = "survey-qa-visual-reservation" as const;
const MAX_VISUAL_USAGE_LEDGER_BYTES = 1024 * 1024;
const MAX_VISUAL_USAGE_CAS_ATTEMPTS = 8;

export type VisualUsageAdmissionReason =
  | "already-committed"
  | "reservation-active"
  | "shared-ledger-unverifiable"
  | "shared-ledger-drift"
  | "prior-cost-unknown"
  | "wall-clock-cap"
  | "visual-call-cap"
  | "visual-cost-cap"
  | "model-call-cap"
  | "cost-cap";

export interface VisualInferenceReservation {
  schemaVersion: typeof VISUAL_RESERVATION_SCHEMA_VERSION;
  kind: typeof VISUAL_RESERVATION_KIND;
  eventId: string;
  callId: string;
  inferenceCacheKey: string;
  provider: string;
  model: string;
  maximumCostUsd: number;
  maximumVisualCalls: number;
  maximumVisualUsd: number;
  reservedAt: string;
}

export interface VisualUsageCoreAllowance {
  sourceUsageSha256: string;
  sourceCheckpointRevision: number;
  modelCallsUsed: number;
  modelCallsMax: number;
  costUsedUsd: number;
  costMaxUsd: number;
  verificationReserveUsd: number;
  reportReserveUsd: number;
  wallClockUsedMilliseconds: number;
  wallClockMaxMilliseconds: number;
  wallClockStartedAtMs: number;
}

export interface VisualUsageLedger {
  schemaVersion: typeof VISUAL_USAGE_LEDGER_SCHEMA_VERSION;
  kind: typeof VISUAL_USAGE_LEDGER_KIND;
  runId: string;
  revision: number;
  observedAt: string;
  ownership: Fence;
  coreAllowance: VisualUsageCoreAllowance;
  reservation: VisualInferenceReservation | null;
  events: VisualModelCallUsageEvent[];
  totals: { modelCallsUsed: number; knownCostUsd: number; unknownCostCount: number };
  lastAdmissionWallClockMilliseconds: number;
}

export class VisualUsageLedgerCorruptionError extends Error {
  constructor(readonly key: string, detail: string) {
    super(`visual usage ledger ${key} is corrupt: ${detail}`);
    this.name = "VisualUsageLedgerCorruptionError";
  }
}

export class VisualUsageContention extends Error {
  constructor(runId: string) {
    super(`visual usage ledger contention for run ${runId}`);
    this.name = "VisualUsageContention";
  }
}

export class VisualUsageValidationError extends Error {
  constructor(readonly field: string, detail: string) {
    super(`visual usage ${field}: ${detail}`);
    this.name = "VisualUsageValidationError";
  }
}

export class VisualUsageIdentityConflict extends Error {
  constructor(readonly eventId: string) {
    super(`visual usage event ${eventId} was already committed with different attempt telemetry`);
    this.name = "VisualUsageIdentityConflict";
  }
}

export class VisualUsageReservationConflict extends Error {
  constructor(
    readonly eventId: string,
    readonly reservedEventId: string | null,
  ) {
    super(
      reservedEventId === null
        ? `visual usage settlement ${eventId} has no durable pre-provider reservation`
        : `visual usage settlement ${eventId} conflicts with active reservation ${reservedEventId}`,
    );
    this.name = "VisualUsageReservationConflict";
  }
}

export class VisualUsageAdmissionRefused extends Error {
  constructor(
    readonly reason: VisualUsageAdmissionReason,
    readonly eventId: string,
    detail: string,
  ) {
    super(`visual inference admission refused (${reason}) for ${eventId}: ${detail}`);
    this.name = "VisualUsageAdmissionRefused";
  }
}

export class VisualUsageCheckpointMissing extends Error {
  constructor(runId: string) {
    super(`visual usage checkpoint is missing for run ${runId}`);
    this.name = "VisualUsageCheckpointMissing";
  }
}

export interface VisualUsageAttemptInput {
  eventId: string;
  callId: string;
  inferenceCacheKey: string;
  provider: string;
  model: string;
  resultState: VisualUsageResultState;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: VisualUsageCost;
  /** Retry code may reuse the original timestamp; when omitted, only the first commit's time wins. */
  at?: string;
}

export interface VisualUsageCommitResult {
  eventId: string;
  disposition: "committed" | "already-committed";
  usageRevision: number;
}

export interface VisualUsageReservationReleaseResult {
  eventId: string;
  disposition: "released" | "already-released";
  usageRevision: number;
}

export interface VisualInferenceAdmissionInput {
  callId: string;
  inferenceCacheKey: string;
  provider: string;
  model: string;
  /** A conservative upper bound for this one call; unknown/unbounded proposals are refused. */
  maximumCostUsd: number;
  /** Independent channel ceiling; the global model-call cap is intentionally not its proxy. */
  maximumVisualCalls: number;
  /** Independent channel ceiling; protects the run even when its global USD cap is much larger. */
  maximumVisualUsd: number;
}

export interface VisualInferenceAdmission {
  eventId: string;
  disposition: "reserved" | "already-reserved";
  projectedVisualCalls: number;
  projectedVisualKnownCostUsd: number;
  projectedModelCalls: number;
  projectedKnownCostUsd: number;
  spendableCostUsd: number;
}

/**
 * The cache digest is the event identity. The call id must carry the digest suffix minted by the
 * observer, so a caller cannot pair one paid-call id with another screenshot's cache receipt.
 */
export function visualUsageEventId(callId: string, inferenceCacheKey: string): string {
  const cacheMatch = INFERENCE_KEY.exec(inferenceCacheKey);
  if (!cacheMatch) invalid("inferenceCacheKey", "expected visual-inference/sha256/<64 lowercase hex>");
  const digest = cacheMatch[1]!;
  const callMatch = CALL_ID.exec(callId);
  if (!callMatch) invalid("callId", "expected visual-<32 lowercase hex>");
  if (callMatch[1] !== digest.slice(-32)) {
    invalid("identity", "callId does not carry the inference cache digest suffix");
  }
  return `visual-model-call/sha256/${digest}`;
}

/** Build and validate the only event shape accepted by the strict commit path. */
export function visualModelUsage(input: VisualUsageAttemptInput): VisualModelCallUsageEvent {
  const expectedEventId = visualUsageEventId(input.callId, input.inferenceCacheKey);
  const eventId = identityString(input.eventId, "eventId", 200);
  if (eventId !== expectedEventId) {
    invalid("eventId", "does not match the event id derived from call/cache identity");
  }
  const provider = identityString(input.provider, "provider", 200);
  const model = identityString(input.model, "model", 300);
  const resultState = visualResultState(input.resultState, "resultState");
  const inputTokens = nullableTokenCount(input.inputTokens, "inputTokens");
  const outputTokens = nullableTokenCount(input.outputTokens, "outputTokens");
  const cost = normalizeVisualCost(input.cost, "cost");
  const at = input.at ?? new Date().toISOString();
  assertIsoTimestamp(at, "at");
  return {
    kind: "visual-model-call",
    eventId,
    callId: input.callId,
    inferenceCacheKey: input.inferenceCacheKey,
    provider,
    model,
    resultState,
    inputTokens,
    outputTokens,
    cost,
    at,
  };
}

/**
 * Closed bridge from the retry-safe inference receipt to the strict usage ledger. The durable
 * client owns purchase/outcome durability; this module independently re-validates its identity
 * and telemetry before accounting it. A type-only dependency keeps the store free of a runtime
 * vision-module cycle.
 */
export function visualUsageFromAccountingEvent(
  value: VisualInferenceAccountingEvent,
): VisualUsageAttemptInput {
  if (!isRecord(value)) invalid("accountingEvent", "expected an object");
  exactKeys(value, "accountingEvent", [
    "eventId",
    "callId",
    "inferenceCacheKey",
    "requestedProvider",
    "requestedModel",
    "reportedModel",
    "resultState",
    "inputTokens",
    "outputTokens",
    "costUsd",
    "usageSource",
    "attempts",
    "settledAt",
  ]);

  const callId = identityString(value.callId, "accountingEvent.callId", 100);
  const inferenceCacheKey = identityString(
    value.inferenceCacheKey,
    "accountingEvent.inferenceCacheKey",
    200,
  );
  const expectedEventId = visualUsageEventId(callId, inferenceCacheKey);
  const eventId = identityString(value.eventId, "accountingEvent.eventId", 200);
  if (eventId !== expectedEventId) {
    invalid("accountingEvent.eventId", "does not match the event id derived from call/cache identity");
  }

  const provider = identityString(value.requestedProvider, "accountingEvent.requestedProvider", 200);
  const model = identityString(value.requestedModel, "accountingEvent.requestedModel", 300);
  if (value.reportedModel !== null) {
    identityString(value.reportedModel, "accountingEvent.reportedModel", 300);
  }
  const resultState = visualResultState(value.resultState, "accountingEvent.resultState");
  const inputTokens = nullableTokenCount(value.inputTokens, "accountingEvent.inputTokens");
  const outputTokens = nullableTokenCount(value.outputTokens, "accountingEvent.outputTokens");
  const usageSource = identityString(value.usageSource, "accountingEvent.usageSource", 100);
  if (!VISUAL_USAGE_SOURCES.has(usageSource)) {
    invalid("accountingEvent.usageSource", "unknown visual usage source");
  }
  const attempts = nonnegativeSafeInteger(value.attempts, "accountingEvent.attempts");
  if (attempts !== 1) {
    invalid("accountingEvent.attempts", "one usage event must describe exactly one provider attempt");
  }
  const at = identityString(value.settledAt, "accountingEvent.settledAt", 100);
  assertIsoTimestamp(at, "accountingEvent.settledAt");

  let cost: VisualUsageCost;
  if (value.costUsd === null) {
    if (usageSource === "configured-rate") {
      invalid("accountingEvent.costUsd", "configured-rate telemetry must include its calculated cost");
    }
    cost = {
      state: "unknown",
      reason:
        usageSource !== "unavailable"
          ? "provider-not-reported"
          : resultState === "timeout" || resultState === "unavailable"
            ? "attempt-outcome-uncertain"
            : "transport-no-cost-telemetry",
    };
  } else {
    const usd = nonnegativeFinite(value.costUsd, "accountingEvent.costUsd");
    if (usageSource === "unavailable") {
      invalid("accountingEvent.usageSource", "known cost requires a reported or configured source");
    }
    cost = {
      state: "known",
      usd,
      source: usageSource as "provider-reported" | "gateway-reported" | "configured-rate",
    };
  }

  return {
    eventId,
    callId,
    inferenceCacheKey,
    provider,
    model,
    resultState,
    inputTokens,
    outputTokens,
    cost,
    at,
  };
}

/** Strict callback for `DurableVisionClient.accountSettledAttempt`; errors are never swallowed. */
export async function commitVisualInferenceAccountingStrict(
  env: Env,
  runId: string,
  fence: Fence,
  event: VisualInferenceAccountingEvent,
): Promise<VisualUsageCommitResult> {
  return commitVisualUsageStrict(env, runId, fence, visualUsageFromAccountingEvent(event));
}

/**
 * Clear only the exact reservation whose immutable provider receipt proves no paid call occurred.
 * No visual-model-call event is appended, so neither the call cap nor USD totals move. Replays are
 * idempotent and a contradictory paid event or another active reservation fails closed.
 */
export async function releaseUnattemptedVisualInferenceReservationStrict(
  env: Env,
  runId: string,
  fence: Fence,
  input: VisualInferenceNotAttemptedEvent,
): Promise<VisualUsageReservationReleaseResult> {
  const callId = identityString(input.callId, "notAttempted.callId", 100);
  const inferenceCacheKey = identityString(
    input.inferenceCacheKey,
    "notAttempted.inferenceCacheKey",
    200,
  );
  const eventId = visualUsageEventId(callId, inferenceCacheKey);
  if (input.eventId !== eventId) invalid("notAttempted.eventId", "identity mismatch");
  const provider = identityString(input.requestedProvider, "notAttempted.requestedProvider", 200);
  const model = identityString(input.requestedModel, "notAttempted.requestedModel", 300);
  let disposition: VisualUsageReservationReleaseResult["disposition"] = "released";
  const ledger = await updateVisualUsageLedger(
    env,
    runId,
    fence,
    "settlement",
    (draft) => {
      const visualEvents = validatedVisualEvents(draft.events, "events");
      if (visualEvents.some((event) => event.eventId === eventId)) {
        throw new VisualUsageIdentityConflict(eventId);
      }
      const reservation = validatedVisualReservation(draft.reservation, "reservation");
      if (reservation === null) {
        disposition = "already-released";
        return false;
      }
      if (reservation.eventId !== eventId) {
        throw new VisualUsageReservationConflict(eventId, reservation.eventId);
      }
      if (
        reservation.callId !== callId ||
        reservation.inferenceCacheKey !== inferenceCacheKey ||
        reservation.provider !== provider ||
        reservation.model !== model
      ) {
        throw new VisualUsageIdentityConflict(eventId);
      }
      draft.reservation = null;
      disposition = "released";
    },
  );
  return { eventId, disposition, usageRevision: ledger.revision };
}

/**
 * Commit one paid attempt exactly once. `updateCheckpoint` may invoke the mutator repeatedly on
 * CAS contention; each invocation re-reads the durable event id before touching either counter.
 * No error is caught here: a visual caller must not continue after an accounting failure.
 */
export async function commitVisualUsageStrict(
  env: Env,
  runId: string,
  fence: Fence,
  input: VisualUsageAttemptInput,
): Promise<VisualUsageCommitResult> {
  const event = visualModelUsage(input);
  let disposition: VisualUsageCommitResult["disposition"] = "committed";
  const ledger = await updateVisualUsageLedger(
    env, runId, fence, "settlement",
    (draft) => {
      const visualEvents = validatedVisualEvents(draft.events, "events");
      const existing = visualEvents.filter((candidate) => candidate.eventId === event.eventId);
      if (existing.length > 1) {
        invalid("events", `eventId ${event.eventId} occurs ${existing.length} times`);
      }
      if (existing.length === 1) {
        if (!sameVisualCharge(existing[0]!, event)) throw new VisualUsageIdentityConflict(event.eventId);
        disposition = "already-committed";
        return false;
      }
      const reservation = validatedVisualReservation(draft.reservation, "reservation");
      if (reservation === null || reservation.eventId !== event.eventId) {
        throw new VisualUsageReservationConflict(event.eventId, reservation?.eventId ?? null);
      }
      if (
        reservation.callId !== event.callId ||
        reservation.inferenceCacheKey !== event.inferenceCacheKey ||
        reservation.provider !== event.provider ||
        reservation.model !== event.model
      ) {
        throw new VisualUsageIdentityConflict(event.eventId);
      }
      // Reservation -> exact charge is one atomic CAS transition. If the provider reports a
      // value above its bound, persist the truth anyway; the overrun then blocks later calls.
      draft.reservation = null;
      draft.events = [...visualEvents, event];
      draft.totals = visualTotals(draft.events);
      disposition = "committed";
    },
  );
  return { eventId: event.eventId, disposition, usageRevision: ledger.revision };
}

/** Admission check for callers that already hold an atomic checkpoint projection. */
export function assertVisualInferenceAdmitted(
  usage: Usage,
  input: VisualInferenceAdmissionInput,
  nowMs = Date.now(),
  visualState: Pick<VisualUsageLedger, "events" | "reservation"> = { events: [], reservation: null },
): VisualInferenceAdmission {
  assertUsageCounters(usage);
  const provider = identityString(input.provider, "provider", 200);
  const model = identityString(input.model, "model", 300);
  const eventId = visualUsageEventId(input.callId, input.inferenceCacheKey);
  assertSharedModelUsageVerifiable(usage, eventId);
  const wallClockUsedMilliseconds = measuredWallClockMilliseconds(usage, nowMs);
  const maximumCostUsd = nonnegativeFinite(input.maximumCostUsd, "maximumCostUsd");
  const maximumVisualCalls = nonnegativeSafeInteger(input.maximumVisualCalls, "maximumVisualCalls");
  const maximumVisualUsd = nonnegativeFinite(input.maximumVisualUsd, "maximumVisualUsd");
  const visualEvents = validatedVisualEvents(visualState.events, "visual.events");
  const reservation = validatedVisualReservation(visualState.reservation, "visual.reservation");

  if (visualEvents.some((event) => event.eventId === eventId)) {
    throw new VisualUsageAdmissionRefused(
      "already-committed",
      eventId,
      "this inference cache identity already has a durable paid-attempt event",
    );
  }
  const unknownCosts = visualEvents.filter((event) => event.cost.state === "unknown");
  if (unknownCosts.length > 0) {
    throw new VisualUsageAdmissionRefused(
      "prior-cost-unknown",
      eventId,
      `${unknownCosts.length} prior visual attempt(s) have unknown cost`,
    );
  }

  let disposition: VisualInferenceAdmission["disposition"] = "reserved";
  if (reservation !== null) {
    if (reservation.eventId !== eventId) {
      throw new VisualUsageAdmissionRefused(
        "reservation-active",
        eventId,
        `another paid identity already holds the sole visual reservation (${reservation.eventId})`,
      );
    }
    if (!sameReservationProposal(reservation, {
      ...input, provider, model, maximumCostUsd, maximumVisualCalls, maximumVisualUsd,
    })) {
      throw new VisualUsageIdentityConflict(eventId);
    }
    disposition = "already-reserved";
  }

  if (wallClockUsedMilliseconds >= usage.wallClock.maxMilliseconds) {
    throw new VisualUsageAdmissionRefused(
      "wall-clock-cap",
      eventId,
      `run wall clock has used ${wallClockUsedMilliseconds} ms of ${usage.wallClock.maxMilliseconds} ms`,
    );
  }

  const projectedVisualCalls = visualEvents.length + 1;
  if (!Number.isSafeInteger(projectedVisualCalls) || projectedVisualCalls > maximumVisualCalls) {
    throw new VisualUsageAdmissionRefused(
      "visual-call-cap",
      eventId,
      `one more visual call would use ${projectedVisualCalls} of ${maximumVisualCalls}`,
    );
  }

  let usedVisualKnownCostUsd = 0;
  for (const event of visualEvents) {
    // Unknown events were refused above, so every event reaching this sum is known.
    if (event.cost.state !== "known") invalid("events", "unknown visual cost escaped the admission stop");
    usedVisualKnownCostUsd += event.cost.usd;
    if (!Number.isFinite(usedVisualKnownCostUsd)) {
      invalid("events", "visual known-cost sum is not finite");
    }
  }
  const projectedVisualKnownCostUsd = usedVisualKnownCostUsd + maximumCostUsd;
  if (!Number.isFinite(projectedVisualKnownCostUsd)) {
    invalid("maximumVisualUsd", "projected visual cost is not finite");
  }
  if (
    usedVisualKnownCostUsd >= maximumVisualUsd ||
    projectedVisualKnownCostUsd > maximumVisualUsd
  ) {
    throw new VisualUsageAdmissionRefused(
      "visual-cost-cap",
      eventId,
      `projected visual known cost $${projectedVisualKnownCostUsd} exceeds channel ceiling $${maximumVisualUsd}`,
    );
  }

  const projectedModelCalls = usage.modelCalls.used + visualEvents.length + 1;
  if (!Number.isSafeInteger(projectedModelCalls) || projectedModelCalls > usage.modelCalls.max) {
    throw new VisualUsageAdmissionRefused(
      "model-call-cap",
      eventId,
      `one more call would use ${projectedModelCalls} of ${usage.modelCalls.max}`,
    );
  }

  const spendableCostUsd =
    usage.cost.maxUsd - usage.cost.verificationReserveUsd - usage.cost.reportReserveUsd;
  if (!Number.isFinite(spendableCostUsd) || spendableCostUsd < 0) {
    invalid("cost.reserves", "verification and report reserves exceed the total cost cap");
  }
  const projectedKnownCostUsd = usage.cost.usedUsd + usedVisualKnownCostUsd + maximumCostUsd;
  if (!Number.isFinite(projectedKnownCostUsd)) {
    invalid("cost.usedUsd", "projected cost is not finite");
  }
  if (usage.cost.usedUsd >= spendableCostUsd || projectedKnownCostUsd > spendableCostUsd) {
    throw new VisualUsageAdmissionRefused(
      "cost-cap",
      eventId,
      `projected known cost $${projectedKnownCostUsd} exceeds spendable $${spendableCostUsd} after reserves`,
    );
  }
  return {
    eventId,
    disposition,
    projectedVisualCalls,
    projectedVisualKnownCostUsd,
    projectedModelCalls,
    projectedKnownCostUsd,
    spendableCostUsd,
  };
}

/**
 * Fence-checked strict preflight. It durably refreshes wall-clock usage in the same checkpoint
 * CAS that grants admission. A missing checkpoint or storage failure is surfaced to the visual
 * caller rather than converted into permission to spend.
 */
export async function preflightVisualInferenceStrict(
  env: Env,
  runId: string,
  fence: Fence,
  input: VisualInferenceAdmissionInput,
): Promise<VisualInferenceAdmission> {
  let admission: VisualInferenceAdmission | null = null;
  const evaluatedAtMs = Date.now();
  const reservedAt = new Date(evaluatedAtMs).toISOString();
  await updateVisualUsageLedger(
    env, runId, fence, "admission",
    (draft, coreUsage) => {
      draft.lastAdmissionWallClockMilliseconds = measuredWallClockMilliseconds(
        coreUsage, evaluatedAtMs,
      );
      admission = assertVisualInferenceAdmitted(coreUsage, input, evaluatedAtMs, draft);
      if (admission.disposition === "reserved") {
        draft.reservation = visualReservation(input, admission.eventId, reservedAt);
      }
    },
  );
  if (admission === null) invalid("admission", "checkpoint preflight produced no decision");
  return admission;
}

type VisualUsageUpdateMode = "admission" | "settlement";

interface LoadedVisualUsageLedger {
  ledger: VisualUsageLedger;
  etag: string;
}

/** Read-only operator projection of the post-run visual spend channel. */
export async function readVisualUsageLedger(
  bucket: R2Bucket,
  runId: string,
): Promise<VisualUsageLedger | null> {
  return (await loadVisualUsageLedger(bucket, runId))?.ledger ?? null;
}

async function updateVisualUsageLedger(
  env: Env,
  runId: string,
  fence: Fence,
  mode: VisualUsageUpdateMode,
  mutate: (draft: VisualUsageLedger, coreUsage: Usage) => boolean | void,
): Promise<VisualUsageLedger> {
  const key = visualUsageLedgerKey(runId);
  for (let attempt = 0; attempt < MAX_VISUAL_USAGE_CAS_ATTEMPTS; attempt += 1) {
    const core = await loadCoreUsageAuthority(env, runId, fence);
    const loaded = await loadVisualUsageLedger(env.EVIDENCE, runId);
    if (mode === "admission" || loaded === null) {
      assertSharedModelUsageVerifiable(core.usage, "visual-model-call/unresolved");
    }
    if (
      mode === "admission" &&
      loaded !== null &&
      loaded.ledger.coreAllowance.sourceUsageSha256 !== core.allowance.sourceUsageSha256
    ) {
      throw new VisualUsageAdmissionRefused(
        "shared-ledger-drift",
        loaded.ledger.reservation?.eventId ?? "visual-model-call/unresolved",
        "the finalized core usage changed after the visual allowance was sealed",
      );
    }

    const now = new Date().toISOString();
    const current = loaded?.ledger ?? initialVisualUsageLedger(runId, fence, core.allowance, now);
    const draft = JSON.parse(JSON.stringify(current)) as VisualUsageLedger;
    draft.revision = loaded === null ? 1 : current.revision + 1;
    draft.observedAt = now;
    draft.ownership = { ...fence };
    if (mutate(draft, core.usage) === false) return current;
    const normalized = normalizeVisualUsageLedger(draft, runId);
    const bytes = new TextEncoder().encode(canonicalJson(normalized));
    if (bytes.byteLength > MAX_VISUAL_USAGE_LEDGER_BYTES) {
      invalid("ledger", `exceeds ${MAX_VISUAL_USAGE_LEDGER_BYTES} bytes`);
    }
    const written = await env.EVIDENCE.put(key, bytes, {
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
      onlyIf: loaded === null ? { etagDoesNotMatch: "*" } : { etagMatches: loaded.etag },
    });
    if (written !== null) {
      const reread = await loadVisualUsageLedger(env.EVIDENCE, runId);
      if (reread === null || canonicalJson(reread.ledger) !== canonicalJson(normalized)) {
        throw new VisualUsageLedgerCorruptionError(key, "ledger disappeared or changed after CAS write");
      }
      return reread.ledger;
    }
  }
  throw new VisualUsageContention(runId);
}

async function loadCoreUsageAuthority(
  env: Env,
  runId: string,
  fence: Fence,
): Promise<{ usage: Usage; allowance: VisualUsageCoreAllowance }> {
  const loaded = await loadCheckpoint(env, runId);
  if (loaded === null) throw new VisualUsageCheckpointMissing(runId);
  const ownership = loaded.checkpoint.ownership;
  if (
    ownership === null ||
    ownership.instanceId !== fence.instanceId ||
    ownership.epoch !== fence.epoch
  ) {
    throw new OwnershipLost(runId, fence, ownership);
  }
  const usage = loaded.checkpoint.usage;
  assertUsageCounters(usage);
  const sourceUsageSha256 = await sha256Hex(canonicalJson(usage));
  return {
    usage,
    allowance: {
      sourceUsageSha256,
      sourceCheckpointRevision: loaded.checkpoint.revision,
      modelCallsUsed: usage.modelCalls.used,
      modelCallsMax: usage.modelCalls.max,
      costUsedUsd: usage.cost.usedUsd,
      costMaxUsd: usage.cost.maxUsd,
      verificationReserveUsd: usage.cost.verificationReserveUsd,
      reportReserveUsd: usage.cost.reportReserveUsd,
      wallClockUsedMilliseconds: usage.wallClock.usedMilliseconds,
      wallClockMaxMilliseconds: usage.wallClock.maxMilliseconds,
      wallClockStartedAtMs: usage.wallClock.startedAtMs,
    },
  };
}

function initialVisualUsageLedger(
  runId: string,
  fence: Fence,
  allowance: VisualUsageCoreAllowance,
  observedAt: string,
): VisualUsageLedger {
  return {
    schemaVersion: VISUAL_USAGE_LEDGER_SCHEMA_VERSION,
    kind: VISUAL_USAGE_LEDGER_KIND,
    runId,
    revision: 1,
    observedAt,
    ownership: { ...fence },
    coreAllowance: allowance,
    reservation: null,
    events: [],
    totals: { modelCallsUsed: 0, knownCostUsd: 0, unknownCostCount: 0 },
    lastAdmissionWallClockMilliseconds: allowance.wallClockUsedMilliseconds,
  };
}

async function loadVisualUsageLedger(
  bucket: R2Bucket,
  runId: string,
): Promise<LoadedVisualUsageLedger | null> {
  const key = visualUsageLedgerKey(runId);
  const object = await bucket.get(key);
  if (object === null) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength > MAX_VISUAL_USAGE_LEDGER_BYTES) {
    throw new VisualUsageLedgerCorruptionError(key, "stored bytes exceed the ledger envelope");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new VisualUsageLedgerCorruptionError(key, "stored bytes are not strict UTF-8 JSON");
  }
  try {
    const ledger = normalizeVisualUsageLedger(parsed, runId);
    if (canonicalJson(ledger) !== new TextDecoder().decode(bytes)) {
      throw new Error("stored bytes are not canonical JSON");
    }
    return { ledger, etag: object.etag };
  } catch (error) {
    if (error instanceof VisualUsageLedgerCorruptionError) throw error;
    throw new VisualUsageLedgerCorruptionError(
      key,
      error instanceof Error ? error.message.slice(0, 500) : "validation failed",
    );
  }
}

function normalizeVisualUsageLedger(value: unknown, runId: string): VisualUsageLedger {
  if (!isRecord(value)) invalid("ledger", "expected an object");
  exactKeys(value, "ledger", [
    "schemaVersion", "kind", "runId", "revision", "observedAt", "ownership",
    "coreAllowance", "reservation", "events", "totals", "lastAdmissionWallClockMilliseconds",
  ]);
  if (value.schemaVersion !== VISUAL_USAGE_LEDGER_SCHEMA_VERSION) invalid("ledger.schemaVersion", "unknown schema");
  if (value.kind !== VISUAL_USAGE_LEDGER_KIND) invalid("ledger.kind", "unknown kind");
  if (identityString(value.runId, "ledger.runId", 100) !== runId) invalid("ledger.runId", "wrong run");
  const observedAt = identityString(value.observedAt, "ledger.observedAt", 100);
  assertIsoTimestamp(observedAt, "ledger.observedAt");
  const revision = nonnegativeSafeInteger(value.revision, "ledger.revision");
  if (revision < 1) invalid("ledger.revision", "must be at least one");
  const ownership = normalizeFence(value.ownership, "ledger.ownership");
  const coreAllowance = normalizeCoreAllowance(value.coreAllowance, "ledger.coreAllowance");
  const reservation = validatedVisualReservation(value.reservation, "ledger.reservation");
  const events = validatedVisualEvents(value.events, "ledger.events");
  const totals = visualTotals(events);
  if (!isRecord(value.totals)) invalid("ledger.totals", "expected an object");
  exactKeys(value.totals, "ledger.totals", ["modelCallsUsed", "knownCostUsd", "unknownCostCount"]);
  if (
    nonnegativeSafeInteger(value.totals.modelCallsUsed, "ledger.totals.modelCallsUsed") !== totals.modelCallsUsed ||
    nonnegativeFinite(value.totals.knownCostUsd, "ledger.totals.knownCostUsd") !== totals.knownCostUsd ||
    nonnegativeSafeInteger(value.totals.unknownCostCount, "ledger.totals.unknownCostCount") !== totals.unknownCostCount
  ) invalid("ledger.totals", "does not reconcile to visual events");
  if (reservation !== null && events.some((event) => event.eventId === reservation.eventId)) {
    invalid("ledger.reservation", "cannot remain active beside its committed event");
  }
  if (reservation !== null && totals.unknownCostCount > 0) {
    invalid("ledger.reservation", "cannot exist after an unknown-cost attempt");
  }
  return {
    schemaVersion: VISUAL_USAGE_LEDGER_SCHEMA_VERSION,
    kind: VISUAL_USAGE_LEDGER_KIND,
    runId,
    revision,
    observedAt,
    ownership,
    coreAllowance,
    reservation,
    events,
    totals,
    lastAdmissionWallClockMilliseconds: nonnegativeSafeInteger(
      value.lastAdmissionWallClockMilliseconds,
      "ledger.lastAdmissionWallClockMilliseconds",
    ),
  };
}

function normalizeCoreAllowance(value: unknown, field: string): VisualUsageCoreAllowance {
  if (!isRecord(value)) invalid(field, "expected an object");
  exactKeys(value, field, [
    "sourceUsageSha256", "sourceCheckpointRevision", "modelCallsUsed", "modelCallsMax",
    "costUsedUsd", "costMaxUsd", "verificationReserveUsd", "reportReserveUsd",
    "wallClockUsedMilliseconds", "wallClockMaxMilliseconds", "wallClockStartedAtMs",
  ]);
  const hash = identityString(value.sourceUsageSha256, `${field}.sourceUsageSha256`, 64);
  if (!/^[0-9a-f]{64}$/.test(hash)) invalid(`${field}.sourceUsageSha256`, "expected lowercase sha256");
  return {
    sourceUsageSha256: hash,
    sourceCheckpointRevision: nonnegativeSafeInteger(value.sourceCheckpointRevision, `${field}.sourceCheckpointRevision`),
    modelCallsUsed: nonnegativeSafeInteger(value.modelCallsUsed, `${field}.modelCallsUsed`),
    modelCallsMax: nonnegativeSafeInteger(value.modelCallsMax, `${field}.modelCallsMax`),
    costUsedUsd: nonnegativeFinite(value.costUsedUsd, `${field}.costUsedUsd`),
    costMaxUsd: nonnegativeFinite(value.costMaxUsd, `${field}.costMaxUsd`),
    verificationReserveUsd: nonnegativeFinite(value.verificationReserveUsd, `${field}.verificationReserveUsd`),
    reportReserveUsd: nonnegativeFinite(value.reportReserveUsd, `${field}.reportReserveUsd`),
    wallClockUsedMilliseconds: nonnegativeSafeInteger(value.wallClockUsedMilliseconds, `${field}.wallClockUsedMilliseconds`),
    wallClockMaxMilliseconds: nonnegativeSafeInteger(value.wallClockMaxMilliseconds, `${field}.wallClockMaxMilliseconds`),
    wallClockStartedAtMs: nonnegativeSafeInteger(value.wallClockStartedAtMs, `${field}.wallClockStartedAtMs`),
  };
}

function visualReservation(
  input: VisualInferenceAdmissionInput,
  eventId: string,
  reservedAt: string,
): VisualInferenceReservation {
  return validatedVisualReservation({
    schemaVersion: VISUAL_RESERVATION_SCHEMA_VERSION,
    kind: VISUAL_RESERVATION_KIND,
    eventId,
    callId: input.callId,
    inferenceCacheKey: input.inferenceCacheKey,
    provider: input.provider,
    model: input.model,
    maximumCostUsd: input.maximumCostUsd,
    maximumVisualCalls: input.maximumVisualCalls,
    maximumVisualUsd: input.maximumVisualUsd,
    reservedAt,
  }, "reservation")!;
}

function validatedVisualReservation(value: unknown, field: string): VisualInferenceReservation | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) invalid(field, "expected an object or null");
  exactKeys(value, field, [
    "schemaVersion", "kind", "eventId", "callId", "inferenceCacheKey", "provider", "model",
    "maximumCostUsd", "maximumVisualCalls", "maximumVisualUsd", "reservedAt",
  ]);
  if (value.schemaVersion !== VISUAL_RESERVATION_SCHEMA_VERSION) invalid(`${field}.schemaVersion`, "unknown schema");
  if (value.kind !== VISUAL_RESERVATION_KIND) invalid(`${field}.kind`, "unknown kind");
  const callId = identityString(value.callId, `${field}.callId`, 100);
  const inferenceCacheKey = identityString(value.inferenceCacheKey, `${field}.inferenceCacheKey`, 200);
  const eventId = identityString(value.eventId, `${field}.eventId`, 200);
  if (eventId !== visualUsageEventId(callId, inferenceCacheKey)) invalid(`${field}.eventId`, "identity mismatch");
  const reservedAt = identityString(value.reservedAt, `${field}.reservedAt`, 100);
  assertIsoTimestamp(reservedAt, `${field}.reservedAt`);
  return {
    schemaVersion: VISUAL_RESERVATION_SCHEMA_VERSION,
    kind: VISUAL_RESERVATION_KIND,
    eventId,
    callId,
    inferenceCacheKey,
    provider: identityString(value.provider, `${field}.provider`, 200),
    model: identityString(value.model, `${field}.model`, 300),
    maximumCostUsd: nonnegativeFinite(value.maximumCostUsd, `${field}.maximumCostUsd`),
    maximumVisualCalls: nonnegativeSafeInteger(value.maximumVisualCalls, `${field}.maximumVisualCalls`),
    maximumVisualUsd: nonnegativeFinite(value.maximumVisualUsd, `${field}.maximumVisualUsd`),
    reservedAt,
  };
}

function sameReservationProposal(
  reservation: VisualInferenceReservation,
  input: VisualInferenceAdmissionInput,
): boolean {
  return (
    reservation.callId === input.callId &&
    reservation.inferenceCacheKey === input.inferenceCacheKey &&
    reservation.provider === input.provider &&
    reservation.model === input.model &&
    reservation.maximumCostUsd === input.maximumCostUsd &&
    reservation.maximumVisualCalls === input.maximumVisualCalls &&
    reservation.maximumVisualUsd === input.maximumVisualUsd
  );
}

function visualTotals(events: VisualModelCallUsageEvent[]): VisualUsageLedger["totals"] {
  let knownCostUsd = 0;
  let unknownCostCount = 0;
  for (const event of events) {
    if (event.cost.state === "known") {
      knownCostUsd += event.cost.usd;
      if (!Number.isFinite(knownCostUsd)) invalid("events", "known visual cost sum is not finite");
    } else unknownCostCount += 1;
  }
  return { modelCallsUsed: events.length, knownCostUsd, unknownCostCount };
}

function normalizeFence(value: unknown, field: string): Fence {
  if (!isRecord(value)) invalid(field, "expected an object");
  exactKeys(value, field, ["instanceId", "epoch"]);
  return {
    instanceId: identityString(value.instanceId, `${field}.instanceId`, 300),
    epoch: nonnegativeSafeInteger(value.epoch, `${field}.epoch`),
  };
}

function validatedVisualEvents(values: unknown, field: string): VisualModelCallUsageEvent[] {
  if (!Array.isArray(values)) invalid(field, "expected an array");
  const output: VisualModelCallUsageEvent[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < values.length; index++) {
    const value: unknown = values[index];
    if (!isRecord(value) || value.kind !== "visual-model-call") {
      invalid(`${field}[${index}]`, "expected a visual-model-call event");
    }
    const event = validateStoredVisualEvent(value, `${field}[${index}]`);
    if (ids.has(event.eventId)) invalid(field, `duplicate visual eventId ${event.eventId}`);
    ids.add(event.eventId);
    output.push(event);
  }
  return output;
}

function validateStoredVisualEvent(
  value: Record<string, unknown>,
  field: string,
): VisualModelCallUsageEvent {
  exactKeys(value, field, [
    "kind",
    "eventId",
    "callId",
    "inferenceCacheKey",
    "provider",
    "model",
    "resultState",
    "inputTokens",
    "outputTokens",
    "cost",
    "at",
  ]);
  const eventId = identityString(value.eventId, `${field}.eventId`, 200);
  const callId = identityString(value.callId, `${field}.callId`, 100);
  const inferenceCacheKey = identityString(value.inferenceCacheKey, `${field}.inferenceCacheKey`, 200);
  const expectedEventId = visualUsageEventId(callId, inferenceCacheKey);
  const eventMatch = EVENT_ID.exec(eventId);
  if (!eventMatch || eventId !== expectedEventId) {
    invalid(`${field}.eventId`, "does not match the event id derived from call/cache identity");
  }
  const at = identityString(value.at, `${field}.at`, 100);
  assertIsoTimestamp(at, `${field}.at`);
  return {
    kind: "visual-model-call",
    eventId,
    callId,
    inferenceCacheKey,
    provider: identityString(value.provider, `${field}.provider`, 200),
    model: identityString(value.model, `${field}.model`, 300),
    resultState: visualResultState(value.resultState, `${field}.resultState`),
    inputTokens: nullableTokenCount(value.inputTokens, `${field}.inputTokens`),
    outputTokens: nullableTokenCount(value.outputTokens, `${field}.outputTokens`),
    cost: normalizeVisualCost(value.cost, `${field}.cost`),
    at,
  };
}

/**
 * Prove that the frozen core counters are fully explained by fail-loud model-call events.
 * A version marker alone is not evidence: the event count and the same per-call upward
 * micro-dollar envelopes used by the writer must reconcile to the shared cap counters.
 */
function assertSharedModelUsageVerifiable(usage: Usage, eventId: string): void {
  if (usage.paidModelAccounting?.mode !== "fail-loud-v2-micro-ceiling") {
    throw new VisualUsageAdmissionRefused(
      "shared-ledger-unverifiable",
      eventId,
      "the core checkpoint predates conservative fail-loud paid model accounting",
    );
  }
  if (!Array.isArray(usage.events)) invalid("events", "expected an array");
  let modelCalls = 0;
  let costMicros = 0;
  for (let index = 0; index < usage.events.length; index += 1) {
    const event = usage.events[index];
    if (!isRecord(event)) invalid(`events[${index}]`, "expected an object");
    if (event.kind === "visual-model-call") {
      throw new VisualUsageAdmissionRefused(
        "shared-ledger-unverifiable",
        eventId,
        "the finalized core checkpoint is contaminated by post-run visual usage",
      );
    }
    if (event.kind === "browser-session") continue;
    if (event.kind !== "model-call") invalid(`events[${index}].kind`, "unknown usage event kind");
    exactKeys(event, `events[${index}]`, [
      "kind", "model", "inputTokens", "outputTokens", "costUsd", "at",
    ]);
    identityString(event.model, `events[${index}].model`, 300);
    nonnegativeSafeInteger(event.inputTokens, `events[${index}].inputTokens`);
    nonnegativeSafeInteger(event.outputTokens, `events[${index}].outputTokens`);
    const at = identityString(event.at, `events[${index}].at`, 100);
    assertIsoTimestamp(at, `events[${index}].at`);
    const eventCost = nonnegativeFinite(event.costUsd, `events[${index}].costUsd`);
    modelCalls += 1;
    const eventMicros = conservativeUsdMicros(eventCost, `events[${index}].costUsd`);
    if (costMicros > Number.MAX_SAFE_INTEGER - eventMicros) {
      invalid("events", "conservative micro-dollar sum exceeds the safe integer range");
    }
    costMicros += eventMicros;
  }
  const costUsd = costMicros / USD_MICRO_SCALE;
  if (modelCalls !== usage.modelCalls.used || costUsd !== usage.cost.usedUsd) {
    throw new VisualUsageAdmissionRefused(
      "shared-ledger-unverifiable",
      eventId,
      `core events explain ${modelCalls} call(s) and $${costUsd}, but counters report ` +
        `${usage.modelCalls.used} call(s) and $${usage.cost.usedUsd}`,
    );
  }
}

function assertUsageCounters(usage: Usage): void {
  if (!isRecord(usage)) invalid("ledger", "expected an object");
  if (!isRecord(usage.modelCalls)) invalid("modelCalls", "expected an object");
  nonnegativeSafeInteger(usage.modelCalls.used, "modelCalls.used");
  nonnegativeSafeInteger(usage.modelCalls.max, "modelCalls.max");
  if (!isRecord(usage.cost)) invalid("cost", "expected an object");
  nonnegativeFinite(usage.cost.usedUsd, "cost.usedUsd");
  nonnegativeFinite(usage.cost.maxUsd, "cost.maxUsd");
  nonnegativeFinite(usage.cost.verificationReserveUsd, "cost.verificationReserveUsd");
  nonnegativeFinite(usage.cost.reportReserveUsd, "cost.reportReserveUsd");
  if (!isRecord(usage.wallClock)) invalid("wallClock", "expected an object");
  nonnegativeSafeInteger(usage.wallClock.usedMilliseconds, "wallClock.usedMilliseconds");
  nonnegativeSafeInteger(usage.wallClock.maxMilliseconds, "wallClock.maxMilliseconds");
  nonnegativeSafeInteger(usage.wallClock.startedAtMs, "wallClock.startedAtMs");
}

function measuredWallClockMilliseconds(usage: Usage, nowMs: number): number {
  assertUsageCounters(usage);
  const evaluatedAtMs = nonnegativeSafeInteger(nowMs, "wallClock.evaluatedAtMs");
  const { startedAtMs, usedMilliseconds } = usage.wallClock;
  if (startedAtMs > evaluatedAtMs) {
    invalid("wallClock.startedAtMs", "cannot be later than the admission clock");
  }
  const elapsed = evaluatedAtMs - startedAtMs;
  const measured = Math.max(usedMilliseconds, elapsed);
  if (!Number.isSafeInteger(measured)) {
    invalid("wallClock.usedMilliseconds", "elapsed wall clock exceeds the safe integer range");
  }
  return measured;
}

function normalizeVisualCost(value: unknown, field: string): VisualUsageCost {
  if (!isRecord(value)) invalid(field, "expected a tagged cost object");
  if (value.state === "known") {
    exactKeys(value, field, ["state", "usd", "source"]);
    const source = identityString(value.source, `${field}.source`, 100);
    if (!KNOWN_COST_SOURCES.has(source)) invalid(`${field}.source`, "unknown known-cost source");
    return {
      state: "known",
      usd: nonnegativeFinite(value.usd, `${field}.usd`),
      source: source as "provider-reported" | "gateway-reported" | "configured-rate",
    };
  }
  if (value.state === "unknown") {
    exactKeys(value, field, ["state", "reason"]);
    const reason = identityString(value.reason, `${field}.reason`, 100);
    if (!UNKNOWN_COST_REASONS.has(reason)) invalid(`${field}.reason`, "unknown unknown-cost reason");
    return {
      state: "unknown",
      reason: reason as "provider-not-reported" | "transport-no-cost-telemetry" | "attempt-outcome-uncertain",
    };
  }
  invalid(`${field}.state`, "expected known or unknown");
}

function sameVisualCharge(a: VisualModelCallUsageEvent, b: VisualModelCallUsageEvent): boolean {
  return (
    a.eventId === b.eventId &&
    a.callId === b.callId &&
    a.inferenceCacheKey === b.inferenceCacheKey &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.resultState === b.resultState &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    JSON.stringify(a.cost) === JSON.stringify(b.cost)
  );
}

function visualResultState(value: unknown, field: string): VisualUsageResultState {
  const state = identityString(value, field, 30);
  if (!VISUAL_RESULT_STATES.has(state)) invalid(field, "unknown visual result state");
  return state as VisualUsageResultState;
}

function nullableTokenCount(value: unknown, field: string): number | null {
  return value === null ? null : nonnegativeSafeInteger(value, field);
}

/** One paid call consumes every micro-dollar it touches; positive tails always round upward. */
function conservativeUsdMicros(value: unknown, field: string): number {
  const usd = nonnegativeFinite(value, field);
  const scaled = usd * USD_MICRO_SCALE;
  if (!Number.isFinite(scaled) || scaled > Number.MAX_SAFE_INTEGER) {
    invalid(field, "cannot be represented as safe conservative micro-dollars");
  }
  const micros = Math.ceil(scaled);
  if (!Number.isSafeInteger(micros) || micros < 0) {
    invalid(field, "conservative micro-dollar charge is outside the safe integer range");
  }
  return micros;
}

/** Stored cap counters are whole micro-dollar envelopes, serialized as USD for API clarity. */
function storedConservativeUsdMicros(value: unknown, field: string): number {
  const usd = nonnegativeFinite(value, field);
  const scaled = usd * USD_MICRO_SCALE;
  if (!Number.isFinite(scaled) || scaled > Number.MAX_SAFE_INTEGER) {
    invalid(field, "cannot be represented as safe conservative micro-dollars");
  }
  const micros = Math.round(scaled);
  if (!Number.isSafeInteger(micros) || micros / USD_MICRO_SCALE !== usd) {
    invalid(field, "must be a whole conservative micro-dollar amount");
  }
  return micros;
}

function nonnegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(field, "expected a non-negative safe integer");
  }
  return value;
}

function nonnegativeFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalid(field, "expected a finite non-negative number");
  }
  return value;
}

function identityString(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid(field, `expected a trimmed identity string of 1..${max} characters`);
  }
  return value;
}

function assertIsoTimestamp(value: string, field: string): void {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    invalid(field, "expected a canonical ISO-8601 timestamp");
  }
}

function exactKeys(value: Record<string, unknown>, field: string, keys: string[]): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) invalid(field, `unknown field ${JSON.stringify(key)}`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) invalid(field, `missing field ${JSON.stringify(key)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(field: string, detail: string): never {
  throw new VisualUsageValidationError(field, detail);
}

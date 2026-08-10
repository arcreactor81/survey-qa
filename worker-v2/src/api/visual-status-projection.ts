/**
 * Read-only projection of the isolated visual shadow channel.
 *
 * This endpoint is deliberately outside every verifier, judgement, record, and report path.
 * It only re-reads durable visual control-plane artifacts and reports whether each surface was
 * actually inspected. It never turns a visual observation into a survey verdict.
 */

import type { Env } from "../types/env";
import type { RunCheckpoint } from "../types/contracts";
import { visualManifestKey, visualUsageLedgerKey } from "../keys";
import { canonicalHash } from "../store/hash";
import {
  readVisualLaunchMarker,
  VISUAL_LAUNCH_MARKER_STATES,
  type VisualLaunchMarker,
  type VisualLaunchMarkerState,
} from "../store/visual-launch";
import { readVisualWorkManifest, type VisualWorkManifest } from "../store/visual-work";
import {
  deriveVisualCoverageDenominator,
  readVisualCoverageIndex,
  readVisualCoveragePointer,
  visualCoveragePointerKey,
  type VisualCoverageIndex,
  type VisualCoveragePointer,
} from "../store/visual-coverage";
import {
  readVisualProgress,
  readVisualProgressHeadByIdentity,
  visualProgressExpectation,
  visualProgressPointerKey,
  type VisualProgressSnapshot,
} from "../store/visual-progress";
import {
  readVisualTerminalStatusFromPointer,
  visualTerminalStatusPointerKey,
  type VisualTerminalStatus,
  type VisualTerminalStatusPointer,
} from "../store/visual-status";
import { readVisualUsageLedger } from "../store/usage";
import {
  VisualRolloutConfigurationError,
  visualShadowConfiguration,
  type VisualShadowConfiguration,
} from "../vision/config";
import { visualShadowWorkflowInstanceId } from "../workflow/visual-shadow-workflow";

export const VISUAL_STATUS_SCHEMA_VERSION = "survey-qa-visual-status/1.0.0" as const;

const ENGINE_STATES = [
  "queued",
  "running",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
  "waitingForPause",
  "unknown",
] as const;

type VisualEngineState = (typeof ENGINE_STATES)[number];

type NotInspected = {
  state: "not-inspected";
  reason: "ownership-unclaimed" | "plan-not-created" | "core-report-not-finalized" | "work-manifest-absent";
};

export interface VisualStatusProjection {
  schemaVersion: typeof VISUAL_STATUS_SCHEMA_VERSION;
  kind: "survey-qa-visual-status";
  channel: "observation-only-non-verdict";
  runId: string;
  sourceCheckpoint: { revision: number; observedAt: string };
  configuration:
    | { state: "disabled" }
    | {
        state: "enabled";
        provider: string;
        maximumCalls: number;
        maximumUsd: number;
        maximumWaves: number;
      }
    | { state: "invalid"; detail: string };
  currentIdentity:
    | { state: "unavailable"; reason: NotInspected["reason"] }
    | {
        state: "available";
        planRevisionId: string;
        workflowInstanceId: string;
        ownership: { instanceId: string; epoch: number };
      };
  launch:
    | NotInspected
    | {
        state:
          | "not-recorded"
          | "intent-recorded"
          | "accepted-not-started"
          | "started"
          | "unresolved";
        workflowInstanceId: string;
        /** Every receipt remains visible even when a later receipt has higher precedence. */
        markers: Record<VisualLaunchMarkerState, string | null>;
      };
  childEngine:
    | NotInspected
    | { state: "not-queried"; reason: "no-launch-receipt" | "durable-result-present" }
    | { state: "available"; status: VisualEngineState; errorReported: boolean }
    | { state: "unavailable" };
  work:
    | NotInspected
    | { state: "absent"; key: string }
    | {
        state: "available";
        manifest: { key: string; contentSha256: string };
        denominatorItems: number;
        totals: VisualWorkManifest["totals"];
      };
  usage:
    | NotInspected
    | { state: "absent"; key: string }
    | {
        state: "available";
        key: string;
        revision: number;
        ownership: { instanceId: string; epoch: number };
        committedCalls: number;
        knownCostUsd: number;
        unknownCostCount: number;
        reservation:
          | { state: "none" }
          | { state: "active"; eventId: string; maximumCostUsd: number; reservedAt: string };
      };
  progress:
    | NotInspected
    | { state: "absent"; pointerKey: string; processedItems: 0; denominatorItems: number }
    | {
        state: "in-progress" | "denominator-processed";
        pointerKey: string;
        stateRef: { key: string; contentSha256: string };
        processedItems: number;
        denominatorItems: number;
        completedWaves: number;
        ownership: { instanceId: string; epoch: number };
        purchaseChannel: VisualProgressSnapshot["state"]["purchaseChannel"];
      }
    | { state: "not-inspected"; reason: "coverage-finalized" | NotInspected["reason"] };
  terminal:
    | NotInspected
    | { state: "absent"; pointerKey: string }
    | {
        state: "limitation";
        pointerKey: string;
        statusRef: { key: string; contentSha256: string };
        finalizedAt: string;
        phase: VisualTerminalStatus["phase"];
        reason: VisualTerminalStatus["reason"];
        detail: string;
        workManifest: VisualTerminalStatus["workManifest"];
        coverageIndex: VisualTerminalStatus["coverageIndex"];
        inferenceFingerprintSha256: string | null;
        authorizationFingerprintSha256: string | null;
      };
  coverage:
    | NotInspected
    | { state: "absent"; pointerKey: string }
    | {
        state: "finalized";
        pointerKey: string;
        coverageRef: { key: string; contentSha256: string };
        finalizedAt: string;
        totals: VisualCoverageIndex["totals"];
        successfulDataManifest: VisualCoveragePointer["successfulDataManifest"];
      };
}

export class VisualStatusProjectionCorruptionError extends Error {
  constructor(detail: string) {
    super(`visual status projection is inconsistent: ${detail}`);
    this.name = "VisualStatusProjectionCorruptionError";
  }
}

/**
 * Re-read the current ownership channel. No result is inferred from an absent object: every
 * uninspected or absent surface has a distinct state in the returned closed projection.
 */
export async function projectVisualStatus(
  env: Env,
  checkpoint: RunCheckpoint,
): Promise<VisualStatusProjection> {
  const configuration = configurationStatus(env);
  const base = {
    schemaVersion: VISUAL_STATUS_SCHEMA_VERSION,
    kind: "survey-qa-visual-status" as const,
    channel: "observation-only-non-verdict" as const,
    runId: checkpoint.runId,
    sourceCheckpoint: { revision: checkpoint.revision, observedAt: checkpoint.observedAt },
    configuration,
  };

  const unavailableReason = identityUnavailableReason(checkpoint);
  if (unavailableReason !== null) {
    const notInspected: NotInspected = { state: "not-inspected", reason: unavailableReason };
    return {
      ...base,
      currentIdentity: { state: "unavailable", reason: unavailableReason },
      launch: notInspected,
      childEngine: notInspected,
      work: notInspected,
      usage: notInspected,
      progress: notInspected,
      terminal: notInspected,
      coverage: notInspected,
    };
  }

  const ownership = checkpoint.ownership!;
  const planRevisionId = checkpoint.execution!.planRevisionId!;
  const fence = { instanceId: ownership.instanceId, epoch: ownership.epoch };
  const workflowInstanceId = visualShadowWorkflowInstanceId(checkpoint.runId, fence);
  const currentIdentity = {
    state: "available" as const,
    planRevisionId,
    workflowInstanceId,
    ownership: fence,
  };

  const usageKey = visualUsageLedgerKey(checkpoint.runId);
  const visualUsage = await readVisualUsageLedger(env.EVIDENCE, checkpoint.runId);
  const usage: VisualStatusProjection["usage"] = visualUsage === null
    ? { state: "absent", key: usageKey }
    : {
        state: "available",
        key: usageKey,
        revision: visualUsage.revision,
        ownership: visualUsage.ownership,
        committedCalls: visualUsage.totals.modelCallsUsed,
        knownCostUsd: visualUsage.totals.knownCostUsd,
        unknownCostCount: visualUsage.totals.unknownCostCount,
        reservation: visualUsage.reservation === null
          ? { state: "none" }
          : {
              state: "active",
              eventId: visualUsage.reservation.eventId,
              maximumCostUsd: visualUsage.reservation.maximumCostUsd,
              reservedAt: visualUsage.reservation.reservedAt,
            },
      };

  const markerRows = await Promise.all(
    VISUAL_LAUNCH_MARKER_STATES.map(async (state) =>
      readVisualLaunchMarker(env.EVIDENCE, {
        state,
        runId: checkpoint.runId,
        planRevisionId,
        workflowInstanceId,
        ownership: fence,
      }),
    ),
  );
  const markers = Object.fromEntries(
    VISUAL_LAUNCH_MARKER_STATES.map((state, index) => [state, markerRows[index]?.recordedAt ?? null]),
  ) as Record<VisualLaunchMarkerState, string | null>;
  assertLaunchReceiptOrder(markerRows);
  const launch = {
    state: launchState(markerRows),
    workflowInstanceId,
    markers,
  } satisfies Exclude<VisualStatusProjection["launch"], NotInspected>;

  const workKey = visualManifestKey(checkpoint.runId);
  const workManifest = await readVisualWorkManifest(env.EVIDENCE, workKey, {
    runId: checkpoint.runId,
    planRevisionId,
  });
  const workSha256 = workManifest === null ? null : await canonicalHash(workManifest);
  const denominator = workManifest === null ? null : await deriveVisualCoverageDenominator(workManifest);
  const work: VisualStatusProjection["work"] =
    workManifest === null
      ? { state: "absent", key: workKey }
      : {
          state: "available",
          manifest: { key: workKey, contentSha256: workSha256! },
          denominatorItems: denominator!.length,
          totals: workManifest.totals,
        };

  // Coverage is read before a terminal limitation. A malformed final coverage pointer/index
  // must never disappear behind an older limitation pointer.
  const coveragePointer = await readVisualCoveragePointer(env.EVIDENCE, checkpoint.runId, {
    runId: checkpoint.runId,
    planRevisionId,
    ...(workSha256 === null ? {} : { visualWorkManifestSha256: workSha256 }),
  });
  let coverageIndex: VisualCoverageIndex | null = null;
  if (coveragePointer !== null) {
    if (workManifest === null || workSha256 === null || denominator === null) {
      corrupt("a finalized coverage pointer exists but its exact work manifest is absent");
    }
    coverageIndex = await readVisualCoverageIndex(
      env.EVIDENCE,
      checkpoint.runId,
      coveragePointer.coverage.contentSha256,
      workManifest,
      {
        runId: checkpoint.runId,
        planRevisionId,
        visualWorkManifestSha256: workSha256,
        inferenceFingerprintSha256: coveragePointer.inferenceFingerprintSha256,
        authorizationFingerprintSha256: coveragePointer.authorizationFingerprintSha256,
      },
    );
    if (coverageIndex === null) corrupt("the finalized coverage pointer target is absent");
    if (coverageIndex.totals.denominatorItems !== denominator.length) {
      corrupt("finalized coverage does not close the exact current work denominator");
    }
  }
  const coverage: VisualStatusProjection["coverage"] =
    coveragePointer === null
      ? { state: "absent", pointerKey: visualCoveragePointerKey(checkpoint.runId) }
      : {
          state: "finalized",
          pointerKey: visualCoveragePointerKey(checkpoint.runId),
          coverageRef: coveragePointer.coverage,
          finalizedAt: coverageIndex!.finalizedAt,
          totals: coverageIndex!.totals,
          successfulDataManifest: coveragePointer.successfulDataManifest,
        };

  const terminalResult = await readVisualTerminalStatusFromPointer(env.EVIDENCE, checkpoint.runId, {
    runId: checkpoint.runId,
    planRevisionId,
  });
  if (terminalResult !== null) {
    await verifyTerminalReferences(
      env,
      terminalResult.pointer,
      workManifest,
      workSha256,
      coveragePointer,
      coverageIndex,
    );
  }
  const terminal: VisualStatusProjection["terminal"] =
    terminalResult === null
      ? { state: "absent", pointerKey: visualTerminalStatusPointerKey(checkpoint.runId) }
      : terminalProjection(terminalResult.pointer, terminalResult.status);

  let progress: VisualStatusProjection["progress"];
  if (coverageIndex !== null) {
    progress = { state: "not-inspected", reason: "coverage-finalized" };
  } else if (workManifest === null || workSha256 === null || denominator === null) {
    progress = { state: "not-inspected", reason: "work-manifest-absent" };
  } else {
    const head = await readVisualProgressHeadByIdentity(env.EVIDENCE, {
      runId: checkpoint.runId,
      planRevisionId,
      visualWorkManifestSha256: workSha256,
      denominatorItemCount: denominator.length,
    });
    if (head === null) {
      progress = {
        state: "absent",
        pointerKey: visualProgressPointerKey(checkpoint.runId),
        processedItems: 0,
        denominatorItems: denominator.length,
      };
    } else {
      // The head alone is not enough to claim an exact count. This full reader verifies every
      // predecessor state and contiguous wave shard before nextDenominatorOrdinal is exposed.
      const snapshot = await readVisualProgress(env.EVIDENCE, visualProgressExpectation(head));
      if (snapshot === null) corrupt("the visual progress head disappeared during full-history verification");
      const processedItems = snapshot.state.nextDenominatorOrdinal;
      progress = {
        state: processedItems === denominator.length ? "denominator-processed" : "in-progress",
        pointerKey: visualProgressPointerKey(checkpoint.runId),
        stateRef: snapshot.stateRef,
        processedItems,
        denominatorItems: denominator.length,
        completedWaves: snapshot.state.completedWaveCount,
        ownership: snapshot.state.ownership,
        purchaseChannel: snapshot.state.purchaseChannel,
      };
    }
  }

  const durableResultPresent = coverageIndex !== null || terminalResult !== null;
  const anyLaunchReceipt = markerRows.some((marker) => marker !== null);
  const childEngine = durableResultPresent
    ? ({ state: "not-queried", reason: "durable-result-present" } as const)
    : !anyLaunchReceipt
      ? ({ state: "not-queried", reason: "no-launch-receipt" } as const)
      : await readChildEngineStatus(env, workflowInstanceId);

  return {
    ...base,
    currentIdentity,
    launch,
    childEngine,
    work,
    usage,
    progress,
    terminal,
    coverage,
  };
}

function configurationStatus(env: Env): VisualStatusProjection["configuration"] {
  let configuration: VisualShadowConfiguration;
  try {
    configuration = visualShadowConfiguration(env);
  } catch (error) {
    if (error instanceof VisualRolloutConfigurationError) {
      return { state: "invalid", detail: error.message.slice(0, 500) };
    }
    throw error;
  }
  if (!configuration.enabled) return { state: "disabled" };
  return {
    state: "enabled",
    provider: configuration.provider,
    maximumCalls: configuration.maximumCalls,
    maximumUsd: configuration.maximumUsd,
    maximumWaves: configuration.maximumWaves,
  };
}

function identityUnavailableReason(checkpoint: RunCheckpoint): NotInspected["reason"] | null {
  if (checkpoint.ownership === null) return "ownership-unclaimed";
  if (checkpoint.execution === null || checkpoint.execution.planRevisionId === null) return "plan-not-created";
  if (!checkpoint.reportAvailable) return "core-report-not-finalized";
  return null;
}

function assertLaunchReceiptOrder(markers: readonly (VisualLaunchMarker | null)[]): void {
  const byState = new Map<VisualLaunchMarkerState, VisualLaunchMarker | null>(
    VISUAL_LAUNCH_MARKER_STATES.map((state, index) => [state, markers[index] ?? null]),
  );
  const intent = byState.get("intent") ?? null;
  const accepted = byState.get("accepted") ?? null;
  const started = byState.get("started") ?? null;
  if ((accepted !== null || started !== null) && intent === null) {
    corrupt("an accepted or started launch receipt exists without its earlier durable intent receipt");
  }
  if (intent !== null && accepted !== null && Date.parse(accepted.recordedAt) < Date.parse(intent.recordedAt)) {
    corrupt("the accepted launch receipt predates intent");
  }
  // A child may start after the binding accepted it but before the parent persisted `accepted`,
  // so `started` without an accepted receipt is legitimate. It still cannot predate intent.
  if (intent !== null && started !== null && Date.parse(started.recordedAt) < Date.parse(intent.recordedAt)) {
    corrupt("the child-start receipt predates launch intent");
  }
}

function launchState(markers: readonly (VisualLaunchMarker | null)[]): Exclude<VisualStatusProjection["launch"], NotInspected>["state"] {
  const byState = new Map<VisualLaunchMarkerState, VisualLaunchMarker | null>(
    VISUAL_LAUNCH_MARKER_STATES.map((state, index) => [state, markers[index] ?? null]),
  );
  if (byState.get("started") !== null) return "started";
  // Preserve uncertainty over acceptance: unresolved outranks an accepted parent receipt when no
  // child-start proof exists, while both timestamps remain present in `markers`.
  if (byState.get("unresolved") !== null) return "unresolved";
  if (byState.get("accepted") !== null) return "accepted-not-started";
  if (byState.get("intent") !== null) return "intent-recorded";
  return "not-recorded";
}

async function verifyTerminalReferences(
  env: Env,
  pointer: VisualTerminalStatusPointer,
  work: VisualWorkManifest | null,
  workSha256: string | null,
  coveragePointer: VisualCoveragePointer | null,
  coverageIndex: VisualCoverageIndex | null,
): Promise<void> {
  if (pointer.workManifest !== null) {
    if (work === null || workSha256 === null) corrupt("terminal status cites an absent work manifest");
    if (pointer.workManifest.contentSha256 !== workSha256) {
      corrupt("terminal status cites a work manifest other than the exact current denominator");
    }
  }
  if (pointer.coverageIndex !== null) {
    if (work === null) corrupt("terminal status cites coverage but its work manifest is absent");
    if (
      coveragePointer !== null &&
      coveragePointer.coverage.contentSha256 === pointer.coverageIndex.contentSha256 &&
      coverageIndex !== null
    ) return;
    const cited = await readVisualCoverageIndex(
      env.EVIDENCE,
      pointer.runId,
      pointer.coverageIndex.contentSha256,
      work,
      { runId: pointer.runId, planRevisionId: pointer.planRevisionId },
    );
    if (cited === null) corrupt("terminal status cites an absent coverage index");
  }
}

function terminalProjection(
  pointer: VisualTerminalStatusPointer,
  status: VisualTerminalStatus,
): Extract<VisualStatusProjection["terminal"], { state: "limitation" }> {
  return {
    state: "limitation",
    pointerKey: visualTerminalStatusPointerKey(pointer.runId),
    statusRef: pointer.status,
    finalizedAt: status.finalizedAt,
    phase: status.phase,
    reason: status.reason,
    detail: status.detail,
    workManifest: status.workManifest,
    coverageIndex: status.coverageIndex,
    inferenceFingerprintSha256: status.inferenceFingerprintSha256,
    authorizationFingerprintSha256: status.authorizationFingerprintSha256,
  };
}

async function readChildEngineStatus(
  env: Env,
  workflowInstanceId: string,
): Promise<VisualStatusProjection["childEngine"]> {
  try {
    const instance = await env.V2_VISUAL_WORKFLOW.get(workflowInstanceId);
    const status = await instance.status();
    if (!ENGINE_STATES.includes(status.status as VisualEngineState)) {
      return { state: "unavailable" };
    }
    return {
      state: "available",
      status: status.status as VisualEngineState,
      errorReported: status.error !== undefined,
    };
  } catch {
    // A missing/expired engine record is not proof that the durable launch or result artifacts
    // never existed. Keep the control-plane read visibly unavailable without erasing them.
    return { state: "unavailable" };
  }
}

export function isVisualStatusCorruption(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return [
    "VisualStatusProjectionCorruptionError",
    "VisualLaunchMarkerCorruptionError",
    "VisualWorkCorruptError",
    "VisualCoverageCorruptionError",
    "VisualProgressCorruptionError",
    "VisualTerminalStatusCorruptionError",
    "VisualUsageLedgerCorruptionError",
  ].includes(error.name);
}

function corrupt(detail: string): never {
  throw new VisualStatusProjectionCorruptionError(detail);
}

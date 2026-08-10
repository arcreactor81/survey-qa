/**
 * SERIAL, DURABLE VISUAL SHADOW ORCHESTRATION.
 *
 * This channel is deliberately inserted after observation projection and before verification,
 * but none of its outputs are arguments to verification, derivation, record assembly, or
 * reporting. It inventories screenshot pixels in shadow mode, closes its own denominator, and
 * may fail only into a named visual terminal limitation. Ownership loss is the sole exception:
 * an obsolete Workflow instance must stop immediately rather than publish over its replacement.
 */

import type { WorkflowStep } from "cloudflare:workers";
import { visualManifestKey } from "../../keys";
import { loadCheckpoint, type Fence } from "../../store/checkpoint";
import { canonicalHash, canonicalJson } from "../../store/hash";
import {
  createDisabledVisualInferenceFingerprint,
  deriveVisualCoverageDenominator,
  finalizeVisualCoverageIndex,
  prepareVisualCoverageIndex,
  readVisualCoverageIndex,
  readVisualCoveragePointer,
  visualCoveragePointerKey,
  type VisualCoverageAuthorization,
  type VisualCoverageIndex,
  type VisualInferenceFingerprint,
} from "../../store/visual-coverage";
import {
  appendVisualProgressWave,
  initializeVisualProgress,
  readVisualProgress,
  readVisualProgressHead,
  visualProgressCursor,
  visualProgressExpectation,
  type VisualProgressAuthoritySeal,
  type VisualProgressExpected,
  type VisualProgressHead,
  type VisualProgressIdentityExpected,
  type VisualProgressItem,
  type VisualProgressPurchaseChannel,
  type VisualProgressRolloutSeal,
  type VisualProgressSnapshot,
} from "../../store/visual-progress";
import {
  finalizeVisualTerminalStatus,
  prepareVisualTerminalStatus,
  readVisualTerminalStatusFromPointer,
  type VisualTerminalReason,
  type VisualTerminalStatusPointer,
} from "../../store/visual-status";
import {
  VisualStorageCorruptionError,
  VisualStorageImmutabilityError,
  VisualStorageValidationError,
} from "../../store/vision";
import {
  readVisualWorkManifest,
  VisualWorkCapacityExceededError,
  type VisualWorkEpochRow,
  type VisualWorkManifest,
} from "../../store/visual-work";
import {
  VisualUsageAdmissionRefused,
  VisualUsageCheckpointMissing,
  VisualUsageIdentityConflict,
  VisualUsageReservationConflict,
  VisualUsageValidationError,
} from "../../store/usage";
import { OwnershipLost } from "../../types/contracts";
import type { Env } from "../../types/env";
import {
  VisualRolloutConfigurationError,
  resolveVisualProvider,
  visualShadowConfiguration,
  visualShadowConfigurationSha256,
  visualShadowRawConfigurationSha256,
  visualShadowStepTimeoutMs,
  type ResolvedVisualProvider,
} from "../../vision/config";
import { VisualInferencePurchaseBlockedError } from "../../vision/durable-client";
import {
  VisualObservationPersistenceError,
  visualPromptSha256,
  visualResponseSchemaSha256,
} from "../../vision/observe";
import { VISUAL_PROMPT_VERSION, VISUAL_RESPONSE_SCHEMA_VERSION } from "../../vision/schema";
import { prepareVisualPerceptionWork } from "./visual-perception";
import {
  closeVisualCoverageEntries,
  visualProcessedItemFromEpochResult,
  visualProcessedLimitationItem,
  visualProcessedMechanicalItem,
  type VisualCoverageRemainderPosture,
} from "./visual-coverage-closure";
import { processVisualEpoch, VisualEpochProcessingError } from "./visual-epoch";

const VISUAL_DETERMINISTIC_POLICY = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "30 minutes",
} as const;
const VISUAL_WAVE_RETRY_POLICY = { retries: { limit: 1, delay: "30 seconds" } } as const;

/** Keeps one paid wave comfortably below the invocation's subrequest envelope. */
export const VISUAL_SHADOW_MAX_DENOMINATOR_ITEMS_PER_WAVE = 100;

export interface VisualShadowWorkflowInput {
  env: Env;
  step: WorkflowStep;
  runId: string;
  planRevisionId: string;
  fence: Fence;
}

export type VisualShadowWorkflowResult =
  | {
      state: "coverage-finalized";
      coverageKey: string;
      pointerKey: string;
      coverageSha256: string;
      totals: VisualCoverageIndex["totals"];
    }
  | {
      state: "terminal-limitation";
      reason: VisualTerminalReason | "VISUAL_STATUS_PERSISTENCE_FAILED";
      statusPointerKey: string | null;
    };

interface AuthorityCandidate {
  rollout: VisualProgressRolloutSeal;
  inference: VisualInferenceFingerprint;
  authorization: VisualCoverageAuthorization;
}

interface ResolvedAuthorityCandidate extends AuthorityCandidate {
  resolved: ResolvedVisualProvider | null;
}

interface CompactProgress {
  identity: VisualProgressIdentityExpected;
  expected: VisualProgressExpected;
  cursor: ReturnType<typeof visualProgressCursor>;
  purchaseChannel: VisualProgressPurchaseChannel;
  authority: VisualProgressAuthoritySeal;
  authorityDrift: boolean;
}

type VisualPhase =
  | "work-preparation"
  | "rollout-initialization"
  | "wave-orchestration"
  | "coverage-finalization";
type VisualDenominator = Awaited<ReturnType<typeof deriveVisualCoverageDenominator>>;
type VisualEpochDenominatorItem = Extract<VisualDenominator[number], { kind: "epoch" }>;

/** Main entry called by the run Workflow. Every `step.do` remains a direct member call. */
export async function runVisualShadowWorkflow(
  input: VisualShadowWorkflowInput,
): Promise<VisualShadowWorkflowResult> {
  let phase: VisualPhase = "work-preparation";
  let recoveryIdentity: VisualProgressIdentityExpected | null = null;
  let recoveryProgress: CompactProgress | null = null;
  try {
    const preparation = await input.step.do(
      "prepare-visual-work-v1",
      VISUAL_DETERMINISTIC_POLICY,
      async () => {
        await assertCurrentOwner(input.env, input.runId, input.fence);
        return prepareVisualPerceptionWork(input.env, input.runId);
      },
    );
    if (preparation.state !== "evaluated") {
      const capacityExceeded = preparation.reason === "VISUAL_WORK_CAPACITY_EXCEEDED";
      return await persistTerminalLimitation(input, {
        phase: "work-preparation",
        reason: capacityExceeded
          ? "VISUAL_WORK_CAPACITY_EXCEEDED"
          : "VISUAL_WALK_ARTIFACT_INDEX_MISSING",
        detail: capacityExceeded
          ? preparation.detail
          : "The strict execution-walk artifact index is absent; visual coverage is unknown and no visual call was authorized.",
      });
    }

    const identity = await input.step.do(
      "visual-shadow-work-identity-v1",
      VISUAL_DETERMINISTIC_POLICY,
      async (): Promise<VisualProgressIdentityExpected> => {
        await assertCurrentOwner(input.env, input.runId, input.fence);
        const work = await readExactWorkManifest(
          input.env,
          input.runId,
          input.planRevisionId,
          preparation.value.manifestSha256,
        );
        const denominator = await deriveVisualCoverageDenominator(work);
        return {
          runId: input.runId,
          planRevisionId: input.planRevisionId,
          visualWorkManifestSha256: preparation.value.manifestSha256,
          denominatorItemCount: denominator.length,
        };
      },
    );
    recoveryIdentity = identity;

    const existingCoverage = await input.step.do(
      "visual-shadow-existing-coverage-v1",
      VISUAL_DETERMINISTIC_POLICY,
      async () => {
        await assertCurrentOwner(input.env, input.runId, input.fence);
        return readExistingCoverage(input.env, identity);
      },
    );
    if (existingCoverage !== null) return existingCoverage;

    // A valid closed coverage index is monotonic and wins over an older limitation. Only after
    // proving no coverage pointer exists may a fixed terminal status stop this child.
    const priorStatus = await input.step.do(
      "visual-shadow-existing-terminal-v1",
      VISUAL_DETERMINISTIC_POLICY,
      async () => {
        await assertCurrentOwner(input.env, input.runId, input.fence);
        return readVisualTerminalStatusFromPointer(input.env.EVIDENCE, input.runId, {
          runId: input.runId,
          planRevisionId: input.planRevisionId,
        });
      },
    );
    if (priorStatus !== null) return terminalResult(priorStatus.pointer);

    phase = "rollout-initialization";
    const currentAuthority = await input.step.do(
      "visual-shadow-authority-v1",
      VISUAL_DETERMINISTIC_POLICY,
      async () => {
        await assertCurrentOwner(input.env, input.runId, input.fence);
        const current = await resolveAuthorityCandidate(input.env);
        return authorityWithoutClient(current);
      },
    );

    let progress = await input.step.do(
      "initialize-visual-shadow-v1",
      VISUAL_DETERMINISTIC_POLICY,
      async () => {
        await assertCurrentOwner(input.env, input.runId, input.fence);
        const initialized = await initializeVisualProgress(input.env, {
          ...identity,
          ...currentAuthority,
          ownership: { ...input.fence },
        });
        return compactProgress(initialized.head, currentAuthority);
      },
    );
    recoveryProgress = progress;

    phase = "wave-orchestration";
    const sealedRollout = progress.authority.rollout;
    if (
      sealedRollout.state === "valid" &&
      sealedRollout.configuration.enabled &&
      progress.authority.authorization.state === "authorized" &&
      !progress.authorityDrift
    ) {
      const remainingWaves = Math.max(
        0,
        sealedRollout.configuration.maximumWaves - progress.cursor.completedWaveCount,
      );
      for (let workflowWave = 0; workflowWave < remainingWaves; workflowWave += 1) {
        if (
          progress.cursor.nextDenominatorOrdinal >= progress.identity.denominatorItemCount ||
          progress.purchaseChannel.state !== "open" ||
          progress.authorityDrift
        ) break;
        const before = progress.cursor.nextDenominatorOrdinal;
        const waveOrdinal = progress.cursor.completedWaveCount;
        progress = await input.step.do(
          `visual-shadow-wave-v1-${waveOrdinal}`,
          {
            ...VISUAL_WAVE_RETRY_POLICY,
            timeout: visualShadowStepTimeoutMs(sealedRollout.configuration),
          },
          async () => runVisualWave(input, progress),
        );
        recoveryProgress = progress;
        if (progress.cursor.nextDenominatorOrdinal <= before) break;
      }
    }

    phase = "coverage-finalization";
    return await input.step.do(
      "finalize-visual-shadow-coverage-v1",
      VISUAL_DETERMINISTIC_POLICY,
      async () => finalizeCoverage(input, progress),
    );
  } catch (error) {
    if (error instanceof OwnershipLost) throw error;
    if (phase === "coverage-finalization" && recoveryIdentity !== null) {
      try {
        const recovered = await input.step.do(
          "recover-finalized-visual-shadow-coverage-v1",
          VISUAL_DETERMINISTIC_POLICY,
          async () => {
            await assertCurrentOwner(input.env, input.runId, input.fence);
            return readExistingCoverage(input.env, recoveryIdentity!);
          },
        );
        if (recovered !== null) return recovered;
      } catch (recoveryError) {
        if (recoveryError instanceof OwnershipLost) throw recoveryError;
      }
    }
    return await persistTerminalLimitation(
      input,
      terminalForFailure(phase, error),
      { identity: recoveryIdentity, progress: recoveryProgress },
    );
  }
}

async function runVisualWave(
  input: VisualShadowWorkflowInput,
  supplied: CompactProgress,
): Promise<CompactProgress> {
  await assertCurrentOwner(input.env, input.runId, input.fence);
  const head = await readVisualProgressHead(input.env.EVIDENCE, supplied.expected);
  if (head === null) throw new Error("visual progress disappeared before a wave");
  const liveCursor = visualProgressCursor(head);
  if (canonicalJson(liveCursor) !== canonicalJson(supplied.cursor)) {
    // Lost Workflow-step response after a successful append: the fixed head is the winner.
    const recovered = compactProgress(head, authorityFromSeal(head.authority));
    return { ...recovered, authorityDrift: supplied.authorityDrift };
  }
  if (
    liveCursor.nextDenominatorOrdinal >= supplied.identity.denominatorItemCount ||
    head.state.purchaseChannel.state !== "open"
  ) return compactProgress(head, authorityFromSeal(head.authority));

  const work = await readExactWorkManifest(
    input.env,
    input.runId,
    input.planRevisionId,
    supplied.identity.visualWorkManifestSha256,
  );
  const denominator = await deriveVisualCoverageDenominator(work);
  if (denominator.length !== supplied.identity.denominatorItemCount) {
    throw new Error("visual denominator count drifted before a wave");
  }

  const current = await resolveAuthorityCandidate(input.env);
  const currentPlain = authorityWithoutClient(current);
  if (!authorityMatches(head.authority, currentPlain) || current.resolved === null) {
    const appended = await appendConfigurationDrift(input, head, denominator);
    return compactProgress(appended, currentPlain);
  }

  const configuration = head.authority.rollout;
  if (configuration.state !== "valid" || !configuration.configuration.enabled) {
    throw new Error("authorized visual progress does not carry an enabled rollout");
  }
  const deadlineMs = Date.now() + configuration.configuration.waveBudgetMs;
  const epochByOrdinal = new Map<string, VisualWorkEpochRow>();
  for (const row of work.epochs) epochByOrdinal.set(epochKey(row.walkOrdinal, row.epochOrdinal), row);

  const items: VisualProgressItem[] = [];
  let channel: VisualProgressPurchaseChannel = head.state.purchaseChannel;
  for (
    let ordinal = liveCursor.nextDenominatorOrdinal;
    ordinal < denominator.length && items.length < VISUAL_SHADOW_MAX_DENOMINATOR_ITEMS_PER_WAVE;
    ordinal += 1
  ) {
    const item = denominator[ordinal]!;
    if (item.kind !== "epoch" || item.eligibility !== "eligible") {
      items.push(visualProcessedMechanicalItem(ordinal, item));
      continue;
    }
    // Never strand an empty wave at the time boundary: if this is the first item, starting the
    // one serial call is still within the budget whose clock began immediately above.
    if (items.length > 0 && Date.now() >= deadlineMs) break;
    const row = epochByOrdinal.get(epochKey(item.walkOrdinal, item.epochOrdinal));
    if (row === undefined) throw new Error("visual denominator epoch has no exact work-manifest row");
    try {
      const result = await processVisualEpoch({
        env: input.env,
        runId: input.runId,
        fence: input.fence,
        row,
        rollout: {
          maximumCalls: configuration.configuration.maximumCalls,
          maximumUsd: configuration.configuration.maximumUsd,
          timeoutMs: configuration.configuration.timeoutMs,
        },
        client: current.resolved.client,
        model: current.resolved.modelSpec,
      });
      items.push(visualProcessedItemFromEpochResult(ordinal, item, result));
    } catch (error) {
      if (error instanceof OwnershipLost) throw error;
      const classified = classifyEpochFailure(error, ordinal, item, head.state.completedWaveCount);
      if (classified === null) throw error;
      items.push(classified.item);
      channel = classified.channel;
      break;
    }
  }
  if (items.length === 0) throw new Error("visual wave produced an empty progress shard");

  const appended = await appendVisualProgressWave(input.env, {
    expected: visualProgressExpectation(head),
    cursor: liveCursor,
    waveOrdinal: liveCursor.completedWaveCount,
    startDenominatorOrdinal: liveCursor.nextDenominatorOrdinal,
    items,
    purchaseChannelAfter: channel,
  });
  return compactProgress(appended.head, currentPlain);
}

async function appendConfigurationDrift(
  input: VisualShadowWorkflowInput,
  head: VisualProgressHead,
  denominator: VisualDenominator,
): Promise<VisualProgressHead> {
  const cursor = visualProgressCursor(head);
  const items: VisualProgressItem[] = [];
  let channel: VisualProgressPurchaseChannel = head.state.purchaseChannel;
  for (
    let ordinal = cursor.nextDenominatorOrdinal;
    ordinal < denominator.length && items.length < VISUAL_SHADOW_MAX_DENOMINATOR_ITEMS_PER_WAVE;
    ordinal += 1
  ) {
    const item = denominator[ordinal]!;
    if (item.kind !== "epoch" || item.eligibility !== "eligible") {
      items.push(visualProcessedMechanicalItem(ordinal, item));
      continue;
    }
    const limitation = visualProcessedLimitationItem(
      ordinal,
      item,
      "rollout-config-invalid",
      "The current deployment no longer matches the sealed visual rollout/model authority; no call was attempted.",
    );
    items.push(limitation);
    channel = {
      state: "blocked",
      originatingBlocker: {
        code: "rollout-authority-drift",
        detail: limitation.detail!,
        waveOrdinal: cursor.completedWaveCount,
        denominatorOrdinal: ordinal,
        disposition: "rollout-config-invalid",
      },
    };
    break;
  }
  if (items.length === 0) return head;
  const appended = await appendVisualProgressWave(input.env, {
    expected: visualProgressExpectation(head),
    cursor,
    waveOrdinal: cursor.completedWaveCount,
    startDenominatorOrdinal: cursor.nextDenominatorOrdinal,
    items,
    purchaseChannelAfter: channel,
  });
  return appended.head;
}

function classifyEpochFailure(
  error: unknown,
  ordinal: number,
  denominator: VisualEpochDenominatorItem,
  waveOrdinal: number,
): { item: VisualProgressItem; channel: VisualProgressPurchaseChannel } | null {
  if (error instanceof VisualUsageAdmissionRefused) {
    if (
      error.reason === "visual-call-cap" ||
      error.reason === "visual-cost-cap" ||
      error.reason === "model-call-cap" ||
      error.reason === "cost-cap" ||
      error.reason === "wall-clock-cap"
    ) {
      const item = visualProcessedLimitationItem(
        ordinal,
        denominator,
        "budget-not-authorized",
        `The sealed visual/global allowance refused another purchase (${error.reason}); no call was attempted.`,
      );
      return {
        item,
        channel: {
          state: "exhausted",
          originatingStop: {
            code: `usage-${error.reason}`,
            detail: item.detail!,
            waveOrdinal,
            denominatorOrdinal: ordinal,
            remainderDisposition: "budget-not-authorized",
          },
        },
      };
    }
    return blockedFailure(
      ordinal,
      denominator,
      waveOrdinal,
      "purchase-blocked",
      `usage-${error.reason}`,
      `Strict visual admission refused because ${error.reason}; no further purchase was attempted.`,
    );
  }
  if (error instanceof VisualInferencePurchaseBlockedError) {
    return blockedFailure(
      ordinal,
      denominator,
      waveOrdinal,
      "purchase-blocked",
      `inference-${error.reason}`,
      `The durable inference receipt is ${error.reason}; no further purchase was attempted.`,
    );
  }
  if (
    error instanceof VisualUsageValidationError ||
    error instanceof VisualUsageIdentityConflict ||
    error instanceof VisualUsageReservationConflict ||
    error instanceof VisualUsageCheckpointMissing
  ) {
    return blockedFailure(
      ordinal,
      denominator,
      waveOrdinal,
      "accounting-failed",
      "usage-accounting-unavailable",
      "Strict visual admission/accounting state could not be validated; the purchase channel was stopped.",
    );
  }
  if (
    error instanceof VisualObservationPersistenceError ||
    error instanceof VisualStorageValidationError ||
    error instanceof VisualStorageImmutabilityError ||
    error instanceof VisualStorageCorruptionError
  ) {
    return blockedFailure(
      ordinal,
      denominator,
      waveOrdinal,
      "persistence-failed",
      "visual-artifact-persistence-failed",
      "A required visual artifact could not be durably validated and re-read; the purchase channel was stopped.",
    );
  }
  if (error instanceof VisualEpochProcessingError) {
    if (error.code === "loaded-work-identity-invalid") {
      return {
        item: visualProcessedLimitationItem(
          ordinal,
          denominator,
          "input-integrity-failed",
          "The prepared epoch row did not retain a complete target-neutral work identity; no call was attempted.",
        ),
        channel: { state: "open", originatingBlocker: null },
      };
    }
    if (error.code === "rollout-limits-invalid") {
      return blockedFailure(
        ordinal,
        denominator,
        waveOrdinal,
        "rollout-config-invalid",
        "sealed-rollout-limits-invalid",
        "The sealed visual rollout limits were rejected by the one-epoch processor; the purchase channel was stopped.",
      );
    }
    return blockedFailure(
      ordinal,
      denominator,
      waveOrdinal,
      "persistence-failed",
      `visual-epoch-${error.code}`,
      "A required visual epoch artifact could not be durably validated and re-read; the purchase channel was stopped.",
    );
  }
  return null;
}

function blockedFailure(
  ordinal: number,
  denominator: VisualEpochDenominatorItem,
  waveOrdinal: number,
  disposition: "purchase-blocked" | "accounting-failed" | "persistence-failed" | "rollout-config-invalid",
  code: string,
  message: string,
): { item: VisualProgressItem; channel: VisualProgressPurchaseChannel } {
  const item = visualProcessedLimitationItem(ordinal, denominator, disposition, message);
  return {
    item,
    channel: {
      state: "blocked",
      originatingBlocker: {
        code,
        detail: item.detail!,
        waveOrdinal,
        denominatorOrdinal: ordinal,
        disposition,
      },
    },
  };
}

async function finalizeCoverage(
  input: VisualShadowWorkflowInput,
  supplied: CompactProgress,
): Promise<Extract<VisualShadowWorkflowResult, { state: "coverage-finalized" }>> {
  await assertCurrentOwner(input.env, input.runId, input.fence);
  const work = await readExactWorkManifest(
    input.env,
    input.runId,
    input.planRevisionId,
    supplied.identity.visualWorkManifestSha256,
  );
  const snapshot = await readVisualProgress(input.env.EVIDENCE, supplied.expected);
  if (snapshot === null) throw new Error("visual progress disappeared before coverage finalization");
  if (canonicalJson(visualProgressCursor(snapshot)) !== canonicalJson(supplied.cursor)) {
    throw new Error("visual progress cursor drifted before coverage finalization");
  }
  const remainder = remainderPosture(snapshot, supplied.authorityDrift);
  const entries = await closeVisualCoverageEntries({
    workManifest: work,
    inferenceFingerprintSha256: snapshot.authority.modelFingerprintSha256,
    authorizationFingerprintSha256: snapshot.authority.authorizationFingerprintSha256,
    processed: snapshot.items,
    remainder,
  });
  const prepared = await prepareVisualCoverageIndex({
    workManifest: work,
    visualWorkManifestSha256: supplied.identity.visualWorkManifestSha256,
    inference: snapshot.authority.inference,
    authorization: snapshot.authority.authorization,
    finalizedAt: snapshot.state.coverageFinalizedAt,
    entries,
  });
  // The closed coverage index already cites and re-verifies every successful epoch. The
  // optional aggregate is deliberately absent until it has a sharded, bounded verifier;
  // emitting a 20k-way in-memory fan-out here would make the convenience index less safe than
  // the complete coverage it summarizes.
  const finalized = await finalizeVisualCoverageIndex(input.env.EVIDENCE, prepared, {
    successfulDataManifest: null,
  });
  const pointer = await readVisualCoveragePointer(input.env.EVIDENCE, input.runId, {
    runId: input.runId,
    planRevisionId: input.planRevisionId,
    visualWorkManifestSha256: supplied.identity.visualWorkManifestSha256,
    inferenceFingerprintSha256: snapshot.authority.modelFingerprintSha256,
    authorizationFingerprintSha256: snapshot.authority.authorizationFingerprintSha256,
  });
  if (pointer === null || pointer.coverage.contentSha256 !== finalized.coverageSha256) {
    throw new Error("visual coverage pointer disappeared or changed after finalization");
  }
  const reread = await readVisualCoverageIndex(
    input.env.EVIDENCE,
    input.runId,
    pointer.coverage.contentSha256,
    work,
    {
      runId: input.runId,
      planRevisionId: input.planRevisionId,
      visualWorkManifestSha256: supplied.identity.visualWorkManifestSha256,
      inferenceFingerprintSha256: snapshot.authority.modelFingerprintSha256,
      authorizationFingerprintSha256: snapshot.authority.authorizationFingerprintSha256,
    },
  );
  if (reread === null) throw new Error("visual coverage index disappeared after pointer creation");
  return {
    state: "coverage-finalized",
    coverageKey: finalized.coverageKey,
    pointerKey: finalized.pointerKey,
    coverageSha256: finalized.coverageSha256,
    totals: reread.totals,
  };
}

function remainderPosture(
  snapshot: VisualProgressSnapshot,
  authorityDrift: boolean,
): VisualCoverageRemainderPosture {
  if (authorityDrift || snapshot.authority.rollout.state === "invalid") {
    return { state: "invalid", detail: "The current deployment does not hold the sealed visual rollout/model authority." };
  }
  if (
    snapshot.authority.rollout.state === "valid" &&
    !snapshot.authority.rollout.configuration.enabled
  ) {
    return { state: "disabled", detail: "The sealed deployment explicitly disabled visual shadow inference." };
  }
  const channel = snapshot.state.purchaseChannel;
  if (channel.state === "exhausted") {
    return { state: "budget-exhausted", detail: channel.originatingStop.detail };
  }
  if (channel.state === "blocked") {
    if (channel.originatingBlocker.disposition === "rollout-config-invalid") {
      return { state: "invalid", detail: channel.originatingBlocker.detail };
    }
    return { state: "purchase-blocked", detail: channel.originatingBlocker.detail };
  }
  return { state: "wave-limit", detail: "The sealed maximum number of serial visual waves was exhausted." };
}

async function resolveAuthorityCandidate(env: Env): Promise<ResolvedAuthorityCandidate> {
  const prompt = { version: VISUAL_PROMPT_VERSION, sha256: await visualPromptSha256() };
  const responseSchema = {
    version: VISUAL_RESPONSE_SCHEMA_VERSION,
    sha256: await visualResponseSchemaSha256(),
  };
  let configuration;
  try {
    configuration = visualShadowConfiguration(env);
  } catch (error) {
    if (!(error instanceof VisualRolloutConfigurationError)) throw error;
    const configurationFingerprintSha256 = await visualShadowRawConfigurationSha256(env);
    return {
      rollout: { state: "invalid", recognizedInputSha256: configurationFingerprintSha256 },
      inference: await createDisabledVisualInferenceFingerprint({ prompt, responseSchema }),
      authorization: {
        state: "invalid",
        rolloutConfigurationSha256: configurationFingerprintSha256,
        maximumVisualCalls: 0,
        maximumVisualUsd: 0,
      },
      resolved: null,
    };
  }
  const configurationFingerprintSha256 = await visualShadowConfigurationSha256(configuration);
  if (!configuration.enabled) {
    return {
      rollout: { state: "valid", configuration },
      inference: await createDisabledVisualInferenceFingerprint({ prompt, responseSchema }),
      authorization: {
        state: "disabled",
        rolloutConfigurationSha256: configurationFingerprintSha256,
        maximumVisualCalls: 0,
        maximumVisualUsd: 0,
      },
      resolved: null,
    };
  }
  let resolved: ResolvedVisualProvider;
  try {
    resolved = await resolveVisualProvider(env, configuration);
  } catch (error) {
    if (!(error instanceof VisualRolloutConfigurationError)) throw error;
    const invalidFingerprint = await visualShadowRawConfigurationSha256(env);
    return {
      rollout: { state: "invalid", recognizedInputSha256: invalidFingerprint },
      inference: await createDisabledVisualInferenceFingerprint({ prompt, responseSchema }),
      authorization: {
        state: "invalid",
        rolloutConfigurationSha256: invalidFingerprint,
        maximumVisualCalls: 0,
        maximumVisualUsd: 0,
      },
      resolved: null,
    };
  }
  return {
    rollout: { state: "valid", configuration },
    inference: {
      ...resolved.modelSpec,
      prompt,
      responseSchema,
    },
    authorization: {
      state: "authorized",
      rolloutConfigurationSha256: configurationFingerprintSha256,
      maximumVisualCalls: configuration.maximumCalls,
      maximumVisualUsd: configuration.maximumUsd,
    },
    resolved,
  };
}

function authorityWithoutClient(value: ResolvedAuthorityCandidate): AuthorityCandidate {
  return { rollout: value.rollout, inference: value.inference, authorization: value.authorization };
}

function authorityFromSeal(value: VisualProgressAuthoritySeal): AuthorityCandidate {
  return { rollout: value.rollout, inference: value.inference, authorization: value.authorization };
}

function authorityMatches(sealed: VisualProgressAuthoritySeal, current: AuthorityCandidate): boolean {
  return (
    canonicalJson(sealed.rollout) === canonicalJson(current.rollout) &&
    canonicalJson(sealed.inference) === canonicalJson(current.inference) &&
    canonicalJson(sealed.authorization) === canonicalJson(current.authorization)
  );
}

function compactProgress(head: VisualProgressHead, current: AuthorityCandidate): CompactProgress {
  return {
    identity: {
      runId: head.state.runId,
      planRevisionId: head.state.planRevisionId,
      visualWorkManifestSha256: head.state.visualWorkManifestSha256,
      denominatorItemCount: head.state.denominatorItemCount,
    },
    expected: visualProgressExpectation(head),
    cursor: visualProgressCursor(head),
    purchaseChannel: head.state.purchaseChannel,
    authority: head.authority,
    authorityDrift: !authorityMatches(head.authority, current),
  };
}

async function readExactWorkManifest(
  env: Env,
  runId: string,
  planRevisionId: string,
  expectedSha256: string,
): Promise<VisualWorkManifest> {
  const work = await readVisualWorkManifest(env.EVIDENCE, visualManifestKey(runId), {
    runId,
    planRevisionId,
  });
  if (work === null) throw new Error("visual work manifest is absent after preparation");
  if ((await canonicalHash(work)) !== expectedSha256) {
    throw new Error("visual work manifest bytes do not match the prepared identity");
  }
  return work;
}

async function readExistingCoverage(
  env: Env,
  identity: VisualProgressIdentityExpected,
): Promise<Extract<VisualShadowWorkflowResult, { state: "coverage-finalized" }> | null> {
  const pointer = await readVisualCoveragePointer(env.EVIDENCE, identity.runId, {
    runId: identity.runId,
    planRevisionId: identity.planRevisionId,
    visualWorkManifestSha256: identity.visualWorkManifestSha256,
  });
  if (pointer === null) return null;
  const work = await readExactWorkManifest(
    env,
    identity.runId,
    identity.planRevisionId,
    identity.visualWorkManifestSha256,
  );
  const coverage = await readVisualCoverageIndex(
    env.EVIDENCE,
    identity.runId,
    pointer.coverage.contentSha256,
    work,
    {
      runId: identity.runId,
      planRevisionId: identity.planRevisionId,
      visualWorkManifestSha256: identity.visualWorkManifestSha256,
      inferenceFingerprintSha256: pointer.inferenceFingerprintSha256,
      authorizationFingerprintSha256: pointer.authorizationFingerprintSha256,
    },
  );
  if (coverage === null) throw new Error("visual coverage pointer names a missing index");
  if (coverage.totals.denominatorItems !== identity.denominatorItemCount) {
    throw new Error("stored visual coverage does not close the current denominator");
  }
  return {
    state: "coverage-finalized",
    coverageKey: pointer.coverage.key,
    pointerKey: visualCoveragePointerKey(identity.runId),
    coverageSha256: pointer.coverage.contentSha256,
    totals: coverage.totals,
  };
}

async function assertCurrentOwner(env: Env, runId: string, fence: Fence): Promise<void> {
  const loaded = await loadCheckpoint(env, runId);
  const current = loaded?.checkpoint.ownership ?? null;
  if (current === null || current.instanceId !== fence.instanceId || current.epoch !== fence.epoch) {
    throw new OwnershipLost(runId, fence, current);
  }
}

function terminalForFailure(
  phase: VisualPhase,
  error: unknown,
): { phase: VisualPhase; reason: VisualTerminalReason; detail: string } {
  if (phase === "work-preparation") {
    if (error instanceof VisualWorkCapacityExceededError) {
      return {
        phase,
        reason: "VISUAL_WORK_CAPACITY_EXCEEDED",
        detail:
          `The captured run requires at least ${error.observedLowerBound} visual denominator item(s), ` +
          `above the current unsharded capacity of ${error.maximumDenominatorItems}; no visual call was authorized.`,
      };
    }
    return {
      phase,
      reason: "VISUAL_WORK_PREPARATION_FAILED",
      detail: "The visual work denominator could not be durably prepared and re-read; no visual call was authorized.",
    };
  }
  if (phase === "rollout-initialization") {
    return {
      phase,
      reason: "VISUAL_ROLLOUT_INITIALIZATION_FAILED",
      detail: "The non-secret visual rollout/model authority could not be durably sealed; no visual call was authorized.",
    };
  }
  if (phase === "wave-orchestration") {
    return {
      phase,
      reason: "VISUAL_WAVE_ORCHESTRATION_FAILED",
      detail: "Serial visual shadow orchestration stopped at an unclassified control-plane boundary; it was not relabelled as provider unavailability.",
    };
  }
  const limited =
    error instanceof Error && /exceeds .*?(?:items|bytes|storage envelope)|storage envelope/i.test(error.message);
  return {
    phase,
    reason: limited ? "VISUAL_COVERAGE_LIMIT_EXCEEDED" : "VISUAL_COVERAGE_FINALIZATION_FAILED",
    detail: limited
      ? "Closed visual coverage exceeded a named storage or item envelope; no denominator rows were silently omitted."
      : "Closed visual coverage could not be durably finalized and re-read.",
  };
}

async function persistTerminalLimitation(
  input: VisualShadowWorkflowInput,
  limitation: { phase: VisualPhase; reason: VisualTerminalReason; detail: string },
  context: {
    identity: VisualProgressIdentityExpected | null;
    progress: CompactProgress | null;
  } = { identity: null, progress: null },
): Promise<VisualShadowWorkflowResult> {
  try {
    return await input.step.do(
      "visual-shadow-terminal-status-v1",
      VISUAL_DETERMINISTIC_POLICY,
      async (): Promise<VisualShadowWorkflowResult> => {
        await assertCurrentOwner(input.env, input.runId, input.fence);
        // Final coverage is monotonic. Recheck immediately before a terminal pointer write so a
        // lost coverage response can never produce two fixed terminal stories.
        if (context.identity !== null) {
          const coverage = await readExistingCoverage(input.env, context.identity);
          if (coverage !== null) return coverage;
        }
        const existing = await readVisualTerminalStatusFromPointer(input.env.EVIDENCE, input.runId, {
          runId: input.runId,
          planRevisionId: input.planRevisionId,
        });
        if (existing !== null) return terminalResult(existing.pointer);
        let workManifest = null;
        if (context.identity !== null) {
          try {
            await readExactWorkManifest(
              input.env,
              input.runId,
              input.planRevisionId,
              context.identity.visualWorkManifestSha256,
            );
            workManifest = {
              key: visualManifestKey(input.runId),
              contentSha256: context.identity.visualWorkManifestSha256,
            };
          } catch {
            // The limitation still needs to be visible, but a corrupt/missing object must never
            // be cited as verified evidence. Its absence is already named by the phase reason.
          }
        }
        const inferenceFingerprintSha256 =
          context.progress?.authority.modelFingerprintSha256 ?? null;
        const authorizationFingerprintSha256 =
          context.progress?.authority.authorizationFingerprintSha256 ?? null;
        const prepared = await prepareVisualTerminalStatus({
          runId: input.runId,
          planRevisionId: input.planRevisionId,
          finalizedAt: new Date().toISOString(),
          phase: limitation.phase,
          reason: limitation.reason,
          detail: limitation.detail,
          workManifest,
          inferenceFingerprintSha256,
          authorizationFingerprintSha256,
        });
        await finalizeVisualTerminalStatus(input.env.EVIDENCE, prepared);
        const reread = await readVisualTerminalStatusFromPointer(input.env.EVIDENCE, input.runId, {
          runId: input.runId,
          planRevisionId: input.planRevisionId,
          phase: limitation.phase,
          reason: limitation.reason,
          workManifestSha256: workManifest?.contentSha256 ?? null,
          inferenceFingerprintSha256,
          authorizationFingerprintSha256,
        });
        if (reread === null) throw new Error("visual terminal status disappeared after finalization");
        return terminalResult(reread.pointer);
      },
    );
  } catch (error) {
    if (error instanceof OwnershipLost) throw error;
    return {
      state: "terminal-limitation",
      reason: "VISUAL_STATUS_PERSISTENCE_FAILED",
      statusPointerKey: null,
    };
  }
}

function terminalResult(
  pointer: VisualTerminalStatusPointer,
): Extract<VisualShadowWorkflowResult, { state: "terminal-limitation" }> {
  return {
    state: "terminal-limitation",
    reason: pointer.reason,
    statusPointerKey: pointer.status.key,
  };
}

function epochKey(walkOrdinal: number, epochOrdinal: number): string {
  return `${walkOrdinal}:${epochOrdinal}`;
}

/**
 * PRIVACY-SAFE, READ-ONLY BROWSER ACTIVITY PROJECTION.
 *
 * This surface answers "what did the browser actually record?". It is deliberately not a
 * coverage projection and cannot mint a checked case, observation, finding, or verdict.
 * Three grains stay separate all the way to the response:
 *
 *   - a WALK ATTEMPT is one recorded browser drive;
 *   - a SCREEN CHANGE is one step whose stable screen identity changed after advancing;
 *   - a COVERAGE-CREDITED WALK is a walk that closed at least one sealed execution case.
 *
 * A screen change is not a unique page. Re-visiting A -> B -> A produces two changes and two
 * unique stable screens. A new walk carries the exact content-addressed PathObservation evidence
 * id in its durable ledger row, so the live view can bind it immediately. The immutable post-run
 * walk-artifact index remains the compatibility authority for older rows. When neither binding is
 * present, or a binding is unresolved, unreadable, or outside this endpoint's inspection ceiling,
 * the response names that limitation and never fills in a page count from URL or catalogue order.
 *
 * PRIVACY BOUNDARY. Path/query/fragment components, page titles, rendered text, option labels,
 * action targets, error strings, and raw screen signatures never leave this module. The only
 * location returned is an http(s) origin derived with URL.origin. All other page-derived data
 * is a count or a closed machine state.
 */

import type { Env } from "../types/env";
import type { RunCheckpoint } from "../types/contracts";
import type { EvidenceCatalogEntry } from "../types/record";
import { walkArtifactIndexKey } from "../keys";
import { getBoundCatalogEntry, getVerifiedEvidence } from "../store/evidence";
import { readWalkArtifactIndex, type WalkArtifactBinding } from "../store/walk-artifact-index";
import { validatePathObservationBytes } from "../store/visual-work";
import { execProgressKey } from "../workflow/stages/execute-batch";

export const EXECUTION_ACTIVITY_SCHEMA_VERSION = "survey-qa-execution-activity/1.0.0" as const;

const MAX_PROGRESS_BYTES = 32 * 1024 * 1024;
const MAX_WALKS = 100_000;
const MAX_CASE_IDS_PER_WALK = 100_000;
const MAX_TEXT = 100_000;
const MAX_WALK_ROWS_RETURNED = 50;
const MAX_ARTIFACT_WALKS_INSPECTED = 24;
const MAX_ARRAY_ITEMS = 1_000_000;
const SAFE_LIMITATION_KIND = /^[a-z0-9][a-z0-9._:-]{0,119}$/;
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const PUBLIC_OUTCOMES = new Set([
  "completed",
  "no-advance-control",
  "blocked",
  "blocked-after-probe",
  "step-cap",
  "time-cap",
  "load-crash",
  "browser-hung",
  "per-case-timeout",
  "cycle-detected",
  "error",
]);

type ArtifactState =
  | "inspected"
  | "not-yet-indexed"
  | "unresolved"
  | "not-inspected-limit"
  | "catalog-missing"
  | "binding-mismatch"
  | "artifact-unreadable"
  | "artifact-corrupt"
  | "artifact-identity-mismatch";

interface ParsedReaderLimitation {
  kind: string;
  count: number;
}

interface ParsedWalk {
  pathId: string;
  attemptId: string;
  tier: 1 | 2;
  outcome: string;
  steps: number;
  wallMs: number;
  shimmed: boolean;
  loadCrash: boolean;
  evidenceCount: number;
  caseIds: string[];
  exercised: boolean;
  plannedDecisions: number;
  matchedDecisions: number;
  constrainingDecisions: number;
  matchedConstraining: number;
  screensAdvanced: number;
  blockedSteps: number | null;
  ending: "completed" | "screened-out" | "stalled" | "unclassified" | null;
  unboundDecisions: number | null;
  bindingRefusalCount: number | null;
  readerLimitations: ParsedReaderLimitation[] | null;
  readerLimitationCount: number | null;
  observationEvidenceId: string | null;
  at: string;
}

interface ParsedProgress {
  runId: string;
  planRevisionId: string;
  walks: ParsedWalk[];
  totalSteps: number;
  totalEvidence: number;
}

interface ArtifactFacts {
  uniqueStableScreens: number;
  stableScreenSignatures: Set<string>;
  returnScreenChanges: number;
  origins: Set<string>;
  actionReceipts: number;
  successfulActionReceipts: number;
  navigatorDefaultAnswers: number | null;
  captureFailureOccurrences: number | null;
  unfillableControls: number | null;
  pageErrorOccurrences: number;
  consoleErrorOccurrences: number;
  invalidScreenUrls: number;
}

interface WalkArtifactProjection {
  state: ArtifactState;
  uniqueStableScreensObserved: number | null;
  returnScreenChangesObserved: number | null;
  originsObserved: string[];
  actionReceiptsObserved: number | null;
  successfulActionReceiptsObserved: number | null;
  navigatorDefaultAnswersObserved: number | null;
  captureFailureOccurrences: number | null;
  unfillableControls: number | null;
  pageErrorOccurrences: number | null;
  consoleErrorOccurrences: number | null;
  invalidScreenUrls: number | null;
}

export interface ExecutionActivityProjection {
  schemaVersion: typeof EXECUTION_ACTIVITY_SCHEMA_VERSION;
  kind: "survey-qa-execution-activity";
  channel: "browser-activity-not-qa-coverage";
  runId: string;
  revision: number;
  observedAt: string;
  sourceCheckpointHash: string;
  ledger: {
    state: "absent" | "available";
    planRevisionId: string | null;
  };
  totals: {
    walkAttemptsRecorded: number;
    stepObservations: number;
    screenChanges: number;
    walksCreditedToCoverage: number;
    activityOnlyWalks: number;
    executionCasesCredited: number;
    evidenceReferences: number;
    uniqueStableScreensObserved: number | null;
    uniqueStableScreensExact: boolean;
    returnScreenChangesObserved: number | null;
    actionReceiptsObserved: number | null;
    successfulActionReceiptsObserved: number | null;
    navigatorDefaultAnswersObserved: number | null;
    visitedOrigins: string[];
    visitedOriginsExact: boolean;
  };
  artifactInspection: {
    state: "not-yet-indexed" | "complete" | "partial";
    indexedWalks: number;
    walksEligibleForInspection: number;
    walksInspected: number;
    unresolvedWalks: number;
    unreadableOrMismatchedWalks: number;
    walksNotInspectedBecauseOfLimit: number;
    inspectionLimit: number;
  };
  limitations: {
    unboundPlannedDecisions: number;
    walksWithoutUnboundDecisionCount: number;
    bindingRefusals: number;
    walksWithoutBindingRefusalCount: number;
    readerLimitationOccurrences: number;
    walksWithoutReaderLimitationCount: number;
    readerLimitationKinds: Array<{ kind: string; occurrences: number }>;
    blockedSteps: number;
    walksWithoutBlockedStepCount: number;
    captureFailureOccurrencesObserved: number | null;
    unfillableControlsObserved: number | null;
    pageErrorOccurrencesObserved: number | null;
    consoleErrorOccurrencesObserved: number | null;
    invalidScreenUrlsObserved: number | null;
    artifactDerivedCountsExact: boolean;
    unrecognizedOutcomeRows: number;
  };
  outcomes: Array<{ outcome: string; walks: number }>;
  walks: Array<{
    ordinal: number;
    tier: 1 | 2;
    recordedAt: string;
    outcome: string;
    ending: "completed" | "screened-out" | "stalled" | "unclassified" | null;
    stepObservations: number;
    screenChanges: number;
    blockedSteps: number | null;
    creditedToCoverage: boolean;
    executionCasesCredited: number;
    plannedDecisions: number;
    matchedDecisions: number;
    unboundPlannedDecisions: number | null;
    bindingRefusals: number | null;
    shimmed: boolean;
    loadCrash: boolean;
    artifact: WalkArtifactProjection;
  }>;
  walkRowsReturned: number;
  walkRowsOmitted: number;
  privacy: {
    urls: "origins-only";
    queryTokens: "excluded";
    pageText: "excluded";
    screenSignatures: "counted-not-returned";
    actionTargets: "excluded";
    rawErrors: "excluded";
  };
}

export class ExecutionActivityCorruptError extends Error {
  constructor(detail: string) {
    super(`execution activity source is corrupt: ${detail}`);
    this.name = "ExecutionActivityCorruptError";
  }
}

export function isExecutionActivityCorruption(error: unknown): boolean {
  return error instanceof ExecutionActivityCorruptError;
}

/**
 * Project one immutable read snapshot. No write, no finding, no coverage mutation.
 */
export async function projectExecutionActivity(
  env: Env,
  checkpoint: RunCheckpoint,
  sourceCheckpointHash: string,
): Promise<ExecutionActivityProjection> {
  const progress = await readProgressStrict(env, checkpoint.runId);
  const base = baseProjection(checkpoint, sourceCheckpointHash);
  if (progress === null) return base;

  const expectedPlanRevisionId = checkpoint.execution?.planRevisionId;
  if (expectedPlanRevisionId && progress.planRevisionId !== expectedPlanRevisionId) {
    corrupt("execution ledger plan revision does not match the checkpoint");
  }

  let index = null;
  try {
    index = await readWalkArtifactIndex(env.EVIDENCE, walkArtifactIndexKey(checkpoint.runId), {
      runId: checkpoint.runId,
      planRevisionId: progress.planRevisionId,
      walks: progress.walks.length,
    });
  } catch {
    corrupt("walk-artifact index failed strict identity or integrity validation");
  }

  const artifactByOrdinal = new Map<number, WalkArtifactProjection>();
  const globalSignatures = new Set<string>();
  const globalOrigins = new Set<string>();
  let inspectedWalks = 0;
  let unreadableOrMismatchedWalks = 0;
  let notInspectedBecauseOfLimit = 0;
  let actionReceipts = 0;
  let successfulActionReceipts = 0;
  let returnScreenChanges = 0;
  let navigatorDefaultAnswers = 0;
  let navigatorDefaultKnown = true;
  let captureFailures = 0;
  let captureFailuresKnown = true;
  let unfillableControls = 0;
  let unfillableKnown = true;
  let pageErrors = 0;
  let consoleErrors = 0;
  let invalidScreenUrls = 0;

  const firstInspectionOrdinal = Math.max(0, progress.walks.length - MAX_ARTIFACT_WALKS_INSPECTED);
  for (let ordinal = 0; ordinal < progress.walks.length; ordinal += 1) {
      const walk = progress.walks[ordinal]!;
      const indexedRow = index?.rows[ordinal] ?? null;
      if (ordinal < firstInspectionOrdinal) {
        artifactByOrdinal.set(ordinal, emptyArtifact("not-inspected-limit"));
        if (walk.observationEvidenceId !== null || indexedRow?.selected !== null) notInspectedBecauseOfLimit += 1;
        continue;
      }
      let selected: WalkArtifactBinding | null = null;
      if (walk.observationEvidenceId !== null) {
        let entry: EvidenceCatalogEntry | null;
        try {
          entry = await getBoundCatalogEntry(env, checkpoint.runId, walk.observationEvidenceId);
        } catch {
          artifactByOrdinal.set(ordinal, emptyArtifact("artifact-unreadable"));
          unreadableOrMismatchedWalks += 1;
          continue;
        }
        if (entry === null) {
          artifactByOrdinal.set(ordinal, emptyArtifact("catalog-missing"));
          unreadableOrMismatchedWalks += 1;
          continue;
        }
        if (!directEntryMatchesWalk(entry, walk)) {
          artifactByOrdinal.set(ordinal, emptyArtifact("binding-mismatch"));
          unreadableOrMismatchedWalks += 1;
          continue;
        }
        selected = bindingFromEntry(entry);
      } else if (
        indexedRow !== null &&
        indexedRow.selected !== null &&
        (indexedRow.state === "exact" || indexedRow.state === "legacy")
      ) {
        selected = indexedRow.selected;
      }
      if (selected === null) {
        artifactByOrdinal.set(
          ordinal,
          emptyArtifact(indexedRow === null ? "not-yet-indexed" : "unresolved"),
        );
        continue;
      }
      const inspected = await inspectArtifact(env, checkpoint.runId, progress.planRevisionId, walk, selected);
      artifactByOrdinal.set(ordinal, inspected.projection);
      if (inspected.facts === null) {
        unreadableOrMismatchedWalks += 1;
        continue;
      }
      inspectedWalks += 1;
      for (const signature of inspected.facts.stableScreenSignatures) globalSignatures.add(signature);
      for (const origin of inspected.facts.origins) globalOrigins.add(origin);
      actionReceipts += inspected.facts.actionReceipts;
      successfulActionReceipts += inspected.facts.successfulActionReceipts;
      returnScreenChanges += inspected.facts.returnScreenChanges;
      pageErrors += inspected.facts.pageErrorOccurrences;
      consoleErrors += inspected.facts.consoleErrorOccurrences;
      invalidScreenUrls += inspected.facts.invalidScreenUrls;
      if (inspected.facts.navigatorDefaultAnswers === null) navigatorDefaultKnown = false;
      else navigatorDefaultAnswers += inspected.facts.navigatorDefaultAnswers;
      if (inspected.facts.captureFailureOccurrences === null) captureFailuresKnown = false;
      else captureFailures += inspected.facts.captureFailureOccurrences;
      if (inspected.facts.unfillableControls === null) unfillableKnown = false;
      else unfillableControls += inspected.facts.unfillableControls;
  }

  const inspectionExact =
    progress.walks.length <= MAX_ARTIFACT_WALKS_INSPECTED &&
    inspectedWalks === progress.walks.length;

  const outcomeCounts = new Map<string, number>();
  const creditedCaseIds = new Set<string>();
  const readerKinds = new Map<string, number>();
  let creditedWalks = 0;
  let unboundDecisions = 0;
  let unboundUnknown = 0;
  let bindingRefusals = 0;
  let bindingUnknown = 0;
  let readerLimitationOccurrences = 0;
  let readerUnknown = 0;
  let blockedSteps = 0;
  let blockedUnknown = 0;
  let unrecognizedOutcomes = 0;

  for (const walk of progress.walks) {
    const outcome = publicOutcome(walk.outcome);
    if (outcome === "unrecognized") unrecognizedOutcomes += 1;
    outcomeCounts.set(outcome, (outcomeCounts.get(outcome) ?? 0) + 1);
    if (walk.caseIds.length > 0) creditedWalks += 1;
    for (const caseId of walk.caseIds) creditedCaseIds.add(caseId);
    if (walk.unboundDecisions === null) unboundUnknown += 1;
    else unboundDecisions += walk.unboundDecisions;
    if (walk.bindingRefusalCount === null) bindingUnknown += 1;
    else bindingRefusals += walk.bindingRefusalCount;
    if (walk.readerLimitationCount === null) readerUnknown += 1;
    else readerLimitationOccurrences += walk.readerLimitationCount;
    for (const limitation of walk.readerLimitations ?? []) {
      const kind = safeLimitationKind(limitation.kind);
      readerKinds.set(kind, (readerKinds.get(kind) ?? 0) + limitation.count);
    }
    if (walk.blockedSteps === null) blockedUnknown += 1;
    else blockedSteps += walk.blockedSteps;
  }

  const returnedFrom = Math.max(0, progress.walks.length - MAX_WALK_ROWS_RETURNED);
  const walks = progress.walks.slice(returnedFrom).map((walk, relativeIndex) => {
    const ordinal = returnedFrom + relativeIndex;
    return {
      ordinal: ordinal + 1,
      tier: walk.tier,
      recordedAt: walk.at,
      outcome: publicOutcome(walk.outcome),
      ending: walk.ending,
      stepObservations: walk.steps,
      screenChanges: walk.screensAdvanced,
      blockedSteps: walk.blockedSteps,
      creditedToCoverage: walk.caseIds.length > 0,
      executionCasesCredited: walk.caseIds.length,
      plannedDecisions: walk.plannedDecisions,
      matchedDecisions: walk.matchedDecisions,
      unboundPlannedDecisions: walk.unboundDecisions,
      bindingRefusals: walk.bindingRefusalCount,
      shimmed: walk.shimmed,
      loadCrash: walk.loadCrash,
      artifact: artifactByOrdinal.get(ordinal) ?? emptyArtifact(index === null ? "not-yet-indexed" : "not-inspected-limit"),
    };
  });

  const eligible = progress.walks.filter((walk, ordinal) =>
    walk.observationEvidenceId !== null ||
    (index?.rows[ordinal]?.selected !== null &&
      (index?.rows[ordinal]?.state === "exact" || index?.rows[ordinal]?.state === "legacy")),
  ).length;
  const unresolved = Math.max(0, progress.walks.length - eligible);
  const artifactState = progress.walks.length === 0
    ? "complete"
    : eligible === 0 && index === null
      ? "not-yet-indexed"
      : inspectionExact
        ? "complete"
        : "partial";
  const hasAnyInspection = inspectedWalks > 0 || progress.walks.length === 0;

  return {
    ...base,
    ledger: { state: "available", planRevisionId: progress.planRevisionId },
    totals: {
      walkAttemptsRecorded: progress.walks.length,
      stepObservations: progress.totalSteps,
      screenChanges: progress.walks.reduce((sum, walk) => sum + walk.screensAdvanced, 0),
      walksCreditedToCoverage: creditedWalks,
      activityOnlyWalks: progress.walks.length - creditedWalks,
      executionCasesCredited: creditedCaseIds.size,
      evidenceReferences: progress.totalEvidence,
      uniqueStableScreensObserved: hasAnyInspection ? globalSignatures.size : null,
      uniqueStableScreensExact: inspectionExact,
      returnScreenChangesObserved: hasAnyInspection ? returnScreenChanges : null,
      actionReceiptsObserved: hasAnyInspection ? actionReceipts : null,
      successfulActionReceiptsObserved: hasAnyInspection ? successfulActionReceipts : null,
      navigatorDefaultAnswersObserved: hasAnyInspection && navigatorDefaultKnown ? navigatorDefaultAnswers : null,
      visitedOrigins: [...globalOrigins].sort(),
      visitedOriginsExact: inspectionExact,
    },
    artifactInspection: {
      state: artifactState,
      indexedWalks: index?.totals.walks ?? 0,
      walksEligibleForInspection: eligible,
      walksInspected: inspectedWalks,
      unresolvedWalks: unresolved,
      unreadableOrMismatchedWalks,
      walksNotInspectedBecauseOfLimit: notInspectedBecauseOfLimit,
      inspectionLimit: MAX_ARTIFACT_WALKS_INSPECTED,
    },
    limitations: {
      unboundPlannedDecisions: unboundDecisions,
      walksWithoutUnboundDecisionCount: unboundUnknown,
      bindingRefusals,
      walksWithoutBindingRefusalCount: bindingUnknown,
      readerLimitationOccurrences,
      walksWithoutReaderLimitationCount: readerUnknown,
      readerLimitationKinds: [...readerKinds.entries()]
        .map(([kind, occurrences]) => ({ kind, occurrences }))
        .sort((a, b) => a.kind.localeCompare(b.kind)),
      blockedSteps,
      walksWithoutBlockedStepCount: blockedUnknown,
      captureFailureOccurrencesObserved: hasAnyInspection && captureFailuresKnown ? captureFailures : null,
      unfillableControlsObserved: hasAnyInspection && unfillableKnown ? unfillableControls : null,
      pageErrorOccurrencesObserved: hasAnyInspection ? pageErrors : null,
      consoleErrorOccurrencesObserved: hasAnyInspection ? consoleErrors : null,
      invalidScreenUrlsObserved: hasAnyInspection ? invalidScreenUrls : null,
      artifactDerivedCountsExact: inspectionExact,
      unrecognizedOutcomeRows: unrecognizedOutcomes,
    },
    outcomes: [...outcomeCounts.entries()]
      .map(([outcome, count]) => ({ outcome, walks: count }))
      .sort((a, b) => a.outcome.localeCompare(b.outcome)),
    walks,
    walkRowsReturned: walks.length,
    walkRowsOmitted: progress.walks.length - walks.length,
  };
}

function baseProjection(checkpoint: RunCheckpoint, sourceCheckpointHash: string): ExecutionActivityProjection {
  return {
    schemaVersion: EXECUTION_ACTIVITY_SCHEMA_VERSION,
    kind: "survey-qa-execution-activity",
    channel: "browser-activity-not-qa-coverage",
    runId: checkpoint.runId,
    revision: checkpoint.revision,
    observedAt: checkpoint.observedAt,
    sourceCheckpointHash,
    ledger: { state: "absent", planRevisionId: null },
    totals: {
      walkAttemptsRecorded: 0,
      stepObservations: 0,
      screenChanges: 0,
      walksCreditedToCoverage: 0,
      activityOnlyWalks: 0,
      executionCasesCredited: 0,
      evidenceReferences: 0,
      uniqueStableScreensObserved: null,
      uniqueStableScreensExact: false,
      returnScreenChangesObserved: null,
      actionReceiptsObserved: null,
      successfulActionReceiptsObserved: null,
      navigatorDefaultAnswersObserved: null,
      visitedOrigins: [],
      visitedOriginsExact: false,
    },
    artifactInspection: {
      state: "not-yet-indexed",
      indexedWalks: 0,
      walksEligibleForInspection: 0,
      walksInspected: 0,
      unresolvedWalks: 0,
      unreadableOrMismatchedWalks: 0,
      walksNotInspectedBecauseOfLimit: 0,
      inspectionLimit: MAX_ARTIFACT_WALKS_INSPECTED,
    },
    limitations: {
      unboundPlannedDecisions: 0,
      walksWithoutUnboundDecisionCount: 0,
      bindingRefusals: 0,
      walksWithoutBindingRefusalCount: 0,
      readerLimitationOccurrences: 0,
      walksWithoutReaderLimitationCount: 0,
      readerLimitationKinds: [],
      blockedSteps: 0,
      walksWithoutBlockedStepCount: 0,
      captureFailureOccurrencesObserved: null,
      unfillableControlsObserved: null,
      pageErrorOccurrencesObserved: null,
      consoleErrorOccurrencesObserved: null,
      invalidScreenUrlsObserved: null,
      artifactDerivedCountsExact: false,
      unrecognizedOutcomeRows: 0,
    },
    outcomes: [],
    walks: [],
    walkRowsReturned: 0,
    walkRowsOmitted: 0,
    privacy: {
      urls: "origins-only",
      queryTokens: "excluded",
      pageText: "excluded",
      screenSignatures: "counted-not-returned",
      actionTargets: "excluded",
      rawErrors: "excluded",
    },
  };
}

async function inspectArtifact(
  env: Env,
  runId: string,
  planRevisionId: string,
  walk: ParsedWalk,
  binding: WalkArtifactBinding,
): Promise<{ projection: WalkArtifactProjection; facts: ArtifactFacts | null }> {
  let entry;
  try {
    entry = await getBoundCatalogEntry(env, runId, binding.evidenceId);
  } catch {
    return { projection: emptyArtifact("artifact-unreadable"), facts: null };
  }
  if (entry === null) return { projection: emptyArtifact("catalog-missing"), facts: null };
  if (!bindingMatches(entry, binding)) return { projection: emptyArtifact("binding-mismatch"), facts: null };

  let bytes: Uint8Array;
  try {
    ({ bytes } = await getVerifiedEvidence(env, entry));
  } catch {
    return { projection: emptyArtifact("artifact-unreadable"), facts: null };
  }
  try {
    validatePathObservationBytes(bytes);
  } catch {
    return { projection: emptyArtifact("artifact-corrupt"), facts: null };
  }

  let root: Record<string, unknown>;
  try {
    root = object(JSON.parse(fatalUtf8.decode(bytes)) as unknown, "$artifact");
  } catch {
    return { projection: emptyArtifact("artifact-corrupt"), facts: null };
  }
  if (
    root.kind !== "v2-path-observation/1.0.0" ||
    root.runId !== runId ||
    root.planRevisionId !== planRevisionId ||
    root.pathId !== walk.pathId ||
    root.attemptId !== walk.attemptId ||
    root.tier !== walk.tier ||
    root.outcome !== walk.outcome
  ) {
    return { projection: emptyArtifact("artifact-identity-mismatch"), facts: null };
  }

  let facts: ArtifactFacts;
  try {
    facts = extractArtifactFacts(root, walk);
  } catch {
    return { projection: emptyArtifact("artifact-corrupt"), facts: null };
  }
  return {
    facts,
    projection: {
      state: "inspected",
      uniqueStableScreensObserved: facts.uniqueStableScreens,
      returnScreenChangesObserved: facts.returnScreenChanges,
      originsObserved: [...facts.origins].sort(),
      actionReceiptsObserved: facts.actionReceipts,
      successfulActionReceiptsObserved: facts.successfulActionReceipts,
      navigatorDefaultAnswersObserved: facts.navigatorDefaultAnswers,
      captureFailureOccurrences: facts.captureFailureOccurrences,
      unfillableControls: facts.unfillableControls,
      pageErrorOccurrences: facts.pageErrorOccurrences,
      consoleErrorOccurrences: facts.consoleErrorOccurrences,
      invalidScreenUrls: facts.invalidScreenUrls,
    },
  };
}

function extractArtifactFacts(root: Record<string, unknown>, walk: ParsedWalk): ArtifactFacts {
  const steps = array(root.steps, "$artifact.steps", MAX_ARRAY_ITEMS);
  if (steps.length !== walk.steps) invalid("$artifact.steps", "count does not match the execution ledger");
  const signatures = new Set<string>();
  const seenInWalk = new Set<string>();
  const origins = new Set<string>();
  let returnScreenChanges = 0;
  let advanced = 0;
  let actionReceipts = 0;
  let successfulActionReceipts = 0;
  let pageErrorOccurrences = 0;
  let consoleErrorOccurrences = 0;
  let invalidScreenUrls = 0;

  for (let index = 0; index < steps.length; index += 1) {
    const step = object(steps[index], `$artifact.steps[${index}]`);
    const before = screenIdentity(step.screenBefore, `$artifact.steps[${index}].screenBefore`);
    signatures.add(before.signature);
    seenInWalk.add(before.signature);
    if (before.origin === null) invalidScreenUrls += 1;
    else origins.add(before.origin);

    const didAdvance = booleanValue(step.advanced, `$artifact.steps[${index}].advanced`);
    if (didAdvance) advanced += 1;
    if (step.screenAfterAdvance !== null) {
      const after = screenIdentity(step.screenAfterAdvance, `$artifact.steps[${index}].screenAfterAdvance`);
      signatures.add(after.signature);
      if (didAdvance && seenInWalk.has(after.signature)) returnScreenChanges += 1;
      seenInWalk.add(after.signature);
      if (after.origin === null) invalidScreenUrls += 1;
      else origins.add(after.origin);
    }

    const actions = array(step.actions, `$artifact.steps[${index}].actions`, MAX_ARRAY_ITEMS);
    actionReceipts += actions.length;
    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const action = object(actions[actionIndex], `$artifact.steps[${index}].actions[${actionIndex}]`);
      if (booleanValue(action.ok, `$artifact.steps[${index}].actions[${actionIndex}].ok`)) successfulActionReceipts += 1;
    }
    pageErrorOccurrences += array(step.pageErrors, `$artifact.steps[${index}].pageErrors`, MAX_ARRAY_ITEMS).length;
    consoleErrorOccurrences += array(step.consoleErrors, `$artifact.steps[${index}].consoleErrors`, MAX_ARRAY_ITEMS).length;
  }
  if (advanced !== walk.screensAdvanced) invalid("$artifact.steps", "advanced count does not match the execution ledger");

  const navigatorDefaultAnswers = optionalInteger(root, "navigatorDefaultAnswerCount", "$artifact");
  const captureFailureOccurrences = optionalInteger(root, "captureFailureCount", "$artifact");
  const unfillableControls = optionalInteger(root, "unfillableControlCount", "$artifact");
  return {
    uniqueStableScreens: signatures.size,
    stableScreenSignatures: signatures,
    returnScreenChanges,
    origins,
    actionReceipts,
    successfulActionReceipts,
    navigatorDefaultAnswers,
    captureFailureOccurrences,
    unfillableControls,
    pageErrorOccurrences,
    consoleErrorOccurrences,
    invalidScreenUrls,
  };
}

function screenIdentity(value: unknown, path: string): { signature: string; origin: string | null } {
  const screen = object(value, path);
  const signature = nonempty(screen.screenSignature, `${path}.screenSignature`, MAX_TEXT);
  const rawUrl = nonempty(screen.url, `${path}.url`, 8_000);
  let origin: string | null = null;
  try {
    const url = new URL(rawUrl);
    if ((url.protocol === "https:" || url.protocol === "http:") && url.origin.length <= 500) origin = url.origin;
  } catch {
    origin = null;
  }
  return { signature, origin };
}

function emptyArtifact(state: ArtifactState): WalkArtifactProjection {
  return {
    state,
    uniqueStableScreensObserved: null,
    returnScreenChangesObserved: null,
    originsObserved: [],
    actionReceiptsObserved: null,
    successfulActionReceiptsObserved: null,
    navigatorDefaultAnswersObserved: null,
    captureFailureOccurrences: null,
    unfillableControls: null,
    pageErrorOccurrences: null,
    consoleErrorOccurrences: null,
    invalidScreenUrls: null,
  };
}

function bindingMatches(entry: Awaited<ReturnType<typeof getBoundCatalogEntry>> & {}, binding: WalkArtifactBinding): boolean {
  return (
    entry.evidenceId === binding.evidenceId &&
    (entry.artifactRef ?? null) === binding.artifactRef &&
    entry.contentHash === binding.contentHash &&
    entry.mediaType === binding.mediaType &&
    (entry.sourceEvidenceId ?? null) === binding.sourceEvidenceId &&
    entry.attemptId === binding.attemptId &&
    entry.routeId === binding.routeId &&
    entry.type === binding.type &&
    entry.size === binding.size
  );
}

function directEntryMatchesWalk(entry: EvidenceCatalogEntry, walk: ParsedWalk): boolean {
  return (
    entry.evidenceId === walk.observationEvidenceId &&
    entry.sourceEvidenceId === `EV-${walk.pathId}-observation` &&
    entry.attemptId === walk.attemptId &&
    entry.routeId === walk.pathId &&
    entry.type === "state" &&
    entry.mediaType === "application/json"
  );
}

function bindingFromEntry(entry: EvidenceCatalogEntry): WalkArtifactBinding {
  return {
    evidenceId: entry.evidenceId,
    artifactRef: entry.artifactRef ?? null,
    contentHash: entry.contentHash,
    mediaType: entry.mediaType,
    sourceEvidenceId: entry.sourceEvidenceId!,
    attemptId: entry.attemptId,
    routeId: entry.routeId,
    type: entry.type,
    size: entry.size,
  };
}

async function readProgressStrict(env: Env, runId: string): Promise<ParsedProgress | null> {
  const stored = await env.EVIDENCE.get(execProgressKey(runId));
  if (stored === null) return null;
  if (!Number.isSafeInteger(stored.size) || stored.size < 0 || stored.size > MAX_PROGRESS_BYTES) {
    corrupt("execution ledger byte size is outside its bounded envelope");
  }
  let parsed: unknown;
  try {
    const bytes = new Uint8Array(await stored.arrayBuffer());
    if (bytes.byteLength !== stored.size) corrupt("execution ledger stored/read byte sizes differ");
    parsed = JSON.parse(fatalUtf8.decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof ExecutionActivityCorruptError) throw error;
    corrupt("execution ledger is not strict UTF-8 JSON");
  }

  const root = closedObject(parsed, "$progress", [
    "kind",
    "runId",
    "planRevisionId",
    "walks",
    "floorDone",
    "explorationDone",
    "seedDone",
    "caseWitnessReceipts",
    "seedReceiptRefusals",
    "shimRequired",
    "hungPaths",
    "screenoutPivots",
    "shimEvidence",
    "totalSteps",
    "totalEvidence",
  ], ["kind", "runId", "planRevisionId", "walks", "floorDone", "explorationDone", "shimRequired", "shimEvidence", "totalSteps", "totalEvidence"]);
  literal(root.kind, "v2-execution-progress/1.0.0", "$progress.kind");
  const parsedRunId = nonempty(root.runId, "$progress.runId", 300);
  if (parsedRunId !== runId) corrupt("execution ledger run identity does not match its key");
  const planRevisionId = nonempty(root.planRevisionId, "$progress.planRevisionId", 300);
  const walkValues = array(root.walks, "$progress.walks", MAX_WALKS);
  const walks = walkValues.map((walk, index) => parseWalk(walk, index));
  stringArray(root.floorDone, "$progress.floorDone", MAX_WALKS, 500, true);
  stringArray(root.explorationDone, "$progress.explorationDone", MAX_WALKS, 500, true);
  if (Object.prototype.hasOwnProperty.call(root, "seedDone")) {
    stringArray(root.seedDone, "$progress.seedDone", MAX_WALKS, 500, true);
  }
  if (Object.prototype.hasOwnProperty.call(root, "caseWitnessReceipts")) {
    parseCaseWitnessReceipts(root.caseWitnessReceipts, "$progress.caseWitnessReceipts");
  }
  if (Object.prototype.hasOwnProperty.call(root, "seedReceiptRefusals")) {
    parseSeedReceiptRefusals(root.seedReceiptRefusals, "$progress.seedReceiptRefusals");
  }
  booleanValue(root.shimRequired, "$progress.shimRequired");
  nullableString(root.shimEvidence, "$progress.shimEvidence", 1_000);
  if (Object.prototype.hasOwnProperty.call(root, "hungPaths")) {
    stringArray(root.hungPaths, "$progress.hungPaths", MAX_WALKS, 500, true);
  }
  if (Object.prototype.hasOwnProperty.call(root, "screenoutPivots")) {
    const pivots = object(root.screenoutPivots, "$progress.screenoutPivots");
    if (Object.keys(pivots).length > MAX_WALKS) invalid("$progress.screenoutPivots", "too many path entries");
    for (const [pathId, value] of Object.entries(pivots)) {
      if (pathId.length === 0 || pathId.length > 500) invalid("$progress.screenoutPivots", "path id is outside its bound");
      integer(value, `$progress.screenoutPivots.${pathId}`);
    }
  }
  const totalSteps = integer(root.totalSteps, "$progress.totalSteps");
  const totalEvidence = integer(root.totalEvidence, "$progress.totalEvidence");
  const computedSteps = walks.reduce((sum, walk) => sum + walk.steps, 0);
  const computedEvidence = walks.reduce((sum, walk) => sum + walk.evidenceCount, 0);
  if (totalSteps !== computedSteps) corrupt("execution ledger totalSteps does not recompute from walk rows");
  if (totalEvidence !== computedEvidence) corrupt("execution ledger totalEvidence does not recompute from walk rows");
  const creditedCases = new Set<string>();
  for (const walk of walks) {
    for (const caseId of walk.caseIds) {
      if (creditedCases.has(caseId)) corrupt("one sealed execution case is credited by more than one walk row");
      creditedCases.add(caseId);
    }
  }
  return { runId: parsedRunId, planRevisionId, walks, totalSteps, totalEvidence };
}

function parseWalk(value: unknown, index: number): ParsedWalk {
  const path = `$progress.walks[${index}]`;
  const root = closedObject(value, path, [
    "pathId",
    "tier",
    "attemptId",
    "outcome",
    "outcomeDetail",
    "steps",
    "wallMs",
    "shimmed",
    "loadCrash",
    "evidenceCount",
    "caseIds",
    "exercised",
    "plannedDecisions",
    "matchedDecisions",
    "constrainingDecisions",
    "matchedConstraining",
    "screensAdvanced",
    "blockedSteps",
    "ending",
    "pivot",
    "unboundDecisions",
    "bindingRefusalCount",
    "readerLimitations",
    "readerLimitationCount",
    "observationEvidenceId",
    "at",
  ], [
    "pathId",
    "tier",
    "attemptId",
    "outcome",
    "outcomeDetail",
    "steps",
    "wallMs",
    "shimmed",
    "loadCrash",
    "evidenceCount",
    "caseIds",
    "exercised",
    "plannedDecisions",
    "matchedDecisions",
    "constrainingDecisions",
    "matchedConstraining",
    "screensAdvanced",
    "at",
  ]);
  const steps = integer(root.steps, `${path}.steps`);
  const screensAdvanced = integer(root.screensAdvanced, `${path}.screensAdvanced`);
  if (screensAdvanced > steps) invalid(`${path}.screensAdvanced`, "cannot exceed step observations");
  const plannedDecisions = integer(root.plannedDecisions, `${path}.plannedDecisions`);
  const matchedDecisions = integer(root.matchedDecisions, `${path}.matchedDecisions`);
  const constrainingDecisions = integer(root.constrainingDecisions, `${path}.constrainingDecisions`);
  const matchedConstraining = integer(root.matchedConstraining, `${path}.matchedConstraining`);
  if (matchedDecisions > plannedDecisions) invalid(`${path}.matchedDecisions`, "cannot exceed planned decisions");
  if (matchedConstraining > constrainingDecisions) invalid(`${path}.matchedConstraining`, "cannot exceed constraining decisions");
  const exercised = booleanValue(root.exercised, `${path}.exercised`);
  const caseIds = stringArray(root.caseIds, `${path}.caseIds`, MAX_CASE_IDS_PER_WALK, 1_000, true);
  if (caseIds.length > 0 && !exercised) invalid(`${path}.caseIds`, "a non-exercised walk cannot credit cases");
  // These two fields are intentionally not projected — both may carry free text or internal
  // attempt identity — but accepting arbitrary shapes here would make this a permissive parser
  // for a ledger it otherwise calls strict. Validate, then discard at the privacy boundary.
  nullableString(root.outcomeDetail, `${path}.outcomeDetail`, MAX_TEXT);
  if (Object.prototype.hasOwnProperty.call(root, "pivot")) parsePivot(root.pivot, `${path}.pivot`);
  const ending = Object.prototype.hasOwnProperty.call(root, "ending")
    ? parseEnding(root.ending, `${path}.ending`)
    : null;
  const readerLimitations = Object.prototype.hasOwnProperty.call(root, "readerLimitations")
    ? parseReaderLimitations(root.readerLimitations, `${path}.readerLimitations`)
    : null;
  const readerLimitationCount = optionalInteger(root, "readerLimitationCount", path);
  if (readerLimitations !== null && readerLimitationCount !== null) {
    const sum = readerLimitations.reduce((total, limitation) => total + limitation.count, 0);
    if (sum !== readerLimitationCount) invalid(`${path}.readerLimitationCount`, "does not sum the limitation rows");
  }
  return {
    pathId: nonempty(root.pathId, `${path}.pathId`, 500),
    attemptId: nonempty(root.attemptId, `${path}.attemptId`, 500),
    tier: oneOf(root.tier, [1, 2] as const, `${path}.tier`),
    outcome: nonempty(root.outcome, `${path}.outcome`, 500),
    steps,
    wallMs: finiteNonnegative(root.wallMs, `${path}.wallMs`),
    shimmed: booleanValue(root.shimmed, `${path}.shimmed`),
    loadCrash: booleanValue(root.loadCrash, `${path}.loadCrash`),
    evidenceCount: integer(root.evidenceCount, `${path}.evidenceCount`),
    caseIds,
    exercised,
    plannedDecisions,
    matchedDecisions,
    constrainingDecisions,
    matchedConstraining,
    screensAdvanced,
    blockedSteps: optionalInteger(root, "blockedSteps", path),
    ending,
    unboundDecisions: Object.prototype.hasOwnProperty.call(root, "unboundDecisions")
      ? parseUnboundDecisions(root.unboundDecisions, `${path}.unboundDecisions`)
      : null,
    bindingRefusalCount: optionalInteger(root, "bindingRefusalCount", path),
    readerLimitations,
    readerLimitationCount,
    observationEvidenceId: Object.prototype.hasOwnProperty.call(root, "observationEvidenceId")
      ? patterned(root.observationEvidenceId, /^ev_[0-9a-hjkmnp-tv-z]{12}$/, `${path}.observationEvidenceId`)
      : null,
    at: timestamp(root.at, `${path}.at`),
  };
}

function parsePivot(value: unknown, path: string): void {
  const root = closedObject(value, path, ["retryOf", "ordinal", "reason"], ["retryOf", "ordinal", "reason"]);
  nonempty(root.retryOf, `${path}.retryOf`, 500);
  const ordinal = integer(root.ordinal, `${path}.ordinal`);
  if (ordinal === 0) invalid(`${path}.ordinal`, "must be a positive pivot ordinal");
  nonempty(root.reason, `${path}.reason`, MAX_TEXT);
}

/** W5 audit rows are validated but never returned: they contain answer labels and values. */
function parseCaseWitnessReceipts(value: unknown, path: string): void {
  const hashes = [
    "receiptHash",
    "seedCertificateHash",
    "expectedHistoryDigest",
    "observedHistoryDigest",
    "performedHistoryDigest",
    "beforePresentationHash",
    "afterPresentationHash",
  ] as const;
  array(value, path, MAX_WALKS).forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const root = closedObject(entry, itemPath, [
      "kind",
      "receiptHash",
      "caseId",
      "alternativeId",
      "seedCertificateHash",
      "attemptId",
      "pathId",
      "expectedOccurrenceId",
      "observedOccurrenceId",
      "expectedHistoryDigest",
      "observedHistoryDigest",
      "performedHistoryDigest",
      "beforePresentationHash",
      "afterPresentationHash",
      "beforeEvidenceId",
      "afterEvidenceId",
      "observationEvidenceId",
      "actionIndex",
      "performedAction",
    ], [
      "kind",
      "receiptHash",
      "caseId",
      "alternativeId",
      "seedCertificateHash",
      "attemptId",
      "pathId",
      "expectedOccurrenceId",
      "observedOccurrenceId",
      "expectedHistoryDigest",
      "observedHistoryDigest",
      "performedHistoryDigest",
      "beforePresentationHash",
      "afterPresentationHash",
      "beforeEvidenceId",
      "afterEvidenceId",
      "observationEvidenceId",
      "actionIndex",
      "performedAction",
    ]);
    literal(root.kind, "v2-case-witness-receipt/1.0.0", `${itemPath}.kind`);
    for (const field of hashes) patterned(root[field], /^sha256:[0-9a-f]{64}$/, `${itemPath}.${field}`);
    for (const field of ["caseId", "alternativeId", "attemptId", "pathId"] as const) {
      nonempty(root[field], `${itemPath}.${field}`, 1_000);
    }
    const expectedOccurrence = nonempty(root.expectedOccurrenceId, `${itemPath}.expectedOccurrenceId`, 500);
    const observedOccurrence = nonempty(root.observedOccurrenceId, `${itemPath}.observedOccurrenceId`, 500);
    if (expectedOccurrence !== observedOccurrence) invalid(itemPath, "expected and observed occurrence identities differ");
    const expectedHistory = root.expectedHistoryDigest as string;
    const observedHistory = root.observedHistoryDigest as string;
    if (expectedHistory !== observedHistory) invalid(itemPath, "expected and observed history digests differ");
    nonempty(root.beforeEvidenceId, `${itemPath}.beforeEvidenceId`, 1_000);
    nonempty(root.afterEvidenceId, `${itemPath}.afterEvidenceId`, 1_000);
    patterned(
      root.observationEvidenceId,
      /^ev_[0-9a-hjkmnp-tv-z]{12}$/,
      `${itemPath}.observationEvidenceId`,
    );
    integer(root.actionIndex, `${itemPath}.actionIndex`);
    parsePerformedAction(root.performedAction, `${itemPath}.performedAction`);
  });
}

function parseSeedReceiptRefusals(value: unknown, path: string): void {
  array(value, path, MAX_WALKS).forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const root = closedObject(
      entry,
      itemPath,
      ["alternativeId", "caseId", "attemptId", "reason"],
      ["alternativeId", "caseId", "attemptId", "reason"],
    );
    nonempty(root.alternativeId, `${itemPath}.alternativeId`, 1_000);
    nonempty(root.caseId, `${itemPath}.caseId`, 1_000);
    nonempty(root.attemptId, `${itemPath}.attemptId`, 1_000);
    nonempty(root.reason, `${itemPath}.reason`, MAX_TEXT);
  });
}

function parsePerformedAction(value: unknown, path: string): void {
  const root = closedObject(
    value,
    path,
    ["kind", "targetIdx", "targetLabel", "targetCode", "value", "ok", "detail", "selectReadback", "choiceReadback"],
    ["kind", "targetIdx", "targetLabel", "targetCode", "value", "ok", "detail"],
  );
  oneOf(root.kind, [
    "click-option",
    "select-option",
    "type-text",
    "set-value",
    "refuse-fill",
    "clear-text",
    "click-next",
    "click-back",
    "select-grid-cell",
    "open",
  ] as const, `${path}.kind`);
  if (root.targetIdx !== null) integer(root.targetIdx, `${path}.targetIdx`);
  nullableString(root.targetLabel, `${path}.targetLabel`, MAX_TEXT);
  nullableString(root.targetCode, `${path}.targetCode`, MAX_TEXT);
  nullableString(root.value, `${path}.value`, MAX_TEXT);
  booleanValue(root.ok, `${path}.ok`);
  nullableString(root.detail, `${path}.detail`, MAX_TEXT);
  if (Object.prototype.hasOwnProperty.call(root, "selectReadback") && root.selectReadback !== null) {
    const readback = closedObject(root.selectReadback, `${path}.selectReadback`, ["order", "code", "label"], ["order", "code", "label"]);
    integer(readback.order, `${path}.selectReadback.order`);
    nullableString(readback.code, `${path}.selectReadback.code`, MAX_TEXT);
    nullableString(readback.label, `${path}.selectReadback.label`, MAX_TEXT);
  }
  if (Object.prototype.hasOwnProperty.call(root, "choiceReadback") && root.choiceReadback !== null) {
    const readback = closedObject(
      root.choiceReadback,
      `${path}.choiceReadback`,
      ["idx", "type", "name", "formOwner", "unnamedControlIdx", "checked", "checkedGroupIdxs"],
      ["idx", "type", "name", "formOwner", "unnamedControlIdx", "checked", "checkedGroupIdxs"],
    );
    const idx = integer(readback.idx, `${path}.choiceReadback.idx`);
    oneOf(readback.type, ["radio", "checkbox"] as const, `${path}.choiceReadback.type`);
    const name = nullableString(readback.name, `${path}.choiceReadback.name`, MAX_TEXT);
    if (name === "") invalid(`${path}.choiceReadback.name`, "empty native names must use the unnamed null identity");
    const formOwner = readback.formOwner === null
      ? null
      : integer(readback.formOwner, `${path}.choiceReadback.formOwner`);
    const unnamedControlIdx = readback.unnamedControlIdx === null
      ? null
      : integer(readback.unnamedControlIdx, `${path}.choiceReadback.unnamedControlIdx`);
    if (name === null && unnamedControlIdx !== idx) {
      invalid(`${path}.choiceReadback.unnamedControlIdx`, "an unnamed native choice must carry its own control index");
    }
    if (name !== null && unnamedControlIdx !== null) {
      invalid(`${path}.choiceReadback.unnamedControlIdx`, "a named native choice cannot carry an unnamed singleton identity");
    }
    // A null form owner is a real part of the identity (the control is not associated with a
    // form), not a missing decoder default. Reading it keeps same-name controls in different
    // native form owners from being silently merged; the privacy projection discards the tuple.
    void formOwner;
    const checked = booleanValue(readback.checked, `${path}.choiceReadback.checked`);
    const checkedGroupIdxs = array(
      readback.checkedGroupIdxs,
      `${path}.choiceReadback.checkedGroupIdxs`,
      MAX_ARRAY_ITEMS,
    ).map((groupIdx, index) => integer(groupIdx, `${path}.choiceReadback.checkedGroupIdxs[${index}]`));
    if (new Set(checkedGroupIdxs).size !== checkedGroupIdxs.length) {
      invalid(`${path}.choiceReadback.checkedGroupIdxs`, "must not contain duplicate control indices");
    }
    if (checked !== checkedGroupIdxs.includes(idx)) {
      invalid(`${path}.choiceReadback.checkedGroupIdxs`, "must agree with the target control's checked state");
    }
  }
}

function parseUnboundDecisions(value: unknown, path: string): number {
  const rows = array(value, path, MAX_ARRAY_ITEMS);
  rows.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const root = closedObject(entry, itemPath, ["question", "wanted", "reason"], ["question", "wanted", "reason"]);
    nonempty(root.question, `${itemPath}.question`, 1_000);
    stringArray(root.wanted, `${itemPath}.wanted`, MAX_CASE_IDS_PER_WALK, MAX_TEXT, false);
    nonempty(root.reason, `${itemPath}.reason`, MAX_TEXT);
  });
  return rows.length;
}

function parseEnding(value: unknown, path: string): ParsedWalk["ending"] {
  const root = closedObject(value, path, ["kind", "evidence"], ["kind", "evidence"]);
  const kind = oneOf(root.kind, ["completed", "screened-out", "stalled", "unclassified"] as const, `${path}.kind`);
  const evidence = stringArray(root.evidence, `${path}.evidence`, 1_000, MAX_TEXT, false);
  if (evidence.length === 0) invalid(`${path}.evidence`, "must name at least one deciding fact");
  return kind;
}

function parseReaderLimitations(value: unknown, path: string): ParsedReaderLimitation[] {
  return array(value, path, MAX_ARRAY_ITEMS).map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const root = closedObject(entry, itemPath, ["stepIndex", "kind", "detail", "count"], ["stepIndex", "kind", "detail", "count"]);
    stepOrdinal(root.stepIndex, `${itemPath}.stepIndex`);
    const kind = nonempty(root.kind, `${itemPath}.kind`, 500);
    nonempty(root.detail, `${itemPath}.detail`, MAX_TEXT);
    return { kind, count: integer(root.count, `${itemPath}.count`) };
  });
}

function publicOutcome(value: string): string {
  return PUBLIC_OUTCOMES.has(value) ? value : "unrecognized";
}

function safeLimitationKind(value: string): string {
  return SAFE_LIMITATION_KIND.test(value) ? value : "unrecognized";
}

function optionalInteger(root: Record<string, unknown>, key: string, path: string): number | null {
  return Object.prototype.hasOwnProperty.call(root, key) ? integer(root[key], `${path}.${key}`) : null;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "must be an object");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid(path, "must be a plain object");
  return value as Record<string, unknown>;
}

function closedObject(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  const root = object(value, path);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(root)) if (!allowedSet.has(key)) invalid(`${path}.${key}`, "unknown field");
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(root, key)) invalid(path, `missing required field ${key}`);
  return root;
}

function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) invalid(path, "must be an array");
  if (value.length > max) invalid(path, `must contain at most ${max} items`);
  return value;
}

function stringArray(
  value: unknown,
  path: string,
  maxItems: number,
  maxChars: number,
  unique: boolean,
): string[] {
  const values = array(value, path, maxItems).map((entry, index) => nonempty(entry, `${path}[${index}]`, maxChars));
  if (unique && new Set(values).size !== values.length) invalid(path, "must not contain duplicates");
  return values;
}

function nonempty(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) invalid(path, `must be a non-empty string of at most ${max} characters`);
  return value;
}

function patterned(value: unknown, pattern: RegExp, path: string): string {
  const text = nonempty(value, path, MAX_TEXT);
  if (!pattern.test(text)) invalid(path, `must match ${pattern.source}`);
  return text;
}

function nullableString(value: unknown, path: string, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > max) invalid(path, `must be null or a string of at most ${max} characters`);
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(path, "must be a non-negative safe integer");
  return value as number;
}

/**
 * Step ordinals are whole steps (k) or the walker's recovery interleave (k + 0.5): the driver
 * records the recovery it runs after a blocked step as `stepIndex + 0.5` by design. Accept
 * exactly the writer's domain — halves and nothing finer.
 */
function stepOrdinal(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value * 2)) {
    invalid(path, "must be a non-negative whole or half step ordinal");
  }
  return value;
}

function finiteNonnegative(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(path, "must be a finite non-negative number");
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path, "must be a boolean");
  return value;
}

function timestamp(value: unknown, path: string): string {
  const text = nonempty(value, path, 100);
  if (!Number.isFinite(Date.parse(text))) invalid(path, "must be an ISO timestamp");
  return text;
}

function literal<T extends string>(value: unknown, expected: T, path: string): T {
  if (value !== expected) invalid(path, `must equal ${expected}`);
  return expected;
}

function oneOf<const T extends readonly (string | number)[]>(value: unknown, values: T, path: string): T[number] {
  if (!values.includes(value as never)) invalid(path, `must be one of ${values.join(", ")}`);
  return value as T[number];
}

function invalid(path: string, detail: string): never {
  corrupt(`${path}: ${detail}`);
}

function corrupt(detail: string): never {
  throw new ExecutionActivityCorruptError(detail);
}

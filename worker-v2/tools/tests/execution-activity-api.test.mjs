/**
 * Privacy-safe partial browser activity — the watch page's evidence source.
 *
 * The pinned counterexample is the shape measured on the current live run: many transitions
 * can alternate between two stable screens while closing no QA case. The assertions below
 * make `44 transitions -> 44 pages` and `activity -> coverage` both fail loudly. They also put
 * secrets in every raw artifact surface the API promises not to serialize.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { seedRun, testEnv, worker } from "./_helpers.mjs";
import { readFileSync } from "node:fs";

const PLAN_REVISION_ID = "plan_activity_projection_01";
const AT = "2026-08-13T01:00:00.000Z";
const utf8 = new TextEncoder();
const HASH = `sha256:${"a".repeat(64)}`;
const SECRETS = [
  "PRIVATE_USER",
  "PRIVATE_PASS",
  "PRIVATE_PATH",
  "PRIVATE_QUERY",
  "PRIVATE_FRAGMENT",
  "RAW_SIGNATURE_ALPHA",
  "RAW_SIGNATURE_BETA",
  "RAW_PAGE_TITLE",
  "RAW_VISIBLE_TEXT",
  "RAW_ACTION_LABEL",
  "RAW_ACTION_DETAIL",
  "RAW_PAGE_ERROR",
  "RAW_CONSOLE_ERROR",
  "RAW_OUTCOME_DETAIL",
  "RAW_ENDING_EVIDENCE",
  "RAW_CAPTURE_FAILURE_DETAIL",
  "RAW_SEED_REFUSAL_REASON",
];

const surveyUrl = (screen) =>
  `https://PRIVATE_USER:PRIVATE_PASS@survey.example.test/PRIVATE_PATH/${screen}` +
  `?token=PRIVATE_QUERY&screen=${screen}#PRIVATE_FRAGMENT`;

const screen = (signature) => ({
  url: surveyUrl(signature),
  screenSignature: signature,
  title: "RAW_PAGE_TITLE",
  visibleText: "RAW_VISIBLE_TEXT",
  controls: [{ idx: 7, label: "RAW_ACTION_LABEL", value: "PRIVATE_QUERY" }],
});

const steps = () => Array.from({ length: 44 }, (_, index) => {
  const before = index % 2 === 0 ? "RAW_SIGNATURE_ALPHA" : "RAW_SIGNATURE_BETA";
  const after = index % 2 === 0 ? "RAW_SIGNATURE_BETA" : "RAW_SIGNATURE_ALPHA";
  return {
    stepIndex: index,
    decisionQuestion: null,
    decisionSource: "navigator-default",
    requested: null,
    screenBefore: screen(before),
    screenAfterAction: null,
    screenAfterAdvance: screen(after),
    actions: [{
      kind: "click-next",
      targetIdx: 7,
      targetLabel: "RAW_ACTION_LABEL",
      targetCode: null,
      value: null,
      ok: true,
      detail: "RAW_ACTION_DETAIL",
    }],
    requestedButNotOffered: [],
    advanced: true,
    blocked: false,
    blockedReason: null,
    pageErrors: index === 0 ? ["RAW_PAGE_ERROR"] : [],
    consoleErrors: index === 0 ? ["RAW_CONSOLE_ERROR"] : [],
    evidence: {},
    wallMs: 10,
  };
});

function artifact(runId, pathId, attemptId, captureKnowledge) {
  const value = {
    kind: "v2-path-observation/1.0.0",
    runId,
    pathId,
    tier: 1,
    attemptId,
    planRevisionId: PLAN_REVISION_ID,
    surveyUrl: surveyUrl("root"),
    startedAt: AT,
    endedAt: "2026-08-13T01:00:01.000Z",
    wallMs: 440,
    plannedWitnesses: [],
    steps: steps(),
    outcome: "cycle-detected",
    outcomeDetail: "RAW_OUTCOME_DETAIL",
    ending: { kind: "stalled", evidence: ["RAW_ENDING_EVIDENCE"] },
    shimmed: false,
    shimNote: null,
    loadFailure: null,
    unboundDecisions: [],
    bindingRefusalCount: 0,
    readerLimitations: [],
    readerLimitationCount: 0,
    navigatorDefaultAnswerCount: 44,
    evidenceIds: [],
    viewport: { width: 1280, height: 900 },
  };
  if (captureKnowledge === "known-failures") {
    value.screenCaptures = [];
    value.screenCaptureCount = 0;
    value.captureFailures = [{
      kind: "screen-read-failed",
      detail: "RAW_CAPTURE_FAILURE_DETAIL",
      count: 2,
      at: AT,
      stepIndex: 0,
      slot: "before",
    }];
    value.captureFailureCount = 2;
    value.unfillableControls = [];
    value.unfillableControlCount = 0;
  }
  return value;
}

function witnessReceipt(caseId, attemptId, pathId, observationEvidenceId) {
  return {
    kind: "v2-case-witness-receipt/1.0.0",
    receiptHash: HASH,
    caseId,
    alternativeId: pathId,
    seedCertificateHash: HASH,
    attemptId,
    pathId,
    expectedOccurrenceId: "occ_activity_fixture",
    observedOccurrenceId: "occ_activity_fixture",
    expectedHistoryDigest: HASH,
    observedHistoryDigest: HASH,
    performedHistoryDigest: HASH,
    beforePresentationHash: HASH,
    afterPresentationHash: HASH,
    beforeEvidenceId: "ev_before_fixture",
    afterEvidenceId: "ev_after_fixture",
    observationEvidenceId,
    actionIndex: 0,
    performedAction: {
      kind: "click-option",
      targetIdx: 1,
      targetLabel: "RAW_ACTION_LABEL",
      targetCode: "PRIVATE_QUERY",
      value: null,
      ok: true,
      detail: "RAW_ACTION_DETAIL",
      choiceReadback: {
        idx: 1,
        type: "radio",
        name: "PRIVATE_USER",
        formOwner: 0,
        unnamedControlIdx: null,
        checked: true,
        checkedGroupIdxs: [1],
      },
    },
  };
}

async function activityRun({
  captureKnowledge = "known-failures",
  withIndex = true,
  withDirectPointer = false,
  directIdentityMismatch = false,
  credited = false,
  corruptTotalSteps = false,
  receiptMutation = null,
} = {}) {
  const mod = await worker();
  const env = testEnv();
  const seeded = await seedRun(mod, env);
  const pathId = "path_activity_loop";
  const attemptId = `attempt_${seeded.runId.slice(-8)}`;
  const caseIds = credited ? ["fi_seed_activity"] : [];
  const walk = {
    pathId,
    tier: 1,
    attemptId,
    outcome: "cycle-detected",
    outcomeDetail: "RAW_OUTCOME_DETAIL",
    steps: 44,
    wallMs: 440,
    shimmed: false,
    loadCrash: false,
    evidenceCount: 0,
    caseIds,
    exercised: credited,
    plannedDecisions: 0,
    matchedDecisions: 0,
    constrainingDecisions: 0,
    matchedConstraining: 0,
    screensAdvanced: 44,
    blockedSteps: 0,
    ending: { kind: "stalled", evidence: ["RAW_ENDING_EVIDENCE"] },
    unboundDecisions: [],
    bindingRefusalCount: 0,
    readerLimitations: [],
    readerLimitationCount: 0,
    at: AT,
  };
  let artifactEntry = null;
  if ((withIndex || withDirectPointer) && !corruptTotalSteps) {
    const bytes = utf8.encode(JSON.stringify(artifact(seeded.runId, pathId, attemptId, captureKnowledge)));
    // The strict production validator is exercised again by the read endpoint; validate here
    // too so a malformed fixture cannot accidentally prove only an error path.
    mod.visualWork.validatePathObservationBytes(bytes);
    artifactEntry = await mod.evidence.putEvidence(env, {
      runId: seeded.runId,
      bytes,
      mediaType: "application/json",
      type: "state",
      sourceEvidenceId: `EV-${pathId}-observation`,
      artifactRef: `walks/${attemptId}.json`,
      attemptId,
      routeId: directIdentityMismatch ? `${pathId}_mismatch` : pathId,
      witnesses: [],
    });
    if (withDirectPointer) walk.observationEvidenceId = artifactEntry.evidenceId;
  }
  const receipt = credited
    ? witnessReceipt(caseIds[0], attemptId, pathId, artifactEntry?.evidenceId ?? "ev_123456789abc")
    : null;
  if (receipt && receiptMutation) receiptMutation(receipt);
  const progress = {
    kind: "v2-execution-progress/1.0.0",
    runId: seeded.runId,
    planRevisionId: PLAN_REVISION_ID,
    walks: [walk],
    floorDone: [pathId],
    explorationDone: [],
    seedDone: credited ? [pathId] : [],
    caseWitnessReceipts: receipt ? [receipt] : [],
    seedReceiptRefusals: credited ? [] : [{
      alternativeId: "seed_private",
      caseId: "fi_private",
      attemptId,
      reason: "RAW_SEED_REFUSAL_REASON",
    }],
    shimRequired: false,
    hungPaths: [],
    screenoutPivots: {},
    shimEvidence: null,
    totalSteps: corruptTotalSteps ? 43 : 44,
    totalEvidence: 0,
  };
  await env.EVIDENCE.put(mod.executeBatch.execProgressKey(seeded.runId), JSON.stringify(progress), {
    httpMetadata: { contentType: "application/json" },
  });

  await mod.checkpoint.updateCheckpoint(env, seeded.runId, (draft) => {
    draft.execution = {
      batchIndex: 1,
      sessionId: null,
      sessionOpenedAt: null,
      pendingCaseIds: [],
      completedCaseIds: caseIds,
      planRevisionId: PLAN_REVISION_ID,
    };
    draft.attempts = { started: 1, completed: 1 };
    draft.currentAttempt = null;
  });

  if (withIndex && !corruptTotalSteps) {
    const index = mod.walkArtifactIndex.buildWalkArtifactIndex({
      runId: seeded.runId,
      planRevisionId: PLAN_REVISION_ID,
      walks: [walk],
      catalog: [artifactEntry],
    });
    await mod.walkArtifactIndex.putWalkArtifactIndex(
      env.EVIDENCE,
      mod.keys.walkArtifactIndexKey(seeded.runId),
      index,
    );
  }

  return { mod, env, runId: seeded.runId };
}

async function getActivity(bed) {
  const response = await bed.mod.apiRuns.getExecutionActivity(
    new Request(`https://v2.invalid/api/v2/runs/${bed.runId}/execution-activity`),
    bed.env,
    bed.runId,
  );
  return { response, body: await response.json() };
}

suite("execution activity API: metric grain and privacy", () => {
  test("the watch transport polls per-walk activity during execution even when checkpoint revision is unchanged", () => {
    const source = readFileSync(new URL("../../public/watch.js", import.meta.url), "utf8");
    assert(source.includes("ACTIVITY_VISIBLE_MS = 15000"), "activity refresh lost its independent bounded cadence");
    assert(source.includes('status.phases[i].name === "executing"'), "refresh is no longer scoped to browser execution");
    assert(
      /await fetchCoverage\(\);\s*}\s*var attempts[\s\S]*if \(activityRefreshDue\(status, attemptsStarted\)\)/.test(source),
      "activity refresh fell back inside the checkpoint-revision branch and will hide per-walk commits",
    );
  });

  test("44 screen changes across an A/B loop remain 2 unique stable screens and 0 credited walks", async () => {
    const bed = await activityRun();
    const { response, body } = await getActivity(bed);
    assertEq(response.status, 200, JSON.stringify(body));
    assertEq(body.channel, "browser-activity-not-qa-coverage");
    assertEq(body.totals.walkAttemptsRecorded, 1);
    assertEq(body.totals.stepObservations, 44);
    assertEq(body.totals.screenChanges, 44, "transitions are their own activity grain");
    assertEq(body.totals.uniqueStableScreensObserved, 2, "A/B revisits must deduplicate");
    assertEq(body.totals.uniqueStableScreensExact, true);
    assertEq(body.totals.returnScreenChangesObserved, 43, "all changes after the first return to a seen screen");
    assertEq(body.totals.walksCreditedToCoverage, 0, "movement must not mint QA credit");
    assertEq(body.totals.activityOnlyWalks, 1);
    assertEq(body.totals.executionCasesCredited, 0);
    assertEq(body.totals.actionReceiptsObserved, 44);
    assertEq(body.totals.successfulActionReceiptsObserved, 44, "this counts receipts marked ok, not survey success");
    assertEq(body.totals.navigatorDefaultAnswersObserved, 44);
    assertEq(body.limitations.captureFailureOccurrencesObserved, 2, "measured failures stay measured");
    assertEq(body.limitations.pageErrorOccurrencesObserved, 1);
    assertEq(body.limitations.consoleErrorOccurrencesObserved, 1);
    assertEq(JSON.stringify(body.totals.visitedOrigins), JSON.stringify(["https://survey.example.test"]));
    assertEq(body.totals.visitedOriginsExact, true);
    assertEq(body.walks[0].outcome, "cycle-detected", "W4's named stop must not become unrecognized");
    assertEq(body.walks[0].ending, "stalled");
    assertEq(body.walks[0].creditedToCoverage, false);
    assertEq(body.outcomes[0].outcome, "cycle-detected");
    assertEq(body.limitations.unrecognizedOutcomeRows, 0);

    const serialized = JSON.stringify(body);
    for (const secret of SECRETS) {
      assert(!serialized.includes(secret), `${secret} escaped the privacy projection`);
    }
    assertEq(body.privacy.urls, "origins-only");
    assertEq(body.privacy.queryTokens, "excluded");
    assertEq(body.privacy.pageText, "excluded");
    assertEq(body.privacy.screenSignatures, "counted-not-returned");
  });

  test("legacy missing capture fields stay unknown, distinct from an observed failure count", async () => {
    const bed = await activityRun({ captureKnowledge: "legacy-missing", credited: true });
    const { response, body } = await getActivity(bed);
    assertEq(response.status, 200, JSON.stringify(body));
    assertEq(body.limitations.captureFailureOccurrencesObserved, null, "missing capture fields are not a zero");
    assertEq(body.limitations.unfillableControlsObserved, null, "legacy absence stays unknown");
    assertEq(body.totals.walksCreditedToCoverage, 1, "W5 receipt-bearing progress remains readable");
    assertEq(body.totals.executionCasesCredited, 1);
    const serialized = JSON.stringify(body);
    assert(!serialized.includes("RAW_ACTION_LABEL"), "W5 performed-action label escaped");
    assert(!serialized.includes("PRIVATE_USER"), "W5 receipt identity escaped");
    assert(!serialized.includes("formOwner"), "native form-owner identity escaped the privacy projection");
    assert(!serialized.includes("unnamedControlIdx"), "unnamed singleton identity escaped the privacy projection");
  });

  test("named and unnamed native choice receipt identities are accepted but never projected", async () => {
    const named = await activityRun({ credited: true });
    const namedResult = await getActivity(named);
    assertEq(namedResult.response.status, 200, JSON.stringify(namedResult.body));

    const unnamed = await activityRun({
      credited: true,
      receiptMutation: (receipt) => {
        receipt.performedAction.choiceReadback.name = null;
        receipt.performedAction.choiceReadback.unnamedControlIdx = receipt.performedAction.choiceReadback.idx;
      },
    });
    const unnamedResult = await getActivity(unnamed);
    assertEq(unnamedResult.response.status, 200, JSON.stringify(unnamedResult.body));
    const serialized = JSON.stringify(unnamedResult.body);
    assert(!serialized.includes("formOwner"), "form-owner identity escaped the privacy projection");
    assert(!serialized.includes("unnamedControlIdx"), "unnamed singleton identity escaped the privacy projection");
  });

  test("current W5 receipt history and observation authority are mandatory and strictly shaped", async () => {
    const mutations = [
      ["missing performed history", (receipt) => { delete receipt.performedHistoryDigest; }],
      ["malformed performed history", (receipt) => { receipt.performedHistoryDigest = "sha256:short"; }],
      ["missing observation evidence", (receipt) => { delete receipt.observationEvidenceId; }],
      ["malformed observation evidence", (receipt) => { receipt.observationEvidenceId = "EV-private-pointer"; }],
    ];
    for (const [label, receiptMutation] of mutations) {
      const bed = await activityRun({ credited: true, receiptMutation });
      const { response, body } = await getActivity(bed);
      assertEq(response.status, 500, label);
      assertEq(body.error.code, "EXECUTION_ACTIVITY_CORRUPT", label);
    }
  });

  test("native choice group identity is required, internally consistent, and closed to unknown fields", async () => {
    const mutations = [
      ["missing form owner", (receipt) => { delete receipt.performedAction.choiceReadback.formOwner; }],
      ["negative form owner", (receipt) => { receipt.performedAction.choiceReadback.formOwner = -1; }],
      ["missing unnamed singleton", (receipt) => { delete receipt.performedAction.choiceReadback.unnamedControlIdx; }],
      ["named receipt claims unnamed singleton", (receipt) => { receipt.performedAction.choiceReadback.unnamedControlIdx = 1; }],
      ["unnamed receipt lacks its singleton", (receipt) => {
        receipt.performedAction.choiceReadback.name = null;
        receipt.performedAction.choiceReadback.unnamedControlIdx = null;
      }],
      ["unnamed receipt points at another control", (receipt) => {
        receipt.performedAction.choiceReadback.name = null;
        receipt.performedAction.choiceReadback.unnamedControlIdx = 2;
      }],
      ["unknown identity field", (receipt) => { receipt.performedAction.choiceReadback.formId = "PRIVATE_QUERY"; }],
      ["duplicate checked group index", (receipt) => { receipt.performedAction.choiceReadback.checkedGroupIdxs = [1, 1]; }],
      ["checked state contradicts group", (receipt) => { receipt.performedAction.choiceReadback.checkedGroupIdxs = []; }],
    ];
    for (const [label, receiptMutation] of mutations) {
      const bed = await activityRun({ credited: true, receiptMutation });
      const { response, body } = await getActivity(bed);
      assertEq(response.status, 500, label);
      assertEq(body.error.code, "EXECUTION_ACTIVITY_CORRUPT", label);
    }
  });

  test("without an immutable walk index the ledger activity remains visible but page-derived counts stay unknown", async () => {
    const bed = await activityRun({ withIndex: false });
    const { response, body } = await getActivity(bed);
    assertEq(response.status, 200, JSON.stringify(body));
    assertEq(body.totals.screenChanges, 44, "committed ledger activity must not disappear");
    assertEq(body.totals.uniqueStableScreensObserved, null, "no index means no artifact-derived page claim");
    assertEq(body.totals.uniqueStableScreensExact, false);
    assertEq(body.totals.visitedOrigins.length, 0);
    assertEq(body.artifactInspection.state, "not-yet-indexed");
    assertEq(body.walks[0].artifact.state, "not-yet-indexed");
  });

  test("a new walk's exact observation pointer exposes verified activity before the post-run index exists", async () => {
    const bed = await activityRun({ withIndex: false, withDirectPointer: true });
    const { response, body } = await getActivity(bed);
    assertEq(response.status, 200, JSON.stringify(body));
    assertEq(body.artifactInspection.state, "complete");
    assertEq(body.artifactInspection.indexedWalks, 0, "the post-run index is intentionally absent");
    assertEq(body.artifactInspection.walksInspected, 1);
    assertEq(body.totals.uniqueStableScreensObserved, 2);
    assertEq(body.totals.uniqueStableScreensExact, true);
    assertEq(body.totals.returnScreenChangesObserved, 43);
    assertEq(JSON.stringify(body.totals.visitedOrigins), JSON.stringify(["https://survey.example.test"]));
    assertEq(body.walks[0].artifact.state, "inspected");
  });

  test("a direct pointer whose catalogue route differs fails closed and is never replaced by catalogue order", async () => {
    const bed = await activityRun({
      withIndex: false,
      withDirectPointer: true,
      directIdentityMismatch: true,
    });
    const { response, body } = await getActivity(bed);
    assertEq(response.status, 200, JSON.stringify(body));
    assertEq(body.artifactInspection.state, "partial");
    assertEq(body.artifactInspection.walksInspected, 0);
    assertEq(body.artifactInspection.unreadableOrMismatchedWalks, 1);
    assertEq(body.totals.uniqueStableScreensObserved, null);
    assertEq(body.totals.visitedOrigins.length, 0);
    assertEq(body.walks[0].artifact.state, "binding-mismatch");
  });

  test("a self-inconsistent execution total fails closed instead of serving plausible activity", async () => {
    const bed = await activityRun({ withIndex: false, corruptTotalSteps: true });
    const { response, body } = await getActivity(bed);
    assertEq(response.status, 500);
    assertEq(body.error.code, "EXECUTION_ACTIVITY_CORRUPT");
    assert(JSON.stringify(body).includes("totalSteps"), "the named reconciliation failure was lost");
  });
});

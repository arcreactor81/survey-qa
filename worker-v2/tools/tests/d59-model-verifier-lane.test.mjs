/**
 * D59 — MODEL VERIFIER LANE v1: the copy family, flags only.
 *
 * THE FOUR PROPERTIES THESE TESTS GUARD:
 *
 *   1. DISABLED GATE = BYTE-IDENTICAL BEHAVIOR. When `WORKERSAI_ENABLED` is absent or "false",
 *      the model lane is never entered and every observation's verifier stamp is exactly what
 *      the base (pre-model-lane) code produces. This is the design, not a stopgap.
 *
 *   2. THE LANE CAN NEVER EMIT FAIL. The owner ruling (OWNER-RULINGS.md, 2 Aug) is that a
 *      model may never emit a fail/violated verdict. The model lane's output space is
 *      `{verified, insufficient}` plus flags. This test asserts that NO PredicateResult the
 *      lane produces has outcome `violated`, and therefore `OUTCOME_TO_DECISION` can never
 *      map it to `contradicted`.
 *
 *   3. MODEL-CALL FAILURE DEMOTES TO NAMED INSUFFICIENT. A model call that throws is caught
 *      and the decision is `insufficient` with reason `MODEL_CALL_FAILED`. It must never
 *      populate any payload key that downstream code reads as a verdict signal.
 *
 *   4. A FLAG NEVER CHANGES A VERDICT COUNT. Flags are metadata rendered separately; they
 *      do not map to fail/violated/contradicted.
 *
 * Evidence these tests can fail: `tools/mutate-model-verifier.mjs`.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { passingGates } from "../fixtures/v2-fixture.mjs";

const PATH_ID = "MODEL-D59";
const ATTEMPT_ID = "att_d59test01";
const COPY_REQUIREMENT = "req_d59copy01";
const ROUTE_REQUIREMENT = "req_d59route01";
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// Shared fixture builders
// ---------------------------------------------------------------------------

const req = (id, facet, statement) => ({
  requirementLineageId: id,
  requirementVersionId: id.replace("req_", "reqv_"),
  semanticFingerprint: `fp_${id}`,
  scope: "survey",
  quantifier: "specific",
  selector: null,
  exceptions: [],
  facet,
  assertionStatus: "entailed",
  testability: "browser-observable",
  notBrowserObservableReason: null,
  sourceAtoms: [{ blockId: "B1", kind: "paragraph", coords: null, role: "normative", atomTextHash: "sha256:aa" }],
  composition: null,
  normativeStatement: statement,
  displayQuote: statement,
  retiredAt: null,
});

const facetInst = (id, { target, kind, lineage, routeAnswer = null, destination = null, expectationGap = null }) => ({
  facetInstanceId: id,
  requirementLineageId: lineage,
  requirementVersionId: lineage.replace("req_", "reqv_"),
  caseVersionId: `cv_${id}`,
  floorCase: true,
  targetQuestionId: target,
  expansionCertificate: `cert_${id}`,
  case: { kind, routeAnswer, boundaryInput: null, configuration: null, expectedDestination: destination },
  expectationGap,
  screen: target,
  label: `${id} on ${target}`,
});

function contractBody() {
  return {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: "d".repeat(64),
    documentSha256: "d".repeat(64),
    sealedAt: "2026-08-07T00:00:00.000Z",
    requirements: [
      req(COPY_REQUIREMENT, "copy", "Please rate the following brands on a scale of 1 to 5."),
      req(ROUTE_REQUIREMENT, "routing", "Dummy route requirement for vocabulary."),
    ],
    facetInstances: [
      facetInst("fi_copy_q3", {
        target: "Q3",
        kind: "copy",
        lineage: COPY_REQUIREMENT,
        expectationGap: { code: "NO_TYPED_PREDICATE_FOR_KIND", detail: "copy needs model verifier" },
      }),
      // Vocabulary: put Q3 in the sealed ids so screens can identify it.
      facetInst("fi_vocab_q3", {
        target: "Q3",
        kind: "rendered-state",
        lineage: ROUTE_REQUIREMENT,
      }),
    ],
    contractSupplements: [],
    extraction: {
      passAHash: "sha256:aaa",
      passBHash: "sha256:bbb",
      sourceLedgerHash: "sha256:ccc",
      diffHash: "sha256:ddd",
      reviewMode: "high-risk-only",
      reviewedBy: "d59-fixture",
      reviewedAt: "2026-08-07T00:00:00.000Z",
      gates: passingGates(),
    },
  };
}

const screen = (text) => ({
  at: "2026-08-07T00:05:00.000Z",
  url: "https://fixture.invalid/survey",
  title: null,
  collectedErrors: [],
  questionText: text,
  instructionText: null,
  visibleText: text,
  visibleTextTruncated: false,
  bracketedInstructionsVisible: [],
  controls: [],
  optionGroups: [],
  grid: null,
  buttons: [],
  progress: { present: false, kind: null, now: null, max: null, text: null },
  validationMessages: [],
  counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0 },
  screenSignature: `sig:${text}`,
});

const COPY_STEPS = [
  {
    stepIndex: 0,
    decisionQuestion: "Q3",
    decisionSource: "plan",
    requested: { select: [], textEntry: null, action: null },
    screenBefore: screen("Q3. Please rate the following brands on a scale of 1 to 5."),
    screenAfterAction: null,
    screenAfterAdvance: null,
    actions: [],
    requestedButNotOffered: [],
    advanced: true,
    blocked: false,
    pageErrors: [],
    consoleErrors: [],
    evidence: { screenBefore: null, screenAfterAdvance: null, screenshots: [] },
    wallMs: 5000,
  },
];

const walkArtifact = (runId) => ({
  kind: "v2-path-observation/1.0.0",
  runId,
  pathId: PATH_ID,
  tier: 1,
  attemptId: ATTEMPT_ID,
  planRevisionId: "plan_d59test01",
  surveyUrl: "https://fixture.invalid/survey",
  startedAt: "2026-08-07T00:04:00.000Z",
  endedAt: "2026-08-07T00:05:00.000Z",
  wallMs: 60000,
  plannedWitnesses: [COPY_REQUIREMENT],
  steps: COPY_STEPS,
  outcome: "completed",
  outcomeDetail: null,
  shimmed: false,
  shimNote: null,
  loadFailure: null,
  evidenceIds: [],
  viewport: { width: 1280, height: 900 },
});

const walkProjectionPayload = (observationEvidenceId) => ({
  pathId: PATH_ID,
  attemptId: ATTEMPT_ID,
  observationEvidenceId,
  outcome: "completed",
  outcomeDetail: null,
  screensAdvanced: 1,
  steps: 1,
  exercised: true,
  observedAt: "2026-08-07T00:05:00.000Z",
});

async function seedRun(mod, env) {
  const runId = mod.ids.mintRunId();
  const { contractRevisionId, contractHash } = await mod.contractRevision.sealContract(env, contractBody());

  const entry = await mod.evidence.putEvidence(env, {
    runId,
    bytes: enc.encode(JSON.stringify(walkArtifact(runId))),
    mediaType: "application/json",
    type: "state",
    attemptId: ATTEMPT_ID,
    routeId: PATH_ID,
    witnesses: [COPY_REQUIREMENT],
    sourceEvidenceId: `EV-${PATH_ID}-observation`,
    artifactRef: `observations/${PATH_ID}/observation.json`,
  });

  await env.EVIDENCE.put(
    mod.keys.observationsKey(runId),
    JSON.stringify({
      observations: [
        {
          observationId: "obs_d59_copy_q3",
          facetInstanceId: "fi_copy_q3",
          attemptId: ATTEMPT_ID,
          routeId: PATH_ID,
          observedAt: "2026-08-07T00:05:00.000Z",
          payloadKind: "v2-walk-projection/1.0.0",
          payload: walkProjectionPayload(entry.evidenceId),
          completeness: "complete-scoped-inventory",
          evidenceIds: [entry.evidenceId],
          verifier: { decision: "insufficient", evidenceIds: [entry.evidenceId], verifierVersion: "none/not-yet-verified" },
          attestation: { producedBy: "v2-executor", producerVersion: "v2-observation-projection/1.0.0", payloadHash: "sha256:d59" },
        },
      ],
    }),
    { httpMetadata: { contentType: "application/json" } },
  );

  await mod.checkpoint.createCheckpoint(env, mod.checkpoint.initialCheckpoint(env, runId, "standard", false));
  await mod.checkpoint.updateCheckpoint(env, runId, (d) => {
    d.contract = {
      state: "sealed",
      contractRevisionId,
      contractHash,
      total: 2,
      requirements: { total: 2, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
    };
    d.counts = { ...d.counts, exercised: 1, pending: 1 };
  });

  return { runId };
}

// ---------------------------------------------------------------------------
// Property 1: disabled gate means byte-identical behavior to base
// ---------------------------------------------------------------------------

suite("d59 — model verifier lane v1", () => {
  test("disabled gate means byte-identical behavior to base", async () => {
    const mod = await worker();
    // Run WITHOUT the model gate — WORKERSAI_ENABLED absent.
    const envOff = testEnv();
    const { runId } = await seedRun(mod, envOff);

    const result = await mod.verifyObservations.verifyObservations(envOff, runId);
    const ledger = JSON.parse(await (await envOff.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;
    const obs = ledger.find((o) => o.facetInstanceId === "fi_copy_q3");

    assertEq(obs.verifier.decision, "insufficient",
      "with the gate off, a copy case must stay insufficient");
    assertEq(obs.verifier.reason, "NO_TYPED_EXPECTATION",
      "with the gate off, the reason must be the base NO_TYPED_EXPECTATION");
    assert(obs.verifier.verifierVersion.includes("+no-model"),
      "with the gate off, the version stamp must say +no-model");
    assert(!obs.verifier.verifierVersion.includes("model-verifier"),
      "with the gate off, the version must not mention model-verifier");
  });

  // ---------------------------------------------------------------------------
  // Property 2: the lane can NEVER emit fail/violated/contradicted
  // ---------------------------------------------------------------------------

  test("the lane can never emit fail — model returning VERIFIED maps to verified, not contradicted", async () => {
    const mod = await worker();
    // Run WITH the model gate ON and a mock AI that returns "VERIFIED".
    const mockAI = {
      async run(_model, _input) {
        return { response: "VERIFIED" };
      },
    };
    const envOn = testEnv({ WORKERSAI_ENABLED: "true", AI: mockAI });
    const { runId } = await seedRun(mod, envOn);

    const result = await mod.verifyObservations.verifyObservations(envOn, runId);
    const ledger = JSON.parse(await (await envOn.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;
    const obs = ledger.find((o) => o.facetInstanceId === "fi_copy_q3");

    assertEq(obs.verifier.decision, "verified",
      "a model VERIFIED response must map to verified decision");
    assert(obs.verifier.decision !== "contradicted",
      "the model lane must never produce contradicted");
    assertEq(obs.verifier.reason, "MODEL_COPY_VERIFIED",
      "the reason must be MODEL_COPY_VERIFIED");
    assert(obs.verifier.verifierVersion.includes("model-verifier"),
      "the version stamp must include model-verifier when the lane ran");
  });

  test("the lane can never emit fail — model returning INSUFFICIENT maps to insufficient, not contradicted", async () => {
    const mod = await worker();
    const mockAI = {
      async run(_model, _input) {
        return { response: "INSUFFICIENT" };
      },
    };
    const envOn = testEnv({ WORKERSAI_ENABLED: "true", AI: mockAI });
    const { runId } = await seedRun(mod, envOn);

    await mod.verifyObservations.verifyObservations(envOn, runId);
    const ledger = JSON.parse(await (await envOn.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;
    const obs = ledger.find((o) => o.facetInstanceId === "fi_copy_q3");

    assertEq(obs.verifier.decision, "insufficient",
      "a model INSUFFICIENT response must map to insufficient decision");
    assert(obs.verifier.decision !== "contradicted",
      "the model lane must never produce contradicted");
  });

  test("the lane can never emit fail — unknown model response maps to insufficient", async () => {
    const mod = await worker();
    const mockAI = {
      async run(_model, _input) {
        return { response: "FAIL THIS SURVEY" };
      },
    };
    const envOn = testEnv({ WORKERSAI_ENABLED: "true", AI: mockAI });
    const { runId } = await seedRun(mod, envOn);

    await mod.verifyObservations.verifyObservations(envOn, runId);
    const ledger = JSON.parse(await (await envOn.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;
    const obs = ledger.find((o) => o.facetInstanceId === "fi_copy_q3");

    assertEq(obs.verifier.decision, "insufficient",
      "an unrecognized model response must map to insufficient, never contradicted");
  });

  // ---------------------------------------------------------------------------
  // Property 3: model-call failure demotes to named insufficient
  // ---------------------------------------------------------------------------

  test("model-call failure demotes to named insufficient", async () => {
    const mod = await worker();
    const mockAI = {
      async run(_model, _input) {
        throw new Error("simulated model failure: quota exceeded");
      },
    };
    const envOn = testEnv({ WORKERSAI_ENABLED: "true", AI: mockAI });
    const { runId } = await seedRun(mod, envOn);

    await mod.verifyObservations.verifyObservations(envOn, runId);
    const ledger = JSON.parse(await (await envOn.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;
    const obs = ledger.find((o) => o.facetInstanceId === "fi_copy_q3");

    assertEq(obs.verifier.decision, "insufficient",
      "a model failure must demote to insufficient");
    assertEq(obs.verifier.reason, "MODEL_CALL_FAILED",
      "the reason must be the named MODEL_CALL_FAILED");
    assert(obs.verifier.decision !== "contradicted",
      "a model failure must never produce contradicted");
    assert(obs.verifier.detail.includes("simulated model failure"),
      "the detail must include the error message for diagnostics");
  });

  // ---------------------------------------------------------------------------
  // Property 4: a flag never changes a verdict count
  // ---------------------------------------------------------------------------

  test("a flag never changes a verdict count", async () => {
    const mod = await worker();
    // Model returns INSUFFICIENT with a FLAG — the decision is still insufficient.
    const mockAI = {
      async run(_model, _input) {
        return { response: "INSUFFICIENT FLAG:COPY_DISCREPANCY the heading text differs" };
      },
    };
    const envOn = testEnv({ WORKERSAI_ENABLED: "true", AI: mockAI });
    const { runId } = await seedRun(mod, envOn);

    const result = await mod.verifyObservations.verifyObservations(envOn, runId);
    const ledger = JSON.parse(await (await envOn.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;
    const obs = ledger.find((o) => o.facetInstanceId === "fi_copy_q3");

    assertEq(obs.verifier.decision, "insufficient",
      "a flagged response is still insufficient — the flag does not change the decision");
    assertEq(result.value.contradicted, 0,
      "no contradiction from a flag — zero contradicted in the summary");
    assert(obs.verifier.detail.includes("FLAG:COPY_DISCREPANCY"),
      "the flag must appear in the detail for the report renderer");
  });

  // ---------------------------------------------------------------------------
  // Provenance
  // ---------------------------------------------------------------------------

  test("provenance includes model id and prompt hash", async () => {
    const mod = await worker();
    const mockAI = {
      async run(_model, _input) {
        return { response: "VERIFIED" };
      },
    };
    const envOn = testEnv({ WORKERSAI_ENABLED: "true", AI: mockAI });
    const { runId } = await seedRun(mod, envOn);

    await mod.verifyObservations.verifyObservations(envOn, runId);
    const ledger = JSON.parse(await (await envOn.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;
    const obs = ledger.find((o) => o.facetInstanceId === "fi_copy_q3");

    assert(obs.verifier.detail.includes("model=@cf/meta/llama-3.1-8b-instruct"),
      "the detail must carry the model id");
    assert(obs.verifier.detail.includes("promptHash="),
      "the detail must carry the prompt hash");
    assert(obs.verifier.detail.includes("evidenceRefs="),
      "the detail must carry the evidence references");
    assertEq(obs.verifier.predicate, "model-copy/1.0.0",
      "the predicate must name the model-copy lane version");
  });

  // ---------------------------------------------------------------------------
  // Property 5: usage event pushed on model success AND failure
  // ---------------------------------------------------------------------------

  test("usage event is pushed to checkpoint on model success", async () => {
    const mod = await worker();
    const mockAI = {
      async run(_model, _input) {
        return { response: "VERIFIED" };
      },
    };
    const envOn = testEnv({ WORKERSAI_ENABLED: "true", AI: mockAI });
    const { runId } = await seedRun(mod, envOn);

    // Claim ownership to get a fence for usage tracking.
    const fence = await mod.checkpoint.claimOwnership(envOn, runId, "inst-d59-usage", 1);

    await mod.verifyObservations.verifyObservations(envOn, runId, fence);

    // Read the checkpoint and verify a model-call usage event was pushed.
    const loaded = await mod.checkpoint.loadCheckpoint(envOn, runId);
    const usageEvents = loaded.checkpoint.usage.events.filter(
      (e) => e.kind === "model-call" && e.model === "@cf/meta/llama-3.1-8b-instruct",
    );
    assertEq(usageEvents.length, 1,
      "exactly one model-call usage event must be pushed on a successful model call");
    assertEq(usageEvents[0].costUsd, 0,
      "Workers AI included models must book zero cost");
    assertEq(usageEvents[0].inputTokens, 0,
      "Workers AI does not report token counts — inputTokens must be 0");
    assertEq(usageEvents[0].outputTokens, 0,
      "Workers AI does not report token counts — outputTokens must be 0");
    assert(usageEvents[0].eventId.startsWith("model-verifier/"),
      "the eventId must carry the model-verifier prefix for deduplication");
    assertEq(loaded.checkpoint.usage.modelCalls.used, 1,
      "the model call counter must be incremented");
  });

  test("usage event is pushed to checkpoint on model failure", async () => {
    const mod = await worker();
    const mockAI = {
      async run(_model, _input) {
        throw new Error("simulated model failure for usage test");
      },
    };
    const envOn = testEnv({ WORKERSAI_ENABLED: "true", AI: mockAI });
    const { runId } = await seedRun(mod, envOn);

    // Claim ownership to get a fence for usage tracking.
    const fence = await mod.checkpoint.claimOwnership(envOn, runId, "inst-d59-usage-fail", 1);

    await mod.verifyObservations.verifyObservations(envOn, runId, fence);

    // Read the checkpoint and verify a model-call usage event was pushed EVEN on failure.
    const loaded = await mod.checkpoint.loadCheckpoint(envOn, runId);
    const usageEvents = loaded.checkpoint.usage.events.filter(
      (e) => e.kind === "model-call" && e.model === "@cf/meta/llama-3.1-8b-instruct",
    );
    assertEq(usageEvents.length, 1,
      "a model-call usage event must be pushed even when the model call fails");
    assertEq(usageEvents[0].costUsd, 0,
      "a failed Workers AI call must book zero cost");
    assertEq(loaded.checkpoint.usage.modelCalls.used, 1,
      "the model call counter must be incremented even on failure");

    // The verifier still produced the correct insufficient decision.
    const ledger = JSON.parse(await (await envOn.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;
    const obs = ledger.find((o) => o.facetInstanceId === "fi_copy_q3");
    assertEq(obs.verifier.decision, "insufficient",
      "a failed call must still produce insufficient");
    assertEq(obs.verifier.reason, "MODEL_CALL_FAILED",
      "the reason must be MODEL_CALL_FAILED");
  });

  // ---------------------------------------------------------------------------
  // Property 6: target screen not found => named insufficient, model NOT called
  // ---------------------------------------------------------------------------

  test("known targetQ with no matching screen => insufficient MODEL_COPY_TARGET_SCREEN_NOT_FOUND, model not invoked", async () => {
    const mod = await worker();
    let aiCalled = false;
    const mockAI = {
      async run(_model, _input) {
        aiCalled = true;
        return { response: "VERIFIED" };
      },
    };
    const envOn = testEnv({ WORKERSAI_ENABLED: "true", AI: mockAI });

    // Seed a run where the copy case targets Q99 but the walk only has Q3 screens.
    const customContract = {
      schemaVersion: "v2-contract-revision/1.0.0",
      kind: "survey-qa-v2-contract-revision",
      documentRevisionId: "d".repeat(64),
      documentSha256: "d".repeat(64),
      sealedAt: "2026-08-07T00:00:00.000Z",
      requirements: [
        req("req_d59copy_q99", "copy", "This question targets Q99 which is not on any screen."),
        req(ROUTE_REQUIREMENT, "routing", "Dummy route requirement for vocabulary."),
      ],
      facetInstances: [
        facetInst("fi_copy_q99", {
          target: "Q99",
          kind: "copy",
          lineage: "req_d59copy_q99",
          expectationGap: { code: "NO_TYPED_PREDICATE_FOR_KIND", detail: "copy needs model verifier" },
        }),
        facetInst("fi_vocab_q99", {
          target: "Q99",
          kind: "rendered-state",
          lineage: ROUTE_REQUIREMENT,
        }),
      ],
      contractSupplements: [],
      extraction: {
        passAHash: "sha256:aaa",
        passBHash: "sha256:bbb",
        sourceLedgerHash: "sha256:ccc",
        diffHash: "sha256:ddd",
        reviewMode: "high-risk-only",
        reviewedBy: "d59-fixture",
        reviewedAt: "2026-08-07T00:00:00.000Z",
        gates: passingGates(),
      },
    };

    const runId = mod.ids.mintRunId();
    const { contractRevisionId, contractHash } = await mod.contractRevision.sealContract(envOn, customContract);

    // Walk artifact has only Q3 screens — no Q99.
    const artifact = walkArtifact(runId);
    const entry = await mod.evidence.putEvidence(envOn, {
      runId,
      bytes: enc.encode(JSON.stringify(artifact)),
      mediaType: "application/json",
      type: "state",
      attemptId: ATTEMPT_ID,
      routeId: PATH_ID,
      witnesses: ["req_d59copy_q99"],
      sourceEvidenceId: `EV-${PATH_ID}-observation`,
      artifactRef: `observations/${PATH_ID}/observation.json`,
    });

    await envOn.EVIDENCE.put(
      mod.keys.observationsKey(runId),
      JSON.stringify({
        observations: [
          {
            observationId: "obs_d59_copy_q99",
            facetInstanceId: "fi_copy_q99",
            attemptId: ATTEMPT_ID,
            routeId: PATH_ID,
            observedAt: "2026-08-07T00:05:00.000Z",
            payloadKind: "v2-walk-projection/1.0.0",
            payload: walkProjectionPayload(entry.evidenceId),
            completeness: "complete-scoped-inventory",
            evidenceIds: [entry.evidenceId],
            verifier: { decision: "insufficient", evidenceIds: [entry.evidenceId], verifierVersion: "none/not-yet-verified" },
            attestation: { producedBy: "v2-executor", producerVersion: "v2-observation-projection/1.0.0", payloadHash: "sha256:d59q99" },
          },
        ],
      }),
      { httpMetadata: { contentType: "application/json" } },
    );

    await mod.checkpoint.createCheckpoint(envOn, mod.checkpoint.initialCheckpoint(envOn, runId, "standard", false));
    await mod.checkpoint.updateCheckpoint(envOn, runId, (d) => {
      d.contract = {
        state: "sealed",
        contractRevisionId,
        contractHash,
        total: 2,
        requirements: { total: 2, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
      };
      d.counts = { ...d.counts, exercised: 1, pending: 1 };
    });

    await mod.verifyObservations.verifyObservations(envOn, runId);
    const ledger = JSON.parse(await (await envOn.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;
    const obs = ledger.find((o) => o.facetInstanceId === "fi_copy_q99");

    assertEq(obs.verifier.decision, "insufficient",
      "when the target question is not on any screen, the decision must be insufficient");
    assertEq(obs.verifier.reason, "MODEL_COPY_TARGET_SCREEN_NOT_FOUND",
      "the reason must be MODEL_COPY_TARGET_SCREEN_NOT_FOUND");
    assertEq(aiCalled, false,
      "the model must NOT be invoked when no screen matches the target question");
    assert(obs.verifier.detail.includes("Q99"),
      "the detail must mention the target question that was not found");
  });

  // ---------------------------------------------------------------------------
  // Property 7: no-target-question case, second screen matches => verified with provenance
  // ---------------------------------------------------------------------------

  test("no-target-question case with match on second screen => verified with screens-checked provenance", async () => {
    const mod = await worker();
    let callCount = 0;
    const mockAI = {
      async run(_model, input) {
        callCount++;
        // The first screen does not match; the second does.
        if (callCount === 1) return { response: "INSUFFICIENT" };
        return { response: "VERIFIED" };
      },
    };
    const envOn = testEnv({ WORKERSAI_ENABLED: "true", AI: mockAI });

    // Build a contract where the copy case has NO target question (survey-wide copy).
    const customContract = {
      schemaVersion: "v2-contract-revision/1.0.0",
      kind: "survey-qa-v2-contract-revision",
      documentRevisionId: "d".repeat(64),
      documentSha256: "d".repeat(64),
      sealedAt: "2026-08-07T00:00:00.000Z",
      requirements: [
        req("req_d59copy_wide", "copy", "Welcome to the survey. Please answer all questions honestly."),
        req(ROUTE_REQUIREMENT, "routing", "Dummy route requirement for vocabulary."),
      ],
      facetInstances: [
        facetInst("fi_copy_wide", {
          target: null,  // NO target question — survey-wide copy
          kind: "copy",
          lineage: "req_d59copy_wide",
          expectationGap: { code: "NO_TYPED_PREDICATE_FOR_KIND", detail: "copy needs model verifier" },
        }),
        facetInst("fi_vocab_q3_wide", {
          target: "Q3",
          kind: "rendered-state",
          lineage: ROUTE_REQUIREMENT,
        }),
      ],
      contractSupplements: [],
      extraction: {
        passAHash: "sha256:aaa",
        passBHash: "sha256:bbb",
        sourceLedgerHash: "sha256:ccc",
        diffHash: "sha256:ddd",
        reviewMode: "high-risk-only",
        reviewedBy: "d59-fixture",
        reviewedAt: "2026-08-07T00:00:00.000Z",
        gates: passingGates(),
      },
    };

    const runId = mod.ids.mintRunId();
    const { contractRevisionId, contractHash } = await mod.contractRevision.sealContract(envOn, customContract);

    // Walk artifact with TWO screens — first unrelated, second matching.
    const multiScreenSteps = [
      {
        stepIndex: 0,
        decisionQuestion: "Q1",
        decisionSource: "plan",
        requested: { select: [], textEntry: null, action: null },
        screenBefore: screen("Q1. What is your age?"),
        screenAfterAction: null,
        screenAfterAdvance: null,
        actions: [],
        requestedButNotOffered: [],
        advanced: true,
        blocked: false,
        pageErrors: [],
        consoleErrors: [],
        evidence: { screenBefore: null, screenAfterAdvance: null, screenshots: [] },
        wallMs: 5000,
      },
      {
        stepIndex: 1,
        decisionQuestion: "Q2",
        decisionSource: "plan",
        requested: { select: [], textEntry: null, action: null },
        screenBefore: screen("Welcome to the survey. Please answer all questions honestly."),
        screenAfterAction: null,
        screenAfterAdvance: null,
        actions: [],
        requestedButNotOffered: [],
        advanced: true,
        blocked: false,
        pageErrors: [],
        consoleErrors: [],
        evidence: { screenBefore: null, screenAfterAdvance: null, screenshots: [] },
        wallMs: 5000,
      },
    ];

    const multiScreenArtifact = {
      kind: "v2-path-observation/1.0.0",
      runId,
      pathId: PATH_ID,
      tier: 1,
      attemptId: ATTEMPT_ID,
      planRevisionId: "plan_d59test01",
      surveyUrl: "https://fixture.invalid/survey",
      startedAt: "2026-08-07T00:04:00.000Z",
      endedAt: "2026-08-07T00:05:00.000Z",
      wallMs: 60000,
      plannedWitnesses: ["req_d59copy_wide"],
      steps: multiScreenSteps,
      outcome: "completed",
      outcomeDetail: null,
      shimmed: false,
      shimNote: null,
      loadFailure: null,
      evidenceIds: [],
      viewport: { width: 1280, height: 900 },
    };

    const entry = await mod.evidence.putEvidence(envOn, {
      runId,
      bytes: enc.encode(JSON.stringify(multiScreenArtifact)),
      mediaType: "application/json",
      type: "state",
      attemptId: ATTEMPT_ID,
      routeId: PATH_ID,
      witnesses: ["req_d59copy_wide"],
      sourceEvidenceId: `EV-${PATH_ID}-observation`,
      artifactRef: `observations/${PATH_ID}/observation.json`,
    });

    await envOn.EVIDENCE.put(
      mod.keys.observationsKey(runId),
      JSON.stringify({
        observations: [
          {
            observationId: "obs_d59_copy_wide",
            facetInstanceId: "fi_copy_wide",
            attemptId: ATTEMPT_ID,
            routeId: PATH_ID,
            observedAt: "2026-08-07T00:05:00.000Z",
            payloadKind: "v2-walk-projection/1.0.0",
            payload: walkProjectionPayload(entry.evidenceId),
            completeness: "complete-scoped-inventory",
            evidenceIds: [entry.evidenceId],
            verifier: { decision: "insufficient", evidenceIds: [entry.evidenceId], verifierVersion: "none/not-yet-verified" },
            attestation: { producedBy: "v2-executor", producerVersion: "v2-observation-projection/1.0.0", payloadHash: "sha256:d59wide" },
          },
        ],
      }),
      { httpMetadata: { contentType: "application/json" } },
    );

    await mod.checkpoint.createCheckpoint(envOn, mod.checkpoint.initialCheckpoint(envOn, runId, "standard", false));
    await mod.checkpoint.updateCheckpoint(envOn, runId, (d) => {
      d.contract = {
        state: "sealed",
        contractRevisionId,
        contractHash,
        total: 2,
        requirements: { total: 2, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
      };
      d.counts = { ...d.counts, exercised: 1, pending: 1 };
    });

    // Claim ownership so usage events can be pushed.
    const fence = await mod.checkpoint.claimOwnership(envOn, runId, "inst-d59-wide", 1);

    await mod.verifyObservations.verifyObservations(envOn, runId, fence);
    const ledger = JSON.parse(await (await envOn.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;
    const obs = ledger.find((o) => o.facetInstanceId === "fi_copy_wide");

    assertEq(obs.verifier.decision, "verified",
      "when the second screen matches, the decision must be verified");
    assertEq(obs.verifier.reason, "MODEL_COPY_VERIFIED",
      "the reason must be MODEL_COPY_VERIFIED");
    assert(obs.verifier.detail.includes("screensChecked=2/2"),
      "the detail must report how many screens were checked of how many available: " + obs.verifier.detail);
    assertEq(callCount, 2,
      "the model must be called exactly twice (first screen insufficient, second verified)");

    // Verify usage events were pushed for both model calls.
    const loaded = await mod.checkpoint.loadCheckpoint(envOn, runId);
    const usageEvents = loaded.checkpoint.usage.events.filter(
      (e) => e.kind === "model-call" && e.model === "@cf/meta/llama-3.1-8b-instruct",
    );
    assertEq(usageEvents.length, 2,
      "two usage events must be pushed (one per model call)");
  });
});

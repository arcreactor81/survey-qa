/**
 * D19 — THE VERIFIER MUST READ *THIS CASE'S* STEP, NOT THE FIRST STEP THAT LOOKS RIGHT.
 *
 * THE DEFECT. Both deterministic predicates in `verify-observations.ts` picked their step out
 * of the walk by the STIMULUS ALONE:
 *
 *     walk.steps.find((s) => selectedAnswer(s, answer.code, answer.label))
 *
 * — the first step that clicked the documented code or label, with NO check that the step
 * happened on the question the sealed case is about. A walk is a whole survey and clone paths
 * retain every base decision, so on any survey where "Yes" (or code "1", or the value "151")
 * is also answered on an EARLIER question, that predicate evaluated the wrong step. It then
 * read the wrong step's `screenAfterAdvance` and:
 *
 *   - if that screen presented any other sealed question id → `contradicted` → `fail` → A
 *     DEFECT CLAIM ABOUT A HEALTHY SITE, through the fully-trusted deterministic lane;
 *   - if it happened to present the documented destination → `verified` → A REAL ROUTING
 *     DEFECT CONCEALED by a pass nobody checked.
 *
 * Yes/No screeners and repeated numeric codes make both of those the COMMON case on a real
 * survey, not an edge case.
 *
 * WHAT THESE TESTS ASSERT. Each scenario below is a walk that is IDENTICAL under the old
 * predicate and the new one except for which step gets read. The fixtures are built so that
 * reinstating the old `find` flips every one of them — `MUTANT_FIND`/`MUTANT_REPLACE` over
 * `testkit.mjs#mutantPlugin` is the evidence, and the mutation commands are recorded in the
 * task report rather than in a script, because `tools/mutate-expander.mjs` is hardwired to a
 * different file.
 *
 * WHY THESE TESTS DO NOT USE `projectObservations`. The observation ledger is seeded directly
 * here. That is not a shortcut around the producer: it keeps this file testing the VERIFIER
 * (the layer that decides what a client is told) rather than the projection, and it keeps it
 * runnable while the execution-program fixture regression is being fixed elsewhere. The
 * stage under test is the real `verifyObservations`, over a real sealed revision and real
 * content-addressed evidence that it re-reads and re-hashes itself.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { passingGates } from "../fixtures/v2-fixture.mjs";

const PATH_ID = "FLOOR-D19";
const ATTEMPT_ID = "att_d19test01";
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// The sealed contract: a question vocabulary, and the cases under test
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

const facet = (id, { target, kind, routeAnswer = null, boundaryInput = null, destination = null, lineage = "req_d19route01" }) => ({
  facetInstanceId: id,
  requirementLineageId: lineage,
  requirementVersionId: lineage.replace("req_", "reqv_"),
  caseVersionId: `cv_${id}`,
  floorCase: true,
  targetQuestionId: target,
  expansionCertificate: `cert_${id}`,
  case: {
    kind,
    routeAnswer,
    boundaryInput,
    configuration: null,
    expectedDestination: destination,
  },
  expectationGap: null,
  screen: target,
  label: `${id} on ${target}`,
});

/** A vocabulary entry: puts a question id into the seal so screens can be read against it. */
const vocab = (id, target) => facet(id, { target, kind: "rendered-state", lineage: "req_d19render01" });

/**
 * THE SEALED CASES.
 *
 *   `fi_route_q7`  Q7 answered "Yes" (code 1) must route to Q9. The answer "Yes"/"1" is
 *                  deliberately one that an earlier screener also takes.
 *   `fi_bound_q12` Q12 must reject "151". The value is deliberately one an earlier numeric
 *                  question also accepts.
 *   The `vocab` rows put Q3, Q9 and Q12 into the sealed question set — the same vocabulary
 *   the verifier reads screens against.
 */
function contractBody(extraFacets = []) {
  return {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: "d".repeat(64),
    documentSha256: "d".repeat(64),
    sealedAt: "2026-08-05T00:00:00.000Z",
    requirements: [
      req("req_d19route01", "routing", 'When Q7 is answered "Yes", the survey must route to Q9.'),
      req("req_d19bound001", "validation", "Q12 must reject a spend above 150."),
      req("req_d19render01", "rendered-state", "Every screen must display exactly one question."),
    ],
    facetInstances: [
      facet("fi_route_q7", {
        target: "Q7",
        kind: "route",
        routeAnswer: { code: "1", label: "Yes" },
        destination: { questionId: "Q9", screen: null, terminal: null },
      }),
      facet("fi_bound_q12", {
        target: "Q12",
        kind: "boundary",
        boundaryInput: { bound: "above-max", value: "151", expectedOutcome: "rejected" },
        lineage: "req_d19bound001",
      }),
      vocab("fi_q3", "Q3"),
      vocab("fi_q9", "Q9"),
      vocab("fi_q12", "Q12"),
      ...extraFacets,
    ],
    contractSupplements: [],
    extraction: {
      passAHash: "sha256:aaa",
      passBHash: "sha256:bbb",
      sourceLedgerHash: "sha256:ccc",
      diffHash: "sha256:ddd",
      reviewMode: "high-risk-only",
      reviewedBy: "d19-fixture",
      reviewedAt: "2026-08-05T00:00:00.000Z",
      gates: passingGates(),
    },
  };
}

// ---------------------------------------------------------------------------
// Walk fixtures — the bytes the verifier re-reads
// ---------------------------------------------------------------------------

const screen = (text, { validationMessages = [] } = {}) => ({
  at: "2026-08-05T00:05:00.000Z",
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
  validationMessages,
  counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0 },
  screenSignature: `sig:${text}`,
});

const stepBase = (index, on, extra) => ({
  stepIndex: index,
  // Deliberately WRONG on every step: the driver's own heuristic match is not a binder, and
  // a fix that leaned on it would pass its tests while still reading another question's
  // screen. Every scenario below binds — or refuses to — on screen evidence alone.
  decisionQuestion: "Q7",
  decisionSource: "plan",
  requested: { select: [], textEntry: null, action: null },
  screenBefore: screen(on),
  screenAfterAction: null,
  screenAfterAdvance: null,
  actions: [],
  requestedButNotOffered: [],
  advanced: false,
  blocked: false,
  pageErrors: [],
  consoleErrors: [],
  evidence: { screenBefore: null, screenAfterAdvance: null, screenshots: [] },
  wallMs: 5000,
  ...extra,
});

/** A step that CLICKS an option on the screen `on`, then advances to `reached`. */
const clickStep = (index, { on, code = "1", label = "Yes", reached, advanced = true }) =>
  stepBase(index, on, {
    requested: { select: [label], textEntry: null, action: null },
    screenAfterAdvance: advanced && reached ? screen(reached) : null,
    actions: [{ kind: "click-option", targetIdx: 0, targetLabel: label, targetCode: code, value: null, ok: true, detail: null }],
    advanced,
  });

/** A step that TYPES `value` on the screen `on`. `rejected` = the survey refused it. */
const typeStep = (index, { on, value = "151", rejected = false, reached = "Q13. Anything else?" }) =>
  stepBase(index, on, {
    requested: { select: [], textEntry: value, action: null },
    screenAfterAction: rejected ? screen(on, { validationMessages: ["Please enter a value of 150 or less."] }) : screen(on),
    screenAfterAdvance: rejected ? null : screen(reached),
    actions: [{ kind: "type-text", targetIdx: 0, targetLabel: null, targetCode: null, value, ok: true, detail: null }],
    advanced: !rejected,
    blocked: rejected,
  });

const walkArtifact = (runId, steps) => ({
  kind: "v2-path-observation/1.0.0",
  runId,
  pathId: PATH_ID,
  tier: 1,
  attemptId: ATTEMPT_ID,
  planRevisionId: "plan_d19test01",
  surveyUrl: "https://fixture.invalid/survey",
  startedAt: "2026-08-05T00:04:00.000Z",
  endedAt: "2026-08-05T00:05:00.000Z",
  wallMs: 60000,
  plannedWitnesses: ["req_d19route01"],
  steps,
  outcome: "completed",
  outcomeDetail: null,
  shimmed: false,
  shimNote: null,
  loadFailure: null,
  evidenceIds: [],
  viewport: { width: 1280, height: 900 },
});

// ---------------------------------------------------------------------------
// Seeding: exactly what `verifyObservations` reads, and nothing more
// ---------------------------------------------------------------------------

/**
 * Seal the contract, store the walk artifact content-addressed, and commit ONE observation
 * for `caseId` citing it. The verifier re-reads and re-hashes those bytes itself.
 */
async function seedRunForCase(mod, env, { caseId, steps, extraFacets = [] }) {
  const runId = mod.ids.mintRunId();
  const { contractRevisionId, contractHash } = await mod.contractRevision.sealContract(env, contractBody(extraFacets));

  const entry = await mod.evidence.putEvidence(env, {
    runId,
    bytes: enc.encode(JSON.stringify(walkArtifact(runId, steps))),
    mediaType: "application/json",
    type: "state",
    attemptId: ATTEMPT_ID,
    routeId: PATH_ID,
    witnesses: ["req_d19route01"],
    sourceEvidenceId: `EV-${PATH_ID}-observation`,
    artifactRef: `observations/${PATH_ID}/observation.json`,
  });

  const payload = {
    pathId: PATH_ID,
    attemptId: ATTEMPT_ID,
    observationEvidenceId: entry.evidenceId,
    outcome: "completed",
    outcomeDetail: null,
    screensAdvanced: steps.filter((s) => s.advanced).length,
    steps: steps.length,
    exercised: true,
    observedAt: "2026-08-05T00:05:00.000Z",
  };
  await env.EVIDENCE.put(
    mod.keys.observationsKey(runId),
    JSON.stringify({
      observations: [
        {
          observationId: `obs_d19_${caseId}`,
          facetInstanceId: caseId,
          attemptId: ATTEMPT_ID,
          routeId: PATH_ID,
          observedAt: "2026-08-05T00:05:00.000Z",
          payloadKind: "v2-walk-projection/1.0.0",
          payload,
          completeness: "complete-scoped-inventory",
          evidenceIds: [entry.evidenceId],
          // No decision is asserted here: the verify stage owns it.
          verifier: { decision: "insufficient", evidenceIds: [entry.evidenceId], verifierVersion: "none/not-yet-verified" },
          attestation: { producedBy: "v2-executor", producerVersion: "v2-observation-projection/1.0.0", payloadHash: "sha256:d19" },
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
      total: 5 + extraFacets.length,
      requirements: { total: 3, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
    };
    d.counts = { ...d.counts, exercised: 1, pending: 4 + extraFacets.length };
  });

  return { runId };
}

/** Run the REAL verify stage and hand back the summary plus the row it wrote. */
async function verifyCase(mod, env, opts) {
  const { runId } = await seedRunForCase(mod, env, opts);
  const result = await mod.verifyObservations.verifyObservations(env, runId);
  const ledger = JSON.parse(await (await env.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;
  return { runId, result, row: ledger.find((o) => o.facetInstanceId === opts.caseId) };
}

// ===========================================================================
suite("D19 — the verifier reads the case's own step, not the first matching one", () => {
  test("THE ONE THAT MATTERS: an earlier 'Yes' must not fabricate a defect about a healthy site", async () => {
    const mod = await worker();
    const env = testEnv();

    // A HEALTHY SITE. Q3 (a screener) is answered "Yes" and goes to Q12; the case's own
    // question Q7 is answered "Yes" and goes to Q9, exactly as the document requires.
    const { runId, result, row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, { on: "Q3. Do you use the product?", reached: "Q12. How much do you spend per month?" }),
        clickStep(1, { on: "Q7. Would you buy it again?", reached: "Q9. Which brands do you buy?" }),
      ],
    });

    assertEq(result.value.contradicted, 0, `a healthy site must produce NO defect claim: ${JSON.stringify(result.value.byReason)}`);
    assertEq(row.verifier.decision, "verified");
    assertEq(row.verifier.reason, "ROUTE_DESTINATION_REACHED");
    assert(
      !String(row.verifier.detail ?? "").includes("Q12"),
      `the verdict must be about Q7's own step, not Q3's: ${row.verifier.detail}`,
    );

    // AND THE CONSEQUENCE THE CLIENT SEES. Under the defect this requirement failed.
    const derived = await mod.deriveVerdicts.deriveItemResults(env, runId);
    const routing = derived.value.itemResults.find((r) => r.requirementLineageId === "req_d19route01");
    assertEq(routing.verdict, "pass", JSON.stringify(routing));
  });

  test("THE SYMMETRIC HALF: an earlier 'Yes' that landed on the destination must not conceal a real defect", async () => {
    const mod = await worker();
    const env = testEnv();

    // A BROKEN SITE. Q3 → Q9 (which is where the DOCUMENT says Q7 should go), while Q7 — the
    // case's own question — routes to Q12. Reading the first matching step mints a `verified`
    // over a real routing defect.
    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, { on: "Q3. Do you use the product?", reached: "Q9. Which brands do you buy?" }),
        clickStep(1, { on: "Q7. Would you buy it again?", reached: "Q12. How much do you spend per month?" }),
      ],
    });

    assertEq(result.value.verified, 0, "the case's own step went to Q12; nothing here may pass");
    assertEq(row.verifier.decision, "contradicted");
    assertEq(row.verifier.reason, "ROUTE_DESTINATION_MISMATCH");
    assert(String(row.verifier.detail).includes("Q12"), `the verdict must cite what Q7 actually reached: ${row.verifier.detail}`);
  });

  test("BOUNDARY, THE SAME DEFECT: an earlier field that accepted '151' must not fabricate a defect", async () => {
    const mod = await worker();
    const env = testEnv();

    // Q4 is a different numeric question and legitimately accepts 151. The case is about
    // Q12, which rejects it, exactly as documented.
    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_bound_q12",
      steps: [
        typeStep(0, { on: "Q4. How many units did you buy?", value: "151", rejected: false }),
        typeStep(1, { on: "Q12. How much do you spend per month?", value: "151", rejected: true }),
      ],
    });

    assertEq(result.value.contradicted, 0, `Q4 accepting 151 says nothing about Q12: ${JSON.stringify(result.value.byReason)}`);
    assertEq(row.verifier.decision, "verified");
    assertEq(row.verifier.reason, "BOUNDARY_REJECTED_AS_DOCUMENTED");
  });
});

// ===========================================================================
suite("D19 — when the case's own step cannot be identified, nothing is decided", () => {
  test("the stimulus happened on a screen that never identified itself — `insufficient`, and NAMED", async () => {
    const mod = await worker();
    const env = testEnv();

    // A survey whose screens do not print question ids. "Yes" was clicked, and the walk went
    // somewhere — but nothing in these bytes says WHICH question was answered, so no verdict
    // about Q7 is available. The old predicate read this step and called it a mismatch.
    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, { on: "Do you use the product?", reached: "Q12. How much do you spend per month?" }),
        clickStep(1, { on: "Would you buy it again?", reached: "Q9. Which brands do you buy?" }),
      ],
    });

    assertEq(result.value.contradicted, 0, "an unidentifiable step is not a defect");
    assertEq(result.value.verified, 0, "and it is not a pass either");
    assertEq(row.verifier.decision, "insufficient");
    assertEq(row.verifier.reason, "STEP_NOT_BOUND_TO_TARGET_QUESTION");
    assert(String(row.verifier.detail).includes("Q7"), `the limitation must name the question it could not find: ${row.verifier.detail}`);
  });

  test("two steps on the target question both took the documented answer — ambiguous, never guessed", async () => {
    const mod = await worker();
    const env = testEnv();

    // Back-navigation: Q7 is answered "Yes" twice and the two attempts went to different
    // screens. Picking either one is picking, not reading.
    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, { on: "Q7. Would you buy it again?", reached: "Q9. Which brands do you buy?" }),
        clickStep(1, { on: "Q7. Would you buy it again?", reached: "Q12. How much do you spend per month?" }),
      ],
    });

    assertEq(result.value.verified, 0);
    assertEq(result.value.contradicted, 0);
    assertEq(row.verifier.reason, "STEP_BINDING_AMBIGUOUS");
  });

  test("a sealed case naming no target question can never be decided", async () => {
    const mod = await worker();
    const env = testEnv();

    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_route_notarget",
      extraFacets: [
        facet("fi_route_notarget", {
          target: null,
          kind: "route",
          routeAnswer: { code: "1", label: "Yes" },
          destination: { questionId: "Q9", screen: null, terminal: null },
        }),
      ],
      steps: [clickStep(0, { on: "Q7. Would you buy it again?", reached: "Q9. Which brands do you buy?" })],
    });

    assertEq(result.value.verified, 0, "a case with no question to bind to must not ride an unrelated step to a pass");
    assertEq(row.verifier.reason, "CASE_TARGET_QUESTION_UNKNOWN");
  });

  test("the walk never took the documented answer AT ALL — that stays its own, different reason", async () => {
    const mod = await worker();
    const env = testEnv();

    // The distinction is load-bearing for the report: "the branch was never exercised" is a
    // fact about the walk; "I could not tell which step it was" is a limit of this verifier.
    const { row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, { on: "Q7. Would you buy it again?", code: "2", label: "No", reached: "Q12. How much do you spend per month?" }),
      ],
    });

    assertEq(row.verifier.decision, "insufficient");
    assertEq(row.verifier.reason, "ROUTE_ANSWER_NOT_SELECTED");
  });
});

// ===========================================================================
suite("D19 — binding does not intercept the verdicts that were already right", () => {
  test("two steps on the target question taking DIFFERENT answers still decide their own cases", async () => {
    const mod = await worker();
    const env = testEnv();

    // The shape D16 exercises: one screen, several documented answers, one walk. Only one
    // step took THIS case's answer, so there is nothing ambiguous about it.
    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, { on: "Q7. Would you buy it again?", code: "2", label: "No", reached: "Q12. How much do you spend per month?" }),
        clickStep(1, { on: "Q7. Would you buy it again?", code: "1", label: "Yes", reached: "Q9. Which brands do you buy?" }),
      ],
    });

    assertEq(result.value.verified, 1, JSON.stringify(result.value.byReason));
    assertEq(row.verifier.reason, "ROUTE_DESTINATION_REACHED");
  });

  test("a bound step whose destination prints no id is still `insufficient`, not a fabricated fail", async () => {
    const mod = await worker();
    const env = testEnv();

    // The shape D15 exercises. Binding must not turn "the destination cannot be identified"
    // into anything else.
    const { row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [clickStep(0, { on: "Q7. Would you buy it again?", reached: "Which brands do you buy?" })],
    });

    assertEq(row.verifier.decision, "insufficient");
    assertEq(row.verifier.reason, "DESTINATION_NOT_IDENTIFIABLE");
  });

  test("a bound step that did not advance is still `insufficient`", async () => {
    const mod = await worker();
    const env = testEnv();

    const { row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [clickStep(0, { on: "Q7. Would you buy it again?", reached: null, advanced: false })],
    });

    assertEq(row.verifier.reason, "ROUTE_NOT_ADVANCED");
  });
});

// ===========================================================================
suite("D19 — a screen that PIPES another question's id has not identified itself", () => {
  test("the reached screen presents the destination AND another sealed id — `insufficient`, not a pass", async () => {
    const mod = await worker();
    const env = testEnv();

    // The screen is Q12 and back-references Q9 ("earlier in Q9 you said…"). Matching the
    // destination token anywhere on the screen calls that a pass, and the real routing defect
    // (Q7 → Q12) disappears. The token rule cannot tell a pipe from an identity, so it says so.
    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, {
          on: "Q7. Would you buy it again?",
          reached: "Q12. Earlier in Q9 you said you buy several brands. How much do you spend per month?",
        }),
      ],
    });

    assertEq(result.value.verified, 0, "a screen presenting two sealed ids has not identified itself as either");
    assertEq(row.verifier.decision, "insufficient");
    assertEq(row.verifier.reason, "DESTINATION_AMBIGUOUS");
    assert(String(row.verifier.detail).includes("Q12"), `the limitation must name what else was on the screen: ${row.verifier.detail}`);
  });

  test("a step whose own screen presents two sealed ids cannot bind the case either", async () => {
    const mod = await worker();
    const env = testEnv();

    // Same rule at the other end: the step's own screen carries Q7 and Q3, so which question
    // was answered is unreadable — and this is the ONLY step that took the answer.
    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, {
          on: "Q7. You told us at Q3 that you use it. Would you buy it again?",
          reached: "Q9. Which brands do you buy?",
        }),
      ],
    });

    assertEq(result.value.verified, 0);
    assertEq(result.value.contradicted, 0);
    assertEq(row.verifier.reason, "STEP_NOT_BOUND_TO_TARGET_QUESTION");
  });
});

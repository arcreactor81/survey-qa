/**
 * D24 — A SCREEN MUST BE BINDABLE TO ITS QUESTION, OR THE RUN PRODUCES NOTHING.
 *
 * THE DEFECT. Screen identity was read from rendered text alone:
 *
 *     const haystack = norm(`${screen.questionText} ${screen.title} ${screen.visibleText}`);
 *
 * The instrument under test renders prose headings and prints no question numbers anywhere, so
 * `tokenOnScreen(screen, "Q7")` was FALSE ON EVERY SCREEN OF THE SURVEY. `stepsOnTargetQuestion`
 * returned `[]`, `selectCaseStep` returned STEP_NOT_BOUND_TO_TARGET_QUESTION, and every route and
 * boundary case exited at binding: A RUN THAT YIELDS ZERO VERDICTS. Not a wrong answer — an
 * absent one, which is worse to diagnose because every reason code looks principled.
 *
 * And the ids were in the artifact the whole time. `browser/page-script.ts` records `name` and
 * `id` for every control; the survey emits `name="<questionId>"` and `id="<questionId>_<code>"`.
 * The binder simply never looked at them.
 *
 * WHAT THESE TESTS ASSERT, and the split is the point:
 *
 *   POSITIVE (3) — a screen carrying its id ONLY in control attributes now binds, at BOTH call
 *   sites, and the run reaches a verdict. Every screen fixture below has TEXT WITH NO IDS IN IT,
 *   so each of these fails against text-only identity. That is the null-run-to-measurable proof.
 *
 *   FAIL-CLOSED (4) — controls resolving to two distinct sealed ids REFUSE, at both call sites,
 *   and a destination that could be one of two questions produces `insufficient` rather than a
 *   `violated` naming whichever came first. Reading more of the artifact must not buy a guess.
 *
 *   DEGRADATION (2) — a survey where the convention does NOT hold (GUID / framework-mangled
 *   names) refuses with a NAMED reason whose detail says identity was sought in both places.
 *   This is the CLAUDE.md requirement: a named limitation, never a wrong answer.
 *
 * THE CONVENTION THESE TESTS PIN, stated because pinning it is not the same as generalizing it:
 * "a control's `name` is the sealed question id" is a convention of the surveys we have. A real
 * Decipher / Qualtrics / SurveyJS instrument may emit `QID12_4`, a GUID, or nothing — which is
 * exactly what the two degradation tests fix in place as a REFUSAL rather than a wrong bind.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { passingGates } from "../fixtures/v2-fixture.mjs";

const PATH_ID = "FLOOR-D24";
const ATTEMPT_ID = "att_d24test01";
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// The sealed contract — the same vocabulary shape D19 uses, so the only variable
// under test is WHERE the id is found on a screen.
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

const facet = (id, { target, kind, routeAnswer = null, boundaryInput = null, destination = null, lineage = "req_d24route01" }) => ({
  facetInstanceId: id,
  requirementLineageId: lineage,
  requirementVersionId: lineage.replace("req_", "reqv_"),
  caseVersionId: `cv_${id}`,
  floorCase: true,
  targetQuestionId: target,
  expansionCertificate: `cert_${id}`,
  case: { kind, routeAnswer, boundaryInput, configuration: null, expectedDestination: destination },
  expectationGap: null,
  screen: target,
  label: `${id} on ${target}`,
});

const vocab = (id, target) => facet(id, { target, kind: "rendered-state", lineage: "req_d24render01" });

function contractBody() {
  return {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: "d".repeat(64),
    documentSha256: "d".repeat(64),
    sealedAt: "2026-08-05T00:00:00.000Z",
    requirements: [
      req("req_d24route01", "routing", 'When Q7 is answered "Yes", the survey must route to Q9.'),
      req("req_d24bound001", "validation", "Q12 must reject a spend above 150."),
      req("req_d24render01", "rendered-state", "Every screen must display exactly one question."),
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
        lineage: "req_d24bound001",
      }),
      vocab("fi_q3", "Q3"),
      vocab("fi_q9", "Q9"),
      vocab("fi_q12", "Q12"),
    ],
    contractSupplements: [],
    extraction: {
      passAHash: "sha256:aaa",
      passBHash: "sha256:bbb",
      sourceLedgerHash: "sha256:ccc",
      diffHash: "sha256:ddd",
      reviewMode: "high-risk-only",
      reviewedBy: "d24-fixture",
      reviewedAt: "2026-08-05T00:00:00.000Z",
      gates: passingGates(),
    },
  };
}

// ---------------------------------------------------------------------------
// Screens whose TEXT NEVER NAMES A QUESTION — exactly like the survey under test
// ---------------------------------------------------------------------------

/**
 * A control as `browser/page-script.ts` records it. Only `name` and `id` are load-bearing
 * here; the rest is present so the fixture is a real `ControlState` and not a stub shaped to
 * the assertion.
 */
const control = (idx, { name = null, id = null, code = "1", label = "Yes" }) => ({
  idx,
  tag: "input",
  type: "radio",
  name,
  id,
  code,
  label,
  text: "",
  checked: false,
  value: null,
  disabled: false,
  required: false,
  visible: true,
  placeholder: null,
  maxlength: null,
  readOnly: false,
});

/**
 * PROSE ONLY. `text` is what a respondent reads and it deliberately contains no question id,
 * so every positive test below is impossible to pass by reading text. `controls` is where the
 * identity lives — or does not.
 */
const screen = (text, controls = [], { validationMessages = [] } = {}) => ({
  at: "2026-08-05T00:05:00.000Z",
  url: "https://fixture.invalid/survey",
  title: null,
  collectedErrors: [],
  questionText: text,
  instructionText: null,
  visibleText: text,
  visibleTextTruncated: false,
  bracketedInstructionsVisible: [],
  controls,
  optionGroups: [],
  grid: null,
  buttons: [],
  progress: { present: false, kind: null, now: null, max: null, text: null },
  validationMessages,
  counts: { controls: controls.length, optionGroups: 0, options: controls.length, textInputs: 0 },
  screenSignature: `sig:${text}`,
});

/** The two option controls a radio question renders, named the way the survey names them. */
const namedOptions = (q) => [
  control(0, { name: q, id: `${q}_1`, code: "1", label: "Yes" }),
  control(1, { name: q, id: `${q}_2`, code: "2", label: "No" }),
];

/** The GRID shape: the per-row `name` is mangled, and only the `id` still carries the question. */
const gridOptions = (q) => [
  control(0, { name: `${q}_r1`, id: `${q}_r1_1`, code: "1", label: "Yes" }),
  control(1, { name: `${q}_r2`, id: `${q}_r2_1`, code: "1", label: "Yes" }),
];

/** A platform that does NOT follow the convention: opaque names, opaque ids. */
const foreignOptions = () => [
  control(0, { name: "QID_8f14e45f-ea6a-4c6b-9ba1-27b7d2f5a1c9", id: "ctl00$body$rb_0", code: "1", label: "Yes" }),
  control(1, { name: "QID_8f14e45f-ea6a-4c6b-9ba1-27b7d2f5a1c9", id: "ctl00$body$rb_1", code: "2", label: "No" }),
];

const stepBase = (index, before, extra) => ({
  stepIndex: index,
  // Deliberately wrong on every step: the driver's own guess is not a binder.
  decisionQuestion: "Q7",
  decisionSource: "plan",
  requested: { select: [], textEntry: null, action: null },
  screenBefore: before,
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

const clickStep = (index, { before, after, code = "1", label = "Yes", advanced = true }) =>
  stepBase(index, before, {
    requested: { select: [label], textEntry: null, action: null },
    screenAfterAdvance: advanced && after ? after : null,
    actions: [{ kind: "click-option", targetIdx: 0, targetLabel: label, targetCode: code, value: null, ok: true, detail: null }],
    advanced,
  });

const typeStep = (index, { before, value = "151", rejected = true }) =>
  stepBase(index, before, {
    requested: { select: [], textEntry: value, action: null },
    screenAfterAction: rejected
      ? screen(before.questionText, before.controls, { validationMessages: ["Please enter a value of 150 or less."] })
      : before,
    screenAfterAdvance: null,
    actions: [{ kind: "type-text", targetIdx: 0, targetLabel: null, targetCode: null, value, ok: true, detail: null }],
    advanced: false,
    blocked: rejected,
  });

const walkArtifact = (runId, steps) => ({
  kind: "v2-path-observation/1.0.0",
  runId,
  pathId: PATH_ID,
  tier: 1,
  attemptId: ATTEMPT_ID,
  planRevisionId: "plan_d24test01",
  surveyUrl: "https://fixture.invalid/survey",
  startedAt: "2026-08-05T00:04:00.000Z",
  endedAt: "2026-08-05T00:05:00.000Z",
  wallMs: 60000,
  plannedWitnesses: ["req_d24route01"],
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
// Seeding — the REAL verify stage over REAL content-addressed evidence
// ---------------------------------------------------------------------------

async function verifyCase(mod, env, { caseId, steps }) {
  const runId = mod.ids.mintRunId();
  const { contractRevisionId, contractHash } = await mod.contractRevision.sealContract(env, contractBody());

  const entry = await mod.evidence.putEvidence(env, {
    runId,
    bytes: enc.encode(JSON.stringify(walkArtifact(runId, steps))),
    mediaType: "application/json",
    type: "state",
    attemptId: ATTEMPT_ID,
    routeId: PATH_ID,
    witnesses: ["req_d24route01"],
    sourceEvidenceId: `EV-${PATH_ID}-observation`,
    artifactRef: `observations/${PATH_ID}/observation.json`,
  });

  await env.EVIDENCE.put(
    mod.keys.observationsKey(runId),
    JSON.stringify({
      observations: [
        {
          observationId: `obs_d24_${caseId}`,
          facetInstanceId: caseId,
          attemptId: ATTEMPT_ID,
          routeId: PATH_ID,
          observedAt: "2026-08-05T00:05:00.000Z",
          payloadKind: "v2-walk-projection/1.0.0",
          payload: {
            pathId: PATH_ID,
            attemptId: ATTEMPT_ID,
            observationEvidenceId: entry.evidenceId,
            outcome: "completed",
            outcomeDetail: null,
            screensAdvanced: steps.filter((s) => s.advanced).length,
            steps: steps.length,
            exercised: true,
            observedAt: "2026-08-05T00:05:00.000Z",
          },
          completeness: "complete-scoped-inventory",
          evidenceIds: [entry.evidenceId],
          verifier: { decision: "insufficient", evidenceIds: [entry.evidenceId], verifierVersion: "none/not-yet-verified" },
          attestation: { producedBy: "v2-executor", producerVersion: "v2-observation-projection/1.0.0", payloadHash: "sha256:d24" },
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
      total: 5,
      requirements: { total: 3, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
    };
    d.counts = { ...d.counts, exercised: 1, pending: 4 };
  });

  const result = await mod.verifyObservations.verifyObservations(env, runId);
  const ledger = JSON.parse(await (await env.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;
  return { runId, result, row: ledger.find((o) => o.facetInstanceId === caseId) };
}

// ===========================================================================
suite("D24 — a screen binds to its question by control attributes, not text alone", () => {
  test("THE ONE THAT MATTERS: a survey that prints no question ids still reaches a verdict", async () => {
    const mod = await worker();
    const env = testEnv();

    // Every screen here is PROSE ONLY. Under text-only identity Q7 is on no screen, the case
    // exits STEP_NOT_BOUND_TO_TARGET_QUESTION, and the run yields nothing.
    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, {
          before: screen("Do you use the product?", namedOptions("Q3")),
          after: screen("How much do you spend per month?", namedOptions("Q12")),
        }),
        clickStep(1, {
          before: screen("Would you buy it again?", namedOptions("Q7")),
          after: screen("Which brands do you buy?", namedOptions("Q9")),
        }),
      ],
    });

    assertEq(row.verifier.decision, "verified", `binding must reach a verdict: ${JSON.stringify(row.verifier)}`);
    assertEq(row.verifier.reason, "ROUTE_DESTINATION_REACHED");
    assertEq(result.value.verified, 1);
    assertEq(result.value.contradicted, 0, "a healthy site produces no defect claim");
  });

  test("BOTH ENDS ARE MARKUP: the ORIGIN binds and the DESTINATION is identified from controls", async () => {
    const mod = await worker();
    const env = testEnv();

    // The same walk with the DESTINATION's controls made foreign. If only the origin call site
    // were wired, this and the test above would be indistinguishable — both would bind and then
    // conclude nothing. This one must NOT reach a verdict; the one above must.
    const { row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(1, {
          before: screen("Would you buy it again?", namedOptions("Q7")),
          after: screen("Which brands do you buy?", foreignOptions()),
        }),
      ],
    });

    assertEq(row.verifier.decision, "insufficient");
    assertEq(row.verifier.reason, "DESTINATION_NOT_IDENTIFIABLE", "the origin bound; the destination did not");
  });

  test("THE GRID SHAPE: a mangled per-row `name` still binds through the `id` prefix", async () => {
    const mod = await worker();
    const env = testEnv();

    // `name="Q7_r1"` matches no sealed id; only `id="Q7_r1_1"` still carries Q7.
    const { row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, {
          before: screen("How much do you agree with each statement?", gridOptions("Q7")),
          after: screen("Which brands do you buy?", gridOptions("Q9")),
        }),
      ],
    });

    assertEq(row.verifier.decision, "verified", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "ROUTE_DESTINATION_REACHED");
  });

  test("THE BOUNDARY PREDICATE BINDS TOO — the fix is in the shared binder, not one predicate", async () => {
    const mod = await worker();
    const env = testEnv();

    const { row } = await verifyCase(mod, env, {
      caseId: "fi_bound_q12",
      steps: [
        typeStep(0, { before: screen("How old are you?", namedOptions("Q3")), value: "151", rejected: false }),
        typeStep(1, { before: screen("How much do you spend per month?", namedOptions("Q12")), value: "151", rejected: true }),
      ],
    });

    assertEq(row.verifier.decision, "verified", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "BOUNDARY_REJECTED_AS_DOCUMENTED");
  });
});

// ===========================================================================
// THE HALF THAT MATTERS. Reading more of the artifact must buy accuracy, never a guess.
// ===========================================================================
suite("D24 — reading control attributes must not buy a guess", () => {
  test("FAIL-CLOSED, ORIGIN: controls resolving to TWO sealed questions refuse to bind", async () => {
    const mod = await worker();
    const env = testEnv();

    // A screen carrying controls for Q7 AND Q3 has not identified itself: at most one of them
    // is its own question. Binding it to Q7 because Q7 is what we were looking for is the guess.
    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, {
          before: screen("Would you buy it again?", [...namedOptions("Q7"), ...namedOptions("Q3")]),
          after: screen("Which brands do you buy?", namedOptions("Q9")),
        }),
      ],
    });

    assertEq(row.verifier.decision, "insufficient", `two sealed ids must refuse: ${JSON.stringify(row.verifier)}`);
    assertEq(row.verifier.reason, "STEP_NOT_BOUND_TO_TARGET_QUESTION");
    assertEq(result.value.verified, 0);
    assertEq(result.value.contradicted, 0, "an unidentifiable screen is not a defect");
  });

  test("FAIL-CLOSED, ORIGIN: markup saying Q7 while the TEXT pipes Q3 refuses — the readings are UNIONED", async () => {
    const mod = await worker();
    const env = testEnv();

    // The union is the multi-question detector. If control identity simply OVERRODE text, this
    // screen would bind to Q7 and a piped back-reference would stop being visible at all.
    const { row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, {
          before: screen("Earlier at Q3 you said you use it. Would you buy it again?", namedOptions("Q7")),
          after: screen("Which brands do you buy?", namedOptions("Q9")),
        }),
      ],
    });

    assertEq(row.verifier.decision, "insufficient");
    assertEq(row.verifier.reason, "STEP_NOT_BOUND_TO_TARGET_QUESTION");
  });

  test("FAIL-CLOSED, DESTINATION: the expected id present ALONGSIDE another is ambiguous, not a pass", async () => {
    const mod = await worker();
    const env = testEnv();

    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, {
          before: screen("Would you buy it again?", namedOptions("Q7")),
          after: screen("Which brands do you buy?", [...namedOptions("Q9"), ...namedOptions("Q12")]),
        }),
      ],
    });

    assertEq(result.value.verified, 0, "a screen that could be two questions cannot witness a destination");
    assertEq(row.verifier.decision, "insufficient");
    assertEq(row.verifier.reason, "DESTINATION_AMBIGUOUS");
  });

  test("FAIL-CLOSED, DESTINATION: the expected id ABSENT and TWO others present is ambiguous, not a fabricated defect", async () => {
    const mod = await worker();
    const env = testEnv();

    // Q9 is nowhere; Q3 and Q12 are both on the reached screen. Naming either one as "where the
    // walk went" is a guess, and a `contradicted` is the one outcome a guess may never produce.
    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, {
          before: screen("Would you buy it again?", namedOptions("Q7")),
          after: screen("A few more things about you.", [...namedOptions("Q3"), ...namedOptions("Q12")]),
        }),
      ],
    });

    assertEq(result.value.contradicted, 0, `a guessed destination must never become a defect: ${JSON.stringify(row.verifier)}`);
    assertEq(row.verifier.decision, "insufficient");
    assertEq(row.verifier.reason, "DESTINATION_AMBIGUOUS");
  });

  test("A REAL MISMATCH IS STILL CLAIMABLE: exactly one other sealed id on the reached screen", async () => {
    const mod = await worker();
    const env = testEnv();

    // The counterweight to the two tests above: fail-closed must not mean fail-silent. The
    // document routes Q7 → Q9; the markup says the walk landed on Q12, unambiguously.
    const { row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, {
          before: screen("Would you buy it again?", namedOptions("Q7")),
          after: screen("How much do you spend per month?", namedOptions("Q12")),
        }),
      ],
    });

    assertEq(row.verifier.decision, "contradicted", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "ROUTE_DESTINATION_MISMATCH");
    assert(String(row.verifier.detail).includes("Q12"), `the claim must name what was reached: ${row.verifier.detail}`);
  });
});

// ===========================================================================
// THE CONVENTION IS A CONVENTION. When it does not hold, the answer is a NAMED
// limitation — never a wrong bind. (CLAUDE.md: no silent reliance on a convention.)
// ===========================================================================
suite("D24 — a platform that does not follow the convention degrades to a named limitation", () => {
  test("GUID and framework-mangled names bind NOTHING, and the reason says where identity was sought", async () => {
    const mod = await worker();
    const env = testEnv();

    // Neither `name` nor any `id` prefix is a sealed id, and the text prints none either. This
    // is a real Decipher/ASP.NET shape, and the ONLY acceptable outcome is a refusal.
    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, {
          before: screen("Would you buy it again?", foreignOptions()),
          after: screen("Which brands do you buy?", foreignOptions()),
        }),
      ],
    });

    assertEq(result.value.verified, 0, "an unreadable platform must not produce a pass");
    assertEq(result.value.contradicted, 0, "nor a defect claim");
    assertEq(row.verifier.decision, "insufficient");
    assertEq(row.verifier.reason, "STEP_NOT_BOUND_TO_TARGET_QUESTION");
    // The named limitation must say BOTH places were looked at, otherwise "we could not identify
    // the screen" is indistinguishable from "we never read the markup".
    assert(
      /name\/id attributes/.test(String(row.verifier.detail)),
      `the reason must name where identity was sought: ${row.verifier.detail}`,
    );
  });

  test("A DESTINATION on such a platform is NOT IDENTIFIABLE, and says so in the same terms", async () => {
    const mod = await worker();
    const env = testEnv();

    const { row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, {
          before: screen("Would you buy it again?", namedOptions("Q7")),
          after: screen("Which brands do you buy?", foreignOptions()),
        }),
      ],
    });

    assertEq(row.verifier.decision, "insufficient");
    assertEq(row.verifier.reason, "DESTINATION_NOT_IDENTIFIABLE");
    assert(
      /name\/id attributes/.test(String(row.verifier.detail)),
      `the reason must name where identity was sought: ${row.verifier.detail}`,
    );
  });
});

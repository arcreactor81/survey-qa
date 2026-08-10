/**
 * D35 — THE DRIVER AND THE VERIFIER MUST ANSWER "WHICH QUESTION IS THIS SCREEN?" THE SAME WAY.
 *
 * THE DISAGREEMENT THESE TESTS CLOSE. `browser/driver.ts` was rebuilt around the DOCUMENT'S
 * WORDING of a question (an F-measure at >=0.70 with a >=1.25x margin, corroborated by control
 * markup, with option-label overlap forbidden from ever binding) because option-label binding had
 * produced real confident-wrong answers. `verify-observations.ts` went on reading TEXT TOKENS +
 * MARKUP and never looked at wording at all. Two halves of one system, two answers to one
 * question, and both failure directions are real:
 *
 *   - THE VERIFIER COULD ACCEPT WHAT THE WALKER REFUSED. A screen that back-references the target
 *     in prose presents exactly `{target}` to `tokenOnScreen`. If the walker refused that screen
 *     and the navigator's default happened to perform the documented stimulus, a verdict came off
 *     a screen the walker itself declined to identify.
 *   - THE VERIFIER WAS BLIND WHERE THE WALKER COULD SEE. On an instrument that prints no ids and
 *     names no controls after them — the general case — the driver binds by wording and the
 *     verifier bound nothing: every case came back "exercised, and unverifiable".
 *
 * WHAT THE FOUR GROUPS BELOW ASSERT:
 *
 *   YIELD (1)        a survey with no ids anywhere now reaches a verdict through wording. This is
 *                    the null-run-to-measurable proof, and it fails against 1.3.0.
 *   FAIL-CLOSED (3)  a wording/markup CONFLICT refuses; a wording TIE refuses (both tied ids enter
 *                    the union, which is how the driver's `identity-ambiguous` is expressed here);
 *                    and — the line that did not move — a destination identified by WORDING ALONE
 *                    is `DESTINATION_IDENTIFIED_BY_TEXT_ONLY`, never a mismatch. Wording is
 *                    document prose matched against screen prose, so it is a text-class witness
 *                    and may not carry the one arm that accuses a client's survey.
 *   THE VETOES (3)   the walker's own `bindingRefusals` / `unboundDecisions` withhold a verdict,
 *                    and their ABSENCE on an older artifact withholds nothing.
 *   COUNTERWEIGHTS (3) fail-closed must not become fail-silent: both real Run-5 findings are
 *                    re-produced with a wording index in play, and a healthy survey is not accused.
 *
 * PLUS THE ANTI-DRIFT TEST. `WORDING_BIND_MIN` / `WORDING_MARGIN_RATIO` exist in BOTH modules
 * because the driver's are not exported. Two numbers in two files drift. So one test drives the
 * REAL `bindDecision` and the REAL `screenIdentity` over the same screens and asserts they reach
 * the same conclusion — move either number and this reddens.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { passingGates } from "../fixtures/v2-fixture.mjs";

const PATH_ID = "FLOOR-D35";
const ATTEMPT_ID = "att_d35test01";
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// THE DOCUMENT. The wording index is built from `facet: "question"` requirements
// scoped `question:<id>` — the same rows `plan.ts` stamped onto the decisions, so
// the verifier scores screens against the very text the driver scored them against.
// ---------------------------------------------------------------------------

/** Q7's own sentence. Long enough to clear MIN_WORDING_TOKENS, distinct enough to score alone. */
const Q7_WORDING =
  "In the past three months, have you tried a coffee product at home that was new to you?";
/** Q9's sentence — a different subject entirely, so it can never be confused with Q7's. */
const Q9_WORDING = "Which of these coffee brands do you buy most often for your household?";
/** Q12's sentence — the boundary question. */
const Q12_WORDING = "Roughly how much do you spend on coffee for your household each month?";
/**
 * THE CONFUSABLE TWIN. Deliberately built as a near-restatement of Q7 so the two score within
 * the margin of each other on Q7's screen. This is the measured shape the driver calibrated
 * against ("…have you tried a coffee product at home that was new to you" vs "You said that in
 * the past 3 months you have tried a coffee product…" scored 0.642), sharpened until it ties.
 */
const Q8_TWIN_WORDING =
  "In the past three months, have you tried a coffee product at home that was new to you at all?";

const req = (id, facet, scope, quote) => ({
  requirementLineageId: id,
  requirementVersionId: id.replace("req_", "reqv_"),
  semanticFingerprint: `fp_${id}`,
  scope,
  quantifier: "specific",
  selector: null,
  exceptions: [],
  facet,
  assertionStatus: "entailed",
  testability: "browser-observable",
  notBrowserObservableReason: null,
  sourceAtoms: [{ blockId: "B1", kind: "paragraph", coords: null, role: "normative", atomTextHash: "sha256:aa" }],
  composition: null,
  normativeStatement: quote,
  displayQuote: quote,
  retiredAt: null,
});

const facet = (id, { target, kind, routeAnswer = null, boundaryInput = null, destination = null, lineage = "req_d35route01" }) => ({
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

const vocab = (id, target) => facet(id, { target, kind: "rendered-state", lineage: "req_d35render01" });

/**
 * @param {{ wordQuestions?: boolean, twin?: boolean }} opts
 *   `wordQuestions: false` seals a revision that words NOTHING — the 1.3.0 world, used to prove
 *   the new witness is inert without it. `twin: true` adds Q8's confusable restatement.
 */
function contractBody({ wordQuestions = true, twin = false } = {}) {
  const requirements = [
    req("req_d35route01", "routing", "survey", 'When Q7 is answered "Yes", the survey must route to Q9.'),
    req("req_d35bound001", "validation", "survey", "Q12 must reject a spend above 150."),
    req("req_d35render01", "rendered-state", "survey", "Every screen must display exactly one question."),
  ];
  if (wordQuestions) {
    requirements.push(
      req("req_d35q7", "question", "question:Q7", Q7_WORDING),
      req("req_d35q9", "question", "question:Q9", Q9_WORDING),
      req("req_d35q12", "question", "question:Q12", Q12_WORDING),
    );
    if (twin) requirements.push(req("req_d35q8", "question", "question:Q8", Q8_TWIN_WORDING));
  }
  const facetInstances = [
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
      lineage: "req_d35bound001",
    }),
    vocab("fi_q9", "Q9"),
    vocab("fi_q12", "Q12"),
  ];
  if (twin) facetInstances.push(vocab("fi_q8", "Q8"));
  return {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: "d".repeat(64),
    documentSha256: "d".repeat(64),
    sealedAt: "2026-08-08T00:00:00.000Z",
    requirements,
    facetInstances,
    contractSupplements: [],
    extraction: {
      passAHash: "sha256:aaa",
      passBHash: "sha256:bbb",
      sourceLedgerHash: "sha256:ccc",
      diffHash: "sha256:ddd",
      reviewMode: "high-risk-only",
      reviewedBy: "d35-fixture",
      reviewedAt: "2026-08-08T00:00:00.000Z",
      gates: passingGates(),
    },
  };
}

// ---------------------------------------------------------------------------
// Screens. THE DEFAULT SHAPE PRINTS NO ID AND NAMES NO CONTROL AFTER ONE — the
// instrument that produced the null run. Identity therefore has to come from the
// wording or from nowhere, which is what makes the positive tests impossible to
// pass by reading tokens or markup.
// ---------------------------------------------------------------------------

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

/** Controls a platform names its own opaque way — present, and carrying no sealed id. */
const opaqueOptions = () => [
  control(0, { name: "ctl00$body$rb", id: "ctl00$body$rb_0", code: "1", label: "Yes" }),
  control(1, { name: "ctl00$body$rb", id: "ctl00$body$rb_1", code: "2", label: "No" }),
];

/** Controls that DO follow the convention — the markup witness. */
const namedOptions = (q) => [
  control(0, { name: q, id: `${q}_1`, code: "1", label: "Yes" }),
  control(1, { name: q, id: `${q}_2`, code: "2", label: "No" }),
];

const screen = (text, controls = [], { validationMessages = [], instructionText = null, optionGroups = [] } = {}) => ({
  at: "2026-08-08T00:05:00.000Z",
  url: "https://fixture.invalid/survey",
  title: null,
  collectedErrors: [],
  questionText: text,
  instructionText,
  visibleText: instructionText ? `${text} ${instructionText}` : text,
  visibleTextTruncated: false,
  bracketedInstructionsVisible: [],
  controls,
  optionGroups,
  grid: null,
  buttons: [],
  progress: { present: false, kind: null, now: null, max: null, text: null },
  validationMessages,
  counts: { controls: controls.length, optionGroups: 0, options: controls.length, textInputs: 0 },
  screenSignature: `sig:${text}`,
});

const stepBase = (index, before, extra) => ({
  stepIndex: index,
  // Deliberately wrong on every step: the producer's own guess is not a binder, and 1.4.0 does
  // not start reading `bindingVia` either.
  decisionQuestion: "Q99",
  decisionSource: "plan",
  bindingVia: "wording:0.99+markup:Q99",
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

const clickStep = (index, { before, after, code = "1", label = "Yes", advanced = true, ...extra }) =>
  stepBase(index, before, {
    requested: { select: [label], textEntry: null, action: null },
    screenAfterAdvance: advanced && after ? after : null,
    actions: [{ kind: "click-option", targetIdx: 0, targetLabel: label, targetCode: code, value: null, ok: true, detail: null }],
    advanced,
    ...extra,
  });

/**
 * A boundary step the survey ACCEPTED — it advanced and raised no message it was not already
 * showing. Against a document that requires rejection this is the `BOUNDARY_NOT_REJECTED`
 * finding, which is half the Run-5 regression baseline.
 */
const typeStepAccepted = (index, { before, after, value = "151", ...extra }) =>
  stepBase(index, before, {
    requested: { select: [], textEntry: value, action: null },
    screenAfterAction: before,
    screenAfterAdvance: after,
    actions: [{ kind: "type-text", targetIdx: 0, targetLabel: null, targetCode: null, value, ok: true, detail: null }],
    advanced: true,
    ...extra,
  });

const walkArtifact = (runId, steps, extra = {}) => ({
  kind: "v2-path-observation/1.0.0",
  runId,
  pathId: PATH_ID,
  tier: 1,
  attemptId: ATTEMPT_ID,
  planRevisionId: "plan_d35test01",
  surveyUrl: "https://fixture.invalid/survey",
  startedAt: "2026-08-08T00:04:00.000Z",
  endedAt: "2026-08-08T00:05:00.000Z",
  wallMs: 60000,
  plannedWitnesses: ["req_d35route01"],
  steps,
  outcome: "completed",
  outcomeDetail: null,
  shimmed: false,
  shimNote: null,
  loadFailure: null,
  evidenceIds: [],
  viewport: { width: 1280, height: 900 },
  ...extra,
});

// ---------------------------------------------------------------------------
// The REAL verify stage over REAL content-addressed evidence.
// ---------------------------------------------------------------------------

async function verifyCase(mod, env, { caseId, steps, walkExtra = {}, contract = {} }) {
  const runId = mod.ids.mintRunId();
  const body = contractBody(contract);
  const { contractRevisionId, contractHash } = await mod.contractRevision.sealContract(env, body);

  const entry = await mod.evidence.putEvidence(env, {
    runId,
    bytes: enc.encode(JSON.stringify(walkArtifact(runId, steps, walkExtra))),
    mediaType: "application/json",
    type: "state",
    attemptId: ATTEMPT_ID,
    routeId: PATH_ID,
    witnesses: ["req_d35route01"],
    sourceEvidenceId: `EV-${PATH_ID}-observation`,
    artifactRef: `observations/${PATH_ID}/observation.json`,
  });

  await env.EVIDENCE.put(
    mod.keys.observationsKey(runId),
    JSON.stringify({
      observations: [
        {
          observationId: `obs_d35_${caseId}`,
          facetInstanceId: caseId,
          attemptId: ATTEMPT_ID,
          routeId: PATH_ID,
          observedAt: "2026-08-08T00:05:00.000Z",
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
            observedAt: "2026-08-08T00:05:00.000Z",
          },
          completeness: "complete-scoped-inventory",
          evidenceIds: [entry.evidenceId],
          verifier: { decision: "insufficient", evidenceIds: [entry.evidenceId], verifierVersion: "none/not-yet-verified" },
          attestation: { producedBy: "v2-executor", producerVersion: "v2-observation-projection/1.0.0", payloadHash: "sha256:d35" },
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
      total: body.facetInstances.length,
      requirements: { total: body.requirements.length, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
    };
    d.counts = { ...d.counts, exercised: 1, pending: body.facetInstances.length - 1 };
  });

  const result = await mod.verifyObservations.verifyObservations(env, runId);
  const ledger = JSON.parse(await (await env.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;
  return { runId, result, row: ledger.find((o) => o.facetInstanceId === caseId) };
}

// ===========================================================================
suite("D35 — the document's wording is a screen-identity witness", () => {});

test("YIELD: a survey that prints NO ids and names NO controls now reaches a verdict", async () => {
  const mod = await worker();
  const env = testEnv();

  // Every screen here is prose with opaque markup — `tokenOnScreen` finds nothing and
  // `controlSealedIdsOnScreen` resolves nothing. Under 1.3.0 this is the NULL RUN: the case
  // exits at STEP_NOT_BOUND_TO_TARGET_QUESTION and no verdict exists. The only thing that can
  // bind it is the document's own wording of Q7 and Q9.
  const { row } = await verifyCase(mod, env, {
    caseId: "fi_route_q7",
    steps: [clickStep(0, { before: screen(Q7_WORDING, opaqueOptions()), after: screen(Q9_WORDING, opaqueOptions()) })],
  });

  assertEq(row.verifier.decision, "verified", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "ROUTE_DESTINATION_REACHED");
  assert(
    // THE STAMP MUST BE THE VERSION THIS BUILD ACTUALLY IS. A literal here ("…/1.5.0") pinned
    // the wrong property: it reddened on every deliberate version bump — 1.6.0 opened the
    // registry for `option-set` and did not touch this arm at all — while proving nothing about
    // the stamp, which is what a reader of two records compares. The yield this test measures is
    // the assertions above; this one is that the record says which predicate produced them.
    String(row.verifier.verifierVersion) === `${mod.verifyObservations.VERIFIER_VERSION}+no-model`,
    `the record must be stamped with this build's verifier version: ${row.verifier.verifierVersion}`,
  );
});

test("THE SAME WALK IS A NULL RUN WHEN THE DOCUMENT WORDS NOTHING — the witness is doing the work", async () => {
  const mod = await worker();
  const env = testEnv();

  // THE CONTROL FOR THE TEST ABOVE, and the thing that makes it impossible to pass by accident:
  // identical bytes, identical walk, a revision that simply carries no `facet: "question"` rows.
  // If this reached a verdict too, the previous test would be proving nothing about wording.
  const { row } = await verifyCase(mod, env, {
    caseId: "fi_route_q7",
    contract: { wordQuestions: false },
    steps: [clickStep(0, { before: screen(Q7_WORDING, opaqueOptions()), after: screen(Q9_WORDING, opaqueOptions()) })],
  });

  assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "STEP_NOT_BOUND_TO_TARGET_QUESTION");
});

test("FAIL-CLOSED: wording says one question and the markup says another — neither overrules", async () => {
  const mod = await worker();
  const env = testEnv();

  // The screen READS as Q7 and its form fields are named Q12. Exactly the driver's
  // `identity-conflict`: two witnesses, one of them wrong, and nothing here can say which. The
  // union carries both ids, the singleton rule declines, and no verdict is taken.
  const { row } = await verifyCase(mod, env, {
    caseId: "fi_route_q7",
    steps: [clickStep(0, { before: screen(Q7_WORDING, namedOptions("Q12")), after: screen(Q9_WORDING, opaqueOptions()) })],
  });

  assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "STEP_NOT_BOUND_TO_TARGET_QUESTION");
});

test("FAIL-CLOSED: a wording TIE refuses — both tied ids enter the union, and a tie-break would be a guess", async () => {
  const mod = await worker();
  const env = testEnv();

  // Q8's sealed wording is a near-restatement of Q7's, so on Q7's screen the two score within
  // the 1.25x margin of each other. The driver refuses this screen outright
  // (`identity-ambiguous`); this file expresses the same refusal by putting BOTH ids in the
  // union. A tie-break that quietly took the higher score would bind a screen the walker would
  // not have walked — which is the whole class of defect being closed.
  const { row } = await verifyCase(mod, env, {
    caseId: "fi_route_q7",
    contract: { twin: true },
    steps: [clickStep(0, { before: screen(Q7_WORDING, opaqueOptions()), after: screen(Q9_WORDING, opaqueOptions()) })],
  });

  assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "STEP_NOT_BOUND_TO_TARGET_QUESTION");
});

test("THE LINE THAT DID NOT MOVE: a destination identified by WORDING ALONE may not accuse", async () => {
  const mod = await worker();
  const env = testEnv();

  // The document routes Q7 -> Q9. The walk reached a screen the document's wording of Q12
  // describes, and NO control on it is named Q12. Wording is document prose matched against
  // screen prose — it fails exactly where a back-reference fails, on a screen that quotes or
  // summarises another question — so it may identify a screen for BINDING and may never carry
  // the arm that accuses a client's survey of a routing defect.
  const { result, row } = await verifyCase(mod, env, {
    caseId: "fi_route_q7",
    steps: [clickStep(0, { before: screen(Q7_WORDING, namedOptions("Q7")), after: screen(Q12_WORDING, opaqueOptions()) })],
  });

  assertEq(result.value.contradicted, 0, `wording must never author a mismatch: ${JSON.stringify(row.verifier)}`);
  assertEq(row.verifier.decision, "insufficient");
  assertEq(row.verifier.reason, "DESTINATION_IDENTIFIED_BY_TEXT_ONLY");
  assert(
    String(row.verifier.detail).includes("wording"),
    `the refusal must name the witness that saw it: ${row.verifier.detail}`,
  );
});

// ===========================================================================
suite("D35 — the walker's refusals are read as a veto, its bindings are not", () => {});

test("VETO: the walker refused THIS screen for THIS question, and the verifier stands down", async () => {
  const mod = await worker();
  const env = testEnv();

  // Identity here is unambiguous by every reading — wording AND markup say Q7 — so without the
  // veto this verifies. The walker's own record says it declined to bind Q7 to this same
  // screen. Two identity readings, opposite conclusions, and neither half may settle it alone.
  const { row } = await verifyCase(mod, env, {
    caseId: "fi_route_q7",
    steps: [
      clickStep(0, {
        before: screen(Q7_WORDING, namedOptions("Q7")),
        after: screen(Q9_WORDING, namedOptions("Q9")),
        bindingRefusals: [
          { question: "Q7", reason: "option-labels-only", detail: "this screen offers 1 label Q7 asks for, and nothing else links them" },
        ],
      }),
    ],
  });

  assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "WALKER_REFUSED_THIS_SCREEN");
});

test("VETO: a refusal about ANOTHER question is not this case's — the veto is precise, not blanket", async () => {
  const mod = await worker();
  const env = testEnv();

  // THE COUNTERWEIGHT TO THE TEST ABOVE. A veto that fired on any refusal at all would make
  // every busy screen unverifiable, which is fail-SILENT wearing fail-closed's clothes.
  const { row } = await verifyCase(mod, env, {
    caseId: "fi_route_q7",
    steps: [
      clickStep(0, {
        before: screen(Q7_WORDING, namedOptions("Q7")),
        after: screen(Q9_WORDING, namedOptions("Q9")),
        bindingRefusals: [{ question: "Q12", reason: "option-labels-only", detail: "not about Q7" }],
      }),
    ],
  });

  assertEq(row.verifier.decision, "verified", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "ROUTE_DESTINATION_REACHED");
});

test("VETO: the walk says it never bound a decision to this question at all", async () => {
  const mod = await worker();
  const env = testEnv();

  // `unboundDecisions` is the walk's account of what it did NOT do. A step bound to Q7 here was
  // answered by the navigator's default, not by the document's answer, however well the screen
  // identifies itself.
  const { row } = await verifyCase(mod, env, {
    caseId: "fi_route_q7",
    steps: [clickStep(0, { before: screen(Q7_WORDING, namedOptions("Q7")), after: screen(Q9_WORDING, namedOptions("Q9")) })],
    walkExtra: { unboundDecisions: [{ question: "Q7", wanted: ["Yes"], reason: "option-labels-only" }], bindingRefusalCount: 1 },
  });

  assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "TARGET_QUESTION_NEVER_BOUND_IN_WALK");
});

test("ABSENCE VETOES NOTHING: an artifact written before these fields existed verifies exactly as it did", async () => {
  const mod = await worker();
  const env = testEnv();

  // The optional-field contract, tested rather than asserted in a comment: no `bindingRefusals`,
  // no `unboundDecisions`, same bytes otherwise. Absence must not read as "the walker refused"
  // any more than it reads as "everything bound".
  const { row } = await verifyCase(mod, env, {
    caseId: "fi_route_q7",
    steps: [clickStep(0, { before: screen(Q7_WORDING, namedOptions("Q7")), after: screen(Q9_WORDING, namedOptions("Q9")) })],
  });

  assertEq(row.verifier.decision, "verified", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "ROUTE_DESTINATION_REACHED");
});

// ===========================================================================
suite("D35 — fail-closed must not become fail-silent", () => {});

test("THE RUN-5 FINDING SURVIVES: a markup-witnessed routing mismatch is still claimed, with wording in play", async () => {
  const mod = await worker();
  const env = testEnv();

  // "the document routes to Q9; the walk reached a screen whose own controls are named after
  // Q12" — the first real fail verdict this stage ever produced. The wording index is loaded and
  // the reached screen's own prose is Q12's, so both witnesses agree; the accusation still rests
  // on the markup.
  const { result, row } = await verifyCase(mod, env, {
    caseId: "fi_route_q7",
    steps: [clickStep(0, { before: screen(Q7_WORDING, namedOptions("Q7")), after: screen(Q12_WORDING, namedOptions("Q12")) })],
  });

  assertEq(result.value.contradicted, 1, JSON.stringify(row.verifier));
  assertEq(row.verifier.decision, "contradicted");
  assertEq(row.verifier.reason, "ROUTE_DESTINATION_MISMATCH");
  assert(
    String(row.verifier.detail).includes("controls are named after Q12"),
    `the finding must still name its markup witness: ${row.verifier.detail}`,
  );
});

test("THE RUN-5 FINDING SURVIVES: a boundary the survey should have rejected is still claimed", async () => {
  const mod = await worker();
  const env = testEnv();

  // "the document requires this input to be rejected; the survey advanced and raised no message
  // it was not already showing" — the second real fail verdict, bound to Q12 by wording alone on
  // a screen with opaque markup. The four-state read is untouched: it advanced, the delta of
  // validation messages is empty, so the outcome is ACCEPTED against a document that requires
  // rejection.
  const { result, row } = await verifyCase(mod, env, {
    caseId: "fi_bound_q12",
    steps: [typeStepAccepted(0, { before: screen(Q12_WORDING, opaqueOptions()), after: screen(Q9_WORDING, opaqueOptions()) })],
  });

  assertEq(result.value.contradicted, 1, JSON.stringify(row.verifier));
  assertEq(row.verifier.decision, "contradicted");
  assertEq(row.verifier.reason, "BOUNDARY_NOT_REJECTED");
  assert(
    String(row.verifier.detail).includes("raised no message it was not already showing"),
    `the delta witness must still be what carries it: ${row.verifier.detail}`,
  );
});

test("THE PRICE OF THE THIRD WITNESS, PINNED: a wording tie on the REACHED screen refuses instead of accusing", async () => {
  const mod = await worker();
  const env = testEnv();

  // THIS IS A DELIBERATE YIELD COST, WRITTEN DOWN SO IT CANNOT DRIFT EITHER WAY. The reached
  // screen's controls name Q12 unambiguously — under 1.3.0 that alone was a claimable
  // ROUTE_DESTINATION_MISMATCH. With a twin in the contract its wording ALSO ties between Q7 and
  // Q8, so the union carries more than one foreign id and "which screen was actually reached"
  // can no longer be read off it. The finding is withheld.
  //
  // We accept that: the alternative is an arm that names a destination while its own witnesses
  // disagree, and a `contradicted` is the one outcome a guess may never produce. It costs a
  // finding only where the reached screen's wording genuinely ties, which needs a rival scoring
  // within 1.25x of a near-perfect match (measured worst real confusable pair: 0.642).
  const origin = screen("Please answer the question below.", namedOptions("Q7"));
  const reached = screen(Q7_WORDING, namedOptions("Q12"));
  const { result, row } = await verifyCase(mod, env, {
    caseId: "fi_route_q7",
    contract: { twin: true },
    steps: [clickStep(0, { before: origin, after: reached })],
  });

  assertEq(result.value.contradicted, 0, JSON.stringify(row.verifier));
  assertEq(row.verifier.decision, "insufficient");
  assertEq(row.verifier.reason, "DESTINATION_AMBIGUOUS");
});

test("A HEALTHY SURVEY IS NOT ACCUSED: every case wording-identified, nothing contradicted", async () => {
  const mod = await worker();
  const env = testEnv();

  // The direction a fail-closed verifier is least likely to be tested in. A survey that routes
  // exactly as documented, read entirely through the new witness, must produce a pass and zero
  // accusations — a run that accuses nobody is the normal case, not the broken one.
  const routed = await verifyCase(mod, env, {
    caseId: "fi_route_q7",
    steps: [
      clickStep(0, { before: screen(Q7_WORDING, opaqueOptions()), after: screen(Q9_WORDING, opaqueOptions()) }),
      clickStep(1, { before: screen(Q9_WORDING, opaqueOptions()), after: screen(Q12_WORDING, opaqueOptions()) }),
    ],
  });
  assertEq(routed.result.value.contradicted, 0, JSON.stringify(routed.row.verifier));
  assertEq(routed.row.verifier.decision, "verified");

  // And the boundary the survey DOES refuse, on the same instrument.
  const bounded = await verifyCase(mod, env, {
    caseId: "fi_bound_q12",
    steps: [
      stepBase(0, screen(Q12_WORDING, []), {
        requested: { select: [], textEntry: "151", action: null },
        screenAfterAction: screen(Q12_WORDING, [], { validationMessages: ["Please enter a value of 150 or less."] }),
        screenAfterAdvance: null,
        actions: [{ kind: "type-text", targetIdx: 0, targetLabel: null, targetCode: null, value: "151", ok: true, detail: null }],
        advanced: false,
        blocked: true,
        blockedReason: "validation-visible",
      }),
    ],
  });
  assertEq(bounded.result.value.contradicted, 0, JSON.stringify(bounded.row.verifier));
  assertEq(bounded.row.verifier.decision, "verified");
  assertEq(bounded.row.verifier.reason, "BOUNDARY_REJECTED_AS_DOCUMENTED");
});

// ===========================================================================
suite("D35 — the driver and the verifier must not drift apart", () => {});

test("CROSS-MODULE AGREEMENT: the real binder and the real identity seam reach the same conclusion", async () => {
  const mod = await worker();

  // THE ANTI-DRIFT GUARD. `WORDING_BIND_MIN` and `WORDING_MARGIN_RATIO` live in BOTH modules
  // because the driver's copies are not exported, and two numbers in two files drift — which is
  // the exact defect class 1.4.0 exists to close, reappearing as a maintenance accident. So this
  // drives the REAL `bindDecision` and the REAL `screenIdentity` over one set of screens and
  // asserts they agree case by case. Change either threshold, or either scorer, and this reddens.
  const wording = new Map([
    ["Q7", { text: Q7_WORDING, scope: "question:Q7" }],
    ["Q9", { text: Q9_WORDING, scope: "question:Q9" }],
    ["Q8", { text: Q8_TWIN_WORDING, scope: "question:Q8" }],
  ]);
  const decisions = [
    { question: "Q7", question_text: Q7_WORDING, select: ["Yes"] },
    { question: "Q9", question_text: Q9_WORDING, select: [] },
    { question: "Q8", question_text: Q8_TWIN_WORDING, select: [] },
  ];
  const universe = ["Q7", "Q9", "Q8"];

  const cases = [
    { what: "a screen the document words unambiguously", screen: screen(Q9_WORDING, opaqueOptions()), expect: "Q9" },
    // MEASURED: Q7 scores 1.000 here and its twin Q8 scores 0.971, so the margin is 1.03x and
    // the pair is not separated. A genuine tie, not a fixture asserted to be one.
    { what: "a screen two wordings describe equally", screen: screen(Q7_WORDING, opaqueOptions()), expect: null },
    // MEASURED: Q9 scores 0.632 here — clear of every rival (Q12 at 0.316) but UNDER the 0.70
    // bar. This is the case that makes the BAR load-bearing rather than decorative: drop the
    // threshold and the verifier claims Q9 while the driver still refuses, and the two halves
    // are back to disagreeing. A paraphrase is not an identification.
    { what: "a screen the document only half describes", screen: screen("Which coffee brands do you buy?", opaqueOptions()), expect: null },
    { what: "a screen no wording describes", screen: screen("Thank you for taking part.", opaqueOptions()), expect: null },
  ];

  for (const c of cases) {
    const bound = mod.driver.bindDecision(c.screen, decisions, universe);
    const identity = mod.verifyObservations.screenIdentity(c.screen, universe, wording);
    const verifierSays = identity.wording.length === 1 ? identity.wording[0] : null;
    const driverSays = bound.match ? String(bound.match.decision.question) : null;

    assertEq(
      verifierSays,
      driverSays,
      `${c.what}: the driver bound ${driverSays} and the verifier's wording witness claims ` +
        `${JSON.stringify(identity.wording)} — the two halves must not disagree about identity`,
    );
    assertEq(verifierSays, c.expect, `${c.what}: expected ${c.expect}`);
    // And the tie must be VISIBLE, not silently dropped: a refused screen carries both rivals.
    if (c.expect === null && identity.wording.length > 0) {
      assert(identity.wording.length === 2, `a tie must surface both rivals: ${JSON.stringify(identity.wording)}`);
    }
  }
});

test("OPTION LABELS ARE STILL NOT IDENTITY, on either side of the seam", async () => {
  const mod = await worker();

  // The rule that fixed the driver's defect, checked from this file's side: a screen offering the
  // labels a decision wants, with no wording match and no markup, identifies nothing.
  // The screen OFFERS the label the decision wants — the only link between them — and nothing
  // else: no wording match, no control named after the question, no id in the heading.
  const offered = screen("Please choose one of the following.", opaqueOptions(), {
    optionGroups: [
      {
        name: "ctl00$body$rb",
        label: "Please choose one of the following.",
        multi: false,
        options: [
          { idx: 0, code: "1", label: "Yes", checked: false, disabled: false },
          { idx: 1, code: "2", label: "No", checked: false, disabled: false },
        ],
      },
    ],
  });
  const wording = new Map([["Q7", { text: Q7_WORDING, scope: "question:Q7" }]]);
  const identity = mod.verifyObservations.screenIdentity(offered, ["Q7"], wording);

  assertEq(identity.ids.length, 0, JSON.stringify(identity));
  assertEq(identity.wording.length, 0, JSON.stringify(identity));

  const bound = mod.driver.bindDecision(offered, [{ question: "Q7", question_text: Q7_WORDING, select: ["Yes"] }], ["Q7"]);
  assertEq(bound.match, null, "the driver must refuse it too");
  assert(
    bound.refusals.some((r) => r.reason === "option-labels-only"),
    `and say why: ${JSON.stringify(bound.refusals)}`,
  );
});

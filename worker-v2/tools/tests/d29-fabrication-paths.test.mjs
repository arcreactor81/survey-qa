/**
 * D29 — THE LAST TWO WAYS THIS SYSTEM COULD REPORT A CONFIDENT DEFECT ON A HEALTHY SURVEY.
 *
 * Both defects had the same shape: a predicate treating "I could not tell" as "I can tell, and
 * the answer is no". A withheld pass costs the run a finding. A fabricated defect costs the
 * product its claim to be worth reading, and it costs it on the surveys that are FINE — which
 * is most of them.
 *
 * ==================== PATH 1 — A TIMEOUT READ AS A REJECTION ====================
 *
 *     const rejected = step.blocked === true || (step.screenAfterAction?.validationMessages.length ?? 0) > 0;
 *
 * `blocked` is `!advanced`, and `advanced` is set by WINNING A POLLING RACE against
 * `advanceTimeoutMs` (`browser/driver.ts`). A slow-but-healthy survey loses that race and is,
 * at that line, byte-identical to a survey that refused the input.
 *
 * The naive repair — "require a validation message" — breaks the opposite arm: a survey that
 * refuses SILENTLY (a disabled Next button, no message) then reads as accepted, and a boundary
 * the document says must be rejected becomes `BOUNDARY_NOT_REJECTED`. And a naive TRI-state
 * still misses a fourth quadrant: server-side validation that navigates to an error
 * interstitial both ADVANCES and shows a message.
 *
 * So: FOUR states, two of which are `insufficient`. These tests pin all four, and they pin the
 * three inputs the middle two turn on — the witness must be a DELTA (the selector that collects
 * it also matches cookie banners), it must be ATTRIBUTABLE (the driver types the planned value
 * into every empty text control), and the quadrant must be keyed on `advanced` and NOT on
 * `blocked` (the no-advance-control path writes `blocked: false` with `advanced: false`, and a
 * disabled Next button lands on exactly that path).
 *
 * ==================== PATH 2 — A BACK-REFERENCE READ AS SCREEN IDENTITY ====================
 *
 * The route predicate's `violated` arm named `alsoPresent[0]` as "the screen actually reached".
 * A healthy screen that prints no id of its own and says "As you said in Q2, …" presents
 * exactly one foreign sealed id — so the length check that closed the two-id case does not
 * touch this one. Prose refers to other questions; a control's `name` does not. The accusing
 * arm therefore requires the MARKUP witness.
 *
 * ==================== THE COUNTERWEIGHTS ARE HALF THE FILE ====================
 *
 * Fail-closed must not become fail-silent. Every refusal below is paired with the case that
 * still reaches a verdict, because a predicate that answers `insufficient` to everything would
 * pass every test in the first half of this file and be worth nothing.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { passingGates } from "../fixtures/v2-fixture.mjs";

const PATH_ID = "FLOOR-D29";
const ATTEMPT_ID = "att_d29test01";
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// The sealed contract
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

const facet = (id, { target, kind, routeAnswer = null, boundaryInput = null, destination = null, lineage }) => ({
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

const vocab = (target) => facet(`fi_vocab_${target}`, { target, kind: "rendered-state", lineage: "req_d29render01" });

function contractBody() {
  return {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: "d".repeat(64),
    documentSha256: "d".repeat(64),
    sealedAt: "2026-08-08T00:00:00.000Z",
    requirements: [
      req("req_d29route01", "routing", 'When Q7 is answered "Yes", the survey must route to Q9.'),
      req("req_d29bound001", "validation", "Q12 must reject a spend above 150."),
      req("req_d29bound002", "validation", "Q14 must accept an age of 42."),
      req("req_d29render01", "rendered-state", "Every screen must display exactly one question."),
    ],
    facetInstances: [
      facet("fi_route_q7", {
        target: "Q7",
        kind: "route",
        routeAnswer: { code: "1", label: "Yes" },
        destination: { questionId: "Q9", screen: null, terminal: null },
        lineage: "req_d29route01",
      }),
      facet("fi_reject_q12", {
        target: "Q12",
        kind: "boundary",
        boundaryInput: { bound: "above-max", value: "151", expectedOutcome: "rejected" },
        lineage: "req_d29bound001",
      }),
      facet("fi_accept_q14", {
        target: "Q14",
        kind: "boundary",
        boundaryInput: { bound: "in-range", value: "42", expectedOutcome: "accepted" },
        lineage: "req_d29bound002",
      }),
      vocab("Q2"),
      vocab("Q3"),
      vocab("Q9"),
    ],
    contractSupplements: [],
    extraction: {
      passAHash: "sha256:aaa",
      passBHash: "sha256:bbb",
      sourceLedgerHash: "sha256:ccc",
      diffHash: "sha256:ddd",
      reviewMode: "high-risk-only",
      reviewedBy: "d29-fixture",
      reviewedAt: "2026-08-08T00:00:00.000Z",
      gates: passingGates(),
    },
  };
}

// ---------------------------------------------------------------------------
// Screens, as `browser/page-script.ts` records them
// ---------------------------------------------------------------------------

const radio = (idx, q, code, label) => ({
  idx,
  tag: "input",
  type: "radio",
  name: q,
  id: `${q}_${code}`,
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

const textInput = (idx, { name, label, value = "" }) => ({
  idx,
  tag: "input",
  type: "text",
  name,
  id: `${name}_input`,
  code: null,
  label,
  text: "",
  checked: null,
  value,
  disabled: false,
  required: false,
  visible: true,
  placeholder: null,
  maxlength: null,
  readOnly: false,
});

const nextBtn = (idx = 9, disabled = false) => ({ idx, label: "Next", role: "next", disabled, visible: true });

/**
 * PROSE FIRST, IDS ONLY WHERE A TEST PUTS THEM. `text` never contains a question id unless the
 * test is about text-carried identity, so nothing here binds by accident.
 */
const screen = (
  text,
  { controls = [], validationMessages = [], optionGroups = [], buttons = [nextBtn()], grid = null, sig = null } = {},
) => ({
  at: "2026-08-08T00:05:00.000Z",
  url: "https://fixture.invalid/survey",
  title: null,
  collectedErrors: [],
  questionText: text,
  instructionText: null,
  visibleText: text,
  visibleTextTruncated: false,
  bracketedInstructionsVisible: [],
  controls,
  optionGroups,
  grid,
  buttons,
  progress: { present: false, kind: null, now: null, max: null, text: null },
  validationMessages,
  counts: {
    controls: controls.length,
    optionGroups: optionGroups.length,
    options: optionGroups.reduce((n, g) => n + g.options.length, 0),
    textInputs: controls.filter((c) => c.type === "text").length,
  },
  // As `page-script.ts` computes it: question text plus the option inventory. NOT the
  // validation messages — a survey that shows an error is still the same screen, which is
  // exactly why the driver's "did it advance?" test cannot see a rejection on its own.
  screenSignature: sig ?? `sig:${text}`,
});

/** A radio question whose CONTROLS name it — the markup witness. */
const asked = (q, text, opts = {}) => screen(text, { controls: [radio(0, q, "1", "Yes"), radio(1, q, "2", "No")], ...opts });

/** A single-text-field question whose control names it. */
const fieldFor = (q, text, opts = {}) => screen(text, { controls: [textInput(0, { name: q, label: text })], ...opts });

const stepBase = (index, before, extra) => ({
  stepIndex: index,
  // Deliberately wrong everywhere: the driver's own guess is never a binder.
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

const clickStep = (index, { before, after = null, code = "1", label = "Yes", advanced = true }) =>
  stepBase(index, before, {
    requested: { select: [label], textEntry: null, action: null },
    screenAfterAdvance: advanced ? after : null,
    actions: [{ kind: "click-option", targetIdx: 0, targetLabel: label, targetCode: code, value: null, ok: true, detail: null }],
    advanced,
  });

/**
 * A boundary step, spelled out field by field, because every field is the variable in some
 * test below: what was typed and how many controls it went into, what each of the three
 * screens showed, whether the survey advanced, and what the walker said about why it stopped.
 */
const typeStep = (
  index,
  { before, afterAction = null, afterAdvance = null, value, advanced = false, blocked = null, blockedReason = null, writes = 1 },
) =>
  stepBase(index, before, {
    requested: { select: [], textEntry: value, action: null },
    screenAfterAction: afterAction,
    screenAfterAdvance: afterAdvance,
    actions: Array.from({ length: writes }, (_, i) => ({
      kind: "type-text",
      targetIdx: i,
      targetLabel: null,
      targetCode: null,
      value,
      ok: true,
      detail: null,
    })),
    advanced,
    blocked: blocked === null ? !advanced : blocked,
    blockedReason,
  });

const walkArtifact = (runId, steps) => ({
  kind: "v2-path-observation/1.0.0",
  runId,
  pathId: PATH_ID,
  tier: 1,
  attemptId: ATTEMPT_ID,
  planRevisionId: "plan_d29test01",
  surveyUrl: "https://fixture.invalid/survey",
  startedAt: "2026-08-08T00:04:00.000Z",
  endedAt: "2026-08-08T00:05:00.000Z",
  wallMs: 60000,
  plannedWitnesses: ["req_d29route01"],
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
// The REAL verify stage over REAL content-addressed evidence
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
    witnesses: ["req_d29route01"],
    sourceEvidenceId: `EV-${PATH_ID}-observation`,
    artifactRef: `observations/${PATH_ID}/observation.json`,
  });

  await env.EVIDENCE.put(
    mod.keys.observationsKey(runId),
    JSON.stringify({
      observations: [
        {
          observationId: `obs_d29_${caseId}`,
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
          attestation: { producedBy: "v2-executor", producerVersion: "v2-observation-projection/1.0.0", payloadHash: "sha256:d29" },
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
      total: 6,
      requirements: { total: 4, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
    };
    d.counts = { ...d.counts, exercised: 1, pending: 5 };
  });

  const result = await mod.verifyObservations.verifyObservations(env, runId);
  const ledger = JSON.parse(await (await env.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;
  return { runId, result, row: ledger.find((o) => o.facetInstanceId === caseId) };
}

const Q12_BEFORE = () => fieldFor("Q12", "How much do you spend per month?");
const Q14_BEFORE = () => fieldFor("Q14", "How old are you?");

// ===========================================================================
suite("D29 path 1 — a timeout is not a rejection, and a silence is not an acceptance", () => {
  test("THE ONE THAT MATTERS: a SLOW but healthy survey must not be accused of refusing a valid input", async () => {
    const mod = await worker();
    const env = testEnv();

    // The document says 42 is acceptable and the survey agrees — it is just slower than
    // `advanceTimeoutMs`. The walker recorded the honest reason: the clock ran out.
    // The old predicate read `blocked === true` as "the survey refused it" and minted
    // BOUNDARY_REJECTED_UNEXPECTEDLY: a confident defect about a working survey.
    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_accept_q14",
      steps: [
        typeStep(0, {
          before: Q14_BEFORE(),
          afterAction: Q14_BEFORE(),
          afterAdvance: Q14_BEFORE(),
          value: "42",
          advanced: false,
          blocked: true,
          blockedReason: "advance-timeout",
        }),
      ],
    });

    assertEq(result.value.contradicted, 0, `a slow page is not a defect: ${JSON.stringify(row.verifier)}`);
    assertEq(row.verifier.decision, "insufficient");
    assertEq(row.verifier.reason, "BOUNDARY_REJECTION_NOT_WITNESSED");
    assert(
      String(row.verifier.detail).includes("advance-timeout"),
      `the refusal to decide must name what the walker saw: ${row.verifier.detail}`,
    );
  });

  test("THE OTHER ARM, which the naive fix breaks: a SILENT refusal must not read as acceptance", async () => {
    const mod = await worker();
    const env = testEnv();

    // A disabled Next button is the common silent refusal, and `walkPath` records it on the
    // no-advance-control path — `blocked: false` AND `advanced: false`. A tri-state keyed on
    // `blocked` sees false, concludes "accepted", and ships BOUNDARY_NOT_REJECTED about a
    // survey that refused exactly as documented. Keying on `advanced` is what closes it.
    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_reject_q12",
      steps: [
        typeStep(0, {
          before: Q12_BEFORE(),
          afterAction: fieldFor("Q12", "How much do you spend per month?", { buttons: [nextBtn(9, true)] }),
          value: "151",
          advanced: false,
          blocked: false,
          blockedReason: "no-advance-control",
        }),
      ],
    });

    assertEq(result.value.contradicted, 0, `a silent refusal is not "the survey accepted it": ${JSON.stringify(row.verifier)}`);
    assertEq(row.verifier.decision, "insufficient");
    assertEq(row.verifier.reason, "BOUNDARY_REJECTION_NOT_WITNESSED");
    assert(String(row.verifier.detail).includes("no-advance-control"), row.verifier.detail);
  });

  test("THE FOURTH QUADRANT nobody enumerated: it ADVANCED and complained — decide nothing", async () => {
    const mod = await worker();
    const env = testEnv();

    // Server-side validation that navigates to an error interstitial. Under a tri-state
    // ("advanced → accepted") this is BOUNDARY_NOT_REJECTED — a defect claim against a survey
    // that rejected the input correctly, just on the server.
    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_reject_q12",
      steps: [
        typeStep(0, {
          before: Q12_BEFORE(),
          afterAction: Q12_BEFORE(),
          afterAdvance: screen("Sorry — something needs your attention.", {
            validationMessages: ["Please enter a value of 150 or less."],
          }),
          value: "151",
          advanced: true,
        }),
      ],
    });

    assertEq(result.value.contradicted, 0, `an error interstitial is not proof of acceptance: ${JSON.stringify(row.verifier)}`);
    assertEq(row.verifier.decision, "insufficient");
    assertEq(row.verifier.reason, "BOUNDARY_OUTCOME_CONFLICTING");
  });

  test("THE WITNESS IS A DELTA: a cookie banner already on the screen is not a rejection of what we typed", async () => {
    const mod = await worker();
    const env = testEnv();

    // `page-script.ts` collects `[aria-live]`, `[role=alert]`, `[class*=error]`. A cookie
    // banner, a toast and a live region all qualify, and they are there BEFORE we type. Under
    // a PRESENCE test the survey "refused" an input it accepted — BOUNDARY_REJECTED_UNEXPECTEDLY
    // on a healthy site, caused by the site having a cookie banner.
    const banner = ["We use cookies to improve your experience."];
    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_accept_q14",
      steps: [
        typeStep(0, {
          before: fieldFor("Q14", "How old are you?", { validationMessages: banner }),
          afterAction: fieldFor("Q14", "How old are you?", { validationMessages: banner }),
          afterAdvance: screen("Thanks — a few more questions.", { validationMessages: banner }),
          value: "42",
          advanced: true,
        }),
      ],
    });

    assertEq(result.value.contradicted, 0, `a cookie banner must not become a rejection: ${JSON.stringify(row.verifier)}`);
    assertEq(row.verifier.decision, "verified");
    assertEq(row.verifier.reason, "BOUNDARY_ACCEPTED_AS_DOCUMENTED");
  });

  test("ATTRIBUTION: the driver types into EVERY empty field, so a sibling's refusal decides nothing", async () => {
    const mod = await worker();
    const env = testEnv();

    // `applyDecision` writes the planned value into every empty text control. On a screen with
    // an age field and a postcode field, "42" goes into both; the postcode refuses it; one
    // screen-level message appears — and it was being read as the documented boundary's
    // rejection, producing BOUNDARY_REJECTED_UNEXPECTEDLY about a field that behaved.
    const twoFields = (msgs = []) =>
      screen("How old are you, and what is your postcode?", {
        controls: [
          textInput(0, { name: "Q14", label: "How old are you?" }),
          textInput(1, { name: "postcode", label: "Postcode" }),
        ],
        validationMessages: msgs,
      });

    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_accept_q14",
      steps: [
        typeStep(0, {
          before: twoFields(),
          afterAction: twoFields(["That is not a valid postcode."]),
          value: "42",
          advanced: false,
          blocked: true,
          blockedReason: "validation-visible",
          writes: 2,
        }),
      ],
    });

    assertEq(result.value.contradicted, 0, `a sibling field's refusal is not this case's: ${JSON.stringify(row.verifier)}`);
    assertEq(row.verifier.decision, "insufficient");
    assertEq(row.verifier.reason, "BOUNDARY_REJECTION_NOT_ATTRIBUTABLE");
    assert(String(row.verifier.detail).includes("2 text control"), row.verifier.detail);
  });

  test("ATTRIBUTION: an unanswered option group on the same screen is a rival explanation", async () => {
    const mod = await worker();
    const env = testEnv();

    // One text write, so exclusivity over TEXT controls holds — but the screen also carries a
    // radio group nobody answered, and "please answer this question" is a message about that,
    // not about the boundary. The driver only auto-answers groups on some screens, so this is
    // reachable in a real walk.
    const withGroup = (msgs = []) =>
      screen("How old are you, and do you consent?", {
        controls: [textInput(0, { name: "Q14", label: "How old are you?" }), radio(1, "Q14", "1", "I consent")],
        optionGroups: [
          { name: "Q14", kind: "radio", options: [{ order: 0, idx: 1, code: "1", label: "I consent", checked: false, disabled: false, visible: true }] },
        ],
        validationMessages: msgs,
      });

    const { row } = await verifyCase(mod, env, {
      caseId: "fi_accept_q14",
      steps: [
        typeStep(0, {
          before: withGroup(),
          afterAction: withGroup(["Please answer this question."]),
          value: "42",
          advanced: false,
          blocked: true,
          blockedReason: "validation-visible",
        }),
      ],
    });

    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "BOUNDARY_REJECTION_NOT_ATTRIBUTABLE");
    assert(String(row.verifier.detail).includes("unanswered"), row.verifier.detail);
  });

  test("THE WALKER'S REASON NAMES an `insufficient` — it never authors a rejection", async () => {
    const mod = await worker();
    const env = testEnv();

    // `control-disabled` is the walker's account of ITS OWN state: no enabled advance control
    // remained. That is not the survey saying it refused the value — a Next button greys out
    // for plenty of reasons — so it may sharpen the refusal to decide and never become one.
    const { row } = await verifyCase(mod, env, {
      caseId: "fi_reject_q12",
      steps: [
        typeStep(0, {
          before: Q12_BEFORE(),
          afterAction: fieldFor("Q12", "How much do you spend per month?", { buttons: [nextBtn(9, true)] }),
          value: "151",
          advanced: false,
          blocked: true,
          blockedReason: "control-disabled",
        }),
      ],
    });

    assertEq(row.verifier.decision, "insufficient", "a disabled control is not a witnessed rejection");
    assertEq(row.verifier.reason, "BOUNDARY_REJECTION_NOT_WITNESSED");
    assert(String(row.verifier.detail).includes("control-disabled"), row.verifier.detail);
  });
});

// ===========================================================================
// FAIL-CLOSED MUST NOT MEAN FAIL-SILENT.
// ===========================================================================
suite("D29 path 1 — the verdicts that must STILL be reachable", () => {
  test("A REAL REJECTION still verifies: no advance, and a message that was not there before", async () => {
    const mod = await worker();
    const env = testEnv();

    const { row } = await verifyCase(mod, env, {
      caseId: "fi_reject_q12",
      steps: [
        typeStep(0, {
          before: Q12_BEFORE(),
          afterAction: fieldFor("Q12", "How much do you spend per month?", {
            validationMessages: ["Please enter a value of 150 or less."],
          }),
          value: "151",
          advanced: false,
          blocked: true,
          blockedReason: "validation-visible",
        }),
      ],
    });

    assertEq(row.verifier.decision, "verified", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "BOUNDARY_REJECTED_AS_DOCUMENTED");
  });

  test("SUBMIT-TIME VALIDATION is now seen at all: the message lands AFTER Next, not after typing", async () => {
    const mod = await worker();
    const env = testEnv();

    // `screenAfterAction` is captured BEFORE Next is clicked, so a survey that validates on
    // submit — the common case — put its message in `screenAfterAdvance`, which the predicate
    // never read. The rejection was invisible and `blocked` was covering for it.
    const { row } = await verifyCase(mod, env, {
      caseId: "fi_reject_q12",
      steps: [
        typeStep(0, {
          before: Q12_BEFORE(),
          afterAction: Q12_BEFORE(),
          afterAdvance: fieldFor("Q12", "How much do you spend per month?", {
            validationMessages: ["Please enter a value of 150 or less."],
          }),
          value: "151",
          advanced: false,
          blocked: true,
          blockedReason: "validation-visible",
        }),
      ],
    });

    assertEq(row.verifier.decision, "verified", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "BOUNDARY_REJECTED_AS_DOCUMENTED");
  });

  test("A REAL `BOUNDARY_NOT_REJECTED` is still claimable: it advanced, and said nothing new", async () => {
    const mod = await worker();
    const env = testEnv();

    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_reject_q12",
      steps: [
        typeStep(0, {
          before: Q12_BEFORE(),
          afterAction: Q12_BEFORE(),
          afterAdvance: screen("Thanks — a few more questions."),
          value: "151",
          advanced: true,
        }),
      ],
    });

    assertEq(row.verifier.decision, "contradicted", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "BOUNDARY_NOT_REJECTED");
    assertEq(result.value.contradicted, 1);
  });

  test("A REAL `BOUNDARY_REJECTED_UNEXPECTEDLY` is still claimable when the rejection IS attributable", async () => {
    const mod = await worker();
    const env = testEnv();

    const { row } = await verifyCase(mod, env, {
      caseId: "fi_accept_q14",
      steps: [
        typeStep(0, {
          before: Q14_BEFORE(),
          afterAction: fieldFor("Q14", "How old are you?", { validationMessages: ["You must be at least 65."] }),
          value: "42",
          advanced: false,
          blocked: true,
          blockedReason: "validation-visible",
        }),
      ],
    });

    assertEq(row.verifier.decision, "contradicted", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "BOUNDARY_REJECTED_UNEXPECTEDLY");
  });
});

// ===========================================================================
suite("D29 path 2 — prose refers to other questions; markup does not", () => {
  test("THE ONE THAT MATTERS: a screen that says 'as you said in Q2' must not be reported AS Q2", async () => {
    const mod = await worker();
    const env = testEnv();

    // A HEALTHY SITE. The document routes Q7 → Q9; the walk went to Q9, which renders a prose
    // heading, prints no number of its own, and back-references Q2. Text-only identity reads
    // "the reached screen presents Q2", finds exactly one foreign id, and the old arm reported
    // a routing defect naming a screen the walk never visited.
    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, {
          before: asked("Q7", "Would you buy it again?"),
          after: screen("As you said in Q2, you buy weekly. Which brands do you buy?"),
        }),
      ],
    });

    assertEq(result.value.contradicted, 0, `a back-reference is not a destination: ${JSON.stringify(row.verifier)}`);
    assertEq(row.verifier.decision, "insufficient");
    assertEq(row.verifier.reason, "DESTINATION_IDENTIFIED_BY_TEXT_ONLY");
    assert(
      String(row.verifier.detail).toLowerCase().includes("back-reference"),
      `the refusal must say WHY prose is not identity: ${row.verifier.detail}`,
    );
  });

  test("THE SAME SCREEN WITH THE MARKUP WITNESS is a mismatch — the split buys accuracy, not silence", async () => {
    const mod = await worker();
    const env = testEnv();

    // Identical prose. The difference is that this screen's own controls are named Q2, which a
    // back-reference cannot be. That is a real routing defect and it must still be claimable.
    const { result, row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, {
          before: asked("Q7", "Would you buy it again?"),
          after: asked("Q2", "As you said in Q2, you buy weekly. Which brands do you buy?"),
        }),
      ],
    });

    assertEq(row.verifier.decision, "contradicted", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "ROUTE_DESTINATION_MISMATCH");
    assertEq(result.value.contradicted, 1);
    assert(String(row.verifier.detail).includes("Q2"), row.verifier.detail);
  });

  test("MARKUP ALONE is enough — the survey that prints no ids anywhere keeps its mismatch", async () => {
    const mod = await worker();
    const env = testEnv();

    // The t1-easy shape: prose headings, no numbers on screen, ids only in control attributes.
    // This is the case D24's control binder exists for, and 0.2 must not take it away again.
    const { row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, {
          before: asked("Q7", "Would you buy it again?"),
          after: asked("Q3", "Do you use the product?"),
        }),
      ],
    });

    assertEq(row.verifier.decision, "contradicted", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "ROUTE_DESTINATION_MISMATCH");
  });

  test("A DESTINATION REACHED AS DOCUMENTED still verifies", async () => {
    const mod = await worker();
    const env = testEnv();

    const { row } = await verifyCase(mod, env, {
      caseId: "fi_route_q7",
      steps: [
        clickStep(0, {
          before: asked("Q7", "Would you buy it again?"),
          after: asked("Q9", "Which brands do you buy?"),
        }),
      ],
    });

    assertEq(row.verifier.decision, "verified", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "ROUTE_DESTINATION_REACHED");
  });
});

// ===========================================================================
// THE WALKER'S OWN HALF. Everything above reads `blockedReason` out of an artifact; these
// prove the walker WRITES it, over the real `walkPath`, and that each of the four values
// corresponds to the situation it names. `PageLike` is a structural interface, so a fake page
// drives the production code with no browser anywhere — and until this file, not one line of
// `browser/driver.ts` had ever been executed by the suite.
// ===========================================================================

/**
 * A page that returns a scripted sequence of screens. Each `read` consumes the next one and
 * the last repeats, which is exactly how a real page behaves once it has stopped changing.
 */
function fakePage(reads) {
  const queue = [...reads];
  let last = reads[0] ?? null;
  const typed = [];
  const handle = () => ({
    async click() {},
    async type(text) {
      typed.push(text);
    },
    async focus() {},
  });
  return {
    typed,
    async goto() {},
    async evaluate(script) {
      // The screen reader is the only script whose RESULT this driver uses.
      if (typeof script === "string" && script.includes("screenSignature")) {
        if (queue.length > 0) last = queue.shift();
        return last;
      }
      return { ok: true };
    },
    async evaluateOnNewDocument() {},
    async $$() {
      return Array.from({ length: 12 }, handle);
    },
    async screenshot() {
      throw new Error("no screenshot in this harness");
    },
    async setViewport() {},
    on() {},
    async close() {},
    async reload() {},
  };
}

async function walk(mod, env, reads) {
  const runId = mod.ids.mintRunId();
  const cap = { env, runId, attemptId: ATTEMPT_ID, pathId: PATH_ID, witnesses: [] };
  return mod.driver.walkPath(
    fakePage(reads),
    { id: PATH_ID, decisions: [], witnesses: [] },
    {
      surveyUrl: "https://fixture.invalid/survey",
      runId,
      planRevisionId: "plan_d29test01",
      attemptId: ATTEMPT_ID,
      tier: 1,
      maxSteps: 1,
      deadline: Date.now() + 30_000,
      viewport: { width: 1280, height: 900 },
      applyHistoryShim: false,
      // Small on purpose: this is the race whose loser was being read as a rejection.
      advanceTimeoutMs: 200,
    },
    cap,
  );
}

const ageField = (opts = {}) => screen("How old are you?", { controls: [textInput(0, { name: "Q14", label: "Age" })], ...opts });

// ===========================================================================
suite("D29 — the walker records WHY it stopped, so the verifier reads a witness", () => {
  test("A LOST RACE is `advance-timeout` — the case that must never read as a rejection", async () => {
    const mod = await worker();
    const env = testEnv();

    // Next is pressed, the screen does not change within the timeout, nothing is said and the
    // advance control is still there. That is a slow page, and the walker says so.
    const stuck = ageField();
    const obs = await walk(mod, env, [stuck, stuck, stuck]);

    assertEq(obs.steps[0].advanced, false);
    assertEq(obs.steps[0].blocked, true);
    assertEq(obs.steps[0].blockedReason, "advance-timeout", JSON.stringify(obs.steps[0].blockedReason));
  });

  test("A MESSAGE THAT APPEARED is `validation-visible` — and it has to be NEW", async () => {
    const mod = await worker();
    const env = testEnv();

    // Same screen, same signature (an error does not change the question or its options), but
    // the page now says something it was not saying before.
    const obs = await walk(mod, env, [
      ageField(),
      ageField({ validationMessages: ["Please enter a whole number."] }),
      ageField({ validationMessages: ["Please enter a whole number."] }),
    ]);

    assertEq(obs.steps[0].blockedReason, "validation-visible");
  });

  test("A MESSAGE THAT WAS ALREADY THERE is not one: the cookie banner does not make it a rejection", async () => {
    const mod = await worker();
    const env = testEnv();

    // The identical message on every screen INCLUDING the first. The selector that collects it
    // matches `[aria-live]` and `[class*=error]`, so this is the common case, not a contrived one.
    const banner = ["We use cookies to improve your experience."];
    const obs = await walk(mod, env, [
      ageField({ validationMessages: banner }),
      ageField({ validationMessages: banner }),
      ageField({ validationMessages: banner }),
    ]);

    assertEq(obs.steps[0].blockedReason, "advance-timeout", "a pre-existing banner is not this submit's message");
  });

  test("AN ADVANCE CONTROL THAT WENT AWAY is `control-disabled`", async () => {
    const mod = await worker();
    const env = testEnv();

    // Next was enabled when it was pressed and is disabled afterwards — the shape of a survey
    // refusing quietly. Still not a verdict: it names an `insufficient` on the verifier side.
    const obs = await walk(mod, env, [ageField(), ageField(), ageField({ buttons: [nextBtn(9, true)] })]);

    assertEq(obs.steps[0].blockedReason, "control-disabled");
  });

  test("NO ENABLED ADVANCE CONTROL AT ALL is `no-advance-control` — the `blocked:false` trap", async () => {
    const mod = await worker();
    const env = testEnv();

    // THE KEYING TRAP, from the walker's side. Nothing is ever submitted, so `blocked` stays
    // FALSE while `advanced` is also false. A reader asking "was it rejected?" of `blocked`
    // sees false and concludes the survey accepted an input it never took.
    const disabled = ageField({ buttons: [nextBtn(9, true)] });
    const obs = await walk(mod, env, [disabled, disabled]);

    assertEq(obs.steps[0].advanced, false);
    assertEq(obs.steps[0].blocked, false, "the no-advance-control path leaves `blocked` false — that is the trap");
    assertEq(obs.steps[0].blockedReason, "no-advance-control");
    assertEq(obs.outcome, "no-advance-control");
  });

  test("A STEP THAT ADVANCED CARRIES NO REASON — the field never invents one", async () => {
    const mod = await worker();
    const env = testEnv();

    const obs = await walk(mod, env, [ageField(), ageField(), screen("Which brands do you buy?")]);

    assertEq(obs.steps[0].advanced, true);
    assertEq(obs.steps[0].blockedReason, null);
  });
});

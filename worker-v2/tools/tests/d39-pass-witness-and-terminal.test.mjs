/**
 * D39 — A PASS IS A CLAIM TOO, AND AN ENDING IS EVIDENCE ONLY WHEN IT IS BOUND.
 *
 * Two changes in `verify-observations.ts` 1.5.0, both about the same thing: which witness is
 * strong enough to CONCLUDE something about where a walk landed.
 *
 * ==================== THE FALSE PASS (the mirror of 0.2) ====================
 *
 * 0.2 made the route `violated` arm demand a MARKUP witness because prose back-references other
 * questions — and scoped that to the accusing arm. The `satisfied` arm went on reading the plain
 * union, so a RENDERED-TEXT TOKEN alone could mint a pass:
 *
 *     the document routes Q7 -> Q9; the survey actually lands on Q10; Q10 is nobody's
 *     `targetQuestionId` so nothing on it resolves; Q10's prose opens "As you said in Q9…".
 *     The identity union is exactly `{Q9}` — a singleton — and the case was VERIFIED.
 *
 * A real routing defect, certified as correct, by the arm nobody audits. `theFalsePass` below is
 * that walk, byte for byte, and it PASSES on 1.4.0.
 *
 * THE REPAIR IS NOT "PROSE MAY NOT PASS", and the tests are built to prove the difference. What
 * failed is prose read WITHOUT REGARD TO WHERE ON THE SCREEN IT SITS. Four readings, one hole:
 *
 *   BODY TOKEN     the id anywhere in the prose — including the body, which is where a
 *                  back-reference lives. THE HOLE, and the only reading removed.
 *   HEADING TOKEN  the id in the screen's own `questionText`/`title`. A numbered questionnaire
 *                  states its identity exactly there, and a heading is a claim about ITSELF.
 *   WORDING        precision taken against that same heading, so quoted body prose cannot
 *                  inflate it — and on an instrument that prints no ids at all it is the ONLY
 *                  witness there is.
 *   MARKUP         the fields this screen submits. Strongest.
 *
 * So `satisfied` requires MARKUP, WORDING or the HEADING token; `violated` still requires MARKUP
 * alone. THREE of the tests here are the counterweight: all three admissible witnesses must still
 * mint a pass. Markup-only-on-both-arms is the obvious "symmetric" fix and it is measurably
 * wrong — it turns four existing verified fixtures insufficient and takes every text-id and every
 * prose-only instrument with them, which is fail-SILENT wearing fail-closed's clothes.
 *
 * ==================== THE TERMINAL DESTINATION ====================
 *
 * "Answering No must SCREEN THE RESPONDENT OUT" was unverifiable by construction: every terminal
 * case returned `TERMINAL_DESTINATION_NOT_DISCRIMINABLE`, however plainly the walk reached the
 * screen-out. The walker now TYPES its ending, and that is the one bit this stage cannot
 * recompute — so everything AROUND it is recomputed here and every one of those fences gets a
 * test, because a fence nobody drove is not a fence:
 *
 *   - no typed ending  -> byte-for-byte the old answer. AN OLDER ARTIFACT MUST NOT BECOME
 *                        DECIDABLE, and a literal this build does not know counts as older,
 *                        never as a default. Nor does the walk's `outcome`, which is the false
 *                        friend the typed ending exists to replace.
 *   - `unclassified`   -> the producer's own counted residual stays a residual here, under its
 *                        own reason: a different work item from an artifact that predates the
 *                        field, and not a completion.
 *   - not this screen  -> the walk went on past this destination; its ending witnesses another.
 *   - still has a Next -> by this file's own reading it is not the end of anything.
 *   - quota / stalled  -> named refusals, forever and for this walk respectively.
 *
 * Evidence these can fail: `tools/mutate-verifier-destination.mjs`.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { passingGates } from "../fixtures/v2-fixture.mjs";

const PATH_ID = "FLOOR-D39";
const ATTEMPT_ID = "att_d39test01";
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// THE DOCUMENT
// ---------------------------------------------------------------------------

const Q7_WORDING = "In the past three months, have you tried a coffee product at home that was new to you?";
const Q9_WORDING = "Which of these coffee brands do you buy most often for your household?";
/**
 * Q10 IS NOT IN THE DOCUMENT'S CASE SET — that is the point of it. It is a real screen of the
 * survey that no case targets, so `sealedQuestionIds` never contains `Q10`, nothing on its screen
 * resolves to a sealed id, and the only sealed id it presents is the one it BACK-REFERENCES.
 */
const Q10_HEADING = "Thinking about your last supermarket trip, how many items did you put in the basket?";
const Q10_BACKREF = "As you said in Q9, brand choice matters. Please answer for that same brand.";

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

const facet = (id, { target, kind, routeAnswer = null, destination = null, lineage = "req_d39route01" }) => ({
  facetInstanceId: id,
  requirementLineageId: lineage,
  requirementVersionId: lineage.replace("req_", "reqv_"),
  caseVersionId: `cv_${id}`,
  floorCase: true,
  targetQuestionId: target,
  expansionCertificate: `cert_${id}`,
  case: { kind, routeAnswer, boundaryInput: null, configuration: null, expectedDestination: destination },
  expectationGap: null,
  screen: target,
  label: `${id} on ${target}`,
});

const vocab = (id, target) => facet(id, { target, kind: "rendered-state", lineage: "req_d39render01" });

/**
 * @param {{ wordQuestions?: boolean }} opts
 *   `wordQuestions: false` seals a revision that words nothing, which makes the WORDING witness
 *   inert. The false-pass test uses it so that the TOKEN reading is provably the only thing that
 *   could have carried the pass.
 */
function contractBody({ wordQuestions = true } = {}) {
  const requirements = [
    req("req_d39route01", "routing", "survey", 'When Q7 is answered "Yes", the survey must route to Q9.'),
    req("req_d39route02", "routing", "survey", 'When Q7 is answered "No", the respondent is screened out.'),
    req("req_d39render01", "rendered-state", "survey", "Every screen must display exactly one question."),
  ];
  if (wordQuestions) {
    requirements.push(req("req_d39q7", "question", "question:Q7", Q7_WORDING), req("req_d39q9", "question", "question:Q9", Q9_WORDING));
  }
  return {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: "e".repeat(64),
    documentSha256: "e".repeat(64),
    sealedAt: "2026-08-08T00:00:00.000Z",
    requirements,
    facetInstances: [
      facet("fi_route_q7", {
        target: "Q7",
        kind: "route",
        routeAnswer: { code: "1", label: "Yes" },
        destination: { questionId: "Q9", screen: null, terminal: null },
      }),
      facet("fi_out_q7", {
        target: "Q7",
        kind: "route",
        routeAnswer: { code: "2", label: "No" },
        destination: { questionId: null, screen: null, terminal: "screenout" },
        lineage: "req_d39route02",
      }),
      facet("fi_done_q7", {
        target: "Q7",
        kind: "route",
        routeAnswer: { code: "2", label: "No" },
        destination: { questionId: null, screen: null, terminal: "complete" },
        lineage: "req_d39route02",
      }),
      facet("fi_quota_q7", {
        target: "Q7",
        kind: "route",
        routeAnswer: { code: "2", label: "No" },
        destination: { questionId: null, screen: null, terminal: "quota" },
        lineage: "req_d39route02",
      }),
      vocab("fi_q9", "Q9"),
    ],
    contractSupplements: [],
    extraction: {
      passAHash: "sha256:aaa",
      passBHash: "sha256:bbb",
      sourceLedgerHash: "sha256:ccc",
      diffHash: "sha256:ddd",
      reviewMode: "high-risk-only",
      reviewedBy: "d39-fixture",
      reviewedAt: "2026-08-08T00:00:00.000Z",
      gates: passingGates(),
    },
  };
}

// ---------------------------------------------------------------------------
// Screens
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

/** Controls that follow the convention — the MARKUP witness. */
const namedOptions = (q) => [
  control(0, { name: q, id: `${q}_1`, code: "1", label: "Yes" }),
  control(1, { name: q, id: `${q}_2`, code: "2", label: "No" }),
];

const screen = (text, controls = [], { instructionText = null, buttons = [], signature = null } = {}) => ({
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
  optionGroups: [],
  grid: null,
  buttons,
  progress: { present: false, kind: null, now: null, max: null, text: null },
  validationMessages: [],
  counts: { controls: controls.length, optionGroups: 0, options: controls.length, textInputs: 0 },
  screenSignature: signature ?? `sig:${text}`,
});

/** The Q7 screen. Named controls, so binding never depends on what the test is measuring. */
const q7Screen = () => screen(Q7_WORDING, namedOptions("Q7"));

/** A terminal page: prose, no controls, and NOTHING to advance with. */
const endPage = (text) => screen(text, [], { signature: `sig:end:${text}` });

const ENABLED_NEXT = [{ idx: 9, label: "Next", role: "next", disabled: false, visible: true }];

const stepBase = (index, before, extra) => ({
  stepIndex: index,
  // Deliberately wrong on every step: the producer's own guess is not a binder.
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

/** The step the walker writes when a screen offers nothing to advance with. */
const deadEndStep = (index, before) => stepBase(index, before, { advanced: false, blockedReason: "no-advance-control" });

/**
 * A typed `WalkEnding`, in the producing side's OWN shape (`browser/types.ts`) — `{ kind,
 * evidence }`, never a bare string. Written through one helper so that if that contract ever
 * changes there is exactly one place here that has to follow it.
 */
const ended = (kind) => ({ kind, evidence: [`fixture: the final screen was classified ${kind}`] });

const walkArtifact = (runId, steps, extra = {}) => ({
  kind: "v2-path-observation/1.0.0",
  runId,
  pathId: PATH_ID,
  tier: 1,
  attemptId: ATTEMPT_ID,
  planRevisionId: "plan_d39test01",
  surveyUrl: "https://fixture.invalid/survey",
  startedAt: "2026-08-08T00:04:00.000Z",
  endedAt: "2026-08-08T00:05:00.000Z",
  wallMs: 60000,
  plannedWitnesses: ["req_d39route01"],
  steps,
  // `outcome` is the FALSE FRIEND: its "completed" means "the loop exited under budget". It is
  // set here on every walk precisely so that a verifier reading it instead of the typed ending
  // would pass the terminal tests for the wrong reason — and the no-ending test would go red.
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
    witnesses: ["req_d39route01"],
    sourceEvidenceId: `EV-${PATH_ID}-observation`,
    artifactRef: `observations/${PATH_ID}/observation.json`,
  });

  await env.EVIDENCE.put(
    mod.keys.observationsKey(runId),
    JSON.stringify({
      observations: [
        {
          observationId: `obs_d39_${caseId}`,
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
          attestation: { producedBy: "v2-executor", producerVersion: "v2-observation-projection/1.0.0", payloadHash: "sha256:d39" },
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

/** The walk that produced the false pass: Q7 -> a screen that only BACK-REFERENCES Q9. */
const theFalsePass = () => [
  clickStep(0, {
    before: q7Screen(),
    after: screen(Q10_HEADING, opaqueOptions(), { instructionText: Q10_BACKREF }),
  }),
];

/** The same route, landing on a screen whose OWN CONTROLS are named after Q9. */
const theMarkupPass = () => [clickStep(0, { before: q7Screen(), after: screen("Which brands?", namedOptions("Q9")) })];

/** The same route on an instrument that prints nothing: only the document's WORDING identifies it. */
const theWordingPass = () => [clickStep(0, { before: q7Screen(), after: screen(Q9_WORDING, opaqueOptions()) })];

/**
 * The TEXT-ID instrument: the destination screen states its own id IN ITS HEADING, the way a
 * numbered questionnaire renders. No markup, and the revision need not word anything.
 */
const theHeadingPass = () => [
  clickStep(0, { before: q7Screen(), after: screen("Q9. Which brands do you buy?", opaqueOptions()) }),
];

/** A screen-out walk: "No" advances to a dead-end page the walk then stops on. */
const theScreenOutWalk = () => {
  const out = endPage("Thank you for your interest. Unfortunately you do not qualify for this study.");
  return [clickStep(0, { before: q7Screen(), after: out, code: "2", label: "No" }), deadEndStep(1, out)];
};

// ===========================================================================
suite("D39 — a PASS needs a witness that cannot be a back-reference", () => {});

test("THE FALSE PASS: a screen that only BACK-REFERENCES the destination does not certify the route", async () => {
  const mod = await worker();
  const env = testEnv();

  // The reached screen is Q10 — a real screen of the survey that NO case targets, so it resolves
  // to nothing sealed and `alsoPresent` is empty. Its prose says "As you said in Q9…", so the
  // TOKEN reading presents exactly `{Q9}`. Under 1.4.0 that singleton was a PASS, and the walk
  // that produced it had gone somewhere the document never sent it.
  const { row } = await verifyCase(mod, env, {
    caseId: "fi_route_q7",
    contract: { wordQuestions: false },
    steps: theFalsePass(),
  });

  assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "DESTINATION_PRESENTED_BY_TEXT_TOKEN_ONLY");
});

test("THE FALSE PASS IS NOT RESCUED BY THE WORDING INDEX — a back-reference still is not an identity", async () => {
  const mod = await worker();
  const env = testEnv();

  // THE CONTROL FOR THE TEST ABOVE. Identical walk, identical bytes, a revision that DOES word
  // Q7 and Q9. If wording claimed Q9 for a screen whose heading is a different question entirely,
  // the new gate would be satisfiable by prose after all and the repair would be cosmetic.
  const { row } = await verifyCase(mod, env, { caseId: "fi_route_q7", steps: theFalsePass() });

  assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "DESTINATION_PRESENTED_BY_TEXT_TOKEN_ONLY");
});

test("COUNTERWEIGHT: a destination named by its OWN CONTROLS is still a pass", async () => {
  const mod = await worker();
  const env = testEnv();

  const { row } = await verifyCase(mod, env, {
    caseId: "fi_route_q7",
    contract: { wordQuestions: false },
    steps: theMarkupPass(),
  });

  assertEq(row.verifier.decision, "verified", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "ROUTE_DESTINATION_REACHED");
  assert(
    // The STAMP, not a literal: see the same note in d35. A pinned version string reddens on
    // every deliberate bump (1.6.0 opened the registry for `option-set`) without testing the
    // property a reader of two records depends on — that the record names the build that judged it.
    String(row.verifier.verifierVersion) === `${mod.verifyObservations.VERIFIER_VERSION}+no-model`,
    `the record must be stamped with this build's verifier version: ${row.verifier.verifierVersion}`,
  );
});

test("COUNTERWEIGHT: a destination identified by the DOCUMENT'S OWN WORDING is still a pass", async () => {
  const mod = await worker();
  const env = testEnv();

  // THE ONE THAT STOPS THIS BECOMING FAIL-SILENT. The instrument this system was built against
  // prints no ids and names its controls opaquely — wording is the only witness it has. A
  // markup-only `satisfied` would return that whole survey to the null run, which is deleting
  // 1.4.0 to close 0.2's mirror image.
  const { row } = await verifyCase(mod, env, { caseId: "fi_route_q7", steps: theWordingPass() });

  assertEq(row.verifier.decision, "verified", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "ROUTE_DESTINATION_REACHED");
});

test("COUNTERWEIGHT: a TEXT-ID instrument that prints the id in its own HEADING is still a pass", async () => {
  const mod = await worker();
  const env = testEnv();

  // THE OTHER HALF OF THE FAIL-SILENT COUNTERWEIGHT, and the reason the rule is not "markup or
  // nothing". A numbered questionnaire renders "Q9. Which brands do you buy?" as the screen's own
  // heading and names no control after anything. That heading is a statement about ITSELF; the
  // body sentence that quotes another question is not. Requiring markup here would turn four
  // existing verified fixtures insufficient and take every text-id survey with them.
  const { row } = await verifyCase(mod, env, {
    caseId: "fi_route_q7",
    contract: { wordQuestions: false },
    steps: theHeadingPass(),
  });

  assertEq(row.verifier.decision, "verified", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "ROUTE_DESTINATION_REACHED");
  assert(/in its own heading/.test(row.verifier.detail), row.verifier.detail);
});

test("THE HEADING AND THE BODY ARE THE SAME BYTES TO THE OLD READING — one passes, one does not", async () => {
  const mod = await worker();
  const env = testEnv();

  // The discriminating pair, run back to back on ONE assertion. Both screens contain the string
  // "Q9" in their rendered text and `tokenOnScreen` cannot tell them apart; the pass turns
  // entirely on WHERE it is. If the split ever stops being made, these two converge — to two
  // passes if the body is readmitted, to two refusals if the heading is dropped — and either way
  // this reddens.
  const heading = await verifyCase(mod, env, {
    caseId: "fi_route_q7",
    contract: { wordQuestions: false },
    steps: theHeadingPass(),
  });
  const body = await verifyCase(mod, env, {
    caseId: "fi_route_q7",
    contract: { wordQuestions: false },
    steps: theFalsePass(),
  });

  assertEq(heading.row.verifier.decision, "verified", JSON.stringify(heading.row.verifier));
  assertEq(body.row.verifier.decision, "insufficient", JSON.stringify(body.row.verifier));
  assert(
    heading.row.verifier.decision !== body.row.verifier.decision,
    "a heading and a back-reference must not reach the same conclusion",
  );
});

test("REGRESSION BASELINE: the walk reached a screen whose OWN CONTROLS are named after another question", async () => {
  const mod = await worker();
  const env = testEnv();

  // `ROUTE_DESTINATION_MISMATCH` is one of the two real findings this pipeline produced on a live
  // survey. The accusing arm did not move in 1.5.0 and this is the proof it still fires.
  const { row } = await verifyCase(mod, env, {
    caseId: "fi_route_q7",
    contract: { wordQuestions: false },
    steps: [clickStep(0, { before: q7Screen(), after: screen("Some other question", namedOptions("Q7")) })],
  });

  assertEq(row.verifier.decision, "contradicted", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "ROUTE_DESTINATION_MISMATCH");
  assert(/controls are named after Q7/.test(row.verifier.detail), row.verifier.detail);
});

// ===========================================================================
suite("D39 — a terminal destination, and only when the ending is bound to it", () => {});

test("AN OLDER ARTIFACT DOES NOT BECOME DECIDABLE: no typed ending is exactly as undecided as before", async () => {
  const mod = await worker();
  const env = testEnv();

  // The walk carries `outcome: "completed"` — the FALSE FRIEND. A verifier reading that instead
  // of the typed ending would call this a screen-out mismatch and be confidently wrong about an
  // artifact that simply predates the field.
  const { row } = await verifyCase(mod, env, { caseId: "fi_out_q7", steps: theScreenOutWalk() });

  assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "TERMINAL_DESTINATION_NOT_DISCRIMINABLE");
});

test("AN UNRECOGNISED ENDING IS TREATED AS ABSENT, never as a default", async () => {
  const mod = await worker();
  const env = testEnv();

  const { row } = await verifyCase(mod, env, {
    caseId: "fi_out_q7",
    steps: theScreenOutWalk(),
    walkExtra: { ending: ended("finished") },
  });

  assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "TERMINAL_DESTINATION_NOT_DISCRIMINABLE");
});

test("THE SCREEN-OUT IS VERIFIABLE: the document screens this respondent out and the walk ended screened-out", async () => {
  const mod = await worker();
  const env = testEnv();

  const { row } = await verifyCase(mod, env, {
    caseId: "fi_out_q7",
    steps: theScreenOutWalk(),
    walkExtra: { ending: ended("screened-out") },
  });

  assertEq(row.verifier.decision, "verified", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "ROUTE_TERMINAL_AS_DOCUMENTED");
});

test("THE PRODUCER'S FOURTH STATE STAYS UNDECIDED — `unclassified` is a residual, not a completion", async () => {
  const mod = await worker();
  const env = testEnv();

  // `WalkEnding` has four states, and the fourth exists so an ending nobody could name is COUNTED
  // rather than defaulted. Consuming it as anything but a refusal here would rebuild the defect
  // the type was introduced to remove, one module downstream — and it gets its OWN reason,
  // because "the walker looked and could not tell" is a different work item from "this artifact
  // predates endings".
  const { row } = await verifyCase(mod, env, {
    caseId: "fi_out_q7",
    steps: theScreenOutWalk(),
    walkExtra: { ending: { kind: "unclassified", evidence: ["no terminal marker matched"] } },
  });

  assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "TERMINAL_ENDING_UNCLASSIFIED");
});

test("THE DEFECT: the document screens this respondent out and the survey completed the interview", async () => {
  const mod = await worker();
  const env = testEnv();

  const { row } = await verifyCase(mod, env, {
    caseId: "fi_out_q7",
    steps: theScreenOutWalk(),
    walkExtra: { ending: ended("completed") },
  });

  assertEq(row.verifier.decision, "contradicted", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "ROUTE_TERMINAL_MISMATCH");
});

test("AND THE OTHER DIRECTION: a documented COMPLETION that completes is a pass, not an accusation", async () => {
  const mod = await worker();
  const env = testEnv();

  const { row } = await verifyCase(mod, env, {
    caseId: "fi_done_q7",
    steps: theScreenOutWalk(),
    walkExtra: { ending: ended("completed") },
  });

  assertEq(row.verifier.decision, "verified", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "ROUTE_TERMINAL_AS_DOCUMENTED");
});

test("AN ENDING ABOUT ANOTHER SCREEN DECIDES NOTHING — the walk carried on past this destination", async () => {
  const mod = await worker();
  const env = testEnv();

  // "No" advanced to Q9, the walk answered that too, and only THEN ended. The walk really did end
  // screened-out; it is simply not what this answer led to. Without the binding check this is a
  // confident pass for a route that never screened anybody out.
  const q9 = screen("Which brands?", namedOptions("Q9"), { buttons: ENABLED_NEXT });
  const out = endPage("Thank you for your interest. Unfortunately you do not qualify for this study.");
  const { row } = await verifyCase(mod, env, {
    caseId: "fi_out_q7",
    steps: [
      clickStep(0, { before: q7Screen(), after: q9, code: "2", label: "No" }),
      clickStep(1, { before: q9, after: out, code: "2", label: "No" }),
      deadEndStep(2, out),
    ],
    walkExtra: { ending: ended("screened-out") },
  });

  assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "TERMINAL_ENDING_NOT_BOUND_TO_DESTINATION");
});

test("A SCREEN THAT STILL OFFERS NEXT IS NOT THE END OF ANYTHING, whatever the ending says", async () => {
  const mod = await worker();
  const env = testEnv();

  // The walker's ending and this file's own reading of the same bytes disagree. Neither half may
  // settle that alone, so the case is refused and the disagreement is named.
  const notReallyOver = screen("Thanks — one more thing", [], { buttons: ENABLED_NEXT, signature: "sig:end:soft" });
  const { row } = await verifyCase(mod, env, {
    caseId: "fi_out_q7",
    steps: [clickStep(0, { before: q7Screen(), after: notReallyOver, code: "2", label: "No" })],
    walkExtra: { ending: ended("screened-out") },
  });

  assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "DESTINATION_NOT_STRUCTURALLY_TERMINAL");
});

test("A STALLED WALK REACHED NO ENDING the document could name", async () => {
  const mod = await worker();
  const env = testEnv();

  const { row } = await verifyCase(mod, env, {
    caseId: "fi_out_q7",
    steps: theScreenOutWalk(),
    walkExtra: { ending: ended("stalled") },
  });

  assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "WALK_DID_NOT_REACH_AN_ENDING");
});

test("QUOTA IS NEVER DECIDABLE — a quota-full page and a screen-out page are the same DOM", async () => {
  const mod = await worker();
  const env = testEnv();

  const { row } = await verifyCase(mod, env, {
    caseId: "fi_quota_q7",
    steps: theScreenOutWalk(),
    walkExtra: { ending: ended("screened-out") },
  });

  assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
  assertEq(row.verifier.reason, "TERMINAL_KIND_HAS_NO_WITNESS");
});

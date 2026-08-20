/**
 * D43 — THE WALKER TYPED IT, THE RECORD DID NOT CARRY IT.
 *
 * ==================== THE MEASURED GAP ====================
 *
 * Deployed `e821ecd7`, live run `v2r_01kzggtye653abaa36sxeg23yd` (migraine). All 41
 * observations report `screensAdvanced: 5` — the walker really does traverse the whole survey
 * now, which is D42's fix working. And all 41 report `outcome: "no-advance-control"` and
 * NOTHING ELSE about how the walk ended.
 *
 * `no-advance-control` is the value a FINISHED SURVEY and a WALK THAT NEVER GOT IN both
 * produce. That single ambiguity is what let four medical runs be reported as successes while
 * stuck on page 2. D42 closed it at the source: `browser/driver.ts#classifyEnding` types a
 * four-state `WalkEnding` on EVERY walk and `capture.ts` writes it into the artifact.
 *
 * IT NEVER GOT ANY FURTHER. Two hops threw it away:
 *
 *   1. `execute-batch.ts#walkRecord` reduces the `PathObservation` to a `WalkRecord` for
 *      `progress.json` — and listed the fields it kept. `ending` was not among them, nor were
 *      `readerLimitations`, `readerLimitationCount`, `bindingRefusalCount` or
 *      `unboundDecisions`.
 *   2. `project-observations.ts#observationsFromWalks` reduces the `WalkRecord` to the
 *      observation payload the SIGNED RECORD carries — and dropped even the fields the walk
 *      ledger did keep: `blockedSteps`, `constrainingDecisions`, `matchedConstraining`.
 *
 * So the record — the artifact a human actually audits, and the one thing that survives a run —
 * could not tell a completion from a screen-out, and the walk's own named limitations were
 * invisible in it.
 *
 * ==================== WHAT THIS SUITE REFUSES TO ACCEPT AS A FIX ====================
 *
 * "The field is present" is not the property. This repo has shipped ten artifacts in two days
 * that appeared to validate while being structurally unable to fail — `claims: []`,
 * `blockers: []`, `attempts: []`, each hardcoded empty beside deriving code nobody called. A
 * projection that stamped `ending: { kind: "completed" }` on every observation would satisfy a
 * presence test perfectly and be the cardinal failure of this product.
 *
 * So every carry here is checked three ways: PRESENT, CORRECT, and DIFFERENT for a walk that
 * ended a different way. `unclassified` gets its own tests at both hops, because it is the one
 * value whose collapse would be invisible: a terminal page that said nothing about which kind
 * of ending it was, quietly promoted to a completion, is a confident wrong answer with the
 * producer's name on it. And ABSENT is a fifth state — a ledger row that predates the field —
 * which must project as absent rather than as any value at all.
 *
 * ==================== AND IT IS READABLE, NOT EVIDENCE ====================
 *
 * The last suite is the counterweight, and it is the load-bearing half. Putting a
 * temptingly-named `ending` on the payload creates a NEW way to be confidently wrong: a future
 * consumer reading the producer's summary of itself instead of re-reading the bytes. The
 * verifier takes `observationEvidenceId` from the payload and nothing else, re-reads the
 * artifact and re-hashes it. So a payload whose ending CONTRADICTS its artifact must move no
 * verdict at all — in either direction.
 *
 * Evidence these can fail: `tools/mutate-projection-carry.mjs`.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { passingGates } from "../fixtures/v2-fixture.mjs";

const PATH_ID = "FLOOR-D43";
const ATTEMPT_ID = "att_d43test01";
const PLAN_REVISION_ID = "plan_d43test01";
const enc = new TextEncoder();

const Q7_WORDING = "In the past three months, have you seen a specialist about your migraine?";

// ---------------------------------------------------------------------------
// Screens, steps, and the walk artifact — the producing side's own shapes.
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

/** Controls that follow the convention, so binding never depends on what is being measured. */
const namedOptions = (q) => [
  control(0, { name: q, id: `${q}_1`, code: "1", label: "Yes" }),
  control(1, { name: q, id: `${q}_2`, code: "2", label: "No" }),
];

const screen = (text, controls = [], { signature = null } = {}) => ({
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
  optionGroups: [],
  grid: null,
  buttons: [],
  progress: { present: false, kind: null, now: null, max: null, text: null },
  validationMessages: [],
  counts: { controls: controls.length, optionGroups: 0, options: controls.length, textInputs: 0 },
  screenSignature: signature ?? `sig:${text}`,
});

const q7Screen = () => screen(Q7_WORDING, namedOptions("Q7"));
const endPage = (text) => screen(text, [], { signature: `sig:end:${text}` });

const stepBase = (index, before, extra) => ({
  stepIndex: index,
  decisionQuestion: "Q99",
  decisionSource: "plan",
  bindingVia: "markup:Q7",
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

const clickStep = (index, { before, after, code = "2", label = "No" }) =>
  stepBase(index, before, {
    requested: { select: [label], textEntry: null, action: null },
    screenAfterAdvance: after,
    actions: [{ kind: "click-option", targetIdx: 1, targetLabel: label, targetCode: code, value: null, ok: true, detail: null }],
    advanced: true,
  });

const deadEndStep = (index, before) => stepBase(index, before, { advanced: false, blockedReason: "no-advance-control" });

/**
 * A typed `WalkEnding` in the producing side's OWN shape (`browser/types.ts`) — `{ kind,
 * evidence }`, never a bare string. The evidence array is carried too, and tested: an ending
 * whose reasoning did not survive is an ending nobody can argue with.
 */
const ended = (kind) => ({ kind, evidence: [`the final screen was classified ${kind}`, "fixture evidence line 2"] });

/** The walk that runs Q7 -> a screen-out page and then finds nothing to press. */
const screenOutSteps = () => {
  const out = endPage("Thank you for your interest. Unfortunately you do not qualify for this study.");
  return [clickStep(0, { before: q7Screen(), after: out }), deadEndStep(1, out)];
};

/**
 * The artifact the walker writes. `outcome` is pinned to the run's OWN value —
 * `"no-advance-control"`, the one that covers both a finished survey and a walk that never got
 * in — on every fixture below, so nothing here can pass by reading it instead of the ending.
 */
const walkArtifact = (runId, extra = {}) => ({
  kind: "v2-path-observation/1.0.0",
  runId,
  pathId: PATH_ID,
  tier: 1,
  attemptId: ATTEMPT_ID,
  planRevisionId: PLAN_REVISION_ID,
  surveyUrl: "https://fixture.invalid/survey",
  startedAt: "2026-08-08T00:04:00.000Z",
  endedAt: "2026-08-08T00:05:00.000Z",
  wallMs: 60000,
  plannedWitnesses: ["req_d43route02"],
  steps: screenOutSteps(),
  outcome: "no-advance-control",
  outcomeDetail: null,
  shimmed: false,
  shimNote: null,
  loadFailure: null,
  evidenceIds: [],
  viewport: { width: 1280, height: 900 },
  ...extra,
});

const AUDIT = {
  exercised: true,
  plannedDecisions: 3,
  matchedDecisions: 2,
  constrainingDecisions: 2,
  matchedConstraining: 1,
};

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

const req = (id, facet, scope, quote) => ({
  requirementLineageId: id,
  requirementVersionId: id.replace("req_", "reqv_"),
  semanticFingerprint: `fp_${id}`,
  scope,
  quantifier: scope === "survey" ? "every" : "specific",
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

const facet = (id, { target, kind, routeAnswer = null, destination = null, lineage }) => ({
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

function contractBody() {
  return {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: "d".repeat(64),
    documentSha256: "d".repeat(64),
    sealedAt: "2026-08-08T00:00:00.000Z",
    requirements: [
      req("req_d43route02", "routing", "survey", 'When Q7 is answered "No", the respondent is screened out.'),
      req("req_d43render01", "rendered-state", "survey", "Every screen must display exactly one question."),
      req("req_d43q7", "question", "question:Q7", Q7_WORDING),
    ],
    facetInstances: [
      facet("fi_out_q7", {
        target: "Q7",
        kind: "route",
        routeAnswer: { code: "2", label: "No" },
        destination: { questionId: null, screen: null, terminal: "screenout" },
        lineage: "req_d43route02",
      }),
      facet("fi_render_q7", { target: "Q7", kind: "rendered-state", lineage: "req_d43render01" }),
    ],
    contractSupplements: [],
    extraction: {
      passAHash: "sha256:aaa",
      passBHash: "sha256:bbb",
      sourceLedgerHash: "sha256:ccc",
      diffHash: "sha256:ddd",
      reviewMode: "high-risk-only",
      reviewedBy: "d43-fixture",
      reviewedAt: "2026-08-08T00:00:00.000Z",
      gates: passingGates(),
    },
  };
}

// ---------------------------------------------------------------------------
// Driving the REAL projection
// ---------------------------------------------------------------------------

/**
 * `observationsFromWalks` IS the projection — `projectObservations` is that function with R2
 * around it (the storage round-trip is exercised end-to-end further down). Calling it directly
 * keeps each property below pinned to ONE walk ledger row, which is what the record is a
 * function of.
 */
const projectOne = async (mod, walk) => {
  const runId = "v2r_d43";
  const catalog = [
    {
      evidenceId: "EV-D43-ART",
      sourceEvidenceId: `EV-${PATH_ID}-observation`,
      attemptId: walk.attemptId,
      contentHash: "sha256:aa",
      artifactRef: `observations/${PATH_ID}/observation.json`,
    },
  ];
  const progress = { kind: "v2-execution-progress/1.0.0", runId, planRevisionId: PLAN_REVISION_ID, walks: [walk] };
  const { rows } = await mod.projectObservations.observationsFromWalks(runId, {}, progress, catalog);
  return rows;
};

/** One projected payload for a walk that ended `kind`, straight through the REAL `walkRecord`. */
const payloadForEnding = async (mod, kind, artifactExtra = {}) => {
  const obs = walkArtifact("v2r_d43", { ending: ended(kind), ...artifactExtra });
  const walk = mod.executeBatch.walkRecord(obs, ["fi_out_q7"], AUDIT);
  const rows = await projectOne(mod, walk);
  return rows[0].payload;
};

// ===========================================================================
suite("D43 — the ending the walker typed reaches the walk ledger", () => {});

test("THE FIRST HOP: `walkRecord` carried outcome and dropped the ending that disambiguates it", async () => {
  const mod = await worker();
  const row = mod.executeBatch.walkRecord(walkArtifact("v2r_d43", { ending: ended("screened-out") }), ["fi_out_q7"], AUDIT);

  // The value the live run published, still there and still ambiguous...
  assertEq(row.outcome, "no-advance-control");
  // ...and the field that says which of the two things it was.
  assertEq(row.ending.kind, "screened-out", JSON.stringify(row.ending));
  // The REASONING travels with it. An ending whose evidence did not survive is one nobody
  // reading the ledger can argue with, which is how a classifier's mistake becomes a fact.
  assertEq(row.ending.evidence.length, 2);
  assert(/classified screened-out/.test(row.ending.evidence[0]), JSON.stringify(row.ending.evidence));
});

test("walkRecord carries the driver's runtime-only exact observation evidence identity", async () => {
  const mod = await worker();
  const obs = walkArtifact("v2r_d43", { observationEvidenceId: "ev_exact_observation" });
  const row = mod.executeBatch.walkRecord(obs, ["fi_out_q7"], AUDIT);
  assertEq(row.observationEvidenceId, "ev_exact_observation");
  const explicit = mod.executeBatch.walkRecord(obs, ["fi_out_q7"], AUDIT, undefined, "ev_reverified");
  assertEq(explicit.observationEvidenceId, "ev_reverified");
});

test("A DIFFERENT ENDING IS A DIFFERENT VALUE — all four states survive the hop distinctly", async () => {
  const mod = await worker();
  const seen = new Map();
  for (const kind of ["completed", "screened-out", "stalled", "unclassified"]) {
    const row = mod.executeBatch.walkRecord(walkArtifact("v2r_d43", { ending: ended(kind) }), ["fi_out_q7"], AUDIT);
    seen.set(kind, row.ending.kind);
  }
  assertEq(
    JSON.stringify([...seen]),
    JSON.stringify([
      ["completed", "completed"],
      ["screened-out", "screened-out"],
      ["stalled", "stalled"],
      ["unclassified", "unclassified"],
    ]),
    "a carry that mapped, defaulted or collapsed any state would show up here as a repeat",
  );
  assertEq(new Set(seen.values()).size, 4, "four inputs, four outputs — nothing was folded into anything else");
});

test("`unclassified` IS NEVER COLLAPSED INTO `completed` on the producing side", async () => {
  const mod = await worker();
  const row = mod.executeBatch.walkRecord(walkArtifact("v2r_d43", { ending: ended("unclassified") }), ["fi_out_q7"], AUDIT);

  // The one collapse that would be invisible downstream: the walker looked at a terminal page
  // and nothing on it said which kind of ending it was. That is a COUNTED RESIDUAL, and the
  // verifier has its own arm for it. Promoting it here would arm that arm with a wrong answer.
  assertEq(row.ending.kind, "unclassified");
  assert(row.ending.kind !== "completed", "a terminal page that said nothing is not a completion");
});

test("ABSENCE IS PRESERVED AS ABSENCE: an artifact predating endings gets NO `ending` key", async () => {
  const mod = await worker();
  const obs = walkArtifact("v2r_d43");
  delete obs.ending;
  const row = mod.executeBatch.walkRecord(obs, ["fi_out_q7"], AUDIT);

  // Not `undefined`, not a default: the key must not be there at all, so a reader testing
  // `"ending" in walk` cannot mistake a walk that predates the field for one that has an ending.
  assertEq("ending" in row, false, `the key was written anyway: ${JSON.stringify(row.ending)}`);
  assertEq(JSON.parse(JSON.stringify(row)).ending, undefined);
});

test("THE READER'S OWN LIMITATIONS, ITS REFUSALS AND WHAT IT NEVER BOUND reach the ledger too", async () => {
  const mod = await worker();
  const limitations = [{ stepIndex: 2, kind: "grid-column-labels-unresolved", detail: "3 columns had no header", count: 3 }];
  const unbound = [{ question: "Q11", wanted: ["Yes"], reason: "no screen on this walk was identified as this question" }];
  const row = mod.executeBatch.walkRecord(
    walkArtifact("v2r_d43", {
      ending: ended("screened-out"),
      readerLimitations: limitations,
      readerLimitationCount: 3,
      bindingRefusalCount: 2,
      unboundDecisions: unbound,
    }),
    ["fi_out_q7"],
    AUDIT,
  );

  // "There are 4 footnotes I could not read" — never a quietly shorter list. The COUNT alone
  // would be the shorter list: it says how many without saying which, so nothing downstream
  // can name the limitation or act on it.
  assertEq(JSON.stringify(row.readerLimitations), JSON.stringify(limitations));
  assertEq(row.readerLimitationCount, 3);
  assertEq(row.bindingRefusalCount, 2);
  assertEq(JSON.stringify(row.unboundDecisions), JSON.stringify(unbound));
});

test("...and THEIR absence is absence, not zero — 'the walker did not say' is not 'the walker saw none'", async () => {
  const mod = await worker();
  const row = mod.executeBatch.walkRecord(walkArtifact("v2r_d43", { ending: ended("completed") }), ["fi_out_q7"], AUDIT);

  for (const key of ["readerLimitations", "readerLimitationCount", "bindingRefusalCount", "unboundDecisions"]) {
    assertEq(key in row, false, `${key} was defaulted onto a walk that never reported it`);
  }
});

// ===========================================================================
suite("D43 — ...and the ledger reaches the record's observation payload", () => {});

test("THE MEASURED DEFECT: 41 observations said `no-advance-control` and nothing else", async () => {
  const mod = await worker();
  const payload = await payloadForEnding(mod, "screened-out");

  assertEq(payload.outcome, "no-advance-control", "the ambiguous value the live run published");
  assertEq(payload.ending.kind, "screened-out", "and the field that resolves it, in the SIGNED payload");
  assertEq(payload.ending.evidence.length, 2, "with the walker's own reasoning attached");
});

test("A DIFFERENT ENDING IS A DIFFERENT PAYLOAD — and a different payload HASH", async () => {
  const mod = await worker();
  const runId = "v2r_d43";
  const rows = [];
  for (const kind of ["completed", "screened-out", "stalled", "unclassified"]) {
    const walk = mod.executeBatch.walkRecord(walkArtifact(runId, { ending: ended(kind) }), ["fi_out_q7"], AUDIT);
    rows.push((await projectOne(mod, walk))[0]);
  }

  assertEq(new Set(rows.map((r) => r.payload.ending.kind)).size, 4, "four walks, four endings");
  // THE HASH IS THE POINT OF THIS TEST. `attestation.payloadHash` is what the record is signed
  // over, so an `ending` that did not change it would be a field sitting BESIDE the attested
  // payload rather than inside it — present to a reader, absent from anything that verifies.
  assertEq(new Set(rows.map((r) => r.attestation.payloadHash)).size, 4, "the ending is inside the hashed payload");
});

test("`unclassified` IS NOT COLLAPSED AT THIS HOP EITHER", async () => {
  const mod = await worker();
  const payload = await payloadForEnding(mod, "unclassified");

  assertEq(payload.ending.kind, "unclassified");
  // Stated as its own assertion because this is the one a "presence" test would miss: a
  // projection stamping `{ kind: "completed" }` on everything passes every other check here.
  assert(payload.ending.kind !== "completed", "the fourth state is a residual, and residuals are not passes");
});

test("A LEDGER ROW THAT PREDATES ENDINGS PROJECTS A PAYLOAD WITHOUT ONE", async () => {
  const mod = await worker();
  const obs = walkArtifact("v2r_d43");
  delete obs.ending;
  const walk = mod.executeBatch.walkRecord(obs, ["fi_out_q7"], AUDIT);
  const payload = (await projectOne(mod, walk))[0].payload;

  assertEq("ending" in payload, false, `defaulted to: ${JSON.stringify(payload.ending)}`);
});

test("THE COUNTS THE PAYLOAD ALSO DROPPED — the gate's denominator, the refusals, the limitations", async () => {
  const mod = await worker();
  const limitations = [{ stepIndex: 1, kind: "option-labels-truncated", detail: "2 labels cut", count: 2 }];
  const unbound = [{ question: "Q11", wanted: ["Yes"], reason: "never bound" }];
  const walk = mod.executeBatch.walkRecord(
    walkArtifact("v2r_d43", {
      ending: ended("completed"),
      readerLimitations: limitations,
      readerLimitationCount: 2,
      bindingRefusalCount: 1,
      unboundDecisions: unbound,
      steps: [...screenOutSteps(), { ...deadEndStep(2, q7Screen()), blockedReason: "validation-visible" }],
    }),
    ["fi_out_q7"],
    AUDIT,
  );
  const payload = (await projectOne(mod, walk))[0].payload;

  // The exercised gate's own arithmetic. `exercised: true` alone is a boolean with no working
  // shown; these two are why run v2r_01kzfb6py8pbxznqv022p2qkhb could be re-adjudicated at all.
  assertEq(payload.constrainingDecisions, 2);
  assertEq(payload.matchedConstraining, 1);
  // Positive evidence the site refused, counted at the moment it was observed.
  assertEq(payload.blockedSteps, 1);
  assertEq(payload.bindingRefusalCount, 1);
  assertEq(payload.readerLimitationCount, 2);
  assertEq(JSON.stringify(payload.readerLimitations), JSON.stringify(limitations));
  assertEq(JSON.stringify(payload.unboundDecisions), JSON.stringify(unbound));
});

test("...and none of THOSE is defaulted either when the walk never reported them", async () => {
  const mod = await worker();
  // An old `progress.json` row: `loadProgress` re-reads it with a cast, so fields the type
  // calls required can genuinely be missing at runtime. Absent must project absent.
  const stale = {
    pathId: PATH_ID,
    tier: 1,
    attemptId: ATTEMPT_ID,
    outcome: "no-advance-control",
    outcomeDetail: null,
    steps: 2,
    wallMs: 60000,
    shimmed: false,
    loadCrash: false,
    evidenceCount: 1,
    caseIds: ["fi_out_q7"],
    exercised: true,
    plannedDecisions: 1,
    matchedDecisions: 1,
    screensAdvanced: 1,
    at: "2026-08-08T00:05:00.000Z",
  };
  const payload = (await projectOne(mod, stale))[0].payload;

  for (const key of [
    "ending",
    "constrainingDecisions",
    "matchedConstraining",
    "blockedSteps",
    "unboundDecisions",
    "bindingRefusalCount",
    "readerLimitations",
    "readerLimitationCount",
  ]) {
    assertEq(key in payload, false, `${key} was invented for a ledger row that never carried it`);
  }
  // ...while everything the old row DID carry still projects, so this is a degradation and not
  // a failure to read the row at all.
  assertEq(payload.outcome, "no-advance-control");
  assertEq(payload.exercised, true);
});

test("END TO END THROUGH R2: the stored `observations.json` carries the ending", async () => {
  const mod = await worker();
  const env = testEnv();
  const { runId } = await seedExecutedRun(mod, env, { ending: ended("screened-out") });

  const projected = await mod.projectObservations.projectObservations(env, runId);
  assertEq(projected.state, "evaluated", JSON.stringify(projected));

  // Read back through the SAME key and the SAME reader every judging stage uses. The two hops
  // are functions; this is the round-trip through storage that a live run actually performs.
  const inputs = await mod.runInputs.loadRunInputs(env, runId);
  const row = inputs.observations.find((o) => o.facetInstanceId === "fi_out_q7");
  assertEq(row.payload.outcome, "no-advance-control");
  assertEq(row.payload.ending.kind, "screened-out", JSON.stringify(row.payload));
});

// ===========================================================================
// THE THIRD HOP, added by the completion-path audit (docs/COMPLETION-PATH-AUDIT.md G1/G2).
//
// The two hops above carry the ending as far as the record's OBSERVATION payloads. The record
// also carries an ATTEMPT LEDGER — `record.attempts`, the rows the report renders "how many
// walks ran and how did they go" from — and that projection dropped the ending entirely and
// judged its `ok` flag off `outcome === "completed"`.
//
// `browser/types.ts` says what is wrong with that in its own words: `outcome: "completed"`
// means "the step loop exited under budget", and A REAL THANK-YOU PAGE LANDS ON
// `"no-advance-control"`. So the flag was INVERTED for the one case the deliverable is about:
// the walk that ran out of SURVEY was recorded `ok: false`, and walks that ran out of PLAN
// mid-survey were recorded `ok: true`.
// ===========================================================================
suite("D43 — ...and the record's ATTEMPT ledger carries it, and judges `ok` BY it", () => {});

/** A ledger row as `walkRecord` writes it, with only the fields `deriveAttempts` reads. */
const ledgerRow = (extra = {}) => ({
  pathId: PATH_ID,
  attemptId: ATTEMPT_ID,
  outcome: "no-advance-control",
  loadCrash: false,
  caseIds: ["fi_out_q7"],
  wallMs: 60000,
  at: "2026-08-08T00:05:00.000Z",
  ...extra,
});

const attemptFor = async (mod, row) => mod.assembleRecordProjection.deriveAttempts({ walks: [row], evidence: [] })[0];

test("THE THIRD HOP: the attempt row carries the ending, evidence and all", async () => {
  const mod = await worker();
  const attempt = await attemptFor(mod, ledgerRow({ ending: ended("completed") }));

  // The ambiguous value the ledger recorded, still there...
  assertEq(attempt.stopReason, "no-advance-control");
  // ...and, for the first time, the field in the SIGNED record that says which ending it was.
  assertEq(attempt.ending.kind, "completed", JSON.stringify(attempt.ending));
  assertEq(attempt.ending.evidence.length, 2, "an ending whose reasoning did not survive is one nobody can argue with");
  assert(/classified completed/.test(attempt.ending.evidence[0]), JSON.stringify(attempt.ending.evidence));
});

test("THE INVERTED FLAG: the walk that finished the survey is `ok`, and `outcome` alone never decides it", async () => {
  const mod = await worker();

  // THE MEASURED SHAPE OF A REAL COMPLETION: the step loop did not "complete" — it ran out of
  // survey, which the walker records as `no-advance-control` and types as `completed`. Under
  // the old `ok: w.outcome === "completed"` this row was the one that read `ok: false`.
  const finished = await attemptFor(mod, ledgerRow({ outcome: "no-advance-control", ending: ended("completed") }));
  assertEq(finished.ok, true, `the walk that reached the thank-you page must be ok: ${JSON.stringify(finished)}`);

  // ...and the exact inverse, which the old line called ok: the step loop exited under budget
  // with the survey still going. That is a walk that ran out of PLAN, not out of survey.
  const ranOutOfPlan = await attemptFor(mod, ledgerRow({ outcome: "completed", ending: ended("stalled") }));
  assertEq(ranOutOfPlan.ok, false, `a walk that stopped mid-survey is not ok: ${JSON.stringify(ranOutOfPlan)}`);

  // A screen-out is an ending REACHED. The survey answered us; we were turned away, not stopped.
  const turnedAway = await attemptFor(mod, ledgerRow({ ending: ended("screened-out") }));
  assertEq(turnedAway.ok, true);
});

test("`unclassified` IS NOT AN ENDING REACHED — the counted residual never becomes a success", async () => {
  const mod = await worker();
  const unnamed = await attemptFor(mod, ledgerRow({ ending: ended("unclassified") }));

  // The collapse that would be invisible: a terminal page that said nothing about which kind of
  // ending it was, recorded in the signed document as a walk that went fine. `unclassified` is
  // the walker's "I could not tell", and reading it as ok republishes the guess it refused.
  assertEq(unnamed.ok, false, JSON.stringify(unnamed));
  assertEq(unnamed.ending.kind, "unclassified", "and it is still carried, so a reader can see WHY it is not ok");
});

test("A LOAD CRASH IS NOT OK however it finished — the older guarantee is not traded away", async () => {
  const mod = await worker();
  const crashed = await attemptFor(mod, ledgerRow({ loadCrash: true, ending: ended("completed") }));
  assertEq(crashed.ok, false, "a walk whose page never loaded cannot have finished the survey");
});

test("ABSENCE IS PRESERVED AS ABSENCE at the third hop, and `ok` degrades to the honest older reading", async () => {
  const mod = await worker();

  const legacy = ledgerRow({ outcome: "no-advance-control" });
  const attempt = await attemptFor(mod, legacy);
  // Not `undefined`, not a default: `"ending" in attempt` must still separate "this walk said
  // nothing about its ending" from "nobody looked".
  assertEq("ending" in attempt, false, `the key was written anyway: ${JSON.stringify(attempt.ending)}`);
  assertEq(JSON.parse(JSON.stringify(attempt)).ending, undefined);

  // The fallback reads the two TERMINAL outcomes — it says "this walk ran out of survey"
  // without claiming which kind of ending it was, and never invents one.
  assertEq(attempt.ok, true, "a pre-ending row that ran out of survey is still ok");
  assertEq((await attemptFor(mod, ledgerRow({ outcome: "completed" }))).ok, true);
  for (const outcome of ["step-cap", "time-cap", "blocked", "load-crash", "per-case-timeout"]) {
    assertEq((await attemptFor(mod, ledgerRow({ outcome }))).ok, false, outcome);
  }
});

test("A DIFFERENT ENDING IS A DIFFERENT VALUE — all four states survive the third hop distinctly", async () => {
  const mod = await worker();
  const seen = [];
  for (const kind of ["completed", "screened-out", "stalled", "unclassified"]) {
    const attempt = await attemptFor(mod, ledgerRow({ ending: ended(kind) }));
    seen.push([kind, attempt.ending.kind, attempt.ok]);
  }
  assertEq(
    JSON.stringify(seen),
    JSON.stringify([
      ["completed", "completed", true],
      ["screened-out", "screened-out", true],
      ["stalled", "stalled", false],
      ["unclassified", "unclassified", false],
    ]),
    "a carry that mapped, defaulted or collapsed any state would show up here as a repeat",
  );
});

test("END TO END THROUGH R2: the signed record's attempt row carries the ending", async () => {
  const mod = await worker();
  const env = testEnv();
  const { runId } = await seedExecutedRun(mod, env, { ending: ended("screened-out") });

  const projected = await mod.projectObservations.projectObservations(env, runId);
  assertEq(projected.state, "evaluated", JSON.stringify(projected));
  const derived = await mod.deriveVerdicts.deriveItemResults(env, runId);
  assertEq(derived.state, "evaluated", JSON.stringify(derived));
  const assembled = await mod.assembleRecord.assembleRecord(env, runId, derived.value.itemResults);
  assertEq(assembled.state, "evaluated", `${assembled.reason ?? ""} ${assembled.detail ?? ""}`);

  // Read back out of storage, not off a return value — the signed document is the deliverable.
  const record = await (await env.EVIDENCE.get(mod.keys.recordKey(runId))).json();
  const row = record.attempts.find((a) => a.pathId === PATH_ID);
  assert(row, `no attempt row for ${PATH_ID}: ${JSON.stringify(record.attempts)}`);
  assertEq(row.ending.kind, "screened-out", JSON.stringify(row));
  assertEq(row.ok, true, "reaching a screen-out page is reaching an ending");
  assertEq(row.derivedBy, "v2-attempt-projection/1.2.0", "the projection version says which reading of `ok` produced it");
});

// ===========================================================================
suite("D43 — the payload is READABLE, and still not EVIDENCE", () => {});

test("A PAYLOAD WHOSE ENDING CONTRADICTS ITS ARTIFACT MOVES NO VERDICT", async () => {
  const mod = await worker();

  // The document says answering "No" screens the respondent out, and the walk's ARTIFACT says
  // it ended screened-out. The PAYLOAD says `completed` — the value that, if it were read,
  // turns this into ROUTE_TERMINAL_MISMATCH: a published defect claim against a survey that did
  // exactly what the document says. This is the new failure mode the carry creates, and the
  // only thing standing between it and a customer is that the verifier re-reads the bytes.
  const lied = await verifyWithPayloadEnding(mod, { artifact: ended("screened-out"), payload: ended("completed") });
  assertEq(lied.decision, "verified", JSON.stringify(lied));
  assertEq(lied.reason, "ROUTE_TERMINAL_AS_DOCUMENTED");

  // And the other direction, because a payload that could only ever be ignored INTO a pass is
  // half a guarantee: an artifact that stalled stays undecided however confident the payload is.
  const flattered = await verifyWithPayloadEnding(mod, { artifact: ended("stalled"), payload: ended("screened-out") });
  assertEq(flattered.decision, "insufficient", JSON.stringify(flattered));
  assertEq(flattered.reason, "WALK_DID_NOT_REACH_AN_ENDING");
});

test("AND A PAYLOAD ENDING CANNOT RESCUE AN ARTIFACT THAT HAS NONE", async () => {
  const mod = await worker();

  // The migraine run's own shape, one field short: the artifact predates typed endings and the
  // payload carries a confident one. "Not decidable" is the correct, and the only honest,
  // answer — an older artifact does not become decidable by assuming an ending for it.
  const decided = await verifyWithPayloadEnding(mod, { artifact: null, payload: ended("screened-out") });
  assertEq(decided.decision, "insufficient", JSON.stringify(decided));
  assertEq(decided.reason, "TERMINAL_DESTINATION_NOT_DISCRIMINABLE");
});

// ---------------------------------------------------------------------------
// Seeding: the durable state a real run leaves behind
// ---------------------------------------------------------------------------

async function seedExecutedRun(mod, env, { ending = ended("screened-out"), payloadOverride = null } = {}) {
  const runId = mod.ids.mintRunId();
  const { contractRevisionId, contractHash, revision } = await mod.contractRevision.sealContract(env, contractBody());
  const sealedCaseIds = revision.facetInstances.map((fi) => fi.facetInstanceId);

  const obs = walkArtifact(runId, ending === null ? {} : { ending });
  const entry = await mod.evidence.putEvidence(env, {
    runId,
    bytes: enc.encode(JSON.stringify(obs)),
    mediaType: "application/json",
    type: "state",
    attemptId: ATTEMPT_ID,
    routeId: PATH_ID,
    witnesses: ["req_d43route02"],
    sourceEvidenceId: `EV-${PATH_ID}-observation`,
    artifactRef: `observations/${PATH_ID}/observation.json`,
  });

  await env.EVIDENCE.put(
    mod.keys.planKey(runId, PLAN_REVISION_ID),
    JSON.stringify({
      kind: "v2-execution-program/2.0.0",
      runId,
      planRevisionId: PLAN_REVISION_ID,
      contractRevisionId,
      contractHash,
      generatedAt: "2026-08-08T00:01:00.000Z",
      surveyUrl: "https://fixture.invalid/survey",
      floor: [{ pathId: PATH_ID, tier: 1, caseIds: ["fi_out_q7"], witnesses: ["req_d43route02"] }],
      exploration: [],
      caseOrder: sealedCaseIds,
      unassignedCaseIds: sealedCaseIds.filter((id) => id !== "fi_out_q7"),
      coverage: {
        obligations: 1,
        witnessedByFloor: 1,
        coversAllObligations: true,
        coversAllAfterMandatoryExploration: true,
        uncovered: [],
      },
      warnings: [],
      plan: { floor: { paths: [{ id: PATH_ID }] }, exploration: { queue: [] } },
    }),
    { httpMetadata: { contentType: "application/json" } },
  );

  // THE LEDGER IS WRITTEN BY THE REAL `walkRecord`, not by hand: seeding a row here would test
  // this fixture's idea of the first hop instead of the first hop.
  await env.EVIDENCE.put(
    mod.keys.k("runs", runId, "execution", "progress.json"),
    JSON.stringify({
      kind: "v2-execution-progress/1.0.0",
      runId,
      planRevisionId: PLAN_REVISION_ID,
      walks: [mod.executeBatch.walkRecord(obs, ["fi_out_q7"], AUDIT)],
      floorDone: [PATH_ID],
      explorationDone: [],
      shimRequired: false,
      hungPaths: [],
      shimEvidence: null,
      totalSteps: 2,
      // walkRecord derives evidenceCount from the observation's evidenceIds. This fixture's
      // separately catalogued observation artifact is its container, not an entry in that list.
      totalEvidence: 0,
    }),
    { httpMetadata: { contentType: "application/json" } },
  );

  if (payloadOverride) {
    await env.EVIDENCE.put(
      mod.keys.observationsKey(runId),
      JSON.stringify({
        observations: [
          {
            observationId: "obs_d43000000000000001",
            facetInstanceId: "fi_out_q7",
            attemptId: ATTEMPT_ID,
            routeId: PATH_ID,
            observedAt: "2026-08-08T00:05:00.000Z",
            payloadKind: "v2-walk-projection/1.0.0",
            payload: {
              pathId: PATH_ID,
              attemptId: ATTEMPT_ID,
              observationEvidenceId: entry.evidenceId,
              outcome: "no-advance-control",
              outcomeDetail: null,
              ending: payloadOverride,
              screensAdvanced: 1,
              steps: 2,
              exercised: true,
              observedAt: "2026-08-08T00:05:00.000Z",
            },
            completeness: "complete-scoped-inventory",
            evidenceIds: [entry.evidenceId],
            verifier: { decision: "insufficient", evidenceIds: [entry.evidenceId], verifierVersion: "none/not-yet-verified" },
            attestation: { producedBy: "v2-executor", producerVersion: "v2-observation-projection/1.0.0", payloadHash: "sha256:d43" },
          },
        ],
      }),
      { httpMetadata: { contentType: "application/json" } },
    );
  }

  await mod.checkpoint.createCheckpoint(env, mod.checkpoint.initialCheckpoint(env, runId, "standard", false));
  await mod.checkpoint.updateCheckpoint(env, runId, (d) => {
    d.contract = {
      state: "sealed",
      contractRevisionId,
      contractHash,
      total: sealedCaseIds.length,
      requirements: { total: 3, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
    };
    d.counts = { ...d.counts, exercised: 1, pending: sealedCaseIds.length - 1 };
    d.execution = {
      batchIndex: 1,
      sessionId: null,
      sessionOpenedAt: null,
      pendingCaseIds: [],
      completedCaseIds: ["fi_out_q7"],
      planRevisionId: PLAN_REVISION_ID,
    };
  });

  return { runId, contractRevisionId, contractHash };
}

/**
 * Run the REAL verify stage over an observation whose payload ending and whose artifact ending
 * are set INDEPENDENTLY, and report what it decided.
 */
async function verifyWithPayloadEnding(mod, { artifact, payload }) {
  const env = testEnv();
  const { runId } = await seedExecutedRun(mod, env, { ending: artifact, payloadOverride: payload });
  await mod.verifyObservations.verifyObservations(env, runId);
  const ledger = JSON.parse(await (await env.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;
  return ledger.find((o) => o.facetInstanceId === "fi_out_q7").verifier;
}

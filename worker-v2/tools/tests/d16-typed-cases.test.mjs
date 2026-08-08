/**
 * D16 — THE EXPANDER MATERIALIZES TYPED CASES, OR SAYS WHY IT CANNOT.
 *
 * THE DEFECT. `verify-observations.ts` promotes to `verified` through one route: a closed
 * predicate keyed on `FacetCase.kind` reading `routeAnswer` + `expectedDestination` or
 * `boundaryInput` out of the SEALED revision. The expander that materializes those payloads
 * was writing three different things into them and calling all three a case:
 *
 *   1. a destination bound to a question the document names        — decidable;
 *   2. whatever string the model wrote, verbatim, in `questionId`  — NOT decidable, and
 *      indistinguishable from (1) at the seal. `"CONTINUE"` is the reference example: a
 *      screen with a Continue button token-matches it, so the predicate returned
 *      `satisfied` and the run gained a pass NOTHING had checked;
 *   3. a min/max SELECTION count written into `boundaryInput.value`, which is documented
 *      as "the literal input to type". On any numeric field, "type 1" is accepted (a false
 *      pass) and "type 2" is accepted (a fabricated defect — "the document requires this to
 *      be rejected").
 *
 * On the reference document (226 requirements, 220 cases) 66 cases presented as typed and
 * 16 were decidable. The other 50 were the two fabrication classes above.
 *
 * THE NEGATIVE HALF IS THE LOAD-BEARING HALF, and it is not "does the count go up". Every
 * test below whose name starts NEGATIVE asserts that something the expander COULD have
 * emitted, it refuses to: an unbound destination does not become an expectation, a
 * selection count does not become a value to type, and a kind with no registered predicate
 * cannot be typed by any payload. `tools/mutate-expander.mjs` is the proof they can fail.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { passingGates } from "../fixtures/v2-fixture.mjs";

const PATH_ID = "FLOOR-01";
const ATTEMPT_ID = "att_d16test01";
const PLAN_REVISION_ID = "plan_d16test01";
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// MergedRow fixtures — the shape `merge.ts` hands the expander
// ---------------------------------------------------------------------------

const requirement = (id, { scope, facet, statement, testability = "browser-observable" }) => ({
  requirementLineageId: id,
  requirementVersionId: `${id}@1`,
  semanticFingerprint: `fp_${id}`,
  scope,
  quantifier: "specific",
  selector: null,
  exceptions: [],
  facet,
  assertionStatus: "entailed",
  testability,
  notBrowserObservableReason: null,
  sourceAtoms: [{ blockId: "b0001", kind: "paragraph", coords: null, role: "normative", atomTextHash: "sha256:aa" }],
  composition: null,
  normativeStatement: statement,
  displayQuote: statement,
  retiredAt: null,
});

const expansion = (over = {}) => ({
  kind: "route",
  routeAnswers: [],
  maxLength: null,
  minSelections: null,
  maxSelections: null,
  ...over,
});

/** One MergedRow. `exp` is the typed expansion hint, or null when the document stated none. */
const row = (id, req, exp = null) => ({
  requirement: requirement(id, req),
  foundBy: ["B"],
  raw: [
    {
      id,
      construct: req.facet,
      scope: req.scope,
      quantifier: "specific",
      selector: null,
      exceptions: [],
      statement: req.statement,
      docQuote: req.statement,
      blockIds: ["b0001"],
      browserObservable: "full",
      confidence: 0.9,
      expansion: exp,
      pass: "B",
      origin: "chunk-1",
    },
  ],
  conflict: null,
});

/**
 * THE REFERENCE ROW SET, modelled on what the reference document actually produced.
 *
 * `q9`/`q12` exist to put those ids into the DOCUMENT'S OWN question vocabulary — the only
 * thing a destination is ever bound against. Nothing here assumes ids look like /Q\d+/;
 * `screener-A` is in the set precisely so a test can show a two-character id in a different
 * shape binds identically.
 */
function referenceRows() {
  return [
    row("req_route", { scope: "question:Q7", facet: "skip-rule", statement: "Route Q7 by answer." }, expansion({
      routeAnswers: [
        // (1) DECIDABLE: the destination is a question this document names.
        { code: "3", label: "Can't remember", destination: "Q9" },
        // (2) RELATIVE: names a target only through document order. Never bound.
        { code: "9", label: "Prefer not to say", destination: "CONTINUE" },
        // (3) COMPOUND: names two questions. Picking one is picking, not reading.
        { code: "1", label: "Yes", destination: "Q9 then Q12" },
        // (4) PHRASED: names exactly one question this document knows.
        { code: "2", label: "No", destination: "go to Q12" },
        // (5) STATED BY NOBODY: the answer is enumerated, the destination is not.
        { code: "4", label: "Not sure", destination: null },
        // (6) TERMINAL: typed for the report, undecidable by any model-free predicate.
        { code: "5", label: "Never", destination: "SCREEN-OUT" },
      ],
    })),
    row("req_q9", { scope: "question:Q9", facet: "question", statement: "Q9 asks which brands." }),
    row("req_q12", { scope: "question:Q12", facet: "question", statement: "Q12 asks about price." }),
    row("req_sa", { scope: "question:screener-A", facet: "question", statement: "screener-A asks age." }),
    // A SELECTION bound: exactly one answer. Three cases, none of them a value to type.
    row("req_sel", { scope: "question:Q9", facet: "validation", statement: "Q9 requires exactly one answer." }, expansion({
      kind: "boundary",
      minSelections: 1,
      maxSelections: 1,
    })),
    // A LENGTH bound: two cases, one of which the document entails.
    row("req_len", { scope: "question:Q12", facet: "validation", statement: "Q12 allows at most 5 characters." }, expansion({
      kind: "boundary",
      maxLength: 5,
    })),
    // A routing rule with no enumerated answer set — the exclusion class.
    row("req_excl", { scope: "question:Q12", facet: "skip-rule", statement: "Everyone except code 6 continues." }),
    // A kind no model-free predicate is registered for.
    row("req_copy", { scope: "survey", facet: "copy", statement: "The client name must not appear." }),
  ];
}

const expandRef = async (mod, rows = referenceRows()) =>
  mod.expand.expandFloor(rows, { locale: "en", viewport: "desktop" });

const answer = (out, code) => out.facetInstances.find((f) => f.case.routeAnswer?.code === code);
const gapsOf = (out) => out.facetInstances.filter((f) => f.expectationGap).map((f) => f.expectationGap.code);

// ===========================================================================
suite("D16 — the expander materializes typed cases", () => {
  test("a route answer whose destination the document NAMES expands to a decidable case", async () => {
    const mod = await worker();
    const out = await expandRef(mod);

    const direct = answer(out, "3");
    assertEq(direct.case.kind, "route");
    assertEq(direct.case.routeAnswer.label, "Can't remember");
    assertEq(direct.case.expectedDestination.questionId, "Q9");
    assertEq(direct.case.expectedDestination.terminal, null);
    assertEq(direct.expectationGap, null, "a bound destination is an expectation a predicate can decide");

    // AND A PHRASE THAT NAMES ONE. "go to Q12" is bound by the same whole-token rule the
    // verifier matches screens with, so "bound here" implies "matchable there".
    const phrased = answer(out, "2");
    assertEq(phrased.case.expectedDestination.questionId, "Q12");
    assertEq(phrased.expectationGap, null);
  });

  test("a length bound entails rejection ABOVE it, and acceptance of nothing", async () => {
    const mod = await worker();
    const out = await expandRef(mod);
    const bounds = out.facetInstances.filter((f) => f.requirementLineageId === "req_len");
    assertEq(bounds.length, 2, "the document enumerates exactly two cases for a stated bound");

    const over = bounds.find((f) => f.case.boundaryInput.bound === "above-max");
    assertEq(over.case.boundaryInput.value, "xxxxxx", "one character past the stated maximum");
    assertEq(over.case.boundaryInput.expectedOutcome, "rejected");
    assertEq(over.expectationGap, null, "a stated maximum entails that longer is not permitted");

    // NEGATIVE HALF OF THE SAME REQUIREMENT: the at-maximum case stays in the denominator
    // and carries NO expectation, because "a maximum of 5 characters" never said that
    // "xxxxx" is an acceptable ANSWER. A field that refuses the filler for its content
    // would otherwise be reported as violating a rule it obeys.
    const at = bounds.find((f) => f.case.boundaryInput.bound === "max");
    assertEq(at.case.boundaryInput.expectedOutcome, "unspecified");
    assertEq(at.expectationGap.code, "INPUT_CONTENT_NOT_STATED");
  });

  test("coverage states the CEILING: every case counted, every gap named", async () => {
    const mod = await worker();
    const out = await expandRef(mod);
    const c = out.coverage;

    assertEq(c.cases, out.facetInstances.length);
    assertEq(c.typedCases, 3, `expected exactly three decidable cases, got ${JSON.stringify(c.byKind)}`);
    assertEq(c.untypedCases, c.cases - c.typedCases);
    assertEq(
      Object.values(c.byGap).reduce((n, v) => n + v, 0),
      c.untypedCases,
      "every untyped case names exactly one reason",
    );
    // The gap histogram is asserted BY CODE, not by total: a total is satisfied by any
    // partition of it, so a mis-bucketed case would not move it.
    assertEq(c.byGap.ROUTE_DESTINATION_NOT_BOUND, 2, "CONTINUE and the compound destination");
    assertEq(c.byGap.ROUTE_DESTINATION_NOT_STATED, 1);
    assertEq(c.byGap.ROUTE_DESTINATION_TERMINAL, 1);
    assertEq(c.byGap.SELECTION_BOUND_IS_NOT_A_TEXT_INPUT, 3);
    assertEq(c.byGap.INPUT_CONTENT_NOT_STATED, 1);
    assertEq(c.byGap.ROUTE_ANSWERS_NOT_ENUMERATED, 1, "the exclusion-stated routing rule");
    assertEq(c.byGap.NO_TYPED_PREDICATE_FOR_KIND, 4, "three rendered-state questions and one copy rule");
    assertEq(c.byKind.route.typed, 2);
    assertEq(c.byKind.boundary.typed, 1);
  });

  test("the preview attributes the ceiling to the REQUIREMENT that caused it", async () => {
    const mod = await worker();
    const out = await expandRef(mod);
    const route = out.preview.find((p) => p.requirementLineageId === "req_route");
    assertEq(route.caseCount, 6);
    assertEq(route.typedCaseCount, 2);
    assertEq(route.gaps.ROUTE_DESTINATION_NOT_BOUND, 2);
    assert(/2 destination\(s\) bound/.test(route.basis), `basis must state how many bound: ${route.basis}`);
    assertEq(out.unpreviewed.length, 0, "a requirement absent from the preview blocks its own gate");
  });
});

// ===========================================================================
suite("D16 — a case that cannot be checked SAYS SO, and is never fabricated", () => {
  test("NEGATIVE: a relative destination does not become an expectation", async () => {
    const mod = await worker();
    const out = await expandRef(mod);
    const relative = answer(out, "9");

    assertEq(relative.case.expectedDestination, null, "CONTINUE names no question, so no destination is minted");
    assertEq(relative.expectationGap.code, "ROUTE_DESTINATION_NOT_BOUND");
    assert(
      relative.expectationGap.detail.includes("CONTINUE"),
      "the gap must quote what it could not bind, or the extraction signal is unactionable",
    );
    // AND THE CASE IS STILL IN THE DENOMINATOR. Dropping it would make the denominator a
    // function of how well extraction did, which is the D10 violation.
    assert(relative.floorCase === true);
  });

  test("NEGATIVE: a compound destination binds to NEITHER of the questions it names", async () => {
    const mod = await worker();
    const out = await expandRef(mod);
    const compound = answer(out, "1");

    assertEq(compound.case.expectedDestination, null);
    assertEq(compound.expectationGap.code, "ROUTE_DESTINATION_NOT_BOUND");
    assert(
      /Q9/.test(compound.expectationGap.detail) && /Q12/.test(compound.expectationGap.detail),
      "the gap names both candidates, so a reader can see WHY choosing was refused",
    );
  });

  test("NEGATIVE: a selection count never becomes a value to type", async () => {
    const mod = await worker();
    const out = await expandRef(mod);
    const sel = out.facetInstances.filter((f) => f.requirementLineageId === "req_sel");

    assertEq(sel.length, 3, "min + max + above-max: the document enumerates three, and it still does");
    for (const f of sel) {
      assertEq(f.case.boundaryInput.value, null, `a selection count is not an input: ${JSON.stringify(f.case)}`);
      assertEq(f.case.boundaryInput.expectedOutcome, "unspecified");
      assertEq(f.expectationGap.code, "SELECTION_BOUND_IS_NOT_A_TEXT_INPUT");
    }
    // THE SPECIFIC FABRICATION: "exactly one answer" must not produce "type 2 and expect a
    // rejection", which on a numeric field manufactures a defect out of a correct survey.
    assert(
      !sel.some((f) => f.case.boundaryInput.value === "2"),
      "the above-max case must not carry the selection count as text",
    );
    // Identity survives the refusal: three cases, three distinct ledger rows.
    assertEq(new Set(sel.map((f) => f.caseVersionId)).size, 3, "the three cases stay distinguishable in the ledger");
  });

  test("NEGATIVE: a requirement too loose to type yields a REPORTED gap, not a case with an expectation", async () => {
    const mod = await worker();
    const out = await expandRef(mod);

    const excl = out.facetInstances.filter((f) => f.requirementLineageId === "req_excl");
    assertEq(excl.length, 1);
    assertEq(excl[0].case.kind, "route", "the kind still says what the requirement IS");
    assertEq(excl[0].case.routeAnswer, null, "no answer set was stated, and none is invented");
    assertEq(excl[0].expectationGap.code, "ROUTE_ANSWERS_NOT_ENUMERATED");

    const missing = answer(out, "4");
    assertEq(missing.case.expectedDestination, null);
    assertEq(missing.expectationGap.code, "ROUTE_DESTINATION_NOT_STATED");
  });

  test("NEGATIVE: a kind with no registered predicate can never be typed, whatever it carries", async () => {
    const mod = await worker();
    const out = await expandRef(mod);
    for (const f of out.facetInstances) {
      if (f.case.kind === "route" || f.case.kind === "boundary") continue;
      assert(
        f.expectationGap !== null,
        `${f.case.kind} has no predicate in PREDICATE_FOR_KIND, so it must never report as typed`,
      );
      assertEq(f.expectationGap.code, "NO_TYPED_PREDICATE_FOR_KIND");
    }
  });

  test("NEGATIVE: a terminal destination is typed for the report and decidable by nobody", async () => {
    const mod = await worker();
    const out = await expandRef(mod);
    const terminal = answer(out, "5");
    assertEq(terminal.case.expectedDestination.terminal, "screenout");
    assertEq(terminal.case.expectedDestination.questionId, null);
    assertEq(terminal.expectationGap.code, "ROUTE_DESTINATION_TERMINAL");
  });

  test("NEGATIVE: binding uses the DOCUMENT'S vocabulary, and a one-character id cannot be caught by a phrase", async () => {
    const mod = await worker();
    // Ids nobody here has seen: no /Q\d+/ anywhere. Binding must work identically.
    const rows = [
      row("r_a", { scope: "question:ItemA", facet: "question", statement: "ItemA." }),
      row("r_one", { scope: "question:A", facet: "question", statement: "A." }),
      row("r_route", { scope: "section:S", facet: "routing", statement: "Route." }, expansion({
        routeAnswers: [
          { code: "1", label: null, destination: "ItemA" },
          { code: "2", label: null, destination: "then go to ItemA" },
          // A one-character id must not be pulled out of unrelated prose.
          { code: "3", label: null, destination: "proceed to a later section" },
          // ...but naming it exactly still binds, because that phrase names it and nothing else.
          { code: "4", label: null, destination: "A" },
        ],
      })),
    ];
    const out = await mod.expand.expandFloor(rows, { locale: "en", viewport: null });
    assertEq(answer(out, "1").case.expectedDestination.questionId, "ItemA");
    assertEq(answer(out, "2").case.expectedDestination.questionId, "ItemA");
    assertEq(answer(out, "3").case.expectedDestination, null, "'a later section' must not bind to question A");
    assertEq(answer(out, "3").expectationGap.code, "ROUTE_DESTINATION_NOT_BOUND");
    assertEq(answer(out, "4").case.expectedDestination.questionId, "A");
  });

  test("the expansion is deterministic — same rows in, same ids out", async () => {
    const mod = await worker();
    const a = await expandRef(mod);
    const b = await expandRef(mod);
    assertEq(JSON.stringify(a.facetInstances), JSON.stringify(b.facetInstances));
    assert(
      a.facetInstances.every((f) => /^xc_[0-9a-f]{16}$/.test(f.expansionCertificate)),
      "every case carries an expansion certificate over its own inputs",
    );
    assertEq(gapsOf(a).length, a.coverage.untypedCases);
  });
});

// ===========================================================================
// END TO END: an EXPANDED case through the real seal and the real verifier
// ===========================================================================

/**
 * A SCREEN THAT CARRIES ITS QUESTION ID IN BOTH PLACES A SCREEN CAN CARRY ONE — the leading
 * `Q<n>` of the fixture text, mirrored into control `name`/`id`.
 *
 * Since the 0.2 fix a text-only foreign id cannot support a destination MISMATCH: rendered
 * prose also carries back-references ("as you said in Q2…"), so the arm that ACCUSES a survey
 * requires a control named after the question it says was reached. These fixtures are about
 * TYPED CASES, not about identity provenance, so they carry both readings. Text naming no
 * question still yields no controls.
 */
const controlsFor = (text) => {
  const id = /^\s*(Q\d+)\b/.exec(String(text ?? ""))?.[1];
  if (!id) return [];
  return ["1", "2"].map((code, i) => ({
    idx: i,
    tag: "input",
    type: "radio",
    name: id,
    id: `${id}_${code}`,
    code,
    label: code === "1" ? "Yes" : "No",
    text: "",
    checked: false,
    value: null,
    disabled: false,
    required: false,
    visible: true,
    placeholder: null,
    maxlength: null,
    readOnly: false,
  }));
};

const screen = (text) => ({
  at: "2026-08-02T00:05:00.000Z",
  url: "https://fixture.invalid/survey",
  title: null,
  collectedErrors: [],
  questionText: text,
  instructionText: null,
  visibleText: text,
  visibleTextTruncated: false,
  bracketedInstructionsVisible: [],
  controls: controlsFor(text),
  optionGroups: [],
  grid: null,
  buttons: [],
  progress: { present: false, kind: null, now: null, max: null, text: null },
  validationMessages: [],
  counts: { controls: controlsFor(text).length, optionGroups: 0, options: controlsFor(text).length, textInputs: 0 },
  screenSignature: `sig:${text}`,
});

const step = (index, { code, label, reached }) => ({
  stepIndex: index,
  decisionQuestion: "Q7",
  decisionSource: "plan",
  requested: { select: [label], textEntry: null, action: null },
  screenBefore: screen("Q7. Which brand did you buy most recently?"),
  screenAfterAction: null,
  screenAfterAdvance: screen(reached),
  actions: [{ kind: "click-option", targetIdx: 0, targetLabel: label, targetCode: code, value: null, ok: true, detail: null }],
  requestedButNotOffered: [],
  advanced: true,
  blocked: false,
  pageErrors: [],
  consoleErrors: [],
  evidence: { screenBefore: null, screenAfterAdvance: null, screenshots: [] },
  wallMs: 5000,
});

/**
 * ONE WALK THAT EXERCISES BOTH ROUTE ANSWERS UNDER TEST.
 *
 * Step 0 selects the answer whose destination BOUND, and lands where the document says.
 * Step 1 selects the answer whose destination did NOT bind ("CONTINUE"), and lands on a
 * screen that literally contains the word "Continue" — which is what a Continue button
 * looks like on almost every survey. Under the previous expander that screen token-matched
 * `expectedDestination.questionId === "CONTINUE"` and the case was promoted to `verified`.
 */
const walkArtifact = (runId, { boundReached = "Q9. Which brands do you buy?" } = {}) => ({
  kind: "v2-path-observation/1.0.0",
  runId,
  pathId: PATH_ID,
  tier: 1,
  attemptId: ATTEMPT_ID,
  planRevisionId: PLAN_REVISION_ID,
  surveyUrl: "https://fixture.invalid/survey",
  startedAt: "2026-08-02T00:04:00.000Z",
  endedAt: "2026-08-02T00:05:00.000Z",
  wallMs: 60000,
  plannedWitnesses: ["req_route"],
  steps: [
    step(0, { code: "3", label: "Can't remember", reached: boundReached }),
    step(1, { code: "9", label: "Prefer not to say", reached: "Continue to the next section" }),
  ],
  outcome: "completed",
  outcomeDetail: null,
  shimmed: false,
  shimNote: null,
  loadFailure: null,
  evidenceIds: [],
  viewport: { width: 1280, height: 900 },
});

/** Seal the EXPANDER's own output, then seed the durable state a real run leaves behind. */
async function seedExpandedRun(mod, env, { walk = null } = {}) {
  const runId = mod.ids.mintRunId();
  const out = await expandRef(mod);
  const caseIds = out.facetInstances.map((f) => f.facetInstanceId);

  const { contractRevisionId, contractHash, revision } = await mod.contractRevision.sealContract(env, {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: "c".repeat(64),
    documentSha256: "c".repeat(64),
    sealedAt: "2026-08-02T00:00:00.000Z",
    requirements: referenceRows().map((r) => r.requirement),
    facetInstances: out.facetInstances,
    contractSupplements: [],
    extraction: {
      passAHash: "sha256:aaa",
      passBHash: "sha256:bbb",
      sourceLedgerHash: "sha256:ccc",
      diffHash: "sha256:ddd",
      reviewMode: "high-risk-only",
      reviewedBy: "d16-fixture",
      reviewedAt: "2026-08-02T00:00:00.000Z",
      gates: passingGates(),
    },
  });

  await mod.evidence.putEvidence(env, {
    runId,
    bytes: enc.encode(JSON.stringify(walk ?? walkArtifact(runId))),
    mediaType: "application/json",
    type: "state",
    attemptId: ATTEMPT_ID,
    routeId: PATH_ID,
    witnesses: ["req_route"],
    sourceEvidenceId: `EV-${PATH_ID}-observation`,
    artifactRef: `observations/${PATH_ID}/observation.json`,
  });

  await env.EVIDENCE.put(
    mod.keys.planKey(runId, PLAN_REVISION_ID),
    JSON.stringify({
      kind: "v2-execution-program/2.0.0",
      // 2.0.0 binds the program to its run; `loadProgram` refuses a mismatched runId.
      runId,
      planRevisionId: PLAN_REVISION_ID,
      contractRevisionId,
      contractHash,
      generatedAt: "2026-08-02T00:01:00.000Z",
      surveyUrl: "https://fixture.invalid/survey",
      floor: [{ pathId: PATH_ID, tier: 1, caseIds, witnesses: ["req_route"] }],
      exploration: [],
      caseOrder: caseIds,
      unassignedCaseIds: [],
      coverage: {
        obligations: 8,
        witnessedByFloor: 8,
        coversAllObligations: true,
        coversAllAfterMandatoryExploration: true,
        uncovered: [],
      },
      warnings: [],
      plan: { floor: { paths: [{ id: PATH_ID }] }, exploration: { queue: [] } },
    }),
    { httpMetadata: { contentType: "application/json" } },
  );

  await env.EVIDENCE.put(
    mod.keys.k("runs", runId, "execution", "progress.json"),
    JSON.stringify({
      kind: "v2-execution-progress/1.0.0",
      runId,
      planRevisionId: PLAN_REVISION_ID,
      walks: [
        {
          pathId: PATH_ID,
          tier: 1,
          attemptId: ATTEMPT_ID,
          outcome: "completed",
          outcomeDetail: null,
          steps: 2,
          wallMs: 60000,
          shimmed: false,
          loadCrash: false,
          evidenceCount: 1,
          caseIds,
          exercised: true,
          plannedDecisions: 2,
          matchedDecisions: 2,
          screensAdvanced: 2,
          at: "2026-08-02T00:05:00.000Z",
        },
      ],
      floorDone: [PATH_ID],
      explorationDone: [],
      shimRequired: false,
      hungPaths: [],
      shimEvidence: null,
      totalSteps: 2,
      totalEvidence: 1,
    }),
    { httpMetadata: { contentType: "application/json" } },
  );

  await mod.checkpoint.createCheckpoint(env, mod.checkpoint.initialCheckpoint(env, runId, "standard", false));
  await mod.checkpoint.updateCheckpoint(env, runId, (d) => {
    d.contract = {
      state: "sealed",
      contractRevisionId,
      contractHash,
      total: caseIds.length,
      requirements: { total: 8, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
    };
    d.counts = { ...d.counts, exercised: caseIds.length, pending: 0 };
    d.execution = {
      batchIndex: 1,
      sessionId: null,
      sessionOpenedAt: null,
      pendingCaseIds: [],
      completedCaseIds: caseIds,
      planRevisionId: PLAN_REVISION_ID,
    };
  });

  return { runId, out, revision };
}

const readLedger = async (mod, env, runId) =>
  JSON.parse(await (await env.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;

suite("D16 — an EXPANDED case reaches `verified`, and only when it should", () => {
  test("THE SEAL CARRIES THE TYPED CASE: what the expander bound survives sealing and re-reading", async () => {
    const mod = await worker();
    const env = testEnv();
    const { revision } = await seedExpandedRun(mod, env);

    const sealedRoutes = revision.facetInstances.filter((f) => f.case.kind === "route" && f.expectationGap === null);
    assertEq(sealedRoutes.length, 2, "the sealed ledger, not the expander's return value, is what the verifier reads");
    for (const f of sealedRoutes) {
      assert(f.case.routeAnswer.code !== null || f.case.routeAnswer.label !== null);
      assert(f.case.expectedDestination.questionId !== null);
    }
    // And the honest half of the same ledger.
    assert(
      revision.facetInstances.some((f) => f.expectationGap?.code === "ROUTE_DESTINATION_NOT_BOUND"),
      "the seal must also carry the reason a case is undecidable, or the ceiling is unauditable downstream",
    );
  });

  test("an expanded route case whose walk reached the bound destination VERIFIES", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId, out } = await seedExpandedRun(mod, env);
    await mod.projectObservations.projectObservations(env, runId);

    const result = await mod.verifyObservations.verifyObservations(env, runId);
    assertEq(result.state, "evaluated");
    assertEq(result.value.verified, 1, `expected exactly one pass: ${JSON.stringify(result.value.byReason)}`);

    const bound = answer(out, "3");
    const o = (await readLedger(mod, env, runId)).find((x) => x.facetInstanceId === bound.facetInstanceId);
    assertEq(o.verifier.decision, "verified");
    assertEq(o.verifier.predicate, "route-destination/1.0.0");
    assertEq(o.verifier.reason, "ROUTE_DESTINATION_REACHED");
  });

  test("NEGATIVE: THE ONE THAT MATTERS — an unbound destination cannot verify even when the screen spells it", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId, out } = await seedExpandedRun(mod, env);
    await mod.projectObservations.projectObservations(env, runId);
    await mod.verifyObservations.verifyObservations(env, runId);

    const relative = answer(out, "9");
    const o = (await readLedger(mod, env, runId)).find((x) => x.facetInstanceId === relative.facetInstanceId);
    // The walk DID select this answer and DID advance to a screen containing "Continue".
    // The previous expander made that a pass. It is now unverifiable, and says why.
    assertEq(o.verifier.decision, "insufficient");
    assertEq(o.verifier.reason, "NO_TYPED_EXPECTATION");
  });

  test("NEGATIVE: a typed case whose walk landed elsewhere is CONTRADICTED, never verified", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId0 = mod.ids.mintRunId();
    const { runId, out } = await seedExpandedRun(mod, env, {
      walk: { ...walkArtifact(runId0, { boundReached: "Q12. How much did you pay?" }) },
    });
    await mod.projectObservations.projectObservations(env, runId);

    const result = await mod.verifyObservations.verifyObservations(env, runId);
    assertEq(result.value.verified, 0, "the destination was not reached, so nothing may pass");

    const bound = answer(out, "3");
    const o = (await readLedger(mod, env, runId)).find((x) => x.facetInstanceId === bound.facetInstanceId);
    assertEq(o.verifier.decision, "contradicted");
    assertEq(o.verifier.reason, "ROUTE_DESTINATION_MISMATCH");
  });

  test("NEGATIVE: the run stays diagnostic-only — no signing keys were configured and none are bypassed", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedExpandedRun(mod, env);
    await mod.projectObservations.projectObservations(env, runId);
    await mod.verifyObservations.verifyObservations(env, runId);

    const keys = mod.runInputs.signingKeys(env);
    assertEq(keys.recordKeyPem, null, "a typed case must not have acquired a signing key on the way through");
    assertEq(keys.judgementKeyPem, null);
    const inputs = await mod.runInputs.loadRunInputs(env, runId);
    assertEq(inputs.envelope?.input.targetBuildId ?? null, null, "no target build id was minted either");
  });
});

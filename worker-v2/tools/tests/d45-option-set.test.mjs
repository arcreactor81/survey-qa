/**
 * D45 — THE OPTION-SET PREDICATE: A MISSING OPTION IS CLAIMABLE, AND A COMPLETE ONE IS NEVER ACCUSED.
 *
 * ============================== WHY THIS FILE EXISTS ==============================
 *
 * `PREDICATE_FOR_KIND` opened for a third kind, and every new verdict-minting path is a new way
 * to publish a confident wrong answer. The two halves of that risk are NOT symmetric in how
 * easily a test catches them:
 *
 *   A MISSING CLAIM is loud. If the predicate refuses everything, the seeded `missing-option`
 *   defect goes unreported and a single positive test notices.
 *   A FALSE CLAIM is silent. A predicate that accuses a HEALTHY survey passes every positive
 *   test in this file and ships a defect report about a working site.
 *
 * So the negative half is the larger half, and the FIRST test below is the one that matters:
 * a complete, correct option set produces NOTHING. `tools/mutate-option-set.mjs` proves each of
 * these can fail by breaking the guard it names.
 *
 * ============================== WHAT IS PINNED HERE ==============================
 *
 *   1. THE MINT (`extract/expand.ts`). Labels come from the DOCUMENT'S QUOTE, corroborated by
 *      the requirement's statement; a `scope: "survey"` option row REFUSES rather than binding
 *      by proximity; an order row and a scale header refuse; the case COUNT never moves.
 *   2. THE PREDICATE (`verify-observations.ts`). Missing / label-mismatch / extra-on-closed-set
 *      are claimable; near-variants, hidden options, grids, unattributable groups and captures
 *      that did not attest their own read all REFUSE, by name.
 *   3. THE SEAM. `KINDS_WITH_A_PREDICATE` and `PREDICATE_FOR_KIND` are set-EQUAL, so the drift
 *      `expand.ts` warns about turns this suite red instead of mis-reporting the ceiling.
 *
 * THE FIXTURE IS `test-suite/branching/s1-skip`, REDUCED, because that is the pair the live test
 * runs: Q3 lists five biologics in the .docx and the FLAWED site drops `BIMZELX`. The document
 * rows are the real extraction shapes measured on three sealed revisions
 * (`cr_805451d5…`, `cr_c49d4a06…`, `cr_7831959c…`) — `"Q3 offers 'NURTEC' as an answer option."`
 * with quote `"[#] NURTEC"`, and `"Q2 includes option 1: 'Yes…'."` with quote `"(list) 1) Yes…"`.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { passingGates } from "../fixtures/v2-fixture.mjs";

const PATH_ID = "FLOOR-D45";
const ATTEMPT_ID = "att_d45test01";
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// The sealed contract — the real s1-skip Q3, as extraction words it
// ---------------------------------------------------------------------------

const req = (id, facet, statement, quote, scope) => ({
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
  sourceAtoms: [{ blockId: "B1", kind: "list-item", coords: null, role: "option-list", atomTextHash: "sha256:aa" }],
  composition: null,
  normativeStatement: statement,
  displayQuote: quote,
  retiredAt: null,
});

/** The document's own wording of Q3 — the witness that identifies the screen (1.4.0). */
const Q3_WORDING =
  "Which of the following biologic therapies do you currently prescribe for moderate-to-severe plaque psoriasis?";
const Q4_WORDING =
  "Overall, how satisfied are you with the biologic therapies you currently prescribe for moderate-to-severe plaque psoriasis?";

const BIOLOGICS = [
  ["1", "SKYRIZI"],
  ["2", "TREMFYA"],
  ["3", "COSENTYX"],
  ["4", "TALTZ"],
  ["5", "BIMZELX"],
];

const optionRow = (code, label) =>
  req(
    `req_d45opt${code}`,
    "option-list",
    `Q3 includes option ${code}: '${label}'.`,
    `(list) ${code}) ${label}`,
    "question:Q3",
  );

const facet = (id, { target, kind, optionSet = null, lineage, gap = null }) => ({
  facetInstanceId: id,
  requirementLineageId: lineage,
  requirementVersionId: lineage.replace("req_", "reqv_"),
  caseVersionId: `cv_${id}`,
  floorCase: true,
  targetQuestionId: target,
  expansionCertificate: `cert_${id}`,
  case: {
    kind,
    routeAnswer: null,
    boundaryInput: null,
    configuration: null,
    expectedDestination: null,
    optionSet,
  },
  expectationGap: gap,
  screen: target,
  label: `${id} on ${target}`,
});

const documented = (code, label) => ({ code, label });

/** The sealed payload for "Q3 must offer <code>=<label>", with the other four as siblings. */
const membership = (code, label, { exhaustive = false, siblings = null } = {}) => ({
  asserted: [documented(code, label)],
  siblings: siblings ?? BIOLOGICS.filter(([c]) => c !== code).map(([c, l]) => documented(c, l)),
  exhaustive,
});

function contractBody({ cases }) {
  return {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: "d".repeat(64),
    documentSha256: "d".repeat(64),
    sealedAt: "2026-08-09T00:00:00.000Z",
    requirements: [
      // The QUESTION rows carry the wording witness the verifier identifies screens by.
      req("req_d45q3word", "question", Q3_WORDING, Q3_WORDING, "question:Q3"),
      req("req_d45q4word", "question", Q4_WORDING, Q4_WORDING, "question:Q4"),
      ...BIOLOGICS.map(([c, l]) => optionRow(c, l)),
    ],
    facetInstances: [
      ...cases,
      // Q4 is a sealed target too, so "Q3" and "Q4" are both in the vocabulary a screen is read
      // against — otherwise identity would be trivially unambiguous and prove nothing.
      facet("fi_d45_q4", { target: "Q4", kind: "rendered-state", lineage: "req_d45q4word" }),
    ],
    contractSupplements: [],
    extraction: {
      passAHash: "sha256:aaa",
      passBHash: "sha256:bbb",
      sourceLedgerHash: "sha256:ccc",
      diffHash: "sha256:ddd",
      reviewMode: "high-risk-only",
      reviewedBy: "d45-fixture",
      reviewedAt: "2026-08-09T00:00:00.000Z",
      gates: passingGates(),
    },
  };
}

// ---------------------------------------------------------------------------
// Screens, as `browser/page-script.ts` records them for THIS engine
// ---------------------------------------------------------------------------

/**
 * The branching engine emits `name="answer"` and `id="opt-<code>"` — so NOTHING in the markup
 * names the question, and screen identity here is carried by the document's WORDING alone.
 * That is the real instrument, and building the fixture any other way would test a survey we do
 * not have.
 */
const opt = (order, code, label, over = {}) => ({
  order,
  idx: order,
  code,
  label,
  checked: false,
  disabled: false,
  visible: true,
  operable: true,
  ...over,
});

const group = (options, name = "answer") => ({ name, kind: "checkbox", options });

const screen = (
  questionText,
  { optionGroups = [], grid = null, readerLimitations = [], controls = null, sig = null } = {},
) => {
  const ctrls =
    controls ??
    optionGroups.flatMap((g) =>
      g.options.map((o) => ({
        idx: o.idx,
        tag: "input",
        type: "checkbox",
        name: g.name,
        id: `opt-${o.code}`,
        code: o.code,
        label: o.label,
        text: "",
        checked: false,
        value: null,
        disabled: false,
        required: false,
        visible: true,
        placeholder: null,
        maxlength: null,
        readOnly: false,
      })),
    );
  const base = {
    at: "2026-08-09T00:05:00.000Z",
    url: "https://fixture.invalid/survey",
    title: null,
    collectedErrors: [],
    questionText,
    instructionText: null,
    visibleText: questionText,
    visibleTextTruncated: false,
    bracketedInstructionsVisible: [],
    controls: ctrls,
    optionGroups,
    grid,
    buttons: [{ idx: 9, label: "Next", role: "next", disabled: false, visible: true }],
    progress: { present: false, kind: null, now: null, max: null, text: null },
    validationMessages: [],
    counts: {
      controls: ctrls.length,
      optionGroups: optionGroups.length,
      options: optionGroups.reduce((n, g) => n + g.options.length, 0),
      textInputs: 0,
    },
    screenSignature: sig ?? `sig:${questionText}`,
  };
  // `readerLimitations: null` means "this capture predates the check" — the field is ABSENT,
  // which must never read as "none". Anything else is emitted as the array it is.
  if (readerLimitations !== null) base.readerLimitations = readerLimitations;
  return base;
};

const q3Screen = (labels, over = {}) =>
  screen(Q3_WORDING, {
    optionGroups: [group(labels.map(([c, l], i) => opt(i, c, l)))],
    ...over,
  });

const CLEAN_Q3 = () => q3Screen(BIOLOGICS);
const FLAWED_Q3 = () => q3Screen(BIOLOGICS.filter(([c]) => c !== "5"));

const step = (index, before) => ({
  stepIndex: index,
  // The producer's own guess, deliberately wrong: it is never a binder.
  decisionQuestion: "Q9",
  decisionSource: "plan",
  requested: { select: [], textEntry: null, action: null },
  screenBefore: before,
  screenAfterAction: null,
  screenAfterAdvance: null,
  actions: [],
  requestedButNotOffered: [],
  advanced: true,
  blocked: false,
  pageErrors: [],
  consoleErrors: [],
  evidence: { screenBefore: null, screenAfterAdvance: null, screenshots: [] },
  wallMs: 500,
});

const walkArtifact = (runId, steps) => ({
  kind: "v2-path-observation/1.0.0",
  runId,
  pathId: PATH_ID,
  tier: 1,
  attemptId: ATTEMPT_ID,
  planRevisionId: "plan_d45test01",
  surveyUrl: "https://fixture.invalid/survey",
  startedAt: "2026-08-09T00:04:00.000Z",
  endedAt: "2026-08-09T00:05:00.000Z",
  wallMs: 60000,
  plannedWitnesses: ["req_d45opt5"],
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

async function verifyCase(mod, env, { caseId, cases, steps, completeness = "complete-scoped-inventory" }) {
  const runId = mod.ids.mintRunId();
  const { contractRevisionId, contractHash } = await mod.contractRevision.sealContract(env, contractBody({ cases }));

  const entry = await mod.evidence.putEvidence(env, {
    runId,
    bytes: enc.encode(JSON.stringify(walkArtifact(runId, steps))),
    mediaType: "application/json",
    type: "state",
    attemptId: ATTEMPT_ID,
    routeId: PATH_ID,
    witnesses: ["req_d45opt5"],
    sourceEvidenceId: `EV-${PATH_ID}-observation`,
    artifactRef: `observations/${PATH_ID}/observation.json`,
  });

  await env.EVIDENCE.put(
    mod.keys.observationsKey(runId),
    JSON.stringify({
      observations: [
        {
          observationId: `obs_d45_${caseId}`,
          facetInstanceId: caseId,
          attemptId: ATTEMPT_ID,
          routeId: PATH_ID,
          observedAt: "2026-08-09T00:05:00.000Z",
          payloadKind: "v2-walk-projection/1.0.0",
          payload: {
            pathId: PATH_ID,
            attemptId: ATTEMPT_ID,
            observationEvidenceId: entry.evidenceId,
            outcome: "completed",
            outcomeDetail: null,
            screensAdvanced: steps.length,
            steps: steps.length,
            exercised: true,
            observedAt: "2026-08-09T00:05:00.000Z",
          },
          completeness,
          evidenceIds: [entry.evidenceId],
          verifier: { decision: "insufficient", evidenceIds: [entry.evidenceId], verifierVersion: "none/not-yet-verified" },
          attestation: { producedBy: "v2-executor", producerVersion: "v2-observation-projection/1.0.0", payloadHash: "sha256:d45" },
        },
      ],
    }),
    { httpMetadata: { contentType: "application/json" } },
  );

  const total = cases.length + 1;
  await mod.checkpoint.createCheckpoint(env, mod.checkpoint.initialCheckpoint(env, runId, "standard", false));
  await mod.checkpoint.updateCheckpoint(env, runId, (d) => {
    d.contract = {
      state: "sealed",
      contractRevisionId,
      contractHash,
      total,
      requirements: { total: 7, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
    };
    // The coverage ledger refuses a checkpoint whose buckets do not sum to the sealed total.
    d.counts = { ...d.counts, exercised: 1, pending: total - 1 };
  });

  const result = await mod.verifyObservations.verifyObservations(env, runId);
  const ledger = JSON.parse(await (await env.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;
  return { runId, result, row: ledger.find((o) => o.facetInstanceId === caseId) };
}

/** The case under test: "Q3 must offer 5=BIMZELX". */
const bimzelxCase = (over = {}) => [
  facet("fi_d45_bimzelx", { target: "Q3", kind: "option-set", lineage: "req_d45opt5", optionSet: membership("5", "BIMZELX", over) }),
];

// ===========================================================================
suite("D45 — the half that matters: a correct option set is NEVER accused", () => {
  test("THE ONE THAT MATTERS: a complete, correct option set produces no claim at all", async () => {
    const mod = await worker();
    const { result, row } = await verifyCase(mod, await Promise.resolve(testEnv()), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, CLEAN_Q3())],
    });
    assertEq(row.verifier.decision, "verified", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_SET_AS_DOCUMENTED");
    assertEq(result.value.contradicted, 0, "a healthy survey must contribute zero defect claims");
  });

  test("NEVER ACCUSED: every one of the five documented options is offered, and none is claimed", async () => {
    const mod = await worker();
    for (const [code, label] of BIOLOGICS) {
      const env = testEnv();
      const { row } = await verifyCase(mod, env, {
        caseId: `fi_d45_${code}`,
        cases: [
          facet(`fi_d45_${code}`, {
            target: "Q3",
            kind: "option-set",
            lineage: `req_d45opt${code}`,
            optionSet: membership(code, label),
          }),
        ],
        steps: [step(0, CLEAN_Q3())],
      });
      assertEq(row.verifier.decision, "verified", `${label}: ${JSON.stringify(row.verifier)}`);
    }
  });

  test("NEVER ACCUSED: a site that WORDS an option differently is not accused of missing it", async () => {
    const mod = await worker();
    // The document says "18-24"; the site renders "18 to 24". Same option, two spellings. A
    // label-equality test alone calls this a MISSING OPTION — a confident defect about a
    // healthy survey, which is this product's cardinal failure.
    const wordy = screen(Q3_WORDING, {
      optionGroups: [group([opt(0, "1", "18 to 24"), opt(1, "2", "25 to 34")])],
    });
    const { row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_age",
      cases: [
        facet("fi_d45_age", {
          target: "Q3",
          kind: "option-set",
          lineage: "req_d45opt1",
          optionSet: { asserted: [documented("1", "18-24")], siblings: [], exhaustive: false },
        }),
      ],
      steps: [step(0, wordy)],
    });
    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_LABEL_NEAR_MATCH_ONLY");
  });

  test("NEVER ACCUSED: a site whose extra wording ADDS words ('Other (please specify)') is not accused", async () => {
    const mod = await worker();
    const withSpecify = screen(Q3_WORDING, {
      optionGroups: [group([opt(0, "1", "SKYRIZI"), opt(1, "9", "Other (please specify)")])],
    });
    const { row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_other",
      cases: [
        facet("fi_d45_other", {
          target: "Q3",
          kind: "option-set",
          lineage: "req_d45opt1",
          optionSet: { asserted: [documented("9", "Other")], siblings: [], exhaustive: false },
        }),
      ],
      steps: [step(0, withSpecify)],
    });
    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_LABEL_NEAR_MATCH_ONLY");
  });

  test("NEVER ACCUSED: the option set of ANOTHER question is not this case's evidence", async () => {
    const mod = await worker();
    // The walk only ever saw Q4. Q3's options are absent from it — and reading Q4's inventory
    // as Q3's would report all five biologics missing from a survey that offers them one
    // screen later. Binding refuses; nobody is accused.
    const q4 = screen(Q4_WORDING, {
      optionGroups: [group([opt(0, "1", "Very satisfied"), opt(1, "2", "Somewhat satisfied")])],
    });
    const { row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, q4)],
    });
    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "STEP_NOT_BOUND_TO_TARGET_QUESTION");
  });

  test("A SCREEN WITH NO OPTIONS AT ALL is a different refusal from one whose groups cannot be attributed", async () => {
    const mod = await worker();
    // Q3 rendered as a free-text question: the walk found the screen and it carries no answer
    // options at all. That is `OPTION_INVENTORY_NOT_CAPTURED` — nothing was ever captured to
    // compare — and it must stay distinct from `OPTION_GROUP_NOT_ATTRIBUTABLE`, which means an
    // inventory WAS captured and could not be tied to this question. The two call for different
    // repairs (walk the question / read the markup), so they must not share a bucket.
    const textOnly = screen(Q3_WORDING, {
      optionGroups: [],
      controls: [
        {
          idx: 0,
          tag: "textarea",
          type: "textarea",
          name: "answer",
          id: "answer",
          code: null,
          label: Q3_WORDING,
          text: "",
          checked: null,
          value: "",
          disabled: false,
          required: false,
          visible: true,
          placeholder: null,
          maxlength: null,
          readOnly: false,
        },
      ],
    });
    const { row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, textOnly)],
    });
    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_INVENTORY_NOT_CAPTURED");
  });

  test("NEVER ACCUSED: a capture that did not attest its own read cannot support an absence claim", async () => {
    const mod = await worker();
    // Same missing BIMZELX, but the reader REPORTED a limitation on this screen — so its
    // inventory is not a complete positive read and "it is not there" is not established.
    const degraded = q3Screen(BIOLOGICS.filter(([c]) => c !== "5"), {
      readerLimitations: [{ kind: "grid-column-labels-unresolved", detail: "columns did not match inputs", count: 1 }],
    });
    const { row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, degraded)],
    });
    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_INVENTORY_READ_NOT_ATTESTED");

    // AND ABSENCE OF THE FIELD IS NOT "NONE": an older capture never looked, and must not
    // silently license the accusation a newer one would have earned.
    const older = q3Screen(BIOLOGICS.filter(([c]) => c !== "5"), { readerLimitations: null });
    const { row: row2 } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, older)],
    });
    assertEq(row2.verifier.decision, "insufficient", JSON.stringify(row2.verifier));
    assertEq(row2.verifier.reason, "OPTION_INVENTORY_READ_NOT_ATTESTED");
  });

  test("NEVER ACCUSED: a grid is not compared, and a screen hosting two groups is not guessed at", async () => {
    const mod = await worker();
    const gridScreen = q3Screen(BIOLOGICS.filter(([c]) => c !== "5"), {
      grid: { columns: ["Agree"], rows: [] },
    });
    const { row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, gridScreen)],
    });
    assertEq(row.verifier.reason, "OPTION_SET_ON_A_GRID_NOT_COMPARED");

    const twoGroups = screen(Q3_WORDING, {
      optionGroups: [
        group(BIOLOGICS.filter(([c]) => c !== "5").map(([c, l], i) => opt(i, c, l)), "answer"),
        group([opt(0, "1", "Yes"), opt(1, "2", "No")], "consent"),
      ],
    });
    const { row: row2 } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, twoGroups)],
    });
    assertEq(row2.verifier.reason, "OPTION_GROUP_NOT_ATTRIBUTABLE");
  });

  test("NEVER ACCUSED: a case whose payload was refused at expansion reaches no verdict", async () => {
    const mod = await worker();
    const { row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_nopayload",
      cases: [
        facet("fi_d45_nopayload", {
          target: "Q3",
          kind: "option-set",
          lineage: "req_d45opt5",
          optionSet: null,
          gap: { code: "OPTION_SET_NOT_BOUND_TO_A_QUESTION", detail: "scope: survey" },
        }),
      ],
      steps: [step(0, FLAWED_Q3())],
    });
    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "NO_TYPED_EXPECTATION");
  });
});

// ===========================================================================
suite("D45 — fail-closed must not become fail-silent: the seeded defect IS claimed", () => {
  test("THE SEEDED DEFECT: s1-skip's flawed Q3 drops BIMZELX, and the run says so", async () => {
    const mod = await worker();
    const { result, row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, FLAWED_Q3())],
    });
    assertEq(row.verifier.decision, "contradicted", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_MISSING");
    assertEq(result.value.contradicted, 1);
    assert(
      /BIMZELX/.test(row.verifier.detail) && /SKYRIZI/.test(row.verifier.detail),
      `the detail must quote what was required and what was offered: ${row.verifier.detail}`,
    );
    assertEq(row.verifier.predicate, "option-set-offered/1.0.0");
  });

  test("THE OTHER FOUR ARE STILL FINE: only the dropped option is claimed", async () => {
    const mod = await worker();
    for (const [code, label] of BIOLOGICS) {
      const { row } = await verifyCase(mod, testEnv(), {
        caseId: `fi_d45_${code}`,
        cases: [
          facet(`fi_d45_${code}`, {
            target: "Q3",
            kind: "option-set",
            lineage: `req_d45opt${code}`,
            optionSet: membership(code, label),
          }),
        ],
        steps: [step(0, FLAWED_Q3())],
      });
      assertEq(
        row.verifier.decision,
        code === "5" ? "contradicted" : "verified",
        `${label}: ${JSON.stringify(row.verifier)}`,
      );
    }
  });

  test("LABEL MISMATCH is claimable — but only once the site's CODES are shown to mean the same thing", async () => {
    const mod = await worker();
    // The site renders code 3 as "COSENTYX (secukinumab)". Codes 1, 2 and 4 match the document
    // by code AND label, so the two numbering schemes coincide here and code 3 is the same
    // option under different wording.
    const reworded = q3Screen([
      ["1", "SKYRIZI"],
      ["2", "TREMFYA"],
      ["3", "COSENTYX (secukinumab)"],
      ["4", "TALTZ"],
      ["5", "BIMZELX"],
    ]);
    const { row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_3",
      cases: [
        facet("fi_d45_3", {
          target: "Q3",
          kind: "option-set",
          lineage: "req_d45opt3",
          optionSet: membership("3", "COSENTYX"),
        }),
      ],
      steps: [step(0, reworded)],
    });
    assertEq(row.verifier.decision, "contradicted", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_LABEL_MISMATCH");

    // THE COUNTERWEIGHT, AND IT IS THE LOAD-BEARING HALF. Take the corroboration away while
    // leaving EVERYTHING ELSE IDENTICAL — code 3 still carries a near variant of the
    // documented label — and the same rendering must be REFUSED. The site here appends a
    // generic name to every option, so no documented (code,label) pair matches exactly and
    // nothing witnesses that its codes mean what the document's do.
    //
    // THIS FIXTURE IS THE ONE THAT DISCRIMINATES, and an earlier version was not: it shifted
    // the codes so that code 3 carried an UNRELATED label, which the near-variant test rejects
    // on its own. Deleting the licence gate then changed no outcome and the mutant survived —
    // a counterweight that could not fail, in a file about checks that cannot fail.
    const zeroBased = q3Screen([
      ["1", "SKYRIZI (risankizumab)"],
      ["2", "TREMFYA (guselkumab)"],
      ["3", "COSENTYX (secukinumab)"],
      ["4", "TALTZ (ixekizumab)"],
      ["5", "BIMZELX (bimekizumab)"],
    ]);
    const { row: row2 } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_3",
      cases: [
        facet("fi_d45_3", {
          target: "Q3",
          kind: "option-set",
          lineage: "req_d45opt3",
          optionSet: membership("3", "COSENTYX"),
        }),
      ],
      steps: [step(0, zeroBased)],
    });
    assertEq(row2.verifier.decision, "insufficient", JSON.stringify(row2.verifier));
    assertEq(row2.verifier.reason, "OPTION_LABEL_NEAR_MATCH_ONLY");
  });

  test("AN EXTRA OPTION is claimable ONLY when the document closes the set", async () => {
    const mod = await worker();
    const withExtra = q3Screen([...BIOLOGICS, ["9", "ENBREL"]]);
    const closed = {
      asserted: BIOLOGICS.map(([c, l]) => documented(c, l)),
      siblings: [],
      exhaustive: true,
    };
    const { row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_closed",
      cases: [facet("fi_d45_closed", { target: "Q3", kind: "option-set", lineage: "req_d45opt1", optionSet: closed })],
      steps: [step(0, withExtra)],
    });
    assertEq(row.verifier.decision, "contradicted", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_OFFERED_NOT_DOCUMENTED");

    // THE COUNTERWEIGHT: the SAME site against a MEMBERSHIP requirement claims nothing. A row
    // that says "Q3 offers SKYRIZI" never said Q3 offers nothing else, and a question whose
    // "Other" is stated in a row this case has not seen would otherwise be accused of it.
    const { row: row2 } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_open",
      cases: [
        facet("fi_d45_open", {
          target: "Q3",
          kind: "option-set",
          lineage: "req_d45opt1",
          optionSet: { ...closed, exhaustive: false },
        }),
      ],
      steps: [step(0, withExtra)],
    });
    assertEq(row2.verifier.decision, "verified", JSON.stringify(row2.verifier));
  });

  test("AN EXHAUSTIVE PASS is an absence claim, so a PARTIAL walk cannot support it", async () => {
    const mod = await worker();
    const closed = { asserted: BIOLOGICS.map(([c, l]) => documented(c, l)), siblings: [], exhaustive: true };
    const args = {
      caseId: "fi_d45_closed",
      cases: [facet("fi_d45_closed", { target: "Q3", kind: "option-set", lineage: "req_d45opt1", optionSet: closed })],
      steps: [step(0, CLEAN_Q3())],
    };
    const { row } = await verifyCase(mod, testEnv(), args);
    assertEq(row.verifier.decision, "verified", JSON.stringify(row.verifier));

    const { row: partial } = await verifyCase(mod, testEnv(), { ...args, completeness: "partial" });
    assertEq(partial.verifier.decision, "insufficient", JSON.stringify(partial.verifier));
    assertEq(partial.verifier.reason, "PARTIAL_SCOPE_CANNOT_SUPPORT_ABSENCE");

    // ...while a MEMBERSHIP pass is a positive label match and is unaffected by walk scope.
    const { row: member } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, CLEAN_Q3())],
      completeness: "partial",
    });
    assertEq(member.verifier.decision, "verified", JSON.stringify(member.verifier));
  });

  test("A HIDDEN option is neither offered nor missing, and is not reported as either", async () => {
    const mod = await worker();
    const hidden = q3Screen(BIOLOGICS.filter(([c]) => c !== "5"));
    hidden.optionGroups[0].options.push(opt(4, "5", "BIMZELX", { visible: false, operable: false }));
    const { row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, hidden)],
    });
    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_PRESENT_BUT_NOT_OPERABLE");
  });
});

// ===========================================================================
suite("D45 — the mint: labels come from the DOCUMENT, and an unbound list refuses", () => {
  const rowFor = (over) => ({
    requirement: {
      requirementLineageId: over.id ?? "req_mint01",
      requirementVersionId: (over.id ?? "req_mint01").replace("req_", "reqv_"),
      semanticFingerprint: "fp_mint",
      scope: over.scope ?? "question:Q3",
      quantifier: "specific",
      selector: null,
      exceptions: [],
      facet: over.facet ?? "option-list",
      assertionStatus: "entailed",
      testability: "browser-observable",
      notBrowserObservableReason: null,
      sourceAtoms: [],
      composition: null,
      normativeStatement: over.statement,
      displayQuote: over.quote,
      retiredAt: null,
    },
    raw: [{ expansion: null }],
  });

  const expand = async (mod, rows) =>
    await mod.expand.expandFloor(rows, { locale: "en", viewport: "desktop" });

  test("THE LABEL BYTES ARE THE DOCUMENT'S: three real extraction shapes all mint", async () => {
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({ id: "req_a", statement: "Q3 offers 'NURTEC' as an answer option.", quote: "[#] NURTEC" }),
      rowFor({
        id: "req_b",
        statement: "S3 includes the response option 'Advertising or public relations' with code 3.",
        quote: "3) Advertising or public relations",
        scope: "question:S3",
      }),
      rowFor({
        id: "req_c",
        statement: "Q2 includes option 1: 'Yes, a daily oral preventive'.",
        quote: "(list) 1) Yes, a daily oral preventive",
        scope: "question:Q2",
      }),
    ]);
    assertEq(out.facetInstances.length, 3, "one case per option requirement — the count never moves");
    const by = (id) => out.facetInstances.find((f) => f.requirementLineageId === id);
    assertEq(by("req_a").expectationGap, null);
    assertEq(by("req_a").case.optionSet.asserted[0].label, "NURTEC");
    assertEq(by("req_a").case.optionSet.asserted[0].code, null, "the quote printed no code, so none is invented");
    assertEq(by("req_b").case.optionSet.asserted[0].code, "3");
    assertEq(by("req_b").case.optionSet.asserted[0].label, "Advertising or public relations");
    assertEq(by("req_c").case.optionSet.asserted[0].code, "1");
    assertEq(by("req_c").case.optionSet.asserted[0].label, "Yes, a daily oral preventive");
    for (const f of out.facetInstances) assertEq(f.case.kind, "option-set");
  });

  test("REFUSED: a `scope: survey` option list is never bound to a question by proximity", async () => {
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({ id: "req_q", statement: "Q3 offers 'NURTEC' as an answer option.", quote: "[#] NURTEC" }),
      // THE MEASURED HAZARD: a fifth of real option rows look like this, and three different
      // questions' option-1 rows all sit here claiming code 1.
      rowFor({
        id: "req_s",
        scope: "survey",
        statement: "The survey contains an answer option with code '99' and label 'None of these'.",
        quote: "(list) 99) None of these [EXCLUSIVE]",
      }),
    ]);
    const survey = out.facetInstances.find((f) => f.requirementLineageId === "req_s");
    assertEq(survey.case.optionSet, null, "no payload may be minted for an unbound option list");
    assertEq(survey.expectationGap.code, "OPTION_SET_NOT_BOUND_TO_A_QUESTION");
    assertEq(survey.case.kind, "option-set", "the kind still says what the requirement IS");
    assertEq(survey.floorCase, true, "and it stays in the denominator (D10)");
    assertEq(out.coverage.byGap.OPTION_SET_NOT_BOUND_TO_A_QUESTION, 1, "the refusal is COUNTED");
  });

  test("REFUSED: an ORDER rule and a SCALE header carry no option lines, and none is imagined", async () => {
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({
        id: "req_order",
        scope: "question:Q2",
        statement:
          "For Q2, the answer options must be presented in the order: 1. Reduction in monthly migraine days, 2. Speed of onset of benefit, and they must not be randomized.",
        quote: "PROGRAMMER NOTE: Present options in the exact order listed above. Do not randomize.",
      }),
      rowFor({
        id: "req_scale",
        scope: "question:GRID_1",
        statement: "The grid question's scale consists of exactly 5 options, in this order: Strongly agree, Somewhat agree.",
        quote: "[SCALE — COLUMNS, IN THIS ORDER:]",
      }),
      rowFor({
        id: "req_rating",
        scope: "question:Q8",
        statement: "Q8 presents a rating scale of integer values from 0 to 10 inclusive.",
        quote: "[RATING SCALE 0–10]",
      }),
    ]);
    for (const f of out.facetInstances) {
      assertEq(f.case.optionSet, null, `${f.requirementLineageId} minted a payload from prose alone`);
      assertEq(f.expectationGap.code, "OPTION_SET_NOT_READ_FROM_THE_DOCUMENT_QUOTE");
    }
    assertEq(out.coverage.byGap.OPTION_SET_NOT_READ_FROM_THE_DOCUMENT_QUOTE, 3);
  });

  test("REFUSED: PROSE the statement DOES quote must not become a sealed option label", async () => {
    const mod = await worker();
    // THE DANGEROUS SHAPE, and the reason the phrase guard is structural rather than a
    // corroboration check. Extraction often quotes the document verbatim in its statement, so a
    // programmer note reaches BOTH readings and corroborates itself. Sealed as a label, the
    // predicate would hunt for that sentence in a screen's option inventory, never find it, and
    // publish a missing-option claim about a survey that is behaving exactly as documented.
    const note = "PROGRAMMER NOTE: Present options in the exact order listed above. Do not randomize.";
    const out = await expand(mod, [rowFor({ id: "req_prose", statement: note, quote: note })]);
    const f = out.facetInstances[0];
    assertEq(f.case.optionSet, null, "a multi-sentence line is prose, and prose is not an answer option");
    assertEq(f.expectationGap.code, "OPTION_SET_NOT_READ_FROM_THE_DOCUMENT_QUOTE");
  });

  test("REFUSED: a label the requirement's own STATEMENT does not carry is a disagreement, not a fact", async () => {
    const mod = await worker();
    const out = await expand(mod, [
      // The model paraphrased: the document prints "25 to 34", the sentence says "25-34".
      rowFor({ id: "req_p", statement: "Q3 offers '25-34' as an answer option.", quote: "(list) 2) 25 to 34" }),
    ]);
    const f = out.facetInstances[0];
    assertEq(f.case.optionSet, null);
    assertEq(f.expectationGap.code, "OPTION_LABEL_NOT_CORROBORATED_BY_THE_STATEMENT");
  });

  test("REFUSED: a statement naming ANOTHER question the document knows is ambiguous, not resolved", async () => {
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({ id: "req_q5", scope: "question:Q5", statement: "Q5 asks about barriers.", quote: "Q5.", facet: "question" }),
      rowFor({
        id: "req_x",
        scope: "question:Q3",
        statement: "The options carried forward from Q5 include 'SKYRIZI'.",
        quote: "(list) 1) SKYRIZI",
      }),
    ]);
    const f = out.facetInstances.find((x) => x.requirementLineageId === "req_x");
    assertEq(f.case.optionSet, null);
    assertEq(f.expectationGap.code, "OPTION_SET_QUESTION_AMBIGUOUS");
  });

  test("THE CLOSED SET: `exactly N … and no others` needs the QUOTE to bear the count out", async () => {
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({
        id: "req_closed",
        statement:
          "Q3 offers exactly the following five answer options, and no others: KEYTRUDA, OPDIVO, TECENTRIQ, IMFINZI, LIBTAYO.",
        quote: "KEYTRUDA\nOPDIVO\nTECENTRIQ\nIMFINZI\nLIBTAYO",
      }),
      // THE ONE THAT MUST NOT CLOSE. The statement says "four" and the quote captured ONE. A
      // payload that called that closed would accuse the site of offering three options the
      // document lists.
      rowFor({
        id: "req_short",
        scope: "question:S1",
        statement:
          'S1 must offer exactly the following four response options: "Neurologist", "Headache specialist", "Primary care physician", "Nurse practitioner".',
        quote: "[#] Neurologist",
      }),
    ]);
    const closed = out.facetInstances.find((f) => f.requirementLineageId === "req_closed");
    assertEq(closed.case.optionSet.asserted.length, 5);
    assertEq(closed.case.optionSet.exhaustive, true);
    const short = out.facetInstances.find((f) => f.requirementLineageId === "req_short");
    assertEq(short.case.optionSet.asserted.length, 1, "only the option the document QUOTED is asserted");
    assertEq(short.case.optionSet.exhaustive, false, "a stated count the quote does not bear out never closes a set");
  });

  test("SIBLINGS are the other rows' options for the SAME question, and carry no claim", async () => {
    const mod = await worker();
    const out = await expand(
      mod,
      BIOLOGICS.map(([c, l]) =>
        rowFor({ id: `req_s${c}`, statement: `Q3 includes option ${c}: '${l}'.`, quote: `(list) ${c}) ${l}` }),
      ).concat([
        rowFor({ id: "req_other", scope: "question:Q4", statement: "Q4 includes option 1: 'Very satisfied'.", quote: "(list) 1) Very satisfied" }),
      ]),
    );
    const one = out.facetInstances.find((f) => f.requirementLineageId === "req_s1");
    assertEq(one.case.optionSet.asserted.length, 1);
    assertEq(one.case.optionSet.siblings.length, 4, "the other four Q3 options, and nothing from Q4");
    assert(
      !one.case.optionSet.siblings.some((s) => s.label === "SKYRIZI"),
      "a row is never its own sibling",
    );
    assert(
      !one.case.optionSet.siblings.some((s) => s.label === "Very satisfied"),
      "another question's options are not this question's corroboration",
    );
  });
});

// ===========================================================================
suite("D45 — the registry opened for exactly one kind, and the two tables agree", () => {
  test("THE REGISTRY: exactly route, boundary and option-set — nothing else acquired a predicate", async () => {
    const mod = await worker();
    assertEq(
      Object.keys(mod.verifyObservations.PREDICATE_FOR_KIND).sort().join(","),
      "boundary,option-set,route",
      "opening the registry for a kind is a deliberate act; this list is the audit of it",
    );
  });

  test("NO DRIFT: the expander's typed-kind set and the verifier's registry are set-EQUAL", async () => {
    const mod = await worker();
    // `expand.ts` reports a case as TYPED from its own copy of this set. The two disagreeing is
    // how a case comes to be counted as decidable that no predicate can reach, or gapped when
    // one can — and its own comment warns about exactly that.
    assertEq(
      mod.expand.kindsWithAPredicate().join(","),
      Object.keys(mod.verifyObservations.PREDICATE_FOR_KIND).sort().join(","),
    );
  });

  test("A KIND WITH NO PREDICATE IS STILL NEVER TYPED", async () => {
    const mod = await worker();
    const out = await mod.expand.expandFloor(
      [
        {
          requirement: {
            requirementLineageId: "req_copy",
            requirementVersionId: "reqv_copy",
            semanticFingerprint: "fp_copy",
            scope: "survey",
            quantifier: "every",
            selector: null,
            exceptions: [],
            facet: "copy",
            assertionStatus: "entailed",
            testability: "browser-observable",
            notBrowserObservableReason: null,
            sourceAtoms: [],
            composition: null,
            normativeStatement: "The footer must name the sponsor.",
            displayQuote: "The footer must name the sponsor.",
            retiredAt: null,
          },
          raw: [{ expansion: null }],
        },
      ],
      { locale: "en", viewport: "desktop" },
    );
    assertEq(out.facetInstances[0].expectationGap.code, "NO_TYPED_PREDICATE_FOR_KIND");
  });
});

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

function contractBody({ cases, requirements = null }) {
  return {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: "d".repeat(64),
    documentSha256: "d".repeat(64),
    sealedAt: "2026-08-09T00:00:00.000Z",
    requirements:
      requirements ??
      [
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
 * names the question, and screen identity there is carried by the document's WORDING alone.
 * 1.8.0 (FIX C1 respin): that shape DECIDES again. A sole non-empty group that fails
 * name/prefix attribution is still accepted when it is the screen's ONLY answerable thing
 * beyond navigation controls and its name is not the reader's "(unnamed)" merge key — which
 * is exactly the engine's shape (radios named "answer" plus a Next button and nothing else).
 * The borrowed-inventory shapes 1.7.0 closed (a select-rendered target, a consent group
 * beside a textarea target) still refuse, because in each of them ANOTHER answerable control
 * on the screen could be the target's rendering — see the FIX C1 suite below.
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

/**
 * THE DEFAULT GROUP IS "answer" — the real branching engine's shape, RESTORED (1.8.0, FIX C1
 * respin). The strict 1.7.0 rule required name/prefix attribution even for a sole group, so
 * these fixtures were briefly renamed "Q3" to keep the guards BEHIND attribution (near-match,
 * hidden, attested, exhaustive, mismatch) exercised; under the 1.8.0 discriminator the
 * engine's sole "answer" group is attributable-by-only-answerable — these screens carry no
 * other answerable control beyond the group's own checkboxes — so the fixtures are once again
 * the instrument the live test actually runs, and the same guards are exercised through the
 * clause the corpus itself takes. Name/prefix attribution is still exercised by the "Q3" and
 * "Q3_answer" fixtures in the FIX C1 suite below.
 */
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

const attestedSelectControl = (entries = BIOLOGICS, over = {}) => ({
  idx: over.idx ?? 0,
  tag: "select",
  type: "select",
  name: over.name ?? "Q3",
  id: over.id ?? "Q3",
  code: null,
  label: Q3_WORDING,
  text: "",
  checked: null,
  value: "",
  disabled: over.disabled ?? false,
  required: true,
  visible: over.visible ?? true,
  placeholder: null,
  maxlength: null,
  readOnly: false,
  multiple: over.multiple ?? false,
  options: [
    { order: 0, code: "", label: "Choose a therapy", selected: true, disabled: false, hidden: false, placeholder: true },
    ...entries.map(([code, label], index) => ({
      order: index + 1, code, label, selected: false, disabled: false,
      hidden: over.hiddenCode === code, placeholder: false,
    })),
  ],
});

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

async function verifyCase(
  mod,
  env,
  { caseId, cases, steps, completeness = "complete-scoped-inventory", requirements = null },
) {
  const runId = mod.ids.mintRunId();
  const body = contractBody({ cases, requirements });
  const { contractRevisionId, contractHash } = await mod.contractRevision.sealContract(env, body);

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
      requirements: { total: body.requirements.length, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
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

suite("W4 / native-select inventories reach option-set verdicts only when fully attested", () => {
  const dropdownScreen = (control) => screen(Q3_WORDING, { optionGroups: [], controls: [control] });

  test("a complete current native-select inventory verifies and its HTML placeholder is not an extra", async () => {
    const mod = await worker();
    const base = bimzelxCase()[0];
    const closed = [{
      ...base,
      facetInstanceId: "fi_d45_select_closed",
      caseVersionId: "cv_fi_d45_select_closed",
      case: {
        ...base.case,
        optionSet: { asserted: BIOLOGICS.map(([code, label]) => documented(code, label)), siblings: [], exhaustive: true },
      },
    }];
    const { row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_select_closed",
      cases: closed,
      steps: [step(0, dropdownScreen(attestedSelectControl()))],
    });
    assertEq(row.verifier.decision, "verified", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_SET_AS_DOCUMENTED");
  });

  test("a fully attested dropdown missing a documented option produces the real OPTION_MISSING claim", async () => {
    const mod = await worker();
    const { result, row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, dropdownScreen(attestedSelectControl(BIOLOGICS.filter(([code]) => code !== "5"))))],
    });
    assertEq(row.verifier.decision, "contradicted", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_MISSING");
    assertEq(result.value.contradicted, 1);
  });

  test("hidden documented options, multiple selects, and competing target inventories stay named insufficient", async () => {
    const mod = await worker();
    const fixtures = [
      [dropdownScreen(attestedSelectControl(BIOLOGICS, { hiddenCode: "5" })), "OPTION_PRESENT_BUT_NOT_OPERABLE"],
      [dropdownScreen(attestedSelectControl(BIOLOGICS, { multiple: true })), "OPTION_SELECT_MULTIPLE_NOT_SUPPORTED"],
      [screen(Q3_WORDING, { optionGroups: [], controls: [attestedSelectControl(), attestedSelectControl(BIOLOGICS, { idx: 1, id: "Q3_second" })] }), "OPTION_INVENTORY_TARGET_AMBIGUOUS"],
    ];
    for (const [site, reason] of fixtures) {
      const { result, row } = await verifyCase(mod, testEnv(), {
        caseId: "fi_d45_bimzelx", cases: bimzelxCase(), steps: [step(0, site)],
      });
      assertEq(row.verifier.decision, "insufficient", `${reason}: ${JSON.stringify(row.verifier)}`);
      assertEq(row.verifier.reason, reason, JSON.stringify(row.verifier));
      assertEq(result.value.contradicted, 0);
    }
  });
});

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
    // Named "Q4" explicitly: this screen IS Q4 and its group may as well say so; identity
    // (wording = Q4) refuses the bind either way, before any group logic runs.
    const q4 = screen(Q4_WORDING, {
      optionGroups: [group([opt(0, "1", "Very satisfied"), opt(1, "2", "Somewhat satisfied")], "Q4")],
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
    // 1.8.0 (FIX C1 respin) — BACK ON THE ENGINE'S OWN SHAPE. The sole group here is named
    // "answer" again (the `group` default): under 1.7.0's unconditional attribution rule this
    // exact fixture refused (OPTION_GROUP_NOT_ATTRIBUTABLE), which traded the corpus's one
    // proven true positive for the false-accusation fix. The 1.8.0 discriminator keeps both —
    // this group is the screen's only answerable thing beyond navigation, so it IS Q3's
    // rendering whatever the markup calls it, and the seeded defect is claimed again. The
    // borrowed-inventory shapes that motivated 1.7.0 stay refusals in the FIX C1 suite below.
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
    // 1.8.1 re-anchor: the extra accusation now ALSO needs clause (i) name attribution (a
    // clause (ii) sole group may be a name-fusion — see the 1.8.1 suite at the end of this
    // file), so this fixture names its group "Q3". The property pinned HERE is unchanged:
    // an extra option is claimable only when the document CLOSES the set.
    const withExtra = screen(Q3_WORDING, {
      optionGroups: [group([...BIOLOGICS, ["9", "ENBREL"]].map(([c, l], i) => opt(i, c, l)), "Q3")],
    });
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
      quantifier: over.quantifier ?? "specific",
      selector: null,
      exceptions: [],
      facet: over.facet ?? "option-list",
      assertionStatus: over.assertionStatus ?? "entailed",
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

  /** A contract register with one ordinary option row replaced by the exact row under test. */
  const requirementsReplacing = (code, replacement) => [
    req("req_d45q3word", "question", Q3_WORDING, Q3_WORDING, "question:Q3"),
    req("req_d45q4word", "question", Q4_WORDING, Q4_WORDING, "question:Q4"),
    ...BIOLOGICS.filter(([held]) => held !== code).map(([held, label]) => optionRow(held, label)),
    replacement,
  ];

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
      assertEq(
        f.expectationGap.code,
        "OPTION_SET_QUOTE_LINE_UNPARSED",
        "a structurally plausible line that cannot be classified is counted unread, not silently discarded",
      );
    }
    assertEq(out.coverage.byGap.OPTION_SET_QUOTE_LINE_UNPARSED, 3);
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
    assertEq(f.expectationGap.code, "OPTION_SET_QUOTE_LINE_UNPARSED");
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

  test("FIX A1 (review-extract finding 1): a numeral-free closure over a DROPPED quote line must not close the set", async () => {
    // PINS THE PRE-FIX BUG (expander < 1.5.0): `exhaustive` was computed from `parsed.length`
    // — the count that SURVIVED parseDocumentedOptions' filters — so the two-sentence line
    // "Not sure. I would need more information." vanished silently, the numeral-free closure
    // phrase returned true ("answer" is not a NUMBER_WORD), and `exhaustive: true` sealed over
    // an incomplete option list. A site faithfully rendering all three options was then
    // accused of OPTION_OFFERED_NOT_DOCUMENTED — a confident wrong answer about a compliant
    // survey. On pre-1.5.0 code this test FAILS: exhaustive === true and no gap is counted.
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({
        id: "req_droppedline",
        scope: "question:Q7",
        statement:
          "Q7 offers exactly the following answer options and no others: Yes, No, Not sure. I would need more information.",
        quote: "Yes\nNo\nNot sure. I would need more information.",
      }),
    ]);
    const f = out.facetInstances[0];
    assertEq(f.case.optionSet, null, "a gap-marked case must carry no executable membership payload");
    assertEq(f.expectationGap.code, "OPTION_SET_QUOTE_LINE_UNPARSED", "the loss is named on the untyped case");
    assertEq(out.coverage.byGap.OPTION_SET_QUOTE_LINE_UNPARSED, 1, "the loss is COUNTED, not silent");
    assertEq(out.coverage.typedCases, 0, "coverage must not call a gap-marked case decidable");
    assertEq(out.coverage.untypedCases, 1, "the counted gap and the untyped denominator are the same case");
  });

  test("FIX A1: 'Other (please specify):' killed by the header guard cannot seal a closed set", async () => {
    // The same finding via the `/:$/` guard — the strongest real-world route. "Other (please
    // specify):" is an extremely common genuine option line; TRAILING_MARKER does not strip
    // its colon, so the header guard drops it, and pre-1.5.0 the row sealed `exhaustive: true`
    // over [Yes, No] — accusing a compliant site of offering the "Other" the document lists.
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({
        id: "req_otherline",
        scope: "question:Q9",
        statement: "Q9 offers exactly the following answer options and no others: Yes, No, Other (please specify).",
        quote: "Yes\nNo\nOther (please specify):",
      }),
    ]);
    const f = out.facetInstances[0];
    assertEq(f.case.optionSet, null, "the unread Other line makes the whole option expectation untyped");
    assertEq(f.expectationGap.code, "OPTION_SET_QUOTE_LINE_UNPARSED");
    assertEq(out.coverage.byGap.OPTION_SET_QUOTE_LINE_UNPARSED, 1);
  });

  test("FIX A1 edge: a NUMERIC closure whose stated count matches the SURVIVORS still cannot close over a dropped line", async () => {
    // The numeric variant of the same hole: the statement says "exactly two", the quote
    // carries THREE lines, and the prose guard drops the third — so the stated count equals
    // the survivor count by coincidence and pre-1.5.0 sealed `exhaustive: true`. The
    // reconciliation is against the quote's FULL line accounting, not against what survived.
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({
        id: "req_twocount",
        scope: "question:Q6",
        statement: "Q6 offers exactly two answer options and no others: Yes, No.",
        quote: "Yes\nNo\nPrefer not to say. Skip to the end of the survey.",
      }),
    ]);
    assertEq(out.facetInstances[0].case.optionSet, null);
    assertEq(out.coverage.byGap.OPTION_SET_QUOTE_LINE_UNPARSED, 1);
  });

  test("FIX A1 edge: an over-long quote line (the 160-char cap) is a counted loss, not a silent one", async () => {
    // The third heuristic filter named by the finding. One sentence, no trailing colon — it
    // survives the prose guard and dies on the length cap; the loss must block closure and be
    // counted exactly like the other two.
    const long =
      "Never because " + "the current formulary restrictions in my practice setting ".repeat(3) + "prevent it";
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({
        id: "req_longline",
        scope: "question:Q4",
        statement: `Q4 offers exactly the following answer options and no others: Yes, No, ${long}.`,
        quote: `Yes\nNo\n${long}`,
      }),
    ]);
    assertEq(out.facetInstances[0].case.optionSet, null);
    assertEq(out.coverage.byGap.OPTION_SET_QUOTE_LINE_UNPARSED, 1);
  });

  test("FIX A1/NORTH STAR: a pure bracketed line is ambiguous without source-role evidence and blocks closure", async () => {
    // `[ROTATE]` may be an instruction in one authoring convention; `[None]` may be the
    // respondent-visible label in another. The display quote carries no per-line source role,
    // so syntax cannot choose between them. Pre-1.7.0 silently dropped the third line, sealed
    // an exhaustive set over [Yes, No], then accused a compliant site's `[None]` as extra.
    const mod = await worker();
    const bracketed = rowFor({
      id: "req_d45opt5",
      scope: "question:Q3",
      statement: "Q3 offers only the following answer options: Yes, No, [None].",
      quote: "Yes\nNo\n[None]",
    });
    const out = await expand(mod, [
      bracketed,
    ]);
    const f = out.facetInstances[0];
    assertEq(f.case.optionSet, null, "an ambiguous bracketed line must not disappear from a closed set");
    assertEq(f.expectationGap.code, "OPTION_SET_QUOTE_LINE_UNPARSED");
    assertEq(out.coverage.byGap.OPTION_SET_QUOTE_LINE_UNPARSED, 1);
    assertEq(out.coverage.typedCases, 0);

    const { result, row } = await verifyCase(mod, testEnv(), {
      caseId: f.facetInstanceId,
      cases: [f],
      requirements: requirementsReplacing("5", bracketed.requirement),
      steps: [
        step(
          0,
          q3Screen([
            ["1", "Yes"],
            ["2", "No"],
            ["3", "[None]"],
          ]),
        ),
      ],
    });
    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "NO_TYPED_EXPECTATION");
    assertEq(result.value.contradicted, 0, "a compliant bracket-label survey must not be accused from a silent short read");
  });

  test("FIX A1/NORTH STAR: a trailing bracket suffix is not stripped without source-role evidence", async () => {
    // `[EXCLUSIVE]` is commonly an instruction, but syntax does not make it one: a different
    // instrument may render that text as part of its label. The source adapter must establish
    // the role before removing bytes. Until then the entire case is a counted limitation.
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({
        id: "req_suffix",
        scope: "question:Q3",
        statement: "Q3 offers only the following answer options: Yes, No, None [EXCLUSIVE].",
        quote: "Yes\nNo\nNone [EXCLUSIVE]",
      }),
    ]);
    const f = out.facetInstances[0];
    assertEq(f.case.optionSet, null, "an untyped suffix must not be removed to manufacture a shorter closed set");
    assertEq(f.expectationGap.code, "OPTION_SET_QUOTE_LINE_UNPARSED");
    assertEq(out.coverage.byGap.OPTION_SET_QUOTE_LINE_UNPARSED, 1);
  });

  test("FIX A1/NORTH STAR: a semicolon with no delimiter provenance is counted, never split into options", async () => {
    // This document has ONE visible label containing punctuation. The deliberately wrong site
    // splits it into two controls. Pre-1.8.0 split the quote on `;`, sealed those two invented
    // labels, and could certify this divergent site. With no source-boundary provenance the
    // only honest result is an untyped, counted case.
    const semicolonRow = rowFor({
      id: "req_d45opt5",
      scope: "question:Q3",
      statement: "Q3 offers only the following answer options: Research; development, Other.",
      quote: "Research; development\nOther",
    });
    const mod = await worker();
    const out = await expand(mod, [semicolonRow]);
    const f = out.facetInstances[0];
    assertEq(f.case.optionSet, null, "delimiter ambiguity must not mint a split or combined label");
    assertEq(f.expectationGap.code, "OPTION_SET_QUOTE_LINE_UNPARSED");
    assertEq(out.coverage.byGap.OPTION_SET_QUOTE_LINE_UNPARSED, 1);

    const { result, row } = await verifyCase(mod, testEnv(), {
      caseId: f.facetInstanceId,
      cases: [f],
      requirements: requirementsReplacing("5", semicolonRow.requirement),
      steps: [
        step(
          0,
          q3Screen([
            ["1", "Research"],
            ["2", "development"],
            ["3", "Other"],
          ]),
        ),
      ],
    });
    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "NO_TYPED_EXPECTATION");
    assertEq(result.value.contradicted, 0);
  });

  test("FIX A1/NORTH STAR: distinct duplicate-label occurrences never collapse into one typed option", async () => {
    // Codes 1 and 2 are two source occurrences with the same visible label. The current
    // payload has no multiplicity predicate, so keeping one and dropping the other would call
    // the case typed while testing only half its source material.
    const duplicateRow = rowFor({
      id: "req_d45opt5",
      scope: "question:Q3",
      statement: "Q3 includes two answer choices labelled 'Other', with codes 1 and 2.",
      quote: "1) Other\n2) Other",
    });
    const mod = await worker();
    const out = await expand(mod, [duplicateRow]);
    const f = out.facetInstances[0];
    assertEq(f.case.optionSet, null, "distinct coded occurrences cannot be deduplicated by label alone");
    assertEq(f.expectationGap.code, "OPTION_SET_QUOTE_LINE_UNPARSED");
    assertEq(out.coverage.byGap.OPTION_SET_QUOTE_LINE_UNPARSED, 1);

    const { row } = await verifyCase(mod, testEnv(), {
      caseId: f.facetInstanceId,
      cases: [f],
      requirements: requirementsReplacing("5", duplicateRow.requirement),
      steps: [
        step(
          0,
          q3Screen([
            ["1", "Other"],
            ["2", "Other"],
          ]),
        ),
      ],
    });
    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "NO_TYPED_EXPECTATION");
  });

  test("FIX A1/NORTH STAR: Unicode letters are ordinary option labels, not ASCII-shaped punctuation", async () => {
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({
        id: "req_unicode",
        scope: "question:Q3",
        statement: "Q3 offers exactly the following three answer options and no others: はい, いいえ, わからない.",
        quote: "はい\nいいえ\nわからない",
      }),
    ]);
    const f = out.facetInstances[0];
    assertEq(f.expectationGap, null, "a non-Latin questionnaire must not lose its option vocabulary");
    assertEq(JSON.stringify(f.case.optionSet.asserted.map((o) => o.label)), JSON.stringify(["はい", "いいえ", "わからない"]));
    assertEq(f.case.optionSet.exhaustive, true);
    assertEq(f.case.optionSet.closureAssessment.status, "established");
    assertEq(f.case.optionSet.closureAssessment.code, "OPTION_SET_CLOSURE_ESTABLISHED");
    assertEq(out.coverage.typedCases, 1);
    assertEq(out.coverage.optionSetClosure.established, 1);
  });

  test("FIX A1/NORTH STAR: unproven closure has explicit computed coverage while membership stays typed", async () => {
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({
        id: "req_closure_coverage",
        scope: "question:Q3",
        quantifier: "only",
        statement: "Q3の回答選択肢は次の3つのみです：はい、いいえ、わからない。",
        quote: "はい\nいいえ\nわからない",
      }),
    ]);
    const f = out.facetInstances[0];
    assertEq(f.expectationGap, null, "positive membership remains safely typed");
    assertEq(f.case.optionSet.exhaustive, false, "unproven language-neutral closure stays conservative");
    assertEq(f.case.optionSet.closureAssessment.status, "not-evaluated");
    assertEq(f.case.optionSet.closureAssessment.code, "OPTION_SET_CLOSURE_NOT_EVALUATED");
    assert(
      f.case.optionSet.closureAssessment.detail.includes("extra-option coverage was NOT evaluated"),
      f.case.optionSet.closureAssessment.detail,
    );
    assertEq(out.coverage.optionSetClosure.cases, 1);
    assertEq(out.coverage.optionSetClosure.payloadCases, 1);
    assertEq(out.coverage.optionSetClosure.established, 0);
    assertEq(out.coverage.optionSetClosure.notEvaluated, 1);
    assertEq(out.coverage.optionSetClosure.notEstablished, 0);
    assertEq(out.coverage.optionSetClosure.unavailableBecauseCaseUntyped, 0);
    assertEq(out.coverage.optionSetClosure.byCode.OPTION_SET_CLOSURE_NOT_EVALUATED, 1);
  });

  test("FIX A1/NORTH STAR: Unicode sentence boundaries are prose, not answer labels", async () => {
    const note = "選択肢を記載順に表示します。ランダム化しないでください。";
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({ id: "req_unicode_prose", scope: "question:Q3", statement: note, quote: note }),
    ]);
    const f = out.facetInstances[0];
    assertEq(f.case.optionSet, null, "non-Latin prose must not become a respondent-visible option requirement");
    assertEq(f.expectationGap.code, "OPTION_SET_QUOTE_LINE_UNPARSED");
    assertEq(out.coverage.byGap.OPTION_SET_QUOTE_LINE_UNPARSED, 1);
  });

  test("FIX A1/NORTH STAR: a compatibility-equivalent non-ASCII colon remains an unread header shape", async () => {
    const header = "その他（具体的に）：";
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({ id: "req_unicode_colon", scope: "question:Q3", statement: header, quote: header }),
    ]);
    const f = out.facetInstances[0];
    assertEq(f.case.optionSet, null, "a full-width colon must not bypass the counted header ambiguity");
    assertEq(f.expectationGap.code, "OPTION_SET_QUOTE_LINE_UNPARSED");
    assertEq(out.coverage.byGap.OPTION_SET_QUOTE_LINE_UNPARSED, 1);
  });

  test("FIX A1/NORTH STAR: a symbol-only candidate is counted unread rather than silently shortening a set", async () => {
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({
        id: "req_symbol",
        scope: "question:Q3",
        statement: "Q3 offers only the following answer options: Yes, No, ★.",
        quote: "Yes\nNo\n★",
      }),
    ]);
    const f = out.facetInstances[0];
    assertEq(f.case.optionSet, null, "a star can be a real scale label and cannot be dropped as punctuation");
    assertEq(f.expectationGap.code, "OPTION_SET_QUOTE_LINE_UNPARSED");
    assertEq(out.coverage.byGap.OPTION_SET_QUOTE_LINE_UNPARSED, 1);
    assertEq(out.coverage.untypedCases, 1);
  });

  test("FIX A1 seam: a partial quote is untyped end-to-end and cannot accuse from its readable fragment", async () => {
    // The cardinal counterexample for the old payload+gap shape. BIMZELX is readable and the
    // walked screen omits it, so ANY leaked membership payload produces OPTION_MISSING. The
    // unread Other line makes the case untyped: it stays counted, contributes no sibling
    // authority, and the real verifier must decline rather than accuse from half a quote.
    const mod = await worker();
    const partialRow = rowFor({
      id: "req_d45opt5",
      statement: "Q3 offers exactly the following answer options and no others: BIMZELX, Other (please specify).",
      quote: "5) BIMZELX\nOther (please specify):",
    });
    const ordinaryRow = rowFor({
      id: "req_d45opt1",
      statement: "Q3 includes option 1: 'SKYRIZI'.",
      quote: "1) SKYRIZI",
    });
    const out = await expand(mod, [partialRow, ordinaryRow]);
    const partial = out.facetInstances.find((f) => f.requirementLineageId === "req_d45opt5");
    const ordinary = out.facetInstances.find((f) => f.requirementLineageId === "req_d45opt1");

    assertEq(partial.case.optionSet, null, "a case coverage calls untyped must carry no executable payload");
    assertEq(partial.expectationGap.code, "OPTION_SET_QUOTE_LINE_UNPARSED");
    assertEq(
      ordinary.case.optionSet.siblings.length,
      0,
      "readable fragments of an untyped row must not acquire verdict authority as sibling evidence",
    );
    assertEq(out.coverage.cases, 2);
    assertEq(out.coverage.typedCases, 1);
    assertEq(out.coverage.untypedCases, 1);
    assertEq(out.coverage.byGap.OPTION_SET_QUOTE_LINE_UNPARSED, 1);
    const preview = out.preview.find((entry) => entry.requirementLineageId === "req_d45opt5");
    assertEq(preview.typedCaseCount, 0);
    assertEq(preview.gaps.OPTION_SET_QUOTE_LINE_UNPARSED, 1);

    const { result, row } = await verifyCase(mod, testEnv(), {
      caseId: partial.facetInstanceId,
      cases: [partial],
      requirements: requirementsReplacing("5", partialRow.requirement),
      steps: [step(0, FLAWED_Q3())],
    });
    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "NO_TYPED_EXPECTATION");
    assertEq(result.value.contradicted, 0, "a gap-marked partial quote must mint no defect verdict");
  });

  test("FIX A3: an explicit-negative option is never positive assertion or sibling authority", async () => {
    // `OptionSetPayload.asserted` means REQUIRED PRESENT. Before this guard, a human-authored
    // explicit-negative row flowed through the generic `constrainsMatching` gate, so the
    // forbidden label became a required option. The correct screen below omits BIMZELX; the
    // old payload inverted the document and accused it of OPTION_MISSING.
    const mod = await worker();
    const negativeRow = rowFor({
      id: "req_d45opt5",
      assertionStatus: "explicit-negative",
      statement: "Q3 must not offer option 5: 'BIMZELX'.",
      quote: "5) BIMZELX",
    });
    const ordinaryRow = rowFor({
      id: "req_d45opt1",
      statement: "Q3 includes option 1: 'SKYRIZI'.",
      quote: "1) SKYRIZI",
    });
    const out = await expand(mod, [negativeRow, ordinaryRow]);
    const negative = out.facetInstances.find((f) => f.requirementLineageId === "req_d45opt5");
    const ordinary = out.facetInstances.find((f) => f.requirementLineageId === "req_d45opt1");

    assertEq(negative.case.optionSet, null, "a positive-only payload cannot represent a forbidden option");
    assertEq(negative.expectationGap.code, "OPTION_SET_NEGATIVE_PREDICATE_NOT_AVAILABLE");
    assertEq(
      ordinary.case.optionSet.siblings.length,
      0,
      "a forbidden option must not widen the documented-positive union or license a code comparison",
    );
    assertEq(out.coverage.typedCases, 1);
    assertEq(out.coverage.untypedCases, 1);
    assertEq(out.coverage.byGap.OPTION_SET_NEGATIVE_PREDICATE_NOT_AVAILABLE, 1);

    const { result, row } = await verifyCase(mod, testEnv(), {
      caseId: negative.facetInstanceId,
      cases: [negative],
      requirements: requirementsReplacing("5", negativeRow.requirement),
      steps: [step(0, FLAWED_Q3())],
    });
    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "NO_TYPED_EXPECTATION");
    assertEq(result.value.contradicted, 0, "correctly omitting a forbidden option must never be accused as missing it");
  });

  test("FIX A2 (review-extract finding 3): a DISPUTED row's options never enter a sibling inventory", async () => {
    // PINS THE PRE-FIX BUG (expander < 1.5.0): the sibling loop skipped the
    // `constrainsMatching` gate, so a row the two extraction passes DISAGREED on
    // (assertionStatus "disputed" — minting zero cases of its own since 1.3.0) still pushed
    // its options into the per-question inventory. A sealed Q3 case then carried TREMFYA in
    // `siblings`, widening the verifier's `documented` union (masking a genuinely
    // undocumented extra option as documented — silent green) and able to witness a
    // code-vocabulary licence off evidence the expander itself refused to seal. On pre-1.5.0
    // code this test FAILS: siblings.length === 1.
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({ id: "req_sibok", statement: "Q3 includes option 1: 'SKYRIZI'.", quote: "(list) 1) SKYRIZI" }),
      rowFor({
        id: "req_sibdisp",
        statement: "Q3 includes option 2: 'TREMFYA'.",
        quote: "(list) 2) TREMFYA",
        assertionStatus: "disputed",
      }),
    ]);
    assert(
      !out.facetInstances.some((f) => f.requirementLineageId === "req_sibdisp"),
      "a disputed row mints zero cases (1.3.0) — unchanged",
    );
    const ok = out.facetInstances.find((f) => f.requirementLineageId === "req_sibok");
    assertEq(
      ok.case.optionSet.siblings.length,
      0,
      `a row the expander refused to seal must not corroborate another: ${JSON.stringify(ok.case.optionSet.siblings)}`,
    );
  });

  test("FIX A2: a question-AMBIGUOUS row's options never enter a sibling inventory", async () => {
    // The same gate via the OPTION_SET_QUESTION_AMBIGUOUS refusal: a Q3-scoped row whose
    // statement also names Q5 is refused as an assertion precisely because which question
    // owns its options has two readings — yet pre-1.5.0 those options still landed in the
    // Q3 inventory and surfaced inside other rows' sealed `siblings`, able to certify an
    // undocumented Q3 option as documented. On pre-1.5.0 code this test FAILS.
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({ id: "req_q5head", scope: "question:Q5", statement: "Q5 asks about barriers.", quote: "Q5.", facet: "question" }),
      rowFor({
        id: "req_sibamb",
        scope: "question:Q3",
        statement: "The options carried forward from Q5 include 'ENBREL'.",
        quote: "(list) 9) ENBREL",
      }),
      rowFor({ id: "req_sibok2", scope: "question:Q3", statement: "Q3 includes option 1: 'SKYRIZI'.", quote: "(list) 1) SKYRIZI" }),
    ]);
    const amb = out.facetInstances.find((f) => f.requirementLineageId === "req_sibamb");
    assertEq(amb.expectationGap.code, "OPTION_SET_QUESTION_AMBIGUOUS", "the assertion-side refusal — unchanged");
    const ok = out.facetInstances.find((f) => f.requirementLineageId === "req_sibok2");
    assertEq(
      ok.case.optionSet.siblings.length,
      0,
      `a refused-as-ambiguous row's options corroborate nothing: ${JSON.stringify(ok.case.optionSet.siblings)}`,
    );
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

// ===========================================================================
// FIX C1 (respin, verifier 1.8.0) / FIX C2 (review-verdict-path findings 1-2)
//
// C1: `targetOptionGroup`'s sole-group early return handed back the only non-empty group with
//     NO attribution check, while page-script puts only radio/checkbox controls into
//     `optionGroups` — so a target rendered as a `<select>` contributed no group and INHERITED
//     an unrelated group's inventory, minting a confident OPTION_MISSING against a complete,
//     correctly-rendered dropdown. The 1.7.0 fix required name/prefix attribution
//     unconditionally — which also refused the ENTIRE branching corpus (the engine names every
//     option control "answer") and turned the product's one proven true positive into a
//     refusal. 1.8.0 narrows the boundary to a discriminator: a sole group that fails
//     attribution is accepted only when it is the screen's ONLY answerable thing beyond
//     navigation controls AND is not the "(unnamed)" merge key. Every borrowed-inventory
//     shape below still refuses — in each, something else on the screen could be the target's
//     rendering — while the engine's shape detects again.
// C2: the exhaustive extra-option arm filtered `offered` with no visible/operable test, so a
//     hidden sentinel radio was accused as an undocumented offer — the conflation the
//     membership arm explicitly refuses, 70 lines up, in the opposite direction.
// ===========================================================================
suite("D45 — FIX C1/C2: a borrowed inventory and a hidden extra are refusals, never accusations", () => {
  /** A `<select>` control bound to the target, carrying its own COMPLETE option list. */
  const selectControl = (name, options) => ({
    idx: 0,
    tag: "select",
    type: "select",
    name,
    id: name,
    code: null,
    label: Q3_WORDING,
    text: "",
    checked: null,
    value: null,
    disabled: false,
    required: false,
    visible: true,
    placeholder: null,
    maxlength: null,
    readOnly: false,
    options: options.map(([c, l], i) => ({ order: i, code: c, label: l, selected: false, disabled: false })),
  });

  const checkboxControl = (idx, name, code, label) => ({
    idx,
    tag: "input",
    type: "checkbox",
    name,
    id: `${name}-${code}`,
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

  test("FIX C1 respin: the branching engine's sole 'answer' group DETECTS the seeded defect again", async () => {
    // THE RED-ON-PRE-RESPIN PIN, superseding 1.7.0's "pin flip" test which asserted the exact
    // opposite outcome on this same shape. Byte-for-byte the branching engine's markup: flawed
    // Q3, ONE group named "answer", its own radios and nothing else answerable on the screen.
    // Under the strict 1.7.0 rule this returned insufficient/OPTION_GROUP_NOT_ATTRIBUTABLE —
    // the s4-style OPTION_MISSING true positive became a refusal across the whole corpus, the
    // product's only proven detection capability. Clause (ii) of the 1.8.0 discriminator
    // attributes it structurally: the step is already BOUND to Q3, and this group is the only
    // thing a respondent could answer Q3 with, so the inventory is Q3's whatever the markup
    // calls it. On the 1.7.0 tree this test FAILS (refusal instead of detection); the shapes
    // that must STILL refuse are pinned in the tests that follow.
    const mod = await worker();
    const engineShaped = screen(Q3_WORDING, {
      optionGroups: [group(BIOLOGICS.filter(([c]) => c !== "5").map(([c, l], i) => opt(i, c, l)), "answer")],
    });
    const { result, row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, engineShaped)],
    });
    assertEq(row.verifier.decision, "contradicted", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_MISSING");
    assertEq(result.value.contradicted, 1, "the corpus's one true positive must be a claim again");
  });

  test("FIX C1 respin: a sole '(unnamed)' group is refused — never satisfied, never violated", async () => {
    // "(unnamed)" is the page reader's MERGE KEY (`page-script.ts`: `c.name || '(unnamed)'`):
    // radios from SEVERAL unnamed questions collapse under it, so a sole "(unnamed)" group may
    // be a fusion whose inventory belongs to no single question — the only-answerable clause
    // deliberately excludes it. Review 1 flagged this shape as unpinned; both directions are
    // pinned here: a full inventory must not certify (never satisfied) and a flawed one must
    // not accuse (never violated). Controls carry `name: null`, which is what actually
    // produces the "(unnamed)" group key in a real capture.
    const mod = await worker();
    const unnamedRadio = (idx, code, label) => ({
      idx,
      tag: "input",
      type: "radio",
      name: null,
      id: `opt-${code}`,
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
    const unnamedScreen = (labels) =>
      screen(Q3_WORDING, {
        optionGroups: [group(labels.map(([c, l], i) => opt(i, c, l)), "(unnamed)")],
        controls: labels.map(([c, l], i) => unnamedRadio(i, c, l)),
      });

    const { result, row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, unnamedScreen(BIOLOGICS))],
    });
    assertEq(row.verifier.decision, "insufficient", `never satisfied: ${JSON.stringify(row.verifier)}`);
    assertEq(row.verifier.reason, "OPTION_GROUP_NOT_ATTRIBUTABLE");
    assertEq(result.value.contradicted, 0);

    const { result: result2, row: row2 } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, unnamedScreen(BIOLOGICS.filter(([c]) => c !== "5")))],
    });
    assertEq(row2.verifier.decision, "insufficient", `never violated: ${JSON.stringify(row2.verifier)}`);
    assertEq(row2.verifier.reason, "OPTION_GROUP_NOT_ATTRIBUTABLE");
    assertEq(result2.value.contradicted, 0, "a possibly-fused inventory must accuse nobody");
  });

  test("FIX C1 respin boundary: a sole 'answer' group beside an answerable text input refuses", async () => {
    // THE EDGE OF CLAUSE (ii): it fails the moment ANYTHING else answerable is on the screen.
    // The text input could be the target's rendering — Q3 rendered free-text while the group
    // belongs to some other unnamed-by-id question — so the unattributed group is no longer
    // the only candidate, and comparing it would be guessing between two. The flawed inventory
    // makes the stakes concrete: acceptance here would mint contradicted/OPTION_MISSING.
    const mod = await worker();
    const flawed = BIOLOGICS.filter(([c]) => c !== "5");
    const withTextInput = screen(Q3_WORDING, {
      optionGroups: [group(flawed.map(([c, l], i) => opt(i, c, l)), "answer")],
      controls: [
        ...flawed.map(([c, l], i) => checkboxControl(i, "answer", c, l)),
        {
          idx: flawed.length,
          tag: "input",
          type: "text",
          name: "otherq",
          id: "otherq",
          code: null,
          label: "Anything else?",
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
    const { result, row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, withTextInput)],
    });
    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_GROUP_NOT_ATTRIBUTABLE");
    assertEq(result.value.contradicted, 0, "with a second candidate rendering on screen, nobody is accused");
  });

  test("FIX C1: a target rendered as a <select> never inherits another control's inventory", async () => {
    // PINS review-verdict-path FINDING 1 (the select half). The screen renders Q3 as a
    // COMPLETE dropdown — all five biologics on the select's own options — plus one unrelated
    // consent checkbox. The select contributes no option group, so pre-1.7.0 the sole consent
    // group inherited the comparison and every asserted option "went missing": a confident
    // OPTION_MISSING against a correctly-rendered dropdown, this product's cardinal failure.
    // On pre-1.7.0 code this test FAILS (contradicted/OPTION_MISSING).
    const mod = await worker();
    const dropdown = screen(Q3_WORDING, {
      optionGroups: [group([opt(0, "1", "I consent")], "consent")],
      controls: [selectControl("Q3", BIOLOGICS), checkboxControl(1, "consent", "1", "I consent")],
    });
    const { result, row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, dropdown)],
    });
    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_SELECT_INVENTORY_NOT_ATTESTED");
    assertEq(result.value.contradicted, 0, "a complete dropdown must never be accused of missing its options");
  });

  test("FIX C1: the consent-checkbox case — a sole unrelated group beside a free-text target refuses", async () => {
    // The walked scenario without any select: Q3 is a textarea, the only option group on the
    // screen is a consent checkbox. Pre-1.7.0 the consent inventory decided Q3's case
    // (contradicted/OPTION_MISSING); the honest answer is that no inventory of Q3's was ever
    // captured to compare. On pre-1.7.0 code this test FAILS.
    const mod = await worker();
    const textWithConsent = screen(Q3_WORDING, {
      optionGroups: [group([opt(0, "1", "I consent"), opt(1, "2", "I do not consent")], "consent")],
      controls: [
        {
          idx: 0,
          tag: "textarea",
          type: "textarea",
          name: "freetext",
          id: "freetext",
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
        checkboxControl(1, "consent", "1", "I consent"),
        checkboxControl(2, "consent", "2", "I do not consent"),
      ],
    });
    const { row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, textWithConsent)],
    });
    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_GROUP_NOT_ATTRIBUTABLE");
  });

  test("FIX C1 edge: id-PREFIX attribution still binds a sole group, in both directions", async () => {
    // The boundary that moved is "no attribution at all"; the multi-group path's prefix rule
    // (`Q3_answer` -> `Q3`) now applies to the sole group too. A clean screen stays verified
    // and the seeded defect stays claimed — attribution must not have become a blanket refusal.
    const mod = await worker();
    const cleanPrefixed = screen(Q3_WORDING, {
      optionGroups: [group(BIOLOGICS.map(([c, l], i) => opt(i, c, l)), "Q3_answer")],
    });
    const { row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, cleanPrefixed)],
    });
    assertEq(row.verifier.decision, "verified", JSON.stringify(row.verifier));

    const flawedPrefixed = screen(Q3_WORDING, {
      optionGroups: [group(BIOLOGICS.filter(([c]) => c !== "5").map(([c, l], i) => opt(i, c, l)), "Q3_answer")],
    });
    const { row: row2 } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, flawedPrefixed)],
    });
    assertEq(row2.verifier.decision, "contradicted", JSON.stringify(row2.verifier));
    assertEq(row2.verifier.reason, "OPTION_MISSING");
  });

  test("FIX C1 edge: a select bound to ANOTHER question does not block an attributed group", async () => {
    // The select refusal is scoped to selects the target is BOUND to — an unrelated dropdown
    // (a country picker) beside an attributed Q3 group must not widen the refusal, or the fix
    // would silently delete the predicate's yield on ordinary mixed screens.
    const mod = await worker();
    const mixed = screen(Q3_WORDING, {
      optionGroups: [group(BIOLOGICS.filter(([c]) => c !== "5").map(([c, l], i) => opt(i, c, l)), "Q3")],
      controls: [
        selectControl("country", [["uk", "United Kingdom"], ["fr", "France"]]),
        ...BIOLOGICS.filter(([c]) => c !== "5").map(([c, l], i) => checkboxControl(i + 1, "Q3", c, l)),
      ],
    });
    const { row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, mixed)],
    });
    assertEq(row.verifier.decision, "contradicted", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_MISSING");
  });

  test("FIX C2: a hidden 'no answer' sentinel with an empty label is not an undocumented offer", async () => {
    // PINS review-verdict-path FINDING 2. LimeSurvey/SurveyJS emit a hidden empty-value radio
    // in every group; its label reads as "" and it is neither visible nor operable. The
    // document closes Q3's set at five, all five match exactly — and pre-1.7.0 the sentinel
    // fell through the extra filter (no visible/operable test) into a contradicted
    // OPTION_OFFERED_NOT_DOCUMENTED literally quoting "": an accusation about an option no
    // respondent can see or reach. On pre-1.7.0 code this test FAILS.
    const mod = await worker();
    const withSentinel = q3Screen(BIOLOGICS);
    withSentinel.optionGroups[0].options.push(opt(5, "", "", { visible: false, operable: false }));
    const closed = { asserted: BIOLOGICS.map(([c, l]) => documented(c, l)), siblings: [], exhaustive: true };
    const { result, row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_closed",
      cases: [facet("fi_d45_closed", { target: "Q3", kind: "option-set", lineage: "req_d45opt1", optionSet: closed })],
      steps: [step(0, withSentinel)],
    });
    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_PRESENT_BUT_NOT_OPERABLE_EXTRA");
    assertEq(result.value.contradicted, 0, "a hidden sentinel must accuse nobody");
  });

  test("FIX C2: a display:none alternate-layout option is not an undocumented offer either", async () => {
    // The other real shape: a mobile/alternate layout the media query switched off, whose
    // wording is genuinely dissimilar to every documented label (so the near-variant absorber
    // cannot catch it). `visible: false` alone must already withhold — operability is a
    // separate fact and either failing reading kills the claim "offered to the respondent".
    const mod = await worker();
    const withAlternate = q3Screen(BIOLOGICS);
    withAlternate.optionGroups[0].options.push(opt(5, "99", "None of the above", { visible: false, operable: true }));
    const closed = { asserted: BIOLOGICS.map(([c, l]) => documented(c, l)), siblings: [], exhaustive: true };
    const { row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_closed",
      cases: [facet("fi_d45_closed", { target: "Q3", kind: "option-set", lineage: "req_d45opt1", optionSet: closed })],
      steps: [step(0, withAlternate)],
    });
    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_PRESENT_BUT_NOT_OPERABLE_EXTRA");
  });

  test("FIX C2 edge: a genuinely offered extra still accuses, and quotes only what is reachable", async () => {
    // The fail-silent counterweight, and the boundary of the moved line: ENBREL is visible AND
    // operable, so the accusation stands — but the hidden sentinel beside it must not be
    // quoted as evidence. On pre-1.7.0 code this test FAILS: the detail quoted "" as an
    // undocumented offer alongside ENBREL.
    // 1.8.1 re-anchor: the group is named "Q3" because the offered-extra ACCUSATION now needs
    // clause (i) attribution; the offered-vs-present split this test pins is unchanged.
    const mod = await worker();
    const withBoth = screen(Q3_WORDING, {
      optionGroups: [group([...BIOLOGICS, ["9", "ENBREL"]].map(([c, l], i) => opt(i, c, l)), "Q3")],
    });
    withBoth.optionGroups[0].options.push(opt(6, "", "", { visible: false, operable: false }));
    const closed = { asserted: BIOLOGICS.map(([c, l]) => documented(c, l)), siblings: [], exhaustive: true };
    const { row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_closed",
      cases: [facet("fi_d45_closed", { target: "Q3", kind: "option-set", lineage: "req_d45opt1", optionSet: closed })],
      steps: [step(0, withBoth)],
    });
    assertEq(row.verifier.decision, "contradicted", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_OFFERED_NOT_DOCUMENTED");
    assert(/ENBREL/.test(row.verifier.detail), row.verifier.detail);
    assert(!row.verifier.detail.includes('""'), `the hidden sentinel must not be quoted as an offer: ${row.verifier.detail}`);
  });
});

// ===========================================================================
suite("D45 — 1.9.0: a word-shaped capture is not a count clause (owner-approved softening)", () => {
  /**
   * THE SEAM THIS PINS. `assessClosedSet`'s count-clause recognizer captures a token where it
   * expects a number, and the most canonical closure phrasings in the domain put an ordinary
   * WORD there: "exactly the following ANSWER options and no others" captures "answer", the
   * NUMBER_WORD lookup fails, and pre-1.9.0 `countAgrees` read that as a count disagreement —
   * so closure was refused as OPTION_SET_CLOSURE_EVIDENCE_INCOMPLETE on exactly the sentences
   * that close a set most explicitly, and the extra-option arm never opened on those questions.
   *
   * THE OWNER-APPROVED RULE (11 Aug): a word-shaped capture that is not a number word is NOT a
   * count clause — the phrase states closure with NO stated count. A real numeral or number
   * word that disagrees with the parsed option count still refuses, unchanged, and every other
   * 1.8.0 conjunct (full-line accounting, statement corroboration, entailed-only, parsed >= 2)
   * is byte-untouched. The last test below is the load-bearing edge: the softening must not
   * reopen the full-line unparsed-line guard.
   */
  const rowFor = (over) => ({
    requirement: {
      requirementLineageId: over.id ?? "req_v19_01",
      requirementVersionId: (over.id ?? "req_v19_01").replace("req_", "reqv_"),
      semanticFingerprint: "fp_v19",
      scope: over.scope ?? "question:Q3",
      quantifier: over.quantifier ?? "specific",
      selector: null,
      exceptions: [],
      facet: over.facet ?? "option-list",
      assertionStatus: over.assertionStatus ?? "entailed",
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

  test("SOFTENED 1.9.0: 'exactly the following answer options and no others' closes a fully-parsed corroborated set", async () => {
    // RED ON PRE-1.9.0 CODE: the capture grabs "answer", NUMBER_WORD misses, countAgrees is
    // false, and this — the domain's most canonical closure sentence — never seals exhaustive.
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({
        id: "req_v19_word_exact",
        scope: "question:Q3",
        statement: "Q3 offers exactly the following answer options and no others: SKYRIZI, TREMFYA, COSENTYX.",
        quote: "SKYRIZI\nTREMFYA\nCOSENTYX",
      }),
    ]);
    const f = out.facetInstances[0];
    assertEq(f.expectationGap, null, "a fully-parsed corroborated quote must stay typed");
    assertEq(f.case.optionSet.asserted.length, 3);
    assertEq(
      f.case.optionSet.exhaustive,
      true,
      "'answer' is a word, not a count clause — the phrase closes the set with no stated count",
    );
    assertEq(f.case.optionSet.closureAssessment.status, "established");
    assertEq(f.case.optionSet.closureAssessment.code, "OPTION_SET_CLOSURE_ESTABLISHED");
    assert(
      !f.case.optionSet.closureAssessment.detail.includes("stated count is"),
      `no count was stated, so none may be attested: ${f.case.optionSet.closureAssessment.detail}`,
    );
    assertEq(out.coverage.optionSetClosure.established, 1);
  });

  test("SOFTENED 1.9.0: 'only the following answer options' closes a fully-parsed corroborated set", async () => {
    // RED ON PRE-1.9.0 CODE: same seam via the other canonical phrasing — "following answer
    // options" captures "answer" and the closure was refused despite a complete, corroborated
    // quote.
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({
        id: "req_v19_word_only",
        scope: "question:Q3",
        statement: "Q3 offers only the following answer options: SKYRIZI, TREMFYA.",
        quote: "SKYRIZI\nTREMFYA",
      }),
    ]);
    const f = out.facetInstances[0];
    assertEq(f.expectationGap, null);
    assertEq(f.case.optionSet.asserted.length, 2);
    assertEq(f.case.optionSet.exhaustive, true, "'only the following' closes the set; 'answer' states no count");
    assertEq(f.case.optionSet.closureAssessment.status, "established");
    assertEq(f.case.optionSet.closureAssessment.code, "OPTION_SET_CLOSURE_ESTABLISHED");
  });

  test("UNCHANGED 1.9.0: a stated count that DISAGREES with the parsed options still refuses closure", async () => {
    // The refusal the softening must NOT weaken: "exactly five" RESOLVES to a number, the
    // quote bears out four, and a closed set over a fragment licenses an extra-option
    // accusation against a compliant site.
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({
        id: "req_v19_five_four",
        scope: "question:Q5",
        statement: "Q5 offers exactly five options and no others: Red, Green, Blue, Yellow.",
        quote: "Red\nGreen\nBlue\nYellow",
      }),
    ]);
    const f = out.facetInstances[0];
    assertEq(f.expectationGap, null, "membership stays typed; it is the CLOSURE that is refused");
    assertEq(f.case.optionSet.asserted.length, 4);
    assertEq(f.case.optionSet.exhaustive, false, "a resolved count of five over four parsed options never closes a set");
    assertEq(f.case.optionSet.closureAssessment.status, "not-established");
    assertEq(f.case.optionSet.closureAssessment.code, "OPTION_SET_CLOSURE_EVIDENCE_INCOMPLETE");
    assert(
      f.case.optionSet.closureAssessment.detail.includes("statedCount=5"),
      f.case.optionSet.closureAssessment.detail,
    );
    assertEq(out.coverage.optionSetClosure.notEstablished, 1);
  });

  test("UNCHANGED 1.9.0: a stated count the parsed options bear out still closes the set", async () => {
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({
        id: "req_v19_five_five",
        scope: "question:Q5",
        statement: "Q5 offers exactly five options and no others: Red, Green, Blue, Yellow, Purple.",
        quote: "Red\nGreen\nBlue\nYellow\nPurple",
      }),
    ]);
    const f = out.facetInstances[0];
    assertEq(f.expectationGap, null);
    assertEq(f.case.optionSet.asserted.length, 5);
    assertEq(f.case.optionSet.exhaustive, true);
    assertEq(f.case.optionSet.closureAssessment.status, "established");
    assert(
      f.case.optionSet.closureAssessment.detail.includes("its stated count is 5"),
      f.case.optionSet.closureAssessment.detail,
    );
  });

  test("LOAD-BEARING EDGE 1.9.0: a word-shape closure over a DROPPED quote line still refuses via the unparsed-line gap", async () => {
    // The conjunct the softening must not reopen. "Other (please specify):" dies on the
    // header guard, so one candidate line of the quote was never read — and a closure phrase
    // that now sails past the count clause must STILL refuse on full-line accounting, or the
    // softening would seal exhaustive over a set the document lists one option longer.
    const mod = await worker();
    const out = await expand(mod, [
      rowFor({
        id: "req_v19_dropped",
        scope: "question:Q9",
        statement: "Q9 offers only the following answer options: Yes, No, Other (please specify).",
        quote: "Yes\nNo\nOther (please specify):",
      }),
    ]);
    const f = out.facetInstances[0];
    assertEq(f.case.optionSet, null, "an unread candidate line must keep the whole option expectation untyped");
    assertEq(f.expectationGap.code, "OPTION_SET_QUOTE_LINE_UNPARSED");
    assertEq(out.coverage.byGap.OPTION_SET_QUOTE_LINE_UNPARSED, 1);
    assertEq(out.coverage.typedCases, 0, "the softened count clause must not make a gap-marked case decidable");
  });
});

// ===========================================================================
// 1.8.1 (Codex review BLOCKER 1) — A NAME-FUSED GROUP LICENSES NO EXTRA ACCUSATION.
//
// THE COUNTEREXAMPLE. `page-script.ts` merges every radio/checkbox into a group by NAME
// ALONE (`c.name || '(unnamed)'`), so a target checkbox question and a consent question that
// both emit `name="answer"` arrive here as ONE fused group. Clause (ii) of the 1.8.0
// discriminator accepted that sole group — its exclusions assumed a second question's
// radios "would have created a SECOND group", which is false exactly when names collide —
// and an exhaustive target then accused the fused-in consent option as
// OPTION_OFFERED_NOT_DOCUMENTED: a confident false accusation about a healthy survey, the
// product's cardinal failure.
//
// THE 1.8.1 RULE. Acceptance now carries its OWN provenance: clause (i) (name/id-prefix)
// keeps the full extra arm; clause (ii) (only-answerable) does NOT license it — a fused
// group is indistinguishable from a single question there, and an "extra" option may simply
// belong to the other fused question, so the offered-extra arm demotes to a named
// insufficient (OPTION_EXTRA_UNATTRIBUTED_GROUP). The MEMBERSHIP arms are deliberately
// unchanged: fusion only ADDS options to the group, so a documented option absent from the
// fused superset is absent from the target's rendering too — OPTION_MISSING stays sound,
// and the corpus's one proven detection stays a claim.
//
// `tools/mutate-option-set.mjs` re-licenses the extra arm under clause (ii); the first test
// below is the one that kills it.
// ===========================================================================
suite("D45 — 1.8.1: a name-fused group licenses no EXTRA accusation (Codex review BLOCKER 1)", () => {
  /** The closed exhaustive payload: the document lists all five biologics and no others. */
  const closedSet = () => ({
    asserted: BIOLOGICS.map(([c, l]) => documented(c, l)),
    siblings: [],
    exhaustive: true,
  });
  const closedCase = () => [
    facet("fi_d45_closed", { target: "Q3", kind: "option-set", lineage: "req_d45opt1", optionSet: closedSet() }),
  ];
  /** The fused-in consent option: shares no token with any documented label, visible, operable. */
  const CONSENT_LABEL = "I agree to take part in this study";

  test("FIX 1.8.1: a fused target+consent group under one name never mints the extra-option accusation", async () => {
    // RED ON PRE-1.8.1 CODE: contradicted/OPTION_OFFERED_NOT_DOCUMENTED, quoting the consent
    // option as an undocumented offer of Q3. The screen is byte-shaped as page-script fuses
    // it: Q3's five checkboxes AND the consent checkbox all emit name="answer", so the reader
    // merges them into ONE group and nothing else on the screen is answerable — clause (ii)
    // accepts, correctly, because the membership comparison is still sound on the superset.
    // The EXTRA arm is what may not fire: the consent option is beyond the document's closed
    // set for Q3, but it may simply belong to the other fused question.
    const mod = await worker();
    const fused = screen(Q3_WORDING, {
      optionGroups: [
        group([...BIOLOGICS.map(([c, l], i) => opt(i, c, l)), opt(5, "1", CONSENT_LABEL)], "answer"),
      ],
    });
    const { result, row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_closed",
      cases: closedCase(),
      steps: [step(0, fused)],
    });
    assertEq(row.verifier.decision, "insufficient", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_EXTRA_UNATTRIBUTED_GROUP");
    assert(
      row.verifier.detail.includes(CONSENT_LABEL),
      `the refusal must name the option it declines to accuse: ${row.verifier.detail}`,
    );
    assertEq(result.value.contradicted, 0, "a fused-in option must accuse nobody");
  });

  test("UNCHANGED 1.8.1: the s4-style OPTION_MISSING through clause (ii) still detects — plain and fused", async () => {
    // The detection the gate must not cost, in BOTH shapes. Plain: the branching engine's
    // flawed Q3 (BIMZELX dropped) under the sole "answer" group. Fused: the same flawed
    // inventory WITH the consent option fused in — fusion only ADDS options, so the
    // documented option absent from the superset is absent from Q3, period, and the
    // membership arm proceeds under clause (ii) exactly as before.
    const mod = await worker();
    const flawedPlain = screen(Q3_WORDING, {
      optionGroups: [group(BIOLOGICS.filter(([c]) => c !== "5").map(([c, l], i) => opt(i, c, l)), "answer")],
    });
    const { result, row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, flawedPlain)],
    });
    assertEq(row.verifier.decision, "contradicted", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_MISSING");
    assertEq(result.value.contradicted, 1, "the corpus's one true positive must remain a claim");

    const flawedFused = screen(Q3_WORDING, {
      optionGroups: [
        group(
          [...BIOLOGICS.filter(([c]) => c !== "5").map(([c, l], i) => opt(i, c, l)), opt(4, "1", CONSENT_LABEL)],
          "answer",
        ),
      ],
    });
    const { result: result2, row: row2 } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_bimzelx",
      cases: bimzelxCase(),
      steps: [step(0, flawedFused)],
    });
    assertEq(row2.verifier.decision, "contradicted", JSON.stringify(row2.verifier));
    assertEq(row2.verifier.reason, "OPTION_MISSING");
    assertEq(result2.value.contradicted, 1, "fusion only ADDS options; an absent documented option is still absent");
  });

  test("UNCHANGED 1.8.1: a name-attributed group with a real extra still accuses", async () => {
    // Clause (i) keeps the full extra arm: when the group NAMES the target, the inventory is
    // the target's by the markup's own word, an extra is the target's extra, and the closed
    // set the document states is violated. The gate must move clause (ii) only.
    const mod = await worker();
    const attributedExtra = screen(Q3_WORDING, {
      optionGroups: [group([...BIOLOGICS.map(([c, l], i) => opt(i, c, l)), opt(5, "9", "ENBREL")], "Q3")],
    });
    const { result, row } = await verifyCase(mod, testEnv(), {
      caseId: "fi_d45_closed",
      cases: closedCase(),
      steps: [step(0, attributedExtra)],
    });
    assertEq(row.verifier.decision, "contradicted", JSON.stringify(row.verifier));
    assertEq(row.verifier.reason, "OPTION_OFFERED_NOT_DOCUMENTED");
    assert(/ENBREL/.test(row.verifier.detail), row.verifier.detail);
    assertEq(result.value.contradicted, 1);
  });
});

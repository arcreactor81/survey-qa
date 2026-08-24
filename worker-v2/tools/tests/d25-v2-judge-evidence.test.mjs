/**
 * D25 — THE JUDGE COULD NOT READ A SINGLE BYTE OF v2 EVIDENCE.
 *
 * ============================== THE DEFECT ==============================
 *
 * Two independent stops, either of which alone empties the report's authoritative column.
 *
 * STOP A — THE MANIFEST COLLIDES. `pipeline/judge/lib/authority.mjs` keys the SIGNED evidence
 * catalogue by `basename(artifactRef)`, and every walk wrote
 * `observations/<pathId>/observation.json`. Every walk after the first therefore raised
 * MANIFEST_DUPLICATE_ARTIFACT, which clears `manifestComplete`, which clears `verified` — and
 * an unverified authority is diagnostic-only, so NO JudgementRecord was minted at all. The
 * mount overwrote the files into the bargain: N walks landed on disk as one.
 *
 * STOP B — THE SHAPE. A `PathObservation` has `steps[]`; every module in the judge reads
 * `evidence[]` of `{seq, screen_id, option_inventory}`. `captureSpineState` therefore refused
 * to promote it, `isSessionArtifact` refused it, and `loadSessions`'s quarantine branch tests
 * the SAME field — so the artifact was dropped in SILENCE, not even reported as quarantined.
 * Zero sessions in, `no-observation` out, every row `not-assessed`.
 *
 * ============================ WHAT THESE TESTS ASSERT ============================
 *
 * PROJECTION (7) — a PathObservation reads as a capture spine, and the three shapes that would
 * INVENT a route are refused: a blocked step, a failed action, and a walk whose own
 * `screenAfterAdvance` disagrees with the next step's screen. A v1 artifact is untouched.
 *
 * COLLISION (3) — the producer emits unique basenames now; a colliding catalogue is REFUSED by
 * `loadArtifactBytes` and by the mount loop rather than silently overwritten, and
 * `mintJudgement` reports it as a named non-evaluation instead of judging a smaller evidence
 * set without saying so.
 *
 * END TO END (4) — THE BAR. A real v2 run: sealed contract, walks captured by the REAL
 * `capturePathObservation`, a RunRecordV2 assembled and signed by the REAL assembler, judged by
 * the REAL `mintJudgement`, published by the REAL report path. The assertion is a NON-ZERO
 * ASSESSED ROW COUNT — `pass` or `fail`, because `inconclusive` and `not-assessed` are what a
 * broken run already produced. Against the code before this change every one of these returns
 * zero.
 *
 * WHY THE LAST ONE READS PER-ROW CELL STATES OUT OF THE PUBLISHED BYTES: `hasCurrentResults` is
 * TRUE for an attested, run-bound judgement whose every row is `not-assessed`. Measured, not
 * assumed — with the projection disabled this run still publishes `hasCurrentResults: true`,
 * `derivedVerdicts: true` and a populated `re-derived` column over two `NOT_REACHED` rows. A
 * summary flag was never going to be the discriminating fact.
 *
 * WHAT THESE TESTS DELIBERATELY DO NOT COVER: a ROUTE obligation end to end. When they were
 * written nothing could make one pass — `R-ROUTE-1` gated on the signed item type
 * `branch-outcome` and every v2 revision spells that facet `routing` — so the fixture uses
 * `option-set` and the gap was named rather than papered over.
 *
 * THAT GAP IS NOW CLOSED, and deliberately NOT by changing this file. `d26-routing-facet.test.mjs`
 * carries the route arms end to end (pass and fail) against the same real chain; the compiler
 * learned the v2 facet vocabulary through `pipeline/judge/lib/facet-vocab.mjs`. These tests keep
 * their `option-set` fixture on purpose: it is the shape that proved the EVIDENCE stops, and
 * re-pointing it at routing would lose that coverage. See
 * `worker-v2/docs/judge-evidence-gap-notes.md` §7a and `worker-v2/docs/routing-facet-notes.md`.
 */

import { createHash } from "node:crypto";

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { FIXTURE_KEY, TARGET_BUILD_ID, passingGates } from "../fixtures/v2-fixture.mjs";
import { projectPathObservation, isV2PathObservation, screenIdOf } from "../../../pipeline/judge/lib/v2-observation.mjs";
// buildTrustStatements is imported through the esbuild bundle (mod.reportRender) so that
// the mutation harness can apply rewrites to publication.mjs via esbuild's load step.
// A direct import from the pipeline file would bypass the mutant plugin.

const enc = new TextEncoder();
const sha256 = (s) => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;

// ---------------------------------------------------------------------------
// A SURVEY THAT PRINTS NO QUESTION IDS — like the instrument under test.
// Identity lives in the control attributes (D24's finding); the prose never
// names a question, so nothing here can bind by reading text.
// ---------------------------------------------------------------------------

const control = (idx, { name, id, code, label, type = "radio" }) => ({
  idx,
  tag: "input",
  type,
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
 * A RenderedScreen as `browser/page-script.ts` records one: `controls` AND `optionGroups`,
 * because the two carry different facts — identity is in the control attributes, the complete
 * positive inventory is in the groups, and the judge needs both.
 */
function questionScreen(q, prose, options) {
  const controls = options.map((o, i) => control(i, { name: q, id: `${q}_${o.code}`, code: o.code, label: o.label }));
  return {
    at: "2026-08-08T00:05:00.000Z",
    url: "https://fixture.invalid/survey",
    title: null,
    collectedErrors: [],
    questionText: prose,
    instructionText: null,
    visibleText: prose,
    visibleTextTruncated: false,
    bracketedInstructionsVisible: [],
    controls,
    optionGroups: [
      {
        name: q,
        kind: "radio",
        options: options.map((o, i) => ({
          order: i,
          idx: i,
          code: o.code,
          label: o.label,
          checked: false,
          disabled: false,
          visible: true,
        })),
      },
    ],
    grid: null,
    buttons: [
      { idx: 90, label: "Back", role: "back", disabled: false, visible: true },
      { idx: 99, label: "Next", role: "next", disabled: false, visible: true },
    ],
    progress: { present: true, kind: "bar", now: options.length, max: 10, text: null },
    validationMessages: [],
    counts: { controls: controls.length, optionGroups: 1, options: options.length, textInputs: 0 },
    screenSignature: `sig:${q}`,
  };
}

/** A screen with no controls at all — the survey's closing page. */
const plainScreen = (prose) => ({
  ...questionScreen("NONE", prose, []),
  controls: [],
  optionGroups: [],
  counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0 },
  screenSignature: `sig:${prose}`,
});

const Q1_OPTIONS = [
  { code: "1", label: "A watering can" },
  { code: "2", label: "The kitchen tap" },
];
const Q2_OPTIONS = [
  { code: "1", label: "Yes" },
  { code: "2", label: "No" },
];

const Q1 = () => questionScreen("Q1", "How do you usually water your houseplants?", Q1_OPTIONS);
const Q2 = () => questionScreen("Q2", "Do you keep plants in more than one room?", Q2_OPTIONS);
const CLOSING = () => plainScreen("Thank you for taking part.");

const step = (index, before, extra = {}) => ({
  stepIndex: index,
  decisionQuestion: "WRONG-ON-PURPOSE",
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
  wallMs: 1000,
  ...extra,
});

const clickStep = (index, before, after, { code = "1", label = "A watering can", ok = true, advanced = true, blocked = false } = {}) =>
  step(index, before, {
    requested: { select: [label], textEntry: null, action: null },
    screenAfterAdvance: after,
    actions: [
      { kind: "click-option", targetIdx: 0, targetLabel: label, targetCode: code, value: null, ok, detail: null },
      { kind: "click-next", targetIdx: 99, targetLabel: "Next", targetCode: null, value: null, ok: true, detail: null },
    ],
    advanced,
    blocked,
  });

const walk = (runId, pathId, steps) => ({
  kind: "v2-path-observation/1.0.0",
  runId,
  pathId,
  tier: 1,
  attemptId: "att_d25test01",
  planRevisionId: "plan_d25test01",
  surveyUrl: "https://fixture.invalid/survey",
  startedAt: "2026-08-08T00:04:00.000Z",
  endedAt: "2026-08-08T00:05:00.000Z",
  wallMs: 60000,
  plannedWitnesses: [],
  steps,
  outcome: "completed",
  outcomeDetail: null,
  shimmed: false,
  shimNote: null,
  loadFailure: null,
  evidenceIds: [],
  viewport: { width: 1280, height: 900 },
});

/** The straight walk: Q1 answered, Q2 answered, closing screen reached. */
const straightWalk = (runId, pathId) =>
  walk(runId, pathId, [
    clickStep(0, Q1(), Q2()),
    clickStep(1, Q2(), CLOSING(), { label: "Yes" }),
  ]);

const VOCAB = ["Q1", "Q2"];

// ===========================================================================
suite("D25 — a v2 PathObservation reads as a capture spine", () => {
  test("THE SHAPE STOP: a PathObservation projects to evidence[] with a gap-free spine", () => {
    const doc = projectPathObservation(straightWalk("r1", "FLOOR-01"), { screenIdVocabulary: VOCAB });

    assert(Array.isArray(doc.evidence) && doc.evidence.length > 0, "the projection must produce an evidence spine");
    // Two answered steps plus the terminal screen the last step advanced to.
    assertEq(doc.evidence.length, 3, "spine length");
    assertEq(
      doc.evidence.map((e) => e.seq).join(","),
      "1,2,3",
      "seq must be unique, ordered and CONSECUTIVE or captureSpineState quarantines the session",
    );
    assertEq(doc.evidence[0].screen_id, "Q1", "screen identity comes from the control attributes");
    assertEq(doc.evidence[1].screen_id, "Q2", "screen identity comes from the control attributes");
    assertEq(doc.evidence[0].option_inventory.length, 2, "the complete positive inventory is carried across");
    assertEq(doc.evidence[0].option_inventory[0].value, "1", "option CODE is preserved — it is the identity");
    assertEq(doc.evidence[0].controls_state.next.text, "Next", "controls_state is what several predicates read");
    assertEq(doc.evidence[0].controls_state.progress.now, "2", "screenRanks orders screens by progress.now");
  });

  test("a step's action becomes a trace entry the route table can build an edge from", () => {
    const doc = projectPathObservation(straightWalk("r1", "FLOOR-01"), { screenIdVocabulary: VOCAB });
    assertEq(doc.trace.length, 2, "one applied action per ADVANCING step");
    assertEq(doc.trace[0].screen, "Q1", "the trace screen must equal the capture's screen_id or sessions.mjs discards it");
    assertEq(doc.trace[0].applied.clicked[0].label, "A watering can");
    assertEq(doc.trace[0].applied.clicked[0].alias_used, "1", "the code travels as the alias so corroboration can use either");
  });

  test("THE FALSE-FAIL GUARD: a BLOCKED step authors no action, so it cannot become a Q1 -> Q1 edge", () => {
    const w = walk("r1", "FLOOR-01", [
      clickStep(0, Q1(), null, { advanced: false, blocked: true }),
      clickStep(1, Q1(), Q2()),
    ]);
    const doc = projectPathObservation(w, { screenIdVocabulary: VOCAB });
    assertEq(doc.trace.length, 1, "only the step that actually advanced may author an action");
    assertEq(doc.trace[0].seq, 2, "and it is the second capture, not the blocked one");
  });

  test("an action the driver FAILED to perform is not a click that happened", () => {
    const w = walk("r1", "FLOOR-01", [clickStep(0, Q1(), Q2(), { ok: false })]);
    const doc = projectPathObservation(w, { screenIdVocabulary: VOCAB });
    assertEq(doc.trace.length, 0, "an ok:false action must author nothing");
  });

  test("a walk whose own screenAfterAdvance disagrees with the next step is ANNOTATED, not trusted", () => {
    // The step says it landed on the closing screen; the next capture is Q2. One of the two is
    // wrong and the projection cannot tell which, so the capture is annotated and
    // route-table.mjs skips the edge instead of authoring `Q1 -> Q2` on a disagreement.
    const w = walk("r1", "FLOOR-01", [clickStep(0, Q1(), CLOSING()), clickStep(1, Q2(), CLOSING(), { label: "Yes" })]);
    const doc = projectPathObservation(w, { screenIdVocabulary: VOCAB });
    assert(doc.evidence[1].action_taken !== null, "the disagreeing capture must carry an annotation");
  });

  test("a screen that presents TWO sealed ids identifies as neither", () => {
    const piped = Q1();
    // The markup says Q1; the prose pipes Q2. At most one is its identity.
    piped.visibleText = "As you said in Q2, you keep plants in more than one room.";
    piped.questionText = piped.visibleText;
    const id = screenIdOf(piped, VOCAB);
    assert(id.startsWith("SIG-"), `two sealed ids must fall back to a signature token, got ${id}`);
    assert(id !== "Q1" && id !== "Q2", "and it must not silently pick one");
  });

  test("a v1 harness artifact is NOT a PathObservation and is left exactly as it is", () => {
    const v1 = { id: "EXP-01", evidence: [{ seq: 1, screen_id: "Q1", option_inventory: [] }], trace: [] };
    assertEq(isV2PathObservation(v1), false, "shape AND kind, never one alone");
    assertEq(isV2PathObservation({ kind: "v2-path-observation/1.0.0" }), false, "kind without steps[] is not one either");
    assertEq(isV2PathObservation(straightWalk("r", "p")), true);
  });
});

// ===========================================================================
suite("D25 — colliding artifact names are refused, never silently overwritten", () => {
  test("THE MANIFEST STOP: two walks no longer collapse onto one basename", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();

    for (const pathId of ["FLOOR-01", "FLOOR-02"]) {
      await mod.capture.capturePathObservation(
        { env, runId, attemptId: "att_d25test01", pathId, witnesses: [] },
        straightWalk(runId, pathId),
      );
    }

    const catalog = await mod.evidence.listCatalog(env, runId);
    assertEq(catalog.length, 2, "two walks, two catalogue entries");
    const basenames = new Set(catalog.map((e) => String(e.artifactRef).split("/").pop()));
    assertEq(basenames.size, 2, `both walks must mount under distinct names, got ${[...basenames].join(", ")}`);

    // And the whole set survives the flattening the judge mount uses.
    const { artifacts } = await mod.runInputs.loadArtifactBytes(env, catalog);
    assertEq(artifacts.length, 2);
    assertEq(new Set(artifacts.map((a) => a.name)).size, 2, "no walk may overwrite another on the mount");
  });

  test("a catalogue that DOES collide is refused by name, not judged smaller in silence", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();

    // The pre-fix artifactRef, written directly: two walks, one basename.
    const entries = [];
    for (const pathId of ["FLOOR-01", "FLOOR-02"]) {
      entries.push(
        await mod.evidence.putEvidence(env, {
          runId,
          bytes: enc.encode(JSON.stringify(straightWalk(runId, pathId))),
          mediaType: "application/json",
          type: "state",
          attemptId: "att_d25test01",
          routeId: pathId,
          witnesses: [],
          sourceEvidenceId: `EV-${pathId}-observation`,
          artifactRef: `observations/${pathId}/observation.json`,
        }),
      );
    }

    // Two DIFFERENT walks sharing a basename is a TRUE collision — different artifactRefs,
    // same basename. The refusal must fire even after the deduplicate pass, because these
    // entries differ in content (different pathId -> different walk bytes -> different hash).
    let threw = null;
    try {
      await mod.runInputs.loadArtifactBytes(env, entries);
    } catch (err) {
      threw = err;
    }
    assert(threw !== null, "a colliding catalogue must be refused, not flattened");
    assertEq(threw.name, "ArtifactNameCollision");
    assert(
      String(threw.message).includes("observation.json"),
      "the refusal must name the artifact that collides",
    );
  });

  test("mintJudgement reports the collision as a named non-evaluation", async () => {
    const mod = await worker();
    // The full chain, so the judge is reached with a real record in place and the collision is
    // the ONLY thing that stops it. Anything less would pass for the wrong reason.
    const { minted } = await runThroughJudge(mod, signingEnv(), { collide: true });
    assertEq(minted.state, "not-evaluated", "a run whose evidence names collide cannot be judged honestly");
    assertEq(minted.reason, "EVIDENCE_NAME_COLLISION");
    assert(
      String(minted.detail).includes("observation.json"),
      "the non-evaluation must name the artifact, so the report says WHICH evidence was ambiguous",
    );
  });
});

// ===========================================================================
suite("D25 — identical duplicate catalogue entries are collapsed, not refused", () => {
  test("identical duplicates (same ref + same hash) are collapsed and the judgement proceeds", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();

    const walkBytes = enc.encode(JSON.stringify(straightWalk(runId, "FLOOR-01")));
    // Write the entry once via the real store (write-once, so the second putEvidence with
    // identical content returns the existing entry rather than writing a new R2 key).
    const entry = await mod.evidence.putEvidence(env, {
      runId,
      bytes: walkBytes,
      mediaType: "application/json",
      type: "state",
      attemptId: "att_d25dedup",
      routeId: "FLOOR-01",
      witnesses: [],
      sourceEvidenceId: "EV-FLOOR-01-observation",
      artifactRef: "observations/FLOOR-01/FLOOR-01-step-035-recovery.pdf",
    });

    // Simulate the retried-step duplicate: the catalogue array carries the SAME entry twice.
    const catalogWithDupes = [entry, entry, entry];

    const { artifacts, duplicatesCollapsed } = await mod.runInputs.loadArtifactBytes(env, catalogWithDupes);
    assertEq(artifacts.length, 1, "three identical entries must collapse to one artifact");
    assertEq(duplicatesCollapsed, 2, "two of the three entries were duplicates");
  });

  test("a TRUE collision (same basename, different hash) is still refused after the dedupe pass", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();

    // Two entries that share a basename but have DIFFERENT content hashes — this is the
    // ambiguity the refusal exists to catch. Neither the ref nor the hash matches, so the
    // dedupe pass keeps both, and the collision check fires.
    const entry1 = await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode("version-A"),
      mediaType: "application/json",
      type: "state",
      attemptId: "att_d25col",
      routeId: "FLOOR-01",
      witnesses: [],
      sourceEvidenceId: "EV-FLOOR-01-A",
      artifactRef: "observations/FLOOR-01/artifact.json",
    });
    const entry2 = await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode("version-B"),
      mediaType: "application/json",
      type: "state",
      attemptId: "att_d25col",
      routeId: "FLOOR-02",
      witnesses: [],
      sourceEvidenceId: "EV-FLOOR-02-B",
      artifactRef: "observations/FLOOR-02/artifact.json",
    });

    let threw = null;
    try {
      await mod.runInputs.loadArtifactBytes(env, [entry1, entry2]);
    } catch (err) {
      threw = err;
    }
    assert(threw !== null, "different-hash entries sharing a basename must still be refused");
    assertEq(threw.name, "ArtifactNameCollision");
  });

  test("mintJudgement proceeds and counts the collapse when duplicates are identical", async () => {
    const mod = await worker();
    const { minted } = await runThroughJudge(mod, signingEnv());
    // The real capture path does not produce duplicates (putEvidence is write-once), so the
    // end-to-end run proceeds normally. This confirms that the dedupe change did not break
    // the happy path; the direct-fixture test above confirms the collapse counting.
    assertEq(minted.state, "evaluated", "the judge must still reach a judgement on a clean catalogue");
  });
});

// ===========================================================================
// The end-to-end seed: a real v2 run, built by the real stages.
// ===========================================================================

const req = (id, facet, statement, quote) => ({
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
  sourceAtoms: [{ blockId: "B1", kind: "paragraph", coords: null, role: "normative", atomTextHash: sha256(quote) }],
  composition: null,
  normativeStatement: statement,
  displayQuote: quote,
  retiredAt: null,
});

/**
 * TWO OBLIGATIONS THE JUDGE CAN DECIDE FROM THE WALK ALONE, one each way.
 *
 * `R-OPT-1` in `pipeline/judge/lib/compile.mjs` compiles this exact register to an
 * `option-present` expectation, and `optionPresent` decides it against the complete captured
 * inventory. One option IS rendered and one is NOT, so a working chain must produce one pass
 * and one fail — not two of anything, which is what a chain that reads no evidence produces.
 */
const OPT_PRESENT = 'Option 1 with answer text "A watering can" is displayed on Q1.';
const OPT_ABSENT = 'Option 3 with answer text "A self-watering pot" is displayed on Q1.';

function contractBodyD25() {
  return {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: "e".repeat(64),
    documentSha256: "e".repeat(64),
    sealedAt: "2026-08-08T00:00:00.000Z",
    requirements: [
      req("req_d25opt0001", "option-set", OPT_PRESENT, "| 1 | A watering can |"),
      req("req_d25opt0003", "option-set", OPT_ABSENT, "| 3 | A self-watering pot |"),
    ],
    facetInstances: [
      {
        facetInstanceId: "fi_d25_opt1",
        requirementLineageId: "req_d25opt0001",
        requirementVersionId: "reqv_d25opt0001",
        caseVersionId: "cv_fi_d25_opt1",
        floorCase: true,
        targetQuestionId: "Q1",
        expansionCertificate: "cert_fi_d25_opt1",
        case: { kind: "option-set", routeAnswer: null, boundaryInput: null, configuration: null, expectedDestination: null },
        expectationGap: null,
        screen: "Q1",
        label: "Q1 option 1",
      },
      {
        facetInstanceId: "fi_d25_opt3",
        requirementLineageId: "req_d25opt0003",
        requirementVersionId: "reqv_d25opt0003",
        caseVersionId: "cv_fi_d25_opt3",
        floorCase: true,
        targetQuestionId: "Q1",
        expansionCertificate: "cert_fi_d25_opt3",
        case: { kind: "option-set", routeAnswer: null, boundaryInput: null, configuration: null, expectedDestination: null },
        expectationGap: null,
        screen: "Q1",
        label: "Q1 option 3",
      },
    ],
    contractSupplements: [],
    extraction: {
      passAHash: "sha256:aaa",
      passBHash: "sha256:bbb",
      sourceLedgerHash: "sha256:ccc",
      diffHash: "sha256:ddd",
      reviewMode: "high-risk-only",
      reviewedBy: "d25-fixture",
      reviewedAt: "2026-08-08T00:00:00.000Z",
      gates: passingGates(),
    },
  };
}

/**
 * Seed a run the way the workflow seeds one, and capture the walks with the REAL capture
 * stage so the artifactRefs under test are the ones production writes.
 */
async function seedV2Run(mod, env, { collide = false } = {}) {
  const runId = mod.ids.mintRunId();
  const { contractRevisionId, contractHash } = await mod.contractRevision.sealContract(env, contractBodyD25());

  for (const pathId of ["FLOOR-01", "FLOOR-02"]) {
    if (collide) {
      await mod.evidence.putEvidence(env, {
        runId,
        bytes: enc.encode(JSON.stringify(straightWalk(runId, pathId))),
        mediaType: "application/json",
        type: "state",
        attemptId: "att_d25test01",
        routeId: pathId,
        witnesses: [],
        sourceEvidenceId: `EV-${pathId}-observation`,
        artifactRef: `observations/${pathId}/observation.json`,
      });
    } else {
      await mod.capture.capturePathObservation(
        { env, runId, attemptId: "att_d25test01", pathId, witnesses: [] },
        straightWalk(runId, pathId),
      );
    }
  }

  await mod.envelope.putEnvelope(env, {
    schemaVersion: "v2-run-envelope/1.0.0",
    kind: "survey-qa-v2-envelope",
    runId,
    createdAt: "2026-08-08T00:00:00.000Z",
    instanceId: runId,
    input: {
      surveyUrl: "https://fixture.invalid/survey",
      documentKey: mod.keys.inputDocumentKey(runId),
      documentSha256: "e".repeat(64),
      documentName: "houseplants.docx",
      targetBuildId: TARGET_BUILD_ID,
      locale: "en",
      viewports: ["desktop"],
    },
    profile: "standard",
    contractRevisionId,
    recovery: null,
    finalCompletion: null,
  });

  await mod.checkpoint.createCheckpoint(env, mod.checkpoint.initialCheckpoint(env, runId, "standard", false));
  await mod.checkpoint.updateCheckpoint(env, runId, (d) => {
    d.contract = {
      state: "sealed",
      contractRevisionId,
      contractHash,
      total: 2,
      requirements: { total: 2, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
    };
    d.counts = { ...d.counts, exercised: 2, pending: 0 };
    d.completion = { test: "complete", report: "not-started", reasonCode: null };
  });

  return { runId, contractRevisionId, contractHash };
}

/** The real chain: aggregate -> assemble (signed) -> judge. */
async function runThroughJudge(mod, env, seedOpts = {}) {
  const seeded = await seedV2Run(mod, env, seedOpts);
  const derived = await mod.deriveVerdicts.deriveItemResults(env, seeded.runId);
  assertEq(derived.state, "evaluated", "the aggregator must run before there is a record to judge");
  const assembled = await mod.assembleRecord.assembleRecord(env, seeded.runId, derived.value.itemResults);
  assertEq(assembled.state, "evaluated", "the record must assemble");
  assert(assembled.value.signed, "the record must be SIGNED or the authority cannot verify and nothing is minted");
  const minted = await mod.deriveVerdicts.mintJudgement(env, seeded.runId);
  return { ...seeded, derived, assembled, minted };
}

/**
 * The env the workflow runs with when its signing keys are configured.
 *
 * BOTH keys matter and they do different jobs. `RECORD_SIGNING_KEY` attests the RunRecord, so
 * the judge's authority can verify; `JUDGEMENT_SIGNING_KEY` attests the JudgementRecord, and
 * without it `store/judgement.ts` demotes the result to `unusable` and the report shows ONE
 * column — the run's own historical prose. `testEnv` already pins the fixture key in
 * `JUDGEMENT_KEY_REGISTRY`, which is the trust boundary refusing to take the producer's word.
 */
const signingEnv = () =>
  testEnv({
    RECORD_SIGNING_KEY: FIXTURE_KEY.privateKeyPem,
    RECORD_SIGNING_KEY_ID: FIXTURE_KEY.keyId,
    JUDGEMENT_SIGNING_KEY: FIXTURE_KEY.privateKeyPem,
    JUDGEMENT_SIGNING_KEY_ID: FIXTURE_KEY.keyId,
  });

// ===========================================================================
suite("D25 — a real v2 run produces real results", () => {
  test("THE ONE THAT MATTERS: a run walked by the executor yields a NON-ZERO assessed row count", async () => {
    const mod = await worker();
    const { minted } = await runThroughJudge(mod, signingEnv());

    assertEq(minted.state, "evaluated", "the judge must reach a judgement");
    const byVerdict = minted.value.counts.byVerdict;
    const assessed = byVerdict.pass + byVerdict.fail;
    assert(
      assessed > 0,
      `THE BAR: at least one obligation must reach an ASSESSED verdict. Got ${JSON.stringify(byVerdict)} — ` +
        "before this change the judge read zero v2 sessions and every row was not-assessed.",
    );
    // One option is rendered and one is not, so a chain that really read the inventory must
    // land on BOTH sides. Two passes or two fails would mean it decided without looking.
    assertEq(byVerdict.pass, 1, "the rendered option must pass");
    assertEq(byVerdict.fail, 1, "the option the survey does not render must fail");
  });

  test("the evidence really was read: the authority verifies and every walk is in the manifest", async () => {
    const mod = await worker();
    const { minted } = await runThroughJudge(mod, signingEnv());

    assert(minted.value.authority.verified, "an unverified authority is diagnostic-only and mints nothing");
    assert(minted.value.authority.manifestComplete, "the manifest is what the basename collision used to break");
    assertEq(minted.value.artifacts, 2, "both walks reached the judge");
  });

  test("and the verdicts are DERIVED, not copied: the judge cites the artifact it re-read", async () => {
    const mod = await worker();
    const env = signingEnv();
    const { runId } = await runThroughJudge(mod, env);

    const judgement = JSON.parse(await (await env.EVIDENCE.get(mod.keys.judgementKey(runId))).text());
    const rows = judgement.results ?? judgement.rows ?? [];
    assert(rows.length > 0, "the minted JudgementRecord must carry its rows");
    const failing = rows.find((r) => r.verdict === "fail");
    assert(failing, "the seeded absence must appear as a fail in the record itself");
    assert(
      Array.isArray(failing.evidenceRefs) && failing.evidenceRefs.length > 0,
      "a derived fail cites the artifact it was derived from",
    );
  });

  test("THE DELIVERABLE: the published report carries a CURRENT-RESULTS column", async () => {
    const mod = await worker();
    const env = signingEnv();
    const { runId } = await runThroughJudge(mod, env);

    const built = await mod.reportBuild.buildAndStoreReport(env, runId);
    assert(built.ok, `the report must build: ${built.ok ? "" : `${built.reasonCode} — ${built.detail}`}`);
    assertEq(built.summary.judgementState, "attested", built.summary.judgementSummary);
    assert(
      built.summary.hasCurrentResults,
      "a run whose judgement assessed real rows must publish them as CURRENT results — this is the " +
        "column that was empty on every v2 run no matter how well the walk went",
    );
    assert(built.summary.derivedVerdicts, "and the register must say the verdicts were re-derived");

    // AND THE COLUMN MUST HAVE SOMETHING IN IT.
    //
    // `hasCurrentResults` is TRUE for an attested, run-bound judgement whose every row is
    // `not-assessed`: it reports that the column EXISTS, not that anything was decided.
    // Measured, not assumed — with the projection disabled this run still publishes
    // `hasCurrentResults: true`, `derivedVerdicts: true` and a `re-derived` column over two
    // undecided rows. So the assertion has to be read off the PUBLISHED BYTES, per row.
    const pointer = JSON.parse(await (await env.EVIDENCE.get(mod.keys.reportPointerKey(runId))).text());
    const view = JSON.parse(await (await env.EVIDENCE.get(pointer.artifacts.data.key)).text());
    const states = view.register.rows.map((r) => r.cellsByColumn["re-derived"]?.state ?? null);
    const decided = states.filter((s) => s === "PASS" || s === "FAIL");
    assert(
      decided.length > 0,
      `the current column must DECIDE at least one row; states were ${JSON.stringify(states)}. ` +
        "With the judge unable to read v2 evidence every one of them publishes as NOT_REACHED.",
    );
    assert(
      states.includes("FAIL"),
      `and the seeded absence must reach the reader as a FAIL; got ${JSON.stringify(states)}`,
    );
    // The register's cell vocabulary is not the judge's verdict vocabulary — a row the judge
    // passed can still publish as INCOMPLETE when its case was never exercised by the
    // in-workflow verifier. The exact pass/fail split is asserted where it is exact, on
    // `counts.byVerdict` above; here the claim is only that the reader sees a decided row.
  });
});

// ===========================================================================
// Trust card: unaudited artifacts are not absent.
//
// The build.ts audit writes state "unaudited" for budget-exhausted entries, and
// buildTrustStatements in publication.mjs must count them separately from "missing".
// These tests exercise buildTrustStatements directly with hand-built audit maps.
// ===========================================================================
suite("D100 — the trust card does not accuse storage of losing files the render never opened", () => {
  test("the trust card words verified + unaudited + missing honestly, never folding unaudited into absent", async () => {
    const mod = await worker();
    const audit = new Map();
    audit.set("ev1", { state: "verified" });
    audit.set("ev2", { state: "verified" });
    audit.set("ev3", { state: "verified" });
    audit.set("ev4", { state: "unaudited", note: "not audited at render time: byte budget exhausted" });
    audit.set("ev5", { state: "unaudited", note: "not audited at render time: byte budget exhausted" });
    audit.set("ev6", { state: "missing", note: "GET failed" });
    const statements = mod.reportRender.buildTrustStatements({
      attestation: { state: "verified", reason: "ok" },
      evidenceAudit: audit,
      evidenceCount: 6,
      revision: { sealed: true, humanReviewed: true, revisionId: "cr_tc" },
      resultReview: { state: "complete", headline: "complete", policyVersion: null },
    });
    const ev = statements.find((s) => s.id === "evidence-files");
    assert(/3 of 6 hash-verified/.test(ev.value), `verified count must appear: ${ev.value}`);
    assert(/2 not audited at render time/.test(ev.value), `unaudited count must appear as 'not audited': ${ev.value}`);
    assert(/1 absent/.test(ev.value), `truly missing count must appear as 'absent': ${ev.value}`);
    assert(!/2 absent/.test(ev.value), `unaudited must never read as absent: ${ev.value}`);
    assertEq(ev.state, "partial", "anything unaudited or missing keeps state partial");
  });

  test("a trust card with zero unaudited and zero missing omits both groups", async () => {
    const mod = await worker();
    const audit = new Map();
    audit.set("ev1", { state: "verified" });
    audit.set("ev2", { state: "verified" });
    const statements = mod.reportRender.buildTrustStatements({
      attestation: { state: "verified", reason: "ok" },
      evidenceAudit: audit,
      evidenceCount: 2,
      revision: { sealed: true, humanReviewed: true, revisionId: "cr_tc" },
      resultReview: { state: "complete", headline: "complete", policyVersion: null },
    });
    const ev = statements.find((s) => s.id === "evidence-files");
    assertEq(ev.value, "2 of 2 hash-verified");
    assertEq(ev.state, "verified");
  });

  test("a real GET failure still reads as absent, not as unaudited", async () => {
    const mod = await worker();
    const audit = new Map();
    audit.set("ev1", { state: "verified" });
    audit.set("ev2", { state: "missing", note: "GET returned 404" });
    const statements = mod.reportRender.buildTrustStatements({
      attestation: { state: "verified", reason: "ok" },
      evidenceAudit: audit,
      evidenceCount: 2,
      revision: { sealed: true, humanReviewed: true, revisionId: "cr_tc" },
      resultReview: { state: "complete", headline: "complete", policyVersion: null },
    });
    const ev = statements.find((s) => s.id === "evidence-files");
    assert(/1 absent/.test(ev.value), `a real GET failure must still read as absent: ${ev.value}`);
    assert(!/not audited/.test(ev.value), `a real GET failure must not read as unaudited: ${ev.value}`);
    assertEq(ev.state, "partial");
  });
});

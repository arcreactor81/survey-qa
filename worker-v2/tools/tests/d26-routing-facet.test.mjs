/**
 * D26 — NO ROUTING REQUIREMENT COULD BE ASSESSED ON A v2 RUN.
 *
 * ============================== THE DEFECT ==============================
 *
 * `R-ROUTE-1` (`pipeline/judge/lib/compile.mjs`) gated on ONE literal string:
 *
 *     if (o.category !== 'branch-outcome') return null;
 *
 * `o.category` is the SIGNED contract item type. `contract-binding.mjs` maps
 * `category <- contract.items[].type`, and `contractItemFromRequirement` sets that from the
 * requirement's `facet`. No v2 revision has ever spelled a routing facet `branch-outcome` —
 * the extraction's construct vocabulary spells it `skip-rule` (pass B), `routing` (the
 * fixtures and the producer's own case table) or `terminate`. So the gate never opened,
 * every routing requirement compiled to NOTHING, and every one of them published as
 * `NO_TYPED_EXPECTATION` -> `not-assessed` in the authoritative column. Routing defects —
 * much of what this system exists to catch — were structurally invisible there.
 *
 * D25 closed the judge's ability to READ v2 evidence and said so out loud: its fixture uses
 * `option-set` obligations because a ROUTE obligation could not reach a verdict at all. That
 * is the gap this file closes, and it is why the route half of the projection
 * (trace -> `route-table.mjs` -> `route@1` -> `ROUTE_EDGE` attestation) had never once been
 * exercised end to end.
 *
 * ============================ WHAT WAS DECIDED ============================
 *
 * The v2 FACET VOCABULARY IS CANONICAL and the judge's gate learns it, through an explicit
 * mapping in `pipeline/judge/lib/facet-vocab.mjs`. Nothing that gets signed changed:
 * `requirements[].facet` is inside `semanticContractBody`'s digest — the revision id IS that
 * digest — so re-spelling it on the producer would change the identity of every revision and
 * change what past runs mean. `contract.items[].type` still publishes the signed facet
 * verbatim. Full reasoning: `worker-v2/docs/routing-facet-notes.md`.
 *
 * ============================ WHAT THESE TESTS ASSERT ============================
 *
 * VOCABULARY (5) — every facet the producer classifies as a route compiles to a route
 * expectation; a non-route facet and an UNBOUND (null) type still compile to nothing, so the
 * D3 fail-closed property survives verbatim; and the judge's route set is pinned SET-EQUAL to
 * the producer's own `FACET_TO_CASE_KIND` route class, so the two halves cannot drift.
 *
 * END TO END (5) — THE BAR, and it is the same bar D25 set: a real v2 run, sealed contract,
 * walks written by the REAL `capturePathObservation`, a RunRecordV2 assembled and signed by
 * the REAL assembler, judged by the REAL `mintJudgement`, published by the REAL report path.
 * BOTH ARMS on one run: the walk that follows the documented route reaches `pass`, and the
 * walk that lands on a DIFFERENT DOCUMENTED SCREEN reaches `fail` with
 * `ROUTE_DESTINATION_MISMATCH`, citing the artifact it re-read.
 *
 * MEASURED AGAINST THE OLD GATE, by reverting the one line and re-running: 7 of these 10 go
 * red. Both compiles return `null`, both predicate reasons are `null`, and the register
 * publishes both rows as `PENDING`. The route table is EMPTY — not merely undecided — which
 * is the second-order effect worth naming: `documentScreens` builds the capture vocabulary by
 * walking COMPILED expectations, so with no route expectation there is no `Q1`/`Q2` in the
 * vocabulary, every captured screen falls back to a signature token, and not one edge can be
 * built from walks that projected perfectly well. A closed gate did not just silence the
 * verdict; it blinded the evidence projection that feeds it.
 */

import { createHash } from "node:crypto";

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { FIXTURE_KEY, TARGET_BUILD_ID, passingGates } from "../fixtures/v2-fixture.mjs";
import { compileObligation } from "../../../pipeline/judge/lib/compile.mjs";
import { ROUTE_FACETS, isRouteFacet } from "../../../pipeline/judge/lib/facet-vocab.mjs";

const enc = new TextEncoder();
const sha256 = (s) => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;

// ===========================================================================
// THE TWO STATEMENTS. One the survey honours, one it does not.
//
// Both are phrased the way `R-ROUTE-1`'s grammar reads a routing rule: the trigger names a
// CODE at a question, the consequence names the next screen. The survey routes BOTH answers
// to Q2, so the first is true of the implementation and the second is a real routing defect
// whose destination is a different DOCUMENTED screen.
// ===========================================================================

// The label is quoted so `R-ROUTE-1` carries it onto the trigger and the predicate's
// `corroborateLabels` has something to check the rendered option against. The CODE is still
// the identity; the wording is corroboration only, which is exactly what the corroboration
// assertion below proves on real captured inventory.
const ROUTE_HONOURED = 'When the respondent selects code 1 "A watering can" at Q1, the next screen must be Q2.';
const ROUTE_VIOLATED = 'When the respondent selects code 2 "The kitchen tap" at Q1, the next screen must be Q3.';

// ===========================================================================
suite("D26 — the compiler reads the v2 facet vocabulary", () => {
  const compileRoute = (category, statement = ROUTE_HONOURED) =>
    compileObligation({ id: "OBL-D26", category, statement, doc_quote: "| Q1 | Code 1 | Ask Q2 |" });

  test("every facet the producer classifies as a route compiles to a route expectation", () => {
    for (const facet of ROUTE_FACETS) {
      const { expectation, ruleId } = compileRoute(facet);
      assert(expectation !== null, `facet ${JSON.stringify(facet)} must compile to a typed expectation`);
      assertEq(expectation.kind, "route", `facet ${facet}`);
      assertEq(ruleId, "R-ROUTE-1", `facet ${facet}`);
      assertEq(expectation.question, "Q1");
      assertEq(expectation.destination, "Q2");
      assertEq(expectation.trigger.codes.join(","), "1");
      assertEq(expectation.trigger.identity, "code", "a code trigger is identified by its code, never its wording");
    }
  });

  test("`routing` is the spelling that was silently dropped, and it is now the one under test", () => {
    // Stated separately from the loop so the regression is named: this exact value is what
    // `worker-v2/tools/fixtures/v2-fixture.mjs` and every v2 revision emit.
    assert(isRouteFacet("routing"), "the v2 spelling must be recognised");
    assert(compileRoute("routing").expectation !== null, "and it must reach a typed expectation");
  });

  test("a NON-route facet still compiles to nothing, however routing-shaped its prose", () => {
    // The statement is the same one that compiles under `routing`. Only the signed type
    // differs, which is the whole point of gating on the signed type.
    assertEq(compileRoute("question").expectation, null);
    assertEq(compileRoute("validation").expectation, null);
    assertEq(compileRoute("option-list").expectation, null);
    assertEq(isRouteFacet("navigation"), false, "a facet the PRODUCER does not expand as a route must not compile as one");
  });

  test("D3 SURVIVES: an UNBOUND type fails closed exactly as the literal comparison did", () => {
    // `contract-binding.mjs` writes `category: null` when the signature carries no type. A
    // null must never open the gate, or an unsigned field decides whether a routing rule is
    // judged at all — the hole D3 was raised to close.
    assertEq(compileRoute(null).expectation, null, "null is not a route facet");
    assertEq(compileRoute(undefined).expectation, null);
    assertEq(compileRoute("").expectation, null);
    assertEq(isRouteFacet(null), false);
    assertEq(isRouteFacet({ toString: () => "routing" }), false, "only a string may be a facet");
  });

  test("THE DRIFT PIN: the judge's route set is SET-EQUAL to the producer's route class", async () => {
    const mod = await worker();
    const producerRoutes = Object.entries(mod.expand.FACET_TO_CASE_KIND)
      .filter(([, kind]) => kind === "route")
      .map(([facet]) => facet)
      .sort();
    assertEq(
      [...ROUTE_FACETS].sort().join(","),
      producerRoutes.join(","),
      "the judge must compile a route expectation for exactly the facets whose sealed execution case is a " +
        "route — narrower loses rows in silence, wider judges a routing claim the run was never driven to exercise",
    );
  });
});

// ===========================================================================
// A SURVEY THAT PRINTS NO QUESTION IDS — identity lives in the control attributes (D24).
// Same construction as D25, so nothing here can bind by reading prose.
// ===========================================================================

const control = (idx, { name, id, code, label }) => ({
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

const clickStep = (index, before, after, { code, label }) =>
  step(index, before, {
    requested: { select: [label], textEntry: null, action: null },
    screenAfterAdvance: after,
    actions: [
      { kind: "click-option", targetIdx: 0, targetLabel: label, targetCode: code, value: null, ok: true, detail: null },
      { kind: "click-next", targetIdx: 99, targetLabel: "Next", targetCode: null, value: null, ok: true, detail: null },
    ],
    advanced: true,
    blocked: false,
  });

const walk = (runId, pathId, steps) => ({
  kind: "v2-path-observation/1.0.0",
  runId,
  pathId,
  tier: 1,
  attemptId: "att_d26test01",
  planRevisionId: "plan_d26test01",
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

/**
 * ONE WALK PER ANSWER AT Q1, and the implementation sends BOTH to Q2.
 *
 * The two walks produce two DISTINCT route-table rows (the answer is part of the row key), so
 * neither arm can borrow the other's edge: the pass arm is decided by the code-1 row and the
 * fail arm by the code-2 row.
 */
const walkAnswering = (runId, pathId, answer) =>
  walk(runId, pathId, [
    clickStep(0, Q1(), Q2(), answer),
    clickStep(1, Q2(), CLOSING(), { code: "1", label: "Yes" }),
  ]);

const WALKS = [
  { pathId: "FLOOR-01", answer: Q1_OPTIONS[0] }, // code 1 -> Q2, as documented
  { pathId: "FLOOR-02", answer: Q1_OPTIONS[1] }, // code 2 -> Q2, but the document says Q3
];

// ===========================================================================
// The sealed contract. Facet `routing` — the spelling a v2 revision actually carries.
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

const routeCase = (id, lineage, { code, label, destination }) => ({
  facetInstanceId: id,
  requirementLineageId: lineage,
  requirementVersionId: lineage.replace("req_", "reqv_"),
  caseVersionId: `cv_${id}`,
  floorCase: true,
  targetQuestionId: "Q1",
  expansionCertificate: `cert_${id}`,
  case: {
    kind: "route",
    routeAnswer: { code, label },
    boundaryInput: null,
    configuration: null,
    expectedDestination: { questionId: destination, screen: null, terminal: null },
  },
  expectationGap: null,
  screen: "Q1",
  label: `Q1 code ${code}`,
});

const HONOURED_QUOTE = "| Q1 | Code 1 selected | Ask Q2 |";
const VIOLATED_QUOTE = "| Q1 | Code 2 selected | Ask Q3 |";

function contractBodyD26() {
  return {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: "f".repeat(64),
    documentSha256: "f".repeat(64),
    sealedAt: "2026-08-08T00:00:00.000Z",
    requirements: [
      req("req_d26route01", "routing", ROUTE_HONOURED, HONOURED_QUOTE),
      req("req_d26route02", "routing", ROUTE_VIOLATED, VIOLATED_QUOTE),
    ],
    facetInstances: [
      routeCase("fi_d26_r1", "req_d26route01", { code: "1", label: "A watering can", destination: "Q2" }),
      routeCase("fi_d26_r2", "req_d26route02", { code: "2", label: "The kitchen tap", destination: "Q3" }),
    ],
    contractSupplements: [],
    extraction: {
      passAHash: "sha256:aaa",
      passBHash: "sha256:bbb",
      sourceLedgerHash: "sha256:ccc",
      diffHash: "sha256:ddd",
      reviewMode: "high-risk-only",
      reviewedBy: "d26-fixture",
      reviewedAt: "2026-08-08T00:00:00.000Z",
      gates: passingGates(),
    },
  };
}

async function seedV2Run(mod, env) {
  const runId = mod.ids.mintRunId();
  const { contractRevisionId, contractHash } = await mod.contractRevision.sealContract(env, contractBodyD26());

  for (const w of WALKS) {
    await mod.capture.capturePathObservation(
      { env, runId, attemptId: "att_d26test01", pathId: w.pathId, witnesses: [] },
      walkAnswering(runId, w.pathId, w.answer),
    );
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
      documentSha256: "f".repeat(64),
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
async function runThroughJudge(mod, env) {
  const seeded = await seedV2Run(mod, env);
  const derived = await mod.deriveVerdicts.deriveItemResults(env, seeded.runId);
  assertEq(derived.state, "evaluated", "the aggregator must run before there is a record to judge");
  const assembled = await mod.assembleRecord.assembleRecord(env, seeded.runId, derived.value.itemResults);
  assertEq(assembled.state, "evaluated", "the record must assemble");
  assert(assembled.value.signed, "the record must be SIGNED or the authority cannot verify and nothing is minted");
  const minted = await mod.deriveVerdicts.mintJudgement(env, seeded.runId);
  return { ...seeded, derived, assembled, minted };
}

const signingEnv = () =>
  testEnv({
    RECORD_SIGNING_KEY: FIXTURE_KEY.privateKeyPem,
    RECORD_SIGNING_KEY_ID: FIXTURE_KEY.keyId,
    JUDGEMENT_SIGNING_KEY: FIXTURE_KEY.privateKeyPem,
    JUDGEMENT_SIGNING_KEY_ID: FIXTURE_KEY.keyId,
  });

/** The judged rows, read out of the MINTED record rather than out of a summary. */
async function judgedRows(mod, env, runId) {
  const judgement = JSON.parse(await (await env.EVIDENCE.get(mod.keys.judgementKey(runId))).text());
  const rows = judgement.results ?? judgement.rows ?? [];
  const byId = new Map(rows.map((r) => [r.obligationId ?? r.itemId, r]));
  return { rows, byId, judgement };
}

// ===========================================================================
suite("D26 — a ROUTE obligation reaches a real verdict on a real v2 run", () => {
  test("BOTH ARMS: the honoured route passes and the violated route fails", async () => {
    const mod = await worker();
    const env = signingEnv();
    const { runId, minted } = await runThroughJudge(mod, env);

    assertEq(minted.state, "evaluated", "the judge must reach a judgement");
    const { byId } = await judgedRows(mod, env, runId);

    const pass = byId.get("req_d26route01");
    const fail = byId.get("req_d26route02");
    assert(pass && fail, "both routing obligations must appear in the minted record");

    // The compile step first: before this change BOTH of these were null and both rows were
    // NO_TYPED_EXPECTATION, which is the state the whole file exists to make impossible.
    assertEq(pass.compiledBy, "R-ROUTE-1", "the honoured route must compile to a typed route expectation");
    assertEq(fail.compiledBy, "R-ROUTE-1", "so must the violated one");
    assertEq(pass.predicateId, "route@1", "and it must be decided by the ROUTE predicate, not by prose");

    assertEq(pass.verdict, "pass", `the walk that followed the documented route must PASS; got ${pass.reason}`);
    assertEq(fail.verdict, "fail", `the walk that landed elsewhere must FAIL; got ${fail.reason}`);

    const byVerdict = minted.value.counts.byVerdict;
    assertEq(byVerdict.pass, 1, "exactly one routing row passes");
    assertEq(byVerdict.fail, 1, "exactly one routing row fails");
  });

  test("the FAIL arm names the defect and CITES the artifact it re-read", async () => {
    const mod = await worker();
    const env = signingEnv();
    const { runId } = await runThroughJudge(mod, env);
    const { byId } = await judgedRows(mod, env, runId);
    const fail = byId.get("req_d26route02");

    assertEq(
      fail.predicateReason,
      "ROUTE_DESTINATION_MISMATCH",
      "the document says Q3 and the survey went to Q2; that is a destination mismatch, not a missing observation",
    );
    assertEq(fail.expectation.destination, "Q3", "the expectation must carry the DOCUMENT'S destination");
    assertEq(fail.predicateDetail.observedDestinations.Q2, 1, "and the detail must carry the destination actually walked");
    assert(
      Array.isArray(fail.evidenceRefs) && fail.evidenceRefs.length > 0,
      "a derived fail cites the artifact it was derived from",
    );
    assert(
      Array.isArray(fail.counterWitnesses) && fail.counterWitnesses.length > 0,
      "and the counter-witness is the route edge itself",
    );
  });

  test("THE ROUTE PROJECTION, ON REAL EVIDENCE: the edge was rebuilt from the walk and ATTESTED", async () => {
    const mod = await worker();
    const env = signingEnv();
    const { runId } = await runThroughJudge(mod, env);
    const { byId, judgement } = await judgedRows(mod, env, runId);

    // The route table is built by `route-table.mjs` from the PROJECTED v2 walks
    // (`v2-observation.mjs` trace -> edge). Before this work that path had only ever been
    // unit-tested, because no route obligation could reach it. It is published in the record.
    const table = judgement.routeTable ?? null;
    assert(table, "the minted judgement must carry the route table it decided from");
    assertEq(table.sessions, 2, "both walks must be admitted as sessions");
    assertEq(table.sessionsQuarantined, 0, "and neither may be quarantined");
    const q1 = (table.rows ?? []).filter((r) => r.question === "Q1");
    assertEq(q1.length, 2, `one row per distinct answer at Q1; got ${JSON.stringify(q1.map((r) => r.answer))}`);
    for (const r of q1) {
      assertEq(Object.keys(r.destinations).join(","), "Q2", "the implementation routes both answers to Q2");
      assertEq(
        Object.values(r.destinations)[0].witnesses[0].proofKind,
        "route-edge",
        "every edge must ship the complete route-edge proof tuple, not a bare screen id",
      );
    }

    // ATTESTATION: the witness is re-verified against the signed artifact at judgement time.
    const pass = byId.get("req_d26route01");
    assert(pass.attestation.witnessCount > 0, "a route pass must cite at least one attested edge");
    assert(pass.attestation.allVerified, "and every cited edge must re-verify against the signed artifact");
    assertEq(
      pass.attestation.hashAuthority,
      "signed-run-record",
      "the hashes must come from the signed record, not from an unattested local read",
    );
  });

  test("the identity is the CODE the document binds, not the wording", async () => {
    const mod = await worker();
    const env = signingEnv();
    const { runId } = await runThroughJudge(mod, env);
    const { byId } = await judgedRows(mod, env, runId);
    const pass = byId.get("req_d26route01");

    assertEq(pass.expectation.trigger.identity, "code");
    assertEq(pass.expectation.trigger.codes.join(","), "1");
    assertEq(pass.expectation.trigger.mode, "include");
    assertEq(pass.expectation.trigger.labels.join(","), "A watering can", "the wording travels as corroboration");
    // The document's wording is checked against what the site rendered AT THAT CODE. Confirmed
    // means the two agree; a wording that named a different live option would be typed drift
    // and would decide nothing.
    assertEq(
      pass.predicateDetail.corroboration.level,
      "confirmed",
      `the trigger wording must be confirmed against the rendered inventory; got ${JSON.stringify(pass.predicateDetail.corroboration)}`,
    );
    assertEq(pass.predicateDetail.corroboration.renderedAtTrigger.join(","), "A watering can");
  });

  test("THE DELIVERABLE: the published report DECIDES the routing rows", async () => {
    const mod = await worker();
    const env = signingEnv();
    const { runId } = await runThroughJudge(mod, env);

    const built = await mod.reportBuild.buildAndStoreReport(env, runId);
    assert(built.ok, `the report must build: ${built.ok ? "" : `${built.reasonCode} — ${built.detail}`}`);
    assertEq(built.summary.judgementState, "attested", built.summary.judgementSummary);
    assert(built.summary.hasCurrentResults, "a run whose judgement assessed real rows must publish them as CURRENT results");

    // Read off the PUBLISHED BYTES, per row — `hasCurrentResults` reports that the column
    // EXISTS, not that anything in it was decided (D25's finding, and it holds here too).
    const pointer = JSON.parse(await (await env.EVIDENCE.get(mod.keys.reportPointerKey(runId))).text());
    const view = JSON.parse(await (await env.EVIDENCE.get(pointer.artifacts.data.key)).text());
    const states = new Map(view.register.rows.map((r) => [r.itemId, r.cellsByColumn["re-derived"]?.state ?? null]));
    assert(
      states.get("req_d26route02") === "FAIL",
      `the routing defect must reach the reader as a FAIL; states were ${JSON.stringify([...states])}. ` +
        "MEASURED against the old gate: both rows publish as PENDING, however the walk went.",
    );
  });
});

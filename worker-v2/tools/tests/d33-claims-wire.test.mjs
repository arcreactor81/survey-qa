/**
 * D33 — THE RECORD MUST CARRY THE DEFECTS THE RUN FOUND.
 *
 * THE DEFECT. Run `v2r_01kzfktf3qj9qazn86t1y0yx5k` (8 Aug) produced this pipeline's first
 * real defect verdicts: 227 requirements, 223 incomplete, 2 pass and 2 FAIL — a route the
 * document sends to Q9 that landed on Q8 (`ROUTE_DESTINATION_MISMATCH`), and a boundary the
 * document requires the site to reject that it accepted (`BOUNDARY_NOT_REJECTED`). The signed
 * record it wrote nevertheless carried `claims: []` and `blockers: []`. A researcher reading
 * that record sees a clean survey. `assemble-record.ts` called the assembler with a literal
 * `claims: []`, and `assemble-record.mjs` hardcoded `blockers: []` — the wire was never
 * connected.
 *
 * THE FIX IS THE ABSENCE OF A WIRE. Claims are no longer a parameter: the assembler derives
 * them from the `itemResults` and `observations` it already receives, so no caller can omit
 * them. Blockers are derived the same way, from a walk ledger the caller must supply as a
 * distinguishable value (`null` = no ledger, `[]` = a ledger with no walks).
 *
 * ============================ WHAT THESE TESTS DRIVE ============================
 *
 * The REAL chain: `deriveVerdicts.deriveItemResults` (the real aggregator, over seeded
 * observations) -> `assembleRecord.assembleRecord` (the real stage, reading the real R2) ->
 * the stored record's own bytes. Nothing asserts on a value a test computed.
 *
 * THAT SEAM IS THE ONE `tsc` CANNOT SEE. `assemble-record.ts` imports the assembler under
 * `@ts-ignore` because the module is untyped ESM shared with the offline pipeline, so
 * `npx tsc --noEmit` passes whether the stage passes `walks`, passes the old `claims: []`, or
 * passes neither. These tests are the only thing standing between that seam and a silent
 * regression, which is why they go through the stage rather than calling the .mjs directly.
 *
 * THE FIXTURE IS THE REAL RUN, REDUCED. Three requirements in the shape run 5 actually had:
 *
 *   req_ty94r6fg57gn  a case that fails on a real `contradicted` route observation, beside a
 *                     sibling case the cursor left BLOCKED which carries a contradicted
 *                     observation of its own. The aggregator's `statusForCase` lets a cap or
 *                     an unreachable route decide a case BEFORE it looks at any verifier
 *                     decision, so that sibling must yield NO claim. A projection that
 *                     reached past the verdict to the observation would be authoring one.
 *   req_1xc0tm90zzvr  a case that fails on a real `contradicted` boundary observation, beside
 *                     a sibling holding the run's real `insufficient` observation
 *                     (NO_TYPED_EXPECTATION). Insufficient is not a defect and must not leak.
 *   req_clean0000001  one `verified` case — a PASS, which must contribute nothing.
 *
 * So "exactly 2 claims" is simultaneously the positive proof and the proof that a pending
 * case, a blocked case, an insufficient decision and a passing requirement all stay out.
 *
 * The reason codes, the detail strings and the load-crash message below are the ones the real
 * run wrote; the record was fetched from `/api/v2/runs/<id>/record` and its load-failure trace
 * from the evidence endpoint. Nothing here is invented prose.
 *
 * Evidence these tests can fail: `tools/mutate-claims.mjs`.
 */

import { assert, assertEq, sha256, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { FIXTURE_KEY, passingGates } from "../fixtures/v2-fixture.mjs";

/**
 * The env with a record signing key, so the headline test's record is genuinely SIGNED. It
 * matters beyond the wording: `assemble-record.ts` builds the unsigned record FIRST and hands
 * it to `signRecordWithProducerKey`, so the attestation's payload hash is taken over bytes that
 * already contain the claims. Signing here pins that the findings are inside what was attested,
 * not appended to a record that was signed without them.
 */
const signingEnv = () =>
  testEnv({ RECORD_SIGNING_KEY: FIXTURE_KEY.privateKeyPem, RECORD_SIGNING_KEY_ID: FIXTURE_KEY.keyId });

const enc = new TextEncoder();

// The two verifier verdicts run 5 actually produced, verbatim.
const ROUTE_DETAIL = "the document routes to Q9; the walk reached a screen whose own controls are named after Q8";
const BOUNDARY_DETAIL =
  "the document requires this input to be rejected; the survey advanced and raised no message it was not already showing";
const INSUFFICIENT_DETAIL = "the sealed boundary case states no expected outcome, so there is nothing to check the walk against";
// The page error the target actually threw (`var history = []` under strict mode).
const CRASH_MESSAGE = "Cannot set property history of #<Window> which has only a getter";

const PATH_ID = "FLOOR-01";
const ATTEMPT_ID = "att_d33crash01";

// ---------------------------------------------------------------------------
// The sealed contract: three requirements, five cases.
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
  sourceAtoms: [{ blockId: "B1", kind: "paragraph", coords: null, role: "normative", atomTextHash: sha256(statement) }],
  composition: null,
  normativeStatement: statement,
  displayQuote: statement,
  retiredAt: null,
});

const facetInstance = (id, requirementLineageId, kind) => ({
  facetInstanceId: id,
  requirementLineageId,
  requirementVersionId: requirementLineageId.replace("req_", "reqv_"),
  caseVersionId: `cv_${id}`,
  floorCase: true,
  targetQuestionId: "Q8",
  expansionCertificate: `cert_${id}`,
  case: { kind, routeAnswer: null, boundaryInput: null, configuration: null, expectedDestination: null },
  expectationGap: null,
  screen: "Q8",
  label: id,
});

const contractBodyD33 = () => ({
  schemaVersion: "v2-contract-revision/1.0.0",
  kind: "survey-qa-v2-contract-revision",
  documentRevisionId: "d".repeat(64),
  documentSha256: "d".repeat(64),
  sealedAt: "2026-08-08T00:00:00.000Z",
  requirements: [
    req("req_ty94r6fg57gn", "routing", "If Q8 is Yes, go to Q9."),
    req("req_1xc0tm90zzvr", "boundary", "An age below 18 must be rejected."),
    req("req_clean0000001", "option-set", 'Option 1 with answer text "Yes" is displayed on Q8.'),
  ],
  facetInstances: [
    facetInstance("fi_route_fail", "req_ty94r6fg57gn", "routing"),
    facetInstance("fi_route_blocked", "req_ty94r6fg57gn", "routing"),
    facetInstance("fi_bound_fail", "req_1xc0tm90zzvr", "boundary"),
    facetInstance("fi_bound_insufficient", "req_1xc0tm90zzvr", "boundary"),
    facetInstance("fi_clean_pass", "req_clean0000001", "option-set"),
  ],
  contractSupplements: [],
  extraction: {
    passAHash: "sha256:aaa",
    passBHash: "sha256:bbb",
    sourceLedgerHash: "sha256:ccc",
    diffHash: "sha256:ddd",
    reviewMode: "high-risk-only",
    reviewedBy: "d33-fixture",
    reviewedAt: "2026-08-08T00:00:00.000Z",
    gates: passingGates(),
  },
});

const observation = ({ observationId, facetInstanceId, decision, predicate, reason, detail, evidenceIds = [] }) => ({
  observationId,
  facetInstanceId,
  attemptId: ATTEMPT_ID,
  routeId: `${PATH_ID}--${facetInstanceId}`,
  observedAt: "2026-08-08T03:07:34.175Z",
  payloadKind: "v2-walk-projection/1.0.0",
  payload: { pathId: PATH_ID, attemptId: ATTEMPT_ID, outcome: "no-advance-control", exercised: true },
  completeness: "partial",
  evidenceIds,
  verifier: { decision, evidenceIds, verifierVersion: "v2-structural-verifier/1.3.0+no-model", predicate, reason, detail },
  attestation: { producedBy: "v2-executor", producerVersion: "v2-observation-projection/1.0.0", payloadHash: `sha256:${"0".repeat(64)}` },
});

/**
 * The observation set, parameterised so the counterweight can seed the SAME structure with
 * every decision flipped to `verified` — one controlled pair, not two unrelated fixtures.
 */
function observationsFor({ allPass = false, evidenceId = (s) => s } = {}) {
  return [
    observation({
      observationId: "obs_5886a62b2a58d253d27b",
      facetInstanceId: "fi_route_fail",
      decision: allPass ? "verified" : "contradicted",
      predicate: "route-destination/1.0.0",
      reason: allPass ? "ROUTE_DESTINATION_REACHED" : "ROUTE_DESTINATION_MISMATCH",
      detail: allPass ? "the walk reached the documented destination" : ROUTE_DETAIL,
      evidenceIds: [evidenceId("EV-D33-ROUTE")],
    }),
    // A contradicted observation on a case the CURSOR left blocked. The aggregator decides
    // that case from the cursor, so this must never become a claim.
    observation({
      observationId: "obs_blocked00000000001",
      facetInstanceId: "fi_route_blocked",
      decision: allPass ? "verified" : "contradicted",
      predicate: "route-destination/1.0.0",
      reason: allPass ? "ROUTE_DESTINATION_REACHED" : "ROUTE_DESTINATION_MISMATCH",
      detail: allPass ? "the walk reached the documented destination" : ROUTE_DETAIL,
      evidenceIds: [evidenceId("EV-D33-BLOCKED")],
    }),
    observation({
      observationId: "obs_6f0d49494a4a4b571bba",
      facetInstanceId: "fi_bound_fail",
      decision: allPass ? "verified" : "contradicted",
      predicate: "boundary-outcome/1.0.0",
      reason: allPass ? "BOUNDARY_REJECTED_AS_DOCUMENTED" : "BOUNDARY_NOT_REJECTED",
      detail: allPass ? "the survey rejected the input as documented" : BOUNDARY_DETAIL,
      evidenceIds: [evidenceId("EV-D33-BOUND")],
    }),
    // AN INSUFFICIENT OBSERVATION ON THE FAILING CASE ITSELF. This is the position no
    // requirement-level or case-level guard can defend: the case IS `fail`, so both guards
    // wave it through, and only the per-observation decision filter stops the verifier's "the
    // document stated nothing to check here" from being published as a second defect about
    // the client's site. `tools/mutate-claims.mjs` found this hole by surviving.
    observation({
      observationId: "obs_insufficient_on_fail",
      facetInstanceId: "fi_bound_fail",
      decision: allPass ? "verified" : "insufficient",
      predicate: "boundary-outcome/1.0.0",
      reason: allPass ? "BOUNDARY_ACCEPTED_AS_DOCUMENTED" : "NO_TYPED_EXPECTATION",
      detail: allPass ? "the survey accepted the input as documented" : INSUFFICIENT_DETAIL,
      evidenceIds: [evidenceId("EV-D33-BOUND2")],
    }),
    // Run 5's real `insufficient`. Not a defect, and it sits on a sibling case of a FAILING
    // requirement — the exact position from which a sloppy projection would leak it.
    observation({
      observationId: "obs_2601e6636d45714eaeba",
      facetInstanceId: "fi_bound_insufficient",
      decision: allPass ? "verified" : "insufficient",
      predicate: "boundary-outcome/1.0.0",
      reason: allPass ? "BOUNDARY_ACCEPTED_AS_DOCUMENTED" : "NO_TYPED_EXPECTATION",
      detail: allPass ? "the survey accepted the input as documented" : INSUFFICIENT_DETAIL,
      evidenceIds: [evidenceId("EV-D33-INSUFF")],
    }),
    observation({
      observationId: "obs_clean000000000001",
      facetInstanceId: "fi_clean_pass",
      decision: "verified",
      predicate: "option-present/1.0.0",
      reason: "OPTION_PRESENT",
      detail: "the option the document names is displayed",
      evidenceIds: [evidenceId("EV-D33-CLEAN")],
    }),
  ];
}

// ---------------------------------------------------------------------------
// The walk ledger — written to the SAME durable key `execute-batch.ts` writes.
// ---------------------------------------------------------------------------

const walk = (over = {}) => ({
  pathId: PATH_ID,
  tier: 1,
  attemptId: ATTEMPT_ID,
  outcome: "completed",
  outcomeDetail: null,
  steps: 10,
  wallMs: 1000,
  shimmed: false,
  loadCrash: false,
  evidenceCount: 4,
  caseIds: [],
  exercised: true,
  plannedDecisions: 0,
  matchedDecisions: 0,
  constrainingDecisions: 0,
  matchedConstraining: 0,
  screensAdvanced: 10,
  at: "2026-08-08T02:52:30.000Z",
  ...over,
});

const CRASHED_WALK = walk({
  outcome: "load-crash",
  outcomeDetail: CRASH_MESSAGE,
  loadCrash: true,
  shimmed: false,
  steps: 0,
  screensAdvanced: 0,
  exercised: false,
  evidenceCount: 2,
  at: "2026-08-08T02:51:49.600Z",
});

const SHIMMED_RETRY = walk({ shimmed: true });

async function seedD33(mod, env, { observationOpts = {}, walks, crashEvidence = true, reasonCode = "walks-blocked-by-site" } = {}) {
  const runId = mod.ids.mintRunId();
  const { contractRevisionId, contractHash } = await mod.contractRevision.sealContract(env, contractBodyD33());

  // The crash artifacts, written by the REAL capture stage so their catalogue `type` and
  // `sourceEvidenceId` are the ones production mints — the two fields the blocker's evidence
  // lookup reads. `captureFailure` is the only producer of `type: "trace"` in the tree.
  if (crashEvidence) {
    const cap = { env, runId, attemptId: ATTEMPT_ID, pathId: PATH_ID, witnesses: [] };
    await mod.capture.captureFailure(
      cap,
      { what: "the survey threw during load and rendered no interactive control", pageErrors: [CRASH_MESSAGE], shimmed: false },
      "load-failure",
    );
    await mod.capture.captureScreenshot(cap, enc.encode("PNG-AT-FAILURE"), "load-failure", 0);
    // Decoys on the SAME path and attempt: the shimmed retry's own screens. A lookup that
    // took "every artifact of this attempt" would sweep these in.
    await mod.capture.captureScreenshot(cap, enc.encode("PNG-AFTER-SHIM"), "before", 0);
  }

  // The storage layer MINTS the catalogue id (`ev_<12>`); `EV-D33-*` is only the record-side
  // source name. The observations must cite the minted id, because that is what production
  // writes and what the traceability assertion resolves against — a fixture citing the source
  // name would make that test pass over evidence the catalogue does not contain.
  const minted = new Map();
  for (const [source, text] of [
    ["EV-D33-ROUTE", "route walk"],
    ["EV-D33-BLOCKED", "blocked walk"],
    ["EV-D33-BOUND", "boundary walk"],
    ["EV-D33-BOUND2", "boundary walk, second observation"],
    ["EV-D33-INSUFF", "insufficient walk"],
    ["EV-D33-CLEAN", "clean walk"],
  ]) {
    const entry = await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode(text),
      mediaType: "application/json",
      type: "state",
      attemptId: ATTEMPT_ID,
      routeId: PATH_ID,
      witnesses: [],
      sourceEvidenceId: source,
      artifactRef: `observations/${PATH_ID}/${source}.json`,
    });
    minted.set(source, entry.evidenceId);
  }

  const observations = observationsFor({
    ...observationOpts,
    evidenceId: (source) => {
      const id = minted.get(source);
      if (!id) throw new Error(`fixture bug: no catalogue entry was minted for ${source}`);
      return id;
    },
  });

  await env.EVIDENCE.put(mod.keys.observationsKey(runId), JSON.stringify({ observations }), {
    httpMetadata: { contentType: "application/json" },
  });

  if (walks !== null) {
    await env.EVIDENCE.put(
      mod.keys.k("runs", runId, "execution", "progress.json"),
      JSON.stringify({
        kind: "v2-execution-progress/1.0.0",
        runId,
        planRevisionId: "plan_d33",
        walks,
        floorDone: [],
        explorationDone: [],
        shimRequired: true,
        shimEvidence: null,
        hungPaths: [],
        totalSteps: 10,
        totalEvidence: 4,
      }),
      { httpMetadata: { contentType: "application/json" } },
    );
  }

  await mod.envelope.putEnvelope(env, {
    schemaVersion: "v2-run-envelope/1.0.0",
    kind: "survey-qa-v2-envelope",
    runId,
    createdAt: "2026-08-08T02:51:00.000Z",
    instanceId: runId,
    input: {
      surveyUrl: "https://fixture.invalid/survey",
      documentKey: mod.keys.inputDocumentKey(runId),
      documentSha256: "d".repeat(64),
      documentName: "d33.docx",
      targetBuildId: "build_d33",
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
      total: 5,
      requirements: { total: 3, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
    };
    // Four cases observed, one the executor never settled — the ledger must reconcile to the
    // sealed total of 5 or `updateCheckpoint` refuses the write.
    d.counts = { ...d.counts, exercised: 4, blocked: 1, pending: 0 };
    // The cursor that makes `fi_route_blocked` blocked rather than observed. THE REASON CODE
    // IS LOAD-BEARING: `blocked` means "the site stopped us here", and since the completion-path
    // audit only a reason that NAMES a site refusal produces it (`unsettledBucketFor`,
    // types/contracts.ts). This fixture is about a case the SITE blocked, so it carries the
    // accusation-grade code; it previously said `coverage-shortfall-unexercised`, which is our
    // own shortfall and now correctly yields `not-reached` instead.
    d.execution = { ...d.execution, pendingCaseIds: ["fi_route_blocked"], planRevisionId: "plan_d33" };
    d.completion = { test: "partial-blocked", report: "not-started", reasonCode };
  });

  return { runId, contractRevisionId, contractHash };
}

/** The real chain, and the record read back from storage rather than from a return value. */
async function assembleD33(env, opts = {}) {
  const mod = await worker();
  const seeded = await seedD33(mod, env, {
    observationOpts: { allPass: opts.allPass === true },
    walks: opts.walks === undefined ? [CRASHED_WALK, SHIMMED_RETRY] : opts.walks,
    crashEvidence: opts.crashEvidence,
    reasonCode: opts.reasonCode,
  });
  const derived = await mod.deriveVerdicts.deriveItemResults(env, seeded.runId);
  assertEq(derived.state, "evaluated", `the aggregator must run: ${derived.reason ?? ""} ${derived.detail ?? ""}`);
  const assembled = await mod.assembleRecord.assembleRecord(env, seeded.runId, derived.value.itemResults);
  assertEq(assembled.state, "evaluated", `the record must assemble: ${assembled.reason ?? ""} ${assembled.detail ?? ""}`);
  const stored = await (await env.EVIDENCE.get(mod.keys.recordKey(seeded.runId))).json();
  return { mod, ...seeded, derived, assembled, record: stored };
}

// ===========================================================================
suite("D33 — the record carries the defects the run found", () => {
  test("THE ONE THAT MATTERS: two failing verdicts produce two claims in the SIGNED record, not []", async () => {
    const { record, derived, assembled } = await assembleD33(signingEnv());
    assert(assembled.value.signed, "this test says SIGNED; without a key it would be asserting on an unsigned record");
    assert(record.attestation?.payloadHash, "the attestation must cover the bytes that carry the claims");

    const fails = derived.value.itemResults.filter((r) => r.verdict === "fail" || r.verdict === "mixed");
    assertEq(fails.length, 2, "the fixture must reproduce run 5's two failing requirements");
    assertEq(
      record.claims.length,
      2,
      `the record must carry one claim per failing case and NOTHING else — got ${JSON.stringify(record.claims.map((c) => c.claimType))}`,
    );

    const byType = new Map(record.claims.map((c) => [c.claimType, c]));
    const route = byType.get("ROUTE_DESTINATION_MISMATCH");
    const boundary = byType.get("BOUNDARY_NOT_REJECTED");
    assert(route, `the route defect must be claimed: ${JSON.stringify([...byType.keys()])}`);
    assert(boundary, `the boundary defect must be claimed: ${JSON.stringify([...byType.keys()])}`);

    assertEq(route.claimClass, "defect");
    assertEq(route.normativeRef.requirementLineageId, "req_ty94r6fg57gn");
    assertEq(route.normativeRef.requirementVersionId, "reqv_ty94r6fg57gn");
    assertEq(JSON.stringify(route.observationRefs), JSON.stringify(["obs_5886a62b2a58d253d27b"]));
    assertEq(boundary.normativeRef.requirementLineageId, "req_1xc0tm90zzvr");
    assertEq(JSON.stringify(boundary.observationRefs), JSON.stringify(["obs_6f0d49494a4a4b571bba"]));
  });

  test("the claim's prose is the VERIFIER'S OWN sentence, verbatim — never a paraphrase", async () => {
    const { record } = await assembleD33(testEnv());
    const proses = record.claims.map((c) => c.prose).sort();
    assertEq(
      JSON.stringify(proses),
      JSON.stringify([BOUNDARY_DETAIL, ROUTE_DETAIL].sort()),
      "a claim that rewrites the verifier's detail has put an unchecked narrative in front of a reviewer",
    );
    for (const c of record.claims) {
      assert(!("severity" in c), "a v2 claim carries NO severity — it is not derivable from the evidence");
      assert(!("confidence" in c), "a v2 claim carries NO confidence");
    }
  });

  test("every claim is traceable to evidence ids that exist in THIS record's own catalogue", async () => {
    const { record } = await assembleD33(testEnv());
    const catalogue = new Set(record.evidence.map((e) => e.evidenceId));
    const observations = new Map(record.observations.map((o) => [o.observationId, o]));
    assert(catalogue.size > 0, "the fixture must catalogue evidence or this test proves nothing");
    // NON-VACUITY. Every assertion below lives inside a loop over `record.claims`, so an empty
    // claims list would satisfy all of them — which is the exact regression this file exists to
    // catch. A test that passes hardest when the product is most broken is worse than no test.
    assertEq(record.claims.length, 2, "this test is a loop over the claims; with none it proves nothing");

    for (const c of record.claims) {
      assert(c.observationRefs.length > 0, `claim ${c.claimId} cites no observation`);
      for (const ref of c.observationRefs) {
        const o = observations.get(ref);
        assert(o, `claim ${c.claimId} cites observation ${ref}, which is not in the record`);
        assert(o.evidenceIds.length > 0, `observation ${ref} cites no evidence`);
        for (const ev of o.evidenceIds) {
          assert(catalogue.has(ev), `claim ${c.claimId} reaches evidence ${ev}, absent from the catalogue`);
        }
      }
    }
  });

  test("THE COUNTERWEIGHT: a run with zero fail verdicts produces zero claims", async () => {
    const { record, derived } = await assembleD33(testEnv(), { allPass: true, walks: [] });
    const fails = derived.value.itemResults.filter((r) => r.verdict === "fail" || r.verdict === "mixed");
    assertEq(fails.length, 0, "the all-pass fixture must produce no failing verdict");
    assertEq(
      record.claims.length,
      0,
      `a claims pipeline that manufactures a claim from a passing run is worse than the empty array it replaces: ${JSON.stringify(record.claims)}`,
    );
    assertEq(record.blockers.length, 0, `a healthy ledger blocks nothing: ${JSON.stringify(record.blockers)}`);
  });

  test("A CASE WE NEVER DROVE IS `not-reached`, NOT `blocked` — the record does not accuse the site of our shortfall", async () => {
    // Completion-path audit G5. The first-completion run shape is one deep walk, a few
    // screened-out probes and ~400 cases nobody ever attempted. Every one of those 400 was
    // written into the SIGNED RECORD as `blocked` — "the site stopped us here" — because the
    // status mapping read every non-`-cap` reason that way. The identical fixture, one reason
    // code apart, is the whole proof: the same never-driven case is `blocked` under a site
    // refusal and `not-reached` under our own coverage shortfall.
    const { derived } = await assembleD33(testEnv(), { reasonCode: "coverage-shortfall-unexercised" });
    const routeItem = derived.value.itemResults.find((r) => r.requirementLineageId === "req_ty94r6fg57gn");
    const never = routeItem.facetResults.find((f) => f.facetInstanceId === "fi_route_blocked");
    assertEq(never.status, "not-reached", `our own shortfall must not be filed as the site's refusal: ${JSON.stringify(never)}`);
  });

  test("a contradicted observation on a case the CURSOR blocked yields no claim — the aggregator decides, not the projection", async () => {
    const { record, derived } = await assembleD33(testEnv());
    const routeItem = derived.value.itemResults.find((r) => r.requirementLineageId === "req_ty94r6fg57gn");
    const blocked = routeItem.facetResults.find((f) => f.facetInstanceId === "fi_route_blocked");
    assertEq(blocked.status, "blocked", "the fixture must actually reach the blocked branch or this proves nothing");
    assert(
      blocked.observationIds.includes("obs_blocked00000000001"),
      "the blocked case must still CARRY its contradicted observation — otherwise the leak has no route to test",
    );
    assert(
      !record.claims.some((c) => c.observationRefs.includes("obs_blocked00000000001")),
      "a projection that read the observation past the case status would be authoring a verdict the aggregator declined",
    );
  });

  test("an `insufficient` decision beside a failing sibling never becomes a claim", async () => {
    const { record } = await assembleD33(testEnv());
    assert(
      !record.claims.some((c) => c.observationRefs.includes("obs_2601e6636d45714eaeba")),
      "NO_TYPED_EXPECTATION means the document stated nothing to check — it is not a finding about the site",
    );
    assert(
      !record.claims.some((c) => c.claimType === "NO_TYPED_EXPECTATION"),
      "an insufficient reason code must never appear as a defect type",
    );
  });

  test("a FAILING case holding both a contradicted and an insufficient observation claims only the contradicted one", async () => {
    const { record, derived } = await assembleD33(testEnv());
    const boundItem = derived.value.itemResults.find((r) => r.requirementLineageId === "req_1xc0tm90zzvr");
    const failing = boundItem.facetResults.find((f) => f.facetInstanceId === "fi_bound_fail");
    assertEq(failing.status, "fail", "the fixture must reach the fail branch");
    assertEq(
      failing.observationIds.length,
      2,
      "the case must carry BOTH observations, or the only guard left to test is one no longer under pressure",
    );
    assert(
      !record.claims.some((c) => c.observationRefs.includes("obs_insufficient_on_fail")),
      "neither the verdict nor the case status can filter this one — dropping the per-observation decision " +
        "check would publish 'the document stated nothing to check' as a defect about the client's site",
    );
    assertEq(record.claims.length, 2, "one claim per CONTRADICTED observation, not one per observation on a failing case");
  });

  test("THE LOAD CRASH SURFACES: the target that rendered nothing is a blocker naming its own evidence", async () => {
    const { record } = await assembleD33(testEnv());
    const crash = record.blockers.find((b) => b.kind === "TARGET_FAILED_TO_LOAD");
    assert(crash, `the highest-severity thing this run found must be visible: ${JSON.stringify(record.blockers.map((b) => b.kind))}`);
    assertEq(crash.detail, CRASH_MESSAGE, "the blocker must quote the page's own error, not describe it");
    assertEq(crash.outcome, "load-crash");
    assertEq(crash.pathId, PATH_ID);
    assertEq(crash.shimmed, false, "the crash was captured BEFORE the workaround, and the record must say so");
    assert(!("severity" in crash), "a blocker carries no invented severity");

    const catalogue = new Map(record.evidence.map((e) => [e.evidenceId, e]));
    assertEq(crash.evidenceIds.length, 2, `the trace AND the screenshot: ${JSON.stringify(crash.evidenceIds)}`);
    const sources = crash.evidenceIds.map((id) => {
      assert(catalogue.has(id), `blocker evidence ${id} is not in this record's catalogue`);
      return catalogue.get(id).sourceEvidenceId;
    });
    assert(sources.includes(`EV-${PATH_ID}-load-failure`), `the failure trace must be cited: ${JSON.stringify(sources)}`);
    assert(sources.includes(`EV-${PATH_ID}-0-load-failure-png`), `the screenshot must be cited: ${JSON.stringify(sources)}`);
    assert(
      !sources.some((s) => s === `EV-${PATH_ID}-0-before-png`),
      "the shimmed retry's own screens share this path and attempt and must NOT be swept in",
    );
  });

  test("the shim that made the rest of the run possible is itself a blocker on every later observation", async () => {
    const { record } = await assembleD33(testEnv());
    const shim = record.blockers.find((b) => b.kind === "OBSERVATIONS_MADE_AGAINST_SHIMMED_TARGET");
    assert(shim, `a run whose walks were shimmed must say so: ${JSON.stringify(record.blockers.map((b) => b.kind))}`);
    assert(
      shim.detail.includes("1 of 2 walk(s)"),
      `the caveat must be counted, not asserted: ${shim.detail}`,
    );
  });

  test("NO LEDGER IS NOT A CLEAN LEDGER: a run with no execution progress blocks on saying so", async () => {
    const { record } = await assembleD33(testEnv(), { walks: null, crashEvidence: false });
    const kinds = record.blockers.map((b) => b.kind);
    assert(
      kinds.includes("EXECUTION_LEDGER_UNAVAILABLE"),
      `"we cannot say whether the target loaded" must not read as "it loaded fine": ${JSON.stringify(kinds)}`,
    );
    assert(
      !kinds.includes("TARGET_FAILED_TO_LOAD"),
      "an absent ledger is not evidence of a crash either — it accuses nobody",
    );
  });

  test("an EMPTY ledger is a different fact from a MISSING one and blocks nothing", async () => {
    const { record } = await assembleD33(testEnv(), { walks: [], crashEvidence: false });
    assertEq(
      JSON.stringify(record.blockers),
      "[]",
      "a ledger that recorded no walk has looked and found nothing to block on",
    );
  });

  test("a failing case citing an observation the record does not carry is NAMED, never quietly dropped", async () => {
    // `deriveClaims` cannot emit a pointer to something absent — so the alternative to naming it
    // is a shorter findings list with no explanation, which is the "quietly shorter list"
    // CLAUDE.md forbids. The stage takes `itemResults` as a parameter, so this drives the real
    // assembler with a verdict whose cited observation was never committed.
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedD33(mod, env, { walks: [], crashEvidence: false });
    const derived = await mod.deriveVerdicts.deriveItemResults(env, seeded.runId);
    const doctored = derived.value.itemResults.map((r) =>
      r.requirementLineageId !== "req_ty94r6fg57gn"
        ? r
        : {
            ...r,
            facetResults: r.facetResults.map((f) =>
              f.status !== "fail" ? f : { ...f, observationIds: ["obs_never_committed"] },
            ),
          },
    );
    const assembled = await mod.assembleRecord.assembleRecord(env, seeded.runId, doctored);
    assertEq(assembled.state, "evaluated", `${assembled.reason ?? ""} ${assembled.detail ?? ""}`);
    const record = await (await env.EVIDENCE.get(mod.keys.recordKey(seeded.runId))).json();

    const orphan = record.blockers.find((b) => b.kind === "UNRESOLVED_FAIL_OBSERVATION");
    assert(orphan, `the hole must be named: ${JSON.stringify(record.blockers.map((b) => b.kind))}`);
    assertEq(JSON.stringify(orphan.observationRefs), JSON.stringify(["obs_never_committed"]));
    assert(orphan.detail.includes("req_ty94r6fg57gn"), `the blocker must name the requirement: ${orphan.detail}`);
    assert(
      !record.claims.some((c) => c.observationRefs.includes("obs_never_committed")),
      "a claim is a POINTER; one pointing at an observation the record does not carry is worse than none",
    );
  });

  test("the stage's reported counts are the STORED record's counts — it cannot report findings it did not persist", async () => {
    const { assembled, record } = await assembleD33(testEnv());
    assertEq(assembled.value.claims, record.claims.length, "the stage counted claims the stored record does not carry");
    assertEq(assembled.value.blockers, record.blockers.length, "the stage counted blockers the stored record does not carry");
    assert(assembled.value.claims > 0 && assembled.value.blockers > 0, "this fixture must produce both, or the equality is vacuous");
    for (const b of record.blockers) {
      assertEq(b.derivedBy, "v2-blocker-projection/1.1.0", "every blocker names the projection that derived it");
    }
  });
});

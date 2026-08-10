/**
 * D41 — THE SIGNED RECORD MUST NOT CERTIFY THE EMPTIEST POSSIBLE VIEW OF A RUN.
 *
 * ============================== THE DEFECT ==============================
 *
 * A forensic review of runs 4 and 5 established that the RunRecord is assembled and
 * Ed25519-signed BEFORE the judgement stage runs. Run 4 was signed at 02:28:03; `mint-judgement`
 * then failed with EVIDENCE_NAME_COLLISION at 02:29:57, visible only in stdout. At signing time
 * `claims`, `blockers`, `ambiguities`, `taxonomyGaps`, `attempts` and `modelCalls` were all
 * structurally empty and `targetBuildId` was null, so the record could not even state what was
 * tested. Run 5 — the first real defects this product ever found — is permanently signed with
 * `claims: []`.
 *
 * A customer who verifies that signature gets cryptographic confidence in an artifact
 * structurally incapable of containing a failure.
 *
 * ====================== WHY THE ORDER IS NOT THE FIX ======================
 *
 * `mintJudgement` READS the record and binds its JudgementRecord to that record's own
 * `attestation.payloadHash`. A record carrying the judgement's outcome would have to contain a
 * hash of itself. Signing later does not remove the circularity; it breaks the binding. So
 * revision 1 is signed before the judge — correctly — and a SECOND signed revision supersedes
 * it after `mint-judgement` and `close-test-axis` have both run.
 *
 * SUPERSEDE, NEVER MUTATE, and these tests hold that literally: revision 1's bytes must still
 * be readable, unchanged, and still verify under the same key AFTER revision 2 exists.
 *
 * ========================= WHAT ELSE IS UNDER TEST =========================
 *
 *   - `attempts: []` was re-deadened at the fixed call site, one field over from `claims`.
 *     It is now derived from the execution ledger and cannot be omitted.
 *   - `ambiguities` and `taxonomyGaps` were hardcoded `[]` in the assembler while both sources
 *     sat in the inputs it already held.
 *   - THE GUARD: a record containing fail verdicts MUST carry claims. It refuses at the write
 *     boundary, so a record showing a clean survey over failing verdicts never reaches storage.
 *
 * THE FIXTURE IS RUN 5, REDUCED — the same shape `d33-claims-wire.test.mjs` uses, with the real
 * observation ids, the real verifier reason codes and the verifier's own detail strings from
 * `v2r_01kzfktf3qj9qazn86t1y0yx5k` (227 requirements: 223 incomplete, 2 pass, 2 fail), extended
 * with the ambiguity, the expectation gaps and the walk ledger the record now has to carry.
 *
 * Evidence these tests can fail: `tools/mutate-closure.mjs`.
 */

import { assert, assertEq, assertThrows, fakeStep, sha256, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { FIXTURE_KEY, passingGates } from "../fixtures/v2-fixture.mjs";

const signingEnv = () =>
  testEnv({ RECORD_SIGNING_KEY: FIXTURE_KEY.privateKeyPem, RECORD_SIGNING_KEY_ID: FIXTURE_KEY.keyId });

const enc = new TextEncoder();

// The two verifier verdicts run 5 actually produced, verbatim.
const ROUTE_DETAIL = "the document routes to Q9; the walk reached a screen whose own controls are named after Q8";
const BOUNDARY_DETAIL =
  "the document requires this input to be rejected; the survey advanced and raised no message it was not already showing";
const INSUFFICIENT_DETAIL =
  "the sealed boundary case states no expected outcome, so there is nothing to check the walk against";
// The page error the target actually threw (`var history = []` under strict mode).
const CRASH_MESSAGE = "Cannot set property history of #<Window> which has only a getter";

const PATH_ID = "FLOOR-01";
const ATTEMPT_ID = "att_d41crash01";

// The ambiguous passage. Its `displayQuote` is what the checklist ambiguity's `doc_quote` must
// equal EXACTLY for the two to bind — the binding rule is exact-or-absent, never fuzzy.
const AMBIGUOUS_QUOTE = "Respondents under 18 should not continue.";
const READING_A = "the survey terminates the respondent";
const READING_B = "the survey skips the remaining questions but still submits";

// ---------------------------------------------------------------------------
// The sealed contract
// ---------------------------------------------------------------------------

const req = (id, facet, statement, over = {}) => ({
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
  ...over,
});

const facetInstance = (id, requirementLineageId, kind, expectationGap = null) => ({
  facetInstanceId: id,
  requirementLineageId,
  requirementVersionId: requirementLineageId.replace("req_", "reqv_"),
  caseVersionId: `cv_${id}`,
  floorCase: true,
  targetQuestionId: "Q8",
  expansionCertificate: `cert_${id}`,
  case: { kind, routeAnswer: null, boundaryInput: null, configuration: null, expectedDestination: null },
  expectationGap,
  screen: "Q8",
  label: id,
});

const contractBodyD41 = ({ reuseInputsHash, documentSha256 = "d".repeat(64) } = {}) => ({
  schemaVersion: "v2-contract-revision/1.0.0",
  kind: "survey-qa-v2-contract-revision",
  documentRevisionId: documentSha256,
  documentSha256,
  sealedAt: "2026-08-08T00:00:00.000Z",
  requirements: [
    req("req_ty94r6fg57gn", "routing", "If Q8 is Yes, go to Q9."),
    req("req_1xc0tm90zzvr", "boundary", "An age below 18 must be rejected."),
    req("req_clean0000001", "option-set", 'Option 1 with answer text "Yes" is displayed on Q8.'),
    // THE AMBIGUOUS ONE. The seal keeps the STATUS; only the run's checklist keeps the readings.
    req("req_ambig00000001", "copy", AMBIGUOUS_QUOTE, { assertionStatus: "ambiguous" }),
  ],
  facetInstances: [
    facetInstance("fi_route_fail", "req_ty94r6fg57gn", "routing"),
    facetInstance("fi_route_blocked", "req_ty94r6fg57gn", "routing"),
    facetInstance("fi_bound_fail", "req_1xc0tm90zzvr", "boundary"),
    facetInstance("fi_bound_insufficient", "req_1xc0tm90zzvr", "boundary"),
    facetInstance("fi_clean_pass", "req_clean0000001", "option-set"),
    // TWO SEALED CASES NOTHING CAN DECIDE. Both carry the expander's own closed code, and both
    // used to vanish: the record declared `taxonomyGaps: []` whatever the revision said.
    facetInstance("fi_ambig_gap", "req_ambig00000001", "copy", {
      code: "NO_TYPED_PREDICATE_FOR_KIND",
      detail: "no model-free predicate exists for a copy case; the model verifier is not wired",
    }),
    facetInstance("fi_route_gap", "req_ty94r6fg57gn", "routing", {
      code: "ROUTE_DESTINATION_NOT_STATED",
      detail: 'the document says "go to the next relevant question" and names no destination',
    }),
  ],
  contractSupplements: [],
  extraction: {
    ...(reuseInputsHash === undefined ? {} : { reuseInputsHash }),
    passAHash: "sha256:aaa",
    passBHash: "sha256:bbb",
    sourceLedgerHash: "sha256:ccc",
    diffHash: "sha256:ddd",
    reviewMode: "high-risk-only",
    reviewedBy: "d41-fixture",
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
  attestation: {
    producedBy: "v2-executor",
    producerVersion: "v2-observation-projection/1.0.0",
    payloadHash: `sha256:${"0".repeat(64)}`,
  },
});

function observationsFor(evidenceId) {
  return [
    observation({
      observationId: "obs_5886a62b2a58d253d27b",
      facetInstanceId: "fi_route_fail",
      decision: "contradicted",
      predicate: "route-destination/1.0.0",
      reason: "ROUTE_DESTINATION_MISMATCH",
      detail: ROUTE_DETAIL,
      evidenceIds: [evidenceId("EV-D41-ROUTE")],
    }),
    observation({
      observationId: "obs_blocked00000000001",
      facetInstanceId: "fi_route_blocked",
      decision: "contradicted",
      predicate: "route-destination/1.0.0",
      reason: "ROUTE_DESTINATION_MISMATCH",
      detail: ROUTE_DETAIL,
      evidenceIds: [evidenceId("EV-D41-BLOCKED")],
    }),
    observation({
      observationId: "obs_6f0d49494a4a4b571bba",
      facetInstanceId: "fi_bound_fail",
      decision: "contradicted",
      predicate: "boundary-outcome/1.0.0",
      reason: "BOUNDARY_NOT_REJECTED",
      detail: BOUNDARY_DETAIL,
      evidenceIds: [evidenceId("EV-D41-BOUND")],
    }),
    observation({
      observationId: "obs_2601e6636d45714eaeba",
      facetInstanceId: "fi_bound_insufficient",
      decision: "insufficient",
      predicate: "boundary-outcome/1.0.0",
      reason: "NO_TYPED_EXPECTATION",
      detail: INSUFFICIENT_DETAIL,
      evidenceIds: [evidenceId("EV-D41-INSUFF")],
    }),
    observation({
      observationId: "obs_clean000000000001",
      facetInstanceId: "fi_clean_pass",
      decision: "verified",
      predicate: "option-present/1.0.0",
      reason: "OPTION_PRESENT",
      detail: "the option the document names is displayed",
      evidenceIds: [evidenceId("EV-D41-CLEAN")],
    }),
  ];
}

// ---------------------------------------------------------------------------
// The execution ledger — the crashed walk and the shimmed retry, under ONE attempt id
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
  steps: 0,
  wallMs: 400,
  screensAdvanced: 0,
  exercised: false,
  evidenceCount: 2,
  at: "2026-08-08T02:51:49.600Z",
});

const SHIMMED_RETRY = walk({ shimmed: true, caseIds: ["fi_route_fail", "fi_bound_fail"] });

/** The extraction's own checklist — the ONLY place the competing readings survive. */
const CHECKLIST = {
  schema_version: "v2-extract-checklist/1.0.0",
  obligations: [{ id: "req_ambig00000001", doc_quote: AMBIGUOUS_QUOTE, statement: AMBIGUOUS_QUOTE }],
  ambiguities: [
    {
      id: "AMB-B-01",
      doc_quote: AMBIGUOUS_QUOTE,
      reading_a: READING_A,
      reading_b: READING_B,
      why_ambiguous: '"should not continue" does not say whether the interview ends or the questions are skipped',
      affects: ["Q2"],
    },
    // An ambiguity whose quote matches NO sealed requirement. It must still be reported —
    // unbound and saying so — rather than dropped into a quietly shorter list.
    {
      id: "AMB-A-07",
      doc_quote: "Section C is optional for pilot markets.",
      reading_a: "the whole section may be skipped",
      reading_b: "the section is shown but every question is optional",
      why_ambiguous: "the document does not say who decides",
      affects: [],
    },
  ],
  unverifiable_from_browser: [],
};

async function seedD41(mod, env, { walks = [CRASHED_WALK, SHIMMED_RETRY], checklist = CHECKLIST } = {}) {
  const runId = mod.ids.mintRunId();
  const { contractRevisionId, contractHash } = await mod.contractRevision.sealContract(env, contractBodyD41());

  const cap = { env, runId, attemptId: ATTEMPT_ID, pathId: PATH_ID, witnesses: [] };
  await mod.capture.captureFailure(
    cap,
    { what: "the survey threw during load and rendered no interactive control", pageErrors: [CRASH_MESSAGE], shimmed: false },
    "load-failure",
  );
  await mod.capture.captureScreenshot(cap, enc.encode("PNG-AT-FAILURE"), "load-failure", 0);

  const minted = new Map();
  for (const source of ["EV-D41-ROUTE", "EV-D41-BLOCKED", "EV-D41-BOUND", "EV-D41-INSUFF", "EV-D41-CLEAN"]) {
    const entry = await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode(`walk artifact ${source}`),
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

  const observations = observationsFor((source) => {
    const id = minted.get(source);
    if (!id) throw new Error(`fixture bug: no catalogue entry minted for ${source}`);
    return id;
  });

  await env.EVIDENCE.put(mod.keys.observationsKey(runId), JSON.stringify({ observations }), {
    httpMetadata: { contentType: "application/json" },
  });

  if (checklist !== null) {
    await env.EVIDENCE.put(mod.deriveVerdicts.runChecklistKey(runId), JSON.stringify(checklist), {
      httpMetadata: { contentType: "application/json" },
    });
  }

  if (walks !== null) {
    await env.EVIDENCE.put(
      mod.keys.k("runs", runId, "execution", "progress.json"),
      JSON.stringify({
        kind: "v2-execution-progress/1.0.0",
        runId,
        planRevisionId: "plan_d41",
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
      documentName: "d41.docx",
      // NOTHING RECORDED AND NOTHING CONFIGURED — run 5's own situation, and the reason its
      // record said `targetBuildId: null` while the report independently derived an id.
      targetBuildId: null,
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
      total: 7,
      requirements: { total: 4, ambiguous: 1, disputed: 0, notBrowserObservable: 0 },
    };
    // Five cases observed, one blocked by the cursor, one never reached. The seven buckets must
    // reconcile to the sealed total or `updateCheckpoint` refuses the write.
    d.counts = { ...d.counts, exercised: 5, blocked: 1, "not-reached": 1, pending: 0 };
    d.execution = { ...d.execution, pendingCaseIds: ["fi_route_blocked"], planRevisionId: "plan_d41" };
    d.completion = { test: "partial-blocked", report: "not-started", reasonCode: "coverage-shortfall-unexercised" };
  });

  return { runId, contractRevisionId, contractHash };
}

/** The real chain, and every record read back from storage rather than from a return value. */
async function assembleD41(env, opts = {}) {
  const mod = await worker();
  const seeded = await seedD41(mod, env, opts);
  const derived = await mod.deriveVerdicts.deriveItemResults(env, seeded.runId);
  assertEq(derived.state, "evaluated", `the aggregator must run: ${derived.reason ?? ""} ${derived.detail ?? ""}`);
  const assembled = await mod.assembleRecord.assembleRecord(env, seeded.runId, derived.value.itemResults);
  assertEq(assembled.state, "evaluated", `the record must assemble: ${assembled.reason ?? ""} ${assembled.detail ?? ""}`);
  const record = await (await env.EVIDENCE.get(mod.keys.recordKey(seeded.runId))).json();
  return { mod, env, ...seeded, derived, assembled, record };
}

/** A closure block in the shape `run-workflow.ts#supersede-record` builds. */
const closureOf = ({ minted, status = null, reasonCode = null, detail = null, boundRecordHash, closed = false }) => ({
  judgement: { minted, status, reasonCode, detail, boundRecordHash },
  testAxis: {
    closed,
    completion: closed ? "complete" : "partial-blocked",
    reasonCode: closed ? null : "coverage-shortfall-unexercised",
    blockers: closed ? [] : ["1 requirement(s) are still incomplete"],
  },
  closedAt: "2026-08-08T02:30:10.000Z",
  derivedBy: "v2-run-closure/1.0.0",
});

// ===========================================================================
suite("D41 — the run's own account is signed AFTER the run has an ending", () => {
  /**
   * THE HEADLINE. Revision 1 is the document the judge binds to and cannot contain the
   * judgement's outcome; revision 2 does, is signed, and names the hash it replaces.
   */
  test("THE ONE THAT MATTERS: run 5's judgement failure reaches a SIGNED record instead of stdout", async () => {
    const { mod, env, runId, assembled, record } = await assembleD41(signingEnv());

    assert(assembled.value.signed, "this test says SIGNED; without a key it asserts on an unsigned record");
    assertEq(record.recordRevision.revision, 1, "the record the judge binds to is revision 1");
    assertEq(record.recordRevision.supersedes, null, "revision 1 supersedes nothing");
    assertEq(record.closure, null, "nothing had closed when revision 1 was signed — saying otherwise would be a lie");

    // Run 4's real ending: the judge refused because two catalogued artifacts shared a basename.
    const closure = closureOf({
      minted: false,
      reasonCode: "EVIDENCE_NAME_COLLISION",
      detail: "two catalogued artifacts resolve to the same basename, so the evidence mount would lose one",
      boundRecordHash: assembled.value.recordHash,
    });
    const superseded = await mod.assembleRecord.supersedeRecord(env, runId, closure, "the judgement ran after signing");
    assertEq(superseded.state, "evaluated", `${superseded.reason ?? ""} ${superseded.detail ?? ""}`);

    const head = await (await env.EVIDENCE.get(mod.keys.recordKey(runId))).json();
    assertEq(head.recordRevision.revision, 2, "the head must now be the superseding revision");
    assertEq(head.recordRevision.supersedes.recordHash, assembled.value.recordHash, "revision 2 must name what it replaces");
    assertEq(head.recordRevision.supersedes.revision, 1);
    assertEq(head.closure.judgement.minted, false, "the record must be able to say the second opinion never happened");
    assertEq(head.closure.judgement.reasonCode, "EVIDENCE_NAME_COLLISION");
    assertEq(
      head.closure.judgement.boundRecordHash,
      assembled.value.recordHash,
      "a reader must be able to check WHICH record the judgement was about",
    );
    assert(head.attestation?.payloadHash, "the superseding revision is itself signed, or it certifies nothing");
    assert(
      head.attestation.payloadHash !== assembled.value.recordHash,
      "a revision that added closure and kept the same payload hash did not add it",
    );
  });

  test("SUPERSEDE, NEVER MUTATE: revision 1 is still readable, unchanged, and still verifies", async () => {
    const { mod, env, runId, assembled, record } = await assembleD41(signingEnv());
    const before = JSON.stringify(record);

    const superseded = await mod.assembleRecord.supersedeRecord(
      env,
      runId,
      closureOf({ minted: true, status: "publishable", boundRecordHash: assembled.value.recordHash, closed: true }),
      "closure",
    );
    assertEq(superseded.state, "evaluated");

    const archived = await env.EVIDENCE.get(mod.keys.recordArchiveKey(runId, assembled.value.recordHash));
    assert(archived, "revision 1 must remain addressable, or the judgement's binding resolves to nothing");
    const archivedBody = await archived.text();
    assertEq(archivedBody, before, "the prior revision's BYTES must be identical — this is the sealed-artifact invariant");

    // AND IT STILL VERIFIES UNDER THE SAME KEY. Byte equality is not enough on its own: the
    // point of the invariant is that a customer holding revision 1 can still authenticate it,
    // so the Ed25519 check is run, not assumed.
    const { verifyAttestation } = await import("../../../scorer/src/lib/attest.mjs");
    const verdict = verifyAttestation(JSON.parse(archivedBody), {
      keys: { [FIXTURE_KEY.keyId]: { publicKeyPem: FIXTURE_KEY.publicKeyPem } },
    });
    assert(verdict.ok === true, `revision 1 must still verify after being superseded: ${JSON.stringify(verdict)}`);

    // And so does revision 2 — a superseding revision that could not be authenticated would be
    // a downgrade dressed as a fix.
    const head = await (await env.EVIDENCE.get(mod.keys.recordKey(runId))).json();
    const headVerdict = verifyAttestation(head, {
      keys: { [FIXTURE_KEY.keyId]: { publicKeyPem: FIXTURE_KEY.publicKeyPem } },
    });
    assert(headVerdict.ok === true, `revision 2 must verify too: ${JSON.stringify(headVerdict)}`);
  });

  test("the two revisions differ ONLY in the two fields a supersede is allowed to add", async () => {
    const { mod, env, runId, assembled, record } = await assembleD41(signingEnv());
    await mod.assembleRecord.supersedeRecord(
      env,
      runId,
      closureOf({ minted: true, status: "publishable", boundRecordHash: assembled.value.recordHash, closed: true }),
      "closure",
    );
    const head = await (await env.EVIDENCE.get(mod.keys.recordKey(runId))).json();

    const differing = [...new Set([...Object.keys(record), ...Object.keys(head)])].filter(
      (k) => JSON.stringify(record[k]) !== JSON.stringify(head[k]),
    );
    assertEq(
      JSON.stringify(differing.sort()),
      JSON.stringify(["attestation", "closure", "recordRevision"]),
      `a supersede that re-states the run is a second opinion, not a supersede: ${JSON.stringify(differing)}`,
    );
    // The findings themselves must be carried forward, not recomputed into agreement.
    assertEq(JSON.stringify(head.claims), JSON.stringify(record.claims));
    assertEq(JSON.stringify(head.itemResults), JSON.stringify(record.itemResults));
  });

  /**
   * THE REGRESSION SUPERSEDING WOULD OTHERWISE HAVE CAUSED, AND THE PROOF IT DOES NOT.
   *
   * `store/judgement.ts#checkJudgementBinding` recomputes the payload hash of whatever record is
   * stored at `record.json` and requires the JudgementRecord to name it. A judgement can only
   * ever have judged revision 1 — it runs before closure exists — so moving that pointer to a
   * superseding revision would have failed the `run-payload-hash` gate on EVERY run and demoted
   * every re-derived column to `unusable`. That would be a regression in exactly the artifact
   * this change exists to repair.
   *
   * The negative half is the load-bearing half: a judgement naming a hash that appears nowhere in
   * this record's chain must STILL fail, or the gate has been traded away rather than fixed.
   */
  test("A JUDGEMENT BOUND TO REVISION 1 STILL BINDS after revision 2 replaces it", async () => {
    const { mod, env, runId, assembled, contractRevisionId, contractHash } = await assembleD41(signingEnv());
    const rev1Hash = assembled.value.recordHash;

    await mod.assembleRecord.supersedeRecord(
      env,
      runId,
      closureOf({ minted: true, status: "publishable", boundRecordHash: rev1Hash, closed: true }),
      "closure",
    );
    const head = await (await env.EVIDENCE.get(mod.keys.recordKey(runId))).json();

    // The head really is a different document by hash, or this test proves nothing.
    const headHash = await mod.judgement.runRecordPayloadHash(head);
    assert(headHash !== rev1Hash, "revision 2 must hash differently, or the gate was never under pressure");

    const facts = { runId, record: head, contractRevisionId, contractHash, targetBuildId: "build_d41" };
    const bound = { binding: { runId, runRecordPayloadHash: rev1Hash, contractRevisionId, targetBuildId: "build_d41" } };
    const payloadCheck = (await mod.judgement.checkJudgementBinding(bound, facts)).find(
      (c) => c.id === "run-payload-hash",
    );
    assert(
      payloadCheck.ok,
      `a judgement of revision 1 must survive revision 2: expected ${payloadCheck.expected}, named ${payloadCheck.actual}`,
    );
    assert(
      /supersedes/.test(payloadCheck.detail),
      `and the report must SAY it matched an earlier revision rather than the current one: ${payloadCheck.detail}`,
    );

    // AND AT DEPTH 2. `supersedes.recordHash` only ever names the revision immediately before
    // this one, so a third revision would orphan a judgement bound to the first unless the
    // original hash is carried forward. A retried closure step is enough to produce one.
    await mod.assembleRecord.supersedeRecord(
      env,
      runId,
      closureOf({ minted: true, status: "publishable", boundRecordHash: rev1Hash, closed: true }),
      "closure, recorded again",
    );
    const third = await (await env.EVIDENCE.get(mod.keys.recordKey(runId))).json();
    assertEq(third.recordRevision.revision, 3, "the fixture must actually reach depth 2");
    assertEq(
      third.recordRevision.originalRecordHash,
      rev1Hash,
      "revision 1's hash must be carried forward, not just the immediate predecessor's",
    );
    const deepCheck = (
      await mod.judgement.checkJudgementBinding(bound, { ...facts, record: third })
    ).find((c) => c.id === "run-payload-hash");
    assert(deepCheck.ok, `the binding must survive a chain of any depth: ${JSON.stringify(deepCheck)}`);

    // THE NEGATIVE. A hash from nowhere in this chain is still a different record.
    const foreign = {
      binding: { runId, runRecordPayloadHash: `sha256:${"9".repeat(64)}`, contractRevisionId, targetBuildId: "build_d41" },
    };
    const foreignCheck = (await mod.judgement.checkJudgementBinding(foreign, facts)).find(
      (c) => c.id === "run-payload-hash",
    );
    assert(!foreignCheck.ok, "a judgement of an unrelated record must still fail the binding");
  });

  test("RUN 5'S CLAIMS, IN THE SUPERSEDING RECORD: the two defects it actually found", async () => {
    const { mod, env, runId, assembled } = await assembleD41(signingEnv());
    await mod.assembleRecord.supersedeRecord(
      env,
      runId,
      closureOf({ minted: false, reasonCode: "EVIDENCE_NAME_COLLISION", boundRecordHash: assembled.value.recordHash }),
      "closure",
    );
    const head = await (await env.EVIDENCE.get(mod.keys.recordKey(runId))).json();

    assertEq(head.claims.length, 2, `exactly the two run 5 found: ${JSON.stringify(head.claims.map((c) => c.claimType))}`);
    const byType = new Map(head.claims.map((c) => [c.claimType, c]));

    const route = byType.get("ROUTE_DESTINATION_MISMATCH");
    assert(route, `the route defect must survive into revision 2: ${JSON.stringify([...byType.keys()])}`);
    assertEq(route.normativeRef.requirementLineageId, "req_ty94r6fg57gn");
    assertEq(JSON.stringify(route.observationRefs), JSON.stringify(["obs_5886a62b2a58d253d27b"]));
    assertEq(route.prose, ROUTE_DETAIL, "the claim's prose is the verifier's own sentence");

    const boundary = byType.get("BOUNDARY_NOT_REJECTED");
    assert(boundary, `the boundary defect must survive into revision 2: ${JSON.stringify([...byType.keys()])}`);
    assertEq(boundary.normativeRef.requirementLineageId, "req_1xc0tm90zzvr");
    assertEq(JSON.stringify(boundary.observationRefs), JSON.stringify(["obs_6f0d49494a4a4b571bba"]));
    assertEq(boundary.prose, BOUNDARY_DETAIL);

    // And the load crash, which is a fact about the whole run rather than about one requirement.
    assert(
      head.blockers.some((b) => b.kind === "TARGET_FAILED_TO_LOAD" && b.detail === CRASH_MESSAGE),
      `the crash must still qualify every verdict in revision 2: ${JSON.stringify(head.blockers.map((b) => b.kind))}`,
    );
  });
});

// ===========================================================================
suite("D41 — a record that fails something must say what", () => {
  /**
   * THE GUARD FABLE NAMED: a record containing fail verdicts MUST carry nonzero claims. It is
   * checked at the WRITE BOUNDARY, beside `rejectModelDerivedVerdicts`, so it survives a future
   * edit to the projection that derives claims — which is exactly the edit that produced the
   * original defect.
   */
  test("THE GUARD: a record whose failing verdicts reach it unclaimed is REFUSED, not stored", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedD41(mod, env);
    const derived = await mod.deriveVerdicts.deriveItemResults(env, seeded.runId);

    // A failing case whose observations are stripped: the projections can produce neither a
    // claim (nothing to point at) nor an UNRESOLVED_FAIL_OBSERVATION blocker (no id to name).
    // That is the shape of a record showing a clean survey over a real failure.
    const doctored = derived.value.itemResults.map((r) => ({
      ...r,
      facetResults: r.facetResults.map((f) => (f.status === "fail" ? { ...f, observationIds: [] } : f)),
    }));
    const out = await mod.assembleRecord.assembleRecord(env, seeded.runId, doctored);

    assertEq(out.state, "not-evaluated", "a record that hides its failures must not be assembled");
    assertEq(out.reason, "UNACCOUNTED_FAILURES");
    assert(
      out.detail.includes("req_ty94r6fg57gn") && out.detail.includes("req_1xc0tm90zzvr"),
      `the refusal must name the failing cases it could not account for: ${out.detail}`,
    );
    assertEq(
      await env.EVIDENCE.get(mod.keys.recordKey(seeded.runId)),
      null,
      "REFUSING MEANS NOTHING IS STORED. A signed record showing a clean survey over failing verdicts is the " +
        "one artifact this system must never produce, and a half-written one is the same artifact.",
    );
  });

  /**
   * THE GUARD IS PER FAILING CASE, and this is the position a record-level "claims must be
   * nonempty" check waves through: one defect published, another silently missing. A reader of
   * that record sees a survey with one problem and no reason to suspect a second.
   */
  test("THE GUARD IS PER-CASE: one claimed failure does not excuse an unclaimed one", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedD41(mod, env);
    const derived = await mod.deriveVerdicts.deriveItemResults(env, seeded.runId);

    const doctored = derived.value.itemResults.map((r) =>
      r.requirementLineageId !== "req_1xc0tm90zzvr"
        ? r
        : { ...r, facetResults: r.facetResults.map((f) => (f.status === "fail" ? { ...f, observationIds: [] } : f)) },
    );
    const out = await mod.assembleRecord.assembleRecord(env, seeded.runId, doctored);

    assertEq(out.state, "not-evaluated", "a record carrying one claim and one hidden failure must still be refused");
    assertEq(out.reason, "UNACCOUNTED_FAILURES");
    assert(
      out.detail.includes("req_1xc0tm90zzvr") && !out.detail.includes("req_ty94r6fg57gn"),
      `the refusal must name the unaccounted case and only it: ${out.detail}`,
    );
    assert(
      /1 of 2 failing case/.test(out.detail),
      `and it must say the record was not empty — that is what a record-level check would miss: ${out.detail}`,
    );
  });

  test("THE COUNTERWEIGHT: the guard does not fire on the run it is meant to allow", async () => {
    const { record } = await assembleD41(testEnv());
    assert(record.claims.length > 0, "the healthy fixture must produce claims, or the counterweight is vacuous");
    assert(
      record.itemResults.some((r) => r.verdict === "fail" || r.verdict === "mixed"),
      "and it must genuinely contain failing verdicts, or the guard was never reached",
    );
  });

  test("the honest branch survives: a failing case whose observation is MISSING is named, not refused", async () => {
    // `deriveClaims` cannot point at an observation the record does not carry, so the accounting
    // accepts an UNRESOLVED_FAIL_OBSERVATION blocker instead. A guard that refused here would
    // turn the honest disclosure into a lost run.
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedD41(mod, env);
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
    const out = await mod.assembleRecord.assembleRecord(env, seeded.runId, doctored);
    assertEq(out.state, "evaluated", `${out.reason ?? ""} ${out.detail ?? ""}`);
    const record = await (await env.EVIDENCE.get(mod.keys.recordKey(seeded.runId))).json();
    assert(
      record.blockers.some((b) => b.kind === "UNRESOLVED_FAIL_OBSERVATION"),
      "the hole must still be named rather than refused into silence",
    );
  });
});

// ===========================================================================
suite("D41 — the fields the record declared empty while the data sat in its inputs", () => {
  test("ATTEMPTS ARE DERIVED: the execution ledger reaches the record, crashed walk and all", async () => {
    const { record } = await assembleD41(testEnv());
    assertEq(record.attempts.length, 2, `one row per walk: ${JSON.stringify(record.attempts)}`);

    const [crash, retry] = record.attempts;
    assertEq(crash.pathId, "FLOOR-01");
    assertEq(crash.attemptNumber, 1);
    assertEq(crash.ok, false, "a walk that crashed on load is not ok however it finished");
    assertEq(crash.stopReason, "load-crash", "the stop reason is the driver's own closed word");
    assertEq(crash.startedAt, "2026-08-08T02:51:49.200Z", "start is end minus duration — both recorded, neither guessed");
    assertEq(crash.endedAt, "2026-08-08T02:51:49.600Z");
    assertEq(crash.derivedBy, "v2-attempt-projection/1.0.0");

    assertEq(retry.attemptNumber, 2, "the retry is the second walk of its path");
    assertEq(retry.ok, true);
    assertEq(JSON.stringify(retry.targetCaseIds), JSON.stringify(["fi_route_fail", "fi_bound_fail"]));
    assertEq(
      retry.retryOfAttemptId,
      crash.attemptId,
      "a crashed path is retried under the SAME attempt id; the record states the ledger's fact rather than minting one",
    );
    assertEq(retry.retryReason, "load-crash");
    assert(
      crash.evidenceSharedWithSiblingWalks && retry.evidenceSharedWithSiblingWalks,
      "two walks sharing a path AND an attempt cannot split the catalogue between them, and the record must say so",
    );
    assert(crash.evidenceIds.length > 0, "the walk's own artifacts must be citable from its attempt row");
  });

  test("A RUN WITH NO LEDGER HAS NO ATTEMPTS, and that is not the same as a run that ran none", async () => {
    const { record } = await assembleD41(testEnv(), { walks: null });
    assertEq(JSON.stringify(record.attempts), "[]");
    assert(
      record.blockers.some((b) => b.kind === "EXECUTION_LEDGER_UNAVAILABLE"),
      "an empty attempt list with no blocker beside it reads as a run that simply did nothing",
    );
  });

  test("AMBIGUITIES ARE DERIVED, with the extraction's own readings verbatim", async () => {
    const { record } = await assembleD41(testEnv());
    const bound = record.ambiguities.find((a) => a.normativeRef?.requirementLineageId === "req_ambig00000001");
    assert(bound, `the sealed ambiguous requirement must appear: ${JSON.stringify(record.ambiguities)}`);
    assertEq(bound.status, "ambiguous");
    assertEq(bound.readingsAvailable, true);
    assertEq(
      JSON.stringify(bound.readings),
      JSON.stringify([READING_A, READING_B]),
      "both readings, verbatim and in the extraction's order — a composed summary is an answer to an open question",
    );
    assertEq(bound.documentQuote, AMBIGUOUS_QUOTE);
    assertEq(bound.derivedBy, "v2-ambiguity-projection/1.0.0");

    const unbound = record.ambiguities.find((a) => a.status === "extraction-declared");
    assert(unbound, "an ambiguity that binds to no sealed requirement must still be reported");
    assertEq(unbound.normativeRef, null, "it is reported UNBOUND rather than attached by guesswork");
    assertEq(unbound.documentQuote, "Section C is optional for pilot markets.");
  });

  test("NO CHECKLIST IS NOT AN UNAMBIGUOUS DOCUMENT: the ambiguity survives, its readings do not", async () => {
    const { record } = await assembleD41(testEnv(), { checklist: null });
    const bound = record.ambiguities.find((a) => a.normativeRef?.requirementLineageId === "req_ambig00000001");
    assert(bound, "the seal alone still knows the requirement is ambiguous");
    assertEq(bound.readingsAvailable, false, "a digest cannot be un-hashed, and the record must say the readings are gone");
    assertEq(JSON.stringify(bound.readings), "[]");
    assertEq(
      record.ambiguities.length,
      1,
      "with no checklist there is nothing unbound to report either — one sealed ambiguity, no invention",
    );
  });

  test("TAXONOMY GAPS ARE DERIVED: every sealed case with no predicate is counted, not dropped", async () => {
    const { record } = await assembleD41(testEnv());
    assertEq(record.taxonomyGaps.length, 2, `both sealed gaps: ${JSON.stringify(record.taxonomyGaps)}`);
    const byCode = new Map(record.taxonomyGaps.map((g) => [g.code, g]));

    const kind = byCode.get("NO_TYPED_PREDICATE_FOR_KIND");
    assert(kind, `the copy case's gap must appear: ${JSON.stringify([...byCode.keys()])}`);
    assertEq(kind.facetInstanceId, "fi_ambig_gap");
    assertEq(kind.caseKind, "copy");
    assertEq(kind.normativeRef.requirementLineageId, "req_ambig00000001");
    assertEq(kind.detail, "no model-free predicate exists for a copy case; the model verifier is not wired");

    const dest = byCode.get("ROUTE_DESTINATION_NOT_STATED");
    assert(dest, "the unstated destination is a limit of this system, and it is counted");
    assertEq(dest.detail, 'the document says "go to the next relevant question" and names no destination');
    for (const g of record.taxonomyGaps) assertEq(g.derivedBy, "v2-taxonomy-gap-projection/1.0.0");
  });

  test("THE RECORD CAN NAME WHAT IT TESTED even with nothing recorded and nothing configured", async () => {
    const { record } = await assembleD41(testEnv());
    assertEq(record.run.targetBuildId, null, "nothing was recorded, and the recorded field must not be invented into");
    assertEq(record.run.targetIdentity.source, "derived");
    assert(
      /^site-sha256:[0-9a-f]{64}$/.test(record.run.targetIdentity.targetBuildId),
      `the identity must be derived from this run's own screens: ${record.run.targetIdentity.targetBuildId}`,
    );
    assert(record.run.targetIdentity.note.length > 0, "and it must say what kind of identity that is");
  });

  /**
   * `resources.modelCalls` is the THIRD wire of this family, and the only one that cannot be
   * connected today: `checkpoint.modelCallLedger` does not exist on `RunCheckpoint` and nothing
   * in the tree writes it. So the empty list stays, and what changes is that it is NAMED — an
   * empty provenance table beside a real spend must not read like a run that made no calls.
   */
  test("AN EMPTY MODEL-CALL LIST SAYS WHICH KIND OF EMPTY IT IS", async () => {
    const { record } = await assembleD41(testEnv());
    assertEq(JSON.stringify(record.resources.modelCalls), "[]", "nothing writes a per-call ledger yet");
    assertEq(
      record.resources.perCallTelemetry,
      "no-calls",
      "the fixture spends nothing, so the empty list IS the complete truth and the record says so",
    );

    // The position that matters: a run that really spent money and kept no per-call rows. Its
    // cost is unfalsifiable from the record alone (DEBRIEF fix #6), and that must be stated.
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedD41(mod, env);
    await mod.checkpoint.updateCheckpoint(env, seeded.runId, (d) => {
      d.usage = { ...d.usage, modelCalls: { ...d.usage.modelCalls, used: 47 }, cost: { ...d.usage.cost, usedUsd: 1.06 } };
    });
    const derived = await mod.deriveVerdicts.deriveItemResults(env, seeded.runId);
    const out = await mod.assembleRecord.assembleRecord(env, seeded.runId, derived.value.itemResults);
    assertEq(out.state, "evaluated", `${out.reason ?? ""} ${out.detail ?? ""}`);
    const spent = await (await env.EVIDENCE.get(mod.keys.recordKey(seeded.runId))).json();
    assertEq(spent.resources.totals.modelCalls, 47);
    assertEq(
      spent.resources.perCallTelemetry,
      "unrecorded",
      "47 calls and an empty provenance table must not be reported as though nothing was spent",
    );
  });

  test("the stage reports what it stored: every derived count is the STORED record's own", async () => {
    const { assembled, record } = await assembleD41(testEnv());
    assertEq(assembled.value.attempts, record.attempts.length);
    assertEq(assembled.value.ambiguities, record.ambiguities.length);
    assertEq(assembled.value.taxonomyGaps, record.taxonomyGaps.length);
    assertEq(assembled.value.claims, record.claims.length);
    assertEq(assembled.value.revision, 1);
    assert(
      assembled.value.attempts > 0 && assembled.value.ambiguities > 0 && assembled.value.taxonomyGaps > 0,
      "this fixture must produce all three, or the equalities above are vacuous",
    );
  });
});

// ===========================================================================
/**
 * D41 (b) — THE SAME BYTES MUST NOT BUY FOUR DIFFERENT DENOMINATORS.
 *
 * Four runs re-extracted IDENTICAL document bytes. They cost about $1.06 and produced 189, 194,
 * 195 and 227 requirements from one document, with the option-set case count alone swinging
 * 48 to 92. The money bought four incompatible answers to what the document requires, and no two
 * of those runs can be compared at all.
 *
 * A sealed revision is now indexed by a digest over everything that could change what a
 * re-extraction would produce, and a later run over identical inputs ADOPTS it. The load-bearing
 * halves are the negatives: a different viewport set and a stale entry must both MISS, because
 * adopting a denominator expanded for another configuration would silently shrink the case set —
 * the "a run that shrinks its own denominator hides the missing execution" failure of D10.
 */
/**
 * THE EXPANDER VERSION IS TAKEN FROM THE SOURCE, NOT WRITTEN DOWN HERE.
 *
 * It was a literal (`v2-floor-expander/1.1.0`) until the expander shipped 1.2.0, and the run
 * under test computes its OWN digest from the real `EXPANDER_VERSION` — so the literal stopped
 * matching, the seeded index entry stopped being found, and the adoption test failed with "the
 * submitted document is missing from storage": the run had fallen through to a real extraction.
 * That failure was correct and its cause was a stale fixture. Reading the constant keeps the
 * ADOPTION tests about adoption; the digest-sensitivity test below still varies the field
 * explicitly, which is where a version's effect on the key belongs.
 */
const reuseInputs = async (mod, env = testEnv()) => ({
  documentSha256: "e".repeat(64),
  docxParserVersion: mod.docxBlocks.DOCX_BLOCKS_VERSION,
  promptVersionA: mod.passA.PASS_A_VERSION,
  promptVersionB: mod.passB.PASS_B_VERSION,
  modelA: "grok-4.3",
  modelB: "deepseek-v4-pro",
  mergeVersion: mod.merge.MERGE_VERSION,
  expanderVersion: mod.expand.EXPANDER_VERSION,
  locale: "en",
  viewports: ["desktop"],
  reviewMode: "high-risk-only",
  policyFingerprint: await mod.contractReuse.extractionPolicyFingerprint(env),
});

/** A run with NO sealed contract of its own, beside an index entry that has one. */
async function seedReusableRun(mod, env, inputs, { pointAt = null, pointHash = null } = {}) {
  const runId = mod.ids.mintRunId();
  const digest = await mod.contractReuse.extractionInputsDigest(inputs);
  const { contractRevisionId, contractHash, revision } = await mod.contractRevision.sealContract(
    env,
    contractBodyD41({ reuseInputsHash: `sha256:${digest}`, documentSha256: inputs.documentSha256.replace(/^sha256:/, "") }),
  );
  const executionCases = mod.contractRevision.denominators(revision).executionCases;

  await mod.envelope.putEnvelope(env, {
    schemaVersion: "v2-run-envelope/1.0.0",
    kind: "survey-qa-v2-envelope",
    runId,
    createdAt: "2026-08-08T02:51:00.000Z",
    instanceId: runId,
    input: {
      surveyUrl: "https://fixture.invalid/survey",
      documentKey: mod.keys.inputDocumentKey(runId),
      documentSha256: inputs.documentSha256,
      documentName: "d41-reuse.docx",
      targetBuildId: null,
      locale: inputs.locale,
      viewports: inputs.viewports,
    },
    profile: "standard",
    // NOT sealed for THIS run — the whole point is that it has no denominator yet.
    contractRevisionId: null,
    recovery: null,
    finalCompletion: null,
  });
  await mod.checkpoint.createCheckpoint(env, mod.checkpoint.initialCheckpoint(env, runId, "standard", false));
  await mod.checkpoint.claimOwnership(env, runId, runId, 0);

  await mod.contractReuse.recordReusableContract(env, digest, {
    contractRevisionId: pointAt ?? contractRevisionId,
    contractHash: pointHash ?? contractHash,
    inputs,
    sealedByRunId: "run_that_paid_for_it",
    sealedAt: "2026-08-08T00:00:00.000Z",
  });

  return { runId, contractRevisionId, contractHash, executionCases };
}

const reusePayload = (runId, inputs) => ({
  payload: {
    runId,
    surveyUrl: "https://fixture.invalid/survey",
    documentKey: `v2/runs/${runId}/input/document.docx`,
    documentSha256: inputs.documentSha256,
    profile: "standard",
    locale: inputs.locale,
    viewports: inputs.viewports,
  },
});

suite("D41 — a contract sealed over identical inputs is reused, not re-bought", () => {
  test("EVERY input is in the key: change any one of them and the digest moves", async () => {
    const mod = await worker();
    const RI = await reuseInputs(mod);
    const base = await mod.contractReuse.extractionInputsDigest(RI);
    assert(/^[0-9a-f]{64}$/.test(base), `the digest must be a sha-256 hex string, got ${base}`);

    const variants = {
      documentSha256: "f".repeat(64),
      docxParserVersion: `${mod.docxBlocks.DOCX_BLOCKS_VERSION}-not`,
      promptVersionA: `${mod.passA.PASS_A_VERSION}-not`,
      promptVersionB: `${mod.passB.PASS_B_VERSION}-not`,
      modelA: "grok-4.4",
      modelB: "deepseek-v5",
      mergeVersion: `${mod.merge.MERGE_VERSION}-not`,
      // DERIVED, so this stays "a different expander" whatever version ships. A literal here
      // silently became the SAME value as the base when the expander shipped 1.2.0, and a
      // sensitivity test whose "changed" value equals the original proves nothing.
      expanderVersion: `${mod.expand.EXPANDER_VERSION}-not`,
      locale: "de",
      viewports: ["desktop", "mobile"],
      reviewMode: "always",
      policyFingerprint: "f".repeat(64),
    };
    for (const [field, value] of Object.entries(variants)) {
      const moved = await mod.contractReuse.extractionInputsDigest({ ...RI, [field]: value });
      assert(
        moved !== base,
        `changing ${field} left the reuse key unchanged, so a run would adopt a denominator computed for ` +
          `different inputs — which is worse than paying for the extraction again`,
      );
    }

    // ...and nothing ELSE moves it. The same configuration spelled with the keys in another
    // order and a `sha256:` prefix on the digest must land on the SAME key, or two identical
    // runs each pay for their own extraction and the drift is back.
    const reordered = await mod.contractReuse.extractionInputsDigest({
      reviewMode: RI.reviewMode,
      policyFingerprint: RI.policyFingerprint,
      viewports: ["desktop"],
      locale: RI.locale,
      mergeVersion: RI.mergeVersion,
      expanderVersion: RI.expanderVersion,
      modelB: RI.modelB,
      modelA: RI.modelA,
      promptVersionB: RI.promptVersionB,
      promptVersionA: RI.promptVersionA,
      docxParserVersion: RI.docxParserVersion,
      documentSha256: `sha256:${RI.documentSha256}`,
    });
    assertEq(reordered, base, "key order and a sha256: prefix must not split one configuration into two keys");

    const orderedViewports = { ...RI, viewports: ["desktop", "mobile"] };
    const reversedViewports = { ...RI, viewports: ["mobile", "desktop"] };
    assert(
      (await mod.contractReuse.extractionInputsDigest(orderedViewports)) !==
        (await mod.contractReuse.extractionInputsDigest(reversedViewports)),
      "viewport order must move the key while consolidation consumes viewports[0]",
    );

    const policyA = await mod.contractReuse.extractionPolicyFingerprint(testEnv());
    const policyB = await mod.contractReuse.extractionPolicyFingerprint(
      testEnv({ GROK_REASONING_EFFORT: "a-different-reasoning-policy" }),
    );
    assert(
      policyA !== policyB,
      "changing a model reasoning policy must invalidate reuse even when document, model name, and prompts are unchanged",
    );
  });

  test("MISSING PARSER IDENTITY CANNOT ADOPT: a legacy entry is a miss even when its own digest re-derives", async () => {
    const mod = await worker();
    const env = testEnv();
    const current = await reuseInputs(mod, env);
    const { docxParserVersion: _missing, ...legacyInputs } = current;
    const legacyDigest = await mod.contractReuse.extractionInputsDigest(legacyInputs);

    await env.EVIDENCE.put(
      mod.contractReuse.contractReuseKey(legacyDigest),
      JSON.stringify({
        kind: mod.contractReuse.CONTRACT_REUSE_VERSION,
        inputsDigest: legacyDigest,
        contractRevisionId: "rev_legacy_parser_unknown",
        contractHash: "hash_legacy_parser_unknown",
        inputs: legacyInputs,
        sealedByRunId: "run_legacy_parser_unknown",
        sealedAt: "2026-08-08T00:00:00.000Z",
      }),
    );

    assertEq(
      await mod.contractReuse.lookupReusableContract(env, legacyDigest),
      null,
      "an entry that cannot name its DOCX parser must never become a denominator under current code",
    );
  });

  test("FIRST WRITER WINS ATOMICALLY: concurrent publishers cannot both record", async () => {
    const mod = await worker();
    const env = testEnv();
    const RI = await reuseInputs(mod, env);
    const digest = await mod.contractReuse.extractionInputsDigest(RI);
    const write = (suffix) =>
      mod.contractReuse.recordReusableContract(env, digest, {
        contractRevisionId: `rev_${suffix}`,
        contractHash: `hash_${suffix}`,
        inputs: RI,
        sealedByRunId: `run_${suffix}`,
        sealedAt: "2026-08-08T00:00:00.000Z",
      });
    const outcomes = await Promise.all([write("a"), write("b")]);
    assertEq(outcomes.filter((outcome) => outcome === "recorded").length, 1, JSON.stringify(outcomes));
    assertEq(outcomes.filter((outcome) => outcome === "already-recorded").length, 1, JSON.stringify(outcomes));
    const held = await mod.contractReuse.lookupReusableContract(env, digest);
    assert(["rev_a", "rev_b"].includes(held.contractRevisionId));
  });

  test("FIRST WRITER WINS: a second seal over the same inputs does not repoint the index", async () => {
    const mod = await worker();
    const env = testEnv();
    const RI = await reuseInputs(mod, env);
    const digest = await mod.contractReuse.extractionInputsDigest(RI);

    assertEq(
      await mod.contractReuse.recordReusableContract(env, digest, {
        contractRevisionId: "rev_first",
        contractHash: "hash_first",
        inputs: RI,
        sealedByRunId: "run_a",
        sealedAt: "2026-08-08T00:00:00.000Z",
      }),
      "recorded",
    );
    assertEq(
      await mod.contractReuse.recordReusableContract(env, digest, {
        contractRevisionId: "rev_second",
        contractHash: "hash_second",
        inputs: RI,
        sealedByRunId: "run_b",
        sealedAt: "2026-08-08T00:05:00.000Z",
      }),
      "already-recorded",
    );
    assertEq(
      (await mod.contractReuse.lookupReusableContract(env, digest)).contractRevisionId,
      "rev_first",
      "repointing the key would hand every FUTURE run a second denominator for the same bytes",
    );
  });

  test("THE RUN ADOPTS IT: identical inputs seal nothing and run no extraction pass", async () => {
    const mod = await worker();
    const env = testEnv();
    const RI = await reuseInputs(mod, env);
    const seeded = await seedReusableRun(mod, env, RI);

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    const step = fakeStep();
    await wf.run(reusePayload(seeded.runId, RI), step);

    assert(step.calls.includes("adopt-reusable-contract"), `steps: ${step.calls.join(", ")}`);
    assertEq(
      step.calls.filter((n) => n.startsWith("extract-pass-a-wave-") || n.startsWith("extract-pass-b-wave-")).length,
      0,
      `a run over identical inputs must issue NO extraction model calls, steps: ${step.calls.join(", ")}`,
    );
    assert(!step.calls.includes("seal-contract-revision"), "and it must not mint a second denominator");

    const cp = (await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
    assertEq(cp.contract.contractRevisionId, seeded.contractRevisionId, "the adopted revision is the indexed one");
    assertEq(cp.contract.state, "sealed");
    assertEq(cp.contract.total, seeded.executionCases, "and the denominator is the sealed one, not a fresh count");
  });

  test("A DIFFERENT VIEWPORT SET MISSES: the run must not adopt a denominator expanded for another", async () => {
    const mod = await worker();
    const env = testEnv();
    const RI = await reuseInputs(mod, env);
    // Indexed for desktop only; this run asks for desktop AND mobile, so the sealed cases were
    // never expanded for it. Adopting would hide every mobile case that was never materialized.
    const seeded = await seedReusableRun(mod, env, RI);

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    const step = fakeStep();
    // The run goes on to EXTRACT, and the fixture has no document in storage, so extraction
    // throws. That throw IS the assertion: it can only be reached by a run that declined the
    // index and went to read the document itself. Swallowing it here and then checking the
    // steps is the difference between "it did not adopt" and "it did not get that far".
    await wf.run(reusePayload(seeded.runId, { ...RI, viewports: ["desktop", "mobile"] }), step).catch(() => {});

    assert(step.calls.includes("adopt-reusable-contract"), "it must still LOOK, or the miss proves nothing");
    assert(
      step.calls.includes("extract-pass-a-wave-0"),
      `a miss must fall through to a real extraction, steps: ${step.calls.join(", ")}`,
    );
    const cp = (await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
    assert(
      cp.contract.contractRevisionId !== seeded.contractRevisionId,
      "a revision expanded for one viewport set must not be adopted by a run asking for another",
    );
  });

  test("A STALE INDEX ENTRY IS NOT AN AUTHORITY: an unresolvable id makes the run extract", async () => {
    const mod = await worker();
    const env = testEnv();
    const RI = await reuseInputs(mod, env);
    const seeded = await seedReusableRun(mod, env, RI, { pointAt: "rev_does_not_exist" });

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    const step = fakeStep();
    await wf.run(reusePayload(seeded.runId, RI), step).catch(() => {});

    assert(
      step.calls.includes("extract-pass-a-wave-0"),
      `an entry that does not re-read must send the run to a real extraction, steps: ${step.calls.join(", ")}`,
    );
    const cp = (await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
    assert(
      cp.contract.contractRevisionId !== "rev_does_not_exist",
      "the index can point at a revision but must never BE one — a poisoned entry cannot become a denominator",
    );
  });

  test("A VALID BUT DIFFERENT REVISION IS NOT AN AUTHORITY: the seal must bind the reuse digest", async () => {
    const mod = await worker();
    const env = testEnv();
    const RI = await reuseInputs(mod, env);
    const other = await mod.contractRevision.sealContract(
      env,
      contractBodyD41({ reuseInputsHash: `sha256:${"a".repeat(64)}` }),
    );
    const seeded = await seedReusableRun(mod, env, RI, {
      pointAt: other.contractRevisionId,
      pointHash: other.contractHash,
    });

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    const step = fakeStep();
    await wf.run(reusePayload(seeded.runId, RI), step).catch(() => {});

    assert(
      step.calls.includes("extract-pass-a-wave-0"),
      `a valid revision sealed to other inputs must be a reuse miss, steps: ${step.calls.join(", ")}`,
    );
    const cp = (await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
    assert(cp.contract.contractRevisionId !== other.contractRevisionId);
  });

  test("LEGACY SCHEMA INJECTION FAILS: human provenance cannot ride an unchanged 1.0 identity", async () => {
    const mod = await worker();
    const legacy = contractBodyD41();
    const forged = structuredClone(legacy);
    forged.requirementsProvenance = {
      method: "human-authored",
      authoredBy: "forged@example.invalid",
    };
    forged.approval = { kind: "human-authored", gates: {} };
    await assertThrows(
      () => mod.contractRevision.computeRevisionId(forged),
      "1.0.0 revisions may not carry human approval or provenance",
    );
    await assertThrows(
      () => mod.contractRevision.sealContract(testEnv(), forged),
      "legacy-human-fields:forbidden",
    );
  });
});

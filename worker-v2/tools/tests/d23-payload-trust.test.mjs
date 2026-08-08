/**
 * D23 — THE PAYLOAD IS A POINTER. A PRODUCER CANNOT DECLARE ITS OWN DEFECT.
 *
 * THE DEFECT (fabrication path #5 in `docs/DIRECTIONAL-PLAN.md`). The structural floor in
 * `verify-observations.ts` opened with:
 *
 *     const payload = o.payload as { contradiction?: unknown; error?: unknown } | null;
 *     if (payload && (payload.contradiction || payload.error)) {
 *       return { outcome: "violated", reason: VERIFIER_REASON.STRUCTURAL_CONTRADICTION, ... };
 *     }
 *
 * `violated` maps to `contradicted` (`OUTCOME_TO_DECISION`), `contradicted` maps to a case
 * status of `fail` (`assemble-record.mjs`), and ONE failing case fails the whole requirement.
 * So those two keys — written BY THE PRODUCER, onto its OWN payload — minted a full, confident,
 * client-visible defect claim about a survey, with:
 *
 *   - no artifact located, no bytes re-read, no hash re-checked;
 *   - no sealed expectation consulted;
 *   - no predicate run at all, because the floor executes FIRST in `decideObservation`, so
 *     nothing downstream was even in a position to catch it.
 *
 * That is the exact shape the file's own header forbids in as many words: "The payload is a
 * POINTER. A verifier that trusted the producer's summary of itself would be certifying the
 * producer's word."
 *
 * WHY THERE WAS NO TEST BEFORE THIS ONE. The hole is DORMANT: the only production producer
 * (`project-observations.ts`) builds a `WalkProjectionPayload` carrying neither key, and no
 * fixture in the tree sets either. A dormant hole is precisely the one that ships — the whole
 * suite stayed 217/217 both before and after the fix, which is the measurement that PROVES
 * dormancy rather than assuming it, and equally proves nothing here was covered.
 *
 * WHY IT COULD NOT WAIT. Phase 3.3 wires model-observations. A failed model call's payload
 * naturally carries an `error`. Every transport failure would then have become a defect claim
 * with no predicate behind it — silently defeating the never-`violated` invariant that is the
 * model verifier's entire owner-approved safety rationale. The detonator arrives with the
 * feature, so the fuse has to be cut before it.
 *
 * WHAT THE FIX IS, AND WHAT IT IS NOT. The branch is DEMOTED, not deleted: it returns
 * `insufficient` with the named reason `PRODUCER_FLAGGED_PAYLOAD_UNVERIFIED`. Evidence-blind
 * DEMOTION is legitimate — withholding a pass costs the run a pass and accuses nobody.
 * Evidence-blind PROMOTION TO A VERDICT, in either direction, is not. Both halves are asserted
 * below: the poisoned observation must not reach `contradicted` (the fabrication), and it must
 * not reach `verified` either (which is what DELETING the branch would have produced, since the
 * fixtures below are healthy walks).
 *
 * HOW THE FIXTURES ARE BUILT, and this is the load-bearing part. The poisoned run and the clean
 * run are THE SAME sealed contract, THE SAME walk artifact bytes, THE SAME cited evidence and
 * THE SAME `WalkProjectionPayload` — differing ONLY by one extra key on the payload object. So
 * "the fabrication is gone" and "the legitimate path is untouched" are read off one controlled
 * pair, and a fix that merely broke the verifier would fail the clean half.
 *
 * Evidence these tests can fail: `tools/mutate-payload-trust.mjs`.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { passingGates } from "../fixtures/v2-fixture.mjs";

const PATH_ID = "FLOOR-D23";
const ATTEMPT_ID = "att_d23test01";
const ROUTE_REQUIREMENT = "req_d23route01";
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// The sealed contract — one route case on Q7, plus the question vocabulary
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

const facet = (id, { target, kind, routeAnswer = null, destination = null, lineage = ROUTE_REQUIREMENT }) => ({
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

/** A vocabulary entry: puts a question id into the seal so screens can be read against it. */
const vocab = (id, target) => facet(id, { target, kind: "rendered-state", lineage: "req_d23render01" });

function contractBody() {
  return {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: "d".repeat(64),
    documentSha256: "d".repeat(64),
    sealedAt: "2026-08-07T00:00:00.000Z",
    requirements: [
      req(ROUTE_REQUIREMENT, "routing", 'When Q7 is answered "Yes", the survey must route to Q9.'),
      req("req_d23render01", "rendered-state", "Every screen must display exactly one question."),
    ],
    facetInstances: [
      facet("fi_route_q7", {
        target: "Q7",
        kind: "route",
        routeAnswer: { code: "1", label: "Yes" },
        destination: { questionId: "Q9", screen: null, terminal: null },
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
      reviewedBy: "d23-fixture",
      reviewedAt: "2026-08-07T00:00:00.000Z",
      gates: passingGates(),
    },
  };
}

// ---------------------------------------------------------------------------
// The walk artifact — a HEALTHY site: Q7 answered "Yes" lands on Q9, as documented
// ---------------------------------------------------------------------------

const screen = (text) => ({
  at: "2026-08-07T00:05:00.000Z",
  url: "https://fixture.invalid/survey",
  title: null,
  collectedErrors: [],
  questionText: text,
  instructionText: null,
  visibleText: text,
  visibleTextTruncated: false,
  bracketedInstructionsVisible: [],
  controls: [],
  optionGroups: [],
  grid: null,
  buttons: [],
  progress: { present: false, kind: null, now: null, max: null, text: null },
  validationMessages: [],
  counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0 },
  screenSignature: `sig:${text}`,
});

const HEALTHY_STEPS = [
  {
    stepIndex: 0,
    decisionQuestion: "Q7",
    decisionSource: "plan",
    requested: { select: ["Yes"], textEntry: null, action: null },
    screenBefore: screen("Q7. Would you buy it again?"),
    screenAfterAction: null,
    screenAfterAdvance: screen("Q9. Which brands do you buy?"),
    actions: [{ kind: "click-option", targetIdx: 0, targetLabel: "Yes", targetCode: "1", value: null, ok: true, detail: null }],
    requestedButNotOffered: [],
    advanced: true,
    blocked: false,
    pageErrors: [],
    consoleErrors: [],
    evidence: { screenBefore: null, screenAfterAdvance: null, screenshots: [] },
    wallMs: 5000,
  },
];

const walkArtifact = (runId) => ({
  kind: "v2-path-observation/1.0.0",
  runId,
  pathId: PATH_ID,
  tier: 1,
  attemptId: ATTEMPT_ID,
  planRevisionId: "plan_d23test01",
  surveyUrl: "https://fixture.invalid/survey",
  startedAt: "2026-08-07T00:04:00.000Z",
  endedAt: "2026-08-07T00:05:00.000Z",
  wallMs: 60000,
  plannedWitnesses: [ROUTE_REQUIREMENT],
  steps: HEALTHY_STEPS,
  outcome: "completed",
  outcomeDetail: null,
  shimmed: false,
  shimNote: null,
  loadFailure: null,
  evidenceIds: [],
  viewport: { width: 1280, height: 900 },
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * EXACTLY the object `project-observations.ts` builds — the only observation payload shape any
 * producer in this repo emits, reproduced key-for-key. `poison` is the ONLY difference between
 * the clean run and the poisoned one.
 */
const walkProjectionPayload = (observationEvidenceId, poison = null) => ({
  pathId: PATH_ID,
  attemptId: ATTEMPT_ID,
  observationEvidenceId,
  outcome: "completed",
  outcomeDetail: null,
  screensAdvanced: 1,
  steps: 1,
  exercised: true,
  observedAt: "2026-08-07T00:05:00.000Z",
  ...(poison ?? {}),
});

/** Seal, store the walk content-addressed, and commit ONE observation citing it. */
async function seedRun(mod, env, poison) {
  const runId = mod.ids.mintRunId();
  const { contractRevisionId, contractHash } = await mod.contractRevision.sealContract(env, contractBody());

  const entry = await mod.evidence.putEvidence(env, {
    runId,
    bytes: enc.encode(JSON.stringify(walkArtifact(runId))),
    mediaType: "application/json",
    type: "state",
    attemptId: ATTEMPT_ID,
    routeId: PATH_ID,
    witnesses: [ROUTE_REQUIREMENT],
    sourceEvidenceId: `EV-${PATH_ID}-observation`,
    artifactRef: `observations/${PATH_ID}/observation.json`,
  });

  await env.EVIDENCE.put(
    mod.keys.observationsKey(runId),
    JSON.stringify({
      observations: [
        {
          observationId: "obs_d23_route_q7",
          facetInstanceId: "fi_route_q7",
          attemptId: ATTEMPT_ID,
          routeId: PATH_ID,
          observedAt: "2026-08-07T00:05:00.000Z",
          payloadKind: "v2-walk-projection/1.0.0",
          payload: walkProjectionPayload(entry.evidenceId, poison),
          completeness: "complete-scoped-inventory",
          evidenceIds: [entry.evidenceId],
          // No decision is asserted here: the verify stage owns it.
          verifier: { decision: "insufficient", evidenceIds: [entry.evidenceId], verifierVersion: "none/not-yet-verified" },
          attestation: { producedBy: "v2-executor", producerVersion: "v2-observation-projection/1.0.0", payloadHash: "sha256:d23" },
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
      total: 2,
      requirements: { total: 2, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
    };
    d.counts = { ...d.counts, exercised: 1, pending: 1 };
  });

  return { runId };
}

/**
 * Run the REAL verify stage, then the REAL aggregator, and hand back both the verifier stamp
 * and the verdict a client would be shown. The second half is the point: a fabricated
 * `contradicted` is only harmful because it becomes a `fail` on a report.
 */
async function verifyPoisoned(poison) {
  const mod = await worker();
  const env = testEnv();
  const { runId } = await seedRun(mod, env, poison);

  const result = await mod.verifyObservations.verifyObservations(env, runId);
  const ledger = JSON.parse(await (await env.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;
  const derived = await mod.deriveVerdicts.deriveItemResults(env, runId);

  return {
    mod,
    result,
    row: ledger.find((o) => o.facetInstanceId === "fi_route_q7"),
    routing: derived.value.itemResults.find((r) => r.requirementLineageId === ROUTE_REQUIREMENT),
  };
}

// ===========================================================================
suite("D23 — a producer-flagged payload cannot mint a defect", () => {
  test("THE ONE THAT MATTERS: a model-observation's own `error` key must not mint a defect claim", async () => {
    // The shape Phase 3.3 delivers on its first failed model call: a perfectly ordinary walk
    // projection with an `error` string on it. Under the old floor this was `contradicted`.
    const { result, row, routing } = await verifyPoisoned({ error: "model call failed: 429 rate limited" });

    assertEq(
      result.value.contradicted,
      0,
      `a producer's own error string is not evidence of a site defect: ${JSON.stringify(result.value.byReason)}`,
    );
    assertEq(row.verifier.decision, "insufficient", `expected a demotion, got ${JSON.stringify(row.verifier)}`);
    assertEq(row.verifier.reason, "PRODUCER_FLAGGED_PAYLOAD_UNVERIFIED");

    // AND THE CONSEQUENCE A CLIENT WOULD SEE. This is what made the hole worth closing: the
    // fabricated `contradicted` did not stay inside the verifier, it became a printed `fail`.
    assert(
      routing.verdict !== "fail",
      `a failed producer call must not fail the client's requirement: ${JSON.stringify(routing)}`,
    );
  });

  test("the same for a `contradiction` key — the guard is an OR and both halves are producer-written", async () => {
    const { result, row, routing } = await verifyPoisoned({ contradiction: "the producer believes this screen was wrong" });

    assertEq(result.value.contradicted, 0, JSON.stringify(result.value.byReason));
    assertEq(row.verifier.decision, "insufficient");
    assertEq(row.verifier.reason, "PRODUCER_FLAGGED_PAYLOAD_UNVERIFIED");
    assert(routing.verdict !== "fail", JSON.stringify(routing));
  });

  test("a producer-flagged payload is not promoted to a PASS either — the demotion was kept, not deleted", async () => {
    // DELETING the branch rather than demoting it would land here: the walk underneath is
    // healthy, so the route predicate would happily verify an observation whose own producer
    // said it had errored. Withholding is the whole point of keeping the branch.
    const { result, row } = await verifyPoisoned({ error: "model call failed: 429 rate limited" });

    assertEq(result.value.verified, 0, "an observation whose producer flagged an error may not be certified");
    assertEq(row.verifier.predicate, "structural", "the floor must still be what decided this, not the route predicate");
  });
});

// ===========================================================================
suite("D23 — the legitimate producer path is unchanged", () => {
  test("the legitimate producer path is byte-identical: a normal WalkProjectionPayload still verifies", async () => {
    // The SAME contract, the SAME walk bytes, the SAME payload — minus the poison key. If the
    // fix had over-reached and demoted real observations, this is where it would show.
    const { result, row, routing } = await verifyPoisoned(null);

    assertEq(result.value.verified, 1, JSON.stringify(result.value.byReason));
    assertEq(result.value.contradicted, 0);
    assertEq(result.value.insufficient, 0);
    assertEq(row.verifier.decision, "verified");
    assertEq(row.verifier.reason, "ROUTE_DESTINATION_REACHED");
    assertEq(row.verifier.predicate, "route-destination/1.0.0");
    assertEq(row.verifier.detail, "selecting the documented answer advanced to a screen presenting Q9");
    assertEq(routing.verdict, "pass", JSON.stringify(routing));
  });

  test("the floor still DEMOTES what it always demoted: no evidence cited is still `insufficient`", async () => {
    // `structuralDecision` is exported, so the floor can be asked directly what it does to each
    // payload shape. Two properties in one place: a REAL producer payload passes through it
    // untouched (null — the predicate decides), and the evidence-blind demotion this stage has
    // always performed is still performed. The fix removed a PROMOTION, not demotion generally.
    const mod = await worker();
    const realPayload = walkProjectionPayload("ev_whatever");

    assertEq(
      mod.verifyObservations.structuralDecision({ payload: realPayload, evidenceIds: ["ev_whatever"] }),
      null,
      "the only payload shape any producer builds must pass straight through the floor",
    );

    const noEvidence = mod.verifyObservations.structuralDecision({ payload: realPayload, evidenceIds: [] });
    assertEq(noEvidence.outcome, "insufficient");
    assertEq(noEvidence.reason, "NO_EVIDENCE_CITED");

    // And the poisoned shape, at the same seam: demoted, named, and never a verdict.
    const flagged = mod.verifyObservations.structuralDecision({
      payload: { ...realPayload, error: "boom" },
      evidenceIds: ["ev_whatever"],
    });
    assertEq(flagged.outcome, "insufficient", `the floor may not author a verdict: ${JSON.stringify(flagged)}`);
    assertEq(flagged.reason, "PRODUCER_FLAGGED_PAYLOAD_UNVERIFIED");
  });
});

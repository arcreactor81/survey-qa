/**
 * D15 — THE OBSERVATION LEDGER: the producer/consumer gap, and how a `verified` is earned.
 *
 * THE DEFECT. The executor left its walks in two places — the content-addressed evidence
 * catalogue (as `PathObservation` artifacts) and `execution/progress.json` (as a walk
 * ledger) — and NOTHING ever wrote `v2/runs/<id>/observations.json`, which is the only key
 * `run-inputs.ts#readObservations` reads. So `verify-observations` mapped over an empty
 * array, the aggregator saw no observations for any sealed case, every case came back
 * `pending`, every requirement `incomplete`, and a live run judged 0 pass / 39 not-assessed.
 * Downstream of that, `structuralDecision` had no branch that could return `verified` at all.
 *
 * THE TESTS BELOW COME IN TWO HALVES AND THE SECOND IS THE IMPORTANT ONE.
 *
 *   1. A case CAN now reach `verified`, and it carries through the aggregator as a `pass`.
 *   2. It CANNOT reach `verified` when the observation does not actually satisfy its
 *      expectation — including when the observation's own payload SAYS it does. That is the
 *      property that distinguishes this fix from the defect it replaces: the first run wrote
 *      MATCHES_DOCUMENT while citing the artifact that disproved it, so a verdict that can be
 *      asserted rather than derived is the bug, not the feature.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { passingGates } from "../fixtures/v2-fixture.mjs";

const PATH_ID = "FLOOR-01";
const ATTEMPT_ID = "att_d15test01";
const PLAN_REVISION_ID = "plan_d15test01";
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// A sealed contract with TYPED execution cases
// ---------------------------------------------------------------------------

/**
 * Two requirements, three sealed cases:
 *   - `fi_route`   a ROUTE case: answering Q7 "Can't remember" must land on Q9. TYPED, so a
 *                  predicate can decide it.
 *   - `fi_render`  a RENDERED-STATE case. No typed expectation a model-free predicate can
 *                  decide, so it must stay `insufficient` no matter how good the walk was.
 *   - `fi_q12`     exists only to put Q12 into the sealed question set, which is what lets
 *                  the route predicate say "the walk landed on a DIFFERENT documented
 *                  screen" instead of guessing.
 */
function routingContractBody() {
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
    sourceAtoms: [{ blockId: "B1", kind: "paragraph", coords: null, role: "normative", atomTextHash: "sha256:aa" }],
    composition: null,
    normativeStatement: statement,
    displayQuote: quote,
    retiredAt: null,
  });

  return {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: "b".repeat(64),
    documentSha256: "b".repeat(64),
    sealedAt: "2026-08-02T00:00:00.000Z",
    requirements: [
      req("req_d15route001", "routing", 'When Q7 is answered "Can\'t remember", the survey must route to Q9.', "If Q7 = 'Can't remember', go to Q9."),
      req("req_d15render01", "rendered-state", "Every screen must display exactly one question.", "Show one question per screen."),
    ],
    facetInstances: [
      {
        facetInstanceId: "fi_route",
        requirementLineageId: "req_d15route001",
        requirementVersionId: "reqv_d15route001",
        caseVersionId: "cv_route",
        floorCase: true,
        targetQuestionId: "Q7",
        expansionCertificate: "cert_route",
        case: {
          kind: "route",
          routeAnswer: { code: "8", label: "Can't remember" },
          boundaryInput: null,
          configuration: null,
          expectedDestination: { questionId: "Q9", screen: null, terminal: null },
        },
        screen: "Q7",
        label: "Q7 = Can't remember -> Q9",
      },
      {
        facetInstanceId: "fi_render",
        requirementLineageId: "req_d15render01",
        requirementVersionId: "reqv_d15render01",
        caseVersionId: "cv_render",
        floorCase: true,
        targetQuestionId: "Q1",
        expansionCertificate: "cert_render",
        case: { kind: "rendered-state", routeAnswer: null, boundaryInput: null, configuration: null, expectedDestination: null },
        screen: "Q1",
        label: "one question per screen",
      },
      {
        facetInstanceId: "fi_q12",
        requirementLineageId: "req_d15render01",
        requirementVersionId: "reqv_d15render01",
        caseVersionId: "cv_q12",
        floorCase: true,
        targetQuestionId: "Q12",
        expansionCertificate: "cert_q12",
        case: { kind: "rendered-state", routeAnswer: null, boundaryInput: null, configuration: null, expectedDestination: null },
        screen: "Q12",
        label: "one question per screen (Q12)",
      },
    ],
    contractSupplements: [],
    extraction: {
      passAHash: "sha256:aaa",
      passBHash: "sha256:bbb",
      sourceLedgerHash: "sha256:ccc",
      diffHash: "sha256:ddd",
      reviewMode: "high-risk-only",
      reviewedBy: "fixture-reviewer",
      reviewedAt: "2026-08-02T00:00:00.000Z",
      gates: passingGates(),
    },
  };
}

// ---------------------------------------------------------------------------
// A walk artifact — the bytes the verifier re-reads
// ---------------------------------------------------------------------------

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
  controls: [],
  optionGroups: [],
  grid: null,
  buttons: [],
  progress: { present: false, kind: null, now: null, max: null, text: null },
  validationMessages: [],
  counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0 },
  screenSignature: `sig:${text}`,
});

/**
 * One walk that answers Q7 and advances. `reached` is what the NEXT screen actually showed —
 * the single fact every route verdict below turns on.
 */
function walkArtifact(
  runId,
  {
    reached = "Q9. Which brands do you buy?",
    advanced = true,
    // The sealed route answer is code "8" / label "Can't remember". Matching is by exact
    // code OR exact label (`RouteAnswerPayload`), so a test that means "this walk answered
    // something else" has to change BOTH.
    selectedCode = "8",
    selectedLabel = "Can't remember",
  } = {},
) {
  return {
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
    plannedWitnesses: ["req_d15route001"],
    steps: [
      {
        stepIndex: 0,
        decisionQuestion: "Q7",
        decisionSource: "plan",
        requested: { select: ["Can't remember"], textEntry: null, action: null },
        screenBefore: screen("Q7. Which brand did you buy most recently?"),
        screenAfterAction: null,
        screenAfterAdvance: advanced ? screen(reached) : null,
        actions: [
          {
            kind: "click-option",
            targetIdx: 3,
            targetLabel: selectedLabel,
            targetCode: selectedCode,
            value: null,
            ok: true,
            detail: null,
          },
        ],
        requestedButNotOffered: [],
        advanced,
        blocked: false,
        pageErrors: [],
        consoleErrors: [],
        evidence: { screenBefore: null, screenAfterAdvance: null, screenshots: [] },
        wallMs: 5000,
      },
    ],
    outcome: "completed",
    outcomeDetail: null,
    shimmed: false,
    shimNote: null,
    loadFailure: null,
    evidenceIds: [],
    viewport: { width: 1280, height: 900 },
  };
}

// ---------------------------------------------------------------------------
// The scenario: everything the executor would have left behind, and nothing more
// ---------------------------------------------------------------------------

/**
 * Seed the DURABLE STATE A REAL RUN LEAVES: a sealed revision, a plan program, a walk
 * ledger, the walk artifact in the evidence catalogue, and a checkpoint naming the plan.
 *
 * Note what is NOT seeded: `observations.json`. That is the whole point — the projection
 * stage has to produce it from the above, exactly as it must on a live run.
 */
async function seedExecutedRun(mod, env, { walk = null, caseIds = ["fi_route", "fi_render"], writeArtifact = true } = {}) {
  const runId = mod.ids.mintRunId();
  const { contractRevisionId, contractHash, revision } = await mod.contractRevision.sealContract(
    env,
    routingContractBody(),
  );

  // THE PROGRAM AND THE WALK LEDGER ARE DIFFERENT KINDS OF INPUT, and `caseIds` names the
  // WALK's — what the executor recorded it closed.
  //
  // Under program 2.0.0 the plan is a TOTAL, EXACT partition of the sealed case ids:
  // `caseOrder` must permute them, and `floor[].caseIds + unassignedCaseIds` must too. A
  // program is therefore structurally incapable of naming a case the seal does not carry,
  // and `loadProgram` refuses one that tries. So the program below is derived from the
  // SEAL, never from `caseIds` — deriving it keeps this fixture from drifting out of the
  // permutation the loader checks.
  //
  // The WALK LEDGER carries no such guarantee: it is what a browser session left behind,
  // and it can name a case id the seal does not carry (`caseIds: ["fi_not_in_the_seal"]`)
  // or none at all (`caseIds: []`). That is exactly the untrusted surface the verifier's
  // NO_SEALED_CASE check defends, so `caseIds` is passed to the walk VERBATIM below.
  const sealedCaseIds = revision.facetInstances.map((fi) => fi.facetInstanceId);
  const assignedCaseIds = sealedCaseIds.filter((id) => caseIds.includes(id));
  const unassignedCaseIds = sealedCaseIds.filter((id) => !assignedCaseIds.includes(id));

  if (writeArtifact) {
    await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode(JSON.stringify(walk ?? walkArtifact(runId))),
      mediaType: "application/json",
      type: "state",
      attemptId: ATTEMPT_ID,
      routeId: PATH_ID,
      witnesses: ["req_d15route001"],
      sourceEvidenceId: `EV-${PATH_ID}-observation`,
      artifactRef: `observations/${PATH_ID}/observation.json`,
    });
  }

  await env.EVIDENCE.put(
    mod.keys.planKey(runId, PLAN_REVISION_ID),
    JSON.stringify({
      kind: "v2-execution-program/2.0.0",
      // 2.0.0 binds the program to its run. `loadProgram` refuses a program whose runId is
      // not the run it was loaded under, so this must be the run the rest of the seed uses.
      runId,
      planRevisionId: PLAN_REVISION_ID,
      contractRevisionId,
      contractHash,
      generatedAt: "2026-08-02T00:01:00.000Z",
      surveyUrl: "https://fixture.invalid/survey",
      floor: [{ pathId: PATH_ID, tier: 1, caseIds: assignedCaseIds, witnesses: ["req_d15route001"] }],
      exploration: [],
      caseOrder: sealedCaseIds,
      unassignedCaseIds,
      coverage: {
        obligations: 2,
        witnessedByFloor: 2,
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
          steps: 1,
          wallMs: 60000,
          shimmed: false,
          loadCrash: false,
          evidenceCount: 1,
          caseIds,
          exercised: true,
          plannedDecisions: 1,
          matchedDecisions: 1,
          screensAdvanced: 1,
          at: "2026-08-02T00:05:00.000Z",
        },
      ],
      floorDone: [PATH_ID],
      explorationDone: [],
      shimRequired: false,
      hungPaths: [],
      shimEvidence: null,
      totalSteps: 1,
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
      total: 3,
      requirements: { total: 2, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
    };
    // The checkpoint refuses a ledger that does not reconcile against the sealed total, so
    // the seed states one that does: the cases this walk closed are exercised, the rest are
    // still owed an observation.
    d.counts = { ...d.counts, exercised: caseIds.length, pending: 3 - caseIds.length };
    d.execution = {
      batchIndex: 1,
      sessionId: null,
      sessionOpenedAt: null,
      pendingCaseIds: [],
      completedCaseIds: caseIds,
      planRevisionId: PLAN_REVISION_ID,
    };
  });

  return { runId, contractRevisionId, contractHash };
}

const readLedger = async (mod, env, runId) =>
  JSON.parse(await (await env.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;

const byCase = (rows, id) => rows.find((o) => o.facetInstanceId === id);

// ===========================================================================
suite("D15 — the executor's walks reach the observation ledger", () => {
  test("THE ROOT DEFECT: nothing wrote observations.json, so verification had nothing to decide", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedExecutedRun(mod, env);

    // Pre-projection: the walk artifact and the walk ledger both exist...
    const catalog = await mod.evidence.listCatalog(env, runId);
    assertEq(catalog.length, 1, "the walk artifact is in the evidence catalogue");
    // ...and the key every judging stage reads is still empty. This is the live defect.
    assertEq(await env.EVIDENCE.get(mod.keys.observationsKey(runId)), null);
    const before = await mod.runInputs.loadRunInputs(env, runId);
    assertEq(before.observations.length, 0, "the consumer sees nothing, which is why every case capped at pending");

    const projected = await mod.projectObservations.projectObservations(env, runId);
    assertEq(projected.state, "evaluated");
    assertEq(projected.value.observations, 2, "one observation per case the walk actually closed");

    const after = await mod.runInputs.loadRunInputs(env, runId);
    assertEq(after.observations.length, 2, "the SAME key the consumer reads is now populated");
    assert(
      after.observations.every((o) => typeof o.facetInstanceId === "string"),
      "observations are keyed by sealed execution case — a PathObservation could never supply that",
    );
  });

  test("the projection authors NO verifier decision — that is the verify stage's job alone", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedExecutedRun(mod, env);
    await mod.projectObservations.projectObservations(env, runId);

    for (const o of await readLedger(mod, env, runId)) {
      assertEq(o.verifier.decision, "insufficient", "a projection that supplied its own pass is the original defect");
      assertEq(o.verifier.verifierVersion, "none/not-yet-verified");
    }
  });

  test("a walk that closed NO cases mints no observation — a blocked site is not a failed survey", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedExecutedRun(mod, env, { caseIds: [] });

    const projected = await mod.projectObservations.projectObservations(env, runId);
    assertEq(projected.state, "evaluated");
    assertEq(projected.value.observations, 0);
    assertEq(projected.value.contributingWalks, 0, "an unexercised walk contributes nothing rather than a contradiction");
  });

  test("the projection is idempotent over the same durable state", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedExecutedRun(mod, env);

    await mod.projectObservations.projectObservations(env, runId);
    const first = await (await env.EVIDENCE.get(mod.keys.observationsKey(runId))).text();
    await mod.projectObservations.projectObservations(env, runId);
    const second = await (await env.EVIDENCE.get(mod.keys.observationsKey(runId))).text();
    assertEq(second, first, "a replacement instance re-running the step must not mint a second, divergent ledger");
  });
});

// ===========================================================================
suite("D15 — a case CAN reach `verified`, and only by being checked", () => {
  test("a route case whose walk reached the documented destination verifies", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedExecutedRun(mod, env);
    await mod.projectObservations.projectObservations(env, runId);

    const result = await mod.verifyObservations.verifyObservations(env, runId);
    assertEq(result.state, "evaluated");
    assertEq(result.value.verified, 1, JSON.stringify(result.value.byReason));

    const route = byCase(await readLedger(mod, env, runId), "fi_route");
    assertEq(route.verifier.decision, "verified");
    // THE VERDICT NAMES WHAT PRODUCED IT. A `verified` nobody can interrogate is worse than
    // no verified at all.
    assertEq(route.verifier.predicate, "route-destination/1.0.0");
    assertEq(route.verifier.reason, "ROUTE_DESTINATION_REACHED");
  });

  test("a verified case becomes a PASS through the deterministic aggregator", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedExecutedRun(mod, env);
    await mod.projectObservations.projectObservations(env, runId);
    await mod.verifyObservations.verifyObservations(env, runId);

    const derived = await mod.deriveVerdicts.deriveItemResults(env, runId);
    assertEq(derived.state, "evaluated");
    const routing = derived.value.itemResults.find((r) => r.requirementLineageId === "req_d15route001");
    assertEq(routing.verdict, "pass", JSON.stringify(routing));
    assertEq(routing.facetResults.find((f) => f.facetInstanceId === "fi_route").status, "pass");
  });

  test("a case kind with no model-free expectation stays `insufficient`, however good the walk was", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedExecutedRun(mod, env);
    await mod.projectObservations.projectObservations(env, runId);
    await mod.verifyObservations.verifyObservations(env, runId);

    const render = byCase(await readLedger(mod, env, runId), "fi_render");
    assertEq(render.verifier.decision, "insufficient");
    assertEq(render.verifier.reason, "NO_TYPED_EXPECTATION", "a rendered-state case needs the document, and no model is wired");
  });
});

// ===========================================================================
// THE HALF THAT MATTERS. Without these, the suite above only proves the system can be
// made to say yes.
// ===========================================================================
suite("D15 — a case CANNOT reach `verified` when the walk does not satisfy the expectation", () => {
  test("NEGATIVE: the walk landed on a DIFFERENT documented screen — contradicted, never verified", async () => {
    const mod = await worker();
    const env = testEnv();
    // The same run in every respect except one: the walk went to Q12, not the documented Q9.
    const { runId } = await seedExecutedRunWithWalk(mod, env, { reached: "Q12. How much do you spend per month?" });
    await mod.projectObservations.projectObservations(env, runId);
    const result = await mod.verifyObservations.verifyObservations(env, runId);

    assertEq(result.value.verified, 0, "a walk that went somewhere else must never verify");
    assertEq(result.value.contradicted, 1);
    const route = byCase(await readLedger(mod, env, runId), "fi_route");
    assertEq(route.verifier.decision, "contradicted");
    assertEq(route.verifier.reason, "ROUTE_DESTINATION_MISMATCH");

    const derived = await mod.deriveVerdicts.deriveItemResults(env, runId);
    assertEq(derived.value.itemResults.find((r) => r.requirementLineageId === "req_d15route001").verdict, "fail");
  });

  test("NEGATIVE: the destination cannot be identified — `insufficient`, and NOT a fabricated fail", async () => {
    const mod = await worker();
    const env = testEnv();
    // A survey that prints no question numbers. The expected token is absent, but so is
    // every other sealed one, so nothing has been proven either way.
    const { runId } = await seedExecutedRunWithWalk(mod, env, { reached: "Which brands do you buy?" });
    await mod.projectObservations.projectObservations(env, runId);
    const result = await mod.verifyObservations.verifyObservations(env, runId);

    assertEq(result.value.verified, 0);
    assertEq(result.value.contradicted, 0, "absence of the expected token is not evidence of a wrong destination");
    const route = byCase(await readLedger(mod, env, runId), "fi_route");
    assertEq(route.verifier.reason, "DESTINATION_NOT_IDENTIFIABLE");
  });

  test("NEGATIVE: the walk never selected the documented answer — the branch was never exercised", async () => {
    const mod = await worker();
    const env = testEnv();
    // It still LANDS on Q9 — but by answering something the document said nothing about.
    // A destination reached down the wrong branch witnesses nothing about this case.
    const { runId } = await seedExecutedRunWithWalk(mod, env, {
      reached: "Q9. Which brands do you buy?",
      selectedCode: "3",
      selectedLabel: "Every day",
    });
    await mod.projectObservations.projectObservations(env, runId);
    const result = await mod.verifyObservations.verifyObservations(env, runId);

    assertEq(result.value.verified, 0, "landing on Q9 having answered something else proves nothing about this case");
    const route = byCase(await readLedger(mod, env, runId), "fi_route");
    assertEq(route.verifier.reason, "ROUTE_ANSWER_NOT_SELECTED");
  });

  test("NEGATIVE: the answer was selected but the survey never advanced", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedExecutedRunWithWalk(mod, env, { advanced: false });
    await mod.projectObservations.projectObservations(env, runId);
    const result = await mod.verifyObservations.verifyObservations(env, runId);

    assertEq(result.value.verified, 0);
    assertEq(byCase(await readLedger(mod, env, runId), "fi_route").verifier.reason, "ROUTE_NOT_ADVANCED");
  });

  test("NEGATIVE: a walk that captured nothing cites no evidence, and cannot support a positive claim", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedExecutedRun(mod, env, { writeArtifact: false });
    await mod.projectObservations.projectObservations(env, runId);
    const result = await mod.verifyObservations.verifyObservations(env, runId);

    assertEq(result.value.verified, 0);
    assertEq(result.value.contradicted, 0, "missing evidence is `we do not know`, not `the survey failed`");
    // The structural floor catches this before any predicate runs — a demotion, as designed.
    assertEq(byCase(await readLedger(mod, env, runId), "fi_route").verifier.reason, "NO_EVIDENCE_CITED");
  });

  test("NEGATIVE: THE RE-READ IS REAL — delete the cited bytes and the same run stops verifying", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedExecutedRunWithWalk(mod, env, {});
    await mod.projectObservations.projectObservations(env, runId);

    // Baseline: this exact run verifies.
    assertEq((await mod.verifyObservations.verifyObservations(env, runId)).value.verified, 1);

    // Now remove the artifact's BYTES while leaving the catalogue entry, the observation and
    // its citation completely intact. Nothing the verifier could "assert" from has changed —
    // only the thing it must actually go and read.
    const entry = (await mod.evidence.listCatalog(env, runId)).find((e) => e.sourceEvidenceId === "EV-FLOOR-01-observation");
    await env.EVIDENCE.delete(mod.keys.evidenceBlobKey(entry.contentHash));

    const result = await mod.verifyObservations.verifyObservations(env, runId);
    assertEq(result.value.verified, 0, "a verdict that survives the loss of its evidence was never derived from it");
    assertEq(result.value.contradicted, 0, "unreadable evidence is not a defect");
    assertEq(byCase(await readLedger(mod, env, runId), "fi_route").verifier.reason, "ARTIFACT_UNREADABLE");
  });

  test("NEGATIVE: an observation citing no walk artifact cannot be verified", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedExecutedRunWithWalk(mod, env, {});
    await mod.projectObservations.projectObservations(env, runId);

    // Keep the evidence citations (so the structural floor passes) but drop the pointer to
    // the walk artifact, as an observation projected from a catalogue that lost the entry
    // would look.
    const rows = await readLedger(mod, env, runId);
    for (const o of rows) o.payload = { ...o.payload, observationEvidenceId: null };
    await env.EVIDENCE.put(mod.keys.observationsKey(runId), JSON.stringify({ observations: rows }), {
      httpMetadata: { contentType: "application/json" },
    });

    const result = await mod.verifyObservations.verifyObservations(env, runId);
    assertEq(result.value.verified, 0);
    assertEq(byCase(await readLedger(mod, env, runId), "fi_route").verifier.reason, "ARTIFACT_NOT_LOCATED");
  });

  test("THE ONE THAT MATTERS MOST: an observation ASSERTING it passed is overruled by its own artifact", async () => {
    const mod = await worker();
    const env = testEnv();
    // The walk went to Q12. The document says Q9.
    const { runId } = await seedExecutedRunWithWalk(mod, env, { reached: "Q12. How much do you spend per month?" });
    await mod.projectObservations.projectObservations(env, runId);

    // Now forge the ledger the way the FIRST RUN failed: stamp `verified` on the row and
    // dress the payload up as a clean success. Every field a lazy verifier might trust now
    // says "pass"; only the cited artifact says otherwise.
    const forged = await readLedger(mod, env, runId);
    for (const o of forged) {
      o.verifier = { decision: "verified", evidenceIds: o.evidenceIds, verifierVersion: "hand-written/1.0.0" };
      if (o.facetInstanceId === "fi_route") {
        o.payload = { ...o.payload, outcome: "completed", exercised: true, matchesDocument: true, reachedDestination: "Q9" };
      }
    }
    await env.EVIDENCE.put(mod.keys.observationsKey(runId), JSON.stringify({ observations: forged }), {
      httpMetadata: { contentType: "application/json" },
    });

    const result = await mod.verifyObservations.verifyObservations(env, runId);
    assertEq(result.value.verified, 0, "a hand-written `verified` must not survive verification");

    const route = byCase(await readLedger(mod, env, runId), "fi_route");
    assertEq(route.verifier.decision, "contradicted");
    assertEq(route.verifier.reason, "ROUTE_DESTINATION_MISMATCH");
    assert(
      route.verifier.detail.includes("Q12"),
      `the verdict must cite what the artifact actually showed: ${route.verifier.detail}`,
    );
  });

  test("NEGATIVE: a sealed case the revision does not carry can never be verified", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedExecutedRun(mod, env, { caseIds: ["fi_not_in_the_seal"] });
    await mod.projectObservations.projectObservations(env, runId);
    const result = await mod.verifyObservations.verifyObservations(env, runId);

    assertEq(result.value.verified, 0);
    assertEq(byCase(await readLedger(mod, env, runId), "fi_not_in_the_seal").verifier.reason, "NO_SEALED_CASE");
  });
});

/**
 * Seed a run whose single walk is shaped by `opts`.
 *
 * Two phases, because `walkArtifact` must be stamped with the run id the seeder mints: seed
 * without the artifact, then write the artifact against the id that came back.
 */
async function seedExecutedRunWithWalk(mod, env, opts) {
  const seeded = await seedExecutedRun(mod, env, { writeArtifact: false });
  await mod.evidence.putEvidence(env, {
    runId: seeded.runId,
    bytes: enc.encode(JSON.stringify(walkArtifact(seeded.runId, opts))),
    mediaType: "application/json",
    type: "state",
    attemptId: ATTEMPT_ID,
    routeId: PATH_ID,
    witnesses: ["req_d15route001"],
    sourceEvidenceId: `EV-${PATH_ID}-observation`,
    artifactRef: `observations/${PATH_ID}/observation.json`,
  });
  return seeded;
}

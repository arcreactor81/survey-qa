/**
 * D30 — VERIFICATION MUST NOT COST ONE R2 READ PER ARTIFACT THE RUN EVER CAPTURED.
 *
 * THE INCIDENT. Run `v2r_01kzfb6py8pbxznqv022p2qkhb` got further than any run before it:
 * extraction, a sealed contract, a 212-case plan, fourteen `execute-batch` steps and
 * `project-observations` all succeeded. Then `verify-observations` died, three attempts deep:
 *
 *     Error: Too many API requests by single Worker invocation.
 *
 * Attempt 1 ran 1m19s before erroring. **Attempts 2 and 3 errored in 0 seconds** — they never
 * reached a single R2 call, because a Workflow instance does not get a fresh invocation per
 * step and the invocation's subrequest budget was already spent. That 0s is the empirical
 * proof that consecutive steps and step ATTEMPTS share one budget.
 *
 * WHERE THE BUDGET WENT, and it was not the browser. `puppeteer.connect` upgrades to a
 * WebSocket and CDP traffic rides it, so driving a page is not a subrequest per command. R2
 * is. That run wrote **1,707 catalogue entries** (one per screen read and per screenshot of
 * 46 walks — counted against the live bucket, not estimated), and `listCatalog` is a fan-out:
 * one LIST plus **one GET per entry**. `project-observations` paid 1,707 of them, and then
 * `verify-observations` — via `loadRunInputs` — paid the identical 1,707 one step later. 1m19s
 * is 1,707 sequential R2 GETs at ~46ms.
 *
 * THE FIX THIS FILE GUARDS. `verify-observations` never needed the catalogue. It needs the ONE
 * entry naming each cited walk artifact, so it now reads them by key with
 * `getBoundCatalogEntry` and passes `{ catalog: false }` to `loadRunInputs`. The cost becomes
 * O(distinct artifacts cited) — the number of CONTRIBUTING walks, 8 in that run — instead of
 * O(everything captured).
 *
 * ==================== WHAT THESE TESTS CAN AND CANNOT PROVE ====================
 *
 * They CANNOT prove the run now completes. There is no subrequest counter in a memory R2, the
 * `limits.subrequests` ceiling in wrangler.jsonc is enforced only on deployment, and nothing
 * local can show that `step.sleep` yields a fresh invocation. Only a live run shows those.
 *
 * What they CAN prove is the property the fix actually rests on, and they are built so that
 * reintroducing the fan-out makes them fail rather than merely making them slower:
 *
 *   1. INVARIANCE, not a threshold. The same run is verified twice — once with 10 decoy
 *      catalogue entries and once with 400 — and the R2 operation counts must be EQUAL. A
 *      generous absolute ceiling would pass a 1,707-entry scan on a 3-entry fixture; an
 *      equality across a 40x change in catalogue size cannot be satisfied by anything that
 *      touches the catalogue at all. `listCatalog` restored here fails by 390 operations.
 *   2. The decoy keys are named and asserted UNREAD, so the failure message says what was
 *      touched instead of only that a number moved.
 *   3. The integrity chain is re-proven on the cheaper path: a repointed catalogue entry and
 *      a missing one must both yield `insufficient`, never a pass. Reading by key must run the
 *      same binding assertion the catalogue scan ran — if it did not, this is a fabrication
 *      hole, not an optimisation.
 */

import { assert, assertEq, fakeStep, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { passingGates } from "../fixtures/v2-fixture.mjs";

const PATH_ID = "BUDGET-D30";
const ATTEMPT_ID = "att_d30budget";
const ROUTE_REQUIREMENT = "req_d30route01";
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// A counting R2. It wraps rather than replaces `memoryR2` so the storage semantics
// under test stay the production ones — only the accounting is added.
// ---------------------------------------------------------------------------

/**
 * EVERY METHOD IS COUNTED, INCLUDING `list`. A wrapper that counted only `get` would let a
 * reintroduced `listCatalog` hide half of itself, and a wrapper that forgot a method entirely
 * would silently under-report — so the proxy forwards by enumeration and any method added to
 * the R2 surface later that this list does not name will throw here rather than go uncounted.
 */
function countingR2(inner) {
  const ops = [];
  const wrap = (name) => async (...args) => {
    ops.push({ op: name, key: typeof args[0] === "string" ? args[0] : JSON.stringify(args[0] ?? null) });
    return inner[name](...args);
  };
  return {
    _inner: inner,
    _ops: ops,
    get _count() {
      return ops.length;
    },
    head: wrap("head"),
    get: wrap("get"),
    put: wrap("put"),
    delete: wrap("delete"),
    list: wrap("list"),
  };
}

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

const vocab = (id, target) => facet(id, { target, kind: "rendered-state", lineage: "req_d30render01" });

function contractBody() {
  return {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: "e".repeat(64),
    documentSha256: "e".repeat(64),
    sealedAt: "2026-08-08T00:00:00.000Z",
    requirements: [
      req(ROUTE_REQUIREMENT, "routing", 'When Q7 is answered "Yes", the survey must route to Q9.'),
      req("req_d30render01", "rendered-state", "Every screen must display exactly one question."),
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
      reviewedBy: "d30-fixture",
      reviewedAt: "2026-08-08T00:00:00.000Z",
      gates: passingGates(),
    },
  };
}

// ---------------------------------------------------------------------------
// The walk artifact — a healthy site: Q7 answered "Yes" lands on Q9, as documented
// ---------------------------------------------------------------------------

const screen = (text) => ({
  at: "2026-08-08T00:05:00.000Z",
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
    actions: [
      { kind: "click-option", targetIdx: 0, targetLabel: "Yes", targetCode: "1", value: null, ok: true, detail: null },
    ],
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
  planRevisionId: "plan_d30budget",
  surveyUrl: "https://fixture.invalid/survey",
  startedAt: "2026-08-08T00:04:00.000Z",
  endedAt: "2026-08-08T00:05:00.000Z",
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

const walkProjectionPayload = (observationEvidenceId) => ({
  pathId: PATH_ID,
  attemptId: ATTEMPT_ID,
  observationEvidenceId,
  outcome: "completed",
  outcomeDetail: null,
  screensAdvanced: 1,
  steps: 1,
  exercised: true,
  observedAt: "2026-08-08T00:05:00.000Z",
});

const observationRow = (id, facetInstanceId, evidenceId) => ({
  observationId: id,
  facetInstanceId,
  attemptId: ATTEMPT_ID,
  routeId: PATH_ID,
  observedAt: "2026-08-08T00:05:00.000Z",
  payloadKind: "v2-walk-projection/1.0.0",
  payload: walkProjectionPayload(evidenceId),
  completeness: "complete-scoped-inventory",
  evidenceIds: [evidenceId],
  verifier: { decision: "insufficient", evidenceIds: [evidenceId], verifierVersion: "none/not-yet-verified" },
  attestation: {
    producedBy: "v2-executor",
    producerVersion: "v2-observation-projection/1.0.0",
    payloadHash: "sha256:d30",
  },
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Seal, store the walk, commit `observations` observations citing it, and then bury it under
 * `decoys` further catalogue entries — the screenshots and per-screen DOM reads a real run
 * produces in their thousands and which verification has no reason to open.
 */
async function seedRun(mod, env, { decoys = 0, observations = 1 } = {}) {
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

  const decoyIds = [];
  for (let i = 0; i < decoys; i++) {
    const d = await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode(`{"screenshot":${i}}`),
      mediaType: "application/json",
      type: "screenshot",
      attemptId: ATTEMPT_ID,
      routeId: PATH_ID,
      witnesses: [],
      sourceEvidenceId: `EV-${PATH_ID}-decoy-${i}`,
      artifactRef: `observations/${PATH_ID}/decoy-${i}.json`,
    });
    decoyIds.push(d.evidenceId);
  }

  // MANY OBSERVATIONS, ONE ARTIFACT — the real ratio. A single walk closes every case on its
  // path (212 cases over 8 contributing walks in the incident run), so the artifact cache is
  // what must absorb the fan-in, and this fixture is only meaningful because M > K.
  const rows = [];
  for (let i = 0; i < observations; i++) {
    rows.push(observationRow(`obs_d30_${i}`, "fi_route_q7", entry.evidenceId));
  }
  await env.EVIDENCE.put(mod.keys.observationsKey(runId), JSON.stringify({ observations: rows }), {
    httpMetadata: { contentType: "application/json" },
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
    d.counts = { ...d.counts, exercised: 1, pending: 1 };
  });

  return { runId, evidenceId: entry.evidenceId, decoyIds };
}

/** Seed, then count ONLY the R2 operations `verifyObservations` itself performs. */
async function verifyAndCount(opts) {
  const mod = await worker();
  const env = testEnv();
  const seeded = await seedRun(mod, env, opts);

  // The counter is installed AFTER seeding so the fixture's own writes are not counted.
  const counting = countingR2(env.EVIDENCE);
  const result = await mod.verifyObservations.verifyObservations({ ...env, EVIDENCE: counting }, seeded.runId);

  const ledger = JSON.parse(await (await env.EVIDENCE.get(mod.keys.observationsKey(seeded.runId))).text()).observations;
  return { mod, env, result, ledger, ops: counting._ops, ...seeded };
}

// ===========================================================================
suite("D30 — verification's R2 cost is bounded by the artifacts it cites", () => {
  test("THE ONE THAT MATTERS: 40x more catalogue entries costs exactly zero more R2 operations", async () => {
    const small = await verifyAndCount({ decoys: 10, observations: 12 });
    const large = await verifyAndCount({ decoys: 400, observations: 12 });

    // Both must actually have verified something — a stage that returned early would also
    // spend nothing, and would satisfy an equality test while proving the opposite.
    assertEq(small.result.state, "evaluated", "the small run must really verify");
    assertEq(large.result.state, "evaluated", "the large run must really verify");
    assertEq(small.result.value.verified, 12, `expected 12 verified, got ${JSON.stringify(small.result.value)}`);
    assertEq(large.result.value.verified, 12, `expected 12 verified, got ${JSON.stringify(large.result.value)}`);

    assertEq(
      large.ops.length,
      small.ops.length,
      `verification's R2 cost must not grow with the catalogue. 10 decoys cost ${small.ops.length} ` +
        `operation(s), 400 decoys cost ${large.ops.length}. A difference of ~390 means the whole ` +
        `catalogue is being listed and read again — the exact fan-out that exhausted the ` +
        `invocation's subrequest budget on v2r_01kzfb6py8pbxznqv022p2qkhb.`,
    );
  });

  test("and the cost is small in absolute terms: one keyed read per distinct artifact, not one per case", async () => {
    const { ops, result } = await verifyAndCount({ decoys: 50, observations: 40 });

    // 40 observations, 1 distinct artifact (K=1). The run-inputs preamble reads the
    // checkpoint, envelope, sealed revision and observations; verification then reads the
    // catalogue entry and the blob for the ONE artifact and writes the stamped ledger back.
    // Ten is comfortable headroom over that and is still ~1/170th of a 1,707-entry scan.
    assert(
      ops.length <= 10,
      `verification of 40 observations over 1 artifact took ${ops.length} R2 operation(s): ` +
        `${JSON.stringify(ops.map((o) => `${o.op} ${o.key}`))}`,
    );
    assertEq(result.value.verified, 40, JSON.stringify(result.value));
  });

  test("the decoys are not merely cheap to read — they are never touched at all", async () => {
    const { ops, decoyIds, mod, runId } = await verifyAndCount({ decoys: 25, observations: 5 });

    const touched = decoyIds.filter((id) => ops.some((o) => o.key === mod.keys.evidenceCatalogKey(runId, id)));
    assertEq(
      touched.length,
      0,
      `verification opened ${touched.length} catalogue entr(ies) no observation cites: ${JSON.stringify(touched)}`,
    );

    // The positive half, so this cannot pass by never reading anything: the CITED entry IS read.
    assert(
      ops.some((o) => o.op === "get" && String(o.key).includes("/evidence/")),
      `the cited catalogue entry must still be read by key: ${JSON.stringify(ops.map((o) => `${o.op} ${o.key}`))}`,
    );
  });
});

// ===========================================================================
suite("D30 — the cheaper read path still refuses evidence it cannot bind", () => {
  /**
   * THE POINT OF THIS SUITE. `listCatalog` ran `assertCatalogBinding` on every entry it
   * returned. If reading by key skipped that, this change would have bought subrequests by
   * deleting an integrity check — a fabrication hole wearing an optimisation's clothes. So the
   * two ways evidence can fail to bind are exercised against the NEW path directly.
   */
  /**
   * THE CITATION IS TAMPERED WITH AND THE BYTES ARE PERFECT.
   *
   * This fixture is built the way it is because the obvious version of it does not test
   * anything. Repointing the entry at a DIFFERENT artifact makes the walk fail to verify on
   * its own merits — no steps, no binding step, `insufficient` — so the test passes whether or
   * not the binding assertion runs. That version was written first, and swapping
   * `getBoundCatalogEntry` for the unbound `getCatalogEntry` left the whole suite green.
   *
   * So the bytes here are the SAME healthy walk that the control below verifies. Only the
   * entry's `sourceEvidenceId` is altered — the citation, not the content. Every content check
   * still passes: the blob exists, it re-hashes to the stated `contentHash`, it parses as a
   * PathObservation, and its step would satisfy the sealed route case. The ONLY thing wrong is
   * that the entry's `evidenceId` no longer re-derives from its own fields, which is exactly
   * and only what `assertCatalogBinding` catches.
   *
   * Verified with the mutation: replacing `getBoundCatalogEntry` with `getCatalogEntry` turns
   * this from `insufficient` into a `verified` — a pass minted from a citation that had been
   * moved. That is the fabrication this assertion exists to stop.
   */
  test("a catalogue entry whose CITATION was altered cannot verify, even though its bytes are perfect", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId, evidenceId } = await seedRun(mod, env, { decoys: 3, observations: 4 });

    const key = mod.keys.evidenceCatalogKey(runId, evidenceId);
    const entry = JSON.parse(await (await env.EVIDENCE.get(key)).text());
    await env.EVIDENCE.put(
      key,
      JSON.stringify({ ...entry, sourceEvidenceId: `EV-${PATH_ID}-someone-elses-citation` }),
      { httpMetadata: { contentType: "application/json" } },
    );

    const result = await mod.verifyObservations.verifyObservations(env, runId);
    assertEq(result.state, "evaluated");
    assertEq(
      result.value.verified,
      0,
      `an entry that no longer binds to its own id must never support a pass — the bytes being ` +
        `healthy is precisely what makes this dangerous: ${JSON.stringify(result.value)}`,
    );
    assertEq(
      result.value.contradicted,
      0,
      `nor may it mint a defect — evidence we cannot bind is "we cannot know": ${JSON.stringify(result.value)}`,
    );
    assertEq(result.value.insufficient, 4, JSON.stringify(result.value.byReason));
  });

  /**
   * The other half of the chain, and it fails for a different reason than the one above: here
   * the CITATION is untouched and the BYTES were swapped underneath it. `getVerifiedEvidence`
   * re-hashes the blob against the entry's `contentHash`, so storage that returns different
   * bytes than the catalogue committed to can never reach a predicate.
   */
  test("bytes swapped underneath an untouched citation cannot verify either", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId, evidenceId } = await seedRun(mod, env, { decoys: 3, observations: 4 });

    const entry = JSON.parse(
      await (await env.EVIDENCE.get(mod.keys.evidenceCatalogKey(runId, evidenceId))).text(),
    );
    // Overwrite the content-addressed blob in place. The catalogue still says contentHash H;
    // what lives at H no longer hashes to H.
    await env.EVIDENCE.put(
      mod.keys.evidenceBlobKey(entry.contentHash),
      enc.encode(JSON.stringify({ ...walkArtifact(runId), tampered: true })),
      { httpMetadata: { contentType: "application/json" } },
    );

    const result = await mod.verifyObservations.verifyObservations(env, runId);
    assertEq(result.value.verified, 0, `a failed re-hash must never support a pass: ${JSON.stringify(result.value)}`);
    assertEq(result.value.contradicted, 0, JSON.stringify(result.value));
    assertEq(result.value.insufficient, 4, JSON.stringify(result.value.byReason));
  });

  test("an observation citing an artifact with no catalogue entry is insufficient, never a pass", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId, evidenceId } = await seedRun(mod, env, { decoys: 3, observations: 4 });

    await env.EVIDENCE.delete(mod.keys.evidenceCatalogKey(runId, evidenceId));

    const result = await mod.verifyObservations.verifyObservations(env, runId);
    assertEq(result.value.verified, 0, `a missing entry must not verify: ${JSON.stringify(result.value)}`);
    assertEq(result.value.contradicted, 0, JSON.stringify(result.value));
    assertEq(result.value.insufficient, 4, JSON.stringify(result.value.byReason));
  });

  test("the healthy control DOES verify — so the two refusals above are not a broken verifier", async () => {
    const { result } = await verifyAndCount({ decoys: 3, observations: 4 });
    assertEq(result.value.verified, 4, `the untouched fixture must still pass: ${JSON.stringify(result.value)}`);
  });
});

// ===========================================================================
suite("D30 — the invocation boundary before judging", () => {
  /**
   * THIS ASSERTION USED TO SAY THE OPPOSITE, AND THE REVERSAL IS THE POINT.
   *
   * It required `step.sleep("yield-before-judging", "30 seconds")` to sit on the
   * execution/judging seam, on the theory that a sleep makes the Workflow yield and a new
   * Worker invocation carries a fresh subrequest budget. The theory was never verifiable from
   * here — the test's own docblock said so — and it has since been MEASURED FALSE on a real
   * run: the Worker invocation id is THE SAME on both sides of the sleep, so it reset nothing.
   * The in-tree precedent already pointed the same way: the four `record-failure` retries
   * (5 s / 10 s / 20 s) each failed instantly with the identical ceiling error.
   *
   * So the sleep was 30 seconds of dead wall clock on every run, and it is deleted. What the
   * suite guards now is that it does not come back by habit, and that the two layers which do
   * carry the load are still named where the sleep used to be — `limits.subrequests` and
   * verify-observations' keyed reads (the tests above this one). A comment that merely
   * MENTIONS the removed sleep is fine and expected; a live `step.sleep` call is not.
   */
  test("run-workflow does NOT burn wall clock on a sleep that resets no budget", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("../../src/workflow/run-workflow.ts", import.meta.url)), "utf8");

    assert(
      src.indexOf('step.sleep("yield-before-judging"') === -1,
      "the yield-before-judging sleep is back. It was measured NOT to start a new Worker invocation " +
        "(same invocation id on both sides), so it resets no subrequest budget and costs 30 s of every run.",
    );

    // The seam it used to sit on must still exist, or this test is asserting the absence of a
    // sleep from a workflow that no longer has the shape the sleep was about.
    const closeAt = src.indexOf('step.do("phase-executing-close"');
    const projectAt = src.indexOf('step.do("project-observations"');
    assert(closeAt !== -1 && projectAt !== -1, "the steps this boundary sat between were renamed");
    assert(closeAt < projectAt, "execution must still close before the judging tail begins");

    // AND THE REASONING MUST SURVIVE THE DELETION. Removing the sleep without leaving the
    // subrequest problem written down is how the next agent re-adds it.
    const seam = src.slice(closeAt, projectAt);
    assert(
      seam.includes("limits.subrequests"),
      "the seam must still name what actually bounds the subrequest budget, or the deletion reads as " +
        "'the problem was imaginary'",
    );
  });

  /**
   * NO `step.sleep` SURVIVES ON THE HAPPY PATH AT ALL. The only remaining sleep in the file is
   * `failure-recording-cooldown`, which sits in the catch block and is explicitly documented as
   * "cheap, guarded, and load-bearing for nothing". Asserting the count keeps a second
   * speculative yield from appearing somewhere else in the tail.
   */
  test("the only sleep left in the workflow is the failure-path cooldown", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("../../src/workflow/run-workflow.ts", import.meta.url)), "utf8");

    const sleeps = [...src.matchAll(/step\.sleep\(\s*"([^"]+)"/g)].map((m) => m[1]);
    assertEq(
      JSON.stringify(sleeps),
      JSON.stringify(["failure-recording-cooldown"]),
      `the workflow's sleeps are ${JSON.stringify(sleeps)}; only the failure-path cooldown is intended`,
    );
  });

  /**
   * THE DOUBLE ITSELF. `fakeStep.sleep` used to be `async sleep() {}` — a no-op that recorded
   * nothing, so a workflow that never slept and one that slept with the wrong arguments were
   * indistinguishable to the whole suite. That is the same class of defect as the test double
   * that was a plain object where production is an RPC stub: 340 green, and a crash in
   * production. This asserts the double can now tell the difference.
   */
  test("the step double records sleeps rather than silently swallowing them", async () => {
    const step = fakeStep();
    await step.do("some-step", async () => "ok");
    await step.sleep("yield-before-judging", "30 seconds");

    assertEq(step.sleeps.length, 1, "a sleep the double does not record is a sleep no test can assert");
    assertEq(step.sleeps[0].name, "yield-before-judging");
    assertEq(step.sleeps[0].duration, "30 seconds");
    assert(!step.calls.includes("yield-before-judging"), "a sleep is a boundary, not a step; it must not enter `calls`");
  });
});

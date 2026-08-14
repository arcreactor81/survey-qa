/**
 * D11 — no stage may certify work it did not do, and the test axis closes only on a gate.
 *
 * All four extraction gates are tested at the gate level with real pipeline code:
 * zeroUnexplainedNormativeBlocks, noUnresolvedHighRiskDisagreement,
 * allConstructClassesDispositioned, allScopedExpansionsPreviewed. The workflow tests
 * exercise the full path through verifying, adjudicating, and close-test-axis, proving
 * the test axis properly closes when all requirements are settled.
 *
 * Coverage includes the gate primitives, seal/read/judge enforcement, and workflow
 * completion. Caller-level tests matter here: a direct validator can remain green while
 * a stored-reader or authority binder quietly stops calling it.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, assertEq, assertThrows, fakeStep, REPO_ROOT, suite, test } from "../testkit.mjs";
import { seedRun, testEnv, worker } from "./_helpers.mjs";
import { contractBody, FIXTURE_KEY, passingGates, runRecordV2 } from "../fixtures/v2-fixture.mjs";
import { signRunRecordV2 } from "../assembler/assemble-v2.mjs";
import { loadEvidenceAuthority } from "../../../pipeline/judge/lib/authority.mjs";
import { contractGateFailures, REQUIRED_CONTRACT_GATES } from "../../shared/v2-record.mjs";

const notEvaluatedStage = (what) => ({ state: "not-evaluated", reason: "NOT_IMPLEMENTED", detail: what });

const HARNESS_KEY_REGISTRY = path.join(REPO_ROOT, "scorer", "fixtures", "keys", "registry.json");
const HARNESS_PRIVATE_KEY = readFileSync(
  path.join(REPO_ROOT, "scorer", "fixtures", "keys", "TEST-ONLY-fixture-harness.private.pem"),
  "utf8",
);

function invalidGateCases() {
  const partial = passingGates();
  delete partial.allScopedExpansionsPreviewed;
  const proofless = passingGates();
  proofless.allScopedExpansionsPreviewed = { state: "pass" };
  return [
    {
      name: "empty",
      gates: {},
      failures: REQUIRED_CONTRACT_GATES.map((gate) => `${gate}:missing`),
    },
    {
      name: "three-of-four",
      gates: partial,
      failures: ["allScopedExpansionsPreviewed:missing"],
    },
    {
      name: "proofless-pass",
      gates: proofless,
      failures: ["allScopedExpansionsPreviewed:pass"],
    },
    {
      name: "null-map",
      gates: null,
      failures: REQUIRED_CONTRACT_GATES.map((gate) => `${gate}:missing`),
    },
  ];
}

async function neverSealableRevision(mod, gates) {
  const body = contractBody();
  body.extraction.gates = gates;
  const identity = await mod.contractRevision.revisionIdentity(body);
  return { body, identity, revision: { ...body, contractRevisionId: identity.contractRevisionId } };
}

const payloadFor = (runId) => ({
  payload: {
    runId,
    surveyUrl: "https://fixture.invalid/s",
    documentKey: "k",
    documentSha256: "a".repeat(64),
    profile: "standard",
    locale: "en",
    viewports: ["desktop"],
  },
});

suite("D11 — no stage may certify work it did not do", () => {
  test("an unevaluated stage yields `not-evaluated` gates, never a passing one", async () => {
    const mod = await worker();
    const gates = mod.workflow.deriveGates(
      notEvaluatedStage("ledger"),
      notEvaluatedStage("diff"),
      notEvaluatedStage("constructs"),
      notEvaluatedStage("expansion"),
    );
    for (const [name, g] of Object.entries(gates)) {
      assertEq(g.state, "not-evaluated", `gate ${name}`);
      assertEq(mod.gates.gatePassed(g), false, `gate ${name} must not count as passed`);
      assert(!("value" in g), `gate ${name} must expose no value in the successful domain`);
    }
  });

  test("a `pass` gate WITHOUT a proof does not count as passed", async () => {
    const mod = await worker();
    assertEq(mod.gates.gatePassed({ state: "pass", proof: undefined }), false);
    assertEq(
      mod.gates.gatePassed({ state: "pass", proof: { evaluatorId: "", evaluatorVersion: "", inputHash: "", observedAt: "" } }),
      false,
    );
    assertEq(
      mod.gates.gatePassed({
        state: "pass",
        proof: { evaluatorId: "x", evaluatorVersion: "1", inputHash: "sha256:1", observedAt: "2026-08-02T00:00:00Z" },
      }),
      true,
    );
  });

  test("sealContract REFUSES a contract whose gates were never evaluated", async () => {
    const mod = await worker();
    const env = testEnv();
    const body = contractBody();
    body.extraction.gates = mod.workflow.deriveGates(
      notEvaluatedStage("ledger"),
      notEvaluatedStage("diff"),
      notEvaluatedStage("constructs"),
      notEvaluatedStage("expansion"),
    );
    const err = await assertThrows(() => mod.contractRevision.sealContract(env, body), "unmet approval gates");
    assertEq(err.name, "ContractGateFailure");
    assert(err.message.includes("not-evaluated"), "the failure must name the state, not just the gate");
  });

  test("sealContract accepts only gates that pass WITH a proof", async () => {
    const mod = await worker();
    const env = testEnv();
    const sealed = await mod.contractRevision.sealContract(env, contractBody());
    assert(sealed.contractRevisionId.startsWith("cr_"));

    const noProof = contractBody();
    noProof.extraction.gates = { ...passingGates(), allScopedExpansionsPreviewed: { state: "pass" } };
    await assertThrows(() => mod.contractRevision.sealContract(env, noProof), "unmet approval gates");
  });

  test("missing approval-gate entries fail closed in both gate validators", async () => {
    const mod = await worker();
    const env = testEnv();

    const empty = contractBody();
    empty.extraction.gates = {};
    assertEq(mod.gates.unmetGates(empty.extraction.gates).length, 4, "an empty map is four missing gates");
    assertEq(contractGateFailures(empty.extraction.gates).length, 4, "the shared judge validator must agree");
    const emptyError = await assertThrows(
      () => mod.contractRevision.sealContract(env, empty),
      "unmet approval gates",
    );
    assert(emptyError.message.includes("zeroUnexplainedNormativeBlocks:missing"));

    const threeOfFour = contractBody();
    threeOfFour.extraction.gates = passingGates();
    delete threeOfFour.extraction.gates.allScopedExpansionsPreviewed;
    assertEq(mod.gates.unmetGates(threeOfFour.extraction.gates).length, 1);
    assertEq(contractGateFailures(threeOfFour.extraction.gates).length, 1);
    const partialError = await assertThrows(
      () => mod.contractRevision.sealContract(env, threeOfFour),
      "unmet approval gates",
    );
    assert(partialError.message.includes("allScopedExpansionsPreviewed:missing"));
  });

  test("stored revisions with missing or proofless gates are refused after their identity re-binds", async () => {
    const mod = await worker();
    const env = testEnv();

    for (const c of invalidGateCases()) {
      const { identity, revision } = await neverSealableRevision(mod, c.gates);
      await env.EVIDENCE.put(mod.keys.contractRevisionKey(identity.contractRevisionId), JSON.stringify(revision), {
        httpMetadata: { contentType: "application/json" },
      });

      const err = await assertThrows(
        () => mod.contractRevision.getContractRevision(env, identity.contractRevisionId, { contractHash: identity.contractHash }),
        "approval gates do not pass",
      );
      assertEq(err.name, "ContractRevisionTampered", c.name);
      for (const failure of c.failures) {
        assert(err.message.includes(failure), `${c.name}: missing diagnostic ${failure}: ${err.message}`);
      }
    }
  });

  test("the independent judge refuses correctly hashed and signed revisions with missing or proofless gates", async () => {
    const mod = await worker();
    const scratch = mkdtempSync(path.join(tmpdir(), "survey-qa-d11-authority-"));

    try {
      for (const c of invalidGateCases()) {
        const { identity, revision } = await neverSealableRevision(mod, c.gates);
        const runId = mod.ids.mintRunId();
        const record = signRunRecordV2(
          runRecordV2({
            runId,
            contractRevisionId: identity.contractRevisionId,
            contractHash: identity.contractHash,
            evidence: [],
          }),
          {
            privateKeyPem: HARNESS_PRIVATE_KEY,
            keyId: "fixture-harness-key-1",
            signedAt: "2026-08-05T00:00:00.000Z",
          },
        );

        const runDir = path.join(scratch, c.name);
        const recordPath = path.join(runDir, "run-record.v2.json");
        const revisionPath = path.join(runDir, "contract-revision.json");
        mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
        writeFileSync(recordPath, JSON.stringify(record), "utf8");
        writeFileSync(revisionPath, JSON.stringify(revision), "utf8");

        const authority = loadEvidenceAuthority({
          runDir,
          checklist: { obligations: [] },
          runRecordPath: recordPath,
          keyRegistryPath: HARNESS_KEY_REGISTRY,
          allowFixtureKeys: true,
          contractRevisionPath: revisionPath,
        });

        assertEq(authority.signatureVerified, true, `${c.name}: the valid record signature must be reached`);
        assertEq(authority.contractBound, false, `${c.name}: an unsealable denominator must not bind`);
        assert(
          !authority.findings.some(
            (f) => f.code === "CONTRACT_REVISION_TAMPERED" || f.code === "CONTRACT_HASH_MISMATCH",
          ),
          `${c.name}: identity/hash checks must pass before the gate refusal: ${JSON.stringify(authority.findings)}`,
        );
        const gateFinding = authority.findings.find(
          (f) => f.code === "CONTRACT_REVISION_UNSEALED" && f.detail.includes("approval gates do not pass"),
        );
        assert(gateFinding, `${c.name}: no gate-specific authority finding: ${JSON.stringify(authority.findings)}`);
        for (const failure of c.failures) {
          assert(
            gateFinding.detail.includes(failure),
            `${c.name}: authority finding omitted ${failure}: ${gateFinding.detail}`,
          );
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("all four extraction gates are not-evaluated when no stage ran", async () => {
    const mod = await worker();
    const gates = mod.workflow.deriveGates(
      notEvaluatedStage("source-ledger"),
      notEvaluatedStage("extraction-diff"),
      notEvaluatedStage("construct-checklist"),
      notEvaluatedStage("floor-expansion-preview"),
    );
    assertEq(Object.keys(gates).length, 4, "four gates total");
    for (const [name, g] of Object.entries(gates)) {
      assertEq(g.state, "not-evaluated", `gate ${name}`);
      assertEq(mod.gates.gatePassed(g), false, `gate ${name} must not count as passed`);
    }
    const unmet = mod.gates.unmetGates(gates);
    assertEq(unmet.length, 4, "all four gates must be unmet");
  });

  test("a passing extraction with zero problems yields four pass gates", async () => {
    const mod = await worker();
    const proof = { evaluatorId: "test", evaluatorVersion: "1", inputHash: "sha256:a", observedAt: "2026-08-02T00:00:00Z" };
    const gates = mod.workflow.deriveGates(
      { state: "evaluated", value: { hash: "h1", unexplainedNormativeBlocks: 0 }, proof },
      { state: "evaluated", value: { hash: "h2", highRiskDisagreements: 0 }, proof },
      { state: "evaluated", value: { hash: "h3", undispositionedConstructs: 0, names: [] }, proof },
      { state: "evaluated", value: { hash: "h4", unpreviewedRequirements: 0 }, proof },
    );
    for (const [name, g] of Object.entries(gates)) {
      assertEq(g.state, "pass", `gate ${name} must pass`);
      assertEq(mod.gates.gatePassed(g), true, `gate ${name} must count as passed`);
    }
    assertEq(mod.gates.unmetGates(gates).length, 0);
  });

  test("a problem in any one gate fails that gate and leaves the rest alone", async () => {
    const mod = await worker();
    const proof = { evaluatorId: "test", evaluatorVersion: "1", inputHash: "sha256:a", observedAt: "2026-08-02T00:00:00Z" };
    const gates = mod.workflow.deriveGates(
      { state: "evaluated", value: { hash: "h1", unexplainedNormativeBlocks: 0 }, proof },
      { state: "evaluated", value: { hash: "h2", highRiskDisagreements: 3 }, proof },
      { state: "evaluated", value: { hash: "h3", undispositionedConstructs: 0, names: [] }, proof },
      { state: "evaluated", value: { hash: "h4", unpreviewedRequirements: 0 }, proof },
    );
    assertEq(gates.zeroUnexplainedNormativeBlocks.state, "pass");
    assertEq(gates.noUnresolvedHighRiskDisagreement.state, "fail");
    assertEq(gates.allConstructClassesDispositioned.state, "pass");
    assertEq(gates.allScopedExpansionsPreviewed.state, "pass");
    assertEq(mod.gates.unmetGates(gates).length, 1);
  });

  test("WORKFLOW: close-test-axis completes the test axis on a run with no blockers", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env, { testCompletion: "running" });
    // Seed the execution cursor as ALREADY DONE: no pending cases, plan revision present.
    // This makes the workflow take the resume path — no re-planning, no browser work —
    // so the ledger (exercised 2, pending 0) is the genuine result of a finished run,
    // not a fiction that a fresh plan would overwrite.
    await mod.checkpoint.updateCheckpoint(env, seeded.runId, (d) => {
      d.execution = {
        batchIndex: 0,
        sessionId: null,
        sessionOpenedAt: null,
        pendingCaseIds: [],
        completedCaseIds: [],
        planRevisionId: "plan_fixture_complete",
      };
    });
    // The plan program itself — executeBatch reads it back by revision id. Without it the
    // batch returns `plan-missing` and the run ends partial-blocked, not complete.
    //
    // Program 2.0.0 requires the plan to account for EVERY sealed case exactly once across
    // `floor[].caseIds + unassignedCaseIds`, and `caseOrder` to permute the same set. This
    // run has no floor work left to do, so every sealed case is carried as unassigned — the
    // shape a plan takes when no path witnesses a case. Derived from the seal rather than
    // written out, so it cannot drift from what the fixture actually sealed.
    const sealedCaseIds = (
      await mod.contractRevision.getContractRevision(env, seeded.contractRevisionId)
    ).facetInstances.map((fi) => fi.facetInstanceId);

    await env.EVIDENCE.put(
      mod.keys.planKey(seeded.runId, "plan_fixture_complete"),
      JSON.stringify({
        kind: "v2-execution-program/2.0.0",
        // 2.0.0 binds the program to its run: `loadProgram` refuses a program whose runId
        // is not the run it was loaded under, so a program copied between runs can never
        // be replayed as the second run's plan.
        runId: seeded.runId,
        planRevisionId: "plan_fixture_complete",
        contractRevisionId: seeded.contractRevisionId,
        contractHash: seeded.contractHash,
        generatedAt: "2026-08-02T00:01:00.000Z",
        surveyUrl: "https://fixture.invalid/survey",
        floor: [],
        exploration: [],
        caseOrder: sealedCaseIds,
        unassignedCaseIds: sealedCaseIds,
        coverage: {
          obligations: 2,
          witnessedByFloor: 2,
          coversAllObligations: true,
          coversAllAfterMandatoryExploration: true,
          uncovered: [],
        },
        warnings: [],
        plan: { floor: { paths: [] }, exploration: { queue: [] } },
      }),
      { httpMetadata: { contentType: "application/json" } },
    );

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    await wf.run(payloadFor(seeded.runId), fakeStep());

    const cp = (await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
    assertEq(cp.completion.report, "complete", "the report built and published");
    assertEq(cp.reportAvailable, true);
    assertEq(cp.completion.test, "complete", "the test axis must be complete when all cases are settled");
    assertEq(cp.completion.reasonCode, null);
  });

  test("WORKFLOW: a blocked axis is terminal in the signed closure before the report is published", async () => {
    // Exact regression shape from the reuse review: execution has no remaining cursor work,
    // then the plan artifact becomes unreadable before the closing gate re-reads it. That is a
    // close-test-axis blocker reached while completion.test is still `running`, rather than an
    // earlier deliberate partial stop. The step hook below models that storage race precisely.
    // Finalize used to repair the checkpoint only AFTER supersede-record and report, leaving the
    // signed closure permanently in the non-terminal state it observed before the repair.
    const mod = await worker();
    const env = testEnv({
      RECORD_SIGNING_KEY: FIXTURE_KEY.privateKeyPem,
      RECORD_SIGNING_KEY_ID: FIXTURE_KEY.keyId,
    });
    const seeded = await seedRun(mod, env, { testCompletion: "running" });
    await mod.checkpoint.updateCheckpoint(env, seeded.runId, (d) => {
      d.execution = {
        batchIndex: 0,
        sessionId: null,
        sessionOpenedAt: null,
        pendingCaseIds: [],
        completedCaseIds: [],
        planRevisionId: "plan_removed_at_closure",
      };
    });

    const sealedCaseIds = (
      await mod.contractRevision.getContractRevision(env, seeded.contractRevisionId)
    ).facetInstances.map((fi) => fi.facetInstanceId);
    const planKey = mod.keys.planKey(seeded.runId, "plan_removed_at_closure");
    await env.EVIDENCE.put(
      planKey,
      JSON.stringify({
        kind: "v2-execution-program/2.0.0",
        runId: seeded.runId,
        planRevisionId: "plan_removed_at_closure",
        contractRevisionId: seeded.contractRevisionId,
        contractHash: seeded.contractHash,
        generatedAt: "2026-08-11T00:00:00.000Z",
        surveyUrl: "https://fixture.invalid/survey",
        floor: [],
        exploration: [],
        caseOrder: sealedCaseIds,
        unassignedCaseIds: sealedCaseIds,
        coverage: {
          obligations: sealedCaseIds.length,
          witnessedByFloor: sealedCaseIds.length,
          coversAllObligations: true,
          coversAllAfterMandatoryExploration: true,
          uncovered: [],
        },
        warnings: [],
        plan: { floor: { paths: [] }, exploration: { queue: [] } },
      }),
      { httpMetadata: { contentType: "application/json" } },
    );

    const step = fakeStep();
    const executeStep = step.do;
    step.do = async (name, a, b) => {
      if (name === "close-test-axis") await env.EVIDENCE.delete(planKey);
      return await executeStep(name, a, b);
    };

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    await wf.run(payloadFor(seeded.runId), step);

    const cp = (await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
    assertEq(cp.completion.test, "failed", "the blocker must terminate before publication");
    assertEq(cp.completion.reasonCode, "test-axis-never-closed");

    const record = await (await env.EVIDENCE.get(mod.keys.recordKey(seeded.runId))).json();
    assert(record.attestation?.payloadHash, "the closure under test must actually be signed");
    assert(record.closure, "the published record must be the superseding closure revision");
    assertEq(record.closure.testAxis.closed, false);
    assertEq(
      record.closure.testAxis.completion,
      "failed",
      "the signed closure must see the same terminal state as the final checkpoint",
    );
    assertEq(record.closure.testAxis.reasonCode, "test-axis-never-closed");
    assert(record.closure.testAxis.blockers.length > 0, "the closure must retain what prevented closure");

    const report = await (await env.EVIDENCE.get(mod.keys.reportPointerKey(seeded.runId))).json();
    assertEq(report.final, false, "a blocked axis must never publish a final report manifest");
  });

  test("WORKFLOW: a run with unsettled cases NEVER closes the test axis", async () => {
    // THE HONEST INVARIANT THIS FILE MUST DEFEND: a run in which some cases never reached
    // a verdict is NOT a completed test, whatever the report does. The seed below plants
    // two cases that ended `blocked` (unsettled) — the exact shape of a real run whose
    // browser failed — and the workflow must leave the axis open, then finalize marks it
    // failed with the reason named, never `complete`.
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env, { testCompletion: "running" });
    await mod.checkpoint.updateCheckpoint(env, seeded.runId, (d) => {
      d.counts = { ...d.counts, exercised: 0, blocked: 2, pending: 0 };
    });

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    await wf.run(payloadFor(seeded.runId), fakeStep());

    const cp = (await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
    // THE ASSERTION THIS TEST EXISTS FOR:
    assert(cp.completion.test !== "complete", `unsettled cases must never close the axis (test=${cp.completion.test})`);
    // The run ends `partial-blocked` (execution stopped, cases reclassified as blocked
    // by executing-close) OR `failed` (if nothing stopped execution and finalize named
    // the never-closed axis). Either is honest; `complete` is not.
    assert(
      ["partial-blocked", "failed"].includes(cp.completion.test),
      `test axis must end partial-blocked or failed, got ${cp.completion.test}`,
    );
    assert(cp.completion.reasonCode, `a non-complete axis must carry a reason, got ${cp.completion.reasonCode}`);
  });

  test("WORKFLOW: verifying and adjudicating complete on a run with a sealed contract and record", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env, { testCompletion: "running" });
    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    await wf.run(payloadFor(seeded.runId), fakeStep());

    const cp = (await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
    for (const name of ["verifying", "adjudicating"]) {
      const ph = cp.phases.find((p) => p.name === name);
      assertEq(ph.state, "complete", `${name} runs its evaluation and completes`);
    }
  });

  test("WORKFLOW: a run whose usage exceeds a cap stops with budget-exhausted, not a fake pass", async () => {
    // THE CAPS ARE ENFORCED AGAINST THE CHECKPOINT'S USAGE COUNTERS — which used to be
    // nothing ever incremented. This test proves the enforcement path: a seeded run whose
    // tool-call counter is already over its cap must stop with `tool-call-cap`, reclassify
    // its pending cases as budget-exhausted, and never report the test axis complete.
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env, { testCompletion: "running" });
    await mod.checkpoint.updateCheckpoint(env, seeded.runId, (d) => {
      // A case that exists but was never exercised — the run has real unsettled work.
      d.counts = { ...d.counts, exercised: 1, pending: 1 };
      d.usage.toolCalls.used = d.usage.toolCalls.max + 1;
    });

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    await wf.run(payloadFor(seeded.runId), fakeStep());

    const cp = (await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
    assert(
      cp.completion.reasonCode === "tool-call-cap" ||
        cp.completion.reasonCode === "cost-cap" ||
        cp.completion.reasonCode === "model-call-cap",
      `the run must stop on the cap it breached, got reasonCode=${cp.completion.reasonCode}`,
    );
    assert(cp.completion.test !== "complete", `a capped run must never close the test axis (test=${cp.completion.test})`);
    assert(
      cp.counts["budget-exhausted"] > 0,
      `capped cases must be bucketed as budget-exhausted, got counts=${JSON.stringify(cp.counts)}`,
    );
  });

  test("WORKFLOW: close-test-axis NEVER overwrites a cap-stop's reason, even on a settled ledger", async () => {
    // THE EXACT SHAPE CHANGE B PROTECTS. A run hits a cap (tool-call-cap), the cap's
    // executing-close sets `partial-budget` + reasonCode, AND the ledger happens to look
    // settled (pending was already 0, exercised > 0) so testAxisBlockers returns empty.
    // The old close-test-axis then overwrote `partial-budget` with `complete / null` —
    // the cap-stop's reason erased by the closer. This test seeds exactly that shape and
    // asserts the reason SURVIVES. Revert the guard (allow the clobber) and this test
    // fails: it would read test=complete.
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env, { testCompletion: "running" });
    await mod.checkpoint.updateCheckpoint(env, seeded.runId, (d) => {
      // Settled ledger: nothing pending, nothing unsettled. The cap fires below.
      d.counts = { ...d.counts, exercised: 2, pending: 0 };
      d.usage.toolCalls.used = d.usage.toolCalls.max + 1;
      // Cursor with NO pending work + a plan program (stored below) so execution returns
      // `done` and does not reclassify anything — the ledger stays settled.
      d.execution = {
        batchIndex: 0,
        sessionId: null,
        sessionOpenedAt: null,
        pendingCaseIds: [],
        completedCaseIds: [],
        planRevisionId: "plan_guard",
      };
    });
    // Program 2.0.0 accounts for every sealed case exactly once; nothing is assigned here
    // because this cursor has no pending work. See the note on `plan_fixture_complete`.
    const sealedCaseIds = (
      await mod.contractRevision.getContractRevision(env, seeded.contractRevisionId)
    ).facetInstances.map((fi) => fi.facetInstanceId);
    await env.EVIDENCE.put(
      mod.keys.planKey(seeded.runId, "plan_guard"),
      JSON.stringify({
        kind: "v2-execution-program/2.0.0",
        runId: seeded.runId,
        planRevisionId: "plan_guard",
        contractRevisionId: seeded.contractRevisionId,
        contractHash: seeded.contractHash,
        generatedAt: "2026-08-02T00:01:00.000Z",
        surveyUrl: "https://fixture.invalid/survey",
        floor: [],
        exploration: [],
        caseOrder: sealedCaseIds,
        unassignedCaseIds: sealedCaseIds,
        coverage: { obligations: 2, witnessedByFloor: 2, coversAllObligations: true, coversAllAfterMandatoryExploration: true, uncovered: [] },
        warnings: [],
        plan: { floor: { paths: [] }, exploration: { queue: [] } },
      }),
      { httpMetadata: { contentType: "application/json" } },
    );

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    await wf.run(payloadFor(seeded.runId), fakeStep());

    const cp = (await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
    // THE ASSERTION THAT KILLS THE CLOBBER:
    assertEq(cp.completion.reasonCode, "tool-call-cap", "the cap-stop's reason must survive close-test-axis");
    assert(
      cp.completion.test !== "complete",
      `a cap-stopped run must never read as complete (test=${cp.completion.test})`,
    );
  });

  test("WORKFLOW: extraction that burns the budget stops failed, not partial-budget", async () => {
    // `extractionBudgetExceeded` existed but was never called: extraction could spend
    // past the reserve, seal, and then trip cost-cap at batch 0 with a misleading
    // `partial-budget` after exercising NOTHING. The guard now fires at resume time
    // (catching resumed runs that already over-spent) and at the seal step (catching
    // fresh extraction that just over-spent). This test seeds a sealed run already over
    // the extraction fraction and asserts it stops `failed` — never sealing, never
    // reporting partial-budget, never completing.
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env, { testCompletion: "running" });
    await mod.checkpoint.updateCheckpoint(env, seeded.runId, (d) => {
      // 60% of a 30 USD budget — over the 0.5 extraction fraction.
      d.usage.cost.usedUsd = 18;
      d.usage.cost.maxUsd = 30;
    });

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    await wf.run(payloadFor(seeded.runId), fakeStep());

    const cp = (await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
    assertEq(cp.completion.test, "failed", "extraction over budget is a failure, not a partial run");
    assertEq(cp.completion.reasonCode, "extraction-budget-exceeded");
    assertEq(cp.contract.state, "unavailable", "nothing may be sealed over an unaffordable extraction");
  });

  test("the test-axis gate names every blocker in words", async () => {
    const mod = await worker();
    const blockers = mod.workflow.testAxisBlockers(
      {
        contract: {
          state: "unavailable",
          total: null,
          contractRevisionId: null,
          contractHash: null,
          requirements: { total: null, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
        },
        counts: {
          exercised: 0,
          "not-reached": 0,
          "proven-unreachable": 0,
          blocked: 0,
          "budget-exhausted": 0,
          "time-exhausted": 0,
          pending: 3,
        },
        phases: [{ name: "adjudicating", state: "stopped", observedAt: null, reasonCode: null }],
      },
      notEvaluatedStage("adj"),
      notEvaluatedStage("rec"),
    );
    assert(blockers.length >= 4, JSON.stringify(blockers));
    assert(blockers.some((b) => b.includes("no contract revision was sealed")));
    assert(blockers.some((b) => b.includes("terminal disposition")));
    assert(blockers.some((b) => b.toLowerCase().includes("no runrecord was assembled")));

    const ok = mod.workflow.testAxisBlockers(
      {
        contract: {
          state: "sealed",
          total: 2,
          contractRevisionId: "cr_x",
          contractHash: "sha256:x",
          requirements: { total: 2, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
        },
        counts: {
          exercised: 2,
          "not-reached": 0,
          "proven-unreachable": 0,
          blocked: 0,
          "budget-exhausted": 0,
          "time-exhausted": 0,
          pending: 0,
        },
        phases: [{ name: "adjudicating", state: "complete", observedAt: null, reasonCode: null }],
      },
      { state: "evaluated", value: {}, proof: {} },
      { state: "evaluated", value: { coverageBlockers: 0 }, proof: {} },
    );
    assertEq(ok.length, 0, JSON.stringify(ok));
  });
});

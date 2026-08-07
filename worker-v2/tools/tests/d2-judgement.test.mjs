/**
 * D2 — an optional, unauthenticated judgement could publish green results.
 *
 * Each case below passes trivially on the pre-fix code (`readOptionalJson` handed any
 * parseable JSON to the renderer as the re-derived column) and is the reason the fix
 * exists. The load-bearing assertions are:
 *
 *   - an unsigned legacy bundle is NOT the second column;
 *   - a judgement bound to a DIFFERENT run is NOT this run's results, even though its
 *     obligation ids overlap perfectly;
 *   - a tampered payload, an unknown key, and a fixture key in a production posture are
 *     all refused;
 *   - the absence of a judgement is REPORTED, not silently absorbed;
 *   - only the fully attested, fully bound record is rendered as results.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { putJudgement, seedRun, signedJudgement, testEnv, worker } from "./_helpers.mjs";
import { FIXTURE_REGISTRY_AS_PRODUCTION } from "../fixtures/v2-fixture.mjs";

suite("D2 — the judgement boundary", () => {
  test("a correctly signed, correctly bound JudgementRecord is `attested`", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    await putJudgement(mod, env, seeded.runId, signedJudgement(seeded));

    const load = await mod.judgement.loadJudgement(env, {
      runId: seeded.runId,
      record: seeded.record,
      contractRevisionId: seeded.contractRevisionId,
      contractHash: seeded.contractHash,
      targetBuildId: "build-2026-08-02-a1b2c3",
    });
    assertEq(load.state, "attested", `problems: ${JSON.stringify(load.problems)}`);
    assertEq(load.attestation.state, "verified");
  });

  test("a legacy derived-verdict bundle is UNUSABLE, not the second column", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    // Exactly what the judge writes today, and exactly what used to drive the column.
    await putJudgement(mod, env, seeded.runId, {
      kind: "derived-verdicts",
      engineVersion: "1.0.0",
      results: [{ obligationId: "req_fixture000001", verdict: "pass", coverage: "exercised" }],
    });

    const load = await mod.judgement.loadJudgement(env, {
      runId: seeded.runId,
      record: seeded.record,
      contractRevisionId: seeded.contractRevisionId,
      contractHash: seeded.contractHash,
      targetBuildId: "build-2026-08-02-a1b2c3",
    });
    assertEq(load.state, "unusable");
    assertEq(load.record, null, "an unusable judgement must never expose a record to render");
    assert(
      load.problems.some((p) => p.code === "NO_JUDGEMENT_RECORD"),
      `expected NO_JUDGEMENT_RECORD, got ${JSON.stringify(load.problems.map((p) => p.code))}`,
    );
  });

  test("ANOTHER run's judgement, with overlapping obligation ids, does not bind", async () => {
    const mod = await worker();
    const env = testEnv();
    const a = await seedRun(mod, env);
    const b = await seedRun(mod, env);
    // b's judgement is perfectly signed and perfectly valid — for b.
    await putJudgement(mod, env, a.runId, signedJudgement(b));

    const load = await mod.judgement.loadJudgement(env, {
      runId: a.runId,
      record: a.record,
      contractRevisionId: a.contractRevisionId,
      contractHash: a.contractHash,
      targetBuildId: "build-2026-08-02-a1b2c3",
    });
    assertEq(load.state, "unusable");
    assertEq(load.attestation.state, "verified", "the signature is genuine; it is the BINDING that fails");
    assert(
      load.bindingChecks.some((c) => c.id === "run-id" && !c.ok),
      "the run-id binding must be the check that refuses it",
    );
    assert(
      load.bindingChecks.some((c) => c.id === "run-payload-hash" && !c.ok),
      "the payload-hash binding must also refuse it",
    );
  });

  test("a judgement whose body was edited after signing is refused", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    const doc = signedJudgement(seeded);
    // Flip the failing obligation to a pass, keeping the original signature.
    doc.results[1].verdict = "pass";
    await putJudgement(mod, env, seeded.runId, doc);

    const load = await mod.judgement.loadJudgement(env, {
      runId: seeded.runId,
      record: seeded.record,
      contractRevisionId: seeded.contractRevisionId,
      contractHash: seeded.contractHash,
      targetBuildId: "build-2026-08-02-a1b2c3",
    });
    assertEq(load.state, "unusable");
    assertEq(load.attestation.state, "invalid");
    assert(load.attestation.reason.includes("payloadHash mismatch"), load.attestation.reason);
  });

  test("with no pinned key registry, nothing is trusted (fail-closed, not fail-open)", async () => {
    const mod = await worker();
    const env = testEnv({ JUDGEMENT_KEY_REGISTRY: undefined });
    const seeded = await seedRun(mod, env);
    await putJudgement(mod, env, seeded.runId, signedJudgement(seeded));

    const load = await mod.judgement.loadJudgement(env, {
      runId: seeded.runId,
      record: seeded.record,
      contractRevisionId: seeded.contractRevisionId,
      contractHash: seeded.contractHash,
      targetBuildId: "build-2026-08-02-a1b2c3",
    });
    assertEq(load.state, "unusable");
    assertEq(load.attestation.state, "unavailable");
  });

  test("a FIXTURE key cannot certify results in a production posture", async () => {
    const mod = await worker();
    // trust: "fixture" in the registry + DEV_SEED off == a deployed build.
    const env = testEnv({ DEV_SEED: undefined });
    const seeded = await seedRun(mod, env);
    await putJudgement(mod, env, seeded.runId, signedJudgement(seeded));

    const load = await mod.judgement.loadJudgement(env, {
      runId: seeded.runId,
      record: seeded.record,
      contractRevisionId: seeded.contractRevisionId,
      contractHash: seeded.contractHash,
      targetBuildId: "build-2026-08-02-a1b2c3",
    });
    assertEq(load.state, "unusable");
    assert(load.attestation.reason.includes("local development"), load.attestation.reason);
  });

  test("an unknown signing key is refused even in dev", async () => {
    const mod = await worker();
    const env = testEnv({ JUDGEMENT_KEY_REGISTRY: JSON.stringify({ keys: { "some-other-key": { publicKeyRaw: "AA".repeat(1) } } }) });
    const seeded = await seedRun(mod, env);
    await putJudgement(mod, env, seeded.runId, signedJudgement(seeded));

    const load = await mod.judgement.loadJudgement(env, {
      runId: seeded.runId,
      record: seeded.record,
      contractRevisionId: seeded.contractRevisionId,
      contractHash: seeded.contractHash,
      targetBuildId: "build-2026-08-02-a1b2c3",
    });
    assertEq(load.state, "unusable");
    assert(load.attestation.reason.includes("not in the pinned key registry"), load.attestation.reason);
  });

  test("a run with no target build id can never carry current results", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env, { targetBuildId: null });
    await putJudgement(mod, env, seeded.runId, signedJudgement(seeded));

    const load = await mod.judgement.loadJudgement(env, {
      runId: seeded.runId,
      record: seeded.record,
      contractRevisionId: seeded.contractRevisionId,
      contractHash: seeded.contractHash,
      targetBuildId: null,
    });
    assertEq(load.state, "unusable");
    assert(load.bindingChecks.some((c) => c.id === "target-build" && !c.ok));
  });

  // ---- the report path, end to end -------------------------------------

  test("REPORT: a signed, bound judgement produces the re-derived column and a published report", async () => {
    const mod = await worker();
    const env = testEnv({ JUDGEMENT_KEY_REGISTRY: FIXTURE_REGISTRY_AS_PRODUCTION, DEV_SEED: undefined });
    const seeded = await seedRun(mod, env);
    await putJudgement(mod, env, seeded.runId, signedJudgement(seeded));

    const built = await mod.reportBuild.buildAndStoreReport(env, seeded.runId);
    assert(built.ok, `build failed: ${JSON.stringify(built)}`);
    assertEq(built.summary.judgementState, "attested");
    assertEq(built.summary.derivedVerdicts, true);
    assertEq(built.summary.final, true, "attested judgement + closed test axis is a final report");
  });

  test("REPORT: deleting the judgement does NOT quietly republish the run's own prose verdicts", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    await putJudgement(mod, env, seeded.runId, signedJudgement(seeded));
    await env.EVIDENCE.delete(mod.keys.judgementKey(seeded.runId));

    const built = await mod.reportBuild.buildAndStoreReport(env, seeded.runId);
    assert(built.ok, "the report still builds — absence of a judgement is not a build failure");
    assertEq(built.summary.derivedVerdicts, false);
    assertEq(built.summary.judgementState, "absent");
    assertEq(built.summary.final, false, "a report with no re-derived verdicts is never final");
  });

  test("REPORT: an arbitrary JSON judgement drives nothing and is recorded as a diagnostic", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    await putJudgement(mod, env, seeded.runId, { results: [{ obligationId: "req_fixture000002", verdict: "pass" }] });

    const built = await mod.reportBuild.buildAndStoreReport(env, seeded.runId);
    assert(built.ok);
    assertEq(built.summary.derivedVerdicts, false, "arbitrary JSON must never become the re-derived column");
    assertEq(built.summary.judgementState, "unusable");
    assertEq(built.summary.final, false);

    // The reason is carried into the served report-data as a NON-FINAL diagnostic.
    const pointer = await mod.publish.readReportPointer(env, seeded.runId);
    const data = JSON.parse(await (await env.EVIDENCE.get(pointer.artifacts.data.key)).text());
    assertEq(data.operationalDiagnostics.judgement.state, "unusable");
    assert(
      data.operationalDiagnostics.judgement.problems.length > 0,
      "the diagnostic must say WHY, not merely that something was wrong",
    );
  });
});

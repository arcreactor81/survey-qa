/**
 * D14(b) — ONE DISCRIMINATED PUBLICATION OBJECT.
 *
 * `hasCurrentResults`, `currentColumnId` and `final` used to be three values computed
 * separately, correlated by one guard that compared the judgement state against
 * `hasCurrentResults` and NEVER against `currentColumnId`. Two contradiction shapes walked
 * straight through it:
 *
 *   attested   + current results + NO column      -> "final" over a page naming nothing
 *   unattested + no current results + a column    -> a column published under a state that
 *                                                    forbids one
 *
 * `decidePublication` returns a discriminated value in which neither shape is
 * REPRESENTABLE, and `final` is read off that one value. These tests drive the rule
 * directly, because once the decision is threaded correctly the happy path can no longer
 * reach the contradiction — and an unreachable guard that nothing tests is how the first
 * one rotted.
 *
 * D14 also covers the two binding fields the shared schema left optional. A judgement that
 * does not name its compiler or its ambiguity policy is not reproducible, and one that
 * does not name the revision HASH is bound to an id whose bytes nothing re-checked.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { putJudgement, seedRun, signedJudgement, testEnv, worker } from "./_helpers.mjs";

const ATTESTED = { hasCurrentResults: true, currentColumnId: "re-derived" };
const NOTHING = { hasCurrentResults: false, currentColumnId: null };

suite("D14b — the contradiction shapes are refused", () => {
  test("attested with current results but NO column is refused", async () => {
    const mod = await worker();
    const d = mod.reportBuild.decidePublication("v2r_x", "attested", { hasCurrentResults: true, currentColumnId: null });
    assertEq(d.ok, false, "current results with no column names nothing");
    assertEq(d.reasonCode, "judgement-not-reflected-in-report");
  });

  test("attested naming SOME OTHER column as current is refused", async () => {
    const mod = await worker();
    // The shape the old guard could not see: `hasCurrentResults` is true, so it passed —
    // while the page was publishing the run's own historical prose verdicts as this run's
    // current answer under an attested state.
    const d = mod.reportBuild.decidePublication("v2r_x", "attested", {
      hasCurrentResults: true,
      currentColumnId: "as-run",
    });
    assertEq(d.ok, false, 'only the re-derived column may be current');
    assertEq(d.reasonCode, "current-column-is-not-the-re-derivation");
    assert(/unreviewed verdicts as reviewed/.test(d.detail), d.detail);
  });

  test("an unattested judgement naming a current column is refused even with no results flag", async () => {
    const mod = await worker();
    const d = mod.reportBuild.decidePublication("v2r_x", "unusable", {
      hasCurrentResults: false,
      currentColumnId: "re-derived",
    });
    assertEq(d.ok, false, "a column under an unattested state is a column that may not exist");
    assertEq(d.reasonCode, "unattested-judgement-published-as-current");
  });

  test("the two legal states are legal, and carry the whole decision in one value", async () => {
    const mod = await worker();
    const yes = mod.reportBuild.decidePublication("v2r_x", "attested", ATTESTED);
    assertEq(yes.ok, true);
    assertEq(yes.publication.kind, "attested-current");
    assertEq(yes.publication.currentColumnId, "re-derived");
    assertEq(yes.publication.hasCurrentResults, true);

    for (const state of ["absent", "unusable"]) {
      const no = mod.reportBuild.decidePublication("v2r_x", state, NOTHING);
      assertEq(no.ok, true, state);
      assertEq(no.publication.kind, "no-current-results");
      assertEq(no.publication.currentColumnId, null);
      assertEq(no.publication.hasCurrentResults, false);
    }
  });

  test("reportClaimsAgree is a projection of the same decision, not a second rule", async () => {
    const mod = await worker();
    assertEq(mod.reportBuild.reportClaimsAgree("v2r_x", "attested", ATTESTED).ok, true);
    assertEq(mod.reportBuild.reportClaimsAgree("v2r_x", "absent", NOTHING).ok, true);
    assertEq(
      mod.reportBuild.reportClaimsAgree("v2r_x", "attested", { hasCurrentResults: true, currentColumnId: "as-run" })
        .reasonCode,
      "current-column-is-not-the-re-derivation",
    );
  });
});

suite("D14 — compiler, ambiguity-policy and revision-hash bindings are MANDATORY", () => {
  test("a judgement with no compilerVersion cannot be current results", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    await putJudgement(
      mod,
      env,
      seeded.runId,
      signedJudgement({
        runId: seeded.runId,
        record: seeded.record,
        contractRevisionId: seeded.contractRevisionId,
        contractHash: seeded.contractHash,
        bindingOverrides: { compilerVersion: "" },
      }),
    );
    const load = await mod.judgement.loadJudgement(env, {
      runId: seeded.runId,
      record: seeded.record,
      contractRevisionId: seeded.contractRevisionId,
      contractHash: seeded.contractHash,
      targetBuildId: seeded.record.run.targetBuildId,
    });
    assertEq(load.state, "unusable", "an unreproducible judgement is not a current result");
    assert(
      load.bindingChecks.some((c) => c.id === "compiler-version" && !c.ok),
      `the compiler binding must be named: ${JSON.stringify(load.bindingChecks.map((c) => [c.id, c.ok]))}`,
    );
  });

  test("a judgement with no ambiguityPolicyVersion cannot be current results", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    await putJudgement(
      mod,
      env,
      seeded.runId,
      signedJudgement({
        runId: seeded.runId,
        record: seeded.record,
        contractRevisionId: seeded.contractRevisionId,
        contractHash: seeded.contractHash,
        bindingOverrides: { ambiguityPolicyVersion: "" },
      }),
    );
    const load = await mod.judgement.loadJudgement(env, {
      runId: seeded.runId,
      record: seeded.record,
      contractRevisionId: seeded.contractRevisionId,
      contractHash: seeded.contractHash,
      targetBuildId: seeded.record.run.targetBuildId,
    });
    assertEq(load.state, "unusable");
    assert(load.bindingChecks.some((c) => c.id === "ambiguity-policy-version" && !c.ok));
  });

  test("a judgement naming the right revision id with the WRONG revision hash is refused", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    await putJudgement(
      mod,
      env,
      seeded.runId,
      signedJudgement({
        runId: seeded.runId,
        record: seeded.record,
        contractRevisionId: seeded.contractRevisionId,
        contractHash: seeded.contractHash,
        bindingOverrides: { contractRevisionHash: `sha256:${"0".repeat(64)}` },
      }),
    );
    const load = await mod.judgement.loadJudgement(env, {
      runId: seeded.runId,
      record: seeded.record,
      contractRevisionId: seeded.contractRevisionId,
      contractHash: seeded.contractHash,
      targetBuildId: seeded.record.run.targetBuildId,
    });
    assertEq(load.state, "unusable", "a revision id names BYTES; the judgement must name the same ones");
    assert(load.bindingChecks.some((c) => c.id === "contract-revision-hash" && !c.ok));
  });
});

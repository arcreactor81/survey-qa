/**
 * D28 — A RESULT COULD NEVER BE FINAL, BECAUSE NOTHING NAMED THE THING THAT WAS TESTED.
 *
 * `DEFAULT_TARGET_BUILD_ID` is unset on the deployed service, so `report/build.ts` resolved
 * `targetBuildId: null`, every judgement failed its `target-build` binding check, and EVERY
 * report this deployment produces was marked diagnostic-only. No rerun could differ: the
 * missing thing was configuration, not luck. And no static tag could be invented in code —
 * a survey URL is not a build id, and `CLAUDE.md` forbids per-survey configuration.
 *
 * The identity is now DERIVED from the site as this run actually observed it: a sha-256
 * over the sorted, distinct content hashes of the run's captured screens, which are already
 * in the content-addressed evidence catalogue. Every test below fails on the code as it was.
 *
 * THE LOAD-BEARING ONES, in order of how much they would cost to get wrong:
 *
 *   - EMPTY CAPTURE STAYS UNBINDABLE. A run that saw nothing has nothing to bind to. If the
 *     derivation hashed the empty set it would mint a well-formed identity for "we saw
 *     nothing", every such run would share it, and a run that never reached the survey
 *     could be certified. That is the failure this whole feature could quietly introduce.
 *   - THE DERIVED ID ACTUALLY BINDS. Computing a string proves nothing; the statement of
 *     the feature is that a judgement bound to the derived id becomes CURRENT RESULTS and
 *     the report goes final. This is the only test that fails if the resolver is ever
 *     disconnected from the facts handed to `loadJudgement`.
 *   - THE OVERRIDE STILL WINS. `DEFAULT_TARGET_BUILD_ID` must remain an owner-controlled
 *     override, not dead configuration.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { putJudgement, seedRun, signedJudgement, testEnv, worker } from "./_helpers.mjs";
import { FIXTURE_REGISTRY_AS_PRODUCTION, runRecordV2 } from "../fixtures/v2-fixture.mjs";

const enc = new TextEncoder();
const PREFIX = "site-sha256:";

/** Put one capture into a run's catalogue. `type` is what decides whether it participates. */
const capture = (mod, env, runId, { text, type, id, ref, mediaType = "application/json" }) =>
  mod.evidence.putEvidence(env, {
    runId,
    bytes: enc.encode(text),
    mediaType,
    type,
    sourceEvidenceId: id,
    artifactRef: ref,
    witnesses: [],
  });

/**
 * A seeded run that carries NO recorded target identity anywhere — neither on the envelope
 * nor in the RunRecord — plus whatever captures the test wants. The fixture record hardcodes
 * a build id, so it is rewritten here; otherwise every test would resolve the recorded value
 * and never reach the derivation at all.
 */
async function seedRunWithCaptures(mod, env, captures) {
  const seeded = await seedRun(mod, env, { targetBuildId: null });
  const extra = [];
  for (const c of captures) extra.push(await capture(mod, env, seeded.runId, c));

  const evidence = [...seeded.evidence, ...extra];
  const record = runRecordV2({
    runId: seeded.runId,
    contractRevisionId: seeded.contractRevisionId,
    contractHash: seeded.contractHash,
    evidence,
  });
  record.run.targetBuildId = null;
  await env.EVIDENCE.put(mod.keys.recordKey(seeded.runId), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });
  return { ...seeded, record, evidence };
}

const readReportData = async (mod, env, runId) => {
  const pointer = await mod.publish.readReportPointer(env, runId);
  return JSON.parse(await (await env.EVIDENCE.get(pointer.artifacts.data.key)).text());
};

const SCREEN_A = { text: '{"screen":"Q1","visibleText":"How often do you water them?"}', type: "dom-excerpt", id: "EV-S1", ref: "observations/p1/p1-step-001-before.json" };
const SCREEN_B = { text: '{"screen":"Q2","visibleText":"Which plants do you own?"}', type: "dom-excerpt", id: "EV-S2", ref: "observations/p1/p1-step-002-before.json" };
const SHOT_A = { text: "PNG-BYTES-A", type: "screenshot", id: "EV-S1-png", ref: "observations/p1/p1-step-001-before.png", mediaType: "image/png" };

suite("D28 — the target identity a judgement binds to", () => {
  // ---- the derivation, as a function ------------------------------------

  test("two runs that captured IDENTICAL screens derive the SAME id", async () => {
    const mod = await worker();
    const env = testEnv();
    const a = await seedRunWithCaptures(mod, env, [SCREEN_A, SCREEN_B, SHOT_A]);
    // The second run captures the same content in the opposite order. Different run, so
    // different evidence ids — the id must come from the CONTENT and nothing else.
    const b = await seedRunWithCaptures(mod, env, [SHOT_A, SCREEN_B, SCREEN_A]);

    const idA = await mod.reportBuild.deriveObservedSiteBuildId(await mod.evidence.listCatalog(env, a.runId));
    const idB = await mod.reportBuild.deriveObservedSiteBuildId(await mod.evidence.listCatalog(env, b.runId));

    assert(typeof idA === "string" && idA.startsWith(PREFIX), `expected a ${PREFIX} id, got ${JSON.stringify(idA)}`);
    assertEq(idB, idA, "identical observed content must produce an identical id");
    assert(
      a.evidence.every((e) => !idA.includes(e.evidenceId)),
      "the id must not carry a run-scoped evidence id — that would make it a per-run nonce",
    );
  });

  test("a single changed byte on ONE screen derives a DIFFERENT id", async () => {
    const mod = await worker();
    const env = testEnv();
    const a = await seedRunWithCaptures(mod, env, [SCREEN_A, SCREEN_B]);
    const b = await seedRunWithCaptures(mod, env, [SCREEN_A, { ...SCREEN_B, text: SCREEN_B.text.replace("own?", "own!") }]);

    const idA = await mod.reportBuild.deriveObservedSiteBuildId(await mod.evidence.listCatalog(env, a.runId));
    const idB = await mod.reportBuild.deriveObservedSiteBuildId(await mod.evidence.listCatalog(env, b.runId));
    assert(idA && idB, "both runs captured screens, so both must derive an id");
    assert(idA !== idB, "a different build served at the same URL must not share an id with the one it replaced");
  });

  test("capturing the SAME screen on several walks does not change the id (stated rule 2)", async () => {
    const mod = await worker();
    const env = testEnv();
    const once = await seedRunWithCaptures(mod, env, [SCREEN_A, SCREEN_B]);
    // The same two screens, re-captured under three more citations — which is what a
    // multi-path plan does. Multiplicity is a fact about the PLAN, not about the site.
    const many = await seedRunWithCaptures(mod, env, [
      SCREEN_A,
      SCREEN_B,
      { ...SCREEN_A, id: "EV-S1-again", ref: "observations/p2/p2-step-001-before.json" },
      { ...SCREEN_B, id: "EV-S2-again", ref: "observations/p2/p2-step-002-before.json" },
      { ...SCREEN_A, id: "EV-S1-third", ref: "observations/p3/p3-step-001-before.json" },
    ]);

    const idOnce = await mod.reportBuild.deriveObservedSiteBuildId(await mod.evidence.listCatalog(env, once.runId));
    const idMany = await mod.reportBuild.deriveObservedSiteBuildId(await mod.evidence.listCatalog(env, many.runId));
    assertEq(idMany, idOnce);
  });

  test("EMPTY CAPTURE derives NOTHING — never the hash of an empty set", async () => {
    const mod = await worker();
    assertEq(await mod.reportBuild.deriveObservedSiteBuildId([]), null, "an empty catalogue has nothing to identify");
    const resolved = await mod.reportBuild.resolveTargetIdentity({ recorded: null, override: null, catalog: [] });
    assertEq(resolved.targetBuildId, null);
    assertEq(resolved.source, "none");
    assert(
      !JSON.stringify(resolved).includes(PREFIX),
      "a run that observed nothing must not be handed a well-formed identity for having observed nothing",
    );
  });

  test("the run's OWN bookkeeping is not a screen: traces and path observations derive nothing", async () => {
    const mod = await worker();
    const env = testEnv();
    // Every type the store knows EXCEPT the two that are a direct reading of the site.
    const run = await seedRunWithCaptures(mod, env, [
      { text: '{"loadFailure":"boom"}', type: "trace", id: "EV-T1", ref: "observations/p1/p1-failure.json" },
      { text: '{"kind":"v2-path-observation/1.0.0"}', type: "state", id: "EV-O1", ref: "observations/p1/p1-observation.json" },
      { text: '{"log":[]}', type: "har", id: "EV-H1", ref: "observations/p1/p1-net.har" },
      { text: "notes", type: "other", id: "EV-X1", ref: "observations/p1/p1-notes.txt", mediaType: "text/plain" },
    ]);
    const id = await mod.reportBuild.deriveObservedSiteBuildId(await mod.evidence.listCatalog(env, run.runId));
    assertEq(id, null, "hashing run bookkeeping would mint a fresh id every run and identify nothing");
  });

  // ---- the precedence, written down in one place ------------------------

  test("PRECEDENCE: recorded, else the configured override, else derived, else unbindable", async () => {
    const mod = await worker();
    const catalog = [{ type: "dom-excerpt", contentHash: "b".repeat(64) }];

    const recorded = await mod.reportBuild.resolveTargetIdentity({
      recorded: "release-4.2.1",
      override: "env-tag",
      catalog,
    });
    assertEq(recorded.targetBuildId, "release-4.2.1", "a run's own recorded identity must not change under it");
    assertEq(recorded.source, "recorded");

    const override = await mod.reportBuild.resolveTargetIdentity({ recorded: null, override: "env-tag", catalog });
    assertEq(override.targetBuildId, "env-tag", "an owner-controlled tag beats a derived one");
    assertEq(override.source, "override");

    const derived = await mod.reportBuild.resolveTargetIdentity({ recorded: null, override: undefined, catalog });
    assert(derived.targetBuildId?.startsWith(PREFIX), `expected a derived id, got ${JSON.stringify(derived.targetBuildId)}`);
    assertEq(derived.source, "derived");

    const none = await mod.reportBuild.resolveTargetIdentity({ recorded: "   ", override: "", catalog: [] });
    assertEq(none.targetBuildId, null, "blank configuration is not configuration");
    assertEq(none.source, "none");
  });

  // ---- through the report path -----------------------------------------

  test("REPORT: an empty capture stays unbindable, with the reason the binding already names", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRunWithCaptures(mod, env, []);
    await putJudgement(mod, env, seeded.runId, signedJudgement(seeded));

    const built = await mod.reportBuild.buildAndStoreReport(env, seeded.runId);
    assert(built.ok, `build failed: ${JSON.stringify(built)}`);
    assertEq(built.summary.judgementState, "unusable");
    assertEq(built.summary.hasCurrentResults, false);
    assertEq(built.summary.final, false);

    const data = await readReportData(mod, env, seeded.runId);
    assertEq(data.operationalDiagnostics.targetIdentity.targetBuildId, null);
    assertEq(data.operationalDiagnostics.targetIdentity.source, "none");
    assert(
      !JSON.stringify(data.operationalDiagnostics.targetIdentity).includes(PREFIX),
      "a run that captured nothing must never be published with a derived identity",
    );
    const check = data.operationalDiagnostics.judgement.bindingChecks.find((c) => c.id === "target-build");
    assert(check && !check.ok, "the target-build binding check must still fail");
    assert(
      String(check.detail).includes("recorded no target build id"),
      `the existing named reason must survive: ${JSON.stringify(check.detail)}`,
    );
  });

  test("REPORT: an explicit DEFAULT_TARGET_BUILD_ID overrides the derived id", async () => {
    const mod = await worker();
    const env = testEnv({ DEFAULT_TARGET_BUILD_ID: "release-2026-08-08" });
    const seeded = await seedRunWithCaptures(mod, env, [SCREEN_A, SCREEN_B]);
    await putJudgement(mod, env, seeded.runId, signedJudgement({ ...seeded, targetBuildId: "release-2026-08-08" }));

    const built = await mod.reportBuild.buildAndStoreReport(env, seeded.runId);
    assert(built.ok, `build failed: ${JSON.stringify(built)}`);
    assertEq(built.summary.judgementState, "attested", "the owner's tag is what the judgement binds to");

    const data = await readReportData(mod, env, seeded.runId);
    assertEq(data.operationalDiagnostics.targetIdentity.targetBuildId, "release-2026-08-08");
    assertEq(data.operationalDiagnostics.targetIdentity.source, "override");
  });

  test("REPORT: the DERIVED id binds — a run with captures can be a final result", async () => {
    const mod = await worker();
    // The production posture: fixture keys are not honoured, so nothing here is trusted by
    // accident of the dev seed.
    const env = testEnv({ JUDGEMENT_KEY_REGISTRY: FIXTURE_REGISTRY_AS_PRODUCTION, DEV_SEED: undefined });
    const seeded = await seedRunWithCaptures(mod, env, [SCREEN_A, SCREEN_B, SHOT_A]);

    const derived = await mod.reportBuild.deriveObservedSiteBuildId(await mod.evidence.listCatalog(env, seeded.runId));
    assert(derived?.startsWith(PREFIX), `expected a derived id, got ${JSON.stringify(derived)}`);
    await putJudgement(mod, env, seeded.runId, signedJudgement({ ...seeded, targetBuildId: derived }));

    const built = await mod.reportBuild.buildAndStoreReport(env, seeded.runId);
    assert(built.ok, `build failed: ${JSON.stringify(built)}`);
    assertEq(built.summary.judgementState, "attested", "the derived identity must be what the binding resolves");
    assertEq(built.summary.derivedVerdicts, true);
    assertEq(built.summary.hasCurrentResults, true);
    assertEq(built.summary.currentColumnId, "re-derived");
    assertEq(built.summary.final, true, "THE POINT: a run that observed the site can now be recorded as settled");

    const data = await readReportData(mod, env, seeded.runId);
    assertEq(data.operationalDiagnostics.targetIdentity.source, "derived");
    assertEq(data.operationalDiagnostics.targetIdentity.targetBuildId, derived);
    assert(
      /observed content|actually captured/i.test(data.operationalDiagnostics.targetIdentity.note),
      "the diagnostic must say the id names OBSERVED CONTENT, not a vendor's release",
    );
  });

  test("REPORT: a judgement bound to a DIFFERENT observation of the same survey does not bind", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRunWithCaptures(mod, env, [SCREEN_A, SCREEN_B]);
    // The id a run over a CHANGED build would have derived. Everything else about the
    // judgement is correct for this run.
    const other = await mod.reportBuild.deriveObservedSiteBuildId([
      { type: "dom-excerpt", contentHash: "c".repeat(64) },
    ]);
    await putJudgement(mod, env, seeded.runId, signedJudgement({ ...seeded, targetBuildId: other }));

    const built = await mod.reportBuild.buildAndStoreReport(env, seeded.runId);
    assert(built.ok);
    assertEq(built.summary.judgementState, "unusable", "a judgement of another build is never this run's result");
    assertEq(built.summary.final, false);
  });
});

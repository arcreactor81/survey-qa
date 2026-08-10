/**
 * D40 — TWO WAYS A RUN'S OWN RECORD LIED ABOUT ITSELF.
 *
 * PART A — THE SWEEPER WAS DANGEROUS. A forensic review of 8 Aug found it had erased a run's
 * forensic record by restarting it, re-spent money on a run already known to be dead,
 * RESURRECTED A RUN AN OPERATOR HAD DELIBERATELY TERMINATED (terminated and errored shared one
 * branch), and burst all of it at once when cron came back after 140 silent minutes — because
 * the two-strike protocol had a MINIMUM observation separation and no MAXIMUM staleness.
 *
 * PART B — NO SIGNED RECORD COULD SAY WHAT WAS TESTED. `assemble-record.mjs` stamps
 * `run.targetBuildId` from `envelope.input.targetBuildId`, that field was null on every run,
 * and the null propagated into the judge's binding. So run 4 (5 pass / 0 fail) and run 5
 * (2 pass / 2 fail) on the SAME document and the SAME survey could not be told apart, and
 * "was that the deploys or nondeterminism?" was answerable only out-of-band via wrangler.
 *
 * EVERY TEST HERE FAILS ON THE CODE AS IT WAS, and the load-bearing ones are proved by
 * mutation in `tools/mutate-sweeper-identity.mjs` rather than asserted to be good.
 *
 * ONE TEST IN PART C IS A CHARACTERIZATION TEST, NOT A GUARD: it PROVES the cross-run
 * instability of the derived id rather than papering over it. Read its comment before
 * "fixing" it.
 */

import { assert, assertEq, fakeStep, suite, test } from "../testkit.mjs";
import { seedRun, testEnv, worker } from "./_helpers.mjs";

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const PREFIX = "site-sha256:";

/**
 * A Workflow binding double that RECORDS EVERY METHOD TOUCHED.
 *
 * The point of this suite's part A is a NEGATIVE: that two specific engine calls do not
 * happen. A double that merely returns a status cannot witness that — it would be equally
 * silent whether the sweeper called `create()` or not — so every method is logged, including
 * the ones on the instance handle, and the assertions read the log.
 */
function recordingWorkflow(status, error = null) {
  const calls = [];
  return {
    calls,
    binding: {
      async get(id) {
        calls.push(`get:${id}`);
        if (status === "not_found") throw new Error("(instance.not_found) Instance not found");
        return {
          async status() {
            calls.push(`status:${id}`);
            return { status, error };
          },
          async restart() {
            calls.push(`restart:${id}`);
          },
          async terminate() {
            calls.push(`terminate:${id}`);
          },
        };
      },
      async create({ id }) {
        calls.push(`create:${id}`);
        return { id };
      },
    },
  };
}

/** A run old enough to be swept, still non-terminal, with its active marker in place. */
async function seedSweepable(mod, env, { ageMs = 6 * 60 * 60 * 1000, recovery = null, lastProgressMs = ageMs } = {}) {
  const seeded = await seedRun(mod, env, { testCompletion: "running" });
  await mod.envelope.markActive(env, seeded.runId);
  await env.EVIDENCE.put(
    mod.keys.envelopeKey(seeded.runId),
    JSON.stringify({ ...(await mod.envelope.getEnvelope(env, seeded.runId)), createdAt: ago(ageMs), recovery }),
  );
  await env.EVIDENCE.put(
    mod.keys.checkpointKey(seeded.runId),
    JSON.stringify({
      ...(await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint,
      lastProgressAt: ago(lastProgressMs),
    }),
  );
  return seeded.runId;
}

/** Pretend the previous cron tick happened `ms` ago. `null` writes no tick at all. */
async function seedTick(mod, env, ms) {
  if (ms === null) return;
  await env.EVIDENCE.put(mod.keys.sweeperTickKey(), JSON.stringify({ at: ago(ms) }));
}

const checkpointOf = async (mod, env, runId) => (await mod.checkpoint.loadCheckpoint(env, runId)).checkpoint;

suite("D40a — the sweeper observes and records; it does not resurrect", () => {
  test("REPORT-ONLY: a dead run is SETTLED, and no instance is restarted or re-created", async () => {
    const mod = await worker();
    const wf = recordingWorkflow("errored", { name: "Error", message: "boom" });
    const env = testEnv({ V2_RUN_WORKFLOW: wf.binding });
    await seedTick(mod, env, 60_000);
    const runId = await seedSweepable(mod, env);

    const verdict = await mod.sweeper.sweepRun(env, runId, new Date());

    // IT STILL RECORDS. The owner's requirement is that a run which died silently is still
    // visible and still marked failed — report-only is not the same as doing nothing.
    assert(verdict.startsWith("failed:workflow-errored"), `expected an honest settlement, got ${verdict}`);
    const cp = await checkpointOf(mod, env, runId);
    assertEq(cp.completion.test, "failed");
    assertEq(cp.completion.reasonCode, "workflow-errored");
    assertEq(await env.EVIDENCE.head(mod.keys.activeMarkerKey(runId)), null, "and it stops being swept");
    assert(/recovery was NOT attempted/i.test(String(cp.error)), `the reader must be told: ${cp.error}`);

    // AND IT SPENDS NOTHING. This is the whole point: `restart()` re-runs a pipeline whose
    // evidence is already written, and `create()` spends money on a target nobody re-examined.
    assert(
      !wf.calls.some((c) => c.startsWith("restart:")),
      `the sweeper must not restart an instance: ${wf.calls.join(", ")}`,
    );
    assert(
      !wf.calls.some((c) => c.startsWith("create:")),
      `the sweeper must not create an instance: ${wf.calls.join(", ")}`,
    );
    assertEq(cp.recovery.attempt, 0, "and it must not claim an attempt it never made");
  });

  test("AN OPERATOR'S KILL IS A DECISION, NOT A FAULT — and it is recorded as its own thing", async () => {
    const mod = await worker();
    const killed = recordingWorkflow("terminated");
    const env = testEnv({ V2_RUN_WORKFLOW: killed.binding });
    await seedTick(mod, env, 60_000);
    const runId = await seedSweepable(mod, env);

    const verdict = await mod.sweeper.sweepRun(env, runId, new Date());
    assert(verdict.startsWith("failed:operator-terminated"), `expected the operator's decision, got ${verdict}`);

    const cp = await checkpointOf(mod, env, runId);
    assertEq(cp.completion.reasonCode, "operator-terminated");
    assert(/operator terminated/i.test(String(cp.error)), `the reason must say so in words: ${cp.error}`);
    assert(
      !killed.calls.some((c) => c.startsWith("restart:") || c.startsWith("create:")),
      `a deliberate kill must never be recovered: ${killed.calls.join(", ")}`,
    );

    // THE DISCRIMINATION, MEASURED. It is not enough that a terminated run gets *a* code —
    // it must get a DIFFERENT one from a crash, or the two are still one branch wearing two
    // names. An errored run of the identical shape is swept here and the codes compared.
    const crashed = recordingWorkflow("errored", { name: "Error", message: "boom" });
    const env2 = testEnv({ V2_RUN_WORKFLOW: crashed.binding });
    await seedTick(mod, env2, 60_000);
    const runId2 = await seedSweepable(mod, env2);
    await mod.sweeper.sweepRun(env2, runId2, new Date());
    const cp2 = await checkpointOf(mod, env2, runId2);
    assert(
      cp2.completion.reasonCode !== cp.completion.reasonCode,
      `an operator's decision and a crash must not share a reason code (both "${cp.completion.reasonCode}")`,
    );
  });

  test("A PAUSE IS OPERATOR TERRITORY TOO — untouched, unfenced, and never failed", async () => {
    // A paused instance is indistinguishable from a hung one from the sweeper's seat: it does
    // not beat and it commits no progress. Without an explicit branch it therefore collects
    // two strikes, gets FENCED OUT, and is written down as failed — a deliberate pause
    // relabelled as a fault, which is the same defect as treating a termination as a crash.
    const mod = await worker();
    const wf = recordingWorkflow("paused");
    const env = testEnv({ V2_RUN_WORKFLOW: wf.binding });
    await seedTick(mod, env, 60_000);
    // Deliberately well past every threshold: silent for four hours, no progress for four
    // hours, and already carrying a matching first strike from six minutes ago. Every other
    // branch in this sweeper would act on that.
    const runId = await seedSweepable(mod, env, { lastProgressMs: 4 * 60 * 60 * 1000 });
    const before = await checkpointOf(mod, env, runId);
    await mod.envelope.updateEnvelope(env, runId, (e) => {
      e.recovery = { stallValue: `none|${before.revision}`, stallSeenAt: ago(6 * 60 * 1000) };
    });

    assertEq(await mod.sweeper.sweepRun(env, runId, new Date()), "paused-operator-territory");

    const after = await checkpointOf(mod, env, runId);
    assertEq(after.completion.test, "running", "a paused run is not a failed run");
    assertEq(after.ownership, before.ownership, "and the operator's instance must not be fenced out");
    assert(await env.EVIDENCE.head(mod.keys.activeMarkerKey(runId)), "it stays visible and keeps being swept");
    assert(
      !wf.calls.some((c) => c.startsWith("restart:") || c.startsWith("create:") || c.startsWith("terminate:")),
      `nothing may be done to a paused instance: ${wf.calls.join(", ")}`,
    );
  });

  test("A TERMINATION IS RECORDED WHILE THE ENGINE WILL STILL SAY IT — even on an observe-only tick", async () => {
    // Workflow instances are retained for a bounded time. An unrecorded termination becomes
    // `instance.not_found` later, and the NOT_FOUND path would then relabel the operator's
    // deliberate kill as a fault of unknown cause. So this one case settles regardless of the
    // tick's posture: nothing is being DECIDED, only written down.
    const mod = await worker();
    const killed = recordingWorkflow("terminated");
    const env = testEnv({ V2_RUN_WORKFLOW: killed.binding });
    await seedTick(mod, env, 140 * 60 * 1000); // the outage
    const runId = await seedSweepable(mod, env);

    const out = await mod.sweeper.sweep(env, new Date());
    assertEq(out.tick.maySettle, false, "the tick must know it follows an outage");
    assert(
      String(out.results[runId]).startsWith("failed:operator-terminated"),
      `the decision must still be written down: ${out.results[runId]}`,
    );
  });
});

suite("D40b — a cron gap is a hazard, and it is bounded", () => {
  test("THE BURST: the first tick after a cron outage settles NOTHING", async () => {
    const mod = await worker();
    const wf = recordingWorkflow("errored", { name: "Error", message: "boom" });
    const env = testEnv({ V2_RUN_WORKFLOW: wf.binding });
    await seedTick(mod, env, 140 * 60 * 1000); // 28 missed ticks, as happened
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await seedSweepable(mod, env));

    const out = await mod.sweeper.sweep(env, new Date());

    assertEq(out.tick.maySettle, false);
    assert(/cron gap of 140 minute/.test(out.tick.note), `the gap must be reported: ${out.tick.note}`);
    for (const id of ids) {
      assert(
        String(out.results[id]).startsWith("observed-not-settled"),
        `run ${id} must be observed, not settled: ${out.results[id]}`,
      );
      const cp = await checkpointOf(mod, env, id);
      assertEq(cp.completion.test, "running", "and its durable state must be untouched");
      assert(await env.EVIDENCE.head(mod.keys.activeMarkerKey(id)), "and it must still be swept next tick");
    }
  });

  test("THE BUDGET: even a healthy tick settles a bounded number of runs", async () => {
    const mod = await worker();
    const wf = recordingWorkflow("errored", { name: "Error", message: "boom" });
    const env = testEnv({ V2_RUN_WORKFLOW: wf.binding });
    await seedTick(mod, env, 60_000); // cron healthy
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await seedSweepable(mod, env));

    const out = await mod.sweeper.sweep(env, new Date());
    assertEq(out.tick.maySettle, true, "this tick is healthy, so the bound under test is the BUDGET");

    const settled = ids.filter((id) => String(out.results[id]).startsWith("failed:"));
    const deferred = ids.filter((id) => String(out.results[id]).startsWith("observed-not-settled"));
    assert(settled.length > 0, "a healthy tick must still settle SOMETHING, or the bound is just an off switch");
    assert(settled.length <= 3, `at most the per-tick budget may be settled, got ${settled.length}`);
    assertEq(settled.length + deferred.length, ids.length, "and every run is accounted for either way");
    assert(
      deferred.some((id) => /budget/.test(String(out.results[id]))),
      "a deferred run must say WHY it was deferred",
    );
  });

  test("STALE EVIDENCE IS RE-TAKEN, NOT COUNTED: an observation from before the outage is not a strike", async () => {
    const mod = await worker();
    // The engine still says `running`: this is the stall path, which is the one the two-strike
    // protocol guards and the one that burst.
    const wf = recordingWorkflow("running");
    const env = testEnv({ V2_RUN_WORKFLOW: wf.binding });
    await seedTick(mod, env, 60_000);
    const runId = await seedSweepable(mod, env, { lastProgressMs: 4 * 60 * 60 * 1000 });
    await mod.checkpoint.beat(env, runId, "still alive", "fp-1");

    // The first strike, taken two hours ago — before the outage. Its fingerprint MATCHES what
    // this sweep will compute, so under the old rule ("same value, and >= 4 minutes apart")
    // this run was instantly actionable the moment cron resumed.
    const cp = await checkpointOf(mod, env, runId);
    const fingerprint = `fp-1|${cp.revision}`;
    await mod.envelope.updateEnvelope(env, runId, (e) => {
      e.recovery = { stallValue: fingerprint, stallSeenAt: ago(2 * 60 * 60 * 1000) };
    });

    const verdict = await mod.sweeper.sweepRun(env, runId, new Date());
    assertEq(verdict, "stall-strike-1-evidence-expired", "a two-hour-old observation is not a second look");
    assertEq((await checkpointOf(mod, env, runId)).completion.test, "running", "and nothing was settled on it");

    // The counterweight, so this is not just "never act": a FRESH pair of observations still
    // reaches a settlement. Without this the test above would pass on a sweeper that had been
    // turned off entirely.
    await mod.envelope.updateEnvelope(env, runId, (e) => {
      e.recovery = { stallValue: fingerprint, stallSeenAt: ago(6 * 60 * 1000) };
    });
    const acted = await mod.sweeper.sweepRun(env, runId, new Date());
    assert(acted.startsWith("failed:instance-stalled"), `a fresh, cron-separated pair must still act: ${acted}`);

    // AND THE VERDICT IS FENCED. A stalled run is one the ENGINE still reports as running, so
    // everything above is indirect evidence. Without taking the ownership epoch first, an
    // original that was merely slow would keep writing checkpoints straight over the failure
    // just recorded — a verdict a live instance can silently undo is worse than no verdict,
    // because a reader believes it.
    const settledCp = await checkpointOf(mod, env, runId);
    assertEq(settledCp.ownership.instanceId, "sweeper:report-only", "the superseded original must be fenced out");
    assert(settledCp.ownership.epoch > 0, "and the epoch must have advanced past whatever held it");
  });
});

suite("D40c — the run records WHAT IT TESTED, before any verdict depends on it", () => {
  /** Two captured screens, so the run has something to derive an identity from. */
  const withScreens = async (mod, env, runId, texts) => {
    const enc = new TextEncoder();
    for (const [i, text] of texts.entries()) {
      await mod.evidence.putEvidence(env, {
        runId,
        bytes: enc.encode(text),
        mediaType: "application/json",
        type: "dom-excerpt",
        sourceEvidenceId: `EV-S${i}`,
        artifactRef: `observations/p1/p1-step-00${i}-before.json`,
        witnesses: [],
      });
    }
  };

  test("THE DERIVED IDENTITY IS RECORDED ON THE ENVELOPE, which is what the record stamps from", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env, { targetBuildId: null });
    await withScreens(mod, env, seeded.runId, ['{"screen":"Q1"}', '{"screen":"Q2"}']);

    const out = await mod.targetBuild.ensureRecordedTargetIdentity(env, seeded.runId);
    assertEq(out.outcome, "recorded");
    assert(out.targetBuildId?.startsWith(PREFIX), `expected a derived id, got ${JSON.stringify(out.targetBuildId)}`);

    // THE ASSERTION THAT MATTERS. `assemble-record.mjs` reads exactly this field and nothing
    // else, so a function that computed the right string and did not persist it here would
    // leave every signed record as silent as before.
    const envelope = await mod.envelope.getEnvelope(env, seeded.runId);
    assertEq(envelope.input.targetBuildId, out.targetBuildId, "the identity must be ON THE ENVELOPE");

    // And it is the same string the derivation yields from this run's catalogue — not a
    // second, parallel spelling of "an id".
    const expected = await mod.reportBuild.deriveObservedSiteBuildId(
      await mod.evidence.listCatalog(env, seeded.runId),
    );
    assertEq(envelope.input.targetBuildId, expected);
  });

  test("THE SEAM: the assembled record's targetBuildId is the recorded id, not null and not a second answer", async () => {
    // THE FIELD THE JUDGE ACTUALLY READS. `shared/v2-record.mjs` projects
    // `run.targetBuildId` to `run.target.buildId`, `pipeline/judge/lib/authority.mjs` reads
    // that into `authority.targetBuildId`, and `judgement-record.mjs` puts it in
    // `binding.targetBuildId` — which `store/judgement.ts` then compares against what the
    // report resolved. Every link carried null while the envelope did, so a report that
    // derived an id was comparing it against the judgement's null and demoting the result for
    // what looked like a mismatch.
    //
    // The assembler also carries a separately-resolved `run.targetIdentity` block. Two
    // spellings of one question is how a record comes to disagree with itself, so this asserts
    // they are the SAME string — which they are precisely because the envelope is populated and
    // both take the "recorded" branch.
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env, { targetBuildId: null });
    await withScreens(mod, env, seeded.runId, ['{"screen":"Q1"}', '{"screen":"Q2"}']);

    const recorded = await mod.targetBuild.ensureRecordedTargetIdentity(env, seeded.runId);
    assert(recorded.targetBuildId?.startsWith(PREFIX), "the run must first record what it tested");

    const assembled = await mod.assembleRecord.assembleRecord(env, seeded.runId, []);
    assertEq(assembled.state, "evaluated", `the record must assemble: ${JSON.stringify(assembled)}`);
    const record = JSON.parse(await (await env.EVIDENCE.get(mod.keys.recordKey(seeded.runId))).text());

    assertEq(record.run.targetBuildId, recorded.targetBuildId, "THE SIGNED RECORD MUST SAY WHAT IT TESTED");
    assertEq(
      record.run.targetIdentity?.targetBuildId ?? record.run.targetBuildId,
      recorded.targetBuildId,
      "and the record must not carry two different answers to one question",
    );
    assertEq(record.run.targetIdentity?.source ?? "recorded", "recorded", "resolved from the run's own record");
  });

  test("FIRST WRITE WINS: an owner's tag is never replaced by a derived one", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env, { targetBuildId: "release-4.2.1" });
    await withScreens(mod, env, seeded.runId, ['{"screen":"Q1"}']);

    const out = await mod.targetBuild.ensureRecordedTargetIdentity(env, seeded.runId);
    assertEq(out.outcome, "already-recorded");
    assertEq(out.targetBuildId, "release-4.2.1");
    assertEq((await mod.envelope.getEnvelope(env, seeded.runId)).input.targetBuildId, "release-4.2.1");

    // A second call — a resumed instance, a recovered replacement — must be a no-op too, or a
    // judgement already bound to this run's identity would stop binding half-way through.
    await mod.targetBuild.ensureRecordedTargetIdentity(env, seeded.runId);
    assertEq((await mod.envelope.getEnvelope(env, seeded.runId)).input.targetBuildId, "release-4.2.1");
  });

  test("NULL IS NEVER WRITTEN: a run that captured nothing stays unbindable", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env, { targetBuildId: null });

    const out = await mod.targetBuild.ensureRecordedTargetIdentity(env, seeded.runId);
    assertEq(out.outcome, "no-capture");
    assertEq(out.targetBuildId, null);
    assertEq((await mod.envelope.getEnvelope(env, seeded.runId)).input.targetBuildId, null);
    assert(
      !JSON.stringify(out).includes(PREFIX),
      "a run that observed nothing must not be handed a well-formed identity for having observed nothing",
    );
  });

  test("BLANK CONFIGURATION IS NOT CONFIGURATION: a whitespace DEFAULT_TARGET_BUILD_ID records as null", async () => {
    // `assemble-record.mjs` stamps this field verbatim while `store/target-build.ts` treats a
    // blank string as unset, so a whitespace variable would have signed a record bound to
    // "   " beside a report that resolved something else — a mismatch reading as "a judgement
    // of a different build".
    const mod = await worker();
    const env = testEnv({ DEFAULT_TARGET_BUILD_ID: "   " });
    const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    const req = new Request("https://x/api/v2/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surveyUrl: "https://fixture.invalid/s",
        documentBase64: btoa(String.fromCharCode(...docx)),
        documentName: "q.docx",
      }),
    });
    const res = await mod.apiRuns.submitRun(req, env);
    assertEq(res.status, 202, await res.clone().text());
    const { runId } = await res.json();
    assertEq((await mod.envelope.getEnvelope(env, runId)).input.targetBuildId, null);
  });

  test("THE WIRING: the workflow records the identity BEFORE it derives or assembles anything", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env, { targetBuildId: null, testCompletion: "running" });
    await withScreens(mod, env, seeded.runId, ['{"screen":"Q1"}', '{"screen":"Q2"}']);

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    const step = fakeStep();
    await wf.run(
      {
        payload: {
          runId: seeded.runId,
          surveyUrl: "https://fixture.invalid/s",
          documentKey: "k",
          documentSha256: "a".repeat(64),
          profile: "standard",
          locale: "en",
          viewports: ["desktop"],
        },
      },
      step,
    );

    const at = step.calls.indexOf("record-target-identity");
    assert(at >= 0, `the workflow must record a target identity: ${step.calls.join(", ")}`);
    for (const later of ["derive-verdicts", "assemble-record", "mint-judgement", "report"]) {
      const j = step.calls.indexOf(later);
      assert(j < 0 || at < j, `identity must be recorded before ${later} (${at} vs ${j})`);
    }
    const envelope = await mod.envelope.getEnvelope(env, seeded.runId);
    assert(
      envelope.input.targetBuildId?.startsWith(PREFIX),
      `the run must have recorded what it tested, got ${JSON.stringify(envelope.input.targetBuildId)}`,
    );
  });

  test("CHARACTERIZATION, NOT A GUARD: the derived id is NOT stable across runs, and here is the reason", async () => {
    // READ THIS BEFORE "FIXING" THIS TEST.
    //
    // `RenderedScreen.at` (browser/types.ts) is a wall-clock capture timestamp, and
    // browser/capture.ts stringifies the WHOLE screen into the `dom-excerpt` blob whose
    // sha-256 IS its content hash. So two runs over a byte-identical site derive two
    // DIFFERENT ids, and the id therefore answers "which observation is this judgement bound
    // to" and NOT "which build was served".
    //
    // This is asserted rather than hidden because the alternative — quietly excluding
    // `dom-excerpt`, or reaching inside blobs this module did not write to normalise them —
    // would produce an id that LOOKS like a build fingerprint and is not one. Closing it is a
    // capture-side change (hoist `at` out of the hashed projection, or catalogue a normalised
    // screen hash beside the raw one). When that lands, THIS TEST MUST BE INVERTED
    // DELIBERATELY, not deleted.
    const mod = await worker();
    const env = testEnv();
    const screen = (at) => ({
      at,
      url: "https://fixture.invalid/s",
      title: "Q1",
      visibleText: "How often do you water them?",
      controls: [],
      screenSignature: "sig-q1",
    });
    const ctx = (runId) => ({ env, runId, attemptId: "a1", pathId: "p1", witnesses: [] });

    const a = await seedRun(mod, env, { targetBuildId: null });
    const b = await seedRun(mod, env, { targetBuildId: null });
    // The SAME screen, captured through the REAL capture path, one second apart.
    await mod.capture.captureScreenJson(ctx(a.runId), screen("2026-08-08T10:00:00.000Z"), "before", 1);
    await mod.capture.captureScreenJson(ctx(b.runId), screen("2026-08-08T10:00:01.000Z"), "before", 1);

    const idA = await mod.reportBuild.deriveObservedSiteBuildId(await mod.evidence.listCatalog(env, a.runId));
    const idB = await mod.reportBuild.deriveObservedSiteBuildId(await mod.evidence.listCatalog(env, b.runId));
    assert(idA && idB, "both runs captured a screen, so both derive an id");
    assert(
      idA !== idB,
      "MEASURED LIMITATION: if these are now equal, the capture side has been normalised — " +
        "invert this test and update store/target-build.ts's honesty note, do not delete it",
    );

    // And the counterweight that stops this from being a test of nothing: with the clock held
    // still, the very same screen DOES derive the same id, so the instability above is the
    // timestamp and not general randomness.
    const c = await seedRun(mod, env, { targetBuildId: null });
    await mod.capture.captureScreenJson(ctx(c.runId), screen("2026-08-08T10:00:00.000Z"), "before", 1);
    const idC = await mod.reportBuild.deriveObservedSiteBuildId(await mod.evidence.listCatalog(env, c.runId));
    assertEq(idC, idA, "the same bytes must always derive the same id — the variable is the clock");
  });
});

/**
 * D13 — recovery was neither resumable nor fenced.
 *
 * Five separate holes, five separate tests:
 *   - `recoveryAttempt` was passed and never read, so a replacement re-extracted and
 *     re-sealed from scratch, discarding the cursor and the live browser session;
 *   - nothing stopped an uncertain original and its replacement both driving the browser;
 *   - a fresh heartbeat hid indefinitely stale durable progress, because the sweeper took
 *     max(beat, progress);
 *   - exhausted recovery returned "attempts-exhausted" forever and never terminalized;
 *   - a successful recovery never cleared the recovery state.
 */

import { assert, assertEq, assertThrows, fakeStep, suite, test } from "../testkit.mjs";
import { seedRun, testEnv, worker } from "./_helpers.mjs";

const payloadFor = (runId, recoveryAttempt) => ({
  payload: {
    runId,
    surveyUrl: "https://fixture.invalid/s",
    documentKey: "k",
    documentSha256: "a".repeat(64),
    profile: "standard",
    locale: "en",
    viewports: ["desktop"],
    ...(recoveryAttempt === undefined ? {} : { recoveryAttempt }),
  },
});

const ago = (ms) => new Date(Date.now() - ms).toISOString();

suite("D13 — recovery resumes and is fenced", () => {
  test("a replacement RESUMES the sealed contract instead of re-extracting", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env, { testCompletion: "running" });
    // Pretend the original got as far as sealing and then died.
    await mod.checkpoint.claimOwnership(env, seeded.runId, seeded.runId, 0);

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    const step = fakeStep();
    await wf.run(payloadFor(seeded.runId, 1), step);

    assert(step.calls.includes("resume-sealed-contract"), `steps: ${step.calls.join(", ")}`);
    assert(!step.calls.includes("seal-contract-revision"), "a replacement must never re-seal a sealed contract");
    // BOUND TO THE STEP NAMES THE WORKFLOW ACTUALLY USES. This line asserted
    // `!step.calls.includes("extract-pass-a-global")` — a step name the wave work renamed to
    // `extract-pass-a-wave-N`. The assertion therefore passed no matter what the workflow did:
    // a replacement could have re-extracted the whole document and this test would still have
    // been green. That is the check-that-cannot-fail class CLAUDE.md names as recurring here,
    // and the rename is what introduced it.
    assertEq(
      step.calls.filter((n) => n.startsWith("extract-pass-a-wave-")).length,
      0,
      `a replacement must never re-run extraction, steps: ${step.calls.join(", ")}`,
    );

    const cp = (await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
    assertEq(cp.contract.contractRevisionId, seeded.contractRevisionId, "the run keeps ONE denominator");
    assertEq(cp.ownership.epoch, 1, "the replacement owns the run at its own epoch");
    assertEq(cp.ownership.instanceId, `${seeded.runId}-r1`);
  });

  test("an epoch fence stops the superseded original from writing", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env, { testCompletion: "running" });

    const original = await mod.checkpoint.claimOwnership(env, seeded.runId, seeded.runId, 0);
    // A write while it still owns the run succeeds.
    assert(await mod.checkpoint.updateCheckpoint(env, seeded.runId, (d) => { d.error = "before"; }, { fence: original }));

    // The sweeper hands the run to a replacement.
    await mod.checkpoint.claimOwnership(env, seeded.runId, `${seeded.runId}-r1`, 1);

    const err = await assertThrows(
      () => mod.checkpoint.updateCheckpoint(env, seeded.runId, (d) => { d.error = "after"; }, { fence: original }),
      "may no longer write",
    );
    assertEq(err.name, "OwnershipLost");
    const cp = (await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
    assertEq(cp.error, "before", "the superseded instance's write must not have landed");
  });

  test("the fence is taken BEFORE the browser, not only before the write", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env, { testCompletion: "running" });

    // Give the run one pending case so the batch loop would really drive the browser.
    await mod.checkpoint.claimOwnership(env, seeded.runId, seeded.runId, 0);
    await mod.checkpoint.updateCheckpoint(env, seeded.runId, (d) => {
      d.execution = {
        batchIndex: 0,
        sessionId: null,
        sessionOpenedAt: null,
        pendingCaseIds: ["fi_fixture01"],
        completedCaseIds: [],
        planRevisionId: "plan_fixture",
      };
    });

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    // A step double that lets the run reach the batch, then supersedes it mid-flight.
    let superseded = false;
    const step = {
      calls: [],
      cache: new Map(),
      async do(name, a, b) {
        const body = typeof a === "function" ? a : b;
        this.calls.push(name);
        if (name.startsWith("execute-batch-") && !superseded) {
          superseded = true;
          await mod.checkpoint.claimOwnership(env, seeded.runId, `${seeded.runId}-r1`, 1);
        }
        if (this.cache.has(name)) return this.cache.get(name);
        const r = await body();
        this.cache.set(name, r);
        return r;
      },
      async sleep() {},
    };

    await wf.run(payloadFor(seeded.runId), step);

    // The puppeteer stub throws "test stub: puppeteer is not available under node" if the
    // browser is ever touched. It must not have been: the fence fires first, and the
    // instance stops quietly because it no longer owns the run.
    const cp = (await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
    assert(
      cp.error === null || !String(cp.error).includes("test stub"),
      `a superseded instance must not drive the browser (error=${cp.error})`,
    );
    assertEq(cp.ownership.epoch, 1);
  });

  test("SWEEPER: a fresh heartbeat does not hide stale durable progress", async () => {
    const mod = await worker();
    // The instance is genuinely RUNNING as far as the engine is concerned — this is the
    // case the two-signal rule exists for.
    const env = testEnv({
      V2_RUN_WORKFLOW: { async get() { return { async status() { return { status: "running" }; } }; }, async create() {} },
    });
    const seeded = await seedRun(mod, env, { testCompletion: "running" });

    // Beating right now, no committed progress for three hours.
    await mod.checkpoint.beat(env, seeded.runId, "still alive", "fp-1");
    await env.EVIDENCE.put(
      mod.keys.checkpointKey(seeded.runId),
      JSON.stringify({
        ...(await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint,
        lastProgressAt: ago(3 * 60 * 60 * 1000),
      }),
    );
    await env.EVIDENCE.put(
      mod.keys.envelopeKey(seeded.runId),
      JSON.stringify({
        ...(await mod.envelope.getEnvelope(env, seeded.runId)),
        createdAt: ago(4 * 60 * 60 * 1000),
      }),
    );

    const verdict = await mod.sweeper.sweepRun(env, seeded.runId, new Date());
    assert(verdict !== "healthy", `a beating-but-idle run must not read as healthy (got ${verdict})`);
    assertEq(verdict, "stall-strike-1", "and it enters the two-strike protocol rather than acting immediately");
  });

  test("SWEEPER: exhausted recovery is TERMINAL, not a permanent shrug", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env, { testCompletion: "running" });
    await mod.envelope.markActive(env, seeded.runId);

    await env.EVIDENCE.put(
      mod.keys.envelopeKey(seeded.runId),
      JSON.stringify({
        ...(await mod.envelope.getEnvelope(env, seeded.runId)),
        createdAt: ago(6 * 60 * 60 * 1000),
        recovery: { attempt: 1, phase: "recreating", startedAt: ago(5 * 60 * 60 * 1000), reason: "instance not found" },
      }),
    );
    await env.EVIDENCE.put(
      mod.keys.checkpointKey(seeded.runId),
      JSON.stringify({
        ...(await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint,
        lastProgressAt: ago(5 * 60 * 60 * 1000),
      }),
    );

    const verdict = await mod.sweeper.sweepRun(env, seeded.runId, new Date());
    assert(verdict.startsWith("failed:"), `expected a terminal outcome, got ${verdict}`);

    const cp = (await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
    assertEq(cp.completion.test, "failed");
    assertEq(cp.completion.reasonCode, "recovery-exhausted");
    assertEq(await env.EVIDENCE.head(mod.keys.activeMarkerKey(seeded.runId)), null, "and it stops being swept");
  });

  test("SWEEPER: a replacement still making progress is left alone", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env, { testCompletion: "running" });
    await env.EVIDENCE.put(
      mod.keys.envelopeKey(seeded.runId),
      JSON.stringify({
        ...(await mod.envelope.getEnvelope(env, seeded.runId)),
        createdAt: ago(6 * 60 * 60 * 1000),
        recovery: { attempt: 1, phase: "recreating", startedAt: ago(5 * 60 * 60 * 1000), reason: "instance not found" },
      }),
    );
    await mod.checkpoint.beat(env, seeded.runId, "working", "fp-2");
    const verdict = await mod.sweeper.sweepRun(env, seeded.runId, new Date());
    assertEq(verdict, "attempts-exhausted-but-progressing");
  });

  test("a run that finishes clears its recovery state", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env, { testCompletion: "running" });
    await mod.checkpoint.updateCheckpoint(env, seeded.runId, (d) => {
      d.recovery = { active: true, attempt: 1, reason: "instance not found" };
    });
    await mod.envelope.updateEnvelope(env, seeded.runId, (e) => {
      e.recovery = { attempt: 1, phase: "recreating", claimId: "c1", leaseUntil: ago(-60_000), stallValue: "x" };
    });

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    await wf.run(payloadFor(seeded.runId, 1), fakeStep());

    const cp = (await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
    assertEq(cp.recovery.active, false, "a finished run is not in recovery mode");
    const env2 = await mod.envelope.getEnvelope(env, seeded.runId);
    assertEq(env2.recovery.phase, undefined);
    assertEq(env2.recovery.leaseUntil, undefined);
    assert(env2.finalCompletion, "and the envelope records the terminal outcome");
  });
});

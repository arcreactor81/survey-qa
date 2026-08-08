/**
 * A FAILED RUN SAYS WHY IT FAILED — through the product's own surfaces.
 *
 * THE INCIDENT THESE TESTS ARE WRITTEN FROM. Run `v2r_01kzf7ehb2sayx2y2xz4ecm1ed`, the
 * first real one, ended with `completion.reasonCode: "workflow-error"` and an empty
 * `error`. Cloudflare's Workflow API had the answer the entire time and returned it
 * instantly — `plan-1`, three attempts, each one
 * `Error: planning refused duplicate sealed facetInstanceId fi_b74430a941910fc9a6f9`.
 * A perfect diagnosis, recorded by the engine, reachable only by an operator with an API
 * token. Nothing a user or an API consumer could read said anything at all.
 *
 * FOUR PROPERTIES, and each one fails on the code as it was:
 *
 *   1. The cause is recorded WHERE IT STILL EXISTS — inside the step closure, in the same
 *      isolate as the throw, before the durable step boundary gets to decide how much of
 *      an error survives it. That is also the only place that knows the step's NAME.
 *   2. A guard that deliberately refused gets a NAMED reason (`planning-refused`), not the
 *      code reserved for "something threw and we do not know what".
 *   3. The original error still propagates. Recording is additive; nothing is swallowed,
 *      the step still fails and the instance still errors.
 *   4. Nothing sensitive rides along. An error message is user-visible text, so it is
 *      sanitised — and the sanitiser is tested in BOTH directions, because one that ate
 *      the diagnosis would pass a leak test and fail at the job it exists for.
 */

import { assert, assertEq, assertThrows, fakeStep, memoryR2, suite, test } from "../testkit.mjs";
import { seedRun, testEnv, worker } from "./_helpers.mjs";

/** The exact sentence the planner's guard threw on the run that started all this. */
const THE_REAL_REFUSAL = "planning refused duplicate sealed facetInstanceId fi_b74430a941910fc9a6f9";
const THE_FACET_ID = "fi_b74430a941910fc9a6f9";

const RUN_PARAMS = (runId) => ({
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

/** A workflow instance, and its step wrapper, without driving a whole run. */
function instrumented(mod, env, runId) {
  const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
  const raw = fakeStep();
  return { wf, raw, step: wf.instrumentSteps(raw, runId) };
}

const load = async (mod, env, runId) => (await mod.checkpoint.loadCheckpoint(env, runId)).checkpoint;

suite("a failed run says why — the cause reaches the surfaces", () => {
  test("the step closure records the cause, the step name and a NAMED reason", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });
    const { step } = instrumented(mod, env, runId);

    // The body throws exactly what plan.ts's guard throws. On the code as it was, this
    // error crossed the step boundary and the run published `workflow-error` with nothing
    // else; the message never reached anything a reader could open.
    const threw = await assertThrows(
      () => step.do("plan", { retries: { limit: 0 } }, async () => { throw new Error(THE_REAL_REFUSAL); }),
      THE_REAL_REFUSAL,
      "PROPERTY 3: the original error must still propagate — the step has to genuinely fail",
    );
    assertEq(threw.message, THE_REAL_REFUSAL, "the SAME error object, not a re-wrapped stand-in");

    const cp = await load(mod, env, runId);
    assert(cp.failure, "the cause must be on the checkpoint at all — this is the field that did not exist");
    assertEq(cp.failure.step, "plan", "PROPERTY 1: only the closure knows WHICH step refused");
    assertEq(
      cp.failure.reasonCode,
      "planning-refused",
      "PROPERTY 2: a deliberate guard refusing is not an unknown crash",
    );
    assertEq(cp.failure.kind, "Error", "the thrower's class travels as its own fact");
    assert(
      cp.failure.message.includes(THE_FACET_ID),
      `the diagnosis must survive verbatim — the id IS the answer, got: ${cp.failure.message}`,
    );
    assert(
      cp.failure.message.includes("planning refused duplicate sealed facetInstanceId"),
      `the guard's sentence must survive, got: ${cp.failure.message}`,
    );
  });

  test("THE STATUS ENDPOINT: a reader polling the run is told what happened", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });
    const { step } = instrumented(mod, env, runId);

    await assertThrows(
      () => step.do("plan", async () => { throw new Error(THE_REAL_REFUSAL); }),
      THE_REAL_REFUSAL,
    );

    const res = await mod.apiRuns.getStatus(new Request(`https://x/api/v2/runs/${runId}/status`), env, runId);
    assertEq(res.status, 200, "the status endpoint must answer");
    const body = await res.json();

    assert(body.failure, "the status body must carry the cause, not just a verdict");
    assertEq(body.failure.reasonCode, "planning-refused", "the machine field a client branches on");
    assertEq(body.failure.step, "plan", "which stage refused");
    assert(
      body.failure.message.includes(THE_FACET_ID),
      `the human sentence a reader renders, got: ${body.failure.message}`,
    );
    // STRUCTURED, NOT A BLOB: the four facts are four fields. A client that wants to
    // switch on the reason must never have to parse the prose to find it.
    for (const key of ["step", "reasonCode", "kind", "message", "at"]) {
      assert(key in body.failure, `failure.${key} must be its own field`);
    }
  });

  test("THE RUN RECORD: the endpoint named after the run can say why it failed", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });
    const { step } = instrumented(mod, env, runId);

    await assertThrows(
      () => step.do("plan", async () => { throw new Error(THE_REAL_REFUSAL); }),
      THE_REAL_REFUSAL,
    );

    const res = await mod.apiRuns.getRunSummary(new Request(`https://x/api/v2/runs/${runId}`), env, runId);
    const body = await res.json();
    // This endpoint used to return `completion` and had, structurally, no field in which
    // to explain it: a verdict with no evidence.
    assert("error" in body, "the run record must have somewhere to put the sentence");
    assert(body.failure, "and the structured cause beside it");
    assertEq(body.failure.reasonCode, "planning-refused");
    assert(body.failure.message.includes(THE_FACET_ID), `got: ${body.failure.message}`);
  });

  test("A HEALTHY RUN IS UNCHANGED — the field is omitted, not nulled", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedRun(mod, env);
    const cp = await load(mod, env, runId);

    const status = mod.contracts.projectStatus(cp, "2026-08-08T00:00:00.000Z");
    assert(!("failure" in status), "a run that never failed must not carry an empty failure block");
    assert(
      !JSON.stringify(status).includes("failure"),
      "the bytes on the wire must not carry the field at all for a healthy run",
    );

    const summary = await (await mod.apiRuns.getRunSummary(new Request("https://x/"), env, runId)).json();
    assert(!("failure" in summary), "same rule on the run record");
    assertEq(summary.error, null, "and its error is null, not a string saying nothing");
  });

  test("A RETRY THAT SUCCEEDED IS NOT A FAILURE — the cause is withdrawn", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });
    const { step } = instrumented(mod, env, runId);

    // `plan` runs under a 2-retry policy in production. Attempt 1 throws...
    await assertThrows(
      () => step.do("plan", async () => { throw new Error(THE_REAL_REFUSAL); }),
      THE_REAL_REFUSAL,
    );
    assert((await load(mod, env, runId)).failure, "attempt 1's cause is recorded");

    // ...and attempt 2 works. A run that carried a contradiction of its own outcome for
    // the rest of its life would be exactly the kind of lying surface this fix exists
    // against.
    await step.do("plan", async () => ({ planRevisionId: "pr_x", caseCount: 2 }));
    assert(
      !(await load(mod, env, runId)).failure,
      "a superseded cause must be withdrawn once the step succeeds",
    );
  });

  test("FIRST CAUSE WINS — the aftershock does not overwrite the diagnosis", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });
    const { step } = instrumented(mod, env, runId);

    await assertThrows(() => step.do("plan", async () => { throw new Error(THE_REAL_REFUSAL); }), THE_REAL_REFUSAL);
    await assertThrows(
      () => step.do("report", async () => { throw new Error("could not build a report for a run that never planned"); }),
      "could not build a report",
    );

    const cp = await load(mod, env, runId);
    assertEq(cp.failure.step, "plan", "the run failed in planning; reporting merely failed afterwards");
    assertEq(cp.failure.reasonCode, "planning-refused");
  });
});

suite("the whole-run failure path: named reason, still propagating, still reported", () => {
  test("the run ends with the GUARD'S name, not the generic code", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });

    // `fakeStep`'s `throwOn` throws at the BOUNDARY, without running the body — which is
    // precisely the degraded path the incident took. Even here, when a message does reach
    // the outer catch, it must be classified rather than flattened.
    const step = fakeStep({ throwOn: { "resume-durable-state": new Error(THE_REAL_REFUSAL) } });
    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);

    await assertThrows(
      () => wf.run(RUN_PARAMS(runId), step),
      THE_REAL_REFUSAL,
      "PROPERTY 3: the ORIGINAL error must still propagate so the instance genuinely errors",
    );

    const cp = await load(mod, env, runId);
    assertEq(cp.completion.test, "failed", "the run is failed");
    assertEq(
      cp.completion.reasonCode,
      "planning-refused",
      "PROPERTY 2: `workflow-error` means nobody knows; this failure IS understood",
    );
    assert(cp.error && cp.error.includes(THE_FACET_ID), `the sentence is on file: ${cp.error}`);
    assert(cp.failure && cp.failure.reasonCode === "planning-refused", "and the structured cause beside it");

    // The phase rail has carried a reasonCode for `stopped` since it was written, and the
    // uncaught path was the one branch that stopped a phase without filling it in.
    const stopped = cp.phases.filter((ph) => ph.state === "stopped");
    assert(
      stopped.length === 0 || stopped.some((ph) => ph.reasonCode !== null),
      "a stopped phase must say why it stopped",
    );

    // And the second gap: an uncaught step failure still produces a report to read.
    assert(step.calls.includes("report"), `reporting is reached on the failure path: ${step.calls.join(", ")}`);
    assert(step.calls.includes("finalize"), "and the run is finalized");
  });

  test("an UNRECOGNISED crash still says `workflow-error` — no confident guessing", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });

    const step = fakeStep({ throwOn: { "resume-durable-state": new Error("connection reset by peer") } });
    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    await assertThrows(() => wf.run(RUN_PARAMS(runId), step), "connection reset by peer");

    const cp = await load(mod, env, runId);
    assertEq(
      cp.completion.reasonCode,
      "workflow-error",
      "the honest code for a fault nobody has classified — the classifier must not widen",
    );
    // It still SAYS something, which is the other half of the fix: a generic reason is
    // acceptable, a generic reason with nothing beside it is what happened in August.
    assert(cp.error && cp.error.includes("connection reset by peer"), `got: ${cp.error}`);
  });

  test("the precise in-closure record is NOT clobbered by the boundary's vaguer one", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });

    // Stand in for "the closure already wrote the truth" — the state the run reaches when
    // the body threw and the boundary then handed the outer catch something lesser.
    await mod.checkpoint.updateCheckpoint(env, runId, (d) => {
      d.failure = {
        step: "plan",
        reasonCode: "planning-refused",
        kind: "Error",
        message: THE_REAL_REFUSAL,
        at: "2026-08-07T23:14:22.114Z",
      };
    });

    const step = fakeStep({ throwOn: { "resume-durable-state": new Error("") } });
    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    await assertThrows(() => wf.run(RUN_PARAMS(runId), step));

    const cp = await load(mod, env, runId);
    assertEq(cp.failure.step, "plan", "the step the closure named must survive");
    assertEq(cp.completion.reasonCode, "planning-refused", "and its reason, not the boundary's blank");
    assert(cp.error.includes(THE_FACET_ID), `and the surfaced sentence is the good one: ${cp.error}`);
  });
});

suite("an error message is user-visible text — nothing sensitive rides along", () => {
  const leaks = [
    ["a bearer token", "upstream refused: Authorization: Bearer sk-ant-api03-AbCdEf0123456789xyz", "sk-ant"],
    // THE ORDERING CASE. This one is not caught by the provider-prefix rule, so it is the
    // row that actually proves `Bearer` is redacted before the `Authorization:` assignment
    // rule eats the word "Bearer" and calls the job done.
    ["a bearer JWT", "denied: Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJ4In0.sIgNaTuRe", "eyJhbGciOiJSUzI1NiJ9"],
    ["an api key assignment", "call failed (api_key=9f8e7d6c5b4a39281706)", "9f8e7d6c5b4a39281706"],
    ["a provider key prefix", "DeepSeek rejected sk-4f1c9ab7de2340815566", "sk-4f1c9ab7de2340815566"],
    ["an internal gateway URL", "POST https://gateway.ai.cloudflare.internal/v1/acct-77/deepseek failed", "cloudflare.internal"],
    ["an R2 endpoint", "put failed: https://f0cbb2076e.r2.cloudflarestorage.com/survey-qa-artifacts", "r2.cloudflarestorage.com"],
    ["a POSIX build path", "TypeError: x is not a function\n    at plan (/worker/src/workflow/stages/plan.ts:413:13)", "/worker/src"],
    ["a Windows path", "ENOENT: E:\\survey-qa\\worker-v2\\.dev.vars not found", "survey-qa\\worker-v2"],
    ["a cookie", "rejected: Cookie: CF_Authorization=eyJhbGciOiJSUzI1NiJ9.payload", "eyJhbGciOiJSUzI1NiJ9"],
  ];

  test("credentials, internal hosts, paths and stack frames never reach the client", async () => {
    const mod = await worker();
    for (const [label, raw, secret] of leaks) {
      const clean = mod.contracts.sanitiseErrorText(raw);
      assert(!clean.includes(secret), `${label} leaked: ${clean}`);
      assert(!/\n/.test(clean), `${label} left a multi-line blob: ${JSON.stringify(clean)}`);
    }
  });

  test("...AND THE DIAGNOSIS SURVIVES — a sanitiser that eats the answer has failed", async () => {
    const mod = await worker();
    const clean = mod.contracts.sanitiseErrorText(new Error(THE_REAL_REFUSAL));
    assert(clean.includes(THE_FACET_ID), `the facet instance id IS the diagnosis, got: ${clean}`);
    assert(clean.includes("planning refused duplicate sealed facetInstanceId"), `got: ${clean}`);

    // The other ids a reader needs in order to act, none of them secrets.
    const withIds = mod.contracts.sanitiseErrorText(
      "seal refused: contract revision cr_9ace02930ee22ce76cd2663e762fc057af81745f " +
        "(sha256:14563a2c726f89ea56d41e352696355677b4064a30d84b646d124ba812a3c58e) has 0 execution cases",
    );
    assert(withIds.includes("cr_9ace02930ee22ce76cd2663e762fc057af81745f"), `revision id lost: ${withIds}`);
    assert(withIds.includes("sha256:14563a2c"), `content hash lost: ${withIds}`);
  });

  test("the surfaced text is BOUNDED — a status body is not a log sink", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });
    const { step } = instrumented(mod, env, runId);

    await assertThrows(() => step.do("plan", async () => { throw new Error("x".repeat(9000)); }), "xxx");

    const body = await (
      await mod.apiRuns.getStatus(new Request(`https://x/api/v2/runs/${runId}/status`), env, runId)
    ).json();
    assert(body.failure.message.length <= 300, `unbounded diagnosis: ${body.failure.message.length} chars`);
    assert((body.error ?? "").length <= 2000, `unbounded error prose: ${(body.error ?? "").length} chars`);
  });

  test("a checkpoint written BEFORE the sanitiser existed is still sanitised on the way out", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });

    // Read-side re-sanitisation is not belt-and-braces: eight call sites across four
    // modules write `error`, some of them interpolating a browser binding's exception or
    // a Cloudflare API body, and the projection is the one place all of them pass through.
    await mod.checkpoint.updateCheckpoint(env, runId, (d) => {
      d.error = "browser unavailable: GET https://internal-broker.svc.local/session?token=abcd1234efgh failed";
    });

    const body = await (
      await mod.apiRuns.getStatus(new Request(`https://x/api/v2/runs/${runId}/status`), env, runId)
    ).json();
    assert(!body.error.includes("internal-broker.svc.local"), `internal host leaked: ${body.error}`);
    assert(!body.error.includes("abcd1234efgh"), `token leaked: ${body.error}`);
    assert(body.error.includes("browser unavailable"), `the diagnosis was eaten: ${body.error}`);
  });

  /**
   * THE STEP OBJECT IS AN RPC STUB IN PRODUCTION, AND THE SUITE CANNOT SEE THAT.
   *
   * `fakeStep()` is an ordinary object, so `step.do.bind(step)` is `Function.prototype.bind`
   * and every behavioural test above passes on code that cannot survive one second in the
   * cloud. It did not survive: run `v2r_01kzfa0dx1pg90xcvamef6zb6c` errored at 0 seconds
   * with 0 steps and `TypeError: The RPC receiver does not implement the method "bind"`,
   * on a suite that was 339/339 green.
   *
   * A stub answers EVERY property by resolving it as a method name on the far side, so
   * `.bind` / `.call` / `.apply`, and any method read off it and held, are asks for remote
   * methods that do not exist. Only `target.method(...)` works. Since no behavioural test
   * can distinguish the two, the guard is on the source itself — the one check here that
   * can actually fail.
   */
  test("the step wrapper never uses a form a JSRPC stub cannot answer", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(new URL("../../src/workflow/run-workflow.ts", import.meta.url)),
      "utf8",
    );

    // Only the wrapper's body — the surrounding prose explains the crash and names the
    // forbidden forms, so scanning the whole file would match its own warning.
    const start = src.indexOf("private instrumentSteps(");
    assert(start !== -1, "instrumentSteps is gone — this guard is now testing nothing");
    const end = src.indexOf("\n  private ", start + 10);
    const body = src
      .slice(start, end === -1 ? src.length : end)
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");

    for (const forbidden of [".bind(", ".call(", ".apply("]) {
      assert(
        !body.includes(forbidden),
        `instrumentSteps uses ${forbidden} on the step object. A JSRPC stub resolves that ` +
          `as a remote method name and the run dies before step 1. Use target.method(...).`,
      );
    }

    // And the positive half: a detached `const inner = step.do` is the same bug wearing a
    // different hat — reading a method off a stub and holding it loses the receiver — so
    // EVERY mention of `step.do` must be invoked on the spot. Two spellings are legal:
    // `step.do(...)`, and `(step.do as T)(...)` where the cast is parenthesised and called.
    // Paren-balanced rather than regexed, because the cast type contains parens itself.
    const held = [];
    let found = 0;
    for (let i = body.indexOf("step.do"); i !== -1; i = body.indexOf("step.do", i + 1)) {
      found++;
      const after = body.slice(i + "step.do".length);
      if (/^\s*\(/.test(after)) continue; // step.do(...)

      if (/^\s+as\s/.test(after)) {
        let k = i - 1;
        while (k >= 0 && /\s/.test(body[k])) k--;
        if (body[k] !== "(") {
          held.push(body.slice(i, i + 60));
          continue;
        }
        let depth = 1;
        let m = k + 1;
        while (m < body.length && depth > 0) {
          if (body[m] === "(") depth++;
          else if (body[m] === ")") depth--;
          m++;
        }
        if (/^\s*\(/.test(body.slice(m))) continue; // (step.do as T)(...)
      }
      held.push(body.slice(i, i + 60));
    }

    assert(found > 0, "instrumentSteps no longer forwards step.do at all");
    assert(
      held.length === 0,
      `step.do is read without being invoked on the spot — a held reference loses the ` +
        `receiver, which on a stub is the same crash: ${JSON.stringify(held)}`,
    );
  });
});

// ===========================================================================
// THE SECOND INCIDENT — v2r_01kzfb6py8pbxznqv022p2qkhb, 8 August 2026
//
// The machinery above was 13/13 green and produced NOTHING on the first real failure it
// met. The run died at `verify-observations-1`; Cloudflare's engine recorded the cause
// perfectly, on all three retries:
//
//     Error: Too many API requests by single Worker invocation.
//
// and the status endpoint answered:
//
//     {"completion":{"test":"partial-blocked","report":"not-started",
//                    "reasonCode":"walks-blocked-by-site"},
//      "failure": undefined, "error": null}
//
// TWO DEFECTS, AND THE FIRST ONE IS WHY THE TESTS ABOVE COULD NOT SEE IT.
//
//   1. THE RECORDER NEEDED THE RESOURCE THAT HAD RUN OUT. Writing the cause is an R2 write;
//      an R2 write is a subrequest; subrequests were the thing exhausted. The in-closure
//      recorder swallowed its own failure by design, and the outer `record-failure` step
//      failed the same way on all four attempts — 0 seconds each, per the engine's own step
//      list, which ends `verify-observations-1, record-failure-1` with NO `report-1` and NO
//      `finalize-1`. Every test above runs against `memoryR2`, and a fake bucket cannot run
//      out of subrequests, so all of them passed on code that could not survive this.
//
//   2. THE HEADLINE DESCRIBED A DIFFERENT EVENT. `walks-blocked-by-site` was true of the
//      WALK PHASE, minutes earlier. The run then died in VERIFICATION for an unrelated
//      reason, and the old rule — promote only `running` to `failed`, and never replace a
//      reasonCode already on file — left the stale phase fact standing as the run's cause.
//
// THE TESTS BELOW MAKE THE STORAGE LAYER THROW THE ACTUAL CLOUDFLARE SENTENCE. That is the
// difference between a check that passes and a check that could fail: every assertion here
// is false on the code as it was.
// ===========================================================================

/** The engine's own words, verbatim, from the instance record for the dead run. */
const THE_CEILING =
  "Too many API requests by single Worker invocation. " +
  "To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits";
const SUBREQUEST_LIMIT_EXCEEDED = "subrequest-limit-exceeded";
const WALKS_BLOCKED = "walks-blocked-by-site";

/**
 * AN R2 BINDING THAT CAN RUN OUT — the property `memoryR2` structurally cannot have.
 *
 * Once `exhaust()` is called every operation throws the sentence the platform throws, which
 * is what turns "the recorder writes the cause" from an assumption into a claim with a way
 * of being wrong. `restore()` is not a cheat: a later HTTP request is a DIFFERENT Worker
 * invocation with its own budget, so a reader's request succeeding while the dying run's
 * writes fail is the real asymmetry, not a convenience.
 */
function exhaustible(bucket = memoryR2()) {
  let out = false;
  const guard = (fn) => async (...args) => {
    if (out) throw new Error(THE_CEILING);
    return fn(...args);
  };
  return {
    exhaust() { out = true; },
    restore() { out = false; },
    get exhausted() { return out; },
    head: guard((...a) => bucket.head(...a)),
    get: guard((...a) => bucket.get(...a)),
    put: guard((...a) => bucket.put(...a)),
    delete: guard((...a) => bucket.delete(...a)),
    list: guard((...a) => bucket.list(...a)),
  };
}

/**
 * A step double with two hooks: run something the instant a named step is entered (used to
 * exhaust the budget mid-run, exactly as a real stage does), and run something when the
 * workflow sleeps (used to stand in for the fresh invocation a hibernation MIGHT grant).
 */
function hookedStep({ throwOn = {}, onStep = {}, onSleep = null } = {}) {
  const base = fakeStep({ throwOn });
  return {
    get calls() { return base.calls; },
    get sleeps() { return base.sleeps; },
    async do(name, a, b) {
      if (onStep[name]) onStep[name]();
      return base.do(name, a, b);
    },
    async sleep(name, duration) {
      if (onSleep) onSleep(name);
      return base.sleep(name, duration);
    },
    async sleepUntil(name, ts) {
      return base.sleepUntil(name, ts);
    },
  };
}

/** A Workflows binding that answers the way the engine answered for the dead run. */
const engineSaying = (status, message) => ({
  async get() {
    return { async status() { return { status, error: { name: "Error", message } }; } };
  },
  async create() {},
});

/** A binding that fails the test if the read surface consults it at all. */
const engineThatMustNotBeAsked = () => ({
  async get() {
    throw new Error("ASKED-THE-ENGINE");
  },
  async create() {},
});

/**
 * The run's state at the moment it died: the walk phase legitimately stopped because the
 * site blocked it, and verification in flight. Both facts are real and both must survive.
 */
async function seedTheIncident(mod, env, runId) {
  await mod.checkpoint.updateCheckpoint(env, runId, (d) => {
    d.completion = { test: "partial-blocked", report: "not-started", reasonCode: WALKS_BLOCKED };
    mod.checkpoint.setPhase(d, "extracting", "complete");
    mod.checkpoint.setPhase(d, "planning", "complete");
    mod.checkpoint.setPhase(d, "executing", "stopped", WALKS_BLOCKED);
    mod.checkpoint.setPhase(d, "verifying", "active");
  });
}

/** Silence the run: the reader's staleness gate is what licenses asking the engine. */
async function goQuiet(mod, env, runId, agoMs = 10 * 60 * 1000) {
  await env.EVIDENCE.put(
    mod.keys.heartbeatKey(runId),
    JSON.stringify({
      at: new Date(Date.now() - agoMs).toISOString(),
      note: "verifying observations",
      fingerprint: "verify",
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
}

const statusBody = async (mod, env, runId) =>
  (await mod.apiRuns.getStatus(new Request(`https://x/api/v2/runs/${runId}/status`), env, runId)).json();

suite("resource exhaustion has a name, and the run that hit it still says so", () => {
  test("the classifier names the ceiling — and still refuses to guess at anything else", async () => {
    const mod = await worker();
    const { classifyFailure } = mod.workflow;

    assertEq(
      classifyFailure(new Error(THE_CEILING)),
      SUBREQUEST_LIMIT_EXCEEDED,
      "the sentence the engine recorded four times must resolve to its own code, not to `workflow-error`",
    );
    assertEq(
      classifyFailure(new Error("Too many subrequests.")),
      SUBREQUEST_LIMIT_EXCEEDED,
      "the general ceiling is the same failure mode as the internal-services one",
    );
    assertEq(
      classifyFailure("too many api requests by single worker invocation"),
      SUBREQUEST_LIMIT_EXCEEDED,
      "the runtime's capitalisation is not ours to promise — the words are",
    );

    // THE OTHER HALF, which is the half a widening classifier quietly breaks: everything
    // nobody has classified stays `workflow-error`, on purpose.
    assertEq(classifyFailure(new Error("connection reset by peer")), null, "no guessing");
    assertEq(classifyFailure(new Error("too many requests")), null, "a rate-limited API is NOT the subrequest ceiling");
    assertEq(classifyFailure(new Error("")), null, "an empty throw is unclassified, not exhausted");
  });

  test("THE HEADLINE NAMES WHAT ENDED THE RUN — and the walk phase keeps its own fact", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });
    await seedTheIncident(mod, env, runId);

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    const step = hookedStep({ throwOn: { "resume-durable-state": new Error(THE_CEILING) } });
    await assertThrows(() => wf.run(RUN_PARAMS(runId), step), "Too many API requests");

    const cp = await load(mod, env, runId);

    // WHAT THE RUN PUBLISHED BEFORE THIS FIX: `partial-blocked` / `walks-blocked-by-site`,
    // because `partial-*` was treated as a settled ending and the reasonCode already on
    // file was treated as the answer.
    assertEq(cp.completion.test, "failed", "a run that died before verifying did not end partially — it died");
    assertEq(
      cp.completion.reasonCode,
      SUBREQUEST_LIMIT_EXCEEDED,
      "the headline must name the RUN-level cause, not a phase outcome from minutes earlier",
    );

    // AND NOTHING WAS TRADED AWAY FOR IT. Both facts are true and both are on file, in the
    // two places that own them.
    const executing = cp.phases.find((ph) => ph.name === "executing");
    assertEq(
      executing.reasonCode,
      WALKS_BLOCKED,
      "the site really did block those walks; overwriting that fact would be the same defect pointing the other way",
    );
    assertEq(executing.state, "stopped", "and the phase rail still says the walk phase stopped");

    const verifying = cp.phases.find((ph) => ph.name === "verifying");
    assertEq(verifying.state, "stopped", "the phase that was in flight is no longer claimed to be running");
    assertEq(verifying.reasonCode, SUBREQUEST_LIMIT_EXCEEDED, "and it says why it stopped");

    assertEq(cp.failure.step, "resume-durable-state", "the outer catch knows the step even when the body never ran");
    assertEq(cp.failure.reasonCode, SUBREQUEST_LIMIT_EXCEEDED);
  });

  test("A DELIBERATE ENDING IS NOT OVERWRITTEN by the crash that came after it", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });

    // A run that already stopped itself on purpose, named the reason, and then hit a fault
    // on the way out. The correction above must not reach back and rename this.
    await mod.checkpoint.updateCheckpoint(env, runId, (d) => {
      d.completion = { test: "failed", report: "not-started", reasonCode: "extraction-budget-exceeded" };
      mod.checkpoint.setPhase(d, "verifying", "active");
    });

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    await assertThrows(
      () => wf.run(RUN_PARAMS(runId), hookedStep({ throwOn: { "resume-durable-state": new Error(THE_CEILING) } })),
      "Too many API requests",
    );

    const cp = await load(mod, env, runId);
    assertEq(
      cp.completion.reasonCode,
      "extraction-budget-exceeded",
      "the run's own deliberate reason outranks the aftershock that followed it",
    );
    assertEq(cp.completion.test, "failed");
  });
});

suite("a cause must survive the failure that caused it", () => {
  test("THE INCIDENT, REPRODUCED: storage is gone, and the reader is STILL told what killed the run", async () => {
    const mod = await worker();
    const bucket = exhaustible();
    const env = testEnv({ EVIDENCE: bucket });
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });
    await seedTheIncident(mod, env, runId);

    // The budget runs out the moment the stage that spends it is entered — which is what
    // `verify-observations` did after re-reading and re-hashing every walk artifact.
    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    const step = hookedStep({
      throwOn: { "resume-durable-state": new Error(THE_CEILING) },
      onStep: { "resume-durable-state": () => bucket.exhaust() },
    });
    await assertThrows(() => wf.run(RUN_PARAMS(runId), step), "Too many API requests");

    // THE RUN GENUINELY COULD NOT WRITE ITS OWN CAUSE. This assertion is the point of the
    // fixture: if it ever fails, the bucket stopped simulating exhaustion and every
    // assertion below became a happy-path test again.
    bucket.restore();
    const stored = await load(mod, env, runId);
    assert(!stored.failure, "the durable record must still be empty — the write really was impossible");
    assertEq(stored.completion.reasonCode, WALKS_BLOCKED, "and the stale phase fact is still all it has");

    // AND YET THE READER IS ANSWERED. A status request is a different Worker invocation with
    // its own budget, and the Workflows engine kept the sentence the run could not store.
    env.V2_RUN_WORKFLOW = engineSaying("errored", THE_CEILING);
    await goQuiet(mod, env, runId);
    const body = await statusBody(mod, env, runId);

    assert(body.failure, "the status endpoint returned `failure: undefined` on the day this happened");
    assertEq(body.failure.reasonCode, SUBREQUEST_LIMIT_EXCEEDED, "the machine field a client branches on");
    assert(
      body.failure.message.includes("Too many API requests by single Worker invocation"),
      `the engine's own sentence must reach the reader, got: ${body.failure.message}`,
    );
    assertEq(body.failure.step, "phase:verifying", "the honest locator: the engine knows the instance, not the step");
    assert(body.error && body.error.includes("Too many API requests"), `and the prose field agrees: ${body.error}`);

    // The headline stops describing an unrelated event...
    assertEq(body.completion.test, "failed");
    assertEq(body.completion.reasonCode, SUBREQUEST_LIMIT_EXCEEDED);
    // ...without losing the one it used to describe.
    assertEq(
      body.phases.find((ph) => ph.name === "executing").reasonCode,
      WALKS_BLOCKED,
      "the walk-blocking fact is real and the user needs it",
    );

    // THE RUN RECORD ANSWERS THE SAME WAY. Two endpoints, one reconciliation.
    const summary = await (await mod.apiRuns.getRunSummary(new Request("https://x/"), env, runId)).json();
    assertEq(summary.failure.reasonCode, SUBREQUEST_LIMIT_EXCEEDED, "the run record must not disagree with the status");
    assertEq(summary.completion.reasonCode, SUBREQUEST_LIMIT_EXCEEDED);
  });

  test("RECORDING THAT FAILS DOES NOT CANCEL REPORTING — and it tries again past a sleep", async () => {
    const mod = await worker();
    const bucket = exhaustible();
    const env = testEnv({ EVIDENCE: bucket });
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });
    await seedTheIncident(mod, env, runId);

    // Exhausted at the crash, and restored when the workflow sleeps. THE SLEEP DOES NOT
    // PROVE ANYTHING ABOUT CLOUDFLARE — a hibernation MAY be re-invoked with a fresh
    // budget and the engine's own step record for this incident shows four retries that
    // plainly were not. What this proves is the WIRING: the failure path survives its own
    // recorder failing, asks again on the other side of the boundary, and still reports.
    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    const step = hookedStep({
      throwOn: { "resume-durable-state": new Error(THE_CEILING) },
      onStep: { "resume-durable-state": () => bucket.exhaust() },
      onSleep: () => bucket.restore(),
    });
    await assertThrows(() => wf.run(RUN_PARAMS(runId), step), "Too many API requests");

    assert(
      step.sleeps.some((s) => s.name === "failure-recording-cooldown"),
      `the failure path must pause before re-recording: ${JSON.stringify(step.sleeps)}`,
    );
    assert(
      step.calls.includes("record-failure-after-cooldown"),
      `the second attempt must be its own step: ${step.calls.join(", ")}`,
    );

    // THE CAUSE IS NOW DURABLE, from the run's own hand.
    const cp = await load(mod, env, runId);
    assert(cp.failure, "the retry past the boundary must land the cause the first attempt could not");
    assertEq(cp.failure.reasonCode, SUBREQUEST_LIMIT_EXCEEDED);
    assertEq(cp.completion.test, "failed");
    assertEq(cp.completion.reasonCode, SUBREQUEST_LIMIT_EXCEEDED);

    // AND THE RUN STILL REPORTS. On 8 August the engine's step list ended at
    // `record-failure-1`: the unguarded `await step.do("record-failure")` threw out of the
    // catch block and took reporting with it.
    assert(step.calls.includes("report"), `reporting must still be reached: ${step.calls.join(", ")}`);
    assert(step.calls.includes("finalize"), "and the run must still be finalized");
  });

  test("THE ENGINE IS NOT CONSULTED about a run that is alive and talking", async () => {
    const mod = await worker();
    const env = testEnv({ V2_RUN_WORKFLOW: engineThatMustNotBeAsked() });
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });
    await seedTheIncident(mod, env, runId);
    await goQuiet(mod, env, runId, 2_000); // beating two seconds ago

    // A binding call on every poll of every healthy run would be a cost with no reader.
    const body = await statusBody(mod, env, runId);
    assert(!body.failure, "a live run has no failure to report");
    assertEq(body.completion.test, "partial-blocked", "and its own state is left exactly as it wrote it");
    assertEq(body.completion.reasonCode, WALKS_BLOCKED);
  });

  test("A RUN THAT EXPLAINED ITSELF IS NEVER SECOND-GUESSED by the engine", async () => {
    const mod = await worker();
    const env = testEnv({ V2_RUN_WORKFLOW: engineThatMustNotBeAsked() });
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });
    await seedTheIncident(mod, env, runId);
    await mod.checkpoint.updateCheckpoint(env, runId, (d) => {
      d.failure = {
        step: "plan",
        reasonCode: "planning-refused",
        kind: "Error",
        message: THE_REAL_REFUSAL,
        at: "2026-08-08T00:47:00.000Z",
      };
    });
    await goQuiet(mod, env, runId);

    const body = await statusBody(mod, env, runId);
    assertEq(body.failure.reasonCode, "planning-refused", "the run's own diagnosis is the better one and it wins");
    assert(body.failure.message.includes(THE_FACET_ID), `got: ${body.failure.message}`);
  });

  test("AN ENGINE THAT SAYS `running` CHANGES NOTHING — silence is not a verdict", async () => {
    const mod = await worker();
    const env = testEnv({
      V2_RUN_WORKFLOW: {
        async get() { return { async status() { return { status: "running" }; } }; },
        async create() {},
      },
    });
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });
    await seedTheIncident(mod, env, runId);
    await goQuiet(mod, env, runId);

    // A quiet run is not a dead run, and a stalled-but-live instance must not be declared
    // failed by a reader. Only `errored`/`terminated` is a verdict.
    const body = await statusBody(mod, env, runId);
    assert(!body.failure, "a running instance has produced no cause to publish");
    assertEq(body.completion.test, "partial-blocked", "nothing is rewritten on the strength of a stale heartbeat");
  });

  test("AN ENGINE THAT HAS FORGOTTEN THE RUN degrades to silence, never to an error page", async () => {
    const mod = await worker();
    // `testEnv`'s default binding throws `instance.not_found` — the shape retention produces.
    const env = testEnv();
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });
    await seedTheIncident(mod, env, runId);
    await goQuiet(mod, env, runId);

    const res = await mod.apiRuns.getStatus(new Request(`https://x/api/v2/runs/${runId}/status`), env, runId);
    assertEq(res.status, 200, "a cause that cannot be recovered must not turn the status endpoint into a 500");
    const body = await res.json();
    assert(!body.failure, "and it must not invent one");
  });
});

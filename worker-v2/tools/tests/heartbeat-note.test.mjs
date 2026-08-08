/**
 * THE HEARTBEAT NOTE — the run's own words for what it is doing, reaching the client.
 *
 * The workflow already wrote ~20 granular notes across a run ("extract pass A wave 3
 * (whole-document / global rules)", "merging passes: source ledger, typed diff, floor
 * expansion"), and `readHeartbeat` already returned every one of them. `projectStatus`
 * took only the TIMESTAMP, so the note died at the projection: during the ~10-minute
 * extraction the rail read "Reading questionnaire · Running" and nothing moved, which on
 * a first real run is indistinguishable from hung.
 *
 * Tests 1 and 4 fail on the code as it was — the note was in neither the projection nor
 * the endpoint body.
 *
 * TEST 2 IS THE LOAD-BEARING ONE IN THE OTHER DIRECTION, and it is the reason the field is
 * omitted rather than nulled. The note is optional; a run that never wrote one must
 * serialize EXACTLY as it did before the field existed. If the projection emitted
 * `"heartbeatNote": null` on every run, every existing status body would change shape and
 * a client could start rendering an empty row where there had previously been nothing at
 * all. That test guards the key set AND its order, so a later field cannot slip in unseen.
 *
 * WHAT IS DELIBERATELY NOT TESTED HERE: any duration, ETA or percentage derived from the
 * note. Nothing derives one, because the server promises none — the note says what IS
 * happening, never how long is left.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { seedRun, testEnv, worker } from "./_helpers.mjs";

/**
 * The exact key set — and order — that run-status/2.0.0 carried BEFORE the note existed.
 * Written out by hand rather than derived from the projection, because a guard derived
 * from the thing it is guarding would silently absorb the next field added and could
 * never fail.
 */
const KEYS_BEFORE_THE_NOTE = [
  "schemaVersion",
  "runId",
  "phase",
  "phases",
  "completion",
  "heartbeatAt",
  "lastProgressAt",
  "progressRevision",
  "reportAvailable",
  "recoveryMode",
  "error",
];

const AT = "2026-08-08T00:00:00.000Z";
const A_REAL_NOTE = "extract pass A wave 3 (whole-document / global rules)";

async function checkpointFor(mod, env, opts = {}) {
  const seeded = await seedRun(mod, env, opts);
  const loaded = await mod.checkpoint.loadCheckpoint(env, seeded.runId);
  return { runId: seeded.runId, cp: loaded.checkpoint };
}

suite("the heartbeat note reaches the client", () => {
  test("the note travels through the status projection beside the timestamp", async () => {
    const mod = await worker();
    const env = testEnv();
    const { cp } = await checkpointFor(mod, env);

    const status = mod.contracts.projectStatus(cp, AT, A_REAL_NOTE);

    assertEq(status.heartbeatNote, A_REAL_NOTE, "the note the run wrote must survive the projection");
    // The note is ADDITIONAL to the check-in, never a replacement for it: a check-in proves
    // the process is alive, the note says what it is busy with, and they are two facts.
    assertEq(status.heartbeatAt, AT, "the timestamp still travels");
    assertEq(status.schemaVersion, "run-status/2.0.0", "an additive optional field is not a new schema");
  });

  test("a run with NO note serializes exactly as it did before the field existed", async () => {
    const mod = await worker();
    const env = testEnv();
    const { cp } = await checkpointFor(mod, env);

    // Called with the OLD two-argument signature, which must still compile and behave.
    const status = mod.contracts.projectStatus(cp, AT);

    assert(!("heartbeatNote" in status), "an absent note must be OMITTED, not present-and-null");
    assertEq(
      Object.keys(status).join(","),
      KEYS_BEFORE_THE_NOTE.join(","),
      "the key set and its order must be untouched for a run that never wrote a note",
    );
    assert(
      !JSON.stringify(status).includes("heartbeatNote"),
      "the bytes on the wire must not carry the field at all",
    );
  });

  test("an empty or whitespace-only note is not a note", async () => {
    const mod = await worker();
    const env = testEnv();
    const { cp } = await checkpointFor(mod, env);

    // Each of these would otherwise reach the tracker as a blank line implying the run is
    // doing nothing — a worse statement than the quiet-stage copy it would have displaced.
    for (const empty of [null, undefined, "", "   ", "\n\t "]) {
      const status = mod.contracts.projectStatus(cp, AT, empty);
      assert(
        !("heartbeatNote" in status),
        `an empty note (${JSON.stringify(empty)}) must not travel`,
      );
    }
  });

  test("a pathological note is bounded — a status line is not a log sink", async () => {
    const mod = await worker();
    const env = testEnv();
    const { cp } = await checkpointFor(mod, env);

    const status = mod.contracts.projectStatus(cp, AT, "x".repeat(5000));
    assert(
      typeof status.heartbeatNote === "string" && status.heartbeatNote.length <= 200,
      `an unbounded note reaches the browser: length ${status.heartbeatNote && status.heartbeatNote.length}`,
    );
  });

  test("THE ENDPOINT: the note the workflow beat comes back on /status", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await checkpointFor(mod, env, { testCompletion: "running" });

    // The real producer path — the same call the workflow makes between extraction waves.
    const beaten = "merging passes: source ledger, typed diff, floor expansion";
    await mod.checkpoint.beat(env, runId, beaten, "ledger");

    const res = await mod.apiRuns.getStatus(
      new Request(`https://x/api/v2/runs/${runId}/status`),
      env,
      runId,
    );
    assertEq(res.status, 200, "the status endpoint must answer");

    const body = await res.json();
    assertEq(body.heartbeatNote, beaten, "the endpoint must carry the note, not just the timestamp");
    assert(typeof body.heartbeatAt === "string", "the check-in timestamp is still its own fact");
  });

  test("THE ENDPOINT: a run that never checked in carries no note field", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await checkpointFor(mod, env, { testCompletion: "running" });

    const res = await mod.apiRuns.getStatus(
      new Request(`https://x/api/v2/runs/${runId}/status`),
      env,
      runId,
    );
    const body = await res.json();

    assert(!("heartbeatNote" in body), "no heartbeat written means no note field on the wire");
    assertEq(body.heartbeatAt, null, "and no check-in either — the two stay consistent");
  });
});

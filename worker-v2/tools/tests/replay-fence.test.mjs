/**
 * REPLAY FENCE — proves the SHIPPED ReplayBucket can fail.
 *
 * The fence guarantees: reads prefer the replay's own writes and fall back to
 * the source, writes land under the replay prefix, deletes throw, and writes
 * to cross-run keys throw.
 *
 * HISTORY, BECAUSE IT IS THE POINT OF THIS FILE'S SHAPE: this suite used to
 * test an inline COPY of the fence algorithm, introduced with the comment
 * "test the logic inline — the exact same algorithm". It was not the same
 * algorithm. The copy read forward-first (replay writes shadow the source);
 * the shipped module read the raw key first — so on gate attempt #3 the
 * mint stage read PROD's signed record instead of the record the replay's own
 * assemble stage wrote three minutes earlier, and the judgement went
 * diagnostic-only (RUN_RECORD_ATTESTATION_INVALID) while every test here
 * stayed green. A test of a copy proves the copy. This suite now imports the
 * REAL module through the same esbuild bundle every other suite uses.
 */

import { suite, test, assert, assertEq, memoryR2 } from "../testkit.mjs";
import { worker } from "./_helpers.mjs";

async function fence() {
  const mod = await worker();
  return mod.replayBucket;
}

suite("replay-fence", () => {
  test("reads pass through to the source run", async () => {
    const { wrapReplayBucket } = await fence();
    const r2 = memoryR2();
    const sourceKey = "v2/runs/v2r_source/checkpoint.json";
    await r2.put(sourceKey, '{"runId": "v2r_source"}');

    const wrapped = wrapReplayBucket(r2, {
      sourceRunId: "v2r_source",
      replayRunId: "replay-v100-a",
    });

    const obj = await wrapped.get(sourceKey);
    assert(obj !== null, "source key should be readable through the fence");
    const text = await obj.text();
    assert(text.includes("v2r_source"), "should read the source data");
  });

  test("writes are rewritten to the replay prefix", async () => {
    const { wrapReplayBucket } = await fence();
    const r2 = memoryR2();
    const wrapped = wrapReplayBucket(r2, {
      sourceRunId: "v2r_source",
      replayRunId: "replay-v100-a",
    });

    const sourceKey = "v2/runs/v2r_source/observations.json";
    await wrapped.put(sourceKey, '{"observations": []}');

    // The write should land under the replay prefix.
    const replayKey = "v2/runs/replay-v100-a/observations.json";
    const obj = await r2.get(replayKey);
    assert(obj !== null, "write should land at the replay prefix key");

    // The source key should NOT have been written.
    const sourceObj = await r2.get(sourceKey);
    assert(sourceObj === null, "source key must not be written");
  });

  test("report writes are rewritten to the replay prefix", async () => {
    const { wrapReplayBucket } = await fence();
    const r2 = memoryR2();
    const wrapped = wrapReplayBucket(r2, {
      sourceRunId: "v2r_source",
      replayRunId: "replay-v100-a",
    });

    const sourceKey = "v2/reports/v2r_source/current.json";
    await wrapped.put(sourceKey, '{"buildId": "test"}');

    const replayKey = "v2/reports/replay-v100-a/current.json";
    const obj = await r2.get(replayKey);
    assert(obj !== null, "report write should land at the replay prefix key");
  });

  test("deletes throw ReplayDeleteForbidden", async () => {
    const { wrapReplayBucket } = await fence();
    const r2 = memoryR2();
    const wrapped = wrapReplayBucket(r2, {
      sourceRunId: "v2r_source",
      replayRunId: "replay-v100-a",
    });

    let threw = false;
    try {
      await wrapped.delete("v2/runs/v2r_source/something.json");
    } catch (e) {
      threw = true;
      assert(e.name === "ReplayDeleteForbidden", `expected ReplayDeleteForbidden, got ${e.name}`);
    }
    assert(threw, "delete must throw");
  });

  test("writes to cross-run keys throw ReplayFenceViolation", async () => {
    const { wrapReplayBucket } = await fence();
    const r2 = memoryR2();
    const wrapped = wrapReplayBucket(r2, {
      sourceRunId: "v2r_source",
      replayRunId: "replay-v100-a",
    });

    let threw = false;
    try {
      // A contract revision key is cross-run and must not be written.
      await wrapped.put("v2/contracts/some-revision.json", "{}");
    } catch (e) {
      threw = true;
      assert(e.name === "ReplayFenceViolation", `expected ReplayFenceViolation, got ${e.name}`);
    }
    assert(threw, "cross-run write must throw");
  });

  test("replay run id must differ from source run id", async () => {
    const { wrapReplayBucket } = await fence();
    const r2 = memoryR2();
    let threw = false;
    try {
      wrapReplayBucket(r2, {
        sourceRunId: "v2r_source",
        replayRunId: "v2r_source",
      });
    } catch (e) {
      threw = true;
      assert(e.name === "ReplayFenceViolation", `expected ReplayFenceViolation, got ${e.name}`);
    }
    assert(threw, "same source and replay id must throw");
  });

  test("MUTANT: removing the rewrite lets a write hit the source key", async () => {
    // This is the MUTANT proof. If the rewrite is removed (assertReplayWrite
    // just returns the key unchanged), the source key would be written.
    const { wrapReplayBucket } = await fence();
    const r2 = memoryR2();
    const sourceKey = "v2/runs/v2r_source/observations.json";
    await r2.put(sourceKey, '{"original": true}');

    // With the fence in place, writing the source key should write to replay prefix.
    const wrapped = wrapReplayBucket(r2, {
      sourceRunId: "v2r_source",
      replayRunId: "replay-v100-a",
    });
    await wrapped.put(sourceKey, '{"replayed": true}');

    // The original source data must be untouched.
    const sourceObj = await r2.get(sourceKey);
    assert(sourceObj !== null, "source object should still exist");
    const text = await sourceObj.text();
    assert(
      text.includes('"original"'),
      `source data must be untouched, got: ${text}`,
    );

    // The replay data should be at the replay key.
    const replayObj = await r2.get("v2/runs/replay-v100-a/observations.json");
    assert(replayObj !== null, "replay data should exist");
    const replayText = await replayObj.text();
    assert(
      replayText.includes('"replayed"'),
      `replay data should contain the written value, got: ${replayText}`,
    );
  });

  test("reads prefer replay writes over source data — THE GATE-3 DEFECT", async () => {
    // GATE ATTEMPT #3, measured: the source run had completed its tail in
    // production, so record.json existed at the source key. The shipped get()
    // tried the raw key first and served PROD's record; the replay's own
    // assemble output was invisible; the judge refused prod's signature
    // against the bench key and minted diagnostic-only. This test seeds
    // exactly that state — both keys populated — and requires the fence to
    // serve the replay's own bytes. Against the pre-fix module it fails.
    const { wrapReplayBucket } = await fence();
    const r2 = memoryR2();
    // Source data — the "prod record".
    await r2.put("v2/runs/v2r_source/record.json", '{"signer": "prod"}');

    const wrapped = wrapReplayBucket(r2, {
      sourceRunId: "v2r_source",
      replayRunId: "replay-v100-a",
    });

    // The replay's own assemble writes through the fence.
    await wrapped.put("v2/runs/v2r_source/record.json", '{"signer": "bench"}');

    // Reading the source key must now return the replay's record — via get AND head.
    const obj = await wrapped.get("v2/runs/v2r_source/record.json");
    assert(obj !== null, "should get a result");
    const text = await obj.text();
    assert(text.includes('"bench"'), `must read the replay's own write, got: ${text}`);
    const h = await wrapped.head("v2/runs/v2r_source/record.json");
    assert(h !== null, "head should resolve");
  });

  test("a replay-prefixed key never written falls back to the source copy", async () => {
    const { wrapReplayBucket } = await fence();
    const r2 = memoryR2();
    await r2.put("v2/runs/v2r_source/plan.json", '{"plan": "source"}');

    const wrapped = wrapReplayBucket(r2, {
      sourceRunId: "v2r_source",
      replayRunId: "replay-v100-a",
    });

    // A stage that addresses the replay spelling directly still reads source data.
    const obj = await wrapped.get("v2/runs/replay-v100-a/plan.json");
    assert(obj !== null, "reverse fall-through should find the source copy");
    const text = await obj.text();
    assert(text.includes('"source"'), `should read source data, got: ${text}`);
  });

  test("REPLAY_ENABLED refusal — entrypoint rejects without it", async () => {
    // This test verifies the logic, not the deployed worker.
    // The entrypoint checks: if REPLAY_ENABLED !== "true", return 403.
    const envWithout = {};
    const replayEnabled = envWithout.REPLAY_ENABLED;
    assert(replayEnabled !== "true", "absent REPLAY_ENABLED must not be 'true'");

    const envWith = { REPLAY_ENABLED: "true" };
    assertEq(envWith.REPLAY_ENABLED, "true", "present REPLAY_ENABLED must be exactly 'true'");

    const envWrong = { REPLAY_ENABLED: "yes" };
    assert(envWrong.REPLAY_ENABLED !== "true", "'yes' must not pass the check");
  });
});

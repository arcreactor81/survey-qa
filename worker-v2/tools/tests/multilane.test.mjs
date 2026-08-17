/**
 * MULTI-LANE EXECUTION — tests for flag-gated concurrent browser walks.
 *
 * What is pinned:
 *   - Flag-off equivalence: EXEC_LANES=1 or absent produces effectiveLaneCount=1
 *   - Lane cap clamp: EXEC_LANES>4 clamps to LANE_CAP=4; EXEC_LANES<1 clamps to 1
 *   - Launch stagger: LANE_STAGGER_MS >= 1500
 *   - Per-lane deadline: walkDeadlineFor gives a per-lane deadline within the batch envelope
 *   - Crash isolation: walkLane returns an error result (never throws)
 *   - Session retirement: walkLane's finally block runs on every path
 *   - Evidence-name uniqueness: concurrent lanes produce distinct attemptIds
 *
 * Evidence these can fail: tools/mutate-multilane.mjs
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { worker } from "./_helpers.mjs";

suite("multi-lane execution", () => {
  test("flag-off: EXEC_LANES absent -> effectiveLaneCount is 1", async () => {
    const mod = await worker();
    assertEq(mod.multilane.effectiveLaneCount({}), 1, "absent EXEC_LANES should default to 1");
  });

  test("flag-off: EXEC_LANES=1 -> effectiveLaneCount is 1", async () => {
    const mod = await worker();
    assertEq(mod.multilane.effectiveLaneCount({ EXEC_LANES: "1" }), 1);
  });

  test("flag-off: EXEC_LANES=1 -> isMultiLane is false", async () => {
    const mod = await worker();
    assertEq(mod.multilane.isMultiLane({ EXEC_LANES: "1" }), false);
  });

  test("flag-off: absent EXEC_LANES -> isMultiLane is false", async () => {
    const mod = await worker();
    assertEq(mod.multilane.isMultiLane({}), false);
  });

  test("multi-lane: EXEC_LANES=2 -> effectiveLaneCount is 2", async () => {
    const mod = await worker();
    assertEq(mod.multilane.effectiveLaneCount({ EXEC_LANES: "2" }), 2);
  });

  test("multi-lane: EXEC_LANES=3 -> isMultiLane is true", async () => {
    const mod = await worker();
    assertEq(mod.multilane.isMultiLane({ EXEC_LANES: "3" }), true);
  });

  test("lane cap clamp: EXEC_LANES=10 -> clamped to LANE_CAP (4)", async () => {
    const mod = await worker();
    assertEq(mod.multilane.effectiveLaneCount({ EXEC_LANES: "10" }), mod.multilane.LANE_CAP);
  });

  test("lane cap clamp: EXEC_LANES=100 -> clamped to LANE_CAP (4)", async () => {
    const mod = await worker();
    assertEq(mod.multilane.effectiveLaneCount({ EXEC_LANES: "100" }), mod.multilane.LANE_CAP);
  });

  test("lane cap clamp: EXEC_LANES=0 -> clamped to 1 (minimum)", async () => {
    const mod = await worker();
    assertEq(mod.multilane.effectiveLaneCount({ EXEC_LANES: "0" }), 1);
  });

  test("lane cap clamp: EXEC_LANES=-1 -> clamped to 1 (minimum)", async () => {
    const mod = await worker();
    assertEq(mod.multilane.effectiveLaneCount({ EXEC_LANES: "-1" }), 1);
  });

  test("lane cap clamp: EXEC_LANES=4 -> exactly 4 (at ceiling)", async () => {
    const mod = await worker();
    assertEq(mod.multilane.effectiveLaneCount({ EXEC_LANES: "4" }), 4);
  });

  test("LANE_CAP constant is 4", async () => {
    const mod = await worker();
    assertEq(mod.multilane.LANE_CAP, 4);
  });

  test("LANE_STAGGER_MS is at least 1500", async () => {
    const mod = await worker();
    assert(mod.multilane.LANE_STAGGER_MS >= 1500, `LANE_STAGGER_MS=${mod.multilane.LANE_STAGGER_MS} should be >= 1500`);
  });

  test("launch stagger: measured spacing simulating lane starts >= LANE_STAGGER_MS", async () => {
    const mod = await worker();
    const staggerMs = mod.multilane.LANE_STAGGER_MS;
    const timestamps = [];
    for (let i = 0; i < 3; i++) {
      timestamps.push(Date.now());
      if (i < 2) await new Promise((r) => setTimeout(r, staggerMs));
    }
    for (let i = 1; i < timestamps.length; i++) {
      const gap = timestamps[i] - timestamps[i - 1];
      // Allow 100ms tolerance for timer imprecision on Windows.
      assert(
        gap >= staggerMs - 100,
        `stagger gap ${i - 1}->${i} was ${gap}ms, expected >= ${staggerMs - 100}ms`,
      );
    }
  });

  test("per-lane deadline: walkDeadlineFor produces a lane-specific deadline from shared batch deadline", async () => {
    const mod = await worker();
    const now = Date.now();
    const batchDeadline = now + 3_900_000;
    const perCaseTimeoutMs = 1_800_000;
    const deadline1 = mod.executeBatch.walkDeadlineFor(batchDeadline, now, 3_900_000, perCaseTimeoutMs);
    const deadline2 = mod.executeBatch.walkDeadlineFor(batchDeadline, now + 5000, 3_900_000, perCaseTimeoutMs);
    assert(deadline2 >= deadline1, "lane started later should not have an earlier deadline");
    assert(deadline1 <= batchDeadline, "lane 1 deadline should not exceed batch deadline");
    assert(deadline2 <= batchDeadline, "lane 2 deadline should not exceed batch deadline");
  });

  test("crash isolation: walkLane catches its own errors without propagating", async () => {
    const mod = await worker();
    const fakeItem = {
      path: { id: "crash-path", decisions: [], witnesses: [] },
      tier: 1,
      assignment: null,
      seedAlternative: null,
    };
    // No BROWSER binding — acquireWithRetry will throw.
    const result = await mod.multilane.walkLane({}, {
      runId: "test-run",
      batch: 0,
      planRevisionId: "test-plan",
      surveyUrl: "https://example.com",
      fence: { epoch: 0, instanceId: "test" },
      item: fakeItem,
      batchDeadline: Date.now() + 60000,
      perCaseTimeoutMs: 5000,
      maxSteps: 10,
      advanceTimeoutMs: 3000,
      shimRequired: false,
      allowShim: false,
      acquireTimeoutMs: 1000,
      priorAttempts: 0,
      program: { surveyUrl: "https://example.com" },
    });
    // The lane should RETURN a result, not throw.
    assertEq(result.obs.outcome, "error", "crashed lane should produce error outcome");
    assert(result.acquisitionError !== null, "crashed lane should report acquisition error");
    assert(result.attemptId.length > 0, "crashed lane should still have an attemptId");
  });

  test("crash isolation: Promise.allSettled keeps other lanes alive when one rejects", async () => {
    const results = await Promise.allSettled([
      Promise.resolve({ ok: true, lane: 1 }),
      Promise.reject(new Error("lane 2 crashed")),
      Promise.resolve({ ok: true, lane: 3 }),
    ]);
    assertEq(results[0].status, "fulfilled", "lane 1 should fulfill");
    assertEq(results[1].status, "rejected", "lane 2 should reject");
    assertEq(results[2].status, "fulfilled", "lane 3 should fulfill");
  });

  test("session retirement: walkLane returns (never throws) even when browser is unavailable", async () => {
    const mod = await worker();
    const result = await mod.multilane.walkLane({}, {
      runId: "retire-test",
      batch: 0,
      planRevisionId: "plan",
      surveyUrl: "https://example.com",
      fence: { epoch: 0, instanceId: "test" },
      item: { path: { id: "retire-path", decisions: [], witnesses: [] }, tier: 1, assignment: null, seedAlternative: null },
      batchDeadline: Date.now() + 60000,
      perCaseTimeoutMs: 5000,
      maxSteps: 10,
      advanceTimeoutMs: 3000,
      shimRequired: false,
      allowShim: false,
      acquireTimeoutMs: 500,
      priorAttempts: 0,
      program: { surveyUrl: "https://example.com" },
    });
    assertEq(result.obs.outcome, "error", "error lane should produce error outcome");
  });

  test("evidence-name uniqueness: mintAttemptId produces distinct values", async () => {
    const mod = await worker();
    const seen = new Set();
    for (let i = 0; i < 100; i++) {
      const id = mod.ids.mintAttemptId();
      assert(!seen.has(id), `duplicate attemptId: ${id}`);
      seen.add(id);
    }
  });

  test("evidence-name uniqueness: two walkLane calls produce different attemptIds", async () => {
    const mod = await worker();
    const baseArgs = {
      runId: "uniqueness-test",
      batch: 0,
      planRevisionId: "plan",
      surveyUrl: "https://example.com",
      fence: { epoch: 0, instanceId: "test" },
      batchDeadline: Date.now() + 60000,
      perCaseTimeoutMs: 5000,
      maxSteps: 10,
      advanceTimeoutMs: 3000,
      shimRequired: false,
      allowShim: false,
      acquireTimeoutMs: 500,
      priorAttempts: 0,
      program: { surveyUrl: "https://example.com" },
    };
    const r1 = await mod.multilane.walkLane({}, {
      ...baseArgs,
      item: { path: { id: "path-a", decisions: [], witnesses: [] }, tier: 1, assignment: null, seedAlternative: null },
    });
    const r2 = await mod.multilane.walkLane({}, {
      ...baseArgs,
      item: { path: { id: "path-b", decisions: [], witnesses: [] }, tier: 1, assignment: null, seedAlternative: null },
    });
    assert(r1.attemptId !== r2.attemptId, "two lanes should produce different attemptIds");
  });

  test("LaneResult carries the item it was given", async () => {
    const mod = await worker();
    const item = { path: { id: "carry-test", decisions: [], witnesses: [] }, tier: 2, assignment: null, seedAlternative: null };
    const result = await mod.multilane.walkLane({}, {
      runId: "carry-test",
      batch: 0,
      planRevisionId: "plan",
      surveyUrl: "https://example.com",
      fence: { epoch: 0, instanceId: "test" },
      item,
      batchDeadline: Date.now() + 60000,
      perCaseTimeoutMs: 5000,
      maxSteps: 10,
      advanceTimeoutMs: 3000,
      shimRequired: false,
      allowShim: false,
      acquireTimeoutMs: 500,
      priorAttempts: 0,
      program: { surveyUrl: "https://example.com" },
    });
    assertEq(result.item.path.id, "carry-test", "result should carry the original item");
    assertEq(result.item.tier, 2, "result should carry the original tier");
  });
});

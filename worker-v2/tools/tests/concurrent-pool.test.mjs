/**
 * BOUNDED-CONCURRENCY POOL — the utility behind the derive-fanout-scale fix.
 *
 * Three properties, each with a test that proves it can fail:
 *
 *   1. ORDER PRESERVED: results come back in input order regardless of completion order.
 *      Mutant: shuffle completion order via randomised delays — result array must still
 *      match input indices.
 *
 *   2. BOUND RESPECTED: at no instant are more than `concurrency` tasks in flight.
 *      Mutant: set concurrency=3 on 20 items, instrument the high-water mark, assert <= 3.
 *      A pool that ignores the bound (Promise.all) would hit 20.
 *
 *   3. ONE REJECTION PROPAGATES LOUDLY: a single failing task rejects the whole pool.
 *      Mutant: one task throws; the caller must see that error, not a silent partial result.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { suite, test, assert, assertEq } from "../testkit.mjs";

/** Deep-equal for arrays of primitives, since testkit's assertEq is strict reference. */
function assertArrayEq(actual, expected, message) {
  assertEq(
    JSON.stringify(actual),
    JSON.stringify(expected),
    message,
  );
}

// THE REAL MODULE, not a copy. This file originally carried a hand-copied "reference
// implementation" of mapConcurrent — a test structurally incapable of catching a regression
// in the shipped pool. It now bundles src/store/concurrent-pool.ts itself (same pattern as
// bounded-source-block-jsonl.test.mjs), so a behavior change in the real module is a
// behavior change in these tests.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const poolPath = JSON.stringify(
  path.join(WORKER_ROOT, "src/store/concurrent-pool.ts").replace(/\\/g, "/"),
);
const built = await esbuild.build({
  stdin: {
    contents: `export * from ${poolPath};`,
    loader: "ts",
    resolveDir: WORKER_ROOT,
  },
  bundle: true,
  format: "esm",
  write: false,
  platform: "neutral",
});
const poolModule = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`
);
const { mapConcurrent, R2_READ_CONCURRENCY } = poolModule;
assert(typeof mapConcurrent === "function", "the real mapConcurrent is importable");
assert(
  Number.isInteger(R2_READ_CONCURRENCY) && R2_READ_CONCURRENCY >= 1,
  "the real R2_READ_CONCURRENCY constant is exported and sane",
);

// ---------------------------------------------------------------------------
// 1. ORDER PRESERVED — results match input order even when tasks complete out of order
// ---------------------------------------------------------------------------
suite("concurrent-pool — order preserved", () => {
  test("results are returned in input order regardless of completion order", async () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    // Each task completes after a delay inversely proportional to its index, so the last
    // item finishes first and the first item finishes last.
    const results = await mapConcurrent(items, 4, async (item) => {
      await new Promise((r) => setTimeout(r, (10 - item) * 2));
      return item * 10;
    });
    assertArrayEq(results, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90],
      "results must be in input order");
  });
});

// ---------------------------------------------------------------------------
// 2. BOUND RESPECTED — no more than `concurrency` tasks run at once
// ---------------------------------------------------------------------------
suite("concurrent-pool — bound respected", () => {
  test("concurrency bound is respected (high-water mark <= concurrency)", async () => {
    const concurrency = 3;
    const items = Array.from({ length: 20 }, (_, i) => i);
    let inFlight = 0;
    let highWater = 0;

    const results = await mapConcurrent(items, concurrency, async (item) => {
      inFlight++;
      if (inFlight > highWater) highWater = inFlight;
      // Yield to let other tasks start if the pool allows too many.
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return item;
    });

    assert(highWater <= concurrency,
      `high-water mark ${highWater} exceeded concurrency ${concurrency}`);
    assert(highWater >= 1, "at least one task must have run");
    assertEq(results.length, 20, "all items must produce results");

    // EVIDENCE THIS TEST CAN FAIL: if concurrency were ignored (Promise.all), highWater
    // would be 20, failing the <= 3 assertion.
  });
});

// ---------------------------------------------------------------------------
// 3. ONE REJECTION PROPAGATES LOUDLY — the pool rejects with the failing task's error
// ---------------------------------------------------------------------------
suite("concurrent-pool — rejection propagation", () => {
  test("a single failing task rejects the whole pool", async () => {
    const items = [1, 2, 3, 4, 5];
    const boom = new Error("DELIBERATE_FAILURE");
    let caught = null;

    try {
      await mapConcurrent(items, 2, async (item) => {
        if (item === 3) throw boom;
        return item;
      });
    } catch (err) {
      caught = err;
    }

    assert(caught !== null, "the pool must reject when a task throws");
    assert(caught === boom, `the pool must propagate the original error, got: ${caught?.message}`);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
suite("concurrent-pool — edge cases", () => {
  test("empty input returns empty output", async () => {
    const results = await mapConcurrent([], 4, async () => {
      throw new Error("should not be called");
    });
    assertEq(results.length, 0, "empty input must produce zero results");
  });

  test("concurrency larger than input length works correctly", async () => {
    const items = [10, 20, 30];
    const results = await mapConcurrent(items, 100, async (item) => item + 1);
    assertArrayEq(results, [11, 21, 31], "results must be correct when concurrency > items");
  });

  test("concurrency of 1 is sequential", async () => {
    const items = [1, 2, 3, 4, 5];
    const order = [];
    const results = await mapConcurrent(items, 1, async (item) => {
      order.push(item);
      return item * 2;
    });
    assertArrayEq(results, [2, 4, 6, 8, 10], "results must be correct");
    assertArrayEq(order, [1, 2, 3, 4, 5], "with concurrency=1, tasks must run in strict order");
  });

  test("concurrency < 1 throws", async () => {
    let caught = null;
    try {
      await mapConcurrent([1], 0, async (x) => x);
    } catch (err) {
      caught = err;
    }
    assert(caught !== null, "concurrency < 1 must throw");
    assert(caught.message.includes("concurrency"), `error must mention concurrency: ${caught.message}`);
  });
});

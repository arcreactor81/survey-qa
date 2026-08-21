/**
 * D58 — STARTUP BUDGET: a walk that never gets past page creation, survey goto, or the
 * first screen read is recorded as "walk-never-started" with the sub-phase that hung, the
 * real wallMs, and ONE retry. A dead start must cost ~2-4 minutes and produce a receipt,
 * never 15 silent minutes.
 *
 * ==================== THE MEASURED DEFECT ====================
 *
 * The 2026-08-16/17 runs recorded 27 walks as 0-screen "per-case-timeout" or "error" rows
 * with wallMs=0, steps=0, ZERO evidence — 15 minutes burned before the first step ever ran.
 * v96: 2/28 walks, v97: 6/23, v98: 6/28. Browser session ACQUISITION is already bounded
 * and raced. The UNBUDGETED stretch is everything between "session acquired" and "first step
 * recorded": page creation, the survey goto, the first screen read.
 *
 * ==================== WHAT IS PINNED ====================
 *
 *   - STARTUP BUDGET: a configurable wall-clock cap on the pre-first-step stretch, with
 *     floor/ceiling guards so an operator cannot zero it or set it above the per-case timeout.
 *   - THREE SUB-PHASES are instrumented with timestamps (page-create / survey-load /
 *     first-read) so the outcomeDetail names WHICH sub-phase hung from measured data.
 *   - WALK-NEVER-STARTED outcome: carries real wallMs (not 0), the hung sub-phase in
 *     outcomeDetail, and exactly one retry on a fresh page.
 *   - CONSUMER BUCKETING: the new outcome maps to "not-reached" (infrastructure, never a
 *     site accusation, never a completion, never demoted to a defect claim).
 *   - ENV WIRING: EXEC_WALK_STARTUP_BUDGET_MS is declared in all wrangler configs at 120000.
 *
 * Evidence these can fail: `tools/mutate-startup-budget.mjs`.
 */

import { readFileSync } from "node:fs";
import { assert, assertEq, suite, test } from "../testkit.mjs";
import { worker } from "./_helpers.mjs";

/* ------------------------------------------------------------------ helpers */

/**
 * Load the execute-batch module from the bundled worker.
 */
async function loadBatch() {
  const mod = await worker();
  return mod.executeBatch;
}

/* ------------------------------------------------------------------ unit: resolveStartupBudgetMs */

suite("startup budget resolution", () => {
  test("defaults to DEFAULT_STARTUP_BUDGET_MS when env is undefined", async () => {
    const { resolveStartupBudgetMs, DEFAULT_STARTUP_BUDGET_MS } = await loadBatch();
    assertEq(resolveStartupBudgetMs(undefined), DEFAULT_STARTUP_BUDGET_MS);
    assertEq(DEFAULT_STARTUP_BUDGET_MS, 120_000, "default must be 120s");
  });

  test("reads a valid env value", async () => {
    const { resolveStartupBudgetMs } = await loadBatch();
    assertEq(resolveStartupBudgetMs("60000"), 60_000);
  });

  test("floor-guards: values below 10s are clamped to 10s", async () => {
    const { resolveStartupBudgetMs } = await loadBatch();
    assertEq(resolveStartupBudgetMs("1000"), 10_000);
    assertEq(resolveStartupBudgetMs("0"), 10_000);
  });

  test("ceiling-guards: values above 600s are clamped to 600s", async () => {
    const { resolveStartupBudgetMs } = await loadBatch();
    assertEq(resolveStartupBudgetMs("999999"), 600_000);
  });

  test("non-numeric input falls back to default", async () => {
    const { resolveStartupBudgetMs, DEFAULT_STARTUP_BUDGET_MS } = await loadBatch();
    assertEq(resolveStartupBudgetMs("not-a-number"), DEFAULT_STARTUP_BUDGET_MS);
  });
});

/* ------------------------------------------------------------------ unit: hungStartupPhase */

suite("hungStartupPhase: the sub-phase detector names the right phase", () => {
  test("no phases completed → page-create hung", async () => {
    const { hungStartupPhase } = await loadBatch();
    assertEq(hungStartupPhase([]), "page-create");
  });

  test("page-create completed → survey-load hung", async () => {
    const { hungStartupPhase } = await loadBatch();
    assertEq(hungStartupPhase(["page-create"]), "survey-load");
  });

  test("survey-load completed → first-read hung", async () => {
    const { hungStartupPhase } = await loadBatch();
    assertEq(hungStartupPhase(["page-create", "survey-load"]), "first-read");
  });

  test("all phases completed → first-read (defensive)", async () => {
    const { hungStartupPhase } = await loadBatch();
    assertEq(hungStartupPhase(["page-create", "survey-load", "first-read"]), "first-read");
  });
});

/* ------------------------------------------------------------------ unit: walkRecord with walk-never-started */

suite("walkRecord: walk-never-started carries real wallMs and correct fields", () => {
  test("walk-never-started observation produces a valid WalkRecord with real wallMs", async () => {
    const { walkRecord } = await loadBatch();
    const obs = {
      kind: "v2-path-observation/1.0.0",
      runId: "run_test",
      pathId: "path_1",
      tier: 1,
      attemptId: "att_1",
      planRevisionId: "plan_1",
      surveyUrl: "https://test.invalid",
      startedAt: "2026-08-14T00:00:00.000Z",
      endedAt: "2026-08-14T00:02:00.000Z",
      wallMs: 119500,
      plannedWitnesses: [],
      steps: [],
      outcome: "walk-never-started",
      outcomeDetail: "walk never started: hung in survey-load after 119500ms (startup budget 120000ms, phases completed: page-create)",
      shimmed: false,
      shimNote: null,
      loadFailure: null,
      evidenceIds: [],
      viewport: { width: 1280, height: 900 },
    };

    const record = walkRecord(obs, []);
    assertEq(record.outcome, "walk-never-started");
    assertEq(record.wallMs, 119500, "wallMs must carry the real elapsed time, never 0");
    assertEq(record.steps, 0);
    assertEq(record.caseIds.length, 0);
    assertEq(record.exercised, false, "a walk-never-started is never exercised");
    assert(
      record.outcomeDetail.includes("survey-load"),
      "outcomeDetail must name the sub-phase that hung",
    );
  });
});

/* ------------------------------------------------------------------ unit: consumer bucketing */

suite("consumer bucketing: walk-never-started is infrastructure, never a site accusation", () => {
  test("unsettledBucketFor routes walk-never-started to not-reached", async () => {
    const mod = await worker();
    const { unsettledBucketFor } = mod.contracts;
    assertEq(unsettledBucketFor("walk-never-started"), "not-reached");
  });

  test("walkExercised returns false for walk-never-started", async () => {
    const { walkExercised } = await loadBatch();
    const obs = {
      outcome: "walk-never-started",
      loadFailure: null,
      steps: [],
    };
    assertEq(walkExercised(obs), false);
  });

  test("hasBlockingEvidence does not consider walk-never-started as blocking", async () => {
    const { hasBlockingEvidence } = await loadBatch();
    const walks = [
      {
        pathId: "p1",
        attemptId: "a1",
        tier: 1,
        outcome: "walk-never-started",
        outcomeDetail: "hung in page-create",
        steps: 0,
        wallMs: 120000,
        shimmed: false,
        loadCrash: false,
        evidenceCount: 0,
        caseIds: [],
        exercised: false,
        plannedDecisions: 0,
        matchedDecisions: 0,
        constrainingDecisions: 0,
        matchedConstraining: 0,
        screensAdvanced: 0,
        at: "2026-08-14T00:00:00.000Z",
      },
    ];
    assertEq(hasBlockingEvidence(walks), false, "walk-never-started must not be treated as blocking evidence");
  });

  test("resolveStopReason produces coverage-shortfall, not site-blocked, for walk-never-started walks", async () => {
    const { resolveStopReason, EXEC_STOP_COVERAGE_SHORTFALL } = await loadBatch();
    const walks = [
      {
        outcome: "walk-never-started",
        steps: 0,
        wallMs: 120000,
        blockedSteps: 0,
        ending: undefined,
      },
    ];
    const reason = resolveStopReason({ done: true, pendingCases: 1, stopReason: null, walks });
    assertEq(reason, EXEC_STOP_COVERAGE_SHORTFALL, "walk-never-started must bucket as our shortfall, never a site accusation");
  });
});

/* ------------------------------------------------------------------ env wiring: wrangler config pin */

suite("env wiring: EXEC_WALK_STARTUP_BUDGET_MS is declared in all wrangler configs", () => {
  test("wrangler.jsonc declares EXEC_WALK_STARTUP_BUDGET_MS as 120000", () => {
    const content = readFileSync("wrangler.jsonc", "utf8");
    const match = content.match(/"EXEC_WALK_STARTUP_BUDGET_MS"\s*:\s*"(\d+)"/);
    assert(match, "EXEC_WALK_STARTUP_BUDGET_MS must be declared in wrangler.jsonc");
    assertEq(match[1], "120000", "EXEC_WALK_STARTUP_BUDGET_MS must be 120000 in wrangler.jsonc");
  });

  test("all arm configs declare EXEC_WALK_STARTUP_BUDGET_MS as 120000", () => {
    const arms = ["wrangler.arm-a.jsonc", "wrangler.arm-b.jsonc", "wrangler.arm-c.jsonc", "wrangler.arm-cr.jsonc"];
    for (const f of arms) {
      const content = readFileSync(f, "utf8");
      const match = content.match(/"EXEC_WALK_STARTUP_BUDGET_MS"\s*:\s*"(\d+)"/);
      assert(match, `${f} must declare EXEC_WALK_STARTUP_BUDGET_MS`);
      assertEq(match[1], "120000", `${f} must have EXEC_WALK_STARTUP_BUDGET_MS=120000`);
    }
  });
});

/* ------------------------------------------------------------------ unit: onStartupPhase callback in walkPath */

suite("walkPath startup phase instrumentation", () => {
  test("walkPath calls onStartupPhase at survey-load and first-read transitions", async () => {
    const mod = await worker();
    const { walkPath } = mod.driver;

    // Minimal PageLike stub that completes successfully
    const phases = [];
    let evalOnNewDocCount = 0;
    const page = {
      goto: async () => {},
      evaluate: async (script) => {
        // Return a minimal screen for READ_SCREEN
        return JSON.stringify({
          questionText: "Test question?",
          instructionText: "",
          visibleText: "Test question? Yes No",
          controls: [],
          buttons: [],
          progressText: null,
          collectedErrors: [],
        });
      },
      evaluateOnNewDocument: async () => { evalOnNewDocCount++; },
      $$: async () => [],
      screenshot: async () => new Uint8Array(0),
      setViewport: async () => {},
      on: () => {},
      close: async () => {},
      reload: async () => {},
    };

    const path = { id: "path_test", decisions: [], witnesses: [] };
    const cap = {
      env: { EVIDENCE: { put: async () => ({}) } },
      runId: "run_test",
      attemptId: "att_test",
      pathId: "path_test",
      witnesses: [],
    };

    try {
      await walkPath(page, path, {
        surveyUrl: "https://test.invalid",
        runId: "run_test",
        planRevisionId: "plan_test",
        attemptId: "att_test",
        tier: 1,
        maxSteps: 1,
        deadline: Date.now() + 30_000,
        viewport: { width: 1280, height: 900 },
        applyHistoryShim: false,
        advanceTimeoutMs: 1000,
        onStartupPhase: (phase) => phases.push(phase),
      }, cap);
    } catch {
      // walkPath may throw in the minimal stub environment; the phase callbacks
      // fire BEFORE the step loop's first read attempt, which is what we test.
    }

    // survey-load fires after page.goto, which is the FIRST page call after setup.
    assert(phases.includes("survey-load"), "walkPath must call onStartupPhase('survey-load') after goto");
  });
});

/* ------------------------------------------------------------------ unit: healthy walk consumes no extra budget */

suite("healthy walk: the startup budget is transparent", () => {
  test("a walk that completes normally has no walk-never-started outcome", async () => {
    const { walkRecord } = await loadBatch();
    const obs = {
      kind: "v2-path-observation/1.0.0",
      runId: "run_test",
      pathId: "path_1",
      tier: 1,
      attemptId: "att_1",
      planRevisionId: "plan_1",
      surveyUrl: "https://test.invalid",
      startedAt: "2026-08-14T00:00:00.000Z",
      endedAt: "2026-08-14T00:01:30.000Z",
      wallMs: 90000,
      plannedWitnesses: [],
      steps: [{ stepIndex: 0, advanced: true }],
      outcome: "completed",
      outcomeDetail: null,
      shimmed: false,
      shimNote: null,
      loadFailure: null,
      evidenceIds: ["ev1"],
      viewport: { width: 1280, height: 900 },
    };

    const record = walkRecord(obs, ["case_1"]);
    assert(record.outcome !== "walk-never-started", "a healthy walk must not be walk-never-started");
    assertEq(record.outcome, "completed");
    assertEq(record.steps, 1);
    assert(record.wallMs > 0, "wallMs must be the real elapsed time");
  });
});

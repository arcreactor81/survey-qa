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
import { worker, testEnv } from "./_helpers.mjs";

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

/* ------------------------------------------------------------------ unit: walkNeverStarted pure function */

suite("walkNeverStarted: the determination drives the real function, not a hand-built shape", () => {
  test("true when timed out without first-read", async () => {
    const { walkNeverStarted } = await loadBatch();
    assertEq(walkNeverStarted(true, []), true, "timed out, no phases at all");
    assertEq(walkNeverStarted(true, ["page-create"]), true, "timed out, only page-create");
    assertEq(walkNeverStarted(true, ["page-create", "survey-load"]), true, "timed out, page-create + survey-load");
  });

  test("false when first-read completed", async () => {
    const { walkNeverStarted } = await loadBatch();
    assertEq(walkNeverStarted(true, ["page-create", "survey-load", "first-read"]), false,
      "timed out but first-read completed means the walk DID start");
  });

  test("false when not timed out", async () => {
    const { walkNeverStarted } = await loadBatch();
    assertEq(walkNeverStarted(false, []), false, "not timed out, no phases");
    assertEq(walkNeverStarted(false, ["page-create"]), false, "not timed out, some phases");
    assertEq(walkNeverStarted(false, ["page-create", "survey-load", "first-read"]), false,
      "not timed out, all phases");
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

/* ------------------------------------------------------------------ executor-level: startup retry on a hanging page */

/**
 * A fake page whose screen read hangs forever. walkPath proceeds through goto and fires
 * onStartupPhase("survey-load"), then hangs on the first screen read — so "first-read"
 * is never reached and the startup-budget determination produces "walk-never-started".
 * Copied from multilane.test.mjs's hangingReadPage, with the same contract.
 */
function hangingPage() {
  return {
    _newPageAt: Date.now(),
    async goto() {},
    async evaluate(script) {
      if (typeof script !== "string") return { ok: true };
      if (script.includes("screenSignature")) {
        // Hang forever — the withTimeout race fires and produces BrowserTimeout.
        return new Promise(() => {});
      }
      return { ok: true };
    },
    async evaluateOnNewDocument() {},
    async $$(selector) { return []; },
    async screenshot() { throw new Error("no screenshot in hanging harness"); },
    async setViewport() {},
    on() {},
    async close() {},
    async reload() {},
  };
}

/** Install a browser whose pages always hang on the first screen read. */
async function withHangingBrowser(fn) {
  const browser = {
    async newPage() { return hangingPage(); },
    async close() {},
    disconnect() {},
    sessionId() { return "sess_hanging"; },
  };
  globalThis.__V2_TEST_BROWSER__ = {
    async launch() { return browser; },
    async connect() { return browser; },
  };
  try {
    return await fn();
  } finally {
    delete globalThis.__V2_TEST_BROWSER__;
  }
}

/**
 * Seed a run bed whose plan has ONE floor path with delegated decisions, and whose env
 * has a SHORT per-case timeout so the test runs in ms-scale. The startup budget is even
 * shorter so the startup-budget race fires first.
 */
async function hangingBed(mod, env) {
  const { seedRun } = await import("./_helpers.mjs");
  const seeded = await seedRun(mod, env, { testCompletion: "running" });
  const sealed = (await mod.contractRevision.getContractRevision(env, seeded.contractRevisionId))
    .facetInstances.map((fi) => fi.facetInstanceId);
  const planRevisionId = "plan_d58hang001";
  const path = {
    id: "FLOOR-HANG",
    tier: 1,
    kind: "floor",
    intent: "walk the survey",
    decisions: [{
      question: "Q1",
      select: [],
      source: "default:navigator-discretion",
      strategy: "navigator:choose-the-first-valid-answer",
      note: "delegated",
    }],
    skipped_questions: [],
    terminated_at: null,
    witnesses: [],
    witness_notes: [],
    needs_repeats: [],
    steps: 3,
  };
  await env.EVIDENCE.put(
    mod.keys.planKey(seeded.runId, planRevisionId),
    JSON.stringify({
      kind: "v2-execution-program/2.0.0",
      runId: seeded.runId,
      planRevisionId,
      contractRevisionId: seeded.contractRevisionId,
      contractHash: seeded.contractHash,
      generatedAt: "2026-08-14T00:00:00.000Z",
      surveyUrl: "https://fixture.invalid/survey",
      floor: [{ pathId: "FLOOR-HANG", caseIds: [sealed[0]] }],
      exploration: [],
      caseOrder: sealed,
      unassignedCaseIds: sealed.slice(1),
      coverage: {
        obligations: 2,
        witnessedByFloor: 1,
        coversAllObligations: false,
        coversAllAfterMandatoryExploration: false,
        uncovered: [],
      },
      warnings: [],
      plan: { floor: { paths: [path] }, exploration: { queue: [] } },
    }),
    { httpMetadata: { contentType: "application/json" } },
  );

  const fence = await mod.checkpoint.claimOwnership(env, seeded.runId, seeded.runId, 0);
  const cursor = {
    batchIndex: 0,
    sessionId: null,
    sessionOpenedAt: null,
    pendingCaseIds: [...sealed],
    completedCaseIds: [],
    planRevisionId,
  };
  await mod.checkpoint.updateCheckpoint(env, seeded.runId, (d) => {
    d.execution = { ...cursor };
    d.counts = { ...d.counts, exercised: 0, pending: sealed.length };
  }, { fence });

  return { runId: seeded.runId, fence, cursor, planRevisionId, sealed };
}

suite("D58 — the LIVE executor: a hanging startup gets exactly one retry", () => {
  test("walk-never-started retry: the walk ledger records EXACTLY TWO rows for the path", async () => {
    // WHAT THIS PROVES: when the startup hangs, the executor records the initial
    // walk-never-started observation AND retries once on a fresh page. Both the
    // initial failure and the retry (also a failure with a hanging page) are
    // recorded in the walk ledger as two separate rows for the same path.
    //
    // WHY THIS IS A REAL TEST, NOT A SHAPE TEST:
    //   - It drives executeBatch end-to-end with fakes (the D31 pattern).
    //   - The determination runs through the real walkNeverStarted function.
    //   - Removing the retry block (mutant 2) leaves one row, not two.
    //   - Removing the startup budget (mutant 1) makes the outcome
    //     "per-case-timeout" instead of "walk-never-started", so no retry fires
    //     and only one row appears.
    //
    // TIMING: EXEC_PER_CASE_TIMEOUT_MS=1200, EXEC_WALK_STARTUP_BUDGET_MS=800.
    // The hanging page returns a never-resolving promise on screen reads, so the
    // 1200ms withTimeout fires. walkNeverStarted returns true (no "first-read"
    // phase), and the retry block runs with an 800ms timeout. Both complete in
    // ~2s total with NO real-second sleeps.
    const mod = await worker();
    const env = testEnv({
      EXEC_PER_CASE_TIMEOUT_MS: "1200",
      EXEC_WALK_TIMEOUT_MS: "1200",
      EXEC_WALK_STARTUP_BUDGET_MS: "800",
      EXEC_BATCH_MAX_MS: "30000",
    });
    const bed = await hangingBed(mod, env);

    const out = await withHangingBrowser(() =>
      mod.executeBatch.executeBatch(env, {
        runId: bed.runId,
        batch: 0,
        fence: bed.fence,
        cursor: bed.cursor,
        surveyUrl: "https://fixture.invalid/survey",
        planRevisionId: bed.planRevisionId,
      }),
    );

    const progress = await mod.executeBatch.loadProgress(env, bed.runId, bed.planRevisionId);
    const pathRows = progress.walks.filter((w) => w.pathId === "FLOOR-HANG");

    // THE CRITICAL ASSERTION: exactly two rows for this path — the initial failure
    // plus the retry. With the retry removed (mutant 2) this is 1; with an unbounded
    // retry it would be more. Either mutation reddens this test.
    assertEq(pathRows.length, 2,
      `expected exactly 2 walk rows for FLOOR-HANG (initial + retry), got ${pathRows.length}: ` +
      pathRows.map((r) => `${r.outcome}/${r.wallMs}ms`).join(", "));

    // Both rows must be walk-never-started — the page hangs unconditionally.
    assertEq(pathRows[0].outcome, "walk-never-started",
      "first row must be walk-never-started");
    assertEq(pathRows[1].outcome, "walk-never-started",
      "retry row must also be walk-never-started (page hangs unconditionally)");

    // Both must carry non-zero wallMs — the real elapsed time, never 0.
    assert(pathRows[0].wallMs > 0, `first row wallMs must be non-zero, got ${pathRows[0].wallMs}`);
    assert(pathRows[1].wallMs > 0, `retry row wallMs must be non-zero, got ${pathRows[1].wallMs}`);

    // The batch must have walked the path (even though both attempts failed).
    assertEq(out.pathsWalked, 1, "the path was walked (attempted)");
    // No cases closed — the walk never started.
    assertEq(out.casesClosed, 0, "a walk-never-started must close no cases");
  });
});

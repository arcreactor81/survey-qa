/**
 * D58 — BOUNDED BINDING-FAILURE RETRY: a walk that blocks because `bindDecision()` never
 * identified any screen as the target of a planned decision gets up to two full re-walks.
 *
 * ==================== WHY THIS EXISTS (the measured gap) ====================
 *
 * `bindDecision()` evaluates four independent signals (wording similarity, control-name
 * markup, question token in heading, option-label overlap) to identify which planned
 * decision applies to the current screen. Each signal independently passes or fails. When
 * no signal crosses its threshold on ANY constraining decision, the walker defaults
 * everywhere and blocks at a low screen count — not because the survey refused it, but
 * because it never steered at all.
 *
 * Run v2r_01m0f81gbe7n28zvhgrt0dphvm measured this: FLOOR-01 blocked at screen 8 with
 * constrainingDecisions=2, matchedConstraining=0, while an exploration walk on a different
 * path matched 3/3 and reached 67 screens. The binding depends on page render — HTML
 * structure, heading text, timing — and a fresh browser session gives it another chance.
 *
 * ==================== THE INVARIANTS PINNED HERE ====================
 *
 *   - ELIGIBILITY IS NARROW: walk outcome is in BLOCKING_OUTCOMES ("blocked",
 *     "blocked-after-probe") + constraining decisions > 0 + 0 matched constraining +
 *     not an intended termination + not sealed stimulus + not a just-triggers probe +
 *     under the 2-retry cap + attempt budget and deadline bounds.
 *   - FULL RE-WALK: from step 0 (not a partial pivot). Binding is per-screen and the
 *     whole walk must be re-driven.
 *   - DURABLE BEFORE EFFECT: the pivot counter is incremented and saved BEFORE the
 *     re-walk (the hungPaths / screenoutPivots pattern).
 *   - EVERY ATTEMPT IS FIRST-CLASS: a fresh attemptId per retry, its own WalkRecord
 *     linked by `pivot: { retryOf, ordinal, reason }`.
 *   - MUTUAL EXCLUSION WITH SCREENOUT RETRY: a screened-out walk's outcome is not in
 *     BLOCKING_OUTCOMES, so it won't trigger binding retry. A blocked walk won't trigger
 *     screenout retry. They don't conflict.
 *
 * Evidence these can fail: `tools/mutate-binding-retry.mjs`.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

/* ============================================================ 1. the eligibility predicate */

const blockedObs = (over = {}) => ({
  outcome: "blocked",
  steps: [{ advanced: true, stepIndex: 0, actions: [], decisionSource: null }],
  ...over,
});
const blockedAudit = (over = {}) => ({
  exercised: false,
  plannedDecisions: 2,
  matchedDecisions: 0,
  constrainingDecisions: 2,
  matchedConstraining: 0,
  ...over,
});
const eligPath = (over = {}) => ({ id: "P1", terminated_at: null, decisions: [], ...over });
const eligArgs = (over = {}) => ({
  obs: blockedObs(),
  audit: blockedAudit(),
  path: eligPath(),
  pivots: {},
  pathsWalked: 0,
  maxAttempts: 10,
  now: 1_000,
  batchDeadline: 2_000,
  ...over,
});

suite("D58 — eligibility: narrow, typed, and bounded", () => {
  test("the happy path IS eligible: blocked with constraining decisions, none matched, under cap, in budget", async () => {
    const mod = await worker();
    assertEq(mod.executeBatch.bindingRetryEligible(eligArgs()), true);
  });

  test("blocked-after-probe is ALSO eligible — same class of binding failure", async () => {
    const mod = await worker();
    assertEq(
      mod.executeBatch.bindingRetryEligible(eligArgs({ obs: blockedObs({ outcome: "blocked-after-probe" }) })),
      true,
    );
  });

  test("only BLOCKING outcomes qualify — completed, screened-out, error, stalled all refuse", async () => {
    const mod = await worker();
    for (const outcome of ["completed", "no-advance-control", "screened-out", "error", "per-case-timeout"]) {
      assertEq(
        mod.executeBatch.bindingRetryEligible(eligArgs({ obs: blockedObs({ outcome }) })),
        false,
        `a "${outcome}" walk was binding-retried`,
      );
    }
  });

  test("zero constraining decisions refuses — there is nothing to bind", async () => {
    const mod = await worker();
    assertEq(
      mod.executeBatch.bindingRetryEligible(eligArgs({ audit: blockedAudit({ constrainingDecisions: 0 }) })),
      false,
    );
  });

  test("at least one matched constraining refuses — binding worked for something", async () => {
    const mod = await worker();
    assertEq(
      mod.executeBatch.bindingRetryEligible(eligArgs({ audit: blockedAudit({ matchedConstraining: 1 }) })),
      false,
    );
  });

  test("a path that INTENDS termination is never retried (terminated_at)", async () => {
    const mod = await worker();
    const path = eligPath({ terminated_at: { question: "S3", answer: "Market research", terminal: "T1" } });
    assertEq(mod.executeBatch.bindingRetryEligible(eligArgs({ path })), false);
  });

  test("the binding-retry guard refuses a path whose decisions carry case_action — sealed stimulus is sealed", async () => {
    const mod = await worker();
    const path = eligPath({
      decisions: [{ question: "S4", select: [], case_action: { kind: "route" }, source: "typed-case:route" }],
    });
    assertEq(mod.executeBatch.bindingRetryEligible(eligArgs({ path })), false);
  });

  test("a just-triggers terminal-adjacency probe is never retried", async () => {
    const mod = await worker();
    const path = eligPath({ adjacency: { side: "just-triggers", terminal: "T1" } });
    assertEq(mod.executeBatch.bindingRetryEligible(eligArgs({ path })), false);
    const avoids = eligPath({ adjacency: { side: "just-avoids", terminal: "T1" } });
    assertEq(mod.executeBatch.bindingRetryEligible(eligArgs({ path: avoids })), true, "just-avoids stays eligible");
  });

  test("binding-retry pivots at the cap refuse: 2 recorded pivots end it, 1 does not", async () => {
    const mod = await worker();
    assertEq(mod.executeBatch.bindingRetryEligible(eligArgs({ pivots: { P1: 2 } })), false);
    assertEq(mod.executeBatch.bindingRetryEligible(eligArgs({ pivots: { P1: 1 } })), true);
    assertEq(mod.executeBatch.bindingRetryEligible(eligArgs({ pivots: undefined })), true, "absent map = zero pivots");
  });

  test("the batch deadline bounds the retry like any other walk", async () => {
    const mod = await worker();
    assertEq(mod.executeBatch.bindingRetryEligible(eligArgs({ now: 2_000 })), false);
  });

  test("the attempt budget bounds the retry", async () => {
    const mod = await worker();
    assertEq(mod.executeBatch.bindingRetryEligible(eligArgs({ pathsWalked: 10, maxAttempts: 10 })), false);
    assertEq(mod.executeBatch.bindingRetryEligible(eligArgs({ pathsWalked: 9, maxAttempts: 10 })), true);
  });

  test("MUTUAL EXCLUSION: a screened-out walk is NOT eligible for binding retry", async () => {
    const mod = await worker();
    // A screened-out walk has outcome "screened-out" or the ending kind is screened-out.
    // The screenout retry checks ending.kind; the binding retry checks outcome against
    // BLOCKING_OUTCOMES. "screened-out" is NOT in BLOCKING_OUTCOMES.
    assertEq(
      mod.executeBatch.bindingRetryEligible(eligArgs({ obs: blockedObs({ outcome: "screened-out" }) })),
      false,
      "screened-out walks should be handled by screenoutRetryEligible, not bindingRetryEligible",
    );
  });
});

/* ============================================================ 2. the cap constant */

suite("D58 — BINDING_RETRY_CAP", () => {
  test("the cap is 2, consistent with SCREENOUT_PIVOT_CAP", async () => {
    const mod = await worker();
    assertEq(mod.executeBatch.BINDING_RETRY_CAP, 2);
    assertEq(mod.executeBatch.SCREENOUT_PIVOT_CAP, 2, "both retry caps must be identical for consistency");
  });
});

/* ============================================================ 3. the progress field */

/** Minimal progress.json scaffold with all required fields for decodeProgress. */
const bareProgress = (runId, planRevisionId, over = {}) => ({
  kind: "v2-execution-progress/1.0.0",
  runId,
  planRevisionId,
  walks: [],
  floorDone: [],
  explorationDone: [],
  seedDone: [],
  caseWitnessReceipts: [],
  seedReceiptRefusals: [],
  shimRequired: false,
  shimEvidence: null,
  hungPaths: [],
  screenoutPivots: {},
  totalSteps: 0,
  totalEvidence: 0,
  ...over,
});

suite("D58 — bindingRetryPivots in progress", () => {
  test("decodeProgress accepts a progress.json WITHOUT bindingRetryPivots (backward compat)", async () => {
    const mod = await worker();
    const runId = "v2r_d58test001";
    const planRevisionId = "plan_d58test01";
    const raw = bareProgress(runId, planRevisionId);
    // Should not throw — the field is optional
    const decoded = mod.executeBatch.decodeProgress(raw, runId, planRevisionId);
    assert(decoded, "decodeProgress must accept a progress without bindingRetryPivots");
  });

  test("decodeProgress accepts valid bindingRetryPivots when present", async () => {
    const mod = await worker();
    const runId = "v2r_d58test002";
    const planRevisionId = "plan_d58test02";
    const raw = bareProgress(runId, planRevisionId, { bindingRetryPivots: { "FLOOR-01": 1 } });
    const decoded = mod.executeBatch.decodeProgress(raw, runId, planRevisionId);
    assert(decoded, "decodeProgress must accept valid bindingRetryPivots");
  });

  test("decodeProgress rejects non-integer bindingRetryPivots values", async () => {
    const mod = await worker();
    const runId = "v2r_d58test003";
    const planRevisionId = "plan_d58test03";
    const raw = bareProgress(runId, planRevisionId, { bindingRetryPivots: { "FLOOR-01": 1.5 } });
    let threw = false;
    try {
      mod.executeBatch.decodeProgress(raw, runId, planRevisionId);
    } catch {
      threw = true;
    }
    assert(threw, "decodeProgress must reject a non-integer binding retry count");
  });

  test("decodeProgress rejects empty path id in bindingRetryPivots", async () => {
    const mod = await worker();
    const runId = "v2r_d58test004";
    const planRevisionId = "plan_d58test04";
    const raw = bareProgress(runId, planRevisionId, { bindingRetryPivots: { "": 1 } });
    let threw = false;
    try {
      mod.executeBatch.decodeProgress(raw, runId, planRevisionId);
    } catch {
      threw = true;
    }
    assert(threw, "decodeProgress must reject an empty path id in bindingRetryPivots");
  });
});

/* ============================================================ 4. THE LIVE EXECUTOR (end to end) */

const nextBtn = (idx) => ({ idx, label: "Next", role: "next", roleVia: "text:Next", disabled: false, visible: true });

const option = (idx, label, rest = {}) => ({
  order: idx,
  idx,
  code: null,
  label,
  checked: false,
  disabled: false,
  visible: true,
  operable: true,
  actuatedVia: "self",
  labelIndex: null,
  ...rest,
});

const screen = (text, { controls = [], optionGroups = [], grid = null, buttons, signature } = {}) => ({
  at: "2026-08-20T00:05:00.000Z",
  url: "https://fixture.invalid/survey",
  title: null,
  collectedErrors: [],
  questionText: text,
  instructionText: null,
  visibleText: text,
  visibleTextTruncated: false,
  bracketedInstructionsVisible: [],
  controls,
  optionGroups,
  grid,
  readerLimitations: [],
  buttons: buttons === undefined ? [nextBtn(30)] : buttons,
  progress: { present: false, kind: null, now: null, max: null, text: null },
  validationMessages: [],
  counts: {
    controls: controls.length,
    optionGroups: optionGroups.length,
    options: optionGroups.reduce((n, g) => n + g.options.length, 0),
    textInputs: 0,
    valueInputs: controls.length,
    optionsNotOperable: 0,
    readerLimitations: 0,
  },
  screenSignature: signature ?? `sig:${text}`,
});

/** A page that blocks: no advance control after the first screen. */
const blockingScreen = () =>
  screen("Q1. Which brand do you prefer?", {
    optionGroups: [
      {
        name: "Q1",
        kind: "radio",
        options: [option(0, "Brand A"), option(1, "Brand B")],
      },
    ],
  });

/** A terminal page in the COMPLETION lexicon. */
const completedTerminal = () => screen("Thank you for completing the survey.", { buttons: [] });

function fakePage(reads) {
  const queue = [...reads];
  let last = reads[0] ?? null;
  const typed = [];
  const set = [];
  const clicks = [];
  const handle = (selector, index) => ({
    async click() {
      clicks.push({ selector, index });
    },
    async type(text) {
      typed.push({ index, text });
    },
    async focus() {},
  });
  return {
    typed,
    set,
    clicks,
    async goto() {},
    async evaluate(script) {
      if (typeof script !== "string") return { ok: true };
      if (script.includes("screenSignature")) {
        if (queue.length > 0) last = queue.shift();
        return last;
      }
      const m = /el\.value = ("(?:[^"\\]|\\.)*");/.exec(script);
      if (m && script.includes("change")) {
        const value = JSON.parse(m[1]);
        set.push({ value });
        return { ok: true, reason: null, got: value };
      }
      if (script.includes("W4_NATIVE_CHOICE_SCOPED_READBACK")) {
        const idx = Number(/const expectedIdx = (\d+);/.exec(script)?.[1]);
        return { idx, type: "radio", name: null, checked: true, checkedGroupIdxs: [idx] };
      }
      return { ok: true };
    },
    async evaluateOnNewDocument() {},
    async $$(selector) {
      return Array.from({ length: 32 }, (_, i) => handle(selector, i));
    },
    async screenshot() {
      throw new Error("no screenshot in this harness");
    },
    async setViewport() {},
    on() {},
    async close() {},
    async reload() {},
  };
}

function multiWalkBrowser(scripts) {
  const pages = [];
  let i = 0;
  const browser = {
    async newPage() {
      const reads = scripts[Math.min(i, scripts.length - 1)];
      i += 1;
      const page = fakePage(reads);
      pages.push(page);
      return page;
    },
    async close() {},
    disconnect() {},
    sessionId() {
      return "sess_test";
    },
  };
  return { browser, pages };
}

async function withBrowser(scripts, fn) {
  const { browser, pages } = multiWalkBrowser(scripts);
  globalThis.__V2_TEST_BROWSER__ = { async launch() { return browser; }, async connect() { return browser; } };
  try {
    return { out: await fn(), pages };
  } finally {
    delete globalThis.__V2_TEST_BROWSER__;
  }
}

async function liveBed(mod, env, pathOver = {}) {
  const { seedRun } = await import("./_helpers.mjs");
  const seeded = await seedRun(mod, env, { testCompletion: "running" });
  const sealed = (await mod.contractRevision.getContractRevision(env, seeded.contractRevisionId)).facetInstances.map(
    (fi) => fi.facetInstanceId,
  );
  const planRevisionId = "plan_d58live001";
  const path = {
    id: "FLOOR-01",
    tier: 1,
    kind: "floor",
    intent: "walk the survey",
    decisions: [
      // A constraining decision that will never bind — the question wording doesn't match
      // any screen in the fixture, so bindDecision() will refuse every screen.
      {
        question: "Q99",
        question_wording: "A question that does not appear on any screen in this fixture",
        select: ["Nonexistent option"],
        source: "plan:routed",
        strategy: "select-documented-label",
      },
    ],
    skipped_questions: [],
    terminated_at: null,
    witnesses: [],
    witness_notes: [],
    needs_repeats: [],
    steps: 3,
    ...pathOver,
  };
  await env.EVIDENCE.put(
    mod.keys.planKey(seeded.runId, planRevisionId),
    JSON.stringify({
      kind: "v2-execution-program/2.0.0",
      runId: seeded.runId,
      planRevisionId,
      contractRevisionId: seeded.contractRevisionId,
      contractHash: seeded.contractHash,
      generatedAt: "2026-08-20T00:00:00.000Z",
      surveyUrl: "https://fixture.invalid/survey",
      floor: [{ pathId: "FLOOR-01", caseIds: [sealed[0]] }],
      exploration: [],
      caseOrder: sealed,
      unassignedCaseIds: sealed.slice(1),
      coverage: { obligations: 2, witnessedByFloor: 1, coversAllObligations: false, coversAllAfterMandatoryExploration: false, uncovered: [] },
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

const runBatch = (mod, env, bed) =>
  mod.executeBatch.executeBatch(env, {
    runId: bed.runId,
    batch: 0,
    fence: bed.fence,
    cursor: bed.cursor,
    surveyUrl: "https://fixture.invalid/survey",
    planRevisionId: bed.planRevisionId,
  });

/**
 * Walk script that blocks: the walker advances one screen, then blocks (no advance control
 * after repeated attempts). The constraining decision never binds because the question
 * wording doesn't match any screen.
 */
const blockingScript = () => [blockingScreen(), blockingScreen(), blockingScreen()];

/** Walk script that completes — simulates a successful binding retry. */
const completingScript = () => [blockingScreen(), blockingScreen(), completedTerminal()];

suite("D58 — THE LIVE RETRY: a blocked walk with 0 matched constraining gets a full re-walk", () => {
  test("an eligible blocked walk is re-walked and the retry record links the attempts", async () => {
    const mod = await worker();
    const env = testEnv();
    const bed = await liveBed(mod, env);

    const { out } = await withBrowser([blockingScript(), completingScript()], () => runBatch(mod, env, bed));

    const progress = await mod.executeBatch.loadProgress(env, bed.runId, bed.planRevisionId);
    // At minimum: the original blocked walk + the binding retry walk
    assert(progress.walks.length >= 2, `expected at least 2 walks, got ${progress.walks.length}`);

    // Find the binding retry walk (has pivot with reason mentioning "binding")
    const retryWalks = progress.walks.filter((w) => w.pivot?.reason?.includes("binding retry"));
    assert(retryWalks.length >= 1, `expected at least one binding retry walk, got ${retryWalks.length}`);

    const firstRetry = retryWalks[0];
    assertEq(firstRetry.pivot?.ordinal, 1);
    assert(typeof firstRetry.pivot?.reason === "string" && firstRetry.pivot.reason.length > 0);

    // The binding retry counter is recorded
    assertEq(progress.bindingRetryPivots?.["FLOOR-01"] >= 1, true, "binding retry counter not recorded");
    assertEq(out.pathsWalked >= 2, true, "pathsWalked must count binding retries");
  });

  test("THE CAP: three blocked walks end the path with no fourth walk", async () => {
    const mod = await worker();
    const env = testEnv();
    const bed = await liveBed(mod, env);

    // Every attempt blocks. The third script repeats for any illegal extra walk.
    const { out } = await withBrowser(
      [blockingScript(), blockingScript(), blockingScript(), blockingScript()],
      () => runBatch(mod, env, bed),
    );

    const progress = await mod.executeBatch.loadProgress(env, bed.runId, bed.planRevisionId);
    const retryWalks = progress.walks.filter((w) => w.pivot?.reason?.includes("binding retry"));
    assert(retryWalks.length <= 2, `binding retries exceeded cap of 2, got ${retryWalks.length}`);
    assertEq(progress.bindingRetryPivots?.["FLOOR-01"] <= 2, true, "binding retry counter exceeded cap");
  });

  test("a path WITHOUT constraining decisions is never binding-retried", async () => {
    const mod = await worker();
    const env = testEnv();
    // Path with no decisions — constrainingDecisions will be 0
    const bed = await liveBed(mod, env, { decisions: [] });

    await withBrowser([blockingScript(), completingScript()], () => runBatch(mod, env, bed));

    const progress = await mod.executeBatch.loadProgress(env, bed.runId, bed.planRevisionId);
    const retryWalks = progress.walks.filter((w) => w.pivot?.reason?.includes("binding retry"));
    assertEq(retryWalks.length, 0, "a path with no constraining decisions should not get binding-retried");
  });

  test("a path with sealed case_action is never binding-retried", async () => {
    const mod = await worker();
    const env = testEnv();
    const bed = await liveBed(mod, env, {
      decisions: [
        {
          question: "Q99",
          select: [],
          source: "typed-case:route",
          case_action: {
            facetInstanceId: "fi_d58route01",
            targetQuestionId: "Q99",
            kind: "route",
            routeAnswer: { code: null, label: null },
            boundaryInput: null,
          },
        },
      ],
    });

    await withBrowser([blockingScript(), completingScript()], () => runBatch(mod, env, bed));

    const progress = await mod.executeBatch.loadProgress(env, bed.runId, bed.planRevisionId);
    const retryWalks = progress.walks.filter((w) => w.pivot?.reason?.includes("binding retry"));
    assertEq(retryWalks.length, 0, "sealed stimulus was binding-retried — the typed case's outcome was fought");
  });

  test("a path that INTENDS termination is never binding-retried, live", async () => {
    const mod = await worker();
    const env = testEnv();
    const bed = await liveBed(mod, env, {
      terminated_at: { question: "Q99", answer: "Nonexistent", terminal: "T1" },
    });

    await withBrowser([blockingScript(), completingScript()], () => runBatch(mod, env, bed));

    const progress = await mod.executeBatch.loadProgress(env, bed.runId, bed.planRevisionId);
    const retryWalks = progress.walks.filter((w) => w.pivot?.reason?.includes("binding retry"));
    assertEq(retryWalks.length, 0, "a plan-intended termination was fought by binding retry");
  });
});

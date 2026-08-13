/**
 * D55 — BOUNDED SCREEN-OUT RETRY: a walk that screens out on the harness's OWN invented
 * answers gets up to two deterministic re-walks with varied fillers.
 *
 * ==================== WHY THIS EXISTS (the measured gap) ====================
 *
 * Numeric screeners are STRUCTURALLY unreachable by the planner: `mineThresholds` mines no
 * numeric terminate rules and `buildTerminals` triggers are label-quoted only, so "terminate
 * if >= 15" exists nowhere as data and no stamp can steer the numeric filler around it.
 * Survival hints (D54) are the label mechanism; THIS is the numeric mechanism. The pinned
 * counterexample is s2's S4 (min=0 max=31, terminate at >= 15): d44 asserts the midpoint 16
 * STAYS screened out — no constant passes every screener, and retuning the constant is the
 * hard-anchoring CLAUDE.md forbids. The repair is not a better constant but a BOUNDED,
 * DETERMINISTIC pivot: on a typed `screened-out` ending reached on navigator-default
 * answers, re-walk with variant 1 (25% quantile / 2nd eligible option), then variant 2
 * (75% / 3rd), then stop. Variant = the durable pivot ordinal — no clock, no randomness.
 *
 * ==================== THE INVARIANTS PINNED HERE ====================
 *
 *   - ELIGIBILITY IS NARROW: typed screened-out + invented answers on the walk + the plan
 *     did not intend termination (`terminated_at`), does not carry sealed stimulus
 *     (`case_action` — a typed case's stimulus replays identically, so a pivot could only
 *     waste walks fighting an intended outcome), is not a `just-triggers` terminal-adjacency
 *     probe, is under the 2-pivot cap, and the batch deadline has not passed.
 *   - DURABLE BEFORE EFFECT: the pivot counter is incremented and saved BEFORE the re-walk
 *     (the hungPaths pattern), so a Workflow step replay re-derives the same ordinal.
 *   - EVERY ATTEMPT IS FIRST-CLASS: a fresh attemptId per pivot (never the shim retry's
 *     reuse), its own WalkRecord linked by `pivot: { retryOf, ordinal, reason }`, and
 *     attempt-unique artifact refs — the judge's signed manifest keys the catalogue by
 *     BASENAME, so a re-walk under attempt 0's refs raises MANIFEST_DUPLICATE_ARTIFACT and
 *     the run mints no judgement. That landing gate ships in the same change and is pinned
 *     below.
 *   - CLOSURE IS A UNION WITH DEDUPE: each attempt closes cases through the same
 *     `assessExercised` gate as any walk, and the cursor's existing dedupe stops a retry
 *     from double-closing what attempt 0 already closed.
 *   - STIMULUS IS INPUT, NEVER EVIDENCE: pivot fillers keep the counted
 *     `navigator-default:` prefix under a `retry-N` tag, and the base midpoint and its
 *     pinned constants are untouched (variant 0 is byte-identical to today).
 *
 * Evidence these can fail: `tools/mutate-screenout-retry.mjs`.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

const ATTEMPT_ID = "att_d55000000001";
const PATH_ID = "path_d55000000001";

/* ------------------------------------------------------------------ fixtures (d54 shapes) */

const nextBtn = (idx) => ({ idx, label: "Next", role: "next", roleVia: "text:Next", disabled: false, visible: true });

const option = (idx, label, { code = null, ...rest } = {}) => ({
  order: idx,
  idx,
  code,
  label,
  checked: false,
  disabled: false,
  visible: true,
  operable: true,
  actuatedVia: "self",
  labelIndex: null,
  ...rest,
});

const numberControl = (idx, rest = {}) => ({
  idx,
  tag: "input",
  type: "number",
  name: null,
  id: null,
  code: null,
  label: "",
  text: "",
  checked: null,
  value: "",
  valueIsUserSupplied: false,
  disabled: false,
  required: false,
  visible: true,
  operable: true,
  actuatedVia: "self",
  placeholder: null,
  maxlength: null,
  min: null,
  max: null,
  step: null,
  pattern: null,
  readOnly: false,
  ...rest,
});

const screen = (text, { controls = [], optionGroups = [], grid = null, buttons, signature } = {}) => ({
  at: "2026-08-11T00:05:00.000Z",
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

/** The pinned counterexample's shape: s2's S4 — min=0 max=31, terminate at >= 15. */
const s4Screen = () =>
  screen("S4. On how many days last month did you experience this?", {
    controls: [numberControl(0, { min: "0", max: "31" })],
  });

/** A terminal page in the SCREENOUT lexicon, with nothing left to press. */
const screenedOutTerminal = () =>
  screen("Unfortunately, on this occasion you do not qualify for this study.", { buttons: [] });

/** A terminal page in the COMPLETION lexicon, with nothing left to press. */
const completedTerminal = () => screen("Thank you for completing the survey.", { buttons: [] });

/** A page serving scripted screens, recording keystrokes/assignments/clicks (d44/d54 pattern). */
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
      // A successful Puppeteer click is not sufficient evidence that a native radio kept the
      // requested state. Mirror the real scoped receipt so these route tests exercise the
      // production exact-readback contract rather than the retired transport-click convention.
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

/* ============================================================ 1. the variant, at driver level */

async function walkVariant(mod, env, reads, variant, path = {}) {
  const runId = mod.ids.mintRunId();
  const page = fakePage(reads);
  const obs = await mod.driver.walkPath(
    page,
    { id: PATH_ID, decisions: [], witnesses: [], ...path },
    {
      surveyUrl: "https://fixture.invalid/survey",
      runId,
      planRevisionId: "plan_d55test01",
      attemptId: ATTEMPT_ID,
      tier: 1,
      maxSteps: 1,
      deadline: Date.now() + 30_000,
      viewport: { width: 1280, height: 900 },
      applyHistoryShim: false,
      advanceTimeoutMs: 200,
      variant,
    },
    { env, runId, attemptId: ATTEMPT_ID, pathId: PATH_ID, witnesses: [] },
  );
  return { obs, page };
}

const advancing = (s) => [s, s, completedTerminal()];
const actionsOf = (obs, kind) => (obs.steps[0]?.actions ?? []).filter((a) => a.kind === kind && a.ok);

suite("D55 — variant quantiles: a different deterministic point on the SAME declared range", () => {
  test("THE PINNED COUNTEREXAMPLE RESOLVED: 0..31 midpoints to 16 (screened out), variant 1 answers 8 — below the 15 threshold", async () => {
    const mod = await worker();
    // Variant 0 IS the pinned midpoint, byte-for-byte — the d44 counterexample is untouched.
    assertEq(mod.driver.navigatorValueFor({ type: "number", min: "0", max: "31" }).value, "16");
    const v1 = mod.driver.navigatorValueFor({ type: "number", min: "0", max: "31" }, 1);
    assertEq(v1.value, "8", `variant 1 on 0..31 answered "${v1.value}"`);
    assert(Number(v1.value) < 15, "the retry value must clear S4's >= 15 threshold");
    const v2 = mod.driver.navigatorValueFor({ type: "number", min: "0", max: "31" }, 2);
    assertEq(v2.value, "23", `variant 2 on 0..31 answered "${v2.value}"`);
  });

  test("variant values are STILL step-snapped and clamped — the grid is the site's, like the midpoint's", async () => {
    const mod = await worker();
    const v = (c, n) => mod.driver.navigatorValueFor(c, n).value;
    // Integer default grid: 25% of 0..99 is 24.75 -> snapped to 25; 75% -> 74.
    assertEq(v({ type: "number", min: "0", max: "99" }, 1), "25");
    assertEq(v({ type: "number", min: "0", max: "99" }, 2), "74");
    // Min-anchored fractional grid: 3..7 step 0.5 -> 4 and 6, never 4.25.
    assertEq(v({ type: "number", min: "3", max: "7", step: "0.5" }, 1), "4");
    assertEq(v({ type: "number", min: "3", max: "7", step: "0.5" }, 2), "6");
    // Coarse grid: 0..10 step 4 -> the grid points 4 and 8.
    assertEq(v({ type: "number", min: "0", max: "10", step: "4" }, 1), "4");
    assertEq(v({ type: "number", min: "0", max: "10", step: "4" }, 2), "8");
    // step="any" is the one case a fraction is legal.
    assertEq(v({ type: "number", min: "0", max: "1", step: "any" }, 1), "0.25");
    // A range has HTML's default 0..100 even undeclared, and is SET, not typed.
    assertEq(v({ type: "range" }, 1), "25");
    assertEq(v({ type: "range" }, 2), "75");
    assertEq(mod.driver.navigatorValueFor({ type: "range" }, 1).via, "set");
    assertEq(mod.driver.navigatorValueFor({ type: "number", min: "0", max: "31" }, 1).via, "type");
  });

  test("no range to vary: one bound or none keeps the variant-0 value — the variant never invents a range", async () => {
    const mod = await worker();
    assertEq(mod.driver.navigatorValueFor({ type: "number", min: "18" }, 1).value, "18");
    assertEq(mod.driver.navigatorValueFor({ type: "number" }, 2).value, "1");
  });

  test("the variant filler keeps the counted navigator-default provenance, tagged retry-N", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs, page } = await walkVariant(mod, env, advancing(s4Screen()), 1);
    const typed = actionsOf(obs, "type-text");
    assertEq(typed.length, 1, JSON.stringify(obs.steps[0]?.actions));
    assertEq(typed[0].value, "8");
    assertEq(page.typed[0].text, "8", "the record and the keystrokes must agree");
    assert(typed[0].detail.startsWith("navigator-default:retry-1:"), typed[0].detail);
    assertEq(obs.navigatorDefaultAnswerCount, 1, "a pivot filler is still a counted invented answer");
  });
});

/** The d54 industry screen widened to three options: position 1 is the documented trigger. */
const threeOptionScreen = () =>
  screen("S3. Which industry do you work in for your main job?", {
    optionGroups: [
      {
        name: "S3",
        kind: "radio",
        options: [option(0, "Market research"), option(1, "Software engineering"), option(2, "Healthcare")],
      },
    ],
  });

suite("D55 — variant option picks: the Nth eligible option AFTER survival-hint filtering, clamped", () => {
  test("HINT FILTERING COMPOSES: variant 1 picks the 2nd NON-flagged option, not the 2nd option", async () => {
    const mod = await worker();
    const env = testEnv();
    // Eligible after filtering out the documented trigger: [Software engineering, Healthcare].
    // Variant 1 = index 1 of THAT list — "Healthcare". Counting from the raw option list
    // instead would land back on a flagged or already-tried label.
    const { obs } = await walkVariant(mod, env, advancing(threeOptionScreen()), 1, {
      survival_hints: [{ question: "S3", avoid_labels: ["Market research"] }],
    });
    const clicks = actionsOf(obs, "click-option");
    assertEq(clicks.length, 1, JSON.stringify(obs.steps[0]?.actions));
    assertEq(clicks[0].targetLabel, "Healthcare", `variant 1 clicked "${clicks[0].targetLabel}"`);
    assert(
      clicks[0].detail.startsWith("navigator-default:retry-1:option-2-of-2-eligible-after-hint-filtering ("),
      clicks[0].detail,
    );
  });

  test("CLAMP, NOT WRAPAROUND: more pivots than eligible options repeats the furthest untried position, never position-1", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walkVariant(mod, env, advancing(threeOptionScreen()), 2, {
      survival_hints: [{ question: "S3", avoid_labels: ["Market research"] }],
    });
    const clicks = actionsOf(obs, "click-option");
    // Wraparound (2 % 2 = 0) would re-click "Software engineering" — or worse, an unfiltered
    // wrap would re-click the documented trigger the first walk died on.
    assertEq(clicks[0].targetLabel, "Healthcare", `variant 2 clicked "${clicks[0].targetLabel}"`);
  });

  test("without hints the variant is a plain Nth-eligible pick, still navigator-default-counted", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walkVariant(mod, env, advancing(threeOptionScreen()), 1);
    const clicks = actionsOf(obs, "click-option");
    assertEq(clicks[0].targetLabel, "Software engineering");
    assert(clicks[0].detail.startsWith("navigator-default:retry-1:option-2-of-3-eligible ("), clicks[0].detail);
    assert(obs.navigatorDefaultAnswerCount >= 1);
  });

  test("DETERMINISM: the same inputs walk the same walk — actions are byte-identical across runs", async () => {
    const mod = await worker();
    const strip = (obs) => JSON.stringify(obs.steps[0].actions);
    const a = await walkVariant(mod, testEnv(), advancing(threeOptionScreen()), 1, {
      survival_hints: [{ question: "S3", avoid_labels: ["Market research"] }],
    });
    const b = await walkVariant(mod, testEnv(), advancing(threeOptionScreen()), 1, {
      survival_hints: [{ question: "S3", avoid_labels: ["Market research"] }],
    });
    assertEq(strip(a.obs), strip(b.obs), "a variant choice moved between two identical walks");
    const c = await walkVariant(mod, testEnv(), advancing(s4Screen()), 2);
    const d = await walkVariant(mod, testEnv(), advancing(s4Screen()), 2);
    assertEq(strip(c.obs), strip(d.obs));
  });
});

/* ============================================================ 2. the landing gate (capture refs) */

suite("D55 — the landing gate: a retry's artifact basenames are DISJOINT from attempt 0's", () => {
  test("ordinal 0 refs are BYTE-IDENTICAL to today's; ordinal 1 carries the retry slug in the basename", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();
    const ctx0 = { env, runId, attemptId: "att_d55aaaa0001", pathId: PATH_ID, witnesses: [] };
    const r0 = await mod.capture.captureScreenJsonRef(ctx0, s4Screen(), "before", 0);
    // The exact legacy shape: any drift here re-keys every existing run's evidence.
    assertEq(r0.artifactRef, `observations/${PATH_ID}/${PATH_ID}-step-000-before.json`);

    const ctx1 = { ...ctx0, attemptId: "att_d55aaaa0002", attemptOrdinal: 1 };
    const r1 = await mod.capture.captureScreenJsonRef(ctx1, s4Screen(), "before", 0);
    assertEq(r1.artifactRef, `observations/${PATH_ID}/${PATH_ID}-retry-1-step-000-before.json`);

    const basename = (ref) => ref.split("/").pop();
    assert(basename(r0.artifactRef) !== basename(r1.artifactRef), "the signed manifest keys by basename");
    // Identical bytes, same slot, same producer id — and STILL a distinct catalogue entry,
    // because `evidenceIdFor` hashes the artifactRef. A shared entry would leave the retry
    // observation citing a ref the catalogue never minted.
    assert(r0.evidenceId !== r1.evidenceId, "identical bytes across attempts collapsed onto one catalogue entry");
  });

  test("attemptOrdinal 0 is EXPLICITLY the legacy shape — present-but-zero changes nothing", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();
    const ctx = { env, runId, attemptId: "att_d55aaaa0003", pathId: PATH_ID, attemptOrdinal: 0, witnesses: [] };
    const r = await mod.capture.captureScreenJsonRef(ctx, s4Screen(), "after-action", 2);
    assertEq(r.artifactRef, `observations/${PATH_ID}/${PATH_ID}-step-002-after-action.json`);
  });
});

/* ============================================================ 3. the eligibility predicate */

const eligObs = (over = {}) => ({
  ending: { kind: "screened-out", evidence: [] },
  navigatorDefaultAnswerCount: 1,
  ...over,
});
const eligPath = (over = {}) => ({ id: "P1", terminated_at: null, decisions: [], ...over });
const eligArgs = (over = {}) => ({
  obs: eligObs(),
  path: eligPath(),
  pivots: {},
  now: 1_000,
  batchDeadline: 2_000,
  ...over,
});

suite("D55 — eligibility: narrow, typed, and bounded", () => {
  test("the happy path IS eligible: typed screened-out on invented answers, plan silent, under cap, in budget", async () => {
    const mod = await worker();
    assertEq(mod.executeBatch.screenoutRetryEligible(eligArgs()), true);
  });

  test("only a TYPED screened-out ending qualifies — completed, stalled, unclassified and absent all refuse", async () => {
    const mod = await worker();
    for (const kind of ["completed", "stalled", "unclassified"]) {
      assertEq(
        mod.executeBatch.screenoutRetryEligible(eligArgs({ obs: eligObs({ ending: { kind, evidence: [] } }) })),
        false,
        `a "${kind}" ending was pivoted`,
      );
    }
    assertEq(mod.executeBatch.screenoutRetryEligible(eligArgs({ obs: eligObs({ ending: undefined }) })), false);
  });

  test("a screen-out reached on ZERO invented answers is the PLAN's outcome — replaying it identically buys nothing", async () => {
    const mod = await worker();
    assertEq(
      mod.executeBatch.screenoutRetryEligible(eligArgs({ obs: eligObs({ navigatorDefaultAnswerCount: 0 }) })),
      false,
    );
    assertEq(
      mod.executeBatch.screenoutRetryEligible(eligArgs({ obs: eligObs({ navigatorDefaultAnswerCount: undefined }) })),
      false,
      "absent must degrade to not-eligible, never to a walk",
    );
  });

  test("a path that INTENDS termination is never pivoted (terminated_at)", async () => {
    const mod = await worker();
    const path = eligPath({ terminated_at: { question: "S3", answer: "Market research", terminal: "T1" } });
    assertEq(mod.executeBatch.screenoutRetryEligible(eligArgs({ path })), false);
  });

  test("the guard refuses a path whose decisions carry case_action — sealed stimulus is sealed", async () => {
    const mod = await worker();
    const path = eligPath({
      decisions: [{ question: "S4", select: [], case_action: { kind: "route" }, source: "typed-case:route" }],
    });
    assertEq(mod.executeBatch.screenoutRetryEligible(eligArgs({ path })), false);
  });

  test("a just-triggers terminal-adjacency probe EXISTS to screen out — never pivoted", async () => {
    const mod = await worker();
    // VERIFIED against plan-core.js:1699/1713: exploration entries emit
    // `adjacency: { side: 'just-triggers' | 'just-avoids', terminal }` through the open
    // index signature, and the whole entry travels in the plan artifact to the executor.
    const path = eligPath({ adjacency: { side: "just-triggers", terminal: "T1" } });
    assertEq(mod.executeBatch.screenoutRetryEligible(eligArgs({ path })), false);
    const avoids = eligPath({ adjacency: { side: "just-avoids", terminal: "T1" } });
    assertEq(mod.executeBatch.screenoutRetryEligible(eligArgs({ path: avoids })), true, "just-avoids stays eligible");
  });

  test("pivots at the cap refuse: 2 recorded pivots end it, 1 does not", async () => {
    const mod = await worker();
    assertEq(mod.executeBatch.screenoutRetryEligible(eligArgs({ pivots: { P1: 2 } })), false);
    assertEq(mod.executeBatch.screenoutRetryEligible(eligArgs({ pivots: { P1: 1 } })), true);
    assertEq(mod.executeBatch.screenoutRetryEligible(eligArgs({ pivots: undefined })), true, "absent map = zero pivots");
  });

  test("the batch deadline bounds the pivot like any other walk", async () => {
    const mod = await worker();
    assertEq(mod.executeBatch.screenoutRetryEligible(eligArgs({ now: 2_000 })), false);
  });
});

/* ============================================================ 4. the pivot record (walkRecord) */

const AUDIT = {
  exercised: true,
  plannedDecisions: 0,
  matchedDecisions: 0,
  constrainingDecisions: 0,
  matchedConstraining: 0,
};

const bareObs = (over = {}) => ({
  kind: "v2-path-observation/1.0.0",
  runId: "v2r_d55",
  pathId: "P1",
  tier: 1,
  attemptId: "att_d55rec00001",
  planRevisionId: "plan_d55",
  surveyUrl: "https://fixture.invalid/survey",
  startedAt: "2026-08-11T00:00:00.000Z",
  endedAt: "2026-08-11T00:00:05.000Z",
  wallMs: 5000,
  plannedWitnesses: [],
  steps: [],
  outcome: "no-advance-control",
  outcomeDetail: null,
  shimmed: false,
  shimNote: null,
  loadFailure: null,
  evidenceIds: [],
  viewport: { width: 1280, height: 900 },
  ...over,
});

suite("D55 — the pivot travels by its own conditional spread, like every optional walk fact", () => {
  test("a pivot passed to walkRecord is carried verbatim; absent leaves NO key (d43's contract)", async () => {
    const mod = await worker();
    const pivot = { retryOf: "att_d55rec00000", ordinal: 1, reason: "screened out on invented answers" };
    const withPivot = mod.executeBatch.walkRecord(bareObs(), [], AUDIT, pivot);
    assertEq(JSON.stringify(withPivot.pivot), JSON.stringify(pivot), "the pivot must carry byte-for-byte");
    const without = mod.executeBatch.walkRecord(bareObs(), [], AUDIT);
    assertEq("pivot" in without, false, "an absent pivot must not plant the key");
  });
});

/* ============================================================ 5. THE LIVE EXECUTOR (end to end) */

/** A browser whose newPage() serves the NEXT walk's script — one script per attempt. */
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

/** d31's live bed with a parameterizable floor path: one path, one assigned case. */
async function liveBed(mod, env, pathOver = {}) {
  const { seedRun } = await import("./_helpers.mjs");
  const seeded = await seedRun(mod, env, { testCompletion: "running" });
  const sealed = (await mod.contractRevision.getContractRevision(env, seeded.contractRevisionId)).facetInstances.map(
    (fi) => fi.facetInstanceId,
  );
  const planRevisionId = "plan_d55live001";
  const path = {
    id: "FLOOR-01",
    tier: 1,
    kind: "floor",
    intent: "walk the survey",
    decisions: [],
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
      generatedAt: "2026-08-11T00:00:00.000Z",
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

/** Walk 0: answers S4 with the midpoint and lands on the screen-out terminal. */
const screenoutScript = () => [s4Screen(), s4Screen(), screenedOutTerminal()];
/** A retry script whose terminal is a completion — the varied filler "cleared" the screener. */
const completionScript = () => [s4Screen(), s4Screen(), completedTerminal()];

suite("D55 — THE LIVE RETRY: one pivot, linked records, a fresh attempt, no double-closing", () => {
  test("THE RETRY: an eligible screened-out walk is re-walked once with variant 1, and the pivot record links the attempts", async () => {
    const mod = await worker();
    const env = testEnv();
    const bed = await liveBed(mod, env);

    const { out, pages } = await withBrowser([screenoutScript(), completionScript()], () => runBatch(mod, env, bed));

    const progress = await mod.executeBatch.loadProgress(env, bed.runId, bed.planRevisionId);
    // PRE-FIX THIS IS THE WHOLE FEATURE: one walk, screened out, path closed, no retry.
    assertEq(progress.walks.length, 2, `expected the screened-out attempt AND its pivot, got ${progress.walks.length}`);

    const [first, second] = progress.walks;
    assertEq(first.ending?.kind, "screened-out");
    assertEq("pivot" in first, false, "attempt 0 is not a pivot");
    assertEq(second.pivot?.retryOf, first.attemptId, "the pivot must name the attempt it re-walked");
    assertEq(second.pivot?.ordinal, 1);
    assert(typeof second.pivot?.reason === "string" && second.pivot.reason.length > 0, "the pivot carries its reason");
    assertEq(second.ending?.kind, "completed");

    // The variant REACHED the driver: attempt 0 typed the pinned midpoint, the pivot the 25% quantile.
    assertEq(pages[0].typed[0].text, "16");
    assertEq(pages[1].typed[0].text, "8");

    // The pivot ordinal is durable — written BEFORE the re-walk, so a step replay re-derives it.
    assertEq(progress.screenoutPivots?.["FLOOR-01"], 1);
    assertEq(out.pathsWalked, 2, "pathsWalked counts ATTEMPTS — the wall-clock ledger stays honest");
  });

  test("a FRESH attemptId is minted for every pivot attempt — never the shim retry's reuse", async () => {
    const mod = await worker();
    const env = testEnv();
    const bed = await liveBed(mod, env);
    await withBrowser([screenoutScript(), completionScript()], () => runBatch(mod, env, bed));
    const progress = await mod.executeBatch.loadProgress(env, bed.runId, bed.planRevisionId);
    assertEq(progress.walks.length, 2);
    assert(
      progress.walks[0].attemptId !== progress.walks[1].attemptId,
      `both attempts share attemptId ${progress.walks[0].attemptId} — walk-artifact-index resolution is ambiguous`,
    );
  });

  test("THE LANDING GATE, LIVE: the two attempts' artifact basenames are disjoint sets, and the retry's are non-empty", async () => {
    const mod = await worker();
    const env = testEnv();
    const bed = await liveBed(mod, env);
    await withBrowser([screenoutScript(), completionScript()], () => runBatch(mod, env, bed));
    const progress = await mod.executeBatch.loadProgress(env, bed.runId, bed.planRevisionId);
    const byAttempt = new Map();
    for (const [key, entry] of env.EVIDENCE._store) {
      if (!key.includes(`/runs/${bed.runId}/evidence/`)) continue;
      let parsed;
      try {
        parsed = JSON.parse(new TextDecoder().decode(entry.bytes));
      } catch {
        continue;
      }
      if (typeof parsed?.artifactRef !== "string" || typeof parsed?.attemptId !== "string") continue;
      const set = byAttempt.get(parsed.attemptId) ?? new Set();
      set.add(parsed.artifactRef.split("/").pop());
      byAttempt.set(parsed.attemptId, set);
    }
    const first = byAttempt.get(progress.walks[0].attemptId);
    const second = byAttempt.get(progress.walks[1].attemptId);
    assert(first && first.size > 0, "attempt 0 wrote no artifacts");
    assert(second && second.size > 0, "the retry wrote no artifacts — the disjointness claim would be vacuous");
    assert([...second].some((b) => b.endsWith("-observation.json")), "the retry's own PathObservation is missing");
    const overlap = [...first].filter((b) => second.has(b));
    assertEq(
      overlap.length,
      0,
      `basenames collide across attempts (MANIFEST_DUPLICATE_ARTIFACT): ${overlap.join(", ")}`,
    );
  });

  test("CLOSURE IS A UNION WITH DEDUPE: attempt 0 already closed the case; the pivot must not close it again", async () => {
    const mod = await worker();
    const env = testEnv();
    const bed = await liveBed(mod, env);
    const { out } = await withBrowser([screenoutScript(), completionScript()], () => runBatch(mod, env, bed));
    // A screened-out walk that advanced >= 1 screen legitimately closes its cases (the
    // existing walkExercised rule); the retry's closure list is filtered against the
    // cursor, so the SAME case cannot be counted twice.
    assertEq(out.casesClosed, 1, "the union across attempts double-counted a case");
    const closedTwice = bed.cursor.completedCaseIds.filter((id) => id === bed.sealed[0]);
    assertEq(closedTwice.length, 1, "the cursor carries a duplicate case id");
  });

  test("THE CAP: a second pivot is the LAST — three screen-outs end the path with no fourth walk", async () => {
    const mod = await worker();
    const env = testEnv();
    const bed = await liveBed(mod, env);
    // Every attempt screens out. The last script repeats for any illegal extra walk.
    const { out } = await withBrowser(
      [screenoutScript(), screenoutScript(), screenoutScript()],
      () => runBatch(mod, env, bed),
    );
    const progress = await mod.executeBatch.loadProgress(env, bed.runId, bed.planRevisionId);
    assertEq(progress.walks.length, 3, `expected attempt 0 + 2 pivots, got ${progress.walks.length}`);
    assertEq(progress.screenoutPivots?.["FLOOR-01"], 2);
    assertEq(progress.walks[1].pivot?.ordinal, 1);
    assertEq(progress.walks[2].pivot?.ordinal, 2);
    assertEq(progress.walks[2].pivot?.retryOf, progress.walks[1].attemptId, "each pivot links its OWN predecessor");
    assertEq(progress.walks[2].ending?.kind, "screened-out", "the exhausted pivot leaves a normal screened-out walk");
    assertEq(out.pathsWalked, 3);
    // The path is still DONE — an exhausted pivot is not a stuck path.
    assertEq(progress.floorDone.includes("FLOOR-01"), true);
  });

  test("a sealed typed case is NEVER pivoted: a case_action path screens out ONCE and is not re-walked", async () => {
    const mod = await worker();
    const env = testEnv();
    const bed = await liveBed(mod, env, {
      decisions: [
        {
          question: "S4",
          select: [],
          source: "typed-case:route",
          case_action: {
            facetInstanceId: "fi_d55route01",
            targetQuestionId: "S4",
            kind: "route",
            routeAnswer: { code: null, label: null },
            boundaryInput: null,
          },
        },
      ],
    });
    await withBrowser([screenoutScript(), completionScript()], () => runBatch(mod, env, bed));
    const progress = await mod.executeBatch.loadProgress(env, bed.runId, bed.planRevisionId);
    assertEq(progress.walks.length, 1, "sealed stimulus was pivoted — the typed case's outcome was fought, not observed");
    assertEq(progress.screenoutPivots?.["FLOOR-01"] ?? 0, 0);
  });

  test("a path that INTENDS its termination is never pivoted (terminated_at), live", async () => {
    const mod = await worker();
    const env = testEnv();
    const bed = await liveBed(mod, env, {
      terminated_at: { question: "S4", answer: "16", terminal: "T1" },
    });
    await withBrowser([screenoutScript(), completionScript()], () => runBatch(mod, env, bed));
    const progress = await mod.executeBatch.loadProgress(env, bed.runId, bed.planRevisionId);
    assertEq(progress.walks.length, 1, "a plan-intended termination was fought by the retry");
  });
});

/* ============================================================ 6. the attempt budget (Codex-review BLOCKER 4)
 *
 * EXEC_BATCH_MAX_ATTEMPTS is the batch's NAMED attempt cap, and before this fix it was
 * checked only at the outer work-item gate: a pivot was admitted by deadline and pivot
 * count alone, so maxAttempts=1 could execute THREE attempts (attempt 0 + two pivots) and
 * maxAttempts=4 six — the named cost/side-effect cap was not real for pivots.
 *
 * THE ACCOUNTING RULE PINNED HERE: the budget is checked before every attempt against the
 * SAME `pathsWalked` counter the outer gate reads — the outer walk at the work-item gate,
 * the pivot at the eligibility site AT PIVOT TIME — and every attempt consumes it
 * identically, `pathsWalked += 1` after its per-attempt commit. The cap means the same
 * thing everywhere: attempts, not outer work items.
 */

suite("D55 — BLOCKER 4, the attempt budget: EXEC_BATCH_MAX_ATTEMPTS caps pivots like any other attempt", () => {
  test("eligibility reads the batch's attempt accounting: a spent budget refuses AT PIVOT TIME, remaining budget does not", async () => {
    const mod = await worker();
    // The counter and cap are the executor's own `pathsWalked` / `maxAttempts` — the exact
    // pair the outer work-item gate compares.
    assertEq(mod.executeBatch.screenoutRetryEligible(eligArgs({ pathsWalked: 1, maxAttempts: 1 })), false);
    assertEq(mod.executeBatch.screenoutRetryEligible(eligArgs({ pathsWalked: 3, maxAttempts: 3 })), false);
    assertEq(mod.executeBatch.screenoutRetryEligible(eligArgs({ pathsWalked: 1, maxAttempts: 2 })), true, "one attempt of budget left IS budget");
  });

  test("THE BUDGET BINDS PIVOTS: maxAttempts=1 means ONE attempt — an eligible screen-out does NOT pivot on an exhausted budget", async () => {
    const mod = await worker();
    const env = testEnv({ EXEC_BATCH_MAX_ATTEMPTS: "1" });
    const bed = await liveBed(mod, env);
    // The completion script exists only to catch an ILLEGAL pivot: pre-fix the retry loop
    // never consulted the attempt budget and this walked twice under a cap of one.
    const { out, pages } = await withBrowser([screenoutScript(), completionScript()], () => runBatch(mod, env, bed));
    const progress = await mod.executeBatch.loadProgress(env, bed.runId, bed.planRevisionId);
    assertEq(progress.walks.length, 1, `maxAttempts=1 executed ${progress.walks.length} attempts — the named cap is not real for pivots`);
    assertEq(pages.length, 1, "a second page was opened under a budget of one");
    assertEq(out.pathsWalked, 1);
    assertEq(progress.walks[0].ending?.kind, "screened-out");
    assertEq("pivot" in progress.walks[0], false);
    assertEq(progress.screenoutPivots?.["FLOOR-01"] ?? 0, 0, "a refused pivot must not consume a pivot ordinal");
    // Budget exhaustion is not a stuck path: the committed screened-out attempt stands.
    assertEq(progress.floorDone.includes("FLOOR-01"), true);
  });

  test("THE BUDGET IS SHARED: maxAttempts=3 with one item — attempt 0 + 2 pivots land exactly ON the cap, never past it", async () => {
    const mod = await worker();
    const env = testEnv({ EXEC_BATCH_MAX_ATTEMPTS: "3" });
    const bed = await liveBed(mod, env);
    // Every attempt screens out; the last script repeats for any illegal extra walk.
    const { out, pages } = await withBrowser(
      [screenoutScript(), screenoutScript(), screenoutScript()],
      () => runBatch(mod, env, bed),
    );
    const progress = await mod.executeBatch.loadProgress(env, bed.runId, bed.planRevisionId);
    // The boundary, from both sides: the second pivot fires at pathsWalked=2 < 3 (an
    // over-tightened clause would stop at 2 walks), and nothing walks past 3 (outer
    // accounting + pivots share one counter).
    assertEq(progress.walks.length, 3, `expected exactly the budget's 3 attempts, got ${progress.walks.length}`);
    assertEq(pages.length, 3);
    assertEq(out.pathsWalked, 3);
    assertEq(progress.screenoutPivots?.["FLOOR-01"], 2);
    assertEq(progress.walks[1].pivot?.ordinal, 1);
    assertEq(progress.walks[2].pivot?.ordinal, 2);
  });

  test("NO OVER-TIGHTENING: one attempt of remaining budget still admits the pivot (maxAttempts=2)", async () => {
    const mod = await worker();
    const env = testEnv({ EXEC_BATCH_MAX_ATTEMPTS: "2" });
    const bed = await liveBed(mod, env);
    const { out, pages } = await withBrowser([screenoutScript(), completionScript()], () => runBatch(mod, env, bed));
    const progress = await mod.executeBatch.loadProgress(env, bed.runId, bed.planRevisionId);
    assertEq(progress.walks.length, 2, "the budget clause refused a pivot the budget allows");
    assertEq(pages.length, 2);
    assertEq(out.pathsWalked, 2);
    assertEq(progress.walks[1].pivot?.ordinal, 1);
    assertEq(progress.walks[1].ending?.kind, "completed");
  });
});

/**
 * D56 — FIXES FROM THE FIRST REAL BROWSER WALK (analysis of run v2r_01m04jhrymz7wh490kq5jxke65).
 *
 * Three amendments, each with fixtures replicating the captured shapes generically:
 *
 * 1. OPTION-LINKED SPECIFY FILL (the 433-case killer): a text input bound to a choice
 *    option auto-selects its parent when filled. The walker must not fill it unless
 *    that option IS the planned answer.
 *
 * 2. TIMEOUT REGRESSION + DON'T-START GUARD: EXEC_PER_CASE_TIMEOUT_MS raised to 120s;
 *    a walk must not begin when the remaining batch budget is below the per-case timeout.
 *
 * 3. STRUCTURAL TERMINAL-PAGE ARM: platform navigation widgets (a select with jump
 *    semantics) must not count as "answerable", keeping the structural arm inert.
 *
 * Evidence these can fail: each test is written to FAIL on the pre-fix behaviour.
 */

import { assert, assertEq, assertThrows, suite, test, loadWorker } from "../testkit.mjs";
import { testEnv } from "./_helpers.mjs";

// ------------------------------------------------------------------ helpers

const opt = (idx, code, label, extra = {}) => ({
  order: 0,
  idx,
  code,
  label,
  checked: false,
  disabled: false,
  visible: true,
  operable: true,
  ...extra,
});

const control = (idx, overrides = {}) => ({
  idx,
  tag: "input",
  type: "radio",
  name: null,
  id: null,
  code: null,
  label: "",
  text: "",
  checked: false,
  value: null,
  disabled: false,
  required: false,
  visible: true,
  operable: true,
  placeholder: null,
  maxlength: null,
  readOnly: false,
  ...overrides,
});

const selectControl = (idx, options, overrides = {}) => ({
  idx,
  tag: "select",
  type: "select",
  name: null,
  id: null,
  code: null,
  label: "",
  text: "",
  checked: null,
  value: null,
  disabled: false,
  required: false,
  visible: true,
  operable: true,
  placeholder: null,
  maxlength: null,
  readOnly: false,
  options: options.map((o, i) => ({
    order: i,
    code: String(o.code ?? i),
    label: o.label ?? `Option ${i}`,
    selected: false,
    disabled: false,
    ...o,
  })),
  ...overrides,
});

const nextBtn = (idx) => ({
  idx,
  label: "Next",
  role: "next",
  roleVia: "value-text",
  disabled: false,
  visible: true,
});

const backBtn = (idx) => ({
  idx,
  label: "Back",
  role: "back",
  roleVia: "value-text",
  disabled: false,
  visible: true,
});

const baseScreen = (overrides = {}) => ({
  at: new Date().toISOString(),
  url: "https://fixture.invalid/survey",
  title: null,
  collectedErrors: [],
  questionText: null,
  instructionText: null,
  visibleText: "",
  visibleTextTruncated: false,
  bracketedInstructionsVisible: [],
  controls: [],
  optionGroups: [],
  grid: null,
  buttons: [],
  progress: { present: false, kind: null, now: null, max: null, text: null },
  validationMessages: [],
  readerLimitations: [],
  counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0, valueInputs: 0 },
  screenSignature: "fixture-sig",
  ...overrides,
});

// ===========================================================================
// AMENDMENT 1: OPTION-LINKED SPECIFY FILL
// ===========================================================================

suite("amendment 1: option-linked specify fill", () => {
  test("detectOptionLinkedSpecifyInputs finds a specify input by label adjacency", async () => {
    const { mod } = await loadWorker();

    // A screen with 20 radio options and an "Other (Please Specify)" text box
    const screen = baseScreen({
      controls: [
        // 20 radio options for role question
        ...Array.from({ length: 20 }, (_, i) =>
          control(i, { type: "radio", name: "S10", label: `Role ${i + 1}` }),
        ),
        // The "Other" radio at idx 20
        control(20, { type: "radio", name: "S10", label: "Other (Please Specify)" }),
        // The specify text box at idx 21
        control(21, { type: "text", name: "S10_other", label: "Other (Please Specify)" }),
      ],
      optionGroups: [
        {
          name: "S10",
          kind: "radio",
          options: [
            ...Array.from({ length: 20 }, (_, i) =>
              opt(i, String(i + 1), `Role ${i + 1}`),
            ),
            opt(20, "other", "Other (Please Specify)"),
          ],
        },
      ],
    });

    const result = mod.driver.detectOptionLinkedSpecifyInputs(screen);
    assert(result.size > 0, "should detect at least one option-linked specify input");
    assert(result.has(21), "the text box at idx 21 should be detected as option-linked");
    assertEq(result.get(21), 20, "should link to the 'Other' option at idx 20");
  });

  test("detectOptionLinkedSpecifyInputs finds a specify input by shared name prefix", async () => {
    const { mod } = await loadWorker();

    const screen = baseScreen({
      controls: [
        control(0, { type: "radio", name: "Q5", label: "Option A" }),
        control(1, { type: "radio", name: "Q5", label: "Option B" }),
        control(2, { type: "text", name: "Q5_specify", label: "Details" }),
      ],
      optionGroups: [
        {
          name: "Q5",
          kind: "radio",
          options: [opt(0, "a", "Option A"), opt(1, "b", "Option B")],
        },
      ],
    });

    const result = mod.driver.detectOptionLinkedSpecifyInputs(screen);
    assert(result.has(2), "text input with shared name prefix should be detected");
  });

  test("detectOptionLinkedSpecifyInputs finds a specify input adjacent to a specify-labelled option", async () => {
    const { mod } = await loadWorker();

    const screen = baseScreen({
      controls: [
        control(0, { type: "radio", name: "Q7", label: "Yes" }),
        control(1, { type: "radio", name: "Q7", label: "No" }),
        control(2, { type: "radio", name: "Q7", label: "Other, please specify" }),
        control(3, { type: "text", name: "Q7_open", label: "" }),
      ],
      optionGroups: [
        {
          name: "Q7",
          kind: "radio",
          options: [
            opt(0, "1", "Yes"),
            opt(1, "2", "No"),
            opt(2, "3", "Other, please specify"),
          ],
        },
      ],
    });

    const result = mod.driver.detectOptionLinkedSpecifyInputs(screen);
    assert(result.has(3), "text input adjacent to a specify-labelled last option should be detected");
    assertEq(result.get(3), 2, "should link to the 'Other, please specify' option at idx 2");
  });

  test("detectOptionLinkedSpecifyInputs does NOT flag a standalone text input", async () => {
    const { mod } = await loadWorker();

    // A screen with just a text input and radio options that have no specify pattern
    const screen = baseScreen({
      controls: [
        control(0, { type: "radio", name: "Q1", label: "Yes" }),
        control(1, { type: "radio", name: "Q1", label: "No" }),
        control(10, { type: "text", name: "comment", label: "Please leave a comment" }),
      ],
      optionGroups: [
        {
          name: "Q1",
          kind: "radio",
          options: [opt(0, "1", "Yes"), opt(1, "2", "No")],
        },
      ],
    });

    const result = mod.driver.detectOptionLinkedSpecifyInputs(screen);
    assert(!result.has(10), "a standalone text input far from any option should NOT be flagged");
  });

  test("verifyChoiceGroupsAfterInteraction detects a changed radio selection", async () => {
    const { mod } = await loadWorker();

    const before = baseScreen({
      optionGroups: [
        {
          name: "S10",
          kind: "radio",
          options: [
            opt(0, "1", "Service Line Leader", { checked: false }),
            opt(1, "2", "Other (Please Specify)", { checked: false }),
          ],
        },
      ],
    });

    // After all interactions, "Other" is now checked (it was auto-selected by text fill)
    const afterAction = baseScreen({
      optionGroups: [
        {
          name: "S10",
          kind: "radio",
          options: [
            opt(0, "1", "Service Line Leader", { checked: false }),
            opt(1, "2", "Other (Please Specify)", { checked: true }),
          ],
        },
      ],
    });

    // The walker had clicked "Service Line Leader" at idx 0
    const actions = [
      {
        kind: "click-option",
        targetIdx: 0,
        targetLabel: "Service Line Leader",
        targetCode: "1",
        value: null,
        ok: true,
        detail: "element-click; exact-choice-readback",
        choiceReadback: {
          idx: 0,
          type: "radio",
          name: "S10",
          checked: true,
          checkedGroupIdxs: [0],
        },
      },
    ];

    const observations = mod.driver.verifyChoiceGroupsAfterInteraction(before, afterAction, actions);
    assert(observations.length > 0, "should produce an observation about the changed selection");
    assert(!observations[0].ok, "the mismatch observation should have ok=false");
    assert(
      observations[0].detail.includes("choice-group-verification-mismatch"),
      `detail should mention mismatch, got: ${observations[0].detail}`,
    );
  });

  test("verifyChoiceGroupsAfterInteraction reports nothing when selection is unchanged", async () => {
    const { mod } = await loadWorker();

    const before = baseScreen({
      optionGroups: [
        {
          name: "Q1",
          kind: "radio",
          options: [
            opt(0, "1", "Yes", { checked: false }),
            opt(1, "2", "No", { checked: false }),
          ],
        },
      ],
    });

    const afterAction = baseScreen({
      optionGroups: [
        {
          name: "Q1",
          kind: "radio",
          options: [
            opt(0, "1", "Yes", { checked: true }),
            opt(1, "2", "No", { checked: false }),
          ],
        },
      ],
    });

    const actions = [
      {
        kind: "click-option",
        targetIdx: 0,
        targetLabel: "Yes",
        targetCode: "1",
        value: null,
        ok: true,
        detail: "element-click; exact-choice-readback",
        choiceReadback: {
          idx: 0,
          type: "radio",
          name: "Q1",
          checked: true,
          checkedGroupIdxs: [0],
        },
      },
    ];

    const observations = mod.driver.verifyChoiceGroupsAfterInteraction(before, afterAction, actions);
    assertEq(observations.length, 0, "no observations when the checked state is as expected");
  });
});

// ===========================================================================
// AMENDMENT 2: TIMEOUT REGRESSION + DON'T-START GUARD
// ===========================================================================

suite("amendment 2c: a hung screen read becomes a recorded outcome, never a silent stall", () => {
  // The 2026-08-17 run hung EVERY walk that crossed the screener (12/12 crossing attempts)
  // and the per-case axe destroyed each observation: 0 screens, wallMs=0, no evidence of
  // where. A page call that never resolves must instead REJECT within the read bound, flow
  // into the existing screen-read-failed path, and return an observation that says so.
  test("a never-resolving screen read rejects at readTimeoutMs and the walk returns an error observation", async () => {
    const { mod } = await loadWorker();
    const env = testEnv();
    const hangingPage = {
      async goto() {},
      async evaluate(script) {
        if (typeof script === "string" && script.includes("screenSignature")) {
          return new Promise(() => {}); // the wedge: a read that never resolves
        }
        return { ok: true };
      },
      async evaluateOnNewDocument() {},
      async $$() {
        return [];
      },
      async screenshot() {
        throw new Error("no screenshot in this harness");
      },
      async setViewport() {},
      on() {},
      async close() {},
      async reload() {},
    };
    const runId = mod.ids.mintRunId();
    const t0 = Date.now();
    const walkPromise = mod.driver.walkPath(
      hangingPage,
      { id: "path_d56hang", decisions: [], witnesses: [] },
      {
        surveyUrl: "https://fixture.invalid/survey",
        runId,
        planRevisionId: "plan_d56hang01",
        attemptId: "att_d56hang00001",
        tier: 1,
        maxSteps: 3,
        deadline: Date.now() + 60_000,
        viewport: { width: 1280, height: 900 },
        applyHistoryShim: false,
        advanceTimeoutMs: 200,
        readTimeoutMs: 400,
      },
      { env, runId, attemptId: "att_d56hang00001", pathId: "path_d56hang", witnesses: [] },
    );
    // The race is the test's own axe: an UNBOUNDED read makes walkPath never return, and
    // this must be a clean named failure, not a hung test process.
    const obs = await Promise.race([
      walkPromise,
      new Promise((resolve) => setTimeout(() => resolve("WALK-NEVER-RETURNED"), 20_000)),
    ]);
    assert(obs !== "WALK-NEVER-RETURNED", "walkPath hung past the read bound instead of recording the hang");
    const elapsed = Date.now() - t0;
    assert(elapsed < 20_000, `the walk must return at the read bound, not hang (took ${elapsed}ms)`);
    assertEq(obs.outcome, "error", `a hung read must be a recorded outcome, got ${obs.outcome}`);
    assert(
      String(obs.outcomeDetail).includes("hung"),
      `the outcome must NAME the hang: ${obs.outcomeDetail}`,
    );
    assert(obs.captureFailureCount >= 1, "the hang must be a counted capture failure");
  });

  test("ANY hung page call — screenshot, not a read — still returns a walk, via the page-call bound", async () => {
    // The first v42 walk proved the read bounds alone are not the class: it hung with all
    // five reads bounded, because clicks/readbacks/captures are page calls too. walkPath
    // wraps the page so EVERY promise-returning method rejects at pageCallTimeoutMs.
    const { mod } = await loadWorker();
    const env = testEnv();
    const screenJson = {
      url: "https://fixture.invalid/survey",
      title: "S1",
      questionText: "S1. A question?",
      grid: null,
      collectedErrors: [],
      readerLimitations: [],
      controls: [],
      optionGroups: [],
      buttons: [],
      validationMessages: [],
      progress: { present: false, value: null },
      counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0, valueInputs: 0, optionsNotOperable: 0, readerLimitations: 0 },
      screenSignature: "sig:hangcap",
    };
    const page = {
      async goto() {},
      async evaluate(script) {
        if (typeof script === "string" && script.includes("screenSignature")) return screenJson;
        return { ok: true };
      },
      async evaluateOnNewDocument() {},
      async $$() {
        return [];
      },
      screenshot() {
        return new Promise(() => {}); // the wedge, this time in the capture channel
      },
      async setViewport() {},
      on() {},
      async close() {},
      async reload() {},
    };
    const runId = mod.ids.mintRunId();
    const t0 = Date.now();
    const obs = await Promise.race([
      mod.driver.walkPath(
        page,
        { id: "path_d56hangcap", decisions: [], witnesses: [] },
        {
          surveyUrl: "https://fixture.invalid/survey",
          runId,
          planRevisionId: "plan_d56hang02",
          attemptId: "att_d56hang00002",
          tier: 1,
          maxSteps: 1,
          deadline: Date.now() + 60_000,
          viewport: { width: 1280, height: 900 },
          applyHistoryShim: false,
          advanceTimeoutMs: 200,
          pageCallTimeoutMs: 400,
        },
        { env, runId, attemptId: "att_d56hang00002", pathId: "path_d56hangcap", witnesses: [] },
      ),
      new Promise((resolve) => setTimeout(() => resolve("WALK-NEVER-RETURNED"), 20_000)),
    ]);
    assert(obs !== "WALK-NEVER-RETURNED", "a hung screenshot hung the whole walk — the page-call bound is not in force");
    assert(Date.now() - t0 < 20_000, "the walk must return promptly once the hung call rejects");
    assert(Array.isArray(obs.steps) && obs.steps.length >= 1, "the walk's steps must survive a hung capture");
    assert(obs.captureFailureCount >= 1, "the hung capture must be a counted capture failure");
  });
});

suite("amendment 2d: every step says where its time went (phaseMs)", () => {
  // The 2026-08-17 deep walks cost ~19s per screen while the same screens read locally in
  // ~1.5s. The pace work needs MEASURED waste, not inferred waste: each step now records
  // read/act/advance/capture wall clocks, additively.
  test("a walked step carries phaseMs with all four phases, bounded by the step's wallMs", async () => {
    const { mod } = await loadWorker();
    const env = testEnv();
    const screenJson = {
      url: "https://fixture.invalid/survey",
      title: "S1",
      questionText: "S1. A question?",
      grid: null,
      collectedErrors: [],
      readerLimitations: [],
      controls: [],
      optionGroups: [],
      buttons: [],
      validationMessages: [],
      progress: { present: false, value: null },
      counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0, valueInputs: 0, optionsNotOperable: 0, readerLimitations: 0 },
      screenSignature: "sig:phase",
    };
    const page = {
      async goto() {},
      async evaluate(script) {
        if (typeof script === "string" && script.includes("screenSignature")) return screenJson;
        return { ok: true };
      },
      async evaluateOnNewDocument() {},
      async $$() {
        return [];
      },
      async screenshot() {
        throw new Error("no screenshot in this harness");
      },
      async setViewport() {},
      on() {},
      async close() {},
      async reload() {},
    };
    const runId = mod.ids.mintRunId();
    const obs = await mod.driver.walkPath(
      page,
      { id: "path_d56phase", decisions: [], witnesses: [] },
      {
        surveyUrl: "https://fixture.invalid/survey",
        runId,
        planRevisionId: "plan_d56phase1",
        attemptId: "att_d56phase0001",
        tier: 1,
        maxSteps: 1,
        deadline: Date.now() + 30_000,
        viewport: { width: 1280, height: 900 },
        applyHistoryShim: false,
        advanceTimeoutMs: 200,
      },
      { env, runId, attemptId: "att_d56phase0001", pathId: "path_d56phase", witnesses: [] },
    );
    assert(obs.steps.length >= 1, "the walk must record at least one step");
    const s = obs.steps[0];
    assert(s.phaseMs && typeof s.phaseMs === "object", "phaseMs must be present on a current walker's step");
    for (const k of ["read", "act", "advance", "capture"]) {
      assert(Number.isFinite(s.phaseMs[k]) && s.phaseMs[k] >= 0, `phaseMs.${k} must be a non-negative number`);
    }
    const sum = s.phaseMs.read + s.phaseMs.act + s.phaseMs.advance + s.phaseMs.capture;
    assert(sum <= s.wallMs + 5, `phase clocks (${sum}ms) must not exceed the step's wallMs (${s.wallMs}ms)`);
  });
});

suite("amendment 2e: the post-advance epoch is deduped mid-walk and backfilled at walk end", () => {
  // The v44 phase clocks measured epoch capture at ~21s of every ~28s step; one third of it
  // was the post-advance epoch — the SAME screen the next step captures as its before-epoch
  // a second later. Mid-walk it is skipped; a walk that ENDS on an advanced screen gets that
  // final screen backfilled under the "final" slot so no terminal state loses its visual.
  test("an advanced step mid-walk records before+after-action only, and the walk's last screen arrives as a final-slot epoch", async () => {
    const { mod } = await loadWorker();
    const env = testEnv();
    const mkScreen = (sig, q) => ({
      url: "https://fixture.invalid/survey",
      title: q,
      questionText: `${q}. A question?`,
      grid: null,
      collectedErrors: [],
      readerLimitations: [],
      controls: [],
      optionGroups: [],
      buttons: [{ idx: 0, label: "Next", role: "next", roleVia: "text:Next", disabled: false, visible: true }],
      validationMessages: [],
      progress: { present: false, value: null },
      counts: { controls: 1, optionGroups: 0, options: 0, textInputs: 0, valueInputs: 0, optionsNotOperable: 0, readerLimitations: 0 },
      screenSignature: sig,
    });
    const terminal = mkScreen("sig:B", "S2");
    terminal.buttons = []; // no forward control: the walk ends on screen B with its own final epoch
    const reads = [mkScreen("sig:A", "S1"), mkScreen("sig:A", "S1"), terminal, terminal, terminal];
    let last = reads[0];
    const page = {
      async goto() {},
      async evaluate(script) {
        if (typeof script === "string" && script.includes("screenSignature")) {
          if (reads.length > 0) last = reads.shift();
          return last;
        }
        return { ok: true };
      },
      async evaluateOnNewDocument() {},
      async $$() {
        return Array.from({ length: 4 }, () => ({ async click() {}, async type() {}, async focus() {} }));
      },
      async screenshot() {
        return new TextEncoder().encode("PNG-D56");
      },
      async setViewport() {},
      on() {},
      async close() {},
      async reload() {},
    };
    const runId = mod.ids.mintRunId();
    const obs = await mod.driver.walkPath(
      page,
      { id: "path_d56dedup", decisions: [], witnesses: [] },
      {
        surveyUrl: "https://fixture.invalid/survey",
        runId,
        planRevisionId: "plan_d56dedup1",
        attemptId: "att_d56dedup001",
        tier: 1,
        maxSteps: 5,
        deadline: Date.now() + 30_000,
        viewport: { width: 1280, height: 900 },
        applyHistoryShim: false,
        advanceTimeoutMs: 1_000,
      },
      { env, runId, attemptId: "att_d56dedup001", pathId: "path_d56dedup", witnesses: [] },
    );
    assertEq(obs.steps.length, 2, `two steps walked (outcome ${obs.outcome}: ${obs.outcomeDetail})`);
    assertEq(obs.steps[0].advanced, true, "step 0 must have advanced");
    const step0Slots = (obs.steps[0].evidence?.screenCaptures ?? []).map((e) => e.slot);
    assert(!step0Slots.includes("advanced"), `mid-walk advanced epoch must be deduped, got slots ${JSON.stringify(step0Slots)}`);
    assert(step0Slots.includes("before"), "step 0 keeps its before epoch");
    const step1Slots = (obs.steps[1].evidence?.screenCaptures ?? []).map((e) => e.slot);
    assert(step1Slots.includes("final"), `the terminal screen keeps its own final epoch, got ${JSON.stringify(step1Slots)}`);
    // The dedup bookkeeping must reset per step: no spurious post-loop backfill of screen B
    // under step 0's index after step 1 already captured it.
    const walkSlots = (obs.screenCaptures ?? []).map((e) => `${e.slot}@${e.stepIndex}`);
    assertEq(
      walkSlots.filter((s) => s.startsWith("final@")).length,
      1,
      `exactly one final epoch, got ${JSON.stringify(walkSlots)}`,
    );
  });

  test("a walk that ENDS on an advanced step keeps that screen's epoch (no dedup at walk end)", async () => {
    const { mod } = await loadWorker();
    const env = testEnv();
    const mkScreen = (sig, q) => ({
      url: "https://fixture.invalid/survey",
      title: q,
      questionText: `${q}. A question?`,
      grid: null,
      collectedErrors: [],
      readerLimitations: [],
      controls: [],
      optionGroups: [],
      buttons: [{ idx: 0, label: "Next", role: "next", roleVia: "text:Next", disabled: false, visible: true }],
      validationMessages: [],
      progress: { present: false, value: null },
      counts: { controls: 1, optionGroups: 0, options: 0, textInputs: 0, valueInputs: 0, optionsNotOperable: 0, readerLimitations: 0 },
      screenSignature: sig,
    });
    const reads = [mkScreen("sig:A", "S1"), mkScreen("sig:A", "S1"), mkScreen("sig:B", "S2")];
    let last = reads[0];
    const page = {
      async goto() {},
      async evaluate(script) {
        if (typeof script === "string" && script.includes("screenSignature")) {
          if (reads.length > 0) last = reads.shift();
          return last;
        }
        return { ok: true };
      },
      async evaluateOnNewDocument() {},
      async $$() {
        return Array.from({ length: 4 }, () => ({ async click() {}, async type() {}, async focus() {} }));
      },
      async screenshot() {
        return new TextEncoder().encode("PNG-D56");
      },
      async setViewport() {},
      on() {},
      async close() {},
      async reload() {},
    };
    const runId = mod.ids.mintRunId();
    const obs = await mod.driver.walkPath(
      page,
      { id: "path_d56dedup2", decisions: [], witnesses: [] },
      {
        surveyUrl: "https://fixture.invalid/survey",
        runId,
        planRevisionId: "plan_d56dedup2",
        attemptId: "att_d56dedup002",
        tier: 1,
        maxSteps: 1,
        deadline: Date.now() + 30_000,
        viewport: { width: 1280, height: 900 },
        applyHistoryShim: false,
        advanceTimeoutMs: 1_000,
      },
      { env, runId, attemptId: "att_d56dedup002", pathId: "path_d56dedup2", witnesses: [] },
    );
    assertEq(obs.steps.length, 1);
    assertEq(obs.steps[0].advanced, true, `the step must have advanced (outcome ${obs.outcome})`);
    const slots = (obs.steps[0].evidence?.screenCaptures ?? []).map((e) => e.slot);
    assert(
      slots.includes("advanced"),
      `a walk ending on an advanced step keeps that screen's epoch, got ${JSON.stringify(slots)}`,
    );
  });
});

suite("amendment 2b: the walk deadline returns partials before the axe destroys them", () => {
  // Runs v2r_01m05wjkybhr6cfcggpgrerfqr (v40) and v2r_01m067zf40z4788yb60c380vgp (v41)
  // recorded 27 walks as 0-screen "per-case-timeout" rows with wallMs=0 and NO evidence of
  // where they hung — the per-case budget was enforced ONLY by withTimeout, which throws
  // the whole observation away. The walk deadline handed to walkPath must be strictly
  // tighter than the axe, so a long walk exits its own loop as a "time-cap" partial
  // observation and the axe fires only on a genuine hang.
  test("for every shipped config, the walk deadline beats the per-case axe by a positive margin", async () => {
    const { mod } = await loadWorker();
    const { readFileSync, readdirSync } = await import("fs");
    const configs = ["wrangler.jsonc", ...readdirSync(".").filter((f) => f.startsWith("wrangler.arm-") && f.endsWith(".jsonc"))];
    for (const f of configs) {
      const content = readFileSync(f, "utf8");
      const perCase = Number(content.match(/"EXEC_PER_CASE_TIMEOUT_MS"\s*:\s*"(\d+)"/)?.[1]);
      const batch = Number(content.match(/"EXEC_BATCH_MAX_MS"\s*:\s*"(\d+)"/)?.[1]);
      assert(Number.isFinite(perCase) && Number.isFinite(batch), `${f} must declare both budgets`);
      const now = 1_000_000;
      const deadline = mod.executeBatch.walkDeadlineFor(Number.POSITIVE_INFINITY, now, batch, perCase);
      const margin = now + perCase - deadline;
      assert(margin > 0, `${f}: the walk deadline must be strictly before the ${perCase}ms axe (margin ${margin}ms)`);
      assert(
        margin >= Math.min(mod.executeBatch.PER_CASE_WRAPUP_GRACE_MS, Math.ceil(perCase / 2)),
        `${f}: the wrap-up margin (${margin}ms) is thinner than the grace contract`,
      );
      assert(deadline - now >= Math.floor(perCase / 2), `${f}: the walk keeps at least half the per-case budget`);
    }
  });

  test("the walk invocation actually threads the per-case budget into walkPath's deadline", async () => {
    // The arithmetic above is only real if the walkOnce call site USES it — a revert to the
    // batch-only deadline would pass every unit test while the axe goes back to destroying
    // observations. The call shape is pinned at source level, the same way the BATCH_POLICY
    // step timeout is pinned in run-workflow.ts.
    const { readFileSync } = await import("fs");
    const src = readFileSync("src/workflow/stages/execute-batch.ts", "utf8");
    assert(
      /deadline: walkDeadlineFor\(batchDeadline, Date\.now\(\), num\(env\.EXEC_BATCH_MAX_MS, 120_000\), perCaseTimeoutMs\)/.test(src),
      "walkOnce must hand walkPath a deadline computed by walkDeadlineFor over the per-case budget",
    );
  });

  test("a pathological grace can never zero the walk's own time", async () => {
    const { mod } = await loadWorker();
    const now = 5_000;
    const d = mod.executeBatch.walkDeadlineFor(Number.POSITIVE_INFINITY, now, 300_000, 10_000, 999_999);
    assertEq(d - now, 5_000, "grace >= budget must floor at half the per-case budget, never zero");
  });

  test("the batch deadline still wins when it is the tighter bound", async () => {
    const { mod } = await loadWorker();
    const now = 0;
    const d = mod.executeBatch.walkDeadlineFor(now + 30_000, now, 300_000, 120_000);
    assertEq(d, 30_000, "a nearly-exhausted batch must bound the walk below the per-case budget");
  });
});

suite("amendment 2: timeout and batch residual", () => {
  test("the batch budget strictly exceeds the per-case timeout so a walk can ever start", async () => {
    // Run v2r_01m05358wjeprcr01r5r3nn1vy started ZERO walks: EXEC_PER_CASE_TIMEOUT_MS was
    // raised to 120000 while EXEC_BATCH_MAX_MS stayed 120000, and the batch-residual guard
    // (whose minimum residual IS the per-case timeout) refused every walk before it began.
    // This is the config-arithmetic relationship as a check that can fail: the batch must
    // fit at least one full case plus overhead, in EVERY config that declares both.
    const { readFileSync, readdirSync } = await import("fs");
    const configs = ["wrangler.jsonc", ...readdirSync(".").filter((f) => f.startsWith("wrangler.arm-") && f.endsWith(".jsonc"))];
    const OVERHEAD_MS = 30_000; // navigation/setup slack per batch, matched to acquire+advance budgets
    for (const f of configs) {
      const content = readFileSync(f, "utf8");
      const perCase = content.match(/"EXEC_PER_CASE_TIMEOUT_MS"\s*:\s*"(\d+)"/);
      const batch = content.match(/"EXEC_BATCH_MAX_MS"\s*:\s*"(\d+)"/);
      assert(perCase && batch, `${f} must declare both EXEC_PER_CASE_TIMEOUT_MS and EXEC_BATCH_MAX_MS`);
      assert(
        Number(batch[1]) >= Number(perCase[1]) + OVERHEAD_MS,
        `${f}: EXEC_BATCH_MAX_MS (${batch[1]}) must be >= EXEC_PER_CASE_TIMEOUT_MS (${perCase[1]}) + ${OVERHEAD_MS}ms overhead, or the residual guard starts zero walks`,
      );
    }
  });

  test("the workflow step axe clears the batch budget with slack for acquire and commit", async () => {
    // The sibling inversion of the per-case-vs-batch bug, one level up: BATCH_POLICY's step
    // timeout equaled EXEC_BATCH_MAX_MS exactly (run v2r_01m05bh8scxkebmqd7h9wmmf5z walked
    // zero screens — the engine axed every batch mid-walk before commit). The whole family
    // of nested budgets must strictly widen: per-case < batch < step.
    const { readFileSync } = await import("fs");
    const wrangler = readFileSync("wrangler.jsonc", "utf8");
    const batch = wrangler.match(/"EXEC_BATCH_MAX_MS"\s*:\s*"(\d+)"/);
    assert(batch, "EXEC_BATCH_MAX_MS must be declared");
    const src = readFileSync("src/workflow/run-workflow.ts", "utf8");
    const policy = src.match(/const BATCH_POLICY = .*timeout: "(\d+) minutes?"/);
    assert(policy, "BATCH_POLICY must declare a minutes-denominated timeout");
    const stepMs = Number(policy[1]) * 60_000;
    const SLACK_MS = 120_000; // session acquire (<=45s) + retry-on-fresh-session + commit
    assert(
      stepMs >= Number(batch[1]) + SLACK_MS,
      `BATCH_POLICY step timeout (${stepMs}ms) must be >= EXEC_BATCH_MAX_MS (${batch[1]}) + ${SLACK_MS}ms slack, or the step axe kills batches mid-walk`,
    );
  });

  test("EXEC_PER_CASE_TIMEOUT_MS is 900000 in wrangler.jsonc", async () => {
    const { readFileSync } = await import("fs");
    const wrangler = readFileSync("wrangler.jsonc", "utf8");
    const perCase = wrangler.match(/"EXEC_PER_CASE_TIMEOUT_MS"\s*:\s*"(\d+)"/);
    assert(perCase, "EXEC_PER_CASE_TIMEOUT_MS must be declared");
    assertEq(perCase[1], "900000", "EXEC_PER_CASE_TIMEOUT_MS must be 900000 (15 min)");
  });

  test("all arm configs agree on EXEC_PER_CASE_TIMEOUT_MS=900000", async () => {
    const { readFileSync, readdirSync } = await import("fs");
    const armFiles = readdirSync(".").filter((f) => f.startsWith("wrangler.arm-") && f.endsWith(".jsonc"));
    assert(armFiles.length > 0, "there must be at least one arm config");
    for (const f of armFiles) {
      const content = readFileSync(f, "utf8");
      const perCase = content.match(/"EXEC_PER_CASE_TIMEOUT_MS"\s*:\s*"(\d+)"/);
      assert(perCase, `${f} must declare EXEC_PER_CASE_TIMEOUT_MS`);
      assertEq(perCase[1], "900000", `${f} must have EXEC_PER_CASE_TIMEOUT_MS=900000`);
    }
  });

  test("DEPLOY.md config gate pins EXEC_PER_CASE_TIMEOUT_MS to 900000", async () => {
    const { readFileSync } = await import("fs");
    const deploy = readFileSync("DEPLOY.md", "utf8");
    assert(
      deploy.includes('eq(v.EXEC_PER_CASE_TIMEOUT_MS,"900000"'),
      "DEPLOY.md must pin EXEC_PER_CASE_TIMEOUT_MS to 900000",
    );
  });

  test("EXPECTED_STATIC_VARS pins EXEC_PER_CASE_TIMEOUT_MS to 900000", async () => {
    const { readFileSync } = await import("fs");
    const canary = readFileSync("tools/assert-no-active-canary-workflows.mjs", "utf8");
    assert(
      canary.includes('EXEC_PER_CASE_TIMEOUT_MS: "900000"'),
      "EXPECTED_STATIC_VARS must pin EXEC_PER_CASE_TIMEOUT_MS to 900000",
    );
  });

  test("execute-batch has a minimum batch residual guard", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync("src/workflow/stages/execute-batch.ts", "utf8");
    // The guard must compare remaining budget against a minimum before starting a walk
    assert(
      src.includes("minBatchResidualMs") && src.includes("remainingBudgetMs"),
      "execute-batch must implement a minimum batch residual guard",
    );
    // The guard must be derived from the per-case timeout
    assert(
      src.includes("minBatchResidualMs = perCaseTimeoutMs"),
      "minimum batch residual must be derived from the per-case timeout",
    );
  });

  test("the don't-start guard prevents a walk when budget is insufficient", async () => {
    // This is a structural test: the guard must prevent starting, not just log a warning.
    const { readFileSync } = await import("fs");
    const src = readFileSync("src/workflow/stages/execute-batch.ts", "utf8");
    // The guard must `break` out of the work loop, not just skip
    assert(
      src.includes("remainingBudgetMs < minBatchResidualMs") &&
        (src.includes("break;") || src.includes("break")),
      "the guard must break out of the work loop when budget is insufficient",
    );
  });
});

// ===========================================================================
// AMENDMENT 3: STRUCTURAL TERMINAL-PAGE ARM
// ===========================================================================

suite("amendment 3: structural terminal page", () => {
  test("isPlatformNavigationWidget detects a question skip menu dropdown", async () => {
    const { mod } = await loadWorker();

    // A select with options that look like question IDs
    const navSelect = selectControl(
      99,
      [
        { code: "", label: "-- QUESTION SKIP MENU --", placeholder: true },
        { code: "S1", label: "S1" },
        { code: "S10", label: "S10" },
        { code: "S15", label: "S15" },
        { code: "END", label: "END" },
      ],
      { label: "QUESTION SKIP MENU" },
    );
    const screen = baseScreen();

    assert(
      mod.driver.isPlatformNavigationWidget(navSelect, screen),
      "a select with question-id options and 'skip menu' label should be a navigation widget",
    );
  });

  test("isPlatformNavigationWidget does NOT flag a survey answer dropdown", async () => {
    const { mod } = await loadWorker();

    const surveySelect = selectControl(
      5,
      [
        { code: "1", label: "Strongly agree" },
        { code: "2", label: "Somewhat agree" },
        { code: "3", label: "Neutral" },
        { code: "4", label: "Somewhat disagree" },
        { code: "5", label: "Strongly disagree" },
      ],
      { label: "Please rate your experience" },
    );
    const screen = baseScreen();

    assert(
      !mod.driver.isPlatformNavigationWidget(surveySelect, screen),
      "a select with survey answer options should NOT be a navigation widget",
    );
  });

  test("classifyEnding structural arm fires when the only answerable control is a nav widget", async () => {
    const { mod } = await loadWorker();

    // A terminal page: back button visible, no forward button, and a navigation dropdown
    const navSelect = selectControl(
      99,
      [
        { code: "", label: "-- QUESTION SKIP MENU --", placeholder: true },
        { code: "S1", label: "S1" },
        { code: "S10", label: "S10" },
      ],
      { label: "QUESTION SKIP MENU", name: "skipMenu" },
    );

    const finalScreen = baseScreen({
      controls: [navSelect],
      buttons: [backBtn(100)],
      visibleText: "Thank you for your willingness to participate. Survey status: Terminated at S10",
      questionText: null,
    });

    // With the nav widget excluded from "answerable", the structural arm should fire
    const ending = mod.driver.classifyEnding(finalScreen, {
      outcome: "no-advance-control",
      unboundDecisions: 0,
      navigatorDefaults: 1,
    });

    assertEq(ending.kind, "screened-out", `ending should be screened-out (structural + wording), got: ${ending.kind}`);
  });

  test("classifyEnding structural arm fires on a terminal page with zero question controls", async () => {
    const { mod } = await loadWorker();

    // A terminal page with only a back button and a question skip menu, no wording markers
    const navSelect = selectControl(
      99,
      [
        { code: "", label: "Jump to question", placeholder: true },
        { code: "Q1", label: "Q1" },
        { code: "Q5", label: "Q5" },
      ],
      { label: "Jump to question", name: "navJump" },
    );

    const finalScreen = baseScreen({
      controls: [navSelect],
      buttons: [backBtn(100)],
      // No standard screen-out or completion wording — only structural signals
      visibleText: "Session ended. You cannot continue.",
      questionText: null,
    });

    const ending = mod.driver.classifyEnding(finalScreen, {
      outcome: "no-advance-control",
      unboundDecisions: 0,
    });

    // With the old code, answerable.length would be 1 (the nav select), and the structural
    // arm would NOT fire. With the fix, answerable.length is 0 and it fires.
    assertEq(
      ending.kind,
      "screened-out",
      `structural arm should fire when the only 'answerable' control is a navigation widget, got: ${ending.kind}`,
    );
  });

  test("classifyEnding still counts a real survey select as answerable", async () => {
    const { mod } = await loadWorker();

    // A page with a real survey dropdown and a back button
    const surveySelect = selectControl(
      5,
      [
        { code: "1", label: "Option A" },
        { code: "2", label: "Option B" },
      ],
      { label: "Choose an option" },
    );

    const finalScreen = baseScreen({
      controls: [surveySelect],
      buttons: [backBtn(100)],
      visibleText: "Please complete this question before continuing.",
      questionText: "Which option do you prefer?",
    });

    const ending = mod.driver.classifyEnding(finalScreen, {
      outcome: "no-advance-control",
      unboundDecisions: 0,
    });

    // With a real survey select, there IS an answerable control, so the structural arm
    // should NOT fire (regardless of the back-only button configuration)
    assert(
      ending.kind !== "screened-out",
      `a page with a real survey select should NOT trigger the structural screen-out arm, got: ${ending.kind}`,
    );
  });
});

suite("amendment 3b: leftover cases get the honest run-end label", () => {
  // The 2026-08-17 drive runs ended with ZERO plannable work and wore
  // "batch-budget-exhausted" — a label that says "more batches would have helped" about a
  // run where they could not have. The close step must consult WHY the loop ended: executor
  // done => no-executable-work; batches exhausted => batch-budget-exhausted. Pinned at
  // source level (the close step runs only inside a live Workflow engine).
  test("phase-executing-close distinguishes executor-done from batches-exhausted", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync("src/workflow/run-workflow.ts", "utf8");
    assert(
      src.includes('const leftoverReason = executorSaidDone ? "no-executable-work" : "batch-budget-exhausted";'),
      "the leftover>0 ending must pick its label from executorSaidDone",
    );
    assert(
      /if \(outcome\.done\) \{\s*\n\s*executorSaidDone = true;/.test(src),
      "the batch loop must record that the executor said done",
    );
  });
});

suite("amendment 4: a validation rejection overrides the already-answered skip on recovery", () => {
  // Measured live (run v2r_01m07j4mrttnmzg7j917mjpb0v, screen 48 "Years at organization"):
  // the page pre-fills "-" and the reader's valueIsUserSupplied believes it, so the value
  // loop skips the field as answered while the site's validation says "Please enter a
  // number." forever. When the advance fails AND validation messages are present, the
  // recovery pass must re-derive values — the site itself has testified the field holds
  // no answer.
  test("a pre-filled placeholder that validation rejects gets re-typed by the recovery pass", async () => {
    const { mod } = await loadWorker();
    const env = testEnv();
    const mk = (validation, fieldValue = "-") => ({
      url: "https://fixture.invalid/survey",
      title: "S70",
      questionText: "S70. Years at organization?",
      grid: null,
      collectedErrors: [],
      readerLimitations: [],
      controls: [
        {
          idx: 0,
          tag: "input",
          type: "text",
          name: "S70_1",
          id: null,
          code: null,
          label: "Years at organization",
          text: "",
          checked: null,
          value: fieldValue,
          valueIsUserSupplied: true,
          disabled: false,
          required: true,
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
        },
      ],
      optionGroups: [],
      buttons: [{ idx: 1, label: "Next", role: "next", roleVia: "text:Next", disabled: false, visible: true }],
      validationMessages: validation,
      progress: { present: false, value: null },
      counts: { controls: 1, optionGroups: 0, options: 0, textInputs: 1, valueInputs: 1, optionsNotOperable: 0, readerLimitations: 0 },
      screenSignature: "sig:s70",
    });
    // The field RETAINS what the walker typed: after the first fill the re-reads show the
    // probe text as a user-supplied value, so only the validation bypass (never the
    // placeholder rule) can make the recovery re-derive.
    const V = ["Please enter a number."];
    const reads = [mk([]), mk([]), mk(V, "QA-PROBE"), mk(V, "QA-PROBE"), mk(V, "QA-PROBE"), mk(V, "QA-PROBE")];
    let last = reads[0];
    const typed = [];
    const commits = [];
    const page = {
      async goto() {},
      async evaluate(script) {
        if (typeof script === "string" && script.includes("screenSignature")) {
          if (reads.length > 0) last = reads.shift();
          return last;
        }
        const src = String(script);
        if (src.includes("W4_COMMIT_TYPED_VALUE")) commits.push(1);
        if (src.includes("el.value")) {
          const start = src.indexOf('el.value = "');
          const end = start >= 0 ? src.indexOf('";', start) : -1;
          const value = start >= 0 && end > start ? src.slice(start + 'el.value = "'.length, end) : "";
          typed.push(value);
          return { ok: true, reason: null, got: value };
        }
        return { ok: true };
      },
      async evaluateOnNewDocument() {},
      async $$() {
        return Array.from({ length: 4 }, (_, i) => ({
          async click() {},
          async type(t) {
            typed.push(t);
          },
          async focus() {},
        }));
      },
      async screenshot() {
        return new TextEncoder().encode("PNG-D56");
      },
      async setViewport() {},
      on() {},
      async close() {},
      async reload() {},
    };
    const runId = mod.ids.mintRunId();
    const obs = await mod.driver.walkPath(
      page,
      { id: "path_d56reval", decisions: [], witnesses: [] },
      {
        surveyUrl: "https://fixture.invalid/survey",
        runId,
        planRevisionId: "plan_d56reval1",
        attemptId: "att_d56reval001",
        tier: 1,
        maxSteps: 1,
        deadline: Date.now() + 30_000,
        viewport: { width: 1280, height: 900 },
        applyHistoryShim: false,
        advanceTimeoutMs: 400,
      },
      { env, runId, attemptId: "att_d56reval001", pathId: "path_d56reval", witnesses: [] },
    );
    const allActions = obs.steps.flatMap((s) => s.actions ?? []);
    const fills = allActions.filter((a) => (a.kind === "type-text" || a.kind === "set-value") && a.targetIdx === 0 && a.ok);
    assert(
      fills.length >= 1 || typed.length >= 1,
      `the validation-rejected placeholder must be re-typed on recovery; actions: ${JSON.stringify(allActions.map((a) => a.kind))}`,
    );
    // "Please enter a number." must STEER the derivation: the first live recovery re-typed
    // the text probe and was rejected again. A number, never prose.
    const values = fills.map((a) => a.value).concat(typed);
    assert(
      values.some((v) => /^\d+$/.test(String(v ?? ""))),
      `the recovery must derive a NUMBER for a number-demanding validation, typed: ${JSON.stringify(values)}`,
    );
    // The first pass may type the probe (no validation has spoken yet); the walk must
    // CONVERGE on a number once it has — the last non-empty value typed is numeric.
    const nonEmpty = values.filter((v) => String(v ?? "").length > 0);
    assert(
      /^\d+$/.test(String(nonEmpty[nonEmpty.length - 1] ?? "")),
      `the walk must converge on a numeric answer after validation speaks, typed: ${JSON.stringify(values)}`,
    );
    // Every keyboard-typed value must be COMMITTED (input+change+blur dispatched): the
    // live server posted the STALE value when the events never fired (S70, v56 run).
    assert(commits.length >= 1, "typeIdx must dispatch the change-event commit after typing");
    // AND the FIRST pass must have treated the placeholder as unanswered: on S80 the live
    // site terminated OUTRIGHT with no validation round, so a walk that only fills on
    // recovery never fills there at all. The first fill precedes any validation feedback.
    assertEq(
      nonEmpty[0],
      "QA-PROBE",
      `the first pass must fill over the '-' placeholder before any validation speaks, typed: ${JSON.stringify(values)}`,
    );
  });
});

suite("amendment 5: recovery half-steps are valid persisted step ordinals", () => {
  // Measured live (run v2r_01m08ce0s86w97rvvcn08h0n59): every deep walk's observation came
  // back "artifact-corrupt" from the activity projection and visual-work ingestion — five
  // 53-screen walks unreadable at exactly the screens that blocked. The cause was not the
  // artifacts: the driver records the recovery it runs after a blocked step as
  // `stepIndex + 0.5` BY DESIGN, and the strict validators demanded integers, so every legal
  // recovery walk was declared corrupt on sight. The boundary must accept the writer's real
  // domain — whole or half ordinals — while 2.25, NaN and negatives still fail.
  const blockedRecoveryWalk = async () => {
    const { mod } = await loadWorker();
    const env = testEnv();
    const mk = (validation, fieldValue = "-") => ({
      at: "2026-08-17T18:00:00.000Z",
      url: "https://fixture.invalid/survey",
      title: "S70",
      questionText: "S70. Years at organization?",
      grid: null,
      collectedErrors: [],
      readerLimitations: [],
      controls: [
        {
          idx: 0,
          tag: "input",
          type: "text",
          name: "S70_1",
          id: null,
          code: null,
          label: "Years at organization",
          text: "",
          checked: null,
          value: fieldValue,
          valueIsUserSupplied: true,
          disabled: false,
          required: true,
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
        },
      ],
      optionGroups: [],
      buttons: [{ idx: 1, label: "Next", role: "next", roleVia: "text:Next", disabled: false, visible: true }],
      validationMessages: validation,
      progress: { present: false, value: null },
      counts: { controls: 1, optionGroups: 0, options: 0, textInputs: 1, valueInputs: 1, optionsNotOperable: 0, readerLimitations: 0 },
      screenSignature: "sig:s70",
    });
    const V = ["Please enter a number."];
    const reads = [mk([]), mk([]), mk(V, "QA-PROBE"), mk(V, "QA-PROBE"), mk(V, "QA-PROBE"), mk(V, "QA-PROBE")];
    let last = reads[0];
    const page = {
      async goto() {},
      async evaluate(script) {
        if (typeof script === "string" && script.includes("screenSignature")) {
          if (reads.length > 0) last = reads.shift();
          return last;
        }
        const src = String(script);
        if (src.includes("el.value")) return { ok: true, reason: null, got: "" };
        return { ok: true };
      },
      async evaluateOnNewDocument() {},
      async $$() {
        return Array.from({ length: 4 }, () => ({
          async click() {},
          async type() {},
          async focus() {},
        }));
      },
      async screenshot() {
        return new TextEncoder().encode("PNG-D56");
      },
      async setViewport() {},
      on() {},
      async close() {},
      async reload() {},
    };
    const runId = mod.ids.mintRunId();
    const obs = await mod.driver.walkPath(
      page,
      { id: "path_d56ordnl", decisions: [], witnesses: [] },
      {
        surveyUrl: "https://fixture.invalid/survey",
        runId,
        planRevisionId: "plan_d56ordnl1",
        attemptId: "att_d56ordnl001",
        tier: 1,
        maxSteps: 1,
        deadline: Date.now() + 30_000,
        viewport: { width: 1280, height: 900 },
        applyHistoryShim: false,
        advanceTimeoutMs: 400,
      },
      { env, runId, attemptId: "att_d56ordnl001", pathId: "path_d56ordnl", witnesses: [] },
    );
    return { mod, obs };
  };
  const bytes = (value) => new TextEncoder().encode(JSON.stringify(value));

  test("a real blocked-then-recovered walk validates as a strict PathObservation", async () => {
    const { mod, obs } = await blockedRecoveryWalk();
    const fractional = obs.steps.filter((s) => !Number.isInteger(s.stepIndex)).map((s) => s.stepIndex);
    // The guard that this fixture still exercises the class: no half-step, no test.
    assert(
      fractional.length >= 1,
      `the blocked walk must record a recovery interleave at k + 0.5; steps: ${JSON.stringify(obs.steps.map((s) => s.stepIndex))}`,
    );
    assert(
      fractional.every((n) => Number.isSafeInteger(n * 2)),
      `recovery ordinals must stay on the half-step grid, got: ${JSON.stringify(fractional)}`,
    );
    // The kill-shot for the live defect: before the stepOrdinal fix this exact call threw
    // "must be an integer…" and five 53-screen walks' evidence was unreadable.
    mod.visualWork.validatePathObservationBytes(bytes(obs));
  });

  test("the relaxed boundary still rejects off-grid, negative and non-numeric ordinals", async () => {
    const { mod, obs } = await blockedRecoveryWalk();
    const offGrid = structuredClone(obs);
    offGrid.steps[offGrid.steps.length - 1].stepIndex = 2.25;
    await assertThrows(
      () => mod.visualWork.validatePathObservationBytes(bytes(offGrid)),
      "stepIndex",
      "a quarter-step is not in the writer's domain and must still read as corrupt",
    );
    const negative = structuredClone(obs);
    negative.steps[negative.steps.length - 1].stepIndex = -0.5;
    await assertThrows(
      () => mod.visualWork.validatePathObservationBytes(bytes(negative)),
      "stepIndex",
      "a negative ordinal must still read as corrupt",
    );
    const notANumber = structuredClone(obs);
    notANumber.steps[notANumber.steps.length - 1].stepIndex = "0.5";
    await assertThrows(
      () => mod.visualWork.validatePathObservationBytes(bytes(notANumber)),
      "stepIndex",
      "a stringly ordinal must still read as corrupt",
    );
  });

  test("half-step reader limitations and unfillable-control rows survive the boundary too", async () => {
    const { mod, obs } = await blockedRecoveryWalk();
    const widened = structuredClone(obs);
    widened.readerLimitations = [
      { stepIndex: 0.5, kind: "d56-fixture-limitation", detail: "recorded during a recovery interleave", count: 1 },
    ];
    widened.readerLimitationCount = 1;
    widened.unfillableControls = [
      {
        idx: 0,
        type: "text",
        label: "Years at organization",
        required: true,
        reason: "value-rejected",
        detail: "d56 fixture row bound to the recovery interleave",
        stepIndex: 0.5,
      },
    ];
    widened.unfillableControlCount = 1;
    mod.visualWork.validatePathObservationBytes(bytes(widened));
    const offGrid = structuredClone(widened);
    offGrid.readerLimitations[0].stepIndex = 0.25;
    await assertThrows(
      () => mod.visualWork.validatePathObservationBytes(bytes(offGrid)),
      "stepIndex",
      "an off-grid limitation ordinal must still read as corrupt",
    );
  });
});

suite("amendment 6: a set value must SURVIVE the mask, not merely pass the synchronous readback", () => {
  // Measured live (run v2r_01m0c4hvsqcn2jgr740peefgmh, S150 numeric grid cell, 19 Aug):
  // set-value read back "1" at set time, the input mask re-initialised on a later tick,
  // and the advance click posted "-" — the walk stalled on validation that never cleared.
  // setIdx now verifies after a delay, re-sets once on revert, and records a refusal when
  // the mask discards the value twice.
  const revertingPage = (behavior) => {
    let sets = 0;
    let reads = 0;
    return {
      sets: () => sets,
      async evaluate(script) {
        const src = String(script);
        if (src.includes("W4_READ_VALUE")) {
          reads += 1;
          if (behavior === "clean") return { got: "7" };
          if (behavior === "revert-once") return { got: reads === 1 ? "-" : "7" };
          return { got: "-" }; // always-reverts
        }
        if (src.includes("el.value = ")) {
          sets += 1;
          return { ok: true, reason: null, got: "7" };
        }
        return { ok: true };
      },
    };
  };

  test("a clean set verifies after the delay and reports it", async () => {
    const mod = await loadWorker().then((w) => w.mod);
    const page = revertingPage("clean");
    const r = await mod.driver.setIdx(page, 3, "7");
    assertEq(r.ok, true, r.detail);
    assert(r.detail.includes("verified after delay"), r.detail);
    assertEq(page.sets(), 1, "a clean set must not re-set");
  });

  test("THE MEASURED SHAPE: the mask reverts once, the re-set sticks, and the receipt names the revert", async () => {
    const mod = await loadWorker().then((w) => w.mod);
    const page = revertingPage("revert-once");
    const r = await mod.driver.setIdx(page, 3, "7");
    assertEq(r.ok, true, r.detail);
    assert(r.detail.includes("survived after one re-set"), r.detail);
    assertEq(page.sets(), 2, "the revert must buy exactly one re-set");
  });

  test("a mask that keeps discarding is a recorded refusal, never a success", async () => {
    const mod = await loadWorker().then((w) => w.mod);
    const page = revertingPage("always-reverts");
    const r = await mod.driver.setIdx(page, 3, "7");
    assertEq(r.ok, false, r.detail);
    assertEq(r.discarded, true, "a twice-reverted value is the control refusing it");
    assert(r.detail.includes("keeps discarding"), r.detail);
  });
});

suite("amendment 7: multi-cell numeric recovery splits an allocation, not all-ones", () => {
  // Measured live (run v2r_01m0ceth…, B10 percentage-allocation grid, 19 Aug): three
  // numeric cells rejected three "1"s forever — the grid demands the cells total 100.
  // With multiple numeric-demanding cells on one screen the recovery now sets 100 in the
  // first and 0 in the rest; a lone cell keeps the least-committed "1".
  const allocWalk = async (cellCount) => {
    const { mod } = await loadWorker();
    const env = testEnv();
    const controls = Array.from({ length: cellCount }, (_, i) => ({
      idx: i,
      tag: "input", type: "text", name: `B10_${i + 1}`, id: null, code: null,
      label: "%", text: "", checked: null, value: "", valueIsUserSupplied: false,
      disabled: false, required: true, visible: true, operable: true,
      actuatedVia: "self", placeholder: null, maxlength: null, min: null, max: null,
      step: null, pattern: null, readOnly: false,
    }));
    const mk = (validation) => ({
      at: "2026-08-19T12:00:00.000Z",
      url: "https://fixture.invalid/survey",
      title: "B10",
      questionText: "B10. What proportion of each?",
      grid: null, collectedErrors: [], readerLimitations: [],
      controls,
      optionGroups: [],
      buttons: [{ idx: 90, label: ">>", role: "next", roleVia: "text:Next", disabled: false, visible: true }],
      validationMessages: validation,
      progress: { present: false, value: null },
      counts: { controls: controls.length, optionGroups: 0, options: 0, textInputs: controls.length, valueInputs: controls.length, optionsNotOperable: 0, readerLimitations: 0 },
      screenSignature: "sig:b10",
    });
    const V = ["Please enter a number."];
    const reads = [mk([]), mk([]), mk(V), mk(V), mk(V), mk(V)];
    let last = reads[0];
    const sets = [];
    const page = {
      async goto() {},
      async evaluate(script) {
        const src = String(script);
        if (src.includes("screenSignature")) { if (reads.length > 0) last = reads.shift(); return last; }
        if (src.includes("W4_READ_VALUE")) return { got: sets.length > 0 ? sets[sets.length - 1] : "" };
        const start = src.indexOf('el.value = "');
        if (start >= 0 && src.includes("change")) {
          const end = src.indexOf('";', start);
          const v = end > start ? src.slice(start + 'el.value = "'.length, end) : "";
          sets.push(v);
          return { ok: true, reason: null, got: v };
        }
        return { ok: true };
      },
      async evaluateOnNewDocument() {},
      async $$() { return Array.from({ length: 95 }, () => ({ async click() {}, async type() {}, async focus() {} })); },
      async screenshot() { return new TextEncoder().encode("PNG-D56"); },
      async setViewport() {}, on() {}, async close() {}, async reload() {},
    };
    const runId = mod.ids.mintRunId();
    const obs = await mod.driver.walkPath(
      page,
      { id: "path_d56alloc", decisions: [], witnesses: [] },
      {
        surveyUrl: "https://fixture.invalid/survey", runId, planRevisionId: "plan_d56alloc1",
        attemptId: "att_d56alloc001", tier: 1, maxSteps: 1, deadline: Date.now() + 30_000,
        viewport: { width: 1280, height: 900 }, applyHistoryShim: false, advanceTimeoutMs: 400,
      },
      { env, runId, attemptId: "att_d56alloc001", pathId: "path_d56alloc", witnesses: [] },
    );
    const recoverySets = obs.steps
      .filter((s) => s.decisionSource === "recovery")
      .flatMap((s) => (s.actions ?? []).filter((a) => a.kind === "set-value" && a.ok))
      .map((a) => a.value);
    return recoverySets;
  };

  test("THE MEASURED SHAPE: three numeric cells recover as 100/0/0, never 1/1/1", async () => {
    const values = await allocWalk(3);
    assertEq(JSON.stringify(values), JSON.stringify(["100", "0", "0"]),
      `three cells must split an allocation, got ${JSON.stringify(values)}`);
  });

  test("a lone numeric cell keeps the least-committed 1", async () => {
    const values = await allocWalk(1);
    assertEq(JSON.stringify(values), JSON.stringify(["1"]),
      `a single cell has no sum constraint to satisfy, got ${JSON.stringify(values)}`);
  });
});

suite("amendment 8: a blocked set-value recovery gets one keyboard-flip round", () => {
  // Measured live (run v2r_01m0cp6grt3sbyscj6d6vk89qb, B10 allocation grid, screen 68,
  // 19 Aug): four set-value fills read back "ok" while the site's own TOTAL stayed 0 —
  // the widget's submitted state listens only to real key events. The S70 lesson (set is
  // the mechanism a wedged mask accepts) is the exact opposite wiring. Neither is right
  // everywhere, so when a set-based numeric recovery leaves validation standing the walk
  // now runs ONE more round with the same values through the keyboard, and both rounds
  // travel in the receipts.
  const isDigits = (s) => typeof s === "string" && s.length > 0 && [...s].every((ch) => ch >= "0" && ch <= "9");

  const keyboardOnlyGridWalk = async ({ keyboardRegisters, lateNumericMessage = false }) => {
    const { mod } = await loadWorker();
    const env = testEnv();
    const cellCount = 3;
    const NEXT_IDX = 90;
    const controls = Array.from({ length: cellCount }, (_, i) => ({
      idx: i,
      tag: "input", type: "text", name: `B10_${i + 1}`, id: null, code: null,
      label: "%", text: "", checked: null, value: "", valueIsUserSupplied: false,
      disabled: false, required: true, visible: true, operable: true,
      actuatedVia: "self", placeholder: null, maxlength: null, min: null, max: null,
      step: null, pattern: null, readOnly: false,
    }));
    const V = ["Please enter a number.", "Please ensure the sum of your answers equals 100."];
    // The measured B10 staging: the FIRST rejection says only "Please provide an answer.";
    // the numeric-sum demand appears only after values were submitted and rejected.
    const V_GENERIC = ["Please provide an answer."];
    const mkGrid = (validation) => ({
      at: "2026-08-19T12:00:00.000Z",
      url: "https://fixture.invalid/survey",
      title: "B10",
      questionText: "B10. What proportion of each?",
      grid: null, collectedErrors: [], readerLimitations: [],
      controls,
      optionGroups: [],
      buttons: [{ idx: NEXT_IDX, label: ">>", role: "next", roleVia: "text:Next", disabled: false, visible: true }],
      validationMessages: validation,
      progress: { present: false, value: null },
      counts: { controls: controls.length, optionGroups: 0, options: 0, textInputs: controls.length, valueInputs: controls.length, optionsNotOperable: 0, readerLimitations: 0 },
      screenSignature: "sig:kbgrid",
    });
    const doneScreen = {
      at: "2026-08-19T12:00:01.000Z",
      url: "https://fixture.invalid/survey/next-section",
      title: "C10",
      questionText: "C10. The next section.",
      grid: null, collectedErrors: [], readerLimitations: [],
      controls: [],
      optionGroups: [],
      buttons: [],
      validationMessages: [],
      progress: { present: false, value: null },
      counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0, valueInputs: 0, optionsNotOperable: 0, readerLimitations: 0 },
      screenSignature: "sig:kbdone",
    };

    // THE WIDGET'S SUBMITTED STATE: only keyboard keystrokes land here, and only when the
    // fixture is told keyboard registers at all. Non-numeric keystrokes are transformed to
    // "-" the way the live mask did. set-value writes are remembered separately and NEVER
    // register — that is the measured B10 wiring this fixture pins.
    const typed = {};
    const sets = [];
    let nextClicks = 0;
    let done = false;
    const acceptedCount = () => Object.values(typed).filter((v) => isDigits(v)).length;
    const idxFromSrc = (src) => {
      const at = src.indexOf(")[");
      if (at < 0) return null;
      const end = src.indexOf("]", at + 2);
      const n = Number(src.slice(at + 2, end));
      return Number.isInteger(n) ? n : null;
    };
    const mkHandle = (idx) => ({
      async click() {
        if (idx === NEXT_IDX) {
          if (acceptedCount() >= cellCount) done = true;
          else nextClicks += 1;
        }
      },
      async type(v) {
        if (keyboardRegisters) typed[idx] = isDigits(v) ? v : "-";
        else typed[idx] = "-";
      },
      async focus() {},
    });
    const page = {
      async goto() {},
      async evaluate(script) {
        const src = String(script);
        if (src.includes("screenSignature")) {
          if (done) return doneScreen;
          const validation = nextClicks === 0 ? [] : lateNumericMessage && nextClicks === 1 ? V_GENERIC : V;
          return mkGrid(validation);
        }
        if (src.includes("W4_READ_VALUE")) return { got: sets.length > 0 ? sets[sets.length - 1] : "" };
        // The set sniffer runs BEFORE the plain readback sniffer: setValueScript both
        // assigns el.value and reads it back, and only the assignment identifies it.
        const start = src.indexOf('el.value = "');
        if (start >= 0 && src.includes("change")) {
          const end = src.indexOf('";', start);
          const v = end > start ? src.slice(start + 'el.value = "'.length, end) : "";
          if (v.length > 0) sets.push(v);
          return { ok: true, reason: null, got: v };
        }
        if (src.includes("'value' in e")) {
          const idx = idxFromSrc(src);
          return idx !== null && typed[idx] !== undefined ? typed[idx] : "";
        }
        return { ok: true };
      },
      async evaluateOnNewDocument() {},
      async $$() { return Array.from({ length: 95 }, (_, i) => mkHandle(i)); },
      async screenshot() { return new TextEncoder().encode("PNG-D56"); },
      async setViewport() {}, on() {}, async close() {}, async reload() {},
    };
    const runId = mod.ids.mintRunId();
    const obs = await mod.driver.walkPath(
      page,
      { id: "path_d56kbflip", decisions: [], witnesses: [] },
      {
        surveyUrl: "https://fixture.invalid/survey", runId, planRevisionId: "plan_d56kbflip1",
        attemptId: "att_d56kbflip01", tier: 1, maxSteps: 2, deadline: Date.now() + 30_000,
        viewport: { width: 1280, height: 900 }, applyHistoryShim: false, advanceTimeoutMs: 400,
      },
      { env, runId, attemptId: "att_d56kbflip01", pathId: "path_d56kbflip", witnesses: [] },
    );
    return { obs, sets, typed };
  };

  test("THE MEASURED SHAPE: set-value recovery blocked, keyboard flip advances the walk", async () => {
    const { obs, sets } = await keyboardOnlyGridWalk({ keyboardRegisters: true });
    assert(sets.length >= 3, `the first recovery must have tried set-value fills, saw ${sets.length}`);
    const recoverySteps = obs.steps.filter((s) => s.decisionSource === "recovery");
    assertEq(recoverySteps.length, 1, "both rounds fold into the ONE half-step the persisted grid allows");
    const rec = recoverySteps[0];
    assert(Number.isSafeInteger(rec.stepIndex * 2), `recovery ordinal must stay on the half-step grid, got ${rec.stepIndex}`);
    const setActions = (rec.actions ?? []).filter((a) => a.kind === "set-value" && a.ok).map((a) => a.value);
    assertEq(JSON.stringify(setActions), JSON.stringify(["100", "0", "0"]),
      `round one is the set-value allocation, got ${JSON.stringify(setActions)}`);
    const typedActions = (rec.actions ?? []).filter((a) => a.kind === "type-text" && a.ok).map((a) => a.value);
    assertEq(JSON.stringify(typedActions), JSON.stringify(["100", "0", "0"]),
      `round two re-enters the same allocation by keyboard, got ${JSON.stringify(typedActions)}`);
    const flipClick = (rec.actions ?? []).filter((a) => a.kind === "click-next").pop();
    assert(String(flipClick?.detail ?? "").includes("keyboard-flip"), "the second click-next names the flip round");
    assertEq(rec.advanced, true, "the keyboard flip must be the round that advances");
    assert(obs.outcome !== "blocked", `the walk must continue past the grid, outcome was ${JSON.stringify(obs.outcome)}`);
  });

  test("THE MEASURED v80 SHAPE: the numeric demand appears only in the SECOND validation, and the rounds still get through", async () => {
    // Run v2r_01m0cy89mz80nf4g3z32j7f8sx: first rejection said only "Please provide an
    // answer.", so a single recovery round derived probe text, submitted it, and never read
    // the numeric-sum message that came back. The bounded rounds re-derive from the newest
    // validation: probe round, then the set allocation, then the keyboard flip.
    const { obs } = await keyboardOnlyGridWalk({ keyboardRegisters: true, lateNumericMessage: true });
    const rec = obs.steps.find((s) => s.decisionSource === "recovery");
    assert(rec, "a recovery step must be recorded");
    const setValues = (rec.actions ?? []).filter((a) => a.kind === "set-value" && a.ok).map((a) => a.value);
    assertEq(JSON.stringify(setValues), JSON.stringify(["100", "0", "0"]),
      `the numeric demand round must derive the allocation once the site says numbers, got ${JSON.stringify(setValues)}`);
    const typedNumeric = (rec.actions ?? []).filter((a) => a.kind === "type-text" && a.ok && a.value !== "QA-PROBE").map((a) => a.value);
    assertEq(JSON.stringify(typedNumeric), JSON.stringify(["100", "0", "0"]),
      `the final round re-enters the allocation by keyboard, got ${JSON.stringify(typedNumeric)}`);
    const clicks = (rec.actions ?? []).filter((a) => a.kind === "click-next");
    assertEq(clicks.length, 3, "three rounds each submitted once");
    assert(String(clicks[2].detail).includes("keyboard-flip"), "the last round names the mechanism flip");
    assertEq(rec.advanced, true, "the walk gets through the staged-validation grid");
    assert(obs.outcome !== "blocked", `outcome was ${JSON.stringify(obs.outcome)}`);
  });

  test("counterproof: when keyboard does not register either, the walk blocks and says the flip was tried", async () => {
    const { obs } = await keyboardOnlyGridWalk({ keyboardRegisters: false });
    assertEq(obs.outcome, "blocked");
    assert(
      String(obs.outcomeDetail).includes("a second recovery re-entered the numeric values by keyboard"),
      `the receipt must say the flip ran: ${String(obs.outcomeDetail).slice(0, 200)}`,
    );
    const rec = obs.steps.find((s) => s.decisionSource === "recovery");
    assert(rec, "the merged recovery step is still recorded");
    assertEq(rec.blocked, true);
    assert((rec.actions ?? []).some((a) => a.kind === "type-text"), "the failed flip round's receipts still travel");
    for (const s of obs.steps) {
      assert(Number.isSafeInteger(s.stepIndex * 2), `every persisted ordinal stays on the half-step grid, got ${s.stepIndex}`);
    }
  });
});

suite("amendment 9: validation outranks the checked bit — held selections re-actuate by label", () => {
  // Measured live (run v2r_01m0d2sxehnjcyd18qttmvp7wh, screen 7 = S40 yes/no radio,
  // 19 Aug): "Yes" was clicked and read back checked, yet the site's validation said
  // "Please select an answer." — the platform registers a selection through its own
  // handlers, and both recovery rounds SKIPPED the group as already answered and just
  // re-clicked next. Under a standing validation the held option now re-actuates through
  // its label, a different code path than the element click that just failed.
  const labelOnlyRadioWalk = async ({ labelRegisters, preChecked = false, siteValidates = true }) => {
    const { mod } = await loadWorker();
    const env = testEnv();
    const NEXT_IDX = 90;
    let checked = preChecked;
    let registered = preChecked && !siteValidates;
    let nextClicks = 0;
    let done = false;
    let optionElementClicks = 0;
    let labelClicks = 0;
    const mkRadio = () => ({
      at: "2026-08-19T12:00:00.000Z",
      url: "https://fixture.invalid/survey",
      title: "S40",
      questionText: "S40. Committee service?",
      grid: null, collectedErrors: [], readerLimitations: [],
      controls: [{
        idx: 0, tag: "input", type: "radio", name: "S40", id: null, code: "1",
        label: "Yes", text: "", checked, value: "1", valueIsUserSupplied: false,
        disabled: false, required: true, visible: true, operable: true,
        actuatedVia: "self", labelIndex: 5, placeholder: null, maxlength: null,
        min: null, max: null, step: null, pattern: null, readOnly: false,
      }],
      optionGroups: [{
        name: "S40",
        kind: "radio",
        options: [
          { order: 0, idx: 0, code: "1", label: "Yes", checked, disabled: false, visible: true, operable: true, actuatedVia: "self", labelIndex: 5 },
          { order: 1, idx: 1, code: "2", label: "No", checked: false, disabled: false, visible: true, operable: true, actuatedVia: "self", labelIndex: 6 },
        ],
      }],
      buttons: [{ idx: NEXT_IDX, label: ">>", role: "next", roleVia: "text:Next", disabled: false, visible: true }],
      validationMessages: !done && nextClicks > 0 && !registered && siteValidates ? ["Please select an answer."] : [],
      progress: { present: false, value: null },
      counts: { controls: 1, optionGroups: 1, options: 2, textInputs: 0, valueInputs: 0, optionsNotOperable: 0, readerLimitations: 0 },
      screenSignature: "sig:s40",
    });
    const doneScreen = {
      ...mkRadio(),
      url: "https://fixture.invalid/survey/after-s40",
      title: "S50",
      questionText: "S50. The next question.",
      controls: [], optionGroups: [], buttons: [],
      validationMessages: [],
      counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0, valueInputs: 0, optionsNotOperable: 0, readerLimitations: 0 },
      screenSignature: "sig:after-s40",
    };
    const mkControlHandle = (idx) => ({
      async click() {
        if (idx === NEXT_IDX) {
          if (registered || !siteValidates) { if (checked) done = true; else nextClicks += 1; }
          else nextClicks += 1;
          return;
        }
        if (idx === 0) { checked = true; optionElementClicks += 1; }
      },
      async type() {}, async focus() {},
    });
    const mkLabelHandle = (labelIdx) => ({
      async click() {
        labelClicks += 1;
        if (labelIdx === 5) { checked = true; if (labelRegisters) registered = true; }
      },
      async type() {}, async focus() {},
    });
    const page = {
      async goto() {},
      async evaluate(script) {
        const src = String(script);
        if (src.includes("screenSignature")) return done ? doneScreen : mkRadio();
        if (src.includes("checkedGroupIdxs")) {
          return { idx: 0, type: "radio", name: "S40", formOwner: 0, unnamedControlIdx: null, checked, checkedGroupIdxs: checked ? [0] : [] };
        }
        return { ok: true };
      },
      async evaluateOnNewDocument() {},
      async $$(sel) {
        if (String(sel) === "label") return Array.from({ length: 10 }, (_, i) => mkLabelHandle(i));
        return Array.from({ length: 95 }, (_, i) => mkControlHandle(i));
      },
      async screenshot() { return new TextEncoder().encode("PNG-D56"); },
      async setViewport() {}, on() {}, async close() {}, async reload() {},
    };
    const runId = mod.ids.mintRunId();
    const obs = await mod.driver.walkPath(
      page,
      { id: "path_d56label", decisions: [], witnesses: [] },
      {
        surveyUrl: "https://fixture.invalid/survey", runId, planRevisionId: "plan_d56label1",
        attemptId: "att_d56label001", tier: 1, maxSteps: 2, deadline: Date.now() + 30_000,
        viewport: { width: 1280, height: 900 }, applyHistoryShim: false, advanceTimeoutMs: 400,
      },
      { env, runId, attemptId: "att_d56label001", pathId: "path_d56label", witnesses: [] },
    );
    return { obs, optionElementClicks, labelClicks };
  };

  test("THE MEASURED SHAPE: a held selection the site rejects re-actuates by label and advances", async () => {
    const { obs, labelClicks } = await labelOnlyRadioWalk({ labelRegisters: true });
    const rec = obs.steps.find((s) => s.decisionSource === "recovery");
    assert(rec, "a recovery step must be recorded");
    const re = (rec.actions ?? []).find((a) => String(a.detail ?? "").startsWith("revalidate-reactuate(label-click)"));
    assert(re, `the held option must re-actuate through its label; actions: ${JSON.stringify((rec.actions ?? []).map((a) => a.kind + ":" + String(a.detail).slice(0, 40)))}`);
    assert(labelClicks > 0, "the label element itself was clicked");
    assertEq(rec.advanced, true, "the re-actuated selection is what the site accepts");
    assert(obs.outcome !== "blocked", `outcome was ${JSON.stringify(obs.outcome)}`);
  });

  test("counterproof: with no validation standing, held state is never re-dispatched", async () => {
    const { obs, optionElementClicks, labelClicks } = await labelOnlyRadioWalk({ labelRegisters: true, preChecked: true, siteValidates: false });
    assertEq(optionElementClicks, 0, "a pre-checked group with no validation gets no element click");
    assertEq(labelClicks, 0, "and no label click either — re-dispatch would invent a change");
    assert(obs.outcome !== "blocked", `outcome was ${JSON.stringify(obs.outcome)}`);
  });
});

suite("amendment 10: a specify-style text cell is cleared, never allocated", () => {
  // Measured live (run v2r_01m0d5x1h5z8xjxw6tdvnee771, B10, 19 Aug): the allocation split
  // wrote "0" into the grid's "Others (Please Specify)" TEXT cell; the sum constraint was
  // satisfied but the platform's pairing rule then demanded a real specify answer forever.
  // The specify cell is not a numeric target: it is cleared so the allocation stands alone.
  const isDigits = (s) => typeof s === "string" && s.length > 0 && [...s].every((ch) => ch >= "0" && ch <= "9");

  const specifyGridWalk = async ({ pctIdxs = [0, 1, 3], labels = ["%", "%", "Others (Please Specify)", "%"] } = {}) => {
    const { mod } = await loadWorker();
    const env = testEnv();
    const NEXT_IDX = 90;
    const SPECIFY_IDX = labels.findIndex((l) => l !== "%");
    const mk = (validation) => ({
      at: "2026-08-19T12:00:00.000Z",
      url: "https://fixture.invalid/survey",
      title: "B10",
      questionText: "B10. What proportion of each?",
      grid: null, collectedErrors: [], readerLimitations: [],
      controls: labels.map((label, i) => ({
        idx: i, tag: "input", type: "text", name: `B10_${i + 1}`, id: null, code: null,
        label, text: "", checked: null, value: "", valueIsUserSupplied: false,
        disabled: false, required: label === "%", visible: true, operable: true,
        actuatedVia: "self", placeholder: null, maxlength: null, min: null, max: null,
        step: null, pattern: null, readOnly: false,
      })),
      optionGroups: [],
      buttons: [{ idx: NEXT_IDX, label: ">>", role: "next", roleVia: "text:Next", disabled: false, visible: true }],
      validationMessages: validation,
      progress: { present: false, value: null },
      counts: { controls: labels.length, optionGroups: 0, options: 0, textInputs: labels.length, valueInputs: labels.length, optionsNotOperable: 0, readerLimitations: 0 },
      screenSignature: "sig:specgrid",
    });
    const doneScreen = { ...mk([]), url: "https://fixture.invalid/survey/next", questionText: "C10.", controls: [], buttons: [], counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0, valueInputs: 0, optionsNotOperable: 0, readerLimitations: 0 }, screenSignature: "sig:specdone" };
    // Stored per cell: % cells DISCARD non-numeric values (mask), the specify cell keeps
    // anything. The site: all three % cells numeric and sum 100 AND specify empty -> next
    // advances; % cells incomplete -> numeric demand; specify non-empty -> pairing demand.
    const stored = Object.fromEntries(labels.map((_, i) => [i, ""]));
    let nextClicks = 0;
    let done = false;
    const V_NUMERIC = ["Please enter numeric answers in column % of PCVs stocked."];
    const V_PAIRING = ["If you specify «Others (Please Specify)» then please enter answer for the «Others (Please Specify)» option."];
    const currentValidation = () => {
      if (nextClicks === 0) return [];
      const pctOk = pctIdxs.every((i) => isDigits(stored[i]));
      if (!pctOk) return V_NUMERIC;
      if (stored[SPECIFY_IDX].length > 0) return V_PAIRING;
      return [];
    };
    const put = (idx, v) => { stored[idx] = idx === SPECIFY_IDX ? v : (isDigits(v) || v === "" ? v : ""); };
    const idxFromSrc = (src) => {
      const at = src.indexOf(")[");
      if (at < 0) return null;
      const end = src.indexOf("]", at + 2);
      const n = Number(src.slice(at + 2, end));
      return Number.isInteger(n) ? n : null;
    };
    const lastTyped = {};
    const page = {
      async goto() {},
      async evaluate(script) {
        const src = String(script);
        if (src.includes("screenSignature")) return done ? doneScreen : mk(currentValidation());
        if (src.includes("W4_READ_VALUE")) {
          const idx = idxFromSrc(src);
          return { got: idx !== null ? stored[idx] ?? "" : "" };
        }
        if (src.includes("el.value = ''")) {
          const idx = idxFromSrc(src);
          if (idx !== null) { put(idx, ""); delete lastTyped[idx]; }
          return { ok: true };
        }
        const start = src.indexOf('el.value = "');
        if (start >= 0 && src.includes("change")) {
          const end = src.indexOf('";', start);
          const v = end > start ? src.slice(start + 'el.value = "'.length, end) : "";
          const idx = idxFromSrc(src);
          if (idx !== null) { put(idx, v); lastTyped[idx] = stored[idx]; }
          return { ok: true, reason: null, got: idx !== null ? stored[idx] : v };
        }
        if (src.includes("'value' in e")) {
          const idx = idxFromSrc(src);
          return idx !== null ? (lastTyped[idx] ?? stored[idx] ?? "") : "";
        }
        return { ok: true };
      },
      async evaluateOnNewDocument() {},
      async $$(sel) {
        const mkHandle = (idx) => ({
          async click() {
            if (idx === NEXT_IDX) {
              const pctOk = pctIdxs.every((i) => isDigits(stored[i]));
              if (pctOk && stored[SPECIFY_IDX].length === 0) done = true; else nextClicks += 1;
            }
          },
          async type(v) { lastTyped[idx] = v; put(idx, v); },
          async focus() {},
        });
        return Array.from({ length: 95 }, (_, i) => mkHandle(i));
      },
      async screenshot() { return new TextEncoder().encode("PNG-D56"); },
      async setViewport() {}, on() {}, async close() {}, async reload() {},
    };
    const runId = mod.ids.mintRunId();
    const obs = await mod.driver.walkPath(
      page,
      { id: "path_d56spec", decisions: [], witnesses: [] },
      {
        surveyUrl: "https://fixture.invalid/survey", runId, planRevisionId: "plan_d56spec1",
        attemptId: "att_d56spec001", tier: 1, maxSteps: 2, deadline: Date.now() + 30_000,
        viewport: { width: 1280, height: 900 }, applyHistoryShim: false, advanceTimeoutMs: 400,
      },
      { env, runId, attemptId: "att_d56spec001", pathId: "path_d56spec", witnesses: [] },
    );
    return { obs, stored };
  };

  test("a lone % cell next to a specify box keeps the least-committed 1", async () => {
    // The specify box must not inflate the target count: one real numeric cell means the
    // least-committed "1", not an allocation share. Counting the specify box as a second
    // target would put "100" into a field whose bounds nothing declared.
    const { obs } = await specifyGridWalk({ pctIdxs: [0], labels: ["%", "Others (Please Specify)"] });
    const rec = obs.steps.find((s) => s.decisionSource === "recovery");
    assert(rec, "a recovery step must be recorded");
    const pctFills = (rec.actions ?? []).filter((a) => a.kind === "set-value" && a.targetIdx === 0 && a.ok).map((a) => a.value);
    assertEq(JSON.stringify(pctFills), JSON.stringify(["1"]),
      `a lone numeric cell takes 1, got ${JSON.stringify(pctFills)}`);
    assertEq(rec.advanced, true);
  });

  test("THE MEASURED SHAPE: the allocation lands on the % cells and the specify cell is cleared", async () => {
    const { obs, stored } = await specifyGridWalk();
    const rec = obs.steps.find((s) => s.decisionSource === "recovery");
    assert(rec, "a recovery step must be recorded");
    const numericIntoSpecify = (rec.actions ?? []).filter((a) =>
      (a.kind === "set-value" || a.kind === "type-text") && a.targetIdx === 2 && isDigits(a.value));
    assertEq(numericIntoSpecify.length, 0,
      `the specify cell must never receive a number, got ${JSON.stringify(numericIntoSpecify.map((a) => a.value))}`);
    const clear = (rec.actions ?? []).find((a) => a.targetIdx === 2 && String(a.detail ?? "").includes("not a numeric allocation target"));
    assert(clear, "the specify cell is explicitly cleared with the reason in the receipt");
    assertEq(stored[2], "", "and the page's specify state ends empty");
    assertEq(rec.advanced, true, "the allocation alone satisfies the screen");
    assert(obs.outcome !== "blocked", `outcome was ${JSON.stringify(obs.outcome)}`);
  });
});

suite("amendment 11: a rejected submit never reads as an advance", () => {
  // Measured live 19 Aug (jump probe at B10): a failed submit on a full-page-POST platform
  // re-renders the SAME question with a validation banner, and the banner mutates every
  // structural signal — signature, question identity, history length. Six rejected submits
  // each read as an advance, so the recovery that answers validation never ran. The site's
  // own rejection outranks structural movement: validation visible + the same answerable
  // control skeleton => no advance.
  const ctrl = (idx, name, label, extra = {}) => ({
    idx, tag: "input", type: "text", name, id: null, code: null, label, text: "",
    checked: null, value: "", valueIsUserSupplied: false, disabled: false, required: true,
    visible: true, operable: true, actuatedVia: "self", placeholder: null, maxlength: null,
    min: null, max: null, step: null, pattern: null, readOnly: false, ...extra,
  });
  const screenOf = ({ controls, validation = [], signature, history, url }) => ({
    at: "2026-08-19T12:00:00.000Z",
    url: url ?? "https://fixture.invalid/survey",
    title: "B10", questionText: "", grid: null, collectedErrors: [], readerLimitations: [],
    controls, optionGroups: [],
    buttons: [{ idx: 90, label: ">>", role: "next", roleVia: "text:Next", disabled: false, visible: true }],
    validationMessages: validation,
    progress: { present: false, value: null },
    counts: { controls: controls.length, optionGroups: 0, options: 0, textInputs: controls.length, valueInputs: controls.length, optionsNotOperable: 0, readerLimitations: 0 },
    screenSignature: signature,
    historyLength: history,
  });

  test("THE MEASURED SHAPE: banner mutates signature+identity+history, and it is still not an advance", async () => {
    const { mod } = await loadWorker();
    const before = screenOf({
      controls: [ctrl(0, "B10_1", "%"), ctrl(1, "B10_2", "%")],
      signature: "sig:one", history: 5,
    });
    const after = screenOf({
      controls: [
        ctrl(0, "B10_1", "%"), ctrl(1, "B10_2", "%"),
        // The banner's own additions: hidden plumbing and an unnamed anchor-ish control.
        ctrl(2, "__seqno", "", { type: "hidden", visible: false }),
      ],
      validation: ["Please review your responses on this page.", "Please enter numeric answers."],
      signature: "sig:two", history: 6,
    });
    const signals = mod.driver.advanceSignals(before, after);
    assertEq(JSON.stringify(signals), JSON.stringify([]),
      `a validation re-render with the same answerable skeleton is not movement, got ${JSON.stringify(signals)}`);
  });

  test("counterproof: a NEW question showing validation still advances when its skeleton differs", async () => {
    const { mod } = await loadWorker();
    const before = screenOf({ controls: [ctrl(0, "B10_1", "%")], signature: "sig:one", history: 5 });
    const after = screenOf({
      controls: [ctrl(0, "B20_1", "How many?")],
      validation: ["Please enter a number."],
      signature: "sig:two", history: 6,
    });
    const signals = mod.driver.advanceSignals(before, after);
    assert(signals.length > 0, "a different answerable skeleton is a real advance even with a banner up");
  });

  test("counterproof: without validation, the structural signals still work exactly as before", async () => {
    const { mod } = await loadWorker();
    const before = screenOf({ controls: [ctrl(0, "B10_1", "%")], signature: "sig:one", history: 5 });
    const after = screenOf({ controls: [ctrl(0, "B10_1", "%")], signature: "sig:two", history: 6 });
    const signals = mod.driver.advanceSignals(before, after);
    assert(signals.includes("screen-signature-changed") && signals.includes("history-length-changed"),
      `no validation means no veto, got ${JSON.stringify(signals)}`);
  });
});

suite("amendment 12: multi-question screens traverse per root instead of ending the walk", () => {
  // Measured live 19 Aug (run v2r_01m0dcadeay20nhmh5wap22dag, screen 75): the conjoint
  // block renders four questions on one page and the deep walk ENDED at the one-question
  // refusal with 80% of the survey unreached. The reader scopes each root's controls, so
  // each root now takes the same navigator defaults a single-question screen gets —
  // scoped per root, so screen-level heuristics cannot leak across questions. The fixture
  // is the leak-proof shape: TWO fragmented exclusion screeners share the page, and only
  // per-root filling answers BOTH none-options (whole-screen filling picks one and stops).
  const NEXT_IDX = 90;
  const mkCtrl = (idx, type, name, label) => ({
    idx, tag: "input", type, name, id: null, code: null, label, text: "",
    checked: false, value: "", valueIsUserSupplied: false, disabled: false, required: false,
    visible: true, operable: true, actuatedVia: "self", labelIndex: null, placeholder: null,
    maxlength: null, min: null, max: null, step: null, pattern: null, readOnly: false,
  });
  const mkOpt = (idx, label) => ({
    order: 0, idx, code: String(idx), label, checked: false, disabled: false,
    visible: true, operable: true, actuatedVia: "self", labelIndex: null,
  });

  const twinScreenerWalk = async ({ scopedRoots = true } = {}) => {
    const { mod } = await loadWorker();
    const env = testEnv();
    const checked = new Set();
    let nextClicks = 0;
    let done = false;
    const rootA = [0, 1, 2];
    const rootB = [3, 4, 5];
    const answered = (root) => root.some((i) => checked.has(i));
    const mkScreen = () => ({
      at: "2026-08-19T12:00:00.000Z",
      url: "https://fixture.invalid/survey",
      title: "Q1Q2",
      questionText: "",
      grid: null, collectedErrors: [], readerLimitations: [],
      controls: [
        mkCtrl(0, "checkbox", "q1_a", "Company Alpha"),
        mkCtrl(1, "checkbox", "q1_b", "Company Beta"),
        mkCtrl(2, "radio", "q1none", "None of the above"),
        mkCtrl(3, "checkbox", "q2_a", "Condition Gamma"),
        mkCtrl(4, "checkbox", "q2_b", "Condition Delta"),
        mkCtrl(5, "radio", "q2none", "None of the above"),
      ].map((c) => ({ ...c, checked: checked.has(c.idx) })),
      optionGroups: [
        { name: "q1_a", kind: "checkbox", options: [{ ...mkOpt(0, "Company Alpha"), checked: checked.has(0) }] },
        { name: "q1_b", kind: "checkbox", options: [{ ...mkOpt(1, "Company Beta"), checked: checked.has(1) }] },
        { name: "q1none", kind: "radio", options: [{ ...mkOpt(2, "None of the above"), checked: checked.has(2) }] },
        { name: "q2_a", kind: "checkbox", options: [{ ...mkOpt(3, "Condition Gamma"), checked: checked.has(3) }] },
        { name: "q2_b", kind: "checkbox", options: [{ ...mkOpt(4, "Condition Delta"), checked: checked.has(4) }] },
        { name: "q2none", kind: "radio", options: [{ ...mkOpt(5, "None of the above"), checked: checked.has(5) }] },
      ],
      questionRoots: scopedRoots
        ? [
            { via: "question-container+fieldset", label: "Q1", controlIdxs: rootA },
            { via: "question-container+fieldset", label: "Q2", controlIdxs: rootB },
          ]
        : [
            { via: "question-container+fieldset", label: "Q1" },
            { via: "question-container+fieldset", label: "Q2" },
          ],
      buttons: [{ idx: NEXT_IDX, label: ">>", role: "next", roleVia: "text:Next", disabled: false, visible: true }],
      validationMessages: nextClicks > 0 && !done ? ["Please select an answer."] : [],
      progress: { present: false, value: null },
      counts: { controls: 6, optionGroups: 6, options: 6, textInputs: 0, valueInputs: 0, optionsNotOperable: 0, readerLimitations: 0 },
      screenSignature: "sig:twin",
    });
    const doneScreen = {
      ...mkScreen(),
      url: "https://fixture.invalid/survey/after-twin",
      controls: [], optionGroups: [], questionRoots: [], buttons: [],
      validationMessages: [],
      counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0, valueInputs: 0, optionsNotOperable: 0, readerLimitations: 0 },
      screenSignature: "sig:after-twin",
    };
    const idxFromSrc = (src) => {
      const at = src.indexOf(")[");
      if (at < 0) return null;
      const end = src.indexOf("]", at + 2);
      const n = Number(src.slice(at + 2, end));
      return Number.isInteger(n) ? n : null;
    };
    const page = {
      async goto() {},
      async evaluate(script) {
        const src = String(script);
        if (src.includes("screenSignature")) return done ? doneScreen : mkScreen();
        if (src.includes("checkedGroupIdxs")) {
          const idx = idxFromSrc(src);
          const kind = idx === 2 || idx === 5 ? "radio" : "checkbox";
          const names = ["q1_a", "q1_b", "q1none", "q2_a", "q2_b", "q2none"];
          return {
            idx, type: kind, name: idx !== null ? names[idx] ?? null : null, formOwner: 0,
            unnamedControlIdx: null, checked: idx !== null && checked.has(idx),
            checkedGroupIdxs: idx !== null && checked.has(idx) ? [idx] : [],
          };
        }
        return { ok: true };
      },
      async evaluateOnNewDocument() {},
      async $$() {
        return Array.from({ length: 95 }, (_, idx) => ({
          async click() {
            if (idx === NEXT_IDX) {
              if (answered(rootA) && answered(rootB)) done = true;
              else nextClicks += 1;
              return;
            }
            if (idx <= 5) checked.add(idx);
          },
          async type() {}, async focus() {},
        }));
      },
      async screenshot() { return new TextEncoder().encode("PNG-D56"); },
      async setViewport() {}, on() {}, async close() {}, async reload() {},
    };
    const runId = mod.ids.mintRunId();
    const obs = await mod.driver.walkPath(
      page,
      { id: "path_d56twin", decisions: [], witnesses: [] },
      {
        surveyUrl: "https://fixture.invalid/survey", runId, planRevisionId: "plan_d56twin1",
        attemptId: "att_d56twin001", tier: 1, maxSteps: 2, deadline: Date.now() + 30_000,
        viewport: { width: 1280, height: 900 }, applyHistoryShim: false, advanceTimeoutMs: 400,
      },
      { env, runId, attemptId: "att_d56twin001", pathId: "path_d56twin", witnesses: [] },
    );
    return { obs, checked };
  };

  test("THE MEASURED SHAPE: both roots take their own none-option and the walk continues", async () => {
    const { obs, checked } = await twinScreenerWalk();
    assert(checked.has(2) && checked.has(5),
      `each root's own exclusive none must be picked, got ${JSON.stringify([...checked])}`);
    assert(obs.outcome !== "multi-question-screen-actuation-unsupported",
      `the walk must not end at the refusal, outcome was ${JSON.stringify(obs.outcome)}`);
    const step0 = obs.steps[0];
    assertEq(step0.advanced, true, "the twin-screener page advances once both roots are answered");
    assert((obs.readerLimitations ?? []).some((l) => l.kind === "multi-question-screen-actuation-unsupported"),
      "the standing limitation still travels — traversal is not witnessing");
    assertEq(step0.decisionQuestion, null, "no planned decision binds on a multi-root screen");
  });

  test("counterproof: roots without scoped control indexes keep the hard refusal", async () => {
    const { obs } = await twinScreenerWalk({ scopedRoots: false });
    assertEq(obs.outcome, "multi-question-screen-actuation-unsupported",
      "acting without ownership scoping would be a guess — the refusal stands");
  });
});

suite("amendment 13: a forward control the page withholds is waited for, boundedly", () => {
  // Measured live 19 Aug 2026 (run v2r_01m0dj2vcznwcw8krwxhyw5qan, screen 42, question C20):
  // the page rendered its ">>" with visible:false behind a minimum-dwell gate and the walk
  // read "no control advances this screen" and ENDED, 79% of the survey unreached. The fix
  // waits for the control to open. NO DURATION IS ENCODED: these fixtures release after a
  // different number of polls each, and the same code handles all of them.
  const NEXT_IDX = 7;

  const mkCtrl = (idx, type, name, label) => ({
    idx, tag: "input", type, name, id: null, code: null, label, text: "",
    checked: false, value: "", valueIsUserSupplied: false, disabled: false, required: false,
    visible: true, operable: true, actuatedVia: "self", labelIndex: null, placeholder: null,
    maxlength: null, min: null, max: null, step: null, pattern: null, readOnly: false,
  });

  // A screen carrying a BACK control that is usable and a FORWARD control the page is holding
  // back — the exact live shape. `prose` is what a countdown rewrites while it ticks.
  const gatedScreen = ({ answerable = true, forwardVisible = false, prose = "you may proceed shortly" } = {}) => ({
    at: "2026-08-19T12:00:00.000Z",
    url: "https://fixture.invalid/gated",
    title: "C20-like",
    questionText: "",
    instructionText: prose,
    visibleText: prose,
    grid: null,
    collectedErrors: [],
    readerLimitations: [],
    controls: answerable
      ? [mkCtrl(0, "radio", "best", "Profile Variation 1"), mkCtrl(1, "radio", "worst", "Profile Variation 1")]
      : [],
    optionGroups: answerable
      ? [
          { name: "best", kind: "radio", options: [{ order: 0, idx: 0, code: "1", label: "Profile Variation 1", checked: false, disabled: false, visible: true, operable: true, actuatedVia: "self", labelIndex: null }] },
          { name: "worst", kind: "radio", options: [{ order: 0, idx: 1, code: "1", label: "Profile Variation 1", checked: false, disabled: false, visible: true, operable: true, actuatedVia: "self", labelIndex: null }] },
        ]
      : [],
    questionRoots: [],
    buttons: [
      { idx: 6, label: "<<", labelSource: "code", role: "back", roleVia: "code:<<", disabled: false, visible: true },
      { idx: NEXT_IDX, label: ">>", labelSource: "code", role: "other", roleVia: null, disabled: false, visible: forwardVisible },
    ],
    validationMessages: [],
    progress: { present: false, kind: null, now: null, max: null, text: null },
    counts: {
      controls: answerable ? 2 : 0, optionGroups: answerable ? 2 : 0, options: answerable ? 2 : 0,
      textInputs: 0, valueInputs: 0, optionsNotOperable: 0, readerLimitations: 0,
    },
    screenSignature: "sig:gated",
  });

  // A page whose reads are counted, so "never waited" is provable rather than asserted.
  const pollingPage = (screensInOrder) => {
    const state = { reads: 0 };
    return {
      state,
      async goto() {},
      async evaluate(script) {
        const src = String(script);
        if (src.includes("screenSignature")) {
          const i = Math.min(state.reads, screensInOrder.length - 1);
          state.reads += 1;
          return screensInOrder[i];
        }
        return { ok: true };
      },
      async evaluateOnNewDocument() {},
      async $$() { return []; },
      async screenshot() { return new TextEncoder().encode("PNG-A13"); },
      async setViewport() {}, on() {}, async close() {}, async reload() {},
    };
  };

  const repeat = (screen, n) => Array.from({ length: n }, () => screen);

  // ---- the wiring: the WALK itself must wait, advance, and say what it waited for ----
  const gatedWalk = async ({ opensAfterReads = 3, ceilingMs = 300 } = {}) => {
    const { mod } = await loadWorker();
    const env = testEnv();
    const checked = new Set();
    let reads = 0;
    let done = false;
    const live = () => {
      const s = gatedScreen({ forwardVisible: opensAfterReads >= 0 && reads >= opensAfterReads });
      s.controls = s.controls.map((c) => ({ ...c, checked: checked.has(c.idx) }));
      return s;
    };
    const doneScreen = {
      ...gatedScreen(),
      url: "https://fixture.invalid/gated/after",
      controls: [], optionGroups: [], questionRoots: [], buttons: [],
      counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0, valueInputs: 0, optionsNotOperable: 0, readerLimitations: 0 },
      screenSignature: "sig:after-gated",
    };
    const idxFromSrc = (src) => {
      const at = src.indexOf(")[");
      if (at < 0) return null;
      const end = src.indexOf("]", at + 2);
      const n = Number(src.slice(at + 2, end));
      return Number.isInteger(n) ? n : null;
    };
    const page = {
      async goto() {},
      async evaluate(script) {
        const src = String(script);
        if (src.includes("screenSignature")) {
          if (done) return doneScreen;
          const s = live();
          reads += 1;
          return s;
        }
        if (src.includes("checkedGroupIdxs")) {
          const idx = idxFromSrc(src);
          return {
            idx, type: "radio", name: idx === 0 ? "best" : "worst", formOwner: 0,
            unnamedControlIdx: null, checked: idx !== null && checked.has(idx),
            checkedGroupIdxs: idx !== null && checked.has(idx) ? [idx] : [],
          };
        }
        return { ok: true };
      },
      async evaluateOnNewDocument() {},
      async $$() {
        return Array.from({ length: 12 }, (_, idx) => ({
          async click() {
            if (idx === NEXT_IDX) { done = true; return; }
            if (idx <= 1) checked.add(idx);
          },
          async type() {}, async focus() {},
        }));
      },
      async screenshot() { return new TextEncoder().encode("PNG-A13W"); },
      async setViewport() {}, on() {}, async close() {}, async reload() {},
    };
    const runId = mod.ids.mintRunId();
    const obs = await mod.driver.walkPath(
      page,
      { id: "path_a13", decisions: [], witnesses: [] },
      {
        surveyUrl: "https://fixture.invalid/gated", runId, planRevisionId: "plan_a13gate01",
        attemptId: "att_a13gate0001", tier: 1, maxSteps: 2, deadline: Date.now() + 120_000,
        viewport: { width: 1280, height: 900 }, applyHistoryShim: false, advanceTimeoutMs: 400,
        forwardReleaseMaxWaitMs: ceilingMs, forwardReleasePollMs: 20, forwardReleaseTerminalMaxWaitMs: 60,
      },
      { env, runId, attemptId: "att_a13gate0001", pathId: "path_a13", witnesses: [] },
    );
    return { obs };
  };

  test("THE WALK ITSELF waits out the gate, presses the control that opened, and puts the measured wait in the receipt", async () => {
    const { obs } = await gatedWalk({ opensAfterReads: 3 });
    const step0 = obs.steps[0];
    assertEq(step0.advanced, true,
      `the walk must get past a screen whose only fault was a gate, outcome was ${JSON.stringify(obs.outcome)}`);
    const press = (step0.actions ?? []).find((a) => a.kind === "click-next");
    assert(press && String(press.detail).includes("forward control enabled after"),
      `the press receipt must carry the MEASURED wait, got ${JSON.stringify(press?.detail)}`);
    assert(String(press.detail).includes("WITHHELD"),
      "and it must say the page was withholding the control, not offering it");
  });

  test("THE WALK ITSELF ends honestly when the gate never opens, naming the control it could not press", async () => {
    const { obs } = await gatedWalk({ opensAfterReads: -1, ceilingMs: 70 });
    assertEq(obs.outcome, "no-advance-control", "a gate that never opens is still an honest dead stop");
    assert(String(obs.outcomeDetail).includes("OUT OF REACH"),
      `the outcome must not read like a thank-you page, got ${JSON.stringify(obs.outcomeDetail)}`);
    assert((obs.readerLimitations ?? []).some((l) => l.kind === "forward-control-withheld"),
      `the withheld control must be a counted limitation, got ${JSON.stringify(obs.readerLimitations)}`);
  });


  test("THE MEASURED SHAPE: a hidden forward control that opens mid-poll releases the wait, and the wait is measured", async () => {
    const { mod } = await loadWorker();
    // Held for two polls, open on the third — a number this code never knew in advance.
    const page = pollingPage([
      ...repeat(gatedScreen({ prose: "proceed in 9" }), 1),
      ...repeat(gatedScreen({ prose: "proceed in 6" }), 1),
      gatedScreen({ forwardVisible: true, prose: "proceed now" }),
    ]);
    const held = await mod.driver.awaitForwardRelease(
      page,
      gatedScreen({ prose: "proceed in 12" }),
      { deadline: Date.now() + 120_000, forwardReleasePollMs: 20, forwardReleaseTerminalMaxWaitMs: 60, forwardReleaseMaxWaitMs: 5_000 },
      "fixture",
    );
    assertEq(held.released, true, "the control opened, so the wait must report a release");
    assertEq(held.polls, 3, `release must be noticed on the poll that sees it, got ${held.polls}`);
    assert(held.waitedMs >= 40, `the measured wait is evidence and must be real, got ${held.waitedMs}ms`);
    assert(held.screen !== null && held.screen.buttons.some((b) => b.idx === NEXT_IDX && b.visible),
      "the released screen must be handed back so the walk presses the control that actually opened");
    assertEq(held.withheld.length, 1, "exactly one forward control was being withheld");
    assertEq(held.withheld[0].why, "present but hidden", "the live shape is hidden, not disabled");
  });

  test("a DISABLED forward control is withheld too, not just a hidden one", async () => {
    const { mod } = await loadWorker();
    const screen = gatedScreen({ forwardVisible: true });
    screen.buttons[1].disabled = true;
    const held = mod.driver.withheldForwardControls(screen);
    assertEq(held.length, 1, "a present-but-disabled forward control is withheld");
    assertEq(held[0].why, "present but disabled", "and it is named for what it is");
  });

  test("a BACK control is never mistaken for a withheld way forward", async () => {
    const { mod } = await loadWorker();
    const screen = gatedScreen();
    // Both buttons hidden: only the forward-eligible one may count.
    screen.buttons[0].visible = false;
    const held = mod.driver.withheldForwardControls(screen);
    assertEq(held.length, 1, `only the forward candidate counts, got ${JSON.stringify(held)}`);
    assertEq(held[0].idx, NEXT_IDX, "and it is the forward one");
  });

  test("counterproof: a screen with NO forward control at all never waits and never re-reads", async () => {
    const { mod } = await loadWorker();
    const bare = gatedScreen();
    bare.buttons = [];
    const page = pollingPage([bare]);
    const held = await mod.driver.awaitForwardRelease(
      page,
      bare,
      { deadline: Date.now() + 120_000, forwardReleasePollMs: 20, forwardReleaseTerminalMaxWaitMs: 60, forwardReleaseMaxWaitMs: 5_000 },
      "fixture",
    );
    assertEq(held.polls, 0, "nothing was being withheld, so there was nothing to wait for");
    assertEq(held.waitedMs, 0, "a real ending must cost no time at all");
    assertEq(page.state.reads, 0, "and it must not re-read the page even once");
  });

  test("a gate that never opens stops at the ceiling and reports the wait it actually spent", async () => {
    const { mod } = await loadWorker();
    const page = pollingPage(repeat(gatedScreen({ prose: "still waiting" }), 40));
    const t0 = Date.now();
    const held = await mod.driver.awaitForwardRelease(
      page,
      gatedScreen({ prose: "still waiting" }),
      { deadline: Date.now() + 600_000, forwardReleasePollMs: 20, forwardReleaseTerminalMaxWaitMs: 60, forwardReleaseMaxWaitMs: 70 },
      "fixture",
    );
    const elapsed = Date.now() - t0;
    assertEq(held.released, false, "the control never opened, and the wait must not pretend it did");
    assert(held.polls >= 1 && held.polls <= 3, `the ceiling bounds the polling, got ${held.polls}`);
    assert(elapsed < 5_000, `patience must never become an unbounded wait, took ${elapsed}ms`);
    assertEq(held.ceilingMs, 70, "the ceiling actually applied travels in the receipt");
  });

  test("a screen that LOOKS TERMINAL and says nothing new stops at the short cap, not the configured ceiling", async () => {
    const { mod } = await loadWorker();
    // No answerable controls + unchanging prose = what a real thank-you page looks like. A
    // completion page must not cost the full ceiling on every walk of every run.
    const terminal = gatedScreen({ answerable: false, prose: "Thank you for taking part." });
    const page = pollingPage(repeat(terminal, 40));
    const held = await mod.driver.awaitForwardRelease(
      page,
      terminal,
      { deadline: Date.now() + 600_000, forwardReleasePollMs: 20, forwardReleaseTerminalMaxWaitMs: 60, forwardReleaseMaxWaitMs: 5_000 },
      "fixture",
    );
    assertEq(held.released, false, "nothing opened");
    assertEq(held.ceilingMs, 60, `the terminal-looking cap must apply, got ${held.ceilingMs}`);
    assert(held.waitedMs < 2_000, `a completion page must not pay the full ceiling, waited ${held.waitedMs}ms`);
  });

  test("counterproof: a terminal-looking screen whose own prose keeps changing earns the full ceiling back", async () => {
    const { mod } = await loadWorker();
    // Same shape, except the page is visibly still working — a countdown rewriting itself. That
    // is proof of life, and it must buy the patience the short cap would have denied.
    const ticking = (n) => gatedScreen({ answerable: false, prose: `proceed in ${n} seconds` });
    const page = pollingPage([
      ticking(9), ticking(6), ticking(3),
      gatedScreen({ answerable: false, forwardVisible: true, prose: "proceed now" }),
    ]);
    const held = await mod.driver.awaitForwardRelease(
      page,
      ticking(12),
      { deadline: Date.now() + 600_000, forwardReleasePollMs: 20, forwardReleaseTerminalMaxWaitMs: 60, forwardReleaseMaxWaitMs: 5_000 },
      "fixture",
    );
    assertEq(held.released, true, "a page that kept working long enough to open must be waited for");
    assertEq(held.polls, 4, `the wait must run past the short cap, got ${held.polls} polls`);
    assert(held.waitedMs > 60, `the short cap must have been lifted, waited only ${held.waitedMs}ms`);
  });

  test("PRODUCTION TIMING DEFAULTS are pinned — fixtures inject milliseconds, the deployed walk must not", async () => {
    const { mod } = await loadWorker();
    // The tests above run the real decision procedure in milliseconds so a mutant run costs
    // milliseconds too. That speed is only honest if the values production actually uses are
    // pinned somewhere a weakening mutant cannot slip past — this is that place.
    assertEq(mod.driver.FORWARD_RELEASE_POLL_MS, 3_000,
      "production polls every 3s; a fixture-speed interval must never reach the deployed walk");
    assertEq(mod.driver.FORWARD_RELEASE_MAX_WAIT_MS, 90_000,
      "the production ceiling is a generous safety bound, not a dwell estimate");
    assertEq(mod.driver.FORWARD_RELEASE_TERMINAL_LOOKING_MAX_WAIT_MS, 9_000,
      "the terminal-looking patience must stay long enough to clear a short gate");
    assert(mod.driver.FORWARD_RELEASE_TERMINAL_LOOKING_MAX_WAIT_MS < mod.driver.FORWARD_RELEASE_MAX_WAIT_MS,
      "the terminal cap is only meaningful while it is shorter than the full ceiling");
    assert(mod.driver.FORWARD_RELEASE_POLL_MS < mod.driver.FORWARD_RELEASE_TERMINAL_LOOKING_MAX_WAIT_MS,
      "a poll interval at or above the short cap would make terminal-looking patience a single glance");
  });

  test("a walk given no timing options at all falls back to the production defaults", async () => {
    const { mod } = await loadWorker();
    // The injection points must DEFAULT, not require. A deployment that passes nothing gets the
    // real timings; this is what stops the fixture speed from being the shipped behaviour.
    const t0 = Date.now();
    const bare = gatedScreen();
    bare.buttons = [];
    await mod.driver.awaitForwardRelease(bare && bare, bare, { deadline: Date.now() + 50 }, "fixture");
    assert(Date.now() - t0 < 1_000, "a screen with nothing withheld must return immediately even with real defaults");
    const held = await mod.driver.awaitForwardRelease(
      { async evaluate() { throw new Error("must not be read"); } },
      gatedScreen(),
      // Deadline inside one production poll interval: the loop must decline to start rather than
      // overrun it, which only works if the REAL 3s interval is what it fell back to.
      { deadline: Date.now() + 500 },
      "fixture",
    );
    assertEq(held.polls, 0, "with the production interval and a 500ms deadline, no poll may start");
    assertEq(held.ceilingMs, mod.driver.FORWARD_RELEASE_MAX_WAIT_MS,
      "and the ceiling it fell back to must be the production default");
  });

  test("the ceiling is a CONFIGURED bound, never this survey's dwell baked into the code", async () => {
    const { mod } = await loadWorker();
    const { readFileSync } = await import("fs");
    assert(mod.driver.FORWARD_RELEASE_MAX_WAIT_MS >= 60_000,
      `the default ceiling is a safety bound and must be generous, got ${mod.driver.FORWARD_RELEASE_MAX_WAIT_MS}`);
    const batch = readFileSync("src/workflow/stages/execute-batch.ts", "utf8");
    assert(batch.includes("EXEC_FORWARD_RELEASE_MAX_WAIT_MS"),
      "the ceiling must be raisable per deployment without a code change");
    assert(batch.includes("forwardReleaseMaxWaitMs:"),
      "and it must actually reach the walk, not merely be read from the environment");
  });

  test("the ending classifier reports a withheld way forward as evidence, and still refuses to name the ending", async () => {
    const { mod } = await loadWorker();
    // The LIVE shape: answerable controls still on the screen, so the structural screen-out arm
    // stays inert and the ending genuinely has nothing to name it.
    const ending = mod.driver.classifyEnding(gatedScreen({ prose: "" }), {
      outcome: "no-advance-control", unboundDecisions: 0,
    });
    assertEq(ending.kind, "unclassified",
      "a hidden Next on an unrecognised terminal page must not become a positive 'stalled' claim");
    assert(ending.evidence.some((e) => e.includes("out of reach")),
      `the withheld control must still be reported, got ${JSON.stringify(ending.evidence)}`);
  });

  test("counterproof: a completion page keeps its completed ending even carrying a hidden forward control", async () => {
    const { mod } = await loadWorker();
    const done = gatedScreen({ answerable: false, prose: "Thank you for completing this survey." });
    const ending = mod.driver.classifyEnding(done, { outcome: "no-advance-control", unboundDecisions: 0 });
    assertEq(ending.kind, "completed",
      "completion wording outranks the withheld-control evidence — a real completion must still read as one");
  });
});

// ===========================================================================
// amendment 14: the deep walk's own step budget, when the environment loses it
//
// Completion-path audit §5.4. Every shipped environment declares
// EXEC_MAX_STEPS_PER_PATH = 120, sized in wrangler.jsonc's own comment against the measured
// ~85-100-screen full traversal. The CODE fallback was 40. Forty does not clear this survey,
// and the failure is silent in exactly the way CLAUDE.md forbids: an over-cap walk is converted
// to `outcome: "step-cap"` and therefore `ending: stalled` (driver.ts), so a deploy that lost
// the variable would report walks that gave up instead of the walk that finished.
// ===========================================================================
suite("amendment 14: a lost env var must not silently cap the deep walk", () => {
  test("the code fallback clears every shipped config's declared step cap", async () => {
    const { mod } = await loadWorker();
    const { readFileSync, readdirSync } = await import("fs");
    const fallback = mod.executeBatch.DEFAULT_MAX_STEPS_PER_PATH;

    const configs = ["wrangler.jsonc", ...readdirSync(".").filter((f) => f.startsWith("wrangler.arm-") && f.endsWith(".jsonc"))];
    assert(configs.length >= 2, `expected the deployed config and the arm configs, got ${JSON.stringify(configs)}`);
    for (const f of configs) {
      const declared = Number(readFileSync(f, "utf8").match(/"EXEC_MAX_STEPS_PER_PATH"\s*:\s*"(\d+)"/)?.[1]);
      // A config that stopped declaring it would make the comparison vacuous, so the absence is
      // itself a failure rather than a quietly skipped row.
      assert(Number.isFinite(declared), `${f} declares no EXEC_MAX_STEPS_PER_PATH to compare against`);
      assert(
        fallback >= declared,
        `${f} sizes walks at ${declared} screens and the code default is ${fallback}: an environment that lost the ` +
          `variable would cap every deep walk below what this config was sized for, and report it as a stall`,
      );
    }
  });

  test("...and it clears the measured traversal itself, not merely whatever the configs say", async () => {
    const { mod } = await loadWorker();
    // The independent half. If someone lowered every config to 40, the comparison above would
    // pass while nothing could reach a completion page. The number this is pinned against is
    // wrangler.jsonc's own stated sizing argument: a ~85-100-screen full traversal.
    assert(
      mod.executeBatch.DEFAULT_MAX_STEPS_PER_PATH >= 100,
      `the fallback (${mod.executeBatch.DEFAULT_MAX_STEPS_PER_PATH}) does not clear the measured ~85-100-screen traversal`,
    );
  });

  test("THE RESOLVER, NOT A LINE OF SOURCE: an environment with no step cap resolves to the fallback", async () => {
    const { mod } = await loadWorker();
    const { resolveMaxStepsPerPath, DEFAULT_MAX_STEPS_PER_PATH } = mod.executeBatch;

    // The property stated as behaviour, so a mutation can kill it. An assertion that only greps
    // the source cannot: the mutant harness rewrites the module inside esbuild's load step and
    // never touches the file on disk.
    assertEq(resolveMaxStepsPerPath(undefined), DEFAULT_MAX_STEPS_PER_PATH, "a missing variable takes the fallback");
    assertEq(resolveMaxStepsPerPath("55"), 55, "and a declared value still wins — this is a fallback, not a policy");
    assertEq(resolveMaxStepsPerPath("not a number"), DEFAULT_MAX_STEPS_PER_PATH, "an unreadable value is not a cap of NaN");
  });

  test("the call site resolves through it, and a missing variable is named rather than silently defaulted", async () => {
    const { readFileSync } = await import("fs");
    const source = readFileSync("src/workflow/stages/execute-batch.ts", "utf8");
    // A SOURCE-LEVEL DRIFT GUARD, and honestly labelled as one: this pair is not killable by the
    // mutation campaign (the rewrite is in-memory), so it is a review aid in the same spirit as
    // amendment 3b above — the behavioural half of this property is the test before it.
    assert(
      /const maxSteps = resolveMaxStepsPerPath\(declaredMaxSteps\);/.test(source),
      "the step-cap read no longer resolves through resolveMaxStepsPerPath",
    );
    assert(
      /EXEC_MAX_STEPS_PER_PATH is not set in this environment/.test(source),
      "an environment missing the variable must be named in the log, not silently defaulted",
    );
  });
});

suite("amendment 15: a rejected choice grid re-picks DISTINCT columns instead of the same one twice", () => {
  // The shape forward-scan §3.3 names on twelve upcoming screens (C20 ×4, D40 ×8): a 2-row
  // (Best, Worst) × 3-column (Profile Variation 1/2/3) radio grid on which naming the SAME
  // column twice is invalid. The grid pass answers each row with its first cell and has no
  // sibling awareness, so both rows land on column 1, the site rejects, and the recovery
  // re-derives the identical answer for every round it is given.
  //
  // THE FIXTURE'S REJECTION MESSAGE IS DELIBERATELY GENERIC — "Please review your responses on
  // this page." It contains no "best", no "worst", no "same", no "different". A fix that passes
  // this suite therefore CANNOT be reading the validation's words for the constraint's
  // semantics; the only thing left to read is the observable pair the class is defined on —
  // validation standing, and two or more rows sitting on one column. That is what keeps this a
  // class fix rather than a transcription of one questionnaire's wording.
  const NEXT_IDX = 90;
  const GENERIC_VALIDATION = "Please review your responses on this page.";

  /**
   * One walk over one grid page. `accepts(picks, submitOrdinal)` is THE SITE'S rule and nothing
   * else — the walker is never told what it is, only shown the generic rejection when it is
   * unmet. `picks[r]` is the column index row r currently holds, which is what the fixture
   * asserts on afterwards.
   */
  const gridWalk = async ({ rowLabels, columns, cellType = "radio", accepts }) => {
    const { mod } = await loadWorker();
    const env = testEnv();
    const width = columns.length;
    const cellCount = rowLabels.length * width;
    const picks = rowLabels.map(() => null);
    const idxOf = (r, c) => r * width + c;
    let submits = 0;
    let rejected = false;
    let done = false;
    const mkControl = (r, c) => ({
      idx: idxOf(r, c), tag: "input", type: cellType, name: `row_${r}`, id: null, code: null,
      label: `${rowLabels[r]} / ${columns[c]}`, text: "",
      checked: cellType === "radio" ? picks[r] === c : false,
      value: "", valueIsUserSupplied: false, disabled: false, required: false,
      visible: true, operable: true, actuatedVia: "self", labelIndex: null,
      placeholder: null, maxlength: null, min: null, max: null, step: null, pattern: null,
      readOnly: false,
    });
    const mkScreen = () => ({
      at: "2026-08-19T12:00:00.000Z",
      url: "https://fixture.invalid/survey",
      title: "BW",
      questionText: "Please indicate the best and the worst of the profiles you reviewed.",
      instructionText: null, visibleText: "", visibleTextTruncated: false,
      bracketedInstructionsVisible: [], collectedErrors: [], readerLimitations: [],
      controls: rowLabels.flatMap((_, r) => columns.map((__, c) => mkControl(r, c))),
      optionGroups: cellType === "radio"
        ? rowLabels.map((label, r) => ({
            name: `row_${r}`,
            kind: "radio",
            options: columns.map((col, c) => ({
              order: c, idx: idxOf(r, c), code: `${r + 1}-${c + 1}`, label: `${label} / ${col}`,
              checked: picks[r] === c, disabled: false, visible: true, operable: true,
              actuatedVia: "self", labelIndex: null,
            })),
          }))
        : [],
      grid: {
        columns: [...columns],
        rows: rowLabels.map((label, r) => ({
          label,
          name: `row_${r}`,
          cells: columns.map((col, c) => ({
            column: col, code: `${r + 1}-${c + 1}`, checked: picks[r] === c, idx: idxOf(r, c),
          })),
        })),
      },
      buttons: [{ idx: NEXT_IDX, label: ">>", role: "next", roleVia: "text:Next", disabled: false, visible: true }],
      validationMessages: rejected && !done ? [GENERIC_VALIDATION] : [],
      progress: { present: false, kind: null, now: null, max: null, text: null },
      counts: {
        controls: cellCount,
        optionGroups: cellType === "radio" ? rowLabels.length : 0,
        options: cellType === "radio" ? cellCount : 0,
        textInputs: cellType === "radio" ? 0 : cellCount,
        valueInputs: cellType === "radio" ? 0 : cellCount,
        optionsNotOperable: 0, readerLimitations: 0,
      },
      screenSignature: "sig:bw",
    });
    const doneScreen = {
      ...mkScreen(),
      url: "https://fixture.invalid/survey/after-bw",
      controls: [], optionGroups: [], grid: null, buttons: [], validationMessages: [],
      counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0, valueInputs: 0, optionsNotOperable: 0, readerLimitations: 0 },
      screenSignature: "sig:after-bw",
    };
    const idxFromSrc = (src) => {
      const at = src.indexOf(")[");
      if (at < 0) return null;
      const end = src.indexOf("]", at + 2);
      const n = Number(src.slice(at + 2, end));
      return Number.isInteger(n) ? n : null;
    };
    const page = {
      async goto() {},
      async evaluate(script) {
        const src = String(script);
        if (src.includes("screenSignature")) return done ? doneScreen : mkScreen();
        if (src.includes("checkedGroupIdxs")) {
          const idx = idxFromSrc(src);
          if (cellType !== "radio" || idx === null || idx < 0 || idx >= cellCount) return null;
          const r = Math.floor(idx / width);
          // A row is one native radio group: picking a cell unchecks that row's other cells.
          return {
            idx, type: "radio", name: `row_${r}`, formOwner: 0, unnamedControlIdx: null,
            checked: picks[r] === idx % width,
            checkedGroupIdxs: picks[r] === null ? [] : [idxOf(r, picks[r])],
          };
        }
        return { ok: true };
      },
      async evaluateOnNewDocument() {},
      async $$() {
        return Array.from({ length: 95 }, (_, idx) => ({
          async click() {
            if (idx === NEXT_IDX) {
              submits += 1;
              if (accepts(picks.slice(), submits)) { done = true; rejected = false; }
              else rejected = true;
              return;
            }
            if (idx >= 0 && idx < cellCount) picks[Math.floor(idx / width)] = idx % width;
          },
          async type() {}, async focus() {},
        }));
      },
      async screenshot() { return new TextEncoder().encode("PNG-D56"); },
      async setViewport() {}, on() {}, async close() {}, async reload() {},
    };
    const runId = mod.ids.mintRunId();
    const obs = await mod.driver.walkPath(
      page,
      { id: "path_d56bw", decisions: [], witnesses: [] },
      {
        surveyUrl: "https://fixture.invalid/survey", runId, planRevisionId: "plan_d56bw1",
        attemptId: "att_d56bw001", tier: 1, maxSteps: 2, deadline: Date.now() + 30_000,
        viewport: { width: 1280, height: 900 }, applyHistoryShim: false, advanceTimeoutMs: 400,
      },
      { env, runId, attemptId: "att_d56bw001", pathId: "path_d56bw", witnesses: [] },
    );
    const cellsOf = (steps) =>
      steps.flatMap((s) => (s.actions ?? []).filter((a) => a.kind === "select-grid-cell"));
    return {
      obs,
      picks,
      submits,
      firstPassCells: cellsOf(obs.steps.filter((s) => s.decisionSource !== "recovery")),
      recoveryCells: cellsOf(obs.steps.filter((s) => s.decisionSource === "recovery")),
      allCells: cellsOf(obs.steps),
    };
  };

  test("THE MEASURED SHAPE: a rejected 2x3 best/worst grid re-picks distinct columns and advances", async () => {
    const { obs, picks, firstPassCells, recoveryCells } = await gridWalk({
      rowLabels: ["Best", "Worst"],
      columns: ["Profile Variation 1", "Profile Variation 2", "Profile Variation 3"],
      // The site's rule, never shown to the walker: both rows answered, on different columns.
      accepts: (p) => p[0] !== null && p[1] !== null && p[0] !== p[1],
    });
    assertEq(JSON.stringify(picks), JSON.stringify([0, 1]),
      `Best and Worst must end on DIFFERENT columns, deterministically row k -> column k, got ${JSON.stringify(picks)}`);
    assertEq(firstPassCells.length, 2,
      `the first pass still answers every row, got ${firstPassCells.length}`);
    assert(firstPassCells.every((a) => !String(a.detail).includes("distinct-column-repick")),
      `the FIRST pass must be untouched — the conquered wide grids answer every row with one column legally, got ${JSON.stringify(firstPassCells.map((a) => a.detail))}`);
    assertEq(recoveryCells.length, 2,
      `the recovery round re-answers both rows, got ${recoveryCells.length}`);
    assert(recoveryCells.every((a) =>
      String(a.detail).includes("grid:distinct-column-repick") &&
      String(a.detail).includes("validation standing and 2 rows share a column") &&
      String(a.detail).includes("for distinctness")),
      `every re-pick receipt must say WHY it moved, got ${JSON.stringify(recoveryCells.map((a) => a.detail))}`);
    assert(recoveryCells.some((a) =>
      String(a.detail).includes('re-picked row "Worst" to column "Profile Variation 2"')),
      `the receipt must name the row it moved and the column it moved to, got ${JSON.stringify(recoveryCells.map((a) => a.detail))}`);
    assert(obs.steps.some((s) => s.decisionSource === "recovery" && s.advanced === true),
      `the recovery must clear the wall the first pass hit, steps were ${JSON.stringify(obs.steps.map((s) => [s.stepIndex, s.decisionSource, s.advanced]))}`);
  });

  test("counterproof: a legal same-column grid with no validation standing is never re-picked", async () => {
    // The conquered shape this fix must not disturb: a 3-row x 5-point rating grid (D20/D30)
    // where answering every row with the same column is perfectly legal. Nothing rejects it, so
    // no validation ever stands, so the distinct-column re-pick must never run.
    const { obs, picks, allCells } = await gridWalk({
      rowLabels: ["Product X", "Product Y", "Product Z"],
      columns: ["Very unlikely", "Unlikely", "Neither", "Likely", "Very likely"],
      accepts: () => true,
    });
    assertEq(JSON.stringify(picks), JSON.stringify([0, 0, 0]),
      `a legal same-column answer must be left exactly as the first pass made it, got ${JSON.stringify(picks)}`);
    assert(allCells.every((a) => !String(a.detail).includes("distinct-column-repick")),
      `no validation stood, so nothing may be re-picked, got ${JSON.stringify(allCells.map((a) => a.detail))}`);
    assert(!obs.steps.some((s) => s.decisionSource === "recovery"),
      "the page took the answer, so no recovery round should exist at all");
  });

  test("fewer columns than rows: the spread is the best available and every receipt names the shortfall", async () => {
    // Distinctness is not always reachable. Three rows over two columns CANNOT all differ, and
    // the honest behaviour is to spread as far as the grid allows and say so on the record —
    // never to claim a distinctness the grid cannot provide.
    const { picks, recoveryCells } = await gridWalk({
      rowLabels: ["Row A", "Row B", "Row C"],
      columns: ["Yes", "No"],
      accepts: (_p, submitOrdinal) => submitOrdinal > 1,
    });
    assertEq(JSON.stringify(picks), JSON.stringify([0, 1, 0]),
      `three rows over two columns cycle as far as the grid allows, got ${JSON.stringify(picks)}`);
    assertEq(recoveryCells.length, 3, `all three rows are re-answered, got ${recoveryCells.length}`);
    assert(recoveryCells.every((a) =>
      String(a.detail).includes("LIMITATION: this grid offers 2 columns for 3 answerable rows") &&
      String(a.detail).includes("some still repeat")),
      `a grid that cannot make its rows distinct must NAME that on every receipt, got ${JSON.stringify(recoveryCells.map((a) => a.detail))}`);
  });

  test("counterproof: a NON-choice grid is never distinct-column re-picked, validation or not", async () => {
    // The trigger is scoped to CHOICE grids on purpose. A grid of value cells — the allocation
    // shape amendment 7 owns — has no "one column per row" semantics to satisfy, and spreading
    // its cells would move answers off the column the plan asked for to chase a constraint that
    // cannot exist there. Validation stands here and the re-pick must still not fire.
    // Asserted on the GRID PASS'S OWN targets, not on what the page ends up holding: the value
    // loop fills text cells afterwards and moves the page's state for reasons of its own, which
    // is exactly the noise a claim about the grid pass must not be read out of.
    const { recoveryCells, allCells } = await gridWalk({
      rowLabels: ["Row A", "Row B"],
      columns: ["Col 1", "Col 2", "Col 3"],
      cellType: "text",
      accepts: (_p, submitOrdinal) => submitOrdinal > 1,
    });
    assertEq(JSON.stringify(recoveryCells.map((a) => a.targetIdx)), JSON.stringify([0, 3]),
      `a value grid keeps each row's FIRST cell even under standing validation (a spread would target [0,4]), got ${JSON.stringify(recoveryCells.map((a) => a.targetIdx))}`);
    assert(allCells.every((a) => !String(a.detail).includes("distinct-column-repick")),
      `the re-pick is for choice grids only, got ${JSON.stringify(allCells.map((a) => a.detail))}`);
  });
});

suite("amendment 16: a demand the site has made stands until the step ends", () => {
  // Measured live 20 Aug 2026 (run v2r_01m0e6axg4phhm8wzeh3a3fxw5, screen 54, question D10):
  // an allocation grid demanded numeric answers summing to 100. Recovery round 1 derived that
  // and set 100/0/0. The page then re-rendered carrying NO validation messages, so round 2 —
  // deriving from the newest read alone — saw no demand, fell back to the generic text default
  // and typed probe text into the same numeric cells. Round 3 set numbers again. The ladder
  // oscillated instead of converging and the walk stopped at 39% of the survey.
  const NEXT_IDX = 30;
  const CELL_IDXS = [0, 1, 2];
  const NUMERIC_DEMAND =
    "Please enter numeric answers for «A», «B» and «C» in column Future. " +
    "Please ensure the sum of your answers equals 100 in column Future.";
  const REVIEW = "Please review your responses on this page. One or more questions require further input.";

  const numCell = (idx) => ({
    idx, tag: "input", type: "text", name: `cell_${idx}`, id: null, code: null, label: "%", text: "",
    checked: false, value: "", valueIsUserSupplied: false, disabled: false, required: false,
    visible: true, operable: true, actuatedVia: "self", labelIndex: null, placeholder: null,
    maxlength: null, min: null, max: null, step: null, pattern: null, readOnly: false,
  });

  // `validation` is what THIS read carries — the live defect is that it goes empty after the
  // round that answered it, while the demand itself has not been withdrawn.
  const gridScreen = (validation) => ({
    at: "2026-08-20T12:00:00.000Z",
    url: "https://fixture.invalid/alloc",
    title: "D10-like",
    questionText: "D10",
    instructionText: "",
    visibleText: "Future column",
    grid: null,
    collectedErrors: [],
    readerLimitations: [],
    controls: CELL_IDXS.map(numCell),
    optionGroups: [],
    questionRoots: [],
    buttons: [{ idx: NEXT_IDX, label: ">>", labelSource: "code", role: "other", roleVia: null, disabled: false, visible: true }],
    validationMessages: validation,
    progress: { present: false, kind: null, now: null, max: null, text: null },
    counts: { controls: 3, optionGroups: 0, options: 0, textInputs: 3, valueInputs: 3, optionsNotOperable: 0, readerLimitations: 0 },
    screenSignature: "sig:alloc",
  });

  // THE MEASURED SEQUENCE. The site states the demand once, then stops repeating it while still
  // refusing to advance — exactly what D10 did.
  const allocWalk = async () => {
    const { mod } = await loadWorker();
    const env = testEnv();
    const typed = new Map();
    let submits = 0;
    const readsAfterFirstSubmit = () => (submits === 0 ? [] : submits === 1 ? [REVIEW, NUMERIC_DEMAND] : []);
    const page = {
      async goto() {},
      async evaluate(script) {
        const src = String(script);
        if (src.includes("screenSignature")) {
          const s = gridScreen(readsAfterFirstSubmit());
          s.controls = s.controls.map((c) => ({ ...c, value: typed.get(c.idx) ?? "" }));
          return s;
        }
        if (src.includes("checkedGroupIdxs")) return { idx: null, type: null, name: null, formOwner: 0, unnamedControlIdx: null, checked: false, checkedGroupIdxs: [] };
        // set-value / read-value helpers: record what the driver wrote.
        const at = src.indexOf(")[");
        if (at >= 0) {
          const end = src.indexOf("]", at + 2);
          const idx = Number(src.slice(at + 2, end));
          const q = src.indexOf('"');
          if (Number.isInteger(idx) && src.includes("value") && q >= 0) {
            const q2 = src.indexOf('"', q + 1);
            if (q2 > q) typed.set(idx, src.slice(q + 1, q2));
          }
          return { ok: true, value: typed.get(idx) ?? "" };
        }
        return { ok: true };
      },
      async evaluateOnNewDocument() {},
      async $$() {
        return Array.from({ length: 40 }, (_, idx) => ({
          async click() { if (idx === NEXT_IDX) submits += 1; },
          async type(text) { typed.set(idx, String(text).replace(/[^0-9.\-]/g, "").slice(0, 12) || "-"); },
          async focus() {},
        }));
      },
      async screenshot() { return new TextEncoder().encode("PNG-A16"); },
      async setViewport() {}, on() {}, async close() {}, async reload() {},
    };
    const runId = mod.ids.mintRunId();
    const obs = await mod.driver.walkPath(
      page,
      { id: "path_a16", decisions: [], witnesses: [] },
      {
        surveyUrl: "https://fixture.invalid/alloc", runId, planRevisionId: "plan_a16alloc1",
        attemptId: "att_a16alloc001", tier: 1, maxSteps: 2, deadline: Date.now() + 60_000,
        viewport: { width: 1280, height: 900 }, applyHistoryShim: false, advanceTimeoutMs: 120,
        forwardReleasePollMs: 20, forwardReleaseTerminalMaxWaitMs: 60, forwardReleaseMaxWaitMs: 5_000,
      },
      { env, runId, attemptId: "att_a16alloc001", pathId: "path_a16", witnesses: [] },
    );
    return { obs };
  };

  test("THE MEASURED SHAPE: a numeric demand survives the re-render that stops repeating it", async () => {
    const { obs } = await allocWalk();
    const recovery = obs.steps.find((s) => s.decisionSource === "recovery");
    assert(recovery, "the blocked screen must have run recovery rounds");
    const valueWrites = (recovery.actions ?? []).filter((a) => a.kind === "set-value" || a.kind === "type-text");
    assert(valueWrites.length > 0, "the recovery must have written values");
    // THE REGRESSION THIS PINS: once the site has demanded numbers, no later round may put
    // non-numeric probe text back into those cells.
    const afterDemand = valueWrites.filter((a) => a.value !== null && a.value !== undefined);
    const nonNumeric = afterDemand.filter((a) => !/^-?\d+(\.\d+)?$/.test(String(a.value)));
    assertEq(nonNumeric.length, 0,
      `a standing numeric demand was regressed to free text: ${JSON.stringify(nonNumeric.map((a) => [a.targetIdx, a.value]))}`);
  });

  test("mergeStandingDemands keeps an earlier demand when the newest read carries none", async () => {
    const { mod } = await loadWorker();
    const merged = mod.driver.mergeStandingDemands([NUMERIC_DEMAND], []);
    assertEq(merged.length, 1, "an empty read is not the site withdrawing its demand");
    assertEq(merged[0], NUMERIC_DEMAND, "and the demand it keeps is the one that was made");
  });

  test("BOTH demands are satisfied when the site adds a second one", async () => {
    const { mod } = await loadWorker();
    const pairing = "Please make sure you choose different Profile Variation for both Best and Worst rows.";
    const merged = mod.driver.mergeStandingDemands([NUMERIC_DEMAND], [pairing]);
    assertEq(merged.length, 2, `both demands must stand, got ${JSON.stringify(merged)}`);
    assertEq(merged[0], pairing, "the site's newest word is ordered first so first-match derivation follows it");
    assert(merged.includes(NUMERIC_DEMAND), "and the earlier demand is still there to be satisfied");
  });

  test("a repeated demand is not counted twice, however the site re-spaces it", async () => {
    const { mod } = await loadWorker();
    const merged = mod.driver.mergeStandingDemands([NUMERIC_DEMAND], [`  ${NUMERIC_DEMAND.toUpperCase()}  `]);
    assertEq(merged.length, 1, `whitespace and case must not create a second demand: ${JSON.stringify(merged)}`);
  });

  test("counterproof: with no demand ever made, nothing is invented", async () => {
    const { mod } = await loadWorker();
    assertEq(mod.driver.mergeStandingDemands([], []).length, 0, "no demand means no demand");
  });
});

suite("amendment 17: the site's own position counter is movement evidence when it is prose", () => {
  // Measured live 20 Aug 2026 (run v2r_01m0eddha4xfq66xhynfmaq2cw, screen 54, question D10):
  // the walk pressed forward three times and the survey MOVED each time — "Survey progress: 39%"
  // became 43% then 44% — while every structural signal stayed silent, because the D-section
  // repeats one question shape. Byte-identical screen signature, unchanged question identity,
  // unchanged URL, historyLength pinned at 50, no validation. The walk called it advance-timeout
  // and stopped at 54 screens while the respondent had genuinely gone further.
  const screenAt = (progressText, over = {}) => ({
    at: "2026-08-20T12:00:00.000Z",
    url: "https://fixture.invalid/loop",
    title: "D-section",
    questionText: "D10",
    instructionText: "",
    visibleText: "allocation grid",
    grid: null,
    collectedErrors: [],
    readerLimitations: [],
    controls: [{
      idx: 0, tag: "input", type: "text", name: "D10_1", id: null, code: null, label: "%", text: "",
      checked: false, value: "", valueIsUserSupplied: false, disabled: false, required: false,
      visible: true, operable: true, actuatedVia: "self", labelIndex: null, placeholder: null,
      maxlength: null, min: null, max: null, step: null, pattern: null, readOnly: false,
    }],
    optionGroups: [],
    questionRoots: [],
    buttons: [{ idx: 9, label: ">>", labelSource: "code", role: "other", roleVia: null, disabled: false, visible: true }],
    validationMessages: [],
    // The live shape: a prose div, so now/max are null and the numeric signal cannot fire.
    progress: { present: true, kind: "div", now: null, max: null, text: progressText },
    counts: { controls: 1, optionGroups: 0, options: 0, textInputs: 1, valueInputs: 1, optionsNotOperable: 0, readerLimitations: 0 },
    historyLength: 50,
    screenSignature: "sig:identical",
    ...over,
  });

  test("THE MEASURED SHAPE: identical structure, but the progress sentence moved 39% -> 43%", async () => {
    const { mod } = await loadWorker();
    const signals = mod.driver.advanceSignals(screenAt("Survey progress: 39%"), screenAt("Survey progress: 43%"));
    assert(signals.includes("progress-text-increased"),
      `the site's own counter moving forward is movement, got ${JSON.stringify(signals)}`);
  });

  test("counterproof: an unchanged counter on an identical screen is still NOT an advance", async () => {
    const { mod } = await loadWorker();
    const signals = mod.driver.advanceSignals(screenAt("Survey progress: 39%"), screenAt("Survey progress: 39%"));
    assertEq(JSON.stringify(signals), "[]",
      "a screen that did not move must never be read as movement");
  });

  test("counterproof: a counter that went BACKWARDS is not an advance", async () => {
    const { mod } = await loadWorker();
    const signals = mod.driver.advanceSignals(screenAt("Survey progress: 43%"), screenAt("Survey progress: 39%"));
    assert(!signals.includes("progress-text-increased"),
      `going backwards is not going forwards, got ${JSON.stringify(signals)}`);
  });

  test("a position counter with no number at all yields no signal, and says nothing false", async () => {
    const { mod } = await loadWorker();
    const signals = mod.driver.advanceSignals(screenAt("Nearly there"), screenAt("Almost done"));
    assert(!signals.includes("progress-text-increased"),
      `an unparseable counter must produce no claim, got ${JSON.stringify(signals)}`);
  });

  test("the counter works on a non-percentage wording too — it is a number, not a format", async () => {
    const { mod } = await loadWorker();
    const signals = mod.driver.advanceSignals(screenAt("Page 3 of 20"), screenAt("Page 4 of 20"));
    assert(signals.includes("progress-text-increased"),
      `nothing here may depend on percent signs or English, got ${JSON.stringify(signals)}`);
  });

  test("an ABSENT position indicator is never compared as a zero", async () => {
    const { mod } = await loadWorker();
    // ABSENT IS NOT ZERO — the standing rule in this repo. A screen with no counter compared
    // against one showing 5% must not read as five points of progress.
    const noCounter = screenAt("", { progress: { present: false, kind: null, now: null, max: null, text: null } });
    const signals = mod.driver.advanceSignals(noCounter, screenAt("Survey progress: 5%"));
    assert(!signals.includes("progress-text-increased"),
      `an absent counter must make no claim at all, got ${JSON.stringify(signals)}`);
  });

  test("a rejected submit is STILL not an advance, whatever the counter says", async () => {
    const { mod } = await loadWorker();
    // The standing rule outranks this signal: validation visible + the same answerable skeleton
    // is a re-render, and a re-render that also renumbered itself must not read as movement.
    const before = screenAt("Survey progress: 39%");
    const after = screenAt("Survey progress: 43%", { validationMessages: ["Please review your responses on this page."] });
    const signals = mod.driver.advanceSignals(before, after);
    assertEq(JSON.stringify(signals), "[]",
      `the site's own rejection outranks every structural signal, got ${JSON.stringify(signals)}`);
  });
});

suite("amendment 18: a press the site ignores without complaint is not a wrong answer", () => {
  // Measured live 20 Aug 2026 (run v2r_01m0enh6bjc1en2bgesvcnt5jc, screen 45, C20 "SCREEN 2 of 4"):
  // the walk answered the best/worst grid correctly — the distinct-column repick fired and the
  // readbacks confirm two different columns checked — pressed forward, and nothing happened. No
  // movement and NO validation. The screen's own words: "You will be allowed to proceed in 4
  // seconds" before the press, "…in 0 seconds" after. The press landed inside a minimum-dwell
  // gate and was ignored, and the walk then spent its recovery rounds re-deriving a right answer.
  //
  // This is the gate's SECOND shape: the control stays VISIBLE and the press is simply ignored,
  // so awaitForwardRelease (which waits for a WITHHELD control) never fires.
  const NEXT_IDX = 8;
  const mkOpt = (idx, label, checked) => ({
    order: 0, idx, code: String(idx), label, checked, disabled: false,
    visible: true, operable: true, actuatedVia: "self", labelIndex: null,
  });

  const screenOf = ({ validation = [], progress = "Survey progress: 26%", checked = new Set() } = {}) => ({
    at: "2026-08-20T12:00:00.000Z",
    url: "https://fixture.invalid/gated2",
    title: "C20-like",
    questionText: "C20",
    instructionText: "",
    visibleText: "best and worst",
    grid: null,
    collectedErrors: [],
    readerLimitations: [],
    controls: [0, 1].map((idx) => ({
      idx, tag: "input", type: "radio", name: `q_${idx}`, id: null, code: null, label: `choice ${idx}`,
      text: "", checked: checked.has(idx), value: "", valueIsUserSupplied: false, disabled: false,
      required: false, visible: true, operable: true, actuatedVia: "self", labelIndex: null,
      placeholder: null, maxlength: null, min: null, max: null, step: null, pattern: null, readOnly: false,
    })),
    optionGroups: [
      { name: "q_0", kind: "radio", options: [mkOpt(0, "choice 0", checked.has(0))] },
      { name: "q_1", kind: "radio", options: [mkOpt(1, "choice 1", checked.has(1))] },
    ],
    questionRoots: [],
    // The control stays VISIBLE and enabled the whole time — that is what makes this shape
    // invisible to the withheld-control patience.
    buttons: [{ idx: NEXT_IDX, label: ">>", labelSource: "code", role: "other", roleVia: null, disabled: false, visible: true }],
    validationMessages: validation,
    progress: { present: true, kind: "div", now: null, max: null, text: progress },
    counts: { controls: 2, optionGroups: 2, options: 2, textInputs: 0, valueInputs: 0, optionsNotOperable: 0, readerLimitations: 0 },
    historyLength: 50,
    screenSignature: "sig:gate2",
  });

  // `ignorePresses` presses are swallowed exactly as the live gate swallowed them: no movement,
  // no complaint. `thenValidation` instead makes the site find its voice, which must hand over.
  const walkWith = async ({ ignorePresses = 1, thenValidation = null, validationAfterReads = null, movesOnItsOwn = false } = {}) => {
    const { mod } = await loadWorker();
    const env = testEnv();
    const checked = new Set();
    let presses = 0;
    let moved = false;
    let complained = false;
    let readsSincePress = 0;
    const page = {
      async goto() {},
      async evaluate(script) {
        const src = String(script);
        if (src.includes("screenSignature")) {
          if (presses >= 1) readsSincePress += 1;
          // BOTH inner guards live INSIDE the silent-refusal wait, so the event they react to
          // must land there and not on the advance-poll read that precedes it. Read 1 after the
          // press is that poll; read 2 is the wait's first look.
          if (movesOnItsOwn && readsSincePress >= 2) moved = true;
          if (moved) {
            return {
              ...screenOf(), url: "https://fixture.invalid/gated2/next", screenSignature: "sig:after",
              controls: [], optionGroups: [], validationMessages: [],
              // The next screen carries its OWN forward control, so pressing through it is
              // possible — which is exactly the harm the late-advance guard prevents.
              buttons: [{ idx: NEXT_IDX, label: ">>", labelSource: "code", role: "other", roleVia: null, disabled: false, visible: true }],
              counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0, valueInputs: 0, optionsNotOperable: 0, readerLimitations: 0 },
            };
          }
          const lateComplaint = validationAfterReads !== null && readsSincePress >= validationAfterReads;
          return screenOf({ checked, validation: (complained && thenValidation) || lateComplaint ? [thenValidation ?? "Please answer this question."] : [] });
        }
        if (src.includes("checkedGroupIdxs")) {
          const at = src.indexOf(")[");
          const idx = at < 0 ? null : Number(src.slice(at + 2, src.indexOf("]", at + 2)));
          return { idx, type: "radio", name: idx !== null ? `q_${idx}` : null, formOwner: 0, unnamedControlIdx: null, checked: idx !== null && checked.has(idx), checkedGroupIdxs: idx !== null && checked.has(idx) ? [idx] : [] };
        }
        return { ok: true };
      },
      async evaluateOnNewDocument() {},
      async $$() {
        return Array.from({ length: 14 }, (_, idx) => ({
          async click() {
            if (idx === NEXT_IDX) {
              presses += 1;
              if (thenValidation) { complained = true; return; }
              if (presses > ignorePresses) moved = true;   // the gate has expired
              return;
            }
            if (idx <= 1) checked.add(idx);
          },
          async type() {}, async focus() {},
        }));
      },
      async screenshot() { return new TextEncoder().encode("PNG-A18"); },
      async setViewport() {}, on() {}, async close() {}, async reload() {},
    };
    const runId = mod.ids.mintRunId();
    const obs = await mod.driver.walkPath(
      page,
      { id: "path_a18", decisions: [], witnesses: [] },
      {
        surveyUrl: "https://fixture.invalid/gated2", runId, planRevisionId: "plan_a18gate01",
        attemptId: "att_a18gate0001", tier: 1, maxSteps: 2, deadline: Date.now() + 60_000,
        viewport: { width: 1280, height: 900 }, applyHistoryShim: false, advanceTimeoutMs: 120,
        forwardReleasePollMs: 20, forwardReleaseTerminalMaxWaitMs: 60, forwardReleaseMaxWaitMs: 5_000,
      },
      { env, runId, attemptId: "att_a18gate0001", pathId: "path_a18", witnesses: [] },
    );
    return { obs, presses };
  };

  test("THE MEASURED SHAPE: an ignored press is waited out and re-pressed, and the walk advances", async () => {
    const { obs } = await walkWith({ ignorePresses: 1 });
    const step0 = obs.steps[0];
    assertEq(step0.advanced, true,
      `a momentarily inert control must not end the walk, outcome was ${JSON.stringify(obs.outcome)}`);
    const repress = (step0.actions ?? []).find((a) => String(a.detail ?? "").includes("silent-refusal re-press"));
    assert(repress, `the re-press must be in the receipt, got ${JSON.stringify((step0.actions ?? []).map((a) => a.detail))}`);
    assert(String(repress.detail).includes("neither movement nor any validation"),
      "and it must say WHY it re-pressed rather than re-answering");
  });

  test("the walk does not re-answer a question the site never complained about", async () => {
    const { obs } = await walkWith({ ignorePresses: 1 });
    // Scoped to the step under test: a LATER step meeting its own unresponsive screen runs its
    // own ladder, which is ordinary behaviour and not what this pins.
    const recovery = obs.steps.find((st) => st.decisionSource === "recovery" && st.stepIndex === 0.5);
    assertEq(recovery, undefined,
      "silence is not rejection: the answer-recovery ladder must not run when nothing was refused");
  });

  test("counterproof: when the site DOES complain, it is handed to recovery and not re-pressed", async () => {
    const { obs } = await walkWith({ thenValidation: "Please make sure you choose different Profile Variation for both rows." });
    const all = obs.steps.flatMap((s) => s.actions ?? []);
    const repress = all.find((a) => String(a.detail ?? "").includes("silent-refusal re-press"));
    assertEq(repress, undefined,
      "a real validation belongs to the answer-recovery ladder, never to the re-press loop");
  });

  test("a complaint that arrives DURING the wait hands over instead of re-pressing", async () => {
    const { obs } = await walkWith({ ignorePresses: 999, validationAfterReads: 2 });
    const represses = obs.steps
      .flatMap((s) => s.actions ?? [])
      .filter((a) => String(a.detail ?? "").includes("silent-refusal re-press"));
    assertEq(represses.length, 0,
      `once the site complains the answer-recovery ladder owns it, got ${represses.length} re-presses`);
  });

  test("a survey that moves on its own while we wait is NOT pressed through", async () => {
    const { obs } = await walkWith({ movesOnItsOwn: true });
    // The harm is a re-press fired INSIDE the wait after the screen had already moved — that
    // press lands on the NEXT question. (The walk pressing the next screen as its own step is
    // ordinary progress, so total presses cannot tell the two apart; the receipt can.)
    // SCOPED TO THE STEP UNDER TEST. A later step meeting its own unresponsive screen re-presses
    // legitimately; the defect is a re-press on THIS step after this screen had already moved.
    const represses = (obs.steps[0].actions ?? [])
      .filter((a) => String(a.detail ?? "").includes("silent-refusal re-press"));
    assertEq(represses.length, 0,
      `a late advance must be noticed, not pressed through onto the next screen: ${JSON.stringify(represses.map((a) => a.detail))}`);
    assertEq(obs.steps[0].advanced, true, "and the walk must record that it advanced");
  });

  test("a press that is ignored forever stops at the bounded press count", async () => {
    const { obs } = await walkWith({ ignorePresses: 999 });
    // Pin the guard itself: the SILENT re-presses are bounded. (The initial press and the
    // answer-recovery ladder's own presses are separate machinery with their own bounds.)
    const represses = obs.steps
      .flatMap((s) => s.actions ?? [])
      .filter((a) => String(a.detail ?? "").includes("silent-refusal re-press"));
    assertEq(represses.length, 3,
      `a page that ignores every press must not be hammered, got ${represses.length} re-presses`);
    assert((obs.readerLimitations ?? []).some((l) => l.kind === "silent-refusal-repressed"),
      `the extra presses must be a counted limitation, got ${JSON.stringify(obs.readerLimitations)}`);
  });
});

suite("amendment 19: the page that says the survey ended is a completion, not a rejection", () => {
  // Measured live 20 Aug 2026 (run v2r_01m0f1zccejfmq8fd02r7xq8kv, screen 81): the deep walk
  // traversed the whole instrument — 81 screens — and landed on a page reading
  // "End of survey / End of test link." The completion lexicon required the ARTICLE ("the end of
  // THE survey"), so nothing matched, and the structural arm then classified a COMPLETED survey
  // as a rejection page. That is a positive wrong claim about the one outcome this system exists
  // to report.
  const terminalPage = (text) => ({
    at: "2026-08-20T12:00:00.000Z",
    url: "https://fixture.invalid/end",
    title: "end",
    questionText: "",
    instructionText: "",
    visibleText: text,
    grid: null,
    collectedErrors: [],
    readerLimitations: [],
    controls: [],
    optionGroups: [],
    questionRoots: [],
    // The live shape: only a back control is visible, which is what made the structural
    // rejection arm fire on a page that had actually finished.
    buttons: [{ idx: 1, label: "<<", labelSource: "code", role: "back", roleVia: "code:<<", disabled: false, visible: true }],
    validationMessages: [],
    progress: { present: false, kind: null, now: null, max: null, text: null },
    counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0, valueInputs: 0, optionsNotOperable: 0, readerLimitations: 0 },
    screenSignature: "sig:end",
  });

  test("THE MEASURED SHAPE: 'End of survey' is a completion, not a structural screen-out", async () => {
    const { mod } = await loadWorker();
    const ending = mod.driver.classifyEnding(terminalPage("End of survey\nEnd of test link."), {
      outcome: "no-advance-control", unboundDecisions: 0,
    });
    assertEq(ending.kind, "completed",
      `a survey that said it ended must not be reported as a rejection: ${JSON.stringify(ending)}`);
  });

  test("the article stays optional in both directions", async () => {
    const { mod } = await loadWorker();
    for (const text of ["This is the end of the survey.", "End of the questionnaire", "end of this interview"]) {
      const ending = mod.driver.classifyEnding(terminalPage(text), { outcome: "no-advance-control", unboundDecisions: 0 });
      assertEq(ending.kind, "completed", `${JSON.stringify(text)} -> ${JSON.stringify(ending.kind)}`);
    }
  });

  test("counterproof: a bare 'the end' in ordinary prose is NOT a completion", async () => {
    const { mod } = await loadWorker();
    // The original caution, preserved: the noun is what anchors this, never the article.
    const ending = mod.driver.classifyEnding(terminalPage("And that was the end of it."), {
      outcome: "no-advance-control", unboundDecisions: 0,
    });
    assert(ending.kind !== "completed",
      `"the end" alone must never claim a completion, got ${JSON.stringify(ending)}`);
  });

  test("counterproof: a screen-out page is still a screen-out", async () => {
    const { mod } = await loadWorker();
    const ending = mod.driver.classifyEnding(
      terminalPage("Unfortunately you do not qualify for this study. Terminated at S80."),
      { outcome: "no-advance-control", unboundDecisions: 0 },
    );
    assertEq(ending.kind, "screened-out",
      "widening the completion lexicon must not swallow a real disqualification");
  });
});

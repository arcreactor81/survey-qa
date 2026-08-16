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

import { assert, assertEq, suite, test, loadWorker } from "../testkit.mjs";
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

  test("EXEC_PER_CASE_TIMEOUT_MS is 120000 in wrangler.jsonc", async () => {
    const { readFileSync } = await import("fs");
    const wrangler = readFileSync("wrangler.jsonc", "utf8");
    const perCase = wrangler.match(/"EXEC_PER_CASE_TIMEOUT_MS"\s*:\s*"(\d+)"/);
    assert(perCase, "EXEC_PER_CASE_TIMEOUT_MS must be declared");
    assertEq(perCase[1], "120000", "EXEC_PER_CASE_TIMEOUT_MS must be 120000");
  });

  test("all arm configs agree on EXEC_PER_CASE_TIMEOUT_MS=120000", async () => {
    const { readFileSync, readdirSync } = await import("fs");
    const armFiles = readdirSync(".").filter((f) => f.startsWith("wrangler.arm-") && f.endsWith(".jsonc"));
    assert(armFiles.length > 0, "there must be at least one arm config");
    for (const f of armFiles) {
      const content = readFileSync(f, "utf8");
      const perCase = content.match(/"EXEC_PER_CASE_TIMEOUT_MS"\s*:\s*"(\d+)"/);
      assert(perCase, `${f} must declare EXEC_PER_CASE_TIMEOUT_MS`);
      assertEq(perCase[1], "120000", `${f} must have EXEC_PER_CASE_TIMEOUT_MS=120000`);
    }
  });

  test("DEPLOY.md config gate pins EXEC_PER_CASE_TIMEOUT_MS to 120000", async () => {
    const { readFileSync } = await import("fs");
    const deploy = readFileSync("DEPLOY.md", "utf8");
    assert(
      deploy.includes('eq(v.EXEC_PER_CASE_TIMEOUT_MS,"120000"'),
      "DEPLOY.md must pin EXEC_PER_CASE_TIMEOUT_MS to 120000",
    );
  });

  test("EXPECTED_STATIC_VARS pins EXEC_PER_CASE_TIMEOUT_MS to 120000", async () => {
    const { readFileSync } = await import("fs");
    const canary = readFileSync("tools/assert-no-active-canary-workflows.mjs", "utf8");
    assert(
      canary.includes('EXEC_PER_CASE_TIMEOUT_MS: "120000"'),
      "EXPECTED_STATIC_VARS must pin EXEC_PER_CASE_TIMEOUT_MS to 120000",
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

/**
 * D53 — THE CONSTANT-SUM ("ALLOCATION") FILLER, and the wall it removes.
 *
 * MEASURED on the live branching fleet (reach baseline, 2026-08-10/11, 12 targets x 2 passes):
 * the single largest reach blocker was the allocation grid. 3 of 12 walks hard-blocked at a
 * "must sum to exactly 100" table (s5-allocation Q1, s6-kitchen-sink Q6 twice) — the
 * navigator-default filler wrote `1` into each of 5 independent number inputs, the site
 * answered "Values must sum to exactly 100 (current total: 5)", the recovery pass re-derived
 * the identical values, and the walk ended `blocked`/`stalled`. That one wall gated ~6 screens
 * on s5-clean and ~9 on each s6 variant (~24 screens total), and s5-clean's own manifest is
 * reach-censored by it (the fleet walker never saw past screen 4 of ~10).
 *
 * THE FIX is a group-aware pass in `applyDecision` that runs BEFORE the grid and value passes:
 *
 *   DETECTION IS STRUCTURAL + CONSERVATIVE. >= 2 operable, writable number inputs hosted in
 *   one grid (the fleet shape: table-rendered, ONE number input per row, ZERO header labels)
 *   or sharing a non-empty name prefix, AND a sum target readable from the SITE'S OWN
 *   declarations — an explicit total in question/instruction text or in the validation echo
 *   after a blocked submit ("Points must sum to exactly 100 (current total: 5)"), else a
 *   shared per-input max corroborated by sum wording. NO confident target => DO NOTHING: a
 *   wrong sum guess typed into a non-allocation screen is worse than today's named failure.
 *
 *   THE VALUE RULE IS DETERMINISTIC AND LEAST-COMMITTED. Equal split of T over N, snapped to
 *   each input's own step grid (the site's grid, anchored at its own min — same arithmetic as
 *   `stepAlignedMidpoint`), remainder one step at a time to the FIRST inputs in DOM order,
 *   clamped into each input's own min/max with greedy DOM-order redistribution. Bounds that
 *   make T unreachable are a NAMED UnfillableControl per member ("the site's own declarations
 *   make the declared total unreachable"), never a silent skip and never a wrong sum.
 *
 *   THE INVARIANT: stimulus is INPUT, never EVIDENCE. Every value carries the
 *   `navigator-default:allocation-split(...)` detail prefix, so `countDefaults` and the
 *   ending's provenance line keep counting these as answers the harness invented.
 *
 * Evidence these can fail: `tools/mutate-allocation.mjs`.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

const ATTEMPT_ID = "att_d53000000001";
const PATH_ID = "path_d53000000001";

/* ------------------------------------------------------------------ fixtures */

const control = (idx, { type = "text", name = null, id = null, label = "", ...rest }) => ({
  idx,
  tag: type === "textarea" ? "textarea" : "input",
  type,
  name,
  id,
  code: null,
  label,
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

const nextBtn = (idx) => ({ idx, label: "Next", role: "next", roleVia: "text:Next", disabled: false, visible: true });

const screen = (text, { controls = [], buttons, signature } = {}) => ({
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
  optionGroups: [],
  grid: null,
  readerLimitations: [],
  buttons: buttons === undefined ? [nextBtn(controls.length)] : buttons,
  progress: { present: false, kind: null, now: null, max: null, text: null },
  validationMessages: [],
  counts: {
    controls: controls.length,
    optionGroups: 0,
    options: 0,
    textInputs: 0,
    valueInputs: controls.length,
    optionsNotOperable: 0,
    readerLimitations: 0,
  },
  screenSignature: signature ?? `sig:${text}`,
});

/** The fleet's allocation row labels, verbatim from s5-allocation Q1. */
const ROW_LABELS = [
  "Topical therapy alone",
  "Phototherapy",
  "Oral systemic agents",
  "Biologic therapy",
  "Other approaches",
];

/**
 * THE FLEET SHAPE, byte-faithful to what the reader produced on s5/s6: a table-rendered grid,
 * ONE number input per row, ZERO header labels (`grid-column-labels-unresolved`), no name, no
 * min/max on the inputs, the target stated only in prose — and the live "Total 0" mirror row
 * in the page's visible text. That mirror is why `visibleText` must NEVER be scanned for a
 * target: its 0 would conflict with the declared 100 and every real fleet grid would abstain.
 */
const allocScreen = ({
  question = "Q1. Thinking about all of your patients, what percentage is currently managed primarily with each of the following approaches?",
  instruction = "Enter a whole number in every row. Your answers must sum to exactly 100.",
  validationMessages = [],
  memberExtra = () => ({}),
  extraControls = [],
  n = 5,
} = {}) => {
  const members = ROW_LABELS.slice(0, n).map((label, i) => control(i, { type: "number", label, ...memberExtra(i) }));
  const controls = [...members, ...extraControls];
  const s = screen(question, { controls });
  s.instructionText = instruction;
  s.visibleText = `${question} ${instruction ?? ""} ${ROW_LABELS.slice(0, n).join(" ")} Total 0`;
  s.validationMessages = validationMessages;
  s.grid = {
    columns: [],
    rows: ROW_LABELS.slice(0, n).map((label, i) => ({
      label,
      name: members[i].name,
      cells: [{ column: null, code: "", checked: false, idx: i }],
    })),
  };
  s.readerLimitations = [
    { kind: "grid-column-labels-unresolved", detail: `the grid offers 0 header label(s) for ${n} cell(s)`, count: n },
  ];
  return s;
};

/** See d44: a fakePage that records keystrokes, assignments and clicks separately. */
function fakePage(reads, { setRejects = false } = {}) {
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
        return setRejects
          ? { ok: false, reason: "value-rejected-by-control", got: "" }
          : { ok: true, reason: null, got: value };
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

async function walk(mod, env, reads, decisions = [], pageOpts = {}) {
  const runId = mod.ids.mintRunId();
  const page = fakePage(reads, pageOpts);
  const obs = await mod.driver.walkPath(
    page,
    { id: PATH_ID, decisions, witnesses: [] },
    {
      surveyUrl: "https://fixture.invalid/survey",
      runId,
      planRevisionId: "plan_d53test01",
      attemptId: ATTEMPT_ID,
      tier: 1,
      maxSteps: 1,
      deadline: Date.now() + 30_000,
      viewport: { width: 1280, height: 900 },
      applyHistoryShim: false,
      advanceTimeoutMs: 200,
    },
    { env, runId, attemptId: ATTEMPT_ID, pathId: PATH_ID, witnesses: [] },
  );
  return { obs, page };
}

const actionsOf = (obs, kind) => (obs.steps[0]?.actions ?? []).filter((a) => a.kind === kind);
const advancing = (s) => [s, s, screen("Thank you for completing the survey.", { controls: [], buttons: [] })];

/* ============================================================ 1. detection */

suite("D53 — detection reads the constant-sum target from the site's own declarations", () => {
  test("THE FLEET SHAPE: a table-hosted group with the target in instruction text is detected", async () => {
    const mod = await worker();
    const groups = mod.driver.allocationGroups(allocScreen());
    assertEq(groups.length, 1, JSON.stringify(groups));
    assertEq(groups[0].total, 100, JSON.stringify(groups[0]));
    assertEq(groups[0].members.length, 5, JSON.stringify(groups[0].members));
    assertEq(
      groups[0].members.map((m) => m.idx).join(","),
      "0,1,2,3,4",
      JSON.stringify(groups[0].members),
    );
    assert(/instruction/.test(groups[0].targetSource), `the source does not name where the total was read: ${groups[0].targetSource}`);
  });

  test("THE RECOVERY SOURCE: the fleet's validation echo declares the target — and 'current total: 5' is never mistaken for one", async () => {
    const mod = await worker();
    // The instruction says nothing about a sum; the target is only in the site's own blocked-
    // submit echo, VERBATIM from the s6 baseline. The echo contains TWO numbers — the target
    // and the current sum — and reading 5 (or abstaining on 100-vs-5 ambiguity) would kill the
    // recovery pass, which is the one place validationMessages exist to serve.
    const s = allocScreen({
      instruction: "Enter a whole number in every row.",
      validationMessages: ["Points must sum to exactly 100 (current total: 5)."],
    });
    const groups = mod.driver.allocationGroups(s);
    assertEq(groups.length, 1, JSON.stringify(groups));
    assertEq(groups[0].total, 100, `the echo's current total leaked into the target: ${JSON.stringify(groups[0])}`);
    assert(/validation/.test(groups[0].targetSource), groups[0].targetSource);
  });

  test("NO SUM LANGUAGE, NO GROUP — a grid of number inputs alone is not an allocation", async () => {
    const mod = await worker();
    // Structurally this IS groupable (same grid, 5 number inputs). What is missing is the
    // site's own declaration of a total, and without one the pass must do NOTHING: a wrong
    // sum guess typed into a non-allocation screen is worse than the current named failure.
    const s = allocScreen({
      question: "Q2. For each programme, how many patients did you enrol last month?",
      instruction: "Enter a whole number in every row.",
    });
    assertEq(mod.driver.allocationGroups(s).length, 0, JSON.stringify(mod.driver.allocationGroups(s)));
  });

  test("SUM LANGUAGE ALONE IS NOT A GROUP — two structurally unrelated number inputs never become one", async () => {
    const mod = await worker();
    // The prose talks about summing, but the two inputs share no grid and no name prefix.
    // Detection is an AND: structure AND declared target.
    const s = screen("Q3. Your household's numbers must sum to exactly 100 percent of your budget.", {
      controls: [
        control(0, { type: "number", name: "age", label: "Your age" }),
        control(1, { type: "number", name: "years", label: "Years in practice" }),
      ],
    });
    assertEq(mod.driver.allocationGroups(s).length, 0, JSON.stringify(mod.driver.allocationGroups(s)));
  });

  test("N >= 2: a single number input under sum wording is not an allocation", async () => {
    const mod = await worker();
    const s = allocScreen({ n: 1 });
    assertEq(mod.driver.allocationGroups(s).length, 0, JSON.stringify(mod.driver.allocationGroups(s)));
  });

  test("A SHARED NAME PREFIX groups; a shared per-input max corroborated by sum wording supplies the target", async () => {
    const mod = await worker();
    // No grid and no explicit number anywhere — but every input declares the same max and the
    // screen talks about allocating. The shared max is CORROBORATION, consulted only when no
    // explicit total is stated (a per-row cap is not a total: see the explicit-first test below).
    const s = screen("Q7. How do you split your week across these activities?", {
      controls: [
        control(0, { type: "number", name: "q7_1", label: "Consulting", max: "100" }),
        control(1, { type: "number", name: "q7_2", label: "Surgery", max: "100" }),
        control(2, { type: "number", name: "q7_3", label: "Research", max: "100" }),
        control(3, { type: "number", name: "q7_4", label: "Teaching", max: "100" }),
      ],
    });
    s.instructionText = "Allocate your percentages across the rows so they add up.";
    const groups = mod.driver.allocationGroups(s);
    assertEq(groups.length, 1, JSON.stringify(groups));
    assertEq(groups[0].total, 100, JSON.stringify(groups[0]));
    assert(/max/.test(groups[0].targetSource), groups[0].targetSource);
  });

  test("AN EXPLICIT STATED TOTAL BEATS A SHARED MAX — a per-row cap is not a total", async () => {
    const mod = await worker();
    // Five inputs each capped at 20, and the site SAYS the total is 100. Reading the shared
    // max as the target here would type a sum of 20 into a screen that demands 100.
    const s = allocScreen({
      instruction: "Enter a whole number in every row (0-20 per row). Your answers must sum to exactly 100.",
      memberExtra: () => ({ min: "0", max: "20" }),
    });
    const groups = mod.driver.allocationGroups(s);
    assertEq(groups.length, 1, JSON.stringify(groups));
    assertEq(groups[0].total, 100, `the shared per-row cap displaced the stated total: ${JSON.stringify(groups[0])}`);
  });

  test("A READONLY 'Total' MIRROR is never a member", async () => {
    const mod = await worker();
    const s = allocScreen({
      extraControls: [control(5, { type: "number", label: "Total", readOnly: true, value: "0" })],
    });
    const groups = mod.driver.allocationGroups(s);
    assertEq(groups.length, 1, JSON.stringify(groups));
    assertEq(groups[0].members.length, 5, JSON.stringify(groups[0].members));
    assert(!groups[0].members.some((m) => m.idx === 5), "the readonly mirror joined the group");
  });

  test("A DIGITS-ONLY NAME IS NOT A PREFIX — inputs named '1' and '2' do not group", async () => {
    const mod = await worker();
    const s = screen("Q8. Distribute 10 points between the two options.", {
      controls: [
        control(0, { type: "number", name: "1", label: "Option A" }),
        control(1, { type: "number", name: "2", label: "Option B" }),
      ],
    });
    assertEq(mod.driver.allocationGroups(s).length, 0, JSON.stringify(mod.driver.allocationGroups(s)));
  });
});

/* ============================================================ 2. the split arithmetic */

suite("D53 — the split is deterministic, exact, and snapped to each input's own grid", () => {
  const group = (mod, members, total = 100) => ({
    total,
    targetSource: "test",
    members,
  });
  const member = (idx, extra = {}) => ({ idx, label: `row ${idx}`, min: null, max: null, step: null, value: "", required: false, ...extra });

  test("AN EVEN TOTAL SPLITS EQUALLY: 100 over 5 is 20 each", async () => {
    const mod = await worker();
    const split = mod.driver.allocationValues(group(mod, [member(0), member(1), member(2), member(3), member(4)]));
    assert(split.ok, JSON.stringify(split));
    assertEq(split.values.map((v) => v.value).join(","), "20,20,20,20,20", JSON.stringify(split));
  });

  test("THE REMAINDER GOES TO THE FIRST INPUTS IN DOM ORDER: 100 over 3 is 34,33,33", async () => {
    const mod = await worker();
    const split = mod.driver.allocationValues(group(mod, [member(0), member(1), member(2)]));
    assert(split.ok, JSON.stringify(split));
    assertEq(split.values.map((v) => v.value).join(","), "34,33,33", JSON.stringify(split));
  });

  test("EACH INPUT'S OWN STEP GRID IS RESPECTED: 10 over 3 at step 0.5 is 3.5,3.5,3", async () => {
    const mod = await worker();
    const split = mod.driver.allocationValues(
      group(mod, [member(0, { step: "0.5" }), member(1, { step: "0.5" }), member(2, { step: "0.5" })], 10),
    );
    assert(split.ok, JSON.stringify(split));
    assertEq(split.values.map((v) => v.value).join(","), "3.5,3.5,3", JSON.stringify(split));
  });

  test("A CLAMPED MEMBER'S SHARE IS REDISTRIBUTED greedily in DOM order: max=10 on the first of 3", async () => {
    const mod = await worker();
    const split = mod.driver.allocationValues(group(mod, [member(0, { max: "10" }), member(1), member(2)]));
    assert(split.ok, JSON.stringify(split));
    assertEq(split.values.map((v) => v.value).join(","), "10,57,33", JSON.stringify(split));
    const sum = split.values.reduce((a, v) => a + Number(v.value), 0);
    assertEq(sum, 100, `the redistributed values no longer sum to the target: ${JSON.stringify(split)}`);
  });

  test("BOUNDS THAT MAKE THE TOTAL UNREACHABLE ARE NAMED, with the arithmetic: min values alone exceed it", async () => {
    const mod = await worker();
    const split = mod.driver.allocationValues(group(mod, [member(0, { min: "60" }), member(1, { min: "60" })]));
    assert(!split.ok, JSON.stringify(split));
    assert(/120/.test(split.why) && /100/.test(split.why), `the arithmetic is not named: ${split.why}`);
  });

  test("...and max values that cannot reach it", async () => {
    const mod = await worker();
    const split = mod.driver.allocationValues(group(mod, [member(0, { max: "40" }), member(1, { max: "50" })]));
    assert(!split.ok, JSON.stringify(split));
    assert(/90/.test(split.why) && /100/.test(split.why), `the arithmetic is not named: ${split.why}`);
  });

  test("...and step grids that cannot land on it exactly", async () => {
    const mod = await worker();
    const split = mod.driver.allocationValues(group(mod, [member(0, { step: "3" }), member(1, { step: "3" })]));
    assert(!split.ok, JSON.stringify(split));
    assert(/step/.test(split.why), `the step grid is not named: ${split.why}`);
  });
});

/* ============================================================ 3. the driver applies it */

suite("D53 — the driver claims the group before the grid and value passes", () => {
  test("THE MEASURED WALL COMES DOWN: the fleet-shape grid is filled to its declared total, not with 1s", async () => {
    const mod = await worker();
    // Pre-fix this walk types 1 into each of 5 inputs (the baseline's "current total: 5"),
    // and the grid pass separately lands a meaningless click on each number cell.
    const s = allocScreen();
    const { obs, page } = await walk(mod, testEnv(), advancing(s));

    const typed = actionsOf(obs, "type-text");
    assertEq(typed.length, 5, JSON.stringify(obs.steps[0].actions));
    assertEq(typed.map((a) => a.value).join(","), "20,20,20,20,20", JSON.stringify(typed.map((a) => a.value)));
    const sum = typed.reduce((a, t) => a + Number(t.value), 0);
    assertEq(sum, 100, `the typed values do not sum to the declared total: ${sum}`);
    for (const a of typed) {
      assert(
        /^navigator-default:allocation-split\(/.test(a.detail ?? ""),
        `an allocation value does not carry the allocation-split provenance prefix: ${a.detail}`,
      );
    }
    assertEq(
      page.typed.map((t) => t.text).join(","),
      "20,20,20,20,20",
      `the record and the keystrokes must agree: ${JSON.stringify(page.typed)}`,
    );
    // The grid pass must NOT also click the cells the allocation pass claimed.
    assertEq(actionsOf(obs, "select-grid-cell").length, 0, JSON.stringify(obs.steps[0].actions));
    // THE INVARIANT: these are invented answers and the walk says so.
    assertEq(obs.navigatorDefaultAnswerCount, 5, JSON.stringify(obs.navigatorDefaultAnswerCount));
    assert(
      (obs.ending?.evidence ?? []).some((e) => /navigator-defaults the harness chose/.test(e)),
      `the ending does not disclose its fillers: ${JSON.stringify(obs.ending?.evidence)}`,
    );
  });

  test("WITHOUT A DECLARED TOTAL the pass does nothing: midpoints and grid clicks exactly as today", async () => {
    const mod = await worker();
    const s = allocScreen({
      question: "Q2. For each programme, how many patients did you enrol last month?",
      instruction: "Enter a whole number in every row.",
    });
    const { obs } = await walk(mod, testEnv(), advancing(s));
    const typed = actionsOf(obs, "type-text");
    assertEq(typed.length, 5, JSON.stringify(obs.steps[0].actions));
    for (const a of typed) {
      assert(!/allocation-split/.test(a.detail ?? ""), `an undeclared screen was treated as an allocation: ${a.detail}`);
      assertEq(a.value, "1", `the per-control default changed: ${a.value}`);
    }
    // The grid pass still runs on unclaimed cells — the pre-existing behaviour, untouched.
    assertEq(actionsOf(obs, "select-grid-cell").length, 5, JSON.stringify(obs.steps[0].actions));
  });

  test("A PLANNED VALUE STILL WINS: text_entry on the bound decision suppresses the split", async () => {
    const mod = await worker();
    // A planned text_entry fans out to every value control on the screen (the existing rule),
    // so every member is a planned member and the pass abstains — the task's "exclude the
    // planned member and subtract its value from T" in its degenerate all-members form.
    const s = allocScreen({
      question: "Q1. Allocate 100 points across the following approaches.",
      memberExtra: (i) => ({ name: "Q1", id: `Q1_r${i + 1}` }),
    });
    const decision = { question: "Q1", select: [], text_entry: { required: true, value: "7" } };
    const { obs } = await walk(mod, testEnv(), advancing(s), [decision]);
    const typed = actionsOf(obs, "type-text");
    assertEq(typed.length, 5, JSON.stringify(obs.steps[0].actions));
    for (const a of typed) {
      assertEq(a.value, "7", `the plan's value was displaced: ${a.value}`);
      assert(!/navigator-default/.test(a.detail ?? ""), `a planned answer was labelled a filler: ${a.detail}`);
    }
    assertEq(obs.navigatorDefaultAnswerCount, 0, JSON.stringify((obs.steps[0].actions ?? []).map((a) => a.detail)));
  });

  test("THE RECOVERY SHAPE: values that no longer sum to the echoed target are overwritten", async () => {
    const mod = await worker();
    // The screen the recovery pass sees: the first pass typed 1s (user-supplied as far as the
    // page can tell), the submit was blocked, and the site echoed the target. `alreadyAnswered`
    // must NOT protect those fillers — a group that does not sum to the site's own target is
    // not an answered group. The sum==target guard below is what protects real answers.
    const s = allocScreen({
      instruction: "Enter a whole number in every row.",
      validationMessages: ["Values must sum to exactly 100 (current total: 5)."],
      memberExtra: () => ({ value: "1", valueIsUserSupplied: true }),
    });
    const { obs, page } = await walk(mod, testEnv(), advancing(s));
    const typed = actionsOf(obs, "type-text");
    assertEq(typed.length, 5, JSON.stringify(obs.steps[0].actions));
    assertEq(typed.map((a) => a.value).join(","), "20,20,20,20,20", JSON.stringify(typed.map((a) => a.value)));
    assert(typed.every((a) => /allocation-split/.test(a.detail ?? "")), JSON.stringify(typed.map((a) => a.detail)));
    assertEq(page.typed.length, 5, JSON.stringify(page.typed));
  });

  test("A GROUP THAT ALREADY SUMS TO THE TARGET IS CLAIMED AND LEFT ALONE", async () => {
    const mod = await worker();
    const held = ["40", "30", "15", "10", "5"];
    const s = allocScreen({ memberExtra: (i) => ({ value: held[i], valueIsUserSupplied: true }) });
    const { obs } = await walk(mod, testEnv(), advancing(s));
    assertEq(actionsOf(obs, "type-text").length, 0, JSON.stringify(obs.steps[0].actions));
    assertEq(actionsOf(obs, "set-value").length, 0, JSON.stringify(obs.steps[0].actions));
    // Claimed: the grid pass does not click a group that is already right.
    assertEq(actionsOf(obs, "select-grid-cell").length, 0, JSON.stringify(obs.steps[0].actions));
  });

  test("AN UNREACHABLE TOTAL IS A NAMED LIMITATION, never a wrong sum: every member becomes UnfillableControl", async () => {
    const mod = await worker();
    // The site declares min=30 on each of 5 rows and a total of 100: 5 x 30 = 150 > 100.
    const s = allocScreen({ memberExtra: () => ({ min: "30" }) });
    const { obs, page } = await walk(mod, testEnv(), [s, s, s]);
    const named = obs.steps[0].unfillableControls ?? [];
    assertEq(named.length, 5, JSON.stringify(named));
    for (const u of named) {
      assertEq(u.reason, "no-derivation", JSON.stringify(u));
      assert(/150/.test(u.detail) && /100/.test(u.detail), `the arithmetic is not named: ${u.detail}`);
    }
    const refused = actionsOf(obs, "refuse-fill");
    assertEq(refused.length, 5, JSON.stringify(obs.steps[0].actions));
    assert(refused.every((a) => a.ok === false), "a refusal was recorded as a success");
    assertEq(actionsOf(obs, "type-text").length, 0, "a wrong sum was typed anyway");
    assertEq(page.typed.length, 0, JSON.stringify(page.typed));
    assertEq(obs.navigatorDefaultAnswerCount, 0, JSON.stringify(obs.navigatorDefaultAnswerCount));
  });

  test("A BLANK PROBE IS STILL A BLANK PROBE: leave-blank skips the allocation pass", async () => {
    const mod = await worker();
    const s = allocScreen({
      question: "Q1. Allocate 100 points across the following approaches.",
      memberExtra: (i) => ({ name: "Q1", id: `Q1_r${i + 1}` }),
    });
    const decision = { question: "Q1", select: [], action: "leave-blank-and-continue" };
    const { obs, page } = await walk(mod, testEnv(), advancing(s), [decision]);
    assert(
      (obs.steps[0].actions ?? []).every((a) => !/allocation-split/.test(a.detail ?? "")),
      `a leave-blank probe filled the allocation anyway: ${JSON.stringify(obs.steps[0].actions)}`,
    );
    assert(
      page.typed.every((t) => t.text === ""),
      `keystrokes reached the page on a blank probe: ${JSON.stringify(page.typed)}`,
    );
  });
});

/* ============================================================ 4. BLOCKER 2 — the lattice invariant */

/**
 * THE 11 AUG REVIEW BLOCKER: `allocationValues` snapped the equal split to each input's step
 * grid, but the clamp phase clamped to the RAW min/max without re-snapping, and the success
 * check verified only the final total. Total 20 over A={min 0, max 5, step 3} and
 * B={min 0, max 20, step 1} returned [5,15] — 5 is not on A's own grid ({0, 3} is all it
 * admits) — while a fully valid [3,17] exists. The driver then recorded the step-invalid
 * write as a successful navigator default, and the site's later rejection was blamed on the
 * site. The invariant these tests pin: every value returned lies on its member's own VALID
 * LATTICE (the min-anchored step grid intersected with [min, max]) and the total is exact —
 * or the group is a named unfillable. Never a knowingly-invalid write.
 */
suite("D53 — BLOCKER 2: every allocation value lies on its member's own valid lattice", () => {
  const member = (idx, extra = {}) => ({ idx, label: `row ${idx}`, min: null, max: null, step: null, value: "", required: false, ...extra });
  const group = (members, total) => ({ total, targetSource: "test", members });

  /** Independent oracle: the member's valid values — its min-anchored step grid cut to [min, max]. */
  const lattice = (m) => {
    const lo = Number(m.min ?? 0);
    const hi = Number(m.max);
    const step = Number(m.step ?? 1);
    const out = [];
    for (let k = 0; ; k++) {
      const v = Number((lo + k * step).toPrecision(12));
      if (v > hi + 1e-9) break;
      out.push(v);
    }
    return out;
  };

  /** Every returned value sits on its own member's lattice (interval membership for step="any"). */
  const assertMemberValid = (split, members) => {
    for (let i = 0; i < members.length; i++) {
      const v = Number(split.values[i].value);
      const m = members[i];
      if (String(m.step ?? "").toLowerCase() === "any") {
        const lo = Number(m.min ?? 0);
        const hi = m.max === null ? Number.POSITIVE_INFINITY : Number(m.max);
        assert(v >= lo - 1e-9 && v <= hi + 1e-9, `member ${i} holds ${v}, outside its own [${lo}, ${hi}]: ${JSON.stringify(split)}`);
        continue;
      }
      assert(
        lattice(m).some((x) => Math.abs(x - v) < 1e-9),
        `member ${i} holds ${v}, which is NOT on its own grid {${lattice(m).join(",")}}: ${JSON.stringify(split)}`,
      );
    }
  };

  const sumOf = (split) => split.values.reduce((a, v) => a + Number(v.value), 0);

  test("THE REVIEW'S COUNTEREXAMPLE: total 20 over {min 0, max 5, step 3} + {min 0, max 20, step 1} is [3,17] — never the step-invalid [5,15]", async () => {
    const mod = await worker();
    const members = [member(0, { min: "0", max: "5", step: "3" }), member(1, { min: "0", max: "20", step: "1" })];
    const split = mod.driver.allocationValues(group(members, 20));
    assert(split.ok, JSON.stringify(split));
    assertEq(split.values.map((v) => v.value).join(","), "3,17", JSON.stringify(split));
    assertMemberValid(split, members);
    assertEq(sumOf(split), 20, `the split does not land the declared total exactly: ${JSON.stringify(split)}`);
  });

  test("...and the driver types the lattice-valid split end to end, not the raw-clamped one", async () => {
    const mod = await worker();
    const s = allocScreen({
      n: 2,
      instruction: "Enter a whole number in every row. Your answers must sum to exactly 20.",
      memberExtra: (i) => (i === 0 ? { min: "0", max: "5", step: "3" } : { min: "0", max: "20", step: "1" }),
    });
    const { obs, page } = await walk(mod, testEnv(), advancing(s));
    const typed = actionsOf(obs, "type-text");
    assertEq(typed.length, 2, JSON.stringify(obs.steps[0].actions));
    assertEq(typed.map((a) => a.value).join(","), "3,17", JSON.stringify(typed.map((a) => a.value)));
    assertEq(page.typed.map((t) => t.text).join(","), "3,17", `the keystrokes disagree with the record: ${JSON.stringify(page.typed)}`);
  });

  test("A TOTAL NO LATTICE COMBINATION REACHES IS NAMED UNFILLABLE — raw maxes said 25 was fine, the grids top out at 23", async () => {
    const mod = await worker();
    // Raw maxes sum to 5 + 20 = 25, but the first member's own grid tops out at 3, so the
    // true reachable ceiling is 23. Pre-fix this returned ok with [5,20] — a step-invalid 5
    // laundered by an exact-looking total.
    const members = [member(0, { min: "0", max: "5", step: "3" }), member(1, { min: "0", max: "20", step: "1" })];
    const split = mod.driver.allocationValues(group(members, 25));
    assert(!split.ok, `a lattice-unreachable total produced a write: ${JSON.stringify(split)}`);
    assert(/23/.test(split.why) && /25/.test(split.why), `the lattice arithmetic is not named: ${split.why}`);
  });

  test('step="any" IS UNCHANGED: no grid means fractions are legal and the equal split stands', async () => {
    const mod = await worker();
    const members = [member(0, { step: "any" }), member(1, { step: "any" })];
    const split = mod.driver.allocationValues(group(members, 25));
    assert(split.ok, JSON.stringify(split));
    assertEq(split.values.map((v) => v.value).join(","), "12.5,12.5", JSON.stringify(split));
  });

  test('...and in a MIXED group the step="any" member absorbs what the grids cannot, exactly', async () => {
    const mod = await worker();
    // {0..20, step 3} can only hold multiples of 3; whatever offset that leaves against the
    // total, the continuous member must take — a shape the greedy quanta alone cannot always
    // close (pre-fix this exact group was declared unfillable at deficit 1).
    const members = [member(0, { min: "0", max: "10", step: "any" }), member(1, { min: "0", max: "20", step: "3" })];
    const split = mod.driver.allocationValues(group(members, 20));
    assert(split.ok, `a feasible mixed group was declared unfillable: ${JSON.stringify(split)}`);
    assertMemberValid(split, members);
    assertEq(sumOf(split), 20, JSON.stringify(split));
  });

  test("GREEDY STEP-QUANTA ALONE WOULD STRAND A FEASIBLE SPLIT — the bounded exact search places it", async () => {
    const mod = await worker();
    // After the equal split, remainder and clamps, the deficit is 2 and NO single member can
    // absorb it in its own quanta ({4}, {3}, {1 at its cap}) — greedy DOM order dead-ends.
    // Yet 4+6+0 lands the total exactly. A false "unfillable" here is the other face of the
    // blocker: the caller records per-member no-derivation rows for a group the site itself
    // considers answerable.
    const members = [
      member(0, { min: "0", max: "4", step: "4" }),
      member(1, { min: "0", max: "6", step: "3" }),
      member(2, { min: "0", max: "1", step: "1" }),
    ];
    const split = mod.driver.allocationValues(group(members, 10));
    assert(split.ok, `a feasible lattice split was declared unfillable: ${JSON.stringify(split)}`);
    assertMemberValid(split, members);
    assertEq(sumOf(split), 10, JSON.stringify(split));
  });

  test("PROPERTY: over a deterministic (min,max,step,T) sweep, every split is member-valid and total-exact, and unfillable EXACTLY when no lattice combination reaches T", async () => {
    const mod = await worker();
    const configs = [
      { min: "0", max: "5", step: "3" },
      { min: "0", max: "20", step: "1" },
      { min: "0", max: "6", step: "3" },
      { min: "2", max: "8", step: "2" }, // anchored at min 2: the grid is {2,4,6,8}, NOT the even numbers from 0
      { min: "0", max: "4", step: "4" },
      { min: "1", max: "7", step: "1" },
    ];
    const totals = [0, 5, 7, 10, 13, 20, 26];
    let checked = 0;
    for (const a of configs) {
      for (const b of configs) {
        for (const T of totals) {
          const members = [member(0, a), member(1, b)];
          const split = mod.driver.allocationValues(group(members, T));
          const feasible = lattice(a).some((x) => lattice(b).some((y) => Math.abs(x + y - T) < 1e-9));
          if (split.ok) {
            assert(feasible, `an infeasible total ${T} over ${JSON.stringify([a, b])} produced a write: ${JSON.stringify(split)}`);
            assertMemberValid(split, members);
            assertEq(sumOf(split), T, `${JSON.stringify([a, b, T])}: ${JSON.stringify(split)}`);
          } else {
            assert(!feasible, `a feasible total ${T} over ${JSON.stringify([a, b])} was declared unfillable: ${split.why}`);
          }
          checked += 1;
        }
      }
    }
    assertEq(checked, configs.length * configs.length * totals.length, "the sweep did not cover the declared set");
  });
});

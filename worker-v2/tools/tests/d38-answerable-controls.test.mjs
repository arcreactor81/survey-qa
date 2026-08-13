/**
 * D38 — THE TWO WAYS THE BROWSER LAYER ANSWERED CONFIDENTLY AND WRONGLY.
 *
 * Both were MEASURED by driving the real `walkPath` against a live survey, not reasoned about.
 *
 * ==================== 1. A GRID CELL LABELLED ONE COLUMN TO THE RIGHT ====================
 *
 * `page-script.ts` collected grid columns with `thead th, tr:first-child th`. The first row of
 * a `<tbody>` is `:first-child` of its own parent, so its `<th scope="row">` — a ROW LABEL —
 * was collected as a sixth COLUMN over five inputs. The length-mismatch branch then shifted
 * every cell one place:
 *
 *     value 1 ("Strongly agree")  reported as  "Somewhat agree"
 *     value 5 ("Strongly disagree")  reported as  a row label
 *
 * `applyDecision` picks a grid cell by matching the planned column against `cell.column`, so a
 * documented "Somewhat agree" clicked value 1 — Strongly agree — with no error and no fallback.
 * A documented "Strongly agree" matched nothing, fell through to `cells[0]`, and was
 * ACCIDENTALLY RIGHT. Right and wrong answers from one bug on one screen.
 *
 * The reader half of that fix is in `page-script.ts`, which is a string evaluated in a page and
 * therefore cannot be executed by this suite at all — it is proved in a real browser against
 * the live target and against fixture DOMs. What IS this suite's to prove is the driver half:
 * that the fallback which used to hide the shift is NAMED when it fires, and that a limitation
 * the reader raises reaches the walk artifact instead of dying on the screen that raised it.
 *
 * ==================== 2. AN NPS SCORE THAT COULD NOT BE RECORDED ====================
 *
 * The navigator's default answered each group with `o.visible && !o.disabled`. On an
 * eleven-point NPS scale drawn as `opacity:0; width:1px` radios inside their labels, every
 * 0-10 option fails `visible`, so the ONLY reachable answer was the twelfth, "Don't know" —
 * recorded in 2 of 2 walks. Not unlikely: structurally impossible. Every route keyed on a
 * score was unreachable and the coverage report still said the screen was answered.
 *
 * The repair may not be "drop the filter" — that starts clicking honeypots and `display:none`
 * alternate layouts a respondent cannot touch. It is `operable`: the control is drawn itself,
 * or a <label> that ACTIVATES it is drawn and not covered. These tests pin both directions,
 * and the third one that is easy to forget: a screen from an OLDER reader carries no
 * `operable` field at all, and must degrade to the old behaviour rather than to "everything
 * is answerable".
 *
 * Evidence these can fail: `tools/mutate-runner.mjs` over this file's named tests.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

const ATTEMPT_ID = "att_d38000000001";
const PATH_ID = "path_d38000000001";

/* ------------------------------------------------------------------ fixtures */

const opt = (idx, code, label, extra = {}) => ({
  order: 0,
  idx,
  code,
  label,
  checked: false,
  disabled: false,
  visible: true,
  ...extra,
});

const control = (idx, { name, id = null, type = "radio", code = null, label = "", ...rest }) => ({
  idx,
  tag: "input",
  type,
  name,
  id,
  code,
  label,
  text: "",
  checked: false,
  value: null,
  disabled: false,
  required: false,
  visible: true,
  placeholder: null,
  maxlength: null,
  readOnly: false,
  ...rest,
});

const nextBtn = (idx) => ({ idx, label: "Next", role: "next", disabled: false, visible: true });

const screen = (text, { controls = [], optionGroups = [], grid = null, readerLimitations, buttons } = {}) => {
  const s = {
    at: "2026-08-08T00:05:00.000Z",
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
    buttons: buttons ?? [nextBtn(controls.length)],
    progress: { present: false, kind: null, now: null, max: null, text: null },
    validationMessages: [],
    counts: {
      controls: controls.length,
      optionGroups: optionGroups.length,
      options: optionGroups.reduce((n, g) => n + g.options.length, 0),
      textInputs: 0,
    },
    screenSignature: `sig:${text}`,
  };
  // ABSENT, not empty, unless a test sets it — that is the shape an older reader produces and
  // half of what these tests are about.
  if (readerLimitations !== undefined) s.readerLimitations = readerLimitations;
  return s;
};

/**
 * The NPS shape, exactly as the live target renders it: eleven 0-10 radios that are NOT drawn
 * but ARE operable through their labels, and one "Don't know" that is drawn.
 */
const npsScreen = ({ operable = true } = {}) => {
  const options = [];
  const controls = [];
  for (let n = 0; n <= 10; n++) {
    const extra = operable
      ? { visible: false, operable: true, actuatedVia: "label", labelIndex: n }
      : { visible: false };
    options.push(opt(n, String(n), String(n), { ...extra, order: n }));
    controls.push(control(n, { name: "Q9", id: `Q9_${n}`, code: String(n), label: String(n), ...extra }));
  }
  const dk = { visible: true, operable: true, actuatedVia: "self", labelIndex: 11 };
  options.push(opt(11, "99", "Don't know / no usual brand", { ...dk, order: 11 }));
  controls.push(control(11, { name: "Q9", id: "Q9_dk", code: "99", label: "Don't know / no usual brand", ...dk }));
  return screen("How likely would you be to recommend the coffee brand you buy most often?", {
    controls,
    optionGroups: [{ name: "Q9", kind: "radio", options }],
    readerLimitations: [],
  });
};

/** A page that serves scripted screens and RECORDS which selector every click went through. */
function fakePage(reads) {
  const queue = [...reads];
  let last = reads[0] ?? null;
  const clicks = [];
  const handle = (selector, index) => ({
    async click() {
      clicks.push({ selector, index });
    },
    async type() {},
    async focus() {},
  });
  return {
    clicks,
    async goto() {},
    async evaluate(script) {
      if (typeof script === "string" && script.includes("screenSignature")) {
        if (queue.length > 0) last = queue.shift();
        return last;
      }
      // A click transport succeeding is not proof that a native radio retained the intended
      // state. Mirror the production scoped readback so this PageLike fixture exercises the
      // exact W4 receipt contract, as the repaired D32/D55 fixtures do.
      if (typeof script === "string" && script.includes("W4_NATIVE_CHOICE_SCOPED_READBACK")) {
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

async function walk(mod, env, reads, decisions = []) {
  const runId = mod.ids.mintRunId();
  const page = fakePage(reads);
  const obs = await mod.driver.walkPath(
    page,
    { id: PATH_ID, decisions, witnesses: [] },
    {
      surveyUrl: "https://fixture.invalid/survey",
      runId,
      planRevisionId: "plan_d38test01",
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

const optionClicks = (obs) => (obs.steps[0]?.actions ?? []).filter((a) => a.kind === "click-option");

/* ------------------------------------------------------------------ tests */

suite("D38 — a control a respondent can operate is answerable, whether or not it is drawn", () => {
  test("THE NPS DEFECT: the walk records a 0-10 score, not the one option that happened to be drawn", async () => {
    const mod = await worker();
    const env = testEnv();
    const s = npsScreen();

    const { obs, page } = await walk(mod, env, [s, s, s]);
    const clicked = optionClicks(obs);

    assertEq(clicked.length, 1, JSON.stringify(clicked));
    // The whole defect in one assertion: "99" here means the only answer this survey can ever
    // receive from us is "Don't know", on every run, forever.
    assertEq(clicked[0].targetCode, "0", `answered ${clicked[0].targetCode} — ${clicked[0].detail}`);
    assert(clicked[0].ok, `the click failed: ${clicked[0].detail}`);
    // ...and it went through the LABEL, which is the route measured to work on a real browser.
    assert(/label-click/.test(clicked[0].detail ?? ""), `detail did not name the label route: ${clicked[0].detail}`);
    assert(
      page.clicks.some((c) => c.selector === "label" && c.index === 0),
      `no click was delivered through the label selector: ${JSON.stringify(page.clicks)}`,
    );
  });

  test("A CONTROL NO RESPONDENT COULD REACH IS STILL REFUSED — the counterweight", async () => {
    const mod = await worker();
    const env = testEnv();

    // A honeypot first (not drawn, no label to click), then a real option. The old predicate
    // skipped the honeypot for the right reason by accident; the new one must skip it for the
    // stated reason, and must NOT start clicking it just because it stopped keying on `visible`.
    const s = screen("Which brand do you buy most often?", {
      controls: [
        control(0, { name: "Q3", code: "bot", label: "", visible: false, operable: false, actuatedVia: "none", labelIndex: null }),
        control(1, { name: "Q3", code: "1", label: "Brand A", visible: true, operable: true, actuatedVia: "self" }),
      ],
      optionGroups: [
        {
          name: "Q3",
          kind: "radio",
          options: [
            opt(0, "bot", "", { visible: false, operable: false, actuatedVia: "none", labelIndex: null }),
            opt(1, "1", "Brand A", { order: 1, visible: true, operable: true, actuatedVia: "self" }),
          ],
        },
      ],
      readerLimitations: [],
    });

    const { obs, page } = await walk(mod, env, [s, s, s]);
    const clicked = optionClicks(obs);

    assertEq(clicked.length, 1, JSON.stringify(clicked));
    assertEq(clicked[0].targetCode, "1", `clicked the unreachable control: ${JSON.stringify(clicked[0])}`);
    assert(
      !page.clicks.some((c) => c.selector === "label"),
      `a control with no label was actuated through one: ${JSON.stringify(page.clicks)}`,
    );
  });

  test("A SCREEN FROM AN OLDER READER carries no `operable` at all, and must keep the old behaviour", async () => {
    const mod = await worker();
    const env = testEnv();

    // No `operable` anywhere — this is what every walk artifact written before this change
    // looks like. Absence must read as "this reader did not look", so the answer falls back to
    // `visible`; reading it as "operable" would answer with a control nobody can see.
    const s = screen("Which brand do you buy most often?", {
      controls: [
        control(0, { name: "Q3", code: "bot", label: "", visible: false }),
        control(1, { name: "Q3", code: "1", label: "Brand A", visible: true }),
      ],
      optionGroups: [
        {
          name: "Q3",
          kind: "radio",
          options: [opt(0, "bot", "", { visible: false }), opt(1, "1", "Brand A", { order: 1, visible: true })],
        },
      ],
    });

    const { obs } = await walk(mod, env, [s, s, s]);
    const clicked = optionClicks(obs);
    assertEq(clicked.length, 1, JSON.stringify(clicked));
    assertEq(clicked[0].targetCode, "1", JSON.stringify(clicked[0]));
  });
});

/* ------------------------------------------------------------------ the grid half */

const gridScreen = (columns, cellColumns) =>
  screen("How much do you agree or disagree with each of the following statements?", {
    controls: [
      control(0, { name: "Q5_a", id: "Q5_a_1", code: "1", label: "Statement one - Strongly agree" }),
      control(1, { name: "Q5_a", id: "Q5_a_2", code: "2", label: "Statement one - Somewhat agree" }),
    ],
    optionGroups: [],
    grid: {
      columns,
      rows: [
        {
          label: "Statement one",
          name: "Q5_a",
          cells: [
            { column: cellColumns[0], code: "1", checked: false, idx: 0 },
            { column: cellColumns[1], code: "2", checked: false, idx: 1 },
          ],
        },
      ],
    },
    readerLimitations: [],
  });

/** Binds by MARKUP alone: no wording on the decision, control names carry `Q5`. */
const gridDecision = (wantColumn) => ({
  question: "Q5",
  select: [],
  strategy: `grid:answer-every-row with "${wantColumn}"`,
});

suite("D38 — the grid fallback that hid a shifted column parse is NAMED when it fires", () => {
  test("the documented column is answered, and nothing is flagged", async () => {
    const mod = await worker();
    const env = testEnv();
    const s = gridScreen(["Strongly agree", "Somewhat agree"], ["Strongly agree", "Somewhat agree"]);

    const { obs } = await walk(mod, env, [s, s, s], [gridDecision("Somewhat agree")]);
    const cells = (obs.steps[0].actions ?? []).filter((a) => a.kind === "select-grid-cell");

    assertEq(cells.length, 1, JSON.stringify(obs.steps[0].actions));
    assertEq(cells[0].targetCode, "2", JSON.stringify(cells[0]));
    assert(
      !/no-column-matched/.test(cells[0].detail ?? ""),
      `a clean match was reported as a fallback: ${cells[0].detail}`,
    );
  });

  test("NO COLUMN MATCHED: the first cell is still clicked, but the record says so", async () => {
    const mod = await worker();
    const env = testEnv();
    // The columns could not be resolved, so the reader labelled nothing. Taking cells[0] here
    // is a DIFFERENT act from answering the documented column, and it used to be recorded
    // identically — which is how the shifted parse produced wrong answers that read like right
    // ones. The click still happens (the walk must go on); the fallback is no longer silent.
    const s = gridScreen([], [null, null]);

    const { obs } = await walk(mod, env, [s, s, s], [gridDecision("Somewhat agree")]);
    const cells = (obs.steps[0].actions ?? []).filter((a) => a.kind === "select-grid-cell");

    assertEq(cells.length, 1, JSON.stringify(obs.steps[0].actions));
    assertEq(cells[0].targetCode, "1", JSON.stringify(cells[0]));
    assert(
      /no-column-matched "Somewhat agree"/.test(cells[0].detail ?? ""),
      `the fallback was not named: ${cells[0].detail}`,
    );
    assert(
      /columns are unlabelled/.test(cells[0].detail ?? ""),
      `the record does not say the columns were unresolved: ${cells[0].detail}`,
    );
  });
});

suite("D38 — a limitation the reader named reaches the walk artifact", () => {
  test("it is LISTED with its screen and COUNTED, not left on the screen that raised it", async () => {
    const mod = await worker();
    const env = testEnv();
    const s = screen("How much do you agree or disagree with each of the following statements?", {
      controls: [control(0, { name: "Q5_a", code: "1", label: "Statement one - Strongly agree", visible: true, operable: true, actuatedVia: "self" })],
      optionGroups: [],
      readerLimitations: [
        {
          kind: "grid-column-labels-unresolved",
          detail: "THE GRID COLUMNS COULD NOT BE MATCHED TO THE INPUTS, so 5 cell(s) are reported with no column label",
          count: 5,
        },
      ],
    });

    const { obs } = await walk(mod, env, [s, s, s]);

    assertEq((obs.readerLimitations ?? []).length, 1, JSON.stringify(obs.readerLimitations));
    assertEq(obs.readerLimitations[0].kind, "grid-column-labels-unresolved");
    assertEq(obs.readerLimitations[0].stepIndex, 0);
    assertEq(obs.readerLimitationCount, 5, JSON.stringify(obs.readerLimitations));
  });

  test("a screen that raised NONE leaves the count at zero — 'we looked' stays different from 'nobody looked'", async () => {
    const mod = await worker();
    const env = testEnv();
    // `readerLimitations: []` is a claim. The walk-level count must therefore be 0 and the list
    // present-but-empty, never absent, or a consumer cannot tell this from an older artifact.
    const s = npsScreen();

    const { obs } = await walk(mod, env, [s, s, s]);
    assertEq((obs.readerLimitations ?? null)?.length, 0, JSON.stringify(obs.readerLimitations));
    assertEq(obs.readerLimitationCount, 0, JSON.stringify(obs.readerLimitationCount));
  });
});

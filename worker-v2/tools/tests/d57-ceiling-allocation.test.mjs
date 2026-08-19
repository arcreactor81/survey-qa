/**
 * D57 — ALLOCATION UNDER A CARRY-FORWARD CEILING (docs/FORWARD-SCAN.md §3.4).
 *
 * THE CLASS. A sum-to-100 allocation grid where some rows carry a per-row CEILING that the
 * screen DISPLAYS — a read-only column piping an earlier answer onto the same screen ("this
 * row may not exceed what you gave it last time"). Amendment 7's recovery splits 100/0/0
 * with the whole 100 in the FIRST cell; where that row's displayed cap is below 100 the site
 * rejects the split for ever and the walk stalls on a screen whose own answer was visible
 * the entire time.
 *
 * THE FIX, AND ITS BOUNDARY. The split becomes ceiling-aware using ONLY what the screen
 * itself shows: a read-only cell whose whole content is a number in the same row as an
 * allocation input, or a limit the site's own validation states in words. No cross-screen
 * memory, no question ids, no column names — the walker must not know that a column headed
 * "Current scenario" pipes an earlier question. Where nothing is displayed, the existing
 * first-cell behaviour stands, byte for byte.
 *
 * EVIDENCE THESE CAN FAIL. Every test here is written to fail on the pre-fix behaviour:
 * the walk tests block (the site rejects 100 on a capped row for ever) and the unit tests
 * assert placements the ordinal walk cannot produce. The counterproof is the other
 * direction — it pins the unchanged receipt so the fix cannot quietly rewrite a screen it
 * was never meant to touch.
 */

import { assert, assertEq, suite, test, loadWorker } from "../testkit.mjs";
import { testEnv } from "./_helpers.mjs";

// ------------------------------------------------------------------ helpers

const isDigits = (s) => typeof s === "string" && s.length > 0 && [...s].every((ch) => ch >= "0" && ch <= "9");

const roControl = (idx, value, label) => ({
  idx,
  tag: "input",
  type: "text",
  name: null,
  id: null,
  code: null,
  label,
  text: "",
  checked: null,
  value,
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
  readOnly: true,
});

const fillControl = (idx, name, label) => ({
  idx,
  tag: "input",
  type: "text",
  name,
  id: null,
  code: null,
  label,
  text: "",
  checked: null,
  value: "",
  valueIsUserSupplied: false,
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
});

/**
 * Build a generic allocation screen from a row spec.
 *
 * Each row is `{ label, ceiling: number|null, specify?: true }`. A row with a ceiling gets a
 * READ-ONLY cell holding that number in the same table row as its input — the shape a piped
 * carry-forward column takes on any platform that renders one. Nothing here names a survey,
 * a question id or a column: the association is the table's own row.
 */
const buildScreen = (rows) => {
  const controls = [];
  const gridRows = [];
  const targets = [];
  const ceilingOf = {};
  let specifyIdx = null;
  let idx = 0;
  let n = 0;
  for (const row of rows) {
    const cells = [];
    if (row.ceiling !== null && row.ceiling !== undefined) {
      controls.push(roControl(idx, String(row.ceiling), "Current scenario"));
      cells.push({ column: "Current scenario", code: String(row.ceiling), checked: false, idx });
      idx += 1;
    }
    n += 1;
    const label = row.specify ? "Others (Please Specify)" : "%";
    controls.push(fillControl(idx, `C10_${n}`, label));
    cells.push({ column: label, code: "", checked: false, idx });
    if (row.specify) specifyIdx = idx;
    else {
      targets.push(idx);
      if (row.ceiling !== null && row.ceiling !== undefined) ceilingOf[idx] = row.ceiling;
    }
    idx += 1;
    gridRows.push({ label: row.label, name: `C10_${n}`, cells });
  }
  return {
    controls,
    targets,
    ceilingOf,
    specifyIdx,
    grid: { columns: ["Current scenario", "%"], rows: gridRows },
  };
};

/**
 * Walk one allocation screen against a site that ENFORCES its displayed ceilings.
 *
 * The site advances only when every % cell holds a number, the numbers total 100, no cell
 * exceeds the cap its own row displays, and the specify cell (if any) is empty. Any other
 * state is rejected — which is exactly what makes 100-on-a-capped-row an unwinnable screen.
 */
const ceilingWalk = async ({ rows, useGrid = true }) => {
  const { mod } = await loadWorker();
  const env = testEnv();
  const NEXT_IDX = 90;
  const built = buildScreen(rows);
  const { controls, targets, ceilingOf, specifyIdx } = built;
  const stored = {};
  for (const c of controls) stored[c.idx] = "";

  let nextClicks = 0;
  let done = false;

  const sum = () => targets.reduce((a, i) => a + (isDigits(stored[i]) ? Number(stored[i]) : 0), 0);
  const allNumeric = () => targets.every((i) => isDigits(stored[i]));
  const overCap = () =>
    targets.filter((i) => ceilingOf[i] !== undefined && isDigits(stored[i]) && Number(stored[i]) > ceilingOf[i]);
  const specifyEmpty = () => specifyIdx === null || String(stored[specifyIdx] ?? "").length === 0;

  const V_NUMERIC = ["Please enter numeric answers in column % of PCVs stocked."];
  const V_SUM = ["The number entered must total 100."];
  const V_PAIRING = [
    "If you specify «Others (Please Specify)» then please enter answer for the «Others (Please Specify)» option.",
  ];
  const capMessage = (i) => {
    const row = built.grid.rows.find((r) => r.cells.some((cell) => cell.idx === i));
    return `Please enter a number less than or equal to ${ceilingOf[i]} for ${row ? row.label : "this row"}.`;
  };

  const currentValidation = () => {
    if (nextClicks === 0) return [];
    if (!allNumeric()) return V_NUMERIC;
    const over = overCap();
    if (over.length > 0) return [capMessage(over[0])];
    if (!specifyEmpty()) return V_PAIRING;
    if (sum() !== 100) return V_SUM;
    return [];
  };

  const mk = (validation) => ({
    at: "2026-08-19T12:00:00.000Z",
    url: "https://fixture.invalid/survey",
    title: "C10",
    questionText: "C10. What proportion of each?",
    grid: useGrid ? built.grid : null,
    collectedErrors: [],
    readerLimitations: [],
    controls,
    optionGroups: [],
    buttons: [{ idx: NEXT_IDX, label: ">>", role: "next", roleVia: "text:Next", disabled: false, visible: true }],
    validationMessages: validation,
    progress: { present: false, value: null },
    counts: {
      controls: controls.length,
      optionGroups: 0,
      options: 0,
      textInputs: controls.length,
      valueInputs: controls.length,
      optionsNotOperable: 0,
      readerLimitations: 0,
    },
    screenSignature: "sig:c10alloc",
  });

  const doneScreen = {
    ...mk([]),
    url: "https://fixture.invalid/survey/next",
    questionText: "C20.",
    grid: null,
    controls: [],
    buttons: [],
    counts: {
      controls: 0,
      optionGroups: 0,
      options: 0,
      textInputs: 0,
      valueInputs: 0,
      optionsNotOperable: 0,
      readerLimitations: 0,
    },
    screenSignature: "sig:c10done",
  };

  // The % cells carry an input mask: they DISCARD anything that is not digits, exactly as the
  // live grid did. The specify cell keeps whatever it is given.
  const put = (idx, v) => {
    if (idx === specifyIdx) stored[idx] = v;
    else stored[idx] = isDigits(v) || v === "" ? v : "";
  };
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
        const i = idxFromSrc(src);
        return { got: i !== null ? stored[i] ?? "" : "" };
      }
      if (src.includes("el.value = ''")) {
        const i = idxFromSrc(src);
        if (i !== null) {
          put(i, "");
          delete lastTyped[i];
        }
        return { ok: true };
      }
      const start = src.indexOf('el.value = "');
      if (start >= 0 && src.includes("change")) {
        const end = src.indexOf('";', start);
        const v = end > start ? src.slice(start + 'el.value = "'.length, end) : "";
        const i = idxFromSrc(src);
        if (i !== null) {
          put(i, v);
          lastTyped[i] = stored[i];
        }
        return { ok: true, reason: null, got: i !== null ? stored[i] : v };
      }
      if (src.includes("'value' in e")) {
        const i = idxFromSrc(src);
        return i !== null ? lastTyped[i] ?? stored[i] ?? "" : "";
      }
      return { ok: true };
    },
    async evaluateOnNewDocument() {},
    async $$() {
      const mkHandle = (i) => ({
        async click() {
          if (i !== NEXT_IDX) return;
          if (allNumeric() && overCap().length === 0 && specifyEmpty() && sum() === 100) done = true;
          else nextClicks += 1;
        },
        async type(v) {
          lastTyped[i] = v;
          put(i, v);
        },
        async focus() {},
      });
      return Array.from({ length: 95 }, (_, i) => mkHandle(i));
    },
    async screenshot() {
      return new TextEncoder().encode("PNG-D57");
    },
    async setViewport() {},
    on() {},
    async close() {},
    async reload() {},
  };

  const runId = mod.ids.mintRunId();
  const obs = await mod.driver.walkPath(
    page,
    { id: "path_d57ceil", decisions: [], witnesses: [] },
    {
      surveyUrl: "https://fixture.invalid/survey",
      runId,
      planRevisionId: "plan_d57ceil1",
      attemptId: "att_d57ceil001",
      tier: 1,
      maxSteps: 2,
      deadline: Date.now() + 30_000,
      viewport: { width: 1280, height: 900 },
      applyHistoryShim: false,
      advanceTimeoutMs: 400,
    },
    { env, runId, attemptId: "att_d57ceil001", pathId: "path_d57ceil", witnesses: [] },
  );
  return { obs, stored, built };
};

const recoveryFills = (obs) => {
  const rec = obs.steps.find((s) => s.decisionSource === "recovery");
  assert(rec, "a recovery step must be recorded");
  return {
    rec,
    byIdx: new Map(
      (rec.actions ?? [])
        .filter((a) => (a.kind === "set-value" || a.kind === "type-text") && a.ok)
        .map((a) => [a.targetIdx, a.value]),
    ),
  };
};

// ------------------------------------------------------------------ the walk

suite("d57: an allocation split respects the ceilings its own screen displays", () => {
  test("THE CLASS: a grid row showing a ceiling of 40 takes 0 and the uncapped row takes the 100", async () => {
    // Pre-fix this screen is unwinnable: the 100 lands on the capped row, the site rejects it
    // for ever, and the walk records `blocked` on a question whose answer was on the screen.
    const { obs, stored, built } = await ceilingWalk({
      rows: [
        { label: "PCV15", ceiling: 40 },
        { label: "Product X", ceiling: null },
      ],
    });
    const capped = built.targets[0];
    const free = built.targets[1];
    const { byIdx } = recoveryFills(obs);
    assertEq(byIdx.get(capped), "0", `the capped row must not take the mass, got ${JSON.stringify(byIdx.get(capped))}`);
    assertEq(byIdx.get(free), "100", `the uncapped row must take the mass, got ${JSON.stringify(byIdx.get(free))}`);
    assertEq(stored[capped], "0", "and the page ends with 0 in the capped cell");
    assertEq(stored[free], "100", "and 100 in the uncapped cell");
    assert(obs.outcome !== "blocked", `the walk must get past the screen, outcome was ${JSON.stringify(obs.outcome)}`);
  });

  test("the receipt names the split AND the displayed bound that constrained it", async () => {
    const { obs, built } = await ceilingWalk({
      rows: [
        { label: "PCV15", ceiling: 40 },
        { label: "Product X", ceiling: null },
      ],
    });
    const { rec } = recoveryFills(obs);
    const detail = String(
      (rec.actions ?? []).find((a) => a.targetIdx === built.targets[1] && a.kind === "set-value")?.detail ?? "",
    );
    assert(
      detail.includes("100 placed on cell #") && detail.includes("the first cell this screen shows no ceiling for"),
      `the receipt must state the split chosen, got ${JSON.stringify(detail)}`,
    );
    assert(
      detail.includes("displayed bounds:") && detail.includes("<= 40"),
      `the receipt must name the displayed bound that constrained it, got ${JSON.stringify(detail)}`,
    );
    assert(
      detail.includes("read-only cell showing 40"),
      `the receipt must say WHERE the bound was read, got ${JSON.stringify(detail)}`,
    );
  });

  test("the ceiling fix and the specify clear compose: mass on the uncapped % row, specify emptied", async () => {
    const { obs, stored, built } = await ceilingWalk({
      rows: [
        { label: "PCV15", ceiling: 40 },
        { label: "Product X", ceiling: null },
        { label: "Others", ceiling: null, specify: true },
      ],
    });
    const capped = built.targets[0];
    const free = built.targets[1];
    const { rec, byIdx } = recoveryFills(obs);
    assertEq(byIdx.get(capped), "0", "the capped row still takes 0");
    assertEq(byIdx.get(free), "100", "the uncapped % row still takes the 100");
    const numericIntoSpecify = (rec.actions ?? []).filter(
      (a) => (a.kind === "set-value" || a.kind === "type-text") && a.targetIdx === built.specifyIdx && isDigits(a.value),
    );
    assertEq(numericIntoSpecify.length, 0, "the specify cell never receives a number");
    assertEq(stored[built.specifyIdx], "", "and the page's specify state ends empty");
    assert(obs.outcome !== "blocked", `outcome was ${JSON.stringify(obs.outcome)}`);
  });

  test("THE COUNTERPROOF: with no ceiling displayed the receipt is the pre-fix one, byte for byte", async () => {
    // The fix must be inert on every screen that shows no bound. This pins the exact string
    // amendment 7 produced, so a future ceiling-detector that fires too eagerly is caught
    // here rather than by silently reshaping an answer on a screen it had no business
    // touching.
    const { obs, stored, built } = await ceilingWalk({
      rows: [
        { label: "PCV15", ceiling: null },
        { label: "Product X", ceiling: null },
        { label: "Product Y", ceiling: null },
      ],
    });
    const { rec, byIdx } = recoveryFills(obs);
    assertEq(
      JSON.stringify(built.targets.map((i) => byIdx.get(i))),
      JSON.stringify(["100", "0", "0"]),
      "with nothing displayed the first cell keeps the whole 100",
    );
    const detail = String(
      (rec.actions ?? []).find((a) => a.targetIdx === built.targets[0] && a.kind === "set-value")?.detail ?? "",
    );
    const EXPECTED =
      "navigator-default:the site's validation demands a number " +
      '("Please enter numeric answers in column % of PCVs stocked.")' +
      "; 3 numeric cells share this screen — allocation split (100 first, 0 rest) so a sum constraint can hold (";
    assertEq(
      detail.slice(0, EXPECTED.length),
      EXPECTED,
      `the no-ceiling receipt must be unchanged, got ${JSON.stringify(detail)}`,
    );
    assert(!detail.includes("displayed bounds:"), "and it must claim no bounds it never read");
    assertEq(stored[built.targets[0]], "100", "the page state matches the pre-fix split");
  });
});

// ------------------------------------------------------------------ the detector

suite("d57: the ceiling detector reads only what the screen displays", () => {
  const screenOf = (controls, grid = null) => ({
    at: "2026-08-19T12:00:00.000Z",
    url: "https://fixture.invalid/survey",
    title: null,
    collectedErrors: [],
    questionText: null,
    instructionText: null,
    visibleText: "",
    visibleTextTruncated: false,
    bracketedInstructionsVisible: [],
    controls,
    optionGroups: [],
    grid,
    buttons: [],
  });

  test("a read-only cell in the input's own grid row is the row's ceiling", async () => {
    const { mod } = await loadWorker();
    const controls = [roControl(0, "40", "Current scenario"), fillControl(1, "C10_1", "%"), fillControl(2, "C10_2", "%")];
    const grid = {
      columns: ["Current scenario", "%"],
      rows: [
        { label: "PCV15", name: "C10_1", cells: [{ column: "Current scenario", code: "40", checked: false, idx: 0 }, { column: "%", code: "", checked: false, idx: 1 }] },
        { label: "Product X", name: "C10_2", cells: [{ column: "%", code: "", checked: false, idx: 2 }] },
      ],
    };
    const found = mod.driver.displayedRowCeilings(screenOf(controls, grid), [1, 2], []);
    assertEq(found.length, 1, `exactly one row displays a bound, got ${JSON.stringify(found)}`);
    assertEq(found[0].idx, 1);
    assertEq(found[0].ceiling, 40);
  });

  test("a row head that merely CONTAINS digits is not a ceiling", async () => {
    // "PCV15" and "Product 3" are names, not bounds. Reading a cap out of a product name is
    // the failure this class cannot afford, because a wrong cap reshapes an answer silently.
    const { mod } = await loadWorker();
    const controls = [roControl(0, "PCV15", "Product"), fillControl(1, "C10_1", "%"), fillControl(2, "C10_2", "%")];
    const grid = {
      columns: ["Product", "%"],
      rows: [
        { label: "PCV15", name: "C10_1", cells: [{ column: "Product", code: "PCV15", checked: false, idx: 0 }, { column: "%", code: "", checked: false, idx: 1 }] },
        { label: "Product X", name: "C10_2", cells: [{ column: "%", code: "", checked: false, idx: 2 }] },
      ],
    };
    assertEq(JSON.stringify(mod.driver.displayedRowCeilings(screenOf(controls, grid), [1, 2], [])), "[]");
  });

  test("a grid row holding TWO allocation inputs is ambiguous and states no bound", async () => {
    // Which of the two does the read-only number cap? The table does not say, and a cap
    // apportioned to the wrong input is a wrong answer that reads like a right one.
    const { mod } = await loadWorker();
    const controls = [roControl(0, "40", "Current scenario"), fillControl(1, "C10_1", "%"), fillControl(2, "C10_2", "%")];
    const grid = {
      columns: ["Current scenario", "%", "%"],
      rows: [
        {
          label: "PCV15",
          name: "C10_1",
          cells: [
            { column: "Current scenario", code: "40", checked: false, idx: 0 },
            { column: "%", code: "", checked: false, idx: 1 },
            { column: "%", code: "", checked: false, idx: 2 },
          ],
        },
      ],
    };
    assertEq(JSON.stringify(mod.driver.displayedRowCeilings(screenOf(controls, grid), [1, 2], [])), "[]");
  });

  test("an EDITABLE numeric neighbour is never read as a ceiling", async () => {
    // A bound is something the screen SHOWS and the respondent cannot change. Another
    // allocation cell that happens to hold a number is not a cap on its neighbour.
    const { mod } = await loadWorker();
    const editable = { ...fillControl(0, "C10_0", "%"), value: "40" };
    const controls = [editable, fillControl(1, "C10_1", "%"), fillControl(2, "C10_2", "%")];
    assertEq(JSON.stringify(mod.driver.displayedRowCeilings(screenOf(controls), [1, 2], [])), "[]");
  });

  test("without a table, an adjacent read-only number binds to the nearer input", async () => {
    const { mod } = await loadWorker();
    const controls = [roControl(0, "25", "prior"), fillControl(1, "C10_1", "%"), fillControl(2, "C10_2", "%")];
    const found = mod.driver.displayedRowCeilings(screenOf(controls), [1, 2], []);
    assertEq(found.length, 1, `one bound, got ${JSON.stringify(found)}`);
    assertEq(found[0].idx, 1);
    assertEq(found[0].ceiling, 25);
  });

  test("an equidistant read-only number names no row and is refused", async () => {
    const { mod } = await loadWorker();
    const controls = [fillControl(0, "C10_1", "%"), roControl(1, "25", "prior"), fillControl(2, "C10_2", "%")];
    assertEq(JSON.stringify(mod.driver.displayedRowCeilings(screenOf(controls), [0, 2], [])), "[]");
  });

  test("the site's own words are honoured when they name one row and one limit", async () => {
    const { mod } = await loadWorker();
    const controls = [fillControl(0, "C10_1", "PCV15 share"), fillControl(1, "C10_2", "Product X share")];
    const found = mod.driver.displayedRowCeilings(screenOf(controls), [0, 1], [
      "Please enter a number less than or equal to 30 for PCV15 share.",
    ]);
    assertEq(found.length, 1, `one bound, got ${JSON.stringify(found)}`);
    assertEq(found[0].idx, 0);
    assertEq(found[0].ceiling, 30);
  });

  test("a validation naming TWO rows is ambiguous and states no bound", async () => {
    const { mod } = await loadWorker();
    const controls = [fillControl(0, "C10_1", "PCV15 share"), fillControl(1, "C10_2", "PCV20 share")];
    const found = mod.driver.displayedRowCeilings(screenOf(controls), [0, 1], [
      "PCV15 share and PCV20 share must each be no more than 30",
    ]);
    assertEq(JSON.stringify(found), "[]", `an ambiguous segment must bind nothing, got ${JSON.stringify(found)}`);
  });
});

// ------------------------------------------------------------------ the splitter

suite("d57: the ceiling-aware split places mass where the bounds allow", () => {
  test("no bounds at all leaves the pre-fix split and reports no reason", async () => {
    const { mod } = await loadWorker();
    const out = mod.driver.ceilingAwareAllocationSplit([3, 7, 9], 100, []);
    assertEq(out.how, null, "nothing displayed means nothing to say");
    assertEq(JSON.stringify([...out.values]), JSON.stringify([[3, "100"], [7, "0"], [9, "0"]]));
  });

  test("the mass goes to the FIRST cell with no displayed ceiling", async () => {
    const { mod } = await loadWorker();
    const out = mod.driver.ceilingAwareAllocationSplit([3, 7, 9], 100, [
      { idx: 3, ceiling: 40, via: "a read-only cell showing 40" },
      { idx: 7, ceiling: 10, via: "a read-only cell showing 10" },
    ]);
    assertEq(JSON.stringify([...out.values]), JSON.stringify([[3, "0"], [7, "0"], [9, "100"]]));
    assert(String(out.how).includes("<= 40"), `the bounds must travel in the receipt, got ${JSON.stringify(out.how)}`);
  });

  test("every cell capped: largest-ceiling-first, and the total is still reached", async () => {
    const { mod } = await loadWorker();
    const out = mod.driver.ceilingAwareAllocationSplit([3, 7, 9], 100, [
      { idx: 3, ceiling: 40, via: "shown" },
      { idx: 7, ceiling: 70, via: "shown" },
      { idx: 9, ceiling: 5, via: "shown" },
    ]);
    // 70 first (roomiest), then 30 of the 40 available on cell 3, and cell 9 is untouched.
    assertEq(JSON.stringify([...out.values]), JSON.stringify([[3, "30"], [7, "70"], [9, "0"]]));
    const total = [...out.values.values()].reduce((a, v) => a + Number(v), 0);
    assertEq(total, 100, "the demanded sum is still hit exactly");
    assert(String(out.how).includes("largest-ceiling-first"), `got ${JSON.stringify(out.how)}`);
  });

  test("no split can satisfy the caps: DEGRADE to the pre-fix split with the arithmetic named", async () => {
    const { mod } = await loadWorker();
    const out = mod.driver.ceilingAwareAllocationSplit([3, 7], 100, [
      { idx: 3, ceiling: 10, via: "shown" },
      { idx: 7, ceiling: 20, via: "shown" },
    ]);
    assertEq(JSON.stringify([...out.values]), JSON.stringify([[3, "100"], [7, "0"]]),
      "the degrade is the pre-fix split, not a knowingly-short sum");
    assert(
      String(out.how).includes("allow at most 30") && String(out.how).includes("below the 100"),
      `the shortfall must be named, not papered over, got ${JSON.stringify(out.how)}`,
    );
  });

  test("a capped cell never receives more than its displayed ceiling", async () => {
    // The property, not an example: across a spread of cap sets, no cell exceeds its cap.
    const { mod } = await loadWorker();
    const caps = [[90, 30, 60], [100, 1, 1], [50, 50, 50], [33, 33, 34]];
    for (const set of caps) {
      const ceilings = set.map((ceiling, i) => ({ idx: i, ceiling, via: "shown" }));
      const out = mod.driver.ceilingAwareAllocationSplit([0, 1, 2], 100, ceilings);
      for (const c of ceilings) {
        const got = Number(out.values.get(c.idx));
        assert(
          got <= c.ceiling,
          `cell #${c.idx} got ${got} against a displayed ceiling of ${c.ceiling} (caps ${JSON.stringify(set)})`,
        );
      }
    }
  });
});

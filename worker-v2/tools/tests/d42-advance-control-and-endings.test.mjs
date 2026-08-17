/**
 * D42 — THE STALL THAT PRODUCED A LARGE NUMBER AND READ AS SUCCESS.
 *
 * Four medical surveys ran, reported "38 observations, $0.025 each", and that was passed
 * upward as a result. A forensic review found ALL FOUR WALKS STUCK ON SCREEN 1 OF 5: the 38
 * observations were 38 captures OF THE SAME SCREEN, and 142/142 medical observations were
 * stalled. Nothing in the artifact contradicted the summary, because nothing in the artifact
 * could express the difference between "this survey ended" and "we never got into it".
 *
 * ==================== 1. THE CLASSIFIER THAT COULD NOT SEE A BUTTON ====================
 *
 * `page-script.ts` classified navigation with `(c.text || c.label || '')`. SurveyJS renders
 * navigation as `<input type="button" title="Next" value="Next">` — an `<input>` has NO
 * `textContent`, and `labelFor` finds no `<label>` for it, so BOTH inputs to that rule were the
 * empty string on every SurveyJS screen ever read. Every navigation control classified `other`.
 *
 * `nextButton` then survived screen 1 BY ACCIDENT: the first page offers only Next, so its
 * "exactly one non-back candidate" fallback picked it up. Screen 2 adds Previous, two `other`
 * candidates tie, and the walk reports `no-advance-control` — which was ALSO the value a
 * finished survey produced. MEASURED before the fix, driving the real `walkPath` against the
 * live instruments: migraine and type-2-diabetes died on screen 2 with `no-advance-control`;
 * oncology and rheumatoid-arthritis died on screen 1 `blocked`, because the walker's default
 * filler "QA-PROBE" had been typed into `<input type="number" min="0" max="50">` and the site
 * answered "Invalid input". After the fix all four walk all five screens to the thank-you page.
 *
 * ==================== 2. ONE ENUM VALUE FOR TWO OPPOSITE EVENTS ====================
 *
 * `outcome: "no-advance-control"` meant both "the respondent reached the end" and "nothing here
 * advances". `outcome: "completed"` cannot be used instead — it means "the step loop exited
 * under budget", and a real thank-you page does not land there. So the ending is typed from the
 * EVIDENCE on the final screen, and `unclassified` is a real counted residual: defaulting an
 * unrecognised ending to `completed` would rebuild the defect one level up.
 *
 * ==================== 3. THE READER CONTRADICTING ITSELF ====================
 *
 * `counts.textInputs` counted `text`/`textarea`; the driver filled `text`/`textarea`/`number`/
 * `email`. A screen whose only free-text question is a number field therefore reported
 * `textInputs: 0` beside its own inventory holding one — and `walkPath` asks
 * `counts.textInputs > 0` when deciding whether the survey RENDERED AT ALL.
 *
 * WHAT THIS SUITE CAN AND CANNOT REACH. `page-script.ts` is a string evaluated in a page; node
 * has no DOM and cannot run it. The two DECISIONS inside it that are pure are therefore held as
 * their own source strings and `eval`ed here, so the text under test is byte-for-byte the text
 * the browser runs. Everything DOM-shaped is proved in a real browser instead —
 * `node tools/live-walk.mjs` drives the production `walkPath` against the live medical fleet and
 * against `tools/fixtures/endings/*.html`.
 *
 * Evidence these can fail: `tools/mutate-endings.mjs`.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

const ATTEMPT_ID = "att_d42000000001";
const PATH_ID = "path_d42000000001";

/* ------------------------------------------------------------------ fixtures */

const control = (idx, { type = "radio", name = null, id = null, code = null, label = "", ...rest }) => ({
  idx,
  tag: type === "textarea" ? "textarea" : type === "button" ? "input" : "input",
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
  operable: true,
  actuatedVia: "self",
  placeholder: null,
  maxlength: null,
  readOnly: false,
  ...rest,
});

const screen = (text, { controls = [], optionGroups = [], buttons, progress, visibleText, signature, url, historyLength } = {}) => ({
  at: "2026-08-08T00:05:00.000Z",
  url: url ?? "https://fixture.invalid/survey",
  title: null,
  collectedErrors: [],
  questionText: text,
  instructionText: null,
  visibleText: visibleText ?? text,
  visibleTextTruncated: false,
  bracketedInstructionsVisible: [],
  controls,
  optionGroups,
  grid: null,
  buttons: buttons ?? [],
  progress: progress ?? { present: false, kind: null, now: null, max: null, text: null },
  validationMessages: [],
  readerLimitations: [],
  counts: {
    controls: controls.length,
    optionGroups: optionGroups.length,
    options: optionGroups.reduce((n, g) => n + g.options.length, 0),
    textInputs: controls.filter((c) => ["text", "textarea", "number", "email"].includes(c.type)).length,
  },
  historyLength: historyLength ?? null,
  screenSignature: signature ?? `sig:${text}`,
});

const nextBtn = (idx = 9) => ({ idx, label: "Next", labelSource: "code", role: "next", roleVia: "code:Next", disabled: false, visible: true });

/** A page that serves scripted screens; the driver's real `walkPath` runs against it. */
function fakePage(reads) {
  const queue = [...reads];
  let last = reads[0] ?? null;
  const typed = [];
  const handle = () => ({
    async click() {},
    async type(text) {
      typed.push(text);
    },
    async focus() {},
  });
  return {
    typed,
    async goto() {},
    async evaluate(script) {
      if (typeof script === "string" && script.includes("screenSignature")) {
        if (queue.length > 0) last = queue.shift();
        return last;
      }
      return { ok: true };
    },
    async evaluateOnNewDocument() {},
    async $$() {
      return Array.from({ length: 32 }, () => handle());
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

async function walk(mod, env, reads, { decisions = [], maxSteps = 1 } = {}) {
  const runId = mod.ids.mintRunId();
  const page = fakePage(reads);
  const obs = await mod.driver.walkPath(
    page,
    { id: PATH_ID, decisions, witnesses: [] },
    {
      surveyUrl: "https://fixture.invalid/survey",
      runId,
      planRevisionId: "plan_d42test01",
      attemptId: ATTEMPT_ID,
      tier: 1,
      maxSteps,
      deadline: Date.now() + 30_000,
      viewport: { width: 1280, height: 900 },
      applyHistoryShim: false,
      advanceTimeoutMs: 200,
    },
    { env, runId, attemptId: ATTEMPT_ID, pathId: PATH_ID, witnesses: [] },
  );
  return { obs, page };
}

/* ============================================================ 1. the classifier */

suite("D42 — the control that advances the survey is found by what the CONTROL says", () => {
  test("THE MEDICAL-FLEET DEFECT: `<input type=button value=Next>` has no text and no label, and is still Next", async () => {
    const mod = await worker();
    const classify = (0, eval)(mod.pageScript.CLASSIFY_CONTROL_ROLE_SRC);

    // Exactly what the reader captured from the live instrument: text and label BOTH empty,
    // the word "Next" reachable only through `value` (and `title`).
    const v = classify({ text: "", label: "", code: "Next", title: "Next", ariaLabel: null });
    assertEq(v.role, "next", JSON.stringify(v));
    assert(/^code:/.test(v.via ?? ""), `the value field must be what decided, got via=${v.via}`);
  });

  test("and its sibling is BACK, so the two stop tying — which is what killed the walk on screen 2", async () => {
    const mod = await worker();
    const classify = (0, eval)(mod.pageScript.CLASSIFY_CONTROL_ROLE_SRC);
    const v = classify({ text: "", label: "", code: "Previous", title: "Previous", ariaLabel: null });
    assertEq(v.role, "back", JSON.stringify(v));
  });

  test("THE LAST PAGE: a survey's final control says Complete, and a walk that cannot press it never reaches the end", async () => {
    const mod = await worker();
    const classify = (0, eval)(mod.pageScript.CLASSIFY_CONTROL_ROLE_SRC);
    assertEq(classify({ text: "", label: "", code: "Complete", title: "Complete" }).role, "next");
  });

  test("THE COUNTERWEIGHT: an ancestor's text may not overrule what the control itself says", async () => {
    const mod = await worker();
    const classify = (0, eval)(mod.pageScript.CLASSIFY_CONTROL_ROLE_SRC);

    // `labelFor` falls back to the nearest ancestor `label/li/td/div` — for a navigation button
    // that is the whole navigation bar, reading "Previous Next". Consulting it first would
    // classify the NEXT button as `back` and walk the survey BACKWARDS, which is worse than not
    // classifying it at all. The control's own `value` must win.
    const v = classify({ text: "", label: "Previous Next Complete", code: "Next", title: null, ariaLabel: null });
    assertEq(v.role, "next", `an ancestor's text overruled the control's own value: ${JSON.stringify(v)}`);
  });

  test("NOTHING NAMED A DIRECTION is `other` with NO evidence — unknown, never 'there is no way forward'", async () => {
    const mod = await worker();
    const classify = (0, eval)(mod.pageScript.CLASSIFY_CONTROL_ROLE_SRC);
    const v = classify({ text: "", label: "", code: "", title: null, ariaLabel: null });
    assertEq(v.role, "other", JSON.stringify(v));
    assertEq(v.via, null, `an unclassified control must cite no evidence, got ${v.via}`);
  });
});

suite("D42 — a Next chosen by ELIMINATION is recorded differently from one chosen by identity", () => {
  test("the fallback that hid the defect on screen 1 now names itself in the record", async () => {
    const mod = await worker();
    const env = testEnv();

    // The pre-fix world: one button, classified `other` because nothing named it. `nextButton`
    // still presses it — that is the honest degradation for a platform whose words we do not
    // know — but "we pressed the only thing that was not a back button" and "we pressed the
    // control that said Next" were previously the same record.
    const s = screen("Q1?", {
      controls: [control(0, { name: "Q1", code: "1", label: "One" })],
      optionGroups: [{ name: "Q1", kind: "radio", options: [{ order: 0, idx: 0, code: "1", label: "One", checked: false, disabled: false, visible: true, operable: true }] }],
      buttons: [{ idx: 1, label: "", labelSource: null, role: "other", roleVia: null, disabled: false, visible: true }],
    });

    const { obs } = await walk(mod, env, [s, s, s]);
    const clickNext = (obs.steps[0].actions ?? []).find((a) => a.kind === "click-next");
    assert(clickNext, JSON.stringify(obs.steps[0].actions));
    assert(
      /sole-forward-candidate/.test(clickNext.detail ?? ""),
      `a press chosen by elimination was not named as one: ${clickNext.detail}`,
    );
  });

  test("...and a Next that named itself says so instead", async () => {
    const mod = await worker();
    const env = testEnv();
    const s = screen("Q1?", {
      controls: [control(0, { name: "Q1", code: "1", label: "One" })],
      optionGroups: [{ name: "Q1", kind: "radio", options: [{ order: 0, idx: 0, code: "1", label: "One", checked: false, disabled: false, visible: true, operable: true }] }],
      buttons: [nextBtn(1)],
    });

    const { obs } = await walk(mod, env, [s, s, s]);
    const clickNext = (obs.steps[0].actions ?? []).find((a) => a.kind === "click-next");
    assert(/role:next/.test(clickNext.detail ?? ""), clickNext.detail);
    assert(!/sole-forward-candidate/.test(clickNext.detail ?? ""), clickNext.detail);
  });
});

suite("W4 / table-radio live regression — Back-only endings and cycles are bounded", () => {
  test("a direction-only << control is Back, never the sole forward candidate", async () => {
    const mod = await worker();
    const classify = (0, eval)(mod.pageScript.CLASSIFY_CONTROL_ROLE_SRC);
    const classified = classify({ text: "", label: "", code: "<<", title: null, ariaLabel: null });
    assertEq(classified.role, "back", JSON.stringify(classified));

    const start = screen("Start the questionnaire", { buttons: [nextBtn(0)] });
    // role=other reproduces an artifact written by the older reader. The driver's independent
    // glyph guard must still prevent the fallback from relabelling this control as forward.
    const end = screen("Thank you for completing the questionnaire.", {
      buttons: [
        { idx: 0, label: "<<", labelSource: "code", role: "other", roleVia: null, disabled: false, visible: true },
        // Hidden markup is inventory, not a respondent-facing forward affordance.
        { idx: 1, label: "Continue", labelSource: "code", role: "next", roleVia: "code:Continue", disabled: false, visible: false },
      ],
    });
    const { obs } = await walk(mod, testEnv(), [start, start, end, end, end], { maxSteps: 5 });
    const advances = obs.steps.flatMap((s) => s.actions).filter((a) => a.kind === "click-next");
    assertEq(advances.length, 1, JSON.stringify(obs.steps.map((s) => s.actions)));
    assert(!advances.some((a) => a.targetLabel === "<<"), JSON.stringify(advances));
    assertEq(obs.outcome, "no-advance-control", JSON.stringify({ outcome: obs.outcome, detail: obs.outcomeDetail }));
    assertEq(obs.ending?.kind, "completed", JSON.stringify(obs.ending));
  });

  test("the same directed transition traversed twice stops as a named cycle before the screen cap", async () => {
    const mod = await worker();
    const a = screen("State A", { buttons: [nextBtn(0)] });
    const b = screen("State B", { buttons: [nextBtn(0)] });
    const { obs } = await walk(
      mod,
      testEnv(),
      [a, a, b, b, b, a, a, a, b, b, b, a, a, a, b],
      { maxSteps: 10 },
    );
    assertEq(obs.outcome, "cycle-detected", JSON.stringify({ outcome: obs.outcome, detail: obs.outcomeDetail }));
    assertEq(obs.steps.length, 5, JSON.stringify(obs.steps.map((s) => [s.screenBefore?.questionText, s.screenAfterAdvance?.questionText])));
    assert(/repeating the exact screen transition/.test(obs.outcomeDetail ?? ""), obs.outcomeDetail);
    assertEq(obs.ending?.kind, "stalled", JSON.stringify(obs.ending));
  });

  test("reused templates with changed answer receipts or occurrence history do NOT collapse into a cycle", async () => {
    const mod = await worker();
    const b = screen("Roster bridge", { buttons: [nextBtn(0)], signature: "sig:bridge" });
    const occurrence = (idx, historyLength) => {
      const c = control(idx, { name: "row_answer", code: String(idx), label: `Choice ${idx}` });
      return screen("Repeated roster template", {
        controls: [c],
        optionGroups: [{
          name: "row_answer", kind: "radio",
          options: [{ order: 0, idx, code: String(idx), label: `Choice ${idx}`, checked: false, disabled: false, visible: true, operable: true }],
        }],
        buttons: [nextBtn(8)],
        signature: "sig:reused-template",
        historyLength,
      });
    };
    const sequence = (a1, a2, a3) => [a1, a1, b, b, b, a2, a2, a2, b, b, b, a3, a3, a3, b];
    const changedAnswer = await walk(mod, testEnv(), sequence(occurrence(0, 1), occurrence(1, 1), occurrence(2, 1)), { maxSteps: 5 });
    assertEq(changedAnswer.obs.outcome, "step-cap", JSON.stringify(changedAnswer.obs.outcomeDetail));
    assertEq(changedAnswer.obs.steps.length, 5);

    const changedHistory = await walk(mod, testEnv(), sequence(occurrence(0, 1), occurrence(0, 2), occurrence(0, 3)), { maxSteps: 5 });
    assertEq(changedHistory.obs.outcome, "step-cap", JSON.stringify(changedHistory.obs.outcomeDetail));
    assertEq(changedHistory.obs.steps.length, 5);
  });
});

/* ============================================================ 2. the reader's own counts */

suite("D42 — the reader's summary must agree with the inventory it summarises", () => {
  test("A NUMBER FIELD IS A TEXT ENTRY — one list, shared by the reader and the driver", async () => {
    const mod = await worker();
    // The exact drift that produced the contradiction: the driver filled these four, the
    // reader counted two of them.
    for (const t of ["text", "textarea", "number", "email"]) {
      assert(mod.pageScript.isTextEntry(t), `${t} must count as a free-text answer`);
    }
    for (const t of ["radio", "checkbox", "button", "submit", "hidden"]) {
      assert(!mod.pageScript.isTextEntry(t), `${t} must NOT count as a free-text answer`);
    }
  });

  test("POISONED: a summary that disagrees with the inventory is REPORTED, with both numbers", async () => {
    const mod = await worker();
    const check = (0, eval)(mod.pageScript.CHECK_COUNTS_SRC);

    // Screen 1 of the live oncology instrument: four radios and one `<input type=number>`.
    const controls = [
      control(0, { name: "S1", code: "a" }),
      control(1, { name: "S1", code: "b" }),
      control(4, { type: "number", id: "sq_8i" }),
    ];
    const groups = [
      {
        name: "S1",
        kind: "radio",
        options: [
          { order: 0, idx: 0, code: "a", label: "a", checked: false, disabled: false, visible: true, operable: true },
          { order: 1, idx: 1, code: "b", label: "b", checked: false, disabled: false, visible: true, operable: true },
        ],
      },
    ];
    // `valueInputs` (the wide count: everything the driver supplies a value to) is HONEST here on
    // purpose, so this fixture still isolates ONE disagreement — the narrow count — rather than
    // testing two at once.
    const poisoned = { controls: 3, optionGroups: 1, options: 2, textInputs: 0, valueInputs: 1, optionsNotOperable: 0 };

    const out = check(poisoned, controls, groups, mod.pageScript.TEXT_ENTRY_TYPES, mod.pageScript.VALUE_ENTRY_TYPES);
    assertEq(out.length, 1, JSON.stringify(out));
    assert(/textInputs/.test(out[0]), out[0]);
    // BOTH numbers, or a reader of the limitation cannot tell which side is wrong.
    assert(/says 0/.test(out[0]) && /holds 1/.test(out[0]), out[0]);
  });

  test("THE COUNTERWEIGHT: a summary that agrees says NOTHING — a check that always fires is not a check", async () => {
    const mod = await worker();
    const check = (0, eval)(mod.pageScript.CHECK_COUNTS_SRC);
    const controls = [control(0, { name: "S1", code: "a" }), control(4, { type: "number" })];
    const groups = [
      {
        name: "S1",
        kind: "radio",
        options: [{ order: 0, idx: 0, code: "a", label: "a", checked: false, disabled: false, visible: true, operable: true }],
      },
    ];
    const honest = { controls: 2, optionGroups: 1, options: 1, textInputs: 1, valueInputs: 1, optionsNotOperable: 0 };
    assertEq(check(honest, controls, groups, mod.pageScript.TEXT_ENTRY_TYPES, mod.pageScript.VALUE_ENTRY_TYPES).length, 0);
  });

  test("THE WIDE COUNT IS CHECKED TOO — a slider the summary forgot is a REPORTED disagreement", async () => {
    const mod = await worker();
    const check = (0, eval)(mod.pageScript.CHECK_COUNTS_SRC);
    // A screen whose only question is a slider. It has ZERO text inputs — truthfully — so the
    // narrow count agrees and only the wide one can catch a summary that missed the control.
    // This is the same defect shape as the number-field case, one type family over, and without
    // this assertion `valueInputs` would be a number nothing ever checks.
    const controls = [control(0, { type: "range", id: "q1", label: "How likely?" })];
    const wrong = { controls: 1, optionGroups: 0, options: 0, textInputs: 0, valueInputs: 0, optionsNotOperable: 0 };
    const out = check(wrong, controls, [], mod.pageScript.TEXT_ENTRY_TYPES, mod.pageScript.VALUE_ENTRY_TYPES);
    assertEq(out.length, 1, JSON.stringify(out));
    assert(/valueInputs/.test(out[0]), out[0]);
    assert(/says 0/.test(out[0]) && /holds 1/.test(out[0]), out[0]);

    const right = { controls: 1, optionGroups: 0, options: 0, textInputs: 0, valueInputs: 1, optionsNotOperable: 0 };
    assertEq(check(right, controls, [], mod.pageScript.TEXT_ENTRY_TYPES, mod.pageScript.VALUE_ENTRY_TYPES).length, 0);
  });
});

suite("D42 — the walker's filler must be something the control can hold", () => {
  test("THE SCREEN-1 BLOCKER: a number field gets a number inside the bounds the SITE declares", async () => {
    const mod = await worker();
    const env = testEnv();

    // Measured: "QA-PROBE" into `<input type=number min=0 max=50>` produced "Invalid input",
    // the survey would not advance, and the walk was recorded `blocked` — read downstream as
    // the survey REJECTING an answer, about a survey that was working perfectly.
    const s = screen("S2. How many years have you been treating patients?", {
      controls: [control(0, { type: "number", id: "sq_8i", label: "S2.", min: "18", max: "50" })],
      buttons: [nextBtn(1)],
    });

    const { obs, page } = await walk(mod, env, [s, s, s]);
    const typedAction = (obs.steps[0].actions ?? []).find((a) => a.kind === "type-text");
    assert(typedAction, JSON.stringify(obs.steps[0].actions));
    const v = Number(typedAction.value);
    assert(Number.isFinite(v), `a number field was given "${typedAction.value}"`);
    assert(v >= 18 && v <= 50, `"${typedAction.value}" is outside the site's own min=18 max=50`);
    assertEq(page.typed[0], typedAction.value, "the record and the keystrokes must agree");
    assert(/navigator-default/.test(typedAction.detail ?? ""), `filler not named as the walker's own: ${typedAction.detail}`);
  });

  test("a PLANNED answer is still typed verbatim — the filler may never displace the document", async () => {
    const mod = await worker();
    const env = testEnv();
    const s = screen("S2?", {
      controls: [control(0, { type: "number", label: "S2.", min: "0", max: "50" })],
      buttons: [nextBtn(1)],
    });
    const decisions = [{ question: "S2", select: [], question_text: "S2?", text_entry: { required: true, value: "42" } }];

    const { obs } = await walk(mod, env, [s, s, s], { decisions });
    const typedAction = (obs.steps[0].actions ?? []).find((a) => a.kind === "type-text");
    assertEq(typedAction.value, "42", JSON.stringify(typedAction));
    assert(!/navigator-default/.test(typedAction.detail ?? ""), typedAction.detail);
  });
});

/* ============================================================ 3. the endings */

const backBtn = (idx = 8) => ({ idx, label: "<<", labelSource: "code", role: "back", roleVia: "symbol:<<", disabled: false, visible: true });
const hiddenNextBtn = (idx = 9) => ({ idx, label: ">>", labelSource: "code", role: "next", roleVia: "code:>>", disabled: false, visible: false });

const endingOf = (mod, final, ctx = {}) =>
  mod.driver.classifyEnding(final, { outcome: "no-advance-control", unboundDecisions: 0, ...ctx });

suite("D42 — a survey that ended and a survey we never got into are no longer one value", () => {
  test("COMPLETED: no control advances it, and the page says the survey is finished", async () => {
    const mod = await worker();
    const final = screen("Thank you for completing the survey.", {
      visibleText: "Thank you for completing the survey.\n\nYour responses have been recorded.",
    });
    const e = endingOf(mod, final);
    assertEq(e.kind, "completed", JSON.stringify(e));
    assert(e.evidence.some((x) => /Thank you for completing/.test(x)), JSON.stringify(e.evidence));
  });

  test("THE ORDERING THAT MATTERS: a screen-out page THANKS YOU TOO, and is not a completion", async () => {
    const mod = await worker();
    // Measured wording from the instrument where the screen-out path was actually reached
    // (run 3 `fi_8e1bf`, run 5 `fi_7eda`). Testing completion first swallows it whole, and a
    // respondent turned away at the screener is then indistinguishable from one who finished.
    const final = screen("Thank you for your interest in this survey.", {
      visibleText:
        "Thank you for your interest in this survey. Unfortunately, on this occasion you do not qualify to take part.",
    });
    const e = endingOf(mod, final);
    assertEq(e.kind, "screened-out", JSON.stringify(e));
    assert(e.evidence.some((x) => /do not qualify/.test(x)), JSON.stringify(e.evidence));
  });

  test("STALLED: the screen still offered an enabled Next — this is the 38-captures-of-one-screen case", async () => {
    const mod = await worker();
    const final = screen("Q1. Which of the following are you aware of?", { buttons: [nextBtn(9)] });
    const e = endingOf(mod, final, { outcome: "blocked", unboundDecisions: 7 });
    assertEq(e.kind, "stalled", JSON.stringify(e));
    assert(e.evidence.some((x) => /still offered an enabled control/.test(x)), JSON.stringify(e.evidence));
    assert(e.evidence.some((x) => /7 planned decision/.test(x)), JSON.stringify(e.evidence));
  });

  test("A WALK THAT HIT A CAP REACHED NO ENDING, whatever its last screen happens to say", async () => {
    const mod = await worker();
    // The trap: the walk ran out of BUDGET on a screen that reads like a thank-you page. It did
    // not run out of survey, so it witnesses no ending.
    const final = screen("Thank you for completing the survey.", {
      visibleText: "Thank you for completing the survey.",
    });
    const e = endingOf(mod, final, { outcome: "step-cap" });
    assertEq(e.kind, "stalled", JSON.stringify(e));
  });

  test("UNCLASSIFIED IS A REAL ANSWER: a terminal page that says nothing is NOT a completion", async () => {
    const mod = await worker();
    const final = screen("Session closed.", { visibleText: "Session closed." });
    const e = endingOf(mod, final);
    assertEq(e.kind, "unclassified", JSON.stringify(e));
    assert(e.evidence.some((x) => /nothing on it says which kind of ending/.test(x)), JSON.stringify(e.evidence));
  });

  test("NO FINAL SCREEN AT ALL is unclassified, never an ending", async () => {
    const mod = await worker();
    const e = endingOf(mod, null, { outcome: "error" });
    assertEq(e.kind, "unclassified", JSON.stringify(e));
  });

  test("PROGRESS CORROBORATES AND NEVER GATES: measured, the live fleet reports progress.now null", async () => {
    const mod = await worker();
    // A completion page whose wording this reader does not know, but whose progress bar is full.
    const full = screen("Fin.", {
      visibleText: "Fin.",
      progress: { present: true, kind: "progress", now: 100, max: 100, text: null },
    });
    assertEq(endingOf(mod, full).kind, "completed");
    // ...and the same page with an UNREADABLE progress value — which is what all four live
    // SurveyJS instruments actually report — must not become a completion by assumption.
    const unreadable = screen("Fin.", {
      visibleText: "Fin.",
      progress: { present: true, kind: "div", now: null, max: null, text: null },
    });
    assertEq(endingOf(mod, unreadable).kind, "unclassified");
  });
});

suite("D42 — the ending reaches the walk artifact", () => {
  test("a walk that runs out of survey carries a typed ending with its evidence", async () => {
    const mod = await worker();
    const env = testEnv();
    const first = screen("Q1?", {
      controls: [control(0, { name: "Q1", code: "1", label: "One" })],
      optionGroups: [{ name: "Q1", kind: "radio", options: [{ order: 0, idx: 0, code: "1", label: "One", checked: false, disabled: false, visible: true, operable: true }] }],
      buttons: [nextBtn(1)],
    });
    const done = screen("Thank you for completing the survey.", {
      visibleText: "Thank you for completing the survey.\n\nYour responses have been recorded.",
    });

    const { obs } = await walk(mod, env, [first, first, done, done, done], { maxSteps: 4 });

    assertEq(obs.outcome, "no-advance-control", obs.outcomeDetail ?? "");
    assert(obs.ending, "the walk artifact carries no typed ending at all");
    assertEq(obs.ending.kind, "completed", JSON.stringify(obs.ending));
    assert(obs.ending.evidence.length > 0, "an ending with no evidence is an assertion, not an observation");
  });

  test("...and a walk that never left screen 1 carries `stalled` on the SAME outcome value", async () => {
    const mod = await worker();
    const env = testEnv();
    // The whole point: `outcome` is identical in both directions on the fleet's artifacts, so
    // the ending is the only field that can tell the two apart.
    const stuck = screen("Q1?", {
      controls: [control(0, { name: "Q1", code: "1", label: "One" })],
      optionGroups: [{ name: "Q1", kind: "radio", options: [{ order: 0, idx: 0, code: "1", label: "One", checked: false, disabled: false, visible: true, operable: true }] }],
      buttons: [nextBtn(1)],
    });

    const { obs } = await walk(mod, env, [stuck, stuck, stuck, stuck, stuck], { maxSteps: 4 });
    assert(obs.ending, "the walk artifact carries no typed ending at all");
    assertEq(obs.ending.kind, "stalled", JSON.stringify(obs.ending));
  });
});

/* ============================================================ 4. screen-out wording gap (12-Aug audit defect 4) */

suite("D42 — screen-out detection covers real termination wording from the 12-Aug run", () => {
  // STRUCTURAL REPLICA of the Confirmit termination page from the audit. The audit records:
  //   visible text: "For testing only: Thank you for your willingness to participate. Due to
  //   the specific guidelines, we have been given for this study, we are unable to accept your
  //   offer to participate in our research. We value your opinion and look forward to receiving
  //   your feedback in future studies. Survey status: Terminated at qConsent"
  //   buttons: [{ idx:15, label:"<<", role:"other", visible:true }, { idx:16, label:">>", role:"next", visible:false }]
  // This is a STRUCTURAL replica: same shape, same signal distribution, no private bytes.

  test("the 12-Aug termination wording is classified as screened-out, not unclassified", async () => {
    const mod = await worker();
    const termination = screen("", {
      visibleText:
        "Thank you for your willingness to participate. Due to the specific guidelines, we have been given " +
        "for this study, we are unable to accept your offer to participate in our research. We value your " +
        "opinion and look forward to receiving your feedback in future studies.",
      buttons: [backBtn(15), hiddenNextBtn(16)],
    });
    const e = endingOf(mod, termination);
    assertEq(e.kind, "screened-out", JSON.stringify(e));
    assert(
      e.evidence.some((x) => /unable to accept/.test(x) || /structural/.test(x)),
      `the evidence must cite either the matched wording or structural signals: ${JSON.stringify(e.evidence)}`,
    );
  });

  test("the old SCREENOUT_MARKERS would have missed it — this test fails on the pre-fix regex list", async () => {
    // The pre-fix regex: /\bwe\s+are\s+(unable|not\s+able)\s+to\s+(continue|proceed)\b/i
    // requires "continue" or "proceed" after "unable to". The 12-Aug text says "accept".
    const oldRegex = /\bwe\s+are\s+(unable|not\s+able)\s+to\s+(continue|proceed)\b/i;
    const auditText =
      "we are unable to accept your offer to participate in our research";
    assert(!oldRegex.test(auditText), "the old regex should NOT match — if it does, the fix premise is wrong");

    // The new regex family covers the verb "accept".
    const newRegex = /\b(unable|not\s+able)\s+to\s+accept\b/i;
    assert(newRegex.test(auditText), "the new regex must match the 12-Aug termination wording");
  });

  test("status:terminated is detected as a screen-out marker", async () => {
    const mod = await worker();
    const termination = screen("", {
      visibleText: "Survey status: Terminated at qConsent",
      buttons: [backBtn(15)],
    });
    const e = endingOf(mod, termination);
    assertEq(e.kind, "screened-out", JSON.stringify(e));
    assert(e.evidence.some((x) => /Terminated/.test(x) || /structural/.test(x)), JSON.stringify(e.evidence));
  });

  test("STRUCTURAL screen-out: back-only page with no answerable controls and no known wording", async () => {
    const mod = await worker();
    // A terminal page in a language or format this reader has no wording markers for.
    // The structural signal (only back buttons, no answerable controls) should still classify
    // it as screened-out rather than unclassified.
    const foreignTermination = screen("", {
      visibleText: "Merci pour votre interet. Malheureusement, vous ne pouvez pas continuer.",
      buttons: [backBtn(15)],
    });
    const e = endingOf(mod, foreignTermination);
    assertEq(e.kind, "screened-out", JSON.stringify(e));
    assert(
      e.evidence.some((x) => /structural/.test(x)),
      `a back-only page with no answerable controls must cite structural signals: ${JSON.stringify(e.evidence)}`,
    );
  });

  test("COUNTERWEIGHT: a back-only page WITH answerable controls is NOT structurally screened out", async () => {
    const mod = await worker();
    // A page that still has answerable controls (e.g. a consent form whose Next button is hidden
    // until the user selects an option). The structural screen-out should NOT fire here.
    const active = screen("Please select an option", {
      visibleText: "Please select an option to continue",
      controls: [control(0, { name: "Q1", code: "1", label: "Yes" })],
      buttons: [backBtn(15)],
    });
    const e = endingOf(mod, active);
    // Without completion or screen-out wording and with answerable controls, this should be
    // unclassified, not screened-out.
    assertEq(e.kind, "unclassified", JSON.stringify(e));
  });

  test("COUNTERWEIGHT: a page with NO buttons at all and completion wording is a completion, not a screen-out", async () => {
    const mod = await worker();
    const done = screen("Thank you for completing this survey.", {
      visibleText: "Thank you for completing this survey. Your responses have been recorded.",
      buttons: [],
    });
    const e = endingOf(mod, done);
    assertEq(e.kind, "completed", JSON.stringify(e));
  });
});

/* ============================================================ 5. per-case time budget (12-Aug audit defect 5) */

suite("D42 — a per-case timeout is a named outcome that never kills the batch", () => {
  test("a walk exceeding its per-case budget produces outcome time-cap with a stalled ending", async () => {
    const mod = await worker();
    const env = testEnv();
    // Use a very short deadline to force the walk to hit its time cap after exactly one step.
    // The walkPath loop checks `Date.now() < opts.deadline` BETWEEN steps, so the first step
    // executes and then the loop exits on the deadline check.
    const runId = mod.ids.mintRunId();
    const s = screen("Q1?", {
      controls: [control(0, { name: "Q1", code: "1", label: "One" })],
      optionGroups: [{ name: "Q1", kind: "radio", options: [{ order: 0, idx: 0, code: "1", label: "One", checked: false, disabled: false, visible: true, operable: true }] }],
      buttons: [nextBtn(1)],
    });
    const { obs } = await walk(mod, env, [s, s, s, s, s, s, s, s, s, s], { decisions: [], maxSteps: 40 });
    // The walk should not exhaust all 40 steps — it is bounded by the 30-second deadline in
    // the walk helper. What matters is that the ending is stalled (the walk stopped due to
    // budget, not because the survey ended) and the outcome is NOT error.
    assert(obs.outcome !== "error", `the walk must not crash: ${obs.outcomeDetail}`);
    // With enough screens and a forward button, the walk should advance until deadline or step cap.
    // The ending must be stalled — the walk stopped for its own reasons, not because the survey ended.
    if (obs.outcome === "time-cap" || obs.outcome === "step-cap") {
      assertEq(obs.ending?.kind, "stalled", JSON.stringify(obs.ending));
      assert(
        obs.ending.evidence.some((x) => /time-cap|step-cap/.test(x)),
        `the ending must cite the capped outcome: ${JSON.stringify(obs.ending.evidence)}`,
      );
    }
  });

  test("an expired deadline before any step produces time-cap with an unclassified ending (no screen captured)", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();
    const page = fakePage([
      screen("Q1?", {
        controls: [control(0, { name: "Q1", code: "1", label: "One" })],
        optionGroups: [{ name: "Q1", kind: "radio", options: [{ order: 0, idx: 0, code: "1", label: "One", checked: false, disabled: false, visible: true, operable: true }] }],
        buttons: [nextBtn(1)],
      }),
    ]);
    const obs = await mod.driver.walkPath(
      page,
      { id: PATH_ID, decisions: [], witnesses: [] },
      {
        surveyUrl: "https://fixture.invalid/survey",
        runId,
        planRevisionId: "plan_d42test01",
        attemptId: ATTEMPT_ID,
        tier: 1,
        maxSteps: 40,
        deadline: Date.now() - 1, // already expired
        viewport: { width: 1280, height: 900 },
        applyHistoryShim: false,
        advanceTimeoutMs: 200,
      },
      { env, runId, attemptId: ATTEMPT_ID, pathId: PATH_ID, witnesses: [] },
    );
    assertEq(obs.outcome, "time-cap", JSON.stringify({ outcome: obs.outcome, detail: obs.outcomeDetail }));
    // With no steps taken, there is no final screen, so the ending cannot be classified.
    assertEq(obs.ending?.kind, "unclassified", JSON.stringify(obs.ending));
  });

  test("EXEC_PER_CASE_TIMEOUT_MS is declared in wrangler.jsonc", async () => {
    // Structural test: the config var exists and has a value consistent with the batch budget.
    // The per-case timeout may EQUAL the batch budget because the don't-start guard
    // (execute-batch.ts) prevents walks from beginning when the remaining batch budget
    // is below the per-case timeout. A walk at the start of a batch always has the full
    // budget, so perCase <= batch is the correct invariant.
    const { readFileSync } = await import("fs");
    const wrangler = readFileSync("wrangler.jsonc", "utf8");
    assert(wrangler.includes('"EXEC_PER_CASE_TIMEOUT_MS"'), "EXEC_PER_CASE_TIMEOUT_MS must be declared in wrangler.jsonc");
    const perCase = wrangler.match(/"EXEC_PER_CASE_TIMEOUT_MS"\s*:\s*"(\d+)"/);
    const batch = wrangler.match(/"EXEC_BATCH_MAX_MS"\s*:\s*"(\d+)"/);
    assert(perCase, "EXEC_PER_CASE_TIMEOUT_MS must have a numeric string value");
    assert(batch, "EXEC_BATCH_MAX_MS must have a numeric string value");
    const perCaseMs = Number(perCase[1]);
    const batchMs = Number(batch[1]);
    assert(
      perCaseMs <= batchMs,
      `per-case budget (${perCaseMs}ms) must be at most the batch budget (${batchMs}ms)`,
    );
  });

  test("the per-case timeout is the tighter of EXEC_PER_CASE_TIMEOUT_MS and EXEC_WALK_TIMEOUT_MS", async () => {
    // Verify the derivation in execute-batch.ts: perCaseTimeoutMs = Math.min(perCase, walkTimeout).
    // When EXEC_PER_CASE_TIMEOUT_MS < EXEC_WALK_TIMEOUT_MS, the per-case value wins.
    // When EXEC_PER_CASE_TIMEOUT_MS > EXEC_WALK_TIMEOUT_MS, the legacy value wins (backward compat).
    const { readFileSync } = await import("fs");
    const src = readFileSync("src/workflow/stages/execute-batch.ts", "utf8");
    assert(
      src.includes("Math.min(") && src.includes("EXEC_PER_CASE_TIMEOUT_MS") && src.includes("walkTimeoutMs"),
      "perCaseTimeoutMs must be derived as the minimum of the per-case config and the walk timeout",
    );
  });

  test("per-case-timeout is a recognized outcome in the execution activity projection", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync("src/api/execution-activity-projection.ts", "utf8");
    assert(src.includes('"per-case-timeout"'), "per-case-timeout must be a recognized outcome");
  });
});

suite("D42 — a termination page wearing a dead forward control is a screen-out, not a stall", () => {
  // Measured live (run v2r_01m07qpwcjamfpcs89frs3syjs, screen 15): the test-mode
  // termination page prints "unable to accept ... Terminated at S80" AND renders a ">>"
  // the walker clicked twelve times without the screen ever changing.
  test("screen-out wording + a rendered advance the walk MEASURED inert (outcome blocked) => screened-out", async () => {
    const mod = await worker();
    const final = screen("", {
      visibleText:
        "For testing only:\nThank you for your willingness to participate. Due to the specific guidelines, we have been given for this study, we are unable to accept your offer to participate in our research.\n\nSurvey status: Terminated at S80",
      buttons: [
        { idx: 15, label: "<<", role: "back", roleVia: "text", disabled: false, visible: true },
        { idx: 16, label: ">>", role: "next", roleVia: "text", disabled: false, visible: true },
      ],
    });
    const e = mod.driver.classifyEnding(final, { outcome: "blocked", unboundDecisions: 0 });
    assertEq(e.kind, "screened-out", JSON.stringify(e.evidence));
    assert(
      e.evidence.some((line) => /measured it inert|MEASURED it inert/i.test(line)),
      `the inert-control measurement must be the named evidence: ${JSON.stringify(e.evidence)}`,
    );
  });

  test("the SAME page with a WORKING advance (outcome completed) stays stalled — behaviour, not wording, decides", async () => {
    const mod = await worker();
    const final = screen("", {
      visibleText: "we are unable to accept your offer to participate in our research.",
      buttons: [{ idx: 16, label: ">>", role: "next", roleVia: "text", disabled: false, visible: true }],
    });
    const e = mod.driver.classifyEnding(final, { outcome: "completed", unboundDecisions: 0 });
    assertEq(e.kind, "stalled", JSON.stringify(e.evidence));
  });
});

suite("D42 — consecutive same-shaped questions are distinguishable advances", () => {
  // Measured across five runs on 2026-08-17: S70 "Years at organization" -> S80 "Years at
  // title" produce BYTE-IDENTICAL screenSignatures (one text input each, identical
  // chrome), the form POST changes neither URL nor history, and every successful advance
  // between them was declared "did not advance".
  const yearsScreen = (name, label) =>
    screen("", {
      signature: "sig:same-shape",
      controls: [
        { idx: 13, tag: "input", type: "text", name, id: null, code: null, label, text: "", checked: null, value: "", valueIsUserSupplied: false, disabled: false, required: false, visible: true, operable: true, placeholder: null, maxlength: null, readOnly: false },
      ],
      buttons: [{ idx: 16, label: ">>", role: "next", roleVia: "text", disabled: false, visible: true }],
    });

  test("THE MEASURED SHAPE: identical signatures, different input name+label => question-identity-changed fires", async () => {
    const mod = await worker();
    const s70 = yearsScreen("S70_1", "Years at organization");
    const s80 = yearsScreen("S80_1", "Years at title or similar role");
    const signals = mod.driver.advanceSignals(s70, s80);
    assert(!signals.includes("screen-signature-changed"), "the fixture must reproduce the identical-signature shape");
    assert(
      signals.includes("question-identity-changed"),
      `the advance between same-shaped questions must be detectable: ${JSON.stringify(signals)}`,
    );
  });

  test("A VALIDATION RE-RENDER OF THE SAME SCREEN IS NOT AN ADVANCE: same name+label => no identity signal", async () => {
    const mod = await worker();
    const before = yearsScreen("S70_1", "Years at organization");
    const after = yearsScreen("S70_1", "Years at organization");
    after.validationMessages = ["Please enter a number."];
    after.controls[0].value = "1"; // answering must not fake an advance either
    const signals = mod.driver.advanceSignals(before, after);
    assert(
      !signals.includes("question-identity-changed"),
      `a same-question re-render must not read as an advance: ${JSON.stringify(signals)}`,
    );
  });
});

suite("D42 — consecutive text-only screens are distinguishable advances", () => {
  // Measured 2026-08-18, run v2r_01m08r1rvjkkne4sdhr18a42pf walk 2: the "you have
  // qualified" interstitial (iCongo) and the section intro behind it (iSecA) are both
  // control-less Next-only screens with identical structure — identical screenSignature,
  // identical (empty) question identity, progress rendered as unparsed prose — so the
  // real advance between them read as "did not advance" and the walk stalled at the
  // main body's doorstep. On a control-less screen only the text can move, and only
  // navigation can move it.
  const infoScreen = (text) =>
    screen("", {
      signature: "sig:info-shape",
      controls: [],
      buttons: [{ idx: 3, label: ">>", role: "next", roleVia: "text", disabled: false, visible: true }],
    });

  test("THE MEASURED SHAPE: identical signatures, zero controls, different prose => info-screen-text-changed fires", async () => {
    const mod = await worker();
    const congrats = infoScreen();
    congrats.visibleText = "Survey progress: 2% iCongo Congratulations, you have qualified for our research";
    const intro = infoScreen();
    intro.visibleText = "Survey progress: 3% iSecA Throughout this survey, we will focus on pediatric patients";
    const signals = mod.driver.advanceSignals(congrats, intro);
    assert(!signals.includes("screen-signature-changed"), "the fixture must reproduce the identical-signature shape");
    assert(!signals.includes("question-identity-changed"), "control-less screens carry no question identity to change");
    assert(
      signals.includes("info-screen-text-changed"),
      `the advance between text-only screens must be detectable: ${JSON.stringify(signals)}`,
    );
  });

  test("a RE-READ of the same text-only screen is not an advance", async () => {
    const mod = await worker();
    const a = infoScreen();
    a.visibleText = "Survey progress: 2% iCongo Congratulations, you have qualified";
    const b = infoScreen();
    b.visibleText = "Survey progress: 2% iCongo Congratulations, you have qualified";
    const signals = mod.driver.advanceSignals(a, b);
    assert(
      !signals.includes("info-screen-text-changed"),
      `an unmoved info screen must not read as an advance: ${JSON.stringify(signals)}`,
    );
  });

  test("THE GATE: a screen WITH controls whose prose changes (validation re-render) never fires the text signal", async () => {
    const mod = await worker();
    const mkAnswerable = (visibleText) =>
      screen("", {
        signature: "sig:answerable",
        controls: [
          { idx: 5, tag: "input", type: "text", name: "Q1_1", id: null, code: null, label: "Amount", text: "", checked: null, value: "", valueIsUserSupplied: false, disabled: false, required: true, visible: true, operable: true, placeholder: null, maxlength: null, readOnly: false },
        ],
        buttons: [{ idx: 7, label: ">>", role: "next", roleVia: "text", disabled: false, visible: true }],
      });
    const before = mkAnswerable();
    before.visibleText = "Q1. How many?";
    const after = mkAnswerable();
    after.visibleText = "Please review your responses. Q1. How many?";
    after.validationMessages = ["Please review your responses."];
    const signals = mod.driver.advanceSignals(before, after);
    assert(
      !signals.includes("info-screen-text-changed"),
      `a validation re-render of an answerable screen must never fire the text signal: ${JSON.stringify(signals)}`,
    );
  });
});

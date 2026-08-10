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

const screen = (text, { controls = [], optionGroups = [], buttons, progress, visibleText } = {}) => ({
  at: "2026-08-08T00:05:00.000Z",
  url: "https://fixture.invalid/survey",
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
  screenSignature: `sig:${text}`,
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

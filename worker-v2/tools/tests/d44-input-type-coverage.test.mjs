/**
 * D44 — THE WALKER'S FILLER WAS A BOUNDARY PROBE, AND HALF THE INPUT TYPES WERE NEVER FILLED.
 *
 * BOTH HALVES WERE MEASURED against the six live branching targets and against Chrome, not
 * reasoned about.
 *
 * ============ 1. "THE LOWEST LEGAL VALUE" IS THE ONE VALUE A SCREENER CUTS AT ============
 *
 * `defaultTextFor` gave a numeric control `1`, raised to `min` when `min` was higher. That is not
 * a neutral filler — it is a boundary probe, and a screener exists to cut at the boundary. Two of
 * the six live surveys screened the walk out on the harness's own answer:
 *
 *     s2-screener      S1 "What is your age?"      min=0 max=99, terminate if < 18  -> answered 1
 *     s6-kitchen-sink  S2 "years treating RA"      min=0 max=50, terminate if < 2   -> answered 1
 *
 * s2 stopped after TWO screens of ~10 with `ending: screened-out`, and the clean/flawed
 * experiment that depended on it returned 0 of 3 seeded defects. Nothing was broken. The walker
 * had volunteered that it was one year old.
 *
 * The repair is the midpoint of the range THE SITE declares, snapped to the site's own step grid:
 * with no information, the centre commits to least, and an extreme should only ever be chosen on
 * purpose by a probe the plan asked for. IT IS STILL A GUESS AND IT IS NOT TUNED TO THIS CORPUS —
 * the counterexample is in the same survey and is asserted below: s2's S4 (min=0 max=31,
 * terminate at >= 15) is screened out by the midpoint too. No constant passes every screener.
 * What makes that acceptable is the other half of this change: the walk NAMES how many of its
 * answers it invented, so a screen-out reached on a filler can never be read as a fact about the
 * survey.
 *
 * ============ 2. THE TYPES THE DRIVER NEVER TOUCHED ============
 *
 * Measured in Chrome (`el.type` reflection and value sanitisation), the true gap was:
 *
 *   - `tel` `url` `search`                        never filled; they hold typed text fine.
 *   - `range` `date` `time` `month` `week`        never filled, and they CANNOT be typed into:
 *     `datetime-local` `color`                    assigning "QA-PROBE" is discarded outright and
 *                                                 a range ignores keystrokes altogether.
 *   - `email`                                     filled with "QA-PROBE", which STICKS in `.value`
 *                                                 and then fails the control's own constraint
 *                                                 validation — a required email field blocked the
 *                                                 submit and the survey got the blame.
 *   - `password` `file`                           must never be silently skipped.
 *
 * NOT a gap, and asserted here because it looks like one: `<input>` with no type and
 * `<input type="totally-bogus">` both reflect `el.type === "text"`, so they have always been
 * filled.
 *
 * ============ 3. THE COUNTERWEIGHT, WHICH IS THE LOAD-BEARING HALF ============
 *
 * Teaching the walker more types makes it likelier to advance. A driver that reported success on
 * a field it never satisfied would pass any "it advances now" test and destroy the product. So a
 * control the walker will NOT answer (a password) or CANNOT answer (a file input) is recorded
 * with `ok: false`, named on the step, lifted to the walk, and — when the walk then goes nowhere
 * — spelled out in `outcomeDetail`, which otherwise reads exactly like a normal ending.
 *
 * The DOM half of all of this is proved in a real browser: `node tools/live-walk.mjs` drives the
 * production `walkPath` against the six live branching targets, and a data:-URL fixture proves a
 * required password field still stalls the walk and still says why.
 *
 * Evidence these can fail: `tools/mutate-input-coverage.mjs`.
 */

import { assert, assertEq, assertThrows, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { READ_SCREEN } from "../../src/browser/page-script.ts";

const ATTEMPT_ID = "att_d44000000001";
const PATH_ID = "path_d44000000001";

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

const selectControl = (idx, label, options, rest = {}) => ({
  ...control(idx, { type: "select", label }),
  tag: "select",
  multiple: false,
  value: options.find((o) => o.selected)?.code ?? "",
  options: options.map((o, order) => ({
    order,
    code: String(o.code),
    label: String(o.label),
    selected: !!o.selected,
    disabled: !!o.disabled,
    hidden: !!o.hidden,
    placeholder: !!o.placeholder,
  })),
  ...rest,
});

const nextBtn = (idx) => ({ idx, label: "Next", role: "next", roleVia: "text:Next", disabled: false, visible: true });

const screen = (text, { controls = [], optionGroups = [], buttons, signature } = {}) => ({
  at: "2026-08-09T00:05:00.000Z",
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
  grid: null,
  readerLimitations: [],
  buttons: buttons === undefined ? [nextBtn(controls.length)] : buttons,
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

/**
 * A page that serves scripted screens and RECORDS every route separately — keystrokes through
 * `type()`, assignments through the `setValueScript` string. The two must never be confusable:
 * reporting a slider as typed when nothing was typed is the failure this file exists to prevent.
 *
 * `setRejects` makes the page refuse the assignment, which is how a real `<input type=date>`
 * behaves when handed a value it cannot parse.
 */
function fakePage(reads, { setRejects = false, selectReadback = "exact", choiceReadback = "exact" } = {}) {
  const queue = [...reads];
  let last = reads[0] ?? null;
  const typed = [];
  const set = [];
  const clicks = [];
  const selections = [];
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
    selections,
    async goto() {},
    async evaluate(script) {
      if (typeof script !== "string") return { ok: true };
      if (script.includes("screenSignature")) {
        if (queue.length > 0) last = queue.shift();
        return last;
      }
      // The delayed-verification probe reads the value the mask let stand. This stub's
      // controls have no mask: whatever the last set assigned is what the probe sees.
      if (script.includes("W4_READ_VALUE")) {
        return { got: setRejects ? "" : (set.length > 0 ? set[set.length - 1].value : "") };
      }
      // The setValueScript body is recognisable by the events it dispatches; capture the value
      // it was built with so a test can assert WHAT was assigned, not merely that something was.
      const m = /el\.value = ("(?:[^"\\]|\\.)*");/.exec(script);
      if (m && script.includes("change")) {
        const value = JSON.parse(m[1]);
        set.push({ value });
        return setRejects
          ? { ok: false, reason: "value-rejected-by-control", got: "" }
          : { ok: true, reason: null, got: value };
      }
      if (script.includes("W4_NATIVE_SELECT_SCOPED_READBACK")) {
        const idx = Number(/document\.querySelectorAll\(SEL\)\[(\d+)\]/.exec(script)?.[1]);
        const order = JSON.parse(/const expectedOrder = ([^;]+);/.exec(script)?.[1] ?? "null");
        const code = JSON.parse(/const expectedCode = ([^;]+);/.exec(script)?.[1] ?? "null");
        const label = JSON.parse(/const expectedLabel = ([^;]+);/.exec(script)?.[1] ?? "null");
        selections.push({ idx, order, code, label });
        if (selectReadback === "missing") return { ok: true, reason: null, got: null, changed: true };
        if (selectReadback === "foreign") {
          return { ok: true, reason: null, got: { order, code: `foreign:${code}`, label }, changed: true };
        }
        return { ok: true, reason: null, got: { order, code, label }, changed: true };
      }
      if (script.includes("W4_NATIVE_CHOICE_SCOPED_READBACK")) {
        const idx = Number(/const expectedIdx = (\d+);/.exec(script)?.[1]);
        if (choiceReadback === "missing") return null;
        if (choiceReadback === "foreign") {
          return { idx, type: "radio", name: "agreement", checked: false, checkedGroupIdxs: [] };
        }
        return { idx, type: "radio", name: "agreement", checked: true, checkedGroupIdxs: [idx] };
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
      planRevisionId: "plan_d44test01",
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

function readScreenInTinyDom({ hiddenWidget = false, secondSelected = false } = {}) {
  class FakeNode {
    constructor(tag, attrs = {}, text = "") {
      this.tagName = tag.toUpperCase();
      this.attrs = attrs;
      this.textContent = text;
      this.parentElement = null;
      this.children = [];
      this.id = attrs.id ?? "";
      this.name = attrs.name ?? "";
      this.type = attrs.type ?? tag;
      this.value = attrs.value ?? "";
      this.disabled = !!attrs.disabled;
      this.required = !!attrs.required;
      this.readOnly = false;
      this.multiple = false;
      this.size = 0;
    }
    getAttribute(name) { return Object.hasOwn(this.attrs, name) ? String(this.attrs[name]) : null; }
    getClientRects() { return hiddenWidget && this.attrs.role === "combobox" ? [] : [1]; }
    getBoundingClientRect() { return this.getClientRects().length ? { width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20 } : { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }; }
    contains(node) { return node === this || this.children.includes(node); }
    closest() { return this; }
  }
  const heading = new FakeNode("h2", {}, "Question");
  const select = new FakeNode("select", { name: "q", required: true });
  select.options = [
    Object.assign(new FakeNode("option", { value: "" }, "Choose"), { label: "Choose", value: "", selected: !secondSelected, hidden: false, disabled: false }),
    Object.assign(new FakeNode("option", { value: "b" }, "Beta"), { label: "Beta", value: "b", selected: secondSelected, hidden: false, disabled: false }),
  ];
  for (const option of select.options) option.parentElement = select;
  const combo = new FakeNode("div", { role: "combobox", "aria-label": "Hidden combo" }, "Hidden combo");
  const nodes = [select, combo];
  const document = {
    title: "fixture",
    body: Object.assign(new FakeNode("body", {}, "Question Choose Beta"), { innerText: "Question Choose Beta" }),
    documentElement: { clientWidth: 1000, clientHeight: 800 },
    querySelectorAll(selector) {
      if (selector === "label") return [];
      if (selector.includes("input, select")) return nodes;
      if (selector.includes("h1, h2")) return [heading];
      return [];
    },
    querySelector() { return null; },
    getElementById() { return null; },
    elementFromPoint() { return select; },
  };
  const window = { innerWidth: 1000, innerHeight: 800, getComputedStyle() { return { display: "block", visibility: "visible", opacity: "1" }; }, __qaErrors: [] };
  return Function("window", "document", "location", `return (${READ_SCREEN})`)(window, document, { href: "https://fixture.invalid" });
}

/**
 * A read sequence in which the survey ACTUALLY ADVANCES, so the walk applies the screen once.
 *
 * With `[s, s, s]` the signature never changes, the walker treats that as blocked and runs its
 * recovery pass — a second, legitimate application of the same screen. That is correct driver
 * behaviour and it makes "how many keystrokes reached the page" the wrong question to ask of a
 * whole-walk recording. Where a test is about the ROUTE a control is answered by, it uses this.
 */
const advancing = (s) => [s, s, screen("Thank you for completing the survey.", { controls: [], buttons: [] })];

/* ============================================================ 1. the value derivation */

suite("D44 — the navigator's filler is the middle of the site's own range, not its edge", () => {
  test("THE s2-screener DEFECT: an age field declared 0..99 is answered 50, NOT 1", async () => {
    const mod = await worker();
    const v = mod.driver.navigatorValueFor({ type: "number", min: "0", max: "99" });
    // `1` here is the whole measured failure: the walk answered "I am one year old", the
    // screener terminated it under its documented under-18 rule, and two screens of a ten-screen
    // survey were all the experiment ever saw.
    assertEq(v.value, "50", `an age field declared 0..99 was answered "${v.value}"`);
    assertEq(v.via, "type");
    assert(/midpoint/.test(v.how), v.how);
  });

  test("THE HONEST COUNTEREXAMPLE: the midpoint is screened out too, and is not tuned to this corpus", async () => {
    const mod = await worker();
    // s2-screener S4: min=0 max=31, and the survey terminates at >= 15 (a chronic-migraine
    // quota). The midpoint lands ON the wrong side of that. If a future edit ever "fixes" this
    // by picking a fraction of the range that clears this corpus's thresholds, THIS assertion is
    // what fails — which is the point. No constant passes every screener, and a value chosen
    // because it happened to pass ours is the hard-anchoring CLAUDE.md names as a reference
    // failure. The walk's honesty comes from naming its fillers, never from out-guessing rules.
    const v = mod.driver.navigatorValueFor({ type: "number", min: "0", max: "31" });
    assertEq(v.value, "16");
    assert(Number(v.value) >= 15, `the corpus counterexample has been tuned away: ${v.value}`);
  });

  test("THE SITE'S STEP GRID IS THE SITE'S — a midpoint may not land between its own points", async () => {
    const mod = await worker();
    // A fraction here is not a rounding nicety: the branching engine answers a non-integer with
    // "Please enter a whole number." and refuses to advance, which the walk records as the
    // survey rejecting an answer.
    assertEq(mod.driver.navigatorValueFor({ type: "number", min: "0", max: "99" }).value, "50");
    assertEq(mod.driver.navigatorValueFor({ type: "number", min: "3", max: "7", step: "0.5" }).value, "5");
    assertEq(mod.driver.navigatorValueFor({ type: "number", min: "0", max: "10", step: "4" }).value, "4");
    // `step="any"` is the site saying there is no grid — the one case a fraction is legal.
    assertEq(mod.driver.navigatorValueFor({ type: "number", min: "0", max: "1", step: "any" }).value, "0.5");
  });

  test("A MIDPOINT NEEDS TWO ENDS — one bound or none keeps the long-standing filler, and says so", async () => {
    const mod = await worker();
    assertEq(mod.driver.navigatorValueFor({ type: "number" }).value, "1");
    assertEq(mod.driver.navigatorValueFor({ type: "number", min: "18" }).value, "18");
    assertEq(mod.driver.navigatorValueFor({ type: "number", max: "0" }).value, "0");
    assert(/two ends|no bounds/.test(mod.driver.navigatorValueFor({ type: "number" }).how));
  });

  test("EVERY TYPE A RESPONDENT CAN ANSWER HAS A RULE, and each says which route it takes", async () => {
    const mod = await worker();
    const rule = (type, extra = {}) => mod.driver.navigatorValueFor({ type, ...extra });

    // Typed. `email` is the live defect the fleet never reported: "QA-PROBE" is ACCEPTED into an
    // email input's value and then fails its constraint validation, so a required email field
    // blocks the submit and the survey is recorded as rejecting the answer.
    assert(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rule("email").value), `not a valid address: ${rule("email").value}`);
    assert(/^https?:\/\/\S+$/.test(rule("url").value), rule("url").value);
    assert(/^\+?[0-9]{6,}$/.test(rule("tel").value), rule("tel").value);
    for (const t of ["text", "textarea", "search", "email", "url", "tel", "number"]) {
      assertEq(rule(t).via, "type", `${t} must be delivered as keystrokes`);
    }

    // SET, never typed — measured: these discard inserted text, and a range ignores keys entirely.
    for (const t of ["range", "date", "time", "month", "week", "datetime-local", "color"]) {
      const r = rule(t);
      assert(r, `no navigator-default rule for ${t}`);
      assertEq(r.via, "set", `${t} must be SET, not typed`);
      assert(r.value.length > 0, `${t} got an empty value`);
    }
    // A range declares nothing and still has a range: HTML's defaults are 0..100 step 1.
    assertEq(rule("range").value, "50");
    assertEq(rule("range", { min: "1", max: "5" }).value, "3");
    assert(/^\d{4}-\d{2}-\d{2}$/.test(rule("date").value), rule("date").value);
    assertEq(rule("date", { min: "2020-01-01", max: "2020-01-11" }).value, "2020-01-06");
    assert(/^#[0-9a-f]{6}$/i.test(rule("color").value), rule("color").value);
  });

  test("THE REFUSALS ARE PERMANENT AND NAMED — password and file have no value, by design", async () => {
    const mod = await worker();
    assertEq(mod.driver.navigatorValueFor({ type: "password" }), null);
    assertEq(mod.driver.navigatorValueFor({ type: "file" }), null);
    assert(/refuses/.test(mod.pageScript.fillRefusalFor("password") ?? ""), "password must be refused in words");
    assert(/read-only|cannot be answered/.test(mod.pageScript.fillRefusalFor("file") ?? ""), "file must be refused in words");
    // ...and the refusal list must not swallow a type we DO fill.
    for (const t of ["text", "number", "email", "tel", "url", "search", "range", "date", "color"]) {
      assertEq(mod.pageScript.fillRefusalFor(t), null, `${t} must not be refused`);
    }
  });

  test("THE TWO LISTS, AND THE ONE DELIBERATE EXCLUSION", async () => {
    const mod = await worker();
    // The judge's set is text|textarea|email|number|tel|url|search|password. The reader's now
    // matches it EXCEPT for password, and that exclusion is policy, not drift.
    for (const t of ["text", "textarea", "number", "email", "tel", "url", "search"]) {
      assert(mod.pageScript.isTextEntry(t), `${t} must count as a free-text answer`);
      assert(mod.pageScript.isValueEntry(t), `${t} must count as a value entry`);
    }
    assert(!mod.pageScript.isTextEntry("password"), "password must never be a text entry the walker fills");
    assert(!mod.pageScript.isValueEntry("password"), "password must never be a value entry the walker fills");
    assert(!mod.pageScript.isValueEntry("file"), "file must never be a value entry the walker fills");
    // A slider is an answer but it is NOT free text — `textInputs` is consumed under that meaning.
    for (const t of ["range", "date", "time", "month", "week", "datetime-local", "color"]) {
      assert(!mod.pageScript.isTextEntry(t), `${t} must NOT be counted as free text`);
      assert(mod.pageScript.isValueEntry(t), `${t} must be a value entry`);
    }
    for (const t of ["radio", "checkbox", "button", "submit", "hidden"]) {
      assert(!mod.pageScript.isValueEntry(t), `${t} must NOT be a value entry`);
    }
  });
});

/* ============================================================ 2. the driver applies them */

suite("D44 — the driver fills what it now knows, by the route each control accepts", () => {
  test("A NUMBER SCREEN IS ANSWERED WITH THE MIDPOINT — the s2 stall, at driver level", async () => {
    const mod = await worker();
    const s = screen("S1. What is your age?", {
      controls: [control(0, { type: "number", label: "S1.", min: "0", max: "99" })],
    });
    const { obs, page } = await walk(mod, testEnv(), [s, s, s]);
    const typed = actionsOf(obs, "type-text");
    assertEq(typed.length, 1, JSON.stringify(obs.steps[0].actions));
    assertEq(typed[0].value, "50", `the walk answered "${typed[0].value}"`);
    assertEq(page.typed[0].text, "50", "the record and the keystrokes must agree");
    assert(/navigator-default/.test(typed[0].detail), typed[0].detail);
  });

  test("THE TYPES THAT WERE NEVER TOUCHED are now typed — tel, url, search", async () => {
    const mod = await worker();
    const s = screen("Contact details", {
      controls: [
        control(0, { type: "tel", label: "Phone" }),
        control(1, { type: "url", label: "Website" }),
        control(2, { type: "search", label: "Find" }),
      ],
    });
    const { obs, page } = await walk(mod, testEnv(), advancing(s));
    assertEq(actionsOf(obs, "type-text").length, 3, JSON.stringify(obs.steps[0].actions));
    assertEq(page.typed.length, 3, JSON.stringify(page.typed));
    // Nothing was refused: these are answerable and were answered.
    assertEq((obs.steps[0].unfillableControls ?? []).length, 0, JSON.stringify(obs.steps[0].unfillableControls));
  });

  test("A SLIDER IS SET, NOT TYPED — and the record never says keystrokes were delivered", async () => {
    const mod = await worker();
    // Measured: `Input.insertText` into a range does nothing at all. A record saying `type-text`
    // here would be a claim about an act that did not happen, on a question left unanswered.
    const s = screen("How likely are you to recommend?", {
      controls: [control(0, { type: "range", label: "0-10", min: "0", max: "10", value: "5" })],
    });
    const { obs, page } = await walk(mod, testEnv(), advancing(s));
    const set = actionsOf(obs, "set-value");
    assertEq(set.length, 1, JSON.stringify(obs.steps[0].actions));
    assertEq(actionsOf(obs, "type-text").length, 0, "a range must never be reported as typed");
    assertEq(set[0].value, "5");
    assertEq(page.set.length, 1, JSON.stringify(page.set));
    assertEq(page.typed.length, 0, `keystrokes were delivered to a range: ${JSON.stringify(page.typed)}`);
  });

  test("AN UNTOUCHED SLIDER IS NOT 'ALREADY ANSWERED' — `value` alone would skip every one, for ever", async () => {
    const mod = await worker();
    // A range reports its midpoint before anyone has touched it. The old skip rule was
    // `c.value && c.value.length > 0`, which would read that as an answer already given.
    const s = screen("How likely?", {
      controls: [control(0, { type: "range", value: "50", valueIsUserSupplied: false })],
    });
    const { obs } = await walk(mod, testEnv(), [s, s, s]);
    assertEq(actionsOf(obs, "set-value").length, 1, "an untouched slider was skipped as already answered");
  });

  test("...but a control the RESPONDENT already filled is still left alone", async () => {
    const mod = await worker();
    const s = screen("Your age", {
      controls: [control(0, { type: "number", min: "0", max: "99", value: "42", valueIsUserSupplied: true })],
    });
    const { obs } = await walk(mod, testEnv(), [s, s, s]);
    assertEq(actionsOf(obs, "type-text").length, 0, "a control carrying a real answer was overwritten");
  });

  test("A PLANNED VALUE ALWAYS WINS, and still goes in by the route the control accepts", async () => {
    const mod = await worker();
    const s = screen("Q1. On what date did you start treatment?", {
      controls: [control(0, { type: "date", name: "Q1", id: "Q1", label: "Q1." })],
    });
    const decision = { question: "Q1", select: [], text_entry: { required: true, value: "2019-07-04" } };
    const { obs, page } = await walk(mod, testEnv(), [s, s, s], [decision]);
    const set = actionsOf(obs, "set-value");
    assertEq(set.length, 1, JSON.stringify(obs.steps[0].actions));
    assertEq(set[0].value, "2019-07-04", "the document's value was displaced by the harness's filler");
    assertEq(page.set[0].value, "2019-07-04");
    assert(!/navigator-default/.test(set[0].detail ?? ""), `a planned answer was labelled a filler: ${set[0].detail}`);
  });

  test("A VALUE THE CONTROL REFUSED IS RECORDED AS REFUSED, never as filled", async () => {
    const mod = await worker();
    const s = screen("Q1. Date", {
      controls: [control(0, { type: "date", label: "Q1.", pattern: null })],
    });
    const { obs } = await walk(mod, testEnv(), [s, s, s], [], { setRejects: true });
    const set = actionsOf(obs, "set-value");
    assertEq(set.length, 1);
    assertEq(set[0].ok, false, "a rejected assignment was reported as a success");
    const named = obs.steps[0].unfillableControls ?? [];
    assertEq(named.length, 1, JSON.stringify(named));
    assertEq(named[0].reason, "value-rejected");
  });
});

/* ============================================================ 3. THE COUNTERWEIGHT */

suite("D44 — a control the walker will not answer STILL STALLS THE WALK, and says why", () => {
  test("A REQUIRED PASSWORD IS REFUSED — ok:false, named on the step, and lifted to the walk", async () => {
    const mod = await worker();
    // The failure this prevents: teaching the walker more types makes it advance more, and a
    // driver that claimed success on a field it never satisfied would sail through any "it
    // advances now" test while reporting a survey it never answered.
    const s = screen("Sign in to continue", {
      controls: [control(0, { type: "password", label: "Password", required: true })],
      buttons: [],
    });
    const { obs, page } = await walk(mod, testEnv(), [s, s, s]);

    const refused = actionsOf(obs, "refuse-fill");
    assertEq(refused.length, 1, JSON.stringify(obs.steps[0].actions));
    assertEq(refused[0].ok, false, "a REFUSAL was recorded as a success");
    assertEq(page.typed.length, 0, `the harness typed into a password field: ${JSON.stringify(page.typed)}`);
    assertEq(page.set.length, 0, `the harness set a password field: ${JSON.stringify(page.set)}`);

    const named = obs.steps[0].unfillableControls ?? [];
    assertEq(named.length, 1, JSON.stringify(named));
    assertEq(named[0].reason, "refused-by-policy");
    assertEq(named[0].required, true);
    assertEq((obs.unfillableControls ?? []).length, 1, JSON.stringify(obs.unfillableControls));
    assertEq(obs.unfillableControls[0].stepIndex, 0);
    assertEq(obs.unfillableControlCount, 1);
  });

  test("THE STALL IS NO LONGER INDISTINGUISHABLE FROM A NORMAL ENDING", async () => {
    const mod = await worker();
    const s = screen("Sign in to continue", {
      controls: [control(0, { type: "password", label: "Password", required: true })],
      buttons: [],
    });
    const { obs } = await walk(mod, testEnv(), [s, s, s]);

    // The old sentence, verbatim, is exactly what a thank-you page produces. It must now carry
    // the reason the walk may not be at the end at all.
    assertEq(obs.outcome, "no-advance-control");
    assert(/UNANSWERED/.test(obs.outcomeDetail ?? ""), `the stall is still generic: ${obs.outcomeDetail}`);
    assert(/password/.test(obs.outcomeDetail ?? ""), obs.outcomeDetail);
    assert(
      (obs.ending?.evidence ?? []).some((e) => /were NOT answered/.test(e)),
      `the ending does not name what went unanswered: ${JSON.stringify(obs.ending)}`,
    );
  });

  test("A FILE INPUT CANNOT BE SATISFIED, and that is a different reason from a refusal", async () => {
    const mod = await worker();
    const s = screen("Upload your prescription", {
      controls: [control(0, { type: "file", label: "Prescription", required: true })],
      buttons: [],
    });
    const { obs } = await walk(mod, testEnv(), [s, s, s]);
    const named = obs.steps[0].unfillableControls ?? [];
    assertEq(named.length, 1, JSON.stringify(named));
    assertEq(named[0].reason, "cannot-be-satisfied");
  });

  test("THE OTHER COUNTERWEIGHT: a walk that answered everything reports an EMPTY list, not an absent one", async () => {
    const mod = await worker();
    // "We looked and met nothing we could not answer" and "nobody looked" are different claims,
    // and a check that only ever fires on the bad case cannot be trusted on the good one.
    const s = screen("S1. What is your age?", {
      controls: [control(0, { type: "number", min: "0", max: "99" })],
    });
    const { obs } = await walk(mod, testEnv(), [s, s, s]);
    assertEq((obs.unfillableControls ?? null)?.length, 0, JSON.stringify(obs.unfillableControls));
    assertEq(obs.unfillableControlCount, 0);
    assert(!/UNANSWERED/.test(obs.outcomeDetail ?? ""), `a clean walk claimed a refusal: ${obs.outcomeDetail}`);
  });
});

suite("D44 / W4 — native selects are scoped, read back, and never silently skipped", () => {
  test("a single native radio group spread across table rows is layout, never a matrix", async () => {
    const mod = await worker();
    const classify = (0, eval)(mod.pageScript.CLASSIFY_TABLE_GRID_SRC);
    const splitOneGroup = classify([
      [{ type: "radio", name: "agreement" }],
      [{ type: "radio", name: "agreement" }],
    ]);
    assertEq(splitOneGroup.isGrid, false, JSON.stringify(splitOneGroup));
    assertEq(splitOneGroup.reason, "single-native-radio-group-or-unproven-rows");

    const realMatrix = classify([
      [{ type: "radio", name: "row_a" }, { type: "radio", name: "row_a" }],
      [{ type: "radio", name: "row_b" }, { type: "radio", name: "row_b" }],
    ]);
    assertEq(realMatrix.isGrid, true, JSON.stringify(realMatrix));
    // The existing constant-sum convention remains explicit and unchanged.
    assertEq(classify([[{ type: "number", name: "" }], [{ type: "number", name: "" }]]).isGrid, true);
  });

  test("the table-laid Boolean group selects exactly one radio and carries exact retained-state receipt", async () => {
    const mod = await worker();
    const radios = [
      control(0, { type: "radio", name: "agreement", code: "1", label: "Agree", checked: false }),
      control(1, { type: "radio", name: "agreement", code: "0", label: "Do not agree", checked: false }),
    ];
    const s = screen("Please choose one", {
      controls: radios,
      optionGroups: [{
        name: "agreement",
        kind: "radio",
        options: radios.map((r, order) => ({
          order, idx: r.idx, code: r.code, label: r.label, checked: false,
          disabled: false, visible: true, operable: true, actuatedVia: "self", labelIndex: null,
        })),
      }],
    });
    const { obs } = await walk(mod, testEnv(), advancing(s));
    const optionActions = actionsOf(obs, "click-option");
    assertEq(actionsOf(obs, "select-grid-cell").length, 0, JSON.stringify(obs.steps[0].actions));
    assertEq(optionActions.length, 1, JSON.stringify(obs.steps[0].actions));
    assertEq(optionActions[0].targetIdx, 0);
    assertEq(optionActions[0].choiceReadback?.idx, 0, JSON.stringify(optionActions[0]));
    assertEq(optionActions[0].choiceReadback?.checked, true, JSON.stringify(optionActions[0]));
    assertEq(optionActions[0].choiceReadback?.checkedGroupIdxs?.join(","), "0", JSON.stringify(optionActions[0]));
    assert(/exact-choice-readback/.test(optionActions[0].detail ?? ""), optionActions[0].detail);
    assertEq(obs.steps[0].advanced, true, JSON.stringify(obs.steps[0]));
  });

  test("a native radio click WITHOUT exact retained-state readback is not recorded as success", async () => {
    const mod = await worker();
    const radio = control(0, { type: "radio", name: "agreement", code: "1", label: "Agree", checked: false });
    const s = screen("Please choose one", {
      controls: [radio],
      optionGroups: [{
        name: "agreement", kind: "radio",
        options: [{ order: 0, idx: 0, code: "1", label: "Agree", checked: false, disabled: false, visible: true, operable: true }],
      }],
    });
    const { obs } = await walk(mod, testEnv(), advancing(s), [], { choiceReadback: "missing" });
    const action = actionsOf(obs, "click-option")[0];
    assert(action, JSON.stringify(obs.steps[0].actions));
    assertEq(action.ok, false, JSON.stringify(action));
    assertEq(action.choiceReadback, null, JSON.stringify(action));
    assert(/choice-readback-unavailable-or-mismatched/.test(action.detail ?? ""), action.detail);
    assertEq(obs.navigatorDefaultAnswerCount, 0, "an unproved click was counted as an invented answer");
  });

  const options = () => [
    { code: "", label: "Choose one", selected: true, placeholder: true },
    { code: "alpha-code", label: "Alpha" },
    { code: "beta-code", label: "Beta" },
  ];

  test("a planned exact LABEL selects inside its owning select and records exact readback", async () => {
    const mod = await worker();
    const s = screen("Q1. Pick a treatment", {
      controls: [selectControl(0, "Treatment", options(), { name: "Q1", id: "Q1", required: true })],
    });
    const decision = { question: "Q1", question_wording: "Pick a treatment", select: ["Beta"] };
    const { obs, page } = await walk(mod, testEnv(), advancing(s), [decision]);
    const selected = actionsOf(obs, "select-option");
    assertEq(selected.length, 1, JSON.stringify(obs.steps[0].actions));
    assertEq(selected[0].ok, true, JSON.stringify(selected[0]));
    assertEq(selected[0].targetCode, "beta-code");
    assertEq(selected[0].selectReadback?.order, 2);
    assertEq(selected[0].selectReadback?.code, "beta-code");
    assertEq(page.selections[0]?.idx, 0, "the action escaped its owning select");
    assert(!/navigator-default/.test(selected[0].detail ?? ""), selected[0].detail);
    assertEq(obs.navigatorDefaultAnswerCount, 0);
    assertEq((obs.unfillableControls ?? []).length, 0, JSON.stringify(obs.unfillableControls));
  });

  test("persisted successful select receipts require exact action/readback/owning-inventory agreement", async () => {
    const mod = await worker();
    const s = screen("Q1. Pick a treatment", {
      controls: [selectControl(0, "Treatment", options(), { name: "Q1", id: "Q1", required: true })],
    });
    const decision = { question: "Q1", question_wording: "Pick a treatment", select: ["Beta"] };
    const { obs } = await walk(mod, testEnv(), advancing(s), [decision]);
    const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
    mod.visualWork.validatePathObservationBytes(encode(obs));

    const badPointer = structuredClone(obs);
    badPointer.observationEvidenceId = "not-an-evidence-id";
    await assertThrows(
      () => mod.visualWork.validatePathObservationBytes(encode(badPointer)),
      "observationEvidenceId: has an invalid identity format",
      "the additive runtime pointer must not weaken the strict persisted envelope",
    );
    const unboundPointer = structuredClone(obs);
    unboundPointer.evidenceIds = unboundPointer.evidenceIds.filter((id) => id !== unboundPointer.observationEvidenceId);
    await assertThrows(
      () => mod.visualWork.validatePathObservationBytes(encode(unboundPointer)),
      "observationEvidenceId: must also occur in evidenceIds",
      "a syntactically valid pointer outside the walk's evidence set is not a binding",
    );
    const widened = { ...structuredClone(obs), unrelatedFutureField: true };
    await assertThrows(
      () => mod.visualWork.validatePathObservationBytes(encode(widened)),
      "unrelatedFutureField: unknown field",
      "allowing one additive pointer must not turn the strict envelope into an open object",
    );

    const forged = structuredClone(obs);
    forged.steps[0].actions.find((a) => a.kind === "select-option").selectReadback.code = "foreign-code";
    let rejected = false;
    try { mod.visualWork.validatePathObservationBytes(encode(forged)); } catch (error) {
      rejected = /target\/value fields must exactly equal/.test(String(error));
    }
    assert(rejected, "a successful select receipt with foreign readback crossed the persisted validation boundary");
  });

  test("a planned exact CODE is accepted without treating a label substring as exact", async () => {
    const mod = await worker();
    const s = screen("Q1. Pick", {
      controls: [selectControl(0, "Treatment", options(), { name: "Q1", id: "Q1", required: true })],
    });
    const decision = { question: "Q1", question_wording: "Pick", select: ["alpha-code"] };
    const { obs } = await walk(mod, testEnv(), advancing(s), [decision]);
    const selected = actionsOf(obs, "select-option")[0];
    assertEq(selected.targetLabel, "Alpha");
    assert(/planned:exact-option-code/.test(selected.detail ?? ""), selected.detail);
  });

  test("no plan falls back to the first USABLE non-placeholder option and counts provenance", async () => {
    const mod = await worker();
    const s = screen("Pick one", { controls: [selectControl(0, "Treatment", options(), { required: true })] });
    const { obs } = await walk(mod, testEnv(), advancing(s));
    const selected = actionsOf(obs, "select-option")[0];
    assertEq(selected.targetLabel, "Alpha");
    assert(/navigator-default:first-usable-native-option/.test(selected.detail ?? ""), selected.detail);
    assertEq(obs.navigatorDefaultAnswerCount, 1);
  });

  test("a label shared by TWO selects is ambiguous; neither foreign/global option is selected", async () => {
    const mod = await worker();
    const s = screen("Q1. Pick each", {
      controls: [
        selectControl(0, "First", options(), { name: "Q1", id: "Q1", required: true }),
        selectControl(1, "Second", options(), { required: true }),
      ],
    });
    const decision = { question: "Q1", question_wording: "Pick each", select: ["Beta"] };
    const { obs, page } = await walk(mod, testEnv(), [s, s, s], [decision]);
    assertEq(page.selections.length, 0, JSON.stringify(page.selections));
    assertEq(actionsOf(obs, "select-option").length, 0, JSON.stringify(obs.steps[0].actions));
    const named = obs.steps[0].unfillableControls ?? [];
    assertEq(named.filter((u) => u.reason === "selection-ambiguous").length, 2, JSON.stringify(named));
  });

  test("a requested native select on a MIXED screen does not invent an unrelated radio default first", async () => {
    const mod = await worker();
    const radio = control(0, {
      type: "radio",
      tag: "input",
      name: "unrelated",
      label: "Unrelated first radio",
      code: "radio-1",
      checked: false,
    });
    const s = screen("Q1. Mixed controls", {
      controls: [radio, selectControl(1, "Treatment", options(), { name: "Q1", id: "Q1", required: true })],
      optionGroups: [{
        name: "unrelated",
        kind: "radio",
        options: [{
          order: 0,
          idx: 0,
          code: "radio-1",
          label: "Unrelated first radio",
          checked: false,
          disabled: false,
          visible: true,
          operable: true,
          actuatedVia: "self",
        }],
      }],
    });
    const decision = { question: "Q1", question_wording: "Mixed controls", select: ["Beta"] };
    const { obs, page } = await walk(mod, testEnv(), advancing(s), [decision]);
    assertEq(actionsOf(obs, "select-option").length, 1, JSON.stringify(obs.steps[0].actions));
    assertEq(actionsOf(obs, "click-option").length, 0, JSON.stringify(obs.steps[0].actions));
    assertEq(page.clicks.filter((x) => x.index === 0).length, 0, JSON.stringify(page.clicks));
  });

  test("an exact token shared by a radio and a select is NAMED ambiguous and actuates neither", async () => {
    const mod = await worker();
    const radio = control(0, { type: "radio", tag: "input", name: "other", label: "Beta", code: "radio-beta", checked: false });
    const s = screen("Q1. Mixed exact collision", {
      controls: [radio, selectControl(1, "Treatment", options(), { name: "Q1", id: "Q1", required: true })],
      optionGroups: [{
        name: "other", kind: "radio",
        options: [{ order: 0, idx: 0, code: "radio-beta", label: "Beta", checked: false, disabled: false, visible: true, operable: true }],
      }],
    });
    const decision = { question: "Q1", question_wording: "Mixed exact collision", select: ["Beta"] };
    const { obs, page } = await walk(mod, testEnv(), [s, s, s], [decision]);
    assertEq(page.selections.length, 0, JSON.stringify(page.selections));
    assertEq(page.clicks.filter((x) => x.index === 0).length, 0, JSON.stringify(page.clicks));
    assertEq(actionsOf(obs, "select-option").length, 0, JSON.stringify(obs.steps[0].actions));
    assertEq(actionsOf(obs, "click-option").length, 0, JSON.stringify(obs.steps[0].actions));
    const named = obs.steps[0].unfillableControls ?? [];
    assertEq(named.filter((u) => u.reason === "selection-ambiguous").length, 2, JSON.stringify(named));
  });

  test("success WITHOUT exact post-action readback is a failed receipt and named unfillable", async () => {
    const mod = await worker();
    const s = screen("Pick one", { controls: [selectControl(0, "Treatment", options(), { required: true })] });
    const { obs } = await walk(mod, testEnv(), [s, s, s], [], { selectReadback: "missing" });
    const selected = actionsOf(obs, "select-option")[0];
    assertEq(selected.ok, false, JSON.stringify(selected));
    assertEq(selected.selectReadback, null);
    assert(/exact post-action readback/.test(selected.detail ?? ""), selected.detail);
    assertEq(obs.steps[0].unfillableControls?.[0]?.reason, "value-rejected");
  });

  test("a mismatched FOREIGN readback is rejected even when the page adapter says ok:true", async () => {
    const mod = await worker();
    const s = screen("Pick one", { controls: [selectControl(0, "Treatment", options(), { required: true })] });
    const { obs } = await walk(mod, testEnv(), [s, s, s], [], { selectReadback: "foreign" });
    const selected = actionsOf(obs, "select-option")[0];
    assertEq(selected.ok, false, JSON.stringify(selected));
    assert(/foreign:alpha-code/.test(selected.selectReadback?.code ?? ""), JSON.stringify(selected));
    assertEq(obs.steps[0].unfillableControls?.[0]?.reason, "value-rejected");
  });

  test("disabled and placeholder-only visible selects are BOTH named, never silently skipped", async () => {
    const mod = await worker();
    const s = screen("Pick one", {
      controls: [
        selectControl(0, "Disabled", options(), { required: true, disabled: true }),
        selectControl(1, "Placeholder only", [{ code: "", label: "Choose", selected: true, placeholder: true }], { required: true }),
      ],
    });
    const { obs, page } = await walk(mod, testEnv(), [s, s, s]);
    assertEq(page.selections.length, 0, JSON.stringify(page.selections));
    const named = obs.steps[0].unfillableControls ?? [];
    assertEq(named.length, 2, JSON.stringify(named));
    assert(named.some((u) => u.reason === "control-disabled"), JSON.stringify(named));
    assert(named.some((u) => u.reason === "no-usable-option"), JSON.stringify(named));
  });

  test("a hidden native select is named non-operable instead of silently assumed to back a widget", async () => {
    const mod = await worker();
    const s = screen("Visible prose", {
      controls: [selectControl(0, "Hidden alternate", options(), { visible: false, required: true })],
    });
    const { obs, page } = await walk(mod, testEnv(), [s, s, s]);
    assertEq(page.selections.length, 0, JSON.stringify(page.selections));
    assertEq(obs.steps[0].unfillableControls?.[0]?.reason, "control-not-operable", JSON.stringify(obs.steps[0].unfillableControls));
    assertEq(obs.steps[0].unfillableControls?.length, 1, JSON.stringify(obs.steps[0].unfillableControls));
    assert((obs.unfillableControls ?? []).every((u) => u.reason === "control-not-operable"), JSON.stringify(obs.unfillableControls));
  });

  test("a select-only page counts as rendered even when no heading heuristic recognizes it", async () => {
    const mod = await worker();
    const bare = screen("", {
      controls: [selectControl(0, "Treatment", options(), { required: true })],
    });
    bare.questionText = null;
    bare.visibleText = "";
    bare.collectedErrors = [{ kind: "error", message: "fixture load error", at: "2026-08-09T00:05:00.000Z" }];
    bare.counts.options = 0;
    bare.counts.valueInputs = 0;
    const { obs } = await walk(mod, testEnv(), [bare, bare, bare]);
    assert(!/rendered no interactive controls/.test(obs.outcomeDetail ?? ""), obs.outcomeDetail);
    assertEq(actionsOf(obs, "select-option").length, 1, JSON.stringify(obs.steps[0]?.actions));
  });

  test("an already-selected usable option is observed but NOT re-actuated or counted as invented", async () => {
    const mod = await worker();
    const held = options().map((o) => ({ ...o, selected: o.code === "beta-code" }));
    const s = screen("Pick one", { controls: [selectControl(0, "Treatment", held, { required: true })] });
    const { obs, page } = await walk(mod, testEnv(), advancing(s));
    assertEq(page.selections.length, 0, JSON.stringify(page.selections));
    assertEq(actionsOf(obs, "select-option").length, 0, JSON.stringify(obs.steps[0].actions));
    assertEq(obs.navigatorDefaultAnswerCount, 0);
  });

  test("accessible combobox and drag semantics are discovered but explicitly unsupported", async () => {
    const mod = await worker();
    const s = screen("Arrange and choose", {
      controls: [
        control(0, { type: "combobox", tag: "div", label: "Brand", widgetKinds: ["combobox"] }),
        control(1, { type: "sortable", tag: "li", label: "First item", widgetKinds: ["draggable", "sortable"] }),
      ],
    });
    const { obs, page } = await walk(mod, testEnv(), [s, s, s]);
    assertEq(page.selections.length, 0);
    assertEq(page.typed.length, 0);
    const named = obs.steps[0].unfillableControls ?? [];
    assertEq(named.length, 2, JSON.stringify(named));
    assert(named.every((u) => u.reason === "unsupported-widget"), JSON.stringify(named));
  });

  test("the reader count includes only VISIBLE custom widgets", () => {
    const read = readScreenInTinyDom({ hiddenWidget: true });
    assertEq(read.controls.filter((c) => c.widgetKinds?.includes("combobox")).length, 1, JSON.stringify(read.controls));
    assertEq(read.counts.customWidgets, 0, JSON.stringify(read.counts));
  });

  test("native select state changes an explicit state signal WITHOUT masquerading as navigation", () => {
    const before = readScreenInTinyDom({ secondSelected: false });
    const after = readScreenInTinyDom({ secondSelected: true });
    assert(before.selectStateSignature !== after.selectStateSignature, `${before.selectStateSignature} === ${after.selectStateSignature}`);
    assertEq(before.screenSignature, after.screenSignature, "answering a control changed screen identity and can fake navigation");
  });

  test("two select screens with the same options but different accessible labels have different identity", () => {
    const first = readScreenInTinyDom({ secondSelected: false });
    const second = structuredClone(first);
    second.controls[0].label = "A different respondent question";
    const expected = JSON.stringify([0, second.controls[0].label, false, second.controls[0].options.map((o) => [o.order, o.code, o.label])]);
    second.screenSignature = `${String(second.screenSignature).split("##")[0]}##${expected}`;
    assert(first.screenSignature !== second.screenSignature, `${first.screenSignature} === ${second.screenSignature}`);
  });
});

suite("D44 — an ending reached on invented answers says that it was", () => {
  test("THE PROVENANCE LINE: a walk made of navigator-defaults declares how many it made up", async () => {
    const mod = await worker();
    // Why this matters more than it looks: with the midpoint fix, s2-screener now walks FURTHER
    // and is screened out later, on answers the harness chose. A consumer that cannot see that
    // will write up "the site screens respondents out here" about a screener behaving exactly as
    // its own document specifies — a confident wrong answer, which is the cardinal failure.
    const s = screen("S1. What is your age?", {
      controls: [control(0, { type: "number", min: "0", max: "99" })],
    });
    const { obs } = await walk(mod, testEnv(), [s, s, s]);
    assertEq(obs.navigatorDefaultAnswerCount, 1, JSON.stringify(obs.navigatorDefaultAnswerCount));
    assert(
      (obs.ending?.evidence ?? []).some((e) => /navigator-defaults the harness chose/.test(e)),
      `the ending does not disclose its fillers: ${JSON.stringify(obs.ending?.evidence)}`,
    );
  });

  test("...and a walk that invented NOTHING adds no such line", async () => {
    const mod = await worker();
    const s = screen("Q1. What is your age?", {
      controls: [control(0, { type: "number", name: "Q1", id: "Q1", min: "0", max: "99" })],
    });
    const decision = { question: "Q1", select: [], text_entry: { required: true, value: "37" } };
    const { obs } = await walk(mod, testEnv(), [s, s, s], [decision]);
    assertEq(obs.navigatorDefaultAnswerCount, 0, JSON.stringify((obs.steps[0].actions ?? []).map((a) => a.detail)));
    assert(
      !(obs.ending?.evidence ?? []).some((e) => /navigator-defaults the harness chose/.test(e)),
      `a fully planned walk claimed invented answers: ${JSON.stringify(obs.ending?.evidence)}`,
    );
  });
});

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

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

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

const nextBtn = (idx) => ({ idx, label: "Next", role: "next", roleVia: "text:Next", disabled: false, visible: true });

const screen = (text, { controls = [], buttons, signature } = {}) => ({
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

/**
 * A page that serves scripted screens and RECORDS every route separately — keystrokes through
 * `type()`, assignments through the `setValueScript` string. The two must never be confusable:
 * reporting a slider as typed when nothing was typed is the failure this file exists to prevent.
 *
 * `setRejects` makes the page refuse the assignment, which is how a real `<input type=date>`
 * behaves when handed a value it cannot parse.
 */
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

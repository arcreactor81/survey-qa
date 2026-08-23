/**
 * EVIDENCE THAT D44's TESTS CAN FAIL.
 *
 * D44 is the widening change, and a widening change is exactly the shape this repo keeps getting
 * wrong: teaching the walker to fill more control types makes walks advance further, and "the
 * walk advances now" is a metric that a driver claiming success on fields it never satisfied
 * would score PERFECTLY on. Eleven artifacts in two days appeared to validate while being
 * structurally unable to fail. So the tests that hold the honest half — the refusal, the naming,
 * the provenance — have to be shown capable of going red when the honest half is removed.
 *
 * Every mutant below re-introduces ONE thing: the measured s2-screener stall, one of the never-
 * filled types, or one of the counterweights. `runMutantSuite` refuses to score anything until a
 * no-op mutation comes back not-killed over the real baseline AND a re-applied mutation comes
 * back not-killed over a deliberately RED one, so "something went red" can never pass for "this
 * guard works".
 *
 *   node tools/mutate-input-coverage.mjs
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const PS = "src/browser/page-script.ts";
const DR = "src/browser/driver.ts";

await runMutantSuite({
  title: "D44 — can the input-coverage and refusal guards fail?",
  filter: "D44",
  mutants: [
    /* ---------------------------------------------- the measured stall */
    {
      name: "the numeric filler goes back to the LOWEST legal value",
      breaks:
        "THE measured defect: `1` (raised to `min`) is a boundary probe, and a screener cuts at the " +
        "boundary. s2-screener terminated the walk on its under-18 rule after two screens of ten, and " +
        "the clean/flawed experiment on it returned 0 of 3 seeded defects for that reason alone",
      file: DR,
      find: "  const mid = effLo + (effHi - effLo) / 2;",
      replace: "  const mid = effLo;",
      kills: ["THE s2-screener DEFECT: an age field declared 0..99 is answered 50, NOT 1"],
    },
    {
      name: "the site's own step grid is ignored",
      breaks:
        "a midpoint that lands between the site's step points is refused by its own constraint " +
        "validation — the branching engine answers 49.5 with 'Please enter a whole number.' and the " +
        "walk records the survey as rejecting an answer the harness malformed",
      file: DR,
      find: "  const stepped = rawStep === \"any\" ? null : (num(c.step) ?? 1);",
      replace: "  const stepped = null;",
      kills: ["THE SITE'S STEP GRID IS THE SITE'S — a midpoint may not land between its own points"],
    },

    /* ---------------------------------------------- the coverage gap */
    {
      name: "tel, url and search leave the fillable set again",
      breaks:
        "measured: the driver filled four types and these three were never touched, so a survey " +
        "asking for a phone number blocked exactly as the number field did",
      file: PS,
      find: `  "tel",
  "url",
  "search",
];`,
      replace: "];",
      kills: ["THE TYPES THAT WERE NEVER TOUCHED are now typed — tel, url, search"],
    },
    {
      name: "a slider is TYPED instead of set",
      breaks:
        "measured in Chrome: a range ignores inserted text entirely, so the record says keystrokes " +
        "were delivered to a question that stayed unanswered — a confident wrong answer the harness " +
        "manufactured about itself",
      file: DR,
      find: '      return mid ? { value: mid.value, how: mid.how, via: "set" } : null;',
      replace: '      return mid ? { value: mid.value, how: mid.how, via: "type" } : null;',
      kills: ["A SLIDER IS SET, NOT TYPED — and the record never says keystrokes were delivered"],
    },
    {
      name: "the email filler goes back to the probe text",
      breaks:
        "the live defect nobody had named: 'QA-PROBE' is ACCEPTED into an email input's value and " +
        "then fails its constraint validation, so a required email field blocks the submit and the " +
        "survey is written up as rejecting the answer",
      file: DR,
      find: '      return { value: "qa-probe@example.com",',
      replace: "      return { value: PROBE_TEXT,",
      kills: ["EVERY TYPE A RESPONDENT CAN ANSWER HAS A RULE, and each says which route it takes"],
    },
    {
      name: "an untouched slider counts as already answered",
      breaks:
        "a range reports its midpoint before anyone touches it, so keying the skip off `value` alone " +
        "skips every slider on every survey for ever while recording the screen as answered",
      file: DR,
      // RE-ANCHORED: alreadyAnswered was widened to a multi-line ternary (revalidateValidation + placeholderValue guards added)
      find: "    const alreadyAnswered =\n      revalidateValidation.length > 0 || placeholderValue\n        ? false\n        : (c.valueIsUserSupplied ?? !!(c.value && c.value.length > 0));",
      replace: "    const alreadyAnswered =\n      revalidateValidation.length > 0 || placeholderValue\n        ? false\n        : !!(c.value && c.value.length > 0);",
      kills: ["AN UNTOUCHED SLIDER IS NOT 'ALREADY ANSWERED' — `value` alone would skip every one, for ever"],
    },

    /* ---------------------------------------------- THE COUNTERWEIGHTS */
    {
      name: "the harness starts typing into password fields",
      breaks:
        "the policy hole. A survey asking for a credential is not a survey to answer, and the whole " +
        "reason the reader's list stayed narrower than the judge's is this one deliberate exclusion",
      file: PS,
      find: '  "search",\n];',
      replace: '  "search",\n  "password",\n];',
      kills: ["THE TWO LISTS, AND THE ONE DELIBERATE EXCLUSION"],
    },
    {
      name: "the password refusal stops being a refusal",
      breaks:
        "with no reason to print, a control the harness will not answer becomes indistinguishable " +
        "from one it simply did not meet",
      file: PS,
      find: '  if (t === "password") {',
      replace: "  if (false) {",
      kills: ["THE REFUSALS ARE PERMANENT AND NAMED — password and file have no value, by design"],
    },
    {
      name: "A REFUSAL IS RECORDED AS A SUCCESS",
      breaks:
        "THE cardinal failure of this change in one flag: a driver that reports ok on a field it " +
        "never satisfied passes every 'does it advance now?' test ever written, and every walk it " +
        "produces is a confident claim about a survey it did not answer",
      file: DR,
      find: 'actions.push({ kind: "refuse-fill", targetIdx: c.idx, targetLabel: c.label, targetCode: null, value: null, ok: false, detail: `refused: ${refusal}` });',
      replace: 'actions.push({ kind: "refuse-fill", targetIdx: c.idx, targetLabel: c.label, targetCode: null, value: null, ok: true, detail: `refused: ${refusal}` });',
      kills: ["A REQUIRED PASSWORD IS REFUSED — ok:false, named on the step, and lifted to the walk"],
    },
    {
      name: "the stall goes back to the generic sentence",
      breaks:
        "'screen N offered no enabled control that advances the survey' is EXACTLY what a thank-you " +
        "page produces. Without the reason attached, a walk stopped dead by a field it refused reads " +
        "identically to a walk that finished the survey",
      file: DR,
      find: "        (unfillable.length > 0",
      replace: "        (false",
      kills: ["THE STALL IS NO LONGER INDISTINGUISHABLE FROM A NORMAL ENDING"],
    },
    {
      name: "what the walker could not answer never leaves the step it was on",
      breaks:
        "the same shape as the ending that was classified perfectly and then dropped on the way into " +
        "the ledger: a refusal named on screen 4 and left in screen 4's payload is a refusal nobody reads",
      file: DR,
      find: "    for (const u of unfillable) unfillableControls.push({ ...u, stepIndex });",
      replace: "    void unfillable;",
      kills: ["A REQUIRED PASSWORD IS REFUSED — ok:false, named on the step, and lifted to the walk"],
    },
    {
      name: "the ending stops disclosing that its answers were invented",
      breaks:
        "with the midpoint fix a walk gets FURTHER before it is screened out — on answers the harness " +
        "chose. A consumer that cannot see that writes up 'the site screens respondents out here' " +
        "about a screener behaving exactly as its own document specifies",
      file: DR,
      find: '  if (typeof ctx.navigatorDefaults === "number" && ctx.navigatorDefaults > 0) {',
      replace: "  if (false) {",
      kills: ["THE PROVENANCE LINE: a walk made of navigator-defaults declares how many it made up"],
    },
    {
      name: "a value the control REFUSED is recorded as filled",
      breaks:
        "a date input handed something it cannot parse discards it silently. Reporting that as a fill " +
        "is how the harness's own malformed value becomes 'the survey rejected our answer'",
      file: DR,
      // RE-ANCHORED (D55 sweep): the D53 allocation pass introduced a second
      // `if (r.discarded || !r.ok) {` at deeper indent whose text CONTAINS the old
      // one-line anchor, so it matched twice and the harness went BROKEN-ANCHOR — blind
      // on this guard. The value loop's own `idx: c.idx` line disambiguates it (the
      // allocation pass pushes a bare `idx`).
      find: "    if (r.discarded || !r.ok) {\n      unfillable.push({\n        idx: c.idx,",
      replace: "    if (false) {\n      unfillable.push({\n        idx: c.idx,",
      kills: ["A VALUE THE CONTROL REFUSED IS RECORDED AS REFUSED, never as filled"],
    },
  ],
});

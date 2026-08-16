/**
 * EVIDENCE THAT D42's TESTS CAN FAIL.
 *
 * D42 pins the day's cleanest cannot-fail metric: four medical walks stuck on screen 1 of 5,
 * 38 captures of the same screen, and that 38 reported upward as progress. A suite that claims
 * to guard against it is worth exactly as much as its ability to go red when the guard is
 * removed — this repo has shipped a 340/340 green suite over a crash that killed a run in one
 * second, a fleet leak check that reported "no leaks" over an empty denominator, and a mutation
 * harness that could not mutate the file it was scoring.
 *
 * Every mutant below re-introduces ONE of the measured defects, and each names the SPECIFIC test
 * that must newly fail. `runMutantSuite` refuses to score anything until a no-op mutation comes
 * back not-killed over the real baseline AND a re-applied mutation comes back not-killed over a
 * deliberately RED one, so "something went red" can never pass for "this guard works".
 *
 *   node tools/mutate-endings.mjs
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const PS = "src/browser/page-script.ts";
const DR = "src/browser/driver.ts";

await runMutantSuite({
  title: "D42 — can the advance-control and ending guards fail?",
  filter: "D42",
  mutants: [
    {
      name: "the classifier stops consulting the control's own `value`",
      breaks:
        "THE defect: a SurveyJS `<input type=button value=Next>` has no text and no <label>, so " +
        "dropping `code` makes every navigation control on every SurveyJS screen classify `other` again",
      file: PS,
      find: "    ['code', c && c.code],",
      replace: "    ['code', null],",
      kills: ["THE MEDICAL-FLEET DEFECT: `<input type=button value=Next>` has no text and no label, and is still Next"],
    },
    {
      name: "the ancestor's text is consulted FIRST",
      breaks:
        "`labelFor` falls back to the nearest ancestor, which for a nav button is the whole nav bar " +
        "reading 'Previous Next' — consulting it first walks the survey BACKWARDS",
      file: PS,
      find: "    ['text', c && c.text],\n    ['code', c && c.code],",
      replace: "    ['label', c && c.label],\n    ['text', c && c.text],\n    ['code', c && c.code],",
      kills: ["THE COUNTERWEIGHT: an ancestor's text may not overrule what the control itself says"],
    },
    {
      name: "'complete' leaves the forward lexicon",
      breaks: "SurveyJS's LAST page offers Complete, not Next — a walk that cannot press it never reaches the end",
      file: PS,
      find: "done|complete|completed|proceed",
      replace: "done|proceed",
      kills: ["THE LAST PAGE: a survey's final control says Complete, and a walk that cannot press it never reaches the end"],
    },
    {
      name: "a press chosen by ELIMINATION claims it was chosen by identity",
      breaks:
        "the elimination fallback is what made screen 1 look healthy while the classifier was blind; " +
        "a record that cannot tell the two apart hides that again",
      file: DR,
      find: '      via: "sole-forward-candidate — no control on this screen NAMED itself as advancing, and exactly one was not a back control",',
      replace: '      via: "role:next",',
      kills: ["the fallback that hid the defect on screen 1 now names itself in the record"],
    },
    {
      name: "the counts self-check trusts the summary it is checking",
      breaks:
        "this is the cannot-fail shape itself: a checker that re-reads the number it is auditing " +
        "instead of recounting the inventory always agrees, and reports a clean screen forever",
      file: PS,
      find: "    textInputs: controls.filter(function (c) { return isText(c.type); }).length,",
      replace: "    textInputs: counts.textInputs,",
      kills: ["POISONED: a summary that disagrees with the inventory is REPORTED, with both numbers"],
    },
    {
      name: "a number field stops counting as a free-text answer",
      breaks:
        "the measured drift: the reader counted text/textarea while the driver filled " +
        "text/textarea/number/email, so a screen whose only question is a number field read as having none",
      file: PS,
      find: `  "text",
  "textarea",
  "number",
  "email",`,
      replace: `  "text",
  "textarea",
  "email",`,
      kills: ["A NUMBER FIELD IS A TEXT ENTRY — one list, shared by the reader and the driver"],
    },
    {
      name: "the walker types its text probe into a number field again",
      breaks:
        "'QA-PROBE' into `<input type=number min=0 max=50>` produced 'Invalid input' and a `blocked` " +
        "walk — a working survey recorded as rejecting an answer, on screen 1, on two of four instruments",
      file: DR,
      // RE-ANCHORED: `defaultTextFor` became `navigatorValueFor` (D44), which is one rule per
      // type instead of one `if`. The defect it re-introduces is unchanged — the probe text goes
      // back into a numeric control — and so is the test that must catch it.
      find: `    case "number": {
      const mid = stepAlignedMidpoint(c);`,
      replace: `    case "number": {
      if (true) return { value: PROBE_TEXT, how: "probe text", via: "type" };
      const mid = stepAlignedMidpoint(c);`,
      kills: ["THE SCREEN-1 BLOCKER: a number field gets a number inside the bounds the SITE declares"],
    },
    {
      name: "the WIDE count stops being recounted from the inventory",
      breaks:
        "`valueInputs` is what `walkPath` now asks 'did this survey render?' with — a screen whose " +
        "only question is a slider has zero TEXT inputs — so a summariser nothing audits puts that " +
        "screen back on the 'the survey rendered no interactive control' path it was moved off",
      file: PS,
      find: "    valueInputs: controls.filter(function (c) { return isValue(c.type); }).length,",
      replace: "    valueInputs: counts.valueInputs,",
      kills: ["THE WIDE COUNT IS CHECKED TOO — a slider the summary forgot is a REPORTED disagreement"],
    },
    {
      name: "a screen-out is recorded as a completion",
      breaks:
        "a disqualification page thanks you too, so this is what happens whenever the completion test " +
        "runs first — the respondent turned away and the respondent who finished become one record",
      file: DR,
      find: '      kind: "screened-out", // wording-matched screen-out (arm 2)',
      replace: '      kind: "completed", // wording-matched screen-out (arm 2)',
      kills: ["THE ORDERING THAT MATTERS: a screen-out page THANKS YOU TOO, and is not a completion"],
    },
    {
      name: "an ending nothing named DEFAULTS to completed",
      breaks:
        "the ninth cannot-fail artifact, pre-empted: a terminal page that says nothing becomes a " +
        "completion by assumption, which is exactly the defect typing the ending was meant to remove",
      file: DR,
      find: "  if (completion || progressFull) {",
      replace: "  if (true) {",
      kills: ["UNCLASSIFIED IS A REAL ANSWER: a terminal page that says nothing is NOT a completion"],
    },
    {
      name: "a screen still offering Next is treated as an ending",
      breaks: "this is the 38-captures-of-one-screen case: the walk stopped, the survey had not",
      file: DR,
      find: "  if (advance) {",
      replace: "  if (false) {",
      kills: ["STALLED: the screen still offered an enabled Next — this is the 38-captures-of-one-screen case"],
    },
    {
      name: "a walk that ran out of BUDGET is allowed to have reached an ending",
      breaks:
        "a cap, an error or a refused submit stops the walk, not the survey; reading the last screen " +
        "as an ending turns 'we ran out of time on a thank-you-looking page' into a completion",
      file: DR,
      find: '  if (ctx.outcome !== "completed" && ctx.outcome !== "no-advance-control") {',
      replace: "  if (false) {",
      kills: ["A WALK THAT HIT A CAP REACHED NO ENDING, whatever its last screen happens to say"],
    },
    {
      name: "the typed ending never reaches the walk artifact",
      breaks:
        "the classification can be perfect and still worthless if the field is not written: every " +
        "consumer degrades to 'not decidable', which is where the fleet already was",
      file: DR,
      find: "    ending,\n    shimmed: opts.applyHistoryShim,",
      replace: "    shimmed: opts.applyHistoryShim,",
      kills: ["a walk that runs out of survey carries a typed ending with its evidence"],
    },
  ],
});

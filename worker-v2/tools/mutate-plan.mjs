#!/usr/bin/env node
/**
 * EVIDENCE THAT THE D20 TESTS CAN FAIL.
 *
 *   node tools/mutate-plan.mjs
 *
 * "Beware the check that cannot fail" (CLAUDE.md). D20 asserts that typed-case
 * materialization PRESERVES the planner's other selections on a multi-select question —
 * and a test asserting that something is preserved passes trivially over code that simply
 * never touches it. So each mutant below reinstates one specific destruction the live path
 * used to perform, and the REAL D20 suite is re-run against it. A survivor means the
 * property it broke is not actually tested, and this exits non-zero.
 *
 * MUTANT 1 IS THE REGRESSION ITSELF: the unconditional `select = [label]` that shipped on
 * `materializeCasePaths` while the union rule sat in an uncalled helper.
 *
 * NOTHING IS WRITTEN TO `src/**`. `testkit.mjs#mutantPlugin` rewrites the source inside
 * esbuild's load step, so an interrupted run cannot leave a mutated working copy behind —
 * which matters in a tree other agents are editing. This is a separate mutant SET from
 * `mutate-expander.mjs` (which is pinned to `src/extract/expand.ts`) so the two cannot
 * disturb each other.
 *
 * THE KILL CRITERION IS NOT LOCAL TO THIS FILE — it lives in `tools/mutate-runner.mjs`, and
 * it is baseline-aware. This harness originally scored a mutant as killed on ANY `FAIL` line,
 * which is only sound over a fully green suite; on 5 Aug, with 22 pre-existing failures, that
 * rule scored every mutant (including a no-op) as killed. The shared runner records the
 * unmutated failures first and counts only NEW ones, and self-checks that rule against both a
 * green and a deliberately red baseline before scoring anything here.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const FILE = "src/workflow/stages/plan.ts";
/**
 * The planner itself. It is mutated through the SAME bundle as `plan.ts` — which is why D36's
 * length tests reach it via `mod.plan.planFromContract` instead of importing this file
 * directly: a direct `import` runs code esbuild's load step never saw, so the mutant would not
 * reach it and the guard would score as untestable while looking green.
 */
const PLAN_CORE = "src/workflow/stages/planner/plan-core.js";

/** Each mutant names the property it breaks, so a survivor reads as a gap, not a puzzle. */
const MUTANTS = [
  {
    name: "THE REGRESSION: the typed answer unconditionally REPLACES the whole select list",
    breaks: "a multi-select question keeps the planner's gating selections when a typed answer is driven",
    file: FILE,
    find:
      "      if (planned.length > 1) {\n" +
      "        decision.select = label === null || planned.includes(label) ? [...planned] : [...planned, label];\n" +
      "      } else {\n" +
      "        decision.select = label === null ? [] : [label];\n" +
      "      }",
    replace: "      decision.select = label === null ? [] : [label];",
    kills: ["THE ONE THAT MATTERS: a typed answer UNIONS into a multi-select, never replaces it"],
  },
  {
    name: "every question is treated as multi-select, so a radio is UNIONed",
    breaks: "a single-select question replaces its selection instead of accumulating two clicks",
    file: FILE,
    find: "      if (planned.length > 1) {",
    replace: "      if (true) {",
    kills: ["a SINGLE-select question still REPLACES — a radio must not be clicked twice"],
  },
  {
    name: "typed cases share one walk instead of receiving independent clones",
    breaks: "two cases on one question are each driven, rather than the last one silently winning",
    file: FILE,
    find: "    const clone = clonePlannedPath(base);",
    replace: "    const clone = base;",
    kills: ["NEVER A SILENT LOSS: two cases on ONE single-select question both get driven"],
  },

  // ---- D36: the stimulus a walk is handed must be one a browser can perform ----------------
  //
  // Mutant 4 IS THE PRODUCTION DEFECT VERBATIM: the boundary probe describing itself instead of
  // being itself. The three after it exist because "not a placeholder" is a weaker property than
  // "the right number of the right characters", and a test that only checked the first would go
  // on passing over a value of the wrong length — the same untested boundary in new clothes.
  {
    name: "THE PRODUCTION DEFECT: the boundary probe types its own DESCRIPTION again",
    breaks: "a character-limit walk types the number of characters the limit is about",
    file: PLAN_CORE,
    find: "          value: boundaryText(c.textLength),",
    replace: "          value: `<exactly ${c.textLength} characters>`,",
    kills: ["THE PRODUCTION DEFECT: no decision anywhere carries a `<exactly N characters>` placeholder"],
  },
  {
    name: "the payload is silently capped, so a 500-character probe types 24",
    breaks: "`text_entry.value.length` equals the `length` the probe declares",
    file: PLAN_CORE,
    find: "  return BOUNDARY_FILL_CHAR.repeat(len);",
    replace: "  return BOUNDARY_FILL_CHAR.repeat(Math.min(len, 24));",
    kills: ["`value.length` IS `length` — the three sides of a 500-character limit are 499, 500 and 501"],
  },
  {
    name: "the filler is whitespace, which a trimming field eats without saying so",
    breaks: "every character of the payload survives a field that trims its input",
    file: PLAN_CORE,
    find: "const BOUNDARY_FILL_CHAR = 'x';",
    replace: "const BOUNDARY_FILL_CHAR = ' ';",
    kills: ["every character is ONE code unit, so `maxlength`, the DOM and a byte count cannot disagree"],
  },
  {
    name: "a zero-length side types one character instead of submitting nothing",
    breaks: "'type 0 characters' means the empty field, not a one-character answer",
    file: PLAN_CORE,
    find: "  const len = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;",
    replace: "  const len = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;",
    kills: ["a limit of 1 makes the just-below side ZERO characters — the empty field, not the string '0'"],
  },

  // ---- D36: a code-only route answer ------------------------------------------------------
  {
    name: "code-only route answers are left with nothing to click, as before",
    breaks: "a sealed code resolves to the label another sealed case gives that same code",
    file: FILE,
    find: "      if (label === null && sealedCode !== null) {",
    replace: "      if (false && label === null && sealedCode !== null) {",
    kills: ["THE PRODUCTION ROWS: Q7/code 2 with no label takes its label from the sealed case that has one"],
  },
  {
    name: "a routing CONDITION is allowed into the code->label index",
    breaks: "the poison D32 removed from one case cannot be handed to another through the index",
    file: FILE,
    find: "    if (isRoutingConditionLabel(answer.label, qid, sealedQuestionIds)) continue;",
    replace: "    if (false) continue;",
    kills: ["A ROUTING CONDITION NEVER BECOMES A LABEL FOR SOMEONE ELSE"],
  },
  {
    name: "the index is keyed by the CODE alone, so code 1 means the same thing everywhere",
    breaks: "an answer code is a fact about ONE question, never about the survey",
    file: FILE,
    find: '  return [String(questionId ?? "").trim(), String(code ?? "").trim()].join(ROUTE_CODE_KEY_SEPARATOR);',
    replace: '  return String(code ?? "").trim();',
    kills: ["A CODE IS NOT A GLOBAL FACT: the same code on ANOTHER question resolves to nothing"],
  },
  {
    name: "two sealed cases that disagree let the FIRST one win",
    breaks: "a contradiction resolves to nothing rather than to whichever row was read first",
    file: FILE,
    find: "    if (held.label === answer.label) continue;",
    replace: "    continue;",
    kills: ["TWO SEALED CASES THAT DISAGREE DO NOT VOTE — at most one is right, so neither is used"],
  },

  // ---- D36: the 48, and the vocabulary gap behind the empty option model -------------------
  {
    name: "'no target question' is filed back under 'incomplete stimulus'",
    breaks: "each of the four reasons a case reaches no walk is counted as itself",
    file: FILE,
    find: "        PLAN_LIMITATION_CODES.caseWithoutTargetQuestion,",
    replace: "        PLAN_LIMITATION_CODES.caseWithoutStimulus,",
    kills: ["THE 21: a complete stimulus with no targetQuestionId is NOT 'stimulus incomplete'"],
  },
  {
    name: "the sealed facet is passed through as the planner category again",
    breaks: "`option-list` reaches the option miner under the name the miner reads",
    file: FILE,
    find: "  return SEALED_FACET_TO_PLANNER_CATEGORY[facet] ?? facet;",
    replace: "  return facet;",
    kills: ["THE ROOT CAUSE OF THE EMPTY OPTION MODEL: `option-list` reaches the miner as `option-set`"],
  },
  {
    name: "`skip-rule` is mapped to `branch-outcome` after all",
    breaks: "a near-neighbour rename is not allowed to stand in for a routing model",
    file: FILE,
    find: '  terminate: "terminal",\n});',
    replace: '  terminate: "terminal",\n  "skip-rule": "branch-outcome",\n});',
    kills: ["`skip-rule` is NOT translated — the measurement that says why is the point"],
  },
  {
    name: "the planner's multi-select default stops preferring the exclusive none-option",
    breaks:
      "reach on the universal exclusion-screener shape, one layer above the driver: the " +
      "planner puts a disqualifying affiliation into `select`, plan answers replay " +
      "identically on every attempt, and every walk and every pivot dies at that screen — " +
      "measured live on 2026-08-17 at the S50 exclusion screener",
    file: PLAN_CORE,
    find: "    if (Q.multi) {\n      const none = usable.find((o) => NONE_STYLE.test(o.text));\n      if (none) return { select: [none.text], source: 'default:exclusive-none-option' };\n    }",
    replace: "    // (exclusive-none preference dropped by mutant)",
    kills: ["THE MEASURED SHAPE: a multi-select exclusion question defaults to None of the above, named as such"],
  },
];

await runMutantSuite({
  title: "D20 + D36 plan-stage mutants — can the materialization and stimulus tests still fail?",
  // No filter. `plan.ts` feeds D11, D18 and D20, and a baseline over only D20 would miss a
  // mutation that reddens one of the others.
  filter: "",
  mutants: MUTANTS,
});

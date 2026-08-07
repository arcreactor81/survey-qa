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
];

await runMutantSuite({
  title: "D20 typed-case materialization mutants — can the preservation tests still fail?",
  // No filter. `plan.ts` feeds D11, D18 and D20, and a baseline over only D20 would miss a
  // mutation that reddens one of the others.
  filter: "",
  mutants: MUTANTS,
});

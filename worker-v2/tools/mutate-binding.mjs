#!/usr/bin/env node
/**
 * EVIDENCE THAT THE D32 TESTS CAN FAIL.
 *
 *   node tools/mutate-binding.mjs
 *
 * "Beware the check that cannot fail" (CLAUDE.md). D32 asserts that a decision binds to the
 * RIGHT screen and is REFUSED when it cannot be identified — and both halves are the kind of
 * property that passes trivially over code that does something else entirely. The investigator
 * who found this defect walked into exactly that trap once already: their first binding test
 * pointed at an artifact that was insufficient for unrelated reasons, so it passed whether or
 * not the guard ran.
 *
 * So every mutant below REINSTATES one specific behaviour the old code had, or DELETES one
 * signal the new code depends on, and the REAL suite is re-run against it. A survivor means
 * the property it broke is not actually tested, and this exits non-zero.
 *
 * MUTANT 1 IS THE PRODUCTION DEFECT ITSELF: option-label overlap binding a decision to a
 * screen. That is the line that spent `fi_d2db2a271da3fc008605`'s "Can't remember" on a
 * different question and let the real Q7 take the opposite branch.
 *
 * NOTHING IS WRITTEN TO `src/**`. `testkit.mjs#mutantPlugin` rewrites the source inside
 * esbuild's load step, so an interrupted run cannot leave a mutated working copy behind — which
 * matters in a tree several agents are editing. This is a separate mutant SET from
 * `mutate-plan.mjs` (pinned to the same file but to different anchors) so the two cannot
 * disturb each other.
 *
 * The kill criterion lives in `tools/mutate-runner.mjs`: baseline-aware, and a mutant that
 * declares `kills` is killed only by THAT NAMED TEST going newly red.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const DRIVER = "src/browser/driver.ts";
const PLAN = "src/workflow/stages/plan.ts";

const MUTANTS = [
  {
    name: "THE PRODUCTION DEFECT: option-label overlap binds a decision again",
    breaks: "a similar answer label on a foreign screen is not identity and must be refused",
    file: DRIVER,
    find: "  // ---- 5: option-label overlap is not identity ----\n  for (const row of scored) {",
    replace:
      "  // ---- 5: MUTANT — overlap binds, exactly as production did ----\n" +
      "  for (const row of scored) {\n" +
      '    if (optionHits(row.decision) > 0) return bind(row, "options:" + optionHits(row.decision));\n' +
      "  }\n" +
      "  for (const row of scored) {",
    kills: [
      "THE REFUSAL ARM: with nothing else to bind, a similar label ALONE is refused, not bound",
      "exactness does not rescue the old rule: 'Yes' against 'Yes' on the wrong screen also refuses",
      "THE ROUTE CASE CLICKS ITS ANSWER ON ITS OWN SCREEN, not on the screen that resembles it",
      "a walk that never bound a decision SAYS SO on the observation, with a count",
    ],
  },
  {
    name: "a refused decision is consumed anyway, so it cannot reach its own screen",
    breaks: "refusing must leave the decision PENDING — the other half of the repair",
    file: DRIVER,
    find: "    if (matched) remaining.splice(matched.index, 1);",
    replace:
      "    if (matched) remaining.splice(matched.index, 1);\n" +
      "    else for (const r of binding.refusals) {\n" +
      '      const i = remaining.findIndex((d) => String(d.question ?? "") === r.question);\n' +
      "      if (i >= 0) remaining.splice(i, 1);\n" +
      "    }",
    kills: ["a walk that never bound a decision SAYS SO on the observation, with a count"],
  },
  {
    name: "the wording signal is deleted (every score becomes zero)",
    breaks: "the PRIMARY signal really is the one carrying the binds, not a decoration",
    file: DRIVER,
    find: "  return (2 * precision * recall) / (precision + recall);",
    replace: "  return 0;",
    kills: [
      "THE DEFECT: a foreign screen offering a similar label no longer eats the Q7 decision",
      "THE LOAD-BEARING ONE: a screen the wording identifies binds even when it does NOT offer the answer",
      "…and the S2 decision it produces binds the S2 screen, whose heading is only the FIRST sentence",
    ],
  },
  {
    name: "recall is taken over the heading instead of the whole screen",
    breaks: "a document sentence the site renders BELOW the heading still counts (S2: 0.556 -> 1.000)",
    file: DRIVER,
    find: '  const full = tokenSet(`${screen.questionText ?? ""} ${screen.instructionText ?? ""} ${strippedVisible}`);',
    replace: "  const full = heading;",
    kills: ["…and the S2 decision it produces binds the S2 screen, whose heading is only the FIRST sentence"],
  },
  {
    name: "the markup signal is deleted (control name/id never consulted)",
    breaks: "a question the contract never worded is still drivable",
    file: DRIVER,
    find: "  const markupId = markupIds.length === 1 ? markupIds[0]! : null;",
    replace: "  const markupId = null as string | null;",
    kills: [
      "a question the contract never worded still binds by the ids its controls carry",
      "a grid whose per-row names are `Q5_A` still binds Q5, by the control id prefix",
      "the words say one question and the controls say another: refuse and name both",
      "the screen names a question with no pending decision: refuse rather than spend the leftovers",
    ],
  },
  {
    name: "the ambiguity margin is dropped: the higher score always wins",
    breaks: "two decisions describing one screen equally must refuse, not race",
    file: DRIVER,
    find:
      "    const separated = !runnerUp || runnerUp.wording <= 0 || top.wording >= runnerUp.wording * WORDING_MARGIN_RATIO;",
    replace: "    const separated = true;",
    kills: ["two decisions describe the screen equally well: refuse both, and say so"],
  },
  {
    name: "the sibling scope search is removed (exact key only)",
    breaks: "S2's wording, which extraction filed under `question:S2_coffee`, is still found",
    file: PLAN,
    find: "  const candidates = children.length > 0 ? children : parents;",
    replace: "  const candidates = [] as string[];",
    kills: [
      "THE SIBLING SCOPE, MEASURED IN PRODUCTION: S2's wording lives under `question:S2_coffee`",
      "…and the S2 decision it produces binds the S2 screen, whose heading is only the FIRST sentence",
    ],
  },
  {
    name: "the wording index keeps the FIRST usable quote instead of the question's own sentence",
    breaks: "a programmer instruction filed under the same facet does not become the wording",
    file: PLAN,
    find: "    if (a > b || (a === b && text < held.text)) index.set(qid, { text, scope: r.scope });",
    replace: "    if (false) index.set(qid, { text, scope: r.scope });",
    kills: ["PROGRAMMER INSTRUCTIONS ARE NOT WORDING: the question's own sentence wins over the rows beside it"],
  },
  {
    name: "routing-condition detection is switched off",
    breaks: "an 'answer' no option can ever carry is removed from what the driver clicks",
    file: PLAN,
    find: "  return tokens.some((t) => t !== own && /\\d/.test(t) && sealedQuestionIds.has(t));",
    replace: "  return false;",
    kills: [
      "THE PRODUCTION ROWS: 'Code 2 at Q1' is a routing CONDITION, not something Q2 offers",
      "a condition label does not silently vanish: it is returned, counted and warned about",
    ],
  },
  {
    name: "routing-condition detection fires on ANY sealed id, digit or not",
    breaks: "a real answer containing a bare-letter id is not eaten",
    file: PLAN,
    find: "  return tokens.some((t) => t !== own && /\\d/.test(t) && sealedQuestionIds.has(t));",
    replace: "  return tokens.some((t) => t !== own && sealedQuestionIds.has(t));",
    kills: ["A REAL ANSWER IS NEVER EATEN: a label is only a condition when it names another question BY NUMBER"],
  },
  {
    name: "limitations are emitted only when they bit",
    breaks: "'we looked and it was zero' stays distinguishable from 'nobody looked'",
    file: PLAN,
    find: "    limitations,\n    coverage: {",
    replace: "    limitations: limitations.filter((l) => l.count > 0),\n    coverage: {",
    kills: ["EVERY named limitation is emitted, INCLUDING at zero — 'we looked' must differ from 'nobody looked'"],
  },
];

await runMutantSuite({
  title: "D32 decision-identity mutants — can the binding and refusal tests still fail?",
  // No filter: `driver.ts` and `plan.ts` feed D11, D18, D20, D29 and D31 as well, and a
  // baseline over D32 alone would hide a mutation that reddens one of those instead.
  filter: "",
  mutants: MUTANTS,
});

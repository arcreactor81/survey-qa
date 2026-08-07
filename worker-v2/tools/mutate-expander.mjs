#!/usr/bin/env node
/**
 * EVIDENCE THAT THE D16 EXPANDER TESTS CAN FAIL.
 *
 *   node tools/mutate-expander.mjs
 *
 * "Beware the check that cannot fail" (CLAUDE.md). D16 asserts that the expander REFUSES
 * to fabricate expectations — and a test suite that asserts a refusal is exactly the shape
 * that passes over code doing nothing at all. So each mutation below reinstates one
 * specific fabrication the expander used to perform, or forces one comparison open, and the
 * REAL suite is re-run against it. A mutant that survives means the property it broke is
 * not actually being tested, and this exits non-zero.
 *
 * ==================== WHY THIS FILE CHANGED ON 7 AUG ====================
 *
 * It used to score a mutant as KILLED on ANY `FAIL` line in the output. That is only sound
 * over a suite that is fully green, and on 5 Aug the suite had 22 pre-existing failures — so
 * every mutant, including one that changes nothing, scored as killed. This harness was itself
 * a check that could not fail, which is the same defect it exists to hunt.
 *
 * The criterion now lives in `tools/mutate-runner.mjs` and is BASELINE-AWARE: the suite runs
 * unmutated first, and only a test that newly goes red counts as a kill. Where a mutant names
 * `kills`, only THAT test counts — "something somewhere went red" is not proof about a
 * specific property. The runner also scores a no-op mutation before any real one and aborts
 * if it comes back "killed", so the criterion cannot silently regress again.
 *
 * NOTHING IS WRITTEN TO `src/**`. `testkit.mjs#mutantPlugin` rewrites the source inside
 * esbuild's load step, so an interrupted run cannot leave a mutated working copy behind —
 * which matters in a tree other agents are editing.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const FILE = "src/extract/expand.ts";

/**
 * Each mutant names the property it breaks, so a survivor reads as a gap, not a puzzle, and
 * names the TEST that must notice, so a kill is attributable rather than incidental.
 */
const MUTANTS = [
  {
    name: "compound destinations bind to the first question named",
    breaks: "the binder refuses to CHOOSE between the questions a compound destination names",
    file: FILE,
    find: "if (named.length === 1) {",
    replace: "if (true) {",
    kills: ["NEGATIVE: a compound destination binds to NEITHER of the questions it names"],
  },
  {
    name: "one-character question ids are pulled out of unrelated prose",
    breaks: "phrase matching excludes ids too short to be distinguishable from ordinary words",
    file: FILE,
    find: "        .filter(([key, id]) => id.length > 1 && mentions(phrase, key))",
    replace: "        .filter(([key, id]) => mentions(phrase, key))",
    kills: ["NEGATIVE: binding uses the DOCUMENT'S vocabulary, and a one-character id cannot be caught by a phrase"],
  },
  {
    name: "an unbindable destination is taken verbatim as a question id (the CONTINUE defect)",
    breaks: "a destination that names no question the document knows never becomes an expectation",
    file: FILE,
    find: "  // (4) Nothing bound (A3).\n  return {\n    destination: null,",
    replace: "  // (4) Nothing bound (A3).\n  return {\n    destination: { questionId: phrase, screen: null, terminal: null },",
    kills: [
      "NEGATIVE: a relative destination does not become an expectation",
      "NEGATIVE: THE ONE THAT MATTERS — an unbound destination cannot verify even when the screen spells it",
    ],
  },
  {
    name: "a selection count is written back into the text-input payload",
    breaks: "a min/max selection count never becomes a value to type",
    file: FILE,
    find: 'boundaryInput: { bound: "above-max", value: null, expectedOutcome: "unspecified" },',
    replace: 'boundaryInput: { bound: "above-max", value: String(expansion.maxSelections + 1), expectedOutcome: "rejected" },',
    kills: ["NEGATIVE: a selection count never becomes a value to type"],
  },
  {
    name: "a length bound claims its filler string is an acceptable answer",
    breaks: "a stated maximum length does not entail that a synthetic string of that length is a valid ANSWER",
    file: FILE,
    find: 'boundaryInput: { bound: "max", value: "x".repeat(max), expectedOutcome: "unspecified" } },\n        expectationGap: gap(',
    replace: 'boundaryInput: { bound: "max", value: "x".repeat(max), expectedOutcome: "accepted" } },\n        expectationGap: null && gap(',
    kills: ["a length bound entails rejection ABOVE it, and acceptance of nothing"],
  },
  {
    name: "the predicate registry stops gating which kinds may report as typed",
    breaks: "a case kind no predicate is registered for can never be reported as decidable",
    file: FILE,
    find: "  KINDS_WITH_A_PREDICATE.has(d.case.kind) ? d.expectationGap : (d.expectationGap ?? structuralGap(d.case.kind));",
    replace: "  d.expectationGap;",
    kills: ["NEGATIVE: a kind with no registered predicate can never be typed, whatever it carries"],
  },
  {
    name: "coverage counts every case as typed",
    breaks: "the reported ceiling is derived from the cases, not asserted",
    file: FILE,
    find: "    if (fi.expectationGap) byGap[fi.expectationGap.code] = (byGap[fi.expectationGap.code] ?? 0) + 1;",
    replace: "    if (false) byGap[fi.expectationGap.code] = (byGap[fi.expectationGap.code] ?? 0) + 1;",
    kills: ["coverage states the CEILING: every case counted, every gap named"],
  },
];

await runMutantSuite({
  title: "D16 expander mutants — can the refusal tests still fail?",
  // No filter. `expand.ts` feeds the sealed contract that D16, D19 and D20 all read, and a
  // baseline taken over only D16 would miss a mutation that reddens one of the others.
  filter: "",
  mutants: MUTANTS,
});

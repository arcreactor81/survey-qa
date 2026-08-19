/**
 * EVIDENCE THAT D37 CAN FAIL — and, first, that its COUNTERWEIGHT can.
 *
 *   node tools/mutate-report-defects.mjs
 *
 * This product's failure mode is not "a test is missing", it is "a test cannot fail". A
 * report that showed a defect lane unconditionally would pass every "the defect is visible"
 * assertion in D37 and be worse than what it replaced — a researcher who is told about
 * problems on a clean survey learns to ignore the page, and then misses the real one. So the
 * first mutant here is the one that makes the lane unconditional, and the clean-run test is
 * the one that must go red for it.
 *
 * The rest put back, one at a time, each specific thing run `v2r_01kzfktf3qj9qazn86t1y0yx5k`
 * did: the headline order that buried a defect under "nothing to act on"; the em-dash counts
 * panel that made 2-of-227 look like a clean sweep; the vocabulary check that stops an
 * inconclusive result being published as a defect; and the zero rows that are the whole
 * reason a plan's shortfall list can distinguish "we looked" from "nobody looked".
 *
 * Nothing is written to disk: the rewrite happens inside esbuild's load step
 * (testkit.mjs#mutantPlugin), so an interrupted run cannot leave a mutated working copy —
 * which is what makes it safe to mutate shared `pipeline/**` files from this session.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const SUMMARY = "../pipeline/report/lib/render-summary.mjs";
const PLAIN = "../pipeline/report/lib/plain-language.mjs";
const VIEW = "../pipeline/report/lib/view-model.mjs";

const MUTANTS = [
  {
    name: "THE COUNTERWEIGHT: the defect lane renders whether or not there is a defect",
    breaks: "a clean survey is reported as a broken one",
    file: SUMMARY,
    find: '\n  s.problems.length\n    ? `<section class="lane lane--problems"',
    replace: '\n  true\n    ? `<section class="lane lane--problems"',
    kills: ["A CLEAN RUN SHOWS NO DEFECT — no lane, no defect headline, nothing derived"],
  },
  {
    name: "THE ORIGINAL DEFECT: 'we cannot tell you yet' outranks a recorded divergence again",
    breaks: "the page opens by saying there is nothing to act on, above the things to act on",
    file: PLAIN,
    find: "if (!countsKnown && recordedDivergences > 0) {",
    replace: "if (!countsKnown && false) {",
    kills: ["THE RECORD'S OWN CLAIM IS WHAT IS SHOWN, and nothing is derived beside it"],
  },
  {
    name: "THE ORIGINAL DEFECT: the counts panel goes back to em dashes when nothing settled",
    breaks: "a run that tried 2 of 227 requirements reads exactly like a run that tried all of them",
    file: SUMMARY,
    find: '      s.countsKnown\n        ? `<div class="mini-counts">${["passed", "problem", "decision", "partial", "no-browser", "not-completed"]',
    replace: '      true\n        ? `<div class="mini-counts">${["passed", "problem", "decision", "partial", "no-browser", "not-completed"]',
    kills: ["A CLEAN RUN STILL SAYS HOW LITTLE IT CHECKED — silence is not a pass"],
  },
  {
    name: "FABRICATION: an inconclusive check is published as a defect",
    breaks: "'we could not check this' is reported to a researcher as 'your survey is broken'",
    file: VIEW,
    find: 'if (!o || o.verifier?.decision !== "contradicted") continue;',
    replace: "if (!o) continue;",
    kills: ["NOTHING IS INVENTED: an `insufficient` decision is not a defect"],
  },
  {
    name: "THE ZEROS ARE DROPPED from what the plan could not do",
    breaks: "'we looked and found none of these' becomes indistinguishable from 'nobody looked'",
    file: SUMMARY,
    find: "const entries = Array.isArray(block.entries) ? block.entries : [];",
    replace:
      "const entries = (Array.isArray(block.entries) ? block.entries : []).filter((e) => Number(e?.count ?? 0) > 0);",
    kills: ["a named shortfall is shown — and the one at ZERO survives, because that is the point"],
  },
  {
    name: "THE MEASURED DEFECT: the page reads a stop-reason shape v2 does not write",
    breaks:
      "every v2 attempt counts as \"other\", so the page prints \"Recorded attempt stop reasons: " +
      "other ×N\" over a run whose walks each stated plainly how they stopped — including the " +
      "`no-advance-control` that a real completion lands on",
    file: VIEW,
    find: '    const r = a?.stop?.reason ?? a?.stopReason ?? "other";',
    replace: '    const r = a?.stop?.reason ?? "other";',
    kills: ["A V2 ATTEMPT'S STOP REASON IS NAMED, not counted as `other`"],
  },
  {
    name: "INVERTED: an attempt that stated no reason is given one anyway",
    breaks:
      "the fix is a second READ, not a default. Inventing a stop reason for a row that carries " +
      "neither shape is the same confident-wrong-answer defect pointed the other way",
    file: VIEW,
    find: '    const r = a?.stop?.reason ?? a?.stopReason ?? "other";',
    replace: '    const r = a?.stop?.reason ?? a?.stopReason ?? "no-advance-control";',
    kills: ["THE COUNTERWEIGHT: a stop reason the record does NOT state is still `other`"],
  },
];

await runMutantSuite({
  title: "D37 — the defects a reader must see, and the clean run that must stay clean",
  // No filter. These files render EVERY report the suite publishes, so a baseline over only
  // D37 would miss a mutation that reddens D1, D12 or D14 instead of the guard it names.
  filter: "",
  mutants: MUTANTS,
});

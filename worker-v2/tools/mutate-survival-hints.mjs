/**
 * EVIDENCE THAT THE SURVIVAL-HINT GUARDS (D36 extension + D54) CAN FAIL.
 *
 * Survival hints are a reach change with one hard invariant: hints are INPUT, never
 * EVIDENCE. Each mutant below re-opens one of the three ways that invariant (or the
 * fallback contract) could quietly break — the stamp leaking into `select` (the one field
 * that fabricates missing-option evidence AND moves the exercised gate), the driver
 * refusing an answer instead of falling back to position-1, and a pass that is NOT a hint
 * consumer starting to consume them — and the named guard test must go red for it.
 *
 *   node tools/mutate-survival-hints.mjs
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const PLAN = "src/workflow/stages/plan.ts";
const DR = "src/browser/driver.ts";

await runMutantSuite({
  title: "Survival hints — can the INPUT-never-EVIDENCE guards fail?",
  filter: "survival",
  mutants: [
    {
      name: "the stamp writes into `select` instead of `avoid_labels`",
      breaks:
        "THE INVARIANT at its leak vector. A label in `select` is clicked as a PLAN answer, " +
        "lands in requestedButNotOffered when the site words it differently (fabricated " +
        "missing-option evidence), makes the delegated decision constraining (the exercised " +
        "gate's denominator moves on stimulus metadata), and changes pathSignature (two " +
        "identical experiments stop being the same experiment)",
      file: PLAN,
      find: "      d.avoid_labels = [...labels];",
      replace: "      d.select = [...labels];",
      kills: [
        "stamping is SIGNATURE-NEUTRAL: pathSignature is byte-identical before and after",
        "a stamped discretion decision stays INVISIBLE to the exercised gate",
      ],
    },
    {
      name: "the driver refuses to answer instead of falling back to position-1",
      breaks:
        "the never-refuse contract. A screen whose every answerable option is a documented " +
        "trigger (a genuine one-branch screener) would go unanswered, the walk would stall " +
        "with a generic no-advance sentence, and a hint — pure steering input — would have " +
        "COST reach instead of buying it",
      file: DR,
      find: "      const chosen = preferred ?? first;",
      replace: "      if (!preferred) continue;\n      const chosen = preferred;",
      kills: ["EVERY answerable option is flagged => today's position-1 fallback, never a refusal"],
    },
    {
      name: "the recovery re-pick stops consuming survival hints (the pre-fix gap reintroduced)",
      breaks:
        "the retry half of the steering contract. When a screen blocks and walkPath's recovery " +
        "pass re-invokes applyDecision, the synthetic decision is NON-NULL — so an unstamped " +
        "`avoid_labels` reads as an empty avoid set, and the re-pick takes the documented " +
        "screen-out label the FIRST pass deliberately steered around: a walk dies on a retry " +
        "that attempt one would have survived, on the exact answer the hints exist to avoid",
      file: DR,
      find: "          avoid_labels: survivalAvoidLabels(decision, pathHints, after ?? before),",
      replace: "          // (recovery avoid_labels stamp dropped by mutant)",
      kills: [
        "THE RETRY REPLAY: a blocked screen's recovery re-pick steers off the flagged position-1 label",
        "the recovery consumes PATH-LEVEL hints on an unbound screen — the second avoid-label source",
      ],
    },
    {
      name: "the grid default starts consuming hints",
      breaks:
        "the one-consumer rule. Hints are calibrated for the option default's position-1 pick; " +
        "a grid answer steered by label overlap is a different act on a different control " +
        "family, taken silently — and the recorded fallback detail ('fell back to the row's " +
        "first cell') would no longer describe what was clicked",
      file: DR,
      find: "      const cell = wantedCell ?? row.cells[0];",
      replace:
        '      const cell = wantedCell ?? row.cells.find((x) => !(x.column && avoid.some((a) => labelMatches(x.column ?? "", a)))) ?? row.cells[0];',
      kills: ["the grid default ignores hints: cells[0] is clicked even when its column is a flagged label"],
    },
  ],
});

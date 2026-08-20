/**
 * EVIDENCE THAT THE BOUNDED BINDING-FAILURE RETRY'S GUARDS (D58) CAN FAIL.
 *
 * The binding retry fires when a walk blocks with constraining decisions in the plan and
 * zero matched: `bindDecision()` never identified any screen as the target of a planned
 * decision, so the walker defaulted everywhere and got stuck. Each mutant below re-opens
 * exactly one guard clause, and the named D58 test must go red for it.
 *
 *   node tools/mutate-binding-retry.mjs
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const EB = "src/workflow/stages/execute-batch.ts";

await runMutantSuite({
  title: "Bounded binding-failure retry — can the D58 guards fail?",
  filter: "d58",
  mutants: [
    {
      name: "the eligibility gate drops the BLOCKING_OUTCOMES clause",
      breaks:
        "the narrow trigger. Without the outcome check, completed and screened-out walks " +
        "trigger binding retries — the wrong feature fights the right one's outcome",
      file: EB,
      find: "  if (!BLOCKING_OUTCOMES.has(obs.outcome)) return false;",
      replace: "  // (BLOCKING_OUTCOMES clause dropped by mutant)",
      kills: [
        "only BLOCKING outcomes qualify — completed, screened-out, error, stalled all refuse",
      ],
    },
    {
      name: "the eligibility gate drops the constrainingDecisions > 0 clause",
      breaks:
        "the denominator. Without checking for constraining decisions, a walk with no " +
        "decisions at all (navigator-only plan) is retried — there was nothing to bind",
      file: EB,
      find: "  if (audit.constrainingDecisions === 0) return false;",
      replace: "  // (constrainingDecisions clause dropped by mutant)",
      kills: [
        "zero constraining decisions refuses — there is nothing to bind",
      ],
    },
    {
      name: "the eligibility gate drops the matchedConstraining > 0 clause",
      breaks:
        "the trigger polarity. Without this check, a walk where binding SUCCEEDED " +
        "(matchedConstraining > 0) is also retried — re-walking a success",
      file: EB,
      find: "  if (audit.matchedConstraining > 0) return false;",
      replace: "  // (matchedConstraining clause dropped by mutant)",
      kills: [
        "at least one matched constraining refuses — binding worked for something",
      ],
    },
    {
      name: "the eligibility gate drops the case_action clause",
      breaks:
        "sealed stimulus stops being sealed. A typed route/boundary case whose documented " +
        "answer blocks the walker would be re-walked — the planned decisions replay " +
        "identically, so the retry burns walks fighting an intended outcome",
      file: EB,
      // This is the second occurrence of this exact line in the file — the first is
      // screenoutRetryEligible, the second is bindingRetryEligible. The mutant runner
      // replaces ALL occurrences, but the d58 filter means only binding-retry tests run,
      // so the screenout gate being broken doesn't matter for kill measurement.
      find: "  if (Array.isArray(path.decisions) && path.decisions.some((d) => d && d.case_action !== undefined)) return false; // binding-retry",
      replace: "  // (case_action clause dropped by mutant) // binding-retry",
      kills: [
        "the binding-retry guard refuses a path whose decisions carry case_action — sealed stimulus is sealed",
        "a path with sealed case_action is never binding-retried",
      ],
    },
    {
      name: "the pivot cap is removed",
      breaks:
        "the bound in 'bounded'. A path whose binding keeps failing re-walks until the " +
        "batch deadline, spending the whole budget on one path",
      file: EB,
      find: "  if ((args.pivots?.[path.id] ?? 0) >= BINDING_RETRY_CAP) return false;",
      replace: "  // (pivot cap dropped by mutant)",
      kills: [
        "binding-retry pivots at the cap refuse: 2 recorded pivots end it, 1 does not",
      ],
    },
    {
      name: "the eligibility gate drops the attempt-budget clause",
      breaks:
        "the named cap. EXEC_BATCH_MAX_ATTEMPTS is not enforced for binding retries, so " +
        "a batch can exceed its attempt budget",
      file: EB,
      find: "  if (args.pathsWalked >= args.maxAttempts) return false; // binding-retry",
      replace: "  // (attempt-budget clause dropped by mutant) // binding-retry",
      kills: [
        "the attempt budget bounds the retry",
      ],
    },
  ],
});

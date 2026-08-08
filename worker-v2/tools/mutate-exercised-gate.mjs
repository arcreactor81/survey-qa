#!/usr/bin/env node
/**
 * EVIDENCE THAT THE D31 TESTS CAN FAIL.
 *
 *   node tools/mutate-exercised-gate.mjs
 *
 * D31 changes a COVERAGE GATE and an ACCUSATION. Both are the kind of change this project has
 * shipped false confidence with before — the first live run marked 119 mandatory cases
 * `exercised` off four walks that never got past a blank first screen — so "the suite is green"
 * is not evidence of anything here. Every mutant below reinstates one specific wrong behaviour
 * and names the ONE test that must go red for it. A survivor is a property nobody is testing,
 * and this exits non-zero.
 *
 * THE SET IS DELIBERATELY TWO-SIDED. Mutants 1–3 make the gate too GENEROUS (the 119 shape);
 * mutants 4–7 make the accusation too EAGER or impossible. A gate that can never pass and an
 * accusation that can never fire are the same disease as their opposites, so both directions
 * have a mutant.
 *
 * MUTANTS 1 AND 5 ARE CALL-SITE mutants — they revert the two lines in `executeBatch` itself,
 * not the helpers. They exist because a suite that only binds to exported predicates proves the
 * predicates work while the live path quietly does something else, and the only thing that can
 * kill them is the end-to-end suite that drives the real `executeBatch` against a fake page.
 *
 * NOTHING IS WRITTEN TO `src/**`: `testkit.mjs#mutantPlugin` rewrites the source inside
 * esbuild's load step, so an interrupted run leaves the working copy untouched. The kill
 * criterion is the shared, baseline-aware one in `tools/mutate-runner.mjs`.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const FILE = "src/workflow/stages/execute-batch.ts";

const MUTANTS = [
  {
    name: "CALL SITE: the gate goes back to counting EVERY planned decision",
    breaks: "a walk whose plan delegated every choice is exercised once it walked the survey",
    file: FILE,
    find: "      const audit = assessExercised(obs, item.path.decisions as PlannedDecision[] | undefined);\n      const exercised = audit.exercised;",
    replace:
      "      const audit = assessExercised(obs, item.path.decisions as PlannedDecision[] | undefined);\n" +
      "      const exercised = walkExercised(obs) && (audit.plannedDecisions === 0 || audit.matchedDecisions > 0);",
    kills: [
      "END TO END: a delegated walk closes its case and the leftover is OUR shortfall, not the site's fault",
    ],
  },
  {
    name: "THE DANGEROUS ONE: a sealed stimulus with an empty `select` stops constraining",
    breaks: "a typed case cannot close on a walk that never applied its stimulus",
    file: FILE,
    find: "  if (d.case_action) return true;\n  if (Array.isArray(d.select) && d.select.length > 0) return true;",
    replace: "  if (Array.isArray(d.select) && d.select.length > 0) return true;",
    kills: ["THE SEALED STIMULUS THAT NEVER RAN is NOT exercised — even though its `select` is empty"],
  },
  {
    name: "THE 119 SHAPE: the hard floor stops requiring that a screen advanced",
    breaks: "a walk that never got past the first screen cannot be exercised",
    file: FILE,
    find: "  return obs.steps.some((s) => s.advanced);",
    replace: "  return true;",
    kills: ["A WALK THAT DID NOTHING is not exercised, however little the plan asked of it"],
  },
  {
    name: "the hard floor accepts a walk that was capped mid-survey",
    breaks: "advancing is not finishing — a capped walk has not observed all its cases",
    file: FILE,
    find: '  if (obs.outcome !== "completed" && obs.outcome !== "no-advance-control") return false;',
    replace: '  if (obs.outcome === "error") return false;',
    kills: ["A WALK CAPPED MID-SURVEY is not exercised, even after ten screens"],
  },
  {
    name: "CALL SITE: the accusation goes back to firing on the pending count alone",
    breaks: "`walks-blocked-by-site` requires positive evidence that the site refused",
    file: FILE,
    find:
      "  stopReason = resolveStopReason({\n" +
      "    done,\n" +
      "    pendingCases: args.cursor.pendingCaseIds.length,\n" +
      "    stopReason,\n" +
      "    walks: progress.walks,\n" +
      "  });",
    replace:
      "  if (done && args.cursor.pendingCaseIds.length > 0 && stopReason === null) {\n" +
      "    stopReason = EXEC_STOP_WALKS_BLOCKED_BY_SITE;\n" +
      "  }",
    kills: [
      "END TO END: a delegated walk closes its case and the leftover is OUR shortfall, not the site's fault",
    ],
  },
  {
    name: "the survey ENDING is read as the survey BLOCKING again",
    breaks: "`no-advance-control` and `advance-timeout` are not evidence of a refusal",
    file: FILE,
    find: '    return s.blockedReason === "validation-visible" || s.blockedReason === "control-disabled";',
    replace: "    return s.blockedReason !== null && s.blockedReason !== undefined;",
    kills: ["BOTH blocking reasons count, and only those two"],
  },
  {
    name: "our own PROBE's validation message is charged to the site",
    breaks: "a probe that submits without answering must not make the survey look broken",
    file: FILE,
    find: '    if (s.decisionSource === "probe") return false;',
    replace: "    if (false) return false;",
    kills: ["OUR OWN PROBE IS NOT THE SITE'S FAULT: a probe blocked by validation is the survey WORKING"],
  },
  {
    name: "INVERTED: the accusation is made impossible",
    breaks: "a survey that genuinely blocks is still named — a gate that cannot accuse is useless",
    file: FILE,
    find: "  return walks.some((w) => BLOCKING_OUTCOMES.has(w.outcome) || (w.blockedSteps ?? 0) > 0);",
    replace: "  return false;",
    kills: ["END TO END: the SAME survey that actually blocks IS named — the live path can still accuse"],
  },
];

await runMutantSuite({
  title: "D31 exercised-gate + blocking-evidence mutants — can the coverage tests still fail?",
  // No filter. `execute-batch.ts` is on the live workflow path that D11, D13 and D30 also
  // exercise, and a baseline over only D31 would miss a mutation that reddens one of those.
  filter: "",
  mutants: MUTANTS,
});

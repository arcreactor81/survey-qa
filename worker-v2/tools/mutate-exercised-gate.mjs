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
    // RE-ANCHORED: `2755cc1` (multi-lane execution) gave `executeBatch` a second exit that ends
    // with this identical five-line call, so the bare block matched TWICE and the plugin refused
    // it — the mutant has been unappliable ever since, which is a guard reported as present and
    // never once exercised. The preceding comment is unique to the SEQUENTIAL exit, which is the
    // path the end-to-end test below drives (EXEC_LANES defaults to 1).
    find:
      "  // `resolveStopReason`. It reads the whole run's walks (durable, cumulative) rather than\n" +
      "  // this batch's, because the run-level cause is a fact about the run.\n" +
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
    // RE-ANCHORED: `hasBlockingEvidence` gained the terminal-ending exemption (completion-path
    // audit G4) and its body moved onto three lines. Same guard, same kill.
    find:
      "  return walks.some(\n" +
      "    (w) => (BLOCKING_OUTCOMES.has(w.outcome) && !reachedTerminalPage(w)) || (w.blockedSteps ?? 0) > 0,\n" +
      "  );",
    replace: "  return false;",
    kills: ["END TO END: the SAME survey that actually blocks IS named — the live path can still accuse"],
  },

  // ---- the side door the accusation came back through (completion-path audit G4/G5) ----
  // Two-sided, like everything above it: one mutant re-opens the door, two make the exemption
  // so wide the accusation can never fire again.
  {
    name: "a correctly classified screen-out is evidence of blocking again",
    breaks:
      "the poisoned input: `classifyEnding` arm 0 REQUIRES `outcome: \"blocked\"` to recognise the " +
      "measured termination page, so every screen-out this system classifies correctly becomes " +
      "proof the site refused us — and one screener probe publishes `walks-blocked-by-site` " +
      "against a healthy customer survey",
    file: FILE,
    find: "  w.ending?.kind === \"completed\" || w.ending?.kind === \"screened-out\";",
    replace: "  false;",
    kills: ["A CORRECTLY CLASSIFIED SCREEN-OUT IS NOT PROOF THE SITE REFUSED US"],
  },
  {
    name: "INVERTED: the exemption swallows walks that reached no ending at all",
    breaks:
      "an accusation that can never fire is the same disease as one that always fires. `stalled` " +
      "means the walk stopped BEFORE the ending — exempting it means a walk the site genuinely " +
      "stopped buys silence with the fact that it was stopped",
    file: FILE,
    find: "  w.ending?.kind === \"completed\" || w.ending?.kind === \"screened-out\";",
    replace: "  w.ending !== undefined;",
    kills: ["COUNTERWEIGHT — a `blocked` walk that reached NO terminal ending still accuses"],
  },
  {
    name: "INVERTED: a terminal ending also erases the refusals MEASURED on the way there",
    breaks:
      "`blockedSteps` counts steps where the walker watched the survey refuse a valid non-probe " +
      "answer. That refusal happened; walking on to a terminal page afterwards does not unhappen " +
      "it, and dropping it is how positive evidence gets discarded to keep a run quiet",
    file: FILE,
    find: "    (w) => (BLOCKING_OUTCOMES.has(w.outcome) && !reachedTerminalPage(w)) || (w.blockedSteps ?? 0) > 0,",
    replace: "    (w) => !reachedTerminalPage(w) && (BLOCKING_OUTCOMES.has(w.outcome) || (w.blockedSteps ?? 0) > 0),",
    kills: ["COUNTERWEIGHT — a MEASURED refusal mid-walk survives a terminal ending"],
  },
  {
    name: "the unsettled-bucket mapping goes back to a denylist",
    breaks:
      "'any reason that is not a `-cap`' means every code this system invents, for any purpose, " +
      "silently defaults to accusing the customer — which is how 400+ never-attempted cases were " +
      "written into a signed record as refusals by the site",
    file: "src/types/contracts.ts",
    find: '  return (SITE_REFUSAL_REASON_CODES as readonly string[]).includes(reason) ? "blocked" : "not-reached";',
    replace: '  return "blocked";',
    kills: ["only a reason that NAMES a site refusal produces `blocked`"],
  },
  {
    name: "CALL SITE: the record keeps its own private copy of the mapping",
    breaks:
      "the two readers drift apart again — the checkpoint files a case as never-reached while the " +
      "signed record published beside it files the same case as blocked by the site",
    file: "src/workflow/stages/derive-verdicts.ts",
    find: "  const status = unsettledBucketFor(reason);",
    replace: '  const status = reason === "wall-clock-cap" ? "time-exhausted" : reason && reason.endsWith("-cap") ? "budget-exhausted" : reason ? "blocked" : "not-reached";',
    kills: ["A CASE WE NEVER DROVE IS `not-reached`, NOT `blocked` — the record does not accuse the site of our shortfall"],
  },

  // ---- the deep walk's step budget (completion-path audit §5.4) ----
  {
    name: "the step-cap fallback goes back to 40",
    breaks:
      "a deploy that loses EXEC_MAX_STEPS_PER_PATH silently caps every deep walk at 40 screens on " +
      "a survey measured at ~85-100, converting the completion into `step-cap` -> `stalled`: the " +
      "run reports a walk that gave up instead of the walk that finished",
    file: FILE,
    find: "export const DEFAULT_MAX_STEPS_PER_PATH = 120;",
    replace: "export const DEFAULT_MAX_STEPS_PER_PATH = 40;",
    kills: ["the code fallback clears every shipped config's declared step cap"],
  },
  {
    name: "the resolver ignores the constant and hard-codes the old cap",
    breaks:
      "the same silent cap one layer in, and the layer the live path actually calls: every " +
      "assertion about the exported constant stays green while no real walk gets the budget",
    file: FILE,
    find: "  return num(declared, DEFAULT_MAX_STEPS_PER_PATH);",
    replace: "  return num(declared, 40);",
    kills: ["THE RESOLVER, NOT A LINE OF SOURCE: an environment with no step cap resolves to the fallback"],
  },
  // NOT MUTATED, DELIBERATELY: the `const maxSteps = resolveMaxStepsPerPath(...)` call site
  // itself. Its guard in d56 reads the source FILE, and this harness rewrites modules inside
  // esbuild's load step without touching the disk — so a mutant there could never be killed, and
  // a permanently-surviving mutant reads as a missing guard rather than as an unmutatable one.
  // The behavioural half (the resolver above) is mutated; the call site is a source-level drift
  // guard, in the same spirit as d56's amendment 3b.

  // --------------------------------------------------------- BROWSER-ABORT-CAP
  // The consecutive hard abort cap is an internal retry budget. Removing it from the
  // registry or misspelling its suffix changes how `stopCompletion` / `unsettledBucketFor`
  // classify the pending cases — either accusing the site or routing to the wrong bucket.
  {
    name: "`browser-abort-cap` removed from the EXEC_STOP_REASONS registry",
    breaks:
      "the d31 registry test would no longer list it and the test would fail, " +
      "proving the registry test is load-bearing",
    file: FILE,
    find: "  EXEC_STOP_BROWSER_ABORT_CAP,\n] as const;",
    replace: "] as const;",
    // The registry-contents test is the one that reddens: it compares the registry's exact
    // membership. The routing test reads the CONSTANT (still exported, still "-cap"-suffixed
    // under this mutant) and stays green — the first campaign run proved that, scoring this
    // mutant SURVIVED while it was pointed at the routing test.
    kills: [
      "the executor's stop-reason vocabulary is CLOSED and every non-cap reason is in it",
    ],
  },
  {
    name: "`browser-abort-cap` loses its `-cap` suffix and is misclassified",
    breaks:
      "`stopCompletion` would map a reason without the `-cap` suffix to `partial-blocked`, " +
      "which accuses the customer's site. The `-cap` suffix is what routes it to " +
      "`partial-budget` (an internal budget exhaustion)",
    file: FILE,
    find: 'export const EXEC_STOP_BROWSER_ABORT_CAP = "browser-abort-cap";',
    replace: 'export const EXEC_STOP_BROWSER_ABORT_CAP = "browser-abort-exhausted";',
    kills: [
      "`browser-abort-cap` routes to `budget-exhausted` and `partial-budget` — an honest internal shortfall, not a site accusation",
    ],
  },
];

await runMutantSuite({
  title: "D31 exercised-gate + blocking-evidence mutants — can the coverage tests still fail?",
  // No filter. `execute-batch.ts` is on the live workflow path that D11, D13 and D30 also
  // exercise, and a baseline over only D31 would miss a mutation that reddens one of those.
  filter: "",
  mutants: MUTANTS,
});

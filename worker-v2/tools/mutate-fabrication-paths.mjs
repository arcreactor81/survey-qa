#!/usr/bin/env node
/**
 * MUTANTS FOR THE LAST TWO FABRICATION PATHS (D29) — can the new guards actually fail?
 *
 *   node tools/mutate-fabrication-paths.mjs
 *
 * Every test in `tools/tests/d29-fabrication-paths.test.mjs` asserts that the system REFUSES
 * to decide, or that it decides one specific way. Refusal-shaped assertions are the exact class
 * this repository has shipped vacuously before: a predicate that returned `insufficient` for
 * everything would pass the whole first half of that file. So each mutant here reinstates one
 * specific pre-fix behaviour and NAMES the test that must newly go red.
 *
 * THE KILL CRITERION IS `tools/mutate-runner.mjs`'s: baseline-aware (only a test that was
 * PASSING before the mutation counts) and named (only the DECLARED guard counts, so a mutation
 * broad enough to redden the suite does not score as a kill of every property at once). Nothing
 * is written under `src/**` — the rewrite happens inside esbuild's load step.
 *
 * ANCHORS. Both mutated files are LF-only (checked). A mutant whose anchor no longer matches
 * exactly once is reported as BROKEN-ANCHOR and is NOT a kill: the source moved under this
 * harness and the anchor has to be re-read, not re-interpreted.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const VERIFY = "src/workflow/stages/verify-observations.ts";
const DRIVER = "src/browser/driver.ts";

const MUTANTS = [
  // ================= PATH 1 — THE BOUNDARY OUTCOME =================
  {
    name: "the pre-fix keying is restored: `blocked` OR any message means rejected",
    breaks:
      "a lost advance-timeout race is not a rejection, and a `blocked:false` silent refusal is not an acceptance",
    file: VERIFY,
    // The pre-fix line, reinstated verbatim in front of the four-state read. Everything after
    // it is unreachable, which is the point: this is the predicate as it shipped.
    find: "function readBoundaryOutcome(step: StepObservation): BoundaryRead {\n  const messages = deltaValidationMessages(step);",
    replace:
      "function readBoundaryOutcome(step: StepObservation): BoundaryRead {\n" +
      '  return step.blocked === true || (step.screenAfterAction?.validationMessages.length ?? 0) > 0\n' +
      '    ? { state: "rejected", detail: "pre-fix keying" }\n' +
      '    : { state: "accepted", detail: "pre-fix keying" };\n' +
      "  const messages = deltaValidationMessages(step);",
    kills: [
      "THE ONE THAT MATTERS: a SLOW but healthy survey must not be accused of refusing a valid input",
      "THE OTHER ARM, which the naive fix breaks: a SILENT refusal must not read as acceptance",
    ],
  },
  {
    name: "the witness goes back to PRESENCE instead of a delta",
    breaks: "a message that was already on the screen cannot be about what we just typed",
    file: VERIFY,
    find: "  const had = new Set((step.screenBefore?.validationMessages ?? []).map(norm).filter(Boolean));",
    replace: "  const had = new Set([]);",
    kills: ["THE WITNESS IS A DELTA: a cookie banner already on the screen is not a rejection of what we typed"],
  },
  {
    name: "control attribution is dropped — any message on the screen is this control's",
    breaks: "the driver types the planned value into EVERY empty text control, so a sibling's refusal is not ours",
    file: VERIFY,
    find: "  const attribution = boundaryControlAttribution(step);",
    replace: "  const attribution = { ok: true };",
    kills: [
      "ATTRIBUTION: the driver types into EVERY empty field, so a sibling's refusal decides nothing",
      "ATTRIBUTION: an unanswered option group on the same screen is a rival explanation",
    ],
  },
  {
    name: "the fourth quadrant collapses: advanced AND complaining is scored as accepted",
    breaks: "server-side validation on an error interstitial both advances and shows a message",
    file: VERIFY,
    find: "  if (step.advanced === true) {\n    if (!witnessed) {\n      return { state: \"accepted\"",
    replace: "  if (step.advanced === true) {\n    if (true) {\n      return { state: \"accepted\"",
    kills: ["THE FOURTH QUADRANT nobody enumerated: it ADVANCED and complained — decide nothing"],
  },
  {
    name: "the walker's own account of itself is promoted into a rejection",
    breaks: "`blockedReason` is a fact about the WALKER; it may name an `insufficient` and never author a verdict",
    file: VERIFY,
    find: "  if (!witnessed) {\n    return {\n      state: \"insufficient\",\n      reason: VERIFIER_REASON.BOUNDARY_REJECTION_NOT_WITNESSED,",
    replace:
      '  if (step.blockedReason === "control-disabled") return { state: "rejected", detail: "the advance control was disabled" };\n' +
      "  if (!witnessed) {\n    return {\n      state: \"insufficient\",\n      reason: VERIFIER_REASON.BOUNDARY_REJECTION_NOT_WITNESSED,",
    kills: ["THE WALKER'S REASON NAMES an `insufficient` — it never authors a rejection"],
  },

  // ================= PATH 2 — SCREEN IDENTITY =================
  {
    name: "the markup witness is dropped: a prose back-reference identifies the screen again",
    breaks: '"as you said in Q2" prints Q2 on a screen that is not Q2, and the accusing arm may not guess',
    file: VERIFY,
    find: "      if (!identity.markup.includes(other)) {",
    replace: "      if (false) {",
    kills: ["THE ONE THAT MATTERS: a screen that says 'as you said in Q2' must not be reported AS Q2"],
  },
  {
    name: "the seam stops distinguishing the two readings — everything counts as markup",
    breaks: "provenance is the whole point of the seam; without it the accusing arm is unguarded again",
    file: VERIFY,
    // RE-ANCHORED for 1.4.0. The seam gained a THIRD witness (the document's own wording), so
    // the union is now built into `ids` on its own line and the return names four fields. The
    // property under test is unchanged and the mutation is the same one: collapse the
    // provenance by declaring the whole union to be markup, which un-guards the accusing arm.
    find: "  return { ids, text: [...new Set(text)], markup, wording };",
    replace: "  return { ids, text: [...new Set(text)], markup: ids, wording };",
    kills: ["THE ONE THAT MATTERS: a screen that says 'as you said in Q2' must not be reported AS Q2"],
  },
  {
    name: "FAIL-SILENT CHECK: the accusing arm refuses even WITH the markup witness",
    breaks: "fail-closed must not become fail-silent — a real routing defect stays claimable",
    file: VERIFY,
    find: "      if (!identity.markup.includes(other)) {",
    replace: "      if (true) {",
    kills: [
      "THE SAME SCREEN WITH THE MARKUP WITNESS is a mismatch — the split buys accuracy, not silence",
      "MARKUP ALONE is enough — the survey that prints no ids anywhere keeps its mismatch",
    ],
  },

  // ================= THE WALKER'S HALF =================
  {
    name: "the walker stops recording why it stopped",
    breaks: "the verifier must READ a witness rather than reconstruct one from `blocked`",
    file: DRIVER,
    find: "      blockedReason: advanced ? null : whyBlocked(before, afterAction, after),",
    replace: "      blockedReason: null,",
    kills: [
      "A LOST RACE is `advance-timeout` — the case that must never read as a rejection",
      "A MESSAGE THAT APPEARED is `validation-visible` — and it has to be NEW",
      "AN ADVANCE CONTROL THAT WENT AWAY is `control-disabled`",
    ],
  },
  {
    name: "the walker's message check goes back to PRESENCE",
    breaks: "a banner that was there before the submit is not this submit's validation message",
    file: DRIVER,
    find: "  const had = new Set((before?.validationMessages ?? []).map(normMsg).filter(Boolean));",
    replace: "  const had = new Set([]);",
    kills: ["A MESSAGE THAT WAS ALREADY THERE is not one: the cookie banner does not make it a rejection"],
  },
  {
    name: "the no-advance-control path stops naming itself",
    breaks: "the `blocked:false` + `advanced:false` shape is invisible unless the walker names it",
    file: DRIVER,
    find: '        blockedReason: "no-advance-control",',
    replace: "        blockedReason: null,",
    kills: ["NO ENABLED ADVANCE CONTROL AT ALL is `no-advance-control` — the `blocked:false` trap"],
  },
];

await runMutantSuite({
  title: "D29 fabrication-path mutants — can the four-state boundary and the identity seam fail?",
  // No filter: these mutants reach D15/D16/D19/D24 as well as D29, and a baseline over a
  // subset of the suite is not a baseline for a mutation that can reach the rest of it.
  filter: "",
  mutants: MUTANTS,
});

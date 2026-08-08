#!/usr/bin/env node
/**
 * EVIDENCE THAT THE D23 TESTS CAN FAIL.
 *
 *   node tools/mutate-payload-trust.mjs
 *
 * D23 closes a hole that was DORMANT: no producer in the tree sets `payload.error` or
 * `payload.contradiction`, so the whole suite was 217/217 both before and after the fix. That is
 * exactly the condition under which a new test proves nothing — it passes on the fixed code, and
 * it would have passed on the broken code too if the fixture had not been written to poison the
 * payload deliberately. "It passes now" and "it would notice if the behaviour came back" are
 * different claims, and only this file establishes the second one.
 *
 * So each mutant below REINSTATES the defect in a different way and asserts that THE NAMED TESTS
 * WHICH GUARD IT newly fail:
 *
 *   1. the single-line promotion — the floor authors a verdict again;
 *   2. the ORIGINAL branch, byte-for-byte, including its retired reason code;
 *   3. the branch DELETED rather than demoted — the other way to get this wrong, and the reason
 *      the fix demotes instead of removing. With the branch gone the poisoned observation falls
 *      through to the route predicate and a healthy walk CERTIFIES an observation whose own
 *      producer said it had errored.
 *
 * `kills` is the whole point: a mutation broad enough to redden the suite proves nothing about
 * any particular property, and `mutate-runner.mjs` refuses to count it. The kill criterion, the
 * baseline handling and the harness's own no-op self-check live there — see its header for the
 * defect they exist to close.
 *
 * NOTHING IS WRITTEN TO `src/**`. The rewrite happens inside esbuild's load step
 * (`testkit.mjs#mutantPlugin`), so an interrupted run leaves no mutated working copy behind.
 *
 * ANCHORS. `verify-observations.ts` is LF-only (checked), and the two single-line anchors below
 * were each verified to occur EXACTLY ONCE by count, not by eye. If this file ever reports
 * BROKEN-ANCHOR the source moved — re-read it and re-anchor. A BROKEN-ANCHOR is not a kill and
 * must never be accepted as one.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const VERIFY = "src/workflow/stages/verify-observations.ts";

/** The three tests that assert the floor may not author a verdict out of the payload. */
const NEVER_A_VERDICT = [
  "THE ONE THAT MATTERS: a model-observation's own `error` key must not mint a defect claim",
  "the same for a `contradiction` key — the guard is an OR and both halves are producer-written",
  "the floor still DEMOTES what it always demoted: no evidence cited is still `insufficient`",
];

const MUTANTS = [
  {
    name: "THE PROMOTION IS BACK: the structural floor authors a verdict from the producer's payload",
    breaks: "an evidence-blind step may demote, but may never author a verdict",
    file: VERIFY,
    // Six-space indent: the only `outcome:` line inside the floor's returned literal. The
    // `insufficient()` helper's copy is two-space, so this matches once.
    find: '      outcome: "insufficient",',
    replace: '      outcome: "violated",',
    kills: NEVER_A_VERDICT,
  },
  {
    name: "THE ORIGINAL BRANCH, BYTE-FOR-BYTE — `violated` + STRUCTURAL_CONTRADICTION",
    breaks: "producer-supplied payload keys become a `contradicted`, and from there a client-visible `fail`",
    file: VERIFY,
    find:
      "    return {\n" +
      '      outcome: "insufficient",\n' +
      "      reason: VERIFIER_REASON.PRODUCER_FLAGGED_PAYLOAD_UNVERIFIED,\n" +
      '      predicate: "structural",\n' +
      "      detail:\n" +
      '        "the observation\'s own payload carries a producer-authored contradiction/error key; that is the " +\n' +
      "        \"producer's word about itself, not evidence, so it withholds a pass and claims no defect\",\n" +
      "    };",
    replace:
      "    return {\n" +
      '      outcome: "violated",\n' +
      "      reason: VERIFIER_REASON.STRUCTURAL_CONTRADICTION,\n" +
      '      predicate: "structural",\n' +
      '      detail: "the observation carries its own contradiction or error payload",\n' +
      "    };",
    kills: NEVER_A_VERDICT,
  },
  {
    name: "DEMOTED, NOT DELETED: the branch is removed instead, so a flagged observation is CERTIFIED",
    breaks: "an observation whose producer flagged an error cannot support a pass either",
    file: VERIFY,
    find: "  if (payload && (payload.contradiction || payload.error)) {",
    replace: "  if (false) {",
    kills: [
      "THE ONE THAT MATTERS: a model-observation's own `error` key must not mint a defect claim",
      "a producer-flagged payload is not promoted to a PASS either — the demotion was kept, not deleted",
      "the floor still DEMOTES what it always demoted: no evidence cited is still `insufficient`",
    ],
  },
];

await runMutantSuite({
  title: "D23 payload-trust mutants — can the new tests still fail?",
  // No filter. The floor runs for EVERY observation in the suite, so a mutation of it can reach
  // tests far outside D23; a baseline over a subset would not be a baseline for that.
  filter: "",
  mutants: MUTANTS,
});

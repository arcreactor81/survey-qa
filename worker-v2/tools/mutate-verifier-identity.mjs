#!/usr/bin/env node
/**
 * EVIDENCE THAT THE D35 TESTS CAN FAIL.
 *
 *   node tools/mutate-verifier-identity.mjs
 *
 * D35 adds a THIRD screen-identity witness to the file that decides truth, and a VETO that lets
 * the walker's refusals withhold a verdict. Both are exactly the kind of change this repository
 * has shipped false confidence with before — a 340/340 green suite once shipped a crash that
 * killed a run in one second — so "the new tests pass" is not evidence of anything. Each mutant
 * below reinstates one specific wrong behaviour and names the ONE test that must go red for it.
 *
 * THE SET IS DELIBERATELY TWO-SIDED, because for a fail-closed verifier the two failure modes
 * are equal and opposite:
 *
 *   TOO GENEROUS (1, 2, 3, 6)  the accusing arm accepts a prose-class witness; a wording tie is
 *                              broken silently; a paraphrase counts as an identification; the
 *                              walker's refusal is ignored. Each of these ends in a confident
 *                              wrong answer, which is this product's cardinal failure.
 *   TOO SILENT (4, 5, 7)       the witness is dropped from the union (back to the null run); the
 *                              bar is raised until nothing binds; the veto fires on any refusal
 *                              at all. Fail-closed must not become fail-silent, so a guard that
 *                              can never let anything through needs a mutant too.
 *
 * NOTHING IS WRITTEN TO `src/**`. The rewrite happens inside esbuild's load step
 * (`testkit.mjs#mutantPlugin`), so an interrupted run leaves no mutated working copy behind. The
 * kill criterion, the baseline handling and the harness's own no-op self-check live in
 * `tools/mutate-runner.mjs` — see the header there for the defect they exist to close.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const VERIFY = "src/workflow/stages/verify-observations.ts";

const MUTANTS = [
  // ------------------------------------------------- the accusing arm's witness
  {
    name: "the accusation accepts ANY witness — a wording match is enough to name a destination",
    breaks: "wording is document prose matched against screen prose; only MARKUP may accuse",
    file: VERIFY,
    // `other` is drawn from `alsoPresent`, which is a subset of `identity.ids`, so this
    // condition is always false and the arm falls straight through to `violated`.
    find: "      if (!identity.markup.includes(other)) {",
    replace: "      if (!identity.ids.includes(other)) {",
    kills: ["THE LINE THAT DID NOT MOVE: a destination identified by WORDING ALONE may not accuse"],
  },

  // ------------------------------------------------------------- the wording witness
  {
    name: "a wording TIE is broken silently — the higher score wins",
    breaks: "two questions describing one screen equally is a refusal, not a ranking",
    file: VERIFY,
    find: "  const separated = !runnerUp || runnerUp.score <= 0 || top.score >= runnerUp.score * WORDING_MARGIN_RATIO;",
    replace: "  const separated = true;",
    kills: [
      "FAIL-CLOSED: a wording TIE refuses — both tied ids enter the union, and a tie-break would be a guess",
      "CROSS-MODULE AGREEMENT: the real binder and the real identity seam reach the same conclusion",
    ],
  },
  {
    name: "the bind threshold is dropped — a paraphrase counts as an identification",
    breaks: "the driver refuses under 0.70 and the verifier must refuse with it",
    file: VERIFY,
    find: "  if (top.score < WORDING_BIND_MIN) return [];",
    replace: "  if (false) return [];",
    kills: ["CROSS-MODULE AGREEMENT: the real binder and the real identity seam reach the same conclusion"],
  },
  {
    name: "the bind threshold is raised out of reach — the witness can never fire",
    breaks: "a guard that can never let anything through is fail-SILENT, not fail-closed",
    file: VERIFY,
    find: "  if (top.score < WORDING_BIND_MIN) return [];",
    replace: "  if (top.score < 1.01) return [];",
    kills: ["YIELD: a survey that prints NO ids and names NO controls now reaches a verdict"],
  },
  {
    name: "the wording witness is dropped from the identity union",
    breaks: "the union is where a new witness earns its yield; without it D35 is the 1.3.0 null run",
    file: VERIFY,
    find: "  const ids = [...new Set([...text, ...markup, ...wording])];",
    replace: "  const ids = [...new Set([...text, ...markup])];",
    kills: ["YIELD: a survey that prints NO ids and names NO controls now reaches a verdict"],
  },

  // ------------------------------------------------------------------ the vetoes
  {
    name: "the walker's refusal of THIS screen is ignored",
    breaks: "when the two identity readings disagree, neither half may settle it alone",
    file: VERIFY,
    find: "    const refusal = (only.bindingRefusals ?? []).find((r) => r && r.question === target);",
    replace: "    const refusal = undefined;",
    kills: ["VETO: the walker refused THIS screen for THIS question, and the verifier stands down"],
  },
  {
    name: "the refusal veto goes BLANKET — any refusal on the step kills the case",
    breaks: "a veto that fires on another question's refusal is fail-silent wearing fail-closed's clothes",
    file: VERIFY,
    find: "    const refusal = (only.bindingRefusals ?? []).find((r) => r && r.question === target);",
    replace: "    const refusal = (only.bindingRefusals ?? []).find((r) => !!r);",
    kills: ["VETO: a refusal about ANOTHER question is not this case's — the veto is precise, not blanket"],
  },
  {
    name: "the walk's own account of what it never bound is ignored",
    breaks: "a step bound to a question the walker never bound was answered by the navigator's default",
    file: VERIFY,
    find: "  const neverBound = (walk.unboundDecisions ?? []).find((u) => u && u.question === target);",
    replace: "  const neverBound = undefined;",
    kills: ["VETO: the walk says it never bound a decision to this question at all"],
  },
];

await runMutantSuite({
  title: "D35 — the wording witness and the walker's vetoes",
  filter: "",
  mutants: MUTANTS,
});

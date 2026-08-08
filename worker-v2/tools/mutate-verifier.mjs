#!/usr/bin/env node
/**
 * EVIDENCE THAT THE D15/D16 NEGATIVE TESTS CAN FAIL.
 *
 *   node tools/mutate-verifier.mjs
 *
 * D15 and D16's negative half is the load-bearing half: it is what proves a verdict cannot be
 * fabricated. Those tests were dark from 5 Aug 06:29 until this run's fixture repair, and a
 * test that has just been un-dark-ed is exactly the one you must not take on trust — "it
 * passes now" and "it would notice if the behaviour broke" are different claims.
 *
 * So each mutant below REVERTS one specific guarantee to the shape it would have if nobody
 * had implemented it — a verifier that trusts the producer's summary, a floor that stops
 * demoting, a predicate registry with a default arm — and asserts that THE NAMED TEST WHICH
 * GUARDS IT newly fails. `kills` is the whole point: a mutation broad enough to redden the
 * suite proves nothing about any particular property, and the runner refuses to count it.
 *
 * NOTHING IS WRITTEN TO `src/**`. The rewrite happens inside esbuild's load step
 * (`testkit.mjs#mutantPlugin`), which is what makes it safe to mutate `verify-observations.ts`
 * and `plan.ts` in a session that is forbidden to edit them, and what guarantees an
 * interrupted run leaves no mutated working copy behind.
 *
 * The kill criterion, the baseline handling and the harness's own no-op self-check live in
 * `tools/mutate-runner.mjs` — see the header there for the defect they exist to close.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const VERIFY = "src/workflow/stages/verify-observations.ts";
const PROJECT = "src/workflow/stages/project-observations.ts";
const INPUTS = "src/workflow/stages/run-inputs.ts";

const MUTANTS = [
  // ---------------------------------------------------------------- projection
  {
    name: "the projection authors a verdict instead of leaving it to the verify stage",
    breaks: "no stage but `verify` may write `observation.verifier.decision`",
    file: PROJECT,
    find: '        verifier: { decision: "insufficient", evidenceIds, verifierVersion: "none/not-yet-verified" },',
    replace: '        verifier: { decision: "verified", evidenceIds, verifierVersion: "projection-authored/1.0.0" },',
    kills: ["the projection authors NO verifier decision — that is the verify stage's job alone"],
  },
  {
    name: "a walk that closed no cases is counted as a contributing walk",
    breaks: "a blocked site contributes nothing rather than a contradiction",
    file: PROJECT,
    find: "    if (caseIds.length === 0) continue; // a walk that closed nothing observed nothing it may claim",
    replace: "    // mutant: the empty-walk guard is gone",
    kills: ["a walk that closed NO cases mints no observation — a blocked site is not a failed survey"],
  },

  // ------------------------------------------------------- the structural floor
  {
    name: "the structural floor stops demoting an observation that cites no evidence",
    breaks: "an observation citing no evidence cannot support a positive claim",
    file: VERIFY,
    find: "  if (!Array.isArray(o.evidenceIds) || o.evidenceIds.length === 0) {",
    replace: "  if (false) {",
    kills: ["NEGATIVE: a walk that captured nothing cites no evidence, and cannot support a positive claim"],
  },

  // ------------------------------------------------- expectation, from the seal
  {
    name: "a case the sealed revision does not carry is passed anyway",
    breaks: "there is no expectation to check against, so there can be no pass",
    file: VERIFY,
    find:
      "  if (!sealedCase) {\n" +
      "    return insufficient(\n" +
      '      "expectation",\n' +
      "      VERIFIER_REASON.NO_SEALED_CASE,\n" +
      "      `no sealed execution case ${o.facetInstanceId} in the contract revision, so there is no expectation to check against`,\n" +
      "    );\n" +
      "  }",
    replace:
      "  if (!sealedCase) {\n" +
      "    return {\n" +
      '      outcome: "satisfied",\n' +
      '      predicate: "expectation",\n' +
      "      reason: VERIFIER_REASON.ROUTE_DESTINATION_REACHED,\n" +
      '      detail: "fabricated: passed a case the seal does not carry",\n' +
      "    };\n" +
      "  }",
    kills: ["NEGATIVE: a sealed case the revision does not carry can never be verified"],
  },
  {
    name: "the predicate registry acquires a default arm — an unregistered kind passes",
    breaks: "a case kind no predicate is registered for can never be promoted",
    file: VERIFY,
    find:
      "  if (!expectation || !predicate) {\n" +
      "    return insufficient(\n" +
      '      "expectation",\n' +
      "      VERIFIER_REASON.NO_TYPED_EXPECTATION,\n" +
      "      expectation\n" +
      '        ? `execution case kind "${expectation.kind}" carries no expectation this verifier can decide without reading the document`\n' +
      '        : "the sealed execution case carries no typed case payload",\n' +
      "    );\n" +
      "  }",
    replace:
      "  if (!expectation || !predicate) {\n" +
      "    return {\n" +
      '      outcome: "satisfied",\n' +
      '      predicate: "expectation",\n' +
      "      reason: VERIFIER_REASON.ROUTE_DESTINATION_REACHED,\n" +
      '      detail: "fabricated: a kind with no registered predicate was passed anyway",\n' +
      "    };\n" +
      "  }",
    kills: ["a case kind with no model-free expectation stays `insufficient`, however good the walk was"],
  },
  {
    name: "an UNBOUND destination is filled in with a guess instead of refusing",
    breaks: "a destination the expander could not bind never becomes an expectation to check",
    file: VERIFY,
    find:
      "    const answer = expectation.routeAnswer;\n" +
      "    const dest = expectation.expectedDestination;",
    replace:
      "    const answer = expectation.routeAnswer;\n" +
      "    const dest = expectation.expectedDestination ?? " +
      "{ questionId: expectation.routeAnswer?.label ?? null, screen: null, terminal: null };",
    kills: ["NEGATIVE: THE ONE THAT MATTERS — an unbound destination cannot verify even when the screen spells it"],
  },

  // --------------------------------------- the re-read: bytes, not the payload
  {
    name: "an observation with no artifact pointer is trusted instead of refused",
    breaks: "with no bytes to re-read there is nothing to compare, so nothing may pass",
    file: VERIFY,
    find:
      "  if (!artifactId) {\n" +
      "    return insufficient(\n" +
      "      predicate.id,\n" +
      "      VERIFIER_REASON.ARTIFACT_NOT_LOCATED,\n" +
      '      "the observation cites no walk artifact, so there are no bytes to re-read and nothing to compare",\n' +
      "    );\n" +
      "  }",
    replace:
      "  if (!artifactId) {\n" +
      "    return {\n" +
      '      outcome: "satisfied",\n' +
      "      predicate: predicate.id,\n" +
      "      reason: VERIFIER_REASON.ROUTE_DESTINATION_REACHED,\n" +
      '      detail: "fabricated: trusted an observation with no artifact to re-read",\n' +
      "    };\n" +
      "  }",
    kills: ["NEGATIVE: an observation citing no walk artifact cannot be verified"],
  },
  {
    name: "THE RE-READ IS ABANDONED: evidence that will not re-read is passed on the producer's word",
    breaks: "a verdict must not survive the loss of the bytes it was supposedly derived from",
    file: VERIFY,
    find:
      "  const walk = await readArtifact(artifactId);\n" +
      "  if (!walk) {\n" +
      "    return {\n" +
      '      outcome: "error",\n' +
      "      reason: VERIFIER_REASON.ARTIFACT_UNREADABLE,",
    replace:
      "  const walk = await readArtifact(artifactId);\n" +
      "  if (!walk) {\n" +
      "    return {\n" +
      '      outcome: "satisfied",\n' +
      "      reason: VERIFIER_REASON.ROUTE_DESTINATION_REACHED,",
    kills: ["NEGATIVE: THE RE-READ IS REAL — delete the cited bytes and the same run stops verifying"],
  },
  {
    name: "A HAND-WRITTEN `verified` IS PRESERVED instead of being overruled by the artifact",
    breaks: "the verify stage's decision replaces whatever the observation claimed about itself",
    file: VERIFY,
    find:
      "    verified.push({\n" +
      "      ...o,\n" +
      "      verifier: {\n" +
      "        decision: OUTCOME_TO_DECISION[result.outcome],",
    replace:
      "    verified.push({\n" +
      "      ...o,\n" +
      "      verifier: {\n" +
      '        decision: o.verifier?.decision === "verified" ? "verified" : OUTCOME_TO_DECISION[result.outcome],',
    kills: ["THE ONE THAT MATTERS MOST: an observation ASSERTING it passed is overruled by its own artifact"],
  },

  // ------------------------------------------------------ the route predicate
  {
    name: "the documented answer no longer has to have been selected",
    breaks: "a destination reached down another branch witnesses nothing about this case",
    file: VERIFY,
    find: "      performed: (s) => selectedAnswer(s, answer.code, answer.label),",
    replace: "      performed: () => true,",
    kills: ["NEGATIVE: the walk never selected the documented answer — the branch was never exercised"],
  },
  {
    name: "a survey that never advanced is treated as having reached a destination",
    breaks: "no advance means no destination was reached",
    file: VERIFY,
    find: "    if (!step.advanced || !step.screenAfterAdvance) {",
    replace: "    if (false) {",
    kills: ["NEGATIVE: the answer was selected but the survey never advanced"],
  },
  {
    name: "landing on a DIFFERENT sealed question is scored as a pass",
    breaks: "a walk that went somewhere else is contradicted, never verified",
    file: VERIFY,
    // RE-ANCHORED for 0.2. The arm now refuses when the foreign id is carried by rendered
    // prose alone (a back-reference is not an identity), so the old four-line anchor spanning
    // `if (other) {` straight into the return no longer matches and would report BROKEN-ANCHOR
    // rather than a kill. The property under test is unchanged: landing somewhere else must
    // never be scored as arriving.
    find: '        outcome: "violated",\n        reason: VERIFIER_REASON.ROUTE_DESTINATION_MISMATCH,',
    replace: '        outcome: "satisfied",\n        reason: VERIFIER_REASON.ROUTE_DESTINATION_MISMATCH,',
    kills: [
      "NEGATIVE: the walk landed on a DIFFERENT documented screen — contradicted, never verified",
      "NEGATIVE: a typed case whose walk landed elsewhere is CONTRADICTED, never verified",
    ],
  },
  {
    name: "an unidentifiable destination is turned into a FABRICATED failure",
    breaks: "absence of the expected token is not evidence of a wrong destination",
    file: VERIFY,
    find:
      "    return insufficient(\n" +
      "      this.id,\n" +
      "      VERIFIER_REASON.DESTINATION_NOT_IDENTIFIABLE,\n" +
      "      `the reached screen presents neither ${wanted} nor any other sealed question id — not in its rendered text ` +\n" +
      "        `and not in its controls' name/id attributes — so the destination cannot be identified`,\n" +
      "    );",
    replace:
      "    return {\n" +
      '      outcome: "violated",\n' +
      "      predicate: this.id,\n" +
      "      reason: VERIFIER_REASON.ROUTE_DESTINATION_MISMATCH,\n" +
      '      detail: "fabricated: the expected token was simply absent",\n' +
      "    };",
    kills: ["NEGATIVE: the destination cannot be identified — `insufficient`, and NOT a fabricated fail"],
  },

  // ------------------------------------------------------------- signing posture
  {
    name: "a signing key materializes when none was configured",
    breaks: "the run stays diagnostic-only; no key is bypassed or defaulted into existence",
    file: INPUTS,
    find: '  const pem = (v: string | undefined) => (v && v.includes("PRIVATE KEY") ? v.replace(/\\\\n/g, "\\n") : null);',
    replace:
      '  const pem = (v: string | undefined) => (v && v.includes("PRIVATE KEY") ? v.replace(/\\\\n/g, "\\n") : ' +
      '"-----BEGIN PRIVATE KEY-----fabricated-----END PRIVATE KEY-----");',
    kills: ["NEGATIVE: the run stays diagnostic-only — no signing keys were configured and none are bypassed"],
  },
];

await runMutantSuite({
  title: "D15/D16 negative-verification mutants — can the restored tests still fail?",
  // No filter: the guarded tests span D15 and D16, and a baseline over a subset of the suite
  // is not a baseline for a mutation that can reach the rest of it.
  filter: "",
  mutants: MUTANTS,
});

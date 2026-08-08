#!/usr/bin/env node
/**
 * EVIDENCE THAT THE D33 TESTS CAN FAIL.
 *
 *   node tools/mutate-claims.mjs
 *
 * "Beware the check that cannot fail" (CLAUDE.md). D33 asserts that a run's failing verdicts
 * reach the signed record as claims and that its load crash reaches it as a blocker — and BOTH
 * halves are the shape that passes trivially. Most of the file's assertions live inside a loop
 * over `record.claims`, so an empty claims list satisfies them all; that is precisely the
 * regression under test, and the first draft of the traceability test passed over zero claims
 * until a non-vacuity guard was added. This harness is the proof it now cannot.
 *
 * THE SEAM `tsc` CANNOT SEE. `assemble-record.ts` imports the assembler under `@ts-ignore`
 * because the module is untyped ESM shared with the offline pipeline. `npx tsc --noEmit` is
 * therefore green whether the stage passes `walks`, passes the old `claims: []`, or passes
 * neither — MUTANT 2 is the only thing that checks it, and it is the mutant closest to how
 * the original defect was introduced.
 *
 * MUTANT 1 IS THE PRODUCTION DEFECT ITSELF: the record storing a literal empty claims array
 * over two real `contradicted` verdicts, exactly as run v2r_01kzfktf3qj9qazn86t1y0yx5k did.
 *
 * NOTHING IS WRITTEN TO `src/**`. `testkit.mjs#mutantPlugin` rewrites the source inside
 * esbuild's load step, so an interrupted run cannot leave a mutated working copy behind —
 * which matters in a tree several agents are editing right now.
 *
 * The kill criterion lives in `tools/mutate-runner.mjs`: baseline-aware, and a mutant that
 * declares `kills` is killed only by THOSE NAMED TESTS going newly red.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const CORE = "src/workflow/stages/assemble-record.mjs";
const STAGE = "src/workflow/stages/assemble-record.ts";

const T_MAIN = "THE ONE THAT MATTERS: two failing verdicts produce two claims in the SIGNED record, not []";
const T_PROSE = "the claim's prose is the VERIFIER'S OWN sentence, verbatim — never a paraphrase";
const T_TRACE = "every claim is traceable to evidence ids that exist in THIS record's own catalogue";
const T_ZERO = "THE COUNTERWEIGHT: a run with zero fail verdicts produces zero claims";
const T_BLOCKED =
  "a contradicted observation on a case the CURSOR blocked yields no claim — the aggregator decides, not the projection";
const T_INSUFF = "an `insufficient` decision beside a failing sibling never becomes a claim";
const T_CRASH = "THE LOAD CRASH SURFACES: the target that rendered nothing is a blocker naming its own evidence";
const T_SHIM = "the shim that made the rest of the run possible is itself a blocker on every later observation";
const T_NOLEDGER = "NO LEDGER IS NOT A CLEAN LEDGER: a run with no execution progress blocks on saying so";
const T_EMPTY = "an EMPTY ledger is a different fact from a MISSING one and blocks nothing";
const T_COUNTS = "the stage's reported counts are the STORED record's counts — it cannot report findings it did not persist";
const T_MIXED =
  "a FAILING case holding both a contradicted and an insufficient observation claims only the contradicted one";
const T_ORPHAN = "a failing case citing an observation the record does not carry is NAMED, never quietly dropped";

const MUTANTS = [
  {
    name: "THE PRODUCTION DEFECT: the record stores a literal empty claims array again",
    breaks: "a run's failing verdicts must reach the signed record as claims",
    file: CORE,
    find: "  const claims = deriveClaims({ itemResults, observations });",
    replace: "  const claims = [];",
    kills: [T_MAIN, T_PROSE, T_TRACE, T_COUNTS],
  },
  {
    name: "THE SEAM tsc CANNOT SEE: the stage stops handing the assembler its walk ledger",
    breaks: "the load crash and the shim caveat both come from the ledger the stage must pass",
    file: STAGE,
    find: "    walks,\n",
    replace: "",
    kills: [T_CRASH, T_SHIM, T_EMPTY],
  },
  {
    name: "blockers are hardcoded empty in the assembler again",
    breaks: "the record must carry what qualifies every result in it",
    file: CORE,
    find: "    blockers: arr(blockers),",
    replace: "    blockers: [],",
    kills: [T_CRASH, T_SHIM, T_NOLEDGER, T_COUNTS],
  },
  {
    name: "THE PROJECTION AUTHORS ITS OWN FINDINGS: every gate on the derivation removed",
    breaks:
      "a claim may only project a verdict the aggregator already derived — never reach past it to the observation",
    file: CORE,
    find:
      '    if (r?.verdict !== "fail" && r?.verdict !== "mixed") continue;\n' +
      "    for (const f of arr(r.facetResults)) {\n" +
      '      if (f?.status !== "fail") continue;\n' +
      "      for (const observationId of arr(f.observationIds)) {\n" +
      "        const o = byId.get(observationId);",
    replace:
      "    for (const f of arr(r.facetResults)) {\n" +
      "      for (const observationId of arr(f.observationIds)) {\n" +
      "        const o = byId.get(observationId);",
    // NAMED PRECISELY, and the narrowing is itself a finding. The first version of this mutant
    // also named the zero-fail counterweight and the insufficient-sibling test, and BOTH
    // survived — correctly. Neither is guarded by the verdict or case-status filters: the
    // all-pass fixture is saved by the DECISION filter this mutant leaves intact, and the
    // insufficient sibling by the same. What these two guards actually defend is a case the
    // aggregator settled some OTHER way, which is what T_BLOCKED tests.
    kills: [T_MAIN, T_BLOCKED],
  },
  {
    name: "the decision filter is dropped: an `insufficient` observation on a FAILING case becomes a defect",
    breaks: "only a decision that maps to `fail` through the aggregator's own table may be claimed",
    file: CORE,
    find: '        if (DECISION_TO_STATUS[o?.verifier?.decision] !== "fail") continue;\n',
    replace: "",
    // THIS MUTANT SURVIVED THE FIRST RUN OF THIS HARNESS, and the fixture was wrong, not the
    // mutant: every insufficient observation sat on a case the verdict or status filter already
    // rejected, so nothing exercised the decision filter on its own. `fi_bound_fail` now carries
    // a contradicted AND an insufficient observation — the one position where this filter is the
    // only thing standing between a verifier saying "the document states nothing to check here"
    // and a published defect claim about a customer's survey.
    kills: [T_MIXED, T_MAIN],
  },
  {
    name: "a failing case whose observation is missing is skipped in silence",
    breaks: "an unresolvable fail must be NAMED as a blocker, not dropped into a shorter findings list",
    file: CORE,
    find: "        if (known.has(observationId)) continue;\n",
    replace: "        continue;\n",
    kills: [T_ORPHAN],
  },
  {
    name: "the crash blocker sweeps every artifact of the attempt, retry screenshots included",
    breaks: "a crashed path is RETRIED under the same attempt id, so 'all evidence of this attempt' is wrong",
    file: CORE,
    find: '  const traces = onWalk.filter((e) => e?.type === "trace");',
    replace: "  const traces = onWalk;",
    kills: [T_CRASH],
  },
  {
    name: "the claim's prose is composed rather than quoted",
    breaks: "prose must be the verifier's own sentence — the one part of a claim nothing else checks",
    file: CORE,
    find: '  if (typeof detail === "string" && detail.length > 0) return detail;',
    replace:
      '  if (typeof detail === "string" && detail.length > 0) return `the site diverged from the document: ${detail}`;',
    kills: [T_PROSE],
  },
];

await runMutantSuite({
  title: "D33 — evidence the claims/blockers guards can fail",
  // Scoped to D33 so the baseline is this file's own tests. The tree is being edited by other
  // agents; a whole-suite baseline would drag their in-flight red into every score, and the
  // runner would then refuse the mutants whose guards it thinks are already broken.
  filter: "D33",
  mutants: MUTANTS,
});

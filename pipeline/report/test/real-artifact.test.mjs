// THE ACCEPTANCE PROOF. Nothing in this file is hand-authored.
//
// Three review rounds in a row, this build proved that its components REFUSE
// bad input while faking the proof that they ACCEPT good input. Round 2's
// "happy path" fixture was a hand-authored hybrid, and GPT's ruling on it was
// exact: "The enriched happy fixture has been shaped to fit the consumer; it is
// not representative of real judge output. ... its witness could not be emitted
// by the real judge."
//
// So this test does not build a JudgementRecord. It RUNS THE REAL JUDGE
// (pipeline/judge/lib/engine.mjs) over the REAL frozen run at
// pipeline/runs/t1-easy — 119 obligations, 103 signed artifacts, real
// predicates, real witnesses, real per-witness attestations — and asserts that
// what the real producer emits crosses the report's trust boundary, drives a
// current column, and renders.
//
// WHAT IS AUTHORED, STATED PLAINLY: the frozen run predates contract sealing,
// and the real judge refuses (correctly) to mint a publishable record against
// an unsealed denominator. `make-acceptance-artifact.mjs` therefore seals that
// run's contract revision with the content-derived identity rule the worker's
// `computeRevisionId` uses, marks it `sealed-unreviewed` (automated seal, NO
// human review) and re-signs the run record with the key that already signed
// it. That is an INPUT-enabling change. Every field this test asserts on —
// predicate identity and outcome, witness structure, locators, hashes,
// individual attestations, the aggregate re-verification claim, binding
// versions, producer status — is produced by the judge, not by this file.
//
// WHAT THIS DOES NOT PROVE: the RunRecordV2 -> Worker -> report seam (D1),
// which is owned by another track and was still broken when this was written.
// This proves the judge -> report half.

import test from "node:test";
import assert from "node:assert/strict";

import { produceAcceptanceArtifact, KEY_REGISTRY_PATH } from "../make-acceptance-artifact.mjs";
import {
  evaluateJudgement,
  registryFor,
  validateResultProof,
  recordLevelProofProblems,
  recomputeWitnessAttestation,
} from "../lib/judgement-record.mjs";
import { evaluatePassPublication } from "../lib/publication.mjs";
import { buildReportView } from "../lib/view-model.mjs";
import { renderReportHtml } from "../lib/render-html.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SUBSTRATE_RUN, SUBSTRATE_RUN_ID } from "../../runs/run-source.mjs";

const KEY_REGISTRY = registryFor(KEY_REGISTRY_PATH);

// WHICH RUN. The claim under test is "the report accepts what the real judge
// really emits", which is a property of the producer, not of one survey. The
// substrate is `pipeline/runs/t1-easy` when that (blind-derived, held for the
// staggered push) run is in the checkout, and the public
// `pipeline/runs/synthetic-demo` when it is not — see pipeline/runs/run-source.mjs
// and docs/EVALUATION-BOUNDARY.md. Nothing below is pinned to either survey's
// size: the expectations are derived from the substrate's own contract, which is
// a STRONGER statement than the obligation counts that used to be hard-coded
// here ("> 100 results", "> 50 passes" — true of t1-easy, and true of nothing).
const produced = produceAcceptanceArtifact({ runDir: SUBSTRATE_RUN });
const { record, judgement } = produced;
const CHECKLIST = JSON.parse(readFileSync(path.join(SUBSTRATE_RUN, "checklist.json"), "utf8"));

test("the REAL judge mints a publishable, attested JudgementRecord over the real run", () => {
  assert.equal(produced.authority.verified, true, "the real run's evidence authority must verify");
  assert.equal(produced.authority.contractSealed, true);
  assert.equal(produced.authority.contractReviewState, "sealed-unreviewed");
  assert.equal(judgement.publishable, true, "the producer must declare its own record publishable");
  assert.equal(judgement.status, "attestable");
  assert.ok(judgement.attestation, "the producer must have signed it");
  // EVERY obligation the signed contract carries is judged — none dropped, none
  // invented. (Was `> 100`, which only ever said "this is the big run".)
  assert.equal(
    judgement.results.length,
    CHECKLIST.obligations.length,
    `${SUBSTRATE_RUN_ID} carries ${CHECKLIST.obligations.length} obligations and the judge must return a result for each`
  );
  assert.deepEqual(
    judgement.results.map((r) => r.obligationId).sort(),
    CHECKLIST.obligations.map((o) => o.id).sort()
  );
});

test("ACCEPTANCE: a genuine signed JudgementRecord from the real judge is TRUSTED by the report", () => {
  const trust = evaluateJudgement({
    judgement: { judgementRecord: judgement, verdicts: null, routeTable: null, delta: null, summary: null, path: "acceptance" },
    record,
    keyRegistry: KEY_REGISTRY,
  });
  assert.deepEqual(
    trust.problems,
    [],
    `the report must accept real judge output; it reported: ${JSON.stringify(trust.problems, null, 1)}`
  );
  assert.equal(trust.state, "trusted");
  assert.equal(trust.attestation.state, "verified");
  assert.equal(trust.binding.allOk, true);
  // Sealed and human-reviewed are separate facts and must stay separate.
  assert.equal(trust.revision.sealed, true);
  assert.equal(trust.revision.humanReviewed, false);
});

test("ACCEPTANCE: every real result passes full proof validation as the real judge emits it", () => {
  const problems = [];
  for (const r of judgement.results) {
    problems.push(...recordLevelProofProblems(validateResultProof(r, r.obligationId)));
  }
  assert.deepEqual(problems.slice(0, 5), [], `real judge output must satisfy the proof validator: ${JSON.stringify(problems.slice(0, 5), null, 1)}`);
  assert.equal(problems.length, 0);
});

test("ACCEPTANCE: recomputing every aggregate attestation agrees with what the real judge claimed", () => {
  let checked = 0;
  for (const r of judgement.results) {
    const re = recomputeWitnessAttestation(r);
    assert.equal(
      re.falsified,
      false,
      `${r.obligationId} claims allVerified beyond its own attestations`
    );
    if (re.claimed !== null) {
      assert.equal(re.allVerified, re.claimed, `${r.obligationId}: recomputed ${re.allVerified}, claimed ${re.claimed}`);
      checked += 1;
    }
  }
  // Was `> 100`. EVERY result must carry an aggregate claim, which is the
  // property that matters and does not depend on how big the run is.
  assert.equal(checked, judgement.results.length, "every real result carries an aggregate claim to recompute");
});

test("ACCEPTANCE: the real record drives a CURRENT result column and the page renders", () => {
  const judgementBundle = {
    judgementRecord: judgement,
    verdicts: null,
    routeTable: judgement.routeTable ?? null,
    delta: null,
    summary: null,
    path: "acceptance",
  };
  const trust = evaluateJudgement({ judgement: judgementBundle, record, keyRegistry: KEY_REGISTRY });
  const view = buildReportView({
    record,
    attestation: { state: "verified", reason: "acceptance", registryPath: KEY_REGISTRY_PATH },
    options: {
      judgement: judgementBundle,
      judgementTrust: trust,
      generatedAt: "2026-08-02T00:00:00Z",
      evidenceAudit: new Map(),
    },
  });

  assert.equal(view.publication.currentResults.present, true, "a trusted record must produce current results");
  assert.equal(view.publication.currentResults.columnId, "re-derived");
  assert.equal(view.publication.resultReview.state, "complete");

  const html = renderReportHtml(view, { css: "/* acceptance */" });
  assert.match(html, /Current result/);
  // Was `html.length > 100000`, which is a fact about t1-easy's size. What the
  // page has to do is carry EVERY judged requirement, so that is what is checked.
  for (const r of judgement.results) {
    assert.ok(html.includes(r.obligationId), `${r.obligationId} must appear on the rendered page`);
  }

  // Real passes exist in the current column and are published as passes, which
  // is the half of the gate that has never been proven before this round.
  const roll = view.register.denominators.documentRequirements.byColumn["re-derived"].roll;
  assert.ok(roll.pass > 0, "the real run's genuine passes must publish as passes");
  assert.ok(roll.fail > 0, "the real run's seeded defects must publish as fails");
});

test("ACCEPTANCE: the publication gate CLEARS on real passes and bites on real non-passes", () => {
  const passes = judgement.results.filter((r) => r.verdict === "pass");
  const cleared = passes.filter((r) => evaluatePassPublication(r).publishable);
  // Was `> 50`. The gate is per-row, so the claim is "every pass this substrate
  // produced clears it" — asserted below over all of them — plus the guard that
  // the substrate produced some, i.e. the equality is not vacuous.
  assert.ok(passes.length > 0, "the substrate run must produce passes for the gate to clear");
  assert.equal(
    cleared.length,
    passes.length,
    `every real pass must clear the gate; ${passes.length - cleared.length} did not: ${JSON.stringify(
      passes.filter((r) => !evaluatePassPublication(r).publishable).slice(0, 3).map((r) => ({
        id: r.obligationId,
        reason: evaluatePassPublication(r).reason,
      })),
      null,
      1
    )}`
  );

  // ...and the same gate refuses a real fail, which carries a counter-witness
  // by construction.
  const fails = judgement.results.filter((r) => r.verdict === "fail");
  assert.ok(fails.length > 0);
  for (const f of fails) {
    assert.equal(evaluatePassPublication(f).publishable, false, `${f.obligationId} must not clear the PASS gate`);
  }
});

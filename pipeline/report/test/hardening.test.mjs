// Round-3 regression suite: D11 (the signed-result validator), D13 (truth-
// preserving aggregation and earned settlement), D14 (a blocker rendered as
// what it is) and D7 (report finality is not defect-freedom).
//
// Every D11 case below is built by taking REAL judge output — produced at test
// time by pipeline/judge over pipeline/runs/t1-easy — and breaking exactly ONE
// thing in it. That is deliberate: the previous round's negative tests were
// written against a hand-authored happy fixture, so they could only prove that
// the validator rejects shapes the real producer never emits. Starting from the
// real artifact means each test says "the real thing, minus this one property,
// is refused" — which is the claim that matters.
//
// Each test fails when its fix is reverted; the revert checks are recorded in
// the handover, not simulated here.

import test from "node:test";
import assert from "node:assert/strict";

import { produceAcceptanceArtifact, KEY_REGISTRY_PATH } from "../make-acceptance-artifact.mjs";
import {
  evaluateJudgement,
  registryFor,
  validateResultProof,
  recordLevelProofProblems,
  recomputeWitnessAttestation,
  SUPPORTED_JUDGEMENT_RECORD_SCHEMAS,
} from "../lib/judgement-record.mjs";
import { evaluatePassPublication } from "../lib/publication.mjs";
import {
  buildRegister,
  aggregateParent,
  evaluateSettlement,
  classifyRowBlocker,
  CELL_STATES,
} from "../lib/register.mjs";
import { buildReportView } from "../lib/view-model.mjs";
import { renderReportHtml } from "../lib/render-html.mjs";
import { signRecord } from "../../../scorer/src/lib/attest.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeRunRecord, makeItem, makeItemResult, makeJudged, makeJudgementRecord, KEY_REGISTRY, ROOT } from "./helpers.mjs";
import { SUBSTRATE_RUN, SUBSTRATE_RUN_ID } from "../../runs/run-source.mjs";

const REGISTRY = registryFor(KEY_REGISTRY_PATH);
const PRIVATE_KEY = readFileSync(path.join(ROOT, "scorer", "fixtures", "keys", "TEST-ONLY-fixture-harness.private.pem"), "utf8");

// THE SUBSTRATE, not the survey. Every D11 case below takes REAL judge output
// over a REAL signed run and breaks exactly one thing in it; which run supplied
// that output is irrelevant to the claim, so it is `pipeline/runs/t1-easy` when
// that (blind-derived, publication-held) run is in the checkout and the public
// `pipeline/runs/synthetic-demo` when it is not. See pipeline/runs/run-source.mjs.
const real = produceAcceptanceArtifact({ runDir: SUBSTRATE_RUN });

/** Re-sign after a mutation, so the signature is never the thing that fails. */
const resign = (doc) => {
  const { attestation: _drop, ...rest } = doc;
  return { ...rest, attestation: signRecord(rest, PRIVATE_KEY, "fixture-harness-key-1", "2026-08-02T00:00:00Z") };
};

/** Take the real signed record, mutate it, re-sign it, and ask the boundary. */
function mutateReal(mutate) {
  const doc = JSON.parse(JSON.stringify(real.judgement));
  mutate(doc);
  return evaluateJudgement({
    judgement: { judgementRecord: resign(doc), path: "mutated" },
    record: real.record,
    keyRegistry: REGISTRY,
  });
}

const codes = (trust) => trust.problems.map((p) => p.code);

/* ================================================================= *
 * D11 — the signed result validator                                  *
 * ================================================================= */

test("D11: a signed row citing a witness that pins nothing is REFUSED, not published", () => {
  // The exact shape named in the defect: supportingWitnesses:[{}] claiming allVerified.
  const trust = mutateReal((doc) => {
    const row = doc.results.find((r) => r.verdict === "pass" && r.supportingWitnesses.length);
    row.supportingWitnesses = [{}];
    row.attestation = { positive: [], counter: [], allVerified: true, witnessCount: 0, hashAuthority: "signed-run-record" };
  });
  assert.equal(trust.state, "diagnostic");
  assert.ok(codes(trust).includes("MALFORMED_WITNESS"), codes(trust).join(", "));
  assert.ok(codes(trust).includes("ATTESTATION_AGGREGATE_FALSIFIED"), codes(trust).join(", "));
});

test("D11: an aggregate allVerified that is false of its own attestations is REFUSED", () => {
  const trust = mutateReal((doc) => {
    const row = doc.results.find((r) => r.attestation?.positive?.length);
    row.attestation.positive[0].ok = false;
    row.attestation.allVerified = true; // the lie
  });
  assert.equal(trust.state, "diagnostic");
  assert.ok(codes(trust).includes("ATTESTATION_AGGREGATE_FALSIFIED"));
});

test("D11: attestations that do not correspond to the cited witnesses are REFUSED", () => {
  const trust = mutateReal((doc) => {
    const row = doc.results.find((r) => r.attestation?.positive?.length);
    row.attestation.positive[0].witness.artifact = "SOMETHING-ELSE.json";
  });
  assert.equal(trust.state, "diagnostic");
  assert.ok(codes(trust).includes("ATTESTATION_WITNESS_MISMATCH"));
});

test("D11: an attestation of different bytes than the citation is REFUSED", () => {
  const trust = mutateReal((doc) => {
    const row = doc.results.find((r) => r.attestation?.positive?.length && r.supportingWitnesses[0]?.sha256);
    row.attestation.positive[0].sha256 = "f".repeat(64);
  });
  assert.equal(trust.state, "diagnostic");
  assert.ok(codes(trust).includes("ATTESTATION_HASH_MISMATCH"));
});

test("D11: a schema version outside the exact allowlist is REFUSED (no prefix acceptance)", () => {
  assert.deepEqual(SUPPORTED_JUDGEMENT_RECORD_SCHEMAS, ["survey-qa-judgement-record/1.0.0"]);
  const trust = mutateReal((doc) => {
    // Same prefix, version this reader has never been taught.
    doc.schemaVersion = "survey-qa-judgement-record/9.9.9";
  });
  assert.equal(trust.state, "diagnostic");
  assert.ok(codes(trust).includes("UNSUPPORTED_SCHEMA_VERSION"), codes(trust).join(", "));
});

test("D11: a producer version this reader cannot interpret is REFUSED", () => {
  const trust = mutateReal((doc) => {
    doc.binding.predicateVersion = "3.0.0";
  });
  assert.equal(trust.state, "diagnostic");
  assert.ok(codes(trust).includes("UNSUPPORTED_PRODUCER_VERSION"));
});

test("D11: a record with no producer publishability declaration is REFUSED", () => {
  const trust = mutateReal((doc) => {
    delete doc.publishable;
  });
  assert.equal(trust.state, "diagnostic");
  assert.ok(codes(trust).includes("PRODUCER_STATUS_ABSENT"));
});

test("D11: publishable:true beside status diagnostic-only is REFUSED as contradictory", () => {
  const trust = mutateReal((doc) => {
    doc.status = "diagnostic-only";
  });
  assert.equal(trust.state, "diagnostic");
  assert.ok(codes(trust).includes("PRODUCER_STATUS_CONTRADICTORY"));
});

test("D11: a verdict its own named predicate contradicts cannot publish as a pass", () => {
  // ROW level by design: the record stays readable and the ROW is demoted, which
  // is what AMENDMENT A specifies ("the row becomes Judgment pending").
  const row = JSON.parse(JSON.stringify(real.judgement.results.find((r) => r.verdict === "pass")));
  row.predicateOutcome = "insufficient";
  const problems = validateResultProof(row, "row");
  assert.ok(problems.some((p) => p.code === "PREDICATE_OUTCOME_CONTRADICTS_VERDICT"));
  assert.deepEqual(recordLevelProofProblems(problems), [], "this one is row-level, not record-level");
  assert.equal(evaluatePassPublication(row).publishable, false);
});

test("D11: the publication gate RECOMPUTES re-verification instead of believing it", () => {
  const row = JSON.parse(JSON.stringify(real.judgement.results.find((r) => r.verdict === "pass" && r.attestation.positive.length)));
  assert.equal(evaluatePassPublication(row).publishable, true, "the real row publishes");
  row.attestation.positive[0].ok = false; // one witness did not re-verify...
  // ...and the record still claims otherwise. The gate must not believe it.
  assert.equal(row.attestation.allVerified, true);
  const re = recomputeWitnessAttestation(row);
  assert.equal(re.claimed, true);
  assert.equal(re.allVerified, false);
  assert.equal(re.falsified, true);
  const gate = evaluatePassPublication(row);
  assert.equal(gate.publishable, false);
  assert.ok(gate.failed.includes("witnesses-reverified"));
});

/* ================================================================= *
 * D13 — truth-preserving cells, aggregation and earned settlement    *
 * ================================================================= */

function registerWith(judgedList, { items = null, findings = [], parameters = {}, reviewState = "sealed" } = {}) {
  const contractItems = items ?? judgedList.map((j) => makeItem(j.obligationId));
  const record = makeRunRecord({
    items: contractItems,
    itemResults: contractItems.map((i) => makeItemResult(i.itemId)),
    findings,
    parameters,
    sealedRevision: true,
  });
  if (reviewState !== "sealed") {
    record.contract.revision.reviewState = reviewState;
  }
  const signed = resign(record);
  const doc = makeJudgementRecord(signed, judgedList);
  const judgement = { judgementRecord: doc, verdicts: null, routeTable: null, delta: null, summary: null, path: "test" };
  const trust = evaluateJudgement({ judgement, record: signed, keyRegistry: KEY_REGISTRY, registryPath: "test" });
  return { record: signed, trust, reg: buildRegister({ record: signed, judgement, judgementTrust: trust, findings, runContext: {} }) };
}

/** A register whose single requirement is MIXED: it passed on one observed route
 *  and failed on another. Built the same way register-render.test.mjs builds it,
 *  from a route table the judging engine supplies. */
function routeMixedRegister() {
  const items = [makeItem("OBL-R")];
  const record = makeRunRecord({ items, itemResults: [makeItemResult("OBL-R")], sealedRevision: true });
  const judged = makeJudged("OBL-R", {
    expectation: {
      kind: "route",
      question: "Q7",
      trigger: { mode: "include", codes: ["1", "2"], labels: ["Yes", "No"] },
      destination: "Q9",
      compiledBy: "R-ROUTE",
      compilerVersion: "1.0.0",
    },
    evidenceScope: { claimKind: "route", routeRowsConsidered: 2 },
  });
  const routeTable = {
    screenRank: {},
    rows: [
      { question: "Q7", answer: "Yes", answerCodes: ["1"], answerLabels: ["Yes"], destinations: { Q9: { count: 4, witnesses: [] } }, observations: 4, pathConsistency: "consistent" },
      { question: "Q7", answer: "No", answerCodes: ["2"], answerLabels: ["No"], destinations: { Q8: { count: 1, witnesses: [] } }, observations: 1, pathConsistency: "consistent" },
    ],
  };
  const doc = makeJudgementRecord(record, [judged]);
  doc.routeTable = routeTable;
  const signed = resign(doc);
  const judgement = { judgementRecord: signed, verdicts: null, routeTable, delta: null, summary: null, path: "test" };
  const trust = evaluateJudgement({ judgement, record, keyRegistry: KEY_REGISTRY, registryPath: "test" });
  return { record, trust, reg: buildRegister({ record, judgement, judgementTrust: trust, findings: [], runContext: {} }) };
}

test("D13: coverage may not mask a recorded fail — proven-unreachable + fail renders FAIL", () => {
  const judged = makeJudged("OBL-1", { verdict: "fail", coverage: "proven-unreachable" });
  const { reg } = registerWith([judged]);
  const cell = reg.rows[0].cellsByColumn["re-derived"];
  assert.equal(cell.state, "FAIL", "the observed divergence must not disappear behind a coverage state");
  assert.equal(cell.maskedBy, "PROVEN_UNREACHABLE");
  assert.ok(reg.warnings.some((w) => w.code === "REGISTER_COVERAGE_MASKED_FAIL"));
});

test("D13: PROVEN_UNREACHABLE without an attested reachability proof is demoted to NOT_REACHED", () => {
  const judged = makeJudged("OBL-1", {
    verdict: "not-assessed",
    coverage: "proven-unreachable",
    predicateId: null,
    predicateOutcome: null,
    supportingWitnesses: [],
    counterWitnesses: [],
    attestation: { positive: [], counter: [], allVerified: false, witnessCount: 0, hashAuthority: "signed-run-record" },
    evidenceRefs: [],
  });
  const { reg } = registerWith([judged]);
  const cell = reg.rows[0].cellsByColumn["re-derived"];
  assert.equal(cell.state, "NOT_REACHED");
  assert.equal(cell.wouldHaveBeen, "proven-unreachable");
  assert.equal(cell.settlement.settled, false);
  assert.ok(reg.warnings.some((w) => w.code === "REGISTER_UNREACHABLE_WITHOUT_PROOF"));
});

test("D13: not-browser-observable declared by RUN CONFIGURATION does not settle the row", () => {
  const findings = [
    {
      findingId: "BLK-1",
      kind: "blocker",
      severity: "critical",
      category: "environment",
      summary: "the data file is server-side",
      itemRefs: ["OBL-1"],
      evidenceRefs: [],
      attemptRefs: [],
      confidence: 1,
    },
  ];
  const { reg } = registerWith([makeJudged("OBL-1", { verdict: "not-assessed", coverage: "blocked" })], {
    findings,
    parameters: { couldNotObserve: [{ item: "OBL-1 codes written to the data file", why: "the data file is server-side" }] },
  });
  const cell = reg.rows[0].cellsByColumn["re-derived"];
  assert.notEqual(cell.state, "NOT_BROWSER_OBSERVABLE", "a run may not decide its own testability");
  assert.equal(cell.state, "BLOCKED");
  assert.ok(reg.warnings.some((w) => w.code === "NBO_NOT_ON_REVIEWED_CONTRACT"));
});

test("D13: not-browser-observable SETTLES only from a human-reviewed sealed contract", () => {
  const reviewed = { sealed: true, humanReviewed: true, revisionId: "CR-1" };
  const item = { itemId: "OBL-1", testability: "not-browser-observable" };
  assert.equal(evaluateSettlement("NOT_BROWSER_OBSERVABLE", { revision: reviewed, contractItem: item }).settled, true);
  // sealed but NOT reviewed: an identity, not a review.
  assert.equal(
    evaluateSettlement("NOT_BROWSER_OBSERVABLE", {
      revision: { sealed: true, humanReviewed: false, revisionId: "CR-1" },
      contractItem: item,
    }).settled,
    false
  );
  // reviewed, but the contract does not say it.
  assert.equal(evaluateSettlement("NOT_BROWSER_OBSERVABLE", { revision: reviewed, contractItem: { itemId: "OBL-1" } }).settled, false);
});

test("D13: EXPLICIT_NEGATIVE still requires complete, re-verified absence evidence", () => {
  const incomplete = evaluateSettlement("EXPLICIT_NEGATIVE", {
    judged: makeJudged("OBL-1", { evidenceScope: { claimKind: "positive-witness" } }),
  });
  assert.equal(incomplete.settled, false);
  const complete = evaluateSettlement("EXPLICIT_NEGATIVE", {
    judged: makeJudged("OBL-1", {
      evidenceScope: { claimKind: "scoped-absence", memberCount: 1374, membersDigest: "sha256:" + "a".repeat(64) },
    }),
  });
  assert.equal(complete.settled, true);
});

test("D13: DOCUMENT_SILENT does not settle on a sealed-but-unreviewed revision", () => {
  const s = evaluateSettlement("DOCUMENT_SILENT", {
    revision: { sealed: true, humanReviewed: false, revisionId: "CR-1" },
    contractItem: { assertionStatus: "document-silent" },
  });
  assert.equal(s.settled, false);
  assert.match(s.missing, /HUMAN-REVIEWED/);
});

test("D13: a precedence-state parent may not absorb a failed execution case", () => {
  const failingCase = {
    caseId: "C-1",
    label: "route A",
    leaf: false,
    cellsByColumn: { "re-derived": { state: "FAIL", reasonText: "the destination diverged" } },
  };
  const unreachableCase = {
    caseId: "C-2",
    label: "route B",
    leaf: false,
    cellsByColumn: { "re-derived": { state: "PROVEN_UNREACHABLE", reasonText: "cannot be reached" } },
  };
  const warnings = [];
  for (const parentState of ["NOT_BROWSER_OBSERVABLE", "BLOCKED", "AMBIGUOUS", "PROVEN_UNREACHABLE"]) {
    const out = aggregateParent({
      parent: { state: parentState, notes: [] },
      cases: [failingCase, unreachableCase],
      itemId: "OBL-1",
      warnings,
    });
    assert.ok(out, `${parentState} must not silently absorb a failed case`);
    assert.equal(out.state, "FAIL");
    assert.equal(out.maskedBy, parentState);
  }
  assert.ok(warnings.every((w) => w.code === "REGISTER_PRECEDENCE_MASKED_FAIL"));
  // ...and with no failing child the short-circuit still stands.
  assert.equal(aggregateParent({ parent: { state: "BLOCKED" }, cases: [unreachableCase], itemId: "OBL-1", warnings: [] }), null);
});

/* ================================================================= *
 * D14 — every blocker rendered as WHAT IT IS                         *
 * ================================================================= */

test("D14: a route-dependent failure is classified as a DEFECT, not a neutral ambiguity", () => {
  const b = classifyRowBlocker({
    row: { itemId: "OBL-1" },
    cell: { state: "MIXED", reasonCode: null },
    settlement: { settled: false, requires: null, missing: null },
    integrityFailed: false,
    contradiction: true,
  });
  assert.equal(b.kind, "self-contradicting-row");
  assert.equal(b.neutralForScoring, false);
  assert.match(b.nature, /Defect/i);
});

test("D14: an evidence failure, an incompleteness and a suppression are three different things", () => {
  const evidence = classifyRowBlocker({
    row: { itemId: "OBL-1" },
    cell: { state: "JUDGMENT_PENDING", reasonCode: "publication-gate-failed", publicationGate: { reason: "x" } },
    settlement: { settled: false },
    integrityFailed: true,
    contradiction: false,
  });
  assert.equal(evidence.kind, "evidence-integrity-failure");
  assert.match(evidence.remedy, /re-read|re-run/i);

  const incomplete = classifyRowBlocker({
    row: { itemId: "OBL-2" },
    cell: { state: "NOT_REACHED", reasonCode: "not-reached" },
    settlement: { settled: false, requires: null },
    integrityFailed: false,
    contradiction: false,
  });
  assert.equal(incomplete.kind, "incomplete-coverage");

  // The N3 class: a violation WAS observed and then suppressed because the
  // completeness scope could not be attested.
  const suppressed = classifyRowBlocker({
    row: { itemId: "OBL-3" },
    cell: { state: "NOT_ASSESSED", reasonCode: "SCOPE_INCOMPLETE_FOR_CLAIM", reasonText: "scope not attestable" },
    settlement: { settled: false, requires: null },
    integrityFailed: false,
    contradiction: false,
  });
  assert.equal(suppressed.kind, "suppressed-observation");
  assert.match(suppressed.detail, /SUPPRESSED/);

  const ambiguous = classifyRowBlocker({
    row: { itemId: "OBL-4" },
    cell: { state: "AMBIGUOUS", blockedBy: ["AMB-1"], wouldHaveBeen: "fail" },
    settlement: { settled: false },
    integrityFailed: false,
    contradiction: false,
  });
  assert.equal(ambiguous.kind, "unresolved-ambiguity");
  assert.equal(ambiguous.neutralForScoring, true);

  // All four are distinct: the bug was that they rendered identically.
  assert.equal(new Set([evidence.nature, incomplete.nature, suppressed.nature, ambiguous.nature]).size, 4);
});

test("D14: the rendered page no longer calls every blocker a neutral item awaiting adjudication", () => {
  const judged = makeJudged("OBL-1", {
    verdict: "not-assessed",
    coverage: "exercised",
    reason: "SCOPE_INCOMPLETE_FOR_CLAIM",
    note: "the completeness scope could not be attested",
    predicateId: "text-forbidden@1",
    predicateOutcome: "insufficient",
  });
  const { record, trust, reg } = registerWith([judged]);
  const blocker = reg.certification.blockers.find((b) => b.kind === "suppressed-observation");
  assert.ok(blocker, `expected a suppressed-observation blocker, got ${reg.certification.blockers.map((b) => b.kind).join(", ")}`);

  const view = buildReportView({
    record,
    attestation: { state: "verified", reason: "ok", registryPath: "test" },
    options: {
      judgement: { judgementRecord: trust.verdicts, verdicts: null, routeTable: null, delta: null, summary: null, path: "test" },
      judgementTrust: trust,
      generatedAt: "2026-08-02T00:00:00Z",
      evidenceAudit: new Map(),
    },
  });
  const html = renderReportHtml(view, { css: "/* test */" });
  assert.ok(
    !/Each item below is neutral for scoring and must be adjudicated by a human/.test(html),
    "the blanket ambiguity framing must be gone"
  );
  assert.match(html, /Suppressed observation/i);
  assert.match(html, /What closes it/);
});

/* ================================================================= *
 * D7 — report finality is not defect-freedom                         *
 * ================================================================= */

test("D7: a report whose only outstanding item is a FAILURE is FINAL, and says so", () => {
  const { reg } = registerWith([makeJudged("OBL-1", { verdict: "fail" })]);
  assert.equal(reg.certification.final, true, "an honest failure does not make a report unfinishable");
  assert.equal(reg.certification.defectFree, false);
  assert.equal(reg.certification.defectCount, 1);
  assert.deepEqual(reg.certification.defectRefs, ["OBL-1"]);
  assert.equal(CELL_STATES[reg.rows[0].cellsByColumn["re-derived"].state].countsAs, "fail");
});

test("D7: a ROUTE-DEPENDENT failure is a defect, not a finality blocker", () => {
  // A MIXED row is the case where the two questions actually diverge: it IS a
  // certification blocker under the old single boolean, and it is a DEFECT
  // under the split. Finality must survive it; defect-freedom must not.
  const { reg } = routeMixedRegister();
  const cell = reg.rows[0].cellsByColumn["re-derived"];
  assert.equal(cell.state, "MIXED");
  const defectBlocker = reg.certification.blockers.find((b) => b.kind === "self-contradicting-row");
  assert.ok(defectBlocker, "the MIXED row is still reported");
  assert.equal(defectBlocker.neutralForScoring, false);
  assert.equal(reg.certification.blockers.length > reg.certification.finalityBlockers.length, true);
  assert.ok(
    !reg.certification.finalityBlockers.some((b) => b.kind === "self-contradicting-row"),
    "a route-dependent failure is the report CONTENT, not a reason the report cannot be issued"
  );
  assert.equal(reg.certification.final, true);
  assert.equal(reg.certification.defectFree, false);
  assert.equal(reg.certification.defectCount, 1);
});

test("D7: finality and defect-freedom are separate — a clean run is final AND defect-free", () => {
  const { reg } = registerWith([makeJudged("OBL-1")]);
  assert.equal(reg.certification.final, true);
  assert.equal(reg.certification.defectFree, true);
  assert.equal(reg.certification.defectCount, 0);
});

test("D7: unfinished work blocks FINALITY even when nothing failed", () => {
  const { reg } = registerWith([
    makeJudged("OBL-1", {
      verdict: "not-assessed",
      coverage: "not-reached",
      predicateId: null,
      predicateOutcome: null,
      supportingWitnesses: [],
      counterWitnesses: [],
      attestation: { positive: [], counter: [], allVerified: false, witnessCount: 0, hashAuthority: "signed-run-record" },
      evidenceRefs: [],
    }),
  ]);
  assert.equal(reg.certification.final, false);
  assert.equal(reg.certification.defectFree, true, "nothing failed...");
  assert.ok(reg.certification.finalityBlockers.length > 0, "...but the work is not finished");
});

test("D7: the final-with-failures page reports the failures instead of 'cannot be certified'", () => {
  const { record, trust } = registerWith([makeJudged("OBL-1", { verdict: "fail" })]);
  const view = buildReportView({
    record,
    attestation: { state: "verified", reason: "ok", registryPath: "test" },
    options: {
      judgement: { judgementRecord: trust.verdicts, verdicts: null, routeTable: null, delta: null, summary: null, path: "test" },
      judgementTrust: trust,
      generatedAt: "2026-08-02T00:00:00Z",
      evidenceAudit: new Map(),
    },
  });
  const html = renderReportHtml(view, { css: "/* test */" });
  assert.match(html, /Final — every requirement settled; 1 failed/);
  assert.match(html, /Failures are the report's content, not an obstacle to issuing it/);
  assert.ok(!/this run cannot be certified/.test(html));
});

/* ================================================================= *
 * Advisory — sealed, humanReviewed and certified are THREE facts      *
 * ================================================================= */

test("the contract-review statement no longer claims a human sealed anything", async () => {
  const { buildTrustStatements } = await import("../lib/publication.mjs");
  const statements = buildTrustStatements({
    attestation: { state: "verified", reason: "ok" },
    evidenceAudit: new Map(),
    evidenceCount: 0,
    revision: { sealed: true, humanReviewed: false, revisionId: "cr_x", why: "no human reviewed it" },
    resultReview: { state: "complete", headline: "complete", policyVersion: null },
  });
  const contract = statements.find((s) => s.id === "contract-review");
  assert.ok(!/whether a human sealed/i.test(contract.scope), "sealing can be automated; the copy must not claim otherwise");
  assert.match(contract.scope, /may be automated/i);
  assert.match(contract.scope, /a seal is not a review/i);
});

/* ================================================================= *
 * Trust card: unaudited artifacts are not absent                      *
 * ================================================================= */

test("the trust card words verified + unaudited + missing honestly, never folding unaudited into absent", async () => {
  const { buildTrustStatements } = await import("../lib/publication.mjs");
  const audit = new Map();
  audit.set("ev1", { state: "verified" });
  audit.set("ev2", { state: "verified" });
  audit.set("ev3", { state: "verified" });
  audit.set("ev4", { state: "unaudited", note: "not audited at render time: byte budget exhausted" });
  audit.set("ev5", { state: "unaudited", note: "not audited at render time: byte budget exhausted" });
  audit.set("ev6", { state: "missing", note: "GET failed" });
  const statements = buildTrustStatements({
    attestation: { state: "verified", reason: "ok" },
    evidenceAudit: audit,
    evidenceCount: 6,
    revision: { sealed: true, humanReviewed: true, revisionId: "cr_tc" },
    resultReview: { state: "complete", headline: "complete", policyVersion: null },
  });
  const ev = statements.find((s) => s.id === "evidence-files");
  assert.match(ev.value, /3 of 6 hash-verified/, "verified count must appear");
  assert.match(ev.value, /2 not audited at render time/, "unaudited count must appear as 'not audited'");
  assert.match(ev.value, /1 absent/, "truly missing count must appear as 'absent'");
  assert.ok(!/2 absent/.test(ev.value), "unaudited must never read as absent");
  assert.equal(ev.state, "partial", "anything unaudited or missing keeps state partial");
});

test("a trust card with zero unaudited and zero missing omits both groups", async () => {
  const { buildTrustStatements } = await import("../lib/publication.mjs");
  const audit = new Map();
  audit.set("ev1", { state: "verified" });
  audit.set("ev2", { state: "verified" });
  const statements = buildTrustStatements({
    attestation: { state: "verified", reason: "ok" },
    evidenceAudit: audit,
    evidenceCount: 2,
    revision: { sealed: true, humanReviewed: true, revisionId: "cr_tc" },
    resultReview: { state: "complete", headline: "complete", policyVersion: null },
  });
  const ev = statements.find((s) => s.id === "evidence-files");
  assert.equal(ev.value, "2 of 2 hash-verified");
  assert.equal(ev.state, "verified");
});

test("a real GET failure still reads as absent, not as unaudited", async () => {
  const { buildTrustStatements } = await import("../lib/publication.mjs");
  const audit = new Map();
  audit.set("ev1", { state: "verified" });
  audit.set("ev2", { state: "missing", note: "GET returned 404" });
  const statements = buildTrustStatements({
    attestation: { state: "verified", reason: "ok" },
    evidenceAudit: audit,
    evidenceCount: 2,
    revision: { sealed: true, humanReviewed: true, revisionId: "cr_tc" },
    resultReview: { state: "complete", headline: "complete", policyVersion: null },
  });
  const ev = statements.find((s) => s.id === "evidence-files");
  assert.match(ev.value, /1 absent/, "a real GET failure must still read as absent");
  assert.ok(!/not audited/.test(ev.value), "a real GET failure must not read as unaudited");
  assert.equal(ev.state, "partial");
});

// D10 — the mandatory-case denominator and MIXED aggregation must reconcile.
//
// Each test fails against the pre-fix build:
//   · route/screen cases were materialized from OBSERVED evidence, so missing
//     execution shrank the denominator;
//   · implicit leaf cases were counted in the total but never bucketed
//     (171 declared, 66 accounted for);
//   · pathConsistency "mixed" reached a MIXED cell through exactly one pathway;
//   · a PASS parent survived a mandatory NOT_REACHED / NOT_ASSESSED child.

import test from "node:test";
import assert from "node:assert/strict";

import { buildRegister, CELL_STATES } from "../lib/register.mjs";
import { evaluateJudgement } from "../lib/judgement-record.mjs";
import { makeRunRecord, makeItem, makeItemResult, makeJudged, makeJudgementRecord, KEY_REGISTRY } from "./helpers.mjs";

function build({ items, itemResults, judged, routeTable = null, parameters = {} }) {
  const record = makeRunRecord({ items, itemResults, sealedRevision: true, parameters });
  const doc = makeJudgementRecord(record, judged);
  if (routeTable) doc.routeTable = routeTable;
  const judgement = { judgementRecord: doc, verdicts: null, routeTable, delta: null, summary: null, path: "test" };
  const trust = evaluateJudgement({ judgement, record, keyRegistry: KEY_REGISTRY });
  return { record, trust, reg: buildRegister({ record, judgement, judgementTrust: trust, findings: [], runContext: {} }) };
}

const routeJudged = (id, { codes = ["1", "2"], labels = ["Yes", "No"], destination = "Q2", verdict = "pass", pathConsistency = "consistent", mode = "include" } = {}) =>
  makeJudged(id, {
    verdict,
    pathConsistency,
    expectation: {
      kind: "route",
      question: "Q1",
      trigger: { mode, codes, labels },
      destination,
      compiledBy: "R-ROUTE",
      compilerVersion: "1.0.0",
    },
    evidenceScope: { claimKind: "route", routeRowsConsidered: 2 },
  });

const routeRow = (answer, codes, labels, destination, { observations = 3, pathConsistency = "consistent" } = {}) => ({
  question: "Q1",
  answer,
  answerCodes: codes,
  answerLabels: labels,
  destinations: { [destination]: { count: observations, witnesses: [] } },
  observations,
  pathConsistency,
});

/* ---------------- every case occupies exactly one bucket ---------------- */

test("every mandatory execution case lands in exactly one outcome bucket", () => {
  const items = [makeItem("OBL-1"), makeItem("OBL-2"), makeItem("OBL-3")];
  const { reg } = build({
    items,
    itemResults: items.map((i) => makeItemResult(i.itemId)),
    judged: items.map((i) => makeJudged(i.itemId)),
  });
  const ec = reg.denominators.executionCases;
  assert.equal(ec.total, 3, "three single-locus requirements are three mandatory cases");
  assert.equal(ec.enumerated, ec.total, "every declared case must be materialized");
  for (const col of reg.columns) {
    const bucketed = Object.values(ec.byColumn[col.id].states).reduce((a, n) => a + n, 0);
    assert.equal(bucketed, ec.total, `column ${col.id}: ${ec.total} declared but ${bucketed} bucketed`);
  }
  assert.ok(!reg.warnings.some((w) => w.code === "CASE_BUCKET_RECONCILIATION"));
});

test("a leaf case is materialized in the model but is not a second table row", () => {
  const items = [makeItem("OBL-1")];
  const { reg } = build({ items, itemResults: [makeItemResult("OBL-1")], judged: [makeJudged("OBL-1")] });
  assert.equal(reg.rows[0].cases.length, 1);
  assert.equal(reg.rows[0].cases[0].leaf, true, "the implicit case must be marked so the renderer does not duplicate the row");
});

/* ---------------- the denominator must not come from observation -------- */

test("an EXCLUSION routing trigger yields NO derived cases — the denominator cannot come from what was observed", () => {
  const items = [makeItem("OBL-EX")];
  const routeTable = {
    screenRank: {},
    rows: [routeRow("Yes", ["1"], ["Yes"], "Q2"), routeRow("No", ["3"], ["No"], "Q2")],
  };
  const { reg } = build({
    items,
    itemResults: [makeItemResult("OBL-EX")],
    judged: [routeJudged("OBL-EX", { mode: "exclude", codes: ["2"], labels: [] })],
    routeTable,
  });
  const row = reg.rows[0];
  assert.equal(row.expansion.established, false);
  assert.equal(row.expansion.mandatoryCases, null);
  assert.equal(row.cases.length, 0, "cases must never be manufactured from the answers the run happened to give");
  assert.equal(reg.denominators.executionCases.notEstablished.rows, 1);
  assert.ok(reg.denominators.executionCases.notEstablished.rowIds.includes("OBL-EX"));
});

test("a survey-wide scoped rule with no sealed screen ledger has NO established case count", () => {
  const items = [makeItem("OBL-GLOBAL")];
  const routeTable = { screenRank: { S1: 1, S2: 2, S3: 3 }, rows: [] };
  const judged = makeJudged("OBL-GLOBAL", {
    expectation: { kind: "one-question-per-screen", screen: null, compiledBy: "R-GEN", compilerVersion: "1.0.0" },
    evidenceScope: { claimKind: "scoped-absence", capturesScanned: 100, screensScanned: 3 },
    predicateDetail: { violations: 0, capturesScanned: 100 },
    reason: "COMPLETE_POSITIVE_INVENTORY",
  });
  const { reg } = build({ items, itemResults: [makeItemResult("OBL-GLOBAL")], judged: [judged], routeTable });
  const row = reg.rows[0];
  assert.equal(row.expansion.established, false, "3 screens SCANNED is an observation, not a denominator");
  assert.equal(row.cases.length, 0);
  assert.equal(row.cellsByColumn["re-derived"].state, "INCOMPLETE", "a pass cannot stand on an unestablished case set");
});

test("a sealed floor-case ledger DOES establish the case count", () => {
  const items = [makeItem("OBL-GLOBAL")];
  const record = makeRunRecord({ items, itemResults: [makeItemResult("OBL-GLOBAL")], sealedRevision: true });
  record.contract.floorCases = [
    { itemId: "OBL-GLOBAL", caseId: "OBL-GLOBAL#S1", screen: "S1" },
    { itemId: "OBL-GLOBAL", caseId: "OBL-GLOBAL#S2", screen: "S2" },
    { itemId: "OBL-GLOBAL", caseId: "OBL-GLOBAL#S3", screen: "S3" },
  ];
  const judged = makeJudged("OBL-GLOBAL", {
    expectation: { kind: "one-question-per-screen", screen: null, compiledBy: "R-GEN", compilerVersion: "1.0.0" },
    evidenceScope: { claimKind: "scoped-absence", capturesScanned: 100, screensScanned: 3 },
    predicateDetail: { violations: 0, capturesScanned: 100 },
  });
  const reg = buildRegister({
    record,
    judgement: { judgementRecord: null, verdicts: { results: [judged] }, routeTable: { screenRank: {}, rows: [] } },
    judgementTrust: { state: "diagnostic", verdicts: { results: [judged] }, problems: [], revision: null },
    findings: [],
    runContext: {},
  });
  const row = reg.rows[0];
  assert.equal(row.expansion.established, true);
  assert.equal(row.expansion.mandatoryCases, 3);
  assert.equal(row.cases.length, 3);
  assert.equal(reg.caseLedger.present, true);
});

/* ---------------- MIXED must be reachable from every pathway ------------ */

test("MIXED via disagreeing execution cases", () => {
  const items = [makeItem("OBL-R")];
  const routeTable = {
    screenRank: {},
    rows: [routeRow("Yes", ["1"], ["Yes"], "Q2"), routeRow("No", ["2"], ["No"], "Q9")],
  };
  const { reg } = build({
    items,
    itemResults: [makeItemResult("OBL-R")],
    judged: [routeJudged("OBL-R")],
    routeTable,
  });
  const cell = reg.rows[0].cellsByColumn["re-derived"];
  assert.equal(cell.state, "MIXED");
  assert.equal(CELL_STATES.MIXED.countsAs, "fail");
  assert.ok(reg.warnings.some((w) => w.code === "REGISTER_AGGREGATE_CONTRADICTION"));
});

test("MIXED via the parent's own pathConsistency — the second aggregation pathway", () => {
  const items = [makeItem("OBL-P")];
  const { reg } = build({
    items,
    itemResults: [makeItemResult("OBL-P")],
    judged: [makeJudged("OBL-P", { pathConsistency: "mixed" })],
  });
  const cell = reg.rows[0].cellsByColumn["re-derived"];
  assert.equal(cell.state, "MIXED", "a recorded pathConsistency of `mixed` must never render as a pass");
  assert.ok(cell.mixedPathways.some((p) => /pathConsistency/.test(p)));
});

test("MIXED via an observed route row whose pathConsistency is mixed — the third pathway", () => {
  const items = [makeItem("OBL-RT")];
  const routeTable = {
    screenRank: {},
    rows: [
      routeRow("Yes", ["1"], ["Yes"], "Q2"),
      routeRow("No", ["2"], ["No"], "Q2", { pathConsistency: "mixed" }),
    ],
  };
  const { reg } = build({
    items,
    itemResults: [makeItemResult("OBL-RT")],
    judged: [routeJudged("OBL-RT")],
    routeTable,
  });
  assert.equal(reg.rows[0].cellsByColumn["re-derived"].state, "MIXED");
});

/* ---------------- a PASS may not survive an undecided child ------------- */

test("a PASS parent over a NOT_REACHED mandatory child becomes INCOMPLETE, not PASS and not MIXED", () => {
  const items = [makeItem("OBL-U")];
  // Only one of the two document-named routes was ever walked.
  const routeTable = { screenRank: {}, rows: [routeRow("Yes", ["1"], ["Yes"], "Q2")] };
  const { reg } = build({
    items,
    itemResults: [makeItemResult("OBL-U")],
    judged: [routeJudged("OBL-U", { destination: "Q2" })],
    routeTable,
  });
  const row = reg.rows[0];
  assert.equal(row.expansion.mandatoryCases, 2, "the document names two answers, so two cases are mandatory");
  const childStates = row.cases.map((c) => c.cellsByColumn["re-derived"].state);
  assert.ok(childStates.includes("NOT_REACHED"));
  const cell = row.cellsByColumn["re-derived"];
  assert.equal(cell.state, "INCOMPLETE");
  assert.notEqual(cell.state, "MIXED", "one required route not tested is INCOMPLETE, not mixed");
  assert.equal(CELL_STATES.INCOMPLETE.countsAs, "none");
  assert.ok(reg.warnings.some((w) => w.code === "REGISTER_PASS_OVER_UNDECIDED_CASE"));
});

test("fail-if-any: a failing child makes the parent fail even when the parent recorded a pass", () => {
  const items = [makeItem("OBL-F")];
  const routeTable = {
    screenRank: {},
    rows: [routeRow("Yes", ["1"], ["Yes"], "Q9"), routeRow("No", ["2"], ["No"], "Q9")],
  };
  const { reg } = build({
    items,
    itemResults: [makeItemResult("OBL-F")],
    judged: [routeJudged("OBL-F", { destination: "Q2" })],
    routeTable,
  });
  assert.equal(reg.rows[0].cellsByColumn["re-derived"].state, "FAIL");
});

/* ---------------- the 119-vs-136 accounting ---------------- */

test("out-of-browser mandates are accounted for explicitly and never folded into the register denominator", () => {
  const items = [makeItem("OBL-1"), makeItem("OBL-2")];
  const { reg } = build({
    items,
    itemResults: items.map((i) => makeItemResult(i.itemId)),
    judged: items.map((i) => makeJudged(i.itemId)),
    parameters: {
      outOfBrowserScopeMandates: [
        { id: "UNV-1", mandate: "codes written to the data file", whyNotObservable: "server-side" },
        { id: "UNV-2", mandate: "start/end times stored", whyNotObservable: "server-side" },
      ],
    },
  });
  const dm = reg.documentedMandates;
  assert.equal(dm.browserTestable, 2);
  assert.equal(dm.otherMethod, 2);
  assert.equal(dm.total, 4);
  assert.equal(reg.denominators.documentRequirements.total, 2, "the register denominator stays the browser-testable population");
  for (const e of dm.entries) {
    assert.equal(e.needsReview, true, "an out-of-browser mandate with no named method and owner must be flagged for review");
  }
});

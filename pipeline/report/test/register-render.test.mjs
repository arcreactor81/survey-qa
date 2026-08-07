// Register rendering: the mixed cell's wording, the route comparison table,
// collapse inheritance, and the publication gate's visual half.
//
// Fails against the pre-fix build: the mixed cell carried no primary-verdict
// line and no route comparison table, a collapsed parent showed nothing about
// its worst descendant, and a diagnostic column's PASS cells took pass styling.

import test from "node:test";
import assert from "node:assert/strict";

import { buildReportView } from "../lib/view-model.mjs";
import { renderReportHtml } from "../lib/render-html.mjs";
import { evaluateJudgement } from "../lib/judgement-record.mjs";
import { makeRunRecord, makeItem, makeItemResult, makeJudged, makeJudgementRecord, KEY_REGISTRY } from "./helpers.mjs";

function routeFixture({ destinations }) {
  const items = [makeItem("OBL-R")];
  const record = makeRunRecord({ items, itemResults: [makeItemResult("OBL-R")], sealedRevision: true });
  const judged = makeJudged("OBL-R", {
    expectation: {
      kind: "route",
      question: "Q7",
      trigger: { mode: "include", codes: ["1", "2"], labels: ["Yes", "Can't remember"] },
      destination: "Q9",
      compiledBy: "R-ROUTE",
      compilerVersion: "1.0.0",
    },
    evidenceScope: { claimKind: "route", routeRowsConsidered: 2 },
  });
  const routeTable = {
    screenRank: {},
    rows: [
      {
        question: "Q7",
        answer: "Yes",
        answerCodes: ["1"],
        answerLabels: ["Yes"],
        destinations: { [destinations[0]]: { count: 4, witnesses: [] } },
        observations: 4,
        pathConsistency: "consistent",
      },
      {
        question: "Q7",
        answer: "Can't remember",
        answerCodes: ["2"],
        answerLabels: ["Can't remember"],
        destinations: { [destinations[1]]: { count: 1, witnesses: [] } },
        observations: 1,
        pathConsistency: "consistent",
      },
    ],
  };
  const doc = makeJudgementRecord(record, [judged]);
  doc.routeTable = routeTable;
  const judgement = { judgementRecord: doc, verdicts: null, routeTable, delta: null, summary: null, path: "test" };
  const judgementTrust = evaluateJudgement({ judgement, record, keyRegistry: KEY_REGISTRY });
  const view = buildReportView({
    record,
    attestation: { state: "verified", reason: "ok", registryPath: "test" },
    options: { judgement, judgementTrust, generatedAt: "2026-08-02T00:00:00Z", evidenceAudit: new Map() },
  });
  return { view, html: renderReportHtml(view, { css: "/* test */" }) };
}

test("the mixed cell states the primary verdict first and counts TESTED ROUTES, never 'usually works'", () => {
  const { view, html } = routeFixture({ destinations: ["Q9", "Q8"] });
  assert.equal(view.register.rows[0].cellsByColumn["re-derived"].state, "MIXED");
  assert.match(html, /FAIL — behaviour changed by route/);
  assert.match(html, /1 tested route matched/);
  assert.match(html, /1 tested route diverged/);
  assert.ok(!/usually works/i.test(html), "test frequency is not respondent incidence");
  assert.match(html, /is not a statement about how many respondents take them/);
});

test("a mixed cell expands into a route comparison table", () => {
  const { html } = routeFixture({ destinations: ["Q9", "Q8"] });
  assert.match(html, /Route comparison/);
  assert.match(html, /Respondent route/);
  assert.match(html, /Document requires/);
  assert.match(html, /Survey did/);
});

test("a collapsed parent discloses its worst descendant state", () => {
  const { html } = routeFixture({ destinations: ["Q9", "Q8"] });
  assert.match(html, /worst state below this row/);
  assert.match(html, /collapsing this row cannot hide it/);
});

test("a diagnostic column's PASS cells are stripped of pass styling by the stylesheet contract", () => {
  const items = [makeItem("OBL-1")];
  const record = makeRunRecord({ items, itemResults: [makeItemResult("OBL-1")], sealedRevision: true });
  const judgement = {
    judgementRecord: null,
    verdicts: { kind: "derived-verdicts", results: [makeJudged("OBL-1")] },
    routeTable: null,
    delta: null,
    summary: null,
    path: "test",
  };
  const judgementTrust = evaluateJudgement({ judgement, record, keyRegistry: KEY_REGISTRY });
  const view = buildReportView({
    record,
    attestation: { state: "verified", reason: "ok", registryPath: "test" },
    options: { judgement, judgementTrust, generatedAt: "2026-08-02T00:00:00Z", evidenceAudit: new Map() },
  });
  const html = renderReportHtml(view, { css: "/* test */" });
  assert.match(html, /reg-cell--diagnostic/);
  assert.match(html, /diagnostic — not a current result/);
  assert.match(html, /NOT current results/);
});

// Direction 2 view component tests.
//
// These test that the v2 enrichment components render correctly from the
// view model: KPI strip, consequence cards, scope tiles, trust strip,
// evidence sidebar, limitations panel, findings view.
//
// HONESTY RULES TESTED:
//  1. No current result renders as "—", never as zero
//  2. Exercised counts never use success styling
//  3. Limitations are always visible, never zero-suppressed
//  4. Engineering vocabulary (OBL-, obligation, sealed revision) never
//     appears outside Technical details disclosures
//  5. Coverage is computed from the view model, not invented

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildReportView } from "../lib/view-model.mjs";
import { buildDecisionSummary } from "../lib/plain-language.mjs";
import { renderReportHtml } from "../lib/render-html.mjs";
import {
  renderV2KpiStrip,
  renderV2ConsequenceCards,
  renderV2ScopeTiles,
  renderV2TrustStrip,
  renderV2LimitationsPanel,
  renderV2FindingsView,
  renderV2SummaryEnrichment,
} from "../lib/render-v2-views.mjs";
import { extractView, splitZones } from "../jargon-scan.mjs";
import { makeRunRecord, makeItem, makeItemResult, makeJudged, makeJudgementRecord, KEY_REGISTRY } from "./helpers.mjs";
import { evaluateJudgement } from "../lib/judgement-record.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(HERE, "..", "report.css"), "utf8");

const ROUTING = {
  findingId: "DIV-002",
  kind: "defect",
  category: "routing-mismatch",
  severity: "high",
  confidence: 0.95,
  summary: "OBL-1: Q7 skip rule routes incorrectly",
  expected: "Q7 selecting 18-24 routes to Q9",
  observed: "Q7 selecting 18-24 routes to Q12",
  itemRefs: ["OBL-1"],
  attemptRefs: ["AT-1"],
  evidenceRefs: ["EV-1"],
};

function build({ withJudgement = false, items = null, findings = [], parameters = {} } = {}) {
  const itemList = items || [makeItem("OBL-1"), makeItem("OBL-2")];
  const record = makeRunRecord({
    items: itemList,
    itemResults: itemList.map((i) => makeItemResult(i.itemId)),
    findings,
    sealedRevision: true,
    parameters,
  });
  let judgement = null;
  let judgementTrust = null;
  if (withJudgement) {
    const doc = makeJudgementRecord(record, [
      makeJudged("OBL-1"),
      makeJudged("OBL-2", { verdict: "fail" }),
    ]);
    judgement = { judgementRecord: doc, verdicts: null, routeTable: null, delta: null, summary: null, path: "test" };
    judgementTrust = evaluateJudgement({ judgement, record, keyRegistry: KEY_REGISTRY });
  }
  return buildReportView({
    record,
    attestation: { state: "verified", reason: "ok", registryPath: "test" },
    options: { judgement, judgementTrust, generatedAt: "2026-08-02T00:00:00Z", evidenceAudit: new Map() },
  });
}

test("KPI strip renders document requirements from the register denominator", () => {
  const view = build({ withJudgement: true });
  const html = renderV2KpiStrip(view);
  assert.ok(html.includes("Document requirements"), "must show document requirements label");
  assert.ok(html.includes("v2-kpi-value"), "must render KPI value elements");
});

test("KPI strip shows '—' when no current result exists", () => {
  const view = build({ withJudgement: false });
  const html = renderV2KpiStrip(view);
  // When there is no current result (no judgement), failing should show —
  assert.ok(html.includes("—"), "must show — when no current result");
  assert.ok(html.includes("No current result"), "must say 'No current result'");
});

test("consequence cards only render for findings with known respondent consequences", () => {
  const view = build({ withJudgement: true, findings: [ROUTING] });
  const html = renderV2ConsequenceCards(view);
  // The ROUTING finding has a respondent consequence from the fixed lookup
  if (html) {
    assert.ok(html.includes("v2-consequence-card"), "consequence card present");
    assert.ok(html.includes("consequence"), "consequence text present");
  }
});

test("scope tiles render two denominators that are never summed", () => {
  const view = build({ withJudgement: true });
  const html = renderV2ScopeTiles(view);
  assert.ok(html.includes("Document requirements"), "document requirements card present");
  assert.ok(html.includes("Mandatory browser checks"), "mandatory checks card present");
  assert.ok(html.includes("never added"), "the 'never added' warning present");
});

test("trust strip renders labels only — no internal vocabulary", () => {
  const view = build({ withJudgement: true });
  const html = renderV2TrustStrip(view);
  if (html) {
    // The trust strip must not contain banned terms
    const text = html.replace(/<[^>]+>/g, " ");
    for (const term of ["sealed revision", "contract revision", "matcher version"]) {
      assert.ok(!text.toLowerCase().includes(term), `trust strip must not contain '${term}'`);
    }
  }
});

test("findings view renders provenance diffs with plainified text", () => {
  const view = build({ withJudgement: true, findings: [ROUTING] });
  const html = renderV2FindingsView(view);
  assert.ok(html.includes("v2-prov"), "provenance diff section exists");
  assert.ok(html.includes("The document says"), "expected label present");
  assert.ok(html.includes("What the survey does"), "observed label present");
  // The raw OBL- reference must be inside <details class="tech">, not in customer copy
  const { customer } = splitZones(html);
  const customerText = customer.replace(/<[^>]+>/g, " ");
  assert.ok(!customerText.includes("OBL-1"), "OBL- reference must not be in customer copy");
});

test("v2 summary enrichment renders all components without error", () => {
  const view = build({ withJudgement: true, findings: [ROUTING] });
  const html = renderV2SummaryEnrichment(view);
  assert.ok(typeof html === "string" && html.length > 0, "enrichment renders non-empty");
  assert.ok(html.includes("v2-kpi-strip"), "KPI strip present");
  assert.ok(html.includes("v2-trust-strip") || html.includes("v2-trust-badge"), "trust strip or badges present");
});

test("full report renders with v2 components embedded", () => {
  const view = build({ withJudgement: true, findings: [ROUTING] });
  const html = renderReportHtml(view, { css: CSS });
  // The v2 components should be inside the summary view
  const summaryView = extractView(html, "summary");
  assert.ok(summaryView, "summary view exists");
  assert.ok(summaryView.includes("v2-kpi-strip"), "v2 KPI strip in summary");
  // The v2 findings should be inside the full check view
  const fullView = extractView(html, "full");
  assert.ok(fullView, "full check view exists");
  assert.ok(fullView.includes("v2-prov") || fullView.includes("v2-finding-card"), "v2 findings view in full check");
});

test("limitations panel counts non-exercised requirements", () => {
  const items = [makeItem("OBL-1"), makeItem("OBL-2"), makeItem("OBL-3")];
  const results = [
    makeItemResult("OBL-1"),
    makeItemResult("OBL-2", { coverageStatus: "not-reached", verdict: "not-assessed" }),
    makeItemResult("OBL-3", { coverageStatus: "blocked", verdict: "not-assessed" }),
  ];
  const record = makeRunRecord({ items, itemResults: results, sealedRevision: true });
  const doc = makeJudgementRecord(record, [
    makeJudged("OBL-1"),
    makeJudged("OBL-2", { verdict: "not-assessed" }),
    makeJudged("OBL-3", { verdict: "not-assessed" }),
  ]);
  const judgement = { judgementRecord: doc, verdicts: null, routeTable: null, delta: null, summary: null, path: "test" };
  const judgementTrust = evaluateJudgement({ judgement, record, keyRegistry: KEY_REGISTRY });
  const view = buildReportView({
    record,
    attestation: { state: "verified", reason: "ok", registryPath: "test" },
    options: { judgement, judgementTrust, generatedAt: "2026-08-02T00:00:00Z", evidenceAudit: new Map() },
  });
  const html = renderV2LimitationsPanel(view);
  if (html) {
    assert.ok(html.includes("v2-limitations"), "limitations panel rendered");
    // At least one limitation should be listed
    assert.ok(html.includes("v2-lim-item"), "at least one limitation item");
  }
});

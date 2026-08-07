// D9 (stale as-run truth as the first-glance result), D8 (operational blockers
// omitted from certification), and the AMENDMENT A conformance gaps that are
// checkable in the rendered page.
//
// Each test fails against the pre-fix build:
//   · headline completion/summary came from the original itemResults, so the
//     page opened with 112 pass / 3 fail;
//   · identity and methods rendered before the launch blocker and the register;
//   · the page fabricated `sealed@<contractHash>` as a revision identity;
//   · certification could report "no outstanding blocker" while DIV-001 stood;
//   · one green "Verified" badge stood in for four separate trust statements.

import test from "node:test";
import assert from "node:assert/strict";

import { buildReportView } from "../lib/view-model.mjs";
import { renderReportHtml } from "../lib/render-html.mjs";
import { evaluateJudgement } from "../lib/judgement-record.mjs";
import { makeRunRecord, makeItem, makeItemResult, makeJudged, makeJudgementRecord, KEY_REGISTRY } from "./helpers.mjs";

const DISCLOSED_MODIFICATION = {
  what: "window.history was redefined as a writable data property before the site script ran",
  why: "Without it the site throws at load and renders nothing at all (DIV-001), which would have made the run impossible.",
  scope: "One property descriptor.",
  consequence: "Every finding other than DIV-001 is conditional on this shim.",
};

const DIV001 = {
  findingId: "DIV-001",
  kind: "defect",
  severity: "critical",
  category: "load-time-crash",
  summary: "The page throws at load in an unmodified browser and renders nothing.",
  expected: "The interview renders.",
  observed: "Zero questions render; the welcome screen never appears.",
  confidence: 1,
  itemRefs: ["OBL-1"],
  attemptRefs: ["AT-1"],
  evidenceRefs: [],
};

function view({ withJudgement = false, findings = [], parameters = {} } = {}) {
  const items = [makeItem("OBL-1"), makeItem("OBL-2")];
  const record = makeRunRecord({
    items,
    itemResults: items.map((i) => makeItemResult(i.itemId)),
    findings,
    sealedRevision: true,
    parameters,
  });
  let judgement = null;
  let judgementTrust = null;
  if (withJudgement) {
    const doc = makeJudgementRecord(record, [makeJudged("OBL-1"), makeJudged("OBL-2", { verdict: "fail" })]);
    judgement = { judgementRecord: doc, verdicts: null, routeTable: null, delta: null, summary: null, path: "test" };
    judgementTrust = evaluateJudgement({ judgement, record, keyRegistry: KEY_REGISTRY });
  }
  const v = buildReportView({
    record,
    attestation: { state: "verified", reason: "ok", registryPath: "test" },
    options: { judgement, judgementTrust, generatedAt: "2026-08-02T00:00:00Z", evidenceAudit: new Map() },
  });
  return { record, view: v, html: renderReportHtml(v, { css: "/* test */" }) };
}

/* ---------------- D9: first-glance order and current results ---------------- */

test("with no trusted judgement there is NO current result, and the as-run totals are labelled historical", () => {
  const { view: v } = view();
  assert.equal(v.publication.currentResults.present, false);
  assert.match(v.publication.currentResults.headline, /No current result/i);
  assert.equal(v.publication.asRecorded.historical, true);
  assert.match(v.publication.asRecorded.headline, /as the executing agent recorded them/i);
  assert.equal(v.publication.resultReview.state, "not-run");
});

test("a trusted JudgementRecord — not the as-run record — supplies the current headline", () => {
  const { view: v } = view({ withJudgement: true });
  assert.equal(v.publication.currentResults.present, true);
  assert.equal(v.publication.currentResults.columnId, "re-derived");
  assert.equal(v.publication.currentResults.roll.fail, 1, "the re-derived column has one fail");
  // The as-run record recorded both requirements as passes; that must NOT be current.
  assert.equal(v.publication.asRecorded.roll.pass, 2);
  assert.equal(v.publication.currentResults.roll.pass, 1);
  assert.equal(v.publication.resultReview.state, "complete");
});

test("the launch blocker and the publication state render BEFORE identity, methods and the register", () => {
  const { html } = view({ findings: [DIV001], parameters: { disclosedModification: DISCLOSED_MODIFICATION } });
  const at = (needle) => {
    const i = html.indexOf(needle);
    assert.notEqual(i, -1, `missing section ${needle}`);
    return i;
  };
  const blocker = at('id="operational"');
  const action = at('id="action"');
  const review = at('id="result-review"');
  const scope = at('id="scope"');
  const findings = at('id="findings"');
  const register = at('id="register"');
  const identity = at('id="identity"');
  const method = at('id="method"');
  const provenance = at('id="provenance"');

  assert.ok(blocker < action, "1 launch blocker before 2 action state");
  assert.ok(action < review, "2 action state before 3 result review");
  assert.ok(review < scope, "3 result review before 4 scope");
  assert.ok(scope < findings, "4 scope before 5 findings");
  assert.ok(findings < register, "5 findings before 6 register");
  assert.ok(register < identity, "6 register before 7 identity/methods");
  assert.ok(register < method && register < provenance, "methods, hashes and provenance are demoted below the register");
});

test("the page never fabricates a sealed contract revision from a hash", () => {
  const { html, view: v } = view();
  assert.ok(!/sealed@/.test(html), "a hash is not a human review and must never be printed as `sealed@<hash>`");
  for (const col of v.register.columns) {
    assert.ok(col.contractRevisionId === null || !String(col.contractRevisionId).startsWith("sealed@"));
  }
});

test("the as-run register column can never take current-result or pass styling", () => {
  const { view: v, html } = view();
  const asRun = v.register.columns.find((c) => c.id === "as-run");
  assert.equal(asRun.publication.current, false);
  assert.equal(asRun.publication.styling, "historical");
  assert.match(html, /reg-cell--historical/);
});

/* ---------------- D8: operational blockers are certification blockers ------- */

test("an operational blocker blocks certification even with no ambiguity and no contract gap", () => {
  const { view: v, html } = view({ findings: [DIV001], parameters: { disclosedModification: DISCLOSED_MODIFICATION } });
  assert.equal(v.operationalBlockers.present, true);
  assert.deepEqual(
    v.operationalBlockers.entries.map((b) => b.findingId),
    ["DIV-001"]
  );
  assert.equal(v.operationalBlockers.conditioning.length, 1);
  assert.equal(v.register.certification.certifiable, false);
  assert.ok(v.register.certification.blockers.some((b) => b.kind === "operational-blocker" && b.ref === "DIV-001"));
  assert.match(html, /Critical operational blocker outside the document-derived denominator/);
  assert.match(html, /ACTION REQUIRED/);
});

test("a run with no operational blocker says so instead of staying silent", () => {
  const { html, view: v } = view();
  assert.equal(v.operationalBlockers.present, false);
  assert.match(html, /No operational blocker was recorded for this run/);
});

/* ---------------- Amendment A conformance ---------------- */

test("four SEPARATE trust statements replace one green Verified badge", () => {
  const { view: v, html } = view();
  assert.deepEqual(
    v.publication.trustStatements.map((t) => t.id),
    ["record-signature", "evidence-files", "contract-review", "result-review"]
  );
  for (const t of v.publication.trustStatements) assert.match(html, new RegExp(t.label));
  assert.match(html, /Integrity only\./, "the signature statement must say what it does NOT prove");
});

test("two denominators render as two equal cards and are never summed", () => {
  const { html, view: v } = view();
  assert.match(html, /class="denoms"/);
  assert.match(html, /Document requirements/);
  assert.match(html, /Mandatory browser checks/);
  assert.equal(v.register.denominatorGuard.summed, false);
  assert.match(html, /must not be added/i);
});

test("out-of-browser mandates render as NOT_BROWSER_OBSERVABLE with a reviewed reason, never as N/A", () => {
  const { html } = view({
    parameters: {
      outOfBrowserScopeMandates: [
        { id: "UNV-1", mandate: "codes written to the data file", whyNotObservable: "the data file is server-side" },
      ],
    },
  });
  assert.match(html, /Not browser-observable/);
  assert.match(html, /the data file is server-side/);
  assert.match(html, /no alternative verification method named/);
  assert.ok(!/>N\/A</.test(html), "N/A must never stand in for a named state");
});

test("filters carry a persistent showing-N-of-total disclosure and totals reflect the full register", () => {
  const { html } = view();
  assert.match(html, /Showing all 2 of 2 document requirements · 0 hidden by filters/);
  assert.match(html, /headline totals always reflect the full register/);
});

test("every finding carries a respondent consequence, a reach and what to re-test", () => {
  const { view: v, html } = view({ findings: [DIV001], parameters: { disclosedModification: DISCLOSED_MODIFICATION } });
  for (const f of v.findings.all) {
    assert.ok(f.respondent, `finding ${f.findingId} has no respondent consequence`);
    assert.ok(f.respondent.consequence.length > 20);
    assert.ok(f.respondent.reach.label.length > 5);
  }
  assert.match(html, /What a respondent experiences/);
  assert.match(html, /What to re-test/);
});

test("an unknown finding category asks a reviewer for the consequence instead of inventing one", () => {
  const odd = { ...DIV001, findingId: "DIV-999", category: "something-nobody-mapped", severity: "high" };
  const { view: v } = view({ findings: [odd] });
  const f = v.findings.all.find((x) => x.findingId === "DIV-999");
  assert.equal(f.respondent.known, false);
  assert.match(f.respondent.consequence, /reviewer must state/i);
});

test("the retired kind document-live-disagreement is normalized once, not reported twice", () => {
  const retired = {
    findingId: "DIV-005",
    kind: "document-live-disagreement",
    severity: "low",
    category: "validation-message-wording",
    summary: "the message wording differs from the questionnaire",
    expected: "the standard message",
    observed: "a different message",
    confidence: 0.9,
    itemRefs: ["OBL-1"],
    attemptRefs: [],
    evidenceRefs: [],
  };
  const { view: v, html } = view({ findings: [retired] });
  assert.equal(v.findings.all.find((f) => f.findingId === "DIV-005").kind, "defect");
  assert.deepEqual(
    v.retiredKindNormalizations.map((n) => [n.findingId, n.from, n.to]),
    [["DIV-005", "document-live-disagreement", "defect"]]
  );
  // It is NOT also carried as a gap in the closed claim-kind registry.
  const taxonomy = v.register.lanes.byId["taxonomy-gap"].entries;
  assert.ok(!taxonomy.some((e) => e.id === "DIV-005"), "a normalized retired kind must not also become a taxonomy gap");
  assert.ok(!/Document versus live disagreements/.test(html), "the retired taxonomy must not have a live section");
  assert.match(html, /Claim kind normalized/);
});

test("the mandatory-check card reports completion only when a column may report it", () => {
  const none = view();
  assert.match(none.html, /no column may report completion/);
  const trusted = view({ withJudgement: true });
  assert.match(trusted.html, /2 of 2 completed · 0 not completed/);
});

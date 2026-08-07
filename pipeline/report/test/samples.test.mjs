// The real records, end to end. These are the runs the review was written
// about. The assertions are the invariants the review said the build was
// violating, checked against real data rather than a hand-built one.
//
// ─────────────────────────────────────────────────────────────────────────────
// PUBLICATION BOUNDARY, AND WHY THIS FILE NO LONGER SKIPS QUIETLY
//
// It used to open with a bare presence check on seven tests. In the
// owner's tree that is invisible; in a checkout without `pipeline/runs/t1-easy`
// — which is DERIVED from the blind corpus and is held back until the test runs
// are complete (docs/EVALUATION-BOUNDARY.md) — seven tests silently evaporated
// and the file still reported success. Silent skipping is exactly the failure
// class this project has spent the week deleting.
//
// So the file now names two SUBJECTS:
//
//   synthetic-demo   the public stand-in run (pipeline/runs/synthetic-demo),
//                    present in every checkout, driven through the REAL judge
//                    at test time. Every invariant below that is a property of
//                    the REPORT rather than of one survey runs against it, so a
//                    clean clone really checks them.
//   t1-easy          the private run. The tests that assert ITS NUMBERS — 112
//                    historical passes, 136 = 119 + 17, DIV-001, DIV-005 — have
//                    no honest synthetic equivalent, so they are gated with a
//                    STATED REASON and the gate count is pinned at the bottom
//                    of this file.
//
// The `samples/fixtures/*` records are PUBLISHED on purpose, so their absence is
// now a failure rather than a skip.
// ─────────────────────────────────────────────────────────────────────────────

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildReportView } from "../lib/view-model.mjs";
import { renderReportHtml } from "../lib/render-html.mjs";
import { loadJudgementBundle, evaluateJudgement, registryFor } from "../lib/judgement-record.mjs";
import { loadKeyRegistry, verifyAttestation } from "../../../scorer/src/lib/attest.mjs";
import { produceAcceptanceArtifact } from "../make-acceptance-artifact.mjs";
import { SYNTHETIC_RUN, PRIVATE_RUN, privateOnly, announcePrivateRunGate } from "../../runs/run-source.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const KEYS = path.join(ROOT, "scorer", "fixtures", "keys", "registry.json");
const T1 = path.join(PRIVATE_RUN, "run-record.json");
const REPLAY = path.join(ROOT, "pipeline", "judge", "replay");
const FIXTURES = path.join(HERE, "..", "samples", "fixtures");

const load = (p) => JSON.parse(readFileSync(p, "utf8"));

function viewOf(record, judgement, judgementTrust) {
  const registry = loadKeyRegistry(KEYS);
  const v = verifyAttestation(record, registry);
  const attestation = v.ok
    ? { state: "verified", reason: "ok", registryPath: KEYS }
    : { state: "invalid", reason: v.message, registryPath: KEYS };
  const view = buildReportView({
    record,
    attestation,
    options: { judgement, judgementTrust, generatedAt: "2026-08-01T22:30:00Z", evidenceAudit: new Map() },
  });
  return { record, view, html: renderReportHtml(view, { css: "/* test */" }) };
}

function render(recordPath, judgementPath) {
  const record = load(recordPath);
  const registry = loadKeyRegistry(KEYS);
  const judgement = judgementPath ? loadJudgementBundle(judgementPath) : null;
  const judgementTrust = judgement ? evaluateJudgement({ judgement, record, keyRegistry: registry, registryPath: KEYS }) : null;
  return viewOf(record, judgement, judgementTrust);
}

/**
 * The public stand-in, rendered from what the REAL judge emits over it at test
 * time. Nothing is committed standing in for it, so it cannot drift away from
 * the producer without this file going red.
 */
let syntheticCache = null;
function synthetic() {
  if (!syntheticCache) {
    const produced = produceAcceptanceArtifact({ runDir: SYNTHETIC_RUN });
    const judgement = {
      judgementRecord: produced.judgement,
      verdicts: null,
      routeTable: produced.judgement.routeTable ?? null,
      delta: null,
      summary: null,
      path: "synthetic",
    };
    const trust = evaluateJudgement({ judgement, record: produced.record, keyRegistry: registryFor(KEYS), registryPath: KEYS });
    syntheticCache = viewOf(produced.record, judgement, trust);
  }
  return syntheticCache;
}

/* ================================================================== *
 * INVARIANTS OF THE REPORT — asserted on every subject that exists.   *
 * ================================================================== */

const SUBJECTS = [
  ["synthetic-demo", () => synthetic(), {}],
  ["t1-easy", () => render(T1, REPLAY), privateOnly("renders the blind-derived run against its legacy replay bundle")],
];

for (const [label, make, gate] of SUBJECTS) {
  test(`${label}: mandatory execution cases reconcile to exactly one bucket each`, gate, () => {
    const { view } = make();
    const ec = view.register.denominators.executionCases;
    assert.equal(ec.enumerated, ec.total);
    assert.ok(ec.total > 0, "an empty case set would make this vacuous");
    for (const col of view.register.columns) {
      const bucketed = Object.values(ec.byColumn[col.id].states).reduce((a, n) => a + n, 0);
      assert.equal(bucketed, ec.total, `column ${col.id}: ${ec.total} declared, ${bucketed} bucketed`);
    }
    assert.ok(!view.integrity.warnings.some((w) => w.code === "CASE_BUCKET_RECONCILIATION"));
  });

  test(`${label}: no scoped rule takes its mandatory-case count from what the run observed`, gate, () => {
    const { view } = make();
    const unestablished = view.register.rows.filter((r) => r.expansion.established === false);
    assert.ok(unestablished.length > 0, "the contract does contain survey-wide and exclusion-scoped rules");
    for (const r of unestablished) {
      assert.equal(r.cases.length, 0);
      assert.notEqual(r.cellsByColumn["re-derived"]?.state, "PASS", `${r.itemId} passes on an unestablished case set`);
    }
  });

  test(`${label}: no fabricated sealed@<hash> revision identity anywhere on the page`, gate, () => {
    assert.ok(!/sealed@/.test(make().html));
  });

  test(`${label}: the documented-mandate denominator is the sum of its two parts`, gate, () => {
    const { view } = make();
    const dm = view.register.documentedMandates;
    assert.equal(dm.browserTestable + dm.otherMethod, dm.total);
    assert.ok(dm.total > 0);
    // ...and the register's own denominator is the browser-testable part, never
    // the whole documented population.
    assert.equal(view.register.denominators.documentRequirements.total, dm.browserTestable);
  });
}

/* ================================================================== *
 * t1-easy's OWN NUMBERS — no synthetic equivalent, so gated.          *
 * ================================================================== */

test("t1-easy renders, and the legacy replay bundle drives NO current result", privateOnly("asserts the blind-derived run's historical pass count and its legacy replay bundle"), () => {
  const { view, html } = render(T1, REPLAY);
  assert.equal(view.publication.judgement.state, "diagnostic");
  assert.equal(view.publication.currentResults.present, false);
  assert.equal(view.publication.hasCurrentResults, false);
  // the historical column is still visible, and still says 112 passes — as history
  assert.equal(view.publication.asRecorded.roll.pass, 112);
  assert.equal(view.publication.asRecorded.historical, true);
  assert.ok(html.length > 10000);
});

test("t1-easy: DIV-001 is an operational blocker and blocks certification", privateOnly("names a finding of the blind-derived run"), () => {
  const { view, html } = render(T1, REPLAY);
  assert.ok(view.operationalBlockers.entries.some((b) => b.findingId === "DIV-001"));
  assert.equal(view.register.certification.certifiable, false);
  assert.ok(view.register.certification.blockers.some((b) => b.ref === "DIV-001"));
  // and it renders before the register
  assert.ok(html.indexOf('id="operational"') < html.indexOf('id="register"'));
});

test("t1-easy: 136 documented mandates = 119 browser-testable + 17 requiring another method", privateOnly("pins the blind-derived run's documented-mandate counts"), () => {
  const { view } = render(T1, REPLAY);
  const dm = view.register.documentedMandates;
  assert.equal(dm.browserTestable, 119);
  assert.equal(dm.otherMethod, 17);
  assert.equal(dm.total, 136);
  assert.equal(view.register.denominators.documentRequirements.total, 119);
});

test("t1-easy: the retired document-live-disagreement kind is carried once", privateOnly("names a finding of the blind-derived run"), () => {
  const { view } = render(T1, REPLAY);
  assert.equal(view.retiredKindNormalizations.length, 1);
  assert.equal(view.retiredKindNormalizations[0].findingId, "DIV-005");
  assert.ok(!view.findings.all.some((f) => f.kind === "document-live-disagreement"));
  assert.ok(!view.register.lanes.byId["taxonomy-gap"].entries.some((e) => e.id === "DIV-005"));
});

/* ================================================================== *
 * THE PUBLISHED FIXTURES — absent is a FAILURE, not a skip.           *
 * ================================================================== */

const FIXTURE_FILES = [
  "derived-invalid-attestation.run-record.json",
  "derived-partial-budget.run-record.json",
  "derived-record-integrity.run-record.json",
  "derived-trusted-judgement.run-record.json",
  "derived-trusted-judgement.judgement-record.json",
  "derived-publication-gate.run-record.json",
  "derived-publication-gate.judgement-record.json",
];

test("the published report fixtures are all present", () => {
  // These belong to the OPEN corpus and are committed on purpose. When they went
  // missing every test below them turned into a silent skip; now their absence
  // is a red test that names the file and how to rebuild it.
  const missing = FIXTURE_FILES.filter((f) => !existsSync(path.join(FIXTURES, f)));
  assert.deepEqual(
    missing,
    [],
    `missing published fixture(s) in pipeline/report/samples/fixtures — rebuild with \`node pipeline/report/make-fixtures.mjs\`: ${missing.join(", ")}`
  );
});

for (const [name, file] of [
  ["invalid attestation", "derived-invalid-attestation.run-record.json"],
  ["partial budget", "derived-partial-budget.run-record.json"],
  ["record integrity", "derived-record-integrity.run-record.json"],
]) {
  test(`edge-case fixture renders: ${name}`, () => {
    const { view, html } = render(path.join(FIXTURES, file), null);
    assert.equal(view.publication.currentResults.present, false, "no judgement supplied means no current result");
    assert.equal(view.publication.resultReview.state, "not-run");
    assert.ok(html.includes('id="register"'));
  });
}

test("fixture: a trusted JudgementRecord DOES produce a current result", () => {
  const { view } = render(
    path.join(FIXTURES, "derived-trusted-judgement.run-record.json"),
    path.join(FIXTURES, "derived-trusted-judgement.judgement-record.json")
  );
  assert.equal(view.publication.judgement.state, "trusted");
  assert.equal(view.publication.currentResults.present, true);
  assert.equal(view.publication.currentResults.columnId, "re-derived");
  assert.equal(view.publication.resultReview.state, "complete");
});

test("fixture: the publication gate withholds unpublishable passes on an otherwise valid record", () => {
  const { view, html } = render(
    path.join(FIXTURES, "derived-publication-gate.run-record.json"),
    path.join(FIXTURES, "derived-publication-gate.judgement-record.json")
  );
  assert.equal(view.publication.judgement.state, "trusted");
  const states = view.register.denominators.documentRequirements.byColumn["re-derived"].states;
  assert.equal(states.JUDGMENT_PENDING, 3, "three recorded passes must fail the gate");
  assert.equal(states.MIXED, 1, "a pathConsistency of mixed must never render as a pass");
  assert.equal(view.publication.currentResults.roll.pass, 14);

  // AND THE CERTIFICATION BANNER MUST NOT CONTRADICT THOSE ROWS.
  // This record's JudgementRecord declares `certification.certifiable: true`, and the
  // report used to print "No certification blocker is outstanding" directly above its own
  // three withheld rows and one MIXED row — one of them (it-s1-role) withheld because a
  // cited witness did NOT re-verify, i.e. an evidence-integrity failure under a green
  // badge. Certification is recomputed against the rendered rows, never taken on the
  // judgement's word.
  const cert = view.register.certification;
  assert.equal(
    cert.certifiable,
    false,
    `certifiable must be false while the current column holds withheld/mixed rows: ${JSON.stringify(states)}`
  );
  const byRef = new Map(cert.blockers.map((b) => [b.ref, b]));
  for (const ref of ["it-s1-role", "it-s2-tenure", "it-s2-instruction"]) {
    assert.ok(byRef.has(ref), `withheld row ${ref} must be a named certification blocker`);
    assert.equal(byRef.get(ref).lane, "publication-gate");
  }
  assert.equal(byRef.get("it-s2-range")?.kind, "self-contradicting-row", "a MIXED row blocks certification too");
  assert.match(byRef.get("it-s1-role").detail, /did not re-verify/, "and the blocker states the integrity failure");
  assert.ok(!html.includes("No certification blocker is outstanding"), "the clean-certification banner must not render");
  assert.ok(cert.blockers.length > 0, "a blocked certification must always name its blockers");
});

/* ================================================================== *
 * the skip inventory is itself asserted                               *
 * ================================================================== */

/** Shared invariants asserted once per subject. Keep in step with the loop above. */
const SHARED_INVARIANTS = 4;
/** `privateOnly(...)` call sites: one inside SUBJECTS + four standalone pinned tests. */
const PRIVATE_GATE_SITES = 5;
/** So: the private SUBJECT's four invariants, plus the four pinned tests. */
const PRIVATE_GATED = SHARED_INVARIANTS + (PRIVATE_GATE_SITES - 1);

test("publication boundary: the private-run gate is exactly as declared", () => {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const sites = (src.match(/privateOnly\("/g) || []).length;
  assert.equal(sites, PRIVATE_GATE_SITES, `${sites} privateOnly() call sites, ${PRIVATE_GATE_SITES} declared`);
  assert.equal(SUBJECTS.length, 2, "one public subject and one private subject");
  assert.equal(PRIVATE_GATED, 8, "8 tests skip when the private run is absent; nothing else may");
  const silent = new RegExp(["skip", ":\\s*!existsSync"].join(""));
  assert.ok(!silent.test(src), "a bare existence check is a SILENT skip: gate with a stated reason instead");
});

announcePrivateRunGate("pipeline/report/test/samples.test.mjs", PRIVATE_GATED);

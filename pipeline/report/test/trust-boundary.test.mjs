// D2 (report half) — the re-derived column may be driven ONLY by a
// schema-validated, attested, run-bound JudgementRecord, and a recorded PASS
// must clear the publication gate before it is published as a pass.
//
// Each test here fails against the pre-fix build:
//   · the old cellFromJudged() produced PASS from `verdict: "pass"` whatever
//     attestation.allVerified said, and whatever contradicting evidence the
//     result carried;
//   · the old buildRegister() accepted arbitrary judgement JSON with no schema
//     check, no signature and no binding, and let it drive the register.

import test from "node:test";
import assert from "node:assert/strict";

import { buildRegister } from "../lib/register.mjs";
import {
  evaluateJudgement,
  validateJudgementRecordShape,
  evidenceManifestRoot,
  sealedContractRevision,
} from "../lib/judgement-record.mjs";
import { buildTrustStatements, evaluatePassPublication } from "../lib/publication.mjs";
import { makeRunRecord, makeItem, makeItemResult, makeJudged, makeJudgedUnverified, makeJudgementRecord, KEY_REGISTRY } from "./helpers.mjs";

function fixture({ sealedRevision = true, judgedOver = {}, unverified = false } = {}) {
  const items = [makeItem("OBL-1")];
  const record = makeRunRecord({
    items,
    itemResults: [makeItemResult("OBL-1")],
    evidence: [
      {
        evidenceId: "EV-1",
        type: "dom-snapshot",
        mediaType: "application/json",
        artifactRef: "runs/RUN-TEST-1/artifacts/A.json",
        contentHash: "sha256:w",
        byteLength: 10,
      },
    ],
    sealedRevision,
  });
  // `unverified` = the cited witnesses did NOT re-verify, spelled the way the
  // real judge spells it: well-formed attestation entries reporting ok:false.
  const judged = (unverified ? makeJudgedUnverified : makeJudged)("OBL-1", judgedOver);
  return { record, judged };
}

function register(record, judgementDoc) {
  const judgement = { judgementRecord: judgementDoc, verdicts: null, routeTable: null, delta: null, summary: null, path: "test" };
  const trust = evaluateJudgement({ judgement, record, keyRegistry: KEY_REGISTRY, registryPath: "test-registry" });
  return {
    trust,
    reg: buildRegister({ record, judgement, judgementTrust: trust, findings: [], runContext: {} }),
  };
}

test("a fully bound, attested JudgementRecord produces a CURRENT result column", () => {
  const { record, judged } = fixture();
  const { trust, reg } = register(record, makeJudgementRecord(record, [judged]));
  assert.equal(trust.state, "trusted", trust.problems.map((p) => p.message).join("\n"));
  const col = reg.columns.find((c) => c.id === "re-derived");
  assert.equal(col.publication.current, true);
  assert.equal(reg.publication.currentColumnId, "re-derived");
  assert.equal(reg.rows[0].cellsByColumn["re-derived"].state, "PASS");
});

test("an UNSIGNED JudgementRecord cannot drive current results", () => {
  const { record, judged } = fixture();
  const doc = makeJudgementRecord(record, [judged], { unsigned: true });
  const { trust, reg } = register(record, doc);
  assert.equal(trust.state, "diagnostic");
  assert.equal(reg.columns.find((c) => c.id === "re-derived").publication.current, false);
  assert.equal(reg.publication.currentColumnId, null);
  assert.equal(reg.publication.hasCurrentResults, false);
});

test("a JudgementRecord bound to a DIFFERENT run payload cannot drive current results", () => {
  const { record, judged } = fixture();
  const doc = makeJudgementRecord(record, [judged], { payloadHash: "sha256:" + "0".repeat(64) });
  const { trust } = register(record, doc);
  assert.equal(trust.state, "diagnostic");
  assert.ok(trust.problems.some((p) => p.code === "JUDGEMENT_BINDING_FAILED"));
});

test("a JudgementRecord bound to a different TARGET BUILD cannot drive current results", () => {
  const { record, judged } = fixture();
  const doc = makeJudgementRecord(record, [judged], { bindingOverrides: { targetBuildId: "BUILD-OTHER" } });
  const { trust } = register(record, doc);
  assert.equal(trust.state, "diagnostic");
  assert.ok(trust.problems.some((p) => /Target build id does not bind/.test(p.message)));
});

test("a JudgementRecord whose evidence-manifest root does not match cannot drive current results", () => {
  const { record, judged } = fixture();
  const doc = makeJudgementRecord(record, [judged], {
    bindingOverrides: { evidenceManifestRoot: "sha256:" + "f".repeat(64) },
  });
  const { trust } = register(record, doc);
  assert.equal(trust.state, "diagnostic");
  assert.ok(trust.problems.some((p) => /Evidence-manifest root does not bind/.test(p.message)));
  assert.notEqual(evidenceManifestRoot(record), "sha256:" + "f".repeat(64));
});

test("without a SEALED contract revision the judgement is unbindable — a hash is not a review", () => {
  const { record, judged } = fixture({ sealedRevision: false });
  const doc = makeJudgementRecord(record, [judged]);
  const { trust, reg } = register(record, doc);
  assert.equal(trust.state, "diagnostic");
  assert.ok(trust.problems.some((p) => /Sealed contract revision does not bind/.test(p.message)));
  // and no column may fabricate `sealed@<hash>` as an identity
  for (const col of reg.columns) {
    assert.ok(
      col.contractRevisionId === null || !String(col.contractRevisionId).startsWith("sealed@"),
      `column ${col.id} fabricated a revision identity: ${col.contractRevisionId}`
    );
  }
});

test("a legacy derived-verdict bundle is a DIAGNOSTIC, never a current result", () => {
  const { record, judged } = fixture();
  const judgement = {
    judgementRecord: null,
    verdicts: { kind: "derived-verdicts", engineVersion: "1.0.0", results: [judged] },
    routeTable: null,
    delta: null,
    summary: null,
    path: "test",
  };
  const trust = evaluateJudgement({ judgement, record, keyRegistry: KEY_REGISTRY });
  assert.equal(trust.state, "diagnostic");
  assert.ok(trust.problems.some((p) => p.code === "NO_JUDGEMENT_RECORD"));
  const reg = buildRegister({ record, judgement, judgementTrust: trust, findings: [], runContext: {} });
  assert.equal(reg.publication.hasCurrentResults, false);
  assert.equal(reg.columns.find((c) => c.id === "re-derived").publication.styling, "diagnostic");
});

test("a SEALED-BUT-UNREVIEWED revision is reported as sealed, with the missing review named", () => {
  // Every real v2 run seals its contract with `reviewedAt: null` (the workflow does), and
  // the projection spells that `reviewState: "sealed-unreviewed"`. That used to read as
  // NOT SEALED, so the page told a reader "this run was executed against an unreviewed
  // contract, identified only by its hash" about a run whose contract had been sealed
  // write-once behind four proof-bearing approval gates and whose revision id it could
  // name. Sealing and human review are two facts; neither may be inferred from the other.
  const items = [makeItem("OBL-1")];
  const record = makeRunRecord({ items, itemResults: [makeItemResult("OBL-1")], sealedRevision: true });
  record.contract.revision.reviewState = "sealed-unreviewed";
  record.contract.revision.sealedBy = null;

  const rev = sealedContractRevision(record);
  assert.equal(rev.sealed, true, "an immutable, gate-approved revision identity exists");
  assert.equal(rev.humanReviewed, false, "but nobody reviewed the extraction");
  assert.match(rev.why, /no human has reviewed/i, "and the page must say so in words");
  assert.equal(rev.revisionId, "CR-TEST-1");

  const trust = { state: "absent", verdicts: null, problems: [], binding: null, attestation: { state: "absent", reason: "" }, revision: rev, legacyBundle: false, source: null };
  const reg = buildRegister({ record, judgement: null, judgementTrust: trust, findings: [], runContext: {} });
  for (const col of reg.columns) {
    assert.equal(col.contractRevisionId, "CR-TEST-1", `column ${col.id} must name the sealed revision`);
    assert.match(col.contractRevisionNote, /not human-reviewed/, "and must carry the caveat, not deny the seal");
  }

  const statements = buildTrustStatements({
    attestation: { state: "verified", reason: "" },
    evidenceAudit: new Map(),
    evidenceCount: 0,
    revision: rev,
    resultReview: { state: "not-run", headline: "not run", policyVersion: null },
  });
  const contract = statements.find((s) => s.id === "contract-review");
  assert.equal(contract.state, "sealed-unreviewed", "neither a clean 'sealed' nor a false 'not-sealed'");
  assert.equal(contract.tone, "warn");
  assert.match(contract.value, /NOT human-reviewed/);
});

/* ---------------- the publication gate ---------------- */

test("a PASS whose witnesses did not re-verify becomes JUDGMENT_PENDING, not PASS", () => {
  const { record, judged } = fixture({
    unverified: true,
  });
  const { reg } = register(record, makeJudgementRecord(record, [judged]));
  const cell = reg.rows[0].cellsByColumn["re-derived"];
  assert.equal(cell.state, "JUDGMENT_PENDING");
  assert.equal(cell.wouldHaveBeen, "pass");
  assert.ok(cell.publicationGate.failed.includes("witnesses-reverified"));
});

test("a PASS carrying a counter-witness becomes JUDGMENT_PENDING — the trust killer fails closed", () => {
  const counter = [{ artifact: "A.json", sha256: "sha256:w", session: "S-1", seq: 2, locator: "evidence[1]", value: ["contradicts"] }];
  const { record, judged } = fixture({ judgedOver: { counterWitnesses: counter } });
  const { reg } = register(record, makeJudgementRecord(record, [judged]));
  const cell = reg.rows[0].cellsByColumn["re-derived"];
  assert.equal(cell.state, "JUDGMENT_PENDING");
  assert.ok(cell.publicationGate.failed.includes("no-contradicting-evidence"));
});

test("a PASS whose named predicate is not satisfied becomes JUDGMENT_PENDING", () => {
  const { record, judged } = fixture({ judgedOver: { predicateOutcome: "insufficient" } });
  const { reg } = register(record, makeJudgementRecord(record, [judged]));
  assert.equal(reg.rows[0].cellsByColumn["re-derived"].state, "JUDGMENT_PENDING");
});

test("JUDGMENT_PENDING never counts as a pass in any roll-up", () => {
  const { record, judged } = fixture({
    unverified: true,
  });
  const { reg } = register(record, makeJudgementRecord(record, [judged]));
  const roll = reg.denominators.documentRequirements.byColumn["re-derived"].roll;
  assert.equal(roll.pass, 0);
  assert.equal(roll.withheld, 1);
});

test("a FAIL on unverified evidence is KEPT as a fail but flagged — a defect is never dropped over bookkeeping", () => {
  const { record, judged } = fixture({
    unverified: true, judgedOver: { verdict: "fail" },
  });
  const { reg } = register(record, makeJudgementRecord(record, [judged]));
  const cell = reg.rows[0].cellsByColumn["re-derived"];
  assert.equal(cell.state, "FAIL");
  assert.equal(cell.evidenceUnverified, true);
});

/* ---------------- schema validation ---------------- */

test("schema validation rejects a non-JudgementRecord and an out-of-enum verdict", () => {
  assert.ok(validateJudgementRecordShape({ kind: "derived-verdicts" }).some((p) => p.code === "NOT_A_JUDGEMENT_RECORD"));
  const bad = validateJudgementRecordShape({
    kind: "judgement-record",
    schemaVersion: "survey-qa-judgement-record/1.0.0",
    generatedAt: "x",
    binding: {},
    results: [{ obligationId: "OBL-1", verdict: "MATCHES_DOCUMENT" }],
    attestation: {},
  });
  assert.ok(bad.some((p) => p.code === "BAD_VERDICT"));
  assert.ok(bad.some((p) => p.code === "MISSING_BINDING_FIELD"));
});

test("the gate reports every unmet condition, not just the first", () => {
  const g = evaluatePassPublication({ obligationId: "X", verdict: "pass" });
  assert.equal(g.publishable, false);
  assert.deepEqual(g.failed.sort(), ["cited-observation", "named-predicate", "witnesses-reverified", "proof-well-formed"].sort());
});

/* ---------------- cross-track shape divergence ---------------- */

test("a JudgementRecord VARIANT is named as a divergence, not accepted by alias", () => {
  const { record, judged } = fixture();
  const doc = makeJudgementRecord(record, [judged]);
  const variant = { ...doc, kind: "JudgementRecord", schemaVersion: "survey-qa.judgement-record/1.0.0" };
  const problems = validateJudgementRecordShape(variant);
  assert.ok(problems.some((p) => p.code === "JUDGEMENT_RECORD_SHAPE_DIVERGENCE"));
  assert.ok(!problems.some((p) => p.code === "BAD_SCHEMA_VERSION"), "the divergence is reported once, not twice");
  const { trust } = register(record, variant);
  assert.equal(trust.state, "diagnostic");
});

test("a producer that declares its own record unpublishable is obeyed", () => {
  const { record, judged } = fixture();
  const doc = makeJudgementRecord(record, [judged]);
  const { trust } = register(record, { ...doc, publishable: false, unbindableFields: ["proofVersion"] });
  assert.equal(trust.state, "diagnostic");
  assert.ok(trust.problems.some((p) => p.code === "PRODUCER_DECLARED_UNPUBLISHABLE"));
});

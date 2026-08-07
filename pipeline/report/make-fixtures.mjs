#!/usr/bin/env node
// Derives UI fixtures from the REAL integration records so the renderer's
// honesty paths can be seen, not just asserted. Every fixture is a documented
// mutation of a real record and every rendered fixture carries a loud
// "synthetic fixture — not a real run" strip (--fixture-note).
//
// Fixtures produced (docs/ui-report-redesign.md §6.1 fixture list):
//   1. invalid-attestation   — signature tampered, NOT re-signed  -> fail-closed banner
//   2. partial-budget        — run stopped at the budget cap, re-signed -> partial banner
//   3. record-integrity      — missing dispositions + an illegal status/verdict pair,
//                              re-signed -> warnings shown, nothing normalised
//
// Records 2 and 3 are re-signed with the TEST-ONLY fixture harness key so the
// attestation state stays "verified" and the fixture demonstrates exactly one
// thing. Usage: node make-fixtures.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { signRecord, payloadHashOf } from "../../scorer/src/lib/attest.mjs";
import { evidenceManifestRoot } from "./lib/judgement-record.mjs";
// READ-ONLY import of the REAL producer, so the fixture envelope is the one the
// judge builds rather than one shaped to satisfy the report.
import { buildJudgementRecord } from "../judge/lib/judgement-record.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const OUT = path.join(HERE, "samples", "fixtures");
const KEY = path.join(ROOT, "scorer", "fixtures", "keys", "TEST-ONLY-fixture-harness.private.pem");
const CLEAN = path.join(ROOT, "scorer", "integration", "runs", "clean", "run-record.json");
const FLAWED = path.join(ROOT, "scorer", "integration", "runs", "flawed", "run-record.json");

const load = (p) => JSON.parse(readFileSync(p, "utf8"));
const privateKeyPem = readFileSync(KEY, "utf8");

mkdirSync(OUT, { recursive: true });

function resign(record) {
  record.attestation = signRecord(record, privateKeyPem, "fixture-harness-key-1", "2026-08-01T22:30:00Z");
  return record;
}

function write(name, record) {
  const file = path.join(OUT, name);
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
  return file;
}

function render(recordFile, outFile, note) {
  execFileSync(
    process.execPath,
    [
      path.join(HERE, "render-report.mjs"),
      recordFile,
      "-o",
      path.join(OUT, outFile),
      "--generated-at",
      "2026-08-01T22:30:00Z",
      "--fixture-note",
      note,
    ],
    { stdio: "inherit" }
  );
}

/* 1 — tampered signature, deliberately NOT re-signed. */
{
  const rec = load(FLAWED);
  rec.run.runId = "RUN-FIXTURE-TAMPERED";
  // Flip one base64url character of the signature; everything else is intact.
  const sig = rec.attestation.signature;
  rec.attestation.signature = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
  const f = write("derived-invalid-attestation.run-record.json", rec);
  render(
    f,
    "fixture-invalid-attestation.html",
    "Derived from scorer/integration/runs/flawed/run-record.json: the run ID was changed and one character of the Ed25519 signature was flipped. Nothing else was touched. This exists only to show the fail-closed path; it is not a real run."
  );
}

/* 2 — testing stopped at the budget cap, re-signed so attestation stays valid. */
{
  const rec = load(CLEAN);
  rec.run.runId = "RUN-FIXTURE-PARTIAL-BUDGET";
  const stopped = ["it-q5-barrier", "it-q6-nps", "it-q6-instruction", "it-q6-range", "it-completion"];
  rec.itemResults = rec.itemResults.map((r) =>
    stopped.includes(r.itemId)
      ? {
          ...r,
          coverageStatus: "budget-exhausted",
          verdict: "not-assessed",
          reason: {
            code: "budget-exhausted",
            summary: "Run reached the enforced monetary cap before this obligation was exercised",
          },
          attemptRefs: [],
          evidenceRefs: [],
        }
      : r
  );
  rec.attempts[rec.attempts.length - 1].stop = {
    reason: "budget-limit",
    detail: "Enforced monetary cap reached with the verification and reporting reserve still protected",
    lastValidStateId: rec.attempts[rec.attempts.length - 1].stop.lastValidStateId,
  };
  rec.resources.totals.totalCostUsd = 22.4;
  rec.resources.totals.modelCostUsd = 22.2;
  const f = write("derived-partial-budget.run-record.json", resign(rec));
  render(
    f,
    "fixture-partial-budget.html",
    "Derived from scorer/integration/runs/clean/run-record.json: five obligations were rewritten to budget-exhausted / not-assessed, the last attempt's stop reason was set to budget-limit, and the cost total was raised to $22.40 against the $25.00 cap. The record was then re-signed with the TEST-ONLY fixture key so attestation stays valid and the partial-run path is the only thing on show."
  );
}

/* 3 — structurally broken record: missing dispositions + illegal pair. */
{
  const rec = load(FLAWED);
  rec.run.runId = "RUN-FIXTURE-BROKEN-RECORD";
  rec.itemResults = rec.itemResults.filter((r) => r.itemId !== "it-q4-satisfaction" && r.itemId !== "it-q5-barrier");
  rec.itemResults = rec.itemResults.map((r) =>
    r.itemId === "it-q1-range"
      ? { ...r, coverageStatus: "not-reached", verdict: "pass", attemptRefs: [], evidenceRefs: [] }
      : r
  );
  rec.itemResults.push({
    itemId: "it-does-not-exist",
    coverageStatus: "exercised",
    verdict: "pass",
    reason: { code: "requirement-met", summary: "Disposition for an obligation that is not in the contract" },
    confidence: 0.9,
    attemptRefs: ["AT-1"],
    evidenceRefs: ["EV-F-S1"],
  });
  const f = write("derived-record-integrity.run-record.json", resign(rec));
  render(
    f,
    "fixture-record-integrity.html",
    "Derived from scorer/integration/runs/flawed/run-record.json: two dispositions were deleted, one obligation was given the illegal pair not-reached + pass, and a disposition for a non-existent obligation was added. Re-signed with the TEST-ONLY fixture key. It shows that the renderer reports structural damage instead of quietly repairing it."
  );
}

/* ------------------------------------------------------------------ *
 * 4 and 5 — the JudgementRecord trust boundary, rendered.
 *
 * RunRecord v1.0.0 has no sealed ContractRevision and the judging engine does
 * not yet mint a JudgementRecord, so the only way to SEE the current-results
 * path and the publication gate is to build both here, from a real record,
 * and say loudly that they are synthetic.
 * ------------------------------------------------------------------ */

function sealedRecordFrom(sourceFile, runId) {
  const rec = load(sourceFile);
  rec.run.runId = runId;
  rec.contract.revision = {
    contractRevisionId: "CR-FIXTURE-1",
    contractRevisionHash: "sha256:" + "cr".repeat(32),
    reviewState: "sealed",
    sealedAt: "2026-08-01T20:00:00Z",
    sealedBy: "TEST-ONLY fixture reviewer",
  };
  return resign(rec);
}

/**
 * The judge's `attestAll` projection (pipeline/judge/lib/engine.mjs). The
 * attested witness carries `expected`, not `value`, and the artifact digest
 * sits BESIDE it — the previous spelling of these fixtures nested the PUBLIC
 * witness verbatim, which is a shape the real judge cannot emit and which is
 * why GPT ruled the enriched fixture unrepresentative.
 */
function attestationEntry(w, { ok = true, reason = null } = {}) {
  return {
    witness: {
      artifact: w.artifact,
      session: w.session ?? null,
      seq: w.seq ?? null,
      locator: w.locator,
      expected: w.value,
      note: w.note ?? null,
      proofKind: w.proofKind ?? "capture-field",
      proofClaim: null,
    },
    ok,
    reason: ok ? null : (reason ?? "WITNESS_REREAD_FAILED"),
    proofKind: w.proofKind ?? "capture-field",
    sha256: ok ? w.sha256 : null,
  };
}

function judgedFor(rec, itemId, over = {}) {
  const res = rec.itemResults.find((r) => r.itemId === itemId);
  const evId = (res?.evidenceRefs ?? [])[0] ?? null;
  const ev = rec.evidence.find((e) => e.evidenceId === evId) ?? null;
  const w = ev
    ? {
        artifact: ev.artifactRef.split("/").pop(),
        sha256: ev.contentHash,
        session: res.attemptRefs?.[0] ?? "AT-1",
        seq: 1,
        locator: ev.capture?.captureStep ?? "capture",
        value: [res.reason?.summary ?? "observed"],
        note: "re-read from the artifact bytes by the judging engine",
        proofKind: "capture-field",
      }
    : null;
  const supporting = over.supportingWitnesses ?? (w ? [w] : []);
  const counter = over.counterWitnesses ?? [];
  return {
    obligationId: itemId,
    category: "question",
    statement: rec.contract.items.find((i) => i.itemId === itemId)?.requirement ?? itemId,
    verdict: res?.verdict ?? "not-assessed",
    coverage: res?.coverageStatus ?? "pending",
    disposition: "none",
    reason: "POSITIVE_WITNESS",
    withheld: null,
    note: null,
    expectation: { kind: "rendered-state", screen: "S1", compiledBy: "R-1", compilerVersion: "1.0.0" },
    compiledBy: "R-1",
    predicateId: "rendered-state@1",
    predicateOutcome: "satisfied",
    predicateReason: "POSITIVE_WITNESS",
    predicateDetail: {},
    evidenceScope: { claimKind: "positive-witness" },
    pathConsistency: "consistent",
    evidenceRefs: [...supporting, ...counter].map((x) => ({
      artifact: x.artifact,
      sha256: x.sha256,
      locators: [x.locator],
    })),
    supportingWitnesses: supporting,
    counterWitnesses: counter,
    attestation: {
      positive: supporting.map((x) => attestationEntry(x)),
      counter: counter.map((x) => attestationEntry(x)),
      allVerified: supporting.length + counter.length > 0,
      witnessCount: supporting.length + counter.length,
      hashAuthority: "signed-run-record",
    },
    ...over,
  };
}

/**
 * The ENVELOPE is built by the real producer (`pipeline/judge/lib/judgement-record.mjs`
 * `buildJudgementRecord`), read-only, so `status`, `publishable`,
 * `renderingConstraint` and `unbindableFields` are decided by the stage that
 * decides them in production rather than typed here to suit the consumer.
 */
function mintJudgementRecord(rec, results) {
  const rev = rec.contract.revision;
  const doc = buildJudgementRecord({
    authority: {
      verified: true,
      contractSealed: true,
      runId: rec.run.runId,
      runRecordPayloadHash: payloadHashOf(rec),
      contractRevisionId: rev.contractRevisionId,
      contractRevisionHash: rev.contractRevisionHash,
      targetBuildId: rec.run.target.buildId,
      evidenceManifestRoot: evidenceManifestRoot(rec),
    },
    versions: {
      engineVersion: "1.0.0",
      compilerVersion: "1.0.0",
      predicateVersion: "1.0.0",
      ambiguityPolicyVersion: "1.0.0",
      proofVersion: "1.0.0",
    },
    generatedAt: "2026-08-01T22:00:00Z",
    denominator: { obligations: results.length, rule: "the fixture's contract items" },
    counts: {},
    certification: { certifiable: true, blockers: [], integrity: [] },
    results,
    routeTable: null,
    ambiguityIndex: { version: "1.0.0", map: {}, integrity: [] },
    source: { runDir: "fixture" },
    // The producer will not declare a record publishable unless the caller can
    // prove the evidence set came from this authority, that every compiled
    // obligation field was signature-covered, and that the ambiguity set was
    // too. In a derived fixture all three hold by construction.
    evidenceBinding: { bound: true, problems: [] },
    contractFieldsBound: true,
    ambiguitiesSigned: true,
  });
  const signed = { judgementId: `JR-${rec.run.runId}`, ...doc };
  signed.attestation = signRecord(signed, privateKeyPem, "fixture-harness-key-1", "2026-08-01T22:30:00Z");
  return signed;
}

function renderWithJudgement(recordFile, judgementFile, outFile, note) {
  execFileSync(
    process.execPath,
    [
      path.join(HERE, "render-report.mjs"),
      recordFile,
      "-o",
      path.join(OUT, outFile),
      "--judgement",
      judgementFile,
      "--generated-at",
      "2026-08-01T22:30:00Z",
      "--fixture-note",
      note,
    ],
    { stdio: "inherit" }
  );
}

/* 4 — a trusted JudgementRecord: the ONLY shape that produces current results. */
{
  const rec = sealedRecordFrom(CLEAN, "RUN-FIXTURE-TRUSTED-JUDGEMENT");
  const f = write("derived-trusted-judgement.run-record.json", rec);
  const doc = mintJudgementRecord(
    rec,
    rec.contract.items.map((i) => judgedFor(rec, i.itemId))
  );
  const jf = write("derived-trusted-judgement.judgement-record.json", doc);
  renderWithJudgement(
    f,
    jf,
    "fixture-trusted-judgement.html",
    "Derived from scorer/integration/runs/clean/run-record.json: a sealed ContractRevision was added, the record re-signed with the TEST-ONLY fixture key, and a JudgementRecord was minted and signed with the same key, bound to the run payload hash, the sealed revision, the target build and the evidence-manifest root. It exists to show the ONLY configuration in which this report publishes a current result."
  );
}

/* 5 — the publication gate biting: three ways a recorded pass fails to publish. */
{
  const rec = sealedRecordFrom(CLEAN, "RUN-FIXTURE-PUBLICATION-GATE");
  const f = write("derived-publication-gate.run-record.json", rec);
  const ids = rec.contract.items.map((i) => i.itemId);
  const results = ids.map((id, idx) => {
    if (idx === 0) {
      // cited evidence did not re-verify. Expressed as the judge expresses it:
      // the attestation entries EXIST and report ok:false. An empty attestation
      // set is not a failed re-verification, it is a missing one, and D11 now
      // names the difference.
      const j = judgedFor(rec, id);
      j.attestation = {
        positive: j.supportingWitnesses.map((x) => attestationEntry(x, { ok: false })),
        counter: [],
        allVerified: false,
        witnessCount: j.supportingWitnesses.length,
        hashAuthority: "signed-run-record",
      };
      return j;
    }
    if (idx === 1) {
      // the evidence set contradicts the recorded pass
      return judgedFor(rec, id, {
        counterWitnesses: [
          {
            artifact: "counter.json",
            sha256: "sha256:" + "ee".repeat(32),
            session: "AT-1",
            seq: 9,
            locator: "evidence[9]",
            value: ["the captured page shows the opposite of the recorded verdict"],
            note: "counter-witness attached to a result recorded as a pass",
          },
        ],
      });
    }
    if (idx === 2) {
      // the named decision predicate did not report satisfied
      return judgedFor(rec, id, { predicateOutcome: "insufficient", reason: "INSUFFICIENT_SAMPLE" });
    }
    if (idx === 3) {
      // routes disagree inside one run
      return judgedFor(rec, id, { pathConsistency: "mixed" });
    }
    return judgedFor(rec, id);
  });
  const doc = mintJudgementRecord(rec, results);
  const jf = write("derived-publication-gate.judgement-record.json", doc);
  renderWithJudgement(
    f,
    jf,
    "fixture-publication-gate.html",
    "Derived from scorer/integration/runs/clean/run-record.json with a sealed ContractRevision and a signed, fully bound JudgementRecord in which four recorded passes are deliberately unpublishable: one whose witnesses did not re-verify, one carrying a counter-witness, one whose named predicate was not satisfied, and one whose routes disagree. It exists to show the publication gate failing closed on a record that is otherwise entirely valid."
  );
}

process.stdout.write(`make-fixtures: wrote fixtures to ${OUT}\n`);

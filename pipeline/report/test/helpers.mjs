// Test helpers: build minimal, well-formed RunRecords and JudgementRecords.
//
// These are deliberately small. The point of each test is one behaviour, and a
// 2 MB real record makes it impossible to see which field caused the outcome.
// The real records are exercised separately by pipeline/report/test/samples.test.mjs.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { signRecord, loadKeyRegistry } from "../../../scorer/src/lib/attest.mjs";
import { evidenceManifestRoot, sealedContractRevision } from "../lib/judgement-record.mjs";
// READ-ONLY import of the REAL producer. The report's unit fixtures are built
// by the stage that builds them in production, so a fixture cannot drift into a
// shape the real judge could never emit.
import { buildJudgementRecord } from "../../judge/lib/judgement-record.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..", "..");
export const KEY_REGISTRY_PATH = path.join(ROOT, "scorer", "fixtures", "keys", "registry.json");
const PRIVATE_KEY = readFileSync(
  path.join(ROOT, "scorer", "fixtures", "keys", "TEST-ONLY-fixture-harness.private.pem"),
  "utf8"
);
export const KEY_REGISTRY = loadKeyRegistry(KEY_REGISTRY_PATH);
export const KEY_ID = "fixture-harness-key-1";
const SIGNED_AT = "2026-08-02T00:00:00Z";

export function sign(record) {
  const { attestation, ...rest } = record;
  void attestation;
  return { ...rest, attestation: signRecord(rest, PRIVATE_KEY, KEY_ID, SIGNED_AT) };
}

/**
 * A minimal RunRecord. `sealedRevision: true` adds the reviewed ContractRevision
 * block a JudgementRecord must bind to.
 */
export function makeRunRecord({
  items = [],
  itemResults = [],
  findings = [],
  evidence = [],
  parameters = {},
  sealedRevision = false,
  buildId = "BUILD-1",
} = {}) {
  const record = {
    schemaVersion: "1.0.0",
    run: {
      runId: "RUN-TEST-1",
      target: { url: "https://example.invalid/s", environment: "test", buildId, buildHash: "sha256:build" },
      documentHash: "sha256:doc",
      contractHash: "sha256:contract",
      configuration: { profileId: "test", configurationHash: "sha256:cfg", parameters },
      timestamps: { createdAt: SIGNED_AT, startedAt: SIGNED_AT, endedAt: SIGNED_AT },
    },
    contract: {
      extraction: { method: "fixture", extractorVersion: "test", extractedAt: SIGNED_AT },
      assumptions: [],
      items,
      ...(sealedRevision
        ? {
            revision: {
              contractRevisionId: "CR-TEST-1",
              contractRevisionHash: "sha256:revision",
              reviewState: "sealed",
              sealedAt: SIGNED_AT,
              sealedBy: "test-reviewer",
            },
          }
        : {}),
    },
    attempts: [{ attemptId: "AT-1", stop: { reason: "path-complete", detail: "", lastValidStateId: "S1" } }],
    itemResults,
    findings,
    evidence,
    resources: { totals: {}, limits: {}, modelCalls: [], toolVersions: [] },
  };
  return sign(record);
}

export function makeItem(itemId, extra = {}) {
  return {
    itemId,
    type: "question",
    sourceAnchor: { locator: `S1 / ${itemId}`, quote: `quote for ${itemId}`, aliases: [] },
    requirement: `requirement ${itemId}`,
    expectedObservable: `expected observable ${itemId}`,
    stimulus: null,
    preconditions: [],
    variants: [],
    confidence: 0.99,
    ...extra,
  };
}

export function makeItemResult(itemId, { coverageStatus = "exercised", verdict = "pass", evidenceRefs = ["EV-1"] } = {}) {
  return {
    itemId,
    coverageStatus,
    verdict,
    reason: { code: verdict === "pass" ? "requirement-met" : "requirement-mismatch", summary: "as recorded" },
    confidence: 0.9,
    attemptRefs: ["AT-1"],
    evidenceRefs,
  };
}

/*
 * WITNESS AND ATTESTATION SHAPE
 * -----------------------------
 * These mirror the REAL judge's two projections exactly
 * (pipeline/judge/lib/engine.mjs — `publicWitness` and `attestAll`), because a
 * fixture whose witness could not be emitted by the real judge proves nothing
 * about the real path:
 *   · the PUBLIC witness carries `value` and an inline `sha256`;
 *   · the ATTESTED witness carries `expected` (not `value`), no inline hash,
 *     and the digest sits BESIDE it as `entry.sha256`.
 * A digest that is not 64 hex characters is not a digest, so "sha256:w" — which
 * these helpers used to carry — is gone.
 *
 * The end-to-end acceptance proof does not rely on any of this: it runs the
 * real judge over the real frozen run (test/real-artifact.test.mjs).
 */
const HEX = (seed) => seed.repeat(64).slice(0, 64);

const witness = (artifact = "A.json", seed = "a") => ({
  artifact,
  sha256: `sha256:${HEX(seed)}`,
  session: "S-1",
  seq: 1,
  locator: "evidence[0]",
  value: ["observed"],
  note: null,
  proofKind: "capture-field",
});

/** The judge's `attestAll` projection of a witness. */
export function attestationEntry(w, { ok = true, reason = null } = {}) {
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

/**
 * A judged result that CLEARS the publication gate.
 *
 * The predicate outcome and the witness sides are DERIVED from the verdict. A
 * "fail" whose named predicate reported `satisfied`, or a fail with no
 * counter-witness, is not a result the judge can emit — deriving them keeps
 * `makeJudged(id, { verdict: "fail" })` a real result rather than a pass with
 * the label swapped.
 */
export function makeJudged(obligationId, over = {}) {
  const verdict = over.verdict ?? "pass";
  const failing = verdict === "fail";
  const supporting = over.supportingWitnesses ?? (failing ? [] : [witness()]);
  const counter = over.counterWitnesses ?? (failing ? [witness("B.json", "b")] : []);
  return {
    obligationId,
    category: "question",
    statement: `requirement ${obligationId}`,
    verdict: "pass",
    coverage: "exercised",
    disposition: failing ? "defect" : "none",
    reason: failing ? "OPTION_ABSENT" : "POSITIVE_WITNESS",
    withheld: null,
    note: null,
    expectation: { kind: "rendered-state", screen: "S1", compiledBy: "R-1", compilerVersion: "1.0.0" },
    compiledBy: "R-1",
    predicateId: "rendered-state@1",
    predicateOutcome: failing ? "violated" : "satisfied",
    predicateReason: failing ? "OPTION_ABSENT" : "POSITIVE_WITNESS",
    predicateDetail: {},
    evidenceScope: { claimKind: "positive-witness" },
    pathConsistency: "consistent",
    evidenceRefs: [...supporting, ...counter].map((w) => ({
      artifact: w.artifact,
      sha256: w.sha256,
      locators: [w.locator],
    })),
    supportingWitnesses: supporting,
    counterWitnesses: counter,
    attestation: {
      positive: supporting.map((w) => attestationEntry(w)),
      counter: counter.map((w) => attestationEntry(w)),
      allVerified: supporting.length + counter.length > 0,
      witnessCount: supporting.length + counter.length,
      hashAuthority: "signed-run-record",
    },
    ...over,
  };
}

/**
 * A judged result whose cited witnesses DID NOT re-verify — expressed the way
 * the real judge expresses it: a well-formed attestation whose entries report
 * `ok: false`. The old spelling (`{ allVerified: false, positive: [], counter: [] }`)
 * is not a failed re-verification, it is a record with no attestations at all,
 * and D11 now names that as a broken proof rather than a failed one.
 */
export function makeJudgedUnverified(obligationId, over = {}) {
  const j = makeJudged(obligationId, over);
  return {
    ...j,
    attestation: {
      positive: j.supportingWitnesses.map((w) => attestationEntry(w, { ok: false })),
      counter: j.counterWitnesses.map((w) => attestationEntry(w, { ok: false })),
      allVerified: false,
      witnessCount: j.supportingWitnesses.length + j.counterWitnesses.length,
      hashAuthority: "signed-run-record",
    },
  };
}

/**
 * A JudgementRecord bound to `record`. Pass `bindingOverrides` to break exactly
 * one binding and prove the boundary is fail-closed.
 */
export function makeJudgementRecord(record, results, { bindingOverrides = {}, unsigned = false, payloadHash = null } = {}) {
  const { payloadHashOf } = judgementDeps;
  const revision = sealedContractRevision(record);
  // THE REAL PRODUCER assembles the envelope. Hand-writing `status`,
  // `publishable`, `renderingConstraint` and `unbindableFields` here is how a
  // consumer-shaped fixture is born; the judge's own `buildJudgementRecord`
  // decides them from the authority it is given, exactly as it does in
  // production. `bindingOverrides` is applied AFTER the build, because a
  // deliberately broken binding is the point of the negative tests.
  const authority = {
    verified: true,
    contractSealed: revision.sealed,
    runId: record.run.runId,
    runRecordPayloadHash: payloadHash ?? payloadHashOf(record),
    contractRevisionId: revision.revisionId,
    contractRevisionHash: revision.revisionHash,
    targetBuildId: record.run.target.buildId,
    evidenceManifestRoot: evidenceManifestRoot(record),
  };
  let doc = buildJudgementRecord({
    authority,
    versions: {
      engineVersion: "1.0.0",
      compilerVersion: "1.0.0",
      predicateVersion: "1.0.0",
      ambiguityPolicyVersion: "1.0.0",
      proofVersion: "1.0.0",
    },
    generatedAt: SIGNED_AT,
    denominator: { obligations: results.length, rule: "test fixture" },
    counts: {},
    certification: { certifiable: true, blockers: [], integrity: [] },
    results,
    routeTable: null,
    ambiguityIndex: { version: "1.0.0", map: {}, integrity: [] },
    source: { runDir: "test" },
    // The judge refuses to declare a record publishable unless the caller can
    // prove three things the authority does not imply: that the evidence set
    // came from THIS authority, that every compiled obligation field was
    // covered by the signature, and that the ambiguity set was too. In a unit
    // fixture all three hold by construction — the record, the checklist and
    // the judged results are the same object graph — so they are asserted
    // here rather than left undefined, which the producer (correctly) treats
    // as a failure to prove them.
    evidenceBinding: { bound: true, problems: [] },
    contractFieldsBound: true,
    ambiguitiesSigned: true,
  });
  doc = { judgementId: "JR-TEST-1", ...doc };
  if (Object.keys(bindingOverrides).length) {
    doc = { ...doc, binding: { ...doc.binding, ...bindingOverrides } };
  }
  if (unsigned) return doc;
  // Signed directly rather than via `attestJudgementRecord`, which correctly
  // refuses to sign an unbindable record — several tests need exactly that
  // combination (a valid signature over a record that does not bind) to prove
  // the report does not let a signature rescue a binding failure.
  return sign(doc);
}

// Imported lazily so helpers.mjs stays importable without a cycle.
import * as judgementDeps from "../../../scorer/src/lib/attest.mjs";

#!/usr/bin/env node
// gate-coverage.mjs — one NEGATIVE case per live gate the 285-check suite could
// not detect the loss of (audit finding 11: "45% kill rate; at least 16 of 29
// single-line deletions of live checks leave the suite fully green").
//
// Every assertion here was written against a measured surviving mutant in
// scorer/test/mutation/mutants.mjs. Each one is a case that PASSES today and
// FAILS if the named guard is removed, so the mutant dies. The mutant id is
// quoted beside each block; run
//
//     node scorer/test/mutation/run-mutations.mjs --only <ID>
//
// to see exactly which guard a test defends.
//
// Level: these call the gate functions directly rather than re-signing whole
// fixtures. That is deliberate — a gate test that has to route through
// attestation, schema validation and matching before it reaches the guard is
// testing the pipeline, not the guard, and it cannot isolate two guards that
// are individually redundant (the attestation layer is exactly that case).
//
// Exits non-zero on any mismatch.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { jcsHash, sha256OfBytes } from "../src/lib/canonical.mjs";
import {
  signRecord,
  verifyAttestation,
  generateFixtureKeypair,
  payloadHashOf,
} from "../src/lib/attest.mjs";
import {
  checkOracleIntegrity,
  checkIdentity,
  checkOracleAccess,
  checkRunIntegrity,
} from "../src/lib/integrity.mjs";
import { assessArtifacts, assessClaims } from "../src/lib/evidence.mjs";
import { reconcileResources } from "../src/lib/resources.mjs";
import { computeMetricsAndCompleteness } from "../src/lib/metrics.mjs";
import { matchObligations, stringSim, scorePair } from "../src/lib/matcher.mjs";
import { matchDefects } from "../src/lib/defect-match.mjs";

import { sha256OfString } from "../oracle/lib/corpus.mjs";
import { checkManifestCoverage } from "../oracle/lib/schema-guard.mjs";
import { applyPatchOp, mapSeededErrors } from "../oracle/lib/seeded-map.mjs";
import { deriveOracle } from "../oracle/lib/derive.mjs";
import { buildSurvey } from "../oracle/lib/pipeline.mjs";
import { reachabilityAgainstTarget, targetIndexOf } from "../oracle/lib/serialize.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATES = path.resolve(HERE, "..", "fixtures", "gates");
const GATE_ARTIFACTS = path.join(GATES, "artifacts");

let checksRun = 0;
let failures = 0;
const failureDetails = [];

function check(label, ok, detail) {
  checksRun++;
  if (!ok) {
    failures++;
    failureDetails.push(`${label}: ${detail}`);
    console.error(`FAIL  ${label}: ${detail}`);
  }
}

const codes = (list) => new Set(list.map((e) => e.code));
const clone = (v) => JSON.parse(JSON.stringify(v));

/* ======================================================================== */
/* attest.mjs                                                                */
/* ======================================================================== */
// The three attestation guards are individually redundant against a naive
// tamper (any one of them catches it), which is why deleting any one of them
// left the suite green. Each case below defeats every guard EXCEPT the one
// under test.

function attestGates() {
  const kp = generateFixtureKeypair();
  const registry = { keys: { "gate-key": { publicKeyPem: kp.publicKeyPem } } };
  const base = { schemaVersion: "1.0.0", body: { a: 1, b: ["x", null, true] }, attestation: null };

  const signed = clone(base);
  signed.attestation = signRecord(signed, kp.privateKeyPem, "gate-key", "2026-08-01T00:00:00Z");
  check("attest: control record verifies", verifyAttestation(signed, registry).ok === true, "baseline must verify");

  // ATT-PAYLOAD-HASH — the signature is valid over the record as it stands, so
  // signature verification alone would pass; only the payloadHash comparison
  // notices that the ATTESTED hash is not the hash of what was signed.
  const wrongHash = clone(signed);
  wrongHash.attestation.payloadHash = "sha256:" + "0".repeat(64);
  const wrongHashResult = verifyAttestation(wrongHash, registry);
  check(
    "attest gate: a payloadHash that does not match the record is rejected [ATT-PAYLOAD-HASH]",
    wrongHashResult.ok === false && wrongHashResult.code === "ATTESTATION_INVALID",
    JSON.stringify(wrongHashResult)
  );

  // ATT-SIG-VERIFY — the record is edited AND the attested payloadHash is
  // updated to match the edit, so the hash comparison passes. Only the Ed25519
  // verification can still tell that the signature is over the old payload.
  const staleSignature = clone(signed);
  staleSignature.body.a = 999;
  staleSignature.attestation.payloadHash = payloadHashOf(staleSignature);
  const staleResult = verifyAttestation(staleSignature, registry);
  check(
    "attest gate: an updated payloadHash with a stale signature is rejected [ATT-SIG-VERIFY]",
    staleResult.ok === false && staleResult.code === "ATTESTATION_INVALID",
    JSON.stringify(staleResult)
  );

  // ATT-SCOPE — the attestation block is excluded from the payload, so
  // rewriting `scope` changes neither the hash nor the signature. Only the
  // explicit scope check rejects a signature that claims narrower coverage.
  const narrowScope = clone(signed);
  narrowScope.attestation.scope = "body-only";
  const scopeResult = verifyAttestation(narrowScope, registry);
  check(
    "attest gate: a narrowed attestation scope is rejected [ATT-SCOPE]",
    scopeResult.ok === false && scopeResult.code === "ATTESTATION_INVALID",
    JSON.stringify(scopeResult)
  );
}

/* ======================================================================== */
/* evidence.mjs — integrity                                                  */
/* ======================================================================== */

const RUN_ID = "RUN-GATE-1";
const artifactRef = (name) => `runs/${RUN_ID}/artifacts/${name}`;

function evidenceRecord(overrides) {
  return {
    evidenceId: "E-1",
    type: "screenshot",
    artifactRef: artifactRef("ok.txt"),
    contentHash: sha256OfBytes(readFileSync(path.join(GATE_ARTIFACTS, "ok.txt"))),
    byteLength: readFileSync(path.join(GATE_ARTIFACTS, "ok.txt")).length,
    mediaType: "text/plain",
    capturedAt: "2026-08-01T10:05:00Z",
    capture: { captureStep: "CAP-1", attemptId: "AT-1", actionId: "ACT-1", stateId: "ST-1", phase: "after-action" },
    redaction: { status: "not-required", method: null },
    ...overrides,
  };
}

function gateIndex(attemptOverrides = {}) {
  const attempt = {
    attemptId: "AT-1",
    pathId: "P-1",
    attemptNumber: 1,
    retryOfAttemptId: null,
    retryReason: null,
    targetItemIds: ["T-1"],
    timestamps: { startedAt: "2026-08-01T10:00:00Z", endedAt: "2026-08-01T10:10:00Z" },
    actions: [{ actionId: "ACT-1", sequence: 1, occurredAt: "2026-08-01T10:01:00Z" }],
    stateFingerprints: [{ stateId: "ST-1", sequence: 1, capturedAt: "2026-08-01T10:02:00Z" }],
    stop: { reason: "path-complete", detail: "", lastValidStateId: "ST-1" },
    ...attemptOverrides,
  };
  return {
    attempt,
    index: {
      attemptById: new Map([["AT-1", attempt]]),
      actionToAttempt: new Map([["ACT-1", "AT-1"]]),
      stateToAttempt: new Map([["ST-1", "AT-1"]]),
    },
  };
}

function assess(evidence, attemptOverrides) {
  const { index } = gateIndex(attemptOverrides);
  const run = { run: { runId: RUN_ID }, evidence: [evidence] };
  const out = assessArtifacts(run, GATE_ARTIFACTS, index);
  return { verdict: out.status.get(evidence.evidenceId), errors: out.errors };
}

function evidenceIntegrityGates() {
  check(
    "evidence: control artifact is integrity-valid",
    assess(evidenceRecord({})).verdict.valid === true,
    JSON.stringify(assess(evidenceRecord({})))
  );

  // EV-PATH-TRAVERSAL-GUARD — the traversal target EXISTS and its declared
  // hash and length are CORRECT, so every downstream check would pass it. Only
  // the traversal guard stops the scorer reading outside the run's artifact
  // directory. (Audit finding 11: "the path-traversal guard on evidence
  // references" was individually deletable.)
  const outsideBytes = readFileSync(path.join(GATES, "outside.txt"));
  const traversal = assess(
    evidenceRecord({
      artifactRef: artifactRef("../outside.txt"),
      contentHash: sha256OfBytes(outsideBytes),
      byteLength: outsideBytes.length,
    })
  );
  check(
    "evidence gate: '..' in an artifactRef is rejected even when the target resolves [EV-PATH-TRAVERSAL-GUARD]",
    traversal.verdict.valid === false && traversal.verdict.code === "EVIDENCE_CROSS_RUN_REUSE",
    JSON.stringify(traversal)
  );
  const backslash = assess(evidenceRecord({ artifactRef: artifactRef("sub\\ok.txt") }));
  check(
    "evidence gate: a backslash separator in an artifactRef is rejected [EV-PATH-TRAVERSAL-GUARD]",
    backslash.verdict.valid === false && backslash.verdict.code === "EVIDENCE_CROSS_RUN_REUSE",
    JSON.stringify(backslash)
  );
  const absolute = assess(evidenceRecord({ artifactRef: artifactRef("/etc/passwd") }));
  check(
    "evidence gate: an absolute tail in an artifactRef is rejected [EV-PATH-TRAVERSAL-GUARD]",
    absolute.verdict.valid === false && absolute.verdict.code === "EVIDENCE_CROSS_RUN_REUSE",
    JSON.stringify(absolute)
  );

  // EV-CONTENT-HASH — the audit's first missing fixture: an artifact
  // substituted at IDENTICAL length. The cheap byteLength comparison passes;
  // only the content hash notices the swap.
  const substitutedPath = path.join(GATE_ARTIFACTS, "substituted-same-length.txt");
  const onDisk = readFileSync(substitutedPath);
  const decoy = Buffer.from("A".repeat(onDisk.length));
  check(
    "evidence gate fixture: the substituted artifact really is the same length",
    decoy.length === onDisk.length && !decoy.equals(onDisk),
    `disk=${onDisk.length} decoy=${decoy.length}`
  );
  const sameLength = assess(
    evidenceRecord({
      artifactRef: artifactRef("substituted-same-length.txt"),
      contentHash: sha256OfBytes(decoy),
      byteLength: decoy.length,
    })
  );
  check(
    "evidence gate: an artifact substituted at identical length is rejected [EV-CONTENT-HASH]",
    sameLength.verdict.valid === false && sameLength.verdict.code === "EVIDENCE_HASH_MISMATCH",
    JSON.stringify(sameLength)
  );

  // EV-CAPTURE-TIME-WINDOW — the audit's second missing fixture: a FULLY
  // self-consistent lineage (attempt, action and state all exist and all belong
  // to each other) whose capture time falls outside the attempt window.
  const outOfWindow = assess(evidenceRecord({ capturedAt: "2026-08-01T10:30:00Z" }));
  check(
    "evidence gate: a self-consistent lineage captured outside its attempt window is rejected [EV-CAPTURE-TIME-WINDOW]",
    outOfWindow.verdict.valid === false && outOfWindow.verdict.code === "EVIDENCE_LINEAGE_MISMATCH",
    JSON.stringify(outOfWindow)
  );
  const beforeWindow = assess(evidenceRecord({ capturedAt: "2026-08-01T09:00:00Z" }));
  check(
    "evidence gate: a capture BEFORE the attempt window is rejected [EV-CAPTURE-TIME-WINDOW]",
    beforeWindow.verdict.valid === false && beforeWindow.verdict.code === "EVIDENCE_LINEAGE_MISMATCH",
    JSON.stringify(beforeWindow)
  );
  const onBoundary = assess(evidenceRecord({ capturedAt: "2026-08-01T10:10:00Z" }));
  check(
    "evidence gate: the window is INCLUSIVE at its end (boundary fixture)",
    onBoundary.verdict.valid === true,
    JSON.stringify(onBoundary)
  );

  // EV-REDACTION-CONSISTENCY
  const redactedNoMethod = assess(
    evidenceRecord({ redaction: { status: "redacted", method: null } })
  );
  check(
    "evidence gate: a redaction claim without a method is rejected [EV-REDACTION-CONSISTENCY]",
    redactedNoMethod.verdict.valid === false && redactedNoMethod.verdict.code === "EVIDENCE_LINEAGE_MISMATCH",
    JSON.stringify(redactedNoMethod)
  );
}

/* ======================================================================== */
/* evidence.mjs — claim sufficiency                                          */
/* ======================================================================== */

function claimsFor({ result, attemptOverrides, finding }) {
  const { attempt, index: partial } = gateIndex(attemptOverrides);
  const evidence = evidenceRecord({
    evidenceId: "E-BLK",
    type: "blocker-packet",
    artifactRef: artifactRef("blocker.txt"),
    contentHash: sha256OfBytes(readFileSync(path.join(GATE_ARTIFACTS, "blocker.txt"))),
    byteLength: readFileSync(path.join(GATE_ARTIFACTS, "blocker.txt")).length,
  });
  const run = { run: { runId: RUN_ID }, evidence: [evidence], findings: finding ? [finding] : [] };
  const artifacts = assessArtifacts(run, GATE_ARTIFACTS, partial);
  const index = {
    ...partial,
    evidenceById: new Map([[evidence.evidenceId, evidence]]),
    resultByItemId: result ? new Map([[result.itemId, result]]) : new Map(),
  };
  return {
    attempt,
    out: assessClaims({
      run,
      index,
      artifactStatus: artifacts.status,
      itemToOracle: new Map(),
      oracleById: new Map(),
    }),
  };
}

function evidenceSufficiencyGates() {
  const blockedResult = {
    itemId: "T-1",
    coverageStatus: "blocked",
    verdict: "inconclusive",
    attemptRefs: ["AT-1"],
    findingRefs: [],
    evidenceRefs: ["E-BLK"],
  };

  const withState = claimsFor({ result: blockedResult });
  check(
    "claims: control blocked item with a last valid state is sufficient",
    withState.out.itemSufficient.get("T-1") === true,
    JSON.stringify([...withState.out.itemSufficient])
  );

  // EV-BLOCKED-LAST-VALID-STATE — everything else about the claim is perfect:
  // an integrity-valid blocker packet, from an attempt that targeted the item.
  // The ONLY defect is that the attempt recorded no last valid state.
  const noState = claimsFor({
    result: blockedResult,
    attemptOverrides: { stop: { reason: "blocked", detail: "", lastValidStateId: null } },
  });
  check(
    "claims gate: a blocked item whose attempt recorded no last valid state gets no credit [EV-BLOCKED-LAST-VALID-STATE]",
    noState.out.itemSufficient.get("T-1") === false,
    JSON.stringify([...noState.out.itemSufficient])
  );

  // EV-CLAIM-RELEVANCE — an integrity-valid artifact captured in a resolved
  // attempt, but that attempt was never trying to exercise this item.
  const irrelevant = claimsFor({
    result: { ...blockedResult, coverageStatus: "exercised", evidenceRefs: ["E-BLK"] },
    attemptOverrides: { targetItemIds: ["T-OTHER"] },
  });
  check(
    "claims gate: an exercised item witnessed only by an attempt that never targeted it gets no credit [EV-CLAIM-RELEVANCE]",
    irrelevant.out.itemSufficient.get("T-1") === false,
    JSON.stringify([...irrelevant.out.itemSufficient])
  );
  const relevant = claimsFor({
    result: { ...blockedResult, coverageStatus: "exercised", evidenceRefs: ["E-BLK"] },
  });
  check(
    "claims: control exercised item witnessed by a targeting attempt IS credited",
    relevant.out.itemSufficient.get("T-1") === true,
    JSON.stringify([...relevant.out.itemSufficient])
  );

  // EV-BLOCKER-FINDING-LAST-VALID-STATE — the same rule on the finding side.
  const blockerFinding = {
    findingId: "F-BLK",
    kind: "blocker",
    expected: "the survey should advance past Q4",
    observed: "the Next control never enabled",
    itemRefs: ["T-1"],
    attemptRefs: ["AT-1"],
    evidenceRefs: ["E-BLK"],
  };
  const findingWithState = claimsFor({ finding: blockerFinding });
  check(
    "claims: control blocker finding with a last valid state is sufficient",
    findingWithState.out.findingSufficient.get("F-BLK") === true,
    JSON.stringify([...findingWithState.out.findingSufficient])
  );
  const findingNoState = claimsFor({
    finding: blockerFinding,
    attemptOverrides: { stop: { reason: "blocked", detail: "", lastValidStateId: null } },
  });
  check(
    "claims gate: a blocker FINDING without a last valid state gets no credit [EV-BLOCKER-FINDING-LAST-VALID-STATE]",
    findingNoState.out.findingSufficient.get("F-BLK") === false,
    JSON.stringify([...findingNoState.out.findingSufficient])
  );
}

/* ======================================================================== */
/* integrity.mjs                                                             */
/* ======================================================================== */

function baseRun() {
  const contract = {
    items: [
      {
        itemId: "T-1",
        type: "question",
        sourceAnchor: { locator: "Q1", quote: "Q1. Age?", aliases: [] },
        requirement: "Q1 age question is shown",
        variants: [],
      },
    ],
    extraction: { method: "llm", extractorVersion: "gate/1", modelCallRefs: ["MC-1"], extractedAt: "2026-08-01T10:00:10Z" },
  };
  const run = {
    run: {
      runId: RUN_ID,
      target: { url: "https://t/", environment: "fixture", buildId: "BUILD-1", buildHash: "sha256:" + "1".repeat(64) },
      documentHash: "sha256:" + "2".repeat(64),
      contractHash: jcsHash(contract),
      timestamps: {
        createdAt: "2026-08-01T09:59:00Z",
        startedAt: "2026-08-01T10:00:00Z",
        endedAt: "2026-08-01T11:00:00Z",
      },
    },
    contract,
    attempts: [
      {
        attemptId: "AT-1",
        pathId: "P-1",
        attemptNumber: 1,
        retryOfAttemptId: null,
        retryReason: null,
        targetItemIds: ["T-1"],
        timestamps: { startedAt: "2026-08-01T10:00:00Z", endedAt: "2026-08-01T10:10:00Z" },
        actions: [
          {
            actionId: "ACT-1",
            sequence: 1,
            occurredAt: "2026-08-01T10:01:00Z",
            operation: "click",
            target: "Next",
            parameters: {},
            beforeStateId: null,
            afterStateId: "ST-1",
          },
        ],
        stateFingerprints: [{ stateId: "ST-1", sequence: 1, capturedAt: "2026-08-01T10:02:00Z" }],
        stop: { reason: "path-complete", detail: "", lastValidStateId: "ST-1" },
      },
      {
        attemptId: "AT-2",
        pathId: "P-2",
        attemptNumber: 1,
        retryOfAttemptId: null,
        retryReason: null,
        targetItemIds: ["T-1"],
        timestamps: { startedAt: "2026-08-01T10:20:00Z", endedAt: "2026-08-01T10:30:00Z" },
        actions: [],
        stateFingerprints: [{ stateId: "ST-2", sequence: 1, capturedAt: "2026-08-01T10:21:00Z" }],
        stop: { reason: "path-complete", detail: "", lastValidStateId: "ST-2" },
      },
    ],
    evidence: [],
    findings: [],
    itemResults: [
      { itemId: "T-1", coverageStatus: "exercised", verdict: "pass", attemptRefs: ["AT-1"], findingRefs: [], evidenceRefs: [] },
    ],
    resources: { modelCalls: [{ callId: "MC-1" }] },
  };
  return run;
}

function integrityGates() {
  const control = checkRunIntegrity(baseRun());
  check(
    "integrity: control run is clean",
    control.hard.length === 0 && control.soft.length === 0,
    JSON.stringify({ hard: control.hard, soft: control.soft })
  );

  // INT-CONTRACT-HASH-BINDING — audit finding 11: "the binding between the
  // agent's checklist and its signed hash" was individually deletable.
  const rebound = baseRun();
  rebound.contract.items[0].requirement = "Q1 asks something entirely different";
  const reboundOut = checkRunIntegrity(rebound);
  check(
    "integrity gate: a contract edited after signing no longer matches contractHash [INT-CONTRACT-HASH-BINDING]",
    codes(reboundOut.hard).has("CONTRACT_HASH_MISMATCH"),
    JSON.stringify(reboundOut.hard)
  );

  // INT-ACTION-IN-ATTEMPT-WINDOW — the action time is inside the RUN window and
  // monotonic, so only the attempt-window rule can catch it.
  const lateAction = baseRun();
  lateAction.attempts[0].actions[0].occurredAt = "2026-08-01T10:15:00Z";
  lateAction.run.contractHash = jcsHash(lateAction.contract);
  const lateOut = checkRunIntegrity(lateAction);
  check(
    "integrity gate: an action outside its attempt window is rejected [INT-ACTION-IN-ATTEMPT-WINDOW]",
    codes(lateOut.hard).has("INTEGRITY_CHRONOLOGY_INVALID") &&
      lateOut.hard.some((e) => e.message.includes("outside attempt window")),
    JSON.stringify(lateOut.hard)
  );

  // INT-STATE-IN-ATTEMPT-WINDOW
  const lateState = baseRun();
  lateState.attempts[0].stateFingerprints[0].capturedAt = "2026-08-01T10:45:00Z";
  const lateStateOut = checkRunIntegrity(lateState);
  check(
    "integrity gate: a state fingerprint outside its attempt window is rejected [INT-STATE-IN-ATTEMPT-WINDOW]",
    lateStateOut.hard.some((e) => e.message.includes("outside attempt window") && e.message.includes("ST-1")),
    JSON.stringify(lateStateOut.hard)
  );

  // INT-RUN-CHRONOLOGY-AND-OR — created AFTER started, but started <= ended, so
  // only the conjunction (not either disjunct) rejects it.
  const badChrono = baseRun();
  badChrono.run.timestamps.createdAt = "2026-08-01T10:05:00Z";
  const badChronoOut = checkRunIntegrity(badChrono);
  check(
    "integrity gate: a run created after it started is rejected [INT-RUN-CHRONOLOGY-AND-OR]",
    badChronoOut.hard.some((e) => e.code === "INTEGRITY_CHRONOLOGY_INVALID" && e.message.includes("created<=started")),
    JSON.stringify(badChronoOut.hard)
  );

  // INT-DUP-CONTRACT-ITEM
  const dup = baseRun();
  dup.contract.items.push({ ...clone(dup.contract.items[0]) });
  dup.run.contractHash = jcsHash(dup.contract);
  dup.itemResults.push({ ...clone(dup.itemResults[0]) });
  const dupOut = checkRunIntegrity(dup);
  check(
    "integrity gate: duplicate contract itemIds are rejected [INT-DUP-CONTRACT-ITEM]",
    dupOut.hard.some((e) => e.code === "INTEGRITY_ID_COLLISION" && e.message.includes("contract itemId")),
    JSON.stringify(dupOut.hard)
  );

  // INT-LAST-VALID-STATE-OWNERSHIP — the cited state EXISTS, it just belongs to
  // a different attempt.
  const stolenState = baseRun();
  stolenState.attempts[0].stop.lastValidStateId = "ST-2";
  const stolenOut = checkRunIntegrity(stolenState);
  check(
    "integrity gate: a lastValidStateId belonging to another attempt is rejected [INT-LAST-VALID-STATE-OWNERSHIP]",
    stolenOut.hard.some((e) => e.message.includes("stop.lastValidStateId is not one of its states")),
    JSON.stringify(stolenOut.hard)
  );

  // INT-ACTION-STATE-XREF
  const crossState = baseRun();
  crossState.attempts[0].actions[0].afterStateId = "ST-2";
  const crossOut = checkRunIntegrity(crossState);
  check(
    "integrity gate: an action referencing another attempt's state is rejected [INT-ACTION-STATE-XREF]",
    crossOut.hard.some((e) => e.code === "INTEGRITY_LINEAGE_INVALID" && e.message.includes("outside its attempt")),
    JSON.stringify(crossOut.hard)
  );

  // INT-IDENTITY-BUILD-HASH
  const oracle = {
    oracleRecordId: "OREC-1",
    survey: {
      surveyId: "s-gate",
      variant: { variantId: "VAR-1", kind: "flawed" },
      document: { contentHash: "sha256:" + "2".repeat(64) },
      targetBuild: { buildId: "BUILD-1", contentHash: "sha256:" + "1".repeat(64) },
    },
    obligations: [],
    witnessPaths: [],
    seededDefects: [],
  };
  check(
    "identity: control run and oracle agree",
    checkIdentity(baseRun(), oracle).length === 0,
    JSON.stringify(checkIdentity(baseRun(), oracle))
  );
  const otherBuild = clone(oracle);
  otherBuild.survey.targetBuild.contentHash = "sha256:" + "9".repeat(64);
  check(
    "identity gate: a run scored against a different BUILD HASH is rejected [INT-IDENTITY-BUILD-HASH]",
    checkIdentity(baseRun(), otherBuild).some((e) => e.code === "RUN_IDENTITY_MISMATCH" && e.message.includes("buildHash")),
    JSON.stringify(checkIdentity(baseRun(), otherBuild))
  );

  // INT-ORACLE-ID-IN-URL — audit finding 11: "detection of hidden identifiers
  // inside URLs (the code comment specifically promises this case, and no
  // fixture tests it)". The identifier is embedded in a path, with no
  // whitespace around it.
  const isolationOracle = clone(oracle);
  isolationOracle.obligations = [
    { oracleId: "ORC-SECRET-7", reachability: { status: "reachable", witnessPathIds: ["p001"] } },
  ];
  isolationOracle.witnessPaths = [{ witnessPathId: "p001" }];
  const cleanRun = baseRun();
  check(
    "isolation: control run leaks no oracle identifier",
    checkOracleAccess(JSON.stringify(cleanRun), cleanRun, isolationOracle).length === 0,
    "control must be clean"
  );
  const urlLeak = baseRun();
  urlLeak.attempts[0].actions[0].target = "https://cdn.example.test/assets/ORC-SECRET-7/thumb.png";
  const urlLeakErrors = checkOracleAccess(JSON.stringify(urlLeak), urlLeak, isolationOracle);
  check(
    "isolation gate: an oracle identifier embedded inside a URL path is detected [INT-ORACLE-ID-IN-URL]",
    urlLeakErrors.some((e) => e.code === "ORACLE_ACCESS_VIOLATION" && e.message.includes("ORC-SECRET-7")),
    JSON.stringify(urlLeakErrors)
  );
  const notALeak = baseRun();
  notALeak.attempts[0].actions[0].target = "https://cdn.example.test/assets/ORC-SECRET-77/thumb.png";
  check(
    "isolation boundary: a LONGER identifier that merely contains the secret is not a leak",
    checkOracleAccess(JSON.stringify(notALeak), notALeak, isolationOracle).length === 0,
    JSON.stringify(checkOracleAccess(JSON.stringify(notALeak), notALeak, isolationOracle))
  );

  // INT-ORACLE-PATH-RE
  const pathLeak = baseRun();
  pathLeak.attempts[0].actions[0].target = "/private/oracle/index.json";
  const pathLeakErrors = checkOracleAccess(JSON.stringify(pathLeak), pathLeak, isolationOracle);
  check(
    "isolation gate: an action targeting a private oracle path is rejected [INT-ORACLE-PATH-RE]",
    pathLeakErrors.some((e) => e.message.includes("private oracle path")),
    JSON.stringify(pathLeakErrors)
  );
  const recordLeak = baseRun();
  recordLeak.attempts[0].actions[0].parameters = { href: "/data/oracle-record.json" };
  check(
    "isolation gate: an action fetching an oracle-record file is rejected [INT-ORACLE-PATH-RE]",
    checkOracleAccess(JSON.stringify(recordLeak), recordLeak, isolationOracle).some((e) =>
      e.message.includes("private oracle path")
    ),
    "oracle-record vocabulary must stay in the path pattern"
  );

  // INT-ORACLE-UNREACHABLE-WITNESS
  const contradictory = {
    obligations: [{ oracleId: "ORC-1", reachability: { status: "unreachable", witnessPathIds: ["p001"] } }],
    witnessPaths: [{ witnessPathId: "p001" }],
    seededDefects: [],
  };
  check(
    "oracle gate: an UNREACHABLE obligation carrying witness paths is rejected [INT-ORACLE-UNREACHABLE-WITNESS]",
    checkOracleIntegrity(contradictory).some((e) => e.message.includes("unreachable obligation")),
    JSON.stringify(checkOracleIntegrity(contradictory))
  );
}

/* ======================================================================== */
/* resources.mjs                                                             */
/* ======================================================================== */

// One model call, hand-priced: 1e6 input + 1e5 cached + 1e4 output on the
// overseer table = 3.0 + 0.03 + 0.15 = 3.18 USD.
function baseResourceRun() {
  return {
    run: { timestamps: { startedAt: "2026-08-01T10:00:00Z", endedAt: "2026-08-01T10:30:00Z" } },
    attempts: [
      {
        attemptId: "AT-1",
        targetItemIds: ["T-1"],
        timestamps: { startedAt: "2026-08-01T10:00:00Z", endedAt: "2026-08-01T10:10:00Z" },
        actions: [{ actionId: "ACT-1" }, { actionId: "ACT-2" }],
        retryOfAttemptId: null,
      },
    ],
    resources: {
      modelCalls: [
        {
          callId: "MC-1",
          model: "fixture-ai/overseer",
          inputTokens: 1000000,
          cachedInputTokens: 100000,
          outputTokens: 10000,
          costUsd: 3.18,
        },
      ],
      totals: {
        modelCalls: 1,
        toolCalls: 2,
        retryCount: 0,
        escalationCount: 0,
        inputTokens: 1000000,
        cachedInputTokens: 100000,
        outputTokens: 10000,
        browserMilliseconds: 600000,
        wallClockMilliseconds: 1800000,
        modelCostUsd: 3.18,
        browserCostUsd: 0.5,
        otherCostUsd: 0.32,
        totalCostUsd: 4,
        currency: "USD",
        pricingVersion: "fixture-pricing/2026-08-01",
      },
      limits: {
        maxCostUsd: 30,
        maxWallClockMilliseconds: 3600000,
        maxModelCalls: 200,
        maxToolCalls: 500,
        maxStepsPerAttempt: 40,
        maxAttemptsPerItem: 2,
        verificationReserveUsd: 4.5,
        reportReserveUsd: 3,
      },
    },
  };
}

function resourceGates() {
  const control = reconcileResources(baseResourceRun());
  check(
    "resources: control run reconciles cleanly",
    control.errors.length === 0 && control.warnings.length === 0 && control.costKnown && control.limitsOk,
    JSON.stringify({ errors: control.errors, warnings: control.warnings })
  );

  // RES-PER-CALL-PRICING — audit finding 11: the "falsified cost" fixture
  // reaches its error through the TOTALS, so the per-call reconciliation was
  // free to delete. Here the totals are INTERNALLY CONSISTENT with the claimed
  // per-call figure; only the pinned pricing table disagrees.
  const misPriced = baseResourceRun();
  misPriced.resources.modelCalls[0].costUsd = 1.0;
  misPriced.resources.totals.modelCostUsd = 1.0;
  misPriced.resources.totals.totalCostUsd = 1.82;
  const misPricedOut = reconcileResources(misPriced);
  check(
    "resources gate: a per-call cost that disagrees with the pinned pricing table is caught [RES-PER-CALL-PRICING]",
    misPricedOut.errors.some((e) => e.code === "RESOURCE_MISMATCH" && e.message.includes("pinned-pricing recomputation")),
    JSON.stringify(misPricedOut.errors)
  );

  const capCases = [
    ["RES-CAP-RESERVES", (r) => (r.resources.limits.verificationReserveUsd = 40), "reserves exceed maxCostUsd"],
    ["RES-CAP-TOTAL-COST", (r) => (r.resources.limits.maxCostUsd = 1), "exceeds maxCostUsd"],
    ["RES-CAP-WALL-CLOCK", (r) => (r.resources.limits.maxWallClockMilliseconds = 1000), "wall clock exceeds"],
    ["RES-CAP-MODEL-CALLS", (r) => (r.resources.limits.maxModelCalls = 0), "model calls exceed"],
    ["RES-CAP-TOOL-CALLS", (r) => (r.resources.limits.maxToolCalls = 1), "tool calls exceed"],
    ["RES-CAP-STEPS-PER-ATTEMPT", (r) => (r.resources.limits.maxStepsPerAttempt = 1), "exceeding maxStepsPerAttempt"],
    ["RES-CAP-ATTEMPTS-PER-ITEM", (r) => (r.resources.limits.maxAttemptsPerItem = 0), "exceeding maxAttemptsPerItem"],
  ];
  for (const [mutantId, breakIt, needle] of capCases) {
    const r = baseResourceRun();
    breakIt(r);
    const out = reconcileResources(r);
    check(
      `resources gate: ${needle} is a RESOURCE_LIMIT_EXCEEDED [${mutantId}]`,
      out.limitsOk === false &&
        out.errors.some((e) => e.code === "RESOURCE_LIMIT_EXCEEDED" && e.message.includes(needle)),
      JSON.stringify(out.errors)
    );
  }

  // RES-TOTAL-COST-COMPOSITION
  const badTotal = baseResourceRun();
  badTotal.resources.totals.totalCostUsd = 3.0;
  check(
    "resources gate: totalCostUsd that is not the sum of its components is caught [RES-TOTAL-COST-COMPOSITION]",
    reconcileResources(badTotal).errors.some((e) => e.message.includes("modelCost+browserCost+otherCost")),
    JSON.stringify(reconcileResources(badTotal).errors)
  );

  // RES-PRICING-VERSION-PIN
  const otherPricing = baseResourceRun();
  otherPricing.resources.totals.pricingVersion = "vendor-pricing/2030-01-01";
  const otherPricingOut = reconcileResources(otherPricing);
  check(
    "resources gate: an unpinned pricingVersion makes cost UNKNOWN [RES-PRICING-VERSION-PIN]",
    otherPricingOut.costKnown === false &&
      otherPricingOut.warnings.some((w) => w.code === "PRICING_UNKNOWN"),
    JSON.stringify(otherPricingOut)
  );

  // RES-BROWSER-MS-RECONCILIATION
  const badBrowser = baseResourceRun();
  badBrowser.resources.totals.browserMilliseconds = 1;
  check(
    "resources gate: browserMilliseconds that does not match attested attempt time is caught [RES-BROWSER-MS-RECONCILIATION]",
    reconcileResources(badBrowser).errors.some((e) => e.message.includes("attested attempt time")),
    JSON.stringify(reconcileResources(badBrowser).errors)
  );

  // RES-CACHED-TOKEN-RATE (already covered by the pricing arithmetic, asserted
  // here as a direct behavioural statement).
  const allCached = baseResourceRun();
  allCached.resources.modelCalls[0].inputTokens = 0;
  allCached.resources.modelCalls[0].cachedInputTokens = 1000000;
  allCached.resources.modelCalls[0].outputTokens = 0;
  allCached.resources.modelCalls[0].costUsd = 0.3;
  allCached.resources.totals.inputTokens = 0;
  allCached.resources.totals.cachedInputTokens = 1000000;
  allCached.resources.totals.outputTokens = 0;
  allCached.resources.totals.modelCostUsd = 0.3;
  allCached.resources.totals.totalCostUsd = 1.12;
  check(
    "resources gate: 1M cached tokens cost the CACHED rate, not the fresh rate [RES-CACHED-TOKEN-RATE]",
    reconcileResources(allCached).errors.length === 0,
    JSON.stringify(reconcileResources(allCached).errors)
  );
}

/* ======================================================================== */
/* metrics.mjs — the completion clauses the audit called dead                 */
/* ======================================================================== */

function metricsScaffold({ extraResults = [], ambiguous = [], itemSufficientExtra = [] } = {}) {
  const oracle = {
    obligations: [
      {
        oracleId: "ORC-1",
        type: "question",
        reachability: { status: "reachable", witnessPathIds: ["p001"] },
      },
    ],
    seededDefects: [],
  };
  const results = [
    { itemId: "T-1", coverageStatus: "exercised", verdict: "pass", attemptRefs: [], findingRefs: [], evidenceRefs: [] },
    ...extraResults,
  ];
  const run = {
    contract: { items: results.map((r) => ({ itemId: r.itemId })) },
    resources: { totals: { totalCostUsd: 1 } },
  };
  return computeMetricsAndCompleteness({
    run,
    oracle,
    index: {
      resultByItemId: new Map(results.map((r) => [r.itemId, r])),
      missingResultItemIds: [],
    },
    matching: { matches: [{ itemId: "T-1", oracleId: "ORC-1", score: 1 }], ambiguous },
    defects: { truePositives: [], precisionDenominator: 0, assertedCount: 0, redundant: [] },
    claims: {
      itemSufficient: new Map([["T-1", true], ...itemSufficientExtra]),
      requiredClaims: 1,
      sufficientClaims: 1,
    },
    resources: { costKnown: true },
  });
}

function metricsGates() {
  const control = metricsScaffold();
  check(
    "metrics: control run is testComplete",
    control.completeness.testComplete === true,
    JSON.stringify(control.completeness)
  );

  // MET-AMBIGUOUS-CLAUSE
  const withAmbiguity = metricsScaffold({ ambiguous: [{ itemId: "T-1" }] });
  check(
    "metrics gate: an unadjudicated ambiguous match blocks testComplete [MET-AMBIGUOUS-CLAUSE]",
    withAmbiguity.completeness.testComplete === false,
    JSON.stringify(withAmbiguity.completeness)
  );

  // MET-PARTIAL-STATUS-CLAUSE — every oracle obligation is still exercised and
  // verified, and every contract item still has a result, so ONLY the partial
  // status can block completeness.
  const withBlocked = metricsScaffold({
    extraResults: [
      { itemId: "T-2", coverageStatus: "blocked", verdict: "inconclusive", attemptRefs: [], findingRefs: [], evidenceRefs: [] },
    ],
    itemSufficientExtra: [["T-2", true]],
  });
  check(
    "metrics gate: a blocked item blocks testComplete even when the oracle is fully covered [MET-PARTIAL-STATUS-CLAUSE]",
    withBlocked.completeness.testComplete === false &&
      withBlocked.completeness.reportComplete === true &&
      withBlocked.completeness.unaccountedOracleIds.length === 0,
    JSON.stringify(withBlocked.completeness)
  );

  // MET-UNREACHABLE-CLAIMS-OK-CLAUSE — one of the audit's "two dead clauses".
  // The unsupported proven-unreachable claim is on an item matched to NO
  // obligation, so the oracle denominator is untouched and only this clause
  // can fail.
  const badUnreachableClaim = metricsScaffold({
    extraResults: [
      {
        itemId: "T-3",
        coverageStatus: "proven-unreachable",
        verdict: "inconclusive",
        attemptRefs: [],
        findingRefs: [],
        evidenceRefs: [],
      },
    ],
    itemSufficientExtra: [["T-3", false]],
  });
  check(
    "metrics gate: an unsupported proven-unreachable claim blocks testComplete [MET-UNREACHABLE-CLAIMS-OK-CLAUSE]",
    badUnreachableClaim.completeness.testComplete === false &&
      badUnreachableClaim.completeness.reportComplete === true &&
      badUnreachableClaim.completeness.unaccountedOracleIds.length === 0,
    JSON.stringify(badUnreachableClaim.completeness)
  );
  const goodUnreachableClaim = metricsScaffold({
    extraResults: [
      {
        itemId: "T-3",
        coverageStatus: "proven-unreachable",
        verdict: "inconclusive",
        attemptRefs: [],
        findingRefs: [],
        evidenceRefs: [],
      },
    ],
    itemSufficientExtra: [["T-3", true]],
  });
  check(
    "metrics: control — a SUPPORTED proven-unreachable claim leaves testComplete true",
    goodUnreachableClaim.completeness.testComplete === true,
    JSON.stringify(goodUnreachableClaim.completeness)
  );
}

/* ======================================================================== */
/* matcher.mjs                                                               */
/* ======================================================================== */

function matcherGates() {
  const anchor = { locator: "Q5", quote: "Q5. Which of these have you used?", aliases: [] };
  const requirement = "Q5 offers the full brand list with a none-of-these exclusive option";

  // MAT-TYPE-GATE — identical anchor and identical requirement, different type.
  // Only the type gate stops a perfect textual match being credited.
  const branchObligation = { oracleId: "ORC-BR", type: "branch", sourceAnchor: anchor, requirement };
  const questionItem = { itemId: "T-Q", type: "question", sourceAnchor: anchor, requirement };
  const crossType = matchObligations([questionItem], [branchObligation]);
  check(
    "matcher gate: a question item cannot match a branch obligation, however identical the text [MAT-TYPE-GATE]",
    crossType.matches.length === 0 && crossType.unmatchedOracleIds.includes("ORC-BR"),
    JSON.stringify(crossType.matches)
  );
  const sameType = matchObligations([questionItem], [{ ...branchObligation, type: "question" }]);
  check(
    "matcher: control — the same pair with matching types IS credited",
    sameType.matches.length === 1,
    JSON.stringify(sameType.matches)
  );

  // MAT-JACCARD-EMPTY-AND-OR — an empty string must not be similar to
  // everything. (With `||` in the empty-set shortcut, an item with no
  // requirement text scores a perfect token overlap against every obligation.)
  check(
    "matcher gate: empty text is NOT similar to non-empty text [MAT-JACCARD-EMPTY-AND-OR]",
    stringSim("", "alpha beta gamma") === 0,
    `got ${stringSim("", "alpha beta gamma")}`
  );
  check(
    "matcher: control — empty vs empty is exact",
    stringSim("", "") === 1,
    `got ${stringSim("", "")}`
  );

  // MAT-INELIGIBLE-EDGE-DROPPED — a sub-threshold pair must be NO EDGE AT ALL,
  // not a low-weight edge. The distinction only shows up when the weak edge is
  // relatively stronger for the losing item than the strong edge is: the
  // maximum-weight solver then prefers the (weak + strong) pairing to the
  // (strong + weak) one, and after the eligibility filter the WRONG item ends
  // up holding the obligation.
  //
  // Constructed so that, with candidate scores a=I0/O0, b=I0/O1, c=I1/O0,
  // d=I1/O1:  a > c >= 0.55 > b, d   and   b + c > a + d.
  const tok = (p, n) => [...Array(n)].map((_, i) => p + String(i + 1).padStart(3, "0"));
  const R0 = tok("t", 60);
  const R1 = tok("u", 60);
  const V = tok("v", 60);
  const i0Req = R0.slice();
  for (let k = 0; k < 12; k++) i0Req[k * 5] = R1[k];
  const i1Req = R0.slice();
  for (let k = 0; k < 15; k++) i1Req[k * 4] = V[k];
  const anchorB = { locator: "Q40", quote: "Q40. In which year did you start using it?", aliases: [] };
  const O0 = { oracleId: "ORC-MAIN", type: "question", sourceAnchor: anchor, requirement: R0.join(" ") };
  const O1 = { oracleId: "ORC-DECOY", type: "question", sourceAnchor: anchorB, requirement: R1.join(" ") };
  const I0 = { itemId: "T-BEST", type: "question", sourceAnchor: anchor, requirement: i0Req.join(" ") };
  const I1 = { itemId: "T-RUNNER-UP", type: "question", sourceAnchor: anchor, requirement: i1Req.join(" ") };

  const a = scorePair(I0, O0);
  const b = scorePair(I0, O1);
  const c = scorePair(I1, O0);
  const d = scorePair(I1, O1);
  const T = 0.55;
  check(
    "matcher gate fixture: the score matrix really has the displacing shape",
    a > c && c >= T && b < T && d < T && b + c > a + d,
    `a=${a.toFixed(4)} b=${b.toFixed(4)} c=${c.toFixed(4)} d=${d.toFixed(4)}`
  );
  const withDecoy = matchObligations([I0, I1], [O0, O1]);
  check(
    "matcher gate: a sub-threshold candidate cannot displace the best eligible pairing [MAT-INELIGIBLE-EDGE-DROPPED]",
    withDecoy.matches.length === 1 &&
      withDecoy.matches[0].itemId === "T-BEST" &&
      withDecoy.matches[0].oracleId === "ORC-MAIN",
    JSON.stringify(withDecoy.matches)
  );
}

/* ======================================================================== */
/* defect-match.mjs                                                          */
/* ======================================================================== */

const DEF_OBLIGATION = "ORC-DEF";
const DEF_ITEM = "T-DEF";

function runDefectMatch({ findings, seededDefects, cleanTarget = false, itemToOracle }) {
  return matchDefects({
    findings,
    seededDefects,
    itemToOracle: itemToOracle ?? new Map([[DEF_ITEM, DEF_OBLIGATION]]),
    findingSufficient: new Map(findings.map((f) => [f.findingId, true])),
    cleanTarget,
  });
}

function defectMatchGates() {
  const text = "alpha beta gamma delta epsilon zeta";
  const finding = {
    findingId: "F-1",
    kind: "defect",
    expected: text,
    observed: text,
    itemRefs: [DEF_ITEM],
  };
  const seeded = [
    {
      defectId: "D-1",
      affectedObligationIds: [DEF_OBLIGATION],
      expected: { requirement: text },
      observed: { requirement: text },
    },
  ];

  const control = runDefectMatch({ findings: [finding], seededDefects: seeded });
  check(
    "defect-match: control — a perfect finding on a flawed target is a true positive",
    control.truePositives.length === 1 && control.falsePositives.length === 0,
    JSON.stringify(control)
  );

  // DEF-CLEAN-TARGET — the same perfect finding, against a CLEAN target that
  // nonetheless carries a seeded-defect list (so the seededDefects.length === 0
  // fallback cannot cover for the missing clause). Reporting a bug on a build
  // known to be good is a false positive, whatever the text says.
  const onClean = runDefectMatch({ findings: [finding], seededDefects: seeded, cleanTarget: true });
  check(
    "defect gate: an asserted defect on a CLEAN target is a false positive [DEF-CLEAN-TARGET]",
    onClean.truePositives.length === 0 &&
      onClean.falsePositives.length === 1 &&
      onClean.precisionDenominator === 1,
    JSON.stringify(onClean)
  );

  // DEF-ITEM-MAPPING-CONDITION — textually perfect, but the item it is attached
  // to maps to an obligation the defect does not affect. Condition 1 of §6.
  const wrongItem = runDefectMatch({
    findings: [finding],
    seededDefects: seeded,
    itemToOracle: new Map([[DEF_ITEM, "ORC-SOMETHING-ELSE"]]),
  });
  check(
    "defect gate: a perfect-text finding attached to an unaffected obligation is a false positive [DEF-ITEM-MAPPING-CONDITION]",
    wrongItem.truePositives.length === 0 && wrongItem.falsePositives.length === 1,
    JSON.stringify(wrongItem)
  );

  // DEF-REDUNDANT-NEEDS-CREDITED-TP — the "redundant" escape hatch removes a
  // finding from the precision denominator, so it must only apply when the
  // defect it restates was ACTUALLY credited. Here two findings are ambiguous
  // between two near-identical defects, so NEITHER defect is credited; a third
  // finding that scores above the threshold against one of them must be a
  // FALSE POSITIVE, not a free "duplicate".
  const tk = (n) => [...Array(n)].map((_, i) => "tok" + String(i + 1).padStart(3, "0"));
  const baseText = tk(60).join(" ");
  const twinText = (() => {
    const t = tk(60);
    t[30] = "zzz060";
    return t.join(" ");
  })();
  const partialText = tk(60).slice(0, 30).concat(["q1"]).join(" ");
  const mkF = (id, s) => ({ findingId: id, kind: "defect", expected: s, observed: s, itemRefs: [DEF_ITEM] });
  const mkD = (id, s) => ({
    defectId: id,
    affectedObligationIds: [DEF_OBLIGATION],
    expected: { requirement: s },
    observed: { requirement: s },
  });
  const uncredited = runDefectMatch({
    findings: [mkF("F-1", baseText), mkF("F-2", twinText), mkF("F-3", partialText)],
    seededDefects: [mkD("D-1", baseText), mkD("D-2", twinText)],
  });
  check(
    "defect gate fixture: the two near-identical defects are ambiguous, so neither is credited",
    uncredited.truePositives.length === 0 && uncredited.ambiguous.length === 2,
    JSON.stringify({ tp: uncredited.truePositives, amb: uncredited.ambiguous.map((x) => x.findingId) })
  );
  check(
    "defect gate: a finding restating an UNCREDITED defect is a false positive, not redundant [DEF-REDUNDANT-NEEDS-CREDITED-TP]",
    uncredited.falsePositives.includes("F-3") &&
      uncredited.redundant.length === 0 &&
      uncredited.precisionDenominator === 3,
    JSON.stringify({ fp: uncredited.falsePositives, redundant: uncredited.redundant, denom: uncredited.precisionDenominator })
  );

  // Control for the same line: when the defect IS credited, a second valid
  // finding for it stays REDUNDANT and leaves the precision denominator.
  const credited = runDefectMatch({
    findings: [mkF("F-1", baseText), mkF("F-2", partialText)],
    seededDefects: [mkD("D-1", baseText)],
  });
  check(
    "defect-match: control — a duplicate of a CREDITED defect is redundant, not a false positive",
    credited.truePositives.length === 1 &&
      credited.redundant.length === 1 &&
      credited.falsePositives.length === 0 &&
      credited.precisionDenominator === 1,
    JSON.stringify(credited)
  );
}

/* ======================================================================== */
/* oracle/lib — ground-truth pipeline gates                                  */
/* ======================================================================== */

// A tiny synthetic manifest that exercises, in one place: an unconditional rule
// followed by a dead rule, a one-sided numeric range, a forward (unresolvable)
// piping token, an unreachable question, and a first-match-wins rule order.
function synthManifest() {
  return {
    schema: "branching-survey/v1",
    id: "syn",
    variant: "clean",
    title: "Synthetic gate survey",
    intro: "Intro.",
    seed: 7,
    questions: [
      {
        id: "Q1",
        section: "A",
        type: "radio",
        text: "Pick one",
        options: [
          { code: 1, label: "Yes" },
          { code: 2, label: "No" },
        ],
        rules: [
          { if: { q: "Q1", op: "eq", value: 2 }, terminate: "SCREENOUT", reason: "not qualified" },
          { if: { op: "always" }, goto: "Q3" },
          { if: { q: "Q1", op: "eq", value: 1 }, goto: "Q2" },
        ],
      },
      { id: "Q2", type: "number", text: "How many?", min: 0 },
      { id: "Q3", type: "text", text: "Tell us about {Q4} please" },
      { id: "Q4", type: "text", text: "Anything else?" },
    ],
  };
}

function derive(manifest, variant = "clean") {
  return deriveOracle(manifest, {
    surveyId: "syn",
    variant,
    manifestPath: `derived:${variant}`,
    manifestSha256: sha256OfString(JSON.stringify(manifest)),
  });
}

function oracleDerivationGates() {
  const set = derive(synthManifest());
  const ids = new Set(set.obligations.map((o) => o.localId));
  const byLocalId = new Map(set.obligations.map((o) => [o.localId, o]));

  check(
    "derive: control — the synthetic manifest derives without problems",
    set.problems.length === 0,
    JSON.stringify(set.problems)
  );

  // DER-UNCONDITIONAL-RULE-CUTOFF: rule 3 sits after an unconditional rule, so
  // it can never fire and must carry no obligation.
  check(
    "derive gate: rules after an unconditional rule emit no branch obligation [DER-UNCONDITIONAL-RULE-CUTOFF]",
    ids.has("branch:Q1:goto:Q3:taken") && !ids.has("branch:Q1:goto:Q2:taken"),
    [...ids].join(", ")
  );
  // DER-DEFAULT-EDGE-CONDITION: an unconditional rule always fires, so there is
  // no default-continue edge.
  check(
    "derive gate: no default-continue edge after an unconditional rule [DER-DEFAULT-EDGE-CONDITION]",
    !ids.has("branch:Q1:default"),
    [...ids].join(", ")
  );
  // DER-RANGE-AND-OR: Q2 declares only a minimum.
  const range = byLocalId.get("rule:Q2:range");
  check(
    "derive gate: a one-sided numeric bound still produces a range obligation [DER-RANGE-AND-OR]",
    Boolean(range) && range.payload.min === 0 && range.payload.max === null,
    JSON.stringify(range && range.payload)
  );
  // DER-PIPING-EARLIER-SOURCE: {Q4} appears in Q3, i.e. forward. The engine
  // renders it literally, so no piping obligation may be derived.
  check(
    "derive gate: a FORWARD piping token derives no piping obligation [DER-PIPING-EARLIER-SOURCE]",
    !ids.has("rule:Q3:piping:Q4") && set.notes.some((n) => n.includes("{Q4}")),
    [...ids].join(", ")
  );
  // DER-REACHABILITY-FROM-WALK: the unconditional goto skips Q2 entirely.
  check(
    "derive gate: reachability comes from the walk — Q2 is unreachable [DER-REACHABILITY-FROM-WALK]",
    byLocalId.get("question:Q2").reachable === false && byLocalId.get("question:Q3").reachable === true,
    JSON.stringify(set.obligations.map((o) => [o.localId, o.reachable]))
  );
  // WALK-FIRST-MATCH-WINS: answering Q1=2 fires rule 1 (terminate), not the
  // later unconditional goto. Under last-match-wins the terminate edge would
  // never be attributed a witness path.
  check(
    "walk gate: edge attribution is FIRST match wins [WALK-FIRST-MATCH-WINS]",
    byLocalId.get("branch:Q1:terminate:SCREENOUT:taken").reachable === true,
    JSON.stringify(byLocalId.get("branch:Q1:terminate:SCREENOUT:taken"))
  );
}

function schemaGuardGates() {
  const ok = checkManifestCoverage(synthManifest(), "syn");
  check("schema-guard: control — the synthetic manifest is fully mapped", ok.length === 0, JSON.stringify(ok));

  // SG-UNKNOWN-KEY
  const strayTop = { ...synthManifest(), somethingNew: true };
  check(
    "schema-guard gate: an unknown TOP-LEVEL key is reported [SG-UNKNOWN-KEY]",
    checkManifestCoverage(strayTop, "syn").some((p) => p.includes("somethingNew")),
    JSON.stringify(checkManifestCoverage(strayTop, "syn"))
  );
  const strayQuestion = synthManifest();
  strayQuestion.questions[0].displayLogic = { mode: "x" };
  check(
    "schema-guard gate: an unknown QUESTION key is reported [SG-UNKNOWN-KEY]",
    checkManifestCoverage(strayQuestion, "syn").some((p) => p.includes("displayLogic")),
    JSON.stringify(checkManifestCoverage(strayQuestion, "syn"))
  );

  // SG-UNKNOWN-ENUM
  const strayType = synthManifest();
  strayType.questions[1].type = "slider";
  check(
    "schema-guard gate: an unknown question TYPE is reported [SG-UNKNOWN-ENUM]",
    checkManifestCoverage(strayType, "syn").some((p) => p.includes("questionType")),
    JSON.stringify(checkManifestCoverage(strayType, "syn"))
  );
  const strayOp = synthManifest();
  strayOp.questions[0].rules[0].if = { q: "Q1", op: "matchesRegex", value: "x" };
  check(
    "schema-guard gate: an unknown condition OPERATOR is reported [SG-UNKNOWN-ENUM]",
    checkManifestCoverage(strayOp, "syn").some((p) => p.includes("condOp")),
    JSON.stringify(checkManifestCoverage(strayOp, "syn"))
  );

  // SG-NESTED-COND-RECURSION — the unknown construct is one level down, inside
  // an and/or term. Only the recursive walk can see it.
  const nested = synthManifest();
  nested.questions[0].rules[0].if = {
    op: "and",
    terms: [
      { q: "Q1", op: "eq", value: 2 },
      { q: "Q1", op: "sortsBefore", value: 1 },
    ],
  };
  check(
    "schema-guard gate: an unknown operator NESTED inside and/or is reported [SG-NESTED-COND-RECURSION]",
    checkManifestCoverage(nested, "syn").some((p) => p.includes("sortsBefore")),
    JSON.stringify(checkManifestCoverage(nested, "syn"))
  );
}

function seededMapGates() {
  // SM-NO-OP-REPLACE — a seeded "defect" that changes nothing is not a defect.
  const doc = { questions: [{ id: "Q1", text: "Pick one" }] };
  let threw = false;
  try {
    applyPatchOp(clone(doc), { op: "replace", path: "/questions/0/text", value: "Pick one" });
  } catch {
    threw = true;
  }
  check("seeded-map gate: a no-op replace patch is rejected [SM-NO-OP-REPLACE]", threw, "must throw");
  let realThrew = false;
  try {
    applyPatchOp(clone(doc), { op: "replace", path: "/questions/0/text", value: "Pick two" });
  } catch {
    realThrew = true;
  }
  check("seeded-map: control — a real replace patch applies", realThrew === false, "must not throw");

  // SM-UNION-MATCHES — a flawed variant that differs from clean in a way NO
  // seeded error accounts for must be reported as un-tiled.
  const cleanRaw = synthManifest();
  const cleanSet = derive(cleanRaw, "clean");
  const unattributedFlawed = synthManifest();
  unattributedFlawed.questions[0].text = "Pick exactly one";
  const flawedSet = derive(unattributedFlawed, "flawed");
  const untiled = mapSeededErrors({
    surveyId: "syn",
    cleanRaw,
    seededErrors: [],
    cleanSet,
    flawedSet,
  });
  check(
    "seeded-map gate: an unattributed clean/flawed delta is reported [SM-UNION-MATCHES]",
    untiled.unionMatchesFullDiff === false && untiled.unattributedDeltas.length > 0,
    JSON.stringify(untiled.unattributedDeltas)
  );
  const tiled = mapSeededErrors({
    surveyId: "syn",
    cleanRaw,
    seededErrors: [
      {
        id: "E1",
        category: "wording",
        location: "Q1",
        description: "Q1 wording changed",
        patch: [{ op: "replace", path: "/questions/0/text", value: "Pick exactly one" }],
      },
    ],
    cleanSet,
    flawedSet,
  });
  check(
    "seeded-map: control — an attributed delta tiles the diff exactly",
    tiled.unionMatchesFullDiff === true,
    JSON.stringify(tiled.unattributedDeltas)
  );

  // SM-MODIFIED-HASH-AGREEMENT — two seeded errors touch the SAME obligation.
  // Each single-patch derivation is a valid delta, but the last-applied hash no
  // longer equals the combined flawed hash: the errors interact.
  const interactingFlawed = synthManifest();
  interactingFlawed.questions[0].text = "Pick B";
  const interactingSet = derive(interactingFlawed, "flawed");
  const interacting = mapSeededErrors({
    surveyId: "syn",
    cleanRaw,
    seededErrors: [
      {
        id: "E-B",
        category: "wording",
        location: "Q1",
        description: "B",
        patch: [{ op: "replace", path: "/questions/0/text", value: "Pick B" }],
      },
      {
        id: "E-A",
        category: "wording",
        location: "Q1",
        description: "A",
        patch: [{ op: "replace", path: "/questions/0/text", value: "Pick A" }],
      },
    ],
    cleanSet,
    flawedSet: interactingSet,
  });
  check(
    "seeded-map gate: interacting seeded errors on one obligation are reported [SM-MODIFIED-HASH-AGREEMENT]",
    interacting.unionMatchesFullDiff === false &&
      interacting.unattributedDeltas.some((d) => d.includes("single-patch hash")),
    JSON.stringify(interacting.unattributedDeltas)
  );
}

function pipelineGates() {
  // PIPE-PATH-COUNT — the only independent cross-check on the walk enumeration
  // is corpus.json's declared routing-path count. Feed a deliberately wrong
  // count and the build must complain. (Read-only: the real manifests are used
  // unchanged; only the expectation passed in is wrong.)
  const wrongCounts = buildSurvey({
    id: "s1-skip",
    files: {},
    routingPaths: { clean: 99999, flawed: 99999 },
  });
  check(
    "pipeline gate: a walk that disagrees with corpus.json routingPaths is a problem [PIPE-PATH-COUNT]",
    wrongCounts.problems.some((p) => p.includes("corpus.json says")),
    JSON.stringify(wrongCounts.problems)
  );
}

function serializeGates() {
  // SER-REACHABLE-AND-OR — the target still RENDERS Q1, but the answer the
  // documented rule names has been removed, so its triggering stimulus can no
  // longer be given. Reachability needs BOTH rendered AND givable.
  const cleanSet = derive(synthManifest(), "clean");
  const strippedOption = synthManifest();
  strippedOption.questions[0].options = [{ code: 1, label: "Yes" }];
  strippedOption.questions[0].rules = [{ if: { op: "always" }, goto: "Q3" }];
  const targetSet = derive(strippedOption, "flawed");
  const idx = targetIndexOf(targetSet);

  const terminateEdge = cleanSet.obligations.find((o) => o.localId === "branch:Q1:terminate:SCREENOUT:taken");
  const reach = reachabilityAgainstTarget(terminateEdge, cleanSet, idx);
  check(
    "serialize gate: a rendered question whose stimulus is no longer givable is UNREACHABLE [SER-REACHABLE-AND-OR]",
    reach.status === "unreachable",
    JSON.stringify(reach)
  );
  const questionOb = cleanSet.obligations.find((o) => o.localId === "question:Q1");
  check(
    "serialize: control — the question itself stays reachable in the same target",
    reachabilityAgainstTarget(questionOb, cleanSet, idx).status === "reachable",
    JSON.stringify(reachabilityAgainstTarget(questionOb, cleanSet, idx))
  );
}

// Independent reference vectors for the string "café" (U+0063 U+0061 U+0066
// U+00E9), computed outside this codebase. UTF-8 is five bytes
// (63 61 66 c3 a9); latin1 is four (63 61 66 e9) and hashes differently.
const CAFE_SHA256_UTF8 = "850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e";
const CAFE_SHA256_LATIN1 = "dafd66c0b98965e688be1fc12942c09f0350e6be0685017c3f234e97d0adc92e";

function corpusHashGates() {
  // ORC-SHA-ENCODING — a fixed external vector, not a self-comparison. Every
  // obligation contentHash and the whole reproducible ground truth ride on this
  // encoding, and a silent switch is invisible on ASCII-only corpora.
  const got = sha256OfString("café");
  check(
    "corpus gate: content hashes are SHA-256 over UTF-8 bytes [ORC-SHA-ENCODING]",
    got === CAFE_SHA256_UTF8 && got !== CAFE_SHA256_LATIN1,
    `got ${got}, expected ${CAFE_SHA256_UTF8}`
  );
}

/* -------------------------------- main ---------------------------------- */

attestGates();
evidenceIntegrityGates();
evidenceSufficiencyGates();
integrityGates();
resourceGates();
metricsGates();
matcherGates();
defectMatchGates();
oracleDerivationGates();
schemaGuardGates();
seededMapGates();
pipelineGates();
serializeGates();
corpusHashGates();

console.log(
  "GATE-COVERAGE " +
    JSON.stringify({ totalChecks: checksRun, totalChecksPassed: checksRun - failures, totalChecksFailed: failures })
);
if (failures > 0) {
  console.error(`\n${failures} failing check(s):`);
  for (const d of failureDetails) console.error("  - " + d);
  process.exit(1);
}

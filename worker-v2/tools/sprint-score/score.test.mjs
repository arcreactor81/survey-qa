import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ORACLE_SCHEMA_VERSION, publicSummary, scoreSprint } from "./score.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "cli.mjs");

function observation(overrides = {}) {
  return {
    observationId: "obs-defect",
    facetInstanceId: "facet-defect",
    payloadKind: "option-set",
    verifier: { decision: "contradicted", predicate: "option-set-membership" },
    attestation: { payloadHash: "sha256:synthetic-observation" },
    ...overrides,
  };
}

function itemResult(
  requirementLineageId = "lineage-a",
  requirementVersionId = "version-a",
  facetInstanceId = "facet-defect",
) {
  return {
    requirementLineageId,
    requirementVersionId,
    facetResults: [{ facetInstanceId, status: "fail" }],
  };
}

function strictClaim(overrides = {}) {
  return {
    claimId: "claim-defect",
    claimClass: "defect",
    claimType: "option-set-mismatch",
    normativeRef: { requirementLineageId: "lineage-a", requirementVersionId: "version-a" },
    observationRefs: ["obs-defect"],
    prose: "ignored by strict scoring",
    ...overrides,
  };
}

function record(runId, { claims = [], observations = [observation()], itemResults = [itemResult()] } = {}) {
  const evidenceId = `evidence-${runId}`;
  const attemptId = `attempt-${runId}`;
  return {
    schemaVersion: "run-record/2.0.0",
    kind: "survey-qa-v2-run-record",
    runId,
    attempts: [{ attemptId }],
    observations: observations.map((value) => ({
      ...value,
      attemptId: value.attemptId ?? attemptId,
      evidenceIds: value.evidenceIds ?? [evidenceId],
      verifier: {
        ...value.verifier,
        evidenceIds: value.verifier?.evidenceIds ?? [evidenceId],
      },
    })),
    claims,
    itemResults,
    evidence: [{ evidenceId }],
  };
}

const expectedClaim = () => ({
  claimType: "option-set-mismatch",
  normativeRef: { requirementLineageId: "lineage-a", requirementVersionId: "version-a" },
  observation: { payloadKind: "option-set", predicate: "option-set-membership" },
});

function passingProbe(stage) {
  if (stage === "eligible") return ({ defect }) => ({ passed: true, refs: [{ kind: "oracle", id: defect.caseId }], code: null });
  if (stage === "exactScreenReached") {
    return ({ record: value }) => ({ passed: true, refs: [{ kind: "evidence", id: `evidence-${value.runId}` }], code: null });
  }
  if (stage === "uniquelyBound") {
    return () => ({ passed: true, refs: [{ kind: "observation", id: "obs-defect" }], code: null });
  }
  if (stage === "typedCaseEmitted") {
    return () => ({ passed: true, refs: [{ kind: "facet", id: "facet-defect" }], code: null });
  }
  return () => ({
    passed: true,
    refs: [{ kind: "item", requirementLineageId: "lineage-a", requirementVersionId: "version-a" }],
    code: null,
  });
}

function oracle(overrides = {}) {
  const probes = Object.fromEntries(
    ["eligible", "exactScreenReached", "uniquelyBound", "typedCaseEmitted", "decided"].map((stage) => [
      stage,
      passingProbe(stage),
    ]),
  );
  return {
    schemaVersion: ORACLE_SCHEMA_VERSION,
    defects: [{ caseId: "opaque-defect-1", runId: "flawed", expectedClaim: expectedClaim() }],
    cleanControls: [{ controlId: "opaque-control-1", runId: "clean" }],
    probes,
    ...overrides,
  };
}

function inputs({ flawedClaims = [strictClaim()], flawedObservations, flawedItemResults, oracleOverrides } = {}) {
  return {
    records: [
      record("flawed", {
        claims: flawedClaims,
        observations: flawedObservations ?? [observation()],
        itemResults: flawedItemResults ?? [itemResult()],
      }),
      record("clean", { claims: [] }),
    ],
    oracle: oracle(oracleOverrides),
  };
}

test("strict success is counted in both E2E and conditional scoreboards", async () => {
  const result = await scoreSprint(inputs());
  assert.deepEqual(result.scoreboards.endToEnd, { numerator: 1, denominator: 1, rate: 1, status: "measured" });
  assert.deepEqual(result.scoreboards.conditionalReached, {
    numerator: 1,
    denominator: 1,
    rate: 1,
    status: "measured",
  });
  assert.equal(result.gaps.detected, 1);
  assert.equal(result.cleanControls.falsePositiveClaims, 0);
});

test("negative mutation: losing exact-screen proof creates a visible coverage gap", async () => {
  const mutated = oracle();
  mutated.probes.exactScreenReached = () => ({
    passed: false,
    refs: [{ kind: "evidence", id: "evidence-flawed" }],
    code: "EXACT_SCREEN_NOT_REACHED",
  });
  // Typed-case and decision probes still run and remain visible; coverage does not mask them.
  const result = await scoreSprint({ ...inputs(), oracle: mutated, records: inputs({ flawedClaims: [] }).records });
  assert.equal(result.gaps.coverage, 1);
  assert.equal(result.stages.exactScreenReached.failed, 1);
  assert.equal(result.stages.typedCaseEmitted.passed, 1);
  assert.equal(result.stages.decided.passed, 1);
  assert.deepEqual(result.scoreboards.conditionalReached, {
    numerator: 0,
    denominator: 0,
    rate: null,
    status: "no-denominator",
  });
});

test("negative mutation: deleting the exact claim creates a nonzero predicate gap", async () => {
  const result = await scoreSprint(inputs({ flawedClaims: [] }));
  assert.equal(result.gaps.predicate, 1);
  assert.equal(result.stages.strictClaimMatched.failed, 1);
  assert.equal(result.scoreboards.endToEnd.numerator, 0);
  assert.equal(result.scoreboards.conditionalReached.denominator, 1);
});

test("negative mutation: a claim for the wrong defect type cannot count", async () => {
  const wrong = strictClaim({ claimType: "routing-mismatch" });
  const result = await scoreSprint(inputs({ flawedClaims: [wrong] }));
  assert.equal(result.gaps.predicate, 1);
  assert.deepEqual(result.cases[0].matchingClaimIds, []);
});

test("negative mutation: a claim with only the wrong lineage cannot count", async () => {
  const wrong = strictClaim({
    normativeRef: { requirementLineageId: "somewhere-else", requirementVersionId: "version-a" },
    observationRefs: ["obs-other"],
  });
  const result = await scoreSprint(inputs({
    flawedClaims: [wrong],
    flawedObservations: [
      observation(),
      observation({ observationId: "obs-other", facetInstanceId: "facet-other" }),
    ],
    flawedItemResults: [itemResult(), itemResult("somewhere-else", "version-a", "facet-other")],
  }));
  assert.equal(result.gaps.predicate, 1);
  assert.equal(result.scoreboards.endToEnd.numerator, 0);
});

test("negative mutation: a claim with only the wrong version cannot count", async () => {
  const wrong = strictClaim({
    normativeRef: { requirementLineageId: "lineage-a", requirementVersionId: "different-version" },
    observationRefs: ["obs-other"],
  });
  const result = await scoreSprint(inputs({
    flawedClaims: [wrong],
    flawedObservations: [
      observation(),
      observation({ observationId: "obs-other", facetInstanceId: "facet-other" }),
    ],
    flawedItemResults: [itemResult(), itemResult("lineage-a", "different-version", "facet-other")],
  }));
  assert.equal(result.gaps.predicate, 1);
  assert.equal(result.scoreboards.endToEnd.numerator, 0);
});

test("negative mutations: claim class, payload kind, decision, and payload hash are each load-bearing", async () => {
  const wrongClass = await scoreSprint(inputs({ flawedClaims: [strictClaim({ claimClass: "notice" })] }));
  assert.equal(wrongClass.gaps.predicate, 1);

  const wrongPayload = await scoreSprint(inputs({
    flawedObservations: [observation({ payloadKind: "rendered-state" })],
  }));
  assert.equal(wrongPayload.gaps.predicate, 1);

  const wrongDecision = await scoreSprint(inputs({
    flawedObservations: [
      observation({ verifier: { decision: "verified", predicate: "option-set-membership" } }),
    ],
  }));
  assert.equal(wrongDecision.gaps.predicate, 1);

  const expectedWithHash = expectedClaim();
  expectedWithHash.observation.payloadHash = "sha256:different-payload";
  const wrongHash = await scoreSprint(inputs({
    oracleOverrides: {
      defects: [{ caseId: "opaque-defect-1", runId: "flawed", expectedClaim: expectedWithHash }],
    },
  }));
  assert.equal(wrongHash.gaps.predicate, 1);
});

test("negative mutation: a claim backed by the wrong predicate cannot count", async () => {
  const wrongObservation = observation({
    verifier: { decision: "contradicted", predicate: "some-other-predicate" },
  });
  const result = await scoreSprint(inputs({ flawedObservations: [wrongObservation] }));
  assert.equal(result.gaps.predicate, 1);
  assert.equal(result.stages.strictClaimMatched.failed, 1);
});

test("any claim on a clean control is a false positive", async () => {
  const value = inputs();
  value.records[1].claims = [strictClaim({ claimId: "claim-on-clean" })];
  const result = await scoreSprint(value);
  assert.equal(result.cleanControls.falsePositiveControls, 1);
  assert.equal(result.cleanControls.falsePositiveClaims, 1);
  assert.equal(result.cleanControls.cleanControls, 0);
});

test("a passed stage without a real record-backed reference is rejected", async () => {
  const bad = oracle();
  bad.probes.exactScreenReached = () => ({ passed: true, refs: [], code: null });
  await assert.rejects(() => scoreSprint({ ...inputs(), oracle: bad }), /UNPROVEN_STAGE/);
});

test("a strict claim without proven prerequisite stages is rejected as inconsistent", async () => {
  const bad = oracle();
  bad.probes.uniquelyBound = () => ({ passed: false, refs: [], code: "IDENTITY_AMBIGUOUS" });
  await assert.rejects(() => scoreSprint({ ...inputs(), oracle: bad }), /INCONSISTENT_CLAIM_PIPELINE/);
});

test("empty denominators and malformed RunRecord-like inputs fail loudly", async () => {
  const empty = oracle({ defects: [] });
  await assert.rejects(() => scoreSprint({ records: inputs().records, oracle: empty }), /EMPTY_DENOMINATOR/);
  const noControls = oracle({ cleanControls: [] });
  await assert.rejects(() => scoreSprint({ records: inputs().records, oracle: noControls }), /EMPTY_DENOMINATOR/);
  await assert.rejects(
    () => scoreSprint({ records: [{ runId: "broken" }], oracle: oracle() }),
    /records\[0\]\.observations must be an array/,
  );
});

test("one production claim cannot receive credit for two oracle defects", async () => {
  const duplicate = expectedClaim();
  const repeated = oracle({
    defects: [
      { caseId: "opaque-defect-1", runId: "flawed", expectedClaim: expectedClaim() },
      { caseId: "opaque-defect-2", runId: "flawed", expectedClaim: duplicate },
    ],
  });
  await assert.rejects(
    () => scoreSprint({ records: inputs().records, oracle: repeated }),
    /duplicate identity/,
  );

  const hashSpecific = expectedClaim();
  hashSpecific.observation.payloadHash = "sha256:synthetic-observation";
  const overlapping = oracle({
    defects: [
      { caseId: "opaque-defect-broad", runId: "flawed", expectedClaim: expectedClaim() },
      { caseId: "opaque-defect-hash-specific", runId: "flawed", expectedClaim: hashSpecific },
    ],
  });
  const allocated = await scoreSprint({ records: inputs().records, oracle: overlapping });
  assert.deepEqual(allocated.scoreboards.endToEnd, {
    numerator: 1,
    denominator: 2,
    rate: 0.5,
    status: "measured",
  });
  assert.equal(allocated.gaps.predicate, 1);
});

test("maximum matching reassigns a broad case so two distinct claims receive 2/2 credit", async () => {
  const specificPayloadHash = "sha256:specific-observation";
  const broadExpected = expectedClaim();
  const specificExpected = expectedClaim();
  specificExpected.observation.payloadHash = specificPayloadHash;

  // Sorted greedy order is intentionally hostile: the broad case is visited first and
  // `claim-a-specific` sorts before `claim-b-general`. A non-augmenting allocator would
  // consume the specific case's only candidate and stop at 1/2.
  const value = inputs({
    flawedClaims: [
      strictClaim({ claimId: "claim-a-specific", observationRefs: ["obs-defect"] }),
      strictClaim({ claimId: "claim-b-general", observationRefs: ["obs-alternate"] }),
    ],
    flawedObservations: [
      observation({ attestation: { payloadHash: specificPayloadHash } }),
      observation({
        observationId: "obs-alternate",
        attestation: { payloadHash: "sha256:alternate-observation" },
      }),
    ],
    oracleOverrides: {
      defects: [
        { caseId: "opaque-defect-a-broad", runId: "flawed", expectedClaim: broadExpected },
        { caseId: "opaque-defect-b-specific", runId: "flawed", expectedClaim: specificExpected },
      ],
    },
  });

  const result = await scoreSprint(value);
  assert.deepEqual(result.scoreboards.endToEnd, {
    numerator: 2,
    denominator: 2,
    rate: 1,
    status: "measured",
  });

  const broad = result.cases.find((row) => row.caseId === "opaque-defect-a-broad");
  const specific = result.cases.find((row) => row.caseId === "opaque-defect-b-specific");
  assert.deepEqual(broad.candidateClaimIds, ["claim-a-specific", "claim-b-general"]);
  assert.deepEqual(specific.candidateClaimIds, ["claim-a-specific"]);
  assert.deepEqual(broad.matchingClaimIds, ["claim-b-general"]);
  assert.deepEqual(specific.matchingClaimIds, ["claim-a-specific"]);
});

test("record and probe entities must be coherently linked to the expected normative item", async () => {
  const incoherent = inputs();
  incoherent.records[0].claims[0].normativeRef = {
    requirementLineageId: "missing-lineage",
    requirementVersionId: "missing-version",
  };
  await assert.rejects(() => scoreSprint(incoherent), /names no itemResult/);

  const secondItem = itemResult("lineage-b", "version-b", "facet-other");
  const unrelated = inputs({
    flawedObservations: [
      observation(),
      observation({ observationId: "obs-other", facetInstanceId: "facet-other" }),
    ],
    flawedItemResults: [itemResult(), secondItem],
  });
  unrelated.oracle.probes.typedCaseEmitted = () => ({
    passed: true,
    refs: [{ kind: "facet", id: "facet-other" }],
    code: null,
  });
  await assert.rejects(() => scoreSprint(unrelated), /not bound to the expected normative requirement/);
});

test("public output contains aggregates but no oracle ids, run ids, or evidence refs", async () => {
  const summary = publicSummary(await scoreSprint(inputs()));
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("opaque-defect-1"), false);
  assert.equal(serialized.includes("flawed"), false);
  assert.equal(serialized.includes("evidence-flawed"), false);
  assert.equal(summary.gaps.detected, 1);
});

test("CLI exits nonzero for missing/invalid inputs and emits only redacted output on success", () => {
  const missing = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /CLI_INPUT_ERROR/);

  const dir = mkdtempSync(path.join(tmpdir(), "sprint-score-test-"));
  try {
    const invalidPath = path.join(dir, "invalid.json");
    writeFileSync(invalidPath, "not json", "utf8");
    const missingOraclePath = path.join(dir, "absent-oracle.mjs");
    const invalid = spawnSync(process.execPath, [CLI, "--records", invalidPath, "--oracle", missingOraclePath], {
      encoding: "utf8",
    });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /CLI_INPUT_ERROR/);

    const recordsPath = path.join(dir, "records.json");
    writeFileSync(recordsPath, JSON.stringify(inputs().records), "utf8");
    const oraclePath = path.join(dir, "private-oracle.mjs");
    writeFileSync(
      oraclePath,
      `
        console.log("PRIVATE_SENTINEL_STDOUT");
        process.stderr.write("PRIVATE_SENTINEL_STDERR\\n");
        const hit = (stage) => ({ record, defect }) => {
          if (stage === "eligible") return { passed: true, refs: [{ kind: "oracle", id: defect.caseId }], code: null };
          if (stage === "exactScreenReached") return { passed: true, refs: [{ kind: "evidence", id: "evidence-" + record.runId }], code: null };
          if (stage === "uniquelyBound") return { passed: true, refs: [{ kind: "observation", id: "obs-defect" }], code: null };
          if (stage === "typedCaseEmitted") return { passed: true, refs: [{ kind: "facet", id: "facet-defect" }], code: null };
          return { passed: true, refs: [{ kind: "item", requirementLineageId: "lineage-a", requirementVersionId: "version-a" }], code: null };
        };
        export default {
          schemaVersion: "${ORACLE_SCHEMA_VERSION}",
          defects: [{
            caseId: "PRIVATE_SENTINEL_CASE",
            runId: "flawed",
            placement: "PRIVATE_SENTINEL_PLACEMENT",
            expectedClaim: {
              claimType: "option-set-mismatch",
              normativeRef: { requirementLineageId: "lineage-a", requirementVersionId: "version-a" },
              observation: { payloadKind: "option-set", predicate: "option-set-membership" }
            }
          }],
          cleanControls: [{ controlId: "PRIVATE_SENTINEL_CONTROL", runId: "clean" }],
          probes: Object.fromEntries(["eligible", "exactScreenReached", "uniquelyBound", "typedCaseEmitted", "decided"].map((stage) => [stage, hit(stage)]))
        };
      `,
      "utf8",
    );
    const success = spawnSync(
      process.execPath,
      [CLI, "--records", recordsPath, "--oracle", oraclePath, "--pretty"],
      { encoding: "utf8" },
    );
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stdout.includes("PRIVATE_SENTINEL"), false);
    assert.equal(success.stderr.includes("PRIVATE_SENTINEL"), false);
    assert.equal(success.stdout.includes("evidence-flawed"), false);
    assert.equal(JSON.parse(success.stdout).gaps.detected, 1);

    writeFileSync(
      oraclePath,
      `
        process.stdout.write('PRIVATE_SENTINEL_STDOUT\\n');
        process.stderr.write('PRIVATE_SENTINEL_STDERR\\n');
        export default () => {
          const error = new Error('PRIVATE_SENTINEL_PLACEMENT');
          error.code = 'PRIVATE_SENTINEL_ERROR_CODE';
          throw error;
        };
      `,
      'utf8',
    );
    const privateFailure = spawnSync(
      process.execPath,
      [CLI, '--records', recordsPath, '--oracle', oraclePath],
      { encoding: 'utf8' },
    );
    assert.notEqual(privateFailure.status, 0);
    assert.equal(privateFailure.stdout.includes('PRIVATE_SENTINEL'), false);
    assert.equal(privateFailure.stderr.includes('PRIVATE_SENTINEL'), false);
    assert.match(privateFailure.stderr, /CLI_INPUT_ERROR/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Boundary-safe scorer for the frozen-contract sprint.
 *
 * This module deliberately knows nothing about a survey, a corpus, a manifest, or where
 * private truth is stored. It accepts only production RunRecord-like JSON and an oracle
 * object supplied by the independent scorer at call time. The oracle identifies the
 * opaque cases and proves the first five stages with references to entities that really
 * exist in the record. This module computes the final, strict claim match itself.
 *
 * Important: every stage probe is evaluated independently. A coverage miss therefore
 * cannot hide the fact that (for example) a typed case was emitted, and a target-level
 * early stop cannot manufacture a zero predicate-gap count. `gaps` is an exclusive
 * first-failure partition; `stages` is the independent accounting.
 */

export const SCORE_SCHEMA_VERSION = "sprint-score/1.0.0";
export const ORACLE_SCHEMA_VERSION = "sprint-score-oracle/1.0.0";
export const SCORER_VERSION = "frozen-contract-scorer/1.0.0";

const PROBE_STAGES = Object.freeze([
  "eligible",
  "exactScreenReached",
  "uniquelyBound",
  "typedCaseEmitted",
  "decided",
]);

const ALL_STAGES = Object.freeze([...PROBE_STAGES, "strictClaimMatched"]);

const ALLOWED_REF_KINDS = Object.freeze({
  eligible: new Set(["oracle"]),
  exactScreenReached: new Set(["evidence", "observation"]),
  uniquelyBound: new Set(["observation", "facet"]),
  typedCaseEmitted: new Set(["facet"]),
  decided: new Set(["item", "observation", "facet"]),
});

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function fail(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  throw error;
}

function nonEmptyString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("INVALID_INPUT", `${path} must be a non-empty string`);
  }
  return value;
}

function requiredArray(value, path) {
  if (!Array.isArray(value)) fail("INVALID_INPUT", `${path} must be an array`);
  return value;
}

function uniqueBy(values, keyOf, path) {
  const seen = new Set();
  for (const [index, value] of values.entries()) {
    const key = keyOf(value, index);
    if (seen.has(key)) fail("INVALID_INPUT", `${path} contains duplicate identity ${JSON.stringify(key)}`);
    seen.add(key);
  }
}

function cloneJson(value, path) {
  try {
    return structuredClone(value);
  } catch (error) {
    fail("INVALID_INPUT", `${path} must be structured-cloneable JSON-like data (${error.message})`);
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function validateRecord(input, index) {
  const path = `records[${index}]`;
  if (!isObject(input)) fail("INVALID_INPUT", `${path} must be an object`);

  const record = cloneJson(input, path);
  nonEmptyString(record.runId, `${path}.runId`);

  const observations = requiredArray(record.observations, `${path}.observations`);
  const claims = requiredArray(record.claims, `${path}.claims`);
  const itemResults = requiredArray(record.itemResults, `${path}.itemResults`);
  const attempts = requiredArray(record.attempts, `${path}.attempts`);
  const evidence = requiredArray(record.evidence, `${path}.evidence`);

  for (const [i, observation] of observations.entries()) {
    if (!isObject(observation)) fail("INVALID_INPUT", `${path}.observations[${i}] must be an object`);
    nonEmptyString(observation.observationId, `${path}.observations[${i}].observationId`);
    nonEmptyString(observation.facetInstanceId, `${path}.observations[${i}].facetInstanceId`);
    nonEmptyString(observation.payloadKind, `${path}.observations[${i}].payloadKind`);
    if (!isObject(observation.verifier)) {
      fail("INVALID_INPUT", `${path}.observations[${i}].verifier must be an object`);
    }
    nonEmptyString(observation.verifier.decision, `${path}.observations[${i}].verifier.decision`);
  }
  uniqueBy(observations, (o) => o.observationId, `${path}.observations`);
  const observationIds = new Set(observations.map((o) => o.observationId));

  for (const [i, claim] of claims.entries()) {
    if (!isObject(claim)) fail("INVALID_INPUT", `${path}.claims[${i}] must be an object`);
    nonEmptyString(claim.claimId, `${path}.claims[${i}].claimId`);
    nonEmptyString(claim.claimClass, `${path}.claims[${i}].claimClass`);
    nonEmptyString(claim.claimType, `${path}.claims[${i}].claimType`);
    if (!isObject(claim.normativeRef)) {
      fail("INVALID_INPUT", `${path}.claims[${i}].normativeRef must be an object`);
    }
    nonEmptyString(
      claim.normativeRef.requirementLineageId,
      `${path}.claims[${i}].normativeRef.requirementLineageId`,
    );
    nonEmptyString(
      claim.normativeRef.requirementVersionId,
      `${path}.claims[${i}].normativeRef.requirementVersionId`,
    );
    const refs = requiredArray(claim.observationRefs, `${path}.claims[${i}].observationRefs`);
    if (refs.length === 0) fail("INVALID_INPUT", `${path}.claims[${i}].observationRefs must not be empty`);
    for (const [j, ref] of refs.entries()) {
      nonEmptyString(ref, `${path}.claims[${i}].observationRefs[${j}]`);
      if (!observationIds.has(ref)) {
        fail("INVALID_INPUT", `${path}.claims[${i}] cites missing observation ${JSON.stringify(ref)}`);
      }
    }
  }
  uniqueBy(claims, (claim) => claim.claimId, `${path}.claims`);

  for (const [i, item] of itemResults.entries()) {
    if (!isObject(item)) fail("INVALID_INPUT", `${path}.itemResults[${i}] must be an object`);
    nonEmptyString(item.requirementLineageId, `${path}.itemResults[${i}].requirementLineageId`);
    nonEmptyString(item.requirementVersionId, `${path}.itemResults[${i}].requirementVersionId`);
    const facets = requiredArray(item.facetResults, `${path}.itemResults[${i}].facetResults`);
    for (const [j, facet] of facets.entries()) {
      if (!isObject(facet)) fail("INVALID_INPUT", `${path}.itemResults[${i}].facetResults[${j}] must be an object`);
      nonEmptyString(facet.facetInstanceId, `${path}.itemResults[${i}].facetResults[${j}].facetInstanceId`);
    }
  }
  uniqueBy(
    itemResults,
    (item) => `${item.requirementLineageId}\u0000${item.requirementVersionId}`,
    `${path}.itemResults`,
  );

  const itemKeys = new Set(
    itemResults.map((item) => `${item.requirementLineageId}\u0000${item.requirementVersionId}`),
  );
  const facetOwners = new Map();
  for (const [i, item] of itemResults.entries()) {
    const itemKey = `${item.requirementLineageId}\u0000${item.requirementVersionId}`;
    for (const [j, facet] of item.facetResults.entries()) {
      if (facetOwners.has(facet.facetInstanceId)) {
        fail(
          "INVALID_INPUT",
          `${path}.itemResults[${i}].facetResults[${j}] repeats facet identity ${JSON.stringify(facet.facetInstanceId)}`,
        );
      }
      facetOwners.set(facet.facetInstanceId, itemKey);
    }
  }

  for (const [i, attempt] of attempts.entries()) {
    if (!isObject(attempt)) fail("INVALID_INPUT", `${path}.attempts[${i}] must be an object`);
    nonEmptyString(attempt.attemptId, `${path}.attempts[${i}].attemptId`);
  }
  uniqueBy(attempts, (attempt) => attempt.attemptId, `${path}.attempts`);
  const attemptIds = new Set(attempts.map((attempt) => attempt.attemptId));

  for (const [i, entry] of evidence.entries()) {
    if (!isObject(entry)) fail("INVALID_INPUT", `${path}.evidence[${i}] must be an object`);
    nonEmptyString(entry.evidenceId, `${path}.evidence[${i}].evidenceId`);
  }
  uniqueBy(evidence, (entry) => entry.evidenceId, `${path}.evidence`);
  const evidenceIds = new Set(evidence.map((entry) => entry.evidenceId));

  const observationsById = new Map(observations.map((entry) => [entry.observationId, entry]));
  for (const [i, observation] of observations.entries()) {
    const observationPath = `${path}.observations[${i}]`;
    if (!facetOwners.has(observation.facetInstanceId)) {
      fail(
        "INVALID_INPUT",
        `${observationPath}.facetInstanceId names no facet in itemResults`,
      );
    }
    nonEmptyString(observation.attemptId, `${observationPath}.attemptId`);
    if (!attemptIds.has(observation.attemptId)) {
      fail("INVALID_INPUT", `${observationPath}.attemptId names no attempt in the same record`);
    }
    for (const [j, evidenceId] of requiredArray(observation.evidenceIds, `${observationPath}.evidenceIds`).entries()) {
      nonEmptyString(evidenceId, `${observationPath}.evidenceIds[${j}]`);
      if (!evidenceIds.has(evidenceId)) {
        fail("INVALID_INPUT", `${observationPath}.evidenceIds[${j}] names absent evidence ${JSON.stringify(evidenceId)}`);
      }
    }
    for (const [j, evidenceId] of requiredArray(
      observation.verifier.evidenceIds,
      `${observationPath}.verifier.evidenceIds`,
    ).entries()) {
      nonEmptyString(evidenceId, `${observationPath}.verifier.evidenceIds[${j}]`);
      if (!evidenceIds.has(evidenceId)) {
        fail(
          "INVALID_INPUT",
          `${observationPath}.verifier.evidenceIds[${j}] names absent evidence ${JSON.stringify(evidenceId)}`,
        );
      }
    }
  }

  for (const [i, claim] of claims.entries()) {
    const claimPath = `${path}.claims[${i}]`;
    const claimItemKey = `${claim.normativeRef.requirementLineageId}\u0000${claim.normativeRef.requirementVersionId}`;
    if (!itemKeys.has(claimItemKey)) {
      fail("INVALID_INPUT", `${claimPath}.normativeRef names no itemResult in the same record`);
    }
    for (const observationId of claim.observationRefs) {
      const observation = observationsById.get(observationId);
      const owner = observation ? facetOwners.get(observation.facetInstanceId) : null;
      if (owner !== claimItemKey) {
        fail(
          "INVALID_INPUT",
          `${claimPath} cites observation ${JSON.stringify(observationId)} from a different normative item`,
        );
      }
    }
  }

  // Probes are readers. A private oracle bug must not be able to rewrite the production
  // record between stages and thereby manufacture a coherent-looking funnel.
  return deepFreeze(record);
}

function recordIndex(record) {
  const facets = new Set();
  const facetOwners = new Map();
  for (const observation of record.observations) facets.add(observation.facetInstanceId);
  for (const item of record.itemResults) {
    const itemKey = `${item.requirementLineageId}\u0000${item.requirementVersionId}`;
    for (const facet of item.facetResults) {
      facets.add(facet.facetInstanceId);
      facetOwners.set(facet.facetInstanceId, itemKey);
    }
  }
  return {
    evidence: new Set(record.evidence.map((entry) => entry.evidenceId)),
    observations: new Set(record.observations.map((entry) => entry.observationId)),
    facets,
    attempts: new Set(record.attempts.map((entry) => entry.attemptId)),
    claims: new Set(record.claims.map((entry) => entry.claimId)),
    observationsById: new Map(record.observations.map((entry) => [entry.observationId, entry])),
    facetOwners,
    items: new Set(
      record.itemResults.map((item) => `${item.requirementLineageId}\u0000${item.requirementVersionId}`),
    ),
  };
}

function validateExpectedClaim(expected, path) {
  if (!isObject(expected)) fail("INVALID_ORACLE", `${path} must be an object`);
  nonEmptyString(expected.claimType, `${path}.claimType`);
  if (!isObject(expected.normativeRef)) fail("INVALID_ORACLE", `${path}.normativeRef must be an object`);
  nonEmptyString(expected.normativeRef.requirementLineageId, `${path}.normativeRef.requirementLineageId`);
  nonEmptyString(expected.normativeRef.requirementVersionId, `${path}.normativeRef.requirementVersionId`);
  if (!isObject(expected.observation)) fail("INVALID_ORACLE", `${path}.observation must be an object`);
  nonEmptyString(expected.observation.payloadKind, `${path}.observation.payloadKind`);
  nonEmptyString(expected.observation.predicate, `${path}.observation.predicate`);
  if (expected.observation.payloadHash !== undefined) {
    nonEmptyString(expected.observation.payloadHash, `${path}.observation.payloadHash`);
  }
}

function validateOracle(oracle, recordsById) {
  if (!isObject(oracle)) fail("INVALID_ORACLE", "oracle must be an object supplied at scoring time");
  if (oracle.schemaVersion !== ORACLE_SCHEMA_VERSION) {
    fail("INVALID_ORACLE", `oracle.schemaVersion must equal ${JSON.stringify(ORACLE_SCHEMA_VERSION)}`);
  }
  const defects = requiredArray(oracle.defects, "oracle.defects");
  const controls = requiredArray(oracle.cleanControls, "oracle.cleanControls");
  if (defects.length === 0) {
    fail("EMPTY_DENOMINATOR", "oracle.defects must not be empty; a zero-defect sprint cannot pass");
  }
  if (controls.length === 0) {
    fail("EMPTY_DENOMINATOR", "oracle.cleanControls must not be empty; false-positive safety needs a denominator");
  }
  if (!isObject(oracle.probes)) fail("INVALID_ORACLE", "oracle.probes must be an object");
  for (const stage of PROBE_STAGES) {
    if (typeof oracle.probes[stage] !== "function") {
      fail("INVALID_ORACLE", `oracle.probes.${stage} must be a function`);
    }
  }

  for (const [i, defect] of defects.entries()) {
    const path = `oracle.defects[${i}]`;
    if (!isObject(defect)) fail("INVALID_ORACLE", `${path} must be an object`);
    nonEmptyString(defect.caseId, `${path}.caseId`);
    nonEmptyString(defect.runId, `${path}.runId`);
    if (!recordsById.has(defect.runId)) {
      fail("MISSING_RECORD", `${path} names absent run ${JSON.stringify(defect.runId)}`);
    }
    validateExpectedClaim(defect.expectedClaim, `${path}.expectedClaim`);
  }
  uniqueBy(defects, (defect) => defect.caseId, "oracle.defects");
  uniqueBy(
    defects,
    (defect) =>
      JSON.stringify([
        defect.runId,
        defect.expectedClaim.claimType,
        defect.expectedClaim.normativeRef.requirementLineageId,
        defect.expectedClaim.normativeRef.requirementVersionId,
        defect.expectedClaim.observation.payloadKind,
        defect.expectedClaim.observation.predicate,
        defect.expectedClaim.observation.payloadHash ?? null,
      ]),
    "oracle.defects expected claim identities",
  );

  for (const [i, control] of controls.entries()) {
    const path = `oracle.cleanControls[${i}]`;
    if (!isObject(control)) fail("INVALID_ORACLE", `${path} must be an object`);
    nonEmptyString(control.controlId, `${path}.controlId`);
    nonEmptyString(control.runId, `${path}.runId`);
    if (!recordsById.has(control.runId)) {
      fail("MISSING_RECORD", `${path} names absent run ${JSON.stringify(control.runId)}`);
    }
  }
  uniqueBy(controls, (control) => control.controlId, "oracle.cleanControls");
  uniqueBy(controls, (control) => control.runId, "oracle.cleanControls run ids");

  const defectRunIds = new Set(defects.map((defect) => defect.runId));
  for (const control of controls) {
    if (defectRunIds.has(control.runId)) {
      fail(
        "INVALID_ORACLE",
        `run ${JSON.stringify(control.runId)} is both planted-defect and clean-control evidence`,
      );
    }
  }
}

function validateEntityRef(ref, { caseId, record, index, stage, refIndex }) {
  const path = `probe ${stage} for ${caseId}.refs[${refIndex}]`;
  if (!isObject(ref)) fail("INVALID_PROBE", `${path} must be an object`);
  const kind = nonEmptyString(ref.kind, `${path}.kind`);
  if (!ALLOWED_REF_KINDS[stage].has(kind)) {
    fail("INVALID_PROBE", `${path} kind ${JSON.stringify(kind)} is not evidence for stage ${stage}`);
  }

  if (kind === "item") {
    const lineage = nonEmptyString(ref.requirementLineageId, `${path}.requirementLineageId`);
    const version = nonEmptyString(ref.requirementVersionId, `${path}.requirementVersionId`);
    if (!index.items.has(`${lineage}\u0000${version}`)) {
      fail("INVALID_PROBE", `${path} names an item absent from run ${JSON.stringify(record.runId)}`);
    }
    return { kind, requirementLineageId: lineage, requirementVersionId: version };
  }

  const id = nonEmptyString(ref.id, `${path}.id`);
  if (kind === "oracle") {
    if (id !== caseId) fail("INVALID_PROBE", `${path} must identify its own opaque oracle case`);
    return { kind, id };
  }

  const collection =
    kind === "evidence"
      ? index.evidence
      : kind === "observation"
        ? index.observations
        : kind === "facet"
          ? index.facets
          : kind === "attempt"
            ? index.attempts
            : index.claims;
  if (!collection.has(id)) {
    fail("INVALID_PROBE", `${path} names ${kind} ${JSON.stringify(id)} absent from run ${JSON.stringify(record.runId)}`);
  }
  return { kind, id };
}

function validateProbeResult(value, context) {
  const { caseId, stage, defect, index } = context;
  if (!isObject(value)) fail("INVALID_PROBE", `probe ${stage} for ${caseId} must return an object`);
  if (typeof value.passed !== "boolean") {
    fail("INVALID_PROBE", `probe ${stage} for ${caseId}.passed must be boolean`);
  }
  const refs = requiredArray(value.refs, `probe ${stage} for ${caseId}.refs`).map((ref, refIndex) =>
    validateEntityRef(ref, { ...context, refIndex }),
  );
  if (value.passed && refs.length === 0) {
    fail("UNPROVEN_STAGE", `probe ${stage} for ${caseId} passed without a record-backed reference`);
  }
  const code = value.code === null || value.code === undefined ? null : nonEmptyString(value.code, `probe ${stage}.code`);
  if (!value.passed && code === null) {
    fail("INVALID_PROBE", `probe ${stage} for ${caseId} failed without a named reason code`);
  }

  if (value.passed && ["uniquelyBound", "typedCaseEmitted", "decided"].includes(stage)) {
    const expectedItemKey =
      `${defect.expectedClaim.normativeRef.requirementLineageId}\u0000` +
      `${defect.expectedClaim.normativeRef.requirementVersionId}`;
    const ownerOf = (ref) => {
      if (ref.kind === "item") return `${ref.requirementLineageId}\u0000${ref.requirementVersionId}`;
      if (ref.kind === "facet") return index.facetOwners.get(ref.id) ?? null;
      if (ref.kind === "observation") {
        const observation = index.observationsById.get(ref.id);
        return observation ? index.facetOwners.get(observation.facetInstanceId) ?? null : null;
      }
      return null;
    };
    if (refs.some((ref) => ownerOf(ref) !== expectedItemKey)) {
      fail(
        "UNPROVEN_STAGE",
        `probe ${stage} for ${caseId} cited an entity that is not bound to the expected normative requirement`,
      );
    }
  }
  return { passed: value.passed, refs, code };
}

function strictClaimMatches(record, expected) {
  const observationsById = new Map(record.observations.map((observation) => [observation.observationId, observation]));
  const matchingClaimIds = [];

  for (const claim of record.claims) {
    if (claim.claimClass !== "defect") continue;
    if (claim.claimType !== expected.claimType) continue;
    if (claim.normativeRef.requirementLineageId !== expected.normativeRef.requirementLineageId) continue;
    if (claim.normativeRef.requirementVersionId !== expected.normativeRef.requirementVersionId) continue;

    const observationMatches = claim.observationRefs.some((id) => {
      const observation = observationsById.get(id);
      if (!observation) return false;
      if (observation.payloadKind !== expected.observation.payloadKind) return false;
      if (observation.verifier.decision !== "contradicted") return false;
      if (observation.verifier.predicate !== expected.observation.predicate) return false;
      if (
        expected.observation.payloadHash !== undefined &&
        observation.attestation?.payloadHash !== expected.observation.payloadHash
      ) {
        return false;
      }
      return true;
    });

    if (observationMatches) matchingClaimIds.push(claim.claimId);
  }
  return matchingClaimIds;
}

function ratio(numerator, denominator) {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
    status: denominator === 0 ? "no-denominator" : "measured",
  };
}

function firstGap(stages) {
  if (!stages.eligible.passed) return "eligibility";
  if (!stages.exactScreenReached.passed) return "coverage";
  if (!stages.uniquelyBound.passed) return "binding";
  if (!stages.typedCaseEmitted.passed) return "typedCaseEmission";
  if (!stages.decided.passed) return "decision";
  if (!stages.strictClaimMatched.passed) return "predicate";
  return "detected";
}

/**
 * Allocate claims one-to-one. A single production claim is one detected defect, even if two
 * oracle descriptors are broad enough to match it. The augmenting-path matcher maximises the
 * number of credited cases without making the answer depend on oracle array order.
 */
function allocateStrictClaims(cases) {
  const claimOwner = new Map();
  const caseClaim = new Map();
  const ordered = [...cases].sort((a, b) => a.caseId.localeCompare(b.caseId));

  const augment = (row, visitedClaims) => {
    const candidates = [...row.candidateClaimIds].sort();
    for (const claimId of candidates) {
      const claimKey = `${row.runId}\u0000${claimId}`;
      if (visitedClaims.has(claimKey)) continue;
      visitedClaims.add(claimKey);
      const previous = claimOwner.get(claimKey);
      if (!previous) {
        claimOwner.set(claimKey, row);
        caseClaim.set(row, claimId);
        return true;
      }
      if (augment(previous, visitedClaims)) {
        claimOwner.set(claimKey, row);
        caseClaim.set(row, claimId);
        return true;
      }
    }
    return false;
  };

  for (const row of ordered) augment(row, new Set());
  return caseClaim;
}

/**
 * Score one frozen sprint.
 *
 * Oracle contract (all case identifiers are opaque):
 *   {
 *     schemaVersion: "sprint-score-oracle/1.0.0",
 *     defects: [{ caseId, runId, expectedClaim: {
 *       claimType,
 *       normativeRef: { requirementLineageId, requirementVersionId },
 *       observation: { payloadKind, predicate, payloadHash? }
 *     }}],
 *     cleanControls: [{ controlId, runId }],
 *     probes: { eligible, exactScreenReached, uniquelyBound, typedCaseEmitted, decided }
 *   }
 *
 * Each probe receives `{ record, defect }` and returns
 * `{ passed: boolean, refs: EntityRef[], code: string|null }`. Passed stages must cite a
 * compatible entity present in that same record. The scorer, not the oracle, performs
 * the strict claim-identity and contradicted-observation match.
 */
export async function scoreSprint({ records: inputRecords, oracle }) {
  const recordsInput = requiredArray(inputRecords, "records");
  if (recordsInput.length === 0) fail("EMPTY_INPUT", "records must not be empty");
  const records = recordsInput.map(validateRecord);
  uniqueBy(records, (record) => record.runId, "records");
  const recordsById = new Map(records.map((record) => [record.runId, record]));

  validateOracle(oracle, recordsById);

  const cases = [];
  for (const oracleDefect of oracle.defects) {
    // Descriptors are data, not executable oracle hooks. Clone them before use so a probe
    // cannot rewrite the expected claim for the next probe.
    const defect = deepFreeze(cloneJson(oracleDefect, `oracle defect ${oracleDefect.caseId}`));
    const record = recordsById.get(defect.runId);
    const index = recordIndex(record);
    const stages = {};

    for (const stage of PROBE_STAGES) {
      let raw;
      try {
        raw = await oracle.probes[stage]({ record, defect });
      } catch (error) {
        fail("ORACLE_PROBE_FAILED", `${stage} for ${defect.caseId}: ${error?.message ?? String(error)}`);
      }
      stages[stage] = validateProbeResult(raw, { caseId: defect.caseId, record, index, stage, defect });
    }

    const candidateClaimIds = strictClaimMatches(record, defect.expectedClaim);

    if (
      candidateClaimIds.length > 0 &&
      (!stages.eligible.passed ||
        !stages.exactScreenReached.passed ||
        !stages.uniquelyBound.passed ||
        !stages.typedCaseEmitted.passed ||
        !stages.decided.passed)
    ) {
      fail(
        "INCONSISTENT_CLAIM_PIPELINE",
        `${defect.caseId} has a strict matching claim without every prerequisite stage being proven`,
      );
    }

    cases.push({
      caseId: defect.caseId,
      runId: defect.runId,
      stages,
      candidateClaimIds,
    });
  }

  const claimAllocation = allocateStrictClaims(cases);
  for (const row of cases) {
    const allocatedClaimId = claimAllocation.get(row) ?? null;
    row.stages.strictClaimMatched = {
      passed: allocatedClaimId !== null,
      refs: allocatedClaimId === null ? [] : [{ kind: "claim", id: allocatedClaimId }],
      code: allocatedClaimId === null ? "NO_UNALLOCATED_STRICT_CLAIM_MATCH" : null,
    };
    row.matchingClaimIds = allocatedClaimId === null ? [] : [allocatedClaimId];
    row.firstGap = firstGap(row.stages);
  }

  const controlRows = oracle.cleanControls.map((control) => {
    const record = recordsById.get(control.runId);
    return {
      controlId: control.controlId,
      runId: control.runId,
      falsePositive: record.claims.length > 0,
      claimIds: record.claims.map((claim) => claim.claimId),
    };
  });

  const stages = Object.fromEntries(
    ALL_STAGES.map((stage) => {
      const passed = cases.filter((row) => row.stages[stage].passed).length;
      return [stage, { passed, failed: cases.length - passed, total: cases.length }];
    }),
  );

  const gapNames = ["eligibility", "coverage", "binding", "typedCaseEmission", "decision", "predicate", "detected"];
  const gaps = Object.fromEntries(gapNames.map((name) => [name, cases.filter((row) => row.firstGap === name).length]));
  const partitionTotal = Object.values(gaps).reduce((sum, value) => sum + value, 0);
  if (partitionTotal !== cases.length) {
    fail("INTERNAL_ACCOUNTING_ERROR", `gap partition counted ${partitionTotal} of ${cases.length} planted defects`);
  }

  const detected = cases.filter((row) => row.stages.strictClaimMatched.passed).length;
  const reached = cases.filter(
    (row) => row.stages.eligible.passed && row.stages.exactScreenReached.passed,
  );
  const reachedAndBound = reached.filter((row) => row.stages.uniquelyBound.passed);
  const falsePositiveControls = controlRows.filter((row) => row.falsePositive).length;
  const falsePositiveClaims = controlRows.reduce((sum, row) => sum + row.claimIds.length, 0);

  return {
    schemaVersion: SCORE_SCHEMA_VERSION,
    scorerVersion: SCORER_VERSION,
    scoreboards: {
      endToEnd: ratio(detected, cases.length),
      conditionalReached: ratio(
        reached.filter((row) => row.stages.strictClaimMatched.passed).length,
        reached.length,
      ),
      conditionalReachedAndBound: ratio(
        reachedAndBound.filter((row) => row.stages.strictClaimMatched.passed).length,
        reachedAndBound.length,
      ),
    },
    stages,
    gaps,
    cleanControls: {
      total: controlRows.length,
      falsePositiveControls,
      falsePositiveClaims,
      cleanControls: controlRows.length - falsePositiveControls,
    },
    cases,
    controls: controlRows,
  };
}

/** Public/redacted output: no oracle case ids, run ids, evidence refs, or placement detail. */
export function publicSummary(result) {
  if (!isObject(result) || result.schemaVersion !== SCORE_SCHEMA_VERSION) {
    fail("INVALID_SCORE", "publicSummary requires a scoreSprint result");
  }
  return {
    schemaVersion: result.schemaVersion,
    scorerVersion: result.scorerVersion,
    scoreboards: cloneJson(result.scoreboards, "scoreboards"),
    stages: cloneJson(result.stages, "stages"),
    gaps: cloneJson(result.gaps, "gaps"),
    cleanControls: cloneJson(result.cleanControls, "cleanControls"),
  };
}

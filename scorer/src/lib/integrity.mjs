// §4 step 5 structural integrity: ID uniqueness, cross-references,
// append-only attempt lineage, chronological order, contract-hash binding,
// and exact set equality between contract.items[*].itemId and
// itemResults[*].itemId (report denominator).
//
// Hard errors fail the run closed (quality suppressed).
// Soft errors deny credit for the affected claim but scoring proceeds,
// exactly as required by the §11 fixtures (e.g. DENOMINATOR_MISMATCH).

import { jcsHash } from "./canonical.mjs";

function pushErr(list, code, message) {
  list.push({ code, message });
}

function findDuplicate(ids) {
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

function ts(s) {
  return Date.parse(s);
}

/** Validate the OracleRecord's internal integrity (hard failures only). */
export function checkOracleIntegrity(oracle) {
  const errors = [];
  const obligationIds = oracle.obligations.map((o) => o.oracleId);
  const dupO = findDuplicate(obligationIds);
  if (dupO) pushErr(errors, "ORACLE_INVALID", `duplicate oracleId ${dupO}`);
  const witnessIds = oracle.witnessPaths.map((w) => w.witnessPathId);
  const dupW = findDuplicate(witnessIds);
  if (dupW) pushErr(errors, "ORACLE_INVALID", `duplicate witnessPathId ${dupW}`);
  const defectIds = oracle.seededDefects.map((d) => d.defectId);
  const dupD = findDuplicate(defectIds);
  if (dupD) pushErr(errors, "ORACLE_INVALID", `duplicate defectId ${dupD}`);

  const witnessSet = new Set(witnessIds);
  const obligationSet = new Set(obligationIds);
  for (const o of oracle.obligations) {
    for (const w of o.reachability.witnessPathIds) {
      if (!witnessSet.has(w)) {
        pushErr(errors, "ORACLE_INVALID", `obligation ${o.oracleId} references unknown witnessPathId ${w}`);
      }
    }
    if (o.reachability.status === "reachable" && o.reachability.witnessPathIds.length === 0) {
      pushErr(errors, "ORACLE_INVALID", `reachable obligation ${o.oracleId} has no witness path`);
    }
    if (o.reachability.status === "unreachable" && o.reachability.witnessPathIds.length > 0) {
      pushErr(errors, "ORACLE_INVALID", `unreachable obligation ${o.oracleId} has witness paths`);
    }
  }
  for (const d of oracle.seededDefects) {
    for (const a of d.affectedObligationIds) {
      if (!obligationSet.has(a)) {
        pushErr(errors, "ORACLE_INVALID", `defect ${d.defectId} references unknown obligation ${a}`);
      }
    }
  }
  return errors;
}

/**
 * Run/oracle subject identity (§4 step 4): document hash, target build
 * ID/hash, and evaluation subject must agree.
 */
export function checkIdentity(run, oracle) {
  const errors = [];
  if (run.run.documentHash !== oracle.survey.document.contentHash) {
    pushErr(
      errors,
      "RUN_IDENTITY_MISMATCH",
      `documentHash ${run.run.documentHash} does not match oracle document ${oracle.survey.document.contentHash}`
    );
  }
  if (run.run.target.buildId !== oracle.survey.targetBuild.buildId) {
    pushErr(
      errors,
      "RUN_IDENTITY_MISMATCH",
      `target buildId ${run.run.target.buildId} does not match oracle buildId ${oracle.survey.targetBuild.buildId}`
    );
  }
  if (run.run.target.buildHash !== oracle.survey.targetBuild.contentHash) {
    pushErr(
      errors,
      "RUN_IDENTITY_MISMATCH",
      `target buildHash ${run.run.target.buildHash} does not match oracle build ${oracle.survey.targetBuild.contentHash}`
    );
  }
  return errors;
}

/**
 * Oracle isolation (§9): any appearance of private oracle identifiers in the
 * RunRecord, or tester actions targeting private oracle paths, invalidates
 * the evaluation.
 */
export function checkOracleAccess(runRawText, run, oracle) {
  const errors = [];
  const privateIds = [
    oracle.oracleRecordId,
    oracle.survey.variant.variantId,
    ...oracle.obligations.map((o) => o.oracleId),
    ...oracle.witnessPaths.map((w) => w.witnessPathId),
    ...oracle.seededDefects.map((d) => d.defectId),
  ];
  // Boundary = alphanumerics only, so IDs embedded in URLs/paths
  // ("/private/oracle/orec-....json") are still detected.
  const idChar = "[A-Za-z0-9]";
  for (const id of privateIds) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<!${idChar})${escaped}(?!${idChar})`);
    if (re.test(runRawText)) {
      pushErr(
        errors,
        "ORACLE_ACCESS_VIOLATION",
        `private oracle identifier ${id} appears in the RunRecord`
      );
    }
  }
  const pathRe = /(private\/oracle|oracle-record|oracle_manifest|seeded-defect)/i;
  for (const attempt of run.attempts ?? []) {
    for (const action of attempt.actions ?? []) {
      const hay = `${action.target ?? ""} ${JSON.stringify(action.parameters ?? {})}`;
      if (pathRe.test(hay)) {
        pushErr(
          errors,
          "ORACLE_ACCESS_VIOLATION",
          `attempt ${attempt.attemptId} action ${action.actionId} targets a private oracle path`
        );
      }
    }
  }
  return errors;
}

/**
 * §4 step 5. Returns { hard, soft, index } where index carries lookup maps
 * used by later stages, plus the accounting of dropped/missing results.
 */
export function checkRunIntegrity(run) {
  const hard = [];
  const soft = [];

  const contractItems = run.contract.items;
  const itemIds = contractItems.map((it) => it.itemId);
  const dupItem = findDuplicate(itemIds);
  if (dupItem) pushErr(hard, "INTEGRITY_ID_COLLISION", `duplicate contract itemId ${dupItem}`);
  for (const it of contractItems) {
    const dupVar = findDuplicate((it.variants ?? []).map((v) => v.variantId));
    if (dupVar) pushErr(hard, "INTEGRITY_ID_COLLISION", `duplicate variantId ${dupVar} in item ${it.itemId}`);
  }

  const attemptIds = run.attempts.map((a) => a.attemptId);
  const dupAttempt = findDuplicate(attemptIds);
  if (dupAttempt) pushErr(hard, "INTEGRITY_ID_COLLISION", `duplicate attemptId ${dupAttempt}`);

  const actionIds = [];
  const stateIds = [];
  for (const a of run.attempts) {
    for (const act of a.actions) actionIds.push(act.actionId);
    for (const st of a.stateFingerprints) stateIds.push(st.stateId);
  }
  const dupAction = findDuplicate(actionIds);
  if (dupAction) pushErr(hard, "INTEGRITY_ID_COLLISION", `duplicate actionId ${dupAction}`);
  const dupState = findDuplicate(stateIds);
  if (dupState) pushErr(hard, "INTEGRITY_ID_COLLISION", `duplicate stateId ${dupState}`);

  const evidenceIds = run.evidence.map((e) => e.evidenceId);
  const dupEvidence = findDuplicate(evidenceIds);
  if (dupEvidence) pushErr(hard, "INTEGRITY_ID_COLLISION", `duplicate evidenceId ${dupEvidence}`);

  const findingIds = run.findings.map((f) => f.findingId);
  const dupFinding = findDuplicate(findingIds);
  if (dupFinding) pushErr(hard, "INTEGRITY_ID_COLLISION", `duplicate findingId ${dupFinding}`);

  const callIds = run.resources.modelCalls.map((c) => c.callId);
  const dupCall = findDuplicate(callIds);
  if (dupCall) pushErr(hard, "INTEGRITY_ID_COLLISION", `duplicate callId ${dupCall}`);

  // Contract-hash binding: run.contractHash == JCS hash of contract.
  // Canonicalization can legitimately FAIL (RFC 8785 rejects strings that are
  // not well-formed Unicode); that is a hard, fail-closed error, never a pass.
  let recomputedContractHash;
  try {
    recomputedContractHash = jcsHash(run.contract);
  } catch (e) {
    pushErr(hard, "CONTRACT_HASH_MISMATCH", `contract cannot be canonicalized: ${e.message}`);
    recomputedContractHash = null;
  }
  if (recomputedContractHash !== null && recomputedContractHash !== run.run.contractHash) {
    pushErr(
      hard,
      "CONTRACT_HASH_MISMATCH",
      `run.contractHash ${run.run.contractHash} != recomputed ${recomputedContractHash}`
    );
  }

  // Lookup maps.
  const itemById = new Map(contractItems.map((it) => [it.itemId, it]));
  const attemptById = new Map(run.attempts.map((a) => [a.attemptId, a]));
  const actionToAttempt = new Map();
  const stateToAttempt = new Map();
  for (const a of run.attempts) {
    for (const act of a.actions) actionToAttempt.set(act.actionId, a.attemptId);
    for (const st of a.stateFingerprints) stateToAttempt.set(st.stateId, a.attemptId);
  }
  const evidenceById = new Map(run.evidence.map((e) => [e.evidenceId, e]));
  const findingById = new Map(run.findings.map((f) => [f.findingId, f]));
  const callById = new Map(run.resources.modelCalls.map((c) => [c.callId, c]));

  // Append-only attempt lineage: per pathId the attempts form ONE unbroken
  // chain. attemptNumber is unique and consecutive from 1; every attempt after
  // the first retries exactly its immediate predecessor (attemptNumber-1 on the
  // same path); the first attempt retries nothing. This rejects forks (two
  // attempts retrying the same parent), duplicate attempt numbers, gaps, and
  // cross-path retries — all of which previously passed because any earlier
  // same-path attempt with a preceding number was accepted.
  const byPath = new Map();
  for (const a of run.attempts) {
    const list = byPath.get(a.pathId) ?? [];
    list.push(a);
    byPath.set(a.pathId, list);
  }
  const pathIds = [...byPath.keys()].sort();
  for (const pathId of pathIds) {
    const list = byPath.get(pathId);
    const seenNumbers = new Set();
    const retriedParents = new Set();
    for (let k = 0; k < list.length; k++) {
      const a = list[k];
      if (seenNumbers.has(a.attemptNumber)) {
        pushErr(
          hard,
          "INTEGRITY_LINEAGE_INVALID",
          `path ${pathId} has two attempts numbered ${a.attemptNumber} (attempt ${a.attemptId}); attemptNumber must be unique per path`
        );
      }
      seenNumbers.add(a.attemptNumber);
      if (a.attemptNumber !== k + 1) {
        pushErr(
          hard,
          "INTEGRITY_LINEAGE_INVALID",
          `attempt ${a.attemptId}: attemptNumber ${a.attemptNumber} is not consecutive (expected ${k + 1}) for path ${pathId}`
        );
      }
      if (k === 0) {
        if (a.retryOfAttemptId !== null) {
          pushErr(
            hard,
            "INTEGRITY_LINEAGE_INVALID",
            `first attempt ${a.attemptId} on path ${pathId} must not retry another attempt`
          );
        }
        if (a.retryReason !== null) {
          pushErr(hard, "INTEGRITY_LINEAGE_INVALID", `first attempt ${a.attemptId} has a retryReason`);
        }
      } else {
        const predecessor = list[k - 1];
        if (a.retryOfAttemptId !== predecessor.attemptId) {
          pushErr(
            hard,
            "INTEGRITY_LINEAGE_INVALID",
            `attempt ${a.attemptId} retries ${a.retryOfAttemptId ?? "nothing"} but its immediate predecessor on path ${pathId} is ${predecessor.attemptId}; retry lineage must be a single unbroken chain`
          );
        }
        if (retriedParents.has(a.retryOfAttemptId)) {
          pushErr(
            hard,
            "INTEGRITY_LINEAGE_INVALID",
            `attempt ${a.attemptId} forks lineage: ${a.retryOfAttemptId} is already retried by another attempt`
          );
        }
        if (a.retryOfAttemptId !== null) retriedParents.add(a.retryOfAttemptId);
        if (a.retryReason === null) {
          pushErr(hard, "INTEGRITY_LINEAGE_INVALID", `retry attempt ${a.attemptId} lacks a retryReason`);
        }
      }
    }
  }
  // Retry targets must exist and belong to the same path.
  const attemptByIdForLineage = new Map(run.attempts.map((a) => [a.attemptId, a]));
  for (const a of run.attempts) {
    if (a.retryOfAttemptId === null) continue;
    const prior = attemptByIdForLineage.get(a.retryOfAttemptId);
    if (!prior) {
      pushErr(
        hard,
        "INTEGRITY_LINEAGE_INVALID",
        `attempt ${a.attemptId} retries unknown attempt ${a.retryOfAttemptId}`
      );
    } else if (prior.pathId !== a.pathId) {
      pushErr(hard, "INTEGRITY_LINEAGE_INVALID", `attempt ${a.attemptId} retries a different path`);
    } else if (prior.attemptNumber !== a.attemptNumber - 1) {
      pushErr(hard, "INTEGRITY_LINEAGE_INVALID", `attempt ${a.attemptId} attemptNumber is not predecessor+1`);
    }
  }

  // Chronology.
  const rt = run.run.timestamps;
  if (!(ts(rt.createdAt) <= ts(rt.startedAt) && ts(rt.startedAt) <= ts(rt.endedAt))) {
    pushErr(hard, "INTEGRITY_CHRONOLOGY_INVALID", "run timestamps are not ordered created<=started<=ended");
  }
  for (const a of run.attempts) {
    const s = ts(a.timestamps.startedAt);
    const e = ts(a.timestamps.endedAt);
    if (!(s <= e)) pushErr(hard, "INTEGRITY_CHRONOLOGY_INVALID", `attempt ${a.attemptId} ends before it starts`);
    if (s < ts(rt.startedAt) || e > ts(rt.endedAt)) {
      pushErr(hard, "INTEGRITY_CHRONOLOGY_INVALID", `attempt ${a.attemptId} lies outside the run window`);
    }
    let lastSeq = -1;
    let lastAt = -Infinity;
    for (const act of a.actions) {
      if (act.sequence <= lastSeq) {
        pushErr(hard, "INTEGRITY_CHRONOLOGY_INVALID", `attempt ${a.attemptId} action sequence not increasing`);
      }
      lastSeq = act.sequence;
      const at = ts(act.occurredAt);
      if (at < lastAt) {
        pushErr(hard, "INTEGRITY_CHRONOLOGY_INVALID", `attempt ${a.attemptId} action times not monotonic`);
      }
      lastAt = at;
      if (at < s || at > e) {
        pushErr(hard, "INTEGRITY_CHRONOLOGY_INVALID", `action ${act.actionId} outside attempt window`);
      }
      for (const ref of [act.beforeStateId, act.afterStateId]) {
        if (ref !== null && stateToAttempt.get(ref) !== a.attemptId) {
          pushErr(hard, "INTEGRITY_LINEAGE_INVALID", `action ${act.actionId} references state ${ref} outside its attempt`);
        }
      }
    }
    let lastStSeq = -1;
    for (const st of a.stateFingerprints) {
      if (st.sequence <= lastStSeq) {
        pushErr(hard, "INTEGRITY_CHRONOLOGY_INVALID", `attempt ${a.attemptId} state sequence not increasing`);
      }
      lastStSeq = st.sequence;
      const at = ts(st.capturedAt);
      if (at < s || at > e) {
        pushErr(hard, "INTEGRITY_CHRONOLOGY_INVALID", `state ${st.stateId} outside attempt window`);
      }
    }
    if (a.stop.lastValidStateId !== null && stateToAttempt.get(a.stop.lastValidStateId) !== a.attemptId) {
      pushErr(hard, "INTEGRITY_LINEAGE_INVALID", `attempt ${a.attemptId} stop.lastValidStateId is not one of its states`);
    }
    for (const t of a.targetItemIds) {
      if (!itemById.has(t)) {
        pushErr(soft, "CROSS_REF_INVALID", `attempt ${a.attemptId} targets unknown contract item ${t}`);
      }
    }
  }

  // Extraction provenance refs.
  for (const ref of run.contract.extraction.modelCallRefs) {
    if (!callById.has(ref)) {
      pushErr(soft, "CROSS_REF_INVALID", `extraction references unknown model call ${ref}`);
    }
  }

  // Item results: exactly one final disposition per contract item.
  const resultByItemId = new Map();
  const droppedResultItemIds = [];
  for (const r of run.itemResults) {
    if (!itemById.has(r.itemId)) {
      pushErr(soft, "CROSS_REF_INVALID", `itemResult references unknown contract item ${r.itemId}; result dropped, no credit`);
      droppedResultItemIds.push(r.itemId);
      continue;
    }
    if (resultByItemId.has(r.itemId)) {
      pushErr(soft, "RESULT_DUPLICATE", `multiple results for contract item ${r.itemId}; extras ignored`);
      continue;
    }
    resultByItemId.set(r.itemId, r);
    for (const ar of r.attemptRefs) {
      if (!attemptById.has(ar)) pushErr(soft, "CROSS_REF_INVALID", `result ${r.itemId} references unknown attempt ${ar}`);
    }
    for (const fr of r.findingRefs) {
      if (!findingById.has(fr)) pushErr(soft, "CROSS_REF_INVALID", `result ${r.itemId} references unknown finding ${fr}`);
    }
    for (const er of r.evidenceRefs) {
      if (!evidenceById.has(er)) {
        pushErr(soft, "EVIDENCE_MISSING", `result ${r.itemId} cites evidence ${er} which is not in the signed registry`);
      }
    }
  }

  const missingResultItemIds = itemIds.filter((id) => !resultByItemId.has(id)).sort();
  if (missingResultItemIds.length > 0) {
    pushErr(
      soft,
      "DENOMINATOR_MISMATCH",
      `contract items without a final result: ${missingResultItemIds.join(", ")}`
    );
  }

  // Findings refs.
  for (const f of run.findings) {
    for (const ir of f.itemRefs) {
      if (!itemById.has(ir)) pushErr(soft, "CROSS_REF_INVALID", `finding ${f.findingId} references unknown item ${ir}`);
    }
    for (const ar of f.attemptRefs) {
      if (!attemptById.has(ar)) pushErr(soft, "CROSS_REF_INVALID", `finding ${f.findingId} references unknown attempt ${ar}`);
    }
    for (const er of f.evidenceRefs) {
      if (!evidenceById.has(er)) {
        pushErr(soft, "EVIDENCE_MISSING", `finding ${f.findingId} cites evidence ${er} which is not in the signed registry`);
      }
    }
  }

  return {
    hard,
    soft,
    index: {
      itemById,
      attemptById,
      actionToAttempt,
      stateToAttempt,
      evidenceById,
      findingById,
      callById,
      resultByItemId,
      missingResultItemIds,
      droppedResultItemIds,
    },
  };
}

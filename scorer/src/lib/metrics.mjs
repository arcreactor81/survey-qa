// Quality and cost metrics (proposal §3/§5/§7 + threat-model §5-§7, §10).
//
//  - extraction accuracy: recall vs the private oracle denominator and
//    precision vs the tester-local checklist (duplicates/extraneous lower it);
//  - reachable coverage: reachable oracle obligations that were matched,
//    exercised, and evidence-sufficient;
//  - seeded-defect recall/precision (one TP max per seeded defect);
//  - evidence completeness over evidence-requiring claims;
//  - report-complete vs test-complete (§7.2) and complete/partial cohorts;
//  - cost per verified coverage unit: authentic recomputed total cost over
//    matched+exercised+evidence-sufficient oracle obligations (§10 —
//    duplicate or unmatched tester items can never lower it);
//  - repeatability: needs multiple runs, out of P0 single-run scope (null).

export function computeMetricsAndCompleteness({
  run,
  oracle,
  index,
  matching,
  defects,
  claims,
  resources,
}) {
  const obligations = oracle.obligations;
  const reachableOracleIds = new Set(
    obligations.filter((o) => o.reachability.status === "reachable").map((o) => o.oracleId)
  );
  const unreachableOracleIds = new Set(
    obligations.filter((o) => o.reachability.status === "unreachable").map((o) => o.oracleId)
  );

  const contractItemCount = run.contract.items.length;
  const oracleCount = obligations.length;

  // ---- verified coverage units ----
  // matched (unambiguously) + exercised + evidence-sufficient, counted on the
  // ORACLE side (one unit max per obligation; duplicates cannot inflate).
  const exercisedVerifiedOracleIds = [];
  const unreachableSupportedOracleIds = [];
  for (const m of matching.matches) {
    const result = index.resultByItemId.get(m.itemId);
    if (!result) continue;
    const sufficient = claims.itemSufficient.get(m.itemId) === true;
    if (result.coverageStatus === "exercised" && sufficient) {
      exercisedVerifiedOracleIds.push(m.oracleId);
    }
    if (
      result.coverageStatus === "proven-unreachable" &&
      sufficient &&
      unreachableOracleIds.has(m.oracleId)
    ) {
      unreachableSupportedOracleIds.push(m.oracleId);
    }
  }
  const exercisedVerifiedSet = new Set(exercisedVerifiedOracleIds);
  const verifiedCoverageUnits = exercisedVerifiedSet.size;

  const reachableCovered = [...exercisedVerifiedSet].filter((id) => reachableOracleIds.has(id));

  // ---- report completeness (tester-local denominator) ----
  const accountedItems = contractItemCount - index.missingResultItemIds.length;
  const reportCompleteness = contractItemCount === 0 ? 1 : accountedItems / contractItemCount;
  const reportComplete = index.missingResultItemIds.length === 0;

  // ---- test completeness (§7.2), FULL oracle denominator ----
  // Every oracle obligation must be accounted for:
  //  - reachable   => matched, exercised and evidence-sufficient;
  //  - unreachable => matched with a supported proven-unreachable claim.
  // An unreachable obligation the report never extracted at all (no matched
  // item, hence no claim) leaves the oracle denominator unaccounted and makes
  // the test partial — omitting hard items can never buy completeness.
  const unreachableSupportedSet = new Set(unreachableSupportedOracleIds);
  const allReachableExercised = [...reachableOracleIds].every((id) => exercisedVerifiedSet.has(id));
  const allUnreachableAccounted = [...unreachableOracleIds].every((id) =>
    unreachableSupportedSet.has(id)
  );
  const unaccountedOracleIds = [
    ...[...reachableOracleIds].filter((id) => !exercisedVerifiedSet.has(id)),
    ...[...unreachableOracleIds].filter((id) => !unreachableSupportedSet.has(id)),
  ].sort();
  const unreachableClaimsOk = [...index.resultByItemId.values()]
    .filter((r) => r.coverageStatus === "proven-unreachable")
    .every((r) => claims.itemSufficient.get(r.itemId) === true);
  const partialStatuses = ["blocked", "not-reached", "budget-exhausted", "time-exhausted", "pending"];
  const hasPartialStatus = [...index.resultByItemId.values()].some((r) =>
    partialStatuses.includes(r.coverageStatus)
  );
  const testComplete =
    reportComplete &&
    allReachableExercised &&
    allUnreachableAccounted &&
    unreachableClaimsOk &&
    !hasPartialStatus &&
    matching.ambiguous.length === 0;
  const cohort = testComplete ? "complete" : "partial";

  // ---- metric values ----
  const matchedOracleCount = matching.matches.length;
  const extractionRecall = oracleCount === 0 ? null : matchedOracleCount / oracleCount;
  const extractionPrecision = contractItemCount === 0 ? null : matchedOracleCount / contractItemCount;
  const reachableCoverage =
    reachableOracleIds.size === 0 ? null : reachableCovered.length / reachableOracleIds.size;

  const seededTotal = oracle.seededDefects.length;
  const seededDefectRecall = seededTotal === 0 ? null : defects.truePositives.length / seededTotal;
  // Redundant duplicate findings leave the denominator (advisory i): honest
  // duplicate reporting neither inflates recall nor is punished as a fabrication.
  const precisionDenominator = defects.precisionDenominator ?? defects.assertedCount;
  const seededDefectPrecision =
    precisionDenominator === 0 ? null : defects.truePositives.length / precisionDenominator;

  const evidenceCompleteness =
    claims.requiredClaims === 0 ? null : claims.sufficientClaims / claims.requiredClaims;

  const costPerVerifiedCoverageUnit =
    resources.costKnown && verifiedCoverageUnits > 0
      ? run.resources.totals.totalCostUsd / verifiedCoverageUnits
      : null;

  return {
    completeness: {
      reportComplete,
      reportCompleteness,
      unaccountedItemIds: [...index.missingResultItemIds],
      testComplete,
      oracleObligations: oracleCount,
      oracleObligationsAccounted: oracleCount - unaccountedOracleIds.length,
      unaccountedOracleIds,
      cohort,
    },
    metrics: {
      extractionRecall,
      extractionPrecision,
      reachableCoverage,
      reachableObligations: reachableOracleIds.size,
      reachableExercisedVerified: reachableCovered.length,
      seededDefectRecall,
      seededDefectPrecision,
      seededDefectsTotal: seededTotal,
      assertedDefectFindings: defects.assertedCount,
      redundantDefectFindings: defects.redundant ? defects.redundant.length : 0,
      defectPrecisionDenominator: precisionDenominator,
      evidenceCompleteness,
      reportCompleteness,
      verifiedCoverageUnits,
      costPerVerifiedCoverageUnit,
      costCohort: cohort,
      repeatability: null, // requires multiple runs; out of P0 single-run scope
    },
  };
}

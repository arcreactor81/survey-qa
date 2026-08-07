// Finding-to-defect matching (threat-model §6).
//
// A finding of kind "defect" matches a seeded defect only when:
//   1. >=1 referenced tester item maps to an oracle obligation in the
//      defect's affectedObligationIds;
//   2. the finding's expected/observed meanings are compatible with the
//      defect's expected/observed requirements (local lexical similarity —
//      category may support but never substitutes for semantic agreement);
//   3. cited evidence passed integrity + sufficiency (checked upstream and
//      passed in via findingSufficient).
//
// Candidates are resolved one-to-one (same max-weight assignment machinery),
// under a pinned defect-matcher profile. Ambiguity is GLOBAL-assignment aware,
// exactly as in matcher.mjs §5.3: a pair is ambiguous only when forbidding it
// still admits an alternate global assignment within the margin that maps the
// finding onto a DIFFERENT seeded defect. One seeded defect yields at most one
// true positive.
//
// Duplicate findings (§6 + advisory i): when several valid findings match the
// same seeded defect, exactly ONE is the true positive and the rest are
// classified REDUNDANT — flagged, but neither true positives nor false
// positives, and removed from the precision denominator so that honest
// duplicate reporting can neither inflate recall nor be punished as a
// fabricated defect.
//
// Clean targets (§6 + defect 6): EVERY asserted defect finding is a false
// positive unless an approved, versioned scorer-side oracle correction exists.
// That classification is an audit judgement about the assertion, so it does
// NOT depend on the evidence state: an unsupported assertion on a clean target
// is still a false positive (it is additionally listed under `unsupported`).

import { stringSim, maxWeightAssignment } from "./matcher.mjs";

export const DEFECT_MATCHER_PROFILE = Object.freeze({
  defectMatcherVersion: "survey-qa-scorer-defect-matcher/1.1.0",
  weights: Object.freeze({ expected: 0.5, observed: 0.5 }),
  minSideSimilarity: 0.3,
  eligibilityThreshold: 0.45,
  ambiguityMargin: 0.05,
  ambiguityRule: "alternate-global-assignment-within-margin",
  duplicatePolicy: "one-true-positive-rest-redundant",
  assignment: "hungarian-max-weight-one-to-one",
  // Approved, versioned scorer-side oracle corrections for clean targets
  // (§6, §12 policy flag 1). Empty in P0: no correction is approved, so every
  // asserted clean-target defect is a false positive.
  approvedCleanTargetCorrections: Object.freeze([]),
});

const TOTAL_EPS = 1e-9;

function round6(x) {
  return Number(x.toFixed(6));
}

function solveAssignment(scores, nR, nC, forbidden) {
  if (nR === 0 || nC === 0) return { pairs: [], total: 0 };
  let matrix = scores;
  if (forbidden) {
    matrix = scores.map((row, i) =>
      i === forbidden.i ? row.map((s, j) => (j === forbidden.j ? 0 : s)) : row
    );
  }
  const raw = maxWeightAssignment(matrix, nR, nC);
  const pairs = [];
  let total = 0;
  for (const [i, j] of raw) {
    const s = matrix[i][j];
    if (s >= DEFECT_MATCHER_PROFILE.eligibilityThreshold) {
      pairs.push({ i, j, score: s });
      total += s;
    }
  }
  pairs.sort((a, b) => a.i - b.i);
  return { pairs, total };
}

/**
 * @param findings        run.findings
 * @param seededDefects   oracle.seededDefects
 * @param itemToOracle    Map(itemId -> oracleId) from unambiguous matching
 * @param findingSufficient Map(findingId -> boolean) evidence gate
 * @param cleanTarget     true when the oracle variant is clean
 */
export function matchDefects({ findings, seededDefects, itemToOracle, findingSufficient, cleanTarget }) {
  const profile = DEFECT_MATCHER_PROFILE;
  const asserted = findings.filter((f) => f.kind === "defect");
  const unsupported = asserted
    .filter((f) => findingSufficient.get(f.findingId) === false)
    .map((f) => f.findingId);
  const eligibleFindings = asserted.filter((f) => findingSufficient.get(f.findingId) !== false);

  // On clean targets every asserted defect is a false positive (§6) —
  // including evidence-insufficient ones, which are an audit finding about the
  // assertion itself. Ambiguities/blockers are separate kinds and never become
  // defect FPs.
  if (cleanTarget || seededDefects.length === 0) {
    const corrected = new Set(profile.approvedCleanTargetCorrections);
    const falsePositives = asserted
      .map((f) => f.findingId)
      .filter((id) => !corrected.has(id))
      .sort();
    return {
      truePositives: [],
      falsePositives,
      redundant: [],
      unsupported: unsupported.sort(),
      falseNegatives: seededDefects.map((d) => d.defectId).sort(),
      ambiguous: [],
      assertedCount: asserted.length,
      precisionDenominator: asserted.length,
    };
  }

  const nR = eligibleFindings.length;
  const nC = seededDefects.length;
  const scores = [];
  for (let i = 0; i < nR; i++) {
    const f = eligibleFindings[i];
    const mappedOracleIds = new Set(
      f.itemRefs.map((id) => itemToOracle.get(id)).filter((x) => x !== undefined)
    );
    const row = new Array(nC).fill(0);
    for (let j = 0; j < nC; j++) {
      const d = seededDefects[j];
      const touches = d.affectedObligationIds.some((o) => mappedOracleIds.has(o));
      if (!touches) continue; // condition 1
      const expSim = stringSim(f.expected, d.expected.requirement);
      const obsSim = stringSim(f.observed, d.observed.requirement);
      if (expSim < profile.minSideSimilarity || obsSim < profile.minSideSimilarity) continue;
      const s = profile.weights.expected * expSim + profile.weights.observed * obsSim;
      if (s >= profile.eligibilityThreshold) row[j] = s;
    }
    scores.push(row);
  }

  const optimal = solveAssignment(scores, nR, nC, null);

  const truePositives = [];
  const ambiguous = [];
  const margin = profile.ambiguityMargin;
  for (const { i, j, score } of optimal.pairs) {
    const alternate = solveAssignment(scores, nR, nC, { i, j });
    const altPair = alternate.pairs.find((p) => p.i === i);
    const withinMargin = optimal.total - alternate.total <= margin + TOTAL_EPS;
    if (withinMargin && altPair) {
      ambiguous.push({
        findingId: eligibleFindings[i].findingId,
        assignedDefectId: seededDefects[j].defectId,
        assignedScore: round6(score),
        margin,
        optimalTotal: round6(optimal.total),
        alternateTotal: round6(alternate.total),
        alternateDefectId: seededDefects[altPair.j].defectId,
        candidates: [
          { defectId: seededDefects[j].defectId, score: round6(score) },
          { defectId: seededDefects[altPair.j].defectId, score: round6(altPair.score) },
        ],
      });
    } else {
      truePositives.push({
        findingId: eligibleFindings[i].findingId,
        defectId: seededDefects[j].defectId,
        score: round6(score),
      });
    }
  }

  const tpFindingIds = new Set(truePositives.map((t) => t.findingId));
  const ambiguousFindingIds = new Set(ambiguous.map((a) => a.findingId));
  const tpDefectIdToFinding = new Map(truePositives.map((t) => [t.defectId, t.findingId]));

  // Advisory (i): a second valid finding for an already-credited seeded defect
  // is REDUNDANT, not a false positive. It earns no extra recall and does not
  // count against precision; it is flagged for the report.
  const redundant = [];
  const falsePositives = [];
  for (let i = 0; i < nR; i++) {
    const f = eligibleFindings[i];
    if (tpFindingIds.has(f.findingId) || ambiguousFindingIds.has(f.findingId)) continue;
    let bestJ = -1;
    let bestScore = 0;
    for (let j = 0; j < nC; j++) {
      const s = scores[i][j];
      if (s >= profile.eligibilityThreshold && s > bestScore && tpDefectIdToFinding.has(seededDefects[j].defectId)) {
        bestScore = s;
        bestJ = j;
      }
    }
    if (bestJ >= 0) {
      redundant.push({
        findingId: f.findingId,
        defectId: seededDefects[bestJ].defectId,
        duplicateOfFindingId: tpDefectIdToFinding.get(seededDefects[bestJ].defectId),
        score: round6(bestScore),
      });
    } else {
      falsePositives.push(f.findingId);
    }
  }

  const tpDefectIds = new Set(truePositives.map((t) => t.defectId));
  const falseNegatives = seededDefects
    .map((d) => d.defectId)
    .filter((id) => !tpDefectIds.has(id))
    .sort();

  truePositives.sort((a, b) => (a.findingId < b.findingId ? -1 : 1));
  ambiguous.sort((a, b) => (a.findingId < b.findingId ? -1 : 1));
  redundant.sort((a, b) => (a.findingId < b.findingId ? -1 : 1));
  falsePositives.sort();

  return {
    truePositives,
    falsePositives,
    redundant,
    unsupported: unsupported.sort(),
    falseNegatives,
    ambiguous,
    assertedCount: asserted.length,
    // Redundant duplicates leave the precision denominator (advisory i).
    precisionDenominator: asserted.length - redundant.length,
  };
}

#!/usr/bin/env node
// calibration-pins.mjs — the calibration regression net (audit finding 11).
//
// WHY THIS FILE EXISTS
// The audit measured that every calibration constant in the scorer was asserted
// by no test: only the version STRINGS were pinned. Threshold mutants were
// invisible across a wide band, and inside that band they materially changed
// real scores (extraction recall 0.944 -> 0.778, defect recall 0.333 -> 0).
// The in-flight fix round revises exactly these constants, so without this file
// a reverted fix is indistinguishable from a working one.
//
// WHAT IT PINS — two layers, deliberately redundant:
//
//   1. THE FROZEN PROFILE OBJECTS, whole, as exact JSON. Not the version
//      string: the entire object, so no number can move without this file
//      moving with it.
//
//      *** CHANGING ANY NUMBER BELOW REQUIRES BUMPING THE MATCHING VERSION  ***
//      *** STRING IN THE SAME COMMIT. The version string is INSIDE the      ***
//      *** pinned literal, so a value change with a stale version fails      ***
//      *** here by construction.                                            ***
//
//   2. BOUNDARY FIXTURES either side of every threshold, so the numbers have
//      behavioural meaning rather than being a copied constant. Each pair is
//      one input just below the cut and one just above, with the measured
//      scores asserted to bracket the constant — so a threshold move in either
//      direction flips an observable outcome, not just a literal.
//
// Exits non-zero on any mismatch. Pure library-level: no fixture files, no
// wall clock, no network.

import {
  MATCHER_PROFILE,
  LOCATOR_RULES,
  stringSim,
  scorePair,
  assignWithAmbiguity,
  matchObligations,
} from "../src/lib/matcher.mjs";
import { DEFECT_MATCHER_PROFILE, matchDefects } from "../src/lib/defect-match.mjs";
import { PRICING } from "../src/lib/resources.mjs";
import { EVIDENCE_POLICY_VERSION, EVIDENCE_REQUIRED_STATUSES } from "../src/lib/evidence.mjs";
import { SCORECARD_VERSION } from "../src/score-run.mjs";

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

/* ======================================================================== */
/* 1. FROZEN PROFILE OBJECTS — exact, whole, version string included.        */
/* ======================================================================== */

const PINNED_MATCHER_PROFILE =
  '{"matcherVersion":"survey-qa-scorer-matcher/1.1.0",' +
  '"normalization":"nfkc-casefold-ws-punct-operators-signednumbers/2",' +
  '"locatorCanonicalization":"pinned-locator-rules/1",' +
  '"locatorRules":[' +
  '{"id":"question","words":"questions|question|ques|qn|q","canonical":"q"},' +
  '{"id":"screener","words":"screeners|screener|scr|s","canonical":"s"},' +
  '{"id":"section","words":"sections|section|sect|sec","canonical":"sec"},' +
  '{"id":"loop","words":"loops|loop|l","canonical":"l"},' +
  '{"id":"block","words":"blocks|block|blk|b","canonical":"b"},' +
  '{"id":"page","words":"pages|page|pg|p","canonical":"p"},' +
  '{"id":"grid","words":"grids|grid|gr","canonical":"grid"},' +
  '{"id":"item","words":"items|item|itm","canonical":"item"},' +
  '{"id":"rule","words":"rule","canonical":"rule"}],' +
  '"semanticModel":null,' +
  '"weights":{"anchor":0.45,"requirement":0.55,"anchorLocator":0.6,"anchorQuote":0.4,"jaccard":0.5,"levenshtein":0.5},' +
  '"eligibilityThreshold":0.55,' +
  '"ambiguityMargin":0.05,' +
  '"ambiguityRule":"alternate-global-assignment-within-margin",' +
  '"duplicateThreshold":0.95,' +
  '"assignment":"hungarian-max-weight-one-to-one"}';

const PINNED_DEFECT_MATCHER_PROFILE =
  '{"defectMatcherVersion":"survey-qa-scorer-defect-matcher/1.1.0",' +
  '"weights":{"expected":0.5,"observed":0.5},' +
  '"minSideSimilarity":0.3,' +
  '"eligibilityThreshold":0.45,' +
  '"ambiguityMargin":0.05,' +
  '"ambiguityRule":"alternate-global-assignment-within-margin",' +
  '"duplicatePolicy":"one-true-positive-rest-redundant",' +
  '"assignment":"hungarian-max-weight-one-to-one",' +
  '"approvedCleanTargetCorrections":[]}';

const PINNED_PRICING =
  '{"version":"fixture-pricing/2026-08-01","currency":"USD","models":{' +
  '"fixture-ai/overseer":{"inputPerMTok":3,"cachedInputPerMTok":0.3,"outputPerMTok":15},' +
  '"fixture-ai/navigator":{"inputPerMTok":0.25,"cachedInputPerMTok":0.025,"outputPerMTok":1.25}}}';

function profilePins() {
  check(
    "pin MATCHER_PROFILE (whole object)",
    JSON.stringify(MATCHER_PROFILE) === PINNED_MATCHER_PROFILE,
    `got ${JSON.stringify(MATCHER_PROFILE)}`
  );
  check(
    "pin DEFECT_MATCHER_PROFILE (whole object)",
    JSON.stringify(DEFECT_MATCHER_PROFILE) === PINNED_DEFECT_MATCHER_PROFILE,
    `got ${JSON.stringify(DEFECT_MATCHER_PROFILE)}`
  );
  check("pin PRICING (whole table)", JSON.stringify(PRICING) === PINNED_PRICING, `got ${JSON.stringify(PRICING)}`);
  check(
    "pin EVIDENCE_POLICY_VERSION",
    EVIDENCE_POLICY_VERSION === "survey-qa-scorer-evidence-policy/1.1.0",
    `got ${EVIDENCE_POLICY_VERSION}`
  );
  check(
    "pin EVIDENCE_REQUIRED_STATUSES",
    JSON.stringify(EVIDENCE_REQUIRED_STATUSES) ===
      '["exercised","blocked","budget-exhausted","time-exhausted","proven-unreachable"]',
    `got ${JSON.stringify(EVIDENCE_REQUIRED_STATUSES)}`
  );
  check("pin SCORECARD_VERSION", SCORECARD_VERSION === "1.0.0", `got ${SCORECARD_VERSION}`);

  // The profiles are the published contract: they must be immutable at runtime,
  // so a caller cannot retune the scorer mid-run.
  check("MATCHER_PROFILE is frozen", Object.isFrozen(MATCHER_PROFILE), "profile must be frozen");
  check("MATCHER_PROFILE.weights is frozen", Object.isFrozen(MATCHER_PROFILE.weights), "weights must be frozen");
  check("LOCATOR_RULES is frozen", Object.isFrozen(LOCATOR_RULES) && LOCATOR_RULES.every(Object.isFrozen), "rules must be frozen");
  check(
    "DEFECT_MATCHER_PROFILE is frozen",
    Object.isFrozen(DEFECT_MATCHER_PROFILE) && Object.isFrozen(DEFECT_MATCHER_PROFILE.weights),
    "profile must be frozen"
  );
  check("PRICING is frozen", Object.isFrozen(PRICING) && Object.isFrozen(PRICING.models), "pricing must be frozen");

  // Internal coherence the numbers must keep whatever their values become.
  const mw = MATCHER_PROFILE.weights;
  check("matcher anchor+requirement weights sum to 1", Math.abs(mw.anchor + mw.requirement - 1) < 1e-12, `${mw.anchor}+${mw.requirement}`);
  check("matcher anchor sub-weights sum to 1", Math.abs(mw.anchorLocator + mw.anchorQuote - 1) < 1e-12, `${mw.anchorLocator}+${mw.anchorQuote}`);
  check("matcher similarity blend sums to 1", Math.abs(mw.jaccard + mw.levenshtein - 1) < 1e-12, `${mw.jaccard}+${mw.levenshtein}`);
  const dw = DEFECT_MATCHER_PROFILE.weights;
  check("defect side weights sum to 1", Math.abs(dw.expected + dw.observed - 1) < 1e-12, `${dw.expected}+${dw.observed}`);
  check(
    "defect per-side floor is below the combined threshold",
    DEFECT_MATCHER_PROFILE.minSideSimilarity < DEFECT_MATCHER_PROFILE.eligibilityThreshold,
    "a floor above the threshold would make the threshold unreachable"
  );
}

/* ======================================================================== */
/* 2. BOUNDARY FIXTURES — one input either side of every threshold.          */
/* ======================================================================== */

/* ---- 2a. matcher eligibilityThreshold (0.55) --------------------------- */
// Entry point: assignWithAmbiguity applies the threshold to raw candidate
// scores, so the straddle is exact to 1e-4 rather than approximated by text.
function matcherEligibilityBoundary() {
  const T = MATCHER_PROFILE.eligibilityThreshold;
  const justAbove = Number((T + 0.0001).toFixed(6));
  const justBelow = Number((T - 0.0001).toFixed(6));

  const above = assignWithAmbiguity([[justAbove]], 1, 1);
  const below = assignWithAmbiguity([[justBelow]], 1, 1);
  check(
    `eligibility boundary: ${justAbove} (just above ${T}) is MATCHED`,
    above.matched.length === 1 && above.ambiguous.length === 0,
    JSON.stringify(above)
  );
  check(
    `eligibility boundary: ${justBelow} (just below ${T}) is NOT matched`,
    below.matched.length === 0 && below.ambiguous.length === 0,
    JSON.stringify(below)
  );
  check(
    "eligibility boundary brackets the constant",
    justBelow < T && T <= justAbove,
    `${justBelow} < ${T} <= ${justAbove}`
  );

  // The same cut, reached through the real text path: a tester item whose
  // score lands either side of the threshold is credited or not.
  const obligation = {
    oracleId: "ORC-B1",
    type: "question",
    sourceAnchor: { locator: "Q7", quote: "Q7. How often do you use the product?", aliases: [] },
    requirement: "Q7 usage-frequency question is shown with five ordered options",
  };
  const near = {
    itemId: "T-NEAR",
    type: "question",
    sourceAnchor: { locator: "Q7", quote: "Q7. How often do you use the product?", aliases: [] },
    requirement: "Q7 usage frequency question is shown with five ordered options",
  };
  const far = {
    itemId: "T-FAR",
    type: "question",
    sourceAnchor: { locator: "Q19", quote: "Q19. Which region do you live in?", aliases: [] },
    requirement: "Q19 region question offers a dropdown of territories",
  };
  const nearScore = scorePair(near, obligation);
  const farScore = scorePair(far, obligation);
  check(
    "text-path straddle: paraphrase scores above the cut, unrelated item below",
    nearScore >= T && farScore < T,
    `near=${nearScore.toFixed(6)} far=${farScore.toFixed(6)} threshold=${T}`
  );
  const m = matchObligations([near, far], [obligation]);
  check(
    "text-path straddle: only the above-cut item is matched",
    m.matches.length === 1 && m.matches[0].itemId === "T-NEAR" && m.unmatchedTesterItemIds.includes("T-FAR"),
    JSON.stringify(m.matches)
  );
}

/* ---- 2b. matcher ambiguityMargin (0.05) -------------------------------- */
// Construction: scores [[x, x-d], [x, x]]. The optimum is x+x; forbidding the
// (0,0) edge yields (x-d)+x, so the optimum/alternate gap is exactly d and the
// item is genuinely remapped. d either side of the margin flips the verdict.
function matcherAmbiguityBoundary() {
  const M = MATCHER_PROFILE.ambiguityMargin;
  const x = 0.8;
  const mk = (d) => assignWithAmbiguity([[x, Number((x - d).toFixed(6))], [x, x]], 2, 2);

  const inside = mk(Number((M - 0.001).toFixed(6)));
  const outside = mk(Number((M + 0.001).toFixed(6)));
  check(
    `ambiguity boundary: gap ${(M - 0.001).toFixed(3)} (inside ${M}) IS ambiguous`,
    inside.ambiguous.length > 0,
    JSON.stringify(inside)
  );
  check(
    `ambiguity boundary: gap ${(M + 0.001).toFixed(3)} (outside ${M}) is NOT ambiguous`,
    outside.ambiguous.length === 0 && outside.matched.length === 2,
    JSON.stringify(outside)
  );
  // A pair on the wrong side of the margin must still be CREDITED, not silently
  // dropped: widening the margin must cost credit, not invent it.
  check(
    "outside the margin the pair is credited as a match",
    outside.matched.some((p) => p.i === 0 && p.j === 0),
    JSON.stringify(outside.matched)
  );
}

/* ---- 2c. matcher duplicateThreshold (0.95) ----------------------------- */
// Duplicate similarity = 0.5*requirement + 0.5*anchor. With identical anchors
// the anchor term is exactly 1, so the pair straddles by requirement text.
function duplicateThresholdBoundary() {
  const T = MATCHER_PROFILE.duplicateThreshold;
  const anchor = { locator: "Q4", quote: "Q4. Which brands are you aware of?", aliases: [] };
  const base = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
  const nearlyIdentical = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda pi"; // 1 of 12 changed
  const clearlyDifferent = "mu beta gamma delta epsilon zeta eta theta iota kappa"; // 2 of 10 changed

  const simOf = (a, b) => 0.5 * stringSim(a, b) + 0.5 * 1;
  const simAbove = simOf(base, nearlyIdentical);
  const simBelow = simOf(base, clearlyDifferent);
  check(
    "duplicate boundary brackets the constant",
    simBelow < T && T <= simAbove,
    `below=${simBelow.toFixed(6)} threshold=${T} above=${simAbove.toFixed(6)}`
  );

  const mkItem = (id, requirement) => ({ itemId: id, type: "question", sourceAnchor: anchor, requirement });
  const obligations = [
    { oracleId: "ORC-D1", type: "question", sourceAnchor: anchor, requirement: base },
  ];
  const dupRun = matchObligations([mkItem("T-A", base), mkItem("T-B", nearlyIdentical)], obligations);
  check(
    "duplicate boundary: above the cut, the second item is flagged DUPLICATE",
    dupRun.duplicates.length === 1 && dupRun.duplicates[0].itemId === "T-B",
    JSON.stringify(dupRun.duplicates)
  );
  const distinctRun = matchObligations([mkItem("T-A", base), mkItem("T-C", clearlyDifferent)], obligations);
  check(
    "duplicate boundary: below the cut, both items stay distinct",
    distinctRun.duplicates.length === 0,
    JSON.stringify(distinctRun.duplicates)
  );
}

/* ---- 2d. defect matcher: minSideSimilarity (0.3) ----------------------- */
// The per-side floor is the only thing preventing a finding that restates the
// specification and says nothing true about what was observed from matching on
// its expected side alone (audit finding 1). These two cases differ ONLY in the
// observed side; the combined score clears the threshold in BOTH.
const DEF_OBLIGATION_ID = "ORC-DEF-1";
const DEF_ITEM_ID = "T-DEF-1";
const defSeeded = (expected, observed) => [
  {
    defectId: "D-1",
    affectedObligationIds: [DEF_OBLIGATION_ID],
    expected: { requirement: expected },
    observed: { requirement: observed },
  },
];
function runDefects(finding, seeded) {
  return matchDefects({
    findings: [finding],
    seededDefects: seeded,
    itemToOracle: new Map([[DEF_ITEM_ID, DEF_OBLIGATION_ID]]),
    findingSufficient: new Map([[finding.findingId, true]]),
    cleanTarget: false,
  });
}

function defectSideFloorBoundary() {
  const P = DEFECT_MATCHER_PROFILE;
  const expectedRef = "alpha beta gamma delta";
  const observedRef = "alpha beta gamma delta";

  // observed side ~0.39: above the 0.3 floor.
  const observedAbove = "alpha zeta eta theta";
  // observed side ~0.23: below the 0.3 floor, and NOTHING else changes.
  const observedBelow = "zeta eta theta iota";

  const sAbove = stringSim(observedAbove, observedRef);
  const sBelow = stringSim(observedBelow, observedRef);
  check(
    "side-floor boundary brackets the constant",
    sBelow < P.minSideSimilarity && P.minSideSimilarity <= sAbove,
    `below=${sBelow.toFixed(6)} floor=${P.minSideSimilarity} above=${sAbove.toFixed(6)}`
  );
  // Both cases clear the COMBINED threshold, so only the floor can separate them.
  const combined = (o) => P.weights.expected * 1 + P.weights.observed * stringSim(o, observedRef);
  check(
    "side-floor boundary: both cases clear the combined threshold",
    combined(observedAbove) >= P.eligibilityThreshold && combined(observedBelow) >= P.eligibilityThreshold,
    `above=${combined(observedAbove).toFixed(6)} below=${combined(observedBelow).toFixed(6)}`
  );

  const mkFinding = (observed) => ({
    findingId: "F-1",
    kind: "defect",
    expected: expectedRef,
    observed,
    itemRefs: [DEF_ITEM_ID],
  });
  const seeded = defSeeded(expectedRef, observedRef);
  const above = runDefects(mkFinding(observedAbove), seeded);
  const below = runDefects(mkFinding(observedBelow), seeded);
  check(
    "side-floor boundary: observed side above the floor is a TRUE POSITIVE",
    above.truePositives.length === 1,
    JSON.stringify(above)
  );
  check(
    "side-floor boundary: observed side below the floor is a FALSE POSITIVE",
    below.truePositives.length === 0 && below.falsePositives.length === 1,
    JSON.stringify(below)
  );
}

/* ---- 2e. defect matcher: eligibilityThreshold (0.45) ------------------- */
// Both sides clear the 0.3 floor in BOTH cases, so only the combined threshold
// can separate them.
function defectEligibilityBoundary() {
  const P = DEFECT_MATCHER_PROFILE;
  const expectedRef = "alpha beta gamma delta";
  const observedRef = "alpha beta gamma delta";
  const observedSide = "alpha zeta eta theta"; // ~0.39, above the floor

  const expectedAbove = "alpha beta gamma epsilon"; // ~0.675
  const expectedBelow = "alpha beta zeta epsilon"; // ~0.449, still above the 0.3 floor

  const comb = (e) => P.weights.expected * stringSim(e, expectedRef) + P.weights.observed * stringSim(observedSide, observedRef);
  check(
    "defect threshold boundary brackets the constant",
    comb(expectedBelow) < P.eligibilityThreshold && P.eligibilityThreshold <= comb(expectedAbove),
    `below=${comb(expectedBelow).toFixed(6)} threshold=${P.eligibilityThreshold} above=${comb(expectedAbove).toFixed(6)}`
  );
  check(
    "defect threshold boundary: both cases clear the per-side floor",
    stringSim(expectedBelow, expectedRef) >= P.minSideSimilarity &&
      stringSim(observedSide, observedRef) >= P.minSideSimilarity,
    `expected=${stringSim(expectedBelow, expectedRef).toFixed(6)} observed=${stringSim(observedSide, observedRef).toFixed(6)}`
  );

  const mkFinding = (expected) => ({
    findingId: "F-1",
    kind: "defect",
    expected,
    observed: observedSide,
    itemRefs: [DEF_ITEM_ID],
  });
  const seeded = defSeeded(expectedRef, observedRef);
  const above = runDefects(mkFinding(expectedAbove), seeded);
  const below = runDefects(mkFinding(expectedBelow), seeded);
  check(
    "defect threshold boundary: above the cut is a TRUE POSITIVE",
    above.truePositives.length === 1,
    JSON.stringify(above)
  );
  check(
    "defect threshold boundary: below the cut is a FALSE POSITIVE",
    below.truePositives.length === 0 && below.falsePositives.length === 1,
    JSON.stringify(below)
  );
}

/* ---- 2f. defect matcher: ambiguityMargin (0.05) ------------------------ */
// Two findings, two seeded defects on the same obligation, arranged so the
// optimum and the best alternate differ by a controlled gap. The gap is
// measured here rather than assumed, so the assertion stays honest if the
// similarity function changes.
function defectAmbiguityBoundary() {
  const P = DEFECT_MATCHER_PROFILE;
  // Deterministic synthetic token strings: a base of N tokens and a near-twin
  // with ONE token replaced. The similarity of the twin rises with N, so N is
  // the dial that puts the optimum/alternate gap either side of the margin.
  // N=60 -> gap ~0.0447 (inside 0.05); N=50 -> gap ~0.0535 (outside).
  const tokens = (n) => [...Array(n)].map((_, i) => "tok" + String(i + 1).padStart(3, "0"));
  const baseOf = (n) => tokens(n).join(" ");
  const twinOf = (n) => {
    const t = tokens(n);
    t[Math.floor(n / 2)] = "zzz" + String(n).padStart(3, "0");
    return t.join(" ");
  };
  const A_INSIDE = baseOf(60);
  const B_INSIDE = twinOf(60);
  const A_OUTSIDE = baseOf(50);
  const B_OUTSIDE = twinOf(50);

  const mk = (A, other) => {
    const findings = [
      { findingId: "F-1", kind: "defect", expected: A, observed: A, itemRefs: [DEF_ITEM_ID] },
      { findingId: "F-2", kind: "defect", expected: other, observed: other, itemRefs: [DEF_ITEM_ID] },
    ];
    const seeded = [
      {
        defectId: "D-1",
        affectedObligationIds: [DEF_OBLIGATION_ID],
        expected: { requirement: A },
        observed: { requirement: A },
      },
      {
        defectId: "D-2",
        affectedObligationIds: [DEF_OBLIGATION_ID],
        expected: { requirement: other },
        observed: { requirement: other },
      },
    ];
    return matchDefects({
      findings,
      seededDefects: seeded,
      itemToOracle: new Map([[DEF_ITEM_ID, DEF_OBLIGATION_ID]]),
      findingSufficient: new Map([
        ["F-1", true],
        ["F-2", true],
      ]),
      cleanTarget: false,
    });
  };

  // Gap between the optimal assignment (1.0 + 1.0) and the best alternate
  // (sim + sim) is 2 * (1 - sim).
  const gapFor = (a, b) => 2 * (1 - stringSim(a, b));
  const gapInside = gapFor(A_INSIDE, B_INSIDE);
  const gapOutside = gapFor(A_OUTSIDE, B_OUTSIDE);
  check(
    "defect ambiguity boundary brackets the constant",
    gapInside < P.ambiguityMargin && P.ambiguityMargin <= gapOutside,
    `inside=${gapInside.toFixed(6)} margin=${P.ambiguityMargin} outside=${gapOutside.toFixed(6)}`
  );
  const inside = mk(A_INSIDE, B_INSIDE);
  const outside = mk(A_OUTSIDE, B_OUTSIDE);
  check(
    "defect ambiguity boundary: inside the margin, nothing is credited automatically",
    inside.ambiguous.length > 0 && inside.truePositives.length < 2,
    JSON.stringify({ ambiguous: inside.ambiguous.length, tp: inside.truePositives.length })
  );
  check(
    "defect ambiguity boundary: outside the margin, both findings are credited",
    outside.ambiguous.length === 0 && outside.truePositives.length === 2,
    JSON.stringify({ ambiguous: outside.ambiguous.length, tp: outside.truePositives.length })
  );
}

/* ---- 2g. pricing table: the numbers actually price a call -------------- */
function pricingBoundary() {
  // A concrete, hand-computable reconciliation: 1e6 input + 1e6 cached +
  // 1e6 output on the overseer model must cost exactly 3.0 + 0.3 + 15.0.
  const rates = PRICING.models["fixture-ai/overseer"];
  const expected = rates.inputPerMTok + rates.cachedInputPerMTok + rates.outputPerMTok;
  check("pricing: overseer unit-cost arithmetic", Math.abs(expected - 18.3) < 1e-12, `got ${expected}`);
  const nav = PRICING.models["fixture-ai/navigator"];
  check(
    "pricing: cached input is an order of magnitude cheaper than fresh input",
    Math.abs(rates.inputPerMTok / rates.cachedInputPerMTok - 10) < 1e-9 &&
      Math.abs(nav.inputPerMTok / nav.cachedInputPerMTok - 10) < 1e-9,
    `overseer=${rates.inputPerMTok / rates.cachedInputPerMTok} navigator=${nav.inputPerMTok / nav.cachedInputPerMTok}`
  );
}

/* -------------------------------- main ---------------------------------- */

profilePins();
matcherEligibilityBoundary();
matcherAmbiguityBoundary();
duplicateThresholdBoundary();
defectSideFloorBoundary();
defectEligibilityBoundary();
defectAmbiguityBoundary();
pricingBoundary();

console.log(
  "CALIBRATION-PINS " +
    JSON.stringify({ totalChecks: checksRun, totalChecksPassed: checksRun - failures, totalChecksFailed: failures })
);
if (failures > 0) {
  console.error(`\n${failures} failing check(s):`);
  for (const d of failureDetails) console.error("  - " + d);
  console.error(
    "\nIf you INTENDED to change a calibration constant: update the pinned literal\n" +
      "above AND bump the profile's version string in the same commit."
  );
  process.exit(1);
}

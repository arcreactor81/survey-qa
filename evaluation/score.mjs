#!/usr/bin/env node
/**
 * THE SCORER — survey-qa architecture ablation
 *
 * Reads each condition's normalised output plus the answer keys; emits per-survey and
 * aggregate scores. Every rule it applies is pre-registered in PRE-REGISTRATION.md and
 * hashed into FREEZE.json.
 *
 * THREE PROPERTIES THIS FILE IS BUILT AROUND
 *
 *  1. ARM-AGNOSTIC. There is no branch on `arm` anywhere in the scoring path. Arms plug in
 *     through the normalised format (finding-schema.mjs) and adapters (adapters/), never
 *     through a special case here. Maturity gate M5 greps for violations.
 *
 *  2. DETERMINISTIC MATCHING. No fuzzy string similarity, no threshold, no margin, no
 *     "near match" anywhere in defect credit. The repo already ran that experiment and
 *     lost (merged-contract §1; scorer/src/lib/defect-match.mjs is slated for DELETE, not
 *     migration). Matching is on structured facets: location, class, observable predicate.
 *
 *  3. IT CAN FAIL. Every load-bearing decision goes through a named entry in RULES, so
 *     selftest/mutate.mjs can replace one and prove a self-test turns red. A gate no test
 *     defends is reported as such rather than counted as assurance.
 *
 * CLI:  node evaluation/score.mjs --corpus <dir> --results <dir> [--out <file>]
 *                                 [--annotations <file>] [--exclusions <file>]
 *                                 [--pilot] [--blind-queue] [--amend "<reason>"]
 *
 * The CLI is the only part that touches `truth/`. Nothing else in this repository reads
 * an answer key, and no arm ever does.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

import {
  VOCAB_VERSION,
  LOCATOR_RULES_VERSION,
  REQUIREMENT_CLASSES,
  PREDICTED_OWNER,
  normaliseLocator,
  parseLocationSpec,
  eligibleClasses,
} from "./lib/class-map.mjs";
import { validateArmResult, validateTelemetry, ARMS } from "./finding-schema.mjs";

export const SCORECARD_VERSION = "survey-qa-eval-scorecard/1.0.0";
export const MATCHER_VERSION = "survey-qa-eval-matcher/1.0.0";

// ===========================================================================
// RULES — every load-bearing decision, named so it can be individually mutated.
// selftest/mutate.mjs replaces one at a time and asserts the suite goes red.
// ===========================================================================

export const RULES = {
  /** §4.4 — GUESSING IS A FAILURE EVEN WHEN THE GUESS IS RIGHT. */
  scoreAmbiguityOutcome(kind) {
    if (kind === "surfaced") return { correct: 1, guessed: 0, missed: 0 };
    if (kind === "guessed") return { correct: 0, guessed: 1, missed: 0 }; // right guess scores identically
    return { correct: 0, guessed: 0, missed: 1 };
  },

  /** §4.3 — a defect assertion matching no key defect is a false positive. */
  isFalsePositive({ matched, atAmbiguityLocus, quarantined, queued }) {
    if (matched) return false;
    if (atAmbiguityLocus) return false; // scored on the ambiguity track, never double-counted
    if (quarantined) return false; // SUSPECTED_CORPUS_DEFECT (§10.4)
    if (queued) return false; // unresolved -> the queue decides, not silence
    return true;
  },

  /** §5.5 — extra valid findings for one defect are REDUNDANT: not TP, not FP. */
  classifyDuplicate() {
    return "redundant";
  },

  /** §5.5 — one finding covering several defects: exactly one TP, the rest MISS, no partial credit. */
  underSplitCredit() {
    return { tpPerFinding: 1, partialCredit: 0 };
  },

  /** §4.5 — the arm never writes the visit log; a claim without a witness is unwitnessed. */
  coverageClaimWitnessed(location, visitedSet) {
    return visitedSet.has(normaliseLocator(location));
  },

  /** §4.1 — aggregate over DEFECTS, not the mean of per-survey recalls. */
  aggregateRecall(tpTotal, denominatorTotal) {
    return denominatorTotal === 0 ? null : tpTotal / denominatorTotal;
  },

  /** §4.7 — undefined when nothing was found. Not 0, not Infinity: both are outcome-deciders. */
  costPerDefect(usd, tp) {
    if (usd === null || usd === undefined) return null;
    if (!tp) return null;
    return usd / tp;
  },

  /** §6.4 — X beats Y iff Holm-adjusted exact McNemar p <= 0.05 AND b - c >= 5. */
  margin({ b, c, pAdj }) {
    return pAdj <= 0.05 && b - c >= 5;
  },

  /** §7.3 — if the outcome differs between the favourable and unfavourable readings of the
   *  queue, no point estimate may be reported as the result. */
  swingDominates(highDecision, lowDecision) {
    return highDecision !== lowDecision;
  },

  /** §8.2 — the freeze is not advisory. */
  freezeCheck(recorded, computed) {
    return recorded === computed;
  },

  /**
   * ARCHITECTURE.md §6 — a result with no verifiable build identity is not scoreable.
   * Named as a RULE so `selftest/mutate.mjs` can delete it and prove the suite goes red;
   * a gate nothing tests is a gate that is not enforced (scorer/docs/threat-model.md §11).
   */
  rejectOnArmIdentity(errors) {
    return errors.some((e) => e.code.startsWith("ARM_IDENTITY_"));
  },
};

// ===========================================================================
// Scoring
// ===========================================================================

/**
 * @param {object} input
 *   surveys:     [{ surveyId, tier, isCleanControl, key, runs: [{arm, seed, result, telemetry}] }]
 *   annotations: { "<surveyId>::<defectId>": { predicate, authoredAt } }
 *   exclusions:  [{ surveyId, defectId, reason, filedAt }]
 *   meta:        { corpusId, pilot, firstResultAt, freeze }
 * @param {object} opts  { mutations }  -- mutations is for selftest/mutate.mjs ONLY
 */
export function scoreCorpus(input, opts = {}) {
  const R = { ...RULES, ...(opts.mutations || {}) };
  const meta = input.meta || {};
  const annotations = input.annotations || {};
  const exclusions = input.exclusions || [];
  const warnings = [];
  const inconclusive = [];

  const excluded = new Set(exclusions.map((e) => `${e.surveyId}::${e.defectId}`));

  // ---- per-arm accumulators ------------------------------------------------
  const arms = {};
  const ensureArm = (a) =>
    (arms[a] ??= {
      arm: a,
      surveysRun: 0,
      runsInvalid: [],
      schemaErrors: [],
      tpStrict: [], // "<surveyId>::<defectId>"
      tpLenient: [],
      falsePositives: [],
      redundant: [],
      missed: [],
      missNeverVisited: [],
      missVisitedButMissed: [],
      missLocusUnknown: [],
      ambiguity: { correct: 0, guessed: 0, missed: 0, shield: 0, spurious: 0, assertions: 0 },
      cleanControlFp: 0,
      cleanControlsSeen: 0,
      cleanControlsClean: 0,
      observationVolume: 0,
      hedgingSurveys: [],
      claimedExercised: 0,
      witnessedExercised: 0,
      locusVisited: 0,
      locusTotal: 0,
      unannotatedConfirmations: 0,
      attribution: { graph: 0, model: 0, "graph-located-model-judged": 0, unattributed: 0 },
      taxonomyGaps: 0,
      cost: { usd: 0, usdKnown: true, modelCalls: 0, tokensIn: 0, tokensOut: 0, browserSessions: 0, browserActions: 0, wallClockMs: 0, nodeVisits: 0 },
      partialRuns: [],
      seeds: {},
      flags: [],
    });

  const queue = [];
  const perClass = {};
  for (const c of REQUIREMENT_CLASSES) {
    perClass[c] = { planted: 0, caught: {}, attribution: {}, neverVisited: {}, visitedButMissed: {} };
  }
  /**
   * ref -> requirementClass, derived from the KEY, never from an arm's declaration.
   * `planted` and `caught` must share a denominator; letting an arm's self-declared class
   * decide which row it is credited in would let a condition move its own numerator.
   */
  const defectClassByRef = new Map();

  // ---- pass 1: score every (survey, run) ----------------------------------
  for (const survey of input.surveys || []) {
    const key = survey.key || {};
    const keyDefects = (key.defects || [])
      .filter((d) => !excluded.has(`${survey.surveyId}::${d.id}`))
      .map((d) => prepareDefect(d, survey.surveyId));
    const keyAmbiguities = (key.ambiguities || []).map((a) => ({
      ...a,
      loci: parseLocationSpec(a.location),
    }));

    // per-class planted counts (post-exclusion)
    for (const d of keyDefects) {
      // A defect eligible for several classes is counted under its FIRST eligible class
      // only, so `planted` sums to the corpus total rather than double counting.
      const cls = d.eligible.classes[0];
      if (cls) {
        perClass[cls].planted += 1;
        defectClassByRef.set(`${survey.surveyId}::${d.id}`, cls);
      }
      if (d.eligible.taxonomyGap) {
        warnings.push({
          code: "TAXONOMY_GAP_IN_KEY",
          surveyId: survey.surveyId,
          defectId: d.id,
          keyClass: d.class,
          detail: "key class maps to none of the 16; excluded from the seam table rather than forced into the nearest token (§2.1)",
        });
      }
    }

    for (const run of survey.runs || []) {
      const arm = run.arm;
      if (!ARMS.includes(arm)) {
        warnings.push({ code: "UNKNOWN_ARM_IN_RESULTS", surveyId: survey.surveyId, arm });
        continue;
      }
      const acc = ensureArm(arm);
      acc.surveysRun += 1;
      if (run.seed !== null && run.seed !== undefined) {
        (acc.seeds[survey.surveyId] ??= []).push(run.seed);
      }

      const scored = scoreRun({ survey, keyDefects, keyAmbiguities, run, annotations, R, queue });

      if (scored.runInvalid) {
        acc.runsInvalid.push({ surveyId: survey.surveyId, reason: scored.runInvalid });
        // A run that misreported its own mechanism, leaked the oracle, or failed schema
        // validation contributes NOTHING. It is not scored low; it is not scored.
        continue;
      }
      if (scored.schemaErrors.length) {
        acc.schemaErrors.push({ surveyId: survey.surveyId, errors: scored.schemaErrors });
      }

      mergeRun(acc, scored, survey, perClass, arm, defectClassByRef);
    }
  }

  // ---- pass 2: cross-condition corpus-defect quarantine (§10.4) ------------
  applyCorpusDefectQuarantine(arms, queue, warnings);

  // ---- derived per-arm figures --------------------------------------------
  const denominator = countDenominator(input.surveys, excluded);
  for (const acc of Object.values(arms)) {
    acc.recallStrict = R.aggregateRecall(acc.tpStrict.length, denominator.defects);
    acc.recallLenient = R.aggregateRecall(acc.tpLenient.length, denominator.defects);
    acc.coverageHonesty =
      acc.claimedExercised === 0 ? null : acc.witnessedExercised / acc.claimedExercised;
    acc.unwitnessed = acc.claimedExercised - acc.witnessedExercised;
    acc.defectLocusCoverage = acc.locusTotal === 0 ? null : acc.locusVisited / acc.locusTotal;
    acc.cleanControlCleanRate =
      acc.cleanControlsSeen === 0 ? null : acc.cleanControlsClean / acc.cleanControlsSeen;
    acc.ambiguityPrecision =
      acc.ambiguity.assertions === 0 ? null : acc.ambiguity.correct / acc.ambiguity.assertions;
    acc.defectPrecisionDenominator =
      acc.tpStrict.length + acc.falsePositives.length; // redundant excluded (§5.5)
    acc.defectPrecision =
      acc.defectPrecisionDenominator === 0 ? null : acc.tpStrict.length / acc.defectPrecisionDenominator;
    acc.costPerDefect = R.costPerDefect(acc.cost.usdKnown ? acc.cost.usd : null, acc.tpStrict.length);
    acc.annotationCoverage =
      acc.tpStrict.length === 0
        ? null
        : 1 - acc.unannotatedConfirmations / acc.tpStrict.length;

    // ---- flags (§4.3, §4.5, §11.2) ----
    if (acc.cleanControlFp >= 2) acc.flags.push("FP_HEAVY");
    if (acc.hedgingSurveys.length) acc.flags.push("HEDGING");
    if (acc.coverageHonesty !== null && acc.coverageHonesty < 1) acc.flags.push("COVERAGE_UNWITNESSED");
    if (acc.recallStrict === 0) acc.flags.push("ZERO_YIELD");
    if (acc.runsInvalid.length) acc.flags.push("RUNS_INVALID");
    acc.safetyViolations = acc.flags.filter((f) =>
      ["FP_HEAVY", "HEDGING", "COVERAGE_UNWITNESSED", "RUNS_INVALID"].includes(f),
    ).length;
    acc.coverageFigure =
      acc.coverageHonesty === 1 ? fmtPct(acc.defectLocusCoverage) : `UNWITNESSED-${acc.unwitnessed}`;
  }

  // ---- FP amplification (§4.3) --------------------------------------------
  const fpAmplification =
    arms.C && arms.A && arms.B
      ? arms.C.cleanControlFp > arms.A.cleanControlFp + arms.B.cleanControlFp
      : false;
  if (fpAmplification) {
    warnings.push({
      code: "FP_AMPLIFICATION",
      detail:
        "the hybrid produces more clean-control false positives than its components combined: it is amplifying rather than filtering (§4.3)",
    });
  }

  // ---- HYBRID_REGRESSION (§6.6) -------------------------------------------
  let regression = null;
  if (arms.C && (arms.A || arms.B)) {
    const componentTp = new Set([...(arms.A?.tpStrict || []), ...(arms.B?.tpStrict || [])]);
    const cTp = new Set(arms.C.tpStrict);
    const regressionSet = [...componentTp].filter((d) => !cTp.has(d)).sort();
    regression = { size: regressionSet.length, defects: regressionSet, designDefect: regressionSet.length >= 3 };
    if (regression.designDefect) {
      warnings.push({
        code: "HYBRID_REGRESSION",
        detail: `the hybrid missed ${regressionSet.length} defects that a component found: it is losing information one of its halves already had (§6.6)`,
        defects: regressionSet,
      });
    }
  }

  // ---- the four pre-committed comparisons (§6.1) --------------------------
  const comparisons = buildComparisons(arms, queue, R);

  // ---- inconclusive conditions (§6.8) -------------------------------------
  const totalFindings = Object.values(arms).reduce(
    (n, a) => n + a.tpStrict.length + a.falsePositives.length + a.redundant.length + a.ambiguity.assertions,
    0,
  );
  const adjudicationRate = totalFindings === 0 ? 0 : queue.length / totalFindings;

  if (meta.pilot) {
    inconclusive.push({
      code: "PILOT",
      detail: "pilot data. §9.4: the scorer refuses to emit a headline comparison from pilot data.",
    });
  }
  for (const cmp of comparisons) {
    if (cmp.queueDominated) {
      inconclusive.push({
        code: "QUEUE_DOMINATED",
        comparison: cmp.id,
        detail: `resolving the adjudication queue the other way changes the outcome of ${cmp.id}; no point estimate may be reported as the result (§7.3)`,
      });
    }
  }
  for (const acc of Object.values(arms)) {
    const delta = (acc.recallLenient ?? 0) - (acc.recallStrict ?? 0);
    if (delta * denominator.defects >= 5) {
      inconclusive.push({
        code: "MATCHING_SENSITIVE",
        arm: acc.arm,
        detail: `recall_lenient - recall_strict = ${(delta * denominator.defects).toFixed(0)} defects for arm ${acc.arm}, at or above the decision margin: the strict/lenient choice is deciding the outcome (§4.1)`,
      });
    }
  }
  if (denominator.defectsBeforeExclusion > 0) {
    const exclusionRate = excluded.size / denominator.defectsBeforeExclusion;
    if (exclusionRate >= 0.2) {
      inconclusive.push({
        code: "EXCLUSIONS_EXCESSIVE",
        detail: `${(exclusionRate * 100).toFixed(0)}% of planted defects excluded; too much of the corpus removed for the remainder to represent it (§6.8)`,
      });
    }
  }
  const taxonomyGapTotal = Object.values(arms).reduce((n, a) => n + a.taxonomyGaps, 0);
  if (totalFindings > 0 && taxonomyGapTotal / totalFindings >= 0.2) {
    inconclusive.push({
      code: "TAXONOMY_GAPS_EXCESSIVE",
      detail: "the shared 16-class vocabulary does not fit this corpus; the seam table cannot be trusted (§6.8)",
    });
  }
  for (const acc of Object.values(arms)) {
    if (acc.runsInvalid.some((r) => r.reason === "ATTRIBUTION_IMPOSSIBLE")) {
      inconclusive.push({ code: "ATTRIBUTION_IMPOSSIBLE", arm: acc.arm, detail: "a condition misreported its own mechanism (§3.3)" });
    }
    if (acc.runsInvalid.some((r) => r.reason === "SUSPECTED_ORACLE_LEAK")) {
      inconclusive.push({ code: "SUSPECTED_ORACLE_LEAK", arm: acc.arm, detail: "blindness compromised; this condition's numbers are void (§8.4)" });
    }
  }

  // Descriptive ranking. NEVER an input to any decision (§6). Safety sorts first, which is
  // what makes an over-flagger rank below an arm that emitted nothing at all.
  const ranking = Object.values(arms)
    .slice()
    .sort(
      (x, y) =>
        x.safetyViolations - y.safetyViolations ||
        (y.recallStrict ?? 0) - (x.recallStrict ?? 0) ||
        x.arm.localeCompare(y.arm),
    )
    .map((a, i) => ({ rank: i + 1, arm: a.arm, safetyViolations: a.safetyViolations, recallStrict: a.recallStrict }));

  return {
    scorecardVersion: SCORECARD_VERSION,
    matcherVersion: MATCHER_VERSION,
    vocabVersion: VOCAB_VERSION,
    locatorRulesVersion: LOCATOR_RULES_VERSION,
    scoredAt: meta.scoredAt || new Date().toISOString(),
    corpusId: meta.corpusId || null,
    pilot: Boolean(meta.pilot),

    // The queue size sits at the TOP of the summary, beside recall, deliberately (§7.2).
    headline: {
      adjudicationQueueSize: queue.length,
      adjudicationRate,
      queueWarning:
        adjudicationRate >= 0.15
          ? "LARGE QUEUE — the matching rule is weak here and these numbers are soft (§7.2)"
          : null,
      denominator,
      exclusions: exclusions.length,
      inconclusive: inconclusive.map((i) => i.code),
      headlineSuppressed: inconclusive.length > 0,
    },

    arms,
    ranking,
    perClass: finalisePerClass(perClass, arms),
    comparisons,
    regression,
    fpAmplification,
    queue,
    exclusions,
    warnings,
    inconclusive,
  };
}

// ---------------------------------------------------------------------------
// One (survey, run)
// ---------------------------------------------------------------------------

function scoreRun({ survey, keyDefects, keyAmbiguities, run, annotations, R, queue }) {
  const out = {
    runInvalid: null,
    schemaErrors: [],
    tpStrict: [],
    tpLenient: [],
    falsePositives: [],
    redundant: [],
    missed: [],
    missNeverVisited: [],
    missVisitedButMissed: [],
    missLocusUnknown: [],
    ambiguity: { correct: 0, guessed: 0, missed: 0, shield: 0, spurious: 0, assertions: 0 },
    observationVolume: 0,
    hedging: false,
    claimedExercised: 0,
    witnessedExercised: 0,
    locusVisited: 0,
    locusTotal: 0,
    unannotatedConfirmations: 0,
    attribution: { graph: 0, model: 0, "graph-located-model-judged": 0, unattributed: 0 },
    taxonomyGaps: 0,
    cost: null,
    partial: false,
    classOfDefect: {},
  };

  const result = run.result;
  const telemetry = run.telemetry;

  // -- validation ----------------------------------------------------------
  const v = validateArmResult(result);
  out.schemaErrors = v.errors;
  if (v.errors.some((e) => e.code === "ATTRIBUTION_IMPOSSIBLE")) {
    out.runInvalid = "ATTRIBUTION_IMPOSSIBLE";
    return out;
  }
  // §6 of evaluation/arms/ARCHITECTURE.md — a result whose build identity is missing or
  // self-inconsistent is REJECTED, not scored low. Same family as ATTRIBUTION_IMPOSSIBLE
  // and for the same reason (§3.3): a condition that cannot account for what produced it
  // cannot be trusted about the seam. Scoring it anyway would produce a number that reads
  // as evidence about an architecture nobody can identify.
  if (R.rejectOnArmIdentity(v.errors)) {
    out.runInvalid = "ARM_IDENTITY_INVALID";
    return out;
  }
  if (!v.ok && v.errors.some((e) => FATAL_SCHEMA_CODES.has(e.code))) {
    out.runInvalid = "SCHEMA_INVALID";
    return out;
  }
  const tv = validateTelemetry(telemetry);
  if (!tv.ok) {
    out.runInvalid = "TELEMETRY_INVALID";
    return out;
  }

  // -- oracle-leak check (§8.4) -------------------------------------------
  if (detectOracleLeak(result, survey)) {
    out.runInvalid = "SUSPECTED_ORACLE_LEAK";
    return out;
  }

  // -- cost + coverage -----------------------------------------------------
  out.cost = telemetry.cost || {};
  out.partial = Boolean(telemetry.budgetExhausted || telemetry.timeExhausted);

  const visited = new Set((telemetry.visitLog || []).map((l) => normaliseLocator(l)));
  for (const u of result.coverage?.claimedUnits || []) {
    if (u.status !== "exercised") continue;
    out.claimedExercised += 1;
    if (R.coverageClaimWitnessed(u.location, visited)) out.witnessedExercised += 1;
  }

  const allLoci = new Set();
  for (const d of keyDefects) for (const l of d.loci.values) allLoci.add(l);
  for (const a of keyAmbiguities) for (const l of a.loci.values) allLoci.add(l);
  out.locusTotal = allLoci.size;
  for (const l of allLoci) if (visited.has(l)) out.locusVisited += 1;

  // -- partition findings --------------------------------------------------
  const findings = Array.isArray(result.findings) ? result.findings : [];
  for (const f of findings) {
    if (f.attribution && out.attribution[f.attribution] !== undefined) out.attribution[f.attribution] += 1;
  }
  const defectFindings = findings.filter((f) => f.claimClass === "defect");
  const ambiguityFindings = findings.filter((f) => f.claimClass === "ambiguity");
  const observationFindings = findings.filter((f) => f.claimClass === "observation" || f.claimClass === "blocker");

  out.observationVolume = observationFindings.length + ambiguityFindings.length;
  const estimate = Number(survey.key?.total_requirements_estimate) || 0;
  out.hedging = estimate > 0 && out.observationVolume > 0.5 * estimate;

  // -- AMBIGUITY TRACK, scored FIRST (§4.4) --------------------------------
  // Done before defect matching because a determinate claim at an ambiguity locus is
  // scored here and is deliberately exempt from the defect false-positive count.
  const ambiguityLoci = new Set();
  for (const a of keyAmbiguities) for (const l of a.loci.values) ambiguityLoci.add(l);
  const defectLoci = new Set();
  for (const d of keyDefects) for (const l of d.loci.values) defectLoci.add(l);

  const guessedAtLocus = new Set();
  for (const a of keyAmbiguities) {
    const loci = new Set(a.loci.values);
    const at = (f) => loci.has(normaliseLocator(f.location?.raw));

    const surfaced = ambiguityFindings.some((f) => at(f) && Array.isArray(f.readings) && f.readings.length >= 2);
    const guessedAsDefect = defectFindings.some(at);
    // A determinate coverage verdict at the locus is also a guess: the arm silently
    // adopted one reading and passed or failed it.
    const guessedAsVerdict = (result.coverage?.claimedUnits || []).some(
      (u) => loci.has(normaliseLocator(u.location)) && (u.verdict === "pass" || u.verdict === "fail"),
    );

    let kind;
    if (surfaced) kind = "surfaced";
    else if (guessedAsDefect || guessedAsVerdict) kind = "guessed";
    else kind = "silent";

    const s = R.scoreAmbiguityOutcome(kind);
    out.ambiguity.correct += s.correct;
    out.ambiguity.guessed += s.guessed;
    out.ambiguity.missed += s.missed;
    if (kind === "guessed") for (const l of loci) guessedAtLocus.add(l);
  }

  out.ambiguity.assertions = ambiguityFindings.length;
  for (const f of ambiguityFindings) {
    const l = normaliseLocator(f.location?.raw);
    if (ambiguityLoci.has(l)) continue; // counted as `correct` above
    // AMBIGUITY_SHIELD: shrugging at a findable defect is not caution (§4.4).
    if (defectLoci.has(l)) out.ambiguity.shield += 1;
    else out.ambiguity.spurious += 1;
  }

  // -- DEFECT MATCHING (§5) ------------------------------------------------
  const locusDictionary = new Set([...allLoci, ...visited]);
  const match = matchDefects({
    surveyId: survey.surveyId,
    arm: run.arm,
    keyDefects,
    defectFindings,
    annotations,
    locusDictionary,
    queue,
    R,
  });

  out.tpStrict = match.tpStrict;
  out.tpLenient = match.tpLenient;
  out.redundant = match.redundant;
  out.unannotatedConfirmations = match.unannotatedConfirmations;
  out.taxonomyGaps = match.taxonomyGaps;
  out.classOfDefect = match.classOfDefect;

  const matchedFindingIds = new Set(match.tpStrict.map((t) => t.findingId));
  const redundantIds = new Set(match.redundant.map((r) => r.findingId));
  const queuedFindingIds = new Set(
    queue.filter((q) => q.surveyId === survey.surveyId && q.arm === run.arm).map((q) => q.findingId),
  );

  for (const f of defectFindings) {
    const l = normaliseLocator(f.location?.raw);
    const isFp = R.isFalsePositive({
      matched: matchedFindingIds.has(f.findingId) || redundantIds.has(f.findingId),
      atAmbiguityLocus: guessedAtLocus.has(l) || ambiguityLoci.has(l),
      quarantined: false, // applied corpus-wide in pass 2
      queued: queuedFindingIds.has(f.findingId),
    });
    if (isFp) {
      out.falsePositives.push({
        surveyId: survey.surveyId,
        findingId: f.findingId,
        location: l,
        requirementClass: f.requirementClass,
        attribution: f.attribution,
        isCleanControl: Boolean(survey.isCleanControl),
      });
    }
  }

  // -- miss decomposition (§4.2) ------------------------------------------
  const foundDefectIds = new Set(match.tpStrict.map((t) => t.defectId));
  for (const d of keyDefects) {
    if (foundDefectIds.has(d.id)) continue;
    const ref = `${survey.surveyId}::${d.id}`;
    out.missed.push(ref);
    if (d.loci.kind === "global" || d.loci.values.length === 0) out.missLocusUnknown.push(ref);
    else if (d.loci.values.some((l) => visited.has(l))) out.missVisitedButMissed.push(ref);
    else out.missNeverVisited.push(ref);
  }

  return out;
}

const FATAL_SCHEMA_CODES = new Set([
  "NOT_AN_OBJECT",
  "SCHEMA_VERSION_MISMATCH",
  "UNKNOWN_ARM",
  "MISSING_ARM_VERSION",
  "MISSING_SURVEY_ID",
  "FINDINGS_NOT_ARRAY",
  "COVERAGE_MISSING",
]);

// ---------------------------------------------------------------------------
// The matching rule (§5)
// ---------------------------------------------------------------------------

function matchDefects({ surveyId, arm, keyDefects, defectFindings, annotations, locusDictionary, queue, R }) {
  const confirmed = []; // { findingId, defectId, unannotated }
  const lenient = []; // { findingId, defectId }
  const queuedPairs = [];
  let taxonomyGaps = 0;
  const classOfDefect = {};

  // ---- M1: the eligibility gate -----------------------------------------
  const candidates = new Map(); // findingId -> [{ defect, tier }]
  for (const f of defectFindings) {
    const fl = normaliseLocator(f.location?.raw);
    const list = [];
    for (const d of keyDefects) {
      if (d.eligible.taxonomyGap) continue;
      // M1.2 CLASS — a gate, never a matcher.
      if (!d.eligible.classes.includes(f.requirementClass)) continue;
      // M1.1 LOCATION
      if (d.loci.kind === "global") {
        // §5.2 — the gate is WAIVED and the pair goes straight to adjudication.
        list.push({ defect: d, waived: true });
        continue;
      }
      if (d.loci.values.includes(fl)) list.push({ defect: d, waived: false });
    }
    candidates.set(f.findingId, list);

    // §5.2 — a locator we cannot place is queued, never silently converted into the
    // arm's recall loss. A rule that charges an arm for the rule's own vocabulary gap
    // is measuring the rule.
    if (list.length === 0 && fl && !locusDictionary.has(fl)) {
      queue.push({
        code: "LOCATOR_UNRESOLVED",
        surveyId,
        arm,
        findingId: f.findingId,
        location: fl,
        candidateDefectIds: [],
        detail: "finding locator resolves to no key locus and no visited screen",
      });
      queuedPairs.push({ findingId: f.findingId, defectIds: [] });
    }
  }

  for (const f of defectFindings) {
    if (!REQUIREMENT_CLASSES.includes(f.requirementClass)) taxonomyGaps += 1;
  }

  // ---- lenient set: M1 only (§4.1) --------------------------------------
  for (const [findingId, list] of candidates) {
    for (const { defect } of list) lenient.push({ findingId, defectId: defect.id });
  }

  // ---- M2: consequence discrimination ------------------------------------
  // Reverse index so "sole candidate" means sole in BOTH directions.
  const byDefect = new Map();
  for (const [findingId, list] of candidates) {
    for (const { defect, waived } of list) {
      if (!byDefect.has(defect.id)) byDefect.set(defect.id, []);
      byDefect.get(defect.id).push({ findingId, waived });
    }
  }

  for (const [findingId, list] of candidates) {
    const f = defectFindings.find((x) => x.findingId === findingId);
    if (list.length === 0) continue;

    // Tier 3 — an annotation, where one exists, is decisive in both directions.
    const annotated = list.filter(({ defect }) => annotations[`${surveyId}::${defect.id}`]);
    if (annotated.length) {
      const agreeing = annotated.filter(
        ({ defect }) => annotations[`${surveyId}::${defect.id}`].predicate === f.observable?.predicate,
      );
      if (agreeing.length === 1) {
        confirmed.push({ findingId, defectId: agreeing[0].defect.id, unannotated: false });
        classOfDefect[agreeing[0].defect.id] = f.requirementClass;
        continue;
      }
      if (agreeing.length === 0 && annotated.length === list.length) {
        // Right place, plausible class, WRONG consequence. This is a rejection, not a
        // queue item — it is exactly the hole Tier 3 exists to close (§5.4).
        continue;
      }
    }

    const waivedOnly = list.every((x) => x.waived);
    if (waivedOnly) {
      queue.push({
        code: "LOCATION_WAIVED",
        surveyId,
        arm,
        findingId,
        location: normaliseLocator(f.location?.raw),
        candidateDefectIds: list.map((x) => x.defect.id),
        detail: "key location is global/unparseable; never auto-credited (§5.2)",
      });
      queuedPairs.push({ findingId, defectIds: list.map((x) => x.defect.id) });
      continue;
    }

    const nonWaived = list.filter((x) => !x.waived);

    // Tier 1 — the finding has exactly ONE candidate defect. Confirmed.
    //
    // The ambiguity that needs a human is "which defect did this finding find?", i.e. one
    // finding with several candidate defects. Several findings pointing at ONE defect is
    // not an identification ambiguity — they all name the same thing — and §5.5 already
    // rules on it: one TP, the rest REDUNDANT. Queueing duplicates would flood the queue
    // and destroy `adjudicationRate` as a weakness signal.
    //
    // The residual direction risk (right place, right class, opposite consequence) is real,
    // is stated in §10.6, and is measured by `annotationCoverage`.
    if (nonWaived.length === 1) {
      confirmed.push({ findingId, defectId: nonWaived[0].defect.id, unannotated: true });
      classOfDefect[nonWaived[0].defect.id] = f.requirementClass;
      continue;
    }

    // Tier 2 — a contested cluster. Nothing in it is auto-credited to anybody.
    queue.push({
      code: annotated.length ? "MULTI_CANDIDATE" : "PREDICATE_UNANNOTATED",
      surveyId,
      arm,
      findingId,
      location: normaliseLocator(f.location?.raw),
      candidateDefectIds: nonWaived.map((x) => x.defect.id),
      detail:
        "several defects/findings at one locus; predicate alone cannot discriminate and no annotation resolves it (§5.4 Tier 2)",
    });
    queuedPairs.push({ findingId, defectIds: nonWaived.map((x) => x.defect.id) });
  }

  // ---- M3: one-to-one maximum-cardinality assignment (§5.5) --------------
  const assign = maxBipartite(confirmed);
  const tpStrict = [];
  const redundant = [];
  let unannotatedConfirmations = 0;

  for (const pair of confirmed) {
    if (assign.get(pair.findingId) === pair.defectId) {
      tpStrict.push({ surveyId, findingId: pair.findingId, defectId: pair.defectId, ref: `${surveyId}::${pair.defectId}` });
      if (pair.unannotated) unannotatedConfirmations += 1;
    }
  }
  const assignedFindings = new Set(tpStrict.map((t) => t.findingId));
  for (const pair of confirmed) {
    if (assignedFindings.has(pair.findingId)) continue;
    // A valid finding that lost the assignment: REDUNDANT, per R.classifyDuplicate.
    if (R.classifyDuplicate() === "redundant") {
      redundant.push({ surveyId, findingId: pair.findingId, defectId: pair.defectId });
      assignedFindings.add(pair.findingId);
    }
  }

  // ---- UNDER_SPLIT detection (§5.5) --------------------------------------
  // The signature is read off the CANDIDATE map, not the confirmed set: a finding that was
  // eligible for several defects, was credited to one, and left another with no other
  // candidate finding at all. Reading it off `confirmed` would miss the case Tier 3
  // resolves — which is the only case where we can actually tell an under-split from an
  // ordinary contested cluster.
  const assignedDefects = new Set(tpStrict.map((t) => t.defectId));
  const credit = R.underSplitCredit();
  for (const t of tpStrict) {
    const others = (candidates.get(t.findingId) || [])
      .map((x) => x.defect.id)
      .filter((dId) => dId !== t.defectId && !assignedDefects.has(dId));
    if (!others.length) continue;
    const orphaned = others.filter(
      (dId) => (byDefect.get(dId) || []).filter((x) => x.findingId !== t.findingId).length === 0,
    );
    if (!orphaned.length) continue;

    // §5.5 — NO PARTIAL CREDIT, and no multi-credit either. One finding buys one defect.
    // The rule is consulted here rather than hardcoded so it is individually mutable: a
    // harness that let an under-split finding claim both defects would be silently
    // inflating recall for exactly the arms that report at the wrong granularity.
    const extra = Math.max(0, (credit.tpPerFinding ?? 1) - 1);
    for (const dId of orphaned.slice(0, extra)) {
      tpStrict.push({ surveyId, findingId: t.findingId, defectId: dId, ref: `${surveyId}::${dId}` });
      assignedDefects.add(dId);
    }
    if (credit.partialCredit) {
      // Fractional credit cannot propagate into a McNemar table — a half-found defect is
      // not a unit anyone can reason about. Recorded loudly rather than quietly absorbed.
      queue.push({
        code: "PARTIAL_CREDIT_ATTEMPTED",
        surveyId,
        arm,
        findingId: t.findingId,
        location: null,
        candidateDefectIds: orphaned,
        detail: `partial credit of ${credit.partialCredit} is not representable in the paired test (§5.5)`,
      });
    }
    queue.push({
      code: "UNDER_SPLIT",
      surveyId,
      arm,
      findingId: t.findingId,
      location: null,
      candidateDefectIds: orphaned,
      detail: `one finding appears to cover ${orphaned.length + 1} defects; credited to one, the rest are misses, no partial credit (credit=${credit.partialCredit}) (§5.5)`,
    });
  }

  // lenient assignment, same discipline
  const lenientAssign = maxBipartite(lenient);
  const tpLenient = lenient
    .filter((p) => lenientAssign.get(p.findingId) === p.defectId)
    .map((p) => ({ surveyId, findingId: p.findingId, defectId: p.defectId, ref: `${surveyId}::${p.defectId}` }));

  return { tpStrict, tpLenient, redundant, unannotatedConfirmations, taxonomyGaps, classOfDefect, queuedPairs };
}

/**
 * Maximum-cardinality one-to-one bipartite assignment (Kuhn's augmenting paths).
 * Deliberately NOT greedy: greedy lets processing order decide credit, which is the
 * discipline scorer/docs/threat-model.md §5.2 already settled on.
 * Pairs are sorted first so the result is deterministic under any input ordering.
 */
export function maxBipartite(pairs) {
  const sorted = pairs
    .slice()
    .sort((a, b) => a.findingId.localeCompare(b.findingId) || a.defectId.localeCompare(b.defectId));
  const adjacency = new Map();
  for (const p of sorted) {
    if (!adjacency.has(p.findingId)) adjacency.set(p.findingId, []);
    adjacency.get(p.findingId).push(p.defectId);
  }
  const matchDefect = new Map(); // defectId -> findingId
  const tryAssign = (findingId, seen) => {
    for (const defectId of adjacency.get(findingId) || []) {
      if (seen.has(defectId)) continue;
      seen.add(defectId);
      const held = matchDefect.get(defectId);
      if (held === undefined || tryAssign(held, seen)) {
        matchDefect.set(defectId, findingId);
        return true;
      }
    }
    return false;
  };
  for (const findingId of adjacency.keys()) tryAssign(findingId, new Set());

  const out = new Map(); // findingId -> defectId
  for (const [defectId, findingId] of matchDefect) out.set(findingId, defectId);
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

/**
 * §8.4 — oracle-leak check.
 *
 * Deliberately scoped to strings that exist ONLY in the key. `document_says` is excluded
 * because it may legitimately quote the questionnaire, which every arm is entitled to read;
 * flagging on it would fire on honest work. What remains: key-minted defect/ambiguity IDs,
 * the distinctive `requirement_source` tokens, and verbatim spans from `how_to_observe`
 * (which is a scoring instruction and appears nowhere a arm can legitimately reach).
 *
 * A quarantine is REVIEWABLE, not an automatic void: it is recorded and the owner may clear
 * it with a written reason that appears in the report.
 */
export function detectOracleLeak(result, survey) {
  const key = survey.key || {};
  const idTokens = [
    ...(key.defects || []).map((d) => d.id),
    ...(key.ambiguities || []).map((a) => a.id),
  ].filter((id) => typeof id === "string" && /^[A-Za-z]{1,3}\d+$/.test(id));

  const sourceTokens = ["auto-numbering", "image-alt"];

  const spans = [];
  for (const d of key.defects || []) {
    const words = String(d.how_to_observe || "").trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i + 8 <= words.length; i += 1) spans.push(words.slice(i, i + 8).join(" ").toLowerCase());
  }

  const haystacks = [];
  for (const f of result.findings || []) {
    haystacks.push(String(f.prose || ""));
    haystacks.push(String(f.observable?.subject || ""));
    haystacks.push(String(f.observable?.expected || ""));
    haystacks.push(String(f.observable?.actual || ""));
    for (const r of f.readings || []) haystacks.push(String(r));
  }
  const blob = haystacks.join("  ");
  const lower = blob.toLowerCase();

  for (const id of idTokens) {
    if (new RegExp(`(^|[^A-Za-z0-9])${escapeRe(id)}([^A-Za-z0-9]|$)`).test(blob)) return true;
  }
  for (const t of sourceTokens) if (lower.includes(t)) return true;
  for (const s of spans) if (s.length > 20 && lower.includes(s)) return true;
  return false;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prepareDefect(d, surveyId) {
  return {
    ...d,
    surveyId,
    loci: parseLocationSpec(d.location),
    eligible: eligibleClasses(d.class),
  };
}

function mergeRun(acc, s, survey, perClass, arm, defectClassByRef) {
  acc.tpStrict.push(...s.tpStrict.map((t) => t.ref));
  acc.tpLenient.push(...s.tpLenient.map((t) => t.ref));
  acc.redundant.push(...s.redundant);
  acc.falsePositives.push(...s.falsePositives);
  acc.missed.push(...s.missed);
  acc.missNeverVisited.push(...s.missNeverVisited);
  acc.missVisitedButMissed.push(...s.missVisitedButMissed);
  acc.missLocusUnknown.push(...s.missLocusUnknown);

  acc.ambiguity.correct += s.ambiguity.correct;
  acc.ambiguity.guessed += s.ambiguity.guessed;
  acc.ambiguity.missed += s.ambiguity.missed;
  acc.ambiguity.shield += s.ambiguity.shield;
  acc.ambiguity.spurious += s.ambiguity.spurious;
  acc.ambiguity.assertions += s.ambiguity.assertions;

  acc.observationVolume += s.observationVolume;
  if (s.hedging) acc.hedgingSurveys.push(survey.surveyId);

  if (survey.isCleanControl) {
    acc.cleanControlsSeen += 1;
    const fps = s.falsePositives.length;
    acc.cleanControlFp += fps;
    if (fps === 0) acc.cleanControlsClean += 1;
  }

  acc.claimedExercised += s.claimedExercised;
  acc.witnessedExercised += s.witnessedExercised;
  acc.locusVisited += s.locusVisited;
  acc.locusTotal += s.locusTotal;
  acc.unannotatedConfirmations += s.unannotatedConfirmations;
  acc.taxonomyGaps += s.taxonomyGaps;

  for (const k of Object.keys(acc.attribution)) acc.attribution[k] += s.attribution[k] || 0;

  const c = s.cost || {};
  if (c.usd === null || c.usd === undefined) acc.cost.usdKnown = false;
  else acc.cost.usd += c.usd;
  acc.cost.modelCalls += c.modelCalls || 0;
  acc.cost.tokensIn += c.tokensIn || 0;
  acc.cost.tokensOut += c.tokensOut || 0;
  acc.cost.browserSessions += c.browserSessions || 0;
  acc.cost.browserActions += c.browserActions || 0;
  acc.cost.wallClockMs += c.wallClockMs || 0;
  acc.cost.nodeVisits += c.nodeVisits || 0;
  if (s.partial) acc.partialRuns.push(survey.surveyId);

  // ---- per-class attribution (§4.6) --------------------------------------
  // Row membership always comes from the KEY's class, so `caught` and `planted` share a
  // denominator. The arm's self-declared requirementClass gates matching (§5.2) and
  // labels false positives; it never decides which row a catch lands in.
  for (const t of s.tpStrict) {
    const cls = defectClassByRef.get(t.ref);
    if (!cls || !perClass[cls]) continue;
    perClass[cls].caught[arm] = (perClass[cls].caught[arm] || 0) + 1;
    const declared = s.classOfDefect[t.defectId];
    if (declared && declared !== cls) {
      perClass[cls].attribution[`${arm}:class-disagreement`] =
        (perClass[cls].attribution[`${arm}:class-disagreement`] || 0) + 1;
    }
    const f = (survey.runs.find((r) => r.arm === arm)?.result?.findings || []).find(
      (x) => x.findingId === t.findingId,
    );
    if (f?.attribution) {
      perClass[cls].attribution[`${arm}:${f.attribution}`] =
        (perClass[cls].attribution[`${arm}:${f.attribution}`] || 0) + 1;
    }
  }
  for (const ref of s.missNeverVisited) {
    const cls = defectClassByRef.get(ref);
    if (cls && perClass[cls]) perClass[cls].neverVisited[arm] = (perClass[cls].neverVisited[arm] || 0) + 1;
  }
  for (const ref of s.missVisitedButMissed) {
    const cls = defectClassByRef.get(ref);
    if (cls && perClass[cls]) perClass[cls].visitedButMissed[arm] = (perClass[cls].visitedButMissed[arm] || 0) + 1;
  }
}

function countDenominator(surveys, excluded) {
  let defects = 0;
  let before = 0;
  let ambiguities = 0;
  let cleanControls = 0;
  for (const s of surveys || []) {
    for (const d of s.key?.defects || []) {
      before += 1;
      if (!excluded.has(`${s.surveyId}::${d.id}`)) defects += 1;
    }
    ambiguities += (s.key?.ambiguities || []).length;
    if (s.isCleanControl) cleanControls += 1;
  }
  return { surveys: (surveys || []).length, defects, defectsBeforeExclusion: before, ambiguities, cleanControls };
}

function finalisePerClass(perClass, arms) {
  const armIds = Object.keys(arms);
  const out = {};
  for (const [cls, row] of Object.entries(perClass)) {
    const caught = {};
    for (const a of armIds) caught[a] = row.caught[a] || 0;
    out[cls] = {
      planted: row.planted,
      predictedOwner: PREDICTED_OWNER[cls] || null,
      caught,
      deltaGraph: arms.C && arms.A ? caught.C - caught.A : null, // what computed coverage adds
      deltaModel: arms.C && arms.B ? caught.C - caught.B : null, // what attribute judgement adds
      neverVisited: row.neverVisited,
      visitedButMissed: row.visitedButMissed,
      // §4.6 — no percentages on cells where N < 5. A percentage over two items is a lie
      // with a decimal point.
      inferential: row.planted >= 5,
      note: row.planted < 5 ? "descriptive only (n<5)" : null,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// §10.4 — cross-condition corpus-defect quarantine
// ---------------------------------------------------------------------------

function applyCorpusDefectQuarantine(arms, queue, warnings) {
  const CAP = 3; // conditions are NOT independent; agreement is weak evidence (§10.4)
  const byLocus = new Map();
  for (const acc of Object.values(arms)) {
    for (const fp of acc.falsePositives) {
      if (!fp.isCleanControl) continue;
      const k = `${fp.surveyId}::${fp.location}::${fp.requirementClass}`;
      if (!byLocus.has(k)) byLocus.set(k, []);
      byLocus.get(k).push({ arm: acc.arm, fp });
    }
  }
  const candidates = [...byLocus.entries()]
    .filter(([, hits]) => new Set(hits.map((h) => h.arm)).size >= 2)
    .sort((a, b) => a[0].localeCompare(b[0]));

  let quarantined = 0;
  for (const [k, hits] of candidates) {
    if (quarantined >= CAP) {
      warnings.push({
        code: "QUARANTINE_CAP_REACHED",
        locus: k,
        detail: "beyond the cap of 3, agreed clean-control assertions count as false positives for everyone (§10.4)",
      });
      continue;
    }
    quarantined += 1;
    queue.push({
      code: "SUSPECTED_CORPUS_DEFECT",
      surveyId: hits[0].fp.surveyId,
      arm: null, // blinded by construction: this entry belongs to the corpus, not an arm
      findingId: null,
      location: hits[0].fp.location,
      candidateDefectIds: [],
      detail: `${new Set(hits.map((h) => h.arm)).size} conditions independently asserted a defect here on a clean control (§10.4)`,
    });
    for (const h of hits) {
      const acc = arms[h.arm];
      acc.falsePositives = acc.falsePositives.filter((x) => x !== h.fp);
      acc.cleanControlFp = Math.max(0, acc.cleanControlFp - 1);
    }
  }
}

// ---------------------------------------------------------------------------
// §6 — the decision rule
// ---------------------------------------------------------------------------

export function buildComparisons(arms, queue, R) {
  const specs = [];
  const has = (a) => Boolean(arms[a]);

  if (has("C") && has("A")) specs.push({ id: "H1", x: "C", y: "A", question: "what does the GRAPH add" });
  if (has("C") && has("B")) specs.push({ id: "H2", x: "C", y: "B", question: "what does the MODEL add" });
  if (has("C") && (has("A") || has("B"))) {
    const best = ["A", "B"]
      .filter(has)
      .sort((a, b) => (arms[b].recallStrict ?? 0) - (arms[a].recallStrict ?? 0))[0];
    specs.push({ id: "H3", x: "C", y: best, question: "is the HYBRID better than the best single component" });
  }
  if (has("C") && has("C-R")) {
    specs.push({ id: "H4", x: "C", y: "C-R", question: "is PRINCIPLED TRAVERSAL doing the work, or just browsing more" });
  }

  // queue-favourable extra credits, per arm
  const queuedDefectsByArm = new Map();
  for (const q of queue) {
    if (!q.arm || !q.candidateDefectIds?.length) continue;
    if (!queuedDefectsByArm.has(q.arm)) queuedDefectsByArm.set(q.arm, new Set());
    for (const d of q.candidateDefectIds) queuedDefectsByArm.get(q.arm).add(`${q.surveyId}::${d}`);
  }

  const raw = specs.map((spec) => {
    const base = discordance(arms[spec.x].tpStrict, arms[spec.y].tpStrict);
    return { ...spec, ...base, p: mcnemarExactP(base.b, base.c) };
  });

  const adjusted = holm(raw.map((r) => r.p));
  raw.forEach((r, i) => {
    r.pAdj = adjusted[i];
  });

  return raw.map((r) => {
    // The swing is judged at the SAME Holm step the point estimate was judged at, so the
    // two are like-for-like. `holmMultiplier` is that step's factor, recovered from the
    // point estimate rather than recomputed (recomputing would re-rank the comparisons
    // under the swing and change which alpha each one faces).
    const holmMultiplier = r.p > 0 ? r.pAdj / r.p : specs.length;
    const decideWith = (xExtra, yExtra) => {
      const xs = new Set([...arms[r.x].tpStrict, ...xExtra]);
      const ys = new Set([...arms[r.y].tpStrict, ...yExtra]);
      const d = discordance([...xs], [...ys]);
      const pAdj = Math.min(1, mcnemarExactP(d.b, d.c) * holmMultiplier);
      if (R.margin({ b: d.b, c: d.c, pAdj })) return r.x;
      if (R.margin({ b: d.c, c: d.b, pAdj })) return r.y;
      return "inconclusive";
    };

    const xQ = [...(queuedDefectsByArm.get(r.x) || [])];
    const yQ = [...(queuedDefectsByArm.get(r.y) || [])];
    const high = decideWith(xQ, []); // every queued item resolved in X's favour
    const low = decideWith([], yQ); // every queued item resolved in Y's favour
    const point = decideWith([], []); // conservative: queued items are not matches

    const queueDominated = R.swingDominates(high, low);

    return {
      id: r.id,
      question: r.question,
      x: r.x,
      y: r.y,
      b: r.b,
      c: r.c,
      concordantBoth: r.both,
      concordantNeither: r.neither,
      p: r.p,
      pAdj: r.pAdj,
      marginMet: R.margin({ b: r.b, c: r.c, pAdj: r.pAdj }),
      pointDecision: point,
      swing: { favourX: high, favourY: low },
      queueDominated,
      decision: queueDominated ? "INCONCLUSIVE — QUEUE-DOMINATED" : point,
      reportable: !queueDominated,
    };
  });
}

export function discordance(xTp, yTp) {
  const X = new Set(xTp);
  const Y = new Set(yTp);
  const all = new Set([...X, ...Y]);
  let b = 0;
  let c = 0;
  let both = 0;
  for (const d of all) {
    const inX = X.has(d);
    const inY = Y.has(d);
    if (inX && inY) both += 1;
    else if (inX) b += 1;
    else c += 1;
  }
  return { b, c, both, neither: null };
}

/** Two-sided exact McNemar: p = 2 * P(Binom(b+c, 0.5) >= max(b,c)), capped at 1. */
export function mcnemarExactP(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const m = Math.max(b, c);
  let num = 0n;
  for (let k = m; k <= n; k += 1) num += binom(n, k);
  const den = 1n << BigInt(n);
  return Math.min(1, 2 * (Number(num) / Number(den)));
}

function binom(n, k) {
  let r = 1n;
  const kk = BigInt(Math.min(k, n - k));
  for (let i = 0n; i < kk; i += 1n) {
    r = (r * (BigInt(n) - i)) / (i + 1n);
  }
  return r;
}

/** Holm-Bonferroni across the pre-specified comparisons (§6.3). */
export function holm(ps) {
  const m = ps.length;
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const out = new Array(m);
  let running = 0;
  order.forEach((entry, rank) => {
    const adj = Math.min(1, (m - rank) * entry.p);
    running = Math.max(running, adj);
    out[entry.i] = running;
  });
  return out;
}

function fmtPct(x) {
  return x === null || x === undefined ? null : Number((x * 100).toFixed(1));
}

// ===========================================================================
// CLI — the only code in this repository that reads an answer key
// ===========================================================================

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/**
 * §8.2 — which frozen files have drifted. Exported (and rule-routed) so a self-test can
 * reach it: a freeze check only exercised inside `main()` is a gate nothing tests.
 */
export function freezeDrift(recordedHashes, computedHashes, R = RULES) {
  return Object.keys(computedHashes).filter((f) => !R.freezeCheck(recordedHashes?.[f], computedHashes[f]));
}

export function computeFreezeHashes(root) {
  const files = [
    "PRE-REGISTRATION.md",
    "score.mjs",
    "finding-schema.mjs",
    "lib/class-map.mjs",
    "exclusions.json",
    "budget.json",
  ];
  const out = {};
  for (const f of files) {
    const p = join(root, f);
    out[f] = existsSync(p) ? sha256File(p) : null;
  }
  return out;
}

function loadCorpus(corpusDir, resultsDir, armFilter) {
  const surveys = [];
  const ids = readdirSync(corpusDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const surveyId of ids) {
    const keyPath = join(corpusDir, surveyId, "truth", "answer-key.json");
    if (!existsSync(keyPath)) continue;
    const key = JSON.parse(readFileSync(keyPath, "utf8"));
    const runs = [];
    for (const arm of ARMS) {
      if (armFilter && !armFilter.includes(arm)) continue;
      const dir = join(resultsDir, arm);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).sort()) {
        if (!file.startsWith(surveyId) || !file.endsWith(".json") || file.endsWith(".telemetry.json")) continue;
        const result = JSON.parse(readFileSync(join(dir, file), "utf8"));
        const telPath = join(dir, file.replace(/\.json$/, ".telemetry.json"));
        const telemetry = existsSync(telPath) ? JSON.parse(readFileSync(telPath, "utf8")) : null;
        runs.push({ arm, seed: result.seed ?? null, result, telemetry });
      }
    }
    surveys.push({
      surveyId,
      tier: key.tier,
      isCleanControl: Boolean(key.is_clean_control),
      key,
      runs,
    });
  }
  return surveys;
}

function main(argv) {
  const args = parseArgs(argv);
  const root = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

  if (!args.corpus || !args.results) {
    console.error(
      "usage: node evaluation/score.mjs --corpus <dir> --results <dir> [--out <file>]\n" +
        "                                [--annotations <file>] [--exclusions <file>]\n" +
        "                                [--pilot] [--blind-queue] [--amend \"<reason>\"]",
    );
    process.exit(2);
  }

  // ---- §8.2 THE FREEZE ---------------------------------------------------
  const freezePath = join(root, "FREEZE.json");
  const computed = computeFreezeHashes(root);
  if (existsSync(freezePath)) {
    const frozen = JSON.parse(readFileSync(freezePath, "utf8"));
    const drift = freezeDrift(frozen.hashes, computed);
    if (drift.length) {
      if (!args.amend) {
        console.error(
          `FROZEN HARNESS MODIFIED — refusing to score.\n  changed: ${drift.join(", ")}\n` +
            `  The harness froze at ${frozen.frozenAt}. To proceed you must state why:\n` +
            `    --amend "<reason>"   (appended to AMENDMENTS.md and printed in the final report)`,
        );
        process.exit(3);
      }
      const line = `\n## ${new Date().toISOString()}\n\nChanged: ${drift.join(", ")}\n\n${args.amend}\n`;
      const amendPath = join(root, "AMENDMENTS.md");
      writeFileSync(
        amendPath,
        (existsSync(amendPath) ? readFileSync(amendPath, "utf8") : "# Amendments to a frozen harness\n") + line,
      );
      console.error(`WARNING: scoring with an amended harness. Recorded in ${amendPath}.`);
    }
  }

  const annotations = args.annotations && existsSync(args.annotations)
    ? JSON.parse(readFileSync(args.annotations, "utf8"))
    : {};
  const exclusions = args.exclusions && existsSync(args.exclusions)
    ? JSON.parse(readFileSync(args.exclusions, "utf8")).exclusions || []
    : [];

  const surveys = loadCorpus(args.corpus, args.results, args.arms);
  const card = scoreCorpus({
    surveys,
    annotations,
    exclusions,
    meta: {
      corpusId: args.corpus,
      pilot: Boolean(args.pilot) || /[\\/]pilot[\\/]?$/.test(args.results),
      scoredAt: new Date().toISOString(),
    },
  });

  card.freeze = { hashes: computed, amended: Boolean(args.amend), amendReason: args.amend || null };
  card.annotationsHash = createHash("sha256").update(JSON.stringify(annotations)).digest("hex");

  if (args.blindQueue) card.queue = card.queue.map((q) => ({ ...q, arm: "«blinded»" }));

  const outPath = args.out || join(root, "results", "scorecard.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFieldwise(outPath, card);
  writeFieldwise(join(dirname(outPath), "adjudication-queue.json"), { queue: card.queue });

  printSummary(card);
  process.exit(card.inconclusive.length ? 1 : 0);
}

function writeFieldwise(p, obj) {
  writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

function printSummary(card) {
  const h = card.headline;
  console.log(`\nsurvey-qa evaluation — ${card.scorecardVersion}`);
  console.log(`matcher ${card.matcherVersion} · vocab ${card.vocabVersion} · ${card.locatorRulesVersion}`);
  if (card.pilot) console.log("\n*** PILOT DATA — no headline comparison may be cited (§9.4) ***");
  console.log(
    `\nADJUDICATION QUEUE: ${h.adjudicationQueueSize} (${(h.adjudicationRate * 100).toFixed(1)}% of findings)` +
      (h.queueWarning ? `\n  ${h.queueWarning}` : ""),
  );
  console.log(
    `DENOMINATOR: ${h.denominator.defects} defects / ${h.denominator.ambiguities} ambiguities / ` +
      `${h.denominator.cleanControls} clean controls over ${h.denominator.surveys} surveys` +
      (h.exclusions ? ` (${h.exclusions} excluded)` : ""),
  );

  console.log("\narm  recall_s  recall_l  cc-FP  amb ✓/guess/miss  cov-honesty  cost/defect  flags");
  for (const a of Object.values(card.arms)) {
    console.log(
      `${a.arm.padEnd(4)} ${fmt(a.recallStrict).padEnd(9)} ${fmt(a.recallLenient).padEnd(9)} ` +
        `${String(a.cleanControlFp).padEnd(6)} ` +
        `${`${a.ambiguity.correct}/${a.ambiguity.guessed}/${a.ambiguity.missed}`.padEnd(16)} ` +
        `${fmt(a.coverageHonesty).padEnd(12)} ` +
        `${(a.costPerDefect === null ? "n/a" : `$${a.costPerDefect.toFixed(3)}`).padEnd(12)} ` +
        `${a.flags.join(",")}`,
    );
  }

  console.log("\ncomparison                                              b    c    p_adj   decision");
  for (const c of card.comparisons) {
    console.log(
      `${c.id} ${c.x} vs ${c.y} — ${c.question}`.slice(0, 54).padEnd(55) +
        `${String(c.b).padEnd(5)}${String(c.c).padEnd(5)}${c.pAdj.toFixed(4).padEnd(8)}${c.decision}`,
    );
  }

  if (card.regression?.designDefect) console.log(`\nHYBRID_REGRESSION: ${card.regression.size} defects a component found and C did not`);
  if (card.fpAmplification) console.log("\nFP_AMPLIFICATION: the hybrid produces more clean-control FPs than its components combined");

  if (card.inconclusive.length) {
    console.log("\nINCONCLUSIVE:");
    for (const i of card.inconclusive) console.log(`  ${i.code}${i.arm ? ` [${i.arm}]` : ""}${i.comparison ? ` [${i.comparison}]` : ""} — ${i.detail}`);
    console.log("\nThe experiment did not decide. Per §6.8 the architecture choice reverts to the");
    console.log("owner on non-empirical grounds. We do not narrate a winner out of a non-significant gap.");
  }
  console.log("");
}

function fmt(x) {
  return x === null || x === undefined ? "n/a" : x.toFixed(3);
}

function parseArgs(argv) {
  const a = { arms: null };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--corpus") a.corpus = argv[++i];
    else if (t === "--results") a.results = argv[++i];
    else if (t === "--out") a.out = argv[++i];
    else if (t === "--annotations") a.annotations = argv[++i];
    else if (t === "--exclusions") a.exclusions = argv[++i];
    else if (t === "--arms") a.arms = argv[++i].split(",");
    else if (t === "--pilot") a.pilot = true;
    else if (t === "--blind-queue") a.blindQueue = true;
    else if (t === "--amend") a.amend = argv[++i];
  }
  return a;
}

if (process.argv[1] && process.argv[1].endsWith("score.mjs")) main(process.argv.slice(2));

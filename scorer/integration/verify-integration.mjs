#!/usr/bin/env node
// verify-integration.mjs — P0 INTEGRATION PROOF assertions + diagnostics.
//
// Runs the scorer CLI twice per run (determinism), asserts the load-bearing
// outcomes of the integration proof, and emits the matcher/defect-matcher
// diagnostics that the scorecard does not print for NON-matches:
//
//   - per-obligation candidate scores for every unmatched tester item and every
//     unmatched oracle obligation (why did extraction miss?);
//   - the COUPLING CHECK: per-side (expected/observed) similarities of every
//     asserted finding against every seeded defect under the SHIPPED
//     defect-matcher 1.1.0, against its 0.3 per-side floor and 0.45 threshold.
//
// It never mutates the run records: a failed assertion is reported, not fixed.
//
// Run: node scorer/integration/verify-integration.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MATCHER_PROFILE, scorePair, stringSim, normalizeText } from "../src/lib/matcher.mjs";
import { DEFECT_MATCHER_PROFILE } from "../src/lib/defect-match.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CLI = path.resolve(HERE, "..", "src", "score-run.mjs");
const ORACLE_DIR = path.resolve(HERE, "..", "oracle", "generated");
const RESULTS = path.join(HERE, "results");
mkdirSync(RESULTS, { recursive: true });

const NOW = "2026-08-01T13:00:00Z";
const CASES = [
  {
    name: "clean",
    runPath: path.join(HERE, "runs", "clean", "run-record.json"),
    oraclePath: path.join(ORACLE_DIR, "s1-skip.clean.json"),
    artifactsDir: path.join(HERE, "artifacts", "RUN-INT-S1-CLEAN"),
  },
  {
    name: "flawed",
    runPath: path.join(HERE, "runs", "flawed", "run-record.json"),
    oraclePath: path.join(ORACLE_DIR, "s1-skip.flawed.json"),
    artifactsDir: path.join(HERE, "artifacts", "RUN-INT-S1-FLAWED"),
  },
];

const failures = [];
const note = (s) => console.log(s);
function assert(ok, label, detail) {
  if (ok) {
    note(`  PASS  ${label}`);
  } else {
    note(`  FAIL  ${label} -- ${detail}`);
    failures.push({ assertion: label, detail });
  }
}

function runCli(c, outFile) {
  const out = execFileSync(
    process.execPath,
    // --fixture-keys: the integration runs are signed with the checked-in
    // TEST-ONLY harness key, which the scorer refuses as a trust anchor unless
    // it is named explicitly (audit finding 13). A real run passes --keys.
    [
      CLI,
      c.runPath,
      c.oraclePath,
      "--artifacts-dir",
      c.artifactsDir,
      "--fixture-keys",
      "--now",
      NOW,
      "--out",
      outFile,
    ],
    { cwd: REPO, encoding: "utf8" }
  );
  return out;
}

/* ------------------------------ scoring -------------------------------- */

const cards = {};
const determinism = {};
for (const c of CASES) {
  const f1 = path.join(RESULTS, `${c.name}-scorecard.json`);
  const f2 = path.join(RESULTS, `${c.name}-scorecard.rerun.json`);
  runCli(c, f1);
  runCli(c, f2);
  const a = readFileSync(f1);
  const b = readFileSync(f2);
  determinism[c.name] = a.equals(b);
  cards[c.name] = JSON.parse(a.toString("utf8"));
}

/* ------------------------ extraction diagnostics ------------------------ */

function matcherDiagnostics(caseName) {
  const c = CASES.find((x) => x.name === caseName);
  const run = JSON.parse(readFileSync(c.runPath, "utf8"));
  const oracle = JSON.parse(readFileSync(c.oraclePath, "utf8"));
  const card = cards[caseName];
  const rows = [];
  const unmatchedItems = new Set(card.matching.unmatchedTesterItemIds);
  const unmatchedOracle = new Set(card.matching.unmatchedOracleIds);
  for (const item of run.contract.items) {
    if (!unmatchedItems.has(item.itemId)) continue;
    const cands = oracle.obligations
      .map((o) => ({ oracleId: o.oracleId, score: Number(scorePair(item, o).toFixed(6)), sameType: item.type === o.type }))
      .filter((x) => x.sameType)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    rows.push({
      itemId: item.itemId,
      type: item.type,
      eligibilityThreshold: MATCHER_PROFILE.eligibilityThreshold,
      topCandidates: cands,
      shortfall: cands.length ? Number((MATCHER_PROFILE.eligibilityThreshold - cands[0].score).toFixed(6)) : null,
    });
  }
  const orphanOracle = [...unmatchedOracle].map((oid) => {
    const o = oracle.obligations.find((x) => x.oracleId === oid);
    const best = run.contract.items
      .filter((i) => i.type === o.type)
      .map((i) => ({ itemId: i.itemId, score: Number(scorePair(i, o).toFixed(6)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    return { oracleId: oid, type: o.type, oracleHasQuote: Boolean(o.sourceAnchor.quote), topTesterItems: best };
  });
  return { unmatchedTesterItems: rows, unmatchedOracleObligations: orphanOracle };
}

/* --------------------- COUPLING CHECK (defect matcher) ------------------ */

function couplingCheck() {
  const c = CASES.find((x) => x.name === "flawed");
  const run = JSON.parse(readFileSync(c.runPath, "utf8"));
  const oracle = JSON.parse(readFileSync(c.oraclePath, "utf8"));
  const P = DEFECT_MATCHER_PROFILE;
  const card = cards.flawed;
  const tp = new Map(card.defects.truePositives.map((t) => [t.defectId, t.findingId]));

  const pairs = [];
  for (const d of oracle.seededDefects) {
    for (const f of run.findings.filter((x) => x.kind === "defect")) {
      const expectedSim = Number(stringSim(f.expected, d.expected.requirement).toFixed(6));
      const observedSim = Number(stringSim(f.observed, d.observed.requirement).toFixed(6));
      const combined = Number((P.weights.expected * expectedSim + P.weights.observed * observedSim).toFixed(6));
      const floorOk = expectedSim >= P.minSideSimilarity && observedSim >= P.minSideSimilarity;
      pairs.push({
        defectId: d.defectId,
        findingId: f.findingId,
        intendedPair: f.itemRefs.some((ir) => {
          const m = card.matching.matches.find((mm) => mm.itemId === ir);
          return m && d.affectedObligationIds.includes(m.oracleId);
        }),
        expectedSim,
        observedSim,
        combined,
        clearsSideFloor: floorOk,
        clearsThreshold: floorOk && combined >= P.eligibilityThreshold,
      });
    }
  }
  const perDefect = oracle.seededDefects.map((d) => {
    const intended = pairs.filter((p) => p.defectId === d.defectId && p.intendedPair);
    const best = intended.sort((a, b) => b.combined - a.combined)[0] ?? null;
    return {
      defectId: d.defectId,
      category: d.category,
      matched: tp.has(d.defectId),
      creditedFindingId: tp.get(d.defectId) ?? null,
      itemMappingReachesAffectedObligation: intended.length > 0,
      intendedFinding: best
        ? {
            findingId: best.findingId,
            expectedSim: best.expectedSim,
            observedSim: best.observedSim,
            combined: best.combined,
            minSideSimilarity: P.minSideSimilarity,
            eligibilityThreshold: P.eligibilityThreshold,
            clearsSideFloor: best.clearsSideFloor,
            clearsThreshold: best.clearsThreshold,
            sideShortfall: {
              expected: Number((P.minSideSimilarity - best.expectedSim).toFixed(6)),
              observed: Number((P.minSideSimilarity - best.observedSim).toFixed(6)),
            },
            thresholdShortfall: Number((P.eligibilityThreshold - best.combined).toFixed(6)),
          }
        : null,
      oracleExpected: d.expected.requirement,
      oracleObserved: d.observed.requirement,
    };
  });
  return { profile: { ...P, approvedCleanTargetCorrections: [...P.approvedCleanTargetCorrections] }, perDefect, allPairs: pairs };
}

/* ------------- diagnosis: how far off is the oracle's register? --------- */
// PURE DIAGNOSTIC. These variants are NOT fed into any scored run; they only
// characterise the sensitivity of the shipped matchers so the gap can be
// attributed (agent prose vs terse machine-generated oracle strings).

function sensitivityProbe() {
  const oracle = JSON.parse(readFileSync(CASES[1].oraclePath, "utf8"));
  const P = DEFECT_MATCHER_PROFILE;
  const byId = new Map(oracle.seededDefects.map((d) => [d.defectId, d]));
  const variants = [
    {
      defectId: "S1-E01",
      label: "as-shipped agent prose",
      expected: "Answering No at Q2 should take the respondent to Q5, the barriers question.",
      observed: "After answering No at Q2 the survey jumped straight to Q6, so Q5 was never shown.",
    },
    {
      defectId: "S1-E01",
      label: "terse spec register",
      expected: "Q2=2 (No) should skip to Q5.",
      observed: "Q2=2 (No) skips to Q6.",
    },
    {
      defectId: "S1-E02",
      label: "as-shipped agent prose",
      expected: "Q3 should offer BIMZELX as the fifth brand option.",
      observed: "Q3 rendered only four brands (SKYRIZI, TREMFYA, COSENTYX, TALTZ); BIMZELX is absent.",
    },
    {
      defectId: "S1-E02",
      label: "terse spec register",
      expected: "Q3: option 5 BIMZELX",
      observed: "BIMZELX is missing from the Q3 option list on the site.",
    },
    {
      defectId: "S1-E03",
      label: "as-shipped agent prose",
      expected: "Q3 should display the instruction 'Select all that apply.'",
      observed: "No 'Select all that apply.' instruction is shown above the Q3 options.",
    },
  ];
  return variants.map((v) => {
    const d = byId.get(v.defectId);
    const e = Number(stringSim(v.expected, d.expected.requirement).toFixed(6));
    const o = Number(stringSim(v.observed, d.observed.requirement).toFixed(6));
    const combined = Number((P.weights.expected * e + P.weights.observed * o).toFixed(6));
    return {
      defectId: v.defectId,
      label: v.label,
      expectedSim: e,
      observedSim: o,
      combined,
      clears: e >= P.minSideSimilarity && o >= P.minSideSimilarity && combined >= P.eligibilityThreshold,
    };
  });
}

/* ------------------------------ assertions ----------------------------- */

note("\n=== (a) CLEAN run: s1-skip.clean =====================================");
const clean = cards.clean;
assert(clean.integrity.status === "valid", "clean: integrity status valid", JSON.stringify(clean.integrity));
assert(
  Object.values(clean.integrity.gates).every((g) => g === "passed"),
  "clean: every integrity gate passed",
  JSON.stringify(clean.integrity.gates)
);
assert(clean.errors.length === 0, "clean: no errors", JSON.stringify(clean.errors));
assert(clean.metrics.extractionRecall === 1, "clean: extractionRecall == 1", `got ${clean.metrics.extractionRecall} (${clean.matching.matched}/${clean.matching.oracleObligations}); unmatched oracle: ${clean.matching.unmatchedOracleIds.join(", ")}`);
assert(clean.metrics.extractionPrecision === 1, "clean: extractionPrecision == 1", `got ${clean.metrics.extractionPrecision}; unmatched tester items: ${clean.matching.unmatchedTesterItemIds.join(", ")}`);
assert(clean.metrics.reachableCoverage === 1, "clean: reachableCoverage == 1", `got ${clean.metrics.reachableCoverage} (${clean.metrics.reachableExercisedVerified}/${clean.metrics.reachableObligations})`);
assert(clean.completeness.testComplete === true, "clean: testComplete", `unaccounted oracle: ${clean.completeness.unaccountedOracleIds.join(", ")}`);
assert(clean.metrics.evidenceCompleteness === 1, "clean: evidenceCompleteness == 1", `got ${clean.metrics.evidenceCompleteness}`);
assert(clean.matching.ambiguous.length === 0, "clean: no ambiguous matches", JSON.stringify(clean.matching.ambiguous));
assert(clean.matching.duplicates.length === 0, "clean: no duplicate items", JSON.stringify(clean.matching.duplicates));
assert(clean.defects.falsePositives.length === 0, "clean: no defect false positives", JSON.stringify(clean.defects.falsePositives));
assert(clean.resources.costKnown && clean.resources.limitsOk, "clean: cost known and limits ok", JSON.stringify(clean.resources));

note("\n=== (b) FLAWED run: s1-skip.flawed ===================================");
const flawed = cards.flawed;
assert(flawed.integrity.status === "valid", "flawed: integrity status valid", JSON.stringify(flawed.integrity));
assert(flawed.errors.length === 0, "flawed: no errors", JSON.stringify(flawed.errors));
assert(flawed.metrics.seededDefectRecall === 1, "flawed: seededDefectRecall == 3/3", `got ${flawed.metrics.seededDefectRecall}; missed: ${flawed.defects.falseNegatives.join(", ")}`);
assert(flawed.defects.falsePositives.length === 0, "flawed: no defect false positives", `got ${JSON.stringify(flawed.defects.falsePositives)}`);
assert(flawed.metrics.seededDefectPrecision === 1, "flawed: seededDefectPrecision == 1", `got ${flawed.metrics.seededDefectPrecision}`);
assert(flawed.completeness.testComplete === true, "flawed: testComplete", `unaccounted oracle: ${flawed.completeness.unaccountedOracleIds.join(", ")}`);
assert(flawed.metrics.evidenceCompleteness === 1, "flawed: evidenceCompleteness == 1", `got ${flawed.metrics.evidenceCompleteness}`);

// Newly-reachable semantics: in the FLAWED variant the defect-affected
// obligations must stay REACHABLE and be exercised+fail, never unreachable.
{
  const oracle = JSON.parse(readFileSync(CASES[1].oraclePath, "utf8"));
  const run = JSON.parse(readFileSync(CASES[1].runPath, "utf8"));
  const affected = [...new Set(oracle.seededDefects.flatMap((d) => d.affectedObligationIds))].sort();
  const unreachable = oracle.obligations.filter((o) => o.reachability.status === "unreachable").map((o) => o.oracleId);
  const oracleById = new Map(oracle.obligations.map((o) => [o.oracleId, o]));
  const oracleToItem = new Map(flawed.matching.matches.map((m) => [m.oracleId, m.itemId]));
  const resultById = new Map(run.itemResults.map((r) => [r.itemId, r]));
  const rows = affected.map((oid) => {
    const itemId = oracleToItem.get(oid) ?? null;
    const r = itemId ? resultById.get(itemId) : null;
    return {
      oracleId: oid,
      reachability: oracleById.get(oid).reachability.status,
      testerItemId: itemId,
      coverageStatus: r?.coverageStatus ?? null,
      verdict: r?.verdict ?? null,
    };
  });
  const ok =
    unreachable.length === 0 &&
    rows.every((r) => r.reachability === "reachable" && r.coverageStatus === "exercised" && r.verdict === "fail");
  assert(ok, "flawed: defect-affected obligations stay reachable and are exercised+fail (exercise-point semantics)", JSON.stringify({ unreachable, rows }));
  globalThis.__newlyReachable = { unreachableObligations: unreachable, affected: rows, ok };
}

note("\n=== determinism =======================================================");
for (const c of CASES) {
  assert(determinism[c.name], `${c.name}: two CLI runs produce byte-identical scorecards`, "scorecards differ");
}

/* ------------------------------- report -------------------------------- */

const report = {
  generatedAt: NOW,
  matcherVersion: clean.matcherVersion,
  defectMatcherVersion: clean.defectMatcherVersion,
  evidencePolicyVersion: clean.evidencePolicyVersion,
  pricingVersion: clean.pricingVersion,
  clean: {
    subject: clean.subject,
    integrity: clean.integrity,
    errors: clean.errors,
    warnings: clean.warnings,
    metrics: clean.metrics,
    completeness: clean.completeness,
    matchedScores: clean.matching.matches,
    diagnostics: matcherDiagnostics("clean"),
  },
  flawed: {
    subject: flawed.subject,
    integrity: flawed.integrity,
    errors: flawed.errors,
    warnings: flawed.warnings,
    metrics: flawed.metrics,
    completeness: flawed.completeness,
    defects: flawed.defects,
    diagnostics: matcherDiagnostics("flawed"),
    newlyReachable: globalThis.__newlyReachable,
  },
  couplingCheck: couplingCheck(),
  sensitivityProbe: sensitivityProbe(),
  determinism,
  failures,
};
const reportPath = path.join(RESULTS, "integration-report.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");

note("\n=== extraction diagnostics (unmatched) ================================");
note(JSON.stringify(report.clean.diagnostics, null, 2));
note("\n=== coupling check (defect matcher 1.1.0) ============================");
for (const d of report.couplingCheck.perDefect) {
  const f = d.intendedFinding;
  note(
    `  ${d.defectId} (${d.category}) matched=${d.matched}` +
      (f
        ? ` finding=${f.findingId} expectedSim=${f.expectedSim} observedSim=${f.observedSim} combined=${f.combined} ` +
          `[floor ${f.minSideSimilarity} ${f.clearsSideFloor ? "OK" : "MISS"}] [threshold ${f.eligibilityThreshold} ${f.clearsThreshold ? "OK" : "MISS"}]`
        : " (no finding maps onto an affected obligation)")
  );
}
note("\n=== sensitivity probe (DIAGNOSTIC ONLY, not scored) ==================");
for (const s of report.sensitivityProbe) {
  note(`  ${s.defectId} [${s.label}] expected=${s.expectedSim} observed=${s.observedSim} combined=${s.combined} clears=${s.clears}`);
}

note(`\nreport written to ${path.relative(REPO, reportPath)}`);
note(failures.length === 0 ? "\nRESULT: INTEGRATION-PROVEN" : `\nRESULT: GAPS-FOUND (${failures.length} failed assertions)`);
process.exit(0);

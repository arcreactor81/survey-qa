#!/usr/bin/env node
// Survey-QA scorer core (P0).
//
// Usage:
//   node score-run.mjs <run-record.json> <oracle-record.json>
//        [--artifacts-dir <dir>] [--keys <registry.json>] [--fixture-keys]
//        [--now <iso8601>] [--out <scorecard.json>]
//
// TRUST ANCHOR: there is NO default key registry. With neither --keys nor
// --fixture-keys the attestation gate fails closed. The checked-in fixture
// registry publishes its own private key, so it is usable only under the
// explicit --fixture-keys opt-in (or SURVEY_QA_ALLOW_FIXTURE_KEYS=1).
//
// Implements the fail-closed validation and scoring order of
// scorer/docs/threat-model.md §4:
//   1. strict JSON parse (rejects duplicate object keys / non-JSON),
//   2. schema validation (RunRecord/OracleRecord 1.0.0),
//   3. harness attestation (Ed25519 over RFC 8785 payload hash),
//   4. subject identity agreement (+ §9 oracle-isolation scan),
//   5. structural integrity (IDs, cross-refs, lineage, chronology,
//      contract-hash, denominator set equality),
//   6. obligation matching (§5),
//   7. evidence integrity + sufficiency (§7) and resource reconciliation (§10),
//   8. quality and cost metrics (§ proposal 3/5/7).
//
// Identity/attestation failure suppresses quality scores: an invalid subject
// never receives a low-but-plausible score.
//
// Determinism: identical inputs produce byte-identical scorecards. The only
// timestamp is `scoredAt`, which is null unless injected with --now.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { strictParse, buildValidators, formatAjvErrors } from "./lib/validate.mjs";
import { verifyAttestation, resolveKeyRegistry } from "./lib/attest.mjs";
import {
  checkOracleIntegrity,
  checkIdentity,
  checkOracleAccess,
  checkRunIntegrity,
} from "./lib/integrity.mjs";
import { MATCHER_PROFILE, matchObligations } from "./lib/matcher.mjs";
import { DEFECT_MATCHER_PROFILE, matchDefects } from "./lib/defect-match.mjs";
import { EVIDENCE_POLICY_VERSION, assessArtifacts, assessClaims } from "./lib/evidence.mjs";
import { PRICING, reconcileResources } from "./lib/resources.mjs";
import { computeMetricsAndCompleteness } from "./lib/metrics.mjs";

export const SCORECARD_VERSION = "1.0.0";

function sortDiag(list) {
  return [...list].sort((a, b) =>
    a.code === b.code ? (a.message < b.message ? -1 : a.message > b.message ? 1 : 0) : a.code < b.code ? -1 : 1
  );
}

function newCard(now) {
  return {
    scorecardVersion: SCORECARD_VERSION,
    scoredAt: now ?? null,
    matcherVersion: MATCHER_PROFILE.matcherVersion,
    defectMatcherVersion: DEFECT_MATCHER_PROFILE.defectMatcherVersion,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    pricingVersion: PRICING.version,
    subject: {
      runId: null,
      oracleRecordId: null,
      surveyId: null,
      variantKind: null,
      documentHash: null,
      buildId: null,
    },
    integrity: {
      status: "invalid",
      evaluationInvalid: false,
      gates: {
        parse: "pending",
        schema: "pending",
        attestation: "pending",
        identity: "pending",
        oracleIsolation: "pending",
        structure: "pending",
        evidence: "pending",
        resources: "pending",
        cost: "pending",
      },
    },
    errors: [],
    warnings: [],
    completeness: null,
    matching: null,
    defects: null,
    evidence: null,
    resources: null,
    metrics: null,
  };
}

/**
 * Score one run against one oracle. Fail-closed; always returns a scorecard.
 * @param {object} opts { runPath, oraclePath, artifactsDir, keysPath,
 *                        allowFixtureKeys, now }
 */
export function scoreRun(opts) {
  const card = newCard(opts.now ?? null);
  const errors = [];
  const warnings = [];
  const gates = card.integrity.gates;

  const finish = () => {
    card.errors = sortDiag(errors);
    card.warnings = sortDiag(warnings);
    for (const k of Object.keys(gates)) {
      if (gates[k] === "pending") gates[k] = "not-reached";
    }
    return card;
  };
  const hardFail = () => {
    card.integrity.status = "invalid";
    card.completeness = null;
    card.matching = null;
    card.defects = null;
    card.evidence = null;
    card.resources = null;
    card.metrics = null; // suppressed: never a low-but-plausible score
    return finish();
  };

  /* ---- step 1: strict parse ---- */
  let runRaw;
  let oracleRaw;
  let run;
  let oracle;
  try {
    runRaw = readFileSync(opts.runPath, "utf8");
  } catch (e) {
    errors.push({ code: "RUN_PARSE_INVALID", message: `cannot read run record: ${e.message}` });
    gates.parse = "failed";
    return hardFail();
  }
  try {
    oracleRaw = readFileSync(opts.oraclePath, "utf8");
  } catch (e) {
    errors.push({ code: "ORACLE_PARSE_INVALID", message: `cannot read oracle record: ${e.message}` });
    gates.parse = "failed";
    return hardFail();
  }
  try {
    run = strictParse(runRaw);
  } catch (e) {
    errors.push({ code: "RUN_PARSE_INVALID", message: `run record is not canonical JSON: ${e.message}` });
    gates.parse = "failed";
    return hardFail();
  }
  try {
    oracle = strictParse(oracleRaw);
  } catch (e) {
    errors.push({ code: "ORACLE_PARSE_INVALID", message: `oracle record is not canonical JSON: ${e.message}` });
    gates.parse = "failed";
    return hardFail();
  }
  gates.parse = "passed";

  /* ---- step 2: schema validation ---- */
  const { validateRun, validateOracle } = buildValidators();
  if (!validateOracle(oracle)) {
    errors.push({
      code: "ORACLE_SCHEMA_INVALID",
      message: `oracle record violates oracle-record 1.0.0: ${formatAjvErrors(validateOracle.errors)}`,
    });
    gates.schema = "failed";
    return hardFail();
  }
  card.subject.oracleRecordId = oracle.oracleRecordId;
  card.subject.surveyId = oracle.survey.surveyId;
  card.subject.variantKind = oracle.survey.variant.kind;
  const oracleIntegrityErrors = checkOracleIntegrity(oracle);
  if (oracleIntegrityErrors.length > 0) {
    errors.push(...oracleIntegrityErrors);
    gates.schema = "failed";
    return hardFail();
  }
  if (!validateRun(run)) {
    errors.push({
      code: "RUN_SCHEMA_INVALID",
      message: `run record violates run-record 1.0.0: ${formatAjvErrors(validateRun.errors)}`,
    });
    gates.schema = "failed";
    return hardFail();
  }
  gates.schema = "passed";
  card.subject.runId = run.run.runId;
  card.subject.documentHash = run.run.documentHash;
  card.subject.buildId = run.run.target.buildId;

  /* ---- step 3: harness attestation ---- */
  // Fail-closed trust anchor: no silent default, and the published fixture
  // registry is refused unless the caller explicitly named it as such.
  const anchor = resolveKeyRegistry({
    keysPath: opts.keysPath ?? null,
    allowFixtureKeys: opts.allowFixtureKeys === true,
    fallbackToFixtures: true,
  });
  if (!anchor.ok) {
    errors.push({ code: "ATTESTATION_INVALID", message: `${anchor.code}: ${anchor.message}` });
    gates.attestation = "failed";
    return hardFail();
  }
  const keyRegistry = anchor.registry;
  const att = verifyAttestation(run, keyRegistry);
  if (!att.ok) {
    errors.push({ code: att.code, message: att.message });
    gates.attestation = "failed";
    return hardFail();
  }
  gates.attestation = "passed";

  /* ---- step 4: subject identity ---- */
  const identityErrors = checkIdentity(run, oracle);
  if (identityErrors.length > 0) {
    errors.push(...identityErrors);
    gates.identity = "failed";
    return hardFail();
  }
  gates.identity = "passed";

  /* ---- §9 oracle isolation ---- */
  const accessErrors = checkOracleAccess(runRaw, run, oracle);
  if (accessErrors.length > 0) {
    errors.push(...accessErrors);
    gates.oracleIsolation = "failed";
    card.integrity.evaluationInvalid = true;
    return hardFail();
  }
  gates.oracleIsolation = "passed";

  /* ---- step 5: structural integrity ---- */
  const structure = checkRunIntegrity(run);
  if (structure.hard.length > 0) {
    errors.push(...structure.hard, ...structure.soft);
    gates.structure = "failed";
    return hardFail();
  }
  errors.push(...structure.soft);
  gates.structure = structure.soft.length === 0 ? "passed" : "degraded";
  const index = structure.index;

  /* ---- step 6: obligation matching (§5) ---- */
  const matching = matchObligations(run.contract.items, oracle.obligations);
  for (const amb of matching.ambiguous) {
    errors.push({
      code: "MATCH_AMBIGUOUS",
      message: `item ${amb.itemId}: an alternate global assignment (total ${amb.alternateTotal} vs optimum ${amb.optimalTotal}, margin ${amb.margin}) remaps it from ${amb.assignedOracleId} to ${amb.alternateOracleId}; no automatic match, no credit; scorer-side adjudication required`,
    });
  }
  for (const dup of matching.duplicates) {
    warnings.push({
      code: "DUPLICATE_ITEM",
      message: `item ${dup.itemId} duplicates ${dup.duplicateOf}; flagged extraneous, cannot inflate coverage`,
    });
    const a = index.resultByItemId.get(dup.itemId);
    const b = index.resultByItemId.get(dup.duplicateOf);
    if (a && b && (a.coverageStatus !== b.coverageStatus || a.verdict !== b.verdict)) {
      errors.push({
        code: "DUPLICATE_CONFLICT",
        message: `duplicate items ${dup.itemId}/${dup.duplicateOf} carry conflicting dispositions`,
      });
    }
  }

  /* ---- step 7a: evidence integrity + sufficiency (§7) ---- */
  const artifactsDir = opts.artifactsDir ?? path.join(path.dirname(opts.runPath), "artifacts");
  const artifacts = assessArtifacts(run, artifactsDir, index);
  errors.push(...artifacts.errors);
  const oracleById = new Map(oracle.obligations.map((o) => [o.oracleId, o]));
  const claims = assessClaims({
    run,
    index,
    artifactStatus: artifacts.status,
    itemToOracle: matching.itemToOracle,
    oracleById,
  });
  errors.push(...claims.errors);
  warnings.push(...claims.warnings);
  const rejectedArtifacts = [...artifacts.status.entries()]
    .filter(([, st]) => !st.valid)
    .map(([evidenceId, st]) => ({ evidenceId, code: st.code }))
    .sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : 1));
  gates.evidence = rejectedArtifacts.length === 0 ? "passed" : "failed";

  /* ---- step 7b: resource reconciliation (§10) ---- */
  const resources = reconcileResources(run);
  errors.push(...resources.errors);
  warnings.push(...resources.warnings);
  gates.resources = resources.errors.length === 0 ? "passed" : "failed";
  gates.cost = resources.costKnown && resources.limitsOk ? "passed" : "failed";

  /* ---- step 8: defect matching (§6) + metrics ---- */
  const defects = matchDefects({
    findings: run.findings,
    seededDefects: oracle.seededDefects,
    itemToOracle: matching.itemToOracle,
    findingSufficient: claims.findingSufficient,
    cleanTarget: oracle.survey.variant.kind === "clean",
  });
  for (const amb of defects.ambiguous) {
    errors.push({
      code: "MATCH_AMBIGUOUS",
      message: `defect finding ${amb.findingId}: an alternate global assignment (total ${amb.alternateTotal} vs optimum ${amb.optimalTotal}) remaps it from ${amb.assignedDefectId} to ${amb.alternateDefectId}; no automatic true positive; scorer-side adjudication required`,
    });
  }
  for (const red of defects.redundant) {
    warnings.push({
      code: "DEFECT_FINDING_REDUNDANT",
      message: `finding ${red.findingId} restates seeded defect ${red.defectId} already credited to ${red.duplicateOfFindingId}; redundant (no extra recall, not a false positive)`,
    });
  }

  const { completeness, metrics } = computeMetricsAndCompleteness({
    run,
    oracle,
    index,
    matching,
    defects,
    claims,
    resources,
  });

  card.integrity.status = errors.length === 0 ? "valid" : "degraded";
  card.completeness = completeness;
  card.matching = {
    profile: {
      matcherVersion: MATCHER_PROFILE.matcherVersion,
      normalization: MATCHER_PROFILE.normalization,
      locatorCanonicalization: MATCHER_PROFILE.locatorCanonicalization,
      weights: {
        anchor: MATCHER_PROFILE.weights.anchor,
        requirement: MATCHER_PROFILE.weights.requirement,
      },
      eligibilityThreshold: MATCHER_PROFILE.eligibilityThreshold,
      ambiguityMargin: MATCHER_PROFILE.ambiguityMargin,
      ambiguityRule: MATCHER_PROFILE.ambiguityRule,
    },
    contractItems: run.contract.items.length,
    oracleObligations: oracle.obligations.length,
    matched: matching.matches.length,
    matches: matching.matches,
    duplicates: matching.duplicates,
    ambiguous: matching.ambiguous,
    unmatchedTesterItemIds: matching.unmatchedTesterItemIds,
    unmatchedOracleIds: matching.unmatchedOracleIds,
  };
  card.defects = {
    profile: {
      defectMatcherVersion: DEFECT_MATCHER_PROFILE.defectMatcherVersion,
      ambiguityRule: DEFECT_MATCHER_PROFILE.ambiguityRule,
      duplicatePolicy: DEFECT_MATCHER_PROFILE.duplicatePolicy,
    },
    seededTotal: oracle.seededDefects.length,
    asserted: defects.assertedCount,
    precisionDenominator: defects.precisionDenominator,
    truePositives: defects.truePositives,
    falsePositives: defects.falsePositives,
    redundant: defects.redundant,
    unsupported: defects.unsupported,
    falseNegatives: defects.falseNegatives,
    ambiguous: defects.ambiguous,
  };
  card.evidence = {
    policyVersion: EVIDENCE_POLICY_VERSION,
    artifactsTotal: run.evidence.length,
    artifactsValid: run.evidence.length - rejectedArtifacts.length,
    artifactsRejected: rejectedArtifacts,
    requiredClaims: claims.requiredClaims,
    sufficientClaims: claims.sufficientClaims,
  };
  card.resources = {
    costKnown: resources.costKnown,
    limitsOk: resources.limitsOk,
    reportedTotals: run.resources.totals,
    recomputed: resources.recomputed,
  };
  card.metrics = metrics;
  return finish();
}

export function renderScorecard(card) {
  return JSON.stringify(card, null, 2) + "\n";
}

/* --------------------------------- CLI --------------------------------- */

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--artifacts-dir") opts.artifactsDir = argv[++i];
    else if (a === "--keys") opts.keysPath = argv[++i];
    else if (a === "--fixture-keys") opts.allowFixtureKeys = true;
    else if (a === "--now") opts.now = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 2) {
    throw new Error(
      "usage: node score-run.mjs <run-record.json> <oracle-record.json> [--artifacts-dir d] [--keys registry.json] [--fixture-keys] [--now iso8601] [--out file]"
    );
  }
  opts.runPath = path.resolve(positional[0]);
  opts.oraclePath = path.resolve(positional[1]);
  if (opts.artifactsDir) opts.artifactsDir = path.resolve(opts.artifactsDir);
  if (opts.keysPath) opts.keysPath = path.resolve(opts.keysPath);
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(e.message + "\n");
    process.exit(2);
  }
  const card = scoreRun(opts);
  const text = renderScorecard(card);
  if (opts.out) writeFileSync(opts.out, text);
  process.stdout.write(text);
  process.exit(0);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();

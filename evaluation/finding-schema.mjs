/**
 * THE NORMALISED FINDING FORMAT — one format, all conditions.
 *
 * Pre-registered in PRE-REGISTRATION.md §3. Hashed into FREEZE.json.
 *
 * The whole point of this file is that `score.mjs` never needs to know which arm produced
 * a result. If the scorer ever needs an arm-specific branch, the format is wrong and the
 * FORMAT gets fixed — not the scorer (§8.1, maturity gate M5).
 *
 * Deliberate omissions, taken from the repo's own rulings:
 *  - `severity` is absent. merged-contract §1: severity has ZERO matching weight, and
 *    worker-v2 sets it null on purpose. A slot invites a default; a default invites use.
 *  - `confidence` is nullable and MUST NOT be defaulted. Same reason.
 *  - `prose` is required for human review and carries ZERO matching weight. The scorer
 *    reads it for exactly one purpose: the oracle-leak check (§8.4).
 */

import {
  REQUIREMENT_CLASSES,
  PREDICATES,
  predicateAdmissible,
} from "./lib/class-map.mjs";

export const FINDING_SCHEMA_VERSION = "survey-qa-eval-finding/1.1.0";

/**
 * 1.1.0 ADDS ONE REQUIRED BLOCK: `armIdentity` (evaluation/arms/ARCHITECTURE.md §5).
 *
 * WHY `armVersion` WAS NOT ENOUGH, and why this is not decoration. §3.1 pins
 * `armVersion: "<git sha>"`. A commit sha cannot witness build parity on THIS repository:
 * `evaluation/`, `worker-v2/`, `graph-spike/` and `pipeline/` are entirely untracked at
 * HEAD, so four arms built hours apart from a dirty tree all report the same sha and can
 * contain different code. It also cannot witness that the arm's MANIFEST describes what the
 * arm actually loaded. Both failures produce a plausible number, which is the shape this
 * repository has shipped before.
 *
 * `armVersion` is RETAINED unchanged. This block is additive.
 *
 * Raised as a proposed amendment to PRE-REGISTRATION.md §3.1 rather than made quietly —
 * ARCHITECTURE.md §11.2. Landable without `--amend` only because the freeze has not
 * occurred: `evaluation/FREEZE.json` does not exist, and §8.2 freezes at the FIRST SCORED
 * RUN. After that, this is an amendment with a written reason printed in the report.
 */
export const ARM_IDENTITY_FIELDS = [
  "armId",
  "sourceSha",
  "treeHash",
  "manifestHash",
  "componentSetHash",
  "buildId",
];

export const CLAIM_CLASSES = ["defect", "ambiguity", "observation", "blocker"];
export const LOCATION_SCOPES = ["question", "screen", "route", "survey"];
export const ATTRIBUTIONS = ["graph", "model", "graph-located-model-judged", "unattributed"];
export const COVERAGE_STATUSES = [
  "exercised",
  "not-reached",
  "proven-unreachable",
  "blocked",
  "budget-exhausted",
  "pending",
];
export const VERDICTS = ["pass", "fail", "inconclusive", "not-assessed"];
export const EVIDENCE_KINDS = ["dom", "screenshot", "trace", "route", "graph-edge"];

/**
 * §3.3 — attribution impossibility. A condition that misreports its own mechanism cannot
 * be trusted about the seam, so this invalidates the RUN, not the finding.
 */
export const ARM_ALLOWED_ATTRIBUTION = {
  A: ["model", "unattributed"],
  B: ["graph", "unattributed"],
  C: ["graph", "model", "graph-located-model-judged", "unattributed"],
  "C-R": ["graph", "model", "graph-located-model-judged", "unattributed"],
};

export const ARMS = ["A", "B", "C", "C-R"];

/**
 * Validate one arm result. Returns { ok, errors: [{code, path, detail}] }.
 * Fail-closed: an unknown field is an error, not a shrug. A format that tolerates drift
 * cannot support the claim that all arms emitted the same thing.
 */
export function validateArmResult(result) {
  const errors = [];
  const err = (code, path, detail) => errors.push({ code, path, detail });

  if (!isPlainObject(result)) {
    err("NOT_AN_OBJECT", "$", "result must be a JSON object");
    return { ok: false, errors };
  }

  if (result.schemaVersion !== FINDING_SCHEMA_VERSION) {
    err("SCHEMA_VERSION_MISMATCH", "$.schemaVersion", `expected ${FINDING_SCHEMA_VERSION}, got ${result.schemaVersion}`);
  }
  if (!ARMS.includes(result.arm)) {
    err("UNKNOWN_ARM", "$.arm", String(result.arm));
  }
  if (typeof result.armVersion !== "string" || !result.armVersion) {
    err("MISSING_ARM_VERSION", "$.armVersion", "a pinned commit sha is required before any scored run (§8.4 / M4)");
  }
  if (typeof result.surveyId !== "string" || !result.surveyId) {
    err("MISSING_SURVEY_ID", "$.surveyId", String(result.surveyId));
  }
  if (result.arm === "C-R") {
    if (!Number.isInteger(result.seed)) {
      err("MISSING_SEED", "$.seed", "C-R is the only stochastic condition; its seed is pinned and recorded (§5.6)");
    }
  } else if (result.seed !== null && result.seed !== undefined) {
    err("UNEXPECTED_SEED", "$.seed", "only C-R carries a seed");
  }

  for (const e of armIdentityErrors(result)) errors.push(e);

  if (!Array.isArray(result.findings)) {
    err("FINDINGS_NOT_ARRAY", "$.findings", typeof result.findings);
  } else {
    const seen = new Set();
    result.findings.forEach((f, i) => validateFinding(f, `$.findings[${i}]`, result.arm, seen, err));
  }

  if (!isPlainObject(result.coverage) || !Array.isArray(result.coverage?.claimedUnits)) {
    err("COVERAGE_MISSING", "$.coverage.claimedUnits", "every condition must state what it claims to have covered (§4.5)");
  } else {
    result.coverage.claimedUnits.forEach((u, i) => {
      const p = `$.coverage.claimedUnits[${i}]`;
      if (typeof u?.unitId !== "string" || !u.unitId) err("UNIT_ID_MISSING", p, "unitId");
      if (typeof u?.location !== "string") err("UNIT_LOCATION_MISSING", p, "location");
      if (!COVERAGE_STATUSES.includes(u?.status)) err("BAD_COVERAGE_STATUS", p, String(u?.status));
      if (!VERDICTS.includes(u?.verdict)) err("BAD_VERDICT", p, String(u?.verdict));
      // Two-axis consistency, matching scorer/docs/threat-model.md §7.2 exactly.
      if (u?.status === "exercised" && u?.verdict === "not-assessed") {
        err("TWO_AXIS_INVALID", p, "exercised requires pass|fail|inconclusive");
      }
      if (u?.status !== "exercised" && u?.verdict !== "not-assessed") {
        err("TWO_AXIS_INVALID", p, `${u?.status} requires verdict not-assessed`);
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * §5/§6 of evaluation/arms/ARCHITECTURE.md — a result must carry proof of what produced it.
 *
 * MISSING IS A REJECTION, NOT A SHRUG. A result with no identity is a result nobody can
 * attribute to a build, and scoring it anyway is exactly the "check that cannot fail" shape
 * `CLAUDE.md` warns about — the number comes out either way and reads as evidence.
 *
 * Returns an array of {code, path, detail}; empty when the block is well-formed and
 * self-consistent. CROSS-ARM parity (all arms one tree, one bundle) is NOT checked here —
 * it needs every arm's result at once and lives in `evaluation/arms/verify.mjs`.
 */
export function armIdentityErrors(result) {
  const out = [];
  const add = (code, path, detail) => out.push({ code, path, detail });
  const id = result?.armIdentity;

  if (id === undefined || id === null) {
    add(
      "ARM_IDENTITY_MISSING",
      "$.armIdentity",
      "required from survey-qa-eval-finding/1.1.0 — a result that cannot name its build cannot be attributed to an arm",
    );
    return out;
  }
  if (typeof id !== "object" || Array.isArray(id)) {
    add("ARM_IDENTITY_MISSING", "$.armIdentity", `expected an object, got ${typeof id}`);
    return out;
  }
  for (const f of ARM_IDENTITY_FIELDS) {
    if (typeof id[f] !== "string" || !id[f]) add("ARM_IDENTITY_INCOMPLETE", `$.armIdentity.${f}`, "required");
  }
  if (typeof id.armId === "string" && id.armId !== result.arm) {
    add(
      "ARM_IDENTITY_INCONSISTENT",
      "$.armIdentity.armId",
      `identity says arm "${id.armId}" but the result says "${result.arm}" — one of them is wrong and neither can be trusted`,
    );
  }
  if (!id.components || typeof id.components !== "object") {
    add("ARM_IDENTITY_INCOMPLETE", "$.armIdentity.components", "the resolved component set is required (§5)");
  }
  return out;
}

function validateFinding(f, path, arm, seen, err) {
  if (!isPlainObject(f)) return err("FINDING_NOT_OBJECT", path, typeof f);

  if (typeof f.findingId !== "string" || !f.findingId) err("FINDING_ID_MISSING", path, "findingId");
  else if (seen.has(f.findingId)) err("FINDING_ID_DUPLICATE", path, f.findingId);
  else seen.add(f.findingId);

  if (!CLAIM_CLASSES.includes(f.claimClass)) err("BAD_CLAIM_CLASS", path, String(f.claimClass));

  if (!isPlainObject(f.location) || typeof f.location.raw !== "string") {
    err("LOCATION_MISSING", `${path}.location`, "location.raw is required");
  } else if (!LOCATION_SCOPES.includes(f.location.scope)) {
    err("BAD_LOCATION_SCOPE", `${path}.location.scope`, String(f.location.scope));
  }

  if (f.claimClass === "defect") {
    if (!REQUIREMENT_CLASSES.includes(f.requirementClass)) {
      err("BAD_REQUIREMENT_CLASS", `${path}.requirementClass`, String(f.requirementClass));
    }
    if (!isPlainObject(f.observable)) {
      err("OBSERVABLE_MISSING", `${path}.observable`, "a defect claim needs an observable consequence (§3.1)");
    } else {
      if (!PREDICATES.includes(f.observable.predicate)) {
        err("BAD_PREDICATE", `${path}.observable.predicate`, String(f.observable.predicate));
      } else if (
        REQUIREMENT_CLASSES.includes(f.requirementClass) &&
        !predicateAdmissible(f.requirementClass, f.observable.predicate)
      ) {
        err(
          "PREDICATE_NOT_ADMISSIBLE",
          `${path}.observable.predicate`,
          `${f.observable.predicate} is not admissible for ${f.requirementClass}`,
        );
      }
    }
  }

  if (f.claimClass === "ambiguity") {
    if (!Array.isArray(f.readings) || f.readings.length < 2) {
      err(
        "READINGS_INSUFFICIENT",
        `${path}.readings`,
        "an ambiguity claim must name >= 2 readings; 'something is unclear' is not surfacing an ambiguity (§4.4)",
      );
    }
  }

  if (!ATTRIBUTIONS.includes(f.attribution)) {
    err("BAD_ATTRIBUTION", `${path}.attribution`, String(f.attribution));
  } else {
    const allowed = ARM_ALLOWED_ATTRIBUTION[arm];
    if (allowed && !allowed.includes(f.attribution)) {
      // Reported here as a schema error AND separately promoted to a run-level
      // invalidation by the scorer (§3.3).
      err("ATTRIBUTION_IMPOSSIBLE", `${path}.attribution`, `arm ${arm} cannot produce attribution "${f.attribution}"`);
    }
  }

  if (!Array.isArray(f.evidence)) {
    err("EVIDENCE_NOT_ARRAY", `${path}.evidence`, typeof f.evidence);
  } else {
    f.evidence.forEach((e, i) => {
      if (!EVIDENCE_KINDS.includes(e?.kind)) err("BAD_EVIDENCE_KIND", `${path}.evidence[${i}].kind`, String(e?.kind));
      if (typeof e?.ref !== "string" || !e.ref) err("EVIDENCE_REF_MISSING", `${path}.evidence[${i}].ref`, "ref");
    });
  }

  if (typeof f.prose !== "string") err("PROSE_MISSING", `${path}.prose`, "prose is required for human review (zero matching weight)");

  if (f.confidence !== null && f.confidence !== undefined) {
    if (typeof f.confidence !== "number" || f.confidence < 0 || f.confidence > 1) {
      err("BAD_CONFIDENCE", `${path}.confidence`, String(f.confidence));
    }
  }

  if ("severity" in f) {
    err(
      "SEVERITY_PRESENT",
      `${path}.severity`,
      "severity has zero matching weight and is deliberately absent from this format (merged-contract §1)",
    );
  }
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Shape of the harness-owned telemetry file (§3.4). The arm never writes this. */
export function validateTelemetry(t) {
  const errors = [];
  const err = (code, path, detail) => errors.push({ code, path, detail });
  if (!isPlainObject(t)) {
    err("NOT_AN_OBJECT", "$", "telemetry must be a JSON object");
    return { ok: false, errors };
  }
  if (typeof t.surveyId !== "string") err("MISSING_SURVEY_ID", "$.surveyId", String(t.surveyId));
  if (!ARMS.includes(t.arm)) err("UNKNOWN_ARM", "$.arm", String(t.arm));
  if (!Array.isArray(t.visitLog)) {
    err("VISIT_LOG_MISSING", "$.visitLog", "the harness owns the visit log; without it coverage honesty is unmeasurable (§4.5)");
  }
  if (!isPlainObject(t.cost)) err("COST_MISSING", "$.cost", "harness-observed cost is required (§4.7)");
  return { ok: errors.length === 0, errors };
}

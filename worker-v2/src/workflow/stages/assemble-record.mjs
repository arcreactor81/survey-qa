/**
 * THE DETERMINISTIC AGGREGATOR AND THE RunRecordV2 ASSEMBLER.
 *
 * `worker-v2/tools/assembler/assemble-v2.mjs` is the working reference and this reuses its
 * PROJECTION LOGIC — the same case-status vocabulary, the same requirement→case grouping,
 * the same refusal to invent a verifier decision. What it does NOT reuse is its INPUT: the
 * tool lifts a completed v1 harness run off disk, and this assembles a v2 run out of the
 * run's OWN sealed contract revision, its own observations and its own evidence catalogue.
 * There is no v1 record here to lift from, so the two share a shape and not a source.
 *
 * ======================== THE ONE RULE THE AGGREGATOR OBEYS ========================
 *
 * A CASE PASSES ONLY WHEN SOMETHING INDEPENDENT SAYS IT DID.
 *
 * The aggregator reads `observation.verifier.decision`, a tri-state produced by the verify
 * stage, and maps it: `verified` → pass, `contradicted` → fail, `insufficient` → pending.
 * It never reads prose, never scores similarity, and — critically — never treats "an
 * observation exists" as "the observation matched the document". That inference is the
 * exact defect the first run died of: the browser captured the divergence, and the stage
 * with no independent check wrote MATCHES_DOCUMENT while citing the artifact that
 * disproved it.
 *
 * The consequence today is visible and intended: while the verify stage returns
 * `insufficient` for everything, every case is `pending` and every requirement is
 * `incomplete`. A run therefore cannot report a pass it did not earn, and `close-test-axis`
 * refuses to close over pending cases. That is the honest state of a pipeline whose
 * verifier is not wired, and it is strictly better than the alternative, which is green.
 *
 * FAIL IS ABSORBING. A later case never erases an earlier fail (`mixed` records the
 * disagreement instead), because a run that retries until something passes is a run that
 * reports the last attempt rather than the truth.
 */

import {
  V2_RUN_RECORD_KIND,
  liveRequirements,
} from "../../../shared/v2-record.mjs";

export const AGGREGATOR_ID = "v2-aggregator/1.0.0";
export const RESULT_POLICY_ID = "v2-result-policy/1.0.0";
export const ASSEMBLER_ID = "v2-worker-assembler/1.0.0";

const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * VERIFIER DECISION → CASE STATUS. The whole table, in one place, with no default branch
 * that could quietly promote an unknown decision into a pass.
 */
const DECISION_TO_STATUS = {
  verified: "pass",
  contradicted: "fail",
  insufficient: "pending",
};

/** Terminal case statuses that a cap or a route exhaustion assigns, not a verdict. */
const NON_VERDICT_STATUS = new Set([
  "not-reached",
  "proven-unreachable",
  "blocked",
  "budget-exhausted",
  "time-exhausted",
]);

/**
 * Aggregate observations into one ItemResult per LIVE requirement in the sealed revision.
 *
 * The denominator is the revision's, never the observations'. A requirement with no
 * observation still gets a row — `incomplete`, with every one of its sealed cases in
 * whatever un-exercised status the cursor left it. A run that shrinks its own denominator
 * when execution is missing hides the missing execution.
 *
 * @param {object} o
 * @param {object} o.revision       the sealed ContractRevision
 * @param {Array}  o.observations   typed observations from execution
 * @param {Record<string,string>} o.unreachedStatus  facetInstanceId → terminal status for
 *                                  cases execution never reached (from the run's cursor).
 */
export function aggregate({ revision, observations, unreachedStatus = {} }) {
  const requirements = liveRequirements(revision);
  const versionById = new Map(requirements.map((r) => [r.requirementLineageId, r.requirementVersionId]));

  const casesByRequirement = new Map();
  for (const f of arr(revision?.facetInstances)) {
    if (!casesByRequirement.has(f.requirementLineageId)) casesByRequirement.set(f.requirementLineageId, []);
    casesByRequirement.get(f.requirementLineageId).push(f);
  }

  const observationsByCase = new Map();
  for (const o of arr(observations)) {
    const id = o?.facetInstanceId ?? null;
    if (id === null) continue;
    if (!observationsByCase.has(id)) observationsByCase.set(id, []);
    observationsByCase.get(id).push(o);
  }

  const itemResults = [];
  for (const r of requirements) {
    const cases = casesByRequirement.get(r.requirementLineageId) ?? [];
    const facetResults = [];

    for (const c of cases) {
      const obs = observationsByCase.get(c.facetInstanceId) ?? [];
      facetResults.push({
        facetInstanceId: c.facetInstanceId,
        routeId: c.case?.routeAnswer?.code ?? c.case?.routeAnswer?.label ?? "floor",
        status: statusForCase(obs, unreachedStatus[c.facetInstanceId]),
        observationIds: obs.map((o) => o.observationId),
      });
    }

    // A requirement the seal materialized no case for is NOT a requirement with nothing to
    // test — it is one whose case set could not be enumerated (an exclusion trigger, or a
    // facet the expander has no rule for). It carries a single un-enumerated row so it
    // still appears in the denominator and can never read as satisfied.
    if (facetResults.length === 0) {
      facetResults.push({ facetInstanceId: null, routeId: "floor", status: "pending", observationIds: [] });
    }

    itemResults.push({
      requirementLineageId: r.requirementLineageId,
      requirementVersionId: versionById.get(r.requirementLineageId) ?? "unknown",
      facetResults,
      verdict: verdictFor(facetResults),
      pathConsistency: pathConsistency(facetResults),
      divergenceSet: divergenceSet(facetResults),
      // ALWAYS the aggregator. A model id here is a contract violation and the type says so.
      derivedBy: AGGREGATOR_ID,
      resultPolicyVersion: RESULT_POLICY_ID,
    });
  }
  return itemResults;
}

function statusForCase(observations, unreached) {
  // A cap or an unreachable route decides the status regardless of what was observed:
  // there is nothing to observe on a case that was never driven.
  if (unreached && NON_VERDICT_STATUS.has(unreached)) return unreached;
  if (observations.length === 0) return "pending";
  // FAIL IS ABSORBING and is checked FIRST, so no ordering of observations can bury one.
  if (observations.some((o) => DECISION_TO_STATUS[o?.verifier?.decision] === "fail")) return "fail";
  // An ambiguity that the sealed revision flagged as outcome-relevant withholds judgement.
  // The judge owns the dependency-aware precedence rule; the aggregator only honours a
  // withhold an observation already carries.
  if (observations.some((o) => o?.withheldByAmbiguity === true)) return "judgment-withheld-ambiguous";
  if (observations.every((o) => DECISION_TO_STATUS[o?.verifier?.decision] === "pass")) return "pass";
  return "pending";
}

function verdictFor(facetResults) {
  const statuses = facetResults.map((f) => f.status);
  if (statuses.includes("fail")) return statuses.includes("pass") ? "mixed" : "fail";
  if (statuses.includes("judgment-withheld-ambiguous")) return "withheld";
  if (statuses.length > 0 && statuses.every((s) => s === "pass")) return "pass";
  return "incomplete";
}

const pathConsistency = (facetResults) => {
  const settled = facetResults.filter((f) => f.status === "pass" || f.status === "fail");
  return new Set(settled.map((f) => f.status)).size > 1 ? "mixed" : "consistent";
};

const divergenceSet = (facetResults) =>
  pathConsistency(facetResults) === "mixed"
    ? facetResults.filter((f) => f.status === "fail").map((f) => f.facetInstanceId ?? "unenumerated")
    : [];

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/**
 * Assemble a RunRecordV2 from the run's OWN durable state.
 *
 * Nothing here is defaulted into a friendlier value. `endedAt` may be null, `targetBuildId`
 * may be null (and then the judgement can never bind, which the report says), attempts may
 * be empty. Each of those is a fact about the run, and a record that smoothed them over
 * would be a record the report cannot be honest from.
 */
export function assembleRunRecordV2({
  runId,
  envelope,
  revision,
  contractHash,
  observations,
  evidence,
  itemResults,
  attempts = [],
  claims = [],
  checkpoint = null,
  planHash = null,
  startedAt,
  endedAt,
}) {
  const usage = checkpoint?.usage ?? null;
  return {
    schemaVersion: "run-record/2.0.0",
    kind: V2_RUN_RECORD_KIND,
    runId,
    contract: { contractRevisionId: revision.contractRevisionId, contractHash },
    run: {
      startedAt,
      endedAt,
      surveyUrl: envelope?.input?.surveyUrl ?? null,
      documentSha256: String(envelope?.input?.documentSha256 ?? "").replace(/^sha256:/, ""),
      targetBuildId: envelope?.input?.targetBuildId ?? null,
      locale: envelope?.input?.locale ?? "en",
      viewports: arr(envelope?.input?.viewports),
    },
    attempts: arr(attempts),
    observations: arr(observations),
    claims: arr(claims),
    ambiguities: [],
    taxonomyGaps: [],
    blockers: [],
    itemResults: arr(itemResults),
    exploration: {
      planHash,
      perKindCounts: perKindCounts(revision),
      // NOT a restatement of "the workflow finished". `testComplete` is a claim about
      // COVERAGE, so it is true only when every case reached a terminal disposition that a
      // verdict — not a cap — decided.
      testComplete: arr(itemResults).every((r) =>
        r.facetResults.every((f) => f.status === "pass" || f.status === "fail" || f.status === "proven-unreachable"),
      ),
    },
    evidence: arr(evidence),
    resources: {
      modelCalls: arr(checkpoint?.modelCallLedger),
      toolVersions: arr(checkpoint?.toolVersions),
      totals: {
        costUsd: usage?.cost?.usedUsd ?? 0,
        modelCalls: usage?.modelCalls?.used ?? 0,
        toolCalls: usage?.toolCalls?.used ?? 0,
        wallClockMs: usage?.wallClock?.usedMilliseconds ?? 0,
        tokens: usage?.tokens ?? { input: 0, output: 0 },
      },
      limits: {
        maxUsd: usage?.cost?.maxUsd ?? 0,
        maxModelCalls: usage?.modelCalls?.max ?? 0,
        maxToolCalls: usage?.toolCalls?.max ?? 0,
        maxWallClockMs: usage?.wallClock?.maxMilliseconds ?? 0,
      },
    },
    versions: {
      aggregator: AGGREGATOR_ID,
      resultPolicy: RESULT_POLICY_ID,
      normalizer: ASSEMBLER_ID,
      projection: ASSEMBLER_ID,
      registry: ASSEMBLER_ID,
    },
    attestation: null,
  };
}

const perKindCounts = (revision) => {
  const counts = {};
  for (const f of arr(revision?.facetInstances)) {
    const kind = f?.case?.kind ?? "unclassified";
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
};

/**
 * REFUSE A RECORD WHOSE VERDICTS NAME A MODEL.
 *
 * `derive-verdicts` is forbidden from calling a model, and this is the check that makes
 * the prohibition mechanical rather than a comment. Called by the assembler stage before
 * anything is stored.
 */
export function rejectModelDerivedVerdicts(itemResults) {
  const offenders = arr(itemResults).filter((r) => r.derivedBy !== AGGREGATOR_ID);
  return offenders.length === 0
    ? null
    : `${offenders.length} ItemResult(s) name a derivedBy other than ${AGGREGATOR_ID}: ` +
        `[${[...new Set(offenders.map((o) => o.derivedBy))].join(", ")}]. A verdict is DERIVED, never authored.`;
}

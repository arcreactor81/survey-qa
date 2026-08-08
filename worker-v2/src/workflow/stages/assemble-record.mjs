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
// Claims — a PROJECTION of the derived verdicts, never a second opinion
// ---------------------------------------------------------------------------

export const CLAIM_PROJECTION_ID = "v2-claim-projection/1.0.0";
export const BLOCKER_PROJECTION_ID = "v2-blocker-projection/1.0.0";

/**
 * DERIVE THE DEFECT CLAIMS FROM THE VERDICTS THAT WERE ALREADY DERIVED.
 *
 * The run that produced two real `contradicted` verifier decisions — a route that landed on
 * Q8 where the document routes to Q9, and a boundary the site accepted that the document
 * requires it to reject — nevertheless signed a record whose `claims` was a literal `[]`,
 * because the assembler took claims as a PARAMETER and its one caller passed nothing. A
 * researcher reading that record sees a clean survey. So claims are no longer a parameter:
 * there is no wire left to forget, because the record derives them from the `itemResults`
 * and `observations` it is already being given.
 *
 * ================= THIS INTRODUCES NO JUDGEMENT, AND HERE IS WHY =================
 *
 * Every claim is gated TWICE on decisions taken elsewhere, and adds nothing of its own:
 *
 *   1. the ItemResult must already be `fail`/`mixed`, and the CASE must already be `fail` —
 *      both written by `aggregate()` above, whose `derivedBy` the assembler stage rejects
 *      unless it is the aggregator's own id;
 *   2. the cited observation's own `verifier.decision` must map to `fail` THROUGH
 *      `DECISION_TO_STATUS` — the same table `statusForCase` reads, imported rather than
 *      restated, so the two can never drift into disagreeing about what a fail is.
 *
 * `claimType` is the verifier's own closed reason code and `prose` is the verifier's own
 * `detail` string, VERBATIM. Nothing here composes a narrative, ranks a severity or scores a
 * confidence; `findingFromClaim` in shared/v2-record.mjs emits `severity: null` for exactly
 * the same reason, and a claim that arrived carrying one would defeat it.
 *
 * NOTE THE PRECEDENCE THIS INHERITS. `statusForCase` lets a cap or an unreachable route
 * decide a case's status BEFORE it looks at any verifier decision, so a contradicted
 * observation sitting under a `blocked` case yields no claim. That is the aggregator's
 * policy, not this projection's, and honouring it is the whole point: a projection that
 * reached past the verdict to the observation would be authoring a verdict of its own.
 */
export function deriveClaims({ itemResults, observations }) {
  const byId = new Map();
  for (const o of arr(observations)) if (o?.observationId) byId.set(o.observationId, o);

  const claims = [];
  const seen = new Set();
  for (const r of arr(itemResults)) {
    if (r?.verdict !== "fail" && r?.verdict !== "mixed") continue;
    for (const f of arr(r.facetResults)) {
      if (f?.status !== "fail") continue;
      for (const observationId of arr(f.observationIds)) {
        const o = byId.get(observationId);
        // An unresolvable observation is NOT skipped into silence — `deriveBlockers` raises
        // it as UNRESOLVED_FAIL_OBSERVATION. It cannot become a claim because a claim's
        // whole substance is the pointer, and this one would point at nothing.
        if (!o) continue;
        if (DECISION_TO_STATUS[o?.verifier?.decision] !== "fail") continue;
        const claimId = `clm_${r.requirementLineageId}_${observationId}`;
        if (seen.has(claimId)) continue;
        seen.add(claimId);
        claims.push({
          claimId,
          claimClass: "defect",
          claimType: claimTypeOf(o),
          normativeRef: {
            requirementLineageId: r.requirementLineageId,
            requirementVersionId: r.requirementVersionId,
          },
          observationRefs: [observationId],
          prose: proseOf(o),
        });
      }
    }
  }
  return claims;
}

/**
 * The verifier's own closed reason code. A decision this Worker produced always names one
 * (`VERIFIER_REASON` in verify-observations.ts); a lifted or fixture observation may not, and
 * the placeholder is deliberately NOT a defect type — an unnamed reason must not be able to
 * read as a specific finding about the site.
 */
const claimTypeOf = (o) => {
  const reason = o?.verifier?.reason;
  return typeof reason === "string" && reason.length > 0 ? reason : "VERIFIER_REASON_UNSTATED";
};

/**
 * THE VERIFIER'S OWN SENTENCE, VERBATIM. `prose` carries zero matching weight, which is
 * precisely why it must not be embellished: it is the only thing a human reads, and an
 * editorialised version would be the one part of the record nothing checks.
 */
const proseOf = (o) => {
  const detail = o?.verifier?.detail;
  if (typeof detail === "string" && detail.length > 0) return detail;
  const predicate = o?.verifier?.predicate;
  return (
    `${predicate ? `predicate ${predicate}` : "an unnamed predicate"} returned ${claimTypeOf(o)}; ` +
    `the verifier recorded no detail text`
  );
};

// ---------------------------------------------------------------------------
// Blockers — what qualifies EVERY result in this record
// ---------------------------------------------------------------------------

/**
 * WHAT `record.blockers` IS FOR, AND HOW IT DIFFERS FROM `testAxisBlockers`.
 *
 * `run-workflow.ts#testAxisBlockers` answers "may `completion.test` be marked complete?" —
 * bookkeeping about the RUN, computed from the checkpoint, and it takes the assembled record
 * as an INPUT, so it can never live inside the record it is computed from.
 *
 * These blockers answer a different question: WHAT QUALIFIES EVERY RESULT IN THIS DOCUMENT?
 * They are facts about the target and about the execution that a reader must hold while
 * reading any verdict here — chief among them that this survey CRASHED ON LOAD and rendered
 * nothing, and that the run only continued by injecting a compatibility shim, so every later
 * observation describes the survey the author intended to ship rather than the one a
 * respondent receives.
 *
 * WHY THE LOAD CRASH IS A BLOCKER AND NOT A CLAIM. A `DefectClaim` is a POINTER: it requires
 * one `normativeRef` and it carries its evidence only through `observationRefs`. The crash
 * has neither. `project-observations.ts` skips walks that closed no cases, and a crashed walk
 * closes none, so no Observation exists to point at; and the crash's evidence witnesses ~220
 * requirements at once, so there is no single requirement it contradicts. Filing it as a
 * claim would mean inventing a `normativeRef` or manufacturing one claim per witness — both
 * fabrications. It belongs where a fact about the whole run belongs.
 *
 * @param {object} o
 * @param {Array|null} o.walks  the execution ledger's walk records, or NULL when the run
 *   wrote no ledger. `null` and `[]` are different facts and must not collapse: `[]` is "the
 *   ledger says no walk ran", `null` is "there is no ledger", and the second is itself a
 *   blocker. A parameter that defaulted to empty would rebuild the exact disconnected wire
 *   this change exists to remove, one field over.
 */
export function deriveBlockers({ walks, itemResults, observations, evidence }) {
  const blockers = [];

  if (!Array.isArray(walks)) {
    blockers.push(
      blocker({
        blockerId: "blk_execution-ledger-unavailable",
        kind: "EXECUTION_LEDGER_UNAVAILABLE",
        detail:
          "the run's execution ledger could not be read, so this record cannot say whether the target loaded, " +
          "whether any walk crashed, or whether the observations below were taken against a shimmed target",
      }),
    );
  } else {
    for (const w of walks) {
      // TYPED, NOT SNIFFED. `loadCrash` is written by `walkRecord()` from
      // `obs.loadFailure !== null`, and `outcome` is the driver's own closed word.
      if (w?.loadCrash !== true) continue;
      blockers.push(
        blocker({
          blockerId: `blk_${w.pathId ?? "unknown-path"}_${w.attemptId ?? "unknown-attempt"}_load-crash`,
          kind: "TARGET_FAILED_TO_LOAD",
          pathId: w.pathId ?? null,
          attemptId: w.attemptId ?? null,
          outcome: typeof w.outcome === "string" ? w.outcome : null,
          shimmed: typeof w.shimmed === "boolean" ? w.shimmed : null,
          at: typeof w.at === "string" ? w.at : null,
          evidenceIds: loadFailureEvidence(evidence, w),
          // VERBATIM the page's own error, as the driver captured it.
          detail:
            typeof w.outcomeDetail === "string" && w.outcomeDetail.length > 0
              ? w.outcomeDetail
              : "the walk recorded a load crash with no detail text",
        }),
      );
    }

    // THE SHIM IS HOW THE REST GOT TESTED, AND IT IS ALSO WHY NONE OF IT DESCRIBES THE
    // SHIPPED SURVEY. Without this the crash disappears from every downstream observation.
    const shimmed = walks.filter((w) => w?.shimmed === true);
    if (shimmed.length > 0) {
      blockers.push(
        blocker({
          blockerId: "blk_observations-against-shimmed-target",
          kind: "OBSERVATIONS_MADE_AGAINST_SHIMMED_TARGET",
          detail:
            `${shimmed.length} of ${walks.length} walk(s) ran with a compatibility shim injected into the page, ` +
            `so their observations describe the survey as patched by this harness, not as served`,
        }),
      );
    }
  }

  // A FAILING CASE WHOSE OBSERVATION IS NOT IN THIS RECORD IS A HOLE, AND IT IS NAMED.
  // `deriveClaims` cannot emit a pointer to something absent; refusing to say so would be
  // the "quietly shorter list" CLAUDE.md forbids.
  const known = new Set(arr(observations).map((o) => o?.observationId));
  for (const r of arr(itemResults)) {
    if (r?.verdict !== "fail" && r?.verdict !== "mixed") continue;
    for (const f of arr(r.facetResults)) {
      if (f?.status !== "fail") continue;
      for (const observationId of arr(f.observationIds)) {
        if (known.has(observationId)) continue;
        blockers.push(
          blocker({
            blockerId: `blk_${r.requirementLineageId}_${observationId}_unresolved`,
            kind: "UNRESOLVED_FAIL_OBSERVATION",
            observationRefs: [observationId],
            detail:
              `requirement ${r.requirementLineageId} has a failing case citing observation ${observationId}, ` +
              `which is not present in this record's observation list, so the failure carries no citable claim`,
          }),
        );
      }
    }
  }

  return blockers;
}

/** One shape for every blocker, with NO severity and NO confidence field to invent. */
const blocker = ({
  blockerId,
  kind,
  detail,
  pathId = null,
  attemptId = null,
  outcome = null,
  shimmed = null,
  at = null,
  evidenceIds = [],
  observationRefs = [],
}) => ({
  blockerId,
  kind,
  pathId,
  attemptId,
  outcome,
  shimmed,
  at,
  detail,
  evidenceIds,
  observationRefs,
  derivedBy: BLOCKER_PROJECTION_ID,
});

/**
 * The catalogued artifacts of one crashed walk.
 *
 * THE TYPED HALF: `browser/capture.ts#captureFailure` is the ONLY producer of a catalogue
 * entry with `type: "trace"`, and the load-crash branch of `driver.ts` is its only caller.
 * So a trace entry stamped with this walk's route and attempt IS the failure record, found
 * by a declared field rather than by reading a name.
 *
 * THE ASSUMPTION, WRITTEN DOWN (CLAUDE.md: no silent reliance on a convention): the driver
 * shoots a screenshot in the same breath as the failure JSON, and `capture.ts` mints the two
 * ids as `EV-{pathId}-{label}` and `EV-{pathId}-{step}-{label}-png`. The label is therefore
 * read OFF the trace entry we already found — never hardcoded — and used to recognise its
 * companion shot. If the scheme changes the companion simply is not located and the blocker
 * carries the trace alone; it never guesses at another artifact.
 *
 * Both filters are scoped to this walk's route AND attempt because a crashed path is retried
 * under the SAME attempt id, so the catalogue holds the crash and the shimmed retry together.
 */
function loadFailureEvidence(evidence, walk) {
  const onWalk = arr(evidence).filter((e) => e?.routeId === walk?.pathId && e?.attemptId === walk?.attemptId);
  const traces = onWalk.filter((e) => e?.type === "trace");
  const ids = traces.map((e) => e.evidenceId);
  const prefix = `EV-${walk?.pathId}-`;
  for (const t of traces) {
    const src = t?.sourceEvidenceId;
    if (typeof src !== "string" || !src.startsWith(prefix)) continue;
    const suffix = `-${src.slice(prefix.length)}-png`;
    for (const e of onWalk) {
      if (e?.type === "screenshot" && typeof e.sourceEvidenceId === "string" && e.sourceEvidenceId.endsWith(suffix)) {
        ids.push(e.evidenceId);
      }
    }
  }
  return [...new Set(ids)].filter((id) => typeof id === "string" && id.length > 0);
}

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
 *
 * `claims` AND `blockers` ARE NOT PARAMETERS, DELIBERATELY. They were, and the record shipped
 * `claims: []` over two real failures because the one caller passed a literal empty array
 * while the assembler dutifully stored it. A findings list that a caller can omit is a
 * findings list that will be omitted. They are derived here, from inputs this function
 * already has, so the only way to a record with no claims is a run with no failing verdicts.
 *
 * `walks` is the one genuinely NEW input, and it is REQUIRED to be distinguishable: pass the
 * execution ledger's walk records, or `null` if the run has no ledger. Never `[]` to mean
 * "did not look" — see `deriveBlockers`.
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
  walks,
  checkpoint = null,
  planHash = null,
  startedAt,
  endedAt,
}) {
  const usage = checkpoint?.usage ?? null;
  const claims = deriveClaims({ itemResults, observations });
  const blockers = deriveBlockers({
    // `undefined` (the caller never passed it) and `null` (the run has no ledger) are the
    // same fact from the record's point of view: nothing is known about the walks.
    walks: walks === undefined ? null : walks,
    itemResults,
    observations,
    evidence,
  });
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
    blockers: arr(blockers),
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

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
import { payloadHashOf } from "../../../../scorer/src/lib/attest.mjs";

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
export function deriveBlockers({ walks, itemResults, observations, evidence, probeCapabilityLimitations }) {
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

  // A PLANNED PROBE IS NOT AN ATTEMPT. The planner can request back-navigation and repeated
  // independent sessions, while the current driver consumes only one forward `decisions`
  // list. Those paths therefore have no attempt row and no observation receipt; without this
  // projection the signed record would show neither the experiment nor its absence.
  //
  // Only the two closed capability codes enter here. Other plan limitations already have their
  // own report surface and must not be reclassified as execution facts by a substring match.
  const capabilityCodes = new Set([
    "planned-back-navigation-not-executable",
    "planned-independent-session-repeats-not-executable",
  ]);
  for (const limitation of Array.isArray(probeCapabilityLimitations) ? probeCapabilityLimitations : []) {
    if (!capabilityCodes.has(limitation?.code) || !(limitation?.count > 0)) continue;
    blockers.push(
      blocker({
        blockerId: `blk_${limitation.code}`,
        kind: "PLANNED_PROBE_NOT_EXECUTED",
        detail: `${limitation.code}: ${typeof limitation.what === "string" ? limitation.what : "planned probe capability is unavailable"}`,
        count: limitation.count,
        pathIds: arr(limitation.pathIds),
        blockingPathIds: arr(limitation.blockingPathIds),
      }),
    );
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
  count = undefined,
  pathIds = undefined,
  blockingPathIds = undefined,
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
  ...(count !== undefined ? { count } : {}),
  ...(pathIds !== undefined ? { pathIds } : {}),
  ...(blockingPathIds !== undefined ? { blockingPathIds } : {}),
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
// Attempts — the execution ledger, projected. NOT a parameter, for the same
// reason claims are not.
// ---------------------------------------------------------------------------

export const ATTEMPT_PROJECTION_ID = "v2-attempt-projection/1.0.0";

/**
 * `attempts: []` WAS THE SAME DEFECT AS `claims: []`, ONE FIELD OVER — and it was
 * re-introduced by the very change that fixed claims, in the fixed caller, on the line below
 * the comment explaining why claims could no longer be a parameter. That is the whole argument
 * for deriving rather than passing: the discipline did not survive one commit.
 *
 * WHAT AN "ATTEMPT" IS HERE. The v2 executor's durable unit is a WALK — one path driven once,
 * recorded in `execution/progress.json`. There is no separate attempt ledger anywhere in the
 * tree, so this is a projection of the walk records and nothing else. One row per walk.
 *
 * TWO WALKS CAN SHARE AN attemptId, and the record says so rather than tidying it away: a path
 * that crashed on load is RETRIED UNDER THE SAME ATTEMPT ID (see `loadFailureEvidence`). So
 * `attemptNumber` is the ordinal of this walk among the walks of its path, in ledger order,
 * and `retryOfAttemptId` legitimately equals `attemptId` for such a retry. Minting a distinct
 * id to make the field look tidier would be inventing a fact about the run.
 */
export function deriveAttempts({ walks, evidence }) {
  if (!Array.isArray(walks)) return [];

  const seenOnPath = new Map();
  const priorOnPath = new Map();
  // How many walk rows share each path+attempt, so a row can declare that its evidence set is
  // not exclusively its own.
  const rowsPerKey = new Map();
  for (const w of walks) {
    rowsPerKey.set(walkKey(w), (rowsPerKey.get(walkKey(w)) ?? 0) + 1);
  }

  const attempts = [];
  for (const w of walks) {
    const pathId = typeof w?.pathId === "string" ? w.pathId : "unknown-path";
    const attemptId = typeof w?.attemptId === "string" ? w.attemptId : "unknown-attempt";
    const n = (seenOnPath.get(pathId) ?? 0) + 1;
    seenOnPath.set(pathId, n);
    const prior = priorOnPath.get(pathId) ?? null;
    priorOnPath.set(pathId, w);

    const endedAt = typeof w?.at === "string" ? w.at : null;
    attempts.push({
      attemptId,
      pathId,
      // The ledger carries a tier, not a label. Inventing a human name for a path the plan
      // labelled elsewhere would put a second, unchecked name in the record.
      pathLabel: null,
      attemptNumber: n,
      retryOfAttemptId: prior ? (typeof prior.attemptId === "string" ? prior.attemptId : null) : null,
      retryReason: prior ? (typeof prior.outcome === "string" ? prior.outcome : null) : null,
      targetCaseIds: arr(w?.caseIds),
      startedAt: startOfWalk(endedAt, w?.wallMs),
      endedAt,
      // `ok` IS THE LEDGER'S OWN WORDS, NOT AN OPINION: the driver wrote `outcome` and
      // `loadCrash`, and a walk that crashed on load is not ok however it finished.
      ok: w?.outcome === "completed" && w?.loadCrash !== true,
      stopReason: typeof w?.outcome === "string" ? w.outcome : null,
      evidenceIds: walkEvidenceIds(evidence, w),
      evidenceSharedWithSiblingWalks: (rowsPerKey.get(walkKey(w)) ?? 0) > 1,
      derivedBy: ATTEMPT_PROJECTION_ID,
    });
  }
  return attempts;
}

/**
 * The path+attempt a walk belongs to. JSON-encoded rather than concatenated, so two ids that
 * happen to contain the separator cannot collide into one bucket and under-report a sibling.
 */
const walkKey = (w) => JSON.stringify([w?.pathId ?? null, w?.attemptId ?? null]);

/** end − duration, or null. Never a guess: an unparseable `at` yields no start time at all. */
function startOfWalk(endedAt, wallMs) {
  if (typeof endedAt !== "string") return null;
  const end = Date.parse(endedAt);
  if (!Number.isFinite(end)) return null;
  if (typeof wallMs !== "number" || !Number.isFinite(wallMs) || wallMs < 0) return null;
  return new Date(end - wallMs).toISOString();
}

const walkEvidenceIds = (evidence, walk) =>
  arr(evidence)
    .filter((e) => e?.routeId === walk?.pathId && e?.attemptId === walk?.attemptId)
    .map((e) => e?.evidenceId)
    .filter((id) => typeof id === "string" && id.length > 0);

// ---------------------------------------------------------------------------
// Ambiguities and taxonomy gaps — the two things the record declared empty
// while both sources sat in the inputs it was already holding
// ---------------------------------------------------------------------------

export const AMBIGUITY_PROJECTION_ID = "v2-ambiguity-projection/1.0.0";
export const TAXONOMY_GAP_PROJECTION_ID = "v2-taxonomy-gap-projection/1.0.0";

/**
 * THE DOCUMENT'S OWN OPEN QUESTIONS, FROM TWO SOURCES THAT ARE NOT THE SAME FACT.
 *
 *   1. THE SEAL. A `ScopedRequirement` carries `assertionStatus`, and `ambiguous`/`disputed`
 *      are the extraction's verdict that the document admits two readings, or that the two
 *      passes could not both hold. This survives the seal and is always available.
 *   2. THE RUN'S CHECKLIST. `v2/runs/<id>/checklist.json` is where the extraction left the
 *      READINGS themselves (`reading_a` / `reading_b` / `why_ambiguous`). A sealed revision
 *      keeps ambiguities only as TOKENS — digests — and no projection can recover prose from
 *      a digest (`checklist-projection.mjs` says the same thing for the same reason).
 *
 * So a requirement flagged ambiguous with no checklist to enrich it is reported with
 * `readings: []` AND `readingsAvailable: false`. Those are different sentences: "there are two
 * readings and this record cannot show them" is not "there is nothing to say".
 *
 * THE BINDING IS EXACT OR ABSENT. A checklist ambiguity attaches to a requirement only when
 * its `doc_quote` trims to exactly the requirement's `displayQuote`. Nothing fuzzy and nothing
 * positional — a mis-bound ambiguity would withhold judgement on the wrong obligation. An
 * ambiguity that binds to nothing is emitted UNBOUND (`normativeRef: null`), because dropping
 * it is the quietly-shorter-list failure CLAUDE.md forbids.
 *
 * NOTHING HERE DECIDES ANYTHING. The dependency-aware withholding policy lives in the judge
 * and in `withheldByAmbiguity` on the observation; this only publishes what was already found.
 */
export function deriveAmbiguities({ revision, checklist }) {
  const requirements = liveRequirements(revision);
  const declared = arr(checklist?.ambiguities);

  const byQuote = new Map();
  for (const a of declared) {
    const q = typeof a?.doc_quote === "string" ? a.doc_quote.trim() : "";
    if (q.length === 0) continue;
    if (!byQuote.has(q)) byQuote.set(q, []);
    byQuote.get(q).push(a);
  }

  const out = [];
  const bound = new Set();
  for (const r of requirements) {
    if (r?.assertionStatus !== "ambiguous" && r?.assertionStatus !== "disputed") continue;
    const quote = typeof r.displayQuote === "string" ? r.displayQuote.trim() : "";
    const matches = byQuote.get(quote) ?? [];
    for (const m of matches) bound.add(m);
    out.push({
      ambiguityId: `amb_${r.requirementLineageId}`,
      status: r.assertionStatus,
      normativeRef: {
        requirementLineageId: r.requirementLineageId,
        requirementVersionId: r.requirementVersionId,
      },
      statement: typeof r.normativeStatement === "string" ? r.normativeStatement : "",
      documentQuote: typeof r.displayQuote === "string" ? r.displayQuote : "",
      readings: readingsOf(matches),
      readingsAvailable: readingsOf(matches).length > 0,
      whyAmbiguous: matches.map((m) => m?.why_ambiguous).find((w) => typeof w === "string" && w.length > 0) ?? null,
      affects: [...new Set(matches.flatMap((m) => arr(m?.affects)).filter((s) => typeof s === "string"))],
      derivedBy: AMBIGUITY_PROJECTION_ID,
    });
  }

  // Declared ambiguities that bound to no sealed requirement. They are the extraction's own
  // open questions about the document and are reported as such, never attached by guesswork.
  for (const a of declared) {
    if (bound.has(a)) continue;
    const id = typeof a?.id === "string" && a.id.length > 0 ? a.id : `unnamed-${out.length}`;
    out.push({
      ambiguityId: `amb_unbound_${id}`,
      status: "extraction-declared",
      normativeRef: null,
      statement: "",
      documentQuote: typeof a?.doc_quote === "string" ? a.doc_quote : "",
      readings: readingsOf([a]),
      readingsAvailable: readingsOf([a]).length > 0,
      whyAmbiguous: typeof a?.why_ambiguous === "string" && a.why_ambiguous.length > 0 ? a.why_ambiguous : null,
      affects: arr(a?.affects).filter((s) => typeof s === "string"),
      derivedBy: AMBIGUITY_PROJECTION_ID,
    });
  }
  return out;
}

/** Both readings, verbatim and in the extraction's own order. Never composed into one string. */
const readingsOf = (entries) =>
  arr(entries)
    .flatMap((a) => [a?.reading_a, a?.reading_b])
    .filter((s) => typeof s === "string" && s.trim().length > 0);

/**
 * EVERY CASE THIS SYSTEM SEALED AND HAS NO PREDICATE FOR.
 *
 * `FacetInstance.expectationGap` is REQUIRED on every sealed case precisely so that "a case
 * exists" can never coexist with "nothing about it could ever be checked" — and then the
 * record threw the whole set away with `taxonomyGaps: []`. A run reporting 227 requirements
 * and zero taxonomy gaps is claiming a reach it does not have.
 *
 * THESE ARE LIMITS OF THE TOOL, NOT FINDINGS ABOUT THE SURVEY, which is why they are their own
 * list and not claims: a `DefectClaim` points at an observation, and a gap is the absence of
 * one. `code` and `detail` are the expander's own closed code and its own words, verbatim.
 */
export function deriveTaxonomyGaps({ revision }) {
  const live = new Set(liveRequirements(revision).map((r) => r.requirementLineageId));
  const gaps = [];
  for (const f of arr(revision?.facetInstances)) {
    const gap = f?.expectationGap;
    if (!gap || typeof gap.code !== "string" || gap.code.length === 0) continue;
    // A retired requirement is out of the denominator, so its cases are not this run's gaps.
    if (!live.has(f.requirementLineageId)) continue;
    gaps.push({
      gapId: `tgap_${f.facetInstanceId}`,
      code: gap.code,
      detail: typeof gap.detail === "string" ? gap.detail : "",
      facetInstanceId: f.facetInstanceId,
      caseKind: typeof f?.case?.kind === "string" ? f.case.kind : "unclassified",
      normativeRef: {
        requirementLineageId: f.requirementLineageId,
        requirementVersionId: f.requirementVersionId,
      },
      derivedBy: TAXONOMY_GAP_PROJECTION_ID,
    });
  }
  return gaps;
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
 * NOTHING A CALLER CAN OMIT IS A FINDINGS LIST ANY MORE. `claims`, `blockers`, `attempts`,
 * `ambiguities` and `taxonomyGaps` are ALL derived here, from inputs this function already
 * holds. Claims were a parameter and the record shipped `claims: []` over two real failures;
 * `attempts: []` was then re-introduced in the commit that fixed claims, one field over, in
 * the fixed caller. A list a caller may omit is a list that will be omitted, and the only cure
 * that has survived contact with this codebase is the absence of the wire.
 *
 * THE THREE INPUTS THAT ARE REQUIRED TO BE DISTINGUISHABLE, and why each one is:
 *
 *   `walks`           the execution ledger's walk records, or `null` for a run with no ledger.
 *                     Never `[]` to mean "did not look" — see `deriveBlockers`.
 *   `checklist`       the run's own extraction checklist, or `null`. Only it carries the
 *                     ambiguity READINGS; `null` makes `readingsAvailable` false rather than
 *                     making an ambiguous document look unambiguous.
 *   `targetIdentity`  the resolved identity of the thing under test. It needs a digest over
 *                     the catalogue, which is async, so it cannot be computed in this
 *                     synchronous module — but it is REQUIRED, and an omitted one throws
 *                     rather than silently producing the `targetBuildId: null` record that
 *                     could not say what it tested.
 */
export function assembleRunRecordV2({
  runId,
  envelope,
  revision,
  contractHash,
  observations,
  evidence,
  itemResults,
  walks,
  probeCapabilityLimitations,
  checklist = null,
  targetIdentity,
  checkpoint = null,
  planHash = null,
  startedAt,
  endedAt,
}) {
  if (!targetIdentity || typeof targetIdentity !== "object" || !("source" in targetIdentity)) {
    // LOUD, NOT DEFAULTED. A missing identity used to be spelled `null` and read as "this run
    // has no build id", which is the sentence a reader cannot distinguish from "nobody wired
    // it". The stage that resolves it is the only place that can, so its absence is a bug.
    throw new Error(
      "assembleRunRecordV2: targetIdentity is required — resolve it with store/target-build.ts#resolveTargetIdentity " +
        "and pass it. A record that cannot name what it tested must not be assembled silently.",
    );
  }
  const usage = checkpoint?.usage ?? null;
  const claims = deriveClaims({ itemResults, observations });
  // `undefined` (the caller never passed it) and `null` (the run has no ledger) are the same
  // fact from the record's point of view: nothing is known about the walks.
  const ledger = walks === undefined ? null : walks;
  const blockers = deriveBlockers({
    walks: ledger,
    itemResults,
    observations,
    evidence,
    probeCapabilityLimitations,
  });
  const attempts = deriveAttempts({ walks: ledger, evidence });
  const ambiguities = deriveAmbiguities({ revision, checklist });
  const taxonomyGaps = deriveTaxonomyGaps({ revision });
  return {
    schemaVersion: "run-record/2.0.0",
    kind: V2_RUN_RECORD_KIND,
    runId,
    // REVISION 1 BY CONSTRUCTION. This is the document the judge binds to, so it cannot
    // contain the judgement's outcome — see `supersedeRunRecord` for the revision that does.
    //
    // `originalRecordHash` is null HERE and only here: this IS the original, and a record that
    // contained its own payload hash would change that hash by containing it.
    recordRevision: { revision: 1, supersedes: null, originalRecordHash: null },
    closure: null,
    contract: { contractRevisionId: revision.contractRevisionId, contractHash },
    run: {
      startedAt,
      endedAt,
      surveyUrl: envelope?.input?.surveyUrl ?? null,
      documentSha256: String(envelope?.input?.documentSha256 ?? "").replace(/^sha256:/, ""),
      targetBuildId: envelope?.input?.targetBuildId ?? null,
      targetIdentity: {
        targetBuildId: targetIdentity.targetBuildId ?? null,
        source: targetIdentity.source,
        note: typeof targetIdentity.note === "string" ? targetIdentity.note : "",
      },
      locale: envelope?.input?.locale ?? "en",
      viewports: arr(envelope?.input?.viewports),
    },
    attempts: arr(attempts),
    observations: arr(observations),
    claims: arr(claims),
    ambiguities: arr(ambiguities),
    taxonomyGaps: arr(taxonomyGaps),
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
      // `checkpoint.modelCallLedger` AND `checkpoint.toolVersions` DO NOT EXIST ON RunCheckpoint,
      // and never have — grep the tree: nothing writes either field. So both of these have
      // always read `undefined` and always produced `[]`. That is the third disconnected wire of
      // the same family as `claims: []` and `attempts: []`, and it is left reading the same
      // properties DELIBERATELY: the day a per-call ledger is written to the checkpoint under
      // that name, this picks it up. What changes is that the emptiness is now NAMED.
      modelCalls: arr(checkpoint?.modelCallLedger),
      toolVersions: arr(checkpoint?.toolVersions),
      // "NOBODY LOOKED" IS NOT "NOTHING HAPPENED" (CLAUDE.md: coverage is computed, not
      // attested). `resources.modelCalls: []` beside `totals.modelCalls: 47` is a record whose
      // provenance table renders empty over a run that spent real money, and the reader has no
      // way to tell it from a run — a contract-reuse run, say — that genuinely made no calls.
      perCallTelemetry: telemetryState(checkpoint, usage),
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

/**
 * WHETHER THE PER-CALL MODEL TELEMETRY IN THIS RECORD IS THE WHOLE STORY.
 *
 *   "recorded"    a ledger is present, and the rows in `modelCalls` are it.
 *   "unrecorded"  the usage counters say calls were made and NO per-call ledger exists. The
 *                 cost in `totals` is therefore unfalsifiable from this record alone, which is
 *                 exactly what DEBRIEF fix #6 was about — and saying so is the only honest
 *                 option until something writes the ledger.
 *   "no-calls"    the counters say zero. An empty `modelCalls` is then the complete truth, and
 *                 a contract-reuse run is the case that makes this arm worth having.
 */
function telemetryState(checkpoint, usage) {
  if (arr(checkpoint?.modelCallLedger).length > 0) return "recorded";
  return (usage?.modelCalls?.used ?? 0) > 0 ? "unrecorded" : "no-calls";
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

// ---------------------------------------------------------------------------
// A RECORD THAT FAILS SOMETHING MUST SAY WHAT
// ---------------------------------------------------------------------------

/**
 * REFUSE A RECORD WHOSE FAIL VERDICTS ARE ACCOUNTED FOR BY NOTHING.
 *
 * ===================== THE CHECK, AND WHY IT IS THE RIGHT ONE =====================
 *
 * "A record containing fail verdicts MUST carry nonzero claims" is the guard that would have
 * caught the original defect on the day it shipped: run 5 signed `claims: []` over two
 * `contradicted` verdicts and nothing anywhere objected. The derivation now makes that
 * particular hole unreachable — but the derivation is exactly the kind of thing this codebase
 * has repeatedly disconnected without noticing, so the property is asserted at the WRITE
 * BOUNDARY as well, beside `rejectModelDerivedVerdicts`, where it survives a future edit to
 * the projection.
 *
 * IT IS PER-FAILING-CASE, NOT MERELY PER-RECORD, and that is strictly stronger: a record with
 * one claim and nine unexplained failing cases passes the headline sentence and is still the
 * cardinal failure. Every case whose status is `fail` must be accounted for by
 *
 *   - a CLAIM citing one of that case's own observations, or
 *   - an `UNRESOLVED_FAIL_OBSERVATION` blocker naming one of them (the honest branch:
 *     `deriveClaims` cannot point at an observation the record does not carry).
 *
 * THE ACCOUNTING IS TOTAL, which is what makes refusal safe rather than a new way to lose a
 * run. `statusForCase` sets `fail` only when some observation of the case maps to `fail`
 * through `DECISION_TO_STATUS`; if that observation is in the record `deriveClaims` emits a
 * claim, and if it is not `deriveBlockers` emits the blocker. So a correct assembly cannot
 * trip this, and anything that does is a genuinely silent failure.
 *
 * REFUSING IS THE DEGRADATION, DELIBERATELY. No record is written; `mint-judgement` then stops
 * on NO_RUN_RECORD, the test axis cannot close, and the report says the run has no record. All
 * of that is loud. The alternative — storing a signed document that shows a clean survey over
 * failing verdicts — is the one outcome this product treats as worse than finding nothing.
 *
 * @returns {string|null} the sentence to refuse with, or null when the record accounts for
 *   every failing case.
 */
export function rejectUnaccountedFailures(record) {
  const itemResults = arr(record?.itemResults);
  const claims = arr(record?.claims);
  const blockers = arr(record?.blockers);

  const claimed = new Set();
  for (const c of claims) for (const ref of arr(c?.observationRefs)) claimed.add(ref);
  const namedByBlocker = new Set();
  for (const b of blockers) {
    if (b?.kind !== "UNRESOLVED_FAIL_OBSERVATION") continue;
    for (const ref of arr(b?.observationRefs)) namedByBlocker.add(ref);
  }

  const failing = [];
  const unaccounted = [];
  for (const r of itemResults) {
    if (r?.verdict !== "fail" && r?.verdict !== "mixed") continue;
    for (const f of arr(r.facetResults)) {
      if (f?.status !== "fail") continue;
      const observationIds = arr(f.observationIds);
      failing.push(`${r.requirementLineageId}/${f.facetInstanceId ?? "unenumerated"}`);
      const accounted = observationIds.some((id) => claimed.has(id) || namedByBlocker.has(id));
      if (!accounted) {
        unaccounted.push(
          `${r.requirementLineageId}/${f.facetInstanceId ?? "unenumerated"}` +
            ` (observations: ${observationIds.length === 0 ? "none cited" : observationIds.join(", ")})`,
        );
      }
    }
  }

  if (failing.length === 0) return null;
  if (claims.length === 0 && unaccounted.length === 0) {
    // Defensive, and it should be unreachable: every failing case was accounted for, yet not
    // one of them produced a claim. Reaching it means the accounting above and the projections
    // have drifted apart, and a record is not the place to discover that.
    return (
      `${failing.length} failing case(s) are present and the record carries NO claims, yet every one of them ` +
      `reports as accounted for. The failure accounting and the claim projection disagree; refusing to sign.`
    );
  }
  if (unaccounted.length === 0) return null;

  return (
    `${unaccounted.length} of ${failing.length} failing case(s) reach this record with neither a claim nor an ` +
    `UNRESOLVED_FAIL_OBSERVATION blocker: [${unaccounted.join("; ")}]. ` +
    `The record carries ${claims.length} claim(s) and ${blockers.length} blocker(s). A signed record that shows a ` +
    `clean survey over failing verdicts is the one artifact this system must never produce.`
  );
}

// ---------------------------------------------------------------------------
// Supersede — the second signed revision, and never an edit of the first
// ---------------------------------------------------------------------------

export const SUPERSEDER_ID = "v2-record-superseder/1.0.0";

/** The hash a record is known by: the one it was signed over, or its canonical payload hash. */
export function recordHashOf(record) {
  const signed = record?.attestation?.payloadHash;
  return typeof signed === "string" && signed.length > 0 ? signed : payloadHashOf(record);
}

/**
 * BUILD THE SUPERSEDING REVISION FROM THE PRIOR RECORD'S OWN BYTES.
 *
 * ===================== WHY THIS IS NOT A SECOND ASSEMBLY =====================
 *
 * A re-assembly would re-read the evidence catalogue (one LIST plus one GET per entry — 1,707
 * on a real run) inside the judging tail, which is the exact subrequest budget the whole
 * yield-before-judging saga was about; and it would re-stamp `endedAt` and every `observedAt`,
 * so the two revisions would disagree about facts that closure did not change. A supersede
 * that silently re-states the run is not a supersede — it is a second opinion.
 *
 * So revision N+1 IS revision N, field for field, plus exactly two declared additions:
 * `recordRevision` (naming the hash it replaces) and `closure` (what happened after N was
 * signed). Anything else differing between two revisions of one run is a bug, and a diff is
 * enough to see it.
 *
 * THE PRIOR RECORD IS NOT TOUCHED. Its bytes stay valid and stay addressable, so the
 * JudgementRecord bound to its payload hash still resolves. Supersede, never mutate.
 */
export function supersedeRunRecord(prior, { closure, reason }) {
  if (!prior || typeof prior !== "object") {
    throw new Error("supersedeRunRecord: there is no prior record to supersede");
  }
  const priorRevision = Number(prior?.recordRevision?.revision);
  // A record written before revisions existed is revision 1 — the honest reading, since it was
  // the record the judge bound to.
  const n = Number.isFinite(priorRevision) && priorRevision >= 1 ? priorRevision : 1;
  const { attestation, ...body } = prior;
  const priorHash = recordHashOf(prior);
  return {
    ...body,
    recordRevision: {
      revision: n + 1,
      supersedes: {
        recordHash: priorHash,
        revision: n,
        signedAt: typeof attestation?.signedAt === "string" ? attestation.signedAt : null,
        reason,
      },
      // THE HASH THE JUDGEMENT BOUND TO, CARRIED FORWARD FOREVER.
      //
      // `store/judgement.ts` recomputes the payload hash of the record CURRENTLY at `record.json`
      // and requires the judgement to name it. Moving that pointer to a superseding revision
      // would therefore demote every re-derived column to `unusable` — a regression in precisely
      // the artifact this whole change is about. The predecessor link alone is not enough,
      // because it only ever names the revision immediately before this one, and a third
      // revision would orphan a judgement bound to the first. This names revision 1 at every
      // depth, so the binding survives a chain of any length.
      originalRecordHash:
        typeof prior?.recordRevision?.originalRecordHash === "string"
          ? prior.recordRevision.originalRecordHash
          : priorHash,
    },
    closure,
    attestation: null,
  };
}

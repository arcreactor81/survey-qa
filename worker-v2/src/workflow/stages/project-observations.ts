/**
 * PHASE: executing (close) — PROJECT THE WALKS INTO THE RUN'S OBSERVATION LEDGER.
 *
 * THE GAP THIS CLOSES. The executor produced two durable things and neither of them was an
 * `Observation`:
 *
 *   - `browser/capture.ts#capturePathObservation` wrote the walk into the EVIDENCE
 *     CATALOGUE as a content-addressed artifact — a `PathObservation`, keyed by PATH;
 *   - `stages/execute-batch.ts#saveProgress` wrote an `ExecProgress` walk ledger to
 *     `v2/runs/<id>/execution/progress.json`.
 *
 * Every judging stage downstream reads `v2/runs/<id>/observations.json` through
 * `run-inputs.ts#readObservations`, whose own comment names the contract: "the observations
 * the execution stage committed". Nothing ever committed them, so the aggregator ran over an
 * empty array, every sealed case came back `pending`, every requirement `incomplete`, and
 * the judge reported nothing assessed. The verifier's missing `verified` branch was the
 * SECOND blocker; this was the first, and it is upstream of it.
 *
 * WHY THE PRODUCER MOVED AND NOT THE CONSUMER. Pointing `readObservations` at the catalogue
 * would not have worked and would have been wrong twice over:
 *
 *   1. THE SHAPES ARE DISJOINT. A `PathObservation` has no `facetInstanceId`, no
 *      `payloadKind`, no `completeness`, no `verifier` and no `attestation`. The aggregator
 *      (`assemble-record.mjs#aggregate`) buckets by `facetInstanceId` and the signed
 *      `RunRecordV2.observations` is typed `Observation[]`. No reader can conjure those
 *      fields out of a walk record.
 *   2. THE CARDINALITY IS DIFFERENT. A walk is one PATH; the denominator is EXECUTION CASES.
 *      One completed walk closes several sealed cases at once, and only the plan's
 *      `PathAssignment` knows which. That mapping has to be applied by something, and this
 *      is that something.
 *
 * The catalogue therefore stays what it is — the evidence store, whose bytes the judge
 * re-reads and re-hashes — and the observation ledger stays what it is: the run's typed
 * claims about its own cases. Conflating them would put claims in the evidence store, which
 * is the one separation `types/record.ts` spends its `DefectClaim` comment defending.
 *
 * ================== WHAT THIS STAGE MAY AND MAY NOT SAY ==================
 *
 * IT AUTHORS NO VERDICT AND NO VERIFIER DECISION. Every observation it mints leaves
 * `verifier.decision: "insufficient"` with `verifierVersion: "none/not-yet-verified"`, and
 * the verify stage stamps the real decision afterwards. A projection that supplied its own
 * decision would be the first run's defect rebuilt: the step that records what happened
 * deciding whether it was right.
 *
 * IT MINTS AN OBSERVATION ONLY FOR A CASE A WALK ACTUALLY CLOSED. `WalkRecord.caseIds` is
 * populated by the executor only when the walk reached the end of the survey having advanced
 * a screen; a crashed, blocked or capped walk carries an empty list. So a blocked walk
 * produces NO observation, its cases stay `pending`, and the executing-close gate buckets
 * them as blocked. Minting an error-carrying observation instead would let the structural
 * floor demote it to `contradicted` and turn "the site would not load" into "the survey
 * failed this requirement" — a fabricated defect.
 *
 * IT IS IDEMPOTENT. Everything it reads is durable (the plan program, the walk ledger, the
 * catalogue) and the key it writes is derived from that state, so a replacement instance
 * re-running this step produces the same bytes rather than a second, divergent ledger.
 */

import type { Env } from "../../types/env";
import { observationsKey, walkArtifactIndexKey } from "../../keys";
import { sha256Hex, canonicalHash } from "../../store/hash";
import { loadCheckpoint } from "../../store/checkpoint";
import { listCatalog } from "../../store/evidence";
import {
  buildWalkArtifactIndex,
  putWalkArtifactIndex,
  resolveWalkArtifactCandidate,
} from "../../store/walk-artifact-index";
import { stageNotEvaluated, type StageResult } from "../gates";
import type { EvidenceCatalogEntry, Observation } from "../../types/record";
import type { WalkEnding } from "../../browser/types";
import { loadProgram, type ExecutionProgram } from "./plan";
import { loadProgress, type ExecProgress, type WalkRecord } from "./execute-batch";

export const PROJECTION_VERSION = "v2-observation-projection/1.0.0";

/**
 * The payload kind. It says the observation is a PROJECTION OF A WALK and nothing more —
 * calling it `rendered-state` would claim a typed reading of the screen that this stage
 * never performed.
 */
export const WALK_PAYLOAD_KIND = "v2-walk-projection/1.0.0";

/**
 * The citation every predicate re-reads. Pointer only; the bytes live in the catalogue.
 *
 * ================== WHAT THE EXTRA FIELDS ARE, AND WHAT THEY ARE NOT ==================
 *
 * Everything below `observationEvidenceId` is the EXECUTOR'S OWN ACCOUNT OF ITS WALK, copied
 * verbatim under the producer's own names. It is here so the run's signed record can be READ —
 * "this walk was screened out", "the reader hit 3 limitations it could not resolve" — without
 * fetching and re-hashing one R2 artifact per walk, which is how the record is actually
 * audited in practice.
 *
 * NONE OF IT IS EVIDENCE AND NO VERDICT MAY REST ON IT. `verify-observations.ts` takes
 * `observationEvidenceId` from this payload and NOTHING ELSE, then re-reads and re-hashes the
 * artifact bytes and reads the walk's ending off THOSE ("the payload supplies the POINTER and
 * nothing else"). That separation is the reason `structuralDecision` refuses to let a
 * producer-authored payload key mint a defect claim, and adding readable fields here must not
 * become a second route around it. If a future consumer wants to DECIDE on an ending, it reads
 * the artifact, exactly as the verifier does.
 *
 * ABSENCE IS PRESERVED AT BOTH HOPS. Each optional field is copied only when the walk ledger
 * carries it, so a run whose `progress.json` predates the field projects a payload without it —
 * and a reader must take that as "this walk did not say", never as a value. There is no `??`
 * on any of them.
 */
export interface WalkProjectionPayload {
  pathId: string;
  attemptId: string;
  /** The catalogue id of the PathObservation artifact. THE VERIFIER RE-READS THESE BYTES. */
  observationEvidenceId: string | null;
  /** Why the STEP LOOP exited, verbatim from the executor. Not a verdict, and not an ending. */
  outcome: string;
  outcomeDetail: string | null;
  /**
   * HOW THE WALK ENDED — `browser/types.ts#WalkEnding`, carried whole (kind AND the evidence
   * the walker quoted for it).
   *
   * THIS IS THE FIELD THE RECORD WAS MISSING. `outcome: "no-advance-control"` is the value a
   * finished survey AND a walk that never got in both produce; run
   * `v2r_01kzggtye653abaa36sxeg23yd` published 41 observations carrying exactly that and
   * nothing else. The four-state ending (`completed` / `screened-out` / `stalled` /
   * `unclassified`) is what separates them.
   *
   * `unclassified` IS A REAL ANSWER AND IS NEVER FOLDED INTO `completed` — not here, not at the
   * walk-record hop, not anywhere on the producing side. It means the walker reached a screen
   * with nothing left to press and nothing on it said WHICH kind of ending it was; a screen-out
   * page thanks you too. And ABSENT is a fifth, different state: an artifact or ledger row that
   * predates typed endings. A reader that defaults either one to a completion has rebuilt the
   * defect this field exists to remove.
   */
  ending?: WalkEnding;
  screensAdvanced: number;
  steps: number;
  /** Whether the executor judged the walk to have exercised the survey. */
  exercised: boolean;
  /**
   * THE EXERCISED GATE'S OWN DENOMINATOR AND NUMERATOR. `exercised` above is a boolean with no
   * arithmetic attached; these are the two numbers it was computed from, and the only reason
   * run `v2r_01kzfb6py8pbxznqv022p2qkhb` could be re-adjudicated at all was that they were on
   * disk (`execute-batch.ts#WalkRecord`). They travel together: a numerator published without
   * its denominator is the shape this repo keeps mistaking for a result.
   */
  constrainingDecisions?: number;
  matchedConstraining?: number;
  /** Steps carrying POSITIVE evidence the site refused to advance. Absent ≠ zero. */
  blockedSteps?: number;
  /** Planned decisions no screen was ever identified as — what the walk did NOT do. */
  unboundDecisions?: Array<{ question: string; wanted: string[]; reason: string }>;
  /** How many times a screen was refused a binding on this walk. Counted, not implied. */
  bindingRefusalCount?: number;
  /**
   * EVERY LIMITATION THE READER NAMED, carried rather than counted away. "There are 4 footnotes
   * I could not read" is the required behaviour; a payload holding only the total would be the
   * quietly shorter list that rule forbids.
   */
  readerLimitations?: Array<{ stepIndex: number; kind: string; detail: string; count: number }>;
  readerLimitationCount?: number;
  observedAt: string;
}

export interface ProjectionSummary {
  walks: number;
  /** Walks that closed at least one case and so produced observations. */
  contributingWalks: number;
  observations: number;
  /** Cases a walk closed but whose walk artifact could not be located in the catalogue. */
  withoutArtifact: number;
}

/**
 * Locate the PathObservation artifact a walk left in the catalogue.
 *
 * `capture.ts` mints it with `sourceEvidenceId: "EV-<pathId>-observation"` and stamps the
 * attempt on the entry. Both are matched, because a retried path walks twice under two
 * attempt ids and an observation must cite the attempt it is actually a projection of.
 */
export function findWalkArtifact(
  catalog: EvidenceCatalogEntry[],
  walk: WalkRecord,
): EvidenceCatalogEntry | null {
  return resolveWalkArtifactCandidate(catalog, walk).selected;
}

/** Every catalogue entry this attempt produced — the walk's own evidence, by attempt. */
const evidenceForAttempt = (catalog: EvidenceCatalogEntry[], attemptId: string): string[] =>
  catalog.filter((e) => e.attemptId === attemptId).map((e) => e.evidenceId);

/**
 * COMPLETENESS IS A CLAIM ABOUT SCOPE, SO IT TRACKS HOW THE WALK ENDED.
 *
 * `completed` means the walk ran the survey to a terminal screen, and each screen it
 * recorded carries the COMPLETE positive inventory (`browser/types.ts` — a subset "would
 * make every absence claim unfalsifiable"). Anything else saw part of the survey, and
 * `partial` is what forbids a later absence claim from resting on it.
 */
const completenessFor = (walk: WalkRecord): Observation["completeness"] =>
  walk.outcome === "completed" ? "complete-scoped-inventory" : "partial";

export async function projectObservations(env: Env, runId: string): Promise<StageResult<ProjectionSummary>> {
  const loaded = await loadCheckpoint(env, runId);
  const planRevisionId = loaded?.checkpoint?.execution?.planRevisionId ?? null;
  if (!planRevisionId) {
    return stageNotEvaluated<ProjectionSummary>(
      "NO_EXECUTION_PLAN",
      "the run has no plan revision on its cursor, so there is no assignment from walks to sealed execution " +
        "cases and nothing can be projected onto the denominator",
    );
  }

  const program = await loadProgram(env, runId, planRevisionId);
  if (!program) {
    return stageNotEvaluated<ProjectionSummary>(
      "NO_EXECUTION_PROGRAM",
      `the execution program for plan ${planRevisionId} did not re-read from storage, so the mapping from ` +
        `walks to execution cases is unavailable`,
    );
  }

  const progress = await loadProgress(env, runId, planRevisionId);
  const catalog = await listCatalog(env, runId);
  // THE EXECUTION LEDGER IS THE DENOMINATOR. Index every walk before projecting the subset
  // that closed cases. The same in-memory catalogue list drives both operations; no second
  // R2 fan-out is introduced here.
  const walkIndex = buildWalkArtifactIndex({
    runId,
    planRevisionId,
    walks: progress.walks,
    catalog,
  });
  await putWalkArtifactIndex(env.EVIDENCE, walkArtifactIndexKey(runId), walkIndex);
  const observations = await observationsFromWalks(runId, program, progress, catalog);

  await env.EVIDENCE.put(observationsKey(runId), JSON.stringify({ observations: observations.rows }), {
    httpMetadata: { contentType: "application/json" },
  });

  return {
    state: "evaluated",
    value: {
      walks: progress.walks.length,
      contributingWalks: observations.contributingWalks,
      observations: observations.rows.length,
      withoutArtifact: observations.withoutArtifact,
    },
    proof: {
      evaluatorId: PROJECTION_VERSION,
      evaluatorVersion: PROJECTION_VERSION,
      inputHash: `plan:${planRevisionId}|walks:${progress.walks.length}|obs:${observations.rows.length}`,
      observedAt: new Date().toISOString(),
    },
  };
}

/**
 * The projection itself, factored out so it can be exercised without an R2.
 *
 * ONE OBSERVATION PER (CASE, WALK). A case closed by two walks gets two observations and the
 * aggregator's fail-is-absorbing rule decides between them; collapsing them here would let
 * this stage pick a winner, which is a verdict.
 */
export async function observationsFromWalks(
  runId: string,
  program: ExecutionProgram,
  progress: ExecProgress,
  catalog: EvidenceCatalogEntry[],
): Promise<{ rows: Observation[]; contributingWalks: number; withoutArtifact: number }> {
  const rows: Observation[] = [];
  let contributingWalks = 0;
  let withoutArtifact = 0;

  for (const walk of progress.walks) {
    const caseIds = Array.isArray(walk.caseIds) ? walk.caseIds : [];
    if (caseIds.length === 0) continue; // a walk that closed nothing observed nothing it may claim
    contributingWalks += 1;

    const artifactResolution = resolveWalkArtifactCandidate(catalog, walk);
    const artifact = artifactResolution.selected;
    if (!artifact) withoutArtifact += caseIds.length;

    // A PathObservation candidate is a semantic artifact citation, not generic attempt
    // context. When resolution is ambiguous, NONE of the candidates may leak back into the
    // observation through the broad `evidenceForAttempt` list; doing so would still let a
    // downstream reader pick one by array order after this resolver correctly refused.
    const pathObservationCandidateIds = new Set(artifactResolution.candidates.map((entry) => entry.evidenceId));

    const evidenceIds = [
      ...(artifact ? [artifact.evidenceId] : []),
      ...evidenceForAttempt(catalog, walk.attemptId).filter(
        (id) => id !== artifact?.evidenceId && !pathObservationCandidateIds.has(id),
      ),
    ];

    for (const facetInstanceId of caseIds) {
      const payload: WalkProjectionPayload = {
        pathId: walk.pathId,
        attemptId: walk.attemptId,
        observationEvidenceId: artifact?.evidenceId ?? null,
        outcome: walk.outcome,
        outcomeDetail: walk.outcomeDetail,
        screensAdvanced: walk.screensAdvanced,
        steps: walk.steps,
        exercised: walk.exercised === true,
        // COPIED ONLY WHEN THE LEDGER CARRIES IT, and then unchanged. Conditional spreads, not
        // `walk.x ?? default`: a ledger row written before a field existed must project a
        // payload WITHOUT that field, so "the walk did not say" stays distinguishable from
        // "the walk said zero" / "the walk completed". `constrainingDecisions` and
        // `matchedConstraining` are non-optional on `WalkRecord` but `loadProgress` re-reads
        // old JSON with a cast, so at runtime they can genuinely be absent — the guard is
        // load-bearing, not defensive decoration.
        ...(walk.ending !== undefined ? { ending: walk.ending } : {}),
        ...(walk.constrainingDecisions !== undefined ? { constrainingDecisions: walk.constrainingDecisions } : {}),
        ...(walk.matchedConstraining !== undefined ? { matchedConstraining: walk.matchedConstraining } : {}),
        ...(walk.blockedSteps !== undefined ? { blockedSteps: walk.blockedSteps } : {}),
        ...(walk.unboundDecisions !== undefined ? { unboundDecisions: walk.unboundDecisions } : {}),
        ...(walk.bindingRefusalCount !== undefined ? { bindingRefusalCount: walk.bindingRefusalCount } : {}),
        ...(walk.readerLimitations !== undefined ? { readerLimitations: walk.readerLimitations } : {}),
        ...(walk.readerLimitationCount !== undefined ? { readerLimitationCount: walk.readerLimitationCount } : {}),
        observedAt: walk.at,
      };

      rows.push({
        observationId: `obs_${(await sha256Hex(`${runId}|${facetInstanceId}|${walk.attemptId}`)).slice(0, 20)}`,
        facetInstanceId,
        attemptId: walk.attemptId,
        routeId: walk.pathId,
        observedAt: walk.at,
        payloadKind: WALK_PAYLOAD_KIND,
        payload,
        completeness: completenessFor(walk),
        evidenceIds,
        // NO DECISION IS AUTHORED HERE. The verify stage owns it, and "no verifier has run
        // yet" must never be indistinguishable from "a verifier ran and agreed".
        verifier: { decision: "insufficient", evidenceIds, verifierVersion: "none/not-yet-verified" },
        attestation: {
          producedBy: "v2-executor",
          producerVersion: PROJECTION_VERSION,
          payloadHash: `sha256:${await canonicalHash(payload)}`,
        },
      });
    }
  }

  // Deterministic order, so re-running the projection over the same durable state produces
  // byte-identical output rather than whatever order the catalogue listing came back in.
  rows.sort((a, b) => (a.observationId < b.observationId ? -1 : a.observationId > b.observationId ? 1 : 0));
  return { rows, contributingWalks, withoutArtifact };
}

/** Re-export so the plan's assignment stays visible to readers of this file. */
export type { ExecutionProgram };

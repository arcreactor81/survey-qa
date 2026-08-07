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
import { observationsKey } from "../../keys";
import { sha256Hex, canonicalHash } from "../../store/hash";
import { loadCheckpoint } from "../../store/checkpoint";
import { listCatalog } from "../../store/evidence";
import { stageNotEvaluated, type StageResult } from "../gates";
import type { EvidenceCatalogEntry, Observation } from "../../types/record";
import { loadProgram, type ExecutionProgram } from "./plan";
import { loadProgress, type ExecProgress, type WalkRecord } from "./execute-batch";

export const PROJECTION_VERSION = "v2-observation-projection/1.0.0";

/**
 * The payload kind. It says the observation is a PROJECTION OF A WALK and nothing more —
 * calling it `rendered-state` would claim a typed reading of the screen that this stage
 * never performed.
 */
export const WALK_PAYLOAD_KIND = "v2-walk-projection/1.0.0";

/** The citation every predicate re-reads. Pointer only; the bytes live in the catalogue. */
export interface WalkProjectionPayload {
  pathId: string;
  attemptId: string;
  /** The catalogue id of the PathObservation artifact. THE VERIFIER RE-READS THESE BYTES. */
  observationEvidenceId: string | null;
  /** How the walk ended, verbatim from the executor. Not a verdict. */
  outcome: string;
  outcomeDetail: string | null;
  screensAdvanced: number;
  steps: number;
  /** Whether the executor judged the walk to have exercised the survey. */
  exercised: boolean;
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
  const wanted = `EV-${walk.pathId}-observation`;
  return (
    catalog.find((e) => e.sourceEvidenceId === wanted && e.attemptId === walk.attemptId) ??
    // A walk recorded before attempt stamping, or a catalogue whose entry lost its attempt:
    // fall back to the path match ONLY when it is unambiguous.
    (catalog.filter((e) => e.sourceEvidenceId === wanted).length === 1
      ? catalog.find((e) => e.sourceEvidenceId === wanted) ?? null
      : null)
  );
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

    const artifact = findWalkArtifact(catalog, walk);
    if (!artifact) withoutArtifact += caseIds.length;

    const evidenceIds = [
      ...(artifact ? [artifact.evidenceId] : []),
      ...evidenceForAttempt(catalog, walk.attemptId).filter((id) => id !== artifact?.evidenceId),
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

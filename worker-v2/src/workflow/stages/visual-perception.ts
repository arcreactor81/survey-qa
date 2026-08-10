/**
 * PREPARE VISUAL PERCEPTION WORK — NO PROVIDER CALLS.
 *
 * This stage closes the paid-work denominator from the strict walk-artifact index. A caller may
 * only begin inference after this immutable manifest exists. Missing index state is explicitly
 * not evaluated; corrupt index state throws rather than being recast as an empty workload.
 */

import { visualManifestKey, walkArtifactIndexKey } from "../../keys";
import { canonicalHash } from "../../store/hash";
import {
  buildVisualWorkManifest,
  putVisualWorkManifest,
  readVisualWorkManifest,
  VisualWorkCapacityExceededError,
  VISUAL_WORK_UNSHARDED_DENOMINATOR_LIMIT,
  type VisualWorkTotals,
} from "../../store/visual-work";
import { readWalkArtifactIndex } from "../../store/walk-artifact-index";
import type { Env } from "../../types/env";
import { stageNotEvaluated, type StageResult } from "../gates";

const EVALUATOR_VERSION = "visual-work-preparation/1.0.0";

export interface VisualWorkPreparationSummary {
  manifestKey: string;
  manifestSha256: string;
  totals: VisualWorkTotals;
}

export async function prepareVisualPerceptionWork(
  env: Env,
  runId: string,
): Promise<StageResult<VisualWorkPreparationSummary>> {
  const index = await readWalkArtifactIndex(env.EVIDENCE, walkArtifactIndexKey(runId), { runId });
  if (index === null) {
    return stageNotEvaluated(
      "VISUAL_WALK_ARTIFACT_INDEX_MISSING",
      "the strict execution-walk artifact index is absent, so visual epoch coverage is unknown and no paid " +
        "visual request is authorized",
    );
  }

  let manifest;
  try {
    manifest = await buildVisualWorkManifest(env, index, {
      maximumDenominatorItems: VISUAL_WORK_UNSHARDED_DENOMINATOR_LIMIT,
    });
  } catch (error) {
    if (!(error instanceof VisualWorkCapacityExceededError)) throw error;
    return stageNotEvaluated(
      "VISUAL_WORK_CAPACITY_EXCEEDED",
      `the captured run requires at least ${error.observedLowerBound} visual denominator item(s), ` +
        `above the current unsharded capacity of ${error.maximumDenominatorItems}; no paid visual request is authorized`,
    );
  }
  const key = visualManifestKey(runId);
  await putVisualWorkManifest(env.EVIDENCE, key, manifest, { index });
  // Re-read the bytes with the same exact index binding. This checks canonical encoding and makes
  // the stage result evidence about what R2 now holds, not merely about an in-memory object.
  const persisted = await readVisualWorkManifest(env.EVIDENCE, key, { index });
  if (persisted === null) throw new Error(`visual work manifest ${key} disappeared after its immutable write`);
  const manifestSha256 = await canonicalHash(persisted);
  return {
    state: "evaluated",
    value: { manifestKey: key, manifestSha256, totals: persisted.totals },
    proof: {
      evaluatorId: EVALUATOR_VERSION,
      evaluatorVersion: EVALUATOR_VERSION,
      inputHash: `sha256:${manifestSha256}`,
      observedAt: new Date().toISOString(),
    },
  };
}

export const prepareVisualWork = prepareVisualPerceptionWork;

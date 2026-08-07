/**
 * EVIDENCE, WRITTEN AS IT IS CAPTURED — never batched to the end of the walk.
 *
 * A crash between "the browser saw it" and "the run wrote it down" loses the only proof
 * the run had. Each screen read and each screenshot goes into the content-addressed store
 * the moment it exists, so a run that dies mid-path still has every artifact it captured
 * up to that point, and the resumed instance adds to them rather than starting the
 * evidence over.
 *
 * Content-addressing makes that cheap: the same screenshot captured twice is one blob,
 * and re-capturing an identical citation is a no-op rather than a rewrite.
 */

import type { Env } from "../types/env";
import { putEvidence } from "../store/evidence";
import type { PathObservation, RenderedScreen } from "./types";

export interface CaptureContext {
  env: Env;
  runId: string;
  attemptId: string;
  pathId: string;
  /**
   * Obligation ids the plan associates with this walk. Recorded on the artifact as
   * RELEVANCE — "this is the screen where these obligations would be observable" — and
   * never as a claim about whether any of them holds.
   */
  witnesses: string[];
}

const enc = new TextEncoder();

export async function captureScreenJson(
  ctx: CaptureContext,
  screen: RenderedScreen,
  slot: string,
  stepIndex: number,
): Promise<string> {
  const ref = `observations/${ctx.pathId}/step-${String(stepIndex).padStart(3, "0")}-${slot}.json`;
  const entry = await putEvidence(ctx.env, {
    runId: ctx.runId,
    bytes: enc.encode(JSON.stringify(screen)),
    mediaType: "application/json",
    type: "dom-excerpt",
    attemptId: ctx.attemptId,
    routeId: ctx.pathId,
    witnesses: ctx.witnesses,
    sourceEvidenceId: `EV-${ctx.pathId}-${stepIndex}-${slot}`,
    artifactRef: ref,
  });
  return entry.evidenceId;
}

export async function captureScreenshot(
  ctx: CaptureContext,
  png: Uint8Array,
  slot: string,
  stepIndex: number,
): Promise<string> {
  const ref = `observations/${ctx.pathId}/step-${String(stepIndex).padStart(3, "0")}-${slot}.png`;
  const entry = await putEvidence(ctx.env, {
    runId: ctx.runId,
    bytes: png,
    mediaType: "image/png",
    type: "screenshot",
    attemptId: ctx.attemptId,
    routeId: ctx.pathId,
    witnesses: ctx.witnesses,
    sourceEvidenceId: `EV-${ctx.pathId}-${stepIndex}-${slot}-png`,
    artifactRef: ref,
  });
  return entry.evidenceId;
}

/** A page-level failure (load crash, unhandled error). Captured BEFORE any workaround. */
export async function captureFailure(
  ctx: CaptureContext,
  payload: unknown,
  label: string,
): Promise<string> {
  const entry = await putEvidence(ctx.env, {
    runId: ctx.runId,
    bytes: enc.encode(JSON.stringify(payload, null, 2)),
    mediaType: "application/json",
    type: "trace",
    attemptId: ctx.attemptId,
    routeId: ctx.pathId,
    witnesses: ctx.witnesses,
    sourceEvidenceId: `EV-${ctx.pathId}-${label}`,
    artifactRef: `observations/${ctx.pathId}/${label}.json`,
  });
  return entry.evidenceId;
}

/** The whole walk, as one durable observation record. */
export async function capturePathObservation(ctx: CaptureContext, obs: PathObservation): Promise<string> {
  const entry = await putEvidence(ctx.env, {
    runId: ctx.runId,
    bytes: enc.encode(JSON.stringify(obs)),
    mediaType: "application/json",
    type: "state",
    attemptId: ctx.attemptId,
    routeId: ctx.pathId,
    witnesses: ctx.witnesses,
    sourceEvidenceId: `EV-${ctx.pathId}-observation`,
    artifactRef: `observations/${ctx.pathId}/observation.json`,
  });
  return entry.evidenceId;
}

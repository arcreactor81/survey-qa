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
import type { EvidenceCatalogEntry } from "../types/record";
import type {
  AccessibilitySnapshotArtifact,
  PathObservation,
  RenderedScreen,
  ScreenArtifactRef,
} from "./types";

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

/**
 * THE BASENAME OF AN artifactRef IS ITS IDENTITY EVERYWHERE DOWNSTREAM, SO IT MUST BE UNIQUE.
 *
 * `pipeline/judge/lib/authority.mjs` keys the SIGNED evidence catalogue by
 * `basename(artifactRef)`, and `run-inputs.ts` / `judge-runtime.mjs` name the judge's mount
 * the same way. Refs that differ only in their directory therefore collapse onto one name:
 * every walk wrote `observations/<pathId>/observation.json`, so the catalogue raised
 * MANIFEST_DUPLICATE_ARTIFACT for every walk after the first, `manifestComplete` went false,
 * the authority went unverified, and the run minted NO judgement at all. The mount overwrote
 * the files into the bargain.
 *
 * The fix is here rather than in the judge's keying because the legacy v1 refs are
 * multi-segment (`runs/<id>/artifacts/EXP-07.json`) and already unique under `basename`.
 * One rule everywhere beats two.
 *
 * `pathId` is unique by construction (`plan.ts` refuses duplicates), but it is composed from
 * facet-instance ids, so it is squeezed to a filename-safe alphabet before it is used as one.
 */
export function artifactSlug(pathId: string): string {
  const safe = String(pathId).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+/, "");
  return safe.length > 0 ? safe : "path";
}

const observationRef = (pathId: string, leaf: string): string =>
  `observations/${pathId}/${artifactSlug(pathId)}-${leaf}`;

function typedRef<K extends ScreenArtifactRef["kind"]>(
  entry: EvidenceCatalogEntry,
  kind: K,
  artifactRef: string,
  sourceEvidenceId: string,
  mediaType: ScreenArtifactRef["mediaType"],
): ScreenArtifactRef & { kind: K } {
  return {
    kind,
    evidenceId: entry.evidenceId,
    artifactRef,
    sourceEvidenceId,
    contentHash: entry.contentHash,
    mediaType,
    size: entry.size,
  };
}

/** The typed form used by paired screen epochs. The legacy string-returning API stays below. */
export async function captureScreenJsonRef(
  ctx: CaptureContext,
  screen: RenderedScreen,
  slot: string,
  stepIndex: number,
): Promise<ScreenArtifactRef & { kind: "screen-json" }> {
  const ref = observationRef(ctx.pathId, `step-${String(stepIndex).padStart(3, "0")}-${slot}.json`);
  const sourceEvidenceId = `EV-${ctx.pathId}-${stepIndex}-${slot}`;
  const entry = await putEvidence(ctx.env, {
    runId: ctx.runId,
    bytes: enc.encode(JSON.stringify(screen)),
    mediaType: "application/json",
    type: "dom-excerpt",
    attemptId: ctx.attemptId,
    routeId: ctx.pathId,
    witnesses: ctx.witnesses,
    sourceEvidenceId,
    artifactRef: ref,
  });
  return typedRef(entry, "screen-json", ref, sourceEvidenceId, "application/json");
}

export async function captureScreenJson(
  ctx: CaptureContext,
  screen: RenderedScreen,
  slot: string,
  stepIndex: number,
): Promise<string> {
  return (await captureScreenJsonRef(ctx, screen, slot, stepIndex)).evidenceId;
}

/** The typed form used by paired screen epochs. The legacy string-returning API stays below. */
export async function captureScreenshotRef(
  ctx: CaptureContext,
  png: Uint8Array,
  slot: string,
  stepIndex: number,
): Promise<ScreenArtifactRef & { kind: "screenshot" }> {
  const ref = observationRef(ctx.pathId, `step-${String(stepIndex).padStart(3, "0")}-${slot}.png`);
  const sourceEvidenceId = `EV-${ctx.pathId}-${stepIndex}-${slot}-png`;
  const entry = await putEvidence(ctx.env, {
    runId: ctx.runId,
    bytes: png,
    mediaType: "image/png",
    type: "screenshot",
    attemptId: ctx.attemptId,
    routeId: ctx.pathId,
    witnesses: ctx.witnesses,
    sourceEvidenceId,
    artifactRef: ref,
  });
  return typedRef(entry, "screenshot", ref, sourceEvidenceId, "image/png");
}

export async function captureScreenshot(
  ctx: CaptureContext,
  png: Uint8Array,
  slot: string,
  stepIndex: number,
): Promise<string> {
  return (await captureScreenshotRef(ctx, png, slot, stepIndex)).evidenceId;
}

/**
 * Chrome's sanitised accessibility tree plus the pairing metadata for its exact screen epoch.
 * The payload is already a closed plain-data shape; no ElementHandle can cross this boundary.
 */
export async function captureAccessibilitySnapshot(
  ctx: CaptureContext,
  payload: AccessibilitySnapshotArtifact,
  slot: string,
  stepIndex: number,
): Promise<ScreenArtifactRef & { kind: "accessibility" }> {
  const ref = observationRef(
    ctx.pathId,
    `step-${String(stepIndex).padStart(3, "0")}-${slot}.accessibility.json`,
  );
  const sourceEvidenceId = `EV-${ctx.pathId}-${stepIndex}-${slot}-ax`;
  const entry = await putEvidence(ctx.env, {
    runId: ctx.runId,
    bytes: enc.encode(JSON.stringify(payload)),
    mediaType: "application/json",
    type: "state",
    attemptId: ctx.attemptId,
    routeId: ctx.pathId,
    witnesses: ctx.witnesses,
    sourceEvidenceId,
    artifactRef: ref,
  });
  return typedRef(entry, "accessibility", ref, sourceEvidenceId, "application/json");
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
    artifactRef: observationRef(ctx.pathId, `${label}.json`),
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
    artifactRef: observationRef(ctx.pathId, "observation.json"),
  });
  return entry.evidenceId;
}

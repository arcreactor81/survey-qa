/**
 * Bounded, read-only projection of the exact capture epochs recorded by browser walks.
 *
 * The immutable walk-artifact index is the only discovery authority. A catalog filename,
 * listing order, stable screen signature, DOM id, or one-question-per-screen convention never
 * creates a pairing here. The endpoint verifies the selected PathObservation bytes, decodes its
 * complete strict envelope, and then exact-binds each explicitly typed modality reference to its
 * per-run catalog row. Large PNG/PDF/JSON modality bytes remain behind the evidence content
 * endpoint, which re-hashes them when the browser actually opens that exact link.
 */

import type {
  ScreenArtifactRef,
  ScreenCaptureEpoch,
  ScreenCaptureFailure,
} from "../browser/types";
import { isV2RunId } from "../ids";
import { walkArtifactIndexKey } from "../keys";
import type { Env } from "../types/env";
import type { EvidenceCatalogEntry } from "../types/record";
import { getBoundCatalogEntry, getVerifiedEvidence } from "../store/evidence";
import {
  decodePathObservationScreenCaptures,
  type DecodedPathObservationScreenCaptures,
} from "../store/visual-work";
import {
  readWalkArtifactIndex,
  type WalkArtifactBinding,
  type WalkArtifactIndex,
  type WalkArtifactIndexRow,
} from "../store/walk-artifact-index";
import { fail, json } from "./http";

export const SCREEN_EVIDENCE_PAGE_SCHEMA_VERSION = "survey-qa-screen-evidence-page/1.0.0" as const;

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const MAX_WALK_ORDINAL = 99_999;
const MAX_EPOCH_ORDINAL = 499_999;

type ModalityName = "extracted-json" | "screenshot" | "pdf" | "accessibility";

type FixedLimitationKind =
  | "walk-artifact-index-missing"
  | "walk-artifact-missing"
  | "walk-artifact-mismatched"
  | "walk-artifact-ambiguous"
  | "legacy-walk-artifact-resolution"
  | "walk-artifact-catalog-entry-missing"
  | "walk-artifact-catalog-binding-failed"
  | "walk-artifact-index-catalog-mismatch"
  | "walk-artifact-kind-invalid"
  | "walk-artifact-bytes-unreadable"
  | "walk-artifact-envelope-invalid"
  | "walk-artifact-identity-mismatch"
  | "screen-captures-not-recorded-by-reader"
  | "no-screen-capture-epochs-recorded"
  | "inconsistent-declared-capture-counts"
  | "pdf-not-recorded-by-reader"
  | "evidence-catalog-entry-missing"
  | "evidence-catalog-binding-failed"
  | "evidence-reference-catalog-mismatch";

type LimitationKind = FixedLimitationKind | `capture-failure:${ScreenCaptureFailure["kind"]}`;

interface LimitationProjection {
  kind: LimitationKind;
  explanation: string;
  count: number;
  modality: ModalityName | null;
}

interface IndexLimitationProjection extends LimitationProjection {
  rows: number;
  occurrences: number;
}

interface CursorPosition {
  walkOrdinal: number;
  epochOrdinal: number;
}

interface CatalogBoundModality {
  status: "catalog-bound";
  verification: "on-content-request";
  evidenceId: string;
  mediaType: string;
  size: number;
  sha256: string;
  href: string;
}

interface UnavailableModality {
  status: "unavailable" | "failed" | "not-recorded";
  reason: LimitationKind;
  count: number;
}

type ModalityProjection = CatalogBoundModality | UnavailableModality;

interface LimitationEntry {
  kind: "limitation";
  cursor: string;
  walkOrdinal: number;
  epochOrdinal: -1;
  limitations: LimitationProjection[];
}

interface ScreenEntry {
  kind: "captured-screen";
  cursor: string;
  walkOrdinal: number;
  epochOrdinal: number;
  stepIndex: number;
  scope: ScreenCaptureEpoch["scope"];
  startedAt: string;
  endedAt: string;
  screenReadAt: string;
  extractedJson: ModalityProjection;
  screenshot: ModalityProjection;
  pdf: ModalityProjection;
  accessibility: ModalityProjection;
  limitations: LimitationProjection[];
}

type ScreenEvidenceEntry = LimitationEntry | ScreenEntry;

interface ReadWalkResult {
  decoded: DecodedPathObservationScreenCaptures | null;
  limitations: LimitationProjection[];
}

interface CatalogProjectionResult {
  value: ModalityProjection;
  limitation: LimitationProjection | null;
}

const FIXED_EXPLANATIONS: Record<FixedLimitationKind, string> = {
  "walk-artifact-index-missing": "The run has no saved walk index, so a screen denominator is not available.",
  "walk-artifact-missing": "No walk artifact was selected for this recorded walk.",
  "walk-artifact-mismatched": "The only recorded candidate belongs to a different attempt.",
  "walk-artifact-ambiguous": "More than one recorded candidate could match this walk.",
  "legacy-walk-artifact-resolution": "This older walk artifact has no exact attempt binding.",
  "walk-artifact-catalog-entry-missing": "The selected walk artifact is absent from the run catalog.",
  "walk-artifact-catalog-binding-failed": "The selected walk artifact failed its catalog binding check.",
  "walk-artifact-index-catalog-mismatch": "The catalog row does not exactly match the indexed selection.",
  "walk-artifact-kind-invalid": "The selected walk artifact is not recorded as PathObservation JSON state.",
  "walk-artifact-bytes-unreadable": "The selected walk artifact bytes failed their stored hash check.",
  "walk-artifact-envelope-invalid": "The selected walk artifact is not a strict PathObservation envelope.",
  "walk-artifact-identity-mismatch": "The PathObservation identity does not match its indexed walk.",
  "screen-captures-not-recorded-by-reader": "This older observation did not record screen-capture epochs.",
  "no-screen-capture-epochs-recorded": "This observation recorded zero screen-capture epochs.",
  "inconsistent-declared-capture-counts": "Declared capture counts do not reconcile with recorded capture rows.",
  "pdf-not-recorded-by-reader": "This historical capture kind did not record a PDF rendition.",
  "evidence-catalog-entry-missing": "A typed capture reference is absent from the run catalog.",
  "evidence-catalog-binding-failed": "A typed capture reference failed its catalog binding check.",
  "evidence-reference-catalog-mismatch": "A typed capture reference does not exactly match its catalog row.",
};

function explanation(kind: LimitationKind): string {
  return kind.startsWith("capture-failure:")
    ? "The browser recorded a named capture failure for this representation."
    : FIXED_EXPLANATIONS[kind as FixedLimitationKind];
}

// API_AUTHORITY_CLOSED_LIMITATION_PROJECTION: raw capture failure details, target URLs,
// DOM/model text, storage keys, and caught exception messages never enter the response. Only
// strict decoder-owned codes, server-authored copy, safe ordinals, and mechanical counts do.
function limitation(kind: LimitationKind, count = 1, modality: ModalityName | null = null): LimitationProjection {
  return { kind, explanation: explanation(kind), count, modality };
}

function screenFail(status: number, code: string, message: string): Response {
  const response = fail(status, code, message);
  response.headers.set("cache-control", "no-store");
  return response;
}

function parseLimit(url: URL): number | null {
  const values = url.searchParams.getAll("limit");
  if (values.length === 0) return DEFAULT_LIMIT;
  if (values.length !== 1 || !/^(?:[1-9]|1[0-9]|20)$/.test(values[0]!)) return null;
  return Number(values[0]);
}

function parseCursorValue(value: string | null): CursorPosition | null | "invalid" {
  if (value === null) return null;
  const match = /^(0|[1-9][0-9]*):(-1|0|[1-9][0-9]*)$/.exec(value);
  if (!match) return "invalid";
  const walkOrdinal = Number(match[1]);
  const epochOrdinal = Number(match[2]);
  if (!Number.isSafeInteger(walkOrdinal) || !Number.isSafeInteger(epochOrdinal)) return "invalid";
  if (walkOrdinal > MAX_WALK_ORDINAL || epochOrdinal > MAX_EPOCH_ORDINAL) return "invalid";
  return { walkOrdinal, epochOrdinal };
}

function cursorString(position: CursorPosition): string {
  return `${position.walkOrdinal}:${position.epochOrdinal}`;
}

function indexLimitations(index: WalkArtifactIndex): IndexLimitationProjection[] {
  const rows: Array<[LimitationKind, number]> = [
    ["legacy-walk-artifact-resolution", index.totals.legacy],
    ["walk-artifact-missing", index.totals.missing],
    ["walk-artifact-mismatched", index.totals.mismatched],
    ["walk-artifact-ambiguous", index.totals.ambiguous],
  ];
  return rows
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => ({ ...limitation(kind, count), rows: count, occurrences: count }));
}

function unresolvedKind(row: WalkArtifactIndexRow): LimitationKind | null {
  if (row.state === "missing") return "walk-artifact-missing";
  if (row.state === "mismatched") return "walk-artifact-mismatched";
  if (row.state === "ambiguous") return "walk-artifact-ambiguous";
  return null;
}

function optionalString(value: string | null | undefined): string | null {
  return value ?? null;
}

function walkCatalogMatches(entry: EvidenceCatalogEntry, selected: WalkArtifactBinding): boolean {
  return (
    entry.evidenceId === selected.evidenceId &&
    optionalString(entry.artifactRef) === selected.artifactRef &&
    entry.contentHash === selected.contentHash &&
    entry.mediaType === selected.mediaType &&
    optionalString(entry.sourceEvidenceId) === selected.sourceEvidenceId &&
    optionalString(entry.attemptId) === selected.attemptId &&
    optionalString(entry.routeId) === selected.routeId &&
    entry.type === selected.type &&
    entry.size === selected.size
  );
}

async function readWalk(env: Env, index: WalkArtifactIndex, row: WalkArtifactIndexRow): Promise<ReadWalkResult> {
  const unresolved = unresolvedKind(row);
  if (unresolved !== null || row.selected === null) {
    return { decoded: null, limitations: [limitation(unresolved ?? "walk-artifact-ambiguous")] };
  }

  let entry: EvidenceCatalogEntry | null;
  try {
    entry = await getBoundCatalogEntry(env, index.runId, row.selected.evidenceId);
  } catch {
    return { decoded: null, limitations: [limitation("walk-artifact-catalog-binding-failed")] };
  }
  if (entry === null) {
    return { decoded: null, limitations: [limitation("walk-artifact-catalog-entry-missing")] };
  }
  if (!walkCatalogMatches(entry, row.selected)) {
    return { decoded: null, limitations: [limitation("walk-artifact-index-catalog-mismatch")] };
  }
  if (entry.mediaType !== "application/json" || entry.type !== "state") {
    return { decoded: null, limitations: [limitation("walk-artifact-kind-invalid")] };
  }

  let bytes: Uint8Array;
  try {
    bytes = (await getVerifiedEvidence(env, entry)).bytes;
  } catch {
    return { decoded: null, limitations: [limitation("walk-artifact-bytes-unreadable")] };
  }

  let decoded: DecodedPathObservationScreenCaptures;
  try {
    decoded = decodePathObservationScreenCaptures(bytes);
  } catch {
    return { decoded: null, limitations: [limitation("walk-artifact-envelope-invalid")] };
  }
  if (
    decoded.runId !== index.runId ||
    decoded.planRevisionId !== index.planRevisionId ||
    decoded.pathId !== row.pathId ||
    decoded.attemptId !== row.attemptId
  ) {
    return { decoded: null, limitations: [limitation("walk-artifact-identity-mismatch")] };
  }

  const limitations: LimitationProjection[] = [];
  if (row.state === "legacy") limitations.push(limitation("legacy-walk-artifact-resolution"));
  if (!decoded.screenCapturesFieldPresent) {
    limitations.push(limitation("screen-captures-not-recorded-by-reader"));
  } else if (decoded.screenCaptures.length === 0) {
    limitations.push(limitation("no-screen-capture-epochs-recorded"));
  }
  if (decoded.countIssues.length > 0) {
    limitations.push(limitation("inconsistent-declared-capture-counts", decoded.countIssues.length));
  }
  limitations.push(...captureFailureLimitations(decoded.walkCaptureFailures));
  return { decoded, limitations };
}

function expectedCatalogType(kind: ScreenArtifactRef["kind"]): EvidenceCatalogEntry["type"] {
  if (kind === "screen-json") return "dom-excerpt";
  if (kind === "screenshot") return "screenshot";
  if (kind === "accessibility") return "state";
  return "other";
}

// API_AUTHORITY_EXACT_REF_BINDING: a typed epoch reference authorizes exactly one catalog row.
// Any changed id/hash/ref/source/media/size, wrong producer attempt/route, or wrong artifact type
// is a refusal. Catalog order and filename suffixes are never fallback selectors.
function modalityCatalogMatches(
  entry: EvidenceCatalogEntry,
  ref: ScreenArtifactRef,
  row: WalkArtifactIndexRow,
): boolean {
  return (
    entry.evidenceId === ref.evidenceId &&
    optionalString(entry.artifactRef) === ref.artifactRef &&
    optionalString(entry.sourceEvidenceId) === ref.sourceEvidenceId &&
    entry.contentHash === ref.contentHash &&
    entry.mediaType === ref.mediaType &&
    entry.size === ref.size &&
    optionalString(entry.attemptId) === row.attemptId &&
    optionalString(entry.routeId) === row.pathId &&
    entry.type === expectedCatalogType(ref.kind)
  );
}

async function projectCatalogModality(
  env: Env,
  runId: string,
  row: WalkArtifactIndexRow,
  ref: ScreenArtifactRef,
  modality: ModalityName,
): Promise<CatalogProjectionResult> {
  let entry: EvidenceCatalogEntry | null;
  try {
    entry = await getBoundCatalogEntry(env, runId, ref.evidenceId);
  } catch {
    const problem = limitation("evidence-catalog-binding-failed", 1, modality);
    return { value: { status: "unavailable", reason: problem.kind, count: 1 }, limitation: problem };
  }
  if (entry === null) {
    const problem = limitation("evidence-catalog-entry-missing", 1, modality);
    return { value: { status: "unavailable", reason: problem.kind, count: 1 }, limitation: problem };
  }
  if (!modalityCatalogMatches(entry, ref, row)) {
    const problem = limitation("evidence-reference-catalog-mismatch", 1, modality);
    return { value: { status: "unavailable", reason: problem.kind, count: 1 }, limitation: problem };
  }
  return {
    value: {
      status: "catalog-bound",
      verification: "on-content-request",
      evidenceId: entry.evidenceId,
      mediaType: entry.mediaType,
      size: entry.size,
      sha256: entry.contentHash,
      href: `/api/v2/runs/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(entry.evidenceId)}/content`,
    },
    limitation: null,
  };
}

function failureModality(kind: ScreenCaptureFailure["kind"]): ModalityName | null {
  if (kind.startsWith("screenshot-")) return "screenshot";
  if (kind.startsWith("pdf-")) return "pdf";
  if (kind.startsWith("accessibility-")) return "accessibility";
  if (kind === "screen-read-failed") return "extracted-json";
  return null;
}

function captureFailureLimitations(failures: readonly ScreenCaptureFailure[]): LimitationProjection[] {
  const counts = new Map<string, LimitationProjection>();
  for (const failure of failures) {
    const kind = `capture-failure:${failure.kind}` as const;
    const modality = failureModality(failure.kind);
    const key = `${kind}|${modality ?? "walk"}`;
    const current = counts.get(key);
    if (current) current.count += failure.count;
    else counts.set(key, limitation(kind, failure.count, modality));
  }
  return [...counts.values()];
}

function addLimitation(
  target: Map<string, LimitationProjection>,
  value: LimitationProjection,
  mode: "sum" | "at-least" = "sum",
): void {
  const key = `${value.kind}|${value.modality ?? "walk"}`;
  const current = target.get(key);
  if (!current) target.set(key, { ...value });
  else if (mode === "sum") current.count += value.count;
  else current.count = Math.max(current.count, value.count);
}

function recordedFailure(failure: ScreenCaptureFailure): CatalogProjectionResult {
  const kind = `capture-failure:${failure.kind}` as const;
  return {
    value: { status: "failed", reason: kind, count: failure.count },
    limitation: limitation(kind, failure.count, failureModality(failure.kind)),
  };
}

async function projectScreen(
  env: Env,
  runId: string,
  row: WalkArtifactIndexRow,
  epoch: ScreenCaptureEpoch,
  epochOrdinal: number,
): Promise<ScreenEntry> {
  const extractedJsonPromise = projectCatalogModality(env, runId, row, epoch.screenJson, "extracted-json");
  const screenshotPromise = epoch.screenshot.status === "captured"
    ? projectCatalogModality(env, runId, row, epoch.screenshot.ref, "screenshot")
    : Promise.resolve(recordedFailure(epoch.screenshot.failure));
  const pdfPromise = epoch.kind === "v2-screen-capture-epoch/1.0.0"
    ? Promise.resolve<CatalogProjectionResult>({
        value: { status: "not-recorded", reason: "pdf-not-recorded-by-reader", count: 1 },
        limitation: limitation("pdf-not-recorded-by-reader", 1, "pdf"),
      })
    : epoch.pdf.status === "captured"
      ? projectCatalogModality(env, runId, row, epoch.pdf.ref, "pdf")
      : Promise.resolve(recordedFailure(epoch.pdf.failure));
  const accessibilityPromise = epoch.accessibility.status === "captured"
    ? projectCatalogModality(env, runId, row, epoch.accessibility.ref, "accessibility")
    : Promise.resolve(recordedFailure(epoch.accessibility.failure));

  const [extractedJson, screenshot, pdf, accessibility] = await Promise.all([
    extractedJsonPromise,
    screenshotPromise,
    pdfPromise,
    accessibilityPromise,
  ]);
  const limitations = new Map<string, LimitationProjection>();
  for (const item of captureFailureLimitations(epoch.captureFailures)) addLimitation(limitations, item);
  for (const result of [extractedJson, screenshot, pdf, accessibility]) {
    if (result.limitation) {
      addLimitation(
        limitations,
        result.limitation,
        result.value.status === "failed" ? "at-least" : "sum",
      );
    }
  }

  return {
    kind: "captured-screen",
    cursor: cursorString({ walkOrdinal: row.walkOrdinal, epochOrdinal }),
    walkOrdinal: row.walkOrdinal,
    epochOrdinal,
    stepIndex: epoch.stepIndex,
    scope: epoch.scope,
    startedAt: epoch.startedAt,
    endedAt: epoch.endedAt,
    screenReadAt: epoch.screenReadAt,
    extractedJson: extractedJson.value,
    screenshot: screenshot.value,
    pdf: pdf.value,
    accessibility: accessibility.value,
    limitations: [...limitations.values()],
  };
}

function limitationEntry(row: WalkArtifactIndexRow, limitations: LimitationProjection[]): LimitationEntry {
  return {
    kind: "limitation",
    cursor: cursorString({ walkOrdinal: row.walkOrdinal, epochOrdinal: -1 }),
    walkOrdinal: row.walkOrdinal,
    epochOrdinal: -1,
    limitations,
  };
}

function cursorExists(cursor: CursorPosition, result: ReadWalkResult): boolean {
  if (cursor.epochOrdinal === -1) return result.limitations.length > 0;
  return result.decoded !== null && cursor.epochOrdinal < result.decoded.screenCaptures.length;
}

function hasLaterPosition(
  result: ReadWalkResult,
  descriptorIndex: number,
  descriptorCount: number,
  row: WalkArtifactIndexRow,
  index: WalkArtifactIndex,
): boolean {
  return descriptorIndex + 1 < descriptorCount || row.walkOrdinal + 1 < index.rows.length ||
    (result.decoded !== null && result.decoded.screenCaptures.length > 0 && descriptorCount === 0);
}

export async function getScreens(req: Request, env: Env, runId: string): Promise<Response> {
  // Keep this namespace boundary identical to every other public v2 run endpoint. It must run
  // before query parsing or storage access so a v1/foreign id cannot become a plausible empty
  // screen list (or a key-derived storage error).
  if (!isV2RunId(runId)) {
    return screenFail(404, "NOT_A_V2_RUN", `${runId} is not a survey-qa-v2 run id`);
  }
  const url = new URL(req.url);
  for (const key of url.searchParams.keys()) {
    if (key !== "limit" && key !== "cursor") {
      return screenFail(400, "SCREEN_EVIDENCE_QUERY_INVALID", "only limit and cursor query parameters are supported");
    }
  }
  const limit = parseLimit(url);
  if (limit === null || limit < 1 || limit > MAX_LIMIT) {
    return screenFail(400, "SCREEN_EVIDENCE_LIMIT_INVALID", `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  const cursorValues = url.searchParams.getAll("cursor");
  if (cursorValues.length > 1) {
    return screenFail(400, "SCREEN_EVIDENCE_CURSOR_INVALID", "cursor must be supplied at most once");
  }
  const requestedCursorText = cursorValues[0] ?? null;
  const requestedCursor = parseCursorValue(requestedCursorText);
  if (requestedCursor === "invalid") {
    return screenFail(400, "SCREEN_EVIDENCE_CURSOR_INVALID", "cursor must be walkOrdinal:epochOrdinal");
  }

  let index: WalkArtifactIndex | null;
  try {
    index = await readWalkArtifactIndex(env.EVIDENCE, walkArtifactIndexKey(runId), { runId });
  } catch {
    return screenFail(
      500,
      "SCREEN_EVIDENCE_INDEX_INVALID",
      "the saved walk index did not pass strict validation; no screen projection was served",
    );
  }
  if (index === null) {
    const missing = limitation("walk-artifact-index-missing");
    return json(
      {
        schemaVersion: SCREEN_EVIDENCE_PAGE_SCHEMA_VERSION,
        state: "unavailable",
        runId,
        cursor: requestedCursorText,
        limit,
        entries: [],
        nextCursor: null,
        denominator: null,
        indexLimitations: [{ ...missing, rows: 1, occurrences: 1 }],
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
  if (requestedCursor !== null && requestedCursor.walkOrdinal >= index.rows.length) {
    return screenFail(400, "SCREEN_EVIDENCE_CURSOR_INVALID", "cursor does not name a saved walk position");
  }

  const entries: ScreenEvidenceEntry[] = [];
  const startWalk = requestedCursor?.walkOrdinal ?? 0;
  let cursorConfirmed = requestedCursor === null;
  let nextCursor: string | null = null;

  for (let walkOrdinal = startWalk; walkOrdinal < index.rows.length; walkOrdinal += 1) {
    const row = index.rows[walkOrdinal]!;
    const result = await readWalk(env, index, row);
    if (requestedCursor !== null && walkOrdinal === requestedCursor.walkOrdinal) {
      cursorConfirmed = cursorExists(requestedCursor, result);
      if (!cursorConfirmed) {
        return screenFail(400, "SCREEN_EVIDENCE_CURSOR_INVALID", "cursor does not name a saved evidence position");
      }
    }

    const descriptors: Array<{ epochOrdinal: number; limitations: LimitationProjection[] | null }> = [];
    if (result.limitations.length > 0) descriptors.push({ epochOrdinal: -1, limitations: result.limitations });
    if (result.decoded !== null) {
      for (let epochOrdinal = 0; epochOrdinal < result.decoded.screenCaptures.length; epochOrdinal += 1) {
        descriptors.push({ epochOrdinal, limitations: null });
      }
    }
    // `readWalk` always emits a limitation for an unreadable/unresolved/zero-epoch walk.
    // This guard is a fail-loud fallback, not a second discovery rule.
    if (descriptors.length === 0) {
      descriptors.push({
        epochOrdinal: -1,
        limitations: [limitation("no-screen-capture-epochs-recorded")],
      });
    }

    for (let descriptorIndex = 0; descriptorIndex < descriptors.length; descriptorIndex += 1) {
      const descriptor = descriptors[descriptorIndex]!;
      if (
        requestedCursor !== null &&
        walkOrdinal === requestedCursor.walkOrdinal &&
        descriptor.epochOrdinal <= requestedCursor.epochOrdinal
      ) {
        continue;
      }
      const entry = descriptor.epochOrdinal === -1
        ? limitationEntry(row, descriptor.limitations ?? [])
        : await projectScreen(
            env,
            runId,
            row,
            result.decoded!.screenCaptures[descriptor.epochOrdinal]!,
            descriptor.epochOrdinal,
          );
      entries.push(entry);
      if (entries.length === limit) {
        nextCursor = hasLaterPosition(result, descriptorIndex, descriptors.length, row, index)
          ? entry.cursor
          : null;
        break;
      }
    }
    if (entries.length === limit) break;
  }

  if (!cursorConfirmed) {
    return screenFail(400, "SCREEN_EVIDENCE_CURSOR_INVALID", "cursor was not found in the saved evidence order");
  }
  return json(
    {
      schemaVersion: SCREEN_EVIDENCE_PAGE_SCHEMA_VERSION,
      state: "available",
      runId,
      cursor: requestedCursorText,
      limit,
      entries,
      nextCursor,
      denominator: {
        walks: index.totals.walks,
        exact: index.totals.exact,
        legacy: index.totals.legacy,
        missing: index.totals.missing,
        mismatched: index.totals.mismatched,
        ambiguous: index.totals.ambiguous,
        unresolved: index.totals.unresolved,
      },
      indexLimitations: indexLimitations(index),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

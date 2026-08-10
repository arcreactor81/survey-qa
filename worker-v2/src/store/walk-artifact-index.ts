/**
 * DETERMINISTIC WALK -> PathObservation CATALOGUE RESOLUTION.
 *
 * The execution ledger is the denominator: every walk gets one row, including crashed,
 * blocked, capped, and otherwise non-contributing walks. The evidence catalogue is only the
 * candidate set. A catalogue order can never select a winner.
 *
 * Current capture code identifies a whole-walk PathObservation with the internal producer id
 * `EV-<pathId>-observation` and stamps `attemptId`. That is an explicit producer contract, not
 * a survey/platform convention. Older catalogue rows did not reliably carry the attempt. The
 * legacy fallback is therefore retained only when the path producer id has exactly one candidate;
 * the index names that degraded resolution instead of presenting it as an exact match.
 */

import { assertV2Key } from "../keys";
import type { EvidenceCatalogEntry } from "../types/record";
import { canonicalJson } from "./hash";

const enc = new TextEncoder();
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const HASH = /^[0-9a-f]{64}$/;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_WALKS = 100_000;
const MAX_CANDIDATES_PER_WALK = 10_000;

export const WALK_ARTIFACT_INDEX_SCHEMA_VERSION = "survey-qa-walk-artifact-index/1.0.0" as const;

export type WalkArtifactResolutionState = "exact" | "legacy" | "missing" | "mismatched" | "ambiguous";

export interface WalkArtifactIndexWalk {
  pathId: string;
  attemptId: string;
  at: string;
  caseIds?: string[];
}

export interface WalkArtifactBinding {
  evidenceId: string;
  artifactRef: string | null;
  contentHash: string;
  mediaType: string;
  sourceEvidenceId: string;
  attemptId: string | null;
  routeId: string | null;
  type: EvidenceCatalogEntry["type"];
  size: number;
}

export interface WalkArtifactIndexRow {
  walkOrdinal: number;
  pathId: string;
  attemptId: string;
  observedAt: string;
  caseIds: string[];
  contributesObservations: boolean;
  expectedSourceEvidenceId: string;
  state: WalkArtifactResolutionState;
  candidateCount: number;
  exactCandidateCount: number;
  selected: WalkArtifactBinding | null;
  /** Every path candidate, sorted by closed binding content. Never silently shortened. */
  candidates: WalkArtifactBinding[];
}

export interface WalkArtifactIndexTotals {
  walks: number;
  contributingWalks: number;
  exact: number;
  legacy: number;
  missing: number;
  mismatched: number;
  ambiguous: number;
  uniquelyResolved: number;
  unresolved: number;
  candidateReferences: number;
}

export interface WalkArtifactIndex {
  schemaVersion: typeof WALK_ARTIFACT_INDEX_SCHEMA_VERSION;
  kind: "survey-qa-walk-artifact-index";
  runId: string;
  planRevisionId: string;
  rows: WalkArtifactIndexRow[];
  totals: WalkArtifactIndexTotals;
}

export interface WalkArtifactCandidateResolution {
  state: WalkArtifactResolutionState;
  expectedSourceEvidenceId: string;
  candidates: EvidenceCatalogEntry[];
  exactCandidates: EvidenceCatalogEntry[];
  selected: EvidenceCatalogEntry | null;
}

export class WalkArtifactIndexValidationError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "WalkArtifactIndexValidationError";
  }
}

export class WalkArtifactIndexImmutableError extends Error {
  constructor(readonly key: string) {
    super(`walk artifact index ${key} already exists with different bytes; immutable rewrite refused`);
    this.name = "WalkArtifactIndexImmutableError";
  }
}

export class WalkArtifactIndexCorruptError extends Error {
  constructor(readonly key: string, detail: string) {
    super(`walk artifact index ${key} is corrupt: ${detail}`);
    this.name = "WalkArtifactIndexCorruptError";
  }
}

/**
 * Resolve without inspecting candidate content or relying on catalogue order. This small selector
 * is also used by the legacy observation projection, whose direct tests supply partial catalogue
 * rows; the durable index builder performs the full binding validation below.
 */
export function resolveWalkArtifactCandidate(
  catalog: readonly EvidenceCatalogEntry[],
  walk: Pick<WalkArtifactIndexWalk, "pathId" | "attemptId">,
): WalkArtifactCandidateResolution {
  const expectedSourceEvidenceId = `EV-${walk.pathId}-observation`;
  const candidates = catalog.filter((entry) => entry.sourceEvidenceId === expectedSourceEvidenceId);
  const exactCandidates = candidates.filter((entry) => entry.attemptId === walk.attemptId);
  if (exactCandidates.length === 1) {
    return {
      state: "exact",
      expectedSourceEvidenceId,
      candidates,
      exactCandidates,
      selected: exactCandidates[0]!,
    };
  }
  if (exactCandidates.length > 1) {
    return { state: "ambiguous", expectedSourceEvidenceId, candidates, exactCandidates, selected: null };
  }
  if (candidates.length === 0) {
    return { state: "missing", expectedSourceEvidenceId, candidates, exactCandidates, selected: null };
  }
  if (candidates.length === 1 && candidates[0]!.attemptId == null) {
    // Documented compatibility path for a pre-attempt-stamping PathObservation. The state keeps
    // this distinguishable from an exact attempt binding everywhere downstream.
    return {
      state: "legacy",
      expectedSourceEvidenceId,
      candidates,
      exactCandidates,
      selected: candidates[0]!,
    };
  }
  if (candidates.length === 1) {
    // A stamped artifact for another attempt is not a legacy artifact. Selecting it would
    // attach one browser walk's bytes to another walk merely because the route was reused.
    return { state: "mismatched", expectedSourceEvidenceId, candidates, exactCandidates, selected: null };
  }
  return { state: "ambiguous", expectedSourceEvidenceId, candidates, exactCandidates, selected: null };
}

/** Build all rows from the execution-walk denominator and mechanically derive every total. */
export function buildWalkArtifactIndex(input: {
  runId: string;
  planRevisionId: string;
  walks: readonly WalkArtifactIndexWalk[];
  catalog: readonly EvidenceCatalogEntry[];
}): WalkArtifactIndex {
  const runId = nonempty(input.runId, "$.runId", 300);
  const planRevisionId = nonempty(input.planRevisionId, "$.planRevisionId", 300);
  if (!Array.isArray(input.walks) || input.walks.length > MAX_WALKS) {
    invalid("$.walks", `must contain at most ${MAX_WALKS} execution walks`);
  }
  if (!Array.isArray(input.catalog)) invalid("$.catalog", "must be an evidence catalogue array");

  const rows = input.walks.map((walk, walkOrdinal) => {
    const path = `$.walks[${walkOrdinal}]`;
    const pathId = nonempty(walk.pathId, `${path}.pathId`, 500);
    const attemptId = nonempty(walk.attemptId, `${path}.attemptId`, 500);
    const observedAt = nonempty(walk.at, `${path}.at`, 100);
    const caseIds = normalizeCaseIds(Array.isArray(walk.caseIds) ? walk.caseIds : [], `${path}.caseIds`);
    const resolution = resolveWalkArtifactCandidate(input.catalog, { pathId, attemptId });
    if (resolution.candidates.length > MAX_CANDIDATES_PER_WALK) {
      invalid(path, `path has more than ${MAX_CANDIDATES_PER_WALK} PathObservation candidates`);
    }
    const candidates = resolution.candidates
      .map((entry, index) => bindingFromCatalogEntry(entry, `${path}.candidates[${index}]`, resolution.expectedSourceEvidenceId))
      .sort(compareBindings);
    const selected =
      resolution.selected === null
        ? null
        : bindingFromCatalogEntry(resolution.selected, `${path}.selected`, resolution.expectedSourceEvidenceId);
    return {
      walkOrdinal,
      pathId,
      attemptId,
      observedAt,
      caseIds,
      contributesObservations: caseIds.length > 0,
      expectedSourceEvidenceId: resolution.expectedSourceEvidenceId,
      state: resolution.state,
      candidateCount: candidates.length,
      exactCandidateCount: candidates.filter((candidate) => candidate.attemptId === attemptId).length,
      selected,
      candidates,
    } satisfies WalkArtifactIndexRow;
  });

  return {
    schemaVersion: WALK_ARTIFACT_INDEX_SCHEMA_VERSION,
    kind: "survey-qa-walk-artifact-index",
    runId,
    planRevisionId,
    rows,
    totals: computeWalkArtifactIndexTotals(rows),
  };
}

export function computeWalkArtifactIndexTotals(rows: readonly WalkArtifactIndexRow[]): WalkArtifactIndexTotals {
  return rows.reduce<WalkArtifactIndexTotals>(
    (totals, row) => {
      totals.walks += 1;
      if (row.contributesObservations) totals.contributingWalks += 1;
      totals[row.state] += 1;
      if (row.state === "exact" || row.state === "legacy") totals.uniquelyResolved += 1;
      else totals.unresolved += 1;
      totals.candidateReferences += row.candidateCount;
      return totals;
    },
    {
      walks: 0,
      contributingWalks: 0,
      exact: 0,
      legacy: 0,
      missing: 0,
      mismatched: 0,
      ambiguous: 0,
      uniquelyResolved: 0,
      unresolved: 0,
      candidateReferences: 0,
    },
  );
}

/** Strict, closed validation. It returns a newly normalized object, never the parsed input. */
export function validateWalkArtifactIndex(value: unknown): WalkArtifactIndex {
  const root = object(value, "$", ["schemaVersion", "kind", "runId", "planRevisionId", "rows", "totals"]);
  literal(root.schemaVersion, WALK_ARTIFACT_INDEX_SCHEMA_VERSION, "$.schemaVersion");
  literal(root.kind, "survey-qa-walk-artifact-index", "$.kind");
  const runId = nonempty(root.runId, "$.runId", 300);
  const planRevisionId = nonempty(root.planRevisionId, "$.planRevisionId", 300);
  const rowValues = arrayValue(root.rows, "$.rows", MAX_WALKS);
  const rows = rowValues.map((row, index) => validateRow(row, index));
  const totals = validateTotals(root.totals, "$.totals");
  assertTotals(totals, computeWalkArtifactIndexTotals(rows));
  return {
    schemaVersion: WALK_ARTIFACT_INDEX_SCHEMA_VERSION,
    kind: "survey-qa-walk-artifact-index",
    runId,
    planRevisionId,
    rows,
    totals,
  };
}

/** Immutable and idempotent. An existing object is accepted only when its bytes are identical. */
export async function putWalkArtifactIndex(
  bucket: R2Bucket,
  key: string,
  value: WalkArtifactIndex,
): Promise<"stored" | "reused"> {
  assertV2Key(key);
  const index = validateWalkArtifactIndex(value);
  const bytes = enc.encode(canonicalJson(index));
  if (bytes.byteLength > MAX_INDEX_BYTES) invalid("$", "walk artifact index exceeds its byte cap");
  const written = await bucket.put(key, bytes, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written !== null) return "stored";
  const existing = await bucket.get(key);
  if (existing === null || existing.size > MAX_INDEX_BYTES) throw new WalkArtifactIndexImmutableError(key);
  const existingBytes = new Uint8Array(await existing.arrayBuffer());
  if (!equalBytes(existingBytes, bytes)) throw new WalkArtifactIndexImmutableError(key);
  return "reused";
}

export async function readWalkArtifactIndex(
  bucket: R2Bucket,
  key: string,
  expected: { runId?: string; planRevisionId?: string; walks?: number } = {},
): Promise<WalkArtifactIndex | null> {
  assertV2Key(key);
  const stored = await bucket.get(key);
  if (stored === null) return null;
  if (!Number.isFinite(stored.size) || stored.size < 0 || stored.size > MAX_INDEX_BYTES) {
    throw new WalkArtifactIndexCorruptError(key, "stored byte size is outside the bounded index envelope");
  }
  const bytes = new Uint8Array(await stored.arrayBuffer());
  if (bytes.byteLength !== stored.size) throw new WalkArtifactIndexCorruptError(key, "stored and read byte sizes differ");
  let decoded: string;
  let parsed: unknown;
  try {
    decoded = fatalUtf8.decode(bytes);
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new WalkArtifactIndexCorruptError(key, "bytes are not strict UTF-8 JSON");
  }
  let index: WalkArtifactIndex;
  try {
    index = validateWalkArtifactIndex(parsed);
  } catch (error) {
    throw new WalkArtifactIndexCorruptError(key, boundedError(error));
  }
  if (canonicalJson(index) !== decoded) {
    throw new WalkArtifactIndexCorruptError(key, "bytes are not the canonical closed encoding");
  }
  if (expected.runId !== undefined && index.runId !== expected.runId) {
    throw new WalkArtifactIndexCorruptError(key, "run identity does not match the requested run");
  }
  if (expected.planRevisionId !== undefined && index.planRevisionId !== expected.planRevisionId) {
    throw new WalkArtifactIndexCorruptError(key, "plan revision does not match the requested projection");
  }
  if (expected.walks !== undefined && index.totals.walks !== expected.walks) {
    throw new WalkArtifactIndexCorruptError(key, "stored walk denominator does not match the execution ledger");
  }
  return index;
}

function validateRow(value: unknown, index: number): WalkArtifactIndexRow {
  const path = `$.rows[${index}]`;
  const root = object(value, path, [
    "walkOrdinal",
    "pathId",
    "attemptId",
    "observedAt",
    "caseIds",
    "contributesObservations",
    "expectedSourceEvidenceId",
    "state",
    "candidateCount",
    "exactCandidateCount",
    "selected",
    "candidates",
  ]);
  const walkOrdinal = nonnegativeInteger(root.walkOrdinal, `${path}.walkOrdinal`, MAX_WALKS);
  if (walkOrdinal !== index) invalid(`${path}.walkOrdinal`, "must be the consecutive execution-ledger ordinal");
  const pathId = nonempty(root.pathId, `${path}.pathId`, 500);
  const attemptId = nonempty(root.attemptId, `${path}.attemptId`, 500);
  const observedAt = nonempty(root.observedAt, `${path}.observedAt`, 100);
  const caseIds = normalizeCaseIds(root.caseIds, `${path}.caseIds`);
  const contributesObservations = boolean(root.contributesObservations, `${path}.contributesObservations`);
  if (contributesObservations !== (caseIds.length > 0)) {
    invalid(`${path}.contributesObservations`, "does not recompute from caseIds");
  }
  const expectedSourceEvidenceId = nonempty(root.expectedSourceEvidenceId, `${path}.expectedSourceEvidenceId`, 1_000);
  if (expectedSourceEvidenceId !== `EV-${pathId}-observation`) {
    invalid(`${path}.expectedSourceEvidenceId`, "does not derive from the capture producer's path identity");
  }
  const state = oneOf(root.state, ["exact", "legacy", "missing", "mismatched", "ambiguous"] as const, `${path}.state`);
  const candidateValues = arrayValue(root.candidates, `${path}.candidates`, MAX_CANDIDATES_PER_WALK);
  const candidates = candidateValues.map((candidate, candidateIndex) =>
    validateBinding(candidate, `${path}.candidates[${candidateIndex}]`, expectedSourceEvidenceId),
  );
  const sorted = [...candidates].sort(compareBindings);
  if (canonicalJson(candidates) !== canonicalJson(sorted)) invalid(`${path}.candidates`, "must be deterministically sorted");
  const candidateCount = nonnegativeInteger(root.candidateCount, `${path}.candidateCount`, MAX_CANDIDATES_PER_WALK);
  const exactCandidateCount = nonnegativeInteger(
    root.exactCandidateCount,
    `${path}.exactCandidateCount`,
    MAX_CANDIDATES_PER_WALK,
  );
  const recomputedExact = candidates.filter((candidate) => candidate.attemptId === attemptId).length;
  if (candidateCount !== candidates.length) invalid(`${path}.candidateCount`, "does not recompute from candidates");
  if (exactCandidateCount !== recomputedExact) {
    invalid(`${path}.exactCandidateCount`, "does not recompute from candidate attempt ids");
  }
  const selected = root.selected === null ? null : validateBinding(root.selected, `${path}.selected`, expectedSourceEvidenceId);
  assertResolutionState(path, state, candidates, exactCandidateCount, selected, attemptId);
  return {
    walkOrdinal,
    pathId,
    attemptId,
    observedAt,
    caseIds,
    contributesObservations,
    expectedSourceEvidenceId,
    state,
    candidateCount,
    exactCandidateCount,
    selected,
    candidates,
  };
}

function assertResolutionState(
  path: string,
  state: WalkArtifactResolutionState,
  candidates: WalkArtifactBinding[],
  exactCandidateCount: number,
  selected: WalkArtifactBinding | null,
  attemptId: string,
): void {
  if (state === "exact") {
    if (exactCandidateCount !== 1 || selected === null || selected.attemptId !== attemptId) {
      invalid(`${path}.state`, "exact requires exactly one selected path+attempt candidate");
    }
  } else if (state === "legacy") {
    if (exactCandidateCount !== 0 || candidates.length !== 1 || selected === null) {
      invalid(`${path}.state`, "legacy requires one path candidate and no exact attempt candidate");
    }
  } else if (state === "missing") {
    if (exactCandidateCount !== 0 || candidates.length !== 0 || selected !== null) {
      invalid(`${path}.state`, "missing requires an empty candidate set and no selection");
    }
  } else if (state === "mismatched") {
    if (
      exactCandidateCount !== 0 ||
      candidates.length !== 1 ||
      candidates[0]!.attemptId === null ||
      selected !== null
    ) {
      invalid(`${path}.state`, "mismatched requires one differently stamped candidate and no selection");
    }
  } else if (
    selected !== null ||
    !((exactCandidateCount > 1) || (exactCandidateCount === 0 && candidates.length > 1))
  ) {
    invalid(`${path}.state`, "ambiguous requires multiple plausible candidates and no selection");
  }
  if (selected !== null && !candidates.some((candidate) => canonicalJson(candidate) === canonicalJson(selected))) {
    invalid(`${path}.selected`, "selection is not one of the recorded candidates");
  }
}

function validateTotals(value: unknown, path: string): WalkArtifactIndexTotals {
  const root = object(value, path, [
    "walks",
    "contributingWalks",
    "exact",
    "legacy",
    "missing",
    "mismatched",
    "ambiguous",
    "uniquelyResolved",
    "unresolved",
    "candidateReferences",
  ]);
  return {
    walks: nonnegativeInteger(root.walks, `${path}.walks`, MAX_WALKS),
    contributingWalks: nonnegativeInteger(root.contributingWalks, `${path}.contributingWalks`, MAX_WALKS),
    exact: nonnegativeInteger(root.exact, `${path}.exact`, MAX_WALKS),
    legacy: nonnegativeInteger(root.legacy, `${path}.legacy`, MAX_WALKS),
    missing: nonnegativeInteger(root.missing, `${path}.missing`, MAX_WALKS),
    mismatched: nonnegativeInteger(root.mismatched, `${path}.mismatched`, MAX_WALKS),
    ambiguous: nonnegativeInteger(root.ambiguous, `${path}.ambiguous`, MAX_WALKS),
    uniquelyResolved: nonnegativeInteger(root.uniquelyResolved, `${path}.uniquelyResolved`, MAX_WALKS),
    unresolved: nonnegativeInteger(root.unresolved, `${path}.unresolved`, MAX_WALKS),
    candidateReferences: nonnegativeInteger(
      root.candidateReferences,
      `${path}.candidateReferences`,
      MAX_WALKS * MAX_CANDIDATES_PER_WALK,
    ),
  };
}

function assertTotals(actual: WalkArtifactIndexTotals, expected: WalkArtifactIndexTotals): void {
  for (const key of Object.keys(expected) as Array<keyof WalkArtifactIndexTotals>) {
    if (actual[key] !== expected[key]) {
      invalid(`$.totals.${key}`, `declares ${actual[key]} but mechanically recomputes to ${expected[key]}`);
    }
  }
}

function bindingFromCatalogEntry(
  entry: EvidenceCatalogEntry,
  path: string,
  expectedSourceEvidenceId: string,
): WalkArtifactBinding {
  return validateBinding(
    {
      evidenceId: entry.evidenceId,
      artifactRef: entry.artifactRef ?? null,
      contentHash: entry.contentHash,
      mediaType: entry.mediaType,
      sourceEvidenceId: entry.sourceEvidenceId,
      attemptId: entry.attemptId ?? null,
      routeId: entry.routeId ?? null,
      type: entry.type,
      size: entry.size,
    },
    path,
    expectedSourceEvidenceId,
  );
}

function validateBinding(value: unknown, path: string, expectedSourceEvidenceId: string): WalkArtifactBinding {
  const root = object(value, path, [
    "evidenceId",
    "artifactRef",
    "contentHash",
    "mediaType",
    "sourceEvidenceId",
    "attemptId",
    "routeId",
    "type",
    "size",
  ]);
  const sourceEvidenceId = nonempty(root.sourceEvidenceId, `${path}.sourceEvidenceId`, 1_000);
  if (sourceEvidenceId !== expectedSourceEvidenceId) invalid(`${path}.sourceEvidenceId`, "does not match path producer id");
  return {
    evidenceId: nonempty(root.evidenceId, `${path}.evidenceId`, 1_000),
    artifactRef: nullableString(root.artifactRef, `${path}.artifactRef`, 2_000),
    contentHash: hash(root.contentHash, `${path}.contentHash`),
    mediaType: nonempty(root.mediaType, `${path}.mediaType`, 200),
    sourceEvidenceId,
    attemptId: nullableString(root.attemptId, `${path}.attemptId`, 500),
    routeId: nullableString(root.routeId, `${path}.routeId`, 500),
    type: oneOf(root.type, ["screenshot", "dom-excerpt", "trace", "state", "har", "other"] as const, `${path}.type`),
    size: nonnegativeInteger(root.size, `${path}.size`, 1_000_000_000),
  };
}

function compareBindings(a: WalkArtifactBinding, b: WalkArtifactBinding): number {
  const left = canonicalJson(a);
  const right = canonicalJson(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeCaseIds(value: unknown, path: string): string[] {
  const source = arrayValue(value, path, 100_000);
  return source.map((item, index) => nonempty(item, `${path}[${index}]`, 500));
}

function object(value: unknown, path: string, expectedKeys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) invalid(path, "must be a plain JSON object");
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) if (!expected.has(key)) invalid(path, `unknown field ${JSON.stringify(key)}`);
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) invalid(path, `missing field ${JSON.stringify(key)}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function arrayValue(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(path, `must be an array with at most ${max} entries`);
  return value;
}

function nonempty(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || !wellFormed(value)) {
    invalid(path, `must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function nullableString(value: unknown, path: string, max: number): string | null {
  return value === null ? null : nonempty(value, path, max);
}

function hash(value: unknown, path: string): string {
  if (typeof value !== "string" || !HASH.test(value)) invalid(path, "must be a lowercase SHA-256 hex digest");
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path, "must be boolean");
  return value;
}

function nonnegativeInteger(value: unknown, path: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    invalid(path, `must be an integer in [0, ${max}]`);
  }
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) invalid(path, `must be one of ${allowed.join(", ")}`);
  return value as T[number];
}

function literal<T extends string>(value: unknown, expected: T, path: string): asserts value is T {
  if (value !== expected) invalid(path, `must equal ${JSON.stringify(expected)}`);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let different = 0;
  for (let index = 0; index < left.byteLength; index += 1) different |= left[index]! ^ right[index]!;
  return different === 0;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : "unknown validation error";
  return message.length <= 700 ? message : `${message.slice(0, 697)}...`;
}

function invalid(path: string, detail: string): never {
  throw new WalkArtifactIndexValidationError(path, detail);
}

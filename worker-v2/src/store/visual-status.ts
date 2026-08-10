/**
 * DURABLE TERMINAL LIMITATION FOR VISUAL SHADOW EXECUTION.
 *
 * Closed coverage is the preferred terminal artifact. Some failures happen before its
 * denominator exists (for example, a missing walk-artifact index), while others prevent its
 * fixed pointer from being committed. Those states must not disappear merely because the richer
 * artifact could not be written. This store records one bounded, non-secret terminal limitation
 * as a content-addressed object and seals it behind a fixed write-once pointer.
 *
 * `finalizedAt` is always supplied by the caller. Recovery must reuse a timestamp already sealed
 * in durable workflow state; this module deliberately never calls the clock. Exact replay is
 * therefore byte-identical, while a later attempt to tell a different terminal story is refused.
 */

import { assertV2Key, k, visualManifestKey } from "../keys";
import { canonicalJson, sha256Hex } from "./hash";
import { visualCoverageIndexKey } from "./visual-coverage";

const enc = new TextEncoder();
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const HASH = /^[0-9a-f]{64}$/;
const MAX_STATUS_BYTES = 32 * 1024;
const MAX_REFERENCED_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_KEY_CHARS = 1_024;
const MAX_SEGMENTS = 64;
const MAX_SEGMENT_CHARS = 300;
const MAX_ID_CHARS = 300;
const MAX_DETAIL_CHARS = 1_000;
const MAX_DETAIL_BYTES = 2_048;

export const VISUAL_TERMINAL_STATUS_SCHEMA_VERSION =
  "survey-qa-visual-terminal-limitation-status/1.0.0" as const;
export const VISUAL_TERMINAL_STATUS_POINTER_SCHEMA_VERSION =
  "survey-qa-visual-terminal-limitation-pointer/1.0.0" as const;

export const VISUAL_TERMINAL_PHASES = [
  "work-preparation",
  "rollout-initialization",
  "wave-orchestration",
  "coverage-finalization",
] as const;

export type VisualTerminalPhase = (typeof VISUAL_TERMINAL_PHASES)[number];

export const VISUAL_TERMINAL_REASONS = [
  "VISUAL_WALK_ARTIFACT_INDEX_MISSING",
  "VISUAL_WORK_CAPACITY_EXCEEDED",
  "VISUAL_WORK_PREPARATION_FAILED",
  "VISUAL_ROLLOUT_INITIALIZATION_FAILED",
  "VISUAL_WAVE_ORCHESTRATION_FAILED",
  "VISUAL_COVERAGE_FINALIZATION_FAILED",
  "VISUAL_COVERAGE_LIMIT_EXCEEDED",
] as const;

export type VisualTerminalReason = (typeof VISUAL_TERMINAL_REASONS)[number];

/** The map is closed so a reason cannot be relabelled as a later/earlier phase on replay. */
export const VISUAL_TERMINAL_REASON_PHASE: Readonly<Record<VisualTerminalReason, VisualTerminalPhase>> = {
  VISUAL_WALK_ARTIFACT_INDEX_MISSING: "work-preparation",
  VISUAL_WORK_CAPACITY_EXCEEDED: "work-preparation",
  VISUAL_WORK_PREPARATION_FAILED: "work-preparation",
  VISUAL_ROLLOUT_INITIALIZATION_FAILED: "rollout-initialization",
  VISUAL_WAVE_ORCHESTRATION_FAILED: "wave-orchestration",
  VISUAL_COVERAGE_FINALIZATION_FAILED: "coverage-finalization",
  VISUAL_COVERAGE_LIMIT_EXCEEDED: "coverage-finalization",
};

/** A key and the digest of the exact immutable bytes at that key. */
export interface VisualTerminalArtifactRef {
  key: string;
  contentSha256: string;
}

export interface VisualTerminalStatus {
  schemaVersion: typeof VISUAL_TERMINAL_STATUS_SCHEMA_VERSION;
  kind: "survey-qa-visual-terminal-limitation-status";
  runId: string;
  planRevisionId: string;
  finalizedAt: string;
  phase: VisualTerminalPhase;
  reason: VisualTerminalReason;
  /** Pre-redacted operator-safe text. Secret-shaped values are rejected at the store boundary. */
  detail: string;
  workManifest: VisualTerminalArtifactRef | null;
  coverageIndex: VisualTerminalArtifactRef | null;
  inferenceFingerprintSha256: string | null;
  authorizationFingerprintSha256: string | null;
}

export interface PrepareVisualTerminalStatusInput {
  runId: string;
  planRevisionId: string;
  finalizedAt: string;
  phase: VisualTerminalPhase;
  reason: VisualTerminalReason;
  detail: string;
  workManifest?: VisualTerminalArtifactRef | null;
  coverageIndex?: VisualTerminalArtifactRef | null;
  inferenceFingerprintSha256?: string | null;
  authorizationFingerprintSha256?: string | null;
}

export interface PreparedVisualTerminalStatus {
  status: VisualTerminalStatus;
  canonicalBytes: Uint8Array;
  contentSha256: string;
}

export interface VisualTerminalStatusPointer {
  schemaVersion: typeof VISUAL_TERMINAL_STATUS_POINTER_SCHEMA_VERSION;
  kind: "survey-qa-visual-terminal-limitation-pointer";
  runId: string;
  planRevisionId: string;
  finalizedAt: string;
  phase: VisualTerminalPhase;
  reason: VisualTerminalReason;
  workManifest: VisualTerminalArtifactRef | null;
  coverageIndex: VisualTerminalArtifactRef | null;
  inferenceFingerprintSha256: string | null;
  authorizationFingerprintSha256: string | null;
  status: VisualTerminalArtifactRef;
}

export interface FinalizedVisualTerminalStatus {
  statusWrite: "stored" | "reused";
  pointerWrite: "stored" | "reused";
  statusKey: string;
  pointerKey: string;
  contentSha256: string;
  pointer: VisualTerminalStatusPointer;
}

export interface VisualTerminalStatusExpected {
  runId?: string;
  planRevisionId?: string;
  finalizedAt?: string;
  phase?: VisualTerminalPhase;
  reason?: VisualTerminalReason;
  workManifestSha256?: string | null;
  coverageIndexSha256?: string | null;
  inferenceFingerprintSha256?: string | null;
  authorizationFingerprintSha256?: string | null;
}

export class VisualTerminalStatusValidationError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "VisualTerminalStatusValidationError";
  }
}

export class VisualTerminalStatusImmutabilityError extends Error {
  constructor(readonly key: string) {
    super(`visual terminal status object ${key} already exists with different bytes; immutable rewrite refused`);
    this.name = "VisualTerminalStatusImmutabilityError";
  }
}

export class VisualTerminalStatusCorruptionError extends Error {
  constructor(readonly key: string, detail: string) {
    super(`visual terminal status object ${key} is corrupt: ${detail}`);
    this.name = "VisualTerminalStatusCorruptionError";
  }
}

/** Content-addressed immutable terminal status object. */
export function visualTerminalStatusKey(runIdValue: string, contentSha256Value: string): string {
  const runId = keySegment(runIdValue, "runId");
  const contentSha256 = hash(contentSha256Value, "contentSha256");
  return k("runs", runId, "visual", "status", "sha256", contentSha256, "status.json");
}

/** Fixed write-once terminal pointer. It is never updated to a newer explanation. */
export function visualTerminalStatusPointerKey(runIdValue: string): string {
  return k("runs", keySegment(runIdValue, "runId"), "visual", "status", "current.json");
}

export async function prepareVisualTerminalStatus(
  input: PrepareVisualTerminalStatusInput,
): Promise<PreparedVisualTerminalStatus> {
  const status = normalizeStatus({
    schemaVersion: VISUAL_TERMINAL_STATUS_SCHEMA_VERSION,
    kind: "survey-qa-visual-terminal-limitation-status",
    runId: input.runId,
    planRevisionId: input.planRevisionId,
    finalizedAt: input.finalizedAt,
    phase: input.phase,
    reason: input.reason,
    detail: input.detail,
    workManifest: input.workManifest ?? null,
    coverageIndex: input.coverageIndex ?? null,
    inferenceFingerprintSha256: input.inferenceFingerprintSha256 ?? null,
    authorizationFingerprintSha256: input.authorizationFingerprintSha256 ?? null,
  });
  const canonicalBytes = enc.encode(canonicalJson(status));
  if (canonicalBytes.byteLength > MAX_STATUS_BYTES) invalid("$", "terminal status exceeds its storage envelope");
  return { status, canonicalBytes, contentSha256: await sha256Hex(canonicalBytes) };
}

export async function validateVisualTerminalStatus(
  value: unknown,
  expected: VisualTerminalStatusExpected = {},
): Promise<VisualTerminalStatus> {
  const status = normalizeStatus(value);
  assertExpectedStatus(status, expected);
  return status;
}

/**
 * Verify every supplied artifact reference, append the status, then conditional-create the fixed
 * pointer. A failed pointer write may leave an unreferenced content-addressed object, never a
 * repointed terminal story.
 */
export async function finalizeVisualTerminalStatus(
  bucket: R2Bucket,
  preparedValue: PreparedVisualTerminalStatus,
): Promise<FinalizedVisualTerminalStatus> {
  const prepared = await normalizePreparedStatus(preparedValue);
  if (prepared.status.workManifest !== null) {
    await readVerifiedReference(bucket, prepared.status.workManifest, "$.workManifest");
  }
  if (prepared.status.coverageIndex !== null) {
    await readVerifiedReference(bucket, prepared.status.coverageIndex, "$.coverageIndex");
  }

  const statusKey = visualTerminalStatusKey(prepared.status.runId, prepared.contentSha256);
  const statusWrite = await putBytesImmutable(bucket, statusKey, prepared.canonicalBytes);
  const pointer: VisualTerminalStatusPointer = {
    schemaVersion: VISUAL_TERMINAL_STATUS_POINTER_SCHEMA_VERSION,
    kind: "survey-qa-visual-terminal-limitation-pointer",
    runId: prepared.status.runId,
    planRevisionId: prepared.status.planRevisionId,
    finalizedAt: prepared.status.finalizedAt,
    phase: prepared.status.phase,
    reason: prepared.status.reason,
    workManifest: prepared.status.workManifest,
    coverageIndex: prepared.status.coverageIndex,
    inferenceFingerprintSha256: prepared.status.inferenceFingerprintSha256,
    authorizationFingerprintSha256: prepared.status.authorizationFingerprintSha256,
    status: { key: statusKey, contentSha256: prepared.contentSha256 },
  };
  const pointerKey = visualTerminalStatusPointerKey(prepared.status.runId);
  const pointerWrite = await putBytesImmutable(bucket, pointerKey, enc.encode(canonicalJson(pointer)));
  return {
    statusWrite,
    pointerWrite,
    statusKey,
    pointerKey,
    contentSha256: prepared.contentSha256,
    pointer,
  };
}

export async function readVisualTerminalStatus(
  bucket: R2Bucket,
  runIdValue: string,
  contentSha256Value: string,
  expected: VisualTerminalStatusExpected = {},
): Promise<VisualTerminalStatus | null> {
  const runId = keySegment(runIdValue, "runId");
  const contentSha256 = hash(contentSha256Value, "contentSha256");
  const key = visualTerminalStatusKey(runId, contentSha256);
  const bytes = await readObjectBytes(bucket, key, MAX_STATUS_BYTES);
  if (bytes === null) return null;
  if ((await sha256Hex(bytes)) !== contentSha256) {
    throw new VisualTerminalStatusCorruptionError(key, "stored bytes do not match the content-addressed key digest");
  }
  const parsed = parseCanonicalJson(bytes, key);
  try {
    return await validateVisualTerminalStatus(parsed, { ...expected, runId });
  } catch (error) {
    throw new VisualTerminalStatusCorruptionError(key, boundedError(error));
  }
}

export async function readVisualTerminalStatusPointer(
  bucket: R2Bucket,
  runIdValue: string,
  expected: VisualTerminalStatusExpected = {},
): Promise<VisualTerminalStatusPointer | null> {
  const runId = keySegment(runIdValue, "runId");
  const key = visualTerminalStatusPointerKey(runId);
  const bytes = await readObjectBytes(bucket, key, MAX_STATUS_BYTES);
  if (bytes === null) return null;
  const parsed = parseCanonicalJson(bytes, key);
  try {
    return normalizePointer(parsed, { ...expected, runId });
  } catch (error) {
    throw new VisualTerminalStatusCorruptionError(key, boundedError(error));
  }
}

/** Resolve and cross-check the pointer and its content-addressed target as one read. */
export async function readVisualTerminalStatusFromPointer(
  bucket: R2Bucket,
  runIdValue: string,
  expected: VisualTerminalStatusExpected = {},
): Promise<{ pointer: VisualTerminalStatusPointer; status: VisualTerminalStatus } | null> {
  const pointer = await readVisualTerminalStatusPointer(bucket, runIdValue, expected);
  if (pointer === null) return null;
  const status = await readVisualTerminalStatus(bucket, pointer.runId, pointer.status.contentSha256, expected);
  if (status === null) {
    throw new VisualTerminalStatusCorruptionError(pointer.status.key, "fixed pointer target is absent");
  }
  if (
    status.planRevisionId !== pointer.planRevisionId ||
    status.finalizedAt !== pointer.finalizedAt ||
    status.phase !== pointer.phase ||
    status.reason !== pointer.reason ||
    canonicalJson(status.workManifest) !== canonicalJson(pointer.workManifest) ||
    canonicalJson(status.coverageIndex) !== canonicalJson(pointer.coverageIndex) ||
    status.inferenceFingerprintSha256 !== pointer.inferenceFingerprintSha256 ||
    status.authorizationFingerprintSha256 !== pointer.authorizationFingerprintSha256
  ) {
    throw new VisualTerminalStatusCorruptionError(pointer.status.key, "fixed pointer fields do not bind its target");
  }
  return { pointer, status };
}

async function normalizePreparedStatus(value: unknown): Promise<PreparedVisualTerminalStatus> {
  const root = object(value, "$prepared", ["status", "canonicalBytes", "contentSha256"]);
  const status = normalizeStatus(root.status);
  if (!(root.canonicalBytes instanceof Uint8Array)) {
    invalid("$prepared.canonicalBytes", "must be a Uint8Array");
  }
  const canonicalBytes = new Uint8Array(root.canonicalBytes);
  if (canonicalBytes.byteLength > MAX_STATUS_BYTES) {
    invalid("$prepared.canonicalBytes", "exceeds the terminal status storage envelope");
  }
  const expectedBytes = enc.encode(canonicalJson(status));
  if (!equalBytes(canonicalBytes, expectedBytes)) {
    invalid("$prepared.canonicalBytes", "does not exactly encode the normalized terminal status");
  }
  const contentSha256 = hash(root.contentSha256, "$prepared.contentSha256");
  if ((await sha256Hex(canonicalBytes)) !== contentSha256) {
    invalid("$prepared.contentSha256", "does not hash the canonical terminal status bytes");
  }
  return { status, canonicalBytes, contentSha256 };
}

function normalizeStatus(value: unknown): VisualTerminalStatus {
  const root = object(value, "$", [
    "schemaVersion",
    "kind",
    "runId",
    "planRevisionId",
    "finalizedAt",
    "phase",
    "reason",
    "detail",
    "workManifest",
    "coverageIndex",
    "inferenceFingerprintSha256",
    "authorizationFingerprintSha256",
  ]);
  literal(root.schemaVersion, VISUAL_TERMINAL_STATUS_SCHEMA_VERSION, "$.schemaVersion");
  literal(root.kind, "survey-qa-visual-terminal-limitation-status", "$.kind");
  const runId = keySegment(root.runId, "$.runId");
  const planRevisionId = boundedString(root.planRevisionId, "$.planRevisionId", MAX_ID_CHARS);
  const finalizedAt = isoTimestamp(root.finalizedAt, "$.finalizedAt");
  const phase = oneOf(root.phase, VISUAL_TERMINAL_PHASES, "$.phase");
  const reason = oneOf(root.reason, VISUAL_TERMINAL_REASONS, "$.reason");
  if (VISUAL_TERMINAL_REASON_PHASE[reason] !== phase) {
    invalid("$.phase", `${reason} belongs to ${VISUAL_TERMINAL_REASON_PHASE[reason]}`);
  }
  const detail = safeDetail(root.detail, "$.detail");
  const workManifest =
    root.workManifest === null ? null : normalizeArtifactRef(root.workManifest, "$.workManifest");
  if (workManifest !== null && workManifest.key !== visualManifestKey(runId)) {
    invalid("$.workManifest.key", "must be the fixed visual work-manifest key for this run");
  }
  const coverageIndex =
    root.coverageIndex === null ? null : normalizeArtifactRef(root.coverageIndex, "$.coverageIndex");
  if (
    coverageIndex !== null &&
    coverageIndex.key !== visualCoverageIndexKey(runId, coverageIndex.contentSha256)
  ) {
    invalid("$.coverageIndex.key", "must be the content-addressed visual coverage-index key for this run");
  }
  const inferenceFingerprintSha256 = nullableHash(
    root.inferenceFingerprintSha256,
    "$.inferenceFingerprintSha256",
  );
  const authorizationFingerprintSha256 = nullableHash(
    root.authorizationFingerprintSha256,
    "$.authorizationFingerprintSha256",
  );
  return {
    schemaVersion: VISUAL_TERMINAL_STATUS_SCHEMA_VERSION,
    kind: "survey-qa-visual-terminal-limitation-status",
    runId,
    planRevisionId,
    finalizedAt,
    phase,
    reason,
    detail,
    workManifest,
    coverageIndex,
    inferenceFingerprintSha256,
    authorizationFingerprintSha256,
  };
}

function normalizePointer(
  value: unknown,
  expected: VisualTerminalStatusExpected,
): VisualTerminalStatusPointer {
  const root = object(value, "$pointer", [
    "schemaVersion",
    "kind",
    "runId",
    "planRevisionId",
    "finalizedAt",
    "phase",
    "reason",
    "workManifest",
    "coverageIndex",
    "inferenceFingerprintSha256",
    "authorizationFingerprintSha256",
    "status",
  ]);
  literal(root.schemaVersion, VISUAL_TERMINAL_STATUS_POINTER_SCHEMA_VERSION, "$pointer.schemaVersion");
  literal(root.kind, "survey-qa-visual-terminal-limitation-pointer", "$pointer.kind");
  const runId = keySegment(root.runId, "$pointer.runId");
  const planRevisionId = boundedString(root.planRevisionId, "$pointer.planRevisionId", MAX_ID_CHARS);
  const finalizedAt = isoTimestamp(root.finalizedAt, "$pointer.finalizedAt");
  const phase = oneOf(root.phase, VISUAL_TERMINAL_PHASES, "$pointer.phase");
  const reason = oneOf(root.reason, VISUAL_TERMINAL_REASONS, "$pointer.reason");
  if (VISUAL_TERMINAL_REASON_PHASE[reason] !== phase) {
    invalid("$pointer.phase", `${reason} belongs to ${VISUAL_TERMINAL_REASON_PHASE[reason]}`);
  }
  const workManifest =
    root.workManifest === null ? null : normalizeArtifactRef(root.workManifest, "$pointer.workManifest");
  if (workManifest !== null && workManifest.key !== visualManifestKey(runId)) {
    invalid("$pointer.workManifest.key", "must be the fixed visual work-manifest key for this run");
  }
  const coverageIndex =
    root.coverageIndex === null ? null : normalizeArtifactRef(root.coverageIndex, "$pointer.coverageIndex");
  if (
    coverageIndex !== null &&
    coverageIndex.key !== visualCoverageIndexKey(runId, coverageIndex.contentSha256)
  ) {
    invalid("$pointer.coverageIndex.key", "must be the content-addressed visual coverage-index key for this run");
  }
  const inferenceFingerprintSha256 = nullableHash(
    root.inferenceFingerprintSha256,
    "$pointer.inferenceFingerprintSha256",
  );
  const authorizationFingerprintSha256 = nullableHash(
    root.authorizationFingerprintSha256,
    "$pointer.authorizationFingerprintSha256",
  );
  const status = normalizeArtifactRef(root.status, "$pointer.status");
  if (status.key !== visualTerminalStatusKey(runId, status.contentSha256)) {
    invalid("$pointer.status.key", "must be the content-addressed terminal status key for this run");
  }
  const pointer: VisualTerminalStatusPointer = {
    schemaVersion: VISUAL_TERMINAL_STATUS_POINTER_SCHEMA_VERSION,
    kind: "survey-qa-visual-terminal-limitation-pointer",
    runId,
    planRevisionId,
    finalizedAt,
    phase,
    reason,
    workManifest,
    coverageIndex,
    inferenceFingerprintSha256,
    authorizationFingerprintSha256,
    status,
  };
  assertExpectedPointer(pointer, expected);
  return pointer;
}

function normalizeArtifactRef(value: unknown, path: string): VisualTerminalArtifactRef {
  const root = object(value, path, ["key", "contentSha256"]);
  return {
    key: storageKey(root.key, `${path}.key`),
    contentSha256: hash(root.contentSha256, `${path}.contentSha256`),
  };
}

async function readVerifiedReference(
  bucket: R2Bucket,
  ref: VisualTerminalArtifactRef,
  path: string,
): Promise<void> {
  const bytes = await readObjectBytes(bucket, ref.key, MAX_REFERENCED_ARTIFACT_BYTES);
  if (bytes === null) throw new VisualTerminalStatusCorruptionError(ref.key, `${path} target is absent`);
  if ((await sha256Hex(bytes)) !== ref.contentSha256) {
    throw new VisualTerminalStatusCorruptionError(ref.key, `${path} bytes do not match contentSha256`);
  }
}

async function readObjectBytes(bucket: R2Bucket, key: string, maxBytes: number): Promise<Uint8Array | null> {
  assertV2Key(key);
  const stored = await bucket.get(key);
  if (stored === null) return null;
  if (!Number.isFinite(stored.size) || stored.size < 0 || stored.size > maxBytes) {
    throw new VisualTerminalStatusCorruptionError(key, "stored size is outside the bounded artifact envelope");
  }
  const bytes = new Uint8Array(await stored.arrayBuffer());
  if (bytes.byteLength !== stored.size) {
    throw new VisualTerminalStatusCorruptionError(key, "declared and read byte sizes differ");
  }
  return bytes;
}

async function putBytesImmutable(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
): Promise<"stored" | "reused"> {
  assertV2Key(key);
  if (bytes.byteLength > MAX_STATUS_BYTES) invalid("$", "terminal status object exceeds its storage envelope");
  const written = await bucket.put(key, bytes, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written !== null) return "stored";
  const existing = await readObjectBytes(bucket, key, MAX_STATUS_BYTES);
  if (existing !== null && equalBytes(existing, bytes)) return "reused";
  throw new VisualTerminalStatusImmutabilityError(key);
}

function parseCanonicalJson(bytes: Uint8Array, key: string): unknown {
  let decoded: string;
  let parsed: unknown;
  try {
    decoded = fatalUtf8.decode(bytes);
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new VisualTerminalStatusCorruptionError(key, "bytes are not strict UTF-8 JSON");
  }
  try {
    if (canonicalJson(parsed) !== decoded) {
      throw new VisualTerminalStatusCorruptionError(key, "bytes are not the canonical closed encoding");
    }
  } catch (error) {
    if (error instanceof VisualTerminalStatusCorruptionError) throw error;
    throw new VisualTerminalStatusCorruptionError(key, "JSON cannot be canonically encoded");
  }
  return parsed;
}

function assertExpectedStatus(value: VisualTerminalStatus, expected: VisualTerminalStatusExpected): void {
  assertExpectedIdentity(value, expected, "$");
  const workManifestSha256 = value.workManifest === null ? null : value.workManifest.contentSha256;
  if (
    expected.workManifestSha256 !== undefined &&
    workManifestSha256 !== expected.workManifestSha256
  ) {
    invalid("$.workManifest", "does not match expected work-manifest digest");
  }
  const coverageIndexSha256 = value.coverageIndex === null ? null : value.coverageIndex.contentSha256;
  if (
    expected.coverageIndexSha256 !== undefined &&
    coverageIndexSha256 !== expected.coverageIndexSha256
  ) {
    invalid("$.coverageIndex", "does not match expected coverage-index digest");
  }
  if (
    expected.inferenceFingerprintSha256 !== undefined &&
    value.inferenceFingerprintSha256 !== expected.inferenceFingerprintSha256
  ) {
    invalid("$.inferenceFingerprintSha256", "does not match expected inference fingerprint");
  }
  if (
    expected.authorizationFingerprintSha256 !== undefined &&
    value.authorizationFingerprintSha256 !== expected.authorizationFingerprintSha256
  ) {
    invalid("$.authorizationFingerprintSha256", "does not match expected authorization fingerprint");
  }
}

function assertExpectedPointer(
  value: VisualTerminalStatusPointer,
  expected: VisualTerminalStatusExpected,
): void {
  assertExpectedIdentity(value, expected, "$pointer");
  const workManifestSha256 = value.workManifest === null ? null : value.workManifest.contentSha256;
  if (
    expected.workManifestSha256 !== undefined &&
    workManifestSha256 !== expected.workManifestSha256
  ) {
    invalid("$pointer.workManifest", "does not match expected work-manifest digest");
  }
  const coverageIndexSha256 = value.coverageIndex === null ? null : value.coverageIndex.contentSha256;
  if (
    expected.coverageIndexSha256 !== undefined &&
    coverageIndexSha256 !== expected.coverageIndexSha256
  ) {
    invalid("$pointer.coverageIndex", "does not match expected coverage-index digest");
  }
  if (
    expected.inferenceFingerprintSha256 !== undefined &&
    value.inferenceFingerprintSha256 !== expected.inferenceFingerprintSha256
  ) {
    invalid("$pointer.inferenceFingerprintSha256", "does not match expected inference fingerprint");
  }
  if (
    expected.authorizationFingerprintSha256 !== undefined &&
    value.authorizationFingerprintSha256 !== expected.authorizationFingerprintSha256
  ) {
    invalid("$pointer.authorizationFingerprintSha256", "does not match expected authorization fingerprint");
  }
}

function assertExpectedIdentity(
  value: Pick<VisualTerminalStatus, "runId" | "planRevisionId" | "finalizedAt" | "phase" | "reason">,
  expected: VisualTerminalStatusExpected,
  path: string,
): void {
  if (expected.runId !== undefined && value.runId !== expected.runId) {
    invalid(`${path}.runId`, "does not match expected runId");
  }
  if (expected.planRevisionId !== undefined && value.planRevisionId !== expected.planRevisionId) {
    invalid(`${path}.planRevisionId`, "does not match expected planRevisionId");
  }
  if (expected.finalizedAt !== undefined && value.finalizedAt !== expected.finalizedAt) {
    invalid(`${path}.finalizedAt`, "does not match expected stable finalizedAt");
  }
  if (expected.phase !== undefined && value.phase !== expected.phase) {
    invalid(`${path}.phase`, "does not match expected phase");
  }
  if (expected.reason !== undefined && value.reason !== expected.reason) {
    invalid(`${path}.reason`, "does not match expected reason");
  }
}

function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) invalid(path, "must be a plain object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    invalid(path, `must contain exactly: ${expected.join(", ")}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (!allowed.some((candidate) => candidate === value)) {
    invalid(path, `must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function literal<T extends string>(value: unknown, expected: T, path: string): asserts value is T {
  if (value !== expected) invalid(path, `must be ${JSON.stringify(expected)}`);
}

function boundedString(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !wellFormed(value)) {
    invalid(path, `must be a non-empty, well-formed string of at most ${max} characters`);
  }
  if (value.normalize("NFC") !== value) invalid(path, "must be NFC-normalized");
  return value;
}

function safeDetail(value: unknown, path: string): string {
  const detail = boundedString(value, path, MAX_DETAIL_CHARS);
  if (enc.encode(detail).byteLength > MAX_DETAIL_BYTES) invalid(path, `must be at most ${MAX_DETAIL_BYTES} UTF-8 bytes`);
  if (/\p{Cc}/u.test(detail)) invalid(path, "must not contain control characters");
  const secretAssignment =
    /(?:^|[\s,;])(?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]/iu;
  const bearerValue = /\bbearer\s+[a-z0-9._~+/-]+=*/iu;
  const secretQuery = /[?&](?:key|token|secret|password|signature)=/iu;
  if (secretAssignment.test(detail) || bearerValue.test(detail) || secretQuery.test(detail)) {
    invalid(path, "must be pre-redacted and contain no secret-shaped values");
  }
  return detail;
}

function keySegment(value: unknown, path: string): string {
  const segment = boundedString(value, path, MAX_SEGMENT_CHARS);
  if (
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(segment)
  ) {
    invalid(path, "must be one canonical storage-key segment");
  }
  return segment;
}

function storageKey(value: unknown, path: string): string {
  const key = boundedString(value, path, MAX_KEY_CHARS);
  try {
    assertV2Key(key);
  } catch {
    invalid(path, "must remain inside the v2 namespace");
  }
  if (key.startsWith("/") || key.endsWith("/") || key.includes("\\") || /[\u0000-\u001f\u007f]/u.test(key)) {
    invalid(path, "must be a canonical relative R2 path");
  }
  const segments = key.split("/");
  if (segments.length > MAX_SEGMENTS) invalid(path, `exceeds ${MAX_SEGMENTS} path segments`);
  for (const segment of segments) {
    if (segment.length === 0 || segment.length > MAX_SEGMENT_CHARS || segment === "." || segment === "..") {
      invalid(path, "contains an empty, dot, or oversized segment");
    }
  }
  return key;
}

function nullableHash(value: unknown, path: string): string | null {
  return value === null ? null : hash(value, path);
}

function hash(value: unknown, path: string): string {
  if (typeof value !== "string" || !HASH.test(value)) invalid(path, "must be a lowercase SHA-256 digest");
  return value;
}

function isoTimestamp(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    invalid(path, "must be a strict RFC 3339 UTC timestamp with milliseconds");
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
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return wellFormed(message) ? message.slice(0, MAX_DETAIL_CHARS) : "invalid visual terminal status artifact";
}

function invalid(path: string, detail: string): never {
  throw new VisualTerminalStatusValidationError(path, detail);
}

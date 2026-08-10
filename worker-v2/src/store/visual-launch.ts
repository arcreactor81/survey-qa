/** Append-only, non-blocking receipts for dispatching the isolated visual Workflow. */

import { visualLaunchMarkerKey } from "../keys";
import type { Fence } from "./checkpoint";
import { canonicalJson } from "./hash";

const enc = new TextEncoder();
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const MAX_MARKER_BYTES = 8 * 1024;
const MAX_ID = 300;

export const VISUAL_LAUNCH_MARKER_SCHEMA_VERSION =
  "survey-qa-visual-launch-marker/1.0.0" as const;
export const VISUAL_LAUNCH_MARKER_STATES = [
  "intent",
  "accepted",
  "started",
  "unresolved",
] as const;
export type VisualLaunchMarkerState = (typeof VISUAL_LAUNCH_MARKER_STATES)[number];

export interface VisualLaunchMarker {
  schemaVersion: typeof VISUAL_LAUNCH_MARKER_SCHEMA_VERSION;
  kind: "survey-qa-visual-launch-marker";
  state: VisualLaunchMarkerState;
  runId: string;
  planRevisionId: string;
  workflowInstanceId: string;
  ownership: Fence;
  recordedAt: string;
}

export interface VisualLaunchExpected {
  state: VisualLaunchMarkerState;
  runId: string;
  planRevisionId: string;
  workflowInstanceId: string;
  ownership: Fence;
}

export class VisualLaunchMarkerValidationError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "VisualLaunchMarkerValidationError";
  }
}

export class VisualLaunchMarkerCorruptionError extends Error {
  constructor(readonly key: string, detail: string) {
    super(`visual launch marker ${key} is corrupt: ${detail}`);
    this.name = "VisualLaunchMarkerCorruptionError";
  }
}

/** Conditional-create. A retry adopts the first valid timestamp instead of rewriting history. */
export async function writeVisualLaunchMarker(
  bucket: R2Bucket,
  input: VisualLaunchExpected & { recordedAt?: string },
): Promise<{ write: "stored" | "reused"; marker: VisualLaunchMarker; key: string }> {
  const expected = normalizeExpected(input);
  const marker = normalizeMarker({
    schemaVersion: VISUAL_LAUNCH_MARKER_SCHEMA_VERSION,
    kind: "survey-qa-visual-launch-marker",
    ...expected,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  });
  const key = visualLaunchMarkerKey(marker.runId, marker.workflowInstanceId, marker.state);
  const bytes = enc.encode(canonicalJson(marker));
  if (bytes.byteLength > MAX_MARKER_BYTES) invalid("$", "marker exceeds its storage envelope");
  const written = await bucket.put(key, bytes, {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written !== null) {
    const reread = await readVisualLaunchMarker(bucket, expected);
    if (reread === null) throw new VisualLaunchMarkerCorruptionError(key, "marker disappeared after create");
    return { write: "stored", marker: reread, key };
  }
  const existing = await readVisualLaunchMarker(bucket, expected);
  if (existing === null) {
    throw new VisualLaunchMarkerCorruptionError(key, "conditional-create lost without an existing marker");
  }
  return { write: "reused", marker: existing, key };
}

export async function readVisualLaunchMarker(
  bucket: R2Bucket,
  expectedInput: VisualLaunchExpected,
): Promise<VisualLaunchMarker | null> {
  const expected = normalizeExpected(expectedInput);
  const key = visualLaunchMarkerKey(expected.runId, expected.workflowInstanceId, expected.state);
  const object = await bucket.get(key);
  if (object === null) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength > MAX_MARKER_BYTES) {
    throw new VisualLaunchMarkerCorruptionError(key, "stored marker exceeds its storage envelope");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fatalUtf8.decode(bytes));
  } catch {
    throw new VisualLaunchMarkerCorruptionError(key, "stored bytes are not strict UTF-8 JSON");
  }
  let marker: VisualLaunchMarker;
  try {
    marker = normalizeMarker(parsed);
    assertExpected(marker, expected);
  } catch (error) {
    throw new VisualLaunchMarkerCorruptionError(
      key,
      error instanceof Error ? error.message.slice(0, 500) : "validation failed",
    );
  }
  if (canonicalJson(marker) !== fatalUtf8.decode(bytes)) {
    throw new VisualLaunchMarkerCorruptionError(key, "stored bytes are not canonical JSON");
  }
  return marker;
}

function normalizeExpected(value: VisualLaunchExpected): VisualLaunchExpected {
  const root = object(value, "$expected", [
    "state",
    "runId",
    "planRevisionId",
    "workflowInstanceId",
    "ownership",
  ], true);
  return {
    state: oneOf(root.state, VISUAL_LAUNCH_MARKER_STATES, "$expected.state"),
    runId: text(root.runId, "$expected.runId", MAX_ID),
    planRevisionId: text(root.planRevisionId, "$expected.planRevisionId", MAX_ID),
    workflowInstanceId: text(root.workflowInstanceId, "$expected.workflowInstanceId", 100),
    ownership: ownership(root.ownership, "$expected.ownership"),
  };
}

function normalizeMarker(value: unknown): VisualLaunchMarker {
  const root = object(value, "$", [
    "schemaVersion",
    "kind",
    "state",
    "runId",
    "planRevisionId",
    "workflowInstanceId",
    "ownership",
    "recordedAt",
  ]);
  literal(root.schemaVersion, VISUAL_LAUNCH_MARKER_SCHEMA_VERSION, "$.schemaVersion");
  literal(root.kind, "survey-qa-visual-launch-marker", "$.kind");
  return {
    schemaVersion: VISUAL_LAUNCH_MARKER_SCHEMA_VERSION,
    kind: "survey-qa-visual-launch-marker",
    state: oneOf(root.state, VISUAL_LAUNCH_MARKER_STATES, "$.state"),
    runId: text(root.runId, "$.runId", MAX_ID),
    planRevisionId: text(root.planRevisionId, "$.planRevisionId", MAX_ID),
    workflowInstanceId: text(root.workflowInstanceId, "$.workflowInstanceId", 100),
    ownership: ownership(root.ownership, "$.ownership"),
    recordedAt: timestamp(root.recordedAt, "$.recordedAt"),
  };
}

function assertExpected(marker: VisualLaunchMarker, expected: VisualLaunchExpected): void {
  if (
    marker.state !== expected.state ||
    marker.runId !== expected.runId ||
    marker.planRevisionId !== expected.planRevisionId ||
    marker.workflowInstanceId !== expected.workflowInstanceId ||
    marker.ownership.instanceId !== expected.ownership.instanceId ||
    marker.ownership.epoch !== expected.ownership.epoch
  ) {
    invalid("$", "marker does not match its exact launch identity");
  }
}

function ownership(value: unknown, path: string): Fence {
  const root = object(value, path, ["instanceId", "epoch"]);
  const epoch = root.epoch;
  if (!Number.isSafeInteger(epoch) || (epoch as number) < 0) invalid(`${path}.epoch`, "must be a non-negative safe integer");
  return { instanceId: text(root.instanceId, `${path}.instanceId`, MAX_ID), epoch: epoch as number };
}

function timestamp(value: unknown, path: string): string {
  const normalized = text(value, path, 100);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    invalid(path, "must be an ISO-8601 UTC timestamp");
  }
  return normalized;
}

function object(
  value: unknown,
  path: string,
  keys: readonly string[],
  allowRecordedAt = false,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(path, "must be an object");
  const root = value as Record<string, unknown>;
  const expected = new Set(keys);
  if (allowRecordedAt) expected.add("recordedAt");
  for (const key of Object.keys(root)) if (!expected.has(key)) invalid(path, `unknown field ${JSON.stringify(key)}`);
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(root, key)) invalid(path, `missing field ${JSON.stringify(key)}`);
  return root;
}

function text(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    invalid(path, `must be a non-empty string of at most ${maximum} characters`);
  }
  if (value.normalize("NFC") !== value || /[\u0000-\u001f\u007f]/u.test(value)) invalid(path, "contains non-canonical text");
  return value;
}

function literal<T extends string>(value: unknown, expected: T, path: string): T {
  if (value !== expected) invalid(path, `must equal ${JSON.stringify(expected)}`);
  return expected;
}

function oneOf<const T extends readonly string[]>(value: unknown, choices: T, path: string): T[number] {
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) {
    invalid(path, `must be one of ${choices.join(", ")}`);
  }
  return value as T[number];
}

function invalid(path: string, detail: string): never {
  throw new VisualLaunchMarkerValidationError(path, detail);
}

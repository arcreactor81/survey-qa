/**
 * STRICT, TARGET-NEUTRAL CAPTURE-EPOCH INPUT LOADER.
 *
 * A VisualWorkEpochRow is authorization to inspect named evidence, not proof of its contents.
 * This boundary re-reads every exact catalogue entry, verifies every content-addressed blob,
 * and binds the three capture channels before any provider can receive pixels. The DOM-derived
 * screen JSON is retained only as opaque paired provenance; its text is never returned as a
 * semantic reading. AX is independently parsed into its closed, inert data schema.
 */

import type {
  AccessibilitySnapshotArtifact,
  AccessibilitySnapshotNode,
  ScreenArtifactRef,
  ScreenCaptureFailure,
  ScreenCaptureGeometry,
  ScreenCaptureScope,
} from "../browser/types";
import {
  EvidenceCatalogTampered,
  EvidenceIntegrityFailure,
  getBoundCatalogEntry,
  getVerifiedEvidence,
} from "../store/evidence";
import { canonicalJson } from "../store/hash";
import {
  computeCaptureInputIdentity,
  type VisualWorkEpochRow,
} from "../store/visual-work";
import type { Env } from "../types/env";
import type { EvidenceCatalogEntry } from "../types/record";
import { computePairedEvidenceSha256 } from "./observe";
import type { PairedAccessibilityReading, PairedScreenReading } from "./reconcile";
import type {
  VisualCaptureGeometry,
  VisualCaptureIdentity,
  VisualEvidenceUnavailable,
  VisualObservationInput,
} from "./types";

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const HASH = /^[0-9a-f]{64}$/;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const MAX_SCREEN_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ACCESSIBILITY_JSON_BYTES = 8 * 1024 * 1024;
const MAX_AX_NODES = 100_000;
const MAX_AX_DEPTH = 512;
const MAX_AX_VALUE_CHARS = 1_000_000;
const MAX_TEXT = 4_000;

type ArtifactChannel = "screenshot" | "screen" | "accessibility";

export type VisualEpochInputFailureKind =
  | "manifest-row-not-eligible"
  | "manifest-row-malformed"
  | "manifest-cache-input-identity-mismatch"
  | "catalog-entry-missing"
  | "catalog-entry-unreadable"
  | "catalog-entry-tampered"
  | "catalog-entry-malformed"
  | "catalog-reference-mismatch"
  | "evidence-read-unavailable"
  | "evidence-integrity-failure"
  | "evidence-size-mismatch"
  | "screenshot-format-invalid"
  | "screenshot-dimensions-mismatch"
  | "screen-json-malformed"
  | "accessibility-json-malformed"
  | "accessibility-schema-invalid"
  | "accessibility-pair-mismatch"
  | "pair-digest-unavailable";

export interface VisualEpochInputLimitation {
  kind: VisualEpochInputFailureKind;
  channel: "manifest" | ArtifactChannel | "pairing";
  count: 1;
  /** Stable diagnostic only: raw storage/provider exceptions are deliberately excluded. */
  detail: string;
}

export interface LoadedVisualEpochInput {
  state: "loaded";
  input: VisualObservationInput;
  /** Pairing provenance only. DOM/screen JSON has no semantic value at this boundary. */
  screen: PairedScreenReading | null;
  /** Independently typed AX semantics, or null only for an explicit manifest capture failure. */
  accessibility: PairedAccessibilityReading | null;
}

export interface IneligibleVisualEpochInput {
  state: "ineligible";
  limitation: VisualEpochInputLimitation;
}

export type VisualEpochInputLoadResult = LoadedVisualEpochInput | IneligibleVisualEpochInput;

interface LoadedEvidence {
  bytes: Uint8Array;
  ref: ScreenArtifactRef;
}

type EvidenceLoadResult =
  | { state: "loaded"; value: LoadedEvidence }
  | IneligibleVisualEpochInput;

/**
 * Re-read and bind one manifest-authorized epoch. This function never invokes a model and never
 * converts a captured-but-bad channel into an absence. Any such defect returns `ineligible`.
 */
export async function loadVisualEpochInput(
  env: Env,
  runId: string,
  row: VisualWorkEpochRow,
): Promise<VisualEpochInputLoadResult> {
  const rowIssue = validateManifestRow(row);
  if (rowIssue !== null) return rowIssue;

  let recomputedIdentity: string;
  try {
    recomputedIdentity = await computeCaptureInputIdentity(row);
  } catch {
    return ineligible(
      "manifest-row-malformed",
      "manifest",
      "The epoch's paired capture identity could not be canonically recomputed.",
    );
  }
  if (row.cacheInputIdentity !== recomputedIdentity) {
    return ineligible(
      "manifest-cache-input-identity-mismatch",
      "manifest",
      "The epoch no longer matches the paired capture identity admitted by the visual-work manifest.",
    );
  }

  // Eligibility validation above proves this branch; keep the runtime guard so a malformed JS
  // caller still cannot cause an unverified provider request.
  if (row.screenshot.status !== "captured") {
    return ineligible("manifest-row-not-eligible", "screenshot", "The manifest did not capture screenshot evidence.");
  }
  const screenshot = await loadEvidence(env, runId, row, row.screenshot.ref, "screenshot");
  if (screenshot.state === "ineligible") return screenshot;
  const png = pngDimensions(screenshot.value.bytes);
  if (png === null) {
    return ineligible(
      "screenshot-format-invalid",
      "screenshot",
      "The verified screenshot bytes do not carry a supported PNG signature and IHDR dimensions record.",
    );
  }
  if (!pngDimensionsBindGeometry(png, row.geometry, row.scope)) {
    return ineligible(
      "screenshot-dimensions-mismatch",
      "screenshot",
      "The PNG IHDR dimensions do not match the measured viewport geometry and device scale factor.",
    );
  }

  let screenInput: VisualObservationInput["screen"];
  let screenReading: PairedScreenReading | null;
  if (row.screen.status === "failed") {
    const failure = unavailableFromFailure(row.screen.failure);
    screenInput = failure;
    screenReading = null;
  } else {
    const screen = await loadEvidence(env, runId, row, row.screen.ref, "screen");
    if (screen.state === "ineligible") return screen;
    if (!isStrictJsonObject(screen.value.bytes, MAX_SCREEN_JSON_BYTES)) {
      return ineligible(
        "screen-json-malformed",
        "screen",
        "The verified screen artifact is not bounded strict UTF-8 JSON object data.",
      );
    }
    screenInput = capturedJsonInput(screen.value);
    screenReading = {
      evidenceId: screen.value.ref.evidenceId,
      contentSha256: screen.value.ref.contentHash,
    };
  }

  let accessibilityInput: VisualObservationInput["accessibility"];
  let accessibilityReading: PairedAccessibilityReading | null;
  if (row.accessibility.status === "failed") {
    // Only an explicit, already-counted manifest capture failure permits unavailable AX.
    accessibilityInput = unavailableFromFailure(row.accessibility.failure);
    accessibilityReading = null;
  } else {
    const accessibility = await loadEvidence(env, runId, row, row.accessibility.ref, "accessibility");
    if (accessibility.state === "ineligible") return accessibility;
    let artifact: AccessibilitySnapshotArtifact;
    try {
      artifact = parseAccessibilitySnapshotArtifact(accessibility.value.bytes);
    } catch (error) {
      return ineligible(
        error instanceof AccessibilityJsonError
          ? "accessibility-json-malformed"
          : "accessibility-schema-invalid",
        "accessibility",
        error instanceof AccessibilitySchemaError
          ? `The verified AX artifact failed the closed schema at ${bounded(error.path)}.`
          : "The verified AX artifact is not bounded strict UTF-8 JSON object data.",
      );
    }
    if (!accessibilityBindsEpoch(artifact, row)) {
      return ineligible(
        "accessibility-pair-mismatch",
        "accessibility",
        "The AX artifact does not exactly bind this epoch's scope, geometry, screen, screenshot, step, and slot.",
      );
    }
    accessibilityInput = capturedJsonInput(accessibility.value);
    accessibilityReading = {
      evidenceId: accessibility.value.ref.evidenceId,
      contentSha256: accessibility.value.ref.contentHash,
      value: artifact,
    };
  }

  const capture: VisualCaptureIdentity = {
    runId,
    attemptId: row.attemptId,
    pathId: row.pathId,
    stepIndex: row.stepIndex,
    slot: row.slot,
    epochId: row.epochId,
    scope: cloneScope(row.scope),
  };
  const geometry: VisualCaptureGeometry = {
    source: row.geometry.source,
    viewportCssWidth: row.geometry.width,
    viewportCssHeight: row.geometry.height,
    screenshotPixelWidth: png.width,
    screenshotPixelHeight: png.height,
    deviceScaleFactor: row.geometry.deviceScaleFactor,
    scrollX: row.geometry.scrollX,
    scrollY: row.geometry.scrollY,
  };

  let pairedEvidenceSha256: string;
  try {
    pairedEvidenceSha256 = await computePairedEvidenceSha256({
      capture,
      geometry,
      screen: pairBinding(screenInput),
      accessibility: pairBinding(accessibilityInput),
    });
  } catch {
    return ineligible(
      "pair-digest-unavailable",
      "pairing",
      "The verified capture channels could not be bound into one canonical epoch digest.",
    );
  }

  return {
    state: "loaded",
    input: {
      screenshot: {
        evidenceId: screenshot.value.ref.evidenceId,
        contentSha256: screenshot.value.ref.contentHash,
        mediaType: "image/png",
        bytes: screenshot.value.bytes,
      },
      screen: screenInput,
      accessibility: accessibilityInput,
      pairedEvidenceSha256,
      capture,
      geometry,
    },
    screen: screenReading,
    accessibility: accessibilityReading,
  };
}

async function loadEvidence(
  env: Env,
  runId: string,
  row: VisualWorkEpochRow,
  ref: ScreenArtifactRef,
  channel: ArtifactChannel,
): Promise<EvidenceLoadResult> {
  let entry: EvidenceCatalogEntry | null;
  try {
    entry = await getBoundCatalogEntry(env, runId, ref.evidenceId);
  } catch (error) {
    return error instanceof EvidenceCatalogTampered
      ? ineligible("catalog-entry-tampered", channel, "The exact evidence catalogue entry failed its citation binding.")
      : ineligible("catalog-entry-unreadable", channel, "The exact evidence catalogue entry could not be safely read.");
  }
  if (entry === null) {
    return ineligible("catalog-entry-missing", channel, "The manifest-named evidence catalogue entry is absent.");
  }
  if (!validCatalogEntryShape(entry)) {
    return ineligible("catalog-entry-malformed", channel, "The evidence catalogue entry is outside its closed schema.");
  }
  const mismatch = catalogMismatch(entry, ref, row, channel);
  if (mismatch !== null) {
    return ineligible(
      "catalog-reference-mismatch",
      channel,
      `The catalogue metadata does not match the manifest reference (${mismatch}).`,
    );
  }

  let bytes: Uint8Array;
  try {
    ({ bytes } = await getVerifiedEvidence(env, entry));
  } catch (error) {
    return error instanceof EvidenceIntegrityFailure
      ? ineligible("evidence-integrity-failure", channel, "The content-addressed evidence bytes failed SHA-256 verification.")
      : ineligible("evidence-read-unavailable", channel, "The content-addressed evidence bytes could not be read.");
  }
  if (bytes.byteLength !== entry.size || bytes.byteLength !== ref.size) {
    return ineligible(
      "evidence-size-mismatch",
      channel,
      "The verified evidence byte length does not match both the catalogue and manifest reference.",
    );
  }
  const max = channel === "screenshot"
    ? MAX_SCREENSHOT_BYTES
    : channel === "screen"
      ? MAX_SCREEN_JSON_BYTES
      : MAX_ACCESSIBILITY_JSON_BYTES;
  if (bytes.byteLength === 0 || bytes.byteLength > max) {
    return ineligible(
      "evidence-size-mismatch",
      channel,
      `The evidence size is outside the closed ${channel} input envelope.`,
    );
  }
  return { state: "loaded", value: { bytes, ref } };
}

function validateManifestRow(row: VisualWorkEpochRow): IneligibleVisualEpochInput | null {
  if (!isRecord(row)) {
    return ineligible("manifest-row-malformed", "manifest", "The visual-work epoch row is not a plain object.");
  }
  const keys = [
    "walkOrdinal", "pathId", "attemptId", "walkArtifact", "epochOrdinal", "epochId", "stepIndex", "slot",
    "scope", "startedAt", "endedAt", "screenReadAt", "screenSignatureHash", "geometry", "screen", "screenshot",
    "accessibility", "cacheInputIdentity", "eligibility", "ambiguityKinds", "limitationKinds",
  ];
  if (!hasExactKeys(row, keys)) {
    return ineligible("manifest-row-malformed", "manifest", "The visual-work epoch row is outside its closed schema.");
  }
  if (
    !Array.isArray(row.ambiguityKinds) ||
    !row.ambiguityKinds.every((item) =>
      item === "duplicate-epoch-identity" || item === "duplicate-cache-input-identity") ||
    !Array.isArray(row.limitationKinds) ||
    !row.limitationKinds.every((item) => typeof item === "string") ||
    !isRecord(row.screenshot)
  ) {
    return ineligible("manifest-row-malformed", "manifest", "The visual-work row carries malformed state arrays or screenshot state.");
  }
  if (row.eligibility !== "eligible" || row.ambiguityKinds.length !== 0 || row.screenshot.status !== "captured") {
    return ineligible(
      "manifest-row-not-eligible",
      "manifest",
      "Only a uniquely eligible epoch with captured PNG evidence can enter visual inference.",
    );
  }
  if (
    !boundedNonempty(row.pathId, 500) ||
    !boundedNonempty(row.attemptId, 500) ||
    !boundedNonempty(row.epochId, 500) ||
    !boundedNonempty(row.slot, 200) ||
    !nonnegativeInteger(row.walkOrdinal, 100_000) ||
    !nonnegativeInteger(row.epochOrdinal, 500_000) ||
    !stepOrdinal(row.stepIndex, 1_000_000) ||
    !validTimestamp(row.startedAt) ||
    !validTimestamp(row.endedAt) ||
    !validTimestamp(row.screenReadAt) ||
    !HASH.test(row.screenSignatureHash) ||
    !validScope(row.scope) ||
    !validGeometry(row.geometry) ||
    !hasExactKeys(row.screenshot, ["status", "ref"]) ||
    !validRef(row.screenshot.ref, "screenshot") ||
    !validScreenState(row.screen, row.stepIndex, row.slot) ||
    !validAccessibilityState(row.accessibility, row.stepIndex, row.slot) ||
    typeof row.cacheInputIdentity !== "string" ||
    !/^visual-capture-input\/sha256\/[0-9a-f]{64}$/.test(row.cacheInputIdentity)
  ) {
    return ineligible(
      "manifest-row-malformed",
      "manifest",
      "Capture identity, explicit scope, geometry, failure, or artifact-reference metadata is malformed.",
    );
  }
  return null;
}

function validCatalogEntryShape(value: EvidenceCatalogEntry): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    "evidenceId", "sourceEvidenceId", "artifactRef", "contentHash", "mediaType", "size", "type",
    "capturedAt", "attemptId", "routeId", "witnesses",
  ])) return false;
  return boundedNonempty(value.evidenceId, 1_000) &&
    boundedNonempty(value.sourceEvidenceId, 1_000) &&
    boundedNonempty(value.artifactRef, 4_000) &&
    HASH.test(value.contentHash) &&
    boundedNonempty(value.mediaType, 200) &&
    nonnegativeInteger(value.size, Number.MAX_SAFE_INTEGER) &&
    ["screenshot", "dom-excerpt", "trace", "state", "har", "other"].includes(value.type) &&
    validTimestamp(value.capturedAt) &&
    (value.attemptId === null || boundedNonempty(value.attemptId, 500)) &&
    (value.routeId === null || boundedNonempty(value.routeId, 500)) &&
    Array.isArray(value.witnesses) &&
    value.witnesses.every((item) => boundedNonempty(item, 1_000));
}

function catalogMismatch(
  entry: EvidenceCatalogEntry,
  ref: ScreenArtifactRef,
  row: VisualWorkEpochRow,
  channel: ArtifactChannel,
): string | null {
  const expectedKind = channel === "screen" ? "screen-json" : channel;
  const expectedMedia = channel === "screenshot" ? "image/png" : "application/json";
  const expectedType = channel === "screenshot" ? "screenshot" : channel === "screen" ? "dom-excerpt" : "state";
  const checks: Array<[boolean, string]> = [
    [ref.kind === expectedKind, "reference kind"],
    [ref.mediaType === expectedMedia, "reference media type"],
    [entry.evidenceId === ref.evidenceId, "evidence id"],
    [entry.sourceEvidenceId === ref.sourceEvidenceId, "source evidence id"],
    [entry.artifactRef === ref.artifactRef, "artifact ref"],
    [entry.contentHash === ref.contentHash, "content hash"],
    [entry.mediaType === ref.mediaType && entry.mediaType === expectedMedia, "media type"],
    [entry.size === ref.size, "declared size"],
    [entry.type === expectedType, "catalogue evidence type"],
    [entry.attemptId === row.attemptId, "attempt id"],
    [entry.routeId === row.pathId, "route/path id"],
  ];
  return checks.find(([ok]) => !ok)?.[1] ?? null;
}

function accessibilityBindsEpoch(artifact: AccessibilitySnapshotArtifact, row: VisualWorkEpochRow): boolean {
  if (row.screenshot.status !== "captured" || row.accessibility.status !== "captured") return false;
  if (row.screen.status !== "captured") return false;
  return artifact.epochId === row.epochId &&
    artifact.stepIndex === row.stepIndex &&
    artifact.slot === row.slot &&
    canonicalJson(artifact.scope) === canonicalJson(row.scope) &&
    artifact.screenReadAt === row.screenReadAt &&
    artifact.screenSignatureHash === row.screenSignatureHash &&
    canonicalJson(artifact.geometry) === canonicalJson(row.geometry) &&
    sameRef(artifact.pairing.screenJson, row.screen.ref) &&
    artifact.pairing.screenshot !== null &&
    sameRef(artifact.pairing.screenshot, row.screenshot.ref) &&
    artifact.capture.completeness === row.accessibility.completeness &&
    canonicalJson(artifact.capture.limitations) === canonicalJson(row.accessibility.limitations);
}

class AccessibilityJsonError extends Error {}

class AccessibilitySchemaError extends Error {
  constructor(readonly path: string) {
    super(path);
  }
}

/** Parse and reconstruct the exact inert AX artifact schema; unknown fields are fatal. */
export function parseAccessibilitySnapshotArtifact(bytes: Uint8Array): AccessibilitySnapshotArtifact {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ACCESSIBILITY_JSON_BYTES) throw new AccessibilityJsonError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fatalUtf8.decode(bytes)) as unknown;
  } catch {
    throw new AccessibilityJsonError();
  }
  const root = exactObject(parsed, "$", [
    "kind", "epochId", "stepIndex", "slot", "scope", "capturedAt", "screenReadAt", "screenSignatureHash",
    "geometry", "pairing", "capture", "tree",
  ]);
  literal(root.kind, "v2-accessibility-snapshot/1.0.0", "$.kind");
  const epochId = stringValue(root.epochId, "$.epochId", 500, true);
  // Same domain as `stepOrdinal`: whole steps or the walker's recovery interleave (k + 0.5).
  if (!stepOrdinal(root.stepIndex, 1_000_000)) schema("$.stepIndex");
  const stepIndex = root.stepIndex as number;
  const slot = stringValue(root.slot, "$.slot", 200, true);
  const scope = parseScope(root.scope, "$.scope");
  const capturedAt = timestampValue(root.capturedAt, "$.capturedAt");
  const screenReadAt = timestampValue(root.screenReadAt, "$.screenReadAt");
  const screenSignatureHash = hashValue(root.screenSignatureHash, "$.screenSignatureHash");
  const geometry = parseGeometry(root.geometry, "$.geometry");
  const pairingRoot = exactObject(root.pairing, "$.pairing", ["screenJson", "screenshot"]);
  const screenJson = parseRef(pairingRoot.screenJson, "$.pairing.screenJson", "screen-json");
  const screenshot = pairingRoot.screenshot === null
    ? null
    : parseRef(pairingRoot.screenshot, "$.pairing.screenshot", "screenshot");

  const captureRoot = exactObject(root.capture, "$.capture", [
    "interestingOnly", "completeness", "limitations", "nodeCount", "maxDepthObserved", "serializedBytes", "limits",
  ]);
  if (captureRoot.interestingOnly !== false) schema("$.capture.interestingOnly");
  const completeness = enumValue(captureRoot.completeness, ["complete", "truncated"] as const, "$.capture.completeness");
  const limitsRoot = exactObject(captureRoot.limits, "$.capture.limits", [
    "maxNodes", "maxDepth", "maxValueChars", "maxSerializedBytes",
  ]);
  const limits = {
    maxNodes: integerValue(limitsRoot.maxNodes, "$.capture.limits.maxNodes", 1, MAX_AX_NODES),
    maxDepth: integerValue(limitsRoot.maxDepth, "$.capture.limits.maxDepth", 0, MAX_AX_DEPTH),
    maxValueChars: integerValue(limitsRoot.maxValueChars, "$.capture.limits.maxValueChars", 1, MAX_AX_VALUE_CHARS),
    maxSerializedBytes: integerValue(
      limitsRoot.maxSerializedBytes,
      "$.capture.limits.maxSerializedBytes",
      1,
      MAX_ACCESSIBILITY_JSON_BYTES,
    ),
  };
  const limitationsRaw = arrayValue(captureRoot.limitations, "$.capture.limitations", MAX_AX_NODES);
  const limitations = limitationsRaw.map((item, index) =>
    parseFailure(item, `$.capture.limitations[${index}]`, stepIndex, slot));
  if ((completeness === "complete") !== (limitations.length === 0)) schema("$.capture.limitations");

  const declaredNodeCount = integerValue(captureRoot.nodeCount, "$.capture.nodeCount", 1, limits.maxNodes);
  const declaredDepth = integerValue(
    captureRoot.maxDepthObserved,
    "$.capture.maxDepthObserved",
    0,
    limits.maxDepth,
  );
  const serializedBytes = integerValue(
    captureRoot.serializedBytes,
    "$.capture.serializedBytes",
    1,
    limits.maxSerializedBytes,
  );
  if (serializedBytes !== bytes.byteLength) schema("$.capture.serializedBytes");
  const stats = { nodes: 0, maxDepth: 0 };
  const tree = parseNode(root.tree, "$.tree", 0, limits, stats);
  if (stats.nodes !== declaredNodeCount) schema("$.capture.nodeCount");
  if (stats.maxDepth !== declaredDepth) schema("$.capture.maxDepthObserved");

  return {
    kind: "v2-accessibility-snapshot/1.0.0",
    epochId,
    stepIndex,
    slot,
    scope,
    capturedAt,
    screenReadAt,
    screenSignatureHash,
    geometry,
    pairing: { screenJson, screenshot },
    capture: {
      interestingOnly: false,
      completeness,
      limitations,
      nodeCount: declaredNodeCount,
      maxDepthObserved: declaredDepth,
      serializedBytes,
      limits,
    },
    tree,
  };
}

function parseNode(
  value: unknown,
  path: string,
  depth: number,
  limits: AccessibilitySnapshotArtifact["capture"]["limits"],
  stats: { nodes: number; maxDepth: number },
): AccessibilitySnapshotNode {
  if (depth > limits.maxDepth) schema(path);
  if (stats.nodes >= limits.maxNodes) schema(path);
  const allowed = [
    "role", "name", "value", "description", "keyshortcuts", "roledescription", "valuetext", "disabled",
    "expanded", "focused", "modal", "multiline", "multiselectable", "readonly", "required", "selected",
    "checked", "pressed", "level", "valuemin", "valuemax", "autocomplete", "haspopup", "invalid",
    "orientation", "children",
  ];
  const root = exactObject(value, path, allowed, ["role", "children"]);
  stats.nodes += 1;
  stats.maxDepth = Math.max(stats.maxDepth, depth);
  const node: AccessibilitySnapshotNode = {
    role: stringValue(root.role, `${path}.role`, limits.maxValueChars, true),
    children: [],
  };
  putOptionalString(root, node, "name", path, limits.maxValueChars);
  putOptionalValue(root, node, path, limits.maxValueChars);
  for (const key of ["description", "keyshortcuts", "roledescription", "valuetext", "autocomplete", "haspopup", "invalid", "orientation"] as const) {
    putOptionalString(root, node, key, path, limits.maxValueChars);
  }
  for (const key of ["disabled", "expanded", "focused", "modal", "multiline", "multiselectable", "readonly", "required", "selected"] as const) {
    if (hasOwn(root, key)) {
      if (typeof root[key] !== "boolean") schema(`${path}.${key}`);
      node[key] = root[key];
    }
  }
  for (const key of ["checked", "pressed"] as const) {
    if (hasOwn(root, key)) {
      if (typeof root[key] !== "boolean" && root[key] !== "mixed") schema(`${path}.${key}`);
      node[key] = root[key];
    }
  }
  for (const key of ["level", "valuemin", "valuemax"] as const) {
    if (hasOwn(root, key)) {
      if (typeof root[key] !== "number" || !Number.isFinite(root[key])) schema(`${path}.${key}`);
      node[key] = root[key];
    }
  }
  node.children = arrayValue(root.children, `${path}.children`, limits.maxNodes).map((child, index) =>
    parseNode(child, `${path}.children[${index}]`, depth + 1, limits, stats));
  return node;
}

function parseFailure(value: unknown, path: string, stepIndex: number, slot: string): ScreenCaptureFailure {
  const root = exactObject(value, path, ["kind", "detail", "count", "at", "stepIndex", "slot"]);
  const kind = enumValue(root.kind, FAILURE_KINDS, `${path}.kind`);
  const detail = stringValue(root.detail, `${path}.detail`, MAX_TEXT, true);
  const count = integerValue(root.count, `${path}.count`, 1, 1_000_000);
  const at = timestampValue(root.at, `${path}.at`);
  const actualStep = integerValue(root.stepIndex, `${path}.stepIndex`, 0, 1_000_000);
  const actualSlot = stringValue(root.slot, `${path}.slot`, 200, true);
  if (actualStep !== stepIndex) schema(`${path}.stepIndex`);
  if (actualSlot !== slot) schema(`${path}.slot`);
  return { kind, detail, count, at, stepIndex: actualStep, slot: actualSlot };
}

function parseRef<K extends ScreenArtifactRef["kind"]>(
  value: unknown,
  path: string,
  kind: K,
): ScreenArtifactRef & { kind: K } {
  const root = exactObject(value, path, [
    "kind", "evidenceId", "artifactRef", "sourceEvidenceId", "contentHash", "mediaType", "size",
  ]);
  literal(root.kind, kind, `${path}.kind`);
  const mediaType = kind === "screenshot" ? "image/png" : "application/json";
  literal(root.mediaType, mediaType, `${path}.mediaType`);
  return {
    kind,
    evidenceId: stringValue(root.evidenceId, `${path}.evidenceId`, 1_000, true),
    artifactRef: stringValue(root.artifactRef, `${path}.artifactRef`, 4_000, true),
    sourceEvidenceId: stringValue(root.sourceEvidenceId, `${path}.sourceEvidenceId`, 1_000, true),
    contentHash: hashValue(root.contentHash, `${path}.contentHash`),
    mediaType,
    size: integerValue(root.size, `${path}.size`, 0, Number.MAX_SAFE_INTEGER),
  } as ScreenArtifactRef & { kind: K };
}

function parseGeometry(value: unknown, path: string): ScreenCaptureGeometry {
  const root = exactObject(value, path, [
    "width", "height", "deviceScaleFactor", "scrollX", "scrollY", "documentWidth", "documentHeight", "source",
  ]);
  const geometry: ScreenCaptureGeometry = {
    width: finiteValue(root.width, `${path}.width`, true),
    height: finiteValue(root.height, `${path}.height`, true),
    deviceScaleFactor: nullableFiniteValue(root.deviceScaleFactor, `${path}.deviceScaleFactor`, true),
    scrollX: nullableFiniteValue(root.scrollX, `${path}.scrollX`, false),
    scrollY: nullableFiniteValue(root.scrollY, `${path}.scrollY`, false),
    documentWidth: nullableFiniteValue(root.documentWidth, `${path}.documentWidth`, true),
    documentHeight: nullableFiniteValue(root.documentHeight, `${path}.documentHeight`, true),
    source: enumValue(root.source, ["browser", "configured-fallback"] as const, `${path}.source`),
  };
  if (!validGeometry(geometry)) schema(path);
  return geometry;
}

function parseScope(value: unknown, path: string): ScreenCaptureScope {
  const root = exactObject(value, path, ["kind", "tileIndex", "tileCount"]);
  const kind = enumValue(root.kind, ["viewport", "tile"] as const, `${path}.kind`);
  if (kind === "viewport") {
    if (root.tileIndex !== null || root.tileCount !== null) schema(path);
    return { kind, tileIndex: null, tileCount: null };
  }
  const tileIndex = integerValue(root.tileIndex, `${path}.tileIndex`, 0, 1_000_000);
  const tileCount = integerValue(root.tileCount, `${path}.tileCount`, 1, 1_000_000);
  if (tileIndex >= tileCount) schema(`${path}.tileIndex`);
  return { kind, tileIndex, tileCount };
}

function isStrictJsonObject(bytes: Uint8Array, maxBytes: number): boolean {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return false;
  try {
    const value = JSON.parse(fatalUtf8.decode(bytes)) as unknown;
    return isJsonValue(value) && isRecord(value);
  } catch {
    return false;
  }
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => bytes[index] === byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, false) !== 13) return null;
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== "IHDR") return null;
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return width > 0 && height > 0 && width <= 200_000 && height <= 200_000 ? { width, height } : null;
}

function pngDimensionsBindGeometry(
  png: { width: number; height: number },
  geometry: ScreenCaptureGeometry,
  scope: ScreenCaptureScope,
): boolean {
  // Tile extents are explicitly declared by scope but their CSS crop bounds are not yet part of
  // this schema. The PNG's own verified dimensions are retained without pretending a viewport
  // equation applies. Configured fallback likewise names that DPR was not measured.
  if (scope.kind === "tile" || geometry.source === "configured-fallback") return true;
  if (geometry.deviceScaleFactor === null) return false;
  const expectedWidth = geometry.width * geometry.deviceScaleFactor;
  const expectedHeight = geometry.height * geometry.deviceScaleFactor;
  if (!Number.isInteger(expectedWidth) || !Number.isInteger(expectedHeight)) return false;
  return png.width === expectedWidth && png.height === expectedHeight;
}

function validScreenState(value: VisualWorkEpochRow["screen"], step: number, slot: string): boolean {
  if (!isRecord(value)) return false;
  if (value.status === "captured") return hasExactKeys(value, ["status", "ref"]) && validRef(value.ref, "screen-json");
  return value.status === "failed" && hasExactKeys(value, ["status", "failure"]) && validFailure(value.failure, step, slot);
}

function validAccessibilityState(value: VisualWorkEpochRow["accessibility"], step: number, slot: string): boolean {
  if (!isRecord(value)) return false;
  if (value.status === "failed") {
    return hasExactKeys(value, ["status", "failure"]) && validFailure(value.failure, step, slot);
  }
  if (!hasExactKeys(value, ["status", "ref", "completeness", "limitations"]) ||
      !validRef(value.ref, "accessibility") ||
      !["complete", "truncated"].includes(value.completeness) ||
      !Array.isArray(value.limitations) ||
      !value.limitations.every((item) => validFailure(item, step, slot))) return false;
  return (value.completeness === "complete") === (value.limitations.length === 0);
}

function validFailure(value: ScreenCaptureFailure, step: number, slot: string): boolean {
  return isRecord(value) && hasExactKeys(value, ["kind", "detail", "count", "at", "stepIndex", "slot"]) &&
    // PDF is visibility-only and never impersonates a missing screen or AX channel. Its
    // named failures travel in the manifest's limitationKinds, outside these modalities.
    (FAILURE_KINDS as readonly ScreenCaptureFailure["kind"][]).includes(value.kind) && boundedNonempty(value.detail, MAX_TEXT) &&
    nonnegativeInteger(value.count, 1_000_000) && value.count > 0 && validTimestamp(value.at) &&
    value.stepIndex === step && value.slot === slot;
}

function validRef<K extends ScreenArtifactRef["kind"]>(value: ScreenArtifactRef, kind: K): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "kind", "evidenceId", "artifactRef", "sourceEvidenceId", "contentHash", "mediaType", "size",
  ]) && value.kind === kind && boundedNonempty(value.evidenceId, 1_000) &&
    boundedNonempty(value.artifactRef, 4_000) && boundedNonempty(value.sourceEvidenceId, 1_000) &&
    HASH.test(value.contentHash) && value.mediaType === (kind === "screenshot" ? "image/png" : "application/json") &&
    nonnegativeInteger(value.size, Number.MAX_SAFE_INTEGER);
}

function validScope(value: ScreenCaptureScope): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "tileIndex", "tileCount"])) return false;
  if (value.kind === "viewport") return value.tileIndex === null && value.tileCount === null;
  return value.kind === "tile" && nonnegativeInteger(value.tileIndex, 1_000_000) &&
    nonnegativeInteger(value.tileCount, 1_000_000) && value.tileCount > 0 && value.tileIndex < value.tileCount;
}

function validGeometry(value: ScreenCaptureGeometry): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    "width", "height", "deviceScaleFactor", "scrollX", "scrollY", "documentWidth", "documentHeight", "source",
  ])) return false;
  if (!positiveFinite(value.width) || !positiveFinite(value.height)) return false;
  if (value.source === "configured-fallback") {
    return value.deviceScaleFactor === null && value.scrollX === null && value.scrollY === null &&
      value.documentWidth === null && value.documentHeight === null;
  }
  return value.source === "browser" && positiveFinite(value.deviceScaleFactor) && finite(value.scrollX) &&
    finite(value.scrollY) && positiveFinite(value.documentWidth) && positiveFinite(value.documentHeight);
}

function unavailableFromFailure(failure: ScreenCaptureFailure): VisualEvidenceUnavailable {
  return { state: "unavailable", failure: { kind: failure.kind, count: failure.count, detail: failure.detail } };
}

function capturedJsonInput(value: LoadedEvidence): VisualObservationInput["screen"] {
  return {
    state: "captured",
    evidenceId: value.ref.evidenceId,
    contentSha256: value.ref.contentHash,
    mediaType: "application/json",
    bytes: value.bytes,
  };
}

function pairBinding(value: VisualObservationInput["screen"]):
  | { state: "captured"; evidenceId: string; contentSha256: string }
  | { state: "unavailable"; failure: VisualEvidenceUnavailable["failure"] } {
  return value.state === "captured"
    ? { state: "captured", evidenceId: value.evidenceId, contentSha256: value.contentSha256 }
    : { state: "unavailable", failure: value.failure };
}

function cloneScope(scope: ScreenCaptureScope): VisualCaptureIdentity["scope"] {
  return scope.kind === "viewport"
    ? { kind: "viewport", tileIndex: null, tileCount: null }
    : { kind: "tile", tileIndex: scope.tileIndex, tileCount: scope.tileCount };
}

function sameRef(a: ScreenArtifactRef, b: ScreenArtifactRef): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function ineligible(
  kind: VisualEpochInputFailureKind,
  channel: VisualEpochInputLimitation["channel"],
  detail: string,
): IneligibleVisualEpochInput {
  return { state: "ineligible", limitation: { kind, channel, count: 1, detail: bounded(detail) } };
}

function exactObject(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  if (!isRecord(value)) schema(path);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) schema(`${path}.${key}`);
  for (const key of required) if (!hasOwn(value, key)) schema(path);
  return value;
}

function arrayValue(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) schema(path);
  return value;
}

function literal(value: unknown, expected: string, path: string): void {
  if (value !== expected) schema(path);
}

function enumValue<const T extends readonly (string | number)[]>(value: unknown, allowed: T, path: string): T[number] {
  if (!allowed.includes(value as never)) schema(path);
  return value as T[number];
}

function stringValue(value: unknown, path: string, max: number, nonempty: boolean): string {
  if (typeof value !== "string" || value.length > max || (nonempty && value.trim().length === 0)) schema(path);
  return value;
}

function integerValue(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) schema(path);
  return value;
}

function finiteValue(value: unknown, path: string, positive: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (positive && value <= 0)) schema(path);
  return value;
}

function nullableFiniteValue(value: unknown, path: string, positive: boolean): number | null {
  return value === null ? null : finiteValue(value, path, positive);
}

function timestampValue(value: unknown, path: string): string {
  const output = stringValue(value, path, 100, true);
  if (!validTimestamp(output)) schema(path);
  return output;
}

function hashValue(value: unknown, path: string): string {
  const output = stringValue(value, path, 64, true);
  if (!HASH.test(output)) schema(path);
  return output;
}

function putOptionalString<K extends "name" | "description" | "keyshortcuts" | "roledescription" | "valuetext" | "autocomplete" | "haspopup" | "invalid" | "orientation">(
  root: Record<string, unknown>,
  node: AccessibilitySnapshotNode,
  key: K,
  path: string,
  max: number,
): void {
  if (hasOwn(root, key)) node[key] = stringValue(root[key], `${path}.${key}`, max, false);
}

function putOptionalValue(
  root: Record<string, unknown>,
  node: AccessibilitySnapshotNode,
  path: string,
  max: number,
): void {
  if (!hasOwn(root, "value")) return;
  if (typeof root.value === "string") node.value = stringValue(root.value, `${path}.value`, max, false);
  else if (typeof root.value === "number" && Number.isFinite(root.value)) node.value = root.value;
  else schema(`${path}.value`);
}

function schema(path: string): never {
  throw new AccessibilitySchemaError(path);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  const allowed = new Set(expected);
  return actual.length === expected.length && actual.every((key) => allowed.has(key));
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedNonempty(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function nonnegativeInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

/**
 * Step ordinals are whole steps (k) or the walker's recovery interleave (k + 0.5): the driver
 * records the recovery it runs after a blocked step as `stepIndex + 0.5` by design. Accept
 * exactly the writer's domain — halves and nothing finer.
 */
function stepOrdinal(value: unknown, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= max &&
    Number.isSafeInteger(value * 2)
  );
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveFinite(value: unknown): value is number {
  return finite(value) && value > 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && Number.isFinite(Date.parse(value));
}

function bounded(value: string): string {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  return oneLine.length <= 500 ? oneLine : `${oneLine.slice(0, 497)}...`;
}

const FAILURE_KINDS = [
  "capture-metadata-failed",
  "screen-read-failed",
  "screenshot-capture-failed",
  "screenshot-capture-empty",
  "screenshot-evidence-write-failed",
  "accessibility-api-unavailable",
  "accessibility-snapshot-failed",
  "accessibility-snapshot-empty",
  "accessibility-snapshot-invalid-node",
  "accessibility-snapshot-node-limit",
  "accessibility-snapshot-depth-limit",
  "accessibility-snapshot-value-limit",
  "accessibility-snapshot-size-limit",
  "accessibility-evidence-write-failed",
] as const;

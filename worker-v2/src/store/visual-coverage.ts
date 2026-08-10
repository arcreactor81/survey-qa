/**
 * CLOSED VISUAL SHADOW COVERAGE.
 *
 * A successful-only visual index answers the wrong question: it says what produced data, not
 * what the run actually attempted (or could not attempt). This module closes that denominator
 * against the immutable pre-call VisualWorkManifest. Every known capture epoch receives exactly
 * one disposition. A walk whose epoch count is unknown receives an explicit placeholder, and a
 * verified walk with a known zero count receives a distinct placeholder so zero cannot masquerade
 * as “nothing to report”.
 *
 * This component is deliberately survey- and provider-neutral. It never calls a model and never
 * turns an observation into a verdict. Provider/model/prompt/schema identities are only sealed so
 * artifacts from different inference configurations cannot be mixed in one coverage claim.
 */

import { assertV2Key, k, visualManifestKey } from "../keys";
import type { ScreenshotScope, VisualObservationArtifact } from "../vision/types";
import {
  createGroundedVisualEpochResult,
  normalizeOptionMembershipReconciliation,
  normalizeVisualObservationArtifact,
} from "./vision";
import { canonicalHash, canonicalJson, sha256Hex } from "./hash";
import type { VisualWorkEpochRow, VisualWorkManifest, VisualWorkWalkRow } from "./visual-work";
import { validateVisualWorkManifest } from "./visual-work";

const enc = new TextEncoder();
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const HASH = /^[0-9a-f]{64}$/;
const MAX_ITEMS = 500_000;
const MAX_COVERAGE_BYTES = 32 * 1024 * 1024;
const MAX_WORK_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_KEY_CHARS = 1_024;
const MAX_SEGMENTS = 64;
const MAX_SEGMENT_CHARS = 300;
const MAX_TEXT = 4_000;

export const VISUAL_COVERAGE_INDEX_SCHEMA_VERSION = "survey-qa-visual-coverage-index/1.0.0" as const;
export const VISUAL_COVERAGE_POINTER_SCHEMA_VERSION = "survey-qa-visual-coverage-pointer/1.0.0" as const;

/**
 * `accounting-failed` is intentionally separate. A provider may have settled successfully while
 * the exact-once usage commit failed. Calling that provider-unavailable would falsify both model
 * availability and spend state; calling it persistence-failed would hide the purchase blocker.
 * `purchase-blocked` does not claim a provider attempt: it also closes untouched eligible
 * remainder after an earlier indeterminate purchase stops the channel. Its detail must name that
 * originating blocker. `rollout-config-invalid` distinguishes fail-closed configuration from an
 * intentional zero-budget/disabled rollout.
 *
 * `provider-malformed` also covers the narrower semantic-contract contradiction where the model's
 * JSON is schema-valid but claims an unqualified empty inventory while the paired readers contain
 * text or interactive semantics. The observation preserves that case under the exact named
 * `model-inventory-empty-despite-paired-content` limitation; it is not counted as visual success.
 */
export const VISUAL_COVERAGE_DISPOSITIONS = [
  "observed-stored",
  "input-ineligible",
  "input-integrity-failed",
  "provider-unavailable",
  "provider-malformed",
  "persistence-failed",
  "purchase-blocked",
  "accounting-failed",
  "rollout-config-invalid",
  "budget-not-authorized",
  "wave-limit-uncovered",
] as const;

export type VisualCoverageDisposition = (typeof VISUAL_COVERAGE_DISPOSITIONS)[number];

export interface VisualInferenceFingerprint {
  provider: string;
  model: string;
  transport: string;
  configurationSha256: string;
  prompt: { version: string; sha256: string };
  responseSchema: { version: string; sha256: string };
}

/** Rollout authority is distinct from model adapter configuration and therefore separately sealed. */
export interface VisualCoverageAuthorization {
  state: "disabled" | "invalid" | "authorized";
  rolloutConfigurationSha256: string;
  maximumVisualCalls: number;
  maximumVisualUsd: number;
}

export type VisualCoverageDenominatorItem =
  | {
      kind: "walk-epochs-unknown" | "walk-no-epochs";
      walkOrdinal: number;
      pathId: string;
      attemptId: string;
      walkResolution: VisualWorkWalkRow["resolution"];
      epochKnowledge: VisualWorkWalkRow["epochKnowledge"];
      epochOrdinal: null;
      epochId: null;
      stepIndex: null;
      slot: null;
      scope: null;
      eligibility: null;
      workItemSha256: string;
    }
  | {
      kind: "epoch";
      walkOrdinal: number;
      pathId: string;
      attemptId: string;
      walkResolution: "verified";
      epochKnowledge: "known";
      epochOrdinal: number;
      epochId: string;
      stepIndex: number;
      slot: string;
      scope: ScreenshotScope;
      eligibility: VisualWorkEpochRow["eligibility"];
      workItemSha256: string;
    };

/** A key plus the digest of the exact immutable bytes it names. */
export interface VisualCoverageArtifactRef {
  key: string;
  contentSha256: string;
}

export interface VisualCoverageSuccessRefs {
  epochDigest: string;
  inferenceDigest: string;
  observation: VisualCoverageArtifactRef;
  reconciliation: VisualCoverageArtifactRef;
  grounded: VisualCoverageArtifactRef;
}

export interface VisualCoverageEntry {
  item: VisualCoverageDenominatorItem;
  inferenceFingerprintSha256: string;
  authorizationFingerprintSha256: string;
  disposition: VisualCoverageDisposition;
  /** Null only for success. Every limitation carries bounded, non-secret diagnostic text. */
  detail: string | null;
  success: VisualCoverageSuccessRefs | null;
}

export interface VisualCoverageDispositionTotals {
  "observed-stored": number;
  "input-ineligible": number;
  "input-integrity-failed": number;
  "provider-unavailable": number;
  "provider-malformed": number;
  "persistence-failed": number;
  "purchase-blocked": number;
  "accounting-failed": number;
  "rollout-config-invalid": number;
  "budget-not-authorized": number;
  "wave-limit-uncovered": number;
}

export interface VisualCoverageTotals {
  denominatorItems: number;
  epochItems: number;
  eligibleEpochItems: number;
  ineligibleEpochItems: number;
  unknownEpochWalkItems: number;
  noEpochWalkItems: number;
  successfulItems: number;
  limitationItems: number;
  dispositions: VisualCoverageDispositionTotals;
}

export interface VisualCoverageIndex {
  schemaVersion: typeof VISUAL_COVERAGE_INDEX_SCHEMA_VERSION;
  kind: "survey-qa-visual-coverage-index";
  runId: string;
  planRevisionId: string;
  visualWorkManifestSha256: string;
  inference: VisualInferenceFingerprint;
  inferenceFingerprintSha256: string;
  authorization: VisualCoverageAuthorization;
  authorizationFingerprintSha256: string;
  finalizedAt: string;
  entries: VisualCoverageEntry[];
  totals: VisualCoverageTotals;
}

export interface PreparedVisualCoverageIndex {
  index: VisualCoverageIndex;
  canonicalBytes: Uint8Array;
  contentSha256: string;
  workManifest: VisualWorkManifest;
}

export interface VisualCoveragePointer {
  schemaVersion: typeof VISUAL_COVERAGE_POINTER_SCHEMA_VERSION;
  kind: "survey-qa-visual-coverage-pointer";
  runId: string;
  planRevisionId: string;
  visualWorkManifestSha256: string;
  inferenceFingerprintSha256: string;
  authorizationFingerprintSha256: string;
  coverage: VisualCoverageArtifactRef;
  successfulDataManifest: VisualCoverageArtifactRef | null;
}

export interface FinalizedVisualCoverageIndex {
  coverageWrite: "stored" | "reused";
  pointerWrite: "stored" | "reused";
  coverageKey: string;
  pointerKey: string;
  coverageSha256: string;
  pointer: VisualCoveragePointer;
}

export interface VisualCoverageExpected {
  runId?: string;
  planRevisionId?: string;
  visualWorkManifestSha256?: string;
  inferenceFingerprintSha256?: string;
  authorizationFingerprintSha256?: string;
}

export const DISABLED_VISUAL_PROVIDER = "not-authorized" as const;
export const DISABLED_VISUAL_MODEL = "not-selected" as const;
export const DISABLED_VISUAL_TRANSPORT = "none" as const;

/**
 * Closed provider sentinel for a rollout that was deliberately disabled or rejected as invalid.
 * Prompt/schema hashes remain exact because they define what would have been observed; rollout
 * caps/config live in the separate authorization fingerprint.
 */
export async function createDisabledVisualInferenceFingerprint(input: {
  prompt: { version: string; sha256: string };
  responseSchema: { version: string; sha256: string };
}): Promise<VisualInferenceFingerprint> {
  return {
    provider: DISABLED_VISUAL_PROVIDER,
    model: DISABLED_VISUAL_MODEL,
    transport: DISABLED_VISUAL_TRANSPORT,
    configurationSha256: await canonicalHash({
      kind: "survey-qa-disabled-visual-inference-sentinel",
      version: "1.0.0",
    }),
    prompt: normalizeVersionHash(input.prompt, "$.prompt"),
    responseSchema: normalizeVersionHash(input.responseSchema, "$.responseSchema"),
  };
}

export class VisualCoverageValidationError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "VisualCoverageValidationError";
  }
}

export class VisualCoverageImmutabilityError extends Error {
  constructor(readonly key: string) {
    super(`visual coverage object ${key} already exists with different bytes; immutable rewrite refused`);
    this.name = "VisualCoverageImmutabilityError";
  }
}

export class VisualCoverageCorruptionError extends Error {
  constructor(readonly key: string, detail: string) {
    super(`visual coverage object ${key} is corrupt: ${detail}`);
    this.name = "VisualCoverageCorruptionError";
  }
}

/** Content-addressed final coverage object. */
export function visualCoverageIndexKey(runId: string, contentSha256: string): string {
  return k("runs", keySegment(runId, "runId"), "visual", "coverage", "sha256", hash(contentSha256, "contentSha256"), "index.json");
}

/** Fixed write-once pointer. A differing retry is refused rather than repointed. */
export function visualCoveragePointerKey(runId: string): string {
  return k("runs", keySegment(runId, "runId"), "visual", "coverage", "current.json");
}

/** Future successful-data manifests use the same content-addressed convention. */
export function visualSuccessfulDataManifestKey(runId: string, contentSha256: string): string {
  return k(
    "runs",
    keySegment(runId, "runId"),
    "visual",
    "successful-data",
    "sha256",
    hash(contentSha256, "contentSha256"),
    "manifest.json",
  );
}

export async function visualInferenceFingerprintSha256(value: VisualInferenceFingerprint): Promise<string> {
  return canonicalHash(normalizeInferenceFingerprint(value, "$.inference"));
}

export async function visualAuthorizationFingerprintSha256(value: VisualCoverageAuthorization): Promise<string> {
  return canonicalHash(normalizeAuthorization(value, "$.authorization"));
}

/**
 * Derive the complete denominator from a closed work manifest. The additional no-epoch item is
 * intentional: it preserves the distinction between “verified as zero” and “never represented”.
 */
export async function deriveVisualCoverageDenominator(
  value: VisualWorkManifest,
): Promise<VisualCoverageDenominatorItem[]> {
  const manifest = await validateVisualWorkManifest(value);
  const epochsByWalk = new Map<number, VisualWorkEpochRow[]>();
  for (const epoch of manifest.epochs) {
    const group = epochsByWalk.get(epoch.walkOrdinal) ?? [];
    group.push(epoch);
    epochsByWalk.set(epoch.walkOrdinal, group);
  }

  const items: VisualCoverageDenominatorItem[] = [];
  for (let walkOrdinal = 0; walkOrdinal < manifest.walks.length; walkOrdinal += 1) {
    const walk = manifest.walks[walkOrdinal]!;
    if (walk.walkOrdinal !== walkOrdinal) {
      invalid(`$.workManifest.walks[${walkOrdinal}].walkOrdinal`, "has an ordinal gap");
    }
    const epochs = epochsByWalk.get(walkOrdinal) ?? [];
    if (walk.epochKnowledge === "unknown") {
      if (epochs.length !== 0 || walk.epochCount !== null) {
        invalid(`$.workManifest.walks[${walkOrdinal}]`, "unknown epoch coverage cannot carry enumerated epochs");
      }
      items.push({
        kind: "walk-epochs-unknown",
        walkOrdinal,
        pathId: walk.pathId,
        attemptId: walk.attemptId,
        walkResolution: walk.resolution,
        epochKnowledge: "unknown",
        epochOrdinal: null,
        epochId: null,
        stepIndex: null,
        slot: null,
        scope: null,
        eligibility: null,
        workItemSha256: await canonicalHash(walk),
      });
      continue;
    }

    if (walk.epochCount !== epochs.length) {
      invalid(
        `$.workManifest.walks[${walkOrdinal}].epochCount`,
        `declares ${walk.epochCount} but ${epochs.length} epoch rows were found`,
      );
    }
    if (epochs.length === 0) {
      items.push({
        kind: "walk-no-epochs",
        walkOrdinal,
        pathId: walk.pathId,
        attemptId: walk.attemptId,
        walkResolution: walk.resolution,
        epochKnowledge: "known",
        epochOrdinal: null,
        epochId: null,
        stepIndex: null,
        slot: null,
        scope: null,
        eligibility: null,
        workItemSha256: await canonicalHash(walk),
      });
      continue;
    }

    for (let epochOrdinal = 0; epochOrdinal < epochs.length; epochOrdinal += 1) {
      const epoch = epochs[epochOrdinal]!;
      if (epoch.epochOrdinal !== epochOrdinal) {
        invalid(`$.workManifest.epochs[walk=${walkOrdinal},index=${epochOrdinal}]`, "has an ordinal gap");
      }
      items.push({
        kind: "epoch",
        walkOrdinal,
        pathId: epoch.pathId,
        attemptId: epoch.attemptId,
        walkResolution: "verified",
        epochKnowledge: "known",
        epochOrdinal,
        epochId: epoch.epochId,
        stepIndex: epoch.stepIndex,
        slot: epoch.slot,
        scope: normalizeScope(epoch.scope, `$.workManifest.epochs[walk=${walkOrdinal},index=${epochOrdinal}].scope`),
        eligibility: epoch.eligibility,
        workItemSha256: await canonicalHash(epoch),
      });
    }
  }
  if (items.length > MAX_ITEMS) invalid("$.workManifest", `coverage denominator exceeds ${MAX_ITEMS} items`);
  return items;
}

export async function prepareVisualCoverageIndex(input: {
  workManifest: VisualWorkManifest;
  visualWorkManifestSha256: string;
  inference: VisualInferenceFingerprint;
  authorization: VisualCoverageAuthorization;
  finalizedAt: string;
  entries: readonly unknown[];
}): Promise<PreparedVisualCoverageIndex> {
  const workManifest = await validateVisualWorkManifest(input.workManifest);
  const visualWorkManifestSha256 = hash(input.visualWorkManifestSha256, "$.visualWorkManifestSha256");
  const actualWorkSha256 = await canonicalHash(workManifest);
  if (visualWorkManifestSha256 !== actualWorkSha256) {
    invalid("$.visualWorkManifestSha256", "does not hash the exact closed visual work manifest");
  }
  const inference = normalizeInferenceFingerprint(input.inference, "$.inference");
  const inferenceFingerprintSha256 = await canonicalHash(inference);
  const authorization = normalizeAuthorization(input.authorization, "$.authorization");
  const authorizationFingerprintSha256 = await canonicalHash(authorization);
  assertAuthorizationInferencePair(authorization, inference);
  const finalizedAt = isoTimestamp(input.finalizedAt, "$.finalizedAt");
  const denominator = await deriveVisualCoverageDenominator(workManifest);
  const entries = normalizeAndCloseEntries(
    input.entries,
    denominator,
    inferenceFingerprintSha256,
    authorizationFingerprintSha256,
    authorization,
  );
  const totals = computeVisualCoverageTotals(entries);
  const index: VisualCoverageIndex = {
    schemaVersion: VISUAL_COVERAGE_INDEX_SCHEMA_VERSION,
    kind: "survey-qa-visual-coverage-index",
    runId: workManifest.runId,
    planRevisionId: workManifest.planRevisionId,
    visualWorkManifestSha256,
    inference,
    inferenceFingerprintSha256,
    authorization,
    authorizationFingerprintSha256,
    finalizedAt,
    entries,
    totals,
  };
  const canonicalBytes = enc.encode(canonicalJson(index));
  if (canonicalBytes.byteLength > MAX_COVERAGE_BYTES) {
    invalid("$", `closed coverage index exceeds the explicit ${MAX_COVERAGE_BYTES}-byte storage envelope`);
  }
  return {
    index,
    canonicalBytes,
    contentSha256: await sha256Hex(canonicalBytes),
    workManifest,
  };
}

export async function validateVisualCoverageIndex(
  value: unknown,
  workManifestValue: VisualWorkManifest,
  expected: VisualCoverageExpected = {},
): Promise<VisualCoverageIndex> {
  const root = object(value, "$", [
    "schemaVersion",
    "kind",
    "runId",
    "planRevisionId",
    "visualWorkManifestSha256",
    "inference",
    "inferenceFingerprintSha256",
    "authorization",
    "authorizationFingerprintSha256",
    "finalizedAt",
    "entries",
    "totals",
  ]);
  literal(root.schemaVersion, VISUAL_COVERAGE_INDEX_SCHEMA_VERSION, "$.schemaVersion");
  literal(root.kind, "survey-qa-visual-coverage-index", "$.kind");
  const declaredRunId = boundedString(root.runId, "$.runId", 300);
  const declaredPlanRevisionId = boundedString(root.planRevisionId, "$.planRevisionId", 300);
  const declaredWorkSha256 = hash(root.visualWorkManifestSha256, "$.visualWorkManifestSha256");
  const declaredInference = normalizeInferenceFingerprint(root.inference, "$.inference");
  const declaredInferenceSha256 = hash(root.inferenceFingerprintSha256, "$.inferenceFingerprintSha256");
  const declaredAuthorization = normalizeAuthorization(root.authorization, "$.authorization");
  const declaredAuthorizationSha256 = hash(
    root.authorizationFingerprintSha256,
    "$.authorizationFingerprintSha256",
  );
  const finalizedAt = isoTimestamp(root.finalizedAt, "$.finalizedAt");
  const entriesRaw = arrayValue(root.entries, "$.entries", MAX_ITEMS);
  // Parse totals before rebuilding so malformed/unknown total fields fail independently.
  normalizeCoverageTotals(root.totals, "$.totals");

  const rebuilt = await prepareVisualCoverageIndex({
    workManifest: workManifestValue,
    visualWorkManifestSha256: declaredWorkSha256,
    inference: declaredInference,
    authorization: declaredAuthorization,
    finalizedAt,
    entries: entriesRaw,
  });
  if (declaredRunId !== rebuilt.index.runId) invalid("$.runId", "does not match the work manifest run identity");
  if (declaredPlanRevisionId !== rebuilt.index.planRevisionId) {
    invalid("$.planRevisionId", "does not match the work manifest plan revision");
  }
  if (declaredInferenceSha256 !== rebuilt.index.inferenceFingerprintSha256) {
    invalid("$.inferenceFingerprintSha256", "does not hash the declared provider/model configuration");
  }
  if (declaredAuthorizationSha256 !== rebuilt.index.authorizationFingerprintSha256) {
    invalid("$.authorizationFingerprintSha256", "does not hash the declared rollout authorization");
  }
  if (canonicalJson(value) !== canonicalJson(rebuilt.index)) {
    invalid("$", "entries, identities, or totals do not mechanically recompute from the closed denominator");
  }
  assertExpected(rebuilt.index, expected);
  return rebuilt.index;
}

/**
 * Verify the stored denominator and every successful artifact set, append the content-addressed
 * coverage object, then conditional-create the fixed pointer. No provider call exists here.
 */
export async function finalizeVisualCoverageIndex(
  bucket: R2Bucket,
  preparedValue: PreparedVisualCoverageIndex,
  options: { successfulDataManifest?: VisualCoverageArtifactRef | null } = {},
): Promise<FinalizedVisualCoverageIndex> {
  const prepared = await normalizePreparedCoverage(preparedValue);
  await verifyStoredWorkManifest(bucket, prepared);
  for (let index = 0; index < prepared.index.entries.length; index += 1) {
    const entry = prepared.index.entries[index]!;
    if (entry.disposition === "observed-stored") {
      if (entry.item.kind !== "epoch") invalid(`$.entries[${index}].item`, "success must bind an epoch");
      const workEpoch = prepared.workManifest.epochs.find(
        (epoch) =>
          epoch.walkOrdinal === entry.item.walkOrdinal && epoch.epochOrdinal === entry.item.epochOrdinal,
      );
      if (workEpoch === undefined) {
        throw new VisualCoverageCorruptionError(
          visualManifestKey(prepared.index.runId),
          `successful coverage row ${index} no longer binds a work-manifest epoch`,
        );
      }
      await verifySuccessfulEntry(
        bucket,
        entry,
        workEpoch,
        prepared.index.runId,
        prepared.index.inference,
        `$.entries[${index}]`,
      );
    }
  }

  const successfulDataManifest =
    options.successfulDataManifest === undefined || options.successfulDataManifest === null
      ? null
      : normalizeArtifactRef(options.successfulDataManifest, "$.successfulDataManifest");
  if (successfulDataManifest !== null) {
    const expectedKey = visualSuccessfulDataManifestKey(
      prepared.index.runId,
      successfulDataManifest.contentSha256,
    );
    if (successfulDataManifest.key !== expectedKey) {
      invalid("$.successfulDataManifest.key", "is not the content-addressed successful-data manifest key");
    }
    await readVerifiedBytes(bucket, successfulDataManifest, "$.successfulDataManifest", MAX_COVERAGE_BYTES);
  }

  const coverageKey = visualCoverageIndexKey(prepared.index.runId, prepared.contentSha256);
  const coverageWrite = await putBytesImmutable(bucket, coverageKey, prepared.canonicalBytes);
  const pointer: VisualCoveragePointer = {
    schemaVersion: VISUAL_COVERAGE_POINTER_SCHEMA_VERSION,
    kind: "survey-qa-visual-coverage-pointer",
    runId: prepared.index.runId,
    planRevisionId: prepared.index.planRevisionId,
    visualWorkManifestSha256: prepared.index.visualWorkManifestSha256,
    inferenceFingerprintSha256: prepared.index.inferenceFingerprintSha256,
    authorizationFingerprintSha256: prepared.index.authorizationFingerprintSha256,
    coverage: { key: coverageKey, contentSha256: prepared.contentSha256 },
    successfulDataManifest,
  };
  const pointerKey = visualCoveragePointerKey(prepared.index.runId);
  const pointerWrite = await putBytesImmutable(bucket, pointerKey, enc.encode(canonicalJson(pointer)));
  return {
    coverageWrite,
    pointerWrite,
    coverageKey,
    pointerKey,
    coverageSha256: prepared.contentSha256,
    pointer,
  };
}

export async function readVisualCoverageIndex(
  bucket: R2Bucket,
  runIdValue: string,
  contentSha256Value: string,
  workManifest: VisualWorkManifest,
  expected: VisualCoverageExpected = {},
): Promise<VisualCoverageIndex | null> {
  const runId = keySegment(runIdValue, "runId");
  const contentSha256 = hash(contentSha256Value, "contentSha256");
  const key = visualCoverageIndexKey(runId, contentSha256);
  const bytes = await readObjectBytes(bucket, key, MAX_WORK_MANIFEST_BYTES);
  if (bytes === null) return null;
  if ((await sha256Hex(bytes)) !== contentSha256) {
    throw new VisualCoverageCorruptionError(key, "stored bytes do not match the content-addressed key digest");
  }
  const parsed = parseCanonicalJson(bytes, key);
  try {
    return await validateVisualCoverageIndex(parsed, workManifest, { ...expected, runId });
  } catch (error) {
    throw new VisualCoverageCorruptionError(key, boundedError(error));
  }
}

export async function readVisualCoveragePointer(
  bucket: R2Bucket,
  runIdValue: string,
  expected: VisualCoverageExpected = {},
): Promise<VisualCoveragePointer | null> {
  const runId = keySegment(runIdValue, "runId");
  const key = visualCoveragePointerKey(runId);
  const bytes = await readObjectBytes(bucket, key, MAX_COVERAGE_BYTES);
  if (bytes === null) return null;
  const parsed = parseCanonicalJson(bytes, key);
  try {
    return normalizeCoveragePointer(parsed, { ...expected, runId });
  } catch (error) {
    throw new VisualCoverageCorruptionError(key, boundedError(error));
  }
}

export function computeVisualCoverageTotals(entries: readonly VisualCoverageEntry[]): VisualCoverageTotals {
  const dispositions = emptyDispositionTotals();
  for (const entry of entries) dispositions[entry.disposition] += 1;
  const successfulItems = dispositions["observed-stored"];
  return {
    denominatorItems: entries.length,
    epochItems: entries.filter((entry) => entry.item.kind === "epoch").length,
    eligibleEpochItems: entries.filter(
      (entry) => entry.item.kind === "epoch" && entry.item.eligibility === "eligible",
    ).length,
    ineligibleEpochItems: entries.filter(
      (entry) => entry.item.kind === "epoch" && entry.item.eligibility !== "eligible",
    ).length,
    unknownEpochWalkItems: entries.filter((entry) => entry.item.kind === "walk-epochs-unknown").length,
    noEpochWalkItems: entries.filter((entry) => entry.item.kind === "walk-no-epochs").length,
    successfulItems,
    limitationItems: entries.length - successfulItems,
    dispositions,
  };
}

function normalizeAndCloseEntries(
  values: readonly unknown[],
  denominator: readonly VisualCoverageDenominatorItem[],
  inferenceFingerprintSha256: string,
  authorizationFingerprintSha256: string,
  authorization: VisualCoverageAuthorization,
): VisualCoverageEntry[] {
  if (values.length > MAX_ITEMS) invalid("$.entries", `exceeds ${MAX_ITEMS} entries`);
  const expectedByKey = new Map<string, VisualCoverageDenominatorItem>();
  const expectedOrder: string[] = [];
  for (const expected of denominator) {
    const key = denominatorItemKey(expected);
    if (expectedByKey.has(key)) invalid("$.workManifest", `derives duplicate denominator identity ${key}`);
    expectedByKey.set(key, expected);
    expectedOrder.push(key);
  }

  const entries: VisualCoverageEntry[] = [];
  const seen = new Set<string>();
  const actualOrder: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const path = `$.entries[${index}]`;
    const entry = normalizeCoverageEntry(values[index], path);
    const key = denominatorItemKey(entry.item);
    if (seen.has(key)) invalid(`${path}.item`, `duplicates denominator identity ${key}`);
    seen.add(key);
    actualOrder.push(key);
    const expected = expectedByKey.get(key);
    if (expected === undefined) invalid(`${path}.item`, `is an extra denominator identity ${key}`);
    if (canonicalJson(entry.item) !== canonicalJson(expected)) {
      invalid(`${path}.item`, "does not exactly bind the corresponding visual work row and digest");
    }
    if (entry.inferenceFingerprintSha256 !== inferenceFingerprintSha256) {
      invalid(`${path}.inferenceFingerprintSha256`, "does not match the sealed provider/model configuration");
    }
    if (entry.authorizationFingerprintSha256 !== authorizationFingerprintSha256) {
      invalid(`${path}.authorizationFingerprintSha256`, "does not match the sealed rollout authorization");
    }
    assertDispositionCompatible(entry, expected, authorization, path);
    entries.push(entry);
  }
  const omitted = expectedOrder.filter((key) => !seen.has(key));
  if (omitted.length > 0) {
    invalid("$.entries", `omits ${omitted.length} denominator item(s), beginning with ${omitted[0]}`);
  }
  if (canonicalJson(actualOrder) !== canonicalJson(expectedOrder)) {
    invalid("$.entries", "must remain in deterministic walk/epoch ordinal order");
  }
  return entries;
}

function normalizeCoverageEntry(value: unknown, path: string): VisualCoverageEntry {
  const root = object(value, path, [
    "item",
    "inferenceFingerprintSha256",
    "authorizationFingerprintSha256",
    "disposition",
    "detail",
    "success",
  ]);
  const item = normalizeDenominatorItem(root.item, `${path}.item`);
  const inferenceFingerprintSha256 = hash(
    root.inferenceFingerprintSha256,
    `${path}.inferenceFingerprintSha256`,
  );
  const authorizationFingerprintSha256 = hash(
    root.authorizationFingerprintSha256,
    `${path}.authorizationFingerprintSha256`,
  );
  const disposition = oneOf(root.disposition, VISUAL_COVERAGE_DISPOSITIONS, `${path}.disposition`);
  const detail = root.detail === null ? null : boundedString(root.detail, `${path}.detail`, MAX_TEXT);
  const success = root.success === null ? null : normalizeSuccessRefs(root.success, `${path}.success`);
  if (disposition === "observed-stored") {
    if (success === null) invalid(`${path}.success`, "observed-stored requires all immutable artifact refs and hashes");
    if (detail !== null) invalid(`${path}.detail`, "must be null for observed-stored");
  } else {
    if (success !== null) invalid(`${path}.success`, "non-success dispositions cannot cite a successful artifact set");
    if (detail === null) invalid(`${path}.detail`, "must name the counted limitation");
  }
  return { item, inferenceFingerprintSha256, authorizationFingerprintSha256, disposition, detail, success };
}

function normalizeDenominatorItem(value: unknown, path: string): VisualCoverageDenominatorItem {
  const root = object(value, path, [
    "kind",
    "walkOrdinal",
    "pathId",
    "attemptId",
    "walkResolution",
    "epochKnowledge",
    "epochOrdinal",
    "epochId",
    "stepIndex",
    "slot",
    "scope",
    "eligibility",
    "workItemSha256",
  ]);
  const kind = oneOf(root.kind, ["walk-epochs-unknown", "walk-no-epochs", "epoch"] as const, `${path}.kind`);
  const walkOrdinal = nonnegativeInteger(root.walkOrdinal, `${path}.walkOrdinal`, MAX_ITEMS);
  const pathId = boundedString(root.pathId, `${path}.pathId`, 500);
  const attemptId = boundedString(root.attemptId, `${path}.attemptId`, 500);
  const workItemSha256 = hash(root.workItemSha256, `${path}.workItemSha256`);
  const walkResolution = oneOf(
    root.walkResolution,
    [
      "unresolved-index",
      "catalog-missing",
      "catalog-binding-mismatch",
      "artifact-unreadable",
      "artifact-corrupt",
      "artifact-identity-mismatch",
      "verified",
    ] as const,
    `${path}.walkResolution`,
  );
  if (kind !== "epoch") {
    literal(root.epochOrdinal, null, `${path}.epochOrdinal`);
    literal(root.epochId, null, `${path}.epochId`);
    literal(root.stepIndex, null, `${path}.stepIndex`);
    literal(root.slot, null, `${path}.slot`);
    literal(root.scope, null, `${path}.scope`);
    literal(root.eligibility, null, `${path}.eligibility`);
    const epochKnowledge = oneOf(root.epochKnowledge, ["known", "unknown"] as const, `${path}.epochKnowledge`);
    if (kind === "walk-epochs-unknown" && epochKnowledge !== "unknown") {
      invalid(`${path}.epochKnowledge`, "walk-epochs-unknown must stay unknown");
    }
    if (kind === "walk-no-epochs" && (epochKnowledge !== "known" || walkResolution !== "verified")) {
      invalid(path, "walk-no-epochs requires a verified walk with known coverage");
    }
    return {
      kind,
      walkOrdinal,
      pathId,
      attemptId,
      walkResolution,
      epochKnowledge,
      epochOrdinal: null,
      epochId: null,
      stepIndex: null,
      slot: null,
      scope: null,
      eligibility: null,
      workItemSha256,
    };
  }
  literal(walkResolution, "verified", `${path}.walkResolution`);
  literal(root.epochKnowledge, "known", `${path}.epochKnowledge`);
  return {
    kind: "epoch",
    walkOrdinal,
    pathId,
    attemptId,
    walkResolution: "verified",
    epochKnowledge: "known",
    epochOrdinal: nonnegativeInteger(root.epochOrdinal, `${path}.epochOrdinal`, MAX_ITEMS),
    epochId: boundedString(root.epochId, `${path}.epochId`, 500),
    stepIndex: nonnegativeInteger(root.stepIndex, `${path}.stepIndex`, 1_000_000),
    slot: boundedString(root.slot, `${path}.slot`, 200),
    scope: normalizeScope(root.scope, `${path}.scope`),
    eligibility: oneOf(root.eligibility, ["eligible", "ineligible", "ambiguous"] as const, `${path}.eligibility`),
    workItemSha256,
  };
}

function normalizeSuccessRefs(value: unknown, path: string): VisualCoverageSuccessRefs {
  const root = object(value, path, [
    "epochDigest",
    "inferenceDigest",
    "observation",
    "reconciliation",
    "grounded",
  ]);
  const epochDigest = hash(root.epochDigest, `${path}.epochDigest`);
  const inferenceDigest = hash(root.inferenceDigest, `${path}.inferenceDigest`);
  const observation = normalizeArtifactRef(root.observation, `${path}.observation`);
  const reconciliation = normalizeArtifactRef(root.reconciliation, `${path}.reconciliation`);
  const grounded = normalizeArtifactRef(root.grounded, `${path}.grounded`);
  const keys = [observation.key, reconciliation.key, grounded.key];
  if (new Set(keys).size !== keys.length) invalid(path, "observation, reconciliation, and grounded keys must differ");
  for (const [label, ref] of [
    ["observation", observation],
    ["reconciliation", reconciliation],
    ["grounded", grounded],
  ] as const) {
    if (ref.key.split("/").filter((segment) => segment === epochDigest).length !== 1) {
      invalid(`${path}.${label}.key`, "must contain the epoch digest as exactly one complete path segment");
    }
  }
  return { epochDigest, inferenceDigest, observation, reconciliation, grounded };
}

function assertDispositionCompatible(
  entry: VisualCoverageEntry,
  expected: VisualCoverageDenominatorItem,
  authorization: VisualCoverageAuthorization,
  path: string,
): void {
  let required: VisualCoverageDisposition | null = null;
  if (expected.kind === "walk-epochs-unknown") {
    required = expected.walkResolution === "verified" ? "input-ineligible" : "input-integrity-failed";
  } else if (expected.kind === "walk-no-epochs") {
    required = "input-ineligible";
  } else if (expected.eligibility !== "eligible") {
    required = "input-ineligible";
  } else if (authorization.state === "disabled") {
    required = "budget-not-authorized";
  } else if (authorization.state === "invalid") {
    required = "rollout-config-invalid";
  }
  if (required !== null && entry.disposition !== required) {
    invalid(`${path}.disposition`, `${expected.kind} mechanically requires ${required}`);
  }
  if (required === null && entry.disposition === "input-ineligible") {
    invalid(`${path}.disposition`, "a preparation-eligible epoch cannot be reclassified as input-ineligible");
  }
  if (entry.disposition === "observed-stored" && expected.kind !== "epoch") {
    invalid(`${path}.disposition`, "a walk placeholder cannot be a stored observation");
  }
}

function normalizeCoverageTotals(value: unknown, path: string): VisualCoverageTotals {
  const root = object(value, path, [
    "denominatorItems",
    "epochItems",
    "eligibleEpochItems",
    "ineligibleEpochItems",
    "unknownEpochWalkItems",
    "noEpochWalkItems",
    "successfulItems",
    "limitationItems",
    "dispositions",
  ]);
  const dispositionRoot = object(root.dispositions, `${path}.dispositions`, [...VISUAL_COVERAGE_DISPOSITIONS]);
  const dispositions = emptyDispositionTotals();
  for (const disposition of VISUAL_COVERAGE_DISPOSITIONS) {
    dispositions[disposition] = nonnegativeInteger(
      dispositionRoot[disposition],
      `${path}.dispositions.${disposition}`,
      MAX_ITEMS,
    );
  }
  return {
    denominatorItems: nonnegativeInteger(root.denominatorItems, `${path}.denominatorItems`, MAX_ITEMS),
    epochItems: nonnegativeInteger(root.epochItems, `${path}.epochItems`, MAX_ITEMS),
    eligibleEpochItems: nonnegativeInteger(root.eligibleEpochItems, `${path}.eligibleEpochItems`, MAX_ITEMS),
    ineligibleEpochItems: nonnegativeInteger(root.ineligibleEpochItems, `${path}.ineligibleEpochItems`, MAX_ITEMS),
    unknownEpochWalkItems: nonnegativeInteger(root.unknownEpochWalkItems, `${path}.unknownEpochWalkItems`, MAX_ITEMS),
    noEpochWalkItems: nonnegativeInteger(root.noEpochWalkItems, `${path}.noEpochWalkItems`, MAX_ITEMS),
    successfulItems: nonnegativeInteger(root.successfulItems, `${path}.successfulItems`, MAX_ITEMS),
    limitationItems: nonnegativeInteger(root.limitationItems, `${path}.limitationItems`, MAX_ITEMS),
    dispositions,
  };
}

function emptyDispositionTotals(): VisualCoverageDispositionTotals {
  return {
    "observed-stored": 0,
    "input-ineligible": 0,
    "input-integrity-failed": 0,
    "provider-unavailable": 0,
    "provider-malformed": 0,
    "persistence-failed": 0,
    "purchase-blocked": 0,
    "accounting-failed": 0,
    "rollout-config-invalid": 0,
    "budget-not-authorized": 0,
    "wave-limit-uncovered": 0,
  };
}

function denominatorItemKey(item: VisualCoverageDenominatorItem): string {
  return item.kind === "epoch"
    ? `walk:${item.walkOrdinal}:epoch:${item.epochOrdinal}`
    : `walk:${item.walkOrdinal}:${item.kind}`;
}

async function normalizePreparedCoverage(value: unknown): Promise<PreparedVisualCoverageIndex> {
  const root = object(value, "$preparedCoverage", ["index", "canonicalBytes", "contentSha256", "workManifest"]);
  const workManifest = await validateVisualWorkManifest(root.workManifest);
  const index = await validateVisualCoverageIndex(root.index, workManifest);
  if (!(root.canonicalBytes instanceof Uint8Array)) {
    invalid("$preparedCoverage.canonicalBytes", "must be Uint8Array");
  }
  const canonicalBytes = enc.encode(canonicalJson(index));
  if (!equalBytes(root.canonicalBytes, canonicalBytes)) {
    invalid("$preparedCoverage.canonicalBytes", "does not exactly encode the normalized coverage index");
  }
  const contentSha256 = hash(root.contentSha256, "$preparedCoverage.contentSha256");
  if ((await sha256Hex(canonicalBytes)) !== contentSha256) {
    invalid("$preparedCoverage.contentSha256", "does not hash the canonical coverage bytes");
  }
  const rebuilt = await prepareVisualCoverageIndex({
    workManifest,
    visualWorkManifestSha256: index.visualWorkManifestSha256,
    inference: index.inference,
    authorization: index.authorization,
    finalizedAt: index.finalizedAt,
    entries: index.entries,
  });
  if (rebuilt.contentSha256 !== contentSha256 || canonicalJson(rebuilt.index) !== canonicalJson(index)) {
    invalid("$preparedCoverage", "does not mechanically rebuild from its denominator and entries");
  }
  return { index, canonicalBytes, contentSha256, workManifest };
}

async function verifyStoredWorkManifest(
  bucket: R2Bucket,
  prepared: PreparedVisualCoverageIndex,
): Promise<void> {
  const key = visualManifestKey(prepared.index.runId);
  const bytes = await readObjectBytes(bucket, key, MAX_COVERAGE_BYTES);
  if (bytes === null) throw new VisualCoverageCorruptionError(key, "the bound visual work manifest is absent");
  if ((await sha256Hex(bytes)) !== prepared.index.visualWorkManifestSha256) {
    throw new VisualCoverageCorruptionError(key, "bytes do not match visualWorkManifestSha256");
  }
  const parsed = parseCanonicalJson(bytes, key);
  let stored: VisualWorkManifest;
  try {
    stored = await validateVisualWorkManifest(parsed, {
      runId: prepared.index.runId,
      planRevisionId: prepared.index.planRevisionId,
    });
  } catch (error) {
    throw new VisualCoverageCorruptionError(key, boundedError(error));
  }
  if (canonicalJson(stored) !== canonicalJson(prepared.workManifest)) {
    throw new VisualCoverageCorruptionError(key, "stored denominator differs from the prepared denominator");
  }
}

async function verifySuccessfulEntry(
  bucket: R2Bucket,
  entry: VisualCoverageEntry,
  workEpoch: VisualWorkEpochRow,
  runId: string,
  inference: VisualInferenceFingerprint,
  path: string,
): Promise<void> {
  const success = entry.success;
  if (success === null || entry.item.kind !== "epoch") {
    invalid(`${path}.success`, "observed-stored requires one epoch and its complete artifact set");
  }
  try {
    for (const [label, ref] of [
      ["observation", success.observation],
      ["reconciliation", success.reconciliation],
      ["grounded", success.grounded],
    ] as const) {
      const segments = ref.key.split("/");
      if (
        segments.length < 5 ||
        segments[0] !== "v2" ||
        segments[1] !== "runs" ||
        segments[2] !== runId
      ) {
        invalid(`${path}.success.${label}.key`, "is not a canonical run-scoped v2 visual artifact key");
      }
      if (segments[3] !== "visual") {
        invalid(`${path}.success.${label}.key`, "must remain under the v2 run's visual namespace");
      }
    }

    const [observationBytes, reconciliationBytes, groundedBytes] = await Promise.all([
      readVerifiedBytes(bucket, success.observation, `${path}.success.observation`, MAX_ARTIFACT_BYTES),
      readVerifiedBytes(bucket, success.reconciliation, `${path}.success.reconciliation`, MAX_ARTIFACT_BYTES),
      readVerifiedBytes(bucket, success.grounded, `${path}.success.grounded`, MAX_ARTIFACT_BYTES),
    ]);
    const observationParsed = parseCanonicalJson(observationBytes, success.observation.key);
    const reconciliationParsed = parseCanonicalJson(reconciliationBytes, success.reconciliation.key);
    const groundedParsed = parseCanonicalJson(groundedBytes, success.grounded.key);

    const observation = await normalizeVisualObservationArtifact(observationParsed);
    const reconciliation = normalizeOptionMembershipReconciliation(reconciliationParsed, observation);
    const groundedRoot = object(groundedParsed, "$grounded", [
      "schemaVersion",
      "kind",
      "finalizedAt",
      "epochDigest",
      "inferenceDigest",
      "observationContentSha256",
      "reconciliationContentSha256",
      "observation",
      "reconciliation",
      "counts",
    ]);
    const groundedObservation = await normalizeVisualObservationArtifact(groundedRoot.observation);
    const groundedReconciliation = normalizeOptionMembershipReconciliation(
      groundedRoot.reconciliation,
      groundedObservation,
    );
    const rebuiltGrounded = await createGroundedVisualEpochResult({
      finalizedAt: isoTimestamp(groundedRoot.finalizedAt, "$grounded.finalizedAt"),
      observation: groundedObservation,
      reconciliation: groundedReconciliation,
    });
    if (canonicalJson(groundedParsed) !== canonicalJson(rebuiltGrounded)) {
      invalid(`${path}.success.grounded`, "does not mechanically rebuild as a closed grounded epoch");
    }
    if (canonicalJson(observation) !== canonicalJson(groundedObservation)) {
      invalid(`${path}.success.observation`, "does not match the observation embedded by the grounded epoch");
    }
    if (canonicalJson(reconciliation) !== canonicalJson(groundedReconciliation)) {
      invalid(
        `${path}.success.reconciliation`,
        "does not match the reconciliation embedded by the grounded epoch",
      );
    }
    if (
      success.epochDigest !== rebuiltGrounded.epochDigest ||
      success.inferenceDigest !== rebuiltGrounded.inferenceDigest
    ) {
      invalid(`${path}.success`, "epoch or inference digest does not match the grounded artifact");
    }
    if (
      success.observation.contentSha256 !== rebuiltGrounded.observationContentSha256 ||
      success.reconciliation.contentSha256 !== rebuiltGrounded.reconciliationContentSha256
    ) {
      invalid(`${path}.success`, "standalone observation/reconciliation hashes do not bind the grounded artifact");
    }
    if (observation.readState !== "observed" || observation.provenance.call === null) {
      invalid(`${path}.success.observation`, "observed-stored requires a settled observed read with call provenance");
    }
    if (
      observation.limitations.some(
        (limitation) => limitation.kind === "model-inventory-empty-despite-paired-content",
      )
    ) {
      invalid(
        `${path}.success.observation`,
        "observed-stored cannot claim model-inventory-empty-despite-paired-content as successful visual coverage",
      );
    }
    assertObservationIdentity(observation, entry.item, workEpoch, runId, inference, path);
  } catch (error) {
    if (error instanceof VisualCoverageCorruptionError) throw error;
    throw new VisualCoverageCorruptionError(success.grounded.key, boundedError(error));
  }
}

function assertObservationIdentity(
  observation: VisualObservationArtifact,
  item: Extract<VisualCoverageDenominatorItem, { kind: "epoch" }>,
  workEpoch: VisualWorkEpochRow,
  runId: string,
  inference: VisualInferenceFingerprint,
  path: string,
): void {
  const capture = observation.input.capture;
  if (
    capture.runId !== runId ||
    capture.pathId !== item.pathId ||
    capture.attemptId !== item.attemptId ||
    capture.epochId !== item.epochId ||
    capture.stepIndex !== item.stepIndex ||
    capture.slot !== item.slot ||
    canonicalJson(capture.scope) !== canonicalJson(item.scope)
  ) {
    invalid(`${path}.success.observation.input.capture`, "does not bind the denominator epoch identity");
  }
  if (
    workEpoch.screenshot.status !== "captured" ||
    observation.input.screenshotEvidenceId !== workEpoch.screenshot.ref.evidenceId ||
    observation.input.screenshotSha256 !== workEpoch.screenshot.ref.contentHash
  ) {
    invalid(`${path}.success.observation.input`, "does not bind the work-manifest screenshot evidence");
  }
  if (workEpoch.screen.status === "captured") {
    if (
      observation.input.screen.state !== "captured" ||
      observation.input.screen.evidenceId !== workEpoch.screen.ref.evidenceId ||
      observation.input.screen.contentSha256 !== workEpoch.screen.ref.contentHash
    ) {
      invalid(`${path}.success.observation.input.screen`, "does not bind the work-manifest screen evidence");
    }
  } else if (
    observation.input.screen.state !== "unavailable" ||
    canonicalJson(observation.input.screen.failure) !== canonicalJson(projectCaptureFailure(workEpoch.screen.failure))
  ) {
    invalid(`${path}.success.observation.input.screen`, "does not bind the named work-manifest screen failure");
  }
  if (workEpoch.accessibility.status === "captured") {
    if (
      observation.input.accessibility.state !== "captured" ||
      observation.input.accessibility.evidenceId !== workEpoch.accessibility.ref.evidenceId ||
      observation.input.accessibility.contentSha256 !== workEpoch.accessibility.ref.contentHash
    ) {
      invalid(`${path}.success.observation.input.accessibility`, "does not bind the work-manifest accessibility evidence");
    }
  } else if (
    observation.input.accessibility.state !== "unavailable" ||
    canonicalJson(observation.input.accessibility.failure) !==
      canonicalJson(projectCaptureFailure(workEpoch.accessibility.failure))
  ) {
    invalid(
      `${path}.success.observation.input.accessibility`,
      "does not bind the named work-manifest accessibility failure",
    );
  }
  const geometry = observation.input.geometry;
  if (
    geometry.viewportCssWidth !== workEpoch.geometry.width ||
    geometry.viewportCssHeight !== workEpoch.geometry.height ||
    geometry.deviceScaleFactor !== workEpoch.geometry.deviceScaleFactor ||
    geometry.scrollX !== workEpoch.geometry.scrollX ||
    geometry.scrollY !== workEpoch.geometry.scrollY ||
    geometry.source !== workEpoch.geometry.source
  ) {
    invalid(`${path}.success.observation.input.geometry`, "does not bind the work-manifest capture geometry");
  }
  const provenance = observation.provenance;
  if (
    provenance.model.provider !== inference.provider ||
    provenance.model.requestedModel !== inference.model ||
    provenance.model.transport !== inference.transport ||
    provenance.model.configurationSha256 !== inference.configurationSha256 ||
    canonicalJson(provenance.prompt) !== canonicalJson(inference.prompt) ||
    canonicalJson(provenance.responseSchema) !== canonicalJson(inference.responseSchema)
  ) {
    invalid(`${path}.success.observation.provenance`, "does not match the sealed inference fingerprint");
  }
  if (provenance.model.reportedModel !== null && provenance.model.reportedModel !== inference.model) {
    invalid(`${path}.success.observation.provenance.model.reportedModel`, "does not match the sealed model");
  }
}

function projectCaptureFailure(failure: {
  kind: string;
  detail: string;
  count: number;
}): { kind: string; detail: string; count: number } {
  return { kind: failure.kind, count: failure.count, detail: failure.detail };
}

function normalizeCoveragePointer(value: unknown, expected: VisualCoverageExpected): VisualCoveragePointer {
  const root = object(value, "$pointer", [
    "schemaVersion",
    "kind",
    "runId",
    "planRevisionId",
    "visualWorkManifestSha256",
    "inferenceFingerprintSha256",
    "authorizationFingerprintSha256",
    "coverage",
    "successfulDataManifest",
  ]);
  literal(root.schemaVersion, VISUAL_COVERAGE_POINTER_SCHEMA_VERSION, "$pointer.schemaVersion");
  literal(root.kind, "survey-qa-visual-coverage-pointer", "$pointer.kind");
  const runId = keySegment(root.runId, "$pointer.runId");
  const planRevisionId = boundedString(root.planRevisionId, "$pointer.planRevisionId", 300);
  const visualWorkManifestSha256 = hash(
    root.visualWorkManifestSha256,
    "$pointer.visualWorkManifestSha256",
  );
  const inferenceFingerprintSha256 = hash(
    root.inferenceFingerprintSha256,
    "$pointer.inferenceFingerprintSha256",
  );
  const authorizationFingerprintSha256 = hash(
    root.authorizationFingerprintSha256,
    "$pointer.authorizationFingerprintSha256",
  );
  const coverage = normalizeArtifactRef(root.coverage, "$pointer.coverage");
  if (coverage.key !== visualCoverageIndexKey(runId, coverage.contentSha256)) {
    invalid("$pointer.coverage.key", "is not the content-addressed coverage index key");
  }
  const successfulDataManifest =
    root.successfulDataManifest === null
      ? null
      : normalizeArtifactRef(root.successfulDataManifest, "$pointer.successfulDataManifest");
  if (
    successfulDataManifest !== null &&
    successfulDataManifest.key !== visualSuccessfulDataManifestKey(runId, successfulDataManifest.contentSha256)
  ) {
    invalid("$pointer.successfulDataManifest.key", "is not the content-addressed successful-data key");
  }
  const pointer: VisualCoveragePointer = {
    schemaVersion: VISUAL_COVERAGE_POINTER_SCHEMA_VERSION,
    kind: "survey-qa-visual-coverage-pointer",
    runId,
    planRevisionId,
    visualWorkManifestSha256,
    inferenceFingerprintSha256,
    authorizationFingerprintSha256,
    coverage,
    successfulDataManifest,
  };
  assertExpected(pointer, expected);
  return pointer;
}

function normalizeInferenceFingerprint(value: unknown, path: string): VisualInferenceFingerprint {
  const root = object(value, path, [
    "provider",
    "model",
    "transport",
    "configurationSha256",
    "prompt",
    "responseSchema",
  ]);
  return {
    provider: boundedString(root.provider, `${path}.provider`, 300),
    model: boundedString(root.model, `${path}.model`, 500),
    transport: boundedString(root.transport, `${path}.transport`, 300),
    configurationSha256: hash(root.configurationSha256, `${path}.configurationSha256`),
    prompt: normalizeVersionHash(root.prompt, `${path}.prompt`),
    responseSchema: normalizeVersionHash(root.responseSchema, `${path}.responseSchema`),
  };
}

function normalizeAuthorization(value: unknown, path: string): VisualCoverageAuthorization {
  const root = object(value, path, [
    "state",
    "rolloutConfigurationSha256",
    "maximumVisualCalls",
    "maximumVisualUsd",
  ]);
  const state = oneOf(root.state, ["disabled", "invalid", "authorized"] as const, `${path}.state`);
  const rolloutConfigurationSha256 = hash(
    root.rolloutConfigurationSha256,
    `${path}.rolloutConfigurationSha256`,
  );
  const maximumVisualCalls = nonnegativeInteger(
    root.maximumVisualCalls,
    `${path}.maximumVisualCalls`,
    10_000_000,
  );
  const maximumVisualUsd = nonnegativeFinite(root.maximumVisualUsd, `${path}.maximumVisualUsd`, 1_000_000);
  if (state !== "authorized" && (maximumVisualCalls !== 0 || maximumVisualUsd !== 0)) {
    invalid(path, `${state} rollout authorization requires exact zero effective call and USD caps`);
  }
  if (state === "authorized" && maximumVisualCalls === 0) {
    invalid(`${path}.maximumVisualCalls`, "authorized rollout requires a positive call cap");
  }
  return { state, rolloutConfigurationSha256, maximumVisualCalls, maximumVisualUsd };
}

function assertAuthorizationInferencePair(
  authorization: VisualCoverageAuthorization,
  inference: VisualInferenceFingerprint,
): void {
  const disabledInference =
    inference.provider === DISABLED_VISUAL_PROVIDER &&
    inference.model === DISABLED_VISUAL_MODEL &&
    inference.transport === DISABLED_VISUAL_TRANSPORT;
  const usesAnyDisabledSentinelPart =
    inference.provider === DISABLED_VISUAL_PROVIDER ||
    inference.model === DISABLED_VISUAL_MODEL ||
    inference.transport === DISABLED_VISUAL_TRANSPORT;
  if (usesAnyDisabledSentinelPart && !disabledInference) {
    invalid("$.inference", "the disabled inference sentinel must be used as one complete identity");
  }
  if (authorization.state !== "authorized" && !disabledInference) {
    invalid("$.inference", `${authorization.state} rollout authorization requires the closed not-authorized sentinel`);
  }
  if (authorization.state === "authorized" && disabledInference) {
    invalid("$.inference", "authorized rollout cannot use the not-authorized sentinel");
  }
}

function normalizeVersionHash(value: unknown, path: string): { version: string; sha256: string } {
  const root = object(value, path, ["version", "sha256"]);
  return {
    version: boundedString(root.version, `${path}.version`, 300),
    sha256: hash(root.sha256, `${path}.sha256`),
  };
}

function normalizeArtifactRef(value: unknown, path: string): VisualCoverageArtifactRef {
  const root = object(value, path, ["key", "contentSha256"]);
  return {
    key: storageKey(root.key, `${path}.key`),
    contentSha256: hash(root.contentSha256, `${path}.contentSha256`),
  };
}

function normalizeScope(value: unknown, path: string): ScreenshotScope {
  const root = object(value, path, ["kind", "tileIndex", "tileCount"]);
  const kind = oneOf(root.kind, ["viewport", "tile"] as const, `${path}.kind`);
  if (kind === "viewport") {
    literal(root.tileIndex, null, `${path}.tileIndex`);
    literal(root.tileCount, null, `${path}.tileCount`);
    return { kind, tileIndex: null, tileCount: null };
  }
  const tileIndex = nonnegativeInteger(root.tileIndex, `${path}.tileIndex`, 1_000_000);
  const tileCount = positiveInteger(root.tileCount, `${path}.tileCount`, 1_000_000);
  if (tileIndex >= tileCount) invalid(`${path}.tileIndex`, "must be lower than tileCount");
  return { kind, tileIndex, tileCount };
}

async function readVerifiedBytes(
  bucket: R2Bucket,
  ref: VisualCoverageArtifactRef,
  path: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const bytes = await readObjectBytes(bucket, ref.key, maxBytes);
  if (bytes === null) throw new VisualCoverageCorruptionError(ref.key, `${path} is absent`);
  if ((await sha256Hex(bytes)) !== ref.contentSha256) {
    throw new VisualCoverageCorruptionError(ref.key, `${path} bytes do not match contentSha256`);
  }
  return bytes;
}

async function readObjectBytes(bucket: R2Bucket, key: string, maxBytes: number): Promise<Uint8Array | null> {
  assertV2Key(key);
  const stored = await bucket.get(key);
  if (stored === null) return null;
  if (!Number.isFinite(stored.size) || stored.size < 0 || stored.size > maxBytes) {
    throw new VisualCoverageCorruptionError(key, "stored size is outside the bounded artifact envelope");
  }
  const bytes = new Uint8Array(await stored.arrayBuffer());
  if (bytes.byteLength !== stored.size) {
    throw new VisualCoverageCorruptionError(key, "declared and read byte sizes differ");
  }
  return bytes;
}

async function putBytesImmutable(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
): Promise<"stored" | "reused"> {
  assertV2Key(key);
  if (bytes.byteLength > MAX_COVERAGE_BYTES) invalid("$", "visual coverage object exceeds its storage envelope");
  const written = await bucket.put(key, bytes, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written !== null) return "stored";
  const existing = await readObjectBytes(bucket, key, MAX_COVERAGE_BYTES);
  if (existing !== null && equalBytes(existing, bytes)) return "reused";
  throw new VisualCoverageImmutabilityError(key);
}

function parseCanonicalJson(bytes: Uint8Array, key: string): unknown {
  let decoded: string;
  let parsed: unknown;
  try {
    decoded = fatalUtf8.decode(bytes);
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new VisualCoverageCorruptionError(key, "bytes are not strict UTF-8 JSON");
  }
  try {
    if (canonicalJson(parsed) !== decoded) {
      throw new VisualCoverageCorruptionError(key, "bytes are not the canonical closed encoding");
    }
  } catch (error) {
    if (error instanceof VisualCoverageCorruptionError) throw error;
    throw new VisualCoverageCorruptionError(key, "JSON cannot be canonically encoded");
  }
  return parsed;
}

function assertExpected(
  value: Pick<
    VisualCoverageIndex | VisualCoveragePointer,
    | "runId"
    | "planRevisionId"
    | "visualWorkManifestSha256"
    | "inferenceFingerprintSha256"
    | "authorizationFingerprintSha256"
  >,
  expected: VisualCoverageExpected,
): void {
  if (expected.runId !== undefined && value.runId !== expected.runId) invalid("$.runId", "does not match expected runId");
  if (expected.planRevisionId !== undefined && value.planRevisionId !== expected.planRevisionId) {
    invalid("$.planRevisionId", "does not match expected planRevisionId");
  }
  if (
    expected.visualWorkManifestSha256 !== undefined &&
    value.visualWorkManifestSha256 !== expected.visualWorkManifestSha256
  ) {
    invalid("$.visualWorkManifestSha256", "does not match expected denominator digest");
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
    invalid("$.authorizationFingerprintSha256", "does not match expected rollout authorization fingerprint");
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

function arrayValue(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) invalid(path, "must be an array");
  if (value.length > max) invalid(path, `exceeds ${max} items`);
  return value;
}

function oneOf<const T extends readonly (string | number)[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (!allowed.some((candidate) => candidate === value)) invalid(path, `must be one of ${allowed.join(", ")}`);
  return value as T[number];
}

function literal<T extends string | number | boolean | null>(
  value: unknown,
  expected: T,
  path: string,
): asserts value is T {
  if (value !== expected) invalid(path, `must be ${JSON.stringify(expected)}`);
}

function boundedString(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !wellFormed(value)) {
    invalid(path, `must be a non-empty, well-formed string of at most ${max} characters`);
  }
  if (value.normalize("NFC") !== value) invalid(path, "must be NFC-normalized");
  return value;
}

function keySegment(value: unknown, path: string): string {
  const segment = boundedString(value, path, MAX_SEGMENT_CHARS);
  if (segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || /[\u0000-\u001f\u007f]/u.test(segment)) {
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

function nonnegativeInteger(value: unknown, path: string, max: number): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0 || value > max) {
    invalid(path, `must be an integer in [0, ${max}]`);
  }
  return value;
}

function positiveInteger(value: unknown, path: string, max: number): number {
  const parsed = nonnegativeInteger(value, path, max);
  if (parsed === 0) invalid(path, "must be positive");
  return parsed;
}

function nonnegativeFinite(value: unknown, path: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    invalid(path, `must be a finite number in [0, ${max}]`);
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
  return wellFormed(message) ? message.slice(0, MAX_TEXT) : "invalid visual coverage artifact";
}

function invalid(path: string, detail: string): never {
  throw new VisualCoverageValidationError(path, detail);
}

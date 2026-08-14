/**
 * CLOSED, PRE-CALL VISUAL WORK DENOMINATOR.
 *
 * The execution walk index is the denominator. This module reconciles every indexed walk to
 * verified PathObservation bytes and records every capture epoch before a provider can be
 * called. Missing or unreadable artifacts therefore become counted unknowns; they can never
 * collapse into a persuasive-looking zero epochs.
 *
 * This is deliberately provider-free. It identifies captured inputs and eligibility, but does
 * not choose a model, resolve a secret, issue a request, or interpret screen content.
 * The modality references are authorization identities, not semantic evidence: a later paid
 * processor must re-read each exact screenshot/screen/AX catalog entry and re-hash its bytes
 * before use. Trusting the reference metadata alone would skip the evidence integrity boundary.
 */

import { assertV2Key } from "../keys";
import type {
  AccessibilityCapture,
  PdfCapture,
  ScreenArtifactRef,
  ScreenCaptureEpoch,
  ScreenCaptureFailure,
  ScreenCaptureGeometry,
  ScreenCaptureScope,
  ScreenshotCapture,
} from "../browser/types";
import { isPdfCaptureFailureKind } from "../browser/types";
import type { Env } from "../types/env";
import type { EvidenceCatalogEntry } from "../types/record";
import { getBoundCatalogEntry, getVerifiedEvidence } from "./evidence";
import { canonicalHash, canonicalJson } from "./hash";
import type {
  WalkArtifactBinding,
  WalkArtifactIndex,
  WalkArtifactIndexRow,
  WalkArtifactResolutionState,
} from "./walk-artifact-index";

const enc = new TextEncoder();
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const HASH = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_WALKS = 100_000;
const MAX_EPOCHS = 500_000;
const MAX_FAILURES = 1_000_000;
const MAX_TEXT = 4_000;

/**
 * Temporary unsharded orchestration envelope. Above this bound the system reports an explicit
 * capacity limitation before provider selection/purchase. It is not a survey convention; the
 * durable denominator must be sharded before this adapter limit can safely be raised.
 */
export const VISUAL_WORK_UNSHARDED_DENOMINATOR_LIMIT = 2_000;

export const VISUAL_WORK_MANIFEST_SCHEMA_VERSION = "survey-qa-visual-work-manifest/1.0.0" as const;

export type VisualWalkResolution =
  | "unresolved-index"
  | "catalog-missing"
  | "catalog-binding-mismatch"
  | "artifact-unreadable"
  | "artifact-corrupt"
  | "artifact-identity-mismatch"
  | "verified";

export type VisualEpochEligibility = "eligible" | "ineligible" | "ambiguous";

export type VisualWorkLimitationKind =
  | "walk-index-missing"
  | "walk-index-mismatched"
  | "walk-index-ambiguous"
  | "catalog-entry-missing"
  | "catalog-binding-mismatch"
  | "walk-artifact-unreadable"
  | "walk-artifact-corrupt"
  | "walk-artifact-identity-mismatch"
  | "legacy-screen-captures-absent"
  | "screen-captures-absent"
  | "inconsistent-declared-capture-counts"
  | "duplicate-epoch-identity"
  | "duplicate-cache-input-identity"
  | `capture-failure:${ScreenCaptureFailure["kind"]}`;

export interface VisualWorkWalkRow {
  walkOrdinal: number;
  pathId: string;
  attemptId: string;
  indexState: WalkArtifactResolutionState;
  walkIndexRowSha256: string;
  selected: WalkArtifactBinding | null;
  resolution: VisualWalkResolution;
  epochKnowledge: "known" | "unknown";
  epochCount: number | null;
}

export type VisualWorkScreenState =
  | { status: "captured"; ref: ScreenArtifactRef & { kind: "screen-json" } }
  | { status: "failed"; failure: ScreenCaptureFailure };

export interface VisualWorkEpochRow {
  walkOrdinal: number;
  pathId: string;
  attemptId: string;
  walkArtifact: WalkArtifactBinding;
  epochOrdinal: number;
  epochId: string;
  stepIndex: number;
  slot: string;
  scope: ScreenCaptureScope;
  startedAt: string;
  endedAt: string;
  screenReadAt: string;
  screenSignatureHash: string;
  geometry: ScreenCaptureGeometry;
  screen: VisualWorkScreenState;
  screenshot: ScreenshotCapture;
  accessibility: AccessibilityCapture;
  /**
   * Target-neutral identity of this exact paired capture; provider/model config is added later.
   * This does not attest the referenced bytes. A consumer must catalog-bind and re-hash all
   * modality evidence before interpreting or sending any of it.
   */
  cacheInputIdentity: string | null;
  eligibility: VisualEpochEligibility;
  ambiguityKinds: Array<"duplicate-epoch-identity" | "duplicate-cache-input-identity">;
  limitationKinds: VisualWorkLimitationKind[];
}

export interface VisualWorkLimitationRow {
  scope: "walk" | "epoch";
  walkOrdinal: number;
  epochOrdinal: number | null;
  kind: VisualWorkLimitationKind;
  count: number;
  detail: string;
}

export interface VisualWorkLimitationTotal {
  kind: VisualWorkLimitationKind;
  rows: number;
  occurrences: number;
}

export interface VisualWorkTotals {
  indexWalks: number;
  walksReconciled: number;
  uniquelyResolvedWalks: number;
  unresolvedWalks: number;
  verifiedArtifactWalks: number;
  epochsDiscovered: number;
  eligibleEpochs: number;
  ineligibleEpochs: number;
  ambiguousEpochs: number;
  unknownEpochWalks: number;
  limitationRows: number;
  limitationOccurrences: number;
  limitations: VisualWorkLimitationTotal[];
}

export interface VisualWorkManifest {
  schemaVersion: typeof VISUAL_WORK_MANIFEST_SCHEMA_VERSION;
  kind: "survey-qa-visual-work-manifest";
  runId: string;
  planRevisionId: string;
  walkArtifactIndexSha256: string;
  walks: VisualWorkWalkRow[];
  epochs: VisualWorkEpochRow[];
  limitations: VisualWorkLimitationRow[];
  totals: VisualWorkTotals;
}

export interface VisualWorkReadExpected {
  runId?: string;
  planRevisionId?: string;
  indexWalks?: number;
  walkArtifactIndexSha256?: string;
  index?: WalkArtifactIndex;
}

export class VisualWorkValidationError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "VisualWorkValidationError";
  }
}

export class VisualWorkImmutableError extends Error {
  constructor(readonly key: string) {
    super(`visual work manifest ${key} already exists with different bytes; immutable rewrite refused`);
    this.name = "VisualWorkImmutableError";
  }
}

export class VisualWorkCorruptError extends Error {
  constructor(readonly key: string, detail: string) {
    super(`visual work manifest ${key} is corrupt: ${detail}`);
    this.name = "VisualWorkCorruptError";
  }
}

export class VisualWorkCapacityExceededError extends Error {
  constructor(
    readonly observedLowerBound: number,
    readonly maximumDenominatorItems: number,
  ) {
    super(
      `visual work requires at least ${observedLowerBound} denominator items, above the ` +
        `unsharded capacity limit of ${maximumDenominatorItems}`,
    );
    this.name = "VisualWorkCapacityExceededError";
  }
}

interface ParsedPathObservation {
  runId: string;
  pathId: string;
  attemptId: string;
  planRevisionId: string;
  captureFieldPresent: boolean;
  epochs: ScreenCaptureEpoch[];
  /** Walk capture failures not already owned by one of the enumerated epochs. */
  walkCaptureFailures: ScreenCaptureFailure[];
  countIssues: string[];
}

/** Reconcile every strict index row. Individual bad artifacts are counted, not fatal to peers. */
export async function buildVisualWorkManifest(
  env: Env,
  index: WalkArtifactIndex,
  options: { maximumDenominatorItems?: number } = {},
): Promise<VisualWorkManifest> {
  if (!index || index.kind !== "survey-qa-walk-artifact-index") {
    invalid("$.index", "must be a validated walk artifact index");
  }
  if (index.rows.length > MAX_WALKS) invalid("$.index.rows", `exceeds ${MAX_WALKS} walks`);
  const maximumDenominatorItems =
    options.maximumDenominatorItems === undefined
      ? MAX_EPOCHS + MAX_WALKS
      : options.maximumDenominatorItems;
  if (
    !Number.isSafeInteger(maximumDenominatorItems) ||
    maximumDenominatorItems < 1 ||
    maximumDenominatorItems > MAX_EPOCHS + MAX_WALKS
  ) {
    invalid("$.options.maximumDenominatorItems", `must be an integer from 1 to ${MAX_EPOCHS + MAX_WALKS}`);
  }
  // Every indexed walk owns at least one denominator row, even when its epoch knowledge is
  // unknown or it is verified to have zero epochs.
  if (index.rows.length > maximumDenominatorItems) {
    throw new VisualWorkCapacityExceededError(index.rows.length, maximumDenominatorItems);
  }
  let denominatorItems = index.rows.length;

  const walkArtifactIndexSha256 = await canonicalHash(index);
  const walks: VisualWorkWalkRow[] = [];
  const epochs: VisualWorkEpochRow[] = [];
  const limitations: VisualWorkLimitationRow[] = [];

  for (const indexRow of index.rows) {
    const walkIndexRowSha256 = await canonicalHash(indexRow);
    const walk: VisualWorkWalkRow = {
      walkOrdinal: indexRow.walkOrdinal,
      pathId: indexRow.pathId,
      attemptId: indexRow.attemptId,
      indexState: indexRow.state,
      walkIndexRowSha256,
      selected: indexRow.selected,
      resolution: "unresolved-index",
      epochKnowledge: "unknown",
      epochCount: null,
    };
    walks.push(walk);

    if (!isUniquelySelected(indexRow)) {
      addWalkLimitation(limitations, indexRow.walkOrdinal, limitationForIndexState(indexRow.state));
      continue;
    }

    let catalogEntry: EvidenceCatalogEntry | null;
    try {
      catalogEntry = await getBoundCatalogEntry(env, index.runId, indexRow.selected.evidenceId);
    } catch {
      walk.resolution = "catalog-binding-mismatch";
      addWalkLimitation(limitations, indexRow.walkOrdinal, "catalog-binding-mismatch");
      continue;
    }
    if (catalogEntry === null) {
      walk.resolution = "catalog-missing";
      addWalkLimitation(limitations, indexRow.walkOrdinal, "catalog-entry-missing");
      continue;
    }
    let catalogBinding: WalkArtifactBinding;
    try {
      catalogBinding = bindingFromCatalog(catalogEntry);
    } catch {
      walk.resolution = "catalog-binding-mismatch";
      addWalkLimitation(limitations, indexRow.walkOrdinal, "catalog-binding-mismatch");
      continue;
    }
    if (canonicalJson(catalogBinding) !== canonicalJson(indexRow.selected)) {
      walk.resolution = "catalog-binding-mismatch";
      addWalkLimitation(limitations, indexRow.walkOrdinal, "catalog-binding-mismatch");
      continue;
    }

    let bytes: Uint8Array;
    try {
      ({ bytes } = await getVerifiedEvidence(env, catalogEntry));
    } catch {
      walk.resolution = "artifact-unreadable";
      addWalkLimitation(limitations, indexRow.walkOrdinal, "walk-artifact-unreadable");
      continue;
    }

    let parsed: ParsedPathObservation;
    try {
      parsed = parsePathObservation(bytes);
    } catch {
      walk.resolution = "artifact-corrupt";
      addWalkLimitation(limitations, indexRow.walkOrdinal, "walk-artifact-corrupt");
      continue;
    }
    if (
      parsed.runId !== index.runId ||
      parsed.pathId !== indexRow.pathId ||
      parsed.attemptId !== indexRow.attemptId ||
      parsed.planRevisionId !== index.planRevisionId
    ) {
      walk.resolution = "artifact-identity-mismatch";
      addWalkLimitation(limitations, indexRow.walkOrdinal, "walk-artifact-identity-mismatch");
      continue;
    }

    walk.resolution = "verified";
    if (!parsed.captureFieldPresent) {
      addWalkLimitation(
        limitations,
        indexRow.walkOrdinal,
        indexRow.state === "legacy" ? "legacy-screen-captures-absent" : "screen-captures-absent",
      );
      continue;
    }

    walk.epochKnowledge = "known";
    walk.epochCount = parsed.epochs.length;
    denominatorItems += Math.max(1, parsed.epochs.length) - 1;
    if (denominatorItems > maximumDenominatorItems) {
      throw new VisualWorkCapacityExceededError(denominatorItems, maximumDenominatorItems);
    }
    if (parsed.countIssues.length > 0) {
      addWalkLimitation(
        limitations,
        indexRow.walkOrdinal,
        "inconsistent-declared-capture-counts",
        parsed.countIssues.join(","),
      );
    }
    for (const failure of parsed.walkCaptureFailures) {
      limitations.push({
        scope: "walk",
        walkOrdinal: indexRow.walkOrdinal,
        epochOrdinal: null,
        kind: `capture-failure:${failure.kind}`,
        count: failure.count,
        detail: `step ${failure.stepIndex}, slot ${failure.slot}: ${failure.detail}`,
      });
    }
    for (let epochOrdinal = 0; epochOrdinal < parsed.epochs.length; epochOrdinal += 1) {
      if (epochs.length >= MAX_EPOCHS) invalid("$.epochs", `exceeds ${MAX_EPOCHS} capture epochs`);
      const epoch = parsed.epochs[epochOrdinal]!;
      const cacheInputIdentity =
        epoch.screenshot.status === "captured" ? await computeCaptureInputIdentity(epoch) : null;
      const row: VisualWorkEpochRow = {
        walkOrdinal: indexRow.walkOrdinal,
        pathId: indexRow.pathId,
        attemptId: indexRow.attemptId,
        walkArtifact: indexRow.selected,
        epochOrdinal,
        epochId: epoch.epochId,
        stepIndex: epoch.stepIndex,
        slot: epoch.slot,
        scope: epoch.scope,
        startedAt: epoch.startedAt,
        endedAt: epoch.endedAt,
        screenReadAt: epoch.screenReadAt,
        screenSignatureHash: epoch.screenSignatureHash,
        geometry: epoch.geometry,
        screen: { status: "captured", ref: epoch.screenJson },
        screenshot: epoch.screenshot,
        accessibility: epoch.accessibility,
        cacheInputIdentity,
        eligibility: epoch.screenshot.status === "captured" ? "eligible" : "ineligible",
        ambiguityKinds: [],
        limitationKinds: [],
      };
      appendCaptureFailureLimitations(row, epoch, limitations);
      epochs.push(row);
    }
  }

  markDuplicateIdentities(epochs, limitations);
  attachLimitationKinds(epochs, limitations);
  limitations.sort(compareLimitations);
  const manifest: VisualWorkManifest = {
    schemaVersion: VISUAL_WORK_MANIFEST_SCHEMA_VERSION,
    kind: "survey-qa-visual-work-manifest",
    runId: index.runId,
    planRevisionId: index.planRevisionId,
    walkArtifactIndexSha256,
    walks,
    epochs,
    limitations,
    totals: computeVisualWorkTotals(walks, epochs, limitations, index.totals.walks),
  };
  return validateVisualWorkManifest(manifest, { index });
}

/** Immutable and idempotent. */
export async function putVisualWorkManifest(
  bucket: R2Bucket,
  key: string,
  value: VisualWorkManifest,
  expected: VisualWorkReadExpected = {},
): Promise<"stored" | "reused"> {
  assertV2Key(key);
  const manifest = await validateVisualWorkManifest(value, expected);
  const bytes = enc.encode(canonicalJson(manifest));
  if (bytes.byteLength > MAX_MANIFEST_BYTES) invalid("$", "visual work manifest exceeds its byte cap");
  const written = await bucket.put(key, bytes, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written !== null) return "stored";
  const existing = await bucket.get(key);
  if (existing === null || existing.size > MAX_MANIFEST_BYTES) throw new VisualWorkImmutableError(key);
  const existingBytes = new Uint8Array(await existing.arrayBuffer());
  if (!equalBytes(existingBytes, bytes)) throw new VisualWorkImmutableError(key);
  return "reused";
}

export async function readVisualWorkManifest(
  bucket: R2Bucket,
  key: string,
  expected: VisualWorkReadExpected = {},
): Promise<VisualWorkManifest | null> {
  assertV2Key(key);
  const stored = await bucket.get(key);
  if (stored === null) return null;
  if (!Number.isFinite(stored.size) || stored.size < 0 || stored.size > MAX_MANIFEST_BYTES) {
    throw new VisualWorkCorruptError(key, "stored byte size is outside the bounded manifest envelope");
  }
  const bytes = new Uint8Array(await stored.arrayBuffer());
  if (bytes.byteLength !== stored.size) throw new VisualWorkCorruptError(key, "stored and read byte sizes differ");
  let decoded: string;
  let parsed: unknown;
  try {
    decoded = fatalUtf8.decode(bytes);
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new VisualWorkCorruptError(key, "bytes are not strict UTF-8 JSON");
  }
  let manifest: VisualWorkManifest;
  try {
    manifest = await validateVisualWorkManifest(parsed, expected);
  } catch (error) {
    throw new VisualWorkCorruptError(key, boundedError(error));
  }
  if (canonicalJson(manifest) !== decoded) {
    throw new VisualWorkCorruptError(key, "bytes are not the canonical closed encoding");
  }
  return manifest;
}

/** Strict, closed validation with every total and identity mechanically re-derived. */
export async function validateVisualWorkManifest(
  value: unknown,
  expected: VisualWorkReadExpected = {},
): Promise<VisualWorkManifest> {
  const root = object(value, "$", [
    "schemaVersion",
    "kind",
    "runId",
    "planRevisionId",
    "walkArtifactIndexSha256",
    "walks",
    "epochs",
    "limitations",
    "totals",
  ]);
  literal(root.schemaVersion, VISUAL_WORK_MANIFEST_SCHEMA_VERSION, "$.schemaVersion");
  literal(root.kind, "survey-qa-visual-work-manifest", "$.kind");
  const runId = nonempty(root.runId, "$.runId", 300);
  const planRevisionId = nonempty(root.planRevisionId, "$.planRevisionId", 300);
  const walkArtifactIndexSha256 = hash(root.walkArtifactIndexSha256, "$.walkArtifactIndexSha256");
  const walks = arrayValue(root.walks, "$.walks", MAX_WALKS).map(validateWalkRow);
  const epochs = arrayValue(root.epochs, "$.epochs", MAX_EPOCHS).map(validateEpochRow);
  const limitations = arrayValue(root.limitations, "$.limitations", MAX_FAILURES).map(validateLimitationRow);
  const totals = validateTotals(root.totals);
  const sortedLimitations = [...limitations].sort(compareLimitations);
  if (canonicalJson(limitations) !== canonicalJson(sortedLimitations)) {
    invalid("$.limitations", "must be deterministically sorted by scope and identity");
  }

  for (let index = 0; index < walks.length; index += 1) {
    if (walks[index]!.walkOrdinal !== index) {
      invalid(`$.walks[${index}].walkOrdinal`, "must be the consecutive execution-ledger ordinal");
    }
  }
  const epochsByWalk = new Map<number, VisualWorkEpochRow[]>();
  for (let index = 0; index < epochs.length; index += 1) {
    const epoch = epochs[index]!;
    const walk = walks[epoch.walkOrdinal];
    if (!walk) invalid(`$.epochs[${index}].walkOrdinal`, "does not identify a manifest walk row");
    if (epoch.pathId !== walk.pathId || epoch.attemptId !== walk.attemptId) {
      invalid(`$.epochs[${index}]`, "path/attempt identity does not match its walk row");
    }
    if (walk.resolution !== "verified" || walk.epochKnowledge !== "known") {
      invalid(`$.epochs[${index}]`, "an epoch may only belong to a verified walk with known epoch coverage");
    }
    if (walk.selected === null || canonicalJson(epoch.walkArtifact) !== canonicalJson(walk.selected)) {
      invalid(`$.epochs[${index}].walkArtifact`, "does not exactly bind the selected walk artifact");
    }
    const group = epochsByWalk.get(epoch.walkOrdinal) ?? [];
    if (epoch.epochOrdinal !== group.length) {
      invalid(`$.epochs[${index}].epochOrdinal`, "must be consecutive within the indexed walk");
    }
    group.push(epoch);
    epochsByWalk.set(epoch.walkOrdinal, group);
  }
  for (let index = 0; index < walks.length; index += 1) {
    const walk = walks[index]!;
    const discovered = epochsByWalk.get(index)?.length ?? 0;
    if (walk.epochKnowledge === "known" && walk.epochCount !== discovered) {
      invalid(`$.walks[${index}].epochCount`, `declares ${walk.epochCount} but ${discovered} epoch rows bind this walk`);
    }
    if (walk.epochKnowledge === "unknown" && discovered !== 0) {
      invalid(`$.walks[${index}].epochKnowledge`, "unknown coverage cannot carry inferred epoch rows");
    }
  }

  assertLimitationBindings(walks, epochs, limitations);
  const duplicateEpochIds = duplicateValues(epochs.map((row) => row.epochId));
  const duplicateInputs = duplicateValues(
    epochs.flatMap((row) => (row.cacheInputIdentity === null ? [] : [row.cacheInputIdentity])),
  );
  for (let index = 0; index < epochs.length; index += 1) {
    const row = epochs[index]!;
    const expectedIdentity = row.screenshot.status === "captured" ? await computeCaptureInputIdentity(row) : null;
    if (row.cacheInputIdentity !== expectedIdentity) {
      invalid(`$.epochs[${index}].cacheInputIdentity`, "does not recompute from the exact paired capture input");
    }
    const expectedAmbiguities: VisualWorkEpochRow["ambiguityKinds"] = [];
    if (duplicateEpochIds.has(row.epochId)) expectedAmbiguities.push("duplicate-epoch-identity");
    if (row.cacheInputIdentity !== null && duplicateInputs.has(row.cacheInputIdentity)) {
      expectedAmbiguities.push("duplicate-cache-input-identity");
    }
    expectedAmbiguities.sort();
    if (canonicalJson(row.ambiguityKinds) !== canonicalJson(expectedAmbiguities)) {
      invalid(`$.epochs[${index}].ambiguityKinds`, "does not recompute from all manifest epoch identities");
    }
    const expectedEligibility: VisualEpochEligibility =
      expectedAmbiguities.length > 0
        ? "ambiguous"
        : row.screenshot.status === "captured" && row.screenshot.ref.mediaType === "image/png"
          ? "eligible"
          : "ineligible";
    if (row.eligibility !== expectedEligibility) {
      invalid(`$.epochs[${index}].eligibility`, `must mechanically recompute to ${expectedEligibility}`);
    }
    const expectedKinds = limitationKindsForEpoch(row.walkOrdinal, row.epochOrdinal, limitations);
    if (canonicalJson(row.limitationKinds) !== canonicalJson(expectedKinds)) {
      invalid(`$.epochs[${index}].limitationKinds`, "does not recompute from counted limitation rows");
    }
  }

  const recomputed = computeVisualWorkTotals(walks, epochs, limitations, walks.length);
  assertTotals(totals, recomputed);
  if (expected.runId !== undefined && expected.runId !== runId) {
    invalid("$.runId", "does not match the requested run identity");
  }
  if (expected.planRevisionId !== undefined && expected.planRevisionId !== planRevisionId) {
    invalid("$.planRevisionId", "does not match the requested plan revision");
  }
  if (expected.indexWalks !== undefined && expected.indexWalks !== totals.indexWalks) {
    invalid("$.totals.indexWalks", "does not match the requested index denominator");
  }
  if (
    expected.walkArtifactIndexSha256 !== undefined &&
    expected.walkArtifactIndexSha256 !== walkArtifactIndexSha256
  ) {
    invalid("$.walkArtifactIndexSha256", "does not match the requested walk index digest");
  }
  if (expected.index !== undefined) {
    await assertExpectedIndex(expected.index, runId, planRevisionId, walkArtifactIndexSha256, walks);
  }

  return {
    schemaVersion: VISUAL_WORK_MANIFEST_SCHEMA_VERSION,
    kind: "survey-qa-visual-work-manifest",
    runId,
    planRevisionId,
    walkArtifactIndexSha256,
    walks,
    epochs,
    limitations,
    totals,
  };
}

export function computeVisualWorkTotals(
  walks: readonly VisualWorkWalkRow[],
  epochs: readonly VisualWorkEpochRow[],
  limitations: readonly VisualWorkLimitationRow[],
  indexWalks = walks.length,
): VisualWorkTotals {
  const limitationCounts = new Map<VisualWorkLimitationKind, { rows: number; occurrences: number }>();
  for (const limitation of limitations) {
    const current = limitationCounts.get(limitation.kind) ?? { rows: 0, occurrences: 0 };
    current.rows += 1;
    current.occurrences += limitation.count;
    limitationCounts.set(limitation.kind, current);
  }
  const limitationTotals = [...limitationCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, counts]) => ({ kind, ...counts }));
  return {
    indexWalks,
    walksReconciled: walks.length,
    uniquelyResolvedWalks: walks.filter((row) => row.indexState === "exact" || row.indexState === "legacy").length,
    unresolvedWalks: walks.filter((row) => row.indexState !== "exact" && row.indexState !== "legacy").length,
    verifiedArtifactWalks: walks.filter((row) => row.resolution === "verified").length,
    epochsDiscovered: epochs.length,
    eligibleEpochs: epochs.filter((row) => row.eligibility === "eligible").length,
    // Ambiguous rows are a named subset of ineligible work: no paid call may pick a first
    // occurrence. Keeping the subset separately must not break the closed denominator
    // `eligible + ineligible === discovered`.
    ineligibleEpochs: epochs.filter((row) => row.eligibility !== "eligible").length,
    ambiguousEpochs: epochs.filter((row) => row.eligibility === "ambiguous").length,
    unknownEpochWalks: walks.filter((row) => row.epochKnowledge === "unknown").length,
    limitationRows: limitations.length,
    limitationOccurrences: limitations.reduce((sum, row) => sum + row.count, 0),
    limitations: limitationTotals,
  };
}

async function assertExpectedIndex(
  index: WalkArtifactIndex,
  runId: string,
  planRevisionId: string,
  digest: string,
  walks: VisualWorkWalkRow[],
): Promise<void> {
  if (index.runId !== runId || index.planRevisionId !== planRevisionId) {
    invalid("$.walkArtifactIndexSha256", "supplied index identity does not match the manifest");
  }
  if ((await canonicalHash(index)) !== digest) {
    invalid("$.walkArtifactIndexSha256", "does not hash the supplied strict walk index");
  }
  if (index.rows.length !== walks.length || index.totals.walks !== walks.length) {
    invalid("$.walks", "does not reconcile every supplied index walk exactly once");
  }
  for (let i = 0; i < walks.length; i += 1) {
    const source = index.rows[i]!;
    const row = walks[i]!;
    if (
      row.walkIndexRowSha256 !== (await canonicalHash(source)) ||
      row.walkOrdinal !== source.walkOrdinal ||
      row.pathId !== source.pathId ||
      row.attemptId !== source.attemptId ||
      row.indexState !== source.state ||
      canonicalJson(row.selected) !== canonicalJson(source.selected)
    ) {
      invalid(`$.walks[${i}]`, "does not exactly bind the corresponding supplied index row");
    }
  }
}

function validateWalkRow(value: unknown, index: number): VisualWorkWalkRow {
  const path = `$.walks[${index}]`;
  const root = object(value, path, [
    "walkOrdinal",
    "pathId",
    "attemptId",
    "indexState",
    "walkIndexRowSha256",
    "selected",
    "resolution",
    "epochKnowledge",
    "epochCount",
  ]);
  const walkOrdinal = nonnegativeInteger(root.walkOrdinal, `${path}.walkOrdinal`, MAX_WALKS);
  const pathId = nonempty(root.pathId, `${path}.pathId`, 500);
  const attemptId = nonempty(root.attemptId, `${path}.attemptId`, 500);
  const indexState = oneOf(
    root.indexState,
    ["exact", "legacy", "missing", "mismatched", "ambiguous"] as const,
    `${path}.indexState`,
  );
  const walkIndexRowSha256 = hash(root.walkIndexRowSha256, `${path}.walkIndexRowSha256`);
  const selected =
    root.selected === null ? null : validateBinding(root.selected, `${path}.selected`, `EV-${pathId}-observation`);
  if (indexState === "exact") {
    if (selected === null || selected.attemptId !== attemptId) {
      invalid(`${path}.selected`, "an exact index row must select the same attempt");
    }
  } else if (indexState === "legacy") {
    if (selected === null || selected.attemptId !== null) {
      invalid(`${path}.selected`, "a legacy index row must select the sole unstamped artifact");
    }
  } else if (selected !== null) {
    invalid(`${path}.selected`, "an unresolved index state cannot carry a selected artifact");
  }
  const resolution = oneOf(
    root.resolution,
    [
      "unresolved-index",
      "catalog-missing",
      "catalog-binding-mismatch",
      "artifact-unreadable",
      "artifact-corrupt",
      "artifact-identity-mismatch",
      "verified",
    ] as const,
    `${path}.resolution`,
  );
  const unique = indexState === "exact" || indexState === "legacy";
  if ((resolution === "unresolved-index") !== !unique) {
    invalid(`${path}.resolution`, "must distinguish an unresolved index from a uniquely selected artifact");
  }
  if (unique && selected === null) invalid(`${path}.selected`, "unique resolution requires its exact catalog binding");
  const epochKnowledge = oneOf(root.epochKnowledge, ["known", "unknown"] as const, `${path}.epochKnowledge`);
  const epochCount =
    root.epochCount === null ? null : nonnegativeInteger(root.epochCount, `${path}.epochCount`, MAX_EPOCHS);
  if (epochKnowledge === "known") {
    if (resolution !== "verified" || epochCount === null) {
      invalid(`${path}.epochKnowledge`, "known epochs require a verified artifact and an explicit count");
    }
  } else if (epochCount !== null) {
    invalid(`${path}.epochCount`, "unknown epoch coverage must stay null, never an inferred zero");
  }
  if (resolution !== "verified" && epochKnowledge !== "unknown") {
    invalid(`${path}.epochKnowledge`, "an unverified artifact cannot attest an epoch count");
  }
  return {
    walkOrdinal,
    pathId,
    attemptId,
    indexState,
    walkIndexRowSha256,
    selected,
    resolution,
    epochKnowledge,
    epochCount,
  };
}

function validateEpochRow(value: unknown, index: number): VisualWorkEpochRow {
  const path = `$.epochs[${index}]`;
  const root = object(value, path, [
    "walkOrdinal",
    "pathId",
    "attemptId",
    "walkArtifact",
    "epochOrdinal",
    "epochId",
    "stepIndex",
    "slot",
    "scope",
    "startedAt",
    "endedAt",
    "screenReadAt",
    "screenSignatureHash",
    "geometry",
    "screen",
    "screenshot",
    "accessibility",
    "cacheInputIdentity",
    "eligibility",
    "ambiguityKinds",
    "limitationKinds",
  ]);
  const walkOrdinal = nonnegativeInteger(root.walkOrdinal, `${path}.walkOrdinal`, MAX_WALKS);
  const pathId = nonempty(root.pathId, `${path}.pathId`, 500);
  const attemptId = nonempty(root.attemptId, `${path}.attemptId`, 500);
  const walkArtifact = validateBinding(root.walkArtifact, `${path}.walkArtifact`, `EV-${pathId}-observation`);
  const epochOrdinal = nonnegativeInteger(root.epochOrdinal, `${path}.epochOrdinal`, MAX_EPOCHS);
  const epochId = nonempty(root.epochId, `${path}.epochId`, 500);
  const stepIndex = nonnegativeInteger(root.stepIndex, `${path}.stepIndex`, 1_000_000);
  const slot = nonempty(root.slot, `${path}.slot`, 200);
  const scope = validateScope(root.scope, `${path}.scope`);
  const startedAt = timestamp(root.startedAt, `${path}.startedAt`);
  const endedAt = timestamp(root.endedAt, `${path}.endedAt`);
  const screenReadAt = timestamp(root.screenReadAt, `${path}.screenReadAt`);
  const screenSignatureHash = hash(root.screenSignatureHash, `${path}.screenSignatureHash`);
  const geometry = validateGeometry(root.geometry, `${path}.geometry`);
  const screen = validateScreenState(root.screen, `${path}.screen`, stepIndex, slot);
  const screenshot = validateScreenshot(root.screenshot, `${path}.screenshot`, stepIndex, slot);
  const accessibility = validateAccessibility(root.accessibility, `${path}.accessibility`, stepIndex, slot);
  const cacheInputIdentity =
    root.cacheInputIdentity === null
      ? null
      : patterned(
          root.cacheInputIdentity,
          /^visual-capture-input\/sha256\/[0-9a-f]{64}$/,
          `${path}.cacheInputIdentity`,
        );
  const eligibility = oneOf(root.eligibility, ["eligible", "ineligible", "ambiguous"] as const, `${path}.eligibility`);
  const ambiguityKinds = normalizeStringEnumArray(
    root.ambiguityKinds,
    ["duplicate-epoch-identity", "duplicate-cache-input-identity"] as const,
    `${path}.ambiguityKinds`,
  );
  const limitationKinds = normalizeLimitationKinds(root.limitationKinds, `${path}.limitationKinds`);
  return {
    walkOrdinal,
    pathId,
    attemptId,
    walkArtifact,
    epochOrdinal,
    epochId,
    stepIndex,
    slot,
    scope,
    startedAt,
    endedAt,
    screenReadAt,
    screenSignatureHash,
    geometry,
    screen,
    screenshot,
    accessibility,
    cacheInputIdentity,
    eligibility,
    ambiguityKinds,
    limitationKinds,
  };
}

function validateLimitationRow(value: unknown, index: number): VisualWorkLimitationRow {
  const path = `$.limitations[${index}]`;
  const root = object(value, path, ["scope", "walkOrdinal", "epochOrdinal", "kind", "count", "detail"]);
  const scope = oneOf(root.scope, ["walk", "epoch"] as const, `${path}.scope`);
  const walkOrdinal = nonnegativeInteger(root.walkOrdinal, `${path}.walkOrdinal`, MAX_WALKS);
  const epochOrdinal =
    root.epochOrdinal === null ? null : nonnegativeInteger(root.epochOrdinal, `${path}.epochOrdinal`, MAX_EPOCHS);
  if ((scope === "walk") !== (epochOrdinal === null)) {
    invalid(`${path}.epochOrdinal`, "must be null for a walk limitation and present for an epoch limitation");
  }
  return {
    scope,
    walkOrdinal,
    epochOrdinal,
    kind: limitationKind(root.kind, `${path}.kind`),
    count: positiveInteger(root.count, `${path}.count`, 1_000_000),
    detail: nonempty(root.detail, `${path}.detail`, MAX_TEXT),
  };
}

function validateTotals(value: unknown): VisualWorkTotals {
  const root = object(value, "$.totals", [
    "indexWalks",
    "walksReconciled",
    "uniquelyResolvedWalks",
    "unresolvedWalks",
    "verifiedArtifactWalks",
    "epochsDiscovered",
    "eligibleEpochs",
    "ineligibleEpochs",
    "ambiguousEpochs",
    "unknownEpochWalks",
    "limitationRows",
    "limitationOccurrences",
    "limitations",
  ]);
  const limitations = arrayValue(root.limitations, "$.totals.limitations", MAX_FAILURES).map((value, index) => {
    const path = `$.totals.limitations[${index}]`;
    const row = object(value, path, ["kind", "rows", "occurrences"]);
    return {
      kind: limitationKind(row.kind, `${path}.kind`),
      rows: positiveInteger(row.rows, `${path}.rows`, MAX_FAILURES),
      occurrences: positiveInteger(row.occurrences, `${path}.occurrences`, Number.MAX_SAFE_INTEGER),
    };
  });
  const sorted = [...limitations].sort((a, b) => a.kind.localeCompare(b.kind));
  if (canonicalJson(limitations) !== canonicalJson(sorted)) {
    invalid("$.totals.limitations", "must be sorted by limitation kind");
  }
  ensureUnique(limitations.map((row) => row.kind), "$.totals.limitations", "limitation kind");
  return {
    indexWalks: nonnegativeInteger(root.indexWalks, "$.totals.indexWalks", MAX_WALKS),
    walksReconciled: nonnegativeInteger(root.walksReconciled, "$.totals.walksReconciled", MAX_WALKS),
    uniquelyResolvedWalks: nonnegativeInteger(
      root.uniquelyResolvedWalks,
      "$.totals.uniquelyResolvedWalks",
      MAX_WALKS,
    ),
    unresolvedWalks: nonnegativeInteger(root.unresolvedWalks, "$.totals.unresolvedWalks", MAX_WALKS),
    verifiedArtifactWalks: nonnegativeInteger(
      root.verifiedArtifactWalks,
      "$.totals.verifiedArtifactWalks",
      MAX_WALKS,
    ),
    epochsDiscovered: nonnegativeInteger(root.epochsDiscovered, "$.totals.epochsDiscovered", MAX_EPOCHS),
    eligibleEpochs: nonnegativeInteger(root.eligibleEpochs, "$.totals.eligibleEpochs", MAX_EPOCHS),
    ineligibleEpochs: nonnegativeInteger(root.ineligibleEpochs, "$.totals.ineligibleEpochs", MAX_EPOCHS),
    ambiguousEpochs: nonnegativeInteger(root.ambiguousEpochs, "$.totals.ambiguousEpochs", MAX_EPOCHS),
    unknownEpochWalks: nonnegativeInteger(root.unknownEpochWalks, "$.totals.unknownEpochWalks", MAX_WALKS),
    limitationRows: nonnegativeInteger(root.limitationRows, "$.totals.limitationRows", MAX_FAILURES),
    limitationOccurrences: nonnegativeInteger(
      root.limitationOccurrences,
      "$.totals.limitationOccurrences",
      Number.MAX_SAFE_INTEGER,
    ),
    limitations,
  };
}

function assertTotals(actual: VisualWorkTotals, expected: VisualWorkTotals): void {
  for (const key of Object.keys(expected) as Array<keyof VisualWorkTotals>) {
    if (canonicalJson(actual[key]) !== canonicalJson(expected[key])) {
      invalid(`$.totals.${key}`, "does not mechanically recompute from the manifest rows");
    }
  }
}

const PATH_OBSERVATION_KEYS = [
  "kind",
  "runId",
  "pathId",
  "tier",
  "attemptId",
  "planRevisionId",
  "surveyUrl",
  "startedAt",
  "endedAt",
  "wallMs",
  "plannedWitnesses",
  "steps",
  "outcome",
  "outcomeDetail",
  "ending",
  "shimmed",
  "shimNote",
  "loadFailure",
  "unboundDecisions",
  "bindingRefusalCount",
  "readerLimitations",
  "readerLimitationCount",
  "unfillableControls",
  "unfillableControlCount",
  "navigatorDefaultAnswerCount",
  "screenCaptures",
  "screenCaptureCount",
  "captureFailures",
  "captureFailureCount",
  "evidenceIds",
  "observationEvidenceId",
  "viewport",
] as const;

function parsePathObservation(bytes: Uint8Array): ParsedPathObservation {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) invalid("$artifact", "PathObservation exceeds its byte cap");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fatalUtf8.decode(bytes)) as unknown;
  } catch {
    invalid("$artifact", "bytes are not strict UTF-8 JSON");
  }
  const root = object(parsed, "$artifact", [...PATH_OBSERVATION_KEYS], [
    "kind",
    "runId",
    "pathId",
    "tier",
    "attemptId",
    "planRevisionId",
    "surveyUrl",
    "startedAt",
    "endedAt",
    "wallMs",
    "plannedWitnesses",
    "steps",
    "outcome",
    "outcomeDetail",
    "shimmed",
    "shimNote",
    "loadFailure",
    "evidenceIds",
    "viewport",
  ]);
  literal(root.kind, "v2-path-observation/1.0.0", "$artifact.kind");
  const runId = nonempty(root.runId, "$artifact.runId", 300);
  const pathId = nonempty(root.pathId, "$artifact.pathId", 500);
  oneOf(root.tier, [1, 2] as const, "$artifact.tier");
  const attemptId = nonempty(root.attemptId, "$artifact.attemptId", 500);
  const planRevisionId = nonempty(root.planRevisionId, "$artifact.planRevisionId", 300);
  nonempty(root.surveyUrl, "$artifact.surveyUrl", 8_000);
  timestamp(root.startedAt, "$artifact.startedAt");
  timestamp(root.endedAt, "$artifact.endedAt");
  finiteNonnegative(root.wallMs, "$artifact.wallMs");
  stringArray(root.plannedWitnesses, "$artifact.plannedWitnesses", 100_000, 1_000);
  validateStepsEnvelope(root.steps, "$artifact.steps");
  nonempty(root.outcome, "$artifact.outcome", 500);
  nullableString(root.outcomeDetail, "$artifact.outcomeDetail", MAX_TEXT);
  booleanValue(root.shimmed, "$artifact.shimmed");
  nullableString(root.shimNote, "$artifact.shimNote", MAX_TEXT);
  validateLoadFailure(root.loadFailure, "$artifact.loadFailure");
  const evidenceIds = stringArray(root.evidenceIds, "$artifact.evidenceIds", MAX_EPOCHS * 3 + 100_000, 1_000);
  // The producer learns this content-addressed pointer only after the immutable observation
  // bytes land, so stored legacy/self bytes may omit it. A returned/runtime observation may
  // carry it, but it must be an exact catalogue identity already present in its evidence list.
  if (hasOwn(root, "observationEvidenceId")) {
    const observationEvidenceId = patterned(
      root.observationEvidenceId,
      /^ev_[0-9a-hjkmnp-tv-z]{12}$/,
      "$artifact.observationEvidenceId",
    );
    if (!evidenceIds.includes(observationEvidenceId)) {
      invalid("$artifact.observationEvidenceId", "must also occur in evidenceIds");
    }
  }
  validateViewport(root.viewport, "$artifact.viewport");
  validateOptionalPathFields(root);

  const captureFieldPresent = hasOwn(root, "screenCaptures");
  const countIssues: string[] = [];
  const epochs: ScreenCaptureEpoch[] = [];
  if (captureFieldPresent) {
    const epochValues = arrayValue(root.screenCaptures, "$artifact.screenCaptures", MAX_EPOCHS);
    for (let index = 0; index < epochValues.length; index += 1) {
      const parsedEpoch = parseCaptureEpoch(epochValues[index], `$artifact.screenCaptures[${index}]`);
      epochs.push(parsedEpoch.epoch);
      countIssues.push(...parsedEpoch.countIssues.map((issue) => `epoch[${index}].${issue}`));
    }
  }

  const hasScreenCount = hasOwn(root, "screenCaptureCount");
  const screenCount = hasScreenCount
    ? nonnegativeInteger(root.screenCaptureCount, "$artifact.screenCaptureCount", MAX_EPOCHS)
    : null;
  if (captureFieldPresent && !hasScreenCount) countIssues.push("screenCaptureCount:missing");
  if (captureFieldPresent && screenCount !== null && screenCount !== epochs.length) {
    countIssues.push("screenCaptureCount:mismatch");
  }
  if (!captureFieldPresent && hasScreenCount) countIssues.push("screenCaptures:absent-with-declared-count");

  const hasFailures = hasOwn(root, "captureFailures");
  const failures = hasFailures
    ? arrayValue(root.captureFailures, "$artifact.captureFailures", MAX_FAILURES).map((failure, index) =>
        validateFailure(failure, `$artifact.captureFailures[${index}]`),
      )
    : null;
  const hasFailureCount = hasOwn(root, "captureFailureCount");
  const failureCount = hasFailureCount
    ? nonnegativeInteger(root.captureFailureCount, "$artifact.captureFailureCount", Number.MAX_SAFE_INTEGER)
    : null;
  if (hasFailures !== hasFailureCount) countIssues.push("captureFailureFields:incomplete");
  if (failures !== null && failureCount !== sumFailureCounts(failures)) {
    countIssues.push("captureFailureCount:mismatch");
  }
  if (captureFieldPresent && failures === null) countIssues.push("captureFailures:missing");
  if (!captureFieldPresent && (hasFailures || hasFailureCount)) {
    countIssues.push("captureFields:present-without-screenCaptures");
  }
  const flattened = epochs.flatMap((epoch) => epoch.captureFailures);
  const residual = failures === null
    ? { extra: [] as ScreenCaptureFailure[], missing: [] as ScreenCaptureFailure[] }
    : subtractFailures(failures, flattened);
  if (failures !== null && residual.missing.length > 0) {
    countIssues.push("captureFailures:missing-epoch-failure");
  }

  return {
    runId,
    pathId,
    attemptId,
    planRevisionId,
    captureFieldPresent,
    epochs,
    walkCaptureFailures: failures === null ? [] : residual.extra,
    countIssues: [...new Set(countIssues)].sort(),
  };
}

/** Strict walk-envelope validation at the same boundary visual-work ingestion uses. */
export function validatePathObservationBytes(bytes: Uint8Array): void {
  parsePathObservation(bytes);
}

/**
 * The read-only screen-capture projection that `screens.ts` uses to project epochs.
 * Named distinctly from the internal `ParsedPathObservation` so the API import is
 * explicit about which subset it consumes.
 */
export interface DecodedPathObservationScreenCaptures {
  runId: string;
  pathId: string;
  attemptId: string;
  planRevisionId: string;
  screenCapturesFieldPresent: boolean;
  screenCaptures: ScreenCaptureEpoch[];
  walkCaptureFailures: ScreenCaptureFailure[];
  countIssues: string[];
}

/**
 * Strict decode of a PathObservation's screen capture epochs for the screens API.
 * Returns the same validated parse as `validatePathObservationBytes`, projected into
 * the shape `screens.ts` consumes.
 */
export function decodePathObservationScreenCaptures(bytes: Uint8Array): DecodedPathObservationScreenCaptures {
  const parsed = parsePathObservation(bytes);
  return {
    runId: parsed.runId,
    pathId: parsed.pathId,
    attemptId: parsed.attemptId,
    planRevisionId: parsed.planRevisionId,
    screenCapturesFieldPresent: parsed.captureFieldPresent,
    screenCaptures: parsed.epochs,
    walkCaptureFailures: parsed.walkCaptureFailures,
    countIssues: parsed.countIssues,
  };
}

function validatePdf(value: unknown, path: string, stepIndex: number, slot: string): PdfCapture {
  const root = plainObject(value, path);
  const status = oneOf(root.status, ["captured", "failed"] as const, `${path}.status`);
  if (status === "captured") {
    exactKeys(root, path, ["status", "ref"]);
    return { status, ref: validateArtifactRef(root.ref, `${path}.ref`, "rendered-pdf") };
  }
  exactKeys(root, path, ["status", "failure"]);
  const failure = validateFailure(root.failure, `${path}.failure`, stepIndex, slot);
  if (!isPdfCaptureFailureKind(failure.kind)) {
    invalid(`${path}.failure.kind`, "must be a PDF capture failure kind");
  }
  return { status, failure: failure as ScreenCaptureFailure & { kind: typeof failure.kind } } as PdfCapture;
}

const EPOCH_V1_KEYS = [
  "kind",
  "epochId",
  "stepIndex",
  "slot",
  "scope",
  "startedAt",
  "endedAt",
  "screenReadAt",
  "screenSignatureHash",
  "geometry",
  "screenJson",
  "screenshot",
  "accessibility",
  "captureFailures",
  "captureFailureCount",
] as const;

const EPOCH_V1_1_KEYS = [...EPOCH_V1_KEYS, "pdf"] as const;

function parseCaptureEpoch(value: unknown, path: string): { epoch: ScreenCaptureEpoch; countIssues: string[] } {
  // Peek at the kind to decide which key set is valid.
  const peeked = plainObject(value, path);
  const kind = oneOf(
    peeked.kind,
    ["v2-screen-capture-epoch/1.0.0", "v2-screen-capture-epoch/1.1.0"] as const,
    `${path}.kind`,
  );
  const isV1_1 = kind === "v2-screen-capture-epoch/1.1.0";
  const allowedKeys = isV1_1 ? [...EPOCH_V1_1_KEYS] : [...EPOCH_V1_KEYS];
  const root = object(value, path, allowedKeys);
  const epochId = nonempty(root.epochId, `${path}.epochId`, 500);
  const stepIndex = nonnegativeInteger(root.stepIndex, `${path}.stepIndex`, 1_000_000);
  const slot = nonempty(root.slot, `${path}.slot`, 200);
  const scope = validateScope(root.scope, `${path}.scope`);
  const startedAt = timestamp(root.startedAt, `${path}.startedAt`);
  const endedAt = timestamp(root.endedAt, `${path}.endedAt`);
  const screenReadAt = timestamp(root.screenReadAt, `${path}.screenReadAt`);
  const screenSignatureHash = hash(root.screenSignatureHash, `${path}.screenSignatureHash`);
  const geometry = validateGeometry(root.geometry, `${path}.geometry`);
  const screenJson = validateArtifactRef(root.screenJson, `${path}.screenJson`, "screen-json");
  const screenshot = validateScreenshot(root.screenshot, `${path}.screenshot`, stepIndex, slot);
  const accessibility = validateAccessibility(root.accessibility, `${path}.accessibility`, stepIndex, slot);
  const captureFailures = arrayValue(root.captureFailures, `${path}.captureFailures`, MAX_FAILURES).map(
    (failure, index) => validateFailure(failure, `${path}.captureFailures[${index}]`, stepIndex, slot),
  );
  const captureFailureCount = nonnegativeInteger(
    root.captureFailureCount,
    `${path}.captureFailureCount`,
    Number.MAX_SAFE_INTEGER,
  );
  const countIssues: string[] = [];
  if (captureFailureCount !== sumFailureCounts(captureFailures)) countIssues.push("captureFailureCount:mismatch");
  const modalityFailures = captureFailuresFromModalities(screenshot, accessibility);
  for (const failure of modalityFailures) {
    if (!captureFailures.some((candidate) => canonicalJson(candidate) === canonicalJson(failure))) {
      countIssues.push("captureFailures:missing-modality-failure");
      break;
    }
  }

  if (isV1_1) {
    const pdf = validatePdf(root.pdf, `${path}.pdf`, stepIndex, slot);
    if (pdf.status === "failed") {
      if (!captureFailures.some((candidate) => canonicalJson(candidate) === canonicalJson(pdf.failure))) {
        countIssues.push("captureFailures:missing-modality-failure");
      }
    }
    return {
      epoch: {
        kind: "v2-screen-capture-epoch/1.1.0",
        epochId,
        stepIndex,
        slot,
        scope,
        startedAt,
        endedAt,
        screenReadAt,
        screenSignatureHash,
        geometry,
        screenJson,
        screenshot,
        pdf,
        accessibility,
        captureFailures,
        captureFailureCount,
      },
      countIssues,
    };
  }

  return {
    epoch: {
      kind: "v2-screen-capture-epoch/1.0.0",
      epochId,
      stepIndex,
      slot,
      scope,
      startedAt,
      endedAt,
      screenReadAt,
      screenSignatureHash,
      geometry,
      screenJson,
      screenshot,
      accessibility,
      captureFailures,
      captureFailureCount,
    },
    countIssues,
  };
}

function validateSelectActions(value: unknown, screenBefore: Record<string, unknown>, path: string): void {
  const actions = arrayValue(value, path, 1_000_000);
  for (let index = 0; index < actions.length; index += 1) {
    const raw = actions[index];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const candidate = plainObject(raw, `${path}[${index}]`);
    if (candidate.kind !== "select-option") continue;
    const actionPath = `${path}[${index}]`;
    const action = object(
      candidate,
      actionPath,
      ["kind", "targetIdx", "targetLabel", "targetCode", "value", "ok", "detail", "selectReadback"],
    );
    literal(action.kind, "select-option", `${actionPath}.kind`);
    const targetIdx = nonnegativeInteger(action.targetIdx, `${actionPath}.targetIdx`, 1_000_000);
    const targetLabel = stringValue(action.targetLabel, `${actionPath}.targetLabel`, MAX_TEXT);
    const targetCode = stringValue(action.targetCode, `${actionPath}.targetCode`, MAX_TEXT);
    const selectedValue = stringValue(action.value, `${actionPath}.value`, MAX_TEXT);
    const ok = booleanValue(action.ok, `${actionPath}.ok`);
    nonempty(action.detail, `${actionPath}.detail`, MAX_TEXT);
    let readback: { order: number; code: string; label: string } | null = null;
    if (action.selectReadback !== null) {
      const got = object(action.selectReadback, `${actionPath}.selectReadback`, ["order", "code", "label"]);
      readback = {
        order: nonnegativeInteger(got.order, `${actionPath}.selectReadback.order`, 1_000_000),
        code: stringValue(got.code, `${actionPath}.selectReadback.code`, MAX_TEXT),
        label: stringValue(got.label, `${actionPath}.selectReadback.label`, MAX_TEXT),
      };
    }
    // Failed attempts retain whatever the page returned as counter-evidence. A SUCCESS is the
    // stronger claim and therefore needs the exact receipt bound back to the pre-action select.
    if (!ok) continue;
    if (!readback) invalid(`${actionPath}.selectReadback`, "a successful select action requires exact readback");
    if (targetCode !== readback.code || selectedValue !== readback.code || targetLabel !== readback.label) {
      invalid(actionPath, "successful select target/value fields must exactly equal its readback");
    }
    const controls = arrayValue(screenBefore.controls, `${path.replace(/\.actions$/, ".screenBefore")}.controls`, 1_000_000);
    const control = controls
      .filter((row) => row !== null && typeof row === "object" && !Array.isArray(row))
      .map((row, controlIndex) => plainObject(row, `${path}.screenBefore.controls[${controlIndex}]`))
      .find((row) => row.idx === targetIdx);
    if (!control || (control.tag !== "select" && control.type !== "select")) {
      invalid(actionPath, "successful select receipt does not target a native select in screenBefore");
    }
    if (control.visible !== true || control.disabled !== false || control.multiple !== false) {
      invalid(actionPath, "successful select receipt targets a hidden, disabled, legacy-unattested, or multiple select");
    }
    const options = arrayValue(control.options, `${actionPath}.screenBefore.target.options`, 1_000_000)
      .map((row, optionIndex) => plainObject(row, `${actionPath}.screenBefore.target.options[${optionIndex}]`));
    const option = options.find((row) => row.order === readback!.order);
    if (
      !option ||
      option.code !== readback.code ||
      option.label !== readback.label ||
      option.disabled !== false ||
      option.hidden !== false ||
      option.placeholder !== false
    ) {
      invalid(actionPath, "successful select receipt is not the exact usable option inventoried on its owning select");
    }
  }
}

function validateStepsEnvelope(value: unknown, path: string): void {
  const steps = arrayValue(value, path, MAX_EPOCHS);
  for (let index = 0; index < steps.length; index += 1) {
    const stepPath = `${path}[${index}]`;
    const step = plainObject(steps[index], stepPath);
    // These are the stable PathObservation step envelope fields. Nested rendered-screen payloads
    // remain evidence, not inputs to this denominator, but must still be JSON objects/arrays.
    const allowed = new Set([
      "stepIndex",
      "decisionQuestion",
      "decisionSource",
      "bindingVia",
      "bindingRefusals",
      "requested",
      "screenBefore",
      "screenAfterAction",
      "screenAfterAdvance",
      "actions",
      "requestedButNotOffered",
      "unfillableControls",
      "advanced",
      "blocked",
      "blockedReason",
      "pageErrors",
      "consoleErrors",
      "evidence",
      "wallMs",
    ]);
    for (const key of Object.keys(step)) if (!allowed.has(key)) invalid(`${stepPath}.${key}`, "unknown step field");
    for (const required of [
      "stepIndex",
      "decisionQuestion",
      "decisionSource",
      "requested",
      "screenBefore",
      "screenAfterAction",
      "screenAfterAdvance",
      "actions",
      "requestedButNotOffered",
      "advanced",
      "blocked",
      "pageErrors",
      "consoleErrors",
      "evidence",
      "wallMs",
    ]) {
      if (!hasOwn(step, required)) invalid(stepPath, `missing required step field ${required}`);
    }
    nonnegativeInteger(step.stepIndex, `${stepPath}.stepIndex`, 1_000_000);
    nullableString(step.decisionQuestion, `${stepPath}.decisionQuestion`, 1_000);
    oneOf(step.decisionSource, ["plan", "navigator-default", "probe", "recovery"] as const, `${stepPath}.decisionSource`);
    if (hasOwn(step, "bindingVia")) nullableString(step.bindingVia, `${stepPath}.bindingVia`, MAX_TEXT);
    const screenBefore = plainObject(step.screenBefore, `${stepPath}.screenBefore`);
    if (step.screenAfterAction !== null) plainObject(step.screenAfterAction, `${stepPath}.screenAfterAction`);
    if (step.screenAfterAdvance !== null) plainObject(step.screenAfterAdvance, `${stepPath}.screenAfterAdvance`);
    validateSelectActions(step.actions, screenBefore, `${stepPath}.actions`);
    stringArray(step.requestedButNotOffered, `${stepPath}.requestedButNotOffered`, 1_000_000, MAX_TEXT);
    booleanValue(step.advanced, `${stepPath}.advanced`);
    booleanValue(step.blocked, `${stepPath}.blocked`);
    stringArray(step.pageErrors, `${stepPath}.pageErrors`, 1_000_000, MAX_TEXT);
    stringArray(step.consoleErrors, `${stepPath}.consoleErrors`, 1_000_000, MAX_TEXT);
    plainObject(step.evidence, `${stepPath}.evidence`);
    finiteNonnegative(step.wallMs, `${stepPath}.wallMs`);
  }
}

function validateOptionalPathFields(root: Record<string, unknown>): void {
  if (hasOwn(root, "ending")) {
    const ending = object(root.ending, "$artifact.ending", ["kind", "evidence"]);
    oneOf(ending.kind, ["completed", "screened-out", "stalled", "unclassified"] as const, "$artifact.ending.kind");
    const evidence = stringArray(ending.evidence, "$artifact.ending.evidence", 100_000, MAX_TEXT);
    if (evidence.length === 0) invalid("$artifact.ending.evidence", "must name at least one observed fact");
  }
  if (hasOwn(root, "unboundDecisions")) {
    arrayValue(root.unboundDecisions, "$artifact.unboundDecisions", 100_000).forEach((value, index) => {
      const path = `$artifact.unboundDecisions[${index}]`;
      const row = object(value, path, ["question", "wanted", "reason"]);
      nonempty(row.question, `${path}.question`, 1_000);
      stringArray(row.wanted, `${path}.wanted`, 100_000, MAX_TEXT);
      nonempty(row.reason, `${path}.reason`, MAX_TEXT);
    });
  }
  for (const field of [
    "bindingRefusalCount",
    "readerLimitationCount",
    "unfillableControlCount",
    "navigatorDefaultAnswerCount",
  ]) {
    if (hasOwn(root, field)) nonnegativeInteger(root[field], `$artifact.${field}`, Number.MAX_SAFE_INTEGER);
  }
  if (hasOwn(root, "readerLimitations")) {
    arrayValue(root.readerLimitations, "$artifact.readerLimitations", MAX_FAILURES).forEach((value, index) => {
      const path = `$artifact.readerLimitations[${index}]`;
      const row = object(value, path, ["stepIndex", "kind", "detail", "count"]);
      nonnegativeInteger(row.stepIndex, `${path}.stepIndex`, 1_000_000);
      nonempty(row.kind, `${path}.kind`, 500);
      nonempty(row.detail, `${path}.detail`, MAX_TEXT);
      positiveInteger(row.count, `${path}.count`, 1_000_000);
    });
  }
  if (hasOwn(root, "unfillableControls")) {
    arrayValue(root.unfillableControls, "$artifact.unfillableControls", MAX_FAILURES).forEach((value, index) => {
      const path = `$artifact.unfillableControls[${index}]`;
      const row = object(value, path, ["idx", "type", "label", "required", "reason", "detail", "stepIndex"]);
      nonnegativeInteger(row.idx, `${path}.idx`, 1_000_000);
      nonempty(row.type, `${path}.type`, 500);
      stringValue(row.label, `${path}.label`, MAX_TEXT);
      booleanValue(row.required, `${path}.required`);
      oneOf(
        row.reason,
        [
          "refused-by-policy",
          "cannot-be-satisfied",
          "no-derivation",
          "value-rejected",
          "control-disabled",
          "control-not-operable",
          "no-usable-option",
          "selection-ambiguous",
          "unsupported-widget",
        ] as const,
        `${path}.reason`,
      );
      nonempty(row.detail, `${path}.detail`, MAX_TEXT);
      nonnegativeInteger(row.stepIndex, `${path}.stepIndex`, 1_000_000);
    });
  }
}

function validateLoadFailure(value: unknown, path: string): void {
  if (value === null) return;
  const row = object(value, path, ["message", "stack", "capturedAt"]);
  nonempty(row.message, `${path}.message`, MAX_TEXT);
  nullableString(row.stack, `${path}.stack`, 64_000);
  timestamp(row.capturedAt, `${path}.capturedAt`);
}

function validateViewport(value: unknown, path: string): void {
  const row = object(value, path, ["width", "height"]);
  positiveInteger(row.width, `${path}.width`, 100_000);
  positiveInteger(row.height, `${path}.height`, 100_000);
}

function validateGeometry(value: unknown, path: string): ScreenCaptureGeometry {
  const root = object(value, path, [
    "width",
    "height",
    "deviceScaleFactor",
    "scrollX",
    "scrollY",
    "documentWidth",
    "documentHeight",
    "source",
  ]);
  const width = positiveInteger(root.width, `${path}.width`, 100_000);
  const height = positiveInteger(root.height, `${path}.height`, 100_000);
  const deviceScaleFactor = nullableFinite(root.deviceScaleFactor, `${path}.deviceScaleFactor`, true);
  const scrollX = nullableFinite(root.scrollX, `${path}.scrollX`, false);
  const scrollY = nullableFinite(root.scrollY, `${path}.scrollY`, false);
  const documentWidth = nullableFinite(root.documentWidth, `${path}.documentWidth`, false);
  const documentHeight = nullableFinite(root.documentHeight, `${path}.documentHeight`, false);
  const source = oneOf(root.source, ["browser", "configured-fallback"] as const, `${path}.source`);
  if (
    source === "configured-fallback" &&
    [deviceScaleFactor, scrollX, scrollY, documentWidth, documentHeight].some((item) => item !== null)
  ) {
    invalid(path, "configured fallback geometry must keep unmeasured browser fields null");
  }
  return { width, height, deviceScaleFactor, scrollX, scrollY, documentWidth, documentHeight, source };
}

function validateScope(value: unknown, path: string): ScreenCaptureScope {
  const root = object(value, path, ["kind", "tileIndex", "tileCount"]);
  const kind = oneOf(root.kind, ["viewport", "tile"] as const, `${path}.kind`);
  if (kind === "viewport") {
    if (root.tileIndex !== null || root.tileCount !== null) {
      invalid(path, "viewport scope must keep tileIndex and tileCount null");
    }
    return { kind, tileIndex: null, tileCount: null };
  }
  const tileIndex = nonnegativeInteger(root.tileIndex, `${path}.tileIndex`, MAX_EPOCHS);
  const tileCount = positiveInteger(root.tileCount, `${path}.tileCount`, MAX_EPOCHS);
  if (tileIndex >= tileCount) invalid(`${path}.tileIndex`, "must be less than tileCount");
  return { kind, tileIndex, tileCount };
}

function validateArtifactRef<K extends ScreenArtifactRef["kind"]>(
  value: unknown,
  path: string,
  expectedKind: K,
): ScreenArtifactRef & { kind: K } {
  const root = object(value, path, [
    "kind",
    "evidenceId",
    "artifactRef",
    "sourceEvidenceId",
    "contentHash",
    "mediaType",
    "size",
  ]);
  literal(root.kind, expectedKind, `${path}.kind`);
  const expectedMedia = expectedKind === "screenshot"
    ? "image/png"
    : expectedKind === "rendered-pdf"
      ? "application/pdf"
      : "application/json";
  literal(root.mediaType, expectedMedia, `${path}.mediaType`);
  return {
    kind: expectedKind,
    evidenceId: nonempty(root.evidenceId, `${path}.evidenceId`, 1_000),
    artifactRef: nonempty(root.artifactRef, `${path}.artifactRef`, 4_000),
    sourceEvidenceId: nonempty(root.sourceEvidenceId, `${path}.sourceEvidenceId`, 1_000),
    contentHash: hash(root.contentHash, `${path}.contentHash`),
    mediaType: expectedMedia,
    size: nonnegativeInteger(root.size, `${path}.size`, Number.MAX_SAFE_INTEGER),
  } as ScreenArtifactRef & { kind: K };
}

function validateScreenState(value: unknown, path: string, stepIndex: number, slot: string): VisualWorkScreenState {
  const root = plainObject(value, path);
  const status = oneOf(root.status, ["captured", "failed"] as const, `${path}.status`);
  if (status === "captured") {
    exactKeys(root, path, ["status", "ref"]);
    return { status, ref: validateArtifactRef(root.ref, `${path}.ref`, "screen-json") };
  }
  exactKeys(root, path, ["status", "failure"]);
  return { status, failure: validateFailure(root.failure, `${path}.failure`, stepIndex, slot) };
}

function validateScreenshot(value: unknown, path: string, stepIndex: number, slot: string): ScreenshotCapture {
  const root = plainObject(value, path);
  const status = oneOf(root.status, ["captured", "failed"] as const, `${path}.status`);
  if (status === "captured") {
    exactKeys(root, path, ["status", "ref"]);
    return { status, ref: validateArtifactRef(root.ref, `${path}.ref`, "screenshot") };
  }
  exactKeys(root, path, ["status", "failure"]);
  return { status, failure: validateFailure(root.failure, `${path}.failure`, stepIndex, slot) };
}

function validateAccessibility(
  value: unknown,
  path: string,
  stepIndex: number,
  slot: string,
): AccessibilityCapture {
  const root = plainObject(value, path);
  const status = oneOf(root.status, ["captured", "failed"] as const, `${path}.status`);
  if (status === "failed") {
    exactKeys(root, path, ["status", "failure"]);
    return { status, failure: validateFailure(root.failure, `${path}.failure`, stepIndex, slot) };
  }
  exactKeys(root, path, ["status", "ref", "completeness", "limitations"]);
  const completeness = oneOf(root.completeness, ["complete", "truncated"] as const, `${path}.completeness`);
  const limitations = arrayValue(root.limitations, `${path}.limitations`, MAX_FAILURES).map((failure, index) =>
    validateFailure(failure, `${path}.limitations[${index}]`, stepIndex, slot),
  );
  if ((completeness === "complete") !== (limitations.length === 0)) {
    invalid(`${path}.limitations`, "complete must be empty and truncated must name at least one limitation");
  }
  return {
    status,
    ref: validateArtifactRef(root.ref, `${path}.ref`, "accessibility"),
    completeness,
    limitations,
  };
}

const FAILURE_KINDS = [
  "capture-metadata-failed",
  "screen-read-failed",
  "screenshot-capture-failed",
  "screenshot-capture-empty",
  "screenshot-evidence-write-failed",
  "pdf-api-unavailable",
  "pdf-capture-timeout",
  "pdf-capture-failed",
  "pdf-capture-empty",
  "pdf-capture-size-limit",
  "pdf-capture-dimension-limit",
  "pdf-evidence-write-failed",
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

function validateFailure(
  value: unknown,
  path: string,
  expectedStepIndex?: number,
  expectedSlot?: string,
): ScreenCaptureFailure {
  const root = object(value, path, ["kind", "detail", "count", "at", "stepIndex", "slot"]);
  const kind = oneOf(root.kind, FAILURE_KINDS, `${path}.kind`);
  const detail = nonempty(root.detail, `${path}.detail`, MAX_TEXT);
  const count = positiveInteger(root.count, `${path}.count`, 1_000_000);
  const at = timestamp(root.at, `${path}.at`);
  const stepIndex = nonnegativeInteger(root.stepIndex, `${path}.stepIndex`, 1_000_000);
  const slot = nonempty(root.slot, `${path}.slot`, 200);
  if (expectedStepIndex !== undefined && expectedStepIndex !== stepIndex) {
    invalid(`${path}.stepIndex`, "does not bind its capture epoch");
  }
  if (expectedSlot !== undefined && expectedSlot !== slot) invalid(`${path}.slot`, "does not bind its capture epoch");
  return { kind, detail, count, at, stepIndex, slot };
}

function captureFailuresFromModalities(
  screenshot: ScreenshotCapture,
  accessibility: AccessibilityCapture,
): ScreenCaptureFailure[] {
  const out: ScreenCaptureFailure[] = [];
  if (screenshot.status === "failed") out.push(screenshot.failure);
  if (accessibility.status === "failed") out.push(accessibility.failure);
  else out.push(...accessibility.limitations);
  return out;
}

function sumFailureCounts(failures: readonly ScreenCaptureFailure[]): number {
  return failures.reduce((sum, failure) => sum + failure.count, 0);
}

/** Multiset subtraction: extra walk failures are legitimate; missing lifted epoch failures are not. */
function subtractFailures(
  walkFailures: readonly ScreenCaptureFailure[],
  epochFailures: readonly ScreenCaptureFailure[],
): { extra: ScreenCaptureFailure[]; missing: ScreenCaptureFailure[] } {
  const unmatchedEpoch = [...epochFailures];
  const extra: ScreenCaptureFailure[] = [];
  for (const failure of walkFailures) {
    const match = unmatchedEpoch.findIndex((candidate) => canonicalJson(candidate) === canonicalJson(failure));
    if (match < 0) extra.push(failure);
    else unmatchedEpoch.splice(match, 1);
  }
  return { extra, missing: unmatchedEpoch };
}

export async function computeCaptureInputIdentity(input: ScreenCaptureEpoch | VisualWorkEpochRow): Promise<string> {
  const screen = "screenJson" in input ? { status: "captured" as const, ref: input.screenJson } : input.screen;
  const digest = await canonicalHash({
    schemaVersion: "survey-qa-visual-capture-input/1.0.0",
    stepIndex: input.stepIndex,
    slot: input.slot,
    scope: input.scope,
    screenSignatureHash: input.screenSignatureHash,
    geometry: input.geometry,
    screen,
    screenshot: input.screenshot,
    accessibility: input.accessibility,
  });
  return `visual-capture-input/sha256/${digest}`;
}

function isUniquelySelected(row: WalkArtifactIndexRow): row is WalkArtifactIndexRow & { selected: WalkArtifactBinding } {
  return (row.state === "exact" || row.state === "legacy") && row.selected !== null;
}

function limitationForIndexState(
  state: WalkArtifactResolutionState,
): "walk-index-missing" | "walk-index-mismatched" | "walk-index-ambiguous" {
  if (state === "missing") return "walk-index-missing";
  if (state === "mismatched") return "walk-index-mismatched";
  if (state === "ambiguous") return "walk-index-ambiguous";
  invalid("$.index", `state ${state} claims unique resolution without a selection`);
}

const DEFAULT_LIMITATION_DETAIL: Record<Exclude<VisualWorkLimitationKind, `capture-failure:${string}`>, string> = {
  "walk-index-missing": "the execution walk has no PathObservation catalog candidate",
  "walk-index-mismatched": "the only stamped PathObservation belongs to a different attempt",
  "walk-index-ambiguous": "multiple PathObservation candidates remain and none may be selected by order",
  "catalog-entry-missing": "the indexed catalog entry could not be re-read by its exact evidence id",
  "catalog-binding-mismatch": "the re-read catalog binding does not exactly match the indexed binding",
  "walk-artifact-unreadable": "the indexed PathObservation bytes were missing or failed their content hash",
  "walk-artifact-corrupt": "the indexed bytes are not a strict PathObservation",
  "walk-artifact-identity-mismatch": "the PathObservation run, plan, path, or attempt identity does not match the index",
  "legacy-screen-captures-absent": "the legacy PathObservation has no screenCaptures field; epoch count is unknown",
  "screen-captures-absent": "the PathObservation has no screenCaptures field; epoch count is unknown",
  "inconsistent-declared-capture-counts": "declared capture counts do not reconcile with captured rows",
  "duplicate-epoch-identity": "the epoch identity occurs more than once and no first occurrence may win",
  "duplicate-cache-input-identity": "the paired capture input identity occurs more than once and no first occurrence may win",
};

function addWalkLimitation(
  limitations: VisualWorkLimitationRow[],
  walkOrdinal: number,
  kind: Exclude<VisualWorkLimitationKind, `capture-failure:${string}`>,
  detail = DEFAULT_LIMITATION_DETAIL[kind],
): void {
  limitations.push({ scope: "walk", walkOrdinal, epochOrdinal: null, kind, count: 1, detail });
}

function appendCaptureFailureLimitations(
  row: VisualWorkEpochRow,
  epoch: ScreenCaptureEpoch,
  limitations: VisualWorkLimitationRow[],
): void {
  const failures = [...epoch.captureFailures];
  for (const failure of captureFailuresFromModalities(epoch.screenshot, epoch.accessibility)) {
    if (!failures.some((candidate) => canonicalJson(candidate) === canonicalJson(failure))) failures.push(failure);
  }
  for (const failure of failures) {
    limitations.push({
      scope: "epoch",
      walkOrdinal: row.walkOrdinal,
      epochOrdinal: row.epochOrdinal,
      kind: `capture-failure:${failure.kind}`,
      count: failure.count,
      detail: failure.detail,
    });
  }
}

function markDuplicateIdentities(
  epochs: VisualWorkEpochRow[],
  limitations: VisualWorkLimitationRow[],
): void {
  markDuplicates(epochs, (row) => row.epochId, "duplicate-epoch-identity", limitations);
  markDuplicates(
    epochs,
    (row) => row.cacheInputIdentity,
    "duplicate-cache-input-identity",
    limitations,
  );
}

function markDuplicates(
  epochs: VisualWorkEpochRow[],
  identityFor: (row: VisualWorkEpochRow) => string | null,
  kind: "duplicate-epoch-identity" | "duplicate-cache-input-identity",
  limitations: VisualWorkLimitationRow[],
): void {
  const groups = new Map<string, VisualWorkEpochRow[]>();
  for (const row of epochs) {
    const identity = identityFor(row);
    if (identity === null) continue;
    const group = groups.get(identity) ?? [];
    group.push(row);
    groups.set(identity, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      if (!row.ambiguityKinds.includes(kind)) row.ambiguityKinds.push(kind);
      row.ambiguityKinds.sort();
      row.eligibility = "ambiguous";
      limitations.push({
        scope: "epoch",
        walkOrdinal: row.walkOrdinal,
        epochOrdinal: row.epochOrdinal,
        kind,
        count: 1,
        detail: DEFAULT_LIMITATION_DETAIL[kind],
      });
    }
  }
}

function attachLimitationKinds(epochs: VisualWorkEpochRow[], limitations: VisualWorkLimitationRow[]): void {
  for (const row of epochs) row.limitationKinds = limitationKindsForEpoch(row.walkOrdinal, row.epochOrdinal, limitations);
}

function limitationKindsForEpoch(
  walkOrdinal: number,
  epochOrdinal: number,
  limitations: readonly VisualWorkLimitationRow[],
): VisualWorkLimitationKind[] {
  return [
    ...new Set(
      limitations
        .filter(
          (limitation) =>
            limitation.scope === "epoch" &&
            limitation.walkOrdinal === walkOrdinal &&
            limitation.epochOrdinal === epochOrdinal,
        )
        .map((limitation) => limitation.kind),
    ),
  ].sort();
}

function compareLimitations(a: VisualWorkLimitationRow, b: VisualWorkLimitationRow): number {
  return (
    a.walkOrdinal - b.walkOrdinal ||
    (a.epochOrdinal ?? -1) - (b.epochOrdinal ?? -1) ||
    a.kind.localeCompare(b.kind) ||
    a.detail.localeCompare(b.detail) ||
    a.count - b.count
  );
}

function assertLimitationBindings(
  walks: readonly VisualWorkWalkRow[],
  epochs: readonly VisualWorkEpochRow[],
  limitations: readonly VisualWorkLimitationRow[],
): void {
  const epochByIdentity = new Map(epochs.map((row) => [`${row.walkOrdinal}:${row.epochOrdinal}`, row]));
  for (let index = 0; index < limitations.length; index += 1) {
    const limitation = limitations[index]!;
    if (!walks[limitation.walkOrdinal]) {
      invalid(`$.limitations[${index}].walkOrdinal`, "does not identify a manifest walk");
    }
    if (limitation.scope === "epoch") {
      if (!epochByIdentity.has(`${limitation.walkOrdinal}:${limitation.epochOrdinal}`)) {
        invalid(`$.limitations[${index}].epochOrdinal`, "does not identify a discovered epoch");
      }
    } else if (
      limitation.kind === "duplicate-epoch-identity" ||
      limitation.kind === "duplicate-cache-input-identity"
    ) {
      invalid(`$.limitations[${index}].kind`, "this limitation must bind a specific epoch");
    }
  }

  const hasWalkKind = (walkOrdinal: number, kind: VisualWorkLimitationKind): boolean =>
    limitations.some(
      (row) => row.scope === "walk" && row.walkOrdinal === walkOrdinal && row.kind === kind,
    );
  for (const walk of walks) {
    let required: VisualWorkLimitationKind | null = null;
    if (walk.indexState === "missing") required = "walk-index-missing";
    else if (walk.indexState === "mismatched") required = "walk-index-mismatched";
    else if (walk.indexState === "ambiguous") required = "walk-index-ambiguous";
    else if (walk.resolution === "catalog-missing") required = "catalog-entry-missing";
    else if (walk.resolution === "catalog-binding-mismatch") required = "catalog-binding-mismatch";
    else if (walk.resolution === "artifact-unreadable") required = "walk-artifact-unreadable";
    else if (walk.resolution === "artifact-corrupt") required = "walk-artifact-corrupt";
    else if (walk.resolution === "artifact-identity-mismatch") required = "walk-artifact-identity-mismatch";
    else if (walk.resolution === "verified" && walk.epochKnowledge === "unknown") {
      required = walk.indexState === "legacy" ? "legacy-screen-captures-absent" : "screen-captures-absent";
    }
    if (required !== null && !hasWalkKind(walk.walkOrdinal, required)) {
      invalid(`$.walks[${walk.walkOrdinal}]`, `is missing counted walk limitation ${required}`);
    }
  }

  const hasEpochFailure = (row: VisualWorkEpochRow, failure: ScreenCaptureFailure): boolean =>
    limitations.some(
      (limitation) =>
        limitation.scope === "epoch" &&
        limitation.walkOrdinal === row.walkOrdinal &&
        limitation.epochOrdinal === row.epochOrdinal &&
        limitation.kind === `capture-failure:${failure.kind}` &&
        limitation.count === failure.count &&
        limitation.detail === failure.detail,
    );
  for (const row of epochs) {
    const modalityFailures: ScreenCaptureFailure[] = [];
    if (row.screen.status === "failed") modalityFailures.push(row.screen.failure);
    modalityFailures.push(...captureFailuresFromModalities(row.screenshot, row.accessibility));
    for (const failure of modalityFailures) {
      if (!hasEpochFailure(row, failure)) {
        invalid(`$.epochs[${row.walkOrdinal}:${row.epochOrdinal}]`, `is missing counted capture failure ${failure.kind}`);
      }
    }
    for (const kind of row.ambiguityKinds) {
      if (
        !limitations.some(
          (limitation) =>
            limitation.scope === "epoch" &&
            limitation.walkOrdinal === row.walkOrdinal &&
            limitation.epochOrdinal === row.epochOrdinal &&
            limitation.kind === kind,
        )
      ) {
        invalid(`$.epochs[${row.walkOrdinal}:${row.epochOrdinal}]`, `is missing counted ambiguity ${kind}`);
      }
    }
  }
}

function bindingFromCatalog(entry: EvidenceCatalogEntry): WalkArtifactBinding {
  const sourceEvidenceId = entry.sourceEvidenceId ?? null;
  if (typeof sourceEvidenceId !== "string" || sourceEvidenceId.length === 0) {
    invalid("$catalog.sourceEvidenceId", "must carry the indexed PathObservation producer identity");
  }
  return validateBinding(
    {
      evidenceId: entry.evidenceId,
      artifactRef: entry.artifactRef ?? null,
      contentHash: entry.contentHash,
      mediaType: entry.mediaType,
      sourceEvidenceId,
      attemptId: entry.attemptId ?? null,
      routeId: entry.routeId ?? null,
      type: entry.type,
      size: entry.size,
    },
    "$catalog",
    sourceEvidenceId,
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
  if (sourceEvidenceId !== expectedSourceEvidenceId) {
    invalid(`${path}.sourceEvidenceId`, "does not match the walk producer identity");
  }
  return {
    evidenceId: nonempty(root.evidenceId, `${path}.evidenceId`, 1_000),
    artifactRef: nullableString(root.artifactRef, `${path}.artifactRef`, 4_000),
    contentHash: hash(root.contentHash, `${path}.contentHash`),
    mediaType: nonempty(root.mediaType, `${path}.mediaType`, 300),
    sourceEvidenceId,
    attemptId: nullableString(root.attemptId, `${path}.attemptId`, 500),
    routeId: nullableString(root.routeId, `${path}.routeId`, 500),
    type: oneOf(root.type, ["screenshot", "dom-excerpt", "trace", "state", "har", "other"] as const, `${path}.type`),
    size: nonnegativeInteger(root.size, `${path}.size`, Number.MAX_SAFE_INTEGER),
  };
}

const BASE_LIMITATION_KINDS = new Set<string>([
  "walk-index-missing",
  "walk-index-mismatched",
  "walk-index-ambiguous",
  "catalog-entry-missing",
  "catalog-binding-mismatch",
  "walk-artifact-unreadable",
  "walk-artifact-corrupt",
  "walk-artifact-identity-mismatch",
  "legacy-screen-captures-absent",
  "screen-captures-absent",
  "inconsistent-declared-capture-counts",
  "duplicate-epoch-identity",
  "duplicate-cache-input-identity",
]);

function limitationKind(value: unknown, path: string): VisualWorkLimitationKind {
  const text = nonempty(value, path, 500);
  if (BASE_LIMITATION_KINDS.has(text)) return text as VisualWorkLimitationKind;
  if (text.startsWith("capture-failure:")) {
    const suffix = text.slice("capture-failure:".length);
    if ((FAILURE_KINDS as readonly string[]).includes(suffix)) return text as VisualWorkLimitationKind;
  }
  invalid(path, "is not a named visual work limitation");
}

function normalizeLimitationKinds(value: unknown, path: string): VisualWorkLimitationKind[] {
  const kinds = arrayValue(value, path, MAX_FAILURES).map((item, index) => limitationKind(item, `${path}[${index}]`));
  const sorted = [...new Set(kinds)].sort();
  if (canonicalJson(kinds) !== canonicalJson(sorted)) invalid(path, "must be unique and sorted");
  return kinds;
}

function normalizeStringEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T[] {
  const rows = arrayValue(value, path, allowed.length).map((item, index) =>
    oneOf(item, allowed, `${path}[${index}]`),
  );
  const sorted = [...new Set(rows)].sort() as T[];
  if (canonicalJson(rows) !== canonicalJson(sorted)) invalid(path, "must be unique and sorted");
  return rows;
}

function duplicateValues(values: readonly string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([value]) => value));
}

function ensureUnique(values: readonly string[], path: string, label: string): void {
  if (new Set(values).size !== values.length) invalid(path, `contains a duplicate ${label}`);
}

function object(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  const root = plainObject(value, path);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(root)) if (!allowedSet.has(key)) invalid(`${path}.${key}`, "unknown field");
  for (const key of required) if (!hasOwn(root, key)) invalid(path, `missing required field ${key}`);
  return root;
}

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "must be a JSON object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, "must not carry a custom prototype");
  return value as Record<string, unknown>;
}

function exactKeys(root: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(root)) if (!allowedSet.has(key)) invalid(`${path}.${key}`, "unknown field");
  for (const key of allowed) if (!hasOwn(root, key)) invalid(path, `missing required field ${key}`);
}

function hasOwn(root: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(root, key);
}

function arrayValue(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) invalid(path, "must be an array");
  if (value.length > max) invalid(path, `must contain at most ${max} rows`);
  return value;
}

function stringArray(value: unknown, path: string, maxRows: number, maxChars: number): string[] {
  return arrayValue(value, path, maxRows).map((item, index) => stringValue(item, `${path}[${index}]`, maxChars));
}

function stringValue(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.length > max) invalid(path, `must be a string of at most ${max} characters`);
  return value;
}

function nonempty(value: unknown, path: string, max: number): string {
  const text = stringValue(value, path, max);
  if (text.length === 0) invalid(path, "must not be empty");
  return text;
}

function nullableString(value: unknown, path: string, max: number): string | null {
  return value === null ? null : stringValue(value, path, max);
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path, "must be a boolean");
  return value;
}

function finiteNonnegative(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalid(path, "must be a finite non-negative number");
  }
  return value;
}

function nullableFinite(value: unknown, path: string, positive: boolean): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || (positive && value <= 0)) {
    invalid(path, positive ? "must be null or a positive finite number" : "must be null or a finite number");
  }
  return value;
}

function nonnegativeInteger(value: unknown, path: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    invalid(path, `must be an integer from 0 through ${max}`);
  }
  return value as number;
}

function positiveInteger(value: unknown, path: string, max: number): number {
  const number = nonnegativeInteger(value, path, max);
  if (number === 0) invalid(path, "must be greater than zero");
  return number;
}

function timestamp(value: unknown, path: string): string {
  const text = nonempty(value, path, 100);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) invalid(path, "must be a canonical ISO timestamp");
  return text;
}

function patterned(value: unknown, pattern: RegExp, path: string): string {
  const text = nonempty(value, path, 1_000);
  if (!pattern.test(text)) invalid(path, "has an invalid identity format");
  return text;
}

function hash(value: unknown, path: string): string {
  const text = nonempty(value, path, 64);
  if (!HASH.test(text)) invalid(path, "must be a lowercase SHA-256 digest");
  return text;
}

function literal<T extends string | number>(value: unknown, expected: T, path: string): T {
  if (value !== expected) invalid(path, `must equal ${JSON.stringify(expected)}`);
  return expected;
}

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[], path: string): T {
  if (!allowed.includes(value as T)) invalid(path, `must be one of ${allowed.join(", ")}`);
  return value as T;
}

function invalid(path: string, detail: string): never {
  throw new VisualWorkValidationError(path, detail);
}

function boundedError(error: unknown): string {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return detail.length <= MAX_TEXT ? detail : `${detail.slice(0, MAX_TEXT - 1)}…`;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

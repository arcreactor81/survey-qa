/**
 * REPLAY-SAFE VISUAL WAVE PROGRESS.
 *
 * Visual inference is purchased serially, but a Cloudflare Workflow step may be replayed after
 * any awaited write. A mutable `progress.json` would make a lost response indistinguishable from
 * an uncommitted wave and would permit either a duplicate purchase or a last-writer-wins fork.
 * This store instead has three layers:
 *
 *   - one fixed, compact pointer advanced with an R2 ETag compare-and-set;
 *   - immutable, content-addressed progress states (including ownership handoffs); and
 *   - immutable, content-addressed wave shards linked in denominator order.
 *
 * The complete run/configuration/work/fence identity is closed and repeated at every boundary.
 * A shard contains observations about processing only; this module never selects or calls a
 * model. Final coverage is still computed against the independently validated work denominator.
 */

import { assertV2Key, k } from "../keys";
import type { Env } from "../types/env";
import { OwnershipLost } from "../types/contracts";
import { loadCheckpoint } from "./checkpoint";
import type {
  VisualCoverageAuthorization,
  VisualCoverageArtifactRef,
  VisualCoverageDisposition,
  VisualInferenceFingerprint,
  VisualCoverageSuccessRefs,
} from "./visual-coverage";
import {
  VISUAL_COVERAGE_DISPOSITIONS,
  visualAuthorizationFingerprintSha256,
  visualInferenceFingerprintSha256,
} from "./visual-coverage";
import {
  VISUAL_PROVIDER_SELECTORS,
  VISUAL_ROLLOUT_CONFIGURATION_SCHEMA_VERSION,
  type VisualShadowConfiguration,
} from "../vision/config";
import { canonicalHash, canonicalJson, sha256Hex } from "./hash";

const enc = new TextEncoder();
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const HASH = /^[0-9a-f]{64}$/;
const BLOCKER_CODE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const MAX_DENOMINATOR_ITEMS = 500_000;
export const VISUAL_PROGRESS_MAX_ITEMS_PER_WAVE = 20_000;
const MAX_WAVES = 500_000;
const MAX_STATE_REVISIONS = 501_000;
const MAX_ADOPTION_CAS_ATTEMPTS = 6;
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 128 * 1024;
export const VISUAL_PROGRESS_MAX_SHARD_BYTES = 16 * 1024 * 1024;
const MAX_KEY_CHARS = 1_024;
const MAX_SEGMENTS = 64;
const MAX_SEGMENT_CHARS = 300;
const MAX_TEXT = 4_000;

export const VISUAL_PROGRESS_POINTER_SCHEMA_VERSION = "survey-qa-visual-progress-pointer/1.0.0" as const;
export const VISUAL_PROGRESS_STATE_SCHEMA_VERSION = "survey-qa-visual-progress-state/1.0.0" as const;
export const VISUAL_PROGRESS_WAVE_SCHEMA_VERSION = "survey-qa-visual-progress-wave/1.0.0" as const;
export const VISUAL_PROGRESS_AUTHORITY_SCHEMA_VERSION = "survey-qa-visual-progress-authority/1.0.0" as const;

const GENESIS_CHAIN_KIND = "survey-qa-visual-progress-chain-genesis" as const;
const CHAIN_LINK_KIND = "survey-qa-visual-progress-chain-link" as const;

export interface VisualProgressOwnership {
  instanceId: string;
  epoch: number;
}

/** Immutable for the lifetime of one visual progress ledger. */
export interface VisualProgressCoreBinding {
  runId: string;
  planRevisionId: string;
  visualWorkManifestSha256: string;
  denominatorItemCount: number;
  configurationFingerprintSha256: string;
  modelFingerprintSha256: string;
  authorizationFingerprintSha256: string;
  /** Immutable non-secret authority object; hashes above are mechanically recomputed from it. */
  authoritySeal: VisualProgressArtifactRef;
  /** Minted once at initialization and later reused by the final closed coverage index. */
  coverageFinalizedAt: string;
}

export type VisualProgressRolloutSeal =
  | { state: "valid"; configuration: VisualShadowConfiguration }
  | { state: "invalid"; recognizedInputSha256: string };

export interface VisualProgressAuthoritySeal {
  schemaVersion: typeof VISUAL_PROGRESS_AUTHORITY_SCHEMA_VERSION;
  kind: "survey-qa-visual-progress-authority";
  runId: string;
  rollout: VisualProgressRolloutSeal;
  configurationFingerprintSha256: string;
  inference: VisualInferenceFingerprint;
  modelFingerprintSha256: string;
  authorization: VisualCoverageAuthorization;
  authorizationFingerprintSha256: string;
}

/** Minimum immutable work identity used to discover a ledger across code/config redeploys. */
export interface VisualProgressIdentityExpected {
  runId: string;
  planRevisionId: string;
  visualWorkManifestSha256: string;
  denominatorItemCount: number;
}

/** Exact sealed identity required before appending under a selected inference configuration. */
export interface VisualProgressExpected extends VisualProgressIdentityExpected {
  configurationFingerprintSha256: string;
  modelFingerprintSha256: string;
  authorizationFingerprintSha256: string;
  authoritySeal: VisualProgressArtifactRef;
  ownership: VisualProgressOwnership;
  /** Omit only while recovering the winning value after a possibly-lost initialization response. */
  coverageFinalizedAt?: string;
}

export interface VisualProgressArtifactRef extends VisualCoverageArtifactRef {}

export interface VisualProgressStateRef extends VisualProgressArtifactRef {
  stateRevision: number;
}

export interface VisualProgressWaveRef extends VisualProgressArtifactRef {
  waveOrdinal: number;
  startDenominatorOrdinal: number;
  endDenominatorOrdinalExclusive: number;
}

export type VisualProgressBlockingDisposition = Extract<
  VisualCoverageDisposition,
  "purchase-blocked" | "accounting-failed" | "persistence-failed" | "rollout-config-invalid"
>;

export interface VisualProgressPurchaseBlocker {
  /** Stable machine-readable name such as `usage-outcome-indeterminate`. */
  code: string;
  detail: string;
  waveOrdinal: number;
  denominatorOrdinal: number;
  disposition: VisualProgressBlockingDisposition;
}

export type VisualProgressPurchaseChannel =
  | { state: "open"; originatingBlocker: null }
  | { state: "blocked"; originatingBlocker: VisualProgressPurchaseBlocker }
  | {
      state: "exhausted";
      originatingStop: {
        code: string;
        detail: string;
        waveOrdinal: number;
        /** First denominator item for which no further purchase is authorized. */
        denominatorOrdinal: number;
        remainderDisposition: "budget-not-authorized";
      };
    };

/** Compact result joined to the independently derived denominator by ordinal and item hash. */
export interface VisualProgressItem {
  denominatorOrdinal: number;
  workItemSha256: string;
  disposition: VisualCoverageDisposition;
  detail: string | null;
  success: VisualCoverageSuccessRefs | null;
}

export interface VisualProgressWaveShard extends VisualProgressCoreBinding {
  schemaVersion: typeof VISUAL_PROGRESS_WAVE_SCHEMA_VERSION;
  kind: "survey-qa-visual-progress-wave";
  ownership: VisualProgressOwnership;
  waveOrdinal: number;
  startDenominatorOrdinal: number;
  endDenominatorOrdinalExclusive: number;
  previousState: VisualProgressStateRef;
  previousWave: VisualProgressWaveRef | null;
  previousChainSha256: string;
  purchaseChannelBefore: VisualProgressPurchaseChannel;
  purchaseChannelAfter: VisualProgressPurchaseChannel;
  items: VisualProgressItem[];
}

export interface VisualProgressState extends VisualProgressCoreBinding {
  schemaVersion: typeof VISUAL_PROGRESS_STATE_SCHEMA_VERSION;
  kind: "survey-qa-visual-progress-state";
  ownership: VisualProgressOwnership;
  stateRevision: number;
  previousState: VisualProgressStateRef | null;
  completedWaveCount: number;
  nextDenominatorOrdinal: number;
  tailWave: VisualProgressWaveRef | null;
  shardChainSha256: string;
  purchaseChannel: VisualProgressPurchaseChannel;
}

export interface VisualProgressPointer extends VisualProgressCoreBinding {
  schemaVersion: typeof VISUAL_PROGRESS_POINTER_SCHEMA_VERSION;
  kind: "survey-qa-visual-progress-pointer";
  ownership: VisualProgressOwnership;
  state: VisualProgressStateRef;
}

export interface VisualProgressCursor {
  stateContentSha256: string;
  stateRevision: number;
  completedWaveCount: number;
  nextDenominatorOrdinal: number;
  shardChainSha256: string;
}

/** O(1) progress view used by every write path. */
export interface VisualProgressHead {
  pointer: VisualProgressPointer;
  pointerEtag: string;
  state: VisualProgressState;
  stateRef: VisualProgressStateRef;
  authority: VisualProgressAuthoritySeal;
}

/** Full audit view. Reconstruct only during finalization/audit, never once per wave. */
export interface VisualProgressSnapshot extends VisualProgressHead {
  /** Oldest to newest, with no ordinal or cursor gaps. */
  waves: VisualProgressWaveShard[];
  waveRefs: VisualProgressWaveRef[];
  items: VisualProgressItem[];
}

export interface InitializeVisualProgressInput extends VisualProgressIdentityExpected {
  rollout: VisualProgressRolloutSeal;
  inference: VisualInferenceFingerprint;
  authorization: VisualCoverageAuthorization;
  ownership: VisualProgressOwnership;
  coverageFinalizedAt?: string;
}

export interface InitializeVisualProgressResult {
  status: "initialized" | "replayed" | "adopted";
  authorityWrite: "stored" | "reused";
  stateWrite: "stored" | "reused";
  pointerWrite: "stored" | "reused";
  head: VisualProgressHead;
}

export interface AppendVisualProgressWaveInput {
  expected: VisualProgressExpected;
  cursor: VisualProgressCursor;
  waveOrdinal: number;
  startDenominatorOrdinal: number;
  items: VisualProgressItem[];
  purchaseChannelAfter: VisualProgressPurchaseChannel;
}

export interface AppendVisualProgressWaveResult {
  status: "appended" | "replayed";
  shardWrite: "stored" | "reused";
  stateWrite: "stored" | "reused";
  pointerWrite: "advanced" | "reused";
  shardRef: VisualProgressWaveRef;
  head: VisualProgressHead;
}

export interface AdoptVisualProgressOwnershipInput {
  expected: VisualProgressIdentityExpected;
  newOwnership: VisualProgressOwnership;
}

export interface AdoptVisualProgressOwnershipResult {
  status: "adopted" | "replayed";
  stateWrite: "stored" | "reused";
  pointerWrite: "advanced" | "reused";
  head: VisualProgressHead;
}

export class VisualProgressValidationError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "VisualProgressValidationError";
  }
}

export class VisualProgressCorruptionError extends Error {
  constructor(readonly key: string, detail: string) {
    super(`visual progress object ${key} is corrupt: ${detail}`);
    this.name = "VisualProgressCorruptionError";
  }
}

export class VisualProgressImmutabilityError extends Error {
  constructor(readonly key: string) {
    super(`visual progress object ${key} already exists with different bytes; immutable rewrite refused`);
    this.name = "VisualProgressImmutabilityError";
  }
}

export class VisualProgressConflictError extends Error {
  constructor(detail: string) {
    super(`visual progress conflict: ${detail}`);
    this.name = "VisualProgressConflictError";
  }
}

/** Fixed CAS head. */
export function visualProgressPointerKey(runId: string): string {
  return k("runs", keySegment(runId, "runId"), "visual", "progress", "current.json");
}

/** Immutable content-addressed state, including ownership-only handoff revisions. */
export function visualProgressStateKey(runId: string, contentSha256: string): string {
  return k(
    "runs",
    keySegment(runId, "runId"),
    "visual",
    "progress",
    "states",
    "sha256",
    hash(contentSha256, "contentSha256"),
    "state.json",
  );
}

/** Immutable non-secret rollout/model/authorization seal. */
export function visualProgressAuthorityKey(runId: string, contentSha256: string): string {
  return k(
    "runs",
    keySegment(runId, "runId"),
    "visual",
    "progress",
    "authority",
    "sha256",
    hash(contentSha256, "contentSha256"),
    "authority.json",
  );
}

/** Immutable bounded wave shard. The padded ordinal makes human inspection sort correctly. */
export function visualProgressWaveKey(runId: string, waveOrdinal: number, contentSha256: string): string {
  const ordinal = nonnegativeInteger(waveOrdinal, "waveOrdinal", MAX_WAVES - 1).toString().padStart(6, "0");
  return k(
    "runs",
    keySegment(runId, "runId"),
    "visual",
    "progress",
    "waves",
    ordinal,
    "sha256",
    hash(contentSha256, "contentSha256"),
    "wave.json",
  );
}

export function visualProgressCursor(snapshot: VisualProgressHead): VisualProgressCursor {
  return {
    stateContentSha256: snapshot.stateRef.contentSha256,
    stateRevision: snapshot.state.stateRevision,
    completedWaveCount: snapshot.state.completedWaveCount,
    nextDenominatorOrdinal: snapshot.state.nextDenominatorOrdinal,
    shardChainSha256: snapshot.state.shardChainSha256,
  };
}

export function visualProgressExpectation(snapshot: VisualProgressHead): VisualProgressExpected {
  return {
    ...coreFrom(snapshot.state),
    ownership: snapshot.state.ownership,
  };
}

/**
 * Conditional-create initialization. If the create response was lost, a retry without an
 * explicit timestamp adopts the already-stored winner and returns its stable finalizedAt.
 */
export async function initializeVisualProgress(
  env: Env,
  input: InitializeVisualProgressInput,
): Promise<InitializeVisualProgressResult> {
  const bucket = env.EVIDENCE;
  const identity = normalizeIdentityExpected(identityFrom(input), "$.input");
  const explicitFinalizedAt = input.coverageFinalizedAt === undefined
    ? undefined
    : isoTimestamp(input.coverageFinalizedAt, "$.input.coverageFinalizedAt");
  const preparedAuthority = await prepareAuthoritySeal(identity.runId, input);
  const authorityWrite = await putImmutable(
    bucket,
    preparedAuthority.ref.key,
    preparedAuthority.bytes,
    MAX_STATE_BYTES,
  );
  const core: VisualProgressCoreBinding = {
    ...identity,
    configurationFingerprintSha256: preparedAuthority.seal.configurationFingerprintSha256,
    modelFingerprintSha256: preparedAuthority.seal.modelFingerprintSha256,
    authorizationFingerprintSha256: preparedAuthority.seal.authorizationFingerprintSha256,
    authoritySeal: preparedAuthority.ref,
    coverageFinalizedAt: explicitFinalizedAt ?? new Date().toISOString(),
  };
  const ownership = normalizeOwnership(input.ownership, "$.input.ownership");
  const expected: VisualProgressExpected = { ...core, ownership };
  await assertCurrentCheckpointOwnership(env, identity.runId, ownership);
  const genesis = await genesisChainSha256(core);
  const state = await validateVisualProgressState({
    schemaVersion: VISUAL_PROGRESS_STATE_SCHEMA_VERSION,
    kind: "survey-qa-visual-progress-state",
    ...core,
    ownership,
    stateRevision: 0,
    previousState: null,
    completedWaveCount: 0,
    nextDenominatorOrdinal: 0,
    tailWave: null,
    shardChainSha256: genesis,
    purchaseChannel: openPurchaseChannel(),
  });
  const stateBytes = canonicalBytes(state, MAX_STATE_BYTES, "$.initialState");
  const stateSha256 = await sha256Hex(stateBytes);
  const stateRef: VisualProgressStateRef = {
    key: visualProgressStateKey(core.runId, stateSha256),
    contentSha256: stateSha256,
    stateRevision: 0,
  };
  const stateWrite = await putImmutable(bucket, stateRef.key, stateBytes, MAX_STATE_BYTES);
  const pointer = validateVisualProgressPointer({
    schemaVersion: VISUAL_PROGRESS_POINTER_SCHEMA_VERSION,
    kind: "survey-qa-visual-progress-pointer",
    ...core,
    ownership,
    state: stateRef,
  });
  const pointerBytes = canonicalBytes(pointer, MAX_HEAD_BYTES, "$.initialPointer");
  const pointerKey = visualProgressPointerKey(core.runId);
  const written = await bucket.put(pointerKey, pointerBytes, {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written !== null) {
    const head = await readVisualProgressHead(bucket, { ...expected, coverageFinalizedAt: core.coverageFinalizedAt });
    if (head === null) throw new VisualProgressConflictError("the newly-created pointer disappeared");
    return { status: "initialized", authorityWrite, stateWrite, pointerWrite: "stored", head };
  }

  const head = await readVisualProgressHeadByIdentity(bucket, identityFrom(expected));
  if (head === null) throw new VisualProgressConflictError("initialization lost a conditional-create race without a winner");
  if (sameOwnership(head.pointer.ownership, ownership)) {
    return { status: "replayed", authorityWrite, stateWrite, pointerWrite: "reused", head };
  }
  const adopted = await adoptVisualProgressOwnership(env, {
    expected: identityFrom(expected),
    newOwnership: ownership,
  });
  return {
    status: "adopted",
    authorityWrite,
    stateWrite: adopted.stateWrite,
    pointerWrite: adopted.pointerWrite === "advanced" ? "stored" : "reused",
    head: adopted.head,
  };
}

/** Read the fixed pointer and its one current content-addressed state: constant R2 reads. */
export async function readVisualProgressHead(
  bucket: R2Bucket,
  expected: VisualProgressExpected,
): Promise<VisualProgressHead | null> {
  const normalizedExpected = normalizeExpected(expected, "$.expected");
  const pointerRecord = await readPointerRecord(bucket, normalizedExpected.runId);
  if (pointerRecord === null) return null;
  assertExpected(pointerRecord.pointer, normalizedExpected, "$.pointer");
  return readHeadFromPointer(bucket, pointerRecord.pointer, pointerRecord.etag);
}

/** Discover sealed authority and the actual prior owner using only immutable work identity. */
export async function readVisualProgressHeadByIdentity(
  bucket: R2Bucket,
  expected: VisualProgressIdentityExpected,
): Promise<VisualProgressHead | null> {
  const identity = normalizeIdentityExpected(expected, "$.expected");
  const pointerRecord = await readPointerRecord(bucket, identity.runId);
  if (pointerRecord === null) return null;
  assertIdentityExpected(pointerRecord.pointer, identity, "$.pointer");
  return readHeadFromPointer(bucket, pointerRecord.pointer, pointerRecord.etag);
}

/** Read and mechanically verify the complete state history and ordered shard chain. */
export async function readVisualProgress(
  bucket: R2Bucket,
  expected: VisualProgressExpected,
): Promise<VisualProgressSnapshot | null> {
  const normalizedExpected = normalizeExpected(expected, "$.expected");
  const pointerRecord = await readPointerRecord(bucket, normalizedExpected.runId);
  if (pointerRecord === null) return null;
  assertExpected(pointerRecord.pointer, normalizedExpected, "$.pointer");
  return readSnapshotFromPointer(bucket, pointerRecord.pointer, pointerRecord.etag);
}

/**
 * Append exactly one non-empty, contiguous wave. Immutable shard/state writes may precede the
 * pointer CAS; orphaned candidates are harmless and a retry computes the same content hashes.
 */
export async function appendVisualProgressWave(
  env: Env,
  input: AppendVisualProgressWaveInput,
): Promise<AppendVisualProgressWaveResult> {
  const bucket = env.EVIDENCE;
  const expected = normalizeExpected(input.expected, "$.input.expected");
  await assertCurrentCheckpointOwnership(env, expected.runId, expected.ownership);
  const cursor = normalizeCursor(input.cursor, "$.input.cursor");
  const waveOrdinal = nonnegativeInteger(input.waveOrdinal, "$.input.waveOrdinal", MAX_WAVES - 1);
  const start = nonnegativeInteger(
    input.startDenominatorOrdinal,
    "$.input.startDenominatorOrdinal",
    expected.denominatorItemCount,
  );
  if (waveOrdinal !== cursor.completedWaveCount) {
    throw new VisualProgressConflictError("wave ordinal does not equal the supplied completed-wave cursor");
  }
  if (start !== cursor.nextDenominatorOrdinal) {
    throw new VisualProgressConflictError("wave start does not equal the supplied denominator cursor");
  }

  const items = normalizeItems(input.items, start, expected.denominatorItemCount, "$.input.items");
  const purchaseChannelAfter = normalizePurchaseChannel(input.purchaseChannelAfter, "$.input.purchaseChannelAfter");
  const priorStateRecord = await readStateByCursor(bucket, expected, cursor);
  const candidate = await prepareWaveCandidate(expected, priorStateRecord, items, purchaseChannelAfter);

  const pointerRecord = await readPointerRecord(bucket, expected.runId);
  if (pointerRecord === null) throw new VisualProgressConflictError("cannot append before initialization");
  const current = await readHeadFromPointer(bucket, pointerRecord.pointer, pointerRecord.etag);
  assertCoreExpected(current.pointer, expected, "$.pointer");

  const existingRef =
    current.state.completedWaveCount === waveOrdinal + 1 && current.state.tailWave?.waveOrdinal === waveOrdinal
      ? current.state.tailWave
      : undefined;
  if (existingRef !== undefined) {
    if (existingRef.contentSha256 !== candidate.shardRef.contentSha256) {
      throw new VisualProgressConflictError(`wave ${waveOrdinal} already committed a different shard (fork refused)`);
    }
    if (!sameOwnership(current.pointer.ownership, expected.ownership)) {
      throw new VisualProgressConflictError("the matching wave exists but the progress head has moved to another ownership fence");
    }
    return {
      status: "replayed",
      shardWrite: "reused",
      stateWrite: "reused",
      pointerWrite: "reused",
      shardRef: existingRef,
      head: current,
    };
  }
  if (current.stateRef.contentSha256 !== cursor.stateContentSha256) {
    throw new VisualProgressConflictError("cursor/state drift: the head advanced without the requested wave");
  }
  assertCursor(current, cursor, "$.input.cursor");
  assertExpected(current.pointer, expected, "$.pointer");

  const shardWrite = await putImmutable(
    bucket,
    candidate.shardRef.key,
    candidate.shardBytes,
    VISUAL_PROGRESS_MAX_SHARD_BYTES,
  );
  const stateWrite = await putImmutable(bucket, candidate.stateRef.key, candidate.stateBytes, MAX_STATE_BYTES);
  const nextPointer = validateVisualProgressPointer({
    schemaVersion: VISUAL_PROGRESS_POINTER_SCHEMA_VERSION,
    kind: "survey-qa-visual-progress-pointer",
    ...coreFrom(candidate.state),
    ownership: candidate.state.ownership,
    state: candidate.stateRef,
  });
  const pointerBytes = canonicalBytes(nextPointer, MAX_HEAD_BYTES, "$.nextPointer");
  // Re-read the checkpoint fence immediately before the cross-object pointer CAS. R2 cannot
  // transact with the checkpoint object, so the pointer ETag is the serializing boundary: a
  // takeover that wins first changes the pointer fence and makes this CAS lose; one that wins
  // later necessarily adopts this already-committed state.
  await assertCurrentCheckpointOwnership(env, expected.runId, expected.ownership);
  const advanced = await bucket.put(visualProgressPointerKey(expected.runId), pointerBytes, {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    onlyIf: { etagMatches: pointerRecord.etag },
  });
  if (advanced === null) {
    const raced = await readVisualProgressAfterRace(bucket, expected, candidate.shardRef);
    return {
      status: "replayed",
      shardWrite,
      stateWrite,
      pointerWrite: "reused",
      shardRef: candidate.shardRef,
      head: raced,
    };
  }
  const head = await readVisualProgressHead(bucket, expected);
  if (head === null) throw new VisualProgressConflictError("the appended pointer disappeared");
  return {
    status: "appended",
    shardWrite,
    stateWrite,
    pointerWrite: "advanced",
    shardRef: candidate.shardRef,
    head,
  };
}

/**
 * CAS ownership handoff for Workflow recovery. Progress does not move; only a new immutable
 * state revision and the fixed pointer acquire the strictly higher ownership epoch.
 */
export async function adoptVisualProgressOwnership(
  env: Env,
  input: AdoptVisualProgressOwnershipInput,
): Promise<AdoptVisualProgressOwnershipResult> {
  return adoptVisualProgressOwnershipAttempt(env, input, 0);
}

async function adoptVisualProgressOwnershipAttempt(
  env: Env,
  input: AdoptVisualProgressOwnershipInput,
  attempt: number,
): Promise<AdoptVisualProgressOwnershipResult> {
  const bucket = env.EVIDENCE;
  const expected = normalizeIdentityExpected(input.expected, "$.input.expected");
  const newOwnership = normalizeOwnership(input.newOwnership, "$.input.newOwnership");
  await assertCurrentCheckpointOwnership(env, expected.runId, newOwnership);
  const pointerRecord = await readPointerRecord(bucket, expected.runId);
  if (pointerRecord === null) throw new VisualProgressConflictError("cannot adopt ownership before initialization");
  assertIdentityExpected(pointerRecord.pointer, expected, "$.pointer");
  const current = await readHeadFromPointer(bucket, pointerRecord.pointer, pointerRecord.etag);

  if (sameOwnership(current.pointer.ownership, newOwnership)) {
    return { status: "replayed", stateWrite: "reused", pointerWrite: "reused", head: current };
  }
  if (newOwnership.epoch <= current.pointer.ownership.epoch) {
    throw new VisualProgressConflictError("ownership adoption requires an epoch strictly above the actual pointer owner");
  }
  if (newOwnership.instanceId === current.pointer.ownership.instanceId) {
    throw new VisualProgressConflictError("ownership adoption requires a new Workflow instance");
  }

  const state = await validateVisualProgressState({
    ...current.state,
    ownership: newOwnership,
    stateRevision: current.state.stateRevision + 1,
    previousState: current.stateRef,
  });
  const stateBytes = canonicalBytes(state, MAX_STATE_BYTES, "$.adoptedState");
  const stateSha256 = await sha256Hex(stateBytes);
  const stateRef: VisualProgressStateRef = {
    key: visualProgressStateKey(state.runId, stateSha256),
    contentSha256: stateSha256,
    stateRevision: state.stateRevision,
  };
  const stateWrite = await putImmutable(bucket, stateRef.key, stateBytes, MAX_STATE_BYTES);
  const nextPointer = validateVisualProgressPointer({
    schemaVersion: VISUAL_PROGRESS_POINTER_SCHEMA_VERSION,
    kind: "survey-qa-visual-progress-pointer",
    ...coreFrom(state),
    ownership: newOwnership,
    state: stateRef,
  });
  await assertCurrentCheckpointOwnership(env, expected.runId, newOwnership);
  const advanced = await bucket.put(
    visualProgressPointerKey(state.runId),
    canonicalBytes(nextPointer, MAX_HEAD_BYTES, "$.adoptedPointer"),
    {
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
      onlyIf: { etagMatches: pointerRecord.etag },
    },
  );
  if (advanced === null) {
    const reread = await readPointerRecord(bucket, state.runId);
    if (reread === null) throw new VisualProgressConflictError("ownership handoff lost its pointer");
    assertIdentityExpected(reread.pointer, expected, "$.pointer");
    const head = await readHeadFromPointer(bucket, reread.pointer, reread.etag);
    if (!sameOwnership(head.pointer.ownership, newOwnership)) {
      if (head.pointer.ownership.epoch < newOwnership.epoch && attempt + 1 < MAX_ADOPTION_CAS_ATTEMPTS) {
        // A final old-fence append may have won after this replacement proved checkpoint
        // ownership but before its pointer CAS. Re-adopt that newer exact head; its append is
        // preserved and the next CAS fences the old owner out. Persistent contention is fatal.
        return adoptVisualProgressOwnershipAttempt(env, input, attempt + 1);
      }
      throw new VisualProgressConflictError(
        `ownership handoff lost ${attempt + 1} CAS attempt(s) to another transition`,
      );
    }
    return { status: "replayed", stateWrite, pointerWrite: "reused", head };
  }
  const head = await readVisualProgressHeadByIdentity(bucket, expected);
  if (head === null) throw new VisualProgressConflictError("the adopted pointer disappeared");
  if (!sameOwnership(head.pointer.ownership, newOwnership)) {
    throw new VisualProgressConflictError("the adopted pointer has the wrong ownership fence");
  }
  return { status: "adopted", stateWrite, pointerWrite: "advanced", head };
}

// -------------------------------------------------------------------------------------
// Closed schema validation
// -------------------------------------------------------------------------------------

export async function validateVisualProgressAuthoritySeal(value: unknown): Promise<VisualProgressAuthoritySeal> {
  const root = object(value, "$authority", [
    "schemaVersion",
    "kind",
    "runId",
    "rollout",
    "configurationFingerprintSha256",
    "inference",
    "modelFingerprintSha256",
    "authorization",
    "authorizationFingerprintSha256",
  ]);
  literal(root.schemaVersion, VISUAL_PROGRESS_AUTHORITY_SCHEMA_VERSION, "$authority.schemaVersion");
  literal(root.kind, "survey-qa-visual-progress-authority", "$authority.kind");
  const runId = keySegment(root.runId, "$authority.runId");
  const rollout = normalizeRolloutSeal(root.rollout, "$authority.rollout");
  const inference = normalizeInferenceFingerprint(root.inference, "$authority.inference");
  const authorization = normalizeAuthorization(root.authorization, "$authority.authorization");
  const configurationFingerprintSha256 = hash(
    root.configurationFingerprintSha256,
    "$authority.configurationFingerprintSha256",
  );
  const modelFingerprintSha256 = hash(root.modelFingerprintSha256, "$authority.modelFingerprintSha256");
  const authorizationFingerprintSha256 = hash(
    root.authorizationFingerprintSha256,
    "$authority.authorizationFingerprintSha256",
  );
  const expectedConfiguration = await rolloutFingerprintSha256(rollout);
  const expectedModel = await visualInferenceFingerprintSha256(inference);
  const expectedAuthorization = await visualAuthorizationFingerprintSha256(authorization);
  if (configurationFingerprintSha256 !== expectedConfiguration) {
    invalid("$authority.configurationFingerprintSha256", "does not hash the sealed rollout configuration");
  }
  if (modelFingerprintSha256 !== expectedModel) {
    invalid("$authority.modelFingerprintSha256", "does not hash the sealed inference fingerprint");
  }
  if (authorizationFingerprintSha256 !== expectedAuthorization) {
    invalid("$authority.authorizationFingerprintSha256", "does not hash the sealed authorization");
  }
  if (authorization.rolloutConfigurationSha256 !== configurationFingerprintSha256) {
    invalid("$authority.authorization.rolloutConfigurationSha256", "does not bind the sealed rollout configuration");
  }
  const expectedAuthorizationState =
    rollout.state === "invalid" ? "invalid" : rollout.configuration.enabled ? "authorized" : "disabled";
  if (authorization.state !== expectedAuthorizationState) {
    invalid("$authority.authorization.state", `must be ${expectedAuthorizationState} for the sealed rollout state`);
  }
  return {
    schemaVersion: VISUAL_PROGRESS_AUTHORITY_SCHEMA_VERSION,
    kind: "survey-qa-visual-progress-authority",
    runId,
    rollout,
    configurationFingerprintSha256,
    inference,
    modelFingerprintSha256,
    authorization,
    authorizationFingerprintSha256,
  };
}

export function validateVisualProgressPointer(value: unknown): VisualProgressPointer {
  const root = object(value, "$pointer", [
    "schemaVersion",
    "kind",
    ...CORE_KEYS,
    "ownership",
    "state",
  ]);
  literal(root.schemaVersion, VISUAL_PROGRESS_POINTER_SCHEMA_VERSION, "$pointer.schemaVersion");
  literal(root.kind, "survey-qa-visual-progress-pointer", "$pointer.kind");
  const core = normalizeCore(root, "$pointer");
  const ownership = normalizeOwnership(root.ownership, "$pointer.ownership");
  const state = normalizeStateRef(root.state, "$pointer.state", core.runId);
  return {
    schemaVersion: VISUAL_PROGRESS_POINTER_SCHEMA_VERSION,
    kind: "survey-qa-visual-progress-pointer",
    ...core,
    ownership,
    state,
  };
}

export async function validateVisualProgressState(value: unknown): Promise<VisualProgressState> {
  const root = object(value, "$state", [
    "schemaVersion",
    "kind",
    ...CORE_KEYS,
    "ownership",
    "stateRevision",
    "previousState",
    "completedWaveCount",
    "nextDenominatorOrdinal",
    "tailWave",
    "shardChainSha256",
    "purchaseChannel",
  ]);
  literal(root.schemaVersion, VISUAL_PROGRESS_STATE_SCHEMA_VERSION, "$state.schemaVersion");
  literal(root.kind, "survey-qa-visual-progress-state", "$state.kind");
  const core = normalizeCore(root, "$state");
  const ownership = normalizeOwnership(root.ownership, "$state.ownership");
  const stateRevision = nonnegativeInteger(root.stateRevision, "$state.stateRevision", MAX_STATE_REVISIONS);
  const previousState = root.previousState === null
    ? null
    : normalizeStateRef(root.previousState, "$state.previousState", core.runId);
  const completedWaveCount = nonnegativeInteger(root.completedWaveCount, "$state.completedWaveCount", MAX_WAVES);
  const nextDenominatorOrdinal = nonnegativeInteger(
    root.nextDenominatorOrdinal,
    "$state.nextDenominatorOrdinal",
    core.denominatorItemCount,
  );
  const tailWave = root.tailWave === null
    ? null
    : normalizeWaveRef(root.tailWave, "$state.tailWave", core.runId);
  const shardChainSha256 = hash(root.shardChainSha256, "$state.shardChainSha256");
  const purchaseChannel = normalizePurchaseChannel(root.purchaseChannel, "$state.purchaseChannel");

  if (stateRevision === 0) {
    if (previousState !== null) invalid("$state.previousState", "genesis state cannot cite a predecessor");
    if (completedWaveCount !== 0 || nextDenominatorOrdinal !== 0 || tailWave !== null) {
      invalid("$state", "genesis state must have an empty wave cursor");
    }
    if (purchaseChannel.state !== "open") invalid("$state.purchaseChannel", "genesis purchase channel must be open");
    const genesis = await genesisChainSha256(core);
    if (shardChainSha256 !== genesis) invalid("$state.shardChainSha256", "does not match the bound genesis chain");
  } else if (previousState === null) {
    invalid("$state.previousState", "non-genesis state must cite its immutable predecessor");
  }
  if ((completedWaveCount === 0) !== (tailWave === null)) {
    invalid("$state.tailWave", "must be null exactly when no waves are complete");
  }
  if (tailWave !== null) {
    if (tailWave.waveOrdinal !== completedWaveCount - 1) {
      invalid("$state.tailWave.waveOrdinal", "does not name the last completed wave");
    }
    if (tailWave.endDenominatorOrdinalExclusive !== nextDenominatorOrdinal) {
      invalid("$state.tailWave.endDenominatorOrdinalExclusive", "does not close at the state cursor");
    }
  }
  return {
    schemaVersion: VISUAL_PROGRESS_STATE_SCHEMA_VERSION,
    kind: "survey-qa-visual-progress-state",
    ...core,
    ownership,
    stateRevision,
    previousState,
    completedWaveCount,
    nextDenominatorOrdinal,
    tailWave,
    shardChainSha256,
    purchaseChannel,
  };
}

export function validateVisualProgressWaveShard(value: unknown): VisualProgressWaveShard {
  const root = object(value, "$wave", [
    "schemaVersion",
    "kind",
    ...CORE_KEYS,
    "ownership",
    "waveOrdinal",
    "startDenominatorOrdinal",
    "endDenominatorOrdinalExclusive",
    "previousState",
    "previousWave",
    "previousChainSha256",
    "purchaseChannelBefore",
    "purchaseChannelAfter",
    "items",
  ]);
  literal(root.schemaVersion, VISUAL_PROGRESS_WAVE_SCHEMA_VERSION, "$wave.schemaVersion");
  literal(root.kind, "survey-qa-visual-progress-wave", "$wave.kind");
  const core = normalizeCore(root, "$wave");
  const ownership = normalizeOwnership(root.ownership, "$wave.ownership");
  const waveOrdinal = nonnegativeInteger(root.waveOrdinal, "$wave.waveOrdinal", MAX_WAVES - 1);
  const startDenominatorOrdinal = nonnegativeInteger(
    root.startDenominatorOrdinal,
    "$wave.startDenominatorOrdinal",
    core.denominatorItemCount,
  );
  const endDenominatorOrdinalExclusive = nonnegativeInteger(
    root.endDenominatorOrdinalExclusive,
    "$wave.endDenominatorOrdinalExclusive",
    core.denominatorItemCount,
  );
  const previousState = normalizeStateRef(root.previousState, "$wave.previousState", core.runId);
  const previousWave = root.previousWave === null
    ? null
    : normalizeWaveRef(root.previousWave, "$wave.previousWave", core.runId);
  const previousChainSha256 = hash(root.previousChainSha256, "$wave.previousChainSha256");
  const purchaseChannelBefore = normalizePurchaseChannel(root.purchaseChannelBefore, "$wave.purchaseChannelBefore");
  const purchaseChannelAfter = normalizePurchaseChannel(root.purchaseChannelAfter, "$wave.purchaseChannelAfter");
  const items = normalizeItems(root.items, startDenominatorOrdinal, core.denominatorItemCount, "$wave.items");
  if (endDenominatorOrdinalExclusive !== startDenominatorOrdinal + items.length) {
    invalid("$wave.endDenominatorOrdinalExclusive", "does not equal start plus the non-empty item count");
  }
  assertPurchaseTransition(purchaseChannelBefore, purchaseChannelAfter, waveOrdinal, items, "$wave");
  return {
    schemaVersion: VISUAL_PROGRESS_WAVE_SCHEMA_VERSION,
    kind: "survey-qa-visual-progress-wave",
    ...core,
    ownership,
    waveOrdinal,
    startDenominatorOrdinal,
    endDenominatorOrdinalExclusive,
    previousState,
    previousWave,
    previousChainSha256,
    purchaseChannelBefore,
    purchaseChannelAfter,
    items,
  };
}

// -------------------------------------------------------------------------------------
// State/shard construction and full-chain verification
// -------------------------------------------------------------------------------------

interface StateRecord {
  state: VisualProgressState;
  ref: VisualProgressStateRef;
}

interface PreparedAuthoritySeal {
  seal: VisualProgressAuthoritySeal;
  bytes: Uint8Array;
  ref: VisualProgressArtifactRef;
}

async function prepareAuthoritySeal(
  runId: string,
  input: Pick<InitializeVisualProgressInput, "rollout" | "inference" | "authorization">,
): Promise<PreparedAuthoritySeal> {
  const rollout = normalizeRolloutSeal(input.rollout, "$.input.rollout");
  const inference = normalizeInferenceFingerprint(input.inference, "$.input.inference");
  const authorization = normalizeAuthorization(input.authorization, "$.input.authorization");
  const seal = await validateVisualProgressAuthoritySeal({
    schemaVersion: VISUAL_PROGRESS_AUTHORITY_SCHEMA_VERSION,
    kind: "survey-qa-visual-progress-authority",
    runId,
    rollout,
    configurationFingerprintSha256: await rolloutFingerprintSha256(rollout),
    inference,
    modelFingerprintSha256: await visualInferenceFingerprintSha256(inference),
    authorization,
    authorizationFingerprintSha256: await visualAuthorizationFingerprintSha256(authorization),
  });
  const bytes = canonicalBytes(seal, MAX_STATE_BYTES, "$.authority");
  const contentSha256 = await sha256Hex(bytes);
  return {
    seal,
    bytes,
    ref: {
      key: visualProgressAuthorityKey(runId, contentSha256),
      contentSha256,
    },
  };
}

interface PreparedWaveCandidate {
  shard: VisualProgressWaveShard;
  shardBytes: Uint8Array;
  shardRef: VisualProgressWaveRef;
  state: VisualProgressState;
  stateBytes: Uint8Array;
  stateRef: VisualProgressStateRef;
}

async function readHeadFromPointer(
  bucket: R2Bucket,
  pointer: VisualProgressPointer,
  pointerEtag: string,
): Promise<VisualProgressHead> {
  const current = await readStateRef(bucket, pointer.state);
  assertSameCore(pointer, current.state, "$.state");
  if (!sameOwnership(pointer.ownership, current.state.ownership)) {
    corrupt(pointer.state.key, "pointer and current state ownership differ");
  }
  const authority = await readAuthorityRef(bucket, pointer.runId, pointer.authoritySeal);
  assertAuthorityBindsCore(authority, pointer, pointer.authoritySeal.key);
  return { pointer, pointerEtag, state: current.state, stateRef: current.ref, authority };
}

async function prepareWaveCandidate(
  expected: VisualProgressExpected,
  prior: StateRecord,
  items: VisualProgressItem[],
  purchaseChannelAfter: VisualProgressPurchaseChannel,
): Promise<PreparedWaveCandidate> {
  assertExpected(prior.state, expected, "$.cursorState");
  const waveOrdinal = prior.state.completedWaveCount;
  const start = prior.state.nextDenominatorOrdinal;
  const end = start + items.length;
  const shard = validateVisualProgressWaveShard({
    schemaVersion: VISUAL_PROGRESS_WAVE_SCHEMA_VERSION,
    kind: "survey-qa-visual-progress-wave",
    ...coreFrom(prior.state),
    ownership: prior.state.ownership,
    waveOrdinal,
    startDenominatorOrdinal: start,
    endDenominatorOrdinalExclusive: end,
    previousState: prior.ref,
    previousWave: prior.state.tailWave,
    previousChainSha256: prior.state.shardChainSha256,
    purchaseChannelBefore: prior.state.purchaseChannel,
    purchaseChannelAfter,
    items,
  });
  const shardBytes = canonicalBytes(shard, VISUAL_PROGRESS_MAX_SHARD_BYTES, "$.wave");
  const shardSha256 = await sha256Hex(shardBytes);
  const shardRef: VisualProgressWaveRef = {
    key: visualProgressWaveKey(shard.runId, waveOrdinal, shardSha256),
    contentSha256: shardSha256,
    waveOrdinal,
    startDenominatorOrdinal: start,
    endDenominatorOrdinalExclusive: end,
  };
  const chainSha256 = await nextChainSha256(prior.state.shardChainSha256, shardRef);
  const state = await validateVisualProgressState({
    schemaVersion: VISUAL_PROGRESS_STATE_SCHEMA_VERSION,
    kind: "survey-qa-visual-progress-state",
    ...coreFrom(prior.state),
    ownership: prior.state.ownership,
    stateRevision: prior.state.stateRevision + 1,
    previousState: prior.ref,
    completedWaveCount: waveOrdinal + 1,
    nextDenominatorOrdinal: end,
    tailWave: shardRef,
    shardChainSha256: chainSha256,
    purchaseChannel: purchaseChannelAfter,
  });
  const stateBytes = canonicalBytes(state, MAX_STATE_BYTES, "$.nextState");
  const stateSha256 = await sha256Hex(stateBytes);
  const stateRef: VisualProgressStateRef = {
    key: visualProgressStateKey(state.runId, stateSha256),
    contentSha256: stateSha256,
    stateRevision: state.stateRevision,
  };
  return { shard, shardBytes, shardRef, state, stateBytes, stateRef };
}

async function readSnapshotFromPointer(
  bucket: R2Bucket,
  pointer: VisualProgressPointer,
  pointerEtag: string,
): Promise<VisualProgressSnapshot> {
  const head = await readHeadFromPointer(bucket, pointer, pointerEtag);
  const current: StateRecord = { state: head.state, ref: head.stateRef };
  const wavesNewestFirst: VisualProgressWaveShard[] = [];
  const refsNewestFirst: VisualProgressWaveRef[] = [];
  let waveCursor = current.state.tailWave;
  for (let remaining = current.state.completedWaveCount; remaining > 0; remaining -= 1) {
    if (waveCursor === null) corrupt(current.ref.key, "wave chain ended before completedWaveCount");
    const wave = await readWaveRef(bucket, waveCursor);
    wavesNewestFirst.push(wave);
    refsNewestFirst.push(waveCursor);
    waveCursor = wave.previousWave;
  }
  if (waveCursor !== null) corrupt(current.ref.key, "wave chain contains more shards than completedWaveCount");
  const waves = wavesNewestFirst.reverse();
  const waveRefs = refsNewestFirst.reverse();

  // A wave-only audit is insufficient: the fixed pointer could otherwise be redirected to a
  // perfectly well-formed later state that cites a missing predecessor and resets the cursor to
  // genesis. Follow every immutable state link and prove that each revision is exactly either an
  // ownership-only adoption or the commit of the one wave it names. This is intentionally an
  // audit/finalization cost; the O(1) write path above must not acquire history-sized reads.
  await verifyStatePredecessorChain(bucket, current, waves, waveRefs);

  let expectedChain = await genesisChainSha256(coreFrom(current.state));
  let expectedPurchase = openPurchaseChannel();
  let expectedDenominatorOrdinal = 0;
  let priorWaveRef: VisualProgressWaveRef | null = null;
  let priorOwnership: VisualProgressOwnership | null = null;
  let priorStateRevision = -1;
  for (let index = 0; index < waves.length; index += 1) {
    const shard = waves[index]!;
    const ref = waveRefs[index]!;
    assertSameCore(current.state, shard, "$.waveHistory");
    if (shard.waveOrdinal !== index || shard.startDenominatorOrdinal !== expectedDenominatorOrdinal) {
      corrupt(ref.key, "wave ordinal or denominator cursor has a gap/reorder");
    }
    if (!sameNullableWaveRef(shard.previousWave, priorWaveRef)) {
      corrupt(ref.key, "wave shard link omitted or reordered a shard");
    }
    if (shard.previousChainSha256 !== expectedChain) corrupt(ref.key, "wave previous chain digest drifted");
    if (canonicalJson(shard.purchaseChannelBefore) !== canonicalJson(expectedPurchase)) {
      corrupt(ref.key, "wave purchase-channel predecessor drifted");
    }
    if (priorOwnership !== null) {
      if (
        shard.ownership.epoch < priorOwnership.epoch ||
        (shard.ownership.epoch === priorOwnership.epoch && shard.ownership.instanceId !== priorOwnership.instanceId)
      ) {
        corrupt(ref.key, "wave ownership fence regressed or changed instance without a higher epoch");
      }
    }
    if (shard.previousState.stateRevision <= priorStateRevision) {
      corrupt(ref.key, "wave predecessor state revisions are not strictly increasing");
    }
    expectedChain = await nextChainSha256(expectedChain, ref);
    expectedPurchase = shard.purchaseChannelAfter;
    expectedDenominatorOrdinal = shard.endDenominatorOrdinalExclusive;
    priorWaveRef = ref;
    priorOwnership = shard.ownership;
    priorStateRevision = shard.previousState.stateRevision;
  }
  if (
    priorOwnership !== null &&
    (current.state.ownership.epoch < priorOwnership.epoch ||
      (current.state.ownership.epoch === priorOwnership.epoch && current.state.ownership.instanceId !== priorOwnership.instanceId))
  ) {
    corrupt(current.ref.key, "current ownership fence is behind the tail wave owner");
  }
  if (priorStateRevision >= current.state.stateRevision) {
    corrupt(current.ref.key, "current state revision does not follow the tail wave predecessor");
  }
  if (waves.length !== current.state.completedWaveCount) corrupt(current.ref.key, "completedWaveCount does not equal shard count");
  if (current.state.shardChainSha256 !== expectedChain) corrupt(current.ref.key, "final shard-chain digest drifted");
  if (canonicalJson(current.state.purchaseChannel) !== canonicalJson(expectedPurchase)) {
    corrupt(current.ref.key, "final purchase-channel state drifted");
  }
  if (current.state.nextDenominatorOrdinal !== expectedDenominatorOrdinal) {
    corrupt(current.ref.key, "state denominator cursor does not match the ordered wave chain");
  }
  const items = waves.flatMap((wave) => wave.items);
  if (items.length !== current.state.nextDenominatorOrdinal) corrupt(current.ref.key, "flattened item count does not equal cursor");
  for (let ordinal = 0; ordinal < items.length; ordinal += 1) {
    if (items[ordinal]!.denominatorOrdinal !== ordinal) corrupt(current.ref.key, "flattened denominator ordinals are not contiguous");
  }
  if (current.state.purchaseChannel.state === "blocked") {
    const blocker = current.state.purchaseChannel.originatingBlocker;
    const item = items[blocker.denominatorOrdinal];
    if (!item || item.disposition !== blocker.disposition || item.detail !== blocker.detail) {
      corrupt(current.ref.key, "purchase blocker does not bind its originating progress item");
    }
    for (let ordinal = blocker.denominatorOrdinal + 1; ordinal < items.length; ordinal += 1) {
      const later = items[ordinal]!;
      if (later.disposition !== "purchase-blocked" || later.detail !== blocker.detail) {
        corrupt(current.ref.key, "post-blocker items do not name the sealed purchase origin");
      }
    }
  } else if (current.state.purchaseChannel.state === "exhausted") {
    const stop = current.state.purchaseChannel.originatingStop;
    if (stop.denominatorOrdinal > current.state.nextDenominatorOrdinal) {
      corrupt(current.ref.key, "purchase exhaustion starts beyond the durable denominator cursor");
    }
    for (let ordinal = stop.denominatorOrdinal; ordinal < items.length; ordinal += 1) {
      const item = items[ordinal]!;
      if (item.disposition !== stop.remainderDisposition || item.detail !== stop.detail) {
        corrupt(current.ref.key, "post-exhaustion items do not use the sealed remainder disposition/detail");
      }
    }
  }
  return { ...head, waves, waveRefs, items };
}

async function verifyStatePredecessorChain(
  bucket: R2Bucket,
  current: StateRecord,
  waves: readonly VisualProgressWaveShard[],
  waveRefs: readonly VisualProgressWaveRef[],
): Promise<void> {
  const waveByRef = new Map<string, { wave: VisualProgressWaveShard; ref: VisualProgressWaveRef }>();
  for (let index = 0; index < waves.length; index += 1) {
    const ref = waveRefs[index]!;
    waveByRef.set(canonicalJson(ref), { wave: waves[index]!, ref });
  }

  let successor = current;
  let transitionCount = 0;
  while (successor.state.stateRevision > 0) {
    const predecessorRef = successor.state.previousState;
    if (predecessorRef === null) {
      corrupt(successor.ref.key, "non-genesis state history ended before revision zero");
    }
    if (predecessorRef.stateRevision !== successor.state.stateRevision - 1) {
      corrupt(successor.ref.key, "state predecessor revision does not decrement by exactly one");
    }
    const predecessor = await readStateRef(bucket, predecessorRef);
    assertSameCore(successor.state, predecessor.state, successor.ref.key);
    await assertExactStateTransition(predecessor, successor, waveByRef);
    successor = predecessor;
    transitionCount += 1;
    if (transitionCount > MAX_STATE_REVISIONS) {
      corrupt(current.ref.key, "state predecessor history exceeds the explicit revision envelope");
    }
  }
  if (successor.state.previousState !== null) {
    corrupt(successor.ref.key, "genesis state cites a predecessor");
  }
  if (transitionCount !== current.state.stateRevision) {
    corrupt(current.ref.key, "state predecessor count does not equal the current revision");
  }
}

async function assertExactStateTransition(
  predecessor: StateRecord,
  successor: StateRecord,
  waveByRef: ReadonlyMap<string, { wave: VisualProgressWaveShard; ref: VisualProgressWaveRef }>,
): Promise<void> {
  const before = predecessor.state;
  const after = successor.state;
  if (after.stateRevision !== before.stateRevision + 1) {
    corrupt(successor.ref.key, "state transition does not advance exactly one revision");
  }
  if (!sameStateRef(after.previousState, predecessor.ref)) {
    corrupt(successor.ref.key, "state transition does not exactly bind its immutable predecessor");
  }

  const completedWaveDelta = after.completedWaveCount - before.completedWaveCount;
  if (completedWaveDelta === 0) {
    if (
      after.nextDenominatorOrdinal !== before.nextDenominatorOrdinal ||
      !sameNullableWaveRef(after.tailWave, before.tailWave) ||
      after.shardChainSha256 !== before.shardChainSha256 ||
      canonicalJson(after.purchaseChannel) !== canonicalJson(before.purchaseChannel)
    ) {
      corrupt(successor.ref.key, "ownership adoption changed progress instead of preserving the exact cursor/channel");
    }
    if (
      after.ownership.epoch <= before.ownership.epoch ||
      after.ownership.instanceId === before.ownership.instanceId
    ) {
      corrupt(successor.ref.key, "ownership-only state transition lacks a strictly higher, different-instance fence");
    }
    return;
  }

  if (completedWaveDelta !== 1) {
    corrupt(successor.ref.key, "state transition omits or commits more than one wave");
  }
  if (!sameOwnership(after.ownership, before.ownership)) {
    corrupt(successor.ref.key, "a wave commit changed ownership instead of using an adoption revision");
  }
  const tail = after.tailWave;
  if (tail === null) corrupt(successor.ref.key, "wave-advancing state has no tail wave");
  const committed = waveByRef.get(canonicalJson(tail));
  if (committed === undefined) {
    corrupt(successor.ref.key, "wave-advancing state names a shard outside the ordered wave chain");
  }
  const wave = committed.wave;
  if (!sameOwnership(wave.ownership, before.ownership)) {
    corrupt(committed.ref.key, "wave ownership does not match its predecessor and successor states");
  }
  if (!sameStateRef(wave.previousState, predecessor.ref)) {
    corrupt(committed.ref.key, "wave predecessor state does not exactly bind the state history");
  }
  if (!sameNullableWaveRef(wave.previousWave, before.tailWave)) {
    corrupt(committed.ref.key, "wave predecessor shard does not match its predecessor state");
  }
  if (
    wave.waveOrdinal !== before.completedWaveCount ||
    wave.startDenominatorOrdinal !== before.nextDenominatorOrdinal ||
    wave.endDenominatorOrdinalExclusive !== after.nextDenominatorOrdinal
  ) {
    corrupt(committed.ref.key, "wave cursor does not exactly derive the successor state");
  }
  if (wave.previousChainSha256 !== before.shardChainSha256) {
    corrupt(committed.ref.key, "wave chain predecessor does not match its predecessor state");
  }
  if (
    canonicalJson(wave.purchaseChannelBefore) !== canonicalJson(before.purchaseChannel) ||
    canonicalJson(wave.purchaseChannelAfter) !== canonicalJson(after.purchaseChannel)
  ) {
    corrupt(committed.ref.key, "wave purchase-channel transition does not derive the successor state");
  }
  const expectedChain = await nextChainSha256(before.shardChainSha256, committed.ref);
  if (after.shardChainSha256 !== expectedChain) {
    corrupt(successor.ref.key, "successor state chain digest does not include its exact committed wave");
  }
}

async function readVisualProgressAfterRace(
  bucket: R2Bucket,
  expected: VisualProgressExpected,
  candidate: VisualProgressWaveRef,
): Promise<VisualProgressHead> {
  const reread = await readPointerRecord(bucket, expected.runId);
  if (reread === null) throw new VisualProgressConflictError("pointer disappeared after a wave CAS race");
  const head = await readHeadFromPointer(bucket, reread.pointer, reread.etag);
  assertCoreExpected(head.pointer, expected, "$.pointer");
  const committed =
    head.state.completedWaveCount === candidate.waveOrdinal + 1 && head.state.tailWave?.waveOrdinal === candidate.waveOrdinal
      ? head.state.tailWave
      : null;
  if (committed?.contentSha256 !== candidate.contentSha256) {
    throw new VisualProgressConflictError(`wave ${candidate.waveOrdinal} lost a CAS race to a different shard`);
  }
  if (!sameOwnership(head.pointer.ownership, expected.ownership)) {
    throw new VisualProgressConflictError("wave committed but ownership changed before replay confirmation");
  }
  return head;
}

// -------------------------------------------------------------------------------------
// R2 primitives
// -------------------------------------------------------------------------------------

async function readPointerRecord(
  bucket: R2Bucket,
  runId: string,
): Promise<{ pointer: VisualProgressPointer; etag: string } | null> {
  const key = visualProgressPointerKey(runId);
  const obj = await bucket.get(key);
  if (obj === null) return null;
  const bytes = await boundedObjectBytes(obj, key, MAX_HEAD_BYTES);
  const pointer = await parseCanonical(bytes, key, validateVisualProgressPointer);
  if (pointer.runId !== runId) corrupt(key, "pointer runId does not match its fixed key");
  return { pointer, etag: obj.etag };
}

async function readStateByCursor(
  bucket: R2Bucket,
  expected: VisualProgressExpected,
  cursor: VisualProgressCursor,
): Promise<StateRecord> {
  const ref: VisualProgressStateRef = {
    key: visualProgressStateKey(expected.runId, cursor.stateContentSha256),
    contentSha256: cursor.stateContentSha256,
    stateRevision: cursor.stateRevision,
  };
  const record = await readStateRef(bucket, ref);
  assertExpected(record.state, expected, "$.cursorState");
  if (
    record.state.completedWaveCount !== cursor.completedWaveCount ||
    record.state.nextDenominatorOrdinal !== cursor.nextDenominatorOrdinal ||
    record.state.shardChainSha256 !== cursor.shardChainSha256
  ) {
    throw new VisualProgressConflictError("cursor fields do not match their content-addressed state");
  }
  return record;
}

async function readStateRef(bucket: R2Bucket, ref: VisualProgressStateRef): Promise<StateRecord> {
  const bytes = await readContentAddressed(bucket, ref, MAX_STATE_BYTES);
  const state = await parseCanonical(bytes, ref.key, validateVisualProgressState);
  if (state.stateRevision !== ref.stateRevision) corrupt(ref.key, "state reference revision does not match bytes");
  if (visualProgressStateKey(state.runId, ref.contentSha256) !== ref.key) corrupt(ref.key, "state reference key drifted");
  return { state, ref };
}

async function readAuthorityRef(
  bucket: R2Bucket,
  runId: string,
  ref: VisualProgressArtifactRef,
): Promise<VisualProgressAuthoritySeal> {
  if (ref.key !== visualProgressAuthorityKey(runId, ref.contentSha256)) {
    corrupt(ref.key, "authority reference key drifted");
  }
  const bytes = await readContentAddressed(bucket, ref, MAX_STATE_BYTES);
  const authority = await parseCanonical(bytes, ref.key, validateVisualProgressAuthoritySeal);
  if (authority.runId !== runId) corrupt(ref.key, "authority runId does not match its progress ledger");
  return authority;
}

async function readWaveRef(bucket: R2Bucket, ref: VisualProgressWaveRef): Promise<VisualProgressWaveShard> {
  const bytes = await readContentAddressed(bucket, ref, VISUAL_PROGRESS_MAX_SHARD_BYTES);
  const wave = await parseCanonical(bytes, ref.key, validateVisualProgressWaveShard);
  if (
    wave.waveOrdinal !== ref.waveOrdinal ||
    wave.startDenominatorOrdinal !== ref.startDenominatorOrdinal ||
    wave.endDenominatorOrdinalExclusive !== ref.endDenominatorOrdinalExclusive
  ) {
    corrupt(ref.key, "wave reference cursor does not match bytes");
  }
  if (visualProgressWaveKey(wave.runId, wave.waveOrdinal, ref.contentSha256) !== ref.key) {
    corrupt(ref.key, "wave reference key drifted");
  }
  return wave;
}

async function readContentAddressed(
  bucket: R2Bucket,
  ref: VisualProgressArtifactRef,
  maxBytes: number,
): Promise<Uint8Array> {
  const obj = await bucket.get(ref.key);
  if (obj === null) throw new VisualProgressCorruptionError(ref.key, "referenced immutable object is missing");
  const bytes = await boundedObjectBytes(obj, ref.key, maxBytes);
  const actual = await sha256Hex(bytes);
  if (actual !== ref.contentSha256) corrupt(ref.key, "content hash does not match its reference");
  return bytes;
}

async function putImmutable(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  maxBytes: number,
): Promise<"stored" | "reused"> {
  assertV2Key(key);
  if (bytes.byteLength > maxBytes) invalid("$", `object exceeds its ${maxBytes}-byte storage envelope`);
  const written = await bucket.put(key, bytes, {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written !== null) return "stored";
  const existing = await bucket.get(key);
  if (existing === null) throw new VisualProgressImmutabilityError(key);
  const existingBytes = await boundedObjectBytes(existing, key, maxBytes);
  if (!equalBytes(existingBytes, bytes)) throw new VisualProgressImmutabilityError(key);
  return "reused";
}

async function boundedObjectBytes(objectBody: R2ObjectBody, key: string, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isFinite(objectBody.size) || objectBody.size < 0 || objectBody.size > maxBytes) {
    corrupt(key, `stored size is outside [0, ${maxBytes}]`);
  }
  const bytes = new Uint8Array(await objectBody.arrayBuffer());
  if (bytes.byteLength !== objectBody.size) corrupt(key, "stored and read byte sizes differ");
  return bytes;
}

async function parseCanonical<T>(
  bytes: Uint8Array,
  key: string,
  normalize: (value: unknown) => T | Promise<T>,
): Promise<T> {
  let decoded: string;
  let parsed: unknown;
  try {
    decoded = fatalUtf8.decode(bytes);
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new VisualProgressCorruptionError(key, "bytes are not strict UTF-8 JSON");
  }
  let normalized: T;
  try {
    normalized = await normalize(parsed);
  } catch (error) {
    throw new VisualProgressCorruptionError(key, boundedError(error));
  }
  if (canonicalJson(normalized) !== decoded) corrupt(key, "bytes are not the canonical closed encoding");
  return normalized;
}

// -------------------------------------------------------------------------------------
// Scalar and invariant helpers
// -------------------------------------------------------------------------------------

const CORE_KEYS = [
  "runId",
  "planRevisionId",
  "visualWorkManifestSha256",
  "denominatorItemCount",
  "configurationFingerprintSha256",
  "modelFingerprintSha256",
  "authorizationFingerprintSha256",
  "authoritySeal",
  "coverageFinalizedAt",
] as const;

function normalizeRolloutSeal(value: unknown, path: string): VisualProgressRolloutSeal {
  const loose = objectAtLeast(value, path);
  if (loose.state === "invalid") {
    const root = object(value, path, ["state", "recognizedInputSha256"]);
    return {
      state: "invalid",
      recognizedInputSha256: hash(root.recognizedInputSha256, `${path}.recognizedInputSha256`),
    };
  }
  const root = object(value, path, ["state", "configuration"]);
  literal(root.state, "valid", `${path}.state`);
  return { state: "valid", configuration: normalizeRolloutConfiguration(root.configuration, `${path}.configuration`) };
}

function normalizeRolloutConfiguration(value: unknown, path: string): VisualShadowConfiguration {
  const loose = objectAtLeast(value, path);
  if (loose.enabled === false) {
    const root = object(value, path, ["schemaVersion", "enabled", "concurrency"]);
    literal(root.schemaVersion, VISUAL_ROLLOUT_CONFIGURATION_SCHEMA_VERSION, `${path}.schemaVersion`);
    if (root.enabled !== false) invalid(`${path}.enabled`, "must be false");
    if (root.concurrency !== 1) invalid(`${path}.concurrency`, "must equal one");
    return { schemaVersion: VISUAL_ROLLOUT_CONFIGURATION_SCHEMA_VERSION, enabled: false, concurrency: 1 };
  }
  const root = object(value, path, [
    "schemaVersion",
    "enabled",
    "provider",
    "maximumCalls",
    "maximumUsd",
    "timeoutMs",
    "waveBudgetMs",
    "maximumWaves",
    "concurrency",
  ]);
  literal(root.schemaVersion, VISUAL_ROLLOUT_CONFIGURATION_SCHEMA_VERSION, `${path}.schemaVersion`);
  if (root.enabled !== true) invalid(`${path}.enabled`, "must be boolean true or false");
  if (root.concurrency !== 1) invalid(`${path}.concurrency`, "must equal one");
  return {
    schemaVersion: VISUAL_ROLLOUT_CONFIGURATION_SCHEMA_VERSION,
    enabled: true,
    provider: oneOf(root.provider, VISUAL_PROVIDER_SELECTORS, `${path}.provider`),
    maximumCalls: positiveInteger(root.maximumCalls, `${path}.maximumCalls`, 10_000),
    maximumUsd: positiveFinite(root.maximumUsd, `${path}.maximumUsd`, 1_000),
    timeoutMs: integerRange(root.timeoutMs, `${path}.timeoutMs`, 1_000, 300_000),
    waveBudgetMs: integerRange(root.waveBudgetMs, `${path}.waveBudgetMs`, 1_000, 420_000),
    maximumWaves: positiveInteger(root.maximumWaves, `${path}.maximumWaves`, 1_000),
    concurrency: 1,
  };
}

function normalizeInferenceFingerprint(value: unknown, path: string): VisualInferenceFingerprint {
  const root = object(value, path, ["provider", "model", "transport", "configurationSha256", "prompt", "responseSchema"]);
  return {
    provider: boundedString(root.provider, `${path}.provider`, 300),
    model: boundedString(root.model, `${path}.model`, 300),
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
  const maximumVisualCalls = nonnegativeInteger(root.maximumVisualCalls, `${path}.maximumVisualCalls`, 10_000);
  const maximumVisualUsd = nonnegativeFinite(root.maximumVisualUsd, `${path}.maximumVisualUsd`, 1_000);
  if (state !== "authorized" && (maximumVisualCalls !== 0 || maximumVisualUsd !== 0)) {
    invalid(path, "disabled/invalid authorization must seal zero calls and zero USD");
  }
  if (state === "authorized" && (maximumVisualCalls === 0 || maximumVisualUsd === 0)) {
    invalid(path, "authorized rollout requires positive call and USD caps");
  }
  return {
    state,
    rolloutConfigurationSha256: hash(root.rolloutConfigurationSha256, `${path}.rolloutConfigurationSha256`),
    maximumVisualCalls,
    maximumVisualUsd,
  };
}

function normalizeVersionHash(value: unknown, path: string): { version: string; sha256: string } {
  const root = object(value, path, ["version", "sha256"]);
  return { version: boundedString(root.version, `${path}.version`, 300), sha256: hash(root.sha256, `${path}.sha256`) };
}

async function rolloutFingerprintSha256(value: VisualProgressRolloutSeal): Promise<string> {
  return value.state === "valid" ? canonicalHash(value.configuration) : Promise.resolve(value.recognizedInputSha256);
}

function normalizeExpected(value: VisualProgressExpected, path: string): VisualProgressExpected {
  const root = objectAtLeast(value, path);
  const allowed = new Set([...CORE_KEYS, "ownership"]);
  for (const key of Object.keys(root)) {
    if (!allowed.has(key as (typeof CORE_KEYS)[number] | "ownership")) invalid(path, `unknown field ${JSON.stringify(key)}`);
  }
  for (const key of CORE_KEYS) {
    if (key === "coverageFinalizedAt") continue;
    if (!Object.prototype.hasOwnProperty.call(root, key)) invalid(path, `missing field ${JSON.stringify(key)}`);
  }
  if (!Object.prototype.hasOwnProperty.call(root, "ownership")) invalid(path, "missing field \"ownership\"");
  const base = normalizeCoreWithoutFinalizedAt(root, path);
  const coverageFinalizedAt = root.coverageFinalizedAt === undefined
    ? undefined
    : isoTimestamp(root.coverageFinalizedAt, `${path}.coverageFinalizedAt`);
  return { ...base, ownership: normalizeOwnership(root.ownership, `${path}.ownership`), coverageFinalizedAt };
}

function normalizeIdentityExpected(value: VisualProgressIdentityExpected, path: string): VisualProgressIdentityExpected {
  const root = object(value, path, ["runId", "planRevisionId", "visualWorkManifestSha256", "denominatorItemCount"]);
  return {
    runId: keySegment(root.runId, `${path}.runId`),
    planRevisionId: boundedString(root.planRevisionId, `${path}.planRevisionId`, MAX_SEGMENT_CHARS),
    visualWorkManifestSha256: hash(root.visualWorkManifestSha256, `${path}.visualWorkManifestSha256`),
    denominatorItemCount: nonnegativeInteger(root.denominatorItemCount, `${path}.denominatorItemCount`, MAX_DENOMINATOR_ITEMS),
  };
}

function identityFrom(value: VisualProgressIdentityExpected): VisualProgressIdentityExpected {
  return {
    runId: value.runId,
    planRevisionId: value.planRevisionId,
    visualWorkManifestSha256: value.visualWorkManifestSha256,
    denominatorItemCount: value.denominatorItemCount,
  };
}

function normalizeCore(value: Record<string, unknown>, path: string): VisualProgressCoreBinding {
  return {
    ...normalizeCoreWithoutFinalizedAt(value, path),
    coverageFinalizedAt: isoTimestamp(value.coverageFinalizedAt, `${path}.coverageFinalizedAt`),
  };
}

function normalizeCoreWithoutFinalizedAt(value: Record<string, unknown>, path: string): Omit<VisualProgressCoreBinding, "coverageFinalizedAt"> {
  const runId = keySegment(value.runId, `${path}.runId`);
  return {
    runId,
    planRevisionId: boundedString(value.planRevisionId, `${path}.planRevisionId`, MAX_SEGMENT_CHARS),
    visualWorkManifestSha256: hash(value.visualWorkManifestSha256, `${path}.visualWorkManifestSha256`),
    denominatorItemCount: nonnegativeInteger(value.denominatorItemCount, `${path}.denominatorItemCount`, MAX_DENOMINATOR_ITEMS),
    configurationFingerprintSha256: hash(value.configurationFingerprintSha256, `${path}.configurationFingerprintSha256`),
    modelFingerprintSha256: hash(value.modelFingerprintSha256, `${path}.modelFingerprintSha256`),
    authorizationFingerprintSha256: hash(value.authorizationFingerprintSha256, `${path}.authorizationFingerprintSha256`),
    authoritySeal: normalizeAuthorityRef(value.authoritySeal, `${path}.authoritySeal`, runId),
  };
}

function coreWithoutFinalizedAt(value: VisualProgressExpected): Omit<VisualProgressCoreBinding, "coverageFinalizedAt"> {
  return {
    runId: value.runId,
    planRevisionId: value.planRevisionId,
    visualWorkManifestSha256: value.visualWorkManifestSha256,
    denominatorItemCount: value.denominatorItemCount,
    configurationFingerprintSha256: value.configurationFingerprintSha256,
    modelFingerprintSha256: value.modelFingerprintSha256,
    authorizationFingerprintSha256: value.authorizationFingerprintSha256,
    authoritySeal: value.authoritySeal,
  };
}

function coreFrom(value: VisualProgressCoreBinding): VisualProgressCoreBinding {
  return {
    runId: value.runId,
    planRevisionId: value.planRevisionId,
    visualWorkManifestSha256: value.visualWorkManifestSha256,
    denominatorItemCount: value.denominatorItemCount,
    configurationFingerprintSha256: value.configurationFingerprintSha256,
    modelFingerprintSha256: value.modelFingerprintSha256,
    authorizationFingerprintSha256: value.authorizationFingerprintSha256,
    authoritySeal: value.authoritySeal,
    coverageFinalizedAt: value.coverageFinalizedAt,
  };
}

function normalizeOwnership(value: unknown, path: string): VisualProgressOwnership {
  const root = object(value, path, ["instanceId", "epoch"]);
  return {
    instanceId: boundedString(root.instanceId, `${path}.instanceId`, MAX_SEGMENT_CHARS),
    epoch: nonnegativeInteger(root.epoch, `${path}.epoch`, Number.MAX_SAFE_INTEGER),
  };
}

function normalizeCursor(value: unknown, path: string): VisualProgressCursor {
  const root = object(value, path, [
    "stateContentSha256",
    "stateRevision",
    "completedWaveCount",
    "nextDenominatorOrdinal",
    "shardChainSha256",
  ]);
  return {
    stateContentSha256: hash(root.stateContentSha256, `${path}.stateContentSha256`),
    stateRevision: nonnegativeInteger(root.stateRevision, `${path}.stateRevision`, MAX_STATE_REVISIONS),
    completedWaveCount: nonnegativeInteger(root.completedWaveCount, `${path}.completedWaveCount`, MAX_WAVES),
    nextDenominatorOrdinal: nonnegativeInteger(root.nextDenominatorOrdinal, `${path}.nextDenominatorOrdinal`, MAX_DENOMINATOR_ITEMS),
    shardChainSha256: hash(root.shardChainSha256, `${path}.shardChainSha256`),
  };
}

function normalizeItems(value: unknown, start: number, denominatorCount: number, path: string): VisualProgressItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > VISUAL_PROGRESS_MAX_ITEMS_PER_WAVE) {
    invalid(path, `must be a non-empty array with at most ${VISUAL_PROGRESS_MAX_ITEMS_PER_WAVE} entries`);
  }
  if (start + value.length > denominatorCount) invalid(path, "wave exceeds the fixed denominator item count");
  return value.map((item, index) => normalizeItem(item, start + index, `${path}[${index}]`));
}

function normalizeItem(value: unknown, expectedOrdinal: number, path: string): VisualProgressItem {
  const root = object(value, path, ["denominatorOrdinal", "workItemSha256", "disposition", "detail", "success"]);
  const denominatorOrdinal = nonnegativeInteger(root.denominatorOrdinal, `${path}.denominatorOrdinal`, MAX_DENOMINATOR_ITEMS - 1);
  if (denominatorOrdinal !== expectedOrdinal) invalid(`${path}.denominatorOrdinal`, `must be contiguous ordinal ${expectedOrdinal}`);
  const disposition = oneOf(root.disposition, VISUAL_COVERAGE_DISPOSITIONS, `${path}.disposition`);
  const detail = root.detail === null ? null : boundedString(root.detail, `${path}.detail`, MAX_TEXT);
  const success = root.success === null ? null : normalizeSuccess(root.success, `${path}.success`);
  if (disposition === "observed-stored") {
    if (detail !== null || success === null) invalid(path, "observed-stored requires success refs and null detail");
  } else if (detail === null || success !== null) {
    invalid(path, "every non-success disposition requires a named detail and null success refs");
  }
  return { denominatorOrdinal, workItemSha256: hash(root.workItemSha256, `${path}.workItemSha256`), disposition, detail, success };
}

function normalizeSuccess(value: unknown, path: string): VisualCoverageSuccessRefs {
  const root = object(value, path, ["epochDigest", "inferenceDigest", "observation", "reconciliation", "grounded"]);
  return {
    epochDigest: hash(root.epochDigest, `${path}.epochDigest`),
    inferenceDigest: hash(root.inferenceDigest, `${path}.inferenceDigest`),
    observation: normalizeArtifactRef(root.observation, `${path}.observation`),
    reconciliation: normalizeArtifactRef(root.reconciliation, `${path}.reconciliation`),
    grounded: normalizeArtifactRef(root.grounded, `${path}.grounded`),
  };
}

function normalizeArtifactRef(value: unknown, path: string): VisualProgressArtifactRef {
  const root = object(value, path, ["key", "contentSha256"]);
  return { key: storageKey(root.key, `${path}.key`), contentSha256: hash(root.contentSha256, `${path}.contentSha256`) };
}

function normalizeAuthorityRef(value: unknown, path: string, runId: string): VisualProgressArtifactRef {
  const ref = normalizeArtifactRef(value, path);
  if (ref.key !== visualProgressAuthorityKey(runId, ref.contentSha256)) {
    invalid(`${path}.key`, "is not the bound content-addressed authority key");
  }
  return ref;
}

function normalizeStateRef(value: unknown, path: string, runId: string): VisualProgressStateRef {
  const root = object(value, path, ["key", "contentSha256", "stateRevision"]);
  const contentSha256 = hash(root.contentSha256, `${path}.contentSha256`);
  const stateRevision = nonnegativeInteger(root.stateRevision, `${path}.stateRevision`, MAX_STATE_REVISIONS);
  const key = storageKey(root.key, `${path}.key`);
  if (key !== visualProgressStateKey(runId, contentSha256)) invalid(`${path}.key`, "is not the bound content-addressed state key");
  return { key, contentSha256, stateRevision };
}

function normalizeWaveRef(value: unknown, path: string, runId: string): VisualProgressWaveRef {
  const root = object(value, path, [
    "key",
    "contentSha256",
    "waveOrdinal",
    "startDenominatorOrdinal",
    "endDenominatorOrdinalExclusive",
  ]);
  const contentSha256 = hash(root.contentSha256, `${path}.contentSha256`);
  const waveOrdinal = nonnegativeInteger(root.waveOrdinal, `${path}.waveOrdinal`, MAX_WAVES - 1);
  const startDenominatorOrdinal = nonnegativeInteger(root.startDenominatorOrdinal, `${path}.startDenominatorOrdinal`, MAX_DENOMINATOR_ITEMS);
  const endDenominatorOrdinalExclusive = nonnegativeInteger(
    root.endDenominatorOrdinalExclusive,
    `${path}.endDenominatorOrdinalExclusive`,
    MAX_DENOMINATOR_ITEMS,
  );
  if (endDenominatorOrdinalExclusive <= startDenominatorOrdinal) {
    invalid(`${path}.endDenominatorOrdinalExclusive`, "must be greater than the start ordinal");
  }
  const key = storageKey(root.key, `${path}.key`);
  if (key !== visualProgressWaveKey(runId, waveOrdinal, contentSha256)) invalid(`${path}.key`, "is not the bound wave key");
  return { key, contentSha256, waveOrdinal, startDenominatorOrdinal, endDenominatorOrdinalExclusive };
}

function normalizePurchaseChannel(value: unknown, path: string): VisualProgressPurchaseChannel {
  const loose = objectAtLeast(value, path);
  if (loose.state === "exhausted") {
    const root = object(value, path, ["state", "originatingStop"]);
    const stop = object(root.originatingStop, `${path}.originatingStop`, [
      "code",
      "detail",
      "waveOrdinal",
      "denominatorOrdinal",
      "remainderDisposition",
    ]);
    const code = boundedString(stop.code, `${path}.originatingStop.code`, 120);
    if (!BLOCKER_CODE.test(code)) invalid(`${path}.originatingStop.code`, "must be a stable lowercase dotted/dashed name");
    literal(stop.remainderDisposition, "budget-not-authorized", `${path}.originatingStop.remainderDisposition`);
    return {
      state: "exhausted",
      originatingStop: {
        code,
        detail: boundedString(stop.detail, `${path}.originatingStop.detail`, MAX_TEXT),
        waveOrdinal: nonnegativeInteger(stop.waveOrdinal, `${path}.originatingStop.waveOrdinal`, MAX_WAVES - 1),
        denominatorOrdinal: nonnegativeInteger(
          stop.denominatorOrdinal,
          `${path}.originatingStop.denominatorOrdinal`,
          MAX_DENOMINATOR_ITEMS - 1,
        ),
        remainderDisposition: "budget-not-authorized",
      },
    };
  }
  const root = object(value, path, ["state", "originatingBlocker"]);
  if (root.state === "open") {
    if (root.originatingBlocker !== null) invalid(`${path}.originatingBlocker`, "open channel must not claim a blocker");
    return openPurchaseChannel();
  }
  literal(root.state, "blocked", `${path}.state`);
  const blocker = object(root.originatingBlocker, `${path}.originatingBlocker`, [
    "code",
    "detail",
    "waveOrdinal",
    "denominatorOrdinal",
    "disposition",
  ]);
  const code = boundedString(blocker.code, `${path}.originatingBlocker.code`, 120);
  if (!BLOCKER_CODE.test(code)) invalid(`${path}.originatingBlocker.code`, "must be a stable lowercase dotted/dashed name");
  const disposition = oneOf(
    blocker.disposition,
    ["purchase-blocked", "accounting-failed", "persistence-failed", "rollout-config-invalid"] as const,
    `${path}.originatingBlocker.disposition`,
  );
  return {
    state: "blocked",
    originatingBlocker: {
      code,
      detail: boundedString(blocker.detail, `${path}.originatingBlocker.detail`, MAX_TEXT),
      waveOrdinal: nonnegativeInteger(blocker.waveOrdinal, `${path}.originatingBlocker.waveOrdinal`, MAX_WAVES - 1),
      denominatorOrdinal: nonnegativeInteger(
        blocker.denominatorOrdinal,
        `${path}.originatingBlocker.denominatorOrdinal`,
        MAX_DENOMINATOR_ITEMS - 1,
      ),
      disposition,
    },
  };
}

function assertPurchaseTransition(
  before: VisualProgressPurchaseChannel,
  after: VisualProgressPurchaseChannel,
  waveOrdinal: number,
  items: VisualProgressItem[],
  path: string,
): void {
  if (before.state !== "open") {
    if (canonicalJson(after) !== canonicalJson(before)) invalid(`${path}.purchaseChannelAfter`, "non-open purchase channel cannot reopen or change origin");
    if (before.state === "exhausted") {
      for (const item of items) {
        if (item.disposition !== before.originatingStop.remainderDisposition || item.detail !== before.originatingStop.detail) {
          invalid(`${path}.items`, "items appended after exhaustion must mechanically close with the sealed remainder disposition/detail");
        }
      }
    } else {
      for (const item of items) {
        if (item.disposition !== "purchase-blocked" || item.detail !== before.originatingBlocker.detail) {
          invalid(`${path}.items`, "items appended after a purchase blocker must name that origin and issue no new purchase");
        }
      }
    }
    return;
  }
  if (after.state === "open") return;
  if (after.state === "exhausted") {
    const stop = after.originatingStop;
    const start = items[0]!.denominatorOrdinal;
    const end = items[items.length - 1]!.denominatorOrdinal + 1;
    if (stop.waveOrdinal !== waveOrdinal || stop.denominatorOrdinal < start || stop.denominatorOrdinal > end) {
      invalid(`${path}.purchaseChannelAfter`, "new exhaustion stop must originate at this wave's bounded cursor");
    }
    for (const item of items) {
      if (
        item.denominatorOrdinal >= stop.denominatorOrdinal &&
        (item.disposition !== stop.remainderDisposition || item.detail !== stop.detail)
      ) {
        invalid(`${path}.items`, "items at/after the exhaustion cursor must use the sealed remainder disposition/detail");
      }
    }
    return;
  }
  const blocker = after.originatingBlocker;
  if (blocker.waveOrdinal !== waveOrdinal) invalid(`${path}.purchaseChannelAfter`, "new blocker must originate in this wave");
  const origin = items.find((item) => item.denominatorOrdinal === blocker.denominatorOrdinal);
  if (!origin || origin.disposition !== blocker.disposition || origin.detail !== blocker.detail) {
    invalid(`${path}.purchaseChannelAfter`, "new blocker must exactly bind one blocking item in this wave");
  }
  for (const item of items) {
    if (
      item.denominatorOrdinal > blocker.denominatorOrdinal &&
      (item.disposition !== "purchase-blocked" || item.detail !== blocker.detail)
    ) {
      invalid(`${path}.items`, "items after a purchase blocker must close mechanically with the named origin");
    }
  }
}

function assertExpected(value: VisualProgressCoreBinding & { ownership: VisualProgressOwnership }, expected: VisualProgressExpected, path: string): void {
  assertCoreExpected(value, expected, path);
  if (!sameOwnership(value.ownership, expected.ownership)) {
    throw new VisualProgressConflictError(`${path} ownership fence drift`);
  }
}

function assertCoreExpected(value: VisualProgressCoreBinding, expected: VisualProgressExpected, path: string): void {
  const actual = coreFrom(value);
  const wanted = {
    ...coreWithoutFinalizedAt(expected),
    ...(expected.coverageFinalizedAt === undefined ? {} : { coverageFinalizedAt: expected.coverageFinalizedAt }),
  };
  for (const [key, expectedValue] of Object.entries(wanted)) {
    if (canonicalJson(actual[key as keyof VisualProgressCoreBinding]) !== canonicalJson(expectedValue)) {
      throw new VisualProgressConflictError(`${path}.${key} drift`);
    }
  }
}

function assertIdentityExpected(
  value: VisualProgressIdentityExpected,
  expected: VisualProgressIdentityExpected,
  path: string,
): void {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key as keyof VisualProgressIdentityExpected] !== expectedValue) {
      throw new VisualProgressConflictError(`${path}.${key} work-identity drift`);
    }
  }
}

function assertSameCore(a: VisualProgressCoreBinding, b: VisualProgressCoreBinding, path: string): void {
  if (canonicalJson(coreFrom(a)) !== canonicalJson(coreFrom(b))) corrupt(path, "core progress binding drifted");
}

function assertAuthorityBindsCore(
  authority: VisualProgressAuthoritySeal,
  core: VisualProgressCoreBinding,
  key: string,
): void {
  if (
    authority.configurationFingerprintSha256 !== core.configurationFingerprintSha256 ||
    authority.modelFingerprintSha256 !== core.modelFingerprintSha256 ||
    authority.authorizationFingerprintSha256 !== core.authorizationFingerprintSha256
  ) {
    corrupt(key, "authority object hashes do not match the progress core binding");
  }
}

function assertCursor(snapshot: VisualProgressHead, cursor: VisualProgressCursor, path: string): void {
  const actual = visualProgressCursor(snapshot);
  if (canonicalJson(actual) !== canonicalJson(cursor)) throw new VisualProgressConflictError(`${path} drifted from the fixed head`);
}

async function assertCurrentCheckpointOwnership(
  env: Env,
  runId: string,
  mine: VisualProgressOwnership,
): Promise<void> {
  const loaded = await loadCheckpoint(env, runId);
  const current = loaded?.checkpoint.ownership ?? null;
  if (current === null || current.instanceId !== mine.instanceId || current.epoch !== mine.epoch) {
    throw new OwnershipLost(runId, mine, current);
  }
}

function openPurchaseChannel(): VisualProgressPurchaseChannel {
  return { state: "open", originatingBlocker: null };
}

function sameOwnership(a: VisualProgressOwnership, b: VisualProgressOwnership): boolean {
  return a.instanceId === b.instanceId && a.epoch === b.epoch;
}

function sameNullableWaveRef(a: VisualProgressWaveRef | null, b: VisualProgressWaveRef | null): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function sameStateRef(a: VisualProgressStateRef | null, b: VisualProgressStateRef): boolean {
  return a !== null && canonicalJson(a) === canonicalJson(b);
}

async function genesisChainSha256(core: VisualProgressCoreBinding): Promise<string> {
  return canonicalHash({ kind: GENESIS_CHAIN_KIND, ...coreFrom(core) });
}

async function nextChainSha256(previousChainSha256: string, shard: VisualProgressWaveRef): Promise<string> {
  return canonicalHash({ kind: CHAIN_LINK_KIND, previousChainSha256, shard });
}

function canonicalBytes(value: unknown, maxBytes: number, path: string): Uint8Array {
  const bytes = enc.encode(canonicalJson(value));
  if (bytes.byteLength > maxBytes) invalid(path, `canonical object exceeds ${maxBytes} bytes`);
  return bytes;
}

function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  const root = objectAtLeast(value, path);
  const expected = new Set(keys);
  for (const key of Object.keys(root)) if (!expected.has(key)) invalid(path, `unknown field ${JSON.stringify(key)}`);
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(root, key)) invalid(path, `missing field ${JSON.stringify(key)}`);
  return root;
}

function objectAtLeast(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "must be a plain JSON object");
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) invalid(path, "must be a plain JSON object");
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !wellFormed(value)) {
    invalid(path, `must be a non-empty well-formed string of at most ${max} characters`);
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
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    invalid(path, `must be a safe integer in [0, ${max}]`);
  }
  return value;
}

function positiveInteger(value: unknown, path: string, max: number): number {
  const parsed = nonnegativeInteger(value, path, max);
  if (parsed === 0) invalid(path, "must be positive");
  return parsed;
}

function integerRange(value: unknown, path: string, min: number, max: number): number {
  const parsed = nonnegativeInteger(value, path, max);
  if (parsed < min) invalid(path, `must be in [${min}, ${max}]`);
  return parsed;
}

function nonnegativeFinite(value: unknown, path: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    invalid(path, `must be finite in [0, ${max}]`);
  }
  return value;
}

function positiveFinite(value: unknown, path: string, max: number): number {
  const parsed = nonnegativeFinite(value, path, max);
  if (parsed === 0) invalid(path, "must be positive");
  return parsed;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) invalid(path, `must be one of ${allowed.join(", ")}`);
  return value as T[number];
}

function literal<T extends string>(value: unknown, expected: T, path: string): asserts value is T {
  if (value !== expected) invalid(path, `must equal ${JSON.stringify(expected)}`);
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

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let different = 0;
  for (let index = 0; index < a.byteLength; index += 1) different |= a[index]! ^ b[index]!;
  return different === 0;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return wellFormed(message) ? message.slice(0, MAX_TEXT) : "invalid visual progress artifact";
}

function corrupt(key: string, detail: string): never {
  throw new VisualProgressCorruptionError(key, detail);
}

function invalid(path: string, detail: string): never {
  throw new VisualProgressValidationError(path, detail);
}

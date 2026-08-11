/**
 * PURE CLOSED-COVERAGE ASSEMBLY FOR THE VISUAL SHADOW CHANNEL.
 *
 * Progress shards record a contiguous processed prefix. This module joins that prefix back to
 * the independently derived VisualWorkManifest denominator and mechanically closes everything
 * left over. It performs no storage, provider call, document comparison, or verdict operation.
 */

import {
  VISUAL_COVERAGE_DISPOSITIONS,
  deriveVisualCoverageDenominator,
  type VisualCoverageDenominatorItem,
  type VisualCoverageDisposition,
  type VisualCoverageEntry,
  type VisualCoverageSuccessRefs,
} from "../../store/visual-coverage";
import type { VisualWorkManifest } from "../../store/visual-work";
import type { ProcessVisualEpochResult } from "./visual-epoch";

const HASH = /^[0-9a-f]{64}$/;
const MAX_DETAIL = 4_000;
const EMPTY_INVENTORY_LIMITATION = "model-inventory-empty-despite-paired-content" as const;
const IDENTITY_MISMATCH_LIMITATION = "model-identity-mismatch" as const;

export interface VisualProcessedCoverageItem {
  denominatorOrdinal: number;
  workItemSha256: string;
  disposition: VisualCoverageDisposition;
  detail: string | null;
  success: VisualCoverageSuccessRefs | null;
}

export type VisualCoverageRemainderPosture =
  | { state: "disabled"; detail: string }
  | { state: "invalid"; detail: string }
  | { state: "budget-exhausted"; detail: string }
  | { state: "purchase-blocked"; detail: string }
  | { state: "wave-limit"; detail: string };

export class VisualCoverageClosureError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "VisualCoverageClosureError";
  }
}

export async function closeVisualCoverageEntries(input: {
  workManifest: VisualWorkManifest;
  inferenceFingerprintSha256: string;
  authorizationFingerprintSha256: string;
  processed: readonly VisualProcessedCoverageItem[];
  remainder: VisualCoverageRemainderPosture;
}): Promise<VisualCoverageEntry[]> {
  const inferenceFingerprintSha256 = hash(
    input.inferenceFingerprintSha256,
    "$.inferenceFingerprintSha256",
  );
  const authorizationFingerprintSha256 = hash(
    input.authorizationFingerprintSha256,
    "$.authorizationFingerprintSha256",
  );
  const denominator = await deriveVisualCoverageDenominator(input.workManifest);
  if (!Array.isArray(input.processed)) invalid("$.processed", "expected an array");
  if (input.processed.length > denominator.length) {
    invalid("$.processed", "contains more rows than the closed denominator");
  }
  const remainder = normalizeRemainder(input.remainder);
  const entries: VisualCoverageEntry[] = [];

  for (let ordinal = 0; ordinal < input.processed.length; ordinal += 1) {
    const item = normalizeProcessed(input.processed[ordinal], ordinal);
    const expected = denominator[ordinal]!;
    if (item.denominatorOrdinal !== ordinal) {
      invalid(`$.processed[${ordinal}].denominatorOrdinal`, "must be the exact contiguous prefix ordinal");
    }
    if (item.workItemSha256 !== expected.workItemSha256) {
      invalid(`$.processed[${ordinal}].workItemSha256`, "does not bind the denominator row");
    }
    assertProcessedCompatible(item, expected, `$.processed[${ordinal}]`);
    entries.push({
      item: expected,
      inferenceFingerprintSha256,
      authorizationFingerprintSha256,
      disposition: item.disposition,
      detail: item.detail,
      success: item.success,
    });
  }

  for (let ordinal = input.processed.length; ordinal < denominator.length; ordinal += 1) {
    const expected = denominator[ordinal]!;
    const limitation = mechanicalLimitation(expected) ?? remainderLimitation(remainder);
    entries.push({
      item: expected,
      inferenceFingerprintSha256,
      authorizationFingerprintSha256,
      disposition: limitation.disposition,
      detail: limitation.detail,
      success: null,
    });
  }
  return entries;
}

/** Convert the processor's observation-only output into the compact progress/coverage row. */
export function visualProcessedItemFromEpochResult(
  denominatorOrdinal: number,
  denominator: VisualCoverageDenominatorItem,
  result: ProcessVisualEpochResult,
): VisualProcessedCoverageItem {
  if (!Number.isSafeInteger(denominatorOrdinal) || denominatorOrdinal < 0) {
    invalid("$.denominatorOrdinal", "expected a non-negative safe integer");
  }
  if (denominator.kind !== "epoch" || denominator.eligibility !== "eligible") {
    invalid("$.denominator", "processor results may bind only preparation-eligible epoch rows");
  }
  const work = result.work;
  if (
    work.walkOrdinal !== denominator.walkOrdinal ||
    work.epochOrdinal !== denominator.epochOrdinal ||
    work.pathId !== denominator.pathId ||
    work.attemptId !== denominator.attemptId ||
    work.epochId !== denominator.epochId ||
    work.stepIndex !== denominator.stepIndex ||
    work.slot !== denominator.slot
  ) {
    invalid("$.result.work", "does not exactly bind the denominator epoch identity");
  }

  if (result.state === "input-ineligible") {
    return {
      denominatorOrdinal,
      workItemSha256: denominator.workItemSha256,
      disposition: "input-integrity-failed",
      detail: detail(`Exact epoch input failed closed validation (${result.limitation.kind}); no model call was authorized.`),
      success: null,
    };
  }

  if (
    !Array.isArray(result.observation.limitationKinds) ||
    result.observation.limitationKinds.some((kind) => typeof kind !== "string")
  ) {
    invalid("$.result.observation.limitationKinds", "expected the exact stored observation limitation kinds");
  }
  if (result.readState === "observed" && result.observation.limitationKinds.includes(EMPTY_INVENTORY_LIMITATION)) {
    return limitationItem(
      denominatorOrdinal,
      denominator,
      "provider-malformed",
      `The stored observation carries ${EMPTY_INVENTORY_LIMITATION}; paired readers contained content but the model returned an unqualified empty inventory, so zero is not visual coverage.`,
    );
  }
  if (result.readState === "observed") {
    return {
      denominatorOrdinal,
      workItemSha256: denominator.workItemSha256,
      disposition: "observed-stored",
      detail: null,
      success: {
        epochDigest: result.groundedEpoch.storage.digest,
        inferenceDigest: result.inference.digest,
        observation: {
          key: result.observation.storage.key,
          contentSha256: result.observation.contentSha256,
        },
        reconciliation: {
          key: result.reconciliation.storage.key,
          contentSha256: result.reconciliation.contentSha256,
        },
        grounded: {
          key: result.groundedEpoch.storage.key,
          contentSha256: result.groundedEpoch.contentSha256,
        },
      },
    };
  }
  if (result.readState === "malformed") {
    // FIX (review vision-billing finding E1): a provider model-echo drift now closes the epoch
    // as a stored, counted limitation instead of throwing (visual-epoch.ts). The disposition
    // stays inside the existing closed vocabulary ("provider-malformed" = the settled response
    // violated the closed contract), but the detail must name the telemetry-identity mismatch:
    // the generic text below would falsely claim a schema failure for a schema-valid response.
    if (result.observation.limitationKinds.includes(IDENTITY_MISMATCH_LIMITATION)) {
      return limitationItem(
        denominatorOrdinal,
        denominator,
        "provider-malformed",
        `The stored observation carries ${IDENTITY_MISMATCH_LIMITATION}; the provider-reported model identity did not match the requested model, so the settled response was refused and no visual facts were admitted.`,
      );
    }
    return limitationItem(
      denominatorOrdinal,
      denominator,
      "provider-malformed",
      "The settled visual response failed the closed observation schema; no visual facts were admitted.",
    );
  }
  if (result.readState === "timeout" || result.readState === "unavailable") {
    return limitationItem(
      denominatorOrdinal,
      denominator,
      "provider-unavailable",
      `The settled visual provider outcome was ${result.readState}; no visual facts were admitted.`,
    );
  }
  invalid("$.result.readState", "input-invalid cannot be a stored, settled epoch result");
}

/** Record a denominator row that is mechanically ineligible without invoking the processor. */
export function visualProcessedMechanicalItem(
  denominatorOrdinal: number,
  denominator: VisualCoverageDenominatorItem,
): VisualProcessedCoverageItem {
  if (!Number.isSafeInteger(denominatorOrdinal) || denominatorOrdinal < 0) {
    invalid("$.denominatorOrdinal", "expected a non-negative safe integer");
  }
  const limitation = mechanicalLimitation(denominator);
  if (limitation === null) {
    invalid("$.denominator", "preparation-eligible epochs do not have a mechanical limitation");
  }
  return limitationItem(
    denominatorOrdinal,
    denominator,
    limitation.disposition,
    limitation.detail,
  );
}

/** Build one named non-success row for an eligible epoch after a classified orchestration stop. */
export function visualProcessedLimitationItem(
  denominatorOrdinal: number,
  denominator: VisualCoverageDenominatorItem,
  disposition: Exclude<VisualCoverageDisposition, "observed-stored" | "input-ineligible">,
  message: string,
): VisualProcessedCoverageItem {
  if (!Number.isSafeInteger(denominatorOrdinal) || denominatorOrdinal < 0) {
    invalid("$.denominatorOrdinal", "expected a non-negative safe integer");
  }
  if (denominator.kind !== "epoch" || denominator.eligibility !== "eligible") {
    invalid("$.denominator", "classified orchestration limitations may bind only eligible epochs");
  }
  if (!(VISUAL_COVERAGE_DISPOSITIONS as readonly string[]).includes(disposition)) {
    invalid("$.disposition", "expected a non-success visual coverage disposition");
  }
  return limitationItem(denominatorOrdinal, denominator, disposition, message);
}

function limitationItem(
  denominatorOrdinal: number,
  denominator: VisualCoverageDenominatorItem,
  disposition: VisualCoverageDisposition,
  message: string,
): VisualProcessedCoverageItem {
  return {
    denominatorOrdinal,
    workItemSha256: denominator.workItemSha256,
    disposition,
    detail: detail(message),
    success: null,
  };
}

function mechanicalLimitation(
  item: VisualCoverageDenominatorItem,
): { disposition: VisualCoverageDisposition; detail: string } | null {
  if (item.kind === "walk-epochs-unknown") {
    return item.walkResolution === "verified"
      ? {
          disposition: "input-ineligible",
          detail: "The walk is verified but its visual capture-epoch denominator is unknown; no model call was authorized.",
        }
      : {
          disposition: "input-integrity-failed",
          detail: `The walk artifact resolution was ${item.walkResolution}, so its visual capture-epoch denominator is unknown.`,
        };
  }
  if (item.kind === "walk-no-epochs") {
    return {
      disposition: "input-ineligible",
      detail: "The verified walk contains a known zero visual capture epochs.",
    };
  }
  if (item.eligibility !== "eligible") {
    return {
      disposition: "input-ineligible",
      detail: `The immutable visual work manifest classified this epoch as ${item.eligibility}; no model call was authorized.`,
    };
  }
  return null;
}

function remainderLimitation(
  posture: VisualCoverageRemainderPosture,
): { disposition: VisualCoverageDisposition; detail: string } {
  switch (posture.state) {
    case "disabled":
      return {
        disposition: "budget-not-authorized",
        detail: detail(`Visual shadow inference was disabled; no call was attempted. ${posture.detail}`),
      };
    case "invalid":
      return {
        disposition: "rollout-config-invalid",
        detail: detail(`Visual rollout authority was invalid; no call was attempted. ${posture.detail}`),
      };
    case "budget-exhausted":
      return {
        disposition: "budget-not-authorized",
        detail: detail(`The sealed visual purchase allowance was exhausted; no call was attempted. ${posture.detail}`),
      };
    case "purchase-blocked":
      return {
        disposition: "purchase-blocked",
        detail: detail(`A prior visual purchase became indeterminate; no call was attempted for this item. ${posture.detail}`),
      };
    case "wave-limit":
      return {
        disposition: "wave-limit-uncovered",
        detail: detail(`The sealed visual wave limit was reached before this item; no call was attempted. ${posture.detail}`),
      };
  }
}

function assertProcessedCompatible(
  item: VisualProcessedCoverageItem,
  expected: VisualCoverageDenominatorItem,
  path: string,
): void {
  const mechanical = mechanicalLimitation(expected);
  if (mechanical !== null && item.disposition !== mechanical.disposition) {
    invalid(`${path}.disposition`, `the denominator mechanically requires ${mechanical.disposition}`);
  }
  if (mechanical === null && item.disposition === "input-ineligible") {
    invalid(`${path}.disposition`, "a preparation-eligible epoch cannot be reclassified as input-ineligible");
  }
  if (item.disposition === "observed-stored") {
    if (expected.kind !== "epoch" || item.success === null || item.detail !== null) {
      invalid(path, "observed-stored requires an epoch, complete success refs, and null detail");
    }
  } else if (item.success !== null || item.detail === null) {
    invalid(path, "a limitation requires null success refs and a named detail");
  }
}

function normalizeProcessed(value: unknown, index: number): VisualProcessedCoverageItem {
  if (!isRecord(value)) invalid(`$.processed[${index}]`, "expected an object");
  const expected = ["denominatorOrdinal", "workItemSha256", "disposition", "detail", "success"];
  exactKeys(value, expected, `$.processed[${index}]`);
  const denominatorOrdinal = value.denominatorOrdinal;
  if (!Number.isSafeInteger(denominatorOrdinal) || (denominatorOrdinal as number) < 0) {
    invalid(`$.processed[${index}].denominatorOrdinal`, "expected a non-negative safe integer");
  }
  const disposition = value.disposition;
  if (
    typeof disposition !== "string" ||
    !(VISUAL_COVERAGE_DISPOSITIONS as readonly string[]).includes(disposition)
  ) {
    invalid(`$.processed[${index}].disposition`, "unknown visual coverage disposition");
  }
  const rawDetail = value.detail;
  if (rawDetail !== null && (typeof rawDetail !== "string" || rawDetail.length === 0 || rawDetail.length > MAX_DETAIL)) {
    invalid(`$.processed[${index}].detail`, `expected null or 1..${MAX_DETAIL} characters`);
  }
  const success = value.success === null
    ? null
    : normalizeSuccess(value.success, `$.processed[${index}].success`);
  return {
    denominatorOrdinal: denominatorOrdinal as number,
    workItemSha256: hash(value.workItemSha256, `$.processed[${index}].workItemSha256`),
    disposition: disposition as VisualCoverageDisposition,
    detail: rawDetail as string | null,
    success,
  };
}

function normalizeSuccess(value: unknown, path: string): VisualCoverageSuccessRefs {
  if (!isRecord(value)) invalid(path, "expected an object");
  exactKeys(value, ["epochDigest", "inferenceDigest", "observation", "reconciliation", "grounded"], path);
  return {
    epochDigest: hash(value.epochDigest, `${path}.epochDigest`),
    inferenceDigest: hash(value.inferenceDigest, `${path}.inferenceDigest`),
    observation: artifactRef(value.observation, `${path}.observation`),
    reconciliation: artifactRef(value.reconciliation, `${path}.reconciliation`),
    grounded: artifactRef(value.grounded, `${path}.grounded`),
  };
}

function artifactRef(value: unknown, path: string): { key: string; contentSha256: string } {
  if (!isRecord(value)) invalid(path, "expected an object");
  exactKeys(value, ["key", "contentSha256"], path);
  if (typeof value.key !== "string" || value.key.length === 0 || value.key.length > 1_024) {
    invalid(`${path}.key`, "expected a bounded non-empty key");
  }
  return { key: value.key, contentSha256: hash(value.contentSha256, `${path}.contentSha256`) };
}

function normalizeRemainder(value: unknown): VisualCoverageRemainderPosture {
  if (!isRecord(value)) invalid("$.remainder", "expected an object");
  exactKeys(value, ["state", "detail"], "$.remainder");
  if (!["disabled", "invalid", "budget-exhausted", "purchase-blocked", "wave-limit"].includes(String(value.state))) {
    invalid("$.remainder.state", "unknown terminal posture");
  }
  return { state: value.state, detail: detail(value.detail) } as VisualCoverageRemainderPosture;
}

function detail(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid("$.detail", "expected a non-empty diagnostic string");
  }
  const compact = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (compact.length === 0) invalid("$.detail", "diagnostic became empty after normalization");
  return compact.slice(0, MAX_DETAIL);
}

function hash(value: unknown, path: string): string {
  if (typeof value !== "string" || !HASH.test(value)) invalid(path, "expected 64 lowercase hex characters");
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) if (!expected.has(key)) invalid(path, `unknown field ${JSON.stringify(key)}`);
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) invalid(path, `missing field ${JSON.stringify(key)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(path: string, message: string): never {
  throw new VisualCoverageClosureError(path, message);
}

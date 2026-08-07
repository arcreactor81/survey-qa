/**
 * ONE record-integrity check, used by BOTH readers.
 *
 * There were two, and they disagreed: `GET /record` compared the canonical hash against
 * `attestation.recordHash` only, while the report builder also accepted the harness's
 * `attestation.payloadHash`. A real t1-easy record therefore rendered a report whose
 * header said "verified" and, on the same run, 409'd on `/record` as ATTESTATION_INVALID.
 *
 * Two checkers that can disagree about whether the same bytes are trustworthy is the
 * exact defect class this project exists to remove, so there is now one function and both
 * call it.
 *
 * WHAT IT PROVES: the record has not been edited since it was assembled.
 * WHAT IT DOES NOT PROVE: who assembled it. That is the Ed25519 signature over the RFC
 * 8785 canonical digest, which needs the pinned key registry and a filesystem, and is
 * therefore checked offline by pipeline/report/render-report.mjs. Nothing in-Worker may
 * present integrity as authenticity.
 */

import { canonicalHash } from "./hash";

export type IntegrityState = "verified" | "invalid" | "unavailable";

export interface RecordIntegrity {
  state: IntegrityState;
  reason: string;
  /** The digest field the record offered, if any. */
  claimed: string | null;
  computed: string | null;
}

const INTEGRITY_ONLY =
  "This is an INTEGRITY check (the bytes are unchanged since assembly), not an authenticity check. " +
  "The Ed25519 harness signature is verified offline against the pinned key registry, not in the Worker.";

export async function checkRecordIntegrity(record: unknown): Promise<RecordIntegrity> {
  const r = record as { attestation?: { recordHash?: string; payloadHash?: string } } | null;
  const att = r?.attestation;
  if (!att) {
    return { state: "unavailable", reason: "The record carries no attestation block.", claimed: null, computed: null };
  }
  // v2 records carry `recordHash`; the t1-easy harness carries `payloadHash` over the
  // same scope (entire record excluding the attestation). Both are accepted; neither is
  // invented if absent.
  const claimed = att.recordHash ?? att.payloadHash ?? null;
  if (typeof claimed !== "string") {
    return {
      state: "unavailable",
      reason:
        "The attestation block declares neither recordHash nor payloadHash, so integrity could not be checked. " +
        INTEGRITY_ONLY,
      claimed: null,
      computed: null,
    };
  }
  const { attestation: _drop, ...rest } = record as Record<string, unknown>;
  const computed = `sha256:${await canonicalHash(rest)}`;
  if (computed === claimed) {
    return {
      state: "verified",
      reason: `The record's canonical content hash matches its attested digest. ${INTEGRITY_ONLY}`,
      claimed,
      computed,
    };
  }
  return {
    state: "invalid",
    reason: `Record content hash mismatch: attested ${claimed}, computed ${computed}.`,
    claimed,
    computed,
  };
}

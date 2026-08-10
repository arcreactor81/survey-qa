/**
 * SEALED CONTRACT REVISIONS — immutable, hashed, cross-run.
 *
 * merged-contract §0: "every run references ONE immutable contractRevisionId + hash and
 * may not regenerate its own denominator." That sentence only has teeth if sealing is
 * physically one-way, so:
 *
 *   - the id IS the canonical-JSON sha-256 of the revision body (minus the id field
 *     itself), which makes "id names these exact bytes" a tautology, not a promise;
 *   - the write is guarded with `onlyIf: { etagDoesNotMatch: "*" }`, so a second write
 *     of the same id is a no-op, never an overwrite;
 *   - `sealContract` refuses to seal unless all four §0 approval gates are true.
 *
 * Revisions are NOT run-scoped: two runs of the same unchanged document resolve the same
 * revision, which is what makes cross-run comparison of a result cell meaningful.
 */

import type { Env } from "../types/env";
import { CONTRACT_REVISION_KIND, type ContractRevision } from "../types/record";
import { contractRevisionKey } from "../keys";
import { canonicalHash, canonicalJson } from "./hash";
// THE IDENTITY DEFINITION IS SHARED, NOT LOCAL. The judge re-binds a stored revision the
// same way this module seals it; two spellings of "which bytes is this revision" is the
// defect class D4 found (see shared/v2-record.mjs).
// Typed by shared/v2-record.d.ts.
import {
  contractHashFromDigest as contractHashFromDigestUntyped,
  contractRevisionIdFromDigest as contractRevisionIdFromDigestUntyped,
  contractApprovalFailures as contractApprovalFailuresUntyped,
  semanticContractBody as semanticContractBodyUntyped,
} from "../../shared/v2-record.mjs";

const semanticBody = semanticContractBodyUntyped as (body: unknown) => unknown;
const revisionIdFromDigest = contractRevisionIdFromDigestUntyped as (hex: string) => string;
const hashFromDigest = contractHashFromDigestUntyped as (hex: string) => string;
const approvalFailures = contractApprovalFailuresUntyped as (revision: unknown) => string[];

export class ContractGateFailure extends Error {
  constructor(failed: string[]) {
    super(
      `refusing to seal a contract revision: unmet approval gates [${failed.join(", ")}]. ` +
        `An unreviewed denominator makes every downstream coverage number unfalsifiable. ` +
        `A gate in state "not-evaluated" is NOT a passing gate: work that did not happen must never be ` +
        `indistinguishable from work that happened and found nothing.`,
    );
    this.name = "ContractGateFailure";
  }
}

export class ContractImmutabilityViolation extends Error {
  constructor(id: string) {
    super(`contract revision ${id} already exists with different bytes; revisions are immutable`);
    this.name = "ContractImmutabilityViolation";
  }
}

/**
 * THE SEMANTIC BODY — everything that decides what the contract SAYS, and nothing that
 * merely records when it was written down.
 *
 * `computeRevisionId` used to hash the whole body including `sealedAt`, a wall-clock
 * timestamp. Two runs of the same unchanged document therefore produced DIFFERENT revision
 * ids, which quietly destroys the property the whole revision scheme exists for:
 * "revisions are NOT run-scoped: two runs of the same unchanged document resolve the same
 * revision, which is what makes cross-run comparison of a result cell meaningful". Every
 * cross-run comparison silently became a comparison against a different denominator id.
 *
 * The gate PROOFS carry `observedAt` for the same reason and are excluded on the same
 * grounds: re-running an identical evaluation over identical input is the same approval,
 * and the proof's identity is its evaluator + version + input digest, not its clock.
 * `sealedAt` and the timestamps remain in the STORED revision — they are audit facts —
 * they simply do not participate in identity.
 */
export function semanticContractBody(body: Omit<ContractRevision, "contractRevisionId">): unknown {
  return semanticBody(body);
}

/** Compute the revision id: sha-256 over the canonical SEMANTIC body. */
export async function computeRevisionId(body: Omit<ContractRevision, "contractRevisionId">): Promise<string> {
  return revisionIdFromDigest(await canonicalHash(semanticContractBody(body)));
}

/**
 * THE IDENTITY OF STORED BYTES, RECOMPUTED (D4).
 *
 * `contractRevisionId` and `contractHash` are two projections of ONE digest over the
 * semantic body. This returns both, computed from the bytes in hand, so a caller can ask
 * "do these bytes ARE this revision" rather than "does this string look like a revision
 * id".
 */
export async function revisionIdentity(
  revision: ContractRevision | Omit<ContractRevision, "contractRevisionId">,
): Promise<{ contractRevisionId: string; contractHash: string }> {
  const digest = await canonicalHash(semanticContractBody(revision as Omit<ContractRevision, "contractRevisionId">));
  return { contractRevisionId: revisionIdFromDigest(digest), contractHash: hashFromDigest(digest) };
}

/**
 * Seal + persist. Idempotent: re-sealing identical content returns the same id and
 * performs no write. Returns the id and the canonical hash the checkpoint will carry.
 */
export async function sealContract(
  env: Env,
  body: Omit<ContractRevision, "contractRevisionId">,
): Promise<{ contractRevisionId: string; contractHash: string; revision: ContractRevision }> {
  // Every gate must be `pass` AND carry a proof. `not-evaluated` — the state a stub
  // returns — is refused here, so a pipeline stage that has not been written cannot seal
  // a denominator on behalf of one that has.
  const failed = approvalFailures(body);
  if (failed.length > 0) throw new ContractGateFailure(failed);

  // The hash the checkpoint carries names the SEMANTIC content, matching the id, so
  // `contractRevisionId` and `contractHash` cannot disagree about what "the same
  // contract" means. Both come from ONE digest computation.
  const { contractRevisionId, contractHash } = await revisionIdentity(body);
  const revision: ContractRevision = { ...body, contractRevisionId, kind: CONTRACT_REVISION_KIND };
  const bytes = canonicalJson(revision);
  const key = contractRevisionKey(contractRevisionId);

  const written = await env.EVIDENCE.put(key, bytes, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" }, // write-once; a no-op if it already exists
  });
  if (written === null) {
    // Already sealed with this SEMANTIC id. The stored bytes may legitimately differ in
    // `sealedAt` alone, so compare what identity is defined over rather than raw bytes —
    // and refuse if anything semantic differs, because that would be a hash collision or
    // a corrupted object, not a re-seal.
    const existing = await env.EVIDENCE.get(key);
    if (!existing) throw new ContractImmutabilityViolation(contractRevisionId);
    const parsed = JSON.parse(await existing.text()) as ContractRevision;
    const { contractRevisionId: _drop, ...existingBody } = parsed;
    if (canonicalJson(semanticContractBody(existingBody)) !== canonicalJson(semanticContractBody(body))) {
      throw new ContractImmutabilityViolation(contractRevisionId);
    }
    return { contractRevisionId, contractHash, revision: parsed };
  }
  return { contractRevisionId, contractHash, revision };
}

/**
 * The stored revision's CONTENT does not match the identity it was fetched under.
 *
 * This is never "absent". A reader that maps tampering onto `null` publishes a report
 * whose denominator quietly came from somewhere else, so the two outcomes must not share
 * a return value.
 */
export class ContractRevisionTampered extends Error {
  constructor(
    readonly requestedId: string,
    readonly recomputedId: string,
    detail: string,
  ) {
    super(
      `contract revision ${requestedId} does not re-derive from its own stored bytes (they canonicalize to ` +
        `${recomputedId}): ${detail}. A revision id IS the sha-256 of its semantic body, so this object was ` +
        `altered after sealing. Refusing to use it as a denominator.`,
    );
    this.name = "ContractRevisionTampered";
  }
}

/**
 * READ + RE-BIND (D4).
 *
 * This used to validate the id's SHAPE and the object's `kind` and return it. Neither
 * check looks at the content, so altering the stored bytes under the same key changed the
 * report's denominator — the requirement rows, the execution-case ledger, the ambiguity
 * and not-browser-observable counts — while every signature in the system still verified,
 * because nothing signs a ContractRevision: its id IS its hash, and nobody was checking.
 *
 * The re-derivation is the whole point of content-addressing, so it happens on EVERY read.
 * `expect` additionally cross-checks the hash the caller resolved this revision through
 * (the checkpoint's `contractHash`, the RunRecord's `contract.contractHash`, the
 * JudgementRecord's `binding.contractRevisionHash`), so those three cannot disagree
 * silently either.
 */
export async function getContractRevision(
  env: Env,
  contractRevisionId: string,
  expect: { contractHash?: string | null } = {},
): Promise<ContractRevision | null> {
  if (!/^cr_[0-9a-f]{40}$/.test(contractRevisionId)) return null;
  const obj = await env.EVIDENCE.get(contractRevisionKey(contractRevisionId));
  if (!obj) return null;
  const parsed = JSON.parse(await obj.text()) as ContractRevision;
  if (parsed.kind !== CONTRACT_REVISION_KIND) return null;

  const identity = await revisionIdentity(parsed);
  if (identity.contractRevisionId !== contractRevisionId) {
    throw new ContractRevisionTampered(
      contractRevisionId,
      identity.contractRevisionId,
      "the semantic body hashes to a different id",
    );
  }
  if (parsed.contractRevisionId !== contractRevisionId) {
    throw new ContractRevisionTampered(
      contractRevisionId,
      parsed.contractRevisionId,
      `the object names itself ${JSON.stringify(parsed.contractRevisionId)}`,
    );
  }
  if (expect.contractHash != null && expect.contractHash !== identity.contractHash) {
    throw new ContractRevisionTampered(
      contractRevisionId,
      identity.contractRevisionId,
      `the caller resolved it through contractHash ${JSON.stringify(expect.contractHash)} and its bytes hash to ` +
        `${JSON.stringify(identity.contractHash)}`,
    );
  }
  // A revision whose gates no longer pass could never have been sealed. If it is on disk
  // in that state, it was not written by `sealContract`.
  const failed = approvalFailures(parsed);
  if (failed.length > 0) {
    throw new ContractRevisionTampered(
      contractRevisionId,
      identity.contractRevisionId,
      `its approval gates do not pass [${failed.join(", ")}], so these bytes were never sealable`,
    );
  }
  return parsed;
}

/**
 * The two denominators, computed ONCE from the sealed revision and never recomputed by
 * a live reader. merged-contract §0 forbids merging them into a single number.
 */
export function denominators(revision: ContractRevision): {
  requirements: number;
  executionCases: number;
  ambiguous: number;
  disputed: number;
  notBrowserObservable: number;
} {
  const live = revision.requirements.filter((r) => r.retiredAt === null);
  return {
    requirements: live.length,
    executionCases: revision.facetInstances.length,
    ambiguous: live.filter((r) => r.assertionStatus === "ambiguous").length,
    disputed: live.filter((r) => r.assertionStatus === "disputed").length,
    notBrowserObservable: live.filter((r) => r.testability === "not-browser-observable").length,
  };
}

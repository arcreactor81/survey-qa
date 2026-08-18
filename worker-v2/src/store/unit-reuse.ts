/**
 * CROSS-RUN EXTRACTION UNIT REUSE — content-addressed index of completed extraction units.
 *
 * When a run is about to purchase an extraction unit (pass-B chunk, pass-B sweep, pass-A
 * window, or pass-A synthesis), it first checks this index for a COMPLETED unit with the
 * IDENTICAL identity. On a hit, the stored model output is re-validated through the SAME
 * decoder the live path uses, and only then adopted. The savings are direct: ~$2.30 of
 * DeepSeek per re-extraction for pass B alone, and ~$1.20 of Grok for pass A.
 *
 * UNIT IDENTITY IS EXACT AND TOTAL. Two units with the same identity digest are provably
 * byte-equivalent at the model-input level, because the digest covers every field that
 * could change what the model sees or how its output is interpreted:
 *
 *   requestHash          sha256 of the exact chat request body text — captures the prompt,
 *                        the block text, the model config, the system message.
 *   decoderIdentity      version of the output decoder — a different decoder may extract
 *                        different obligations from the same raw model output.
 *   providerPlanIdentity model + rates + attempt ceiling — a different plan is a different
 *                        provider contract even when the model happens to match.
 *   promptVersion        pass-specific prompt version — a prompt change is a different read.
 *   parserVersion        DOCX parser version — a parser change may produce different blocks
 *                        from the same document bytes.
 *
 * FAIL-OPEN, LOUDLY. Any index read error, identity mismatch (collision paranoia), or
 * validation refusal falls back to a live purchase with a console line naming why. Reuse
 * is an optimization; correctness never depends on it.
 *
 * NEVER STORE FAILED UNITS. Only status "ok" units enter the index. A failed unit retried
 * with a different prompt echo or model state may succeed; caching the failure would
 * prevent that recovery.
 *
 * THE WHOLE-CONTRACT REUSE INDEX AND ITS SEAL-TIME ADOPTION STAY UNTOUCHED. This sits
 * BELOW that layer: individual extraction units, not sealed contract revisions.
 */

import type { Env } from "../types/env";
import { k } from "../keys";
import { sha256Hex } from "./hash";

export const UNIT_REUSE_VERSION = "v2-extract-unit-reuse/1.0.0";

export type UnitKind = "pass-b-chunk" | "pass-b-sweep" | "pass-a-window" | "pass-a-synthesis";

/**
 * Every field that could change what a re-extraction of this unit would produce.
 * If any field differs, the digest differs, and the lookup misses.
 */
export interface UnitIdentityFields {
  unitKind: UnitKind;
  /** sha256 of the exact chat request body — captures prompt, blocks, model config. */
  requestHash: string;
  /** Version of the output decoder that parses the raw model response. */
  decoderIdentity: string;
  /** Provider plan: model identity, rates, attempt ceiling. */
  providerPlanIdentity: string;
  /** Pass-specific prompt version. */
  promptVersion: string;
  /** DOCX parser version that produced the source blocks. */
  parserVersion: string;
}

/**
 * The minimum usage telemetry needed to reconstruct a valid per-run receipt when adopting.
 * This is the successful receipt from the original purchase, not a replay marker.
 */
export interface StoredUsageSummary {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  model: string;
  provider: string;
  usageSource: string;
  attempts: number;
}

/**
 * What is stored in the cross-run index. The identity fields are in the clear for
 * collision-paranoia verification. The model output is the raw response from the provider
 * that the decoder runs on.
 */
export interface StoredReusableUnit {
  version: typeof UNIT_REUSE_VERSION;
  identity: UnitIdentityFields;
  identityDigest: string;
  modelOutput: Record<string, unknown>;
  originalUsage: StoredUsageSummary;
  sourceRunId: string;
  completedAt: string;
}

/**
 * The digest over the identity fields. Field order is FIXED — it is part of the
 * on-disk contract, so a reordering is a silent cache miss for every stored unit.
 */
export async function unitIdentityDigest(fields: UnitIdentityFields): Promise<string> {
  const canonical = [
    UNIT_REUSE_VERSION,
    `kind:${fields.unitKind}`, // mutation-anchor: unit-reuse-identity-kind
    `request:${fields.requestHash}`, // mutation-anchor: unit-reuse-identity-request
    `decoder:${fields.decoderIdentity}`, // mutation-anchor: unit-reuse-identity-decoder
    `provider:${fields.providerPlanIdentity}`, // mutation-anchor: unit-reuse-identity-provider
    `prompt:${fields.promptVersion}`, // mutation-anchor: unit-reuse-identity-prompt
    `parser:${fields.parserVersion}`, // mutation-anchor: unit-reuse-identity-parser
  ].join("\n");
  return sha256Hex(canonical);
}

/** R2 key for a cross-run unit. Content-addressed by the identity digest. */
export const unitReuseKey = (digest: string): string => k("extract-units", `${digest}.json`);

/**
 * Store a successfully completed extraction unit in the cross-run index.
 *
 * FIRST WRITER WINS. Two concurrent runs completing the same unit both store; whichever
 * records first owns the key. The second's result is equally valid and still referenced by
 * its own per-run artifact. Overwriting would cause a future adopter to silently switch
 * provenance, which is drift rather than progress.
 *
 * NEVER CALL THIS FOR FAILED UNITS. The caller must verify status is "ok" before storing.
 */
export async function storeCompletedUnit(
  env: Env,
  identity: UnitIdentityFields,
  modelOutput: Record<string, unknown>,
  originalUsage: StoredUsageSummary,
  sourceRunId: string,
): Promise<"stored" | "already-stored" | "store-failed"> {
  const digest = await unitIdentityDigest(identity);
  const entry: StoredReusableUnit = {
    version: UNIT_REUSE_VERSION,
    identity,
    identityDigest: digest,
    modelOutput,
    originalUsage,
    sourceRunId,
    completedAt: new Date().toISOString(),
  };
  try {
    const written = await env.EVIDENCE.put(
      unitReuseKey(digest),
      JSON.stringify(entry, null, 2),
      {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagDoesNotMatch: "*" },
      },
    );
    return written === null ? "already-stored" : "stored";
  } catch (err) {
    // Storage failures are not fatal. The unit is already persisted in per-run storage;
    // the cross-run index is an optimization, and its absence means the next run pays
    // for the extraction rather than adopting it.
    console.log(
      `unit-reuse: store failed for ${identity.unitKind}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return "store-failed";
  }
}

/**
 * Look up a completed unit in the cross-run index.
 *
 * FAIL-OPEN: any read error, parse error, version mismatch, or identity-field mismatch
 * returns null with a console line naming the reason. The caller falls through to a live
 * purchase.
 *
 * COLLISION PARANOIA: even though the digest is a sha256 of the identity fields, every
 * field is verified in the clear after reading. A digest collision (or index corruption)
 * that paired a unit with the wrong identity is refused, never adopted.
 */
export async function lookupReusableUnit(
  env: Env,
  identity: UnitIdentityFields,
): Promise<StoredReusableUnit | null> {
  const digest = await unitIdentityDigest(identity);
  const key = unitReuseKey(digest);

  let obj: R2ObjectBody | null;
  try {
    obj = await env.EVIDENCE.get(key);
  } catch (err) {
    console.log(
      `unit-reuse: index read failed for ${identity.unitKind}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (obj === null) return null;

  let entry: StoredReusableUnit;
  try {
    const text = await obj.text();
    entry = JSON.parse(text) as StoredReusableUnit;
  } catch (err) {
    console.log(
      `unit-reuse: index parse failed for ${identity.unitKind}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  // Version gate: a future schema change invalidates all stored entries.
  if (entry.version !== UNIT_REUSE_VERSION) {
    console.log(
      `unit-reuse: version mismatch for ${identity.unitKind}: ` +
        `expected ${UNIT_REUSE_VERSION}, got ${String(entry.version)}`,
    );
    return null;
  }

  // Digest self-consistency: the stored digest must match what we computed.
  if (entry.identityDigest !== digest) {
    console.log(
      `unit-reuse: digest mismatch for ${identity.unitKind}: ` +
        `expected ${digest}, got ${String(entry.identityDigest)}`,
    );
    return null;
  }

  // Collision paranoia: every identity field compared in the clear.
  const stored = entry.identity;
  if (
    stored.unitKind !== identity.unitKind ||
    stored.requestHash !== identity.requestHash ||
    stored.decoderIdentity !== identity.decoderIdentity ||
    stored.providerPlanIdentity !== identity.providerPlanIdentity ||
    stored.promptVersion !== identity.promptVersion ||
    stored.parserVersion !== identity.parserVersion
  ) {
    console.log(
      `unit-reuse: identity field mismatch for ${identity.unitKind} ` +
        `(digest collision or index corruption)`, // mutation-anchor: unit-reuse-identity-mismatch-refused
    );
    return null;
  }

  // The model output must be a non-null non-array object for the decoder to run on.
  if (
    typeof entry.modelOutput !== "object" ||
    entry.modelOutput === null ||
    Array.isArray(entry.modelOutput)
  ) {
    console.log(`unit-reuse: modelOutput is not a valid object for ${identity.unitKind}`);
    return null;
  }

  // The original usage must have finite non-negative cost fields.
  const u = entry.originalUsage;
  if (
    typeof u !== "object" || u === null ||
    typeof u.inputTokens !== "number" || u.inputTokens < 0 ||
    typeof u.outputTokens !== "number" || u.outputTokens < 0 ||
    typeof u.costUsd !== "number" || u.costUsd < 0 ||
    typeof u.latencyMs !== "number" || u.latencyMs < 0 ||
    typeof u.model !== "string" || u.model.length === 0 ||
    typeof u.provider !== "string" || u.provider.length === 0 ||
    typeof u.usageSource !== "string" || u.usageSource.length === 0 ||
    typeof u.attempts !== "number" || u.attempts < 1
  ) {
    console.log(`unit-reuse: originalUsage is malformed for ${identity.unitKind}`);
    return null;
  }

  return entry;
}

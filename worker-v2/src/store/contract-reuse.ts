/**
 * REUSING A SEALED CONTRACT REVISION ACROSS RUNS OF THE SAME BYTES.
 *
 * ============================== WHAT THIS COSTS TODAY ==============================
 *
 * Four runs re-extracted IDENTICAL document bytes. They cost about $1.06 in model calls and
 * bought four INCOMPATIBLE denominators from one document — 189, 194, 195 and 227 requirements,
 * with the option-set case count alone swinging 48 → 92. So the money did not buy agreement; it
 * bought four different answers to "what does this document require", and any two runs picked
 * at random cannot be compared at all. Extraction is two model passes over prose, and prose
 * plus a sampling temperature is not a function.
 *
 * Reuse fixes both halves at once. The same bytes, read by the same prompts and the same models
 * into the same configuration, produce the SAME sealed revision — because it is literally the
 * one that was sealed before — and two runs become comparable for the first time.
 *
 * =================== THE KEY, AND WHY EVERY PART OF IT IS IN IT ===================
 *
 * The reuse key is a digest over everything that could change what a re-extraction would
 * produce. Anything omitted is a way for a run to silently adopt a denominator computed for
 * different inputs, which is worse than paying for the extraction again:
 *
 *   documentSha256   the bytes. Not the filename, not the size.
 *   docxParserVersion the deterministic DOCX-to-block reader and its annotated rendering.
 *                    The same bytes can produce different model inputs when this changes.
 *   promptVersionA   pass A reads the whole document for survey-scoped rules.
 *   promptVersionB   pass B walks every block against the construct checklist.
 *   modelA / modelB  the two passes differ in METHOD AND in model; a model swap is a different
 *                    reader of the same prose, and the row set moves.
 *   mergeVersion     the deterministic merge decides which rows survive and how they bind.
 *   expanderVersion  the floor expander materializes the CASES from the requirements. The
 *                    requirement set can be identical while the case denominator changes.
 *   locale           `stageConsolidate` takes it, and it reaches the sealed cases.
 *   viewports        so does this, and ORDER is semantic today because consolidation passes
 *                    `viewports[0]` to the expander. A case that only exists under one viewport is
 *                    materialized from it. A revision expanded for `["desktop"]` is not the
 *                    revision a `["desktop","mobile"]` run needs, and adopting it would silently
 *                    shrink the denominator — the exact "hides the missing execution" failure
 *                    D10 exists to prevent.
 *   reviewMode       `high-risk-only` and `always` gate different rows into the seal.
 *
 * WHAT INVALIDATES A REUSE ENTRY IS THEREFORE THE KEY ITSELF: change any one of those and the
 * digest changes, the lookup misses, and the run extracts. There is no expiry and no manual
 * invalidation, because a cache with a second, human-operated invalidation path is a cache that
 * will be stale exactly once.
 *
 * ==================== THE INDEX IS A HINT, NEVER AN AUTHORITY ====================
 *
 * The entry stores an id and a hash and nothing else that matters. The adopting run re-reads
 * the revision through `getContractRevision`, which RE-HASHES the stored bytes and refuses a
 * revision altered under its key. So a poisoned index entry cannot hand a run a denominator
 * nobody sealed; the worst it can do is name a revision that no longer verifies, and then the
 * run extracts. Nothing here is trusted.
 */

import type { Env } from "../types/env";
import { k } from "../keys";
import { sha256Hex } from "./hash";
import type { DocumentSemanticsProfile } from "../extract/document-semantics";

export const CONTRACT_REUSE_VERSION = "v2-contract-reuse/1.9.0";

/**
 * Configuration read by extraction/model calls that can change rows, source coverage, or
 * whether a unit lands. Undefined is recorded explicitly: changing an unset value to an
 * explicit default may cause a safe cache miss, never an unsafe cross-policy adoption.
 */
export const EXTRACTION_POLICY_KEYS = [
  "GROK_MODEL",
  "GROK_REASONING_EFFORT",
  "GROK_RATE_BINDING_SCHEMA",
  "GROK_RATE_POLICY",
  "GROK_RATE_SOURCE",
  "GROK_RATE_ATTESTED_MODEL",
  "GROK_RATE_ATTESTED_AT",
  "GROK_RATE_RECEIPT_SHA256",
  "GROK_CONTEXT_WINDOW_TOKENS",
  "GROK_INPUT_USD_PER_MTOK",
  "GROK_CACHED_INPUT_USD_PER_MTOK",
  "GROK_OUTPUT_USD_PER_MTOK",
  "GROK_LONG_CONTEXT_THRESHOLD_TOKENS",
  "GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK",
  "GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK",
  "GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK",
  "GROK_MAX_INPUT_USD_PER_MTOK",
  "GROK_MAX_OUTPUT_USD_PER_MTOK",
  "DEEPSEEK_MODEL",
  "DEEPSEEK_REASONING_EFFORT",
  "DEEPSEEK_INPUT_USD_PER_MTOK",
  "DEEPSEEK_OUTPUT_USD_PER_MTOK",
  "DEEPSEEK_FALLBACK_MODE",
  "DEEPSEEK_FALLBACK_MODEL",
  "DEEPSEEK_FALLBACK_REASONING_EFFORT",
  "DEEPSEEK_FALLBACK_MAX_ATTEMPTS",
  "DEEPSEEK_FALLBACK_INPUT_USD_PER_MTOK",
  "DEEPSEEK_FALLBACK_OUTPUT_USD_PER_MTOK",
  "LLM_TIMEOUT_MS",
  "EXTRACT_MAX_ATTEMPTS",
  "EXTRACT_MAX_OUTPUT_TOKENS",
  "EXTRACT_PASS_A_WINDOW_CHARS",
  "EXTRACT_PASS_A_WINDOW_MAX_BLOCKS",
  "EXTRACT_PASS_A_WINDOW_MAX_ISSUES",
  "EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES",
  "EXTRACT_PASS_A_SYNTHESIS_MAX_ISSUES",
  "EXTRACT_PASS_A_WAVE_BUDGET_MS",
  "EXTRACT_PASS_A_MAX_WAVES",
  "EXTRACT_CHUNK_CHARS",
  "EXTRACT_CHUNK_CONCURRENCY",
  "EXTRACT_CHUNK_MAX_BLOCKS",
  "EXTRACT_CHUNK_MAX_ISSUES",
  "EXTRACT_CONTEXT_CHARS",
  "EXTRACT_SWEEP_BLOCKS_PER_CALL",
  "EXTRACT_SWEEP_MAX_CALLS",
  "EXTRACT_WAVE_BUDGET_MS",
  "EXTRACT_PASS_B_MAX_WAVES",
] as const;

export async function extractionPolicyFingerprint(env: Env): Promise<string> {
  const canonical = EXTRACTION_POLICY_KEYS.map((key) => `${key}=${env[key] ?? "<unset>"}`).join("\n");
  return await sha256Hex(canonical);
}

/** Everything that could change what a re-extraction of the same bytes would produce. */
export interface ExtractionInputs {
  documentSha256: string;
  docxParserVersion: string;
  documentSemanticsProfile: DocumentSemanticsProfile;
  promptVersionA: string;
  promptVersionB: string;
  modelA: string;
  modelB: string;
  mergeVersion: string;
  expanderVersion: string;
  locale: string;
  viewports: string[];
  reviewMode: string;
  /** Digest of every extraction/model knob enumerated by EXTRACTION_POLICY_KEYS. */
  policyFingerprint: string;
}

export interface ContractReuseEntry {
  kind: typeof CONTRACT_REUSE_VERSION;
  /** Recomputed from `inputs` on every read; also embedded in the sealed revision. */
  inputsDigest: string;
  contractRevisionId: string;
  contractHash: string;
  /** The inputs the digest was taken over, in the clear, so a miss can be explained. */
  inputs: ExtractionInputs;
  /** The run that paid for this extraction. Provenance, never authority. */
  sealedByRunId: string;
  sealedAt: string;
}

/**
 * The digest. Field order is FIXED here rather than taken from object key order. Viewport order
 * is deliberately retained: the current expander consumes the first viewport as configuration,
 * so reversing the array is not an equivalent spelling.
 */
export async function extractionInputsDigest(inputs: ExtractionInputs): Promise<string> {
  const canonical = [
    CONTRACT_REUSE_VERSION,
    `document:${String(inputs.documentSha256).replace(/^sha256:/, "")}`,
    `docxParser:${inputs.docxParserVersion}`,
    `documentSemantics:${inputs.documentSemanticsProfile}`,
    `promptA:${inputs.promptVersionA}`,
    `promptB:${inputs.promptVersionB}`,
    `modelA:${inputs.modelA}`,
    `modelB:${inputs.modelB}`,
    `merge:${inputs.mergeVersion}`,
    `expander:${inputs.expanderVersion}`,
    `locale:${inputs.locale}`,
    `viewports:${inputs.viewports.join(",")}`,
    `reviewMode:${inputs.reviewMode}`,
    `policy:${inputs.policyFingerprint}`,
  ].join("\n");
  return await sha256Hex(canonical);
}

export const contractReuseKey = (digest: string) => k("contracts", "by-inputs", `${digest}.json`);

/** Absent, unparseable, or the wrong kind ⇒ null. A miss is a cheap extraction, not an error. */
export async function lookupReusableContract(env: Env, digest: string): Promise<ContractReuseEntry | null> {
  const obj = await env.EVIDENCE.get(contractReuseKey(digest));
  if (!obj) return null;
  try {
    const entry = JSON.parse(await obj.text()) as ContractReuseEntry;
    if (entry?.kind !== CONTRACT_REUSE_VERSION) return null;
    if (entry.inputsDigest !== digest) return null;
    // A legacy entry can re-derive a legacy digest while still saying nothing about which
    // DOCX block semantics produced its denominator. Missing identity is therefore a miss,
    // never an invitation to treat the old parser as the current one.
    if (typeof entry.inputs?.docxParserVersion !== "string" || entry.inputs.docxParserVersion.length === 0) return null;
    if (
      entry.inputs.documentSemanticsProfile !== "none/1.0.0" &&
      entry.inputs.documentSemanticsProfile !== "shop-direct-grey-programming/1.0.0"
    ) return null;
    if (await extractionInputsDigest(entry.inputs) !== digest) return null;
    if (typeof entry.contractRevisionId !== "string" || entry.contractRevisionId.length === 0) return null;
    if (typeof entry.contractHash !== "string" || entry.contractHash.length === 0) return null;
    return entry;
  } catch {
    return null;
  }
}

/**
 * Publish the index entry for a revision this run just sealed.
 *
 * FIRST WRITER WINS, deliberately. Two concurrent runs of the same document both extract and
 * both seal; whichever records first owns the key, and the second's revision is still perfectly
 * valid and still referenced by its own run. Overwriting would repoint every FUTURE run at a
 * second denominator for no reason, which is the drift this whole module exists to stop.
 */
export async function recordReusableContract(
  env: Env,
  digest: string,
  entry: Omit<ContractReuseEntry, "kind" | "inputsDigest">,
): Promise<"recorded" | "already-recorded"> {
  if (await extractionInputsDigest(entry.inputs) !== digest) {
    throw new Error("contract reuse entry inputs do not re-derive the key digest");
  }
  const written = await env.EVIDENCE.put(contractReuseKey(digest), JSON.stringify({
    kind: CONTRACT_REUSE_VERSION,
    ...entry,
    // Server-owned and deliberately AFTER the caller-owned fields so it cannot be replaced.
    inputsDigest: digest,
  }), {
    httpMetadata: { contentType: "application/json" },
    // One atomic compare-and-set. A get followed by an unconditional put lets two concurrent
    // sealers both observe absence and the second silently repoint the future denominator.
    onlyIf: { etagDoesNotMatch: "*" },
  });
  return written === null ? "already-recorded" : "recorded";
}

/**
 * Provider-neutral, pre-purchase input-wire policy for extraction calls.
 *
 * `chatRequestBodyText` is the transport serializer. Callers must hand this module every
 * exact body that the logical unit could buy (for example Grok and its DeepSeek Flash
 * substitute). UTF-8 bytes are treated as a conservative upper bound on input tokens:
 * regardless of tokenizer, one encoded byte cannot represent more than one token under
 * this accounting rule. The configured input ceiling plus the provider-enforced output
 * reservation must remain strictly below the smallest attested provider context.
 */

import type { Env } from "../types/env";

export const EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED =
  "extraction-model-input-wire-ceiling-exceeded" as const;
export const DEFAULT_EXTRACTION_MODEL_INPUT_MAX_BYTES = 450_000;
export const DEFAULT_EXTRACTION_MAX_OUTPUT_TOKENS = 32_000;
export const DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const DEFAULT_GROK_CONTEXT_WINDOW_TOKENS = 500_000;

export interface ExtractionRequestBody {
  route: string;
  bodyText: string;
}

export interface ExtractionWirePolicy {
  maxInputBytes: number;
  maxOutputTokens: number;
  grokContextWindowTokens: number;
  deepseekContextWindowTokens: typeof DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS;
  smallestContextWindowTokens: number;
}

export interface ExtractionWireMeasurement {
  route: string;
  utf8Bytes: number;
}

/**
 * Exact UTF-8 byte count without allocating a second full request-sized byte array.
 *
 * Workers' `TextEncoder.encode()` is exact, but it also materializes the encoded body. A
 * questionnaire XML part may be tens of megabytes, so allocating that copy merely to refuse
 * it can make the safeguard itself the out-of-memory event. This follows the Encoding
 * Standard's replacement behavior for unpaired UTF-16 surrogates (U+FFFD = three bytes).
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      // BMP code points and lone low surrogates both encode as three bytes; the latter is
      // replaced with U+FFFD by the platform encoder.
      bytes += 3;
    }
    if (!Number.isSafeInteger(bytes)) {
      throw new Error("extraction request body exceeds the safe UTF-8 byte-count range");
    }
  }
  return bytes;
}

export type ExtractionWirePreflight =
  | {
      ok: true;
      policy: ExtractionWirePolicy;
      measurements: ExtractionWireMeasurement[];
      largestRequestBytes: number;
      appliedMaxBytes: number;
      appliedLimitName: string;
    }
  | {
      ok: false;
      reasonCode: typeof EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED;
      policy: ExtractionWirePolicy;
      measurements: ExtractionWireMeasurement[];
      largestRequestBytes: number;
      appliedMaxBytes: number;
      appliedLimitName: string;
    };

function canonicalPositiveInteger(
  configured: string | undefined,
  fallback: number,
  name: string,
): number {
  const raw = configured ?? String(fallback);
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a canonical positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a safe positive integer`);
  }
  return parsed;
}

/**
 * Closed policy proof. DeepSeek's official Models & Pricing table was checked 2026-08-14:
 * both `deepseek-v4-flash` and `deepseek-v4-pro` declare a 1M-token context.
 * https://api-docs.deepseek.com/quick_start/pricing
 */
export function extractionWirePolicy(env: Env): ExtractionWirePolicy {
  const maxInputBytes = canonicalPositiveInteger(
    env.EXTRACT_MODEL_INPUT_MAX_BYTES,
    DEFAULT_EXTRACTION_MODEL_INPUT_MAX_BYTES,
    "EXTRACT_MODEL_INPUT_MAX_BYTES",
  );
  const maxOutputTokens = canonicalPositiveInteger(
    env.EXTRACT_MAX_OUTPUT_TOKENS,
    DEFAULT_EXTRACTION_MAX_OUTPUT_TOKENS,
    "EXTRACT_MAX_OUTPUT_TOKENS",
  );
  if (maxOutputTokens > DEFAULT_EXTRACTION_MAX_OUTPUT_TOKENS) {
    throw new Error(
      `EXTRACT_MAX_OUTPUT_TOKENS may lower but must not exceed the reviewed hard ceiling ` +
        `${DEFAULT_EXTRACTION_MAX_OUTPUT_TOKENS}`,
    );
  }
  if (maxInputBytes > DEFAULT_EXTRACTION_MODEL_INPUT_MAX_BYTES) {
    throw new Error(
      `EXTRACT_MODEL_INPUT_MAX_BYTES may lower but must not exceed the reviewed hard ceiling ` +
        `${DEFAULT_EXTRACTION_MODEL_INPUT_MAX_BYTES}`,
    );
  }
  const grokContextWindowTokens = canonicalPositiveInteger(
    env.GROK_CONTEXT_WINDOW_TOKENS,
    DEFAULT_GROK_CONTEXT_WINDOW_TOKENS,
    "GROK_CONTEXT_WINDOW_TOKENS",
  );
  const deepseekContextWindowTokens = canonicalPositiveInteger(
    env.DEEPSEEK_CONTEXT_WINDOW_TOKENS,
    DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS,
    "DEEPSEEK_CONTEXT_WINDOW_TOKENS",
  );
  if (deepseekContextWindowTokens !== DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS) {
    throw new Error(
      `DEEPSEEK_CONTEXT_WINDOW_TOKENS must attest ${DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS} ` +
        `for the pinned DeepSeek V4 Flash/Pro routes, got ${deepseekContextWindowTokens}`,
    );
  }
  const smallestContextWindowTokens = Math.min(
    grokContextWindowTokens,
    deepseekContextWindowTokens,
    // A future larger Grok attestation may not silently expand this reviewed admission
    // policy; changing the 500k floor requires an explicit code/test review.
    DEFAULT_GROK_CONTEXT_WINDOW_TOKENS,
  );
  if (maxInputBytes + maxOutputTokens >= smallestContextWindowTokens) {
    throw new Error(
      `EXTRACT_MODEL_INPUT_MAX_BYTES (${maxInputBytes}) plus EXTRACT_MAX_OUTPUT_TOKENS ` +
        `(${maxOutputTokens}) must be strictly below the smallest attested provider context ` +
        `(${smallestContextWindowTokens})`,
    );
  }
  return {
    maxInputBytes,
    maxOutputTokens,
    grokContextWindowTokens,
    deepseekContextWindowTokens: DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS,
    smallestContextWindowTokens,
  };
}

/** Measure every exact possible body before the caller may touch a provider. */
export function preflightExtractionRequestBodies(
  env: Env,
  bodies: readonly ExtractionRequestBody[],
  additionalLimit?: { name: string; maxBytes: number },
): ExtractionWirePreflight {
  if (bodies.length === 0) throw new Error("extraction wire preflight requires at least one request body");
  if (new Set(bodies.map((body) => body.route)).size !== bodies.length) {
    throw new Error("extraction wire preflight route labels must be unique");
  }
  if (bodies.some((body) => body.route.trim().length === 0)) {
    throw new Error("extraction wire preflight route labels must be non-empty");
  }
  const policy = extractionWirePolicy(env);
  let appliedMaxBytes = policy.maxInputBytes;
  let appliedLimitName = "EXTRACT_MODEL_INPUT_MAX_BYTES";
  if (additionalLimit !== undefined) {
    if (
      !Number.isSafeInteger(additionalLimit.maxBytes) || additionalLimit.maxBytes < 1 ||
      additionalLimit.name.trim().length === 0
    ) {
      throw new Error("the route-specific extraction wire limit must be a named positive integer");
    }
    if (additionalLimit.maxBytes < appliedMaxBytes) {
      appliedMaxBytes = additionalLimit.maxBytes;
      appliedLimitName = additionalLimit.name;
    }
  }
  const measurements = bodies.map(({ route, bodyText }) => ({
    route,
    utf8Bytes: utf8ByteLength(bodyText),
  }));
  const largestRequestBytes = Math.max(...measurements.map((row) => row.utf8Bytes));
  const common = {
    policy,
    measurements,
    largestRequestBytes,
    appliedMaxBytes,
    appliedLimitName,
  };
  return largestRequestBytes > appliedMaxBytes
    ? { ok: false, reasonCode: EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED, ...common }
    : { ok: true, ...common };
}

/** Closed private artifact detail; source text and provider bodies never enter it. */
export function extractionWireFailureDetail(
  unit: string,
  ownedBlockCount: number,
  failure: Extract<ExtractionWirePreflight, { ok: false }>,
): string {
  const measures = failure.measurements
    .map((row) => `${row.route}=${row.utf8Bytes}`)
    .join(", ");
  return (
    `${EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED}: ${unit} exact serialized request body is ` +
    `${failure.largestRequestBytes} UTF-8 byte(s) (${measures}), above ` +
    `${failure.appliedLimitName}=${failure.appliedMaxBytes}. All ${ownedBlockCount} owned source ` +
    `block id(s) remain counted; no source was truncated, no coverage was awarded, and no provider ` +
    `request was issued for this refusal.`
  );
}

/**
 * Closed refusal detail when the canonical inner JSONL/catalogue alone proves overflow.
 * No provider body is fabricated or called "exact" because construction stopped before
 * allocating that redundant wrapper; the lower bound is already sufficient to refuse.
 */
export function extractionWirePreSerializationFailureDetail(
  unit: string,
  ownedBlockCount: number,
  proof: { provenUtf8ByteLowerBound: number; maxBytes: number; phase: string },
  appliedLimitName = "EXTRACT_MODEL_INPUT_MAX_BYTES",
): string {
  return (
    `${EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED}: ${unit} provider request body is proven ` +
    `above ${appliedLimitName}=${proof.maxBytes} because its canonical inner source payload ` +
    `alone is at least ${proof.provenUtf8ByteLowerBound} UTF-8 byte(s) ` +
    `(${proof.phase}). All ${ownedBlockCount} owned source block id(s) remain counted; no source ` +
    `was truncated, no coverage was awarded, and no credential or provider request was issued ` +
    `for this refusal.`
  );
}

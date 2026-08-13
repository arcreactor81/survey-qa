/**
 * GROK leg — the WHOLE-DOCUMENT pass (owner ruling: Grok + DeepSeek, differing in METHOD).
 *
 * Request shape and gateway routing are taken from the v1 leg (`src/llm/grok.ts`,
 * read-only): xAI's OpenAI-compatible endpoint, routed through AI Gateway `grok/v1` when
 * CF_AIG_ACCOUNT_ID + CF_AIG_GATEWAY_ID are set, thinking ON, JSON object response format.
 */

import { num, type Env } from "../types/env";
import { deepseekGrokFallbackIdentity } from "./deepseek";
import {
  chatJson,
  keyFor,
  ModelCallError,
  type ChatOptions,
  type ChatOutcome,
  type ProviderSpec,
} from "./chat";

export const DEFAULT_GROK_MODEL = "grok-4.6";
export const GROK_FLASH_ROUTE_VERSION = "grok-flash-route/1.1.0";
export const GROK_RATE_BINDING_SCHEMA = "survey-qa-grok-rate-binding/1.0.0";
export const GROK_RATE_POLICY = "max-known-text-tier/1.0.0";
export type GrokRateSource = "owner-dashboard-copy" | "authenticated-xai-catalogue";

interface CanonicalRate {
  usdPerMTok: number;
  ticksPerToken: bigint;
}

/**
 * xAI's receipts express price as integer 1e-10 USD ticks per token. Their canonical
 * USD/Mtok rendering therefore has at most four fractional digits. Parsing that exact
 * grid refuses whitespace, exponent notation, alternate spellings such as 3.0, and zero
 * sentinels before they can create fictional budget headroom.
 */
function positiveCatalogueRate(value: string | undefined, name: string): CanonicalRate {
  if (
    value === undefined ||
    value.length > 64 ||
    !/^(?:0\.[0-9]{0,3}[1-9]|[1-9][0-9]*(?:\.[0-9]{0,3}[1-9])?)$/.test(value)
  ) {
    throw new Error(name + " must be a canonical positive receipt USD-per-million-token rate");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const ticksPerToken = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0"));
  if (ticksPerToken <= 0n || ticksPerToken > 1_000_000_000_000n) {
    throw new Error(name + " must be a positive bounded receipt rate");
  }
  return { usdPerMTok: Number(ticksPerToken) / 10_000, ticksPerToken };
}

function canonicalInteger(value: string | undefined, name: string, allowZero: boolean): number {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(name + " must be a canonical non-negative integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 1_000_000_000_000 || (!allowZero && parsed === 0)) {
    throw new Error(name + " is outside the accepted receipt envelope");
  }
  return parsed;
}

function rateSource(value: string | undefined): GrokRateSource {
  if (value === "owner-dashboard-copy" || value === "authenticated-xai-catalogue") return value;
  throw new Error("GROK_RATE_SOURCE must name the closed reviewed evidence channel");
}

function observation(value: string | undefined, source: GrokRateSource): string {
  const observedAt = value ?? "";
  if (source === "owner-dashboard-copy") {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(observedAt) ||
      new Date(observedAt + "T00:00:00.000Z").toISOString().slice(0, 10) !== observedAt
    ) {
      throw new Error("owner-dashboard-copy requires an exact canonical observation date");
    }
    return observedAt;
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt) ||
    !Number.isFinite(Date.parse(observedAt)) ||
    new Date(observedAt).toISOString() !== observedAt
  ) {
    throw new Error("authenticated-xai-catalogue requires a canonical UTC RFC3339 observation timestamp");
  }
  return observedAt;
}

function receiptSha256(value: string | undefined): string {
  if (value === undefined || !/^[0-9a-f]{64}$/.test(value) || /^0{64}$/.test(value)) {
    throw new Error("GROK_RATE_RECEIPT_SHA256 must bind the reviewed receipt bytes");
  }
  return value;
}

function sameRate(actual: CanonicalRate, expected: bigint, name: string): number {
  if (actual.ticksPerToken !== expected) {
    throw new Error(name + " must exactly equal the maximum known text tier");
  }
  return actual.usdPerMTok;
}

/**
 * Grok 4.6 was owner-selected before a public rate card was available. Reusing 4.5's price
 * would create fictional budget headroom, so every paid 4.6 call is blocked until the config
 * binds exact rates and an observation timestamp to the exact model id.
 */
export interface GrokRateAttestation {
  model: typeof DEFAULT_GROK_MODEL;
  schema: typeof GROK_RATE_BINDING_SCHEMA;
  source: GrokRateSource;
  observedAt: string;
  receiptSha256: string;
  policy: typeof GROK_RATE_POLICY;
  contextWindowTokens: number;
  base: { inputUsdPerMTok: number; cachedInputUsdPerMTok: number; outputUsdPerMTok: number };
  longContext: {
    thresholdTokens: number;
    inputUsdPerMTok: number;
    cachedInputUsdPerMTok: number;
    outputUsdPerMTok: number;
  };
  /** Conservative flat rates consumed by the existing pre-spend and settlement ledger. */
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

function parseGrokRateBinding(env: Env): GrokRateAttestation {
  const model = env.GROK_MODEL ?? DEFAULT_GROK_MODEL;
  if (model !== DEFAULT_GROK_MODEL) {
    throw new Error(`GROK_MODEL must be pinned to ${DEFAULT_GROK_MODEL}, got ${JSON.stringify(model)}`);
  }
  if (env.GROK_RATE_ATTESTED_MODEL !== model) {
    throw new Error(
      `GROK_RATE_ATTESTED_MODEL must exactly match ${model}; refusing to reuse another model's rates`,
    );
  }
  if (env.GROK_RATE_BINDING_SCHEMA !== GROK_RATE_BINDING_SCHEMA) {
    throw new Error(`GROK_RATE_BINDING_SCHEMA must exactly equal ${GROK_RATE_BINDING_SCHEMA}`);
  }
  if (env.GROK_RATE_POLICY !== GROK_RATE_POLICY) {
    throw new Error(`GROK_RATE_POLICY must exactly equal ${GROK_RATE_POLICY}`);
  }
  const source = rateSource(env.GROK_RATE_SOURCE);
  const observedAt = observation(env.GROK_RATE_ATTESTED_AT, source);
  const receipt = receiptSha256(env.GROK_RATE_RECEIPT_SHA256);
  const contextWindowTokens = canonicalInteger(
    env.GROK_CONTEXT_WINDOW_TOKENS,
    "GROK_CONTEXT_WINDOW_TOKENS",
    false,
  );
  const thresholdTokens = canonicalInteger(
    env.GROK_LONG_CONTEXT_THRESHOLD_TOKENS,
    "GROK_LONG_CONTEXT_THRESHOLD_TOKENS",
    false,
  );
  if (thresholdTokens >= contextWindowTokens) {
    throw new Error("GROK_LONG_CONTEXT_THRESHOLD_TOKENS must be below the attested context window");
  }
  const baseInput = positiveCatalogueRate(env.GROK_INPUT_USD_PER_MTOK, "GROK_INPUT_USD_PER_MTOK");
  const baseCachedInput = positiveCatalogueRate(
    env.GROK_CACHED_INPUT_USD_PER_MTOK,
    "GROK_CACHED_INPUT_USD_PER_MTOK",
  );
  const baseOutput = positiveCatalogueRate(env.GROK_OUTPUT_USD_PER_MTOK, "GROK_OUTPUT_USD_PER_MTOK");
  const longInput = positiveCatalogueRate(
    env.GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK,
    "GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK",
  );
  const longCachedInput = positiveCatalogueRate(
    env.GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK,
    "GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK",
  );
  const longOutput = positiveCatalogueRate(
    env.GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK,
    "GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK",
  );
  const maxInput = positiveCatalogueRate(
    env.GROK_MAX_INPUT_USD_PER_MTOK,
    "GROK_MAX_INPUT_USD_PER_MTOK",
  );
  const maxOutput = positiveCatalogueRate(
    env.GROK_MAX_OUTPUT_USD_PER_MTOK,
    "GROK_MAX_OUTPUT_USD_PER_MTOK",
  );
  const expectedInputTicks = baseInput.ticksPerToken > longInput.ticksPerToken
    ? baseInput.ticksPerToken
    : longInput.ticksPerToken;
  const expectedOutputTicks = baseOutput.ticksPerToken > longOutput.ticksPerToken
    ? baseOutput.ticksPerToken
    : longOutput.ticksPerToken;
  const inputUsdPerMTok = sameRate(maxInput, expectedInputTicks, "GROK_MAX_INPUT_USD_PER_MTOK");
  const outputUsdPerMTok = sameRate(maxOutput, expectedOutputTicks, "GROK_MAX_OUTPUT_USD_PER_MTOK");

  return {
    model,
    schema: GROK_RATE_BINDING_SCHEMA,
    source,
    observedAt,
    receiptSha256: receipt,
    policy: GROK_RATE_POLICY,
    contextWindowTokens,
    base: {
      inputUsdPerMTok: baseInput.usdPerMTok,
      cachedInputUsdPerMTok: baseCachedInput.usdPerMTok,
      outputUsdPerMTok: baseOutput.usdPerMTok,
    },
    longContext: {
      thresholdTokens,
      inputUsdPerMTok: longInput.usdPerMTok,
      cachedInputUsdPerMTok: longCachedInput.usdPerMTok,
      outputUsdPerMTok: longOutput.usdPerMTok,
    },
    inputUsdPerMTok,
    outputUsdPerMTok,
  };
}

/**
 * Canonical reviewed bytes. The digest intentionally excludes itself and includes every
 * field that determines price identity, including cached tiers that today's transport does
 * not report separately. A copied SHA string cannot bless a mixed set of config values.
 */
export function grokRateReceiptCanonicalText(env: Env): string {
  return canonicalRateReceipt(parseGrokRateBinding(env));
}

export async function grokRateAttestation(env: Env): Promise<GrokRateAttestation> {
  const rate = parseGrokRateBinding(env);
  const actual = await sha256Hex(canonicalRateReceipt(rate));
  if (actual !== rate.receiptSha256) {
    throw new Error("GROK_RATE_RECEIPT_SHA256 does not match the canonical reviewed rate binding");
  }
  return rate;
}

function canonicalRateReceipt(rate: GrokRateAttestation): string {
  return JSON.stringify({
    schemaVersion: rate.schema,
    source: rate.source,
    observedAt: rate.observedAt,
    model: rate.model,
    contextWindowTokens: rate.contextWindowTokens,
    pricing: {
      unit: "usd-per-million-tokens",
      base: {
        inputText: rate.base.inputUsdPerMTok,
        cachedInputText: rate.base.cachedInputUsdPerMTok,
        outputText: rate.base.outputUsdPerMTok,
      },
      longContext: {
        thresholdTokens: rate.longContext.thresholdTokens,
        inputText: rate.longContext.inputUsdPerMTok,
        cachedInputText: rate.longContext.cachedInputUsdPerMTok,
        outputText: rate.longContext.outputUsdPerMTok,
      },
      flatLedger: {
        policy: rate.policy,
        inputText: rate.inputUsdPerMTok,
        outputText: rate.outputUsdPerMTok,
      },
    },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Only quota/exhaustion/non-response/unusable-output failures authorize Flash. */
export function grokFlashFallbackEligible(error: ModelCallError): boolean {
  // `invalid-content` is eligible only after exact model identity was established. A missing,
  // redirected, or aliased response model is not evidence that grok-4.6 produced unusable
  // content, so it cannot authorize a purchase from another provider.
  if (error.failureKind === "invalid-content") {
    return error.usage.usageSource !== "unverified-model-rate-ceiling";
  }
  return (
    error.failureKind === "rate-limited" ||
    error.failureKind === "insufficient-balance" ||
    error.failureKind === "timeout-or-network" ||
    error.failureKind === "provider-unavailable"
  );
}

/** Static output/reuse identity. The actual selected leg and trigger are separate receipts. */
export function grokFlashRouteIdentity(env: Env): string {
  // Identity construction is side-effect free and remains possible while a release is
  // deliberately blocked on an absent rate attestation. `grokSpec` is the paid-call gate.
  const model = env.GROK_MODEL ?? DEFAULT_GROK_MODEL;
  return [
    GROK_FLASH_ROUTE_VERSION,
    `primary:${model}`,
    `reasoning:${env.GROK_REASONING_EFFORT ?? "high"}`,
    `attempts:${Math.max(1, Math.floor(num(env.EXTRACT_MAX_ATTEMPTS, 2)))}`,
    `rate-binding-schema:${env.GROK_RATE_BINDING_SCHEMA ?? "<unattested>"}`,
    `rate-policy:${env.GROK_RATE_POLICY ?? "<unattested>"}`,
    `rate-source:${env.GROK_RATE_SOURCE ?? "<unattested>"}`,
    `rate-model:${env.GROK_RATE_ATTESTED_MODEL ?? "<unattested>"}`,
    `rate-observed-at:${env.GROK_RATE_ATTESTED_AT ?? "<unattested>"}`,
    `rate-receipt-sha256:${env.GROK_RATE_RECEIPT_SHA256 ?? "<unattested>"}`,
    `context-window-tokens:${env.GROK_CONTEXT_WINDOW_TOKENS ?? "<unattested>"}`,
    `base-input-usd-per-mtok:${env.GROK_INPUT_USD_PER_MTOK ?? "<unattested>"}`,
    `base-cached-input-usd-per-mtok:${env.GROK_CACHED_INPUT_USD_PER_MTOK ?? "<unattested>"}`,
    `base-output-usd-per-mtok:${env.GROK_OUTPUT_USD_PER_MTOK ?? "<unattested>"}`,
    `long-threshold-tokens:${env.GROK_LONG_CONTEXT_THRESHOLD_TOKENS ?? "<unattested>"}`,
    `long-input-usd-per-mtok:${env.GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK ?? "<unattested>"}`,
    `long-cached-input-usd-per-mtok:${env.GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK ?? "<unattested>"}`,
    `long-output-usd-per-mtok:${env.GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK ?? "<unattested>"}`,
    `max-input-usd-per-mtok:${env.GROK_MAX_INPUT_USD_PER_MTOK ?? "<unattested>"}`,
    `max-output-usd-per-mtok:${env.GROK_MAX_OUTPUT_USD_PER_MTOK ?? "<unattested>"}`,
    `fallback:${deepseekGrokFallbackIdentity(env)}`,
  ].join("|");
}

export async function grokSpec(env: Env): Promise<ProviderSpec> {
  const rate = await grokRateAttestation(env);
  return {
    provider: "grok",
    model: rate.model,
    gatewaySuffix: "/v1",
    directBaseUrl: "https://api.x.ai/v1",
    apiKey: await keyFor(env, "grok"),
    inputUsdPerMTok: rate.inputUsdPerMTok,
    outputUsdPerMTok: rate.outputUsdPerMTok,
    // Reasoning tokens share the output budget, so max_tokens is set
    // generously by the caller rather than trimmed here.
    extraBody: { reasoning_effort: env.GROK_REASONING_EFFORT ?? "high" },
  };
}

export const grokJson = async (env: Env, opts: ChatOptions): Promise<ChatOutcome> =>
  chatJson(await grokSpec(env), env, opts);

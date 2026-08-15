/**
 * GEMINI extraction leg — the FIRST cross-family substitute for an eligible Grok pass-A failure.
 *
 * Owner-approved 15 August 2026: wire exactly gemini-2.5-flash as the first substitute when a
 * typed eligible Grok failure occurs. Gemini is a different model family from DeepSeek, so
 * pass-A-via-Gemini + pass-B-via-DeepSeek keeps full provider-family independence. DeepSeek
 * Flash remains the LAST resort with its existing reduced-independence semantics unchanged.
 *
 * The Gemini client uses the OpenAI-compatible endpoint at generativelanguage.googleapis.com.
 * Thinking/reasoning mode is enabled subject to the existing EXTRACT_MAX_OUTPUT_TOKENS ceiling.
 *
 * Spend cap: USD 10 cumulative for Gemini, hard, enforced through the usage-ledger mechanism.
 */

import { num, resolveSecret, type Env } from "../types/env";
import {
  chatJson,
  MissingCredential,
  type ChatOptions,
  type ChatOutcome,
  type ProviderSpec,
} from "./chat";

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
export const GEMINI_EXTRACTION_ROUTE_VERSION = "gemini-extraction-route/1.0.0";

/**
 * Google AI Studio rates for gemini-2.5-flash, checked 15 Aug 2026 at
 * https://ai.google.dev/pricing. Thinking tokens are billed at the output rate.
 *
 * The two tiers share the same USD/Mtok rates; context-length pricing does not
 * apply to 2.5-flash at the time of this writing. Conservative: use the higher
 * of the two if they ever diverge (same policy as Grok's max-known-text-tier).
 */
export const GEMINI_OFFICIAL_RATES = {
  "gemini-2.5-flash": { inputUsdPerMTok: 0.15, outputUsdPerMTok: 3.5 },
} as const;

export interface GeminiModelLeg {
  model: string;
  maxAttempts: number;
}

function configuredRate(value: string | undefined, name: string): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a finite non-negative USD-per-million-token rate`);
  }
  return parsed;
}

function geminiLeg(env: Env): GeminiModelLeg {
  const model = env.GEMINI_EXTRACTION_MODEL ?? DEFAULT_GEMINI_MODEL;
  if (model !== DEFAULT_GEMINI_MODEL) {
    throw new Error(
      `GEMINI_EXTRACTION_MODEL must be pinned to ${DEFAULT_GEMINI_MODEL}, got ${JSON.stringify(model)}`,
    );
  }
  return {
    model,
    maxAttempts: Math.max(1, Math.floor(num(env.EXTRACT_MAX_ATTEMPTS, 2))),
  };
}

function ratesFor(env: Env): { inputUsdPerMTok: number; outputUsdPerMTok: number } {
  const configuredInput = configuredRate(env.GEMINI_INPUT_USD_PER_MTOK, "GEMINI_INPUT_USD_PER_MTOK");
  const configuredOutput = configuredRate(env.GEMINI_OUTPUT_USD_PER_MTOK, "GEMINI_OUTPUT_USD_PER_MTOK");
  if ((configuredInput === null) !== (configuredOutput === null)) {
    throw new Error("GEMINI_INPUT_USD_PER_MTOK and GEMINI_OUTPUT_USD_PER_MTOK must be configured together");
  }
  if (configuredInput !== null && configuredOutput !== null) {
    return { inputUsdPerMTok: configuredInput, outputUsdPerMTok: configuredOutput };
  }
  const official = GEMINI_OFFICIAL_RATES[DEFAULT_GEMINI_MODEL];
  return official;
}

/**
 * Hard cumulative USD cap for all Gemini extraction spend in this Worker's lifetime.
 * Enforced before every Gemini purchase. Conservative: a purchase is metered at the
 * request-byte ceiling when no provider-reported usage is available.
 */
export function geminiMaxTotalUsd(env: Env): number {
  const raw = env.GEMINI_MAX_TOTAL_USD;
  if (raw === undefined) return 10;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("GEMINI_MAX_TOTAL_USD must be a finite non-negative number");
  }
  return parsed;
}

export function geminiGrokSubstituteIdentity(env: Env): string {
  const leg = geminiLeg(env);
  const rates = ratesFor(env);
  return [
    GEMINI_EXTRACTION_ROUTE_VERSION,
    `role:grok-substitute`,
    `model:${leg.model}`,
    `attempts:${leg.maxAttempts}`,
    `input-usd-per-mtok:${rates.inputUsdPerMTok}`,
    `output-usd-per-mtok:${rates.outputUsdPerMTok}`,
    `max-total-usd:${geminiMaxTotalUsd(env)}`,
  ].join("|");
}

/** Side-effect-free portion of the exact Gemini substitute shape, for pre-purchase byte gates. */
export function geminiGrokSubstituteRequestShape(
  env: Env,
): Pick<ProviderSpec, "model" | "extraBody"> {
  const leg = geminiLeg(env);
  return {
    model: leg.model,
    extraBody: {
      // Thinking/reasoning enabled per owner approval, subject to EXTRACT_MAX_OUTPUT_TOKENS.
      // Google's OpenAI-compatible endpoint accepts this field.
      reasoning_effort: env.GEMINI_REASONING_EFFORT ?? "medium",
    },
  };
}

export async function keyForGemini(env: Env): Promise<string> {
  const key = await resolveSecret(env.GEMINI_API_KEY);
  if (!key) {
    throw new MissingCredential(
      "GEMINI_API_KEY",
      "GEMINI_API_KEY is not available to this Worker. " +
        "The Gemini substitute for an eligible Grok pass-A failure requires a valid API key.",
    );
  }
  return key;
}

async function geminiSpec(env: Env): Promise<ProviderSpec> {
  const leg = geminiLeg(env);
  const rates = ratesFor(env);
  const apiKey = await keyForGemini(env);
  return {
    provider: "gemini",
    model: leg.model,
    // Gemini's OpenAI-compatible endpoint is at a different path structure.
    // When using the AI Gateway, route through the "google-ai-studio" provider.
    gatewaySuffix: "/v1beta",
    directBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey,
    inputUsdPerMTok: rates.inputUsdPerMTok,
    outputUsdPerMTok: rates.outputUsdPerMTok,
    extraBody: geminiGrokSubstituteRequestShape(env).extraBody,
  };
}

/**
 * Gemini substitute for one eligible failed Grok pass-A unit.
 *
 * This is a CROSS-FAMILY substitute: Gemini + DeepSeek Pro pass B maintains full
 * provider-family independence, unlike DeepSeek Flash which reduces it.
 */
export const geminiGrokSubstituteJson = async (
  env: Env,
  opts: ChatOptions,
): Promise<ChatOutcome> => {
  const leg = geminiLeg(env);
  if (
    opts.maxAttempts !== undefined &&
    Math.max(1, Math.floor(opts.maxAttempts)) !== leg.maxAttempts
  ) {
    throw new Error(
      `Gemini grok-substitute maxAttempts must match its stored route identity (${leg.maxAttempts}); ` +
        `received ${JSON.stringify(opts.maxAttempts)}`,
    );
  }
  const spec = await geminiSpec(env);
  return chatJson(spec, env, { ...opts, maxAttempts: leg.maxAttempts });
};

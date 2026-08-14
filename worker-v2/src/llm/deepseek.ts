/**
 * DeepSeek is the block-by-block extraction METHOD. Flash and Pro are two model
 * legs behind that one provider/method; they are continuity, never independent
 * corroboration. The independent second method remains Grok pass A.
 *
 * A logical pass-B unit first buys the configured primary purchase. A transport,
 * truncation, empty-body, or JSON failure may buy ONE configured fallback
 * purchase. Each purchase keeps its own model, token, attempt, and cost receipt.
 * Nothing below combines those receipts into a fictional single model call.
 */

import { num, type Env } from "../types/env";
import type { CallUsage } from "../extract/types";
import {
  chatJson,
  keyFor,
  ModelCallError,
  type ChatOptions,
  type ChatOutcome,
  type ProviderSpec,
} from "./chat";

export const DEEPSEEK_CONTINUITY_VERSION = "deepseek-continuity/1.0.0";
export const DEFAULT_DEEPSEEK_PRIMARY_MODEL = "deepseek-v4-flash";
export const DEFAULT_DEEPSEEK_FALLBACK_MODEL = "deepseek-v4-pro";
export const DEEPSEEK_EXTRACTION_ROUTE_VERSION = "deepseek-extraction-route/1.0.0";

/** Official api.deepseek.com rates checked 2026-08-13, USD per million tokens. */
export const DEEPSEEK_OFFICIAL_RATES = {
  "deepseek-v4-flash": { inputUsdPerMTok: 0.14, outputUsdPerMTok: 0.28 },
  "deepseek-v4-pro": { inputUsdPerMTok: 0.435, outputUsdPerMTok: 0.87 },
} as const;

export interface DeepseekModelLeg {
  role: "primary" | "fallback";
  model: string;
  reasoningEffort: string;
  /** Transport attempts inside this one model purchase. */
  maxAttempts: number;
}

export interface DeepseekContinuityPlan {
  kind: typeof DEEPSEEK_CONTINUITY_VERSION;
  provider: "deepseek";
  primary: DeepseekModelLeg;
  fallback: DeepseekModelLeg | null;
}

export interface DeepseekContinuityOutcome extends ChatOutcome {
  /** Every purchase made for this logical unit, including a failed primary. */
  issuedCalls: CallUsage[];
  planIdentity: string;
  fallbackUsed: boolean;
}

/** A failed logical unit still exposes every paid purchase to the usage ledger. */
export class DeepseekContinuityError extends Error {
  constructor(
    message: string,
    readonly issuedCalls: CallUsage[],
    readonly failureKind: ModelCallError["failureKind"] | "unexpected",
    readonly fallbackAttempted: boolean,
  ) {
    super(message);
    this.name = "DeepseekContinuityError";
  }
}

/**
 * Pro can help when Flash itself is unavailable or returned unusable content.
 * It cannot repair account authentication, exhausted balance, or an invalid request
 * shared by both models; buying Pro for those failures only doubles a doomed spend.
 */
export function deepseekFallbackEligible(error: ModelCallError): boolean {
  return (
    error.failureKind === "timeout-or-network" ||
    error.failureKind === "rate-limited" ||
    error.failureKind === "provider-unavailable" ||
    error.failureKind === "invalid-content"
  );
}

function fallbackMode(env: Env): "on-error" | "disabled" {
  const mode = env.DEEPSEEK_FALLBACK_MODE ?? "on-error";
  if (mode !== "on-error" && mode !== "disabled") {
    throw new Error(
      `DEEPSEEK_FALLBACK_MODE must be "on-error" or "disabled", got ${JSON.stringify(mode)}`,
    );
  }
  return mode;
}

/**
 * Resolve the full plan before any paid call. A bad fallback configuration therefore
 * fails before the primary can spend money and leave an unaccounted receipt behind.
 */
export function deepseekContinuityPlan(env: Env): DeepseekContinuityPlan {
  const primaryModel = env.DEEPSEEK_MODEL ?? DEFAULT_DEEPSEEK_PRIMARY_MODEL;
  const fallbackModel = env.DEEPSEEK_FALLBACK_MODEL ?? DEFAULT_DEEPSEEK_FALLBACK_MODEL;
  const primary: DeepseekModelLeg = {
    role: "primary",
    model: primaryModel,
    reasoningEffort: env.DEEPSEEK_REASONING_EFFORT ?? "medium",
    maxAttempts: Math.max(1, Math.floor(num(env.EXTRACT_MAX_ATTEMPTS, 2))),
  };
  const enabled = fallbackMode(env) === "on-error" && fallbackModel !== primaryModel;
  const fallback: DeepseekModelLeg | null = enabled
    ? {
        role: "fallback",
        model: fallbackModel,
        reasoningEffort: env.DEEPSEEK_FALLBACK_REASONING_EFFORT ?? "medium",
        // Deliberately smaller than the primary retry budget. One failed logical unit
        // can buy at most two fallback transport attempts, regardless of a bad knob.
        maxAttempts: Math.min(2, Math.max(1, Math.floor(num(env.DEEPSEEK_FALLBACK_MAX_ATTEMPTS, 1)))),
      }
    : null;
  return { kind: DEEPSEEK_CONTINUITY_VERSION, provider: "deepseek", primary, fallback };
}

/**
 * Stable output-affecting identity for chunk artifacts, completed pass payloads, and
 * cross-run contract reuse. Prices are not included: a rate update changes accounting,
 * not the extraction answer, and reused calls are charged zero by design.
 */
export function deepseekContinuityIdentity(env: Env): string {
  const plan = deepseekContinuityPlan(env);
  const leg = (value: DeepseekModelLeg): string =>
    `${value.role}:${value.model}:reasoning=${value.reasoningEffort}:attempts=${value.maxAttempts}`;
  return [plan.kind, leg(plan.primary), plan.fallback ? leg(plan.fallback) : "fallback:disabled"].join("|");
}

function configuredRate(value: string | undefined, name: string): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a finite non-negative USD-per-million-token rate`);
  }
  return parsed;
}

function deepseekUnboundModelRateCeiling(env: Env, specs: ProviderSpec[]): {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
} {
  // Missing/mismatched response identity cannot be priced as Flash merely because
  // Flash was requested. Start with every checked DeepSeek SKU even when fallback
  // is disabled, then include any higher configured leg rate.
  const checked = Object.values(DEEPSEEK_OFFICIAL_RATES);
  const configuredInputs = [
    configuredRate(env.DEEPSEEK_INPUT_USD_PER_MTOK, "DEEPSEEK_INPUT_USD_PER_MTOK"),
    configuredRate(env.DEEPSEEK_FALLBACK_INPUT_USD_PER_MTOK, "DEEPSEEK_FALLBACK_INPUT_USD_PER_MTOK"),
  ].filter((value): value is number => value !== null);
  const configuredOutputs = [
    configuredRate(env.DEEPSEEK_OUTPUT_USD_PER_MTOK, "DEEPSEEK_OUTPUT_USD_PER_MTOK"),
    configuredRate(env.DEEPSEEK_FALLBACK_OUTPUT_USD_PER_MTOK, "DEEPSEEK_FALLBACK_OUTPUT_USD_PER_MTOK"),
  ].filter((value): value is number => value !== null);
  return {
    inputUsdPerMTok: Math.max(
      ...checked.map((rate) => rate.inputUsdPerMTok),
      ...specs.map((spec) => spec.inputUsdPerMTok),
      ...configuredInputs,
    ),
    outputUsdPerMTok: Math.max(
      ...checked.map((rate) => rate.outputUsdPerMTok),
      ...specs.map((spec) => spec.outputUsdPerMTok),
      ...configuredOutputs,
    ),
  };
}

function ratesFor(env: Env, leg: DeepseekModelLeg): { inputUsdPerMTok: number; outputUsdPerMTok: number } {
  const inputName = leg.role === "primary"
    ? "DEEPSEEK_INPUT_USD_PER_MTOK"
    : "DEEPSEEK_FALLBACK_INPUT_USD_PER_MTOK";
  const outputName = leg.role === "primary"
    ? "DEEPSEEK_OUTPUT_USD_PER_MTOK"
    : "DEEPSEEK_FALLBACK_OUTPUT_USD_PER_MTOK";
  const configuredInput = configuredRate(env[inputName], inputName);
  const configuredOutput = configuredRate(env[outputName], outputName);
  if ((configuredInput === null) !== (configuredOutput === null)) {
    throw new Error(`${inputName} and ${outputName} must be configured together`);
  }
  if (configuredInput !== null && configuredOutput !== null) {
    return { inputUsdPerMTok: configuredInput, outputUsdPerMTok: configuredOutput };
  }
  const official = DEEPSEEK_OFFICIAL_RATES[leg.model as keyof typeof DEEPSEEK_OFFICIAL_RATES];
  if (!official) {
    throw new Error(
      `no checked DeepSeek rate for ${leg.model}; configure ${inputName} and ${outputName} explicitly before calling it`,
    );
  }
  return official;
}

/**
 * The existing Flash -> Pro continuity plan is retained as a provider primitive, but the
 * extraction topology does not execute that chain as pass B. In the owner-approved route,
 * Flash is the dormant substitute for an eligible failed Grok pass-A unit and Pro is the
 * ordinary block-walk pass B. These helpers select those exact legs without allowing one
 * to silently stand in for the other.
 */
function extractionLeg(env: Env, role: "grok-fallback" | "pass-b"): DeepseekModelLeg {
  const plan = deepseekContinuityPlan(env);
  if (role === "grok-fallback") {
    if (plan.primary.model !== DEFAULT_DEEPSEEK_PRIMARY_MODEL) {
      throw new Error(
        `Grok fallback must be pinned to ${DEFAULT_DEEPSEEK_PRIMARY_MODEL}, got ${JSON.stringify(plan.primary.model)}`,
      );
    }
    return { ...plan.primary, role: "primary" };
  }
  const model = env.DEEPSEEK_FALLBACK_MODEL ?? DEFAULT_DEEPSEEK_FALLBACK_MODEL;
  if (model !== DEFAULT_DEEPSEEK_FALLBACK_MODEL) {
    throw new Error(
      `pass B must be pinned to ${DEFAULT_DEEPSEEK_FALLBACK_MODEL}, got ${JSON.stringify(model)}`,
    );
  }
  return {
    role: "fallback",
    model,
    reasoningEffort: env.DEEPSEEK_FALLBACK_REASONING_EFFORT ?? "medium",
    // Pass B is an ordinary extraction leg, not the second purchase of the dormant
    // continuity chain. Its attempt ceiling is therefore the ordinary extraction ceiling.
    maxAttempts: Math.max(1, Math.floor(num(env.EXTRACT_MAX_ATTEMPTS, 2))),
  };
}

function extractionLegIdentity(env: Env, role: "grok-fallback" | "pass-b"): string {
  const leg = extractionLeg(env, role);
  const rates = ratesFor(env, leg);
  return [
    DEEPSEEK_EXTRACTION_ROUTE_VERSION,
    `role:${role}`,
    `model:${leg.model}`,
    `reasoning:${leg.reasoningEffort}`,
    `attempts:${leg.maxAttempts}`,
    `input-usd-per-mtok:${rates.inputUsdPerMTok}`,
    `output-usd-per-mtok:${rates.outputUsdPerMTok}`,
  ].join("|");
}

export const deepseekGrokFallbackIdentity = (env: Env): string =>
  extractionLegIdentity(env, "grok-fallback");

export const deepseekPassBIdentity = (env: Env): string =>
  extractionLegIdentity(env, "pass-b");

/** Side-effect-free portion of the exact Flash substitute shape, for pre-purchase byte gates. */
function requestShapeForLeg(
  leg: DeepseekModelLeg,
): Pick<ProviderSpec, "model" | "extraBody"> {
  return {
    model: leg.model,
    extraBody: {
      thinking: { type: "enabled" },
      reasoning_effort: leg.reasoningEffort,
    },
  };
}

export function deepseekGrokFallbackRequestShape(
  env: Env,
): Pick<ProviderSpec, "model" | "extraBody"> {
  return requestShapeForLeg(extractionLeg(env, "grok-fallback"));
}

async function extractionLegJson(
  env: Env,
  role: "grok-fallback" | "pass-b",
  opts: ChatOptions,
): Promise<ChatOutcome> {
  const leg = extractionLeg(env, role);
  if (
    opts.maxAttempts !== undefined &&
    Math.max(1, Math.floor(opts.maxAttempts)) !== leg.maxAttempts
  ) {
    throw new Error(
      `${role} maxAttempts must match its stored route identity (${leg.maxAttempts}); ` +
        `received ${JSON.stringify(opts.maxAttempts)}`,
    );
  }
  const spec = await specForLeg(env, leg, await keyFor(env, "deepseek"));
  spec.unboundModelRateCeiling = deepseekUnboundModelRateCeiling(env, [spec]);
  return chatJson(spec, env, { ...opts, maxAttempts: leg.maxAttempts });
}

/** Dormant substitute for one eligible failed Grok pass-A unit. Never calls Pro. */
export const deepseekGrokFallbackJson = (
  env: Env,
  opts: ChatOptions,
): Promise<ChatOutcome> => extractionLegJson(env, "grok-fallback", opts);

/** Ordinary DeepSeek Pro block-walk pass B. Never speculatively calls Flash. */
export const deepseekPassBJson = (
  env: Env,
  opts: ChatOptions,
): Promise<ChatOutcome> => extractionLegJson(env, "pass-b", opts);

export function deepseekPassBAttemptCeiling(env: Env): number {
  return extractionLeg(env, "pass-b").maxAttempts;
}

async function specForLeg(env: Env, leg: DeepseekModelLeg, apiKey: string): Promise<ProviderSpec> {
  const rates = ratesFor(env, leg);
  const request = requestShapeForLeg(leg);
  return {
    provider: "deepseek",
    model: request.model,
    gatewaySuffix: "",
    directBaseUrl: "https://api.deepseek.com",
    apiKey,
    inputUsdPerMTok: rates.inputUsdPerMTok,
    outputUsdPerMTok: rates.outputUsdPerMTok,
    extraBody: request.extraBody,
  };
}

/** Primary spec retained for direct client tests and diagnostics. */
export async function deepseekSpec(env: Env): Promise<ProviderSpec> {
  const plan = deepseekContinuityPlan(env);
  const spec = await specForLeg(env, plan.primary, await keyFor(env, "deepseek"));
  spec.unboundModelRateCeiling = deepseekUnboundModelRateCeiling(env, [spec]);
  return spec;
}

/** Primary-only call retained as an explicit primitive; pass B uses continuity below. */
export const deepseekJson = async (env: Env, opts: ChatOptions): Promise<ChatOutcome> =>
  chatJson(await deepseekSpec(env), env, opts);

/**
 * Execute one logical pass-B unit. The fallback is same-provider continuity and is
 * intentionally tagged with a distinct call id; downstream accounting sees two model
 * calls when two purchases happened.
 */
export async function deepseekJsonWithContinuity(
  env: Env,
  opts: ChatOptions,
): Promise<DeepseekContinuityOutcome> {
  const plan = deepseekContinuityPlan(env);
  const identity = deepseekContinuityIdentity(env);
  if (
    opts.maxAttempts !== undefined &&
    Math.max(1, Math.floor(opts.maxAttempts)) !== plan.primary.maxAttempts
  ) {
    throw new Error(
      `DeepSeek primary maxAttempts must match the continuity plan (${plan.primary.maxAttempts}); ` +
        `received ${JSON.stringify(opts.maxAttempts)}`,
    );
  }
  const apiKey = await keyFor(env, "deepseek");
  // Resolve and validate both price tables before the first paid call.
  const primarySpec = await specForLeg(env, plan.primary, apiKey);
  const fallbackSpec = plan.fallback ? await specForLeg(env, plan.fallback, apiKey) : null;
  const unboundModelRateCeiling = deepseekUnboundModelRateCeiling(
    env,
    [primarySpec, ...(fallbackSpec ? [fallbackSpec] : [])],
  );
  primarySpec.unboundModelRateCeiling = unboundModelRateCeiling;
  if (fallbackSpec) fallbackSpec.unboundModelRateCeiling = unboundModelRateCeiling;
  try {
    const primary = await chatJson(primarySpec, env, { ...opts, maxAttempts: plan.primary.maxAttempts });
    return { ...primary, issuedCalls: [primary.usage], planIdentity: identity, fallbackUsed: false };
  } catch (err) {
    if (!(err instanceof ModelCallError)) throw err;
    if (!fallbackSpec || !plan.fallback || !deepseekFallbackEligible(err)) {
      throw new DeepseekContinuityError(err.message, [err.usage], err.failureKind, false);
    }
    try {
      const fallback = await chatJson(fallbackSpec, env, {
        ...opts,
        callId: `${opts.callId}:fallback`,
        maxAttempts: plan.fallback.maxAttempts,
      });
      return {
        ...fallback,
        issuedCalls: [err.usage, fallback.usage],
        planIdentity: identity,
        fallbackUsed: true,
      };
    } catch (fallbackErr) {
      if (!(fallbackErr instanceof ModelCallError)) {
        throw new DeepseekContinuityError(
          `DeepSeek fallback raised an unexpected error for ${opts.role}: ` +
            `${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
          [err.usage],
          "unexpected",
          true,
        );
      }
      throw new DeepseekContinuityError(
        `DeepSeek primary and fallback failed for ${opts.role}: ${fallbackErr.message}`,
        [err.usage, fallbackErr.usage],
        fallbackErr.failureKind,
        true,
      );
    }
  }
}

/** Worst-case transport attempts one logical pass-B unit can occupy. */
export function deepseekContinuityAttemptCeiling(env: Env): number {
  const plan = deepseekContinuityPlan(env);
  return plan.primary.maxAttempts + (plan.fallback?.maxAttempts ?? 0);
}

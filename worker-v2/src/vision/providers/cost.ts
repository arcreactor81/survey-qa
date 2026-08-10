/**
 * PRE-CALL BILLED-CASH CEILINGS FOR THE PINNED VISUAL ADAPTERS.
 *
 * Actual telemetry is committed after a call. Admission needs a number before the call, so this
 * module deliberately computes an upper bound rather than a forecast. Unknown models/configs are
 * refused. Rates and documented token caps are dated because prices are mutable external facts.
 */

import { canonicalJson } from "../../store/hash";
import type { VisionClientRequest, VisionModelSpec } from "../types";
import {
  CLOUDFLARE_GATEWAY_GEMINI_MAX_COMPLETION_TOKENS,
  CLOUDFLARE_GATEWAY_GEMINI_MODEL,
  CLOUDFLARE_GATEWAY_GEMINI_PROVIDER,
} from "./cloudflare-gateway-gemini";
import {
  GEMINI_36_FLASH_MODEL,
  GEMINI_DIRECT_MAX_OUTPUT_TOKENS,
  GEMINI_DIRECT_PROVIDER,
} from "./gemini-direct";
import {
  MISTRAL_MEDIUM35_CONTEXT_TOKENS,
  MISTRAL_MEDIUM35_MAX_COMPLETION_TOKENS,
  MISTRAL_MEDIUM35_MODEL,
  MISTRAL_MEDIUM35_PROVIDER,
} from "./mistral-medium35";
import {
  WORKERS_AI_GEMMA4_MAX_COMPLETION_TOKENS,
  WORKERS_AI_GEMMA4_MODEL,
  WORKERS_AI_GEMMA4_PROVIDER,
} from "./workers-ai-gemma4";

const enc = new TextEncoder();

export const VISUAL_RATE_CARD_AS_OF = "2026-08-10" as const;
export const GEMINI_36_FLASH_INPUT_USD_PER_MTOK = 1.5;
export const GEMINI_36_FLASH_OUTPUT_USD_PER_MTOK = 7.5;
export const GEMINI_36_FLASH_HIGH_IMAGE_TOKENS = 1_120;
// Bounds fixed wrapper/schema serialization and tokenizer framing beyond the exact UTF-8 byte
// counts below. UTF-8 bytes themselves are already a deliberately conservative text-token bound.
export const GEMINI_36_FLASH_INPUT_OVERHEAD_TOKENS = 4_096;
// Unified Billing passes through provider inference rates, then charges 5% when the credits used
// to pay those requests are purchased. Visual USD policy is an external cash ceiling, so both
// admission and post-call settlement conservatively allocate that fee to each Gateway request.
export const CLOUDFLARE_UNIFIED_BILLING_CREDIT_PURCHASE_FEE_RATE = 0.05;
export const CLOUDFLARE_UNIFIED_BILLING_CASH_MULTIPLIER =
  1 + CLOUDFLARE_UNIFIED_BILLING_CREDIT_PURCHASE_FEE_RATE;

export const GEMMA4_INPUT_USD_PER_MTOK = 0.1;
export const GEMMA4_OUTPUT_USD_PER_MTOK = 0.3;
export const GEMMA4_CONTEXT_TOKENS = 256_000;

// Public rates remain the conservative accounting posture even when the owner's research
// agreement makes Mistral usage free. If that entitlement changes, the canary still stops at
// its explicit dollar cap rather than treating an external plan promise as zero-cost telemetry.
export const MISTRAL_MEDIUM35_INPUT_USD_PER_MTOK = 1.5;
export const MISTRAL_MEDIUM35_OUTPUT_USD_PER_MTOK = 7.5;

export interface VisionCallCostCeiling {
  rateCardAsOf: typeof VISUAL_RATE_CARD_AS_OF;
  provider: string;
  model: string;
  inputTokensUpperBound: number;
  outputTokensUpperBound: number;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  billingBasis: "provider-inference-rate" | "cloudflare-unified-billing-credit-purchase";
  billingMultiplier: number;
  maximumCostUsd: number;
  basis: "documented-context-window" | "exact-text-bytes-plus-documented-image-cap";
}

export function maximumVisionCallCostUsd(
  request: VisionClientRequest,
  model: VisionModelSpec,
): VisionCallCostCeiling {
  if (model.provider === WORKERS_AI_GEMMA4_PROVIDER && model.model === WORKERS_AI_GEMMA4_MODEL) {
    return ceiling({
      provider: model.provider,
      model: model.model,
      inputTokensUpperBound: GEMMA4_CONTEXT_TOKENS,
      outputTokensUpperBound: WORKERS_AI_GEMMA4_MAX_COMPLETION_TOKENS,
      inputRate: GEMMA4_INPUT_USD_PER_MTOK,
      outputRate: GEMMA4_OUTPUT_USD_PER_MTOK,
      billingBasis: "provider-inference-rate",
      billingMultiplier: 1,
      basis: "documented-context-window",
    });
  }

  if (
    model.provider === MISTRAL_MEDIUM35_PROVIDER &&
    model.model === MISTRAL_MEDIUM35_MODEL
  ) {
    return ceiling({
      provider: model.provider,
      model: model.model,
      inputTokensUpperBound: MISTRAL_MEDIUM35_CONTEXT_TOKENS,
      outputTokensUpperBound: MISTRAL_MEDIUM35_MAX_COMPLETION_TOKENS,
      inputRate: MISTRAL_MEDIUM35_INPUT_USD_PER_MTOK,
      outputRate: MISTRAL_MEDIUM35_OUTPUT_USD_PER_MTOK,
      billingBasis: "provider-inference-rate",
      billingMultiplier: 1,
      basis: "documented-context-window",
    });
  }

  const isDirect = model.provider === GEMINI_DIRECT_PROVIDER && model.model === GEMINI_36_FLASH_MODEL;
  const isGateway =
    model.provider === CLOUDFLARE_GATEWAY_GEMINI_PROVIDER &&
    model.model === CLOUDFLARE_GATEWAY_GEMINI_MODEL;
  if (!isDirect && !isGateway) {
    throw new Error(`no pre-call visual cost ceiling for ${model.provider}/${model.model}`);
  }
  const outputTokensUpperBound = isDirect
    ? GEMINI_DIRECT_MAX_OUTPUT_TOKENS
    : CLOUDFLARE_GATEWAY_GEMINI_MAX_COMPLETION_TOKENS;
  const promptBytes = enc.encode(request.prompt.text).byteLength;
  const schemaBytes = enc.encode(canonicalJson(request.responseSchema.jsonSchema)).byteLength;
  const inputTokensUpperBound =
    promptBytes +
    schemaBytes +
    GEMINI_36_FLASH_HIGH_IMAGE_TOKENS +
    GEMINI_36_FLASH_INPUT_OVERHEAD_TOKENS;
  return ceiling({
    provider: model.provider,
    model: model.model,
    inputTokensUpperBound,
    outputTokensUpperBound,
    inputRate: GEMINI_36_FLASH_INPUT_USD_PER_MTOK,
    outputRate: GEMINI_36_FLASH_OUTPUT_USD_PER_MTOK,
    billingBasis: isGateway
      ? "cloudflare-unified-billing-credit-purchase"
      : "provider-inference-rate",
    billingMultiplier: isGateway ? CLOUDFLARE_UNIFIED_BILLING_CASH_MULTIPLIER : 1,
    basis: "exact-text-bytes-plus-documented-image-cap",
  });
}

export function configuredVisionCostUsd(
  telemetry: { inputTokens: number | null; outputTokens: number | null; model?: string },
  model: VisionModelSpec,
): number | null {
  // Billing a substituted/aliased model at the requested model's rate would turn identity drift
  // into false budget headroom. Preserve it as unknown until an authoritative charge is returned.
  if (telemetry.model !== undefined && telemetry.model !== model.model) return null;
  if (telemetry.inputTokens === null || telemetry.outputTokens === null) return null;
  if (!Number.isSafeInteger(telemetry.inputTokens) || telemetry.inputTokens < 0) return null;
  if (!Number.isSafeInteger(telemetry.outputTokens) || telemetry.outputTokens < 0) return null;
  if (model.provider === WORKERS_AI_GEMMA4_PROVIDER && model.model === WORKERS_AI_GEMMA4_MODEL) {
    return tokenCost(telemetry.inputTokens, telemetry.outputTokens, GEMMA4_INPUT_USD_PER_MTOK, GEMMA4_OUTPUT_USD_PER_MTOK);
  }
  if (
    model.provider === MISTRAL_MEDIUM35_PROVIDER &&
    model.model === MISTRAL_MEDIUM35_MODEL
  ) {
    return tokenCost(
      telemetry.inputTokens,
      telemetry.outputTokens,
      MISTRAL_MEDIUM35_INPUT_USD_PER_MTOK,
      MISTRAL_MEDIUM35_OUTPUT_USD_PER_MTOK,
    );
  }
  if (
    model.provider === GEMINI_DIRECT_PROVIDER && model.model === GEMINI_36_FLASH_MODEL
  ) {
    return tokenCost(
      telemetry.inputTokens,
      telemetry.outputTokens,
      GEMINI_36_FLASH_INPUT_USD_PER_MTOK,
      GEMINI_36_FLASH_OUTPUT_USD_PER_MTOK,
    );
  }
  if (
    model.provider === CLOUDFLARE_GATEWAY_GEMINI_PROVIDER &&
    model.model === CLOUDFLARE_GATEWAY_GEMINI_MODEL
  ) {
    return tokenCost(
      telemetry.inputTokens,
      telemetry.outputTokens,
      GEMINI_36_FLASH_INPUT_USD_PER_MTOK,
      GEMINI_36_FLASH_OUTPUT_USD_PER_MTOK,
      CLOUDFLARE_UNIFIED_BILLING_CASH_MULTIPLIER,
    );
  }
  return null;
}

function ceiling(input: {
  provider: string;
  model: string;
  inputTokensUpperBound: number;
  outputTokensUpperBound: number;
  inputRate: number;
  outputRate: number;
  billingBasis: VisionCallCostCeiling["billingBasis"];
  billingMultiplier: number;
  basis: VisionCallCostCeiling["basis"];
}): VisionCallCostCeiling {
  return {
    rateCardAsOf: VISUAL_RATE_CARD_AS_OF,
    provider: input.provider,
    model: input.model,
    inputTokensUpperBound: input.inputTokensUpperBound,
    outputTokensUpperBound: input.outputTokensUpperBound,
    inputUsdPerMillionTokens: input.inputRate,
    outputUsdPerMillionTokens: input.outputRate,
    billingBasis: input.billingBasis,
    billingMultiplier: input.billingMultiplier,
    maximumCostUsd: tokenCost(
      input.inputTokensUpperBound,
      input.outputTokensUpperBound,
      input.inputRate,
      input.outputRate,
      input.billingMultiplier,
    ),
    basis: input.basis,
  };
}

function tokenCost(
  inputTokens: number,
  outputTokens: number,
  inputRate: number,
  outputRate: number,
  billingMultiplier = 1,
): number {
  const raw =
    ((inputTokens * inputRate + outputTokens * outputRate) / 1_000_000) * billingMultiplier;
  // Dollar arithmetic enters a hard cap. Round upward at a precision far below one cent so a
  // floating-point tail can never create budget headroom.
  return Math.ceil(raw * 1_000_000_000_000) / 1_000_000_000_000;
}

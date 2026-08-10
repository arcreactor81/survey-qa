/**
 * FAIL-CLOSED VISUAL SHADOW ROLLOUT CONFIGURATION.
 *
 * Visual perception is paid, new, and deliberately unable to influence verdicts during the
 * shadow phase. There is no default provider and no default paid allowance. A deployment that
 * omits, misspells, or partly configures this block issues zero visual calls (disabled) or fails
 * configuration validation before a call (explicitly enabled but invalid).
 *
 * Concurrency is not a knob: it is fixed at one. Strict preflight is a read followed by a claim;
 * parallel purchases could both observe the same remaining budget and oversubscribe it.
 */

import type { Env, SecretBinding } from "../types/env";
import { canonicalHash } from "../store/hash";
import type { VisionClient, VisionModelSpec } from "./types";
import {
  CloudflareGatewayGeminiVisionClient,
  GeminiDirectVisionClient,
  MistralMedium35VisionClient,
  WorkersAiGemma4VisionClient,
  cloudflareGatewayGeminiModelSpec,
  geminiDirectModelSpec,
  mistralMedium35ModelSpec,
  workersAiGemma4ModelSpec,
} from "./providers";

export const VISUAL_ROLLOUT_CONFIGURATION_SCHEMA_VERSION =
  "survey-qa-visual-rollout-configuration/1.0.0" as const;

/** R2 reads/writes, validation, and Workflow scheduling after the last allowed purchase start. */
export const VISUAL_SHADOW_STEP_SLACK_MS = 60_000;

export const VISUAL_PROVIDER_SELECTORS = [
  "workers-ai-gemma4",
  "cloudflare-gateway-gemini",
  "gemini-direct",
  "mistral-medium35-direct",
] as const;

export type VisualProviderSelector = (typeof VISUAL_PROVIDER_SELECTORS)[number];

export type VisualShadowConfiguration =
  | {
      schemaVersion: typeof VISUAL_ROLLOUT_CONFIGURATION_SCHEMA_VERSION;
      enabled: false;
      concurrency: 1;
    }
  | {
      schemaVersion: typeof VISUAL_ROLLOUT_CONFIGURATION_SCHEMA_VERSION;
      enabled: true;
      provider: VisualProviderSelector;
      maximumCalls: number;
      maximumUsd: number;
      timeoutMs: number;
      waveBudgetMs: number;
      maximumWaves: number;
      concurrency: 1;
    };

export interface ResolvedVisualProvider {
  client: VisionClient;
  modelSpec: VisionModelSpec;
}

export class VisualRolloutConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisualRolloutConfigurationError";
  }
}

/** Parse the complete paid boundary. This function has no side effects and resolves no secret. */
export function visualShadowConfiguration(env: Env): VisualShadowConfiguration {
  const enabled = parseEnabled(env.VISUAL_SHADOW_ENABLED);
  if (!enabled) {
    return {
      schemaVersion: VISUAL_ROLLOUT_CONFIGURATION_SCHEMA_VERSION,
      enabled: false,
      concurrency: 1,
    };
  }

  const provider = exactProvider(env.VISUAL_PROVIDER);
  const maximumCalls = requiredInteger(env.VISUAL_MAX_CALLS, "VISUAL_MAX_CALLS", 1, 10_000);
  const maximumUsd = requiredMoney(env.VISUAL_MAX_USD, "VISUAL_MAX_USD", 1_000);
  const timeoutMs = requiredInteger(env.VISUAL_TIMEOUT_MS, "VISUAL_TIMEOUT_MS", 1_000, 300_000);
  const waveBudgetMs = requiredInteger(
    env.VISUAL_WAVE_BUDGET_MS,
    "VISUAL_WAVE_BUDGET_MS",
    1_000,
    420_000,
  );
  const maximumWaves = requiredInteger(env.VISUAL_MAX_WAVES, "VISUAL_MAX_WAVES", 1, 1_000);

  return {
    schemaVersion: VISUAL_ROLLOUT_CONFIGURATION_SCHEMA_VERSION,
    enabled: true,
    provider,
    maximumCalls,
    maximumUsd,
    timeoutMs,
    waveBudgetMs,
    maximumWaves,
    concurrency: 1,
  };
}

/** Fingerprint the parsed, closed policy rather than ambient or unrecognized environment keys. */
export async function visualShadowConfigurationSha256(
  configuration: VisualShadowConfiguration,
): Promise<string> {
  return await canonicalHash(configuration);
}

/**
 * Fingerprint only the recognized, non-secret rollout inputs when the closed parser rejects
 * them. An invalid deployment still needs a stable authorization identity so closed coverage
 * can report every skipped epoch without recording ambient bindings or credential material.
 */
export async function visualShadowRawConfigurationSha256(env: Env): Promise<string> {
  return await canonicalHash({
    schemaVersion: VISUAL_ROLLOUT_CONFIGURATION_SCHEMA_VERSION,
    kind: "survey-qa-visual-rollout-raw-input",
    enabled: env.VISUAL_SHADOW_ENABLED ?? null,
    provider: env.VISUAL_PROVIDER ?? null,
    maximumCalls: env.VISUAL_MAX_CALLS ?? null,
    maximumUsd: env.VISUAL_MAX_USD ?? null,
    timeoutMs: env.VISUAL_TIMEOUT_MS ?? null,
    waveBudgetMs: env.VISUAL_WAVE_BUDGET_MS ?? null,
    maximumWaves: env.VISUAL_MAX_WAVES ?? null,
  });
}

/**
 * A wave stops starting purchases at `waveBudgetMs` but never abandons one it already bought.
 * The surrounding Workflow step must therefore cover the budget, one complete provider
 * deadline, and non-provider storage/scheduling slack. Keeping the arithmetic here prevents a
 * configuration change from quietly reintroducing a step timeout that can cut off paid work.
 */
export function visualShadowStepTimeoutMs(configuration: VisualShadowConfiguration): number {
  if (!configuration.enabled) {
    throw new VisualRolloutConfigurationError("disabled visual shadow work has no paid wave timeout");
  }
  return configuration.waveBudgetMs + configuration.timeoutMs + VISUAL_SHADOW_STEP_SLACK_MS;
}

/**
 * Resolve exactly the selected adapter. No fallback is permitted: silently switching provider,
 * transport, model, or credential path would invalidate both cost accounting and evaluation.
 */
export async function resolveVisualProvider(
  env: Env,
  configuration: VisualShadowConfiguration,
): Promise<ResolvedVisualProvider> {
  if (!configuration.enabled) {
    throw new VisualRolloutConfigurationError(
      "visual provider resolution refused because VISUAL_SHADOW_ENABLED is not true",
    );
  }

  switch (configuration.provider) {
    case "workers-ai-gemma4": {
      const ai = requireAi(env);
      return {
        client: new WorkersAiGemma4VisionClient(ai),
        modelSpec: await workersAiGemma4ModelSpec(),
      };
    }
    case "cloudflare-gateway-gemini": {
      const ai = requireAi(env);
      const gatewayId = requireBoundedText(env.CF_AIG_GATEWAY_ID, "CF_AIG_GATEWAY_ID", 128);
      return {
        client: new CloudflareGatewayGeminiVisionClient(ai, gatewayId),
        modelSpec: await cloudflareGatewayGeminiModelSpec(gatewayId),
      };
    }
    case "gemini-direct": {
      const secret = requireSecret(env.GEMINI_API_KEY, "GEMINI_API_KEY");
      return {
        client: new GeminiDirectVisionClient(secret),
        modelSpec: await geminiDirectModelSpec(),
      };
    }
    case "mistral-medium35-direct": {
      const secret = requireSecret(env.MISTRAL_API_KEY, "MISTRAL_API_KEY");
      return {
        client: new MistralMedium35VisionClient(secret),
        modelSpec: await mistralMedium35ModelSpec(),
      };
    }
  }
}

function parseEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new VisualRolloutConfigurationError(
    'VISUAL_SHADOW_ENABLED must be exactly "true", exactly "false", or unset',
  );
}

function exactProvider(value: string | undefined): VisualProviderSelector {
  if ((VISUAL_PROVIDER_SELECTORS as readonly string[]).includes(value ?? "")) {
    return value as VisualProviderSelector;
  }
  throw new VisualRolloutConfigurationError(
    `VISUAL_PROVIDER must explicitly name one of ${VISUAL_PROVIDER_SELECTORS.join(", ")}`,
  );
}

function requiredInteger(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new VisualRolloutConfigurationError(`${name} must be an explicit base-10 integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new VisualRolloutConfigurationError(
      `${name} must be between ${minimum} and ${maximum}, inclusive`,
    );
  }
  return parsed;
}

function requiredMoney(value: string | undefined, name: string, maximum: number): number {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,12})?$/.test(value)) {
    throw new VisualRolloutConfigurationError(
      `${name} must be an explicit non-negative decimal with at most 12 fractional digits`,
    );
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maximum) {
    throw new VisualRolloutConfigurationError(`${name} must be greater than zero and at most ${maximum}`);
  }
  return parsed;
}

function requireAi(env: Env): Ai {
  if (env.AI === undefined) {
    throw new VisualRolloutConfigurationError("the selected visual provider requires the AI binding");
  }
  return env.AI;
}

function requireBoundedText(value: string | undefined, name: string, maximumLength: number): string {
  if (value === undefined || value.length === 0 || value.length > maximumLength) {
    throw new VisualRolloutConfigurationError(`${name} is required by the selected visual provider`);
  }
  return value;
}

function requireSecret(
  value: string | SecretBinding | undefined,
  name: "GEMINI_API_KEY" | "MISTRAL_API_KEY",
): SecretBinding {
  if (value === undefined) {
    throw new VisualRolloutConfigurationError(
      `${name} Secrets Store binding is required by the selected visual provider`,
    );
  }
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new VisualRolloutConfigurationError(`${name} must not be empty`);
    }
    // Local test compatibility. Production wrangler configs bind Secrets Store and therefore
    // take the object branch; the key remains lazily resolved by the provider adapter.
    return { get: async () => value };
  }
  if (typeof value.get !== "function") {
    throw new VisualRolloutConfigurationError(`${name} is not a readable secret binding`);
  }
  return value;
}

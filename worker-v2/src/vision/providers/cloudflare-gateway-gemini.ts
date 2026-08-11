import type { VisionClient, VisionClientOutcome, VisionClientRequest, VisionModelSpec } from "../types";
import { VisionProviderUnavailableError } from "../types";
// @ts-ignore -- plain ESM is the single runtime/deployment provider-configuration source
import * as providerConfigurationSource from "../../../shared/visual-provider-config.mjs";
const {
  CLOUDFLARE_GATEWAY_GEMINI_MAX_COMPLETION_TOKENS: SHARED_GATEWAY_MAX_COMPLETION_TOKENS,
  CLOUDFLARE_GATEWAY_GEMINI_MAX_MODEL_CONTENT_CHARS,
  CLOUDFLARE_GATEWAY_GEMINI_MAX_SCREENSHOT_BYTES,
  CLOUDFLARE_GATEWAY_GEMINI_MODEL: SHARED_GATEWAY_MODEL,
  CLOUDFLARE_GATEWAY_GEMINI_PROVIDER: SHARED_GATEWAY_PROVIDER,
  CLOUDFLARE_GATEWAY_GEMINI_TRANSPORT: SHARED_GATEWAY_TRANSPORT,
  cloudflareGatewayGeminiConfiguration: sharedCloudflareGatewayGeminiConfiguration,
} = providerConfigurationSource;
import {
  assertExactProductionVisionRequest,
  boundedProviderString,
  elapsedMilliseconds,
  encodeBase64,
  hashVisionProviderConfiguration,
  isAbortError,
  jsonSchemaObject,
  parseModelJsonOrReturnText,
  providerTokenCount,
  sanitizedProviderFailure,
  throwIfAborted,
} from "./shared";

export const CLOUDFLARE_GATEWAY_GEMINI_PROVIDER: "cloudflare-ai-gateway" =
  SHARED_GATEWAY_PROVIDER;
export const CLOUDFLARE_GATEWAY_GEMINI_MODEL: "google-ai-studio/gemini-3.6-flash" =
  SHARED_GATEWAY_MODEL;
export const CLOUDFLARE_GATEWAY_GEMINI_TRANSPORT:
  "workers-ai-binding-ai-gateway-unified-billing" = SHARED_GATEWAY_TRANSPORT;

const MAX_SCREENSHOT_BYTES: number = CLOUDFLARE_GATEWAY_GEMINI_MAX_SCREENSHOT_BYTES;
const MAX_MODEL_CONTENT_CHARS: number = CLOUDFLARE_GATEWAY_GEMINI_MAX_MODEL_CONTENT_CHARS;
// Bound the charged tail so the strict preflight can reserve a real worst case. If one viewport
// cannot fit, closed validation fails visibly and the capture layer can tile it.
export const CLOUDFLARE_GATEWAY_GEMINI_MAX_COMPLETION_TOKENS: 2048 =
  SHARED_GATEWAY_MAX_COMPLETION_TOKENS;
const MAX_COMPLETION_TOKENS = CLOUDFLARE_GATEWAY_GEMINI_MAX_COMPLETION_TOKENS;
const GATEWAY_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function cloudflareGatewayGeminiConfiguration(
  gatewayId: string,
): import("./shared").VisionProviderConfigurationEnvelope {
  assertGatewayId(gatewayId);
  return sharedCloudflareGatewayGeminiConfiguration(gatewayId);
}

export async function cloudflareGatewayGeminiModelSpec(
  gatewayId: string,
): Promise<VisionModelSpec> {
  const configuration = cloudflareGatewayGeminiConfiguration(gatewayId);
  return {
    provider: CLOUDFLARE_GATEWAY_GEMINI_PROVIDER,
    model: CLOUDFLARE_GATEWAY_GEMINI_MODEL,
    transport: CLOUDFLARE_GATEWAY_GEMINI_TRANSPORT,
    configurationSha256: await hashVisionProviderConfiguration(configuration),
  };
}

export async function createCloudflareGatewayGeminiProvider(
  ai: Ai,
  gatewayId: string,
): Promise<{ client: CloudflareGatewayGeminiVisionClient; modelSpec: VisionModelSpec }> {
  return {
    client: new CloudflareGatewayGeminiVisionClient(ai, gatewayId),
    modelSpec: await cloudflareGatewayGeminiModelSpec(gatewayId),
  };
}

/**
 * Keyless Gemini through Cloudflare Unified Billing. The explicit gateway options are a privacy
 * and cost boundary: no Gateway log collection, no cached cross-run answer, and one attempt.
 */
export class CloudflareGatewayGeminiVisionClient implements VisionClient {
  constructor(
    private readonly ai: Ai,
    private readonly gatewayId: string,
  ) {
    assertGatewayId(gatewayId);
  }

  async observe(request: VisionClientRequest, signal: AbortSignal): Promise<VisionClientOutcome> {
    const startedAt = performance.now();
    try {
      throwIfAborted(signal);
      await assertExactProductionVisionRequest(request);
      if (request.screenshot.bytes.byteLength > MAX_SCREENSHOT_BYTES) {
        throw sanitizedProviderFailure("visual screenshot exceeds the AI Gateway adapter limit");
      }
      throwIfAborted(signal);

      const response: unknown = await this.ai.run(
        CLOUDFLARE_GATEWAY_GEMINI_MODEL,
        {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: request.prompt.text },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:image/png;base64,${encodeBase64(request.screenshot.bytes)}`,
                    detail: "high",
                  },
                },
              ],
            },
          ],
          max_completion_tokens: MAX_COMPLETION_TOKENS,
          n: 1,
          reasoning_effort: "low",
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "survey_qa_visual_inventory",
              schema: jsonSchemaObject(request.responseSchema.jsonSchema),
              strict: true,
            },
          },
          seed: 0,
          store: false,
          stream: false,
          temperature: 0,
        },
        {
          signal,
          gateway: {
            id: this.gatewayId,
            collectLog: false,
            retries: { maxAttempts: 1 },
            skipCache: true,
          },
        },
      );
      throwIfAborted(signal);

      const envelope = parseGatewayResponseIdentity(response);
      const usage = validatedGatewayUsage(envelope.usage);
      const telemetry = gatewayTelemetry(request, envelope, usage, this.ai, startedAt);
      if (usage === null) {
        throw gatewayResponseFailure(telemetry);
      }
      let content: string;
      try {
        content = parseGatewayResponseContent(envelope.value, telemetry);
      } catch (error) {
        if (error instanceof VisionProviderUnavailableError) throw error;
        // Throwing accessors on an injected/non-conforming binding cannot leak their exception,
        // but the already-validated request/model/usage receipt remains safe to account.
        throw gatewayResponseFailure(telemetry);
      }
      return {
        content: parseModelJsonOrReturnText(content),
        telemetry,
      };
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      if (error instanceof VisionProviderUnavailableError) throw error;
      throw sanitizedProviderFailure("AI Gateway Gemini visual inference was unavailable");
    }
  }
}

interface GatewayResponseIdentity {
  value: Record<string, unknown>;
  id: string;
  model: string;
  usage: unknown;
}

interface GatewayUsage {
  inputTokens: number;
  outputTokens: number;
}

function parseGatewayResponseIdentity(value: unknown): GatewayResponseIdentity {
  if (!isRecord(value)) throw gatewayResponseFailure();
  const id = boundedProviderString(value.id);
  const model = boundedProviderString(value.model, 200);
  if (
    id === null ||
    model === null ||
    value.object !== "chat.completion" ||
    !providerTimestamp(value.created)
  ) {
    throw gatewayResponseFailure();
  }
  return { value, id, model, usage: value.usage };
}

function validatedGatewayUsage(value: unknown): GatewayUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = providerTokenCount(value.prompt_tokens);
  const outputTokens = providerTokenCount(value.completion_tokens);
  const totalTokens = providerTokenCount(value.total_tokens);
  if (
    inputTokens === null ||
    outputTokens === null ||
    totalTokens === null ||
    !Number.isSafeInteger(inputTokens + outputTokens) ||
    inputTokens + outputTokens !== totalTokens
  ) {
    return null;
  }
  return { inputTokens, outputTokens };
}

function gatewayTelemetry(
  request: VisionClientRequest,
  envelope: GatewayResponseIdentity,
  usage: GatewayUsage | null,
  ai: Ai,
  startedAt: number,
): VisionClientOutcome["telemetry"] {
  return {
    callId: request.callId,
    provider: CLOUDFLARE_GATEWAY_GEMINI_PROVIDER,
    model: envelope.model,
    providerRequestId: envelope.id,
    // `collectLog:false` normally makes this null; preserve an actual bounded ID if returned.
    gatewayLogId: safeGatewayLogId(ai),
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    // The chat response does not expose the Unified Billing charge. The durable cost estimator
    // applies both the provider rate and Cloudflare's credit-purchase fee after this boundary.
    costUsd: null,
    usageSource: usage === null ? "unavailable" : "provider-reported",
    attempts: 1,
    latencyMs: elapsedMilliseconds(startedAt),
  };
}

function parseGatewayResponseContent(
  value: Record<string, unknown>,
  telemetry: VisionClientOutcome["telemetry"],
): string {
  if (!Array.isArray(value.choices) || value.choices.length !== 1) {
    throw gatewayResponseFailure(telemetry);
  }
  const first = value.choices[0];
  if (
    !isRecord(first) ||
    !hasOnlyKeys(first, ["index", "message", "finish_reason", "logprobs"]) ||
    first.index !== 0 ||
    first.finish_reason !== "stop" ||
    !nullOrAbsent(first.logprobs) ||
    !isRecord(first.message) ||
    !hasOnlyKeys(first.message, ["role", "content", "refusal", "tool_calls", "function_call"]) ||
    first.message.role !== "assistant" ||
    !nullOrAbsent(first.message.refusal) ||
    !nullOrAbsent(first.message.tool_calls) ||
    !nullOrAbsent(first.message.function_call) ||
    typeof first.message.content !== "string" ||
    first.message.content.length === 0 ||
    first.message.content.length > MAX_MODEL_CONTENT_CHARS
  ) {
    throw gatewayResponseFailure(telemetry);
  }
  return first.message.content;
}

function gatewayResponseFailure(
  telemetry: VisionClientOutcome["telemetry"] | null = null,
): VisionProviderUnavailableError {
  return new VisionProviderUnavailableError(
    "AI Gateway returned an incomplete or malformed transport response",
    telemetry,
  );
}

function safeGatewayLogId(ai: Ai): string | null {
  try {
    return boundedProviderString(ai.aiGatewayLogId);
  } catch {
    return null;
  }
}

function providerTimestamp(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullOrAbsent(value: unknown): boolean {
  return value === null || value === undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowlist = new Set(allowed);
  return Object.keys(value).every((key) => allowlist.has(key));
}

function assertGatewayId(value: string): void {
  if (!GATEWAY_ID.test(value)) {
    throw sanitizedProviderFailure("AI Gateway id is unavailable or malformed");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

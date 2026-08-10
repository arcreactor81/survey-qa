import type { VisionClient, VisionClientOutcome, VisionClientRequest, VisionModelSpec } from "../types";
import { VisionProviderUnavailableError } from "../types";
import {
  VISION_PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  assertExactProductionVisionRequest,
  boundedProviderString,
  elapsedMilliseconds,
  encodeBase64,
  hashVisionProviderConfiguration,
  isAbortError,
  jsonSchemaObject,
  parseModelJsonOrReturnText,
  providerTokenCount,
  readBoundedResponseText,
  resolveSecret,
  sanitizedProviderFailure,
  throwIfAborted,
  type VisionProviderConfigurationEnvelope,
} from "./shared";

export const GEMINI_DIRECT_PROVIDER = "google-gemini-api";
export const GEMINI_36_FLASH_MODEL = "gemini-3.6-flash";
export const GEMINI_DIRECT_TRANSPORT = "gemini-interactions-v1-direct-fetch";
export const GEMINI_INTERACTIONS_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1/interactions";

const MAX_INLINE_REQUEST_BYTES = 20_000_000;
const MAX_SUCCESS_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
// Bound the charged tail. Dense screens must degrade to a named truncation/malformed result and
// be recaptured as tiles rather than silently spending past the run reserve.
export const GEMINI_DIRECT_MAX_OUTPUT_TOKENS = 2_048;
const MAX_OUTPUT_TOKENS = GEMINI_DIRECT_MAX_OUTPUT_TOKENS;

export interface AsyncSecretSource {
  get(): Promise<string>;
}

export type GeminiSecretSource = AsyncSecretSource | (() => Promise<string>);
export type VisionFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Every inference-affecting Gemini Interactions API field is fingerprinted. */
export const GEMINI_DIRECT_CONFIGURATION = {
  schemaVersion: VISION_PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  provider: GEMINI_DIRECT_PROVIDER,
  model: GEMINI_36_FLASH_MODEL,
  transport: GEMINI_DIRECT_TRANSPORT,
  request: {
    api: "gemini-interactions/v1",
    endpoint: GEMINI_INTERACTIONS_ENDPOINT,
    image: { mediaType: "image/png", resolution: "high", encoding: "inline-base64" },
    structuredOutput: { type: "text", mimeType: "application/json" },
    generation: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      seed: 0,
      thinkingLevel: "low",
      thinkingSummaries: "none",
    },
    privacy: { background: false, store: false, stream: false },
    transportPolicy: {
      attempts: 1,
      maxErrorResponseBytes: MAX_ERROR_RESPONSE_BYTES,
      maxInlineRequestBytes: MAX_INLINE_REQUEST_BYTES,
      maxSuccessResponseBytes: MAX_SUCCESS_RESPONSE_BYTES,
    },
  },
} as const satisfies VisionProviderConfigurationEnvelope;

export async function geminiDirectModelSpec(): Promise<VisionModelSpec> {
  return {
    provider: GEMINI_DIRECT_PROVIDER,
    model: GEMINI_36_FLASH_MODEL,
    transport: GEMINI_DIRECT_TRANSPORT,
    configurationSha256: await hashVisionProviderConfiguration(GEMINI_DIRECT_CONFIGURATION),
  };
}

/**
 * Provider-native Gemini adapter. The API key is resolved lazily from an injected Secrets Store
 * binding/getter and is placed only in the request header, never in a URL, payload, error, or log.
 */
export class GeminiDirectVisionClient implements VisionClient {
  constructor(
    private readonly secret: GeminiSecretSource,
    private readonly fetcher: VisionFetch = fetch,
  ) {}

  async observe(request: VisionClientRequest, signal: AbortSignal): Promise<VisionClientOutcome> {
    const startedAt = performance.now();
    try {
      throwIfAborted(signal);
      await assertExactProductionVisionRequest(request);
      const apiKey = await resolveSecret(this.secret, signal);
      const body = JSON.stringify({
        model: GEMINI_36_FLASH_MODEL,
        input: [
          { type: "text", text: request.prompt.text },
          {
            type: "image",
            data: encodeBase64(request.screenshot.bytes),
            mime_type: "image/png",
            resolution: "high",
          },
        ],
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: jsonSchemaObject(request.responseSchema.jsonSchema),
        },
        generation_config: {
          max_output_tokens: MAX_OUTPUT_TOKENS,
          seed: 0,
          thinking_level: "low",
          thinking_summaries: "none",
        },
        store: false,
        background: false,
        stream: false,
      });
      if (new TextEncoder().encode(body).byteLength > MAX_INLINE_REQUEST_BYTES) {
        throw sanitizedProviderFailure("visual screenshot exceeds Gemini's inline request limit");
      }
      throwIfAborted(signal);

      const response = await this.fetcher(GEMINI_INTERACTIONS_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body,
        signal,
      });
      throwIfAborted(signal);

      if (!response.ok) {
        try {
          await readBoundedResponseText(response, MAX_ERROR_RESPONSE_BYTES, signal);
        } catch (error) {
          if (isAbortError(error, signal)) throw error;
          // Raw provider errors are intentionally discarded whether bounded or oversized.
        }
        throw sanitizedProviderFailure(`Gemini visual inference returned HTTP ${response.status}`);
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("application/json")) {
        await response.body?.cancel().catch(() => undefined);
        throw sanitizedProviderFailure("Gemini returned a non-JSON transport response");
      }

      const responseText = await readBoundedResponseText(
        response,
        MAX_SUCCESS_RESPONSE_BYTES,
        signal,
      );
      const envelope = parseGeminiEnvelope(responseText);
      const inputTokens = providerTokenCount(envelope.usage?.total_input_tokens);
      const generatedOutputTokens = providerTokenCount(envelope.usage?.total_output_tokens);
      const rawThoughtTokens = envelope.usage?.total_thought_tokens;
      const thoughtTokens = rawThoughtTokens === undefined ? 0 : providerTokenCount(rawThoughtTokens);
      const outputTokens =
        generatedOutputTokens !== null &&
        thoughtTokens !== null &&
        Number.isSafeInteger(generatedOutputTokens + thoughtTokens)
          ? generatedOutputTokens + thoughtTokens
          : null;
      return {
        content: parseModelJsonOrReturnText(envelope.outputText),
        telemetry: {
          callId: request.callId,
          provider: GEMINI_DIRECT_PROVIDER,
          model: envelope.model,
          providerRequestId: envelope.id,
          gatewayLogId: null,
          inputTokens,
          outputTokens,
          // Interactions reports usage but not the account's charged dollar amount.
          costUsd: null,
          usageSource:
            inputTokens === null && outputTokens === null ? "unavailable" : "provider-reported",
          attempts: 1,
          latencyMs: elapsedMilliseconds(startedAt),
        },
      };
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      if (error instanceof VisionProviderUnavailableError) throw error;
      // This deliberately drops fetch/Secrets Store/provider text, which may contain credentials.
      throw sanitizedProviderFailure("Gemini visual inference was unavailable");
    }
  }
}

interface ParsedGeminiEnvelope {
  id: string;
  model: string;
  outputText: string;
  usage: {
    total_input_tokens?: unknown;
    total_output_tokens?: unknown;
    total_thought_tokens?: unknown;
  } | null;
}

function parseGeminiEnvelope(text: string): ParsedGeminiEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw sanitizedProviderFailure("Gemini returned malformed response JSON");
  }
  if (!isRecord(value)) throw sanitizedProviderFailure("Gemini returned a malformed transport response");
  const id = boundedProviderString(value.id);
  const model = boundedProviderString(value.model, 200);
  if (id === null || model === null || value.status !== "completed" || !Array.isArray(value.steps)) {
    throw sanitizedProviderFailure("Gemini returned a malformed transport response");
  }

  let modelOutput: Record<string, unknown> | null = null;
  for (const step of value.steps) {
    if (isRecord(step) && step.type === "model_output") modelOutput = step;
  }
  if (modelOutput === null || !Array.isArray(modelOutput.content)) {
    throw sanitizedProviderFailure("Gemini returned a malformed transport response");
  }
  const blocks: string[] = [];
  for (const block of modelOutput.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      throw sanitizedProviderFailure("Gemini returned a malformed transport response");
    }
    blocks.push(block.text);
  }
  const outputText = blocks.join("");
  if (outputText.length === 0) {
    throw sanitizedProviderFailure("Gemini returned a malformed transport response");
  }
  return {
    id,
    model,
    outputText,
    usage: isRecord(value.usage) ? value.usage : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type {
  VisionClient,
  VisionClientOutcome,
  VisionClientRequest,
  VisionModelSpec,
} from "../types";
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

export const MISTRAL_MEDIUM35_PROVIDER = "mistral-api";
export const MISTRAL_MEDIUM35_MODEL = "mistral-medium-3-5";
export const MISTRAL_MEDIUM35_TRANSPORT = "mistral-chat-completions-v1-direct-fetch";
export const MISTRAL_MEDIUM35_ENDPOINT = "https://api.mistral.ai/v1/chat/completions";
export const MISTRAL_MEDIUM35_CONTEXT_TOKENS = 256_000;

const MAX_SCREENSHOT_BYTES = 20_000_000;
const MAX_INLINE_REQUEST_BYTES = 30_000_000;
const MAX_SUCCESS_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const MAX_MODEL_CONTENT_CHARS = 2 * 1024 * 1024;
// A viewport whose complete closed inventory cannot fit is an explicit truncated provider result,
// not permission to silently omit visible regions. The capture layer can retry with tiles.
export const MISTRAL_MEDIUM35_MAX_COMPLETION_TOKENS = 2_048;
const RESPONSE_SCHEMA_NAME = "survey_qa_visual_inventory";

export type MistralSecretSource =
  | { get(): Promise<string> }
  | (() => Promise<string>);

export type MistralVisionFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Every inference-affecting Mistral request field and every local wire bound is fingerprinted. */
export const MISTRAL_MEDIUM35_CONFIGURATION = {
  schemaVersion: VISION_PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  provider: MISTRAL_MEDIUM35_PROVIDER,
  model: MISTRAL_MEDIUM35_MODEL,
  transport: MISTRAL_MEDIUM35_TRANSPORT,
  request: {
    api: "mistral-chat-completions/v1",
    endpoint: MISTRAL_MEDIUM35_ENDPOINT,
    image: {
      mediaType: "image/png",
      encoding: "inline-base64-data-url",
      maxBytes: MAX_SCREENSHOT_BYTES,
    },
    structuredOutput: {
      type: "json_schema",
      name: RESPONSE_SCHEMA_NAME,
      strict: true,
      validation: "provider-constrained-plus-observer-closed-schema",
    },
    generation: {
      maxTokens: MISTRAL_MEDIUM35_MAX_COMPLETION_TOKENS,
      n: 1,
      randomSeed: 0,
      reasoningEffort: "low",
      safePrompt: false,
      stream: false,
      temperature: 0,
    },
    transportPolicy: {
      attempts: 1,
      maxErrorResponseBytes: MAX_ERROR_RESPONSE_BYTES,
      maxInlineRequestBytes: MAX_INLINE_REQUEST_BYTES,
      maxModelContentChars: MAX_MODEL_CONTENT_CHARS,
      maxSuccessResponseBytes: MAX_SUCCESS_RESPONSE_BYTES,
    },
  },
} as const satisfies VisionProviderConfigurationEnvelope;

export async function mistralMedium35ModelSpec(): Promise<VisionModelSpec> {
  return {
    provider: MISTRAL_MEDIUM35_PROVIDER,
    model: MISTRAL_MEDIUM35_MODEL,
    transport: MISTRAL_MEDIUM35_TRANSPORT,
    configurationSha256: await hashVisionProviderConfiguration(MISTRAL_MEDIUM35_CONFIGURATION),
  };
}

/**
 * Direct Mistral stateless Chat Completions adapter. The API key is resolved only after the
 * screenshot, prompt, and response-schema identities have passed the production request gate.
 * It is carried solely in the Authorization header and no upstream body or exception escapes.
 */
export class MistralMedium35VisionClient implements VisionClient {
  constructor(
    private readonly secret: MistralSecretSource,
    private readonly fetcher: MistralVisionFetch = fetch,
  ) {}

  async observe(request: VisionClientRequest, signal: AbortSignal): Promise<VisionClientOutcome> {
    const startedAt = performance.now();
    try {
      throwIfAborted(signal);
      await assertExactProductionVisionRequest(request);
      if (request.screenshot.bytes.byteLength > MAX_SCREENSHOT_BYTES) {
        throw sanitizedProviderFailure("visual screenshot exceeds Mistral's image byte limit");
      }

      const apiKey = await resolveSecret(this.secret, signal);
      const body = JSON.stringify({
        model: MISTRAL_MEDIUM35_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: request.prompt.text },
              {
                type: "image_url",
                image_url: `data:image/png;base64,${encodeBase64(request.screenshot.bytes)}`,
              },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: RESPONSE_SCHEMA_NAME,
            schema: jsonSchemaObject(request.responseSchema.jsonSchema),
            strict: true,
          },
        },
        max_tokens: MISTRAL_MEDIUM35_MAX_COMPLETION_TOKENS,
        n: 1,
        random_seed: 0,
        reasoning_effort: "low",
        safe_prompt: false,
        stream: false,
        temperature: 0,
      });
      if (new TextEncoder().encode(body).byteLength > MAX_INLINE_REQUEST_BYTES) {
        throw sanitizedProviderFailure("visual screenshot exceeds the Mistral inline request limit");
      }
      throwIfAborted(signal);

      const response = await this.fetcher(MISTRAL_MEDIUM35_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
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
          // Provider error bodies are intentionally discarded whether readable or oversized.
        }
        throw sanitizedProviderFailure(`Mistral visual inference returned HTTP ${response.status}`);
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("application/json")) {
        await response.body?.cancel().catch(() => undefined);
        throw sanitizedProviderFailure("Mistral returned a non-JSON transport response");
      }

      const responseText = await readBoundedResponseText(
        response,
        MAX_SUCCESS_RESPONSE_BYTES,
        signal,
      );
      const envelope = parseMistralEnvelope(responseText);
      return {
        content: parseModelJsonOrReturnText(envelope.content),
        telemetry: {
          callId: request.callId,
          provider: MISTRAL_MEDIUM35_PROVIDER,
          model: envelope.model,
          providerRequestId: envelope.id,
          gatewayLogId: null,
          inputTokens: envelope.inputTokens,
          outputTokens: envelope.outputTokens,
          // Mistral reports tokens but not a per-request charged dollar amount.
          costUsd: null,
          usageSource: "provider-reported",
          attempts: 1,
          latencyMs: elapsedMilliseconds(startedAt),
        },
      };
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      if (error instanceof VisionProviderUnavailableError) throw error;
      // Drop fetch, Secrets Store, and provider exception text: each may contain credentials.
      throw sanitizedProviderFailure("Mistral visual inference was unavailable");
    }
  }
}

interface ParsedMistralEnvelope {
  id: string;
  model: string;
  content: string;
  inputTokens: number;
  outputTokens: number;
}

function parseMistralEnvelope(text: string): ParsedMistralEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw sanitizedProviderFailure("Mistral returned malformed response JSON");
  }
  if (!isRecord(value)) {
    throw sanitizedProviderFailure("Mistral returned a malformed transport response");
  }
  const id = boundedProviderString(value.id);
  const model = boundedProviderString(value.model, 200);
  if (
    id === null ||
    model === null ||
    value.object !== "chat.completion" ||
    !providerTimestamp(value.created) ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 1
  ) {
    throw sanitizedProviderFailure("Mistral returned a malformed transport response");
  }

  const choice = value.choices[0];
  if (
    !isRecord(choice) ||
    choice.index !== 0 ||
    choice.finish_reason !== "stop" ||
    !isRecord(choice.message) ||
    choice.message.role !== "assistant" ||
    (choice.message.tool_calls !== undefined && choice.message.tool_calls !== null)
  ) {
    // In particular, `length`/`model_length` is a named failure, never a shorter inventory.
    throw sanitizedProviderFailure("Mistral returned an incomplete or malformed transport response");
  }
  const content = finalMistralText(choice.message.content);
  if (content === null) {
    throw sanitizedProviderFailure("Mistral returned an incomplete or malformed transport response");
  }

  if (!isRecord(value.usage)) {
    throw sanitizedProviderFailure("Mistral returned a malformed usage receipt");
  }
  const inputTokens = providerTokenCount(value.usage.prompt_tokens);
  const outputTokens = providerTokenCount(value.usage.completion_tokens);
  const totalTokens = providerTokenCount(value.usage.total_tokens);
  if (
    inputTokens === null ||
    outputTokens === null ||
    totalTokens === null ||
    !Number.isSafeInteger(inputTokens + outputTokens) ||
    inputTokens + outputTokens !== totalTokens
  ) {
    throw sanitizedProviderFailure("Mistral returned a malformed usage receipt");
  }

  return {
    id,
    model,
    content,
    inputTokens,
    outputTokens,
  };
}

/** Adjustable reasoning can put private thinking chunks before the schema-constrained answer. */
function finalMistralText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.length > 0 && value.length <= MAX_MODEL_CONTENT_CHARS ? value : null;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null;

  const output: string[] = [];
  let outputChars = 0;
  let answerStarted = false;
  for (const chunk of value) {
    if (!isRecord(chunk)) return null;
    if (chunk.type === "thinking") {
      // Official reasoning responses place thinking before the final TextChunk. Reject a reordered
      // trace rather than guessing which subsequent bytes are the constrained answer.
      if (answerStarted || !Array.isArray(chunk.thinking)) return null;
      continue;
    }
    if (chunk.type !== "text" || typeof chunk.text !== "string" || chunk.text.length === 0) {
      return null;
    }
    answerStarted = true;
    outputChars += chunk.text.length;
    if (outputChars > MAX_MODEL_CONTENT_CHARS) return null;
    output.push(chunk.text);
  }
  return answerStarted ? output.join("") : null;
}

function providerTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

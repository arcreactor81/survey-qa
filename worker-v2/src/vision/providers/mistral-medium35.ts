import type {
  VisionClient,
  VisionClientOutcome,
  VisionClientRequest,
  VisionModelSpec,
} from "../types";
import { VisionProviderUnavailableError } from "../types";
// @ts-ignore -- plain ESM is the single runtime/deployment provider-configuration source
import * as providerConfigurationSource from "../../../shared/visual-provider-config.mjs";
const {
  MISTRAL_MEDIUM35_CONFIGURATION: SHARED_MISTRAL_MEDIUM35_CONFIGURATION,
  MISTRAL_MEDIUM35_CONTEXT_TOKENS: SHARED_MISTRAL_CONTEXT_TOKENS,
  MISTRAL_MEDIUM35_ENDPOINT: SHARED_MISTRAL_ENDPOINT,
  MISTRAL_MEDIUM35_MAX_COMPLETION_TOKENS: SHARED_MISTRAL_MAX_COMPLETION_TOKENS,
  MISTRAL_MEDIUM35_MAX_ERROR_RESPONSE_BYTES,
  MISTRAL_MEDIUM35_MAX_INLINE_REQUEST_BYTES,
  MISTRAL_MEDIUM35_MAX_MODEL_CONTENT_CHARS,
  MISTRAL_MEDIUM35_MAX_SCREENSHOT_BYTES,
  MISTRAL_MEDIUM35_MAX_SUCCESS_RESPONSE_BYTES,
  MISTRAL_MEDIUM35_MODEL: SHARED_MISTRAL_MODEL,
  MISTRAL_MEDIUM35_PROVIDER: SHARED_MISTRAL_PROVIDER,
  MISTRAL_MEDIUM35_RESPONSE_SCHEMA_NAME,
  MISTRAL_MEDIUM35_TRANSPORT: SHARED_MISTRAL_TRANSPORT,
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
  readBoundedResponseText,
  resolveSecret,
  sanitizedProviderFailure,
  throwIfAborted,
} from "./shared";

export const MISTRAL_MEDIUM35_PROVIDER: "mistral-api" = SHARED_MISTRAL_PROVIDER;
export const MISTRAL_MEDIUM35_MODEL: "mistral-medium-3-5" = SHARED_MISTRAL_MODEL;
export const MISTRAL_MEDIUM35_TRANSPORT: "mistral-chat-completions-v1-direct-fetch" =
  SHARED_MISTRAL_TRANSPORT;
export const MISTRAL_MEDIUM35_ENDPOINT: "https://api.mistral.ai/v1/chat/completions" =
  SHARED_MISTRAL_ENDPOINT;
export const MISTRAL_MEDIUM35_CONTEXT_TOKENS: 256000 = SHARED_MISTRAL_CONTEXT_TOKENS;

const MAX_SCREENSHOT_BYTES: number = MISTRAL_MEDIUM35_MAX_SCREENSHOT_BYTES;
const MAX_INLINE_REQUEST_BYTES: number = MISTRAL_MEDIUM35_MAX_INLINE_REQUEST_BYTES;
const MAX_SUCCESS_RESPONSE_BYTES: number = MISTRAL_MEDIUM35_MAX_SUCCESS_RESPONSE_BYTES;
const MAX_ERROR_RESPONSE_BYTES: number = MISTRAL_MEDIUM35_MAX_ERROR_RESPONSE_BYTES;
const MAX_MODEL_CONTENT_CHARS: number = MISTRAL_MEDIUM35_MAX_MODEL_CONTENT_CHARS;
// A viewport whose complete closed inventory cannot fit is an explicit truncated provider result,
// not permission to silently omit visible regions. The capture layer can retry with tiles.
export const MISTRAL_MEDIUM35_MAX_COMPLETION_TOKENS: 2048 =
  SHARED_MISTRAL_MAX_COMPLETION_TOKENS;
const RESPONSE_SCHEMA_NAME: string = MISTRAL_MEDIUM35_RESPONSE_SCHEMA_NAME;

export type MistralSecretSource =
  | { get(): Promise<string> }
  | (() => Promise<string>);

export type MistralVisionFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Every inference-affecting Mistral request field and every local wire bound is fingerprinted. */
export const MISTRAL_MEDIUM35_CONFIGURATION = SHARED_MISTRAL_MEDIUM35_CONFIGURATION;

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

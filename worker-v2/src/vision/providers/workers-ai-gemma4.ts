import type {
  VisionCallTelemetry,
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
  parseModelJsonOrReturnText,
  providerTokenCount,
  throwIfAborted,
  type VisionProviderConfigurationEnvelope,
} from "./shared";

export const WORKERS_AI_GEMMA4_PROVIDER = "cloudflare-workers-ai";
export const WORKERS_AI_GEMMA4_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const WORKERS_AI_GEMMA4_TRANSPORT = "workers-ai-binding";
export const WORKERS_AI_GEMMA4_FAILURE_CATEGORY = "workers-ai-binding";

export const WORKERS_AI_GEMMA4_FAILURE_CODES = [
  "request-contract-invalid",
  "request-screenshot-too-large",
  "request-payload-invalid",
  "inference-upstream",
  "ai-internal",
  "binding-timeout",
  "binding-abort",
  "unclassified-binding-failure",
  "response-unattributed-text",
  "response-envelope-invalid",
  "response-content-invalid",
  "response-finish-length",
  "response-finish-content-filter",
  "response-finish-tool-calls",
  "response-finish-function-call",
  "response-finish-invalid",
] as const;

export type WorkersAiGemma4FailureCode = (typeof WORKERS_AI_GEMMA4_FAILURE_CODES)[number];
export type WorkersAiGemma4FailurePhase = "preflight" | "binding" | "response";

export interface WorkersAiGemma4FailureReference {
  readonly providerFailureCategory: typeof WORKERS_AI_GEMMA4_FAILURE_CATEGORY;
  readonly providerFailureCode: WorkersAiGemma4FailureCode;
  readonly providerFailurePhase: WorkersAiGemma4FailurePhase;
  readonly providerCallAttempted: boolean;
}

const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const MAX_MODEL_CONTENT_CHARS = 2 * 1024 * 1024;
// A viewport inventory that cannot fit this closed response is reported as malformed and can be
// recaptured as tiles. A very large completion ceiling would make the pre-call dollar cap unable
// to reserve a defensible worst case.
export const WORKERS_AI_GEMMA4_MAX_COMPLETION_TOKENS = 2_048;
const MAX_COMPLETION_TOKENS = WORKERS_AI_GEMMA4_MAX_COMPLETION_TOKENS;
const REQUEST_TAG = "survey-qa:visual";
const CLOSED_WORKERS_AI_FAILURE = Symbol("closed-workers-ai-gemma4-failure");

/** Every inference-affecting adapter knob is sealed into `configurationSha256`. */
export const WORKERS_AI_GEMMA4_CONFIGURATION = {
  schemaVersion: VISION_PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  provider: WORKERS_AI_GEMMA4_PROVIDER,
  model: WORKERS_AI_GEMMA4_MODEL,
  transport: WORKERS_AI_GEMMA4_TRANSPORT,
  request: {
    api: "workers-ai-native-binding",
    payloadShape: "chat-completions-multimodal-message-content",
    message: {
      role: "user",
      contentPartOrder: ["text", "image_url"],
      image: { field: "image_url.url", mediaType: "image/png", encoding: "data-url", detail: "high" },
    },
    structuredOutput: {
      requestResponseFormat: false,
      mode: "prompted-json",
      validation: "observer-closed-schema",
      acceptedBindingResponse: "chat-completion-object",
      requiredFinishReason: "stop",
      unattributedTextResponse: "reject",
    },
    generation: {
      chatTemplateKwargs: { enableThinking: false },
      maxCompletionTokens: MAX_COMPLETION_TOKENS,
      n: 1,
      seed: 0,
      store: false,
      stream: false,
      temperature: 0,
    },
    transportPolicy: {
      attempts: 1,
      gateway: "none",
      maxModelContentChars: MAX_MODEL_CONTENT_CHARS,
      maxScreenshotBytes: MAX_SCREENSHOT_BYTES,
      tag: REQUEST_TAG,
    },
  },
} as const satisfies VisionProviderConfigurationEnvelope;

export async function workersAiGemma4ModelSpec(): Promise<VisionModelSpec> {
  return {
    provider: WORKERS_AI_GEMMA4_PROVIDER,
    model: WORKERS_AI_GEMMA4_MODEL,
    transport: WORKERS_AI_GEMMA4_TRANSPORT,
    configurationSha256: await hashVisionProviderConfiguration(WORKERS_AI_GEMMA4_CONFIGURATION),
  };
}

/**
 * Direct Workers AI binding adapter. It deliberately does not configure AI Gateway: there is no
 * payload log to retain, no retry layer, and `Ai.run` remains the single paid attempt.
 */
export class WorkersAiGemma4VisionClient implements VisionClient {
  constructor(private readonly ai: Ai) {}

  async observe(request: VisionClientRequest, signal: AbortSignal): Promise<VisionClientOutcome> {
    const startedAt = performance.now();
    let payload: ChatCompletionsInput;
    try {
      throwIfAborted(signal);
      await assertExactProductionVisionRequest(request);
      throwIfAborted(signal);
    } catch (error) {
      if (signal.aborted) throwIfAborted(signal);
      throw workersAiFailure(
        "Workers AI visual request failed preflight validation",
        "preflight",
        "request-contract-invalid",
        false,
      );
    }
    if (request.screenshot.bytes.byteLength > MAX_SCREENSHOT_BYTES) {
      throw workersAiFailure(
        "Workers AI visual request exceeded the adapter limit",
        "preflight",
        "request-screenshot-too-large",
        false,
      );
    }
    try {
      payload = buildNativeVisionPayload(request);
    } catch (error) {
      if (signal.aborted) throwIfAborted(signal);
      throw workersAiFailure(
        "Workers AI visual request could not be encoded",
        "preflight",
        "request-payload-invalid",
        false,
      );
    }

    let response: unknown;
    try {
      response = await this.ai.run(
        WORKERS_AI_GEMMA4_MODEL,
        payload,
        {
          signal,
          tags: [REQUEST_TAG],
        },
      );
    } catch (error) {
      if (signal.aborted) throwIfAborted(signal);
      // Only the closed name classification leaves this adapter. Platform exception text and
      // arbitrary platform fields are deliberately discarded rather than attached as `cause`.
      throw workersAiBindingFailure(error);
    }
    throwIfAborted(signal);

    let telemetry: VisionCallTelemetry | null = null;
    try {
      const envelope = parseWorkersAiResponseIdentity(response);
      telemetry = workersAiTelemetry(request, envelope, this.ai, startedAt);
      const content = parseWorkersAiResponseContent(envelope.value, telemetry);
      return {
        content: parseModelJsonOrReturnText(content),
        telemetry,
      };
    } catch (error) {
      if (isClosedWorkersAiFailure(error)) throw error;
      // A binding normally returns a structured clone, but an injected/non-conforming binding
      // can still expose throwing accessors. Collapse those too; arbitrary thrown text must not
      // cross the adapter boundary. Preserve identity/usage if they were validated first.
      throw workersAiFailure(
        "Workers AI returned an unusable response envelope",
        "response",
        "response-envelope-invalid",
        true,
        telemetry,
      );
    }
  }
}

/** Cloudflare's Gemma 4 binding uses the typed Chat Completions multimodal message shape. */
function buildNativeVisionPayload(request: VisionClientRequest): ChatCompletionsInput {
  return {
    messages: [{
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
    }],
    chat_template_kwargs: { enable_thinking: false },
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    n: 1,
    seed: 0,
    store: false,
    stream: false,
    temperature: 0,
  };
}

function workersAiBindingFailure(
  error: unknown,
): VisionProviderUnavailableError & WorkersAiGemma4FailureReference {
  const providerFailureCode = safeWorkersAiFailureCode(error);
  const failure = workersAiFailure(
    "Workers AI visual inference was unavailable",
    "binding",
    providerFailureCode,
    true,
  );
  // Preserve the observer's existing closed timeout classification without preserving the
  // platform's message, fields, stack, or cause.
  if (providerFailureCode === "binding-timeout") failure.name = "TimeoutError";
  if (providerFailureCode === "binding-abort") failure.name = "AbortError";
  return failure;
}

function safeWorkersAiFailureCode(error: unknown): WorkersAiGemma4FailureCode {
  try {
    if (error instanceof Error) {
      // These are the two named failures exposed by the Workers AI binding type surface. Do not
      // inspect its message or untyped numeric fields: neither belongs in durable evidence.
      if (error.name === "InferenceUpstreamError") return "inference-upstream";
      if (error.name === "AiInternalError") return "ai-internal";
      if (error.name === "TimeoutError") return "binding-timeout";
      if (error.name === "AbortError") return "binding-abort";
    }
  } catch {
    // A hostile exception accessor is unclassified. Its thrown value is never propagated.
  }
  return "unclassified-binding-failure";
}

function workersAiFailure(
  message: string,
  providerFailurePhase: WorkersAiGemma4FailurePhase,
  providerFailureCode: WorkersAiGemma4FailureCode,
  providerCallAttempted: boolean,
  telemetry: VisionCallTelemetry | null = null,
): VisionProviderUnavailableError & WorkersAiGemma4FailureReference {
  const failure = Object.assign(
    new VisionProviderUnavailableError(message, telemetry),
    {
      providerFailureCategory: WORKERS_AI_GEMMA4_FAILURE_CATEGORY,
      providerFailureCode,
      providerFailurePhase,
      providerCallAttempted,
    } as const,
  );
  Object.defineProperty(failure, CLOSED_WORKERS_AI_FAILURE, { value: true });
  return failure;
}

function isClosedWorkersAiFailure(value: unknown): boolean {
  try {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as Record<typeof CLOSED_WORKERS_AI_FAILURE, unknown>)[CLOSED_WORKERS_AI_FAILURE] === true
    );
  } catch {
    return false;
  }
}

interface WorkersAiResponseIdentity {
  value: Record<string, unknown>;
  id: string;
  model: string;
  usage: { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
}

function parseWorkersAiResponseIdentity(value: unknown): WorkersAiResponseIdentity {
  // Cloudflare's raw REST schema documents a bare-string alternative, but it carries no model,
  // request id, or usage. Treating that text as a successful completion would make the paid call
  // unattributable, so the binding adapter recognizes and rejects it by a named limitation.
  if (typeof value === "string") {
    throw workersAiFailure(
      "Workers AI returned an unattributed text response",
      "response",
      "response-unattributed-text",
      true,
    );
  }
  if (!isRecord(value)) {
    throw workersAiFailure(
      "Workers AI returned an unusable response envelope",
      "response",
      "response-envelope-invalid",
      true,
    );
  }
  const id = boundedProviderString(value.id);
  const model = boundedProviderString(value.model, 200);
  if (id === null || model === null) {
    throw workersAiFailure(
      "Workers AI returned an unusable response envelope",
      "response",
      "response-envelope-invalid",
      true,
    );
  }
  return { value, id, model, usage: isRecord(value.usage) ? value.usage : null };
}

function workersAiTelemetry(
  request: VisionClientRequest,
  envelope: WorkersAiResponseIdentity,
  ai: Ai,
  startedAt: number,
): VisionCallTelemetry {
  const inputTokens = providerTokenCount(envelope.usage?.prompt_tokens);
  const outputTokens = providerTokenCount(envelope.usage?.completion_tokens);
  return {
    callId: request.callId,
    provider: WORKERS_AI_GEMMA4_PROVIDER,
    model: envelope.model,
    providerRequestId: envelope.id,
    gatewayLogId: safeGatewayLogId(ai),
    inputTokens,
    outputTokens,
    // The binding response reports tokens but not the charged dollar amount.
    costUsd: null,
    usageSource:
      inputTokens === null && outputTokens === null ? "unavailable" : "provider-reported",
    attempts: 1,
    latencyMs: elapsedMilliseconds(startedAt),
  };
}

function safeGatewayLogId(ai: Ai): string | null {
  try {
    return boundedProviderString(ai.aiGatewayLogId);
  } catch {
    return null;
  }
}

function parseWorkersAiResponseContent(
  value: Record<string, unknown>,
  telemetry: VisionCallTelemetry,
): string {
  if (!Array.isArray(value.choices) || value.choices.length !== 1) {
    throw workersAiFailure(
      "Workers AI returned an unusable response envelope",
      "response",
      "response-envelope-invalid",
      true,
      telemetry,
    );
  }
  const first = value.choices[0];
  if (!isRecord(first) || first.index !== 0 || !isRecord(first.message) || first.message.role !== "assistant") {
    throw workersAiFailure(
      "Workers AI returned an unusable response envelope",
      "response",
      "response-envelope-invalid",
      true,
      telemetry,
    );
  }
  if (first.finish_reason !== "stop") {
    throw workersAiFailure(
      "Workers AI returned a non-final completion",
      "response",
      safeFinishReasonFailureCode(first.finish_reason),
      true,
      telemetry,
    );
  }
  const content = first.message.content;
  if (typeof content !== "string" || content.length === 0 || content.length > MAX_MODEL_CONTENT_CHARS) {
    throw workersAiFailure(
      "Workers AI returned unusable completion content",
      "response",
      "response-content-invalid",
      true,
      telemetry,
    );
  }
  return content;
}

function safeFinishReasonFailureCode(value: unknown): WorkersAiGemma4FailureCode {
  if (value === "length") return "response-finish-length";
  if (value === "content_filter") return "response-finish-content-filter";
  if (value === "tool_calls") return "response-finish-tool-calls";
  if (value === "function_call") return "response-finish-function-call";
  return "response-finish-invalid";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

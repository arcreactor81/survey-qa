/**
 * One runtime/deployment source for every inference-affecting visual-provider knob.
 *
 * This module is plain ESM so both the Worker TypeScript adapters and the local hardened deployer
 * consume the same objects. Secrets and binding instances are deliberately absent. Adding or
 * changing any request field changes the canonical configuration SHA-256 used by cache identity
 * and remote pre-spend attestation.
 */

export const VISION_PROVIDER_CONFIGURATION_SCHEMA_VERSION =
  "survey-qa-vision-provider-configuration/1.0.0";

export const WORKERS_AI_GEMMA4_PROVIDER = "cloudflare-workers-ai";
export const WORKERS_AI_GEMMA4_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const WORKERS_AI_GEMMA4_TRANSPORT = "workers-ai-binding";
export const WORKERS_AI_GEMMA4_MAX_COMPLETION_TOKENS = 2_048;
export const WORKERS_AI_GEMMA4_MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
export const WORKERS_AI_GEMMA4_MAX_MODEL_CONTENT_CHARS = 2 * 1024 * 1024;
export const WORKERS_AI_GEMMA4_REQUEST_TAG = "survey-qa:visual";

export const WORKERS_AI_GEMMA4_CONFIGURATION = deepFreeze({
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
      maxCompletionTokens: WORKERS_AI_GEMMA4_MAX_COMPLETION_TOKENS,
      n: 1,
      seed: 0,
      store: false,
      stream: false,
      temperature: 0,
    },
    transportPolicy: {
      attempts: 1,
      gateway: "none",
      maxModelContentChars: WORKERS_AI_GEMMA4_MAX_MODEL_CONTENT_CHARS,
      maxScreenshotBytes: WORKERS_AI_GEMMA4_MAX_SCREENSHOT_BYTES,
      tag: WORKERS_AI_GEMMA4_REQUEST_TAG,
    },
  },
});

export const CLOUDFLARE_GATEWAY_GEMINI_PROVIDER = "cloudflare-ai-gateway";
export const CLOUDFLARE_GATEWAY_GEMINI_MODEL = "google-ai-studio/gemini-3.6-flash";
export const CLOUDFLARE_GATEWAY_GEMINI_TRANSPORT =
  "workers-ai-binding-ai-gateway-unified-billing";
export const CLOUDFLARE_GATEWAY_GEMINI_MAX_COMPLETION_TOKENS = 2_048;
export const CLOUDFLARE_GATEWAY_GEMINI_MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
export const CLOUDFLARE_GATEWAY_GEMINI_MAX_MODEL_CONTENT_CHARS = 2 * 1024 * 1024;

export function cloudflareGatewayGeminiConfiguration(gatewayId) {
  if (typeof gatewayId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(gatewayId)) {
    throw new Error("AI Gateway id is unavailable or malformed");
  }
  return deepFreeze({
    schemaVersion: VISION_PROVIDER_CONFIGURATION_SCHEMA_VERSION,
    provider: CLOUDFLARE_GATEWAY_GEMINI_PROVIDER,
    model: CLOUDFLARE_GATEWAY_GEMINI_MODEL,
    transport: CLOUDFLARE_GATEWAY_GEMINI_TRANSPORT,
    request: {
      api: "ai-binding-openai-chat-completions",
      gateway: {
        id: gatewayId,
        collectLog: false,
        retries: { maxAttempts: 1 },
        skipCache: true,
      },
      image: { mediaType: "image/png", detail: "high", encoding: "data-url" },
      structuredOutput: {
        type: "json_schema",
        strict: true,
        acceptedBindingResponse: "single-chat-completion-object",
        requiredFinishReason: "stop",
        alternateCompletionSurface: "reject",
        usageValidation: "prompt-plus-completion-equals-total",
      },
      generation: {
        maxCompletionTokens: CLOUDFLARE_GATEWAY_GEMINI_MAX_COMPLETION_TOKENS,
        n: 1,
        reasoningEffort: "low",
        seed: 0,
        store: false,
        stream: false,
        temperature: 0,
      },
      transportPolicy: {
        attempts: 1,
        maxModelContentChars: CLOUDFLARE_GATEWAY_GEMINI_MAX_MODEL_CONTENT_CHARS,
        maxScreenshotBytes: CLOUDFLARE_GATEWAY_GEMINI_MAX_SCREENSHOT_BYTES,
      },
    },
  });
}

export const MISTRAL_MEDIUM35_PROVIDER = "mistral-api";
export const MISTRAL_MEDIUM35_MODEL = "mistral-medium-3-5";
export const MISTRAL_MEDIUM35_TRANSPORT = "mistral-chat-completions-v1-direct-fetch";
export const MISTRAL_MEDIUM35_ENDPOINT = "https://api.mistral.ai/v1/chat/completions";
export const MISTRAL_MEDIUM35_CONTEXT_TOKENS = 256_000;
export const MISTRAL_MEDIUM35_MAX_COMPLETION_TOKENS = 2_048;
export const MISTRAL_MEDIUM35_MAX_SCREENSHOT_BYTES = 20_000_000;
export const MISTRAL_MEDIUM35_MAX_INLINE_REQUEST_BYTES = 30_000_000;
export const MISTRAL_MEDIUM35_MAX_SUCCESS_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MISTRAL_MEDIUM35_MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
export const MISTRAL_MEDIUM35_MAX_MODEL_CONTENT_CHARS = 2 * 1024 * 1024;
export const MISTRAL_MEDIUM35_RESPONSE_SCHEMA_NAME = "survey_qa_visual_inventory";

export const MISTRAL_MEDIUM35_CONFIGURATION = deepFreeze({
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
      maxBytes: MISTRAL_MEDIUM35_MAX_SCREENSHOT_BYTES,
    },
    structuredOutput: {
      type: "json_schema",
      name: MISTRAL_MEDIUM35_RESPONSE_SCHEMA_NAME,
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
      maxErrorResponseBytes: MISTRAL_MEDIUM35_MAX_ERROR_RESPONSE_BYTES,
      maxInlineRequestBytes: MISTRAL_MEDIUM35_MAX_INLINE_REQUEST_BYTES,
      maxModelContentChars: MISTRAL_MEDIUM35_MAX_MODEL_CONTENT_CHARS,
      maxSuccessResponseBytes: MISTRAL_MEDIUM35_MAX_SUCCESS_RESPONSE_BYTES,
    },
  },
});

/** Resolve the exact adapter configuration without a binding, credential, or paid call. */
export function canaryVisualProviderConfiguration(selector, { gatewayId } = {}) {
  switch (selector) {
    case "workers-ai-gemma4":
      return WORKERS_AI_GEMMA4_CONFIGURATION;
    case "cloudflare-gateway-gemini":
      return cloudflareGatewayGeminiConfiguration(gatewayId);
    case "mistral-medium35-direct":
      return MISTRAL_MEDIUM35_CONFIGURATION;
    default:
      throw new Error("visual provider is not an attested canary selector");
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

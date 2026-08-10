import {
  createCloudflareGatewayGeminiProvider,
  WorkersAiGemma4VisionClient,
  workersAiGemma4ModelSpec,
} from "../../src/vision/providers";
import {
  computeVisualInferenceCacheKey,
  visualPromptSha256,
  visualResponseSchemaSha256,
} from "../../src/vision/observe";
import {
  VISUAL_INVENTORY_PROMPT,
  VISUAL_PROMPT_VERSION,
  VISUAL_RESPONSE_JSON_SCHEMA,
  VISUAL_RESPONSE_SCHEMA_VERSION,
} from "../../src/vision/schema";
import { sha256Hex } from "../../src/store/hash";
import {
  VisionProviderUnavailableError,
  type VisionClient,
  type VisionClientOutcome,
  type VisionModelSpec,
} from "../../src/vision/types";
import { coherentNotAttemptedPreflightReference } from "../../src/vision/provider-failure";

export { VisionProviderUnavailableError };

const REQUEST_SCHEMA_VERSION = "survey-visual-live-bakeoff-endpoint-request/1.0.0";
const RESPONSE_SCHEMA_VERSION = "survey-visual-live-bakeoff-endpoint-response/1.0.0";
const GATEWAY_ID = "firstgateway";
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_CALL_ID_CHARS = 200;
const HASH = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const PUBLIC_FIXTURES = Object.freeze({
  "semantic-radio": Object.freeze({
    sha256: "5fa79fff535f8f8de1214ffbfe3cf31e80bdc06b36437f5d7ee2d841534b72e7",
    pixelWidth: 720,
    pixelHeight: 520,
  }),
  "cards-multilingual": Object.freeze({
    sha256: "0e294c55ad93c91c904e2ac876beabeaeb6b07ffa8b44a4d02d01c33c4768409",
    pixelWidth: 840,
    pixelHeight: 640,
  }),
  "mobile-rtl-controls": Object.freeze({
    sha256: "ce478421fe10c5f837ea80c04dc7a7ba46b9ead2da30c0ed79240dd6a51a131e",
    pixelWidth: 390,
    pixelHeight: 720,
  }),
});

const MODEL_SELECTORS = ["workers-ai-gemma-4", "gateway-gemini-3.6-flash"] as const;
type ModelSelector = (typeof MODEL_SELECTORS)[number];

/** Deliberately tiny: this local-only worker has no application secrets or storage bindings. */
interface Env {
  AI: Ai;
  BAKEOFF_LOCAL_ONLY: string;
  BAKEOFF_GATEWAY_ID: string;
}

interface EndpointInput {
  schemaVersion: typeof REQUEST_SCHEMA_VERSION;
  fixtureId: keyof typeof PUBLIC_FIXTURES;
  modelSelector: ModelSelector;
  callId: string;
  screenshot: {
    sha256: string;
    pixelWidth: number;
    pixelHeight: number;
    base64: string;
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    if (!isLoopbackRequest(request)) return response(403, failure(null, false, "local-only"));
    if (request.method !== "POST" || new URL(request.url).pathname !== "/invoke") {
      return response(404, failure(null, false, "route-unavailable"));
    }
    if (
      env.BAKEOFF_LOCAL_ONLY !== "true" ||
      env.BAKEOFF_GATEWAY_ID !== GATEWAY_ID ||
      typeof env.AI?.run !== "function"
    ) {
      return response(503, failure(null, false, "binding-configuration-unavailable"));
    }

    let input: EndpointInput;
    let screenshotBytes: Uint8Array;
    try {
      input = parseInput(await readBoundedJson(request));
      screenshotBytes = decodeBase64(input.screenshot.base64);
      await assertTrustedScreenshot(input, screenshotBytes);
    } catch {
      return response(400, failure(null, false, "request-invalid"));
    }

    const selected = await selectProvider(env.AI, input.modelSelector);
    const [promptSha256, responseSchemaSha256] = await Promise.all([
      visualPromptSha256(),
      visualResponseSchemaSha256(),
    ]);
    const inferenceCacheKey = await computeVisualInferenceCacheKey({
      screenshotSha256: input.screenshot.sha256,
      pixelWidth: input.screenshot.pixelWidth,
      pixelHeight: input.screenshot.pixelHeight,
      provider: selected.modelSpec.provider,
      model: selected.modelSpec.model,
      configurationSha256: selected.modelSpec.configurationSha256,
      promptSha256,
      responseSchemaSha256,
    });

    let outcome: VisionClientOutcome;
    try {
      // This is the sole paid-call boundary. Both production adapters issue one
      // binding request and have no retry path.
      outcome = await selected.client.observe(
        {
          callId: input.callId,
          inferenceCacheKey,
          screenshot: {
            bytes: screenshotBytes,
            contentSha256: input.screenshot.sha256,
            mediaType: "image/png",
            pixelWidth: input.screenshot.pixelWidth,
            pixelHeight: input.screenshot.pixelHeight,
          },
          prompt: {
            version: VISUAL_PROMPT_VERSION,
            sha256: promptSha256,
            text: VISUAL_INVENTORY_PROMPT,
          },
          responseSchema: {
            version: VISUAL_RESPONSE_SCHEMA_VERSION,
            sha256: responseSchemaSha256,
            jsonSchema: VISUAL_RESPONSE_JSON_SCHEMA,
          },
        },
        request.signal,
      );
    } catch (error) {
      const attempted = stableProviderCallAttempted(error);
      const telemetry = attempted ? stableFailureTelemetry(error, input.callId, selected.modelSpec) : null;
      return response(502, failure(input, attempted, stableProviderFailureCode(error), telemetry));
    }

    try {
      const telemetry = validateTelemetry(outcome, input.callId, selected.modelSpec);
      const receipt = await receiptDigest(telemetry.providerRequestId, telemetry.gatewayLogId);
      return response(200, {
        schemaVersion: RESPONSE_SCHEMA_VERSION,
        fixtureId: input.fixtureId,
        modelSelector: input.modelSelector,
        callId: input.callId,
        attempted: true,
        status: "completed",
        provenance: {
          screenshot: {
            sha256: input.screenshot.sha256,
            pixelWidth: input.screenshot.pixelWidth,
            pixelHeight: input.screenshot.pixelHeight,
          },
          prompt: { version: VISUAL_PROMPT_VERSION, sha256: promptSha256 },
          responseSchema: {
            version: VISUAL_RESPONSE_SCHEMA_VERSION,
            sha256: responseSchemaSha256,
          },
          model: {
            provider: selected.modelSpec.provider,
            requestedModel: selected.modelSpec.model,
            reportedModel: telemetry.model,
            transport: selected.modelSpec.transport,
            configurationSha256: selected.modelSpec.configurationSha256,
          },
          call: receipt === null ? null : { callId: input.callId, receipt },
        },
        telemetry: {
          inputTokens: telemetry.inputTokens,
          outputTokens: telemetry.outputTokens,
          reportedModel: telemetry.model,
          attempts: telemetry.attempts,
          latencyMs: telemetry.latencyMs,
          usageSource: telemetry.usageSource,
        },
        modelContent: outcome.content,
      });
    } catch {
      // A paid response whose accounting/provenance cannot be validated remains
      // attempted, but cannot be turned into an admissible prediction record.
      return response(502, failure(input, true, "response-accounting-invalid"));
    }
  },
} satisfies ExportedHandler<Env>;

async function selectProvider(
  ai: Ai,
  selector: ModelSelector,
): Promise<{ client: VisionClient; modelSpec: VisionModelSpec }> {
  if (selector === "workers-ai-gemma-4") {
    return { client: new WorkersAiGemma4VisionClient(ai), modelSpec: await workersAiGemma4ModelSpec() };
  }
  return createCloudflareGatewayGeminiProvider(ai, GATEWAY_ID);
}

function validateTelemetry(
  outcome: VisionClientOutcome,
  callId: string,
  modelSpec: VisionModelSpec,
): VisionClientOutcome["telemetry"] {
  const telemetry = outcome.telemetry;
  if (
    !isObject(telemetry) ||
    telemetry.callId !== callId ||
    telemetry.provider !== modelSpec.provider ||
    typeof telemetry.model !== "string" ||
    telemetry.model.length === 0 ||
    telemetry.model.length > 200 ||
    telemetry.attempts !== 1 ||
    !nullableTokenCount(telemetry.inputTokens) ||
    !nullableTokenCount(telemetry.outputTokens) ||
    typeof telemetry.latencyMs !== "number" ||
    !Number.isFinite(telemetry.latencyMs) ||
    telemetry.latencyMs < 0 ||
    !["provider-reported", "gateway-reported", "configured-rate", "unavailable"].includes(
      telemetry.usageSource,
    )
  ) {
    throw new Error("invalid telemetry");
  }
  return telemetry;
}

async function receiptDigest(
  providerRequestId: string | null,
  gatewayLogId: string | null,
): Promise<{ kind: "provider-request-id" | "gateway-log-id"; sha256: string } | null> {
  if (typeof providerRequestId === "string" && providerRequestId.length > 0) {
    return { kind: "provider-request-id", sha256: await sha256Hex(providerRequestId) };
  }
  if (typeof gatewayLogId === "string" && gatewayLogId.length > 0) {
    return { kind: "gateway-log-id", sha256: await sha256Hex(gatewayLogId) };
  }
  return null;
}

function failure(
  input: EndpointInput | null,
  attempted: boolean,
  code: string,
  telemetry: ReturnType<typeof publicTelemetry> | null = null,
): Record<string, unknown> {
  return {
    schemaVersion: RESPONSE_SCHEMA_VERSION,
    fixtureId: input?.fixtureId ?? null,
    modelSelector: input?.modelSelector ?? null,
    callId: input?.callId ?? null,
    attempted,
    status: "error",
    // Adapter exceptions do not expose a complete trustworthy usage envelope. A
    // paid but unaccounted attempt is therefore explicit null, never invented zero.
    telemetry,
    error: { code },
  };
}

export function stableProviderCallAttempted(error: unknown): boolean {
  return coherentNotAttemptedPreflightReference(error) === null;
}

function stableFailureTelemetry(
  error: unknown,
  callId: string,
  modelSpec: VisionModelSpec,
): ReturnType<typeof publicTelemetry> | null {
  try {
    if (!(error instanceof VisionProviderUnavailableError) || error.telemetry === null) return null;
    return publicTelemetry(validateTelemetry({ content: null, telemetry: error.telemetry }, callId, modelSpec));
  } catch {
    return null;
  }
}

function publicTelemetry(telemetry: VisionClientOutcome["telemetry"]) {
  return {
    inputTokens: telemetry.inputTokens,
    outputTokens: telemetry.outputTokens,
    reportedModel: telemetry.model,
    attempts: telemetry.attempts,
    latencyMs: telemetry.latencyMs,
    usageSource: telemetry.usageSource,
  };
}

/**
 * Preserve only the adapters' bounded, closed failure reference. Provider exception text and
 * arbitrary upstream fields never cross this endpoint or enter an evaluation artifact.
 */
function stableProviderFailureCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "provider-unavailable";
  try {
    const reference = error as { providerFailureCategory?: unknown; providerFailureCode?: unknown };
    const category = safeFailureSegment(reference.providerFailureCategory);
    const code = safeFailureSegment(reference.providerFailureCode);
    if (category === null || code === null) return "provider-unavailable";
    const combined = `provider-unavailable-${category}-${code}`;
    return combined.length <= 100 ? combined : "provider-unavailable";
  } catch {
    return "provider-unavailable";
  }
}

function safeFailureSegment(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value) ? value : null;
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function isLoopbackRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("body unavailable");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new Error("body too large");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_REQUEST_BYTES) throw new Error("body too large");
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function parseInput(value: unknown): EndpointInput {
  if (!hasExactKeys(value, ["schemaVersion", "fixtureId", "modelSelector", "callId", "screenshot"])) {
    throw new Error("request shape");
  }
  const fixtureId = value.fixtureId;
  const modelSelector = value.modelSelector;
  const callId = value.callId;
  const screenshot = value.screenshot;
  if (
    value.schemaVersion !== REQUEST_SCHEMA_VERSION ||
    !isFixtureId(fixtureId) ||
    !isModelSelector(modelSelector) ||
    typeof callId !== "string" ||
    callId.length === 0 ||
    callId.length > MAX_CALL_ID_CHARS ||
    !hasExactKeys(screenshot, ["sha256", "pixelWidth", "pixelHeight", "base64"]) ||
    typeof screenshot.sha256 !== "string" ||
    !HASH.test(screenshot.sha256) ||
    !positiveInteger(screenshot.pixelWidth) ||
    !positiveInteger(screenshot.pixelHeight) ||
    typeof screenshot.base64 !== "string" ||
    screenshot.base64.length === 0 ||
    screenshot.base64.length > MAX_REQUEST_BYTES ||
    !BASE64.test(screenshot.base64)
  ) {
    throw new Error("request fields");
  }
  return {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    fixtureId,
    modelSelector,
    callId,
    screenshot: {
      sha256: screenshot.sha256,
      pixelWidth: screenshot.pixelWidth,
      pixelHeight: screenshot.pixelHeight,
      base64: screenshot.base64,
    },
  };
}

async function assertTrustedScreenshot(input: EndpointInput, bytes: Uint8Array): Promise<void> {
  const trusted = PUBLIC_FIXTURES[input.fixtureId];
  const dimensions = pngDimensions(bytes);
  if (
    input.screenshot.sha256 !== trusted.sha256 ||
    input.screenshot.pixelWidth !== trusted.pixelWidth ||
    input.screenshot.pixelHeight !== trusted.pixelHeight ||
    dimensions.width !== trusted.pixelWidth ||
    dimensions.height !== trusted.pixelHeight ||
    (await sha256Hex(bytes)) !== trusted.sha256
  ) {
    throw new Error("screenshot mismatch");
  }
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (
    bytes.length < 24 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) ||
    String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR"
  ) {
    throw new Error("not png");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0) throw new Error("zero dimensions");
  return { width, height };
}

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const actual = Object.keys(value);
  const expected = new Set(keys);
  return actual.length === keys.length && actual.every((key) => expected.has(key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isFixtureId(value: unknown): value is keyof typeof PUBLIC_FIXTURES {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PUBLIC_FIXTURES, value);
}

function isModelSelector(value: unknown): value is ModelSelector {
  return typeof value === "string" && MODEL_SELECTORS.some((selector) => selector === value);
}

function nullableTokenCount(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

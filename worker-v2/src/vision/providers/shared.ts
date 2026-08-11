import { canonicalHash, sha256Hex } from "../../store/hash";
import {
  VISUAL_INVENTORY_PROMPT,
  VISUAL_PROMPT_VERSION,
  VISUAL_RESPONSE_JSON_SCHEMA,
  VISUAL_RESPONSE_SCHEMA_VERSION,
} from "../schema";
import { VisionProviderUnavailableError, type JsonValue, type VisionClientRequest } from "../types";
// @ts-ignore -- plain ESM shared verbatim with the local deployment attestor
import { VISION_PROVIDER_CONFIGURATION_SCHEMA_VERSION as SHARED_PROVIDER_CONFIGURATION_SCHEMA_VERSION } from "../../../shared/visual-provider-config.mjs";

const HASH = /^[0-9a-f]{64}$/;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const MAX_CALL_ID_CHARS = 500;
const MAX_CACHE_KEY_CHARS = 500;

export const VISION_PROVIDER_CONFIGURATION_SCHEMA_VERSION:
  "survey-qa-vision-provider-configuration/1.0.0" =
    SHARED_PROVIDER_CONFIGURATION_SCHEMA_VERSION;

export interface VisionProviderConfigurationEnvelope {
  schemaVersion: typeof VISION_PROVIDER_CONFIGURATION_SCHEMA_VERSION;
  provider: string;
  model: string;
  transport: string;
  request: JsonValue;
}

/**
 * The provider fingerprint is part of the paid-inference cache identity. Any setting that can
 * alter a reading belongs in the caller's request descriptor; secrets and binding identities do
 * not. The hardened repository canonicalizer makes property order irrelevant.
 */
export function hashVisionProviderConfiguration(
  value: VisionProviderConfigurationEnvelope,
): Promise<string> {
  return canonicalHash(value);
}

/**
 * Refuse direct calls that try to substitute another prompt, schema, image, or cache identity.
 * Provider adapters then construct a fresh wire payload from the five admitted request fields;
 * they never spread runtime objects into a paid request.
 */
export async function assertExactProductionVisionRequest(
  request: VisionClientRequest,
): Promise<void> {
  const fail = (): never => {
    throw new VisionProviderUnavailableError("visual provider request contract mismatch");
  };

  if (!isPlainRecord(request)) fail();
  if (!boundedString(request.callId, MAX_CALL_ID_CHARS)) fail();
  if (!boundedString(request.inferenceCacheKey, MAX_CACHE_KEY_CHARS)) fail();
  if (!isPlainRecord(request.screenshot)) fail();
  if (request.screenshot.mediaType !== "image/png") fail();
  if (!(request.screenshot.bytes instanceof Uint8Array) || request.screenshot.bytes.byteLength === 0) fail();
  if (!isPng(request.screenshot.bytes)) fail();
  if (!HASH.test(request.screenshot.contentSha256)) fail();
  if (!positiveInteger(request.screenshot.pixelWidth) || !positiveInteger(request.screenshot.pixelHeight)) fail();

  if (!isPlainRecord(request.prompt)) fail();
  if (
    request.prompt.version !== VISUAL_PROMPT_VERSION ||
    request.prompt.text !== VISUAL_INVENTORY_PROMPT ||
    !HASH.test(request.prompt.sha256)
  ) fail();

  if (!isPlainRecord(request.responseSchema)) fail();
  if (
    request.responseSchema.version !== VISUAL_RESPONSE_SCHEMA_VERSION ||
    !HASH.test(request.responseSchema.sha256)
  ) fail();

  const [screenshotSha256, promptSha256, responseSchemaSha256, suppliedSchemaSha256] =
    await Promise.all([
      sha256Hex(request.screenshot.bytes),
      sha256Hex(VISUAL_INVENTORY_PROMPT),
      canonicalHash(VISUAL_RESPONSE_JSON_SCHEMA),
      canonicalHash(request.responseSchema.jsonSchema),
    ]);
  if (
    screenshotSha256 !== request.screenshot.contentSha256 ||
    promptSha256 !== request.prompt.sha256 ||
    responseSchemaSha256 !== request.responseSchema.sha256 ||
    suppliedSchemaSha256 !== responseSchemaSha256
  ) fail();
}

export function jsonSchemaObject(value: JsonValue): Record<string, JsonValue> {
  if (!isPlainRecord(value)) {
    throw new VisionProviderUnavailableError("visual response schema is not an object");
  }
  return value;
}

/** Base64 without Node.js Buffer, so the same code executes in workerd and focused Node tests. */
export function encodeBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const chunks: string[] = [];
  let chunk = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const hasB = index + 1 < bytes.length;
    const hasC = index + 2 < bytes.length;
    const b = hasB ? bytes[index + 1]! : 0;
    const c = hasC ? bytes[index + 2]! : 0;
    chunk +=
      alphabet[a >>> 2]! +
      alphabet[((a & 0x03) << 4) | (b >>> 4)]! +
      (hasB ? alphabet[((b & 0x0f) << 2) | (c >>> 6)]! : "=") +
      (hasC ? alphabet[c & 0x3f]! : "=");
    if (chunk.length >= 32_768) {
      chunks.push(chunk);
      chunk = "";
    }
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks.join("");
}

export function parseModelJsonOrReturnText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // The observer owns the closed-schema decision and will report a named malformed response.
    return text;
  }
}

export function boundedProviderString(value: unknown, maxChars = 500): string | null {
  return boundedString(value, maxChars) ? value : null;
}

export function providerTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function elapsedMilliseconds(startedAt: number): number {
  const value = performance.now() - startedAt;
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

export function sanitizedProviderFailure(message: string): VisionProviderUnavailableError {
  return new VisionProviderUnavailableError(message);
}

export async function resolveSecret(
  source: { get(): Promise<string> } | (() => Promise<string>),
  signal: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  let value: string;
  try {
    const pending = typeof source === "function" ? source() : source.get();
    value = await raceWithAbort(pending, signal);
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    throw sanitizedProviderFailure("visual provider credential is unavailable");
  }
  throwIfAborted(signal);
  const secret = value.trim();
  if (secret.length < 8 || secret.length > 4096 || /\s/.test(secret)) {
    throw sanitizedProviderFailure("visual provider credential is unavailable");
  }
  return secret;
}

/**
 * Read a fetch body without `response.text()`/`response.json()`. The reader is cancelled as soon
 * as a declared or observed size crosses the cap. Callers never persist or log this raw text.
 */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (!positiveInteger(maxBytes)) {
    throw sanitizedProviderFailure("visual provider response limit is invalid");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw sanitizedProviderFailure("visual provider response exceeded its byte limit");
    }
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const read = await reader.read();
      if (read.done) break;
      total += read.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw sanitizedProviderFailure("visual provider response exceeded its byte limit");
      }
      chunks.push(read.value);
    }
  } catch (error) {
    if (isAbortError(error, signal)) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    if (error instanceof VisionProviderUnavailableError) throw error;
    throw sanitizedProviderFailure("visual provider response could not be read");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw sanitizedProviderFailure("visual provider response was not valid UTF-8");
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }
}

function raceWithAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted", "AbortError"),
      );
    };
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function boundedString(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars;
}

function isPlainRecord(value: unknown): value is Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

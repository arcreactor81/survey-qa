import { attestGrokRate, GrokRateAttestationError } from "./grok-rate-attestation-core";
type Env = { XAI_API_KEY?: Readonly<{ get(): Promise<string> }>; RATE_ATTESTATION_OPERATOR_TOKEN_SHA256?: string };
export const RATE_ATTESTATION_OPERATOR_METHOD = "GET";
export const RATE_ATTESTATION_OPERATOR_PATH = "/__operator/grok-rate-attestation";
const TOKEN_HEADER = "x-survey-qa-rate-attestation-token";

/**
 * Authenticated GET is the one operator protocol. A standards-based GET cannot carry a body,
 * and raw/proxied requests are also refused if they expose either a stream or framing metadata.
 */
export async function handleRateAttestationRequest(request: Request, env: Env, fetchImpl: typeof fetch = fetch, observedAt = new Date().toISOString()): Promise<Response> {
  const target = new URL(request.url);
  if (request.method !== RATE_ATTESTATION_OPERATOR_METHOD || target.pathname !== RATE_ATTESTATION_OPERATOR_PATH || target.search !== "" || !(await authorized(request, env))) return new Response("not found", { status: 404 });
  if (!bodyless(request)) return json({ error: "REQUEST_BODY_FORBIDDEN" }, 400);
  try { return json(await attestGrokRate(env, fetchImpl, observedAt)); }
  catch (error) { return json({ error: error instanceof GrokRateAttestationError ? error.code : "RATE_CATALOGUE_UNAVAILABLE" }, 502); }
}

export default { async fetch(request: Request, env: Env): Promise<Response> { return handleRateAttestationRequest(request, env); } };
function bodyless(request: Request): boolean { return request.body === null && request.headers.get("content-length") === null && request.headers.get("transfer-encoding") === null; }
async function authorized(request: Request, env: Env): Promise<boolean> { const token = request.headers.get(TOKEN_HEADER), expected = env.RATE_ATTESTATION_OPERATOR_TOKEN_SHA256; if (token === null || token.length < 32 || token.length > 256 || expected === undefined || !/^[0-9a-f]{64}$/.test(expected)) return false; const actualBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))); return crypto.subtle.timingSafeEqual(actualBytes, hex(expected)); }
function hex(value: string): Uint8Array { const out = new Uint8Array(32); for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16); return out; }
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }

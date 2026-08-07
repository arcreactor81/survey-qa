/**
 * ONE OpenAI-COMPATIBLE JSON CALL, shared by both extraction legs.
 *
 * The v1 legs (`src/llm/grok.ts`, `src/llm/deepseek.ts`, read-only reference) are two
 * near-identical files that differ in a base URL, a model name and a reasoning knob, and
 * each carries its own copy of the parse-and-sanitize logic. Two copies of "did the model
 * answer" is two places for a truncated response to be read as an empty one, so v2 keeps
 * ONE transport and puts the per-provider differences in a small descriptor.
 *
 * WHAT THIS MODULE REFUSES TO DO:
 *   - it never returns `{}` for a call that failed. A failure is a thrown `ModelCallError`
 *     carrying the attempt telemetry, because "the model found nothing" and "the call did
 *     not happen" must not share a value;
 *   - it never swallows `finish_reason: "length"`. A truncated answer is incomplete JSON,
 *     and silently parsing the prefix is how a chunk loses its last twelve requirements;
 *   - it never retries more than the configured cap (default 2 attempts). Money.
 */

import { num, resolveSecret, type Env } from "../types/env";
import type { CallUsage } from "../extract/types";

export interface ProviderSpec {
  /** `grok` | `deepseek` — also the AI Gateway provider path segment. */
  provider: "grok" | "deepseek";
  model: string;
  /** Gateway path suffix after the provider segment (grok needs `/v1`). */
  gatewaySuffix: string;
  directBaseUrl: string;
  apiKey: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** Provider-specific body fields (thinking / reasoning_effort). */
  extraBody: Record<string, unknown>;
}

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly usage: CallUsage,
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

export interface ChatOptions {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Role recorded on the telemetry row, e.g. `extract-pass-a`. */
  role: string;
  callId: string;
  /**
   * The AI Gateway `feature` tag. Defaults to the extraction tag so every existing caller
   * keeps the exact metadata it had; the model verifier passes its own, because a cost
   * question ("what did verification cost on this document") is unanswerable from the
   * gateway when two features share one tag.
   */
  feature?: string;
}

export interface ChatOutcome {
  /** Parsed JSON object the model returned. */
  value: Record<string, unknown>;
  usage: CallUsage;
  /**
   * `cf-aig-log-id` from the gateway response, when the call was routed through one.
   *
   * THIS IS THE LINKAGE, NOT DECORATION. A model-attested observation names the gateway log
   * row that holds the request and response bytes, so "which call said this" is answerable
   * against the gateway's own record rather than against our summary of it. `null` when the
   * call went direct — which is itself the honest statement that no gateway logged it.
   */
  logId?: string | null;
}

/**
 * Run one JSON-mode chat completion and parse it. Throws `ModelCallError` (with usage
 * attached, so a failed call still costs what it cost on the ledger) after the attempt cap.
 */
export async function chatJson(spec: ProviderSpec, env: Env, opts: ChatOptions): Promise<ChatOutcome> {
  const usingGateway = Boolean(env.CF_AIG_ACCOUNT_ID && env.CF_AIG_GATEWAY_ID);
  const baseUrl = usingGateway
    ? `https://gateway.ai.cloudflare.com/v1/${env.CF_AIG_ACCOUNT_ID}/${env.CF_AIG_GATEWAY_ID}/${spec.provider}${spec.gatewaySuffix}`
    : spec.directBaseUrl;

  const headers: Record<string, string> = {
    authorization: `Bearer ${spec.apiKey}`,
    "content-type": "application/json",
  };
  if (usingGateway) {
    headers["cf-aig-metadata"] = JSON.stringify({
      feature: opts.feature ?? "survey-qa-v2-extract",
      role: opts.role,
    });
    if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;
  }

  const body = {
    model: spec.model,
    response_format: { type: "json_object" },
    max_tokens: opts.maxTokens,
    ...spec.extraBody,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  };

  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  let inputTokens = 0;
  let outputTokens = 0;
  let lastDetail = "no attempt was made";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        // MEASURED: a 25-block chunk on DeepSeek has been observed at 190 s, and the cap
        // that used to sit at 240 s aborted a chunk twice and cost the run its seal. The
        // ceiling is configuration now, because "how long may one call take" is a property
        // of the document and the provider, not of this code.
        signal: AbortSignal.timeout(opts.timeoutMs ?? num(env.LLM_TIMEOUT_MS, 300_000)),
      });
      const rawBody = await res.text();
      const latencyMs = Date.now() - startedAt;

      if (!res.ok) {
        lastDetail = `HTTP ${res.status}: ${rawBody.slice(0, 300)}`;
        if (attempt === maxAttempts) break;
        continue;
      }

      let data: ChatResponse;
      try {
        data = JSON.parse(rawBody) as ChatResponse;
      } catch {
        lastDetail = `non-JSON transport body: ${rawBody.slice(0, 200)}`;
        if (attempt === maxAttempts) break;
        continue;
      }

      // Usage accrues even when the CONTENT is unusable: a truncated call was still paid
      // for, and a cost ledger that only counts successes understates every run.
      inputTokens += data.usage?.prompt_tokens ?? 0;
      outputTokens += data.usage?.completion_tokens ?? 0;

      const content = data.choices?.[0]?.message?.content ?? "";
      const finish = data.choices?.[0]?.finish_reason ?? null;
      if (finish === "length") {
        lastDetail = `truncated at max_tokens (${opts.maxTokens}); the JSON is incomplete`;
        if (attempt === maxAttempts) break;
        continue;
      }
      if (content.trim().length === 0) {
        lastDetail = "empty content";
        if (attempt === maxAttempts) break;
        continue;
      }

      const parsed = parseJsonObject(content);
      if (parsed === null) {
        lastDetail = `unparseable JSON: ${content.slice(0, 200)}`;
        if (attempt === maxAttempts) break;
        continue;
      }

      return {
        value: parsed,
        usage: {
          callId: opts.callId,
          role: opts.role,
          provider: spec.provider,
          model: data.model ?? spec.model,
          status: "ok",
          inputTokens,
          outputTokens,
          costUsd: costOf(spec, inputTokens, outputTokens),
          latencyMs,
          attempts: attempt,
        },
      };
    } catch (err) {
      lastDetail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (attempt === maxAttempts) break;
    }
  }

  throw new ModelCallError(`${spec.provider}/${spec.model} ${opts.role} failed: ${lastDetail}`, {
    callId: opts.callId,
    role: opts.role,
    provider: spec.provider,
    model: spec.model,
    status: "error",
    inputTokens,
    outputTokens,
    costUsd: costOf(spec, inputTokens, outputTokens),
    latencyMs: 0,
    attempts: maxAttempts,
    detail: lastDetail.slice(0, 400),
  });
}

export const costOf = (spec: ProviderSpec, inTok: number, outTok: number): number =>
  Math.round(((inTok / 1e6) * spec.inputUsdPerMTok + (outTok / 1e6) * spec.outputUsdPerMTok) * 1e6) / 1e6;

/** Lenient parse: strip fences, then fall back to the outermost {...} span. */
export function parseJsonObject(content: string): Record<string, unknown> | null {
  let text = content.trim();
  const fenced = text.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```\s*$/);
  if (fenced) text = fenced[1]!.trim();
  const attempt = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s) as unknown;
      return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = attempt(text);
  if (direct) return direct;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return attempt(text.slice(start, end + 1));
}

/**
 * A CONFIGURATION failure, not a run failure. It is its own class because the two need
 * different handling: a provider error is worth retrying, an absent credential is worth
 * REPORTING — the stage returns `not-evaluated` and the run ends with a report that names
 * the missing binding, instead of retrying twice and dying with a stack trace.
 */
export class MissingCredential extends Error {
  constructor(readonly binding: string, message: string) {
    super(message);
    this.name = "MissingCredential";
  }
}

export async function keyFor(env: Env, which: "grok" | "deepseek"): Promise<string> {
  const binding = which === "grok" ? "XAI_API_KEY" : "DEEPSEEK_API_KEY";
  const key = await resolveSecret(which === "grok" ? env.XAI_API_KEY : env.DEEPSEEK_API_KEY);
  if (!key) {
    throw new MissingCredential(
      binding,
      `${binding} is not available to this Worker. ` +
        `Extraction requires TWO independent passes (owner ruling); running one leg and calling the result ` +
        `an agreement of two is exactly the failure mode the diff exists to expose.`,
    );
  }
  return key;
}

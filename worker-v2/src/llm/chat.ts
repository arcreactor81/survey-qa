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
  /**
   * Highest prevalidated rate among models this provider plan may buy. Used only
   * when a paid response does not bind its usage to the requested model identity.
   */
  unboundModelRateCeiling?: { inputUsdPerMTok: number; outputUsdPerMTok: number };
  /** Provider-specific body fields (thinking / reasoning_effort). */
  extraBody: Record<string, unknown>;
}

export type ModelFailureKind =
  | "timeout-or-network"
  | "rate-limited"
  | "provider-unavailable"
  | "invalid-content"
  | "authentication"
  | "insufficient-balance"
  | "invalid-request"
  | "nonretryable-http";

/**
 * The transport cause of the failed purchase. A local deadline is deliberately narrower
 * than timeout-or-network so callers cannot turn a provider outage into a fan-out storm.
 */
export type ModelFailureCause =
  | "local-deadline"
  | "network"
  | "http-status"
  | "provider-content"
  | "mixed";

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly usage: CallUsage,
    /** Final attempt's failure class. Existing callers may continue reading only usage. */
    readonly failureKind: ModelFailureKind = "timeout-or-network",
    readonly httpStatus: number | null = null,
    readonly failureCause: ModelFailureCause =
      httpStatus === null && failureKind === "timeout-or-network"
        ? "network"
        : failureKind === "invalid-content"
          ? "provider-content"
          : "http-status",
    /**
     * True when `finish_reason: "length"` was the cause — the provider returned an incomplete
     * JSON answer because the response hit the model's output-token ceiling. This is the
     * discriminator that separates "window too large for the model to answer" from "model
     * returned garbage": the former is fixable by splitting, the latter is not.
     */
    readonly truncatedAtOutputCeiling: boolean = false,
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
   * Exact canonical request bytes already admitted by a caller's wire-size barrier.
   * When present, transport sends this string unchanged instead of serializing again.
   * Callers must derive it with `chatRequestBodyText` for this exact provider spec.
   */
  preSerializedBodyText?: string;
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
 * Canonical OpenAI-compatible request bytes. Size gates use this same serializer as fetch,
 * so prompt wrappers, JSON escaping, model fields and provider-specific reasoning fields
 * cannot sit outside the reviewed wire ceiling.
 */
export function chatRequestBodyText(
  spec: Pick<ProviderSpec, "model" | "extraBody">,
  opts: Pick<ChatOptions, "system" | "user" | "maxTokens">,
): string {
  return JSON.stringify({
    model: spec.model,
    response_format: { type: "json_object" },
    max_tokens: opts.maxTokens,
    ...spec.extraBody,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  });
}

/**
 * Run one JSON-mode chat completion and parse it. Throws `ModelCallError` (with usage
 * attached, so a failed call still costs what it cost on the ledger) after the attempt cap.
 */
export async function chatJson(spec: ProviderSpec, env: Env, opts: ChatOptions): Promise<ChatOutcome> {
  // FAIL CLOSED ON MISSING GATEWAY CONFIG. This used to fall back to `spec.directBaseUrl`
  // (`https://api.deepseek.com`, `https://api.x.ai/v1`), so a missing or mistyped
  // CF_AIG_* var silently routed every paid call AROUND the gateway — no spend limit, no
  // per-request log, no cost ledger, and nothing anywhere said so. A spend ceiling that a
  // typo can bypass is not a ceiling. Refusing is correct: extraction is the dominant cost
  // line, and a run that cannot be metered should not start.
  //
  // `ALLOW_DIRECT_LLM_BASE_URL` is the deliberate escape hatch (local dev against a stub,
  // or a gateway outage) and must be set explicitly — never a default, never a fallback.
  const usingGateway = Boolean(env.CF_AIG_ACCOUNT_ID && env.CF_AIG_GATEWAY_ID);
  if (!usingGateway && env.ALLOW_DIRECT_LLM_BASE_URL !== "true") {
    throw new Error(
      `refusing to call ${spec.provider} directly: CF_AIG_ACCOUNT_ID and CF_AIG_GATEWAY_ID must ` +
        `both be set so spend is metered and capped by the AI Gateway. Set ` +
        `ALLOW_DIRECT_LLM_BASE_URL="true" only to bypass this deliberately.`,
    );
  }
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

  const bodyText = opts.preSerializedBodyText ?? chatRequestBodyText(spec, opts);
  // A byte cannot encode fewer than zero tokens, and treating every request byte as one
  // token is a conservative ceiling for the provider tokenizers used here. max_tokens is
  // already the provider-enforced completion ceiling.
  const unknownInputTokenCeiling = new TextEncoder().encode(bodyText).byteLength;
  const unknownOutputTokenCeiling = Math.max(0, Math.ceil(opts.maxTokens));

  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  let inputTokens = 0;
  let outputTokens = 0;
  let lastDetail = "no attempt was made";
  let lastFailureKind: ModelFailureKind = "timeout-or-network";
  let lastFailureCause: ModelFailureCause = "network";
  let allFailuresWereLocalDeadlines = true;
  let sawLocalDeadline = false;
  let lastHttpStatus: number | null = null;
  let usedConservativeCeiling = false;
  let usedUnboundModelRateCeiling = false;
  let unverifiedReportedModel: string | null = null;
  let attemptsMade = 0;
  let lastTruncatedAtOutputCeiling = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsMade = attempt;
    const startedAt = Date.now();
    let usageAccounted = false;
    let attemptSignal: AbortSignal | null = null;
    const accountUsage = (usage: ChatResponse["usage"] | undefined): void => {
      if (usageAccounted) return;
      usageAccounted = true;
      const input = usage?.prompt_tokens;
      const output = usage?.completion_tokens;
      if (
        typeof input === "number" &&
        Number.isSafeInteger(input) &&
        input >= 0 &&
        typeof output === "number" &&
        Number.isSafeInteger(output) &&
        output >= 0
      ) {
        inputTokens += input;
        outputTokens += output;
        return;
      }
      // A timeout/error may still be billed even when no response usage exists. Zero
      // would create fictional budget headroom, so retain and charge the request/output
      // ceilings instead. The receipt names this source explicitly.
      inputTokens += unknownInputTokenCeiling;
      outputTokens += unknownOutputTokenCeiling;
      usedConservativeCeiling = true;
    };
    try {
      attemptSignal = AbortSignal.timeout(opts.timeoutMs ?? num(env.LLM_TIMEOUT_MS, 300_000));
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: bodyText,
        // MEASURED: a 25-block chunk on DeepSeek has been observed at 190 s, and the cap
        // that used to sit at 240 s aborted a chunk twice and cost the run its seal. The
        // ceiling is configuration now, because "how long may one call take" is a property
        // of the document and the provider, not of this code.
        signal: attemptSignal,
      });
      const rawBody = await res.text();
      const latencyMs = Date.now() - startedAt;
      let data: ChatResponse | null = null;
      try {
        data = JSON.parse(rawBody) as ChatResponse;
      } catch {
        // Account below from a conservative ceiling; content handling still names the
        // non-JSON response separately.
      }
      if (!res.ok) {
        accountUsage(data?.usage);
        lastDetail = `HTTP ${res.status}: ${rawBody.slice(0, 300)}`;
        lastHttpStatus = res.status;
        lastFailureKind = failureKindForHttpStatus(res.status);
        lastFailureCause = "http-status";
        lastTruncatedAtOutputCeiling = false;
        allFailuresWereLocalDeadlines = false;
        // Auth, balance and invalid requests are properties shared by every retry.
        // Re-sending them cannot succeed and only multiplies a doomed purchase.
        if (attempt === maxAttempts || !retryableFailure(lastFailureKind)) break;
        continue;
      }
      lastHttpStatus = null;

      if (data === null) {
        accountUsage(undefined);
        lastDetail = `non-JSON transport body: ${rawBody.slice(0, 200)}`;
        lastFailureKind = "invalid-content";
        lastFailureCause = "provider-content";
        lastTruncatedAtOutputCeiling = false;
        allFailuresWereLocalDeadlines = false;
        if (attempt === maxAttempts) break;
        continue;
      }

      // Model identity and price identity are one contract. A missing model is not
      // permission to infer the requested SKU, and another model cannot be charged at
      // this requested model's rate. No alias convention is assumed: success requires
      // the exact, nonempty requested model or this attempt is unusable.
      const reportedModel = typeof data.model === "string" && data.model.length > 0 ? data.model : null;
      if (reportedModel !== spec.model) {
        // Even a token count in this response is not price-bound to the requested SKU.
        // Retain the paid attempt using request/output ceilings rather than laundering
        // the unbound fields into a provider-reported receipt.
        accountUsage(undefined);
        usedUnboundModelRateCeiling = true;
        unverifiedReportedModel = reportedModel;
        lastDetail =
          `response model identity mismatch: requested ${JSON.stringify(spec.model)}, ` +
          `reported ${JSON.stringify(reportedModel)}`;
        lastFailureKind = "invalid-content";
        lastFailureCause = "provider-content";
        lastTruncatedAtOutputCeiling = false;
        allFailuresWereLocalDeadlines = false;
        if (attempt === maxAttempts) break;
        continue;
      }
      accountUsage(data.usage);

      const content = data.choices?.[0]?.message?.content ?? "";
      const finish = data.choices?.[0]?.finish_reason ?? null;
      if (finish === "length") {
        lastDetail = `truncated at max_tokens (${opts.maxTokens}); the JSON is incomplete`;
        lastFailureKind = "invalid-content";
        lastFailureCause = "provider-content";
        lastTruncatedAtOutputCeiling = true;
        allFailuresWereLocalDeadlines = false;
        if (attempt === maxAttempts) break;
        continue;
      }
      if (content.trim().length === 0) {
        lastDetail = "empty content";
        lastFailureKind = "invalid-content";
        lastFailureCause = "provider-content";
        lastTruncatedAtOutputCeiling = false;
        allFailuresWereLocalDeadlines = false;
        if (attempt === maxAttempts) break;
        continue;
      }

      const parsed = parseJsonObject(content);
      if (parsed === null) {
        lastDetail = `unparseable JSON: ${content.slice(0, 200)}`;
        lastFailureKind = "invalid-content";
        lastFailureCause = "provider-content";
        lastTruncatedAtOutputCeiling = false;
        allFailuresWereLocalDeadlines = false;
        if (attempt === maxAttempts) break;
        continue;
      }

      return {
        value: parsed,
        usage: {
          callId: opts.callId,
          role: opts.role,
          provider: spec.provider,
          model: usedUnboundModelRateCeiling
            ? unverifiedModelLabel(spec.model, unverifiedReportedModel)
            : spec.model,
          status: "ok",
          inputTokens,
          outputTokens,
          costUsd: costOf(spec, inputTokens, outputTokens, usedUnboundModelRateCeiling),
          latencyMs,
          attempts: attempt,
          usageSource: usedUnboundModelRateCeiling
            ? "unverified-model-rate-ceiling"
            : usedConservativeCeiling
              ? "conservative-ceiling"
              : "provider-reported",
          detail: usedConservativeCeiling
            ? usedUnboundModelRateCeiling
              ? "model identity unverified; usage and rates conservatively ceilinged"
              : "usage conservatively ceilinged because one or more attempts returned no valid token receipt"
            : undefined,
        },
      };
    } catch (err) {
      accountUsage(undefined);
      lastDetail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      lastFailureKind = "timeout-or-network";
      lastTruncatedAtOutputCeiling = false;
      lastFailureCause = isLocalDeadlineExpiry(err, attemptSignal) ? "local-deadline" : "network";
      if (lastFailureCause === "local-deadline") sawLocalDeadline = true;
      if (lastFailureCause !== "local-deadline") allFailuresWereLocalDeadlines = false;
      lastHttpStatus = null;
      if (attempt === maxAttempts) break;
    }
  }

  throw new ModelCallError(`${spec.provider}/${spec.model} ${opts.role} failed: ${lastDetail}`, {
    callId: opts.callId,
    role: opts.role,
    provider: spec.provider,
    model: usedUnboundModelRateCeiling
      ? unverifiedModelLabel(spec.model, unverifiedReportedModel)
      : spec.model,
    status: "error",
    inputTokens,
    outputTokens,
    costUsd: costOf(spec, inputTokens, outputTokens, usedUnboundModelRateCeiling),
    latencyMs: 0,
    attempts: attemptsMade,
    usageSource: usedUnboundModelRateCeiling
      ? "unverified-model-rate-ceiling"
      : usedConservativeCeiling
        ? "conservative-ceiling"
        : "provider-reported",
    detail: (
      usedConservativeCeiling
        ? `usage conservatively ceilinged because at least one attempt returned no valid token receipt; ${lastDetail}`
        : lastDetail
    ).slice(0, 400),
  }, lastFailureKind, lastHttpStatus,
  allFailuresWereLocalDeadlines
    ? "local-deadline"
    : sawLocalDeadline
      ? "mixed"
      : lastFailureCause,
  lastTruncatedAtOutputCeiling);
}

function failureKindForHttpStatus(status: number): ModelFailureKind {
  if (status === 408) return "timeout-or-network";
  if (status === 429) return "rate-limited";
  if (status >= 500 && status <= 599) return "provider-unavailable";
  if (status === 401 || status === 403) return "authentication";
  if (status === 402) return "insufficient-balance";
  if (status === 400 || status === 404 || status === 409 || status === 422) return "invalid-request";
  return "nonretryable-http";
}

/** A timer being expired is insufficient: the caught rejection must be that timer's reason. */
export function isLocalDeadlineExpiry(err: unknown, signal: AbortSignal | null): boolean {
  if (signal === null || !signal.aborted || err !== signal.reason) return false;
  const reason = signal.reason;
  return (
    typeof reason === "object" &&
    reason !== null &&
    "name" in reason &&
    (reason as { name?: unknown }).name === "TimeoutError"
  );
}

function retryableFailure(kind: ModelFailureKind): boolean {
  return (
    kind === "timeout-or-network" ||
    kind === "rate-limited" ||
    kind === "provider-unavailable" ||
    kind === "invalid-content"
  );
}

/**
 * Preserve the calculated charge here. The durable usage authority applies its conservative
 * micro-dollar ceiling; rounding at the transport boundary would erase sub-micro tails before
 * the cap could account for them.
 */
export const costOf = (
  spec: ProviderSpec,
  inTok: number,
  outTok: number,
  useUnboundModelRateCeiling = false,
): number => {
  const rates = useUnboundModelRateCeiling
    ? spec.unboundModelRateCeiling ?? {
        inputUsdPerMTok: spec.inputUsdPerMTok,
        outputUsdPerMTok: spec.outputUsdPerMTok,
      }
    : spec;
  return (inTok / 1e6) * rates.inputUsdPerMTok + (outTok / 1e6) * rates.outputUsdPerMTok;
};

function unverifiedModelLabel(requested: string, reported: string | null): string {
  // JSON quoting escapes provider-controlled control characters before the label enters
  // the strict usage ledger. Truncation affects only display; full identities remain in
  // the error detail and no extraction result from this attempt is accepted.
  const requestedLabel = JSON.stringify(requested).slice(0, 120);
  const reportedLabel = (reported === null ? "<missing>" : JSON.stringify(reported)).slice(0, 120);
  return `unverified-model:requested=${requestedLabel};reported=${reportedLabel}`.slice(0, 300);
}

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

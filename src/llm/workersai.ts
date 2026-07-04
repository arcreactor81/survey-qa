// Workers AI comparison leg — the zero-key third pillar. Runs on the native
// AI binding (bundled Workers AI allocation), default model gpt-oss-120b —
// chosen by the empirical model bakeoff (consistent 9/10 recall with zero
// errors, replacing the flaky glm-4.7-flash). No documented JSON mode, so JSON
// is prompt-enforced and parsed leniently, with quote verification downstream.

import { buildComparePrompt } from "../prompt";
import type { CompareResult, Env, Finding, PageCapture } from "../types";

const VALID_CATEGORIES = new Set<Finding["category"]>([
  "typo", "missing-option", "wrong-option-label", "broken-piping",
  "scale-mislabel", "reordered-options", "wrong-numbering",
  "encoding-artifact", "duplicated-word", "missing-instruction",
  "missing-question", "other",
]);
const VALID_SEVERITIES = new Set<Finding["severity"]>(["high", "medium", "low"]);

/**
 * Per-call cap. Unlike fetch, env.AI.run takes no AbortSignal, so a hung
 * Workers AI call would otherwise stall the whole workersai-compare step until
 * its workflow timeout (then retry, doubling the hang). Racing a timer makes a
 * single hung page-call reject fast; the per-page try/catch in
 * runWorkersaiCompares records it in stats.errors and the leg moves on.
 * Mirrors the 60s REQUEST_TIMEOUT_MS on the DeepSeek/Claude legs.
 *
 * KNOWN RESIDUAL (not mitigable here): the timer only unblocks the AWAIT — it
 * cannot cancel the underlying ai.run, because the Workers AI binding exposes
 * no abort/cancellation handle. After a timeout the real call keeps running to
 * completion in the background and is still billed (a "zombie" call); we merely
 * stop waiting on it. `runWithTimeout` attaches a no-op .catch so its eventual
 * (post-race) settlement does not raise an unhandled rejection. There is no
 * cheap fix until the binding gains an AbortSignal parameter; the only guard is
 * choosing a cheap default model to bound the wasted spend.
 */
const AI_RUN_TIMEOUT_MS = 60_000;

interface AiRunner {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

async function runWithTimeout(
  ai: AiRunner,
  model: string,
  inputs: Record<string, unknown>,
  options?: Record<string, unknown>,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = options ? ai.run(model, inputs, options) : ai.run(model, inputs);
  // If the call loses the race and rejects later, don't surface an unhandled
  // rejection — the race result is what callers observe.
  call.catch(() => {});
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Workers AI call timed out after ${AI_RUN_TIMEOUT_MS / 1000}s`)),
          AI_RUN_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer); // no leaked timers on success
  }
}

function parseLenient(text: string): unknown {
  let t = text.trim();
  const fenced = t.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenced) t = fenced[1].trim();
  const attempt = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return JSON.parse(s.replace(/[\x00-\x1F]+/g, " "));
    }
  };
  try {
    return attempt(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start !== -1 && end > start) return attempt(t.slice(start, end + 1));
    throw new Error(`Workers AI output was not parseable JSON: ${t.slice(0, 160)}`);
  }
}

function sanitize(raw: unknown): CompareResult["findings"] {
  const obj = raw as { findings?: unknown };
  if (!obj || !Array.isArray(obj.findings)) return [];
  const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
  const out: CompareResult["findings"] = [];
  for (const f of obj.findings) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    out.push({
      questionId: r.questionId == null ? null : str(r.questionId),
      category: VALID_CATEGORIES.has(r.category as Finding["category"])
        ? (r.category as Finding["category"])
        : "other",
      severity: VALID_SEVERITIES.has(r.severity as Finding["severity"])
        ? (r.severity as Finding["severity"])
        : "medium",
      description: str(r.description),
      specQuote: str(r.specQuote),
      siteQuote: str(r.siteQuote),
    });
  }
  return out;
}

export async function workersaiCompare(
  env: Env,
  specText: string,
  page: PageCapture,
  modelOverride?: string,
): Promise<{
  findings: CompareResult["findings"];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}> {
  const model = modelOverride ?? env.WORKERSAI_MODEL ?? "@cf/openai/gpt-oss-120b";
  // Route through the Cloudflare AI Gateway when CF_AIG_GATEWAY_ID is set
  // (unified logging/caching/cost across all legs). env.AI.run takes the gateway
  // in its options (3rd) arg; the binding is already account-scoped.
  const aiOptions = env.CF_AIG_GATEWAY_ID ? { gateway: { id: env.CF_AIG_GATEWAY_ID } } : undefined;
  const started = Date.now();
  // The Ai binding's model catalog typing is a string-literal union that lags
  // the live catalog; the runtime accepts any valid model id string.
  const ai = env.AI as unknown as AiRunner;
  const res = (await runWithTimeout(ai, model, {
    messages: [
      {
        role: "system",
        content:
          "You are a meticulous pharmaceutical survey QA analyst. Respond with ONLY a valid JSON object — no prose, no markdown fences.",
      },
      { role: "user", content: buildComparePrompt(specText, page.text, page.pageIndex) },
    ],
    max_tokens: 4096,
    temperature: 0,
  }, aiOptions)) as
    | string
    | null
    | undefined
    | {
        // classic Workers AI shape
        response?: string;
        // OpenAI chat.completion shape (returned by gpt-oss-120b and other
        // OpenAI-compatible catalog models)
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
  const latencyMs = Date.now() - started;

  if (res == null) {
    throw new Error("Workers AI returned no result (null/undefined) from ai.run");
  }
  const text =
    typeof res === "string"
      ? res
      : (res.choices?.[0]?.message?.content ?? res.response ?? "");
  if (!text.trim()) {
    throw new Error(
      `Workers AI returned empty response; raw shape: ${JSON.stringify(res).slice(0, 800)}`
    );
  }

  const usage = typeof res === "object" ? res.usage : undefined;

  // Truncation guard: with max_tokens=4096 a long page can hit the cap, leaving
  // the JSON body cut off. parseLenient's brace-recovery would then silently drop
  // the trailing (unclosed) findings, understating this leg's recall with NO error
  // — which corrupts /api/eval-model bakeoff scores. The OpenAI-compat catalog
  // models (gpt-oss-120b) report this as choices[0].finish_reason "length"; the
  // classic {response:string} shape carries no such signal. Mirror the
  // deepseek/grok/gemini legs and THROW on the length signal instead of
  // warning-and-continuing, so a partial result surfaces as an error rather than
  // being scored as a clean, complete pass.
  const finishReason =
    typeof res === "object" ? res.choices?.[0]?.finish_reason : undefined;
  if (finishReason === "length" || finishReason === "max_tokens") {
    // The truncated call still consumed (and was billed for) its tokens. Carry the
    // usage on the thrown error so the caller can still account for the spend even
    // though the findings are unusable (see costUsd accounting in compare.ts).
    const truncErr = new Error(
      `Workers AI response for page ${page.pageIndex} truncated at max_tokens ` +
        `(4096, finish_reason=${finishReason}); output is incomplete JSON`,
    ) as Error & { usage?: { inputTokens: number; outputTokens: number } };
    truncErr.usage = {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
    };
    throw truncErr;
  }

  const findings = sanitize(parseLenient(text));
  return {
    findings,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    latencyMs,
  };
}

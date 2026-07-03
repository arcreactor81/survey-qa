// Grok compare call — OpenAI-compat fetch, optionally routed through the
// Cloudflare AI Gateway (grok provider). Cloned from deepseek.ts; thinking is
// ON at medium effort with a generous max_tokens so reasoning sharpens the diff
// without starving the JSON answer. grok-4.3 accepts none/low/medium/high.

import { buildComparePrompt } from "../prompt";
import { COMPARE_SCHEMA, resolveSecret } from "../types";
import type { CompareResult, Env, Finding, PageCapture } from "../types";

type RawFinding = CompareResult["findings"][number];

const SYSTEM_PROMPT =
  "You are a meticulous survey QA analyst. You respond with a single JSON object and nothing else.";

const VALID_CATEGORIES = new Set<string>(
  COMPARE_SCHEMA.properties.findings.items.properties.category.enum,
);
const VALID_SEVERITIES = new Set<string>(
  COMPARE_SCHEMA.properties.findings.items.properties.severity.enum,
);

interface GrokChatResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Per-request cap so a hung provider/gateway fails this page fast instead of stalling the step. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Coerce one raw model-emitted entry into a valid finding, or null to drop it. */
function sanitizeFinding(entry: unknown): RawFinding | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const obj = entry as Record<string, unknown>;
  const category =
    typeof obj["category"] === "string" && VALID_CATEGORIES.has(obj["category"])
      ? (obj["category"] as Finding["category"])
      : "other";
  const severity =
    typeof obj["severity"] === "string" && VALID_SEVERITIES.has(obj["severity"])
      ? (obj["severity"] as Finding["severity"])
      : "medium";
  return {
    questionId:
      typeof obj["questionId"] === "string" && obj["questionId"].length > 0
        ? obj["questionId"]
        : null,
    category,
    severity,
    description: typeof obj["description"] === "string" ? obj["description"] : "",
    specQuote: typeof obj["specQuote"] === "string" ? obj["specQuote"] : "",
    siteQuote: typeof obj["siteQuote"] === "string" ? obj["siteQuote"] : "",
  };
}

/** Lenient parse: strip markdown fences, fall back to the outermost {...} span. */
function parseFindings(content: string): RawFinding[] {
  let text = content.trim();
  const fenced = text.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```\s*$/);
  if (fenced) text = fenced[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error("Grok response is not valid JSON");
    }
    parsed = JSON.parse(text.slice(start, end + 1));
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Grok response is not a JSON object");
  }
  const rawFindings = (parsed as Record<string, unknown>)["findings"];
  if (!Array.isArray(rawFindings)) return [];

  const findings: RawFinding[] = [];
  for (const entry of rawFindings) {
    const finding = sanitizeFinding(entry);
    if (finding !== null) findings.push(finding);
  }
  return findings;
}

/**
 * Run one Grok compare call for one rendered page via the xAI OpenAI-compatible
 * API. Thinking is ON at medium effort (reasoning_effort:"medium") with a generous
 * max_tokens so reasoning never starves the JSON answer.
 * Throws on HTTP failure, empty content, or unparseable JSON.
 */
export async function grokCompare(
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
  const apiKey = await resolveSecret(env.XAI_API_KEY);
  if (!apiKey) {
    throw new Error("XAI_API_KEY is not set");
  }

  const model = modelOverride ?? env.GROK_MODEL ?? "grok-4.3";
  // Route through the Cloudflare AI Gateway (grok provider) when
  // CF_AIG_ACCOUNT_ID + CF_AIG_GATEWAY_ID are set (unified logging, caching,
  // cost tracking, retries); else hit the xAI OpenAI-compat endpoint directly.
  const usingGateway = Boolean(env.CF_AIG_ACCOUNT_ID && env.CF_AIG_GATEWAY_ID);
  const baseUrl = usingGateway
    ? `https://gateway.ai.cloudflare.com/v1/${env.CF_AIG_ACCOUNT_ID}/${env.CF_AIG_GATEWAY_ID}/grok/v1`
    : "https://api.x.ai/v1";

  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  if (usingGateway) {
    headers["cf-aig-metadata"] = JSON.stringify({ feature: "survey-qa" });
    if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;
  }

  const body = {
    model,
    response_format: { type: "json_object" },
    // Thinking ON at MEDIUM effort (tuning up from low to chase recall). max_tokens
    // is generous so reasoning never starves the JSON answer (reasoning tokens share
    // the output budget on grok-4.3).
    reasoning_effort: "medium",
    max_tokens: 32000,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildComparePrompt(specText, page.text, page.pageIndex) },
    ],
  };

  const startedAt = Date.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const rawBody = await res.text();
  const latencyMs = Date.now() - startedAt;

  if (!res.ok) {
    throw new Error(`Grok API error ${res.status}: ${rawBody.slice(0, 300)}`);
  }

  let data: GrokChatResponse;
  try {
    data = JSON.parse(rawBody) as GrokChatResponse;
  } catch {
    throw new Error(`Grok returned a non-JSON body: ${rawBody.slice(0, 300)}`);
  }

  const content = data.choices?.[0]?.message?.content ?? "";
  if (content.trim().length === 0) {
    throw new Error("Grok returned empty content");
  }
  // Surface truncation distinctly from a generic parse failure.
  if (data.choices?.[0]?.finish_reason === "length") {
    throw new Error(
      `Grok response truncated at max_tokens (${body.max_tokens}); output is incomplete JSON`,
    );
  }

  return {
    findings: parseFindings(content),
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    latencyMs,
  };
}

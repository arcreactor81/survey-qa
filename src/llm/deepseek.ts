// DeepSeek compare call — raw fetch to the DeepSeek chat-completions API,
// optionally routed through a Cloudflare AI Gateway.

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

interface DeepseekChatResponse {
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
      throw new Error("DeepSeek response is not valid JSON");
    }
    parsed = JSON.parse(text.slice(start, end + 1));
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("DeepSeek response is not a JSON object");
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
 * Run one DeepSeek compare call for one rendered page.
 * Routes via Cloudflare AI Gateway when CF_AIG_ACCOUNT_ID + CF_AIG_GATEWAY_ID are set.
 * Throws on HTTP failure, empty content, or unparseable JSON.
 */
export async function deepseekCompare(
  env: Env,
  specText: string,
  page: PageCapture,
): Promise<{
  findings: CompareResult["findings"];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}> {
  const apiKey = await resolveSecret(env.DEEPSEEK_API_KEY);
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is not set");
  }

  const model = env.DEEPSEEK_MODEL ?? "deepseek-v4-pro";
  const usingGateway = Boolean(env.CF_AIG_ACCOUNT_ID && env.CF_AIG_GATEWAY_ID);
  const baseUrl = usingGateway
    ? `https://gateway.ai.cloudflare.com/v1/${env.CF_AIG_ACCOUNT_ID}/${env.CF_AIG_GATEWAY_ID}/deepseek`
    : "https://api.deepseek.com";

  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  // AI Gateway headers are Cloudflare-specific: only attach them when actually
  // routing through the gateway (never leak CF_AIG_TOKEN to api.deepseek.com).
  if (usingGateway) {
    headers["cf-aig-metadata"] = JSON.stringify({ feature: "survey-qa" });
    if (env.CF_AIG_TOKEN) {
      headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;
    }
  }

  const body = {
    model,
    // deepseek-v4-pro reasons by default; pin it ON explicitly at full effort so
    // the behaviour can never silently change under us. Sampling params
    // (temperature/top_p/penalties) are IGNORED in thinking mode, so we omit them.
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    response_format: { type: "json_object" },
    // completion_tokens counts reasoning + answer TOGETHER, so a tight cap would
    // truncate the chain-of-thought. Set the ceiling far above any single-page
    // worst case (reasoning is ~100-1000 tok/page) so thinking runs to its
    // natural length — this is a runaway backstop, not a limit on reasoning.
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
    throw new Error(`DeepSeek API error ${res.status}: ${rawBody.slice(0, 300)}`);
  }

  let data: DeepseekChatResponse;
  try {
    data = JSON.parse(rawBody) as DeepseekChatResponse;
  } catch {
    throw new Error(`DeepSeek returned a non-JSON body: ${rawBody.slice(0, 300)}`);
  }

  const content = data.choices?.[0]?.message?.content ?? "";
  if (content.trim().length === 0) {
    throw new Error("DeepSeek returned empty content");
  }
  // Surface truncation distinctly from a generic parse failure.
  if (data.choices?.[0]?.finish_reason === "length") {
    throw new Error(
      `DeepSeek response truncated at max_tokens (${body.max_tokens}); output is incomplete JSON`,
    );
  }

  return {
    findings: parseFindings(content),
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    latencyMs,
  };
}

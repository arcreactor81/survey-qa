// Gemini compare call — raw fetch to the Google AI Studio OpenAI-compatibility
// endpoint. Cloned from deepseek.ts; thinking is DISABLED (reasoning_effort:
// "none") so reasoning can never eat the output budget.

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

interface GeminiChatResponse {
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
      throw new Error("Gemini response is not valid JSON");
    }
    parsed = JSON.parse(text.slice(start, end + 1));
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Gemini response is not a JSON object");
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
 * Run one Gemini compare call for one rendered page via the Google AI Studio
 * OpenAI-compatibility endpoint. Thinking is disabled (reasoning_effort:"none")
 * so the model never spends the output budget on reasoning.
 * Throws on HTTP failure, empty content, or unparseable JSON.
 */
export async function geminiCompare(
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
  const apiKey = await resolveSecret(env.GEMINI_API_KEY);
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const model = modelOverride ?? env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const baseUrl = "https://generativelanguage.googleapis.com/v1beta/openai";

  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };

  const body = {
    model,
    response_format: { type: "json_object" },
    // Disable thinking: with reasoning_effort "none" the model spends no tokens
    // on a reasoning trace, so it can never eat the answer budget below.
    reasoning_effort: "none",
    max_tokens: 8000,
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
    throw new Error(`Gemini API error ${res.status}: ${rawBody.slice(0, 300)}`);
  }

  let data: GeminiChatResponse;
  try {
    data = JSON.parse(rawBody) as GeminiChatResponse;
  } catch {
    throw new Error(`Gemini returned a non-JSON body: ${rawBody.slice(0, 300)}`);
  }

  const content = data.choices?.[0]?.message?.content ?? "";
  if (content.trim().length === 0) {
    throw new Error("Gemini returned empty content");
  }
  // Surface truncation distinctly from a generic parse failure.
  if (data.choices?.[0]?.finish_reason === "length") {
    throw new Error(
      `Gemini response truncated at max_tokens (${body.max_tokens}); output is incomplete JSON`,
    );
  }

  return {
    findings: parseFindings(content),
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    latencyMs,
  };
}

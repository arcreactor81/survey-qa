// Claude compare call — OPTIONAL in-Worker path via the official Anthropic SDK.
// Only used when env.ANTHROPIC_API_KEY is set (the caller checks; we also guard here).

import Anthropic from "@anthropic-ai/sdk";
import { buildComparePrompt } from "../prompt";
import { COMPARE_SCHEMA, resolveSecret } from "../types";
import type { CompareResult, Env, Finding, PageCapture } from "../types";

/**
 * Per-request cap: without an explicit timeout the SDK applies a 10-minute
 * non-streaming default, so one hung page could eat most of the 15-minute
 * claude-compare step. maxRetries 1 keeps a quick per-page retry while the
 * workflow step's own retries:{limit:1} covers the leg-level retry.
 */
const REQUEST_TIMEOUT_MS = 60_000;
const SDK_MAX_RETRIES = 1;

// Cache the client per isolate (keyed by API key) instead of constructing a
// fresh Anthropic instance for every page.
let cachedClient: Anthropic | null = null;
let cachedApiKey = "";

function getClient(apiKey: string, baseURL?: string): Anthropic {
  const cacheKey = `${apiKey}|${baseURL ?? ""}`;
  if (cachedClient === null || cachedApiKey !== cacheKey) {
    cachedClient = new Anthropic({
      apiKey,
      // Route through the Cloudflare AI Gateway (anthropic provider) when set.
      ...(baseURL ? { baseURL } : {}),
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: SDK_MAX_RETRIES,
    });
    cachedApiKey = cacheKey;
  }
  return cachedClient;
}

type RawFinding = CompareResult["findings"][number];

const VALID_CATEGORIES = new Set<string>(
  COMPARE_SCHEMA.properties.findings.items.properties.category.enum,
);
const VALID_SEVERITIES = new Set<string>(
  COMPARE_SCHEMA.properties.findings.items.properties.severity.enum,
);

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

/** Parse the structured-output JSON (lenient: strips fences if a model ever adds them). */
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
      throw new Error("Claude response is not valid JSON");
    }
    parsed = JSON.parse(text.slice(start, end + 1));
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Claude response is not a JSON object");
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
 * Run one Claude compare call for one rendered page using structured outputs
 * (output_config.format json_schema with COMPARE_SCHEMA). Do NOT set temperature —
 * sampling parameters are rejected on this model.
 */
export async function claudeCompare(
  env: Env,
  specText: string,
  page: PageCapture,
): Promise<{
  findings: CompareResult["findings"];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}> {
  // Same cleaning as the DeepSeek gate: whitespace-only / "PLACEHOLDER" seeds
  // count as unset instead of producing a client that fails on every page.
  const apiKey = await resolveSecret(env.ANTHROPIC_API_KEY);
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  // Route through the Cloudflare AI Gateway (anthropic provider) when configured,
  // so this optional in-Worker Claude path shares the same gateway as the other
  // legs. (An authenticated gateway would also need cf-aig-authorization headers.)
  const baseURL =
    env.CF_AIG_ACCOUNT_ID && env.CF_AIG_GATEWAY_ID
      ? `https://gateway.ai.cloudflare.com/v1/${env.CF_AIG_ACCOUNT_ID}/${env.CF_AIG_GATEWAY_ID}/anthropic`
      : undefined;
  const client = getClient(apiKey, baseURL);
  const model = env.CLAUDE_MODEL ?? "claude-opus-4-8";

  const startedAt = Date.now();
  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    output_config: {
      format: {
        type: "json_schema",
        // COMPARE_SCHEMA is a readonly `as const` object; the SDK type wants a
        // mutable index-signature object, so cast for the SDK.
        schema: COMPARE_SCHEMA as unknown as Record<string, unknown>,
      },
    },
    messages: [
      { role: "user", content: buildComparePrompt(specText, page.text, page.pageIndex) },
    ],
  });
  const latencyMs = Date.now() - startedAt;

  // Surface truncation distinctly instead of letting it fail as a generic
  // (or worse, silently partial) JSON parse downstream.
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude response truncated (stop_reason: max_tokens); output is incomplete");
  }

  let content = "";
  for (const block of response.content) {
    if (block.type === "text") {
      content = block.text;
      break;
    }
  }
  if (content.trim().length === 0) {
    throw new Error(
      `Claude returned no text content (stop_reason: ${response.stop_reason ?? "unknown"})`,
    );
  }

  return {
    findings: parseFindings(content),
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    latencyMs,
  };
}

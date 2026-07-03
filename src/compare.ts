// Compare orchestration: per-model token pricing and the sequential DeepSeek
// page loop (Workers subrequest safety — no parallel fan-out).

import { deepseekCompare } from "./llm/deepseek";
import { workersaiCompare } from "./llm/workersai";
import type { Env, Finding, ModelName, ModelRunStats, PageCapture } from "./types";

// Defaults mirror the *_USD_PER_MTOK vars in wrangler.jsonc (env vars win at
// runtime; these fallbacks apply only if a rate var is unset).
const DEFAULT_RATES: Record<ModelName, { input: number; output: number }> = {
  claude: { input: 5, output: 25 },
  deepseek: { input: 0.28, output: 0.42 },
  workersai: { input: 0.35, output: 0.75 },
};

function parseRate(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** USD cost for a token count at the env-configured (or default) per-MTok rates. */
export function computeCost(
  model: ModelName,
  inputTokens: number,
  outputTokens: number,
  env: Env,
): number {
  const defaults = DEFAULT_RATES[model];
  const envRates: Record<ModelName, [string | undefined, string | undefined]> = {
    claude: [env.CLAUDE_INPUT_USD_PER_MTOK, env.CLAUDE_OUTPUT_USD_PER_MTOK],
    deepseek: [env.DEEPSEEK_INPUT_USD_PER_MTOK, env.DEEPSEEK_OUTPUT_USD_PER_MTOK],
    workersai: [env.WORKERSAI_INPUT_USD_PER_MTOK, env.WORKERSAI_OUTPUT_USD_PER_MTOK],
  };
  const inputRate = parseRate(envRates[model][0], defaults.input);
  const outputRate = parseRate(envRates[model][1], defaults.output);
  return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
}

/**
 * Guard against a total leg outage being reported as a healthy "0 findings"
 * run: if EVERY page errored, throw so the workflow step fails (its configured
 * retry fires, and a persistent outage marks the run failed) instead of
 * resolving with an empty-but-successful-looking result. Partial failures
 * still degrade gracefully via stats.errors.
 */
export function assertLegNotFullyFailed(
  leg: ModelName,
  stats: ModelRunStats,
  pageCount: number,
  lastError: string | undefined,
): void {
  if (pageCount > 0 && stats.errors === pageCount) {
    throw new Error(
      `${leg} compare failed on all ${pageCount} page(s) — leg is down, not "0 findings". Last error: ${lastError ?? "unknown"}`,
    );
  }
}

/**
 * Run the DeepSeek compare over all pages sequentially.
 * A page-level failure increments stats.errors and the run continues;
 * if ALL pages fail the leg throws (total outage must be loud).
 * Findings are stamped model:"deepseek", pageIndex, quoteVerified:false
 * (verification happens later in verify.ts).
 */
export async function runDeepseekCompares(
  env: Env,
  specText: string,
  pages: PageCapture[],
): Promise<{ findings: Finding[]; stats: ModelRunStats }> {
  const findings: Finding[] = [];
  const stats: ModelRunStats = {
    model: "deepseek",
    modelId: env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencyMsTotal: 0,
    errors: 0,
  };

  let lastError: string | undefined;
  for (const page of pages) {
    stats.calls += 1;
    try {
      const result = await deepseekCompare(env, specText, page);
      stats.inputTokens += result.inputTokens;
      stats.outputTokens += result.outputTokens;
      stats.latencyMsTotal += result.latencyMs;
      for (const finding of result.findings) {
        findings.push({
          ...finding,
          model: "deepseek",
          pageIndex: page.pageIndex,
          quoteVerified: false,
        });
      }
    } catch (err) {
      stats.errors += 1;
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`deepseek compare failed for page ${page.pageIndex}: ${lastError}`);
    }
  }

  assertLegNotFullyFailed("deepseek", stats, pages.length, lastError);
  stats.costUsd = computeCost("deepseek", stats.inputTokens, stats.outputTokens, env);
  return { findings, stats };
}

/**
 * Run the Workers AI compare over all pages sequentially (same shape as the
 * DeepSeek loop). Requires the AI binding; no API key.
 */
export async function runWorkersaiCompares(
  env: Env,
  specText: string,
  pages: PageCapture[],
): Promise<{ findings: Finding[]; stats: ModelRunStats }> {
  const findings: Finding[] = [];
  const stats: ModelRunStats = {
    model: "workersai",
    modelId: env.WORKERSAI_MODEL ?? "@cf/openai/gpt-oss-120b",
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencyMsTotal: 0,
    errors: 0,
  };

  let lastError: string | undefined;
  for (const page of pages) {
    stats.calls += 1;
    try {
      const result = await workersaiCompare(env, specText, page);
      stats.inputTokens += result.inputTokens;
      stats.outputTokens += result.outputTokens;
      stats.latencyMsTotal += result.latencyMs;
      for (const finding of result.findings) {
        findings.push({
          ...finding,
          model: "workersai",
          pageIndex: page.pageIndex,
          quoteVerified: false,
        });
      }
    } catch (err) {
      stats.errors += 1;
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`workersai compare failed for page ${page.pageIndex}: ${lastError}`);
    }
  }

  assertLegNotFullyFailed("workersai", stats, pages.length, lastError);
  stats.costUsd = computeCost("workersai", stats.inputTokens, stats.outputTokens, env);
  return { findings, stats };
}

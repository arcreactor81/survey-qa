/**
 * GROK leg — the WHOLE-DOCUMENT pass (owner ruling: Grok + DeepSeek, differing in METHOD).
 *
 * Request shape and gateway routing are taken from the v1 leg (`src/llm/grok.ts`,
 * read-only): xAI's OpenAI-compatible endpoint, routed through AI Gateway `grok/v1` when
 * CF_AIG_ACCOUNT_ID + CF_AIG_GATEWAY_ID are set, thinking ON, JSON object response format.
 */

import { num, type Env } from "../types/env";
import { chatJson, keyFor, type ChatOptions, type ChatOutcome, type ProviderSpec } from "./chat";

export async function grokSpec(env: Env): Promise<ProviderSpec> {
  return {
    provider: "grok",
    model: env.GROK_MODEL ?? "grok-4.3",
    gatewaySuffix: "/v1",
    directBaseUrl: "https://api.x.ai/v1",
    apiKey: await keyFor(env, "grok"),
    inputUsdPerMTok: num(env.GROK_INPUT_USD_PER_MTOK, 1.25),
    outputUsdPerMTok: num(env.GROK_OUTPUT_USD_PER_MTOK, 2.5),
    // Reasoning tokens share the output budget on grok-4.3, so max_tokens is set
    // generously by the caller rather than trimmed here.
    extraBody: { reasoning_effort: env.GROK_REASONING_EFFORT ?? "high" },
  };
}

export const grokJson = async (env: Env, opts: ChatOptions): Promise<ChatOutcome> =>
  chatJson(await grokSpec(env), env, opts);

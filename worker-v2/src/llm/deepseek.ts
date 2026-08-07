/**
 * DEEPSEEK leg — the BLOCK-BY-BLOCK pass (owner ruling: Grok + DeepSeek, differing in
 * METHOD).
 *
 * Request shape and gateway routing are taken from the v1 leg (`src/llm/deepseek.ts`,
 * read-only): DeepSeek's chat-completions API, routed through AI Gateway `deepseek` when
 * CF_AIG_ACCOUNT_ID + CF_AIG_GATEWAY_ID are set, thinking pinned ON explicitly so the
 * behaviour cannot silently change, JSON object response format. Sampling params are
 * omitted because they are ignored in thinking mode.
 *
 * `completion_tokens` counts reasoning + answer TOGETHER, which is why the block pass
 * sizes its chunks well under the token ceiling instead of trusting one big call.
 */

import { num, type Env } from "../types/env";
import { chatJson, keyFor, type ChatOptions, type ChatOutcome, type ProviderSpec } from "./chat";

export async function deepseekSpec(env: Env): Promise<ProviderSpec> {
  return {
    provider: "deepseek",
    model: env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
    gatewaySuffix: "",
    directBaseUrl: "https://api.deepseek.com",
    apiKey: await keyFor(env, "deepseek"),
    inputUsdPerMTok: num(env.DEEPSEEK_INPUT_USD_PER_MTOK, 0.28),
    outputUsdPerMTok: num(env.DEEPSEEK_OUTPUT_USD_PER_MTOK, 0.42),
    extraBody: {
      thinking: { type: "enabled" },
      reasoning_effort: env.DEEPSEEK_REASONING_EFFORT ?? "medium",
    },
  };
}

export const deepseekJson = async (env: Env, opts: ChatOptions): Promise<ChatOutcome> =>
  chatJson(await deepseekSpec(env), env, opts);

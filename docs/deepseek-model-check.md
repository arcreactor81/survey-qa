# DeepSeek model check: is v4-flash "even stronger than v4-pro"?

Checked 2026-08-08. Current config: `worker-v2/wrangler.jsonc:206` sets `DEEPSEEK_MODEL = "deepseek-v4-pro"` (fallback default is also `deepseek-v4-pro`, hardcoded in `worker-v2/src/llm/deepseek.ts:21`, along with the price constants `$0.28`/`$0.42` per Mtok used below). DeepSeek does the block-by-block pass A leg, `response_format: json_object`, thinking pinned on, `reasoning_effort: "medium"`.

## Verdict: **Partly true** — real, but the comparison is apples-to-oranges unless you fix the effort setting

DeepSeek's official 31 Jul 2026 GA release of `deepseek-v4-flash-0731` genuinely **beats `deepseek-v4-pro` on every agentic benchmark DeepSeek publishes** — but that's Flash-GA vs Pro-**Preview** (Pro's official GA build hasn't shipped; DeepSeek's own page says an official Pro release is "as soon as possible"). Independent measurement (Artificial Analysis) confirms Flash beats Pro **when Pro isn't pushed to its own max reasoning effort** — at matched max effort, Pro's Intelligence Index score is still slightly higher than Flash's. So: Flash is not a "weaker/cheaper tier" as the naming implies — DeepSeek broke that convention on purpose — but "Flash is unconditionally the better model" overstates it. It's the better model **per dollar and per second, and on agentic/coding-shaped tasks specifically**, not necessarily on raw peak intelligence at matched effort.

## 1. What exists right now

| id | released | status | source |
|---|---|---|---|
| `deepseek-v4-pro` | 2026-04-24 (preview) | current; official GA still pending ("ASAP") | api-docs.deepseek.com/news/news260424 |
| `deepseek-v4-flash` | 2026-04-24 (preview) → **2026-07-31 GA** (`-0731` build, re-post-trained for agents) | current, GA | api-docs.deepseek.com/updates, deepseek.ai/blog (3rd-party, corroborated by AA) |
| `deepseek-chat` / `deepseek-reasoner` | legacy aliases of V3.2 (non-thinking/thinking) since 2025-12-01 | **retired 2026-07-24 15:59 UTC** | api-docs.deepseek.com/updates |

Only two model ids exist today: `deepseek-v4-pro`, `deepseek-v4-flash` (confirmed via `GET /models`, api-docs.deepseek.com/api/list-models). No separate plain "v4" id. The legacy chat/reasoner names are dead — any code still sending them will fail.

## 2. Flash vs Pro: vendor claim vs independent measurement

**DeepSeek's own claim** (deepseek.ai/blog — third-party-hosted but content matches api-docs changelog): GA Flash-0731 scores 82.7 on Terminal-Bench 2.1 vs 72.1 for Pro-Preview; beats Pro-Preview on all 9 published agent benchmarks (DeepSWE, NL2Repo, Cybergym, Toolathlon, Agent Last Exam, Automation Bench, DSBench ×2). **Caveat stated by DeepSeek itself: comparison is against Pro's preview build, not a GA Pro.** Treat as vendor-reported, agent-harness-sensitive.

**Independent measurement** (Artificial Analysis, artificialanalysis.ai — not DeepSeek):
- At **matched high/max reasoning effort**, results flip depending on which effort tier each model is run at: Flash at Max effort scores ~50-52 on the AA Intelligence Index; Pro at "High" (not its own max) scores ~43-44 — Flash wins. But **Pro pushed to its own Max effort scores ~52**, i.e., back on top of or level with Flash — AA's own writeup ranks Pro-Max as "#2 open-weights reasoning model behind Kimi K2.6," ahead of Flash-Max's ~47.
- Agentic/real-world tasks (GDPval-AA): Pro leads, 1554 vs Flash's 1388.
- Both models have high non-abstention/hallucination rates (94% Pro, 96% Flash) — neither is reliable on knowledge boundaries; not differentiating.
- **Speed**: Flash is unambiguously faster and cheaper at every effort level (below).

**Read:** the "flash beats pro" framing holds specifically for (a) DeepSeek's own agent-benchmark suite compared against Pro's *preview*, and (b) independent measurement *only when Pro is not run at its own max effort*. It is not true that Flash beats a fully-cranked Pro on general intelligence — they're close, with Pro slightly ahead at matched top effort.

## 3. Pricing, latency (official + independent)

| | `deepseek-v4-flash` | `deepseek-v4-pro` |
|---|---|---|
| Input, cache miss (official, api-docs.deepseek.com/quick_start/pricing) | $0.14 /Mtok | $0.435 /Mtok |
| Input, cache hit | $0.0028 /Mtok | $0.003625 /Mtok |
| Output | $0.28 /Mtok | $0.87 /Mtok |
| Our config's assumed price (`wrangler.jsonc`) | not used today | **$0.28 in / $0.42 out** — stale vs. official above (~1.5-2x under current official rate; likely dates to the April preview) |
| Independent throughput (AA, max/high effort settings, their harness) | ~102-113 tok/s output, ~1.15s TTFT | ~57-60 tok/s output, ~1.70s TTFT |
| Rate limit (concurrent connections/account, official) | 2,500 | 500 |
| Context window | 1,000,000 tokens (official); Cloudflare's own hosted-model catalog page lists 131,072 for Pro — a **different product** (Fireworks-served Workers-AI catalog, not the api.deepseek.com path we use) | 1,000,000 tokens (official, api.deepseek.com) |
| Max output tokens | 384K (both, official) | 384K |

**Flash is ~3.1x cheaper on input and exactly 3.1x cheaper on output**, at roughly double the throughput, per official pricing and independent AA speed data.

## 4. JSON / structured output

Both models are on the same `api.deepseek.com` surface and same request schema: `response_format: {"type": "json_object"}` + the word "json" in the prompt (official guide, api-docs.deepseek.com/guides/json_mode). Official docs flag a known issue **for the JSON mode generally, not model-specific**: "the API may occasionally return empty content... actively working on optimizing this." A separate community report (vLLM issue #41132) notes V3.2/V4 can produce **malformed structured output when thinking mode is enabled** — relevant to us because our config pins `thinking: enabled` on Pro today; this risk class is not shown to be better or worse on Flash specifically (unverified difference between the two on this axis).

## 5. Cloudflare AI Gateway routing

Confirmed reachable: our code (`worker-v2/src/llm/deepseek.ts`) already proxies to `api.deepseek.com` through gateway `firstgateway` using a generic pass-through provider path (`gateway.ai.cloudflare.com/v1/{account}/{gateway}/deepseek/...`), forwarding whatever model id is sent. Cloudflare's AI Gateway "providers/deepseek" doc doesn't enumerate model ids (still shows the retired `deepseek-chat` as its example) — it's a transparent proxy, not a curated allow-list, so this is not a functional blocker. **Practically certain but not literally documented per-model**: switching `DEEPSEEK_MODEL` to `deepseek-v4-flash` should route through the exact same gateway path with no config changes beyond the model string and the price constants.

Note: don't confuse this with Cloudflare's separate hosted-model catalog (`developers.cloudflare.com/ai/models/deepseek/deepseek-v4-pro`, served via Fireworks, billed through Cloudflare, 131K context) — that's a different product from the AI-Gateway-proxies-to-DeepSeek's-own-API path our Worker actually uses.

## Judgment for our workload (chunked prose in, strict typed JSON out, inside a bounded Workflow step)

**Switching to `deepseek-v4-flash` looks like an improvement, not a wash**, for this specific shape of work:

- **Cost**: Flash is ~3.1x cheaper than Pro per Mtok at official pricing, **and this ratio holds regardless of input/output token mix** (0.14/0.435 = 0.28/0.87 = 0.322). But our measured "~$0.08/doc" was computed off the *stale* config constants ($0.28 in/$0.42 out), not today's official Pro price ($0.435/$0.87). Rescaling: true current Pro cost is likely **~$0.12-0.17/doc** (the $0.08 figure × 1.55-2.07, depending on the input/output token split), and Flash at official pricing would be **~$0.04-0.05/doc** (the same $0.08 baseline × 0.5-0.67). So the actual before/after is closer to "$0.13-0.17 → $0.04-0.05" than "$0.08 → $0.03" — the ledger has been under-reporting Pro's real cost all along, independent of which model we pick.
- **Wall-clock**: AA's throughput numbers (~2x tokens/sec, ~0.5s better TTFT) point toward the ~127s median per call coming down meaningfully — plausibly into the 60-90s range if our workload scales similarly to AA's harness, though **AA's numbers are their own benchmark conditions, not our chunk-and-thinking-mode pattern**, so treat the exact magnitude as directional, not a guarantee.
- **Structured-output reliability**: no evidence either model is meaningfully better here; same known "occasional empty content" caveat applies to both, and the thinking-mode-breaks-structured-output risk (external vLLM report) isn't shown to differ by tier. Net: **neutral risk**, not a regression.
- **Context/limits**: identical 1M context and 384K max-output ceiling on the `api.deepseek.com` path we use, and Flash's rate limit is 5x more headroom (2,500 vs 500 concurrent) — not binding for us today (`EXTRACT_CHUNK_CONCURRENCY=5`), but more slack if that ever scales up.
- **Model-quality risk specific to us**: our task is closer to extraction/comprehension than open-ended agentic coding, and the strongest independent signal in Flash's favor is agentic-benchmark-specific; the AA general Intelligence Index gap at matched top effort is small and can go either way. Recommend validating on a handful of real documents (side-by-side JSON diff against current Pro output) before fully cutting over, rather than assuming the agent-benchmark win transfers to block-level structured extraction.
- **Deprecation risk**: Pro's GA (non-preview) release is still pending per DeepSeek's own roadmap language ("ASAP") — Pro's current preview id could itself be superseded/renamed later, which is a mild argument for treating this migration as due either way rather than a reason to prefer Pro today.

**Recommendation**: pilot `deepseek-v4-flash` on a sample of real documents alongside current `deepseek-v4-pro` output (same prompts, same chunking), compare JSON validity rate and field-level agreement, and update the (currently stale) `DEEPSEEK_INPUT_USD_PER_MTOK`/`DEEPSEEK_OUTPUT_USD_PER_MTOK` constants to today's official prices for whichever model is selected. If JSON validity and extraction agreement hold up, switch — the cost and latency case is strong and the risk is not obviously worse than what's already accepted with Pro.

## Sources used (primary preferred)

- api-docs.deepseek.com/updates/ (official changelog)
- api-docs.deepseek.com/api/list-models/ (official model list)
- api-docs.deepseek.com/news/news260424/ (official V4 preview announcement)
- api-docs.deepseek.com/quick_start/pricing/ (official pricing)
- api-docs.deepseek.com/guides/json_mode/ (official JSON mode guide)
- api-docs.deepseek.com/quick_start/rate_limit/ (official rate limits)
- developers.cloudflare.com/ai-gateway/usage/providers/deepseek/ (official Cloudflare AI Gateway DeepSeek provider docs)
- developers.cloudflare.com/ai/models/deepseek/deepseek-v4-pro/ (official Cloudflare hosted-model catalog page — different product, noted above)
- artificialanalysis.ai/models/comparisons/deepseek-v4-flash-vs-deepseek-v4-pro-high and artificialanalysis.ai/articles/deepseek-is-back-among-the-leading-open-weights-models-with-v4-pro-and-v4-flash (independent benchmark)
- deepseek.ai/blog/deepseek-v4-flash-ga-agent-benchmarks — **explicitly a third-party/independent site, not affiliated with DeepSeek** (their own disclaimer), used only where corroborated by api-docs.deepseek.com's changelog
- github.com/vllm-project/vllm issue #41132 (community report, structured-output-with-thinking risk)
- local: `E:\survey-qa\worker-v2\wrangler.jsonc`, `E:\survey-qa\worker-v2\src\llm\deepseek.ts`, `E:\survey-qa\worker-v2\src\llm\chat.ts`

## Could not verify

- Exact wall-clock impact on OUR specific chunked/thinking-mode workload (only AA's own harness numbers exist).
- Whether `deepseek-v4-flash` is explicitly listed as supported on Cloudflare's AI Gateway "providers/deepseek" page (it isn't enumerated either way — the page is a generic proxy doc still showing the retired `deepseek-chat` as its example).
- Whether the "empty content" JSON-mode bug or the thinking-mode structured-output bug occurs at different rates on Flash vs Pro specifically.
- The exact reason our config's Pro price constants ($0.28/$0.42) diverge from current official pricing ($0.435/$0.87) — plausibly dates to the April preview launch price, but not confirmed against a historical pricing snapshot.
- Whether `reasoning_effort`/`thinking: enabled` (the extra request-body fields our code sends, per `deepseek.ts`) behave identically on `deepseek-v4-flash` as on `deepseek-v4-pro` — same documented API surface, but not confirmed model-by-model.

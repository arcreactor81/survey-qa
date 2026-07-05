# Workers AI third-pillar bakeoff

The automated in-Worker "third pillar" model is set by the `WORKERSAI_MODEL` var in
`wrangler.jsonc` (switching models is a one-line config change + redeploy — no code change).
Candidates are benched via the secured `GET /api/eval-model?model=<id>&run=<runId>` endpoint
(allowlist in `src/index.ts` → `EVAL_ALLOWLIST`), which runs a candidate over an existing run's
captured pages and scores it against the seeded manifest. Harness: `scratchpad/bench2.mjs`.

## Round 2 — 2026-07-03 (run 43609dcf, 6 pages, en; during a Workers AI brownout)

| Model | Recall (2 reps) | False positives | Speed | Notes |
|---|---|---|---|---|
| `@cf/moonshotai/kimi-k2.7-code` | **10, 10** /10 | 2, 1 | ~198 s/leg | best accuracy; **~3× slower**, tripped the 60 s/page cap |
| `@cf/openai/gpt-oss-120b` *(incumbent)* | 8, 8 /10 | 3, 4 | ~70 s/leg | balanced, reliable, no timeout issues |
| `@cf/qwen/qwen3-30b-a3b-fp8` | 7, 8 /10 | 3, 1 | ~88 s/leg | ~gpt-oss tier, slightly lower recall |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | 8, 8 /10 | **10, 9** | ~31 s/leg | fastest, but disqualifying false-positive rate |
| `@cf/qwen/qwq-32b` | 5, 6 /10 | 2, 0 | ~117 s/leg | weak + per-page errors (24 k context too small for the task) |
| `@cf/moonshotai/kimi-k2.6` | 2 /10 | 0 | timeouts | unusable (slow, times out) |

## Decision: keep `gpt-oss-120b`

Only `kimi-k2.7-code` beats the incumbent, and it beats it well (perfect recall + lower FP). But:
- It runs ~3× slower and trips the 60 s per-call cap, so as an **automated in-Worker leg** it would
  slow the pipeline (that leg up to ~12 min) and risk losing pages to the timeout.
- The Workers AI leg's role is the **fast, zero-key, always-on** third opinion; **Claude (via the
  runner) already provides the 10/10 accuracy tier**, so paying 3× latency to lift this leg 8→10 is
  low marginal value.
- gpt-oss-120b's 8/10 here is likely understated — the bench ran during a Workers AI brownout (one
  rep took a JSON-parse error on a page); its healthy score is a consistent 9/10.

**Upgrade path if latency budget changes:** switch `WORKERSAI_MODEL` to `@cf/moonshotai/kimi-k2.7-code`
AND raise the per-call timeout in `src/llm/workersai.ts` (`runWithTimeout`, currently 60 s) to ~120 s
plus rescale `legStepTimeout` in `src/workflow.ts`. Mistral is fast but ruled out on false positives.

## Round 3 — 2026-07-03 — FULL multilingual matrix (6 langs × 6 models, recall/10)

Every leg validated across en/es/fr/de/zh/ja (seeded 10-error manifest per lang). Claude tiers
run via the parameterized runner (`--model`); kimi via `/api/eval-model` (2 reps, timeout-fragile).

| lang | DeepSeek | gpt-oss-120b | kimi-k2.7 | Opus 4.8 | Sonnet-4.6 | Haiku-4.5 |
|---|---|---|---|---|---|---|
| en | 8 | 8 | 4·10 | 10 | 10 | 10 |
| es | 10 | 9 | 8·8 | 10 | 10 | 9 |
| fr | 10 | 10 | 8·10 | 10 | 10 | 9 |
| de | 10 | 9 | 8·8 | 10 | 10 | 10 |
| zh | 10 | 8 | 10·10 | 10 | 10 | 10 |
| ja | 10 | 9 | 10·9 | 10 | 10 | 10 |
| **avg recall** | **9.7** | **8.8** | **~8.6** | **10.0** | **10.0** | **9.7** |
| **avg FP** | 1.8 | 2.5 | ~1.8 | **0.7** | 1.8 | 2.3 |

Conclusions:
- **Sonnet-4.6 = Opus on recall (perfect 10/10 all langs), faster, far lighter on subscription quota** →
  recommended swap for the Claude leg. Opus keeps a small edge on false positives (0.7 vs 1.8).
- **kimi-k2.7-code REJECTED as a leg:** multilingually it is the least reliable (avg ~8.6, en swung 4↔10),
  timed out on nearly every rep at the 60 s cap, and its reasoning truncated to an EMPTY response (fr rep2:
  finish_reason=length, 4096-tok output cap eaten by CoT). Its English 10/10 was a fluke; not worth the
  timeout/token-cap accommodations to babysit one slow high-variance model.
- **gpt-oss-120b is the weakest surviving leg (8.8) and has no better zero-key `@cf` replacement** (kimi
  failed; qwen ~7; mistral 8-but-10-FP). Since API keys are not a differentiator for this product, the
  cleaner roster is **DeepSeek + Gemini 2.5 Flash + Claude(Sonnet-4.6)**, retiring gpt-oss.

## Round 4 — 2026-07-04 — Gemini vs Grok, and the final automatic roster

Round 3 recommended retiring gpt-oss and closing the roster at DeepSeek + a third keyed leg + Claude
Sonnet-4.6. Two API-keyed third-leg candidates were then evaluated head-to-head (thinking ON, routed
through the Cloudflare AI Gateway) across the same six-language seeded manifest:

| Candidate | Recall (6 langs) | FP | Latency | Notes |
|---|---|---|---|---|
| **Grok 4.3** (`reasoning_effort: medium`) | **10/10 all langs** | ~1.2 | normal | tuning low→medium lifted 9→10; cleanest FP of the keyed legs |
| Gemini 2.5 Flash (`reasoning_effort: medium`) | ~9 (noisy) | higher | normal | plateaued at 9 with more false-positive noise |
| Gemini 3 Flash (preview) | 10/10 | — | **~10× slower (~156 s/leg)** | perfect recall but preview instability + latency disqualifying |

**Decision (final roster, locked 5 Jul 2026):** DeepSeek v4-pro + **Grok 4.3 (medium)** + Claude
Sonnet-4.6 — all run automatically in-Worker, routed through the AI Gateway. **Grok replaces Gemini** as
the third leg (10/10 at usable latency, lowest FP). **gpt-oss and Gemini are retired but kept
inert-and-re-enablable** (their legs + `wrangler.jsonc` vars remain, gated off), so the roster can be
re-benched without code changes.

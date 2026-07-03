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

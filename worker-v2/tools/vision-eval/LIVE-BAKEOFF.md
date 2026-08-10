# Local live visual-provider bake-off

This path compares exactly two production visual adapters against the three public,
hash-bound fixtures:

- Workers AI `@cf/google/gemma-4-26b-a4b-it`
- keyless `google-ai-studio/gemini-3.6-flash` through AI Gateway `firstgateway`

It does not read blind material. The Worker has no application-secret, storage, route,
preview, or observability binding. AI is the only remote binding, so an `/invoke` request
can incur a model charge even though the Worker endpoint itself is local.

## 2026-08-09 measured run

Run `658ef0af-085d-4b47-91ce-751fb3bd67f5` safety-stopped after its first Gemma entry.
The `/invoke` request returned an unavailable response without complete token/cost accounting,
so the journal recorded one claim and one unknown-accounting result, emitted no prediction, and
refused the remaining five entries. Known spend is `$0`; actual spend is **unknown**, not zero.
There was no retry. The local Worker was stopped and port 8788 was closed afterward.

The attempted Gemma adapter used an OpenAI-style multimodal content array plus JSON Mode. Review
against Cloudflare's native vision contract showed that the binding requires plain message text
plus a separate top-level image, and the published JSON Mode model list does not include Gemma 4.
The production adapter and fake-binding tests have been corrected offline. This run is therefore
evidence for the safety stop onlyâ€”not model quality, latency, configured cost, or provider
selection. Do not resume it or buy another entry under its `$0.05` authorization; a new live run
requires a separately reviewed budget.

## Before a reviewed live run

Authenticate Wrangler separately, then inspect `run-plan.json` after the runner creates
it. Do not put credentials in `--endpoint`; the runner only accepts loopback HTTP URLs.

Start the endpoint in one terminal from `worker-v2/`:

```powershell
npx.cmd --no-install wrangler dev --config wrangler.vision-bakeoff.jsonc --env-file tools/vision-eval/live-worker.empty.env --ip 127.0.0.1 --port 8788
```

Passing the intentional empty env file is mandatory. It prevents Wrangler from loading
the project's unrelated `.dev.vars` into this keyless, local-only Worker.

In a second terminal, use a new empty output directory. Use the six-call default so both
models cover all three fixtures, including the mobile RTL case. The hard pre-call cost
reservation may stop earlier with an explicit coverage shortfall:

```powershell
node tools/vision-eval/live-bakeoff.mjs --endpoint http://127.0.0.1:8788/invoke --output-dir E:\tmp\survey-vision-bakeoff-2026-08-09 --max-calls 6
```

## Cost and retry boundary

The frozen plan records the production rate card date and each adapter's production
pre-call upper bound. Before every claim, the runner requires accumulated known cost plus
that upper bound to fit within the global `$0.05` ceiling. Configured cost is admitted only
when both token counts and the requested model identity are present. Unknown cost is
always `null`, never zero, and stops the run before another call.

Each entry is attempted at most once. AI Gateway logging and cache are disabled, Gateway
attempts are one, and there is no runner retry. The journal fsyncs a `claim` before fetch
and a `result` afterward. A restart that finds a claim without a result refuses to buy the
entry again; retain the directory for audit and use a separately reviewed new run if needed.

## Outputs

- `run-plan.json`: immutable fixture/model/cost plan
- `attempt-journal.ndjson`: append-only paid-attempt ledger
- `predictions.<model-selector>.json`: hardened provider-observed envelopes
- `evaluator-provenance.<model-selector>.json`: hash receipts for that model's records
- `run-summary.json`: stop reason, attempts, accounting coverage, and known spend

Provider errors are still journaled. Measurable token cost is retained; missing or drifting
accounting remains unknown. A record is never emitted without known configured cost, exact
production prompt/schema provenance, a matching model configuration, and a hashed call receipt.

## Offline verification

These checks use fake bindings/endpoints only and do not start Wrangler or call a model:

```powershell
node tools/vision-eval/live-bakeoff.test.mjs
npx.cmd tsc --noEmit --target ES2022 --module ES2022 --moduleResolution bundler --lib ES2022 --types @cloudflare/workers-types --strict --skipLibCheck tools/vision-eval/live-worker.ts
```

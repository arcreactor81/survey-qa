# Provider routing and continuity in v2 extraction

Status: implemented and tested offline on 13 August 2026. No provider request was made
during this implementation.

## The normal route

Extraction intentionally uses two different reading methods and two providers:

| Pass | Method | Normal model |
|---|---|---|
| A | whole-document windows for global rules, ambiguity, and cross-references | exact `grok-4.6` |
| B | addressable block walk plus a source-ledger sweep | exact `deepseek-v4-pro` |

The normal result is therefore **Grok 4.6 + DeepSeek Pro**. Deterministic parsing,
coverage, merge, ambiguity, and sealing gates remain authoritative; a stronger model is
not permission to guess or silently shorten the document.

DeepSeek Flash is dormant in a normal run. It substitutes for one pass-A window only
after that window has a retained, typed Grok failure receipt. It never replaces Pro and
Pro is never a speculative fallback from Flash in the production extraction route.

The earlier generic `deepseekJsonWithContinuity` Flash-to-Pro primitive remains in the
repository, with its accounting and tests, but the ordinary pass-B call graph does not
select it. Keeping a tested primitive is different from silently scheduling it.

```text
pass-A window
    |
    +-- exact grok-4.6 usable result --------------------> persist Grok result
    |
    +-- eligible typed ModelCallError
             |
             +-- persist Grok receipt + trigger FIRST
             |
             +-- exact deepseek-v4-flash ----------------> persist substitute result

pass-B chunk/sweep --------------------------------------> exact deepseek-v4-pro
```

## What may activate Flash

Flash is authorized only after bounded Grok attempts end in one of these typed states:

| Grok failure | Flash? |
|---|---|
| timeout/network or HTTP 408 | yes |
| HTTP 429 / quota pressure | yes |
| HTTP 402 / exhausted balance | yes |
| HTTP 5xx provider unavailability | yes |
| exact-model response with truncated, empty, or invalid structured output | yes |
| HTTP 401/403 authentication | no |
| HTTP 400/404/409/422 invalid request/configuration | no |
| other nonretryable HTTP | no |
| missing credentials or local programming/configuration error | no |

The trigger records its schema, failure kind, HTTP status, exact Grok model, error
detail, and the stable event id of the paid Grok receipt. It is written before the Flash
request. A restart that finds the trigger resumes Flash; it cannot retry Grok and erase
why another provider purchase was authorized.

## Independence is not laundered

If Flash substitutes for Grok, the two completed readings are Flash + Pro: different
models and methods, but the same provider family. The pass-A artifact records
`providerIndependence: reduced-same-provider-fallback`. Consolidation returns the named
non-evaluated state `REDUCED_PROVIDER_INDEPENDENCE`; the extracted payloads remain
available for diagnosis, but the run cannot seal them as ordinary independent-provider
corroboration.

This is a continuity result, not an equivalent confidence claim.

## Exact model and price authority

Every successful response must report the exact requested model. An alias, redirect,
missing `response.model`, or different model is unusable and is charged conservatively;
it is never stored under the requested model's identity.

`grok-4.6` is pinned. The active reviewed authority is explicitly an
`owner-dashboard-copy` observed on `2026-08-13`, not an authenticated catalogue result.
The copied dashboard reports a 500,000-token context window and these text tiers:

| Context | Input USD/Mtok | Cached input USD/Mtok | Output USD/Mtok |
|---|---:|---:|---:|
| at or below 200,000 tokens | 2 | 0.5 | 6 |
| above 200,000 tokens | 4 | 1 | 12 |

The transport ledger has one flat input/output pair, so the reviewed policy is
`max-known-text-tier/1.0.0`: every Grok call is reserved and settled at 4 USD/Mtok input
and 12 USD/Mtok output. This intentionally over-reserves a shorter request rather than
under-reserving a long-context request. Grok 4.5 rates are never reused.

The complete binding includes exact model, source, observation date, context window, base
and long tiers, threshold, explicit 4/12 maxima, and the SHA-256 of their canonical JSON:
`be9305eacc767d81d123ca1cada22a89ca04f191f9dfe60c925106dfccde57b5`. The Worker
recomputes that digest before resolving the Secrets Store key. Missing, malformed, zero,
under-ceiling, mixed-source, or digest-mismatched fields return `GROK_RATE_UNATTESTED`
and issue zero Grok requests. The reviewed main v2 config activates all sixteen added
fields atomically; generated canary configuration must carry the same set.

DeepSeek roles remain exact:

| Extraction role | Configured model | Checked USD/Mtok in | Checked USD/Mtok out |
|---|---|---:|---:|
| dormant Grok substitute | `DEEPSEEK_MODEL=deepseek-v4-flash` | 0.14 | 0.28 |
| ordinary pass B | `DEEPSEEK_FALLBACK_MODEL=deepseek-v4-pro` | 0.435 | 0.87 |

The historical variable names reflect the retained generic continuity primitive. The
route identity, documentation, and call sites—not the word `FALLBACK` in a variable
name—define which leg is actually scheduled.

## Accounting, recovery, and reuse

- Every purchase keeps its own provider, exact model, status, token, attempt, latency,
  usage-authority, and cost receipt.
- Missing provider usage is charged from conservative request/output ceilings, never zero.
- Pass-A event ids are stable by run, window, logical issue, and receipt position. The
  Grok trigger binds to its exact event id.
- Pass-B Pro event ids use the same stable settlement pattern.
- Unit artifacts land before checkpoint settlement. On restart, `accountingCalls`
  reoffers the original receipts; the checkpoint CAS treats identical replay as a no-op
  and rejects the same id with different facts.
- Reclaimed execution-view rows have zero incremental cost, while their original
  nonzero receipts remain in the artifact and are reoffered for settlement.
- Unit and completed-pass reuse validates exact parser/prompt identity, static provider
  route identity, trigger/receipt binding, and receipt schema.
- Cross-run contract reuse fingerprints every Grok/Flash/Pro model, effort, attempt,
  rate-attestation, and price field. A changed route is a miss, never an adoption.

## Grok 4.6 validation plan

### Independent authenticated no-spend catalogue cross-check

`worker-v2/tools/grok-rate-attestation-core.ts` is the only operator parser permitted to
turn an xAI catalogue result into a proposed Grok 4.6 rate receipt. It makes one fixed request:
`GET https://api.x.ai/v1/language-models/grok-4.6`, the documented full language-model schema,
with redirects rejected. It accepts only a 200 JSON
response whose exact `id`, `object`, and `owned_by` are `grok-4.6`, `model`, and `xai`; duplicate
keys, aliases, unknown price fields, malformed/non-integer prices, and oversized bodies fail
closed. xAI describes these catalogue prices as integer USD ticks per token, so the receipt
renders USD/Mtok exactly as `ticks / 10,000` (for example 12,500 ticks/token → `$1.25/Mtok`).
It preserves base, cached, image, output, raw long-context text rates, their per-field effective
fallbacks, threshold, and search price. A zero long-context text field means the corresponding
base price—not free usage. The operator receipt still names a positive threshold
`LONG_CONTEXT_COSTING_REQUIRED`, forcing an explicit runtime policy decision. The runtime now
satisfies that requirement without guessing token position: it validates both effective text
tiers and charges the maximum known input/output tier in its existing flat ledger.

The tool never sends an inference request, accepts a caller-supplied endpoint/model, logs the
key/raw response, or writes deployment configuration. It emits a sanitised JSON receipt for
review only. A future catalogue result is a separate evidence source and may replace the owner
copy only through one reviewed atomic change containing its source, timestamp, complete tiers,
derived maxima, and recomputed canonical digest.

Operator sequence (no production deployment):

```powershell
cd worker-v2
node tools/grok-rate-attestation.mjs prepare --outdir ..\.test-tmp\grok-rate-attestation-<new-id>
# Run the printed, loopback-only `wrangler dev --remote` command in one terminal.
# In another terminal, run the printed collect command; it prints one sanitised receipt.
# Stop Wrangler. After the receipt is reviewed, remove only that exact private output directory.
```

The generated temporary config names `survey-qa-v2-rate-attestation`, has no route, preview URL,
workflow, R2, assets, or production config writer, and binds only the existing `XAI_API_KEY`
Secrets Store secret. It is not a production v2 Worker deployment and it must not be used against
v1.

The owner-dashboard binding is sufficient to run the cost-capped test phase; the authenticated
catalogue call remains an independent no-spend cross-check. Benchmark Grok 4.6 serially against
the retained 4.5 baseline on the same non-blind inputs and prompts. Record:

- requirement recall and false positives;
- global-rule, ambiguity, and cross-reference completeness;
- failed/empty/truncated unit rate;
- latency distribution;
- input, reasoning/output tokens, and exact cost;
- downstream diff, source-ledger, and sealing outcomes.

Promotion requires better useful completeness without weakening deterministic authority,
coverage, or ambiguity gates. The corpus measures the models; it does not define survey
semantics.

## Executable evidence

```powershell
cd worker-v2
node tools/test.mjs PROVIDER
node tools/test.mjs "GROK COST POLICY"
node tools/mutate-provider-continuity.mjs
node tools/mutate-provider-activation.mjs
node tools/mutate-grok-cost-policy.mjs
npm.cmd run typecheck
```

The focused suite proves normal Grok+Pro with zero Flash, every eligible and ineligible
failure class, trigger-before-effect recovery, exact model/cost receipts, Pro-only pass B,
same-provider non-sealing, malformed reuse refusal, and both accounting crash windows.
The mutation harnesses deliberately remove those safeguards and require their named green
tests to turn red.

Current pricing/provider freeze evidence on the integrated local bytes: exact config/runtime
cost-policy tests **8/8**, cost-policy mutants **8/8**, provider tests **28/28**,
provider-activation mutants **12/12**, D21 pass-B wave/recovery tests **12/12**, D22 pass-A
wave/recovery tests **13/13**, W6 document-semantics tests **12/12**, and the shared-tree
TypeScript check is clean. No provider or deployment request was made by these gates.

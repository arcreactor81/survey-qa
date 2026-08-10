# Visual survey-page model evaluation — 2026-08-09

> **Historical note — superseded for operations on 10 August 2026.** This file preserves the
> original desk evaluation and early bake-off hypotheses. It is not the live deployment runbook.
> The current secret-free state, exact test evidence, security supersessions, provider matrix,
> one-call caps, and continuation protocol are in `docs/CODEX-CHECKPOINT-10AUG.md`. In particular,
> the top-level-image hypothesis, two-provider matrix, production-disabled posture, and the three
> accounting/keyspace blockers described below have since been superseded in source and tests.
> Do not deploy or make a model-selection claim from this dated note alone.

**Status:** provider desk evaluation and offline harness complete; production provider selection
remains blocked. The first measured provider attempt stopped safely with unknown accounting before
the public-fixture matrix completed.

## Measured bake-off status — safety stop, not a model result

The first live bake-off run attempted exactly one Workers AI Gemma 4 request from its six-call
matrix. The provider path returned no complete usage/cost receipt, so the durable runner recorded
the cost as **unknown**, made **no retry**, and refused to issue the remaining five calls. This is
the required behavior: unknown cost is never represented as zero and cannot create budget
headroom. The local test Worker was then stopped.

Inspection against Cloudflare's native vision example found an adapter-contract mismatch in that
attempt: the binding expects a plain text `messages` entry plus a separate top-level `image` data
URI. The attempted adapter instead used an OpenAI-style multimodal content array and requested
JSON Mode. Cloudflare's published JSON Mode supported-model list does not currently name Gemma 4.
The adapter is now corrected offline to the native text-plus-image shape and relies on the same
closed local response validator, with no `response_format` claim. Provider, cost, durable replay,
and mutation suites are green offline, but **no second paid call has been made** under the original
budget envelope. [Cloudflare native vision example](https://developers.cloudflare.com/workers-ai/guides/tutorials/llama-vision-tutorial/),
[Workers AI JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/).

Consequently this run establishes only that the purchase/accounting safety stop works. It supplies
no admissible accuracy, latency, or cost comparison and selects no provider.

## Implemented guarded path (offline-verified, production-disabled)

The production adapter matrix currently contains exactly two visual readers:

- Workers AI `@cf/google/gemma-4-26b-a4b-it`, using Cloudflare's native text-plus-image request;
- Google AI Studio `gemini-3.6-flash`, using a direct private Interaction request (or the explicitly
  configured keyless Cloudflare Gateway transport).

This is an implementation matrix, not a model-selection result. Grok, Claude, Moondream and Mistral
remain desk-evaluation candidates and were not called in the measured run. No additional paid call
was made after the single Gemma attempt described above.

Both adapters bind exact screenshot, prompt, schema and model identities; locally validate the closed
response schema; store immutable claim/outcome/observation/reconciliation/grounded artifacts; and
close a computed coverage row for every denominator entry. Direct Gemini accounting sums reported
output and thinking tokens; malformed or absent billing telemetry is `unknown`, never zero.

Visual orchestration now runs in a separate child Workflow launched only after the core report and
terminal state are durable. It is serial, replayable from immutable progress, and capped at an
unsharded 2,000-row denominator; exceeding the cap is a named pre-purchase limitation. All production
and arm configs still set `VISUAL_SHADOW_ENABLED` to exact `"false"`.

Paid enablement remains blocked by three accounting boundaries: admission does not yet durably reserve
one call plus maximum USD before the provider boundary; older extraction usage writes can fail without
closing the shared ledger; and visual settlement still mutates the post-finalization core checkpoint
rather than a visual-specific usage projection. Evaluation arms must also remain undeployed because
their configured `V2_PREFIX` values are not used by the hard-coded key builder, so they do not yet have
real R2 namespace isolation.

## Decision in one paragraph

Build the visual observation path behind a provider-neutral interface and evaluate
`gemini-3.6-flash` as the leading externally hosted primary screenshot reader. Add
`@cf/google/gemma-4-26b-a4b-it` as the leading Cloudflare-hosted primary challenger: its
documented UI/OCR capability and much lower cost make it material even though its exact survey
performance and schema reliability remain unmeasured. Evaluate
`@cf/moondream/moondream3.1-9B-A2B` as an independent spatial reader for control inventory,
pointing, bounding boxes, and OCR completeness. Reconcile both with deterministic accessibility
roles, names, states, and actions. A model observation is evidence, not a verdict: disagreement,
unreadable content, cropped content, and missing coverage must produce typed limitations instead
of a guessed answer.

> **Production gate:** no provider may be selected for production, and no provider-specific
> routing may become the default, until the candidates have completed the non-blind,
> public-fixture evaluation defined in this note and the measured result satisfies every required
> floor. Provider documentation and provider benchmarks are not substitutes for this evaluation.

The candidate comparison below began as a desk evaluation based on official provider
documentation and repository inspection. The later bake-off activity is limited to the single
attempt described above. No blind corpus, answer key, or `truth/` material was read.

## Evidence and inference convention

- **E — evidence:** a capability, limit, price, data policy, or repository fact supported directly
  by a dated official source or code in this repository.
- **I — inference:** a suitability judgment for survey screenshots. It is a hypothesis to test,
  not an established capability.

The comparison deliberately keeps these separate. In particular, a provider claiming object
detection, OCR, or multimodal reasoning does not establish correct question-option grouping,
radio/checkbox state detection, or navigation-button completeness on previously unseen survey
interfaces.

## Current repository state

- **E:** production configuration names Grok 4.5 for pass A and DeepSeek V4 Pro for pass B in
  [`worker-v2/wrangler.jsonc`](../worker-v2/wrangler.jsonc). The extraction workflow records those
  as `modelA` and `modelB` in
  [`worker-v2/src/workflow/run-workflow.ts`](../worker-v2/src/workflow/run-workflow.ts).
- **E:** the shared chat transport currently sends system and user content as plain strings. It
  does not have an image-content transport in
  [`worker-v2/src/llm/chat.ts`](../worker-v2/src/llm/chat.ts).
- **E:** `EXTRACTION_MODEL` and `JUDGE_MODEL` name `claude-sonnet-4-6`, but repository search found
  no operational extraction/judge call using those variables.
- **E:** Workers AI is configured with `WORKERSAI_ENABLED: false`; the observation verifier labels
  the model path `model-unwired` in
  [`worker-v2/src/workflow/stages/verify-observations.ts`](../worker-v2/src/workflow/stages/verify-observations.ts).
- **E:** official DeepSeek integration metadata marks V4 as not supporting images, and DeepSeek's
  own integration guidance describes it as text-only. It is not a screenshot reader.
  [DeepSeek WorkBuddy integration](https://api-docs.deepseek.com/quick_start/agent_integrations/workbuddy/),
  [DeepSeek GitHub Copilot integration](https://api-docs.deepseek.com/quick_start/agent_integrations/github_copilot).

The required implementation primitive is therefore a new typed multimodal observation interface,
not merely changing an existing model environment variable.

## Candidate comparison

Prices are current as of **2026-08-09** and come from the linked official provider pages. Token
prices are USD per million tokens unless stated otherwise.

| Candidate | Official evidence (E) | Project inference (I) | Current standard price | Version/lifecycle risk | Desk-evaluation disposition |
|---|---|---|---:|---|---|
| **Gemini 3.6 Flash** (`gemini-3.6-flash`) | Stable multimodal model; text, image, video, audio and PDF input; 1,048,576-token input context; structured output; explicit object detection, normalized `[0,1000]` bounding boxes, segmentation, and configurable media resolution. [Model](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash), [image understanding](https://ai.google.dev/gemini-api/docs/image-understanding), [structured output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output) | Best documented balance of fine-text processing, spatial grounding, schema support, and price. Semantic correctness and survey-specific UI performance remain unmeasured. | **$1.50 input / $7.50 output**; Batch/Flex **$0.75 / $3.75**. [Pricing](https://ai.google.dev/gemini-api/docs/pricing) | Stable ID; no shutdown announced as of this date. Pin the exact stable ID, not a `latest` alias. [Models](https://ai.google.dev/gemini-api/docs/models), [deprecations](https://ai.google.dev/gemini-api/docs/deprecations) | **Leading primary candidate; evaluation required.** |
| **Gemini 3.5 Flash-Lite** (`gemini-3.5-flash-lite`) | Stable, low-latency multimodal model positioned for high-volume document parsing and simple structured extraction; structured output and 1,048,576-token input context. [Model](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite), [latest-model guide](https://ai.google.dev/gemini-api/docs/latest-model) | Plausible cost-optimized first reader, but likely less reliable on dense, ambiguous, or highly spatial UI than 3.6. That comparison must be measured. | **$0.30 / $2.50**; Batch/Flex **$0.15 / $1.25**. [Pricing](https://ai.google.dev/gemini-api/docs/pricing) | Stable ID; no shutdown announced as of this date. | Cost challenger, not a default before evaluation. |
| **Workers AI Gemma 4 26B A4B** (`@cf/google/gemma-4-26b-a4b-it`) | Cloudflare-hosted vision model with a 256k context window; Cloudflare's launch note explicitly names screen/UI understanding, document/PDF parsing, charts, multilingual OCR, handwriting and variable resolutions. The native vision binding accepts text plus a separate image. The current JSON Mode supported-model list does **not** name Gemma 4, so the adapter must not attest native schema enforcement. [Model](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/), [native vision example](https://developers.cloudflare.com/workers-ai/guides/tutorials/llama-vision-tutorial/), [JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/) | The lowest-cost plausible general inventory reader already reachable through the existing Workers AI binding. Provider documentation does not establish survey option grouping or strict semantic correctness, so prompted JSON plus the closed local validator and measured bake-off remain mandatory. | **$0.10 / $0.30**. [Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) | No immutable snapshot/deprecation SLA was found for the slug; record returned model identity and monitor the catalog. | **Leading Cloudflare-hosted primary challenger; evaluation required.** |
| **Gemini 2.5 Flash** (`gemini-2.5-flash`) | Multimodal and currently priced at **$0.30 / $2.50**. [Pricing](https://ai.google.dev/gemini-api/docs/pricing) | There is no reason to start a new integration on a model already approaching shutdown. | **$0.30 / $2.50** | Official shutdown date **2026-10-16**; Google recommends Gemini 3.6 Flash. [Deprecations](https://ai.google.dev/gemini-api/docs/deprecations) | **Do not adopt.** |
| **Grok 4.5** (`grok-4.5`) | Accepts text and images, supports structured outputs, has a 500k context window, accepts PNG/JPEG images up to 20 MiB each, and exposes low/high image detail. [Model](https://docs.x.ai/developers/models/grok-4.5), [image understanding](https://docs.x.ai/developers/model-capabilities/images/understanding), [structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs) | Lowest-change visual baseline because the provider is already in the live pipeline. No current official native UI pointing/bounding-box workflow was found, so spatial reliability must not be assumed. | **$2.00 / $6.00** below 200k context; cached input **$0.30**. Grok 4.5 is not listed for Batch. [Pricing](https://docs.x.ai/developers/pricing) | xAI documents redirecting retired model slugs to replacements. Record and verify returned model identity; a redirect is a different observation, not an equivalent one. [Retirement example](https://docs.x.ai/developers/migration/may-15-retirement) | Lowest-change baseline; evaluation required. |
| **Claude Sonnet 4.6** (`claude-sonnet-4-6`) | Vision and multilingual input; official guidance for UI-component points and bounding boxes; grammar-constrained structured outputs; canonical ID is a pinned snapshot. [Model overview](https://platform.claude.com/docs/en/about-claude/models/overview), [vision coordinates](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates), [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [model IDs](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions) | Strongest documented no-new-vendor technical baseline if the already configured Anthropic credential is usable. Standard-tier image resizing may lose unusually fine detail. | **$3.00 / $15.00**. [Model overview](https://platform.claude.com/docs/en/about-claude/models/overview) | Canonical model ID pins weights/configuration for its lifetime; still record the returned model and API version. | Strong baseline, higher cost; evaluation required. |
| **Workers AI Moondream 3.1** (`@cf/moondream/moondream3.1-9B-A2B`) | Native typed `detect` and `point` tasks, bounding boxes/points, OCR, visual query, and structured output; `detect` supports up to 500 objects. [Cloudflare model card](https://developers.cloudflare.com/ai/models/%40cf/moondream/moondream3.1-9B-A2B/), [provider model card](https://moondream.ai/p/models) | Architecturally independent, cheap spatial/OCR observation is more valuable than a second general model making a correlated prose judgment. No official multilingual UI-OCR guarantee was found, so it must not be the sole reader. | **$0.30 / $1.00**. Workers AI platform usage is billed in addition according to its pricing rules. [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) | Exact model ID includes 3.1, but no immutable-snapshot or deprecation SLA was found. Record model identity and monitor the catalog. | **Preferred independent spatial reader; evaluation required.** |
| **Mistral Large 3** (`mistral-large-2512`) | General-purpose multimodal model with structured outputs and a date-pinned model ID. [Model overview](https://docs.mistral.ai/models/overview), [selection guide](https://docs.mistral.ai/models/model-selection-guide), [vision](https://docs.mistral.ai/studio-api/conversations/vision) | Viable low-cost challenger, but the official material is less explicit about UI pointing/grounding than Gemini, Claude, or Moondream. | **$0.50 / $1.50**; Batch is advertised at 50% discount. [Selection guide](https://docs.mistral.ai/models/model-selection-guide), [pricing](https://mistral.ai/pricing/) | Date-pinned ID is preferable to an alias; Mistral publishes deprecations and replacements, which must be monitored. | Optional challenger, not the leading integration. |
| **Mistral OCR4** | OCR blocks with bounding boxes, structure labels, reading order, word/page confidence, complex layouts, and 40+ languages; accepts images and documents. [OCR4](https://docs.mistral.ai/studio-api/document-processing/basic_ocr), [annotations](https://docs.mistral.ai/studio-api/document-processing/annotations) | Useful conditional reader for multilingual text and layout completeness. Documentation does not establish reliable checkbox/radio state, navigation semantics, or question-option relationships. | **$4 / 1,000 pages**; Document AI annotations **$5 / 1,000 pages**. [Pricing](https://mistral.ai/pricing/api/) | Service/model version must be recorded; page-level pricing differs from token models. | Conditional OCR audit, not primary UI understanding. |
| **DeepSeek V4 Pro** | Text/JSON model with a 1M context window. [Pricing](https://api-docs.deepseek.com/quick_start/pricing) | Cannot observe screenshot pixels. It may remain a document-text reader but is ineligible for visual extraction. | **$0.435 / $0.87** | Not applicable to visual-provider selection. | **Exclude from screenshot evaluation.** |

### Representative real-time cost scenario

For comparability only, assume one 1440×900 screenshot, approximately 2,000 input tokens including
the prompt/schema and 500 output tokens, across a ten-screen run. Gemini's documented tiling makes
the input estimate plausible: an example 960×540 image becomes six 258-token tiles. Other
providers do not publish directly comparable image-token formulae, so this is a budget scenario,
not a billing forecast.

| Candidate | Estimated per screen | Estimated ten-screen run |
|---|---:|---:|
| Gemini 3.6 Flash | $0.00675 | **$0.0675** |
| Gemini 3.5 Flash-Lite | $0.00185 | **$0.0185** |
| Workers AI Gemma 4 26B A4B | $0.00035 | **$0.0035** |
| Grok 4.5 | $0.00700 | **$0.0700** |
| Claude Sonnet 4.6 | $0.01350 | **$0.1350** |
| Workers AI Moondream 3.1 | $0.00110 | **$0.0110** |
| Mistral Large 3 | $0.00175 | **$0.0175** |
| Mistral OCR4 | $0.00400/page | **$0.0400** |

These values exclude browser execution, storage, Worker/Workflow usage, retries, and any gateway
credit surcharge. Cloudflare Unified Billing currently adds a 5% fee when inference is paid with
AI Gateway credits. [AI Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/),
[Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).

There is no defensible provider latency ranking without measurements from the deployed Worker
region. The evaluation must report p50/p95 latency. Batch/Flex prices are appropriate for offline
replay, not the interactive page-state loop. Prompt caching is unlikely to dominate a workload in
which each screenshot is different; cache typed observations by screenshot content hash only when
the privacy and invalidation rules are explicit.

## Material Grok ledger mismatch (corrected 2026-08-09)

The desk review found production configuration declaring:

```json
"GROK_MODEL": "grok-4.5",
"GROK_INPUT_USD_PER_MTOK": "1.25",
"GROK_OUTPUT_USD_PER_MTOK": "2.50"
```

xAI's official Grok 4.5 price on 2026-08-09 is **$2.00 input / $6.00 output** per million tokens
for requests below 200k context. The old ledger therefore understated both rates. The explicit
Grok 4.5 rates in the main and arm Wrangler configurations were corrected to `$2.00 / $6.00` on
2026-08-09. The fallback in
[`worker-v2/src/llm/grok.ts`](../worker-v2/src/llm/grok.ts) remains `$1.25 / $2.50` because its
fallback model is Grok 4.3, whose published short-context rates differ from Grok 4.5. Requests at
or above xAI's 200k-token long-context threshold still require a separate metering rule before
their cost attestations can be trusted.

## Proposed observation architecture

```text
rendered screenshot ──► primary visual reader ──────────┐
                                                       │
rendered screenshot ──► independent spatial reader ────┼─► deterministic reconciliation
                                                       │
page accessibility ──► roles, names, states, actions ──┘
                                  │
                    disagreement / unreadable / missing
                                  ▼
                         named typed limitation
```

The primary reader should emit a schema containing at least:

- screenshot hash, viewport, device-pixel ratio, capture bounds, model ID, prompt version, schema
  version, and media-resolution setting;
- every visible question block with exact visible text and bounding box;
- every visible option with label, mark appearance, bounding box, and its proposed visual question
  grouping; it must not infer semantic checked/disabled state from pixels;
- every visible control with label, appearance-only class/state, and bounding box; semantic role,
  actionability, enabled/disabled, required, and selected state belong to the independent
  accessibility/action channel;
- overlays, modals, validation messages, required markers, progress indicators, and visibly
  clipped/scrollable regions;
- per-field confidence plus explicit `unreadable`, `cropped`, `ambiguous_grouping`,
  `unsupported_language`, and `possible_omission` limitations;
- reported token use, provider request/log ID, latency, and calculated cost.

Moondream should contribute native point/detect/OCR observations rather than a second free-form
verdict. Accessibility data remains the authoritative channel for actionable role/state where it
is present. A visual/accessibility conflict is recorded as a divergence. No majority vote or
fallback may silently turn disagreement into certainty.

## Privacy, retention, logging, and regional constraints

1. **Use paid provider tiers only for survey screenshots.** Google says paid Gemini API prompts
   and responses are not used to improve products, while unpaid-service content may be used and
   human-reviewed. Paid content may be processed transiently or cached where Google or its agents
   operate, so the Gemini Developer API does not provide a hard regional guarantee suitable for
   every customer. [Gemini API terms](https://ai.google.dev/gemini-api/terms).
2. **Disable AI Gateway payload logging for visual requests.** Cloudflare AI Gateway logging is
   enabled by default and can contain prompts and responses. Send
   `cf-aig-collect-log-payload: false` for screenshot requests and retain metadata only; do not
   place screenshots or extracted respondent data in log metadata.
   [AI Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/).
3. **Do not use response caching by default.** Gateway caching matches identical requests, offers
   little value for changing page states, and increases the number of systems retaining sensitive
   observations. If caching is justified later, key an encrypted internal observation by screenshot
   hash, state/capture metadata, model, prompt, and schema version, with an explicit TTL.
   [AI Gateway caching](https://developers.cloudflare.com/ai-gateway/features/caching/).
4. **Preserve provider lineage through the gateway.** Google AI Studio, xAI, and Mistral have
   provider integrations in AI Gateway. Use provider-native requests where necessary to retain
   image-resolution and structured-output semantics. Never allow dynamic routing or fallback to
   replace a model silently; record the provider and returned model for every observation.
   [AI Gateway providers](https://developers.cloudflare.com/ai-gateway/usage/providers/).
5. **xAI:** API input/output is not used for training without explicit permission. Standard API
   retention is 30 days; zero-data-retention mode is available for eligible endpoints and disables
   some stateful features. [xAI security](https://docs.x.ai/developers/faq/security).
6. **Workers AI:** Cloudflare states Customer Content is not used for model training or service
   improvement without consent and is not stored unless the customer explicitly uses a storage
   service. [Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/).
7. **Mistral:** standard stateless API input/output is retained for a rolling 30 days unless ZDR is
   enabled; ZDR is available for Scale stateless API use and is incompatible with some stateful or
   batch functionality. Mistral states Scale data is not used for training and serves the API from
   EU data centers by default, with a US endpoint available.
   [Privacy policy](https://legal.mistral.ai/terms/privacy-policy),
   [ZDR](https://help.mistral.ai/en/articles/347612-can-i-activate-zero-data-retention-zdr),
   [training](https://help.mistral.ai/en/articles/347617-do-you-use-my-user-data-to-train-your-artificial-intelligence-models),
   [data location](https://help.mistral.ai/en/articles/347629-where-do-you-store-my-data-or-my-organization-s-data).
8. **No screenshot should be publicly addressable solely to satisfy a provider image-URL API.**
   Use inline encrypted transport or a narrowly scoped, short-lived signed URL only when required.

## Required non-blind public-fixture evaluation

### Fixture boundary and composition

The evaluation must use public or purpose-built non-blind fixtures. It must not inspect or derive
fixtures from `test-suite/blind/**`, answer keys, or `truth/`. At minimum, the evaluation set must
contain:

- **60 distinct rendered page states**, not 60 crops of one template;
- at least **six unrelated rendering families**: native HTML controls, ARIA/custom controls,
  canvas/SVG controls, matrix/grid survey, multi-question page, and modal/overlay interaction;
- desktop and mobile viewports, at least two device-pixel ratios, and both short and scrollable
  screens;
- at least **12 multilingual states** spanning Latin, CJK, Indic, and right-to-left scripts, with
  each script stratum reported separately rather than hidden in an aggregate;
- checked/unchecked, selected/unselected, enabled/disabled, required/optional, validation-error,
  and focus/hover visual states;
- exact human-authored annotations for visible text, question-option relationships, control roles
  and states, action controls, bounding boxes, cropped regions, and genuine ambiguity.

The fixture set is a measurement instrument, not a specification. Passing it does not authorize
platform-specific heuristics in the core.

### Exact metrics and required floors

Report every metric per fixture family, viewport class, and language/script stratum as well as
micro/macro totals. A pooled score cannot hide a failing stratum.

| Metric | Exact computation | Required floor before production selection |
|---|---|---:|
| Raw schema validity | Responses accepted by the versioned JSON Schema before repair ÷ total responses | **≥ 99.5%** |
| Bounded-retry schema validity | Responses accepted after at most one declared retry ÷ total responses; refusals/truncations count as failures | **100%**, with every retry reported |
| Visible text character accuracy | `1 - character_edit_distance / reference_character_count`, Unicode-normalized without deleting punctuation or answer markers | **≥ 99.5% in every script stratum** |
| Visible text block recall | Annotated visible text blocks matched to an output block at character accuracy ≥ 0.98 ÷ annotated blocks | **≥ 99.0% in every stratum** |
| Control inventory precision/recall | One-to-one match by role plus bbox overlap; report both precision and recall | **≥ 99.0% each** |
| Question-option grouping | Macro F1 over option-to-question edges; repeated labels remain distinct instances | **≥ 98.0% in every fixture family** |
| Control role accuracy | Correct radio/checkbox/select/text/button/link/matrix-cell role ÷ matched controls | **≥ 99.0%** |
| Control state accuracy | Exact match for selected/checked, disabled, required, visible, and validation-error state; report each state separately | **≥ 99.0% for each state** |
| Navigation/action recall | Annotated visible next/back/submit/save/cancel/continue action controls recovered ÷ annotated action controls | **100%**; any miss blocks selection |
| Navigation/action precision | Correctly classified action controls ÷ predicted action controls | **≥ 99.0%** |
| Bounding-box quality | IoU over one-to-one matched visible blocks/controls | **median ≥ 0.85 and 10th percentile ≥ 0.65** |
| Ambiguity calibration | Truly ambiguous fixtures emitted as a named limitation ÷ annotated ambiguous fixtures | **100% recall**, with false limitation rate **≤ 5%** |
| Crop/unreadable detection | Intentionally cropped or unreadable regions reported ÷ such regions | **100% recall** |
| Silent-omission rate | Annotated visible items absent without a named page/item limitation ÷ annotated visible items | **0%** |
| Accessibility divergence recall | Injected visual/accessibility conflicts emitted as divergences ÷ injected conflicts | **100%** |
| Latency | End-to-end provider p50, p95, and maximum from the deployed Worker region, excluding browser capture | Reported; operating budget must be declared before the run and then met |
| Cost | Provider-reported input/output units, retries, and total USD per page and per run, reconciled to the ledger | **100% of calls accounted for**; operating budget must be declared before the run and then met |

The 100% floors apply to deliberately safety-critical finite cases: navigation completeness,
unreadable/cropped reporting, divergence detection, and silent omissions. If the corpus is too
small for those floors to be meaningful, expand it; do not weaken the check or claim success over
an empty denominator.

### Required negative and mutation fixtures

Each negative must be present at least twice in visually unrelated fixture families. The expected
failure mode is part of the fixture annotation.

| Negative/mutation | Required observable behavior |
|---|---|
| Bottom of page and action button intentionally cropped | Emit `cropped`; do not invent a Next/Submit button; crop recall gate fails if omitted. |
| Tiny low-contrast option or footnote | Transcribe it or emit `unreadable` with its region; never silently shorten the list. |
| Same option label repeated under two adjacent questions | Preserve two instances and attach each to the correct question. |
| Two-column layout whose visual reading order differs from DOM order | Recover visual grouping and record divergence if accessibility order conflicts. |
| Matrix/grid with shared scale labels | Associate row prompts and column choices without multiplying, dropping, or flattening relationships. |
| Selected versus unselected custom radio/checkbox differing only by a subtle fill/check mark | Report exact state or a named uncertainty; a confident wrong state fails. |
| Disabled control visually similar to enabled control | Report disabled state or explicit state ambiguity. |
| Icon-only Next/Back button | Detect the action from visible UI plus accessibility evidence; do not hallucinate a text label. |
| Progress dots, carousel arrows, decorative pills, or step labels resembling options/buttons | Do not classify decoration as an answer or survey submission action. |
| Sticky footer overlapping the last option | Report occlusion and preserve both footer actions and any readable option content. |
| Validation tooltip/modal/consent overlay obscuring the questionnaire | Extract the overlay as the active visible layer and mark obscured content, rather than treating covered controls as actionable. |
| Conditional option revealed after a prior response | Treat before/after captures as distinct states and do not leak items across screenshot hashes. |
| Visible CSS pseudo-element text absent from DOM/accessibility | Visual reader must recover it and reconciliation must report the source divergence. |
| Hidden/honeypot DOM element absent from the screenshot | Visual reader must not emit it; accessibility reconciliation must mark hidden/non-visible evidence. |
| Rendered label intentionally differs from accessibility name | Preserve both observations and emit a divergence; do not choose one silently. |
| RTL, CJK, Indic, and mixed-language label/option layouts | Preserve characters, reading order, grouping, and direction within the per-script floors. |
| Canvas/SVG-drawn custom controls | Detect visually or emit a named unsupported-control limitation; absence without limitation fails. |
| Browser zoom, DPR change, and CSS transform | Return boxes in the declared screenshot coordinate system; coordinate conversion must remain correct. |
| Deliberately blurred or corrupted screenshot | Emit page-level unreadable/insufficient status; do not return a complete confident inventory. |
| Model response with one observation deleted by the mutation harness | Coverage/silent-omission gate must fail. |
| Model response with two option-to-question edges swapped | Grouping gate must fail. |
| Model response with action label changed or a button removed | Navigation gate must fail. |
| Model response with all boxes shifted/scaled | Bounding-box gate must fail. |
| Model response marked `complete` while containing an unreadable placeholder | Completeness/limitation consistency gate must fail. |
| Empty fixture set or empty language/control stratum | Evaluation must fail closed; a zero denominator is not a pass. |

At least one committed mutation test must demonstrate that each production gate actually fails.
The evaluation output must list uncovered combinations explicitly.

## Selection rule after evaluation

1. Freeze screenshot fixtures, annotations, prompt, schema, model IDs, resolution settings, and
   operating latency/cost budgets before the scored run.
2. Run every eligible candidate on the same captures. Retries and refusals count and are priced.
3. Reject any candidate that misses any required floor in any required stratum. Do not compensate
   for a safety-critical failure with a better aggregate score or lower price.
4. Among candidates that clear every floor, select the primary on measured correctness first,
   then p95 latency, then total cost. Publish the complete per-stratum result.
5. Select an independent spatial reader only if it measurably increases omission/divergence
   detection on negatives without violating latency, cost, and privacy budgets. Independence is
   not assumed merely because a model has a different name.
6. If no candidate clears every floor, production selection remains blocked. Improve capture,
   schema, prompts, or the architecture and rerun; do not lower the bar post hoc.

Until that process is complete, **Gemini 3.6 Flash, Workers AI Gemma 4, and Moondream 3.1 are
evaluation candidates, not production selections**. Grok 4.5 and Claude Sonnet 4.6 are required
baselines, not presumed losers. The no-new-model baseline is Grok 4.5 plus deterministic
accessibility reconciliation; Claude Sonnet 4.6 is the stronger documented no-new-vendor visual
baseline if its configured credential and data terms are suitable.

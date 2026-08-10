# Liquid AI foundation models — fit assessment for survey-qa

**Purpose:** decision aid, not a survey. Research only; nothing deployed or run. Verified 2026-08-08.
**Framing check:** confirmed. Liquid AI builds the LFM (Liquid Foundation Model) family — small parameter counts,
CPU/edge efficiency, on-device deployment — explicitly *not* datacentre-scale inference. Their own materials,
Hugging Face, and third-party press are consistent on this positioning.

---

## 1. Current lineup

| Model | Size | Modality | Released | Notes |
|---|---|---|---|---|
| **LFM2.5-2.6B** | 2.6B | Text, agentic | **2026-08-06** (primary: HF card) | 131,072-token context (primary), tool calling, license tag `lfm1.0` |
| LFM2.5-1.2B (Base / Instruct / Thinking) | 1.2B | Text | 2026 | Thinking variant does dynamic reasoning traces |
| LFM2.5-350M / -230M | 350M / 230M | Text | 2026 (230M: ~06-27 per press) | Liquid itself does not recommend these for reasoning-heavy work |
| LFM2.5-8B-A1B | 8B total / ~1B active | Text, MoE | 2026 | Also referenced elsewhere as "LFM2-MoE 8.3B/1.5B-active" |
| LFM2.5-VL-450M / -VL-1.6B | 450M / 1.6B | Vision+text | 2026 | Ships with browser demo path (§3) |
| LFM2.5-Audio-1.5B (+ JP variant) | 1.5B | Audio+text | 2026 | End-to-end ASR/TTS/voice chat |
| LFM2.5-Encoder / -Embedding / -ColBERT (350M/230M) | ≤350M | Retrieval | 2026 | Embeddings/reranking, multilingual |
| LFM2-24B-A2B | 24B | Text | ~2026-02-25 (press) | Larger, cloud/AI-PC-class; AA Index score 5 (median 6 among comparable open-weight models, see §4) |
| Nano/task models (Math, PII-Extract-JP, EN↔JP MT, transcript) | 350M–2.6B | Task-specific | 2026 | Narrow, fine-tuned single-purpose variants |
| Original LFM/LFM2 generation | 350M–40B (incl. MoE) | Text | 2024–2025 | Superseded by LFM2.5; exact dates not re-verified here |

Primary sources: `liquid.ai/models`, `docs.liquid.ai/lfm/models/complete-library`, Hugging Face `LiquidAI` org (160 repos), HF model card for LFM2.5-2.6B. Secondary/press dates (MarkTechPost, VentureBeat) are marked; an SEO-aggregator claim of "LFM2 released Feb 2025, 350M/700M/1.2B/3B" conflicts with the primary catalog and is **not used**.

## 2. Architecture claim — verified as: hybrid, not pure transformer

Confirmed via Liquid's technical blog and independent write-ups (MarkTechPost): LFM2 blocks are **Linear Input-Varying (LIV) systems** — gated short convolutions — mixed with a minority of grouped-query attention blocks (e.g. 10 conv blocks : 6 attention blocks in the original LFM2). Conv blocks carry no KV cache; only the attention blocks do, at reduced size versus a same-size pure transformer. This is a real, technical (not just marketing) architecture difference.

**What it buys, per Liquid's own claims (not independently re-benchmarked here):** lower memory footprint at long context (smaller KV cache), faster CPU prefill/decode ("2x faster decode/prefill than Qwen3 on CPU" — **Liquid-reported**), and target hardware is embedded SoC CPU, not GPU cluster. This is consistent with — and the mechanical reason for — their edge/on-device pitch.

## 3. Where it can actually run — three paths, checked independently

| Path | Verdict | Evidence |
|---|---|---|
| **Cloudflare Workers AI catalog** | **No.** | Live-fetched `developers.cloudflare.com/workers-ai/models/` today: 81 models, 28 organizations (Meta, DeepSeek, Google, Mistral, Qwen, Moonshot, Zhipu, IBM, NVIDIA, …) — **no Liquid AI entry.** This repo's own Aug 1 catalog pull (`docs/workers-ai-research.md`, 61 models, 13 lineages) independently agrees: no Liquid lineage then either. |
| **Inside a Cloudflare Worker directly (WASM/self-hosted)** | **No, on Cloudflare's own limits.** | Cloudflare's Workers limits doc: **128 MB memory per isolate, including WASM allocations, for the whole isolate** — weights, runtime, KV cache, and request handling all share that budget. The smallest package size-verified here (LFM2.5-350M, Q4 ONNX, ~276 MB on disk — primary: the model's own HF card) already exceeds it alone. Liquid's actual smallest model, LFM2.5-230M, would quantize smaller (not size-verified here), but the ceiling covers everything in the isolate, not just weights — a ~150–180 MB-class download still leaves no room for a runtime and a request. There is also no WebGPU surface inside a Worker's V8 isolate; that API only exists in a browser window. Not a quality question — a hard platform ceiling. |
| **End user's browser via WebGPU** | **Yes — real, documented, first-party.** | See §4. |
| Self-hosted GPU/CPU server | Yes, standard | `transformers`, `vLLM`, `SGLang`, `llama.cpp`, `MLX` all listed as supported runtimes on model cards. |
| Liquid-operated hosted API | **Unverified as a first-party service.** | `liquid.ai/pricing` (fetched directly) describes only the **open-weights self-host license** (free under $10M company revenue, else contact sales) — no metered per-token API is listed on Liquid's own site. A secondary aggregator (pricepertoken.com) lists "Liquid AI API" $/M-token rates; this most plausibly reflects third-party rehosting (OpenRouter/Together-style), not a Liquid-run endpoint. Do not treat that number as Liquid's own pricing. |

## 4. The browser/WebGPU path — the decisive alternative framing

**The owner's premise is right, and it's a real path, not a hope.** Liquid's own Hugging Face org (`LiquidAI/*-ONNX`, e.g. `LFM2.5-350M-ONNX`, `LFM2.5-1.2B-Instruct-ONNX`, `LFM2.5-VL-1.6B-ONNX`, even `LFM2-24B-A2B-ONNX`) ships **first-party ONNX exports whose own model card includes a working `@huggingface/transformers` + `onnxruntime-web/webgpu` browser code sample** (fetched and confirmed on `LFM2.5-350M-ONNX`). That is "documented and supported," not a one-off community demo — though community demos (a Japanese 1.2B chat page, an 8.3B LFM2-MoE running client-side, live webcam captioning with LFM2.5-VL that survives disabling Wi-Fi) independently corroborate that it works in practice.

**Cost to the user (primary numbers from the LFM2.5-350M-ONNX card):**
- Download size scales with quantization: FP32/FP16 ≈ 692 MB, Q8 ≈ 604 MB, Q4F32 ≈ 459 MB, **Q4 ≈ 276 MB** — this is the *smallest* text model; 1.2B and vision variants are larger (VL-1.6B reported 1.8–3.5 GB across quant/vision combinations by a secondary source, unverified first-party).
- First load = one download, then browser-cached; subsequent loads and inference are offline-capable (independently reported: disabling Wi-Fi mid-session doesn't interrupt a running demo).
- VRAM/RAM: no official minimum published; scales with the file sizes above, run inside the GPU memory WebGPU exposes to the tab.
- **No-WebGPU fallback:** `transformers.js` auto-detects and falls back to WASM+SIMD on CPU — a documented 10–100× slowdown, not a hard failure. WebGPU itself now ships by default in Chrome, Firefox, Safari (macOS/iOS 26+), and Edge (per web.dev, late 2025) — the realistic remaining no-WebGPU population is old GPUs (pre-2020) and **locked-down corporate/managed browsers**, which is exactly the device class survey-qa's own market-research users are likely to be on. If a browser policy blocks WASM too, there is no further fallback — that residual case is real and unmitigated by anything Liquid ships.

**Throughput:** the only numbers found are secondary/blogger-reported (1,400 tok/s on an M4 Max, 200–800 tok/s on mid-range GPUs, for the 230M model) — **not independently verified, and not measured on the tiny-classification-call shape** (thousands of short prompts, few output tokens) that actually matters here. Per-call latency at that shape is unpublished; would need a spike.

**Quality for the two specific narrow tasks (short-label equivalence; screen-to-50-stems matching):** **no benchmark exists for either, from Liquid or anyone else.** The closest proxies: Artificial Analysis Intelligence Index scores LFM2-8B-A1B at 1 and LFM2-24B-A2B at 5, both **below** the ~6 median of comparable open-weight models (independent, primary-fetched) — a general-capability signal that argues for caution. Against that, LFM2.5-2.6B's own reported instruction-following scores (Multi-IF 80.07, IFStruct 85.49 — ahead of a 9B Qwen comparator, **Liquid-reported, press-relayed, not independently reproduced**) suggest unusual strength, for its size, at doing exactly what a strict prompt says and returning a short clean answer, which is the right skill shape for constrained classification. This is inference from adjacent benchmarks, not a direct measurement — **verdict: unverified, a spike is required before trusting this even as a non-authoritative suggestion.**

## 5. Confirming the owner's verification-path reasoning

**Confirmed, on three independent legs — client-side inference cannot serve the verification path itself:**
1. Liquid isn't in the Workers AI catalog the verification path already runs on (§3).
2. Even bypassing the catalog, no Worker can host a Liquid model directly — 128 MB isolate ceiling, no WebGPU surface in the Workers runtime (§3).
3. The headless walk runs inside Cloudflare's network with no user present — there is no end-user browser tab to hand inference to during the walk, and even if there were, the architecture rule (a model emits a typed *observation*, never a *verdict*; the server re-reads and re-hashes the evidence) means a client-supplied number could never enter the verdict path anyway — the untrusted-browser problem, not just a missing-GPU problem.

All three would independently rule it out on their own; together they're conclusive.

## 6. Where the browser path DOES plausibly fit — two roles, not the verification path

- **Pre-flight, before a run.** Plausible and the privacy claim is genuine and rare: a Q4 LFM2.5 model (350M–1.2B) could give a free, instant, client-side "roughly how many questions, does this look like a questionnaire" scan before committing $0.15/~11 min to the real server run — and the document never leaves the browser. This never touches the verdict path (it's a pre-run UX gate the user can ignore), so it fits the architecture doctrine trivially. Quality for even this looser task is unmeasured; treat as a spike, not a shipped feature.
- **Report-side assistance, after a run.** Also plausible, lower-risk: helping a user work through the ~189 requirements / "could not decide" items interactively, explicitly labeled a suggestion to a human, never evidence — exactly what the typed-observation-never-a-verdict rule already permits, at zero marginal cost and no round trip. This role is more open-ended than jobs (a)/(b)/(c) (closer to chat-over-document), so the 1.2B–2.6B instruct tier is the realistic floor — Liquid's own guidance says the 230M model isn't meant for reasoning-heavy work.

## 7. Licensing and cost

**LFM Open License** (current models tagged `lfm1.0`, fetched from `liquid.ai/lfm-license`): free commercial use, modification, and distribution — **until your company's annual revenue reaches $10,000,000 USD**, at which point you must contact Liquid for a commercial agreement. No copyleft; fine-tunes stay yours. Research/education/nonprofit use is unrestricted regardless of revenue. No first-party metered hosted API confirmed (§3) — cost is compute you provide (self-host) or a browser you don't pay for at all (client-side).

## 8. Structured output

Model cards describe **prompt-based** function calling ("Pythonic" or JSON-style calls, selected via the system prompt) — not confirmed grammar-constrained decoding in the OSS serving stacks (`transformers`/`vLLM`/`llama.cpp`/ONNX Runtime/`transformers.js`). Liquid's **LEAP native mobile SDK** does offer real constrained generation (Swift macros, schema-conformant JSON) — but that's the iOS on-device SDK, a different path from the browser/ONNX route in §4. For the two browser roles in §6 this is a non-issue (outputs are advisory, human-facing, never parsed into the pipeline) — but it means nobody should assume schema-guaranteed JSON out of a `transformers.js` deployment.

## 9. Job-by-job verdict

**(a) Semantic equivalence of rendered vs. documented labels, (b) screen-to-question binding by content, (c) wording/copy comparison** — all three are verification-path jobs: they run during the scored server-side judge pass, not in a user's open tab. Under §5, **Liquid is deployment-mismatched for all three, independent of quality** — it cannot reach the Worker or the headless walk. This is not a "maybe with more engineering" gap; it is where the model runs, full stop.

**If the goal is "cheap reliable classifier for this narrow shape," the repo's own prior research already answers it, and it isn't Liquid:** `docs/workers-ai-research.md` already benchmarked exactly this task shape on Workers AI — `qwen3-30b-a3b-fp8` at **$0.00012/verify** (11 neurons) with a correct, well-reasoned verdict, or `bge-reranker-base` at $0.00311/M as a (query, document) pair scorer for requirement-vs-observation matching, both already inside the same Worker, zero extra key, GPU-hosted by Cloudflare. That is the actually-available cheap alternative to Grok/DeepSeek for jobs (a)/(b)/(c) — not Liquid AI.

## 10. Bottom line

Liquid AI's LFM2.5 family is a real, well-differentiated small-model line (genuinely hybrid non-pure-transformer architecture, strong instruction-following for its size, first-party browser deployment via its own ONNX exports) — but it is **not in Cloudflare's Workers AI catalog, cannot fit inside a Worker's 128 MB isolate, and the untrusted-client rule means its output could never enter this system's verdict path even if it could run there** — so for jobs (a), (b), and (c) as posed (verification-path classification), the honest answer is **no**, and the cheaper alternative already sitting in this repo's own research is `qwen3-30b-a3b-fp8` on Workers AI, not Liquid. The one place Liquid genuinely fits is the owner's browser-side reframing: a documented, first-party, zero-cost, genuinely-private client-side model for **pre-flight sanity-checking before a run** and **advisory help reading a finished report** — both explicitly non-authoritative, both consistent with "a model may observe, never decide," and both currently unmeasured for quality, so treat as a spike, not a commitment.

---

**Sources used (primary unless noted):** `liquid.ai/models`, `liquid.ai/pricing`, `liquid.ai/lfm-license`, `docs.liquid.ai/lfm/models/complete-library`, Hugging Face `LiquidAI` org + `LiquidAI/LFM2.5-2.6B` and `LiquidAI/LFM2.5-350M-ONNX` model cards, `developers.cloudflare.com/workers-ai/models/` (live-fetched), `developers.cloudflare.com/workers/platform/limits/`, `huggingface.co/docs/transformers.js` WebGPU guide, `artificialanalysis.ai` (LFM2-8B-A1B, LFM2-24B-A2B pages), this repo's `docs/workers-ai-research.md`. Secondary/press (dates and un-reproduced benchmark numbers flagged inline): MarkTechPost, VentureBeat, web.dev, essamamdani.com, betterstack.com.

**Could not verify:** exact release dates for the pre-2.6B LFM2.5 models and the original 2024–2025 LFM/LFM2 generation; whether Liquid operates any first-party metered hosted API; real per-call latency/throughput for LFM2.5 on short classification-style prompts; any direct benchmark of short-label semantic-equivalence or screen-to-stem matching quality, for Liquid or any model; VRAM/RAM minimums for browser inference beyond file size as a proxy; whether the vision-model browser download sizes (1.8–3.5 GB, secondary source) are current.

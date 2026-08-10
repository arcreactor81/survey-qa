> **OWNER DECISION (1 Aug 2026): No OCR — anywhere.** Direct model ingestion covers all document paths (docx natively; scanned/image inputs via vision-capable extractors like llama-4-scout/gemma-4 if they ever appear), and extraction runs in-Worker on Cloudflare. OCR re-enters only if direct ingestion measurably drops obligations on a real scanned document. The analysis below is retained as the record of why.
> **OWNER AUTHORIZATION (9 Aug 2026): use direct visual understanding for survey-page evidence.**
> Every captured survey screen may be read from its original pixels by a vision-capable model,
> paired with the same epoch's browser accessibility and interaction evidence. This does **not**
> reverse the no-OCR decision above: there is no screenshot-to-text transcription hop. Models
> emit typed, provenance-marked observations only; deterministic predicates retain verdict
> ownership, and any ambiguous or conflicting cross-channel binding is reported as insufficient
> rather than guessed.

# OCR for Evidence & Navigation — "Baidu's unlimited OCR model" evaluated

**Status:** Desk research, 1 Aug 2026. No accounts created, no keys issued, no paid calls made.
**Prompted by:** owner remark — *"we can use baidu's unlimited ocr model"*.
**Scope:** identify what that refers to, then assess fit for (a) turning screenshot evidence into text
for text-only judge legs, and (b) navigation fallback on canvas-rendered surveys.

**Bottom line up front:** the phrase resolves to a real, excellent, MIT-licensed model — and we should
**not adopt it for either use case right now.** "Unlimited" means unlimited *document length*, not
unlimited free usage; and for our evidence path OCR would re-derive, lossily and with hallucination
risk, text the walker already captures exactly from the DOM. There is one genuinely good future fit
for it, and it is neither of the two use cases asked about (§6).

---

## 1. What "Baidu's unlimited OCR model" actually is

Three distinct things in the Baidu orbit get described as "unlimited" or "free" OCR. Only one is a
literal product name, and that is almost certainly the referent.

### 1a. `baidu/Unlimited-OCR` — the literal match ✅

| Fact | Value |
|---|---|
| Released | **22 June 2026** (paper arXiv:2606.23050, 23 Jun) |
| Size | **3B dense** (bf16 weights ≈ 6.7 GB) |
| License | **MIT** — commercial use permitted, no field-of-use restriction |
| Context | 32,768 tokens |
| Lineage | Extends **DeepSeek-OCR**; acknowledges PaddleOCR |
| Headline trick | **R-SWA** (Reference Sliding Window Attention) — constant KV cache, so memory and speed do *not* degrade as output grows |
| Capacity claim | "dozens of pages in a single forward pass" under the 32K limit |
| OmniDocBench | **93.23%** (v1.5), **93.92%** (v1.6) — SOTA at release, +6.22 over the DeepSeek-OCR baseline |
| Sub-scores | math 92.61% (vs 83.37% baseline), table structure 90.93% (vs 84.97%) |
| Serving | HF Transformers, **vLLM** (`vllm/vllm-openai:unlimited-ocr`), SGLang, ms-swift (training, 21 Jul) |
| Hosted | HF Space demo; **Baidu Cloud hosted API since 3 Jul 2026** |

**⚠️ The critical semantic point: "Unlimited" describes document length, not quota.** The repo tagline is
*"Welcome the Era of One-shot Long-horizon Parsing."* It is the *KV cache* that is unlimited — R-SWA keeps
it constant so a 40-page PDF costs the same per token as page 1. Nothing about the name promises free or
uncapped API access.

It *is* free in a different and better sense: **MIT weights, no API key, no gatekeeper, no call limits
from Baidu** — because you host it. You pay in GPU, not in tokens. That is a real and attractive
property; it is just not the property the word "unlimited" is advertising.

### 1b. Qianfan-OCR-Fast on OpenRouter `:free` — the "free tier" candidate

- `baidu/qianfan-ocr-fast:free`, released 20 Apr 2026, **66K context**, multimodal, listed at **$0 in / $0 out**.
- Base model `baidu/Qianfan-OCR`: **4B params (3.6B non-embedding), Apache-2.0**, **192 languages**,
  layout analysis with **bounding boxes + element classification**, merged/rotated tables,
  markdown + JSON + HTML output, LaTeX formulas, KIE. ~1.02 pages/sec quantized on a single A100.
- **Not unlimited.** OpenRouter's platform caps on every `:free` variant: **20 requests/minute**, and
  **50 requests/day** under $10 lifetime spend, **1,000/day** at $10+. Governed globally — extra
  accounts or keys do not raise it.
- Paid third-party routes exist (~$1.75/M tokens via ModelsLab), i.e. *more* expensive per token than
  llama-4-scout's input price.

### 1c. Puter's "Free, Unlimited Baidu ERNIE API" — a phrase trap

Puter markets a **user-pays** model: free *to the developer*, because **the end user's Puter account is
billed**. No API keys, browser-first (npm backend module also exists). For a server-side QA pipeline with
no end users to bill, this is not a funding model — it is a mismatch, and it routes client content through
a fourth party. Mentioned only because the exact words "free, unlimited, Baidu" appear there and may be
where the phrasing came from.

### 1d. Baidu AI Cloud OCR (classic REST APIs)

Nine product lines (General OCR, cards/certs, financial notes, medical bills, iOCR templates, offline SDK,
private deployment). Pricing model is **free trial quota → pay-as-you-go → prepaid packages → private
deployment**. The English product page publishes **no** quota numbers, QPS limits, or registration
requirements; obtaining them requires a sales/contact path. **No public unlimited free tier.** Treat
"free forever" claims about this family as unverified.

### 1e. ERNIE 5.0 / 5.1

Released 22 Jan 2026, natively full-modality (text/image/audio/video), 128K context, ~$0.60/M in,
~$2.10/M out via Qianfan. General multimodal, not OCR-specialised. **No free unlimited OCR endpoint found.**

### 1f. The stronger sibling nobody asked about: PaddleOCR-VL-1.6

| | Unlimited-OCR | **PaddleOCR-VL-1.6** |
|---|---|---|
| Params | 3B | **0.9B** (~959M) |
| OmniDocBench v1.6 | 93.92% | **96.33%** |
| VRAM (FP16) | ≥8 GB (12 GB comfortable) | **~2.1 GB** (~0.5 GB INT4) |
| CPU path | none practical | **GGUF → llama.cpp** ✅ |
| Strength | dozens of pages, one pass | best-in-class per page |

Released 28 May 2026 (1.5 on 29 Jan). Architecture-compatible with 1.5, zero-cost migration.
Robust to *"scanning, skew, warping, screen-photography, and complex illumination"*.
~19 s/page with flash-attention-2 at 3.3 GB VRAM; official GPU guidance is **compute capability ≥ 8.0**
(RTX 30/40/50, A10, A100) and CUDA 12.6+.

**If we ever self-host OCR, this — not Unlimited-OCR — is the better default**, unless the input is a
single very long document (§6). Benchmark figures are vendor-reported; treat the 2.4-point gap as
directional, not decisive.

### 1g. And the boring one that would actually run here: PP-OCRv5 / PP-OCRv6

Classic detect+recognise pipeline, not a VLM. **Mobile English recognition model ≈ 9.6 MB**, CPU-only,
100+ languages, English scenarios +11% over the general v5 model. PP-OCRv6 (PPLCNetV4 backbone,
tiny/small/medium tiers) adds ~+5.1% recognition / +4.6% detection over PP-OCRv5_server, faster.
No hallucination surface — it cannot invent text it did not see. **This is the only OCR in this document
that runs comfortably on the owner's current hardware.**

---

## 2. What we already have — and why it changes the answer

Two facts from the current codebase decide most of this assessment.

**Fact 1 — the walker already captures exact page text.** `src/walker.ts` captures, per page:
`captureText(page)` (rendered visible text), `captureScreenshot(page)` (full-page PNG), and
`capturePdf(page)` (a **vector** PDF rendition, so its text layer is exact, not rasterised).

**Fact 2 — no screenshot is sent to any model leg today.** Grepping `src/prompt.ts`, `src/compare.ts`,
and `src/llm/*.ts` for `image`, `image_url`, `base64`, `screenshot` returns **nothing**. All three legs
(DeepSeek / Grok / Claude) compare `capture.text` against the docx spec. Screenshots and PDFs are stored
in R2 (`src/store.ts`) as human-facing, hash-pinned evidence artifacts.

So the gap the OCR idea is reaching for is real — **screenshots are captured but never reach a judge** —
but the framing "text-only judges can't read the screenshot, so OCR it" contains a hidden assumption
worth stating: *the screenshot's text content is already available, losslessly, as `capture.text`.*

---

## 3. Use case (a) — Evidence OCR for text-only judge legs

### Verdict: ❌ **Do not adopt.** Wrong tool for the stated gap; net negative on our primary axis.

**Why.**

1. **It is a lossy re-derivation of text we already hold exactly.** OCR of a screenshot of a
   DOM-rendered page produces an approximation of `page.innerText`. We have `page.innerText`. Every
   character OCR gets right is a character we already had; every one it gets wrong is a new defect we
   invented.

2. **It inserts a generative model between the survey and the judge.** The 2026 literature is explicit
   that VLM-based OCR *"shifts the core risk from misrecognition to hallucination."* Our product's
   entire claim is *verbatim evidence with model agreement and a confidence score*. A hallucinated
   option label would surface as a defect with full audit ceremony behind it — the exact failure the
   scorer's `fx-04-fabricated-evidence` fixture exists to catch. Adding a hallucination source upstream
   of the evidence chain trades away the thing we are selling.

3. **Unlimited-OCR's documented weak spot is our exact input shape.** Its own error analysis concentrates
   on *"small text ... difficult to discern, primarily due to the use of DeepEncoder's Base mode
   (1024×1024) under multi-page conditions."* Our screenshots are `fullPage: true` — tall, dense, small
   UI type. That is where the model is weakest, in the mode multi-image requests fall back to.

4. **Bounding boxes do not solve "option missing" better than the DOM does.** Unlimited-OCR emits
   `<|det|>type [bbox]<|/det|>`; Qianfan-OCR emits layout JSON. Both give *visual* position. But the DOM
   gives us text **and** geometry (`getBoundingClientRect`) **and** semantics (input type, `name`,
   checked state, `aria-*`) — more reliable, free, already in-process. **If element positions matter for
   "option missing", extend `captureText` into a structured element capture. Do not OCR a picture of
   information we can ask for directly.**

**Where OCR would genuinely earn its place — a narrower gap than the one asked about:** cases where
**pixels and DOM disagree**. An option present in the DOM but clipped, overlapped, `opacity:0`, rendered
off-viewport, or painted into a `<canvas>`; a scale rendered as an image; stimulus text baked into a JPEG.
There the screenshot carries information `innerText` does not, and a pixel-truth-vs-DOM-truth diff is a
*new class of defect* we cannot currently detect. That is a **visual-fidelity iteration** — and note the
LLM-led architecture proposal currently lists pixel-perfect visual testing as an explicit **non-goal**.
It should be scoped deliberately, not smuggled in as an evidence-plumbing change.

**Cheaper fix for the actual gap.** If the goal is "a judge should be able to assess the screenshot",
give the screenshot to a **vision-capable panel leg** directly — `llama-4-scout` (already the #1
navigator, natively multimodal) or `@cf/moondream/moondream3.1-9B-A2B` (image-to-text, added 7 Jul 2026,
$0.30/$1.00). One hop, no transcription layer, no second failure mode, and the model that judges the
image is the model that saw the image.

---

## 4. Use case (b) — Navigation fallback on canvas surveys

### Verdict: ❌ **No meaningful gain over llama-4-scout.** Keep scout; hold OCR as a named contingency.

`llama-4-scout` measured on this project: **838 ms** schema-enforced, **1,004 ms** with a real tool array
and correct element grounding (`browser_click{ref:"r4"}`), 131K context, natively multimodal,
$0.27/$0.85 per M — and the free allocation covers ~450 tool-calling navigator steps/day at $0.

Against that, a Baidu OCR hop offers:

| Dimension | Baidu OCR | Verdict |
|---|---|---|
| **Raw dense-text accuracy** | Genuinely better — purpose-trained, gundam crop mode reads at native resolution | The one real edge, and only if scout demonstrably under-resolves |
| **Actionability** | Returns text + boxes. **Not affordances.** | ❌ Navigation needs "what is clickable and what is its ref" — OCR does not produce that; you would still need a VLM to reason over the OCR output. **Two models where one works.** |
| **Latency** | Extra network leg (cloud) or cold container (self-host) | ❌ vs 838 ms in-Worker |
| **Cost at volume** | ~$0 marginal once self-hosted | ⚖️ Irrelevant at our volume — see below |
| **UI-domain fit** | Trained on documents (OmniDocBench: papers, reports, books) | ❌ Web UI is a different distribution; PaddleOCR-VL claims screen-photography robustness, Unlimited-OCR makes no UI claim |

**Cost is not the binding constraint, so "free" buys us nothing.** Order-of-magnitude: a full-page
screenshot at ~1.5K image tokens in / ~500 tokens out on scout ≈ **$0.0008 per screenshot** → **~$0.03
for a 30-page run**. The architecture proposal's working budget is *single- to double-digit dollars per
run*. Screenshot vision is already rounding error. Replacing $0.03 with $0 while adding an integration,
a container, and a failure mode is a bad trade.

**Named trigger for revisiting:** the first survey where (i) the accessibility tree is genuinely empty
(true `<canvas>` rendering), **and** (ii) scout measurably fails to read it. Both conditions, with
evidence. Until then this is a solution shopping for a problem.

---

## 5. Integration paths, if it is ever adopted

### Path A — Cloud API (Baidu Cloud / OpenRouter `:free` / Puter)
- Callable from the Worker by plain `fetch` — mechanically the easiest; drops into the existing
  AI-Gateway-style routing next to `src/llm/*.ts`.
- **Blocked on the egress decision in §7.** Do not treat as available.
- OpenRouter `:free` adds hard caps (20 rpm / 50–1,000 per day) that a deterministic, budgeted run
  cannot depend on.

### Path B — Self-host (zero egress)
- **Not on Workers.** Workers cannot run Python or native inference. Requires a **Cloudflare Container**
  or the existing **local runner box** (`runner/claude-runner.mjs` establishes the local-runner pattern).
- Sidecar next to the browser runner, HTTP-in / JSON-out, keeps every byte of client content inside our
  own boundary.
- **Model choice for this path is PaddleOCR-VL-1.6-GGUF or PP-OCRv6 — not Unlimited-OCR** (§6, and the
  hardware reality in §8).

---

## 6. The one place Unlimited-OCR is genuinely the right tool — and it is neither use case

Its differentiator is **one-shot parsing of very long documents at constant KV cache**. Screenshots are
single pages; that capability is entirely wasted on them.

But `src/docx.ts` parses **Word** questionnaires. The moment a client hands us a **scanned or
image-only PDF questionnaire** — 40+ pages, tables of routing instructions, programmer notes — the
coverage contract's ingestion step has no path today. That is exactly what Unlimited-OCR was built for:
the whole document in one forward pass, no page-by-page stitching, no cross-page table fragmentation
(90.93% table structure), reading order preserved.

**Recommendation to raise with the owner: keep Unlimited-OCR on the roadmap as a *questionnaire
ingestion* option, not an evidence or navigation option.** That is where its unique property pays,
and — being a document, not client-response data — the sensitivity calculus in §7 is different and
likely easier.

---

## 7. Caveats to state plainly

### 7.1 Data egress — an owner decision, not a default ⚠️

Every cloud path in §5A means **client survey screenshots leave our boundary to a third party**.
Specifically:

- **Third-party disclosure.** Our policy requires clearance before evidence is shared with model
  providers. Real pharma-vendor survey content going to a **Chinese cloud provider** is a compliance
  decision for the **owner**, and must be an explicit, recorded one. It is not a default and not an
  engineering call.
- **Free tiers are the worst case, not the safe case.** OpenRouter exposes distinct toggles —
  *"Enable free endpoints that may publish prompts"* and *"Enable free endpoints that may train on
  inputs."* Free endpoints are precisely the ones where publish/train may apply, and prompts are
  forwarded to the downstream provider whose own retention defaults then govern. Zero-Data-Retention
  routing exists but is **not** the default on free variants.
- **It punches through our retention boundary.** The proposal sets redacted, private storage with 30-day
  raw evidence / 90-day report retention. Sending the same evidence to a provider that may retain or
  train on it makes that number unenforceable — we would be asserting a retention guarantee we no longer
  control.
- **Puter's user-pays route adds a fourth party** and is not usable for server-side QA regardless.
- **Self-hosting avoids all of this entirely.** Weights are MIT (Unlimited-OCR) / Apache-2.0
  (Qianfan-OCR) / open (PaddleOCR). No content leaves. This is the decisive argument for Path B if OCR
  is ever needed.

### 7.2 Reliability and ToS risk of "unlimited" tiers

- **The caps are real and low:** 20 rpm, 50/day (or 1,000/day at $10+ lifetime spend), enforced globally
  across accounts and keys.
- **Free endpoints are capacity-scavenged**: variable latency, variable availability, and withdrawable
  without notice. A run that must complete deterministically inside a time and cost budget cannot have a
  free-tier dependency on its critical path.
- **Unpublished terms**: Baidu AI Cloud's English pages publish no quota, QPS, or registration terms;
  whether international sign-up requires Chinese real-name verification or a mainland entity could not
  be confirmed from public documentation. Assume friction until proven otherwise.
- **The MIT/Apache weights carry none of this risk** — that is the asymmetry worth remembering.

---

## 8. Self-host requirements vs. the hardware we actually have

Measured on this machine, not assumed:

```
NVIDIA GeForce 940MX — 4096 MiB VRAM, driver 582.28   (Maxwell, compute capability 5.0)
Intel(R) UHD Graphics 620 — 1 GB
```

| Model | Needs | On the owner's box |
|---|---|---|
| **Unlimited-OCR (3B)** | ≥8 GB VRAM bf16 (12 GB comfortable), CUDA 12.9+, vLLM/SGLang | ❌ **No.** 4 GB is half the floor; Maxwell has no bf16 and no flash-attention, and vLLM effectively needs CC ≥ 7.0. Not marginal — not close. |
| **PaddleOCR-VL-1.6 (0.9B) GPU** | ~2.1 GB FP16, CC ≥ 8.0, CUDA 12.6+ | ❌ CC 5.0 fails the requirement even though VRAM would fit |
| **PaddleOCR-VL-1.6-GGUF** | llama.cpp, INT4 ~0.5 GB, **CPU-capable** | ✅ **Yes, CPU path.** `llama-cli -m model.gguf --mmproj mmproj.gguf --image x.png`. Expect seconds-to-tens-of-seconds per page on CPU (no published CPU benchmarks — measure before committing). |
| **PP-OCRv5/v6 mobile** | ~10–20 MB, CPU-only, pip install | ✅ **Yes, comfortably.** Fastest to stand up, no hallucination surface. |

**Cloud GPU alternative** if Unlimited-OCR specifically were required: ~$0.20–0.53/hr class for a
suitable card — which reintroduces cost and ops for a capability we established is worth ~$0.03/run.

---

## 9. Recommendation

1. **Do not add OCR to the evidence path.** It re-derives DOM text we already capture exactly, and adds
   a hallucination surface to the one artifact chain that must be trustworthy. ❌
2. **Close the real gap the right way.** Screenshots are captured but never judged. Give the screenshot
   directly to a vision-capable leg (`llama-4-scout`, or `moondream3.1` for a cheap dedicated seat)
   rather than transcribing it into text first. One hop, ~$0.03/run.
3. **Keep scout for navigation fallback.** Revisit only on a named trigger: a true canvas-rendered survey
   where the accessibility tree is empty **and** scout measurably fails. Both, with evidence.
4. **If self-hosted OCR is ever needed, the model is PaddleOCR-VL-1.6 (GGUF/CPU) or PP-OCRv6 — not
   Unlimited-OCR.** Higher benchmark (96.33% vs 93.92%), one-third the size, and the only option that
   runs on hardware we own.
5. **Raise the one real opportunity with the owner:** Unlimited-OCR as a **questionnaire-ingestion**
   path for scanned/image-only PDF questionnaires (§6). That is where its constant-KV-cache long-document
   property is uniquely valuable, and where nothing we have today competes.
6. **Any cloud OCR route stays blocked pending an explicit owner compliance decision** on sending client
   survey content to a Chinese cloud provider — with free tiers being the *highest*-risk variant, not
   the safest.

**One-line summary for the owner:** it is a real and genuinely impressive model, "unlimited" means
unlimited *page count* rather than unlimited *usage*, and our screenshots are the one input shape it
adds nothing to — but hold onto it for the day a client sends a 40-page scanned questionnaire.

---

## Sources

- [baidu/Unlimited-OCR (GitHub)](https://github.com/baidu/Unlimited-OCR) · [Hugging Face](https://huggingface.co/baidu/Unlimited-OCR) · [HF Space demo](https://huggingface.co/spaces/baidu/Unlimited-OCR)
- [Unlimited OCR Works (arXiv:2606.23050)](https://arxiv.org/pdf/2606.23050) · [vLLM recipe](https://recipes.vllm.ai/baidu/Unlimited-OCR)
- [The Decoder — Baidu's Unlimited OCR](https://the-decoder.com/baidus-unlimited-ocr-processes-dozens-of-document-pages-in-one-pass-by-treating-memory-like-human-forgetting/) · [Labellerr analysis](https://www.labellerr.com/blog/baidu-unlimited-ocr/) · [codersera local-run guide](https://codersera.com/blog/run-baidu-unlimited-ocr-locally-2026/)
- [PaddleOCR-VL-1.6 (Hugging Face)](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6) · [GGUF build](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF) · [PaddleOCR-VL-1.6 docs](https://paddlepaddle.github.io/PaddleOCR/main/en/version3.x/algorithm/PaddleOCR-VL/PaddleOCR-VL-1.6.html) · [VRAM recommender](https://www.spheron.network/tools/gpu-recommender/PaddlePaddle/PaddleOCR-VL-1.6)
- [PP-OCRv5 introduction](http://www.paddleocr.ai/main/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5.html) · [PP-OCRv5 multi-language](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/algorithm/PP-OCRv5/PP-OCRv5_multi_languages.en.md)
- [baidu/Qianfan-OCR (Hugging Face)](https://huggingface.co/baidu/Qianfan-OCR) · [MarkTechPost on Qianfan-OCR](https://www.marktechpost.com/2026/03/18/baidu-qianfan-team-releases-qianfan-ocr-a-4b-parameter-unified-document-intelligence-model/) · [Qianfan-OCR-Fast on OpenRouter](https://openrouter.ai/baidu/qianfan-ocr-fast:free)
- [OpenRouter rate limits](https://openrouter.ai/docs/api-reference/limits) · [OpenRouter provider logging policy](https://openrouter.ai/docs/guides/privacy/provider-logging) · [OpenRouter privacy policy](https://openrouter.ai/privacy)
- [Baidu AI Cloud OCR product page](https://cloud.baidu.com/en/product/ocr) · [Puter "free unlimited Baidu ERNIE API"](https://developer.puter.com/tutorials/free-unlimited-baidu-ernie-api/)
- [awesome-ocr-2026 (VLM OCR landscape)](https://github.com/WalidHadri-Iron/awesome-ocr-2026) · [LlamaIndex — best OCR software 2026](https://www.llamaindex.ai/insights/best-ocr-software)

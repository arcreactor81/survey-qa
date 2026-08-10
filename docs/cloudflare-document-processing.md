# Cloudflare document processing vs. our .docx parser

**Question asked:** can a Cloudflare capability retire `src/docx.ts`, which the robustness
corpus proved is losing real content?

**Answer: no — but not because it is worse. Workers AI `toMarkdown` scores 78/99 against
our 77/99 on the same probes, and the two failure sets barely overlap.** It fixes four
hazards we lose on and introduces three we currently survive, including one new
silent-loss class. It also cannot produce the origin labelling and coverage reporting
that `FINDINGS.md` identified as the actual lesson of the corpus. Keep ours; consider a
narrow adjunct.

Everything below was measured, not read. Method: the 20 fixtures in
`test-suite/docx-robustness/corpus/` were POSTed to the live
`POST /accounts/{id}/ai/tomarkdown` endpoint and scored with the *same* 99 probes and the
*same* `evaluate()` logic as `run-harness.mjs`, against our recorded `out/results.json`.

---

## 1. What exists (verified against the live API)

| Capability | Verdict for us |
|---|---|
| **Workers AI `env.AI.toMarkdown()`** | Real, GA, `.docx` supported. **The only viable candidate.** |
| **AI Search / AutoRAG ingestion** | Dead end — [it calls `toMarkdown` internally](https://developers.cloudflare.com/changelog/post/2026-07-08-gif-bmp-image-support/). No separate or better converter, and no way to call just the conversion step without indexing. |
| **Browser Rendering `/markdown`** | Dead end — takes a **URL or HTML**, renders in a browser, converts the *page*. There is no document-to-text path. |
| **Cloudflare repos** (`cloudflare/ai`, `workers-sdk`, `ai-utils`, templates) | Nothing. `cloudflare/ai` is SDK providers and examples; `workers-sdk` is Wrangler. Third-party projects that "extract docx on Workers" are wrappers around `toMarkdown`. No in-Worker OOXML library to lift. |
| **Markdown for Agents** | HTML only, origin-response feature. Not applicable. |

### `toMarkdown` — the verified contract

```ts
// binding — we already have `"ai": { "binding": "AI" }` in worker-v2/wrangler.jsonc
const [res] = await env.AI.toMarkdown(
  [{ name: "spec.docx", blob: new Blob([bytes]) }],
  { conversionOptions: { output: { format: "text" } } },   // 'markdown' (default) | 'text'
);
// res = { id, name, mimeType, format: 'markdown'|'text'|'error', tokens, data }
// on failure: { ..., format: 'error', error: string } — NOT a thrown exception
```

- **REST equivalent** (what I used): `POST /accounts/{id}/ai/tomarkdown`, `multipart/form-data`,
  field `files`, optional field `conversionOptions` (JSON string). Needs `ai:write`.
- **`.docx` is supported.** Live format list (`GET /accounts/{id}/ai/tomarkdown/supported`)
  returns 28 types: `.pdf`, `.docx`, `.odt`, `.xlsx/.xlsm/.xlsb/.xls/.ods/.csv/.numbers`,
  `.pptx/.ppsx/.potx/.pptm/.ppsm/.odp/.otp`, `.html/.htm/.xml`, and 7 image types.
  **`.doc` (legacy binary) is NOT supported** — confirmed, returns `"Unsupported file type"`.
- **Cost: free for us.** Docs: *"toMarkdown is free for most format conversions"*; only
  **standalone image** conversion spends neurons (object detection + a vision model).
  **Images embedded in a .docx are NOT AI-described** — verified: they emit `![alt-text]()`
  with an empty src. So a docx conversion costs **zero neurons**. The whole 20-file corpus,
  run twice, cost nothing against the 10k neurons/day free allocation.
- **Limits:** no published per-file size limit for `toMarkdown` itself (AI Search, which wraps
  it, caps items at 4 MB). Behaviour is bounded by request timeout, not a documented cap — see §4.
- **Latency: ~1.6 s median per document** (min 1.47 s, max 2.17 s on 1–11 KB fixtures).
  Our parser does the same files in **~2 ms**.

---

## 2. Head-to-head on the corpus — 99 probes, identical scoring

| | clean | silent-loss | corrupted | crash | **probes passed** |
|---|---|---|---|---|---|
| **`src/docx.ts` (ours)** | 9 | 6 | 2 | 3 | **77 / 99** |
| **`toMarkdown` `format:"text"`** | 9 | 6+1\* | 2 | 2 | **78 / 99** |
| **`toMarkdown` `format:"markdown"`** | 1 | 12+4\* | 1 | 2 | **54 / 99** |

\* one file lands in a combined `silent-loss+corruption` bucket.

**The 54/99 markdown-mode number is mostly an artifact, and it is a trap.** Markdown mode
escapes literal text — `Q4.` is emitted as `Q4\.` — which breaks every literal probe and
would break any downstream string comparison. But **text mode strips list markers**, which
is the only place auto-numbering lives (§3). So the two modes are a forced trade, and
neither is a drop-in: markdown mode needs an unescaper we would have to write.

### Hazard by hazard

| # | Hazard (FINDINGS.md rank) | Ours | `toMarkdown` | Winner |
|---|---|---|---|---|
| 1 | Word auto-numbering | evaporates silently | **recovers ordinals** as `1.` `2.` `3.` — but only in **markdown** mode, and normalises the label format: `"Q1."` → `"1."`, `"a)"` → `"1."` | **CF, partially** |
| 2 | Footnotes / endnotes | lost, **no marker at all** | **fully solved** — inline `[[1]](#footnote-1)` markers *and* the note text, endnotes too | **CF, decisively** |
| 3 | Headers / footers ("DRAFT — NOT FOR FIELD") | lost | **also lost** | tie (nobody) |
| 4 | Comments | lost | **also lost** | tie (nobody) |
| 5 | Nested tables | outer row pairing breaks (`M4 — Billing` splits from its rule) | **outer pairing correct**, but inner cells **run together with no separator**: `…(has smart meter)ask Q41 then Q42Q40 = 2…` | split |
| 6 | Images / alt text | emits an empty line | **recovers alt text**; markdown mode leaves a visible `![]()` placeholder | **CF** |
| 7 | `w:sym` glyphs | **drops them** — `"≥ 7"` → `" 7"` | **preserves** `≥`, `✓` | **CF** |
| 8 | `w:noBreakHyphen` | **drops it** — `"T-14"` → `"T14"` | **preserves** as U+2011 `T‑14` | **CF** |
| 9 | Content-control dropdown options | lost | **also lost** | tie (nobody) |
| 11 | Main part path hardcoded | **crash** on `word/document2.xml` | **resolves it**, full extraction | **CF** |
| 12 | `.doc` upload | crash, useless message | `"Unsupported file type"` — clean, but still no extraction | CF (marginally) |
| 13 | Unclosed `<w:tbl>` DoS | **17.9 s of Worker CPU** on a 98 KB upload | rejects in 2.2 s, **zero Worker CPU** | **CF** |
| 14 | Deleted paragraph mark | sentence splits | same | tie |
| 15 | Field with no cached result | silent hole | same silent hole | tie |
| — | **UTF-16LE `document.xml`** | **clean, 4/4** | **HARD FAIL** — `Invalid Word Document: [xmldom error] invalid tagName` | **OURS** |
| — | **NBSP fidelity** | **byte-exact** (U+00A0 preserved) | **silently normalises U+00A0 → U+0020** (soft hyphen and ZWSP survive) | **OURS** |
| — | **Moved text (`w:moveFrom`/`w:moveTo`)** | correct, appears once at new position | **silently DROPS the moved paragraph** — `"Q71. ROUTING: … SKIP TO Q80 and set engaged = 0."` vanishes; output reads Q70, Q72, Q73 and looks complete | **OURS, decisively** |
| — | Text box splicing | splices callout **into the middle of the host sentence** | places it after — cleaner | CF (undetected by our probes) |
| — | Table cell separator | tab (`Median LOI\t14 minutes`) | space / markdown pipes | convention clash, ours matches our probes |

**Two probe artifacts I must flag, because the raw scores mislead:**

1. **`16-fields-symbols` "Ref code T-14"** shows as a fail for *both*, but the probe expects an
   ASCII hyphen. `toMarkdown` emits the **semantically correct** U+2011; we emit the
   **corrupt** `T14`. CF is right and we are wrong, and the score says "tie".
2. **`14-legacy-word2003.doc` scores 2/2 "clean" for CF — that is a FALSE PASS.** The fixture is
   Flat WordprocessingML; `toMarkdown` routed it to its `.xml` handler and returned **the raw
   OOXML markup verbatim**, `<w:wordDocument>…` and all. The probes passed only because the
   strings appear inside `<w:t>` tags. It is passthrough, not extraction.

---

## 3. What it preserves, what it loses

**Preserves (better than us):** footnotes + endnotes with inline markers · endnote/footnote
backlinks · image alt text · symbol-font glyphs (`✓`, `≥`) · non-breaking hyphens (U+2011) ·
soft hyphens and ZWSP · curly quotes, en dashes, fractions, `°C`, `£` · run fragmentation ·
tracked-change insertions (accepted view) · text boxes (placed after the host, not spliced
into it) · alternate main-part names · auto-numbering ordinals (markdown mode only) · long
documents without truncation (14.2 KB out, no loss).

**Loses:** **headers and footers entirely** · **comments entirely** · **moved text entirely
and silently** · NBSP (normalised to a space) · content-control dropdown options · field
results with no cached value · nested-table inner cell boundaries · custom numbering label
formats (`"Q1."` → `"1."`) · UTF-16LE documents (hard error) · legacy binary `.doc` ·
**all provenance** — see below.

**The structural blocker.** `toMarkdown` returns **one flat string** with no indication of
which archive part any line came from. `FINDINGS.md`'s cross-cutting conclusion was that v2
must *"report COVERAGE … and label each extracted line with its origin so the comparison
stage can weight it"* — and specifically that an unresolved Word comment is a **proposal, not
the spec**, so emitting it as body text manufactures false discrepancies. A flat markdown
string cannot express that distinction, and `toMarkdown` drops comments and headers anyway.
This is not a gap that a wrapper can close.

---

## 4. Operational risks found by testing

- **An intermittent 120 s hang returning HTTP 524 with an HTML body.** A 2,000-table document
  timed out once at 120.2 s with `text/html`, then converted in 7.0 s and 6.1 s on two
  immediate retries. It is a **flake, not a size cliff** — but any caller doing `res.json()`
  will throw `Unexpected token '<'`. Needs an explicit timeout, a retry, and a content-type
  guard.
- **Superlinear cost in table count:** 500 tables → 1.8 s; 2,000 → 7.0 s; 5,000 → 17.1 s;
  20,000 → hard failure. Our parser does 20,000 tables in **78 ms**.
- **Errors are in-band, not thrown:** a failure arrives as `format: "error"` inside a
  `success: true` envelope. Silent-failure risk if unchecked.
- **The upside:** it burns **zero Worker CPU**. The rank-13 quadratic-scan DoS — where a 98 KB
  upload costs 17.9 s of CPU and size caps do not help — simply cannot happen, because the
  work is a subrequest. Wall-clock waiting is not CPU time on Workers.
- **New dependency:** a network round trip and a Cloudflare service in the critical path of
  every extraction, where today there is none.

---

## 5. Recommendation

**Keep our parser as the primary. Do not migrate.**

Three reasons, in order of weight:

1. **No net gain.** 78 vs 77 probes is a tie, and swapping trades four hazards we lose for
   three we currently survive — including **moved-text silent loss**, which is the worst class
   in the corpus's own taxonomy (plausible, wrong, confident) and which our parser handles
   correctly today.
2. **It cannot do the thing the corpus said matters.** Origin labelling and coverage reporting
   are impossible from a flat string, and it drops comments and headers regardless.
3. **`worker-v2/src/extract/docx-blocks.ts` already closes most of the gap.** That file — which
   I did not modify — states it reads footnotes, endnotes, comments, headers/footers with
   origin labels, emits a `[#]` placeholder for auto-numbering, recovers image alt text, uses a
   depth-counting table scan that refuses an unbalanced document, and handles Flat
   WordprocessingML. **That is ranks 1, 2, 3, 4, 5, 6, 11 and 13 — a superset of what
   `toMarkdown` would buy us, plus the provenance it cannot provide.** The in-house fix landed
   ahead of the platform capability.

**Worth considering — a narrow, optional adjunct (not a replacement).** After v2 lands, the
only things `toMarkdown` still does better are:

- **auto-numbering ordinals** — v2 emits `[#]`, CF emits a real `1.` `2.` `3.`;
- **`w:sym` glyphs and `w:noBreakHyphen`** — real corruptions (`"≥ 7"` → `" 7"`,
  `"T-14"` → `"T14"`) that v2's own header does not claim to fix;
- **a cheap second opinion** — one extra call whose text can be diffed against ours to *flag*
  divergence for review.

If taken, use `format: "markdown"` (the only mode that carries numbering), unescape it, and
treat it strictly as a **secondary signal** — never let it overwrite a labelled block, because
it will silently omit moved text and headers. Guard it with a timeout, a retry, a
content-type check, and a `format === "error"` check, and degrade to our parser on any
failure. The three unfixed-by-anyone hazards — headers/footers, comments, content-control
dropdowns — remain ours to solve; only v2 addresses them.

### Migration cost

| Path | Cost |
|---|---|
| Full replacement | **Not viable.** Loses origin labelling, coverage, comments, headers, moved text, UTF-16 support. Would regress the v2 design. |
| Narrow adjunct | ~1 day: REST/binding call, markdown unescaper, timeout + retry + content-type + `format:"error"` guards, divergence-flagging in the merge stage, and corpus regression tests. |
| Do nothing | Zero. v2 already covers more ground. |

### Bundle-size impact ("reduce dependency on local")

Measured with `esbuild --bundle --minify`:

- `src/docx.ts` alone: **4.3 KB**
- with its only dependency, `fflate`'s tree-shaken `unzipSync`: **9.7 KB**

So a *complete* replacement would remove **~9.7 KB minified** against a 3 MB Worker limit —
**negligible, and unobtainable anyway**, because `fflate` stays in the bundle for
`worker-v2/src/extract/docx-blocks.ts`. An adjunct would *add* code, not remove it.

The meaningful "less local" win is **not bundle size but CPU**: routing extraction to
`toMarkdown` moves a documented 17.9 s CPU-burn risk off our Worker entirely. If that DoS
class ever becomes the binding constraint, `toMarkdown` is the cheapest mitigation available —
but v2's depth-counting scan already claims to fix it without the network round trip.

---

## Reproduce

The measurement scripts live in the session scratchpad (`tm-run.mjs`, `dos-test.mjs`,
`scale.mjs`) and are not checked in — they only need an `ai:write` token, the account id in
`worker-v2/wrangler.jsonc`, and the existing corpus and probe manifests. No repo file was
modified to produce these numbers.

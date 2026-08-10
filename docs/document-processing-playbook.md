# Document-processing playbook — how survey-qa v2 should ingest a real questionnaire

**Status: current normative (proposed).** Nothing here is landed in code.
**Written: 2 August 2026.** Every claim traces to something that actually happened on a shipped
project — the **pa-policy-extractor** (79 real payer PDFs, graded against partial gold, shipped to
Cloudflare), **survey-qa v1** (`src/docx.ts`, deployed, and its 20-fixture robustness harness), or
this repo's own **judge** (`pipeline/judge/lib/`, independently audited three times). A fourth
source, the public **Graphify** project, is assessed in §9.

**The problem statement this answers** is [`../test-suite/docx-robustness/FINDINGS.md`](../test-suite/docx-robustness/FINDINGS.md):
20 hostile-but-realistic .docx fixtures through the production parser produced **9 clean · 6 silent
loss · 2 corrupted text · 3 crash**, and its closing line is the brief for this document —

> *every failure in this corpus was survivable except that **none of them said anything**.*

**Cloudflare-native slot:** `docs/cloudflare-document-processing.md` did not exist when §8.3's
decision criteria were written, and **landed before this was finished**. §8.3 keeps the criteria in
the order they were fixed and then reports the measured outcome against each, so the conclusion
cannot be rationalized after the fact. Headline: `toMarkdown` **78/99 vs our 77/99** — a tie with
barely-overlapping failure sets. Keep ours; narrow adjunct only.

---

## 0. The one-paragraph answer

Ingestion is not "get a string out of the file". It is: **produce a frozen, addressable view of the
document, a block index that says where every line came from, and a coverage record that names
everything we could not read** — then hand the *whole* view to the extraction passes, use the
pa-extractor's reducer machinery **not to cut the document down but to prove we mapped all of it**,
and compile its routing into **a typed graph whose traversal is the coverage denominator** (§6). The
single most expensive lesson from the PA project is one sentence in
`container/pipeline/overrides.py`: *"an all-NA extraction could equally be an extraction MISS on a
covered policy."* Applied here: **a section that yields no obligations is not a section with no
obligations.** Ingestion must be able to say which it was — and after §6, so must traversal.

---

## 1. The two precedents, side by side

| | **pa-policy-extractor** | **survey-qa v1** |
|---|---|---|
| Input | 70 payer PDFs, 3,151 pages, 5.3 M chars; no control over formatting | client `.docx` questionnaires |
| Structure source | **inferred** from a rendered page by a layout+OCR model | **declared** inside the file (OOXML) |
| Text out | Docling + Surya OCR → markdown **+** a typed `DoclingDocument` | fflate + regex over `word/document.xml` |
| Sent to the model | a **reduced** brand-focused slice (97–99 % smaller) | the whole extracted string |
| Partial failure | named in the output (`source`, `truncation`, `spans.found`) | **none** — throw, or a string |
| Provenance | separate pass, verbatim-substring guard, drops paraphrase | none |
| Where it runs | a Cloudflare **Container** (torch/Docling won't fit a Worker) | **in the Worker**, ~2 ms for a 460-paragraph doc |

Read that last row twice. The PA project spent its architecture budget on a Container because a PDF
gives you pixels and you have to *reconstruct* structure. A `.docx` gives you the structure
outright. **Almost every heavyweight decision the PA project made is a decision we get to skip** —
and the ones worth importing are all in the columns marked "none".

---

## 2. What gets text out of the file, and the fallback chain

### 2.1 What PA actually did, and in what order

**First attempt — `E:\Claude Hackathon\extract_pdfs.py`** (pure-Python, no ML):

- `pdfplumber`, `page.extract_text(x_tolerance=1.5)` — the tolerance is the column fix: PDF text is
  positioned glyphs, and the default tolerance welds adjacent columns into one line.
- `page.extract_tables()` separately, serialized as `' | '.join(cells)` under a
  `--- [TABLE 3.2] ---` banner, because a table's text via `extract_text` comes out in visual order
  and loses cell boundaries.
- Explicit `===== PAGE n =====` markers — the only page anchors the project ever had.
- A glyph normalizer for private-use/Wingdings bullets (`''`, `''`, `'•'`…) → `"- "`. Payer PDFs
  encode bullets in symbol fonts; without this they arrive as mojibake or nothing.
- **A second engine as fallback**: if pdfplumber produced `total_chars < 50`, re-run with PyMuPDF
  and *keep whichever produced more characters*.
- **A scanned-page detector**: `scanned_suspect = total_chars < 200`, written per-file to
  `pdftext_report.json`.

That report is worth its own line: **70 files, 3,151 pages, 5,318,609 chars, 0 scanned suspects.**
The corpus turned out to be entirely born-digital. The OCR path was built, was correct, and was
never load-bearing — but the *detector* was, because it is what proved that.

**What shipped — Docling + Surya OCR** (`container/pipeline/core.py:362-391`,
`notebooks/Docling_extraction_1_.ipynb`):

```python
ThreadedPdfPipelineOptions(
    do_ocr=True, ocr_model="suryaocr", allow_external_plugins=True,
    ocr_options=SuryaOcrOptions(lang=["en"]),
    do_table_structure=True,
    table_structure_options=TableStructureOptions(do_cell_matching=True),
    generate_page_images=False, generate_picture_images=False,
    accelerator_options=AcceleratorOptions(num_threads=threads, device=AcceleratorDevice.CPU),
)
```

Why Docling and not the pdfplumber path that already worked: **it emits two artifacts from one
pass.** `doc.export_to_markdown()` for the LLM, *and* a typed `DoclingDocument` whose
`iterate_items()` yields `(item, level)` tuples of `SectionHeaderItem` / `TableItem` / `ListItem`,
with `TableItem.export_to_dataframe()` giving real cells. **The reducer is built entirely on that
second artifact** — without it there is no heading strategy, no table strategy, no cross-reference
BFS. Markdown alone would not have been enough.

Handling, item by item:
- **Columns / reading order**: Docling's layout model, not our code. `do_cell_matching=True` binds
  OCR'd text to detected table cells.
- **Tables**: kept as DataFrames end-to-end; only serialized at the last moment via
  `df.to_markdown(index=False)` (reducer `get_text_between`). Structure survives the whole pipeline.
- **Headers/footers, page breaks mid-sentence**: absorbed by the layout model into reading order.
  **This is a real loss and it was never recovered**: the shipped path has *no page anchors*. The
  audit prompts had to ask for "page/section anchors **or** short quotes" (`pa_audit.js:99`) because
  the page number was gone. Note this for us — see §5.
- **Scanned pages**: `do_ocr=True` unconditionally, so scanned and digital pages take the same path.
- **Big documents**: `66156-4274314.pdf` is 441 pages / 676 k chars. It needed its own cell with
  `images_scale 2.0 → 1.5`, `ocr_batch_size 16 → 4`, `table_batch_size 1`, plus per-file
  `gc.collect()` + `torch.cuda.empty_cache()` and a resume-safe `_summary.json`. **One document
  forced a whole second code path.**
- **Cost of all this on Cloudflare**: OCR is the slow CPU stage, so `core.ocr()` caches by
  `sha256(pdf_bytes)` in a bounded LRU (`_OCR_CACHE_MAX=6`), and the reduce step is serialized under
  `_DOC_LOCK` because `doc.export_to_markdown()` mutates internal state on some Docling versions.

### 2.2 What v1 does, and why each line exists

`src/docx.ts` is 425 lines and there is not a wasted defence in it. Every one names the structure
that forced it, in the comment above it. Taking them in order:

**Run-fragment concatenation** (`extractParagraphText`, line 353). Word splits a word across runs at
any formatting boundary — spell-check state, a language tag, a rsid. `sat` + *`is`* + `fied` is
three `<w:t>` elements. The function walks the *ordered token stream* of a paragraph body and
`parts.join("")` with no separator, so fragments re-weld exactly. FINDINGS confirms
`TER|MIN|ATE → "TERMINATE"` and `1`+`8` → `"under 18"`. This is the most common real-world hazard
and the most commonly botched; it is correct here.

**Tracked changes — and this is *not* a `w:delText` lookahead.** The token alternation is:

```
<w:t(?=[\s/>])[^>]*\/> | <w:t(?=[\s>])[^>]*>([\s\S]*?)<\/w:t> | <w:tab…/> | <w:(?:br|cr)…/>
```

`w:delText` is a **different element name** and simply is not in that alternation, so deleted text
is declined *by omission*. Insertions survive because the scanner is wrapper-agnostic — `<w:ins>`
merely wraps `<w:r><w:t>`, and the run-token scan doesn't care what it is nested inside. Moved
blocks appear once because `w:moveFrom` also carries `w:delText`. So "renders the accepted final
view" is a **free consequence of two unrelated design choices, not a feature**. Three implications
we must not lose:
1. It cannot be turned off — there is no way to render the *original* view.
2. It cannot *report* that a document has tracked changes at all. A client questionnaire arriving
   mid-review is indistinguishable from a clean one. That is a coverage fact the owner would want.
3. It does not honour a **deleted paragraph mark** (FINDINGS rank 14), because that lives in
   `w:pPr/w:rPr/w:del`, not in the run stream — so a sentence splits across two lines.

**The `(?=[\s/>])` lookaheads.** Not about tracked changes: they stop `<w:t` matching `<w:tbl>`,
`<w:tc>`, `<w:tab>`, and stop `<w:p` matching `<w:pPr>`, `<w:pStyle>`, `<w:proofErr>`. Without them
a paragraph-properties block would be mistaken for a paragraph on essentially every document.

**`neutralizeTextBoxParagraphs`** (line 279). `<w:txbxContent>` is *the one place* WordprocessingML
nests paragraphs — a shape's `<w:p>` lives inside a run of an outer `<w:p>`. A lazy outer scan stops
at the **inner** `</w:p>`, which does two bad things at once: it truncates the host paragraph
(dropping every run after the box) and folds the box into that first half. The fix renames the inner
tags to `w:boxpara`, a sentinel no scanner's lookahead accepts — so the outer paragraph matches its
true close and the box's text is captured inline. Real document: a questionnaire with an
interviewer-instruction callout box mid-question. Most extractors fail this.

**`stripMarkupCompatibilityFallback`** (line 262). Word wraps a shape in `<mc:AlternateContent>`
with a DrawingML `<mc:Choice>` **and** an equivalent VML `<mc:Fallback>`, both carrying the same
text. Keep both and every text box is double-counted — which in a questionnaire means a duplicated
instruction that the comparison stage reports as a site defect. Drop the Fallback, keep the Choice.
The comment is honest about the residual: a producer binding `mc` to another prefix "keeps its
(harmless) duplicate rather than losing any text" — **it fails toward duplication, not toward
loss**, which is the right direction and is exactly the instinct §4 generalizes.

**The namespace fallback** (`detectWmlPrefix`, line 223). `w:` is a convention, not a requirement.
Scan with `w:` first because it is overwhelmingly common, and only on **zero blocks** pay for a
rescan: find the prefix actually bound to the WML main namespace — either of two URIs, transitional
*and* strict OOXML — and rebuild the syntax. Handles a default binding (`xmlns="…/main"` → prefix
`""`) too. FINDINGS confirms this works.

**The BOM / UTF-16 sniff** (`decodeDocumentXml`, line 205). Two bytes. The XML spec *requires* a BOM
on UTF-16 XML, so a two-byte sniff is not a heuristic — it is complete. Note the fallback is
deliberately weak: if the runtime lacks a UTF-16 decoder it falls back to UTF-8, and the comment
says why that is safe — "a mangled decode then surfaces via the no-paragraphs error above rather
than as a silently empty spec". **The defence is not the decoder; the defence is that failure is
loud.**

**The numeric-character-reference validity guard** (`isValidXmlChar`, line 384). `&#55296;` is a
lone surrogate; `String.fromCodePoint` would happily emit it and corrupt the string in a way that
survives JSON and reaches the model. The guard implements the XML 1.0 `Char` production exactly and
**leaves malformed references as literal text** rather than materializing them — visible garbage
beats invisible corruption.

**The refusal to return `""`** (lines 174-188). Two distinct errors, both thrown:

> *"An empty/whitespace-only document.xml carries no spec text. Returning `""` here would make every
> downstream model comparison a silent false pass ('no discrepancies'), so fail loudly instead."*

This is the most important line in the file and it is the one instinct v1 and PA agree on
completely (PA: `notebook_loader.py` raises `RuntimeError` when a `required=` name is missing, "so
we fail loudly rather than silently degrade"). **Keep it, and extend it from empty to partial.**

**Size caps.** `MAX_ARCHIVE_BYTES = 25 MB`, `MAX_DOCUMENT_XML_BYTES = 50 MB`, and — the subtle bit
— the check happens *inside the `unzipSync` filter*, because fflate allocates the output buffer from
the ZIP header's declared uncompressed size. Rejecting in the filter prevents the allocation
entirely. Only `word/document.xml` is ever inflated. The error message even lists the entry names it
saw, which is why FINDINGS could diagnose rank 11.

**Where each defence came from** (`git log -- src/docx.ts`, four commits, none of them dedicated to
this file — every defence landed inside a large batch):

| Feature | Commit | The words in the commit message |
|---|---|---|
| size caps + zip-bomb filter, namespace fallback, tables | `d36cfad` "Apply 58 adversarial-review findings" | *"docx size cap"*, *"docx zip-bomb guard"* |
| BOM / UTF-16 decode | `d36cfad` | **never named in any commit message** — `decodeDocumentXml` landed silently inside the same batch |
| namespace prefix fallback | `d36cfad` | **never named** — only in the code comment |
| surrogate / XML-char guard | `1d94dd1` | *"XML control-char rejection"* |
| refusal to return `""` | `1d94dd1` (final), `d36cfad` (comment) | *"empty-docx throws"*; the earlier comment already said *"a false pass"* |
| text boxes + `mc:Fallback` | `9f24eef` "Harden: fix 20 adversarial-audit findings" | *"docx text-box text preserved"* |
| tracked changes | **none** | never mentioned — because it was never written (see above) |

Two readings worth keeping. First, **almost every defence in this file came from an adversarial
review pass, not from a bug report** — which is the same provenance as PA's `overrides.py`. Second,
the two defences nobody thought worth naming in a commit message (BOM, namespace) are the two that
have never fired in anger; the ones that got their own clause are the ones that had.

### 2.3 The fallback chain to build

Ordered, and every step names its own failure:

1. **Triage on magic bytes before anything else.** `D0 CF 11 E0` → "Word 97-2003 binary `.doc` —
   open in Word and Save As `.docx`"; `<?xml` → "Word 2003 XML / Flat OPC"; `%PDF-` → "this is a
   PDF"; `PK\x03\x04` → continue. Four `startsWith` checks (FINDINGS fix 5). Today a `.doc` upload
   crashes with a correct-but-useless message.
2. **Resolve the main part through `_rels/.rels`**, not the hardcoded `"word/document.xml"`. A valid
   questionnaire whose main part is named otherwise is currently *rejected* (FINDINGS rank 11).
3. **Read the part set**, not the part: `document.xml`, `footnotes.xml`, `endnotes.xml`,
   `comments.xml`, `commentsExtended.xml`, `header*.xml`, `footer*.xml`, `numbering.xml`. Real files
   here carry **18–22 parts** and v1 reads **one**.
4. **Per-part decode + parse**, reusing every existing helper unchanged (§10).
5. **On zero blocks from the main part**: namespace rescan (already built), then throw. Never `""`.
6. **On a part that fails to inflate or parse**: do *not* fail the run — record it in
   `coverage.partsFailed` and continue. A corrupt `header1.xml` must not cost us the questionnaire.
7. **Cloudflare-native as an independent second opinion**, never as the silent primary — §8.3.

PA's own fallback shape is worth copying literally: `core.analyze_brand` tags its input `source` as
`"reduced" | "relevance-fallback" | "reduced-error" | "markdown-fallback"`. **Four named states, one
field.** Not a boolean, not a log line — a value in the result.

---

## 3. Structure: preserved, or explicitly declared lost

### 3.0 How little is reported today — the two facts that make this section urgent

**`extractDocxText` already computes the coverage answer and throws it away.** `docx.ts:115` pushes
every archive entry name into `entryNames` during the unzip filter — so at that moment the function
knows the archive has 18–22 parts and that it is about to read exactly one. That list is then used
**only inside an error message** (`docx.ts:146-151`). On the success path it is discarded. The
robustness harness had to recompute `parts_read_by_parser` / `parts_ignored_by_parser` externally,
because the parser will not tell you.

**And the only telemetry that survives ingestion is a character count.** The sole production caller
is `src/workflow.ts:69`; the extraction step returns `{ chars: text.length }` and nothing else. *A
character count cannot distinguish "read the whole spec" from "read 60 % of it and silently dropped
every footnote."* Meanwhile `verify.ts:70-77` still carries a `console.warn` for an empty
`specText` — unreachable since `1d94dd1` made empty throw. The one signal is dead; the one that runs
says nothing.

### 3.1 The rule

> Anything we cannot materialize becomes **a visible placeholder in the text stream** *and*
> **a counted entry in the coverage record**. Never a shorter list.

FINDINGS reaches this independently for numbering — *"If nothing else ships, emit a placeholder —
`[#] Which supplier…` — because a visible unknown is recoverable and a silent gap is not."* The PA
project shipped the same instinct as a literal string: when the window packer drops text it splices
in

```python
gap = "\n\n[... unrelated policy sections omitted ...]\n\n"
```

so the model is *told* the document is discontinuous instead of quietly reading a splice as
contiguous prose.

### 3.2 The result object

Ingestion returns this, not a string:

```ts
interface ExtractedDocument {
  view:   string;              // the frozen serialized text handed to models
  viewHash: string;            // sha256(view) — every provenance anchor is relative to this
  blocks: Block[];             // one per paragraph / table row, in view order
  coverage: Coverage;
  degradations: Degradation[]; // named, machine-readable, never just logged
}

interface Block {
  text: string;
  start: number; end: number;         // offsets into `view`
  origin: 'body' | 'footnote' | 'endnote' | 'comment' | 'header' | 'footer' | 'textbox';
  originId?: string;                  // "3", "MD", "header1"
  sourcePart: string;                 // "word/footnotes.xml"
  kind: 'paragraph' | 'tableRow' | 'listItem' | 'heading';
  level?: number;                     // heading outline level — the reducer needs this
  numberLabel?: string;               // resolved "Q7." / "a)" / "[#]" if unresolved
  cells?: { text: string; start: number; end: number }[];  // for tableRow
}

interface Coverage {
  partsPresent: string[];             // every entry name seen in the archive
  partsRead:    string[];
  partsSkipped: { part: string; reason: string }[];
  partsFailed:  { part: string; error: string }[];
  counts: { paragraphs; tableRows; footnotes; endnotes; comments; headers; footers;
            images; unresolvedNumbering; unresolvedFields; unresolvedSymbols };
  unresolved: Unresolved[];           // one entry per thing we could not read
}
```

`unresolved` is what makes the owner's sentence renderable verbatim:
*"there are 4 footnotes I could not read"* is `coverage.unresolved.filter(u => u.origin==='footnote').length`.

### 3.3 Per-construct disposition

| Construct | Disposition | Precedent |
|---|---|---|
| **Auto-numbering** (`w:numPr` + `numbering.xml`) | **Resolve.** `numId → abstractNumId → lvl`, per-`(numId, ilvl)` counter in document order, substitute into `w:lvlText`. On failure emit `[#]` and count it. | FINDINGS rank 1. Also the hard precondition for §5 — see there. |
| **Footnotes / endnotes** | Read the parts; emit inline `[footnote 3]` at the `w:footnoteReference` **and** the body text as a labelled block. Today not even the marker survives. | FINDINGS rank 2 |
| **Headers / footers** | Read; label `[header]`. Losing `"DRAFT — NOT FOR FIELD"` means QA'ing a superseded draft and reporting every difference as a site defect. | FINDINGS rank 3 |
| **Comments** | Read, label, and carry `w15:done`. **Do not merge into body text** — an unresolved comment is a *proposal*, not the spec; emitting it as body manufactures false discrepancies. Let the comparison stage weight it. | FINDINGS fix 1's design call |
| **Tables** | Keep cell boundaries. v1 already joins cells with `\t` and rows with `\n`; keep that *and* record per-cell offsets in `Block.cells` (§7 needs them). PA kept tables as DataFrames until the last moment for the same reason. | `extractTableRows`, PA `get_table_df` |
| **Nested tables / vMerge** | Depth-aware walker. `<w:tbl…>[\s\S]*?</w:tbl>` terminates on the **inner** close tag — regex cannot express nesting. One change fixes rank 5, 10 and 13 together. Interim: compare counts of `<w:tbl` and `</w:tbl>`, skip table handling if unequal. | FINDINGS fix 4 |
| **Images** | `[image: <alt text>]` or `[image: no alt text]`, counted. Today: an empty line, no placeholder, no warning. | FINDINGS rank 6 |
| **`w:sym`** | Map the known symbol fonts; unmapped → `[sym:F0B3]`, counted. `"≥ 7"` currently becomes `"7"` — the threshold direction is lost and the sentence still reads fine. | FINDINGS rank 7 |
| **`w:noBreakHyphen`** | Emit `-`. `"T-14" → "T14"` silently changes a reference code. Two-line fix. | FINDINGS rank 8 |
| **Content-control dropdowns** (`w:sdt`) | Read `w:dropDownList/w:listItem/@w:displayText`. A whole answer list vanishes today while the sentence stays intact. | FINDINGS rank 9 |
| **Fields with no cached result** | `[field: unresolved]`, counted. Silent hole today. | FINDINGS rank 15 |
| **Deleted paragraph mark** | Honour `w:pPr/w:rPr/w:del` — join the paragraphs. | FINDINGS rank 14 |
| **Page numbers** | Genuinely unavailable in `.docx` (pagination is a renderer decision). **Declare it**: our anchors are part + offset, never "page 12". Do not repeat PA's mistake of discovering this at audit time. | PA `pa_audit.js:99` |

### 3.4 Three failure tiers, taken from what PA actually does

1. **Refuse** — throw, produce nothing. Only when there is no document: bad ZIP, no main part, zero
   blocks, size cap. v1 already does this and is right. PA's analogue: missing `required=` names
   raise rather than degrade.
2. **Degrade and name the mode** — produce output, tag how. PA:
   `source="relevance-fallback"`, `truncation="alias-windowed"|"head"|null`, with `llm_input_chars`
   alongside so the reader can *see* the size the model actually got. Ours: `degradations[]` +
   `coverage.partsFailed`.
3. **Abstain and flag** — the clamp→abstain lesson (§4.4). Emptiness is reported as *unresolved*,
   never as *zero*.

**And a gate:** a run may not seal its coverage contract while `coverage.unresolved` is non-empty
and undispositioned. That is already the merged claim contract's language ("zero unexplained
normative blocks, all construct classes dispositioned") — this section is just the ingestion half of
it.

---

## 4. What broke on the PA project, and what they did about it

The reason to read this list is that **nine of these are document-shape failures, not model
failures**, and every one has a `.docx` analogue.

### 4.1 Reduction and scoping

| # | What broke | Fix | Where |
|---|---|---|---|
| 1 | **Cross-indication contamination.** One PDF covers PsO, PsA, Crohn's, UC, RA, AD. Full-document input made the model grab the wrong indication — "it's nearby and uses similar language". | The reducer exists for *this*, not only for context size. | `INTERVIEW_CHEATSHEET.md` §2 |
| 2 | **Biosimilar prefix collision.** `\bustekinumab\b` matches inside `ustekinumab-kfce` (Yesintek) and `ustekinumab-aauz` (Otulfi) — `\b` treats `-` as a boundary. A multi-drug formulary silently scoped onto the wrong drug. | `alias_in_text`: `(?<![A-Za-z0-9])` + alias + `(?![A-Za-z0-9-])` — the trailing `-` exclusion is the whole fix. | reducer cell, `alias_in_text` |
| 3 | **Structural sub-headers read as drug boundaries.** `Products Affected`, `Goal(s)`, `Length of Authorization`, `Approval Criteria`, `Renewal Criteria`, `References`, `Table 3`, `P&T`, `Effective Date`, `Notes` repeat under *every* drug. | `STRUCTURAL_HEADERS` exclusion regex, consulted at every boundary decision. | reducer, `is_structural_header` |
| 4 | **Administrative tables swamped the reduction.** NDC / GPI / HICL / AWP / WAC / J-Code / Day Supply / Package Size listings are enormous and match every keyword. | `ADMIN_TABLE_PATTERNS` skips them on **column names**; and a large non-criteria table must contain **both** the brand **and** the indication to qualify. | `find_pso_in_tables` |
| 5 | **Routing destination in the wrong column.** In 4-column routing tables, column 0 is bare `7.` and the criterion text is in **column 1** — so BFS resolved nothing. | Check column 1 too when `df.shape[1] >= 3`. | `follow_cross_references` |
| 6 | **Reducer over-reach on small docs.** On single-product policies it clipped shared TB / specialist / reauth sections that sit under **no brand heading**. | **Self-disable**: `if full_len < 100_000: return full_md`. | reducer `reduce_document` |
| 7 | **Scope collapse.** `find_brand_section` sometimes returned a <10-item span in a >200-item document. | Widen to the full document and let phase 2 search everywhere. | `reduce_document` |
| 8 | **A provably dead regex.** `PSO_PATTERNS[1] = re.compile(r'\bPsO\b')` — **case-sensitive**, against strategies B and C which search `.lower()`ed haystacks (`df.to_string().lower()`). A silent recall hole *in the graded submission*, found only by later review. | Re-compiled case-insensitive — and located **by pattern string, not index**, "so a drifted list still patches correctly". | `overrides.py` fix 1 |

### 4.2 The truncation incident — the one that matters most to us

The original scoring loop head-truncated at `MAX_CHARS = 300_000`. From the docstring of
`core._truncate_policy_text`:

> *blind head-truncation amputated the per-drug criteria modules that big payer documents keep DEEP
> in the file (observed live: a **705k-char / 90-page policy whose criteria sat at pages 45-71 →
> all-NA extraction for every brand**; the original pipeline only survived such documents because
> Gemini's 1M context never needed the cap on the extraction call).*

A **silent, total, per-document failure** that looked exactly like "this policy doesn't cover the
drug". The fix — brand-aware window packing — is worth reading as a design, because it is retrieval
done in ~40 lines with no embeddings:

- Always keep the **head** (`WINDOW_HEAD_CHARS = 40_000`): title, indication tables, global criteria
  that apply to every drug.
- Around **every** alias match, a window `[start − 5_000, end + 20_000]` — asymmetric on purpose,
  because "criteria modules FOLLOW the drug-name heading in payer documents".
- Merge overlapping intervals, assemble **in document order** (not relevance-ranked) so "the head
  first and the policy's own narrative flow" survive.
- Splice the explicit gap marker at every cut.
- Fall back to plain head truncation when the alias never appears beyond the head — "there is no
  better text to choose in that case".
- **Report the mode**: `consume_truncation_mode()` returns `None | "head" | "alias-windowed"`, and
  `meta.llm_input_chars` records what the model actually saw.

Two operational numbers that came out of running it live, both cost-shaped rather than
correctness-shaped: `~180k-token extraction calls ran 10+ minutes EACH`, and near-600 k unique packs
"ran 5-8 min and tripped timeouts" — which is why `WINDOW_PACK_BUDGET = 360_000` is *lower* than the
cap it sits under. The head fallback deliberately ignores that budget because identical head slices
are shared across brands and hit the provider's prefix cache. **Retrieval geometry and cost geometry
are the same problem.**

The invariant is even pinned by a test — `test_primary_cap_is_above_scoring_cap`.

### 4.3 The agent-driven path did the same thing by hand

Before any of that was code, `pa_workflow.js:143` told each agent:

> *If the text file is large (>1500 lines), use Grep on … for the brand, its generic name, and terms
> like "psoriasis","plaque","preferred","step","trial","tuberculosis","specialist","quantity limit",
> "reauthoriz","renewal","continuation" … then Read the windows around the hits **AND read the
> general/universal criteria block near the top**. Trace any cross-references ("Go to #","See
> Table","Section").*

Head + keyword windows + follow the graph. That is `_truncate_policy_text` and the reducer, written
in English, months earlier. When the same geometry shows up in the prompt layer *and* the code
layer, it is the shape of the problem, not a preference.

### 4.4 The lesson to import wholesale: clamp → abstain

The shipped `consistency_check` clamped a positive access score to 0 whenever the row's fields all
looked empty. `overrides.py` fix 3 replaced that:

```python
if not covered and access_score > 0:
    # ABSTAIN instead of clamping to 0: an all-NA extraction could
    # equally be an extraction MISS on a covered policy, and the model's
    # positive score was derived from the policy text itself. Keep the
    # score and flag the row for human review.
    return access_score, ABSTAIN_REASON
```

with `ABSTAIN_REASON = "abstain: extraction-empty, score derived from policy text (needs review)"`.
It also widened the coverage test to an extended field set (adding Age, Quantity Limits and the
three Reauth columns to the notebook's narrower list), because the narrow list was itself producing
false "uncovered" verdicts.

The counterweight is that all-empty is *sometimes* real: three of the 79 rows were genuine true
negatives — row 34 (a pharmacy-benefit drug with no PA block in a medical-benefit policy), row 74
(an oncology policy), row 79 (IV-only medical benefit, PsO present only in an FDA blurb). The
pipeline called all three NA correctly. **So "empty" is a legitimate answer *and* the most common
shape of a silent miss — which is exactly why it must be a third state, not a zero.**

### 4.5 Semantic failure modes found by cross-row audit

These were found by re-reading the source, one agent per row, and they are all *reasoning* errors
downstream of correct text — but they are worth listing because they show what an audit layer buys.

| Row | What was wrong | Correction |
|---|---|---|
| 7 STELARA | "unable to take THREE preferred products" — products **unnamed**, so per the rules they are generic, not branded. Row 8 had identical wording and was classified differently. | brands 3→No, generic 0→3; **an internal inconsistency only a cross-row check finds** |
| 44 STELARA | Least-restrictive path misread — the verify pass took a biologic branch instead of the methotrexate-contraindication gate | brands 2→1 |
| 26 TREMFYA | "latent tuberculosis" appeared **only among exclusion conditions**, not as a required screening test | TB No→**NA** (not "No") |
| 30 STELARA | A `¥` footnote granted a `>10 % BSA` severity bypass waiving topical + systemic + phototherapy | generic 1→No, phototherapy Yes→No |
| 66, 72 | Audit *wanted* a change; it was **rejected** on the Reference's own counting rule | held |

Two of those turn on a footnote and a symbol-marked note. **Rank 2 and rank 7 of our FINDINGS list
are not hypothetical hazards — they are the exact shape of two real PA corrections.**

### 4.6 Plumbing failures worth stealing the fixes for

- **Shape drift across a stage boundary.** The original driver wrote the row to CSV and re-read it,
  so the next stage always saw strings. Running in-memory, an int age or a list of specialists
  crashed the verbatim helper. Fix: `_coerce_cell` restores the guarantee explicitly. *Lesson: a
  serialization round-trip was load-bearing behaviour nobody had documented.*
- **Library signature drift.** `TableItem.export_to_dataframe()` changed arity across Docling
  versions — `get_table_df` tries both shapes inside nested `try/except`.
- **Shared-document mutation under concurrency.** `export_to_markdown()` mutates state on some
  versions → `_DOC_LOCK`.
- **Model-output shape.** JSON arrived fenced in markdown, with preamble, or as a bare mapping
  without the envelope. `_parse_spans_json` tries direct parse → fenced block → first `{…}` span.
- **Nondeterminism measured, not assumed.** Identical-code reruns drift ~8 % of cells; a prompt
  "improvement" was shown to be sampling noise, so the prompt was **frozen below the noise floor**
  rather than tuned. Later productionized as `runs` + `_majority` (earliest-run tie-break) +
  `_vote_access_score` (majority → closest-to-median → earliest run).

---

## 5. Does the reducer transfer? Yes — inverted.

### 5.1 The three strategies, in full

`reduce_document(doc, brand)` runs two phases and merges three searches. The framing in
`INTERVIEW_CHEATSHEET.md` §3 is exact: **"three search strategies merged, because PA docs have no
standard format"** — each strategy is a bet on a different *organizing principle*.

**Phase 1 — `find_brand_section` → `(start, end)` over `index.items`:**
- `if total < 200: return (0, total)` — a small document is its own section.
- **1a, header**: brand alias appears in a `SectionHeaderItem` that is *not* structural. End = the
  next non-structural header at the same or higher level.
- **1b, table**: brand alias appears in a table cell → `find_section_scope(anchor_table_pos)`. This
  is the cleverest single function in the codebase: **adaptive gap-based clustering.** Seed with ±10
  tables around the anchor, take inter-table gaps, `initial_threshold = max(median_gap * 3, 10)`,
  walk backward and forward while gaps stay under threshold, then **refine** with
  `max(max(intra_cluster_gap) * 2, 10)` and re-walk. Extend +10 items forward, and reach back up to
  30 items to pull in a preceding header. It infers "how densely does *this* document pack tables"
  rather than assuming a fixed window.
- **1c, any text item**: nearby tables within ±50 → scope from there; else a generous
  `(pos − 50, pos + 200)` window.
- Fallback: whole document, with a printed WARNING.

**Phase 2 — three searches inside that scope:**

- **A · `find_pso_by_headings`** — the document is organised **by drug**. A heading matching
  `PSO_PATTERNS` **or** `UTILITY_PATTERNS` opens a span that runs to the next same-or-higher-level
  non-structural heading. `UTILITY_PATTERNS` is 32 regexes and it is the unsung half: *duration of
  approval, initial auth, length of auth, reauthorization, renewal criteria, continuation criteria,
  quantity limit, dosing limit, approval/denial/clinical/coverage criteria, tuberculosis, TB test,
  TB screen, latent TB, specialist, prescriber requirement, dermatolog, rheumatolog, general
  requirement, universal criteria, required medical info, monitoring requirement, contraindication…*
  Those sections belong to **no drug and no indication**, so no brand-scoped search would ever find
  them. **Strategy A is how document-global rules get in.**

- **B · `find_pso_in_tables`** — the document is organised **by indication**. Per table in scope:
  skip if the *column names* match `ADMIN_TABLE_PATTERNS`; mark it a criteria table if the column
  names match `CRITERIA_TABLE_PATTERNS` (`PA Criteria|Criteria Details|Approval|Required Medical|
  Coverage Duration|Renewal|Exclusion|Prescriber|Restriction|Authorization|Step Therapy|Clinical
  Criteria`); then **small (<20 rows) or criteria-structured → the indication keyword alone
  qualifies; large and non-criteria → require brand AND indication.** Emit `(pos−2, pos+2)`, two
  items of context either side, because the caption or lead-in sentence carries the qualifier the
  table itself omits.

- **C · `follow_cross_references`** — the document is organised **by criteria-number routing
  tables**, and this is the graph traversal. `GOTO_PATTERN = re.compile(r'Go\s+to\s+#\s*(\d+)')`.
  1. **Seed**: every table row containing *both* an indication keyword *and* a `Go to #N` — collect
     those tables and push every referenced `N`.
  2. **BFS**: pop `N`, resolve it by scanning every in-scope table's rows for a first cell matching
     bare `^(\d+)\.?\s*$` or prefixed `^\s*(\d+)\.\s` — **and column 1 when `shape[1] >= 3`**
     (§4.1 #5). On a hit, include that table and enqueue every `Go to #M` found in the matched row.
  3. `visited` guards cycles. Emit `(tbl_pos−2, tbl_pos+2)` per included table.

**Merge and serialize:** `merge_ranges` sorts by start and merges when `start <= prev_end + 3` — a
three-item bridging tolerance so two adjacent hits don't emit a spurious separator. `serialize`
joins with `\n\n---\n\n`, deduping by start. `get_text_between` re-renders in document order:
`## heading`, `df.to_markdown(index=False)` for tables, `- text` for list items, raw text otherwise.

**Three self-correcting gates, all falling back to the full markdown:**

| Gate | Constant | Meaning |
|---|---|---|
| Too aggressive | `MIN_REDUCTION_RATIO = 0.30` | output < 30 % of the brand section → we cut something we needed |
| Too messy | `MIN_FULLDOC_REDUCTION = 0.85` | output > 15 % of the whole document → "pulled in too much noise and likely missed shared sections" (comment cites clean cases: CIMZIA 97 %, formulary 99 %) |
| Too short | `MIN_OUTPUT_CHARS = 100` | with `total_items > 50` |

Plus the self-disable (`full_len < 100_000`) and, in `overrides.py`, the **relevance guard**: a
reduced output missing the brand, or an indication keyword, or any of
`step|trial|approv|authoriz|criteria|requir` is rejected in favour of the full markdown — and the
rejection is surfaced as `source="relevance-fallback"`.

**How much text reached the model:** 97–99 % reduction, **1.5 M → 38 K chars**. And the number that
licenses the entire approach: **92 % agreement between the reduced-text scorer and a scorer reading
the full source PDFs** — an explicit, measured proof that the cut lost nothing decision-relevant.
*Any reduction we ship must carry an equivalent measurement or it is a guess.*

### 5.2 A questionnaire has exactly the same three organizing principles

| PA | Questionnaire | What Word gives us |
|---|---|---|
| Organised by drug → **heading** | Organised by section/module → **heading** | `w:pStyle` Heading N + `w:outlineLvl` — a *declared* level, strictly better than Docling's inferred one |
| Organised by indication → **table** | Grids, quota tables, sample-frame tables, revision history → **table** | real `w:tbl`/`w:tr`/`w:tc` with declared cells |
| Organised by `Go to #7` → **cross-ref BFS** | `SKIP TO Q7`, `GO TO Q12`, `IF Q3=2 CONTINUE ELSE TERMINATE`, `SHOW LIST A`, `ASK ONLY IF S4=1`, `SEE APPENDIX B` → **cross-ref BFS** | the same problem, a richer verb vocabulary |
| `UTILITY_PATTERNS` — TB/specialist/duration sections under no drug | Field instructions, quota rules, soft-launch rules, scope statements, DP instructions — under no question | the same problem |
| `ADMIN_TABLE_PATTERNS` — NDC/AWP/J-Code listings to skip | Revision history, contact list, sample frame, translation matrix | the same problem |

The mapping is close to exact. The `SHOW LIST A` / appendix case is *specifically* PA's cross-ref
BFS: a routing token whose destination is an option list in another part of the document, which must
be pulled in or the answer list is missing.

### 5.3 But the cut does not transfer — and PA's own code says so

`reduce_document` **self-disables below 100 000 chars**, and the cheatsheet records why: on small
documents it "clipped shared TB/specialist/reauth sections not headed under any brand". A client
questionnaire is roughly **20 000–120 000 chars** — squarely in the band PA measured as harmful.

The deeper reason: **PA's denominator was 13 fields; ours is the whole document.** PA could drop a
section and still score 13/13. The v2 coverage contract's denominator *is* the set of obligations in
the document, so dropping a section drops obligations and the run cannot know it did. The reducer's
own safety gates are gates against exactly that, and they fire by falling back to the full text —
i.e. **PA's mature answer to "is this reduction safe?" is repeatedly "no, send everything".**

### 5.4 So: the reducer becomes a coverage prover, not a cutter

Build all three strategies. Run them over the whole document. **Do not cut anything.** Use the span
map for four things:

1. **Routing graph.** Strategy C's BFS, generalized: nodes are questions/blocks, edges are routing
   tokens. This is the artifact planning needs and it does not exist today.
2. **Reference resolution.** `SHOW LIST A` → the appendix block that defines List A, attached to the
   question. Same traversal, different edge type.
3. **Focused views as an *addition*.** Give the second extraction pass (the "source-block/table-aware
   with an explicit construct checklist" pass in the merged claim contract) the focused span
   *alongside* the whole document — PA's demonstrated cure for cross-indication contamination,
   applied to cross-module contamination.
4. **The inversion — coverage proof.** **Every normative block claimed by no strategy is an
   "unmapped normative block"**, which is already an approval gate in
   `structured-claim-contract-merged.md` ("zero unexplained normative blocks"). The reducer stops
   being a filter and becomes the thing that *finds what nothing accounted for*.

And PA's gates transfer as **assertions on the index instead of fallbacks on the input**:

| PA gate | Our assertion |
|---|---|
| `MIN_REDUCTION_RATIO` (cut too much) | strategy union covers < X % of normative blocks → the index is untrustworthy → **declare it**, don't proceed quietly |
| `MIN_FULLDOC_REDUCTION` (cut too little) | ~ everything matched everything → the patterns are too loose to be evidence of anything → declare |
| relevance guard (wrong content) | a resolved routing edge whose destination contains no question-like block → unresolved reference, name it |
| `visited` cycle guard | keep verbatim — questionnaires have loops, and `Q12 → Q7 → Q12` must terminate |

**Numbering is the hard precondition.** Strategy C resolves destinations by matching a criteria
number in a table cell or at the start of a paragraph. Our routing tokens point at `Q7`, `S3`, `A12`
— and where those are Word auto-numbers they **do not exist as text anywhere in `document.xml`**
(FINDINGS rank 1). So: *the cross-reference graph cannot be built until numbering is resolved.* That
is a stronger argument for prioritising numbering than "question identity evaporates", and it is why
numbering sits at #2 in §10 rather than lower.

**One hardcoding discipline to carry over.** PA's design principles include "**zero hardcoding** —
no filename branching, no corpus-fitted rules". Our routing verbs, boilerplate-heading list and
admin-table names are corpus-derived by nature, so they must live in **data, be versioned, be
reported** (`"matched 14 routing tokens across 3 dialects; 2 unrecognised"`), and **fail visibly** on
an unseen dialect. A silently unmatched `PASSER À Q7` is exactly the dead-`\bPsO\b` failure again.

---

## 6. The routing graph: coverage as something the system computes

The owner's claim: *"if we can build a graph for each survey, we don't need to trust the llm blindly
— the system has to generate graphs for each survey, and the system has to traverse the entire graph
by necessity."*

**Verdict: right, and better supported by the existing code than the claim itself suggests — with
one correction to the wording that matters.** "Traverse the entire graph by necessity" is not
achievable as literally stated (full path coverage is exponential, some edges are genuinely
unreachable, and any budget is finite). The achievable and still-transformative version is:

> **The system computes the traversal denominator, attempts every edge, and names every edge it did
> not traverse and why.**

Coverage moves from *attested* to *computed, including its own shortfall*. That survives contact with
a finite budget; "traverse everything" does not, and a claim that cannot survive the budget will be
quietly abandoned in the first real run — which is the failure mode this project keeps rediscovering.

### 6.1 This is a formalisation, not a new architecture — the judge is already doing it informally

Read these four files and the argument makes itself.

**`pipeline/judge/lib/route-table.mjs` already builds graph-S**, recovered by crawling, "with zero
model calls", keyed `(question, answer given) → (screen actually reached next)`. It has a four-rule
**edge admission contract** (E1–E4) whose header says *"each one exists because the raw data violates
it somewhere"*, it records `distinctDestinations` and `pathConsistency: 'mixed' | 'consistent'`, and
it emits `skipped[]` and `integrity[]` for every edge it refused. Its docstring records the payoff:
the row `Q7 | "Can't remember" (code 3) -> Q8` "is exactly the seeded defect T1-D2 **that the prose
verdict denied**."

**`pipeline/judge/lib/compile.mjs` `R-ROUTE-1` already reconstructs a typed edge** — but from prose,
at judge time, one obligation at a time:

```js
return { kind: 'route', question, trigger, destination: dest, sequence, mustNotShow: skip };
```

with `trigger = { mode: 'include'|'exclude', codes, labels, codeSource, identity }`. Every field a
graph edge needs is already there. What is missing is that these edges are **never assembled into a
graph**, so no global property — reachability, orphaning, contradiction, domain coverage — can be
computed. And the reconstruction is a regex over English, with a comment recording its own near-miss:
*"A lazy 'any words' capture silently matched the single letter 'Q' and produced no screen at all."*
A routing edge that silently evaporates because a regex over prose missed is the disease, in the
organ meant to cure it.

**`pipeline/judge/lib/vocab.mjs` already has the traversal-coverage vocabulary**:
`EXERCISED · NOT_REACHED · PROVEN_UNREACHABLE · BLOCKED · PENDING`, under the rule *"Nothing in the
judge may emit a status string that is not defined here."* The distinction the graph diff needs most
(§6.2c) is already a closed enum.

**`pipeline/judge/lib/document-model.mjs` is a 130-line proto-graph-D** — screen order by
first-mention across signed items, terminal screens by a three-pattern regex — and **its docstring is
the whole argument for this proposal**:

> *`screen-universal@1` decided who was ELIGIBLE to see the screen from `routeTable.screenRank`,
> which is the MEDIAN OF `controls_state.progress.now` — a number reported by the survey under test.
> **So the thing being tested supplied the yardstick used to grade it.***

So the recommendation is not "add a graph layer". It is: **compile graph-D once, at ingestion, as a
first-class artifact, and let `R-ROUTE-1` read edges instead of re-deriving them from prose.** That
*deletes* a regex-over-prose layer. It is the cheapest possible form of this proposal and the one
with the least new surface.

### 6.2 Two graphs, one diff — sound, with four leaks that must be plugged

Graph-D compiled from the questionnaire; graph-S recovered by crawling. The reduction to edge-set
arithmetic is **sound for routing** — and it does replace prose-vs-prose comparison *for routing
specifically*, which is exactly where lexical similarity failed. It is not a general replacement:
wording, option lists and scale labels stay lexical (§6.5).

Four leaks, each already half-plugged somewhere in the repo:

**(a) Node identity is the join key, and it is our weakest link.** D-nodes are questions named `Q7` /
`S3` in prose; S-nodes are *screens* identified by a `screen_id` recovered from the DOM. One screen
can carry several questions; a question can span screens; a screen can be unnamed. Set arithmetic is
only ever as sound as its join key — and **the join key is precisely what FINDINGS rank 1 destroys**:
Word auto-numbers are not text anywhere in `document.xml`, so `Q7` may not exist in our extraction at
all. *Numbering resolution is a precondition for the graph, not only for the reducer.* This is now the
second independent argument for the same build item.

**(b) Conditions are not labels.** D-edges are guarded by predicates over answer **codes**
(`Q4 code 2`); S-edges are observed with the **labels the browser rendered**. `compile.mjs` already
states the correct discipline and the graph must inherit it verbatim rather than reinvent it:

> *"Where the document binds a code, the code IS the identity of the answer and the label is
> corroboration only. Where it does not, the label is the identity — and a code is NEVER inferred
> from behaviour."*

**(c) `D ∖ S` is three-valued, not two.** "In D not S" is ambiguous between *the route is missing* and
*we never tried it*. This is the same all-NA problem PA hit and solved with clamp→abstain
(§4.4) — *an empty result is not a negative result.* A two-valued diff would manufacture defects at
exactly the rate the traversal budget falls short, which is the worst possible failure because it
scales with how little work was done. The split must be:

| `D ∖ S` case | Meaning | vocab.mjs term |
|---|---|---|
| attempted, went elsewhere | **missing/mis-route — a defect** | `EXERCISED` + a route reason code |
| never attempted | **not a finding** — a coverage shortfall | `NOT_REACHED` |
| no valid path could reach it | **a document defect** (§6.3 #2) | `PROVEN_UNREACHABLE` |
| attempted, environment refused | **inconclusive** | `BLOCKED` |

**(d) `S` is not the site; `S` is what the crawler admitted.** `admissionRefusal` refuses edges for
four distinct reasons, and refused ≠ absent. The diff must therefore be over `(D, S, S.skipped,
S.integrity)`, not over `(D, S)`. Feeding a refusal-stripped `S` into a set difference silently
converts a data-quality problem into a site defect — the same class of error as (c), from the other
direction.

**Sound if and only if** all four hold: a resolved node-identity function, code-first edge identity,
a three-valued `D ∖ S`, and the refusal set carried forward. All four are already half-built.

### 6.3 Self-validation is the real prize — and the list is long

Graph-D is built by an LLM and cannot be made deterministic. But a graph can be **checked against
itself**, and that is a fundamentally different kind of assurance from asking a model whether it did
a good job. Every check below runs on graph-D alone, before the site is ever loaded, with no model
call:

| # | Check | Class |
|---|---|---|
| 1 | **Dangling edge** — destination node does not exist | structural |
| 2 | **Unreachable node** — no path from entry | structural |
| 3 | **Orphaned route** — edge whose source is itself unreachable | structural |
| 4 | **Dead end** — a node from which no terminal is reachable, not typed terminal | structural |
| 5 | **Terminal with outgoing edges** — typed terminal that also routes onward | contradiction |
| 6 | **Entry ambiguity** — zero or more than one entry node | structural |
| 7 | **Unbounded loop** — a cycle with no exit guard or no iteration cap | structural |
| 8 | **Condition cites an absent code** — a guard on `Q4 code 5` where Q4's option list has codes 1–4. *The classic renumbered-option-list defect.* | domain |
| 9 | **Backward dependency** — a guard referencing a question that is not upstream of the node it guards | temporal |
| 10 | **Non-exhaustive routing** — outgoing guards do not cover the question's full code domain and there is no default. *"What happens if they pick 4?"* | domain |
| 11 | **Overlapping guards** — two outgoing edges simultaneously satisfiable, with no stated priority. **Non-determinism in the specification itself.** | contradiction |
| 12 | **Unsatisfiable base** — a node's guard contradicts every upstream path that reaches it (`shown only if Q4=2` on a node reachable only via `Q4≠2`) | reachability |
| 13 | **Empty base** — guard can never be true given upstream domains (a special case of 12, named separately because it is the common one) | reachability |
| 14 | **Skip/universal contradiction** — a `mustNotShow` naming a screen another rule requires universally. **Representable in `compile.mjs` today and never computed.** | contradiction |
| 15 | **Code/label disagreement** — the same code bound to different labels at one question across rules, or vice versa | identity |
| 16 | **Quota base misplacement** — a quota cell whose base question is not upstream of it | domain |
| 17 | **Anchor/randomise conflict** — an option both anchored and in the randomised set | attribute |
| 18 | **Terminal unreachable from some entry-consistent path** — a respondent can get stuck | structural |

**Eighteen, of which roughly twelve are cheap and decisive. The list is long, so "the model proposes,
the structure checks" is a real architecture, not a slogan.**

And the second-order effect is the one worth naming: **most hallucinated edges fail these checks**,
because a hallucination does not respect the rest of the structure — an invented destination dangles
(1), an invented code violates the option list (8), an invented condition breaks reachability (12).
Structure-checking is therefore also a hallucination detector on graph-D itself.

**Be honest about the residual.** These catch *inconsistent* hallucinations, not *consistent* ones: a
plausible invented edge between two real nodes with a valid code passes every one of them. Structure
raises the cost of a successful hallucination; it does not zero it. The remaining cover is (i) every
node and edge carrying a verbatim span anchor into the document (§7), so an invented edge has no
provenance and is droppable by the same rule that drops an invented quote, and (ii) the two
independent extraction passes and typed diff already in the merged claim contract. Three
independent narrowings, none of them a guarantee. Say that in the report, not in a footnote.

### 6.4 Document-only defects: a finding class the model never has to notice

Checks 1–18 are all **defects in the questionnaire**, computable before a browser starts. That is a
class of finding the current system cannot produce at all, and it is the cheapest QA in the whole
pipeline — no site, no session, no model call at check time, and it runs in the Worker.

It also changes what a run can say when the site is unavailable: *"we could not reach the site, but
the document itself has 3 unreachable questions and 1 non-exhaustive route"* is a real deliverable
where today the answer is nothing.

### 6.5 The limit: most requirements are node attributes, not edges

The owner's proposed fix — key the requirement register to the graph, so coverage becomes *every edge
traversed **AND** every node's checklist evaluated* — **holds up, but only with two mechanisms
attached. Without them it is pure relocation of the coverage problem, and it should not be described
as if it were more.**

What the graph genuinely buys: a **complete node set**, and therefore a complete *denominator of
things that need a checklist*. Today the denominator is "obligations the extractor happened to
propose" — unbounded and unauditable. With a graph it becomes "48 nodes, 48 checklists instantiated,
0 nodes without one" — bounded and computable. **The graph converts an unbounded enumeration problem
("what does this document require?") into a bounded one ("for each of 48 known nodes, which of 14
known attribute classes apply?"). Bounded × bounded is auditable; unbounded is not.** That is the
strongest true claim available and it is a large one.

What it does **not** buy: whether each checklist is complete *for its node*. A node whose checklist
omits exclusive-option enforcement is exactly as silently incomplete as today's missing obligation.
Two mechanisms are what stop that from being a straight relocation:

1. **A closed attribute-class registry**, applying `vocab.mjs`'s existing discipline one level out:
   *nothing may be an obligation that is not an instance of a registered attribute class at a
   registered node.* Then "which classes were not considered at this node?" is a **set difference**,
   and *unconsidered* becomes reportable rather than invisible. Starting registry: wording ·
   option-list membership · option order · anchoring · randomisation · exclusivity · scale labels ·
   scale direction · validation rule · base//routing (the edge) · piping source · carry-forward
   contents · progress indicator · terminal wording.
2. **Per-node source-span coverage** — the ingestion block index (§3) knows which blocks fall in
   node Q7's span. A block inside Q7's span that produced **no obligation of any class** is an
   *unmapped normative block at a known node* — the §5.4 inversion, localised. **This is the part
   that genuinely does not relocate**, because it is a completeness check that does not depend on
   anyone having thought of the attribute class in advance.

What still escapes both: a requirement stated nowhere in the document — a rule that lived in an
email. Nothing in this architecture can find it, and the report must not imply otherwise.

### 6.6 State defeats plain topology — the traversal strategy

Edge coverage will not catch a rule that holds on five routes and breaks on the sixth *if the rule is
only checked once*; it will catch it if the rule is evaluated **at every traversal**, which is what
per-edge obligation evaluation already does. What edge coverage genuinely cannot catch is anything
conditioned on **accumulated state**: a quota that misbehaves once a cell fills, a carry-forward that
corrupts only after a multi-select, an interaction between two upstream answers. Full path coverage
is exponential (20 binary branches = 2²⁰ paths) and is not on the table.

Four tiers, in budget order:

1. **Edge coverage — the floor.** Every D-edge attempted at least once. Computable, budgetable, and
   reportable as a fraction with the remainder itemised.
2. **Node-attribute coverage.** Every node visited at least once with its checklist evaluated.
   Sometimes cheaper than edge coverage, since one visit serves many edges.
3. **Directed state journeys**, generated from the **attribute classes**, not from the topology —
   another reason §6.5's registry is load-bearing: each piping source→sink pair exercised with a
   multi-select *and* a single-select; each validation rule hit with a violating input; each
   exclusive-option rule hit with a conflicting combination; each quota cell driven toward its
   boundary where the environment allows; each randomised node visited N times to sample order (N a
   stated parameter, not an accident).
4. **Pairwise coverage over guard variables** if budget allows — polynomial, not exponential, and the
   standard tractable middle ground for the two-upstream-answer interaction case.

**And the reporting rule, which is the whole point.** `vocab.mjs` already has `NOT_REACHED`,
`PROVEN_UNREACHABLE`, `BLOCKED`, `PENDING`. So the report can say

> *61 edges · 54 traversed · 4 not attempted (budget exhausted after 84 sessions) · 2
> proven-unreachable · 1 blocked — and here are the seven.*

instead of silently reporting on 54. **That is the concrete answer to "the artifact meant to catch a
problem is the thing that hides it": the shortfall becomes a line in the report rather than an
absence.**

### 6.7 The PA precedent supports it — and prices it

`follow_cross_references` (§5.1) treated `Go to #7` routing as a graph traversal over a real
document, with a `visited` cycle guard, and the project's own framing was *"must trace the link or
you miss half the criteria"* — the same claim: untraced routing means missed obligations.

Two costs it measured, both of which point at where our budget should go:

- **The BFS was never the hard part.** It is forty lines and trivially correct. The hard part was
  **binding a routing token to a node** — `7` → the row that *is* criterion 7 — which stayed broken
  until they added the column-1 check for ≥3-column tables (§4.1 #5). *The graph is easy; node
  identity is the whole problem*, and it is a text-extraction problem, not a graph problem. Budget
  accordingly: numbering and cell structure first, algorithms second.
- **PA's traversal was recall-oriented, not exhaustive.** It pulled destinations in so the model
  could read them; it never asserted that every reference resolved, and an unresolved `Go to #7`
  produced silence. **That is exactly the gap the owner's proposal closes, and it is the one place
  the proposal is strictly better than the precedent it descends from.**

One genuine caution from the same precedent: PA's routing lived in *numbered tables* — the document
did half the graph-building. A prose questionnaire ("if the respondent is not aware of the brand,
thank and close") gives less scaffolding, so graph-D extraction is a harder LLM task than PA's BFS
ever was. That is an argument **for** the self-consistency checks, not against the graph.

### 6.8 Where it goes in the build order

Graph-D is an **ingestion artifact**, built from the frozen view and the block index, anchored by
span, and consumed by planning, the judge and the report. It therefore lands **after** node identity
(numbering) and the reducer-as-index (which produces the raw routing edges), and **before** planning.
It is item **7** in §10, and §10 has been re-ordered to say so.

---

## 7. Provenance: the verbatim guard, and why tables don't break it

### 7.1 What PA built

`explain.py` is a **separate pass with its own prompt** that never touches extraction output — "the
returned spans are advisory evidence only". It asks for verbatim quotes, then refuses to believe
them:

```python
# Verbatim guard: keep only quotes that are substrings of the policy.
if quote in policy_text:
    pass
elif re.sub(r"\s+", " ", quote) in norm_policy:
    pass
else:
    continue  # not present verbatim -> drop (no paraphrase/invention)
```

and then:

```python
found = bool(entry.get("found", False)) and bool(quotes)
# If the model said found=true but supplied no verbatim quote,
# downgrade to found=false (no evidence we can stand behind).
```

Plus: it **never raises** (any failure → a fully-populated `found=false` map), it accepts three JSON
shapes, it dedupes, it drops non-string junk, and it fences the untrusted policy text in
`<POLICY_DOCUMENT>…</POLICY_DOCUMENT>` because OCR'd user PDFs can carry prompt injection.

The golden tests (`test_explain_spans.py`) show what it actually catches: the paraphrase *"the
policy demands tuberculosis screening"* is dropped against the real *"A documented negative TB test
is required prior to initiation."*; mixed good/bad quote lists keep only the good; `[123, None,
{"x":1}]` yields `[]` **and** downgrades `found`.

### 7.2 v1 already has this guard — which makes silent loss worse than FINDINGS says

`src/verify.ts:69` + `:84-85`:

```ts
const normalizedSpec = normalizeWhitespace(specText);
const specOk = specNeedle.length > 0 && normalizedSpec.includes(specNeedle);
```

with `normalizeWhitespace = (t) => t.replace(/\s+/g, " ").trim()`. Every model finding must quote the
parser's output character-for-character modulo whitespace, or it is marked `quoteVerified: false`.
**That is the same design as `explain.py`, reached independently, including the whitespace-tolerant
comparison.** (Note it collapses the `\t` cell separators too — the tabs are for the *model's*
reading of table shape, not for the verifier.) v1's `prompt.ts:19-21` `neutralizeDelimiters` is
likewise the same instinct as PA's `<POLICY_DOCUMENT>` fence, also reached independently.

The consequence is the sentence that should reframe FINDINGS:

> **Any text the parser drops is a rule the models can never legally cite. A dropped requirement is
> not merely unchecked — it is *uncheckable*.**

A silently lost footnote does not degrade to "unverified". It degrades to a finding that *cannot be
made*, because the only evidence that would ground it was never in the string. Ranks 2, 3 and 4 are
therefore not "we might miss something" — they are hard ceilings on what the system is capable of
reporting.

The other contract worth recording, because §6.2(a) depends on it: `verify.ts:148-167` matches findings
to seeded defects on `questionId` with `new RegExp("\\b" + escapeRegExp(seededQid) + "\\b")`, with a
comment explaining that a plain `includes()` lets `"q1"` over-match `"q10"`/`"q11"` and `"s1"` match
`"hips1"`. **Question numbers are already the system's join key** — which is the third independent
argument that resolving auto-numbering is not cosmetic.

### 7.3 The apparent contradiction, resolved

> *real documents put text in tables, so a naive verbatim check fails.*

PA had exactly that problem — the reducer renders tables through `df.to_markdown(index=False)`, so a
table quote is nowhere near verbatim against the original PDF. **The guard works anyway, because it
checks against `policy_text` — the exact serialized string the model was shown.** That is the whole
trick and it generalizes cleanly:

> **Check the quote against the bytes you sent the model, never against the original file.
> Then carry an anchor from the view back to the source part.**

### 7.4 What we build, which is strictly stronger

1. **Freeze and hash the view.** `viewHash = sha256(view)`. Every anchor is relative to it. If the
   view changes, every stored anchor is invalidated rather than silently re-pointed.
2. **Anchors are offsets, not substrings**: `{ viewHash, start, length }`, verified by
   `view.slice(start, start+length) === quote`. This is O(1) *and* it fixes a bug PA's substring
   check has: a substring search matches the **first** occurrence, and in a questionnaire
   `"Very satisfied"` appears in forty grids. An offset says which one.
3. **Keep the whitespace-tolerant second chance** — but only to *locate* an offset, never to accept
   an unlocated quote.
4. **Tabs.** Cell text is joined with `\t`; a quote spanning two cells contains a tab. Normalize tabs
   to a single space **in the tolerant comparison only**, and record the cell coordinates
   (`Block.cells[i]`) in the anchor.
5. **Map back to the source.** `offset → Block → { sourcePart, origin, originId }` so a claim cites
   `word/footnotes.xml · footnote 3 · chars 210–288`, auditable against the original archive. This
   is what the judge and scorer need and what PA never had (it lost page numbers at the Docling
   stage and never recovered them — `pa_audit.js` had to ask for "page/section anchors **or** short
   quotes").
6. **Adopt the two behavioural rules verbatim**: no surviving evidence → `found=false`; the
   provenance pass is advisory and must never break a run.
7. **Keep the injection fence.** A client `.docx` is untrusted input in the same way an OCR'd PDF
   is — comments and footnotes are the obvious carriers.

---

## 8. What runs where

### 8.1 The precedent, and why it points the other way here

PA faced this exact fork and its decision table records it:

> | PDF → text | **Cloudflare Container running the real Docling + Surya + reducer** | Fidelity over
> simplicity (vs. the lighter Workers AI `toMarkdown`); preserves the original OCR + the brand reducer |

They chose the heavyweight path. **That decision does not transfer, for three reasons:**

1. **The thing Docling bought them, OOXML gives us for free.** PA needed a layout model because a
   PDF is pixels — headings, cells and reading order had to be *inferred*. The reducer is built on
   the typed `DoclingDocument`, not the markdown. A `.docx` *declares* all of it: heading level in
   `w:outlineLvl`, cells in `w:tc`, list identity in `w:numPr`. We would be paying a model to guess
   at data we already hold.
2. **The cost is not hypothetical.** PA's Container is CPU-only (no GPU on Containers), needs
   `sleepAfter = 3m` / `max_instances = 3`, an OCR-once LRU cache, a `_DOC_LOCK`, per-file GC and a
   441-page special case. v1's parser does a 460-paragraph document **in 2 ms inside the Worker**.
3. **It is the local-dependency trap the owner wants closed.** And the 1 Aug decision recorded in
   `ocr-evidence-research.md` — *"No OCR — anywhere … extraction runs in-Worker on Cloudflare"* — is
   already the opposite call. This playbook agrees with the owner and against the PA precedent, and
   says so explicitly.

### 8.2 The split

| Concern | Where | Why |
|---|---|---|
| Unzip, decode, part-set read, blocks, tables, numbering, coverage, provenance anchors | **our code, in the Worker** | pure string work over declared structure; fflate is the only dependency and it is already bundled; no new bytes for numbering or the walker |
| The reducer-as-index (3 strategies + BFS) | **our code, in the Worker** | deterministic, auditable, free, and it must run over the *same frozen view* the anchors address |
| Extraction passes A and B (Grok + DeepSeek per the owner's 2 Aug decision) | **model calls from the Worker** | already the plan |
| `env.AI.toMarkdown()` and friends | **cross-check / fallback — see 7.3** | pending measurement |
| PDF or scanned questionnaire input | **unresolved — escalate** | "no OCR anywhere" plus "no local dependency" leaves a Cloudflare-native or vision-model path as the only option. Do not resolve this silently. |

Bundle impact of the recommendation: **zero new dependencies.** Part-set reading reuses the existing
helpers (§10); numbering resolution and the depth-aware walker are pure string work. Contrast with
what a native binding costs: an `AI` binding, a network round-trip inside the ingest path, Workers AI
metering, and the retry/timeout/budget machinery PA had to build around model calls
(`MAX_LLM_CALLS`, per-request budget, `PermanentLLMError` vs retryable).

### 8.3 The Cloudflare-native slot — now measured

`docs/cloudflare-document-processing.md` **landed while this was being written.** It ran the 20
corpus fixtures through the live `POST /accounts/{id}/ai/tomarkdown` endpoint and scored them with
the *same* 99 probes and the *same* `evaluate()` logic as `run-harness.mjs`. The criteria below were
written before those numbers were read; both are kept, in that order, so the conclusion cannot be
rationalized after the fact.

**The criteria, fixed in advance — and how they resolved:**

| # | Criterion | Measured outcome |
|---|---|---|
| 1 | Does it return parts we lose — footnotes, comments, headers, numbering? | **Split.** Footnotes/endnotes **decisively yes** (inline `[[1]](#footnote-1)` *and* the note text). Numbering **partially** — real ordinals, but only in markdown mode, and it normalises `"Q1."` → `"1."`. **Headers, footers and comments: also lost.** |
| 2 | Does it declare what it dropped? | **No.** One flat string, no part attribution. *"This is not a gap that a wrapper can close."* |
| 3 | Deterministic and versioned? | Not established; and an intermittent **120 s hang returning HTTP 524 with an HTML body** was observed on one document that then converted in 7.0 s twice on retry. Disqualifying for the primary path on its own. |
| 4 | Cell boundaries preserved? | **Partially.** Outer table rows pair correctly (better than us on nested tables), but **inner cells run together with no separator** — `…(has smart meter)ask Q41 then Q42Q40 = 2…`. And the separator convention is a space/pipe, not our tab. |
| 5 | Latency, cost, limits, failure modes | **Free** (zero neurons for `.docx`; embedded images are *not* AI-described). **~1.6 s median vs our ~2 ms.** Superlinear in table count: 500 → 1.8 s, 2 000 → 7.0 s, 5 000 → 17.1 s, 20 000 → hard failure; **ours does 20 000 tables in 78 ms.** Errors arrive **in-band** as `format: "error"` inside a `success: true` envelope. |
| 6 | Unicode / `w:sym` / `noBreakHyphen` fidelity | **Beats us on the glyphs** (`≥`, `✓`, U+2011) — those are real corruptions of ours. **Loses to us on NBSP**, which it silently normalises U+00A0 → U+0020. |

**The verdict, and it matches the prior: keep ours as primary.** `toMarkdown` scores **78/99 against
our 77/99** — a tie — and *"the two failure sets barely overlap"*: it fixes four hazards we lose and
introduces three we currently survive. Three findings decide it:

1. **It silently drops moved text.** `w:moveFrom`/`w:moveTo` — the paragraph
   `"Q71. ROUTING: … SKIP TO Q80 and set engaged = 0."` **vanishes**, and the output reads Q70, Q72,
   Q73 and looks complete. That is the corpus's own worst class (plausible, wrong, confident), on a
   *routing rule*, and our parser gets it right today (§2.2 — for free, via the same
   `w:delText`-by-omission mechanism).
2. **It cannot do the thing FINDINGS said matters.** A flat string cannot carry origin labels, and it
   drops comments and headers regardless — so the *"an unresolved comment is a proposal, not the
   spec"* distinction is unrepresentable.
3. **It hard-fails on UTF-16LE** (`Invalid Word Document: [xmldom error] invalid tagName`) where we
   are clean 4/4.

The two modes are a forced trade with no good side: `format: "markdown"` scores **54/99** because it
escapes literal text (`Q4.` → `Q4\.`), breaking every literal probe and any downstream string
comparison; `format: "text"` **strips list markers**, which is the only place numbering lives. Either
choice needs code we would have to write.

**So the second-opinion prior stands, narrowed.** Use it exactly as PA used its Workers AI consensus
validators — *same input, different engine; the canonical answer stays with the primary; a failing
validator is dropped rather than failing the run; disagreement is a reported signal.* PA's shape is
`{primary, validators[], agree_count, total, unanimous}`, with per-validator failure degrading
gracefully. Three concrete uses, and no others:

- **Numbering oracle**, per criterion 1 — markdown mode is the only mode carrying ordinals, so it
  needs an unescaper, and its labels are normalised (`"Q1."` → `"1."`), which means it can supply the
  *ordinal* but **not the label our join key needs** (§6.2a). It corroborates our numbering; it does
  not replace it.
- **Glyph repair** for `w:sym` and `w:noBreakHyphen` until we fix them ourselves.
- **A divergence signal**: a block-count or character-count gap between the two readers means one saw
  content the other did not — which is precisely the silent loss FINDINGS is about.

Guard it with a timeout, a retry, a content-type check (the 524 returns HTML, so `res.json()` throws
`Unexpected token '<'`), a `format === "error"` check, and degradation to our parser on any failure.
**Never let it overwrite a labelled block** — it will silently omit moved text and headers.

**And the "less local" answer is not what it looks like.** Measured with `esbuild --bundle --minify`,
`src/docx.ts` is **4.3 KB**, or **9.7 KB** with tree-shaken `fflate` — against a 3 MB Worker limit.
There is no bundle win available, and an adjunct *adds* code. The real "less local" lever is **CPU**:
routing extraction off-Worker would eliminate the rank-13 quadratic-scan DoS (98 KB upload → 17.9 s
of Worker CPU, which size caps do not help) because a subrequest's wall-clock is not Worker CPU. That
is the one genuine argument for the native path — and a depth-counting scan (§10 item 4) closes it
without a network round trip.

**Two defects in our own benchmark, surfaced by the comparison.** Worth more than the score:
- The `16-fields-symbols` probe *"Ref code T-14"* expects an ASCII hyphen. `toMarkdown` emits the
  semantically correct U+2011 and **scores a fail**; we emit the corrupt `T14` and also fail. **Our
  probe encodes the bug as the expectation.** Fix the probe.
- `14-legacy-word2003.doc` scores **2/2 clean** for `toMarkdown` — a **false pass**. The fixture is
  Flat WordprocessingML; it was routed to the `.xml` handler and returned **raw OOXML markup
  verbatim**, and the probes matched because the strings appear inside `<w:t>` tags. Passthrough
  scored as extraction.

Both are instances of the disease this repo keeps naming: the measuring apparatus hiding the thing it
was built to reveal. Add a probe class that asserts the output is **not** markup.

---

## 9. Fourth source: Graphify — not usable, but two ideas worth taking

[`Graphify-Labs/graphify`](https://github.com/Graphify-Labs/graphify) (Python; tree-sitter AST across
36+ languages; Leiden community detection; `graph.json` / `graph.html` / `GRAPH_REPORT.md`; dual
Apache-2.0/MIT; ~100 k stars; 281 Python files, 119,583 LOC; last push 1 Aug 2026). Assessed from a
**full clone of the default branch `v8`** at commit `00efd6e7` — not from the README — with its docx
function **executed** against a purpose-built fixture.

**Verdict: not usable as code. Two ideas worth taking, and one calibration that is worth more than
either.**

### 9.1 The preliminary read was right on all three counts, and the evidence sharpens it

- **Wrong runtime** — confirmed, and worse than stated. Standing up a Python container would buy us
  a **~35-line wrapper** (`graphify/detect.py:544-583`). There is no engine there to import.
- **Wrong objective** — confirmed, now with a mechanism. `AMBIGUOUS` is explicitly an *anti-omission*
  device: the prompt says *"AMBIGUOUS: uncertain — flag for review, **do not omit**"*, reinforced in
  deep mode as *"Mark uncertain ones AMBIGUOUS instead of omitting"*. There is **no
  `--min-confidence` flag anywhere in the repo**, and the only place any tag gates anything is
  whether an edge is drawn in a Mermaid diagram. Nothing is ever refused. That is optimised for a
  rich exploration graph and is the opposite of a contractual floor.
- **Wrong subject** — confirmed, and precisely: the *good* confidence rule is AST-only and never runs
  on a document (§9.3).

### 9.2 The docx path — our exact bug, inherited whole, plus two we don't have

**The library is the finding, not the repo: `python-docx`.** `pyproject.toml:66` →
`office = ["python-docx", "openpyxl"]`, an optional extra that is **off by default**. No markitdown,
no unstructured, no mammoth, no docling — all grepped for, all absent.

The implementation touches `doc.paragraphs` and `doc.tables` and nothing else. A grep of all 119 k
lines for `oxml`, `footnote`, `endnote`, `numPr`, `comments.xml` returns **zero**. The tell is
`from docx.oxml.ns import qn` at line 550 — **imported and never called**. Someone began
element-level work and abandoned it.

Run against a fixture carrying a header, footer, numbered list, a mid-document table, and injected
`footnotes.xml` / `comments.xml`, its output was:

```
HEADER_SENTINEL   present=False      FOOTNOTE_SENTINEL  present=False
FOOTER_SENTINEL   present=False      COMMENT_SENTINEL   present=False
```

and *"Paragraph AFTER the table"* printed **before** the table.

| Construct | Graphify | Us today | Us after §10 |
|---|---|---|---|
| Footnotes / endnotes / comments / headers / footers | **lost** | lost | read + labelled |
| Auto-numbering | **lost worse** — `elif style.startswith("List"): "- " + text`, so `1./2./3.` all become identical bullets; ordinals *and* nesting destroyed | lost | resolved or `[#]` |
| Table position | **destroyed** — a separate loop appends all tables after all paragraphs | preserved | preserved |
| Merged cells | repeat (python-docx `row.cells` semantics) | vMerge stub lost | depth-aware |
| Images, textboxes, content controls, tracked changes | none reachable via `doc.paragraphs` | textboxes **handled well**; rest lost | placeholders + counts |

So it carries **all six of our silent losses plus two of its own**. This is the answer to any future
proposal of the form *"why not just use a library?"* — the mainstream Python library exposes body
content by design, and **our part-set reader is already ahead of a 100 k-star project**.

**And the anti-pattern, stated in code.** `_zip_within_caps` (`detect.py:60`) is genuinely good
engineering — a two-layer bomb guard, declared-size pre-filter *then* bounded stream decompression
per member, better than a naive cap. But over-cap returns `""`, `except ImportError` returns `""`,
and `except Exception` returns `""`; `convert_office_file` then maps empty text to `None` and **the
file silently vanishes from the corpus.** A well-built defence wired to fail silent. That is
precisely the failure this playbook exists to prevent, shipped at scale — read the guard, invert the
disposal.

**PDF** is `pypdf`, text layer only, no layout analysis and no table reconstruction; their own comment
concedes *"A scanned PDF with no text layer extracts to an empty string."* **XLSX** is `openpyxl`
with `data_only=True`, so **formulas are lost and only cached values survive** — and a workbook never
opened in Excel has no cached values at all. Both are materially behind PA's pdfplumber→PyMuPDF
fallback chain (§2.1), which at least *detected* the empty-extraction case and reported it.

**Also worth knowing:** 180 test files and **3,443 test functions — and not one asserting docx content
fidelity.** The office tests cover incremental re-conversion plumbing only. That is exactly why eight
loss modes sit unnoticed in a heavily-tested, heavily-starred project, and it is the strongest
external validation of our 99-probe harness that we are going to get.

### 9.3 Idea worth taking #1 — the *derivation* axis, in its computed form only

`EXTRACTED / INFERRED / AMBIGUOUS` is **two different mechanisms sharing one enum**, and the
distinction is the whole value:

- **Code files → computed by code, deterministically.** No LLM is involved at all:
  ```python
  "confidence": "EXTRACTED" if type_qualified else "INFERRED",
  "confidence_score": 1.0 if type_qualified else 0.8,
  ```
  justified in the source as: *"A type-qualified call (`Type.staticMethod()`) names the receiver type
  explicitly in source, so it is an exact reference — EXTRACTED… An instance call whose receiver type
  came from local inference stays INFERRED."* That is a real, auditable, reproducible rule.
- **Documents → self-reported by the model** from a three-line prompt, unchecked. **A `.docx` is
  100 % this path.** (The 0.95/0.85/0.75/0.65/0.55 rubric in their `docs/how-it-works.md` appears in
  **no prompt and no validator** — documentation describing a mechanism that does not exist.)

**Is their vocabulary sharper than ours? No — but it has an axis we lack.** `vocab.mjs` has
*coverage* (did we exercise it), *verdict* (did it pass), *disposition* (what kind of finding). It
has **no closed enum for how we came to believe a claim.** That axis is worth adopting, converging on
public vocabulary, **but computed rather than self-reported** — i.e. their code path, not their doc
path:

| Value | Computed rule | Consequence |
|---|---|---|
| `STATED` | the node/edge's anchored span literally contains the destination or condition token | the strong case; no review flag |
| `RESOLVED` | bound only through numbering or structural inference (§10 item 2) | reaches the graph, **reported as such** so review is prioritised — this is where a renumbered list silently breaks a route |
| `UNSUPPORTED` | no surviving span anchor | **dropped**, per §7 — never flagged-and-kept |

The third row is where we deliberately diverge: **Graphify flags, we drop.** Their own
`_bind_node_evidence` docstring calls its marker *"a reversible flag, never a drop"*. For a
navigation graph that is right; for a coverage contract it is not.

### 9.4 Idea worth taking #2 — nothing, and here is why that matters

*"Every edge explained, no vector store"* resolves, on inspection, to **a one-word tag plus a line
number**. The required edge fields are `{source, target, relation, confidence, source_file}` —
`source_location` is **not required**, is a point (`"L6"`) rather than a span when present, and the
prompt's own schema defaults it to `null` on the semantic path. **No quote, no rationale, no rule
identifier.** For AST edges that is still mechanically re-checkable (open line 6, confirm the
import). For an LLM edge out of a `.docx` it is not checkable at all.

Their nearest analogue to `explain.py` is `_bind_node_evidence`, and it is weaker on every axis:

| | `explain.py` (PA) / our §7 | Graphify `_bind_node_evidence` |
|---|---|---|
| Applies to | every claim | **nodes only — edges are never evidence-checked** |
| Evidence | a verbatim quote the model was asked to supply | identifier tokens auto-derived from the node's own label |
| Test | literal substring of the exact text the model saw | **any one** token ≥3 chars, case-insensitive, anywhere |
| On failure | **drop the quote; downgrade `found`** | flag `verification="unverified"`, keep |
| Model asked for quotes? | yes | **no — the prompt never requests them** |

Their own docstring concedes it: *"Verification is lenient: any identifier occurring as a substring
(case-insensitive) passes."* A node labelled `parse` passes if the word "parse" appears anywhere in
the document.

**So this is a third independent implementation of the same instinct — and it is the weakest of the
three.** PA asked for quotes and dropped the unsupported ones; v1's `verify.ts` requires every model
finding to quote the parser's own output or be marked unverified; Graphify neither asks nor drops.
Three teams reached for evidence-binding unprompted, which is good evidence the instinct is correct —
and the ranking tells us the thing that makes it *work* is not the binding, it is **the disposal
rule**.

### 9.5 The graph idea itself is untouched by this

Nothing above bears on §6. Graphify's graph is a *code* graph built by tree-sitter, clustered for
exploration, with an unvalidated free-string `relation` field, bare-dict nodes and no schema. The
questionnaire routing graph in §6 descends from pa-policy-extractor's cross-reference BFS and from
this repo's own `route-table.mjs` — both of which are stricter than anything here. **Graphify is
evidence that graphs-over-documents is a well-trodden idea, and evidence that treading it for
*exploration* produces something structurally unable to carry a coverage contract.**

---

## 10. Ranked build order, and what to reuse verbatim

Ordered by *silent-loss closed per unit of work*, which is not the same as FINDINGS' order — items 0,
6 and 7 are new, and numbering moves up because the routing graph depends on it (§5.4).

> **Read items 1–5 as a specification to check against, not as work to start.**
> `docs/cloudflare-document-processing.md` §5 reports that `worker-v2/src/extract/docx-blocks.ts`
> already **states** that it reads footnotes, endnotes, comments and headers/footers with origin
> labels, emits `[#]` for auto-numbering, recovers image alt text, uses a depth-counting table scan
> that refuses an unbalanced document, and handles Flat WordprocessingML — ranks 1, 2, 3, 4, 5, 6, 11
> and 13. **I could not verify that: `worker-v2/**` is off-limits to this investigation and I did not
> open it.** If it holds, items 1–5 are largely done and this playbook's job for them is to supply
> the acceptance bar — the result-object shape (§3.2), the per-construct dispositions (§3.3), the
> three failure tiers (§3.4) and the loud-failure gate. **Items 0, 6, 7 and 8 are the ones with no
> owner**, and they are where the distinctive value of this document lies.



**0 · The frozen view + block index + result object.** Nothing else can be anchored, counted or
diffed without it. Small, and it is the substrate for 1, 3, 6 and 7.
*Reuse:* PA's `meta` shape — `source`, `full_markdown_chars`, `reduced_chars`, `reduction_pct`,
`truncation`, `llm_input_chars` — as the template for `coverage` + `degradations`.

**1 · Read a part SET, not a part.** `footnotes` · `endnotes` · `comments` (+`commentsExtended`
`w15:done`) · `header*` · `footer*`, each block labelled with its origin. Closes FINDINGS ranks 2, 3
and 4 — the three highest-likelihood silent losses — in one change.
*Reuse **verbatim**, no edits:* `extractBlocks`, `extractTableRows`, `extractParagraphText`,
`decodeXmlEntities`, `isValidXmlChar`, `decodeDocumentXml`, `detectWmlPrefix`, `buildSyntax`,
`escapeRegExp`, `neutralizeTextBoxParagraphs`, `stripMarkupCompatibilityFallback`. They are all
part-agnostic already — **only the caller changes.** Keep comments out of body text.

**2 · Numbering resolution.** `numbering.xml`, `numId → abstractNumId → lvl`, per-`(numId, ilvl)`
counters in document order, substituted into `w:lvlText`; `[#]` placeholder + counter on failure.
Closes rank 1 (corruption, very high likelihood) and **unblocks the routing graph**.

**3 · The coverage record, placeholders, and the three failure tiers.** Images, `w:sym`, unresolved
fields, `w:sdt` dropdowns, `noBreakHyphen`, deleted paragraph marks. Turns invisible blind spots into
visible ones and makes *"there are 4 footnotes I could not read"* renderable.
*Reuse:* the abstain reason string pattern from `overrides.py`; the named-mode pattern from
`core.consume_truncation_mode()`.

**4 · Depth-aware tag walker.** Fixes nested tables, vMerge inheritance and the quadratic
`<w:tbl>` scan (98 KB → 18.5 s CPU) together. Interim one-liner first: compare `<w:tbl` and
`</w:tbl>` counts and skip table handling if unequal.

**5 · Input triage + `_rels/.rels` main-part resolution.** Four `startsWith` checks and a lookup.
Turns two crashes into two good error messages.
*Reuse:* v1's existing error style — it already lists the entry names it saw, which is why FINDINGS
could diagnose rank 11 at all.

**6 · The reducer as index (§5.4).** Three strategies over the frozen view, the BFS routing graph,
the unmapped-normative-block report.
*Reuse (port to TS, logic unchanged):* `merge_ranges` including the `+3` bridging tolerance; the
structural-header exclusion pattern (retargeted to questionnaire boilerplate); the admin-table skip
by *column name* (retargeted); the column-0/column-1 destination resolution; the `visited` cycle
guard; the `(pos−2, pos+2)` context pad around table hits.
*Do **not** port:* `MIN_REDUCTION_RATIO` / `MIN_FULLDOC_REDUCTION` / `MIN_OUTPUT_CHARS` **as input
cutters** — port them as assertions on the index (§5.4 table).

**7 · Compile graph-D, and run the 18 self-consistency checks (§6).** The routing edges fall out of
item 6; this item *assembles* them, resolves node identity against the numbering from item 2, anchors
every node and edge to a span from item 0, and runs checks 1–18. Ships with the closed
attribute-class registry (§6.5) so the node checklists have a bounded denominator from day one.
*Reuse:* `compile.mjs`'s `R-ROUTE-1` edge shape `{question, trigger{mode,codes,labels,identity},
destination, sequence, mustNotShow}` **as the edge schema** — then delete its prose regex and have it
read the compiled edge; `route-table.mjs`'s admission-contract discipline (a reason recorded for every
refused edge); `vocab.mjs`'s `EXERCISED / NOT_REACHED / PROVEN_UNREACHABLE / BLOCKED / PENDING` as the
traversal-coverage enum, unchanged; PA's `visited` cycle guard; the computed `STATED / RESOLVED /
UNSUPPORTED` derivation field from §9.3 on every node and edge.
*Payoff before any browser runs:* the document-only defect class (§6.4).

**8 · Provenance anchors + verbatim guard (§7).**
*Reuse:* `_coerce_quotes` logic upgraded from substring to offset; the `found && quotes` downgrade
rule; the never-raise contract; the three-shape JSON parser; the `<POLICY_DOCUMENT>` fencing idea for
untrusted `.docx` text. Every graph-D node and edge takes an anchor here — an edge with no surviving
anchor is dropped by the same rule that drops an invented quote (§6.3).

**9 · Cloudflare-native cross-check.** Slot in `cloudflare-document-processing.md`'s head-to-head
against the §8.3 criteria. If it resolves numbering, promote it to numbering oracle immediately —
that is the one place a native surface could beat us outright.

**Then, and only then, measure.** PA's reducer is credible because of *one number*: **92 %
agreement between reduced-text and full-source scoring**. Our equivalent, run against the
20-fixture harness plus real client documents: **block count, character count and obligation count,
per part, old parser vs new** — with every delta attributed to a named coverage entry. A change that
adds blocks without a coverage story is as suspect as one that loses them.

---

## 11. Where the two projects disagree, and who is right here

| Question | pa-policy-extractor | survey-qa v1 | Right for this problem |
|---|---|---|---|
| Reduce before the model? | Yes, aggressively (97–99 %) | No, send everything | **v1.** PA's own self-disable threshold (100 k chars) puts a questionnaire inside the band it measured as harmful, and our denominator is the whole document |
| Structure from a model or from the file? | Inferred (layout model) | Declared (OOXML) | **v1**, wherever it applies. PA's approach is only necessary for pixels |
| Heavy runtime for ingestion? | Container (torch, Docling, Surya) | In-Worker, ~2 ms | **v1**, and the owner's no-local-dependency goal agrees |
| Fail on an empty result? | Raise on missing required defs | Throw rather than return `""` | **Both agree** — the strongest convergence in this document. Keep it and extend it from *empty* to *partial* |
| Report partial failure? | Yes — `source`, `truncation`, `llm_input_chars`, `spans.found` | **No** — all-or-nothing; and it *computes* the archive's part list, then discards it on the success path (§3.0) | **PA, decisively.** This is the single biggest thing to import, and it is the whole point of FINDINGS |
| Bind claims to evidence? | `explain.py` — asks for quotes, **drops** the unsupported | `verify.ts` — requires findings to quote the parser's output, marks the rest unverified | **Both, and they already agree.** Graphify (§9.4) neither asks nor drops — the ranking shows the disposal rule, not the binding, is what makes it work |
| Multiple models? | Canonical = one model; others advisory, dropped on failure | N-of-3 consensus (retired 1 Aug) | **PA's shape** — and v2's Grok + DeepSeek two-pass already matches it. Canonical stays one; disagreement is a signal, never a silent merge |
| Corpus-fitted rules? | "Zero hardcoding — no filename branching, no corpus-fitted rules" | n/a | **PA.** Our routing verbs and boilerplate lists are corpus-derived by nature → make them data, version them, report unmatched dialects |
| Page/location anchors? | Lost at the Docling stage, never recovered | n/a | **Neither.** Design ours in from the start: part + offset, and *declare* that page numbers do not exist in `.docx` |
| Routing as a graph? | Yes — BFS over `Go to #N`, but **recall-oriented**: an unresolved reference produced silence | n/a | **PA's mechanism, not PA's ambition.** Take the traversal; add the thing it lacked — every unresolved reference and untraversed edge named in the output (§6.7) |

---

## 12. Traceability

Every non-obvious claim above, and where to check it.

**pa-policy-extractor** — `E:\submission\pa-policy-extractor\`
- `container/pipeline/core.py` — Docling options (362-391); `_truncate_policy_text` + the 705 k /
  pages-45-71 incident (128-200); the two-tier caps and their cost rationale (216-244); the OCR-once
  LRU (299-458); `_DOC_LOCK` (290-297); `source` tagging and `meta` (760-950); consensus map
  (954-1002); `_coerce_cell` and the CSV-round-trip lesson (681-695).
- `container/pipeline/overrides.py` — the dead `\bPsO\b` regex (51-52, 141-155); the relevance guard
  (99-136); **clamp → abstain** (165-204, and the module docstring's own summary at 30-33).
- `container/pipeline/explain.py` — the verbatim guard (157-190); the `found` downgrade (248-251);
  the injection fence (108-119).
- `container/pipeline/notebook_loader.py` — "fail loudly rather than silently degrade" (42-78).
- `container/notebooks/document_reducer_1_.ipynb` — **the reducer is the LAST `reduce_document` cell
  in the notebook** (the loader execs cells in order, so later definitions win); `alias_in_text`,
  `BRAND_ALIASES`, `PSO_PATTERNS`, `UTILITY_PATTERNS`, `STRUCTURAL_HEADERS`, `GOTO_PATTERN`,
  `DocumentIndex`, `find_brand_section`, `find_section_scope`, `find_pso_by_headings`,
  `find_pso_in_tables`, `follow_cross_references`, `merge_ranges`, `serialize`, and the three gates.
- `container/notebooks/Docling_extraction_1_.ipynb` — the pipeline options and the 441-page special
  case.
- `container/tests/test_explain_spans.py` — what the verbatim guard rejects, as executable examples.
- `container/tests/test_truncation_windowing.py` — window-packing geometry, incl.
  `test_deep_alias_window_is_packed_in` and `test_primary_cap_is_above_scoring_cap`.
- `PROJECT_OVERVIEW.md` — §4 decision table (Container **vs** `toMarkdown`); §7 the precise diff;
  §13 honest caveats.

**The original working directory** — `E:\Claude Hackathon\`
- `extract_pdfs.py` — the pdfplumber + PyMuPDF fallback chain, the bullet normalizer, the
  `scanned_suspect` detector.
- `pdftext_report.json` — 70 files / 3,151 pages / 5,318,609 chars / **0 scanned suspects**.
- `pa_workflow.js` — the extract → verify → judge ladder and the grep-window reading instruction
  (`howToRead`, line 143).
- `pa_audit.js` — one auditor per row; the "page/section anchors **or** short quotes" tell.
- `audit_reasoning.txt` — rows 23, 30, 31, 34, 36, 77 in the auditors' own words.
- `patch_final.py` — the applied corrections for rows 7, 26, 44, 77 with their reasoning.
- `validate_submission.py` — 26 structural/value/cross-field checks; note C4/C6, the true-negative
  invariants.
- `ground_truth_notes.md` — hand-built partial gold (rows 9, 10, 21, 75).
- `INTERVIEW_CHEATSHEET.md` — §3 the reducer's own account of itself; §4 the 92 % and 78 % numbers;
  §7 the zero-hardcoding and frozen-prompt principles.

**survey-qa v1**
- `src/docx.ts` — every defence quoted in §2.2, with the line numbers given there; `entryNames`
  collected at :115 and used only in the error path at :146-151 (§3.0).
- `src/workflow.ts:69-73` — the sole production caller; `return { chars: text.length }` is the entire
  ingestion telemetry. `:53-59` explains the R2 offload (a Workflows step's persisted return is capped
  at ~1 MiB).
- `src/verify.ts:69,84-85` — v1's own verbatim-substring guard; `:148-167` the word-boundary
  `questionId` matcher; `:70-77` the now-unreachable empty-spec warning.
- `src/prompt.ts:19-21,30-39` — `neutralizeDelimiters` and the single `<questionnaire_document>`
  block; the whole spec text is re-sent once per page per leg.
- Commits `ca468da` · `d36cfad` · `1d94dd1` · `9f24eef` — the provenance table in §2.2.
- `test-suite/docx-robustness/FINDINGS.md` — the benchmark, the ranked hazards, and the fix order
  this playbook re-ranks in §10. The harness itself (`build.mjs` read-only transpile, 20 fixtures,
  99 probes, and the `locate()` step that names which OOXML part still holds each lost string) is the
  repo's most valuable QA asset — see §9.2 for why.

**Graphify** — `github.com/Graphify-Labs/graphify`, branch `v8`, commit `00efd6e7` (1 Aug 2026)
- `graphify/detect.py:544-583` (docx), `:527-541` (pdf), `:586-615` (xlsx), `:60` (`_zip_within_caps`).
- `graphify/llm.py:450-457` (the three-line confidence prompt), `:478` (`source_location: null`),
  `:502`, `:654-718` (`_bind_node_evidence`).
- `graphify/extract.py:2271-2274, 2279` (the computed EXTRACTED/INFERRED rule).
- `graphify/validate.py:5,7` (the enum and `REQUIRED_EDGE_FIELDS`).
- `worked/httpx/graph.json` — shipped edge shape.

**survey-qa judge — the existing informal graph (§6.1)**
- `pipeline/judge/lib/route-table.mjs` — graph-S: the `(question, answer) → (screen reached)` table
  built with zero model calls; the E1–E4 edge admission contract (header, 14-24); `admissionRefusal`
  (184-198); `skipped[]` / `integrity[]`; `pathConsistency`; the `Q7 code 3 → Q8` row "that the prose
  verdict denied".
- `pipeline/judge/lib/compile.mjs` — `R-ROUTE-1` (236-303): the typed edge already reconstructed from
  prose by regex, incl. the code-vs-label identity rule (289-294) and the "lazy 'any words' capture
  silently matched the single letter 'Q'" comment (253-255). `R-ROUTE-2` (305-317), `R-QP-1`/`R-QP-2`.
- `pipeline/judge/lib/vocab.mjs` — `COVERAGE` (EXERCISED / NOT_REACHED / PROVEN_UNREACHABLE /
  BLOCKED / PENDING), `OUTCOME`, `REASON`; and the closed-vocabulary discipline §6.5 extends.
- `pipeline/judge/lib/document-model.mjs` — the proto-graph-D, and the docstring that is this
  section's own argument: *"the thing being tested supplied the yardstick used to grade it."*

**survey-qa v2 context**
- `docs/ocr-evidence-research.md` — the 1 Aug owner decision: no OCR anywhere, extraction in-Worker.
- `docs/structured-claim-contract-merged.md` — two independent extraction passes, the source-first
  ledger, the typed diff, and the approval gates §3.4 and §5.4 hook into; and the 2 Aug owner
  decision that extraction ships complete, not phased.
- `docs/cloudflare-document-processing.md` — the measured `toMarkdown` head-to-head folded into §8.3:
  the 78/99-vs-77/99 score, the moved-text silent drop, the UTF-16LE hard failure, the markdown-mode
  escaping trap, the in-band `format:"error"` envelope and the 524/HTML flake, the table-count
  superlinearity, the 4.3 KB / 9.7 KB bundle measurement, and the two benchmark defects it exposed.
- `docs/STATE-OF-PLAY.md` — today, a submission to v2 is stored and **never opened**
  (`reasonCode: "extraction-not-implemented"`). This playbook is the spec for the step that closes
  that.

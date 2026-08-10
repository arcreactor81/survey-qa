# Real-world .docx robustness — what our parser does to documents it did not generate

**Method.** 20 deliberately hostile-but-realistic fixtures, run through the PRODUCTION parser (`src/docx.ts`, transpiled read-only — not a replica). 99 probes. For every failed probe the harness unzips the archive and records which OOXML part still contains the lost string, so each finding comes with proof a fix is possible.

**Result: 9 clean · 6 silent loss · 2 corrupted text · 3 crash.**

**The structural fact behind most of it:** `src/docx.ts` reads exactly ONE archive part, `word/document.xml`. Real .docx files here carry 18–22 parts. Everything in `footnotes.xml`, `endnotes.xml`, `comments.xml`, `header1.xml`, `footer1.xml`, `numbering.xml` and `word/media/*` is invisible.

---

## Ranked by damage to a real run

Crashes are fine — you notice them. **Silent loss** means a requirement nobody extracts and nobody misses. **Corrupted text** is worst: plausible, wrong, and confident.

| # | Hazard | Class | Likelihood | Why it hurts |
|---|---|---|---|---|
| 1 | Word auto-numbering discarded | corruption | very high | Question identity evaporates; output still reads valid; our comparison keys on question numbers |
| 2 | Footnotes/endnotes dropped, no marker | silent loss | high | Where questionnaires park conditional exceptions (soft launch, scope, quotas) |
| 3 | Headers/footers dropped | silent loss | high | Loses per-page rules AND the document's DRAFT status |
| 4 | Comments dropped | silent loss | high | A doc fresh from client review carries live constraints only in comments |
| 5 | Nested tables scramble row pairing | corruption | medium | Routing rows come apart; reads as if a TERMINATE applies globally |
| 6 | Images invisible, alt text discarded | silent loss | high | Emits an empty line — no placeholder, no count, no warning |
| 7 | `w:sym` glyphs dropped | corruption | medium | "≥ 7" becomes "7" — threshold direction lost |
| 8 | `w:noBreakHyphen` dropped | corruption | medium | "T-14" becomes "T14" — a reference code silently changes |
| 9 | Content-control dropdown options dropped | silent loss | medium | A whole answer list vanishes with the sentence intact |
| 10 | vMerge continuation loses its stub | partial | medium | Quota table loses cell grouping |
| 11 | Main part path hardcoded | crash | low-med | A valid questionnaire is rejected |
| 12 | `.doc` upload | crash | high | Correct failure, useless message |
| 13 | Unclosed `<w:tbl>` → quadratic scan | availability | low | 98 KB upload burns 18.5 s CPU; size caps do not help |
| 14 | Deleted paragraph mark not honoured | cosmetic | medium | Sentence splits across two lines |
| 15 | Field with no cached result | silent loss | medium | Silent hole; sentence still reads complete |

### The three that would embarrass us first

**Auto-numbering (rank 1).** Numbers rendered from `w:numPr` + `numbering.xml` are not text anywhere in `document.xml`. `"Q1."`, `"Q2."`, `"a)"`, `"b)"` simply evaporate — while manually typed numbering in the *same* file (Q7a, Q7b_i, a manual Q10, a restart-at-1) survives perfectly. So the document looks ~80% correct and every identifier the comparison stage keys on is gone.

**Footnotes (rank 2).** Not only is the text lost — `w:footnoteReference` is not tokenised either, so **not even a `[1]` marker survives**. Downstream cannot suspect a footnote ever existed.

**Headers (rank 3).** Losing `"DRAFT — NOT FOR FIELD"` is its own hazard: we would QA a superseded draft against a live site and report every difference as a site defect.

---

## Fixes, in the order worth doing them

1. **Read a part SET, not a part.** Ranks 2, 3 and 4 are ONE change: inflate `footnotes.xml`, `endnotes.xml`, `comments.xml`, `header1.xml`, `footer1.xml`, run the existing `extractBlocks` over each, emit with an origin label (`[footnote 3]`, `[header]`, `[comment MD]`). Closes the three highest-likelihood silent losses at once.
   *Design call on comments:* an unresolved comment is a **proposal**, not necessarily the spec. Emitting them as body text will manufacture false discrepancies against a site that correctly implemented the body. Label them and let the comparison stage weigh them. `w:commentsExtended/@w15:done` carries the resolved flag.
2. **Numbering (rank 1).** Inflate `numbering.xml`, resolve `w:numId → abstractNumId → lvl`, keep a per-(numId, ilvl) counter in document order, substitute into `w:lvlText`. **If nothing else ships, emit a placeholder** — `[#] Which supplier…` — because a visible unknown is recoverable and a silent gap is not.
3. **Placeholders for the unreadable** (ranks 6, 7, 15) plus a coverage report. Converts invisible blind spots into visible ones.
4. **Depth-aware tag walker** (ranks 5, 10, 13). Regex cannot express nesting: `<w:tbl…>[\s\S]*?</w:tbl>` terminates on the *inner* close tag. One structural change fixes nested tables, vMerge inheritance and the quadratic blow-up together. *Cheap interim for the DoS:* compare counts of `<w:tbl` and `</w:tbl>` and skip table handling if they differ.
5. **Input triage** (ranks 11, 12). Sniff the first bytes: `D0 CF 11 E0` → "Word 97-2003 binary .doc — open in Word and Save As .docx"; `<?xml` → "Word 2003 XML / Flat OPC"; `%PDF-` → "this is a PDF". Four `startsWith` checks. And resolve the main part through `_rels/.rels` rather than hardcoding `word/document.xml`.
6. **Two-line wins** (ranks 8, 14).

**Cross-cutting, and the real lesson:** every failure in this corpus was survivable except that **none of them said anything**. Whatever v2 extracts must report COVERAGE — which parts it read, which it skipped, how many images/symbols/fields it could not resolve — and label each extracted line with its origin so the comparison stage can weight it.

---

## What the parser already does well

Worth knowing, so nobody rewrites working code:

- **Run fragmentation is perfect.** Mid-word formatting reassembles exactly: `sat`+**`is`**+`fied` → "satisfied", `TER|MIN|ATE` → "TERMINATE", `1`+`8` → "under 18". This is the most common real-world hazard and the most commonly botched.
- **Tracked changes render the accepted final view.** Insertions kept, deletions correctly declined (they are `w:delText`), moved blocks appear once at the new position with no duplication.
- **Text boxes are handled with real care.** A `w:txbxContent` mid-paragraph does not truncate its host, the `mc:Fallback` copy is not double-counted, and legacy VML boxes are captured. Most extractors fail at least one of those three.
- **Unicode is byte-exact.** Curly quotes, dashes, NBSP, fractions, ≥, °C all round-trip — nothing is "helpfully" normalised, which is right, because normalising the en dash in "6–12 months" would change what the comparator sees.
- **Encoding edge cases covered:** UTF-16LE with BOM decodes; a UTF-8 BOM does not leak into line 1; numeric character references decode with a validity guard that refuses lone surrogates.
- **Alternate namespace bindings work** (WML on the default namespace, no `w:` prefix).
- **Long documents are fine:** 64 questions, ~460 paragraphs, 2 ms, no truncation.
- **It fails loudly rather than returning `""`.** The refusal to return an empty spec closes the worst false-pass path. The recommendation is simply to extend that instinct to *partial* specs.

---

## Reproduce

```
cd test-suite/docx-robustness
node gen/gen-docxlib.mjs && node gen/gen-raw-ooxml.mjs   # rebuild fixtures
node build.mjs                                            # transpile src/docx.ts read-only
node run-harness.mjs                                      # → out/*.txt + out/results.json
node perf-probe.mjs                                       # the quadratic-scan measurement
```

`out/results.json` records, per failed probe, which archive part still holds the lost string.

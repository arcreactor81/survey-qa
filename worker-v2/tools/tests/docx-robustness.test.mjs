/**
 * THE .DOCX READER — THE HOSTILE-CORPUS SCORE AS A PERMANENT GATE, AND THE SEAL AS ITS JUDGE.
 *
 * ============================== WHY THIS FILE EXISTS ==============================
 *
 * `test-suite/docx-robustness/` is 20 deliberately hostile documents and 99 probes. It was a
 * one-off measurement run by hand: v1 scored 77, Cloudflare's `toMarkdown` 78, the deployed v2
 * reader 87. A number nothing re-computes is a number that silently stops being true, so the
 * score is now a test — of BOTH the total AND the exact identity of every failing probe, set
 * equal, because a total alone lets one failure swap for another and read as unchanged.
 *
 * ============================ THE LESSON THIS FILE ENCODES ============================
 *
 * The first attempt at the `w:sdt` dropdown fix emitted the recovered options as a single
 * `[dropdown options: a ; b ; c]` blob appended to the host paragraph. THE EXTRACTION PROBE
 * PASSED. Fed through the REAL `extract/expand.ts#parseDocumentedOptions` — the function that
 * re-reads an option set out of the sealed verbatim quote — that blob dropped option 1 and
 * sealed option 4 as `"Time-of-use / Economy 7] SINGLE CODE."`: a label the document never
 * printed, which the option-set predicate would then hunt for on a live screen where it can
 * never appear. A fabricated missing-option accusation with a document quote in front of it is
 * this project's cardinal failure.
 *
 * So: A PARSER CHANGE IS NOT CORRECT BECAUSE THE PARSER TEST PASSES. IT IS CORRECT WHEN THE
 * SEAL STILL READS IT CORRECTLY. `THE SEAL` below is the load-bearing test in this file, and it
 * calls the real production function on the real parser's real output — no fixture quote.
 *
 * ============================== WHAT IS PINNED HERE ==============================
 *
 *   1. THE SCORE. 89/99 on the frozen corpus (87 before this work: fixture 08 NBSP +1,
 *      fixture 11 dropdown +2), and 38/38 on `corpus-v2-extra` — the fixtures the frozen
 *      corpus does not exercise at all. The score stays structural: unsupported semantic
 *      table-header relationships are surfaced as limitations, never rewarded as guesses.
 *      (This line read "31/31" until the corpus-v2-extra fixtures grew past it; the assertion
 *      below has always been the authority, and the prose had quietly stopped matching it.)
 *   2. THE SEAL, above.
 *   3. ONE NAMED TEST PER FIX, so `tools/mutate-docx-blocks.mjs` has something specific to
 *      point its `kills` at. "The score moved" is not proof that a particular guard works.
 *   4. THE COUNTERWEIGHTS. Two failures in this file would be invisible to everything else:
 *      the unreachable-dropdown detector firing on a document where nothing IS unreachable
 *      (a warning that always warns is not a warning), and the collateral profile — the whole
 *      corpus's extracted text must be byte-identical to the pre-change parser except on the
 *      named documents these fixes are about. W6 later adds three deliberate auxiliary-part
 *      discoveries; those are listed with their exact coverage receipts below.
 *   5. THE PRECONDITION OF ITEM 1. The 20 documents are committed; the 99 probes are NOT — they
 *      are git-ignored, so the commonest environment in this repo, a fresh worktree, has the
 *      corpus and none of the instrument. The harness used to score that as `0/99`: an empty
 *      denominator wearing the costume of a measurement, and the score gate then blamed the
 *      CORPUS for it. Absence is now a named refusal naming the environment and the remedy, and
 *      the last suite in this file builds every provisioning state on disk to prove the refusal
 *      fires — and, just as important, that it does NOT fire when the inputs are there.
 *
 * The parser module comes from the suite's own esbuild bundle of `src/**`, not from
 * `test-suite/docx-robustness/build-v2/`, so this gate cannot score a stale artifact and a
 * mutant applied by `testkit.mjs#mutantPlugin` really does reach the code under test.
 */

import { readFileSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as esbuild from "esbuild";
import { assert, assertEq, assertThrows, loadWorker, suite, test, REPO_ROOT } from "../testkit.mjs";
import {
  SUITES,
  scoreSuite,
  probeInputReport,
  probeSupplyTarget,
  CorpusInputsMissingError,
} from "../../../test-suite/docx-robustness/run-harness-v2.mjs";

const CORPUS = join(REPO_ROOT, "test-suite", "docx-robustness", "corpus");
const EXTRA = join(REPO_ROOT, "test-suite", "docx-robustness", "corpus-v2-extra");

const fixture = (dir, name) => new Uint8Array(readFileSync(join(dir, name)));

async function parser() {
  const { mod } = await loadWorker();
  return mod.docxBlocks;
}

const readOut = async (dir, name) => {
  const { parseDocxBlocks, annotate } = await parser();
  const doc = parseDocxBlocks(fixture(dir, name));
  return { doc, text: annotate(doc.blocks) };
};

let promptsModule = null;
async function prompts() {
  if (promptsModule) return promptsModule;
  const built = await esbuild.build({
    entryPoints: [join(REPO_ROOT, "worker-v2", "src", "extract", "prompts.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
  });
  const source = built.outputFiles[0].text;
  promptsModule = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  return promptsModule;
}

const between = (text, open, close) => {
  const prefix = `${open}\n`;
  const start = text.indexOf(prefix);
  const end = text.indexOf(`\n${close}`, start + prefix.length);
  assert(start >= 0 && end > start, `missing bounded prompt payload: ${open}`);
  return text.slice(start + prefix.length, end);
};

suite("MODEL SOURCE JSONL — exact text and structural metadata share one seam", () => {
  test("multiline source survives JSON transport exactly; the legacy display surface is a counterexample", async () => {
    const mod = await parser();
    const text = "First line\r\nSecond \quoted\ line \\ path\nThird line";
    const semanticSpans = [{
      role: "programming-logic",
      profile: "shop-direct-grey-programming/1.0.0",
      runSpans: 2,
    }];
    const blocks = [{
      blockId: "b0042",
      kind: "table-cell",
      text,
      origin: "footnote 7",
      section: "Routing",
      tableId: "t0003",
      coords: { row: 3, col: 2, rowHeader: "Segment", colHeader: "Rule" },
      sourceSubrole: "comment-proposal",
      semanticSpans,
    }, {
      blockId: "b0043",
      kind: "paragraph",
      text: "A plain counterexample remains plain.",
      origin: "body",
      section: null,
      tableId: null,
      coords: null,
      semanticSpans: [],
    }];

    const jsonl = mod.encodeSourceBlocksJsonl(blocks);
    const physicalLines = jsonl.split("\n");
    assertEq(physicalLines.length, blocks.length, "embedded source newlines escaped across JSONL rows");
    assert(jsonl.includes("\\r\\n") && jsonl.includes("\\nThird line"), "newline escapes are absent");
    assert(!jsonl.includes("\r"), "a raw CR split the compact transport");

    const decoded = physicalLines.map((line) => JSON.parse(line));
    assertEq(decoded[0].text, text, "JSON decoding did not restore SourceBlock.text exactly");
    assertEq(decoded[1].text, blocks[1].text);
    assertEq(decoded[0].block_id, "b0042");
    assertEq(decoded[0].kind, "table-cell");
    assertEq(decoded[0].origin, "footnote 7");
    assertEq(decoded[0].section, "Routing");
    assertEq(decoded[0].table_id, "t0003");
    assertEq(JSON.stringify(decoded[0].coords), JSON.stringify(blocks[0].coords));
    assertEq(decoded[0].source_subrole, "comment-proposal");
    assertEq(JSON.stringify(decoded[0].semantic_spans), JSON.stringify(semanticSpans));
    assertEq(decoded[1].source_subrole, null, "legacy-optional subrole is explicit, not omitted");
    assertEq(
      JSON.stringify(Object.keys(decoded[0])),
      JSON.stringify([
        "block_id", "text", "kind", "origin", "section", "table_id", "coords",
        "source_subrole", "semantic_spans",
      ]),
      "the JSONL row contract drifted",
    );

    assert(
      !mod.annotate([blocks[0]]).includes(text),
      "counterproof failed: the old inline display unexpectedly retained the raw multiline source",
    );
  });

  test("A, B, and sweep prompts carry the same parseable lossless JSONL contract", async () => {
    const mod = await parser();
    const p = await prompts();
    const block = {
      blockId: "b0099",
      kind: "paragraph",
      text: "Keep this line.\nAnd this exact second line.",
      origin: "body",
      section: "Closing",
      tableId: null,
      coords: null,
      sourceSubrole: null,
      semanticSpans: [],
    };
    const jsonl = mod.encodeSourceBlocksJsonl([block]);

    assertEq(p.PROMPT_VERSION_A, "v2-extract-pass-a/1.12.0");
    assertEq(p.PROMPT_VERSION_B, "v2-extract-pass-b/1.7.0");
    for (const system of [p.SYSTEM_A, p.SYSTEM_B]) {
      assert(system.includes('after decoding a row, its "text" value is the exact source string'));
      assert(system.includes('"source_subrole"') && system.includes('"semantic_spans"'));
      assert(!system.includes("Every block you are shown is prefixed"), "old display convention survived");
    }
    assert(p.SYSTEM_B.includes('"table_id" and "coords" identify a cell\'s structural position only'));
    assert(p.SYSTEM_B.includes("surface the ambiguity instead of guessing"));
    assert(!p.SYSTEM_B.includes("headers are what say which question"), "invented header authority survived");

    const a = p.userMessageA("ignored.docx", jsonl, "window 1 of 1 (b0099–b0099)");
    const aPayload = between(
      a,
      "===== SOURCE BLOCKS JSONL (one object per physical line) =====",
      "===== END SOURCE BLOCKS JSONL =====",
    );
    assertEq(JSON.parse(aPayload).text, block.text);

    const b = p.userMessageB("ignored.docx", "B-c1", jsonl, jsonl, [block.blockId]);
    const bPayload = between(
      b,
      "===== YOUR SOURCE BLOCKS JSONL — EXTRACT AND DISPOSITION THESE BLOCKS =====",
      "===== END YOUR SOURCE BLOCKS JSONL =====",
    );
    const bContext = between(
      b,
      "===== CONTEXT SOURCE BLOCKS JSONL — DO NOT EMIT OBLIGATIONS OR DISPOSITIONS FOR THESE BLOCKS =====",
      "===== END CONTEXT SOURCE BLOCKS JSONL =====",
    );
    assertEq(JSON.parse(bPayload).text, block.text);
    assertEq(JSON.parse(bContext).text, block.text);

    const sweep = p.userMessageSweep("ignored.docx", "B-s1", jsonl, jsonl, [block.blockId]);
    const sweepPayload = between(
      sweep,
      "===== UNACCOUNTED SOURCE BLOCKS JSONL =====",
      "===== END UNACCOUNTED SOURCE BLOCKS JSONL =====",
    );
    const sweepContext = between(
      sweep,
      "===== CONTEXT SOURCE BLOCKS JSONL — DO NOT DISPOSITION THESE =====",
      "===== END CONTEXT SOURCE BLOCKS JSONL =====",
    );
    assertEq(JSON.parse(sweepPayload).text, block.text);
    assertEq(JSON.parse(sweepContext).text, block.text);
  });
});

/**
 * THE TEN PROBES THAT STILL FAIL ON THE FROZEN CORPUS, BY IDENTITY.
 *
 * Not one of them is a silent loss, and the point of listing them rather than counting them is
 * that a NEW failure cannot hide behind an OLD one being fixed:
 *
 *   5 PROBE-FORMAT ARTIFACTS (03 x2, 15 x2, 17 x1) — tab-joined row regexes written against
 *     v1's flat text. v2 emits one block per cell with (row, col, rowHeader, colHeader)
 *     coords; the pairing they check is preserved, in a different shape. Verified by reading
 *     out-v2/.
 *   2 DELIBERATE POLICY REFUSALS (06 x2) — Word auto-numbering resolved to "[#]" on purpose.
 *     Held in `POLICY_REFUSALS` and asserted separately below.
 *   1 NEEDS OCR (10) — text rendered into PNG pixels. Authored to fail; OCR is closed by owner
 *     ruling (docs/ocr-evidence-research.md).
 *   1 NEEDS A BINARY .doc READER (18) — an OLE2 compound file, refused with a diagnostic that
 *     names the format. A loud refusal, which is the correct outcome, scored as a failure.
 *   1 PROBE-vs-POLICY (16) — `w:noBreakHyphen` is emitted as U+2011, the character the element
 *     means; the probe expects ASCII "-". Emitting ASCII would score 90/99. See the comment on
 *     `noBreakHyphenTag` in docx-blocks.ts for the argument on both sides — it is a real
 *     trade-off, not an oversight.
 *
 * ZERO of the ten are a silent loss of document text.
 */
const KNOWN_FAILING = [
  "03-routing-matrix-table.docx Age 55\\+\\tAsk Q9c\\tAsk Q9c\\tTERMINATE \\(T3\\)",
  "03-routing-matrix-table.docx METRO\\tLondon",
  "10-image-instructions.docx TERMINATE IF ALL ROWS = 1",
  "15-nested-table.docx M4 — Billing\\tTERMINATE if Q46 = 9",
  "15-nested-table.docx Q40 = 2 \\(no smart meter\\)\\tSKIP TO Q45",
  "16-fields-symbols-bom.docx Ref code T-14 applies",
  "17-default-namespace.docx Q56 = 2\\tTERMINATE \\(T12\\)",
  "18-ole2-header.doc WordDocument",
];

const KNOWN_POLICY_FAILING = [
  "06-inconsistent-numbering.docx Q1\\.\\s*Which supplier do you use for gas\\?",
  "06-inconsistent-numbering.docx a\\)\\s*Yes, same supplier",
];

suite("DOCX READER — the hostile corpus is a permanent gate", () => {
  // PROVISIONING IS A PRECONDITION, NOT A RESULT. The 99 probes are git-ignored while the 20
  // documents are committed, so an unprovisioned worktree used to reach the line below with
  // total 0 and fail as "the corpus must still carry 99 probes" — an accusation against the
  // corpus for something only this machine is missing. `scoreSuite` now refuses by name first,
  // so the message names the environment and says what to supply. A properly provisioned run
  // is unaffected: it still scores exactly 89/99 with the same ten failures.
  test("the frozen 20-file corpus scores 89/99 and the FAILING SET is exactly the known ten", async () => {
    const run = scoreSuite(await parser(), SUITES.find((s) => s.id === "corpus"), { write: false });
    assertEq(run.score.total, 99, "the corpus must still carry 99 probes");
    assertEq(run.score.passed, 89, `score moved: ${run.score.failing.concat(run.score.policyFailing).join(" | ")}`);
    // Set equality, not a count: one failure swapping for another must be visible.
    assertEq(
      JSON.stringify(run.score.failing),
      JSON.stringify(KNOWN_FAILING),
      "the identity of the failing probes changed",
    );
    assertEq(
      JSON.stringify(run.score.policyFailing),
      JSON.stringify(KNOWN_POLICY_FAILING),
      "the set of deliberate policy refusals changed",
    );
  });

  test("the fixtures the frozen corpus lacks — gridSpan header, gridBefore, ruby, dropdown values, declared header row — score 38/38", async () => {
    const run = scoreSuite(await parser(), SUITES.find((s) => s.id === "corpus-v2-extra"), { write: false });
    assertEq(run.score.total, 38, "corpus-v2-extra must still carry 38 probes");
    assertEq(run.score.passed, 38, `failing: ${run.score.failing.join(" | ")}`);
  });

  // DELIBERATELY `probes: "unscored"`, AND THE REASON IS COVERAGE HONESTY. This test asserts a
  // property of the DOCUMENTS — all of which are committed — and never reads a probe. Making it
  // demand the git-ignored probes would paint it red on an unprovisioned machine for something
  // it does not measure, which is the mirror image of the bug above: a false alarm rather than a
  // false number. `"unscored"` returns `score: null`, so this test cannot accidentally read a
  // zero as a measurement either.
  test("EVERY document in both corpora parses or refuses LOUDLY — never empty and quiet", async () => {
    const { parseDocxBlocks } = await parser();
    let refusals = 0;
    for (const s of SUITES) {
      const run = scoreSuite(await parser(), s, { write: false, probes: "unscored" });
      for (const r of run.results) {
        if (r.error !== null) {
          refusals += 1;
          assert(r.error.length > 40, `${r.file}: refused with a message too short to act on: ${r.error}`);
          continue;
        }
        const doc = parseDocxBlocks(fixture(s.dir, r.file));
        assert(doc.blocks.length > 0, `${r.file}: parsed to ZERO blocks without throwing`);
      }
    }
    // The OLE2 binary .doc, and only it. An empty requirement set from an unparsed document
    // would read as "the document obliges nothing".
    assertEq(refusals, 1, "the set of documents this parser refuses changed");
  });
});

suite("DOCX READER — THE SEAL still reads what the parser emits", () => {
  test("THE SEAL: parseDocumentedOptions recovers all four dropdown options, every code null, no invented label", async () => {
    const { mod } = await loadWorker();
    const { text } = await readOut(CORPUS, "11-textbox-content-control.docx");

    // THE QUOTE A MODEL WOULD SEAL: the host question line and the option lines beneath it,
    // copied verbatim out of `annotate()` — the exact string pass A and pass B are shown.
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.includes("Q13. Which tariff are you on?"));
    assert(at >= 0, "the host question line is not in the annotated document");
    const displayQuote = lines.slice(at, at + 5).join("\n");

    const recovered = mod.expand.parseDocumentedOptions(displayQuote);
    const expected = [
      { code: null, label: "Fixed-rate, 12 month" },
      { code: null, label: "Fixed-rate, 24 month" },
      { code: null, label: "Standard variable" },
      { code: null, label: "Time-of-use / Economy 7" },
    ];
    assertEq(JSON.stringify(recovered), JSON.stringify(expected), "the seal no longer reads the parser's option lines");

    // THE FABRICATION THE FIRST DRAFT PRODUCED, named so it can never come back unnoticed.
    assert(
      !recovered.some((o) => o.label.includes("SINGLE CODE") || o.label.includes("]")),
      `a label the document never printed was sealed: ${JSON.stringify(recovered)}`,
    );
    // Every label is a substring of the document the parser read. Nothing was composed.
    for (const o of recovered) {
      assert(text.includes(o.label), `sealed label ${JSON.stringify(o.label)} appears nowhere in the document`);
    }

    // AND IT SURVIVES FLATTENING. A model that copies the span onto one line must get the same
    // four options — `[b0008]` and `(list)` are both split tokens, and that is why the option
    // list is emitted as one BLOCK per item rather than as newlines inside one block (annotate
    // turns a newline into " ⏎ ", which `optionLinesOf` does not split on).
    const flat = mod.expand.parseDocumentedOptions(displayQuote.replace(/\n/g, " "));
    assertEq(JSON.stringify(flat), JSON.stringify(expected), "the option set does not survive a one-line quote");
  });

  test("THE SEAL, on Word's DEFAULT dropdown: no code is minted from w:value, and no label is doubled", async () => {
    const { mod } = await loadWorker();
    const { text } = await readOut(EXTRA, "24-dropdown-value-shapes.docx");
    const recovered = mod.expand.parseDocumentedOptions(text);

    // `w:value` == `w:displayText` is what Word writes by default; a value-as-code rule emits
    // "Yes, definitely) Yes, definitely", which CODED_OPTION does not match, so the DOUBLED
    // STRING becomes the sealed label. And numeric values are the shape that makes such a rule
    // look correct on a fixture.
    for (const o of recovered) {
      assertEq(o.code, null, `a code was minted for ${JSON.stringify(o.label)}; w:value is never printed`);
      assert(!/(.{6,})\)\s*\1/.test(o.label), `a doubled value-as-code label was sealed: ${JSON.stringify(o.label)}`);
    }
    for (const label of ["Yes, definitely", "Prefer not to say", "Under 20 GBP", "20 to 40 GBP"]) {
      assert(recovered.some((o) => o.label === label), `the seal lost ${JSON.stringify(label)}: ${JSON.stringify(recovered)}`);
    }
  });
});

suite("DOCX READER — one named guard per fix", () => {
  // EVERY INVISIBLE CODEPOINT IN THIS FILE IS AN ESCAPE, NEVER A LITERAL, and that is not
  // fussiness. Written as a literal, a U+00A0 and a U+0020 are the same picture: the first
  // draft of this very test typed a plain space, asserted a string the document does not
  // contain, and went red against a parser that was already correct. An expectation nobody
  // can READ is an expectation nobody can review — and the same confusion in the other
  // direction is a test that passes while asserting the wrong thing.
  test("U+00A0 survives the parse byte-for-byte — a comparator may fold, a parser may not", async () => {
    const { text } = await readOut(CORPUS, "08-unicode-punctuation.docx");
    // The document holds TWO of them in this phrase: £100<U+00A0>per<U+00A0>month.
    assert(text.includes(`£100\u00a0per\u00a0month`), "a non-breaking space was rewritten to U+0020");
    // And the collapsed form — what the parser produced before this fix — is absent.
    assert(!text.includes("£100 per month"), "U+00A0 is still being folded to U+0020 somewhere");
    // The characters v2 never touched, held here so a future "tidy" cannot take them either.
    for (const ch of ["\u2019", "\u201c", "\u2013", "\u2014", "\u2265", "\u2026", "\u00bd"]) {
      assert(text.includes(ch), `U+${ch.codePointAt(0).toString(16)} did not survive the parse`);
    }
  });

  test("w:noBreakHyphen becomes U+2011 and w:softHyphen leaves nothing behind", async () => {
    const { text } = await readOut(CORPUS, "16-fields-symbols-bom.docx");
    assert(text.includes("Ref code T\u201114 applies"), "w:noBreakHyphen was dropped: T-14 became T14");
    assert(!/T14/.test(text), "the hyphen is still being dropped somewhere");
    // A soft hyphen is invisible unless the line breaks there, and where the line breaks is a
    // rendering fact this parser does not have. Emitting U+00AD would put a codepoint in the
    // middle of a word that no screen and no model will ever reproduce.
    assert(!text.includes("\u00ad"), "w:softHyphen emitted U+00AD into the middle of a word");
    assert(text.includes("Median LOI"), "the soft-hyphen paragraph did not survive at all");
  });

  test("gridSpan advances exact grid coordinates without inventing semantic column headers", async () => {
    const { doc, text } = await readOut(EXTRA, "21-gridspan-header-vmerge.docx");
    assert(text.includes("(cell r2c3) aware-no"), "the spanned cell did not advance the next answer to grid column 3");
    assert(text.includes("(cell r2c4) weekly"), "Usage data is grid column 4, not array position 3");
    assert(text.includes("(cell r2c5) 42 GBP"), "the last grid column was dropped entirely");
    assert(!text.includes(' col="'), "WordprocessingML supplied no semantic column scope, but one was invented");
    assert(
      doc.coverage.problems.some((p) => /TABLE_GRID_SPANS_PRESENT/.test(p) && /r1c2=span2/.test(p)),
      "the exact gridSpan was not named in parser coverage",
    );
  });

  test("a cell spanning the whole grid is given NO column header rather than the first one's", async () => {
    const { text } = await readOut(CORPUS, "03-routing-matrix-table.docx");
    assert(
      text.includes("(cell r6c1) ALL CELLS — screener applies before quota check"),
      "a full-width footer row was filed under a single column",
    );
  });

  test("vMerge is retained as a counted structural limitation, never promoted to semantic rowHeader", async () => {
    const { doc, text } = await readOut(CORPUS, "03-routing-matrix-table.docx");
    assert(text.includes("(cell r2c1) METRO"), "the explicit restart-cell text was lost");
    assert(text.includes("(cell r3c2) Manchester"), "the continuation row's explicit text was lost");
    assert(!text.includes('row="METRO"'), "adjacency to a vertical merge was promoted to unsupported semantic scope");
    assert(
      doc.coverage.problems.some((p) => /TABLE_VERTICAL_MERGE_PRESENT/.test(p)),
      "the vertical-merge limitation was not counted",
    );
    // 1.8.0: inherited blocks are emitted at continuation rows
    const inherited = doc.blocks.filter((b) => b.sourceSubrole === "vmerge-inherited");
    assert(inherited.length > 0, "no vmerge-inherited blocks were emitted for continuation rows");
    assert(inherited.every((b) => b.origin.includes("vmerge-inherited from")), "inherited blocks lack origin provenance");
  });

  test("a late w:tblHeader repeat flag is ignored and reported, never treated as semantic th/scope", async () => {
    const { doc, text } = await readOut(EXTRA, "26-tblheader-not-row-0.docx");
    assert(!text.includes('col="Aware"'), "repeat-on-page metadata was promoted to a semantic column header");
    assert(!text.includes('col="Use"'), "the same promotion happened on the next column");
    assert(!text.includes('col="Table 4'), "the title row became an inferred column header");
    assert(text.includes("(cell r1c1) Table 4 — Awareness by region"), "the full-width title row was filed under a column");
    assert(
      doc.coverage.problems.some((p) => /TABLE_REPEAT_FLAG_IGNORED/.test(p) && /row\(s\) 2/.test(p)),
      "the invalid non-leading repeat flag was not reported",
    );
  });

  // NOT MUTATION-PROVED, AND THE REASON IS THE POINT. Removing the MAX_GRID_COLUMNS clamp does
  // not make the suite fail — it makes the RUNNER die, building a hundred million Map entries.
  // `mutate-runner.mjs` would score that as NO-RUN, and reading a crash as a result is one of
  // the twelve confirmed instances of this repo's chronic disease. So the guard is proved by a
  // fixture that is deterministic and cheap instead: the clamp is OBSERVABLE in the output.
  test("a gridSpan DECOMPRESSION BOMB is clamped, not chased — 886 bytes may not burn a Worker", async () => {
    const { text } = await readOut(EXTRA, "27-gridspan-bomb.docx");
    assert(text.includes("Q40. Ordinary question above a hostile table."), "a hostile table took the document with it");
    assert(text.includes("(cell r1c1) A"), "the spanning cell was dropped");
    // 99,999,999 declared; nothing may claim a five-digit grid column.
    assert(!/c[0-9]{5,}/.test(text), "an unclamped span ran away into the coordinates");
  });

  test("a gridBefore row starts at its declared structural grid column without inferred headers", async () => {
    const { text } = await readOut(EXTRA, "22-gridbefore-ragged-row.docx");
    assert(text.includes("(cell r3c2) no"), "the skipped grid column was not counted");
    assert(text.includes("(cell r3c3) monthly"), "the next cell did not retain the shifted coordinate");
    assert(!text.includes("(cell r3c1) no"), "the ragged row was incorrectly started at column 1");
  });

  test("ruby base text is exact and each visible reading is a separately addressable non-inline block", async () => {
    const { doc, text } = await readOut(EXTRA, "23-ruby-furigana.docx");
    const body = doc.blocks.find((b) => b.origin === "body" && b.text.startsWith("Q17."));
    assertEq(body?.text, "Q17. 電気の契約について。", "the visible base sentence is not byte-exact");
    const readings = doc.blocks.filter((b) => b.origin.startsWith("ruby-reading"));
    assertEq(JSON.stringify(readings.map((b) => b.text)), JSON.stringify(["でんき", "けいやく"]), "ruby readings were lost");
    assert(readings[0].origin.includes('base="電気"'), "the first reading lost its base association");
    assert(readings[1].origin.includes('base="契約"'), "the second reading lost its base association");
    assert(!body.text.includes("でんき電気"), "the reading was interleaved into a fake base word");
    assert(text.includes("[ruby-reading;"), "the separately addressable reading is absent from annotated text");
    assert(
      doc.coverage.problems.some((p) => /2 ruby annotation\(s\).*2 reading\(s\) recovered.*0 unreadable/.test(p)),
      "ruby coverage does not reconcile recovered and unreadable readings",
    );
  });

  test("a dropdown's options are ADDED beside the control, never substituted for its own text", async () => {
    const { text } = await readOut(CORPUS, "11-textbox-content-control.docx");
    assert(text.includes("Q13. Which tariff are you on?"), "text before the inline control was lost");
    assert(text.includes("SINGLE CODE."), "text after the inline control was lost");
    assert(text.includes("Choose an item."), "the control's own placeholder run was replaced rather than kept");
    assert(text.includes("(list) Time-of-use / Economy 7"), "an option that exists only as an attribute was lost");
  });
});

suite("DOCX READER — North-Star negative and metamorphic guards", () => {
  test("NO Word table row or first column becomes semantic scope; repeat metadata is separately validated", async () => {
    const { doc, text } = await readOut(EXTRA, "28-table-header-ambiguity.docx");
    const cells = doc.blocks.filter((b) => b.kind === "table-cell");
    assert(cells.length > 0, "the table fixture produced no cells");
    for (const cell of cells) {
      assertEq(cell.coords.rowHeader, null, `${cell.blockId}: a semantic rowHeader was guessed`);
      assertEq(cell.coords.colHeader, null, `${cell.blockId}: a semantic colHeader was guessed`);
    }
    assert(!text.includes(' row="') && !text.includes(' col="'), "annotated text contains an invented semantic header");
    const ambiguity = doc.coverage.problems.filter((p) => /TABLE_HEADER_SEMANTICS_AMBIGUOUS/.test(p));
    assertEq(ambiguity.length, 4, `not every table carried a computed ambiguity limitation: ${ambiguity.join(" | ")}`);
    assert(
      doc.coverage.problems.some((p) => /TABLE_REPEAT_FLAG_IGNORED/.test(p) && /t1/.test(p)),
      "the late/non-contiguous repeat flag was not reported",
    );
    assert(
      doc.coverage.problems.some((p) => /TABLE_MULTI_ROW_REPEAT_HEADER/.test(p) && /2 contiguous/.test(p)),
      "the contiguous multi-row repeat structure was not named",
    );
    assert(text.includes("--- table t2 ---") && text.includes("(cell r1c1) Key"), "the two-column ambiguity was dropped");
    assert(text.includes("--- table t3 ---") && text.includes("(cell r1c1) North"), "the all-data first row was dropped");
  });

  test("comboBox suggestions are exact non-option blocks and cannot seal as an exhaustive option set", async () => {
    const { mod } = await loadWorker();
    const { doc, text } = await readOut(EXTRA, "29-combobox-open-suggestions.docx");
    const current = doc.blocks.find((b) => b.origin === "body" && b.text.includes("Q51."));
    assert(current?.text.includes("Green"), "the current free-form value, absent from suggestions, was lost");
    const suggestions = doc.blocks.filter((b) => b.origin === "combo-box-suggestion");
    assertEq(JSON.stringify(suggestions.map((b) => b.text)), JSON.stringify(["Red", "Blue"]), "suggestion labels changed");
    assert(suggestions.every((b) => b.kind === "paragraph"), "a combo suggestion became an ordinary list-item option");
    assert(!doc.blocks.some((b) => b.kind === "list-item"), "the open combo was emitted as a closed option list");
    const sealed = mod.expand.parseDocumentedOptions(text);
    assert(!sealed.some((o) => o.label === "Red" || o.label === "Blue"), `combo suggestions reached the option seal: ${JSON.stringify(sealed)}`);
    assert(
      doc.coverage.problems.some(
        (p) =>
          /1 combo-box content control/.test(p) &&
          /3 open suggestion item/.test(p) &&
          /2 non-empty label/.test(p) &&
          /2 emitted/.test(p) &&
          /1 unreadable/.test(p) &&
          /2 recovered \+ 1 unreadable = 3 declared/.test(p),
      ),
      `combo denominator does not reconcile: ${JSON.stringify(doc.coverage.problems)}`,
    );
  });

  test("gridSpan/gridBefore values are namespace, quote and whitespace metamorphic; malformed values are named", async () => {
    const { doc } = await readOut(EXTRA, "30-grid-attribute-shapes.docx");
    const shape = (tableId) =>
      doc.blocks
        .filter((b) => b.tableId === tableId)
        .map((b) => ({ text: b.text, row: b.coords.row, col: b.coords.col }));
    assertEq(JSON.stringify(shape("t2")), JSON.stringify(shape("t1")), "equivalent XML attribute serializations parsed differently");
    const t2 = shape("t2");
    assert(t2.some((b) => b.text === "Tail" && b.col === 3), "single-quoted alternate-prefix gridSpan was ignored");
    assert(t2.some((b) => b.text === "Offset-A" && b.col === 2), "single-quoted alternate-prefix gridBefore was ignored");
    for (const pattern of [
      /gridSpan> is present without a val attribute/,
      /gridSpan> has invalid integer value "NaN"/,
      /gridBefore> value "-1" is outside the valid range/,
      /gridSpan> value 99999999 exceeds the .* safety bound and was clamped/,
    ]) {
      assert(doc.coverage.problems.some((p) => pattern.test(p)), `missing grid validation diagnostic ${pattern}`);
    }
  });

  test("accepted view excludes deleted/moved-from controls and old property snapshots, but keeps replacements", async () => {
    const { doc, text } = await readOut(EXTRA, "31-accepted-view-controls.docx");
    const options = doc.blocks.filter((b) => b.kind === "list-item").map((b) => b.text);
    assertEq(JSON.stringify(options), JSON.stringify(["Live A", "Live B", "Moved-new C"]), "accepted option metadata is wrong");
    for (const rejected of ["Deleted A", "Deleted B", "Moved-old A", "Stale snapshot"]) {
      assert(!text.includes(rejected), `rejected/old metadata leaked into accepted output: ${rejected}`);
    }
    const ordinary = doc.blocks.find((b) => b.text.includes("Ordinary accepted paragraph."));
    assertEq(ordinary?.kind, "paragraph", "an old pPrChange snapshot fabricated heading/list semantics");
    assert(!ordinary.text.startsWith("[#]"), "an old numbering snapshot fabricated an auto-number marker");
    assert(text.includes("Live A") && text.includes("Moved-new C"), "inserted/moved-to replacements were dropped");
    assert(
      doc.coverage.problems.some(
        (p) => /ACCEPTED_VIEW_FILTER_APPLIED/.test(p) && /2 deleted\/moved-from/.test(p) && /2 superseded property/.test(p),
      ),
      `accepted-view denominator is absent: ${JSON.stringify(doc.coverage.problems)}`,
    );
    assert(
      doc.coverage.problems.some((p) => /ACCEPTED_VIEW_LEAF_REVISIONS_UNINTERPRETED/.test(p) && /1 row\/cell\/paragraph-mark/.test(p)),
      "unimplemented leaf-level revision semantics were not counted",
    );
  });
});

suite("DOCX READER — the counterweights", () => {
  test("a BLOCK-LEVEL dropdown the paragraph scan cannot reach is COUNTED AND NAMED, never silently short", async () => {
    const { doc, text } = await readOut(EXTRA, "25-dropdown-block-level.docx");
    const named = doc.coverage.problems.filter((p) => /dropdown-list content control/.test(p));
    assertEq(named.length, 1, `the unreachable control was not reported: ${JSON.stringify(doc.coverage.problems)}`);
    assert(/1 dropdown/.test(named[0]), `the report does not carry a count: ${named[0]}`);
    assert(/NOT extracted/.test(named[0]), `the report does not say what was lost: ${named[0]}`);
    // And it did NOT guess the options into existence.
    assert(!text.includes("Zone A"), "options were emitted from a control the scan never reached");
    // The document around it is still read.
    assert(text.includes("Q30. Which zone are you in?"), "the paragraph before a block-level control was lost");
  });

  test("A WARNING THAT ALWAYS WARNS IS NOT A WARNING: an inline dropdown reports nothing unreachable", async () => {
    for (const [dir, name] of [
      [CORPUS, "11-textbox-content-control.docx"],
      [EXTRA, "24-dropdown-value-shapes.docx"],
    ]) {
      const { doc } = await readOut(dir, name);
      const named = doc.coverage.problems.filter((p) => /dropdown-list content control/.test(p));
      assertEq(named.length, 0, `${name}: reported an unreachable control where every one is inline: ${named[0]}`);
    }
  });

  test("THE COLLATERAL PROFILE: only the named public fixtures change, and auxiliary discovery has exact receipts", async () => {
    // Byte-for-byte, against extraction output captured from the parser as it was BEFORE this
    // work (test-suite/docx-robustness/out-v2-prechange/). A merged-cell rewrite that also
    // moved an unrelated document would pass every test above and be invisible.
    const { parseDocxBlocks, annotate } = await parser();
    // `probes: "unscored"` — this test compares extracted TEXT against the pre-change captures
    // and enumerates documents; it never reads a probe. See the note on the parse/refuse test.
    const run = scoreSuite(await parser(), SUITES.find((s) => s.id === "corpus"), { write: false, probes: "unscored" });
    const changed = [];
    const auxiliaryReceipts = {};
    const expectedAuxiliaryReceipts = {
      "02-comments.docx": [
        "COMMENT_COVERAGE: 3 declared comment(s): 3 readable and 0 unreadable/empty placeholder(s). Every declared comment remains counted and labelled as a proposal.",
        "COMMENT_FORMATTING_NOT_PRESERVED: 3 Word comment block(s) retain visible text, but comment formatting proves no document semantics. Comments remain labelled proposals.",
      ],
      "04-footnote-endnote-rule.docx": [
        "2 footnote(s) produced 2 addressable block(s) read from word/footnotes.xml; they remain independently originated source, not decoration.",
        "1 endnote(s) produced 1 addressable block(s) read from word/endnotes.xml; they remain independently originated source, not decoration.",
      ],
      "07-header-footer-watermark.docx": [
        "2 addressable block(s) came from word/header1.xml; identical text in another header part remains distinct because part identity is source evidence.",
        "1 addressable block(s) came from word/footer1.xml; identical text in another footer part remains distinct because part identity is source evidence.",
      ],
    };
    for (const r of run.results) {
      if (r.error !== null) continue;
      let before;
      try {
        before = readFileSync(
          join(REPO_ROOT, "test-suite", "docx-robustness", "out-v2-prechange", `${r.file}.txt`),
          "utf8",
        );
      } catch {
        throw new Error(`no pre-change capture for ${r.file}; the collateral profile cannot be checked`);
      }
      const doc = parseDocxBlocks(fixture(CORPUS, r.file));
      const now = annotate(doc.blocks);
      if (now !== before) changed.push(r.file);
      const expected = expectedAuxiliaryReceipts[r.file];
      if (expected) {
        const prefix = r.file === "02-comments.docx" ? /^COMMENT_/ :
          r.file === "04-footnote-endnote-rule.docx" ? /^(?:\d+ footnote|\d+ endnote)/ :
          /^\d+ addressable block\(s\) came from word\/(?:header|footer)1\.xml/;
        auxiliaryReceipts[r.file] = doc.coverage.problems.filter((problem) => prefix.test(problem));
      }
    }
    assertEq(
      JSON.stringify(changed),
      JSON.stringify([
        "02-comments.docx",
        "03-routing-matrix-table.docx",
        "04-footnote-endnote-rule.docx",
        "07-header-footer-watermark.docx",
        "08-unicode-punctuation.docx",
        "11-textbox-content-control.docx",
        "15-nested-table.docx",
        "16-fields-symbols-bom.docx",
        "17-default-namespace.docx",
      ]),
      "the set of documents whose extraction changed is not the set these fixes are about",
    );
    assertEq(
      JSON.stringify(auxiliaryReceipts),
      JSON.stringify(expectedAuxiliaryReceipts),
      "auxiliary-part discovery changed without its exact named coverage receipts",
    );
  });
});

/**
 * ================= THE GATE'S OWN PROVISIONING GUARD — THE NEGATIVE PROOF =================
 *
 * The corpus gate above is only a gate where the corpus can actually be scored. The 20 documents
 * are COMMITTED; the 99 probes are GIT-IGNORED. So the single most likely environment in this
 * repo — a fresh worktree — has a corpus directory full of documents and no probes at all, and
 * the harness used to answer that with `passed: 0, total: 0`: an empty denominator dressed as a
 * measurement, which is the exact failure mode CLAUDE.md's "beware the check that cannot fail"
 * rule exists to stop.
 *
 * These tests build each provisioning state on disk and prove the refusal fires by NAME. Every
 * one of them runs identically whether or not THIS machine has the real probes, because the
 * fixtures are temporary directories the test creates itself — a guard that can only be tested
 * on a broken machine is a guard nobody tests.
 *
 * The last three are the counterweights, and they carry the weight: a refusal that fires
 * unconditionally would pass every test above while making the corpus permanently unscorable.
 */
const TEMP_SUITE_DEFAULTS = {
  probeGlob: "_probes-*.json",
  gitIgnoredProbes: true,
  regenerateWith: "node test-suite/docx-robustness/gen/gen-docxlib.mjs",
};

const DOC = "08-unicode-punctuation.docx";
const NAMED = "probe corpus inputs absent — this environment cannot score the corpus";
// A known-TRUE and a known-FALSE probe over the SAME impossible string — `absent` must hold and
// `present` must not, whatever the parser emits. Quoting real document text here would have been
// the obvious choice and is the wrong one twice over: it couples a test about the SCORER to the
// parser's output, so any unrelated docx-blocks mutant drags these tests red as collateral, and
// it invites an invisible-codepoint literal (the corpus's U+00A0 phrase is the nearest one) into
// an assertion no reviewer can read.
const IMPOSSIBLE = "ZZ-NOT-IN-ANY-DOCUMENT-QQ";
const PASSING_PROBE = { kind: "absent", text: IMPOSSIBLE, why: "known-true: in no document", severity: "high" };
const FAILING_PROBE = { kind: "present", text: IMPOSSIBLE, why: "known-false: in no document", severity: "high" };
const probeManifest = (probes) => JSON.stringify([{ file: DOC, hazard: "temp", probes }]);

/**
 * A throwaway corpus. Documents are copied from the committed frozen corpus — they are in git,
 * so this works on any checkout — while probes are written here, so each provisioning state is
 * BUILT exactly rather than simulated.
 */
async function withTempCorpus({ documents = [], probeFiles = {}, declared }, fn) {
  const dir = mkdtempSync(join(tmpdir(), "docx-corpus-gate-"));
  try {
    for (const doc of documents) copyFileSync(join(CORPUS, doc), join(dir, doc));
    for (const [name, body] of Object.entries(probeFiles)) writeFileSync(join(dir, name), body, "utf8");
    await fn({ ...TEMP_SUITE_DEFAULTS, id: "temp-corpus", dir, out: join(dir, "_out"), probeFiles: declared });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

suite("DOCX READER — an unprovisioned environment is REFUSED, never scored as zero", () => {
  test("an EMPTY corpus directory is refused by name instead of scoring 0/0", async () => {
    const p = await parser();
    await withTempCorpus({ declared: ["_probes-docxlib.json", "_probes-raw.json"] }, async (s) => {
      const err = await assertThrows(
        () => scoreSuite(p, s, { write: false }),
        NAMED,
        "an empty corpus directory did not produce the named refusal",
      );
      assert(err instanceof CorpusInputsMissingError, `wrong error type: ${err.name}`);
      assert(err.message.includes("does not exist") || err.message.includes("contains no .docx"),
        `the refusal does not say the documents are absent: ${err.message}`);
      assert(err.message.includes("REFUSING to report a score over an absent denominator"),
        "the refusal does not state that it declined to report a number");
    });
  });

  test("THE FRESH-WORKTREE SHAPE — documents present, probes absent — names the missing inputs and the git-ignore cause", async () => {
    const p = await parser();
    await withTempCorpus({ documents: [DOC], declared: ["_probes-docxlib.json", "_probes-raw.json"] }, async (s) => {
      const err = await assertThrows(() => scoreSuite(p, s, { write: false }), NAMED, "the real defect shape was not refused");
      // It must name BOTH inputs, or an operator fixes half the problem and hits it again.
      assert(err.message.includes("_probes-docxlib.json"), `first missing input unnamed: ${err.message}`);
      assert(err.message.includes("_probes-raw.json"), `second missing input unnamed: ${err.message}`);
      // And it must blame the ENVIRONMENT, not the corpus. This is the whole point of the fix.
      assert(err.message.includes("GIT-IGNORED"), "the refusal does not explain why this machine lacks them");
      assert(err.message.includes("NOT a corpus regression"), "the refusal still lets the corpus take the blame");
      assert(err.message.includes(TEMP_SUITE_DEFAULTS.regenerateWith), "the refusal does not say how to regenerate them");
      // The document set is intact here, so it must NOT be reported as missing.
      assert(!err.message.includes("contains no .docx"), `documents were present but reported absent: ${err.message}`);
    });
  });

  test("PARTIAL provisioning is refused rather than scored over a silently shrunken denominator", async () => {
    const p = await parser();
    await withTempCorpus({
      documents: [DOC],
      probeFiles: { "_probes-docxlib.json": probeManifest([PASSING_PROBE, FAILING_PROBE]) },
      declared: ["_probes-docxlib.json", "_probes-raw.json"],
    }, async (s) => {
      // The old `existsSync` filter would have scored these 2 probes and called it a corpus run.
      const report = probeInputReport(s);
      assertEq(report.probeCount, 2, "fixture drift: the partial input should hold exactly 2 probes");
      assertEq(report.missing.length, 1, "fixture drift: exactly one declared input should be missing");
      const err = await assertThrows(() => scoreSuite(p, s, { write: false }), NAMED, "a half-provisioned corpus was scored");
      assert(err.message.includes("_probes-raw.json"), `the absent half was not named: ${err.message}`);
    });
  });

  test("a probe input that declares ZERO probes is refused; a present file is not the same as a present denominator", async () => {
    const p = await parser();
    await withTempCorpus({
      documents: [DOC],
      probeFiles: { "_probes-docxlib.json": probeManifest([]), "_probes-raw.json": "[]" },
      declared: ["_probes-docxlib.json", "_probes-raw.json"],
    }, async (s) => {
      const err = await assertThrows(() => scoreSuite(p, s, { write: false }), NAMED, "an empty probe set was scored as a result");
      assert(err.message.includes("declaring zero probes"), `the empty denominator was not named: ${err.message}`);
    });
  });

  test("an UNREADABLE probe input is refused by name, never quietly skipped", async () => {
    const p = await parser();
    await withTempCorpus({
      documents: [DOC],
      probeFiles: { "_probes-docxlib.json": "{ this is not json", "_probes-raw.json": probeManifest([PASSING_PROBE]) },
      declared: ["_probes-docxlib.json", "_probes-raw.json"],
    }, async (s) => {
      const err = await assertThrows(() => scoreSuite(p, s, { write: false }), NAMED, "a corrupt probe input was skipped");
      assert(err.message.includes("unreadable probe input"), `corruption was not named: ${err.message}`);
      assert(err.message.includes("_probes-docxlib.json"), "the corrupt file was not identified");
    });
  });

  // ------------------------------------------------------------------ THE COUNTERWEIGHTS

  test("A REFUSAL THAT ALWAYS REFUSES IS NOT A GUARD: a provisioned corpus scores, and the score discriminates", async () => {
    const p = await parser();
    await withTempCorpus({
      documents: [DOC],
      probeFiles: { "_probes-docxlib.json": probeManifest([PASSING_PROBE, FAILING_PROBE]) },
      declared: ["_probes-docxlib.json"],
    }, async (s) => {
      const run = scoreSuite(p, s, { write: false });
      assertEq(run.score.total, 2, "a fully provisioned suite did not score its declared probes");
      // 1 of 2, not 2 of 2 and not 0 of 2 — the scorer still tells true from false.
      assertEq(run.score.passed, 1, "the scorer stopped discriminating between a true and a false probe");
      assertEq(run.score.failing.length, 1, "the failing probe was not reported by identity");
      assert(run.score.failing[0].includes(IMPOSSIBLE), "the wrong probe was reported failing");
      // The document really was parsed — a 1-of-2 over an unparsed file would be a different bug.
      assert(run.results[0].blocks > 0, "the counterweight scored without the document being read");
    });
  });

  test("NOT SCORED IS NULL, NEVER ZERO: an unscored run returns parse results and no score at all", async () => {
    const p = await parser();
    await withTempCorpus({ documents: [DOC], declared: ["_probes-docxlib.json", "_probes-raw.json"] }, async (s) => {
      // Probes absent — but this caller never asked for a score, so it must NOT be refused.
      const run = scoreSuite(p, s, { write: false, probes: "unscored" });
      assertEq(run.score, null, "an unscored run produced a score object a caller could misread as a measurement");
      assertEq(run.results.length, 1, "the unscored run lost the parse results it exists to provide");
      assertEq(run.results[0].file, DOC);
      assert(run.results[0].blocks > 0, "the document was not actually parsed");
    });
  });

  test("even an unscored run refuses an empty document set — the other empty denominator", async () => {
    const p = await parser();
    await withTempCorpus({ declared: ["_probes-docxlib.json"] }, async (s) => {
      await assertThrows(
        () => scoreSuite(p, s, { write: false, probes: "unscored" }),
        NAMED,
        "a corpus with no documents was walked as though it had been checked",
      );
    });
  });

  test("the refusal points at the REAL frozen-corpus path, and every declared suite can produce one", async () => {
    // Pinned from the suite declaration, so it holds on a provisioned machine too — the exact
    // string an operator is told to supply, matching .gitignore's own pattern.
    assertEq(
      probeSupplyTarget(SUITES.find((s) => s.id === "corpus")),
      "test-suite/docx-robustness/corpus/_probes-*.json",
      "the refusal would send an operator to the wrong path",
    );
    for (const s of SUITES) {
      assert(Array.isArray(s.probeFiles) && s.probeFiles.length > 0, `${s.id}: declares no probe inputs`);
      assert(typeof s.probeGlob === "string" && s.probeGlob.length > 0, `${s.id}: no probeGlob for the diagnostic`);
      assert(typeof s.gitIgnoredProbes === "boolean", `${s.id}: does not state whether its probes are git-ignored`);
      assert(typeof s.regenerateWith === "string" && s.regenerateWith.length > 0, `${s.id}: no regeneration command`);
    }
  });
});

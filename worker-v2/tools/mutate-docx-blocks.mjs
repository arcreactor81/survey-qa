/**
 * DOCX READER MUTANTS — CAN THE PARSER'S NEW GUARDS ACTUALLY FAIL?
 *
 * `tests/docx-robustness.test.mjs` was written by the same hand that wrote the parser change,
 * and this repository has shipped, repeatedly, checks structurally incapable of failing: a
 * 340/340 suite that shipped a one-second crash, a mutation harness that could not mutate
 * `.mjs` at all, a boundary test that typed the literal string `<exactly 500 characters>` (24
 * of them) and reported PASS. "16/16 passed" is not evidence until every guard has been broken
 * and seen to redden the test that names it.
 *
 * ==================== THE MUTANTS ARE THE REJECTED DESIGNS ====================
 *
 * Most of these are not invented breakages. They are the OTHER implementation each decision
 * was chosen over, run as code:
 *
 *   - the `[dropdown options: …]` BLOB the first draft of the `w:sdt` fix actually emitted,
 *     which passed its extraction probe and fed the seal a label the document never printed;
 *   - `w:value` minted as an answer CODE, which is what the proposed patch did — correct-looking
 *     on the one corpus fixture whose values are 1..4, and a doubled fabricated label on the
 *     Word default where `w:value` == `w:displayText`;
 *   - `w:displayText` required, which silently drops an item that has only a `w:value` — and
 *     which the corpus cannot see, because every item in it has both;
 *   - the U+00A0 fold, restored;
 *   - the unreachable-dropdown detector wired ON and OFF, because a warning that always warns
 *     and a warning that never warns are the same non-warning.
 *
 * Every mutation is applied inside esbuild's load step (`testkit.mjs#mutantPlugin`) and NOTHING
 * is written under `src/**`, which is what makes this safe to run while other agents are
 * editing the tree.
 *
 * ==================== ONE GUARD IS DELIBERATELY NOT MUTATED ====================
 *
 * `MAX_GRID_COLUMNS`. Removing that clamp does not fail the suite — it KILLS THE RUNNER, which
 * tries to build a hundred million header-map entries from an 886-byte document. `judge()`
 * would score that NO-RUN, and reading a crash as a result is one of the twelve confirmed
 * instances of this repo's chronic disease. It is proved instead by a deterministic fixture
 * whose output makes the clamp visible: `27-gridspan-bomb.docx`, and the test named
 * "a gridSpan DECOMPRESSION BOMB is clamped, not chased".
 *
 *   node tools/mutate-docx-blocks.mjs
 */

import { runMutantSuite } from "./mutate-runner.mjs";

// The FINDING-B1 mutants (table cells folding combo/ruby drafts back into plain cell text —
// the 1.1.0 behaviour) live in tools/mutate-source-roles.mjs, NOT here: their guard tests are
// in the D50 suite, and this harness's "DOCX READER" filter never runs D50, so a kill named
// here could never be proven (permanent SURVIVED over a baseline that lacks the guard).

const DOCX = "src/extract/docx-blocks.ts";

const SCORE_GATE = "the frozen 20-file corpus scores 89/99 and the FAILING SET is exactly the known ten";
const EXTRA_GATE =
  "the fixtures the frozen corpus lacks — gridSpan header, gridBefore, ruby, dropdown values, declared header row — score 31/31";
const SEAL = "THE SEAL: parseDocumentedOptions recovers all four dropdown options, every code null, no invented label";
const SEAL_VALUES = "THE SEAL, on Word's DEFAULT dropdown: no code is minted from w:value, and no label is doubled";

const MUTANTS = [
  // ============================================================ the option seam
  {
    name: "the dropdown options are emitted as ONE joined blob instead of one block per item",
    breaks:
      "the exact shape the first draft shipped: the seal reads the joined string as a SINGLE option label, so the " +
      "predicate hunts a live screen for a phrase the document never printed",
    file: DOCX,
    find: "  return dropdownItems(body, s).map((label) => ({",
    replace:
      "  const __joined = dropdownItems(body, s);\n" +
      "  return (__joined.length === 0 ? [] : [__joined.join(\", \")]).map((label) => ({",
    kills: [SEAL],
  },
  {
    name: "w:value is minted as the answer CODE",
    breaks:
      "the value is a stored datum, never rendered. On Word's default (value == displayText) it emits " +
      "\"Yes, definitely) Yes, definitely\", which CODED_OPTION cannot parse, so the DOUBLED string seals as the label",
    file: DOCX,
    find: '      const label = decodeXmlEntities(display ?? value ?? "").trim();',
    replace:
      "      const label =\n" +
      "        value === undefined\n" +
      '          ? decodeXmlEntities(display ?? "").trim()\n' +
      "          : `${value}) ${decodeXmlEntities(display ?? value).trim()}`;",
    kills: [SEAL_VALUES],
  },
  {
    name: "an item with no w:displayText is dropped instead of falling back to w:value",
    breaks:
      "w:displayText is OPTIONAL and such an item displays its value; dropping it is a silent loss of a real answer " +
      "option, and every item in the frozen corpus has both attributes so the corpus cannot see it",
    file: DOCX,
    find: '      const label = decodeXmlEntities(display ?? value ?? "").trim();',
    replace: '      const label = decodeXmlEntities(display ?? "").trim();',
    kills: [SEAL_VALUES, EXTRA_GATE],
  },
  {
    name: "dropdown options are not extracted at all (the deployed behaviour)",
    breaks: "the visible run says \"Choose an item.\", so the paragraph reads as complete prose with the whole answer list gone",
    file: DOCX,
    // NO TRAILING NEWLINE IN THE ANCHOR: src/** is CRLF, so a "\n" here matches nothing. The
    // first run of this file did exactly that and the harness reported BROKEN-ANCHOR — which
    // is the behaviour that matters, because the alternative is scoring an UNMUTATED build and
    // calling the survivor a test gap.
    find: "  out.push(...dropdownDrafts(body, s, origin));",
    replace: "  void dropdownDrafts(body, s, origin);",
    kills: [SCORE_GATE, SEAL],
  },

  // ============================================================ the detector, both directions
  {
    name: "the unreachable-dropdown detector is wired OFF",
    breaks: "a block-level control's options vanish with nothing said, which is the silent-loss class this parser exists to refuse",
    file: DOCX,
    find: "  const unreached = dropdownsOutsideParagraphs(xml, s);",
    replace: "  const unreached = 0;",
    kills: ["a BLOCK-LEVEL dropdown the paragraph scan cannot reach is COUNTED AND NAMED, never silently short"],
  },
  {
    name: "the unreachable-dropdown detector is wired ON permanently",
    breaks: "a warning that always warns is not a warning — the counterweight, and the half a positive test cannot see",
    file: DOCX,
    find: "  const unreached = dropdownsOutsideParagraphs(xml, s);",
    replace: "  const unreached = 1;",
    kills: ["A WARNING THAT ALWAYS WARNS IS NOT A WARNING: an inline dropdown reports nothing unreachable"],
  },

  // ============================================================ open combo boxes
  {
    name: "comboBox suggestions are emitted as ordinary closed-list options",
    breaks: "an open suggestion list becomes an exhaustive answer set and a valid free-form value can be accused as a site defect",
    file: DOCX,
    find:
      'function comboBoxDrafts(body: string, s: Syntax): Draft[] {\n' +
      '  return controlItems(body, s, "comboBox").map((label) => ({\n' +
      '    kind: "paragraph",',
    replace:
      'function comboBoxDrafts(body: string, s: Syntax): Draft[] {\n' +
      '  return controlItems(body, s, "comboBox").map((label) => ({\n' +
      '    kind: "list-item",',
    kills: ["comboBox suggestions are exact non-option blocks and cannot seal as an exhaustive option set"],
  },
  {
    name: "comboBox suggestion blocks are silently omitted",
    breaks: "coverage claims recovered suggestions but none remains independently addressable",
    file: DOCX,
    find: "  out.push(...comboBoxDrafts(body, s));",
    replace: "  void comboBoxDrafts(body, s);",
    kills: ["comboBox suggestions are exact non-option blocks and cannot seal as an exhaustive option set"],
  },
  {
    name: "unreadable comboBox listItem tags are counted as recovered",
    breaks: "the declared denominator no longer reconciles recovered and unreadable suggestions",
    file: DOCX,
    find: "      else unreadable += 1;",
    replace: '      else labels.push("[unreadable]");',
    kills: ["comboBox suggestions are exact non-option blocks and cannot seal as an exhaustive option set"],
  },

  // ============================================================ accepted view
  {
    name: "tracked deletions, move sources and old property snapshots are not filtered",
    breaks: "rejected controls resurrect choices and superseded properties fabricate heading/list semantics",
    file: DOCX,
    find: "  const xml = neutralizeTextBoxes(acceptedViewXml(stripFallback(xmlRaw), s, origin, coverage), s);",
    replace: "  const xml = neutralizeTextBoxes(stripFallback(xmlRaw), s);",
    kills: ["accepted view excludes deleted/moved-from controls and old property snapshots, but keeps replacements"],
  },
  {
    name: "old paragraph-property snapshots survive accepted-view filtering",
    breaks: "a superseded pStyle/numPr turns ordinary accepted prose into a heading or numbered item",
    file: DOCX,
    find: '    "pPrChange",',
    replace: '    "__pPrChange",',
    kills: ["accepted view excludes deleted/moved-from controls and old property snapshots, but keeps replacements"],
  },
  {
    name: "old content-control property snapshots survive accepted-view filtering",
    breaks: "a stale dropdown in sdtPrChange contributes a choice that is not in the accepted document view",
    file: DOCX,
    find: '    "sdtPrChange",',
    replace: '    "__sdtPrChange",',
    kills: ["accepted view excludes deleted/moved-from controls and old property snapshots, but keeps replacements"],
  },

  // ============================================================ unicode
  {
    name: "U+00A0 is folded back to U+0020",
    breaks: "the v1 -> v2 regression this work reverses: a parser that folds has destroyed the evidence for everyone downstream",
    file: DOCX,
    find: 'const clean = (t: string) => t.replace(/[ \\t]+\\n/g, "\\n").trim();',
    replace: 'const clean = (t: string) => t.replace(/\\u00a0/g, " ").replace(/[ \\t]+\\n/g, "\\n").trim();',
    kills: ["U+00A0 survives the parse byte-for-byte — a comparator may fold, a parser may not"],
  },
  {
    name: "the [#] auto-numbering placeholder is dropped",
    breaks:
      "the ONE change here that touches a document none of these fixes are about (06, and any other auto-numbered " +
      "file), which is what the collateral profile exists to catch. It is also a real regression in its own right: " +
      "Word's number lives in numbering.xml and exists nowhere in the document, so without the marker the paragraph " +
      "reads as unnumbered prose and a known unknown becomes a silent gap.\n" +
      "MEASURED, and worth recording: the first candidate for this slot — clean() collapsing runs of internal " +
      "whitespace — SURVIVED, and correctly so. Across the whole 20-file corpus only fixture 16 contains two " +
      "consecutive whitespace characters, and 16 is already inside the allowed changed-set. That mutant is " +
      "EQUIVALENT with respect to this corpus, not evidence of a gap in the check — but it does say the corpus " +
      "cannot detect a whitespace tidy-up anywhere else",
    file: DOCX,
    find: "    if (first) first.text = `[#] ${first.text}`;",
    replace: "    if (first) first.text = first.text;",
    kills: ["THE COLLATERAL PROFILE: only the named public fixtures change, and auxiliary discovery has exact receipts"],
  },
  {
    name: "w:noBreakHyphen is dropped again",
    breaks: "\"Ref code T-14\" becomes \"T14\" — a different reference code, with no sign anything went missing",
    file: DOCX,
    find: "      `<${p}noBreakHyphen(?=[\\\\s/>])[^>]*\\\\/?>|<${p}softHyphen(?=[\\\\s/>])[^>]*\\\\/?>`,",
    replace: "      `<${p}softHyphen(?=[\\\\s/>])[^>]*\\\\/?>`,",
    kills: ["w:noBreakHyphen becomes U+2011 and w:softHyphen leaves nothing behind"],
  },
  {
    name: "w:softHyphen emits U+00AD",
    breaks: "an invisible codepoint inside a word that no screen and no model will ever reproduce, so nothing can match it",
    file: DOCX,
    find: "    else if (raw.startsWith(softHyphenTag)) continue;",
    replace: '    else if (raw.startsWith(softHyphenTag)) parts.push("\\u00ad");',
    kills: ["w:noBreakHyphen becomes U+2011 and w:softHyphen leaves nothing behind"],
  },
  {
    name: "the furigana reading is left in the text",
    breaks: "電気 comes out as でんき電気 — CORRUPTION, not loss: plausible Japanese no reader ever saw, matching nothing on any screen",
    file: DOCX,
    find: '  return body.replace(rtRe, "");',
    replace: "  return body;",
    kills: ["ruby base text is exact and each visible reading is a separately addressable non-inline block"],
  },
  {
    name: "ruby readings are removed from the inline word but not emitted separately",
    breaks: "the base looks correct while every visible phonetic annotation silently disappears",
    file: DOCX,
    find: "  out.push(...rubyAnnotations);",
    replace: "  void rubyAnnotations;",
    kills: ["ruby base text is exact and each visible reading is a separately addressable non-inline block"],
  },
  {
    name: "ruby recovery coverage is not reported",
    breaks: "separate reading blocks exist but nobody can distinguish recovered from unreadable annotations",
    file: DOCX,
    find: "  if (rubyReadings > 0) {",
    replace: "  if (false) {",
    kills: ["ruby base text is exact and each visible reading is a separately addressable non-inline block"],
  },

  // ============================================================ the grid
  {
    name: "w:gridSpan is ignored",
    breaks: "one span shifts every later structural coordinate and can drop the final grid column",
    file: DOCX,
    find: '      const span = tableGridInteger(props, s, "gridSpan", 1, 1, tableId, coverage);',
    replace: "      const span = 1;",
    kills: ["gridSpan advances exact grid coordinates without inventing semantic column headers"],
  },
  {
    name: "the first row and first column are guessed as semantic table headers",
    breaks: "WordprocessingML has no th/scope marker, so the guess emits confident semantic facts the source never encoded",
    file: DOCX,
    find: "          rowHeader: null,\n          colHeader: null,",
    replace:
      "          rowHeader: c.gridCol === 1 ? null : row.cells[0]?.text.trim() || null,\n" +
      "          colHeader: r === 0 ? null : rows[0]?.cells.find((cell) => cell.gridCol === c.gridCol)?.text.trim() || null,",
    kills: ["NO Word table row or first column becomes semantic scope; repeat metadata is separately validated"],
  },
  {
    name: "table-header ambiguity is not named or counted",
    breaks: "semantic headers remain null, but the output gives no indication that header relationships were never established",
    file: DOCX,
    find: "    `TABLE_HEADER_SEMANTICS_AMBIGUOUS: ${tableId} contains ${nonEmptyCells} non-empty cell(s). ` +",
    replace: "    `TABLE_HEADER_SEMANTICS_UNREPORTED: ${tableId} contains ${nonEmptyCells} non-empty cell(s). ` +",
    kills: ["NO Word table row or first column becomes semantic scope; repeat metadata is separately validated"],
  },
  {
    name: "vertical merges are not reported as a structural limitation",
    breaks: "an empty continuation cell disappears without saying why no semantic row relation was inferred",
    file: DOCX,
    find: "  if (verticalMergeCount > 0) {",
    replace: "  if (false) {",
    kills: ["vMerge is retained as a counted structural limitation, never promoted to semantic rowHeader"],
  },
  {
    name: "w:gridBefore is ignored",
    breaks: "a ragged row is read as though it began at column 1, shifting every structural coordinate",
    file: DOCX,
    find: '    let gridCol = 1 + tableGridInteger(trPr, s, "gridBefore", 0, 0, tableId, coverage);',
    replace: "    let gridCol = 1;",
    kills: ["a gridBefore row starts at its declared structural grid column without inferred headers"],
  },
  {
    name: "late/non-leading repeat-on-page flags are not reported",
    breaks: "invalid pagination metadata disappears without a named limitation",
    file: DOCX,
    find: "  if (lateRepeatRows.length > 0) {",
    replace: "  if (false) {",
    kills: ["a late w:tblHeader repeat flag is ignored and reported, never treated as semantic th/scope"],
  },
  {
    name: "contiguous multi-row repeat metadata is not reported",
    breaks: "a multi-level repeating structure is silently flattened without saying semantic hierarchy was not inferred",
    file: DOCX,
    find: "  if (repeatPrefix > 1) {",
    replace: "  if (false) {",
    kills: ["NO Word table row or first column becomes semantic scope; repeat metadata is separately validated"],
  },
  {
    name: "grid val parsing requires the element prefix and double quotes",
    breaks: "equivalent XML serialization changes structural coordinates",
    file: DOCX,
    find: '  const raw = xmlAttribute(tag, "val");',
    replace: '  const raw = new RegExp(`${escapeRegExp(s.prefix)}val="([^"]*)"`).exec(tag)?.[1];',
    kills: ["gridSpan/gridBefore values are namespace, quote and whitespace metamorphic; malformed values are named"],
  },
  {
    name: "invalid grid integers fall through without their named diagnostic",
    breaks: "malformed values become a generic range failure rather than an exact readable limitation",
    file: DOCX,
    find: "  if (!/^[+-]?\\d+$/.test(normalized)) {",
    replace: "  if (false) {",
    kills: ["gridSpan/gridBefore values are namespace, quote and whitespace metamorphic; malformed values are named"],
  },
  {
    name: "grid properties with no val attribute are not diagnosed",
    breaks: "an explicit but unreadable property silently becomes the default coordinate",
    file: DOCX,
    find: "  if (raw === undefined) {",
    replace: "  if (false && raw === undefined) {",
    kills: ["gridSpan/gridBefore values are namespace, quote and whitespace metamorphic; malformed values are named"],
  },
  {
    name: "out-of-range grid values are not clamped or reported",
    breaks: "a tiny document can manufacture runaway coordinates without a named safety limitation",
    file: DOCX,
    find: "  if (parsed > MAX_GRID_COLUMNS) {",
    replace: "  if (false) {",
    kills: ["gridSpan/gridBefore values are namespace, quote and whitespace metamorphic; malformed values are named"],
  },
];

await runMutantSuite({
  title: "DOCX READER MUTANTS — the rejected designs, run as code",
  filter: "DOCX READER",
  mutants: MUTANTS,
});

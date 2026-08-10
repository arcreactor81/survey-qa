/*
 * gen-v2-extra.mjs — build the fixtures the frozen 20-file corpus does NOT exercise.
 *
 *   node gen-v2-extra.mjs
 *
 * Writes ./corpus-v2-extra/*.docx and leaves ./corpus-v2-extra/_probes.json alone (the probes
 * are hand-authored; this only regenerates the documents they are written against).
 *
 * WHY A SEPARATE CORPUS. The 20 files under ./corpus are a frozen instrument: 99 probes,
 * v1 = 77, Cloudflare toMarkdown = 78, v2 = 87 (89 after the merged-cell/dropdown/unicode
 * work). Adding fixtures to it would move a denominator that several documents quote. These
 * are scored separately by run-harness-v2.mjs and never summed into that /99.
 *
 * WHAT THE FROZEN CORPUS MISSES, measured before writing these:
 *   - `w:gridSpan` appears exactly ONCE, on a trailing full-width row (03 t2 r6). The case
 *     that actually breaks a reader — a gridSpan in the HEADER row, which shifts every column
 *     label after it and drops the last one — is not in the corpus at all.
 *   - `w:gridBefore` does not appear anywhere. It is the one table case where docling beats
 *     both mammoth and us-before-this-work.
 *   - `w:ruby` does not appear anywhere, and NOBODY handles it: the deployed parser interleaved
 *     the furigana INTO the base word, mammoth drops the base word entirely.
 *   - the corpus's one dropdown (11) has `w:value="1".."4"`, so a parser that emitted the value
 *     as an answer CODE would look correct on it. Word's DEFAULT is `w:value` == `w:displayText`,
 *     and an item may carry no `w:displayText` at all. 24 is that document.
 *   - every dropdown in the corpus is inline in a `w:p`. 25 puts one at BLOCK level, where the
 *     per-paragraph scan cannot reach it, to prove the parser SAYS SO instead of going quiet.
 *   - WordprocessingML has no semantic table-header marker; 28 separates repeat-on-page flags
 *     from header guesses. 29-31 cover open combo boxes, XML-serialization-metamorphic grid
 *     values, and the accepted view of tracked control/property changes.
 */

import { zipSync, strToU8 } from "fflate";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "corpus-v2-extra");
mkdirSync(OUT, { recursive: true });

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const run = (t) => `<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const p = (t) => `<w:p>${run(t)}</w:p>`;
const pRaw = (inner) => `<w:p>${inner}</w:p>`;

const tc = (text, { span = 0, vMerge = null } = {}) => {
  const props = `${span ? `<w:gridSpan w:val="${span}"/>` : ""}${
    vMerge === "restart" ? `<w:vMerge w:val="restart"/>` : vMerge === "continue" ? `<w:vMerge/>` : ""
  }`;
  return `<w:tc><w:tcPr>${props}</w:tcPr>${p(text)}</w:tc>`;
};
const tr = (cells, { header = false, gridBefore = 0 } = {}) =>
  `<w:tr>${header || gridBefore ? `<w:trPr>${header ? "<w:tblHeader/>" : ""}${gridBefore ? `<w:gridBefore w:val="${gridBefore}"/>` : ""}</w:trPr>` : ""}${cells}</w:tr>`;

const dropdown = (items, placeholder = "Choose an item.") =>
  `<w:sdt><w:sdtPr><w:dropDownList>${items
    .map(
      (i) =>
        `<w:listItem${i.display === undefined ? "" : ` w:displayText="${esc(i.display)}"`}${
          i.value === undefined ? "" : ` w:value="${esc(i.value)}"`
        }/>`,
    )
    .join("")}</w:dropDownList></w:sdtPr><w:sdtContent>${run(placeholder)}</w:sdtContent></w:sdt>`;

const comboBox = (items, current) =>
  `<w:sdt><w:sdtPr><w:comboBox>${items
    .map(
      (i) =>
        `<w:listItem${i.display === undefined ? "" : ` w:displayText="${esc(i.display)}"`}${
          i.value === undefined ? "" : ` w:value="${esc(i.value)}"`
        }/>`,
    )
    .join("")}</w:comboBox></w:sdtPr><w:sdtContent>${run(current)}</w:sdtContent></w:sdt>`;

const ruby = (reading, base) =>
  `<w:r><w:ruby><w:rubyPr><w:rubyAlign w:val="distributeLetter"/></w:rubyPr>` +
  `<w:rt><w:r><w:t>${esc(reading)}</w:t></w:r></w:rt>` +
  `<w:rubyBase><w:r><w:t>${esc(base)}</w:t></w:r></w:rubyBase>` +
  `</w:ruby></w:r>`;

function docx(bodyXml, extraNamespaces = "") {
  const doc =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"${extraNamespaces}>` +
    `<w:body>${bodyXml}</w:body></w:document>`;
  return zipSync({
    "[Content_Types].xml": strToU8(CONTENT_TYPES),
    "_rels/.rels": strToU8(RELS),
    "word/document.xml": strToU8(doc),
  });
}

const write = (name, bytes) => {
  writeFileSync(join(OUT, name), bytes);
  console.log(`  ${name}  ${bytes.length} bytes`);
};

console.log(`writing to ${OUT}`);

/* ---- 21: gridSpan in the HEADER row, and a vMerge group ------------------------------
 * FIVE grid columns. The header's "Awareness" cell spans columns 2 AND 3, so "Usage" is
 * grid column 4 and "Price" is grid column 5. Index the header by ARRAY POSITION and every
 * label after the span moves one column left and "Price" is lost — a confidently wrong
 * annotation over a real answer, which is worse than no annotation.
 *
 * Table 2 is the vMerge group the frozen corpus HAS but never probes: 03's continuation rows
 * are only asserted through a v1-flat-text tab regex, so nothing checks that "Manchester"
 * inherits "METRO".
 */
write(
  "21-gridspan-header-vmerge.docx",
  docx(
    p("Q9. Rate each brand.") +
      "<w:tbl>" +
      tr(tc("Brand") + tc("Awareness", { span: 2 }) + tc("Usage") + tc("Price"), { header: true }) +
      tr(tc("Kestrel") + tc("aware-yes") + tc("aware-no") + tc("weekly") + tc("42 GBP")) +
      tr(tc("Sable") + tc("aware-yes") + tc("aware-no") + tc("monthly") + tc("61 GBP")) +
      "</w:tbl>" +
      p("Q10. Regional quota.") +
      "<w:tbl>" +
      tr(tc("Region") + tc("City") + tc("Target"), { header: true }) +
      tr(tc("METRO", { vMerge: "restart" }) + tc("London") + tc("300")) +
      tr(tc("", { vMerge: "continue" }) + tc("Manchester") + tc("120")) +
      "</w:tbl>",
  ),
);

/* ---- 22: w:gridBefore — a row that starts part-way across the grid -------------------
 * Row 3 declares one skipped column, so its two cells are grid columns 2 and 3. Read as if
 * the row began at column 1 and "no" is filed under Brand and "monthly" under Aware.
 */
write(
  "22-gridbefore-ragged-row.docx",
  docx(
    p("Q11. Brand usage.") +
      "<w:tbl>" +
      tr(tc("Brand") + tc("Aware") + tc("Use"), { header: true }) +
      tr(tc("Kestrel") + tc("yes") + tc("weekly")) +
      tr(tc("no") + tc("monthly"), { gridBefore: 1 }) +
      "</w:tbl>",
  ),
);

/* ---- 23: w:ruby furigana -------------------------------------------------------------
 * The reading lives in w:rt and the word in w:rubyBase, and both are ordinary w:t runs.
 */
write(
  "23-ruby-furigana.docx",
  docx(
    pRaw(run("Q17. ") + ruby("でんき", "電気") + run("の") + ruby("けいやく", "契約") + run("について。")) +
      p("SINGLE CODE."),
  ),
);

/* ---- 24: dropdown values that are NOT codes ------------------------------------------
 * Three shapes the frozen corpus's 1..4 values hide:
 *   Q20 — Word's DEFAULT, w:value == w:displayText;
 *   Q21 — an item with NO w:displayText, which displays its w:value;
 *   Q22 — numeric values, the shape that makes a value-as-code rule look correct.
 */
write(
  "24-dropdown-value-shapes.docx",
  docx(
    pRaw(
      run("Q20. Would you recommend it? ") +
        dropdown([
          { display: "Yes, definitely", value: "Yes, definitely" },
          { display: "No", value: "No" },
        ]) +
        run(" SINGLE CODE."),
    ) +
      pRaw(run("Q21. Household income band? ") + dropdown([{ value: "Prefer not to say" }])) +
      pRaw(
        run("Q22. Monthly spend? ") +
          dropdown([
            { display: "Under 20 GBP", value: "1" },
            { display: "20 to 40 GBP", value: "2" },
          ]),
      ),
  ),
);

/* ---- 25: a BLOCK-LEVEL dropdown, where the per-paragraph scan cannot reach ------------
 * The w:sdtPr sits outside every w:p. The options are NOT recovered, and the whole point of
 * this fixture is that the parser must SAY they were not recovered.
 */
write(
  "25-dropdown-block-level.docx",
  docx(
    p("Q30. Which zone are you in?") +
      `<w:sdt><w:sdtPr><w:dropDownList>` +
      `<w:listItem w:displayText="Zone A" w:value="A"/><w:listItem w:displayText="Zone B" w:value="B"/>` +
      `</w:dropDownList></w:sdtPr><w:sdtContent>${p("Choose an item.")}</w:sdtContent></w:sdt>` +
      p("SINGLE CODE."),
  ),
);

/* ---- 26: the declared header row is NOT row 0 ----------------------------------------
 * A full-width TITLE row above the real header, which is how a questionnaire's quota tables
 * are usually drawn. `w:tblHeader` on row 2 is the author saying which row repeats — i.e.
 * which row is the header. Guess row 0 instead (docling always does; mammoth reads the flag
 * but has no fallback for its absence) and every answer in the table is labelled with the
 * TABLE'S TITLE as its column header.
 *
 * Without this fixture the `w:tblHeader` branch is never taken by any test in the tree: every
 * other table's declared header IS row 0, so honouring the flag and ignoring it agree.
 */
write(
  "26-tblheader-not-row-0.docx",
  docx(
    p("Q12. Awareness by region.") +
      "<w:tbl>" +
      tr(tc("Table 4 — Awareness by region", { span: 3 })) +
      tr(tc("Region") + tc("Aware") + tc("Use"), { header: true }) +
      tr(tc("North") + tc("62%") + tc("41%")) +
      "</w:tbl>",
  ),
);

/* ---- 27: a gridSpan DECOMPRESSION BOMB -----------------------------------------------
 * 886 bytes declaring a 99,999,999-column span. Column headers are mapped one grid column at
 * a time, so an unbounded span is a CPU/memory kill inside a Worker from a document small
 * enough to arrive by email — the same class of hazard as the unclosed <w:tbl> that burned
 * 18.5 s on a 98 KB upload. Word caps a table at 63 columns.
 */
write(
  "27-gridspan-bomb.docx",
  docx(
    p("Q40. Ordinary question above a hostile table.") +
      "<w:tbl>" +
      tr(tc("A", { span: 99999999 }) + tc("B") + tc("C"), { header: true }) +
      tr(tc("x") + tc("y") + tc("z")) +
      "</w:tbl>",
  ),
);

/* ---- 28: repeat-on-page flags are not semantic table headers -------------------------
 * WordprocessingML has no th/scope equivalent. These four tables separate pagination
 * metadata from semantics: a late flag (invalid per OOXML), a two-column ambiguity, an
 * all-data first row, and two contiguous rows that repeat on each page.
 */
write(
  "28-table-header-ambiguity.docx",
  docx(
    p("Q50. Table header semantics must not be guessed.") +
      "<w:tbl>" +
      tr(tc("Table 8 — Awareness", { span: 3 })) +
      tr(tc("Region") + tc("Aware") + tc("Use"), { header: true }) +
      tr(tc("North") + tc("62%") + tc("41%")) +
      "</w:tbl>" +
      "<w:tbl>" +
      tr(tc("Key") + tc("Value"), { header: true }) +
      tr(tc("Region") + tc("North")) +
      "</w:tbl>" +
      "<w:tbl>" +
      tr(tc("North") + tc("62%") + tc("41%"), { header: true }) +
      tr(tc("South") + tc("55%") + tc("33%")) +
      "</w:tbl>" +
      "<w:tbl>" +
      tr(tc("Market") + tc("Measures", { span: 2 }), { header: true }) +
      tr(tc("Region") + tc("Aware") + tc("Use"), { header: true }) +
      tr(tc("North") + tc("62%") + tc("41%")) +
      "</w:tbl>",
  ),
);

/* ---- 29: comboBox is open input, never a closed option set ---------------------------
 * The current value Green is deliberately absent from the suggestions. Treating Red/Blue
 * as exhaustive options would manufacture a site defect against a valid free-form value.
 */
write(
  "29-combobox-open-suggestions.docx",
  docx(
    pRaw(
      run("Q51. Enter or choose a colour: ") +
        comboBox(
          [
            { display: "Red", value: "R" },
            { display: "Blue", value: "B" },
            {},
          ],
          "Green",
        ) +
        run(" OPEN ENTRY."),
    ),
  ),
);

/* ---- 30: grid property serialization is metamorphic ---------------------------------
 * Attribute prefix, quote style and whitespace are XML serialization choices. The final
 * table deliberately carries missing, invalid, negative and hostile values so every
 * fallback/clamp is named rather than silently normalized.
 */
const gridShapeTable = (spanTag, beforeTag) =>
  "<w:tbl>" +
  `<w:tr><w:tc><w:tcPr>${spanTag}</w:tcPr>${p("Wide")}</w:tc>${tc("Tail")}</w:tr>` +
  tr(tc("A") + tc("B") + tc("C")) +
  `<w:tr><w:trPr>${beforeTag}</w:trPr>${tc("Offset-A") + tc("Offset-B")}</w:tr>` +
  "</w:tbl>";

write(
  "30-grid-attribute-shapes.docx",
  docx(
    p("Q52. Grid serialization variants.") +
      gridShapeTable(`<w:gridSpan w:val="2"/>`, `<w:gridBefore w:val="1"/>`) +
      gridShapeTable(`<w:gridSpan x:val = '2'/>`, `<w:gridBefore x:val = '1'/>`) +
      "<w:tbl>" +
      `<w:tr><w:tc><w:tcPr><w:gridSpan/></w:tcPr>${p("Missing")}</w:tc>${tc("After-missing")}</w:tr>` +
      `<w:tr><w:tc><w:tcPr><w:gridSpan x:val='NaN'/></w:tcPr>${p("Invalid")}</w:tc>${tc("After-invalid")}</w:tr>` +
      `<w:tr><w:trPr><w:gridBefore x:val='-1'/></w:trPr>${tc("Negative-before")}</w:tr>` +
      `<w:tr><w:tc><w:tcPr><w:gridSpan x:val='99999999'/></w:tcPr>${p("Hostile")}</w:tc></w:tr>` +
      "</w:tbl>",
    ` xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`,
  ),
);

/* ---- 31: accepted view applies to control metadata and old property snapshots --------
 * Deleted/moved-from controls must contribute neither rendered text nor choices. Inserted
 * and moved-to replacements are accepted. pPrChange/sdtPrChange carry OLD properties and
 * must not turn an ordinary paragraph into a heading/list or resurrect stale choices.
 */
write(
  "31-accepted-view-controls.docx",
  docx(
    pRaw(
      run("Q53. Accepted choices: ") +
        `<w:del>${dropdown([{ display: "Deleted A", value: "DA" }, { display: "Deleted B", value: "DB" }], "Deleted A")}</w:del>` +
        `<w:moveFrom>${dropdown([{ display: "Moved-old A", value: "MA" }], "Moved-old A")}</w:moveFrom>` +
        `<w:ins>${dropdown([{ display: "Live A", value: "LA" }, { display: "Live B", value: "LB" }], "Live A")}</w:ins>` +
        `<w:moveTo>${dropdown([{ display: "Moved-new C", value: "MC" }], "Moved-new C")}</w:moveTo>` +
        run(" SINGLE CODE."),
    ) +
      `<w:p><w:pPr><w:rPr><w:del/></w:rPr><w:pPrChange><w:pPr><w:pStyle w:val="Heading1"/><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:pPrChange></w:pPr>` +
      `${run("Ordinary accepted paragraph.")}</w:p>` +
      `<w:p><w:sdt><w:sdtPr><w:sdtPrChange><w:sdtPr><w:dropDownList>` +
      `<w:listItem w:displayText="Stale snapshot" w:value="stale"/>` +
      `</w:dropDownList></w:sdtPr></w:sdtPrChange></w:sdtPr><w:sdtContent>${run("Current plain value")}</w:sdtContent></w:sdt></w:p>`,
  ),
);

console.log("done");

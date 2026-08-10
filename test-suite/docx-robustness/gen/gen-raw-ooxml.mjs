/*
 * gen-raw-ooxml.mjs — hazards the `docx` npm package cannot express, built as
 * hand-written OOXML inside a zip (fflate zipSync).
 *
 * Produces corpus/11, 13, 14, 15, 16, 17, 18.
 *
 * Run: node gen/gen-raw-ooxml.mjs
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import {
  CORPUS_DIR,
  CONTENT_TYPES,
  ROOT_RELS,
  buildDocx,
  documentXml,
  esc,
  para,
  probe,
  record,
  save,
  utf8,
  writeManifest,
} from "./common.mjs";

/* ================================================================== */
/* 11 — text boxes and content controls holding real instructions      */
/* ================================================================== */

const TXBX_TEXT =
  "SCRIPTER CALLOUT: Q17 must be asked BEFORE Q16 for respondents in the pilot cell. Ignore the printed order.";

const drawingTextbox = (inner) => `
  <mc:AlternateContent>
    <mc:Choice Requires="wps">
      <w:drawing>
        <wp:inline distT="0" distB="0" distL="0" distR="0">
          <wp:extent cx="4572000" cy="1143000"/>
          <wp:docPr id="7" name="Text Box 7"/>
          <a:graphic>
            <a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
              <wps:wsp>
                <wps:txbx>
                  <w:txbxContent>${inner}</w:txbxContent>
                </wps:txbx>
              </wps:wsp>
            </a:graphicData>
          </a:graphic>
        </wp:inline>
      </w:drawing>
    </mc:Choice>
    <mc:Fallback>
      <w:pict>
        <v:shape id="_x0000_s1026" type="#_x0000_t202" style="width:360pt;height:90pt">
          <v:textbox>
            <w:txbxContent>${inner}</w:txbxContent>
          </v:textbox>
        </v:shape>
      </w:pict>
    </mc:Fallback>
  </mc:AlternateContent>`;

function textboxAndSdt() {
  const boxPara = `<w:p><w:r><w:t xml:space="preserve">${esc(TXBX_TEXT)}</w:t></w:r></w:p>`;
  const vmlOnlyBox = `<w:p><w:r><w:pict><v:shape id="_x0000_s1027" type="#_x0000_t202" style="width:360pt;height:60pt"><v:textbox><w:txbxContent><w:p><w:r><w:t xml:space="preserve">LEGACY CALLOUT (VML only): quota cell PILOT closes at n=50; after that route everyone to the main cell.</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`;

  const body = [
    para("SECTION M — CALLOUTS AND CONTENT CONTROLS", { style: "Heading1" }),
    // Host paragraph with a text box in the MIDDLE — text must survive on both sides.
    `<w:p>` +
      `<w:r><w:t xml:space="preserve">Q17. Which statement is closest to your view? </w:t></w:r>` +
      `<w:r>${drawingTextbox(boxPara)}</w:r>` +
      `<w:r><w:t xml:space="preserve"> SELECT ONE ONLY — do not accept multiples.</w:t></w:r>` +
      `</w:p>`,
    vmlOnlyBox,
    // Block-level structured document tag (content control) holding a rule.
    `<w:sdt>` +
      `<w:sdtPr><w:alias w:val="Fieldwork window"/><w:tag w:val="fw_window"/><w:id w:val="900001"/><w:text/></w:sdtPr>` +
      `<w:sdtContent><w:p><w:r><w:t xml:space="preserve">FIELDWORK WINDOW: 14 April 2026 to 28 April 2026 inclusive. Do not launch before 09:00 UK time.</w:t></w:r></w:p></w:sdtContent>` +
      `</w:sdt>`,
    // Inline content control inside a normal paragraph.
    `<w:p>` +
      `<w:r><w:t xml:space="preserve">Q13. Which tariff are you on? </w:t></w:r>` +
      `<w:sdt>` +
      `<w:sdtPr><w:alias w:val="Q13 tariff type"/><w:tag w:val="q13_tariff"/><w:id w:val="900002"/>` +
      `<w:dropDownList w:lastValue="Choose an item.">` +
      `<w:listItem w:displayText="Fixed-rate, 12 month" w:value="1"/>` +
      `<w:listItem w:displayText="Fixed-rate, 24 month" w:value="2"/>` +
      `<w:listItem w:displayText="Standard variable" w:value="3"/>` +
      `<w:listItem w:displayText="Time-of-use / Economy 7" w:value="4"/>` +
      `</w:dropDownList></w:sdtPr>` +
      `<w:sdtContent><w:r><w:t xml:space="preserve">Choose an item.</w:t></w:r></w:sdtContent>` +
      `</w:sdt>` +
      `<w:r><w:t xml:space="preserve"> SINGLE CODE.</w:t></w:r>` +
      `</w:p>`,
    para("Q14. And how long have you been on that tariff?"),
  ].join("");

  const name = "11-textbox-content-control.docx";
  save(name, buildDocx({ "word/document.xml": documentXml(body) }));
  record(
    name,
    "text boxes (w:txbxContent via mc:AlternateContent and legacy VML w:pict) and content controls (w:sdt) holding live instructions; inline dropdown options live only in w:listItem/@w:displayText",
    [
      probe("present", "Q17. Which statement is closest to your view?", "host paragraph text BEFORE the text box"),
      probe("present", "SELECT ONE ONLY — do not accept multiples", "host paragraph text AFTER the text box — the classic truncation victim", "meaning"),
      probe("present", "must be asked BEFORE Q16 for respondents in the pilot cell", "the rule inside the DrawingML text box"),
      probe("noregex", "pilot cell[\\s\\S]*pilot cell", "the mc:Fallback copy must not be emitted a second time", "meaning"),
      probe("present", "quota cell PILOT closes at n=50", "the rule inside the legacy VML-only text box"),
      probe("present", "FIELDWORK WINDOW: 14 April 2026 to 28 April 2026", "block-level content control content"),
      probe("present", "Q13. Which tariff are you on?", "text before the inline content control"),
      probe("present", "SINGLE CODE.", "text after the inline content control"),
      probe("present", "Time-of-use / Economy 7", "an option that exists ONLY as a w:listItem/@w:displayText attribute"),
    ],
  );
}

/* ================================================================== */
/* 13 — document.xml stored as UTF-16LE with a BOM                     */
/* ================================================================== */

function utf16Document() {
  const body = [
    para("SECTION N — LEGACY EXPORT", { style: "Heading1" }),
    para("This part was written by an in-house tool that emits UTF-16 XML."),
    para("Q35. Do you have a water meter? SINGLE CODE."),
    para("ROUTING: if Q35 = 2 then SKIP TO Q40 and set flag no_meter = 1."),
    para("Q36. £ values in this module are shown to two decimal places — €/$ never."),
  ].join("");
  const xml = documentXml(body).replace('encoding="UTF-8"', 'encoding="UTF-16"');

  // UTF-16LE bytes with a leading BOM (required by the XML spec for UTF-16).
  const u16 = Buffer.from("﻿" + xml, "utf16le");

  const name = "13-utf16-encoded.docx";
  save(name, buildDocx({ "word/document.xml": new Uint8Array(u16) }));
  record(name, "word/document.xml serialised as UTF-16LE with a BOM (unusual but legal encoding)", [
    probe("present", "Q35. Do you have a water meter?", "basic text must survive the UTF-16 decode"),
    probe("present", "SKIP TO Q40 and set flag no_meter = 1", "a routing rule in the UTF-16 part"),
    probe("present", "£ values in this module", "non-ASCII must decode correctly, not mojibake", "meaning"),
    probe("noregex", "\\u0000", "no NUL bytes may leak into the extracted text (a UTF-8 decode of UTF-16 would)", "meaning"),
  ]);
}

/* ================================================================== */
/* 14 — Word 2003 WordprocessingML flat XML, saved as .doc             */
/* ================================================================== */

function word2003() {
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<?mso-application progid="Word.Document"?>\n` +
    `<w:wordDocument xmlns:w="http://schemas.microsoft.com/office/word/2003/wordml" ` +
    `xmlns:wx="http://schemas.microsoft.com/office/word/2003/auxHint" w:macrosPresent="no">` +
    `<w:body>` +
    `<w:p><w:r><w:t>PROJECT 41-2287 — LEGACY SCREENER (Word 2003 format)</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>S1. Do you or does anyone in your household work in market research? IF YES, TERMINATE (T1).</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>S2. Which of these age bands are you in? SINGLE CODE. TERMINATE if under 18 (T2).</w:t></w:r></w:p>` +
    `</w:body></w:wordDocument>`;

  const name = "14-legacy-word2003.doc";
  save(name, utf8(xml));
  record(
    name,
    "a .doc-era file: genuine Word 2003 WordprocessingML flat XML (NOT a zip), delivered with a .doc extension",
    [
      probe("present", "S1. Do you or does anyone in your household work in market research?", "the screener still contains real rules; the question is whether the failure is loud"),
      probe("present", "TERMINATE if under 18 (T2)", "a real termination rule"),
    ],
    {
      expected_outcome: "crash",
      note:
        "this is the honest .doc-era case: it is not a ZIP, so extractDocxText must throw. The probes are expected to fail; what matters is that the failure is LOUD and the message names the real problem.",
    },
  );
}

/* ================================================================== */
/* 15 — nested table inside a routing grid                             */
/* ================================================================== */

const tc = (t) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${para(t)}</w:tc>`;
const tcRaw = (inner) => `<w:tc><w:tcPr><w:tcW w:w="4800" w:type="dxa"/></w:tcPr>${inner}</w:tc>`;
const tr = (...cells) => `<w:tr>${cells.join("")}</w:tr>`;

function nestedTable() {
  const inner =
    `<w:tbl><w:tblPr><w:tblW w:w="4600" w:type="dxa"/></w:tblPr>` +
    tr(tc("Q40 = 1 (has smart meter)"), tc("ask Q41 then Q42")) +
    tr(tc("Q40 = 2 (no smart meter)"), tc("SKIP TO Q45")) +
    tr(tc("Q40 = 9 (don't know)"), tc("SKIP TO Q45 and set dk_meter = 1")) +
    `</w:tbl><w:p/>`;

  const body = [
    para("SECTION O — MODULE ROUTING MAP", { style: "Heading1" }),
    `<w:tbl><w:tblPr><w:tblW w:w="9600" w:type="dxa"/></w:tblPr>` +
      tr(tc("Module"), tcRaw(para("Routing detail"))) +
      tr(tc("M3 — Smart meters"), tcRaw(inner)) +
      tr(tc("M4 — Billing"), tcRaw(para("TERMINATE if Q46 = 9 (T11). No exceptions."))) +
      tr(tc("M5 — Service"), tcRaw(para("Ask all. Randomise Q50-Q54."))) +
      `</w:tbl>`,
    para("End of routing map. Any module not listed above is asked of all respondents."),
  ].join("");

  const name = "15-nested-table.docx";
  save(name, buildDocx({ "word/document.xml": documentXml(body) }));
  record(name, "a nested w:tbl inside a table cell (a routing sub-grid drawn inside a module map)", [
    probe("present", "SKIP TO Q45 and set dk_meter = 1", "a rule inside the NESTED table"),
    probe("present", "TERMINATE if Q46 = 9 (T11). No exceptions.", "a rule in the OUTER table, AFTER the nested one"),
    probe("present", "Ask all. Randomise Q50-Q54.", "the last outer row, after the nested table"),
    probe("present", "End of routing map.", "content after the whole table"),
    probe(
      "regex",
      "M4 — Billing\\tTERMINATE if Q46 = 9",
      "the outer row must keep its stub attached to its detail cell",
      "meaning",
    ),
    probe(
      "regex",
      "Q40 = 2 \\(no smart meter\\)\\tSKIP TO Q45",
      "the nested row must keep its condition attached to its action",
      "meaning",
    ),
  ]);
}

/* ================================================================== */
/* 16 — UTF-8 BOM, symbols, soft hyphens, field codes                  */
/* ================================================================== */

function fieldsSymbolsBom() {
  const body = [
    para("SECTION P — SYMBOLS AND FIELDS", { style: "Heading1" }),
    // w:sym: the glyph lives in an ATTRIBUTE, not in a w:t.
    `<w:p><w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>` +
      `<w:r><w:t xml:space="preserve"> Tick this box if the respondent consented to recontact.</w:t></w:r></w:p>`,
    `<w:p><w:r><w:t xml:space="preserve">Q48. Rate the value for money </w:t></w:r>` +
      `<w:r><w:sym w:font="Symbol" w:char="F0B3"/></w:r>` +
      `<w:r><w:t xml:space="preserve"> 7 out of 10 counts as a PASS.</w:t></w:r></w:p>`,
    // Soft hyphen / non-breaking hyphen as ELEMENTS.
    `<w:p><w:r><w:t>Q49. Do you consider yourself a multi</w:t></w:r>` +
      `<w:r><w:softHyphen/></w:r><w:r><w:t xml:space="preserve">national customer? </w:t></w:r>` +
      `<w:r><w:t>Ref code T</w:t></w:r><w:r><w:noBreakHyphen/></w:r><w:r><w:t>14</w:t></w:r>` +
      `<w:r><w:t xml:space="preserve"> applies.</w:t></w:r></w:p>`,
    // Complex field WITH a cached result — the visible text is present.
    `<w:p><w:r><w:t xml:space="preserve">See </w:t></w:r>` +
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
      `<w:r><w:instrText xml:space="preserve"> REF _Ref410 \\h </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
      `<w:r><w:t>Table 1</w:t></w:r>` +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
      `<w:r><w:t xml:space="preserve"> for the quota grid.</w:t></w:r></w:p>`,
    // Complex field with NO cached result (fields never updated) — invisible.
    `<w:p><w:r><w:t xml:space="preserve">Fieldwork closes on </w:t></w:r>` +
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
      `<w:r><w:instrText xml:space="preserve"> DOCPROPERTY "CloseDate" \\* MERGEFORMAT </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
      `<w:r><w:t xml:space="preserve"> — no interviews after that date.</w:t></w:r></w:p>`,
    // Numeric character references.
    `<w:p><w:r><w:t xml:space="preserve">Q50. Price band &#163;20&#8211;&#163;40 per month&#160;(inclusive) &#8212; single code.</w:t></w:r></w:p>`,
    // A paragraph whose paragraph MARK is deleted: in the final view these two
    // paragraphs are one sentence.
    `<w:p><w:pPr><w:rPr><w:del w:id="800" w:author="S. Okonjo" w:date="2026-03-11T09:14:00Z"/></w:rPr></w:pPr>` +
      `<w:r><w:t xml:space="preserve">Q51. If the respondent hesitates, </w:t></w:r></w:p>`,
    `<w:p><w:r><w:t>prompt once and then accept the first answer given.</w:t></w:r></w:p>`,
    // A tab between label and value (label/value pairing lives in the tab).
    `<w:p><w:r><w:t>Median LOI</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>14 minutes</w:t></w:r></w:p>`,
  ].join("");

  // UTF-8 BOM in front of the XML declaration — legal, and real producers emit it.
  const xml = "﻿" + documentXml(body);

  const name = "16-fields-symbols-bom.docx";
  save(name, buildDocx({ "word/document.xml": xml }));
  record(
    name,
    "UTF-8 BOM before the XML declaration, w:sym glyphs in attributes, w:softHyphen/w:noBreakHyphen elements, complex fields with and without cached results, numeric character references, and a deleted paragraph mark",
    [
      probe("present", "Tick this box if the respondent consented to recontact", "text next to a w:sym must survive the BOM and the symbol"),
      probe(
        "present",
        "Q48. Rate the value for money",
        "the ≥ glyph is a w:sym attribute; without it the sentence reads 'value for money 7 out of 10' and the threshold direction is LOST",
        "meaning",
      ),
      probe("present", "Ref code T-14 applies", "w:noBreakHyphen must render as a hyphen or the reference code is corrupted", "meaning"),
      probe("present", "See Table 1 for the quota grid", "a complex field WITH a cached result"),
      probe(
        "regex",
        "Fieldwork closes on\\s+—",
        "a field with NO cached result leaves a hole; the sentence must not silently read as complete",
        "meaning",
      ),
      probe("noregex", "DOCPROPERTY", "field instruction codes must not leak into the extracted prose", "meaning"),
      probe("present", "Price band £20–£40 per month", "numeric character references must decode"),
      probe("present", "Median LOI\t14 minutes", "the tab that pairs label with value"),
      probe("noregex", "^\\uFEFF", "the UTF-8 BOM must not survive into the first line of extracted text", "meaning"),
    ],
  );
}

/* ================================================================== */
/* 17 — WordprocessingML bound to the DEFAULT namespace (no w: prefix) */
/* ================================================================== */

function defaultNamespace() {
  const body =
    `<p><r><t xml:space="preserve">SECTION Q — ALTERNATE NAMESPACE BINDING</t></r></p>` +
    `<p><r><t xml:space="preserve">Q55. How many vehicles does your household own? NUMERIC, RANGE 0-9.</t></r></p>` +
    `<p><r><t xml:space="preserve">ROUTING: if Q55 = 0 then SKIP TO Q60 (no vehicle module).</t></r></p>` +
    `<tbl><tr><tc><p><r><t>Q56 = 1</t></r></p></tc><tc><p><r><t>ask Q57</t></r></p></tc></tr>` +
    `<tr><tc><p><r><t>Q56 = 2</t></r></p></tc><tc><p><r><t>TERMINATE (T12)</t></r></p></tc></tr></tbl>`;

  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<body>${body}<sectPr><pgSz w="11906" h="16838"/></sectPr></body></document>`;

  const name = "17-default-namespace.docx";
  save(name, buildDocx({ "word/document.xml": xml }));
  record(name, "WordprocessingML bound to the default XML namespace (no w: prefix) — validates the parser's prefix-detection fallback", [
    probe("present", "Q55. How many vehicles does your household own?", "body text under an unprefixed binding"),
    probe("present", "SKIP TO Q60 (no vehicle module)", "a routing rule under an unprefixed binding"),
    probe("regex", "Q56 = 2\\tTERMINATE \\(T12\\)", "tables must still keep their row shape under an unprefixed binding"),
  ]);
}

/* ================================================================== */
/* 18 — OLE2 / CFB container header (binary Word 97-2003 stand-in)     */
/* ================================================================== */

function ole2Header() {
  // A 1536-byte OLE2 Compound File header. This is an HONEST stand-in, not a
  // real .doc: the magic, sector size and FAT fields are correct, so anything
  // that sniffs the container type will classify it exactly as it would a real
  // Word 97-2003 file, but there is no WordDocument stream inside it.
  const buf = Buffer.alloc(1536, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(buf, 0);
  buf.writeUInt16LE(0x003e, 24); // minor version
  buf.writeUInt16LE(0x0003, 26); // major version (512-byte sectors)
  buf.writeUInt16LE(0xfffe, 28); // little-endian marker
  buf.writeUInt16LE(9, 30); // sector shift => 512
  buf.writeUInt16LE(6, 32); // mini sector shift => 64
  buf.writeUInt32LE(1, 44); // number of FAT sectors
  buf.writeUInt32LE(1, 48); // first directory sector
  buf.writeUInt32LE(4096, 56); // mini stream cutoff
  buf.writeUInt32LE(0xfffffffe, 60); // first mini-FAT sector: END
  buf.writeUInt32LE(0xfffffffe, 68); // first DIFAT sector: END
  buf.writeUInt32LE(0x00000000, 76); // DIFAT[0] -> sector 0
  for (let i = 80; i < 512; i += 4) buf.writeUInt32LE(0xffffffff, i);
  Buffer.from("WordDocument", "utf16le").copy(buf, 512 + 128);

  const name = "18-ole2-header.doc";
  save(name, new Uint8Array(buf));
  record(name, "binary Word 97-2003 container (OLE2/CFB) — the classic 'someone emailed me a .doc' upload", [
    probe("present", "WordDocument", "nothing here is extractable as text; the probe exists only to force the failure path"),
  ], {
    expected_outcome: "crash",
    honesty_note:
      "HEADER-ONLY stand-in: the OLE2 magic and header fields are genuine, but there is no real WordDocument stream. A real binary .doc reaches extractDocxText the same way (non-ZIP bytes) and takes the identical path.",
  });
}

/* ================================================================== */
/* 19 — main document part is NOT at word/document.xml                 */
/* ================================================================== */

function altPartName() {
  // The main part's path is only authoritative through _rels/.rels. Word and
  // several converters do emit word/document2.xml (e.g. after a document is
  // built from a template that already claimed document.xml).
  const body = [
    para("SECTION R — CONVERTER OUTPUT", { style: "Heading1" }),
    para("Q60. Which of these have you contacted in the last 12 months? SELECT ALL THAT APPLY."),
    para("ROUTING: if Q60 = 99 (none) then SKIP TO Q65 and set contact_none = 1."),
    para("TERMINATE anyone who selects both 99 and any other code (T13) — data integrity check."),
  ].join("");

  const contentTypes = CONTENT_TYPES.replace("/word/document.xml", "/word/document2.xml");
  const rootRels = ROOT_RELS.replace("word/document.xml", "word/document2.xml");

  const name = "19-alt-part-name.docx";
  save(
    name,
    zipSync({
      "[Content_Types].xml": utf8(contentTypes),
      "_rels/.rels": utf8(rootRels),
      "word/document2.xml": utf8(documentXml(body)),
    }),
  );
  record(
    name,
    "the main document part lives at word/document2.xml and is declared through _rels/.rels — the hardcoded path assumption",
    [
      probe("present", "Q60. Which of these have you contacted", "the questionnaire body"),
      probe("present", "TERMINATE anyone who selects both 99 and any other code (T13)", "a data-integrity termination rule"),
    ],
    {
      expected_outcome: "crash",
      note:
        "the parser hardcodes word/document.xml instead of resolving the officeDocument relationship in _rels/.rels; this fails loudly today, which is the right failure but the wrong outcome",
    },
  );
}

/* ================================================================== */
/* 20 — text MOVED with track changes on (w:moveFrom / w:moveTo)       */
/* ================================================================== */

function movedText() {
  const RV = 'w:author="R. Aiyar" w:date="2026-03-12T10:02:00Z"';
  const body = [
    para("SECTION S — REORDERED MODULE", { style: "Heading1" }),
    para("Q70. How often do you check your energy usage online?"),
    // The move DESTINATION: Word writes w:moveTo with ordinary w:t runs.
    `<w:p><w:moveToRangeStart w:id="700" w:name="move700" ${RV}/>` +
      `<w:moveTo w:id="701" ${RV}>` +
      `<w:r><w:t xml:space="preserve">Q71. ROUTING: if Q70 = 5 (never) then SKIP TO Q80 and set engaged = 0.</w:t></w:r>` +
      `</w:moveTo><w:moveToRangeEnd w:id="700"/></w:p>`,
    para("Q72. And how often do you contact your supplier?"),
    // The move SOURCE: Word writes w:moveFrom with w:delText runs.
    `<w:p><w:moveFromRangeStart w:id="700" w:name="move700" ${RV}/>` +
      `<w:moveFrom w:id="702" ${RV}>` +
      `<w:r><w:delText xml:space="preserve">Q71. ROUTING: if Q70 = 5 (never) then SKIP TO Q80 and set engaged = 0.</w:delText></w:r>` +
      `</w:moveFrom><w:moveFromRangeEnd w:id="700"/></w:p>`,
    para("Q73. Would you use a usage-alert service?"),
  ].join("");

  const name = "20-moved-text.docx";
  save(name, buildDocx({ "word/document.xml": documentXml(body) }));
  record(
    name,
    "a block moved with track changes on: w:moveTo (destination, w:t runs) and w:moveFrom (source, w:delText runs) both still in the file",
    [
      probe("present", "SKIP TO Q80 and set engaged = 0", "the moved routing rule must appear at its NEW position"),
      probe(
        "noregex",
        "SKIP TO Q80[\\s\\S]*SKIP TO Q80",
        "the rule must appear exactly ONCE — emitting both moveTo and moveFrom duplicates it",
        "meaning",
      ),
      probe(
        "regex",
        "Q71\\. ROUTING[\\s\\S]*Q72\\.",
        "the moved rule must sit before Q72 (its destination), not after it (its source)",
        "meaning",
      ),
    ],
  );
}

/* ================================================================== */

textboxAndSdt();
utf16Document();
word2003();
nestedTable();
fieldsSymbolsBom();
defaultNamespace();
ole2Header();
altPartName();
movedText();
writeManifest("_probes-raw.json");
console.log("raw OOXML fixtures written to", CORPUS_DIR);

/*
 * gen-docxlib.mjs — hazards that the `docx` npm package can express honestly.
 *
 * Produces corpus/01..10 and 12. Each file is a plausible fragment of a real
 * market-research questionnaire that has been through Word, not a synthetic
 * XML toy. Every fixture also records `probes`: the strings that MUST survive
 * extraction (or MUST NOT, for tracked deletions).
 *
 * Run: node gen/gen-docxlib.mjs
 */

import {
  AlignmentType,
  BorderStyle,
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  Document,
  EndnoteReferenceRun,
  ExternalHyperlink,
  Footer,
  FootnoteReferenceRun,
  Header,
  HeadingLevel,
  ImageRun,
  InsertedTextRun,
  DeletedTextRun,
  LevelFormat,
  Packer,
  Paragraph,
  SimpleField,
  Table,
  TableCell,
  TableRow,
  Textbox,
  TextRun,
  VerticalMergeType,
  WidthType,
} from "docx";
import {
  CORPUS_DIR,
  drawText,
  encodePng,
  hline,
  probe,
  record,
  save,
  vline,
  writeManifest,
} from "./common.mjs";

const REV = { author: "S. Okonjo", date: "2026-03-11T09:14:00Z" };

const P = (text, opts = {}) => new Paragraph({ text, ...opts });
const H = (text, heading = HeadingLevel.HEADING_1) => new Paragraph({ text, heading });

async function emit(name, doc) {
  const buf = await Packer.toBuffer(doc);
  save(name, new Uint8Array(buf));
  return name;
}

/* ================================================================== */
/* 01 — tracked changes still live in the file                        */
/* ================================================================== */
async function trackedChanges() {
  const doc = new Document({
    features: { trackRevisions: true },
    sections: [
      {
        children: [
          H("SECTION B — BRAND USAGE"),
          new Paragraph({
            children: [
              new TextRun("Q4. In the last "),
              new DeletedTextRun({ text: "six (6) months", id: 101, ...REV }),
              new InsertedTextRun({ text: "twelve (12) months", id: 102, ...REV }),
              new TextRun(", which of the following energy suppliers have you used? SELECT ALL THAT APPLY."),
            ],
          }),
          // A whole paragraph inserted by a reviewer and never accepted.
          new Paragraph({
            children: [
              new InsertedTextRun({
                text: "INTERVIEWER: if the respondent names a supplier not on the list, record it verbatim at Q4_OTHER and do not terminate.",
                id: 103,
                ...REV,
              }),
            ],
          }),
          // A whole paragraph deleted by a reviewer and never accepted.
          new Paragraph({
            children: [
              new DeletedTextRun({
                text: "SCRIPTER NOTE: hard-terminate anyone who selects only Other at Q4.",
                id: 104,
                ...REV,
              }),
            ],
          }),
          P("Q5. How satisfied are you with your current supplier? SINGLE CODE."),
          new Paragraph({
            children: [
              new TextRun("ROUTING: if Q5 = 1 or 2, "),
              new DeletedTextRun({ text: "skip to Q9", id: 105, ...REV }),
              new InsertedTextRun({ text: "ask Q6 then skip to Q10", id: 106, ...REV }),
              new TextRun("."),
            ],
          }),
        ],
      },
    ],
  });
  const name = await emit("01-tracked-changes.docx", doc);
  record(name, "tracked changes (w:ins / w:del) still present, revisions not accepted", [
    probe("present", "twelve (12) months", "the ACCEPTED recall window; w:ins text is the live requirement"),
    probe("absent", "six (6) months", "superseded recall window; w:del text must not resurface as a live rule", "meaning"),
    probe("present", "record it verbatim at Q4_OTHER", "inserted whole-paragraph instruction is a live rule"),
    probe("absent", "hard-terminate anyone who selects only Other", "deleted whole-paragraph rule must not resurface", "meaning"),
    probe("present", "ask Q6 then skip to Q10", "inserted routing overrides the deleted routing"),
    probe("absent", "skip to Q9", "deleted routing must not survive", "meaning"),
  ]);
}

/* ================================================================== */
/* 02 — comments carrying live instructions                           */
/* ================================================================== */
async function comments() {
  const doc = new Document({
    comments: {
      children: [
        {
          id: 0,
          author: "M. Devlin (Client)",
          initials: "MD",
          date: new Date("2026-03-02T11:00:00Z"),
          children: [
            new Paragraph(
              "Please cap this at 3 selections — legal will not sign off on unlimited multi-select here.",
            ),
          ],
        },
        {
          id: 1,
          author: "R. Aiyar (Research)",
          initials: "RA",
          date: new Date("2026-03-03T15:20:00Z"),
          children: [
            new Paragraph(
              "AGREED — cap at 3. Also randomise codes 1-8, anchor code 9 (None of these) at the bottom.",
            ),
          ],
        },
        {
          id: 2,
          author: "M. Devlin (Client)",
          initials: "MD",
          date: new Date("2026-03-04T08:05:00Z"),
          children: [
            new Paragraph("Quota check: we need minimum 120 completes in the 18-24 cell."),
          ],
        },
      ],
    },
    sections: [
      {
        children: [
          H("SECTION C — ATTITUDES"),
          new Paragraph({
            children: [
              new CommentRangeStart(0),
              new TextRun("Q11. Which of these features matter most when choosing a tariff? "),
              new CommentRangeEnd(0),
              new TextRun({ children: [new CommentReference(0)] }),
              new CommentRangeStart(1),
              new TextRun("SELECT ALL THAT APPLY."),
              new CommentRangeEnd(1),
              new TextRun({ children: [new CommentReference(1)] }),
            ],
          }),
          P("1. Price per kWh"),
          P("2. Fixed-term certainty"),
          P("3. Green generation mix"),
          P("9. None of these"),
          new Paragraph({
            children: [
              new CommentRangeStart(2),
              new TextRun("Q12. What is your age?"),
              new CommentRangeEnd(2),
              new TextRun({ children: [new CommentReference(2)] }),
            ],
          }),
        ],
      },
    ],
  });
  const name = await emit("02-comments.docx", doc);
  record(name, "Word comments (word/comments.xml) carrying live, unresolved instructions", [
    probe("present", "cap this at 3 selections", "a hard scripting constraint that exists ONLY in a comment"),
    probe("present", "randomise codes 1-8, anchor code 9", "randomisation rule that exists ONLY in a comment"),
    probe("present", "minimum 120 completes in the 18-24 cell", "quota rule that exists ONLY in a comment"),
    probe("present", "Q11. Which of these features matter most", "body text around the comment anchors must be intact"),
  ]);
}

/* ================================================================== */
/* 03 — routing matrix where meaning lives in row/column headers       */
/* ================================================================== */
function cell(children, opts = {}) {
  return new TableCell({
    children: children.map((c) => (typeof c === "string" ? new Paragraph(c) : c)),
    ...opts,
  });
}

async function routingMatrix() {
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: [
          cell([""], { columnSpan: 1 }),
          cell(["Q8 = 1 (Owns)"]),
          cell(["Q8 = 2 (Rents)"]),
          cell(["Q8 = 3 (Other)"]),
        ],
      }),
      new TableRow({
        children: [
          cell(["Age 18-34"]),
          cell(["Ask Q9a"]),
          cell(["Ask Q9b"]),
          cell(["TERMINATE (T3)"]),
        ],
      }),
      new TableRow({
        children: [
          cell(["Age 35-54"]),
          cell(["Ask Q9a"]),
          cell(["Ask Q9b"]),
          cell(["Ask Q9c"]),
        ],
      }),
      new TableRow({
        children: [
          cell(["Age 55+"]),
          cell(["Ask Q9c"]),
          cell(["Ask Q9c"]),
          cell(["TERMINATE (T3)"]),
        ],
      }),
    ],
  });

  // Second table: a vertically merged stub column — the label appears once and
  // the continuation rows are structurally empty. This is how real routing
  // grids are drawn.
  const merged = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: [cell(["Cell"]), cell(["Sub-quota"]), cell(["Target n"]), cell(["Hard stop?"])],
      }),
      new TableRow({
        children: [
          cell(["METRO"], { verticalMerge: VerticalMergeType.RESTART }),
          cell(["London"]),
          cell(["200"]),
          cell(["Yes — close at 200"]),
        ],
      }),
      new TableRow({
        children: [
          cell([], { verticalMerge: VerticalMergeType.CONTINUE }),
          cell(["Manchester"]),
          cell(["120"]),
          cell(["Yes — close at 120"]),
        ],
      }),
      new TableRow({
        children: [
          cell(["RURAL"], { verticalMerge: VerticalMergeType.RESTART }),
          cell(["Highlands"]),
          cell(["60"]),
          cell(["No — soft quota"]),
        ],
      }),
      new TableRow({
        children: [
          cell([], { verticalMerge: VerticalMergeType.CONTINUE }),
          cell(["Mid-Wales"]),
          cell(["60"]),
          cell(["No — soft quota"]),
        ],
      }),
      new TableRow({
        children: [
          cell(["ALL CELLS — screener applies before quota check"], { columnSpan: 4 }),
        ],
      }),
    ],
  });

  const doc = new Document({
    sections: [
      {
        children: [
          H("SECTION D — ROUTING"),
          P("Q9 routing is defined by Table 1. Do not route from the question text alone."),
          P("Table 1 — Q9 routing by tenure and age band"),
          table,
          P(""),
          P("Table 2 — Regional quota cells"),
          merged,
        ],
      },
    ],
  });
  const name = await emit("03-routing-matrix-table.docx", doc);
  record(
    name,
    "routing matrix in a w:tbl — meaning lives in the row stub and the column header, plus vMerge/gridSpan",
    [
      probe("present", "Q8 = 2 (Rents)", "column header carries half the routing condition"),
      probe("present", "Age 55+", "row stub carries the other half"),
      probe("present", "TERMINATE (T3)", "the terminate outcome itself"),
      probe(
        "regex",
        "Age 55\\+\\tAsk Q9c\\tAsk Q9c\\tTERMINATE \\(T3\\)",
        "the row must stay on ONE line with its stub, or the cell/condition pairing is lost",
        "meaning",
      ),
      probe("present", "Manchester", "vMerge continuation row content"),
      probe(
        "regex",
        "METRO\\tLondon",
        "the merged stub label must be attached to its first row",
        "meaning",
      ),
      probe("present", "ALL CELLS — screener applies before quota check", "gridSpan footer row rule"),
    ],
    {
      known_structural_gap:
        "the vMerge CONTINUE rows (Manchester, Mid-Wales) have a structurally empty stub cell; no text extractor can recover 'METRO' for them without reading w:vMerge",
    },
  );
}

/* ================================================================== */
/* 04 — a rule that exists only in a footnote / endnote                */
/* ================================================================== */
async function footnotes() {
  const doc = new Document({
    footnotes: {
      1: {
        children: [
          new Paragraph(
            "During SOFT LAUNCH only, a respondent who fails Q4 is NOT terminated: set qc_flag = 1 and allow the interview to continue. At FULL LAUNCH the same failure terminates immediately at T5.",
          ),
        ],
      },
      2: {
        children: [
          new Paragraph(
            "Outcodes beginning BT route to the Northern Ireland cell. IM, JE and GY outcodes are out of scope and must route to T7 on the first attempt.",
          ),
        ],
      },
    },
    endnotes: {
      1: {
        children: [
          new Paragraph(
            "Weighting note: the achieved sample is weighted to ONS mid-2025 estimates by region, age and tenure. Unweighted bases must be shown on every chart.",
          ),
        ],
      },
    },
    sections: [
      {
        children: [
          H("SECTION A — SCREENER"),
          new Paragraph({
            children: [
              new TextRun("Q4. Are you solely or jointly responsible for the energy bills in your household?"),
              new FootnoteReferenceRun(1),
            ],
          }),
          P("1. Solely responsible"),
          P("2. Jointly responsible"),
          P("3. Not responsible — TERMINATE (T5)"),
          new Paragraph({
            children: [
              new TextRun("Q5. What is the first part of your postcode?"),
              new FootnoteReferenceRun(2),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun("Q6. Reporting of this study follows the weighting convention below."),
              new EndnoteReferenceRun(1),
            ],
          }),
        ],
      },
    ],
  });
  const name = await emit("04-footnote-endnote-rule.docx", doc);
  record(name, "a live rule stated ONLY in a footnote (word/footnotes.xml) or endnote (word/endnotes.xml)", [
    probe("present", "set qc_flag = 1", "soft-launch exception exists only in footnote 1"),
    probe("present", "terminates immediately at T5", "full-launch behaviour exists only in footnote 1"),
    probe("present", "out of scope and must route to T7", "postcode scope rule exists only in footnote 2"),
    probe("present", "Unweighted bases must be shown", "reporting rule exists only in endnote 1"),
    probe("present", "Q4. Are you solely or jointly responsible", "body text must be intact"),
  ]);
}

/* ================================================================== */
/* 05 — option list defined in an appendix, referenced by name         */
/* ================================================================== */
async function appendixList() {
  const doc = new Document({
    sections: [
      {
        children: [
          H("SECTION E — BRAND AWARENESS"),
          P("Q14. Which of these suppliers have you heard of? SHOW LIST A. SELECT ALL THAT APPLY."),
          P("Q15. And which have you ever switched to? SHOW LIST A, PUNCHED AT Q14."),
          P("Q16. Which of these tariff types are you aware of? SHOW LIST B. SINGLE CODE."),
          new Paragraph({ text: "", pageBreakBefore: true }),
          H("APPENDIX 1 — MASTER CODE LISTS"),
          P("LIST A — Energy suppliers (randomise 1-9, anchor 98 and 99)"),
          P("1. Britannia Power"),
          P("2. Kestrel Energy"),
          P("3. Northwind Utilities"),
          P("4. Sable & Co Energy"),
          P("5. Verdant Grid"),
          P("6. OrbitOne"),
          P("7. Halcyon Supply"),
          P("8. Trellis Energy"),
          P("9. Marchmont Gas & Power"),
          P("98. Other (specify)"),
          P("99. None of these — EXCLUSIVE"),
          P(""),
          P("LIST B — Tariff types (do NOT randomise; keep in order shown)"),
          P("1. Fixed-rate, 12 month"),
          P("2. Fixed-rate, 24 month"),
          P("3. Standard variable"),
          P("4. Time-of-use / Economy 7"),
          P("5. Green-only tariff"),
        ],
      },
    ],
  });
  const name = await emit("05-appendix-option-list.docx", doc);
  record(name, "option list defined in an appendix and referenced by name (SHOW LIST A) from the body", [
    probe("present", "SHOW LIST A", "the reference in the body"),
    probe("present", "Marchmont Gas & Power", "an option that only exists in the appendix (and contains an & entity)"),
    probe("present", "99. None of these — EXCLUSIVE", "exclusivity rule attached to the appendix option"),
    probe("present", "do NOT randomise; keep in order shown", "list-level rule attached to LIST B"),
    probe("order", ["SHOW LIST A", "LIST A — Energy suppliers"], "the reference must precede the definition; document order matters for resolution"),
  ]);
}

/* ================================================================== */
/* 06 — inconsistent numbering, incl. auto-numbered lists              */
/* ================================================================== */
async function numbering() {
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "q-numbers",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "Q%1.",
              alignment: AlignmentType.START,
            },
          ],
        },
        {
          reference: "opt-letters",
          levels: [
            {
              level: 0,
              format: LevelFormat.LOWER_LETTER,
              text: "%1)",
              alignment: AlignmentType.START,
            },
          ],
        },
      ],
    },
    sections: [
      {
        children: [
          H("SECTION F — USAGE DETAIL"),
          P("Q6. How many people live in your household?"),
          P("Q7a. Do you have a smart meter installed?"),
          P("Q7b. IF Q7a = 1: In what year was it installed?"),
          P("Q7b_i. IF year is before 2019: has it been replaced since?"),
          P("Q8. Which room do you heat most?"),
          // A manual "Q10" that is really the 11th question in the section.
          P("Q10. Do you use any of the following in winter? (NOTE: there is no Q9 — it was cut in v4)"),
          P("Q11. How would you rate your home's insulation?"),

          new Paragraph({ text: "", pageBreakBefore: true }),
          H("SECTION G — NEW MODULE (numbering restarts)"),
          P("This module was written by a different author and restarts at 1."),
          P("1. Which of these have you done in the last year?"),
          P("2. And which do you plan to do next year?"),
          P("3. Why have you not done the others?"),

          new Paragraph({ text: "", pageBreakBefore: true }),
          H("SECTION H — AUTO-NUMBERED (Word list numbering)"),
          P("The question numbers below are Word auto-numbers, not typed text."),
          new Paragraph({
            text: "Which supplier do you use for gas?",
            numbering: { reference: "q-numbers", level: 0 },
          }),
          new Paragraph({
            text: "Which supplier do you use for electricity?",
            numbering: { reference: "q-numbers", level: 0 },
          }),
          new Paragraph({
            text: "Are these the same supplier?",
            numbering: { reference: "q-numbers", level: 0 },
          }),
          P("Codes for the question above (auto-lettered):"),
          new Paragraph({
            text: "Yes, same supplier",
            numbering: { reference: "opt-letters", level: 0 },
          }),
          new Paragraph({
            text: "No, different suppliers",
            numbering: { reference: "opt-letters", level: 0 },
          }),
          new Paragraph({
            text: "Don't know — DO NOT READ",
            numbering: { reference: "opt-letters", level: 0 },
          }),
        ],
      },
    ],
  });
  const name = await emit("06-inconsistent-numbering.docx", doc);
  record(
    name,
    "inconsistent numbering: Q7a/Q7b/Q7b_i, a section restarting at 1, a manual Q10 that is the 11th question, and Word AUTO-numbered questions/options",
    [
      probe("present", "Q7b_i.", "sub-sub numbering must survive verbatim"),
      probe("present", "there is no Q9 — it was cut in v4", "the numbering-gap note"),
      probe("present", "Which supplier do you use for gas?", "auto-numbered question text"),
      probe(
        "regex",
        "Q1\\.\\s*Which supplier do you use for gas\\?",
        "the AUTO-generated question number Q1 lives in numbering.xml, not in the run text",
        "meaning",
      ),
      probe(
        "regex",
        "a\\)\\s*Yes, same supplier",
        "the AUTO-generated option letter a) lives in numbering.xml, not in the run text",
        "meaning",
      ),
      probe("present", "1. Which of these have you done in the last year?", "the manually typed restart-at-1 numbering"),
    ],
  );
}

/* ================================================================== */
/* 07 — headers/footers with client name and DRAFT watermark           */
/* ================================================================== */
async function headersFooters() {
  const doc = new Document({
    sections: [
      {
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    text: "DRAFT — NOT FOR FIELD",
                    bold: true,
                    size: 48,
                    color: "C0C0C0",
                  }),
                ],
              }),
              new Paragraph({
                children: [
                  new TextRun("CONFIDENTIAL — prepared for Northwind Utilities plc | Project 41-2287 | v6.2"),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph(
                "All monetary values shown to respondents must be in GBP and rounded to the nearest £1. Do not show pence.",
              ),
            ],
          }),
        },
        children: [
          H("SECTION I — PRICING"),
          P("Q20. What do you currently pay per month for electricity?"),
          P("Q21. And what would you consider a fair monthly price?"),
          new Paragraph({
            children: [
              new Textbox({
                children: [
                  new TextRun(
                    "WATERMARK NOTE: this version is DRAFT ONLY. Do not script until the client has signed off Section I.",
                  ),
                ],
              }),
            ],
          }),
        ],
      },
    ],
  });
  const name = await emit("07-header-footer-watermark.docx", doc);
  record(name, "client name + DRAFT marker in the header (word/header1.xml) and a rule in the footer (word/footer1.xml)", [
    probe("present", "DRAFT — NOT FOR FIELD", "the draft status of the whole document"),
    probe("present", "prepared for Northwind Utilities plc", "the client identity — provenance, appears on every page", "context"),
    probe("present", "rounded to the nearest £1. Do not show pence", "a live currency-display rule that lives only in the footer"),
    probe("present", "Do not script until the client has signed off", "text-box note in the body"),
    probe("present", "Q20. What do you currently pay per month", "body text must be intact"),
  ]);
}

/* ================================================================== */
/* 08 — smart quotes, dashes, NBSP and friends                         */
/* ================================================================== */
const NBSP = " ";
const NNBSP = " ";
const SHY = "­";
const ZWSP = "​";

async function unicodePunctuation() {
  const doc = new Document({
    sections: [
      {
        children: [
          H("SECTION J — TYPOGRAPHY TRAPS"),
          P(
            "Q22. Thinking about your “main” supplier — the one you’d name first — how likely are you to switch in the next 6–12 months?",
          ),
          P(`Q23. Do you pay more than £100${NBSP}per${NBSP}month?`),
          P("Q24. Rate each statement from 1 – 5 (1 = strongly disagree, 5 = strongly agree)…"),
          P(`Q25. Have you used the Northwind${NNBSP}app in the last 30${NBSP}days?`),
          P(`SCRIPTER: the label below contains a soft hyphen and a zero-width space: multi${SHY}national${ZWSP}suppliers.`),
          P("Q26. ½ of respondents will see version A; ⅓ of those will see the © disclaimer."),
          P("Q27. Temperature comfort ≥ 18°C — agree or disagree?"),
        ],
      },
    ],
  });
  const name = await emit("08-unicode-punctuation.docx", doc);
  record(name, "smart quotes, en/em dashes, non-breaking and narrow-no-break spaces, soft hyphen, ZWSP, fractions and symbols", [
    probe("present", "“main”", "curly double quotes must survive as typed"),
    probe("present", "you’d", "curly apostrophe must survive"),
    probe("present", "6–12 months", "en dash inside a range — a naive ASCII fold changes the meaning of the range", "meaning"),
    probe("present", "— the one you", "em dash as an aside marker"),
    probe("present", `£100${NBSP}per${NBSP}month`, "NBSP must survive; collapsing it to a normal space silently changes the string a comparator sees", "meaning"),
    probe("present", "≥ 18°C", "maths and degree symbols"),
    probe("present", "…", "ellipsis character, not three dots"),
    probe("present", "½ of respondents", "vulgar fraction"),
  ]);
}

/* ================================================================== */
/* 09 — one question split across many runs by mid-word formatting     */
/* ================================================================== */
async function splitRuns() {
  const doc = new Document({
    sections: [
      {
        children: [
          H("SECTION K — RUN FRAGMENTATION"),
          // Mid-word bold: "Satisfied" is split Sat|is|fied with bold on "is".
          new Paragraph({
            children: [
              new TextRun("Q30. How "),
              new TextRun("sat"),
              new TextRun({ text: "is", bold: true }),
              new TextRun("fied are you with the "),
              new TextRun({ text: "speed", bold: true, underline: {} }),
              new TextRun(" of the callout service?"),
            ],
          }),
          // Every word its own run (what Word does after heavy editing).
          new Paragraph({
            children: [
              "Q31.",
              " ",
              "Would",
              " ",
              "you",
              " ",
              "rec",
              "om",
              "mend",
              " ",
              "North",
              "wind",
              " ",
              "to",
              " ",
              "a",
              " ",
              "friend",
              "?",
            ].map((t) => new TextRun(t)),
          }),
          // Formatting split inside a routing token: "TER|MIN|ATE (T9)".
          new Paragraph({
            children: [
              new TextRun("IF Q31 = 1 THEN "),
              new TextRun({ text: "TER", bold: true }),
              new TextRun({ text: "MIN", bold: true, italics: true }),
              new TextRun({ text: "ATE", bold: true }),
              new TextRun(" (T9)"),
            ],
          }),
          // Split inside a numeric threshold: "1" | "8" -> 18
          new Paragraph({
            children: [
              new TextRun("SCREEN OUT anyone under "),
              new TextRun({ text: "1", bold: true }),
              new TextRun("8 years of age."),
            ],
          }),
          // A hyperlink and a field, both of which fragment the paragraph.
          new Paragraph({
            children: [
              new TextRun("Q32. Please read the privacy notice at "),
              new ExternalHyperlink({
                children: [new TextRun({ text: "northwind.example/privacy", style: "Hyperlink" })],
                link: "https://northwind.example/privacy",
              }),
              new TextRun(" before continuing."),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun("Document page "),
              new SimpleField("PAGE", "3"),
              new TextRun(" of "),
              new SimpleField("NUMPAGES", "7"),
              new TextRun(" — quota table continues overleaf."),
            ],
          }),
        ],
      },
    ],
  });
  const name = await emit("09-split-runs.docx", doc);
  record(name, "question text split across many w:r runs by mid-word formatting, hyperlinks and fields", [
    probe("present", "How satisfied are you with the speed", "mid-word bold must not fracture the word"),
    probe("present", "Would you recommend Northwind to a friend?", "word-per-run paragraph must reassemble exactly"),
    probe("present", "TERMINATE (T9)", "a routing token split by formatting must reassemble or the rule is unfindable", "meaning"),
    probe("present", "anyone under 18 years of age", "a numeric threshold split across runs must reassemble", "meaning"),
    probe("present", "northwind.example/privacy", "hyperlink display text"),
    probe("noregex", "sat\\s+is\\s+fied", "runs must not be joined with inserted whitespace", "meaning"),
  ]);
}

/* ================================================================== */
/* 10 — instructions that exist only inside an embedded image          */
/* ================================================================== */
function gridScreenshot() {
  const w = 720;
  const h = 300;
  const px = new Uint8Array(w * h).fill(255);
  drawText(px, w, h, 12, 10, "Q18 GRID - ROWS RANDOMISED, COLS FIXED", 3);
  drawText(px, w, h, 12, 34, "SCALE: 1=NOT AT ALL, 5=VERY", 3);
  // grid
  const x0 = 12, y0 = 70, cw = 110, ch = 34, cols = 6, rows = 5;
  for (let r = 0; r <= rows; r++) hline(px, w, h, x0, x0 + cols * cw, y0 + r * ch);
  for (let c = 0; c <= cols; c++) vline(px, w, h, x0 + c * cw, y0, y0 + rows * ch);
  const colLabels = ["BRAND", "1", "2", "3", "4", "5"];
  colLabels.forEach((l, i) => drawText(px, w, h, x0 + i * cw + 8, y0 + 10, l, 3));
  const rowLabels = ["BRITANNIA", "KESTREL", "NORTHWIND", "SABLE CO"];
  rowLabels.forEach((l, i) => drawText(px, w, h, x0 + 6, y0 + (i + 1) * ch + 10, l, 2));
  drawText(px, w, h, 12, y0 + rows * ch + 14, "NOTE: TERMINATE IF ALL ROWS = 1", 3);
  return encodePng(px, w, h);
}

function logoPng() {
  const w = 200, h = 60;
  const px = new Uint8Array(w * h).fill(255);
  drawText(px, w, h, 8, 20, "NORTHWIND", 3);
  return encodePng(px, w, h);
}

async function imageInstructions() {
  const doc = new Document({
    sections: [
      {
        children: [
          H("SECTION L — GRID"),
          P("Q18. Please rate each brand on the scale shown below."),
          P("SCRIPTER: build the grid exactly as shown in the screenshot."),
          new Paragraph({
            children: [
              new ImageRun({
                type: "png",
                data: gridScreenshot(),
                transformation: { width: 540, height: 225 },
                // No altText at all — this is the common case.
              }),
            ],
          }),
          P("Q19. And overall, which brand would you choose?"),
          new Paragraph({
            children: [
              new ImageRun({
                type: "png",
                data: logoPng(),
                transformation: { width: 150, height: 45 },
                altText: {
                  name: "client-logo",
                  title: "Northwind Utilities logo",
                  description:
                    "Client logo. SCRIPTER: show the client logo on the intro screen only, never on question screens.",
                },
              }),
            ],
          }),
        ],
      },
    ],
  });
  const name = await emit("10-image-instructions.docx", doc);
  record(
    name,
    "an embedded PNG screenshot carrying the grid definition (content a text parser CANNOT see) plus one image whose instruction lives in wp:docPr/@descr alt text",
    [
      probe("present", "Q18. Please rate each brand", "surrounding body text"),
      probe("present", "build the grid exactly as shown in the screenshot", "the pointer to the image"),
      probe(
        "present",
        "show the client logo on the intro screen only",
        "an instruction that IS recoverable from XML: it sits in the image's alt-text description",
      ),
      probe(
        "present",
        "TERMINATE IF ALL ROWS = 1",
        "rendered into the PNG pixels only — unrecoverable without OCR; this probe is EXPECTED to fail and exists to prove the blind spot",
        "requirement",
      ),
    ],
    {
      expected_unrecoverable: ["TERMINATE IF ALL ROWS = 1"],
      note:
        "the pixel-only probe cannot be fixed by better XML parsing; it can only be DETECTED (count w:drawing / w:pict) and surfaced to the user",
    },
  );
}

/* ================================================================== */
/* 12 — a long document (chunking limits)                              */
/* ================================================================== */
async function longDocument() {
  const children = [
    H("MASTER QUESTIONNAIRE — PROJECT 41-2287 (LONG FORM)"),
    P("This instrument has 64 numbered questions across 8 modules."),
  ];
  const topics = [
    "energy use",
    "tariff awareness",
    "switching behaviour",
    "smart meters",
    "billing",
    "customer service",
    "sustainability",
    "future intentions",
  ];
  let qn = 1;
  for (let m = 0; m < 8; m++) {
    children.push(new Paragraph({ text: `MODULE ${m + 1} — ${topics[m].toUpperCase()}`, heading: HeadingLevel.HEADING_1 }));
    for (let i = 0; i < 8; i++) {
      children.push(
        P(
          `Q${qn}. Thinking specifically about ${topics[m]}, how much do you agree with statement ${i + 1}? SINGLE CODE.`,
        ),
      );
      children.push(P("1. Strongly agree"));
      children.push(P("2. Tend to agree"));
      children.push(P("3. Neither agree nor disagree"));
      children.push(P("4. Tend to disagree"));
      children.push(P("5. Strongly disagree"));
      if (qn === 47) {
        children.push(
          P("SCRIPTER: Q47 is the ONLY question in the instrument with a randomised statement order. Do not randomise elsewhere."),
        );
      }
      qn++;
    }
  }
  children.push(
    P("END OF QUESTIONNAIRE — thank and close (code C1). Median length target: 14 minutes."),
  );
  const doc = new Document({ sections: [{ children }] });
  const name = await emit("12-long-document.docx", doc);
  record(name, "long instrument (64 questions, ~450 paragraphs) — chunking / truncation limits", [
    probe("present", "Q1. Thinking specifically about energy use", "first question"),
    probe("present", "Q47 is the ONLY question in the instrument with a randomised statement order", "a unique rule buried in the middle"),
    probe("present", "Q64. Thinking specifically about future intentions", "last question"),
    probe("present", "Median length target: 14 minutes", "final line — proves no tail truncation"),
  ]);
}

/* ================================================================== */

await trackedChanges();
await comments();
await routingMatrix();
await footnotes();
await appendixList();
await numbering();
await headersFooters();
await unicodePunctuation();
await splitRuns();
await imageInstructions();
await longDocument();
writeManifest("_probes-docxlib.json");
console.log("docx-lib fixtures written to", CORPUS_DIR);

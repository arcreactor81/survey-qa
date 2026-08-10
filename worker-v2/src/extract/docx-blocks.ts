/**
 * DOCX → ADDRESSABLE SOURCE BLOCKS, in the Worker.
 *
 * The production parser (`src/docx.ts`, read-only reference) is genuinely good at the
 * hardest common cases — run fragmentation reassembles exactly, tracked changes render the
 * accepted view, text boxes are handled with care, Unicode is byte-exact — so its unzip,
 * namespace-detection, run-token and entity-decoding approach is reused in full. What
 * changes is the SHAPE of the output and the HONESTY of the read:
 *
 *   - every paragraph, table cell, footnote, header/footer line and comment is its own
 *     block with a stable id and an ORIGIN LABEL, so the merge and the human reviewer can
 *     weigh a footnote differently from body copy and a comment differently from either;
 *   - a table cell carries exact structural (row, grid-column) coordinates; WordprocessingML
 *     has no semantic `th`/`scope` equivalent, so row/column headers are never guessed;
 *   - the parse REPORTS COVERAGE: which archive parts it read, which it skipped and why,
 *     how many images and field codes it could not resolve.
 *
 * FOUR FAILURES FROM THE 20-DOCUMENT ROBUSTNESS CORPUS (test-suite/docx-robustness/
 * FINDINGS.md) are addressed here, and all four were SILENT in v1:
 *   1. Word AUTO-NUMBERING lives in numbering.xml, not in document.xml, so "Q1." simply
 *      evaporated while manually typed numbers in the same file survived. A paragraph
 *      numbered by Word now carries a visible "[#]" placeholder: a known unknown is
 *      recoverable, a silent gap is not.
 *   2. FOOTNOTES, ENDNOTES, COMMENTS and HEADERS/FOOTERS were never inflated at all, with
 *      no marker that they existed. They are read, labelled by origin, and counted.
 *   3. NESTED TABLES broke row pairing because a lazy `<w:tbl>...</w:tbl>` match ends on the
 *      INNER close tag — and an UNCLOSED `<w:tbl>` made every lazy scan run to end of
 *      string, which in a Worker is a CPU-limit kill. Table extents are now found by a
 *      depth-counting scan that refuses an unbalanced document instead of chewing it.
 *   4. IMAGES emitted an empty line; their alt text (wp:docPr/@descr) is recovered.
 *
 * A WORD COMMENT IS A PROPOSAL, NOT THE SPEC. Comments are labelled `comment` and the block
 * pass is told it may not turn one into an obligation on its own — emitting them as body
 * text would manufacture false discrepancies against a site that implemented the body
 * correctly.
 *
 * Nothing here interprets. A block is a unit of source, not a requirement.
 */

import { unzipSync, type UnzipFileInfo } from "fflate";
import type { DocumentCoverage, ParsedDocument, SourceBlock } from "./types";

/**
 * Load-bearing parser semantics. Persisted model work records this value and must not be
 * reused after it changes, even when the document's block ids happen to remain identical.
 */
export const DOCX_BLOCKS_VERSION = "v2-docx-blocks/1.1.0" as const;

const PACKAGE_RELS = "_rels/.rels";
/** What `partsRead` calls a flat Word 2003 XML document, which has no parts at all. */
const FLAT_WORDML_PART = "(flat WordprocessingML)";
const DOCUMENT_XML = "word/document.xml";
const FOOTNOTES_XML = "word/footnotes.xml";
const ENDNOTES_XML = "word/endnotes.xml";
const COMMENTS_XML = "word/comments.xml";
const COMMENTS_EXT_XML = "word/commentsExtended.xml";
const HEADER_FOOTER_RE = /^word\/(header|footer)\d+\.xml$/;

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_PART_BYTES = 50 * 1024 * 1024;
/** Depth scans are linear, but a pathological document should still not run unbounded. */
const MAX_TAG_SCANS = 200_000;
/**
 * OOXML spans are author-controlled integers. Keep grid expansion bounded: a declared
 * 99,999,999-column span in a tiny document must not become a Worker memory/CPU kill.
 */
const MAX_GRID_COLUMNS = 4_096;

const WML_MAIN_NAMESPACES = [
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
];

const ENTITY_RE = /&(amp|lt|gt|quot|apos|#\d+|#[xX][0-9a-fA-F]+);/g;

interface Syntax {
  prefix: string;
  rowSrc: string;
  cellSrc: string;
  paragraphSrc: string;
  runTokenSrc: string;
}

const escapeRegExp = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildSyntax(prefix: string): Syntax {
  const p = escapeRegExp(prefix);
  return {
    prefix,
    rowSrc: `<${p}tr(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${p}tr>`,
    cellSrc: `<${p}tc(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${p}tc>`,
    paragraphSrc: `<${p}p(?=[\\s/>])[^>]*\\/>|<${p}p(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${p}p>`,
    runTokenSrc:
      `<${p}t(?=[\\s/>])[^>]*\\/>|<${p}t(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${p}t>|` +
      `<${p}tab(?=[\\s/>])[^>]*\\/>|<${p}(?:br|cr)(?=[\\s/>])[^>]*\\/>|` +
      `<${p}noBreakHyphen(?=[\\s/>])[^>]*\\/?>|<${p}softHyphen(?=[\\s/>])[^>]*\\/?>`,
  };
}

function detectPrefix(xml: string): string | null {
  const declRe = /xmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(xml)) !== null) {
    const uri = m[2] !== undefined ? m[2] : m[3];
    if (uri !== undefined && WML_MAIN_NAMESPACES.includes(uri)) {
      const prefix: string | undefined = m[1];
      return prefix ? `${prefix}:` : "";
    }
  }
  return null;
}

function decodeXmlEntities(text: string): string {
  return text.replace(ENTITY_RE, (match: string, entity: string): string => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code =
          entity[1] === "x" || entity[1] === "X"
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        if (Number.isInteger(code) && code >= 0x20 && code <= 0x10ffff) return String.fromCodePoint(code);
        return match;
      }
    }
  });
}

function decodePart(bytes: Uint8Array): string {
  let label = "utf-8";
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) label = "utf-16le";
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = "utf-16be";
  }
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const stripFallback = (xml: string) => xml.replace(/<mc:Fallback(?=[\s>])[\s\S]*?<\/mc:Fallback>/g, "");

/**
 * Word's accepted view includes insertions/move destinations and excludes deletions/move
 * sources. Metadata inside a rejected change is rejected too: otherwise a deleted dropdown
 * can manufacture live answer choices even though its displayed text correctly disappears.
 */
function acceptedViewXml(xml: string, s: Syntax, origin: string, coverage: DocumentCoverage): string {
  let accepted = xml;
  let rejectedContainers = 0;
  let oldPropertySnapshots = 0;
  // *PrChange/tblGridChange hold the superseded property snapshot, not the accepted one.
  for (const name of [
    "del",
    "moveFrom",
    "pPrChange",
    "rPrChange",
    "tblPrChange",
    "trPrChange",
    "tcPrChange",
    "sectPrChange",
    "sdtPrChange",
    "tblGridChange",
  ] as const) {
    const spans = topLevelSpans(accepted, s.prefix, name);
    if (spans === null) {
      throw new Error(
        `parseDocxBlocks: ${origin} has unbalanced <${s.prefix}${name}> tracked-change markup; ` +
          `the accepted document view cannot be established without guessing.`,
      );
    }
    if (spans.length === 0) continue;
    if (name === "del" || name === "moveFrom") rejectedContainers += spans.length;
    else oldPropertySnapshots += spans.length;
    let rebuilt = "";
    let cursor = 0;
    for (const span of spans) {
      rebuilt += accepted.slice(cursor, span.start);
      cursor = span.end;
    }
    accepted = rebuilt + accepted.slice(cursor);
  }
  if (rejectedContainers > 0 || oldPropertySnapshots > 0) {
    coverage.problems.push(
      `ACCEPTED_VIEW_FILTER_APPLIED: ${origin} excluded ${rejectedContainers} deleted/moved-from content ` +
        `container(s) and ${oldPropertySnapshots} superseded property snapshot(s); inserted/moved-to content was retained.`,
    );
  }
  const p = escapeRegExp(s.prefix);
  const leafRevisions =
    accepted.match(
      new RegExp(`<${p}(?:cellIns|cellDel|cellMerge|numberingChange|del|moveFrom)(?=[\\s/>])[^>]*\\/>`, "g"),
    )?.length ?? 0;
  if (leafRevisions > 0) {
    coverage.problems.push(
      `ACCEPTED_VIEW_LEAF_REVISIONS_UNINTERPRETED: ${origin} contains ${leafRevisions} row/cell/paragraph-mark ` +
        `revision marker(s). Their surrounding accepted text is retained, but leaf-level revision semantics were not inferred.`,
    );
  }
  return accepted;
}

/** Text boxes are the one place WordprocessingML nests paragraphs; neutralize them. */
function neutralizeTextBoxes(xml: string, s: Syntax): string {
  const p = escapeRegExp(s.prefix);
  const txbxRe = new RegExp(`<${p}txbxContent(?=[\\s>])[\\s\\S]*?<\\/${p}txbxContent>`, "g");
  const openRe = new RegExp(`<${p}p(?=[\\s/>])`, "g");
  const closeRe = new RegExp(`<\\/${p}p>`, "g");
  const sentinel = `${s.prefix}boxpara`;
  return xml.replace(txbxRe, (block) => block.replace(openRe, `<${sentinel}`).replace(closeRe, `</${sentinel}>`));
}

/**
 * `w:ruby` contains both the visible base run and its phonetic `w:rt` annotation. A flat
 * `w:t` scan interleaves them into a plausible-looking word no reader actually saw.
 */
function stripRubyReadings(body: string, s: Syntax): string {
  const p = escapeRegExp(s.prefix);
  const rtRe = new RegExp(`<${p}rt(?=[\\s>])[^>]*>[\\s\\S]*?<\\/${p}rt>`, "g");
  return body.replace(rtRe, "");
}

function rubyReadingCount(body: string, s: Syntax): number {
  const p = escapeRegExp(s.prefix);
  return body.match(new RegExp(`<${p}ruby(?=[\\s>])`, "g"))?.length ?? 0;
}

function paragraphText(body: string, s: Syntax): string {
  const parts: string[] = [];
  const tokenRe = new RegExp(s.runTokenSrc, "g");
  const tabTag = `<${s.prefix}tab`;
  const brTag = `<${s.prefix}br`;
  const crTag = `<${s.prefix}cr`;
  const noBreakHyphenTag = `<${s.prefix}noBreakHyphen`;
  const softHyphenTag = `<${s.prefix}softHyphen`;
  let token: RegExpExecArray | null;
  const visibleBody = stripRubyReadings(body, s);
  while ((token = tokenRe.exec(visibleBody)) !== null) {
    const raw = token[0];
    const captured: string | undefined = token[1];
    if (raw.startsWith(tabTag)) parts.push("\t");
    else if (raw.startsWith(brTag) || raw.startsWith(crTag)) parts.push("\n");
    // U+2011 is the character w:noBreakHyphen specifies. ASCII "-" would improve one
    // corpus probe but would discard the author's no-break distinction. A soft hyphen is
    // a rendering opportunity, not a character that is necessarily visible.
    else if (raw.startsWith(noBreakHyphenTag)) parts.push("\u2011");
    else if (raw.startsWith(softHyphenTag)) continue;
    else if (captured !== undefined) parts.push(decodeXmlEntities(captured));
  }
  return parts.join("");
}

/** Heading level from the paragraph's own properties. 0 means "not a heading". */
function headingLevel(body: string, s: Syntax): number {
  const p = escapeRegExp(s.prefix);
  const style = new RegExp(`<${p}pStyle(?=[\\s>])[^>]*${p}val="([^"]*)"`).exec(body);
  if (style) {
    const v = style[1] ?? "";
    const m = /^Heading(\d)$/i.exec(v) ?? /^Titre(\d)$/i.exec(v);
    if (m) return Number(m[1]);
    if (/^(Title|Subtitle)$/i.test(v)) return 1;
  }
  const outline = new RegExp(`<${p}outlineLvl(?=[\\s/>])[^>]*${p}val="(\\d+)"`).exec(body);
  if (outline) return Number(outline[1]) + 1;
  return 0;
}

const hasNumbering = (body: string, s: Syntax) =>
  new RegExp(`<${escapeRegExp(s.prefix)}numPr(?=[\\s/>])`).test(body);

/** A marker the author typed themselves. Word-generated numbers are NOT in document.xml. */
const ALREADY_NUMBERED = /^\s*(?:\(?\d+[.)]|\(?[a-z][.)]|\(?[ivxlc]+[.)]|[-–—•*·])\s/i;

const SECTION_TEXT_RE =
  /^(?:section\s+[a-z0-9]+\b|part\s+[a-z0-9]+\b|appendix\b|module\s+[a-z0-9]+\b|screen(?:er|ing)?\s*:|classification\b)/i;

const clean = (t: string) => t.replace(/[ \t]+\n/g, "\n").trim();

// ---------------------------------------------------------------------------
// Depth-aware element scanning — the fix for nested and unclosed tables
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
  inner: string;
}

/**
 * Top-level spans of `<prefix+name ...> ... </prefix+name>`, counting depth so a nested
 * element cannot close its parent. Returns `null` when the tags do not balance — an
 * unbalanced document is REFUSED rather than scanned lazily, because a lazy scan over an
 * unclosed `<w:tbl>` runs to end-of-string and burned 18.5 s of CPU on a 98 KB upload,
 * which inside a Worker is a kill, not a slow parse.
 */
function topLevelSpans(xml: string, prefix: string, name: string): Span[] | null {
  const p = escapeRegExp(prefix);
  const re = new RegExp(`<${p}${name}(?=[\\s/>])[^>]*?(/?)>|<\\/${p}${name}>`, "g");
  const spans: Span[] = [];
  let depth = 0;
  let openAt = -1;
  let bodyAt = -1;
  let scans = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (++scans > MAX_TAG_SCANS) return null;
    const isClose = m[0].startsWith(`</`);
    const selfClosing = m[1] === "/";
    if (selfClosing) continue;
    if (!isClose) {
      if (depth === 0) {
        openAt = m.index;
        bodyAt = m.index + m[0].length;
      }
      depth += 1;
    } else {
      depth -= 1;
      if (depth < 0) return null;
      if (depth === 0 && openAt >= 0) {
        spans.push({ start: openAt, end: re.lastIndex, inner: xml.slice(bodyAt, m.index) });
        openAt = -1;
      }
    }
  }
  return depth === 0 ? spans : null;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

type Draft = Omit<SourceBlock, "blockId">;

/**
 * Flat Word 2003 XML: an XML declaration, then a `w:wordDocument` root. It is neither a ZIP
 * nor an OLE2 file, so both of the other detections would call it corrupt.
 */
function isFlatWordML(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) return false;
  const head = new TextDecoder().decode(bytes.subarray(0, 2048));
  return /^\s*(﻿)?<\?xml/.test(head) && /<[A-Za-z0-9]*:?wordDocument[\s>]/.test(head);
}

/** OLE2/CFB magic — the signature of a legacy binary `.doc`. */
function isOle2(bytes: Uint8Array): boolean {
  const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return bytes.byteLength >= 8 && magic.every((b, i) => bytes[i] === b);
}

/**
 * The main document part, per the package relationships — with the conventional name as the
 * fallback, and a last-resort scan for the only plausible candidate. Order matters: the
 * relationship is authoritative, the convention is a guess, and the scan is a rescue.
 */
function resolveMainPart(entries: Record<string, Uint8Array>, partNames: string[]): string {
  const rels = entries[PACKAGE_RELS];
  if (rels) {
    const xml = decodePart(rels);
    const re = /<Relationship[^>]*>/g;
    for (const tag of xml.match(re) ?? []) {
      if (!/Type\s*=\s*"[^"]*\/officeDocument"/.test(tag)) continue;
      const target = /Target\s*=\s*"([^"]+)"/.exec(tag)?.[1];
      if (!target) continue;
      const normalized = target.replace(/^\.?\//, "");
      if (entries[normalized]) return normalized;
    }
  }
  if (entries[DOCUMENT_XML]) return DOCUMENT_XML;
  const candidate = partNames.find((n) => /^word\/document\d*\.xml$/.test(n) && entries[n]);
  return candidate ?? DOCUMENT_XML;
}

export function parseDocxBlocks(data: ArrayBuffer | Uint8Array): ParsedDocument {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`parseDocxBlocks: archive is ${bytes.byteLength} bytes, above the ${MAX_ARCHIVE_BYTES} limit`);
  }

  const partNames: string[] = [];
  let entries: Record<string, Uint8Array>;

  // FLAT WordprocessingML (Word 2003 XML, `.doc` or `.xml`): one XML file, no ZIP, and the
  // SAME w:p / w:tbl grammar inside. Screeners still arrive in it. Treating it as the main
  // part costs one branch and turns a hard "not a .docx" into a parsed document; the parts
  // that do not exist in this format (footnotes, headers) are simply absent, and the
  // coverage report says which parts were read.
  if (isFlatWordML(bytes)) {
    entries = { [DOCUMENT_XML]: bytes };
    partNames.push(FLAT_WORDML_PART);
  } else {
  try {
    entries = unzipSync(bytes, {
      filter: (info: UnzipFileInfo) => {
        partNames.push(info.name);
        const wanted =
          info.name === PACKAGE_RELS ||
          // ANY word/*.xml, because the main part is not always named document.xml. The
          // package relationships say which one it is, and they can only be consulted
          // after the archive is open — so the filter must not have thrown the answer
          // away by then. The extra parts are small (styles, numbering, settings).
          /^word\/[^/]+\.xml$/.test(info.name) ||
          info.name === DOCUMENT_XML ||
          info.name === FOOTNOTES_XML ||
          info.name === ENDNOTES_XML ||
          info.name === COMMENTS_XML ||
          info.name === COMMENTS_EXT_XML ||
          HEADER_FOOTER_RE.test(info.name);
        return wanted && Math.max(info.size, info.originalSize) <= MAX_PART_BYTES;
      },
    });
  } catch (err) {
    // NAME THE FORMAT WE ACTUALLY GOT. A legacy Word 97-2003 `.doc` is an OLE2 compound
    // file, not a ZIP, and "invalid zip data" sends the reader hunting for a corrupt upload
    // when the fix is one Save As away.
    if (isOle2(bytes)) {
      throw new Error(
        `parseDocxBlocks: this is a legacy Word 97-2003 document (OLE2 compound file), not a .docx. ` +
          `Re-save it as .docx — the binary format carries none of the part structure this parser reads.`,
      );
    }
    throw new Error(
      `parseDocxBlocks: input is not a readable .docx (ZIP) archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  }

  const coverage: DocumentCoverage = {
    archiveParts: partNames.length,
    partsRead: [],
    partsSkipped: [],
    images: 0,
    imagesWithAltText: 0,
    unresolvedFieldCodes: 0,
    symbolRuns: 0,
    autoNumberedParagraphs: 0,
    problems: [],
  };

  // THE MAIN PART IS WHATEVER THE PACKAGE SAYS IT IS. `word/document.xml` is a convention,
  // not a rule: a generator is free to name it `document2.xml` and point the officeDocument
  // relationship at it. Hardcoding the conventional name turns a valid document into
  // "no document", which is the worst possible failure — an empty requirement set reads as
  // "this document obliges nothing".
  const mainPart = partNames[0] === FLAT_WORDML_PART ? DOCUMENT_XML : resolveMainPart(entries, partNames);
  const documentXml = entries[mainPart];
  if (!documentXml) {
    throw new Error(
      `parseDocxBlocks: the main document part ("${mainPart}") is not in the archive. ` +
        `Parts present: ${partNames.slice(0, 20).join(", ")}`,
    );
  }

  const xml = decodePart(documentXml);
  let syntax = buildSyntax("w:");
  let blocks = scanBody(xml, syntax, coverage, "body");
  if (blocks.length === 0) {
    const detected = detectPrefix(xml);
    if (detected !== null && detected !== "w:") {
      syntax = buildSyntax(detected);
      blocks = scanBody(xml, syntax, coverage, "body");
    }
  }
  if (blocks.length === 0) {
    throw new Error(
      `parseDocxBlocks: no paragraphs could be parsed from "${DOCUMENT_XML}" (${xml.length} chars of XML). ` +
        `An empty requirement set from an unparsed document would read as "the document obliges nothing".`,
    );
  }
  coverage.partsRead.push(partNames[0] === FLAT_WORDML_PART ? FLAT_WORDML_PART : mainPart);

  // --- footnotes / endnotes ---------------------------------------------------------
  for (const [part, label] of [
    [FOOTNOTES_XML, "footnote"],
    [ENDNOTES_XML, "endnote"],
  ] as const) {
    const raw = entries[part];
    if (!raw) continue;
    const partXml = decodePart(raw);
    const s = partSyntax(partXml, syntax);
    const notes = scanNotes(partXml, s, label);
    blocks.push(...notes);
    coverage.partsRead.push(part);
    if (notes.length > 0) {
      coverage.problems.push(
        `${notes.length} ${label}(s) were read from ${part} and are labelled as such — questionnaires park conditional exceptions there, so weigh them as requirements, not decoration.`,
      );
    }
  }

  // --- headers / footers ------------------------------------------------------------
  const seenHeaderText = new Set<string>();
  for (const part of Object.keys(entries)) {
    if (!HEADER_FOOTER_RE.test(part)) continue;
    const partXml = decodePart(entries[part]!);
    const s = partSyntax(partXml, syntax);
    const label = part.includes("header") ? "header" : "footer";
    let added = 0;
    for (const d of scanBody(partXml, s, coverage, label)) {
      const key = `${label}|${clean(d.text)}`;
      if (clean(d.text).length === 0 || seenHeaderText.has(key)) continue;
      seenHeaderText.add(key);
      blocks.push({ ...d, kind: "paragraph", origin: label });
      added += 1;
    }
    coverage.partsRead.push(part);
    if (added > 0) {
      coverage.problems.push(
        `${added} line(s) came from ${part}: a document stamped "DRAFT — NOT FOR FIELD" in its header is a different document from the one it looks like.`,
      );
    }
  }

  // --- comments (PROPOSALS, not spec) -----------------------------------------------
  const commentsRaw = entries[COMMENTS_XML];
  if (commentsRaw) {
    const partXml = decodePart(commentsRaw);
    const s = partSyntax(partXml, syntax);
    const resolvedKnown = entries[COMMENTS_EXT_XML] !== undefined;
    const comments = scanComments(partXml, s, resolvedKnown);
    blocks.push(...comments);
    coverage.partsRead.push(COMMENTS_XML);
    if (comments.length > 0) {
      coverage.problems.push(
        `${comments.length} Word comment(s) are present. A comment is a PROPOSAL, not the specification: they are labelled "comment" and the block pass may not turn one into an obligation on its own.`,
      );
    }
  }

  for (const p of [FOOTNOTES_XML, ENDNOTES_XML, COMMENTS_XML]) {
    if (partNames.includes(p) && !coverage.partsRead.includes(p)) {
      coverage.partsSkipped.push({ part: p, reason: "present in the archive but too large to inflate safely" });
    }
  }
  for (const p of partNames) {
    if (
      !coverage.partsRead.includes(p) &&
      !coverage.partsSkipped.some((x) => x.part === p) &&
      /^word\/.*\.xml$/.test(p) &&
      !/^word\/(theme|styles|settings|fontTable|webSettings|numbering|people|commentsIds|commentsExtended)/.test(p)
    ) {
      coverage.partsSkipped.push({ part: p, reason: "not a text-bearing part this parser reads" });
    }
  }

  // --- assign ids in final order ----------------------------------------------------
  let section: string | null = null;
  const finished: SourceBlock[] = [];
  let n = 0;
  for (const b of blocks) {
    const text = clean(b.text);
    if (text.length === 0) continue;
    if (b.kind === "heading" && b.origin === "body") section = text;
    n += 1;
    finished.push({ ...b, text, blockId: `b${String(n).padStart(4, "0")}`, section });
  }

  const counts = {
    paragraphs: finished.filter((b) => b.kind === "paragraph").length,
    tableCells: finished.filter((b) => b.kind === "table-cell").length,
    footnotes: finished.filter((b) => b.kind === "footnote").length,
    headings: finished.filter((b) => b.kind === "heading").length,
    listItems: finished.filter((b) => b.kind === "list-item").length,
  };

  if (coverage.images > coverage.imagesWithAltText) {
    coverage.problems.push(
      `${coverage.images - coverage.imagesWithAltText} image(s) carry no alt text; whatever they mandate is unreadable to this parser and to any browser-driving tester.`,
    );
  }
  if (coverage.unresolvedFieldCodes > 0) {
    coverage.problems.push(
      `${coverage.unresolvedFieldCodes} Word field code(s) (cross-references, sequence numbers) were left unresolved; their displayed value may differ from the text captured here.`,
    );
  }
  if (coverage.autoNumberedParagraphs > 0) {
    coverage.problems.push(
      `${coverage.autoNumberedParagraphs} paragraph(s) are numbered by Word itself. The number is generated from numbering.xml at render time and is NOT text anywhere in the document, so each one carries a "[#]" placeholder rather than the identifier a reader would see.`,
    );
  }

  return { blocks: finished, annotatedText: annotate(finished), counts, coverage };
}

const partSyntax = (partXml: string, fallback: Syntax): Syntax => {
  const detected = detectPrefix(partXml);
  return detected === null || detected === fallback.prefix ? fallback : buildSyntax(detected);
};

/** The whole-document rendering a pass reads: every line carries its id and its origin. */
export function annotate(blocks: SourceBlock[]): string {
  const out: string[] = [];
  let lastTable: string | null = null;
  for (const b of blocks) {
    if (b.kind === "table-cell" && b.tableId !== lastTable) {
      out.push(`--- table ${b.tableId} ---`);
      lastTable = b.tableId;
    } else if (b.kind !== "table-cell") {
      lastTable = null;
    }
    const inlineText = b.text.replace(/\n/g, " ⏎ ");
    if (b.origin === "combo-box-suggestion") {
      out.push(`[${b.blockId}] [combo-box suggestion — OPEN, NOT EXHAUSTIVE: ${inlineText}]`);
    } else if (b.origin.startsWith("ruby-reading")) {
      out.push(`[${b.blockId}] [${b.origin}: ${inlineText}]`);
    } else {
      out.push(`[${b.blockId}] ${describe(b)}${inlineText}`);
    }
  }
  return out.join("\n");
}

/** Prefix that tells a reader what kind of block this is, and where it came from. */
export function describe(b: SourceBlock): string {
  const origin = b.origin === "body" ? "" : `${b.origin} `;
  if (b.kind === "heading") return `(${origin}heading) `;
  if (b.kind === "footnote") return `(${b.origin}) `;
  if (b.kind === "list-item") return `(${origin}list) `;
  if (b.kind === "table-cell" && b.coords) {
    const rh = b.coords.rowHeader ? ` row="${b.coords.rowHeader}"` : "";
    const ch = b.coords.colHeader ? ` col="${b.coords.colHeader}"` : "";
    return `(${origin}cell r${b.coords.row}c${b.coords.col}${rh}${ch}) `;
  }
  return origin ? `(${origin}) ` : "";
}

// ---------------------------------------------------------------------------
// Body scanning
// ---------------------------------------------------------------------------

function countContentControls(xml: string, s: Syntax, name: "dropDownList" | "comboBox"): number {
  const p = escapeRegExp(s.prefix);
  return xml.match(new RegExp(`<${p}${name}(?=[\\s/>])`, "g"))?.length ?? 0;
}


const countDropdownControls = (xml: string, s: Syntax) => countContentControls(xml, s, "dropDownList");
const countComboBoxControls = (xml: string, s: Syntax) => countContentControls(xml, s, "comboBox");

interface ControlItemStats {
  declared: number;
  labels: string[];
  unreadable: number;
}

function controlItemStats(xml: string, s: Syntax, name: "dropDownList" | "comboBox"): ControlItemStats {
  const p = escapeRegExp(s.prefix);
  const controlRe = new RegExp(
    `<${p}${name}(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${p}${name}>`,
    "g",
  );
  const itemRe = new RegExp(`<${p}listItem(?=[\\s/>])[^>]*\\/?>`, "g");
  const labels: string[] = [];
  let declared = 0;
  let unreadable = 0;
  let control: RegExpExecArray | null;
  while ((control = controlRe.exec(xml)) !== null) {
    for (const tag of (control[1] ?? "").match(itemRe) ?? []) {
      declared += 1;
      const display = xmlAttribute(tag, "displayText");
      const value = xmlAttribute(tag, "value");
      const label = decodeXmlEntities(display ?? value ?? "").trim();
      if (label.length > 0) labels.push(label);
      else unreadable += 1;
    }
  }
  return { declared, labels, unreadable };
}

function controlItemStatsInsideParagraphs(
  xml: string,
  s: Syntax,
  name: "dropDownList" | "comboBox",
): ControlItemStats {
  const combined: ControlItemStats = { declared: 0, labels: [], unreadable: 0 };
  const paraRe = new RegExp(s.paragraphSrc, "g");
  let match: RegExpExecArray | null;
  while ((match = paraRe.exec(xml)) !== null) {
    if (match[1] === undefined) continue;
    const held = controlItemStats(match[1], s, name);
    combined.declared += held.declared;
    combined.labels.push(...held.labels);
    combined.unreadable += held.unreadable;
  }
  return combined;
}

/**
 * Options in an inline content control live in the host paragraph's `w:sdtPr` and are
 * reachable by `paragraphDrafts`. A block-level `w:sdt` places those properties outside
 * every paragraph. Count that difference so an unread option set is never silently short.
 */
function dropdownsOutsideParagraphs(xml: string, s: Syntax): number {
  const total = countDropdownControls(xml, s);
  if (total === 0) return 0;
  let reached = 0;
  const paraRe = new RegExp(s.paragraphSrc, "g");
  let match: RegExpExecArray | null;
  while ((match = paraRe.exec(xml)) !== null) {
    if (match[1] !== undefined) reached += countDropdownControls(match[1], s);
  }
  return Math.max(0, total - reached);
}

function xmlAttribute(tag: string, localName: string): string | undefined {
  const name = escapeRegExp(localName);
  const match = new RegExp(
    `(?:^|\\s)(?:[A-Za-z_][\\w.-]*:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
  ).exec(tag);
  return match?.[1] ?? match?.[2];
}

/**
 * The list item's value is storage metadata, not rendered text and therefore never a
 * document answer code. Word permits displayText to be absent; in that shape it displays
 * value, so value is used only as the label fallback.
 */
function controlItems(body: string, s: Syntax, name: "dropDownList" | "comboBox"): string[] {
  return controlItemStats(body, s, name).labels;
}

const dropdownItems = (body: string, s: Syntax) => controlItems(body, s, "dropDownList");

function dropdownDrafts(body: string, s: Syntax, origin: string): Draft[] {
  return dropdownItems(body, s).map((label) => ({
    kind: "list-item",
    text: label,
    section: null,
    coords: null,
    tableId: null,
    origin,
  }));
}

function comboBoxDrafts(body: string, s: Syntax): Draft[] {
  return controlItems(body, s, "comboBox").map((label) => ({
    kind: "paragraph",
    text: label,
    section: null,
    coords: null,
    tableId: null,
    origin: "combo-box-suggestion",
  }));
}

function elementInner(xml: string, s: Syntax, name: string): string | null {
  const p = escapeRegExp(s.prefix);
  const n = escapeRegExp(name);
  return new RegExp(`<${p}${n}(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${p}${n}>`).exec(xml)?.[1] ?? null;
}

function rubyDrafts(body: string, s: Syntax, origin: string): Draft[] {
  const p = escapeRegExp(s.prefix);
  const rubyRe = new RegExp(`<${p}ruby(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${p}ruby>`, "g");
  const drafts: Draft[] = [];
  let ruby: RegExpExecArray | null;
  while ((ruby = rubyRe.exec(body)) !== null) {
    const rubyBody = ruby[1] ?? "";
    const readingXml = elementInner(rubyBody, s, "rt");
    const baseXml = elementInner(rubyBody, s, "rubyBase");
    const reading = readingXml === null ? "" : paragraphText(readingXml, s);
    const base = baseXml === null ? "" : paragraphText(baseXml, s);
    drafts.push({
      kind: "paragraph",
      text: reading.length > 0 ? reading : "[ruby reading unreadable]",
      section: null,
      coords: null,
      tableId: null,
      origin: `ruby-reading; base=${JSON.stringify(base)}; source=${JSON.stringify(origin)}`,
    });
  }
  return drafts;
}

function scanBody(xmlRaw: string, s: Syntax, coverage: DocumentCoverage, origin: string): Draft[] {
  const xml = neutralizeTextBoxes(acceptedViewXml(stripFallback(xmlRaw), s, origin, coverage), s);
  const unreached = dropdownsOutsideParagraphs(xml, s);
  if (unreached > 0) {
    coverage.problems.push(
      `${origin}: ${unreached} dropdown-list content control(s) sit outside every paragraph. ` +
        `Their declared options were NOT extracted; the rendered control text is still read where present.`,
    );
  }
  const comboBoxes = countComboBoxControls(xml, s);
  if (comboBoxes > 0) {
    const all = controlItemStats(xml, s, "comboBox");
    const emitted = controlItemStatsInsideParagraphs(xml, s, "comboBox");
    const omittedReadable = all.labels.length - emitted.labels.length;
    coverage.problems.push(
      `${origin}: ${comboBoxes} combo-box content control(s) declare ${all.declared} open suggestion item(s): ` +
        `${all.labels.length} non-empty label(s) recovered (${emitted.labels.length} emitted as open-suggestion paragraph ` +
        `blocks; ${omittedReadable} readable block-level label(s) not emitted), and ${all.unreadable} unreadable/empty ` +
        `item(s). Reconciliation: ${all.labels.length} recovered + ${all.unreadable} unreadable = ${all.declared} ` +
        `declared. Suggestions are NOT exhaustive answer options; current rendered values are retained.`,
    );
  }
  const tableSpans = topLevelSpans(xml, s.prefix, "tbl");
  if (tableSpans === null) {
    coverage.problems.push(
      `${origin}: <${s.prefix}tbl> tags do not balance, so TABLE STRUCTURE WAS NOT READ in this part. ` +
        `Cells are still captured as paragraphs where possible, but row/column pairing — which is what makes a ` +
        `routing matrix mean anything — is not available.`,
    );
    return scanParagraphRange(xml, s, coverage, origin);
  }

  const out: Draft[] = [];
  let cursor = 0;
  let tableN = 0;
  for (const span of tableSpans) {
    out.push(...scanParagraphRange(xml.slice(cursor, span.start), s, coverage, origin));
    tableN += 1;
    out.push(...scanTable(span.inner, s, `t${tableN}`, coverage, origin));
    cursor = span.end;
  }
  out.push(...scanParagraphRange(xml.slice(cursor), s, coverage, origin));
  return out;
}

function scanParagraphRange(xml: string, s: Syntax, coverage: DocumentCoverage, origin: string): Draft[] {
  const out: Draft[] = [];
  const paraRe = new RegExp(s.paragraphSrc, "g");
  let m: RegExpExecArray | null;
  while ((m = paraRe.exec(xml)) !== null) {
    const body: string | undefined = m[1];
    if (body === undefined) continue;
    out.push(...paragraphDrafts(body, s, coverage, origin));
  }
  return out;
}

function paragraphDrafts(body: string, s: Syntax, coverage: DocumentCoverage, origin: string): Draft[] {
  const out: Draft[] = [];
  countInlineArtifacts(body, s, coverage);

  const rubyReadings = rubyReadingCount(body, s);
  const rubyAnnotations = rubyDrafts(body, s, origin);
  if (rubyReadings > 0) {
    const recovered = rubyAnnotations.filter((draft) => draft.text !== "[ruby reading unreadable]").length;
    const unreadable = rubyReadings - recovered;
    coverage.problems.push(
      `${origin}: ${rubyReadings} ruby annotation(s) found: ${recovered} reading(s) recovered and emitted as ` +
        `separate ruby-reading paragraph block(s), ${unreadable} unreadable. Readings were NOT interleaved inline; ` +
        `visible base text is preserved exactly.`,
    );
  }

  let text = paragraphText(body, s);
  const numbered = hasNumbering(body, s);
  if (numbered && clean(text).length > 0 && !ALREADY_NUMBERED.test(text)) {
    // The identifier a reader sees ("Q1.", "a)") is generated at render time from
    // numbering.xml and exists nowhere in this XML. A visible unknown is recoverable.
    text = `[#] ${text}`;
    coverage.autoNumberedParagraphs += 1;
  }

  if (clean(text).length > 0) {
    const level = headingLevel(body, s);
    const kind: SourceBlock["kind"] =
      origin === "body" && (level > 0 || SECTION_TEXT_RE.test(clean(text)))
        ? "heading"
        : numbered
          ? "list-item"
          : "paragraph";
    out.push({ kind, text, section: null, coords: null, tableId: null, origin });
  }

  // One block per option is an interface contract with parseDocumentedOptions: a joined
  // prose blob can be mis-sealed as one invented label. Keep the control's rendered text
  // above and add, rather than substitute, the author-declared options.
  out.push(...dropdownDrafts(body, s, origin));
  out.push(...comboBoxDrafts(body, s));
  out.push(...rubyAnnotations);

  for (const alt of imageAlts(body)) {
    coverage.images += 1;
    if (alt !== null) coverage.imagesWithAltText += 1;
    out.push({
      kind: "paragraph",
      text: alt === null ? "[image with no alt text — content unreadable]" : `[image: ${alt}]`,
      section: null,
      coords: null,
      tableId: null,
      origin: "image-alt",
    });
  }
  return out;
}

function countInlineArtifacts(body: string, s: Syntax, coverage: DocumentCoverage): void {
  const p = escapeRegExp(s.prefix);
  const fields = body.match(new RegExp(`<${p}instrText(?=[\\s>])`, "g"));
  if (fields) coverage.unresolvedFieldCodes += fields.length;
  const syms = body.match(new RegExp(`<${p}sym(?=[\\s/>])`, "g"));
  if (syms) coverage.symbolRuns += syms.length;
}

/** Alt text from DrawingML (`wp:docPr@descr|@name`) and VML (`v:shape@alt`). */
function imageAlts(body: string): Array<string | null> {
  const out: Array<string | null> = [];
  const drawingRe = /<(?:w:drawing|w:pict)(?=[\s>])[\s\S]*?<\/(?:w:drawing|w:pict)>/g;
  let m: RegExpExecArray | null;
  while ((m = drawingRe.exec(body)) !== null) {
    const chunk = m[0];
    const descr = /descr="([^"]*)"/.exec(chunk)?.[1] ?? "";
    const alt = /\salt="([^"]*)"/.exec(chunk)?.[1] ?? "";
    const name = /<wp:docPr[^>]*\sname="([^"]*)"/.exec(chunk)?.[1] ?? "";
    const text = decodeXmlEntities(descr || alt || name).trim();
    out.push(text.length > 0 ? text : null);
  }
  return out;
}

type VerticalMerge = "restart" | "continue" | null;

interface TableCell {
  text: string;
  /** One-based OOXML table-grid column, not the cell's array position. */
  gridCol: number;
  span: number;
  vMerge: VerticalMerge;
}

interface TableRow {
  cells: TableCell[];
  repeatHeader: boolean;
}

function propertyElement(xml: string, s: Syntax, name: string): string {
  const p = escapeRegExp(s.prefix);
  const n = escapeRegExp(name);
  return (
    new RegExp(`<${p}${n}(?=[\\s>])[^>]*>[\\s\\S]*?<\\/${p}${n}>|<${p}${n}(?=[\\s/>])[^>]*\\/>`).exec(xml)?.[0] ??
    ""
  );
}

function onOffProperty(tag: string): boolean {
  if (tag.length === 0) return false;
  const value = xmlAttribute(tag, "val")?.toLowerCase();
  return value === undefined || !["0", "false", "off", "no"].includes(value);
}

function tableGridInteger(
  props: string,
  s: Syntax,
  name: "gridSpan" | "gridBefore",
  fallback: number,
  minimum: number,
  tableId: string,
  coverage: DocumentCoverage,
): number {
  const tag = propertyElement(props, s, name);
  if (tag.length === 0) return fallback;
  const raw = xmlAttribute(tag, "val");
  if (raw === undefined) {
    coverage.problems.push(
      `${tableId}: <${s.prefix}${name}> is present without a val attribute; ${fallback} was used and the ` +
        `declared table coordinate is not exact.`,
    );
    return fallback;
  }
  const normalized = raw.trim();
  if (!/^[+-]?\d+$/.test(normalized)) {
    coverage.problems.push(
      `${tableId}: <${s.prefix}${name}> has invalid integer value ${JSON.stringify(raw)}; ${fallback} was used ` +
        `rather than guessing.`,
    );
    return fallback;
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    coverage.problems.push(
      `${tableId}: <${s.prefix}${name}> value ${JSON.stringify(raw)} is outside the valid range; ${fallback} ` +
        `was used rather than manufacturing a coordinate.`,
    );
    return fallback;
  }
  if (parsed > MAX_GRID_COLUMNS) {
    coverage.problems.push(
      `${tableId}: <${s.prefix}${name}> value ${parsed} exceeds the ${MAX_GRID_COLUMNS}-column safety bound and ` +
        `was clamped; cell text is retained but coordinates beyond the bound are not exact.`,
    );
    return MAX_GRID_COLUMNS;
  }
  return parsed;
}

/**
 * ONE BLOCK PER CELL, with exact structural coordinates and nested tables handled rather
 * than silently scrambling the parent's row pairing. WordprocessingML has no semantic
 * equivalent of HTML th/scope, so rowHeader/colHeader remain null instead of guessing.
 */
function scanTable(tableXml: string, s: Syntax, tableId: string, coverage: DocumentCoverage, origin: string): Draft[] {
  const nested = topLevelSpans(tableXml, s.prefix, "tbl");
  let body = tableXml;
  const nestedDrafts: Draft[] = [];
  if (nested === null) {
    coverage.problems.push(`${tableId}: nested <${s.prefix}tbl> tags do not balance; this table was read as flat paragraphs.`);
    return scanParagraphRange(tableXml, s, coverage, origin);
  }
  if (nested.length > 0) {
    // Lift the nested tables OUT before scanning rows, so the parent's <w:tr> scan cannot
    // pair a parent row with a child row, then read each child as its own table.
    let sliced = "";
    let cursor = 0;
    let n = 0;
    for (const span of nested) {
      sliced += tableXml.slice(cursor, span.start);
      n += 1;
      nestedDrafts.push(...scanTable(span.inner, s, `${tableId}.${n}`, coverage, origin));
      cursor = span.end;
    }
    sliced += tableXml.slice(cursor);
    body = sliced;
    coverage.problems.push(
      `${tableId} contains ${nested.length} nested table(s); each is reported as its own table (${tableId}.1 …) so the parent's rows still pair correctly.`,
    );
  }

  const rows: TableRow[] = [];
  const p = escapeRegExp(s.prefix);
  const vMergeRe = new RegExp(`<${p}vMerge(?=[\\s/>])[^>]*\\/?>`);
  const tblHeaderRe = new RegExp(`<${p}tblHeader(?=[\\s/>])[^>]*\\/?>`);
  const rowRe = new RegExp(s.rowSrc, "g");
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(body)) !== null) {
    const rowXml = rowMatch[1] ?? "";
    const trPr = propertyElement(rowXml, s, "trPr");
    let gridCol = 1 + tableGridInteger(trPr, s, "gridBefore", 0, 0, tableId, coverage);
    const cells: TableCell[] = [];
    const cellRe = new RegExp(s.cellSrc, "g");
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowXml)) !== null) {
      const cellXml = cellMatch[1] ?? "";
      const props = propertyElement(cellXml, s, "tcPr");
      const span = tableGridInteger(props, s, "gridSpan", 1, 1, tableId, coverage);
      const vMergeTag = vMergeRe.exec(props)?.[0] ?? "";
      const vMergeValue = xmlAttribute(vMergeTag, "val")?.toLowerCase();
      let vMerge: VerticalMerge = null;
      if (vMergeTag.length > 0) {
        if (vMergeValue === undefined || vMergeValue === "continue") vMerge = "continue";
        else if (vMergeValue === "restart") vMerge = "restart";
        else {
          coverage.problems.push(
            `${tableId}: a vertical merge declares unsupported value ${JSON.stringify(vMergeValue)}; ` +
              `that cell is not treated as a continuation rather than guessing its row group.`,
          );
        }
      }

      const parts: string[] = [];
      const paraRe = new RegExp(s.paragraphSrc, "g");
      let paraMatch: RegExpExecArray | null;
      while ((paraMatch = paraRe.exec(cellXml)) !== null) {
        if (paraMatch[1] === undefined) continue;
        for (const d of paragraphDrafts(paraMatch[1], s, coverage, origin)) {
          if (d.origin === "image-alt") parts.push(d.text);
          else if (clean(d.text).length > 0) parts.push(clean(d.text));
        }
      }
      cells.push({ text: parts.join("\n"), gridCol, span, vMerge });
      gridCol = Math.min(MAX_GRID_COLUMNS + 1, gridCol + span);
    }
    rows.push({ cells, repeatHeader: onOffProperty(tblHeaderRe.exec(trPr)?.[0] ?? "") });
  }

  let repeatPrefix = 0;
  while (repeatPrefix < rows.length && rows[repeatPrefix]!.repeatHeader) repeatPrefix += 1;
  const lateRepeatRows = rows
    .map((row, index) => (row.repeatHeader && index >= repeatPrefix ? index + 1 : null))
    .filter((row): row is number => row !== null);
  if (lateRepeatRows.length > 0) {
    coverage.problems.push(
      `TABLE_REPEAT_FLAG_IGNORED: ${tableId} marks non-leading row(s) ${lateRepeatRows.join(", ")} with ` +
        `<${s.prefix}tblHeader>. OOXML defines that flag only as repeat-on-page metadata and ignores it after ` +
        `the first non-repeating row; it was not used as semantic column-header evidence.`,
    );
  }
  if (repeatPrefix > 1) {
    coverage.problems.push(
      `TABLE_MULTI_ROW_REPEAT_HEADER: ${tableId} has ${repeatPrefix} contiguous leading rows marked to repeat on ` +
        `each page. Their cells and spans are retained, but no multi-level semantic header hierarchy was invented.`,
    );
  }
  const nonEmptyCells = rows.reduce(
    (count, row) => count + row.cells.filter((cell) => clean(cell.text).length > 0).length,
    0,
  );
  coverage.problems.push(
    `TABLE_HEADER_SEMANTICS_AMBIGUOUS: ${tableId} contains ${nonEmptyCells} non-empty cell(s). ` +
      `WordprocessingML supplies row/column positions, spans, and repeat-on-page flags but no semantic header/scope ` +
      `relationship, so rowHeader and colHeader are null for every cell.`,
  );

  const spannedCells = rows.flatMap((row, rowIndex) =>
    row.cells
      .filter((cell) => cell.span > 1)
      .map((cell) => `r${rowIndex + 1}c${cell.gridCol}=span${cell.span}`),
  );
  if (spannedCells.length > 0) {
    const shown = spannedCells.slice(0, 32);
    const omitted = spannedCells.length - shown.length;
    coverage.problems.push(
      `TABLE_GRID_SPANS_PRESENT: ${tableId} contains ${spannedCells.length} horizontally spanned cell(s): ` +
        `${shown.join(", ")}${omitted > 0 ? `; ${omitted} additional span(s) are counted but omitted from this bounded diagnostic` : ""}. ` +
        `Start coordinates are retained; the current SourceBlock contract has no colSpan field.`,
    );
  }

  const verticalMergeCount = rows.reduce(
    (count, row) => count + row.cells.filter((cell) => cell.vMerge !== null).length,
    0,
  );
  if (verticalMergeCount > 0) {
    coverage.problems.push(
      `TABLE_VERTICAL_MERGE_PRESENT: ${tableId} contains ${verticalMergeCount} vertical-merge marker(s). ` +
        `Cell text and structural coordinates are retained, but no row-header relationship is inferred from adjacency.`,
    );
  }

  const out: Draft[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    for (const c of row.cells) {
      const text = c.text;
      if (clean(text).length === 0) continue;
      out.push({
        kind: "table-cell",
        text,
        section: null,
        tableId,
        origin,
        coords: {
          row: r + 1,
          col: c.gridCol,
          rowHeader: null,
          colHeader: null,
        },
      });
    }
  }
  return [...out, ...nestedDrafts];
}

/** Footnote/endnote parts carry separator pseudo-notes; those are not document content. */
function scanNotes(xml: string, s: Syntax, label: "footnote" | "endnote"): Draft[] {
  const p = escapeRegExp(s.prefix);
  const noteRe = new RegExp(
    `<${p}(?:footnote|endnote)(?=[\\s>])([^>]*)>([\\s\\S]*?)<\\/${p}(?:footnote|endnote)>`,
    "g",
  );
  const out: Draft[] = [];
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = noteRe.exec(xml)) !== null) {
    const attrs = m[1] ?? "";
    if (/type="(separator|continuationSeparator|continuationNotice)"/.test(attrs)) continue;
    const paraRe = new RegExp(s.paragraphSrc, "g");
    const parts: string[] = [];
    let pm: RegExpExecArray | null;
    while ((pm = paraRe.exec(m[2] ?? "")) !== null) {
      const t = paragraphText(pm[1] ?? "", s);
      if (clean(t).length > 0) parts.push(clean(t));
    }
    if (parts.length === 0) continue;
    n += 1;
    out.push({
      kind: "footnote",
      text: parts.join("\n"),
      section: null,
      coords: null,
      tableId: null,
      origin: `${label} ${n}`,
    });
  }
  return out;
}

/** Word comments: labelled proposals, never body text. */
function scanComments(xml: string, s: Syntax, resolutionKnown: boolean): Draft[] {
  const p = escapeRegExp(s.prefix);
  const re = new RegExp(`<${p}comment(?=[\\s>])([^>]*)>([\\s\\S]*?)<\\/${p}comment>`, "g");
  const out: Draft[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] ?? "";
    const author = /author="([^"]*)"/.exec(attrs)?.[1] ?? "unknown";
    const initials = /initials="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const paraRe = new RegExp(s.paragraphSrc, "g");
    const parts: string[] = [];
    let pm: RegExpExecArray | null;
    while ((pm = paraRe.exec(m[2] ?? "")) !== null) {
      const t = paragraphText(pm[1] ?? "", s);
      if (clean(t).length > 0) parts.push(clean(t));
    }
    if (parts.length === 0) continue;
    out.push({
      kind: "paragraph",
      text: parts.join("\n"),
      section: null,
      coords: null,
      tableId: null,
      origin: `comment by ${decodeXmlEntities(author)}${initials ? ` (${initials})` : ""} — PROPOSAL, resolution ${
        resolutionKnown ? "recorded in the document but not read here" : "unknown"
      }`,
    });
  }
  return out;
}

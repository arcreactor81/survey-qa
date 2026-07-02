// docx.ts — plain-text extraction from .docx files without external XML libraries.
//
// A .docx file is a ZIP archive; the document body lives in "word/document.xml".
// We unzip with fflate (inflating ONLY word/document.xml, with size caps — see
// the zip-bomb notes on extractDocxText), then pull text out of the
// WordprocessingML by scanning for paragraph elements (<w:p>) and, within each
// paragraph, the ordered stream of text runs (<w:t>), tabs (<w:tab/>) and line
// breaks (<w:br/> / <w:cr/>). Bullet-list items are plain paragraphs in the
// XML, so no special handling is required beyond ordinary paragraph text
// extraction. Table structure is preserved minimally: cells in a row are
// joined with "\t" and each row becomes one output line.
//
// The WordprocessingML namespace is almost always bound to the "w:" prefix,
// but that is a convention, not a requirement. We scan with "w:" first (the
// overwhelmingly common case) and, if nothing matches, detect the actual
// prefix bound to the WordprocessingML namespace and rescan. If extraction
// still finds no paragraphs in a non-empty document we throw instead of
// silently returning "" (an empty spec would make every downstream comparison
// a false pass).

import { unzipSync, type UnzipFileInfo } from "fflate";

const DOCUMENT_XML_PATH = "word/document.xml";

/**
 * Maximum accepted size of the compressed .docx archive. A genuine
 * questionnaire .docx is a few KB–MB; 25 MB is far beyond any legitimate spec
 * document and bounds the work `unzipSync` can be asked to do.
 */
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;

/**
 * Maximum accepted decompressed size of word/document.xml. fflate allocates
 * the output buffer from the ZIP header's declared uncompressed size, so
 * rejecting in the unzip filter prevents the allocation entirely.
 */
const MAX_DOCUMENT_XML_BYTES = 50 * 1024 * 1024;

/** WordprocessingML main namespace URIs (transitional and strict OOXML). */
const WML_MAIN_NAMESPACES = [
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
];

/**
 * Regex sources for one WordprocessingML namespace prefix (e.g. "w:" or "").
 * Sources are stored as strings and each helper builds its own local RegExp,
 * so nested scans never share `lastIndex` state.
 *
 * Paragraph source: alternative 1 is a self-closing/empty paragraph
 * (<w:p/> with optional attributes); alternative 2 captures the paragraph
 * body (capture group 1). The lookahead (?=[\s/>]) ensures we match <w:p ...>
 * but not <w:pPr>, <w:pStyle>, <w:proofErr>, etc. Paragraphs do not nest in
 * WordprocessingML, so a lazy scan to the next </w:p> is correct.
 *
 * Run-token source matches, in document order within a paragraph:
 *   1. an empty self-closing text run       <w:t/> (with optional attributes)
 *   2. a text run with content              <w:t> or <w:t xml:space="preserve">...</w:t>
 *   3. a tab                                <w:tab/>
 *   4. a line break / carriage return       <w:br/> (any w:type) or <w:cr/>
 * Lookaheads prevent partial-name matches (<w:tab> vs <w:tabs>, <w:t> vs
 * <w:tc>/<w:tbl>).
 */
interface WmlSyntax {
  /** The raw namespace prefix, e.g. "w:" (or "" for a default namespace). */
  prefix: string;
  /** Matches a whole <w:tbl>...</w:tbl> block. No capture groups. */
  tableSrc: string;
  /** Matches a table row; group 1 = row body. */
  rowSrc: string;
  /** Matches a table cell; group 1 = cell body. */
  cellSrc: string;
  /** Matches a paragraph; group 1 = body (undefined for self-closing <w:p/>). */
  paragraphSrc: string;
  /** Matches one run token; group 1 = text content when it is a text run. */
  runTokenSrc: string;
}

/** Named and numeric XML character references. */
const ENTITY_RE = /&(amp|lt|gt|quot|apos|#\d+|#[xX][0-9a-fA-F]+);/g;

/**
 * Extract the plain text of a .docx document.
 *
 * Paragraphs are joined with "\n"; tabs and explicit line breaks inside a
 * paragraph are preserved as "\t" and "\n". Within Word tables, cells of a row
 * are joined with "\t" and each row becomes one line, so tabular content keeps
 * its shape. Runs of 3+ consecutive newlines (i.e. multiple blank lines) are
 * collapsed to a single blank line.
 *
 * Defensive limits (uploads are user-controlled): the compressed archive and
 * the decompressed word/document.xml are both size-capped, and only
 * word/document.xml is ever inflated — other entries (e.g. embedded media, or
 * zip-bomb payloads) are skipped without decompression.
 *
 * @throws Error when the input is not a readable ZIP archive, when the archive
 *         does not contain word/document.xml, when a size limit is exceeded,
 *         or when a non-empty document.xml yields no recognizable paragraphs.
 */
export function extractDocxText(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `extractDocxText: .docx archive is ${bytes.byteLength} bytes, above the ${MAX_ARCHIVE_BYTES}-byte limit.`,
    );
  }

  // The filter sees every entry's central-directory metadata WITHOUT
  // decompressing it, so we can (a) collect names for diagnostics, (b) skip
  // everything except word/document.xml, and (c) refuse an entry whose
  // declared decompressed size is absurd before any allocation happens.
  const entryNames: string[] = [];
  let oversizedDeclared = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (info: UnzipFileInfo): boolean => {
        entryNames.push(info.name);
        if (info.name !== DOCUMENT_XML_PATH) return false;
        // fflate: `size` is the compressed size, `originalSize` the declared
        // decompressed size. Cap both — either being huge is disqualifying.
        const declared = Math.max(info.size, info.originalSize);
        if (declared > MAX_DOCUMENT_XML_BYTES) {
          oversizedDeclared = declared;
          return false;
        }
        return true;
      },
    });
  } catch (err) {
    throw new Error(
      `extractDocxText: input is not a readable .docx (ZIP) archive: ${describeError(err)}`,
    );
  }

  const documentXml = entries[DOCUMENT_XML_PATH];
  if (!documentXml) {
    if (oversizedDeclared > 0) {
      throw new Error(
        `extractDocxText: "${DOCUMENT_XML_PATH}" declares ${oversizedDeclared} decompressed bytes, above the ${MAX_DOCUMENT_XML_BYTES}-byte limit; refusing to decompress.`,
      );
    }
    const preview = entryNames.slice(0, 10).join(", ");
    const suffix =
      entryNames.length === 0
        ? "the archive is empty"
        : `archive contains ${entryNames.length} entr${entryNames.length === 1 ? "y" : "ies"}: ${preview}${entryNames.length > 10 ? ", …" : ""}`;
    throw new Error(`extractDocxText: "${DOCUMENT_XML_PATH}" not found in the .docx archive (${suffix}).`);
  }

  // Defense in depth: a crafted header can understate the decompressed size
  // (fflate still bounds the inflate to the declared size, but verify anyway).
  if (documentXml.byteLength > MAX_DOCUMENT_XML_BYTES) {
    throw new Error(
      `extractDocxText: decompressed "${DOCUMENT_XML_PATH}" is ${documentXml.byteLength} bytes, above the ${MAX_DOCUMENT_XML_BYTES}-byte limit.`,
    );
  }

  const xml = decodeDocumentXml(documentXml);

  // Common case first: the "w:" prefix. If nothing matches, detect the prefix
  // actually bound to the WordprocessingML namespace and rescan.
  let blocks = extractBlocks(xml, buildSyntax("w:"));
  if (blocks.length === 0) {
    const detected = detectWmlPrefix(xml);
    if (detected !== null && detected !== "w:") {
      blocks = extractBlocks(xml, buildSyntax(detected));
    }
  }

  if (blocks.length === 0) {
    if (xml.trim().length === 0) return "";
    throw new Error(
      `extractDocxText: no paragraphs could be parsed from "${DOCUMENT_XML_PATH}" (${xml.length} chars of XML); ` +
        "the document may use an unsupported WordprocessingML namespace binding or be malformed.",
    );
  }

  return blocks
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // collapse repeated blank lines
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/**
 * Decode document.xml bytes. XML written as UTF-16 is required by the XML spec
 * to carry a BOM, so a two-byte sniff reliably catches it; everything else is
 * UTF-8 (the universal default for OOXML producers). TextDecoder strips the
 * BOM itself. Falls back to UTF-8 if the runtime lacks a UTF-16 decoder — a
 * mangled decode then surfaces via the no-paragraphs error above rather than
 * as a silently empty spec.
 */
function decodeDocumentXml(bytes: Uint8Array): string {
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

/**
 * Find the prefix bound to the WordprocessingML main namespace by scanning
 * xmlns declarations. Returns e.g. "w14:" for xmlns:w14="…/main", "" for a
 * default namespace (xmlns="…/main"), or null when no binding is found.
 */
function detectWmlPrefix(xml: string): string | null {
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

function buildSyntax(prefix: string): WmlSyntax {
  const p = escapeRegExp(prefix);
  return {
    prefix,
    tableSrc: `<${p}tbl(?=[\\s>])[^>]*>[\\s\\S]*?<\\/${p}tbl>`,
    rowSrc: `<${p}tr(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${p}tr>`,
    cellSrc: `<${p}tc(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${p}tc>`,
    paragraphSrc: `<${p}p(?=[\\s/>])[^>]*\\/>|<${p}p(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${p}p>`,
    runTokenSrc:
      `<${p}t(?=[\\s/>])[^>]*\\/>|<${p}t(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${p}t>|` +
      `<${p}tab(?=[\\s/>])[^>]*\\/>|<${p}(?:br|cr)(?=[\\s/>])[^>]*\\/>`,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Walk the document body in order, emitting one block per paragraph and one
 * block per table row. Tables are matched before their inner paragraphs (the
 * scanner reaches <w:tbl> first), so cell paragraphs are not double-counted.
 * A nested table ends the lazy outer-table match early; any content after
 * that point degrades gracefully to plain paragraph extraction — text is
 * never lost, only the tabular shape.
 */
function extractBlocks(xml: string, wml: WmlSyntax): string[] {
  const blocks: string[] = [];
  // Combined groups: tableSrc has none, so group 1 is the paragraph body.
  const scanner = new RegExp(`${wml.tableSrc}|${wml.paragraphSrc}`, "g");
  let m: RegExpExecArray | null;
  while ((m = scanner.exec(xml)) !== null) {
    if (m[0].startsWith(`<${wml.prefix}tbl`)) {
      blocks.push(...extractTableRows(m[0], wml));
    } else {
      // Group 1 is absent for self-closing <w:p/> (an empty paragraph).
      const body: string | undefined = m[1];
      blocks.push(body === undefined ? "" : extractParagraphText(body, wml));
    }
  }
  return blocks;
}

/**
 * Extract a table's rows: within each row, a cell's (non-empty) paragraphs
 * are joined with " ", cells are joined with "\t" (empty cells keep their
 * column position), and each row becomes one block/line.
 */
function extractTableRows(tableXml: string, wml: WmlSyntax): string[] {
  const rows: string[] = [];
  const rowRe = new RegExp(wml.rowSrc, "g");
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(tableXml)) !== null) {
    const rowBody: string = rowMatch[1] ?? "";
    const cells: string[] = [];
    const cellRe = new RegExp(wml.cellSrc, "g");
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowBody)) !== null) {
      const cellBody: string = cellMatch[1] ?? "";
      const parts: string[] = [];
      const paraRe = new RegExp(wml.paragraphSrc, "g");
      let paraMatch: RegExpExecArray | null;
      while ((paraMatch = paraRe.exec(cellBody)) !== null) {
        const body: string | undefined = paraMatch[1];
        const text = body === undefined ? "" : extractParagraphText(body, wml);
        if (text.length > 0) parts.push(text);
      }
      cells.push(parts.join(" "));
    }
    rows.push(cells.join("\t"));
  }
  return rows;
}

/** Concatenate the ordered run tokens of a single paragraph body. */
function extractParagraphText(paragraphXml: string, wml: WmlSyntax): string {
  const parts: string[] = [];
  const tokenRe = new RegExp(wml.runTokenSrc, "g");
  const tabTag = `<${wml.prefix}tab`;
  const brTag = `<${wml.prefix}br`;
  const crTag = `<${wml.prefix}cr`;
  let token: RegExpExecArray | null;
  while ((token = tokenRe.exec(paragraphXml)) !== null) {
    const raw = token[0];
    const captured: string | undefined = token[1];
    if (raw.startsWith(tabTag)) {
      parts.push("\t");
    } else if (raw.startsWith(brTag) || raw.startsWith(crTag)) {
      parts.push("\n");
    } else if (captured !== undefined) {
      parts.push(decodeXmlEntities(captured));
    }
    // else: self-closing <w:t/> — empty run, contributes nothing.
  }
  return parts.join("");
}

/** Decode the five predefined XML entities plus numeric (&#NNN; / &#xHHH;) references. */
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
        if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) {
          return String.fromCodePoint(code);
        }
        return match; // malformed reference — leave as-is
      }
    }
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

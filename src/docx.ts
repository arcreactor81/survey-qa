// docx.ts — plain-text extraction from .docx files without external XML libraries.
//
// A .docx file is a ZIP archive; the document body lives in "word/document.xml".
// We unzip with fflate, then pull text out of the WordprocessingML by scanning
// for paragraph elements (<w:p>) and, within each paragraph, the ordered stream
// of text runs (<w:t>), tabs (<w:tab/>) and line breaks (<w:br/> / <w:cr/>).
// Bullet-list items are plain paragraphs in the XML, so no special handling is
// required beyond ordinary paragraph text extraction.

import { unzipSync } from "fflate";

const DOCUMENT_XML_PATH = "word/document.xml";

/**
 * Matches one paragraph. Alternative 1 is a self-closing/empty paragraph
 * (<w:p/> with optional attributes); alternative 2 captures the paragraph body.
 * The lookahead (?=[\s/>]) ensures we match <w:p ...> but not <w:pPr>,
 * <w:pStyle>, <w:proofErr>, etc. Paragraphs do not nest in WordprocessingML,
 * so a lazy scan to the next </w:p> is correct.
 */
const PARAGRAPH_RE = /<w:p(?=[\s/>])[^>]*\/>|<w:p(?=[\s>])[^>]*>([\s\S]*?)<\/w:p>/g;

/**
 * Matches, in document order within a paragraph:
 *   1. an empty self-closing text run       <w:t/> (with optional attributes)
 *   2. a text run with content              <w:t> or <w:t xml:space="preserve">...</w:t>
 *   3. a tab                                <w:tab/>
 *   4. a line break / carriage return       <w:br/> (any w:type) or <w:cr/>
 * Lookaheads prevent partial-name matches (<w:tab> vs <w:tabs>, <w:t> vs <w:tc>/<w:tbl>).
 */
const RUN_TOKEN_RE =
  /<w:t(?=[\s/>])[^>]*\/>|<w:t(?=[\s>])[^>]*>([\s\S]*?)<\/w:t>|<w:tab(?=[\s/>])[^>]*\/>|<w:(?:br|cr)(?=[\s/>])[^>]*\/>/g;

/** Named and numeric XML character references. */
const ENTITY_RE = /&(amp|lt|gt|quot|apos|#\d+|#[xX][0-9a-fA-F]+);/g;

/**
 * Extract the plain text of a .docx document.
 *
 * Paragraphs are joined with "\n"; tabs and explicit line breaks inside a
 * paragraph are preserved as "\t" and "\n". Runs of 3+ consecutive newlines
 * (i.e. multiple blank lines) are collapsed to a single blank line.
 *
 * @throws Error when the input is not a readable ZIP archive or when the
 *         archive does not contain word/document.xml.
 */
export function extractDocxText(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    throw new Error(
      `extractDocxText: input is not a readable .docx (ZIP) archive: ${describeError(err)}`,
    );
  }

  const documentXml = entries[DOCUMENT_XML_PATH];
  if (!documentXml) {
    const names = Object.keys(entries);
    const preview = names.slice(0, 10).join(", ");
    const suffix =
      names.length === 0
        ? "the archive is empty"
        : `archive contains ${names.length} entr${names.length === 1 ? "y" : "ies"}: ${preview}${names.length > 10 ? ", …" : ""}`;
    throw new Error(`extractDocxText: "${DOCUMENT_XML_PATH}" not found in the .docx archive (${suffix}).`);
  }

  const xml = new TextDecoder("utf-8").decode(documentXml);

  const paragraphs: string[] = [];
  PARAGRAPH_RE.lastIndex = 0;
  let paragraphMatch: RegExpExecArray | null;
  while ((paragraphMatch = PARAGRAPH_RE.exec(xml)) !== null) {
    // Capture group 1 is absent for self-closing <w:p/> (an empty paragraph).
    const body: string | undefined = paragraphMatch[1];
    paragraphs.push(body === undefined ? "" : extractParagraphText(body));
  }

  return paragraphs
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // collapse repeated blank lines
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/** Concatenate the ordered run tokens of a single paragraph body. */
function extractParagraphText(paragraphXml: string): string {
  const parts: string[] = [];
  RUN_TOKEN_RE.lastIndex = 0;
  let token: RegExpExecArray | null;
  while ((token = RUN_TOKEN_RE.exec(paragraphXml)) !== null) {
    const raw = token[0];
    const captured: string | undefined = token[1];
    if (raw.startsWith("<w:tab")) {
      parts.push("\t");
    } else if (raw.startsWith("<w:br") || raw.startsWith("<w:cr")) {
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

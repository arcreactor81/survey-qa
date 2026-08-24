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
import type {
  DocumentCoverage,
  ParsedDocument,
  SourceBlock,
  SourceBackgroundFormatting,
  SourceFormattingEvidence,
  SourceRunFormatting,
} from "./types";
import {
  DOCUMENT_SEMANTICS_NONE,
  GREY_PROGRAMMING_PROFILE,
  normalizeDocumentSemanticsProfile,
  type DocumentSemanticsProfile,
} from "./document-semantics";

/**
 * Load-bearing parser semantics. Persisted model work records this value and must not be
 * reused after it changes, even when the document's block ids happen to remain identical.
 */
// 1.3.0 — table-hosted combo-box/ruby blocks inherit their host cell's structural
// coordinates, and a table banner starts even when an empty first cell emits only a lifted
// origin-bearing block. Persisted 1.2.0 output cannot identify that host cell after merge.
// 1.4.0 — neutral direct run/paragraph/cell formatting evidence is retained. The explicit
// shop profile below derives addressable programming spans from proven grey only, so the
// profile identity is part of parser/reuse identity and cannot drift under cached work.
// 1.5.0 — the selected document-semantics profile is explicit across API, workflow, recovery,
// human validation and cache identity; missing legacy selection normalizes to neutral.
// 1.6.0 — note/table identities are part-scoped, auxiliary origins remain visible to the
// extraction passes, and unresolved theme/nil shading fails closed instead of inheriting grey.
// 1.7.0: relationship-discovered auxiliary parts, structural subroles, and fail-closed
// formatting specificity. This changes durable parser/cache identity.
// 1.8.0: vertically merged continuation cells inherit their anchor cell's content. Each
// covered row gets its own block with the anchor text, marked as vmerge-inherited, so both
// extraction passes see routing rules that span multiple option rows. Assumption: Word
// vertical merge means the anchor cell's content APPLIES to every row it spans — when this
// does not hold, the inherited text degrades to a named limitation, never a wrong answer.
// Horizontal merges (gridSpan) do NOT inherit: each cell in a horizontal span is a single
// physical cell with its own content, not a continuation of another cell's content.
export const DOCX_BLOCKS_BASE_VERSION = "v2-docx-blocks/1.8.0" as const;
export const docxBlocksVersion = (profile: DocumentSemanticsProfile): string =>
  `${DOCX_BLOCKS_BASE_VERSION}+profile=${profile}`;
/** Backwards-compatible constant for neutral/legacy callers. */
export const DOCX_BLOCKS_VERSION = docxBlocksVersion(DOCUMENT_SEMANTICS_NONE);
export { DOCUMENT_SEMANTICS_NONE, GREY_PROGRAMMING_PROFILE } from "./document-semantics";

const PACKAGE_RELS = "_rels/.rels";
/** What `partsRead` calls a flat Word 2003 XML document, which has no parts at all. */
const FLAT_WORDML_PART = "(flat WordprocessingML)";
const DOCUMENT_XML = "word/document.xml";
const COMMENTS_EXT_XML = "word/commentsExtended.xml";

type AuxiliaryKind = "footnote" | "endnote" | "comment" | "header" | "footer";
const AUXILIARY_RELATIONSHIP_SUFFIX: Record<AuxiliaryKind, RegExp> = {
  footnote: /\/footnotes$/i,
  endnote: /\/endnotes$/i,
  comment: /\/comments$/i,
  header: /\/header$/i,
  footer: /\/footer$/i,
};

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

/** Read visible text tokens without assigning formatting semantics. */
function textTokens(body: string, s: Syntax): string {
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

type ParagraphSegment = {
  text: string;
  formatting: SourceFormattingEvidence;
  programmingLogic: boolean;
};

const emptyFormatting = (): SourceFormattingEvidence => ({
  runs: [],
  paragraphBackground: null,
  cellBackground: null,
  roleBoundarySplit: false,
  unresolvedBackground: [],
});

const explicitAchromaticGrey = (fill: string | null): boolean => {
  const value = fill?.trim() ?? "";
  if (!/^[0-9a-f]{6}$/i.test(value)) return false;
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return r === g && g === b && r > 0 && r < 255;
};

/** Ancestor shading is semantic evidence only when every direct colour input is resolved. */
const backgroundGreyProgramming = (background: SourceBackgroundFormatting | null): boolean => {
  if (background === null || background.themeFill !== null) return false;
  if ((background.shadingVal?.trim().toLowerCase() ?? null) === "nil") return false;
  return explicitAchromaticGrey(background.shadingFill);
};

/** A coloured direct highlight or explicit non-grey run fill counterweights a grey ancestor. */
function directGreyProgramming(
  run: SourceRunFormatting,
  paragraphBackground: SourceBackgroundFormatting | null,
  cellBackground: SourceBackgroundFormatting | null,
): boolean {
  const highlight = run.highlight?.trim().toLowerCase() ?? null;
  // Specificity is strict. Once a higher level declares formatting, an unresolved or
  // non-grey value MUST NOT fall through to a lower grey ancestor.
  if (highlight !== null) return highlight === "lightgray" || highlight === "darkgray";
  if (run.runStyle !== null) return false;
  if (run.shadingPresent === true || run.shadingFill !== null || run.shadingVal != null || run.themeFill !== null) {
    if (run.themeFill !== null || (run.shadingVal?.trim().toLowerCase() ?? null) === "nil") return false;
    return explicitAchromaticGrey(run.shadingFill);
  }
  if (run.paragraphStyle !== null) return false;
  if (paragraphBackground !== null) return backgroundGreyProgramming(paragraphBackground);
  return backgroundGreyProgramming(cellBackground);
}

function directRunFormatting(runXml: string, s: Syntax, text: string, paragraphStyle: string | null): {
  evidence: SourceRunFormatting;
  unresolved: string[];
} {
  const p = escapeRegExp(s.prefix);
  // rPr is an immediate first child by the WordprocessingML grammar. Anchoring avoids
  // borrowing a nested ruby base/reading run's properties as the outer run's evidence.
  const rPr = new RegExp(
    `^\\s*(<${p}rPr(?=[\\s>])[^>]*>[\\s\\S]*?<\\/${p}rPr>|<${p}rPr(?=[\\s/>])[^>]*\\/>)`,
  ).exec(runXml)?.[1] ?? "";
  const highlight = xmlAttribute(propertyElement(rPr, s, "highlight"), "val") ?? null;
  const shading = propertyElement(rPr, s, "shd");
  const shadingFill = xmlAttribute(shading, "fill") ?? null;
  const shadingVal = xmlAttribute(shading, "val") ?? null;
  const themeFill = xmlAttribute(shading, "themeFill") ?? null;
  const runStyle = xmlAttribute(propertyElement(rPr, s, "rStyle"), "val") ?? null;
  const unresolved: string[] = [];
  if (paragraphStyle !== null) unresolved.push(`paragraph-style:${paragraphStyle}`);
  if (runStyle !== null) unresolved.push(`run-style:${runStyle}`);
  if (themeFill !== null) unresolved.push(`theme-fill:${themeFill}`);
  if (shading.length > 0 && shadingFill === null && themeFill === null) unresolved.push("run-shading-unresolved");
  if (shadingVal?.trim().toLowerCase() === "nil") unresolved.push("run-shading-value:nil");
  if (shadingFill?.trim().toLowerCase() === "auto") unresolved.push("automatic-shading-fill");
  return {
    evidence: {
      visibleCharacters: text.length, highlight, shadingFill, shadingPresent: shading.length > 0,
      shadingVal, themeFill, runStyle, paragraphStyle,
    },
    unresolved,
  };
}

/**
 * Preserve direct run evidence and split only when the explicit shop profile changes role.
 * Ordinary run fragmentation is reassembled exactly as before.
 */
function paragraphSegments(
  body: string,
  s: Syntax,
  cellBackground: SourceBackgroundFormatting | null = null,
  documentSemanticsProfile: DocumentSemanticsProfile = DOCUMENT_SEMANTICS_NONE,
): ParagraphSegment[] {
  const visibleBody = stripRubyReadings(body, s);
  const paragraphStyle = xmlAttribute(propertyElement(visibleBody, s, "pStyle"), "val") ?? null;
  const paragraphShading = propertyElement(propertyElement(visibleBody, s, "pPr"), s, "shd");
  const paragraphBackground: SourceBackgroundFormatting | null = paragraphShading.length > 0
    ? {
        shadingFill: xmlAttribute(paragraphShading, "fill") ?? null,
        shadingVal: xmlAttribute(paragraphShading, "val") ?? null,
        themeFill: xmlAttribute(paragraphShading, "themeFill") ?? null,
      }
    : null;
  const ancestorUnresolved = [
    ...(paragraphStyle ? [`paragraph-style:${paragraphStyle}`] : []),
    ...(paragraphBackground?.themeFill ? [`paragraph-theme-fill:${paragraphBackground.themeFill}`] : []),
    ...(cellBackground?.themeFill ? [`cell-theme-fill:${cellBackground.themeFill}`] : []),
    ...(paragraphBackground?.shadingVal?.trim().toLowerCase() === "nil" ? ["paragraph-shading-value:nil"] : []),
    ...(cellBackground?.shadingVal?.trim().toLowerCase() === "nil" ? ["cell-shading-value:nil"] : []),
    ...(paragraphBackground?.shadingFill?.trim().toLowerCase() === "auto" ? ["automatic-paragraph-shading-fill"] : []),
    ...(cellBackground?.shadingFill?.trim().toLowerCase() === "auto" ? ["automatic-cell-shading-fill"] : []),
  ];
  const runs = topLevelSpans(visibleBody, s.prefix, "r");
  if (runs === null) {
    const text = textTokens(visibleBody, s);
    return text.length === 0
      ? []
      : [{
          text,
          formatting: {
            runs: [{ visibleCharacters: text.length, highlight: null, shadingFill: null, themeFill: null, runStyle: null, paragraphStyle }],
            paragraphBackground,
            cellBackground,
            roleBoundarySplit: false,
            unresolvedBackground: ["unbalanced-run-markup", ...ancestorUnresolved],
          },
          // A direct coloured highlight may be hidden in the unbalanced run markup, so do not
          // let a grey ancestor classify this text without proving the counterweight absent.
          programmingLogic: false,
        }];
  }

  const raw: ParagraphSegment[] = [];
  const push = (text: string, formatting: SourceFormattingEvidence, programmingLogic: boolean) => {
    if (text.length === 0) return;
    const prior = raw[raw.length - 1];
    if (prior && prior.programmingLogic === programmingLogic) {
      prior.text += text;
      prior.formatting.runs.push(...formatting.runs);
      prior.formatting.unresolvedBackground = [
        ...new Set([...prior.formatting.unresolvedBackground, ...formatting.unresolvedBackground]),
      ];
      return;
    }
    raw.push({ text, formatting, programmingLogic });
  };

  let cursor = 0;
  for (const run of runs) {
    const gap = textTokens(visibleBody.slice(cursor, run.start), s);
    if (gap.length > 0) {
      const evidence: SourceRunFormatting = {
        visibleCharacters: gap.length,
        highlight: null,
        shadingFill: null,
        themeFill: null,
        runStyle: null,
        paragraphStyle,
      };
      push(
        gap,
        { runs: [evidence], paragraphBackground, cellBackground, roleBoundarySplit: false, unresolvedBackground: ancestorUnresolved },
        documentSemanticsProfile === GREY_PROGRAMMING_PROFILE &&
          directGreyProgramming(evidence, paragraphBackground, cellBackground),
      );
    }
    const text = textTokens(run.inner, s);
    if (text.length > 0) {
      const { evidence, unresolved } = directRunFormatting(run.inner, s, text, paragraphStyle);
      push(
        text,
        {
          runs: [evidence],
          paragraphBackground,
          cellBackground,
          roleBoundarySplit: false,
          unresolvedBackground: [...new Set([...unresolved, ...ancestorUnresolved])],
        },
        documentSemanticsProfile === GREY_PROGRAMMING_PROFILE &&
          directGreyProgramming(evidence, paragraphBackground, cellBackground),
      );
    }
    cursor = run.end;
  }
  const tail = textTokens(visibleBody.slice(cursor), s);
  if (tail.length > 0) {
    const evidence: SourceRunFormatting = {
      visibleCharacters: tail.length,
      highlight: null,
      shadingFill: null,
      themeFill: null,
      runStyle: null,
      paragraphStyle,
    };
    push(
      tail,
      { runs: [evidence], paragraphBackground, cellBackground, roleBoundarySplit: false, unresolvedBackground: ancestorUnresolved },
      documentSemanticsProfile === GREY_PROGRAMMING_PROFILE &&
        directGreyProgramming(evidence, paragraphBackground, cellBackground),
    );
  }
  return raw;
}

function paragraphText(body: string, s: Syntax): string {
  return paragraphSegments(body, s).map((segment) => segment.text).join("");
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
    const re = /<(?:[A-Za-z_][\w.-]*:)?Relationship(?=[\s/>])[^>]*\/?>/gi;
    for (const tag of xml.match(re) ?? []) {
      const type = xmlAttribute(tag, "Type") ?? "";
      if (!/\/officeDocument$/i.test(type)) continue;
      if ((xmlAttribute(tag, "TargetMode") ?? "").toLowerCase() === "external") continue;
      const target = xmlAttribute(tag, "Target");
      if (!target) continue;
      const normalized = resolveRelationshipTarget(null, target);
      if (normalized !== null) return normalized;
    }
  }
  if (entries[DOCUMENT_XML]) return DOCUMENT_XML;
  const candidate = partNames.find((n) => /^word\/document\d*\.xml$/.test(n) && entries[n]);
  return candidate ?? DOCUMENT_XML;
}

type PackageRelationship = {
  id: string | null;
  type: string;
  target: string | null;
  external: boolean;
};

function relationshipPartName(sourcePart: string): string {
  const slash = sourcePart.lastIndexOf("/");
  const dir = slash < 0 ? "" : sourcePart.slice(0, slash + 1);
  const file = slash < 0 ? sourcePart : sourcePart.slice(slash + 1);
  return `${dir}_rels/${file}.rels`;
}

/** Resolve an OPC internal Target against its source part without filesystem semantics. */
function resolveRelationshipTarget(sourcePart: string | null, rawTarget: string): string | null {
  const target = decodeXmlEntities(rawTarget).split("#", 1)[0]!.replace(/\\/g, "/");
  const absolute = target.startsWith("/");
  const base = absolute || sourcePart === null ? [] : sourcePart.split("/").slice(0, -1);
  const parts = [...base];
  for (const segment of target.replace(/^\/+/, "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.length > 0 ? parts.join("/") : null;
}

function relationshipsFor(entries: Record<string, Uint8Array>, sourcePart: string): {
  relPart: string;
  present: boolean;
  relationships: PackageRelationship[];
} {
  const relPart = relationshipPartName(sourcePart);
  const raw = entries[relPart];
  if (!raw) return { relPart, present: false, relationships: [] };
  const xml = decodePart(raw);
  const tags = xml.match(/<(?:[A-Za-z_][\w.-]*:)?Relationship(?=[\s/>])[^>]*\/?>/gi) ?? [];
  return {
    relPart,
    present: true,
    relationships: tags.map((tag) => {
      const external = (xmlAttribute(tag, "TargetMode") ?? "").trim().toLowerCase() === "external";
      const rawTarget = xmlAttribute(tag, "Target");
      return {
        id: xmlAttribute(tag, "Id") ?? null,
        type: xmlAttribute(tag, "Type") ?? "",
        target: external || rawTarget === undefined ? null : resolveRelationshipTarget(sourcePart, rawTarget),
        external,
      };
    }),
  };
}

function auxiliaryKind(type: string): AuxiliaryKind | null {
  for (const [kind, suffix] of Object.entries(AUXILIARY_RELATIONSHIP_SUFFIX) as Array<[AuxiliaryKind, RegExp]>) {
    if (suffix.test(type)) return kind;
  }
  return null;
}

function referencedIds(xml: string, s: Syntax, names: string[]): Set<string> {
  const p = escapeRegExp(s.prefix);
  const out = new Set<string>();
  for (const name of names) {
    const n = escapeRegExp(name);
    const re = new RegExp(`<${p}${n}(?=[\\s/>])([^>]*)/?>`, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(xml)) !== null) {
      const id = xmlAttribute(match[1] ?? "", "id")?.trim();
      if (id) out.add(id);
    }
  }
  return out;
}

export interface ParseDocxBlocksOptions {
  /** Missing means neutral for legacy callers. Unknown values are refused, never guessed. */
  documentSemanticsProfile?: DocumentSemanticsProfile;
}

export function parseDocxBlocks(
  data: ArrayBuffer | Uint8Array,
  options: ParseDocxBlocksOptions = {},
): ParsedDocument {
  const documentSemanticsProfile = normalizeDocumentSemanticsProfile(options.documentSemanticsProfile);
  const parserVersion = docxBlocksVersion(documentSemanticsProfile);
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
          /(?:\.xml|\.rels)$/i.test(info.name);
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
  let blocks = scanBody(xml, syntax, coverage, "body", documentSemanticsProfile);
  if (blocks.length === 0) {
    const detected = detectPrefix(xml);
    if (detected !== null && detected !== "w:") {
      syntax = buildSyntax(detected);
      blocks = scanBody(xml, syntax, coverage, "body", documentSemanticsProfile);
    }
  }
  if (blocks.length === 0) {
    throw new Error(
      `parseDocxBlocks: no paragraphs could be parsed from "${DOCUMENT_XML}" (${xml.length} chars of XML). ` +
        `An empty requirement set from an unparsed document would read as "the document obliges nothing".`,
    );
  }
  coverage.partsRead.push(partNames[0] === FLAT_WORDML_PART ? FLAT_WORDML_PART : mainPart);

  // Auxiliary content is discovered only through the main part's OPC relationships.
  const bodyReferences: Record<"footnote" | "endnote" | "comment", Set<string>> = {
    footnote: referencedIds(xml, syntax, ["footnoteReference"]),
    endnote: referencedIds(xml, syntax, ["endnoteReference"]),
    comment: referencedIds(xml, syntax, ["commentReference", "commentRangeStart", "commentRangeEnd"]),
  };
  const mainRelationships = relationshipsFor(entries, mainPart);
  if (mainRelationships.present) coverage.partsRead.push(mainRelationships.relPart);
  else if ([...Object.values(bodyReferences)].some((ids) => ids.size > 0)) {
    coverage.problems.push(
      `AUXILIARY_RELATIONSHIPS_MISSING: ${mainRelationships.relPart} is absent while the main document ` +
        `references annotations. Referenced content is retained below as unreadable placeholders.`,
    );
  }
  const auxiliary = mainRelationships.relationships
    .map((relationship) => ({ relationship, kind: auxiliaryKind(relationship.type) }))
    .filter((item): item is { relationship: PackageRelationship; kind: AuxiliaryKind } => item.kind !== null);
  const annotationIds: Record<"footnote" | "endnote" | "comment", Set<string>> = {
    footnote: new Set(), endnote: new Set(), comment: new Set(),
  };

  for (const { relationship, kind } of auxiliary) {
    const diagnosticPart = relationship.target ?? `relationship:${relationship.id ?? "(missing-id)"}`;
    if (relationship.external || relationship.target === null) {
      coverage.partsSkipped.push({ part: diagnosticPart, reason: `${kind} relationship is external or has an invalid/missing Target` });
      coverage.problems.push(`AUXILIARY_RELATIONSHIP_UNREADABLE: ${kind} relationship ${relationship.id ?? "(missing-id)"} has no safe internal target.`);
      continue;
    }
    const raw = entries[relationship.target];
    if (!raw) {
      const presentButFiltered = partNames.includes(relationship.target);
      coverage.partsSkipped.push({
        part: relationship.target,
        reason: presentButFiltered ? "relationship target is too large to inflate safely" : "relationship target is absent from the package",
      });
      coverage.problems.push(
        `AUXILIARY_RELATIONSHIP_TARGET_MISSING: ${kind} relationship ${relationship.id ?? "(missing-id)"} targets ` +
          `${relationship.target}, but its bytes are unavailable. Referenced annotations remain counted placeholders.`,
      );
      continue;
    }
    const partXml = decodePart(raw);
    const partS = partSyntax(partXml, syntax);
    const origin = `${kind} [part=${relationship.target}]`;
    if (kind === "footnote" || kind === "endnote") {
      const seen = annotationIds[kind];
      const notes = scanNotes(partXml, partS, kind, relationship.target, coverage, documentSemanticsProfile, seen);
      blocks.push(...notes);
      if (notes.length > 0) {
        coverage.problems.push(
          `${seen.size} ${kind}(s) produced ${notes.length} addressable block(s) read from ${relationship.target}; ` +
            `they remain independently originated source, not decoration.`,
        );
      }
    } else if (kind === "header" || kind === "footer") {
      const drafts = scanBody(partXml, partS, coverage, origin, documentSemanticsProfile, origin)
        .map((draft): Draft => ({
          ...draft,
          origin: draft.origin === origin
            ? origin
            : `${origin}; lifted=${draft.sourceSubrole ?? "origin-bearing-source"}`,
        }))
        .filter((draft) => clean(draft.text).length > 0);
      blocks.push(...drafts);
      if (drafts.length > 0) {
        coverage.problems.push(
          `${drafts.length} addressable block(s) came from ${relationship.target}; identical text in another ` +
            `${kind} part remains distinct because part identity is source evidence.`,
        );
      }
    } else {
      const comments = scanComments(
        partXml, partS, entries[COMMENTS_EXT_XML] !== undefined, coverage, relationship.target,
        annotationIds.comment,
      );
      blocks.push(...comments);
      if (comments.length > 0) {
        coverage.problems.push(
          `COMMENT_FORMATTING_NOT_PRESERVED: ${comments.length} Word comment block(s) retain visible text, ` +
            `but comment formatting proves no document semantics. Comments remain labelled proposals.`,
        );
      }
    }
    coverage.partsRead.push(relationship.target);
  }

  for (const kind of ["footnote", "endnote", "comment"] as const) {
    for (const id of bodyReferences[kind]) {
      if (annotationIds[kind].has(id)) continue;
      const origin = `${kind} ${id} [part=unavailable]`;
      coverage.problems.push(
        `REFERENCED_AUXILIARY_CONTENT_UNREADABLE: main-document ${kind} reference ${id} has no readable ` +
          `relationship-backed declaration; a placeholder remains in the denominator.`,
      );
      blocks.push(kind === "comment"
        ? {
            kind: "paragraph", text: "[comment text unreadable]", section: null, coords: null, tableId: null,
            origin: `${origin}  PROPOSAL, resolution unknown`, sourceSubrole: "comment-proposal",
            formatting: emptyFormatting(), semanticSpans: [],
          }
        : {
            kind: "footnote", text: "[note text unreadable]", section: null, coords: null, tableId: null,
            origin, sourceSubrole: null, formatting: emptyFormatting(), semanticSpans: [],
          });
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
    const text = b.formatting.roleBoundarySplit ? b.text.replace(/[ \t]+\n/g, "\n") : clean(b.text);
    if (clean(text).length === 0) continue;
    if (b.kind === "heading" && b.origin === "body") section = text;
    const bodyScoped =
      b.origin === "body" ||
      b.origin === "combo-box-suggestion" ||
      b.origin === "image-alt" ||
      (b.origin.startsWith("ruby-reading") && b.origin.includes('source="body"'));
    n += 1;
    finished.push({
      ...b,
      text,
      blockId: `b${String(n).padStart(4, "0")}`,
      sourceSubrole: b.sourceSubrole ?? null,
      // Notes/comments/headers/footers are independent document parts. Assigning the last
      // body heading to them would invent scope the DOCX never expressed.
      section: bodyScoped ? section : b.section,
    });
  }

  const counts = {
    paragraphs: finished.filter((b) => b.kind === "paragraph").length,
    tableCells: finished.filter((b) => b.kind === "table-cell").length,
    footnotes: finished.filter((b) => b.kind === "footnote").length,
    headings: finished.filter((b) => b.kind === "heading").length,
    listItems: finished.filter((b) => b.kind === "list-item").length,
  };

  const programmingBlocks = finished.filter((b) =>
    b.semanticSpans.some((span) => span.role === "programming-logic"),
  );
  const programmingRuns = programmingBlocks.reduce(
    (count, block) => count + block.semanticSpans.reduce((n2, span) => n2 + span.runSpans, 0),
    0,
  );
  const programmingCharacters = programmingBlocks.reduce((count, block) => count + block.text.length, 0);
  if (programmingBlocks.length > 0) {
    coverage.problems.push(
      `GREY_PROGRAMMING_PROFILE_APPLIED: explicitly bound parser profile ${GREY_PROGRAMMING_PROFILE} classified ` +
        `${programmingBlocks.length} addressable block(s), ${programmingRuns} direct run span(s), and ` +
        `${programmingCharacters} character(s) as programming logic. Only direct lightGray/darkGray highlights and explicit six-digit ` +
        `achromatic grey fills on runs, paragraphs, or table cells (excluding black/white) qualify; a coloured ` +
        `direct run highlight counterweights a grey ancestor. This is an assumption, not a universal Word convention.`,
    );
  }
  const greyEvidenceRuns = finished.reduce(
    (count, block) => count + block.formatting.runs.filter((run) =>
      directGreyProgramming(run, block.formatting.paragraphBackground, block.formatting.cellBackground),
    ).length,
    0,
  );
  if (documentSemanticsProfile === DOCUMENT_SEMANTICS_NONE && greyEvidenceRuns > 0) {
    coverage.problems.push(
      `GREY_FORMATTING_PRESENT_UNCLASSIFIED: ${greyEvidenceRuns} direct run span(s) carry proven achromatic grey ` +
        `formatting, but documentSemanticsProfile=${DOCUMENT_SEMANTICS_NONE} assigns it no programming meaning. ` +
        `Formatting and text were retained; no option-label bytes were subtracted. Select an explicit declared ` +
        `document convention only when the questionnaire author confirms it.`,
    );
  }
  const unresolvedFormatting = finished.filter((b) => b.formatting.unresolvedBackground.length > 0);
  const packageFormattingReasons = [
    ...(partNames.includes("word/styles.xml") ? ["style-inheritance:word/styles.xml"] : []),
    ...partNames.filter((part) => /^word\/theme\/.*\.xml$/i.test(part)).map((part) => `theme-resolution:${part}`),
  ];
  if (unresolvedFormatting.length > 0 || packageFormattingReasons.length > 0) {
    const reasons = [
      ...new Set([
        ...packageFormattingReasons,
        ...unresolvedFormatting.flatMap((b) => b.formatting.unresolvedBackground),
      ]),
    ];
    coverage.problems.push(
      `GREY_PROGRAMMING_FORMATTING_UNRESOLVED: ${unresolvedFormatting.length} block(s) carry style-, theme-, ` +
        `automatic-, malformed-run, inherited-style, or package-theme background evidence this parser does not resolve ` +
        `(${reasons.slice(0, 12).join(", ")}` +
        `${reasons.length > 12 ? `; ${reasons.length - 12} additional reason(s)` : ""}). No programming role was ` +
        `inferred from those unresolved sources.`,
    );
  }

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

  return {
    parserVersion,
    documentSemanticsProfile,
    blocks: finished,
    annotatedText: annotate(finished),
    counts,
    coverage,
  };
}

const partSyntax = (partXml: string, fallback: Syntax): Syntax => {
  const detected = detectPrefix(partXml);
  return detected === null || detected === fallback.prefix ? fallback : buildSyntax(detected);
};

/**
 * Lossless model-input rendering: one compact JSON object per physical line.
 *
 * `text` is deliberately assigned directly from `SourceBlock.text`. JSON escaping is the
 * transport envelope, not a display normalization: after `JSON.parse`, every code unit —
 * including CR/LF, quotes and backslashes — is the exact parser-owned source string that
 * evidence grounding validates. Keep the metadata structural rather than re-rendering it
 * into prose; a model must never have to infer provenance from a display convention.
 */
export function encodeSourceBlocksJsonl(blocks: SourceBlock[]): string {
  return blocks.map((block) => JSON.stringify(sourceBlockModelProjection(block))).join("\n");
}

/**
 * The single canonical object schema placed on the model-input wire for one source block.
 * The bounded JSONL guard walks this same projection before serialization, so adding a field
 * here cannot silently bypass its raw-value memory tripwire.
 */
export function sourceBlockModelProjection(block: SourceBlock) {
  return {
    block_id: block.blockId,
    text: block.text,
    kind: block.kind,
    origin: block.origin,
    section: block.section,
    table_id: block.tableId,
    coords: block.coords,
    source_subrole: block.sourceSubrole ?? null,
    semantic_spans: block.semanticSpans ?? [],
  };
}

/** The legacy human-readable rendering: every line carries its id and its origin. */
export function annotate(blocks: SourceBlock[]): string {
  const out: string[] = [];
  let lastTable: string | null = null;
  for (const b of blocks) {
    // `tableId`, not `kind`, is the table-membership fact. A combo-box suggestion or ruby
    // reading is deliberately a paragraph block so its source authority survives, but it is
    // still hosted by a table cell and may be the table's first emitted block when that cell
    // has no rendered text of its own.
    if (b.tableId !== null && b.tableId !== lastTable) {
      out.push(`--- table ${b.tableId} ---`);
      lastTable = b.tableId;
    } else if (b.tableId === null) {
      lastTable = null;
    }
    const inlineText = b.text.replace(/\n/g, " ⏎ ");
    // SourceBlock requires semanticSpans, but annotate is also an exported boundary used by
    // versioned/synthetic parsed-document fixtures. Missing legacy provenance means
    // "unclassified", never a crash that prevents the source bytes reaching the model.
    const semanticSpans = b.semanticSpans ?? [];
    if (semanticSpans.some((span) => span.role === "programming-logic")) {
      const spans = semanticSpans.reduce((count, span) => count + span.runSpans, 0);
      out.push(
        `[${b.blockId}] ${describe(b)}[programming logic; profile=${GREY_PROGRAMMING_PROFILE}; direct-grey-runs=${spans}: ${inlineText}]`,
      );
    } else if (b.sourceSubrole === "combo-box-suggestion") {
      out.push(`[${b.blockId}] [combo-box suggestion — OPEN, NOT EXHAUSTIVE: ${inlineText}]`);
    } else if (b.sourceSubrole === "ruby-reading") {
      out.push(`[${b.blockId}] [${b.origin}: ${inlineText}]`);
    } else if (b.sourceSubrole === "vmerge-inherited") {
      out.push(`[${b.blockId}] ${describe(b)}[vmerge-inherited: ${inlineText}]`);
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
    formatting: emptyFormatting(),
    semanticSpans: [],
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
    sourceSubrole: "combo-box-suggestion",
    formatting: emptyFormatting(),
    semanticSpans: [],
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
      sourceSubrole: "ruby-reading",
      formatting: emptyFormatting(),
      semanticSpans: [],
    });
  }
  return drafts;
}

function scanBody(
  xmlRaw: string,
  s: Syntax,
  coverage: DocumentCoverage,
  origin: string,
  documentSemanticsProfile: DocumentSemanticsProfile,
  tableNamespace: string | null = origin === "body" ? null : origin,
): Draft[] {
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
    return scanParagraphRange(xml, s, coverage, origin, documentSemanticsProfile);
  }

  const out: Draft[] = [];
  let cursor = 0;
  let tableN = 0;
  for (const span of tableSpans) {
    out.push(...scanParagraphRange(xml.slice(cursor, span.start), s, coverage, origin, documentSemanticsProfile));
    tableN += 1;
    const tableId = tableNamespace === null ? `t${tableN}` : `${tableNamespace}:t${tableN}`;
    out.push(...scanTable(span.inner, s, tableId, coverage, origin, documentSemanticsProfile));
    cursor = span.end;
  }
  out.push(...scanParagraphRange(xml.slice(cursor), s, coverage, origin, documentSemanticsProfile));
  return out;
}

function scanParagraphRange(
  xml: string,
  s: Syntax,
  coverage: DocumentCoverage,
  origin: string,
  documentSemanticsProfile: DocumentSemanticsProfile,
): Draft[] {
  const out: Draft[] = [];
  const paraRe = new RegExp(s.paragraphSrc, "g");
  let m: RegExpExecArray | null;
  while ((m = paraRe.exec(xml)) !== null) {
    const body: string | undefined = m[1];
    if (body === undefined) continue;
    out.push(...paragraphDrafts(body, s, coverage, origin, null, documentSemanticsProfile));
  }
  return out;
}

function paragraphDrafts(
  body: string,
  s: Syntax,
  coverage: DocumentCoverage,
  origin: string,
  cellBackground: SourceBackgroundFormatting | null = null,
  documentSemanticsProfile: DocumentSemanticsProfile = DOCUMENT_SEMANTICS_NONE,
): Draft[] {
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

  const segments = paragraphSegments(body, s, cellBackground, documentSemanticsProfile);
  if (segments.length > 1) {
    for (const segment of segments) segment.formatting.roleBoundarySplit = true;
  }
  const fullText = segments.map((segment) => segment.text).join("");
  const numbered = hasNumbering(body, s);
  if (numbered && clean(fullText).length > 0 && !ALREADY_NUMBERED.test(fullText)) {
    // The identifier a reader sees ("Q1.", "a)") is generated at render time from
    // numbering.xml and exists nowhere in this XML. A visible unknown is recoverable.
    const first = segments.find((segment) => clean(segment.text).length > 0);
    if (first) first.text = `[#] ${first.text}`;
    coverage.autoNumberedParagraphs += 1;
  }

  const level = headingLevel(body, s);
  for (const segment of segments) {
    const text = segment.formatting.roleBoundarySplit
      ? segment.text.replace(/[ \t]+\n/g, "\n")
      : clean(segment.text);
    if (clean(text).length === 0) continue;
    const programming = segment.programmingLogic;
    const kind: SourceBlock["kind"] =
      !programming && origin === "body" && (level > 0 || SECTION_TEXT_RE.test(text))
        ? "heading"
        : !programming && numbered
          ? "list-item"
          : "paragraph";
    out.push({
      kind,
      text,
      section: null,
      coords: null,
      tableId: null,
      origin,
      formatting: segment.formatting,
      semanticSpans: programming
        ? [{ role: "programming-logic", profile: GREY_PROGRAMMING_PROFILE, runSpans: segment.formatting.runs.length }]
        : [],
    });
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
      sourceSubrole: "image-alt",
      formatting: emptyFormatting(),
      semanticSpans: [],
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
  formatting: SourceFormattingEvidence;
  /** One-based OOXML table-grid column, not the cell's array position. */
  gridCol: number;
  span: number;
  vMerge: VerticalMerge;
  /**
   * Origin-bearing drafts hosted by this cell (combo-box suggestions, ruby readings). They
   * are emitted as SEPARATE blocks after the cell, exactly as the body path emits them after
   * their host paragraph — folding them into cell text erased the origin that annotate()'s
   * OPEN-NOT-EXHAUSTIVE marker and the option-set source-role refusal both key on, which let
   * an open suggestion list in a table cell be sealed as an exhaustive answer list.
   */
  drafts: Draft[];
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
function scanTable(
  tableXml: string,
  s: Syntax,
  tableId: string,
  coverage: DocumentCoverage,
  origin: string,
  documentSemanticsProfile: DocumentSemanticsProfile,
): Draft[] {
  const nested = topLevelSpans(tableXml, s.prefix, "tbl");
  let body = tableXml;
  const nestedDrafts: Draft[] = [];
  if (nested === null) {
    coverage.problems.push(`${tableId}: nested <${s.prefix}tbl> tags do not balance; this table was read as flat paragraphs.`);
    return scanParagraphRange(tableXml, s, coverage, origin, documentSemanticsProfile);
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
      nestedDrafts.push(...scanTable(span.inner, s, `${tableId}.${n}`, coverage, origin, documentSemanticsProfile));
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
      const cellShading = propertyElement(props, s, "shd");
      const cellBackground: SourceBackgroundFormatting | null = cellShading.length > 0
        ? {
            shadingFill: xmlAttribute(cellShading, "fill") ?? null,
            shadingVal: xmlAttribute(cellShading, "val") ?? null,
            themeFill: xmlAttribute(cellShading, "themeFill") ?? null,
          }
        : null;
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
      const cellFormatting = emptyFormatting();
      cellFormatting.cellBackground = cellBackground;
      const cellDrafts: Draft[] = [];
      const paragraphPieces: Draft[] = [];
      const paraRe = new RegExp(s.paragraphSrc, "g");
      let paraMatch: RegExpExecArray | null;
      while ((paraMatch = paraRe.exec(cellXml)) !== null) {
        if (paraMatch[1] === undefined) continue;
        paragraphPieces.push(
          ...paragraphDrafts(paraMatch[1], s, coverage, origin, cellBackground, documentSemanticsProfile),
        );
      }
      const hasProgrammingPieces = paragraphPieces.some((d) => d.semanticSpans.length > 0);
      if (hasProgrammingPieces) {
        // A mixed cell is emitted in exact paragraph/run order. Folding its ordinary pieces
        // into one host cell and appending programming drafts afterwards would reorder
        // A / GREY / B into A+B / GREY. Ordinary pieces keep table-cell kind; programming
        // pieces are lifted paragraphs so row accounting cannot silently absorb them.
        for (const d of paragraphPieces) {
          if (clean(d.text).length === 0) continue;
          cellDrafts.push({
            ...d,
            kind: d.semanticSpans.length > 0 || d.origin !== origin ? "paragraph" : "table-cell",
            tableId,
            coords: { row: rows.length + 1, col: gridCol, rowHeader: null, colHeader: null },
          });
        }
      } else {
        for (const d of paragraphPieces) {
          if (d.sourceSubrole != null) {
            cellDrafts.push({
              ...d,
              kind: "paragraph",
              tableId,
              coords: { row: rows.length + 1, col: gridCol, rowHeader: null, colHeader: null },
            });
          }
          // A declared `sourceSubrole` above preserves known non-answer authority on its own
          // block; human-readable `origin` is provenance/display only, never executable
          // authority. This legacy branch conservatively keeps semantic or origin-bearing
          // drafts separate instead of silently folding unfamiliar parser output into cell
          // text. Drafts carrying only the part origin (paragraph text, dropdown items) fold.
          else if (d.origin !== origin || d.semanticSpans.length > 0) {
            // Preserve the separate draft and its exact host-cell provenance. Declared subroles
            // and semantic spans retain their typed meaning; `origin` remains non-authoritative.
            // `rows.length + 1` is the current one-based row because this row has not yet been
            // appended to `rows`.
            cellDrafts.push({
              ...d,
              kind: d.semanticSpans.length > 0 ? "paragraph" : d.kind,
              tableId,
              coords: { row: rows.length + 1, col: gridCol, rowHeader: null, colHeader: null },
            });
          } else if (clean(d.text).length > 0) {
            parts.push(clean(d.text));
            cellFormatting.runs.push(...d.formatting.runs);
            cellFormatting.paragraphBackground ??= d.formatting.paragraphBackground;
            cellFormatting.unresolvedBackground = [
              ...new Set([...cellFormatting.unresolvedBackground, ...d.formatting.unresolvedBackground]),
            ];
          }
        }
      }
      cells.push({ text: parts.join("\n"), formatting: cellFormatting, gridCol, span, vMerge, drafts: cellDrafts });
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
    (count, row) =>
      count + row.cells.filter((cell) =>
        clean(cell.text).length > 0 || cell.drafts.some((draft) => clean(draft.text).length > 0),
      ).length,
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

  // =========================================================================
  // VERTICAL MERGE INHERITANCE — the fix for merged action cells.
  //
  // ASSUMPTION (stated, not silent): Word vertical merge means the anchor
  // cell's content APPLIES to every row the merge spans. This is the common
  // pattern in routing tables: one [TERMINATE] cell merged across option rows
  // means every covered option terminates. When the assumption does not hold
  // (a merge used only for visual layout grouping), the inherited text is
  // visibly marked as inherited and degrades to a named limitation rather
  // than a wrong answer.
  //
  // MECHANISM: for each grid-column position, walk top to bottom. A cell
  // with vMerge="restart" is the anchor. Subsequent cells with
  // vMerge="continue" at the same column range inherit the anchor's content
  // when their own text is empty. The inherited content becomes a separate
  // block at each continuation row, with sourceSubrole="vmerge-inherited"
  // and the anchor's coordinates in the origin string.
  //
  // HORIZONTAL MERGES (gridSpan) do NOT inherit: each cell in a horizontal
  // span is a single physical cell with its own content.
  // =========================================================================
  let inheritedCount = 0;
  if (verticalMergeCount > 0) {
    // Build a map: gridCol -> ordered list of { rowIndex, cell } for cells
    // that participate in vertical merge groups.
    const mergeColumns = new Map<number, Array<{ rowIndex: number; cell: TableCell }>>();
    for (let r = 0; r < rows.length; r++) {
      for (const c of rows[r]!.cells) {
        if (c.vMerge === null) continue;
        const list = mergeColumns.get(c.gridCol) ?? [];
        list.push({ rowIndex: r, cell: c });
        mergeColumns.set(c.gridCol, list);
      }
    }

    for (const [, entries] of mergeColumns) {
      let anchor: TableCell | null = null;
      let anchorRow = -1;
      for (const { rowIndex, cell } of entries) {
        if (cell.vMerge === "restart") {
          anchor = cell;
          anchorRow = rowIndex;
        } else if (cell.vMerge === "continue" && anchor !== null) {
          // Inherit the anchor's content when this continuation cell is empty.
          if (clean(cell.text).length === 0 && clean(anchor.text).length > 0) {
            cell.text = anchor.text;
            cell.formatting = { ...anchor.formatting };
            cell.drafts = [
              ...cell.drafts,
              ...anchor.drafts.map((d): Draft => ({ ...d })),
            ];
            // Mark for the output loop: this cell carries inherited content.
            (cell as TableCell & { _inheritedFrom?: { row: number; col: number } })._inheritedFrom = {
              row: anchorRow + 1,
              col: anchor.gridCol,
            };
            inheritedCount += 1;
          }
        }
      }
    }

    coverage.problems.push(
      `TABLE_VERTICAL_MERGE_PRESENT: ${tableId} contains ${verticalMergeCount} vertical-merge marker(s)` +
        (inheritedCount > 0
          ? `; ${inheritedCount} continuation cell(s) inherited their anchor cell's content ` +
            `(assumption: vertical merge means content applicability across covered rows). ` +
            `Inherited blocks are marked vmerge-inherited so extraction passes see routing ` +
            `rules at every row they apply to.`
          : `. Cell text and structural coordinates are retained, but no row-header ` +
            `relationship is inferred from adjacency.`),
    );
  }

  const out: Draft[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    for (const c of row.cells) {
      const text = c.text;
      const inherited = (c as TableCell & { _inheritedFrom?: { row: number; col: number } })._inheritedFrom;
      if (clean(text).length === 0) {
        // A cell whose only content is a content control still owes its origin-bearing
        // drafts: skipping the empty cell must not silently drop the open suggestions.
        out.push(...c.drafts);
        continue;
      }
      out.push({
        kind: "table-cell",
        text,
        section: null,
        tableId,
        origin: inherited
          ? `${origin}; vmerge-inherited from r${inherited.row}c${inherited.col}`
          : origin,
        sourceSubrole: inherited ? "vmerge-inherited" : undefined,
        formatting: c.formatting,
        semanticSpans: [],
        coords: {
          row: r + 1,
          col: c.gridCol,
          rowHeader: null,
          colHeader: null,
        },
      });
      // Reading order mirrors the body path: the host cell's own text first, then its
      // origin-bearing drafts.
      out.push(...c.drafts);
    }
  }
  return [...out, ...nestedDrafts];
}

/** Footnote/endnote parts carry separator pseudo-notes; those are not document content. */
function scanNotes(
  xml: string,
  s: Syntax,
  label: "footnote" | "endnote",
  partName: string,
  coverage: DocumentCoverage,
  documentSemanticsProfile: DocumentSemanticsProfile,
  declaredIds: Set<string>,
): Draft[] {
  const p = escapeRegExp(s.prefix);
  const element = label;
  const noteRe = new RegExp(
    `<${p}${element}(?=[\\s/>])([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${p}${element}>)`,
    "g",
  );
  const out: Draft[] = [];
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = noteRe.exec(xml)) !== null) {
    const attrs = m[1] ?? "";
    const noteType = xmlAttribute(attrs, "type")?.trim().toLowerCase() ?? null;
    if (noteType === "separator" || noteType === "continuationseparator" || noteType === "continuationnotice") continue;
    n += 1;
    const declaredId = xmlAttribute(attrs, "id")?.trim();
    const id = declaredId && declaredId.length > 0 ? declaredId : String(n);
    declaredIds.add(id);
    const origin = `${label} ${id} [part=${partName}]`;
    const drafts = scanBody(m[2] ?? "", s, coverage, origin, documentSemanticsProfile, origin)
      .filter((draft) => clean(draft.text).length > 0)
      .map((draft): Draft => ({
        ...draft,
        kind: draft.kind === "table-cell" ? "table-cell" : "footnote",
        origin: draft.origin === origin
          ? origin
          : `${origin}; lifted=${draft.sourceSubrole ?? "origin-bearing-source"}`,
      }));
    if (drafts.length === 0) {
      coverage.problems.push(
        `NOTE_TEXT_UNREADABLE: ${origin} was declared but yielded no visible addressable text; ` +
          `a placeholder is retained and no semantic role is inferred.`,
      );
      out.push({
        kind: "footnote", text: "[note text unreadable]", section: null, coords: null, tableId: null,
        origin, sourceSubrole: null, formatting: emptyFormatting(), semanticSpans: [],
      });
    } else {
      out.push(...drafts);
    }
  }
  return out;
}

/** Word comments: labelled proposals, never body text. */
function scanComments(
  xml: string,
  s: Syntax,
  resolutionKnown: boolean,
  coverage: DocumentCoverage,
  partName: string,
  declaredIds: Set<string>,
): Draft[] {
  const p = escapeRegExp(s.prefix);
  const re = new RegExp(
    `<${p}comment(?=[\\s/>])([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${p}comment>)`,
    "g",
  );
  const out: Draft[] = [];
  let m: RegExpExecArray | null;
  let declared = 0;
  let unreadable = 0;
  let flattenedTables = 0;
  while ((m = re.exec(xml)) !== null) {
    declared += 1;
    const attrs = m[1] ?? "";
    const id = xmlAttribute(attrs, "id")?.trim() || String(declared);
    declaredIds.add(id);
    const author = xmlAttribute(attrs, "author") ?? "unknown";
    const initials = xmlAttribute(attrs, "initials") ?? "";
    const commentBody = m[2] ?? "";
    flattenedTables += commentBody.match(new RegExp(`<${p}tbl(?=[\\s>])`, "g"))?.length ?? 0;
    const paraRe = new RegExp(s.paragraphSrc, "g");
    const parts: string[] = [];
    let pm: RegExpExecArray | null;
    while ((pm = paraRe.exec(commentBody)) !== null) {
      const t = paragraphText(pm[1] ?? "", s);
      if (clean(t).length > 0) parts.push(clean(t));
    }
    if (parts.length === 0) {
      unreadable += 1;
      parts.push("[comment text unreadable]");
    }
    out.push({
      kind: "paragraph",
      text: parts.join("\n"),
      section: null,
      coords: null,
      tableId: null,
      origin: `comment ${id} [part=${partName}] by ${decodeXmlEntities(author)}${initials ? ` (${initials})` : ""}  PROPOSAL, resolution ${
        resolutionKnown ? "recorded in the document but not read here" : "unknown"
      }`,
      // A comment's authority is established by its OPC relationship, not the human-readable
      // origin string. This survives renamed parts and arbitrary reviewer metadata.
      sourceSubrole: "comment-proposal",
      formatting: emptyFormatting(),
      semanticSpans: [],
    });
  }
  if (declared > 0) {
    coverage.problems.push(
      `COMMENT_COVERAGE: ${declared} declared comment(s): ${declared - unreadable} readable and ${unreadable} ` +
        `unreadable/empty placeholder(s). Every declared comment remains counted and labelled as a proposal.`,
    );
  }
  if (flattenedTables > 0) {
    coverage.problems.push(
      `COMMENT_TABLE_STRUCTURE_NOT_PRESERVED: ${flattenedTables} table(s) inside Word comments retain visible ` +
        `paragraph text only; row/column relationships are not available and cannot prove a requirement.`,
    );
  }
  return out;
}

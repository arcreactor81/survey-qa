/**
 * EXTRACTION TYPES — the shapes the two passes, the ledger, the diff and the expander
 * agree on.
 *
 * Everything here is derived from something the document or a model actually produced.
 * There is no field whose default value means "fine": a block with no disposition is
 * `unresolved`, not `non-normative`, and a pass that did not run is absent from the
 * merge rather than contributing an empty list.
 */

/** One addressable unit of the source document. Every one of these must be dispositioned. */
export interface SourceBlock {
  /** Stable within a document parse: `b0001`, `b0002`, ... in document order. */
  blockId: string;
  kind: "paragraph" | "table-cell" | "footnote" | "heading" | "list-item";
  text: string;
  /**
   * WHERE IN THE ARCHIVE THIS CAME FROM: `body`, `footnote 3`, `endnote 1`, `header`,
   * `footer`, `image-alt`, or `comment by <author> — PROPOSAL…`.
   *
   * It is not decoration. A requirement lifted from a header ("DRAFT — NOT FOR FIELD")
   * and a requirement lifted from body copy carry different authority, and a Word comment
   * carries none at all until a human resolves it. v1 dropped these parts entirely and
   * said nothing, so a reviewer could not tell a document had been half-read.
   */
  origin: string;
  /** Nearest preceding heading, or null before the first one. */
  section: string | null;
  /**
   * Structural table start coordinates. WordprocessingML has no semantic th/scope
   * equivalent, so its parser leaves rowHeader/colHeader null.
   */
  coords: { row: number; col: number; rowHeader: string | null; colHeader: string | null } | null;
  tableId: string | null;
}

/**
 * WHAT THE PARSER READ AND WHAT IT COULD NOT — the honest half of the extraction.
 *
 * Every failure in the 20-document robustness corpus was survivable; what made them
 * dangerous is that none of them SAID anything. "There are 4 footnotes in this document I
 * could not read" is a usable output. A requirement list that silently omits them is not.
 */
export interface DocumentCoverage {
  archiveParts: number;
  partsRead: string[];
  partsSkipped: Array<{ part: string; reason: string }>;
  images: number;
  imagesWithAltText: number;
  unresolvedFieldCodes: number;
  symbolRuns: number;
  autoNumberedParagraphs: number;
  /** Plain sentences a human should read before trusting the requirement list. */
  problems: string[];
}

export interface ParsedDocument {
  blocks: SourceBlock[];
  /** Plain reading text, block ids inline, as handed to pass A. */
  annotatedText: string;
  counts: { paragraphs: number; tableCells: number; footnotes: number; headings: number; listItems: number };
  coverage: DocumentCoverage;
}

/** The eleven construct classes pass B must disposition for the document. */
export const CONSTRUCT_CLASSES = [
  "question",
  "option-list",
  "skip-rule",
  "terminate",
  "validation",
  "piping",
  "carry-forward",
  "calculation",
  "randomization",
  "loop",
  "instruction",
] as const;
export type ConstructClass = (typeof CONSTRUCT_CLASSES)[number];

/** A requirement as a model emitted it, before normalization. Both passes emit this shape. */
export interface RawRequirement {
  id: string;
  construct: string;
  scope: string;
  quantifier: string;
  selector: string | null;
  exceptions: string[];
  statement: string;
  docQuote: string;
  blockIds: string[];
  browserObservable: "full" | "partial" | "none";
  confidence: number;
  /** Typed expansion hints, ONLY when the document states them. Never invented. */
  expansion: RawExpansion | null;
  /** Which pass produced it. */
  pass: "A" | "B";
  /** Chunk/window id inside that pass, for the diff's provenance line. */
  origin: string;
}

export interface RawExpansion {
  kind: "route" | "boundary" | "option-set" | "rendered-state" | "copy" | "configuration";
  routeAnswers: Array<{ code: string | null; label: string | null; destination: string | null }>;
  maxLength: number | null;
  minSelections: number | null;
  maxSelections: number | null;
}

export interface RawAmbiguity {
  id: string;
  docQuote: string;
  readingA: string;
  readingB: string;
  whyAmbiguous: string;
  affects: string[];
  pass: "A" | "B";
}

export interface RawUnverifiable {
  id: string;
  docQuote: string;
  mandate: string;
  whyNotObservable: string;
  browserProxyEvidence: string;
  pass: "A" | "B";
}

export interface BlockDisposition {
  blockId: string;
  disposition: "normative" | "mapped-context" | "non-normative" | "ambiguous" | "unresolved";
  reason: string;
}

export interface ConstructVerdict {
  construct: ConstructClass;
  present: boolean;
  blockIds: string[];
}

/** One model call's telemetry. Cost is computed from configured per-Mtok prices. */
export interface CallUsage {
  callId: string;
  role: string;
  provider: string;
  model: string;
  status: "ok" | "parse-failed" | "error";
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  attempts: number;
  detail?: string;
}

export interface PassResult {
  pass: "A" | "B";
  provider: string;
  model: string;
  requirements: RawRequirement[];
  ambiguities: RawAmbiguity[];
  unverifiable: RawUnverifiable[];
  dispositions: BlockDisposition[];
  constructs: ConstructVerdict[];
  /** Windows/chunks that produced nothing usable. A failed unit is NOT an empty unit. */
  failedUnits: Array<{ unit: string; blockIds: string[]; detail: string }>;
  calls: CallUsage[];
}

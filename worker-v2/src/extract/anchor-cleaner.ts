/**
 * NAMED TRANSFORMATION: strip rendering-artifact markers from extracted text.
 *
 * Questionnaire documents sometimes contain bracketed renderer instructions like
 * "[ANCHOR BELOW]", "[INSERT ANCHOR]", "[DISPLAY HERE]" that are not respondent-facing
 * content. When these survive into extracted option labels or routing rules, they pollute
 * the labels the walker tries to match against the live survey.
 *
 * THE PATTERN IS A STATED ASSUMPTION (CLAUDE.md: no silent reliance on a convention):
 * a bracketed token whose every word belongs to a closed vocabulary of rendering directives
 * is classified as a rendering artifact. The vocabulary is English and finite. A document
 * in another language whose artifacts use different words will not be cleaned; those
 * artifacts pass through as ordinary text. This is a named limitation.
 *
 * WHEN THE ASSUMPTION DOES NOT HOLD: a real answer option that happens to be bracketed
 * all-caps rendering words is incorrectly removed. The count makes every removal visible
 * and the vocabulary is in a named data set, not buried in a regex.
 *
 * EVERY REMOVAL IS COUNTED. "There are 3 rendering artifacts I stripped" — never a quietly
 * cleaner string (CLAUDE.md: fail loudly, never silently short).
 */

/**
 * Rendering-directive vocabulary. Each word is a term that appears in bracketed renderer
 * instructions but is not respondent-facing survey content.
 *
 * This set is versioned: adding a word changes what the cleaner removes. The version is
 * carried in the count report so a reader knows which vocabulary produced the count.
 */
export const RENDERING_ARTIFACT_VOCAB = new Set([
  "ANCHOR",
  "INSERT",
  "PLACEHOLDER",
  "MARKER",
  "DISPLAY",
  "RENDER",
  "SHOW",
  "HIDE",
  "BELOW",
  "ABOVE",
  "HERE",
  "TOP",
  "BOTTOM",
  "LEFT",
  "RIGHT",
  "START",
  "END",
  "PAGE",
  "BREAK",
  "POSITION",
  "PLACE",
  "FIXED",
  "NOTE",
  "TAG",
  "LABEL",
  "TEXT",
  "BOX",
  "FIELD",
  "SECTION",
  "BLOCK",
  "AREA",
  "REGION",
  "CELL",
  "ROW",
  "COLUMN",
  "GRID",
]);

export const RENDERING_ARTIFACT_VOCAB_VERSION = "rendering-artifact-vocab/1.0.0";

/**
 * Match a bracketed all-caps token whose every word is in the rendering vocabulary.
 * The bracket content must be at least two characters (a single letter in brackets
 * like "[A]" is more likely to be a real label) and must contain at least one space
 * (single-word brackets like "[TERMINATE]" are routing destinations, not artifacts).
 *
 * The regex captures the full bracket including delimiters so the replacement can
 * remove trailing whitespace too.
 */
const BRACKETED_ARTIFACT = /\[([A-Z][A-Z ]{1,60}[A-Z])\]/g;

export interface CleanResult {
  /** The text with rendering artifacts removed. */
  cleaned: string;
  /** How many artifacts were removed. */
  removedCount: number;
  /** The exact strings that were removed, for the report. */
  removed: string[];
}

/**
 * Strip rendering-artifact markers from text. Returns the cleaned text, the count
 * of removals, and the exact strings removed.
 *
 * Cleaning is applied to the full string. Consecutive whitespace left by removal
 * is collapsed to a single space, and leading/trailing whitespace is trimmed.
 */
export function cleanRenderingArtifacts(text: string): CleanResult {
  const removed: string[] = [];

  const cleaned = text.replace(BRACKETED_ARTIFACT, (match, content: string) => {
    const words = content.trim().split(/\s+/);
    // Every word must be in the vocabulary for this to be a rendering artifact.
    // A bracket containing ANY word outside the vocabulary is kept as-is.
    if (words.length < 2) return match;
    if (words.every((w) => RENDERING_ARTIFACT_VOCAB.has(w))) {
      removed.push(match);
      return "";
    }
    return match;
  });

  // Collapse whitespace left by removals.
  const collapsed = removed.length > 0
    ? cleaned.replace(/  +/g, " ").trim()
    : cleaned;

  return {
    cleaned: collapsed,
    removedCount: removed.length,
    removed,
  };
}

/**
 * Apply cleaning to a batch of strings, accumulating the total count.
 * Returns per-field cleaned values and the aggregate removal report.
 */
export interface BatchCleanReport {
  totalRemoved: number;
  vocabVersion: string;
  details: Array<{ field: string; removed: string[] }>;
}

export function cleanBatch(
  fields: Array<{ field: string; value: string }>,
): { values: Map<string, string>; report: BatchCleanReport } {
  const values = new Map<string, string>();
  let totalRemoved = 0;
  const details: BatchCleanReport["details"] = [];

  for (const { field, value } of fields) {
    const result = cleanRenderingArtifacts(value);
    values.set(field, result.cleaned);
    totalRemoved += result.removedCount;
    if (result.removedCount > 0) {
      details.push({ field, removed: result.removed });
    }
  }

  return {
    values,
    report: {
      totalRemoved,
      vocabVersion: RENDERING_ARTIFACT_VOCAB_VERSION,
      details,
    },
  };
}

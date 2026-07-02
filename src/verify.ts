// Deterministic verification: quote grounding (verifyFindings) and
// seeded-error scoring (buildScorecard). Pure functions — no I/O.
// Seeded errors are passed in by the caller (index.ts imports canon.json).

import type { Finding, ModelName, PageCapture, Scorecard, ScorecardEntry } from "./types";

/** One entry of the seeded-error manifest (canon.json "seededErrors"). */
export interface SeededError {
  id: string;
  questionId: string;
  category: string;
  note: string;
  truth: string;
  rendered: string;
}

const MODELS: readonly ModelName[] = ["deepseek", "claude", "workersai"];

/** Categories where the defect is an ABSENCE on the site, so siteQuote is legitimately "". */
const ABSENCE_CATEGORIES: ReadonlySet<Finding["category"]> = new Set<Finding["category"]>([
  "missing-option",
  "missing-instruction",
  "missing-question",
]);

/** Collapse runs of whitespace to a single space and trim. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Distinctive fragment: first 15 chars, whitespace-normalized, lowercased. */
function fragmentOf(text: string): string {
  return normalizeWhitespace(text).toLowerCase().slice(0, 15);
}

/**
 * Set quoteVerified on every finding:
 * - specQuote must appear (whitespace-normalized) in specText — always required.
 * - siteQuote must appear in THAT page's text (matched by finding.pageIndex).
 * - Absence categories pass with an empty siteQuote; a non-empty siteQuote is
 *   still checked against the page.
 * - Non-absence findings with an empty siteQuote fail verification.
 * Returns new Finding objects; the input array is not mutated.
 */
export function verifyFindings(
  findings: Finding[],
  specText: string,
  pages: PageCapture[],
): Finding[] {
  const normalizedSpec = normalizeWhitespace(specText);
  const pageTextByIndex = new Map<number, string>();
  for (const page of pages) {
    pageTextByIndex.set(page.pageIndex, normalizeWhitespace(page.text));
  }

  return findings.map((finding) => {
    const specNeedle = normalizeWhitespace(finding.specQuote);
    const specOk = specNeedle.length > 0 && normalizedSpec.includes(specNeedle);

    const siteNeedle = normalizeWhitespace(finding.siteQuote);
    let siteOk: boolean;
    if (siteNeedle.length === 0) {
      siteOk = ABSENCE_CATEGORIES.has(finding.category);
    } else {
      const pageText = pageTextByIndex.get(finding.pageIndex);
      siteOk = pageText !== undefined && pageText.includes(siteNeedle);
    }

    return { ...finding, quoteVerified: specOk && siteOk };
  });
}

/**
 * A VERIFIED finding matches a seeded error when:
 *   (questionId matches case-insensitively, OR the finding's description/quotes
 *    contain the seeded questionId)
 * AND
 *   (category matches exactly, OR siteQuote/description contain a distinctive
 *    fragment of seeded.rendered, OR specQuote/description contain a distinctive
 *    fragment of seeded.truth).
 */
function findingMatchesSeeded(finding: Finding, seeded: SeededError): boolean {
  const seededQid = seeded.questionId.toLowerCase();
  const findingQid = (finding.questionId ?? "").toLowerCase();
  const description = normalizeWhitespace(finding.description).toLowerCase();
  const siteQuote = normalizeWhitespace(finding.siteQuote).toLowerCase();
  const specQuote = normalizeWhitespace(finding.specQuote).toLowerCase();

  const questionMatch =
    seededQid.length > 0 &&
    (findingQid === seededQid ||
      description.includes(seededQid) ||
      siteQuote.includes(seededQid) ||
      specQuote.includes(seededQid));
  if (!questionMatch) return false;

  if (finding.category === seeded.category) return true;

  const renderedFragment = fragmentOf(seeded.rendered);
  if (
    renderedFragment.length > 0 &&
    (siteQuote.includes(renderedFragment) || description.includes(renderedFragment))
  ) {
    return true;
  }

  const truthFragment = fragmentOf(seeded.truth);
  if (
    truthFragment.length > 0 &&
    (specQuote.includes(truthFragment) || description.includes(truthFragment))
  ) {
    return true;
  }

  return false;
}

/**
 * Score both models against the seeded-error manifest.
 * Only VERIFIED findings (quoteVerified === true) count — run verifyFindings first.
 * recall = caught / total seeded (per model).
 * falsePositives = that model's verified findings not matched to any seeded error.
 */
export function buildScorecard(
  findings: Finding[],
  seeded: Array<{
    id: string;
    questionId: string;
    category: string;
    note: string;
    truth: string;
    rendered: string;
  }>,
): Scorecard {
  const verified = findings.filter((finding) => finding.quoteVerified);

  const entries: ScorecardEntry[] = seeded.map((error) => {
    const caughtBy = MODELS.filter((model) =>
      verified.some(
        (finding) => finding.model === model && findingMatchesSeeded(finding, error),
      ),
    );
    return {
      errorId: error.id,
      questionId: error.questionId,
      category: error.category,
      note: error.note,
      caughtBy,
    };
  });

  const recall: Record<ModelName, number> = { deepseek: 0, claude: 0, workersai: 0 };
  const falsePositives: Record<ModelName, number> = { deepseek: 0, claude: 0, workersai: 0 };

  for (const model of MODELS) {
    const caught = entries.filter((entry) => entry.caughtBy.includes(model)).length;
    recall[model] = seeded.length > 0 ? caught / seeded.length : 0;
    falsePositives[model] = verified.filter(
      (finding) =>
        finding.model === model &&
        !seeded.some((error) => findingMatchesSeeded(finding, error)),
    ).length;
  }

  return { entries, recall, falsePositives };
}

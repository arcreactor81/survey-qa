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

const MODELS: readonly ModelName[] = ["deepseek", "claude", "workersai", "gemini", "grok"];

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

/** Escape regex metacharacters so a value can be used as a literal pattern. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Distinctive fragment: first 15 chars, whitespace-normalized, lowercased. */
function fragmentOf(text: string): string {
  return normalizeWhitespace(text).toLowerCase().slice(0, 15);
}

/**
 * Minimum length of a whitespace-normalized specQuote for an absence claim to
 * be verifiable. Below this, the quote is not distinctive enough: a common
 * short token ("a", "Yes", "the") is trivially "absent" from a sparse page and
 * would credit a hallucinated absence finding. Kept at 4 so genuinely
 * distinctive short spec tokens still qualify (e.g. the "BIMZELX" brand option,
 * 7 chars, which is a real seeded missing-option). Do NOT raise this above the
 * shortest legitimate absent token, or real absence findings will be dropped.
 */
const MIN_ABSENCE_SPEC_LEN = 4;

/**
 * Set quoteVerified on every finding:
 * - specQuote must appear (whitespace-normalized) in specText — always required.
 * - siteQuote must appear in THAT page's text (matched by finding.pageIndex).
 * - Absence categories pass with an empty siteQuote, but ONLY if the
 *   claimed-missing specQuote is actually ABSENT from the rendered page text
 *   (a "missing X" claim is refuted when X is present on the page). A
 *   non-empty siteQuote is still checked against the page.
 * - Non-absence findings with an empty siteQuote fail verification.
 * Returns new Finding objects; the input array is not mutated.
 */
export function verifyFindings(
  findings: Finding[],
  specText: string,
  pages: PageCapture[],
): Finding[] {
  const normalizedSpec = normalizeWhitespace(specText);
  if (normalizedSpec.length === 0) {
    // Every finding will fail spec grounding below; make the silent-zeroing
    // failure mode (e.g. docx extraction produced no text) visible in logs.
    console.warn(
      "verifyFindings: specText is empty — all findings will fail verification; " +
        "docx extraction may have produced no text",
    );
  }
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
      // Absence claim: verify the claimed-missing spec text does NOT appear on
      // the site. Without this, an absence finding is unfalsifiable (a spec-side
      // check alone would credit a hallucinated "missing" claim even when the
      // text is actually present on the page).
      if (!ABSENCE_CATEGORIES.has(finding.category)) {
        siteOk = false;
      } else if (specNeedle.length < MIN_ABSENCE_SPEC_LEN) {
        // Not distinctive enough to verify an absence — see MIN_ABSENCE_SPEC_LEN.
        siteOk = false;
      } else if (pageTextByIndex.size === 0) {
        // No captured page text: absence cannot be confirmed from evidence.
        siteOk = false;
      } else if (finding.category === "missing-question") {
        // A whole question is "missing" only when it is absent from EVERY
        // captured page — a per-page check would falsely verify a question that
        // merely moved to a different page. Require absence across all pages.
        siteOk = ![...pageTextByIndex.values()].some((text) => text.includes(specNeedle));
      } else {
        // Page-local absence (missing-option / missing-instruction): the defect
        // is scoped to one question on one page. Check the claimed page; if its
        // index is unknown, fall back to requiring absence from every page.
        const pageText = pageTextByIndex.get(finding.pageIndex);
        if (pageText !== undefined) {
          siteOk = !pageText.includes(specNeedle);
        } else {
          siteOk = ![...pageTextByIndex.values()].some((text) => text.includes(specNeedle));
        }
      }
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
 * Fallback when no questionId signal is present anywhere (models may legally
 * emit questionId: null for option/instruction-level defects): still match on
 * STRONG evidence only — exact category AND a verbatim-quote fragment hit
 * (quotes only; the looser description-based hits are not accepted here).
 */
function findingMatchesSeeded(finding: Finding, seeded: SeededError): boolean {
  const seededQid = seeded.questionId.toLowerCase();
  const findingQid = (finding.questionId ?? "").toLowerCase();
  const description = normalizeWhitespace(finding.description).toLowerCase();
  const siteQuote = normalizeWhitespace(finding.siteQuote).toLowerCase();
  const specQuote = normalizeWhitespace(finding.specQuote).toLowerCase();

  // Free-text mention of the seeded id must be a WHOLE token, not a substring:
  // a plain includes() lets short ids over-match ("q1" inside "q10"/"q11", "s1"
  // inside "s10" or "hips1"), crediting the wrong seeded error. \b treats the
  // alphanumeric id as a word so "q1" matches "q1" / "(q1)" but not "q10".
  const qidMentioned = (haystack: string): boolean =>
    new RegExp(`\\b${escapeRegExp(seededQid)}\\b`).test(haystack);

  const questionMatch =
    seededQid.length > 0 &&
    (findingQid === seededQid ||
      qidMentioned(description) ||
      qidMentioned(siteQuote) ||
      qidMentioned(specQuote));
  if (!questionMatch) {
    if (finding.category !== seeded.category) return false;
    const renderedFrag = fragmentOf(seeded.rendered);
    const truthFrag = fragmentOf(seeded.truth);
    return (
      (renderedFrag.length > 0 && siteQuote.includes(renderedFrag)) ||
      (truthFrag.length > 0 && specQuote.includes(truthFrag))
    );
  }

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
 * falsePositives = that model's verified findings NOT assigned to a seeded error
 * by the one-to-one matching below.
 *
 * Assignment is one-to-one per model: each verified finding can credit at most
 * ONE seeded entry, so a single vague finding cannot inflate recall across
 * several entries. Exact-category matches are assigned first, so a
 * fragment-only cross-match (e.g. a reordering finding whose quotes happen to
 * contain another seed's option text) never takes credit that belongs to — or
 * substitutes for — the finding that actually detected the defect.
 *
 * falsePositives is derived from the SAME assignment (unassigned = false
 * positive), not recomputed independently. This reconciles a duplicate finding
 * that hits an already-credited seeded error: it neither earns recall (its
 * entry is already consumed) nor escapes the count (it is a redundant, unmatched
 * report), so it is correctly charged as a false positive — matching the
 * standard "each ground-truth item credits one retrieval; extras are FPs" rule.
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

  const caughtSets: Array<Set<ModelName>> = seeded.map(() => new Set<ModelName>());
  const falsePositives: Record<ModelName, number> = {
    deepseek: 0,
    claude: 0,
    workersai: 0,
    gemini: 0,
    grok: 0,
  };

  for (const model of MODELS) {
    const modelFindings = verified.filter((finding) => finding.model === model);
    const consumed = new Set<Finding>();

    const assign = (requireExactCategory: boolean): void => {
      for (let i = 0; i < seeded.length; i++) {
        const error = seeded[i];
        if (caughtSets[i].has(model)) continue;
        const match = modelFindings.find(
          (finding) =>
            !consumed.has(finding) &&
            (!requireExactCategory || finding.category === error.category) &&
            findingMatchesSeeded(finding, error),
        );
        if (match !== undefined) {
          consumed.add(match);
          caughtSets[i].add(model);
        }
      }
    };
    assign(true); // pass 1: exact-category matches claim their entries first
    assign(false); // pass 2: remaining entries may use fragment/loose matches

    // A verified finding that the assignment never consumed is a false positive:
    // it matched no still-unclaimed seeded error (either it matches none, or its
    // seeded error was already credited to a distinct finding — a redundant
    // duplicate). Deriving FP from `consumed` keeps it consistent with recall.
    falsePositives[model] = modelFindings.length - consumed.size;
  }

  const entries: ScorecardEntry[] = seeded.map((error, i) => ({
    errorId: error.id,
    questionId: error.questionId,
    category: error.category,
    note: error.note,
    caughtBy: MODELS.filter((model) => caughtSets[i].has(model)),
  }));

  const recall: Record<ModelName, number> = {
    deepseek: 0,
    claude: 0,
    workersai: 0,
    gemini: 0,
    grok: 0,
  };
  for (const model of MODELS) {
    const caught = entries.filter((entry) => entry.caughtBy.includes(model)).length;
    recall[model] = seeded.length > 0 ? caught / seeded.length : 0;
  }

  return { entries, recall, falsePositives };
}

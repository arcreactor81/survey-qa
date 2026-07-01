// Compare-prompt builder. Used identically by the in-Worker DeepSeek path
// (src/llm/deepseek.ts), the optional in-Worker Claude path (src/llm/claude.ts),
// and any local Claude runner, so both models judge the same instructions.

import { COMPARE_SCHEMA } from "./types";

const FINDING_SCHEMA = COMPARE_SCHEMA.properties.findings.items;
const CATEGORY_ENUM = FINDING_SCHEMA.properties.category.enum;
const SEVERITY_ENUM = FINDING_SCHEMA.properties.severity.enum;
const FIELD_LIST = FINDING_SCHEMA.required;

/**
 * Build the language-QA compare prompt for one rendered survey page.
 *
 * @param specText  Full questionnaire document text (the ground truth).
 * @param pageText  Rendered visible text of ONE survey page.
 * @param pageIndex 0-based page index (page number shown to the model is pageIndex + 1).
 */
export function buildComparePrompt(specText: string, pageText: string, pageIndex: number): string {
  const pageNumber = pageIndex + 1;

  return `You are a pharmaceutical market-research survey QA analyst. Your job is to perform LANGUAGE checks: compare the questionnaire document (the specification, i.e. the ground truth) against the rendered text of one page of the programmed survey website, and report every language discrepancy on that page.

Here is the FULL questionnaire document:

<questionnaire_document>
${specText}
</questionnaire_document>

Here is the rendered text of survey page ${pageNumber} (0-based page index ${pageIndex}):

<rendered_page page_number="${pageNumber}">
${pageText}
</rendered_page>

REPORT ONLY discrepancies between the questionnaire document and THIS page's rendered text. Check for:
- Typos and misspellings in question text, answer options, or instructions
- Missing answer options, extra answer options, or mislabeled answer options
- Wrong answer-option order — but ONLY when the document explicitly requires a specific order (e.g. a programmer note forbidding randomization); otherwise do not report order differences
- Broken or unresolved piping tokens (e.g. a literal token such as "{Q3brand}" or "[PIPE: ...]" rendered instead of the piped-in value)
- Wrong question numbering (the visible question number does not match the document)
- Encoding artifacts / mojibake (e.g. "â€™" appearing instead of an apostrophe)
- Duplicated words in question text, options, or instructions
- Missing instructions that the document specifies for a question on this page
- Missing questions that the document assigns to THIS page (page ${pageNumber})

Do NOT report:
- Styling, layout, or whitespace differences
- The presence of navigation buttons (e.g. "Next", "Previous", "Complete") or other survey chrome
- Questions that the document assigns to OTHER pages
- Anything that is not a language discrepancy on this specific page

Severity levels:
- "high" — meaning-changing issues: a missing answer option, broken/unresolved piping, a mislabeled scale point
- "medium" — wrong option labels, wrong question numbering, wrong or missing instructions
- "low" — typos and other cosmetic text issues

Quoting rules (strict):
- "siteQuote" MUST be a verbatim substring copied exactly from the rendered page text above — character for character.
- "specQuote" MUST be a verbatim substring copied exactly from the questionnaire document above — character for character.
- For absence-type findings (missing option, missing instruction, missing question), set "siteQuote" to "" and put the missing text from the document in "specQuote".

Respond with ONLY a JSON object of the form {"findings": [...]} — no prose, no markdown fences, nothing else.
Each finding object must contain exactly these fields: ${FIELD_LIST.join(", ")}.
- "questionId": the question identifier this finding relates to (e.g. "Q4"), or null if not attributable to one question
- "category": one of ${CATEGORY_ENUM.map((c) => `"${c}"`).join(", ")}
- "severity": one of ${SEVERITY_ENUM.map((s) => `"${s}"`).join(", ")}
- "description": one or two sentences describing the discrepancy
- "specQuote": verbatim quote from the questionnaire document
- "siteQuote": verbatim quote from the rendered page ("" for absence-type findings)

If this page has no issues, return {"findings": []}.`;
}

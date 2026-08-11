/**
 * THE DETERMINISTIC FLOOR EXPANDER + THE EXPANSION PREVIEW.
 *
 * A sealed requirement is not yet an execution case. This turns each requirement into the
 * mandatory cases the DOCUMENT enumerates — and refuses to invent the ones it does not.
 *
 * THE RULE THAT MATTERS (D10): the denominator may never be a function of what a run
 * observed. So a routing rule stated as an exclusion ("all codes except 6") yields ZERO
 * cases, and the preview says so in words, rather than materializing the answers a browser
 * happened to see. `worker-v2/tools/assembler/assemble-v2.mjs#facetInstancesFrom` is the
 * same expansion over the v1 compiler's typed expectations; this is that logic over the
 * typed `expansion` the extraction itself produced.
 *
 * THE PREVIEW is the evidence for the `allScopedExpansionsPreviewed` gate: EVERY live
 * requirement appears in it with the basis for its case count, including the ones that
 * expanded to nothing and why. A requirement absent from the preview means the gate cannot
 * pass — which is the honest reading of "no scoped expansion has been previewed".
 *
 * ==================== WHAT A TYPED CASE IS, AND WHAT IT IS NOT ====================
 *
 * `stages/verify-observations.ts` promotes an observation to `verified` through ONE route:
 * a closed predicate compares a TYPED EXPECTATION sealed in the revision against artifact
 * bytes it re-read. Its registry is keyed on `FacetCase.kind` and its predicates read
 * `routeAnswer` + `expectedDestination` (route), `boundaryInput` (boundary) and — since
 * 1.2.0 — `optionSet` (option-set, see `mintOptionSet` below). Everything else it can only
 * call `insufficient`.
 *
 * So this module has exactly one job beyond counting: for each case, either produce a
 * payload one of those predicates can decide, or SAY WHY NOT with a closed
 * `EXPECTATION_GAP` code. The third option — a payload that looks decidable and is not —
 * is the one this module used to take, and it is worse than either:
 *
 *   - a route destination was whatever string the model wrote. `"CONTINUE"`,
 *     `"Q2 then Q3"` and `"Q9"` all became `expectedDestination.questionId`, and the
 *     predicate token-matches that string against the reached screen. Two of those three
 *     can never match anything, so the case was unverifiable while presenting as typed,
 *     and NOTHING COUNTED IT. On the reference document that was 6 of 20 route cases.
 *   - a min/max SELECTION count became `boundaryInput.value` — "type 2 into the field".
 *     `BoundaryInputPayload.value` is documented as "the literal input to type", and a
 *     selection count is not one. On any numeric field that case can BOTH pass falsely
 *     (typing "1" is accepted) and manufacture a defect (typing "2" is accepted, so "the
 *     document requires this to be rejected; the survey accepted it"). That was 38 of 220
 *     cases on the reference document — the largest fabrication surface in the pipeline.
 *
 * A CASE THAT CANNOT BE CHECKED MUST SAY SO. It still enters the denominator, because the
 * document does enumerate it and D10 forbids a denominator that shrinks when we cannot
 * discharge it. It carries `expectationGap`, it is counted by code in `ExpansionCoverage`,
 * and the run reports that count. That number is the CEILING on what any verifier arm can
 * possibly verify, and every arm inherits it.
 *
 * ==================== THE ASSUMPTIONS, STATED (north star §"no silent reliance") =========
 *
 * A1. THE QUESTION-ID VOCABULARY IS THE DOCUMENT'S OWN. Destinations are bound against the
 *     ids the extraction itself produced from requirement scopes (`question:<id>`), never
 *     against a pattern like /^Q\d+$/. A document that numbers its questions "F1", "ItemA"
 *     or "第3問" binds exactly as well. DETECTED: a destination that matches nothing in
 *     that vocabulary is `ROUTE_DESTINATION_NOT_BOUND` and counted.
 * A2. A DESTINATION PHRASE NAMES ITS TARGET BY THE SAME IDENTIFIER USED ELSEWHERE. If the
 *     document says "go to the pricing block" and never calls that block by an id, nothing
 *     binds. DETECTED and counted, never guessed.
 * A3. RELATIVE DESTINATIONS ARE NOT RESOLVED. "CONTINUE", "the next question" and
 *     "immediately following" name a target only via document order, which this module
 *     does not model. Resolving them by taking the next row would be a guess dressed as a
 *     fact. DETECTED and counted.
 * A4. THE TERMINAL LEXICON IS ENGLISH AND ADVISORY. Classifying a destination as
 *     complete/screenout/quota uses English words. It is applied ONLY after question-id
 *     binding fails, and every terminal case is `ROUTE_DESTINATION_TERMINAL` regardless —
 *     no predicate decides it — so a mis-classification can change a LABEL and can never
 *     change an answer.
 * A5. TOKEN MATCHING IS THE VERIFIER'S OWN RULE. Binding uses the same whole-token test
 *     `verify-observations.ts#tokenOnScreen` uses, so "bound" implies "matchable by the
 *     predicate that will read it". A binder that was more generous than the matcher would
 *     mint expectations that are unreachable by construction.
 * A6. NOT DETECTED, DECLARED: an answer stated as an EXCLUSION that the extraction wrote
 *     into a route answer anyway (code `"NOT 2"`, label "Any answer except code 2") is not
 *     recognised here. Detecting it lexically would be an English-language rule, and the
 *     failure is safe — the walk never selects such an answer, so the verifier returns
 *     `ROUTE_ANSWER_NOT_SELECTED`, never a pass. It costs yield, not truth. 1 of 20 route
 *     answers on the reference document. Closing it belongs in extraction, not here.
 */

import { sha256Hex } from "../store/hash";
import {
  constrainsMatching,
  EXPECTATION_GAP,
  OPTION_SET_CLOSURE_ASSESSMENT,
  type DocumentedOption,
  type ExpectationGap,
  type ExpectationGapCode,
  type ExpectedDestinationPayload,
  type FacetCase,
  type FacetInstance,
  type OptionSetPayload,
  type ScopedRequirement,
} from "../types/record";
import type { RawExpansion, RawRequirement } from "./types";
import { isNonAnswerOptionSourceRole } from "./source-role";

/**
 * The expander consumes a sealed-shape requirement plus document-stated expansion hints.
 * Extraction and human authorship are producers of that input; neither producer's private
 * pass bookkeeping belongs at this seam.
 */
export interface ExpandableRequirementRow {
  requirement: ScopedRequirement;
  expansion: RawExpansion | null;
}

/** Backwards-compatible producer shape used by merge-focused tests and older callers. */
type ExpansionInputRow =
  | ExpandableRequirementRow
  | { requirement: ScopedRequirement; raw: RawRequirement[] };

const expansionOf = (row: ExpansionInputRow): RawExpansion | null =>
  "expansion" in row ? row.expansion : row.raw.find((raw) => raw.expansion !== null)?.expansion ?? null;

/**
 * 1.3.0 — assertion status became load-bearing at expansion: `document-silent`, `ambiguous`,
 * and `disputed` rows remain previewed requirements but mint zero pass/fail cases. A revision
 * expanded before this change is not safely reusable because it may carry verdict cases for a
 * proposition the document did not settle.
 */

/**
 * 1.2.0 — `option-set` rows mint a sealed OPTION MEMBERSHIP payload (see `mintOptionSet`), so
 * the option-set kind is decidable for the first time. THE CASE COUNT IS UNCHANGED: an option
 * row expanded to exactly one case before and expands to exactly one case now, minted or
 * refused. What moved is whether that case carries an expectation, which is exactly what the
 * version in the CONTRACT REUSE KEY exists to invalidate — a revision sealed by 1.1.0 carries
 * `optionSet: null` on every case and would go silently undecided under this build.
 */
/**
 * 1.4.0 makes parser-origin roles load-bearing: open combo-box suggestions and ruby
 * readings remain counted source material but can no longer mint option-set payloads or
 * corroborate another option through the sibling inventory.
 */
/**
 * 1.5.0 — full-line accounting on the option quote, and sibling gates.
 */
/**
 * 1.8.0 — option authority is positive and entailed-only. An explicit-negative option row
 * cannot enter `OptionSetPayload.asserted` or sibling corroboration until a polarity-bearing
 * predicate exists. A quote with an unread line now carries a gap and NO option payload: the
 * previous payload+gap shape was simultaneously executable and counted untyped, contradicting
 * `FacetInstance.expectationGap` and allowing a verifier verdict from a gap. Unicode letters
 * and numbers are labels; bracketed or symbol-only lines whose role is not structurally known
 * are unread material, never silently discarded as English-shaped "punctuation" or "markers".
 * Semicolons without delimiter provenance and distinct duplicate-label occurrences likewise
 * refuse instead of being split/collapsed. Every minted payload carries computed closure
 * coverage, separating safe membership from a closure claim this compiler did not evaluate.
 */
export const EXPANDER_VERSION = "v2-floor-expander/1.8.0";

/**
 * The producer's own classification of a requirement facet. It decides which requirements
 * get a `route` execution case SEALED into the revision at all.
 *
 * EXPORTED because the judge has to agree with it. `pipeline/judge/lib/facet-vocab.mjs`
 * carries the same route equivalence class on the judging side (the judge cannot import TS),
 * and `tools/tests/d26-routing-facet.test.mjs` asserts the two are set-EQUAL. Widening the
 * route class here — `navigation` and `order` are in the pass-A prompt vocabulary and are
 * deliberately absent below — turns that test red, which is the point: the judge must never
 * compile a route expectation for a facet whose sealed case is not a route.
 */
export const FACET_TO_CASE_KIND: Record<string, FacetCase["kind"]> = {
  "skip-rule": "route",
  "branch-outcome": "route",
  routing: "route",
  terminate: "route",
  "option-list": "option-set",
  "option-set": "option-set",
  copy: "copy",
  question: "rendered-state",
  instruction: "rendered-state",
  validation: "boundary",
};

/**
 * The kinds a registered predicate in `verify-observations.ts#PREDICATE_FOR_KIND` can
 * decide at all. A kind absent from here can never be typed, however good the payload —
 * which is a STRUCTURAL gap, not an extraction one, and is reported as such.
 */
const KINDS_WITH_A_PREDICATE = new Set<FacetCase["kind"]>(["route", "boundary", "option-set"]);

/**
 * EXPORTED SO THE REGISTRY AND THIS SET CAN BE PROVED EQUAL. The comment above says these two
 * can come to disagree after someone adds a predicate; `tools/tests/d45-option-set.test.mjs`
 * asserts set-EQUALITY against `verify-observations.ts#PREDICATE_FOR_KIND`, so "someone adds a
 * predicate and forgets this" turns the suite red instead of reporting cases as typed that no
 * predicate can reach (or as gapped when one can).
 */
export const kindsWithAPredicate = (): string[] => [...KINDS_WITH_A_PREDICATE].sort();

const emptyCase = (kind: FacetCase["kind"]): FacetCase => ({
  kind,
  routeAnswer: null,
  boundaryInput: null,
  configuration: null,
  expectedDestination: null,
  optionSet: null,
});

const gap = (code: ExpectationGapCode, detail: string): ExpectationGap => ({ code, detail });

/** One materialized case, with the reason it cannot be decided when it cannot. */
interface DraftCase {
  case: FacetCase;
  expectationGap: ExpectationGap | null;
}

// ---------------------------------------------------------------------------
// Destination binding
// ---------------------------------------------------------------------------

/** Normalization shared with the verifier's matcher (A5). */
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Whole-token containment — `verify-observations.ts#tokenOnScreen`'s rule, verbatim. */
function mentions(phrase: string, token: string): boolean {
  const t = norm(token).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!t) return false;
  return new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`).test(norm(phrase));
}

/**
 * ENGLISH, ADVISORY, AND LOAD-BEARING FOR NOTHING (A4). Applied only when no question id
 * binds, and the case is `ROUTE_DESTINATION_TERMINAL` either way.
 */
function terminalOf(dest: string): ExpectedDestinationPayload["terminal"] {
  if (/screen-?out/i.test(dest)) return "screenout";
  if (/quota/i.test(dest)) return "quota";
  if (/complete|end of|finish|thank/i.test(dest)) return "complete";
  return null;
}

/**
 * THE DOCUMENT'S OWN QUESTION IDS, from the scopes the extraction produced (A1).
 *
 * This is the same set `verify-observations.ts` derives from the sealed revision's
 * `targetQuestionId`s, which is what makes "bound here" and "recognised there" the same
 * predicate over the same vocabulary.
 */
function questionVocabulary(rows: ExpansionInputRow[]): Map<string, string> {
  const byNorm = new Map<string, string>();
  for (const row of rows) {
    const q = questionOf(row.requirement);
    if (q && !byNorm.has(norm(q))) byNorm.set(norm(q), q);
  }
  return byNorm;
}

export interface DestinationBinding {
  destination: ExpectedDestinationPayload | null;
  expectationGap: ExpectationGap | null;
}

/**
 * BIND A DESTINATION PHRASE TO A QUESTION THE DOCUMENT NAMES, OR REFUSE.
 *
 * There is no arm that produces a destination out of a phrase that named none. That is
 * the whole point: a guessed destination is an expectation the document never stated, and
 * the predicate downstream would certify or refute it with exactly the same confidence it
 * brings to a real one.
 */
export function bindDestination(raw: string | null, vocabulary: Map<string, string>): DestinationBinding {
  const phrase = (raw ?? "").trim();
  if (!phrase) {
    return {
      destination: null,
      expectationGap: gap(
        EXPECTATION_GAP.ROUTE_DESTINATION_NOT_STATED,
        "the document enumerates this answer but binds no destination to it, so there is nothing to check a walk against",
      ),
    };
  }

  // (1) The destination IS a question the document names.
  const exact = vocabulary.get(norm(phrase));
  if (exact) return { destination: { questionId: exact, screen: null, terminal: null }, expectationGap: null };

  // (2) The phrase NAMES exactly one such question (A2). Two is a compound destination
  // ("Q2 then Q3") and picking one of them is picking, not reading.
  //
  // Single-character ids are excluded from phrase matching: a document with a question
  // literally called "A" would otherwise bind "go to a new section" to it. An exact match
  // on "A" still binds, because that phrase names the question and nothing else.
  const named = [
    ...new Set(
      [...vocabulary.entries()]
        .filter(([key, id]) => id.length > 1 && mentions(phrase, key))
        .map(([, id]) => id),
    ),
  ];
  if (named.length === 1) {
    return { destination: { questionId: named[0]!, screen: null, terminal: null }, expectationGap: null };
  }
  if (named.length > 1) {
    return {
      destination: null,
      expectationGap: gap(
        EXPECTATION_GAP.ROUTE_DESTINATION_NOT_BOUND,
        `the destination ${JSON.stringify(phrase)} names ${named.length} questions the document knows ` +
          `(${named.join(", ")}); a compound destination has no single screen to land on, and choosing one ` +
          `of them would be choosing rather than reading`,
      ),
    };
  }

  // (3) A terminal state (A4). Typed for the report; still undecidable by any predicate.
  const terminal = terminalOf(phrase);
  if (terminal) {
    return {
      destination: { questionId: null, screen: null, terminal },
      expectationGap: gap(
        EXPECTATION_GAP.ROUTE_DESTINATION_TERMINAL,
        `the destination ${JSON.stringify(phrase)} reads as the terminal state "${terminal}", which no model-free ` +
          `predicate can tell apart from the other terminal states`,
      ),
    };
  }

  // (4) Nothing bound (A3).
  return {
    destination: null,
    expectationGap: gap(
      EXPECTATION_GAP.ROUTE_DESTINATION_NOT_BOUND,
      `the destination ${JSON.stringify(phrase)} matches no question this document names and reads as no terminal ` +
        `state. It is most likely relative ("continue", "the next question"), which names a target only through ` +
        `document order — resolving it by taking the next row would be a guess presented as a fact`,
    ),
  };
}

// ---------------------------------------------------------------------------
// Option sets — the document's answer options, read from the document's own quote
// ---------------------------------------------------------------------------

/**
 * ============ HOW AN OPTION EXPECTATION IS MINTED, AND WHAT IT REFUSES ============
 *
 * THE SHAPE OF THE INPUT, MEASURED ON THREE REAL SEALED REVISIONS rather than assumed. An
 * option requirement is a sentence plus a verbatim document span:
 *
 *   S: "Q3 offers 'NURTEC' as an answer option."                    Q: "[#] NURTEC"
 *   S: "S3 includes the response option 'Advertising or public
 *       relations' with code 3."                                    Q: "3) Advertising or public relations"
 *   S: "Q2 includes option 1: 'Yes, a daily oral preventive'."      Q: "(list) 1) Yes, a daily oral preventive"
 *   S: "Q3 offers exactly the following five answer options, and
 *       no others: KEYTRUDA, OPDIVO, TECENTRIQ, IMFINZI, LIBTAYO."  Q: "KEYTRUDA\nOPDIVO\n…"
 *
 * A5' — THE LABEL BYTES COME FROM THE QUOTE, NOT FROM THE SENTENCE. The sentence is a model's
 * prose about the document; the quote is the document. Parsing the sentence would seal
 * whatever the model wrote, and a paraphrased label ("25-34" for "25 to 34") compared against
 * a screen is a fabricated defect with a document-shaped justification in front of it. So the
 * options are read from `displayQuote` and the sentence is used only to CORROBORATE them.
 *
 * A6' — CORROBORATION IS TWO-WAY AND IT REFUSES, NEVER REPAIRS. A label the quote carries must
 * also appear in the statement (normalized containment). When the two readings of one row
 * disagree, nothing is minted: `OPTION_LABEL_NOT_CORROBORATED_BY_THE_STATEMENT`.
 *
 * A7' — SCOPE IS THE ONLY BINDER. `scope: "question:<id>"` says which question the options
 * belong to. A row scoped to the SURVEY is refused outright
 * (`OPTION_SET_NOT_BOUND_TO_A_QUESTION`) — see that code's entry for the measurement — and a
 * row whose sentence names a DIFFERENT question the document knows is refused as ambiguous.
 * There is no proximity rule, no carry-forward from the previous row, and no "last question
 * mentioned" fallback. `plan-core.js#mineOptions` HAS one of those (`lastQ`), which is fine
 * for choosing what to click and is not fine for minting a verdict.
 *
 * A8' — ORDER IS NEVER SEALED, AND THAT IS A DECISION ABOUT SURVEYS, NOT A SHORTCUT. Documents
 * routinely permit or require rotation ("Present options in the exact order listed above. Do
 * not randomize." is itself an option row in one of these revisions, and `s1-skip`'s and
 * `s4-nested-rotation`'s manifests carry rotation semantics), and the capture's `order` is DOM
 * order, which a stylesheet is free to disagree with. A site that randomises where the
 * document permits it must not be accused, so no order claim is minted and the order rows
 * refuse like any other row whose quote yields no options.
 */

/** Internal list bullets whose structure is known, plus a bracket-shaped suffix we must NOT guess about. */
const OPTION_LINE_NOISE = /^(?:\[b\d+\]\s*)?(?:\(list\)\s*)?(?:\[#\]\s*)?/i;
const TRAILING_MARKER = /\s*\[[A-Z][A-Z0-9 ,;:'\/-]{1,}\]\s*$/;

/** `3) Label`, `3. Label`, `3 - Label`, `3: Label` — the code the DOCUMENT printed. */
const CODED_OPTION = /^(\d{1,3})\s*[).:\-]\s+(.+)$/;

/**
 * More than one sentence is prose-shaped in every script, not only after ASCII `.?!`.
 * The no-space branch is limited to a following LETTER so `3.5` remains a label while
 * Japanese `一文。次文。` and Arabic `جملة؟جملة` are still recognized as multi-sentence.
 */
const MULTI_SENTENCE_LINE = /\p{Sentence_Terminal}(?:\s+\S|(?=\p{L}))/u;

const NUMBER_WORD: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/**
 * SPLIT A DOCUMENT QUOTE INTO THE OPTION LINES IT CARRIES.
 *
 * Newlines and the repository-owned `[bNNN]` / `(list)` tokens are structural separators. A
 * semicolon is NOT: it can separate flattened blocks or occur inside one respondent-visible
 * label, and `displayQuote` carries no delimiter provenance. It therefore stays on the line
 * for `parseDocumentedOptionsAccounted` to report as unread rather than being guessed apart.
 */
function optionLinesOf(quote: string): string[] {
  const flattened = quote.replace(/\s*\[b\d+\]\s*/gi, "\n").replace(/\s*\(list\)\s*/gi, "\n");
  return flattened
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `parseDocumentedOptionsAccounted`'s result: the options read, plus the lines it could not read. */
export interface ParsedDocumentedOptions {
  options: DocumentedOption[];
  /**
   * 1.8.0 — CANDIDATE OPTION LINES THE PARSER COULD NOT CLASSIFY SAFELY: a line killed by the
   * prose/two-sentence guard, the trailing-colon header guard, or the length cap, plus a pure
   * bracketed or symbol-only line whose role is not carried by structural source metadata.
   * Every one can be a real option on an unknown questionnaire ("Other (please specify):",
   * "[None]", "★"), so none may disappear as an English-shaped programmer convention.
   * A semicolon whose delimiter role is unknown and a normalized duplicate carried by a
   * DISTINCT code/source occurrence are included too. Empty text after stripping an internal
   * join/bullet token and an exact duplicate of the same semantic occurrence remain
   * definitional skips; they add no distinct label bytes to the document inventory.
   * The count is load-bearing: `mintOptionSet` refuses the whole option payload when any
   * candidate line could not be read. The current schema cannot represent safe membership
   * and an unread closure obligation separately, and the dropped line may itself be an option
   * the site legitimately offers.
   */
  unparsedLines: string[];
}

/**
 * READ THE OPTIONS OUT OF A DOCUMENT QUOTE. Never a guess: a line this cannot read is DROPPED
 * and the caller refuses when nothing is left, rather than inventing a label from the prose.
 * Since 1.5.0 the drop is ACCOUNTED, not silent — see `ParsedDocumentedOptions.unparsedLines`.
 */
export function parseDocumentedOptionsAccounted(quote: string): ParsedDocumentedOptions {
  const out: DocumentedOption[] = [];
  const unparsedLines: string[] = [];
  const seen = new Map<string, { code: string | null; line: string }>();
  for (const raw of optionLinesOf(String(quote ?? ""))) {
    // These leading tokens are emitted by this repository's own block/list joiner, so their
    // structural role is known. Arbitrary bracketed DOCUMENT text is not: `[ROTATE]` may be an
    // instruction, while `[None]` may be the respondent-visible label. Syntax alone cannot
    // choose, so a pure bracketed document line is counted unread and blocks a closure claim.
    const sourceText = raw.replace(OPTION_LINE_NOISE, "").trim();
    if (!sourceText) continue;
    // `;` is both ordinary label punctuation and a legacy flattening separator. Without the
    // source block boundary there is no safe reading, so neither splitting nor preserving it
    // as one label can acquire verdict authority.
    if (sourceText.includes(";")) {
      unparsedLines.push(sourceText);
      continue;
    }
    if (/^\[.*\]$/u.test(sourceText)) {
      unparsedLines.push(sourceText);
      continue;
    }
    // A suffix like `[EXCLUSIVE]` is often a programmer annotation, but `[NONE]` or `[A]` can
    // also be respondent-visible label text. The display quote has no per-suffix role, so the
    // old unconditional strip was another silent convention. Count the whole line unread; a
    // future source adapter may remove/role-tag annotations only when its source proves that.
    if (TRAILING_MARKER.test(sourceText)) {
      unparsedLines.push(sourceText);
      continue;
    }
    const line = sourceText;
    // AN ANSWER OPTION IS A PHRASE, NOT PROSE, and this is the guard that keeps a sentence out
    // of the seal. A quote like "PROGRAMMER NOTE: Present options in the exact order listed
    // above. Do not randomize." is one line with letters in it, and without this it becomes a
    // sealed "option label" the predicate then hunts for on a screen — where it is of course
    // absent, which is a FABRICATED missing-option claim with a document quote in front of it.
    // Two shapes, both structural rather than lexical: more than one sentence, or a header
    // ending in a colon.
    // NFKC makes compatibility-equivalent colons (`：`, `﹕`) visible to the same structural
    // header guard without translating or otherwise normalizing the label bytes we preserve.
    if (MULTI_SENTENCE_LINE.test(line) || line.normalize("NFKC").endsWith(":")) {
      unparsedLines.push(line);
      continue;
    }
    const coded = CODED_OPTION.exec(line);
    const code = coded ? coded[1]! : null;
    const label = (coded ? coded[2]! : line).trim();
    if (!label) continue;
    // Unicode letters/numbers are ordinary label material. A non-empty symbol-only line may
    // ALSO be a real answer (`★`, `✓`, emoji), but this payload has no source-role evidence
    // that can distinguish it from a separator. Refuse it visibly instead of silently
    // shortening a closed set. `/[a-z0-9]/` would misclassify every non-Latin questionnaire.
    if (!/[\p{L}\p{N}]/u.test(label)) {
      unparsedLines.push(line);
      continue;
    }
    // One this long is a paragraph, not an answer option, and comparing it to a rendered
    // option would never match anything — but the cap is a heuristic, and the line WAS in the
    // quote, so its loss is recorded and blocks a closure claim like the prose guard's does.
    if (label.length > 160) {
      unparsedLines.push(line);
      continue;
    }
    const key = norm(label);
    const previous = seen.get(key);
    if (previous) {
      // An exact repeated semantic occurrence is idempotent stitching. A different code or
      // source line under the same normalized label may be two distinct answer choices; this
      // payload has no multiplicity semantics, so collapsing them would silently shorten it.
      if (previous.code !== code || previous.line !== line) unparsedLines.push(line);
      continue;
    }
    seen.set(key, { code, line });
    out.push({ code, label });
  }
  return { options: out, unparsedLines };
}

/** The options alone, for callers that read membership material and never seal a closure claim. */
export function parseDocumentedOptions(quote: string): DocumentedOption[] {
  return parseDocumentedOptionsAccounted(quote).options;
}

/** Does the requirement's own sentence carry this label? Normalized containment, both ways round. */
const statementCorroborates = (statement: string, label: string): boolean =>
  norm(statement).includes(norm(label));

/**
 * DOES THE REQUIREMENT CLOSE THE SET IN ITS OWN WORDS, AND DOES THE QUOTE BEAR THAT OUT?
 *
 * Both halves are required. "exactly the following four response options: …" whose quote
 * yields ONE line is a requirement that states a set and a quote that captured a fragment of
 * it, and treating that as closed would accuse a site of offering three options the document
 * lists. So a stated count must EQUAL the number of options read, and a closure phrase with no
 * count needs at least two.
 */
function assessClosedSet(
  r: ScopedRequirement,
  parsed: number,
  asserted: number,
): { exhaustive: boolean; assessment: OptionSetPayload["closureAssessment"] } {
  const s = norm(r.normativeStatement);
  const closed = /\b(?:exactly|and no others?|no other (?:answer |response )?options?|only the following)\b/.test(s);
  if (!closed) {
    return {
      exhaustive: false,
      assessment: {
        status: "not-evaluated",
        code: OPTION_SET_CLOSURE_ASSESSMENT.NOT_EVALUATED,
        detail:
          `positive membership is typed, but no language-neutral closed-set proof is present in this payload ` +
          `(requirement quantifier ${JSON.stringify(r.quantifier)}). The current lexical recognizer did not ` +
          `establish “these and no others”; exhaustive is therefore false and extra-option coverage was NOT evaluated`,
      },
    };
  }
  const stated = /\b(?:exactly|following)\s+(?:the\s+following\s+)?(\d{1,2}|[a-z]+)\s+(?:answer|response|scale)?\s*options?\b/.exec(s);
  const token = stated?.[1] ?? null;
  const n = token === null ? null : /^\d+$/.test(token) ? Number(token) : (NUMBER_WORD[token] ?? null);
  const countAgrees = n === null ? stated === null : n === parsed;
  if (parsed < 2 || asserted !== parsed || !countAgrees) {
    return {
      exhaustive: false,
      assessment: {
        status: "not-established",
        code: OPTION_SET_CLOSURE_ASSESSMENT.EVIDENCE_INCOMPLETE,
        detail:
          `the requirement carries a closed-set phrase, but closure evidence is incomplete: parsed=${parsed}, ` +
          `corroborated=${asserted}, statedCount=${n ?? "not established"}. Exhaustive remains false, so no ` +
          `extra-option verdict can be minted`,
      },
    };
  }
  return {
    exhaustive: true,
    assessment: {
      status: "established",
      code: OPTION_SET_CLOSURE_ASSESSMENT.ESTABLISHED,
      detail:
        `the requirement closes the set in its own words and all ${parsed} parsed option(s) are corroborated` +
        (n === null ? "" : `; its stated count is ${n}`),
    },
  };
}

export interface OptionSetBinding {
  optionSet: OptionSetPayload | null;
  expectationGap: ExpectationGap | null;
}

const nonAnswerOptionSourceRoles = (r: ScopedRequirement): string[] =>
  [...new Set((r.sourceAtoms ?? []).map((atom) => atom.role).filter(isNonAnswerOptionSourceRole))].sort();

/**
 * DOES THE ROW'S STATEMENT NAME ANOTHER QUESTION THE DOCUMENT KNOWS? Shared by
 * `mintOptionSet`'s OPTION_SET_QUESTION_AMBIGUOUS refusal and the sibling inventory in
 * `expandFloor` (1.5.0), so the two cannot drift: a row refused as question-ambiguous must
 * not corroborate a sibling either — its options may belong to the OTHER question.
 */
const namesAnotherQuestion = (r: ScopedRequirement, questionId: string, vocabulary: Map<string, string>): string[] =>
  [...vocabulary.entries()]
    .filter(([key, id]) => id.length > 1 && id !== questionId && mentions(r.normativeStatement, key))
    .map(([, id]) => id);

/**
 * MINT THE SEALED OPTION EXPECTATION FOR ONE ROW, OR SAY WHY NOT.
 *
 * `siblings` are the options OTHER rows state for the SAME question, already parsed and
 * corroborated by this same function's rules. They carry no claim of their own; a predicate
 * uses them to establish that the site's answer CODES are commensurable with the document's
 * before it compares anything keyed on a code.
 */
export function mintOptionSet(
  r: ScopedRequirement,
  vocabulary: Map<string, string>,
  siblingsFor: (questionId: string, exclude: ScopedRequirement) => DocumentedOption[],
): OptionSetBinding {
  // `OptionSetPayload.asserted` means "the survey must offer this". An explicit-negative row
  // means the opposite and cannot be represented by that payload without inverting the
  // document. Keep a counted case, but no executable expectation, until a typed negative
  // option predicate exists. Other non-entailed statuses are withheld before this function.
  if (r.assertionStatus === "explicit-negative") {
    return {
      optionSet: null,
      expectationGap: gap(
        EXPECTATION_GAP.OPTION_SET_NEGATIVE_PREDICATE_NOT_AVAILABLE,
        `the document explicitly states a negative option proposition (${JSON.stringify(r.normativeStatement)}), ` +
          `but the current option-set payload and predicate represent required positive membership only. Treating ` +
          `this label as asserted would accuse a compliant survey of missing an option the document forbids`,
      ),
    };
  }

  const refusedRoles = nonAnswerOptionSourceRoles(r);
  if (refusedRoles.length > 0) {
    return {
      optionSet: null,
      expectationGap: gap(
        EXPECTATION_GAP.OPTION_SET_SOURCE_NOT_AN_ANSWER_LIST,
        `the requirement cites parser-labelled source role(s) ${refusedRoles.map((role) => JSON.stringify(role)).join(", ")}. ` +
          `An open combo-box suggestion does not close the accepted answer vocabulary, and a ruby reading is a ` +
          `visible phonetic annotation rather than an answer. The source remains in the denominator, but the ` +
          `answer-option predicate may not reinterpret it`,
      ),
    };
  }

  const questionId = questionOf(r);
  if (!questionId) {
    return {
      optionSet: null,
      expectationGap: gap(
        EXPECTATION_GAP.OPTION_SET_NOT_BOUND_TO_A_QUESTION,
        `the requirement states answer options under scope ${JSON.stringify(r.scope)}, which names no question. ` +
          `Attaching them to the nearest question in document order is how an option list for one question comes ` +
          `to be checked against another's screen, and the answer would look exactly as confident either way`,
      ),
    };
  }

  // The statement names ANOTHER question this document knows. Which question's options these
  // are has two readings, and no predicate may pick one.
  const named = namesAnotherQuestion(r, questionId, vocabulary);
  if (named.length > 0) {
    return {
      optionSet: null,
      expectationGap: gap(
        EXPECTATION_GAP.OPTION_SET_QUESTION_AMBIGUOUS,
        `the requirement is scoped to ${questionId} but its statement also names ${[...new Set(named)].join(", ")}; ` +
          `an option set compared against the wrong question's screen accuses a survey that is behaving as documented`,
      ),
    };
  }

  const { options: parsed, unparsedLines } = parseDocumentedOptionsAccounted(r.displayQuote ?? "");

  // FULL-LINE ACCOUNTING (1.7.0). Check this BEFORE `parsed.length`: an all-unread quote is
  // still a known parser limitation and must retain its unread-line count, not collapse into
  // the less specific "nothing read" bucket. A case-level `expectationGap` means no registered
  // predicate can decide the case, so it cannot coexist with a positive membership payload.
  if (unparsedLines.length > 0) {
    return {
      optionSet: null,
      expectationGap: gap(
        EXPECTATION_GAP.OPTION_SET_QUOTE_LINE_UNPARSED,
        `${unparsedLines.length} line(s) of this requirement's document quote could not be read as answer ` +
          `options (${unparsedLines.map((l) => JSON.stringify(l.slice(0, 80))).join(", ")}). Although ${parsed.length} ` +
          `option(s) were readable, this case carries no option-set expectation: the current contract cannot ` +
          `represent checked membership and an unchecked closure claim as separate obligations`,
      ),
    };
  }

  if (parsed.length === 0) {
    return {
      optionSet: null,
      expectationGap: gap(
        EXPECTATION_GAP.OPTION_SET_NOT_READ_FROM_THE_DOCUMENT_QUOTE,
        `no answer option could be read from this requirement's document quote ` +
          `(${JSON.stringify((r.displayQuote ?? "").slice(0, 120))}). The labels exist only inside the model's own ` +
          `sentence, and sealing prose as though it were the document is how a paraphrased option becomes a defect claim`,
      ),
    };
  }

  const asserted = parsed.filter((o) => statementCorroborates(r.normativeStatement, o.label));
  if (asserted.length === 0) {
    return {
      optionSet: null,
      expectationGap: gap(
        EXPECTATION_GAP.OPTION_LABEL_NOT_CORROBORATED_BY_THE_STATEMENT,
        `the document quote yields ${parsed.length} option label(s) ` +
          `(${parsed.map((o) => JSON.stringify(o.label)).join(", ")}) and the requirement's own statement contains ` +
          `none of them, so the two readings of this row disagree about what the document says`,
      ),
    };
  }

  const closure = assessClosedSet(r, parsed.length, asserted.length);
  return {
    optionSet: {
      asserted,
      siblings: siblingsFor(questionId, r),
      // The closure claim is taken over what was PARSED, not over what survived corroboration:
      // a set is closed by the document's words, and dropping an uncorroborated line must not
      // make the remainder look complete. The full-line guard above means this point is
      // reachable only when every candidate quote line was accounted for.
      exhaustive: closure.exhaustive,
      closureAssessment: closure.assessment,
    },
    expectationGap: null,
  };
}

// ---------------------------------------------------------------------------
// Coverage — the ceiling, computed
// ---------------------------------------------------------------------------

export interface ExpansionPreviewEntry {
  requirementLineageId: string;
  statement: string;
  scope: string;
  quantifier: string;
  caseCount: number;
  /** Cases a registered predicate can decide from the seal alone. */
  typedCaseCount: number;
  /** Gap codes this requirement's cases carry, with counts. */
  gaps: Record<string, number>;
  basis: string;
}

/**
 * WHAT ANY ARM CAN POSSIBLY VERIFY, BEFORE A SINGLE BROWSER STARTS.
 *
 * Reported per run because it is a headline result in its own right: an arm that verifies
 * 30 of 220 cases against a ceiling of 30 has done everything available to it, and an arm
 * that verifies 30 against a ceiling of 180 has not. Without the ceiling both read the same.
 */
export interface ExpansionCoverage {
  requirements: number;
  /** Requirements that expanded to zero cases (not browser-observable, or not enumerated). */
  requirementsWithNoCase: number;
  cases: number;
  typedCases: number;
  untypedCases: number;
  /** Gap code -> case count. Sums to `untypedCases`. */
  byGap: Record<string, number>;
  /** Case kind -> { cases, typed }. */
  byKind: Record<string, { cases: number; typed: number }>;
  /** Computed coverage of the separate closed-set / extra-option claim. */
  optionSetClosure: {
    cases: number;
    payloadCases: number;
    established: number;
    notEstablished: number;
    notEvaluated: number;
    unavailableBecauseCaseUntyped: number;
    byCode: Record<string, number>;
  };
}

export interface ExpansionOutput {
  facetInstances: FacetInstance[];
  preview: ExpansionPreviewEntry[];
  /** Requirements the expander could not preview at all. Blocks the gate when non-empty. */
  unpreviewed: string[];
  coverage: ExpansionCoverage;
}

export async function expandFloor(
  rows: ExpansionInputRow[],
  configuration: { locale: string; viewport: string | null },
): Promise<ExpansionOutput> {
  const facetInstances: FacetInstance[] = [];
  const preview: ExpansionPreviewEntry[] = [];
  const unpreviewed: string[] = [];
  const vocabulary = questionVocabulary(rows);

  // THE DOCUMENT'S OWN OPTION LINES, PER QUESTION, BUILT ONCE. Corroboration material for the
  // option predicate and nothing else — see `OptionSetPayload.siblings`. It is derived by the
  // SAME parse+corroborate rules a minted assertion goes through, so a sibling can never be
  // something this expander would have refused to seal as an assertion.
  const optionsByQuestion = new Map<string, Array<{ from: string; option: DocumentedOption }>>();
  for (const row of rows) {
    const r = row.requirement;
    if (FACET_TO_CASE_KIND[r.facet] !== "option-set") continue;
    // Positive option authority is ENTAILED-ONLY. `explicit-negative` constrains matching in
    // the abstract contract, but this payload has no polarity and represents only options the
    // survey MUST offer. Letting a forbidden label into `siblings` can mask a forbidden extra
    // or license a code-keyed accusation; disputed/ambiguous/document-silent rows likewise
    // carry no positive authority.
    if (r.assertionStatus !== "entailed") continue;
    // A source unsafe as an assertion is equally unsafe as sibling corroboration, where it
    // could otherwise license a code-keyed label accusation in a different requirement.
    if (nonAnswerOptionSourceRoles(r).length > 0) continue;
    const q = questionOf(r);
    if (!q) continue;
    // 1.5.0 — a row `mintOptionSet` refuses as OPTION_SET_QUESTION_AMBIGUOUS has two readings
    // of which question owns its options; they may belong to the OTHER question, and must not
    // corroborate this one.
    if (namesAnotherQuestion(r, q, vocabulary).length > 0) continue;
    const { options, unparsedLines } = parseDocumentedOptionsAccounted(r.displayQuote ?? "");
    // The whole case is untyped when any candidate line was unread, so its surviving labels
    // cannot acquire verdict authority indirectly as another case's sibling evidence.
    if (unparsedLines.length > 0) continue;
    const held = optionsByQuestion.get(q) ?? [];
    for (const o of options) {
      if (statementCorroborates(r.normativeStatement, o.label)) held.push({ from: r.requirementVersionId, option: o });
    }
    optionsByQuestion.set(q, held);
  }
  const siblingsFor = (questionId: string, exclude: ScopedRequirement): DocumentedOption[] => {
    const seen = new Set<string>();
    const out: DocumentedOption[] = [];
    for (const { from, option } of optionsByQuestion.get(questionId) ?? []) {
      if (from === exclude.requirementVersionId) continue;
      const key = norm(option.label);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(option);
    }
    return out;
  };

  // THE PRECONDITION THIS EXPANDER HAS ALWAYS RELIED ON, NOW STATED.
  //
  // `facetInstanceId` is a hash of `requirementVersionId | index | certificate`, and the
  // certificate is itself a hash of the version id, the case and the gap. So the id is
  // unique across rows IF AND ONLY IF the version id is. On the first real run
  // (v2r_01kzf7ehb2sayx2y2xz4ecm1ed) it was not — a rating grid stated one mandate once per
  // row and two distinct requirements shared an identity — and this module minted two
  // byte-identical facet instances without noticing. Planning caught it at the far end of
  // the pipeline, which is the right place to REFUSE and the wrong place to first learn.
  //
  // Failing here instead names the defect where it can be acted on: the identity mint in
  // `merge.ts`, not the expansion. This is a precondition on the caller, not a fallback —
  // it does not deduplicate, because two rows sharing a version id is exactly the condition
  // under which we cannot tell whether they are one requirement or two.
  const seenVersionIds = new Set<string>();
  for (const row of rows) {
    const id = row.requirement.requirementVersionId;
    if (seenVersionIds.has(id)) {
      throw new Error(
        `expansion refused duplicate requirementVersionId ${id}: two merged rows carry one identity, so every ` +
          `facet instance minted from them would collide. The defect is in the identity mint (extract/merge.ts), ` +
          `not here`,
      );
    }
    seenVersionIds.add(id);
  }

  for (const row of rows) {
    const r: ScopedRequirement = row.requirement;
    const expansion = expansionOf(row);
    const drafts: DraftCase[] = [];
    let basis: string;

    if (!constrainsMatching(r.assertionStatus)) {
      // Assertion status is part of the authority boundary, not report decoration.
      // `document-silent`, `ambiguous`, and `disputed` rows are useful facts for a
      // reviewer, but none states a proposition the site can pass or fail. Keeping the
      // row in the preview preserves computed coverage while minting no denominator case.
      basis =
        `non-constraining assertion status ${JSON.stringify(r.assertionStatus)}: ` +
        "recorded and surfaced for review, expanded to zero pass/fail cases";
    } else if (expansion && expansion.kind === "route" && expansion.routeAnswers.length > 0) {
      for (const a of expansion.routeAnswers) {
        const bound = bindDestination(a.destination, vocabulary);
        drafts.push({
          case: {
            ...emptyCase("route"),
            routeAnswer: { code: a.code, label: a.label },
            expectedDestination: bound.destination,
          },
          expectationGap: bound.expectationGap,
        });
      }
      const boundCount = drafts.filter((d) => d.expectationGap === null).length;
      basis =
        `one case per answer the document enumerates (${expansion.routeAnswers.length}); ` +
        `${boundCount} destination(s) bound to a question this document names`;
    } else if (expansion && expansion.maxLength !== null) {
      const max = Math.min(expansion.maxLength, 512);
      // THE ACCEPTED ARM IS NOT ENTAILED. A length bound says how long an answer may be;
      // it does not say that `"x".repeat(max)` IS a valid answer. A numeric or pattern
      // field that refuses the filler for its CONTENT would be reported as violating a
      // rule it obeys, so the case is kept and the expectation is not.
      drafts.push({
        case: { ...emptyCase("boundary"), boundaryInput: { bound: "max", value: "x".repeat(max), expectedOutcome: "unspecified" } },
        expectationGap: gap(
          EXPECTATION_GAP.INPUT_CONTENT_NOT_STATED,
          `the document states a maximum length (${expansion.maxLength}) but never states that an arbitrary ` +
            `string of that length is an acceptable ANSWER, so "accepted" would be an expectation it does not make`,
        ),
      });
      drafts.push({
        case: {
          ...emptyCase("boundary"),
          boundaryInput: { bound: "above-max", value: "x".repeat(max + 1), expectedOutcome: "rejected" },
        },
        expectationGap: null,
      });
      basis =
        `a stated input bound enumerates exactly two cases: the largest permitted value and the first that is ` +
        `not (max_length=${expansion.maxLength}). Only the over-length case carries an expectation the document ` +
        `entails`;
    } else if (expansion && (expansion.minSelections !== null || expansion.maxSelections !== null)) {
      // A SELECTION COUNT IS NOT A LITERAL INPUT TO TYPE. See EXPECTATION_GAP's entry.
      // The case count is unchanged — the document enumerates these — but the payload no
      // longer claims a text input, because that claim is what could pass falsely.
      const why = (which: string, n: number) =>
        gap(
          EXPECTATION_GAP.SELECTION_BOUND_IS_NOT_A_TEXT_INPUT,
          `the document states a ${which} selection count of ${n}. Exercising it means selecting that many ` +
            `options, not typing a value, and there is no selection-count payload or predicate — writing the ` +
            `count into a text-input case would make "type ${n}" checkable against fields it has nothing to do with`,
        );
      if (expansion.minSelections !== null) {
        drafts.push({
          // `bound` is retained so the three cases of one requirement keep distinct
          // identities in the ledger; `value` and `expectedOutcome` are not, because a
          // text-input payload cannot state anything true about selecting options.
          case: {
            ...emptyCase("boundary"),
            boundaryInput: { bound: "below-min", value: null, expectedOutcome: "unspecified" },
          },
          expectationGap: why("minimum", expansion.minSelections),
        });
      }
      if (expansion.maxSelections !== null) {
        drafts.push({
          case: { ...emptyCase("boundary"), boundaryInput: { bound: "max", value: null, expectedOutcome: "unspecified" } },
          expectationGap: why("maximum", expansion.maxSelections),
        });
        drafts.push({
          case: {
            ...emptyCase("boundary"),
            boundaryInput: { bound: "above-max", value: null, expectedOutcome: "unspecified" },
          },
          expectationGap: why("maximum", expansion.maxSelections),
        });
      }
      basis =
        `a stated selection bound (min=${expansion.minSelections ?? "-"}, max=${expansion.maxSelections ?? "-"}); ` +
        `the count is enumerated, the expectation is not — a selection count is not a value to type`;
    } else if (r.testability === "not-browser-observable") {
      // A mandate a browser cannot observe gets NO execution case. Materializing one would
      // put a case in the denominator that no run could ever discharge.
      basis = "not browser-observable: recorded as a requirement, expanded to zero execution cases";
    } else if (expansion && expansion.kind === "route" && expansion.routeAnswers.length === 0) {
      basis =
        "a routing rule the document states by exclusion enumerates no case set; the count is NOT ESTABLISHED rather than inferred from a run";
    } else if (FACET_TO_CASE_KIND[r.facet] === "option-set") {
      // ONE CASE, EXACTLY AS BEFORE. This branch changes what the case CARRIES, never how many
      // there are: an option requirement expanded to one case under 1.1.0 and expands to one
      // case here, minted or refused. The denominator is pinned per document (D10) and a new
      // predicate is not allowed to move it.
      const bound = mintOptionSet(r, vocabulary, siblingsFor);
      drafts.push({
        case: {
          ...emptyCase("option-set"),
          configuration: { locale: configuration.locale, viewport: configuration.viewport, profileId: null },
          optionSet: bound.optionSet,
        },
        expectationGap: bound.expectationGap,
      });
      basis = bound.optionSet
        ? `one option-set case: the document states ${bound.optionSet.asserted.length} answer option(s) for this ` +
          `question, read from its own quote and corroborated by the requirement's statement` +
          (bound.optionSet.exhaustive
            ? ", and closes the set"
            : `; closure coverage: ${bound.optionSet.closureAssessment.code}`)
        : `one option-set case, carrying no expectation: ${bound.expectationGap?.code}`;
    } else {
      const kind = FACET_TO_CASE_KIND[r.facet] ?? "rendered-state";
      drafts.push({
        case: {
          ...emptyCase(kind),
          configuration: { locale: configuration.locale, viewport: configuration.viewport, profileId: null },
        },
        expectationGap: fallbackGap(kind, r.facet),
      });
      basis = `one ${kind} case: the document enumerates no variants, so the requirement is exercised once under the run configuration`;
    }

    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i]!;
      const c = d.case;
      const expectationGap = gapFor(d);
      const certificate = `xc_${(
        await sha256Hex(
          JSON.stringify({
            expander: EXPANDER_VERSION,
            requirementVersionId: r.requirementVersionId,
            case: c,
            expectationGap,
            index: i,
          }),
        )
      ).slice(0, 16)}`;
      facetInstances.push({
        facetInstanceId: `fi_${(await sha256Hex(`${r.requirementVersionId}|${i}|${certificate}`)).slice(0, 20)}`,
        requirementLineageId: r.requirementLineageId,
        requirementVersionId: r.requirementVersionId,
        caseVersionId: `cv_${(await sha256Hex(JSON.stringify(c))).slice(0, 20)}`,
        floorCase: true,
        targetQuestionId: questionOf(r),
        expansionCertificate: certificate,
        case: c,
        expectationGap,
        screen: null,
        label: labelFor(r, c, expectationGap),
      });
    }

    const gaps: Record<string, number> = {};
    let typed = 0;
    for (const d of drafts) {
      const g = gapFor(d);
      if (g) gaps[g.code] = (gaps[g.code] ?? 0) + 1;
      else typed += 1;
    }
    preview.push({
      requirementLineageId: r.requirementLineageId,
      statement: r.normativeStatement,
      scope: r.scope,
      quantifier: r.quantifier,
      caseCount: drafts.length,
      typedCaseCount: typed,
      gaps,
      basis,
    });
  }

  const previewed = new Set(preview.map((p) => p.requirementLineageId));
  for (const row of rows) {
    if (!previewed.has(row.requirement.requirementLineageId)) unpreviewed.push(row.requirement.requirementLineageId);
  }

  return { facetInstances, preview, unpreviewed, coverage: coverageOf(rows.length, preview, facetInstances) };
}

/**
 * THE ONE PLACE THAT DECIDES WHETHER A CASE IS DECIDABLE.
 *
 * A case a registered predicate cannot reach is NEVER reported as typed, whatever payload
 * it carries: the REGISTRY decides, not the payload. Every caller — the sealed instance and
 * the preview's per-requirement tally — goes through here, so the ledger and the count it is
 * summarised by cannot come to disagree about the same case.
 */
const gapFor = (d: DraftCase): ExpectationGap | null =>
  KINDS_WITH_A_PREDICATE.has(d.case.kind) ? d.expectationGap : (d.expectationGap ?? structuralGap(d.case.kind));

/**
 * Why a fallback case carries no expectation: it never had a payload to carry one in.
 *
 * Returns `null` for kinds no predicate is registered for — NOT because such a case is
 * decidable, but because there is exactly ONE place that decides that, and it is the
 * registry check in the loop below. Two places deciding it is how one of them comes to
 * disagree with `PREDICATE_FOR_KIND` after someone adds a predicate.
 */
function fallbackGap(kind: FacetCase["kind"], facet: string): ExpectationGap | null {
  if (kind === "route") {
    return gap(
      EXPECTATION_GAP.ROUTE_ANSWERS_NOT_ENUMERATED,
      `the requirement is a "${facet}" rule but the extraction bound no answer set to it, so there is no answer ` +
        `to select and no destination to expect. Enumerating one from anywhere other than the document would be ` +
        `a denominator invented by the run`,
    );
  }
  if (kind === "boundary") {
    return gap(
      EXPECTATION_GAP.INPUT_BOUND_NOT_STATED,
      `the requirement is a "${facet}" rule but the extraction bound no numeric input or selection bound to it, ` +
        `so there is no input to enter and no outcome to expect`,
    );
  }
  if (kind === "option-set") {
    // REACHED ONLY BY A ROW THIS FUNCTION'S CALLER DID NOT SEND THROUGH `mintOptionSet` — a
    // facet that maps to `option-set` through some future edit to `FACET_TO_CASE_KIND` without
    // a matching arm in the loop. Since 1.2.0 `option-set` is a kind WITH a predicate, so a
    // `null` here would report such a case as decidable while its payload is empty, which is
    // the exact "looks typed, is not" shape this module exists to refuse.
    return gap(
      EXPECTATION_GAP.OPTION_SET_NOT_READ_FROM_THE_DOCUMENT_QUOTE,
      `the requirement is a "${facet}" rule that reached the generic arm, so no answer option was read from its ` +
        `document quote and there is nothing to compare a rendered screen against`,
    );
  }
  return null;
}

/** No predicate exists for this kind at all — structural, not an extraction defect. */
const structuralGap = (kind: FacetCase["kind"]): ExpectationGap =>
  gap(
    EXPECTATION_GAP.NO_TYPED_PREDICATE_FOR_KIND,
    `a "${kind}" case needs the document's own prose compared against a rendered screen, which is the model ` +
      `verifier's job. No model-free predicate is registered for it, so no extraction quality would make it decidable here`,
  );

function coverageOf(
  requirements: number,
  preview: ExpansionPreviewEntry[],
  facetInstances: FacetInstance[],
): ExpansionCoverage {
  const byGap: Record<string, number> = {};
  const byKind: Record<string, { cases: number; typed: number }> = {};
  const optionSetClosure: ExpansionCoverage["optionSetClosure"] = {
    cases: 0,
    payloadCases: 0,
    established: 0,
    notEstablished: 0,
    notEvaluated: 0,
    unavailableBecauseCaseUntyped: 0,
    byCode: {},
  };
  let typed = 0;
  for (const fi of facetInstances) {
    const k = (byKind[fi.case.kind] ??= { cases: 0, typed: 0 });
    k.cases += 1;
    if (fi.expectationGap) byGap[fi.expectationGap.code] = (byGap[fi.expectationGap.code] ?? 0) + 1;
    else {
      typed += 1;
      k.typed += 1;
    }
    if (fi.case.kind === "option-set") {
      optionSetClosure.cases += 1;
      const payload = fi.case.optionSet;
      if (!payload) {
        optionSetClosure.unavailableBecauseCaseUntyped += 1;
      } else {
        optionSetClosure.payloadCases += 1;
        const assessment = payload.closureAssessment;
        if (assessment.status === "established") optionSetClosure.established += 1;
        else if (assessment.status === "not-established") optionSetClosure.notEstablished += 1;
        else optionSetClosure.notEvaluated += 1;
        optionSetClosure.byCode[assessment.code] = (optionSetClosure.byCode[assessment.code] ?? 0) + 1;
      }
    }
  }
  return {
    requirements,
    requirementsWithNoCase: preview.filter((p) => p.caseCount === 0).length,
    cases: facetInstances.length,
    typedCases: typed,
    untypedCases: facetInstances.length - typed,
    byGap,
    byKind,
    optionSetClosure,
  };
}

const questionOf = (r: ScopedRequirement): string | null => {
  const m = /^question:(.+)$/i.exec(r.scope);
  return m ? m[1]!.trim() : null;
};

function labelFor(r: ScopedRequirement, c: FacetCase, g: ExpectationGap | null): string {
  if (c.routeAnswer) {
    const dest = c.expectedDestination?.terminal ?? c.expectedDestination?.questionId ?? `unbound (${g?.code ?? "?"})`;
    return `route: ${c.routeAnswer.label ?? c.routeAnswer.code} → ${dest}`;
  }
  if (c.boundaryInput) {
    const outcome = g ? `${c.boundaryInput.expectedOutcome}, ${g.code}` : c.boundaryInput.expectedOutcome;
    return `boundary: ${c.boundaryInput.bound} (${outcome})`;
  }
  if (c.kind === "option-set") {
    if (!c.optionSet) return `option-set: not minted (${g?.code ?? "?"})`;
    const labels = c.optionSet.asserted.map((o) => (o.code === null ? o.label : `${o.code}=${o.label}`)).join(", ");
    return `option-set${c.optionSet.exhaustive ? " (closed)" : ""}: ${labels.slice(0, 120)}`;
  }
  return `${c.kind}: ${r.normativeStatement.slice(0, 80)}`;
}

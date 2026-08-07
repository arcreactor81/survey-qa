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
 * `routeAnswer` + `expectedDestination` (route) and `boundaryInput` (boundary). Everything
 * else it can only call `insufficient`.
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
  EXPECTATION_GAP,
  type ExpectationGap,
  type ExpectationGapCode,
  type ExpectedDestinationPayload,
  type FacetCase,
  type FacetInstance,
  type ScopedRequirement,
} from "../types/record";
import type { MergedRow } from "./merge";

export const EXPANDER_VERSION = "v2-floor-expander/1.1.0";

const FACET_TO_CASE_KIND: Record<string, FacetCase["kind"]> = {
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
const KINDS_WITH_A_PREDICATE = new Set<FacetCase["kind"]>(["route", "boundary"]);

const emptyCase = (kind: FacetCase["kind"]): FacetCase => ({
  kind,
  routeAnswer: null,
  boundaryInput: null,
  configuration: null,
  expectedDestination: null,
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
function questionVocabulary(rows: MergedRow[]): Map<string, string> {
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
}

export interface ExpansionOutput {
  facetInstances: FacetInstance[];
  preview: ExpansionPreviewEntry[];
  /** Requirements the expander could not preview at all. Blocks the gate when non-empty. */
  unpreviewed: string[];
  coverage: ExpansionCoverage;
}

export async function expandFloor(
  rows: MergedRow[],
  configuration: { locale: string; viewport: string | null },
): Promise<ExpansionOutput> {
  const facetInstances: FacetInstance[] = [];
  const preview: ExpansionPreviewEntry[] = [];
  const unpreviewed: string[] = [];
  const vocabulary = questionVocabulary(rows);

  for (const row of rows) {
    const r: ScopedRequirement = row.requirement;
    const expansion = row.raw.find((x) => x.expansion !== null)?.expansion ?? null;
    const drafts: DraftCase[] = [];
    let basis: string;

    if (expansion && expansion.kind === "route" && expansion.routeAnswers.length > 0) {
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
  let typed = 0;
  for (const fi of facetInstances) {
    const k = (byKind[fi.case.kind] ??= { cases: 0, typed: 0 });
    k.cases += 1;
    if (fi.expectationGap) byGap[fi.expectationGap.code] = (byGap[fi.expectationGap.code] ?? 0) + 1;
    else {
      typed += 1;
      k.typed += 1;
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
  return `${c.kind}: ${r.normativeStatement.slice(0, 80)}`;
}

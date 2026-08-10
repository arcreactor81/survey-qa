/**
 * GRAPH-D IR — the one shape every ingester must produce, and the accounting that goes
 * with it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY AN IR AND NOT "THE MANIFEST"
 *
 * `graph-spike/compile-d.mjs`, `coverage.mjs`, `attributes.mjs` and `diff.mjs` all
 * interpret one object shape. In the spike that object WAS the branching corpus's own
 * manifest, and FINDINGS.md §2 is explicit that this made the docx parser an inverted
 * renderer rather than an extractor.
 *
 * So the shape is re-declared here as an INTERMEDIATE REPRESENTATION with a stated
 * provenance, and the corpus manifest becomes one ingester among others rather than the
 * definition. Same fields, so the spike's compiler and interpreter are reused verbatim;
 * different status, because every field now carries a BASIS.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THE BASIS FIELDS ARE THE POINT
 *
 * CLAUDE.md: "No silent reliance on a convention. Every place the system depends on one
 * must (a) state the assumption in code, (b) detect when it does not hold, and (c)
 * degrade to a named, reported limitation rather than to a wrong answer."
 *
 * A comparison is only as strong as the weakest thing it is comparing. If the document
 * side of an edge was INFERRED (from document order, say) rather than STATED, then a
 * disagreement between document and site is evidence about the inference at least as much
 * as it is evidence about the site. Emitting it as a defect would be a confident wrong
 * answer. Emitting nothing would be a silent short. So the basis travels with the datum
 * and the finding mapper reads it:
 *
 *   basis "stated"   -> a disagreement is a DEFECT
 *   basis "inferred" -> a disagreement is an OBSERVATION, and the report says how many
 *                       findings were downgraded and why
 *   basis "unknown"  -> the comparison is NOT PERFORMED, and the coverage unit says
 *                       `not-assessed` instead of quietly passing
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHAT THE SHARED EXTRACTION CAN AND CANNOT EXPRESS  (measured, not guessed)
 *
 * `worker-v2/src/extract` is the shared-ingestion control (PRE-REGISTRATION.md §8.1) and
 * Arm B must use it rather than a private parser. Reading its actual schema
 * (`prompts.ts` obligation schema -> `RawExpansion` -> `expand.ts` FacetInstance) settles
 * what a graph built from a real document can contain:
 *
 *   AVAILABLE, TYPED
 *     - source question id      `scope: "question:<id>"` -> FacetInstance.targetQuestionId
 *     - triggering answer       `expansion.route_answers[].code` / `.label`
 *     - destination             `expansion.route_answers[].destination`
 *     - terminal kind           destinationOf() regex -> complete | screenout | quota
 *     - stated input bounds     max_length / min_selections / max_selections
 *
 *   NOT AVAILABLE AT ALL — no field exists to carry them
 *     - condition operators (<, >=, includes, count-of)      -> no numeric gates
 *     - conditions that read a DIFFERENT question            -> no base/ask-if logic
 *     - fall-through ("what happens when no rule fires")     -> inferred, never stated
 *     - question ORDER                                       -> inferred from block order
 *     - full option lists, option order, scale labels        -> prose only
 *     - loops, carry-forward source, piping source           -> prose only
 *     - randomisation and anchors                            -> prose only
 *
 * That list is not a complaint about the extractor; it is the SEAM the ablation exists to
 * locate, and it lands almost exactly where PRE-REGISTRATION.md §4.6 predicted it would
 * (`PREDICTED_OWNER`: routing/terminate -> graph, wording/option-list/option-order/
 * scale-labels/randomisation/carry-forward/piping -> model). Arm B should therefore be
 * expected to score near zero on the model-owned classes when it is fed a real document,
 * and this file is where that expectation is made structural rather than accidental.
 */

export const IR_VERSION = "graph-d-ir/1.0.0";

/** A datum's standing. Ordered weakest-first; `atLeast` compares them. */
export const BASIS = ["unknown", "inferred", "stated"];
export function basisAtLeast(b, floor) {
  return BASIS.indexOf(b ?? "unknown") >= BASIS.indexOf(floor);
}

/**
 * Every assumption any ingester or the crawler relies on. Declared here so that the
 * arm's output can enumerate them whether or not they happened to be violated — "we
 * checked and it held" must be distinguishable from "we never looked" (CLAUDE.md).
 *
 * `detect` is filled in by platform.mjs (site-side) and the ingesters (document-side);
 * an assumption with no detector is marked `detectable: false` AND SAYS SO, because an
 * undetectable assumption is the most dangerous kind and hiding it would be the failure
 * this project exists to prevent.
 */
export const ASSUMPTIONS = [
  {
    id: "SITE-01",
    surface: "site",
    severity: "hard",
    name: "stable-question-identifier-in-dom",
    statement:
      "Every question screen exposes an identifier (a `data-qid`-style attribute or a leading `Q7.` token in its heading) that is stable across sessions and shared with the questionnaire.",
    failureMode:
      "Site nodes cannot be aligned with document nodes. Every routing comparison becomes a guess, so the arm reports a blocker and asserts nothing.",
    detectable: true,
  },
  {
    id: "SITE-02",
    surface: "site",
    severity: "hard",
    name: "one-question-per-screen",
    statement: "A screen presents at most one question, so a screen and a graph node are the same thing.",
    failureMode:
      "The crawler's snapshot reads the FIRST question block on a screen and silently ignores the rest — a quietly shorter list, which is precisely the failure CLAUDE.md forbids. Reported as a blocker instead.",
    detectable: true,
  },
  {
    id: "SITE-03",
    surface: "site",
    severity: "soft",
    name: "forward-only-navigation",
    statement: "There is no back/previous control, so a journey is a path and an edge has one direction.",
    failureMode:
      "With a back button, edge identity depends on arrival history and the `back-navigation-state` requirement class is unevaluable by forward traversal. Reported as a named limitation, not silently ignored.",
    detectable: true,
  },
  {
    id: "SITE-04",
    surface: "site",
    severity: "soft",
    name: "recognised-answer-controls",
    statement:
      "Every screen's answer control is one of radio / checkbox / number / text / rating / allocation-grid.",
    failureMode:
      "An unrecognised control (a select, a date picker, a slider, a drag-rank) cannot be driven, so that node's outgoing edges are never probed. Those edges are reported `not-reached`, never assumed absent.",
    detectable: true,
  },
  {
    id: "SITE-05",
    surface: "site",
    severity: "soft",
    name: "render-settles-without-further-input",
    statement: "A screen's content is complete once the page has loaded and settled; nothing appears later.",
    failureMode:
      "Late-rendering content is read as absent, which manufactures `element-absent` defects. The probe waits and reports the observed settle time; if nothing recognisable ever appears, that is a blocker.",
    detectable: true,
  },
  {
    id: "SITE-06",
    surface: "site",
    severity: "soft",
    name: "single-session-determinism",
    statement:
      "One session renders one option order and one carry-forward state, and that is what gets observed.",
    failureMode:
      "Randomisation, rotation, anchoring and quota behaviour are INVISIBLE to single-session traversal by construction. They are reported as residue, never as pass.",
    detectable: false,
    undetectableBecause:
      "Distinguishing 'fixed order' from 'randomised and this draw happened to look like the document' needs N respondents, which a deterministic crawl does not have.",
  },
  {
    id: "SITE-07",
    surface: "site",
    severity: "soft",
    name: "re-running-the-survey-is-free-and-idempotent",
    statement:
      "Opening the link N times and submitting answers has no side effect: no quota cell is consumed, no respondent record is written, no completion is spent.",
    failureMode:
      "On a live fielding link this is FALSE. Arm B opens one session per journey — hundreds per survey — and would burn quota, corrupt data, or exhaust a sample. The arm reports its session count so the cost is visible before anyone points it at production.",
    detectable: false,
    undetectableBecause:
      "A survey platform does not tell a visitor whether their submission was recorded. This can only be established out of band, by whoever owns the link.",
  },
  {
    id: "DOC-01",
    surface: "document",
    severity: "soft",
    name: "question-identifiers-shared-between-document-and-site",
    statement:
      "The identifiers the extraction recovers from the questionnaire name the same screens the site labels.",
    failureMode:
      "Zero overlap means every documented node looks missing and every site node looks undocumented — dozens of false positives from one namespace mismatch. Detected by intersecting the two id sets before any comparison runs.",
    detectable: true,
  },
  {
    id: "DOC-02",
    surface: "document",
    severity: "soft",
    name: "document-order-implies-presentation-order",
    statement:
      "Where the document does not state what follows a question, the next question in document order is what follows it.",
    failureMode:
      "This is the fall-through edge, and the shared extraction has NO field that can carry it (see the header). Fall-through edges are therefore basis `inferred`, and a disagreement on one is downgraded to an observation rather than asserted as a routing defect.",
    detectable: false,
    undetectableBecause:
      "The absence of a stated rule is indistinguishable from a rule the extraction missed. Only a second, independent read of the document could tell them apart.",
  },
  {
    id: "DOC-03",
    surface: "document",
    severity: "soft",
    name: "enumerated-option-lists-are-complete",
    statement: "Where the arm has an option list, it is the whole list.",
    failureMode:
      "Under the shared extraction the arm's option knowledge comes only from `route_answers`, which enumerates the answers that TRIGGER A ROUTE — a lower bound, not a list. So `option-absent` remains decidable and `option-present-unexpected` does NOT, and the latter is suppressed rather than asserted.",
    detectable: true,
  },
];

export const ASSUMPTION_BY_ID = Object.fromEntries(ASSUMPTIONS.map((a) => [a.id, a]));

/**
 * A fresh, empty IR. `provenance` is required at construction — an IR that cannot say
 * where it came from cannot be trusted about anything, and a default here would let one
 * be built by accident.
 */
export function emptyIR(provenance) {
  if (!provenance?.ingester) throw new Error("IR provenance must name its ingester");
  return {
    irVersion: IR_VERSION,
    schema: "branching-survey/v1", // the shape graph-spike/compile-d.mjs interprets
    id: provenance.surveyId ?? null,
    title: null,
    questions: [],
    loops: [],
    computed: [],
    __provenance: provenance,
    __basis: {
      // Defaults for the whole IR; an individual question may override.
      questionSet: "unknown",
      questionOrder: "unknown",
      fallThrough: "unknown",
      optionSet: "unknown",
      optionOrder: "unknown",
      questionText: "unknown",
      routing: "unknown",
      validation: "unknown",
    },
    /** Everything the ingester could not turn into graph. Counted, never dropped. */
    __unresolved: [],
    /**
     * Things that DID compile but carry a stated weakness — most often an
     * `expectationGap` the shared expander attached, e.g. "this destination reads as a
     * terminal state, which no model-free predicate can tell apart from the other
     * terminal states". Kept separate from `__unresolved` so the unresolved COUNT stays a
     * clean measure of what did not compile, while the caveat is still reported.
     */
    __caveats: [],
    /** Requirements the ingester consumed, for the completeness fraction. */
    __accounting: { requirementsIn: 0, requirementsCompiled: 0, requirementsUnresolved: 0 },
  };
}

/** Record something the ingester saw and could not compile. This list is REPORTED. */
export function unresolved(ir, code, detail, ref = null) {
  ir.__unresolved.push({ code, detail, ref });
  ir.__accounting.requirementsUnresolved += 1;
  return ir;
}

/** A compiled datum with a stated weakness. Reported, and never silently upgraded. */
export function caveat(ir, code, detail, ref = null) {
  ir.__caveats.push({ code, detail, ref });
  return ir;
}

export const UNRESOLVED_CODES = {
  NO_QUESTION_SCOPE: "requirement carries no `question:<id>` scope, so it cannot be attached to a node",
  ROUTE_WITHOUT_EXPANSION: "prose names a routing rule but no typed route_answers survived extraction",
  ROUTE_ANSWER_NOT_A_CODE: "route answer has a label but no numeric code, so the site answer class is unknown",
  DESTINATION_UNRESOLVED: "route destination does not resolve to a known question id or a terminal",
  CONDITION_NOT_EXPRESSIBLE: "the rule's condition is prose the IR has no field for (operator / cross-question / count)",
  CONSTRUCT_NOT_GRAPH_SHAPED: "requirement is real but is a node attribute the IR cannot carry (option list, wording, randomisation, piping, carry-forward)",
  DUPLICATE_QUESTION_ID: "two requirements claim the same question id with incompatible content",
};

/**
 * Sanity-check an IR before it is used. Fail-closed and LOUD: a malformed IR silently
 * accepted produces a comparison against nothing, which reads as "no problems found".
 */
export function validateIR(ir) {
  const errors = [];
  if (ir?.irVersion !== IR_VERSION) errors.push(`irVersion ${ir?.irVersion} != ${IR_VERSION}`);
  if (!Array.isArray(ir?.questions)) errors.push("questions is not an array");
  else {
    const seen = new Set();
    for (const q of ir.questions) {
      if (typeof q.id !== "string" || !q.id) errors.push("a question has no id");
      else if (seen.has(q.id)) errors.push(`duplicate question id ${q.id}`);
      else seen.add(q.id);
      // ABSENT is fine and means "this question has no option list" — a numeric or text
      // question. PRESENT-BUT-NOT-A-LIST is a malformed IR. The interpreter reads
      // `q.options || []` everywhere, so conflating the two would reject valid input.
      if (q.options !== undefined && !Array.isArray(q.options)) errors.push(`${q.id}: options is present but not an array`);
      if (q.rules !== undefined && !Array.isArray(q.rules)) errors.push(`${q.id}: rules is not an array`);
    }
    // Every goto must land somewhere the interpreter can find, or `createDRun` throws
    // mid-replay and the run dies with a stack trace instead of a finding.
    for (const q of ir.questions) {
      for (const r of q.rules || []) {
        if (r.goto && !seen.has(r.goto)) errors.push(`${q.id}: rule targets unknown question ${r.goto}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** The fraction of what the ingester was given that became graph. Reported, not asserted. */
export function completeness(ir) {
  const a = ir.__accounting;
  return {
    ...a,
    compiledShare: a.requirementsIn ? a.requirementsCompiled / a.requirementsIn : null,
    unresolvedByCode: ir.__unresolved.reduce((acc, u) => {
      acc[u.code] = (acc[u.code] || 0) + 1;
      return acc;
    }, {}),
    caveatsByCode: (ir.__caveats || []).reduce((acc, u) => {
      acc[u.code] = (acc[u.code] || 0) + 1;
      return acc;
    }, {}),
  };
}

/**
 * ROUTE LABEL EXTRACTION — per-answer routing rules with verbatim labels.
 *
 * THE MEASURED DEFECT: multi-row per-answer routing tables came out label-less or collapsed
 * into one blob, so the walker got no per-answer steering and live walks died at screeners
 * the document fully specifies. This test proves the full path: fixture route_answers ->
 * sealed facet instances -> sealedRouteDestinations -> stampSurvivalHints emits the right
 * avoid_labels / prefer_labels.
 *
 * THE ANCHOR CLEANER: rendering-artifact markers like "[ANCHOR BELOW]" pollute extracted
 * text. The cleaner strips them with a named, counted transformation.
 *
 * Evidence these can fail: tools/mutate-route-labels.mjs.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { worker } from "./_helpers.mjs";

const mod = await worker();
const { sealedRouteDestinations, stampSurvivalHints, survivalAvoidIndex } = mod.plan;
const { coerceRequirement } = mod.coerce;
const { cleanRenderingArtifacts, RENDERING_ARTIFACT_VOCAB_VERSION } = mod.anchorCleaner;
const { PROMPT_VERSION_A, PROMPT_VERSION_B, SYSTEM_A, SYSTEM_B } = mod.prompts;

/* ================================================================
 * 1. ANCHOR CLEANER — unit tests
 * ================================================================ */

suite("anchor cleaner: rendering artifact removal", () => {
  test("strips a single [ANCHOR BELOW] marker and counts it", () => {
    const result = cleanRenderingArtifacts("Option A [ANCHOR BELOW] more text");
    assertEq(result.cleaned, "Option A more text");
    assertEq(result.removedCount, 1);
    assertEq(result.removed.length, 1);
    assertEq(result.removed[0], "[ANCHOR BELOW]");
  });

  test("strips multiple rendering artifacts and counts each", () => {
    const result = cleanRenderingArtifacts("[INSERT ANCHOR] Label [DISPLAY HERE] end");
    assertEq(result.cleaned, "Label end");
    assertEq(result.removedCount, 2);
    assert(result.removed.includes("[INSERT ANCHOR]"), "should include [INSERT ANCHOR]");
    assert(result.removed.includes("[DISPLAY HERE]"), "should include [DISPLAY HERE]");
  });

  test("preserves brackets whose content is NOT all rendering vocab", () => {
    const result = cleanRenderingArtifacts("Choose [NONE OF THE ABOVE] to skip");
    assertEq(result.cleaned, "Choose [NONE OF THE ABOVE] to skip");
    assertEq(result.removedCount, 0);
  });

  test("preserves single-word brackets (not rendering artifacts)", () => {
    const result = cleanRenderingArtifacts("[TERMINATE] the survey");
    assertEq(result.cleaned, "[TERMINATE] the survey");
    assertEq(result.removedCount, 0);
  });

  test("preserves brackets with lowercase or mixed-case content", () => {
    const result = cleanRenderingArtifacts("[anchor below] stays");
    assertEq(result.cleaned, "[anchor below] stays");
    assertEq(result.removedCount, 0);
  });

  test("returns empty string unchanged", () => {
    const result = cleanRenderingArtifacts("");
    assertEq(result.cleaned, "");
    assertEq(result.removedCount, 0);
  });

  test("text with no brackets passes through unchanged", () => {
    const input = "What is your age?";
    const result = cleanRenderingArtifacts(input);
    assertEq(result.cleaned, input);
    assertEq(result.removedCount, 0);
  });

  test("vocab version is a non-empty string", () => {
    assert(typeof RENDERING_ARTIFACT_VOCAB_VERSION === "string", "version is a string");
    assert(RENDERING_ARTIFACT_VOCAB_VERSION.length > 0, "version is non-empty");
  });

  test("collapses double spaces left by removal", () => {
    const result = cleanRenderingArtifacts("A  [ANCHOR BELOW]  B");
    assertEq(result.cleaned, "A B");
    assertEq(result.removedCount, 1);
  });
});

/* ================================================================
 * 2. PER-ANSWER ROUTE RULES -> SEALED ROUTE DESTINATIONS -> STAMPS
 * ================================================================ */

/**
 * Synthetic fixture: a sealed revision with multi-row routing rules.
 * Each route facet instance carries a typed routeAnswer with a verbatim label.
 *
 * The scenario: question Q5 has three routing rules:
 *   - "Market research" (code 1) -> TERMINATE
 *   - "Healthcare" (code 2) -> SKIP TO Q10
 *   - "None of the above" (code 3) -> TERMINATE
 */
const MULTI_ROW_REVISION = {
  requirements: [
    {
      requirementLineageId: "req-term-q5-market-research",
      requirementVersionId: "rv-001",
      facet: "terminate",
      scope: "question:Q5",
      displayQuote: 'If "Market research" selected at Q5, TERMINATE',
      normativeStatement: 'Selecting "Market research" at Q5 terminates the interview',
      testability: "browser-observable",
      assertionStatus: "asserted",
    },
    {
      requirementLineageId: "req-skip-q5-healthcare",
      requirementVersionId: "rv-002",
      facet: "skip-rule",
      scope: "question:Q5",
      displayQuote: 'If "Healthcare" selected at Q5, SKIP TO Q10',
      normativeStatement: 'Selecting "Healthcare" at Q5 skips to Q10',
      testability: "browser-observable",
      assertionStatus: "asserted",
    },
    {
      requirementLineageId: "req-term-q5-none",
      requirementVersionId: "rv-003",
      facet: "terminate",
      scope: "question:Q5",
      displayQuote: 'If "None of the above" selected at Q5, TERMINATE',
      normativeStatement: 'Selecting "None of the above" at Q5 terminates the interview',
      testability: "browser-observable",
      assertionStatus: "asserted",
    },
  ],
  facetInstances: [
    {
      facetInstanceId: "fi-term-q5-mr",
      requirementLineageId: "req-term-q5-market-research",
      targetQuestionId: "Q5",
      case: {
        kind: "route",
        routeAnswer: { code: "1", label: "Market research" },
        expectedDestination: null,
        boundaryInput: null,
        optionSet: null,
      },
      expectationGap: null,
    },
    {
      facetInstanceId: "fi-skip-q5-hc",
      requirementLineageId: "req-skip-q5-healthcare",
      targetQuestionId: "Q5",
      case: {
        kind: "route",
        routeAnswer: { code: "2", label: "Healthcare" },
        expectedDestination: { questionId: "Q10", tokenBasis: "Q10" },
        boundaryInput: null,
        optionSet: null,
      },
      expectationGap: null,
    },
    {
      facetInstanceId: "fi-term-q5-none",
      requirementLineageId: "req-term-q5-none",
      targetQuestionId: "Q5",
      case: {
        kind: "route",
        routeAnswer: { code: "3", label: "None of the above" },
        expectedDestination: null,
        boundaryInput: null,
        optionSet: null,
      },
      expectationGap: null,
    },
  ],
};

suite("sealedRouteDestinations: per-answer labels", () => {
  test("extracts terminate destinations with verbatim labels", () => {
    const routes = sealedRouteDestinations(MULTI_ROW_REVISION);
    const terminates = routes.filter((r) => r.kind === "terminate");
    assertEq(terminates.length, 2, "two terminate routes");
    const labels = terminates.map((r) => r.label).sort();
    assert(labels.includes("Market research"), "Market research is a terminate label");
    assert(labels.includes("None of the above"), "None of the above is a terminate label");
  });

  test("extracts continue destinations with verbatim labels", () => {
    const routes = sealedRouteDestinations(MULTI_ROW_REVISION);
    const continues = routes.filter((r) => r.kind === "continue");
    assertEq(continues.length, 1, "one continue route");
    assertEq(continues[0].label, "Healthcare");
    assertEq(continues[0].question, "Q5");
  });

  test("skips routes with null labels", () => {
    const revision = {
      requirements: [
        {
          requirementLineageId: "req-term-code-only",
          facet: "terminate",
        },
      ],
      facetInstances: [
        {
          facetInstanceId: "fi-code-only",
          requirementLineageId: "req-term-code-only",
          targetQuestionId: "Q5",
          case: {
            kind: "route",
            routeAnswer: { code: "4", label: null },
          },
        },
      ],
    };
    const routes = sealedRouteDestinations(revision);
    assertEq(routes.length, 0, "code-only route has no label, so produces no route destination");
  });
});

suite("survivalAvoidIndex: sealed routes build avoid and prefer maps", () => {
  test("terminate routes become avoid entries", () => {
    const routes = sealedRouteDestinations(MULTI_ROW_REVISION);
    const { avoid } = survivalAvoidIndex({}, routes);
    const q5Avoid = avoid.get("Q5") ?? [];
    assert(q5Avoid.includes("Market research"), "Market research is avoided");
    assert(q5Avoid.includes("None of the above"), "None of the above is avoided");
  });

  test("continue routes become prefer entries", () => {
    const routes = sealedRouteDestinations(MULTI_ROW_REVISION);
    const { prefer } = survivalAvoidIndex({}, routes);
    const q5Prefer = prefer.get("Q5") ?? [];
    assert(q5Prefer.includes("Healthcare"), "Healthcare is preferred");
  });

  test("a label that is BOTH terminate and continue is in avoid only", () => {
    const revision = {
      requirements: [
        { requirementLineageId: "req-t", facet: "terminate" },
        { requirementLineageId: "req-s", facet: "skip-rule" },
      ],
      facetInstances: [
        {
          facetInstanceId: "fi-t",
          requirementLineageId: "req-t",
          targetQuestionId: "Q1",
          case: { kind: "route", routeAnswer: { code: "1", label: "Conflicted" } },
        },
        {
          facetInstanceId: "fi-s",
          requirementLineageId: "req-s",
          targetQuestionId: "Q1",
          case: { kind: "route", routeAnswer: { code: "1", label: "Conflicted" } },
        },
      ],
    };
    const routes = sealedRouteDestinations(revision);
    const { avoid, prefer } = survivalAvoidIndex({}, routes);
    assert((avoid.get("Q1") ?? []).includes("Conflicted"), "Conflicted is in avoid");
    assert(!(prefer.get("Q1") ?? []).includes("Conflicted"), "Conflicted is NOT in prefer");
  });
});

suite("stampSurvivalHints: full path from route labels to decision stamps", () => {
  test("stamps avoid_labels and prefer_labels on matching decisions", () => {
    const routes = sealedRouteDestinations(MULTI_ROW_REVISION);
    const carriers = [
      {
        id: "path-1",
        decisions: [
          { question: "Q5", select: [], action: "default:navigator-discretion" },
          { question: "Q6", select: ["Yes"], action: null },
        ],
      },
    ];
    const result = stampSurvivalHints(carriers, {}, routes);
    assertEq(result.decisionsStamped, 1, "one decision stamped (Q5)");
    assertEq(result.pathsStamped, 1, "one path stamped");
    assertEq(result.questions.length, 1, "one question hinted");

    const q5Decision = carriers[0].decisions[0];
    assert(Array.isArray(q5Decision.avoid_labels), "Q5 decision has avoid_labels");
    assert(q5Decision.avoid_labels.includes("Market research"), "avoid contains Market research");
    assert(q5Decision.avoid_labels.includes("None of the above"), "avoid contains None of the above");
    assert(Array.isArray(q5Decision.prefer_labels), "Q5 decision has prefer_labels");
    assert(q5Decision.prefer_labels.includes("Healthcare"), "prefer contains Healthcare");
  });

  test("does not stamp decisions with case_action (sealed stimulus)", () => {
    const routes = sealedRouteDestinations(MULTI_ROW_REVISION);
    const carriers = [
      {
        id: "path-2",
        decisions: [
          {
            question: "Q5",
            select: ["Market research"],
            case_action: { facetInstanceId: "fi-term-q5-mr", kind: "route" },
          },
        ],
      },
    ];
    const result = stampSurvivalHints(carriers, {}, routes);
    assertEq(result.decisionsStamped, 0, "sealed stimulus not stamped");
  });

  test("unstampable entries are counted when no label resolves", () => {
    const result = stampSurvivalHints(
      [{ id: "p1", decisions: [{ question: "Q9", select: [] }] }],
      {
        terminals: [
          {
            id: "TERM-NO-LABEL",
            kind: "screen-out",
            trigger: { question: "Q9", answers: [] },
          },
        ],
      },
      [],
    );
    assertEq(result.unstampable.length, 1, "one unstampable terminal");
    assert(result.unstampable[0].terminal === "TERM-NO-LABEL", "correct terminal id");
  });
});

/* ================================================================
 * 3. LABEL-LESS ROUTE ANSWERS: code-only rows
 * ================================================================ */

suite("code-only route answers: the label gap is visible, not silent", () => {
  test("a route with code but no label produces no sealedRouteDestination", () => {
    const revision = {
      requirements: [
        { requirementLineageId: "req-code-only", facet: "terminate" },
      ],
      facetInstances: [
        {
          facetInstanceId: "fi-code-only",
          requirementLineageId: "req-code-only",
          targetQuestionId: "Q3",
          case: {
            kind: "route",
            routeAnswer: { code: "5", label: null },
          },
        },
      ],
    };
    const routes = sealedRouteDestinations(revision);
    assertEq(routes.length, 0, "no destination without a label");
  });
});

/* ================================================================
 * 4. EXPANSION: route_answers -> facet instances (coercion path)
 * ================================================================ */

suite("coerceRequirement: route_answers decomposition", () => {
  test("multi-row route_answers each carry label, code, and destination", () => {
    const raw = {
      id: "OBL-C1-01",
      construct: "skip-rule",
      scope: "question:Q5",
      quantifier: "specific",
      selector: null,
      exceptions: [],
      statement: "Q5 routing: per-answer destinations",
      doc_quote: "If Market research, TERMINATE. If Healthcare, GO TO Q10.",
      block_ids: ["b0042"],
      browser_observable: "full",
      confidence: 0.9,
      expansion: {
        kind: "route",
        route_answers: [
          { code: "1", label: "Market research", destination: "TERMINATE" },
          { code: "2", label: "Healthcare", destination: "Q10" },
          { code: "3", label: "None of the above", destination: "TERMINATE" },
        ],
        max_length: null,
        min_selections: null,
        max_selections: null,
      },
    };
    const result = coerceRequirement(raw, "B", "chunk-1", "survey");
    assert(result !== null, "coercion succeeds");
    assert(result.expansion !== null, "expansion is present");
    assertEq(result.expansion.kind, "route");
    assertEq(result.expansion.routeAnswers.length, 3, "three route answers");
    assertEq(result.expansion.routeAnswers[0].label, "Market research");
    assertEq(result.expansion.routeAnswers[0].code, "1");
    assertEq(result.expansion.routeAnswers[0].destination, "TERMINATE");
    assertEq(result.expansion.routeAnswers[1].label, "Healthcare");
    assertEq(result.expansion.routeAnswers[1].destination, "Q10");
    assertEq(result.expansion.routeAnswers[2].label, "None of the above");
  });

  test("route answer with code only and no label is preserved", () => {
    const raw = {
      id: "OBL-C1-02",
      construct: "terminate",
      scope: "question:Q5",
      quantifier: "specific",
      selector: null,
      exceptions: [],
      statement: "Code 4 terminates",
      doc_quote: "Code 4 -> TERMINATE",
      block_ids: ["b0043"],
      browser_observable: "full",
      confidence: 0.9,
      expansion: {
        kind: "route",
        route_answers: [
          { code: "4", label: null, destination: "TERMINATE" },
        ],
        max_length: null,
        min_selections: null,
        max_selections: null,
      },
    };
    const result = coerceRequirement(raw, "B", "chunk-1", "survey");
    assert(result !== null, "coercion succeeds");
    assertEq(result.expansion.routeAnswers.length, 1);
    assertEq(result.expansion.routeAnswers[0].code, "4");
    assertEq(result.expansion.routeAnswers[0].label, null);
  });

  test("route answer with neither code nor label is filtered out", () => {
    const raw = {
      id: "OBL-C1-03",
      construct: "skip-rule",
      scope: "question:Q5",
      quantifier: "specific",
      selector: null,
      exceptions: [],
      statement: "Empty answer terminates",
      doc_quote: "-> TERMINATE",
      block_ids: ["b0044"],
      browser_observable: "full",
      confidence: 0.9,
      expansion: {
        kind: "route",
        route_answers: [
          { code: null, label: null, destination: "TERMINATE" },
        ],
        max_length: null,
        min_selections: null,
        max_selections: null,
      },
    };
    const result = coerceRequirement(raw, "B", "chunk-1", "survey");
    assert(result !== null, "coercion succeeds");
    assertEq(result.expansion.routeAnswers.length, 0, "empty code+label filtered out");
  });

  test("polluted label with rendering artifact passes through coercion unchanged", () => {
    const raw = {
      id: "OBL-C1-04",
      construct: "skip-rule",
      scope: "question:Q5",
      quantifier: "specific",
      selector: null,
      exceptions: [],
      statement: "Polluted routing",
      doc_quote: "Market research [ANCHOR BELOW] -> TERMINATE",
      block_ids: ["b0045"],
      browser_observable: "full",
      confidence: 0.9,
      expansion: {
        kind: "route",
        route_answers: [
          { code: "1", label: "Market research [ANCHOR BELOW]", destination: "TERMINATE" },
        ],
        max_length: null,
        min_selections: null,
        max_selections: null,
      },
    };
    const result = coerceRequirement(raw, "B", "chunk-1", "survey");
    assert(result !== null, "coercion succeeds");
    assertEq(result.expansion.routeAnswers[0].label, "Market research [ANCHOR BELOW]");
  });
});

/* ================================================================
 * 5. ANCHOR CLEANER ON ROUTE LABELS: the cleaning -> steering pipeline
 * ================================================================ */

suite("anchor cleaner on route labels: cleaning feeds correct steering", () => {
  test("cleaning a polluted label produces the original option text", () => {
    const result = cleanRenderingArtifacts("Market research [ANCHOR BELOW]");
    assertEq(result.cleaned, "Market research");
    assertEq(result.removedCount, 1);
  });

  test("cleaned label produces a valid sealedRouteDestination", () => {
    const revision = {
      requirements: [
        { requirementLineageId: "req-cleaned", facet: "terminate" },
      ],
      facetInstances: [
        {
          facetInstanceId: "fi-cleaned",
          requirementLineageId: "req-cleaned",
          targetQuestionId: "Q5",
          case: {
            kind: "route",
            routeAnswer: { code: "1", label: "Market research" },
          },
        },
      ],
    };
    const routes = sealedRouteDestinations(revision);
    assertEq(routes.length, 1);
    assertEq(routes[0].label, "Market research");
    assertEq(routes[0].kind, "terminate");
  });
});

/* ================================================================
 * 6. PROMPT VERSIONS BUMPED
 * ================================================================ */

suite("prompt versions reflect routing table decomposition", () => {
  test("pass A prompt version is 1.11.0", () => {
    assertEq(PROMPT_VERSION_A, "v2-extract-pass-a/1.11.0");
  });

  test("pass B prompt version is 1.7.0", () => {
    assertEq(PROMPT_VERSION_B, "v2-extract-pass-b/1.7.0");
  });

  test("pass B system prompt contains ROUTING TABLE DECOMPOSITION instruction", () => {
    assert(
      SYSTEM_B.includes("ROUTING TABLE DECOMPOSITION"),
      "SYSTEM_B contains the routing table decomposition instruction",
    );
  });

  test("pass A system prompt contains ROUTING TABLES AND PER-ANSWER RULES instruction", () => {
    assert(
      SYSTEM_A.includes("ROUTING TABLES AND PER-ANSWER RULES"),
      "SYSTEM_A contains routing table instruction",
    );
  });

  test("pass B prompt instructs one route_answers entry per row", () => {
    assert(
      SYSTEM_B.includes("Multi-row tables MUST produce multiple entries"),
      "SYSTEM_B requires multi-row decomposition",
    );
  });

  test("pass B prompt instructs verbatim label copying", () => {
    assert(
      SYSTEM_B.includes("VERBATIM text as it appears in the document"),
      "SYSTEM_B requires verbatim labels",
    );
  });

  test("pass B prompt instructs recording ambiguity for unresolvable labels", () => {
    assert(
      SYSTEM_B.includes('"ambiguities" as a genuine ambiguity rather than guessing'),
      "SYSTEM_B instructs ambiguity recording for unresolvable labels",
    );
  });
});

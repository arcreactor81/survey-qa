/**
 * D36 — A PLANNED STIMULUS IS SOMETHING A BROWSER CAN ACTUALLY PERFORM, OR IT IS COUNTED.
 *
 * ===================== THE THREE DEFECTS, AS PRODUCTION PERFORMED THEM =====================
 *
 * Run `v2r_01kzfb6py8pbxznqv022p2qkhb` judged 227 requirements: 2 pass, 2 fail, 223 never
 * decided. Three separate reasons a walk carried an instruction it could not execute:
 *
 *  1. A CHARACTER-LIMIT PROBE TYPED ITS OWN DESCRIPTION. `plan-core.js` emitted the LITERAL
 *     STRING `"<exactly 500 characters>"` as `text_entry.value`, and `browser/driver.ts` types
 *     that field verbatim — it has no expander. So the 500-character boundary walk typed 24
 *     characters, the field accepted them, and the walk reported a clean pass. A boundary probe
 *     that never reaches the boundary is worse than no probe: it CLOSES the obligation with a
 *     confident wrong answer.
 *
 *  2. A ROUTE CASE WITH NOTHING TO CLICK. A sealed route case may name its answer by CODE with
 *     `label: null`; `select` was then left empty, the driver answered that screen by discretion,
 *     and the route the case exists to witness was never taken — while the case closed. Eight of
 *     the assigned route cases in that revision are like this.
 *
 *  3. FORTY-EIGHT CASES ASSIGNED TO NO WALK, ALL REPORTED AS ONE CAUSE. Every one of them was
 *     warned as "its route/boundary stimulus is incomplete". TWENTY-ONE of the 48 have a complete
 *     stimulus and no `targetQuestionId` — a different defect, in a different place. A shortfall
 *     filed under the wrong cause is worse than an uncounted one, because it gets acted on.
 *
 * ===================== WHAT THESE TESTS REFUSE TO LET BACK IN =====================
 *
 * The negative halves are the load-bearing halves, and each is a thing the code COULD do and
 * must not: invent a label for a code nothing names, let a routing CONDITION propagate from one
 * case to another as if it were an answer, or let a limitation disappear when its count is zero.
 * `tools/mutate-plan.mjs` carries a mutant per property here; a survivor means the property is
 * not actually tested.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { worker } from "./_helpers.mjs";
import { hashContract as pipelineHashContract } from "../../../pipeline/planner/lib/contract.mjs";

// ===========================================================================
// 1. THE BOUNDARY PAYLOAD IS THE PAYLOAD, NOT A DESCRIPTION OF ONE
// ===========================================================================

/**
 * The smallest contract that makes the planner want a character-limit probe: a question that
 * takes text, and a rule capping it. Nothing here is copied from a corpus document — the
 * planner derives the threshold from the sentence, exactly as it does in production.
 */
const textLimitContract = (limit) => ({
  obligations: [
    {
      id: "OBL-A-01",
      category: "question",
      statement: "Q3 asks the respondent to describe their coffee routine in their own words.",
      doc_quote: "Q3. OPEN TEXT.",
      stimulus: ["Q3: (typing)"],
      expected_observable: "Q3 shows a text box.",
      browser_observable: "full",
    },
    {
      id: "OBL-A-02",
      category: "validation",
      statement: `The Q3 text box is limited to ${limit} characters.`,
      doc_quote: `MAXIMUM ${limit} CHARACTERS.`,
      stimulus: [`Q3: (${limit + 1} characters)`],
      expected_observable: `Q3 refuses more than ${limit} characters.`,
      browser_observable: "full",
    },
  ],
});

const plannedTextEntries = (plan) => {
  const out = [];
  for (const entry of [...plan.floor.paths, ...plan.exploration.queue]) {
    for (const d of entry.decisions ?? []) if (d.text_entry) out.push({ entry: entry.id, decision: d });
  }
  return out;
};

/**
 * The planner is reached through `mod.plan`, NOT by importing `plan-core.js` directly. The
 * mutation harness rewrites sources inside esbuild's load step, so a direct import would run
 * unmutated code and these guards could never be shown to fail.
 */
const planFor = async (limit) => {
  const mod = await worker();
  return mod.plan.planFromContract(textLimitContract(limit), {
    run: "d36",
    source: "d36",
    contractStatus: "authoritative",
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
};

suite("D36 — a length boundary types the length, not a description of it", () => {
  test("THE PRODUCTION DEFECT: no decision anywhere carries a `<exactly N characters>` placeholder", async () => {
    const found = plannedTextEntries(await planFor(500))
      .map(({ entry, decision }) => [entry, decision.text_entry.value])
      .filter(([, value]) => /<\s*exactly\b/i.test(value) || /^<.*>$/.test(value));

    assertEq(found.length, 0, `placeholder strings survived into text_entry.value: ${JSON.stringify(found)}`);
  });

  test("`value.length` IS `length` — the three sides of a 500-character limit are 499, 500 and 501", async () => {
    // The point of the walk is the count, so the count is what is asserted. A test that only
    // checked "not a placeholder" would pass on a value of the wrong length, which is the same
    // untested boundary wearing different clothes.
    const sized = plannedTextEntries(await planFor(500))
      .filter(({ decision }) => decision.text_entry.length != null)
      .map(({ decision }) => decision.text_entry);

    assert(sized.length >= 3, `expected the boundary triple to plan three sized entries, got ${sized.length}`);
    for (const te of sized) {
      assertEq(te.value.length, te.length, `a ${te.length}-character probe typed ${te.value.length} characters`);
    }
    assertEq(
      [...new Set(sized.map((te) => te.length))].sort((a, b) => a - b).join(","),
      "499,500,501",
      "the boundary triple is not the two sides and the limit itself",
    );
  });

  test("every character is ONE code unit, so `maxlength`, the DOM and a byte count cannot disagree", async () => {
    for (const te of plannedTextEntries(await planFor(500)).filter(({ decision }) => decision.text_entry.length != null)) {
      const value = te.decision.text_entry.value;
      assertEq([...value].length, value.length, "the payload contains a character outside the BMP");
      assertEq(/^[\x21-\x7e]*$/.test(value), true, "the payload contains whitespace or a non-ASCII character");
    }
  });

  test("a limit of 1 makes the just-below side ZERO characters — the empty field, not the string '0'", async () => {
    // `Math.max(0, value - 1)` is a real input the planner produces, and `"0"` or a one-character
    // filler would silently turn "submit nothing" into "submit something".
    const zero = plannedTextEntries(await planFor(1)).filter(({ decision }) => decision.text_entry.length === 0);
    assert(zero.length >= 1, "a 1-character limit planned no zero-length side at all");
    for (const { decision } of zero) assertEq(decision.text_entry.value, "");
  });
});

// ===========================================================================
// 2. A ROUTE ANSWER GIVEN ONLY AS A CODE
// ===========================================================================

const routeCase = (id, answer, target, requirement = "req_route") => ({
  facetInstanceId: id,
  requirementLineageId: requirement,
  requirementVersionId: `reqv_${id}`,
  caseVersionId: `cv_${id}`,
  floorCase: true,
  targetQuestionId: target,
  expansionCertificate: `cert_${id}`,
  case: {
    kind: "route",
    routeAnswer: answer,
    boundaryInput: null,
    configuration: null,
    expectedDestination: { questionId: "Q9", screen: null, terminal: null },
  },
  expectationGap: null,
  screen: target,
  label: id,
});

const boundaryCase = (id, input, target, requirement = "req_route") => ({
  ...routeCase(id, null, target, requirement),
  facetInstanceId: id,
  case: { kind: "boundary", routeAnswer: null, boundaryInput: input, configuration: null, expectedDestination: null },
});

/**
 * One floor walk that answers Q7 exactly once, so a Q7 case has somewhere to land.
 *
 * Q1 IS ON THE WALK ON PURPOSE. `isRoutingConditionLabel` decides that "Code 2 at Q1" is a
 * condition by finding Q1 among the questions this plan KNOWS ABOUT — so a fixture without Q1
 * makes that detector silently inert and any test of it vacuous. This was not hypothetical: the
 * condition-propagation test below passed a label straight through until Q1 was added here.
 */
const basePath = () => ({
  id: "FLOOR-001",
  tier: 1,
  kind: "floor",
  intent: "cover the routing requirement",
  decisions: [
    { question: "Q1", select: [], source: "default:navigator-discretion" },
    { question: "Q7", select: [], source: "default:navigator-discretion" },
  ],
  skipped_questions: [],
  terminated_at: null,
  witnesses: ["req_route"],
  witness_notes: [],
  needs_repeats: [],
  steps: 4,
  signature: "sha256:base",
});

const WITNESS = { req_route: "FLOOR-001" };

const selectFor = (result, caseId) => {
  const assignment = result.assignments.find((a) => a.caseIds.includes(caseId));
  const path = result.paths.find((p) => p.id === assignment?.pathId);
  return path?.decisions.find((d) => d.case_action?.facetInstanceId === caseId)?.select ?? null;
};

suite("D36 — a code-only route answer is resolved from the seal, or it is counted", () => {
  test("THE PRODUCTION ROWS: Q7/code 2 with no label takes its label from the sealed case that has one", async () => {
    const mod = await worker();

    // Both rows are real shapes from `cr_c3929b37…`: `fi_942d…` is Q7 / code 2 / label null and
    // `fi_568d…` is Q7 / code 2 / label "No". The join is an EQUALITY on sealed data — same
    // question, same code — so it needs no prose and works in any language.
    const result = mod.plan.materializeCasePaths(
      [basePath()],
      [
        routeCase("fi_labelled", { code: "2", label: "No" }, "Q7"),
        routeCase("fi_codeonly", { code: "2", label: null }, "Q7"),
      ],
      WITNESS,
    );

    assertEq(JSON.stringify(selectFor(result, "fi_codeonly")), JSON.stringify(["No"]));
    assertEq(result.resolvedRouteLabels.length, 1);
    assertEq(result.resolvedRouteLabels[0].via, "sealed-case:fi_labelled");
    assertEq(result.unresolvedRouteCodes.length, 0);
  });

  test("THE SEALED ANSWER IS NOT REWRITTEN: `case_action.routeAnswer` still carries `label: null`", async () => {
    const mod = await worker();
    const result = mod.plan.materializeCasePaths(
      [basePath()],
      [
        routeCase("fi_labelled", { code: "2", label: "No" }, "Q7"),
        routeCase("fi_codeonly", { code: "2", label: null }, "Q7"),
      ],
      WITNESS,
    );

    const assignment = result.assignments.find((a) => a.caseIds.includes("fi_codeonly"));
    const path = result.paths.find((p) => p.id === assignment.pathId);
    const decision = path.decisions.find((d) => d.case_action?.facetInstanceId === "fi_codeonly");

    // Resolution changes what is CLICKED. What was SEALED is evidence and may not be edited by
    // the planner, or a later reader cannot tell the document from the plan's reading of it.
    assertEq(decision.case_action.routeAnswer.label, null);
    assertEq(decision.case_action.routeAnswer.code, "2");
    assertEq(decision.route_label_source, "sealed-case:fi_labelled");
  });

  test("NOTHING IS INVENTED: a code no sealed case names resolves to nothing, is counted, and clicks nothing", async () => {
    const mod = await worker();

    // The four S2 cases in production are exactly this: code 1..4, label null, and the only
    // code->label rows the contract carries for those codes sit under `scope: "survey"` where
    // three different questions all claim code 1. Guessing one is a coin flip whose wrong side
    // is a fabricated defect against a healthy survey.
    const result = mod.plan.materializeCasePaths(
      [basePath()],
      [routeCase("fi_orphan", { code: "4", label: null }, "Q7")],
      WITNESS,
    );

    assertEq(JSON.stringify(selectFor(result, "fi_orphan")), JSON.stringify([]));
    assertEq(result.resolvedRouteLabels.length, 0);
    assertEq(result.unresolvedRouteCodes.length, 1);
    assertEq(result.unresolvedRouteCodes[0].facetInstanceId, "fi_orphan");
    assert(
      result.warnings.some((w) => w.includes("fi_orphan") && w.includes("clicks nothing")),
      `the shortfall was not said out loud: ${JSON.stringify(result.warnings)}`,
    );
  });

  test("A ROUTING CONDITION NEVER BECOMES A LABEL FOR SOMEONE ELSE", async () => {
    const mod = await worker();

    // `"Code 2 at Q1"` is the document's skip-rule condition, not anything Q7 offers. D32 strips
    // it from what the driver clicks; if the code->label index accepted it, the SAME poison would
    // be handed to every other Q7 case naming code 2 — a defect worse than the one D32 removed.
    const result = mod.plan.materializeCasePaths(
      [basePath()],
      [
        routeCase("fi_condition", { code: "2", label: "Code 2 at Q1" }, "Q7"),
        routeCase("fi_codeonly", { code: "2", label: null }, "Q7"),
      ],
      WITNESS,
    );

    assertEq(JSON.stringify(selectFor(result, "fi_codeonly")), JSON.stringify([]));
    assertEq(result.resolvedRouteLabels.length, 0);
    assertEq(result.routingConditionSelects.length, 1);
    assertEq(result.unresolvedRouteCodes.length, 2, "both the stripped condition and the code-only case must be counted");
  });

  test("TWO SEALED CASES THAT DISAGREE DO NOT VOTE — at most one is right, so neither is used", async () => {
    const mod = await worker();
    const result = mod.plan.materializeCasePaths(
      [basePath()],
      [
        routeCase("fi_a", { code: "2", label: "No" }, "Q7"),
        routeCase("fi_b", { code: "2", label: "Nope" }, "Q7"),
        routeCase("fi_codeonly", { code: "2", label: null }, "Q7"),
      ],
      WITNESS,
    );

    assertEq(JSON.stringify(selectFor(result, "fi_codeonly")), JSON.stringify([]));
    assertEq(result.unresolvedRouteCodes.length, 1);
    assert(
      result.unresolvedRouteCodes[0].why.includes("disagree"),
      `the disagreement was not the reported reason: ${result.unresolvedRouteCodes[0].why}`,
    );
  });

  test("A CODE IS NOT A GLOBAL FACT: the same code on ANOTHER question resolves to nothing", async () => {
    const mod = await worker();

    // The index is keyed by question AND code. Keying on the code alone is the mistake that puts
    // "Male" on the coffee-frequency screen, because unscoped option lists reuse code 1 freely.
    const result = mod.plan.materializeCasePaths(
      [
        {
          ...basePath(),
          decisions: [
            { question: "Q7", select: [], source: "d" },
            { question: "S2", select: [], source: "d" },
          ],
        },
      ],
      [
        routeCase("fi_q7", { code: "1", label: "Yes" }, "Q7"),
        routeCase("fi_s2", { code: "1", label: null }, "S2"),
      ],
      WITNESS,
    );

    assertEq(JSON.stringify(selectFor(result, "fi_s2")), JSON.stringify([]));
    assertEq(result.unresolvedRouteCodes.length, 1);
    assertEq(result.unresolvedRouteCodes[0].question, "S2");
  });
});

// ===========================================================================
// 3. THE 48 — FOUR CAUSES, COUNTED APART
// ===========================================================================

suite("D36 — a case that reaches no walk says WHICH of the four things was missing", () => {
  test("THE 21: a complete stimulus with no targetQuestionId is NOT 'stimulus incomplete'", async () => {
    const mod = await worker();

    // `fi_2b95…` in production carries a 100-character boundary value and `targetQuestionId: null`.
    // It was reported as an incomplete stimulus, which sent the next reader upstream to look for
    // a missing value that was there all along.
    const result = mod.plan.materializeCasePaths(
      [basePath()],
      [boundaryCase("fi_notarget", { bound: "max", value: "x".repeat(100), expectedOutcome: "unspecified" }, null)],
      WITNESS,
    );

    assertEq(result.unassignedByCause.length, 1);
    assertEq(result.unassignedByCause[0].cause, "cases-with-no-target-question-id");
    assert(
      result.unassignedByCause[0].detail.includes("otherwise complete"),
      `the detail still blames the stimulus: ${result.unassignedByCause[0].detail}`,
    );
  });

  test("…and a case that DOES name its screen but states no input is a different, separately counted cause", async () => {
    const mod = await worker();
    const result = mod.plan.materializeCasePaths(
      [basePath()],
      [boundaryCase("fi_nopayload", { bound: "max", value: null, expectedOutcome: "unspecified" }, "Q7")],
      WITNESS,
    );

    assertEq(result.unassignedByCause[0].cause, "cases-with-no-stimulus-payload");
  });

  test("a target the witness path never answers is its own cause, not a missing stimulus", async () => {
    const mod = await worker();
    const result = mod.plan.materializeCasePaths(
      [basePath()],
      [routeCase("fi_offpath", { code: "1", label: "Yes" }, "Q99")],
      WITNESS,
    );

    assertEq(result.unassignedByCause[0].cause, "cases-whose-target-question-is-not-on-their-witness-path");
  });

  test("a requirement with no witness path at all is the fourth cause", async () => {
    const mod = await worker();
    const result = mod.plan.materializeCasePaths(
      [basePath()],
      [routeCase("fi_nowitness", { code: "1", label: "Yes" }, "Q7", "req_unwitnessed")],
      WITNESS,
    );

    assertEq(result.unassignedByCause[0].cause, "cases-whose-requirement-has-no-witness-path");
  });

  test("the causes ACCOUNT FOR the unassigned ids exactly — no cause is a summary of the others", async () => {
    const mod = await worker();
    const result = mod.plan.materializeCasePaths(
      [basePath()],
      [
        boundaryCase("fi_notarget", { bound: "max", value: "xxx", expectedOutcome: "unspecified" }, null),
        boundaryCase("fi_nopayload", { bound: "max", value: null, expectedOutcome: "unspecified" }, "Q7"),
        routeCase("fi_offpath", { code: "1", label: "Yes" }, "Q99"),
        routeCase("fi_nowitness", { code: "1", label: "Yes" }, "Q7", "req_unwitnessed"),
      ],
      WITNESS,
    );

    assertEq(
      JSON.stringify(result.unassignedByCause.map((u) => u.facetInstanceId).sort()),
      JSON.stringify([...result.unassignedCaseIds].sort()),
    );
    assertEq(new Set(result.unassignedByCause.map((u) => u.cause)).size, 4, "four distinct causes were expected");
  });
});

// ===========================================================================
// 4. THE SEALED FACET VOCABULARY IS NOT THE PLANNER'S VOCABULARY
// ===========================================================================

suite("D36 — sealed facets are translated into planner categories, and only where that is true", () => {
  test("THE ROOT CAUSE OF THE EMPTY OPTION MODEL: `option-list` reaches the miner as `option-set`", async () => {
    const mod = await worker();

    // `plan-core.js#mineOptions` reads answer options only from `option-set` / `instruction`
    // obligations. Extraction seals them as `option-list`, the facet was passed through
    // unchanged, and so every option row in the contract — 63 of 194 in the real revision — was
    // skipped, leaving all 13 questions with zero options and 277 of 286 decisions empty.
    assertEq(mod.plan.plannerCategory("option-list"), "option-set");
    assertEq(mod.plan.plannerCategory("validation"), "validation-rule");
    assertEq(mod.plan.plannerCategory("terminate"), "terminal");
  });

  test("`skip-rule` is NOT translated — the measurement that says why is the point", async () => {
    const mod = await worker();

    // Mapping it to `branch-outcome` makes the planner draw a question-order edge in the order
    // the statement mentions the ids, and a skip rule states its DESTINATION first ("Ask Q2 only
    // if code 2 at Q1" => Q2 -> Q1, backwards). On the real revision it reordered the survey and
    // changed assigned cases, selects and coverage by zero. A near-neighbour rename is not a
    // routing model.
    assertEq(mod.plan.plannerCategory("skip-rule"), "skip-rule");
    assertEq(mod.plan.plannerCategory("navigation"), "navigation");
    assertEq(mod.plan.plannerCategory("randomization"), "randomization");
  });

  test("an unknown facet passes through untouched rather than being filed as a near-neighbour", async () => {
    const mod = await worker();
    assertEq(mod.plan.plannerCategory("some-future-facet"), "some-future-facet");
  });
});

// ===========================================================================
// 5. EVERY NEW SHORTFALL IS ON THE PLAN EVEN WHEN IT DID NOT BITE
// ===========================================================================

suite("D36 — the new limitation codes are emitted at COUNT ZERO", () => {
  test("'we looked and found none' stays distinguishable from 'nobody looked'", async () => {
    const mod = await worker();
    const codes = mod.plan.PLAN_LIMITATION_CODES;

    // A clean plan: one route case with a label, on a path that answers its question once.
    // Every code below must still appear, at zero.
    const result = mod.plan.materializeCasePaths(
      [basePath()],
      [routeCase("fi_clean", { code: "1", label: "Yes" }, "Q7")],
      WITNESS,
    );
    assertEq(result.unassignedCaseIds.length, 0);
    assertEq(result.unresolvedRouteCodes.length, 0);

    // The rows themselves are built in `planStage`; this pins the CODE SET so a later edit
    // cannot drop one and leave the reader unable to tell zero from absent.
    for (const key of [
      "unresolvedRouteCodes",
      "caseWithoutTargetQuestion",
      "caseWithoutStimulus",
      "caseTargetNotOnWitnessPath",
      "caseWithoutWitnessPath",
    ]) {
      assert(typeof codes[key] === "string" && codes[key].length > 0, `limitation code ${key} is missing`);
    }
    assertEq(new Set(Object.values(codes)).size, Object.values(codes).length, "two limitation codes share a string");
  });
});

// ===========================================================================
// 6. SURVIVAL HINTS — documented screen-outs reach the walker as INPUT, never EVIDENCE
// ===========================================================================

/**
 * The model shapes are exactly what `plan-core.js` emits at plan time (`model.questions`
 * with boolean `options[].terminates`, `questions[].terminates`, `model.terminals`) — the
 * data that was ALWAYS in the plan artifact while the driver's position-1 default walked
 * s2-clean into its documented S3 screen-out.
 */
const survivalModel = () => ({
  question_order: ["S3", "Q7"],
  questions: [
    {
      id: "S3",
      index: 0,
      options: [
        { code: "1", text: "Market research", fixed: false, specify: false, terminates: true },
        { code: "2", text: "Software", fixed: false, specify: false, terminates: false },
      ],
      terminates: [{ answer: "Market research", terminal: "TERM-1" }],
    },
    { id: "Q7", index: 1, options: [{ code: "1", text: "Yes", terminates: false }], terminates: [] },
  ],
  terminals: [{ id: "TERM-1", kind: "screen-out", trigger: { question: "S3", answers: ["Market research"] } }],
});

const survivalPath = (over = {}) => ({
  id: "FLOOR-SH1",
  tier: 1,
  kind: "floor",
  intent: "walk to the end",
  decisions: [
    {
      question: "S3",
      select: [],
      source: "default:navigator-discretion",
      question_text: "Which industry do you work in for your main job?",
    },
    { question: "Q7", select: ["Yes"], source: "constraint" },
  ],
  skipped_questions: [],
  terminated_at: null,
  witnesses: [],
  witness_notes: [],
  needs_repeats: [],
  steps: 4,
  ...over,
});

suite("D36 — survival hints: stamped from the model's own terminate data, additively", () => {
  test("documented terminating labels land on discretion decisions AND on the path's hints", async () => {
    const mod = await worker();
    const p = survivalPath();
    const result = mod.plan.stampSurvivalHints([p], survivalModel());

    assertEq(JSON.stringify(p.decisions[0].avoid_labels), JSON.stringify(["Market research"]));
    assertEq(p.decisions[1].avoid_labels, undefined, "a question with no documented trigger must not be stamped");
    // Path-level hints cover the screens NO decision binds; the wording rides along so a
    // reader can see which screen the hint is about.
    assertEq(
      JSON.stringify(p.survival_hints),
      JSON.stringify([
        {
          question: "S3",
          question_text: "Which industry do you work in for your main job?",
          avoid_labels: ["Market research"],
        },
      ]),
    );
    assertEq(result.decisionsStamped, 1);
    assertEq(result.pathsStamped, 1);
  });

  test("a path that INTENDS termination is not stamped — steering it would fight the experiment", async () => {
    const mod = await worker();
    const p = survivalPath({ terminated_at: { question: "S3", answer: "Market research", terminal: "TERM-1" } });
    const result = mod.plan.stampSurvivalHints([p], survivalModel());

    assertEq(p.decisions[0].avoid_labels, undefined);
    assertEq(p.survival_hints, undefined);
    assertEq(result.decisionsStamped, 0);
    assertEq(result.pathsStamped, 0);
  });

  test("sealed stimulus is sealed: a case_action decision is never written to", async () => {
    const mod = await worker();
    const p = survivalPath();
    p.decisions[0].case_action = {
      facetInstanceId: "fi_sealed",
      targetQuestionId: "S3",
      kind: "route",
      routeAnswer: { code: "1", label: "Market research" },
      boundaryInput: null,
    };
    mod.plan.stampSurvivalHints([p], survivalModel());

    assertEq(p.decisions[0].avoid_labels, undefined, "the stamp wrote onto sealed stimulus");
    // The PATH's hints are unaffected: they serve unbound screens, which sealed stimulus is not.
    assertEq(p.survival_hints.length, 1);
  });

  test("terminal-adjacency: just-triggers probes are skipped, just-avoids probes are stamped", async () => {
    const mod = await worker();
    const triggers = survivalPath({ id: "EXP-TRIG", adjacency: { side: "just-triggers", terminal: "TERM-1" } });
    const avoids = survivalPath({ id: "EXP-AVOID", adjacency: { side: "just-avoids", terminal: "TERM-1" } });
    mod.plan.stampSurvivalHints([triggers, avoids], survivalModel());

    assertEq(triggers.decisions[0].avoid_labels, undefined, "a just-triggers probe exists to take the trigger");
    assertEq(triggers.survival_hints, undefined);
    assertEq(JSON.stringify(avoids.decisions[0].avoid_labels), JSON.stringify(["Market research"]));
  });

  test("stamping is SIGNATURE-NEUTRAL: pathSignature is byte-identical before and after", async () => {
    const mod = await worker();
    const p = survivalPath();
    const before = mod.plan.pathSignature(structuredClone(p.decisions));
    mod.plan.stampSurvivalHints([p], survivalModel());
    const after = mod.plan.pathSignature(p.decisions);

    // Two paths that differ only in the hints stamped on them are the SAME experiment. A
    // signature that moved here would mean the hint entered a hashed field — `select` being
    // the leak vector that also fabricates missing-option evidence.
    assertEq(after, before, "stamping survival hints changed the path's identity");
  });

  test("a stamped discretion decision stays INVISIBLE to the exercised gate", async () => {
    const mod = await worker();
    const p = survivalPath();
    mod.plan.stampSurvivalHints([p], survivalModel());

    // The gate reads select/action/text_entry/case_action. A hint that made a delegated
    // decision constraining would move the coverage denominator on stimulus metadata.
    assertEq(mod.executeBatch.isConstrainingDecision(p.decisions[0]), false, "a hint moved the exercised gate");
    // The same call CAN discriminate: the constrained sibling on the same path is counted.
    assertEq(mod.executeBatch.isConstrainingDecision(p.decisions[1]), true);
  });

  test("screen-outs with no stampable label are counted; completion endpoints are not", async () => {
    const mod = await worker();
    const codes = mod.plan.PLAN_LIMITATION_CODES;
    assert(typeof codes.survivalHintsUnstampable === "string" && codes.survivalHintsUnstampable.length > 0);

    const model = survivalModel();
    model.terminals = [
      ...model.terminals,
      // The document mentions a screen-out but no triggering answer resolved to a label —
      // the walker cannot steer around this one, and that has to be COUNTED, not implied.
      { id: "TERM-2", kind: "screen-out", trigger: null, statement: "close the interview if quota is full" },
      // A completion endpoint is a successful end; "avoiding" it would sabotage every walk.
      { id: "TERM-3", kind: "completion", trigger: null },
    ];
    const flagged = mod.plan.stampSurvivalHints([survivalPath()], model);
    assertEq(flagged.unstampable.length, 1);
    assertEq(flagged.unstampable[0].terminal, "TERM-2");

    const clean = mod.plan.stampSurvivalHints([survivalPath()], survivalModel());
    assertEq(clean.unstampable.length, 0, "'we looked and found none' must be a real zero, not an absence");
  });
});

// ===========================================================================
// 6b. SEALED ROUTE DESTINATIONS — the TYPED trigger source the prose miners starve without
// ===========================================================================
//
// Measured on the 2026-08-16 live run: the sealed contract stated 9 terminating S10 role
// labels and 2 continue labels as ROUTE cases (`case.kind: "route"`, requirement facet
// `terminate` / `skip-rule`, `routeAnswer.label` verbatim), but S10 mined ZERO options, so
// `buildTerminals` resolved nothing, zero hints were stamped, and every navigator-default
// walk answered the screener position-1 and screened out. These tests pin the typed path:
// route cases feed the hint index DIRECTLY, with no option list and no prose in between.

const routeRevision = (over = {}) => ({
  requirements: [
    { requirementLineageId: "REQ-T", facet: "terminate" },
    { requirementLineageId: "REQ-C", facet: "skip-rule" },
    { requirementLineageId: "REQ-X", facet: "piping" },
  ],
  facetInstances: [
    {
      facetInstanceId: "fi_term",
      requirementLineageId: "REQ-T",
      targetQuestionId: "S10",
      case: { kind: "route", routeAnswer: { code: "17", label: "Physician" } },
    },
    {
      facetInstanceId: "fi_cont",
      requirementLineageId: "REQ-C",
      targetQuestionId: "S10",
      case: { kind: "route", routeAnswer: { code: "19", label: "Director of Population Health" } },
    },
    // A route under any OTHER facet states a destination this pass must not guess about.
    {
      facetInstanceId: "fi_pipe",
      requirementLineageId: "REQ-X",
      targetQuestionId: "S10",
      case: { kind: "route", routeAnswer: { code: "20", label: "Piped Role" } },
    },
    // Typed-field hygiene: no question, no label, or not a route => never a destination.
    {
      facetInstanceId: "fi_noq",
      requirementLineageId: "REQ-T",
      targetQuestionId: null,
      case: { kind: "route", routeAnswer: { code: "1", label: "Orphan" } },
    },
    {
      facetInstanceId: "fi_nolabel",
      requirementLineageId: "REQ-T",
      targetQuestionId: "S10",
      case: { kind: "route", routeAnswer: { code: "2", label: "  " } },
    },
    {
      facetInstanceId: "fi_notroute",
      requirementLineageId: "REQ-T",
      targetQuestionId: "S10",
      case: { kind: "rendered-state", routeAnswer: { code: "3", label: "Rendered" } },
    },
  ],
  ...over,
});

/** A model that mined NOTHING — the exact starvation measured on the live run. */
const emptyModel = () => ({ questions: [], terminals: [] });

suite("D36 — sealed route destinations feed survival hints without the prose miners", () => {
  test("typed mining: facet terminate => terminate, skip-rule => continue, anything else skipped", async () => {
    const mod = await worker();
    const routes = mod.plan.sealedRouteDestinations(routeRevision());
    assertEq(
      JSON.stringify(routes),
      JSON.stringify([
        { question: "S10", label: "Physician", kind: "terminate" },
        { question: "S10", label: "Director of Population Health", kind: "continue" },
      ]),
    );
  });

  test("THE MEASURED STARVATION: empty model + sealed routes still stamps avoid AND prefer", async () => {
    const mod = await worker();
    const p = survivalPath({
      decisions: [{ question: "S10", select: [], source: "default:navigator-discretion" }],
    });
    const result = mod.plan.stampSurvivalHints([p], emptyModel(), mod.plan.sealedRouteDestinations(routeRevision()));

    assertEq(JSON.stringify(p.decisions[0].avoid_labels), JSON.stringify(["Physician"]));
    assertEq(JSON.stringify(p.decisions[0].prefer_labels), JSON.stringify(["Director of Population Health"]));
    assertEq(
      JSON.stringify(p.survival_hints),
      JSON.stringify([
        { question: "S10", avoid_labels: ["Physician"], prefer_labels: ["Director of Population Health"] },
      ]),
    );
    assertEq(result.decisionsStamped, 1);
    assertEq(result.pathsStamped, 1);
    assertEq(
      JSON.stringify(result.questions),
      JSON.stringify([
        { question: "S10", avoid_labels: ["Physician"], prefer_labels: ["Director of Population Health"] },
      ]),
    );
  });

  test("a label the contract states BOTH ways lands in avoid, never in prefer", async () => {
    const mod = await worker();
    const conflicted = routeRevision();
    conflicted.facetInstances.push({
      facetInstanceId: "fi_conflict",
      requirementLineageId: "REQ-T",
      targetQuestionId: "S10",
      case: { kind: "route", routeAnswer: { code: "19", label: "Director of Population Health" } },
    });
    const { avoid, prefer } = mod.plan.survivalAvoidIndex(emptyModel(), mod.plan.sealedRouteDestinations(conflicted));
    assert(avoid.get("S10").includes("Director of Population Health"), "the terminate reading must win");
    assertEq(prefer.get("S10"), undefined, "a conflicted label must not be preferred");
  });

  test("routes compose with the model's own triggers instead of replacing them", async () => {
    const mod = await worker();
    const { avoid, prefer } = mod.plan.survivalAvoidIndex(
      survivalModel(),
      mod.plan.sealedRouteDestinations(routeRevision()),
    );
    assertEq(JSON.stringify(avoid.get("S3")), JSON.stringify(["Market research"]));
    assertEq(JSON.stringify(avoid.get("S10")), JSON.stringify(["Physician"]));
    assertEq(JSON.stringify(prefer.get("S10")), JSON.stringify(["Director of Population Health"]));
  });
});

// ===========================================================================
// 7. CONTRACT IDENTITY INCLUDES THE SEMANTICS, NOT JUST THE ROW IDS
// ===========================================================================

const semanticHashContract = () => ({
  obligations: [
    {
      id: "OBL-HASH-1",
      category: "validation",
      statement: "Q1 requires at least one answer.",
      stimulus: ["Q1: submit without answering"],
      expected_observable: "Q1 remains visible and reports a validation message.",
      detail: { severity: "blocking", browser: { observable: true, mode: "interaction" } },
    },
  ],
  ambiguities: [
    { id: "AMB-HASH-1", question: "Whether the rule applies after returning with Back.", status: "unresolved" },
  ],
  unverifiable_from_browser: [
    { id: "UNV-HASH-1", statement: "The response is retained for thirty days.", reason: "server-side retention" },
  ],
  provenance: { source: "volatile/path/one.json", loadedAt: "2026-08-09T01:02:03.000Z" },
  contractHash: "sha256:self-reference-is-not-semantic",
});

suite("Planner contract identity: semantic rows, not ids alone", () => {
  test("THE PRODUCTION DEFECT: keeping an obligation id but changing its statement changes the hash", async () => {
    const mod = await worker();
    const before = semanticHashContract();
    const after = structuredClone(before);
    after.obligations[0].statement = "Q1 permits an unanswered submission.";

    assert(
      mod.plan.hashContract(before) !== mod.plan.hashContract(after),
      "an obligation payload changed behind the same id but the Worker planner hash did not",
    );
  });

  test("ambiguity and unverifiable payloads independently participate in the denominator hash", async () => {
    const mod = await worker();
    const base = semanticHashContract();
    const changedAmbiguity = structuredClone(base);
    changedAmbiguity.ambiguities[0].status = "resolved";
    const changedUnverifiable = structuredClone(base);
    changedUnverifiable.unverifiable_from_browser[0].reason = "requires a database audit";

    const hash = mod.plan.hashContract(base);
    assert(hash !== mod.plan.hashContract(changedAmbiguity), "an ambiguity payload change was invisible to the hash");
    assert(hash !== mod.plan.hashContract(changedUnverifiable), "an unverifiable payload change was invisible to the hash");
  });

  test("object key order, denominator row order and volatile provenance do not change semantic identity", async () => {
    const mod = await worker();
    const left = semanticHashContract();
    left.obligations.push({ id: "OBL-HASH-2", statement: "Q2 is optional.", category: "question" });

    const right = {
      contractHash: "sha256:a-different-self-hash",
      provenance: { loadedAt: "2030-01-01T00:00:00.000Z", source: "somewhere/else.json" },
      unverifiable_from_browser: left.unverifiable_from_browser.map((row) => ({
        reason: row.reason,
        statement: row.statement,
        id: row.id,
      })),
      ambiguities: left.ambiguities.map((row) => ({ status: row.status, question: row.question, id: row.id })),
      obligations: [...left.obligations].reverse().map((row) => {
        if (row.id === "OBL-HASH-2") return { category: row.category, statement: row.statement, id: row.id };
        return {
          stimulus: row.stimulus,
          statement: row.statement,
          id: row.id,
          expected_observable: row.expected_observable,
          detail: { browser: { mode: "interaction", observable: true }, severity: "blocking" },
          category: row.category,
        };
      }),
    };

    assertEq(mod.plan.hashContract(left), mod.plan.hashContract(right));
  });

  test("the pipeline and Worker ports produce the same semantic hash", async () => {
    const mod = await worker();
    const contract = semanticHashContract();
    assertEq(mod.plan.hashContract(contract), pipelineHashContract(contract));

    contract.obligations[0].expected_observable = "Q1 advances without a validation message.";
    assertEq(mod.plan.hashContract(contract), pipelineHashContract(contract));
  });
});

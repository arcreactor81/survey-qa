/**
 * D18 — typed cases receive independent witness paths.
 *
 * A requirement-level planner path is only a template. Route/boundary siblings are
 * incompatible experiments unless proved otherwise, so materialization clones the template
 * once per actionable typed case and binds one exact sealed stimulus to each clone.
 */

import { assert, assertEq, assertThrows, suite, test } from "../testkit.mjs";
import { worker } from "./_helpers.mjs";

const routeCase = (id, answer, target = "Q7", requirement = "req_route") => ({
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
    expectedDestination: { questionId: "Q2", screen: null, terminal: null },
  },
  expectationGap: null,
  screen: target,
  label: id,
});

const boundaryCase = (id, boundary, target = "Q3", requirement = "req_boundary") => ({
  facetInstanceId: id,
  requirementLineageId: requirement,
  requirementVersionId: `reqv_${id}`,
  caseVersionId: `cv_${id}`,
  floorCase: true,
  targetQuestionId: target,
  expansionCertificate: `cert_${id}`,
  case: {
    kind: "boundary",
    routeAnswer: null,
    boundaryInput: boundary,
    configuration: null,
    expectedDestination: null,
  },
  expectationGap: null,
  screen: target,
  label: id,
});

const genericCase = (id, target = "Q1", requirement = "req_generic") => ({
  facetInstanceId: id,
  requirementLineageId: requirement,
  requirementVersionId: `reqv_${id}`,
  caseVersionId: `cv_${id}`,
  floorCase: true,
  targetQuestionId: target,
  expansionCertificate: `cert_${id}`,
  case: {
    kind: "rendered-state",
    routeAnswer: null,
    boundaryInput: null,
    configuration: null,
    expectedDestination: null,
  },
  expectationGap: { code: "NO_TYPED_PREDICATE_FOR_KIND", detail: "model verifier not wired" },
  screen: target,
  label: id,
});

const path = () => ({
  id: "FLOOR-001",
  tier: 1,
  kind: "floor",
  intent: "cover the requirement",
  decisions: [
    { question: "Q1", select: ["Start"], source: "default" },
    { question: "Q3", select: [], source: "default" },
    { question: "Q7", select: ["Maybe"], source: "default" },
  ],
  skipped_questions: [],
  terminated_at: null,
  witnesses: ["req_route", "req_boundary", "req_generic"],
  witness_notes: [],
  needs_repeats: [],
  steps: 5,
  signature: "sha256:base",
});

const assignmentFor = (result, caseId) =>
  result.assignments.find((assignment) => assignment.caseIds.includes(caseId));

const pathFor = (result, caseId) => {
  const assignment = assignmentFor(result, caseId);
  return result.paths.find((candidate) => candidate.id === assignment?.pathId);
};

suite("D18 — typed-case paths are independent", () => {
  test("Yes → Q2 and No → Q2 become separate one-case paths", async () => {
    const mod = await worker();
    const base = path();
    const before = JSON.stringify(base);
    const cases = [
      routeCase("fi_yes", { code: "1", label: "Yes" }),
      routeCase("fi_no", { code: "2", label: "No" }),
    ];

    const result = mod.plan.materializeCasePaths([base], cases, { req_route: base.id });

    assertEq(result.paths.length, 3, "base coverage path plus two case-specific clones");
    assertEq(result.assignments.length, 3);
    assertEq(assignmentFor(result, "fi_yes").caseIds.length, 1);
    assertEq(assignmentFor(result, "fi_no").caseIds.length, 1);
    assert(assignmentFor(result, "fi_yes").pathId !== assignmentFor(result, "fi_no").pathId);
    assertEq(pathFor(result, "fi_yes").decisions.find((d) => d.question === "Q7").select[0], "Yes");
    assertEq(pathFor(result, "fi_no").decisions.find((d) => d.question === "Q7").select[0], "No");
    assertEq(JSON.stringify(base), before, "materialization must not mutate its base template");
    assertEq(result.caseOrder.join(","), "fi_yes,fi_no");
  });

  test("same-label answers with different codes retain distinct typed identities", async () => {
    const mod = await worker();
    const base = path();
    const cases = [
      routeCase("fi_code_1", { code: "1", label: "Yes" }),
      routeCase("fi_code_2", { code: "2", label: "Yes" }),
    ];

    const result = mod.plan.materializeCasePaths([base], cases, { req_route: base.id });
    const first = pathFor(result, "fi_code_1").decisions.find((d) => d.question === "Q7");
    const second = pathFor(result, "fi_code_2").decisions.find((d) => d.question === "Q7");

    assertEq(first.case_action.routeAnswer.code, "1");
    assertEq(second.case_action.routeAnswer.code, "2");
    assert(first.case_action.facetInstanceId !== second.case_action.facetInstanceId);
    assert(pathFor(result, "fi_code_1").signature !== pathFor(result, "fi_code_2").signature);
  });

  test("a code-only route never disguises the code as a fuzzy label", async () => {
    const mod = await worker();
    const base = path();
    const result = mod.plan.materializeCasePaths(
      [base],
      [routeCase("fi_code_only", { code: "8", label: null })],
      { req_route: base.id },
    );
    const decision = pathFor(result, "fi_code_only").decisions.find((d) => d.question === "Q7");

    assertEq(decision.select.length, 0, "code-only targeting lives in case_action, not select");
    assertEq(decision.case_action.routeAnswer.code, "8");
    assertEq(decision.case_action.routeAnswer.label, null);
  });

  test("boundary siblings preserve exact values and produce distinct signatures", async () => {
    const mod = await worker();
    const base = path();
    const cases = [
      boundaryCase("fi_max", { bound: "max", value: "150", expectedOutcome: "accepted" }),
      boundaryCase("fi_above", { bound: "above-max", value: "151", expectedOutcome: "rejected" }),
    ];
    const result = mod.plan.materializeCasePaths([base], cases, { req_boundary: base.id });
    const maxPath = pathFor(result, "fi_max");
    const abovePath = pathFor(result, "fi_above");

    assertEq(maxPath.decisions.find((d) => d.question === "Q3").text_entry.value, "150");
    assertEq(abovePath.decisions.find((d) => d.question === "Q3").text_entry.value, "151");
    assert(maxPath.signature !== abovePath.signature, "equal-length values are different experiments");
  });

  test("empty and non-empty boundary siblings cannot inherit one another's action", async () => {
    const mod = await worker();
    const base = path();
    base.decisions.find((d) => d.question === "Q3").action = "leave-blank-and-continue";
    base.decisions.find((d) => d.question === "Q3").text_entry = { required: false, value: "" };
    const cases = [
      boundaryCase("fi_empty", { bound: "empty", value: null, expectedOutcome: "rejected" }),
      boundaryCase("fi_value", { bound: "max", value: "150", expectedOutcome: "accepted" }),
    ];
    const result = mod.plan.materializeCasePaths([base], cases, { req_boundary: base.id });
    const empty = pathFor(result, "fi_empty").decisions.find((d) => d.question === "Q3");
    const value = pathFor(result, "fi_value").decisions.find((d) => d.question === "Q3");

    assertEq(empty.action, "leave-blank-and-continue");
    assertEq(empty.text_entry.value, "");
    assert(!("action" in value), "non-empty clone must clear inherited leave-blank");
    assertEq(value.text_entry.value, "150");
  });

  test("arbitrary question identifiers are matched literally", async () => {
    const mod = await worker();
    const base = path();
    base.decisions.push({ question: "question:alpha/β-17", select: ["Old"], source: "default" });
    const fi = routeCase(
      "fi_arbitrary",
      { code: "A", label: "New" },
      "question:alpha/β-17",
      "req_arbitrary",
    );
    const result = mod.plan.materializeCasePaths([base], [fi], { req_arbitrary: base.id });

    assertEq(pathFor(result, "fi_arbitrary").decisions.find((d) => d.question === "question:alpha/β-17").select[0], "New");
  });

  test("missing or duplicate target decisions are named unassigned cases", async () => {
    const mod = await worker();
    const missingBase = path();
    const missing = routeCase("fi_missing", { code: "1", label: "Yes" }, "Q99");
    const missingResult = mod.plan.materializeCasePaths([missingBase], [missing], { req_route: missingBase.id });
    assertEq(missingResult.unassignedCaseIds[0], "fi_missing");
    assert(missingResult.warnings[0].includes("contains 0 decisions"));

    const duplicateBase = path();
    duplicateBase.decisions.push({ question: "Q7", select: ["Other"], source: "duplicate" });
    const duplicate = routeCase("fi_duplicate", { code: "1", label: "Yes" });
    const duplicateResult = mod.plan.materializeCasePaths([duplicateBase], [duplicate], { req_route: duplicateBase.id });
    assertEq(duplicateResult.unassignedCaseIds[0], "fi_duplicate");
    assert(duplicateResult.warnings[0].includes("contains 2 decisions"));
  });

  test("untyped cases stay on the base assignment and receive no synthetic clone", async () => {
    const mod = await worker();
    const base = path();
    const result = mod.plan.materializeCasePaths([base], [genericCase("fi_generic")], { req_generic: base.id });

    assertEq(result.paths.length, 1);
    assertEq(result.assignments[0].pathId, base.id);
    assertEq(result.assignments[0].caseIds.join(","), "fi_generic");
  });

  test("case accounting rejects missing, duplicate, foreign, and duplicate-sealed ids", async () => {
    const mod = await worker();

    await assertThrows(() => mod.plan.assertExactCasePermutation(["a", "b"], ["a"], "missing"), "not an exact");
    await assertThrows(() => mod.plan.assertExactCasePermutation(["a", "b"], ["a", "a"], "duplicate"), "duplicates");
    await assertThrows(() => mod.plan.assertExactCasePermutation(["a"], ["foreign"], "foreign"), "not an exact");
    await assertThrows(() => mod.plan.assertExactCasePermutation(["a", "a"], ["a", "a"], "sealed"), "sealed");
  });

  test("literal text values are identity-bearing even without case metadata", async () => {
    const mod = await worker();
    const decision = (value) => [{ question: "Q3", select: [], action: null, text_entry: { required: true, value } }];
    assert(
      mod.plan.pathSignature?.(decision("150")) !== mod.plan.pathSignature?.(decision("151")),
      "same-length text values must not share a path signature",
    );
  });

  test("materialization is deterministic over identical sealed inputs", async () => {
    const mod = await worker();
    const cases = [
      routeCase("fi_yes", { code: "1", label: "Yes" }),
      boundaryCase("fi_above", { bound: "above-max", value: "151", expectedOutcome: "rejected" }),
    ];
    const witness = { req_route: "FLOOR-001", req_boundary: "FLOOR-001" };

    const first = mod.plan.materializeCasePaths([path()], cases, witness);
    const second = mod.plan.materializeCasePaths([path()], cases, witness);
    assertEq(JSON.stringify(second), JSON.stringify(first));
  });
});


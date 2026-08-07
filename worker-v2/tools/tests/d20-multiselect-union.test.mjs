/**
 * D20 — the typed answer must not DESTROY a multi-select gating selection.
 *
 * THE DEFECT THIS CLOSES. `decision.select` is what the browser driver clicks. On a
 * multi-select question the planner deliberately chooses a SET — "select A and B, because
 * Q8 is only asked of respondents who picked B" — and a typed route case naming "C" is an
 * ADDITIONAL answer to drive, not a replacement for the plan's whole selection. When
 * materialization overwrote the list with `[label]`, the gating selections vanished, the
 * survey correctly skipped the downstream question the walk was supposed to reach, and the
 * verifier reported a CONTRADICTED destination: a fabricated defect verdict against a
 * survey that behaved exactly as documented.
 *
 * The union rule was written once in a helper that the pipeline then stopped calling. These
 * tests bind to `materializeCasePaths` — the function `planStage` actually runs — so the
 * property cannot go dead again without a red test. `tools/mutate-plan.mjs` is the evidence
 * they can fail.
 *
 * They also pin the property the parent asked about under the name "conflict semantics":
 * two cases naming different answers to ONE single-select question must never silently
 * lose one. Materialization satisfies that structurally — one clone per case, so BOTH are
 * driven on independent walks — which is why no `conflicts[]` report exists. The last test
 * asserts the guarantee in that stronger form.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { worker } from "./_helpers.mjs";

/** Sealed route case, shaped as the expander materializes one. */
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
    expectedDestination: { questionId: "Q8", screen: null, terminal: null },
  },
  expectationGap: null,
  screen: target,
  label: id,
});

/**
 * A base walk whose Q5 selection is MULTI (two labels) and whose Q7 selection is single.
 * The comment on Q5 is the whole point: B is not decoration, it is the reason Q8 is on
 * this walk at all.
 */
const basePath = () => ({
  id: "FLOOR-001",
  tier: 1,
  kind: "floor",
  intent: "cover the requirement",
  decisions: [
    // MULTI-SELECT. "B" gates Q8 downstream; dropping it makes Q8 unreachable.
    { question: "Q5", select: ["A", "B"], source: "default" },
    { question: "Q7", select: ["Maybe"], source: "default" },
    { question: "Q8", select: ["Downstream"], source: "default" },
  ],
  skipped_questions: [],
  terminated_at: null,
  witnesses: ["req_route"],
  witness_notes: [],
  needs_repeats: [],
  steps: 5,
  signature: "sha256:base",
});

const assignmentFor = (result, caseId) => result.assignments.find((a) => a.caseIds.includes(caseId));

const pathFor = (result, caseId) => {
  const assignment = assignmentFor(result, caseId);
  return result.paths.find((p) => p.id === assignment?.pathId);
};

const selectAt = (result, caseId, question) =>
  pathFor(result, caseId).decisions.find((d) => d.question === question).select;

suite("D20 — multi-select selections survive typed-case materialization", () => {
  test("THE ONE THAT MATTERS: a typed answer UNIONS into a multi-select, never replaces it", async () => {
    const mod = await worker();
    const base = basePath();
    const result = mod.plan.materializeCasePaths(
      [base],
      [routeCase("fi_multi", { code: "3", label: "C" }, "Q5")],
      { req_route: base.id },
    );

    const select = selectAt(result, "fi_multi", "Q5");
    assertEq(select.length, 3, "the planner's two gating selections plus the typed answer");
    assert(select.includes("A"), "planner selection A was destroyed");
    assert(select.includes("B"), "planner selection B was destroyed — Q8 becomes unreachable");
    assert(select.includes("C"), "the typed answer must still be driven");
    // The gated downstream question is still on the walk, which is what B was protecting.
    assert(
      pathFor(result, "fi_multi").decisions.some((d) => d.question === "Q8"),
      "the downstream question the gating selection protects must remain on the walk",
    );
  });

  test("the union is idempotent — a typed label the planner already picked is not duplicated", async () => {
    const mod = await worker();
    const base = basePath();
    const result = mod.plan.materializeCasePaths(
      [base],
      [routeCase("fi_dup", { code: "1", label: "A" }, "Q5")],
      { req_route: base.id },
    );

    const select = selectAt(result, "fi_dup", "Q5");
    assertEq(select.length, 2, "A was already selected; the set must not grow");
    assertEq(select.filter((s) => s === "A").length, 1, "no duplicate click on the same option");
    assert(select.includes("B"), "the other gating selection is still required");
  });

  test("a SINGLE-select question still REPLACES — a radio must not be clicked twice", async () => {
    const mod = await worker();
    const base = basePath();
    const result = mod.plan.materializeCasePaths(
      [base],
      [routeCase("fi_single", { code: "1", label: "Yes" }, "Q7")],
      { req_route: base.id },
    );

    const select = selectAt(result, "fi_single", "Q7");
    assertEq(select.join(","), "Yes", "the planner's default must be replaced, not appended to");
    assert(!select.includes("Maybe"), "appending on a radio lets DOM order decide the answer");
  });

  test("a code-only route keeps the multi-select gating selections it cannot name", async () => {
    const mod = await worker();
    const base = basePath();
    const result = mod.plan.materializeCasePaths(
      [base],
      [routeCase("fi_codeonly", { code: "9", label: null }, "Q5")],
      { req_route: base.id },
    );

    const decision = pathFor(result, "fi_codeonly").decisions.find((d) => d.question === "Q5");
    assertEq(decision.select.join(","), "A,B", "an unnamed target must not clear the gating set");
    assertEq(decision.case_action.routeAnswer.code, "9", "the exact target lives in case_action");
    assertEq(decision.case_action.routeAnswer.label, null);
  });

  test("NEVER A SILENT LOSS: two cases on ONE single-select question both get driven", async () => {
    const mod = await worker();
    const base = basePath();
    const cases = [
      routeCase("fi_yes", { code: "1", label: "Yes" }, "Q7"),
      routeCase("fi_no", { code: "2", label: "No" }, "Q7"),
    ];

    const result = mod.plan.materializeCasePaths([base], cases, { req_route: base.id });

    // Neither case may be dropped from the denominator...
    assertEq(result.unassignedCaseIds.length, 0, "no case may be quietly unassigned");
    assertEq(result.caseOrder.join(","), "fi_yes,fi_no");
    // ...nor may they contend for one decision: each gets its own walk.
    assert(
      assignmentFor(result, "fi_yes").pathId !== assignmentFor(result, "fi_no").pathId,
      "two answers to one radio cannot share a walk",
    );
    assertEq(selectAt(result, "fi_yes", "Q7").join(","), "Yes", "the FIRST case's answer must survive");
    assertEq(selectAt(result, "fi_no", "Q7").join(","), "No", "the SECOND case's answer must survive");
    assertEq(assignmentFor(result, "fi_yes").caseIds.length, 1, "one sealed stimulus per walk");
    assertEq(assignmentFor(result, "fi_no").caseIds.length, 1);
  });

  test("the signature is re-stamped over the ENRICHED decisions, not the planner's", async () => {
    const mod = await worker();
    const base = basePath();
    const before = JSON.stringify(base);
    const result = mod.plan.materializeCasePaths(
      [base],
      [routeCase("fi_multi", { code: "3", label: "C" }, "Q5")],
      { req_route: base.id },
    );

    const clone = pathFor(result, "fi_multi");
    assert(clone.signature !== base.signature, "a union that changed the selection must change the identity");
    assertEq(clone.signature, mod.plan.pathSignature(clone.decisions, clone.back_navigation));
    assertEq(JSON.stringify(base), before, "materialization must not mutate its base template");
  });
});

/**
 * D17 — the routing graph compiled from the SEALED contract revision.
 *
 * The graph is an obligation ledger, not an observation. It says what MUST exist
 * according to the document. The site crawler produces a second graph of what DOES
 * exist, and the diff is the comparison.
 */
import { assert, assertEq, suite, test } from "../testkit.mjs";
import { worker } from "./_helpers.mjs";
import { contractBody } from "../fixtures/v2-fixture.mjs";

suite("D17 — compile the document's routing graph", () => {
  test("a contract with route cases produces nodes and edges", async () => {
    const mod = await worker();
    const body = contractBody();

    // Add a routing requirement with a typed facet instance
    body.requirements.push({
      requirementLineageId: "req_route001",
      requirementVersionId: "reqv_route001",
      semanticFingerprint: "fp_route_q7_to_q9",
      scope: "question:Q7",
      quantifier: "specific",
      selector: "Q7",
      exceptions: [],
      facet: "routing",
      assertionStatus: "entailed",
      testability: "browser-observable",
      notBrowserObservableReason: null,
      sourceAtoms: [{ blockId: "B3", kind: "paragraph", coords: null, role: "instruction", atomTextHash: "sha256:ccc" }],
      composition: null,
      normativeStatement: "Answering Q7 'Can't remember' must route to Q9.",
      displayQuote: "IF Q7=3 GO TO Q9",
      retiredAt: null,
    });

    body.requirements.push({
      requirementLineageId: "req_route002",
      requirementVersionId: "reqv_route002",
      semanticFingerprint: "fp_route_q9_to_end",
      scope: "question:Q9",
      quantifier: "specific",
      selector: "Q9",
      exceptions: [],
      facet: "routing",
      assertionStatus: "entailed",
      testability: "browser-observable",
      notBrowserObservableReason: null,
      sourceAtoms: [{ blockId: "B4", kind: "paragraph", coords: null, role: "instruction", atomTextHash: "sha256:ddd" }],
      composition: null,
      normativeStatement: "Answering Q9 'No' must terminate the survey.",
      displayQuote: "IF Q9=No THEN TERMINATE",
      retiredAt: null,
    });

    // Add facet instances with typed route cases
    body.facetInstances = [
      {
        facetInstanceId: "fi_route001",
        requirementLineageId: "req_route001",
        requirementVersionId: "reqv_route001",
        caseVersionId: "cv_route001",
        floorCase: true,
        targetQuestionId: "Q7",
        expansionCertificate: "route-answer-code-3",
        case: {
          kind: "route",
          routeAnswer: { code: "3", label: "Can't remember" },
          expectedDestination: { questionId: "Q9", screen: null, terminal: null },
          boundaryInput: null,
          configuration: null,
        },
        expectationGap: null,
        screen: null,
        label: "Q7 answer 'Can't remember' → Q9",
      },
      {
        facetInstanceId: "fi_route002",
        requirementLineageId: "req_route002",
        requirementVersionId: "reqv_route002",
        caseVersionId: "cv_route002",
        floorCase: true,
        targetQuestionId: "Q9",
        expansionCertificate: "route-answer-state-no",
        case: {
          kind: "route",
          routeAnswer: { code: "2", label: "No" },
          expectedDestination: { questionId: null, screen: null, terminal: "screenout" },
          boundaryInput: null,
          configuration: null,
        },
        expectationGap: null,
        screen: null,
        label: "Q9 answer 'No' → terminate",
      },
    ];

    const model = mod.structure.compileStructureModel(body);
    assert(model !== null, "must produce a graph from a non-empty contract");

    assertEq(Object.keys(model.nodes).length, 3, "Q7, Q9, and TERMINATE:screenout");
    assert(model.nodes["Q7"], "Q7 must be a node");
    assert(model.nodes["Q9"], "Q9 must be a node");
    assert(model.nodes["TERMINATE:screenout"], "terminal node must exist");

    // Q7 options
    const q7 = model.nodes["Q7"];
    assertEq(q7.options.length, 1);
    assertEq(q7.options[0].code, "3");
    assertEq(q7.options[0].label, "Can't remember");

    // Q9 options
    const q9 = model.nodes["Q9"];
    assertEq(q9.options.length, 1);
    assertEq(q9.options[0].label, "No");

    // Edges
    assert(model.edges.length >= 2, `expected >= 2 edges, got ${model.edges.length}`);
    const route1 = model.edges.find((e) => e.from === "Q7" && e.kind === "route");
    assert(route1, "edge Q7 → Q9 must exist");
    assertEq(route1.to, "Q9");
    assertEq(route1.trigger.mode, "code");
    assertEq(route1.trigger.value, "3");
    assertEq(route1.sources.length, 1);

    const route2 = model.edges.find((e) => e.from === "Q9" && e.kind === "terminate");
    assert(route2, "terminate edge must exist");
    assertEq(route2.to, "TERMINATE:screenout");

    // Denominator
    assertEq(model.denominator.nodeCount, 3);
    assertEq(model.denominator.routeEdges, 1);
    assertEq(model.denominator.terminalEdges, 1);
    assertEq(model.denominator.fallthroughEdges, 0, "Q7→Q9 has an explicit edge, no fallthrough needed");
  });

  test("duplicate edges from different facet instances are merged, not duplicated", async () => {
    const mod = await worker();
    const body = contractBody();
    body.requirements.push({
      requirementLineageId: "req_dup",
      requirementVersionId: "reqv_dup",
      semanticFingerprint: "fp_dup",
      scope: "question:Q1",
      quantifier: "specific",
      selector: "Q1",
      exceptions: [],
      facet: "routing",
      assertionStatus: "entailed",
      testability: "browser-observable",
      notBrowserObservableReason: null,
      sourceAtoms: [{ blockId: "B5", kind: "paragraph", coords: null, role: "instruction", atomTextHash: "sha256:eee" }],
      composition: null,
      normativeStatement: "Q1 Yes → Q2.",
      displayQuote: "Q1 Yes → Q2",
      retiredAt: null,
    });
    body.facetInstances = [
      {
        facetInstanceId: "fi_a",
        requirementLineageId: "req_dup",
        requirementVersionId: "reqv_dup",
        caseVersionId: "cv_a",
        floorCase: true,
        targetQuestionId: "Q1",
        expansionCertificate: "q1-yes",
        case: {
          kind: "route",
          routeAnswer: { code: "1", label: "Yes" },
          expectedDestination: { questionId: "Q2", screen: null, terminal: null },
          boundaryInput: null,
          configuration: null,
        },
        expectationGap: null,
        screen: null,
        label: "Q1 Yes → Q2",
      },
      {
        facetInstanceId: "fi_b",
        requirementLineageId: "req_dup",
        requirementVersionId: "reqv_dup",
        caseVersionId: "cv_b",
        floorCase: true,
        targetQuestionId: "Q1",
        expansionCertificate: "q1-yes-b",
        case: {
          kind: "route",
          routeAnswer: { code: "1", label: "Yes" },
          expectedDestination: { questionId: "Q2", screen: null, terminal: null },
          boundaryInput: null,
          configuration: null,
        },
        expectationGap: null,
        screen: null,
        label: "Q1 Yes → Q2 (duplicate)",
      },
    ];

    const model = mod.structure.compileStructureModel(body);
    assert(model !== null);

    // ONE edge for Q1 → Q2, not two
    const q1Edges = model.edges.filter((e) => e.from === "Q1" && e.kind === "route");
    assertEq(q1Edges.length, 1, "duplicate route should be merged into one edge");
    assert(q1Edges[0].sources.includes("fi_a") || q1Edges[0].sources.includes("fi_b"),
      "sources should include both facet instance ids");
  });

  test("different answers to the same destination remain separate coverage obligations", async () => {
    const mod = await worker();
    const body = contractBody();
    body.requirements = [{
      requirementLineageId: "req_same_destination",
      requirementVersionId: "reqv_same_destination",
      semanticFingerprint: "fp_same_destination",
      scope: "question:EntryChoice",
      quantifier: "specific",
      selector: "EntryChoice",
      exceptions: [],
      facet: "routing",
      assertionStatus: "entailed",
      testability: "browser-observable",
      notBrowserObservableReason: null,
      sourceAtoms: [{ blockId: "B-SAME", kind: "paragraph", coords: null, role: "instruction", atomTextHash: "sha256:same" }],
      composition: null,
      normativeStatement: "Both Yes and No continue to Details.",
      displayQuote: "Yes/No -> Details",
      retiredAt: null,
    }];
    body.facetInstances = [
      {
        facetInstanceId: "fi_yes",
        requirementLineageId: "req_same_destination",
        requirementVersionId: "reqv_same_destination",
        caseVersionId: "cv_yes",
        floorCase: true,
        targetQuestionId: "EntryChoice",
        expansionCertificate: "yes-details",
        case: {
          kind: "route",
          routeAnswer: { code: "1", label: "Yes" },
          expectedDestination: { questionId: "Details", screen: null, terminal: null },
          boundaryInput: null,
          configuration: null,
        },
        expectationGap: null,
        screen: null,
        label: "Yes -> Details",
      },
      {
        facetInstanceId: "fi_no",
        requirementLineageId: "req_same_destination",
        requirementVersionId: "reqv_same_destination",
        caseVersionId: "cv_no",
        floorCase: true,
        targetQuestionId: "EntryChoice",
        expansionCertificate: "no-details",
        case: {
          kind: "route",
          routeAnswer: { code: "2", label: "No" },
          expectedDestination: { questionId: "Details", screen: null, terminal: null },
          boundaryInput: null,
          configuration: null,
        },
        expectationGap: null,
        screen: null,
        label: "No -> Details",
      },
    ];

    const model = mod.structure.compileStructureModel(body);
    assert(model !== null);
    const routes = model.edges.filter((e) => e.from === "EntryChoice" && e.to === "Details");
    assertEq(routes.length, 2, "answer-specific edges must not collapse by source/destination alone");

    const coverage = mod.structure.computeEdgeCoverage(model, new Set(["fi_yes"]));
    const sameDestination = coverage.edges.filter((e) => e.from === "EntryChoice" && e.to === "Details");
    assertEq(sameDestination.filter((e) => e.traversed).length, 1);
    assertEq(
      sameDestination.filter((e) => !e.traversed).length,
      1,
      "exercising Yes must not silently cover the No obligation",
    );
  });

  test("destination-only nodes support arbitrary sealed question identifiers", async () => {
    const mod = await worker();
    const body = contractBody();
    body.requirements = [{
      requirementLineageId: "req_arbitrary_ids",
      requirementVersionId: "reqv_arbitrary_ids",
      semanticFingerprint: "fp_arbitrary_ids",
      scope: "question:ItemA",
      quantifier: "specific",
      selector: "ItemA",
      exceptions: [],
      facet: "routing",
      assertionStatus: "entailed",
      testability: "browser-observable",
      notBrowserObservableReason: null,
      sourceAtoms: [{ blockId: "B-IDS", kind: "paragraph", coords: null, role: "instruction", atomTextHash: "sha256:ids" }],
      composition: null,
      normativeStatement: "ItemA continues to ItemB.",
      displayQuote: "ItemA -> ItemB",
      retiredAt: null,
    }];
    body.facetInstances = [{
      facetInstanceId: "fi_arbitrary_ids",
      requirementLineageId: "req_arbitrary_ids",
      requirementVersionId: "reqv_arbitrary_ids",
      caseVersionId: "cv_arbitrary_ids",
      floorCase: true,
      targetQuestionId: "ItemA",
      expansionCertificate: "item-a-b",
      case: {
        kind: "route",
        routeAnswer: { code: "continue", label: "Continue" },
        expectedDestination: { questionId: "ItemB", screen: null, terminal: null },
        boundaryInput: null,
        configuration: null,
      },
      expectationGap: null,
      screen: null,
      label: "ItemA -> ItemB",
    }];

    const model = mod.structure.compileStructureModel(body);
    assert(model !== null);
    assert(model.nodes.ItemA, "source node must exist");
    assert(model.nodes.ItemB, "a destination-only node must not disappear");
    assertEq(model.edges.filter((e) => e.from === "ItemA" && e.to === "ItemB").length, 1);
  });

  test("an empty contract produces null", async () => {
    const mod = await worker();
    const body = contractBody();
    body.requirements = [];
    body.facetInstances = [];
    const model = mod.structure.compileStructureModel(body);
    assertEq(model, null);
  });

  test("determinism: same contract, same graph", async () => {
    const mod = await worker();
    const body = contractBody();
    body.requirements.push({
      requirementLineageId: "req_det",
      requirementVersionId: "reqv_det",
      semanticFingerprint: "fp_det",
      scope: "question:Q4",
      quantifier: "specific",
      selector: "Q4",
      exceptions: [],
      facet: "routing",
      assertionStatus: "entailed",
      testability: "browser-observable",
      notBrowserObservableReason: null,
      sourceAtoms: [{ blockId: "B6", kind: "paragraph", coords: null, role: "instruction", atomTextHash: "sha256:fff" }],
      composition: null,
      normativeStatement: "Q4 → Q5.",
      displayQuote: "Q4 → Q5",
      retiredAt: null,
    });
    body.facetInstances = [{
      facetInstanceId: "fi_det",
      requirementLineageId: "req_det",
      requirementVersionId: "reqv_det",
      caseVersionId: "cv_det",
      floorCase: true,
      targetQuestionId: "Q4",
      expansionCertificate: "q4",
      case: {
        kind: "route",
        routeAnswer: { code: "1", label: "Continue" },
        expectedDestination: { questionId: "Q5", screen: null, terminal: null },
        boundaryInput: null,
        configuration: null,
      },
      expectationGap: null,
      screen: null,
      label: "Q4 → Q5",
    }];

    const a = mod.structure.compileStructureModel(body);
    const b = mod.structure.compileStructureModel(body);
    assert(a && b, "both must produce a graph");
    // Timestamps differ by ~1ms; compare the deterministic parts
    const stripTime = (m) => {
      const { compiledAt, contractRevisionId, ...rest } = m;
      return JSON.stringify(rest);
    };
    assertEq(stripTime(a), stripTime(b), "same contract must produce byte-identical graph (excluding timestamps)");
  });

  test("the StructureModel carries the kind marker", async () => {
    const mod = await worker();
    const body = contractBody();
    body.facetInstances = [{
      facetInstanceId: "fi_kind",
      requirementLineageId: body.requirements[0].requirementLineageId,
      requirementVersionId: body.requirements[0].requirementVersionId,
      caseVersionId: "cv_kind",
      floorCase: true,
      targetQuestionId: "Q7",
      expansionCertificate: "q7",
      case: {
        kind: "route",
        routeAnswer: { code: "1", label: "Yes" },
        expectedDestination: { questionId: "Q8", screen: null, terminal: null },
        boundaryInput: null,
        configuration: null,
      },
      expectationGap: null,
      screen: null,
      label: "Q7 → Q8",
    }];

    const model = mod.structure.compileStructureModel(body);
    assertEq(model.kind, "survey-qa-structure-model/1.0.0");
  });

  test("edge coverage: traversed / untouched counts match exercised facet ids", async () => {
    const mod = await worker();
    const body = contractBody();
    body.requirements.push(
      {
        requirementLineageId: "req_cov1",
        requirementVersionId: "reqv_cov1",
        semanticFingerprint: "fp_cov1",
        scope: "question:Q7",
        quantifier: "specific",
        selector: "Q7",
        exceptions: [],
        facet: "routing",
        assertionStatus: "entailed",
        testability: "browser-observable",
        notBrowserObservableReason: null,
        sourceAtoms: [{ blockId: "B7", kind: "paragraph", coords: null, role: "instruction", atomTextHash: "sha256:ggg" }],
        composition: null,
        normativeStatement: "Q7 → Q9.",
        displayQuote: "Q7 → Q9",
        retiredAt: null,
      },
      {
        requirementLineageId: "req_cov2",
        requirementVersionId: "reqv_cov2",
        semanticFingerprint: "fp_cov2",
        scope: "question:Q9",
        quantifier: "specific",
        selector: "Q9",
        exceptions: [],
        facet: "routing",
        assertionStatus: "entailed",
        testability: "browser-observable",
        notBrowserObservableReason: null,
        sourceAtoms: [{ blockId: "B8", kind: "paragraph", coords: null, role: "instruction", atomTextHash: "sha256:hhh" }],
        composition: null,
        normativeStatement: "Q9 → terminate.",
        displayQuote: "Q9 → terminate",
        retiredAt: null,
      },
    );
    body.facetInstances = [
      {
        facetInstanceId: "fi_cov_a",
        requirementLineageId: "req_cov1",
        requirementVersionId: "reqv_cov1",
        caseVersionId: "cv_cov_a",
        floorCase: true,
        targetQuestionId: "Q7",
        expansionCertificate: "q7-route",
        case: {
          kind: "route",
          routeAnswer: { code: "1", label: "Yes" },
          expectedDestination: { questionId: "Q9", screen: null, terminal: null },
          boundaryInput: null,
          configuration: null,
        },
        expectationGap: null,
        screen: null,
        label: "Q7 Yes → Q9",
      },
      {
        facetInstanceId: "fi_cov_b",
        requirementLineageId: "req_cov2",
        requirementVersionId: "reqv_cov2",
        caseVersionId: "cv_cov_b",
        floorCase: true,
        targetQuestionId: "Q9",
        expansionCertificate: "q9-terminate",
        case: {
          kind: "route",
          routeAnswer: { code: null, label: "No" },
          expectedDestination: { questionId: null, screen: null, terminal: "screenout" },
          boundaryInput: null,
          configuration: null,
        },
        expectationGap: null,
        screen: null,
        label: "Q9 No → terminate",
      },
    ];

    const model = mod.structure.compileStructureModel(body);
    assert(model !== null);

    // Exercise only fi_cov_a (Q7→Q9 route), not fi_cov_b (Q9→terminate)
    const exercised = new Set(["fi_cov_a"]);
    const result = mod.structure.computeEdgeCoverage(model, exercised);

    assert(result.denominator > 0, "denominator must be positive");
    assertEq(result.traversed + result.untouched, result.denominator);

    const q7Edge = result.edges.find((e) => e.from === "Q7" && e.to === "Q9");
    assert(q7Edge, "Q7 edge must be in the coverage result");
    assertEq(q7Edge.traversed, true, "Q7→Q9 edge should be traversed because fi_cov_a was exercised");
    assert(q7Edge.exercisedSources.includes("fi_cov_a"));

    const q9Edge = result.edges.find((e) => e.from === "Q9" && e.to.startsWith("TERMINATE:"));
    assert(q9Edge, "Q9 edge must be in the coverage result");
    assertEq(q9Edge.traversed, false, "Q9→terminate edge should be untouched");
    assertEq(q9Edge.exercisedSources.length, 0);

    assertEq(result.untouched, result.edges.filter((e) => !e.traversed).length);
    assertEq(result.traversed, result.edges.filter((e) => e.traversed).length);
  });

  test("route-diff: three-valued edge classification (matched / not-reached / defect)", async () => {
    const mod = await worker();
    const body = contractBody();
    body.requirements = [
      {
        requirementLineageId: "req_diff_q7",
        requirementVersionId: "reqv_diff_q7",
        semanticFingerprint: "fp_diff_q7",
        scope: "question:Q7",
        quantifier: "specific",
        selector: "Q7",
        exceptions: [],
        facet: "routing",
        assertionStatus: "entailed",
        testability: "browser-observable",
        notBrowserObservableReason: null,
        sourceAtoms: [{ blockId: "B10", kind: "paragraph", coords: null, role: "instruction", atomTextHash: "sha256:jjj" }],
        composition: null,
        normativeStatement: "Q7 → Q9.",
        displayQuote: "Q7 → Q9",
        retiredAt: null,
      },
      {
        requirementLineageId: "req_diff_q9",
        requirementVersionId: "reqv_diff_q9",
        semanticFingerprint: "fp_diff_q9",
        scope: "question:Q9",
        quantifier: "specific",
        selector: "Q9",
        exceptions: [],
        facet: "routing",
        assertionStatus: "entailed",
        testability: "browser-observable",
        notBrowserObservableReason: null,
        sourceAtoms: [{ blockId: "B11", kind: "paragraph", coords: null, role: "instruction", atomTextHash: "sha256:kkk" }],
        composition: null,
        normativeStatement: "Q9 → terminate.",
        displayQuote: "Q9 → terminate",
        retiredAt: null,
      },
    ];
    body.facetInstances = [
      {
        facetInstanceId: "fi_diff_a",
        requirementLineageId: "req_diff_q7",
        requirementVersionId: "reqv_diff_q7",
        caseVersionId: "cv_diff_a",
        floorCase: true,
        targetQuestionId: "Q7",
        expansionCertificate: "q7-q9",
        case: {
          kind: "route",
          routeAnswer: { code: "3", label: "Can't remember" },
          expectedDestination: { questionId: "Q9", screen: null, terminal: null },
          boundaryInput: null,
          configuration: null,
        },
        expectationGap: null,
        screen: null,
        label: "Q7 → Q9",
      },
      {
        facetInstanceId: "fi_diff_b",
        requirementLineageId: "req_diff_q9",
        requirementVersionId: "reqv_diff_q9",
        caseVersionId: "cv_diff_b",
        floorCase: true,
        targetQuestionId: "Q9",
        expansionCertificate: "q9-term",
        case: {
          kind: "route",
          routeAnswer: { code: "2", label: "No" },
          expectedDestination: { questionId: null, screen: null, terminal: "screenout" },
          boundaryInput: null,
          configuration: null,
        },
        expectationGap: null,
        screen: null,
        label: "Q9 → terminate",
      },
    ];

    const model = mod.structure.compileStructureModel(body);
    assert(model !== null, "must produce a graph");
    assertEq(model.edges.length, 2, "Q7→Q9 and Q9→TERMINATE edges only");

    // Exercise Q7→Q9 (fi_diff_a), observed destination matched Q9.
    // Q9→TERMINATE (fi_diff_b) was never exercised.
    const exercised = new Set(["fi_diff_a"]);
    const observed = new Map([["fi_diff_a", "Q9"]]);
    const blockers = new Set();

    const result = mod.structure.diffRoutes(model, exercised, observed, blockers);

    assertEq(result.summary.total, 2);
    assertEq(result.summary.matched, 1, "Q7→Q9 observed destination matched the document");
    assertEq(result.summary.notReached, 1, "Q9→TERMINATE was never exercised");
    assertEq(result.summary.defect, 0);
    assertEq(result.summary.provenUnreachable, 0);
    assertEq(result.summary.blocked, 0);
    assertEq(result.summary.inconclusive, 0);

    const q7Edge = Object.values(result.edges).find((e) => e.edge.from === "Q7" && e.edge.to === "Q9");
    assert(q7Edge, "Q7→Q9 edge must be in diff result");
    assertEq(q7Edge.verdict, "matched", "Q7→Q9 is matched, not a defect");
    assertEq(q7Edge.observedDestination, "Q9");

    const q9Edge = Object.values(result.edges).find((e) => e.edge.from === "Q9" && e.edge.to.startsWith("TERMINATE:"));
    assert(q9Edge, "Q9→TERMINATE edge must be in diff result");
    assertEq(q9Edge.verdict, "not-reached", "Q9→TERMINATE must be not-reached");
    assertEq(q9Edge.observedDestination, undefined);
  });

  test("edge coverage: empty exercised set → zero traversed", async () => {
    const mod = await worker();
    const body = contractBody();
    body.requirements.push({
      requirementLineageId: "req_emptycov",
      requirementVersionId: "reqv_emptycov",
      semanticFingerprint: "fp_emptycov",
      scope: "question:Q1",
      quantifier: "specific",
      selector: "Q1",
      exceptions: [],
      facet: "routing",
      assertionStatus: "entailed",
      testability: "browser-observable",
      notBrowserObservableReason: null,
      sourceAtoms: [{ blockId: "B9", kind: "paragraph", coords: null, role: "instruction", atomTextHash: "sha256:iii" }],
      composition: null,
      normativeStatement: "Q1 → Q2.",
      displayQuote: "Q1 → Q2",
      retiredAt: null,
    });
    body.facetInstances = [{
      facetInstanceId: "fi_empty",
      requirementLineageId: "req_emptycov",
      requirementVersionId: "reqv_emptycov",
      caseVersionId: "cv_empty",
      floorCase: true,
      targetQuestionId: "Q1",
      expansionCertificate: "q1-route",
      case: {
        kind: "route",
        routeAnswer: { code: "1", label: "Yes" },
        expectedDestination: { questionId: "Q2", screen: null, terminal: null },
        boundaryInput: null,
        configuration: null,
      },
      expectationGap: null,
      screen: null,
      label: "Q1 Yes → Q2",
    }];

    const model = mod.structure.compileStructureModel(body);
    assert(model !== null);

    const result = mod.structure.computeEdgeCoverage(model, new Set());
    assertEq(result.traversed, 0, "with empty exercised set, no edge should be traversed");
    assertEq(result.untouched, result.denominator);
    assert(result.edges.every((e) => !e.traversed), "all edges must be untraversed");
  });
});

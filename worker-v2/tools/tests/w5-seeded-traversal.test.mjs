/** W5 — sealed seed authority, unchanged denominator, history receipts and runtime scheduling. */
import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { contractBody } from "../fixtures/v2-fixture.mjs";

const option = (label, code = null) => ({ code, label });
const requirement = (status = "entailed") => ({
  requirementLineageId: "req_seed",
  requirementVersionId: "reqv_seed",
  assertionStatus: status,
});
const facet = (asserted, siblings = []) => ({
  facetInstanceId: "fi_seed",
  requirementLineageId: "req_seed",
  requirementVersionId: "reqv_seed",
  caseVersionId: "cv_seed",
  floorCase: true,
  targetQuestionId: "QX",
  expansionCertificate: "expansion:sealed-source-span",
  case: {
    kind: "option-set",
    routeAnswer: null,
    boundaryInput: null,
    configuration: null,
    expectedDestination: null,
    optionSet: {
      asserted,
      siblings,
      exhaustive: false,
      closureAssessment: { status: "not-evaluated", code: "OPTION_SET_CLOSURE_NOT_EVALUATED", detail: "membership only" },
    },
  },
  expectationGap: null,
  screen: "QX",
  label: "options",
});
const revision = (asserted, status = "entailed", siblings = []) => ({
  contractRevisionId: "cr_" + "a".repeat(40),
  requirements: [requirement(status)],
  facetInstances: [facet(asserted, siblings)],
});
const decision = (question = "QX", select = ["baseline"]) => ({ question, select, source: "sealed-floor" });
const path = (decisions = [decision()]) => ({
  id: "FLOOR-01",
  tier: 1,
  kind: "floor",
  intent: "fixture",
  decisions,
  skipped_questions: [],
  terminated_at: null,
  witnesses: ["req_seed"],
  witness_notes: [],
  needs_repeats: [],
  steps: decisions.length + 1,
});

const build = async ({ asserted = [option("Alpha", "1"), option("Beta", "2")], status, siblings, limits } = {}) => {
  const mod = await worker();
  const rev = revision(asserted, status, siblings);
  const seedPlan = await mod.plan.buildSealedSeedPlan({
    revision: rev,
    contractHash: "sha256:" + "b".repeat(64),
    floorPaths: [path()],
    witnessMap: { req_seed: "FLOOR-01" },
    baselineFloorSteps: 2,
    limits: { candidateCap: 256, perQuestionCap: 256, perBasePathCap: 256, attemptCap: 256, stepCap: 10000, ...limits },
  });
  return { mod, rev, seedPlan };
};

suite("W5 — sealed authority and alternatives census", () => {
  test("asserted payload alone mints singleton alternatives; siblings and unsealed pairwise choices do not", async () => {
    const { seedPlan } = await build({ siblings: [option("ROGUE-SIBLING", "9")] });
    assertEq(seedPlan.census.candidateCount, 2);
    assertEq(seedPlan.census.selectedCount, 2);
    assertEq(seedPlan.census.withheldCombinationCount, 1);
    assertEq(seedPlan.alternatives.map((row) => row.path.decisions[0].select.join("+")).join(","), "Alpha,Beta");
    for (const row of seedPlan.alternatives) {
      assertEq(row.certificate.assertedOptions.map((o) => o.label).join(","), "Alpha,Beta");
      assert(!JSON.stringify(row).includes("ROGUE-SIBLING"), "siblings leaked into seed authority");
      assertEq(row.certificate.selectedOrdinals.length, 1);
    }
  });

  test("ambiguous sealed rows are withheld and counted rather than guessed", async () => {
    const { seedPlan } = await build({ status: "ambiguous" });
    assertEq(seedPlan.alternatives.length, 0);
    assertEq(seedPlan.census.withheldRows, 1);
    assertEq(seedPlan.census.withheld[0].reason, "not-positive-entailed-authority");

    const duplicate = await build({ asserted: [option("Same", "1"), option("Same", "2")] });
    assertEq(duplicate.seedPlan.alternatives.length, 0);
    assert(duplicate.seedPlan.census.withheld[0].detail.includes("repeats a visible label"));
  });

  test("pre-target navigation without an exact action and text without retained state are named census refusals", async () => {
    const mod = await worker();
    const rev = revision([option("Alpha", "1")]);
    const make = (prior) => mod.plan.buildSealedSeedPlan({
      revision: rev, contractHash: "sha256:" + "b".repeat(64),
      floorPaths: [path([prior, decision("QX")])], witnessMap: { req_seed: "FLOOR-01" },
      baselineFloorSteps: 3,
    });
    const navigator = await make(decision("QPRIOR", []));
    assertEq(navigator.alternatives.length, 0);
    assertEq(navigator.census.withheld[0].reason, "under-specified-history-transition");
    const text = await make({ question: "QPRIOR", text_entry: { value: "requested" }, source: "sealed-floor" });
    assertEq(text.alternatives.length, 0);
    assertEq(text.census.withheld[0].reason, "unsupported-history-text-readback");
  });

  test("certificate tampering and out-of-range selected ordinals are refused by recomputation", async () => {
    const { mod, rev, seedPlan } = await build();
    const certificate = structuredClone(seedPlan.alternatives[0].certificate);
    certificate.assertedOptions[0].label = "fabricated";
    assert((await mod.plan.sealedSeedCertificateFailures(certificate, rev, "sha256:" + "b".repeat(64))).length > 0);
    const ordinal = structuredClone(seedPlan.alternatives[0].certificate);
    ordinal.selectedOrdinals = [99];
    assert((await mod.plan.sealedSeedCertificateFailures(ordinal, rev, "sha256:" + "b".repeat(64))).includes("selected option ordinals are invalid"));
    const multiple = structuredClone(seedPlan.alternatives[0].certificate);
    multiple.selectedOrdinals = [0, 1];
    assert((await mod.plan.sealedSeedCertificateFailures(multiple, rev, "sha256:" + "b".repeat(64))).includes("selected option ordinals are invalid"));
  });

  test("candidate cap preserves exact theoretical denominator and omitted count on a huge option set", async () => {
    const asserted = Array.from({ length: 300 }, (_, i) => option(`Option ${i}`, String(i)));
    const { seedPlan } = await build({ asserted, limits: { candidateCap: 5 } });
    assertEq(seedPlan.census.candidateCount, 300);
    assertEq(seedPlan.census.materializedCandidateCount, 5);
    assertEq(seedPlan.census.omittedCandidateCount, 295);
    assertEq(seedPlan.census.droppedCount, 295);
    assertEq(seedPlan.census.withheldCombinationCount, 44_850);
  });

  test("bounded materialization is round-robin across cases rather than starving later authority", async () => {
    const mod = await worker();
    const secondRequirement = { ...requirement(), requirementLineageId: "req_second", requirementVersionId: "reqv_second" };
    const secondFacet = {
      ...facet([option("Only", "9")]), facetInstanceId: "fi_second", requirementLineageId: "req_second",
      requirementVersionId: "reqv_second", targetQuestionId: "QY", screen: "QY",
    };
    const rev = { ...revision([option("A", "1"), option("B", "2"), option("C", "3")]), requirements: [requirement(), secondRequirement] };
    rev.facetInstances = [rev.facetInstances[0], secondFacet];
    const secondPath = { ...path([decision("QY")]), id: "FLOOR-02", witnesses: ["req_second"] };
    const plan = await mod.plan.buildSealedSeedPlan({
      revision: rev, contractHash: "sha256:" + "b".repeat(64), floorPaths: [path(), secondPath],
      witnessMap: { req_seed: "FLOOR-01", req_second: "FLOOR-02" }, baselineFloorSteps: 4,
      limits: { candidateCap: 2, perQuestionCap: 10, perBasePathCap: 10, attemptCap: 10, stepCap: 100 },
    });
    assertEq(plan.alternatives.map((row) => row.caseId).join(","), "fi_second,fi_seed");
    assertEq(plan.census.candidateCount, 4);
    assertEq(plan.census.omittedCandidateCount, 2);
  });

  test("candidate admission is invariant to sealed facet order and prioritizes cheaper marginal case coverage", async () => {
    const mod = await worker();
    const secondRequirement = { ...requirement(), requirementLineageId: "req_second", requirementVersionId: "reqv_second" };
    const secondFacet = {
      ...facet([option("Only", "9")]), facetInstanceId: "fi_second", requirementLineageId: "req_second",
      requirementVersionId: "reqv_second", targetQuestionId: "QY", screen: "QY",
    };
    const firstFacet = revision([option("Alpha", "1")]).facetInstances[0];
    const buildOrder = (facetInstances) => mod.plan.buildSealedSeedPlan({
      revision: { ...revision([option("Alpha", "1")]), requirements: [requirement(), secondRequirement], facetInstances },
      contractHash: "sha256:" + "b".repeat(64),
      floorPaths: [path([decision("QA"), decision("QX")]), { ...path([decision("QY")]), id: "FLOOR-02", witnesses: ["req_second"] }],
      witnessMap: { req_seed: "FLOOR-01", req_second: "FLOOR-02" }, baselineFloorSteps: 5,
      limits: { candidateCap: 1, perQuestionCap: 10, perBasePathCap: 10, attemptCap: 10, stepCap: 100 },
    });
    const forward = await buildOrder([firstFacet, secondFacet]);
    const reverse = await buildOrder([secondFacet, firstFacet]);
    assertEq(forward.alternatives[0].caseId, "fi_second");
    assertEq(reverse.alternatives[0].caseId, "fi_second");
    assertEq(forward.census.omittedCandidateCount, 1);
    assertEq(reverse.census.omittedCandidateCount, 1);
  });
});

const screen = (signature) => {
  const checked = signature !== "before";
  return {
    screenSignature: signature,
    controls: [{
      idx: 1, tag: "input", type: "radio", name: "answer", id: "answer-alpha", code: "1",
      formOwner: 0,
      label: "Alpha", checked, disabled: false, visible: false, operable: true, actuatedVia: "label",
    }],
    optionGroups: [{
      name: "answer", kind: "radio",
      identity: { type: "radio", name: "answer", formOwner: 0, unnamedControlIdx: null },
      options: [{
        order: 0, idx: 1, code: "1", label: "Alpha", checked,
        disabled: false, visible: false, operable: true, actuatedVia: "label",
      }],
    }],
  };
};
const nativeSelectScreen = (signature, selected) => ({
  screenSignature: signature,
  controls: [{
    idx: 4, tag: "select", type: "select", name: "country", id: "country-select",
    code: selected ? "1" : "", value: selected ? "1" : "", disabled: false, visible: true,
    operable: true, multiple: false,
    options: [
      { order: 0, code: "", label: "Choose one", selected: !selected, disabled: false, hidden: false, placeholder: true },
      { order: 1, code: "1", label: "Alpha", selected, disabled: false, hidden: false, placeholder: false },
    ],
  }],
  optionGroups: [],
});
const epoch = (slot, evidenceId) => ({
  epochId: `epoch-${slot}`, stepIndex: 0, slot, captureFailureCount: 0,
  screenSignatureHash: slot === "before"
    ? "6db7d803e74f1ffa7d8f5adc0bf95b3e15bf4c8373fffadf546227cc6c6742cb"
    : "f39592393ef0859cb196a52693d2cea00fb2df784b3c04ae54aa7cadb8e562f8",
  screenJson: { evidenceId },
});
const observedStep = (planned, label = planned.select[0]) => ({
  stepIndex: 0,
  decisionQuestion: planned.question,
  decisionSource: "plan",
  requested: { select: planned.select, textEntry: planned.text_entry?.value ?? null, action: planned.action ?? null },
  screenBefore: screen("before"),
  screenAfterAction: screen("after"),
  screenAfterAdvance: screen("next"),
  actions: [{
    kind: "click-option", targetIdx: 1, targetLabel: label, targetCode: "1", value: null, ok: true, detail: "fixture",
    choiceReadback: {
      idx: 1, type: "radio", name: "answer", formOwner: 0, unnamedControlIdx: null,
      checked: true, checkedGroupIdxs: [1],
    },
  }],
  requestedButNotOffered: [], advanced: true, blocked: false, pageErrors: [], consoleErrors: [],
  evidence: { screenBefore: "ev_before", screenAfterAdvance: "ev_next", screenshots: [], screenCaptures: [epoch("before", "ev_before"), epoch("after-action", "ev_after")] },
  wallMs: 1,
});
const observation = (alternative, steps) => ({
  kind: "v2-path-observation/1.0.0", runId: "run", pathId: alternative.alternativeId, tier: 2,
  attemptId: "att_seed", planRevisionId: "plan", surveyUrl: "https://fixture.invalid", startedAt: "2026-01-01T00:00:00Z",
  endedAt: "2026-01-01T00:00:01Z", wallMs: 1, plannedWitnesses: [], steps, outcome: "no-advance-control",
  outcomeDetail: null, shimmed: false, shimNote: null, loadFailure: null, evidenceIds: ["ev_before", "ev_after", "ev_observation"], viewport: { width: 1, height: 1 },
});
const receipt = (mod, alternative, obs, evidenceId = "ev_observation") =>
  mod.plan.deriveCaseWitnessReceipt(alternative, obs, evidenceId);

suite("W5 — occurrence/history receipts and runtime work", () => {
  test("exact certified action plus before/after occurrence produces a content-addressed case receipt", async () => {
    const { mod, seedPlan } = await build();
    const alternative = seedPlan.alternatives[0];
    await mod.plan.stampPlannedOccurrenceIdentity([alternative.path]);
    const result = await receipt(mod, alternative, observation(alternative, [observedStep(alternative.path.decisions[0])]));
    assertEq(result.ok, true);
    assertEq(result.receipt.caseId, "fi_seed");
    assert(/^sha256:[0-9a-f]{64}$/.test(result.receipt.receiptHash));
    assertEq(result.receipt.expectedOccurrenceId, result.receipt.observedOccurrenceId);
    assertEq(result.receipt.expectedHistoryDigest, result.receipt.observedHistoryDigest);
    const unnamed = observedStep(alternative.path.decisions[0]);
    unnamed.actions[0].choiceReadback.name = null;
    unnamed.actions[0].choiceReadback.unnamedControlIdx = 1;
    for (const retainedScreen of [unnamed.screenBefore, unnamed.screenAfterAction]) {
      retainedScreen.controls[0].name = null;
      retainedScreen.optionGroups[0].name = "(unnamed)";
      retainedScreen.optionGroups[0].identity = {
        type: "radio", name: null, formOwner: 0, unnamedControlIdx: 1,
      };
    }
    assertEq((await receipt(mod, alternative, observation(alternative, [unnamed]))).ok, true);
  });

  test("certified action joins one unique retained control owner across before and after", async () => {
    const { mod, seedPlan } = await build();
    const alternative = seedPlan.alternatives[0];
    await mod.plan.stampPlannedOccurrenceIdentity([alternative.path]);

    const foreignIdx = observedStep(alternative.path.decisions[0]);
    foreignIdx.actions[0].targetIdx = 2;
    foreignIdx.actions[0].choiceReadback.idx = 2;
    foreignIdx.actions[0].choiceReadback.checkedGroupIdxs = [2];
    assertEq((await receipt(mod, alternative, observation(alternative, [foreignIdx]))).ok, false);

    const wrongFormReadback = observedStep(alternative.path.decisions[0]);
    wrongFormReadback.actions[0].choiceReadback.formOwner = 1;
    assertEq((await receipt(mod, alternative, observation(alternative, [wrongFormReadback]))).ok, false);

    const changedFormOwner = observedStep(alternative.path.decisions[0]);
    changedFormOwner.actions[0].choiceReadback.formOwner = 1;
    changedFormOwner.screenAfterAction.controls[0].formOwner = 1;
    changedFormOwner.screenAfterAction.optionGroups[0].identity.formOwner = 1;
    assertEq((await receipt(mod, alternative, observation(alternative, [changedFormOwner]))).ok, false);

    const wrongUnnamedControl = observedStep(alternative.path.decisions[0]);
    wrongUnnamedControl.actions[0].choiceReadback.name = null;
    wrongUnnamedControl.actions[0].choiceReadback.unnamedControlIdx = 2;
    for (const retainedScreen of [wrongUnnamedControl.screenBefore, wrongUnnamedControl.screenAfterAction]) {
      retainedScreen.controls[0].name = null;
      retainedScreen.optionGroups[0].name = "(unnamed)";
      retainedScreen.optionGroups[0].identity = {
        type: "radio", name: null, formOwner: 0, unnamedControlIdx: 1,
      };
    }
    assertEq((await receipt(mod, alternative, observation(alternative, [wrongUnnamedControl]))).ok, false);

    const duplicateUnnamed = observedStep(alternative.path.decisions[0]);
    duplicateUnnamed.actions[0].choiceReadback.name = null;
    duplicateUnnamed.actions[0].choiceReadback.unnamedControlIdx = 1;
    for (const retainedScreen of [duplicateUnnamed.screenBefore, duplicateUnnamed.screenAfterAction]) {
      retainedScreen.controls[0].name = null;
      retainedScreen.optionGroups[0].name = "(unnamed)";
      retainedScreen.optionGroups[0].identity = {
        type: "radio", name: null, formOwner: 0, unnamedControlIdx: 1,
      };
      retainedScreen.controls.push({ ...retainedScreen.controls[0], idx: 2, id: "other-alpha" });
      retainedScreen.optionGroups[0].options.push({
        ...retainedScreen.optionGroups[0].options[0], order: 1, idx: 2,
      });
    }
    assertEq((await receipt(mod, alternative, observation(alternative, [duplicateUnnamed]))).ok, false);

    const ownerChanged = observedStep(alternative.path.decisions[0]);
    ownerChanged.screenAfterAction.controls[0].id = "replacement-alpha";
    assertEq((await receipt(mod, alternative, observation(alternative, [ownerChanged]))).ok, false);

    const disabledChoiceControl = observedStep(alternative.path.decisions[0]);
    disabledChoiceControl.screenBefore.controls[0].disabled = true;
    assertEq((await receipt(mod, alternative, observation(alternative, [disabledChoiceControl]))).ok, false);
    const inoperableChoiceControl = observedStep(alternative.path.decisions[0]);
    inoperableChoiceControl.screenAfterAction.controls[0].operable = false;
    assertEq((await receipt(mod, alternative, observation(alternative, [inoperableChoiceControl]))).ok, false);
    const disabledChoiceOption = observedStep(alternative.path.decisions[0]);
    disabledChoiceOption.screenBefore.optionGroups[0].options[0].disabled = true;
    assertEq((await receipt(mod, alternative, observation(alternative, [disabledChoiceOption]))).ok, false);
    const inoperableChoiceOption = observedStep(alternative.path.decisions[0]);
    inoperableChoiceOption.screenAfterAction.optionGroups[0].options[0].operable = false;
    assertEq((await receipt(mod, alternative, observation(alternative, [inoperableChoiceOption]))).ok, false);

    const selectStep = observedStep(alternative.path.decisions[0]);
    selectStep.screenBefore = nativeSelectScreen("before", false);
    selectStep.screenAfterAction = nativeSelectScreen("after", true);
    selectStep.actions = [{
      kind: "select-option", targetIdx: 4, targetLabel: "Alpha", targetCode: "1", value: "1",
      ok: true, detail: "fixture", selectReadback: { order: 1, code: "1", label: "Alpha" },
    }];
    assertEq((await receipt(mod, alternative, observation(alternative, [selectStep]))).ok, true);

    const duplicateSelect = structuredClone(selectStep);
    for (const retainedScreen of [duplicateSelect.screenBefore, duplicateSelect.screenAfterAction]) {
      retainedScreen.controls.push({ ...structuredClone(retainedScreen.controls[0]), idx: 5, id: "other-select" });
    }
    assertEq((await receipt(mod, alternative, observation(alternative, [duplicateSelect]))).ok, false);

    for (const makeUnusable of [
      (step) => { step.screenBefore.controls[0].visible = false; },
      (step) => { step.screenAfterAction.controls[0].disabled = true; },
      (step) => { step.screenBefore.controls[0].operable = false; },
      (step) => { step.screenAfterAction.controls[0].multiple = true; },
      (step) => { step.screenBefore.controls[0].options[1].disabled = true; },
      (step) => { step.screenAfterAction.controls[0].options[1].hidden = true; },
      (step) => { step.screenBefore.controls[0].options[1].placeholder = true; },
      (step) => { delete step.screenAfterAction.controls[0].options[0].hidden; },
      (step) => { delete step.screenBefore.controls[0].options[0].placeholder; },
    ]) {
      const unusableSelect = structuredClone(selectStep);
      makeUnusable(unusableSelect);
      assertEq((await receipt(mod, alternative, observation(alternative, [unusableSelect]))).ok, false);
    }
  });

  test("one action cannot close a sibling label and same-question different-history substitution refuses", async () => {
    const { mod, seedPlan } = await build();
    const alternative = seedPlan.alternatives[0];
    await mod.plan.stampPlannedOccurrenceIdentity([alternative.path]);
    const wrong = await receipt(mod, alternative, observation(alternative, [observedStep(alternative.path.decisions[0], "Beta")]));
    assertEq(wrong.ok, false);

    const duplicate = structuredClone(alternative);
    duplicate.path.decisions.unshift(decision("QX", ["prior"]));
    await mod.plan.stampPlannedOccurrenceIdentity([duplicate.path]);
    const substituted = await receipt(mod, duplicate, observation(duplicate, [observedStep(duplicate.path.decisions[1])]));
    assertEq(substituted.ok, false);
    assert(substituted.reason.includes("planned history") || substituted.reason.includes("planned history transition"));

    const routeA = structuredClone(alternative.path);
    const routeB = structuredClone(alternative.path);
    routeA.decisions.unshift(decision("QPRIOR", ["A"]));
    routeB.decisions.unshift(decision("QPRIOR", ["B"]));
    await mod.plan.stampPlannedOccurrenceIdentity([routeA, routeB]);
    assert(routeA.decisions[1].occurrence_id !== routeB.decisions[1].occurrence_id, "different prior answers collided on one occurrence identity");
    assert(routeA.decisions[1].history_digest !== routeB.decisions[1].history_digest, "different prior answers collided on one history digest");

    const priorPath = structuredClone(alternative);
    priorPath.path.decisions.unshift(decision("QPRIOR", ["A"]));
    await mod.plan.stampPlannedOccurrenceIdentity([priorPath.path]);
    const priorStep = observedStep(priorPath.path.decisions[0], "A");
    priorStep.actions[0].choiceReadback.checked = false;
    const targetAfterPrior = observedStep(priorPath.path.decisions[1]);
    targetAfterPrior.stepIndex = 1;
    for (const capture of targetAfterPrior.evidence.screenCaptures) capture.stepIndex = 1;
    const unperformedPrior = await receipt(mod, priorPath, observation(priorPath, [priorStep, targetAfterPrior]));
    assertEq(unperformedPrior.ok, false);
    assert(unperformedPrior.reason.includes("exact prior transition"));

    const checkboxPath = structuredClone(alternative);
    checkboxPath.path.decisions.unshift(decision("QCHECK", ["A", "B"]));
    await mod.plan.stampPlannedOccurrenceIdentity([checkboxPath.path]);
    const checkboxPrior = observedStep(checkboxPath.path.decisions[0], "A");
    checkboxPrior.actions = [
      { ...checkboxPrior.actions[0], targetIdx: 1, targetLabel: "A", choiceReadback: { idx: 1, type: "checkbox", name: null, checked: true, checkedGroupIdxs: [1] } },
      { ...checkboxPrior.actions[0], targetIdx: 2, targetLabel: "B", choiceReadback: { idx: 2, type: "checkbox", name: null, checked: true, checkedGroupIdxs: [1, 2] } },
    ];
    const checkboxTarget = observedStep(checkboxPath.path.decisions[1]);
    checkboxTarget.stepIndex = 1;
    for (const capture of checkboxTarget.evidence.screenCaptures) capture.stepIndex = 1;
    assertEq((await receipt(mod, checkboxPath, observation(checkboxPath, [checkboxPrior, checkboxTarget]))).ok, true);
    checkboxPrior.actions[1].choiceReadback.checkedGroupIdxs.push(9);
    assertEq((await receipt(mod, checkboxPath, observation(checkboxPath, [checkboxPrior, checkboxTarget]))).ok, false);

    const wrongHistory = structuredClone(alternative);
    await mod.plan.stampPlannedOccurrenceIdentity([wrongHistory.path]);
    wrongHistory.path.decisions[0].history_digest = "sha256:" + "0".repeat(64);
    const historyResult = await receipt(mod, wrongHistory, observation(wrongHistory, [observedStep(wrongHistory.path.decisions[0])]));
    assertEq(historyResult.reason, "path history digest differs");

    const unread = observedStep(alternative.path.decisions[0]);
    unread.actions[0].choiceReadback.checked = false;
    assertEq((await receipt(mod, alternative, observation(alternative, [unread]))).ok, false);

    const wrongCode = observedStep(alternative.path.decisions[0]);
    wrongCode.actions[0].targetCode = "2";
    assertEq((await receipt(mod, alternative, observation(alternative, [wrongCode]))).ok, false);
    const wrongControl = observedStep(alternative.path.decisions[0]);
    wrongControl.actions[0].choiceReadback.idx = 2;
    assertEq((await receipt(mod, alternative, observation(alternative, [wrongControl]))).ok, false);
    const noObservationArtifact = observation(alternative, [observedStep(alternative.path.decisions[0])]);
    noObservationArtifact.evidenceIds.pop();
    assertEq((await receipt(mod, alternative, noObservationArtifact, null)).reason, "immutable walk observation evidence is absent");

    const finalOnly = observedStep(alternative.path.decisions[0]);
    finalOnly.evidence.screenCaptures[1].slot = "final";
    assertEq((await receipt(mod, alternative, observation(alternative, [finalOnly]))).ok, false);
    const wrongEpoch = observedStep(alternative.path.decisions[0]);
    wrongEpoch.evidence.screenCaptures[1].stepIndex = 9;
    assertEq((await receipt(mod, alternative, observation(alternative, [wrongEpoch]))).ok, false);

    const partial = observation(alternative, [observedStep(alternative.path.decisions[0])]);
    partial.outcome = "browser-hung";
    assertEq((await receipt(mod, alternative, partial)).reason, "walk is error, hung, capped, or partial");

    const crossCase = structuredClone(alternative);
    crossCase.caseId = "fi_sibling";
    assertEq((await receipt(mod, crossCase, observation(crossCase, [observedStep(crossCase.path.decisions[0])]))).reason, "alternative case id differs from certified case");

    const inserted = observedStep(alternative.path.decisions[0]);
    inserted.decisionSource = "navigator-default";
    inserted.decisionQuestion = null;
    inserted.requested = null;
    const insertedResult = await receipt(mod, alternative, observation(alternative, [inserted, observedStep(alternative.path.decisions[0])]));
    assertEq(insertedResult.ok, false);
    assert(insertedResult.reason.includes("not the next planned history transition"));

    const emptyPrior = structuredClone(alternative);
    emptyPrior.path.decisions.unshift(decision("QPRIOR", []));
    await mod.plan.stampPlannedOccurrenceIdentity([emptyPrior.path]);
    const arbitraryAdvance = observedStep(emptyPrior.path.decisions[0]);
    arbitraryAdvance.actions = [{ ...arbitraryAdvance.actions[0], kind: "click-next", targetLabel: "Next", choiceReadback: null }];
    const emptyTarget = observedStep(emptyPrior.path.decisions[1]);
    emptyTarget.stepIndex = 1;
    for (const capture of emptyTarget.evidence.screenCaptures) capture.stepIndex = 1;
    assertEq((await receipt(mod, emptyPrior, observation(emptyPrior, [arbitraryAdvance, emptyTarget]))).ok, false);

    const textPrior = structuredClone(alternative);
    textPrior.path.decisions.unshift({ question: "QTEXT", text_entry: { value: "requested" }, source: "sealed-floor" });
    await mod.plan.stampPlannedOccurrenceIdentity([textPrior.path]);
    const unreadText = observedStep({ ...textPrior.path.decisions[0], select: ["placeholder"] });
    unreadText.requested = { select: [], textEntry: "requested", action: null };
    unreadText.actions = [{ ...unreadText.actions[0], kind: "type-text", value: "requested", targetLabel: null, choiceReadback: null }];
    const textTarget = observedStep(textPrior.path.decisions[1]);
    textTarget.stepIndex = 1;
    for (const capture of textTarget.evidence.screenCaptures) capture.stepIndex = 1;
    assertEq((await receipt(mod, textPrior, observation(textPrior, [unreadText, textTarget]))).ok, false);
  });

  test("resume revalidates retained RenderedScreen bytes and full epoch catalogue bindings", async () => {
    const { mod, seedPlan } = await build();
    const env = testEnv();
    const runId = mod.ids.mintRunId();
    const alternative = seedPlan.alternatives[0];
    await mod.plan.stampPlannedOccurrenceIdentity([alternative.path]);
    const obs = observation(alternative, [observedStep(alternative.path.decisions[0])]);
    obs.runId = runId;
    obs.evidenceIds = [];
    const entries = [];
    for (const [slot, signature] of [["before", "before"], ["after-action", "after"]]) {
      const retainedScreen = slot === "before" ? obs.steps[0].screenBefore : obs.steps[0].screenAfterAction;
      const entry = await mod.evidence.putEvidence(env, {
        runId, bytes: new TextEncoder().encode(JSON.stringify(retainedScreen)),
        mediaType: "application/json", type: "dom-excerpt", attemptId: obs.attemptId,
        routeId: alternative.alternativeId, sourceEvidenceId: `EV-${alternative.alternativeId}-0-${slot}`,
        artifactRef: `runs/${runId}/walks/${alternative.alternativeId}/${slot}.json`, witnesses: [],
      });
      entries.push(entry);
      const capture = obs.steps[0].evidence.screenCaptures.find((row) => row.slot === slot);
      capture.screenJson = {
        kind: "screen-json", evidenceId: entry.evidenceId, artifactRef: entry.artifactRef,
        sourceEvidenceId: entry.sourceEvidenceId, contentHash: entry.contentHash,
        mediaType: entry.mediaType, size: entry.size,
      };
      obs.evidenceIds.push(entry.evidenceId);
    }
    const observationEntry = await mod.evidence.putEvidence(env, {
      runId, bytes: new TextEncoder().encode(JSON.stringify(obs)), mediaType: "application/json",
      type: "state", attemptId: obs.attemptId, routeId: alternative.alternativeId,
      sourceEvidenceId: `EV-${alternative.alternativeId}-observation`,
      artifactRef: `runs/${runId}/walks/${alternative.alternativeId}/observation.json`, witnesses: [],
    });
    const derived = await receipt(mod, alternative, obs, observationEntry.evidenceId);
    assertEq(derived.ok, true);
    const audit = mod.executeBatch.assessExercised(obs, alternative.path.decisions);
    const walk = mod.executeBatch.walkRecord(obs, [derived.receipt.caseId], audit, undefined, observationEntry.evidenceId);
    const artifact = await mod.executeBatch.seedCommitArtifact(derived.receipt, null, observationEntry.evidenceId, obs, walk);
    const originalList = env.EVIDENCE.list;
    env.EVIDENCE.list = async () => { throw new Error("W5 exact evidence joins must never enumerate the catalogue"); };
    assertEq((await mod.executeBatch.seedCommitArtifactFailures(env, runId, artifact, alternative)).length, 0);

    const commitKey = `v2/runs/${runId}/execution/seed-attempts/${obs.attemptId}.json`;
    await env.EVIDENCE.put(commitKey, JSON.stringify(artifact));
    const cursor = {
      batchIndex: 1, sessionId: null, sessionOpenedAt: null, pendingCaseIds: [],
      completedCaseIds: [derived.receipt.caseId], planRevisionId: "plan",
      seedExecution: {
        programHash: "sha256:program", doneAlternativeIds: [alternative.alternativeId],
        committedAttemptIds: [obs.attemptId], reservation: null,
        attempts: [{ alternativeId: alternative.alternativeId, attemptId: obs.attemptId, artifactHash: artifact.artifactHash, artifactKey: commitKey }],
        refusals: [],
        receipts: [{
          caseId: derived.receipt.caseId, alternativeId: alternative.alternativeId, attemptId: obs.attemptId,
          receiptHash: derived.receipt.receiptHash, seedCertificateHash: derived.receipt.seedCertificateHash,
          commitArtifactHash: artifact.artifactHash, artifactKey: commitKey,
        }],
      },
    };
    const stale = {
      kind: "v2-execution-progress/1.0.0", runId, planRevisionId: "plan",
      walks: [], floorDone: [], explorationDone: [], seedDone: [], caseWitnessReceipts: [],
      seedReceiptRefusals: [], shimRequired: false, shimEvidence: null, hungPaths: [],
      screenoutPivots: {}, totalSteps: 0, totalEvidence: 0,
    };
    assertEq(await mod.executeBatch.reconcileSeedProgress(env, { runId, seedPlan }, cursor, stale), true);
    assertEq(stale.seedDone.join(","), alternative.alternativeId);
    assertEq(stale.walks.length, 1);
    assertEq(stale.caseWitnessReceipts.length, 1);
    assertEq(stale.totalSteps, walk.steps);
    assertEq(stale.totalEvidence, walk.evidenceCount);
    await mod.executeBatch.saveProgress(env, stale);
    const rebuilt = await mod.executeBatch.loadProgress(env, runId, "plan");
    assertEq(rebuilt.walks[0].observationEvidenceId, observationEntry.evidenceId);
    assertEq(rebuilt.caseWitnessReceipts[0].receiptHash, derived.receipt.receiptHash);
    env.EVIDENCE.list = originalList;

    const beforeBlobKey = mod.keys.evidenceBlobKey(entries[0].contentHash);
    const original = env.EVIDENCE._store.get(beforeBlobKey);
    env.EVIDENCE._store.set(beforeBlobKey, { ...original, bytes: new TextEncoder().encode(JSON.stringify({ screenSignature: "swapped" })) });
    const corruptFailures = await mod.executeBatch.seedCommitArtifactFailures(env, runId, artifact, alternative);
    assert(corruptFailures.some((row) => row.includes("absent, corrupt, or unreadable")));
    env.EVIDENCE._store.set(beforeBlobKey, original);
    await env.EVIDENCE.delete(beforeBlobKey);
    const missingFailures = await mod.executeBatch.seedCommitArtifactFailures(env, runId, artifact, alternative);
    assert(missingFailures.some((row) => row.includes("absent, corrupt, or unreadable")));

    env.EVIDENCE._store.set(beforeBlobKey, original);
    const swappedObs = structuredClone(obs);
    swappedObs.steps[0].evidence.screenCaptures[0].screenJson = structuredClone(swappedObs.steps[0].evidence.screenCaptures[1].screenJson);
    const swappedWalk = mod.executeBatch.walkRecord(swappedObs, [derived.receipt.caseId], audit, undefined, observationEntry.evidenceId);
    const swappedArtifact = await mod.executeBatch.seedCommitArtifact(derived.receipt, null, observationEntry.evidenceId, swappedObs, swappedWalk);
    const swappedFailures = await mod.executeBatch.seedCommitArtifactFailures(env, runId, swappedArtifact, alternative);
    assert(swappedFailures.some((row) =>
      row.includes("epoch identity") || row.includes("catalogue binding") || row.includes("embedded observation differs")));

    const alteredScreenEntry = await mod.evidence.putEvidence(env, {
      runId, bytes: new TextEncoder().encode(JSON.stringify({ screenSignature: "before", visibleText: "altered" })),
      mediaType: "application/json", type: "dom-excerpt", attemptId: obs.attemptId,
      routeId: alternative.alternativeId, sourceEvidenceId: `EV-${alternative.alternativeId}-0-before`,
      artifactRef: `runs/${runId}/walks/${alternative.alternativeId}/altered-before.json`, witnesses: [],
    });
    const alteredObs = structuredClone(obs);
    alteredObs.steps[0].evidence.screenCaptures[0].screenJson = {
      kind: "screen-json", evidenceId: alteredScreenEntry.evidenceId, artifactRef: alteredScreenEntry.artifactRef,
      sourceEvidenceId: alteredScreenEntry.sourceEvidenceId, contentHash: alteredScreenEntry.contentHash,
      mediaType: alteredScreenEntry.mediaType, size: alteredScreenEntry.size,
    };
    alteredObs.evidenceIds[0] = alteredScreenEntry.evidenceId;
    const alteredObservationEntry = await mod.evidence.putEvidence(env, {
      runId, bytes: new TextEncoder().encode(JSON.stringify(alteredObs)), mediaType: "application/json",
      type: "state", attemptId: alteredObs.attemptId, routeId: alternative.alternativeId,
      sourceEvidenceId: `EV-${alternative.alternativeId}-observation`,
      artifactRef: `runs/${runId}/walks/${alternative.alternativeId}/altered-observation.json`, witnesses: [],
    });
    const alteredReceipt = await receipt(mod, alternative, alteredObs, alteredObservationEntry.evidenceId);
    assertEq(alteredReceipt.ok, true);
    const alteredWalk = mod.executeBatch.walkRecord(
      alteredObs, [alteredReceipt.receipt.caseId],
      mod.executeBatch.assessExercised(alteredObs, alternative.path.decisions),
      undefined, alteredObservationEntry.evidenceId,
    );
    const alteredArtifact = await mod.executeBatch.seedCommitArtifact(
      alteredReceipt.receipt, null, alteredObservationEntry.evidenceId, alteredObs, alteredWalk,
    );
    const alteredFailures = await mod.executeBatch.seedCommitArtifactFailures(env, runId, alteredArtifact, alternative);
    assert(alteredFailures.some((row) => row.includes("bytes differ from the retained step screen")));
  });

  test("duplicate alternatives preserve the first valid case receipt and close the denominator once", async () => {
    const { mod, seedPlan } = await build();
    const alternative = seedPlan.alternatives[0];
    await mod.plan.stampPlannedOccurrenceIdentity([alternative.path]);
    const result = await receipt(mod, alternative, observation(alternative, [observedStep(alternative.path.decisions[0])]));
    const first = mod.plan.retainFirstCaseWitnessReceipt([], result.receipt);
    const second = mod.plan.retainFirstCaseWitnessReceipt(first.receipts, { ...result.receipt, alternativeId: "another" });
    assertEq(first.closesCase, true);
    assertEq(second.closesCase, false);
    assertEq(second.receipts.length, 1);

    const tampered = structuredClone(result.receipt);
    tampered.performedAction.targetLabel = "Beta";
    assert((await mod.plan.storedCaseWitnessReceiptFailures(tampered, alternative)).includes("receipt action label differs"));
  });

  test("program bytes require a separately committed exact hash and legacy programs cannot carry seeds", async () => {
    const { mod, seedPlan } = await build();
    const program = { kind: "v2-execution-program/2.1.0", seedPlan };
    const exact = await mod.plan.executionProgramHash(program);
    assertEq((await mod.plan.w5ProgramAuthorityFailures(program, exact)).length, 0);
    assert((await mod.plan.w5ProgramAuthorityFailures(program, null)).some((row) => row.includes("authoritative checkpoint")));
    assert((await mod.plan.w5ProgramAuthorityFailures({ kind: "v2-execution-program/2.0.0", seedPlan }, exact)).some((row) => row.includes("legacy")));
    assert((await mod.plan.w5ProgramAuthorityFailures({ kind: "v2-execution-program/2.1.0" }, exact)).some((row) => row.includes("omits")));

    const floorPath = path();
    const regeneratedProgram = {
      kind: "v2-execution-program/2.1.0", seedPlan,
      plan: { floor: { paths: [floorPath], coverage: { witness_map: { req_seed: "FLOOR-01" } } } },
    };
    await mod.plan.stampPlannedOccurrenceIdentity([floorPath, ...seedPlan.alternatives.map((row) => row.path)]);
    assertEq((await mod.plan.regeneratedSeedPlanFailures(regeneratedProgram, revision([option("Alpha", "1"), option("Beta", "2")]), "sha256:" + "b".repeat(64))).length, 0);
    const tamperedPlan = structuredClone(regeneratedProgram);
    tamperedPlan.seedPlan.census.candidateCount += 1;
    assert((await mod.plan.regeneratedSeedPlanFailures(tamperedPlan, revision([option("Alpha", "1"), option("Beta", "2")]), "sha256:" + "b".repeat(64))).length > 0);

    // Exercise the actual stored-program/checkpoint/revision load join, not only its pure
    // helper. The program is produced by planStage, independently hash-bound in the checkpoint,
    // then altered at rest while that authority remains unchanged.
    const env = testEnv();
    const runId = mod.ids.mintRunId();
    const planRevisionId = mod.ids.mintPlanRevisionId();
    const sealed = await mod.contractRevision.sealContract(env, contractBody());
    await mod.checkpoint.createCheckpoint(env, mod.checkpoint.initialCheckpoint(env, runId, "standard", false));
    const planned = await mod.plan.planStage(env, {
      runId, contractRevisionId: sealed.contractRevisionId, planRevisionId,
      surveyUrl: "https://fixture.invalid/survey",
    });
    await mod.checkpoint.updateCheckpoint(env, runId, (draft) => {
      draft.execution = {
        batchIndex: 0, sessionId: null, sessionOpenedAt: null, pendingCaseIds: planned.caseIds,
        completedCaseIds: [], planRevisionId,
        seedExecution: {
          programHash: planned.programHash, doneAlternativeIds: [], committedAttemptIds: [],
          reservation: null, attempts: [], refusals: [], receipts: [],
        },
      };
    });
    assert((await mod.plan.loadProgram(env, runId, planRevisionId)) !== null);
    const storedTamper = structuredClone(planned.program);
    storedTamper.seedPlan.census.candidateCount += 1;
    await env.EVIDENCE.put(mod.keys.planKey(runId, planRevisionId), JSON.stringify(storedTamper));
    let loadRefused = false;
    try { await mod.plan.loadProgram(env, runId, planRevisionId); } catch { loadRefused = true; }
    assert(loadRefused, "loadProgram accepted altered stored seed census under the original checkpoint hash");
  });

  test("signed RunRecord projection preserves exact W5 program, attempt, certificate, receipt, and refusal authority", async () => {
    const mod = await worker();
    const seedExecution = {
      programHash: "sha256:program", doneAlternativeIds: ["SEED"], committedAttemptIds: ["att"], reservation: null,
      attempts: [{ alternativeId: "SEED", attemptId: "att", artifactHash: "sha256:artifact", artifactKey: "seed-attempt.json" }],
      refusals: [{ alternativeId: "ORPHAN", attemptId: "orphan", reason: "artifact absent; retired without coverage credit" }],
      receipts: [{
        caseId: "fi_seed", alternativeId: "SEED", attemptId: "att", receiptHash: "sha256:receipt",
        seedCertificateHash: "sha256:certificate", commitArtifactHash: "sha256:artifact", artifactKey: "seed-attempt.json",
      }],
    };
    const record = mod.assembleRecord.assembleRunRecordV2({
      runId: "v2r_w5", envelope: { input: {} },
      revision: { contractRevisionId: "cr", requirements: [], facetInstances: [], contractSupplements: [] },
      contractHash: "sha256:contract", observations: [], evidence: [], itemResults: [], walks: [],
      probeCapabilityLimitations: [], targetIdentity: { source: "fixture", targetBuildId: null, note: "" },
      checkpoint: { execution: { seedExecution }, usage: null }, planHash: "plan", startedAt: "start", endedAt: "end",
    });
    assertEq(JSON.stringify(record.exploration.seedExecution), JSON.stringify({
      programHash: seedExecution.programHash, doneAlternativeIds: seedExecution.doneAlternativeIds,
      attempts: seedExecution.attempts, refusals: seedExecution.refusals, receipts: seedExecution.receipts,
    }));
  });

  test("one checkpoint mutation atomically dedupes attempt credit, receipt closure, and seed completion", async () => {
    const mod = await worker();
    const cursor = {
      pendingCaseIds: ["fi_seed"], completedCaseIds: [],
      seedExecution: {
        programHash: "sha256:p", doneAlternativeIds: [], committedAttemptIds: [],
        reservation: { alternativeId: "SEED", attemptId: "att" }, attempts: [], receipts: [],
      },
    };
    const attemptArtifact = { alternativeId: "SEED", attemptId: "att", artifactHash: "sha256:a", artifactKey: "attempt.json" };
    const pointer = {
      caseId: "fi_seed", alternativeId: "SEED", attemptId: "att", receiptHash: "sha256:r",
      seedCertificateHash: "sha256:c",
      commitArtifactHash: "sha256:a", artifactKey: "attempt.json",
    };
    const first = mod.executeBatch.applySeedAttemptCommit(cursor, {
      alternativeId: "SEED", expectedCaseId: "fi_seed", expectedCertificateHash: "sha256:c", attemptId: "att", retryable: false, attemptArtifact, receipt: pointer,
    });
    assertEq(first.committed, true);
    assertEq(first.closed.join(","), "fi_seed");
    assertEq(cursor.seedExecution.doneAlternativeIds.join(","), "SEED");
    assertEq(cursor.seedExecution.receipts.length, 1);
    assertEq(cursor.seedExecution.attempts.length, 1);
    assertEq(cursor.seedExecution.reservation, null);
    const replay = mod.executeBatch.applySeedAttemptCommit(cursor, {
      alternativeId: "SEED", expectedCaseId: "fi_seed", expectedCertificateHash: "sha256:c", attemptId: "att", retryable: false, attemptArtifact, receipt: pointer,
    });
    assertEq(replay.committed, false);
    assertEq(cursor.seedExecution.receipts.length, 1);
    const retainedFirst = JSON.stringify(cursor.seedExecution.receipts[0]);
    // Deliberately leave the case pending: only the production receipt-pointer dedupe guard,
    // not a second pending-ledger guard, may prevent a duplicate closure here.
    cursor.pendingCaseIds = ["fi_seed"];
    cursor.completedCaseIds = [];
    cursor.seedExecution.reservation = { alternativeId: "SEED-B", attemptId: "att-b" };
    const secondArtifact = { alternativeId: "SEED-B", attemptId: "att-b", artifactHash: "sha256:b", artifactKey: "attempt-b.json" };
    const secondPointer = {
      ...pointer, alternativeId: "SEED-B", attemptId: "att-b", receiptHash: "sha256:r-b",
      commitArtifactHash: "sha256:b", artifactKey: "attempt-b.json",
    };
    const second = mod.executeBatch.applySeedAttemptCommit(cursor, {
      alternativeId: "SEED-B", expectedCaseId: "fi_seed", expectedCertificateHash: "sha256:c",
      attemptId: "att-b", retryable: false, attemptArtifact: secondArtifact, receipt: secondPointer,
    });
    assertEq(second.committed, true);
    assertEq(second.closed.length, 0);
    assertEq(cursor.seedExecution.attempts.length, 2);
    assertEq(cursor.seedExecution.doneAlternativeIds.join(","), "SEED,SEED-B");
    assertEq(cursor.seedExecution.receipts.length, 1);
    assertEq(JSON.stringify(cursor.seedExecution.receipts[0]), retainedFirst);
    const orphan = {
      pendingCaseIds: ["fi_seed"],
      seedExecution: {
        programHash: "sha256:p", doneAlternativeIds: [], committedAttemptIds: [],
        reservation: { alternativeId: "ORPHAN", attemptId: "orphan-att" }, attempts: [], refusals: [], receipts: [],
      },
    };
    mod.executeBatch.retireSeedReservationWithoutArtifact(orphan, orphan.seedExecution.reservation);
    assertEq(orphan.seedExecution.reservation, null);
    assertEq(orphan.seedExecution.doneAlternativeIds.join(","), "ORPHAN");
    assertEq(orphan.seedExecution.attempts.length, 0);
    assertEq(orphan.pendingCaseIds.join(","), "fi_seed");
    for (const mutate of [
      (a) => { a.expectedCaseId = "fi_other"; },
      (a) => { a.attemptArtifact.attemptId = "wrong"; },
      (a) => { a.receipt.alternativeId = "wrong"; },
      (a) => { a.receipt.attemptId = "wrong"; },
      (a) => { a.receipt.commitArtifactHash = "sha256:wrong"; },
      (a) => { a.receipt.artifactKey = "wrong.json"; },
    ]) {
      const fresh = {
        pendingCaseIds: ["fi_seed"], completedCaseIds: [],
        seedExecution: {
          programHash: "sha256:p", doneAlternativeIds: [], committedAttemptIds: [],
          reservation: { alternativeId: "SEED", attemptId: "att" }, attempts: [], receipts: [],
        },
      };
      const bad = {
        alternativeId: "SEED", expectedCaseId: "fi_seed", expectedCertificateHash: "sha256:c", attemptId: "att", retryable: false,
        attemptArtifact: structuredClone(attemptArtifact), receipt: structuredClone(pointer),
      };
      mutate(bad);
      let mismatchRefused = false;
      try { mod.executeBatch.applySeedAttemptCommit(fresh, bad); } catch { mismatchRefused = true; }
      assert(mismatchRefused, "cross-case/cross-attempt/hash/key substitution was accepted");
      assertEq(fresh.seedExecution.committedAttemptIds.length, 0);
      assertEq(fresh.seedExecution.receipts.length, 0);
      assertEq(fresh.seedExecution.reservation.attemptId, "att");
    }
    const wrongReservation = {
      pendingCaseIds: ["fi_seed"], completedCaseIds: [],
      seedExecution: {
        programHash: "sha256:p", doneAlternativeIds: [], committedAttemptIds: [],
        reservation: { alternativeId: "OTHER", attemptId: "att" }, attempts: [], receipts: [],
      },
    };
    let reservationRefused = false;
    try {
      mod.executeBatch.applySeedAttemptCommit(wrongReservation, {
        alternativeId: "SEED", expectedCaseId: "fi_seed", expectedCertificateHash: "sha256:c", attemptId: "att", retryable: false,
        attemptArtifact, receipt: pointer,
      });
    } catch { reservationRefused = true; }
    assert(reservationRefused, "mismatched pre-effect reservation was accepted");
    assertEq(wrongReservation.seedExecution.committedAttemptIds.length, 0);
    let refused = false;
    try {
      mod.executeBatch.applySeedAttemptCommit({ pendingCaseIds: ["fi_seed"] }, {
        alternativeId: "SEED", expectedCaseId: "fi_seed", expectedCertificateHash: "sha256:c", attemptId: "other", retryable: false,
        attemptArtifact: { ...attemptArtifact, attemptId: "other" }, receipt: pointer,
      });
    } catch { refused = true; }
    assert(refused, "absent checkpoint ledger did not fail closed");
  });

  test("selected seeds execute after the floor under a separate completion ledger and before optional exploration", async () => {
    const { mod, seedPlan } = await build();
    const program = {
      floor: [], seedPlan,
      plan: { floor: { paths: [] }, exploration: { queue: [{ id: "EXP", decisions: [], back_navigation: null }] } },
    };
    const progress = { floorDone: [], seedDone: [], explorationDone: [] };
    const seeded = mod.executeBatch.selectWork(program, progress, 1, 32);
    assertEq(seeded.length, 2);
    assert(seeded.every((row) => row.seedAlternative !== null));
    const optional = mod.executeBatch.selectWork(program, { ...progress, seedDone: seedPlan.alternatives.map((row) => row.alternativeId) }, 1, 32);
    assertEq(optional.length, 1);
    assertEq(optional[0].path.id, "EXP");
    assertEq(mod.executeBatch.screenoutRetryEligible({
      obs: { ending: { kind: "screened-out", evidence: ["fixture"] }, navigatorDefaultAnswerCount: 1 },
      path: seedPlan.alternatives[0].path, pivots: {}, pathsWalked: 0, maxAttempts: 4, now: 0, batchDeadline: 1,
    }), false);
  });
});

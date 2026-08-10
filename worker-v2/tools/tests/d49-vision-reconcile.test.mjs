/**
 * D49 — POSITIVE VISUAL MEMBERSHIP, RECONCILED WITHOUT HTML IDENTITY.
 *
 * The visual inventory is deliberately target-neutral. These tests prove the first consumer
 * keeps that boundary: it emits only question/group/option facts visible in the screenshot,
 * uses screen and AX labels as independent support, and refuses a membership when two captured
 * channels actually disagree. No fixture contains a document requirement.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { worker } from "./_helpers.mjs";

const SCREEN_HASH = "1".repeat(64);
const PNG_HASH = "2".repeat(64);
const AX_HASH = "3".repeat(64);
const PAIR_HASH = "4".repeat(64);
const EPOCH_ID = "epoch_d49_0000000000000001";
const QUESTION = "Which therapies are you aware of?";
const OPTIONS = ["NURTEC", "UBRELVY", "QULIPTA", "EMGALITY", "AJOVY"];

const bounds = (x = 0.1, y = 0.1, width = 0.8, height = 0.08) => ({ x, y, width, height });

const reading = (value, y = 0.1) => ({
  quote: {
    value,
    grounding: { kind: "visual-only", sourcePaths: [], evidenceSha256: [PNG_HASH] },
  },
  alternatives: [],
  readability: "read",
  modelConfidence: 0.94,
  bounds: bounds(0.1, y),
});

function visualGroup(questionRegionId, localId, options = OPTIONS) {
  return {
    localId,
    questionRegionId,
    selectionAppearance: "appears-multiple",
    bounds: bounds(0.08, 0.18, 0.84, 0.55),
    options: options.map((label, index) => ({
      localId: `${localId}-option-${index}`,
      text: reading(label, 0.23 + index * 0.08),
      markAppearance: "appears-unselected",
    })),
  };
}

function observation({
  questions = [{ localId: "visual-question-1", text: reading(QUESTION) }],
  groups = [visualGroup("visual-question-1", "visual-group-1")],
  visualLimitations = [],
  screenState = { state: "captured", evidenceId: "screen-d49", contentSha256: SCREEN_HASH },
  accessibilityState = { state: "captured", evidenceId: "ax-d49", contentSha256: AX_HASH },
} = {}) {
  return {
    schemaVersion: "survey-qa-visual-observation/1.0.0",
    kind: "survey-qa-visual-observation",
    createdAt: "2026-08-09T12:00:00.000Z",
    readState: "observed",
    inferenceCacheKey: "visual-inference/sha256/d49",
    cacheKey: "visual-observation/sha256/d49",
    input: {
      screenshotEvidenceId: "screenshot-d49",
      screenshotSha256: PNG_HASH,
      screen: screenState,
      accessibility: accessibilityState,
      pairedEvidenceSha256: PAIR_HASH,
      capture: {
        runId: "v2r_d49000000000000000000001",
        attemptId: "att_d49000000001",
        pathId: "path_d49000000001",
        stepIndex: 2,
        slot: "before",
        epochId: EPOCH_ID,
        scope: { kind: "viewport", tileIndex: null, tileCount: null },
      },
      geometry: {
        viewportCssWidth: 1280,
        viewportCssHeight: 900,
        screenshotPixelWidth: 1280,
        screenshotPixelHeight: 900,
        deviceScaleFactor: 1,
        scrollX: 0,
        scrollY: 0,
      },
    },
    provenance: {
      model: {
        provider: "fixture",
        requestedModel: "fixture-vision",
        reportedModel: "fixture-vision",
        transport: "fixture",
        configurationSha256: "5".repeat(64),
      },
      prompt: { version: "fixture", sha256: "6".repeat(64) },
      responseSchema: { version: "fixture", sha256: "7".repeat(64) },
      call: null,
    },
    inventory: {
      questionRegions: questions,
      optionGroups: groups,
      controls: [],
      messages: [],
      visualLimitations,
    },
    limitations: [],
    counts: {
      questionRegions: questions.length,
      optionGroups: groups.length,
      options: groups.reduce((sum, group) => sum + group.options.length, 0),
      controls: 0,
      messages: 0,
      modelReportedVisualLimitations: visualLimitations.reduce((sum, item) => sum + item.count, 0),
      metadataGroundedQuotes: 0,
      visualOnlyQuotes: questions.length + groups.reduce((sum, group) => sum + group.options.length, 0),
      limitations: 0,
    },
  };
}

const option = (label, index) => ({
  order: index,
  idx: index,
  code: String(index + 1),
  label,
  checked: false,
  disabled: false,
  visible: true,
  operable: true,
  actuatedVia: "label",
  labelIndex: index,
});

function screen({ question = QUESTION, options = OPTIONS, fragmented = false } = {}) {
  const optionGroups = fragmented
    ? options.map((label, index) => ({
        // These names reproduce the measured SurveyJS capture shape. The reconciler must not
        // read them, their prefixes, or any other HTML convention.
        name: `Q1${label}`,
        kind: "checkbox",
        options: [option(label, index)],
      }))
    : [{ name: "opaque-group-name", kind: "checkbox", options: options.map(option) }];
  return {
    at: "2026-08-09T12:00:00.000Z",
    url: "https://fixture.invalid/survey",
    title: "Fixture",
    collectedErrors: [],
    questionText: question,
    instructionText: "Select all that apply",
    visibleText: `${question} ${options.join(" ")}`,
    visibleTextTruncated: false,
    bracketedInstructionsVisible: [],
    controls: [],
    optionGroups,
    grid: null,
    buttons: [],
    progress: { present: false, kind: null, now: null, max: null, text: null },
    validationMessages: [],
    readerLimitations: [],
    counts: {
      controls: 0,
      optionGroups: optionGroups.length,
      options: options.length,
      textInputs: 0,
      valueInputs: 0,
      readerLimitations: 0,
    },
    screenSignature: "d49-screen-signature",
  };
}

function ax(question = QUESTION, options = OPTIONS) {
  return {
    kind: "v2-accessibility-snapshot/1.0.0",
    epochId: EPOCH_ID,
    stepIndex: 2,
    slot: "before",
    capturedAt: "2026-08-09T12:00:00.010Z",
    screenReadAt: "2026-08-09T12:00:00.000Z",
    screenSignatureHash: "8".repeat(64),
    geometry: {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      scrollX: 0,
      scrollY: 0,
      documentWidth: 1280,
      documentHeight: 900,
      source: "browser",
    },
    pairing: {
      screenJson: {
        kind: "screen-json",
        evidenceId: "screen-d49",
        artifactRef: "runs/d49/screen.json",
        sourceEvidenceId: "screen-d49",
        contentHash: SCREEN_HASH,
        mediaType: "application/json",
        size: 100,
      },
      screenshot: {
        kind: "screenshot",
        evidenceId: "screenshot-d49",
        artifactRef: "runs/d49/screenshot.png",
        sourceEvidenceId: "screenshot-d49",
        contentHash: PNG_HASH,
        mediaType: "image/png",
        size: 100,
      },
    },
    capture: {
      interestingOnly: false,
      completeness: "complete",
      limitations: [],
      nodeCount: options.length + 2,
      maxDepthObserved: 2,
      serializedBytes: 500,
      limits: { maxNodes: 5000, maxDepth: 64, maxValueChars: 4000, maxSerializedBytes: 1000000 },
    },
    tree: {
      role: "RootWebArea",
      name: "Survey",
      children: [
        {
          role: "group",
          name: question,
          children: options.map((name) => ({ role: "checkbox", name, checked: false, children: [] })),
        },
      ],
    },
  };
}

const screenReading = (value = screen()) => ({ evidenceId: "screen-d49", contentSha256: SCREEN_HASH, value });
const axReading = (value = ax()) => ({ evidenceId: "ax-d49", contentSha256: AX_HASH, value });

suite("D49 — visual + AX option membership is independent of HTML grouping names", () => {
  test("fragmented checkbox names still produce one visually grouped, AX-supported fact per label", async () => {
    const mod = await worker();
    const result = mod.visionReconcile.reconcileOptionMembership({
      observation: observation(),
      screen: screenReading(screen({ fragmented: true })),
      accessibility: axReading(),
    });
    const changedDomProjection = mod.visionReconcile.reconcileOptionMembership({
      observation: observation(),
      screen: screenReading(screen({ question: "DOM READER DISAGREES", options: ["NOT A VISUAL OPTION"], fragmented: true })),
      accessibility: axReading(),
    });

    assertEq(result.facts.length, OPTIONS.length, JSON.stringify(result));
    assertEq(result.conflicts.length, 0, JSON.stringify(result.conflicts));
    assertEq(
      JSON.stringify(changedDomProjection),
      JSON.stringify(result),
      "changing DOM-derived question/labels/names must not change semantic reconciliation",
    );
    assertEq(result.facts.map((fact) => fact.option.text).join(","), OPTIONS.join(","));
    for (const fact of result.facts) {
      assertEq(fact.question.text, QUESTION);
      assertEq(fact.support.visual, "question-group-option-exact");
      assertEq(fact.support.accessibility.state, "group-and-option-exact");
      assertEq(fact.source.screen.state, "paired");
      assertEq(fact.question.quoteGrounding.kind, "visual-only");
      assertEq(fact.option.quoteGrounding.kind, "visual-only");
      assert(!("screen" in fact.support), "DOM/screen projection appeared as semantic support");
    }
    assert(
      !result.limitations.some((item) => item.kind.includes("nonunique") || item.kind === "channel-disagreement"),
      JSON.stringify(result.limitations),
    );
  });

  test("two visually indistinguishable question/option memberships are named ambiguous, never selected", async () => {
    const mod = await worker();
    const repeatedQuestion = "Which therapy?";
    const questions = [
      { localId: "question-a", text: reading(repeatedQuestion) },
      { localId: "question-b", text: reading(repeatedQuestion) },
    ];
    const groups = [visualGroup("question-a", "group-a", ["Yes"]), visualGroup("question-b", "group-b", ["Yes"])];
    const unavailable = { state: "unavailable", failure: { kind: "fixture-not-captured", count: 1, detail: "fixture" } };
    const result = mod.visionReconcile.reconcileOptionMembership({
      observation: observation({ questions, groups, screenState: unavailable, accessibilityState: unavailable }),
      screen: null,
      accessibility: null,
    });

    assertEq(result.facts.length, 0, JSON.stringify(result.facts));
    assertEq(result.conflicts.length, 0);
    assert(
      result.limitations.some((item) => item.kind === "visual-question-label-nonunique" && item.count === 2),
      JSON.stringify(result.limitations),
    );
  });

  test("an exact AX question group carrying a different option is a channel conflict, not a visual fact", async () => {
    const mod = await worker();
    const oneOptionObservation = observation({ groups: [visualGroup("visual-question-1", "visual-group-1", ["NURTEC"])] });
    const result = mod.visionReconcile.reconcileOptionMembership({
      observation: oneOptionObservation,
      screen: screenReading(screen({ options: ["NURTEC"] })),
      accessibility: axReading(ax(QUESTION, ["UBRELVY"])),
    });

    assertEq(result.facts.length, 0, JSON.stringify(result.facts));
    assertEq(result.conflicts.length, 1, JSON.stringify(result.conflicts));
    assertEq(result.conflicts[0].kind, "channel-disagreement");
    assertEq(result.conflicts[0].channel, "accessibility");
    assertEq(result.conflicts[0].otherChannel.observedOptionNames.join(","), "UBRELVY");
    assert(result.limitations.some((item) => item.kind === "channel-disagreement"), JSON.stringify(result.limitations));
  });

  test("missing AX retains the uniquely grouped visual fact and names the reduced support", async () => {
    const mod = await worker();
    const unavailable = {
      state: "unavailable",
      failure: { kind: "accessibility-api-unavailable", count: 1, detail: "browser exposed no AX API" },
    };
    const result = mod.visionReconcile.reconcileOptionMembership({
      observation: observation({
        groups: [visualGroup("visual-question-1", "visual-group-1", ["NURTEC"])],
        accessibilityState: unavailable,
      }),
      screen: screenReading(screen({ options: ["NURTEC"] })),
      accessibility: null,
    });

    assertEq(result.facts.length, 1, JSON.stringify(result));
    assertEq(result.conflicts.length, 0);
    assertEq(result.facts[0].support.accessibility.state, "unavailable");
    assertEq(result.facts[0].source.screen.state, "paired");
    assert(
      result.limitations.some((item) => item.kind === "accessibility-capture-unavailable" && item.count === 1),
      JSON.stringify(result.limitations),
    );
  });

  test("a model-reported grouping ambiguity overlapping the group suppresses membership facts", async () => {
    const mod = await worker();
    const result = mod.visionReconcile.reconcileOptionMembership({
      observation: observation({
        groups: [visualGroup("visual-question-1", "visual-group-1", ["NURTEC"])],
        visualLimitations: [{ kind: "ambiguous-grouping", count: 1, bounds: bounds(0.05, 0.15, 0.9, 0.65) }],
      }),
      screen: screenReading(screen({ options: ["NURTEC"] })),
      accessibility: axReading(ax(QUESTION, ["NURTEC"])),
    });

    assertEq(result.facts.length, 0, JSON.stringify(result.facts));
    assertEq(result.conflicts.length, 0);
    assert(
      result.limitations.some((item) => item.kind === "visual-group-ambiguity-reported" && item.count === 1),
      JSON.stringify(result.limitations),
    );
  });

  test("the output contract has no inventory-closure or normative decision surface", async () => {
    const mod = await worker();
    const result = mod.visionReconcile.reconcileOptionMembership({
      observation: observation({ groups: [visualGroup("visual-question-1", "visual-group-1", ["NURTEC"])] }),
      screen: screenReading(screen({ options: ["NURTEC"] })),
      accessibility: axReading(ax(QUESTION, ["NURTEC"])),
    });
    const wire = JSON.stringify(result);
    const forbiddenKeys = [
      "exhaustive",
      "closedSet",
      "expected",
      "requirement",
      "verdict",
      "passed",
      "failed",
      "compliance",
      "defect",
      "verified",
      "contradicted",
    ];
    for (const key of forbiddenKeys) assert(!wire.includes(`\"${key}\"`), `forbidden output key ${key}: ${wire}`);
    assertEq(result.scope, "visible-positive-membership-only");
    assertEq(result.facts.length, 1);
    assertEq(result.facts[0].kind, "option-membership");
  });
});

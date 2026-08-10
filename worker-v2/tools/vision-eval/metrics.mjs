import { validateFixture, validatePredictionRecord } from "./schema.mjs";

const EPSILON = 1e-12;

export const DEFAULT_POLICY = Object.freeze({
  minExactTextRecall: 0.95,
  minNormalizedTextRecall: 1,
  minNormalizedTextPrecision: 0.95,
  minCategoryTextF1: 1,
  minMessageKindAccuracy: 1,
  minMessageKindF1: 1,
  minGroupingF1: 1,
  minControlKindAccuracy: 1,
  minAppearanceStateAccuracy: 1,
  minVisibleButtonLinkF1: 1,
  minMeanBboxIou: 0.75,
  minBboxThresholdRate: 0.95,
  bboxIouThreshold: 0.5,
  minLimitationRegionPrecision: 1,
  minLimitationRegionRecall: 1,
  minLimitationKindAccuracy: 1,
  minLimitationCountPrecision: 1,
  minLimitationCountRecall: 1,
  maxUnexpectedUnlocalizedLimitationEntries: 0,
  maxEmptyOptionGroups: 0,
  requireNoSilentOmissions: true,
  maxLatencyMs: null,
  maxCostUsd: null,
});

/** Enabled-by-default quality gates. test.mjs proves every one can fail. */
export const DEFAULT_ENABLED_GATES = Object.freeze([
  "visible_text_exact_recall",
  "visible_text_normalized_recall",
  "visible_text_normalized_precision",
  "region_category_text_f1",
  "message_kind_accuracy",
  "message_kind_f1",
  "question_option_grouping_f1",
  "visual_control_kind_accuracy",
  "visual_appearance_state_accuracy",
  "visible_button_link_f1",
  "bbox_mean_iou",
  "bbox_threshold_rate",
  "visual_limitation_region_precision",
  "visual_limitation_region_recall",
  "visual_limitation_kind_accuracy",
  "visual_limitation_count_precision",
  "visual_limitation_count_recall",
  "unexpected_unlocalized_limitation_entries",
  "empty_option_groups",
  "no_silent_omissions",
]);

export function exactTextKey(value) {
  return String(value).normalize("NFC");
}

export function normalizeVisibleText(value) {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\u2018\u2019\u201A\u201B]/gu, "'")
    .replace(/[\u2010-\u2015]/gu, "-")
    .replace(/\p{P}+/gu, " ")
    .replace(/\p{White_Space}+/gu, " ")
    .trim();
}

function area(box) {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

function intersectionArea(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

export function bboxIou(a, b) {
  const intersection = intersectionArea(a, b);
  const union = area(a) + area(b) - intersection;
  return union > 0 ? intersection / union : 0;
}

function targetCoverage(target, declaration) {
  const targetArea = area(target);
  return targetArea > 0 ? intersectionArea(target, declaration) / targetArea : 0;
}

function ratio(numerator, denominator, emptyValue = 1) {
  return denominator === 0 ? emptyValue : numerator / denominator;
}

function harmonicMean(precision, recall) {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function multisetStats(expectedValues, predictedValues, keyFn) {
  const expected = new Map();
  const predicted = new Map();
  for (const value of expectedValues) {
    const key = keyFn(value);
    expected.set(key, (expected.get(key) ?? 0) + 1);
  }
  for (const value of predictedValues) {
    const key = keyFn(value);
    predicted.set(key, (predicted.get(key) ?? 0) + 1);
  }
  let truePositive = 0;
  for (const [key, count] of expected) truePositive += Math.min(count, predicted.get(key) ?? 0);
  const precision = ratio(truePositive, predictedValues.length, expectedValues.length === 0 ? 1 : 0);
  const recall = ratio(truePositive, expectedValues.length);
  return {
    expected: expectedValues.length,
    predicted: predictedValues.length,
    truePositive,
    precision,
    recall,
    f1: harmonicMean(precision, recall),
  };
}

function flattenInventory(inventory) {
  const questions = inventory.questionRegions.map((question, questionIndex) => ({
    ...question,
    reading: question.text,
    bounds: question.text.bounds,
    questionIndex,
    category: "question",
  }));
  const options = [];
  inventory.optionGroups.forEach((group, groupIndex) => {
    group.options.forEach((option) => {
      options.push({
        ...option,
        reading: option.text,
        bounds: option.text.bounds,
        groupIndex,
        parentQuestionRegionId: group.questionRegionId,
        category: "option",
      });
    });
  });
  const controls = inventory.controls.map((control, controlIndex) => ({
    ...control,
    reading: control.text,
    bounds: control.bounds,
    controlIndex,
    category: "control",
  }));
  const messages = inventory.messages.map((message, messageIndex) => ({
    ...message,
    reading: message.text,
    bounds: message.text.bounds,
    messageIndex,
    category: "message",
  }));
  const allTextNodes = [...questions, ...options, ...controls.filter((control) => control.reading !== null), ...messages];
  const quotedNodes = allTextNodes.filter((node) => typeof node.reading?.quote === "string");
  return { questions, options, controls, messages, allTextNodes, quotedNodes };
}

function matchByQuote(expectedNodes, predictedNodes) {
  const candidates = [];
  for (let expectedIndex = 0; expectedIndex < expectedNodes.length; expectedIndex += 1) {
    const expectedQuote = expectedNodes[expectedIndex].reading?.quote;
    if (typeof expectedQuote !== "string") continue;
    for (let predictedIndex = 0; predictedIndex < predictedNodes.length; predictedIndex += 1) {
      const predictedQuote = predictedNodes[predictedIndex].reading?.quote;
      if (typeof predictedQuote !== "string") continue;
      if (normalizeVisibleText(expectedQuote) !== normalizeVisibleText(predictedQuote)) continue;
      candidates.push({
        expectedIndex,
        predictedIndex,
        exact: exactTextKey(expectedQuote) === exactTextKey(predictedQuote) ? 1 : 0,
        iou: bboxIou(expectedNodes[expectedIndex].bounds, predictedNodes[predictedIndex].bounds),
      });
    }
  }
  return greedyMatch(candidates, expectedNodes.length, predictedNodes.length);
}

/**
 * Text-bearing controls are identified by their pixels. A genuinely textless or
 * icon-only control has no quote to match, so it is paired spatially and then its
 * independently reported visual kind is scored. No aria-label or DOM identifier
 * enters this match.
 */
function matchControls(expectedControls, predictedControls) {
  const candidates = [];
  for (let expectedIndex = 0; expectedIndex < expectedControls.length; expectedIndex += 1) {
    const expected = expectedControls[expectedIndex];
    for (let predictedIndex = 0; predictedIndex < predictedControls.length; predictedIndex += 1) {
      const predicted = predictedControls[predictedIndex];
      const expectedQuote = expected.reading?.quote;
      const predictedQuote = predicted.reading?.quote;
      const iou = bboxIou(expected.bounds, predicted.bounds);
      if (typeof expectedQuote === "string" || typeof predictedQuote === "string") {
        if (
          typeof expectedQuote !== "string" ||
          typeof predictedQuote !== "string" ||
          normalizeVisibleText(expectedQuote) !== normalizeVisibleText(predictedQuote)
        ) {
          continue;
        }
        candidates.push({
          expectedIndex,
          predictedIndex,
          exact: exactTextKey(expectedQuote) === exactTextKey(predictedQuote) ? 2 : 1,
          iou,
        });
      } else if (iou >= 0.3) {
        candidates.push({
          expectedIndex,
          predictedIndex,
          // Kind is the attribute being scored, so it must not be used to
          // choose a favorable pairing. Geometry owns textless identity.
          exact: 0,
          iou,
        });
      }
    }
  }
  return greedyMatch(candidates, expectedControls.length, predictedControls.length);
}

function greedyMatch(candidates, expectedCount, predictedCount) {
  candidates.sort(
    (a, b) =>
      (b.exact ?? 0) - (a.exact ?? 0) ||
      b.iou - a.iou ||
      a.expectedIndex - b.expectedIndex ||
      a.predictedIndex - b.predictedIndex,
  );
  const usedExpected = new Set();
  const usedPredicted = new Set();
  const pairs = [];
  for (const candidate of candidates) {
    if (usedExpected.has(candidate.expectedIndex) || usedPredicted.has(candidate.predictedIndex)) continue;
    usedExpected.add(candidate.expectedIndex);
    usedPredicted.add(candidate.predictedIndex);
    pairs.push(candidate);
  }
  return {
    pairs,
    expectedToPredicted: new Map(pairs.map((pair) => [pair.expectedIndex, pair.predictedIndex])),
    predictedToExpected: new Map(pairs.map((pair) => [pair.predictedIndex, pair.expectedIndex])),
    unmatchedExpected: Array.from({ length: expectedCount }, (_, index) => index).filter((index) => !usedExpected.has(index)),
    unmatchedPredicted: Array.from({ length: predictedCount }, (_, index) => index).filter((index) => !usedPredicted.has(index)),
  };
}

function groupSignature(group) {
  return group.options
    .map((option) => (typeof option.text.quote === "string" ? normalizeVisibleText(option.text.quote) : "<abstained>"))
    .sort()
    .join("\u001f");
}

function matchGroups(expectedGroups, predictedGroups) {
  const candidates = [];
  for (let expectedIndex = 0; expectedIndex < expectedGroups.length; expectedIndex += 1) {
    for (let predictedIndex = 0; predictedIndex < predictedGroups.length; predictedIndex += 1) {
      if (groupSignature(expectedGroups[expectedIndex]) !== groupSignature(predictedGroups[predictedIndex])) continue;
      candidates.push({
        expectedIndex,
        predictedIndex,
        iou: bboxIou(expectedGroups[expectedIndex].bounds, predictedGroups[predictedIndex].bounds),
      });
    }
  }
  return greedyMatch(candidates, expectedGroups.length, predictedGroups.length);
}

function spatialMatch(expectedRegions, predictedRegions, threshold = 0.3) {
  const candidates = [];
  for (let expectedIndex = 0; expectedIndex < expectedRegions.length; expectedIndex += 1) {
    for (let predictedIndex = 0; predictedIndex < predictedRegions.length; predictedIndex += 1) {
      const iou = bboxIou(expectedRegions[expectedIndex].bounds, predictedRegions[predictedIndex].bounds);
      if (iou >= threshold) candidates.push({ expectedIndex, predictedIndex, iou });
    }
  }
  return greedyMatch(candidates, expectedRegions.length, predictedRegions.length);
}

function categoryTextMetrics(expected, predicted) {
  const categories = ["question", "option", "control", "message"];
  const byCategory = {};
  let minimumCategoryF1 = 1;
  for (const category of categories) {
    const expectedQuotes = expected.quotedNodes
      .filter((node) => node.category === category)
      .map((node) => node.reading.quote);
    const predictedQuotes = predicted.quotedNodes
      .filter((node) => node.category === category)
      .map((node) => node.reading.quote);
    const exact = multisetStats(expectedQuotes, predictedQuotes, exactTextKey);
    const normalized = multisetStats(expectedQuotes, predictedQuotes, normalizeVisibleText);
    byCategory[category] = { exact, normalized };
    if (expectedQuotes.length > 0 || predictedQuotes.length > 0) {
      minimumCategoryF1 = Math.min(minimumCategoryF1, normalized.f1);
    }
  }
  return { byCategory, minimumCategoryF1 };
}

function computeMessageKinds(expectedMessages, predictedMessages) {
  const match = matchByQuote(expectedMessages, predictedMessages);
  let correct = 0;
  for (const pair of match.pairs) {
    if (expectedMessages[pair.expectedIndex].kind === predictedMessages[pair.predictedIndex].kind) correct += 1;
  }
  const byKind = {};
  let minimumKindF1 = 1;
  for (const kind of ["instruction", "validation", "progress", "other"]) {
    const expectedQuotes = expectedMessages
      .filter((message) => message.kind === kind && typeof message.reading?.quote === "string")
      .map((message) => message.reading.quote);
    const predictedQuotes = predictedMessages
      .filter((message) => message.kind === kind && typeof message.reading?.quote === "string")
      .map((message) => message.reading.quote);
    byKind[kind] = multisetStats(expectedQuotes, predictedQuotes, normalizeVisibleText);
    if (expectedQuotes.length > 0 || predictedQuotes.length > 0) {
      minimumKindF1 = Math.min(minimumKindF1, byKind[kind].f1);
    }
  }
  return {
    expected: expectedMessages.length,
    predicted: predictedMessages.length,
    quoteMatched: match.pairs.length,
    correct,
    accuracy: ratio(correct, expectedMessages.length),
    byKind,
    minimumKindF1,
  };
}

function computeGrouping(expectedInventory, predictedInventory, expected, predicted, questionMatch, optionMatch) {
  const expectedQuestionById = new Map(expectedInventory.questionRegions.map((question, index) => [question.localId, index]));
  const predictedQuestionById = new Map(predictedInventory.questionRegions.map((question, index) => [question.localId, index]));
  const expectedEdges = new Set();
  expected.options.forEach((option, optionIndex) => {
    const expectedQuestionIndex = expectedQuestionById.get(option.parentQuestionRegionId);
    if (expectedQuestionIndex !== undefined) expectedEdges.add(`${expectedQuestionIndex}:${optionIndex}`);
  });

  const creditedEdges = new Set();
  let predictedEdges = 0;
  let truePositive = 0;
  predicted.options.forEach((option, predictedOptionIndex) => {
    if (option.parentQuestionRegionId === null) return;
    predictedEdges += 1;
    const predictedQuestionIndex = predictedQuestionById.get(option.parentQuestionRegionId);
    const expectedQuestionIndex =
      predictedQuestionIndex === undefined ? undefined : questionMatch.predictedToExpected.get(predictedQuestionIndex);
    const expectedOptionIndex = optionMatch.predictedToExpected.get(predictedOptionIndex);
    const edge = `${expectedQuestionIndex}:${expectedOptionIndex}`;
    if (
      expectedQuestionIndex !== undefined &&
      expectedOptionIndex !== undefined &&
      expectedEdges.has(edge) &&
      !creditedEdges.has(edge)
    ) {
      creditedEdges.add(edge);
      truePositive += 1;
    }
  });
  const precision = ratio(truePositive, predictedEdges, expectedEdges.size === 0 ? 1 : 0);
  const recall = ratio(truePositive, expectedEdges.size);
  return {
    expectedEdges: expectedEdges.size,
    predictedEdges,
    truePositive,
    falsePositive: predictedEdges - truePositive,
    falseNegative: expectedEdges.size - truePositive,
    precision,
    recall,
    f1: harmonicMean(precision, recall),
  };
}

function computeAppearance(expectedInventory, predictedInventory, expected, predicted, optionMatch, controlMatch, groupMatch) {
  let optionMarkCorrect = 0;
  for (const pair of optionMatch.pairs) {
    if (expected.options[pair.expectedIndex].markAppearance === predicted.options[pair.predictedIndex].markAppearance) {
      optionMarkCorrect += 1;
    }
  }
  let groupSelectionCorrect = 0;
  for (const pair of groupMatch.pairs) {
    if (
      expectedInventory.optionGroups[pair.expectedIndex].selectionAppearance ===
      predictedInventory.optionGroups[pair.predictedIndex].selectionAppearance
    ) {
      groupSelectionCorrect += 1;
    }
  }
  let controlKindCorrect = 0;
  let availabilityCorrect = 0;
  let controlSelectionCorrect = 0;
  for (const pair of controlMatch.pairs) {
    const expectedControl = expected.controls[pair.expectedIndex];
    const predictedControl = predicted.controls[pair.predictedIndex];
    if (expectedControl.kind === predictedControl.kind) controlKindCorrect += 1;
    if (expectedControl.availabilityAppearance === predictedControl.availabilityAppearance) availabilityCorrect += 1;
    if (expectedControl.selectionAppearance === predictedControl.selectionAppearance) controlSelectionCorrect += 1;
  }

  const optionCount = expected.options.length;
  const groupCount = expectedInventory.optionGroups.length;
  const controlCount = expected.controls.length;
  const stateAttributes = optionCount + groupCount + controlCount * 2;
  const stateCorrect = optionMarkCorrect + groupSelectionCorrect + availabilityCorrect + controlSelectionCorrect;
  return {
    semanticsAttested: false,
    dimensions: "pixel-appearance-only",
    expectedOptionMarks: optionCount,
    optionMarkCorrect,
    optionMarkAccuracy: ratio(optionMarkCorrect, optionCount),
    expectedGroupSelectionAppearances: groupCount,
    groupSelectionCorrect,
    groupSelectionAccuracy: ratio(groupSelectionCorrect, groupCount),
    expectedControls: controlCount,
    matchedControls: controlMatch.pairs.length,
    controlKindCorrect,
    controlKindAccuracy: ratio(controlKindCorrect, controlCount),
    availabilityAppearanceCorrect: availabilityCorrect,
    availabilityAppearanceAccuracy: ratio(availabilityCorrect, controlCount),
    controlSelectionAppearanceCorrect: controlSelectionCorrect,
    controlSelectionAppearanceAccuracy: ratio(controlSelectionCorrect, controlCount),
    appearanceStateAttributes: stateAttributes,
    appearanceStateCorrect: stateCorrect,
    appearanceStateAccuracy: ratio(stateCorrect, stateAttributes),
  };
}

function computeVisibleButtonLinks(expected, predicted) {
  const isVisibleButtonLink = (control) =>
    (control.kind === "button" || control.kind === "link") && typeof control.reading?.quote === "string";
  const expectedNodes = expected.controls.filter(isVisibleButtonLink);
  const predictedNodes = predicted.controls.filter(isVisibleButtonLink);
  const match = matchByQuote(expectedNodes, predictedNodes);
  const truePositive = match.pairs.length;
  const precision = ratio(truePositive, predictedNodes.length, expectedNodes.length === 0 ? 1 : 0);
  const recall = ratio(truePositive, expectedNodes.length);
  return {
    scope: "visible-button-or-link-labels-only",
    semanticActionabilityAttested: false,
    expected: expectedNodes.length,
    predicted: predictedNodes.length,
    truePositive,
    falsePositive: predictedNodes.length - truePositive,
    falseNegative: expectedNodes.length - truePositive,
    precision,
    recall,
    f1: harmonicMean(precision, recall),
  };
}

function computeBbox(
  expectedInventory,
  predictedInventory,
  expected,
  predicted,
  textMatch,
  controlMatch,
  groupMatch,
  limitationMatch,
  threshold,
) {
  const values = [];
  for (let expectedIndex = 0; expectedIndex < expected.quotedNodes.length; expectedIndex += 1) {
    const predictedIndex = textMatch.expectedToPredicted.get(expectedIndex);
    values.push(
      predictedIndex === undefined
        ? 0
        : bboxIou(expected.quotedNodes[expectedIndex].bounds, predicted.quotedNodes[predictedIndex].bounds),
    );
  }
  for (let expectedIndex = 0; expectedIndex < expectedInventory.optionGroups.length; expectedIndex += 1) {
    const predictedIndex = groupMatch.expectedToPredicted.get(expectedIndex);
    values.push(
      predictedIndex === undefined
        ? 0
        : bboxIou(expectedInventory.optionGroups[expectedIndex].bounds, predictedInventory.optionGroups[predictedIndex].bounds),
    );
  }
  // Quoted control text already participates above. Textless/icon-only controls
  // contribute their control-region box through the spatial control match.
  for (let expectedIndex = 0; expectedIndex < expected.controls.length; expectedIndex += 1) {
    if (typeof expected.controls[expectedIndex].reading?.quote === "string") continue;
    const predictedIndex = controlMatch.expectedToPredicted.get(expectedIndex);
    values.push(
      predictedIndex === undefined
        ? 0
        : bboxIou(expected.controls[expectedIndex].bounds, predicted.controls[predictedIndex].bounds),
    );
  }
  const expectedLimitations = expectedInventory.visualLimitations.filter((limitation) => limitation.bounds !== null);
  const predictedLimitations = predictedInventory.visualLimitations.filter((limitation) => limitation.bounds !== null);
  for (let expectedIndex = 0; expectedIndex < expectedLimitations.length; expectedIndex += 1) {
    const predictedIndex = limitationMatch.expectedToPredicted.get(expectedIndex);
    values.push(
      predictedIndex === undefined
        ? 0
        : bboxIou(expectedLimitations[expectedIndex].bounds, predictedLimitations[predictedIndex].bounds),
    );
  }
  const totalIou = values.reduce((sum, value) => sum + value, 0);
  const atThreshold = values.filter((value) => value + EPSILON >= threshold).length;
  return {
    expectedRegions: values.length,
    meanIou: ratio(totalIou, values.length),
    iouThreshold: threshold,
    atThreshold,
    thresholdRate: ratio(atThreshold, values.length),
    minIou: values.length > 0 ? Math.min(...values) : 1,
  };
}

function computeLimitations(expectedInventory, predictedInventory, expected, predicted, textMatch, limitationMatch) {
  const expectedLimitations = expectedInventory.visualLimitations.filter((limitation) => limitation.bounds !== null);
  const predictedLimitations = predictedInventory.visualLimitations.filter((limitation) => limitation.bounds !== null);
  let kindCorrect = 0;
  for (const pair of limitationMatch.pairs) {
    if (expectedLimitations[pair.expectedIndex].kind === predictedLimitations[pair.predictedIndex].kind) kindCorrect += 1;
  }
  const limitationPrecision = ratio(
    limitationMatch.pairs.length,
    predictedLimitations.length,
    expectedLimitations.length === 0 ? 1 : 0,
  );
  const limitationRecall = ratio(limitationMatch.pairs.length, expectedLimitations.length);
  const expectedReportedCount = expectedInventory.visualLimitations.reduce((sum, limitation) => sum + limitation.count, 0);
  const predictedReportedCount = predictedInventory.visualLimitations.reduce((sum, limitation) => sum + limitation.count, 0);
  const expectedUnlocalizedEntries = expectedInventory.visualLimitations.filter((limitation) => limitation.bounds === null).length;
  const predictedUnlocalizedEntries = predictedInventory.visualLimitations.filter((limitation) => limitation.bounds === null).length;

  const declarations = [
    ...predictedLimitations.map((limitation) => limitation.bounds),
    ...predicted.allTextNodes
      .filter((node) => node.reading?.readability === "unreadable")
      .map((node) => node.reading.bounds),
  ];
  const missingExpected = textMatch.unmatchedExpected.map((index) => expected.quotedNodes[index]);
  const declaredMissing = missingExpected.filter((node) =>
    declarations.some((bounds) => targetCoverage(node.bounds, bounds) >= 0.5),
  ).length;
  return {
    expectedLocalizedLimitations: expectedLimitations.length,
    predictedLocalizedLimitations: predictedLimitations.length,
    localizedTruePositive: limitationMatch.pairs.length,
    limitationRegionPrecision: limitationPrecision,
    limitationRegionRecall: limitationRecall,
    limitationRegionF1: harmonicMean(limitationPrecision, limitationRecall),
    limitationKindAccuracy: ratio(kindCorrect, expectedLimitations.length),
    expectedModelReportedLimitationCount: expectedReportedCount,
    modelReportedLimitationCount: predictedReportedCount,
    limitationCountPrecision: ratio(
      Math.min(expectedReportedCount, predictedReportedCount),
      predictedReportedCount,
      1,
    ),
    limitationCountRecall: ratio(Math.min(expectedReportedCount, predictedReportedCount), expectedReportedCount, 1),
    excessModelReportedLimitationCount: Math.max(0, predictedReportedCount - expectedReportedCount),
    expectedUnlocalizedLimitationEntries: expectedUnlocalizedEntries,
    unlocalizedLimitationEntries: predictedUnlocalizedEntries,
    unexpectedUnlocalizedLimitationEntries: Math.max(0, predictedUnlocalizedEntries - expectedUnlocalizedEntries),
    unreadableTextAbstentions: predicted.allTextNodes.filter((node) => node.reading?.readability === "unreadable").length,
    missingVisibleItems: missingExpected.length,
    declaredMissingItems: declaredMissing,
    declaredOmissionRecall: ratio(declaredMissing, missingExpected.length),
    silentOmissionCount: missingExpected.length - declaredMissing,
  };
}

function compareMinimum(value, minimum) {
  return value + EPSILON >= minimum;
}

function applyPolicy(metrics, measurement, policy) {
  const failures = [];
  const minimumChecks = [
    ["visible_text_exact_recall", metrics.visibleText.exact.recall, policy.minExactTextRecall],
    ["visible_text_normalized_recall", metrics.visibleText.normalized.recall, policy.minNormalizedTextRecall],
    ["visible_text_normalized_precision", metrics.visibleText.normalized.precision, policy.minNormalizedTextPrecision],
    ["region_category_text_f1", metrics.visibleText.minimumCategoryF1, policy.minCategoryTextF1],
    ["message_kind_accuracy", metrics.messageKinds.accuracy, policy.minMessageKindAccuracy],
    ["message_kind_f1", metrics.messageKinds.minimumKindF1, policy.minMessageKindF1],
    ["question_option_grouping_f1", metrics.grouping.f1, policy.minGroupingF1],
    ["visual_control_kind_accuracy", metrics.appearance.controlKindAccuracy, policy.minControlKindAccuracy],
    ["visual_appearance_state_accuracy", metrics.appearance.appearanceStateAccuracy, policy.minAppearanceStateAccuracy],
    ["visible_button_link_f1", metrics.navigationVisibility.f1, policy.minVisibleButtonLinkF1],
    ["bbox_mean_iou", metrics.bbox.meanIou, policy.minMeanBboxIou],
    ["bbox_threshold_rate", metrics.bbox.thresholdRate, policy.minBboxThresholdRate],
    ["visual_limitation_region_precision", metrics.limitations.limitationRegionPrecision, policy.minLimitationRegionPrecision],
    ["visual_limitation_region_recall", metrics.limitations.limitationRegionRecall, policy.minLimitationRegionRecall],
    ["visual_limitation_kind_accuracy", metrics.limitations.limitationKindAccuracy, policy.minLimitationKindAccuracy],
    ["visual_limitation_count_precision", metrics.limitations.limitationCountPrecision, policy.minLimitationCountPrecision],
    ["visual_limitation_count_recall", metrics.limitations.limitationCountRecall, policy.minLimitationCountRecall],
  ];
  for (const [name, value, minimum] of minimumChecks) {
    if (!compareMinimum(value, minimum)) failures.push({ gate: name, actual: value, required: minimum });
  }
  if (policy.requireNoSilentOmissions && metrics.limitations.silentOmissionCount !== 0) {
    failures.push({ gate: "no_silent_omissions", actual: metrics.limitations.silentOmissionCount, required: 0 });
  }
  if (
    metrics.limitations.unexpectedUnlocalizedLimitationEntries >
    policy.maxUnexpectedUnlocalizedLimitationEntries
  ) {
    failures.push({
      gate: "unexpected_unlocalized_limitation_entries",
      actual: metrics.limitations.unexpectedUnlocalizedLimitationEntries,
      requiredMaximum: policy.maxUnexpectedUnlocalizedLimitationEntries,
    });
  }
  if (metrics.structure.emptyOptionGroups > policy.maxEmptyOptionGroups) {
    failures.push({
      gate: "empty_option_groups",
      actual: metrics.structure.emptyOptionGroups,
      requiredMaximum: policy.maxEmptyOptionGroups,
    });
  }
  if (measurement?.attempted && policy.maxLatencyMs !== null && measurement.latencyMs > policy.maxLatencyMs) {
    failures.push({ gate: "latency_ms", actual: measurement.latencyMs, requiredMaximum: policy.maxLatencyMs });
  }
  if (measurement?.attempted && policy.maxCostUsd !== null && measurement.costUsd > policy.maxCostUsd) {
    failures.push({ gate: "cost_usd", actual: measurement.costUsd, requiredMaximum: policy.maxCostUsd });
  }
  return failures;
}

function normalizedAdmission(admission) {
  return admission ?? {
    eligible: false,
    evidenceClass: null,
    trustBoundary: "none",
    failures: ["evaluator-provenance-missing"],
  };
}

function invalidReport(fixture, validation, admission, extraEnvelopeErrors = []) {
  const envelopeErrors = [...validation.envelopeErrors, ...extraEnvelopeErrors];
  const qualityFailedGates = [];
  if (envelopeErrors.length > 0) {
    qualityFailedGates.push({ gate: "prediction_envelope", actual: 0, required: 1 });
  }
  if (!validation.modelValid) {
    qualityFailedGates.push({ gate: "schema_success", actual: 0, required: 1 });
  }
  const finalAdmission = normalizedAdmission(admission);
  const failedGates = [...qualityFailedGates];
  if (!finalAdmission.eligible) {
    failedGates.push({ gate: "admission_provenance", actual: 0, required: 1 });
  }
  return {
    fixtureId: fixture.fixtureId,
    strata: fixture.strata,
    envelope: { valid: envelopeErrors.length === 0, errors: envelopeErrors },
    schema: {
      success: validation.modelValid ? 1 : 0,
      valid: validation.modelValid,
      errors: validation.modelErrors,
      source: "src/vision/schema.ts",
    },
    measurement: validation.measurement,
    metrics: null,
    qualityPassed: false,
    admission: finalAdmission,
    passed: false,
    qualityFailedGates,
    failedGates,
  };
}

export function scoreFixture(fixture, record, policyOverrides = {}, admission = null) {
  const fixtureValidation = validateFixture(fixture);
  if (!fixtureValidation.valid) {
    throw new Error(`Refusing to score invalid fixture ${fixture?.fixtureId ?? "<unknown>"}: ${fixtureValidation.errors.join("; ")}`);
  }
  const validation = validatePredictionRecord(record, fixture);
  const extraEnvelopeErrors = [];
  if (validation.envelopeValid && record.fixtureId !== fixture.fixtureId) {
    extraEnvelopeErrors.push(`$record/fixtureId:expected-${fixture.fixtureId}`);
  }
  if (!validation.valid || extraEnvelopeErrors.length > 0) {
    return invalidReport(fixture, validation, admission, extraEnvelopeErrors);
  }

  const policy = { ...DEFAULT_POLICY, ...policyOverrides };
  const expectedInventory = fixture.expectedInventory;
  const predictedInventory = validation.modelContent;
  const expected = flattenInventory(expectedInventory);
  const predicted = flattenInventory(predictedInventory);
  const expectedText = expected.quotedNodes.map((node) => node.reading.quote);
  const predictedText = predicted.quotedNodes.map((node) => node.reading.quote);
  const textMatch = matchByQuote(expected.quotedNodes, predicted.quotedNodes);
  const questionMatch = matchByQuote(expected.questions, predicted.questions);
  const optionMatch = matchByQuote(expected.options, predicted.options);
  const controlMatch = matchControls(expected.controls, predicted.controls);
  const groupMatch = matchGroups(expectedInventory.optionGroups, predictedInventory.optionGroups);
  const expectedLimitations = expectedInventory.visualLimitations.filter((limitation) => limitation.bounds !== null);
  const predictedLimitations = predictedInventory.visualLimitations.filter((limitation) => limitation.bounds !== null);
  const limitationMatch = spatialMatch(expectedLimitations, predictedLimitations);

  const categorizedText = categoryTextMetrics(expected, predicted);
  const metrics = {
    visibleText: {
      source: "primary quote only; alternatives and confidence do not create a match",
      exact: multisetStats(expectedText, predictedText, exactTextKey),
      normalized: multisetStats(expectedText, predictedText, normalizeVisibleText),
      byCategory: categorizedText.byCategory,
      minimumCategoryF1: categorizedText.minimumCategoryF1,
    },
    messageKinds: computeMessageKinds(expected.messages, predicted.messages),
    grouping: computeGrouping(
      expectedInventory,
      predictedInventory,
      expected,
      predicted,
      questionMatch,
      optionMatch,
    ),
    appearance: computeAppearance(
      expectedInventory,
      predictedInventory,
      expected,
      predicted,
      optionMatch,
      controlMatch,
      groupMatch,
    ),
    navigationVisibility: computeVisibleButtonLinks(expected, predicted),
    bbox: computeBbox(
      expectedInventory,
      predictedInventory,
      expected,
      predicted,
      textMatch,
      controlMatch,
      groupMatch,
      limitationMatch,
      policy.bboxIouThreshold,
    ),
    limitations: computeLimitations(
      expectedInventory,
      predictedInventory,
      expected,
      predicted,
      textMatch,
      limitationMatch,
    ),
    structure: {
      emptyOptionGroups: predictedInventory.optionGroups.filter((group) => group.options.length === 0).length,
    },
  };
  const qualityFailedGates = applyPolicy(metrics, validation.measurement, policy);
  const qualityPassed = qualityFailedGates.length === 0;
  const finalAdmission = normalizedAdmission(admission);
  const failedGates = [...qualityFailedGates];
  if (!finalAdmission.eligible) {
    failedGates.push({ gate: "admission_provenance", actual: 0, required: 1 });
  }
  return {
    fixtureId: fixture.fixtureId,
    strata: fixture.strata,
    envelope: { valid: true, errors: [] },
    schema: { success: 1, valid: true, errors: [], source: "src/vision/schema.ts" },
    measurement: { ...validation.measurement },
    metrics,
    qualityPassed,
    admission: finalAdmission,
    passed: qualityPassed && finalAdmission.eligible,
    qualityFailedGates,
    failedGates,
  };
}

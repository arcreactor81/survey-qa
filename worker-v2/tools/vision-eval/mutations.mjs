function clone(record) {
  return structuredClone(record);
}

export function omitFirstOption(record) {
  const mutated = clone(record);
  const group = mutated.modelContent.optionGroups.find((item) => item.options.length > 0);
  if (!group) throw new Error("omitFirstOption requires at least one option group");
  group.options.splice(0, 1);
  return mutated;
}

export function moveFirstOptionGroupToWrongQuestion(record) {
  const mutated = clone(record);
  if (mutated.modelContent.questionRegions.length < 2 || mutated.modelContent.optionGroups.length === 0) {
    throw new Error("moveFirstOptionGroupToWrongQuestion requires at least two questions and one option group");
  }
  const group = mutated.modelContent.optionGroups[0];
  const alternate = mutated.modelContent.questionRegions.find(
    (question) => question.localId !== group.questionRegionId,
  );
  if (!alternate) throw new Error("moveFirstOptionGroupToWrongQuestion could not find an alternate question");
  group.questionRegionId = alternate.localId;
  return mutated;
}

export function flipFirstAppearanceStates(record) {
  const mutated = clone(record);
  const group = mutated.modelContent.optionGroups.find((item) => item.options.length > 0);
  if (!group) throw new Error("flipFirstAppearanceStates requires at least one option");
  const option = group.options[0];
  option.markAppearance =
    option.markAppearance === "appears-selected" ? "appears-unselected" : "appears-selected";

  const control = mutated.modelContent.controls[0];
  if (!control) throw new Error("flipFirstAppearanceStates requires at least one control");
  control.availabilityAppearance =
    control.availabilityAppearance === "appears-disabled" ? "appears-enabled" : "appears-disabled";
  return mutated;
}

function mirrorBounds(bounds) {
  bounds.x = 1 - bounds.width - bounds.x;
  bounds.y = 1 - bounds.height - bounds.y;
  // Avoid negative zero changing serialized diagnostics while remaining exact.
  if (Object.is(bounds.x, -0)) bounds.x = 0;
  if (Object.is(bounds.y, -0)) bounds.y = 0;
}

function visitReading(reading) {
  if (reading) mirrorBounds(reading.bounds);
}

export function shiftAllBoxes(record) {
  const mutated = clone(record);
  for (const question of mutated.modelContent.questionRegions) visitReading(question.text);
  for (const group of mutated.modelContent.optionGroups) {
    mirrorBounds(group.bounds);
    for (const option of group.options) visitReading(option.text);
  }
  for (const control of mutated.modelContent.controls) {
    mirrorBounds(control.bounds);
    visitReading(control.text);
  }
  for (const message of mutated.modelContent.messages) visitReading(message.text);
  for (const limitation of mutated.modelContent.visualLimitations) {
    if (limitation.bounds) mirrorBounds(limitation.bounds);
  }
  return mutated;
}

export function makeMalformedSchema(record) {
  const mutated = clone(record);
  delete mutated.modelContent.visualLimitations;
  mutated.modelContent.coverageStatus = "complete";
  return mutated;
}

export function makeSilentlyEmpty(record) {
  const mutated = clone(record);
  mutated.modelContent = {
    schemaVersion: "survey-qa-visual-inventory-response/1.0.0",
    questionRegions: [],
    optionGroups: [],
    controls: [],
    messages: [],
    visualLimitations: [],
  };
  return mutated;
}

/** Well-formed alternative contract that production must reject. */
export function makeAlternateSchema(record) {
  const mutated = clone(record);
  mutated.modelContent = {
    schemaVersion: "alternate-visual-inventory/1.0.0",
    regions: [],
    controls: [],
    limitations: [],
  };
  return mutated;
}

export function changeFirstQuotePunctuation(record) {
  const mutated = clone(record);
  const reading = mutated.modelContent.messages.find((item) => typeof item.text.quote === "string")?.text;
  if (!reading) throw new Error("changeFirstQuotePunctuation requires a readable message");
  reading.quote = `${reading.quote}!`;
  return mutated;
}

export function addHallucinatedMessage(record) {
  const mutated = clone(record);
  mutated.modelContent.messages.push({
    localId: "mutation-hallucinated-message",
    kind: "other",
    text: {
      quote: "This text is not in the screenshot",
      alternatives: [],
      readability: "read",
      modelConfidence: 1,
      bounds: { x: 0.4, y: 0.7, width: 0.3, height: 0.04 },
    },
  });
  return mutated;
}

export function moveFirstMessageToQuestion(record) {
  const mutated = clone(record);
  const message = mutated.modelContent.messages.shift();
  if (!message) throw new Error("moveFirstMessageToQuestion requires a message");
  mutated.modelContent.questionRegions.push({
    localId: "mutation-message-as-question",
    text: message.text,
  });
  return mutated;
}

export function flipFirstMessageKind(record) {
  const mutated = clone(record);
  const message = mutated.modelContent.messages[0];
  if (!message) throw new Error("flipFirstMessageKind requires a message");
  message.kind = message.kind === "validation" ? "instruction" : "validation";
  return mutated;
}

export function flipFirstControlKind(record) {
  const mutated = clone(record);
  const control = mutated.modelContent.controls[0];
  if (!control) throw new Error("flipFirstControlKind requires a control");
  control.kind = control.kind === "button" ? "other" : "button";
  return mutated;
}

export function flipFirstTextlessControlKind(record) {
  const mutated = clone(record);
  const control = mutated.modelContent.controls.find((item) => item.text === null);
  if (!control) throw new Error("flipFirstTextlessControlKind requires a textless control");
  control.kind = control.kind === "button" ? "other" : "button";
  return mutated;
}

export function omitVisualLimitations(record) {
  const mutated = clone(record);
  mutated.modelContent.visualLimitations = [];
  return mutated;
}

export function addSpuriousLocalizedLimitation(record) {
  const mutated = clone(record);
  mutated.modelContent.visualLimitations.push({
    kind: "occluded",
    count: 1,
    bounds: { x: 0.02, y: 0.75, width: 0.12, height: 0.08 },
  });
  return mutated;
}

export function flipFirstLimitationKind(record) {
  const mutated = clone(record);
  const limitation = mutated.modelContent.visualLimitations[0];
  if (!limitation) throw new Error("flipFirstLimitationKind requires a limitation");
  limitation.kind = limitation.kind === "blurred" ? "occluded" : "blurred";
  return mutated;
}

export function addHugeUnboundedLimitation(record) {
  const mutated = clone(record);
  mutated.modelContent.visualLimitations.push({
    kind: "unreadable",
    count: 1_000_000,
    bounds: null,
  });
  return mutated;
}

export function addEmptyOptionGroup(record) {
  const mutated = clone(record);
  mutated.modelContent.optionGroups.push({
    localId: "mutation-empty-option-group",
    questionRegionId: null,
    selectionAppearance: "unknown",
    bounds: { x: 0.82, y: 0.72, width: 0.12, height: 0.08 },
    options: [],
  });
  return mutated;
}

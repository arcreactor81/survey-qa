/** Exact, evidence-derived closure for one W5 seed alternative. */
import type { PathObservation, PerformedAction, RenderedScreen, StepObservation } from "../../../browser/types";
import { canonicalHash, sha256Hex } from "../../../store/hash";
import { type PlannedDecision } from "./plan-core.js";
import type { SeedAlternative } from "./seed-plan";

export interface CaseWitnessReceipt {
  kind: "v2-case-witness-receipt/1.0.0";
  receiptHash: string;
  caseId: string;
  alternativeId: string;
  seedCertificateHash: string;
  attemptId: string;
  pathId: string;
  expectedOccurrenceId: string;
  observedOccurrenceId: string;
  expectedHistoryDigest: string;
  observedHistoryDigest: string;
  /** Ordered actual pre-target actions, readbacks, presentations, and capture identities. */
  performedHistoryDigest: string;
  beforePresentationHash: string;
  afterPresentationHash: string;
  beforeEvidenceId: string;
  afterEvidenceId: string;
  /** Content-addressed immutable PathObservation artifact produced by the driver. */
  observationEvidenceId: string;
  actionIndex: number;
  performedAction: PerformedAction;
}

export type CaseWitnessReceiptResult =
  | { ok: true; receipt: CaseWitnessReceipt }
  | { ok: false; reason: string };

/** Revalidate immutable receipt bytes against the certified alternative on every resume. */
export async function storedCaseWitnessReceiptFailures(
  receipt: CaseWitnessReceipt,
  alternative: SeedAlternative,
): Promise<string[]> {
  const failures: string[] = [];
  if (receipt.kind !== "v2-case-witness-receipt/1.0.0") failures.push("receipt kind differs");
  if (receipt.caseId !== alternative.certificate.facetInstanceId || alternative.caseId !== receipt.caseId) failures.push("receipt case differs");
  if (receipt.alternativeId !== alternative.alternativeId || receipt.pathId !== alternative.alternativeId) failures.push("receipt alternative differs");
  if (receipt.seedCertificateHash !== alternative.certificate.certificateHash) failures.push("receipt certificate differs");
  if (receipt.expectedOccurrenceId !== receipt.observedOccurrenceId) failures.push("receipt occurrence differs");
  if (receipt.expectedHistoryDigest !== receipt.observedHistoryDigest) failures.push("receipt history differs");
  const selected = alternative.certificate.selectedOrdinals.map((ordinal) => alternative.certificate.assertedOptions[ordinal]);
  const action = receipt.performedAction;
  if (selected.length !== 1 || !selected[0] || action.targetLabel !== selected[0].label) failures.push("receipt action label differs");
  if (selected[0]?.code !== null && action.targetCode !== selected[0]?.code) failures.push("receipt action code differs");
  const body = { ...receipt } as Record<string, unknown>;
  delete body.receiptHash;
  if (receipt.receiptHash !== `sha256:${await canonicalHash(body)}`) failures.push("receipt content hash differs");
  return failures;
}

export function retainFirstCaseWitnessReceipt(
  existing: readonly CaseWitnessReceipt[],
  candidate: CaseWitnessReceipt,
): { receipts: CaseWitnessReceipt[]; closesCase: boolean } {
  if (existing.some((receipt) => receipt.caseId === candidate.caseId)) {
    return { receipts: [...existing], closesCase: false };
  }
  return { receipts: [...existing, candidate], closesCase: true };
}

const requestedFor = (decision: PlannedDecision): StepObservation["requested"] => ({
  select: decision.select ?? [],
  textEntry: decision.text_entry?.value ?? null,
  action: decision.action ?? null,
});

const sameRequested = (step: StepObservation, decision: PlannedDecision): boolean =>
  JSON.stringify(step.requested) === JSON.stringify(requestedFor(decision));

const exactPriorTransitionPerformed = (step: StepObservation, decision: PlannedDecision): boolean => {
  if (!step.advanced) return false;
  const wantedLabels = decision.select ?? [];
  // There is no retained typed text-state receipt yet, and an empty planned transition cannot
  // authorize whichever navigator-default action happened to advance. Planning withholds both;
  // forged or legacy alternatives fail closed here as well.
  if (decision.text_entry !== undefined || decision.action || wantedLabels.length === 0) return false;
  const choiceActions = wantedLabels.map((label) => step.actions.find((action) =>
    action.ok && action.targetLabel === label && action.targetIdx !== null && action.kind === "click-option" &&
    action.choiceReadback?.checked === true && action.choiceReadback.idx === action.targetIdx,
  ));
  const checkboxActions = choiceActions.filter((action) => action?.choiceReadback?.type === "checkbox");
  if (checkboxActions.length > 0) {
    if (checkboxActions.length !== wantedLabels.length) return false;
    const expected = checkboxActions.map((action) => action!.targetIdx!).sort((a, b) => a - b);
    const final = [...(checkboxActions.at(-1)!.choiceReadback!.checkedGroupIdxs)].sort((a, b) => a - b);
    if (JSON.stringify(final) !== JSON.stringify(expected)) return false;
  }
  for (const label of decision.select ?? []) {
    const retained = step.actions.some((action) => {
      if (!action.ok || action.targetLabel !== label || action.targetIdx === null) return false;
      if (action.kind === "click-option") {
        const readback = action.choiceReadback;
        return !!readback && readback.checked && readback.idx === action.targetIdx &&
          (readback.type === "checkbox" ||
            (readback.checkedGroupIdxs.length === 1 && readback.checkedGroupIdxs[0] === readback.idx));
      }
      return action.kind === "select-option" && !!action.selectReadback &&
        action.selectReadback.label === label && action.selectReadback.code === action.targetCode;
    });
    if (!retained) return false;
  }
  return true;
};

const screenEvidenceId = async (step: StepObservation, slot: "before" | "after-action"): Promise<string | null> => {
  const epochs = step.evidence.screenCaptures ?? [];
  const screen = slot === "before" ? step.screenBefore : step.screenAfterAction;
  if (!screen) return null;
  const signatureHash = await sha256Hex(screen.screenSignature);
  const matched = epochs.filter(
    (row) => row.slot === slot && row.stepIndex === step.stepIndex &&
      row.screenSignatureHash === signatureHash && row.captureFailureCount === 0,
  );
  return matched.length === 1 ? matched[0]!.screenJson.evidenceId : null;
};

type CertifiedOption = { code: string | null; label: string };

interface ChoiceOwner {
  idx: number;
  groupName: string;
  type: "radio" | "checkbox";
  formOwner: number | null;
  unnamedControlIdx: number | null;
  optionOrder: number;
  code: string | null;
  label: string;
  controlId: string | null;
  controlName: string | null;
  checked: boolean | null;
}

interface SelectOwner {
  idx: number;
  optionOrder: number;
  code: string;
  label: string;
  controlId: string | null;
  controlName: string | null;
  selected: boolean;
  retainedCode: string | null;
  retainedValue: string | null;
}

const certifiedOptionMatches = (
  label: string,
  code: string | null,
  selected: CertifiedOption,
): boolean => label === selected.label && (selected.code === null || code === selected.code);

const respondentOperableControl = (control: RenderedScreen["controls"][number]): boolean =>
  control.disabled === false && control.operable === true; // W5_EXPLICIT_OWNER_OPERABILITY

/**
 * Resolve certificate wording to one native radio/checkbox owner in the complete screen
 * inventory. The action's DOM index is evidence only after this independent resolution: using
 * the index to choose among duplicate labels would let a self-consistent forged action define
 * its own owner. Unnamed controls remain resolvable when exactly one inventory row matches.
 */
const uniqueChoiceOwner = (screen: RenderedScreen, selected: CertifiedOption): ChoiceOwner | null => {
  if (!Array.isArray(screen.optionGroups) || !Array.isArray(screen.controls)) return null;
  const candidates = screen.optionGroups.flatMap((group) =>
    group.options.flatMap((option, optionIndex) =>
      certifiedOptionMatches(option.label, option.code, selected)
        ? [{ group, option, optionIndex }]
        : [],
    ),
  );
  if (candidates.length !== 1) return null;
  const { group, option, optionIndex } = candidates[0]!;
  if (option.order !== optionIndex) return null;
  const controls = screen.controls.filter((control) => control.idx === option.idx);
  if (controls.length !== 1) return null;
  const control = controls[0]!;
  const identity = group.identity;
  if (!identity || identity.type !== group.kind) return null;
  const expectedName = identity.name;
  const expectedUnnamedControlIdx = expectedName === null ? option.idx : null;
  if (
    control.tag !== "input" || control.type !== group.kind || control.name !== expectedName ||
    control.formOwner !== identity.formOwner ||
    identity.unnamedControlIdx !== expectedUnnamedControlIdx ||
    control.code !== option.code || control.label !== option.label || control.checked !== option.checked ||
    !respondentOperableControl(control) || option.disabled !== false || option.operable !== true
  ) return null;
  return {
    idx: option.idx,
    groupName: group.name,
    type: group.kind,
    formOwner: identity.formOwner,
    unnamedControlIdx: identity.unnamedControlIdx,
    optionOrder: option.order,
    code: option.code,
    label: option.label,
    controlId: control.id,
    controlName: control.name,
    checked: option.checked,
  };
};

const sameChoiceOwner = (before: ChoiceOwner, after: ChoiceOwner): boolean =>
  before.idx === after.idx && before.groupName === after.groupName && before.type === after.type &&
  before.formOwner === after.formOwner && before.unnamedControlIdx === after.unnamedControlIdx &&
  before.optionOrder === after.optionOrder && before.code === after.code && before.label === after.label &&
  before.controlId === after.controlId && before.controlName === after.controlName;

const readbackMatchesChoiceOwner = (
  owner: ChoiceOwner,
  readback: NonNullable<PerformedAction["choiceReadback"]>,
): boolean =>
  readback.type === owner.type &&
  readback.name === owner.controlName &&
  readback.formOwner === owner.formOwner &&
  readback.unnamedControlIdx === owner.unnamedControlIdx; // W5_COMPLETE_NATIVE_CHOICE_IDENTITY

/** Resolve a certified native-select option without allowing the action index to pick an owner. */
const uniqueSelectOwner = (screen: RenderedScreen, selected: CertifiedOption): SelectOwner | null => {
  if (!Array.isArray(screen.controls)) return null;
  const candidates = screen.controls.flatMap((control) => {
    if (control.tag !== "select" || control.type !== "select" || !Array.isArray(control.options)) return [];
    // Optional legacy fields cannot be read as proof. A native single-select is eligible only
    // when this capture explicitly attests respondent operability/mode and the complete option
    // inventory explicitly classifies hidden/placeholder state for every retained option.
    if (
      control.visible !== true || !respondentOperableControl(control) || control.multiple !== false ||
      control.options.some((option) => typeof option.hidden !== "boolean" || typeof option.placeholder !== "boolean")
    ) return [];
    return control.options.flatMap((option, optionIndex) =>
      certifiedOptionMatches(option.label, option.code, selected) && option.disabled === false &&
        option.hidden === false && option.placeholder === false
        ? [{ control, option, optionIndex }]
        : [],
    );
  });
  if (candidates.length !== 1) return null;
  const { control, option, optionIndex } = candidates[0]!;
  if (option.order !== optionIndex) return null;
  if (screen.controls.filter((candidate) => candidate.idx === control.idx).length !== 1) return null;
  return {
    idx: control.idx,
    optionOrder: option.order,
    code: option.code,
    label: option.label,
    controlId: control.id,
    controlName: control.name,
    selected: option.selected,
    retainedCode: control.code,
    retainedValue: control.value,
  };
};

const sameSelectOwner = (before: SelectOwner, after: SelectOwner): boolean =>
  before.idx === after.idx && before.optionOrder === after.optionOrder && before.code === after.code &&
  before.label === after.label && before.controlId === after.controlId && before.controlName === after.controlName;

/**
 * Join the performed receipt to the unique independently inventoried owner before and after the
 * act. Ambiguous labels/codes, a foreign but self-consistent index, or an owner that changes
 * across the after-action capture all fail closed.
 */
const actionOwnsUniqueRetainedControl = (
  step: StepObservation,
  selected: CertifiedOption,
  action: PerformedAction,
): boolean => {
  const afterScreen = step.screenAfterAction;
  if (!afterScreen) return false;
  if (action.kind === "click-option") {
    const before = uniqueChoiceOwner(step.screenBefore, selected);
    const after = uniqueChoiceOwner(afterScreen, selected);
    const readback = action.choiceReadback;
    if (!before || !after || !sameChoiceOwner(before, after) || !readback) return false;
    return action.targetIdx === before.idx && action.targetLabel === before.label && action.targetCode === before.code &&
      readback.idx === before.idx && readbackMatchesChoiceOwner(before, readback) &&
      after.checked === true;
  }
  if (action.kind === "select-option") {
    const before = uniqueSelectOwner(step.screenBefore, selected);
    const after = uniqueSelectOwner(afterScreen, selected);
    const readback = action.selectReadback;
    if (!before || !after || !sameSelectOwner(before, after) || !readback) return false;
    return action.targetIdx === before.idx && action.targetLabel === before.label && action.targetCode === before.code &&
      action.value === before.code && readback.order === before.optionOrder && readback.code === before.code &&
      readback.label === before.label && after.selected === true && after.retainedCode === before.code &&
      after.retainedValue === before.code;
  }
  return false;
};

const retainedPositiveAction = (
  step: StepObservation,
  selected: { code: string | null; label: string },
): { action: PerformedAction; index: number } | null => {
  for (let index = 0; index < step.actions.length; index += 1) {
    const action = step.actions[index]!;
    if (!action.ok || action.targetLabel !== selected.label) continue;
    if (selected.code !== null && action.targetCode !== selected.code) continue;
    if (!actionOwnsUniqueRetainedControl(step, selected, action)) continue; // W5_UNIQUE_ACTION_OWNER_JOIN
    if (action.kind === "click-option") {
      const readback = action.choiceReadback;
      if (!readback || !readback.checked || action.targetIdx !== readback.idx) continue;
      if (readback.checkedGroupIdxs.length !== 1 || readback.checkedGroupIdxs[0] !== readback.idx) continue;
      return { action, index };
    }
    if (action.kind === "select-option") {
      const readback = action.selectReadback;
      if (!readback || readback.label !== selected.label || readback.code !== action.targetCode) continue;
      if (selected.code !== null && readback.code !== selected.code) continue;
      return { action, index };
    }
  }
  return null;
};

/**
 * Recompute, never attest. The observed history is built from retained ordered steps and must
 * equal the planned occurrence/history identity before the target action can close its case.
 */
export async function deriveCaseWitnessReceipt(
  alternative: SeedAlternative,
  obs: PathObservation,
  observationEvidenceId: string | null = null,
): Promise<CaseWitnessReceiptResult> {
  if (obs.pathId !== alternative.alternativeId) return { ok: false, reason: "path id differs" };
  if (alternative.caseId !== alternative.certificate.facetInstanceId) return { ok: false, reason: "alternative case id differs from certified case" };
  if (obs.loadFailure || (obs.outcome !== "completed" && obs.outcome !== "no-advance-control") || !obs.steps.some((step) => step.advanced)) {
    return { ok: false, reason: "walk is error, hung, capped, or partial" };
  }
  const selected = alternative.certificate.selectedOrdinals.map(
    (ordinal) => alternative.certificate.assertedOptions[ordinal],
  );
  if (selected.length !== 1 || !selected[0]) return { ok: false, reason: "certificate does not select one option" };
  const decisions = alternative.path.decisions;
  const targets = decisions
    .map((decision, index) => ({ decision, index }))
    .filter(({ decision }) => decision.seed_certificate_hash === alternative.certificate.certificateHash);
  if (targets.length !== 1) return { ok: false, reason: `seed decision resolves ${targets.length} times` };
  const target = targets[0]!;
  let historyDigest = `sha256:${await canonicalHash({ kind: "planned-occurrence-history-root/1" })}`;
  let performedHistoryDigest = `sha256:${await canonicalHash({ kind: "performed-history-root/1", attemptId: obs.attemptId })}`;
  const occurrences = new Map<string, number>();
  let stepCursor = 0;
  let targetStep: StepObservation | null = null;
  let observedOccurrenceId = "";

  for (let decisionIndex = 0; decisionIndex <= target.index; decisionIndex += 1) {
    const decision = decisions[decisionIndex]!;
    const matched = obs.steps[stepCursor++] ?? null;
    if (matched && !(
      (matched.decisionSource === "plan" || matched.decisionSource === "probe") &&
      matched.stepIndex === stepCursor - 1 &&
      matched.decisionQuestion === decision.question &&
      sameRequested(matched, decision)
    )) return { ok: false, reason: `retained step ${stepCursor - 1} is not the next planned history transition` };
    if (!matched) return { ok: false, reason: `planned history decision ${decisionIndex} has no exact retained step` };
    const question = String(matched.decisionQuestion ?? "");
    const occurrenceIndex = occurrences.get(question) ?? 0;
    occurrences.set(question, occurrenceIndex + 1);
    const occurrenceId = `occ_${(await canonicalHash({ question, occurrenceIndex, historyDigest })).slice(0, 24)}`;
    if (decisionIndex === target.index) {
      targetStep = matched;
      observedOccurrenceId = occurrenceId;
      break;
    }
    if (!exactPriorTransitionPerformed(matched, decision)) {
      return { ok: false, reason: `retained step ${stepCursor - 1} did not perform the exact prior transition with readback and advance` };
    }
    historyDigest = `sha256:${await canonicalHash({
      prior: historyDigest,
      transition: {
        question, occurrenceIndex, select: decision.select ?? [],
        textEntry: decision.text_entry?.value ?? null, action: decision.action ?? null,
      },
    })}`;
    performedHistoryDigest = `sha256:${await canonicalHash({
      prior: performedHistoryDigest,
      transition: {
        stepIndex: matched.stepIndex,
        decisionQuestion: matched.decisionQuestion,
        decisionSource: matched.decisionSource,
        actions: matched.actions,
        advanced: matched.advanced,
        blocked: matched.blocked,
        beforePresentationHash: await sha256Hex(matched.screenBefore.screenSignature),
        afterActionPresentationHash: matched.screenAfterAction ? await sha256Hex(matched.screenAfterAction.screenSignature) : null,
        afterAdvancePresentationHash: matched.screenAfterAdvance ? await sha256Hex(matched.screenAfterAdvance.screenSignature) : null,
        captureEpochs: (matched.evidence.screenCaptures ?? []).map((epoch) => ({
          epochId: epoch.epochId, stepIndex: epoch.stepIndex, slot: epoch.slot,
          screenSignatureHash: epoch.screenSignatureHash, screenEvidenceId: epoch.screenJson.evidenceId,
        })),
      },
    })}`;
  }

  if (!targetStep) return { ok: false, reason: "target occurrence was not retained" };
  const expectedOccurrenceId = String(target.decision.occurrence_id ?? "");
  const expectedHistoryDigest = String(target.decision.history_digest ?? "");
  if (!expectedOccurrenceId || observedOccurrenceId !== expectedOccurrenceId) {
    return { ok: false, reason: "same-question occurrence identity differs" };
  }
  if (!expectedHistoryDigest || historyDigest !== expectedHistoryDigest) {
    return { ok: false, reason: "path history digest differs" };
  }
  if (!targetStep.screenAfterAction) return { ok: false, reason: "after-action occurrence is absent" };
  const retained = retainedPositiveAction(targetStep, selected[0]);
  if (!retained) return { ok: false, reason: "no exact successful action retained the certified label" };
  const beforeEvidenceId = await screenEvidenceId(targetStep, "before");
  const afterEvidenceId = await screenEvidenceId(targetStep, "after-action");
  if (!beforeEvidenceId || !afterEvidenceId) return { ok: false, reason: "before/after occurrence evidence is incomplete" };
  if (!obs.evidenceIds.includes(beforeEvidenceId) || !obs.evidenceIds.includes(afterEvidenceId)) {
    return { ok: false, reason: "before/after occurrence evidence is not bound to the walk" };
  }
  if (!observationEvidenceId) {
    return { ok: false, reason: "immutable walk observation evidence is absent" };
  }
  const body = {
    kind: "v2-case-witness-receipt/1.0.0" as const,
    caseId: alternative.certificate.facetInstanceId,
    alternativeId: alternative.alternativeId,
    seedCertificateHash: alternative.certificate.certificateHash,
    attemptId: obs.attemptId,
    pathId: obs.pathId,
    expectedOccurrenceId,
    observedOccurrenceId,
    expectedHistoryDigest,
    observedHistoryDigest: historyDigest,
    performedHistoryDigest,
    beforePresentationHash: `sha256:${await sha256Hex(targetStep.screenBefore.screenSignature)}`,
    afterPresentationHash: `sha256:${await sha256Hex(targetStep.screenAfterAction.screenSignature)}`,
    beforeEvidenceId,
    afterEvidenceId,
    observationEvidenceId,
    actionIndex: retained.index,
    performedAction: retained.action,
  };
  return { ok: true, receipt: { ...body, receiptHash: `sha256:${await canonicalHash(body)}` } };
}

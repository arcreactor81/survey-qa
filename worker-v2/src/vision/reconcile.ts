import type { AccessibilitySnapshotArtifact, AccessibilitySnapshotNode } from "../browser/types";
import type {
  GroundedTextReading,
  NormalizedBounds,
  QuoteGrounding,
  VisualObservationArtifact,
  VisualOptionGroup,
  VisualOptionRegion,
  VisualQuestionRegion,
} from "./types";

/**
 * PURE, TARGET-NEUTRAL RECONCILIATION FOR POSITIVE OPTION MEMBERSHIP.
 *
 * This module reads one visual inventory, AX semantics, and screen-capture pairing provenance.
 * Screen/DOM projection contributes no semantic labels here. AX is the sole independent
 * semantic reader: it can add support or expose a channel conflict, but it cannot create a
 * visual grouping that the model did not see. The module never accepts a questionnaire
 * requirement or candidate answer.
 *
 * There is intentionally no inventory-closure output. A viewport can witness visible content;
 * it cannot witness content beyond its pixels, and neither a missing AX node nor a missing DOM
 * projection is turned into a statement about what the respondent was not offered.
 */

export interface PairedScreenReading {
  evidenceId: string;
  contentSha256: string;
}

export interface PairedAccessibilityReading {
  evidenceId: string;
  contentSha256: string;
  value: AccessibilitySnapshotArtifact;
}

export interface ReconcileOptionMembershipInput {
  observation: VisualObservationArtifact;
  screen: PairedScreenReading | null;
  accessibility: PairedAccessibilityReading | null;
}

export type OptionMembershipLimitationKind =
  | "visual-read-not-observed"
  | "visual-question-reference-unbound"
  | "visual-question-reference-nonunique"
  | "visual-question-text-unreadable"
  | "visual-question-text-ambiguous"
  | "visual-question-label-nonunique"
  | "visual-group-id-nonunique"
  | "visual-groups-for-question-nonunique"
  | "visual-option-id-nonunique"
  | "visual-option-text-unreadable"
  | "visual-option-text-ambiguous"
  | "visual-option-label-nonunique"
  | "visual-group-ambiguity-reported"
  | "accessibility-capture-unavailable"
  | "accessibility-reading-not-supplied"
  | "accessibility-pair-mismatch"
  | "accessibility-reading-truncated"
  | "accessibility-question-group-nonunique"
  | "accessibility-option-label-nonunique"
  | "screen-capture-unavailable"
  | "screen-reading-not-supplied"
  | "screen-pair-mismatch"
  | "channel-disagreement"
  | "model-visual-limitation";

export interface OptionMembershipLimitation {
  kind: OptionMembershipLimitationKind;
  channel: "visual" | "accessibility" | "screen" | "cross-channel";
  count: number;
  detail: string;
}

export type AccessibilityMembershipSupport =
  | {
      state: "group-and-option-exact";
      evidenceId: string;
      contentSha256: string;
      groupPath: string;
      optionPath: string;
    }
  | {
      state: "option-label-exact-without-group";
      evidenceId: string;
      contentSha256: string;
      optionPath: string;
    }
  | {
      state:
        | "not-aligned"
        | "ambiguous"
        | "unavailable"
        | "not-supplied"
        | "pair-mismatch"
        | "truncated";
    };

export type ScreenPairingProvenance =
  | {
      state: "paired";
      evidenceId: string;
      contentSha256: string;
    }
  | { state: "unavailable" | "not-supplied" | "pair-mismatch" };

export interface OptionMembershipFact {
  kind: "option-membership";
  question: {
    text: string;
    visualRegionId: string;
    bounds: NormalizedBounds;
    modelConfidence: number;
    quoteGrounding: QuoteGrounding;
  };
  group: {
    visualRegionId: string;
    bounds: NormalizedBounds;
    selectionAppearance: VisualOptionGroup["selectionAppearance"];
  };
  option: {
    text: string;
    visualRegionId: string;
    bounds: NormalizedBounds;
    modelConfidence: number;
    markAppearance: VisualOptionRegion["markAppearance"];
    quoteGrounding: QuoteGrounding;
  };
  source: {
    screenshotEvidenceId: string;
    screenshotSha256: string;
    pairedEvidenceSha256: string;
    epochId: string;
    stepIndex: number;
    slot: string;
    observationCacheKey: string | null;
    /** Pairing provenance only. Screen/DOM text never supports or conflicts with membership. */
    screen: ScreenPairingProvenance;
  };
  support: {
    visual: "question-group-option-exact";
    accessibility: AccessibilityMembershipSupport;
  };
}

export interface PerceptionChannelConflict {
  kind: "channel-disagreement";
  channel: "accessibility";
  question: { text: string; visualRegionId: string };
  option: { text: string; visualRegionId: string };
  groupVisualRegionId: string;
  visualSource: {
    screenshotEvidenceId: string;
    screenshotSha256: string;
  };
  otherChannel: {
    evidenceId: string;
    contentSha256: string;
    questionPath: string;
    observedOptionPaths: string[];
    observedOptionNames: string[];
  };
}

export interface OptionMembershipReconciliation {
  schemaVersion: "survey-qa-option-membership-perception/1.0.0";
  kind: "survey-qa-option-membership-perception";
  scope: "visible-positive-membership-only";
  source: {
    screenshotEvidenceId: string;
    screenshotSha256: string;
    pairedEvidenceSha256: string;
    epochId: string;
  };
  facts: OptionMembershipFact[];
  conflicts: PerceptionChannelConflict[];
  limitations: OptionMembershipLimitation[];
  counts: {
    visualGroupsSeen: number;
    facts: number;
    conflicts: number;
    limitations: number;
  };
}

interface ReadableVisualText {
  value: string;
  normalized: string;
  bounds: NormalizedBounds;
  modelConfidence: number;
  grounding: QuoteGrounding;
}

interface VisualCandidate {
  question: VisualQuestionRegion;
  questionText: ReadableVisualText;
  group: VisualOptionGroup;
  option: VisualOptionRegion;
  optionText: ReadableVisualText;
}

interface AxEntry {
  node: AccessibilitySnapshotNode;
  path: string;
}

interface ChannelEvaluation<TSupport> {
  support: TSupport;
  conflict: PerceptionChannelConflict | null;
}

class LimitationCollector {
  private readonly items = new Map<string, OptionMembershipLimitation>();

  add(
    kind: OptionMembershipLimitationKind,
    channel: OptionMembershipLimitation["channel"],
    count: number,
    detail: string,
  ): void {
    if (!Number.isInteger(count) || count <= 0) return;
    const bounded = detail.length <= 600 ? detail : `${detail.slice(0, 597)}...`;
    const key = `${kind}\u0000${channel}\u0000${bounded}`;
    const prior = this.items.get(key);
    if (prior) prior.count += count;
    else this.items.set(key, { kind, channel, count, detail: bounded });
  }

  values(): OptionMembershipLimitation[] {
    return [...this.items.values()].sort((a, b) =>
      `${a.channel}\u0000${a.kind}\u0000${a.detail}`.localeCompare(`${b.channel}\u0000${b.kind}\u0000${b.detail}`),
    );
  }
}

/** Exact matching for perception channels: Unicode-normalized, case-folded, whitespace-stable. */
export function normalizePerceptionText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

export function reconcileOptionMembership(input: ReconcileOptionMembershipInput): OptionMembershipReconciliation {
  const limitations = new LimitationCollector();
  const { observation } = input;
  const base = (): OptionMembershipReconciliation => ({
    schemaVersion: "survey-qa-option-membership-perception/1.0.0",
    kind: "survey-qa-option-membership-perception",
    scope: "visible-positive-membership-only",
    source: {
      screenshotEvidenceId: observation.input.screenshotEvidenceId,
      screenshotSha256: observation.input.screenshotSha256,
      pairedEvidenceSha256: observation.input.pairedEvidenceSha256,
      epochId: observation.input.capture.epochId,
    },
    facts: [],
    conflicts: [],
    limitations: limitations.values(),
    counts: {
      visualGroupsSeen: observation.inventory.optionGroups.length,
      facts: 0,
      conflicts: 0,
      limitations: limitations.values().reduce((sum, item) => sum + item.count, 0),
    },
  });

  if (observation.readState !== "observed") {
    limitations.add(
      "visual-read-not-observed",
      "visual",
      1,
      `The visual observation state was ${boundedText(observation.readState)}; no pixel membership was read.`,
    );
    return base();
  }

  for (const reported of observation.inventory.visualLimitations) {
    limitations.add(
      "model-visual-limitation",
      "visual",
      reported.count,
      `The pixel reader reported ${boundedText(reported.kind)} in the visible screenshot.`,
    );
  }

  const preparedAx = prepareAccessibility(input, limitations);
  const preparedScreen = prepareScreen(input, limitations);
  const candidates = visualCandidates(observation, limitations);
  const facts: OptionMembershipFact[] = [];
  const conflicts: PerceptionChannelConflict[] = [];

  for (const candidate of candidates) {
    const ax = evaluateAccessibility(candidate, observation, preparedAx, limitations);
    const candidateConflicts = [ax.conflict].filter(
      (item): item is PerceptionChannelConflict => item !== null,
    );
    if (candidateConflicts.length > 0) {
      conflicts.push(...candidateConflicts);
      limitations.add(
        "channel-disagreement",
        "cross-channel",
        candidateConflicts.length,
        `Captured channels disagree on the visually grouped membership ${quoted(candidate.questionText.value)} -> ${quoted(candidate.optionText.value)}.`,
      );
      continue;
    }

    facts.push({
      kind: "option-membership",
      question: {
        text: candidate.questionText.value,
        visualRegionId: candidate.question.localId,
        bounds: candidate.questionText.bounds,
        modelConfidence: candidate.questionText.modelConfidence,
        quoteGrounding: candidate.questionText.grounding,
      },
      group: {
        visualRegionId: candidate.group.localId,
        bounds: candidate.group.bounds,
        selectionAppearance: candidate.group.selectionAppearance,
      },
      option: {
        text: candidate.optionText.value,
        visualRegionId: candidate.option.localId,
        bounds: candidate.optionText.bounds,
        modelConfidence: candidate.optionText.modelConfidence,
        markAppearance: candidate.option.markAppearance,
        quoteGrounding: candidate.optionText.grounding,
      },
      source: {
        screenshotEvidenceId: observation.input.screenshotEvidenceId,
        screenshotSha256: observation.input.screenshotSha256,
        pairedEvidenceSha256: observation.input.pairedEvidenceSha256,
        epochId: observation.input.capture.epochId,
        stepIndex: observation.input.capture.stepIndex,
        slot: observation.input.capture.slot,
        observationCacheKey: observation.cacheKey,
        screen: preparedScreen,
      },
      support: {
        visual: "question-group-option-exact",
        accessibility: ax.support,
      },
    });
  }

  const limitationValues = limitations.values();
  return {
    ...base(),
    facts,
    conflicts,
    limitations: limitationValues,
    counts: {
      visualGroupsSeen: observation.inventory.optionGroups.length,
      facts: facts.length,
      conflicts: conflicts.length,
      limitations: limitationValues.reduce((sum, item) => sum + item.count, 0),
    },
  };
}

function visualCandidates(
  observation: VisualObservationArtifact,
  limitations: LimitationCollector,
): VisualCandidate[] {
  const questionsById = grouped(observation.inventory.questionRegions, (item) => item.localId);
  const groupsById = grouped(observation.inventory.optionGroups, (item) => item.localId);
  const groupsByQuestion = grouped(
    observation.inventory.optionGroups.filter((group) => group.questionRegionId !== null),
    (group) => group.questionRegionId as string,
  );

  for (const [id, questions] of questionsById) {
    if (questions.length > 1) {
      limitations.add(
        "visual-question-reference-nonunique",
        "visual",
        questions.length,
        `Visual question id ${quoted(id)} occurs ${questions.length} times, so references to it are not unique.`,
      );
    }
  }
  for (const [id, groups] of groupsById) {
    if (groups.length > 1) {
      limitations.add(
        "visual-group-id-nonunique",
        "visual",
        groups.length,
        `Visual option-group id ${quoted(id)} occurs ${groups.length} times.`,
      );
    }
  }
  for (const group of observation.inventory.optionGroups) {
    if (group.questionRegionId === null || !questionsById.has(group.questionRegionId)) {
      limitations.add(
        "visual-question-reference-unbound",
        "visual",
        1,
        `Visual option group ${quoted(group.localId)} does not name a captured question region.`,
      );
    }
  }

  const readableQuestions = new Map<string, ReadableVisualText>();
  for (const [id, questions] of questionsById) {
    if (questions.length !== 1) continue;
    const reading = readableText(questions[0]!.text, "question", id, limitations);
    if (reading) readableQuestions.set(id, reading);
  }
  const questionLabels = grouped([...readableQuestions.entries()], ([, reading]) => reading.normalized);
  const ambiguousQuestionIds = new Set<string>();
  for (const entries of questionLabels.values()) {
    if (entries.length <= 1) continue;
    for (const [id] of entries) ambiguousQuestionIds.add(id);
    limitations.add(
      "visual-question-label-nonunique",
      "visual",
      entries.length,
      `${entries.length} visual question regions have the same readable label ${quoted(entries[0]![1].value)}; their memberships are not distinguishable by text.`,
    );
  }

  const result: VisualCandidate[] = [];
  for (const [questionId, groups] of groupsByQuestion) {
    const questions = questionsById.get(questionId) ?? [];
    const questionText = readableQuestions.get(questionId);
    if (questions.length !== 1 || !questionText || ambiguousQuestionIds.has(questionId)) continue;
    if (groups.length !== 1) {
      limitations.add(
        "visual-groups-for-question-nonunique",
        "visual",
        groups.length,
        `Visual question ${quoted(questionText.value)} is linked to ${groups.length} option groups; this slice cannot choose one.`,
      );
      continue;
    }
    const group = groups[0]!;
    if ((groupsById.get(group.localId)?.length ?? 0) !== 1) continue;
    const groupingWarnings = observation.inventory.visualLimitations.filter(
      (item) =>
        item.kind === "ambiguous-grouping" &&
        (item.bounds === null || boundsOverlap(item.bounds, group.bounds)),
    );
    if (groupingWarnings.length > 0) {
      limitations.add(
        "visual-group-ambiguity-reported",
        "visual",
        groupingWarnings.reduce((sum, item) => sum + item.count, 0),
        `The pixel reader explicitly marked grouping around visual group ${quoted(group.localId)} as ambiguous.`,
      );
      continue;
    }

    const optionIds = grouped(group.options, (option) => option.localId);
    for (const [id, options] of optionIds) {
      if (options.length > 1) {
        limitations.add(
          "visual-option-id-nonunique",
          "visual",
          options.length,
          `Visual option id ${quoted(id)} occurs ${options.length} times in group ${quoted(group.localId)}.`,
        );
      }
    }
    const readableOptions = group.options
      .map((option) => ({ option, text: readableText(option.text, "option", option.localId, limitations) }))
      .filter((item): item is { option: VisualOptionRegion; text: ReadableVisualText } => item.text !== null);
    const optionsByLabel = grouped(readableOptions, (item) => item.text.normalized);
    const ambiguousOptionIds = new Set<string>();
    for (const entries of optionsByLabel.values()) {
      if (entries.length <= 1) continue;
      for (const entry of entries) ambiguousOptionIds.add(entry.option.localId);
      limitations.add(
        "visual-option-label-nonunique",
        "visual",
        entries.length,
        `${entries.length} options in visual group ${quoted(group.localId)} have the same readable label ${quoted(entries[0]!.text.value)}.`,
      );
    }
    for (const item of readableOptions) {
      if ((optionIds.get(item.option.localId)?.length ?? 0) !== 1) continue;
      if (ambiguousOptionIds.has(item.option.localId)) continue;
      result.push({ question: questions[0]!, questionText, group, option: item.option, optionText: item.text });
    }
  }
  return result;
}

function readableText(
  reading: GroundedTextReading,
  kind: "question" | "option",
  localId: string,
  limitations: LimitationCollector,
): ReadableVisualText | null {
  const unreadableKind = kind === "question" ? "visual-question-text-unreadable" : "visual-option-text-unreadable";
  const ambiguousKind = kind === "question" ? "visual-question-text-ambiguous" : "visual-option-text-ambiguous";
  const quote = reading.quote?.value ?? "";
  const normalized = normalizePerceptionText(quote);
  if (reading.readability !== "read" || normalized.length === 0) {
    limitations.add(
      unreadableKind,
      "visual",
      1,
      `Visual ${kind} ${quoted(localId)} did not carry one readable quoted label.`,
    );
    return null;
  }
  const distinctAlternatives = new Set(
    reading.alternatives
      .map((alternative) => normalizePerceptionText(alternative.value))
      .filter((alternative) => alternative.length > 0 && alternative !== normalized),
  );
  if (distinctAlternatives.size > 0) {
    limitations.add(
      ambiguousKind,
      "visual",
      1,
      `Visual ${kind} ${quoted(localId)} has ${distinctAlternatives.size} distinct text alternative(s).`,
    );
    return null;
  }
  return {
    value: quote,
    normalized,
    bounds: reading.bounds,
    modelConfidence: reading.modelConfidence,
    grounding: reading.quote!.grounding,
  };
}

type PreparedAccessibility =
  | { state: "ready"; reading: PairedAccessibilityReading; entries: AxEntry[] }
  | { state: Exclude<AccessibilityMembershipSupport["state"], "group-and-option-exact" | "option-label-exact-without-group" | "not-aligned" | "ambiguous"> };

function prepareAccessibility(
  input: ReconcileOptionMembershipInput,
  limitations: LimitationCollector,
): PreparedAccessibility {
  const bound = input.observation.input.accessibility;
  if (bound.state === "unavailable") {
    limitations.add(
      "accessibility-capture-unavailable",
      "accessibility",
      bound.failure.count,
      `Accessibility capture was unavailable (${boundedText(bound.failure.kind)}): ${boundedText(bound.failure.detail)}.`,
    );
    return { state: "unavailable" };
  }
  if (input.accessibility === null) {
    limitations.add(
      "accessibility-reading-not-supplied",
      "accessibility",
      1,
      "The visual observation names captured AX evidence, but this pure reconciliation call did not receive its bytes.",
    );
    return { state: "not-supplied" };
  }
  const reading = input.accessibility;
  const artifact = reading.value;
  const capture = input.observation.input.capture;
  const screenBound = input.observation.input.screen;
  const paired =
    reading.evidenceId === bound.evidenceId &&
    reading.contentSha256 === bound.contentSha256 &&
    artifact.epochId === capture.epochId &&
    artifact.stepIndex === capture.stepIndex &&
    artifact.slot === capture.slot &&
    artifact.pairing.screenshot?.contentHash === input.observation.input.screenshotSha256 &&
    (screenBound.state !== "captured" || artifact.pairing.screenJson.contentHash === screenBound.contentSha256);
  if (!paired) {
    limitations.add(
      "accessibility-pair-mismatch",
      "accessibility",
      1,
      "The supplied AX artifact does not carry the evidence hashes and capture epoch named by the visual observation.",
    );
    return { state: "pair-mismatch" };
  }
  if (artifact.capture.completeness === "truncated") {
    limitations.add(
      "accessibility-reading-truncated",
      "accessibility",
      Math.max(1, artifact.capture.limitations.reduce((sum, item) => sum + item.count, 0)),
      "The AX artifact is explicitly truncated; it cannot establish that a label or group is unique.",
    );
    return { state: "truncated" };
  }
  return { state: "ready", reading, entries: flattenAx(artifact.tree) };
}

type PreparedScreen = ScreenPairingProvenance;

function prepareScreen(input: ReconcileOptionMembershipInput, limitations: LimitationCollector): PreparedScreen {
  const bound = input.observation.input.screen;
  if (bound.state === "unavailable") {
    limitations.add(
      "screen-capture-unavailable",
      "screen",
      bound.failure.count,
      `Screen projection was unavailable (${boundedText(bound.failure.kind)}): ${boundedText(bound.failure.detail)}.`,
    );
    return { state: "unavailable" };
  }
  if (input.screen === null) {
    limitations.add(
      "screen-reading-not-supplied",
      "screen",
      1,
      "The visual observation names captured screen JSON, but this pure reconciliation call did not receive its bytes.",
    );
    return { state: "not-supplied" };
  }
  if (input.screen.evidenceId !== bound.evidenceId || input.screen.contentSha256 !== bound.contentSha256) {
    limitations.add(
      "screen-pair-mismatch",
      "screen",
      1,
      "The supplied screen projection does not carry the evidence id and hash named by the visual observation.",
    );
    return { state: "pair-mismatch" };
  }
  return {
    state: "paired",
    evidenceId: input.screen.evidenceId,
    contentSha256: input.screen.contentSha256,
  };
}

function evaluateAccessibility(
  candidate: VisualCandidate,
  observation: VisualObservationArtifact,
  prepared: PreparedAccessibility,
  limitations: LimitationCollector,
): ChannelEvaluation<AccessibilityMembershipSupport> {
  if (prepared.state !== "ready") return { support: { state: prepared.state }, conflict: null };
  const { entries, reading } = prepared;
  const namedGroups = entries.filter(
    (entry) => isAxGroupRole(entry.node.role) && normalizePerceptionText(entry.node.name ?? "") === candidate.questionText.normalized,
  );
  if (namedGroups.length > 1) {
    limitations.add(
      "accessibility-question-group-nonunique",
      "accessibility",
      namedGroups.length,
      `${namedGroups.length} AX groups exactly name visual question ${quoted(candidate.questionText.value)}.`,
    );
    return { support: { state: "ambiguous" }, conflict: null };
  }
  if (namedGroups.length === 1) {
    const group = namedGroups[0]!;
    const descendants = entries.filter(
      (entry) => entry.path.startsWith(`${group.path}/children/`) && isAxOptionRole(entry.node.role) && axName(entry.node) !== null,
    );
    const matches = descendants.filter(
      (entry) => normalizePerceptionText(axName(entry.node) ?? "") === candidate.optionText.normalized,
    );
    if (matches.length === 1) {
      return {
        support: {
          state: "group-and-option-exact",
          evidenceId: reading.evidenceId,
          contentSha256: reading.contentSha256,
          groupPath: group.path,
          optionPath: matches[0]!.path,
        },
        conflict: null,
      };
    }
    if (matches.length > 1) {
      limitations.add(
        "accessibility-option-label-nonunique",
        "accessibility",
        matches.length,
        `${matches.length} AX option controls in one named group have label ${quoted(candidate.optionText.value)}.`,
      );
      return { support: { state: "ambiguous" }, conflict: null };
    }
    if (descendants.length > 0) {
      return {
        support: { state: "not-aligned" },
        conflict: channelConflict(
          "accessibility",
          candidate,
          observation,
          reading.evidenceId,
          reading.contentSha256,
          group.path,
          descendants.map((entry) => ({ path: entry.path, name: axName(entry.node) ?? "" })),
        ),
      };
    }
    return { support: { state: "not-aligned" }, conflict: null };
  }

  const globalMatches = entries.filter(
    (entry) => isAxOptionRole(entry.node.role) && normalizePerceptionText(axName(entry.node) ?? "") === candidate.optionText.normalized,
  );
  if (globalMatches.length === 1) {
    return {
      support: {
        state: "option-label-exact-without-group",
        evidenceId: reading.evidenceId,
        contentSha256: reading.contentSha256,
        optionPath: globalMatches[0]!.path,
      },
      conflict: null,
    };
  }
  if (globalMatches.length > 1) {
    limitations.add(
      "accessibility-option-label-nonunique",
      "accessibility",
      globalMatches.length,
      `${globalMatches.length} unbound AX option controls have label ${quoted(candidate.optionText.value)}.`,
    );
    return { support: { state: "ambiguous" }, conflict: null };
  }
  return { support: { state: "not-aligned" }, conflict: null };
}

function channelConflict(
  channel: PerceptionChannelConflict["channel"],
  candidate: VisualCandidate,
  observation: VisualObservationArtifact,
  evidenceId: string,
  contentSha256: string,
  questionPath: string,
  alternatives: Array<{ path: string; name: string }>,
): PerceptionChannelConflict {
  const bounded = alternatives.slice(0, 20);
  return {
    kind: "channel-disagreement",
    channel,
    question: { text: candidate.questionText.value, visualRegionId: candidate.question.localId },
    option: { text: candidate.optionText.value, visualRegionId: candidate.option.localId },
    groupVisualRegionId: candidate.group.localId,
    visualSource: {
      screenshotEvidenceId: observation.input.screenshotEvidenceId,
      screenshotSha256: observation.input.screenshotSha256,
    },
    otherChannel: {
      evidenceId,
      contentSha256,
      questionPath,
      observedOptionPaths: bounded.map((item) => item.path),
      observedOptionNames: bounded.map((item) => item.name),
    },
  };
}

function flattenAx(root: AccessibilitySnapshotNode): AxEntry[] {
  const result: AxEntry[] = [];
  const visit = (node: AccessibilitySnapshotNode, path: string): void => {
    result.push({ node, path });
    node.children.forEach((child, index) => visit(child, `${path}/children/${index}`));
  };
  visit(root, "$.tree");
  return result;
}

function isAxGroupRole(role: string): boolean {
  return new Set(["group", "radiogroup", "listbox"]).has(normalizePerceptionText(role));
}

function isAxOptionRole(role: string): boolean {
  return new Set(["checkbox", "radio", "option", "switch", "menuitemcheckbox", "menuitemradio"]).has(
    normalizePerceptionText(role),
  );
}

function axName(node: AccessibilitySnapshotNode): string | null {
  if (typeof node.name === "string" && normalizePerceptionText(node.name).length > 0) return node.name;
  return null;
}

function grouped<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    const bucket = result.get(value);
    if (bucket) bucket.push(item);
    else result.set(value, [item]);
  }
  return result;
}

function boundsOverlap(a: NormalizedBounds, b: NormalizedBounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function quoted(value: string): string {
  return JSON.stringify(boundedText(value));
}

function boundedText(value: string): string {
  const oneLine = String(value).replace(/\s+/gu, " ").trim();
  return oneLine.length <= 180 ? oneLine : `${oneLine.slice(0, 177)}...`;
}

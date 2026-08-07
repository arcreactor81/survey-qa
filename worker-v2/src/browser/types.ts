/**
 * WHAT THE EXECUTOR RECORDS.
 *
 * THE ONE RULE (merged-contract §1, DEBRIEF fix #1): the executor authors an ATTESTED
 * OBSERVATION and never a verdict. There is no `pass`, no `matches`, no `verdict` field
 * anywhere in this file, and that is deliberate — the first run's browser captured the
 * divergence correctly and a prose step then wrote "MATCHES_DOCUMENT" while citing the
 * artifact that disproved it. The stage with no independent check was the only stage that
 * failed, so it is removed rather than supervised: what the browser saw goes here, and the
 * deterministic aggregator decides what it means.
 *
 * The fields exist to make one class of claim possible and one class impossible:
 *   - possible: "the screen showed exactly these 5 options, in this order, with these
 *     codes; this one was clicked; the page then showed that" — an absence claim backed by
 *     the complete positive inventory.
 *   - impossible: "the option list matched the document" — nothing here can say that.
 */

export interface ControlState {
  idx: number;
  tag: string;
  type: string;
  name: string | null;
  id: string | null;
  /** The submitted value — the OPTION CODE. Never renumbered, never inferred. */
  code: string | null;
  label: string;
  text: string;
  checked: boolean | null;
  value: string | null;
  disabled: boolean;
  required: boolean;
  visible: boolean;
  placeholder: string | null;
  maxlength: string | null;
  readOnly: boolean;
  options?: Array<{ order: number; code: string; label: string; selected: boolean; disabled: boolean }>;
}

export interface OptionGroupState {
  name: string;
  kind: "radio" | "checkbox";
  /** COMPLETE, in DOM order. A subset here would make every absence claim unfalsifiable. */
  options: Array<{
    order: number;
    idx: number;
    code: string | null;
    label: string;
    checked: boolean | null;
    disabled: boolean;
    visible: boolean;
  }>;
}

export interface CollectedError {
  kind: string;
  message: string;
  source?: string | null;
  line?: number | null;
  column?: number | null;
  stack?: string | null;
  at: string;
}

export interface RenderedScreen {
  at: string;
  url: string;
  title: string | null;
  /** Script errors the PAGE raised, collected in-page from load onward. */
  collectedErrors: CollectedError[];
  questionText: string | null;
  instructionText: string | null;
  visibleText: string;
  visibleTextTruncated: boolean;
  /** Programmer instructions that reached the respondent, e.g. "[SPECIFY]". */
  bracketedInstructionsVisible: string[];
  controls: ControlState[];
  optionGroups: OptionGroupState[];
  grid: {
    columns: string[];
    rows: Array<{ label: string; name: string | null; cells: Array<{ column: string | null; code: string; checked: boolean; idx: number }> }>;
  } | null;
  buttons: Array<{ idx: number; label: string; role: "next" | "back" | "other"; disabled: boolean; visible: boolean }>;
  progress: { present: boolean; kind: string | null; now: number | null; max: number | null; text: string | null };
  validationMessages: string[];
  counts: { controls: number; optionGroups: number; options: number; textInputs: number };
  screenSignature: string;
}

/** One thing the driver did to the page, recorded as performed — not as intended. */
export interface PerformedAction {
  kind: "click-option" | "type-text" | "clear-text" | "click-next" | "click-back" | "select-grid-cell" | "open";
  targetIdx: number | null;
  targetLabel: string | null;
  targetCode: string | null;
  value: string | null;
  ok: boolean;
  detail: string | null;
}

export interface StepObservation {
  stepIndex: number;
  /** The plan decision this screen was matched to, or null when the driver defaulted. */
  decisionQuestion: string | null;
  decisionSource: "plan" | "navigator-default" | "probe" | "recovery";
  /** What the plan asked for, verbatim, so intent and outcome can be compared later. */
  requested: { select: string[]; textEntry: string | null; action: string | null } | null;
  /** The screen BEFORE acting: the complete positive inventory. */
  screenBefore: RenderedScreen;
  /** The screen after acting but BEFORE advancing — proves what the click did. */
  screenAfterAction: RenderedScreen | null;
  /** The screen after pressing next: where the survey actually went. */
  screenAfterAdvance: RenderedScreen | null;
  actions: PerformedAction[];
  /** Requested labels the screen did not offer. A capture, not a verdict. */
  requestedButNotOffered: string[];
  advanced: boolean;
  /** Set when Next was pressed and the screen did not change. */
  blocked: boolean;
  pageErrors: string[];
  consoleErrors: string[];
  evidence: { screenBefore: string | null; screenAfterAdvance: string | null; screenshots: string[] };
  wallMs: number;
}

export interface PathObservation {
  kind: "v2-path-observation/1.0.0";
  runId: string;
  pathId: string;
  tier: 1 | 2;
  attemptId: string;
  planRevisionId: string;
  surveyUrl: string;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  /** Obligation ids the PLAN says this walk witnesses. A claim of relevance, not a result. */
  plannedWitnesses: string[];
  steps: StepObservation[];
  /** How the walk ended: "completed" | "no-advance-control" | "blocked" | "step-cap" | "error". */
  outcome: string;
  outcomeDetail: string | null;
  /** True when the one-property compatibility shim was in effect for this walk. */
  shimmed: boolean;
  shimNote: string | null;
  /** Load-time failures, captured BEFORE any shim, because the crash is itself a finding. */
  loadFailure: { message: string; stack: string | null; capturedAt: string } | null;
  evidenceIds: string[];
  viewport: { width: number; height: number };
}

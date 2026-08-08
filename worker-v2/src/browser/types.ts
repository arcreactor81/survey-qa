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
  /**
   * CAN A RESPONDENT ACTUATE THIS CONTROL — deliberately NOT a synonym for `visible`.
   *
   * An eleven-point NPS scale drawn as `opacity:0; width:1px` radios inside their labels is
   * `visible: false` on every 0-10 option, so a driver filtering on `visible` could only ever
   * record the twelfth ("Don't know"). The control is operable: the respondent clicks the
   * label. `operable` is true when the control is drawn itself, or when a <label> that
   * activates it is drawn and not covered. It is false for `input[type=hidden]`, for a
   * control in a `display:none` alternate layout whose label is hidden with it, and for a
   * hidden control with no label at all.
   *
   * OPTIONAL ON PURPOSE: artifacts written before it existed re-read without it, and its
   * absence must read as "this reader did not look", never as "not operable".
   */
  operable?: boolean;
  /** How it would be actuated: itself, through its <label>, or not at all. */
  actuatedVia?: "self" | "label" | "none";
  /** Why, in the reader's words. Null when the control is simply drawn. */
  actuationNote?: string | null;
  /** Index into `LABEL_SELECTOR` document order of the <label> that activates it. */
  labelIndex?: number | null;
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
    /** See `ControlState.operable`. Optional on purpose, for the same reason. */
    operable?: boolean;
    actuatedVia?: "self" | "label" | "none";
    labelIndex?: number | null;
  }>;
}

/**
 * SOMETHING THIS READ COULD NOT DO PROPERLY, NAMED AND COUNTED.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. The grid column parse used to collect a row label as a
 * sixth column, notice that six columns did not fit five inputs, and SILENTLY SHIFT every
 * cell one column right — so the cell submitting "Strongly agree" was reported as "Somewhat
 * agree", the driver matched on that label, and a documented answer clicked the wrong option
 * with nothing anywhere recording a doubt. A silent offset is the failure; the alternative is
 * not a cleverer offset but a REPORTED shortfall, which is what this is.
 *
 * These are facts about the READ, never verdicts about the survey: "the columns could not be
 * matched to the inputs" — not "the survey's grid is broken".
 */
export interface ReaderLimitation {
  /** A stable name, e.g. `grid-column-labels-unresolved`. */
  kind: string;
  detail: string;
  /** How many times it bit on this screen. Counted, never implied. */
  count: number;
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
  /**
   * What this read could not do properly. An EMPTY ARRAY is a claim — "we looked and found
   * none"; the field ABSENT is a reader that predates the check. Absence is never "none".
   */
  readerLimitations?: ReaderLimitation[];
  counts: {
    controls: number;
    optionGroups: number;
    options: number;
    textInputs: number;
    /** Options no respondent could reach at this viewport. Optional on purpose. */
    optionsNotOperable?: number;
    readerLimitations?: number;
  };
  screenSignature: string;
}

/**
 * WHY THE WALKER STOPPED ADVANCING — the walker's own decision procedure, written down.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. `blocked` is set by `!advanced`, and `advanced` is set by
 * LOSING A POLLING RACE against `advanceTimeoutMs`. So `blocked === true` means "the screen
 * signature had not changed by the time we stopped looking" and NOTHING ELSE: a slow-but-
 * healthy page is byte-identical to a survey that refused the input. The verifier read
 * `blocked` as "the survey rejected this input" and turned a timeout into a defect claim about
 * a working survey.
 *
 * A verifier cannot reconstruct the difference after the fact — the distinguishing facts
 * (was the advance control still enabled? did a message appear?) are the walker's to observe
 * at the moment it gave up. So it records WHICH of them held:
 *
 *   - `validation-visible`   a message appeared after this submit that was not there before;
 *   - `control-disabled`     no enabled advance control remained after the submit;
 *   - `advance-timeout`      neither — the screen simply had not changed when the clock ran out;
 *   - `no-advance-control`   the screen offered no enabled advance control to begin with, so
 *                            nothing was ever submitted. NOTE the flags on that path are
 *                            `advanced: false` AND `blocked: false` — a reader keying a
 *                            rejection off `blocked` misses it entirely, which is why this
 *                            field exists and why the verifier keys off `advanced`.
 *
 * THIS IS NOT A VERDICT AND MUST NEVER BECOME ONE (see this file's ONE RULE). It describes the
 * walker's own state, not the survey's correctness: `control-disabled` does not say "the survey
 * rejected the value", it says "no control that advances the survey was enabled when we looked".
 * The verifier uses it to NAME an `insufficient`, never to author a rejection.
 *
 * OPTIONAL ON PURPOSE. Walk artifacts written before this field existed re-read without it, and
 * every consumer must degrade to `insufficient` rather than to a guess when it is absent.
 */
export type BlockedReason = "validation-visible" | "control-disabled" | "advance-timeout" | "no-advance-control";

/**
 * A DECISION THE DRIVER DECLINED TO BIND TO THE SCREEN IN FRONT OF IT.
 *
 * THE DEFECT THIS EXISTS TO MAKE VISIBLE. Binding used to score option-label overlap alone
 * whenever nothing else fired, and `labelMatches` is containment-tolerant: a decision for Q7
 * wanting "Can't remember" bound to a DIFFERENT question that offered "Don't know / can't
 * remember", was consumed there, and the real Q7 screen — which offered exactly "Can't
 * remember" — was then answered by the navigator's default down the OPPOSITE branch. The case
 * was marked exercised. Nothing anywhere recorded that a guess had been made.
 *
 * So a decision the driver cannot identify is REFUSED and COUNTED here rather than bound. The
 * reasons are facts about the driver's own evidence, never verdicts about the survey:
 *
 *   - `option-labels-only`        the only thing linking this decision to this screen was that
 *                                 the screen offers a label like one it wants. Two different
 *                                 questions can offer the same label, so this is not identity.
 *   - `identity-ambiguous`        two or more decisions identified this screen equally well;
 *                                 at most one of them is right and choosing would be a guess.
 *   - `identity-conflict`         the wording says one question and the screen's own controls
 *                                 say another.
 *   - `screen-is-another-question` the screen named itself, and the question it named has no
 *                                 pending decision — so this screen is not this decision's.
 */
export interface BindingRefusal {
  /** The planned decision's question id. */
  question: string;
  reason: "option-labels-only" | "identity-ambiguous" | "identity-conflict" | "screen-is-another-question";
  detail: string;
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
  /**
   * WHICH EVIDENCE BOUND THIS SCREEN TO THAT DECISION, e.g.
   * `wording:0.97+markup:Q7` or `markup:Q9`. Null when nothing bound.
   *
   * OPTIONAL ON PURPOSE: walk artifacts written before it existed re-read without it, and its
   * absence must read as "this walk did not record its evidence", never as "there was none".
   */
  bindingVia?: string | null;
  /**
   * Decisions the driver DECLINED to bind to this screen. Not errors — the alternative to
   * each one is a wrong answer confidently recorded. A refused decision stays pending and is
   * offered to every later screen.
   */
  bindingRefusals?: BindingRefusal[];
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
  /**
   * WHY the walker stopped advancing, observed at the moment it stopped. Null when the step
   * advanced; absent on artifacts written before the field existed. See `BlockedReason` —
   * it is a fact about the walker, never a verdict about the survey.
   */
  blockedReason?: BlockedReason | null;
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
  /**
   * PLANNED DECISIONS THIS WALK NEVER BOUND TO A SCREEN — the walk's own account of what it
   * did NOT do. A walk that ends with entries here answered fewer questions deliberately than
   * it was asked to, and said so; the alternative this replaces was answering the wrong screen
   * and reporting the case exercised.
   *
   * Optional: absent on artifacts written before it existed, and absence must not be read as
   * "everything bound".
   */
  unboundDecisions?: Array<{ question: string; wanted: string[]; reason: string }>;
  /** How many times a screen was refused a binding during this walk. Counted, not implied. */
  bindingRefusalCount?: number;
  /**
   * EVERY LIMITATION THE READER NAMED ON ANY SCREEN OF THIS WALK, lifted to the walk so a
   * reader of the artifact does not have to go looking screen by screen for the reason an
   * answer is not trustworthy. Each entry carries the step it came from.
   *
   * Optional: absent on artifacts written before it existed, and absence must not be read as
   * "the reader had no limitations".
   */
  readerLimitations?: Array<{ stepIndex: number; kind: string; detail: string; count: number }>;
  /** Total occurrences, summed over screens. Counted, not implied. */
  readerLimitationCount?: number;
  evidenceIds: string[];
  viewport: { width: number; height: number };
}

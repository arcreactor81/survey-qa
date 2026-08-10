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
  /**
   * The bounds THE SITE declares on a numeric control, verbatim (`min`/`max` attributes).
   *
   * Recorded because a walk that types a value the control cannot hold gets the site's
   * validation back and records `blocked` — which downstream reads as the survey REJECTING an
   * answer. MEASURED: the walker's default filler "QA-PROBE" typed into the oncology
   * instrument's `<input type=number min=0 max=50>` stopped the walk on screen 1 and reported
   * a working survey as blocked. Optional on purpose: absence means this reader did not look.
   */
  min?: string | null;
  max?: string | null;
  /**
   * The GRANULARITY and the FORM the site declares (`step` / `pattern` attributes), verbatim.
   *
   * Same reason as `min`/`max`, one step further: a filler that lands BETWEEN the site's own
   * step points, or outside its own pattern, is refused by the control's own constraint
   * validation and the walk records `blocked` — the harness's arithmetic reported as the survey
   * rejecting an answer. Optional on purpose: absence means this reader did not look.
   */
  step?: string | null;
  pattern?: string | null;
  /**
   * DOES A NON-EMPTY `value` ON THIS CONTROL WITNESS AN ANSWER?
   *
   * `range` reports its midpoint and `color` reports `#000000` when nobody has touched them, so
   * for those two "has a value" is the UNTOUCHED state. A driver skipping controls that are
   * "already filled" by reading `value` alone would therefore skip every slider on every survey
   * for ever, and record the screen as answered. This field is the one that separates the two;
   * `value` is the raw reading and keeps its exact old meaning.
   *
   * Optional on purpose: absent on readers that predate it, and a consumer must then fall back
   * to the old `value`-length test rather than assume either answer.
   */
  valueIsUserSupplied?: boolean;
  readOnly: boolean;
  /**
   * The control's OWN accessible name, kept separate from `label` because `label` falls back to
   * the text of the nearest ancestor and these do not. A navigation `<input type=button>` has no
   * text and no `<label>`, so these and `code` are the only things that name it at all.
   * Optional: absence means this reader did not look, never that the control has none.
   */
  title?: string | null;
  ariaLabel?: string | null;
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

/**
 * ONE IMMUTABLE ARTIFACT CAPTURED FOR A SCREEN EPOCH.
 *
 * This deliberately repeats the content hash and media type from the evidence catalogue.
 * A downstream visual reader can therefore bind the exact PNG / accessibility JSON it read
 * without trusting a filename convention or fetching the catalogue merely to learn what the
 * reference means. `artifactRef` remains the durable judge-facing name; `evidenceId` remains
 * the storage-facing identity. Neither one is inferred from the other.
 */
export interface ScreenArtifactRef {
  kind: "screen-json" | "screenshot" | "accessibility";
  evidenceId: string;
  artifactRef: string;
  sourceEvidenceId: string;
  contentHash: string;
  mediaType: "application/json" | "image/png";
  size: number;
}

/**
 * VIEWPORT FACTS AT THE MOMENT A SCREEN EPOCH WAS CAPTURED.
 *
 * `source` prevents configured dimensions from masquerading as a browser measurement. If the
 * in-page metadata read fails, width/height retain the requested viewport so the artifact can
 * still be rendered, while DPR/scroll/document dimensions are explicitly null and a named
 * `capture-metadata-failed` entry accompanies them.
 */
export interface ScreenCaptureGeometry {
  width: number;
  height: number;
  deviceScaleFactor: number | null;
  scrollX: number | null;
  scrollY: number | null;
  documentWidth: number | null;
  documentHeight: number | null;
  source: "browser" | "configured-fallback";
}

/**
 * THE PIXEL EXTENT THE BROWSER ADAPTER ACTUALLY REQUESTED.
 *
 * A consumer must never infer this from today's `fullPage: false` implementation. Future
 * adapters may emit tiles, so the scope is carried in the capture artifact and bound into the
 * visual-input digest. `tileIndex` is zero-based when a finite tiling pass is declared.
 */
export type ScreenCaptureScope =
  | { kind: "viewport"; tileIndex: null; tileCount: null }
  | { kind: "tile"; tileIndex: number; tileCount: number };

/**
 * A CAPTURE THE BROWSER LAYER ATTEMPTED AND COULD NOT COMPLETE.
 *
 * Every current failure is one occurrence, but `count` is explicit so aggregation is a sum,
 * never an inference from array length. An absent `captureFailures` field belongs to a legacy
 * artifact whose reader did not perform these checks; an empty array is the current reader's
 * claim that every requested modality was captured.
 */
export interface ScreenCaptureFailure {
  kind:
    | "capture-metadata-failed"
    | "screen-read-failed"
    | "screenshot-capture-failed"
    | "screenshot-capture-empty"
    | "screenshot-evidence-write-failed"
    | "accessibility-api-unavailable"
    | "accessibility-snapshot-failed"
    | "accessibility-snapshot-empty"
    | "accessibility-snapshot-invalid-node"
    | "accessibility-snapshot-node-limit"
    | "accessibility-snapshot-depth-limit"
    | "accessibility-snapshot-value-limit"
    | "accessibility-snapshot-size-limit"
    | "accessibility-evidence-write-failed";
  detail: string;
  count: number;
  at: string;
  stepIndex: number;
  slot: string;
}

/**
 * Closed, JSON-only projection of Puppeteer's `SerializedAXNode`.
 *
 * Puppeteer's live object also exposes `elementHandle()`. That method and every unrecognised
 * property are deliberately impossible here: accessibility evidence must never retain a
 * browser handle or acquire new executable/prototype-bearing fields by accident.
 */
export interface AccessibilitySnapshotNode {
  role: string;
  name?: string;
  value?: string | number;
  description?: string;
  keyshortcuts?: string;
  roledescription?: string;
  valuetext?: string;
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  modal?: boolean;
  multiline?: boolean;
  multiselectable?: boolean;
  readonly?: boolean;
  required?: boolean;
  selected?: boolean;
  checked?: boolean | "mixed";
  pressed?: boolean | "mixed";
  level?: number;
  valuemin?: number;
  valuemax?: number;
  autocomplete?: string;
  haspopup?: string;
  invalid?: string;
  orientation?: string;
  /** Always present on a captured node: `[]` means Chrome reported no children. */
  children: AccessibilitySnapshotNode[];
}

/** The bytes stored as the accessibility evidence artifact. */
export interface AccessibilitySnapshotArtifact {
  kind: "v2-accessibility-snapshot/1.0.0";
  epochId: string;
  stepIndex: number;
  slot: string;
  scope: ScreenCaptureScope;
  capturedAt: string;
  screenReadAt: string;
  /** Hash of the legacy screen signature; rendered question/option text never leaks into metadata. */
  screenSignatureHash: string;
  geometry: ScreenCaptureGeometry;
  pairing: {
    screenJson: ScreenArtifactRef & { kind: "screen-json" };
    screenshot: (ScreenArtifactRef & { kind: "screenshot" }) | null;
  };
  capture: {
    interestingOnly: false;
    completeness: "complete" | "truncated";
    limitations: ScreenCaptureFailure[];
    nodeCount: number;
    maxDepthObserved: number;
    serializedBytes: number;
    limits: { maxNodes: number; maxDepth: number; maxValueChars: number; maxSerializedBytes: number };
  };
  tree: AccessibilitySnapshotNode;
}

export type ScreenshotCapture =
  | { status: "captured"; ref: ScreenArtifactRef & { kind: "screenshot" } }
  | { status: "failed"; failure: ScreenCaptureFailure };

export type AccessibilityCapture =
  | {
      status: "captured";
      ref: ScreenArtifactRef & { kind: "accessibility" };
      /** `truncated` always has one or more named entries in `limitations`. */
      completeness: "complete" | "truncated";
      limitations: ScreenCaptureFailure[];
    }
  | { status: "failed"; failure: ScreenCaptureFailure };

/**
 * THE THREE REPRESENTATIONS OF ONE RENDERED SCREEN, PAIRED WITHOUT A DOM CONVENTION.
 *
 * A capture is necessarily sequential over Puppeteer's protocol: screen JSON, PNG and Chrome's
 * accessibility snapshot cannot be obtained in one atomic CDP command. `startedAt` / `endedAt`
 * state that window honestly, while `epochId`, `slot`, `stepIndex`, `screenSignatureHash` and the
 * exact content hashes bind what was collected together. This is an observation bundle, not a
 * claim that two separately-timed browser commands were simultaneous.
 */
export interface ScreenCaptureEpoch {
  kind: "v2-screen-capture-epoch/1.0.0";
  epochId: string;
  stepIndex: number;
  slot: string;
  scope: ScreenCaptureScope;
  startedAt: string;
  endedAt: string;
  screenReadAt: string;
  /** Hash of the legacy screen signature; the raw text remains only inside the screen JSON. */
  screenSignatureHash: string;
  geometry: ScreenCaptureGeometry;
  screenJson: ScreenArtifactRef & { kind: "screen-json" };
  screenshot: ScreenshotCapture;
  accessibility: AccessibilityCapture;
  /** Present and empty means this reader attempted every modality and none failed. */
  captureFailures: ScreenCaptureFailure[];
  captureFailureCount: number;
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
  /**
   * The controls that might move the survey.
   *
   * `role` is `other` when NOTHING THIS READER CONSULTS NAMED A DIRECTION — never "there is no
   * way forward". The distinction is the whole of the medical-fleet defect: every SurveyJS
   * navigation control classified `other` (an `<input type=button>` has no text and no
   * `<label>`, and those were the only two fields the classifier read), Previous and Next tied,
   * and 142/142 observations stalled while 38 captures of one screen read as progress.
   *
   * `roleVia` names the field that decided and quotes it, `null` when none did; `labelSource`
   * says where `label` came from, since an `<input type=button>` DRAWS its `value` and a record
   * saying label `""` for a button a respondent reads as "Next" cannot be checked against a
   * document. Both optional: absent on artifacts written before they existed, and absence must
   * read as "not recorded", never as "nothing named it".
   */
  buttons: Array<{
    idx: number;
    label: string;
    labelSource?: string | null;
    role: "next" | "back" | "other";
    roleVia?: string | null;
    disabled: boolean;
    visible: boolean;
  }>;
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
    /** FREE-TEXT entries only — see `TEXT_ENTRY_TYPES`. A slider is not one. */
    textInputs: number;
    /**
     * EVERY control the driver will supply a value to — the superset that also holds sliders,
     * date pickers and colour wells (`VALUE_ENTRY_TYPES`). `walkPath`'s "did this survey
     * render?" test reads this, because a screen whose only question is a slider renders
     * perfectly and has ZERO text inputs; reading the narrow number there is the same defect
     * that made a number-only screen look like a survey that never rendered.
     *
     * Optional on purpose: absent on readers that predate it, and a consumer must then fall
     * back to `textInputs` rather than read the absence as "no value inputs".
     */
    valueInputs?: number;
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
/**
 * HOW A WALK ENDED — and why this is not `outcome`.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. `outcome: "no-advance-control"` meant two opposite things at
 * once: "the respondent reached the thank-you page and there is nothing left to press", and "we
 * never got into the survey at all". Four medical instruments recorded 38 observations OF THE
 * SAME SCREEN under that one value, 142/142 observations stalled, and the 38 was reported upward
 * as progress. `outcome`'s `"completed"`, meanwhile, means "the step loop exited under budget" —
 * a real thank-you page lands on `"no-advance-control"`, not on `"completed"`. Neither value can
 * be read as an ending, so the ending is typed separately and from the EVIDENCE.
 *
 *   - `completed`     nothing left to press, and the final screen says the survey is finished
 *                     (or a progress indicator reads full).
 *   - `screened-out`  nothing left to press, and the final screen says the respondent does not
 *                     qualify. Tested BEFORE completion, because a disqualification page thanks
 *                     you too.
 *   - `stalled`       the final screen still offered an enabled control that advances the
 *                     survey, or the walk stopped for its own reasons — a cap, an error, a
 *                     submit the survey refused.
 *   - `unclassified`  nothing left to press and nothing said WHICH kind of ending it was. A
 *                     REAL, COUNTED residual: defaulting an unrecognised ending to `completed`
 *                     would rebuild the exact defect this type exists to remove, and consumers
 *                     must read it as "not decidable", never as an ending.
 *
 * THIS IS AN OBSERVATION, NOT A VERDICT (this file's ONE RULE). `screened-out` says "the page
 * this walk landed on says the respondent does not qualify" — never "the survey wrongly screened
 * us out". `evidence` carries the quoted markers that decided it, so a reader can disagree with
 * the classification without having to re-open the screen capture.
 */
export type WalkEndingKind = "completed" | "screened-out" | "stalled" | "unclassified";

export interface WalkEnding {
  kind: WalkEndingKind;
  /** The facts that decided it, with the matched wording quoted. Never empty. */
  evidence: string[];
}

export interface BindingRefusal {
  /** The planned decision's question id. */
  question: string;
  reason: "option-labels-only" | "identity-ambiguous" | "identity-conflict" | "screen-is-another-question";
  detail: string;
}

/**
 * One thing the driver did to the page, recorded as performed — not as intended.
 *
 * TWO KINDS WERE ADDED WHEN THE WALKER LEARNED THE REST OF THE INPUT TYPES, and both are
 * deliberately NOT `type-text`:
 *
 *   `set-value`    a slider, a date picker or a colour well: assigned + `input`/`change`
 *                  dispatched, because measured in Chrome these silently discard typed text and
 *                  a range ignores keystrokes altogether. Calling it `type-text` would tell a
 *                  reader keystrokes were delivered when they were not.
 *   `refuse-fill`  a control this harness will NOT answer (a password field) or CANNOT answer
 *                  (a file input). `ok` is FALSE on these and that is the point: a refusal
 *                  recorded as a success is exactly the confident wrong answer this product
 *                  exists to catch, and a walk that then stalls must be able to say why.
 *
 * Consumers that filter for `type-text` (`verify-observations.ts`, `pipeline/judge`) keep seeing
 * exactly what they saw before: every type they have ever been shown is still typed.
 */
export interface PerformedAction {
  kind:
    | "click-option"
    | "type-text"
    | "set-value"
    | "refuse-fill"
    | "clear-text"
    | "click-next"
    | "click-back"
    | "select-grid-cell"
    | "open";
  targetIdx: number | null;
  targetLabel: string | null;
  targetCode: string | null;
  value: string | null;
  ok: boolean;
  detail: string | null;
}

/**
 * A CONTROL THE WALKER DID NOT ANSWER, AND WHY — the counterweight to teaching it more types.
 *
 * THE FAILURE THIS EXISTS TO PREVENT. Widening the set of inputs the walker fills makes it
 * likelier that a walk advances; the cost of getting that wrong is a driver that reports success
 * on a field it never satisfied, which would pass any "it advances now" test and destroy the
 * product. So the widening ships with its opposite: every control the walker meets and does NOT
 * answer is NAMED here, and a walk that then goes nowhere says so instead of reporting the
 * generic "this screen offered no enabled control that advances the survey" — a sentence that
 * reads identically to a normal ending.
 *
 * The reasons are facts about the HARNESS, never verdicts about the survey:
 *
 *   - `refused-by-policy`   we will not type into it (a password field). Permanent by design.
 *   - `cannot-be-satisfied` it cannot be answered from a page script at all (a file input).
 *   - `no-derivation`       its type is one this harness has no value rule for. The honest
 *                           "we have no rule" — never "there was nothing to answer".
 *   - `value-rejected`      a value WAS derived and the control refused it (sanitised it away,
 *                           or it fell outside a `pattern`/`step` the site declares).
 */
export interface UnfillableControl {
  /** Index into the reader's control order — the same index every action carries. */
  idx: number;
  type: string;
  label: string;
  required: boolean;
  reason: "refused-by-policy" | "cannot-be-satisfied" | "no-derivation" | "value-rejected";
  detail: string;
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
  /**
   * Controls on THIS screen the walker did not answer, each with the reason. See
   * `UnfillableControl`. An EMPTY ARRAY is a claim — "we looked and answered everything we met";
   * the field ABSENT is a walk from before the check existed. Absence is never "none".
   */
  unfillableControls?: UnfillableControl[];
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
  evidence: {
    /** Legacy evidence ids, preserved for existing readers. */
    screenBefore: string | null;
    /** Legacy evidence id, preserved for existing readers. */
    screenAfterAdvance: string | null;
    /** Legacy flat screenshot ids, preserved for existing readers. */
    screenshots: string[];
    /**
     * Typed, modality-paired captures made by the visual+accessibility reader. Absent means an
     * older walker did not make paired captures; `[]` means a current walker made no epoch for
     * this synthetic step.
     */
    screenCaptures?: ScreenCaptureEpoch[];
    /** Present and empty means every capture attempted for this step succeeded completely. */
    captureFailures?: ScreenCaptureFailure[];
    captureFailureCount?: number;
  };
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
  /**
   * WHY THE STEP LOOP EXITED: "completed" | "no-advance-control" | "blocked" | "step-cap" |
   * "error". NOT an ending — `"completed"` here means "the loop exited under budget" and a real
   * thank-you page lands on `"no-advance-control"`. See `ending`.
   */
  outcome: string;
  outcomeDetail: string | null;
  /**
   * HOW THE WALK ENDED, typed from the final screen with its evidence quoted. See `WalkEnding`.
   *
   * Optional on purpose, and the degradation is the contract: an artifact written before this
   * field existed carries no ending, and a consumer must read its ABSENCE as "not decidable",
   * exactly as it read every walk before endings were typed. Absence is never a completion.
   */
  ending?: WalkEnding;
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
  /**
   * EVERY CONTROL THIS WALK MET AND DID NOT ANSWER, lifted to the walk with the step it was on
   * — the same treatment, and for the same reason, as `readerLimitations`: a refusal named on
   * screen 4 and left in screen 4's payload is a refusal nobody reads, and the walk's own
   * `outcome` would then be the generic one.
   *
   * Optional: absent on artifacts written before it existed, and absence must not be read as
   * "the walker answered everything".
   */
  unfillableControls?: Array<UnfillableControl & { stepIndex: number }>;
  /** How many, summed over screens. Counted, not implied. */
  unfillableControlCount?: number;
  /**
   * HOW MANY ANSWERS ON THIS WALK THE HARNESS INVENTED.
   *
   * Every answer given because the plan had no opinion — a first option clicked, a number
   * chosen inside the site's own bounds — is a `navigator-default`, and a walk made mostly of
   * them describes a respondent this harness made up. THAT MATTERS MOST AT THE ENDING: a
   * `screened-out` reached on invented answers is evidence about the filler, not about the
   * survey, and a consumer that cannot tell the two apart will report "the site screens
   * respondents out here" about a screener working exactly as documented.
   *
   * Optional: absent on artifacts written before it existed.
   */
  navigatorDefaultAnswerCount?: number;
  /**
   * Every paired visual/accessibility epoch made on the walk, including a load-failure epoch
   * that could not become a normal step. Optional only for artifacts from the older reader.
   */
  screenCaptures?: ScreenCaptureEpoch[];
  screenCaptureCount?: number;
  /** Named capture shortfalls lifted to the walk; absent is legacy, `[]` is checked-and-clean. */
  captureFailures?: ScreenCaptureFailure[];
  captureFailureCount?: number;
  evidenceIds: string[];
  viewport: { width: number; height: number };
}

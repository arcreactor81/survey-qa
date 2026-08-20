/**
 * THE SURVEY DRIVER — walking a planned path through a live survey.
 *
 * The plan says WHICH answers to give. This module gives them to a real page in a real
 * browser and writes down what happened. It decides nothing about correctness.
 *
 * FOUR THINGS IT IS CAREFUL ABOUT, EACH FOR A REASON.
 *
 * 1. THE COMPLETE INVENTORY COMES FIRST. Every screen is read in full BEFORE it is
 *    touched: every control, every option with its code, every disabled/checked state,
 *    the visible text, the progress indicator, the buttons. An absence claim ("the
 *    document's fourth option is not offered") is only meaningful against the complete
 *    positive list that WAS offered, so the capture is never narrowed to what was asked
 *    for.
 *
 * 2. THE PLAN IS MATCHED TO THE SCREEN BY IDENTITY, AND REFUSES WHEN IT CANNOT BE. A survey
 *    that routes differently than the contract implies would silently desynchronise a driver
 *    that walked decisions positionally: decision 6 would be typed into question 9 and
 *    every observation after it would be mislabelled. That guard was designed here from the
 *    start — and the only signal implementing it, the question id printed on the screen, TURNS
 *    OUT NOT TO EXIST ON REAL SURVEYS. The instrument this product was first run against
 *    prints no ids anywhere in its text, and the planner emitted 275 of 286 decisions with an
 *    empty `select`, so binding ran on OPTION-LABEL OVERLAP ALONE — and `labelMatches` is
 *    containment-tolerant. A decision for Q7 wanting "Can't remember" bound to a different
 *    screen offering "Don't know / can't remember", was consumed there, and the real Q7 screen
 *    took the OPPOSITE branch under `navigator-default` while the case was reported exercised.
 *    Tightening the matcher does not fix that: one of the measured mis-bindings matched "Yes"
 *    against "Yes" EXACTLY, on the wrong screen. Without identity, binding is ambiguous.
 *
 *    So the signal is the DOCUMENT'S OWN WORDING of the question, which the plan now stamps on
 *    every decision (`stages/plan.ts#stampQuestionWording`), corroborated by the ids the
 *    screen's own controls carry. Option-label overlap is a BONUS and can never bind by
 *    itself; a decision that cannot be identified is REFUSED, stays pending for a later
 *    screen, and is counted on the observation. A screen no decision identifies is still
 *    answered by an explicit `navigator-default` that is RECORDED as such.
 *
 * 3. WHAT WAS CLICKED IS OBSERVED, NOT INFERRED. After acting and before advancing, the
 *    screen is read again, so the record contains the control states the click actually
 *    produced rather than the states it was supposed to produce.
 *
 * 4. A PROBE THAT IS BLOCKED IS A SUCCESSFUL PROBE. The plan's boundary entries
 *    deliberately submit an empty or invalid answer; being stopped is the observation.
 *    The driver records the block with the validation text, then recovers by answering
 *    validly so the rest of the walk still happens.
 */

import {
  CONTROL_SELECTOR,
  ERROR_COLLECTOR,
  HISTORY_SHIM,
  LABEL_SELECTOR,
  READ_SCREEN,
  clearValueScript,
  fillRefusalFor,
  isTextEntry,
  isValueEntry,
  selectOptionScript,
  setValueScript,
} from "./page-script";
import type {
  AccessibilitySnapshotArtifact,
  AccessibilitySnapshotNode,
  AdvanceSignal,
  BindingRefusal,
  BlockedReason,
  ControlState,
  PathObservation,
  PerformedAction,
  RenderedScreen,
  ScreenCaptureEpoch,
  ScreenCaptureFailure,
  ScreenCaptureGeometry,
  StepObservation,
  UnfillableControl,
  WalkEnding,
} from "./types";
import type { CaptureContext } from "./capture";
import {
  captureAccessibilitySnapshot,
  captureFailure,
  capturePathObservation,
  captureScreenJsonRef,
  captureScreenshotRef,
} from "./capture";
import type { PlannedDecision, PlannedPath } from "../workflow/stages/planner/plan-core.js";
import { sha256Hex } from "../store/hash";

// ---------------------------------------------------------------------------
// Structural types over the puppeteer surface we use. Declared here (as
// browser-session.ts declares BrowserLike) so this module can be reasoned about
// without dragging the whole puppeteer type graph through the Worker.
// ---------------------------------------------------------------------------

export interface ElementHandleLike {
  click(opts?: unknown): Promise<void>;
  type(text: string, opts?: unknown): Promise<void>;
  focus(): Promise<void>;
  dispose?(): Promise<void>;
}

export interface PageLike {
  goto(url: string, opts?: unknown): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
  evaluateOnNewDocument(script: string): Promise<unknown>;
  $$(selector: string): Promise<ElementHandleLike[]>;
  screenshot(opts?: unknown): Promise<Uint8Array | ArrayBuffer | string>;
  /** Optional only so pre-pivot test doubles and old adapters fail visibly rather than crash. */
  accessibility?: { snapshot(opts?: { interestingOnly?: boolean }): Promise<unknown | null> };
  setViewport(vp: { width: number; height: number; deviceScaleFactor?: number }): Promise<void>;
  on(event: string, handler: (arg: unknown) => void): void;
  close(): Promise<void>;
  reload(opts?: unknown): Promise<unknown>;
}

export interface WalkOptions {
  surveyUrl: string;
  runId: string;
  planRevisionId: string;
  attemptId: string;
  tier: 1 | 2;
  /** Hard cap on screens per walk; a survey that never terminates must not hang a batch. */
  maxSteps: number;
  /** Wall-clock budget for this walk. Checked between steps. */
  deadline: number;
  viewport: { width: number; height: number };
  /** Apply the documented one-property shim on this walk (second attempt only). */
  applyHistoryShim: boolean;
  /** ms to wait for the screen to change after pressing Next before calling it blocked. */
  advanceTimeoutMs: number;
  /**
   * BOUNDED SCREEN-OUT RETRY: which deterministic filler variant this walk uses. 0 (or
   * absent) is today's defaults, byte-for-byte; `execute-batch.ts` sets the durable pivot
   * ordinal (1..2) when re-walking a path that screened out on navigator-default answers.
   *
   * Consumed ONLY by the navigator-default choosers inside `applyDecision`: the option
   * default picks the Nth eligible option AFTER survival-hint filtering (clamped to the
   * last one), and number/range fillers take the 25%/75% quantile of the site's declared
   * range for variant 1/2 — still snapped to the site's own step grid, still clamped.
   * Planned answers, the grid default, and the constant-sum pass are NOT consumers: a
   * plan-specified answer replays identically on every attempt (so a plan-caused
   * screen-out reproduces and the pivot cap closes it), and an allocation's values are
   * constraint-determined, not chosen. The variant is durable state, never a clock or a
   * random draw — the same inputs walk the same walk on every Workflow step replay.
   */
  variant?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const norm = (s: string): string =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const PROBE_TEXT = "QA-PROBE";

/** Label match: exact first, then containment either way. Never fuzzy scoring. */
function labelMatches(optionLabel: string, wanted: string): boolean {
  const a = norm(optionLabel);
  const b = norm(wanted);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) && b.length >= 3) return true;
  if (b.includes(a) && a.length >= 3) return true;
  return false;
}

// ---------------------------------------------------------------------------
// SCREEN IDENTITY — which planned decision is the screen in front of us?
// ---------------------------------------------------------------------------

const tokenSet = (s: string): Set<string> => new Set(norm(s).split(" ").filter(Boolean));

/**
 * The wording thresholds, MEASURED against the live instrument rather than chosen.
 *
 * Every screen of the live survey was captured and scored against the wording of all 13
 * planned questions from the sealed contract. The result:
 *
 *   - a screen's OWN question scored 0.969–1.000 (ten of eleven scored 1.000);
 *   - the best WRONG question on a screen whose question had no pending decision: 0.393;
 *   - the worst confusable pair — Q7 "…have you tried a coffee product at home that was new
 *     to you…" against Q8's screen "You said that in the past 3 months you have tried a
 *     coffee product…", which really do share most of their words: 0.642.
 *
 * `0.7` therefore sits ABOVE the worst confusable pair and BELOW the worst true positive: a
 * question whose wording the site paraphrases heavily falls under it and is REFUSED, which is
 * the direction the failure has to point. The ratio keeps a screen that two decisions both
 * describe from binding to whichever scored a hair higher.
 *
 * THIS CALIBRATION IS AN ASSUMPTION ABOUT SITES, NOT A LAW (CLAUDE.md, the north star): a site
 * that renders questions in a different language from the document, or paraphrases them,
 * scores near zero and binds nothing by wording. That degrades to markup identity, and failing
 * that to a counted refusal — never to a confident wrong answer.
 */
const WORDING_BIND_MIN = 0.7;
const WORDING_MARGIN_RATIO = 1.25;
/** Below this, a "wording" is a programmer instruction ("ASK ALL.") and matches everything. */
const MIN_WORDING_TOKENS = 4;

// ---------------------------------------------------------------------------
// COMPOSITE BINDING SCORE — thresholds and weights.
//
// When NO SINGLE signal crosses its threshold alone (wording < WORDING_BIND_MIN, no markup,
// no question token in heading), the binder assembles a weighted composite from every weak
// signal that IS present. A composite score above COMPOSITE_BIND_MIN binds the decision.
//
// WHY THESE NUMBERS: the composite is a fallback. Its threshold is deliberately HIGH so that
// binding on weak signals alone requires MULTIPLE independent witnesses agreeing. A screen
// that merely echoes a couple of option labels from a different question scores ~0.30 on
// option overlap alone and does NOT reach 0.55. A screen with weak wording (~0.4) AND option
// overlap (~0.3) AND matching response type (~0.10) reaches ~0.80 and DOES bind.
//
// ASSUMPTION STATED: the composite weights reflect the relative informativeness of each signal
// for ANY survey. A site that uses a language the document does not (wording always 0) will
// never bind by composite, and that is the correct outcome — composite is a repair for
// PARTIAL wording match, not a replacement for it.
// ---------------------------------------------------------------------------

/** Below this composite score, no binding. Set above any single weak signal alone. */
const COMPOSITE_BIND_MIN = 0.55;
/** Two candidates must be separated by this ratio, or the composite refuses both. */
const COMPOSITE_MARGIN_RATIO = 1.3;

/** Weights for each signal in the composite. Sum to 1.0 for clarity; the threshold is scaled accordingly. */
const COMPOSITE_WEIGHT_WORDING = 0.50;
const COMPOSITE_WEIGHT_OPTIONS = 0.30;
const COMPOSITE_WEIGHT_RESPONSE_TYPE = 0.20;

/**
 * RESPONSE-TYPE MATCH: does the screen's structural shape corroborate a decision?
 *
 * A single-select question with 5 options matching a screen that has a radio group with ~5
 * options is weak evidence they are the same question. This signal is NEVER strong enough
 * alone; it only nudges a composite over the threshold when wording and option overlap already
 * provide partial evidence.
 *
 * ASSUMPTION STATED: a decision's `select` array length and the presence of `text_entry`
 * are structural hints about response type. This works for any survey platform, because
 * it reads the PLAN's view of what the document described, not any platform convention.
 */
export function responseTypeScore(decision: PlannedDecision, screen: RenderedScreen): number {
  const selectCount = Array.isArray(decision.select) ? decision.select.length : 0;
  const hasTextEntry = !!decision.text_entry;
  const screenOptions = screen.optionGroups.reduce((sum, g) => sum + g.options.length, 0);
  const screenTextInputs = screen.counts?.textInputs ?? 0;
  const screenHasGrid = !!screen.grid;

  let score = 0;

  // Text entry match: the decision expects text input and the screen has one
  if (hasTextEntry && screenTextInputs > 0) score += 0.5;
  // Text entry mismatch: the decision expects text but the screen has none (or vice versa)
  if (hasTextEntry && screenTextInputs === 0) score -= 0.2;

  // Option-group presence match
  if (selectCount > 0 && screenOptions > 0) {
    score += 0.3;
    // Option count similarity: the closer the counts, the more corroborating
    const countRatio = Math.min(selectCount, screenOptions) / Math.max(selectCount, screenOptions);
    score += 0.2 * countRatio;
  }

  // Grid match: if the decision has no select and the screen is a grid, that's corroborating
  // for decisions on grid questions (which typically have empty select and text_entry)
  if (screenHasGrid && selectCount === 0 && !hasTextEntry) score += 0.3;

  return Math.max(0, Math.min(1, score));
}

/**
 * COMPOSITE BINDING SCORE for a single decision against this screen.
 *
 * Combines three weak signals:
 *   - wording (below WORDING_BIND_MIN but nonzero)
 *   - option-label overlap (normalised to [0, 1])
 *   - response-type match
 *
 * Returns a value in [0, 1]. The caller must still check separation and conflict rules.
 */
export function compositeScore(
  wordingScore: number,
  optionHitCount: number,
  optionExpected: number,
  responseType: number,
): number {
  // Normalise wording to [0, 1]: already in that range from questionWordingScore
  const wordingNorm = Math.max(0, Math.min(1, wordingScore));

  // Normalise option hits: fraction of expected labels that the screen offers
  const optionNorm = optionExpected > 0 ? Math.min(1, optionHitCount / optionExpected) : 0;

  // Response type already in [0, 1]
  const responseNorm = Math.max(0, Math.min(1, responseType));

  return (
    COMPOSITE_WEIGHT_WORDING * wordingNorm +
    COMPOSITE_WEIGHT_OPTIONS * optionNorm +
    COMPOSITE_WEIGHT_RESPONSE_TYPE * responseNorm
  );
}

/**
 * HOW WELL DOES THE DOCUMENT'S WORDING OF A QUESTION DESCRIBE THIS SCREEN?
 *
 * An F-measure of two deliberately different comparisons, because the two errors are different:
 *
 *   PRECISION is taken against the screen's own HEADING — what fraction of what this screen
 *   ASKS is accounted for by this wording. A back-reference in body prose ("You said earlier
 *   that…") cannot inflate it, which is the D29 lesson applied here.
 *
 *   RECALL is taken against the screen's FULL text — what fraction of the document's wording
 *   appears anywhere on this screen. A document sentence that continues into an instruction
 *   the site renders below the heading ("Please include any kind of coffee…") is then still
 *   found. Measured: this alone moved S2's score on its own screen from 0.556 to 1.000.
 */
export function questionWordingScore(wording: string | null | undefined, screen: RenderedScreen): number {
  const w = tokenSet(String(wording ?? ""));
  if (w.size < MIN_WORDING_TOKENS) return 0;
  const headingText =
    screen.questionText && screen.questionText.length > 0 ? screen.questionText : screen.visibleText.slice(0, 600);
  const heading = tokenSet(headingText);
  if (heading.size === 0) return 0;
  const full = tokenSet(`${screen.questionText ?? ""} ${screen.instructionText ?? ""} ${screen.visibleText ?? ""}`);
  let inHeading = 0;
  let inFull = 0;
  for (const t of w) {
    if (heading.has(t)) inHeading += 1;
    if (full.has(t)) inFull += 1;
  }
  const precision = inHeading / heading.size;
  const recall = inFull / w.size;
  if (precision === 0 || recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * WHICH OF THE WALK'S QUESTION IDS DOES THIS SCREEN'S MARKUP NAME?
 *
 * The same two readings, in the same order, as `verify-observations.ts#controlSealedIdsOnScreen`
 * — `name` equal to an id outright, else the `id` prefix before its first separator, which is
 * the fallback a GRID needs (`name="Q5_A"`, `id="Q5_A_1"`, question `Q5`). Driver and verifier
 * must agree on what a screen IS, or the driver answers one question and the verifier reads
 * the answer as another's.
 *
 * ASSUMPTION, STATED, AND IT IS THE SAME RELIANCE THE VERIFIER DECLARES: "a control's `name`
 * is the document's question id" is a convention of the surveys we have. Decipher, Qualtrics
 * and SurveyJS each name controls their own way; a real instrument may emit `QID12_4`, a GUID
 * or nothing. WHERE IT DOES NOT HOLD this returns `[]` — the signal is simply absent, wording
 * carries the bind, and if wording cannot either the decision is refused and counted. That is
 * why this is a corroborating signal and not the primary one.
 *
 * The candidate set is EVERY question on the walk, not only the pending ones, on purpose: a
 * screen that names a question whose decision has already been used is evidence this screen is
 * NOT any of the pending ones, and narrowing the set would throw that evidence away.
 */
export function screenMarkupQuestionIds(screen: RenderedScreen, universe: string[]): string[] {
  const known = new Set(universe.filter((q) => typeof q === "string" && q.length > 0));
  if (known.size === 0 || !Array.isArray(screen.controls)) return [];
  const found = new Set<string>();
  for (const c of screen.controls) {
    if (typeof c?.name === "string" && known.has(c.name)) {
      found.add(c.name);
      continue;
    }
    const prefix = typeof c?.id === "string" ? c.id.split(/[_\-.:$[\]]/)[0] : "";
    if (prefix && known.has(prefix)) found.add(prefix);
  }
  return [...found];
}

/**
 * Does the screen print this question's id AS ITS OWN HEADING?
 *
 * Restricted to the heading deliberately. The id printed anywhere in body prose is what
 * D29 caught being read as identity — "as you said at Q2" prints Q2 on a screen that is not
 * Q2 — so the token is a bonus signal everywhere and an identity signal only here.
 */
function tokenInHeading(screen: RenderedScreen, question: string): boolean {
  const token = norm(String(question ?? ""));
  if (!token) return false;
  const heading = norm(screen.questionText ?? "");
  if (!heading) return false;
  return new RegExp(`(^| )${token}( |$)`).test(heading);
}

export interface DecisionBinding {
  decision: PlannedDecision;
  index: number;
  /** The evidence, e.g. `wording:0.97+markup:Q7`. Never empty on a binding. */
  via: string;
}

export interface BindingOutcome {
  match: DecisionBinding | null;
  /** Decisions considered and declined. Each one is a screen this driver refused to guess. */
  refusals: BindingRefusal[];
}

/**
 * BIND THIS SCREEN TO A PENDING DECISION, OR REFUSE.
 *
 * THE ORDER IS THE POLICY:
 *
 *   1. WORDING, the primary signal, decides — the document is the source of truth and its
 *      wording is the one thing every survey renders. A clear winner binds.
 *   2. MARKUP corroborates or CONTRADICTS. Disagreement between the two is a refusal, not a
 *      casting vote: if the words say Q7 and the form fields say Q8, one of them is wrong and
 *      the driver does not know which.
 *   3. MARKUP ALONE binds when there is no usable wording — the honest case for a question the
 *      contract never worded. And a screen whose markup names a question with NO pending
 *      decision refuses everything: that screen has said what it is, and it is not ours.
 *   4. THE QUESTION TOKEN IN THE HEADING binds only when exactly one decision claims it.
 *  4b. COMPOSITE BINDING — when no single signal is strong enough, a weighted composite of
 *      partial wording, option-label overlap and response-type match may bind. The composite
 *      REQUIRES wording > 0 (option overlap alone cannot reach the threshold by construction)
 *      and applies the same ambiguity guard: two candidates scoring close refuse both.
 *   5. OPTION-LABEL OVERLAP NEVER BINDS ON ITS OWN. When the composite also could not bind,
 *      option overlap is recorded as a refusal: `option-labels-only`.
 *
 * OPTION OVERLAP IS NEVER REQUIRED EITHER, and that direction matters just as much. A screen
 * whose wording identifies it MUST bind even when it offers none of the labels the decision
 * asks for — that is precisely how a missing option becomes `requestedButNotOffered` and then
 * a finding. A binder that demanded option agreement would be silent about the defect this
 * product exists to catch.
 */
export function bindDecision(
  screen: RenderedScreen,
  remaining: PlannedDecision[],
  universe?: string[],
): BindingOutcome {
  const refusals: BindingRefusal[] = [];
  if (remaining.length === 0) return { match: null, refusals };

  const ids = universe && universe.length > 0 ? universe : remaining.map((d) => String(d.question ?? ""));
  const markupIds = screenMarkupQuestionIds(screen, ids);
  // More than one sealed id in the markup means the screen has not identified itself: at most
  // one of them can be its identity. Same fail-closed rule the verifier applies.
  const markupId = markupIds.length === 1 ? markupIds[0]! : null;

  const offered = screen.optionGroups.flatMap((g) => g.options.map((o) => o.label));
  const optionHits = (d: PlannedDecision): number => {
    const wanted = Array.isArray(d.select) ? d.select : [];
    return wanted.filter((w) => offered.some((o) => labelMatches(o, w))).length;
  };

  const scored = remaining.map((decision, index) => ({
    decision,
    index,
    question: String(decision.question ?? ""),
    wording: questionWordingScore(
      typeof decision.question_text === "string" ? decision.question_text : null,
      screen,
    ),
  }));
  const ranked = [...scored].sort((a, b) => b.wording - a.wording || a.index - b.index);
  const top = ranked[0];
  const runnerUp = ranked[1];

  const bind = (row: (typeof scored)[number], via: string): BindingOutcome => ({
    match: { decision: row.decision, index: row.index, via },
    refusals,
  });
  const evidence = (row: (typeof scored)[number], parts: string[]): string => {
    const hits = optionHits(row.decision);
    return [...parts, ...(hits > 0 ? [`options:${hits}`] : [])].join("+");
  };

  // ---- 1 + 2: wording decides, markup corroborates or contradicts ----
  if (top && top.wording >= WORDING_BIND_MIN) {
    const separated = !runnerUp || runnerUp.wording <= 0 || top.wording >= runnerUp.wording * WORDING_MARGIN_RATIO;
    if (!separated && runnerUp) {
      for (const row of [top, runnerUp]) {
        refusals.push({
          question: row.question,
          reason: "identity-ambiguous",
          detail:
            `this screen matches the document's wording of ${top.question} (${top.wording.toFixed(2)}) and of ` +
            `${runnerUp.question} (${runnerUp.wording.toFixed(2)}) about equally; at most one of them is this ` +
            `screen and choosing the higher score would be a guess`,
        });
      }
      return { match: null, refusals };
    }
    if (markupId && markupId !== top.question) {
      refusals.push({
        question: top.question,
        reason: "identity-conflict",
        detail:
          `the document's wording of ${top.question} describes this screen (${top.wording.toFixed(2)}) but the ` +
          `screen's own controls name ${markupId}; the two witnesses disagree and neither overrules the other`,
      });
      return { match: null, refusals };
    }
    return bind(top, evidence(top, [`wording:${top.wording.toFixed(2)}`, ...(markupId ? [`markup:${markupId}`] : [])]));
  }

  // ---- 3: markup alone ----
  if (markupId) {
    const byMarkup = scored.find((row) => row.question === markupId);
    if (byMarkup) return bind(byMarkup, evidence(byMarkup, [`markup:${markupId}`]));
    for (const row of scored) {
      if (optionHits(row.decision) === 0 && row.wording === 0) continue;
      refusals.push({
        question: row.question,
        reason: "screen-is-another-question",
        detail:
          `this screen's controls name ${markupId}, which has no pending decision, so the screen is not ` +
          `${row.question}'s however much of it looks familiar`,
      });
    }
    return { match: null, refusals };
  }

  // ---- 4: the question token, printed as this screen's own heading ----
  const tokenClaims = scored.filter((row) => tokenInHeading(screen, row.question));
  if (tokenClaims.length === 1) {
    const row = tokenClaims[0]!;
    return bind(row, evidence(row, [`question-token:${row.question}`]));
  }
  if (tokenClaims.length > 1) {
    for (const row of tokenClaims) {
      refusals.push({
        question: row.question,
        reason: "identity-ambiguous",
        detail: `this screen's heading prints ${tokenClaims.map((c) => c.question).join(" and ")}; at most one is its own id`,
      });
    }
    return { match: null, refusals };
  }

  // ---- 4b: COMPOSITE BINDING — no single signal is strong enough alone, but multiple weak
  //          signals together may identify this screen. This is the FALLBACK that the FLOOR-01
  //          walk needed: weak wording + option overlap + response-type match can cross the
  //          threshold together, when none could alone.
  //
  //          THE SAME TWO GUARDS APPLY: conflicting signals refuse (already handled above
  //          in paths 1-2), and ambiguity between two candidates refuses (checked here).
  //
  //          OPTION OVERLAP IS NEVER IDENTITY ON ITS OWN, even inside the composite: if
  //          wording contributes zero, option overlap alone cannot reach COMPOSITE_BIND_MIN
  //          because its maximum weight (0.30) + response-type's maximum (0.20) = 0.50 < 0.55.
  //          That is BY CONSTRUCTION. ----
  {
    const compositeScored = scored.map((row) => {
      const hits = optionHits(row.decision);
      const expected = Array.isArray(row.decision.select) ? row.decision.select.length : 0;
      const rt = responseTypeScore(row.decision, screen);
      return {
        ...row,
        composite: compositeScore(row.wording, hits, expected, rt),
        compositeDetail: {
          wording: row.wording,
          optionHits: hits,
          optionExpected: expected,
          responseType: rt,
        },
      };
    });

    const compositeRanked = [...compositeScored].sort((a, b) => b.composite - a.composite || a.index - b.index);
    const cTop = compositeRanked[0];
    const cRunnerUp = compositeRanked[1];

    if (cTop && cTop.composite >= COMPOSITE_BIND_MIN) {
      // Ambiguity guard: two candidates scoring close together refuse, same as wording path.
      const cSeparated =
        !cRunnerUp ||
        cRunnerUp.composite <= 0 ||
        cTop.composite >= cRunnerUp.composite * COMPOSITE_MARGIN_RATIO;

      if (!cSeparated && cRunnerUp) {
        for (const row of [cTop, cRunnerUp]) {
          refusals.push({
            question: row.question,
            reason: "composite-ambiguous",
            detail:
              `composite signals for ${cTop.question} (${cTop.composite.toFixed(2)}) and ` +
              `${cRunnerUp.question} (${cRunnerUp.composite.toFixed(2)}) are too close to distinguish; ` +
              `wording: ${row.compositeDetail.wording.toFixed(2)}, options: ${row.compositeDetail.optionHits}/${row.compositeDetail.optionExpected}, ` +
              `responseType: ${row.compositeDetail.responseType.toFixed(2)}`,
          });
        }
        return { match: null, refusals };
      }

      // Wording must contribute SOMETHING — composite without any wording is option overlap
      // in disguise, and option overlap alone is the production defect.
      if (cTop.wording > 0) {
        const cd = cTop.compositeDetail;
        const parts = [
          `composite:${cTop.composite.toFixed(2)}`,
          `wording:${cd.wording.toFixed(2)}`,
          ...(cd.optionHits > 0 ? [`options:${cd.optionHits}/${cd.optionExpected}`] : []),
          ...(cd.responseType > 0 ? [`responseType:${cd.responseType.toFixed(2)}`] : []),
        ];
        return bind(cTop, parts.join("+"));
      }
    }
  }

  // ---- 5: option-label overlap is not identity ----
  for (const row of scored) {
    const hits = optionHits(row.decision);
    if (hits === 0) continue;
    refusals.push({
      question: row.question,
      reason: "option-labels-only",
      detail:
        `this screen offers ${hits} label(s) ${row.question} asks for, and nothing else links them: no question ` +
        `wording matched (${row.wording.toFixed(2)} < ${WORDING_BIND_MIN}), no control names it, its id is not in ` +
        `the heading. Two different questions may offer the same words, so this is not identity`,
    });
  }
  return { match: null, refusals };
}

/**
 * The binding alone, for callers that do not record the refusals.
 *
 * KEPT because a match is what most readers want, NOT as the recommended entry point: a caller
 * that drops `refusals` on the floor turns a named limitation back into a silent one, which is
 * the whole defect. `walkPath` uses `bindDecision`.
 */
export function matchDecision(
  screen: RenderedScreen,
  remaining: PlannedDecision[],
  universe?: string[],
): { decision: PlannedDecision; index: number; via: string } | null {
  return bindDecision(screen, remaining, universe).match;
}

async function read(page: PageLike): Promise<RenderedScreen> {
  return (await page.evaluate(READ_SCREEN)) as RenderedScreen;
}

const READ_CAPTURE_GEOMETRY = String.raw`(() => {
  const root = document.documentElement;
  const body = document.body;
  const width = Math.max(root ? root.scrollWidth : 0, body ? body.scrollWidth : 0, window.innerWidth || 0);
  const height = Math.max(root ? root.scrollHeight : 0, body ? body.scrollHeight : 0, window.innerHeight || 0);
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    deviceScaleFactor: window.devicePixelRatio,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    documentWidth: width,
    documentHeight: height,
  };
})()`;

export const ACCESSIBILITY_CAPTURE_LIMITS: Readonly<{
  maxNodes: number;
  maxDepth: number;
  maxValueChars: number;
  maxSerializedBytes: number;
}> = Object.freeze({
  maxNodes: 5_000,
  maxDepth: 64,
  maxValueChars: 16_384,
  maxSerializedBytes: 1_500_000,
});

type AccessibilityLimitKind = Extract<
  ScreenCaptureFailure["kind"],
  | "accessibility-snapshot-invalid-node"
  | "accessibility-snapshot-node-limit"
  | "accessibility-snapshot-depth-limit"
  | "accessibility-snapshot-value-limit"
  | "accessibility-snapshot-size-limit"
>;

interface AccessibilitySanitizeLimitation {
  kind: AccessibilityLimitKind;
  count: number;
  detail: string;
}

export interface SanitizedAccessibilitySnapshot {
  tree: AccessibilitySnapshotNode | null;
  nodeCount: number;
  maxDepthObserved: number;
  limitations: AccessibilitySanitizeLimitation[];
  error: string | null;
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Convert Puppeteer's live AX objects into a closed JSON-only tree.
 *
 * `elementHandle()` is intentionally not even consulted. Unknown properties are dropped and
 * only the documented scalar state above is copied. The limits are fail-loud: every pruned
 * branch or value is counted in `limitations`; a consumer must never mistake the resulting
 * partial tree for a complete Chrome snapshot.
 */
export function sanitizeAccessibilitySnapshot(
  raw: unknown,
  requested: Partial<typeof ACCESSIBILITY_CAPTURE_LIMITS> = {},
): SanitizedAccessibilitySnapshot {
  const limits = {
    maxNodes: Math.max(1, Math.floor(requested.maxNodes ?? ACCESSIBILITY_CAPTURE_LIMITS.maxNodes)),
    maxDepth: Math.max(0, Math.floor(requested.maxDepth ?? ACCESSIBILITY_CAPTURE_LIMITS.maxDepth)),
    maxValueChars: Math.max(1, Math.floor(requested.maxValueChars ?? ACCESSIBILITY_CAPTURE_LIMITS.maxValueChars)),
  };
  let nodeCount = 0;
  let maxDepthObserved = 0;
  let nodeCuts = 0;
  let depthCuts = 0;
  let valueCuts = 0;
  let invalidNodes = 0;

  const boundedString = (value: string): string => {
    if (value.length <= limits.maxValueChars) return value;
    valueCuts += 1;
    return value.slice(0, limits.maxValueChars);
  };

  const visit = (value: unknown, depth: number, root = false): AccessibilitySnapshotNode | null => {
    if (!plainObject(value)) {
      invalidNodes += 1;
      return null;
    }
    if (depth > limits.maxDepth) {
      depthCuts += 1;
      return null;
    }
    if (nodeCount >= limits.maxNodes) {
      nodeCuts += 1;
      return null;
    }
    if (typeof value.role !== "string" || value.role.length === 0) {
      invalidNodes += 1;
      return null;
    }

    nodeCount += 1;
    maxDepthObserved = Math.max(maxDepthObserved, depth);
    const node: AccessibilitySnapshotNode = { role: boundedString(value.role), children: [] };

    const putString = (key: string, set: (v: string) => void): void => {
      const candidate = value[key];
      if (candidate === undefined) return;
      if (typeof candidate === "string") set(boundedString(candidate));
      else invalidNodes += 1;
    };
    const putBoolean = (key: string, set: (v: boolean) => void): void => {
      const candidate = value[key];
      if (candidate === undefined) return;
      if (typeof candidate === "boolean") set(candidate);
      else invalidNodes += 1;
    };
    const putNumber = (key: string, set: (v: number) => void): void => {
      const candidate = value[key];
      if (candidate === undefined) return;
      if (typeof candidate === "number" && Number.isFinite(candidate)) set(candidate);
      else invalidNodes += 1;
    };
    const putMixed = (key: string, set: (v: boolean | "mixed") => void): void => {
      const candidate = value[key];
      if (candidate === undefined) return;
      if (typeof candidate === "boolean" || candidate === "mixed") set(candidate);
      else invalidNodes += 1;
    };

    putString("name", (v) => (node.name = v));
    const axValue = value.value;
    if (axValue !== undefined) {
      if (typeof axValue === "string") node.value = boundedString(axValue);
      else if (typeof axValue === "number" && Number.isFinite(axValue)) node.value = axValue;
      else invalidNodes += 1;
    }
    putString("description", (v) => (node.description = v));
    putString("keyshortcuts", (v) => (node.keyshortcuts = v));
    putString("roledescription", (v) => (node.roledescription = v));
    putString("valuetext", (v) => (node.valuetext = v));
    putBoolean("disabled", (v) => (node.disabled = v));
    putBoolean("expanded", (v) => (node.expanded = v));
    putBoolean("focused", (v) => (node.focused = v));
    putBoolean("modal", (v) => (node.modal = v));
    putBoolean("multiline", (v) => (node.multiline = v));
    putBoolean("multiselectable", (v) => (node.multiselectable = v));
    putBoolean("readonly", (v) => (node.readonly = v));
    putBoolean("required", (v) => (node.required = v));
    putBoolean("selected", (v) => (node.selected = v));
    putMixed("checked", (v) => (node.checked = v));
    putMixed("pressed", (v) => (node.pressed = v));
    putNumber("level", (v) => (node.level = v));
    putNumber("valuemin", (v) => (node.valuemin = v));
    putNumber("valuemax", (v) => (node.valuemax = v));
    putString("autocomplete", (v) => (node.autocomplete = v));
    putString("haspopup", (v) => (node.haspopup = v));
    putString("invalid", (v) => (node.invalid = v));
    putString("orientation", (v) => (node.orientation = v));

    if (value.children !== undefined && !Array.isArray(value.children)) {
      invalidNodes += 1;
    } else {
      for (const child of (value.children as unknown[] | undefined) ?? []) {
        const clean = visit(child, depth + 1);
        if (clean) node.children.push(clean);
      }
    }

    // A malformed root cannot be represented as a different, invented role. Child nodes can be
    // dropped with an explicit limitation, but the root is the identity of the whole snapshot.
    if (root && nodeCount === 0) return null;
    return node;
  };

  const tree = visit(raw, 0, true);
  if (!tree) {
    return {
      tree: null,
      nodeCount,
      maxDepthObserved,
      limitations: [],
      error: "Chrome returned an accessibility root that was not a non-empty role-bearing object",
    };
  }

  const limitations: AccessibilitySanitizeLimitation[] = [];
  if (invalidNodes > 0) {
    limitations.push({
      kind: "accessibility-snapshot-invalid-node",
      count: invalidNodes,
      detail: `${invalidNodes} AX node or documented scalar value(s) had an invalid shape and were omitted`,
    });
  }
  if (nodeCuts > 0) {
    limitations.push({
      kind: "accessibility-snapshot-node-limit",
      count: nodeCuts,
      detail: `${nodeCuts} AX subtree root(s) were omitted after the ${limits.maxNodes}-node capture limit was reached`,
    });
  }
  if (depthCuts > 0) {
    limitations.push({
      kind: "accessibility-snapshot-depth-limit",
      count: depthCuts,
      detail: `${depthCuts} AX subtree root(s) deeper than level ${limits.maxDepth} were omitted`,
    });
  }
  if (valueCuts > 0) {
    limitations.push({
      kind: "accessibility-snapshot-value-limit",
      count: valueCuts,
      detail: `${valueCuts} AX string value(s) exceeded ${limits.maxValueChars} characters and were truncated`,
    });
  }
  return { tree, nodeCount, maxDepthObserved, limitations, error: null };
}

interface ScreenshotAttempt {
  bytes: Uint8Array | null;
  kind: "screenshot-capture-failed" | "screenshot-capture-empty" | null;
  detail: string | null;
}

const errorText = (err: unknown): string => String(err instanceof Error ? err.message : err).slice(0, 500);

async function shoot(page: PageLike): Promise<ScreenshotAttempt> {
  try {
    const out = await page.screenshot({ type: "png", fullPage: false, encoding: "binary" });
    let bytes: Uint8Array | null = null;
    if (out instanceof Uint8Array) bytes = out;
    else if (out instanceof ArrayBuffer) bytes = new Uint8Array(out);
    if (typeof out === "string") {
      const bin = atob(out);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    }
    if (!bytes || bytes.byteLength === 0) {
      return {
        bytes: null,
        kind: "screenshot-capture-empty",
        detail: "Puppeteer returned no PNG bytes for the viewport screenshot",
      };
    }
    return { bytes, kind: null, detail: null };
  } catch (err) {
    return { bytes: null, kind: "screenshot-capture-failed", detail: `Puppeteer screenshot failed: ${errorText(err)}` };
  }
}

function captureFailureRow(
  kind: ScreenCaptureFailure["kind"],
  detail: string,
  stepIndex: number,
  slot: string,
  at = new Date().toISOString(),
  count = 1,
): ScreenCaptureFailure {
  return { kind, detail, count, at, stepIndex, slot };
}

async function captureGeometry(
  page: PageLike,
  configured: { width: number; height: number },
): Promise<{ geometry: ScreenCaptureGeometry; failure: ScreenCaptureFailure | null }> {
  try {
    const raw = await page.evaluate(READ_CAPTURE_GEOMETRY);
    if (!plainObject(raw)) throw new Error("the page returned a non-object geometry payload");
    const number = (key: string, positive = false): number => {
      const value = raw[key];
      if (typeof value !== "number" || !Number.isFinite(value) || (positive && value <= 0)) {
        throw new Error(`${key} was not a ${positive ? "positive " : ""}finite number`);
      }
      return value;
    };
    return {
      geometry: {
        width: number("width", true),
        height: number("height", true),
        deviceScaleFactor: number("deviceScaleFactor", true),
        scrollX: number("scrollX"),
        scrollY: number("scrollY"),
        documentWidth: number("documentWidth", true),
        documentHeight: number("documentHeight", true),
        source: "browser",
      },
      failure: null,
    };
  } catch (err) {
    return {
      geometry: {
        width: configured.width,
        height: configured.height,
        deviceScaleFactor: null,
        scrollX: null,
        scrollY: null,
        documentWidth: null,
        documentHeight: null,
        source: "configured-fallback",
      },
      // step/slot are filled by the caller, which owns the epoch identity.
      failure: captureFailureRow("capture-metadata-failed", `viewport/scroll/DPR read failed: ${errorText(err)}`, 0, ""),
    };
  }
}

const captureIds = (epoch: ScreenCaptureEpoch): string[] => {
  const ids = [epoch.screenJson.evidenceId];
  if (epoch.screenshot.status === "captured") ids.push(epoch.screenshot.ref.evidenceId);
  if (epoch.accessibility.status === "captured") ids.push(epoch.accessibility.ref.evidenceId);
  return ids;
};

const screenshotIds = (epochs: ScreenCaptureEpoch[]): string[] =>
  epochs.flatMap((epoch) => (epoch.screenshot.status === "captured" ? [epoch.screenshot.ref.evidenceId] : []));

const epochFailures = (epochs: ScreenCaptureEpoch[]): ScreenCaptureFailure[] =>
  epochs.flatMap((epoch) => epoch.captureFailures);

const sumCaptureFailures = (failures: ScreenCaptureFailure[]): number =>
  failures.reduce((sum, failure) => sum + failure.count, 0);

const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

function settleSerializedBytes(payload: AccessibilitySnapshotArtifact): number {
  // `serializedBytes` is inside the bytes whose length it declares. Iterate until changing the
  // number no longer changes its own digit count; three passes is more than enough for that.
  let size = jsonBytes(payload);
  for (let i = 0; i < 3; i++) {
    payload.capture.serializedBytes = size;
    const next = jsonBytes(payload);
    if (next === size) return next;
    size = next;
  }
  payload.capture.serializedBytes = size;
  return jsonBytes(payload);
}

interface PreparedAccessibility {
  capturedAt: string;
  sanitized: SanitizedAccessibilitySnapshot | null;
  failure: ScreenCaptureFailure | null;
}

async function prepareAccessibility(
  page: PageLike,
  stepIndex: number,
  slot: string,
): Promise<PreparedAccessibility> {
  const at = new Date().toISOString();
  if (!page.accessibility || typeof page.accessibility.snapshot !== "function") {
    return {
      capturedAt: at,
      sanitized: null,
      failure: captureFailureRow(
        "accessibility-api-unavailable",
        "this browser adapter exposes no Puppeteer accessibility.snapshot API; absence is not an empty AX tree",
        stepIndex,
        slot,
        at,
      ),
    };
  }

  try {
    // Explicitly request the WHOLE Chrome tree. The default prunes nodes it calls
    // "uninteresting", which is useful for a screen reader and unsound for an absence claim.
    const liveSnapshot = await page.accessibility.snapshot({ interestingOnly: false });
    const capturedAt = new Date().toISOString();
    if (liveSnapshot === null) {
      return {
        capturedAt,
        sanitized: null,
        failure: captureFailureRow(
          "accessibility-snapshot-empty",
          "Chrome returned null for the full accessibility snapshot; this is a failed capture, not a tree with zero nodes",
          stepIndex,
          slot,
          capturedAt,
        ),
      };
    }
    // This call copies only the closed scalar allowlist + children. `liveSnapshot` (and its
    // `elementHandle()` methods) never leaves this block and is never passed to JSON.stringify.
    const sanitized = sanitizeAccessibilitySnapshot(liveSnapshot);
    if (!sanitized.tree || sanitized.error) {
      return {
        capturedAt,
        sanitized: null,
        failure: captureFailureRow(
          "accessibility-snapshot-failed",
          `Chrome AX snapshot could not be sanitised: ${sanitized.error ?? "no root node remained"}`,
          stepIndex,
          slot,
          capturedAt,
        ),
      };
    }
    return { capturedAt, sanitized, failure: null };
  } catch (err) {
    const capturedAt = new Date().toISOString();
    return {
      capturedAt,
      sanitized: null,
      failure: captureFailureRow(
        "accessibility-snapshot-failed",
        `Puppeteer accessibility.snapshot({ interestingOnly: false }) failed: ${errorText(err)}`,
        stepIndex,
        slot,
        capturedAt,
      ),
    };
  }
}

/**
 * Capture one logical screen epoch across all three modalities.
 *
 * Browser protocol calls are sequential, never falsely called atomic: `startedAt`/`endedAt`
 * bound that window. They are intentionally made before any R2 writes, so storage latency does
 * not widen the visual/AX pairing. Screen JSON remains the exact legacy payload and all new
 * references are additive.
 */
export async function captureScreenEpoch(
  page: PageLike,
  cap: CaptureContext,
  screen: RenderedScreen,
  slot: string,
  stepIndex: number,
  configuredViewport: { width: number; height: number },
): Promise<ScreenCaptureEpoch> {
  const startedAt = new Date().toISOString();
  // Opaque but reproducible for an idempotent re-capture. Question/options and wall-clock text
  // participate in the binding without leaking through filenames, logs or report metadata.
  const epochDigest = await sha256Hex(
    JSON.stringify([
      cap.runId,
      cap.attemptId,
      cap.pathId,
      stepIndex,
      slot,
      screen.at,
      screen.screenSignature,
    ]),
  );
  const epochId = `epoch_${epochDigest.slice(0, 24)}`;
  const screenSignatureHash = await sha256Hex(screen.screenSignature);
  const geometryAttempt = await captureGeometry(page, configuredViewport);
  if (geometryAttempt.failure) {
    geometryAttempt.failure.stepIndex = stepIndex;
    geometryAttempt.failure.slot = slot;
  }
  const screenshotAttempt = await shoot(page);
  const screenshotAttemptedAt = new Date().toISOString();
  const accessibilityPrepared = await prepareAccessibility(page, stepIndex, slot);
  // End the browser capture window before writing anything to evidence storage.
  const endedAt = new Date().toISOString();

  const screenJson = await captureScreenJsonRef(cap, screen, slot, stepIndex);

  let screenshot: ScreenCaptureEpoch["screenshot"];
  if (!screenshotAttempt.bytes || screenshotAttempt.kind) {
    screenshot = {
      status: "failed",
      failure: captureFailureRow(
        screenshotAttempt.kind ?? "screenshot-capture-empty",
        screenshotAttempt.detail ?? "Puppeteer returned no usable PNG bytes",
        stepIndex,
        slot,
        screenshotAttemptedAt,
      ),
    };
  } else {
    try {
      screenshot = { status: "captured", ref: await captureScreenshotRef(cap, screenshotAttempt.bytes, slot, stepIndex) };
    } catch (err) {
      screenshot = {
        status: "failed",
        failure: captureFailureRow(
          "screenshot-evidence-write-failed",
          `PNG was captured but its immutable evidence write failed: ${errorText(err)}`,
          stepIndex,
          slot,
          screenshotAttemptedAt,
        ),
      };
    }
  }

  let accessibility: ScreenCaptureEpoch["accessibility"];
  if (!accessibilityPrepared.sanitized?.tree || accessibilityPrepared.failure) {
    accessibility = {
      status: "failed",
      failure:
        accessibilityPrepared.failure ??
        captureFailureRow(
          "accessibility-snapshot-failed",
          "the sanitised Chrome accessibility snapshot had no root",
          stepIndex,
          slot,
          accessibilityPrepared.capturedAt,
        ),
    };
  } else {
    const original = accessibilityPrepared.sanitized;
    let effectiveMaxNodes = ACCESSIBILITY_CAPTURE_LIMITS.maxNodes;
    let sizeLimited = false;
    let payload: AccessibilitySnapshotArtifact;

    while (true) {
      const reLimited =
        effectiveMaxNodes < original.nodeCount
          ? sanitizeAccessibilitySnapshot(original.tree, {
              maxNodes: effectiveMaxNodes,
              maxDepth: ACCESSIBILITY_CAPTURE_LIMITS.maxDepth,
              maxValueChars: ACCESSIBILITY_CAPTURE_LIMITS.maxValueChars,
            })
          : original;
      if (!reLimited.tree) {
        throw new Error("capture: a valid sanitised AX root disappeared while applying the serialized-byte cap");
      }
      const limitations: ScreenCaptureFailure[] = [
        ...original.limitations.map((limitation) =>
          captureFailureRow(
            limitation.kind,
            limitation.detail,
            stepIndex,
            slot,
            accessibilityPrepared.capturedAt,
            limitation.count,
          ),
        ),
        ...(reLimited === original
          ? []
          : reLimited.limitations.map((limitation) =>
              captureFailureRow(
                limitation.kind,
                limitation.detail,
                stepIndex,
                slot,
                accessibilityPrepared.capturedAt,
                limitation.count,
              ),
            )),
      ];
      if (sizeLimited) {
        limitations.push(
          captureFailureRow(
            "accessibility-snapshot-size-limit",
            `the sanitised full AX payload exceeded ${ACCESSIBILITY_CAPTURE_LIMITS.maxSerializedBytes} bytes; ` +
              `the stored prefix is explicitly limited to ${effectiveMaxNodes} node(s)`,
            stepIndex,
            slot,
            accessibilityPrepared.capturedAt,
          ),
        );
      }
      payload = {
        kind: "v2-accessibility-snapshot/1.0.0",
        epochId,
        stepIndex,
        slot,
        scope: { kind: "viewport", tileIndex: null, tileCount: null },
        capturedAt: accessibilityPrepared.capturedAt,
        screenReadAt: screen.at,
        screenSignatureHash,
        geometry: geometryAttempt.geometry,
        pairing: {
          screenJson,
          screenshot: screenshot.status === "captured" ? screenshot.ref : null,
        },
        capture: {
          interestingOnly: false,
          completeness: limitations.length === 0 ? "complete" : "truncated",
          limitations,
          nodeCount: reLimited.nodeCount,
          maxDepthObserved: reLimited.maxDepthObserved,
          serializedBytes: 0,
          limits: {
            maxNodes: effectiveMaxNodes,
            maxDepth: ACCESSIBILITY_CAPTURE_LIMITS.maxDepth,
            maxValueChars: ACCESSIBILITY_CAPTURE_LIMITS.maxValueChars,
            maxSerializedBytes: ACCESSIBILITY_CAPTURE_LIMITS.maxSerializedBytes,
          },
        },
        tree: reLimited.tree,
      };
      const bytes = settleSerializedBytes(payload);
      if (bytes <= ACCESSIBILITY_CAPTURE_LIMITS.maxSerializedBytes || effectiveMaxNodes === 1) break;
      sizeLimited = true;
      effectiveMaxNodes = Math.max(1, Math.floor(Math.min(effectiveMaxNodes, reLimited.nodeCount) / 2));
    }

    // Adding the size-limit row itself can change the byte count by a few hundred bytes. Settle
    // once more and, in the pathological one-node case, fail rather than store over the cap.
    const finalBytes = settleSerializedBytes(payload!);
    if (finalBytes > ACCESSIBILITY_CAPTURE_LIMITS.maxSerializedBytes) {
      accessibility = {
        status: "failed",
        failure: captureFailureRow(
          "accessibility-snapshot-size-limit",
          `even a one-node sanitised AX payload was ${finalBytes} bytes, above the ` +
            `${ACCESSIBILITY_CAPTURE_LIMITS.maxSerializedBytes}-byte evidence cap; no partial artifact was stored`,
          stepIndex,
          slot,
          accessibilityPrepared.capturedAt,
        ),
      };
    } else {
      try {
        const ref = await captureAccessibilitySnapshot(cap, payload!, slot, stepIndex);
        accessibility = {
          status: "captured",
          ref,
          completeness: payload!.capture.completeness,
          limitations: payload!.capture.limitations,
        };
      } catch (err) {
        accessibility = {
          status: "failed",
          failure: captureFailureRow(
            "accessibility-evidence-write-failed",
            `AX tree was captured and sanitised but its immutable evidence write failed: ${errorText(err)}`,
            stepIndex,
            slot,
            accessibilityPrepared.capturedAt,
          ),
        };
      }
    }
  }

  const captureFailures: ScreenCaptureFailure[] = [
    ...(geometryAttempt.failure ? [geometryAttempt.failure] : []),
    ...(screenshot.status === "failed" ? [screenshot.failure] : []),
    ...(accessibility.status === "failed" ? [accessibility.failure] : accessibility.limitations),
  ];
  return {
    kind: "v2-screen-capture-epoch/1.0.0",
    epochId,
    stepIndex,
    slot,
    // Declared by this adapter because `shoot()` requested `fullPage: false`; consumers must
    // read this field rather than inherit that implementation convention.
    scope: { kind: "viewport", tileIndex: null, tileCount: null },
    startedAt,
    endedAt,
    screenReadAt: screen.at,
    screenSignatureHash,
    geometry: geometryAttempt.geometry,
    screenJson,
    screenshot,
    accessibility,
    captureFailures,
    captureFailureCount: sumCaptureFailures(captureFailures),
  };
}

/**
 * CAN A RESPONDENT ANSWER WITH THIS OPTION?
 *
 * THE DEFECT THIS EXISTS TO CLOSE. The navigator's default answered each group with the first
 * option passing `visible && !disabled`. MEASURED on an eleven-point NPS scale drawn as
 * `opacity:0; width:1px` radios inside their labels: every 0-10 option fails `visible`, so the
 * only reachable answer was the twelfth, "Don't know / no usual brand" — recorded in 2 of 2
 * walks. Not unlikely: STRUCTURALLY IMPOSSIBLE. Any route or requirement keyed on a score was
 * unreachable, and the coverage report still said the screen was answered.
 *
 * Dropping the filter is the wrong repair — it starts clicking honeypots and `display:none`
 * alternate layouts a respondent cannot touch. So the question asked is the respondent's:
 * `operable` (see page-script `actuationOf`) is true when the control is drawn itself, or when
 * a <label> that ACTIVATES it is drawn and not covered.
 *
 * `?? o.visible` is deliberate: a screen read by an older reader has no `operable` field, and
 * that must degrade to the old behaviour rather than to "everything is answerable".
 */
function answerable(o: { visible: boolean; disabled: boolean; operable?: boolean }): boolean {
  return !o.disabled && (o.operable ?? o.visible);
}

/**
 * Click a control by its index in the reader's order.
 *
 * ACTUATION FOLLOWS THE READER'S OWN VERDICT. A control the reader marked `actuatedVia:
 * "label"` is not clickable where it is — it is one transparent pixel — so the click goes to
 * the <label> that activates it, which is the thing the respondent clicks. That is the route
 * measured to work: 5 of 5 walks selected a 0-10 NPS radio through its label on local Chromium.
 * (One engine, Kitesurf, does NOT propagate a synthetic click from a label to the hidden input
 * it labels — a fidelity difference recorded in bakeoff/NOTES.md §8, not something this can fix.)
 *
 * Every route is named in `detail`, so "clicked it directly" and "clicked its label" are never
 * confusable after the fact.
 */
async function clickIdx(
  page: PageLike,
  idx: number,
  via?: { actuatedVia?: "self" | "label" | "none"; labelIndex?: number | null } | null,
): Promise<{ ok: boolean; detail: string }> {
  if (via && via.actuatedVia === "label" && typeof via.labelIndex === "number" && via.labelIndex >= 0) {
    try {
      const labels = await page.$$(LABEL_SELECTOR);
      const lh = labels[via.labelIndex];
      if (lh) {
        await lh.click();
        return { ok: true, detail: `label-click(label[${via.labelIndex}]) — control is not drawn` };
      }
    } catch (err) {
      // Fall through to the control itself; the failure is named on the way past.
      try {
        const ok = await page.evaluate(
          `(() => { const l = document.querySelectorAll(${JSON.stringify(LABEL_SELECTOR)})[${via.labelIndex}]; ` +
            `if (!l) return false; l.click(); return true; })()`,
        );
        if (ok === true) {
          return { ok: true, detail: `dom-label-click(label[${via.labelIndex}]) (${String(err).slice(0, 100)})` };
        }
      } catch {
        /* fall through to the control itself */
      }
    }
  }
  try {
    const handles = await page.$$(CONTROL_SELECTOR);
    const h = handles[idx];
    if (!h) return { ok: false, detail: "no-control-at-index" };
    await h.click();
    return { ok: true, detail: "element-click" };
  } catch (err) {
    // A control that is off-screen or overlapped still has to be exercisable; falling
    // back to an in-page click is recorded so a reader can tell the two apart.
    try {
      await page.evaluate(`(() => { const e = document.querySelectorAll(${JSON.stringify(
        CONTROL_SELECTOR,
      )})[${idx}]; if (!e) return false; e.click(); return true; })()`);
      return { ok: true, detail: `dom-click-fallback (${String(err).slice(0, 120)})` };
    } catch (err2) {
      return { ok: false, detail: String(err2).slice(0, 200) };
    }
  }
}

/**
 * Type a value with real keystrokes — AND READ BACK WHAT THE CONTROL KEPT.
 *
 * THE READBACK IS THE POINT, not a nicety. `<input type=number>` and the date family run every
 * assignment and every keystroke through HTML's value-sanitisation algorithm and DISCARD
 * anything they cannot parse, silently and with no error to catch: the harness typed
 * "QA-PROBE", the field stayed empty, and the record said the field had been filled. That is a
 * confident wrong answer manufactured by the harness. So the value the control actually holds
 * afterwards is observed, and `discarded` is returned rather than inferred.
 */
async function typeIdx(
  page: PageLike,
  idx: number,
  value: string,
): Promise<{ ok: boolean; detail: string; discarded?: boolean; got?: string }> {
  try {
    await page.evaluate(clearValueScript(idx));
    if (value.length === 0) return { ok: true, detail: "cleared" };
    const handles = await page.$$(CONTROL_SELECTOR);
    const h = handles[idx];
    if (!h) return { ok: false, detail: "no-control-at-index" };
    await h.click();
    await h.type(value, { delay: 8 });
    const got = await readValueAt(page, idx);
    // Only the UNAMBIGUOUS discard is reported: we asked for something and the control kept
    // nothing. A control that trimmed, truncated or reformatted the value still took it, and
    // calling that a rejection would flood the record with noise.
    if (got !== null && got.length === 0) {
      return { ok: true, detail: `keyboard-type — the control DISCARDED "${value}" and holds ""`, discarded: true, got };
    }
    return { ok: true, detail: "keyboard-type", discarded: false, got: got ?? undefined };
  } catch (err) {
    return { ok: false, detail: String(err).slice(0, 200) };
  }
}

/** What does control #idx hold right now? Null when it cannot be read at all. */
async function readValueAt(page: PageLike, idx: number): Promise<string | null> {
  try {
    const out = await page.evaluate(
      `(() => { const e = document.querySelectorAll(${JSON.stringify(CONTROL_SELECTOR)})[${idx}]; ` +
        `return e && 'value' in e ? String(e.value == null ? '' : e.value) : null; })()`,
    );
    return typeof out === "string" ? out : null;
  } catch {
    return null;
  }
}

/**
 * Read the native choice state the page RETAINED after a click. The group is scoped by native
 * type, exact name, and form owner; a same-named radio in another form is not this receipt.
 * Null is counter-evidence (the click transport returned but the state could not be observed),
 * never an inferred success.
 */
async function readChoiceAt(
  page: PageLike,
  idx: number,
): Promise<NonNullable<PerformedAction["choiceReadback"]> | null> {
  try {
    const out = await page.evaluate(
      `(() => { /* W4_NATIVE_CHOICE_SCOPED_READBACK */ ` +
        `const SEL = ${JSON.stringify(CONTROL_SELECTOR)}; const expectedIdx = ${JSON.stringify(idx)}; ` +
        `const nodes = Array.from(document.querySelectorAll(SEL)); const el = nodes[expectedIdx]; ` +
        `if (!el) return null; const type = String(el.type || '').toLowerCase(); ` +
        `if (type !== 'radio' && type !== 'checkbox') return null; ` +
        `const name = String(el.name || ''); const same = name ? nodes.filter((candidate) => ` +
        `String(candidate.type || '').toLowerCase() === type && String(candidate.name || '') === name && ` +
        `candidate.form === el.form) : [el]; ` +
        `const formOwner = el.form ? Array.prototype.indexOf.call(document.forms || [], el.form) : null; ` +
        `return { idx: expectedIdx, type, name: name || null, formOwner: formOwner >= 0 ? formOwner : null, ` +
        `unnamedControlIdx: name ? null : expectedIdx, checked: !!el.checked, ` +
        `checkedGroupIdxs: same.map((candidate) => nodes.indexOf(candidate)).filter((ownIdx) => ownIdx >= 0 && !!nodes[ownIdx].checked) }; })()`,
    );
    if (!out || typeof out !== "object" || Array.isArray(out)) return null;
    const got = out as Record<string, unknown>;
    if (got.idx !== idx || (got.type !== "radio" && got.type !== "checkbox") || typeof got.checked !== "boolean") return null;
    if (got.name !== null && typeof got.name !== "string") return null;
    if (got.formOwner !== undefined && got.formOwner !== null && !Number.isSafeInteger(got.formOwner)) return null;
    if (got.unnamedControlIdx !== undefined && got.unnamedControlIdx !== null && !Number.isSafeInteger(got.unnamedControlIdx)) return null;
    if (!Array.isArray(got.checkedGroupIdxs) || !got.checkedGroupIdxs.every((v) => Number.isSafeInteger(v) && Number(v) >= 0)) return null;
    return {
      idx,
      type: got.type,
      name: got.name as string | null,
      formOwner: (got.formOwner ?? null) as number | null,
      unnamedControlIdx: (got.unnamedControlIdx ?? null) as number | null,
      checked: got.checked,
      checkedGroupIdxs: [...new Set(got.checkedGroupIdxs as number[])],
    };
  } catch {
    return null;
  }
}

export function exactChoiceReadback(
  idx: number,
  type: string,
  got: PerformedAction["choiceReadback"],
  expected?: {
    name?: string | null;
    formOwner?: number | null;
    identity?: {
      type: "radio" | "checkbox";
      name: string | null;
      formOwner: number | null;
      unnamedControlIdx: number | null;
    };
  } | null,
): boolean {
  if (!got || got.idx !== idx || got.type !== type || !got.checked || !got.checkedGroupIdxs.includes(idx)) return false;
  const identity = expected?.identity ?? (expected && Object.prototype.hasOwnProperty.call(expected, "formOwner")
    ? {
        type: type as "radio" | "checkbox",
        name: expected.name ?? null,
        formOwner: expected.formOwner ?? null,
        unnamedControlIdx: (expected.name ?? null) === null ? idx : null,
      }
    : null);
  if (identity && (
    got.type !== identity.type ||
    got.name !== identity.name ||
    got.formOwner !== identity.formOwner ||
    got.unnamedControlIdx !== identity.unnamedControlIdx
  )) return false;
  return type !== "radio" || (got.checkedGroupIdxs.length === 1 && got.checkedGroupIdxs[0] === idx);
}

const choiceReceiptDetail = (
  detail: string,
  idx: number,
  type: string,
  got: PerformedAction["choiceReadback"],
  expected?: Parameters<typeof exactChoiceReadback>[3],
): string =>
  `${detail}; ${exactChoiceReadback(idx, type, got, expected) ? "exact-choice-readback" : "choice-readback-unavailable-or-mismatched"}`;

/**
 * Set a value on a control that cannot be typed into — see `page-script.ts#setValueScript` for
 * why a slider and a date picker need this route and keystrokes will not do.
 */
async function setIdx(
  page: PageLike,
  idx: number,
  value: string,
): Promise<{ ok: boolean; detail: string; discarded?: boolean; got?: string }> {
  try {
    const out = (await page.evaluate(setValueScript(idx, value))) as
      | { ok?: boolean; reason?: string | null; got?: string | null }
      | null;
    if (!out || typeof out !== "object") return { ok: false, detail: "set-value returned nothing" };
    if (out.ok === true) return { ok: true, detail: "set-value(+input,+change)", discarded: false, got: out.got ?? undefined };
    return {
      ok: false,
      detail: `set-value rejected: ${out.reason ?? "unknown"} — the control holds "${out.got ?? ""}"`,
      discarded: true,
      got: out.got ?? undefined,
    };
  } catch (err) {
    return { ok: false, detail: String(err).slice(0, 200) };
  }
}

type NativeSelectOption = NonNullable<ControlState["options"]>[number];

/** Exact means exact code, or exact rendered label after whitespace folding. No containment. */
function exactSelectOptionMatch(option: NativeSelectOption, requested: string): boolean {
  const wanted = String(requested);
  const clean = (s: string): string => s.replace(/\s+/g, " ").trim();
  return option.code === wanted || clean(option.label) === clean(wanted);
}

function usableSelectOption(option: NativeSelectOption): boolean {
  return !option.disabled && option.hidden !== true && option.placeholder !== true;
}

/**
 * Actuate one native select by its reader index and retain the exact post-action state.
 * `out.ok` is not trusted on its own: missing or mismatched readback is a failed action.
 */
async function selectOptionIdx(
  page: PageLike,
  control: ControlState,
  option: NativeSelectOption,
): Promise<{
  ok: boolean;
  detail: string;
  readback: { order: number; code: string; label: string } | null;
}> {
  try {
    const out = (await page.evaluate(selectOptionScript(control.idx, option))) as
      | {
          ok?: boolean;
          reason?: string | null;
          changed?: boolean;
          got?: { order?: unknown; code?: unknown; label?: unknown } | null;
        }
      | null;
    const got =
      out && out.got && typeof out.got === "object" && Number.isInteger(out.got.order) &&
      typeof out.got.code === "string" && typeof out.got.label === "string"
        ? { order: Number(out.got.order), code: out.got.code, label: out.got.label }
        : null;
    const exact =
      out?.ok === true &&
      got !== null &&
      got.order === option.order &&
      got.code === option.code &&
      got.label === option.label;
    if (!exact) {
      return {
        ok: false,
        detail:
          `native-select failed exact post-action readback (${out?.reason ?? "missing-readback"})` +
          (got ? ` — got order=${got.order} code=${JSON.stringify(got.code)} label=${JSON.stringify(got.label)}` : ""),
        readback: got,
      };
    }
    return {
      ok: true,
      detail: `${out?.changed === false ? "already-selected" : "native-selected-index"}+input+change+exact-readback`,
      readback: got,
    };
  } catch (err) {
    return { ok: false, detail: `native-select threw: ${String(err).slice(0, 180)}`, readback: null };
  }
}

/**
 * THE FILLER THE WALKER TYPES WHEN THE PLAN ASKED FOR NOTHING — and why it is not one string.
 *
 * THE DEFECT THIS EXISTS TO CLOSE, measured on two of the four live medical instruments. The
 * default was the literal `PROBE_TEXT`, "QA-PROBE", typed into every free-text control. Screen 1
 * of the oncology and rheumatoid-arthritis instruments carries `<input type="number" min="0"
 * max="50">`; a number input silently refuses non-numeric text, the site answered "Invalid
 * input", the survey would not advance, and the walk ended `outcome: "blocked"` ON SCREEN 1 —
 * which downstream reads as THE SURVEY REJECTING AN ANSWER. A confident wrong answer about a
 * working survey, produced entirely by the harness typing letters into a number box.
 *
 * So a numeric control gets a number, inside the bounds THE SITE ITSELF declares. The bounds are
 * the site's, never the document's: this is a filler chosen to get past a screen the plan had no
 * opinion about, and it is recorded as `navigator-default` so it can never be mistaken for a
 * documented answer under test. A control the site gives no bounds for gets `1`, which is inside
 * every non-negative range and is a guess about NOTHING except its own type.
 */
const num = (s: string | null | undefined): number | null => {
  if (s === null || s === undefined || String(s).trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Kill float noise from `min + step * k` — `0.1 + 0.2 * 3` must print as `0.7`, not `0.7000000000000001`. */
const tidy = (n: number): string => String(Number(n.toPrecision(12)));

/**
 * THE LEAST-COMMITTED VALUE IN A RANGE THE SITE ITSELF DECLARES — the midpoint, snapped to the
 * site's own step grid.
 *
 * THE DEFECT THIS EXISTS TO CLOSE, and it is the one MEASURED on the live branching fleet. The
 * numeric filler was "the lowest legal value": `1`, raised to `min` when `min` was higher. That
 * is not a neutral choice — IT IS A BOUNDARY PROBE, and a screener's whole job is to cut at the
 * boundary. Two of the six live surveys screened the walk out on the harness's own filler:
 *
 *     s2-screener  S1 "What is your age?"  min=0 max=99, terminate if < 18  -> answered 1
 *     s6-kitchen-sink  S2 "years treating RA"  min=0 max=50, terminate if < 2  -> answered 1
 *
 * s2 stopped after two screens with `ending: screened-out`, and the clean/flawed experiment that
 * depended on it returned 0 of 3 seeded defects. Nothing was broken; the walker had volunteered
 * that it was one year old.
 *
 * The midpoint is defensible without knowing anything about the question: with no information,
 * the centre of the declared range is the value that commits to least, and an extreme should
 * only ever be chosen ON PURPOSE by a boundary probe the plan asked for.
 *
 * IT IS STILL A GUESS, AND IT IS NOT TUNED TO THIS CORPUS — the honest counterexample is in the
 * same survey: s2's S4 declares min=0 max=31 and terminates at >= 15, so the midpoint (15) is
 * screened out too. No constant passes every screener, and a value picked because it happened to
 * clear this corpus's thresholds would be exactly the hard-anchoring CLAUDE.md forbids. What
 * makes that acceptable is the other half of this change: the walk NAMES how many of its answers
 * it invented, so a screen-out reached on a filler can never be read as a fact about the survey.
 *
 * The step grid is the site's, not ours: HTML's default step for `number` and `range` is 1, so a
 * midpoint of 0..99 is 50 and never 49.5 — a fraction the branching engine rejects with "Please
 * enter a whole number." `step="any"` disables the grid, which is the one case a fraction is
 * legal. Returns null when there is no range to take the middle of.
 */
function stepAlignedMidpoint(
  c: { type: string; min?: string | null; max?: string | null; step?: string | null },
): { value: string; how: string } | null {
  const lo = num(c.min);
  const hi = num(c.max);
  // A `range` has a range even when the site declares none: HTML's defaults are 0..100 step 1.
  const isRange = c.type === "range";
  const effLo = lo ?? (isRange ? 0 : null);
  const effHi = hi ?? (isRange ? 100 : null);
  if (effLo === null || effHi === null || !(effHi > effLo)) return null;

  const mid = effLo + (effHi - effLo) / 2;
  const rawStep = String(c.step ?? "").trim().toLowerCase();
  // `step="any"` is the site saying "no grid" — the only case a fractional midpoint is legal.
  const stepped = rawStep === "any" ? null : (num(c.step) ?? 1);
  if (stepped === null || !(stepped > 0)) {
    return { value: tidy(mid), how: `midpoint of the site's declared ${effLo}..${effHi} (step="any", so no grid)` };
  }
  // The step BASE is `min` where the site declares one — the same anchor constraint validation
  // uses — so a control declaring min=3 step=0.5 is offered 3, 3.5, 4… and never 3.25.
  let v = effLo + stepped * Math.round((mid - effLo) / stepped);
  if (v > effHi) v -= stepped;
  if (v < effLo) v = effLo;
  const declared = lo === null || hi === null ? `HTML's default 0..100 for a range` : `the site's declared ${effLo}..${effHi}`;
  return { value: tidy(v), how: `midpoint of ${declared}, snapped to its own step of ${stepped}` };
}

/**
 * THE RETRY'S NUMERIC FILLER — a SEPARATE code path from `stepAlignedMidpoint`, on purpose.
 *
 * The midpoint is PINNED, honest counterexample and all (d44 asserts that 0..31 midpoints to
 * 16 and STAYS screened out on s2's S4; `mutate-input-coverage.mjs` kills constant retuning):
 * retuning it to dodge a screener is the hard-anchoring CLAUDE.md forbids. What the bounded
 * screen-out retry needs is not a better constant — no constant passes every screener — but a
 * DIFFERENT deterministic point on the same declared range for the re-walk. Variant 1 takes
 * the 25% quantile, variant 2 the 75%: one probe below the middle, one above, which between
 * them straddle any single threshold the midpoint sat on the wrong side of.
 *
 * Same discipline as the midpoint, reusing the same arithmetic building blocks (`num`,
 * `tidy`, min-anchored grid snap, clamp into the declared bounds): the range is the SITE'S,
 * the grid is the SITE'S, and the value is recorded as a `navigator-default` under a
 * `retry-N` tag so it can never be mistaken for a documented answer.
 */
export function variantQuantile(variant: number): number {
  return variant === 1 ? 0.25 : 0.75;
}

export function stepAlignedQuantile(
  c: { type: string; min?: string | null; max?: string | null; step?: string | null },
  quantile: number,
): { value: string; how: string } | null {
  const lo = num(c.min);
  const hi = num(c.max);
  const isRange = c.type === "range";
  const effLo = lo ?? (isRange ? 0 : null);
  const effHi = hi ?? (isRange ? 100 : null);
  if (effLo === null || effHi === null || !(effHi > effLo)) return null;

  const point = effLo + (effHi - effLo) * quantile;
  const pct = Math.round(quantile * 100);
  const rawStep = String(c.step ?? "").trim().toLowerCase();
  // `step="any"` is the site saying "no grid" — the one case a fractional value is legal.
  const grid = rawStep === "any" ? null : (num(c.step) ?? 1);
  if (grid === null || !(grid > 0)) {
    return { value: tidy(point), how: `the ${pct}% point of the site's declared ${effLo}..${effHi} (step="any", so no grid)` };
  }
  // Min-anchored, exactly like the midpoint: the same base constraint validation uses.
  let v = effLo + grid * Math.round((point - effLo) / grid);
  if (v > effHi) v -= grid;
  if (v < effLo) v = effLo;
  return { value: tidy(v), how: `the ${pct}% point of the site's declared ${effLo}..${effHi}, snapped to its own step of ${grid}` };
}

/** ISO date helpers for the date family. Fixed, neutral, and inside every plausible range. */
const NEUTRAL_DATE = "2000-01-15";

/**
 * THE VALUE THE WALKER SUPPLIES WHEN THE PLAN ASKED FOR NOTHING — one rule per type, and the
 * route each type actually accepts.
 *
 * THE COVERAGE GAP THIS CLOSES, MEASURED in Chrome rather than assumed (the probe is in the
 * report). The driver filled four types. Of everything else a respondent can answer:
 *
 *   - `tel` `url` `search`      never filled; they hold typed text perfectly well.
 *   - `range` `date` `time`     never filled, and they CANNOT be: assigning "QA-PROBE" to any of
 *     `month` `week`            them is discarded by value sanitisation, and a range ignores
 *     `datetime-local` `color`  keystrokes entirely. They need the value SET — see
 *                               `page-script.ts#setValueScript`.
 *   - `email`                   filled, but with "QA-PROBE" — which STICKS in `.value` and then
 *                               fails the control's own constraint validation, so a `required`
 *                               email field blocks the submit and the survey gets the blame.
 *   - `password` `file`         must never be silently skipped: they are REFUSED and NAMED.
 *
 * NOT A GAP, and worth writing down because it looks like one: `<input>` with no type, and
 * `<input type="totally-bogus">`, both reflect `el.type === "text"` (measured), so the reader has
 * always classified them as text and the driver has always filled them.
 *
 * The plan always wins — this is only the navigator-default path, and every value it produces is
 * recorded as `navigator-default` so it can never be mistaken for a documented answer under test.
 * Returns null when this harness has no rule for the type, which the caller reports as
 * `no-derivation` rather than passing over in silence.
 */
export interface NavigatorValue {
  value: string;
  /** How it was derived, verbatim, for the action record. */
  how: string;
  /** `type` delivers keystrokes; `set` assigns and dispatches input/change. */
  via: "type" | "set";
}

export function navigatorValueFor(
  c: {
    type: string;
    min?: string | null;
    max?: string | null;
    step?: string | null;
  },
  /**
   * BOUNDED SCREEN-OUT RETRY (see WalkOptions.variant): 0 keeps every rule below
   * byte-identical; 1/2 move ONLY the ranged number/range fillers to the 25%/75% quantile
   * of the same declared range (`stepAlignedQuantile` — the midpoint itself is pinned and
   * untouched). Types with a single fixed neutral value, and numbers with fewer than two
   * bounds, have no range to vary across and deliberately return their variant-0 value.
   */
  variant = 0,
): NavigatorValue | null {
  const t = String(c.type ?? "").toLowerCase();
  switch (t) {
    case "text":
    case "textarea":
    case "search":
      return { value: PROBE_TEXT, how: "the harness's probe text", via: "type" };
    // A SYNTACTICALLY VALID address, not the probe text. "QA-PROBE" is accepted into an
    // `<input type=email>`'s value and then fails its constraint validation, so a required email
    // field blocked the submit and the survey was recorded as rejecting the answer.
    // `example.com` is reserved by RFC 2606 and cannot belong to anyone.
    case "email":
      return { value: "qa-probe@example.com", how: "a syntactically valid address on the RFC 2606 reserved domain", via: "type" };
    case "url":
      return { value: "https://example.com/qa-probe", how: "a syntactically valid URL on the RFC 2606 reserved domain", via: "type" };
    // The NANP 555-0100..555-0199 block is reserved for fiction and reaches nobody.
    case "tel":
      return { value: "+15555550100", how: "a reserved fictitious number (NANP 555-01xx)", via: "type" };
    case "number": {
      const mid = stepAlignedMidpoint(c);
      // The retry's variant: a different deterministic point on the SAME declared range,
      // tagged `retry-N` so the counted `navigator-default:` detail names which pivot
      // chose it. Falls through to the pinned midpoint when there is no range to vary.
      if (variant > 0) {
        const q = stepAlignedQuantile(c, variantQuantile(variant));
        if (q) return { value: q.value, how: `retry-${variant}:${q.how}`, via: "type" };
      }
      if (mid) return { value: mid.value, how: mid.how, via: "type" };
      // A midpoint needs TWO ends. With one bound or none there is no middle, so this keeps the
      // long-standing "1, raised or lowered into whatever bound exists" — a guess about nothing
      // except the control's own type.
      const lo = num(c.min);
      const hi = num(c.max);
      let v = 1;
      if (lo !== null && v < lo) v = lo;
      if (hi !== null && v > hi) v = lo !== null ? lo : hi;
      return {
        value: tidy(v),
        how: lo === null && hi === null
          ? "1 — the site declares no bounds, so there is no range to take the middle of"
          : "1, moved into the single bound the site declares (a midpoint needs two ends)",
        via: "type",
      };
    }
    // SET, never typed: a range answers to arrow keys and pointer drags, not to inserted text.
    case "range": {
      const mid = stepAlignedMidpoint(c);
      // Same retry variant as `number` above; a range always has a range (HTML defaults).
      if (variant > 0) {
        const q = stepAlignedQuantile(c, variantQuantile(variant));
        if (q) return { value: q.value, how: `retry-${variant}:${q.how}`, via: "set" };
      }
      return mid ? { value: mid.value, how: mid.how, via: "set" } : null;
    }
    case "date":
      return { value: dateMidpoint(c) ?? NEUTRAL_DATE, how: dateMidpoint(c) ? "midpoint of the site's declared date range" : "a fixed neutral date, the site declaring no range", via: "set" };
    case "month":
      return { value: "2000-01", how: "a fixed neutral month", via: "set" };
    case "week":
      return { value: "2000-W03", how: "a fixed neutral ISO week", via: "set" };
    case "time":
      return { value: "12:00", how: "a fixed neutral time", via: "set" };
    case "datetime-local":
      return { value: `${NEUTRAL_DATE}T12:00`, how: "a fixed neutral local date-time", via: "set" };
    case "color":
      return { value: "#808080", how: "a fixed neutral colour", via: "set" };
    default:
      return null;
  }
}

/** The middle of a declared `min`..`max` on a date control, or null when it declares neither. */
function dateMidpoint(c: { min?: string | null; max?: string | null }): string | null {
  const lo = c.min ? Date.parse(`${c.min}T00:00:00Z`) : NaN;
  const hi = c.max ? Date.parse(`${c.max}T00:00:00Z`) : NaN;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return null;
  const mid = new Date(lo + Math.floor((hi - lo) / 2));
  return mid.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------------------------------
 * CONSTANT-SUM ("allocation") GROUPS — the wall the reach baseline measured.
 *
 * MEASURED (reach baseline, 2026-08-10/11): 3 of 12 fleet walks hard-blocked at a "must sum to
 * exactly 100" grid (s5-allocation Q1, s6-kitchen-sink Q6 twice), gating ~24 screens. Every one
 * is table-rendered with ONE number input per row and ZERO header labels; the per-control
 * filler wrote 1 into each of 5 independent inputs, the site echoed "Values must sum to exactly
 * 100 (current total: 5)", and the recovery pass re-derived byte-identical values — a
 * deterministic, terminal block.
 *
 * DETECTION IS STRUCTURAL + CONSERVATIVE, and both halves are required: >= 2 operable, writable
 * number inputs hosted in one grid or sharing a non-empty name prefix, AND a sum target read
 * from THE SITE'S OWN declarations. A wrong sum guess typed into a screen that never asked for
 * one is worse than today's named failure, so no confident target means DO NOTHING and the
 * per-control midpoints run exactly as before.
 */

export interface AllocationMember {
  idx: number;
  label: string;
  min?: string | null;
  max?: string | null;
  step?: string | null;
  /** What the control holds right now — lets a group that already sums to T be left alone. */
  value?: string | null;
  required?: boolean;
}

export interface AllocationGroup {
  /** The total the site itself declares the group must sum to. */
  total: number;
  /** WHERE the total was read, quoting the site's own words — travels into the action detail. */
  targetSource: string;
  /** The member inputs, in DOM order. */
  members: AllocationMember[];
}

/**
 * Phrases that STATE a total. Deliberately narrow: each requires a sum-verb immediately before
 * the number ("must sum to exactly 100", "must total 100", "adds up to 100", "Allocate 100
 * points", "out of 100"). `visibleText` is NEVER scanned — the fleet's allocation tables render
 * a live "Total 0" mirror row in body text, and its 0 would conflict with the declared 100.
 */
const SUM_TARGET_RES: readonly RegExp[] = [
  /(?:sum|total|add(?:s)?\s+up)\s*(?:(?:up\s+)?to\s+)?(?:exactly\s+)?(\d+(?:\.\d+)?)/gi,
  /(?:allocate|distribute|divide|split)\s+(\d+(?:\.\d+)?)/gi,
  /out\s+of\s+(?:a\s+total\s+of\s+)?(\d+(?:\.\d+)?)/gi,
];

/** Sum LANGUAGE without a number — corroboration only, for the shared-max fallback. */
const SUM_WORDING_RE = /(total|sum|adds?\s+up|allocate|distribute|100\s*%|out\s+of\s+\d+)/i;

/**
 * The declared total for a candidate group, or null when the screen does not state one
 * confidently. Sources, in order:
 *
 *   1. An EXPLICIT number in the question text, the instruction text, or the site's own
 *      validation echo after a blocked submit ("Points must sum to exactly 100 (current
 *      total: 5)" — the echo is how the RECOVERY pass learns the target when the instruction
 *      never stated it). The echo's "current total: N" is the site reporting the walker's own
 *      wrong sum, never a target, so it is stripped before scanning. Different numbers from
 *      different sources mean the screen has not declared ONE total: abstain.
 *   2. A per-input max EVERY member shares, corroborated by sum wording on the screen. This is
 *      deliberately SECOND: an equal per-row cap is a cap, not a total (five inputs capped at
 *      20 under "must sum to exactly 100" total 100, not 20), so an explicit statement always
 *      wins.
 */
function readSumTarget(
  screen: RenderedScreen,
  members: AllocationMember[],
): { total: number; source: string } | null {
  const texts: Array<[string, string]> = [
    ["the question text", screen.questionText ?? ""],
    ["the instruction text", screen.instructionText ?? ""],
    ["the site's validation message", (screen.validationMessages ?? []).join(" | ")],
  ];
  const found: Array<{ total: number; where: string; quote: string }> = [];
  for (const [where, raw] of texts) {
    if (!raw) continue;
    const text = raw.replace(/current\s+total\s*:?\s*\d+(?:\.\d+)?/gi, " ");
    for (const re of SUM_TARGET_RES) {
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const total = Number(m[1]);
        if (Number.isFinite(total) && total > 0) found.push({ total, where, quote: m[0] });
      }
    }
  }
  const totals = new Set(found.map((f) => f.total));
  if (totals.size === 1) {
    const f = found[0]!;
    return { total: f.total, source: `${f.where} ("${f.quote.trim()}")` };
  }
  if (totals.size > 1) return null; // the site names two different totals — not confident
  const maxes = members.map((m) => num(m.max));
  const shared = maxes[0] ?? null;
  if (shared !== null && shared > 0 && maxes.every((v) => v === shared)) {
    const context = `${screen.questionText ?? ""} ${screen.instructionText ?? ""}`;
    if (SUM_WORDING_RE.test(context)) {
      return {
        total: shared,
        source: `the max="${tidy(shared)}" every input shares, corroborated by the screen's sum wording`,
      };
    }
  }
  return null;
}

/**
 * The constant-sum groups on this screen. Empty unless BOTH halves hold: structure (>= 2
 * writable, operable number inputs in one grid or one name-prefix family) and a confidently
 * readable target (see readSumTarget).
 */
export function allocationGroups(screen: RenderedScreen): AllocationGroup[] {
  // Writable AND operable: a readonly "Total" mirror is not a member, and neither is a
  // honeypot or an input in a display:none alternate layout.
  const candidates = screen.controls.filter(
    (c) =>
      String(c.type).toLowerCase() === "number" &&
      c.visible &&
      !c.disabled &&
      !c.readOnly &&
      (c.operable ?? c.visible),
  );
  if (candidates.length < 2) return [];

  const lists: ControlState[][] = [];
  const used = new Set<number>();

  // (a) hosted in one grid — the fleet shape: a table with one number input per row. Keyed off
  // input TYPE, never screen shape: radio grids have no number inputs and are untouched.
  if (screen.grid) {
    const gridIdxs = new Set<number>();
    for (const row of screen.grid.rows) for (const cell of row.cells) gridIdxs.add(cell.idx);
    const inGrid = candidates.filter((c) => gridIdxs.has(c.idx));
    if (inGrid.length >= 2) {
      lists.push(inGrid);
      for (const c of inGrid) used.add(c.idx);
    }
  }

  // (b) a shared name prefix ("q7_1"…"q7_4", "alloc[1]"…): digit runs collapsed, and the
  // residue must still say something — inputs named "1" and "2" share only digits, which is
  // no family at all. Unnamed inputs can only group through a grid.
  const byPrefix = new Map<string, ControlState[]>();
  for (const c of candidates) {
    if (used.has(c.idx) || !c.name) continue;
    const prefix = c.name.replace(/\d+/g, "#");
    if (!/[a-z]/i.test(prefix)) continue;
    const list = byPrefix.get(prefix) ?? [];
    list.push(c);
    byPrefix.set(prefix, list);
  }
  for (const list of byPrefix.values()) if (list.length >= 2) lists.push(list);

  const out: AllocationGroup[] = [];
  for (const list of lists) {
    const members: AllocationMember[] = [...list]
      .sort((a, b) => a.idx - b.idx)
      .map((c) => ({
        idx: c.idx,
        label: c.label,
        min: c.min ?? null,
        max: c.max ?? null,
        step: c.step ?? null,
        value: c.value ?? null,
        required: !!c.required,
      }));
    const target = readSumTarget(screen, members);
    if (!target) continue; // NO confident target => do nothing at all
    out.push({ total: target.total, targetSource: target.source, members });
  }
  return out;
}

export type AllocationSplit =
  | { ok: true; values: Array<{ idx: number; value: string }>; how: string }
  | { ok: false; why: string };

/**
 * THE VALUE RULE — deterministic and least-committed, the group analogue of the midpoint.
 *
 * THE LATTICE INVARIANT (the 11 Aug review blocker): every phase moves ONLY on each member's
 * own VALID VALUE LATTICE — the min-anchored step grid intersected with [min, max]; for
 * step="any", the whole interval. The pre-fix clamp cut a snapped value to the RAW max,
 * which the member's own grid may not contain ({min 0, max 5, step 3} admits {0, 3}, and
 * clamping 9 to 5 wrote a value the input's own validity.stepMismatch condemns), while the
 * success check verified only the final total — a knowingly step-invalid write recorded as
 * a successful navigator default, with the site's later rejection blamed on the site.
 *
 *   1. equal split of T over N, snapped DOWN to each input's own step grid, anchored at its
 *      own min (the same base constraint validation uses — reuse of num/tidy arithmetic);
 *   2. the remainder goes ONE STEP at a time to the FIRST inputs in DOM order;
 *   3. each value is clamped INTO ITS OWN LATTICE: below min it rises to min (a lattice
 *      point — the grid is anchored there), above max it drops to the LARGEST grid point
 *      <= max, never to the raw max;
 *   4. any deficit/surplus the clamps created is redistributed greedily in DOM order, each
 *      member moving in MULTIPLES OF ITS OWN STEP inside its lattice, so every intermediate
 *      state stays member-valid;
 *   5. a residual greedy order cannot place goes to the BOUNDED EXACT SEARCH over the
 *      members' lattices (`exactLatticeRepair` below) — greedy quanta alone can strand a
 *      FEASIBLE split (grids {4} and {3} cannot greedily place a residual of 6 even though
 *      3+3 exists), and a false "unfillable" is the other face of the blocker;
 *   6. only a total NO lattice combination reaches is a NAMED failure carrying the
 *      arithmetic — never a silently wrong sum, and never a knowingly-invalid write.
 */
export function allocationValues(group: AllocationGroup): AllocationSplit {
  const EPS = 1e-9;
  const T = group.total;
  const n = group.members.length;
  const ms = group.members.map((m) => {
    const declaredMin = num(m.min);
    const rawStep = String(m.step ?? "")
      .trim()
      .toLowerCase();
    const parsed = rawStep === "any" ? null : (num(m.step) ?? 1);
    // `step="any"` is the site saying "no grid" — the one case a fraction is legal.
    const step = parsed !== null && parsed > 0 ? parsed : null;
    const lo = declaredMin ?? 0;
    const hi = num(m.max) ?? Number.POSITIVE_INFINITY;
    // The TOP of the member's own lattice: the largest grid point <= max. The raw max is
    // not necessarily on the grid, and nothing below may ever land off the grid.
    const hiLat = step === null ? hi : lo + step * Math.floor((hi - lo) / step + EPS);
    return { idx: m.idx, lo, hi, hiLat, step, anchor: lo, v: 0 };
  });

  for (const m of ms) {
    if (m.hiLat < m.lo - EPS) {
      return {
        ok: false,
        why:
          `the site's own declarations leave an input no valid value at all ` +
          `(min ${tidy(m.lo)}, max ${tidy(m.hi)}, step ${m.step === null ? '"any"' : tidy(m.step)})`,
      };
    }
  }

  const sumMin = ms.reduce((a, m) => a + m.lo, 0);
  // The reachable ceiling is the sum of LATTICE tops, not raw maxes: {min 0, max 5, step 3}
  // contributes 3, and pretending it contributes 5 is exactly how a step-invalid clamp used
  // to slip through this check.
  const sumMax = ms.reduce((a, m) => a + m.hiLat, 0);
  if (sumMin > T + EPS) {
    return {
      ok: false,
      why:
        `the site's own declarations make the declared total unreachable: the inputs' min values alone ` +
        `sum to ${tidy(sumMin)}, above the declared total ${tidy(T)}`,
    };
  }
  if (sumMax < T - EPS) {
    return {
      ok: false,
      why:
        `the site's own declarations make the declared total unreachable: the inputs' max values ` +
        `(each snapped to its own step grid) allow at most ${tidy(sumMax)}, below the declared total ${tidy(T)}`,
    };
  }

  // 1. equal split, snapped down to each input's own grid.
  const base = T / n;
  for (const m of ms) {
    m.v = m.step === null ? base : m.anchor + m.step * Math.floor((base - m.anchor) / m.step + EPS);
  }

  // 2. the remainder: one step to each member in DOM order until it is gone (the "first k
  //    inputs" rule — with a uniform step the snap-down leaves less than one step per member,
  //    so exactly the first k members take one step each).
  let left = T - ms.reduce((a, m) => a + m.v, 0);
  for (const m of ms) {
    if (left <= EPS) break;
    const add = m.step === null ? left : m.step <= left + EPS ? m.step : 0;
    if (add > 0) {
      m.v += add;
      left -= add;
    }
  }

  // 3. clamp each value INTO ITS OWN LATTICE — AFTER the remainder, so a capped member's
  //    excess becomes a deficit the next phase moves elsewhere. Below min the value rises to
  //    min, a lattice point by construction; above max it drops to hiLat, the largest grid
  //    point <= max — NEVER to the raw max, which may sit between the member's own grid
  //    points (the review's counterexample: 9 clamped to raw 5 on a {0, 3} grid).
  for (const m of ms) {
    if (m.v < m.lo) m.v = m.lo;
    if (m.v > m.hiLat) m.v = m.hiLat;
  }

  // 4. clamping (or a step-shaped remainder) may leave the sum off in either direction:
  //    redistribute greedily in DOM order, each member moving as far as its own grid and
  //    lattice bounds allow — always in multiples of its own step, so values stay valid.
  let deficit = T - ms.reduce((a, m) => a + m.v, 0);
  for (const m of ms) {
    if (Math.abs(deficit) <= EPS) break;
    if (deficit > 0) {
      const room = Math.min(deficit, m.hiLat - m.v);
      const add = m.step === null ? room : m.step * Math.floor(room / m.step + EPS);
      if (add > EPS) {
        m.v += add;
        deficit -= add;
      }
    } else {
      const room = Math.min(-deficit, m.v - m.lo);
      const sub = m.step === null ? room : m.step * Math.floor(room / m.step + EPS);
      if (sub > EPS) {
        m.v -= sub;
        deficit += sub;
      }
    }
  }

  // 5. a residual here is NOT yet proof of infeasibility — greedy DOM order can strand a
  //    feasible split. The bounded exact search settles it either way.
  let searched = false;
  if (Math.abs(deficit) > EPS) {
    const repaired = exactLatticeRepair(ms, deficit, EPS);
    if (repaired === "exhausted") {
      return {
        ok: false,
        why:
          `the exact search over the inputs' step grids exhausted its budget before landing on the ` +
          `declared total ${tidy(T)} or ruling it out — refusing to write a possibly-invalid split`,
      };
    }
    if (repaired === "solved") {
      searched = true;
      deficit = T - ms.reduce((a, m) => a + m.v, 0);
    }
    if (Math.abs(deficit) > EPS) {
      return {
        ok: false,
        why:
          `the inputs' declared step grids cannot land on the declared total ${tidy(T)} exactly ` +
          `(nearest reachable sum found: ${tidy(T - deficit)})`,
      };
    }
  }
  return {
    ok: true,
    values: ms.map((m) => ({ idx: m.idx, value: tidy(m.v) })),
    how:
      `${tidy(T)} over ${n} inputs, equal split snapped to each input's own step grid` +
      (searched ? ", residual placed by exact lattice search" : ""),
  };
}

/**
 * PHASE 5 OF `allocationValues` — the bounded exact search, only ever reached when the greedy
 * phases left a residual.
 *
 * The question it answers EXACTLY: is there any assignment on the members' own lattices that
 * sums to the declared total? Formulated as adjustments from the greedy state: a stepped
 * member may move by k*step while staying inside [lo, hiLat]; step="any" members can jointly
 * absorb any residual inside the interval [sum(lo - v), sum(hi - v)]. DFS over the stepped
 * members in DOM order, candidates ordered smallest |k| first (up before down on ties) —
 * deterministic, and biased to move each member as little as possible off the greedy shape.
 * Candidate ranges are pruned by suffix bounds (what the members after this one can still
 * absorb), dead (member, residual) states are memoised, and every candidate tried costs
 * budget, so the walk terminates unconditionally. Realistic groups (a handful of members,
 * totals in the hundreds) sit orders of magnitude below the budget; "exhausted" exists so a
 * pathological screen fails CLOSED instead of looping or writing an unproven split.
 *
 *   "solved"     — ms[].v now holds a member-valid assignment summing exactly to the total
 *   "infeasible" — PROVEN: no lattice combination reaches the total (the search was exhaustive)
 *   "exhausted"  — the budget ran out first; NOT proof of infeasibility, the caller fails closed
 */
function exactLatticeRepair(
  ms: Array<{ lo: number; hi: number; hiLat: number; step: number | null; v: number }>,
  deficit: number,
  EPS: number,
): "solved" | "infeasible" | "exhausted" {
  const stepped = ms.filter((m) => m.step !== null);
  const free = ms.filter((m) => m.step === null);
  const freeLo = free.reduce((a, m) => a + (m.lo - m.v), 0);
  const freeHi = free.reduce((a, m) => a + (m.hiLat - m.v), 0);

  // Suffix bounds: what stepped members i.. plus ALL free members can still absorb.
  const nS = stepped.length;
  const sufLo: number[] = new Array(nS + 1);
  const sufHi: number[] = new Array(nS + 1);
  sufLo[nS] = freeLo;
  sufHi[nS] = freeHi;
  for (let i = nS - 1; i >= 0; i--) {
    sufLo[i] = sufLo[i + 1]! + (stepped[i]!.lo - stepped[i]!.v);
    sufHi[i] = sufHi[i + 1]! + (stepped[i]!.hiLat - stepped[i]!.v);
  }

  let budget = 20_000;
  const dead = new Set<string>();
  const chosen: number[] = new Array(nS).fill(0);

  // 1 = solved, 0 = infeasible from this node, -1 = budget exhausted.
  const dfs = (i: number, rest: number): 1 | 0 | -1 => {
    if (i === nS) return rest >= freeLo - EPS && rest <= freeHi + EPS ? 1 : 0;
    const key = `${i}|${tidy(rest)}`;
    if (dead.has(key)) return 0;
    const m = stepped[i]!;
    const step = m.step as number;
    // k must keep the member inside its own lattice AND leave a residual the rest can absorb.
    const kLo = Math.max(
      Math.ceil((m.lo - m.v) / step - EPS),
      Number.isFinite(sufHi[i + 1]!) ? Math.ceil((rest - sufHi[i + 1]!) / step - EPS) : Number.NEGATIVE_INFINITY,
    );
    const kHi = Math.min(
      Number.isFinite(m.hiLat) ? Math.floor((m.hiLat - m.v) / step + EPS) : Number.POSITIVE_INFINITY,
      Math.floor((rest - sufLo[i + 1]!) / step + EPS),
    );
    const tryK = (k: number): 1 | 0 | -1 => {
      if (--budget <= 0) return -1;
      const r = dfs(i + 1, rest - k * step);
      if (r === 1) chosen[i] = k;
      return r;
    };
    if (kLo <= kHi) {
      if (kLo >= 0) {
        // All candidates move up: ascending k IS ascending |k|.
        for (let k = kLo; k <= kHi; k++) {
          const r = tryK(k);
          if (r !== 0) return r;
        }
      } else if (kHi <= 0) {
        // All candidates move down: descending k IS ascending |k|.
        for (let k = kHi; k >= kLo; k--) {
          const r = tryK(k);
          if (r !== 0) return r;
        }
      } else {
        const first = tryK(0);
        if (first !== 0) return first;
        for (let d = 1, span = Math.max(kHi, -kLo); d <= span; d++) {
          if (d <= kHi) {
            const r = tryK(d);
            if (r !== 0) return r;
          }
          if (-d >= kLo) {
            const r = tryK(-d);
            if (r !== 0) return r;
          }
        }
      }
    }
    dead.add(key);
    return 0;
  };

  const outcome = dfs(0, deficit);
  if (outcome === -1) return "exhausted";
  if (outcome === 0) return "infeasible";
  for (let i = 0; i < nS; i++) stepped[i]!.v += chosen[i]! * (stepped[i]!.step as number);
  // Water-fill the free members with what remains: each takes clamp(rest - what the LATER
  // free members must at least take, own bounds). Exact whenever the leaf interval check
  // admitted the residual — the suffix-lo subtraction is what keeps the tail feasible.
  let rest = deficit - chosen.reduce((a, k, i) => a + k * (stepped[i]!.step as number), 0);
  for (let i = 0; i < free.length; i++) {
    const f = free[i]!;
    let loAfter = 0;
    for (let j = i + 1; j < free.length; j++) loAfter += free[j]!.lo - free[j]!.v;
    const t = Math.min(f.hiLat - f.v, Math.max(f.lo - f.v, rest - loAfter));
    f.v += t;
    rest -= t;
  }
  return "solved";
}

/**
 * PLANNER-DRIVEN SURVIVAL HINTS — the additive stimulus channel that keeps the option
 * DEFAULT from volunteering a documented screen-out answer.
 *
 * THE MEASURED DEFECT (reach baseline 2026-08-10/11): s2-clean died at S3 because the
 * position-1 default answered "Which industry…" with "Market research" — the one answer the
 * questionnaire documents as disqualifying. The plan knew the trigger all along
 * (`plan.model.questions[].options[].terminates`, `model.terminals`); the driver had no
 * channel for it. `stages/plan.ts#stampSurvivalHints` now stamps per-decision
 * `avoid_labels` and per-path `survival_hints`, and THIS is the one place they are read.
 *
 * INPUT, NEVER EVIDENCE — the boundary, stated where it is enforced:
 *   - a hint NEVER joins `wanted`/`select`, so it cannot reach `requestedButNotOffered`
 *     (missing-option evidence) or `isConstrainingDecision` (the exercised gate);
 *   - the steered click keeps the counted `navigator-default:` provenance prefix — it is
 *     still an invented answer, only a better-informed one;
 *   - a hint may re-order which filler is picked; it may NEVER refuse an answer. All
 *     options flagged => today's position-1 pick stands.
 *   - the grid default and the value fillers are NOT consumers: hints are a label
 *     mechanism (phase 2); numeric screen-outs belong to the bounded-retry feature.
 *
 * Path-level hints apply only to UNBOUND screens and are matched by OFFERED-LABEL OVERLAP
 * alone — they pick among fillers and never bind identity (binding stays `bindDecision`'s).
 */
export interface SurvivalHint {
  question?: string;
  question_text?: string;
  avoid_labels: string[];
}

/** Non-empty strings only; everything else in a hint row is noise, never a crash. */
const hintLabels = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];

/** The path's `survival_hints`, sanitized once per walk. Unknown shapes degrade to []. */
export function survivalHintsOf(path: unknown): SurvivalHint[] {
  const raw = (path as { survival_hints?: unknown } | null | undefined)?.survival_hints;
  if (!Array.isArray(raw)) return [];
  const out: SurvivalHint[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const labels = hintLabels((row as Record<string, unknown>)["avoid_labels"]);
    if (labels.length === 0) continue;
    const q = (row as Record<string, unknown>)["question"];
    out.push({ ...(typeof q === "string" ? { question: q } : {}), avoid_labels: labels });
  }
  return out;
}

/**
 * The avoid labels in force for THIS screen. A bound decision speaks for itself
 * (`avoid_labels`, stamped from the same terminate data); an unbound screen consults the
 * path's hints, and a hint applies only when its labels overlap what the screen OFFERS —
 * matching a hint for one screen against another would steer fillers on a guess.
 */
export function survivalAvoidLabels(
  decision: PlannedDecision | null,
  pathHints: readonly SurvivalHint[],
  screen: RenderedScreen,
): string[] {
  if (decision) return hintLabels((decision as Record<string, unknown>)["avoid_labels"]);
  if (pathHints.length === 0) return [];
  const offered = screen.optionGroups.flatMap((g) => g.options.map((o) => o.label));
  if (offered.length === 0) return [];
  const out: string[] = [];
  for (const hint of pathHints) {
    const labels = hintLabels(hint?.avoid_labels);
    if (labels.length === 0) continue;
    if (!labels.some((a) => offered.some((o) => labelMatches(o, a)))) continue;
    for (const l of labels) if (!out.includes(l)) out.push(l);
  }
  return out;
}

/** Apply one decision to the screen in front of us. Returns what was actually done. */
async function applyDecision(
  page: PageLike,
  screen: RenderedScreen,
  decision: PlannedDecision | null,
  pathHints: readonly SurvivalHint[] = [],
  /** BOUNDED SCREEN-OUT RETRY filler variant (WalkOptions.variant). 0 = today's defaults. */
  variant = 0,
): Promise<{ actions: PerformedAction[]; notOffered: string[]; unfillable: UnfillableControl[] }> {
  const actions: PerformedAction[] = [];
  const notOffered: string[] = [];
  /** Controls met on this screen and NOT answered, each with the reason. See UnfillableControl. */
  const unfillable: UnfillableControl[] = [];
  const namedUnfillable = new Set<string>();
  const wanted = decision && Array.isArray(decision.select) ? decision.select : [];
  const strategy = String(decision?.strategy ?? "");
  const probeAction = String(decision?.action ?? "");
  /** How the reader said THIS control is actuated. Grid cells carry only an index. */
  const actuation = (idx: number) => screen.controls.find((c) => c.idx === idx) ?? null;
  const nameUnfillableControl = (
    c: ControlState,
    reason: UnfillableControl["reason"],
    detail: string,
  ): void => {
    const identity = `${c.idx}:${reason}`;
    if (namedUnfillable.has(identity)) return;
    namedUnfillable.add(identity);
    unfillable.push({ idx: c.idx, type: c.type, label: c.label, required: !!c.required, reason, detail });
    actions.push({
      kind: "refuse-fill",
      targetIdx: c.idx,
      targetLabel: c.label,
      targetCode: c.code,
      value: null,
      ok: false,
      detail,
    });
  };
  const wantsBlank = probeAction === "leave-blank-and-continue" || decision?.text_entry?.value === "";
  // Selection ownership is computed BEFORE either native selects or option groups act. A token
  // that exactly identifies a native option cannot first drift through the older, containment-
  // tolerant radio matcher; an exact radio/select collision is named and neither receives it.
  const nativeSelects = screen.controls.filter((c) => c.tag === 'select' || c.type === 'select');
  const cleanExact = (s: string): string => String(s).replace(/\s+/g, ' ').trim();
  const selectOwners = wanted.map((request) => ({
    request,
    controlIdxs: nativeSelects
      .filter((c) => c.visible && (c.options ?? []).some((o) => exactSelectOptionMatch(o, request)))
      .map((c) => c.idx),
    alsoOptionGroup: screen.optionGroups.some((g) =>
      g.options.some((o) => o.code === request || cleanExact(o.label) === cleanExact(request)),
    ),
  }));
  const hasRequestedNativeSelectMatch = selectOwners.some((owner) => owner.controlIdxs.length > 0);
  // ---- survival hints in force here: consumed ONLY by the option default below ----
  // Computed once, up front, so the ONE-consumer rule is auditable: `avoid` appears in the
  // option default and nowhere else. See `survivalAvoidLabels` for the evidence boundary.
  const avoid = survivalAvoidLabels(decision, pathHints, screen);

  // ---- constant-sum ("allocate 100 points") groups: claimed BEFORE the grid and value passes ----
  //
  // The controls this pass answers (or names unfillable) are CLAIMED here, and both later
  // passes honour the claim: the grid pass must not land its meaningless click on a number
  // cell this pass filled, and the value loop must not overwrite a group sum with per-control
  // midpoints. Detection keys off input TYPE, never screen shape — see allocationGroups.
  const allocationClaimed = new Set<number>();
  // A planned `text_entry` fans out to EVERY value control on this screen (see the value
  // loop), so on an allocation screen every member is a planned member: the "exclude planned
  // members and subtract their values from T" rule degenerates to excluding all of them, and
  // the pass abstains — the plan always wins. `case_action` boundary probes materialize as
  // text_entry, so sealed stimulus lands in this same guard; a leave-blank probe is an act of
  // its own and is likewise never overridden.
  if (!wantsBlank && decision?.text_entry?.value === undefined) {
    for (const group of allocationGroups(screen)) {
      const held = group.members.map((m) => num(m.value ?? null));
      const heldSum = held.reduce((a: number, v) => a + (v ?? 0), 0);
      if (held.every((v) => v !== null) && Math.abs(heldSum - group.total) < 1e-9) {
        // The group already sums to the site's own target — the group-level analogue of
        // `alreadyAnswered`, claimed silently so no later pass disturbs a correct state.
        for (const m of group.members) allocationClaimed.add(m.idx);
        continue;
      }
      // NOTE the overwrite: members may already hold values (the recovery pass sees the first
      // pass's own fillers, `valueIsUserSupplied` and all). A group that does NOT sum to the
      // site's declared target is not an answered group, so the fillers are replaced; the
      // sum-matches guard above is what protects a genuinely answered one.
      const split = allocationValues(group);
      if (!split.ok) {
        for (const m of group.members) {
          allocationClaimed.add(m.idx);
          const c = actuation(m.idx);
          unfillable.push({
            idx: m.idx,
            type: c?.type ?? "number",
            label: c?.label ?? m.label,
            required: !!c?.required,
            reason: "no-derivation",
            detail: `constant-sum group unfillable: ${split.why}`,
          });
          actions.push({
            kind: "refuse-fill",
            targetIdx: m.idx,
            targetLabel: c?.label ?? m.label,
            targetCode: null,
            value: null,
            ok: false,
            detail: `constant-sum group unfillable: ${split.why}`,
          });
        }
        continue;
      }
      for (const { idx, value } of split.values) {
        allocationClaimed.add(idx);
        const c = actuation(idx);
        const r = await typeIdx(page, idx, value);
        actions.push({
          kind: "type-text",
          targetIdx: idx,
          targetLabel: c?.label ?? "",
          targetCode: null,
          value,
          ok: r.ok,
          // The `navigator-default:` prefix is REQUIRED: countDefaults and the ending's
          // provenance line key off it, and these values are invented answers like any other
          // filler — stimulus is INPUT, never EVIDENCE.
          detail: `navigator-default:allocation-split(${split.how}; target from ${group.targetSource}) (${r.detail})`,
        });
        if (r.discarded || !r.ok) {
          unfillable.push({
            idx,
            type: c?.type ?? "number",
            label: c?.label ?? "",
            required: !!c?.required,
            reason: "value-rejected",
            detail:
              `the control did not keep the value "${value}" it was given` +
              (r.got !== undefined ? ` — it holds "${r.got}"` : "") +
              (c?.step ? ` (the site declares step="${c.step}")` : ""),
          });
        }
      }
    }
  }

  // ---- grid / matrix screens: every row must be answered before the screen advances ----
  if (screen.grid && screen.grid.rows.length > 0) {
    const m = /grid:answer-every-row with "(.+?)"/.exec(strategy);
    const wantColumn = m ? m[1] : (wanted[0] ?? null);
    for (const row of screen.grid.rows) {
      const wantedCell = wantColumn ? row.cells.find((c) => c.column && labelMatches(c.column, wantColumn)) : null;
      const cell = wantedCell ?? row.cells[0];
      if (!cell) continue;
      // The allocation pass already answered this row's input — a click on a filled number
      // cell is not an answer and must not be recorded as one. Same shape as the option-group
      // skip below.
      if (allocationClaimed.has(cell.idx)) continue;
      const targetControl = actuation(cell.idx);
      const r = await clickIdx(page, cell.idx, targetControl);
      const choiceReadback =
        r.ok && (targetControl?.type === "radio" || targetControl?.type === "checkbox")
          ? await readChoiceAt(page, cell.idx)
          : undefined;
      const choiceSuccess =
        targetControl?.type === "radio" || targetControl?.type === "checkbox"
          ? r.ok && exactChoiceReadback(cell.idx, targetControl.type, choiceReadback, targetControl)
          : r.ok;
      // THE FALLBACK IS NAMED. Taking cells[0] because no column matched is a DIFFERENT act
      // from answering the documented column, and it used to be recorded identically — which
      // is how a shifted column parse produced wrong answers that read like right ones.
      const how =
        wantColumn && !wantedCell
          ? `grid:no-column-matched "${wantColumn}" — fell back to the row's first cell` +
            (row.cells.some((c) => c.column === null) ? " (this grid's columns are unlabelled — see readerLimitations)" : "")
          : null;
      actions.push({
        kind: "select-grid-cell",
        targetIdx: cell.idx,
        targetLabel: `${row.label} / ${cell.column ?? "col?"}`,
        targetCode: cell.code,
        value: null,
        ok: choiceSuccess,
        detail:
          targetControl?.type === "radio" || targetControl?.type === "checkbox"
            ? choiceReceiptDetail(how ? `${how} (${r.detail})` : r.detail, cell.idx, targetControl.type, choiceReadback, targetControl)
            : how ? `${how} (${r.detail})` : r.detail,
        choiceReadback,
      });
    }
  }

  // ---- option groups ----
  // An exact token offered by BOTH a native select and a radio/checkbox is not owned by either.
  // Name the group-side controls now; the native loop below names its own side.
  for (const owner of selectOwners.filter((candidate) => candidate.controlIdxs.length > 0 && candidate.alsoOptionGroup)) {
    for (const g of screen.optionGroups) {
      for (const o of g.options.filter(
        (option) => option.code === owner.request || cleanExact(option.label) === cleanExact(owner.request),
      )) {
        const c = actuation(o.idx);
        if (c) {
          nameUnfillableControl(
            c,
            'selection-ambiguous',
            `requested ${JSON.stringify(owner.request)} exactly identifies both a native select option and this ${g.kind} option; neither control was chosen`,
          );
        }
      }
    }
  }
  for (const g of screen.optionGroups) {
    if (screen.grid && screen.grid.rows.some((r) => r.name && r.name === g.name)) continue; // handled above
    const matches = wanted
      // Any exact native owner beats this match's containment heuristic. Exact group collisions
      // were named above; a merely similar group is unrelated and must not receive the token.
      .filter((w) => !selectOwners.some((owner) => owner.request === w && owner.controlIdxs.length > 0))
      .map((w) => ({ w, opt: g.options.find((o) => labelMatches(o.label, w)) }))
      .filter((x) => x.opt);
    if (matches.length === 0) continue;
    for (const { w, opt } of matches) {
      if (!opt) continue;
      if (opt.checked) {
        const checkedGroupIdxs = g.options.filter((candidate) => candidate.checked).map((candidate) => candidate.idx);
        const choiceReadback: NonNullable<PerformedAction["choiceReadback"]> = {
          idx: opt.idx,
          type: g.kind,
          name: g.identity?.name ?? (g.name === "(unnamed)" ? null : g.name),
          formOwner: g.identity?.formOwner ?? null,
          unnamedControlIdx: g.identity?.unnamedControlIdx ?? null,
          checked: true,
          checkedGroupIdxs,
        };
        actions.push({
          kind: "click-option",
          targetIdx: opt.idx,
          targetLabel: opt.label,
          targetCode: opt.code,
          value: null,
          ok: exactChoiceReadback(opt.idx, g.kind, choiceReadback, g),
          detail: choiceReceiptDetail("already-selected", opt.idx, g.kind, choiceReadback, g),
          choiceReadback,
        });
        continue;
      }
      const r = await clickIdx(page, opt.idx, opt);
      const choiceReadback = r.ok ? await readChoiceAt(page, opt.idx) : null;
      actions.push({
        kind: "click-option",
        targetIdx: opt.idx,
        targetLabel: opt.label,
        targetCode: opt.code,
        value: w,
        ok: r.ok && exactChoiceReadback(opt.idx, g.kind, choiceReadback, g),
        // A requested label that lands on a control NO RESPONDENT COULD REACH is still
        // clicked — the plan asked for it, and refusing here would silently drop a documented
        // answer — but it is never recorded as an ordinary click. A responsive site renders
        // its grid twice (a table and a `display:none` stacked list), and both copies offer
        // the same labels; this is what tells the two apart afterwards.
        detail: choiceReceiptDetail(
          (opt.operable ?? true) ? r.detail : `not-operable:${opt.actuatedVia ?? "unknown"} (${r.detail})`,
          opt.idx,
          g.kind,
          choiceReadback,
          g,
        ),
        choiceReadback,
      });
    }
  }

  // ---- default: nothing requested matched, so answer enough to advance ----
  const answeredSomething = actions.some((a) => a.ok && a.kind !== "type-text");
  if (!answeredSomething && !screen.grid && !hasRequestedNativeSelectMatch) {
    for (const g of screen.optionGroups) {
      if (g.options.some((o) => o.checked)) continue;
      // `answerable`, NOT `visible` — see the comment on answerable(). This is the line that
      // made a 0-10 NPS score unreachable and answered "Don't know" instead.
      const first = g.options.find((o) => answerable(o));
      if (!first) continue;
      // SURVIVAL HINTS: prefer the first answerable option matching NO documented
      // screen-out label. A hint may re-order which filler is picked — it may NEVER refuse
      // an answer: when every answerable option is flagged, today's position-1 choice
      // stands, because a filler that keeps walking beats a stall on a hint.
      const flagged = (o: (typeof g.options)[number]): boolean => avoid.some((a) => labelMatches(o.label, a));
      // ---- BOUNDED SCREEN-OUT RETRY: the Nth eligible option, AFTER hint filtering ----
      //
      // The first walk's position-1 pick (below) reached a documented screen-out, so the
      // pivot moves to the variant-th answerable option matching no avoid label — CLAMPED
      // to the last one, not wrapped: with more pivots than eligible options, wraparound
      // would return to position-1, the exact answer the first walk already screened out
      // on, so the clamp repeats the furthest untried position instead. All-flagged
      // degrades to the full answerable list (a hint may re-order fillers, never refuse
      // one), and the detail keeps the counted `navigator-default:` prefix under a
      // `retry-N` tag — a pivot filler is still an invented answer.
      if (variant > 0) {
        const answerableOpts = g.options.filter((o) => answerable(o));
        const nonFlagged = avoid.length > 0 ? answerableOpts.filter((o) => !flagged(o)) : answerableOpts;
        const eligible = nonFlagged.length > 0 ? nonFlagged : answerableOpts;
        const pick = Math.min(variant, eligible.length - 1);
        const alt = eligible[pick]!;
        const rv = await clickIdx(page, alt.idx, alt);
        const choiceReadback = rv.ok ? await readChoiceAt(page, alt.idx) : null;
        actions.push({
          kind: "click-option",
          targetIdx: alt.idx,
          targetLabel: alt.label,
          targetCode: alt.code,
          value: null,
          ok: rv.ok && exactChoiceReadback(alt.idx, g.kind, choiceReadback, g),
          detail:
            `navigator-default:retry-${variant}:option-${pick + 1}-of-${eligible.length}-eligible` +
            `${avoid.length > 0 ? "-after-hint-filtering" : ""} (` +
            choiceReceiptDetail(rv.detail, alt.idx, g.kind, choiceReadback, g) + `)`,
          choiceReadback,
        });
        if (g.kind === "radio") continue;
        break;
      }
      const preferred = avoid.length > 0 ? g.options.find((o) => answerable(o) && !flagged(o)) : first;
      const chosen = preferred ?? first;
      // The labels actually steered around, in DOM order — named in the detail so a reader
      // can see WHY this filler is not position-1. Empty when the pick equals position-1.
      const avoided: string[] = [];
      if (chosen !== first) {
        for (const o of g.options) {
          if (o.idx === chosen.idx) break;
          if (answerable(o) && flagged(o)) avoided.push(o.label);
        }
      }
      const r = await clickIdx(page, chosen.idx, chosen);
      const choiceReadback = r.ok ? await readChoiceAt(page, chosen.idx) : null;
      actions.push({
        kind: "click-option",
        targetIdx: chosen.idx,
        targetLabel: chosen.label,
        targetCode: chosen.code,
        value: null,
        ok: r.ok && exactChoiceReadback(chosen.idx, g.kind, choiceReadback, g),
        // BOTH shapes keep the `navigator-default:` prefix — countDefaults and the ending's
        // provenance line key off it, and a hint-steered filler is still an invented answer.
        detail:
          avoided.length > 0
            ? `navigator-default:first-non-flagged-option(avoided ${avoided.map((s) => JSON.stringify(s)).join(", ")}) (` +
              choiceReceiptDetail(r.detail, chosen.idx, g.kind, choiceReadback, g) + `)`
            : `navigator-default:first-option (` + choiceReceiptDetail(r.detail, chosen.idx, g.kind, choiceReadback, g) + `)`,
        choiceReadback,
      });
      if (g.kind === "radio") continue;
      break;
    }
  }

  // ---- native <select>: one scoped element, one exact option, one exact readback ----
  //
  // Select options do NOT join optionGroups. Keeping them separate preserves the complete native
  // inventory and prevents a global `role=option`/text lookup from clicking a same-labelled option
  // belonging to another widget. A requested token owns a select only when it identifies exactly
  // one visible select and does not also identify a radio/checkbox option on this screen.
  for (const c of nativeSelects) {
    // A hidden native select MAY back a custom widget, an alternate responsive layout, or a
    // honeypot. The DOM alone does not identify which convention applies. Never actuate it and
    // never silently erase it: retain the control as a named, counted non-actuation.
    if (!c.visible) {
      nameUnfillableControl(
        c,
        'control-not-operable',
        'native select is not rendered at this viewport; it may be backing, alternate-layout, or non-respondent markup, so no safe respondent act is available',
      );
      continue;
    }
    if (c.disabled) {
      nameUnfillableControl(c, "control-disabled", "visible native select is disabled and cannot be actuated");
      continue;
    }
    if (c.multiple) {
      nameUnfillableControl(
        c,
        "unsupported-widget",
        "native select[multiple] was inventoried, but this slice has no certified multi-option actuation/readback contract",
      );
      continue;
    }
    if (!Array.isArray(c.options)) {
      nameUnfillableControl(
        c,
        "no-usable-option",
        "native select was discovered but its complete option inventory is absent, so no scoped selection is safe",
      );
      continue;
    }

    const ownedRequests = selectOwners.filter((owner) => owner.controlIdxs.includes(c.idx));
    const ambiguousRequests = ownedRequests.filter(
      (owner) => owner.controlIdxs.length !== 1 || owner.alsoOptionGroup,
    );
    const uniqueRequests = ownedRequests.filter(
      (owner) => owner.controlIdxs.length === 1 && !owner.alsoOptionGroup,
    );
    if (ambiguousRequests.length > 0 && uniqueRequests.length === 0) {
      nameUnfillableControl(
        c,
        "selection-ambiguous",
        `requested ${ambiguousRequests.map((x) => JSON.stringify(x.request)).join(", ")} matches more than one visible selection control; no global/foreign option was chosen`,
      );
      continue;
    }

    const plannedOptions = uniqueRequests
      .flatMap((owner) => c.options!.filter((o) => exactSelectOptionMatch(o, owner.request)))
      .filter((option, index, all) => all.findIndex((x) => x.order === option.order) === index);
    if (plannedOptions.length > 1) {
      nameUnfillableControl(
        c,
        "selection-ambiguous",
        `the planned tokens identify ${plannedOptions.length} different options inside this single-select; choosing one would invent precedence`,
      );
      continue;
    }

    let chosen: NativeSelectOption | undefined = plannedOptions[0];
    let provenance: string;
    if (chosen) {
      if (!usableSelectOption(chosen)) {
        nameUnfillableControl(
          c,
          "no-usable-option",
          `the exact requested option ${JSON.stringify(chosen.label)} (code ${JSON.stringify(chosen.code)}) is disabled, hidden, or the select's placeholder-label option`,
        );
        continue;
      }
      const source = uniqueRequests.find((owner) => exactSelectOptionMatch(chosen!, owner.request));
      provenance = chosen.code === source?.request ? "planned:exact-option-code" : "planned:exact-option-label";
    } else {
      const usable = c.options.filter(usableSelectOption);
      const already = usable.find((o) => o.selected);
      // A rerun must not dispatch input/change on a value already held by the page. The selected
      // state is observed in the inventory; no performed action or invented-answer count is due.
      if (already) continue;
      const pick = usable.length > 0 ? Math.min(variant, usable.length - 1) : -1;
      chosen = pick >= 0 ? usable[pick] : undefined;
      if (!chosen) {
        const placeholderCount = c.options.filter((o) => o.placeholder).length;
        nameUnfillableControl(
          c,
          "no-usable-option",
          `native select has ${c.options.length} inventoried option(s), but none is enabled, visible and non-placeholder` +
            (placeholderCount > 0 ? ` (${placeholderCount} HTML placeholder-label option)` : ""),
        );
        continue;
      }
      provenance =
        variant > 0
          ? `navigator-default:retry-${variant}:native-option-${pick + 1}-of-${usable.length}-usable`
          : "navigator-default:first-usable-native-option";
    }

    const selected = await selectOptionIdx(page, c, chosen);
    actions.push({
      kind: "select-option",
      targetIdx: c.idx,
      targetLabel: chosen.label,
      targetCode: chosen.code,
      value: chosen.code,
      ok: selected.ok,
      detail: `${provenance} (${selected.detail})`,
      selectReadback: selected.readback,
    });
    if (!selected.ok) {
      unfillable.push({
        idx: c.idx,
        type: c.type,
        label: c.label,
        required: !!c.required,
        reason: "value-rejected",
        detail: `native select did not retain the exact scoped option ${JSON.stringify(chosen.label)} / ${JSON.stringify(chosen.code)}: ${selected.detail}`,
      });
    }
  }

  // Accessible custom selection and drag widgets are RECOGNISED but not guessed at. Each visible
  // node is named here, while the reader's aggregate limitation records that complete option or
  // source/target semantics were unavailable. Platform adapters can replace this refusal later.
  for (const c of screen.controls.filter(
    (control) => control.tag !== "select" && control.visible && (control.widgetKinds ?? []).length > 0,
  )) {
    const kinds = (c.widgetKinds ?? []).join(",");
    nameUnfillableControl(
      c,
      c.disabled ? "control-disabled" : "unsupported-widget",
      c.disabled
        ? `visible semantic widget (${kinds}) is disabled and cannot be actuated`
        : `visible semantic widget (${kinds}) was inventoried, but generic actuation and post-action proof are not implemented; it was not answered`,
    );
  }

  // Requested answers the screen never offered. Native options count only inside their owning,
  // visible select; a document-wide option text match is deliberately impossible here.
  for (const w of wanted) {
    const offeredByGroup = screen.optionGroups.some((g) => g.options.some((o) => labelMatches(o.label, w)));
    const offeredBySelect = nativeSelects.some(
      (c) => c.visible && (c.options ?? []).some((o) => o.hidden !== true && exactSelectOptionMatch(o, w)),
    );
    if (!offeredByGroup && !offeredBySelect) notOffered.push(w);
  }

  // ---- values: everything a respondent supplies rather than picks ----
  //
  // DELIBERATELY STILL `visible`, not `answerable`. Label-mediated actuation is an affordance
  // of a radio or a checkbox — the label IS the control on screen. A text field drawn at zero
  // opacity offers a respondent nothing to type into, and the commonest reason a form contains
  // one is that it is a HONEYPOT waiting for an automated agent to fill it in.
  //
  // The set is now every VALUE control plus the two we deliberately refuse, because a refusal
  // that is never reached is never recorded. `fillRefusalFor` decides which is which.
  const valueControls = screen.controls.filter(
    (c) => c.visible && !c.disabled && !c.readOnly && (isValueEntry(c.type) || fillRefusalFor(c.type) !== null),
  );
  for (const c of valueControls) {
    // Already claimed by the constant-sum pass above — answered as a group, or named
    // unfillable as a group. Either way this loop has nothing to add.
    if (allocationClaimed.has(c.idx)) continue;
    // ---- a control this harness will not, or cannot, answer ----
    const refusal = fillRefusalFor(c.type);
    if (refusal) {
      unfillable.push({
        idx: c.idx,
        type: c.type,
        label: c.label,
        required: !!c.required,
        reason: c.type === "password" ? "refused-by-policy" : "cannot-be-satisfied",
        detail: refusal,
      });
      // `ok: false`, and that is the whole counterweight. A refusal recorded as a success would
      // pass any "does the walk advance now?" test while quietly destroying the product.
      actions.push({ kind: "refuse-fill", targetIdx: c.idx, targetLabel: c.label, targetCode: null, value: null, ok: false, detail: `refused: ${refusal}` });
      continue;
    }

    if (wantsBlank) {
      // The boundary probe applies to controls that HAVE a blank state. A slider and a colour
      // well do not — their untouched state already is "no answer given" — so leaving them
      // alone is what "leave blank" means for them, and clearing them would only reset them
      // to the same default while claiming an act.
      if (!isTextEntry(c.type)) continue;
      const r = await typeIdx(page, c.idx, "");
      actions.push({ kind: "clear-text", targetIdx: c.idx, targetLabel: c.label, targetCode: null, value: "", ok: r.ok, detail: `probe:leave-blank (${r.detail})` });
      continue;
    }

    // ALREADY ANSWERED? — and note which field decides. `value` alone cannot: a `range` reports
    // its midpoint and a `color` reports `#000000` when nobody has touched them, so keying the
    // skip off `value.length > 0` would skip every slider on every survey for ever and record
    // the screen as answered. `valueIsUserSupplied` is the reader's answer to exactly that;
    // where it is absent (an older reader) the old test is the honest fallback.
    const alreadyAnswered = c.valueIsUserSupplied ?? !!(c.value && c.value.length > 0);
    if (alreadyAnswered) continue;

    const planned = decision?.text_entry?.value;
    const derived = navigatorValueFor(c, variant);
    if (planned === undefined && !derived) {
      // NO RULE IS NOT "NOTHING TO ANSWER". The type is one the reader classes as fillable and
      // this harness has no value for it — said out loud rather than passed over.
      unfillable.push({
        idx: c.idx,
        type: c.type,
        label: c.label,
        required: !!c.required,
        reason: "no-derivation",
        detail: `this harness has no navigator-default value for an input of type "${c.type}", so the control was left unanswered`,
      });
      actions.push({ kind: "refuse-fill", targetIdx: c.idx, targetLabel: c.label, targetCode: null, value: null, ok: false, detail: `no navigator-default derivation for type "${c.type}"` });
      continue;
    }

    const value = planned ?? derived!.value;
    // A PLANNED value goes in by whichever route the CONTROL accepts — the document decides the
    // value, never the mechanism. Typing a documented date into a date input would be discarded
    // exactly as the harness's own filler was.
    const via = derived ? derived.via : isTextEntry(c.type) ? "type" : "set";
    const r = via === "set" ? await setIdx(page, c.idx, value) : await typeIdx(page, c.idx, value);
    actions.push({
      kind: via === "set" ? "set-value" : "type-text",
      targetIdx: c.idx,
      targetLabel: c.label,
      targetCode: null,
      value,
      ok: r.ok,
      // WHOSE VALUE THIS WAS, AND HOW IT WAS DERIVED. A planned answer and a filler the harness
      // invented to get past a screen are different evidence, and a `blocked` that follows one
      // of them means something very different from a `blocked` that follows the other.
      detail: planned === undefined ? `navigator-default:${derived!.how} (${r.detail})` : r.detail,
    });
    // THE CONTROL'S OWN VERDICT ON THE VALUE. Sanitised away, or refused outright, is a fact
    // about this walk that has to travel — otherwise the next thing that happens is a `blocked`
    // reported as the survey rejecting an answer it never received.
    if (r.discarded || !r.ok) {
      unfillable.push({
        idx: c.idx,
        type: c.type,
        label: c.label,
        required: !!c.required,
        reason: "value-rejected",
        detail:
          `the control did not keep the value "${value}" it was given` +
          (r.got !== undefined ? ` — it holds "${r.got}"` : "") +
          (c.pattern ? ` (the site declares pattern="${c.pattern}")` : "") +
          (c.step ? ` (the site declares step="${c.step}")` : ""),
      });
    }
  }

  return { actions, notOffered, unfillable };
}

/**
 * THE CONTROL THAT ADVANCES THE SURVEY — and WHICH RULE FOUND IT.
 *
 * The second rule is a FALLBACK, and until it was named it was also a disguise. On the live
 * SurveyJS fleet every navigation control classified `other` (an `<input type=button>` has no
 * text and no `<label>`, so the old classifier's two inputs were both empty — see
 * `page-script.ts#CLASSIFY_CONTROL_ROLE_SRC`). Screen 1 offers only Next, so "exactly one
 * forward-looking candidate" picked it and the walk looked healthy; screen 2 adds Previous,
 * two candidates tie, and the walk died. The classifier is fixed, but the fallback stays —
 * it is the honest degradation for a platform whose words this reader does not know — and it
 * now says so in the record, because a press chosen by elimination and a press chosen by
 * identity are different acts and were previously indistinguishable afterwards.
 */
export type AdvanceControlResolution =
  | { kind: "none"; candidates: [] }
  | { kind: "unique"; control: { idx: number; label: string; via: string }; candidates: Array<{ idx: number; label: string; via: string }> }
  | { kind: "ambiguous"; candidates: Array<{ idx: number; label: string; via: string }> };

export function resolveAdvanceControl(screen: RenderedScreen): AdvanceControlResolution {
  const cands = screen.buttons.filter((b) => b.visible && !b.disabled);
  const explicit = cands.filter((b) => b.role === "next").map((b) => ({
    idx: b.idx,
    label: b.label,
    via: `role:next(${b.roleVia ?? "unrecorded"})`,
  }));
  if (explicit.length > 1) return { kind: "ambiguous", candidates: explicit };
  if (explicit.length === 1 && explicit[0]) {
    return { kind: "unique", control: explicit[0], candidates: explicit };
  }
  // Defense in depth for artifacts read before the page classifier learned direction-only
  // glyphs: `<<`/left-arrow is Back evidence, never an unknown button eligible to become the
  // sole-forward candidate. This is a generic direction convention, not a platform selector.
  const symbolicBack = (label: string): boolean => /^(?:<+|‹|«|←|⬅|◀|⏪)$/u.test(label.trim());
  const only = cands.filter((b) => b.role !== "back" && !symbolicBack(b.label)).map((b) => ({
    idx: b.idx,
    label: b.label,
    via: "sole-forward-candidate - no control on this screen NAMED itself as advancing, and exactly one was not a back control",
  }));
  if (only.length === 1 && only[0]) {
    return { kind: "unique", control: {
      idx: only[0].idx,
      label: only[0].label,
      via: "sole-forward-candidate — no control on this screen NAMED itself as advancing, and exactly one was not a back control",
    }, candidates: only };
  }
  if (only.length > 1) return { kind: "ambiguous", candidates: only };
  return { kind: "none", candidates: [] };
}

/** Return the unique advance control for call sites that only need one-or-none. */
function nextButton(screen: RenderedScreen): { idx: number; label: string; via: string } | null {
  const resolution = resolveAdvanceControl(screen);
  return resolution.kind === "unique" ? resolution.control : null;
}

/**
 * Movement evidence relative to the POST-ACTION baseline. Select/radio answer state is
 * deliberately absent: an answer can change state without navigation. Progress is accepted
 * only when its numeric value increases.
 */
export function advanceSignals(before: RenderedScreen, after: RenderedScreen): AdvanceSignal[] {
  const out: AdvanceSignal[] = [];
  if (after.screenSignature !== before.screenSignature) out.push("screen-signature-changed");
  if (after.url !== before.url) out.push("url-changed");
  if (
    before.historyLength !== null && before.historyLength !== undefined &&
    after.historyLength !== null && after.historyLength !== undefined &&
    after.historyLength !== before.historyLength
  ) out.push("history-length-changed");
  if (
    before.progress?.present && after.progress?.present &&
    typeof before.progress.now === "number" && Number.isFinite(before.progress.now) &&
    typeof after.progress.now === "number" && Number.isFinite(after.progress.now) &&
    after.progress.now > before.progress.now
  ) out.push("progress-value-increased");
  return out;
}

export const MULTI_QUESTION_ACTUATION_UNSUPPORTED = "multi-question-screen-actuation-unsupported";
export const NAVIGATION_FORWARD_AMBIGUOUS = "navigation-forward-ambiguous";

/** Current readers expose roots and the counted limitation; either is sufficient to fail shut. */
export function multiQuestionRootCount(screen: RenderedScreen): number {
  const roots = Array.isArray(screen.questionRoots) ? screen.questionRoots.length : 0;
  const named = (screen.readerLimitations ?? [])
    .filter((row) => row.kind === MULTI_QUESTION_ACTUATION_UNSUPPORTED)
    .reduce((max, row) => Math.max(max, Number.isFinite(row.count) ? row.count : 0), 0);
  return Math.max(roots, named);
}

/** Answer semantics that distinguish two traversals of the same visual template. */
function transitionActionFingerprint(actions: PerformedAction[]): string {
  return JSON.stringify(
    actions
      .filter((action) => action.kind !== "click-next" && action.kind !== "click-back" && action.kind !== "open")
      .map((action) => ({
        kind: action.kind,
        targetIdx: action.targetIdx,
        targetCode: action.targetCode,
        value: action.value,
        ok: action.ok,
        selectReadback: action.selectReadback ?? null,
        choiceReadback: action.choiceReadback ?? null,
      })),
  );
}

/**
 * Signals that may distinguish repeated roster/review occurrences. None is sufficient alone;
 * the cycle key combines all of them with screen identity, answer receipt, and bounded history.
 */
function screenOccurrenceFingerprint(screen: RenderedScreen): string {
  return JSON.stringify({
    url: screen.url,
    title: screen.title,
    historyLength: screen.historyLength ?? null,
    progress: screen.progress?.present
      ? { kind: screen.progress.kind, now: screen.progress.now, max: screen.progress.max, text: screen.progress.text }
      : null,
    selectState: screen.selectStateSignature ?? null,
  });
}

const normMsg = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Validation messages that appeared AFTER this submit — the ones on `after` that were not
 * already on `before`.
 *
 * IT IS A DELTA BECAUSE THE SELECTOR IS PROMISCUOUS. `page-script.ts` collects
 * `[aria-live]`, `[role=alert]` and `[class*=error]`, which on a real site includes the cookie
 * banner, a toast and a live region that was there when the page loaded. A message that was
 * already on the screen before we touched it witnesses nothing about what we typed.
 */
function newValidationMessages(before: RenderedScreen | null, after: RenderedScreen | null): string[] {
  const had = new Set((before?.validationMessages ?? []).map(normMsg).filter(Boolean));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of after?.validationMessages ?? []) {
    const n = normMsg(m);
    if (!n || had.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(m);
  }
  return out;
}

/**
 * WHY THIS STEP STOPPED ADVANCING. Called only when the step did not advance, at the moment
 * the walker gave up, because these facts are not recoverable afterwards.
 *
 * The order is by strength of the observation, not by convenience: a message that appeared
 * after the submit is the most specific thing the page said; an advance control that is no
 * longer enabled is the next; "the signature had not changed when the clock ran out" is what
 * is left, and it is exactly the case that must never read as a rejection.
 */
function whyBlocked(
  before: RenderedScreen | null,
  afterAction: RenderedScreen | null,
  after: RenderedScreen | null,
): BlockedReason {
  if (newValidationMessages(before, afterAction).length > 0) return "validation-visible";
  if (newValidationMessages(before, after).length > 0) return "validation-visible";
  if (after && nextButton(after) === null) return "control-disabled";
  return "advance-timeout";
}

// ---------------------------------------------------------------------------
// HOW THE WALK ENDED — see `WalkEnding` in types.ts for why this is a separate field.
// ---------------------------------------------------------------------------

/**
 * The words a survey prints when it STOPS a respondent short, and the words it prints when a
 * respondent FINISHES. Two lexicons, and the screen-out one is consulted FIRST, because a
 * disqualification page almost always says "thank you" too — "Thank you for your interest.
 * Unfortunately, on this occasion you do not qualify" is the measured wording on the instrument
 * where the screen-out path was actually reached (run 3 `fi_8e1bf`, run 5 `fi_7eda`), and a
 * completion test run first would swallow it whole.
 *
 * THIS IS AN ASSUMPTION ABOUT WORDS, STATED (CLAUDE.md, the north star). A survey whose terminal
 * page says none of this — a different language, a bare "Session closed", an image — matches
 * neither, and that ending is `unclassified` and counted. It is never assumed to be a completion:
 * the whole point of typing the ending is that "the survey ended well" and "we never got in" and
 * "this respondent was turned away" stopped being one value, and a default would put them back.
 */
const SCREENOUT_MARKERS: readonly RegExp[] = [
  /\b(do|does)\s+not\s+qualify\b/i,
  /\b(don't|doesn't)\s+qualify\b/i,
  /\bnot\s+eligible\b/i,
  /\bno\s+longer\s+qualify\b/i,
  /\bscreen(ed)?[\s-]?out\b/i,
  /\bquota\s+(is\s+)?(full|closed)\b/i,
  /\bwe\s+are\s+(unable|not\s+able)\s+to\s+(continue|proceed)\b/i,
  /\bthank\s+you\s+for\s+your\s+interest\b/i,
];

const COMPLETION_MARKERS: readonly RegExp[] = [
  /\bthank\s+you\s+for\s+(completing|taking\s+part|participating|your\s+time)\b/i,
  /\byour\s+responses?\s+(have|has)\s+been\s+(recorded|received|submitted|saved)\b/i,
  /\b(survey|questionnaire|interview)\s+(is\s+)?complete(d)?\b/i,
  /\byou\s+have\s+(now\s+)?completed\b/i,
  /\bsubmission\s+(received|complete)\b/i,
];

const firstMatch = (text: string, res: readonly RegExp[]): string | null => {
  for (const re of res) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
};

/**
 * TYPE THE ENDING OF THIS WALK FROM WHAT THE FINAL SCREEN SHOWED.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. `outcome: "no-advance-control"` meant BOTH "the respondent
 * reached the thank-you page and there is nothing left to press" AND "we never got into the
 * survey at all". One enum value described a survey completed 38 times over and four surveys
 * that never started, and the 38 was reported upward as progress. The discriminators below were
 * all present in the captured evidence the whole time; nothing was reading them.
 *
 * IT IS AN OBSERVATION, NOT A VERDICT (types.ts, THE ONE RULE). It reports what the walker's own
 * final screen carried, with the marker text QUOTED, and it is a fact about the WALK: `stalled`
 * says "this walk stopped while the screen was still offering controls", never "the survey is
 * broken"; `screened-out` says "the terminal page this walk landed on says the respondent does
 * not qualify", never "the survey wrongly screened us out".
 *
 * THE ORDER IS THE POLICY, and every arm records the evidence that carried it:
 *
 *   1. STILL LIVE  — an enabled control that advances the survey is still on the screen, or the
 *      walk stopped for its own reasons (a cap, an error, a submit that was refused). The walker
 *      gave up on a screen the respondent could have gone on from: `stalled`.
 *   2. SCREENED OUT — nothing left to press, and the page says the respondent does not qualify.
 *   3. COMPLETED   — nothing left to press, nothing left to answer, and either the page says the
 *      survey is finished or a progress indicator reads full.
 *   4. UNCLASSIFIED — nothing left to press and nothing said which kind of ending it was.
 *
 * `progress` is a CORROBORATOR and never a requirement: MEASURED on all four live SurveyJS
 * instruments, the completion page reports `progress.now: null`. A conjunction requiring 100%
 * would have classified every real completion as unknown.
 */
export function classifyEnding(
  final: RenderedScreen | null,
  ctx: {
    outcome: string;
    unboundDecisions: number;
    /**
     * HOW MANY OF THIS WALK'S ANSWERS THE HARNESS INVENTED, and how many controls it could not
     * answer at all. Optional so older callers are unaffected — but when they are present they
     * are ATTACHED TO THE ENDING, because that is the one place the difference changes what a
     * reader should conclude: a `screened-out` reached on fillers the navigator chose is
     * evidence about the fillers, not about the survey, and a consumer that cannot see the
     * difference will write up "the site screens respondents out here" about a screener
     * behaving exactly as documented.
     */
    navigatorDefaults?: number;
    unfillable?: UnfillableControl[];
  },
): WalkEnding {
  if (!final) {
    return {
      kind: "unclassified",
      evidence: [`this walk captured no final screen (outcome "${ctx.outcome}"), so there is nothing to read an ending from`],
    };
  }

  const advance = nextButton(final);
  const answerable = final.controls.filter(
    (c) => !c.disabled && !c.readOnly && (c.operable ?? c.visible) && (isValueEntry(c.type) || c.type === "radio" || c.type === "checkbox" || c.type === "select"),
  );
  /**
   * THE PROVENANCE LINE THAT TRAVELS WITH EVERY ENDING. Not decoration: the fix that widened
   * the walker's input types also made it likelier to reach a terminal page, and the value it
   * supplies to get there is invented. Whoever reads this ending has to be able to see that.
   */
  const provenance: string[] = [];
  if (typeof ctx.navigatorDefaults === "number" && ctx.navigatorDefaults > 0) {
    provenance.push(
      `${ctx.navigatorDefaults} answer(s) on this walk were navigator-defaults the harness chose, not answers the ` +
        `document asked for — so where this walk went is partly a fact about those fillers`,
    );
  }
  const named = ctx.unfillable ?? [];
  if (named.length > 0) {
    provenance.push(
      `${named.length} control(s) on this walk were NOT answered: ` +
        named.map((u) => `${u.type}${u.label ? ` "${u.label.slice(0, 40)}"` : ""} (${u.reason})`).join("; "),
    );
  }
  const text = `${final.questionText ?? ""}\n${final.visibleText ?? ""}`;
  const screenout = firstMatch(text, SCREENOUT_MARKERS);
  const completion = firstMatch(text, COMPLETION_MARKERS);
  const progressFull =
    final.progress.present &&
    typeof final.progress.now === "number" &&
    typeof final.progress.max === "number" &&
    final.progress.max > 0 &&
    final.progress.now >= final.progress.max;

  // ---- 1. the survey was still offering a way on ----
  if (advance) {
    return {
      kind: "stalled",
      evidence: [
        `the final screen still offered an enabled control that advances the survey (${advance.via}), so this walk ` +
          `stopped while the survey was still going`,
        `outcome "${ctx.outcome}"`,
        ...(ctx.unboundDecisions > 0 ? [`${ctx.unboundDecisions} planned decision(s) were never bound to a screen`] : []),
        ...provenance,
      ],
    };
  }
  // A walk that ended by ERROR, a CAP, or a submit the survey refused did not reach an ending —
  // whatever the last screen happens to say. Only a walk that ran out of survey can have ended.
  if (ctx.outcome !== "completed" && ctx.outcome !== "no-advance-control") {
    return {
      kind: "stalled",
      evidence: [
        `this walk terminated as "${ctx.outcome}" rather than by running out of survey, so its final screen is ` +
          `where it stopped and not where the survey ends`,
        ...(ctx.unboundDecisions > 0 ? [`${ctx.unboundDecisions} planned decision(s) were never bound to a screen`] : []),
        ...provenance,
      ],
    };
  }

  // ---- 2. turned away ----
  if (screenout) {
    return {
      kind: "screened-out",
      evidence: [
        `no enabled control advances the final screen`,
        `the final screen says: "${screenout}"`,
        ...(completion ? [`it also carries completion wording ("${completion}") — screen-out pages usually thank you too, which is why that is not read as a completion`] : []),
        ...provenance,
      ],
    };
  }

  // ---- 3. finished ----
  if (completion || progressFull) {
    return {
      kind: "completed",
      evidence: [
        `no enabled control advances the final screen`,
        ...(completion ? [`the final screen says: "${completion}"`] : []),
        ...(progressFull ? [`the progress indicator reads ${final.progress.now}/${final.progress.max}`] : []),
        `${answerable.length} answerable control(s) remain on it`,
        ...provenance,
      ],
    };
  }

  // ---- 4. an ending this reader cannot name ----
  return {
    kind: "unclassified",
    evidence: [
      `no enabled control advances the final screen, and nothing on it says which kind of ending this is: no ` +
        `screen-out wording, no completion wording, and ${final.progress.present ? "a progress indicator this reader could not read a value from" : "no progress indicator"}`,
      `${answerable.length} answerable control(s) remain on it`,
      `outcome "${ctx.outcome}"`,
      ...provenance,
    ],
  };
}

/** The screen the walk was looking at when it stopped — post-advance if it advanced, else the one it acted on. */
function finalScreenOf(steps: StepObservation[]): RenderedScreen | null {
  const last = steps.length > 0 ? steps[steps.length - 1] : undefined;
  if (!last) return null;
  return last.screenAfterAdvance ?? last.screenAfterAction ?? last.screenBefore ?? null;
}

/**
 * WALK ONE PLANNED PATH.
 *
 * Returns the observation record. Never throws for a survey-side problem — a crash, a
 * dead end and a blocked submit are all OBSERVATIONS, and turning them into exceptions
 * would lose the evidence that makes them findings.
 */
export async function walkPath(
  page: PageLike,
  path: PlannedPath,
  opts: WalkOptions,
  cap: CaptureContext,
): Promise<PathObservation> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const evidenceIds: string[] = [];
  const steps: StepObservation[] = [];
  const screenCaptures: ScreenCaptureEpoch[] = [];
  const captureFailures: ScreenCaptureFailure[] = [];
  const recordEpoch = (epoch: ScreenCaptureEpoch): ScreenCaptureEpoch => {
    screenCaptures.push(epoch);
    captureFailures.push(...epoch.captureFailures);
    evidenceIds.push(...captureIds(epoch));
    return epoch;
  };
  const recordCaptureFailure = (failure: ScreenCaptureFailure): ScreenCaptureFailure => {
    captureFailures.push(failure);
    return failure;
  };
  const stepEvidence = (
    screenBefore: string | null,
    screenAfterAdvance: string | null,
    epochs: ScreenCaptureEpoch[],
    extraFailures: ScreenCaptureFailure[] = [],
  ): StepObservation["evidence"] => {
    const failures = [...epochFailures(epochs), ...extraFailures];
    return {
      screenBefore,
      screenAfterAdvance,
      screenshots: screenshotIds(epochs),
      screenCaptures: epochs,
      captureFailures: failures,
      captureFailureCount: sumCaptureFailures(failures),
    };
  };

  page.on("pageerror", (e: unknown) => {
    const err = e as { message?: string; stack?: string };
    pageErrors.push(String(err?.message ?? e).slice(0, 500));
  });
  page.on("console", (m: unknown) => {
    const msg = m as { type?: () => string; text?: () => string };
    try {
      if (msg.type && msg.type() === "error" && msg.text) consoleErrors.push(msg.text().slice(0, 500));
    } catch {
      /* console message shapes vary; never let logging break a walk */
    }
  });

  await page.setViewport({ width: opts.viewport.width, height: opts.viewport.height });

  // Collect page script errors IN THE PAGE. The devtools `pageerror` event did not survive
  // the transport on a real run (the fixture threw at load and the event never arrived), so
  // liveness of the most important finding a QA run can make is not left to it.
  await page.evaluateOnNewDocument(ERROR_COLLECTOR);

  let shimNote: string | null = null;
  if (opts.applyHistoryShim) {
    await page.evaluateOnNewDocument(HISTORY_SHIM);
    shimNote =
      "One property descriptor was redefined before the site's script ran: window.history was made writable " +
      "so a top-level `var history = []` could not throw at load. No site file was edited; no other API was " +
      "stubbed, patched or intercepted. Every observation on this walk describes the survey the author " +
      "intended to ship, not the survey a respondent currently receives.";
  }

  let loadFailure: PathObservation["loadFailure"] = null;
  let outcome = "completed";
  let outcomeDetail: string | null = null;

  try {
    await page.goto(opts.surveyUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (err) {
    outcome = "error";
    outcomeDetail = `navigation failed: ${String(err).slice(0, 300)}`;
  }
  await sleep(400);

  let stepIndex = 0;
  // Repeating the same directed transition is only a cycle when its semantic answer receipt,
  // occurrence hints, and bounded incoming history repeat too. Template/roster screens may share
  // a screenSignature, and revisits may answer them differently; neither is collapsed here.
  const traversedTransitions = new Map<string, number>();
  const recentTransitionBases: string[] = [];
  let remaining: PlannedDecision[] = Array.isArray(path.decisions) ? [...path.decisions] : [];
  // EVERY question on this walk, including the ones already answered. A screen naming a
  // question whose decision has been used is evidence about which screen this is NOT, and the
  // binder needs that as much as it needs the pending list.
  const walkQuestionIds = (Array.isArray(path.decisions) ? path.decisions : []).map((d) => String(d.question ?? ""));
  // Path-level survival hints, for screens NO decision binds — sanitized once per walk.
  // See `survivalAvoidLabels` for the single consumer and the INPUT-never-EVIDENCE boundary.
  const pathHints = survivalHintsOf(path);
  // BOUNDED SCREEN-OUT RETRY: the walk-level filler variant, applied to EVERY
  // navigator-default choice on this walk (the main pass and the recovery pass alike) so
  // one attempt is one coherent variant. See WalkOptions.variant for the contract.
  const fillerVariant = opts.variant ?? 0;
  let bindingRefusalCount = 0;
  // WHAT THE READER COULD NOT DO, LIFTED TO THE WALK. A limitation named on screen 7 and
  // buried in screen 7's payload is a limitation nobody reads. Summed as well as listed,
  // because "we looked and found none" (0) and "nobody looked" (absent) are different claims.
  const readerLimitations: Array<{ stepIndex: number; kind: string; detail: string; count: number }> = [];
  const recordReaderLimitation = (kind: string, detail: string, count: number): void => {
    if (readerLimitations.some((row) => row.stepIndex === stepIndex && row.kind === kind)) return;
    readerLimitations.push({ stepIndex, kind, detail, count });
  };
  // AND WHAT THE WALKER COULD NOT ANSWER, lifted the same way and for the same reason. A
  // password field refused on screen 4 and left in screen 4's payload is a refusal nobody reads,
  // while the walk's own outcome says only "this screen offered no enabled control that advances
  // the survey" — a sentence indistinguishable from a normal ending.
  const unfillableControls: Array<UnfillableControl & { stepIndex: number }> = [];
  /** How many answers on this walk the harness invented. See PathObservation. */
  let navigatorDefaultAnswerCount = 0;
  const countDefaults = (as: PerformedAction[]): void => {
    for (const a of as) if (a.ok && typeof a.detail === "string" && a.detail.startsWith("navigator-default")) navigatorDefaultAnswerCount += 1;
  };
  /** The refusals raised on THIS screen, phrased for an `outcomeDetail`. */
  const nameUnfilled = (list: UnfillableControl[]): string =>
    list
      .map((u) => `<control type="${u.type}">${u.label ? ` "${u.label.slice(0, 60)}"` : ""}${u.required ? " (required)" : ""} — ${u.detail}`)
      .join("; ");

  while (stepIndex < opts.maxSteps && Date.now() < opts.deadline && outcome !== "error") {
    const stepT0 = Date.now();
    const errAt = pageErrors.length;

    let before: RenderedScreen;
    try {
      before = await read(page);
    } catch (err) {
      recordCaptureFailure(
        captureFailureRow(
          "screen-read-failed",
          `screen JSON read failed before step ${stepIndex}: ${errorText(err)}`,
          stepIndex,
          "before",
        ),
      );
      outcome = "error";
      outcomeDetail = `screen read failed: ${String(err).slice(0, 300)}`;
      break;
    }

    for (const ce of before.collectedErrors ?? []) {
      const line = `${ce.kind}: ${ce.message}${ce.source ? ` @ ${ce.source}:${ce.line ?? "?"}` : ""}`;
      if (!pageErrors.includes(line)) pageErrors.push(line);
    }

    for (const rl of before.readerLimitations ?? []) {
      readerLimitations.push({
        stepIndex,
        kind: String(rl.kind),
        detail: String(rl.detail),
        count: Number(rl.count) || 0,
      });
    }

    // THE LOAD CRASH IS A FINDING, NOT A HARNESS PROBLEM.
    //
    // "Nothing rendered" is NOT the same as "no controls": a survey whose script dies
    // still paints its static shell, so the first screen came back with a progress bar,
    // a Back button and a Next button — and a check for zero controls saw a normal
    // screen. The question this asks instead is whether the page has any QUESTION on it:
    // no options, no text input, no question text. A survey screen with none of those,
    // when the page also raised a script error, did not render.
    //
    // `valueInputs`, NOT `textInputs`, and that widening is the same lesson one type family
    // over: a screen whose only question is a slider or a date picker has ZERO text inputs, so
    // the narrow count scored it as "no question on the page" exactly as it once did a screen
    // whose only question was a number field. `?? textInputs` keeps a screen read by an older
    // reader on its old answer rather than on a missing field.
    const rendered =
      before.counts.options > 0 ||
      (before.counts.valueInputs ?? before.counts.textInputs) > 0 ||
      (before.counts.customWidgets ?? 0) > 0 ||
      before.controls.some((c) => c.visible && (c.tag === "select" || c.type === "select")) ||
      (before.questionText !== null && before.questionText.length > 0) ||
      before.grid !== null;
    if (stepIndex === 0 && !rendered && pageErrors.length > 0) {
      loadFailure = {
        message: pageErrors[0] ?? "unknown page error",
        stack: (before.collectedErrors ?? [])[0]?.stack ?? null,
        capturedAt: new Date().toISOString(),
      };
      // Capture all modalities before the trace's R2 write widens the browser epoch.
      recordEpoch(await captureScreenEpoch(page, cap, before, "load-failure", 0, opts.viewport));
      const evId = await captureFailure(
        cap,
        {
          what: "the survey threw during load and rendered no interactive control",
          url: opts.surveyUrl,
          pageErrors,
          consoleErrors,
          screenAtFailure: before,
          shimmed: opts.applyHistoryShim,
        },
        "load-failure",
      );
      evidenceIds.push(evId);
      outcome = "load-crash";
      outcomeDetail = loadFailure.message;
      break;
    }

    const beforeCapture = recordEpoch(
      await captureScreenEpoch(page, cap, before, "before", stepIndex, opts.viewport),
    );
    const beforeEv = beforeCapture.screenJson.evidenceId;

    // A generic one-question binder cannot safely choose an owner on a screen with multiple
    // disjoint visible question roots. Likewise it cannot choose DOM-first between multiple
    // usable forward controls. Capture first, then stop without binding, filling, defaulting,
    // or clicking; the pending decision stays pending and the walk cannot earn coverage.
    const rootCount = multiQuestionRootCount(before);
    const initialNavigation = resolveAdvanceControl(before);
    const initialStop =
      rootCount >= 2
        ? {
            kind: MULTI_QUESTION_ACTUATION_UNSUPPORTED,
            count: rootCount,
            detail: `screen ${stepIndex} exposes ${rootCount} distinct visible question roots; generic one-question actuation is unsupported`,
          }
        : initialNavigation.kind === "ambiguous"
          ? {
              kind: NAVIGATION_FORWARD_AMBIGUOUS,
              count: initialNavigation.candidates.length,
              detail:
                `screen ${stepIndex} exposes ${initialNavigation.candidates.length} usable forward candidates: ` +
                initialNavigation.candidates.map((row) => `#${row.idx} ${JSON.stringify(row.label)} via ${row.via}`).join("; "),
            }
          : null;
    if (initialStop) {
      recordReaderLimitation(initialStop.kind, initialStop.detail, initialStop.count);
      steps.push({
        stepIndex,
        decisionQuestion: null,
        decisionSource: "navigator-default",
        bindingVia: null,
        bindingRefusals: [],
        requested: null,
        screenBefore: before,
        screenAfterAction: null,
        screenAfterAdvance: null,
        actions: [],
        requestedButNotOffered: [],
        unfillableControls: [],
        advanced: false,
        blocked: false,
        blockedReason: initialStop.kind as BlockedReason,
        pageErrors: pageErrors.slice(errAt),
        consoleErrors: consoleErrors.slice(),
        evidence: stepEvidence(beforeEv, null, [beforeCapture]),
        wallMs: Date.now() - stepT0,
      });
      outcome = initialStop.kind;
      outcomeDetail = initialStop.detail;
      break;
    }

    // A REFUSED DECISION IS NOT CONSUMED. `splice` runs only on an actual binding, so a
    // decision this screen could not be identified as stays pending and is offered to every
    // later screen — which is the whole repair: the Q7 decision that used to be eaten by an
    // earlier screen's similar option label now survives to reach the real Q7.
    const binding = bindDecision(before, remaining, walkQuestionIds);
    const matched = binding.match;
    const decision = matched?.decision ?? null;
    if (matched) remaining.splice(matched.index, 1);
    bindingRefusalCount += binding.refusals.length;

    const { actions, notOffered, unfillable } = await applyDecision(page, before, decision, pathHints, fillerVariant);
    for (const u of unfillable) unfillableControls.push({ ...u, stepIndex });
    countDefaults(actions);

    const stepReadFailures: ScreenCaptureFailure[] = [];
    let afterAction: RenderedScreen | null = null;
    try {
      afterAction = await read(page);
    } catch (err) {
      const failure = recordCaptureFailure(
        captureFailureRow(
          "screen-read-failed",
          `screen JSON read failed after acting on step ${stepIndex}: ${errorText(err)}`,
          stepIndex,
          "after-action",
        ),
      );
      stepReadFailures.push(failure);
      afterAction = null;
    }

    const navigation = resolveAdvanceControl(afterAction ?? before);
    const nb = navigation.kind === "unique" ? navigation.control : null;
    const afterActionCapture = afterAction
      ? recordEpoch(
          await captureScreenEpoch(
            page,
            cap,
            afterAction,
            navigation.kind === "none" ? "final" : "after-action",
            stepIndex,
            opts.viewport,
          ),
        )
      : null;
    if (navigation.kind === "ambiguous") {
      const detail =
        `screen ${stepIndex} exposes ${navigation.candidates.length} usable forward candidates after answers were applied: ` +
        navigation.candidates.map((row) => `#${row.idx} ${JSON.stringify(row.label)} via ${row.via}`).join("; ");
      recordReaderLimitation(NAVIGATION_FORWARD_AMBIGUOUS, detail, navigation.candidates.length);
      const afterEv = afterActionCapture?.screenJson.evidenceId ?? null;
      const stepCaptures = [beforeCapture, ...(afterActionCapture ? [afterActionCapture] : [])];
      steps.push({
        stepIndex,
        decisionQuestion: decision ? String(decision.question ?? "") : null,
        decisionSource: decision ? (decision.action ? "probe" : "plan") : "navigator-default",
        bindingVia: matched?.via ?? null,
        bindingRefusals: binding.refusals,
        requested: decision
          ? { select: decision.select ?? [], textEntry: decision.text_entry?.value ?? null, action: decision.action ?? null }
          : null,
        screenBefore: before,
        screenAfterAction: afterAction,
        screenAfterAdvance: null,
        actions,
        requestedButNotOffered: notOffered,
        unfillableControls: unfillable,
        advanced: false,
        blocked: false,
        blockedReason: NAVIGATION_FORWARD_AMBIGUOUS,
        pageErrors: pageErrors.slice(errAt),
        consoleErrors: consoleErrors.slice(),
        evidence: stepEvidence(beforeEv, afterEv, stepCaptures, stepReadFailures),
        wallMs: Date.now() - stepT0,
      });
      outcome = NAVIGATION_FORWARD_AMBIGUOUS;
      outcomeDetail = detail;
      break;
    }
    if (!nb) {
      // No control advances the survey: either the end, or a dead end. Both are recorded
      // as what they are — the absence of an advance control on THIS complete screen.
      const afterEv = afterActionCapture?.screenJson.evidenceId ?? null;
      const stepCaptures = [beforeCapture, ...(afterActionCapture ? [afterActionCapture] : [])];
      steps.push({
        stepIndex,
        decisionQuestion: decision ? String(decision.question ?? "") : null,
        decisionSource: decision ? "plan" : "navigator-default",
        bindingVia: matched?.via ?? null,
        bindingRefusals: binding.refusals,
        requested: decision
          ? { select: decision.select ?? [], textEntry: decision.text_entry?.value ?? null, action: decision.action ?? null }
          : null,
        screenBefore: before,
        screenAfterAction: afterAction,
        screenAfterAdvance: null,
        actions,
        requestedButNotOffered: notOffered,
        unfillableControls: unfillable,
        advanced: false,
        // NOTE THE FLAGS, AND THE TRAP THEY SET. Nothing was submitted here, so `blocked`
        // stays false — yet `advanced` is false too. A disabled Next button lands on exactly
        // this path, so a reader asking "did the survey reject the input?" by looking at
        // `blocked` sees `false` and concludes "accepted" about a survey that never even
        // took the input. The reason field is what makes that case nameable.
        blocked: false,
        blockedReason: "no-advance-control",
        pageErrors: pageErrors.slice(errAt),
        consoleErrors: consoleErrors.slice(),
        evidence: stepEvidence(beforeEv, afterEv, stepCaptures, stepReadFailures),
        wallMs: Date.now() - stepT0,
      });
      outcome = "no-advance-control";
      // NAME THE UNANSWERED CONTROL, OR THIS SENTENCE IS A NORMAL ENDING.
      //
      // "screen N offered no enabled control that advances the survey" is exactly what a
      // thank-you page produces. It is ALSO what a screen produces when its Next button is
      // disabled until a field the walker refused — a password — is answered. One sentence, two
      // opposite meanings, and the walker is the only thing that can tell them apart, because it
      // is the only thing that knows it declined to fill something. So when it did, it says so
      // here, where an `outcome`-reading consumer cannot miss it.
      outcomeDetail =
        `screen ${stepIndex} offered no enabled control that advances the survey` +
        (unfillable.length > 0
          ? ` — AND THE WALKER LEFT ${unfillable.length} CONTROL(S) ON IT UNANSWERED, so this is not necessarily the ` +
            `end of the survey: ${nameUnfilled(unfillable)}`
          : "");
      break;
    }

    const clickRes = await clickIdx(page, nb.idx);
    actions.push({
      kind: "click-next",
      targetIdx: nb.idx,
      targetLabel: nb.label,
      targetCode: null,
      value: null,
      ok: clickRes.ok,
      // WHICH RULE CHOSE THIS CONTROL travels with the act. A press chosen because the control
      // named itself and a press chosen by elimination are different evidence — the second is
      // how a reader that could not classify a single SurveyJS button still advanced screen 1
      // and looked healthy doing it.
      detail: `${clickRes.detail} via ${nb.via}`,
    });

    // Did the survey move? The baseline is AFTER answers were applied, so answer-only state
    // cannot fake navigation. Identical templates may still move by URL, history occurrence,
    // or numeric progress; every signal that proves movement is persisted on the step.
    const advanceBaseline = afterAction ?? before;
    const sigBefore = advanceBaseline.screenSignature;
    let after: RenderedScreen | null = null;
    let advanced = false;
    let movementSignals: AdvanceSignal[] = [];
    let pollReadFailureCount = 0;
    let lastPollReadFailure: unknown = null;
    const waitUntil = Date.now() + opts.advanceTimeoutMs;
    while (Date.now() < waitUntil) {
      await sleep(180);
      try {
        after = await read(page);
      } catch (err) {
        pollReadFailureCount += 1;
        lastPollReadFailure = err;
        after = null;
        continue;
      }
      movementSignals = advanceSignals(advanceBaseline, after);
      if (movementSignals.length > 0) {
        advanced = true;
        break;
      }
    }
    if (pollReadFailureCount > 0) {
      const failure = recordCaptureFailure(
        captureFailureRow(
          "screen-read-failed",
          `${pollReadFailureCount} post-advance screen read(s) failed; last error: ${errorText(lastPollReadFailure)}`,
          stepIndex,
          advanced ? "advanced" : "blocked",
          new Date().toISOString(),
          pollReadFailureCount,
        ),
      );
      stepReadFailures.push(failure);
    }
    if (advanced) {
      const receipt = [...actions].reverse().find((action) => action.kind === "click-next");
      if (receipt) receipt.detail = `${receipt.detail ?? "click-next"}; advance-proof:${movementSignals.join("+")}`;
    }
    const afterWasRead = after !== null;
    if (!after) after = afterAction;

    // Never pair a CURRENT PNG/AX tree with the stale `afterAction` JSON fallback. If every
    // post-submit read failed, the missing epoch is named above and `afterEv` stays null.
    const afterCapture = afterWasRead && after
      ? recordEpoch(
          await captureScreenEpoch(page, cap, after, advanced ? "advanced" : "blocked", stepIndex, opts.viewport),
        )
      : null;
    const afterEv = afterCapture?.screenJson.evidenceId ?? null;
    const stepCaptures = [
      beforeCapture,
      ...(afterActionCapture ? [afterActionCapture] : []),
      ...(afterCapture ? [afterCapture] : []),
    ];

    let repeatedTransition: { firstStep: number; from: string; to: string } | null = null;
    if (advanced && after) {
      const transitionBase = JSON.stringify([
        sigBefore,
        screenOccurrenceFingerprint(afterAction ?? before),
        transitionActionFingerprint(actions),
        nb.idx,
        nb.label,
        after.screenSignature,
        screenOccurrenceFingerprint(after),
      ]);
      // Two incoming edges are enough to disambiguate a single legitimate revisit while still
      // bounding a deterministic A<->B loop. The context itself is bounded and cannot grow the
      // walk artifact or key without limit.
      const transitionKey = JSON.stringify([transitionBase, recentTransitionBases.slice(-2)]);
      const firstStep = traversedTransitions.get(transitionKey);
      if (firstStep === undefined) traversedTransitions.set(transitionKey, stepIndex);
      else repeatedTransition = { firstStep, from: sigBefore, to: after.screenSignature };
      recentTransitionBases.push(transitionBase);
      if (recentTransitionBases.length > 2) recentTransitionBases.shift();
    }

    steps.push({
      stepIndex,
      decisionQuestion: decision ? String(decision.question ?? "") : null,
      decisionSource: decision ? (decision.action ? "probe" : "plan") : "navigator-default",
      bindingVia: matched?.via ?? null,
      bindingRefusals: binding.refusals,
      requested: decision
        ? { select: decision.select ?? [], textEntry: decision.text_entry?.value ?? null, action: decision.action ?? null }
        : null,
      screenBefore: before,
      screenAfterAction: afterAction,
      screenAfterAdvance: after,
      actions,
      requestedButNotOffered: notOffered,
      unfillableControls: unfillable,
      advanced,
      // `blocked` IS STILL JUST `!advanced` — it is the outcome of a polling race and it says
      // nothing about the survey's opinion of the input. That is precisely why the next line
      // exists: it records which of the three distinguishable things the walker actually saw
      // when the race was lost, so no later stage has to guess which one it was.
      blocked: !advanced,
      blockedReason: advanced ? null : whyBlocked(before, afterAction, after),
      pageErrors: pageErrors.slice(errAt),
      consoleErrors: consoleErrors.slice(),
      evidence: stepEvidence(beforeEv, afterEv, stepCaptures, stepReadFailures),
      wallMs: Date.now() - stepT0,
    });

    if (repeatedTransition) {
      outcome = "cycle-detected";
      outcomeDetail =
        `walk stopped after repeating the exact screen transition first traversed at step ` +
        `${repeatedTransition.firstStep}: ${JSON.stringify(repeatedTransition.from).slice(0, 180)} -> ` +
        `${JSON.stringify(repeatedTransition.to).slice(0, 180)} through control #${nb.idx} ` +
        `${JSON.stringify(nb.label)}. Repeated traversal is bounded evidence of a cycle, not a new observation.`;
      break;
    }

    if (!advanced) {
      // A BLOCKED SUBMIT IS THE POINT OF A BOUNDARY PROBE. Record it, then recover by
      // answering validly so the remainder of the walk still happens; a probe that ends
      // the walk would cost every downstream observation on this path.
      const wasProbe = decision?.action !== undefined || decision?.text_entry?.value === "";
      // THE RECOVERY MUST ANSWER VALIDLY, AND `PROBE_TEXT` IS NOT A VALID ANSWER TO MOST
      // CONTROLS. This used to force `text_entry: { value: "QA-PROBE" }`, which travels the
      // PLANNED path — so the recovery typed letters into number fields and assigned nonsense to
      // date pickers, which discard it, leaving the walk blocked and reporting "the survey did
      // not advance even after a valid answer" about an answer that never landed. That is the
      // exact defect D42 fixed on the first pass and left standing on the recovery pass. Leaving
      // `text_entry` off makes every control take its own per-type navigator default, which is
      // what "answer validly" has to mean once the walker knows more than one kind of input.
      // THE RECOVERY CONSUMES THE SAME SURVIVAL HINTS AS THE FIRST PASS. The synthetic
      // decision below is non-null, so inside `applyDecision` `survivalAvoidLabels` reads
      // only ITS `avoid_labels` — left unstamped they were [], and the re-pick could take
      // the documented screen-out label the first pass deliberately steered around (hints
      // steer S3 off "Market research"; something else blocks; the recovery re-picked
      // position-1 and the walk died on the exact answer the hints exist to avoid). So the
      // first pass's avoid set is RE-DERIVED from the same sources with the same
      // precedence — the bound decision's own `avoid_labels`, else the path's hints by
      // offered-label overlap. This is an input-stamping site, not a new consumer: the
      // option default inside `applyDecision` remains the ONE consumer of hints.
      const recovery = await applyDecision(
        page,
        after ?? before,
        {
          question: decision?.question ?? "",
          select: decision?.select ?? [],
          source: "recovery",
          avoid_labels: survivalAvoidLabels(decision, pathHints, after ?? before),
        } as PlannedDecision,
        pathHints,
        fillerVariant,
      );
      const recoveryReadFailures: ScreenCaptureFailure[] = [];
      let recoveryBaseline: RenderedScreen | null = null;
      try {
        recoveryBaseline = await read(page);
      } catch (err) {
        recoveryReadFailures.push(recordCaptureFailure(
          captureFailureRow(
            "screen-read-failed",
            `screen JSON read failed after recovery answers on step ${stepIndex}: ${errorText(err)}`,
            stepIndex,
            "recovery-after-action",
          ),
        ));
      }
      const recoveryNavigation = recoveryBaseline ? resolveAdvanceControl(recoveryBaseline) : { kind: "none" as const, candidates: [] };
      const recoveryAmbiguity = recoveryNavigation.kind === "ambiguous"
        ? `screen ${stepIndex} exposes ${recoveryNavigation.candidates.length} usable forward candidates after recovery answers`
        : null;
      let recoveryClicked = false;
      if (recoveryNavigation.kind === "unique") {
        const again = await clickIdx(page, recoveryNavigation.control.idx);
        recoveryClicked = again.ok;
        recovery.actions.push({
          kind: "click-next",
          targetIdx: recoveryNavigation.control.idx,
          targetLabel: recoveryNavigation.control.label,
          targetCode: null,
          value: null,
          ok: again.ok,
          detail: `recovery-after-block (${again.detail}) via ${recoveryNavigation.control.via}`,
        });
      } else if (recoveryAmbiguity) {
        recordReaderLimitation(NAVIGATION_FORWARD_AMBIGUOUS, recoveryAmbiguity, recoveryNavigation.candidates.length);
      }
      if (recoveryClicked) await sleep(600);
      let recovered: RenderedScreen | null = null;
      try {
        recovered = await read(page);
      } catch (err) {
        const failure = recordCaptureFailure(
          captureFailureRow(
            "screen-read-failed",
            `screen JSON read failed after recovery on step ${stepIndex}: ${errorText(err)}`,
            stepIndex,
            "recovery",
          ),
        );
        recoveryReadFailures.push(failure);
        recovered = null;
      }
      const recoveredCapture = recovered
        ? recordEpoch(
            await captureScreenEpoch(page, cap, recovered, "recovery", stepIndex, opts.viewport),
          )
        : null;
      const recoveredEv = recoveredCapture?.screenJson.evidenceId ?? null;
      const recoveryMovement =
        recoveryClicked && recoveryBaseline && recovered ? advanceSignals(recoveryBaseline, recovered) : [];
      if (recoveryMovement.length > 0) {
        const receipt = [...recovery.actions].reverse().find((action) => action.kind === "click-next");
        if (receipt) receipt.detail = `${receipt.detail ?? "click-next"}; advance-proof:${recoveryMovement.join("+")}`;
      }
      const recoveryBeforeCapture = afterCapture ?? afterActionCapture ?? beforeCapture;
      const recoveryCaptures = [recoveryBeforeCapture, ...(recoveredCapture ? [recoveredCapture] : [])];
      steps.push({
        stepIndex: stepIndex + 0.5,
        decisionQuestion: decision ? String(decision.question ?? "") : null,
        decisionSource: "recovery",
        // `textEntry: null` because the recovery no longer forces one value on every control —
        // each takes its own per-type navigator default, and the actions record what each got.
        requested: { select: decision?.select ?? [], textEntry: null, action: "recover-after-block" },
        screenBefore: after ?? before,
        screenAfterAction: recoveryBaseline,
        screenAfterAdvance: recovered,
        actions: recovery.actions,
        requestedButNotOffered: recovery.notOffered,
        unfillableControls: recovery.unfillable,
        advanced: recoveryMovement.length > 0,
        blocked: recoveryClicked && recoveryMovement.length === 0,
        blockedReason:
          recoveryAmbiguity
            ? NAVIGATION_FORWARD_AMBIGUOUS
            : recoveryClicked && recoveryMovement.length === 0
              ? whyBlocked(recoveryBaseline, recoveryBaseline, recovered)
            : null,
        pageErrors: pageErrors.slice(errAt),
        consoleErrors: [],
        evidence: stepEvidence(null, recoveredEv, recoveryCaptures, recoveryReadFailures),
        wallMs: 0,
      });
      for (const u of recovery.unfillable) unfillableControls.push({ ...u, stepIndex: stepIndex + 0.5 });
      if (recoveryAmbiguity) {
        outcome = NAVIGATION_FORWARD_AMBIGUOUS;
        outcomeDetail = recoveryAmbiguity;
        break;
      }
      if (!recoveryClicked || recoveryMovement.length === 0) {
        outcome = wasProbe ? "blocked-after-probe" : "blocked";
        // SAME RULE AS ABOVE, and it matters more here: "the survey did not advance even after a
        // valid answer" is a claim that the answer WAS valid. If the walker left a control on
        // that screen unanswered, it was not, and the sentence would blame the survey for the
        // harness's own gap.
        const unfilledHere = [...unfillable, ...recovery.unfillable];
        outcomeDetail =
          `the survey did not advance from screen ${stepIndex} even after a valid answer` +
          (unfilledHere.length > 0
            ? ` — THOUGH THE WALKER LEFT ${unfilledHere.length} CONTROL(S) ON IT UNANSWERED, so "a valid answer" ` +
              `overstates what was submitted: ${nameUnfilled(unfilledHere)}`
            : "") +
          (after?.validationMessages.length ? `; validation said: ${after.validationMessages.join(" | ")}` : "");
        break;
      }
    }

    stepIndex += 1;
  }

  if (outcome === "completed" && stepIndex >= opts.maxSteps) {
    outcome = "step-cap";
    outcomeDetail = `walk hit the ${opts.maxSteps}-screen cap without reaching a screen that offers no advance control`;
  }
  if (outcome === "completed" && Date.now() >= opts.deadline) {
    outcome = "time-cap";
    outcomeDetail = "walk hit its wall-clock budget";
  }

  // HOW THIS WALK ENDED, typed from the final screen. Computed for EVERY outcome, not only the
  // terminal ones: a walk that hit a cap or a block has an ending too — `stalled` — and leaving
  // the field off those artifacts would make "we did not classify it" and "it did not end"
  // indistinguishable again, one level up from the defect this closes.
  const unbound = remaining.length;
  const ending = classifyEnding(finalScreenOf(steps), {
    outcome,
    unboundDecisions: unbound,
    navigatorDefaults: navigatorDefaultAnswerCount,
    unfillable: unfillableControls,
  });

  const obs: PathObservation = {
    kind: "v2-path-observation/1.0.0",
    runId: opts.runId,
    pathId: path.id,
    tier: opts.tier,
    attemptId: opts.attemptId,
    planRevisionId: opts.planRevisionId,
    surveyUrl: opts.surveyUrl,
    startedAt,
    endedAt: new Date().toISOString(),
    wallMs: Date.now() - t0,
    plannedWitnesses: Array.isArray(path.witnesses) ? path.witnesses : [],
    steps,
    outcome,
    outcomeDetail,
    ending,
    shimmed: opts.applyHistoryShim,
    shimNote,
    loadFailure,
    // WHAT THIS WALK DID NOT DO, in the walk's own words. `remaining` at the end is exactly
    // the decisions no screen was ever identified as; every one of them used to be either
    // spent on the wrong screen or quietly forgotten.
    unboundDecisions: remaining.map((d) => ({
      question: String(d.question ?? ""),
      wanted: Array.isArray(d.select) ? [...d.select] : [],
      reason:
        "no screen on this walk was identified as this question — the walk ended without ever binding it, so " +
        "nothing here witnesses it",
    })),
    bindingRefusalCount,
    readerLimitations,
    readerLimitationCount: readerLimitations.reduce((n, l) => n + l.count, 0),
    // WHAT THIS WALK DID NOT ANSWER, and how much of what it DID answer it made up. Present-but-
    // empty is a claim ("we met nothing we could not answer"); absent is a walk from before the
    // check existed. A consumer may never read the one as the other.
    unfillableControls,
    unfillableControlCount: unfillableControls.length,
    navigatorDefaultAnswerCount,
    // New reader: present-but-empty means every attempted visual/AX capture completed. Older
    // artifacts omit all four fields and therefore never masquerade as checked-and-clean.
    screenCaptures,
    screenCaptureCount: screenCaptures.length,
    captureFailures,
    captureFailureCount: sumCaptureFailures(captureFailures),
    evidenceIds,
    viewport: opts.viewport,
  };

  const obsEv = await capturePathObservation(cap, obs);
  obs.evidenceIds = [...evidenceIds, obsEv];
  obs.observationEvidenceId = obsEv;
  return obs;
}

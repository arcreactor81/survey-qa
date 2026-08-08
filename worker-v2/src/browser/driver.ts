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

import { CONTROL_SELECTOR, ERROR_COLLECTOR, HISTORY_SHIM, LABEL_SELECTOR, READ_SCREEN, clearValueScript } from "./page-script";
import type {
  BindingRefusal,
  BlockedReason,
  PathObservation,
  PerformedAction,
  RenderedScreen,
  StepObservation,
} from "./types";
import type { CaptureContext } from "./capture";
import { capturePathObservation, captureFailure, captureScreenJson, captureScreenshot } from "./capture";
import type { PlannedDecision, PlannedPath } from "../workflow/stages/planner/plan-core.js";

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
 *   5. OPTION-LABEL OVERLAP NEVER BINDS. It is recorded in `via` when something else bound,
 *      and when it is the ONLY thing present the decision is REFUSED as `option-labels-only`.
 *      That single rule is the defect: two questions may offer the same words.
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

async function shoot(page: PageLike): Promise<Uint8Array | null> {
  try {
    const out = await page.screenshot({ type: "png", fullPage: false, encoding: "binary" });
    if (out instanceof Uint8Array) return out;
    if (out instanceof ArrayBuffer) return new Uint8Array(out);
    if (typeof out === "string") {
      const bin = atob(out);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    return null;
  } catch {
    return null;
  }
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

async function typeIdx(page: PageLike, idx: number, value: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await page.evaluate(clearValueScript(idx));
    if (value.length === 0) return { ok: true, detail: "cleared" };
    const handles = await page.$$(CONTROL_SELECTOR);
    const h = handles[idx];
    if (!h) return { ok: false, detail: "no-control-at-index" };
    await h.click();
    await h.type(value, { delay: 8 });
    return { ok: true, detail: "keyboard-type" };
  } catch (err) {
    return { ok: false, detail: String(err).slice(0, 200) };
  }
}

/** Apply one decision to the screen in front of us. Returns what was actually done. */
async function applyDecision(
  page: PageLike,
  screen: RenderedScreen,
  decision: PlannedDecision | null,
): Promise<{ actions: PerformedAction[]; notOffered: string[] }> {
  const actions: PerformedAction[] = [];
  const notOffered: string[] = [];
  const wanted = decision && Array.isArray(decision.select) ? decision.select : [];
  const strategy = String(decision?.strategy ?? "");
  const probeAction = String(decision?.action ?? "");
  /** How the reader said THIS control is actuated. Grid cells carry only an index. */
  const actuation = (idx: number) => screen.controls.find((c) => c.idx === idx) ?? null;

  // ---- grid / matrix screens: every row must be answered before the screen advances ----
  if (screen.grid && screen.grid.rows.length > 0) {
    const m = /grid:answer-every-row with "(.+?)"/.exec(strategy);
    const wantColumn = m ? m[1] : (wanted[0] ?? null);
    for (const row of screen.grid.rows) {
      const wantedCell = wantColumn ? row.cells.find((c) => c.column && labelMatches(c.column, wantColumn)) : null;
      const cell = wantedCell ?? row.cells[0];
      if (!cell) continue;
      const r = await clickIdx(page, cell.idx, actuation(cell.idx));
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
        ok: r.ok,
        detail: how ? `${how} (${r.detail})` : r.detail,
      });
    }
  }

  // ---- option groups ----
  for (const g of screen.optionGroups) {
    if (screen.grid && screen.grid.rows.some((r) => r.name && r.name === g.name)) continue; // handled above
    const matches = wanted
      .map((w) => ({ w, opt: g.options.find((o) => labelMatches(o.label, w)) }))
      .filter((x) => x.opt);
    if (matches.length === 0) continue;
    for (const { w, opt } of matches) {
      if (!opt) continue;
      if (opt.checked) {
        actions.push({
          kind: "click-option",
          targetIdx: opt.idx,
          targetLabel: opt.label,
          targetCode: opt.code,
          value: null,
          ok: true,
          detail: "already-selected",
        });
        continue;
      }
      const r = await clickIdx(page, opt.idx, opt);
      actions.push({
        kind: "click-option",
        targetIdx: opt.idx,
        targetLabel: opt.label,
        targetCode: opt.code,
        value: w,
        ok: r.ok,
        // A requested label that lands on a control NO RESPONDENT COULD REACH is still
        // clicked — the plan asked for it, and refusing here would silently drop a documented
        // answer — but it is never recorded as an ordinary click. A responsive site renders
        // its grid twice (a table and a `display:none` stacked list), and both copies offer
        // the same labels; this is what tells the two apart afterwards.
        detail: (opt.operable ?? true) ? r.detail : `not-operable:${opt.actuatedVia ?? "unknown"} (${r.detail})`,
      });
    }
  }

  // Requested answers the screen never offered. Recorded; NOT judged.
  for (const w of wanted) {
    const offered = screen.optionGroups.some((g) => g.options.some((o) => labelMatches(o.label, w)));
    if (!offered) notOffered.push(w);
  }

  // ---- default: nothing requested matched, so answer enough to advance ----
  const answeredSomething = actions.some((a) => a.ok && a.kind !== "type-text");
  if (!answeredSomething && !screen.grid) {
    for (const g of screen.optionGroups) {
      if (g.options.some((o) => o.checked)) continue;
      // `answerable`, NOT `visible` — see the comment on answerable(). This is the line that
      // made a 0-10 NPS score unreachable and answered "Don't know" instead.
      const first = g.options.find((o) => answerable(o));
      if (!first) continue;
      const r = await clickIdx(page, first.idx, first);
      actions.push({
        kind: "click-option",
        targetIdx: first.idx,
        targetLabel: first.label,
        targetCode: first.code,
        value: null,
        ok: r.ok,
        detail: `navigator-default:first-option (${r.detail})`,
      });
      if (g.kind === "radio") continue;
      break;
    }
  }

  // ---- free text ----
  // DELIBERATELY STILL `visible`, not `answerable`. Label-mediated actuation is an affordance
  // of a radio or a checkbox — the label IS the control on screen. A text field drawn at zero
  // opacity offers a respondent nothing to type into, and the commonest reason a form contains
  // one is that it is a HONEYPOT waiting for an automated agent to fill it in.
  const textControls = screen.controls.filter(
    (c) => c.visible && !c.disabled && !c.readOnly && (c.type === "text" || c.type === "textarea" || c.type === "number" || c.type === "email"),
  );
  const wantsBlank = probeAction === "leave-blank-and-continue" || decision?.text_entry?.value === "";
  for (const c of textControls) {
    if (wantsBlank) {
      const r = await typeIdx(page, c.idx, "");
      actions.push({ kind: "clear-text", targetIdx: c.idx, targetLabel: c.label, targetCode: null, value: "", ok: r.ok, detail: `probe:leave-blank (${r.detail})` });
      continue;
    }
    const value = decision?.text_entry?.value ?? PROBE_TEXT;
    if (c.value && c.value.length > 0) continue;
    const r = await typeIdx(page, c.idx, value);
    actions.push({ kind: "type-text", targetIdx: c.idx, targetLabel: c.label, targetCode: null, value, ok: r.ok, detail: r.detail });
  }

  return { actions, notOffered };
}

function nextButton(screen: RenderedScreen): { idx: number; label: string } | null {
  const cands = screen.buttons.filter((b) => b.visible && !b.disabled);
  const next = cands.find((b) => b.role === "next");
  if (next) return { idx: next.idx, label: next.label };
  const only = cands.filter((b) => b.role !== "back");
  if (only.length === 1 && only[0]) return { idx: only[0].idx, label: only[0].label };
  return null;
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
  let remaining: PlannedDecision[] = Array.isArray(path.decisions) ? [...path.decisions] : [];
  // EVERY question on this walk, including the ones already answered. A screen naming a
  // question whose decision has been used is evidence about which screen this is NOT, and the
  // binder needs that as much as it needs the pending list.
  const walkQuestionIds = (Array.isArray(path.decisions) ? path.decisions : []).map((d) => String(d.question ?? ""));
  let bindingRefusalCount = 0;
  // WHAT THE READER COULD NOT DO, LIFTED TO THE WALK. A limitation named on screen 7 and
  // buried in screen 7's payload is a limitation nobody reads. Summed as well as listed,
  // because "we looked and found none" (0) and "nobody looked" (absent) are different claims.
  const readerLimitations: Array<{ stepIndex: number; kind: string; detail: string; count: number }> = [];

  while (stepIndex < opts.maxSteps && Date.now() < opts.deadline && outcome !== "error") {
    const stepT0 = Date.now();
    const errAt = pageErrors.length;

    let before: RenderedScreen;
    try {
      before = await read(page);
    } catch (err) {
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
    const rendered =
      before.counts.options > 0 ||
      before.counts.textInputs > 0 ||
      (before.questionText !== null && before.questionText.length > 0) ||
      before.grid !== null;
    if (stepIndex === 0 && !rendered && pageErrors.length > 0) {
      loadFailure = {
        message: pageErrors[0] ?? "unknown page error",
        stack: (before.collectedErrors ?? [])[0]?.stack ?? null,
        capturedAt: new Date().toISOString(),
      };
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
      const png = await shoot(page);
      if (png) evidenceIds.push(await captureScreenshot(cap, png, "load-failure", 0));
      outcome = "load-crash";
      outcomeDetail = loadFailure.message;
      break;
    }

    const beforeEv = await captureScreenJson(cap, before, "before", stepIndex);
    evidenceIds.push(beforeEv);
    const beforePng = await shoot(page);
    const shots: string[] = [];
    if (beforePng) {
      const id = await captureScreenshot(cap, beforePng, "before", stepIndex);
      shots.push(id);
      evidenceIds.push(id);
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

    const { actions, notOffered } = await applyDecision(page, before, decision);

    let afterAction: RenderedScreen | null = null;
    try {
      afterAction = await read(page);
    } catch {
      afterAction = null;
    }

    const nb = nextButton(afterAction ?? before);
    if (!nb) {
      // No control advances the survey: either the end, or a dead end. Both are recorded
      // as what they are — the absence of an advance control on THIS complete screen.
      const afterEv = afterAction ? await captureScreenJson(cap, afterAction, "final", stepIndex) : null;
      if (afterEv) evidenceIds.push(afterEv);
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
        evidence: { screenBefore: beforeEv, screenAfterAdvance: afterEv, screenshots: shots },
        wallMs: Date.now() - stepT0,
      });
      outcome = "no-advance-control";
      outcomeDetail = `screen ${stepIndex} offered no enabled control that advances the survey`;
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
      detail: clickRes.detail,
    });

    // Did the survey move? Poll the screen signature rather than waiting on navigation:
    // a single-page survey never navigates, and `waitForNavigation` would time out on
    // every screen of one.
    const sigBefore = (afterAction ?? before).screenSignature;
    let after: RenderedScreen | null = null;
    let advanced = false;
    const waitUntil = Date.now() + opts.advanceTimeoutMs;
    while (Date.now() < waitUntil) {
      await sleep(180);
      try {
        after = await read(page);
      } catch {
        after = null;
        continue;
      }
      if (after.screenSignature !== sigBefore) {
        advanced = true;
        break;
      }
    }
    if (!after) after = afterAction;

    const afterEv = after ? await captureScreenJson(cap, after, advanced ? "advanced" : "blocked", stepIndex) : null;
    if (afterEv) evidenceIds.push(afterEv);
    if (!advanced) {
      const png = await shoot(page);
      if (png) {
        const id = await captureScreenshot(cap, png, "blocked", stepIndex);
        shots.push(id);
        evidenceIds.push(id);
      }
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
      advanced,
      // `blocked` IS STILL JUST `!advanced` — it is the outcome of a polling race and it says
      // nothing about the survey's opinion of the input. That is precisely why the next line
      // exists: it records which of the three distinguishable things the walker actually saw
      // when the race was lost, so no later stage has to guess which one it was.
      blocked: !advanced,
      blockedReason: advanced ? null : whyBlocked(before, afterAction, after),
      pageErrors: pageErrors.slice(errAt),
      consoleErrors: consoleErrors.slice(),
      evidence: { screenBefore: beforeEv, screenAfterAdvance: afterEv, screenshots: shots },
      wallMs: Date.now() - stepT0,
    });

    if (!advanced) {
      // A BLOCKED SUBMIT IS THE POINT OF A BOUNDARY PROBE. Record it, then recover by
      // answering validly so the remainder of the walk still happens; a probe that ends
      // the walk would cost every downstream observation on this path.
      const wasProbe = decision?.action !== undefined || decision?.text_entry?.value === "";
      const recovery = await applyDecision(page, after ?? before, {
        question: decision?.question ?? "",
        select: decision?.select ?? [],
        source: "recovery",
        text_entry: { required: true, value: PROBE_TEXT },
      } as PlannedDecision);
      const again = await clickIdx(page, nb.idx);
      recovery.actions.push({
        kind: "click-next",
        targetIdx: nb.idx,
        targetLabel: nb.label,
        targetCode: null,
        value: null,
        ok: again.ok,
        detail: `recovery-after-block (${again.detail})`,
      });
      await sleep(600);
      let recovered: RenderedScreen | null = null;
      try {
        recovered = await read(page);
      } catch {
        recovered = null;
      }
      const recoveredEv = recovered ? await captureScreenJson(cap, recovered, "recovery", stepIndex) : null;
      if (recoveredEv) evidenceIds.push(recoveredEv);
      steps.push({
        stepIndex: stepIndex + 0.5,
        decisionQuestion: decision ? String(decision.question ?? "") : null,
        decisionSource: "recovery",
        requested: { select: decision?.select ?? [], textEntry: PROBE_TEXT, action: "recover-after-block" },
        screenBefore: after ?? before,
        screenAfterAction: null,
        screenAfterAdvance: recovered,
        actions: recovery.actions,
        requestedButNotOffered: recovery.notOffered,
        advanced: !!recovered && recovered.screenSignature !== (after ?? before).screenSignature,
        blocked: !!recovered && recovered.screenSignature === (after ?? before).screenSignature,
        blockedReason:
          !!recovered && recovered.screenSignature === (after ?? before).screenSignature
            ? whyBlocked(after ?? before, null, recovered)
            : null,
        pageErrors: pageErrors.slice(errAt),
        consoleErrors: [],
        evidence: { screenBefore: null, screenAfterAdvance: recoveredEv, screenshots: [] },
        wallMs: 0,
      });
      if (recovered && recovered.screenSignature === (after ?? before).screenSignature) {
        outcome = wasProbe ? "blocked-after-probe" : "blocked";
        outcomeDetail = `the survey did not advance from screen ${stepIndex} even after a valid answer` +
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
    evidenceIds,
    viewport: opts.viewport,
  };

  const obsEv = await capturePathObservation(cap, obs);
  obs.evidenceIds = [...evidenceIds, obsEv];
  return obs;
}

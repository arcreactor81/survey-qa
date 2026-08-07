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
 * 2. THE PLAN IS MATCHED TO THE SCREEN, NOT ASSUMED TO ALIGN WITH IT. A survey that
 *    routes differently than the contract implies would silently desynchronise a driver
 *    that walked decisions positionally: decision 6 would be typed into question 9 and
 *    every observation after it would be mislabelled. Decisions are matched to the screen
 *    in front of us by question token and by option-label overlap; a screen no decision
 *    matches is answered by an explicit `navigator-default` that is RECORDED as such.
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

import { CONTROL_SELECTOR, ERROR_COLLECTOR, HISTORY_SHIM, READ_SCREEN, clearValueScript } from "./page-script";
import type { PathObservation, PerformedAction, RenderedScreen, StepObservation } from "./types";
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

/**
 * Which planned decision is this screen?
 *
 * Two independent signals, and the stronger one wins:
 *   - the question TOKEN ("Q7", "S1", "D1") appearing as a word on the screen;
 *   - how many of the decision's requested answer labels the screen actually offers.
 * A screen that matches nothing returns null and is answered by an explicit default.
 */
export function matchDecision(
  screen: RenderedScreen,
  remaining: PlannedDecision[],
): { decision: PlannedDecision; index: number; via: string } | null {
  const haystack = norm(`${screen.questionText ?? ""} ${screen.visibleText.slice(0, 600)}`);
  const offered = screen.optionGroups.flatMap((g) => g.options.map((o) => o.label));

  let best: { decision: PlannedDecision; index: number; via: string; score: number } | null = null;
  remaining.forEach((d, i) => {
    let score = 0;
    let via = "";
    const token = norm(String(d.question ?? ""));
    if (token && new RegExp(`(^| )${token}( |$)`).test(haystack)) {
      score += 10;
      via = `question-token:${d.question}`;
    }
    const wanted = Array.isArray(d.select) ? d.select : [];
    const hits = wanted.filter((w) => offered.some((o) => labelMatches(o, w))).length;
    if (hits > 0) {
      score += hits * 3;
      via = via ? `${via}+options:${hits}` : `options:${hits}`;
    }
    // Earlier decisions win ties: the plan is an ordered walk, not a set.
    score -= i * 0.01;
    if (score > 0 && (!best || score > best.score)) best = { decision: d, index: i, via, score };
  });
  if (!best) return null;
  const b = best as { decision: PlannedDecision; index: number; via: string; score: number };
  return { decision: b.decision, index: b.index, via: b.via };
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

/** Click a control by its index in the reader's order. Real element click first. */
async function clickIdx(page: PageLike, idx: number): Promise<{ ok: boolean; detail: string }> {
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

  // ---- grid / matrix screens: every row must be answered before the screen advances ----
  if (screen.grid && screen.grid.rows.length > 0) {
    const m = /grid:answer-every-row with "(.+?)"/.exec(strategy);
    const wantColumn = m ? m[1] : (wanted[0] ?? null);
    for (const row of screen.grid.rows) {
      const cell =
        (wantColumn ? row.cells.find((c) => c.column && labelMatches(c.column, wantColumn)) : null) ??
        row.cells[0];
      if (!cell) continue;
      const r = await clickIdx(page, cell.idx);
      actions.push({
        kind: "select-grid-cell",
        targetIdx: cell.idx,
        targetLabel: `${row.label} / ${cell.column ?? "col?"}`,
        targetCode: cell.code,
        value: null,
        ok: r.ok,
        detail: r.detail,
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
      const r = await clickIdx(page, opt.idx);
      actions.push({
        kind: "click-option",
        targetIdx: opt.idx,
        targetLabel: opt.label,
        targetCode: opt.code,
        value: w,
        ok: r.ok,
        detail: r.detail,
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
      const first = g.options.find((o) => o.visible && !o.disabled);
      if (!first) continue;
      const r = await clickIdx(page, first.idx);
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

    const matched = matchDecision(before, remaining);
    const decision = matched?.decision ?? null;
    if (matched) remaining.splice(matched.index, 1);

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
        requested: decision
          ? { select: decision.select ?? [], textEntry: decision.text_entry?.value ?? null, action: decision.action ?? null }
          : null,
        screenBefore: before,
        screenAfterAction: afterAction,
        screenAfterAdvance: null,
        actions,
        requestedButNotOffered: notOffered,
        advanced: false,
        blocked: false,
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
      requested: decision
        ? { select: decision.select ?? [], textEntry: decision.text_entry?.value ?? null, action: decision.action ?? null }
        : null,
      screenBefore: before,
      screenAfterAction: afterAction,
      screenAfterAdvance: after,
      actions,
      requestedButNotOffered: notOffered,
      advanced,
      blocked: !advanced,
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
    evidenceIds,
    viewport: opts.viewport,
  };

  const obsEv = await capturePathObservation(cap, obs);
  obs.evidenceIds = [...evidenceIds, obsEv];
  return obs;
}

// walker.ts — Browser Rendering walker that steps through a SurveyJS survey,
// capturing each page's visible text and a full-page screenshot, answering
// questions generically so navigation/validation lets us advance.

import puppeteer from "@cloudflare/puppeteer";
import type { BrowserWorker, Page } from "@cloudflare/puppeteer";
import type { Env, PageCapture } from "./types";

const MAX_ITERATIONS = 12;
const GOTO_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 15_000;
const SETTLE_MS = 500;
const POST_CLICK_MS = 800;
const POST_CLICK_RETRY_MS = 700;

const SURVEY_READY_SELECTOR = ".sd-page, .sv-page, .sd-root-modern, form";

/*
 * Minimal DOM typings for code executed inside page.evaluate(). The Worker
 * tsconfig does not include the "dom" lib, so we declare just the surface the
 * in-page callbacks touch. These exist only at compile time; at runtime the
 * callbacks are serialized and run inside the real browser DOM.
 */
interface InPageElement {
  tagName: string;
  className: string;
  textContent: string | null;
  value: string;
  checked: boolean;
  disabled: boolean;
  readOnly: boolean;
  offsetParent: unknown;
  click(): void;
  focus(): void;
  getAttribute(name: string): string | null;
  closest(selector: string): InPageElement | null;
  querySelector(selector: string): InPageElement | null;
  querySelectorAll(selector: string): ArrayLike<InPageElement>;
  dispatchEvent(event: Event): boolean;
}

declare const document: {
  body: InPageElement & { innerText: string };
  querySelector(selector: string): InPageElement | null;
  querySelectorAll(selector: string): ArrayLike<InPageElement>;
};

/**
 * Walk a SurveyJS survey at `url`: capture text + screenshot of every page,
 * answer questions generically, and advance until the completion page, a
 * navigation failure, or MAX_ITERATIONS pages.
 *
 * captures[i] pairs with screenshots[i]; pageIndex runs sequentially from 0.
 * screenshotKey is intentionally left unset (the caller stores PNGs in R2).
 */
export async function walkSurvey(
  env: Env,
  url: string,
): Promise<{ captures: PageCapture[]; screenshots: Uint8Array[]; pdfs: Uint8Array[] }> {
  const captures: PageCapture[] = [];
  const screenshots: Uint8Array[] = [];
  const pdfs: Uint8Array[] = [];

  // Env types BROWSER as Fetcher; the puppeteer binding type is structurally a
  // fetch-capable service binding, so the cast is safe.
  const browser = await puppeteer.launch(env.BROWSER as unknown as BrowserWorker);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1600 });

    // A page that keeps a connection open (analytics heartbeat, websocket,
    // long-poll) never satisfies networkidle0. Treat that timeout as
    // non-fatal: the per-page waitForSelector below handles readiness. Any
    // other navigation error (DNS, connection refused) still fails loudly.
    const gotoNotes: string[] = [];
    try {
      await page.goto(url, { waitUntil: "networkidle0", timeout: GOTO_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        gotoNotes.push(
          "Initial navigation timed out waiting for network idle; attempting walk anyway.",
        );
      } else {
        throw err;
      }
    }

    // Set to false by every deliberate stop (completion, nav failure,
    // validation block). If it survives the loop, the iteration budget ran
    // out and the survey may have uncaptured pages — surface that.
    let loopExhausted = true;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const notes: string[] = iteration === 0 ? [...gotoNotes] : [];

      // 1. Wait for the SurveyJS page to render, then let it settle.
      try {
        await page.waitForSelector(SURVEY_READY_SELECTOR, { timeout: READY_TIMEOUT_MS });
      } catch {
        notes.push("Timed out waiting for survey content to render.");
      }
      await sleep(SETTLE_MS);

      // 2. Capture visible text, a structural page signature, a full-page
      //    screenshot, and a PDF rendition.
      const text = await captureText(page);
      const signature = await capturePageSignature(page);
      screenshots.push(await captureScreenshot(page));
      pdfs.push(await capturePdf(page, notes));

      // Defensive: if we are already looking at the completion page (e.g. a
      // zero-question survey), record it and stop.
      if (await isCompletionPage(page)) {
        notes.push("Completion page.");
        captures.push({ pageIndex: captures.length, text, navOk: true, notes: joinNotes(notes) });
        loopExhausted = false;
        break;
      }

      // 3. Answer every question on the page generically. Failures are noted,
      //    never fatal.
      try {
        const fillNotes = await page.evaluate(fillAnswersInPage);
        notes.push(...fillNotes);
      } catch (err) {
        notes.push(`Answer fill failed: ${describeError(err)}`);
      }

      // 4. Find and click the Next/Complete button.
      let clickedLabel: string | null = null;
      try {
        clickedLabel = await page.evaluate(clickNavButtonInPage);
      } catch (err) {
        notes.push(`Navigation click failed: ${describeError(err)}`);
      }

      if (clickedLabel === null) {
        notes.push("No Next/Complete button found; stopping walk.");
        captures.push({ pageIndex: captures.length, text, navOk: false, notes: joinNotes(notes) });
        loopExhausted = false;
        break;
      }

      // 5. Give the survey time to react, then detect what happened. Prefer
      //    the structural page signature (SurveyJS page/question identity)
      //    over full-text hashing: injected validation errors or animated
      //    text mutate innerText without a page change, and two distinct
      //    pages can render identical text.
      await sleep(POST_CLICK_MS);
      let afterText = await captureText(page);
      let afterSignature = await capturePageSignature(page);
      let completed = await isCompletionPage(page);
      let advanced = didAdvance(signature, afterSignature, text, afterText);

      // One short retry in case the transition is slow.
      if (!advanced && !completed) {
        await sleep(POST_CLICK_RETRY_MS);
        afterText = await captureText(page);
        afterSignature = await capturePageSignature(page);
        completed = await isCompletionPage(page);
        advanced = didAdvance(signature, afterSignature, text, afterText);
      }

      if (completed) {
        // The click advanced us onto the completion page: record the page we
        // just answered, then the completion page itself, and stop.
        captures.push({ pageIndex: captures.length, text, navOk: true, notes: joinNotes(notes) });
        screenshots.push(await captureScreenshot(page));
        pdfs.push(await capturePdf(page, notes));
        captures.push({
          pageIndex: captures.length,
          text: afterText,
          navOk: true,
          notes: "Completion page.",
        });
        loopExhausted = false;
        break;
      }

      if (!advanced) {
        let validationVisible = false;
        try {
          validationVisible = await page.evaluate(detectValidationErrorsInPage);
        } catch {
          // Detection is best-effort; fall back to the generic note.
        }
        notes.push(
          validationVisible
            ? `Clicked "${clickedLabel}" but validation errors are blocking navigation; stopping walk.`
            : `Clicked "${clickedLabel}" but the page content did not change (likely a validation block); stopping walk.`,
        );
        captures.push({ pageIndex: captures.length, text, navOk: false, notes: joinNotes(notes) });
        loopExhausted = false;
        break;
      }

      captures.push({ pageIndex: captures.length, text, navOk: true, notes: joinNotes(notes) });
    }

    // The loop ran out of iterations while the survey was still advancing:
    // flag the truncation so downstream reporting doesn't read a cut-off
    // walk as a completed survey.
    if (loopExhausted && captures.length > 0) {
      const last = captures[captures.length - 1];
      const truncationNote = `Reached MAX_ITERATIONS (${MAX_ITERATIONS}); the survey may have more pages that were not captured.`;
      last.notes = last.notes !== undefined ? `${last.notes} | ${truncationNote}` : truncationNote;
    }
  } finally {
    await browser.close();
  }

  return { captures, screenshots, pdfs };
}

/* ------------------------------------------------------------------------- */
/* Worker-side helpers                                                        */
/* ------------------------------------------------------------------------- */

async function captureText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

async function captureScreenshot(page: Page): Promise<Uint8Array> {
  const shot = await page.screenshot({ type: "png", fullPage: true });
  return new Uint8Array(shot);
}

/** PDF rendition of the current page (Browser Rendering supports page.pdf). */
async function capturePdf(page: Page, notes: string[]): Promise<Uint8Array> {
  try {
    const pdf = await page.pdf({ format: "a4", printBackground: true });
    return new Uint8Array(pdf);
  } catch (err) {
    notes.push(`PDF capture failed: ${describeError(err)}`);
    return new Uint8Array(0);
  }
}

async function isCompletionPage(page: Page): Promise<boolean> {
  return page.evaluate(detectCompletionInPage);
}

/**
 * Structural identity of the currently rendered survey page. Empty string
 * when no structural signal is available (non-SurveyJS markup, evaluate
 * failure) — callers must fall back to text hashing in that case.
 */
async function capturePageSignature(page: Page): Promise<string> {
  try {
    return await page.evaluate(capturePageSignatureInPage);
  } catch {
    return "";
  }
}

/**
 * Decide whether clicking Next actually advanced to a different page.
 * Prefers the structural signature (question/page identity is unique across
 * a SurveyJS survey, and is unaffected by injected error text or animated
 * copy); falls back to comparing full-text hashes when either side lacks a
 * signature.
 */
function didAdvance(
  beforeSig: string,
  afterSig: string,
  beforeText: string,
  afterText: string,
): boolean {
  if (beforeSig !== "" && afterSig !== "") return beforeSig !== afterSig;
  return hashText(afterText) !== hashText(beforeText);
}

function joinNotes(notes: string[]): string | undefined {
  return notes.length > 0 ? notes.join(" | ") : undefined;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

/** FNV-1a 32-bit hash, used to detect whether the page's visible text changed. */
function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/* ------------------------------------------------------------------------- */
/* In-page functions (serialized into the browser by page.evaluate)           */
/* ------------------------------------------------------------------------- */

/**
 * Detect the SurveyJS completion page. The survey intro also contains
 * "Thank you …", so bare text matching would false-positive on page 1; we only
 * treat "thank you" text as completion when no answerable inputs remain AND
 * there is no navigation button left to advance. An intro/welcome page can
 * legitimately have zero inputs, but it still offers a Start/Next button —
 * a real completion page offers nothing to click.
 */
function detectCompletionInPage(): boolean {
  if (document.querySelector(".sd-completedpage, .sv-completedpage, .sv_completed_page")) {
    return true;
  }
  const text = (document.body.innerText || "").toLowerCase();
  if (!text.includes("thank you")) return false;
  const inputs = document.querySelectorAll(
    "input[type=radio], input[type=checkbox], input[type=text], input[type=number], textarea, select",
  );
  if (inputs.length > 0) return false;
  // SurveyJS navigation buttons present => not a completion page.
  if (
    document.querySelector(
      '.sd-navigation__next-btn, .sd-navigation__complete-btn, .sd-navigation__start-btn, .sd-navigation__preview-btn, input[value="Next"], input[value="Complete"], input[value="Start"]',
    )
  ) {
    return false;
  }
  // Generic nav-labelled buttons (intro pages often use "Start"/"Begin").
  const navLabels = ["next", "complete", "submit", "continue", "finish", "done", "start", "begin"];
  const buttons = Array.from(
    document.querySelectorAll("input[type=button][value], input[type=submit][value], button"),
  );
  for (const el of buttons) {
    const label = (el.value || el.textContent || "").trim().toLowerCase();
    if (navLabels.indexOf(label) !== -1) return false;
  }
  return true;
}

/**
 * Build a structural identity string for the currently rendered page: the
 * active SurveyJS page's data-name/id plus every question data-name in the
 * DOM. Question names are unique across a SurveyJS survey, so this changes
 * exactly when the rendered page changes — unlike innerText, which mutates
 * on validation errors, timers, or animated copy. Returns "" when no
 * structural signal exists. Must be fully self-contained (it is serialized).
 */
function capturePageSignatureInPage(): string {
  const pageEl = document.querySelector(".sd-page, .sv-page, .sv_p_root");
  const pagePart =
    pageEl !== null ? pageEl.getAttribute("data-name") || pageEl.getAttribute("id") || "" : "";
  const names = Array.from(document.querySelectorAll("[data-name]"))
    .map((el) => el.getAttribute("data-name") || "")
    .filter((n) => n.length > 0)
    .join(String.fromCharCode(1));
  if (pagePart === "" && names === "") return "";
  return pagePart + String.fromCharCode(2) + names;
}

/**
 * True when SurveyJS is showing at least one non-empty validation error box.
 * Must be fully self-contained (it is serialized).
 */
function detectValidationErrorsInPage(): boolean {
  const boxes = Array.from(
    document.querySelectorAll(".sd-question__erbox, .sv-question__erbox, .sv_qstn_error, .sd-error"),
  );
  return boxes.filter((b) => (b.textContent || "").trim().length > 0).length > 0;
}

/**
 * Generically answer every question on the current page. Returns notes for any
 * per-question failures. Must be fully self-contained (it is serialized).
 */
function fillAnswersInPage(): string[] {
  const notes: string[] = [];

  const fire = (el: InPageElement, type: string): void => {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  };

  // Click a radio/checkbox via its wrapping label (how SurveyJS expects
  // interaction), falling back to the input itself, then confirm state.
  const clickToggle = (el: InPageElement): void => {
    if (el.disabled) return;
    const label = el.closest("label");
    (label !== null ? label : el).click();
    if (!el.checked) el.click();
    fire(el, "change");
  };

  const setValue = (el: InPageElement, value: string): void => {
    if (el.disabled || el.readOnly) return;
    el.focus();
    el.value = value;
    fire(el, "input");
    fire(el, "change");
  };

  // Text inputs that are numeric in disguise (SurveyJS text question with
  // inputmode/min/max) should still get a valid numeric answer.
  const looksNumeric = (el: InPageElement): boolean => {
    const mode = (el.getAttribute("inputmode") || "").toLowerCase();
    if (mode === "numeric" || mode === "decimal") return true;
    return el.getAttribute("min") !== null || el.getAttribute("max") !== null;
  };

  // Pick a numeric answer that respects the element's min/max constraints
  // (a bare "10" fails validation on e.g. a 1-5 rating with max=5).
  const numericValueFor = (el: InPageElement): string => {
    const parseAttr = (name: string): number | null => {
      const raw = el.getAttribute(name);
      if (raw === null || raw === "") return null;
      const n = parseFloat(raw);
      return isNaN(n) ? null : n;
    };
    const min = parseAttr("min");
    const max = parseAttr("max");
    let v = 10;
    if (max !== null && v > max) v = max;
    if (min !== null && v < min) v = min;
    return String(v);
  };

  // Format-valid answers per input type; email/tel/url reject plain prose.
  const textValueFor = (el: InPageElement): string => {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "email") return "qa@example.com";
    if (type === "tel") return "5555555555";
    if (type === "url") return "https://example.com";
    return looksNumeric(el) ? numericValueFor(el) : "Automated QA test response";
  };

  const questionRoots = Array.from(
    document.querySelectorAll("[data-name], .sd-question, .sv-question, .sv_q"),
  );
  const containers: InPageElement[] =
    questionRoots.length > 0 ? questionRoots : [document.body];

  containers.forEach((q, index) => {
    const name = q.getAttribute("data-name") || `question #${index + 1}`;

    // Matrix: click the first-column radio in each row.
    try {
      const matrixRows = Array.from(q.querySelectorAll("tr")).filter(
        (row) => row.querySelector("input[type=radio]") !== null,
      );
      if (matrixRows.length > 0) {
        for (const row of matrixRows) {
          const radio = row.querySelector("input[type=radio]");
          if (radio) clickToggle(radio);
        }
      } else {
        // Rating / NPS: click a middle item.
        const ratingItems = Array.from(
          q.querySelectorAll(".sd-rating__item, .sv-rating__item, .sv_q_rating_item"),
        );
        if (ratingItems.length > 0) {
          const middle = ratingItems[Math.floor(ratingItems.length / 2)];
          const input = middle.querySelector("input[type=radio], input");
          if (input) {
            clickToggle(input);
          } else {
            middle.click();
          }
        } else {
          // Radiogroup: pick the FIRST radio.
          const radios = Array.from(q.querySelectorAll("input[type=radio]"));
          if (radios.length > 0) clickToggle(radios[0]);
        }
      }
    } catch (err) {
      notes.push(`Failed to answer radio/matrix/rating in ${name}: ${String(err)}`);
    }

    // Checkbox: check the first checkbox.
    try {
      const checkboxes = Array.from(q.querySelectorAll("input[type=checkbox]"));
      if (checkboxes.length > 0 && !checkboxes[0].checked) clickToggle(checkboxes[0]);
    } catch (err) {
      notes.push(`Failed to answer checkbox in ${name}: ${String(err)}`);
    }

    // Number inputs.
    try {
      const numbers = Array.from(q.querySelectorAll("input[type=number]"));
      for (const input of numbers) setValue(input, numericValueFor(input));
    } catch (err) {
      notes.push(`Failed to answer number input in ${name}: ${String(err)}`);
    }

    // Native <select> dropdowns: choose the first real (non-placeholder,
    // non-disabled) option and fire change so SurveyJS registers the answer.
    try {
      const selects = Array.from(q.querySelectorAll("select"));
      for (const sel of selects) {
        if (sel.disabled) continue;
        const options = Array.from(sel.querySelectorAll("option"));
        const usable = options.filter(
          (o) => !o.disabled && (o.value || "").trim().length > 0,
        );
        if (usable.length > 0 && sel.value !== usable[0].value) {
          setValue(sel, usable[0].value);
        }
      }
    } catch (err) {
      notes.push(`Failed to answer select in ${name}: ${String(err)}`);
    }

    // Date/time inputs need a format-valid value.
    try {
      const dateValues: Record<string, string> = {
        date: "2024-06-15",
        time: "12:30",
        month: "2024-06",
        week: "2024-W24",
        "datetime-local": "2024-06-15T12:30",
      };
      const dateInputs = Array.from(
        q.querySelectorAll(
          "input[type=date], input[type=time], input[type=month], input[type=week], input[type=datetime-local]",
        ),
      );
      for (const input of dateInputs) {
        const type = (input.getAttribute("type") || "").toLowerCase();
        const value: string | undefined = dateValues[type];
        if (value !== undefined) setValue(input, value);
      }
    } catch (err) {
      notes.push(`Failed to answer date/time input in ${name}: ${String(err)}`);
    }

    // Text inputs and textareas (type-aware: email/tel/url get format-valid
    // values, numeric-in-disguise inputs get an in-range number).
    try {
      const texts = Array.from(
        q.querySelectorAll(
          "input[type=text], input:not([type]), input[type=email], input[type=tel], input[type=url]",
        ),
      );
      for (const input of texts) {
        setValue(input, textValueFor(input));
      }
      const textareas = Array.from(q.querySelectorAll("textarea"));
      for (const area of textareas) setValue(area, "Automated QA test response");
    } catch (err) {
      notes.push(`Failed to answer text input in ${name}: ${String(err)}`);
    }
  });

  return notes;
}

/**
 * Find and click the Next/Complete navigation button. Returns the button's
 * label when a click was issued, or null when no candidate exists. Must be
 * fully self-contained (it is serialized).
 */
function clickNavButtonInPage(): string | null {
  const isVisible = (el: InPageElement): boolean => el.offsetParent !== null;
  const labelOf = (el: InPageElement): string => (el.value || el.textContent || "").trim();

  const candidates: InPageElement[] = [];
  const add = (el: InPageElement): void => {
    if (candidates.indexOf(el) === -1) candidates.push(el);
  };

  // SurveyJS-specific navigation buttons and exact-value inputs first.
  Array.from(
    document.querySelectorAll(
      '.sd-navigation__next-btn, .sd-navigation__complete-btn, input[value="Next"], input[value="Complete"]',
    ),
  ).forEach(add);

  // Generic fallback: any button-ish element whose label suggests navigation.
  const navLabels = ["next", "complete", "submit", "continue", "finish", "done"];
  Array.from(
    document.querySelectorAll("input[type=button][value], input[type=submit][value], button"),
  ).forEach((el) => {
    if (navLabels.indexOf(labelOf(el).toLowerCase()) !== -1) add(el);
  });

  const visibleTarget: InPageElement | undefined = candidates.filter(isVisible)[0];
  const fallbackTarget: InPageElement | undefined = candidates[0];
  const target = visibleTarget !== undefined ? visibleTarget : fallbackTarget;
  if (target === undefined) return null;

  target.click();
  return labelOf(target) || target.className || "button";
}

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
    await page.goto(url, { waitUntil: "networkidle0", timeout: GOTO_TIMEOUT_MS });

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const notes: string[] = [];

      // 1. Wait for the SurveyJS page to render, then let it settle.
      try {
        await page.waitForSelector(SURVEY_READY_SELECTOR, { timeout: READY_TIMEOUT_MS });
      } catch {
        notes.push("Timed out waiting for survey content to render.");
      }
      await sleep(SETTLE_MS);

      // 2. Capture visible text, a full-page screenshot, and a PDF rendition.
      const text = await captureText(page);
      screenshots.push(await captureScreenshot(page));
      pdfs.push(await capturePdf(page, notes));

      // Defensive: if we are already looking at the completion page (e.g. a
      // zero-question survey), record it and stop.
      if (await isCompletionPage(page)) {
        notes.push("Completion page.");
        captures.push({ pageIndex: captures.length, text, navOk: true, notes: joinNotes(notes) });
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
        break;
      }

      // 5. Give the survey time to react, then detect what happened.
      await sleep(POST_CLICK_MS);
      let afterText = await captureText(page);
      let completed = await isCompletionPage(page);
      let advanced = hashText(afterText) !== hashText(text);

      // One short retry in case the transition is slow.
      if (!advanced && !completed) {
        await sleep(POST_CLICK_RETRY_MS);
        afterText = await captureText(page);
        completed = await isCompletionPage(page);
        advanced = hashText(afterText) !== hashText(text);
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
        break;
      }

      if (!advanced) {
        notes.push(
          `Clicked "${clickedLabel}" but the page content did not change (likely a validation block); stopping walk.`,
        );
        captures.push({ pageIndex: captures.length, text, navOk: false, notes: joinNotes(notes) });
        break;
      }

      captures.push({ pageIndex: captures.length, text, navOk: true, notes: joinNotes(notes) });
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
 * treat "thank you" text as completion when no answerable inputs remain.
 */
function detectCompletionInPage(): boolean {
  if (document.querySelector(".sd-completedpage, .sv-completedpage, .sv_completed_page")) {
    return true;
  }
  const text = (document.body.innerText || "").toLowerCase();
  if (!text.includes("thank you")) return false;
  const inputs = document.querySelectorAll(
    "input[type=radio], input[type=checkbox], input[type=text], input[type=number], textarea",
  );
  return inputs.length === 0;
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
      for (const input of numbers) setValue(input, "10");
    } catch (err) {
      notes.push(`Failed to answer number input in ${name}: ${String(err)}`);
    }

    // Text inputs and textareas.
    try {
      const texts = Array.from(
        q.querySelectorAll(
          "input[type=text], input:not([type]), input[type=email], input[type=tel], input[type=url]",
        ),
      );
      for (const input of texts) {
        setValue(input, looksNumeric(input) ? "10" : "Automated QA test response");
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

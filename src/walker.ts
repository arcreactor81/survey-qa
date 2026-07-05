// walker.ts — Browser Rendering walker that steps through a SurveyJS survey,
// capturing each page's visible text and a full-page screenshot, answering
// questions generically so navigation/validation lets us advance.

import puppeteer from "@cloudflare/puppeteer";
import type { BrowserWorker, Page } from "@cloudflare/puppeteer";
import { isBlockedUrl } from "./net-guard";
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

// Minimal `window` surface for the socket-egress guard (below). Only the
// constructors we neuter are declared; typed `unknown` so we can overwrite them.
declare const window: {
  WebSocket?: unknown;
  EventSource?: unknown;
  RTCPeerConnection?: unknown;
  webkitRTCPeerConnection?: unknown;
  WebTransport?: unknown;
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
    await enableSsrfGuard(page);

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

      // 2. Capture visible text, a full-page screenshot, and a PDF rendition.
      //    The structural page signature is captured LATER (after answering) so
      //    that any visibleIf reveals are part of the pre-navigation baseline.
      const text = await captureText(page);
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

      // Snapshot the structural signature AFTER answering — never before.
      // Filling can reveal visibleIf-gated questions on the SAME page (new
      // question nodes appear), which changes the signature; capturing it here
      // (after a short settle for the reactive re-render) folds those reveals
      // into the "before" baseline, so a same-page validation block is not
      // later misread as a page advance. A genuine advance still changes the
      // signature because the next page's question set differs.
      await sleep(SETTLE_MS);
      const signature = await capturePageSignature(page);

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
      let { afterText, afterSignature, completed, contextLost } = await capturePostClickState(page);
      // A destroyed execution context means the click caused a real navigation,
      // which is itself an advance.
      let advanced = contextLost || didAdvance(signature, afterSignature, text, afterText);

      // One short retry in case the transition is slow.
      if (!advanced && !completed && !contextLost) {
        await sleep(POST_CLICK_RETRY_MS);
        ({ afterText, afterSignature, completed, contextLost } = await capturePostClickState(page));
        advanced = contextLost || didAdvance(signature, afterSignature, text, afterText);
      }

      if (completed) {
        // The click advanced us onto the completion page: record the page we
        // just answered (its screenshot/PDF were captured at the top of this
        // iteration), then the completion page itself, and stop.
        captures.push({ pageIndex: captures.length, text, navOk: true, notes: joinNotes(notes) });
        // Capture the completion page's artifacts under their OWN notes array so
        // a capturePdf failure note here is retained — the answered page's notes
        // were already serialized just above.
        const completionNotes: string[] = ["Completion page."];
        screenshots.push(await captureScreenshot(page));
        pdfs.push(await capturePdf(page, completionNotes));
        captures.push({
          pageIndex: captures.length,
          text: afterText,
          navOk: true,
          notes: joinNotes(completionNotes),
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

/**
 * Per-request SSRF guard. The submitted URL is validated once in index.ts,
 * but the browser follows 3xx/meta/JS redirects on its own — an allowlisted
 * public host could redirect to 169.254.169.254 or a private IP and its
 * response body would end up in the report. Request interception re-validates
 * EVERY request (each redirect hop and every subresource) against the same
 * net-guard rules and aborts blocked ones. Public hosts — the same-origin
 * demo survey and its unpkg.com CDN assets — pass untouched.
 *
 * Every intercepted request MUST be settled via continue()/abort() or the
 * page hangs, so the handler always resolves each request and validation
 * failures fail closed (abort). If interception itself cannot be enabled we
 * throw: the walk must never proceed unprotected.
 *
 * LIMITATION: CDP request interception (Fetch domain) covers HTTP(S) requests
 * — including fetch/XHR and EventSource, which are plain HTTP GETs — but does
 * NOT intercept WebSocket handshakes, WebTransport sessions, or WebRTC
 * (RTCPeerConnection) data channels, so those remain an out-of-band egress path
 * that isBlockedUrl can never see. As a defense-in-depth mitigation we also
 * neuter those page-side constructors before any survey script runs
 * (installSocketEgressGuard). The walker only needs to render and read the
 * survey, never a live socket, so this is safe for the same-origin demo (which
 * uses none of them). It stays best-effort: page-side neutering can still be
 * bypassed from a realm the init script has not yet run in (e.g. a just-created
 * same-origin iframe grabbing a fresh constructor), so the authoritative control
 * remains this CDP interceptor plus, ideally, a network-layer egress allowlist.
 */
async function enableSsrfGuard(page: Page): Promise<void> {
  try {
    await page.setRequestInterception(true);
  } catch (err) {
    throw new Error(`Could not enable request interception (SSRF guard): ${describeError(err)}`);
  }
  await installSocketEgressGuard(page);
  page.on("request", (request) => {
    let blocked = true; // fail closed if validation itself throws
    try {
      blocked = isBlockedUrl(request.url());
    } catch {
      blocked = true;
    }
    if (blocked) {
      console.warn(`SSRF guard blocked request to ${request.url()}`);
    }
    const settled = blocked ? request.abort("blockedbyclient") : request.continue();
    settled.catch((err) => {
      // Settling can race the request being cancelled/finished; log and move on.
      console.error(`SSRF guard could not settle request ${request.url()}: ${describeError(err)}`);
    });
  });
}

/**
 * Install a page-context guard that disables the egress APIs the CDP request
 * interceptor cannot see (WebSocket / EventSource / WebRTC). Runs on every new
 * document via evaluateOnNewDocument so it is in place before any survey script
 * executes. Non-fatal: unlike request interception this is defense-in-depth, so
 * if the API is unavailable we log and continue rather than aborting the walk.
 */
async function installSocketEgressGuard(page: Page): Promise<void> {
  const initCapable = page as unknown as {
    evaluateOnNewDocument?: (fn: () => void) => Promise<unknown>;
  };
  if (typeof initCapable.evaluateOnNewDocument !== "function") {
    console.warn("Socket-egress guard unavailable: evaluateOnNewDocument not supported.");
    return;
  }
  try {
    await initCapable.evaluateOnNewDocument(blockSocketEgressInPage);
  } catch (err) {
    console.warn(`Could not install socket-egress guard: ${describeError(err)}`);
  }
}

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

/**
 * True when an error is the puppeteer/CDP "execution context was destroyed"
 * family, thrown when a click triggers a real (full-document) navigation and
 * tears down the frame's JS context mid-evaluate. That is itself proof the page
 * changed, so callers treat it as a successful advance rather than a failure.
 *
 * Deliberately does NOT match "target closed" / "session closed" (nor a
 * disconnected browser): those mean the browser or CDP session actually DIED,
 * not that the page navigated. Classifying a dead browser as an advance would
 * mask the failure as progress, so those errors instead fall through to the
 * caller and surface as a genuine error — the walk step then retries with a
 * fresh browser.
 */
function isExecutionContextDestroyed(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /execution context (?:was destroyed|is not available)|context destroyed|detached frame|frame (?:was )?detached|navigating/i.test(
    msg,
  );
}

/**
 * Capture the post-click page state (text, structural signature, completion
 * flag). A real navigation can destroy the execution context between these
 * evaluate calls; rather than let that reject out of walkSurvey, we treat a
 * context-destroyed error as a genuine page change (contextLost:true) so the
 * loop advances to re-capture the new document on its next iteration. Any other
 * error is rethrown (a real fault should still surface).
 */
async function capturePostClickState(
  page: Page,
): Promise<{ afterText: string; afterSignature: string; completed: boolean; contextLost: boolean }> {
  try {
    const afterText = await captureText(page);
    const afterSignature = await capturePageSignature(page);
    const completed = await isCompletionPage(page);
    return { afterText, afterSignature, completed, contextLost: false };
  } catch (err) {
    if (isExecutionContextDestroyed(err)) {
      return { afterText: "", afterSignature: "", completed: false, contextLost: true };
    }
    throw err;
  }
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
  // Localized "thank you" phrases from SurveyJS's default completedHtml
  // (es/fr/de/zh/ja) so a non-English completion page is still recognized.
  const thanks = ["thank you", "gracias", "merci", "danke", "dank", "感谢", "谢谢", "ありがとう"];
  if (!thanks.some((t) => text.indexOf(t) !== -1)) return false;
  // Scope the input + button checks to the survey root (when present) so
  // unrelated host-page chrome on an embedded survey — a footer newsletter
  // input, a site-search box/button — does not suppress a genuine completion
  // page. The generic-button check was already survey-scoped, but the input and
  // SurveyJS nav-button checks were document-wide, so on a real vendor site with
  // header/footer inputs completion was NEVER detected. Falls back to <body> for
  // non-SurveyJS markup.
  const surveyRoot =
    document.querySelector(".sd-root-modern, .sv-root-modern, .sd-page, .sv-page, form") ||
    document.body;
  const inputs = surveyRoot.querySelectorAll(
    "input[type=radio], input[type=checkbox], input[type=text], input[type=number], textarea, select",
  );
  if (inputs.length > 0) return false;
  // SurveyJS navigation buttons present => not a completion page.
  if (
    surveyRoot.querySelector(
      '.sd-navigation__next-btn, .sd-navigation__complete-btn, .sd-navigation__start-btn, .sd-navigation__preview-btn, input[value="Next"], input[value="Complete"], input[value="Start"]',
    )
  ) {
    return false;
  }
  // A real completion page is terminal — it offers nothing to click. An
  // intro/info page always exposes a proceed control (Start/Next/Begin, a
  // custom label, or an icon-only button). Matching button LABELS against a
  // fixed word list misses custom text, unlisted languages, and icon-only
  // buttons, so such an intro page would be misread as "complete". Instead,
  // treat ANY visible, enabled button as proof this is not the completion page.
  // Completion is thus inferred from the ABSENCE of anything to click, not a
  // label, so a localized completion page (which has no button) is still detected.
  const buttons = Array.from(
    surveyRoot.querySelectorAll(
      "input[type=button], input[type=submit], input[type=reset], button, [role=button]",
    ),
  );
  for (const el of buttons) {
    if (el.offsetParent !== null && !el.disabled) return false;
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
 * Disable the socket egress APIs the request interceptor cannot police
 * (WebSocket, EventSource, WebRTC RTCPeerConnection, and WebTransport). The
 * walked survey never needs a live socket, so replacing these constructors
 * with a throwing stub closes the out-of-band channel without affecting normal
 * HTTP(S) rendering. Each assignment is wrapped so a non-configurable property
 * (or a missing constructor) can't abort the guard. Must be self-contained (it
 * is serialized and injected via evaluateOnNewDocument).
 */
function blockSocketEgressInPage(): void {
  const denied = function denied(): never {
    throw new Error("Blocked by SSRF guard: direct socket egress is disabled during automated walk.");
  };
  try {
    window.WebSocket = denied;
  } catch {
    /* non-configurable — leave as-is */
  }
  try {
    window.EventSource = denied;
  } catch {
    /* non-configurable — leave as-is */
  }
  try {
    window.RTCPeerConnection = denied;
  } catch {
    /* non-configurable — leave as-is */
  }
  try {
    window.webkitRTCPeerConnection = denied;
  } catch {
    /* non-configurable — leave as-is */
  }
  try {
    window.WebTransport = denied;
  } catch {
    /* non-configurable — leave as-is */
  }
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

  // Assign via the native prototype value setter, not `el.value = ...`.
  // React-rendered SurveyJS installs its own "value" setter that updates an
  // internal value-tracker; assigning through it makes React's onChange see
  // oldValue === newValue and ignore the input, so typed answers never
  // register. Calling the *prototype* setter writes the value without touching
  // the tracker, so the input/change events below are seen as a real change.
  // For knockout/vanilla SurveyJS (the demo) this is equivalent to a direct
  // assignment. Falls back to a direct assignment if no setter is found.
  const setNativeValue = (el: InPageElement, value: string): void => {
    let protoSetter: ((v: string) => void) | undefined;
    try {
      const proto = Object.getPrototypeOf(el) as object | null;
      if (proto !== null) {
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc !== undefined && typeof desc.set === "function") {
          protoSetter = desc.set as (v: string) => void;
        }
      }
    } catch {
      protoSetter = undefined;
    }
    if (protoSetter !== undefined) {
      protoSetter.call(el, value);
    } else {
      el.value = value;
    }
  };

  const setValue = (el: InPageElement, value: string): void => {
    if (el.disabled || el.readOnly) return;
    el.focus();
    setNativeValue(el, value);
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

  // A modern SurveyJS dropdown/tagbox renders a search box (the "filter string"
  // input) that matches the generic text selector. Filling it with prose is
  // never a valid selection and blocks navigation, so it must be excluded from
  // the plain-text fill and answered via the combobox handler instead.
  const isComboboxFilterInput = (el: InPageElement): boolean => {
    const cls = el.className || "";
    if (cls.indexOf("dropdown__filter") !== -1 || cls.indexOf("tagbox__filter") !== -1) return true;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "combobox" || role === "searchbox") return true;
    if (el.getAttribute("aria-autocomplete") !== null) return true;
    return el.closest(".sd-dropdown, .sv-dropdown, .sd-tagbox, .sv-tagbox") !== null;
  };

  // Pick a usable option label from an opened SurveyJS list popup, skipping
  // placeholders / "none" / "select all" / "other" entries that don't count as
  // a real answer for a required question.
  const isUsableItemLabel = (label: string): boolean => {
    const t = label.trim().toLowerCase();
    if (t.length === 0) return false;
    const skip = ["none", "select all", "other", "other (describe)", "ninguno", "aucun", "keine"];
    return skip.indexOf(t) === -1;
  };

  // Find the popup/listbox a just-opened dropdown/tagbox control owns, so its
  // options are never confused with another control's list elsewhere in the
  // document. SurveyJS can portal the popup out of the dropdown subtree, so the
  // definitive link is the control's ARIA target (aria-controls/aria-owns);
  // fall back to a listbox nested in the dropdown, then — only when EXACTLY one
  // dropdown popup is visible (we just opened one) — that single visible popup.
  // Returns null when none can be scoped, so the caller leaves the field
  // unanswered rather than click a foreign option.
  const findOpenListPopup = (dd: InPageElement, control: InPageElement): InPageElement | null => {
    const owns =
      control.getAttribute("aria-controls") ||
      control.getAttribute("aria-owns") ||
      dd.getAttribute("aria-controls") ||
      dd.getAttribute("aria-owns");
    if (owns !== null && owns.trim().length > 0) {
      const id = owns.trim().split(/\s+/)[0].replace(/[\\"]/g, "\\$&");
      const byId = document.querySelector('[id="' + id + '"]');
      if (byId !== null) return byId;
    }
    const nested = dd.querySelector(".sv-list, .sd-list, [role=listbox]");
    if (nested !== null) return nested;
    const visiblePopups = Array.from(
      document.querySelectorAll(".sv-popup--dropdown, .sd-popup--dropdown, .sv-list, .sd-list"),
    ).filter((p) => p.offsetParent !== null);
    return visiblePopups.length === 1 ? visiblePopups[0] : null;
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

    // Modern SurveyJS custom dropdown / tagbox (a combobox with no native
    // <select>). Best-effort: open it, then click the first usable list item.
    // The popup list is rendered lazily, so if no items are present yet we
    // toggle the control closed again so its overlay doesn't cover the Next
    // button, and leave the field unanswered (better than poisoning it with
    // invalid filter text, which is a guaranteed validation block).
    try {
      const combos = Array.from(
        q.querySelectorAll(".sd-dropdown, .sv-dropdown, .sd-tagbox, .sv-tagbox"),
      ).filter((dd) => dd.querySelector("select") === null);
      for (const dd of combos) {
        const control = dd.querySelector("[role=combobox], input, .sd-dropdown__value") || dd;
        control.click();
        // Scope the option lookup to THIS control's popup — never the whole
        // document, where another dropdown's (or a stale) popup could be clicked
        // by mistake. Fall back to the dropdown's own subtree.
        const popup = findOpenListPopup(dd, control);
        const scope = popup !== null ? popup : dd;
        const items = Array.from(
          scope.querySelectorAll(
            ".sv-list__item-body, .sd-list__item-body, li[role=option], [role=option]",
          ),
        );
        const target = items.filter((it) => isUsableItemLabel(it.textContent || ""))[0];
        if (target !== undefined) {
          target.click();
        } else {
          // Nothing selectable in this control's popup — close it so its overlay
          // can't block nav, and leave the field unanswered.
          control.click();
        }
      }
    } catch (err) {
      notes.push(`Failed to answer dropdown in ${name}: ${String(err)}`);
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
          "input[type=text], input:not([type]), input[type=email], input[type=tel], input[type=url], input[type=search]",
        ),
      ).filter((el) => !isComboboxFilterInput(el));
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
  // Includes SurveyJS's localized Next/Complete/Submit words for the supported
  // languages (es/fr/de/zh/ja) so a non-English survey still advances. Careful
  // NOT to include any "Previous/Back" word (would walk backwards).
  const navLabels = [
    // English
    "next", "complete", "submit", "continue", "finish", "done",
    // Spanish
    "siguiente", "completar", "finalizar", "terminar", "enviar", "continuar",
    // French
    "suivant", "suivante", "terminer", "envoyer", "valider", "continuer",
    // German
    "weiter", "abschließen", "abschliessen", "absenden", "senden", "fertig",
    "fertigstellen", "fortfahren", "beenden",
    // Chinese
    "下一页", "下一步", "完成", "提交", "继续", "结束",
    // Japanese
    "次へ", "次のページ", "次", "完了", "送信", "続行", "続ける", "終了",
  ];
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

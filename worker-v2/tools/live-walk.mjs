/**
 * DRIVE THE REAL `walkPath` AGAINST A REAL SURVEY IN A REAL BROWSER.
 *
 * WHY THIS EXISTS. Half of the browser layer is a STRING evaluated in a page
 * (`page-script.ts`), which `tools/test.mjs` cannot execute at all — it has no DOM. Every
 * claim about what the reader SEES therefore has to be made in a browser or not at all, and
 * "not at all" is how a classifier that could not recognise a `<input type=button value=Next>`
 * survived a 484/484 suite while four medical walks recorded 38 observations OF THE SAME
 * SCREEN and that number was read as progress.
 *
 * So this is the browser-side counterpart to the node suite, and it is deliberately NOT a
 * re-implementation: it bundles `src/browser/driver.ts` and `src/browser/page-script.ts` with
 * esbuild and calls the production `walkPath`. The only thing supplied here is a `PageLike`
 * over raw CDP — the same transport `bakeoff/cdp.mjs` uses — because puppeteer is not
 * installed and Cloudflare Browser Rendering quota is shared with live product runs.
 *
 * LOCAL CHROME ONLY. Nothing here touches Browser Rendering.
 *
 * WHAT IT PROVES AND WHAT IT DOES NOT. It reports the screens a walk actually reached, with
 * the rendered text of each, and the ending the driver typed. It is EVIDENCE, not a gate: it
 * needs a network and a browser, so it is not in `tools/test.mjs`. The properties it measures
 * that CAN be expressed without a DOM are pinned by `tools/tests/d39-*.test.mjs` and proved
 * killable by `tools/mutate-endings.mjs`.
 *
 *   node tools/live-walk.mjs oncology migraine ...        # slugs on the public testbench
 *   node tools/live-walk.mjs --url https://host/path      # any survey URL
 *   node tools/live-walk.mjs --json                       # machine-readable summary
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(WORKER_ROOT, "..");

const { open, evaluate } = await import(pathToFileURL(path.join(REPO_ROOT, "bakeoff", "cdp.mjs")).href);
const { memoryR2 } = await import(pathToFileURL(path.join(HERE, "testkit.mjs")).href);

/**
 * The driver, bundled from source. A DELIBERATELY NARROW entry — `testkit.mjs#loadWorker`
 * pulls in every module of the Worker, so an unrelated half-finished edit elsewhere in
 * `src/**` (this is a tree several agents write to) stops the browser layer being provable.
 * Nothing here is re-implemented: `walkPath` and `READ_SCREEN` are the shipped source.
 */
async function loadDriver() {
  const dir = mkdtempSync(path.join(tmpdir(), "live-walk-"));
  const entry = path.join(dir, "entry.ts");
  const p = (rel) => JSON.stringify(path.join(WORKER_ROOT, rel).replace(/\\/g, "/"));
  writeFileSync(
    entry,
    [
      `export * as driver from ${p("src/browser/driver.ts")};`,
      `export * as pageScript from ${p("src/browser/page-script.ts")};`,
      `export * as ids from ${p("src/ids.ts")};`,
    ].join("\n"),
    "utf8",
  );
  const out = path.join(dir, "bundle.mjs");
  await esbuild.build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  const mod = await import(pathToFileURL(out).href);
  return { mod, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

const TESTBENCH = "https://survey-qa-testbench.arcreactor81.workers.dev";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// A PageLike over raw CDP.
//
// THE ORDER CONTRACT IS THE WHOLE POINT (page-script.ts, CONTROL_SELECTOR): the reader
// indexes controls in `document.querySelectorAll(SEL)` order and the driver resolves the
// same selector to handles, so `controls[i]` and `handles[i]` must be the same element.
// `$$` therefore returns handles that re-resolve BY INDEX against that same selector at
// click time rather than caching remote object ids, which is exactly what puppeteer's
// element handle does for our purposes and is the only thing the driver relies on.
// ---------------------------------------------------------------------------

function cdpPage(sess) {
  const { cdp, sessionId: sid } = sess;
  const listeners = new Map();

  cdp.ws.on("message", (data) => {
    let m;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params?.exceptionDetails;
      for (const h of listeners.get("pageerror") ?? []) {
        h({ message: d?.exception?.description ?? d?.text ?? "page error", stack: d?.exception?.description ?? null });
      }
    }
    if (m.method === "Runtime.consoleAPICalled") {
      const type = m.params?.type;
      const text = (m.params?.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
      for (const h of listeners.get("console") ?? []) h({ type: () => type, text: () => text });
    }
  });

  /** Click control #idx of `selector`, hit-tested, through a real mouse event. */
  const clickAt = async (selector, idx) => {
    const pt = await evaluate(
      cdp,
      sid,
      `(() => {
        const el = document.querySelectorAll(${JSON.stringify(selector)})[${idx}];
        if (!el) return { ok: false, reason: 'no-element-at-index' };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return { ok: false, reason: 'zero-size' };
        return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`,
    );
    if (!pt || !pt.ok) throw new Error(`click target unusable: ${pt ? pt.reason : "no-result"}`);
    const common = { x: pt.x, y: pt.y, button: "left", clickCount: 1, buttons: 1 };
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...common, clickCount: 0, buttons: 0 }, sid);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...common }, sid);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...common }, sid);
  };

  const handle = (selector, idx) => ({
    async click() {
      await clickAt(selector, idx);
    },
    async type(text) {
      await evaluate(
        cdp,
        sid,
        `(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${idx}]; if (e) e.focus(); return true; })()`,
      );
      await cdp.send("Input.insertText", { text: String(text) }, sid);
      await evaluate(
        cdp,
        sid,
        `(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${idx}];
          if (!e) return false;
          e.dispatchEvent(new Event('input', { bubbles: true }));
          e.dispatchEvent(new Event('change', { bubbles: true }));
          return true; })()`,
      );
    },
    async focus() {
      await evaluate(
        cdp,
        sid,
        `(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${idx}]; if (e) e.focus(); return true; })()`,
      );
    },
  });

  return {
    async goto(url) {
      await cdp.send("Page.navigate", { url }, sid);
      await sleep(1800);
    },
    async evaluate(script) {
      return await evaluate(cdp, sid, script);
    },
    async evaluateOnNewDocument(script) {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${script});` }, sid);
    },
    async $$(selector) {
      const n = await evaluate(cdp, sid, `document.querySelectorAll(${JSON.stringify(selector)}).length`);
      return Array.from({ length: Number(n) || 0 }, (_, i) => handle(selector, i));
    },
    async screenshot() {
      const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
      return r.data; // base64 string — walkPath's `shoot()` decodes this form
    },
    async setViewport(vp) {
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false },
        sid,
      );
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    async close() {},
    async reload() {
      await cdp.send("Page.reload", {}, sid);
      await sleep(1500);
    },
  };
}

// ---------------------------------------------------------------------------

// maxSteps raised 12 -> 30 for the phase-2c reach re-measure: the 2026-08-10/11 baseline
// showed s6-kitchen-sink (19 expected screens) would be CENSORED by a 12-step cap once the
// allocation filler unlocks the Q6 wall — the cap would clip the very improvement under test.
async function walkOne(mod, url, { maxSteps = 30, decisions = [] } = {}) {
  const sess = await open("local-chromium");
  try {
    const { cdp, sessionId: sid } = sess;
    await cdp.send("Page.enable", {}, sid);
    await cdp.send("Runtime.enable", {}, sid);
    const page = cdpPage(sess);
    const env = { EVIDENCE: memoryR2() };
    const runId = mod.ids.mintRunId();
    const pathId = `live_${Math.random().toString(36).slice(2, 10)}`;
    const obs = await mod.driver.walkPath(
      page,
      { id: pathId, decisions, witnesses: [] },
      {
        surveyUrl: url,
        runId,
        planRevisionId: "plan_livewalk01",
        attemptId: `att_live${Math.random().toString(36).slice(2, 8)}`,
        tier: 1,
        maxSteps,
        deadline: Date.now() + 240_000,
        viewport: { width: 1280, height: 900 },
        applyHistoryShim: false,
        advanceTimeoutMs: 4000,
      },
      { env, runId, attemptId: "att_livewalk01", pathId, witnesses: [] },
    );
    return obs;
  } finally {
    await sess.close();
  }
}

function summarise(url, obs) {
  const screens = [];
  for (const s of obs.steps) {
    screens.push({
      step: s.stepIndex,
      advanced: s.advanced,
      question: (s.screenBefore.questionText ?? "").slice(0, 140),
      buttons: s.screenBefore.buttons.map((b) => `${b.label || "(no label)"}:${b.role}`),
      counts: s.screenBefore.counts,
      readerLimitations: (s.screenBefore.readerLimitations ?? []).map((l) => l.kind),
    });
  }
  const last = obs.steps[obs.steps.length - 1] ?? null;
  const finalScreen = last ? (last.screenAfterAdvance ?? last.screenAfterAction ?? last.screenBefore) : null;
  return {
    url,
    outcome: obs.outcome,
    outcomeDetail: obs.outcomeDetail,
    ending: obs.ending ? obs.ending.kind : null,
    endingEvidence: obs.ending ? obs.ending.evidence : null,
    steps: obs.steps.length,
    distinctSignatures: new Set(obs.steps.map((s) => s.screenBefore.screenSignature)).size,
    screens,
    finalText: finalScreen ? finalScreen.visibleText.slice(0, 400) : null,
    readerLimitations: obs.readerLimitations ?? null,
  };
}

const argv = process.argv.slice(2);
const wantJson = argv.includes("--json");
const urls = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--json") continue;
  if (argv[i] === "--url") {
    urls.push(argv[++i]);
    continue;
  }
  urls.push(`${TESTBENCH}/${argv[i]}/en`);
}
if (urls.length === 0) for (const s of ["oncology", "migraine", "rheumatoid-arthritis", "type-2-diabetes"]) urls.push(`${TESTBENCH}/${s}/en`);

const { mod } = await loadDriver();
const out = [];
for (const url of urls) {
  const obs = await walkOne(mod, url);
  const sum = summarise(url, obs);
  out.push(sum);
  if (!wantJson) {
    process.stdout.write(`\n=== ${url}\n`);
    process.stdout.write(`outcome: ${sum.outcome}  ending: ${sum.ending ?? "(none recorded)"}  steps: ${sum.steps}  distinct screens: ${sum.distinctSignatures}\n`);
    for (const e of sum.endingEvidence ?? []) process.stdout.write(`  ending evidence: ${e}\n`);
    for (const s of sum.screens) {
      process.stdout.write(
        `  step ${s.step} advanced=${s.advanced} buttons=[${s.buttons.join(", ")}] counts=${JSON.stringify(s.counts)}\n` +
          `      Q: ${s.question}\n` +
          (s.readerLimitations.length ? `      limitations: ${s.readerLimitations.join(", ")}\n` : ""),
      );
    }
    process.stdout.write(`  FINAL TEXT: ${JSON.stringify(sum.finalText)}\n`);
  }
}
if (wantJson) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
process.exit(0);

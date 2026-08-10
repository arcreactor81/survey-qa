/**
 * THE BROWSER HALF OF D44 — driven through the PRODUCTION `walkPath`, in real Chrome.
 *
 * WHY THIS EXISTS AND WHY IT IS SEPARATE FROM `tools/test.mjs`. Half of the browser layer is a
 * STRING evaluated in a page (`page-script.ts`) and the other half depends on what a real engine
 * does with a value — and "what a real engine does with a value" is the entire subject here.
 * `<input type=number>` DISCARDS "QA-PROBE" silently; a range ignores inserted text; a date input
 * consumes keystrokes into locale-ordered segments. None of that is expressible without a DOM, so
 * the node suite pins the parts that are (the derivation table, the refusal, the naming) and this
 * proves the rest against the thing itself.
 *
 * THREE FIXTURES, AND THE SECOND IS THE LOAD-BEARING ONE:
 *
 *   1. EVERY TYPE  — one screen carrying every control a respondent can answer, gated by a Next
 *                    that stays disabled until the form is constraint-VALID. The walk may only
 *                    advance if every value it supplied was one its control would accept, so
 *                    "it advanced" is not a claim the harness can make about itself.
 *   2. REFUSED     — the counterweight. A required `password` gates the same button. The walk
 *                    MUST NOT advance, MUST record the refusal, and MUST say why. A driver that
 *                    made fixture 1 pass by claiming success everywhere fails here, which is the
 *                    only reason fixture 1's pass means anything.
 *   3. SLIDER-ONLY — a screen whose only question is a range. It has ZERO text inputs, so this is
 *                    what proves `counts.valueInputs` (not `textInputs`) is what "did this survey
 *                    render?" now reads.
 *
 * LOCAL CHROME ONLY. Nothing here touches Browser Rendering.
 *
 *   node tools/probe-input-types.mjs [--json]
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The driver, bundled from source. Same narrow entry as `live-walk.mjs`, same reason. */
async function loadDriver() {
  const dir = mkdtempSync(path.join(tmpdir(), "probe-types-"));
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
  return await import(pathToFileURL(out).href);
}

/* --------------------------------------------------------------- the fixtures */

/**
 * A two-screen survey. Screen 1 is `fields`; Next is DISABLED until every control on it reports
 * `checkValidity()` — the browser's own verdict, not ours — so an advance is the ENGINE saying
 * the values were acceptable. Screen 2 is a terminal thank-you page.
 */
const surveyPage = (title, fields) => `<!doctype html>
<html><head><title>${title}</title></head><body>
<div id="root">
  <h2 id="q">${title}</h2>
  <form id="f">${fields}</form>
  <button id="next" type="button" disabled>Next</button>
</div>
<div id="end" style="display:none"><h2>Thank you for completing the survey.</h2><p>Your responses have been recorded.</p></div>
<script>
  var f = document.getElementById('f');
  var next = document.getElementById('next');
  function sync() {
    var ok = true;
    Array.prototype.forEach.call(f.querySelectorAll('input, textarea, select'), function (e) {
      if (e.willValidate && !e.checkValidity()) ok = false;
    });
    next.disabled = !ok;
  }
  f.addEventListener('input', sync);
  f.addEventListener('change', sync);
  next.addEventListener('click', function () {
    // REMOVED, not hidden — and that detail was measured here rather than assumed. Hiding the
    // question left <h2 id="q"> in the DOM, and the reader's "first heading-ish element free of
    // controls" rule then read the OLD question off the terminal page, so screenSignature never
    // changed and a survey that had plainly advanced looked blocked. The live branching engine
    // empties its root element; a fixture that does otherwise is testing the fixture.
    document.getElementById('root').remove();
    document.getElementById('end').style.display = '';
    document.title = 'done';
  });
  sync();
</script>
</body></html>`;

/**
 * Every type a respondent can answer, each REQUIRED and several carrying the bounds and grids a
 * real instrument declares. A value outside any of them keeps Next disabled.
 */
const EVERY_TYPE = surveyPage(
  "Q1. Please complete every field",
  [
    `<label>Free text <input type="text" name="a" required></label>`,
    `<label>Bare input <input name="bare" required></label>`,
    `<label>Bogus type <input type="totally-bogus" name="bogus" required></label>`,
    `<label>Comments <textarea name="b" required></textarea></label>`,
    `<label>Age <input type="number" name="age" min="18" max="99" required></label>`,
    `<label>Fraction <input type="number" name="frac" min="3" max="7" step="0.5" required></label>`,
    `<label>Email <input type="email" name="e" required></label>`,
    `<label>Website <input type="url" name="u" required></label>`,
    `<label>Phone <input type="tel" name="t" required></label>`,
    `<label>Search <input type="search" name="s" required></label>`,
    `<label>Likelihood <input type="range" name="r" min="0" max="10"></label>`,
    `<label>Start date <input type="date" name="d" required></label>`,
    `<label>Time <input type="time" name="ti" required></label>`,
    `<label>Month <input type="month" name="mo" required></label>`,
    `<label>Week <input type="week" name="wk" required></label>`,
    `<label>Moment <input type="datetime-local" name="dt" required></label>`,
    `<label>Colour <input type="color" name="c"></label>`,
  ].join("\n"),
);

/** THE COUNTERWEIGHT: a field the harness must refuse, gating the only way forward. */
const REQUIRED_PASSWORD = surveyPage(
  "Q1. Sign in to continue",
  [
    `<label>Your name <input type="text" name="who" required></label>`,
    `<label>Password <input type="password" name="pw" required></label>`,
  ].join("\n"),
);

/** A screen whose only question is a slider: zero text inputs, and it still rendered. */
const SLIDER_ONLY = surveyPage(
  "Q1. How likely are you to recommend us?",
  `<label>0 to 10 <input type="range" name="nps" min="0" max="10"></label>`,
);

/* --------------------------------------------------------------- a PageLike over CDP */

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
      for (const h of listeners.get("pageerror") ?? []) h({ message: d?.exception?.description ?? d?.text ?? "page error" });
    }
  });
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
      await evaluate(cdp, sid, `(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${idx}]; if (e) e.focus(); return true; })()`);
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
    async focus() {},
  });
  return {
    async goto(url) {
      await cdp.send("Page.navigate", { url }, sid);
      await sleep(900);
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
      return r.data;
    },
    async setViewport(vp) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false }, sid);
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    async close() {},
    async reload() {},
  };
}

async function walkHtml(mod, html) {
  const sess = await open("local-chromium");
  try {
    const { cdp, sessionId: sid } = sess;
    await cdp.send("Page.enable", {}, sid);
    await cdp.send("Runtime.enable", {}, sid);
    const page = cdpPage(sess);
    const runId = mod.ids.mintRunId();
    const obs = await mod.driver.walkPath(
      page,
      { id: `probe_${Math.random().toString(36).slice(2, 8)}`, decisions: [], witnesses: [] },
      {
        surveyUrl: `data:text/html,${encodeURIComponent(html)}`,
        runId,
        planRevisionId: "plan_probe0001",
        attemptId: `att_probe${Math.random().toString(36).slice(2, 6)}`,
        tier: 1,
        maxSteps: 4,
        deadline: Date.now() + 120_000,
        viewport: { width: 1280, height: 1600 },
        applyHistoryShim: false,
        advanceTimeoutMs: 3000,
      },
      { env: { EVIDENCE: memoryR2() }, runId, attemptId: "att_probe0001", pathId: "path_probe0001", witnesses: [] },
    );
    return obs;
  } finally {
    await sess.close();
  }
}

/* --------------------------------------------------------------- the checks */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) });
  process.stdout.write(`  ${ok ? "PASS" : "FAIL"}  ${name}\n${ok ? "" : `        ${String(detail).slice(0, 400)}\n`}`);
};

const mod = await loadDriver();

/* ---- 1. every type ---- */
process.stdout.write("\nFIXTURE 1 — every control a respondent can answer, behind a validity-gated Next\n");
{
  const obs = await walkHtml(mod, EVERY_TYPE);
  const step0 = obs.steps[0] ?? null;
  const acted = (step0?.actions ?? []).filter((a) => a.kind === "type-text" || a.kind === "set-value");
  const filled = step0 ? await Promise.resolve(step0.screenAfterAction) : null;

  check(
    "the walk ADVANCED — every value it supplied was one the browser's own constraint validation accepted",
    step0?.advanced === true,
    `advanced=${step0?.advanced} outcome=${obs.outcome} detail=${obs.outcomeDetail}`,
  );
  check(
    "every control on the screen was answered (17 of 17)",
    acted.length === 17,
    `${acted.length} answered: ${acted.map((a) => `${a.targetLabel}=${a.value}`).join(", ")}`,
  );
  check(
    "each control HOLDS the value it was given — nothing was silently discarded",
    (filled?.controls ?? []).filter((c) => mod.pageScript.isValueEntry(c.type)).every((c) => (c.value ?? "").length > 0),
    JSON.stringify((filled?.controls ?? []).filter((c) => mod.pageScript.isValueEntry(c.type)).map((c) => [c.type, c.value])),
  );
  const range = (filled?.controls ?? []).find((c) => c.type === "range");
  check(
    "the slider was SET, and by the set route — no keystrokes were claimed",
    (step0?.actions ?? []).some((a) => a.kind === "set-value" && a.targetLabel?.includes("Likelihood")) && range?.value === "5",
    `range value=${range?.value}`,
  );
  const num = (filled?.controls ?? []).find((c) => c.type === "number" && c.min === "18");
  check(
    "the numeric filler is the MIDPOINT of the site's declared range, not its edge",
    // 18..99 has an odd width, so the exact centre (58.5) is off the step grid; either
    // neighbouring step point is the midpoint. What must never come back is the EDGE.
    Math.abs(Number(num?.value) - 58.5) <= 0.5,
    `min=18 max=99 -> "${num?.value}" (the old filler was 18, the boundary a screener cuts at)`,
  );
  const frac = (filled?.controls ?? []).find((c) => c.step === "0.5");
  check("...snapped to the site's own step grid", frac?.value === "5", `min=3 max=7 step=0.5 -> "${frac?.value}"`);
  check(
    "an <input> with NO type and one with a BOGUS type were both filled — they reflect type=text",
    (filled?.controls ?? []).filter((c) => c.name === "bare" || c.name === "bogus").every((c) => (c.value ?? "").length > 0),
    JSON.stringify((filled?.controls ?? []).filter((c) => c.name === "bare" || c.name === "bogus").map((c) => [c.type, c.value])),
  );
  check(
    "nothing was reported unanswerable on a screen where everything was answered",
    (obs.unfillableControls ?? null)?.length === 0,
    JSON.stringify(obs.unfillableControls),
  );
  check("the ending is typed `completed`", obs.ending?.kind === "completed", JSON.stringify(obs.ending));
}

/* ---- 2. THE COUNTERWEIGHT ---- */
process.stdout.write("\nFIXTURE 2 — THE COUNTERWEIGHT: a required password gates the only way forward\n");
{
  const obs = await walkHtml(mod, REQUIRED_PASSWORD);
  const step0 = obs.steps[0] ?? null;
  const typedIntoPassword = (step0?.actions ?? []).some(
    (a) => (a.kind === "type-text" || a.kind === "set-value") && /password/i.test(a.targetLabel ?? ""),
  );
  check(
    "THE WALK STILL STALLS — a driver that always claims success would have advanced here",
    obs.ending?.kind !== "completed" && step0?.advanced !== true,
    `ending=${obs.ending?.kind} advanced=${step0?.advanced} outcome=${obs.outcome}`,
  );
  check("the harness typed NOTHING into the password field", !typedIntoPassword, JSON.stringify(step0?.actions?.map((a) => [a.kind, a.targetLabel, a.value])));
  check(
    "the refusal is recorded with ok:false",
    (step0?.actions ?? []).some((a) => a.kind === "refuse-fill" && a.ok === false),
    JSON.stringify((step0?.actions ?? []).filter((a) => a.kind === "refuse-fill")),
  );
  check(
    "the walk NAMES the control it could not answer",
    (obs.unfillableControls ?? []).some((u) => u.type === "password" && u.reason === "refused-by-policy"),
    JSON.stringify(obs.unfillableControls),
  );
  check(
    "and the stall says why, instead of the sentence a thank-you page produces",
    /UNANSWERED|overstates/.test(obs.outcomeDetail ?? "") && /password/.test(obs.outcomeDetail ?? ""),
    obs.outcomeDetail,
  );
  check(
    "the ending carries it too",
    (obs.ending?.evidence ?? []).some((e) => /were NOT answered/.test(e)),
    JSON.stringify(obs.ending?.evidence),
  );
}

/* ---- 3. a screen with no text inputs at all ---- */
process.stdout.write("\nFIXTURE 3 — a screen whose only question is a slider\n");
{
  const obs = await walkHtml(mod, SLIDER_ONLY);
  const before = obs.steps[0]?.screenBefore ?? null;
  check("it reports ZERO text inputs — truthfully", before?.counts.textInputs === 0, JSON.stringify(before?.counts));
  check(
    "...and a non-zero `valueInputs`, which is what 'did this survey render?' now reads",
    (before?.counts.valueInputs ?? 0) > 0,
    JSON.stringify(before?.counts),
  );
  check("the reader's own summary does not contradict its inventory", (before?.readerLimitations ?? []).length === 0, JSON.stringify(before?.readerLimitations));
  check("the walk advanced off it", obs.steps[0]?.advanced === true, `outcome=${obs.outcome}`);
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} browser checks passed\n`);
if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
process.exit(failed.length === 0 ? 0 : 1);

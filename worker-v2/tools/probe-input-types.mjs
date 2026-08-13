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
 * FIVE FIXTURES, AND THE SECOND IS THE LOAD-BEARING ONE:
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
 *   4. ALLOCATION  — the constant-sum wall the reach baseline measured (3 of 12 fleet walks
 *                    hard-blocked at "must sum to exactly 100", gating ~24 screens). Rendered
 *                    the way the fleet renders it — a table, ONE bare number input per row, no
 *                    header labels, a live "Total" mirror row, the target stated only in the
 *                    instruction prose — and gated by the ENGINE'S OWN check: Next stays
 *                    disabled until the page's script computes whole numbers summing to
 *                    exactly 100. An advance here is the page's arbitration that the driver's
 *                    allocation split satisfied the site's constant-sum rule.
 *   5. ALLOCATION, STEP-CONSTRAINED — the 11 Aug review counterexample in a real engine:
 *                    total 20 over {min 0, max 5, step 3} + {min 0, max 20, step 1}, with Next
 *                    gated on the form's OWN checkValidity() as well as the sum. The pre-fix
 *                    clamp cut the snapped share to the RAW max and wrote [5,15]; 5 is
 *                    stepMismatch in the engine itself ({0, 3} is all that input admits), so
 *                    only a lattice-valid split — [3,17] — can advance here. This is the
 *                    fixture that makes "the driver never knowingly writes an invalid value"
 *                    a claim arbitrated by the engine, not by the harness about itself.
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

/** Native selects: duplicate labels prove selection stays inside the owning <select>. */
const NATIVE_SELECTS = surveyPage(
  "Q1. Choose one option from each list",
  [
    `<label>First list <select name="first" required><option value="" selected>Choose one</option><option value="first-a">Shared label</option><option value="first-b">First only</option></select></label>`,
    `<label>Second list <select name="second" required><option value="" selected>Choose one</option><option value="second-a">Shared label</option><option value="second-b">Second only</option></select></label>`,
  ].join("\n"),
);

/** Unsupported but discoverable semantic widgets: nothing here may be clicked or dragged. */
const CUSTOM_WIDGETS = `<!doctype html><html><head><title>Q1. Custom widgets</title></head><body>
<h2>Q1. Choose and arrange</h2>
<div role="combobox" aria-label="Brand" aria-expanded="false" aria-controls="brands">Choose a brand</div>
<div id="brands" role="listbox" style="display:none"><div role="option">Alpha</div></div>
<ol aria-roledescription="sortable list"><li draggable="true">First item</li><li draggable="true">Second item</li></ol>
<button type="button" disabled>Next</button>
</body></html>`;

/**
 * Generic live-regression shape: ONE Boolean radio group laid out as one option per table row.
 * The terminal page exposes only a direction-glyph Back control. A correct walk selects exactly
 * one native radio, proves what the browser retained, advances once, and never presses Back.
 */
const TABLE_RADIO_AND_BACK_ONLY_END = `<!doctype html><html><head><title>Agreement</title></head><body>
<div id="root">
  <h2>Please choose one response</h2>
  <table><tbody>
    <tr><td><label><input type="radio" name="agreement" value="1" required> Agree</label></td></tr>
    <tr><td><label><input type="radio" name="agreement" value="0"> Do not agree</label></td></tr>
  </tbody></table>
  <button id="next" type="button" disabled>Next</button>
</div>
<div id="end" style="display:none">
  <h2>Thank you for completing the questionnaire.</h2>
  <input id="back" type="button" value="&lt;&lt;" title="&lt;&lt;">
  <input id="hidden-forward" type="button" value="Continue" style="display:none">
</div>
<script>
  var root = document.getElementById('root');
  var next = document.getElementById('next');
  var choices = Array.prototype.slice.call(document.querySelectorAll('input[name="agreement"]'));
  function sync() { next.disabled = !choices.some(function (choice) { return choice.checked; }); }
  choices.forEach(function (choice) { choice.addEventListener('change', sync); });
  next.addEventListener('click', function () {
    root.remove();
    document.getElementById('end').style.display = '';
    document.title = 'done';
  });
  document.getElementById('back').addEventListener('click', function () {
    document.body.setAttribute('data-back-clicked', 'true');
  });
  sync();
</script>
</body></html>`;

/**
 * THE CONSTANT-SUM WALL, fleet-faithful (see targets/fleet …/engine.js `renderInputs`): a
 * table, one BARE `<input type=number>` per row (no name, no min/max — the group is only
 * discoverable through the reader's grid parse), a live "Total" mirror row the page keeps
 * updated (which is why `visibleText` must never be scanned for a target: its 0 would
 * contradict the declared 100), and the target stated once, in the instruction prose. This
 * page does NOT reuse `surveyPage`'s checkValidity gate — bare inputs are trivially valid.
 * The gate is the site's own constant-sum rule: Next is disabled until every row holds a
 * whole number and the rows sum to exactly 100. The ENGINE arbitrates the advance.
 */
const P0_MULTI_QUESTION = [
  '<!doctype html><html><body><h1>Survey</h1><form>',
  '<fieldset><legend>Q1?</legend><label><input type="radio" name="q1" value="y">Yes</label><label><input type="radio" name="q1" value="n">No</label></fieldset>',
  '<fieldset><legend>Q2?</legend><label><input type="radio" name="q2" value="a">A</label><label><input type="radio" name="q2" value="b">B</label></fieldset>',
  '<button type="button">Next</button></form></body></html>',
].join('');

const P0_NATIVE_FORM_GROUPS = [
  '<!doctype html><html><body><h2>Choose in both forms</h2>',
  '<form id="form-a"><label><input type="radio" name="x" value="a1">A1</label><label><input type="radio" name="x" value="a2">A2</label></form>',
  '<form id="form-b"><label><input type="radio" name="x" value="b1">B1</label><label><input type="radio" name="x" value="b2">B2</label></form>',
  '<label><input type="radio" form="form-a" name="x" value="a3">A3 external</label>',
  '<button type="button">Next</button></body></html>',
].join('');

const P0_AMBIGUOUS_FORWARD = [
  '<!doctype html><html><body><h2>Question?</h2>',
  '<button type="button">Continue</button><button type="button">Submit</button>',
  '</body></html>',
].join('');

const P0_IDENTICAL_TEMPLATE_PROGRESS = [
  '<!doctype html><html><body><h2 id="q">Repeated roster item</h2>',
  '<progress id="p" value="1" max="3"></progress>',
  '<button id="next" type="button">Next</button>',
  '<script>document.getElementById("next").onclick=function(){var p=document.getElementById("p");p.value+=1;if(p.value>=3){this.remove();document.getElementById("q").textContent="Thank you for completing the survey.";}};</script>',
  '</body></html>',
].join('');

const ALLOCATION = `<!doctype html>
<html><head><title>Q6. Allocate points</title></head><body>
<div id="root">
  <h2 id="q">Q6. Allocate 100 points across the following factors according to how much each drives your choice.</h2>
  <p class="instruction">Enter a whole number in every row. Your answers must sum to exactly 100.</p>
  <form id="f">
    <table class="alloc">
      <tr><td>Efficacy</td><td><input type="number" data-row="r1"></td></tr>
      <tr><td>Safety profile</td><td><input type="number" data-row="r2"></td></tr>
      <tr><td>Dosing convenience</td><td><input type="number" data-row="r3"></td></tr>
      <tr class="alloc-total"><td>Total</td><td id="alloc-total">0</td></tr>
    </table>
  </form>
  <button id="next" type="button" disabled>Next</button>
</div>
<div id="end" style="display:none"><h2>Thank you for completing the survey.</h2><p>Your responses have been recorded.</p></div>
<script>
  var f = document.getElementById('f');
  var next = document.getElementById('next');
  function sync() {
    var sum = 0;
    var all = true;
    Array.prototype.forEach.call(f.querySelectorAll('input[data-row]'), function (e) {
      var v = e.value.trim();
      var n = Number(v);
      if (v === '' || isNaN(n) || Math.floor(n) !== n) { all = false; return; }
      sum += n;
    });
    var cell = document.getElementById('alloc-total');
    if (cell) cell.textContent = String(sum);
    next.disabled = !(all && sum === 100);
  }
  f.addEventListener('input', sync);
  f.addEventListener('change', sync);
  next.addEventListener('click', function () {
    document.getElementById('root').remove();
    document.getElementById('end').style.display = '';
    document.title = 'done';
  });
  sync();
</script>
</body></html>`;

/**
 * Fixture 5 — the review counterexample, arbitrated by the engine. Same shape as ALLOCATION
 * (table, one number input per row, live Total mirror, target only in prose) but the inputs
 * declare min/max/step, and the gate adds the form's own checkValidity(): a value off an
 * input's step grid is stepMismatch IN THE ENGINE, so Next never enables for [5,15].
 */
const ALLOCATION_STEPPED = `<!doctype html>
<html><head><title>Q7. Split your hours</title></head><body>
<div id="root">
  <h2 id="q">Q7. Split your weekly clinic hours across the two services.</h2>
  <p class="instruction">Enter a value in every row. Your answers must sum to exactly 20.</p>
  <form id="f">
    <table class="alloc">
      <tr><td>Group clinics</td><td><input type="number" name="q7_r1" data-row="r1" min="0" max="5" step="3"></td></tr>
      <tr><td>One-to-one consultations</td><td><input type="number" name="q7_r2" data-row="r2" min="0" max="20" step="1"></td></tr>
      <tr class="alloc-total"><td>Total</td><td id="alloc-total">0</td></tr>
    </table>
  </form>
  <button id="next" type="button" disabled>Next</button>
</div>
<div id="end" style="display:none"><h2>Thank you for completing the survey.</h2><p>Your responses have been recorded.</p></div>
<script>
  var f = document.getElementById('f');
  var next = document.getElementById('next');
  function sync() {
    var sum = 0;
    var all = true;
    Array.prototype.forEach.call(f.querySelectorAll('input[data-row]'), function (e) {
      var v = e.value.trim();
      var n = Number(v);
      if (v === '' || isNaN(n)) { all = false; return; }
      sum += n;
    });
    var cell = document.getElementById('alloc-total');
    if (cell) cell.textContent = String(sum);
    next.disabled = !(all && sum === 20 && f.checkValidity());
  }
  f.addEventListener('input', sync);
  f.addEventListener('change', sync);
  next.addEventListener('click', function () {
    document.getElementById('root').remove();
    document.getElementById('end').style.display = '';
    document.title = 'done';
  });
  sync();
</script>
</body></html>`;

/* --------------------------------------------------------------- a PageLike over CDP */

function cdpPage(sess) {
  const { cdp, sessionId: sid } = sess;
  const listeners = new Map();
  const onMessage = (data) => {
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
  };
  cdp.ws.on("message", onMessage);
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
    async close() {
      cdp.ws.off("message", onMessage);
    },
    async reload() {},
  };
}

let sharedProbeSession = null;

async function walkHtml(mod, html) {
  const sess = sharedProbeSession;
  if (!sess) throw new Error("local Chrome probe session was not opened");
  const { cdp, sessionId: sid } = sess;
  await cdp.send("Page.enable", {}, sid);
  await cdp.send("Runtime.enable", {}, sid);
  const page = cdpPage(sess);
  const runId = mod.ids.mintRunId();
  try {
    return await mod.driver.walkPath(
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
  } finally {
    await page.close();
  }
}

/* --------------------------------------------------------------- the checks */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) });
  process.stdout.write(`  ${ok ? "PASS" : "FAIL"}  ${name}\n${ok ? "" : `        ${String(detail).slice(0, 400)}\n`}`);
};

const mod = await loadDriver();
sharedProbeSession = await open("local-chromium");
try {

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

/* ---- 4. native selects ---- */
process.stdout.write("\nFIXTURE 4 — two native selects with a duplicate label, each validity-gated\n");
{
  const obs = await walkHtml(mod, NATIVE_SELECTS);
  const step0 = obs.steps[0] ?? null;
  const selected = (step0?.actions ?? []).filter((a) => a.kind === "select-option");
  const selects = (step0?.screenAfterAction?.controls ?? []).filter((c) => c.tag === "select");
  check("the walk ADVANCED only after both native selects became valid", step0?.advanced === true, `advanced=${step0?.advanced} outcome=${obs.outcome}`);
  check("one explicit select-option receipt exists per owning select", selected.length === 2, JSON.stringify(selected));
  check(
    "every successful receipt carries exact order/code/label readback",
    selected.every((a) => a.ok && a.selectReadback && a.selectReadback.code === a.targetCode && a.selectReadback.label === a.targetLabel),
    JSON.stringify(selected),
  );
  check(
    "the duplicate label did not trigger a global lookup: scoped defaults selected first-a AND second-a",
    selects.map((c) => c.value).join(",") === "first-a,second-a",
    JSON.stringify(selects.map((c) => [c.name, c.value, c.options?.find((o) => o.selected)])),
  );
  check("both invented selections are counted as navigator-defaults", obs.navigatorDefaultAnswerCount === 2, String(obs.navigatorDefaultAnswerCount));
  check("no native select was silently left unanswered", (obs.unfillableControls ?? []).length === 0, JSON.stringify(obs.unfillableControls));
}

/* ---- 5. unsupported semantic widget floor ---- */
process.stdout.write("\nFIXTURE 5 — accessible custom selection and sortable widgets are named, not guessed at\n");
{
  const obs = await walkHtml(mod, CUSTOM_WIDGETS);
  const before = obs.steps[0]?.screenBefore ?? null;
  const named = obs.steps[0]?.unfillableControls ?? [];
  check("visible semantic widgets are counted as rendered", (before?.counts.customWidgets ?? 0) >= 3, JSON.stringify(before?.counts));
  check(
    "custom selection and drag limitations are named and counted by the reader",
    (before?.readerLimitations ?? []).some((x) => x.kind === "custom-selection-widget-actuation-unsupported") &&
      (before?.readerLimitations ?? []).some((x) => x.kind === "drag-widget-actuation-unsupported"),
    JSON.stringify(before?.readerLimitations),
  );
  check("the driver names every visible semantic node it cannot actuate", named.length >= 3 && named.every((x) => x.reason === "unsupported-widget"), JSON.stringify(named));
  check(
    "no custom selection or drag action was falsely claimed",
    (obs.steps[0]?.actions ?? []).every((a) => a.kind !== "select-option" && a.kind !== "click-option" && a.kind !== "select-grid-cell"),
    JSON.stringify(obs.steps[0]?.actions),
  );
}

/* ---- 6. THE CONSTANT-SUM WALL ---- */
process.stdout.write("\nFIXTURE 6 — the allocation grid: Next enabled only by the engine's own sum-to-100 check\n");
{
  const obs = await walkHtml(mod, ALLOCATION);
  const step0 = obs.steps[0] ?? null;
  const typed = (step0?.actions ?? []).filter((a) => a.kind === "type-text");
  const split = typed.filter((a) => /navigator-default:allocation-split\(/.test(a.detail ?? ""));
  const filled = step0 ? step0.screenAfterAction : null;
  const held = (filled?.controls ?? []).filter((c) => c.type === "number").map((c) => Number(c.value));

  check(
    "the walk ADVANCED — the page's own constant-sum check is what enabled Next",
    step0?.advanced === true,
    `advanced=${step0?.advanced} outcome=${obs.outcome} detail=${obs.outcomeDetail}`,
  );
  check(
    "all three rows were answered by the allocation split, with its provenance prefix",
    split.length === 3,
    `${split.length} of ${typed.length} typed action(s) carry the prefix: ${typed.map((a) => a.detail).join(" | ")}`,
  );
  check(
    "the typed values sum to exactly the declared 100",
    split.reduce((a, t) => a + Number(t.value), 0) === 100,
    split.map((a) => `${a.targetLabel}=${a.value}`).join(", "),
  );
  check(
    "the DOM agrees: every row HOLDS its value and they sum to 100 — the mirror row did not poison the target",
    held.length === 3 && held.every((v) => Number.isFinite(v)) && held.reduce((a, v) => a + v, 0) === 100,
    JSON.stringify(held),
  );
  check(
    "the reader parsed the table as a grid and the claim held: no grid-cell click landed on a filled input",
    (step0?.actions ?? []).every((a) => a.kind !== "select-grid-cell"),
    JSON.stringify((step0?.actions ?? []).map((a) => [a.kind, a.targetIdx])),
  );
  check("the ending is typed `completed`", obs.ending?.kind === "completed", JSON.stringify(obs.ending));
  check(
    "the three invented answers are counted as navigator-defaults",
    obs.navigatorDefaultAnswerCount === 3,
    `navigatorDefaultAnswerCount=${obs.navigatorDefaultAnswerCount}`,
  );
}

/* ---- 7. THE STEP-CONSTRAINED ALLOCATION ---- */
process.stdout.write("\nFIXTURE 7 — the review counterexample: step grids arbitrated by the form's own checkValidity()\n");
{
  const obs = await walkHtml(mod, ALLOCATION_STEPPED);
  const step0 = obs.steps[0] ?? null;
  const typed = (step0?.actions ?? []).filter((a) => a.kind === "type-text");
  const split = typed.filter((a) => /navigator-default:allocation-split\(/.test(a.detail ?? ""));
  const filled = step0 ? step0.screenAfterAction : null;
  const held = (filled?.controls ?? []).filter((c) => c.type === "number").map((c) => c.value);

  check(
    "the walk ADVANCED — Next was gated on the engine's OWN checkValidity(), which a step-invalid [5,15] can never pass",
    step0?.advanced === true,
    `advanced=${step0?.advanced} outcome=${obs.outcome} detail=${obs.outcomeDetail}`,
  );
  check(
    "both rows were answered by the allocation split, with its provenance prefix",
    split.length === 2,
    `${split.length} of ${typed.length} typed action(s): ${typed.map((a) => a.detail).join(" | ")}`,
  );
  check(
    "the split is the lattice-valid [3,17] — 3 on the {0,3} grid of {min 0, max 5, step 3}, never the raw-clamped 5",
    split.map((a) => a.value).join(",") === "3,17",
    split.map((a) => `${a.targetLabel}=${a.value}`).join(", "),
  );
  check(
    "the DOM agrees: the engine KEPT both values and they sum to exactly 20",
    held.join(",") === "3,17",
    JSON.stringify(held),
  );
  check("the ending is typed `completed`", obs.ending?.kind === "completed", JSON.stringify(obs.ending));
}

/* ---- 8. THE LIVE TABLE-RADIO / BACK-ONLY REGRESSION ---- */
process.stdout.write("\nFIXTURE 8 — one radio group across table rows, followed by a Back-only ending\n");
{
  const obs = await walkHtml(mod, TABLE_RADIO_AND_BACK_ONLY_END);
  const step0 = obs.steps[0] ?? null;
  const choices = (step0?.actions ?? []).filter((a) => a.kind === "click-option");
  const gridActs = (step0?.actions ?? []).filter((a) => a.kind === "select-grid-cell");
  const held = (step0?.screenAfterAction?.controls ?? []).filter((c) => c.type === "radio" && c.checked);
  const advances = obs.steps.flatMap((step) => step.actions ?? []).filter((a) => a.kind === "click-next");

  check("the reader kept one native option group and did NOT promote table layout to a matrix", step0?.screenBefore?.grid === null && step0?.screenBefore?.optionGroups?.length === 1, JSON.stringify({ grid: step0?.screenBefore?.grid, groups: step0?.screenBefore?.optionGroups }));
  check("exactly one radio action was emitted — never one grid action per table row", choices.length === 1 && gridActs.length === 0, JSON.stringify(step0?.actions));
  check(
    "the action carries exact retained-state receipt scoped to that one native radio group",
    choices[0]?.choiceReadback?.checked === true && choices[0]?.choiceReadback?.idx === choices[0]?.targetIdx &&
      choices[0]?.choiceReadback?.checkedGroupIdxs?.length === 1 && choices[0]?.choiceReadback?.checkedGroupIdxs?.[0] === choices[0]?.targetIdx,
    JSON.stringify(choices[0]),
  );
  check("the browser itself retained exactly one checked radio", held.length === 1 && held[0]?.idx === choices[0]?.targetIdx, JSON.stringify(held.map((c) => [c.idx, c.code, c.checked])));
  check("the validity-gated screen advanced", step0?.advanced === true, `advanced=${step0?.advanced} outcome=${obs.outcome}`);
  check("the terminal << control was never emitted as click-next", !advances.some((a) => a.targetLabel === "<<"), JSON.stringify(advances));
  check("the walk stopped on the terminal page instead of cycling", obs.outcome === "no-advance-control" && obs.ending?.kind === "completed", JSON.stringify({ outcome: obs.outcome, ending: obs.ending, steps: obs.steps.length }));
}

/* ---- 9. P0: disjoint visible question ownership ---- */
process.stdout.write("\nFIXTURE 9 - two disjoint fieldset questions fail closed before actuation\n");
{
  const obs = await walkHtml(mod, P0_MULTI_QUESTION);
  const step0 = obs.steps[0] ?? null;
  check("multi-question ownership is named", obs.outcome === "multi-question-screen-actuation-unsupported", JSON.stringify({ outcome: obs.outcome, detail: obs.outcomeDetail }));
  check("the two fieldset roots are counted", step0?.screenBefore?.questionRoots?.length === 2 && obs.readerLimitationCount === 2, JSON.stringify({ roots: step0?.screenBefore?.questionRoots, limitations: obs.readerLimitations }));
  check("no response or forward act was emitted", (step0?.actions ?? []).length === 0, JSON.stringify(step0?.actions));
}

/* ---- 10. P0: native form-scoped choice identity ---- */
process.stdout.write("\nFIXTURE 10 - same-name radios in two forms remain two native groups\n");
{
  const obs = await walkHtml(mod, P0_NATIVE_FORM_GROUPS);
  const step0 = obs.steps[0] ?? null;
  const groups = step0?.screenBefore?.optionGroups ?? [];
  const choices = (step0?.actions ?? []).filter((row) => row.kind === "click-option");
  check("same-name radios split by native form owner", groups.length === 2 && groups[0]?.identity?.formOwner !== groups[1]?.identity?.formOwner, JSON.stringify(groups));
  check("external form-owned radio joins form A", groups.some((group) => group.identity?.formOwner === 0 && group.options.length === 3), JSON.stringify(groups));
  check("one exact retained-state receipt exists per form group", choices.length === 2 && choices.every((row) => row.ok && row.choiceReadback?.checkedGroupIdxs?.length === 1), JSON.stringify(choices));
}

/* ---- 11. P0: duplicate forward ambiguity ---- */
process.stdout.write("\nFIXTURE 11 - duplicate visible forward controls are never DOM-first\n");
{
  const obs = await walkHtml(mod, P0_AMBIGUOUS_FORWARD);
  const step0 = obs.steps[0] ?? null;
  check("forward ambiguity is named", obs.outcome === "navigation-forward-ambiguous" && step0?.blockedReason === "navigation-forward-ambiguous", JSON.stringify({ outcome: obs.outcome, step: step0 }));
  check("neither forward candidate was clicked", !(step0?.actions ?? []).some((row) => row.kind === "click-next"), JSON.stringify(step0?.actions));
}

/* ---- 12. P0: identical-template advancement ---- */
process.stdout.write("\nFIXTURE 12 - identical template advances on numeric progress only\n");
{
  const obs = await walkHtml(mod, P0_IDENTICAL_TEMPLATE_PROGRESS);
  const step0 = obs.steps[0] ?? null;
  const click = (step0?.actions ?? []).find((row) => row.kind === "click-next");
  check("unchanged screenSignature still advances when progress increases", step0?.advanced === true && step0?.screenBefore?.screenSignature === step0?.screenAfterAdvance?.screenSignature, JSON.stringify({ before: step0?.screenBefore?.screenSignature, after: step0?.screenAfterAdvance?.screenSignature, advanced: step0?.advanced }));
  check("the persisted click receipt names numeric progress as proof", /advance-proof:progress-value-increased/.test(click?.detail ?? ""), JSON.stringify(click));
}

} finally {
  await sharedProbeSession.close();
  sharedProbeSession = null;
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} browser checks passed\n`);
if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
process.exit(failed.length === 0 ? 0 : 1);

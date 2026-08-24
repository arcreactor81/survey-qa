/**
 * JUMP-THEN-WALK: the production walker, in local Chrome, starting at ANY question the
 * test link's own skip menu can reach.
 *
 * WHY. The fix-verify loop against the live link pays a ~35-minute cloud walk to ask a
 * one-screen question, because every wall so far has been ~68 screens deep. The test link
 * renders a QUESTION SKIP MENU (a <select> of question ids) on its pages — the platform's
 * own affordance for exactly this. This harness navigates the doorstep, uses that menu to
 * reach the target question, and then hands the page to the REAL `walkPath` from
 * `src/browser/driver.ts` — the same bundling discipline as `tools/live-walk.mjs`, no
 * re-implementation. Feedback arrives in minutes, locally, at zero cloud cost.
 *
 * WHAT THIS IS AND IS NOT. It is an ITERATION instrument: it measures whether a screen
 * class is answerable and what the site says when it is not. It is NOT the deliverable
 * end-to-end run — that one walks honestly from screen 1 in the cloud pipeline with full
 * capture, and nothing here touches it. The jump uses only the site's own on-page menu;
 * the survey URL itself is never modified (owner directive).
 *
 *   node tools/live-jump-walk.mjs --url "<link>" --target B10G
 *   node tools/live-jump-walk.mjs --url "<link>" --target B10G --max-steps 60 --json
 *   node tools/live-jump-walk.mjs --url "<link>"                    # no jump: doorstep walk
 *
 * Output: a per-screen summary on stdout; the full PathObservation JSON is saved under
 * .local-private/ for the same diagnosis flow the cloud artifacts get.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(WORKER_ROOT, "..");

const { open, evaluate } = await import(pathToFileURL(path.join(REPO_ROOT, "bakeoff", "cdp.mjs")).href);
const { memoryR2 } = await import(pathToFileURL(path.join(HERE, "testkit.mjs")).href);

async function loadDriver() {
  const dir = mkdtempSync(path.join(tmpdir(), "live-jump-"));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A PageLike over raw CDP — same order contract as tools/live-walk.mjs: handles re-resolve
// BY INDEX against the same selector the reader indexed, at click time.
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
      return r.data;
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

/**
 * Use the page's own jump menu to reach `targetId`. Finds a <select> that carries the
 * target as an option (by option text or value), selects it, fires change, and submits the
 * owning form when change alone does not navigate. Returns what it saw either way.
 */
async function jumpViaSkipMenu(page, targetId) {
  const pick = await page.evaluate(
    `(() => {
      const target = ${JSON.stringify(targetId)};
      const sels = [...document.querySelectorAll('select')];
      for (const s of sels) {
        const opts = [...s.options];
        const hit = opts.find((o) =>
          (o.textContent || '').trim() === target || (o.value || '').trim() === target);
        if (!hit) continue;
        s.value = hit.value;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: hit.value, hasForm: !!s.form, options: opts.length };
      }
      return { ok: false, reason: 'no select on this page carries the target', selects: sels.length };
    })()`,
  );
  if (!pick || !pick.ok) return pick ?? { ok: false, reason: "evaluate returned nothing" };
  await sleep(1500);
  // Some skip menus navigate on change; others need their form submitted.
  const arrived = async () =>
    await page.evaluate(
      `(() => { const t = document.body ? document.body.innerText : ''; return t.includes(${JSON.stringify(targetId)}); })()`,
    );
  if (!(await arrived()) && pick.hasForm) {
    await page.evaluate(
      `(() => {
        const target = ${JSON.stringify(targetId)};
        const sels = [...document.querySelectorAll('select')];
        for (const s of sels) {
          const opts = [...s.options];
          if (!opts.some((o) => (o.textContent || '').trim() === target || (o.value || '').trim() === target)) continue;
          if (s.form) { try { s.form.submit(); } catch (e) {} }
          return true;
        }
        return false;
      })()`,
    );
    await sleep(2000);
  }
  return { ...pick, arrived: await arrived() };
}

/** Answer the doorstep (consent) generically: first radio, then the sole forward control. */
async function passDoorstep(page) {
  const acted = await page.evaluate(
    `(() => {
      const radios = [...document.querySelectorAll('input[type=radio]')].filter((r) => {
        const b = r.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      });
      if (radios.length === 0) return { consent: false };
      radios[0].click();
      return { consent: true };
    })()`,
  );
  await sleep(400);
  await page.evaluate(
    `(() => {
      const fwd = [...document.querySelectorAll('input[type=submit],button')].filter((b) => {
        const r = b.getBoundingClientRect();
        const label = (b.value || b.textContent || '').trim();
        return r.width > 0 && r.height > 0 && !/back|prev|<</i.test(label);
      });
      if (fwd.length > 0) fwd[fwd.length - 1].click();
      return fwd.length;
    })()`,
  );
  await sleep(2500);
  return acted;
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const val = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const url = val("--url", null);
const target = val("--target", null);
const maxSteps = Number(val("--max-steps", "40"));
const asJson = args.includes("--json");
if (!url) {
  console.error('usage: node tools/live-jump-walk.mjs --url "<survey link>" [--target B10G] [--max-steps 40] [--json]');
  process.exit(2);
}

const { mod, dispose } = await loadDriver();
const sess = await open("local-chromium");
try {
  const { cdp, sessionId: sid } = sess;
  await cdp.send("Page.enable", {}, sid);
  await cdp.send("Runtime.enable", {}, sid);
  const page = cdpPage(sess);
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(url);

  let jump = { ok: false, reason: "no jump requested" };
  if (target) {
    // Try the menu on the landing page first; if it is not rendered there, pass the
    // doorstep once and try again. Both attempts are reported.
    jump = await jumpViaSkipMenu(page, target);
    if (!jump.ok || jump.arrived === false) {
      const doorstep = await passDoorstep(page);
      const second = await jumpViaSkipMenu(page, target);
      jump = { first: jump, doorstep, ...second };
    }
    console.error(`[jump] ${JSON.stringify(jump)}`);
    if (!jump.ok) {
      console.error("[jump] target unreachable via the page's own menu — walking from wherever we are");
    }
  }

  // Hand the page to the REAL walker, already positioned: goto becomes a no-op so the walk
  // starts from the current screen instead of restarting the session.
  const positioned = { ...page, goto: async () => {} };
  const env = { EVIDENCE: memoryR2() };
  const runId = mod.ids.mintRunId();
  const pathId = `jump_${Math.random().toString(36).slice(2, 10)}`;
  const obs = await mod.driver.walkPath(
    positioned,
    { id: pathId, decisions: [], witnesses: [] },
    {
      surveyUrl: url,
      runId,
      planRevisionId: "plan_livejump01",
      attemptId: `att_jump${Math.random().toString(36).slice(2, 8)}`,
      tier: 1,
      maxSteps,
      deadline: Date.now() + 900_000,
      viewport: { width: 1280, height: 900 },
      applyHistoryShim: false,
      advanceTimeoutMs: 4000,
    },
    { env, runId, attemptId: "att_livejump01", pathId, witnesses: [] },
  );

  const outDir = path.join(REPO_ROOT, ".local-private");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const obsPath = path.join(outDir, `jump-walk-${target ?? "doorstep"}-${stamp}.json`);
  writeFileSync(obsPath, JSON.stringify(obs, null, 1), "utf8");

  const rows = obs.steps.map((s) => ({
    step: s.stepIndex,
    advanced: s.advanced,
    question: (s.screenBefore?.questionText ?? "").slice(0, 90),
    validation: (s.screenBefore?.validationMessages ?? []).join(" | ").slice(0, 160),
    blockedReason: s.blockedReason ?? null,
  }));
  const summary = {
    url,
    target,
    jump,
    outcome: obs.outcome,
    outcomeDetail: (obs.outcomeDetail ?? "").slice(0, 400),
    ending: obs.ending?.kind ?? null,
    screensAdvanced: rows.filter((r) => r.advanced).length,
    steps: rows,
    observation: obsPath,
  };
  console.log(asJson ? JSON.stringify(summary) : JSON.stringify(summary, null, 1));
} finally {
  await sess.close();
  dispose();
}

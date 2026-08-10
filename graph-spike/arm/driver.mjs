/**
 * BROWSER DRIVER for `evaluation/run-arm.mjs --driver`.
 *
 * `run-arm.mjs` expects `launch()` to return a page-like object with `goto(url)`,
 * `evaluate(fn)` and `close()`. This wraps `graph-spike/cdp.mjs` — a ~150-line Chrome
 * DevTools Protocol client over `ws`, already in the repo's dependency tree, with no
 * puppeteer/playwright added.
 *
 * One deliberate property: the Chrome process is shared across `launch()` calls in a
 * process and torn down on the last close. `run-arm.mjs` counts a browser SESSION per
 * `launch()`, and Arm B opens one session per journey — hundreds per survey. Spawning a
 * fresh Chrome for each would make the arm's wall-clock a measurement of process startup.
 * The session COUNT the harness records is unaffected, which is what the telemetry is for.
 */

import { createServer } from "node:net";

import { launch as launchChrome } from "../cdp.mjs";

let chrome = null;
let pages = 0;

/**
 * Ask the OS for a port it is willing to give away, instead of guessing one.
 *
 * `cdp.mjs` defaults to `9222 + random(900)` and then polls `/json/version` until
 * something answers. That is fine once. Run the arm THREE TIMES IN A ROW — which is
 * exactly what maturity gate M1 requires — and run 2 dies: a previous Chrome has not yet
 * released its debugging port, the new one collides with it, and the poll either answers
 * from a browser that is being killed or never answers at all. This was not reasoned about;
 * it was caught by running the M1 gate and watching the middle run fail while runs 1 and 3
 * passed. An arm that works twice out of three times unattended is not an arm.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Launch with a real free port, and retry: process teardown is inherently racy. */
async function launchChromeReliably(attempts = 4) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await launchChrome({ port: await freePort() });
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw new Error(`could not start a headless browser after ${attempts} attempts: ${last?.message}`);
}

export async function launch() {
  if (!chrome) chrome = await launchChromeReliably();
  const page = await chrome.newPage();
  pages += 1;
  return {
    async goto(url) { return page.goto(url); },
    async evaluate(fn, ...args) { return page.evaluate(fn, ...args); },
    async close() {
      pages -= 1;
      try { await page.close(); } catch { /* target already gone */ }
      if (pages <= 0 && chrome) { const c = chrome; chrome = null; await c.close(); }
    },
  };
}

export default { launch };

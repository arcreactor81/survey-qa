/* Finding a real browser, and driving it once.
 *
 * The UI gates (jargon-scan, verify-previews, measure-tracker) all assert against DOM that
 * a REAL browser produced. That was a deliberate choice: the failure this whole rebuild
 * came out of was confident text contradicted by its own evidence, so "the renderer's
 * output looks right to the renderer" is not evidence about the page.
 *
 * The puppeteer-cached Chrome in this checkout hangs on `--dump-dom` and never exits, so
 * candidates are probed and the first one that actually returns DOM is used. Set
 * SQA_CHROME to override.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  process.env.SQA_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Users\\arcreactor81\\.cache\\puppeteer\\chrome\\win64-151.0.7922.47\\chrome-win64\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

const FLAGS = [
  "--headless", "--disable-gpu", "--no-sandbox", "--no-first-run",
  "--no-default-browser-check", "--disable-background-networking",
  "--disable-component-update", "--disable-sync", "--disable-extensions",
  "--disable-default-apps",
];

let resolved = null;

function tryDump(exe, url, { width = 1280, height = 900, budget = 5000 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "sqa-ui-"));
  return execFileSync(exe, [
    ...FLAGS,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--virtual-time-budget=${budget}`,
    "--run-all-compositor-stages-before-draw",
    "--dump-dom",
    url,
  ], {
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
    timeout: 60000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function findChrome() {
  if (resolved) return resolved;
  for (const exe of CANDIDATES) {
    if (!existsSync(exe)) continue;
    try {
      const dom = tryDump(exe, "data:text/html,<b id=probe>ok</b><script>document.title='probe'</script>", { budget: 1500 });
      if (dom && dom.includes("probe")) { resolved = exe; return exe; }
    } catch { /* try the next candidate */ }
  }
  throw new Error(
    "No usable Chrome found. Set SQA_CHROME to a Chrome/Edge executable that supports --dump-dom.",
  );
}

export function dumpDom(url, opts) {
  return tryDump(findChrome(), url, opts);
}

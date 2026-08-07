#!/usr/bin/env node
// HOW LONG IS THE DEFAULT VIEW, MEASURED IN A REAL BROWSER?
//
//   node measure-report.mjs samples/t1-easy-current-results.html [...]
//
// The owner's rejection of the previous report was a MEASUREMENT — "took 20-30
// seconds to scroll to end of it" — so every claim about length is held to one
// too. Chrome lays the page out at a real viewport with `<details>` in their
// DEFAULT state, because "one click away" only counts as shorter if the click
// has not been made.
//
// "Screens" is scrollHeight / viewport height: how many full flicks of a scroll
// wheel the page is. That is the number the owner was reacting to.
//
// The probe also reports how far down the page the VERDICT sits, because a
// short page that buries the answer is not an improvement, and how many bytes
// each view costs — the artifact's size is a number he measures too.
//
// Chrome discovery mirrors worker-v2/ui/chrome.mjs deliberately rather than
// importing it: that file belongs to another track, and a measurement tool
// should not break because someone else refactored a helper.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CANDIDATES = [
  process.env.SQA_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const FLAGS = [
  "--headless",
  "--disable-gpu",
  "--no-sandbox",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-extensions",
  "--disable-default-apps",
];

const VIEWPORTS = [
  { name: "desktop 1280x900", width: 1280, height: 900 },
  { name: "phone 390x844", width: 390, height: 844 },
];

/**
 * The probe. Injected as a second document that iframes nothing — the report is
 * loaded directly and the measurement is appended to its own DOM, so what is
 * measured is the shipped file, not a copy of it.
 */
const PROBE = `
(function () {
  function box(sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return Math.round(r.top + (window.scrollY || 0));
  }
  var out = {
    scrollHeight: document.documentElement.scrollHeight,
    viewportPx: window.innerHeight,
    winWidth: window.innerWidth,
    docWidth: document.documentElement.scrollWidth,
    verdictTop: box('#verdict'),
    ctaTop: box('.cta-row'),
    evidenceTop: box('.evidence-line'),
    firstLaneTop: box('#lane-blocker'),
    openDetails: document.querySelectorAll('details[open]').length,
    totalDetails: document.querySelectorAll('details').length,
    deferred: document.querySelectorAll('[data-deferred]').length,
    hydrated: document.querySelectorAll('[data-deferred][data-hydrated="done"]').length
  };
  var probe = document.createElement('div');
  probe.id = '__measure';
  probe.textContent = JSON.stringify(out);
  probe.style.display = 'none';
  document.body.appendChild(probe);
})();
`;

let resolvedChrome = null;

function dumpDom(url, { width, height, budget = 6000 }) {
  const exe = findChrome();
  const profile = mkdtempSync(join(tmpdir(), "sqa-report-measure-"));
  return execFileSync(
    exe,
    [
      ...FLAGS,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      `--virtual-time-budget=${budget}`,
      "--run-all-compositor-stages-before-draw",
      "--dump-dom",
      url,
    ],
    { encoding: "utf8", maxBuffer: 200 * 1024 * 1024, timeout: 120000, stdio: ["ignore", "pipe", "ignore"] }
  );
}

function findChrome() {
  if (resolvedChrome) return resolvedChrome;
  for (const exe of CANDIDATES) {
    if (!existsSync(exe)) continue;
    try {
      const dom = execFileSync(
        exe,
        [
          ...FLAGS,
          `--user-data-dir=${mkdtempSync(join(tmpdir(), "sqa-probe-"))}`,
          "--virtual-time-budget=1500",
          "--dump-dom",
          "data:text/html,<b id=probe>ok</b>",
        ],
        { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 40000, stdio: ["ignore", "pipe", "ignore"] }
      );
      if (dom && dom.includes("probe")) {
        resolvedChrome = exe;
        return exe;
      }
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error("No usable Chrome found. Set SQA_CHROME to a Chrome/Edge executable that supports --dump-dom.");
}

/**
 * Measure one file at one viewport. The report is loaded from a temp copy with
 * the probe appended, so the shipped bytes are never modified.
 */
function measure(file, viewport, { openAudit = false } = {}) {
  const html = readFileSync(file, "utf8");
  const injected = html.replace(
    "</body>",
    `<script>${openAudit ? "document.getElementById('v-audit').checked = true; document.getElementById('v-audit').dispatchEvent(new Event('change'));" : ""}
     setTimeout(function(){${PROBE}}, ${openAudit ? 900 : 0});</script></body>`
  );
  const tmp = join(mkdtempSync(join(tmpdir(), "sqa-measure-")), "report.html");
  writeFileSync(tmp, injected, "utf8");
  const dom = dumpDom(pathToFileURL(tmp).href, viewport);
  const m = dom.match(/<div id="__measure"[^>]*>([\s\S]*?)<\/div>/);
  if (!m) throw new Error(`no measurement returned for ${file} at ${viewport.name}`);
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

const files = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!files.length) {
  process.stderr.write("usage: node measure-report.mjs <report.html> [...]\n");
  process.exit(2);
}

const rows = [];
for (const f of files) {
  const file = resolve(f);
  const bytes = readFileSync(file).byteLength;
  for (const vp of VIEWPORTS) {
    const r = measure(file, vp);
    rows.push({ file: f, view: "Summary (default)", vp: vp.name, bytes, ...r, screens: r.scrollHeight / r.viewportPx });
  }
  const audit = measure(file, VIEWPORTS[0], { openAudit: true });
  rows.push({
    file: f,
    view: "Audit trail (opened)",
    vp: VIEWPORTS[0].name,
    bytes,
    ...audit,
    screens: audit.scrollHeight / audit.viewportPx,
  });
}

const pad = (s, n) => String(s).padEnd(n);
process.stdout.write(
  `${pad("file", 42)}${pad("view", 22)}${pad("viewport", 18)}${pad("MB", 7)}${pad("scrollPx", 10)}${pad("screens", 9)}${pad(
    "verdictY",
    10
  )}${pad("sideways", 10)}deferred\n`
);
for (const r of rows) {
  process.stdout.write(
    `${pad(r.file.split(/[\\/]/).pop(), 42)}${pad(r.view, 22)}${pad(r.vp, 18)}${pad((r.bytes / 1048576).toFixed(2), 7)}${pad(
      r.scrollHeight,
      10
    )}${pad(r.screens.toFixed(1), 9)}${pad(r.verdictTop === null ? "—" : r.verdictTop, 10)}${pad(
      r.docWidth > r.winWidth ? `YES +${r.docWidth - r.winWidth}` : "no",
      10
    )}${r.hydrated}/${r.deferred}\n`
  );
}

/* HOW LONG IS THE PAGE?
 *
 * The owner's rejection of the v2 report was a MEASUREMENT — "took 20-30 seconds to scroll
 * to end of it" — so the tracker rework is held to a measurement too, not to an opinion.
 *
 * Each tracker source is rendered into an identical minimal shell (no preview chrome, no
 * masthead, no game panel) so the only difference between runs is the renderer. Chrome
 * reports the real layout, at a real viewport, with `<details>` in its DEFAULT state —
 * because "one click away" only counts as shorter if the click has not been made.
 *
 *   node worker-v2/ui/measure-tracker.mjs                       # current renderer
 *   node worker-v2/ui/measure-tracker.mjs <path-to-tracker.js>   # any baseline copy
 *
 * "Screens" is scrollHeight / viewport height: how many full flicks of a scroll wheel the
 * page is. That is the number the owner was reacting to.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom } from "./chrome.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");
const FIXTURES = join(HERE, "fixtures");
const TMP = join(HERE, ".measure");

const trackerPath = process.argv[2] ? resolve(process.argv[2]) : join(PUBLIC, "tracker.js");
const css = readFileSync(join(PUBLIC, "styles-v2.css"), "utf8");
const trackerJs = readFileSync(trackerPath, "utf8");

// The states worth measuring: the ordinary running case, a finished run, a stopped run,
// and the one with the most recorded detail behind it.
const SLUGS = process.env.SQA_MEASURE_SLUGS
  ? process.env.SQA_MEASURE_SLUGS.split(",")
  : ["02-normal-execution", "05-partial-budget", "14-complete", "16-live-seeded-t1-easy"];

// Headless Chrome clamps the window to 500px wide, so the narrow measurement is reported
// as the width actually measured rather than the width requested — `winWidth` in the probe
// is the number the columns are checked against.
const VIEWPORTS = [
  { name: "desktop 1280x900", width: 1280, height: 900 },
  { name: "narrow (min 500px)", width: 390, height: 844 },
];

const jsonForScript = (o) => JSON.stringify(o).replace(/</g, "\\u003c");

function shell(view) {
  return `<!DOCTYPE html>
<html lang="en" data-theme="light"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style></head>
<body>
<main><div class="watch-wrap"><div id="tracker" class="tracker"></div></div></main>
<script>${trackerJs}</script>
<script>
(function(){
  SurveyQATracker.render(document.getElementById('tracker'), ${jsonForScript(view)});
  var t = document.getElementById('tracker');
  var probe = document.createElement('div');
  probe.id = '__measure';
  probe.textContent = JSON.stringify({
    scrollHeight: document.documentElement.scrollHeight,
    viewportPx: window.innerHeight,
    docWidth: document.documentElement.scrollWidth,
    winWidth: window.innerWidth,
    trackerBytes: t.innerHTML.length,
    openDetails: document.querySelectorAll('details[open]').length,
    totalDetails: document.querySelectorAll('details').length
  });
  probe.style.display = 'none';
  document.body.appendChild(probe);
})();
</script>
</body></html>`;
}

mkdirSync(TMP, { recursive: true });
const rows = [];
for (const slug of SLUGS) {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, slug + ".json"), "utf8"));
  const file = join(TMP, slug + ".html");
  writeFileSync(file, shell(fixture.view), "utf8");
  const url = "file:///" + file.replace(/\\/g, "/");
  for (const vp of VIEWPORTS) {
    const dom = dumpDom(url, { width: vp.width, height: vp.height, budget: 4000 });
    const m = /<div id="__measure"[^>]*>(.*?)<\/div>/s.exec(dom);
    if (!m) { console.log(`FAIL  ${slug} @ ${vp.name}: no measurement — did the render throw?`); continue; }
    const d = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    rows.push({ slug, viewport: vp.name, ...d, screens: d.scrollHeight / d.viewportPx });
  }
}
rmSync(TMP, { recursive: true, force: true });

console.log(`renderer: ${trackerPath}\n`);
const pad = (s, n) => String(s).padEnd(n);
console.log(pad("state", 30) + pad("viewport", 18) + pad("scrollHeight", 14) + pad("screens", 9) +
  pad("tracker DOM", 13) + "details open/total");
for (const r of rows) {
  console.log(
    pad(r.slug, 30) + pad(r.viewport, 18) + pad(r.scrollHeight + "px", 14) +
    pad(r.screens.toFixed(2), 9) + pad((r.trackerBytes / 1024).toFixed(1) + " KB", 13) +
    `${r.openDetails}/${r.totalDetails}` +
    (r.docWidth > r.winWidth ? `  ⚠ HORIZONTAL SCROLL (${r.docWidth} > ${r.winWidth})` : ""),
  );
}
const overflow = rows.filter((r) => r.docWidth > r.winWidth);
console.log(`\n${rows.length} measurements · ${overflow.length} with horizontal page scroll.`);
process.exit(overflow.length ? 1 : 0);

/* Builds one STANDALONE HTML preview per fixture into ui/previews/.
 *
 * There is no live backend, and the owner must be able to click through every honest
 * state. Each generated file inlines the stylesheet, the tracker renderer and one fixture,
 * so it opens straight off disk (file://) with no server, no bundler and no module loader.
 *
 * The important property: previews render through the SAME tracker.js the live page uses.
 * The harness supplies the snapshot; it does not reimplement the rendering. A preview that
 * looks right is therefore evidence about the product, not about the harness.
 *
 * Each page carries two review affordances that the acceptance gate needs:
 *   - a GREYSCALE toggle, because "colour is never the only signal" is checkable, and
 *   - the raw fixture JSON, so a rendered claim can be traced back to the data behind it.
 *
 * Run:  node worker-v2/ui/make-fixtures.mjs && node worker-v2/ui/build-previews.mjs
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");
const FIXTURES = join(HERE, "fixtures");
const OUT = join(HERE, "previews");
mkdirSync(OUT, { recursive: true });

const css = readFileSync(join(PUBLIC, "styles-v2.css"), "utf8");
const trackerJs = readFileSync(join(PUBLIC, "tracker.js"), "utf8");

const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort();
const loaded = files.map((f) => ({
  file: f,
  slug: f.replace(/\.json$/, ""),
  data: JSON.parse(readFileSync(join(FIXTURES, f), "utf8")),
}));

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// </script> inside an inline script would end the block early; escape the only sequence
// that can do that. The payload is our own JSON, but the rule holds regardless of source.
const jsonForScript = (o) => JSON.stringify(o).replace(/</g, "\\u003c");

const PREVIEW_CSS = `
.pv-bar {
  position: sticky; top: 0; z-index: 50;
  background: var(--card); border-bottom: 1px solid var(--border);
  padding: 10px 20px; display: flex; gap: 14px; align-items: center; flex-wrap: wrap;
}
.pv-bar strong { font-family: var(--serif); font-weight: 400; font-size: 17px; color: var(--ink); }
.pv-bar .pv-tag {
  font-family: var(--mono); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--kicker);
}
.pv-actions { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
.pv-btn {
  border: 1px solid var(--border-strong); border-radius: var(--radius-pill);
  background: var(--surface-2); color: var(--accent); cursor: pointer;
  font-family: var(--mono); font-size: 10.5px; padding: 4px 12px;
}
.pv-btn:hover { border-color: var(--accent); }
.pv-why {
  max-width: 920px; margin: 22px auto 0; padding: 0 28px;
  font-size: 13.5px; line-height: 1.6; color: var(--text);
}
.pv-why em { color: var(--accent); }
.pv-nav {
  max-width: 920px; margin: 18px auto 0; padding: 0 28px;
  display: flex; gap: 8px; flex-wrap: wrap; font-family: var(--mono); font-size: 11px;
}
.pv-nav a {
  border: 1px solid var(--border); border-radius: var(--radius-pill);
  padding: 3px 11px; text-decoration: none; background: var(--surface-2);
}
.pv-nav a.is-current { border-color: var(--accent); background: var(--primary-soft); }
.pv-json { max-width: 920px; margin: 26px auto 60px; padding: 0 28px; }
.pv-json pre {
  font-family: var(--mono); font-size: 11px; line-height: 1.5;
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 14px; overflow: auto; max-height: 420px;
}
html.pv-grey body { filter: grayscale(1); }
`;

function page({ title, tag, why, navHtml, bodyHtml, fixtureJson, extraScript }) {
  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${esc(title)} · tracker preview</title>
<style>${css}${PREVIEW_CSS}</style>
</head>
<body>
<div class="aurora" aria-hidden="true"><span class="aurora__glow"></span></div>

<div class="pv-bar">
  <span class="pv-tag">${esc(tag)}</span>
  <strong>${esc(title)}</strong>
  <span class="pv-actions">
    <button type="button" class="pv-btn" id="pvTheme">Toggle dark</button>
    <button type="button" class="pv-btn" id="pvGrey" aria-pressed="false">Greyscale check</button>
    <a class="pv-btn" href="index.html">All states</a>
  </span>
</div>

<p class="pv-why">${why}</p>
<nav class="pv-nav" aria-label="Preview states">${navHtml}</nav>

${bodyHtml}

${fixtureJson ? `<div class="pv-json"><details><summary style="font-family:var(--mono);font-size:11px;color:var(--accent);cursor:pointer">Fixture JSON behind this render</summary><pre>${esc(fixtureJson)}</pre></details></div>` : ""}

<script>
(function(){
  var t=document.getElementById('pvTheme');
  if(t) t.addEventListener('click',function(){
    var d=document.documentElement;
    d.dataset.theme = d.dataset.theme==='dark'?'light':'dark';
    t.textContent = d.dataset.theme==='dark'?'Toggle light':'Toggle dark';
  });
  var g=document.getElementById('pvGrey');
  if(g) g.addEventListener('click',function(){
    var on=document.documentElement.classList.toggle('pv-grey');
    g.setAttribute('aria-pressed', on?'true':'false');
    g.textContent = on?'Greyscale: on':'Greyscale check';
  });
})();
</script>
${extraScript || ""}
</body>
</html>
`;
}

const navFor = (current) =>
  loaded
    .map(
      (f) =>
        `<a href="${esc(f.slug)}.html"${f.slug === current ? ' class="is-current" aria-current="page"' : ""}>${esc(
          f.slug.replace(/^\d+-/, ""),
        )}</a>`,
    )
    .join("\n");

for (const f of loaded) {
  const body = `
<main>
  <div class="watch-wrap">
    <div id="tracker" class="tracker"></div>
  </div>
</main>`;
  const script = `<script>${trackerJs}</script>
<script>
(function(){
  var VIEW = ${jsonForScript(f.data.view)};
  SurveyQATracker.render(document.getElementById('tracker'), VIEW);
})();
</script>`;
  const html = page({
    title: f.data.title || f.slug,
    tag: "State " + f.slug.split("-")[0],
    why: esc(f.data.why || ""),
    navHtml: navFor(f.slug),
    bodyHtml: body,
    fixtureJson: JSON.stringify(f.data, null, 2),
    extraScript: script,
  });
  writeFileSync(join(OUT, f.slug + ".html"), html, "utf8");
  console.log("wrote previews/" + f.slug + ".html");
}

// ---- index -----------------------------------------------------------------
const rows = loaded
  .map(
    (f) => `<tr>
  <td class="mono">${esc(f.slug.split("-")[0])}</td>
  <td><a href="${esc(f.slug)}.html">${esc(f.data.title || f.slug)}</a></td>
  <td>${esc(f.data.why || "")}</td>
</tr>`,
  )
  .join("\n");

const indexBody = `
<main>
  <div class="watch-wrap">
    <section class="tcard">
      <div class="tcard-head"><div>
        <div class="kicker">Acceptance surface</div>
        <h2>Every state the tracker must render</h2>
      </div></div>
      <div class="tcard-body">
        <p style="margin-top:0">Acceptance is not &ldquo;the happy path renders&rdquo;. Each row below is a
        state a real run can legitimately be in, rendered by the same <code class="mono">tracker.js</code>
        the live page uses, from a fixture on disk. Open each one, then re-check it with
        <strong>Greyscale check</strong> on: every status must still be readable, because the measured
        luminance gap between the chip fills is 1&ndash;4% and the words are doing the work.</p>
        <p><strong>What to look at first.</strong> The default view is one card, roughly one screen.
        Everything the run recorded &mdash; the seven check states, all four limits and their
        percentages, attempts and retries, check-ins, route references, fingerprints and feed versions
        &mdash; is still there, under <strong>Run details</strong>. Open it on any state and check that
        nothing you expect is missing: this was a layering change, not a deletion.</p>
        <div class="scroll-x">
          <table>
            <thead><tr><th>#</th><th>State</th><th>Why it exists</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <p class="hint" style="margin-top:18px"><strong>Rebuild:</strong>
        <code class="mono">node worker-v2/ui/make-fixtures.mjs &amp;&amp; node worker-v2/ui/build-previews.mjs</code>.
        The generator refuses to write a fixture whose seven check states do not sum to the run's total
        &mdash; except <code class="mono">15-ledger-inconsistent</code>, which is exempt on purpose
        because its job is to prove the UI fails closed.</p>
        <p class="hint"><strong>These pages open straight off disk.</strong> The landing page and the
        watch shell do not: they load their stylesheet and scripts by absolute path, so they need a
        server &mdash; <code class="mono">node worker-v2/ui/serve.mjs</code>, then
        <code class="mono">http://127.0.0.1:8791/</code>.</p>
        <p class="hint"><strong>The three gates:</strong>
        <code class="mono">node worker-v2/ui/verify-previews.mjs</code> (every state renders and says
        what it must) &middot; <code class="mono">node worker-v2/ui/jargon-scan.mjs</code> (no banned
        word reaches a reader, on any customer-facing view, including inside Run details) &middot;
        <code class="mono">node worker-v2/ui/measure-tracker.mjs</code> (how many screens long the page
        actually is, and whether anything scrolls sideways). All three drive a real browser.</p>
      </div>
    </section>
  </div>
</main>`;

writeFileSync(
  join(OUT, "index.html"),
  page({
    title: "Tracker states",
    tag: "Preview index",
    why: "Click through every state. Nothing here is live; each page is a fixture rendered by the production renderer.",
    navHtml: navFor(""),
    bodyHtml: indexBody,
    fixtureJson: null,
    extraScript: "",
  }),
  "utf8",
);
console.log("wrote previews/index.html");
console.log(`\n${loaded.length} previews built. Open worker-v2/ui/previews/index.html`);

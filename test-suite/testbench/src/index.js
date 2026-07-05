// survey-qa-testbench — external, held-out, MULTILINGUAL testbench Worker.
//
// One walkable multi-page survey per held-out case PER LANGUAGE, at:
//   /<slug>/<lang>   e.g. /oncology/en … /migraine/ja
// where slug ∈ {oncology, rheumatoid-arthritis, type-2-diabetes, migraine}
// and   lang ∈ {en, es, fr, de, zh, ja}. Each survey ends in a localized
// completion page carrying the English marker "Thank you for completing the
// survey." that the walker's text fallback needs.
//
// Each survey is that case+language's ERRORED SurveyJS model (seeded
// discrepancies vs its localized ground-truth .docx) rendered with the SurveyJS
// runtime staged under public/assets/ (no CDN, no re-fetch). The model is
// embedded inline so there is no extra fetch/race for the walker. Static assets
// under /assets/* are served by the assets binding before this Worker runs.
//
// /<slug> (no language) 302-redirects to /<slug>/en for convenience. Nothing
// here is shared with the production survey-qa Worker.
import models from "./models.json";

const LANG_ORDER = ["en", "es", "fr", "de", "zh", "ja"];
const LANG_NAME = { en: "English", es: "Español", fr: "Français", de: "Deutsch", zh: "中文", ja: "日本語" };
const langRank = (l) => { const i = LANG_ORDER.indexOf(l); return i === -1 ? 99 : i; };

// route path -> { slug, lang, route, title, model }
const ROUTES = {};
// slug -> { domain, brands, langs:[...] } for the index + /<slug> redirect
const CASES = {};
for (const [slug, entry] of Object.entries(models)) {
  CASES[slug] = { domain: entry.domain || "", brands: entry.brands || [], langs: [] };
  for (const [lang, le] of Object.entries(entry.langs || {})) {
    ROUTES[le.route] = { slug, lang, route: le.route, title: le.title, model: le.model };
    CASES[slug].langs.push(lang);
  }
  CASES[slug].langs.sort((a, b) => langRank(a) - langRank(b));
}

const htmlResponse = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const escHtml = (s) => String(s).replace(/[<&>]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

// Embed a model as a JS object literal inside <script>. Escape '<' so a value can
// never break out with "</script>", plus the JS-illegal line separators
// U+2028/U+2029. Mojibake glyphs (â€™, grÃ¶ÃŸte, æ‚£è€…) are ordinary characters,
// left as-is and served as UTF-8 — that literal rendering IS the seeded
// encoding-artifact under test.
function embedModel(model) {
  return JSON.stringify(model)
    .replace(/</g, "\\u003c")
    .replace(/2028/g, "\\u2028")
    .replace(/2029/g, "\\u2029");
}

function surveyPage(entry) {
  return `<!DOCTYPE html>
<html lang="${entry.lang || "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(entry.title || "Survey")}</title>
  <link rel="stylesheet" href="/assets/survey-core.min.css">
  <style>
    body { margin: 0; background: #f3f3f3; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    #surveyElement { max-width: 900px; margin: 0 auto; }
  </style>
</head>
<body>
  <div id="surveyElement"></div>
  <script src="/assets/survey.core.min.js"></script>
  <script src="/assets/survey-js-ui.min.js"></script>
  <script>
    (function () {
      "use strict";
      var surveyJson = ${embedModel(entry.model)};
      function renderError(message) {
        var container = document.getElementById("surveyElement");
        if (container) {
          container.innerHTML = "";
          var box = document.createElement("div");
          box.setAttribute("role", "alert");
          box.style.cssText = "margin:2em auto;max-width:40em;padding:1em 1.5em;border:2px solid #c0392b;border-radius:6px;color:#c0392b;background:#fdf3f2;";
          box.textContent = "Testbench error: " + message;
          container.appendChild(box);
        }
        window.surveyLoadError = message;
      }
      var container = document.getElementById("surveyElement");
      if (typeof Survey === "undefined" || typeof Survey.Model !== "function") {
        renderError("the SurveyJS library failed to load."); return;
      }
      var model = new Survey.Model(surveyJson);
      var rendered = false;
      if (typeof model.render === "function") { model.render(container); rendered = true; }
      else if (typeof SurveyUI !== "undefined" && typeof SurveyUI.renderSurvey === "function") { SurveyUI.renderSurvey(model, container); rendered = true; }
      if (!rendered) { renderError("no SurveyJS render entry point available."); return; }
      window.survey = model; // expose for the automated walker
    })();
  </script>
</body>
</html>`;
}

function indexPage() {
  const blocks = Object.keys(CASES)
    .sort()
    .map((slug) => {
      const c = CASES[slug];
      const links = c.langs
        .map((lang) => `<a href="/${slug}/${lang}">${LANG_NAME[lang] || lang}</a>`)
        .join(" · ");
      return `<section>
  <h2>${escHtml(slug)}</h2>
  <p class="meta">${escHtml(c.domain)}${c.brands.length ? " — " + escHtml(c.brands.join(", ")) : ""}</p>
  <p class="links">${links}</p>
</section>`;
    })
    .join("\n");
  const total = Object.values(CASES).reduce((n, c) => n + c.langs.length, 0);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>survey-qa-testbench — held-out multilingual cases</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:52em;margin:2.5em auto;padding:0 1.2em;color:#1c1c1c;line-height:1.5}
  h1{margin-bottom:.2em} h2{margin:.2em 0;text-transform:capitalize}
  .meta{color:#666;margin:.1em 0 .3em} .links a{margin-right:.2em}
  section{border-top:1px solid #eee;padding:.6em 0}
  code{background:#eee;padding:.1em .3em;border-radius:3px}
  .sub{color:#666}
</style></head>
<body>
<h1>survey-qa-testbench</h1>
<p>External, held-out, multilingual generalization testbench for the Survey QA tool.
Each route <code>/&lt;slug&gt;/&lt;lang&gt;</code> is a walkable multi-page survey whose rendered
content deviates from its localized ground-truth <code>questionnaire.docx</code> in exactly its
manifest's seeded errors. <span class="sub">${total} surveys · ${Object.keys(CASES).length} cases × up to ${LANG_ORDER.length} languages.</span></p>
${blocks}
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path.length > 1) path = path.replace(/\/+$/, ""); // normalize trailing slash

    if (path === "" || path === "/") return htmlResponse(indexPage());

    // Exact /<slug>/<lang> survey route.
    if (ROUTES[path]) return htmlResponse(surveyPage(ROUTES[path]));

    // Bare /<slug> -> redirect to its English survey (or first available lang).
    const bare = /^\/([a-z0-9-]+)$/.exec(path);
    if (bare && CASES[bare[1]]) {
      const c = CASES[bare[1]];
      const lang = c.langs.includes("en") ? "en" : c.langs[0];
      return new Response(null, { status: 302, headers: { location: `/${bare[1]}/${lang}` } });
    }

    // Not a known survey route. Static /assets/* are normally served before the
    // Worker runs; delegate to ASSETS as a fallback, else 404.
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      if (res.status !== 404) return res;
    }
    return new Response("Not found: " + path, { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};

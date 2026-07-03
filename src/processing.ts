// Waiting page served at /reports/{runId} while a run's status is
// "processing". Returns a complete, self-contained HTML document (inline
// CSS/JS; the only external resource is the Google Fonts stylesheet).
//
// This module only builds a template string — all page-side JavaScript lives
// inside the returned HTML, so it compiles under the project tsconfig
// (lib: ES2022, no DOM types).
//
// Design language (matches report.ts / index.html — Deep Teal Terminal):
//   ink #0F2422 · cool paper #F1F6F5 · white cards, #D8E2E0 borders,
//   12px radius · accent #096658 · success #156B3F · slate #435659
//   Space Grotesk (display, Segoe UI fallback) headings, system-ui body.
//   prefers-reduced-motion tames every animation on the page.

/** Trivia lines rotated on the waiting page (each < 140 chars).
 *  NOTE: public/index.html duplicates this copy in its status-card JS —
 *  keep the two lists in sync when editing. */
const TRIVIA_LINES: string[] = [
  "A headless Chrome instance is clicking through every page of your survey right now.",
  "Each finding must quote the questionnaire verbatim — if the quote doesn't match, we throw it out.",
  "Three model families — DeepSeek v4-pro, Grok 4.3 and Claude Sonnet 4.6 — read every page independently. Then we compare notes.",
  "Every survey page is captured three ways: extracted text, a screenshot, and a PDF. Evidence beats vibes.",
  "Survey research 101: every extra minute of questionnaire length measurably increases drop-off.",
  "A routing error caught after fielding can mean re-fielding at full cost. Catching it now costs a coffee break.",
  "Mojibake (â€™ where ' should be) happens when UTF-8 bytes get read as CP1252. Surveys cross that boundary constantly.",
  "Routing and skip-logic mistakes are the most common survey programming defects — and the hardest to spot by eye.",
  "Translated surveys get back-translation QA: translate the translation back, then compare it with the original.",
  "Long answer grids invite straight-lining — respondents pick a column and coast. Quality fades before they quit.",
  "Ã© walks into a bar. The bartender says: you look like you've been through a bad encoding.",
  "Our robot has never once experienced survey fatigue.",
  "Somewhere, a {Q3brand} token is about to be caught red-handed.",
  "The browser reads your survey the way respondents do — except it actually reads all the instructions.",
  "Seeded-error scorecards are fire drills for QA: hide known bugs, then measure how many the models catch.",
  "A scale labeled only at its endpoints and one labeled at every point yield different data. Wording is everything.",
];

const STAGES: { icon: string; name: string }[] = [
  { icon: "📄", name: "Parse docx" },
  { icon: "🌐", name: "Browser walks pages" },
  { icon: "🧠", name: "DeepSeek compare (deepseek-v4-pro)" },
  { icon: "🤖", name: "Grok compare (grok-4.3)" },
  { icon: "✨", name: "Claude compare (claude-sonnet-4-6)" },
  { icon: "🔍", name: "Quote verification" },
  { icon: "📊", name: "Report" },
];

/** Seconds (since page load) at which each stage is *estimated* to begin.
 *  The status API has no stage field, so this is a well-informed guess:
 *  docx parse ~3 s, browser walk ~90 s, the three model legs and quote
 *  verification spread out after it. */
const STAGE_AT_SEC: number[] = [0, 3, 93, 118, 140, 163, 180];

/** Routing already restricts runId to [\w-]+, but validate defensively:
 *  strip anything outside [\w-] so the id is safe to embed in HTML and JS. */
function sanitizeRunId(runId: string): string {
  return runId.replace(/[^\w-]/g, "").slice(0, 80);
}

export function processingPage(runId: string): string {
  const id = sanitizeRunId(runId) || "unknown";

  const stageCards = STAGES.map(
    (s, i) => `
          <li class="stage${i === 0 ? " is-cur" : ""}" id="stage-${i}">
            <span class="stage-icon" aria-hidden="true">${s.icon}</span>
            <span class="stage-name">${s.name}</span>
            <span class="stage-dot" aria-hidden="true"></span>
          </li>`,
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<script>
/* Theme bootstrap — runs before first paint to avoid a flash of the wrong theme. */
(function () {
  var t = null;
  try { t = localStorage.getItem("sqa-theme"); } catch (e) { /* storage unavailable */ }
  if (t !== "light" && t !== "dark") {
    t = "light";
    try {
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) t = "dark";
    } catch (e) { /* matchMedia unavailable */ }
  }
  document.documentElement.dataset.theme = t;
  requestAnimationFrame(function(){requestAnimationFrame(function(){document.documentElement.classList.add("theme-ready");});});
})();
</script>
<title>Run ${id} — Survey QA</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: light;
    --ink: #0F2422;
    --paper: #F1F6F5;
    --card: #FFFFFF;
    --accent: #096658;
    --ok: #156B3F;
    --slate: #435659;
    --border: #D8E2E0;
    --text: #14282A;
    --muted: #435659;
    --band-bg: #071012;
    --band-title: #FFFFFF;
    --band-text: #DCE7E5;
    --band-link: #7CE8C9;
    --band-soft: #B4C8C3;
    --tint: #E5EEEC;
    --stage-bg: #F7FAF9;
    --dot-idle: #C5D3D0;
    --done-border: #B2DAC3;
    --done-bg: #EFF8F2;
    --focus-ring: rgba(9, 102, 88, 0.45);
    --focus-soft: rgba(9, 102, 88, 0.16);
    --pulse: rgba(9, 102, 88, 0.35);
    --serif: "Space Grotesk", "Segoe UI", system-ui, Helvetica, Arial, sans-serif;
    --sans: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    --mono: "JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace;
    --shadow: 0 1px 2px rgba(7, 16, 18, 0.05), 0 10px 28px rgba(7, 16, 18, 0.07);
  }
  /* Dark palette — scoped to screen so print always renders the light theme. */
  @media screen {
    html[data-theme="dark"] {
      color-scheme: dark;
      --ink: #EDF5F3;
      --paper: #0B1416;
      --card: #101E21;
      --accent: #35D3AC;
      --ok: #74D389;
      --slate: #8FA6A2;
      --border: #24363A;
      --text: #DCE7E5;
      --muted: #93A9A5;
      --band-bg: #060D0F;
      --band-title: #EDF5F3;
      --band-text: #DCE7E5;
      --band-link: #7CE8C9;
      --band-soft: #B4C8C3;
      --tint: #122023;
      --stage-bg: #14262A;
      --dot-idle: #33484D;
      --done-border: #2C5B41;
      /* Opaque equivalent of rgba(116,211,137,0.1) over the card (#101E21).
         Must stay opaque: done stages sit on top of the .pipeline::before
         connector line — a translucent fill lets it ghost through. */
      --done-bg: #1A302B;
      --focus-ring: rgba(53, 211, 172, 0.55);
      --focus-soft: rgba(53, 211, 172, 0.2);
      --pulse: rgba(53, 211, 172, 0.38);
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.55), 0 10px 28px rgba(0, 0, 0, 0.5);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: var(--sans);
    background: var(--paper);
    color: var(--text);
    line-height: 1.55;
    font-size: 14px;
  }
  .wrap { max-width: 920px; margin: 0 auto; padding: 0 28px; }
  .num { font-variant-numeric: tabular-nums; }
  button:focus-visible {
    outline: 3px solid var(--focus-ring);
    outline-offset: 2px;
    border-radius: 6px;
  }
  .kicker {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--accent);
    margin-bottom: 4px;
  }
  h2 {
    margin: 0;
    font-family: var(--serif);
    font-weight: 600;
    font-size: 22px;
    color: var(--ink);
    letter-spacing: 0.1px;
  }
  .sr-only {
    position: absolute;
    width: 1px; height: 1px;
    margin: -1px; padding: 0; border: 0;
    clip: rect(0 0 0 0);
    overflow: hidden;
    white-space: nowrap;
  }

  /* ---------- header band ---------- */
  .band {
    background: var(--band-bg);
    color: var(--band-text);
    padding: 44px 0 38px;
    border-bottom: 4px solid var(--accent);
  }
  .band .kicker { color: var(--band-link); }
  .brand {
    font-family: var(--serif);
    font-weight: 600;
    font-size: 36px;
    line-height: 1.1;
    margin: 0;
    color: var(--band-title);
  }
  .brand code { font-family: var(--mono); font-size: 27px; color: var(--band-link); }
  .subtitle { margin: 10px 0 0; font-size: 15px; color: var(--band-soft); }
  .elapsed-chip {
    display: inline-block;
    margin-left: 12px;
    padding: 2px 12px;
    border: 1px solid rgba(244, 241, 234, 0.3);
    border-radius: 999px;
    font-size: 12.5px;
    color: var(--band-text);
  }

  /* ---------- layout ---------- */
  main { padding: 32px 0 40px; }
  .arena { position: relative; }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px 28px 26px;
    margin-bottom: 24px;
    box-shadow: var(--shadow);
  }
  .card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .badge-est {
    flex: none;
    padding: 3px 11px;
    border-radius: 999px;
    background: var(--tint);
    border: 1px solid var(--border);
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    color: var(--slate);
  }

  /* ---------- animated pipeline ---------- */
  .pipeline {
    list-style: none;
    display: flex;
    gap: 16px;
    position: relative;
    margin: 22px 0 0;
    padding: 0;
  }
  .pipeline::before {
    content: "";
    position: absolute;
    left: 3%; right: 3%; top: 50%;
    height: 2px;
    background: var(--border);
    z-index: 0;
  }
  .stage {
    position: relative;
    z-index: 1;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 7px;
    text-align: center;
    background: var(--stage-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 15px 10px 13px;
    transition: border-color 0.4s ease, background 0.4s ease, box-shadow 0.4s ease;
  }
  .stage-icon { font-size: 22px; line-height: 1; filter: grayscale(0.9); opacity: 0.55; transition: filter 0.4s ease, opacity 0.4s ease; }
  .stage-name { font-size: 12px; font-weight: 600; line-height: 1.3; color: var(--muted); transition: color 0.4s ease; }
  .stage-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--dot-idle); }
  .stage.is-cur {
    background: var(--card);
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--focus-soft);
  }
  .stage.is-cur .stage-icon, .stage.is-done .stage-icon { filter: none; opacity: 1; }
  .stage.is-cur .stage-name, .stage.is-done .stage-name { color: var(--ink); }
  .stage.is-cur .stage-dot { background: var(--accent); animation: pulse 1.4s ease-in-out infinite; }
  .stage.is-done { border-color: var(--done-border); background: var(--done-bg); }
  .stage.is-done .stage-dot { background: var(--ok); }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 var(--pulse); }
    50% { box-shadow: 0 0 0 7px transparent; }
  }
  .pipe-note { margin: 16px 0 0; font-size: 12px; color: var(--muted); }
  @media (max-width: 720px) {
    .pipeline { flex-direction: column; gap: 10px; }
    .pipeline::before { display: none; }
    .stage { flex-direction: row; text-align: left; padding: 12px 16px; }
    .stage-dot { margin-left: auto; }
  }

  /* ---------- trivia card ---------- */
  .trivia-card { min-height: 132px; }
  /* Sits above the bug layer so a scurrying bug never covers the copy;
     pointer-events pass through so bugs stay clickable underneath. */
  .z-top { position: relative; z-index: 6; pointer-events: none; }
  .trivia {
    margin: 8px 0 0;
    min-height: 46px;
    max-width: 660px;
    font-size: 15px;
    line-height: 1.6;
    color: var(--text);
    transition: opacity 0.4s ease;
  }
  .trivia.is-fading { opacity: 0; }

  /* ---------- bug mini-game ---------- */
  #bugLayer {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    z-index: 5;
  }
  .bug {
    position: absolute;
    left: 0;
    top: 0;
    border: 0;
    margin: 0;
    padding: 5px;
    background: transparent;
    font-size: 24px;
    line-height: 1;
    cursor: pointer;
    pointer-events: auto;
    animation: scurry var(--dur, 7s) linear forwards;
    will-change: transform;
  }
  @keyframes scurry {
    from { transform: translateX(var(--x0, -60px)) translateY(0); }
    to   { transform: translateX(var(--x1, 100vw)) translateY(var(--y1, 0px)); }
  }
  .bug > span {
    display: inline-block;
    animation: bob 0.5s ease-in-out infinite alternate;
  }
  @keyframes bob {
    from { transform: scaleX(var(--flip, 1)) translateY(-3px) rotate(-6deg); }
    to   { transform: scaleX(var(--flip, 1)) translateY(3px) rotate(6deg); }
  }
  .bug.is-squashed { animation-play-state: paused; }
  .bug.is-squashed > span { animation: pop 0.45s ease forwards; }
  @keyframes pop {
    from { transform: scale(1.5); opacity: 1; }
    to   { transform: scale(0.4); opacity: 0; }
  }

  /* ---------- squash counter chip ---------- */
  .squash-chip {
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 20;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow);
    padding: 10px 16px;
    max-width: 240px;
  }
  .squash-chip strong { display: block; font-size: 13px; color: var(--ink); }
  .squash-chip small { display: block; font-size: 11px; color: var(--muted); margin-top: 2px; }

  footer {
    text-align: center;
    font-size: 12px;
    color: var(--slate);
    padding: 0 28px 96px;
  }

  /* ---------- theme toggle ---------- */
  .theme-toggle {
    position: fixed;
    top: 14px;
    right: 14px;
    z-index: 260;
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 50%;
    background: var(--card);
    box-shadow: var(--shadow);
    font-size: 17px;
    line-height: 1;
    cursor: pointer;
  }
  .theme-toggle:hover { border-color: var(--accent); }
  .theme-toggle .tt-sun { display: none; }
  html[data-theme="dark"] .theme-toggle .tt-sun { display: block; }
  html[data-theme="dark"] .theme-toggle .tt-moon { display: none; }

  /* ---------- print ---------- */
  @media print {
    .theme-toggle { display: none !important; }
  }

  /* ---------- reduced motion ---------- */
  @media (prefers-reduced-motion: reduce) {
    .stage, .stage-icon, .stage-name { transition: none; }
    .stage.is-cur .stage-dot { animation: none; }
    .trivia { transition: none; }
    .bug { animation: none; }
    .bug > span { animation: none; }
    .bug.is-squashed > span { animation: none; opacity: 0.35; }
  }

  /* ---------- smooth theme transition (added after first paint via .theme-ready) ---------- */
  html.theme-ready body, html.theme-ready body *, html.theme-ready body *::before, html.theme-ready body *::after { transition: background-color 220ms ease, color 220ms ease, border-color 220ms ease, box-shadow 220ms ease, fill 220ms ease, stroke 220ms ease; }
  @media (prefers-reduced-motion: reduce) { html.theme-ready body, html.theme-ready body *, html.theme-ready body *::before, html.theme-ready body *::after { transition: none !important; } }
</style>
</head>
<body>

<button type="button" id="themeToggle" class="theme-toggle" aria-label="Toggle dark mode" title="Toggle dark mode">
  <span class="tt-moon" aria-hidden="true">&#127769;</span>
  <span class="tt-sun" aria-hidden="true">&#9728;&#65039;</span>
</button>

<header class="band">
  <div class="wrap">
    <div class="kicker">Survey QA · Run in progress</div>
    <h1 class="brand">Run <code>${id}</code></h1>
    <p class="subtitle">Survey QA is inspecting your survey.
      <span class="elapsed-chip">Elapsed <span id="elapsed" class="num">0:00</span></span></p>
  </div>
</header>

<main>
  <div class="wrap arena">

    <section class="card" aria-labelledby="pipe-title">
      <div class="card-head">
        <div>
          <div class="kicker">Pipeline</div>
          <h2 id="pipe-title">Where your run is</h2>
        </div>
        <span class="badge-est">estimated</span>
      </div>
      <ol class="pipeline">${stageCards}
      </ol>
      <p class="pipe-note">The status API doesn't report stage-by-stage progress, so this indicator
        advances on typical timings — the browser walk is the long stretch. All three model legs —
        DeepSeek (deepseek-v4-pro), Grok (grok-4.3) and Claude (claude-sonnet-4-6) — run automatically
        in the Worker, with every call routed through the Cloudflare AI Gateway.</p>
    </section>

    <section class="card trivia-card" aria-labelledby="trivia-title">
      <div class="z-top">
        <div class="kicker">Meanwhile</div>
        <h2 id="trivia-title">While you wait</h2>
        <p class="trivia" id="trivia"></p>
      </div>
    </section>

    <div id="bugLayer"></div>
  </div>
</main>

<div class="squash-chip">
  <strong>🐛 Bugs squashed: <span id="squashCount" class="num">0</span></strong>
  <small>(the real ones are being caught server-side)</small>
</div>

<footer>
  This page checks the run every 5&nbsp;seconds and advances to the report automatically — no refresh needed.
</footer>

<div class="sr-only" aria-live="polite" id="live"></div>

<script>
(function () {
  "use strict";

  var RUN_ID = "${id}";
  var TRIVIA = ${JSON.stringify(TRIVIA_LINES)};
  var STAGE_AT = ${JSON.stringify(STAGE_AT_SEC)};
  var STAGE_NAMES = ${JSON.stringify(STAGES.map((s) => s.name))};
  var N_STAGES = STAGE_AT.length;

  var REDUCED = false;
  try {
    REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) { /* no matchMedia — assume motion is fine */ }

  /* Elapsed clock baseline. Date.now() is only a first guess: the status
     API reports the run's real startedAt, which poll() adopts as soon as it
     arrives — so the clock and the estimated pipeline stage survive page
     refreshes instead of resetting to zero on every load. */
  var startedAt = Date.now();
  var startedAtLocked = false;
  var curStage = -1;
  var squashed = 0;

  function adoptStartedAt(iso) {
    if (startedAtLocked || typeof iso !== "string") return;
    var t = Date.parse(iso);
    if (!isNaN(t) && t <= Date.now()) {
      startedAt = t;
      startedAtLocked = true;
      tick(); /* re-render the clock and stage against the real baseline */
    }
  }

  function elapsedSec() { return Math.max(0, Math.floor((Date.now() - startedAt) / 1000)); }
  function fmtElapsed(s) {
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  /* ----- elapsed clock + estimated pipeline stage ----- */

  function tick() {
    var e = elapsedSec();
    var el = document.getElementById("elapsed");
    if (el) el.textContent = fmtElapsed(e);

    var idx = 0;
    for (var i = 0; i < N_STAGES; i++) { if (e >= STAGE_AT[i]) idx = i; }
    if (idx !== curStage) {
      curStage = idx;
      for (var j = 0; j < N_STAGES; j++) {
        var st = document.getElementById("stage-" + j);
        if (st) st.className = "stage" + (j < idx ? " is-done" : (j === idx ? " is-cur" : ""));
      }
      var live = document.getElementById("live");
      if (live) live.textContent = "Estimated stage: " + STAGE_NAMES[idx];
    }
  }
  setInterval(tick, 1000);
  tick();

  /* ----- rotating trivia (6 s cycle, fade transition) ----- */

  var triviaIdx = Math.floor(Math.random() * TRIVIA.length);
  function setTrivia() {
    var t = document.getElementById("trivia");
    if (t) t.textContent = TRIVIA[triviaIdx];
  }
  setTrivia();
  setInterval(function () {
    var t = document.getElementById("trivia");
    if (!t) return;
    triviaIdx = (triviaIdx + 1) % TRIVIA.length;
    if (REDUCED) { setTrivia(); return; }
    t.className = "trivia is-fading";
    setTimeout(function () { setTrivia(); t.className = "trivia"; }, 420);
  }, 6000);

  /* ----- status polling: reload on any status other than "processing" ----- */

  function poll() {
    fetch("/api/runs/" + RUN_ID)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data) return;
        adoptStartedAt(data.startedAt);
        if (data.status && data.status !== "processing") location.reload();
      })
      .catch(function () { /* transient network error — keep polling */ });
  }
  setInterval(poll, 5000);
  poll(); /* immediately, so the elapsed clock adopts the run's real startedAt */

  /* ----- bug squash mini-game ----- */

  var layer = document.getElementById("bugLayer");
  var countEl = document.getElementById("squashCount");

  function removeBug(btn) {
    if (btn.parentNode) btn.parentNode.removeChild(btn);
  }

  function squash(btn, escapeTimer) {
    if (btn.getAttribute("data-dead")) return;
    btn.setAttribute("data-dead", "1");
    if (escapeTimer) clearTimeout(escapeTimer);
    btn.className = "bug is-squashed";
    btn.innerHTML = '<span aria-hidden="true">💥</span>';
    squashed++;
    if (countEl) countEl.textContent = String(squashed);
    setTimeout(function () { removeBug(btn); }, 480);
  }

  function spawnBug() {
    if (!layer) return;
    var w = layer.clientWidth;
    var h = layer.clientHeight;
    if (w < 120 || h < 120) return;
    if (layer.querySelectorAll(".bug").length >= 3) return;

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bug";
    btn.setAttribute("aria-label", "squash the bug");
    var glyph = Math.random() < 0.5 ? "🐛" : "🪲";
    btn.innerHTML = '<span aria-hidden="true">' + glyph + '</span>';
    btn.style.top = Math.floor(h * (0.08 + Math.random() * 0.78)) + "px";

    var escapeTimer;
    if (REDUCED) {
      // No motion: the bug simply appears somewhere and leaves after a while.
      btn.style.left = Math.floor(w * (0.1 + Math.random() * 0.7)) + "px";
      escapeTimer = setTimeout(function () { removeBug(btn); }, 6000);
    } else {
      var ltr = Math.random() < 0.5;
      var durMs = 5200 + Math.floor(Math.random() * 3800);
      btn.style.setProperty("--x0", (ltr ? -60 : w + 60) + "px");
      btn.style.setProperty("--x1", (ltr ? w + 60 : -60) + "px");
      btn.style.setProperty("--y1", Math.floor((Math.random() - 0.5) * 90) + "px");
      btn.style.setProperty("--dur", durMs + "ms");
      if (!ltr) btn.style.setProperty("--flip", "-1");
      escapeTimer = setTimeout(function () { removeBug(btn); }, durMs + 300);
    }
    btn.addEventListener("click", function () { squash(btn, escapeTimer); });
    layer.appendChild(btn);
  }

  (function scheduleBug() {
    setTimeout(function () {
      spawnBug();
      scheduleBug();
    }, 4500 + Math.random() * 5000);
  })();
})();
</script>
<script>
(function () {
  "use strict";
  var toggle = document.getElementById("themeToggle");
  if (!toggle) return;
  toggle.addEventListener("click", function () {
    var cur = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    var next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("sqa-theme", next); } catch (e) { /* storage unavailable */ }
  });
})();
</script>
</body>
</html>
`;
}

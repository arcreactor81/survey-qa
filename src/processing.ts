// Waiting page served at /reports/{runId} while a run's status is
// "processing". Returns a complete, self-contained HTML document (inline
// CSS/JS; fonts self-hosted at /fonts/ with a strong fallback stack so a
// saved/offline copy still reads).
//
// This module only builds a template string — all page-side JavaScript lives
// inside the returned HTML, so it compiles under the project tsconfig
// (lib: ES2022, no DOM types).
//
// The status API reports a coarse status plus an honest stage field (0 parse,
// 1 walk, 2 compare) inferred from real R2 artifacts, and this page is served ONLY while the run is
// "processing" (index.ts reloads it to the report the moment the run reaches a
// terminal/awaiting status). So the pipeline is shown as genuinely running
// server-side — no guessed per-stage clock — with a REAL elapsed timer adopted
// from the run's own startedAt.
//
// Design: the shared "Editorial Medical" system (src/theme-css.ts) — warm paper
// / near-black, Instrument Serif display, DM Sans body, JetBrains Mono labels.

import { THEME_CSS } from "./theme-css";

/** A themed, self-contained error page for terminal failures / missing runs.
 *  Replaces the bare unstyled <h1>/<pre> so a failed run stays inside the
 *  branded experience. Uses the shared theme tokens (auto light/dark). */
export function errorPage(opts: { title: string; heading: string; detail?: string }): string {
  const esc = (v: string): string =>
    String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const detailBlock = opts.detail ? `<p class="err-detail">${esc(opts.detail)}</p>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<script>
/* Theme bootstrap — set data-theme before first paint, matching the report/processing pages. */
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
})();
</script>
<title>${esc(opts.title)} &mdash; Survey QA</title>
<style>${THEME_CSS}
  body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 32px;
    background: var(--paper); color: var(--ink); font-family: var(--sans); }
  .err-card { max-width: 560px; width: 100%; background: var(--card); border: 1px solid var(--border);
    border-left: 4px solid var(--bad); border-radius: var(--radius); box-shadow: var(--shadow); padding: 30px 32px; }
  .err-kicker { font-family: var(--mono); font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.12em; color: var(--bad); margin-bottom: 12px; }
  .err-card h1 { font-family: var(--serif); font-weight: 400; font-size: 27px; line-height: 1.2;
    letter-spacing: -0.01em; color: var(--ink); margin: 0 0 14px; }
  .err-detail { font-family: var(--mono); font-size: 12.5px; line-height: 1.55; color: var(--slate);
    background: var(--tint); border-radius: var(--radius-sm); padding: 12px 14px; margin: 0 0 22px;
    white-space: pre-wrap; word-break: break-word; }
  .err-cta { display: inline-block; font-family: var(--sans); font-size: 14px; font-weight: 600;
    text-decoration: none; color: var(--accent-ink); background: var(--accent-solid);
    border-radius: var(--radius-sm); padding: 10px 20px; }
  .err-cta:hover { filter: brightness(1.06); }
</style>
</head>
<body>
  <main class="err-card" role="alert">
    <div class="err-kicker">Survey QA</div>
    <h1>${esc(opts.heading)}</h1>
    ${detailBlock}
    <a class="err-cta" href="/">Start a new run &rarr;</a>
  </main>
</body>
</html>`;
}

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
  "🧾 A single dropped answer option can quietly bias an entire brand-tracking study.",
  "🎯 A missed error ships to respondents and corrupts data; a false alarm costs seconds of review — so we optimize for catching everything.",
  "🔗 Piping bugs are sneaky: {brand} renders fine on page 2 but shows the raw token on page 5.",
  "🧪 Benchmarked on 240 planted errors across surveys it had never seen — it flagged all 240, exact category on 239.",
  "🗂️ Six languages, including CJK: the same walker reads English, Español, Français, Deutsch, 中文 and 日本語.",
  "⚖️ Two models agreeing on a finding beats one model shouting. Consensus over confidence.",
  "🕵️ A renamed option ('Very satisfied' → 'Extremely satisfied') shifts your trend line. We flag it.",
  "🔢 Off-by-one numbering (Q7, Q7, Q9) is invisible to skimming and obvious to a machine.",
  "📉 Straight-lining, speeding, and drop-off are the three horsemen of survey data quality.",
  "🧷 'Select all that apply' vs 'select one' — a missing instruction quietly changes how people answer.",
  "🌐 Every model call routes through a Cloudflare AI Gateway — one pane of glass for cost, latency and logs.",
  "♻️ Catch it in QA, or re-field the whole sample. One of these is much cheaper.",
  "🧭 Skip logic that takes the wrong branch strands respondents in questions that don't apply to them.",
  "📝 The questionnaire is the source of truth. The site is the suspect. We compare them line by line.",
  "🎲 Randomized option order is a feature — unless the doc says fixed and the site shuffles anyway.",
  "🧩 A grid row present in the doc but missing on the site is a classic silent data hole.",
  "⌨️ Numeric-entry fields with the wrong range let impossible answers through. Validation matters.",
  "🫧 Encoding artifacts love to hide in apostrophes, em-dashes, and accented characters.",
  "🔬 The verbatim-quote check is our lie detector: no evidence in both documents, no finding.",
  "📮 A survey goes live once. Getting it right the first time is the whole game.",
  "🧮 Sum-to-100 allocation questions that don't enforce 100 become a data-cleaning nightmare later.",
  "🦾 While you read this, three LLMs are arguing about a comma. Productively.",
  "🎛️ Matrix questions with too many rows are where respondent attention goes to die.",
  "👀 Humans miss the tenth typo on page four. The machine reads page four exactly as hard as page one.",
  "📚 A well-QA'd survey is boring to read and beautiful to analyze.",
  "🧊 The report shows each issue once — with which models agreed and the proof. No wall of duplicates.",
  "⚙️ DeepSeek and Grok run in the Worker; Claude joins in-Worker with a key, or via a $0 fallback runner.",
  "🔒 A finding is only trusted when it quotes both the doc and the rendered page. Trust, but verify — literally.",
  "🌡️ A mislabeled scale point turns a 5-point Likert into apples and oranges at analysis time.",
  "🪲 The bugs scurrying across this screen are decorative. The real ones are being caught server-side.",
  "🏷️ Brand lists drift: one option quietly renamed between the doc and the build can skew share-of-preference.",
  "🧬 Two surveys, one truth: we diff the Word doc against the live site so respondents never see the difference.",
  "⌛ Most of the wait is the browser walk — rendering and reading every page like a real respondent.",
  "🗜️ We parse the .docx in the Worker itself — no upload to a third-party service, no round-trip.",
  "🎚️ Endpoints-only vs fully-labeled scales measure different things. If the doc says one, the site should match.",
  "🧠 Ensemble recall: three independent readers catch what any single model would miss.",
  "📴 A required question accidentally set optional is the kind of bug that only shows up in the data.",
  "🔎 We don't just check questions — instructions, option labels, scale points, and numbering all get read.",
  "🇯🇵 CJK surveys are where encoding bugs hide best. The walker reads 日本語 as carefully as English.",
  "🧯 Every real error caught here is one that never reaches a respondent — or your dataset.",
  "🤝 The more models flag the same issue, the higher its confidence in the final report.",
  "🕰️ Fielding first and QA-ing later is the most expensive order of operations in research.",
  "🌀 Reordered options can flip a 'top-2-box' score without changing a single word.",
  "✅ When this finishes you'll get one clean, ranked, de-duplicated list of issues — each with its evidence.",
];

/** The real in-Worker pipeline. Stages light up from the status API's honest
 *  stage field (0 parse, 1 walk, 2 compare), inferred from real R2 artifacts;
 *  this page advances to the report on completion. */
const STAGES: { icon: string; name: string }[] = [
  { icon: "📄", name: "Parse docx" },
  { icon: "🌐", name: "Browser walks pages" },
  { icon: "🧠", name: "DeepSeek compare (deepseek-v4-pro)" },
  { icon: "🤖", name: "Grok compare (grok-4.3)" },
  { icon: "✨", name: "Claude compare (claude-sonnet-4-6)" },
  { icon: "🔍", name: "Quote verification" },
  { icon: "📊", name: "Report" },
];

/** Routing already restricts runId to [\w-]+, but validate defensively:
 *  strip anything outside [\w-] so the id is safe to embed in HTML and JS. */
function sanitizeRunId(runId: string): string {
  return runId.replace(/[^\w-]/g, "").slice(0, 80);
}

export function processingPage(runId: string): string {
  const id = sanitizeRunId(runId) || "unknown";

  const stageCards = STAGES.map(
    (s, i) => `
          <li class="stage${i === 0 ? " is-run" : ""}" id="stage-${i}">
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
<meta name="color-scheme" content="light dark">
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
<link rel="preload" href="/fonts/instrument-serif-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/dm-sans-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/jetbrains-mono-400.woff2" as="font" type="font/woff2" crossorigin>
<style>
${THEME_CSS}

/* ---------- processing-page components ---------- */
.wrap { max-width: 920px; }
.masthead { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.masthead-text { min-width: 0; }
.band .kicker { color: var(--kicker); }
.subtitle { margin: 12px 0 0; font-size: 15px; color: var(--band-soft); }
.elapsed-chip {
  display: inline-block; margin-left: 12px; padding: 2px 12px;
  border: 1px solid var(--border-strong); border-radius: var(--radius-pill);
  font-family: var(--mono); font-size: 12.5px; color: var(--band-text);
}

main { padding: 32px 0 40px; position: relative; z-index: 1; }
.arena { position: relative; }
.card {
  background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 24px 28px 26px; margin-bottom: 24px; box-shadow: var(--shadow);
}
.card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.badge-est {
  flex: none; display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 11px; border-radius: var(--radius-pill);
  background: var(--surface-2); border: 1px solid var(--border);
  font-family: var(--mono); font-size: 10px; font-weight: 400;
  text-transform: uppercase; letter-spacing: 0.09em; color: var(--slate);
}
.badge-est::before {
  content: ""; width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent); animation: pulse 1.6s var(--ease-in-out) infinite;
}

/* animated pipeline — stages light up per the run's real stage (parse / walk / compare) */
.pipeline { list-style: none; display: flex; gap: 16px; position: relative; margin: 22px 0 0; padding: 0; }
.pipeline::before {
  content: ""; position: absolute; left: 3%; right: 3%; top: 50%;
  height: 2px; background: var(--border); z-index: 0;
}
.stage {
  position: relative; z-index: 1; flex: 1;
  display: flex; flex-direction: column; align-items: center; gap: 7px;
  text-align: center; background: var(--stage-bg); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 15px 10px 13px;
  transition: border-color 0.4s ease, background 0.4s ease, box-shadow 0.4s ease;
}
.stage-icon { font-size: 22px; line-height: 1; filter: grayscale(0.6); opacity: 0.6; transition: filter 0.4s ease, opacity 0.4s ease; }
.stage-name { font-size: 12px; font-weight: 600; line-height: 1.3; color: var(--muted); transition: color 0.4s ease; }
.stage-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--dot-idle); }
.stage.is-run {
  background: var(--card);
  border-color: color-mix(in srgb, var(--accent) 32%, var(--border));
}
.stage.is-run .stage-icon { filter: none; opacity: 1; }
.stage.is-run .stage-name { color: var(--ink); }
.stage.is-run .stage-dot { background: var(--accent); animation: pulse 1.6s ease-in-out infinite; }
.stage.is-done { background: var(--card); }
.stage.is-done .stage-icon { filter: none; opacity: 0.9; }
.stage.is-done .stage-name { color: var(--ink); }
.stage.is-done .stage-dot { background: var(--accent); }
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

/* trivia card */
.trivia-card { min-height: 132px; }
.z-top { position: relative; z-index: 6; pointer-events: none; }
.trivia { margin: 8px 0 0; min-height: 46px; max-width: 660px; font-size: 15px; line-height: 1.6; color: var(--text); transition: opacity 0.4s ease; }
.trivia.is-fading { opacity: 0; }

/* bug mini-game */
#bugLayer { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 5; }
.bug {
  position: absolute; left: 0; top: 0; border: 0; margin: 0; padding: 5px;
  background: transparent; font-size: 24px; line-height: 1; cursor: pointer;
  pointer-events: auto; animation: scurry var(--bug-dur, 7s) linear forwards; will-change: transform;
}
@keyframes scurry {
  from { transform: translateX(var(--x0, -60px)) translateY(0); }
  to   { transform: translateX(var(--x1, 100vw)) translateY(var(--y1, 0px)); }
}
.bug > span { display: inline-block; animation: bob 0.5s ease-in-out infinite alternate; }
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
.squash-chip {
  position: fixed; right: 18px; bottom: 18px; z-index: 20;
  background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: var(--shadow); padding: 10px 16px; max-width: 240px;
}
.squash-chip strong { display: block; font-size: 13px; color: var(--ink); }
.squash-chip small { display: block; font-size: 11px; color: var(--muted); margin-top: 2px; }

footer { padding: 0 28px 96px; }

@media (prefers-reduced-motion: reduce) {
  .stage, .stage-icon, .stage-name { transition: none; }
  .stage.is-run .stage-dot { animation: none; }
  .badge-est::before { animation: none; }
  .trivia { transition: none; }
  .bug { animation: none; }
  .bug > span { animation: none; }
  .bug.is-squashed > span { animation: none; opacity: 0.35; }
}
</style>
</head>
<body>

<div class="aurora" aria-hidden="true"><span class="aurora__glow"></span></div>

<button type="button" id="themeToggle" class="theme-toggle" aria-label="Toggle dark mode" title="Toggle dark mode">
  <span class="tt-moon" aria-hidden="true">&#127769;</span>
  <span class="tt-sun" aria-hidden="true">&#9728;&#65039;</span>
</button>

<header class="band">
  <div class="wrap">
    <div class="masthead">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 48 48" width="34" height="34" role="img" aria-label="Survey QA logo">
          <rect x="3" y="3" width="42" height="42" rx="11" fill="currentColor"></rect>
          <rect x="13" y="26" width="5" height="11" rx="1.5" data-paper opacity=".95"></rect>
          <rect x="21.5" y="19" width="5" height="18" rx="1.5" data-paper opacity=".95"></rect>
          <rect x="30" y="12" width="5" height="25" rx="1.5" data-paper opacity=".95"></rect>
        </svg>
      </span>
      <div class="masthead-text">
        <div class="kicker">Survey QA · Run in progress</div>
        <h1 class="brand">Run <code>${id}</code></h1>
      </div>
    </div>
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
        <span class="badge-est">live</span>
      </div>
      <ol class="pipeline">${stageCards}
      </ol>
      <p class="pipe-note">Your run is executing the whole pipeline server-side. DeepSeek (deepseek-v4-pro)
        and Grok (grok-4.3) always run in the Worker; Claude (claude-sonnet-4-6) runs in the Worker when an
        Anthropic key is set, otherwise the $0 fallback runner completes it — every call routes through the
        Cloudflare AI Gateway. Each stage lights up as the run actually reaches it (parsing &rarr; browser
        walk &rarr; comparison), and this page advances to the report the moment the run finishes. A run
        usually takes a few minutes (longer for an external survey URL &mdash; the browser walk and the
        comparison are the slow parts), so keep this tab open.</p>
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

  var REDUCED = false;
  try {
    REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) { /* no matchMedia — assume motion is fine */ }

  /* Elapsed clock baseline. Date.now() is only a first guess: the status
     API reports the run's real startedAt, which poll() adopts as soon as it
     arrives — so the clock survives page refreshes instead of resetting to
     zero on every load. There is no estimated-stage advancement: the pipeline
     is shown running until the run reaches a terminal status and this page
     reloads into the report. */
  var startedAt = Date.now();
  var startedAtLocked = false;
  var squashed = 0;

  function adoptStartedAt(iso) {
    if (startedAtLocked || typeof iso !== "string") return;
    var t = Date.parse(iso);
    if (!isNaN(t) && t <= Date.now()) {
      startedAt = t;
      startedAtLocked = true;
      tick(); /* re-render the clock against the real baseline */
    }
  }

  function elapsedSec() { return Math.max(0, Math.floor((Date.now() - startedAt) / 1000)); }
  function fmtElapsed(s) {
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  /* ----- real elapsed clock (no estimated stage) ----- */

  function tick() {
    var el = document.getElementById("elapsed");
    if (el) el.textContent = fmtElapsed(elapsedSec());
  }
  var tickTimer = setInterval(tick, 1000);
  tick();

  var live = document.getElementById("live");
  if (live) live.textContent = "Your run is processing. This page advances to the report automatically when it finishes.";

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

  /* ----- status polling -----
     "processing" keeps this waiting page. A known terminal status (complete,
     awaiting-claude or failed) reloads, so the server swaps in the report or
     the failure page. A 404 (the run expired or was evicted) — or a run of
     unreadable polls (missing/unknown status, network/server errors) — stops
     here with a clear message instead of polling this page forever. */

  var pollTimer = null;
  var gaveUp = false;
  var pollFailStreak = 0;
  var MAX_POLL_FAILS = 24; /* ~2 minutes at the 5 s cadence */

  function stopWaiting() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function giveUp(title, message) {
    if (gaveUp) return;
    gaveUp = true;
    stopWaiting(); /* stop polling and freeze the elapsed clock */

    var card = document.createElement("section");
    card.className = "card";
    card.setAttribute("role", "alert");
    card.innerHTML =
      '<div class="card-head"><div>' +
        '<div class="kicker">Run status</div>' +
        '<h2 id="giveupTitle"></h2>' +
      '</div></div>' +
      '<p id="giveupMsg" style="margin:0 0 16px; color: var(--slate);"></p>' +
      '<p style="margin:0;"><a href="/" style="color: var(--accent); font-weight:600;">Start a new run &rarr;</a></p>';
    /* Dynamic strings go in via textContent — no HTML injection, no escaping to get wrong. */
    var titleEl = card.querySelector("#giveupTitle");
    if (titleEl) titleEl.textContent = title;
    var msgEl = card.querySelector("#giveupMsg");
    if (msgEl) msgEl.textContent = message;

    var arena = document.querySelector(".arena");
    if (arena) { arena.innerHTML = ""; arena.appendChild(card); }
    var sub = document.querySelector(".subtitle");
    if (sub) sub.textContent = title + ".";
    var liveEl = document.getElementById("live");
    if (liveEl) liveEl.textContent = title + ". " + message;
  }

  function bumpPollFail() {
    if (gaveUp) return;
    pollFailStreak++;
    if (pollFailStreak >= MAX_POLL_FAILS) {
      giveUp("Run status unavailable",
        "Survey QA stopped responding for run " + RUN_ID + " across " + pollFailStreak +
        " checks, so this page gave up. Reload to try again, or start a new run.");
    }
  }

  var maxStage = 0; /* monotonic: a reordered/slow poll can't regress the lights */
  /* Honest per-stage lighting from the status API stage field (0 parse, 1 walk,
     2 compare), inferred from real R2 artifacts — no guessed clock. Finished
     stages go solid, the current group keeps pulsing, later stages stay idle. */
  function lightStages(stage) {
    for (var i = 0; ; i++) {
      var el = document.getElementById("stage-" + i);
      if (!el) break;
      var cls;
      if (i === 0) cls = stage >= 1 ? "is-done" : "is-run";
      else if (i === 1) cls = stage >= 2 ? "is-done" : (stage >= 1 ? "is-run" : "");
      else if (i >= 2 && i <= 4) cls = stage >= 2 ? "is-run" : "";
      else cls = "";
      el.className = "stage" + (cls ? " " + cls : "");
    }
  }

  function poll() {
    if (gaveUp) return;
    fetch("/api/runs/" + RUN_ID)
      .then(function (res) {
        if (res.status === 404) {
          var e = new Error("run not found");
          e.notFound = true;
          throw e;
        }
        if (!res.ok) throw new Error("status endpoint returned HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (gaveUp) return;
        if (!data) { bumpPollFail(); return; }
        adoptStartedAt(data.startedAt);
        var st = data.status;
        if (st === "processing") { pollFailStreak = 0; if (typeof data.stage === "number") { maxStage = Math.max(maxStage, data.stage); lightStages(maxStage); } return; }
        if (st === "complete" || st === "awaiting-claude" || st === "failed") {
          location.reload(); /* server now serves the report or failure page */
          return;
        }
        bumpPollFail(); /* missing or unrecognized status — don't spin on it */
      })
      .catch(function (err) {
        if (gaveUp) return;
        if (err && err.notFound) {
          giveUp("Run not found",
            "The server no longer has run " + RUN_ID + " — it may have finished long ago and " +
            "expired, or been evicted. This page has stopped checking.");
          return;
        }
        bumpPollFail(); /* transient network / server error — bounded, not forever */
      });
  }
  pollTimer = setInterval(poll, 5000);
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
    var startY = Math.floor(h * (0.05 + Math.random() * 0.82));
    btn.style.top = startY + "px";

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
      btn.style.setProperty("--y1", (Math.floor(h * (0.05 + Math.random() * 0.82)) - startY) + "px");
      btn.style.setProperty("--bug-dur", durMs + "ms");
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

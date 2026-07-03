// Emits 3 standalone theme-preview HTML files (openable directly in a browser).
// Each renders a realistic Survey QA UI mock in that direction's palette, with a
// working light/dark toggle and the smooth 220ms theme transition.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const outDir = dirname(fileURLToPath(import.meta.url));

const DIRECTIONS = [
  {
    id: "A", slug: "clinical-slate", name: "Clinical Slate",
    mood: "Lab-instrument UI — cool neutral greys + one saturated signal blue. The strongest enterprise-credible break from the AI-default cream/terracotta look.",
    fontLink: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap",
    serif: '"IBM Plex Sans", "Segoe UI", system-ui, Helvetica, Arial, sans-serif',
    mono: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, "Courier New", monospace',
    light: `--ink:#16212B;--paper:#F3F5F7;--card:#FFFFFF;--accent:#1755C4;--accent-dark:#12459E;--ok:#0B5D38;--bad:#BE3B27;--slate:#56646F;--border:#DCE1E7;--text:#1C2833;--muted:#56646F;--btn-text:#FFFFFF;--band-bg:#101820;--band-title:#FFFFFF;--band-text:#E8EDF2;--band-muted:#93A3B3;--band-soft:#C3CFDA;--band-link:#8AB4FF;--tint:#E9EEF3;--tint-soft:#F8FAFC;--code-bg:#101820;--code-text:#DFE7EE;--input-bg:#FFFFFF;--input-border:#C9D2DB;--focus-ring:rgba(23,85,196,.5);--focus-soft:rgba(23,85,196,.16);--pulse:rgba(23,85,196,.35);--wait-bg:#E3ECFA;--wait-text:#1B4FA8;--ok-bg:#DFF1E7;--bad-bg:#FBE9E6;--done-border:#B5D9C5;--done-bg:#EFF7F2;--err-bg:#FBEBEA;--err-border:#ECC8C4;--err-text:#8C2420;--shadow:0 1px 2px rgba(16,24,32,.05),0 10px 28px rgba(16,24,32,.07);`,
    dark: `--ink:#F2F5F8;--paper:#11161C;--card:#1A222B;--accent:#7CAEFF;--accent-dark:#99C0FF;--ok:#3FB378;--bad:#FF9C8F;--slate:#97A5B4;--border:#2A3542;--text:#E2E8EE;--muted:#9AA8B6;--btn-text:#0D1319;--band-bg:#0B0F14;--band-title:#F2F5F8;--band-text:#E2E8EE;--band-muted:#8FA0B0;--band-soft:#BECBD8;--band-link:#9CC2FF;--tint:#161D25;--tint-soft:#141B22;--code-bg:#0D1218;--code-text:#DAE3EC;--input-bg:#141B22;--input-border:#33404E;--focus-ring:rgba(124,174,255,.55);--focus-soft:rgba(124,174,255,.22);--pulse:rgba(124,174,255,.38);--wait-bg:rgba(124,174,255,.14);--wait-text:#A9C9FF;--ok-bg:rgba(63,179,120,.15);--bad-bg:rgba(255,156,143,.15);--done-border:#2C5943;--done-bg:rgba(63,179,120,.1);--err-bg:rgba(255,156,143,.12);--err-border:rgba(255,156,143,.4);--err-text:#FFB3A9;--shadow:0 1px 2px rgba(0,0,0,.5),0 10px 28px rgba(0,0,0,.45);`,
  },
  {
    id: "B", slug: "deep-teal-terminal", name: "Deep Teal Terminal",
    mood: "Dark-first monitoring console — near-black teal surfaces + a bright mint accent. Matches the live-agent/streaming-findings demo moments; most memorable for judges.",
    fontLink: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap",
    serif: '"Space Grotesk", "Segoe UI", system-ui, Helvetica, Arial, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
    light: `--ink:#0F2422;--paper:#F1F6F5;--card:#FFFFFF;--accent:#096658;--accent-dark:#07564A;--ok:#156B3F;--bad:#A63220;--slate:#435659;--border:#D8E2E0;--text:#14282A;--muted:#435659;--btn-text:#FFFFFF;--band-bg:#071012;--band-title:#FFFFFF;--band-text:#DCE7E5;--band-muted:#85999B;--band-soft:#B4C8C3;--band-link:#7CE8C9;--tint:#E5EEEC;--tint-soft:#F7FAF9;--code-bg:#08211E;--code-text:#C7E8DC;--input-bg:#FFFFFF;--input-border:#C5D3D0;--focus-ring:rgba(9,102,88,.45);--focus-soft:rgba(9,102,88,.16);--pulse:rgba(9,102,88,.35);--wait-bg:#F7EFD3;--wait-text:#674D0C;--ok-bg:#DDF2E4;--bad-bg:#FBE9E6;--done-border:#B2DAC3;--done-bg:#EFF8F2;--err-bg:#FBECEA;--err-border:#EDCBC5;--err-text:#8F2A21;--shadow:0 1px 2px rgba(7,16,18,.05),0 10px 28px rgba(7,16,18,.07);`,
    dark: `--ink:#EDF5F3;--paper:#0B1416;--card:#101E21;--accent:#35D3AC;--accent-dark:#5FE0BF;--ok:#74D389;--bad:#F98576;--slate:#8FA6A2;--border:#24363A;--text:#DCE7E5;--muted:#93A9A5;--btn-text:#062019;--band-bg:#060D0F;--band-title:#EDF5F3;--band-text:#DCE7E5;--band-muted:#7E9490;--band-soft:#B4C8C3;--band-link:#7CE8C9;--tint:#122023;--tint-soft:#101C1F;--code-bg:#07110F;--code-text:#B8E6D2;--input-bg:#0F1B1E;--input-border:#2E4247;--focus-ring:rgba(53,211,172,.55);--focus-soft:rgba(53,211,172,.2);--pulse:rgba(53,211,172,.38);--wait-bg:rgba(242,206,114,.13);--wait-text:#F2CE72;--ok-bg:rgba(116,211,137,.14);--bad-bg:rgba(249,133,118,.16);--done-border:#2C5B41;--done-bg:rgba(116,211,137,.1);--err-bg:rgba(249,133,118,.12);--err-border:rgba(249,133,118,.4);--err-text:#FFAFA4;--shadow:0 1px 2px rgba(0,0,0,.55),0 10px 28px rgba(0,0,0,.5);`,
  },
  {
    id: "C", slug: "editorial-refined", name: "Editorial Refined",
    mood: "Keeps the findings-report feel but fixes what read 'off': cool warm-grey paper, charcoal band, a deep consulting-deck violet accent (never confusable with error red). Fraunces stays.",
    fontLink: "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..700&display=swap",
    serif: '"Fraunces", Georgia, "Times New Roman", serif',
    mono: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, "Courier New", monospace',
    light: `--ink:#1E2027;--paper:#F6F5F0;--card:#FFFFFF;--accent:#6740B4;--accent-dark:#543394;--ok:#1B6B43;--bad:#B8442B;--slate:#5A616D;--border:#E0DED6;--text:#23252C;--muted:#5A616D;--btn-text:#FFFFFF;--band-bg:#1E2027;--band-title:#FFFFFF;--band-text:#E9E8E1;--band-muted:#9AA0AD;--band-soft:#C4C8D2;--band-link:#C9B4F5;--tint:#EEEDE6;--tint-soft:#FAF9F5;--code-bg:#1E2027;--code-text:#E9E8E1;--input-bg:#FFFFFF;--input-border:#D3D1C7;--focus-ring:rgba(103,64,180,.45);--focus-soft:rgba(103,64,180,.16);--pulse:rgba(103,64,180,.35);--wait-bg:#F5ECD6;--wait-text:#7A5A10;--ok-bg:#E0F0E6;--bad-bg:#FBEAE5;--done-border:#B9DBC8;--done-bg:#F0F8F3;--err-bg:#F9ECEA;--err-border:#EACCC6;--err-text:#832B23;--shadow:0 1px 2px rgba(30,32,39,.05),0 10px 28px rgba(30,32,39,.07);`,
    dark: `--ink:#F3F1EA;--paper:#17181D;--card:#20222A;--accent:#BBA0F2;--accent-dark:#CDB8F7;--ok:#43AC77;--bad:#F49385;--slate:#9DA1AB;--border:#30333D;--text:#E6E4DD;--muted:#A0A3AC;--btn-text:#17181D;--band-bg:#101116;--band-title:#F3F1EA;--band-text:#E6E4DD;--band-muted:#8F93A0;--band-soft:#C0C4CE;--band-link:#CDB8F7;--tint:#1C1E24;--tint-soft:#1A1C22;--code-bg:#121318;--code-text:#E2E0D8;--input-bg:#1A1C22;--input-border:#3A3E49;--focus-ring:rgba(187,160,242,.55);--focus-soft:rgba(187,160,242,.22);--pulse:rgba(187,160,242,.38);--wait-bg:rgba(233,200,110,.13);--wait-text:#E9C86E;--ok-bg:rgba(67,172,119,.14);--bad-bg:rgba(244,147,133,.14);--done-border:#2E5A45;--done-bg:rgba(67,172,119,.1);--err-bg:rgba(244,147,133,.12);--err-border:rgba(244,147,133,.4);--err-text:#F5AFA4;--shadow:0 1px 2px rgba(0,0,0,.5),0 10px 28px rgba(0,0,0,.45);`,
  },
];

const page = (d, others) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>
(function(){var t=null;try{t=localStorage.getItem("sqa-preview-theme");}catch(e){}
if(t!=="light"&&t!=="dark"){t="light";try{if(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)t="dark";}catch(e){}}
document.documentElement.dataset.theme=t;
requestAnimationFrame(function(){requestAnimationFrame(function(){document.documentElement.classList.add("theme-ready");});});})();
</script>
<title>Survey QA theme — ${d.name}</title>
<link href="${d.fontLink}" rel="stylesheet">
<style>
  :root{color-scheme:light;${d.light}--serif:${d.serif};--sans:system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;--mono:${d.mono};}
  @media screen{html[data-theme="dark"]{color-scheme:dark;${d.dark}}}
  html.theme-ready body,html.theme-ready body *,html.theme-ready body *::before,html.theme-ready body *::after{transition:background-color 220ms ease,color 220ms ease,border-color 220ms ease,box-shadow 220ms ease;}
  @media (prefers-reduced-motion:reduce){html.theme-ready body,html.theme-ready body *{transition:none!important;}}
  *{box-sizing:border-box;}
  body{margin:0;font-family:var(--sans);background:var(--paper);color:var(--text);line-height:1.55;font-size:14px;}
  .wrap{max-width:1080px;margin:0 auto;padding:0 26px;}
  a{color:var(--accent);}
  h2{font-family:var(--serif);font-weight:600;font-size:23px;color:var(--ink);margin:0 0 16px;}
  .kicker{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.16em;color:var(--accent);margin-bottom:6px;}
  .mono{font-family:var(--mono);}.num{font-variant-numeric:tabular-nums;}
  /* theme toggle */
  .tt{position:fixed;top:14px;right:14px;z-index:50;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:50%;background:var(--card);box-shadow:var(--shadow);font-size:17px;cursor:pointer;}
  .tt .sun{display:none;}html[data-theme="dark"] .tt .sun{display:block;}html[data-theme="dark"] .tt .moon{display:none;}
  /* switcher */
  .switch{position:fixed;top:14px;left:14px;z-index:50;display:flex;gap:6px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:5px;box-shadow:var(--shadow);font-size:12px;}
  .switch a{padding:5px 9px;border-radius:6px;text-decoration:none;color:var(--muted);font-weight:600;}
  .switch a.on{background:var(--accent);color:var(--btn-text);}
  /* band */
  .band{background:var(--band-bg);color:var(--band-text);padding:52px 0 46px;border-bottom:4px solid var(--accent);}
  .brand{font-family:var(--serif);font-weight:600;font-size:42px;margin:0;color:var(--band-title);}
  .tagline{font-size:12px;text-transform:uppercase;letter-spacing:.14em;color:var(--band-muted);margin-top:8px;}
  .vp{max-width:720px;margin:18px 0 0;font-size:16px;color:var(--band-soft);}
  .vp b{color:var(--band-title);}
  .band-meta{margin-top:22px;display:flex;gap:26px;flex-wrap:wrap;font-size:13px;}
  .band-meta span{color:var(--band-muted);}.band-meta b{color:var(--band-text);font-weight:600;}
  .band a{color:var(--band-link);}
  main{padding:30px 0 60px;}
  section{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px 28px 28px;margin-bottom:24px;box-shadow:var(--shadow);}
  .mood{font-size:13.5px;color:var(--muted);margin:0 0 20px;max-width:760px;}
  /* KPI */
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;}
  .kpi{background:var(--tint-soft);border:1px solid var(--border);border-radius:11px;padding:15px 16px;}
  .kpi-label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600;}
  .kpi-val{font-family:var(--serif);font-size:30px;font-weight:600;color:var(--ink);margin-top:4px;}
  .kpi-val .den{font-size:16px;color:var(--muted);}
  .kpi-sub{font-size:12px;color:var(--muted);margin-top:2px;}
  /* buttons */
  .btn{display:inline-block;background:var(--accent);color:var(--btn-text);border:1px solid var(--accent);border-radius:8px;padding:10px 22px;font-weight:600;text-decoration:none;cursor:pointer;}
  .btn:hover{background:var(--accent-dark);border-color:var(--accent-dark);}
  .btn-ghost{background:transparent;border:1px solid rgba(127,127,127,.4);color:var(--band-text);}
  /* table */
  table{width:100%;border-collapse:collapse;font-size:13px;}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:8px 10px;border-bottom:2px solid var(--border);}
  td{padding:9px 10px;border-bottom:1px solid var(--border);}
  tr:hover td{background:var(--tint);}
  .center{text-align:center;}
  .caught{color:var(--ok);font-weight:700;}.missed{color:var(--muted);}
  /* chips */
  .chip{display:inline-block;font-size:11px;font-weight:600;padding:2px 9px;border-radius:20px;}
  .chip-cat{background:var(--tint);color:var(--slate);}
  .sev-high{background:var(--bad-bg);color:var(--bad);}
  .sev-med{background:var(--wait-bg);color:var(--wait-text);}
  .sev-low{background:var(--ok-bg);color:var(--ok);}
  .badge{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px;}
  .badge-ok{background:var(--ok-bg);color:var(--ok);}
  /* quote diff */
  .diff{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px;font-family:var(--mono);font-size:12px;}
  .diff div{padding:9px 11px;border-radius:7px;}
  .spec{background:var(--ok-bg);border:1px solid var(--done-border);}
  .site{background:var(--bad-bg);border:1px solid var(--err-border);}
  .diff .lbl{display:block;font-family:var(--sans);font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:3px;}
  /* code + wait */
  .cmd{background:var(--code-bg);color:var(--code-text);border-radius:8px;padding:12px 14px;font-family:var(--mono);font-size:12.5px;margin-top:10px;overflow-x:auto;}
  .notice{background:var(--wait-bg);color:var(--wait-text);border-radius:8px;padding:11px 14px;font-size:13px;margin-top:4px;}
  /* pipeline */
  .pipe{display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap;}
  .st{width:44px;height:44px;border-radius:11px;border:1px solid var(--border);background:var(--tint-soft);display:flex;align-items:center;justify-content:center;font-size:19px;position:relative;}
  .st.done{border-color:var(--done-border);background:var(--done-bg);}
  .st.done::after{content:"\\2713";position:absolute;right:3px;bottom:1px;font-size:9px;font-weight:700;color:var(--ok);}
  .st.cur{border-color:var(--accent);box-shadow:0 0 0 3px var(--focus-soft);}
  .link{width:22px;height:2px;background:var(--border);}
  footer{color:var(--muted);font-size:12px;text-align:center;padding:20px 0 40px;}
</style>
</head>
<body>
<div class="switch">${others}</div>
<button class="tt" id="tt" aria-label="Toggle dark mode"><span class="moon">🌙</span><span class="sun">☀️</span></button>

<div class="band"><div class="wrap">
  <div class="tagline">Theme preview — Direction ${d.id}</div>
  <h1 class="brand">Survey QA</h1>
  <div class="tagline">Automated questionnaire-to-website verification</div>
  <p class="vp"><b>${d.name}.</b> Parses the Word questionnaire, walks every survey page with a real browser, runs a <b>three-model comparison</b> with verbatim-quote verification, and delivers a findings report with a seeded-error scorecard.</p>
  <div class="band-meta"><span>Run <b class="mono">19564527</b></span><span>Survey <b>/survey.html</b></span><span>Languages <b>6</b></span><span>Toggle dark mode ↗ top-right</span></div>
  <p style="margin-top:24px;"><a class="btn" href="#">View report</a> &nbsp; <a class="btn btn-ghost" href="#">Preview the demo survey ↗</a></p>
</div></div>

<main><div class="wrap">
  <section>
    <p class="mood">${d.mood}</p>
    <div class="kpis">
      <div class="kpi"><div class="kpi-label">Claude recall</div><div class="kpi-val">10<span class="den">/10</span></div><div class="kpi-sub">100% of seeded errors</div></div>
      <div class="kpi"><div class="kpi-label">DeepSeek recall</div><div class="kpi-val">9<span class="den">/10</span></div><div class="kpi-sub">90% · $0.0082/run</div></div>
      <div class="kpi"><div class="kpi-label">Workers AI recall</div><div class="kpi-val">7<span class="den">/10</span></div><div class="kpi-sub">70% · $0.0063/run</div></div>
      <div class="kpi"><div class="kpi-label">Claude cost</div><div class="kpi-val">$0</div><div class="kpi-sub">subscription</div></div>
    </div>
  </section>

  <section>
    <div class="kicker">Live run</div><h2>Processing pipeline</h2>
    <div class="pipe">
      <div class="st done">📄</div><div class="link"></div>
      <div class="st done">🌐</div><div class="link"></div>
      <div class="st cur">🧠</div><div class="link"></div>
      <div class="st">🔍</div><div class="link"></div>
      <div class="st">📊</div>
      <span style="font-size:11px;color:var(--muted);margin-left:8px;">estimated</span>
    </div>
    <div class="notice">Awaiting Claude leg — browser walk and DeepSeek comparison done.</div>
    <div class="cmd">node runner/claude-runner.mjs --worker-url https://survey-qa.arcreactor81.workers.dev --run 19564527</div>
  </section>

  <section>
    <div class="kicker">Evaluation</div><h2>Seeded-error scorecard <span style="font-size:12px;color:var(--muted);">10 errors</span></h2>
    <table>
      <thead><tr><th>ID</th><th>Question</th><th>Category</th><th class="center">Claude</th><th class="center">DeepSeek</th><th class="center">Workers AI</th></tr></thead>
      <tbody>
        <tr><td class="mono num">E01</td><td class="mono num">S1</td><td><span class="chip chip-cat">typo</span></td><td class="center caught">✓</td><td class="center caught">✓</td><td class="center caught">✓</td></tr>
        <tr><td class="mono num">E02</td><td class="mono num">Q1</td><td><span class="chip chip-cat">missing-option</span></td><td class="center caught">✓</td><td class="center caught">✓</td><td class="center caught">✓</td></tr>
        <tr><td class="mono num">E05</td><td class="mono num">Q5</td><td><span class="chip chip-cat">scale-mislabel</span></td><td class="center caught">✓</td><td class="center missed">✗</td><td class="center missed">✗</td></tr>
        <tr><td class="mono num">E06</td><td class="mono num">Q2</td><td><span class="chip chip-cat">reordered-options</span></td><td class="center caught">✓</td><td class="center caught">✓</td><td class="center missed">✗</td></tr>
      </tbody>
    </table>
  </section>

  <section>
    <div class="kicker">Discrepancies</div><h2>Findings <span style="font-size:12px;color:var(--muted);">Claude</span></h2>
    <table>
      <thead><tr><th>Q</th><th>Category</th><th>Severity</th><th>Status</th></tr></thead>
      <tbody>
        <tr><td class="mono">Q4</td><td><span class="chip chip-cat">broken-piping</span></td><td><span class="chip sev-high">high</span></td><td><span class="badge badge-ok">verified</span></td></tr>
        <tr><td class="mono">Q6</td><td><span class="chip chip-cat">wrong-numbering</span></td><td><span class="chip sev-med">medium</span></td><td><span class="badge badge-ok">verified</span></td></tr>
        <tr><td class="mono">S1</td><td><span class="chip chip-cat">typo</span></td><td><span class="chip sev-low">low</span></td><td><span class="badge badge-ok">verified</span></td></tr>
      </tbody>
    </table>
    <div class="diff">
      <div class="spec"><span class="lbl">Questionnaire says</span>How satisfied are you with {Q3 brand}…</div>
      <div class="site"><span class="lbl">Site renders</span>How satisfied are you with {Q3brand}…</div>
    </div>
  </section>
</div></main>

<footer>Survey QA — theme preview (${d.name}). Toggle dark mode, top-right. Not the live app.</footer>

<script>
  var tt=document.getElementById("tt");
  if(tt)tt.addEventListener("click",function(){
    var cur=document.documentElement.dataset.theme==="dark"?"dark":"light";
    var next=cur==="dark"?"light":"dark";
    document.documentElement.dataset.theme=next;
    try{localStorage.setItem("sqa-preview-theme",next);}catch(e){}
  });
</script>
</body>
</html>`;

for (const d of DIRECTIONS) {
  const others = DIRECTIONS.map((o) => `<a href="theme-${o.slug}.html" class="${o.id === d.id ? "on" : ""}">${o.id}</a>`).join("");
  const file = join(outDir, `theme-${d.slug}.html`);
  writeFileSync(file, page(d, others), "utf8");
  console.log(`Wrote ${file}`);
}
console.log("\nOpen any of the 3 files in a browser. Use the A/B/C switcher (top-left) to compare, the sun/moon (top-right) for dark mode.");

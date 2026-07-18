// Shared "Editorial Medical" design system for survey-qa.
//
// This is the SINGLE SOURCE OF TRUTH for the design tokens, self-hosted fonts,
// and the common component vocabulary (masthead, panels, buttons, chips,
// badges, tables, footer, theme toggle, aurora backdrop). report.ts and
// processing.ts inline this string into their self-contained <style>; the
// static landing page mirrors it byte-for-byte at public/styles.css (which then
// appends its own landing-only component rules).
//
// KEEP public/styles.css IN SYNC with THEME_CSS — the top region of that file
// (down to the "END SHARED DESIGN SYSTEM" marker) must match this string.
//
// Design language (ported from the sibling pa-policy-extractor):
//   warm paper (light) / near-black (dark) canvas · muted lavender primary ·
//   sage kicker · dusty-sky + dusty-rose accents · Instrument Serif display
//   (italic <em> accents), DM Sans body, JetBrains Mono technical labels.
//   Light/dark via prefers-color-scheme + a manual [data-theme] override, with
//   the dark palette scoped to @media screen so print always renders on paper.
//
// Fonts are self-hosted at /fonts/ (served from public/ by the ASSETS binding)
// with a strong fallback stack, so a saved/offline report still reads.
// NOTE: any literal backslash inside this template string must be doubled.

export const THEME_CSS = `
/* ===== SHARED DESIGN SYSTEM — keep in sync with public/styles.css ===== */

/* ---- self-hosted fonts (font-src 'self' safe; strong fallbacks offline) ---- */
@font-face { font-family: "DM Sans"; font-style: normal; font-weight: 400; font-display: swap; src: url("/fonts/dm-sans-400.woff2") format("woff2"); }
@font-face { font-family: "DM Sans"; font-style: normal; font-weight: 500; font-display: swap; src: url("/fonts/dm-sans-500.woff2") format("woff2"); }
@font-face { font-family: "DM Sans"; font-style: normal; font-weight: 600; font-display: swap; src: url("/fonts/dm-sans-600.woff2") format("woff2"); }
@font-face { font-family: "Instrument Serif"; font-style: normal; font-weight: 400; font-display: swap; src: url("/fonts/instrument-serif-400.woff2") format("woff2"); }
@font-face { font-family: "Instrument Serif"; font-style: italic; font-weight: 400; font-display: swap; src: url("/fonts/instrument-serif-400i.woff2") format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-style: normal; font-weight: 400; font-display: swap; src: url("/fonts/jetbrains-mono-400.woff2") format("woff2"); }

/* ---- design tokens: light (default / paper) ---- */
:root {
  color-scheme: light dark;
  --serif: "Instrument Serif", "Iowan Old Style", Georgia, "Palatino Linotype", "Times New Roman", serif;
  --sans: "DM Sans", system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;

  --radius: 14px;
  --radius-sm: 8px;
  --radius-pill: 999px;
  --ease-spring: cubic-bezier(.3, .7, .4, 1);
  --ease-out: cubic-bezier(.16, 1, .3, 1);
  --ease-in-out: cubic-bezier(.65, 0, .35, 1);
  --dur-fast: .16s;
  --dur: .32s;
  --dur-slow: .5s;

  /* surfaces */
  --paper: #ECEFEA;
  --bg-grad-1: #E4E9E2;
  --bg-grad-2: #ECEFEA;
  --card: #EFF1ED;
  --surface-2: #E8ECE6;
  --surface-3: #E2E7E1;

  /* ink + hairlines */
  --ink: #3E453F;
  --text: #454C46;
  --slate: #5D655D;
  --muted: #5D655D;
  --text-faint: #616961;
  --border: #B4BBB3;
  --border-strong: #7D857D;

  /* accents — identity through hue, not saturation */
  --accent: #6E5AA8;          /* muted lavender (primary) */
  --accent-dark: #5B4A8F;
  --accent-solid: #5B4A8F;    /* filled controls */
  --accent-ink: #FFFFFF;      /* ink on filled controls */
  --btn-text: #FFFFFF;
  --primary-soft: #ECE7F6;
  --kicker: #4F6B48;          /* sage kicker */
  --link-hot: #9E5839;

  --ok: #4A6B41;
  --green-text: #3C5A34;
  --ok-bg: #DCEBD4;
  --bad: #A14F4B;
  --red-text: #8C4040;
  --bad-bg: #F5E4E4;
  --amber: #8A6D2A;
  --amber-text: #6D5621;
  --wait-bg: #F2EAD4;
  --wait-text: #6D5621;

  /* component-scoped tokens (repointed to editorial hues) */
  --tint: #E2E7E1;
  --tint-soft: #E8ECE6;
  --input-bg: #EFF1ED;
  --input-border: #7D857D;
  --focus-ring: rgba(110, 90, 168, .38);
  --focus-soft: rgba(110, 90, 168, .13);
  --pulse: rgba(110, 90, 168, .22);
  --done-border: #C6DBBD;
  --done-bg: #EEF4E8;
  --err-bg: #F7E7E4;
  --err-border: #E7C9C4;
  --err-text: #8C4040;
  --code-bg: #343B36;
  --code-text: #EDF0EA;

  /* masthead on paper (band recolored from the old dark hero) */
  --band-bg: #ECEFEA;
  --band-title: #3E453F;
  --band-text: #505851;
  --band-muted: #616961;
  --band-soft: #505851;
  --band-link: #6E5AA8;
  --band-dt: #616961;

  /* report-specific tints */
  --stage-bg: #E8ECE6;
  --dot-idle: #B4BBB3;
  --notice-bg: #DCEBD4;
  --notice-border: #C6DBBD;
  --notice-text: #3C5A34;
  --notice-code: #3E453F;
  --table-border: #CCD2CA;
  --row-hover: #E8ECE6;
  --mark-missed: #616961;
  --chip-cat-bg: #E2E7E1;
  --sev-med-bg: #F2EAD4;
  --sev-med-text: #6D5621;
  --sev-low-bg: #E2E7E1;
  --badge-muted-bg: #E2E7E1;
  --spec-bg: #DCEBD4;
  --spec-border: #C6DBBD;
  --site-bg: #F5E4E4;
  --site-border: #E7C9C4;
  --shot-bg: #E2E7E1;
  --note-text: #38617C;
  --note-bg: #E2ECF3;
  --note-border: #C6DAE6;

  --shadow-sm: 0 1px 2px rgba(32, 30, 27, .05);
  --shadow: 0 1px 2px rgba(32, 30, 27, .04), 0 7px 20px rgba(32, 30, 27, .05);
  --shadow-lg: 0 10px 26px rgba(32, 30, 27, .08);
  --glow-color: rgba(110, 90, 168, .05);
}

/* ---- design tokens: dark (near-black) — scoped to screen so print stays light ---- */
@media screen {
  html[data-theme="dark"] {
    color-scheme: dark;
    --paper: #181A18;
    --bg-grad-1: #1D201D;
    --bg-grad-2: #181A18;
    --card: #20231F;
    --surface-2: #252925;
    --surface-3: #2B302B;

    --ink: #D9DDD6;
    --text: #C9CEC6;
    --slate: #A4AAA2;
    --muted: #A4AAA2;
    --text-faint: #989F97;
    --border: #3A403A;
    --border-strong: #4A514A;

    --accent: #BBA8E0;
    --accent-dark: #CDBFEA;
    --accent-solid: #A597C2;
    --accent-ink: #1C1A26;
    --btn-text: #1C1A26;
    --primary-soft: rgba(187, 168, 224, .12);
    --kicker: #A8C4A0;
    --link-hot: #E8A889;

    --ok: #8FB183;
    --green-text: #C2D6BB;
    --ok-bg: rgba(168, 196, 160, .15);
    --bad: #D49A9A;
    --red-text: #E6C0C0;
    --bad-bg: rgba(212, 154, 154, .16);
    --amber: #D4B86A;
    --amber-text: #E2CF9A;
    --wait-bg: rgba(212, 184, 106, .14);
    --wait-text: #E2CF9A;

    --tint: #2B302B;
    --tint-soft: #252925;
    --input-bg: #20231F;
    --input-border: #7C857D;
    --focus-ring: rgba(187, 168, 224, .45);
    --focus-soft: rgba(187, 168, 224, .16);
    --pulse: rgba(187, 168, 224, .24);
    --done-border: #3A5236;
    --done-bg: #1B2A1E;
    --err-bg: rgba(212, 154, 154, .12);
    --err-border: rgba(212, 154, 154, .4);
    --err-text: #E6C0C0;
    --code-bg: #121512;
    --code-text: #C9CEC6;

    --band-bg: #181A18;
    --band-title: #D9DDD6;
    --band-text: #BBC2B9;
    --band-muted: #989F97;
    --band-soft: #BBC2B9;
    --band-link: #BBA8E0;
    --band-dt: #989F97;

    --stage-bg: #252925;
    --dot-idle: #4A514A;
    --notice-bg: rgba(168, 196, 160, .12);
    --notice-border: rgba(168, 196, 160, .38);
    --notice-text: #C2D6BB;
    --notice-code: #D9DDD6;
    --table-border: #3A403A;
    --row-hover: rgba(255,255,255,.04);
    --mark-missed: #90978F;
    --chip-cat-bg: rgba(164,170,162,.12);
    --sev-med-bg: rgba(212, 184, 106, .15);
    --sev-med-text: #E2CF9A;
    --sev-low-bg: rgba(164,170,162,.12);
    --badge-muted-bg: rgba(164,170,162,.12);
    --spec-bg: rgba(168, 196, 160, .13);
    --spec-border: rgba(168, 196, 160, .4);
    --site-bg: rgba(212, 154, 154, .14);
    --site-border: rgba(212, 154, 154, .4);
    --shot-bg: #252925;
    --note-text: #B6D3E6;
    --note-bg: rgba(137, 184, 212, .12);
    --note-border: rgba(137, 184, 212, .32);

    --shadow-sm: 0 1px 2px rgba(0, 0, 0, .3);
    --shadow: 0 1px 2px rgba(0, 0, 0, .25), 0 9px 24px rgba(0, 0, 0, .22);
    --shadow-lg: 0 12px 30px rgba(0, 0, 0, .27);
    --glow-color: rgba(187, 168, 224, .05);
  }
}

/* ---- base ---- */
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font-family: var(--sans);
  background: var(--paper);
  color: var(--text);
  line-height: 1.55;
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}
.wrap { max-width: 1140px; margin: 0 auto; padding: 0 28px; }
a { color: var(--accent); }
.mono { font-family: var(--mono); }
.num { font-variant-numeric: tabular-nums; }
a:focus-visible, button:focus-visible, input:focus-visible,
select:focus-visible, summary:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 4px;
}
.sr-only {
  position: absolute; width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  clip: rect(0 0 0 0); overflow: hidden; white-space: nowrap;
}

/* ---- editorial typographic voice ---- */
.kicker {
  font-family: var(--mono);
  font-size: 11.5px;
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: 0.11em;
  color: var(--kicker);
  margin-bottom: 6px;
}
h2 {
  margin: 0 0 18px;
  font-family: var(--serif);
  font-weight: 400;
  font-size: 27px;
  line-height: 1.15;
  color: var(--ink);
  letter-spacing: -0.01em;
}
h2 em, h3 em, .brand em { font-style: italic; color: var(--accent); }
h3 {
  margin: 26px 0 10px;
  font-family: var(--serif);
  font-weight: 400;
  font-size: 19px;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.sub { font-family: var(--sans); font-size: 12px; font-weight: 400; color: var(--slate); margin-left: 10px; }
.small { font-size: 11px; }
.muted { color: var(--muted); }

/* ---- aurora backdrop: flat paper + film grain + one static masthead glow ---- */
.aurora {
  position: fixed; inset: 0; z-index: -2;
  overflow: hidden; pointer-events: none; background: var(--paper);
}
.aurora::after {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.45'/%3E%3C/svg%3E");
  opacity: .024;
}
.aurora__glow {
  position: absolute; top: -140px; left: 50%;
  width: 820px; height: 560px; margin-left: -410px; border-radius: 50%;
  background: radial-gradient(closest-side, var(--glow-color), transparent 62%);
}
html[data-theme="dark"] .aurora::after { opacity: .06; }

/* ---- masthead (the old dark ".band" hero, recolored to paper/editorial) ---- */
.band {
  position: relative; z-index: 1;
  background: var(--band-bg);
  color: var(--band-text);
  padding: 46px 0 34px;
  border-bottom: 1px solid var(--border);
}
.brand-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.brand-mark { flex: 0 0 auto; color: var(--accent); }
.brand-mark svg { display: block; }
.brand-mark rect[data-paper] { fill: var(--paper); }
.brand {
  font-family: var(--serif);
  font-weight: 400;
  font-size: 44px;
  line-height: 1.05;
  letter-spacing: -0.01em;
  margin: 0;
  color: var(--band-title);
}
.brand code { font-family: var(--mono); font-size: 30px; color: var(--accent); }
.tagline {
  font-family: var(--mono);
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.10em;
  color: var(--band-muted);
}

/* ---- theme toggle (fixed, stays operable above the fullscreen overlay) ---- */
.theme-toggle {
  position: fixed; top: 14px; right: 14px; z-index: 260;
  width: 40px; height: 40px;
  display: flex; align-items: center; justify-content: center;
  padding: 0; border: 1px solid var(--border-strong);
  border-radius: 10px; background: var(--surface-2);
  box-shadow: var(--shadow-sm); font-size: 17px; line-height: 1; cursor: pointer;
  transition: transform var(--dur-fast) var(--ease-spring), border-color var(--dur-fast);
}
.theme-toggle:hover { border-color: var(--accent); transform: translateY(-1px); }
.theme-toggle .tt-sun { display: none; }
html[data-theme="dark"] .theme-toggle .tt-sun { display: block; }
html[data-theme="dark"] .theme-toggle .tt-moon { display: none; }

/* ---- buttons ---- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: .5rem;
  background: var(--accent-solid);
  color: var(--btn-text) !important;
  border: 1px solid var(--accent-solid);
  border-radius: 8px;
  padding: 11px 22px;
  font-family: var(--sans);
  font-size: 14px; font-weight: 600; letter-spacing: 0.01em;
  text-decoration: none; cursor: pointer;
  box-shadow: var(--shadow-sm);
  transition: filter var(--dur-fast), transform var(--dur-fast) var(--ease-spring), box-shadow var(--dur-fast);
}
.btn:hover { filter: brightness(1.03); }
.btn:active { transform: translateY(1px); }
.btn:disabled { opacity: 0.5; cursor: wait; box-shadow: none; }
.btn-ghost {
  background: transparent;
  border: 1px solid var(--border-strong);
  color: var(--text) !important;
  box-shadow: none;
}
.btn-ghost:hover { background: var(--surface-2); border-color: var(--accent); filter: none; }

/* ---- generic chips & badges ---- */
.chip {
  display: inline-block; padding: 2px 10px; border-radius: var(--radius-pill);
  font-family: var(--mono); font-size: 10.5px; font-weight: 400;
  text-transform: uppercase; letter-spacing: 0.06em; white-space: nowrap;
}
.chip-cat { background: var(--chip-cat-bg); color: var(--slate); }
.sev-high { background: var(--bad-bg); color: var(--bad); }
.sev-medium { background: var(--sev-med-bg); color: var(--sev-med-text); }
.sev-low { background: var(--sev-low-bg); color: var(--slate); }
.badge {
  display: inline-block; padding: 2px 9px; border-radius: 6px;
  font-family: var(--mono); font-size: 10.5px; font-weight: 400;
  letter-spacing: 0.02em; white-space: nowrap;
}
.badge-ok { background: var(--ok-bg); color: var(--green-text); }
.badge-bad { background: var(--bad-bg); color: var(--bad); }
.badge-muted { background: var(--badge-muted-bg); color: var(--slate); }
.pill {
  display: inline-block; padding: 2px 11px; border-radius: var(--radius-pill);
  font-size: 10.5px; font-weight: 600; background: var(--surface-3); color: var(--text);
  border: 1px solid var(--border);
}
.pill-ghost { background: transparent; color: var(--muted); }

/* ---- tables ---- */
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--table-border); vertical-align: top; }
thead th {
  font-family: var(--mono); font-size: 11px; font-weight: 400;
  text-transform: uppercase; letter-spacing: 0.08em; color: var(--slate);
  border-bottom: 2px solid var(--border); white-space: nowrap; background: transparent;
}
tbody tr:hover { background: var(--row-hover); }
td.num, th.num { font-variant-numeric: tabular-nums; }
.center { text-align: center; }

/* ---- footer ---- */
footer {
  text-align: center;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--text-faint);
  padding: 0 28px 40px;
  position: relative; z-index: 1;
}
footer a { color: var(--accent); }

/* ---- reduced motion ---- */
@media (prefers-reduced-motion: reduce) {
  .theme-toggle { transition: none; }
}

/* ---- smooth theme crossfade (enabled after first paint via .theme-ready) ---- */
html.theme-ready body, html.theme-ready body *, html.theme-ready body *::before, html.theme-ready body *::after {
  transition: background-color 220ms ease, color 220ms ease, border-color 220ms ease, box-shadow 220ms ease, fill 220ms ease, stroke 220ms ease;
}
@media (prefers-reduced-motion: reduce) {
  html.theme-ready body, html.theme-ready body *, html.theme-ready body *::before, html.theme-ready body *::after { transition: none !important; }
}

/* ---- print: force the light palette, drop decorative chrome ---- */
@media print {
  .theme-toggle, .aurora { display: none !important; }
  body { background: #FFFFFF; }
}
/* ===== END SHARED DESIGN SYSTEM ===== */
`;

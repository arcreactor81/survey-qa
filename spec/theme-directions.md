# Survey QA — Theme Directions Spec

**Status:** Proposal — 3 directions, palettes verified for WCAG AA (computed relative-luminance contrast, not eyeballed).
**Scope:** Drop-in replacement for the CSS custom properties in `public/index.html` (`:root` light block + `html[data-theme="dark"]` block). Variable names are unchanged. No markup changes required except the small transition fix at the bottom.
**Feedback addressed:**
1. *"Colors seem off"* — the current cream `#FAF8F3` + terracotta `#C2571B` + serif combination reads as the generic warm-editorial "AI default" look. All three directions below move to cooler, more precise, enterprise-credible palettes.
2. *"The transition is too sudden"* — dark/light toggle swaps instantly. Fix specified in the last section (smooth 220 ms transition, no flash on first paint, `prefers-reduced-motion` respected).

**Verification method:** WCAG 2.x relative luminance / contrast-ratio formula, computed programmatically for every text/background pair below. Translucent `rgba()` chip backgrounds were composited over their card background before measuring. Semantic ok/bad pairs additionally carry a **luminance gap** (stated per direction) so pass/fail states are distinguishable for red-green colorblind users without relying on hue alone; the UI already pairs status colors with text labels ("PASS"/"FAIL"), which remains the primary cue.

---

## Direction A — Clinical Slate

**Mood:** Lab-instrument UI. Cool neutral greys with a single saturated signal blue. Zero decoration; everything reads as measurement. The strongest fit for a QA/verification tool shown to enterprise stakeholders — the palette itself communicates "calibrated."

**Light swatch:** `🩶 #F3F5F7 paper · ⬜ #FFFFFF card · 🔵 #1755C4 accent · ⬛ #1C2833 text · 🟢 #0B5D38 ok · 🟥 #BE3B27 bad`
**Dark swatch:** `⬛ #11161C paper · 🌑 #1A222B card · 🔷 #7CAEFF accent · ⬜ #E2E8EE text · 🟩 #3FB378 ok · 🟠 #FF9C8F bad`

**Type pairing:** Drop Fraunces. Display face: **IBM Plex Sans** (Google Fonts, weights 500/600) — engineered, technical, designed for IBM's instrumentation heritage; it kills the "editorial default" read instantly.
`--serif` becomes (keep the variable name for drop-in): `"IBM Plex Sans", "Segoe UI", system-ui, Helvetica, Arial, sans-serif`
Body `--sans` and `--mono` stacks unchanged. Font link swap: `family=IBM+Plex+Sans:wght@400;500;600`.

**Computed contrast (WCAG AA):**

| Pair | Light | Dark |
|---|---|---|
| `--text` on `--paper` | **13.72:1** (#1C2833 / #F3F5F7) ✅ | **14.72:1** (#E2E8EE / #11161C) ✅ |
| `--accent` on `--paper` | **6.13:1** (#1755C4 / #F3F5F7) ✅ | **8.10:1** (#7CAEFF / #11161C) ✅ |
| `--muted` on `--paper` | 5.57:1 ✅ | 7.49:1 ✅ |
| `--btn-text` on `--accent` | 6.70:1 ✅ | 8.32:1 ✅ |
| `--ok` / `--bad` on `--paper` | 7.29:1 / 5.00:1 ✅ | 6.86:1 / 9.00:1 ✅ |
| `--band-text` on `--band-bg` | 15.19:1 ✅ | 15.57:1 ✅ |
| ok-vs-bad luminance gap | **1.46:1** | **1.31:1** |

All chip pairs (`--wait-text`/`--wait-bg`, `--ok` on `--ok-bg`, `--bad` on `--bad-bg`, `--err-text` on `--err-bg`, `--code-text` on `--code-bg`) verified ≥ 4.5:1 in both modes.

### A · Light

```css
:root {
  color-scheme: light;
  --ink: #16212B;
  --paper: #F3F5F7;
  --card: #FFFFFF;
  --accent: #1755C4;
  --accent-dark: #12459E;
  --ok: #0B5D38;
  --bad: #BE3B27;
  --slate: #56646F;
  --border: #DCE1E7;
  --text: #1C2833;
  --muted: #56646F;
  --btn-text: #FFFFFF;
  --band-bg: #101820;
  --band-title: #FFFFFF;
  --band-text: #E8EDF2;
  --band-muted: #93A3B3;
  --band-soft: #C3CFDA;
  --band-link: #8AB4FF;
  --tint: #E9EEF3;
  --tint-soft: #F8FAFC;
  --code-bg: #101820;
  --code-text: #DFE7EE;
  --input-bg: #FFFFFF;
  --input-border: #C9D2DB;
  --focus-ring: rgba(23, 85, 196, 0.50);
  --focus-soft: rgba(23, 85, 196, 0.16);
  --pulse: rgba(23, 85, 196, 0.35);
  --wait-bg: #E3ECFA;
  --wait-text: #1B4FA8;
  --ok-bg: #DFF1E7;
  --bad-bg: #FBE9E6;
  --done-border: #B5D9C5;
  --done-bg: #EFF7F2;
  --err-bg: #FBEBEA;
  --err-border: #ECC8C4;
  --err-text: #8C2420;
  --shadow: 0 1px 2px rgba(16, 24, 32, 0.05), 0 10px 28px rgba(16, 24, 32, 0.07);
}
```

### A · Dark

```css
html[data-theme="dark"] {
  color-scheme: dark;
  --ink: #F2F5F8;
  --paper: #11161C;
  --card: #1A222B;
  --accent: #7CAEFF;
  --accent-dark: #99C0FF;
  --ok: #3FB378;
  --bad: #FF9C8F;
  --slate: #97A5B4;
  --border: #2A3542;
  --text: #E2E8EE;
  --muted: #9AA8B6;
  --btn-text: #0D1319;
  --band-bg: #0B0F14;
  --band-title: #F2F5F8;
  --band-text: #E2E8EE;
  --band-muted: #8FA0B0;
  --band-soft: #BECBD8;
  --band-link: #9CC2FF;
  --tint: #161D25;
  --tint-soft: #141B22;
  --code-bg: #0D1218;
  --code-text: #DAE3EC;
  --input-bg: #141B22;
  --input-border: #33404E;
  --focus-ring: rgba(124, 174, 255, 0.55);
  --focus-soft: rgba(124, 174, 255, 0.22);
  --pulse: rgba(124, 174, 255, 0.38);
  --wait-bg: rgba(124, 174, 255, 0.14);
  --wait-text: #A9C9FF;
  --ok-bg: rgba(63, 179, 120, 0.15);
  --bad-bg: rgba(255, 156, 143, 0.15);
  --done-border: #2C5943;
  --done-bg: rgba(63, 179, 120, 0.10);
  --err-bg: rgba(255, 156, 143, 0.12);
  --err-border: rgba(255, 156, 143, 0.40);
  --err-text: #FFB3A9;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 10px 28px rgba(0, 0, 0, 0.45);
}
```

---

## Direction B — Deep Teal Terminal

**Mood:** Dark-first, data-forward, technical. Near-black teal surfaces with a bright mint accent — reads like a monitoring console / terminal, which matches what the product actually does (a browser agent walking survey pages and streaming findings). Light mode is a cool sea-glass neutral so the identity survives daytime demos.

**Light swatch:** `🌫️ #F1F6F5 paper · ⬜ #FFFFFF card · 🟦 #0B7364 accent · ⬛ #14282A text · 🟢 #156B3F ok · 🟥 #BE3E2E bad`
**Dark swatch:** `⬛ #0B1416 paper · 🌑 #101E21 card · 🟢 #35D3AC accent · ⬜ #DCE7E5 text · 🟩 #74D389 ok · 🟠 #F4695A bad`

**Type pairing:** Drop Fraunces. Display face: **Space Grotesk** (Google Fonts, 500/600) — geometric, slightly technical, distinctive without being decorative. Pair with **JetBrains Mono** for `--mono` (code blocks and tabular numbers are a first-class part of this identity).
`--serif` → `"Space Grotesk", "Segoe UI", system-ui, Helvetica, Arial, sans-serif`
`--mono` → `"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace`
Font link: `family=Space+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;500`.

**Note on accent vs `--ok` in dark mode:** both are green-family by design (terminal identity); they are never used to encode opposing states against each other — status is always ok-vs-bad, where the hue gap (green vs red-orange) *and* the luminance gap (1.63:1, the largest of the three directions) do the work.

**Computed contrast (WCAG AA):**

| Pair | Light | Dark |
|---|---|---|
| `--text` on `--paper` | **14.08:1** (#14282A / #F1F6F5) ✅ | **14.75:1** (#DCE7E5 / #0B1416) ✅ |
| `--accent` on `--paper` | **5.27:1** (#0B7364 / #F1F6F5) ✅ | **9.83:1** (#35D3AC / #0B1416) ✅ |
| `--muted` on `--paper` | 5.64:1 ✅ | 7.51:1 ✅ |
| `--btn-text` on `--accent` | 5.75:1 ✅ | 9.01:1 ✅ |
| `--ok` / `--bad` on `--paper` | 6.00:1 / 4.91:1 ✅ | 10.14:1 / 6.23:1 ✅ |
| `--band-text` on `--band-bg` | 15.21:1 ✅ | 15.49:1 ✅ |
| ok-vs-bad luminance gap | **1.22:1** | **1.63:1** |

All chip pairs verified ≥ 4.5:1 in both modes (dark chips composited over `--card`).

### B · Light

```css
:root {
  color-scheme: light;
  --ink: #0F2422;
  --paper: #F1F6F5;
  --card: #FFFFFF;
  --accent: #0B7364;
  --accent-dark: #085C50;
  --ok: #156B3F;
  --bad: #BE3E2E;
  --slate: #4F6663;
  --border: #D8E2E0;
  --text: #14282A;
  --muted: #4F6663;
  --btn-text: #FFFFFF;
  --band-bg: #071012;
  --band-title: #FFFFFF;
  --band-text: #DCE7E5;
  --band-muted: #85999B;
  --band-soft: #B4C8C3;
  --band-link: #7CE8C9;
  --tint: #E5EEEC;
  --tint-soft: #F7FAF9;
  --code-bg: #08211E;
  --code-text: #C7E8DC;
  --input-bg: #FFFFFF;
  --input-border: #C5D3D0;
  --focus-ring: rgba(11, 115, 100, 0.45);
  --focus-soft: rgba(11, 115, 100, 0.16);
  --pulse: rgba(11, 115, 100, 0.35);
  --wait-bg: #F7EFD3;
  --wait-text: #7A5E10;
  --ok-bg: #DDF2E4;
  --bad-bg: #FBE9E6;
  --done-border: #B2DAC3;
  --done-bg: #EFF8F2;
  --err-bg: #FBECEA;
  --err-border: #EDCBC5;
  --err-text: #8F2A21;
  --shadow: 0 1px 2px rgba(7, 16, 18, 0.05), 0 10px 28px rgba(7, 16, 18, 0.07);
}
```

### B · Dark

```css
html[data-theme="dark"] {
  color-scheme: dark;
  --ink: #EDF5F3;
  --paper: #0B1416;
  --card: #101E21;
  --accent: #35D3AC;
  --accent-dark: #5FE0BF;
  --ok: #74D389;
  --bad: #F4695A;
  --slate: #8FA6A2;
  --border: #24363A;
  --text: #DCE7E5;
  --muted: #93A9A5;
  --btn-text: #062019;
  --band-bg: #060D0F;
  --band-title: #EDF5F3;
  --band-text: #DCE7E5;
  --band-muted: #7E9490;
  --band-soft: #B4C8C3;
  --band-link: #7CE8C9;
  --tint: #122023;
  --tint-soft: #101C1F;
  --code-bg: #07110F;
  --code-text: #B8E6D2;
  --input-bg: #0F1B1E;
  --input-border: #2E4247;
  --focus-ring: rgba(53, 211, 172, 0.55);
  --focus-soft: rgba(53, 211, 172, 0.20);
  --pulse: rgba(53, 211, 172, 0.38);
  --wait-bg: rgba(242, 206, 114, 0.13);
  --wait-text: #F2CE72;
  --ok-bg: rgba(116, 211, 137, 0.14);
  --bad-bg: rgba(244, 105, 90, 0.16);
  --done-border: #2C5B41;
  --done-bg: rgba(116, 211, 137, 0.10);
  --err-bg: rgba(244, 105, 90, 0.12);
  --err-border: rgba(244, 105, 90, 0.40);
  --err-text: #FFAFA4;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.55), 0 10px 28px rgba(0, 0, 0, 0.5);
}
```

---

## Direction C — Editorial Refined

**Mood:** Keeps the report/document feel (this tool produces findings reports for humans), but fixes what reads "off": paper cools from cream to a neutral warm-grey, the navy band becomes charcoal, and terracotta is replaced with a deep violet — a consulting-deck accent (authoritative, rarely seen in AI-generated UIs) that cannot be confused with the error red.

**Light swatch:** `📄 #F6F5F0 paper · ⬜ #FFFFFF card · 🟣 #6740B4 accent · ⬛ #23252C text · 🟢 #1B6B43 ok · 🟥 #B8442B bad`
**Dark swatch:** `⬛ #17181D paper · 🌑 #20222A card · 💜 #BBA0F2 accent · ⬜ #E6E4DD text · 🟩 #43AC77 ok · 🟠 #F49385 bad`

**Type pairing:** **Keep Fraunces** — but only here. Rationale: this direction deliberately retains the editorial/report identity, and a high-contrast serif for headings is correct for that; the "AI default" smell came from Fraunces *plus* cream *plus* terracotta as a package, not the typeface alone. With cool paper and a violet accent, Fraunces reads as a deliberate report-house choice. Recommendation: restrict it to `h2`/`.brand` (already the case) and keep the existing fallback stack `"Fraunces", Georgia, "Times New Roman", serif`.

**Computed contrast (WCAG AA):**

| Pair | Light | Dark |
|---|---|---|
| `--text` on `--paper` | **14.02:1** (#23252C / #F6F5F0) ✅ | **13.93:1** (#E6E4DD / #17181D) ✅ |
| `--accent` on `--paper` | **6.48:1** (#6740B4 / #F6F5F0) ✅ | **7.95:1** (#BBA0F2 / #17181D) ✅ |
| `--muted` on `--paper` | 5.72:1 ✅ | 7.03:1 ✅ |
| `--btn-text` on `--accent` | 7.07:1 ✅ | 7.95:1 ✅ |
| `--ok` / `--bad` on `--paper` | 5.95:1 / 4.93:1 ✅ | 6.25:1 / 7.90:1 ✅ |
| `--band-text` on `--band-bg` | 13.24:1 ✅ | 14.82:1 ✅ |
| ok-vs-bad luminance gap | **1.21:1** | **1.26:1** |

All chip pairs verified ≥ 4.5:1 in both modes.

### C · Light

```css
:root {
  color-scheme: light;
  --ink: #1E2027;
  --paper: #F6F5F0;
  --card: #FFFFFF;
  --accent: #6740B4;
  --accent-dark: #543394;
  --ok: #1B6B43;
  --bad: #B8442B;
  --slate: #5A616D;
  --border: #E0DED6;
  --text: #23252C;
  --muted: #5A616D;
  --btn-text: #FFFFFF;
  --band-bg: #1E2027;
  --band-title: #FFFFFF;
  --band-text: #E9E8E1;
  --band-muted: #9AA0AD;
  --band-soft: #C4C8D2;
  --band-link: #C9B4F5;
  --tint: #EEEDE6;
  --tint-soft: #FAF9F5;
  --code-bg: #1E2027;
  --code-text: #E9E8E1;
  --input-bg: #FFFFFF;
  --input-border: #D3D1C7;
  --focus-ring: rgba(103, 64, 180, 0.45);
  --focus-soft: rgba(103, 64, 180, 0.16);
  --pulse: rgba(103, 64, 180, 0.35);
  --wait-bg: #F5ECD6;
  --wait-text: #7A5A10;
  --ok-bg: #E0F0E6;
  --bad-bg: #FBEAE5;
  --done-border: #B9DBC8;
  --done-bg: #F0F8F3;
  --err-bg: #F9ECEA;
  --err-border: #EACCC6;
  --err-text: #832B23;
  --shadow: 0 1px 2px rgba(30, 32, 39, 0.05), 0 10px 28px rgba(30, 32, 39, 0.07);
}
```

### C · Dark

```css
html[data-theme="dark"] {
  color-scheme: dark;
  --ink: #F3F1EA;
  --paper: #17181D;
  --card: #20222A;
  --accent: #BBA0F2;
  --accent-dark: #CDB8F7;
  --ok: #43AC77;
  --bad: #F49385;
  --slate: #9DA1AB;
  --border: #30333D;
  --text: #E6E4DD;
  --muted: #A0A3AC;
  --btn-text: #17181D;
  --band-bg: #101116;
  --band-title: #F3F1EA;
  --band-text: #E6E4DD;
  --band-muted: #8F93A0;
  --band-soft: #C0C4CE;
  --band-link: #CDB8F7;
  --tint: #1C1E24;
  --tint-soft: #1A1C22;
  --code-bg: #121318;
  --code-text: #E2E0D8;
  --input-bg: #1A1C22;
  --input-border: #3A3E49;
  --focus-ring: rgba(187, 160, 242, 0.55);
  --focus-soft: rgba(187, 160, 242, 0.22);
  --pulse: rgba(187, 160, 242, 0.38);
  --wait-bg: rgba(233, 200, 110, 0.13);
  --wait-text: #E9C86E;
  --ok-bg: rgba(67, 172, 119, 0.14);
  --bad-bg: rgba(244, 147, 133, 0.14);
  --done-border: #2E5A45;
  --done-bg: rgba(67, 172, 119, 0.10);
  --err-bg: rgba(244, 147, 133, 0.12);
  --err-border: rgba(244, 147, 133, 0.40);
  --err-text: #F5AFA4;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 10px 28px rgba(0, 0, 0, 0.45);
}
```

---

## Shared accessibility notes (all directions)

- **Dark surfaces are tuned near-neutrals**, never `#000` / `#FFF`: papers sit at ~#0B–#17 lightness with a hue cast matching the direction; cards are one visible step lighter.
- **Semantic trio stays distinguishable for red-green colorblindness**: every direction pairs the green/red hue difference with a measured luminance gap (1.21–1.63:1 stated per direction), and dark-mode `--bad` is pushed toward orange-coral (deuteranopia-friendlier than pure red). `--wait` uses blue (A) or amber (B, C) — never confusable with ok/bad. Status text labels remain the primary channel; color is reinforcement.
- **Focus rings** derive from each accent at ≥ 0.45 alpha over their own paper — visible in both modes.
- **Print**: the existing `@media screen` scoping of the dark block is preserved; print always gets the light palette.

---

## Transition fix — smooth theme switching

Three requirements: (1) ~220 ms ease on themed properties, (2) **no** transition on initial page load (otherwise the pre-paint theme bootstrap causes a visible fade-in from the default palette on every load), (3) instant swap under `prefers-reduced-motion`.

### CSS (paste at the end of the `<style>` block)

```css
/* Theme-change transition.
   Scoped to .theme-ready, which is added only AFTER first paint,
   so the initial load renders instantly with no fade. */
html.theme-ready body,
html.theme-ready body * ,
html.theme-ready body *::before,
html.theme-ready body *::after {
  transition:
    background-color 220ms ease,
    color 220ms ease,
    border-color 220ms ease,
    box-shadow 220ms ease,
    fill 220ms ease,
    stroke 220ms ease;
}

/* Accessibility: instant swap for users who opt out of motion. */
@media (prefers-reduced-motion: reduce) {
  html.theme-ready body,
  html.theme-ready body *,
  html.theme-ready body *::before,
  html.theme-ready body *::after {
    transition: none !important;
  }
}
```

Notes:
- The selector list intentionally targets `body` and descendants (not `html *`) so the transition composes cleanly with the bootstrap script that sets `data-theme` on `<html>` before paint.
- The `transition` property list is explicit (`background-color`, `color`, `border-color`, `box-shadow`, `fill`, `stroke`) — **not** `all` — so it cannot hijack layout properties or existing keyframe animations (`--pulse` spinners are `animation`-based and unaffected).
- If any element already declares its own `transition` for hover states, its own (more specific or later) declaration wins; audit hover transitions after applying and, if one is overridden, append the theme properties to that element's own transition list instead.

### JS (one-line addition to the existing theme bootstrap IIFE in `<head>`)

Add as the last line inside the existing bootstrap function, after `document.documentElement.dataset.theme = t;`:

```js
requestAnimationFrame(function () { requestAnimationFrame(function () { document.documentElement.classList.add("theme-ready"); }); });
```

The double `requestAnimationFrame` guarantees the class lands **after** the first frame is painted, so the initial theme renders with zero transition; every subsequent toggle of `data-theme` (the existing toggle handler needs no changes) animates smoothly at 220 ms.

---

## Recommendation

**A (Clinical Slate)** is the safest enterprise pick and the hardest break from the "AI default" look. **B (Deep Teal Terminal)** is the most memorable for hackathon judging if the demo leans on the live-agent/console moments. **C (Editorial Refined)** is the lowest-risk change if stakeholders liked the report-like feel and only the colors felt off.

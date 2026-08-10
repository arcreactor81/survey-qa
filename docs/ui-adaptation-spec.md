# UI Adaptation Spec — carrying the existing Survey QA site onto the LLM-led v2 system

**Status:** Tier-1 build spec. Consumed by the two v2 UI build agents.
**Owner instruction this answers:** *"review the website of survey qa to understand what we aspire for directionally, and then we need to adapt it for the new system."*
**Method:** the deployed site is behind Cloudflare Access, so this was written by reading the source in this repo, not by browsing the live site.

**Sources read (read-only; nothing under `src/**` was modified):**

| Source | What it gave |
|---|---|
| `public/index.html` (72 KB, markup + inline run/status JS) | landing hero, two-mode run form, inline status card, full-screen "mission control" overlay, verbose stage tracker, bug game |
| `public/styles.css` (35 KB) | mirrored design system + landing-only components |
| `src/theme-css.ts` (16 KB) | **the single source of truth for design tokens** — `THEME_CSS` |
| `src/processing.ts` (44 KB) | waiting page, stage lighting, honest live banner, heartbeat age-stamping, poll/give-up logic, error page |
| `src/report.ts` (46 KB) | current report builder (consensus/scorecard model) |
| `src/index.ts` | routing, slim status endpoint, heartbeat surfacing |
| `pipeline/report/{report.css,lib/render-html.mjs,lib/view-model.mjs}` | the **already-built v2 audit renderer** used for the t1-easy run |
| `spec/theme-directions.md` | the computed WCAG AA verification behind the palette |
| `README.md` | how the product currently presents itself |
| `docs/structured-claim-contract-merged.md` §0–§7 · `docs/ui-report-redesign.md` · `pipeline/runs/t1-easy/DEBRIEF.md` · `docs/p0-adversarial-audit.md` §1–§3, §8 | the converged design this UI must serve |

**Non-goals.** No deploys, no commits. No change to `src/**`, `scorer/**`, `test-suite/**`. This spec describes what the *new* UI (worker-v2 / a new public shell) must be; the legacy production Worker stays untouched and live.

**One structural finding up front, because it changes the build plan.** There are **two** report renderers in this repo, and they are not the same product:

- `src/report.ts` — the deployed consensus report. N-of-3 model agreement, seeded-error scorecard, per-model cost. This is the one the *marketing surface* still describes and the one that must be **retired**.
- `pipeline/report/lib/render-html.mjs` — the v2 audit report already written for the t1-easy run. Two-axis coverage/verdict, sealed-contract denominator, fail-closed attestation banner, ambiguity and not-verifiable sections. Its own header comment already encodes the honesty rules:

  ```
  *   - `exercised` is NEUTRAL (surface tint), never success green.
  *   - every status carries a text label + a glyph; colour is decoration only.
  *   - `.integrity-suspect` (invalid attestation) strips success styling globally.
  *   - wide tables scroll inside `.scroll-x`; the page itself never scrolls sideways.
  ```

  **This is the v2 report's skeleton and it is right.** It is *not* on the shared design system: `pipeline/report/report.css` re-declares a reduced, font-stack-only fork of the tokens (`--accent: #574589` vs `THEME_CSS`'s `#6E5AA8`, `--ink: #2F352F` vs `#3E453F`, no `@font-face`, no dark block visible in the head region, no `--dur-*`/`--ease-*`). **The adaptation is: keep that renderer's structure and honesty semantics, and re-token it onto `THEME_CSS`.** Do not rebuild the audit report from scratch, and do not extend `src/report.ts`.

---

## 1. What the current site does well — preserve these

These are the properties that make this product feel like a measurement instrument rather than a demo. Each is quoted from the implementation so a new page can be checked against it.

### 1.1 Honest artifact-derived progress: no fake timers, no projected ETAs

The waiting page's module docstring states the rule as a design constraint, not a nicety (`src/processing.ts:11-17`):

> the status API reports a coarse status plus an honest stage field (0 parse, 1 walk, 2 compare) **inferred from real R2 artifacts** … So the pipeline is shown as genuinely running server-side — **no guessed per-stage clock** — with a REAL elapsed timer adopted from the run's own `startedAt`.

The elapsed clock is *adopted from the server*, not started at page load, so a refresh does not reset it (`src/processing.ts:507-515`):

```js
function adoptStartedAt(iso) {
  if (startedAtLocked || typeof iso !== "string") return;
  var t = Date.parse(iso);
  if (!isNaN(t) && t <= Date.now()) { startedAt = t; startedAtLocked = true; tick(); }
}
```

The live banner is explicitly forbidden from inventing an ETA (`src/processing.ts:626-631`):

> TRUE measured progress from the run's heartbeat ("deepseek: page 3/6") as the hero line … and a calm taking-longer advisory past 10 minutes. **Never a projected ETA — that would be a guess.**

**Preserve:** server-adopted elapsed baseline; every displayed fact traceable to a durable server artifact; the ban on projected completion.

### 1.2 Age-stamping instead of stale-data-as-truth

A heartbeat note older than three minutes is labelled with its age rather than presented as current (`src/processing.ts:645-661`):

```js
var noteAgeMs = data.progress && data.progress.at ? (Date.now() - Date.parse(data.progress.at)) : 0;
…
if (isFinite(noteAgeMs) && noteAgeMs >= 180000) {
  heroText += " (last update " + Math.round(noteAgeMs / 60000) + " min ago)";
}
```

And the reasoning is recorded in-line — *"an old note … is age-stamped past 3 minutes instead of masquerading as current"*. **Preserve the rule and the threshold.**

### 1.3 Recovery is surfaced, and recovery data never masquerades as live data

`recoveryMode` (`restarting` / `recreating`) renders its own sub-line, and the code documents why recovery must not silently overwrite the hero line (`src/processing.ts:644-671`):

> Recovery outranks the note: while the sweeper is rescuing the run, any note on file was written by the DEAD instance — presenting it as the live hero would be **stale data styled as measured truth**.

**Preserve:** an explicit recovery sub-line; the rule that a rescued run's pre-rescue telemetry is either superseded or age-stamped, never presented as current.

### 1.4 Honest degraded states — "status unavailable" is not "failed"

Three distinct terminal UI states, each with its own copy (`src/processing.ts:570-607`, `src/index.ts:522-532`):

- **Run not found** (HTTP 404 on poll) — *"The server no longer has run X — it may have finished long ago and expired, or been evicted. This page has stopped checking."*
- **Run status unavailable** (bounded fail streak, `MAX_POLL_FAILS = 24`, ~2 min at 5 s cadence) — *"Survey QA stopped responding for run X across N checks, so this page gave up."*
- **Failed run** — a themed `errorPage()` with `role="alert"`, not a bare stack trace.

Polling is bounded rather than infinite, and giving up **freezes** the elapsed clock (`stopWaiting()` clears both timers) rather than letting it keep counting against a run nobody is watching. **Preserve all three states as distinct, and preserve the freeze-on-giveup.**

### 1.5 The two-mode run form

`role="tablist"` with two honest panels (`public/index.html:99-108`): *"🧪 Try the demo — Bundled survey · 10 seeded errors · ready to run"* and *"🚀 QA your own survey — Your live URL + Word questionnaire"*. The custom panel takes exactly the two inputs the product actually needs: a survey URL and a `.docx`, with a keyboard-operable dropzone (`tabindex="0" role="button"`, hidden `<input type="file">`, `.is-drag` / `.has-file` states). **Preserve the two-mode structure, the tablist semantics, the dropzone, and the URL+docx pairing.**

### 1.6 Refresh-safe run permalinks and a "never blank" tracker

`/reports/{runId}` is a real URL that serves the waiting page while processing and the report once terminal (`src/index.ts:522-532`) — the run survives a refresh, a tab close, or a shared link. The landing tracker is built from real DOM text in every state, with a documented invariant (`public/index.html:414-418, 476`):

> Every row is real DOM text (marker glyph, name, model badge, description), so the tracker **can never render as an empty strip.**
> No live run (or failed): show the full queue, all pending — **never blank.**

**Preserve both:** the permalink, and "there is always a legible state; blank is never a state."

### 1.7 The neutral gray-green parchment theme with *computed* WCAG AA

The palette is not eyeballed. `spec/theme-directions.md:9` records the method:

> WCAG 2.x relative luminance / contrast-ratio formula, **computed programmatically for every text/background pair**… Translucent `rgba()` chip backgrounds were **composited over their card background** before measuring. Semantic ok/bad pairs additionally carry a **luminance gap** … so pass/fail states are distinguishable for red-green colorblind users without relying on hue alone; the UI already pairs status colors with text labels ("PASS"/"FAIL"), which remains the primary cue.

All chip pairs verified ≥ 4.5:1 in both modes. **Preserve the method, not just the numbers: any new token must be re-verified the same way, composited, with a stated luminance gap for semantic pairs.**

### 1.8 Reduced motion, treated as a first-class mode rather than an afterthought

Not a blanket `* { animation: none }`. Motion is *modally replaced*:

- Theme crossfade is opt-in after first paint (`html.theme-ready`) and hard-disabled under reduce, with `!important` (`src/theme-css.ts:441-447`).
- The dark palette is scoped to `@media screen` so **print always renders on paper** (`src/theme-css.ts:146`).
- The bug game commits its mode **per bug at spawn** rather than reacting to a media query mid-animation (`src/processing.ts:328-331`): `.is-scurry` crawls for motion users, `.is-still` is a reduced-motion whack-a-mole; *"All is-still animation is opacity-only and lives on the child glyph; the button never fades so its keyboard-focus outline stays visible."* Keyboard focus pauses the dwell so a target cannot fade out from under a keyboard user.

**Preserve:** reduced-motion as an alternate design, JS as the single authority on motion mode, focus never hidden by an animation, print always light.

### 1.9 The bug game as an *opt-in, clearly-labelled* motion feature

The squash chip states its own irrelevance (`src/processing.ts:474-475`): *"(just for fun — actual run status is shown above)"*, and a `motion-toggle` with `aria-pressed` lets a user turn crawling on/off independently of the OS setting. **Preserve** — including the disclaimer, and including the rule from `ui-report-redesign.md` §3.3 that it *"never advances based on presumed backend progress."*

### 1.10 Small craft details worth naming so they are not lost

- **Theme bootstrap before first paint** — inline script sets `data-theme` from `localStorage` → `prefers-color-scheme`, wrapped in `try/catch` for storage-denied contexts; identical in all three page builders. No flash of wrong theme.
- **Self-hosted fonts** at `/fonts/*.woff2` with a strong fallback stack, `font-display: swap`, preloaded — *"so a saved/offline report still reads."*
- **XSS discipline in dynamic UI** — `giveUp()` builds structure with `innerHTML` but injects every dynamic string via `textContent`: *"no HTML injection, no escaping to get wrong"* (`src/processing.ts:585`).
- **Monotonic progress** — `maxStage = Math.max(maxStage, data.stage)` so *"a reordered/slow poll can't regress the lights."*
- **Live regions that don't spam** — `setTextIfChanged()` so `aria-live` re-announces only on real change; visibility-aware polling (5 s visible / 30 s hidden, immediate poll on return, no overlapping requests).
- **Tabular numerals** (`.num { font-variant-numeric: tabular-nums }`) everywhere a number can change.
- **Slim status endpoint** — `/api/runs/:id/status` exists precisely because *"the full envelope … can be 100s of KB … and was being shipped every 5 seconds."*

---

## 2. The design language

Authoritative token source is `src/theme-css.ts` (`THEME_CSS`), mirrored byte-for-byte into `public/styles.css` above the `END SHARED DESIGN SYSTEM` marker. **v2 keeps this contract**: one exported string, mirrored into the static stylesheet, inlined by every server-rendered page. `pipeline/report/report.css` must be re-pointed at these values.

Identity, per the module header: *"warm paper (light) / near-black (dark) canvas · muted lavender primary · sage kicker · dusty-sky + dusty-rose accents · Instrument Serif display (italic `<em>` accents), DM Sans body, JetBrains Mono technical labels."* **Identity through hue, not saturation.**

### 2.1 Colour tokens

Surfaces and ink:

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#ECEFEA` | `#181A18` | page canvas |
| `--card` | `#EFF1ED` | `#20231F` | panels, cards, sections |
| `--surface-2` | `#E8ECE6` | `#252925` | secondary fill (toggle, chips) |
| `--surface-3` | `#E2E7E1` | `#2B302B` | tertiary fill (pills) |
| `--ink` | `#3E453F` | `#D9DDD6` | headings, primary numerals |
| `--text` | `#454C46` | `#C9CEC6` | body |
| `--slate` / `--muted` | `#5D655D` | `#A4AAA2` | secondary text |
| `--text-faint` | `#616961` | `#989F97` | footer, timestamps |
| `--border` | `#B4BBB3` | `#3A403A` | hairlines |
| `--border-strong` | `#7D857D` | `#4A514A` | inputs, ghost buttons |

Accents:

| Token | Light | Dark | Use |
|---|---|---|---|
| `--accent` | `#6E5AA8` | `#BBA8E0` | links, `<em>` in display type, active state |
| `--accent-solid` | `#5B4A8F` | `#A597C2` | filled controls |
| `--accent-ink` / `--btn-text` | `#FFFFFF` | `#1C1A26` | ink on filled controls |
| `--primary-soft` | `#ECE7F6` | `rgba(187,168,224,.12)` | soft accent wash |
| `--kicker` | `#4F6B48` (sage) | `#A8C4A0` | kicker eyebrows |
| `--link-hot` | `#9E5839` | `#E8A889` | rare warm link |
| `--focus-ring` | `rgba(110,90,168,.38)` | `rgba(187,168,224,.45)` | focus glow |

Semantic pairs (**always used with a text label + glyph, never alone**):

| Role | Fg light / dark | Bg light / dark |
|---|---|---|
| ok | `--ok` `#4A6B41` / `#8FB183`; text `--green-text` `#3C5A34` / `#C2D6BB` | `--ok-bg` `#DCEBD4` / `rgba(168,196,160,.15)` |
| bad | `--bad` `#A14F4B` / `#D49A9A`; text `--red-text` `#8C4040` / `#E6C0C0` | `--bad-bg` `#F5E4E4` / `rgba(212,154,154,.16)` |
| wait / amber | `--amber-text`/`--wait-text` `#6D5621` / `#E2CF9A` | `--wait-bg` `#F2EAD4` / `rgba(212,184,106,.14)` |
| info / note | `--note-text` `#38617C` / `#B6D3E6` | `--note-bg` `#E2ECF3` / `rgba(137,184,212,.12)` |
| neutral | `--slate` | `--chip-cat-bg` / `--badge-muted-bg` |

**New v2 tokens to add** (the existing set has no vocabulary for the four flag lanes or the neutral "exercised" state). Add to both blocks, verify with the §1.7 method, and state the luminance gaps:

```
--neutral-strong-bg / --neutral-strong-border   /* `exercised` — NEUTRAL, must not read as ok */
--lane-gap-bg  / --lane-gap-text                /* lane 1: document-backed contract gap  (info family) */
--lane-tax-bg  / --lane-tax-text                /* lane 2: taxonomy gap                  (neutral family) */
--lane-amb-bg  / --lane-amb-text                /* lane 3: ambiguity                     (amber family) */
--lane-anom-bg / --lane-anom-text               /* lane 4: unsupported site anomaly      (slate/dashed) */
--nbo-bg / --nbo-text                           /* NOT_BROWSER_OBSERVABLE                */
--silent-bg / --silent-text                     /* document-silent                       */
--negative-bg / --negative-text                 /* explicit-negative                     */
--phase-pending / --phase-active / --phase-complete / --phase-skipped / --phase-stopped
```

Constraint: `--lane-*` hues must be distinguishable from `ok`/`bad` **and** from each other at ≥ 3:1 non-text contrast, and each lane also carries a distinct glyph and a full-word label. No lane may borrow success green.

Elevation: `--shadow-sm`, `--shadow`, `--shadow-lg` (light shadows are `rgba(32,30,27,.04–.08)`; dark are `rgba(0,0,0,.22–.30)`). `--glow-color` drives the single static masthead glow.

### 2.2 Type scale

Families: `--serif` Instrument Serif (display only) · `--sans` DM Sans (body/UI) · `--mono` JetBrains Mono (labels, IDs, hashes, numbers).

| Role | Family | Size / weight | Notes |
|---|---|---|---|
| Brand (landing) | serif 400 | 44px / 1.05, `-0.01em` | `<em>` in `--accent` |
| Brand (report/processing) | serif 400 | 34px | same mark |
| `h2` section title | serif 400 | 27px / 1.15 | never bold; `em` accents allowed |
| `h3` | serif 400 | 19px | |
| Big numeral (`.kpi-value`, tiles) | serif 400 | 38px / 1.02, tabular | the "instrument readout" |
| Body | sans 400 | **14px** / 1.55 | page base |
| Table cell | sans | 13px | |
| Hint / meta | sans | 12–12.5px, `--muted` | |
| `.small` | sans | 11px | |
| `.kicker` eyebrow | mono 400 | 11.5px, uppercase, `0.11em`, `--kicker` | one per section |
| `thead th` | mono 400 | 11px, uppercase, `0.08em`, `--slate` | |
| `.chip` | mono 400 | 10.5px, uppercase, `0.06em` | pill radius |
| `.badge` | mono 400 | 10.5px, `0.02em` | 6px radius |
| Tagline | mono | 11.5px, uppercase, `0.10em` | |
| Code / quote block | mono | 11.5–12.5px / 1.5, `pre-wrap`, `word-break: break-word` | |

Rules: display serif is **never bold** (400 only, tracking `-0.01em`). Mono carries *machine* facts — IDs, hashes, versions, enum values, counts. Sans carries *human* prose. A status enum rendered in sans is a bug.

### 2.3 Spacing, radius, layout

- `--radius: 14px` (cards/sections) · `--radius-sm: 8px` (inputs, banners, quote blocks, chips-with-corners) · `--radius-pill: 999px`.
- `.wrap { max-width: 1140px; padding: 0 28px }` for landing and report; **920px** for the single-column progress page.
- Section/card padding: `26px 30px 28px` (report sections), `24px 28px 26px` (progress cards). Vertical rhythm between blocks: 24–26px.
- Grid gaps: 16px (KPI/tile rows, stage rows), 18–26px (form grids).
- KPI row: `repeat(auto-fit, minmax(158px, 1fr))`.
- Breakpoints in use: `960px` (5-up → 3-up steps), `720px` (pipeline row → column), `680px` (form grid → 1 col; mode tabs → 1 col), `620px` (two-column provenance → stacked), `540px` (steps → 1 col). **Keep these; do not invent a new scale.**
- Masthead band: `padding: 46px 0 34px`, 1px bottom hairline, sits on `--band-bg` (= paper).

### 2.4 Component patterns (the existing vocabulary a new page must reuse)

**Card / section** — `background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow)`. Header pattern is always: `.kicker` eyebrow → `h2` → optional `.sub` inline qualifier → optional right-aligned status chip (`.badge-est`).

**KPI tile** (`statCard` / `tile`) — mono uppercase label, 38px serif tabular value, 11.5px `--muted` sub-line. In v2 the sub-line is **mandatory** and must name the denominator ("of 148 contract requirements"), never a bare number.

**Banner** — full-width, `role="status"` or `role="alert"`, flag word + headline + facts list. Existing variants: `.notice` (green info), `.live-progress` (accent left-rule 3px + dot), `.err-card` (4px `--bad` left rule). v2 adds `banner--fail` (fail-closed attestation), `banner--warn` (integrity warnings), `banner--partial` (budget/time). All already exist in `pipeline/report/lib/render-html.mjs`; re-token them.

**Chip vs badge vs pill** — `.chip` = pill-radius mono uppercase category/severity. `.badge` = 6px-radius mono status with a leading glyph `<span class="glyph" aria-hidden="true">`. `.pill` = sans 600, bordered, for counts. **v2 rule: coverage status and verdict status use `.badge` with glyph + full word; severity uses `.chip`. They must be visually distinct classes so the eye cannot merge two axes into one token.**

**Left-rule emphasis** — `border-left: 3–4px solid <semantic>` on a card is the established way to signal state without flooding a surface with colour (`.issue.conf-high`, `.err-card`, `.live-progress`). v2 reuses this for row-group state.

**Table** — `width:100%; border-collapse: collapse; font-size:13px`; `th,td { padding: 8px 12px; border-bottom: 1px solid var(--table-border); vertical-align: top }`; mono uppercase `thead`; `tbody tr:hover { background: var(--row-hover) }`; wrapped in `.table-scroll { overflow-x: auto }` (v2 renderer calls it `.scroll-x`). **Pick one name — `.scroll-x` — and use it everywhere.** The page body must never scroll sideways.

**Definition grid** — `dl` with `grid-template-columns: 150px 1fr`, mono uppercase `dt`, `word-break: break-all` `dd`. This is the identity/trust header pattern; keep it for run identity, hashes, versions.

**Disclosure** — `<details>`/`<summary>` with an accent summary and a rotating `▸/▾` marker. Used for the evidence appendix and per-model detail; v2 uses it for evidence drill-down and row expansion. **Constraint: a collapsed disclosure must show its counts and any unresolved state in the summary** (contract §0 review ergonomics — *"collapsing may never hide incompleteness"*).

**Empty state** — `emptyState(title, body)` renders a bordered block with a bold title and an explanatory sentence. **v2 makes this mandatory**: a section with nothing in it says why, and never renders as whitespace.

**Buttons** — `.btn` filled accent, 8px radius, sans 600 14px, `11px 22px`; `.btn-ghost` transparent with `--border-strong`. Disabled = `opacity .5; cursor: wait`.

**Focus** — global `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px }` on links, buttons, inputs, selects, summaries and `[tabindex]`. Never remove it; never let an animation obscure it.

### 2.5 Motion tokens

`--dur-fast: .16s` · `--dur: .32s` · `--dur-slow: .5s` · `--ease-spring: cubic-bezier(.3,.7,.4,1)` · `--ease-out: cubic-bezier(.16,1,.3,1)` · `--ease-in-out: cubic-bezier(.65,0,.35,1)`. Theme crossfade is a fixed 220 ms ease, enabled only after `html.theme-ready`.

**v2 motion budget — hard limits.** Motion is permitted for: hover/press feedback (`--dur-fast`), disclosure open/close, theme crossfade, the opt-in bug game, and **one** liveness indicator (a single pulsing dot in the "live" badge). Motion is **forbidden** on: any number, any count, any coverage bar, any phase chip transition, and any progress element. Numbers change by replacement at snapshot boundaries only. Rationale is already in `ui-report-redesign.md` §3.2 — *"it may not animate usage, coverage, attempt counts, or phase state between snapshots."* An animated counter is a fake-progress affordance wearing a costume.

### 2.6 Accessibility commitments (carried forward as acceptance criteria)

1. WCAG AA (≥ 4.5:1 text, ≥ 3:1 non-text) computed programmatically for every pair in both modes, translucent backgrounds composited before measuring.
2. Semantic pairs carry a stated luminance gap and are **always** accompanied by a text label and a glyph.
3. `:focus-visible` on every interactive element; focus never hidden by motion or overlay.
4. `prefers-reduced-motion: reduce` gets an alternate design, not a stripped one; JS commits motion mode at spawn.
5. Live regions use `aria-live="polite"` + `aria-atomic` and update only on real change.
6. Screen-reader state text accompanies every glyph-only marker (existing `<span class="sr-only"> — done</span>` pattern).
7. Full keyboard operability including the dropzone (`tabindex="0" role="button"`) and the full-screen overlay (background `inert` + `aria-hidden` fallback, `role="dialog" aria-modal="true"`).
8. Dark palette scoped to `@media screen`; print forces the light palette and drops decorative chrome.
9. DOM excerpts render as **inert escaped text**, never executable HTML.
10. `lang`, `<meta name="color-scheme">`, and `noindex` on run pages.

---

## 3. What must be retired

Each item: what it is, where it lives, and why it dies.

### 3.1 Stage 0/1/2 lighting and the walk / legs / report vocabulary

**Where:** `STAGES[]` in `src/processing.ts:149-157`; `lightStages()` `:613-624`; `TRACK`/`trackRowHtml()`/`trackerHtml()` in `public/index.html:426-482`; `computeStage()` in `src/index.ts`.

**Why:** the model is a fixed linear sequence of seven named steps whose completion is inferred from *which R2 file exists*. v2 has six phases that overlap, can be skipped, and can be revisited (`ui-report-redesign.md` §3.1). More importantly, `lightStages()` derives states 2–4 from a single scalar (`stage >= 2` lights DeepSeek, Grok **and** Claude simultaneously) — the frontend inventing three states from one number is exactly what §3.1 forbids: *"The frontend never infers phase completion from enum order."*

**Also retire the words.** "Walk", "legs", "compare" and "stages" appear across the landing hero, the how-it-works steps, the trivia list, `README.md`, and the report footer. v2 vocabulary: **requirement · facet · floor case · exploration · observation · claim · phase · coverage · verdict**.

### 3.2 The three independent execution-leg cards

**Where:** the DeepSeek / Grok / Claude entries in `STAGES` and `TRACK`; the `CLAUDE_STEP` "waiting for you" row; the `awaiting-claude` state machine; `pendingNotice` and the `node runner/claude-runner.mjs …` command block in `src/report.ts:757-763`; the agreement strip (`.agree-row`) in `overviewSection()`.

**Why:** v2 has no per-model legs on the primary axis. Model identity belongs in provenance (`resources.modelCalls`, panelist attribution in a `VerificationRecord`) and in the cost breakdown — not in the run's structural narrative. A user watching a run should see *what work was recorded*, not *which vendor is talking*.

**Carry forward one thing:** the "waiting for you" (`trk-mark-you ▶`) affordance is a genuinely good pattern for "the system is blocked on a human". v2 reuses it for **human extraction review** if the owner selects mandatory review (see §7 Q1) — not for a model runner.

### 3.3 N-of-3 consensus as the report's organizing model

**Where:** `buildIssues()`, `consensusRow()`, `deriveConfidence(consensus, verifiedModels)`, `.mchip.flagged/.unflagged`, and the KPI cards *"High confidence — ≥2 models, each verbatim-verified"* and *"Multi-model consensus — flagged by ≥ 2 of N models"* (`src/report.ts:223-311, 320-400, 564-607`).

**Why:** it fails on the merged contract at the semantic layer. §1 of `structured-claim-contract-merged.md`: *"Human prose, severity, confidence, rationale, suspected cause: ZERO matching weight"* and *"NO lexical fallback, similarity score, threshold, margin … anywhere in defect credit."* `deriveConfidence()` is precisely a vote-count-plus-quote-overlap heuristic. `quoteSig()`/`normFrag()` merge issues by normalised quote fragments — the lexical matcher the audit's Theme 1 identifies as *"inverted, not merely miscalibrated."* And the DEBRIEF's decisive failure was a *single* verdict-writer fabricating a summary; more voters on a broken axis would not have caught it.

**What replaces it:** a verdict derived by the scorer from an **attested typed observation**, with panel votes and preserved dissent shown as verification detail *under* the item, never as the item's headline. Agreement is evidence about the verification, not the verdict.

### 3.4 The seeded-error scorecard as a customer-facing headline

**Where:** `scorecardSection()` (`src/report.ts:409-486`) rendering *"Seeded-error scorecard — how each model did against N known planted errors"*; the README badges `seeded_benchmark 10/10`, `held-out 239/240`; the trivia lines about 240 planted errors; landing step 5 *"A findings report with a seeded-error scorecard: recall per model, false positives, cost and latency."*

**Why:** on a real customer survey there are no seeded errors, so the section is either absent (a hole where a headline was) or reused to mean something it does not mean. `ui-report-redesign.md` §5 is explicit: the corpus scorecard survives only *"in a clearly labelled acceptance/demo appendix."* Also: *"Do not use cost per defect as a quality indicator. A clean survey can legitimately have zero defects"* (§2.3).

**Retire the framing too.** README's *"three independent LLMs … N/3 model agreement, a confidence score"* is the old product. Update the README when the new pages land, or the site and its own docs disagree.

### 3.5 The 3–4 minute expectation copy

**Where:** `runHint` (`public/index.html:163`) — *"A demo run takes ~3–4 minutes: the browser walk (~90 s), then three model comparisons and quote verification."*; `.pipe-note` (`src/processing.ts:452-458`) — *"A run usually takes a few minutes…"*; the >10 min advisory *"most runs finish in 3–10 minutes."*

**Why:** the t1-easy execution phase alone was *"roughly 20–25 minutes serial"* (DEBRIEF §7). A duration promise is an ETA in prose. Replace with the §4.2 copy from `ui-report-redesign.md`:

> This is a live, evidence-backed test, not the former 3–4 minute demo. It has no promised duration or ETA. Model and browser work incurs real API cost up to the displayed cap. The run stops when testing finishes or an enforced limit is reached; a stopped test may still produce a complete partial report. Progress shows recorded work only.

**Keep** the *shape* of the >10 min advisory (a calm "still running, recovery is watching, no refresh needed") but strip every number from it.

### 3.6 Smaller retirements

- **Trivia lines that assert retired facts** — the DeepSeek/Grok/Claude line, *"Two models agreeing beats one model shouting. Consensus over confidence."*, *"The more models flag the same issue, the higher its confidence"*, *"240 planted errors … 239 exact category"*, *"Most of the wait is the browser walk"*. Rewrite the list; it is user-visible copy asserting a design that no longer exists. **Keep** the domain-craft lines (routing errors, mojibake, straight-lining, sum-to-100, piping) — they are good and still true. **Keep** the two lists in sync (`src/processing.ts:81-83` documents that duplication; v2 should export one list from one module instead).
- **`.badge-est` labelled "live" next to an animated pulse** while the page may be showing a snapshot minutes old. v2: the chip carries the snapshot time (`Confirmed 14:07:18`), and pulses only while a poll is genuinely in flight and the last snapshot is fresh.
- **The pages "strip" with eagerly-loaded screenshots** (`pagesSection()`, `img.shot` with `object-fit: cover`). v2 loads evidence only on expansion, verifies bytes against the catalog hash server-side, and gives every screenshot a factual accessible label.
- **`"What we found"` as the report's first heading.** v2's first block is completion + trust, and the summary must state both outcomes in words before any count is shown.
- **Landing hero paragraph** — rewrite entirely; it currently sells consensus, three model families, and the seeded scorecard.

---

## 4. What must be added

Mapped to the converged designs, with the render decisions a builder needs.

### 4.1 The Requirement Register — the primary audit body

Source: `structured-claim-contract-merged.md` §0. Replaces the flat issues list as the report's centre of gravity. The table is a **projection of normalized records**, never an editable spreadsheet, and never the source of truth: *"The human-facing table is a projection of normalized records, never a mutable spreadsheet that scoring reads directly."*

**Hierarchy** (§0 review ergonomics — *"148 flat rows is not honestly reviewable"*):

1. Global / cross-cutting requirements, **pinned first**.
2. Sections and questions in document order.
3. Facet subrows (the atomic, score-bearing unit).
4. Mandatory floor-case expansions under each facet.
5. Separate sections, below the register: **ambiguous** · **disputed** · **not-browser-observable** · **proposed rows**.

**Row identity.** Render `requirementLineageId` as the stable, copyable, permalinkable ID, with `requirementVersionId` and `semanticFingerprint` in the row's provenance drawer. **Never** key a UI row on Q-number, position, quote, or DOM locator. Retired rows stay visible, marked retired. Newly discovered requirements show `not-in-contract` for older run columns.

**Two denominators, never summed.** Report *document requirements* and *mandatory execution cases* as two separately named numbers with two separate labels. A parent row's count and its children's counts may never be added into one total. Any single "coverage %" that spans both denominators is a bug.

**A run cell is not scalar.** The t1-easy run put 84 sessions under one column. Each cell carries: coverage status · verdict · `pathConsistency` (`consistent` | `mixed`) · case counts · a drill-down. A `mixed` cell renders a distinct treatment and lists the `divergenceSet`; the aggregate is **fail-if-any** and *"later passes never erase a fail."* Last-write-wins in a cell is a build failure.

**Explicit cell values — no blanks, no overloaded `N/A`.** Each of these is its own rendered state with its own label, glyph, and colour, per §0: `exercised` · `not-reached` · `proven-unreachable` · `blocked` · `budget-exhausted` · `time-exhausted` · `pending` · `document-silent` · `explicit-negative` · `NOT_BROWSER_OBSERVABLE`. `NOT_BROWSER_OBSERVABLE` must render its **reviewed reason** and, where applicable, its alternative test surface — §0(c) warns it *"must not become an escape hatch for blocked execution."*

**Withheld from pass/fail.** Ambiguous and disputed rows are visible but excluded from pass/fail aggregates, and the aggregate must say so in words: *"3 rows withheld (unresolved ambiguity) — not counted as pass or fail."*

**Run columns.** Current run + one baseline by default; older runs behind a column picker. Every column header exposes document/contract version, target build, device/locale/config, and result-policy version. **Mixed-build runs are INVALID** — render a fail-closed banner, not a merged column.

**Risk queue.** A separate ordered view: blast-radius × control-flow impact × uncertainty. A view, not a second denominator.

**Reverse source-coverage ledger.** From the source-first ledger: every paragraph, table cell (with inherited headers), footnote and cross-reference classified normative / mapped-context / non-normative / ambiguous / unresolved, with unmapped normative blocks called out. This is how a reader sees a row that was *never proposed* — *"a reviewer cannot see a row that was never proposed."*

### 4.2 Phase chips + live coverage ledger (replacing stage lighting)

Source: `ui-report-redesign.md` §3.

Six chips — `Extracting · Planning · Executing · Verifying · Adjudicating · Reporting` — each with a **server-authored** state from `pending` | `active` | `complete` | `skipped` | `stopped`. Chips are activity states, not equal percentages, and carry no implied ordering bar. `Executing: stopped` alongside `Reporting: complete` is a valid, renderable combination.

Once the contract is sealed, the factual headline is:

> **17 of 24 obligations exercised**
> Contract denominator · Confirmed 14:07:18

Below it, **all seven coverage buckets**, and they must sum to the sealed total. Before sealing: *"Building coverage contract — obligation total not established."* — and **never `0 of 0`**.

Current-work block shows durable facts only: active attempt + path label, stable IDs, committed attempt count, attested cost vs cap, protected verification/report reserves, model/tool calls vs caps, wall clock vs cap, snapshot revision + observed timestamp. **Each limit keeps its own name and denominator; never average them into "budget used".**

Heartbeat gains a distinction the current page does not make: **last heartbeat** (the process checked in) vs **last durable progress** (a committed artifact). *"A heartbeat is not itself progress."* Keep the 3-minute treatment and the recovery sub-line verbatim; add snapshot-revision rejection so a late response cannot move progress backwards.

Transport: poll `/api/runs/:id/status` (slim), fetch `/api/runs/:id/coverage` only when `progressRevision` changes. `ETag` / `If-None-Match` / `Cache-Control: no-store`.

### 4.3 The four flag lanes

Source: `structured-claim-contract-merged.md` §0 — *"'Flag other stuff' splits into FOUR LANES."* These are **top-level report sections**, each with its own heading, count, glyph, colour token, and explanation of what it does and does not affect:

| Lane | Meaning | Effect on scoring | UI treatment |
|---|---|---|---|
| **Document-backed contract gap** | source-verified requirement absent from the contract | **the only lane that can become a row**; neutral for precision but **BLOCKS final certification while pending** | info family; each entry shows source atoms, proposed row, adjudication state; a pending entry raises a page-level "certification blocked" notice |
| **Taxonomy gap** | the claim kind registry cannot express this | neutral, capped, blocks final score pending adjudication | neutral family; show the cap and how much is used |
| **Ambiguity** | ≥ 2 typed readings of the document | scored on its **own** track; site judgment withheld; never enters defect recall/coverage/verdict | amber family; show every reading, the source anchor, affected rows, panel disposition, preserved dissent, and whether it is unresolved |
| **Unsupported site anomaly** | an undocumented vendor oddity | **unscored observation**, permanently | slate/dashed; explicitly labelled "recorded, not scored" |

Each lane needs an empty state that names the lane and says "none recorded", and a cross-link from every affected register row.

### 4.4 Ambiguity and not-browser-observable as first-class sections

Ambiguity gets its own top-level section above the register (`ui-report-redesign.md` §2.5) — extraction quality gates every downstream coverage claim. This is the fix for the DEBRIEF's one penalized false positive: `AMB-B2A-02` existed in the contract and the judging step failed the obligation anyway. **UI rule: a register row carrying an unresolved ambiguity may not render a `fail` verdict; it renders `withheld — unresolved ambiguity` with a link to the ambiguity entry.**

Not-browser-observable gets its own section (the t1-easy run declared **17** such mandates, deliberately outside the denominator). It must state: the requirement, the reviewed reason it is not browser-observable, the alternative test surface if one exists, and — loudly — that these are **not passes**.

### 4.5 Evidence drill-down

Source: `ui-report-redesign.md` §2.7. The expansion follows the evidence chain: requirement and expected observable → attempt ledger → browser evidence → deterministic verification → single-verifier result → independent panel votes → bounded reconciliation and final disposition.

Behaviour: metadata + hash render immediately, bytes do not; artifacts load on expand; the evidence service verifies stored bytes against the signed catalog hash before serving and **fails closed** on mismatch; screenshots carry a factual accessible label (item, attempt, capture step); DOM excerpts are inert escaped text; action traces are a keyboard-readable table; missing/restricted/redacted evidence keeps its catalog metadata and shows **why** it is unavailable; one artifact failing to load must not break the item or the report. Hidden chain-of-thought is never rendered.

**The DEBRIEF makes one addition non-negotiable.** The false passes cited `EXP-049` — an artifact proving the opposite. So: **every verdict renders its cited evidence IDs inline, as links, next to the verdict** — not buried behind a disclosure. If a mechanical re-check of a verdict against its cited artifact exists (fix-list item 1), render its result as a distinct badge (`re-checked against cited evidence` / `not re-checked`). A verdict with no cited evidence renders as `unsupported`, not as a pass.

### 4.6 Cost paired with coverage

Never cost alone, never cost-per-defect. Show: attested cost vs enforced cap · wall clock vs cap · model/tool calls vs caps · protected verification and report reserves · optional scorer-supplied weighted coverage and cost-per-verified-coverage-unit **only when the scorer supplies them with a named formula and version**. The browser must not compute either. The exploration economics from the DEBRIEF (~80 of 95 sessions for $0.00 marginal model spend) belong in a method note, not as a headline metric.

### 4.7 Attestation / trust header

Source: `ui-report-redesign.md` §2.2. Already implemented in `pipeline/report/lib/render-html.mjs:178-225` (`renderHeader`) — run ID, schema version, target URL/build ID/build hash, document hash, sealed contract hash, profile + configuration hash, timestamps, attestation badge, algorithm/canonicalization/scope, signing key ID, key registry, payload hash, signature, scorer/matcher versions. **Adapt, do not rebuild.** Add: `contractRevisionId` + hash (a run *"may not regenerate its own denominator"*), result-policy version, and normalizer/projection versions from §5.

Fail-closed banner, above every result:

> **Record integrity check failed. Results below are not authoritative.**

`.integrity-suspect` strips success styling globally — that behaviour already exists and must survive re-tokening. Two more UI-visible trust states from the DEBRIEF: a **test-key** signature must be labelled test-only in the header (*"It proves the record was not mutated after assembly. It proves nothing about provenance."*), and a **disclosed target modification** (the `window.history` shim) renders as a loud banner **above all results, because it conditions all results.**

---

## 5. Information architecture

### 5.1 Pages

| # | Page | Route | Purpose | Primary states |
|---|---|---|---|---|
| 1 | **Landing / submit** | `/` | Explain the product truthfully; take a run | idle · validating · submitting · error · run-created |
| 2 | **Run watch** | `/runs/{runId}` | Honest live ledger of recorded work | denominator-unavailable · active · stale-heartbeat · recovery · partial-budget · partial-time · failed · complete (auto-advance to 3) |
| 3 | **Audit report** | `/runs/{runId}/report` | The deliverable: trust header, completion, findings, lanes, Requirement Register | complete · report-complete/testing-partial · testing-complete/reporting-failed · attestation-invalid · fail-before-extraction |
| 3a | **Register row permalink** | `/runs/{runId}/report/rows/{lineageId}` | Deep link to one requirement, expanded (P2) | — |
| 4 | **Evidence viewer** | `/runs/{runId}/evidence/{evidenceId}` | Authorized, hash-verified artifact; served inline in 3 or standalone | ok · unavailable · restricted · redacted · hash-mismatch (fail-closed) |
| 5 | **Sample report** | `/samples/{name}` | A cached real report, labelled **Sample report** — never "Live demo" | static |
| 6 | **Method / trust** | `/method` | What the system does and does not prove | static |
| 7 | **Error / not-found** | any | Themed `errorPage()`, `role="alert"` | not-found · status-unavailable · failed |

Notes. Route the run under `/runs/…` rather than the legacy `/reports/…` so watch and report are siblings; `/reports/{runId}` must 301 to `/runs/{runId}` so existing permalinks survive. `/method` is new and it is load-bearing: `DEBRIEF.md` §9 (*"What this slice does NOT prove"*) and contract §7 (residual risk) are the most trust-building content this product has, and they currently live only in the repo.

### 5.2 The flow

```
        ┌──────────────────────────────────────────────────────────────────────┐
        │ 1 LANDING  /                                                          │
        │  hero (rewritten) · how it works (rewritten) · run form (2 modes)     │
        │  server-sourced run policy: profile · $ cap · wall cap · reserves     │
        │  deep mode (owner-gated) · authorization + cost acknowledgement       │
        │  primary action: "Start capped run — up to $5.00"                     │
        └───────────────┬──────────────────────────────────────────────────────┘
                        │ POST /api/runs → returns runId + ACCEPTED profile & limits
                        │ (subsequent pages use the RETURNED values, never the requested ones)
                        ▼
        ┌──────────────────────────────────────────────────────────────────────┐
        │ 2 WATCH  /runs/{id}          refresh-safe · shareable · bounded poll  │
        │  phase chips (server-authored) · sealed-contract headline             │
        │  all 7 coverage buckets (sum = total) · current attempt facts         │
        │  cost/calls/time each vs its OWN cap · reserves                       │
        │  heartbeat + last durable progress · recovery sub-line                │
        │  optional "Play while you wait" (motion opt-in)                       │
        └───────────────┬──────────────────────────────────────────────────────┘
                        │ completion.report === "complete" → advance
                        │ (partial-budget / partial-time also advance — a stopped test
                        │  can still produce a COMPLETE report)
                        ▼
        ┌──────────────────────────────────────────────────────────────────────┐
        │ 3 REPORT  /runs/{id}/report                                           │
        │  ① trust header + attestation (+ disclosed-modification banner)       │
        │  ② completion: report-complete AND testing-complete, in words         │
        │  ③ executive summary: named denominators, verdict counts, cost+cover  │
        │  ④ findings requiring action                                          │
        │  ⑤ FOUR FLAG LANES (gap · taxonomy · ambiguity · anomaly)             │
        │  ⑥ scope & extraction review (source-coverage ledger, sealed contract)│
        │  ⑦ ★ REQUIREMENT REGISTER — the audit body                            │
        │  ⑧ not-browser-observable                                             │
        │  ⑨ verification & evidence                                            │
        │  ⑩ cost, limits, provenance                                           │
        │  ⑪ appendix: corpus scorecard (clearly labelled, acceptance-only)     │
        └───────┬───────────────────────────────┬──────────────────────────────┘
                │ expand a row                   │ export
                ▼                                ▼
        ┌─────────────────────────┐   ┌──────────────────────────────────────┐
        │ 3a ROW DRILL-DOWN       │   │ EXPORT                                │
        │  requirement + expected │   │  print/PDF (light palette forced,     │
        │  attempt ledger         │   │    partial banners + full denominator  │
        │  browser evidence  ─────┼──▶│    preserved)                          │
        │  deterministic verif.   │   │  signed RunRecord JSON                 │
        │  verifier result        │   │  Register CSV (two denominators as     │
        │  panel votes + dissent  │   │    two files/sheets, never summed)     │
        │  reconciliation         │   │  authorized ScorecardRecord (optional) │
        │  provenance drawer      │   └──────────────────────────────────────┘
        │   (lineage/version/fp)  │
        └─────────┬───────────────┘
                  ▼
        ┌─────────────────────────────────────────┐
        │ 4 EVIDENCE  hash-verified, lazy,         │
        │   fails closed on mismatch               │
        └─────────────────────────────────────────┘
```

**Cross-links required in both directions:** finding ⇄ register row · register row ⇄ attempt · attempt ⇄ evidence · lane entry ⇄ affected rows · ambiguity ⇄ withheld rows · source-ledger block ⇄ the rows it produced (and a visible "produced no rows" for unmapped normative blocks).

**Navigation.** The report gets a sticky section nav (`renderNav()` already exists in the v2 renderer). The register needs an in-section filter/jump control that changes the **view only** — the canonical audit and export order is always contract order, per `ui-report-redesign.md` §2.1.

**Landing changes beyond copy.** Add the server-sourced run-policy block, the deep-mode control (owner-gated; hidden or non-actionable "Owner approval required" if unauthorized; changing it **re-fetches** the cap summary before submit), and the authorization + cost acknowledgement. Demo mode may only say "same pipeline" if it actually launches the new pipeline; otherwise it links to a **Sample report**.

---

## 6. Honesty rules — carry forward verbatim as implementation constraints

These are acceptance criteria. A build that violates one is not done.

1. **No fake progress.** No global completion percentage, no fake timer, no projected ETA, no inferred milestone. *"Progress is a ledger of observed work, not a loading animation."* Every displayed fact traces to a durable server artifact. The client may locally tick only heartbeat **age**; it may not animate usage, coverage, attempt counts, or phase state between snapshots.
2. **No blended percentages.** *"Do not average cost, call, and time percentages into a generic 'budget used' number. Each limit retains its own name and denominator."* The client computes named percentages from `used / max` and never combines limits.
3. **Coverage and verdict never collapse into one badge.** *"'Exercised' never means 'passed,' and 'not assessed' never means 'passed.'"* Two axes, two labels, two visual treatments, always. `exercised` uses **neutral** styling, never success green. Never one "success" badge that collapses report, testing, coverage, and verdict.
4. **'Not tested' never renders like 'pass'.** `not-reached`, `blocked`, `budget-exhausted`, `time-exhausted`, `pending`, `NOT_BROWSER_OBSERVABLE` and `not-assessed` each get their own explicit label and must be visually distinguishable from a pass at a glance and in greyscale. Untested items are **not passes** and the partial banner must say so in words.
5. **Blanks are never used where an explicit state exists.** *"`document-silent` / `explicit-negative` / `NOT_BROWSER_OBSERVABLE` / `blocked` / `not-reached` stay distinct explicit cell values (never blanks, and never `N/A` overloading them)."* Empty sections render an empty state that says why. The tracker is never blank. Never `0 of 0` — before sealing, say *"Building coverage contract — obligation total not established."*
6. **Colour is never the only signal.** Every status carries a text label **and** a glyph; colour is decoration. Semantic pairs carry a stated luminance gap. The page must be fully interpretable in greyscale and by a screen reader.
7. **Report completeness and test completeness are separate outcomes, both stated in words.** *"A complete report may honestly describe a partial test."* Both sentences appear before any count.
8. **Two denominators, always reported separately** — document requirements vs mandatory execution cases — *"never parent+children in one."*
9. **Exploration may only ADD findings, never change the denominator.** The floor's denominator is sealed; a run *"may not regenerate its own denominator"*; every run references one immutable `contractRevisionId` + hash.
10. **A run cell is not scalar.** `fail-if-any` aggregation; *"later passes never erase a fail"*; `pathConsistency: mixed` renders as mixed with its `divergenceSet`. No last-write-wins.
11. **Ambiguous and disputed rows are visible but withheld from pass/fail**, and the withholding is stated. A row with an unresolved ambiguity may not render `fail`.
12. **The rendered report is a view, not the authority.** Label it as generated from the signed source records. The browser must not invent weighted coverage, cost-per-unit, confidence, or any derived score.
13. **An agent-supplied finding is an assertion, not a verdict.** *"The UI must not silently relabel it 'confirmed' without a verification record or scorer result."* Verification disposition renders explicitly, including `not routed for panel review` — which is **distinct** from unanimous agreement.
14. **Fail closed.** Invalid attestation → warning above every result and success styling stripped globally. Invalid status/verdict combinations → a record-integrity warning, never normalized by the frontend. Evidence hash mismatch → refuse to render, do not show corrupted bytes. Mixed-build run columns → invalid, not merged.
15. **Recovery never resets counters**, and clients reject older snapshot revisions so a delayed response cannot make progress appear to move backward.
16. **Degraded states stay distinct.** "Live status unavailable" ≠ "artifact unavailable" ≠ "failed run" ≠ "run not found". Report-file existence is never treated as proof that testing completed.
17. **Hidden chain-of-thought is never rendered.** Only structured decisions and concise supplied reasons are report data. DOM excerpts render as inert escaped text.
18. **Truthful labels on demo surfaces.** Cached output is a **Sample report**, never a "Live demo". A test signing key is labelled test-only. A disclosed target modification is banner-level, above all results.
19. **Print and export preserve the warnings.** Partial-state banners, the full denominator, and the attestation state survive print/PDF/CSV. An export that drops the partial banner is a lie in a new file format.

---

## 7. Open questions the owner must answer before the UI is finalized

**Q1 — Human extraction review: every run, or audit-grade only?** (contract §0, the explicit NEW OPEN OWNER FORK). This is the largest IA fork in the spec. Mandatory-always adds a **page** (an extraction review queue), a **state** (`awaiting-review`, blocking the seal), and contradicts the *"hand over link + document, come back for the report"* mandate — it makes the product assisted rather than hands-off. GPT's recommendation: mandatory for P1, corpus/gold creation, and audit-grade mode; automated dual extraction for default live operation, pausing only on high-risk ambiguity or unresolved coverage gaps. **Needed:** the answer, and if review exists, whether the reviewer is the customer or the operator.

**Q2 — Oracle-gap disposition** (contract §7, the remaining owner fork): source-verified unmatched requirement = **(a)** neutral-but-blocking pending adjudication, or **(b)** strict oracle-gap-as-FP. This changes lane 1's rendering: under (a) the report shows a **"certification blocked — N gaps pending adjudication"** state that has no visual precedent in the current site; under (b) it is a penalty line in the scorecard.

**Q3 — Who is the report for?** A research-ops buyer wants "is my survey shippable"; an auditor wants the full register. Both are in scope but they want different first screens. Options: one report with a strong executive summary (current plan), or a two-view toggle (Summary / Full audit) with a shared canonical order. **This decides whether the register is above or below the fold.**

**Q4 — Cost display and who pays.** `ui-report-redesign.md` §4.2 says do not claim the user is billed unless true. Is the customer-visible cap real money to them, an operator budget, or a trust signal only? Does the actual dollar figure appear on a customer report at all?

**Q5 — Deep mode: who is authorized, and what does the profile actually change?** The UI renders server policy only. Needed: the named versioned profile, eligibility rule, and its actual path/retry/verification/cap differences — the UI must not describe it as exhaustive, guaranteed, or complete.

**Q6 — Evidence access and retention.** Who may see screenshots and DOM excerpts, for how long, with what redaction? Real customer surveys can contain PII in piped text. The UI assumes authorized, redacted, lazy access and never public raw R2 links — **confirm**, and specify the redaction marker so the UI can render "redacted" as a first-class state.

**Q7 — Run history depth.** Default is current + one baseline, older behind a picker. How many runs are retained, and is cross-run comparison a P1 feature or P2? This decides whether the register is built as a table-with-run-columns now or as single-run-with-a-slot-for-columns.

**Q8 — Does the bug game survive contact with a paying customer?** It is charming and it is honest, but the new run is minutes-to-tens-of-minutes of a capped, real-money test. Keep as-is / keep but hide by default behind "Play while you wait" / retire on the customer path and keep on the demo path?

**Q9 — What replaces the seeded-error scorecard as the landing page's proof?** The current site's credibility rests on `10/10` and `239/240` badges that the new system does not produce for customers. Candidates: the t1-easy DEBRIEF written up honestly (including the three false passes), the `/method` page, or a labelled acceptance appendix. **The landing page cannot ship with the old badges and the new pipeline.**

**Q10 — Legacy coexistence.** Does the v2 UI live at new routes on the same Worker, on `worker-v2` (currently a scaffold: `src/{api,store,types,workflow}`, mostly empty), or on a separate hostname? This determines whether `THEME_CSS` is imported, vendored, or published as a shared package — and whether `/reports/{id}` can 301.

---

## 8. Build handoff

**Split for two agents, by file boundary, so they do not collide:**

- **Agent A — shell + submit + watch.** New landing (`public-v2/index.html` + mirrored `styles.css`), the run-policy/consent block, the watch page (phase chips, coverage ledger, heartbeat/recovery), and the shared token module. Owns the `THEME_CSS` v2 fork and the new tokens in §2.1.
- **Agent B — report + register + evidence.** Adapts `pipeline/report/lib/{view-model,render-html}.mjs` + `report.css`: re-token onto `THEME_CSS`, add the Requirement Register with hierarchy and run columns, the four lanes, the not-browser-observable section, evidence drill-down, and export. **Does not** rewrite the renderer from scratch, and **does not** touch `src/report.ts`.

Shared contract between them: the token module (§2.1), the component vocabulary (§2.4), and the honesty rules (§6). Both consume `run-status/2.0.0` and `coverage-snapshot/1.0.0` from `ui-report-redesign.md` §7.3–7.4.

**Fixtures both must render before either is done** (from `ui-report-redesign.md` §6.1, plus three this spec adds):

denominator not yet established · normal active execution · stale heartbeat · recovery mode · `PARTIAL-BUDGET` · `PARTIAL-TIME` · report complete + testing partial · testing complete + reporting failed · failure before extraction · failure after some attempts · invalid attestation · keyboard / screen-reader / reduced-motion / greyscale interpretation · **(new)** a `mixed` pathConsistency cell with a divergence set · **(new)** a pending contract-gap blocking certification · **(new)** a disclosed target modification.

**Acceptance is not "the happy path renders."** Every fixture above must render correctly, and the greyscale + screen-reader pass is a gate, not a review comment.

**Verification, locally only:** `wrangler dev` and `wrangler deploy --dry-run`. Report the deploy steps; do not run them. The production Worker at `survey-qa.wellshit.co.in` is not touched.

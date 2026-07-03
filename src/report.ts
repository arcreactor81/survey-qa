// HTML report builder for survey-qa runs.
// Produces a self-contained HTML document (inline CSS; the only external
// resource is the Google Fonts stylesheet) from a RunReport. All user/model-
// derived strings are HTML-escaped via esc().
//
// Three model legs feed a report: DeepSeek (deepseek-v4-pro, via AI Gateway)
// and Workers AI (gpt-oss-120b, native binding) run automatically in-Worker;
// Claude Opus 4.8 runs via the user's local runner on their Claude
// subscription ($0), then POSTs findings back.
//
// Design language: editorial-technical consulting deliverable (Deep Teal Terminal).
//   ink #0F2422 · cool paper #F1F6F5 · white cards · accent #096658
//   success #156B3F · fail #A63220 · slate #435659 · borders #D8E2E0
//   Space Grotesk (display, Segoe UI fallback) for headings, system-ui for body.

import type {
  Finding,
  ModelName,
  ModelRunStats,
  PageCapture,
  RunReport,
  ScorecardEntry,
} from "./types";

/** Escape a value for safe interpolation into HTML text or attributes. */
function esc(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MODEL_LABEL: Record<ModelName, string> = {
  deepseek: "DeepSeek",
  claude: "Claude",
  workersai: "Workers AI",
};

const CANONICAL_MODELS: ModelName[] = ["deepseek", "claude", "workersai"];

const SEVERITY_RANK: Record<Finding["severity"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function fmtInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "–";
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Cost as display text. Claude at $0 means subscription-billed. */
function fmtCost(s: ModelRunStats): string {
  if (s.model === "claude" && s.costUsd === 0) return "$0 · subscription";
  if (!Number.isFinite(s.costUsd)) return "–";
  return `$${s.costUsd.toFixed(4)}`;
}

function fmtTimestamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso || "–";
  return new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function runDuration(run: RunReport): string {
  const a = Date.parse(run.startedAt);
  const b = Date.parse(run.finishedAt);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return "";
  return fmtMs(b - a);
}

function severityChip(sev: Finding["severity"]): string {
  return `<span class="chip sev-${esc(sev)}">${esc(sev)}</span>`;
}

function categoryChip(category: string): string {
  return `<span class="chip chip-cat">${esc(category)}</span>`;
}

function verifiedBadge(verified: boolean): string {
  return verified
    ? `<span class="badge badge-ok">verified</span>`
    : `<span class="badge badge-muted">unverified</span>`;
}

function navBadge(ok: boolean): string {
  return ok
    ? `<span class="badge badge-ok">nav ok</span>`
    : `<span class="badge badge-bad">nav failed</span>`;
}

function shotUrl(runId: string, pageIndex: number): string {
  return `/reports/${encodeURIComponent(runId)}/shot/${pageIndex}.png`;
}

function pdfUrl(runId: string, pageIndex: number): string {
  return `/reports/${encodeURIComponent(runId)}/pdf/${pageIndex}.pdf`;
}

/** Models to show as columns/sections, in canonical order. */
function modelsInRun(run: RunReport): ModelName[] {
  const present = new Set<ModelName>();
  for (const s of run.stats) present.add(s.model);
  for (const f of run.findings) present.add(f.model);
  if (run.scorecard) {
    for (const e of run.scorecard.entries) {
      for (const m of e.caughtBy) present.add(m);
    }
  }
  const filtered = CANONICAL_MODELS.filter((m) => present.has(m));
  return filtered.length > 0 ? filtered : CANONICAL_MODELS.slice();
}

/* ------------------------------------------------------------------ */
/* KPI row                                                             */
/* ------------------------------------------------------------------ */

function kpiCard(label: string, value: string, sub: string): string {
  return `
    <div class="kpi">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-sub">${sub}</div>
    </div>`;
}

function kpiSection(run: RunReport, models: ModelName[]): string {
  const cards: string[] = [];
  const scorecard = run.scorecard;

  if (scorecard) {
    const total = scorecard.entries.length;
    for (const m of models) {
      const caught = scorecard.entries.filter((e) => e.caughtBy.includes(m)).length;
      const pct = total > 0 ? Math.round((caught / total) * 100) : 0;
      cards.push(
        kpiCard(
          `${esc(MODEL_LABEL[m])} recall`,
          `${fmtInt(caught)}<span class="kpi-denom">/${fmtInt(total)}</span>`,
          `${pct}% of seeded errors`
        )
      );
    }
    for (const m of models) {
      const fp = scorecard.falsePositives[m] ?? 0;
      cards.push(
        kpiCard(
          `${esc(MODEL_LABEL[m])} false positives`,
          fmtInt(fp),
          "verified, non-seeded"
        )
      );
    }
  }

  const verified = run.findings.filter((f) => f.quoteVerified).length;
  const unverified = run.findings.length - verified;
  cards.push(
    kpiCard(
      "Total findings",
      fmtInt(run.findings.length),
      `${fmtInt(verified)} verified &middot; ${fmtInt(unverified)} unverified`
    )
  );

  for (const s of run.stats) {
    if (s.model === "claude" && s.costUsd === 0) {
      cards.push(kpiCard(`${esc(MODEL_LABEL[s.model])} cost`, "$0", "subscription"));
    } else {
      cards.push(
        kpiCard(
          `${esc(MODEL_LABEL[s.model])} cost`,
          esc(fmtCost(s)),
          esc(s.modelId)
        )
      );
    }
  }

  return `
  <div class="kpi-row" aria-label="Key metrics">
    ${cards.join("\n")}
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Scorecard matrix                                                    */
/* ------------------------------------------------------------------ */

function scorecardSection(run: RunReport, models: ModelName[]): string {
  const scorecard = run.scorecard;
  if (!scorecard) return "";

  const entries = scorecard.entries;
  const total = entries.length;

  const headCells = models
    .map((m) => `<th class="center">${esc(MODEL_LABEL[m])}</th>`)
    .join("");

  const rows = entries
    .map((e: ScorecardEntry) => {
      const cells = models
        .map((m) => {
          const caught = e.caughtBy.includes(m);
          return caught
            ? `<td class="center mark-caught" title="Caught">&#10003;</td>`
            : `<td class="center mark-missed" title="Missed">&#10007;</td>`;
        })
        .join("");
      return `<tr>
        <td class="mono num">${esc(e.errorId)}</td>
        <td class="mono num">${esc(e.questionId)}</td>
        <td>${categoryChip(e.category)}</td>
        <td class="note-cell">${esc(e.note)}</td>
        ${cells}
      </tr>`;
    })
    .join("\n");

  const recallCells = models
    .map((m) => {
      const caught = entries.filter((e) => e.caughtBy.includes(m)).length;
      const pct = total > 0 ? Math.round((caught / total) * 100) : 0;
      return `<td class="center num"><strong>${fmtInt(caught)}/${fmtInt(total)}</strong> <span class="muted">&middot; ${pct}%</span></td>`;
    })
    .join("");

  const fpCells = models
    .map((m) => {
      const fp = scorecard.falsePositives[m] ?? 0;
      return `<td class="center num"><strong>${fmtInt(fp)}</strong></td>`;
    })
    .join("");

  return `
  <section>
    <div class="kicker">Evaluation</div>
    <h2>Scorecard <span class="sub">${total} seeded errors</span></h2>
    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>ID</th><th>Question</th><th>Category</th><th>Note</th>${headCells}</tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
        <tfoot>
          <tr class="summary-row">
            <td colspan="4">Recall</td>
            ${recallCells}
          </tr>
          <tr class="summary-row">
            <td colspan="4">False positives <span class="muted">(verified, non-seeded)</span></td>
            ${fpCells}
          </tr>
        </tfoot>
      </table>
    </div>
  </section>`;
}

/* ------------------------------------------------------------------ */
/* Model comparison                                                    */
/* ------------------------------------------------------------------ */

function statsSection(run: RunReport): string {
  if (run.stats.length === 0) {
    return `
  <section>
    <div class="kicker">Economics</div>
    <h2>Model Comparison</h2>
    <p class="muted">No model stats recorded yet.</p>
  </section>`;
  }

  const rows = run.stats
    .map((s) => {
      const avgLatency = s.calls > 0 ? fmtMs(s.latencyMsTotal / s.calls) : "–";
      return `<tr>
        <td><strong>${esc(MODEL_LABEL[s.model])}</strong><br><span class="mono small muted">${esc(s.modelId)}</span></td>
        <td class="center num">${fmtInt(s.calls)}</td>
        <td class="center num">${fmtInt(s.inputTokens)}</td>
        <td class="center num">${fmtInt(s.outputTokens)}</td>
        <td class="center num">${esc(fmtCost(s))}</td>
        <td class="center num">${esc(avgLatency)}<br><span class="small muted">${esc(fmtMs(s.latencyMsTotal))} total</span></td>
        <td class="center num${s.errors > 0 ? " err" : ""}">${fmtInt(s.errors)}</td>
      </tr>`;
    })
    .join("\n");

  return `
  <section>
    <div class="kicker">Economics</div>
    <h2>Model Comparison</h2>
    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>Model</th><th>Calls</th><th>Input tokens</th><th>Output tokens</th><th>Cost</th><th>Avg latency / call</th><th>Errors</th></tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  </section>`;
}

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

function diffBlock(f: Finding): string {
  const site =
    f.siteQuote === ""
      ? `<span class="muted">(absent)</span>`
      : esc(f.siteQuote);
  return `<div class="diff">
    <div class="diff-col diff-spec">
      <div class="diff-label">Spec</div>
      <code class="quote">${esc(f.specQuote)}</code>
    </div>
    <div class="diff-col diff-site">
      <div class="diff-label">Site</div>
      <code class="quote">${site}</code>
    </div>
  </div>`;
}

function findingsTable(model: ModelName, findings: Finding[]): string {
  const sorted = [...findings].sort(
    (a, b) =>
      Number(b.quoteVerified) - Number(a.quoteVerified) ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.pageIndex - b.pageIndex
  );

  const body =
    sorted.length === 0
      ? `<tr><td colspan="6" class="muted">No findings reported by ${esc(MODEL_LABEL[model])}.</td></tr>`
      : sorted
          .map(
            (f) => `<tr class="finding-row">
        <td class="center num">${fmtInt(f.pageIndex)}</td>
        <td class="mono num">${f.questionId === null ? `<span class="muted">–</span>` : esc(f.questionId)}</td>
        <td>${categoryChip(f.category)}</td>
        <td class="center">${severityChip(f.severity)}</td>
        <td class="desc-cell">${esc(f.description)}</td>
        <td class="center">${verifiedBadge(f.quoteVerified)}</td>
      </tr>
      <tr class="diff-row">
        <td colspan="6">${diffBlock(f)}</td>
      </tr>`
          )
          .join("\n");

  return `
    <h3>${esc(MODEL_LABEL[model])} <span class="sub">${findings.length} finding${findings.length === 1 ? "" : "s"}</span></h3>
    <div class="table-scroll">
      <table class="findings-table">
        <thead>
          <tr><th>Page</th><th>Question</th><th>Category</th><th>Severity</th><th>Description</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${body}
        </tbody>
      </table>
    </div>`;
}

function findingsSection(run: RunReport, models: ModelName[]): string {
  const tables = models
    .map((m) => findingsTable(m, run.findings.filter((f) => f.model === m)))
    .join("\n");
  return `
  <section>
    <div class="kicker">Discrepancies</div>
    <h2>Findings</h2>
    ${tables}
  </section>`;
}

/* ------------------------------------------------------------------ */
/* Pages walk                                                          */
/* ------------------------------------------------------------------ */

function pagesSection(run: RunReport): string {
  if (run.pages.length === 0) {
    return `
  <section>
    <div class="kicker">Evidence</div>
    <h2>Pages</h2>
    <p class="muted">No pages captured.</p>
  </section>`;
  }

  const cards = run.pages
    .map((p: PageCapture) => {
      const png = shotUrl(run.runId, p.pageIndex);
      const shot = p.screenshotKey
        ? `<a class="shot-link" href="${png}" target="_blank" rel="noopener" title="Open full-size screenshot">
            <img class="shot" src="${png}" alt="Screenshot of page ${p.pageIndex}" loading="lazy">
          </a>`
        : `<div class="shot-empty muted small">No screenshot captured for this page.</div>`;
      const pdfLink = p.pdfKey
        ? `<a class="pdf-link" href="${pdfUrl(run.runId, p.pageIndex)}" target="_blank" rel="noopener">PDF</a>`
        : "";
      const notes = p.notes
        ? `<p class="page-notes"><strong>Notes:</strong> ${esc(p.notes)}</p>`
        : "";
      return `
    <article class="page-card">
      <div class="page-head">
        <span class="page-num">Page ${p.pageIndex}</span>
        ${navBadge(p.navOk)}
        ${pdfLink}
      </div>
      ${shot}
      ${notes}
      <details>
        <summary>Captured text</summary>
        <pre class="captured">${esc(p.text)}</pre>
      </details>
    </article>`;
    })
    .join("\n");

  return `
  <section>
    <div class="kicker">Evidence</div>
    <h2>Pages Walk <span class="sub">${run.pages.length} captured</span></h2>
    <div class="strip">
      ${cards}
    </div>
  </section>`;
}

/* ------------------------------------------------------------------ */
/* Document                                                            */
/* ------------------------------------------------------------------ */

/** Build the full self-contained HTML report for a run. */
export function buildHtmlReport(run: RunReport): string {
  const models = modelsInRun(run);
  const hasClaude = run.stats.some((s) => s.model === "claude");
  const duration = runDuration(run);
  const generatedAt = fmtTimestamp(new Date().toISOString());

  let workerOrigin = "<worker-url>";
  try {
    workerOrigin = new URL(run.surveyUrl).origin;
  } catch {
    // keep placeholder if surveyUrl is not absolute
  }
  const pendingNotice = hasClaude
    ? ""
    : `<div class="notice">Third model leg pending &mdash; DeepSeek and Workers AI (gpt-oss-120b) have
        reported; Claude Opus 4.8 runs locally on your Claude subscription ($0, no metered API key).
        Run the local runner:
        <code class="mono">node runner/claude-runner.mjs --worker-url ${esc(workerOrigin)} --run ${esc(run.runId)}</code>
      </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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
<title>Survey QA &mdash; ${esc(run.runId)}</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&amp;family=JetBrains+Mono:wght@400;500&amp;display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: light;
    --ink: #0F2422;
    --paper: #F1F6F5;
    --card: #FFFFFF;
    --accent: #096658;
    --accent-dark: #07564A;
    --ok: #156B3F;
    --bad: #A63220;
    --slate: #435659;
    --border: #D8E2E0;
    --text: #14282A;
    --muted: #435659;
    --band-bg: #071012;
    --band-title: #FFFFFF;
    --band-text: #DCE7E5;
    --band-muted: #85999B;
    --band-dt: #8FA0B5;
    --band-link: #7CE8C9;
    --notice-bg: rgba(194, 87, 27, 0.14);
    --notice-border: rgba(194, 87, 27, 0.55);
    --notice-text: #F3D9C4;
    --notice-code: #FFFFFF;
    --tint: #E5EEEC;
    --table-border: #EFEAE0;
    --row-hover: #FBF7EF;
    --mark-missed: #A9B2BD;
    --chip-cat-bg: #EFEBE2;
    --bad-bg: #FBE9E6;
    --sev-med-bg: #F8E8D8;
    --sev-med-text: #9A4E12;
    --sev-low-bg: #E7EBF0;
    --ok-bg: #DDF2E4;
    --badge-muted-bg: #ECEDEA;
    --spec-bg: #EDF5EF;
    --spec-border: #CBE0D2;
    --site-bg: #F9ECEA;
    --site-border: #E9CCC6;
    --shot-bg: #F1EDE4;
    --note-text: #7A4A12;
    --note-bg: #F8EFDD;
    --note-border: #EBD9B7;
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
      --accent-dark: #5FE0BF;
      --ok: #74D389;
      --bad: #F98576;
      --slate: #8FA6A2;
      --border: #24363A;
      --text: #DCE7E5;
      --muted: #93A9A5;
      --band-bg: #060D0F;
      --band-title: #EDF5F3;
      --band-text: #DCE7E5;
      --band-muted: #7E9490;
      --band-dt: #9DABBF;
      --band-link: #7CE8C9;
      --notice-bg: rgba(232, 130, 74, 0.16);
      --notice-border: rgba(232, 130, 74, 0.5);
      --notice-text: #F2C9A6;
      --notice-code: #F5F1E8;
      --tint: #122023;
      --table-border: #26344C;
      --row-hover: rgba(255, 255, 255, 0.04);
      --mark-missed: #6B7A90;
      --chip-cat-bg: rgba(157, 171, 191, 0.16);
      --bad-bg: rgba(249, 133, 118, 0.16);
      --sev-med-bg: rgba(232, 130, 74, 0.18);
      --sev-med-text: #F0A97E;
      --sev-low-bg: rgba(157, 171, 191, 0.14);
      --ok-bg: rgba(116, 211, 137, 0.14);
      --badge-muted-bg: rgba(157, 171, 191, 0.16);
      --spec-bg: rgba(76, 175, 125, 0.12);
      --spec-border: rgba(76, 175, 125, 0.38);
      --site-bg: rgba(224, 100, 86, 0.12);
      --site-border: rgba(224, 100, 86, 0.4);
      --shot-bg: #0F1B30;
      --note-text: #F0C9A9;
      --note-bg: rgba(232, 130, 74, 0.14);
      --note-border: rgba(232, 130, 74, 0.35);
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
  .wrap { max-width: 1140px; margin: 0 auto; padding: 0 28px; }
  a { color: var(--accent); }

  /* ---------- header band ---------- */
  .band {
    background: var(--band-bg);
    color: var(--band-text);
    padding: 44px 0 40px;
    border-bottom: 4px solid var(--accent);
  }
  .brand-row { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
  .brand {
    font-family: var(--serif);
    font-weight: 600;
    font-size: 34px;
    letter-spacing: 0.2px;
    margin: 0;
    color: var(--band-title);
  }
  .tagline {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--band-muted);
  }
  .band .meta {
    display: grid;
    grid-template-columns: 150px 1fr;
    gap: 5px 18px;
    font-size: 13px;
    margin-top: 26px;
    max-width: 780px;
  }
  .band .meta dt {
    color: var(--band-dt);
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    padding-top: 2px;
  }
  .band .meta dd { margin: 0; word-break: break-all; font-variant-numeric: tabular-nums; }
  .band .meta a { color: var(--band-link); text-decoration: none; }
  .band .meta a:hover { text-decoration: underline; }
  .notice {
    margin-top: 22px;
    background: var(--notice-bg);
    color: var(--notice-text);
    border: 1px solid var(--notice-border);
    border-radius: 10px;
    padding: 12px 16px;
    font-size: 13px;
    max-width: 780px;
  }
  .notice code { display: block; margin-top: 6px; color: var(--notice-code); word-break: break-all; }

  /* ---------- layout ---------- */
  main { padding: 30px 0 56px; }
  section {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 26px 30px 28px;
    margin-bottom: 26px;
    box-shadow: var(--shadow);
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
    margin: 0 0 18px;
    font-family: var(--serif);
    font-weight: 600;
    font-size: 24px;
    color: var(--ink);
    letter-spacing: 0.1px;
  }
  h3 {
    margin: 26px 0 10px;
    font-family: var(--serif);
    font-weight: 600;
    font-size: 17px;
    color: var(--ink);
  }
  .sub { font-family: var(--sans); font-size: 12px; font-weight: 400; color: var(--slate); margin-left: 10px; }
  .mono { font-family: var(--mono); }
  .small { font-size: 11px; }
  .muted { color: var(--muted); }
  .num { font-variant-numeric: tabular-nums; }

  /* ---------- KPI row ---------- */
  .kpi-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(158px, 1fr));
    gap: 16px;
    margin-bottom: 26px;
  }
  .kpi {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 18px 14px;
    box-shadow: var(--shadow);
  }
  .kpi-label {
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.13em;
    color: var(--slate);
    margin-bottom: 6px;
  }
  .kpi-value {
    font-family: var(--serif);
    font-weight: 600;
    font-size: 34px;
    line-height: 1.05;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .kpi-denom { font-size: 20px; color: var(--slate); font-weight: 400; }
  .kpi-sub { font-size: 11.5px; color: var(--muted); margin-top: 6px; font-variant-numeric: tabular-nums; }

  /* ---------- tables ---------- */
  .table-scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--table-border); vertical-align: top; }
  thead th {
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.11em;
    color: var(--slate);
    border-bottom: 2px solid var(--border);
    white-space: nowrap;
    background: transparent;
  }
  tbody tr:hover { background: var(--row-hover); }
  td.num, th.num { font-variant-numeric: tabular-nums; }
  .center { text-align: center; }
  .err { color: var(--bad); font-weight: 700; }
  .mark-caught { color: var(--ok); font-weight: 700; font-size: 15px; }
  .mark-missed { color: var(--mark-missed); font-weight: 700; font-size: 15px; }
  tfoot .summary-row td {
    background: var(--tint);
    border-top: 2px solid var(--border);
    border-bottom: none;
    font-weight: 600;
    color: var(--ink);
  }
  .note-cell { max-width: 340px; }

  /* ---------- chips & badges ---------- */
  .chip {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    white-space: nowrap;
  }
  .chip-cat { background: var(--chip-cat-bg); color: var(--slate); }
  .sev-high { background: var(--bad-bg); color: var(--bad); }
  .sev-medium { background: var(--sev-med-bg); color: var(--sev-med-text); }
  .sev-low { background: var(--sev-low-bg); color: var(--slate); }
  .badge {
    display: inline-block;
    padding: 2px 9px;
    border-radius: 6px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .badge-ok { background: var(--ok-bg); color: var(--ok); }
  .badge-bad { background: var(--bad-bg); color: var(--bad); }
  .badge-muted { background: var(--badge-muted-bg); color: var(--slate); }

  /* ---------- findings diff ---------- */
  .findings-table .desc-cell { min-width: 240px; }
  tr.finding-row td { border-bottom: none; }
  tr.diff-row td { padding-top: 0; padding-bottom: 14px; }
  tr.diff-row:hover { background: transparent; }
  .diff {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .diff-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    margin-bottom: 4px;
  }
  .diff-spec .diff-label { color: var(--ok); }
  .diff-site .diff-label { color: var(--bad); }
  code.quote {
    display: block;
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.5;
    border-radius: 8px;
    padding: 8px 10px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .diff-spec code.quote { background: var(--spec-bg); border: 1px solid var(--spec-border); }
  .diff-site code.quote { background: var(--site-bg); border: 1px solid var(--site-border); }
  @media (max-width: 720px) { .diff { grid-template-columns: 1fr; } }

  /* ---------- pages strip ---------- */
  .strip {
    display: flex;
    gap: 18px;
    overflow-x: auto;
    padding: 4px 2px 14px;
  }
  .page-card {
    flex: 0 0 320px;
    max-width: 320px;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 16px 16px;
    background: var(--card);
  }
  .page-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .page-num { font-family: var(--serif); font-weight: 600; font-size: 16px; color: var(--ink); }
  .pdf-link {
    margin-left: auto;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent);
    text-decoration: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 2px 8px;
  }
  .pdf-link:hover { border-color: var(--accent); }
  .shot-link { display: block; }
  img.shot {
    display: block;
    width: 100%;
    height: 190px;
    object-fit: cover;
    object-position: top;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--shot-bg);
  }
  .shot-empty {
    height: 190px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px dashed var(--border);
    border-radius: 8px;
    background: var(--tint);
    text-align: center;
    padding: 0 14px;
  }
  .page-notes {
    font-size: 12px;
    color: var(--note-text);
    background: var(--note-bg);
    border: 1px solid var(--note-border);
    border-radius: 8px;
    padding: 6px 10px;
    margin: 10px 0 0;
  }
  details { margin-top: 10px; }
  summary { cursor: pointer; font-size: 12.5px; color: var(--accent); font-weight: 600; }
  pre.captured {
    font-family: var(--mono);
    font-size: 11.5px;
    background: var(--tint);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 360px;
    overflow: auto;
  }

  /* ---------- footer ---------- */
  footer {
    text-align: center;
    font-size: 12px;
    color: var(--slate);
    padding-bottom: 40px;
    font-variant-numeric: tabular-nums;
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
    body { background: #FFFFFF; }
    .band {
      background: #FFFFFF;
      color: var(--ink);
      border-bottom: 3px solid var(--ink);
      padding: 20px 0;
    }
    .brand, .band .meta dd { color: var(--ink); }
    .tagline, .band .meta dt { color: var(--slate); }
    .band .meta a, .notice, .notice code { color: var(--ink); }
    .notice { background: #FFFFFF; border-color: var(--border); }
    section, .kpi, .page-card { box-shadow: none; break-inside: avoid; page-break-inside: avoid; }
    tr.finding-row, tr.diff-row { break-inside: avoid; page-break-inside: avoid; }
    .strip { flex-wrap: wrap; overflow: visible; }
    tbody tr:hover { background: transparent; }
    a { text-decoration: none; }
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
    <div class="brand-row">
      <h1 class="brand">Survey QA</h1>
      <span class="tagline">Automated questionnaire-to-website verification</span>
    </div>
    <dl class="meta">
      <dt>Run ID</dt><dd class="mono">${esc(run.runId)}</dd>
      <dt>Survey URL</dt><dd><a href="${esc(run.surveyUrl)}" rel="noopener noreferrer" target="_blank">${esc(run.surveyUrl)}</a></dd>
      <dt>Questionnaire</dt><dd>${esc(run.docxName)}</dd>
      <dt>Started</dt><dd>${esc(fmtTimestamp(run.startedAt))}</dd>
      <dt>Finished</dt><dd>${esc(fmtTimestamp(run.finishedAt))}${duration ? ` <span class="small muted">(${esc(duration)})</span>` : ""}</dd>
    </dl>
    ${pendingNotice}
  </div>
</header>
<main>
  <div class="wrap">
    ${kpiSection(run, models)}
    ${scorecardSection(run, models)}
    ${statsSection(run)}
    ${findingsSection(run, models)}
    ${pagesSection(run)}
  </div>
</main>
<footer>Generated by Survey QA on Cloudflare Workers &middot; ${esc(generatedAt)}</footer>
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
</html>`;
}

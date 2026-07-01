// HTML report builder for survey-qa runs.
// Produces a fully self-contained HTML document (inline CSS only, no external
// assets) from a RunReport. All user/model-derived strings are HTML-escaped.

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
};

const CANONICAL_MODELS: ModelName[] = ["deepseek", "claude"];

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

function fmtCost(s: ModelRunStats): string {
  if (s.model === "claude" && s.costUsd === 0) return "$0 (subscription)";
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
            ? `<td class="center caught">&#10003;</td>`
            : `<td class="center missed">&#10007;</td>`;
        })
        .join("");
      return `<tr>
        <td class="mono">${esc(e.errorId)}</td>
        <td class="mono">${esc(e.questionId)}</td>
        <td>${esc(e.category)}</td>
        <td>${esc(e.note)}</td>
        ${cells}
      </tr>`;
    })
    .join("\n");

  const recallParts = models.map((m) => {
    const caught = entries.filter((e) => e.caughtBy.includes(m)).length;
    const pct = total > 0 ? Math.round((caught / total) * 100) : 0;
    return `${esc(MODEL_LABEL[m])} ${caught}/${total} (${pct}%)`;
  });

  const fpParts = models.map((m) => {
    const fp = scorecard.falsePositives[m] ?? 0;
    return `${esc(MODEL_LABEL[m])}: ${fmtInt(fp)}`;
  });

  const summarySpan = 4 + models.length;

  return `
  <section>
    <h2>Scorecard <span class="sub">${total} seeded errors</span></h2>
    <table>
      <thead>
        <tr><th>ID</th><th>Question</th><th>Category</th><th>Note</th>${headCells}</tr>
      </thead>
      <tbody>
        ${rows}
        <tr class="summary-row">
          <td colspan="${summarySpan}"><strong>Recall:</strong> ${recallParts.join(" &middot; ")}</td>
        </tr>
        <tr class="summary-row">
          <td colspan="${summarySpan}"><strong>False positives (verified, non-seeded):</strong> ${fpParts.join(" &middot; ")}</td>
        </tr>
      </tbody>
    </table>
  </section>`;
}

function statsSection(run: RunReport): string {
  if (run.stats.length === 0) {
    return `
  <section>
    <h2>Model Comparison</h2>
    <p class="muted">No model stats recorded yet.</p>
  </section>`;
  }

  const rows = run.stats
    .map(
      (s) => `<tr>
        <td><strong>${esc(MODEL_LABEL[s.model] ?? s.model)}</strong><br><span class="mono small muted">${esc(s.modelId)}</span></td>
        <td class="center">${fmtInt(s.calls)}</td>
        <td class="center">${fmtInt(s.inputTokens)}</td>
        <td class="center">${fmtInt(s.outputTokens)}</td>
        <td class="center">${esc(fmtCost(s))}</td>
        <td class="center">${esc(fmtMs(s.latencyMsTotal))}</td>
        <td class="center${s.errors > 0 ? " err" : ""}">${fmtInt(s.errors)}</td>
      </tr>`
    )
    .join("\n");

  return `
  <section>
    <h2>Model Comparison</h2>
    <table>
      <thead>
        <tr><th>Model</th><th>Calls</th><th>Input tokens</th><th>Output tokens</th><th>Cost</th><th>Total latency</th><th>Errors</th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </section>`;
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
      ? `<tr><td colspan="7" class="muted">No findings reported by ${esc(MODEL_LABEL[model])}.</td></tr>`
      : sorted
          .map(
            (f) => `<tr>
        <td class="center">${fmtInt(f.pageIndex)}</td>
        <td class="mono">${f.questionId === null ? `<span class="muted">–</span>` : esc(f.questionId)}</td>
        <td>${esc(f.category)}</td>
        <td class="center">${severityChip(f.severity)}</td>
        <td>${esc(f.description)}</td>
        <td>
          <div class="quote-label">spec</div><code class="quote">${esc(f.specQuote)}</code>
          <div class="quote-label">site</div><code class="quote">${f.siteQuote === "" ? `<span class="muted">(absent)</span>` : esc(f.siteQuote)}</code>
        </td>
        <td class="center">${verifiedBadge(f.quoteVerified)}</td>
      </tr>`
          )
          .join("\n");

  return `
    <h3>${esc(MODEL_LABEL[model])} <span class="sub">${findings.length} finding${findings.length === 1 ? "" : "s"}</span></h3>
    <table>
      <thead>
        <tr><th>Page</th><th>Question</th><th>Category</th><th>Severity</th><th>Description</th><th>Quotes</th><th>Status</th></tr>
      </thead>
      <tbody>
        ${body}
      </tbody>
    </table>`;
}

function findingsSection(run: RunReport, models: ModelName[]): string {
  const tables = models
    .map((m) => findingsTable(m, run.findings.filter((f) => f.model === m)))
    .join("\n");
  return `
  <section>
    <h2>Findings</h2>
    ${tables}
  </section>`;
}

function pagesSection(run: RunReport): string {
  if (run.pages.length === 0) {
    return `
  <section>
    <h2>Pages</h2>
    <p class="muted">No pages captured.</p>
  </section>`;
  }

  const cards = run.pages
    .map((p: PageCapture) => {
      const shot = p.screenshotKey
        ? `<img class="shot" src="/reports/${encodeURIComponent(run.runId)}/shot/${p.pageIndex}.png" alt="Screenshot of page ${p.pageIndex}" loading="lazy" style="max-width:520px;width:100%;height:auto;border:1px solid #d8dee6;border-radius:6px;">`
        : `<p class="muted small">No screenshot captured for this page.</p>`;
      const notes = p.notes
        ? `<p class="page-notes"><strong>Notes:</strong> ${esc(p.notes)}</p>`
        : "";
      return `
    <div class="page-card">
      <div class="page-head">
        <strong>Page ${p.pageIndex}</strong>
        ${navBadge(p.navOk)}
      </div>
      ${notes}
      ${shot}
      <details>
        <summary>Captured text</summary>
        <pre class="captured">${esc(p.text)}</pre>
      </details>
    </div>`;
    })
    .join("\n");

  return `
  <section>
    <h2>Pages <span class="sub">${run.pages.length} captured</span></h2>
    ${cards}
  </section>`;
}

/** Build the full self-contained HTML report for a run. */
export function buildHtmlReport(run: RunReport): string {
  const models = modelsInRun(run);
  const hasClaude = run.stats.some((s) => s.model === "claude");
  const duration = runDuration(run);

  const pendingNotice = hasClaude
    ? ""
    : `<div class="notice">Claude comparison pending &mdash; run the local runner:
        <code class="mono">node runner/claude-runner.mjs --worker-url &lt;worker-url&gt; --run ${esc(run.runId)}</code>
      </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Survey QA Report &mdash; ${esc(run.runId)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f4f6f9;
    color: #1e2530;
    line-height: 1.5;
  }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px 20px 64px; }
  header.report-head {
    background: #10243e;
    color: #ffffff;
    border-radius: 10px;
    padding: 22px 26px;
    margin-bottom: 24px;
  }
  header.report-head h1 { margin: 0 0 10px; font-size: 24px; font-weight: 650; letter-spacing: 0.2px; }
  .meta { display: grid; grid-template-columns: 140px 1fr; gap: 4px 14px; font-size: 13px; }
  .meta dt { color: #9db3cc; font-weight: 600; }
  .meta dd { margin: 0; word-break: break-all; }
  .meta a { color: #8fc1ff; text-decoration: none; }
  .meta a:hover { text-decoration: underline; }
  .notice {
    margin-top: 14px;
    background: #fff7e0;
    color: #6b4d00;
    border: 1px solid #e8cf7e;
    border-radius: 6px;
    padding: 10px 14px;
    font-size: 13px;
  }
  section {
    background: #ffffff;
    border: 1px solid #dfe5ec;
    border-radius: 10px;
    padding: 18px 22px;
    margin-bottom: 22px;
  }
  h2 { margin: 0 0 14px; font-size: 18px; border-bottom: 2px solid #eef1f5; padding-bottom: 8px; }
  h3 { margin: 20px 0 8px; font-size: 15px; }
  .sub { font-size: 12px; font-weight: 400; color: #6b7685; margin-left: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #e8ecf1; vertical-align: top; }
  thead th { background: #f0f3f7; font-weight: 650; color: #33404f; white-space: nowrap; }
  tbody tr:hover { background: #fafbfd; }
  .center { text-align: center; }
  .mono { font-family: ui-monospace, Consolas, "Courier New", monospace; }
  .small { font-size: 11px; }
  .muted { color: #8a93a0; }
  .err { color: #b3261e; font-weight: 650; }
  .caught { color: #1a7f37; font-weight: 700; font-size: 15px; }
  .missed { color: #c0392b; font-weight: 700; font-size: 15px; }
  .summary-row td { background: #f7f9fb; font-size: 13px; }
  .chip {
    display: inline-block; padding: 1px 9px; border-radius: 999px;
    font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.4px;
  }
  .sev-high { background: #fde8e7; color: #a1201a; }
  .sev-medium { background: #fdf1dc; color: #8a5b00; }
  .sev-low { background: #e8eef5; color: #40566e; }
  .badge {
    display: inline-block; padding: 1px 8px; border-radius: 4px;
    font-size: 11px; font-weight: 650;
  }
  .badge-ok { background: #dcf2e3; color: #146c2e; }
  .badge-bad { background: #fde8e7; color: #a1201a; }
  .badge-muted { background: #eceff3; color: #6b7685; }
  .quote-label { font-size: 10px; font-weight: 700; color: #8a93a0; text-transform: uppercase; margin-top: 4px; }
  code.quote {
    display: block; font-family: ui-monospace, Consolas, "Courier New", monospace;
    font-size: 11px; background: #f6f8fa; border: 1px solid #e5e9ee; border-radius: 4px;
    padding: 3px 6px; white-space: pre-wrap; word-break: break-word; max-width: 420px;
  }
  .page-card { border: 1px solid #e3e8ee; border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; }
  .page-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .page-notes { font-size: 13px; color: #6b4d00; background: #fff9e8; border-radius: 4px; padding: 6px 10px; }
  details { margin-top: 10px; }
  summary { cursor: pointer; font-size: 13px; color: #33507a; font-weight: 600; }
  pre.captured {
    font-family: ui-monospace, Consolas, "Courier New", monospace;
    font-size: 12px; background: #f6f8fa; border: 1px solid #e5e9ee; border-radius: 6px;
    padding: 12px; white-space: pre-wrap; word-break: break-word; max-height: 420px; overflow: auto;
  }
  footer { text-align: center; font-size: 12px; color: #8a93a0; margin-top: 8px; }
</style>
</head>
<body>
<div class="wrap">
  <header class="report-head">
    <h1>Survey QA Report</h1>
    <dl class="meta">
      <dt>Run ID</dt><dd class="mono">${esc(run.runId)}</dd>
      <dt>Survey URL</dt><dd><a href="${esc(run.surveyUrl)}" rel="noopener noreferrer" target="_blank">${esc(run.surveyUrl)}</a></dd>
      <dt>Questionnaire</dt><dd>${esc(run.docxName)}</dd>
      <dt>Started</dt><dd>${esc(fmtTimestamp(run.startedAt))}</dd>
      <dt>Finished</dt><dd>${esc(fmtTimestamp(run.finishedAt))}${duration ? ` <span class="small">(${esc(duration)})</span>` : ""}</dd>
    </dl>
    ${pendingNotice}
  </header>
  ${scorecardSection(run, models)}
  ${statsSection(run)}
  ${findingsSection(run, models)}
  ${pagesSection(run)}
  <footer>survey-qa &mdash; automated questionnaire vs. rendered-survey language QA</footer>
</div>
</body>
</html>`;
}

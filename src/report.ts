// HTML report builder for survey-qa runs.
// Produces a self-contained HTML document (inline CSS; fonts self-hosted at
// /fonts/ with a strong fallback stack so a saved/offline report still reads).
// All user/model-derived strings are HTML-escaped via esc().
//
// Three model legs feed a report: DeepSeek (deepseek-v4-pro) and Grok (grok-4.3)
// always run in-Worker; Claude (claude-sonnet-4-6) runs in-Worker when an
// Anthropic key is provisioned, with every call routed through the Cloudflare AI
// Gateway. When no Anthropic key is set, the optional local runner
// (runner/claude-runner.mjs) is the fallback: it runs the Claude leg on the
// user's Claude subscription ($0) and POSTs findings back.
//
// Design: the shared "Editorial Medical" system (src/theme-css.ts) — warm paper
// / near-black canvas, Instrument Serif display (italic <em> accents), DM Sans
// body, JetBrains Mono technical labels. Light/dark via prefers-color-scheme +
// a manual [data-theme] toggle; the dark palette is scoped to @media screen so
// print always renders on paper.

import type {
  Finding,
  ModelName,
  ModelRunStats,
  PageCapture,
  RunReport,
  ScorecardEntry,
} from "./types";
import { THEME_CSS } from "./theme-css";

/** When the hardcoded provider $/MTok rates below were last set. Rendered on the
 *  economics card so the cost estimate is honestly dated. Rates are overridable
 *  per-deploy via env (see src/types.ts CLAUDE/DEEPSEEK/GROK_*_USD_PER_MTOK). */
const RATES_AS_OF = "5 Jul 2026";

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
  // Retired legs — labels kept only so reports stored by older runs still render.
  workersai: "workers-ai (retired)",
  gemini: "gemini-2.5-flash (retired)",
  grok: "Grok 4.3",
};

const CANONICAL_MODELS: ModelName[] = ["deepseek", "claude", "workersai", "gemini", "grok"];

// The ACTIVE (non-retired) roster. workers-ai (gpt-oss) and gemini are retired
// from the roster (see the leg gates in workflow.ts), so a CLEAN run is these
// three legs — NOT all five canonical models. "partial" is measured against
// this active set: a clean 3-leg run must not read as partial, while a degraded
// run missing one of these active legs should. Historical runs that still carry
// a retired leg's findings render fine (they simply have >= 3 active legs).
const ACTIVE_MODELS: ModelName[] = ["deepseek", "claude", "grok"];

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

/** Cost as display text. Claude at $0 means the subscription-billed fallback runner. */
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

/** Coerce a page index from stored (JSON) data to a safe non-negative
 *  integer before it is interpolated into HTML or a URL. */
function pageIdx(value: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function shotUrl(runId: string, pageIndex: number): string {
  return `/reports/${encodeURIComponent(runId)}/shot/${pageIdx(pageIndex)}.png`;
}

function pdfUrl(runId: string, pageIndex: number): string {
  return `/reports/${encodeURIComponent(runId)}/pdf/${pageIdx(pageIndex)}.pdf`;
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
/* Issue grouping — merge per-model findings into one issue per         */
/* discrepancy, with consensus + provenance + derived confidence.       */
/* ------------------------------------------------------------------ */

type Confidence = "high" | "medium" | "low";

interface Issue {
  key: string;
  questionId: string | null;
  category: string;
  pageIndex: number;
  /** Distinct models that flagged this discrepancy, in canonical order. */
  flaggedBy: ModelName[];
  /** Highest severity across the contributing findings. */
  severity: Finding["severity"];
  /** True when any contributing finding passed verbatim verification. */
  verified: boolean;
  confidence: Confidence;
  /** Representative finding used for the title + provenance evidence. */
  lead: Finding;
  /** All contributing findings (may be several per model in edge cases). */
  members: Finding[];
}

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

const CONFIDENCE_BASIS: Record<Confidence, string> = {
  high: "Flagged by 2 or more distinct models whose evidence quotes were EACH verbatim-verified in both the questionnaire and the rendered page.",
  medium:
    "Either flagged by a single model with verbatim-verified quotes, or flagged by 2+ models without two independently verified quotes.",
  low: "Flagged by a single model and the evidence quotes were not verbatim-verified.",
};

/** Normalized fragment of a quote: whitespace-collapsed, lower-cased (matching
 *  verify.ts's case-insensitive matching), capped so trivial tail differences
 *  don't split one defect. Used to tell distinct defects apart on a page. */
function normFrag(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 48);
}

/** A defect's identity independent of questionId: the spec + site quote it
 *  cites. Two findings with the same signature on the same page+category are the
 *  same discrepancy even if one carries a questionId and the other does not. */
function quoteSig(f: Finding): string {
  return `${normFrag(f.specQuote)}${normFrag(f.siteQuote)}`;
}

/** High requires the corroboration to be REAL: 2+ DISTINCT models each with a
 *  verbatim-verified quote — matching CONFIDENCE_BASIS.high. A single verified
 *  model, or a 2+-model agreement without two independently verified quotes, is
 *  Medium; a lone unverified flag is Low. */
function deriveConfidence(consensus: number, verifiedModels: number): Confidence {
  if (verifiedModels >= 2) return "high";
  if (verifiedModels >= 1 || consensus >= 2) return "medium";
  return "low";
}

/** Merge the run's findings (up to one per model per real discrepancy) into
 *  a de-duplicated list of issues, sorted by confidence then severity.
 *
 *  Grouping is two-pass so that:
 *   - two DISTINCT null-questionId defects of the same category on one page stay
 *     separate cards (keyed by their quote signature, not collapsed together), and
 *   - the SAME defect reported once with a questionId and once without groups into
 *     ONE consensus card (the null-qid finding joins the qid group when their
 *     page + category + quote signature match), preserving the multi-model signal.
 *  questionId comparison stays case-insensitive, as verify.ts matches it. */
function buildIssues(run: RunReport): Issue[] {
  const groups = new Map<string, Finding[]>();
  // page+category+quoteSig -> the group key that already owns that defect, so a
  // later null-qid finding for the same defect joins the right (possibly qid) group.
  const sigToKey = new Map<string, string>();

  const hasQid = (f: Finding): boolean => f.questionId !== null && f.questionId !== "";
  const sigOf = (f: Finding): string => `${f.pageIndex}\u001f${f.category}\u001f${quoteSig(f)}`;
  const push = (key: string, f: Finding): void => {
    const bucket = groups.get(key);
    if (bucket) bucket.push(f);
    else groups.set(key, [f]);
  };

  // Pass 1: findings WITH a questionId group by question + category. Register
  // each group's page+category+quote signature so a matching null-qid finding
  // can attach to it in pass 2.
  for (const f of run.findings) {
    if (!hasQid(f)) continue;
    const key = `q:${(f.questionId as string).toLowerCase()}\u001f${f.category}`;
    push(key, f);
    const sk = sigOf(f);
    if (!sigToKey.has(sk)) sigToKey.set(sk, key);
  }

  // Pass 2: findings WITHOUT a questionId. Join an existing group (qid or
  // null-qid) that describes the same defect; otherwise start their own card,
  // keyed by the quote signature so distinct null-qid defects don't merge.
  for (const f of run.findings) {
    if (hasQid(f)) continue;
    const sk = sigOf(f);
    let key = sigToKey.get(sk);
    if (!key) {
      key = `p:${sk}`;
      sigToKey.set(sk, key);
    }
    push(key, f);
  }

  const issues: Issue[] = [];
  for (const [key, members] of groups) {
    const flaggedBy = CANONICAL_MODELS.filter((m) => members.some((f) => f.model === m));
    const verified = members.some((f) => f.quoteVerified);
    // Distinct models whose OWN contributing finding passed verbatim verification.
    const verifiedModels = CANONICAL_MODELS.filter((m) =>
      members.some((f) => f.model === m && f.quoteVerified)
    );
    // Prefer a verified finding as the evidence lead so the provenance shown
    // is the one that passed verbatim verification; else the highest severity.
    const lead =
      [...members].sort(
        (a, b) =>
          Number(b.quoteVerified) - Number(a.quoteVerified) ||
          SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
      )[0] ?? members[0];
    const severity = members.reduce<Finding["severity"]>(
      (best, f) => (SEVERITY_RANK[f.severity] < SEVERITY_RANK[best] ? f.severity : best),
      "low"
    );
    const confidence = deriveConfidence(flaggedBy.length, verifiedModels.length);
    issues.push({
      key,
      questionId: lead.questionId,
      category: lead.category,
      pageIndex: lead.pageIndex,
      flaggedBy,
      severity,
      verified,
      confidence,
      lead,
      members,
    });
  }

  issues.sort(
    (a, b) =>
      CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
      b.flaggedBy.length - a.flaggedBy.length ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.pageIndex - b.pageIndex
  );
  return issues;
}

/* ------------------------------------------------------------------ */
/* Overview strip                                                      */
/* ------------------------------------------------------------------ */

function statCard(label: string, value: string, sub: string): string {
  return `
    <div class="kpi">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-sub">${sub}</div>
    </div>`;
}

function overviewSection(run: RunReport, models: ModelName[], issues: Issue[]): string {
  const highConf = issues.filter((i) => i.confidence === "high").length;
  const consensus = issues.filter((i) => i.flaggedBy.length >= 2).length;

  // The report page is served for BOTH the terminal "complete" status and the
  // interim "awaiting-claude" status (workflow.ts sets status = claude ?
  // "complete" : "awaiting-claude"). So a missing in-Worker Claude stat means
  // the run is genuinely still in progress (awaiting the fallback Claude runner);
  // a present Claude stat means the run is terminal. Only an in-progress run may
  // say "so far" — a completed run never does, even if a leg was unavailable.
  const inProgress = !run.stats.some((s) => s.model === "claude");
  const activeRan = ACTIVE_MODELS.filter((m) => models.includes(m)).length;
  const missingActive = activeRan < ACTIVE_MODELS.length;

  const cards = [
    statCard(
      "Issues",
      fmtInt(issues.length),
      `merged from ${fmtInt(run.findings.length)} model finding${run.findings.length === 1 ? "" : "s"}`
    ),
    statCard(
      "High confidence",
      fmtInt(highConf),
      "≥2 models, each verbatim-verified"
    ),
    statCard(
      "Multi-model consensus",
      fmtInt(consensus),
      `flagged by ≥ 2 of ${fmtInt(models.length)} model${models.length === 1 ? "" : "s"}`
    ),
  ];

  // Per-model agreement strip: recall (from the benchmark) + cost, one line each.
  const scorecard = run.scorecard;
  const total = scorecard ? scorecard.entries.length : 0;
  const statByModel = new Map<ModelName, ModelRunStats>();
  for (const s of run.stats) statByModel.set(s.model, s);

  const modelRows = models
    .map((m) => {
      const flagged = issues.filter((i) => i.flaggedBy.includes(m)).length;
      let recall = `<span class="muted">no benchmark</span>`;
      if (scorecard && total > 0) {
        const caught = scorecard.entries.filter((e) => e.caughtBy.includes(m)).length;
        const pct = Math.round((caught / total) * 100);
        recall = `<strong>${fmtInt(caught)}/${fmtInt(total)}</strong> <span class="muted">&middot; ${pct}% recall</span>`;
      }
      const s = statByModel.get(m);
      const cost = s ? esc(fmtCost(s)) : `<span class="muted">pending</span>`;
      return `<div class="agree-row">
        <span class="agree-model">${esc(MODEL_LABEL[m])}</span>
        <span class="agree-recall num">${recall}</span>
        <span class="agree-flagged num">flagged ${fmtInt(flagged)} issue${flagged === 1 ? "" : "s"}</span>
        <span class="agree-cost num">${cost}</span>
      </div>`;
    })
    .join("\n");

  let partialNote = "";
  if (inProgress) {
    // Genuinely mid-run: the Claude leg is still pending (fallback runner).
    partialNote = `<span class="sub">${activeRan} of ${ACTIVE_MODELS.length} model legs run so far</span>`;
  } else if (missingActive) {
    // Terminal but a leg didn't report (a degraded run, or a pre-Grok historical
    // run). Never "so far" — nothing more is coming.
    const gap = ACTIVE_MODELS.length - activeRan;
    partialNote = `<span class="sub">${activeRan} of ${ACTIVE_MODELS.length} legs reported; ${
      gap === 1 ? "one leg was" : `${gap} legs were`
    } unavailable this run</span>`;
  }

  return `
  <section>
    <div class="kicker">Overview</div>
    <h2>What we found ${partialNote}</h2>
    <div class="kpi-row" aria-label="Issue summary">
      ${cards.join("\n")}
    </div>
    <div class="agreement" aria-label="Per-model agreement">
      <div class="agree-head">Model agreement</div>
      ${modelRows}
    </div>
  </section>`;
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
    <div class="kicker">Benchmark</div>
    <h2>Seeded-error scorecard <span class="sub">how each model did against ${total} known planted errors</span></h2>
    <p class="section-lede muted">Ten discrepancies were deliberately planted in the survey. This is the ground-truth check that the models actually catch real problems — it backs the confidence scoring on the issue cards above.</p>
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
    <h2>Model comparison</h2>
    <p class="muted">No model stats recorded yet.</p>
  </section>`;
  }

  const scorecard = run.scorecard;
  const total = scorecard ? scorecard.entries.length : 0;

  const rows = run.stats
    .map((s) => {
      const avgLatency = s.calls > 0 ? fmtMs(s.latencyMsTotal / s.calls) : "–";
      let recall = `<span class="muted">–</span>`;
      if (scorecard && total > 0) {
        const caught = scorecard.entries.filter((e) => e.caughtBy.includes(s.model)).length;
        const pct = Math.round((caught / total) * 100);
        recall = `<strong>${fmtInt(caught)}/${fmtInt(total)}</strong> <span class="muted">&middot; ${pct}%</span>`;
      }
      const errNote = s.errors > 0 ? `<br><span class="small err">${fmtInt(s.errors)} error${s.errors === 1 ? "" : "s"}</span>` : "";
      return `<tr>
        <td><strong>${esc(MODEL_LABEL[s.model])}</strong><br><span class="mono small muted">${esc(s.modelId)}</span></td>
        <td class="center num">${recall}</td>
        <td class="center num">${esc(fmtCost(s))}</td>
        <td class="center num">${esc(avgLatency)}${errNote}</td>
      </tr>`;
    })
    .join("\n");

  return `
  <section>
    <div class="kicker">Economics</div>
    <h2>Model comparison <span class="rates-stamp" title="When the hardcoded provider list prices were last set">rates as of ${esc(RATES_AS_OF)}</span></h2>
    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>Model</th><th>Recall</th><th>Cost</th><th>Avg latency / call</th></tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
    <p class="rates-note muted small">Cost is an estimate from provider list prices as of ${esc(RATES_AS_OF)} (per-deploy overridable via env $/MTok rates); Claude at &ldquo;$0 &middot; subscription&rdquo; is the flat-rate fallback runner, not a metered API charge.</p>
  </section>`;
}

/* ------------------------------------------------------------------ */
/* Issue cards — one card per discrepancy, issue-first                 */
/* ------------------------------------------------------------------ */

/** Two-line provenance diff: what the questionnaire said vs what the site
 *  showed. Absence-type findings (empty siteQuote) are phrased as expected
 *  content that is missing from the rendered page. */
function provenanceBlock(f: Finding): string {
  const absent = f.siteQuote === "";
  const siteLabel = absent ? "Rendered page" : "Site shows";
  const siteBody = absent
    ? `<span class="absent">expected from the questionnaire, but ABSENT from the rendered page</span>`
    : `<code class="quote">${esc(f.siteQuote)}</code>`;
  return `<div class="prov">
    <div class="prov-line prov-spec">
      <span class="prov-label">Questionnaire says</span>
      <code class="quote">${esc(f.specQuote)}</code>
    </div>
    <div class="prov-line prov-site">
      <span class="prov-label">${siteLabel}</span>
      ${siteBody}
    </div>
  </div>`;
}

/** Consensus row: "N/M models" headline plus one chip per model that ran,
 *  marked flagged (✓) or not (✗). */
function consensusRow(issue: Issue, models: ModelName[]): string {
  const chips = models
    .map((m) => {
      const flagged = issue.flaggedBy.includes(m);
      const mark = flagged ? "&#10003;" : "&#10007;";
      const cls = flagged ? "mchip flagged" : "mchip unflagged";
      const state = flagged ? "flagged this issue" : "did not flag this issue";
      return `<span class="${cls}" title="${esc(MODEL_LABEL[m])} ${state}">${esc(MODEL_LABEL[m])} <span class="mmark">${mark}</span></span>`;
    })
    .join("");
  return `<div class="consensus">
    <span class="consensus-count" title="${issue.flaggedBy.length} of ${models.length} model${models.length === 1 ? "" : "s"} that ran flagged this discrepancy">${issue.flaggedBy.length}/${models.length} models</span>
    <span class="mchips">${chips}</span>
  </div>`;
}

function confidenceChip(c: Confidence): string {
  return `<span class="conf-chip conf-${c}" title="${esc(CONFIDENCE_BASIS[c])}">${esc(CONFIDENCE_LABEL[c])}</span>`;
}

/** Per-model detail: severity + description + verification for each finding
 *  that contributed to the issue. Also surfaces severity disagreement. */
function perModelDetail(issue: Issue): string {
  const rows = [...issue.members]
    .sort(
      (a, b) =>
        CANONICAL_MODELS.indexOf(a.model) - CANONICAL_MODELS.indexOf(b.model) ||
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    )
    .map(
      (f) => `<li class="pm-row">
        <span class="pm-model">${esc(MODEL_LABEL[f.model])}</span>
        ${severityChip(f.severity)}
        ${verifiedBadge(f.quoteVerified)}
        <span class="pm-desc">${esc(f.description)}</span>
      </li>`
    )
    .join("\n");
  return `<details class="per-model">
    <summary>Per-model reports (${issue.members.length})</summary>
    <ul class="pm-list">${rows}</ul>
  </details>`;
}

function issueCard(issue: Issue, models: ModelName[]): string {
  const label =
    issue.questionId !== null && issue.questionId !== ""
      ? esc(issue.questionId)
      : `Page ${fmtInt(issue.pageIndex + 1)}`;

  // Severity disagreement across models is itself signal.
  const distinctSevs = [...new Set(issue.members.map((m) => m.severity))];
  const disagree =
    distinctSevs.length > 1
      ? `<span class="disagree" title="Models assigned different severities">models disagree on severity</span>`
      : "";

  const verifiedMark = issue.verified
    ? `<span class="badge badge-ok" title="The evidence quotes were confirmed to appear literally in both the questionnaire and the rendered page — this is what rules out a hallucinated finding.">verbatim-verified</span>`
    : `<span class="badge badge-muted" title="The evidence quotes were not confirmed verbatim against the sources.">unverified</span>`;

  return `
    <article class="issue conf-${issue.confidence}">
      <div class="issue-top">
        <div class="issue-titlewrap">
          <span class="issue-qid">${label}</span>
          <span class="issue-title">${esc(issue.lead.description)}</span>
        </div>
        ${confidenceChip(issue.confidence)}
      </div>
      ${consensusRow(issue, models)}
      <div class="issue-meta">
        ${severityChip(issue.severity)}
        ${categoryChip(issue.category)}
        <span class="meta-page">Page ${fmtInt(issue.pageIndex + 1)}</span>
        ${verifiedMark}
        ${disagree}
      </div>
      <div class="prov-wrap">
        <div class="prov-head">How we found it</div>
        ${provenanceBlock(issue.lead)}
      </div>
      ${issue.members.length > 1 ? perModelDetail(issue) : ""}
    </article>`;
}

function issuesSection(run: RunReport, models: ModelName[], issues: Issue[]): string {
  if (issues.length === 0) {
    return `
  <section>
    <div class="kicker">Discrepancies</div>
    <h2>Issues</h2>
    <p class="muted">No discrepancies were reported for this run.</p>
  </section>`;
  }
  const cards = issues.map((i) => issueCard(i, models)).join("\n");
  return `
  <section>
    <div class="kicker">Discrepancies</div>
    <h2>Issues <span class="sub">${issues.length} discrepanc${issues.length === 1 ? "y" : "ies"}, most-confident first</span></h2>
    <div class="issues">
      ${cards}
    </div>
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
      const idx = pageIdx(p.pageIndex);
      const png = shotUrl(run.runId, idx);
      const shot = p.screenshotKey
        ? `<a class="shot-link" href="${png}" target="_blank" rel="noopener" title="Open full-size screenshot">
            <img class="shot" src="${png}" alt="Screenshot of page ${idx + 1}" loading="lazy">
          </a>`
        : `<div class="shot-empty muted small">No screenshot captured for this page.</div>`;
      const pdfLink = p.pdfKey
        ? `<a class="pdf-link" href="${pdfUrl(run.runId, idx)}" target="_blank" rel="noopener">PDF</a>`
        : "";
      const notes = p.notes
        ? `<p class="page-notes"><strong>Notes:</strong> ${esc(p.notes)}</p>`
        : "";
      return `
    <article class="page-card">
      <div class="page-head">
        <span class="page-num">Page ${idx + 1}</span>
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
    <div class="kicker">Appendix</div>
    <details class="appendix">
      <summary><h2 class="appendix-title">Evidence appendix <span class="sub">${run.pages.length} page${run.pages.length === 1 ? "" : "s"} captured — screenshots &amp; PDFs</span></h2></summary>
      <div class="strip">
        ${cards}
      </div>
    </details>
  </section>`;
}

/* ------------------------------------------------------------------ */
/* Document                                                            */
/* ------------------------------------------------------------------ */

/** Build the full self-contained HTML report for a run. */
export function buildHtmlReport(run: RunReport): string {
  const models = modelsInRun(run);
  const issues = buildIssues(run);
  const hasClaude = run.stats.some((s) => s.model === "claude");
  const duration = runDuration(run);
  const generatedAt = fmtTimestamp(new Date().toISOString());

  // The report page is always served by the Worker itself, so the page's own
  // origin (location.origin) IS the Worker origin. run.surveyUrl may point at
  // a different host entirely, so deriving the runner URL from it would hand
  // the user a command aimed at the wrong server. Render a placeholder
  // server-side; the inline script below fills in location.origin.
  const reportedLabels = run.stats
    .filter((s) => s.model !== "claude")
    .map((s) => esc(MODEL_LABEL[s.model] ?? s.model));
  const reportedLead =
    reportedLabels.length === 0
      ? "The automatic legs have"
      : reportedLabels.length === 1
        ? `${reportedLabels[0]} has`
        : `${reportedLabels.slice(0, -1).join(", ")} and ${reportedLabels[reportedLabels.length - 1]} have`;
  const pendingNotice = hasClaude
    ? ""
    : `<div class="notice">Claude leg pending &mdash; ${reportedLead} reported. Claude
        Sonnet 4.6 runs in-Worker automatically when an Anthropic key is set; this deployment has
        none, so use the fallback local runner (bills your Claude subscription, $0):
        <code class="mono" id="runnerCmd" data-run-id="${esc(run.runId)}">node runner/claude-runner.mjs --worker-url &lt;this-worker-url&gt; --run ${esc(run.runId)}</code>
      </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
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
<link rel="preload" href="/fonts/instrument-serif-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/dm-sans-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/jetbrains-mono-400.woff2" as="font" type="font/woff2" crossorigin>
<style>
${THEME_CSS}

/* ---------- report-page components ---------- */
.masthead { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.masthead-text { min-width: 0; }
.brand-row { align-items: baseline; }
.brand { font-size: 34px; }
.band .meta {
  display: grid; grid-template-columns: 150px 1fr; gap: 5px 18px;
  font-size: 13px; margin-top: 24px; max-width: 780px;
}
.band .meta dt {
  color: var(--band-dt); font-family: var(--mono); font-weight: 400; font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.12em; padding-top: 2px;
}
.band .meta dd { margin: 0; word-break: break-all; font-variant-numeric: tabular-nums; color: var(--band-text); }
.band .meta a { color: var(--band-link); text-decoration: none; }
.band .meta a:hover { text-decoration: underline; }
.notice {
  margin-top: 22px; background: var(--notice-bg); color: var(--notice-text);
  border: 1px solid var(--notice-border); border-radius: var(--radius-sm);
  padding: 12px 16px; font-size: 13px; max-width: 780px;
}
.notice code { display: block; margin-top: 6px; color: var(--notice-code); word-break: break-all; }

main { padding: 30px 0 56px; position: relative; z-index: 1; }
section {
  background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 26px 30px 28px; margin-bottom: 26px; box-shadow: var(--shadow);
}

/* KPI row */
.kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 16px; margin-bottom: 26px; }
.kpi { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px 14px; box-shadow: var(--shadow-sm); }
.kpi-label { font-family: var(--mono); font-size: 10.5px; font-weight: 400; text-transform: uppercase; letter-spacing: 0.12em; color: var(--slate); margin-bottom: 8px; }
.kpi-value { font-family: var(--serif); font-weight: 400; font-size: 38px; line-height: 1.02; letter-spacing: -0.01em; color: var(--ink); font-variant-numeric: tabular-nums; }
.kpi-sub { font-size: 11.5px; color: var(--muted); margin-top: 6px; font-variant-numeric: tabular-nums; }

/* tables — report extras (base table styling is shared) */
.err { color: var(--bad); font-weight: 600; }
.mark-caught { color: var(--green-text); font-weight: 600; font-size: 15px; }
.mark-missed { color: var(--mark-missed); font-weight: 600; font-size: 15px; }
tfoot .summary-row td { background: var(--tint); border-top: 2px solid var(--border); border-bottom: none; font-weight: 600; color: var(--ink); }
.note-cell { max-width: 340px; }
.rates-stamp {
  margin-left: 10px; font-family: var(--mono); font-size: 10.5px; font-weight: 400;
  text-transform: uppercase; letter-spacing: 0.08em; color: var(--slate);
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-pill); padding: 2px 10px; vertical-align: middle; white-space: nowrap;
}
.rates-note { margin: 12px 0 0; }

/* findings diff */
code.quote {
  display: block; font-family: var(--mono); font-size: 11.5px; line-height: 1.5;
  border-radius: var(--radius-sm); padding: 8px 10px; white-space: pre-wrap; word-break: break-word;
}

/* overview: agreement strip */
.section-lede { margin: -8px 0 16px; font-size: 12.5px; max-width: 760px; }
.agreement { margin-top: 20px; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.agree-head { font-family: var(--mono); font-size: 10.5px; font-weight: 400; text-transform: uppercase; letter-spacing: 0.12em; color: var(--slate); background: var(--tint); padding: 8px 16px; border-bottom: 1px solid var(--border); }
.agree-row { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; padding: 10px 16px; border-bottom: 1px solid var(--table-border); font-size: 13px; }
.agree-row:last-child { border-bottom: none; }
.agree-model { font-family: var(--serif); font-weight: 400; font-size: 16px; color: var(--ink); min-width: 92px; }
.agree-recall { min-width: 150px; }
.agree-flagged { color: var(--muted); }
.agree-cost { margin-left: auto; color: var(--ink); font-weight: 600; }

/* issue cards */
.issues { display: flex; flex-direction: column; gap: 16px; }
.issue { border: 1px solid var(--border); border-left: 4px solid var(--slate); border-radius: var(--radius); padding: 16px 18px 16px; background: var(--card); }
.issue.conf-high { border-left-color: var(--accent-solid); }
.issue.conf-medium { border-left-color: var(--accent); }
.issue.conf-low { border-left-color: var(--slate); }
.issue-top { display: flex; align-items: flex-start; gap: 14px; }
.issue-titlewrap { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.issue-qid { font-family: var(--mono); font-weight: 400; font-size: 13px; color: var(--accent); background: var(--chip-cat-bg); border-radius: 6px; padding: 1px 8px; white-space: nowrap; }
.issue-title { font-family: var(--serif); font-weight: 400; font-size: 18px; letter-spacing: -0.01em; color: var(--ink); line-height: 1.3; }
.conf-chip { display: inline-block; padding: 3px 11px; border-radius: var(--radius-pill); font-family: var(--mono); font-size: 11px; font-weight: 400; letter-spacing: 0.02em; white-space: nowrap; cursor: help; flex: 0 0 auto; }
.conf-chip.conf-high { background: var(--accent-solid); color: var(--accent-ink); }
.conf-chip.conf-medium { background: var(--primary-soft); color: var(--accent-solid); }
.conf-chip.conf-low { background: var(--badge-muted-bg); color: var(--slate); }

/* consensus */
.consensus { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
.consensus-count { font-family: var(--serif); font-weight: 400; font-size: 15px; color: var(--ink); background: var(--tint); border-radius: 6px; padding: 2px 10px; white-space: nowrap; cursor: help; }
.mchips { display: flex; gap: 6px; flex-wrap: wrap; }
.mchip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: var(--radius-pill); font-size: 11px; font-weight: 600; white-space: nowrap; border: 1px solid transparent; }
.mchip.flagged { background: var(--ok-bg); color: var(--green-text); border-color: var(--spec-border); }
.mchip.unflagged { background: transparent; color: var(--muted); border-color: var(--border); }
.mchip .mmark { font-weight: 600; }
.mchip.flagged .mmark { color: var(--green-text); }
.mchip.unflagged .mmark { color: var(--mark-missed); }
.issue-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.meta-page { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.disagree { font-family: var(--mono); font-size: 10.5px; font-weight: 400; text-transform: uppercase; letter-spacing: 0.04em; color: var(--sev-med-text); background: var(--sev-med-bg); border-radius: 6px; padding: 2px 8px; cursor: help; }

/* provenance */
.prov-wrap { margin-top: 14px; }
.prov-head { font-family: var(--mono); font-size: 10px; font-weight: 400; text-transform: uppercase; letter-spacing: 0.14em; color: var(--slate); margin-bottom: 8px; }
.prov { display: flex; flex-direction: column; gap: 8px; }
.prov-line { display: grid; grid-template-columns: 130px 1fr; gap: 10px; align-items: start; }
.prov-label { font-family: var(--mono); font-size: 10px; font-weight: 400; text-transform: uppercase; letter-spacing: 0.1em; padding-top: 8px; }
.prov-spec .prov-label { color: var(--green-text); }
.prov-site .prov-label { color: var(--bad); }
.prov-spec code.quote { background: var(--spec-bg); border: 1px solid var(--spec-border); }
.prov-site code.quote { background: var(--site-bg); border: 1px solid var(--site-border); }
.prov .absent { display: block; font-size: 12px; font-style: italic; color: var(--bad); background: var(--site-bg); border: 1px dashed var(--site-border); border-radius: var(--radius-sm); padding: 8px 10px; }
@media (max-width: 620px) { .prov-line { grid-template-columns: 1fr; gap: 4px; } .prov-label { padding-top: 0; } }

/* per-model detail */
.per-model { margin-top: 14px; border-top: 1px solid var(--table-border); padding-top: 10px; }
.per-model summary { font-size: 12px; font-weight: 600; color: var(--accent); cursor: pointer; }
.pm-list { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.pm-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 12.5px; }
.pm-model { font-family: var(--serif); font-weight: 400; font-size: 14px; color: var(--ink); min-width: 76px; }
.pm-desc { color: var(--muted); flex: 1; min-width: 180px; }

/* appendix */
.appendix > summary { list-style: none; cursor: pointer; }
.appendix > summary::-webkit-details-marker { display: none; }
.appendix-title { display: inline; margin: 0; }
.appendix > summary::before { content: "\\25B8"; color: var(--accent); font-weight: 400; margin-right: 8px; }
.appendix[open] > summary::before { content: "\\25BE"; }

/* pages strip */
.strip { display: flex; gap: 18px; overflow-x: auto; padding: 4px 2px 14px; }
.page-card { flex: 0 0 320px; max-width: 320px; border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px 16px; background: var(--card); }
.page-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.page-num { font-family: var(--serif); font-weight: 400; font-size: 17px; color: var(--ink); }
.pdf-link { margin-left: auto; font-family: var(--mono); font-size: 11px; font-weight: 400; letter-spacing: 0.06em; text-transform: uppercase; color: var(--accent); text-decoration: none; border: 1px solid var(--border); border-radius: 6px; padding: 2px 8px; }
.pdf-link:hover { border-color: var(--accent); }
.shot-link { display: block; }
img.shot { display: block; width: 100%; height: 190px; object-fit: cover; object-position: top; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--shot-bg); }
.shot-empty { height: 190px; display: flex; align-items: center; justify-content: center; border: 1px dashed var(--border); border-radius: var(--radius-sm); background: var(--tint); text-align: center; padding: 0 14px; }
.page-notes { font-size: 12px; color: var(--note-text); background: var(--note-bg); border: 1px solid var(--note-border); border-radius: var(--radius-sm); padding: 6px 10px; margin: 10px 0 0; }
details { margin-top: 10px; }
summary { cursor: pointer; font-size: 12.5px; color: var(--accent); font-weight: 600; }
pre.captured { font-family: var(--mono); font-size: 11.5px; background: var(--tint); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px; white-space: pre-wrap; word-break: break-word; max-height: 360px; overflow: auto; }

footer { font-variant-numeric: tabular-nums; padding: 0 28px 40px; }

/* print — force the light palette + tidy the deliverable */
@media print {
  body { background: #FFFFFF; }
  .band { background: #FFFFFF; border-bottom: 3px solid var(--ink); padding: 20px 0; }
  .brand, .band .meta dd { color: var(--ink); }
  .tagline, .band .meta dt { color: var(--slate); }
  .band .meta a, .notice, .notice code { color: var(--ink); }
  .notice { background: #FFFFFF; border-color: var(--border); }
  section, .kpi, .page-card, .issue { box-shadow: none; break-inside: avoid; page-break-inside: avoid; }
  .appendix > summary::before { content: ""; margin: 0; }
  details.appendix, details.per-model { display: block; }
  details.appendix > summary, details.per-model > summary { display: none; }
  .strip { flex-wrap: wrap; overflow: visible; }
  tbody tr:hover { background: transparent; }
  a { text-decoration: none; }
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
        <p class="kicker">Findings report &middot; questionnaire-to-website QA</p>
        <div class="brand-row">
          <h1 class="brand">Survey <em>QA</em></h1>
          <span class="tagline">Automated questionnaire-to-website verification</span>
        </div>
      </div>
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
    ${overviewSection(run, models, issues)}
    ${issuesSection(run, models, issues)}
    ${scorecardSection(run, models)}
    ${statsSection(run)}
    ${pagesSection(run)}
  </div>
</main>
<footer>Generated by Survey QA on Cloudflare Workers &middot; ${esc(generatedAt)}</footer>
<script>
(function () {
  "use strict";
  /* Fill in the local-runner command with the Worker origin — this page is
     served by the Worker, so location.origin is the correct target. */
  var cmd = document.getElementById("runnerCmd");
  if (cmd) {
    cmd.textContent = "node runner/claude-runner.mjs --worker-url " + location.origin +
      " --run " + (cmd.getAttribute("data-run-id") || "");
  }
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

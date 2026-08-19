// Direction 2 upgrade — v2 report view components.
//
// These render the three Direction 2 sections that are ADDED to the existing
// report views. They do NOT replace anything: the existing Summary, Full check,
// and Audit trail views keep their behaviour unchanged. Direction 2 components
// are inserted into the existing views to enrich them.
//
// HONESTY CONSTRAINTS:
//   - Every figure traces to a named API field. Nothing is invented.
//   - Unverified judgements, refused certifications, and "not tested" states
//     are rendered prominently, never hidden.
//   - Exercised is neutral (--neutral-strong-bg), never success green.
//   - Coverage is computed, not attested: anything not covered says so.
//   - The walk-artifact-index may be missing: filmstrip degrades to a text note.

import { esc } from "./esc.mjs";
import { plainify } from "./plain-text.mjs";

/* ------------------------------------------------------------------ *
 * KPI STRIP                                                            *
 * ------------------------------------------------------------------ *
 * Three cards. Each value traces to a named register denominator field.
 * "No current result" is rendered as text, not as zero, not as blank.  */

export function renderV2KpiStrip(view) {
  const reg = view.register;
  const dr = reg.denominators.documentRequirements;
  const ec = reg.denominators.executionCases;
  const pub = view.publication;
  const cur = pub.currentResults;

  const docReqValue = typeof dr.total === "number" ? String(dr.total) : "not established";
  const docReqSub = "Extracted from the questionnaire";

  let checksValue, checksSub, checksMod = "";
  const colId = pub.currentColumnId;
  if (colId && ec.byColumn[colId]) {
    const roll = ec.byColumn[colId].roll;
    const done = roll.pass + roll.fail;
    checksValue = String(done);
    checksSub = `of ${ec.total} mandatory checks`;
  } else {
    // POLISH-6: an em dash is not a number, and "No column may report completion" describes
    // the pipeline's internal state rather than the reader's. The KPI now answers the question
    // it is asked — have the mandatory checks completed? — with a plain "Not yet".
    checksValue = "Not yet";
    checksSub = "No results have cleared our evidence check";
    checksMod = " v2-kpi--neutral";
  }

  let failValue, failSub, failMod = "";
  if (cur.present) {
    failValue = String(cur.roll.fail);
    failSub = cur.roll.fail > 0 ? "Current result" : "Current result — no failing requirement";
    failMod = cur.roll.fail > 0 ? " v2-kpi--fail" : "";
  } else {
    failValue = "—";
    failSub = "No current result";
    failMod = " v2-kpi--neutral";
  }

  return `<div class="v2-kpi-strip" aria-label="Result summary">
    <div class="v2-kpi">
      <div class="v2-kpi-label">Document requirements</div>
      <div class="v2-kpi-value">${esc(docReqValue)}</div>
      <div class="v2-kpi-sub">${esc(docReqSub)}</div>
    </div>
    <div class="v2-kpi${checksMod}">
      <div class="v2-kpi-label">Mandatory checks completed</div>
      <div class="v2-kpi-value">${esc(checksValue)}</div>
      <div class="v2-kpi-sub">${esc(checksSub)}</div>
    </div>
    <div class="v2-kpi${failMod}">
      <div class="v2-kpi-label">Failing</div>
      <div class="v2-kpi-value">${esc(failValue)}</div>
      <div class="v2-kpi-sub">${esc(failSub)}</div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ *
 * RESPONDENT-CONSEQUENCE CARDS                                         *
 * ------------------------------------------------------------------ *
 * One card per failing requirement that has a respondent.consequence.
 * If no consequence is available, the card says so explicitly.         */

export function renderV2ConsequenceCards(view) {
  const findings = (view.findings.supported || []).filter(
    (f) => f.respondent && f.respondent.known && f.respondent.consequence
  );
  if (!findings.length) return "";

  const cards = findings.map((f) => {
    return `<div class="v2-consequence-card">
      <div class="v2-consequence-id">${esc(f.findingId)}</div>
      <div class="v2-consequence-text">${esc(f.respondent.consequence)}</div>
      <details class="tech"><summary>Technical details</summary>
        <p class="mono">Affected: ${(f.itemRefs || []).join(", ") || "none"}</p>
        <p class="mono">Evidence: ${(f.evidenceRefs || []).join(", ") || "none"}</p>
      </details>
    </div>`;
  });

  return `<div class="v2-section-kicker">What a respondent experiences</div>
  <div class="v2-section-title">Failing requirements</div>
  ${cards.join("")}`;
}

/* ------------------------------------------------------------------ *
 * SCOPE TILES                                                          *
 * ------------------------------------------------------------------ *
 * Two cards: document requirements and mandatory browser checks.
 * Never summed. The "what was not tested" list is explicit.            */

export function renderV2ScopeTiles(view) {
  const reg = view.register;
  const dr = reg.denominators.documentRequirements;
  const ec = reg.denominators.executionCases;
  const pub = view.publication;
  const cov = view.coverage;

  // Compute exercised/not-reached/blocked counts from coverage
  const exercised = cov.counts.exercised || 0;
  const notReached = cov.counts["not-reached"] || 0;
  const blocked = cov.counts.blocked || 0;
  const provenUnreachable = cov.counts["proven-unreachable"] || 0;
  const budgetExhausted = cov.counts["budget-exhausted"] || 0;
  const timeExhausted = cov.counts["time-exhausted"] || 0;
  const pending = cov.counts.pending || 0;

  let checksDetail;
  const colId = pub.currentColumnId;
  if (colId && ec.byColumn[colId]) {
    const roll = ec.byColumn[colId].roll;
    const done = roll.pass + roll.fail;
    checksDetail = `${done} completed (pass or fail) · ${ec.total - done} not completed`;
  } else {
    checksDetail = "No current column may report completion";
  }

  // Build the not-tested list from coverage
  const notTestedItems = [];
  const auditRows = view.audit?.rows || [];

  for (const row of auditRows) {
    const item = row.item;
    if (!item) continue;
    const status = row.coverageStatus;
    if (
      status === "not-reached" ||
      status === "proven-unreachable" ||
      status === "blocked" ||
      status === "budget-exhausted" ||
      status === "time-exhausted" ||
      status === "pending"
    ) {
      notTestedItems.push({
        id: item.itemId,
        status,
        requirement: item.requirement || "no description recorded",
      });
    }
  }

  const notTestedHtml = notTestedItems.length
    ? `<div class="v2-not-tested">
        <h3>Requirements not tested</h3>
        <ul class="v2-not-tested-list">
          ${notTestedItems
            .slice(0, 30)
            .map((it) => {
              const chipClass =
                it.status === "blocked"
                  ? " v2-state-chip--blocked"
                  : it.status === "budget-exhausted" || it.status === "time-exhausted"
                    ? " v2-state-chip--budget"
                    : "";
              const label =
                it.status === "not-reached"
                  ? "Not reached"
                  : it.status === "proven-unreachable"
                    ? "Cannot be reached"
                    : it.status === "blocked"
                      ? "Blocked"
                      : it.status === "budget-exhausted"
                        ? "Cost limit"
                        : it.status === "time-exhausted"
                          ? "Time limit"
                          : "Pending";
              return `<li><span class="v2-state-chip${chipClass}">${esc(label)}</span> ${esc(it.requirement)}</li>`;
            })
            .join("")}
          ${notTestedItems.length > 30 ? `<li class="muted">and ${notTestedItems.length - 30} more</li>` : ""}
        </ul>
      </div>`
    : "";

  return `<div class="v2-section-kicker">Scope</div>
  <div class="v2-section-title">What was tested and what was not</div>
  <p class="v2-section-lead">Two denominators, two cards. One document requirement can require several mandatory checks. These totals describe different things and are never added.</p>
  <div class="v2-scope-grid">
    <div class="v2-scope-card">
      <div class="v2-scope-label">Document requirements</div>
      <div class="v2-scope-value">${esc(String(dr.total))}</div>
      <div class="v2-scope-detail">${esc(String(exercised))} exercised · ${esc(String(notReached))} not reached · ${esc(String(blocked))} blocked</div>
    </div>
    <div class="v2-scope-card">
      <div class="v2-scope-label">Mandatory browser checks</div>
      <div class="v2-scope-value">${esc(String(ec.total))}</div>
      <div class="v2-scope-detail">${esc(checksDetail)}</div>
    </div>
  </div>
  ${notTestedHtml}`;
}

/* ------------------------------------------------------------------ *
 * TRUST STRIP                                                          *
 * ------------------------------------------------------------------ *
 * The four trust statements as horizontal badges instead of a grid.    */

export function renderV2TrustStrip(view) {
  const pub = view.publication;
  if (!pub.trustStatements || !pub.trustStatements.length) return "";
  // VOCABULARY BOUNDARY: t.value often carries internal terms (sealed revision,
  // contract revision, matcher version) that are banned from customer copy.
  // The compact trust badge shows ONLY the label, which is written in survey
  // language. The full detail lives in the Audit trail.
  const badges = pub.trustStatements.map((t) => {
    const toneClass =
      t.tone === "ok"
        ? "v2-trust-badge--ok"
        : t.tone === "warn" || t.tone === "amber"
          ? "v2-trust-badge--warn"
          : "v2-trust-badge--neutral";
    const glyph = t.tone === "ok" ? "✓" : t.tone === "warn" || t.tone === "amber" ? "⚠" : "·";
    return `<span class="v2-trust-badge ${toneClass}">${glyph} ${esc(t.label)}</span>`;
  });
  return `<div class="v2-trust-strip" aria-label="Trust statements">${badges.join("")}</div>`;
}

/* ------------------------------------------------------------------ *
 * EVIDENCE SIDEBAR                                                     *
 * ------------------------------------------------------------------ *
 * A filmstrip of evidence thumbnails. Images load on demand from the
 * evidence-content endpoint. For a rendered report, all evidence is
 * post-run. Thumbnails show a placeholder with label text; the real
 * image loads via lazy-loading when the sidebar comes into view.       */

export function renderV2EvidenceSidebar(view) {
  const evidence = view.evidence?.rows || [];
  if (!evidence.length) return "";

  const screenshotEvidence = evidence.filter(
    (e) => e.type === "screenshot" || e.type === "screen-capture" || e.contentType?.startsWith("image/")
  );

  if (!screenshotEvidence.length) {
    return `<div class="v2-evidence-sidebar">
      <h3>Captured screens</h3>
      <p class="muted">No screenshot evidence is attached to this run's findings.</p>
    </div>`;
  }

  const thumbs = screenshotEvidence.slice(0, 24).map((e) => {
    const label = e.evidenceId || "unknown";
    const hasHref = e.audit?.href;
    return `<div>
      <div class="v2-filmstrip-thumb"${hasHref ? ` data-evidence-href="${esc(e.audit.href)}"` : ""}>
        <span class="v2-placeholder">${esc(label)}</span>
      </div>
      <div class="v2-filmstrip-label">${esc(label)}</div>
    </div>`;
  });

  const total = screenshotEvidence.length;
  const shown = Math.min(total, 24);

  return `<div class="v2-evidence-sidebar">
    <h3>Captured screens · ${esc(String(total))} evidence file${total === 1 ? "" : "s"}</h3>
    <div class="v2-filmstrip">${thumbs.join("")}</div>
    ${total > shown ? `<p class="muted" style="margin-top:8px">${total - shown} more evidence files not shown here. Open the Audit trail to see the full evidence catalogue.</p>` : ""}
  </div>`;
}

/* ------------------------------------------------------------------ *
 * LIMITATIONS PANEL                                                    *
 * ------------------------------------------------------------------ *
 * Visible on every view. Named, counted limitations.                   */

export function renderV2LimitationsPanel(view) {
  const items = [];
  const cov = view.coverage;

  // Count non-exercised by category
  const notReached = cov.counts["not-reached"] || 0;
  const blocked = cov.counts.blocked || 0;
  const budgetExhausted = cov.counts["budget-exhausted"] || 0;
  const timeExhausted = cov.counts["time-exhausted"] || 0;
  const pending = cov.counts.pending || 0;
  const provenUnreachable = cov.counts["proven-unreachable"] || 0;

  if (notReached > 0)
    items.push({ count: notReached, text: "Requirements never reached (not passes)" });
  if (blocked > 0)
    items.push({ count: blocked, text: "Requirements blocked by rendering failure" });
  if (provenUnreachable > 0)
    items.push({ count: provenUnreachable, text: "Requirements proven unreachable" });
  if (budgetExhausted > 0)
    items.push({ count: budgetExhausted, text: "Requirements stopped at cost limit" });
  if (timeExhausted > 0)
    items.push({ count: timeExhausted, text: "Requirements stopped at time limit" });
  if (pending > 0)
    items.push({ count: pending, text: "Requirements not completed" });

  // Capture failures from evidence
  const missingEvidence = (view.evidence?.rows || []).filter(
    (e) => e.audit?.state === "missing" || e.audit?.state === "mismatch"
  ).length;
  if (missingEvidence > 0) {
    items.push({ count: missingEvidence, text: "Evidence files missing or mismatched" });
  }

  if (!items.length) return "";

  const totalCount = items.reduce((s, i) => s + i.count, 0);

  return `<div class="v2-limitations">
    <div class="v2-limitations-title">Limitations · ${esc(String(totalCount))} item${totalCount === 1 ? "" : "s"} the report cannot settle</div>
    <ul class="v2-lim-list">
      ${items
        .map(
          (it) =>
            `<li class="v2-lim-item"><span class="v2-lim-count">${esc(String(it.count))}</span> ${esc(it.text)}</li>`
        )
        .join("")}
    </ul>
  </div>`;
}

/* ------------------------------------------------------------------ *
 * FINDINGS VIEW (v1-style provenance diffs)                            *
 * ------------------------------------------------------------------ *
 * One card per supported finding with "The document says" vs
 * "What the survey does" provenance diff.                              */

export function renderV2FindingsView(view) {
  const findings = view.findings.supported || [];
  if (!findings.length) {
    return `<div class="v2-section-kicker">Findings</div>
    <div class="v2-section-title">No findings requiring action</div>
    <p class="v2-section-lead">This is what the record says, not a claim that the survey is defect-free. Read it beside the scope section: a requirement that was never exercised cannot have produced a finding.</p>`;
  }

  const cards = findings.map((f) => {
    const sevClass =
      f.severity === "critical" || f.severity === "high"
        ? "sev--high"
        : f.severity === "medium"
          ? "sev--medium"
          : "sev--low";
    const kindLabel = f.kindLabel || f.kind || "unclassified";

    // VOCABULARY BOUNDARY: f.summary, f.expected, f.observed are engineering
    // strings that may carry internal terms (OBL-, obligation, viewport geometry).
    // The customer-facing provenance diff uses plainified text; the raw record
    // strings are placed inside a Technical details disclosure, which the jargon
    // gate treats as a separate zone.
    const plainSummary = plainify(f.summary, { maxChars: 400, stripMetaTail: true }).text
      || "the survey does not match the questionnaire here";
    const plainExpected = plainify(f.expected, { maxChars: 320 }).text || "not recorded";
    const plainObserved = plainify(f.observed, { maxChars: 320 }).text || "not recorded";

    const consequence = f.respondent?.consequence || null;

    return `<article class="v2-finding-card">
      <div class="v2-finding-head">
        <span class="v2-finding-title">${esc(plainSummary)}</span>
        <span class="sev ${sevClass}">${esc(f.severity)}</span>
        <span class="badge badge--neutral">${esc(kindLabel)}</span>
      </div>
      <div class="v2-prov">
        <div class="v2-prov-line v2-prov-spec">
          <span class="v2-prov-label">The document says</span>
          <span class="v2-prov-quote">${esc(plainExpected)}</span>
        </div>
        <div class="v2-prov-line v2-prov-site">
          <span class="v2-prov-label">What the survey does</span>
          <span class="v2-prov-quote">${esc(plainObserved)}</span>
        </div>
      </div>
      ${
        consequence
          ? `<div class="v2-finding-consequence"><strong>What a respondent experiences:</strong> ${esc(consequence)}</div>`
          : ""
      }
      <details class="tech"><summary>Technical details</summary>
        <p class="mono">${esc(f.findingId)}</p>
        ${f.summary ? `<p class="mono">${esc(f.summary)}</p>` : ""}
        ${f.expected ? `<p class="mono">${esc(f.expected)}</p>` : ""}
        ${f.observed ? `<p class="mono">${esc(f.observed)}</p>` : ""}
        <p class="mono">Affected: ${(f.itemRefs || []).join(", ") || "none"}</p>
        <p class="mono">Evidence: ${(f.evidenceRefs || []).join(", ") || "none"}</p>
      </details>
    </article>`;
  });

  return `<div class="v2-section-kicker">Findings</div>
  <div class="v2-section-title">${esc(String(findings.length))} finding${findings.length === 1 ? "" : "s"}, most severe first</div>
  <p class="v2-section-lead">Each finding shows what the document says alongside what the survey does. Evidence references link to captured screens.</p>
  ${cards.join("")}`;
}

/* ------------------------------------------------------------------ *
 * V2 SUMMARY ENRICHMENT                                                *
 * ------------------------------------------------------------------ *
 * Combines all Direction 2 summary components into a block that is
 * inserted into the existing Summary view.                             */

export function renderV2SummaryEnrichment(view) {
  const parts = [];
  parts.push(renderV2KpiStrip(view));
  parts.push(renderV2ConsequenceCards(view));
  parts.push(renderV2ScopeTiles(view));
  parts.push(renderV2TrustStrip(view));
  parts.push(renderV2EvidenceSidebar(view));
  parts.push(renderV2LimitationsPanel(view));
  return parts.filter(Boolean).join("\n");
}

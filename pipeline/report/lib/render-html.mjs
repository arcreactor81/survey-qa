// Renders the ReportView to a single self-contained HTML document.
//
// No external fetches, no CDN, no build step: CSS is inlined, the only script
// is an ~15-line theme toggle. Every string that came from a record is escaped;
// DOM excerpts and quotes render as inert text, never as markup.
//
// The primary audit body is the Requirement Register (renderRegister), backed by
// lib/register.mjs. It replaced the old flat coverage table and carries strictly
// more: source anchor, compiled expectation, per-run cells with explicit states,
// mandatory execution subrows, per-cell evidence chains, and the flag lanes.
// Case expansion is CSS-only (`:has`), and where `:has` is unsupported every
// case row simply stays visible — this page fails open, because failing open
// cannot hide an unresolved state.

import { esc } from "./esc.mjs";
import { buildDecisionSummary } from "./plain-language.mjs";
import { renderSummaryView } from "./render-summary.mjs";
import { renderFullCheckView, buildRegisterCsv } from "./render-full-check.mjs";
import {
  renderV2SummaryEnrichment,
  renderV2FindingsView,
  renderV2LimitationsPanel,
} from "./render-v2-views.mjs";
import {
  COVERAGE_ORDER,
  COVERAGE_LABEL,
  COVERAGE_GLYPH,
  COVERAGE_MEANING,
  VERDICT_ORDER,
  VERDICT_LABEL,
  VERDICT_GLYPH,
  VERDICT_TONE,
} from "./view-model.mjs";

/* ------------------------------------------------------------------ *
 * DEFERRED BLOCKS — the artifact's size, without deleting anything      *
 * ------------------------------------------------------------------ *
 * The three-view rebuild put the whole previous page behind the Audit trail
 * tab. That is the right INFORMATION architecture and the wrong FILE: the
 * default view is 3.7% of the bytes, but the artifact grew from 2.4 MB to
 * 3.07 MB, and the owner measures the file. Inside it, one block dominates —
 * the auditor's 119-row × 2-column register table, 1.84 MB of the 2.24 MB
 * audit view, and the only part of the audit trail that duplicates something
 * the customer views already carry in full.
 *
 * So that ONE block ships gzipped and base64'd inside the document and is
 * unpacked into the DOM when the Audit trail is opened. Self-containment is
 * preserved (no fetch, no companion file, no CDN), one-click reachability is
 * preserved (the tab does the unpacking), and nothing is deleted — the bytes
 * are byte-identical on inflation, which `expand-deferred.mjs` proves and the
 * conformance suite asserts.
 *
 * The compressor is INJECTED rather than imported. `render-html.mjs` is shared
 * verbatim with the Worker (worker-v2/src/report/render.ts imports it), so it
 * must not depend on `node:zlib`. A caller that supplies no compressor gets the
 * block inline exactly as before — the previous behaviour, unchanged.
 */
function deferBlock(html, { id, defer, label, fallback }) {
  if (typeof defer !== "function") return html;
  const packed = defer(html, id);
  if (!packed || !packed.base64) return html;
  return `<div class="deferred" data-deferred="${esc(id)}">
      <p class="deferred-note">${esc(label)} <span class="muted">(${Math.round(packed.bytes / 1024)} KB of markup, stored as ${Math.round(
        packed.base64.length / 1024
      )} KB)</span></p>
      <noscript><p class="deferred-note deferred-note--noscript">${esc(fallback)}</p></noscript>
      <script type="application/octet-stream" data-deferred-payload="${esc(id)}" data-encoding="${esc(
        packed.encoding
      )}" data-bytes="${packed.bytes}" data-sha256="${esc(packed.sha256)}">${packed.base64}</script>
    </div>`;
}

/* ----------------------------- primitives ----------------------------- */

export { esc };

const REASON_LABEL_FALLBACK = (code) => (code ? String(code).replace(/-/g, " ") : "no reason code");

function usd(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "not recorded";
  return "$" + n.toFixed(2);
}

function usdPrecise(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "not recorded";
  // Sub-dollar amounts are real money in this pipeline; keep four decimals
  // there and drop to cents once the number is large enough to read.
  return "$" + (Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(4));
}

function fmtDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "not recorded";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (h) parts.push(h + "h");
  if (h || m) parts.push(m + "m");
  parts.push(sec + "s");
  return parts.join(" ");
}

function fmtBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "unknown size";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KiB";
  return (n / (1024 * 1024)).toFixed(2) + " MiB";
}

function fmtInt(n) {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "not recorded";
}

function fmtConfidence(c) {
  return typeof c === "number" ? c.toFixed(2) : "not recorded";
}

function fmtDateTime(iso) {
  if (!iso) return "not recorded";
  return String(iso);
}

/** Percentage of a NAMED denominator. Never a global progress number. */
function pctOf(used, max) {
  if (typeof used !== "number" || typeof max !== "number" || !(max > 0)) return null;
  return ((used / max) * 100).toFixed(1) + "%";
}

/* ----------------------------- components ----------------------------- */

function coverageBadge(status, { strong = false } = {}) {
  if (!status) {
    return `<span class="badge badge--warn"><span class="glyph" aria-hidden="true">!</span>No coverage status recorded</span>`;
  }
  const label = COVERAGE_LABEL[status] ?? status;
  const glyph = COVERAGE_GLYPH[status] ?? "?";
  // Deliberately neutral for every coverage state, including `exercised`.
  const tone = status === "exercised" ? "neutral badge--strong" : "neutral";
  return `<span class="badge badge--${tone}${strong ? " badge--strong" : ""}" title="${esc(COVERAGE_MEANING[status] ?? "")}"><span class="glyph" aria-hidden="true">${esc(glyph)}</span>${esc(label)}</span>`;
}

function verdictBadge(verdict) {
  if (!verdict) {
    return `<span class="badge badge--warn"><span class="glyph" aria-hidden="true">!</span>No verdict recorded</span>`;
  }
  const tone = VERDICT_TONE[verdict] ?? "neutral";
  return `<span class="badge badge--${tone}"><span class="glyph" aria-hidden="true">${esc(VERDICT_GLYPH[verdict] ?? "?")}</span>${esc(VERDICT_LABEL[verdict] ?? verdict)}</span>`;
}

function severityChip(sev) {
  return `<span class="sev sev--${esc(sev)}">${esc(sev)}</span>`;
}

function tile({ label, value, denom = "", extra = "", modifier = "" }) {
  return `<div class="tile ${modifier}">
      <span class="tile-label">${esc(label)}</span>
      <div class="tile-value num">${esc(value)}</div>
      ${denom ? `<div class="tile-denom">${denom}</div>` : ""}
      ${extra}
    </div>`;
}

function dt(term, value) {
  return `<div><dt>${esc(term)}</dt><dd>${value}</dd></div>`;
}

function refList(label, ids) {
  if (!ids || !ids.length) return `<span>${esc(label)}: <span class="muted">none</span></span>`;
  return `<span>${esc(label)}: ${ids.map((i) => `<span class="idref">${esc(i)}</span>`).join(", ")}</span>`;
}

function emptyState(title, body) {
  return `<div class="empty-state"><strong>${esc(title)}</strong><p>${body}</p></div>`;
}

/* ------------------------------------------------------------------ *
 * FIRST GLANCE (AMENDMENT A)                                          *
 * ------------------------------------------------------------------ *
 * "First-glance order (the current renderer has identity/navigation/'how it
 *  was driven' first — REVERSE IT): 1 critical qualification or launch blocker
 *  → 2 overall action state → 3 result-review state → 4 scope/completeness
 *  → 5 findings → 6 register → 7 methods, hashes, provenance. Do NOT lead with
 *  112 pass, attestation, run ID, cost, or model details."
 * ------------------------------------------------------------------ */

/**
 * 1 — the permanent operational-blocker lane. DIV-001 sits OUTSIDE the
 * document-derived denominator and must never be buried because the expert
 * answer key omitted it.
 */
function renderOperationalBlockers(view) {
  const ob = view.operationalBlockers;
  if (!ob.present) {
    return `<section id="operational" aria-labelledby="op-h">
      <div class="banner banner--neutral" role="status">
        <span class="banner-flag">Operational blockers</span>
        <h2 id="op-h">No operational blocker was recorded for this run.</h2>
        <p>Nothing in this record says the survey could not be opened, driven or completed. That is a statement about what the run recorded, not a guarantee that a respondent's browser will behave.</p>
      </div>
    </section>`;
  }
  const entries = ob.entries
    .map((b) => {
      const finding = view.findings.all.find((f) => f.findingId === b.findingId) ?? null;
      const consequence = finding?.respondent ?? null;
      return `<article class="op-blocker" id="op-${esc(b.findingId)}">
        <div class="finding-head">
          <h3>${esc(b.summary)}</h3>
          ${severityChip(b.severity ?? "critical")}
          <span class="idref">${esc(b.findingId)}</span>
        </div>
        ${
          consequence
            ? `<p class="consequence"><strong>What a respondent experiences:</strong> ${esc(consequence.consequence)}</p>`
            : ""
        }
        <div class="eo">
          <div class="eo-expected"><span class="eo-label">The document presupposes</span>${esc(b.expected ?? "not recorded")}</div>
          <div class="eo-observed"><span class="eo-label">What actually happens</span>${esc(b.observed ?? "not recorded")}</div>
        </div>
        <p class="muted"><strong>Why this is an operational blocker:</strong> ${esc(b.basis)}</p>
        ${
          b.outsideDenominator
            ? `<p class="muted"><strong>Outside the score:</strong> this blocker is not one of the document-derived requirements, so it earns and loses nothing in any count on this page. It stays outside the score unless it is promoted through the contract-gap workflow. It is still the most consequential practical finding in the run.</p>`
            : ""
        }
        <p class="refs">Affected requirements: ${
          b.itemRefs.length
            ? b.itemRefs.map((id) => `<a class="idref" href="#row-${esc(id)}">${esc(id)}</a>`).join(" ")
            : `<span class="muted">none listed</span>`
        } · Evidence: ${
          b.evidenceRefs.length
            ? b.evidenceRefs.map((id) => `<a class="idref" href="#ev-${esc(id)}">${esc(id)}</a>`).join(" ")
            : `<span class="muted">none listed</span>`
        }</p>
      </article>`;
    })
    .join("");

  return `<section id="operational" aria-labelledby="op-h">
      <div class="banner banner--fail" role="alert">
        <span class="banner-flag">Critical operational blocker outside the document-derived denominator</span>
        <h2 id="op-h">${ob.entries.length} operational blocker${ob.entries.length === 1 ? "" : "s"} — ${
          ob.conditioning.length
            ? "the survey cannot be used as delivered, and every other result on this page is conditional"
            : "at least one requirement could not be settled at all"
        }</h2>
        <p class="muted">${esc(ob.rule)}</p>
        ${entries}
      </div>
    </section>`;
}

/** 2 — the overall action state, in one sentence, before any count. */
function renderActionState(view) {
  const ob = view.operationalBlockers;
  const pub = view.publication;
  const mod = view.runContext?.disclosedModification ?? null;

  const lines = [];
  let tone = "neutral";
  let headline;

  if (ob.conditioning.length) {
    tone = "fail";
    headline = "ACTION REQUIRED — the survey cannot be used as delivered.";
    lines.push(
      `${ob.conditioning.map((b) => b.findingId).join(", ")} ${
        ob.conditioning.length === 1 ? "is" : "are"
      } an operational blocker: the survey does not work in an unmodified browser. Fix that before reading anything else.`
    );
    if (mod) {
      lines.push(
        `All subsequent results are conditional on the disclosed compatibility shim (${mod.what}). They describe the survey the author intended to ship, not the survey a respondent currently receives.`
      );
    }
  } else if (pub.currentResults.present && pub.currentResults.roll.fail > 0) {
    tone = "fail";
    headline = `ACTION REQUIRED — ${pub.currentResults.roll.fail} document requirement${
      pub.currentResults.roll.fail === 1 ? "" : "s"
    } fail.`;
    lines.push("Each failing requirement is listed in the findings below with what a respondent experiences and what to re-test.");
  } else if (!pub.currentResults.present) {
    tone = "warn";
    headline = "NO CURRENT RESULT — nothing on this page is yet an answer about this survey.";
    lines.push(pub.currentResults.note);
  } else {
    tone = "neutral";
    headline = "No failing requirement in the current result.";
    lines.push("Read this beside the scope section: a requirement that was never exercised is not a pass.");
  }

  if (pub.resultReview.state !== "complete") {
    lines.push(
      `Result review ${pub.resultReview.headline} — as-recorded verdict totals are provisional and are shown as history, not as results.`
    );
  }

  return `<section id="action" aria-labelledby="action-h">
      <div class="banner banner--${tone}" role="alert">
        <span class="banner-flag">Overall action state</span>
        <h2 id="action-h">${esc(headline)}</h2>
        ${lines.map((l) => `<p>${esc(l)}</p>`).join("")}
      </div>
    </section>`;
}

/**
 * 3 — result-review state and the FOUR SEPARATE trust statements.
 * "A generic green badge beside a wrong pass count is actively misleading."
 */
function renderResultReview(view) {
  const pub = view.publication;
  const cur = pub.currentResults;
  const hist = pub.asRecorded;

  const trust = pub.trustStatements
    .map(
      (t) => `<div class="trust trust--${esc(t.tone)}">
        <span class="trust-label">${esc(t.label)}</span>
        <span class="trust-value">${esc(t.value)}</span>
        <span class="trust-scope">${esc(t.scope)}</span>
        ${t.detail ? `<span class="sub">${esc(t.detail)}</span>` : ""}
      </div>`
    )
    .join("");

  const currentBlock = cur.present
    ? `<div class="result-card result-card--current">
         <span class="tile-label">Current result — ${esc(cur.label)}</span>
         <p class="result-headline">${esc(cur.headline)}</p>
         <p class="muted">${esc(cur.note)}</p>
       </div>`
    : `<div class="result-card result-card--none">
         <span class="tile-label">Current result</span>
         <p class="result-headline">${esc(cur.headline)}</p>
         <p class="muted">${esc(cur.note)}</p>
         ${
           /* A REJECTED judgement is not an absent one. Without this line the page read
              identically whether the judging stage never ran or ran and had its output
              refused at the trust boundary — and "not run" is the more flattering of the
              two, which is exactly the wrong way for an ambiguity to fail. */
           pub.judgement.state === "diagnostic"
             ? `<p class="muted"><strong>A judgement document EXISTS for this run and was REJECTED.</strong> ${esc(
                 pub.judgementDiagnostic?.summary ??
                   "It is not schema-valid, not attested against a pinned key, or not bound to this run."
               )} This is not "no result review was run": the judging stage produced output and the report refused it, for the reasons below.</p>`
             : `<p class="muted">No judgement document was supplied for this run, so no independent stage re-derived these verdicts. This is "not run", not "rejected".</p>`
         }
         ${
           pub.judgement.problems.length
             ? `<ul>${pub.judgement.problems
                 .map((p) => `<li><span class="mono">${esc(p.code)}</span> — ${esc(p.message)}</li>`)
                 .join("")}</ul>`
             : ""
         }
       </div>`;

  const bindingRows = (pub.judgement.binding || [])
    .map(
      (c) => `<tr>
        <th scope="row">${esc(c.label)}</th>
        <td>${c.ok ? `<span class="chain chain--ok">binds</span>` : `<span class="chain chain--bad">does not bind</span>`}</td>
        <td><span class="hash">${esc(c.expected ?? "—")}</span></td>
        <td><span class="hash">${esc(c.actual ?? "—")}</span></td>
      </tr>`
    )
    .join("");

  return `<section id="result-review" aria-labelledby="rr-h">
      <div class="section-head">
        <h2 id="rr-h">Result review and what may be published</h2>
        <p class="lead">Only an attested, run-bound JudgementRecord may produce a current result. Everything else on this page is either historical (what the run said about itself) or an operational diagnostic. These are four separate statements on purpose: a valid signature is not a correct verdict.</p>
      </div>
      <div class="trust-grid">${trust}</div>
      <div class="result-cards">
        ${currentBlock}
        <div class="result-card result-card--historical">
          <span class="tile-label">As recorded by the run — historical</span>
          <p class="result-headline">${esc(hist.headline)}</p>
          <p class="muted">${esc(hist.caveat)}</p>
        </div>
      </div>
      ${
        bindingRows
          ? `<details class="panel"><summary>How the judgement binds to this run (${
              (pub.judgement.binding || []).filter((c) => c.ok).length
            } of ${(pub.judgement.binding || []).length} checks bind)</summary>
             <div class="scroll-x"><table class="plain">
               <thead><tr><th scope="col">Binding</th><th scope="col">State</th><th scope="col">This run resolves</th><th scope="col">The judgement says</th></tr></thead>
               <tbody>${bindingRows}</tbody>
             </table></div></details>`
          : ""
      }
      ${
        view.retiredKindNormalizations.length
          ? `<div class="panel"><h3>Retired claim kinds normalized at the boundary (${view.retiredKindNormalizations.length})</h3>
             <p class="muted">These findings arrived carrying a claim kind the current registry has retired. Each was normalized once, here, so it appears as one finding rather than as both a finding and a gap in the kind registry.</p>
             <ul>${view.retiredKindNormalizations
               .map(
                 (n) =>
                   `<li><a class="idref" href="#finding-${esc(n.findingId)}">${esc(n.findingId)}</a> — <span class="mono">${esc(
                     n.from
                   )}</span> → <span class="mono">${esc(n.to)}</span>. ${esc(n.why)}</li>`
               )
               .join("")}</ul></div>`
          : ""
      }
    </section>`;
}

/**
 * 4 — scope and completeness. Two denominators as two EQUAL cards, never
 * summed, plus the explicit 119-vs-136 accounting Amendment A demands.
 */
function renderScope(view) {
  const reg = view.register;
  const dr = reg.denominators.documentRequirements;
  const ec = reg.denominators.executionCases;
  const dm = reg.documentedMandates;
  const c = view.completion;

  const nbo = dm.entries
    .map(
      (m) => `<tr>
        <th scope="row"><span class="idref">${esc(m.id ?? "—")}</span></th>
        <td>${esc(m.mandate ?? "not recorded")}</td>
        <td><span class="badge cell--nbo"><span class="glyph" aria-hidden="true">⊘</span>Not browser-observable</span><span class="sub">${esc(
          m.whyNotObservable ?? "no reviewed reason recorded"
        )}</span></td>
        <td>${
          m.alternativeMethod
            ? esc(m.alternativeMethod)
            : `<span class="chain chain--warn">no alternative verification method named — a reviewer must name one</span>`
        }${m.owner ? `<span class="sub">owner: ${esc(m.owner)}</span>` : `<span class="sub muted">no owner named</span>`}</td>
      </tr>`
    )
    .join("");

  return `<section id="scope" aria-labelledby="scope-h">
      <div class="section-head">
        <h2 id="scope-h">Scope and completeness</h2>
        <p class="lead">Two denominators, two cards, never one number. One document requirement can require several mandatory checks; these totals describe different things and must not be added. Where they disagree, the weaker execution outcome controls.</p>
      </div>
      <div class="denoms">
        <div class="denom-card">
          <span class="tile-label">Document requirements</span>
          <div class="tile-value num">${fmtInt(dr.total)}</div>
          <p class="tile-denom">${esc(dr.definition)}</p>
        </div>
        <div class="denom-card">
          <span class="tile-label">Mandatory browser checks</span>
          <div class="tile-value num">${fmtInt(ec.total)}</div>
          ${(() => {
            // "N of M completed · K not completed", from the column that may
            // report it. Completion means a terminal PASS or FAIL on the case.
            const colId = view.publication.currentColumnId;
            if (!colId) {
              return `<p class="tile-denom"><span class="chain chain--warn">no column may report completion</span> There is no current result for this run, so no stage can say how many mandatory checks completed. The historical column's case outcomes are in the register.</p>`;
            }
            const roll = ec.byColumn[colId].roll;
            const done = roll.pass + roll.fail;
            return `<p class="tile-denom"><strong>${done} of ${ec.total} completed · ${
              ec.total - done
            } not completed.</strong> A mandatory check is completed when it reached a terminal pass or fail. Withheld and undecided checks are not completed and are not passes.</p>`;
          })()}
          <p class="tile-denom">${esc(ec.definition)}</p>
          ${
            ec.notEstablished.rows
              ? `<p class="tile-denom"><span class="chain chain--warn">${ec.notEstablished.rows} requirement(s) have NO established mandatory-case count</span> ${esc(
                  ec.notEstablished.why
                )}</p>`
              : ""
          }
        </div>
      </div>
      <p class="table-note">${esc(reg.denominatorGuard.statement)} ${esc(reg.caseLedger.note)}</p>

      <div class="panel">
        <h3>The documented mandate population</h3>
        <p>${esc(dm.statement)}</p>
        ${
          nbo
            ? `<div class="scroll-x"><table class="plain">
                 <caption>${dm.otherMethod} documented mandate(s) that no browser session can settle. They are never counted as complete and never counted as passes.</caption>
                 <thead><tr><th scope="col">Mandate</th><th scope="col">What the document requires</th><th scope="col">State and reviewed reason</th><th scope="col">Alternative verification method and owner</th></tr></thead>
                 <tbody>${nbo}</tbody>
               </table></div>`
            : `<p class="muted">The record names no mandate requiring a non-browser verification method.</p>`
        }
      </div>

      <div class="panel">
        <h3>Execution completeness</h3>
        <ul class="outcome-pair">
          <li><span class="lbl">Report completeness</span><span class="val">${esc(c.report.headline)}</span></li>
          <li><span class="lbl">Testing completeness</span><span class="val">${esc(c.testing.headline)}</span></li>
        </ul>
        <p><strong>Stopping reason:</strong> ${esc(c.testing.stoppingReason)}</p>
        <!-- WHERE THE ATTEMPTS ENDED. Printed beside the stopping reason because it is the
             line that disambiguates it: "nothing left to press" is what a finished survey and
             a walk that never got in both record, and only the ending tells them apart. -->
        <p><strong>Where the attempts ended:</strong> ${esc(c.testing.endings.headline)}</p>
        <p>${esc(String(c.testing.exercised))} of ${esc(String(c.testing.total))} document requirements were exercised at least once. Exercised is not passed.</p>
        ${
          c.oracle.present
            ? `<p><strong>Scorer check against the private oracle:</strong> ${
                c.oracle.testComplete
                  ? "testing complete — every oracle obligation is accounted for."
                  : `testing <strong>incomplete</strong> — ${esc(String(c.oracle.accounted))} of ${esc(
                      String(c.oracle.total)
                    )} oracle obligations accounted for.`
              } This is corpus-only scoring; an ordinary survey run has no oracle.</p>`
            : `<p class="muted">No scorecard was supplied, so testing completeness is stated only against the extracted contract — not against an independent oracle.</p>`
        }
      </div>
    </section>`;
}

/* ------------------------------ sections ------------------------------ */

function renderEdgeCoverage(view) {
  const ec = view.edgeCoverage;
  if (!ec) return "";

  const lines = [];
  lines.push(
    `<p><strong>${ec.traversed} of ${ec.denominator} edges traversed · ${ec.untouched} untouched.</strong> An edge is traversed when at least one of its source facet instances was exercised during execution. Untouched edges are routing commitments the document states that no walk exercised.</p>`
  );

  if (ec.untraversedEdges && ec.untraversedEdges.length) {
    lines.push("<ul>");
    for (const e of ec.untraversedEdges) {
      lines.push(
        `<li><span class="mono">${esc(e.from)}</span> <span class="muted">"${esc(e.trigger)}"</span> → <span class="mono">${esc(e.to)}</span></li>`
      );
    }
    lines.push("</ul>");
  }

  return `<section id="routing-coverage" aria-labelledby="rc-h">
      <div class="section-head">
        <h2 id="rc-h">Routing graph coverage</h2>
        <p class="lead">Coverage of the document's routing graph edges. Each edge is a routing commitment derived from the sealed contract — a statement the document makes about where an answer should lead. This is measured against what the walks actually exercised.</p>
      </div>
      <div class="panel">
        ${lines.join("")}
      </div>
    </section>`;
}

function renderFixtureNote(view) {
  if (!view.fixtureNote) return "";
  return `<div class="banner banner--warn" role="alert">
      <span class="banner-flag">Synthetic fixture — not a real run</span>
      <p>${esc(view.fixtureNote)}</p>
    </div>`;
}

function renderFailClosed(view) {
  if (!view.integrity.failClosed) return "";
  return `<div class="banner banner--fail" role="alert">
      <span class="banner-flag">Fail-closed</span>
      <h2>Record integrity check failed. Results below are not authoritative.</h2>
      <p>${esc(view.attestation.reason || "The harness attestation on this RunRecord did not verify.")}</p>
      <p>Every coverage count, verdict, and finding on this page is rendered from an unverified record. Success styling is suppressed. Do not act on these results until the record verifies against the pinned key registry.</p>
    </div>`;
}

function renderHeader(view) {
  const run = view.record.run || {};
  const target = run.target || {};
  const cfg = run.configuration || {};
  const ts = run.timestamps || {};
  const att = view.record.attestationBlock || {};
  const a = view.attestation;

  // AMENDMENT A retires the single green "Verified" badge: it is an INTEGRITY
  // statement and nothing else, and it must never stand beside a result count
  // as if it endorsed it. The four separate trust statements lead the page;
  // this one names its own scope.
  const attTone = a.state === "verified" ? "neutral" : a.state === "invalid" ? "fail" : "warn";
  const attLabel =
    a.state === "verified"
      ? "Signature valid — integrity only"
      : a.state === "invalid"
        ? "Signature invalid"
        : "Signature not checked";
  const attGlyph = a.state === "verified" ? "✓" : a.state === "invalid" ? "✕" : "?";

  // Effective parameters can be a large structured block (driver, blindness,
  // scope declarations). Scalars are shown inline; structured keys are named
  // and rendered in full by their own sections rather than dumped here.
  const paramEntries = Object.entries(cfg.parameters || {});
  const scalars = paramEntries.filter(([, v]) => v === null || typeof v !== "object");
  const structured = paramEntries.filter(([, v]) => v !== null && typeof v === "object").map(([k]) => k);
  const params =
    [
      scalars.map(([k, v]) => `${k}=${v}`).join(", "),
      structured.length ? `structured: ${structured.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · ") +
    (structured.length ? " — rendered in full under “How this run was driven” and “Not verifiable from the browser”." : "");

  return `<section id="identity" aria-labelledby="identity-h">
      <div class="section-head">
        <h2 id="identity-h">Run identity and trust</h2>
        <p class="lead">Which document, which build, which configuration, and whether the signed record verifies. Everything else on this page is derived from this record.</p>
      </div>
      <div class="panel">
        <dl class="dl-grid">
          ${dt("Run ID", `<span class="idref">${esc(run.runId)}</span>`)}
          ${dt("RunRecord schema", `<span class="mono">${esc(view.record.schemaVersion)}</span>`)}
          ${dt("Target URL", `<span class="hash">${esc(target.url)}</span>`)}
          ${dt("Environment", esc(target.environment))}
          ${dt("Target build ID", `<span class="idref">${esc(target.buildId)}</span>`)}
          ${dt("Target build hash", `<span class="hash">${esc(target.buildHash)}</span>`)}
          ${dt("Questionnaire document hash", `<span class="hash">${esc(run.documentHash)}</span>`)}
          ${dt("Contract hash (sealed denominator)", `<span class="hash">${esc(run.contractHash)}</span>`)}
          ${dt("Run profile", `<span class="idref">${esc(cfg.profileId)}</span>`)}
          ${dt("Configuration hash", `<span class="hash">${esc(cfg.configurationHash)}</span>`)}
          ${dt("Effective parameters", params ? `<span class="mono">${esc(params)}</span>` : `<span class="muted">none recorded</span>`)}
          ${dt("Created / started / ended", `${esc(fmtDateTime(ts.createdAt))}<span class="sub">${esc(fmtDateTime(ts.startedAt))} → ${esc(fmtDateTime(ts.endedAt))}</span>`)}
        </dl>
      </div>
      <div class="panel">
        <h3>Attestation</h3>
        <p class="muted">This is an integrity statement about the bytes of the record. It proves the record was not altered after signing. It does not say a single verdict in it is correct — see the four trust statements at the top of this page.</p>
        <dl class="dl-grid">
          ${dt(
            "State",
            `<span class="badge badge--${attTone} badge--strong"><span class="glyph" aria-hidden="true">${esc(attGlyph)}</span>${esc(attLabel)}</span>`
          )}
          ${dt("Reason", esc(a.reason || "—"))}
          ${dt("Algorithm / canonicalization / scope", `<span class="mono">${esc(att.algorithm)} · ${esc(att.canonicalization)} · ${esc(att.scope)}</span>`)}
          ${dt("Signing key ID", `<span class="idref">${esc(att.keyId)}</span>`)}
          ${dt("Key registry used", a.registryPath ? `<span class="hash">${esc(a.registryPath)}</span>` : `<span class="muted">none supplied</span>`)}
          ${dt("Signed at", esc(fmtDateTime(att.signedAt)))}
          ${dt("Payload hash", `<span class="hash">${esc(att.payloadHash)}</span>`)}
          ${dt("Signature", `<span class="hash">${esc(att.signature)}</span>`)}
          ${
            view.scorecard
              ? dt(
                  "Scorer / matcher",
                  `<span class="mono">${esc(view.scorecard.scorecardVersion)}</span><span class="sub mono">${esc(view.scorecard.matcherVersion)}</span>`
                )
              : dt("Scorer / matcher", `<span class="muted">no scorecard supplied</span>`)
          }
        </dl>
      </div>
      ${renderIntegrityWarnings(view)}
    </section>`;
}

function renderIntegrityWarnings(view) {
  const w = view.integrity.warnings;
  if (!w.length) return "";
  return `<div class="banner banner--warn" role="status">
      <span class="banner-flag">Record integrity warnings</span>
      <h2>${w.length} structural problem${w.length === 1 ? "" : "s"} found in this record</h2>
      <p>These are reported, not repaired. Nothing on this page was normalised to hide them.</p>
      <ul>${w.map((x) => `<li><span class="mono">${esc(x.code)}</span> — ${esc(x.message)}</li>`).join("")}</ul>
    </div>`;
}

function renderSummary(view) {
  const cov = view.coverage;
  const res = view.resources;
  const f = view.findings;

  const bucketList = COVERAGE_ORDER.filter((k) => cov.counts[k] > 0)
    .map((k) => `<li>${esc(COVERAGE_LABEL[k])}: <span class="num">${cov.counts[k]}</span></li>`)
    .join("");

  const verdictList = VERDICT_ORDER.filter((v) => v !== "not-assessed")
    .map((v) => `<li>${esc(VERDICT_LABEL[v])}: <span class="num">${cov.verdictAmongExercised[v]}</span></li>`)
    .join("");

  const unassessed = cov.unassessedByCause.length
    ? cov.unassessedByCause.map((u) => `<li>${esc(u.cause)}: <span class="num">${u.count}</span></li>`).join("")
    : `<li class="muted">No obligation is unassessed.</li>`;

  const kindList = Object.keys(f.byKind).length
    ? Object.entries(f.byKind)
        .sort()
        .map(([k, n]) => `<li>${esc(k)}: <span class="num">${n}</span></li>`)
        .join("")
    : `<li class="muted">No findings asserted.</li>`;

  const sevList = Object.keys(f.bySeverity).length
    ? Object.entries(f.bySeverity)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, n]) => `<li>${esc(k)}: <span class="num">${n}</span></li>`)
        .join("")
    : "";

  const weighted =
    view.scorecard && typeof view.scorecard.metrics?.costPerVerifiedCoverageUnit === "number"
      ? tile({
          label: "Cost per verified coverage unit",
          value: usdPrecise(view.scorecard.metrics.costPerVerifiedCoverageUnit),
          denom: `supplied by the scorer (${esc(view.scorecard.matcherVersion)}), not computed in the browser; ${esc(
            String(view.scorecard.metrics.verifiedCoverageUnits)
          )} verified units`,
        })
      : "";

  return `<section id="summary" aria-labelledby="summary-h">
      <div class="section-head">
        <p class="kicker">Methods and audit</p>
        <h2 id="summary-h">Execution summary — what the run did, and what it cost</h2>
        <p class="lead">Every number below names its own denominator. Coverage and verdict are separate axes: an exercised obligation is not a passed obligation, and an unassessed obligation is not a pass. Verdict counts in this section are AS RECORDED by the run and are historical; the current result is stated at the top of the page.</p>
      </div>
      <div class="tiles">
        ${tile({
          label: "Obligations exercised",
          value: `${cov.exercised} / ${cov.total}`,
          denom: `of the sealed contract total (${cov.total} extracted obligations)`,
          extra: `<ul>${bucketList}</ul>`,
        })}
        ${tile({
          label: "Verdicts among exercised — AS RECORDED, historical",
          value: `${cov.verdictAmongExercised.pass + cov.verdictAmongExercised.fail + cov.verdictAmongExercised.inconclusive} / ${cov.exercised}`,
          denom:
            "denominator is exercised obligations only. These are the verdicts the executing agent wrote about its own evidence; they are history, not the current result. The current result is at the top of this page.",
          extra: `<ul>${verdictList}</ul>`,
          modifier: "tile--historical",
        })}
        ${tile({
          label: "Unassessed by cause",
          value: String(cov.unassessedTotal),
          denom: `of ${cov.total} extracted obligations carry no usable verdict — these are not passes${
            cov.unassessedTotal !== cov.verdictCounts["not-assessed"]
              ? ` (the record labels ${cov.verdictCounts["not-assessed"]} of them "not-assessed"; see the record integrity warnings)`
              : ""
          }`,
          extra: `<ul>${unassessed}</ul>`,
          modifier: cov.unassessedTotal > 0 ? "tile--warn" : "",
        })}
        ${tile({
          label: "Proven unreachable",
          value: String(cov.counts["proven-unreachable"]),
          denom: "obligations with supported evidence that the state cannot be reached",
        })}
        ${tile({
          label: "Findings asserted",
          value: String(f.totalCount),
          denom: "agent-supplied assertions, by kind and severity",
          extra: `<ul>${kindList}</ul>${sevList ? `<ul>${sevList}</ul>` : ""}`,
          modifier: f.totalCount > 0 ? "tile--flag" : "",
        })}
        ${tile({
          label: "Attested cost",
          value: usdPrecise(res.costUsedUsd),
          denom: `cap ${usd(res.costCapUsd)}${pctOf(res.costUsedUsd, res.costCapUsd) ? ` · ${pctOf(res.costUsedUsd, res.costCapUsd)} of the cost cap` : ""}<br>reserves inside the cap: verification ${usd(
            res.verificationReserveUsd
          )}, reporting ${usd(res.reportReserveUsd)}`,
        })}
        ${tile({
          label: "Wall clock",
          value: fmtDuration(res.wallClockMs),
          denom: `cap ${fmtDuration(res.wallClockCapMs)}${
            pctOf(res.wallClockMs, res.wallClockCapMs) ? ` · ${pctOf(res.wallClockMs, res.wallClockCapMs)} of the time cap` : ""
          }`,
        })}
        ${tile({
          label: "Model / tool calls",
          value: `${fmtInt(res.modelCalls)} / ${fmtInt(res.toolCalls)}`,
          denom: `caps ${fmtInt(res.modelCallCap)} model calls, ${fmtInt(res.toolCallCap)} tool calls`,
        })}
        ${weighted}
      </div>
    </section>`;
}

/**
 * AMENDMENT A: every finding carries the RESPONDENT CONSEQUENCE in survey
 * language, plus reach and what to re-test. Where the record does not support
 * one, the report says so instead of inventing it.
 */
function renderRespondentConsequence(f) {
  const rc = f.respondent;
  if (!rc) return "";
  return `<div class="consequence-block consequence-block--${esc(rc.known ? rc.class : "unknown")}">
      <p class="consequence"><strong>What a respondent experiences:</strong> ${esc(rc.consequence)}</p>
      <p class="sub"><strong>Class:</strong> ${esc(rc.classLabel)} · <strong>Reach:</strong> ${esc(rc.reach.label)}</p>
      <p class="sub"><strong>What to re-test:</strong> ${esc(rc.retest)}</p>
    </div>`;
}

function renderFinding(f, view) {
  const sev = esc(f.severity);
  const cls = `finding finding--${sev}${f.supported ? "" : " finding--unsupported"}`;
  const itemLinks = (f.itemRefs || [])
    .map((id) => `<a class="idref" href="#row-${esc(id)}">${esc(id)}</a>`)
    .join(", ");
  const evidenceLinks = (f.evidenceRefs || [])
    .map((id) => `<a class="idref" href="#ev-${esc(id)}">${esc(id)}</a>`)
    .join(", ");

  return `<article class="${cls}" id="audit-finding-${esc(f.findingId)}" aria-labelledby="finding-h-${esc(f.findingId)}">
      <div class="finding-head">
        <h3 id="finding-h-${esc(f.findingId)}">${esc(f.summary)}</h3>
        ${severityChip(f.severity)}
        <span class="badge badge--neutral">${esc(f.kindLabel)}</span>
        <span class="idref">${esc(f.findingId)}</span>
      </div>
      <p class="muted">Category <span class="mono">${esc(f.category)}</span> · finding confidence ${esc(fmtConfidence(f.confidence))} (agent-assigned)</p>
      ${
        f.retiredKind
          ? `<p class="muted"><strong>Claim kind normalized:</strong> this finding arrived as <span class="mono">${esc(
              f.retiredKind
            )}</span>, which the current registry has retired. ${esc(
              f.retiredKindNote || ""
            )} It is carried once, as <span class="mono">${esc(f.kind)}</span>, and is not also counted as a gap in the kind registry.</p>`
          : ""
      }
      ${renderRespondentConsequence(f)}
      <div class="eo">
        <div class="eo-expected"><span class="eo-label">Expected (from the questionnaire)</span>${esc(f.expected)}</div>
        <div class="eo-observed"><span class="eo-label">Observed (in the running survey)</span>${esc(f.observed)}</div>
      </div>
      <p class="muted"><strong>Verification disposition:</strong> ${esc(f.verificationDisposition.note)}</p>
      ${
        f.scorerDisposition
          ? `<p class="muted"><strong>Corpus scorer disposition (oracle-backed, not panel review):</strong> ${esc(
              f.scorerDisposition.detail
            )}</p>`
          : ""
      }
      ${
        f.supported
          ? ""
          : `<p class="muted"><strong>Unsupported assertion:</strong> this finding carries no evidence references, so it is not presented as an established finding.</p>`
      }
      <div class="refs">
        <span>Affected obligations: ${itemLinks || `<span class="muted">none</span>`}</span>
        ${refList("Attempts", f.attemptRefs)}
        <span>Evidence: ${evidenceLinks || `<span class="muted">none</span>`}</span>
      </div>
    </article>`;
}

function renderFindings(view) {
  const f = view.findings;
  const body = f.supported.length
    ? f.supported.map((x) => renderFinding(x, view)).join("")
    : emptyState(
        "No findings requiring action were asserted in this run.",
        "This is what the record says, not a claim that the survey is defect-free. Read it beside the coverage audit: an obligation that was never exercised cannot have produced a finding."
      );

  const unsupported = f.unsupported.length
    ? `<h3>Unsupported assertions (${f.unsupported.length})</h3>
       <p class="muted">These entries assert a problem but reference no evidence. They are listed for the audit trail and are not shown as established findings.</p>
       ${f.unsupported.map((x) => renderFinding(x, view)).join("")}`
    : "";

  return `<section id="findings" aria-labelledby="findings-h">
      <div class="section-head">
        <h2 id="findings-h">Findings requiring action</h2>
        <p class="lead">Ordered by kind and agent-assigned severity, then questionnaire position. Each entry is an agent-supplied assertion; RunRecord v1.0.0 carries no panel verification record, so none of them is relabelled "confirmed" here.</p>
        ${
          /* THE AUDITOR SURFACE MAY NOT ASSERT A PROVENANCE THE SIGNED RECORD CONTRADICTS.
             "Each entry is an agent-supplied assertion" is true of a record that carries
             its own claims. When the record carried NONE and the entries below were read
             back off the failing cases' own attested observations, that sentence is a false
             statement about the artifact — the exact class of component-contradicts-artifact
             failure this section exists to make visible. So it is corrected here rather than
             left to be inferred from the `observed-` id prefix. */
          view.findings?.source === "verifier-observations"
            ? `<p class="lead"><strong>Not agent-supplied.</strong> This run's record asserts no findings of its own (<code>claims: []</code>) while its aggregator settled ${
                view.findings.failingRequirements
              } requirement(s) as failing. The ${
                view.findings.derivedFromObservations
              } entr${view.findings.derivedFromObservations === 1 ? "y" : "ies"} below were derived at render time from those cases' own attested observations — each one names its source observation, predicate and reason code under <code>derivedFrom</code> in the ReportView. Nothing was authored here.</p>`
            : ""
        }
      </div>
      ${body}
      ${unsupported}
    </section>`;
}

function renderDocumentQuestions(view) {
  const q = view.documentQuestions;
  const blocks = [];

  if (q.ambiguities.length) {
    blocks.push(
      `<h3>Ambiguity findings (${q.ambiguities.length})</h3>` + q.ambiguities.map((x) => renderFinding(x, view)).join("")
    );
  }
  // `document-live-disagreement` is RETIRED (merged contract §1) and is
  // normalized to a defect at the view-model boundary, so there is no live
  // section for it here. The normalization is disclosed once, under Result
  // review, instead of the finding being reported twice.
  if (q.ambiguousResultItems.length) {
    blocks.push(
      `<h3>Obligations closed as ambiguous (${q.ambiguousResultItems.length})</h3><ul>` +
        q.ambiguousResultItems
          .map(
            (r) =>
              `<li><a class="idref" href="#row-${esc(r.item.itemId)}">${esc(r.item.itemId)}</a> — ${esc(
                r.result?.reason?.summary || ""
              )}</li>`
          )
          .join("") +
        `</ul>`
    );
  }

  const lowConf = q.lowConfidenceItems.length
    ? `<h3>Low-confidence extraction (${q.lowConfidenceItems.length})</h3>
       <p class="muted">Selection rule: ${esc(q.rule.description)}. The rule is fixed by the report builder and stated here; it is not a slider.</p>
       <ul>${q.lowConfidenceItems
         .map(
           (r) =>
             `<li><a class="idref" href="#row-${esc(r.item.itemId)}">${esc(r.item.itemId)}</a> — extraction confidence ${esc(
               fmtConfidence(r.item.confidence)
             )} — ${esc(r.item.requirement)}</li>`
         )
         .join("")}</ul>`
    : `<h3>Low-confidence extraction</h3>
       <p class="muted">No contract item fell below the report-builder rule (${esc(q.rule.description)}). Lowest recorded extraction confidence is shown per row in the coverage audit.</p>`;

  const assumptions = q.assumptions.length
    ? `<h3>Contract assumptions and limitations (${q.assumptions.length})</h3>
       <p class="muted">Recorded interpretation risks and coverage limits. If one is wrong or incomplete, the scope built on it may be wrong.</p>
       <ul>${q.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`
    : `<h3>Contract assumptions and limitations</h3><p class="muted">The record lists no contract assumptions or limitations.</p>`;

  const nothingJudged = !q.ambiguities.length && !q.ambiguousResultItems.length;

  return `<section id="document-questions" aria-labelledby="dq-h">
      <div class="section-head">
        <h2 id="dq-h">Document questions</h2>
        <p class="lead">Where the questionnaire is genuinely unclear, this section surfaces the question and judges nothing. An ambiguity is not a confirmed survey defect; its effect is that the scope or the expected behaviour is uncertain.</p>
      </div>
      <div class="panel">
        ${
          nothingJudged
            ? emptyState(
                "No ambiguity was recorded for this run.",
                "The record contains no finding of kind <span class=\"mono\">ambiguity</span>, and no obligation was closed with reason <span class=\"mono\">ambiguous-requirement</span>. The contract assumptions below are the only recorded interpretation risk."
              )
            : blocks.join("")
        }
        ${lowConf}
        ${assumptions}
      </div>
    </section>`;
}

/* Loud, unmissable disclosure of anything the harness changed about the target
   in order to be able to run at all. It sits above every result because it
   conditions every result. */
function renderDisclosedModification(view) {
  const m = view.runContext?.disclosedModification;
  if (!m) return "";
  return `<div class="banner banner--warn" role="alert">
      <span class="banner-flag">Disclosed harness modification</span>
      <h2>The target was modified to make this run possible. Every result below is conditional on that modification.</h2>
      <dl class="dl-grid">
        ${dt("What was changed", esc(m.what))}
        ${dt("Why", esc(m.why))}
        ${dt("Scope of the change", esc(m.scope))}
        ${dt("Consequence for these results", esc(m.consequence))}
      </dl>
    </div>`;
}

function renderMethod(view) {
  const rc = view.runContext;
  if (!rc || !rc.present) return "";
  const d = rc.driver || {};
  const blocks = [];

  blocks.push(`<div class="panel">
      <h3>Driver</h3>
      <dl class="dl-grid">
        ${dt("Layer", esc(d.layer || "not recorded"))}
        ${dt("Tool", esc(d.tool || "not recorded"))}
        ${dt("Browser", esc(d.browser || "not recorded"))}
        ${dt("Serving", esc(d.serving || "not recorded"))}
        ${dt("Viewports", (d.viewports || []).map((v) => `<span class="mono">${esc(v)}</span>`).join("<br>") || "<span class=\"muted\">not recorded</span>")}
        ${dt("Interactions", esc(d.interactions || "not recorded"))}
      </dl>
    </div>`);

  if (rc.models) {
    const m = rc.models;
    blocks.push(`<div class="panel">
      <h3>Models used during execution</h3>
      <dl class="dl-grid">
        ${dt("Navigator", esc(String(m.navigator)))}
        ${dt("Judge", esc(String(m.judge)))}
        ${dt("Provider calls during execution", esc(String(m.workers_ai_calls ?? m.workersAiCalls ?? "not recorded")))}
        ${dt("Rationale", esc(m.rationale || "not recorded"))}
      </dl>
      <p class="muted">Extractor model calls are listed separately under Cost, limits and provenance.</p>
    </div>`);
  }

  if (rc.blindness) {
    blocks.push(`<div class="panel">
      <h3>Blindness</h3>
      <dl class="dl-grid">
        ${dt("Answer key opened during extraction/planning/execution", rc.blindness.truthDirectoryReadDuringExtractionPlanningExecution === false ? "No" : "See note")}
        ${dt("Implementation source read", rc.blindness.siteSourceRead === false ? "No" : "See note")}
      </dl>
      <p>${esc(rc.blindness.note || "")}</p>
    </div>`);
  }

  if (rc.twoTierDesign || rc.scale) {
    const t = rc.twoTierDesign || {};
    const s = rc.scale || {};
    blocks.push(`<div class="panel">
      <h3>Two-tier coverage design and what was actually walked</h3>
      <dl class="dl-grid">
        ${dt("Tier 1 floor paths (planned / completed)", `${esc(String(t.floorPathsPlanned ?? "—"))} / ${esc(String(t.floorPathsCompleted ?? "—"))}`)}
        ${dt("Floor provably covers every obligation", t.floorCoversAllObligations === true ? "Yes" : esc(String(t.floorCoversAllObligations ?? "not recorded")))}
        ${dt("Tier 2 exploration queue (planned / executed)", `${esc(String(t.explorationQueue ?? "—"))} / ${esc(String(t.explorationExecuted ?? "—"))}`)}
        ${dt("Exploration classes", t.explorationByClass ? `<span class="mono">${esc(Object.entries(t.explorationByClass).map(([k, v]) => `${k} ×${v}`).join(", "))}</span>` : "<span class=\"muted\">not recorded</span>")}
        ${dt("Caps", t.explorationCaps ? `<span class="mono">${esc(JSON.stringify(t.explorationCaps))}</span>` : "<span class=\"muted\">not recorded</span>")}
        ${dt("Browser sessions", esc(String(s.total_browser_sessions ?? "not recorded")))}
        ${dt("Screen observations", esc(String(s.total_screen_observations ?? "not recorded")))}
        ${dt("Navigation steps", esc(String(s.total_navigation_steps ?? "not recorded")))}
        ${dt("Self-imposed cap", esc(String(s.self_imposed_cap ?? "not recorded")))}
        ${dt("Denominator lock", esc(String(t.denominatorRule ?? "not recorded")))}
      </dl>
    </div>`);
  }

  if (rc.pathDependentBehaviour) {
    const p = rc.pathDependentBehaviour;
    const found = Array.isArray(p.found) ? p.found : [];
    blocks.push(`<div class="panel">
      <h3>Path-dependent behaviour${found.length ? ` (${found.length})` : ""}</h3>
      ${
        found.length
          ? `<ul>${found.map((f) => `<li>${esc(typeof f === "string" ? f : JSON.stringify(f))}</li>`).join("")}</ul>`
          : `<p>None recorded: no obligation was observed to pass on one route and fail on another.</p>`
      }
      ${p.analysis ? `<p class="muted">${esc(p.analysis)}</p>` : ""}
      ${p.per_screen_consistency ? `<p class="muted">${esc(p.per_screen_consistency)}</p>` : ""}
    </div>`);
  }

  if (rc.harnessCaveats.length) {
    blocks.push(`<div class="panel">
      <h3>Harness caveats (${rc.harnessCaveats.length})</h3>
      <p class="muted">Places where the harness, not the survey, behaved imperfectly. Recorded so that no reader mistakes a harness bug for a site defect.</p>
      <ul>${rc.harnessCaveats.map((c) => `<li>${esc(typeof c === "string" ? c : JSON.stringify(c))}</li>`).join("")}</ul>
    </div>`);
  }

  if (rc.contractIntegrity) {
    const ci = rc.contractIntegrity;
    const qi = ci.quoteIntegrity || {};
    blocks.push(`<div class="panel">
      <h3>Extraction integrity</h3>
      <dl class="dl-grid">
        ${dt("Obligations extracted (the denominator)", esc(String(ci.obligations ?? "—")))}
        ${dt("Ambiguities recorded at extraction", esc(String(ci.ambiguities ?? "—")))}
        ${dt("Mandates declared out of browser scope", esc(String(ci.outOfScopeForBrowser ?? "—")))}
        ${dt("Source-quote verification", `exact ${esc(String(qi.exact ?? "—"))} · normalized ${esc(String(qi.normalized ?? "—"))} · <strong>not found ${esc(String(qi.not_found ?? qi.notFound ?? "—"))}</strong>`)}
        ${dt("By category", ci.byCategory ? `<span class="mono">${esc(Object.entries(ci.byCategory).map(([k, v]) => `${k} ×${v}`).join(", "))}</span>` : "<span class=\"muted\">—</span>")}
        ${dt("Planner warnings", (ci.plannerWarnings || []).length ? `<ul>${(ci.plannerWarnings || []).map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "<span class=\"muted\">none</span>")}
      </dl>
    </div>`);
  }

  return `<section id="method" aria-labelledby="method-h">
      <div class="section-head">
        <h2 id="method-h">How this run was driven</h2>
        <p class="lead">What actually touched the survey, what was deliberately not read, and how much was walked. Read this before the verdicts: a verdict is only as good as the layer that produced it.</p>
      </div>
      ${blocks.join("")}
    </section>`;
}

function renderExploration(view) {
  const e = view.exploration;
  if (!e || !e.present) return "";
  const list = (rows, emptyText) =>
    rows.length
      ? `<ul>${rows
          .map(
            (r) =>
              `<li><a class="idref" href="#finding-${esc(r.id)}">${esc(r.id)}</a>${
                r.finding
                  ? ` — ${esc(r.finding.summary)} <span class="sub">${esc(r.finding.kindLabel)} · ${esc(r.finding.severity)}</span>`
                  : ` <span class="muted">— referenced by the record but not present as an asserted finding</span>`
              }</li>`
          )
          .join("")}</ul>`
      : `<p class="muted">${esc(emptyText)}</p>`;

  return `<section id="exploration" aria-labelledby="exp-h">
      <div class="section-head">
        <h2 id="exp-h">Tier 2 directed exploration — what it added</h2>
        <p class="lead">${esc(
          e.question || "Which findings would a clean forward walk have missed?"
        )} Exploration may only ADD findings; it never changes the coverage denominator.</p>
      </div>
      <div class="panel">
        <h3>Reachable only by exploration (${e.explorationOnly.length})</h3>
        ${list(e.explorationOnly, "No finding in this record is attributed solely to exploration.")}
        <h3>The Tier 1 floor alone was sufficient (${e.floorOnlySufficient.length})</h3>
        ${list(e.floorOnlySufficient, "No finding is attributed to the floor alone.")}
        <h3>Found before any planned path ran (${e.foundBeforeAnyPath.length})</h3>
        ${list(e.foundBeforeAnyPath, "No finding was recorded before path execution began.")}
        ${e.analysis ? `<h3>Assessment</h3><p>${esc(e.analysis)}</p>` : ""}
        ${e.costNote ? `<p class="muted"><strong>Cost:</strong> ${esc(e.costNote)}</p>` : ""}
      </div>
    </section>`;
}

function renderNotVerifiable(view) {
  const nv = view.notVerifiable;
  const has = nv.items.length || nv.blockerFindings.length;

  const itemsBlock = nv.items.length
    ? `<div class="scroll-x"><table class="plain">
        <caption>Obligations a browser session could not settle</caption>
        <thead><tr><th scope="col">Obligation</th><th scope="col">Coverage status</th><th scope="col">Recorded reason</th></tr></thead>
        <tbody>${nv.items
          .map(
            (r) => `<tr>
              <th scope="row"><a class="idref" href="#row-${esc(r.item.itemId)}">${esc(r.item.itemId)}</a></th>
              <td>${coverageBadge(r.coverageStatus)}</td>
              <td>${esc(r.result?.reason?.summary || "")}<span class="sub mono">${esc(
                REASON_LABEL_FALLBACK(r.result?.reason?.code)
              )}</span></td>
            </tr>`
          )
          .join("")}</tbody></table></div>`
    : "";

  const blockerBlock = nv.blockerFindings.length
    ? `<h3>Blockers (${nv.blockerFindings.length})</h3>` + nv.blockerFindings.map((x) => renderFinding(x, view)).join("")
    : "";

  const mandates = nv.outOfBrowserScopeMandates || [];
  const mandateBlock = mandates.length
    ? `<h3>Document mandates declared out of browser scope (${mandates.length})</h3>
       <p class="muted">These are requirements the questionnaire imposes that a black-box browser session can never settle — data-file contents, server-side timing, panel identity. Extraction declared them out of scope <em>before</em> execution, so they are deliberately <strong>not</strong> in the ${esc(
         String(view.coverage.total)
       )}-obligation denominator: counting them would make coverage look worse, and pretending they passed would make it look better. Neither is done. They need a different test method.</p>
       <div class="scroll-x"><table class="plain">
        <caption>Out-of-browser-scope mandates — not in the coverage denominator</caption>
        <thead><tr><th scope="col">ID</th><th scope="col">Mandate</th><th scope="col">Why a browser cannot settle it</th><th scope="col">Browser proxy evidence</th></tr></thead>
        <tbody>${mandates
          .map(
            (m) => `<tr>
            <th scope="row"><span class="idref">${esc(m.id)}</span><span class="sub mono">${esc(m.sourceChunk || "")}</span></th>
            <td>${esc(m.mandate)}</td>
            <td>${esc(m.whyNotObservable)}</td>
            <td><span class="mono">${esc(m.browserProxyEvidence || "none")}</span></td>
          </tr>`
          )
          .join("")}</tbody></table></div>`
    : "";

  const cno = nv.couldNotObserve || [];
  const cnoBlock = cno.length
    ? `<h3>Other things this run could not observe (${cno.length})</h3>
       <p class="muted">Recorded by the executor as explicit gaps in what the run witnessed. Some are method limits; some are simply paths that were never walked.</p>
       <ul>${cno
         .map(
           (c) =>
             `<li><strong>${esc(typeof c === "string" ? c : c.item)}</strong>${
               typeof c === "string" ? "" : ` — ${esc(c.why)}`
             }</li>`
         )
         .join("")}</ul>`
    : "";

  const anything = has || mandateBlock || cnoBlock;

  return `<section id="not-verifiable" aria-labelledby="nv-h">
      <div class="section-head">
        <h2 id="nv-h">Not verifiable from the browser</h2>
        <p class="lead">Obligations that could not be settled by driving the live survey: blocked, proven unreachable, route not found, or stopped at a safety boundary. They are neither passes nor failures. Document mandates that were declared out of browser scope before the run are listed separately and are not in the denominator.</p>
      </div>
      <div class="panel">
        ${
          anything
            ? itemsBlock + blockerBlock + mandateBlock + cnoBlock
            : emptyState(
                "Every extracted obligation in this run was reachable from the browser.",
                "No obligation was recorded as blocked, proven-unreachable, route-not-found, or safety-stopped, and no blocker finding was asserted. Obligations that a browser can never settle (back-end quota logic, panel routing, data delivery) would be listed here."
              )
        }
      </div>
    </section>`;
}

/* ---------------------- Requirement Register ------------------------- *
 * The primary audit body. One row per document requirement in questionnaire
 * order (global/cross-cutting pinned first), expanding into the mandatory
 * execution cases a scoped rule materializes. Cells are never blank, coverage
 * and verdict never merge, and the two denominators are never summed.
 * ---------------------------------------------------------------------- */

function cellStateBadge(state, states, { strong = false } = {}) {
  const s = states[state];
  if (!s) {
    return `<span class="badge badge--warn"><span class="glyph" aria-hidden="true">!</span>Unrecognised cell state</span>`;
  }
  return `<span class="badge cell--${esc(s.tone)}${strong ? " badge--strong" : ""}" title="${esc(s.meaning)}"><span class="glyph" aria-hidden="true">${esc(
    s.glyph
  )}</span>${esc(s.label)}</span>`;
}

function chainBadge(chain) {
  if (!chain) return "";
  const bits = [];
  if (chain.catalogState === "hash-match") {
    bits.push(`<span class="chain chain--ok">sha256 matches the signed evidence catalogue</span>`);
  } else if (chain.catalogState === "name-match-only") {
    bits.push(`<span class="chain chain--warn">named in the catalogue, hash not compared</span>`);
  } else {
    bits.push(`<span class="chain chain--warn">not in the signed evidence catalogue</span>`);
  }
  if (chain.bytesState === "verified") bits.push(`<span class="chain chain--ok">bytes re-hashed at render time</span>`);
  else if (chain.bytesState === "mismatch")
    bits.push(`<span class="chain chain--bad">stored bytes do not match the signed hash — link withheld</span>`);
  else if (chain.bytesState === "missing") bits.push(`<span class="chain chain--warn">artifact bytes not present</span>`);
  else bits.push(`<span class="chain chain--muted">bytes not checked in this render</span>`);
  return bits.join(" ");
}

function witnessBlock(cellData) {
  const ev = cellData.evidence || [];
  const t = cellData.evidenceTotals || { supporting: 0, counter: 0, shown: 0 };
  if (!ev.length) {
    return `<p class="muted">No witness is attached to this cell. ${
      cellData.state === "PASS" || cellData.state === "FAIL"
        ? "A verdict with no cited evidence is reported as unsupported, never as a pass."
        : "Nothing was observed for this requirement, so there is nothing to cite."
    }</p>`;
  }
  const rows = ev
    .map((w) => {
      // Bounded on purpose. An audit report that inlines every captured value
      // becomes unopenable, so the bound is stated in words next to the excerpt
      // rather than applied silently.
      const values = (w.value || []).slice(0, 5);
      const more = (w.value || []).length - values.length;
      const excerpt = values.length
        ? `<pre class="excerpt" tabindex="0">${values.map((v) => esc(truncate(v, 300))).join("\n")}${
            more > 0 ? esc(`\n… ${more} more value(s) on this locator, not inlined`) : ""
          }</pre>`
        : `<span class="muted">no value captured on this locator</span>`;
      const reverify =
        w.judgeReverified === "verified"
          ? `<span class="chain chain--ok">re-read and re-verified by the judging engine</span>`
          : w.judgeReverified === "failed"
            ? `<span class="chain chain--bad">re-verification FAILED: ${esc(w.judgeReverifyReason || "no reason recorded")}</span>`
            : `<span class="chain chain--muted">not independently re-verified</span>`;
      const link = w.chain?.href ? ` <a href="${esc(w.chain.href)}">open artifact</a>` : "";
      return `<tr>
        <td><span class="badge cell--${w.role === "counter" ? "fail" : w.role === "route" ? "neutral" : "neutral"}"><span class="glyph" aria-hidden="true">${
          w.role === "counter" ? "✕" : w.role === "route" ? "→" : "·"
        }</span>${esc(w.role === "counter" ? "Counter-witness" : w.role === "route" ? "Route witness" : "Supporting witness")}</span></td>
        <td><span class="mono">${esc(w.artifact || "—")}</span>${link}<span class="sub mono">${esc(
          w.sha256 ? w.sha256.slice(0, 16) + "…" : "no hash on this witness"
        )}</span><span class="sub">${chainBadge(w.chain)}</span></td>
        <td><span class="mono">${esc(w.session || "—")}${w.seq === null || w.seq === undefined ? "" : ` @${esc(w.seq)}`}</span><span class="sub mono">${esc(
          w.locator || "no locator"
        )}</span></td>
        <td>${excerpt}${w.note ? `<span class="sub">${esc(w.note)}</span>` : ""}<span class="sub">${reverify}</span></td>
      </tr>`;
    })
    .join("");
  return `<p class="muted">${t.counter} counter-witness(es) and ${t.supporting} supporting witness(es) are attached to this cell; ${t.shown} are shown here. Counter-witnesses are listed first because they are the evidence a wrong pass ignores. Captured page text renders as inert escaped text and is never executed.</p>
    <div class="scroll-x"><table class="plain witness">
      <thead><tr><th scope="col">Role</th><th scope="col">Artifact and hash chain</th><th scope="col">Session / locator</th><th scope="col">Captured value</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

/**
 * The evidence chain for ONE cell. The document text and the compiled
 * expectation belong to the ROW, not the cell, so they live once in the row's
 * provenance drawer and are linked from here rather than repeated per column
 * and per case — a report nobody can open is not an audit.
 */
function cellDrill(row, colId, cellData, states, { compact = false } = {}) {
  const parts = [];

  parts.push(
    compact
      ? `<p class="muted">One execution case of <a class="idref" href="#row-${esc(row.itemId)}">${esc(
          row.itemId
        )}</a>. The document text, the compiled expectation and the row provenance are in that row's provenance drawer.</p>`
      : `<p class="muted">What the document requires, the source quote and the compiled expectation are in this row's <strong>Source provenance</strong> drawer. This drawer is what happened to it on the <strong>${esc(
          colId
        )}</strong> column.</p>`
  );

  parts.push(`<h4>Result on this run column</h4>
    <dl class="dl-grid">
      ${dt("Cell state", cellStateBadge(cellData.state, states))}
      ${dt("Coverage axis", cellData.coverage ? coverageBadge(cellData.coverage) : `<span class="muted">no coverage status recorded</span>`)}
      ${dt("Reason code", `<span class="mono">${esc(cellData.reasonCode || "none recorded")}</span>`)}
      ${dt("Reason", esc(cellData.reasonText || "none recorded"))}
      ${
        cellData.claimedVerdict
          ? dt("Verdict as recorded", `<span class="mono">${esc(cellData.claimedVerdict)}</span>`)
          : ""
      }
      ${
        cellData.wouldHaveBeen
          ? dt(
              "Withheld",
              `would have been <span class="mono">${esc(cellData.wouldHaveBeen)}</span> — withheld at ${cellData.blockedBy
                .map((b) => `<a class="idref" href="#lane-ambiguity">${esc(b)}</a>`)
                .join(", ")}`
            )
          : ""
      }
      ${dt("Path consistency", `<span class="mono">${esc(cellData.pathConsistency || "not recorded")}</span>`)}
      ${dt(
        "Re-check against cited evidence",
        `<span class="badge ${
          cellData.recheck.state === "re-checked"
            ? "cell--pass"
            : cellData.recheck.state === "re-check-failed"
              ? "cell--fail"
              : "cell--neutral"
        }"><span class="glyph" aria-hidden="true">${
          cellData.recheck.state === "re-checked" ? "✓" : cellData.recheck.state === "re-check-failed" ? "✕" : "·"
        }</span>${esc(
          cellData.recheck.state === "re-checked"
            ? "Re-checked against cited evidence"
            : cellData.recheck.state === "re-check-failed"
              ? "Re-check failed"
              : "Not re-checked"
        )}</span><span class="sub">${esc(cellData.recheck.note)}</span>`
      )}
    </dl>`);

  if (cellData.publicationGate && !cellData.publicationGate.publishable) {
    parts.push(`<h4>Publication gate</h4>
      <p class="muted">A recorded pass is published as a pass only when every condition below holds. Publication fails closed; attestation cannot rescue it.</p>
      <ul>${cellData.publicationGate.conditions
        .map(
          (c) =>
            `<li>${
              c.ok ? `<span class="chain chain--ok">yes</span>` : `<span class="chain chain--bad">no</span>`
            } <strong>${esc(c.label)}</strong> — ${esc(c.detail)} <span class="muted">${esc(c.why || "")}</span></li>`
        )
        .join("")}</ul>`);
  }

  if (cellData.incompleteCases?.length) {
    parts.push(`<h4>Mandatory cases with no terminal result</h4>
      <p class="muted">A requirement is fully tested only when EVERY mandatory case has a valid terminal observation. One required route not tested is INCOMPLETE, not mixed.</p>
      <ul>${cellData.incompleteCases
        .map((c) => `<li><span class="mono">${esc(c.label)}</span> — ${esc(states[c.state]?.label ?? c.state)}</li>`)
        .join("")}</ul>`);
  }

  if (cellData.divergenceSet?.length) {
    parts.push(`<h4>Divergence set — the routes that failed</h4>
      <ul>${cellData.divergenceSet
        .map((d) => `<li><span class="mono">${esc(d.label)}</span> — ${esc(d.why || "no reason recorded")}</li>`)
        .join("")}</ul>`);
  }

  if (cellData.state === "MIXED" && !compact) {
    parts.push(routeComparisonTable(row, colId, states));
  }

  parts.push(`<h4>Evidence chain</h4>${witnessBlock(cellData)}`);

  if (cellData.priorClaim && !compact) {
    const p = cellData.priorClaim;
    parts.push(`<h4>What the run itself claimed here</h4>
      <p>Prior verdict <span class="mono">${esc(p.priorVerdict || "none")}</span>. Shown for contrast only; it was never an input to the derived verdict.</p>
      ${p.priorObservationText ? `<pre class="excerpt" tabindex="0">${esc(p.priorObservationText)}</pre>` : ""}
      ${
        (p.citedArtifacts || []).length
          ? `<ul>${p.citedArtifacts
              .map(
                (a) =>
                  `<li><span class="mono">${esc(a.cited)}</span> — ${
                    a.problem
                      ? `<span class="chain chain--warn">${esc(a.problem)}</span>`
                      : `<span class="chain chain--ok">citation resolves</span>`
                  }</li>`
              )
              .join("")}</ul>`
          : `<p class="muted">The prior claim cited no artifact at all.</p>`
      }`);
  }

  return parts.join("");
}

function registerCell(row, col, cellData, states, { isChild = false, order = [] } = {}) {
  if (!cellData) {
    return `<td class="reg-cell"><span class="badge badge--warn"><span class="glyph" aria-hidden="true">!</span>No cell produced</span><span class="sub">A blank cell is a build failure; this one is reported rather than hidden.</span></td>`;
  }
  const s = states[cellData.state];
  // Publication state is a property of the COLUMN, not the cell: a diagnostic
  // or historical column never takes success styling, whatever it says.
  const pubClass = col.publication?.styling ? ` reg-cell--${esc(col.publication.styling)}` : "";
  const mixed = cellData.state === "MIXED" ? mixedCellSummary(row, col.id, states) : null;
  const worst = !isChild ? worstDescendantState(row, col.id, states, order) : null;
  const coverage = cellData.coverage
    ? `<span class="sub">${coverageBadge(cellData.coverage)}</span>`
    : `<span class="sub muted">coverage not recorded</span>`;
  const reason = cellData.reasonText
    ? `<span class="sub">${esc(truncate(cellData.reasonText, isChild ? 180 : 240))}</span>`
    : "";
  const code = cellData.reasonCode ? `<span class="sub mono">${esc(cellData.reasonCode)}</span>` : "";
  const cited = (cellData.evidence || [])
    .slice(0, 3)
    .map((w) => `<span class="idref">${esc(w.artifact || "?")}</span>`)
    .join(" ");
  const citedLine = (cellData.evidence || []).length
    ? `<span class="sub">Cited: ${cited}${
        (cellData.evidenceTotals?.supporting ?? 0) + (cellData.evidenceTotals?.counter ?? 0) > 3
          ? ` <span class="muted">+${
              (cellData.evidenceTotals.supporting ?? 0) + (cellData.evidenceTotals.counter ?? 0) - 3
            } more</span>`
          : ""
      }</span>`
    : (cellData.state === "PASS" || cellData.state === "FAIL")
      ? `<span class="sub"><span class="chain chain--bad">no evidence cited</span></span>`
      : "";
  const recheck =
    cellData.recheck.state === "re-checked"
      ? `<span class="sub"><span class="chain chain--ok">re-checked against cited evidence</span></span>`
      : cellData.recheck.state === "re-check-failed"
        ? `<span class="sub"><span class="chain chain--bad">re-check failed</span></span>`
        : `<span class="sub"><span class="chain chain--muted">not re-checked</span></span>`;
  const problems = (cellData.citationProblems || []).length
    ? `<span class="sub"><span class="chain chain--warn">${esc(
        cellData.citationProblems.map((p) => p.problem).join(", ")
      )}</span></span>`
    : "";
  const notes = (cellData.notes || []).map((n) => `<span class="sub">${esc(n)}</span>`).join("");

  const drill = `<details class="drill">
      <summary>Evidence chain — ${esc(s.label)}${
        cellData.evidenceTotals
          ? `, ${cellData.evidenceTotals.counter} counter / ${cellData.evidenceTotals.supporting} supporting`
          : ""
      }</summary>
      <div class="drill-body">${cellDrill(row, col.id, cellData, states, { compact: isChild })}</div>
    </details>`;

  return `<td class="reg-cell reg-cell--${esc(s.tone)}${pubClass}">
      ${cellStateBadge(cellData.state, states, { strong: !isChild })}
      ${mixed ? `<span class="sub mixed-line"><strong>${esc(mixed.line)}</strong></span>` : ""}
      ${
        worst
          ? `<span class="sub"><span class="chain chain--warn">worst state below this row: ${esc(
              states[worst].label
            )} — collapsing this row cannot hide it</span></span>`
          : ""
      }
      ${
        cellData.evidenceUnverified
          ? `<span class="sub"><span class="chain chain--bad">cited evidence did not re-verify</span></span>`
          : ""
      }
      ${
        col.publication && col.publication.current === false
          ? `<span class="sub muted">${esc(col.publication.styling === "historical" ? "historical — not a current result" : "diagnostic — not a current result")}</span>`
          : ""
      }
      ${coverage}${code}${reason}${notes}${citedLine}${recheck}${problems}
      ${drill}
    </td>`;
}

function truncate(s, n) {
  const t = String(s ?? "");
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

function scoreableCases(row) {
  return (row.cases || []).filter((c) => !c.leaf);
}

function caseRollup(row, colId, states) {
  if (row.expansion?.established === false) {
    return `<span class="sub"><span class="chain chain--warn">mandatory-case count not established</span></span>`;
  }
  const cases = scoreableCases(row);
  if (!cases.length) {
    return `<span class="sub muted">1 mandatory case — this row is its own case</span>`;
  }
  const counts = new Map();
  for (const c of cases) {
    const st = c.cellsByColumn[colId]?.state ?? "NOT_ASSESSED";
    counts.set(st, (counts.get(st) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([st, n]) => `<span class="rollup">${esc(states[st].glyph)} ${esc(states[st].label)} ×${n}</span>`)
    .join(" ");
}

/**
 * AMENDMENT A: "A collapsed parent inherits its worst descendant state and can
 * never appear green while hiding a problem."
 */
function worstDescendantState(row, colId, states, order) {
  const cases = scoreableCases(row);
  if (!cases.length) return null;
  let worst = null;
  for (const c of cases) {
    const st = c.cellsByColumn[colId]?.state;
    if (!st) continue;
    if (worst === null || order.indexOf(st) < order.indexOf(worst)) worst = st;
  }
  if (!worst) return null;
  const parentState = row.cellsByColumn[colId]?.state;
  // Only interesting when the descendant is WORSE than the parent's own state.
  if (parentState && order.indexOf(worst) >= order.indexOf(parentState)) return null;
  void states;
  return worst;
}

/**
 * The mixed cell, in Amendment A's words: primary verdict first, qualifying
 * state second, and NEVER "usually works" — test frequency is not respondent
 * incidence.
 */
function mixedCellSummary(row, colId, states) {
  const cases = scoreableCases(row);
  const matched = cases.filter((c) => c.cellsByColumn[colId]?.state === "PASS").length;
  const diverged = cases.filter((c) => {
    const s = c.cellsByColumn[colId]?.state;
    return s === "FAIL" || s === "MIXED";
  }).length;
  const untested = cases.filter((c) => {
    const s = c.cellsByColumn[colId]?.state;
    return s && states[s].countsAs !== "pass" && states[s].countsAs !== "fail";
  }).length;
  return {
    matched,
    diverged,
    untested,
    line: `FAIL — behaviour changed by route · ${matched} tested route${matched === 1 ? "" : "s"} matched · ${diverged} tested route${
      diverged === 1 ? "" : "s"
    } diverged${untested ? ` · ${untested} required route${untested === 1 ? "" : "s"} not settled` : ""}`,
  };
}

/** Respondent route | document requires | survey did | result. */
function routeComparisonTable(row, colId, states) {
  const cases = scoreableCases(row).filter((c) => c.routeRow);
  if (!cases.length) return "";
  const rows = cases
    .map((c) => {
      const cd = c.cellsByColumn[colId];
      const observed = Object.entries(c.routeRow.destinations || {})
        .map(([d, i]) => `${d} ×${i.count ?? i}`)
        .join(", ");
      const required = row.compiled?.expectation?.destination ?? null;
      return `<tr>
        <th scope="row">${esc(c.label)}</th>
        <td>${
          required
            ? `<span class="mono">${esc(required)}</span>`
            : `<span class="muted">the document states no destination for this route</span>`
        }<span class="sub muted">from: ${esc(row.expansion.source ?? row.expansion.rule)}</span></td>
        <td><span class="mono">${esc(observed || "no recorded destination")}</span><span class="sub">${esc(
          String(c.observations ?? 0)
        )} observation(s)</span></td>
        <td>${cd ? cellStateBadge(cd.state, states) : `<span class="muted">no cell</span>`}<span class="sub">${esc(
          cd?.reasonText || ""
        )}</span></td>
      </tr>`;
    })
    .join("");
  return `<h4>Route comparison</h4>
    <p class="muted">One row per mandatory route. "Tested routes" counts the routes this run walked; it is not a statement about how many respondents take them.</p>
    <div class="scroll-x"><table class="plain">
      <thead><tr><th scope="col">Respondent route</th><th scope="col">Document requires</th><th scope="col">Survey did</th><th scope="col">Result</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function renderRegister(view, { defer } = {}) {
  const reg = view.register;
  const states = reg.cellStates;
  const cols = reg.columns;
  const dr = reg.denominators.documentRequirements;
  const ec = reg.denominators.executionCases;
  const auditByItem = new Map(view.audit.rows.map((r) => [r.item.itemId, r]));

  const colHeaders = cols
    .map(
      (c) => `<th scope="col" class="reg-col reg-col--${esc(c.publication?.styling ?? "unknown")}">
        <span class="colname">${esc(c.label)}</span>
        <span class="sub">${esc(c.subtitle)}</span>
        ${c.publication ? `<span class="sub"><strong>${esc(c.publication.statement)}</strong></span>` : ""}
        <details class="colmeta"><summary>column identity</summary>
          <dl class="dl-grid">
            ${dt(
              "Contract revision",
              c.contractRevisionId
                ? `<span class="mono">${esc(c.contractRevisionId)}</span>`
                : `<span class="chain chain--warn">${esc(c.contractRevisionNote || "no sealed contract revision")}</span>`
            )}
            ${dt("Contract hash", `<span class="hash">${esc(c.contractHash || "not recorded")}</span>`)}
            ${dt("Document hash", `<span class="hash">${esc(c.documentHash || "not recorded")}</span>`)}
            ${dt("Target build", `<span class="idref">${esc(c.targetBuildId || "not recorded")}</span><span class="sub hash">${esc(c.targetBuildHash || "")}</span>`)}
            ${dt("Profile / config hash", `<span class="idref">${esc(c.profileId || "—")}</span><span class="sub hash">${esc(c.configurationHash || "")}</span>`)}
            ${dt("Device / locale", esc(`${c.device} · ${c.locale}`))}
            ${dt("Result policy", `<span class="mono">${esc(c.resultPolicyVersion || "not recorded")}</span>`)}
            ${dt("Observed at", esc(fmtDateTime(c.observedAt)))}
          </dl>
          <p class="muted">${esc(c.caveat)}</p>
        </details>
      </th>`
    )
    .join("");

  const legend = Object.entries(states)
    .map(
      ([k, s]) =>
        `<li>${cellStateBadge(k, states)} <span class="mono">${esc(k)}</span> — ${esc(s.meaning)} <span class="muted">Counts as: ${esc(
          s.countsAs === "none" ? "neither pass nor fail" : s.countsAs
        )}.</span></li>`
    )
    .join("");

  const groupsHtml = reg.groups
    .map((g) => {
      const head = `<tbody class="reg-sectionhead"><tr><th colspan="${
        3 + cols.length
      }" scope="colgroup">${esc(g.label)} <span class="muted">— ${g.rows.length} requirement${
        g.rows.length === 1 ? "" : "s"
      }${g.pinned ? ", pinned first because a global rule governs every screen" : ", in document order"}</span></th></tr></tbody>`;

      const bodies = g.rows
        .map((row) => {
          const audit = auditByItem.get(row.itemId);
          // A parent is expanded by default when it, or any of its own cases,
          // is unresolved. Collapsing is allowed but can never hide
          // incompleteness: the parent row always carries the case rollup.
          const unresolved = cols.some((c) => {
            const st = row.cellsByColumn[c.id]?.state;
            return st && states[st].countsAs !== "pass" && st !== "NOT_IN_CONTRACT";
          });
          const childCases = scoreableCases(row);
          const caseUnresolved = childCases.some((k) =>
            cols.some((c) => {
              const st = k.cellsByColumn[c.id]?.state;
              if (!st) return false;
              return states[st].countsAs === "fail" || states[st].countsAs === "withheld" || st === "NOT_REACHED";
            })
          );
          const hasCases = childCases.length > 0;
          const openByDefault = hasCases && (unresolved || caseUnresolved);
          const toggleId = `tg-${row.itemId}`;

          const toggle = hasCases
            ? `<label class="reg-toggle-wrap" for="${esc(toggleId)}">
                 <input type="checkbox" class="reg-toggle" id="${esc(toggleId)}"${openByDefault ? " checked" : ""}>
                 <span class="reg-toggle-face" aria-hidden="true">▸</span>
                 <span class="sr-only">Show the ${childCases.length} mandatory execution case(s) for ${esc(row.itemId)}</span>
               </label>`
            : "";

          const flags = [];
          for (const a of row.ambiguities) {
            flags.push(
              `<a class="flagref flagref--amb" href="#lane-ambiguity">${esc(a.ambiguityId)}<span class="sub mono">${esc(
                a.strength
              )}</span></a>`
            );
          }
          for (const e of reg.lanes.byId["contract-gap"].entries) {
            if ((e.relatedRows || []).includes(row.itemId)) {
              flags.push(`<a class="flagref flagref--gap" href="#lane-contract-gap">${esc(e.id)}</a>`);
            }
          }
          for (const e of reg.lanes.byId["taxonomy-gap"].entries) {
            if ((e.relatedRows || []).includes(row.itemId)) {
              flags.push(`<a class="flagref flagref--tax" href="#lane-taxonomy-gap">${esc(e.id)}</a>`);
            }
          }
          for (const id of row.findingRefs) {
            flags.push(`<a class="flagref" href="#finding-${esc(id)}">${esc(id)}</a>`);
          }
          if (row.notBrowserObservable) {
            flags.push(`<a class="flagref flagref--nbo" href="#not-verifiable">not browser-observable</a>`);
          }

          const parent = `<tr class="reg-parent${row.pinned ? " reg-parent--pinned" : ""}" id="row-${esc(row.itemId)}">
            <th scope="row" class="reg-id">
              ${toggle}
              <span class="idref">${esc(row.itemId)}</span>
              <span class="sub mono">${esc(row.identity.versionId)}</span>
              <span class="sub mono">${esc(row.identity.semanticFingerprint)}</span>
              <span class="sub muted">provisional lineage id</span>
            </th>
            <td class="reg-req">
              <span class="req">${esc(row.requirement || "—")}</span>
              <span class="sub"><strong>Expected observable:</strong> ${esc(truncate(row.expectedObservable, 220))}</span>
              ${row.stimulus ? `<span class="sub"><strong>Stimulus:</strong> ${esc(truncate(row.stimulus, 140))}</span>` : ""}
              <details class="prov"><summary>Source provenance</summary>
                <dl class="dl-grid">
                  ${dt("Locator", `<span class="mono">${esc(row.sourceAnchor?.locator || "not recorded")}</span>`)}
                  ${dt("Category", `<span class="mono">${esc(row.category || "—")}</span>`)}
                  ${dt("Scope", `<span class="mono">${esc(row.scopeKind)}</span>`)}
                  ${dt("Extraction confidence", `<span class="num">${esc(fmtConfidence(row.extractionConfidence))}</span>`)}
                  ${dt("Requirement version", `<span class="mono">${esc(row.identity.versionId)}</span>`)}
                  ${dt("Semantic fingerprint", `<span class="mono">${esc(row.identity.semanticFingerprint)}</span>`)}
                  ${dt(
                    "Attempts / evidence",
                    `<span class="num">${esc(String(audit?.attemptCount ?? 0))} / ${esc(String(audit?.evidenceCount ?? 0))}</span>`
                  )}
                  ${
                    row.compiled
                      ? dt("Expectation kind", `<span class="mono">${esc(row.compiled.expectationKind || "none compiled")}</span>`) +
                        dt("Compiler rule", `<span class="idref">${esc(row.compiled.compiledBy || "—")}</span>`) +
                        dt("Predicate", `<span class="mono">${esc(row.compiled.predicateId || "none")}</span>`) +
                        dt("Predicate outcome", `<span class="mono">${esc(row.compiled.predicateOutcome || "none")}</span>`) +
                        dt("Predicate detail", `<span class="mono">${esc(JSON.stringify(row.compiled.predicateDetail ?? null))}</span>`) +
                        dt("Evidence scope", `<span class="mono">${esc(JSON.stringify(row.compiled.evidenceScope ?? null))}</span>`)
                      : dt(
                          "Compiled expectation",
                          `<span class="muted">no typed expectation was compiled for this requirement</span>`
                        )
                  }
                </dl>
                ${row.sourceAnchor?.quote ? `<pre class="excerpt" tabindex="0">${esc(row.sourceAnchor.quote)}</pre>` : ""}
                <p class="muted">Row identity is provisional: RunRecord v1.0.0 has no minted <span class="mono">requirementLineageId</span>, so the item id stands in and is labelled as such. Durable identity is never derived from a question number, a row position, or a quote.</p>
              </details>
            </td>
            <td class="reg-scope">
              ${
                row.pinned
                  ? `<span class="badge cell--neutral badge--strong"><span class="glyph" aria-hidden="true">◎</span>Global rule</span>`
                  : `<span class="badge cell--neutral"><span class="glyph" aria-hidden="true">·</span>${esc(row.scopeKind)}</span>`
              }
              ${
                row.expansion.established === false
                  ? `<span class="sub"><span class="chain chain--warn">mandatory execution cases: NOT ESTABLISHED</span></span>`
                  : `<span class="sub"><strong>${esc(String(row.expansion.mandatoryCases))}</strong> mandatory execution case${
                      row.expansion.mandatoryCases === 1 ? "" : "s"
                    }</span><span class="sub muted">materialized from: ${esc(row.expansion.source ?? row.expansion.rule)}</span>`
              }
              <span class="sub mono">${esc(row.expansion.rule)}</span>
              ${cols
                .map(
                  (c) =>
                    `<span class="sub"><span class="rollup-col">${esc(c.label)}:</span> ${caseRollup(row, c.id, states)}</span>`
                )
                .join("")}
              ${
                row.expansion.note
                  ? `<details class="prov"><summary>expansion basis</summary><p>${esc(row.expansion.basis)}</p><p>${esc(
                      row.expansion.note
                    )}</p></details>`
                  : `<span class="sub muted">${esc(row.expansion.basis)}</span>`
              }
            </td>
            ${cols.map((c) => registerCell(row, c, row.cellsByColumn[c.id], states, { order: view.register.cellStateOrder })).join("")}
            <td class="reg-flags">${flags.length ? flags.join(" ") : `<span class="muted">none</span>`}</td>
          </tr>`;

          // The single implicit case of a single-locus requirement is identical
          // to its parent by construction. It exists in the model so every case
          // lands in exactly one bucket; rendering it again would double the
          // table for no information.
          const children = childCases
            .map(
              (k) => `<tr class="reg-child">
                <th scope="row" class="reg-id"><span class="childmark" aria-hidden="true">└</span><span class="idref">${esc(
                  k.caseId
                )}</span></th>
                <td class="reg-req">
                  <span class="req">${esc(k.label)}</span>
                  <span class="sub">${esc(k.basis)}</span>
                  ${
                    k.routeRow
                      ? `<span class="sub mono">observed ${esc(k.routeRow.question)} → ${esc(
                          Object.entries(k.routeRow.destinations || {})
                            .map(([d, i]) => `${d} ×${i.count ?? i}`)
                            .join(", ")
                        )}</span>`
                      : ""
                  }
                </td>
                <td class="reg-scope"><span class="sub muted">execution case</span>${
                  k.observations !== null && k.observations !== undefined
                    ? `<span class="sub num">${esc(String(k.observations))} observation(s)</span>`
                    : ""
                }</td>
                ${cols
                  .map((c) => registerCell(row, c, k.cellsByColumn[c.id], states, { isChild: true, order: view.register.cellStateOrder }))
                  .join("")}
                <td class="reg-flags"><span class="muted">—</span></td>
              </tr>`
            )
            .join("");

          return `<tbody class="reg-group">${parent}${children}</tbody>`;
        })
        .join("");

      return head + bodies;
    })
    .join("");

  const denomTiles = `<div class="tiles">
      ${tile({
        label: "Document requirements",
        value: fmtInt(dr.total),
        denom: `rows in the sealed contract${dr.retired ? ` · ${dr.retired} retired, still shown` : ""}${
          dr.proposed ? ` · ${dr.proposed} proposed and pending adjudication` : ""
        }`,
      })}
      ${tile({
        label: "Mandatory execution cases",
        value: fmtInt(ec.total),
        denom: `cases a run must exercise · ${ec.enumerated} enumerated here from ${ec.fromExpansion} expanded rule(s)${
          ec.notEstablished.rows ? ` · ${ec.notEstablished.rows} requirement(s) have no established case count` : ""
        }`,
      })}
      ${cols
        .map((c) => {
          const roll = dr.byColumn[c.id].roll;
          return tile({
            label: `${c.label} — requirement outcomes`,
            value: `${roll.fail} fail`,
            denom: `of ${dr.total} document requirements · ${roll.pass} pass · ${roll.withheld} withheld · ${roll.none} no verdict<br>${
              c.publication?.current ? "current result" : "NOT a current result — " + esc(c.publication?.styling ?? "unpublishable")
            }`,
            modifier: c.publication?.current ? (roll.fail > 0 ? "tile--flag" : "") : "tile--historical",
          });
        })
        .join("")}
    </div>`;

  const withheldTotals = cols
    .map((c) => {
      const roll = dr.byColumn[c.id].roll;
      return `<li><strong>${esc(c.label)}:</strong> ${roll.withheld} row(s) withheld — not counted as pass or fail. ${roll.none} row(s) carry no verdict at all.</li>`;
    })
    .join("");

  const caseCounts = cols
    .map((c) => {
      const st = ec.byColumn[c.id].states;
      const present = view.register.cellStateOrder.filter((k) => st[k] > 0);
      return `<li><strong>${esc(c.label)}:</strong> ${
        present.length
          ? present.map((k) => `${esc(states[k].label)} ${st[k]}`).join(" · ")
          : "no enumerated case results in this column"
      }</li>`;
    })
    .join("");

  return `<section id="register" aria-labelledby="reg-h">
      <div class="section-head">
        <p class="kicker">The deliverable</p>
        <h2 id="reg-h">Requirement register</h2>
        <p class="lead">Every requirement the document imposes, in questionnaire order with global rules pinned first, and what each run did to it. This table is a <strong>projection</strong> of the signed records — it is never edited, and scoring never reads it. A miss is visible because the row is still here with an explicit state; no cell is ever blank.</p>
      </div>

      <div class="panel">
        <h3>Two denominators, reported separately</h3>
        <p class="muted">${esc(view.register.denominatorGuard.statement)}</p>
        ${denomTiles}
        <dl class="dl-grid">
          ${dt("Document requirements", esc(dr.definition))}
          ${dt("Mandatory execution cases", esc(ec.definition))}
        </dl>
        <h3>Withheld from pass/fail</h3>
        <ul>${withheldTotals}</ul>
        <h3>Execution-case outcomes (separate total, never added to the row total)</h3>
        <ul>${caseCounts}</ul>
      </div>

      <details class="panel">
        <summary>Cell-state legend — every state, what it means, and how it counts</summary>
        <p class="muted">Coverage and verdict are two axes and are never merged into one badge. Colour is never the only signal: every state carries a glyph and a full-word label, and <em>exercised</em> is deliberately neutral, never success green. States with a zero count are still listed, so a reader can see which dispositions exist.</p>
        <ul class="legend">${legend}</ul>
        <h3>Coverage axis (rendered alongside every cell state)</h3>
        <ul class="legend">${COVERAGE_ORDER.map((k) => `<li>${coverageBadge(k)} ${esc(COVERAGE_MEANING[k])}</li>`).join("")}</ul>
      </details>

      <p class="table-note"><strong>Showing all ${dr.total} of ${dr.total} document requirements · 0 hidden by filters.</strong> No filter is applied to this rendering, and headline totals always reflect the full register whatever is on screen. Print and export expand every row.</p>
      <p class="table-note">${dr.total} document requirements and ${ec.enumerated} enumerated execution cases across ${
        cols.length
      } run column${
        cols.length === 1 ? "" : "s"
      }. Scroll sideways inside the box below; the page itself never scrolls sideways. Parent rows with an unresolved case are expanded by default, and a collapsed parent inherits its worst descendant state — collapsing can never make a row look clean while hiding a problem. ${esc(
        reg.groupingBasis
      )}</p>
      ${
        reg.publication.hasCurrentResults
          ? ""
          : `<p class="table-note"><span class="chain chain--warn">No column in this table is a current result.</span> ${esc(
              reg.publication.statement
            )}</p>`
      }
      ${deferBlock(
        `<div class="scroll-x">
        <table class="register">
          <caption class="sr-only">Requirement register: ${dr.total} document requirements, ${
            ec.enumerated
          } enumerated execution cases, ${cols.length} run column${cols.length === 1 ? "" : "s"}.</caption>
          <thead>
            <tr>
              <th scope="col" class="reg-col-id">Requirement ID</th>
              <th scope="col">Requirement</th>
              <th scope="col">Scope and mandatory cases</th>
              ${colHeaders}
              <th scope="col">Flags</th>
            </tr>
          </thead>
          ${groupsHtml}
        </table>
      </div>`,
        {
          id: "audit-register",
          defer,
          label: `The full ${dr.total}-row audit table opens with this tab. It is stored compressed inside this file — nothing is fetched from anywhere.`,
          fallback:
            "This table needs the browser's scripting to unpack. Every requirement, its result and its evidence are also in the Full check tab, which needs no scripting.",
        }
      )}
    </section>`;
}

function renderRegisterDelta(view) {
  const d = view.register.delta;
  if (!d.present) {
    return `<section id="delta" aria-labelledby="delta-h">
      <div class="section-head"><h2 id="delta-h">Before and after the judgement fix</h2></div>
      ${emptyState(
        "No re-derived verdict bundle was supplied for this run.",
        "The register therefore shows a single run column: the verdicts as the run itself wrote them. Where a derived-verdict bundle exists, a second column appears beside it and every changed row is listed here."
      )}
    </section>`;
  }
  const s = d.summary || {};
  const rows = d.changed
    .map(
      (r) => `<tr>
      <th scope="row"><a class="idref" href="#row-${esc(r.itemId)}">${esc(r.itemId)}</a></th>
      <td>${esc(truncate(r.requirement, 160))}</td>
      <td><span class="mono">${esc(r.priorVerdict || "none")}</span><span class="sub mono">cited ${esc(
        r.priorClaimedEvidence || "nothing"
      )}</span></td>
      <td>${cellStateBadge(r.derivedState || "NOT_ASSESSED", view.register.cellStates)}<span class="sub mono">${esc(
        r.derivedReason || ""
      )}</span>${
        r.withheld
          ? `<span class="sub">would have been <span class="mono">${esc(r.withheld.wouldHaveBeen)}</span>, withheld at ${esc(
              (r.withheld.blockedBy || []).join(", ")
            )}</span>`
          : ""
      }</td>
      <td>${
        r.citationProblems.length
          ? r.citationProblems.map((p) => `<span class="chain chain--warn">${esc(p.problem)}</span>`).join(" ")
          : `<span class="muted">none</span>`
      }</td>
    </tr>`
    )
    .join("");

  return `<section id="delta" aria-labelledby="delta-h">
      <div class="section-head">
        <p class="kicker">Same evidence, different judging stage</p>
        <h2 id="delta-h">Before and after the judgement fix</h2>
        <p class="lead">${esc(
          d.note || "Prior verdicts are shown for contrast only; they were never an input to the derived verdict."
        )}</p>
      </div>
      <div class="panel">
        <div class="tiles">
          ${tile({ label: "Requirements re-judged", value: fmtInt(s.obligations), denom: "every row in the sealed contract" })}
          ${tile({
            label: "Rows whose disposition changed",
            value: fmtInt(s.changed),
            denom: `of ${esc(String(s.obligations ?? "?"))} document requirements`,
            modifier: "tile--warn",
          })}
          ${tile({
            label: "Prior passes that are no longer passes",
            value: fmtInt(s.priorPassNowNotPass),
            denom: "each one was a verdict the run wrote about its own evidence",
            modifier: "tile--flag",
          })}
          ${tile({
            label: "Citation problems found",
            value: fmtInt(s.citationProblems),
            denom: "prior claims citing a derived summary instead of primary evidence",
            modifier: "tile--warn",
          })}
        </div>
        <p>The failure the first run's debrief identified was not coverage: the browser captured the divergence on disk and the verdict-writing step then wrote the opposite. These rows are that failure, made visible against exactly the same artifacts.</p>
        <div class="scroll-x"><table class="plain">
          <caption>${d.changed.length} requirement(s) changed disposition when the verdict was derived instead of authored.</caption>
          <thead><tr>
            <th scope="col">Requirement</th><th scope="col">What it requires</th>
            <th scope="col">As the run wrote it</th><th scope="col">As re-derived from the artifacts</th>
            <th scope="col">Citation problems in the prior claim</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
    </section>`;
}

/**
 * WHY THIS NUMBER IS NOT THE NUMBER ON THE SUMMARY.
 *
 * A blocker list counts BLOCKER RECORDS; the customer views count REQUIREMENTS
 * and QUESTIONS. The shipped build let all three float free — "19 questions for
 * you" on the fold, "11" in the closing panel, "Unresolved ambiguity in the
 * document 62" here — and a reader who noticed had no way to tell which was
 * wrong. (One was: 62 was every judging-stage blocker relabelled as an
 * ambiguity. That is fixed at source in lib/register.mjs.)
 *
 * Where a class maps onto requirements the reader has already been given a
 * count for, the relationship is now stated in the same place as the number.
 */
function countReconciliation(kind, list, view) {
  if (kind !== "unresolved-ambiguity") return "";
  const refs = new Set(list.map((b) => b.ref).filter((r) => typeof r === "string" && r.startsWith("OBL-")));
  const questions = view.documentQuestions?.ambiguities?.length ?? 0;
  if (!refs.size && !questions) return "";
  return `<p class="muted">These are ${list.length} blocker record${list.length === 1 ? "" : "s"}, not ${
    list.length === 1 ? "one requirement" : "requirements"
  }: they land on <strong>${refs.size}</strong> requirement${refs.size === 1 ? "" : "s"}${
    questions
      ? `, and the Summary asks the reader <strong>${questions}</strong> question${questions === 1 ? "" : "s"} to resolve them`
      : ""
  }. One question can withhold several requirements, and one requirement can be withheld by several records.</p>`;
}

function renderCertification(view) {
  const c = view.register.certification;
  if (!c.known) {
    return `<div class="banner banner--neutral" role="status">
        <span class="banner-flag">Certification</span>
        <h2>Certification state unknown</h2>
        <p>No adjudication stage ran for this record, so this report makes no certification claim either way. Absence of a blocker is not a clearance.</p>
      </div>`;
  }
  /* ---- D7: FINALITY and DEFECT-FREEDOM are reported SEPARATELY.
   * A final report may truthfully report failures. Saying "cannot be certified"
   * over a run that finished its work and found three bugs conflates "we did not
   * finish" with "we found problems", which are opposite messages. */
  const defectLine =
    c.defectCount > 0
      ? `<p><strong>${c.defectCount} requirement${c.defectCount === 1 ? "" : "s"} failed.</strong> Failures are the report's content, not an obstacle to issuing it: ${c.defectRefs
          .slice(0, 8)
          .map((r) => `<a class="idref" href="#row-${esc(r)}">${esc(r)}</a>`)
          .join(", ")}${c.defectRefs.length > 8 ? ` and ${c.defectRefs.length - 8} more` : ""}.</p>`
      : "";

  if (c.final) {
    return `<div class="banner banner--neutral" role="status">
        <span class="banner-flag">Report status</span>
        <h2>${
          c.defectFree
            ? "Final — every requirement settled, and none failed"
            : `Final — every requirement settled; ${c.defectCount} failed`
        }</h2>
        <p>Every requirement in the current column reached a state its evidence supports, and no process blocker remains, so this report is FINAL.${
          c.defectFree
            ? " No requirement failed. That is a statement about the requirements in this contract on the routes that were exercised; it is not a claim that the site is correct — read the register."
            : " That a report is final and that a run found no defects are two different facts, and this one is final WITH failures."
        }</p>
        ${defectLine}
        <p class="muted">${esc(c.finalityRule)}</p>
      </div>`;
  }
  const opBlockers = c.blockers.filter((b) => b.kind === "operational-blocker");
  const byKind = new Map();
  for (const b of c.finalityBlockers) {
    if (!byKind.has(b.kind)) byKind.set(b.kind, []);
    byKind.get(b.kind).push(b);
  }
  return `<div class="banner banner--warn" role="alert">
      <span class="banner-flag">Report status</span>
      <h2>Not final — ${c.finalityBlockers.length} unresolved item${
        c.finalityBlockers.length === 1 ? "" : "s"
      }${c.defectCount ? `, and ${c.defectCount} requirement${c.defectCount === 1 ? "" : "s"} failed` : ""}</h2>
      <p>The items below are not all the same kind of thing, and only one kind of them is a neutral matter for human adjudication. Each states what it is and what would close it.</p>
      ${defectLine}
      <p class="muted">${esc(c.rule)}</p>
      ${
        opBlockers.length
          ? `<p><strong>Operational blockers come first:</strong> a survey that cannot be opened, driven or completed makes every other blocker academic. They are certification blockers even though they sit outside the document-derived denominator.</p>`
          : ""
      }
      ${[...byKind.entries()]
        .map(
          ([kind, list]) => `<div class="blocker-class">
          <h3>${esc(list[0].nature ?? kind)} <span class="pill">${list.length}</span></h3>
          ${countReconciliation(kind, list, view)}
          <p class="muted"><strong>What closes it:</strong> ${esc(list[0].remedy ?? "Adjudication by a reviewer.")}${
            list[0].neutralForScoring === false
              ? " <strong>This is not neutral for scoring: it counts against the run.</strong>"
              : " Neutral for scoring while it stands."
          }</p>
          <ul>${list
            .map(
              (b) =>
                `<li><span class="mono">${esc(b.kind)}</span> · <a class="idref" href="${
                  b.kind === "operational-blocker" ? `#op-${esc(b.ref)}` : `#row-${esc(b.ref)}`
                }">${esc(b.ref)}</a> — ${esc(b.detail)}${b.basis ? ` <span class="muted">(${esc(b.basis)})</span>` : ""}</li>`
            )
            .join("")}</ul>
        </div>`
        )
        .join("")}
      ${
        c.integrity.length
          ? `<p><strong>Recorded integrity events (disclosed, not repaired silently):</strong></p><ul>${c.integrity
              .map(
                (i) =>
                  `<li><span class="mono">${esc(i.code)}</span> — ${esc(
                    i.detail || i.reference || ""
                  )}</li>`
              )
              .join("")}</ul>`
          : ""
      }
    </div>`;
}

function renderFlagLanes(view) {
  const lanes = view.register.lanes;
  const sections = lanes.order
    .map((id) => {
      const lane = lanes.byId[id];
      const n = lane.entries.length;
      const body = n
        ? lane.entries.map((e) => renderLaneEntry(lane, e, view)).join("")
        : emptyState(lane.emptyTitle, esc(lane.emptyBody));
      return `<div class="lane lane--${esc(lane.tone)}" id="lane-${esc(id)}">
          <div class="lane-head">
            <h3><span class="lane-glyph" aria-hidden="true">${esc(lane.glyph)}</span>${esc(lane.label)}</h3>
            <span class="pill">${n} entr${n === 1 ? "y" : "ies"}</span>
          </div>
          <p class="lane-blurb">${esc(lane.blurb)}</p>
          <p class="lane-effect"><strong>Effect on scoring:</strong> ${esc(lane.scoring)}${
            lane.canBecomeRow
              ? " This is the only lane whose entries can become register rows, and only through an explicit contract revision."
              : " Entries in this lane can never become register rows."
          }</p>
          ${
            lane.cap
              ? `<p class="muted">Cap ${lane.cap.cap}, used ${lane.cap.used}. ${esc(lane.cap.note)}</p>`
              : ""
          }
          <p class="muted">Source: ${esc(lane.source.join("; "))}.</p>
          ${body}
        </div>`;
    })
    .join("");

  const sidecar = lanes.sidecar.present
    ? `<div class="banner banner--info" role="status">
        <span class="banner-flag">Unsigned sidecar</span>
        <p>Some lane entries come from a reviewer-supplied sidecar${
          lanes.sidecar.path ? ` (<span class="mono">${esc(lanes.sidecar.path)}</span>)` : ""
        }. ${esc(lanes.sidecar.note)}</p>
      </div>`
    : `<p class="muted">No sidecar was supplied. Every entry below is derived from the signed record and the derived-verdict bundle.</p>`;

  return `<section id="flag-lanes" aria-labelledby="lanes-h">
      <div class="section-head">
        <p class="kicker">Everything that is not a row</p>
        <h2 id="lanes-h">Flag lanes</h2>
        <p class="lead">"Flag other stuff" is four separate lanes, not one bucket, because they have four different effects on the result. They are a permanent section of this report and are never folded into the findings list: a taxonomy gap and a site oddity are not findings, and treating them as one is how a report starts lying.</p>
      </div>
      ${sidecar}
      <div class="lanes">${sections}</div>
    </section>`;
}

function renderLaneEntry(lane, e, view) {
  const rowLinks = (e.relatedRows || []).length
    ? (e.relatedRows || [])
        .slice(0, 14)
        .map((r) => `<a class="idref" href="#row-${esc(r)}">${esc(r)}</a>`)
        .join(" ") + ((e.relatedRows || []).length > 14 ? ` <span class="muted">+${e.relatedRows.length - 14} more</span>` : "")
    : `<span class="muted">no register row is affected</span>`;

  const atoms = (e.sourceAtoms || [])
    .map(
      (a) => `<div class="atom">
        <dl class="dl-grid">
          ${dt("Block", `<span class="mono">${esc(a.blockId)}</span>`)}
          ${dt("Kind / role", `<span class="mono">${esc(a.kind)} · ${esc(a.role)}</span>`)}
          ${dt("Location", `<span class="mono">${esc(a.lines)}</span>`)}
          ${dt("Atom text hash", `<span class="hash">${esc(a.atomTextHash)}</span>`)}
        </dl>
        <pre class="excerpt" tabindex="0">${esc(a.quote)}</pre>
      </div>`
    )
    .join("");

  return `<article class="lane-entry" id="flag-${esc(e.id)}">
      <div class="lane-entry-head">
        <h4><span class="idref">${esc(e.id)}</span> ${esc(e.title || "")}</h4>
        ${
          e.adjudication
            ? `<span class="badge ${
                e.adjudication === "pending" ? "cell--amb" : "cell--neutral"
              }"><span class="glyph" aria-hidden="true">${e.adjudication === "pending" ? "!" : "·"}</span>${esc(
                e.adjudication
              )}</span>`
            : ""
        }
        ${e.sidecar ? `<span class="badge cell--neutral"><span class="glyph" aria-hidden="true">·</span>sidecar</span>` : ""}
        ${
          e.blocksCertification
            ? `<span class="badge cell--amb"><span class="glyph" aria-hidden="true">!</span>blocks certification</span>`
            : ""
        }
      </div>
      ${e.proposedRequirement ? `<p><strong>Proposed row:</strong> ${esc(e.proposedRequirement)}</p>` : ""}
      ${e.detail ? `<p>${esc(e.detail)}</p>` : ""}
      ${(e.readings || []).length ? `<p><strong>Readings recorded:</strong></p><ul>${e.readings.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      ${e.whyMissed ? `<p><strong>Why the contract does not carry it:</strong> ${esc(e.whyMissed)}</p>` : ""}
      ${e.observedInRun ? `<p><strong>What the run actually observed:</strong> ${esc(e.observedInRun)}</p>` : ""}
      ${e.disposition ? `<p><strong>Disposition:</strong> ${esc(e.disposition)}</p>` : ""}
      <p class="muted"><strong>Effect:</strong> ${esc(e.effect || lane.scoring)}</p>
      <p class="refs"><strong>Register rows affected:</strong> ${rowLinks}</p>
      ${
        (e.strengths || []).length
          ? `<details class="prov"><summary>Per-row application (${e.strengths.length})</summary><ul>${e.strengths
              .map(
                (s) =>
                  `<li><a class="idref" href="#row-${esc(s.rowId)}">${esc(s.rowId)}</a> — <span class="mono">${esc(
                    s.strength
                  )}</span>${s.note ? ` — ${esc(s.note)}` : ""}</li>`
              )
              .join("")}</ul></details>`
          : ""
      }
      ${atoms ? `<details class="prov" open><summary>Document provenance (${(e.sourceAtoms || []).length} source atom(s))</summary>${atoms}</details>` : ""}
    </article>`;
}


function renderAttempts(view) {
  if (!view.attempts.length) {
    return `<section id="attempts" aria-labelledby="att-h">
      <div class="section-head"><h2 id="att-h">Attempt ledger</h2></div>
      ${emptyState("No attempts are recorded in this run.", "Nothing was executed against the target, so no obligation can carry a verdict.")}
    </section>`;
  }
  const rows = view.attempts
    .map(
      (a) => `<tr>
      <th scope="row">${esc(a.attemptId)}</th>
      <td><span class="idref">${esc(a.pathId)}</span><span class="sub">attempt #${esc(a.attemptNumber)}${
        a.retryOfAttemptId ? ` · retry of ${esc(a.retryOfAttemptId)}` : ""
      }${a.retryReason ? ` (${esc(a.retryReason)})` : ""}</span></td>
      <td>${esc(fmtDateTime(a.timestamps?.startedAt))}<span class="sub">→ ${esc(fmtDateTime(a.timestamps?.endedAt))}</span></td>
      <td class="num">${(a.actions || []).length}<span class="sub">actions</span></td>
      <td class="num">${(a.stateFingerprints || []).length}<span class="sub">states</span></td>
      <td><span class="mono">${esc(a.stop?.reason)}</span><span class="sub">${esc(a.stop?.detail)}</span><span class="sub">last valid state ${esc(
        a.stop?.lastValidStateId || "none"
      )}</span></td>
      <td>${(a.targetItemIds || []).map((id) => `<a class="idref" href="#row-${esc(id)}">${esc(id)}</a>`).join(", ")}</td>
    </tr>`
    )
    .join("");

  return `<section id="attempts" aria-labelledby="att-h">
      <div class="section-head">
        <h2 id="att-h">Attempt ledger</h2>
        <p class="lead">Append-only record of what was actually walked. Retries never overwrite an earlier attempt. Full per-action drill-down is P2; the counts below are the harness-attested totals.</p>
      </div>
      <div class="scroll-x">
        <table class="plain">
          <caption>${view.attempts.length} attempt(s) recorded.</caption>
          <thead><tr>
            <th scope="col">Attempt</th><th scope="col">Path</th><th scope="col">Window</th>
            <th scope="col">Actions</th><th scope="col">States</th><th scope="col">Stop</th><th scope="col">Targeted obligations</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

function renderEvidence(view) {
  const ev = view.evidence;
  if (!ev.count) {
    return `<section id="evidence" aria-labelledby="ev-h">
      <div class="section-head"><h2 id="ev-h">Evidence catalogue</h2></div>
      ${emptyState("No evidence artifacts are catalogued in this record.", "Any finding asserted without evidence is listed as an unsupported assertion above.")}
    </section>`;
  }

  const rows = ev.rows
    .map((e) => {
      const a = e.audit || { state: "not-checked" };
      let badge;
      if (a.state === "verified") badge = `<span class="badge badge--pass"><span class="glyph" aria-hidden="true">✓</span>Bytes match contentHash</span>`;
      else if (a.state === "mismatch")
        badge = `<span class="badge badge--fail"><span class="glyph" aria-hidden="true">✕</span>Hash mismatch — link withheld</span>`;
      else if (a.state === "missing")
        badge = `<span class="badge badge--warn"><span class="glyph" aria-hidden="true">!</span>Bytes not found</span>`;
      else
        badge = `<span class="badge badge--neutral"><span class="glyph" aria-hidden="true">·</span>Not checked — no artifacts directory supplied</span>`;

      const link =
        a.state === "verified" && a.href
          ? `<a href="${esc(a.href)}">open artifact</a>`
          : `<span class="muted">${esc(
              a.state === "mismatch"
                ? "withheld: stored bytes do not match the signed hash"
                : a.state === "missing"
                  ? "unavailable: artifact bytes are not present"
                  : "metadata only in this render"
            )}</span>`;

      return `<tr id="ev-${esc(e.evidenceId)}">
        <th scope="row">${esc(e.evidenceId)}</th>
        <td><span class="mono">${esc(e.type)}</span><span class="sub">${esc(e.mediaType)} · ${esc(fmtBytes(e.byteLength))}</span></td>
        <td><span class="hash">${esc(e.artifactRef)}</span><span class="sub">${link}</span></td>
        <td><span class="hash">${esc(e.contentHash)}</span><span class="sub">${badge}</span></td>
        <td>${esc(fmtDateTime(e.capturedAt))}<span class="sub">${esc(e.capture?.phase)} · attempt ${esc(
          e.capture?.attemptId || "—"
        )} · action ${esc(e.capture?.actionId || "—")} · state ${esc(e.capture?.stateId || "—")}</span></td>
        <td><span class="mono">${esc(e.redaction?.status)}</span><span class="sub">${esc(e.redaction?.method || "no method recorded")}</span></td>
      </tr>`;
    })
    .join("");

  const typeSummary = Object.entries(ev.byType)
    .sort()
    .map(([t, n]) => `${t} ×${n}`)
    .join(", ");

  return `<section id="evidence" aria-labelledby="ev-h">
      <div class="section-head">
        <h2 id="ev-h">Evidence catalogue</h2>
        <p class="lead">${ev.count} artifact(s): ${esc(typeSummary)}. Metadata and hashes render here; artifact bytes are never inlined. Where an artifacts directory was supplied, stored bytes were re-hashed and a link is offered only when the bytes match the signed <span class="mono">contentHash</span>.</p>
      </div>
      <div class="scroll-x">
        <table class="evidence-table">
          <caption>Signed evidence catalogue from <span class="mono">RunRecord.evidence</span>.</caption>
          <thead><tr>
            <th scope="col">Evidence ID</th><th scope="col">Type</th><th scope="col">Artifact reference</th>
            <th scope="col">Content hash</th><th scope="col">Captured</th><th scope="col">Redaction</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

function renderScorecard(view) {
  const sc = view.scorecard;
  if (!sc) {
    return `<section id="scorecard" aria-labelledby="sc-h">
      <div class="section-head"><h2 id="sc-h">Corpus acceptance appendix</h2></div>
      ${emptyState(
        "No scorecard was supplied for this run.",
        "This appendix only exists for corpus runs scored against a private oracle. An ordinary survey run has no oracle and therefore no seeded-defect metrics."
      )}
    </section>`;
  }

  const gates = Object.entries(sc.integrity?.gates || {})
    .map(([g, s]) => `<li>${esc(g)}: <span class="mono">${esc(s)}</span></li>`)
    .join("");

  const m = sc.metrics || {};
  const pct = (x) => (typeof x === "number" ? (x * 100).toFixed(1) + "%" : "not applicable");

  const defects = sc.defects || {};
  const defectRows = [
    ["Seeded defects in this variant", defects.seededTotal],
    ["Defect findings asserted by the tester", defects.asserted],
    ["Matched a seeded defect (true positives)", (defects.truePositives || []).length],
    ["No seeded match (false positives)", (defects.falsePositives || []).length],
    ["Seeded defects missed (false negatives)", (defects.falseNegatives || []).length],
    ["Redundant duplicates", (defects.redundant || []).length],
    ["Rejected as unsupported by the scorer", (defects.unsupported || []).length],
  ]
    .map(([k, v]) => `<li>${esc(k)}: <span class="num">${esc(String(v ?? 0))}</span></li>`)
    .join("");

  const fp = (defects.falsePositives || []).length
    ? `<p>Scorer-classified false positives: ${(defects.falsePositives || [])
        .map((id) => `<a class="idref" href="#finding-${esc(id)}">${esc(id)}</a>`)
        .join(", ")}.</p>`
    : "";
  const fn = (defects.falseNegatives || []).length
    ? `<p>Seeded defects the run did not report: ${(defects.falseNegatives || [])
        .map((id) => `<span class="idref">${esc(id)}</span>`)
        .join(", ")}. These are oracle IDs and exist only in corpus scoring.</p>`
    : "";

  return `<section id="scorecard" aria-labelledby="sc-h">
      <div class="section-head">
        <h2 id="sc-h">Corpus acceptance appendix (scorer output)</h2>
        <p class="lead">This section exists only because the target is a corpus fixture with a private oracle. It measures the <em>tester</em>, not the customer's survey, and it is not the report headline. Source: <span class="mono">${esc(
          sc.scorecardVersion
        )}</span>, matcher <span class="mono">${esc(sc.matcherVersion)}</span>, scored ${esc(fmtDateTime(sc.scoredAt))}.</p>
      </div>
      <div class="panel">
        <dl class="dl-grid">
          ${dt("Subject run", `<span class="idref">${esc(sc.subject?.runId)}</span>`)}
          ${dt("Survey / variant", `<span class="mono">${esc(sc.subject?.surveyId)} · ${esc(sc.subject?.variantKind)}</span>`)}
          ${dt("Integrity status", `<span class="mono">${esc(sc.integrity?.status)}</span>`)}
          ${dt("Matcher / defect matcher", `<span class="mono">${esc(sc.matcherVersion)}</span><span class="sub mono">${esc(sc.defectMatcherVersion)}</span>`)}
          ${dt("Evidence policy", `<span class="mono">${esc(sc.evidencePolicyVersion)}</span>`)}
          ${dt("Cost cohort", `<span class="mono">${esc(sc.completeness?.cohort)}</span>`)}
        </dl>
        <h3>Gates</h3>
        <ul>${gates}</ul>
        <h3>Extraction and coverage against the oracle</h3>
        <ul>
          <li>Extraction recall: <span class="num">${esc(pct(m.extractionRecall))}</span> (oracle obligations matched by an extracted item)</li>
          <li>Extraction precision: <span class="num">${esc(pct(m.extractionPrecision))}</span> (extracted items that matched an oracle obligation)</li>
          <li>Reachable coverage: <span class="num">${esc(pct(m.reachableCoverage))}</span> of ${esc(String(m.reachableObligations ?? "?"))} reachable oracle obligations</li>
          <li>Evidence completeness: <span class="num">${esc(pct(m.evidenceCompleteness))}</span> · report completeness <span class="num">${esc(pct(m.reportCompleteness))}</span></li>
          <li>Unmatched tester items: ${
            (sc.matching?.unmatchedTesterItemIds || []).length
              ? (sc.matching.unmatchedTesterItemIds || [])
                  .map((id) => `<a class="idref" href="#row-${esc(id)}">${esc(id)}</a>`)
                  .join(", ")
              : "none"
          }</li>
        </ul>
        <h3>Seeded-defect scoring</h3>
        <ul>${defectRows}</ul>
        <p>Seeded defect recall ${esc(pct(m.seededDefectRecall))} · seeded defect precision ${esc(pct(m.seededDefectPrecision))}.</p>
        ${fp}
        ${fn}
      </div>
    </section>`;
}

function renderProvenance(view, { modelCalls = [], toolVersions: tools = [] } = {}) {
  const calls = view.resources;

  const modelRows = modelCalls.length
    ? modelCalls
        .map(
          (c) => `<tr>
        <th scope="row">${esc(c.callId)}</th>
        <td><span class="mono">${esc(c.role)}</span></td>
        <td>${esc(c.provider)}<span class="sub mono">${esc(c.model)}</span></td>
        <td><span class="mono">${esc(c.promptVersion)}</span><span class="sub hash">${esc(c.promptHash)}</span></td>
        <td><span class="mono">${esc(c.status)}</span></td>
        <td class="num">${fmtInt(c.inputTokens)} in / ${fmtInt(c.outputTokens)} out<span class="sub">${fmtInt(
          c.cachedInputTokens
        )} cached in</span></td>
        <td class="num">${usdPrecise(c.costUsd)}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="muted">No model calls are recorded in this run.</td></tr>`;

  const downloads = (view.sources?.downloads || [])
    .map(
      (d) =>
        `<li><a href="${esc(d.href)}">${esc(d.label)}</a> <span class="muted">— ${esc(d.note)}</span></li>`
    )
    .join("");

  const t = view.resources.totals || {};

  return `<footer class="report-footer" id="provenance">
      <div class="wrap">
        <h2>Cost, limits, and provenance</h2>
        <div class="panel">
          <dl class="dl-grid">
            ${dt("Extraction method", `<span class="mono">${esc(view.record.extraction?.method)}</span><span class="sub">${esc(view.record.extraction?.extractorVersion)}</span>`)}
            ${dt("Extraction model calls", (view.record.extraction?.modelCallRefs || []).map((r) => `<span class="idref">${esc(r)}</span>`).join(", ") || "<span class=\"muted\">none</span>")}
            ${dt("Extracted at", esc(fmtDateTime(view.record.extraction?.extractedAt)))}
            ${dt("Matcher version", view.scorecard ? `<span class="mono">${esc(view.scorecard.matcherVersion)}</span>` : `<span class="muted">no scorecard supplied</span>`)}
            ${dt("Pricing version", `<span class="mono">${esc(t.pricingVersion)}</span>`)}
            ${dt("Evidence artifacts", `${view.evidence.count} catalogued`)}
            ${dt("Tool versions", tools.map((x) => `<span class="mono">${esc(x.name)} ${esc(x.version)}</span>`).join("<br>") || "<span class=\"muted\">none recorded</span>")}
            ${dt("Report view version", `<span class="mono">${esc(view.viewVersion)}</span>`)}
            ${dt("Rendered at", esc(fmtDateTime(view.generatedAt)))}
          </dl>
        </div>
        <div class="panel">
          <h3>Resource totals against enforced limits</h3>
          <dl class="dl-grid">
            ${dt("Total attested cost", `${usdPrecise(t.totalCostUsd)} of ${usd(calls.costCapUsd)} cap`)}
            ${dt("Cost split", `model ${usdPrecise(t.modelCostUsd)} · browser ${usdPrecise(t.browserCostUsd)} · other ${usdPrecise(t.otherCostUsd)}`)}
            ${dt("Reserves inside the cap", `verification ${usd(calls.verificationReserveUsd)} · reporting ${usd(calls.reportReserveUsd)}`)}
            ${dt("Wall clock", `${fmtDuration(t.wallClockMilliseconds)} of ${fmtDuration(calls.wallClockCapMs)} cap`)}
            ${dt("Browser time", fmtDuration(t.browserMilliseconds))}
            ${dt("Model calls", `${fmtInt(t.modelCalls)} of ${fmtInt(calls.modelCallCap)} cap`)}
            ${dt("Tool calls", `${fmtInt(t.toolCalls)} of ${fmtInt(calls.toolCallCap)} cap`)}
            ${dt("Retries / escalations", `${fmtInt(t.retryCount)} / ${fmtInt(t.escalationCount)}`)}
            ${dt("Tokens", `${fmtInt(t.inputTokens)} in · ${fmtInt(t.cachedInputTokens)} cached in · ${fmtInt(t.outputTokens)} out`)}
          </dl>
        </div>
        <div class="panel">
          <h3>Model calls</h3>
          <div class="scroll-x">
            <table class="plain">
              <caption>Provider calls observed by the harness. Prompt hashes identify the exact prompt version used.</caption>
              <thead><tr>
                <th scope="col">Call</th><th scope="col">Role</th><th scope="col">Provider / model</th>
                <th scope="col">Prompt</th><th scope="col">Status</th><th scope="col">Tokens</th><th scope="col">Cost</th>
              </tr></thead>
              <tbody>${modelRows}</tbody>
            </table>
          </div>
        </div>
        <div class="panel">
          <h3>Source records</h3>
          <ul class="downloads">${downloads || `<li class="muted">No source paths were recorded for this render.</li>`}</ul>
          <p class="muted">This page is a view generated from the signed source records above. The signed <span class="mono">RunRecord</span> and the scorer output remain the authority; where this page and those records disagree, the records win.</p>
        </div>
      </div>
    </footer>`;
}

// Navigation sits AFTER the blocker, the action state and the result-review
// state. A reader must meet the answer before the table of contents.
function renderNav() {
  const items = [
    ["operational", "Operational blockers"],
    ["action", "Action state"],
    ["result-review", "Result review and trust statements"],
    ["scope", "Scope and completeness"],
    ["routing-coverage", "Routing graph coverage"],
    ["findings", "Findings, as recorded"],
    ["document-questions", "Document questions"],
    ["not-verifiable", "Not verifiable from a browser"],
    ["register", "Requirement register (both run columns)"],
    ["flag-lanes", "Flag lanes"],
    ["delta", "Before / after"],
    ["exploration", "Tier 2 exploration"],
    ["summary", "Execution summary and cost"],
    ["identity", "Run identity and hashes"],
    ["method", "How it was driven"],
    ["attempts", "Attempts"],
    ["evidence", "Evidence"],
    ["scorecard", "Corpus appendix"],
    ["provenance", "Provenance"],
  ];
  return `<nav aria-label="Audit trail sections" class="panel audit-nav">
      <strong>In the audit trail:</strong>
      ${items.map(([id, label]) => `<a href="#${id}">${esc(label)}</a>`).join(" · ")}
    </nav>`;
}

/* ------------------------------- document ------------------------------ */

/**
 * The AUDIT TRAIL view — everything the customer views layer over.
 *
 * AMENDMENT B keeps every trust mechanism in the system and reachable; what
 * changes is EXPOSURE. So this view is the previous report body, unchanged in
 * substance and complete: the four trust statements, the certification state,
 * the two-column register (including the historical as-run column), the flag
 * lanes, the before/after comparison, attempts, the evidence catalogue, the
 * corpus appendix, run identity, hashes and provenance.
 */
function renderAuditTrailView(view, { modelCalls = [], toolVersions = [], defer = null } = {}) {
  return `
<section class="audit-intro">
  <h2 class="lane-title">Audit trail</h2>
  <p class="lane-lede">Everything behind the two customer views: how the run was driven, what it recorded, what was re-checked, and every identifier, hash, version and reason code. Nothing on the Summary or the Full check is asserted without a source here.</p>
</section>
${renderOperationalBlockers(view)}
${renderDisclosedModification(view)}
${renderActionState(view)}
${renderResultReview(view)}
${renderCertification(view)}
${renderNav()}
${renderScope(view)}
${renderEdgeCoverage(view)}
${renderFindings(view)}
${renderExploration(view)}
${renderDocumentQuestions(view)}
${renderNotVerifiable(view)}
${renderRegister(view, { defer })}
${renderFlagLanes(view)}
${renderRegisterDelta(view)}
${renderSummary(view)}
${renderHeader(view)}
${renderMethod(view)}
${renderAttempts(view)}
${renderEvidence(view)}
${renderScorecard(view)}
${renderProvenance(view, { modelCalls, toolVersions })}
`;
}

/** Survey identity + run date. The two facts a reader needs before anything else. */
function renderMasthead(view) {
  const run = view.record.run ?? {};
  const target = run.target ?? {};
  const doc = run.document ?? run.questionnaire ?? {};
  const surveyName = target.name ?? target.url ?? run.runId ?? "this survey";
  const docName = doc.name ?? doc.filename ?? null;
  const when = run.finishedAt ?? run.startedAt ?? view.generatedAt;
  return `<header class="masthead">
  <div class="wrap masthead-row">
    <div>
      <p class="kicker">Survey QA · questionnaire-to-survey check</p>
      <h1 class="brand">${esc(surveyName)}</h1>
      <p class="run-line">Checked ${esc(String(when).slice(0, 10))}${docName ? ` against ${esc(docName)}` : ""}</p>
    </div>
    <button type="button" id="theme-toggle" class="theme-toggle" aria-pressed="false">Switch theme</button>
  </div>
</header>`;
}

export function renderReportHtml(view, { css, modelCalls = [], toolVersions = [], defer = null } = {}) {
  const runId = view.record.run?.runId ?? "unknown-run";
  const title = `Survey QA report — ${runId}`;
  const bodyClass = view.integrity.suspect ? "integrity-suspect" : "";
  const summary = buildDecisionSummary(view);
  const csv = buildRegisterCsv(view, summary);
  const csvName = `full-check-${String(runId).replace(/[^A-Za-z0-9_-]+/g, "-")}.csv`;

  /* Progressive enhancement only. View switching, group folding and filtering
     are CSS-only (radio + checkbox), so the page works with scripting off; this
     script adds cross-view links, the CSV download, the register print action
     and the theme toggle. */
  const pageScript = `
    (function () {
      var VIEWS = { summary: 'v-summary', full: 'v-full', audit: 'v-audit' };
      function show(name) {
        var el = document.getElementById(VIEWS[name]);
        if (el) el.checked = true;
      }
      function viewOf(hash) {
        if (!hash) return null;
        var id = hash.replace(/^#/, '');
        var el = document.getElementById(id);
        if (!el) return null;
        var host = el.closest('[data-view]');
        return host ? host.getAttribute('data-view') : null;
      }
      document.addEventListener('click', function (ev) {
        var a = ev.target.closest('a[href^="#"]');
        if (a) {
          var want = a.getAttribute('data-goto') || viewOf(a.getAttribute('href'));
          if (want && VIEWS[want]) {
            show(want);
            hydrateView(want);
            var t = document.getElementById(a.getAttribute('href').slice(1));
            if (t) { ev.preventDefault(); t.scrollIntoView(); history.replaceState(null, '', a.getAttribute('href')); }
          }
        }
        var copy = ev.target.closest('.copy-link');
        if (copy) {
          ev.preventDefault();
          var url = location.href.split('#')[0] + '#' + copy.getAttribute('data-copy');
          if (navigator.clipboard) navigator.clipboard.writeText(url);
          copy.textContent = 'Link copied';
          setTimeout(function () { copy.textContent = 'Copy link'; }, 2000);
        }
      });
      /* Deferred blocks: unpack the compressed markup stored in this file when
         the view that holds it is opened. Nothing is fetched. If the browser
         has no DecompressionStream the note stays and points at the Full check,
         which carries every requirement and needs no scripting. */
      function hydrate(root) {
        var hosts = (root || document).querySelectorAll('[data-deferred]:not([data-hydrated])');
        for (var i = 0; i < hosts.length; i += 1) (function (host) {
          var payload = host.querySelector('script[data-deferred-payload]');
          if (!payload) return;
          host.setAttribute('data-hydrated', 'pending');
          if (typeof DecompressionStream === 'undefined' || typeof Response === 'undefined') {
            host.setAttribute('data-hydrated', 'unsupported');
            return;
          }
          try {
            var raw = atob(payload.textContent.replace(/\\s+/g, ''));
            var bytes = new Uint8Array(raw.length);
            for (var j = 0; j < raw.length; j += 1) bytes[j] = raw.charCodeAt(j);
            new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text().then(function (html) {
              host.innerHTML = html;
              host.setAttribute('data-hydrated', 'done');
            }).catch(function () { host.setAttribute('data-hydrated', 'failed'); });
          } catch (e) { host.setAttribute('data-hydrated', 'failed'); }
        })(hosts[i]);
      }
      function hydrateView(name) {
        var host = document.querySelector('[data-view="' + name + '"]');
        if (host) hydrate(host);
      }
      /* Listening only — the switcher itself is the CSS radio mechanism and
         keeps working with this script removed. */
      var radios = document.querySelectorAll('.viewradio');
      for (var r = 0; r < radios.length; r += 1) {
        radios[r].addEventListener('change', function () { if (this.checked) hydrateView(this.value); });
      }
      window.addEventListener('beforeprint', function () { hydrate(document); });

      var want = viewOf(location.hash);
      if (want) { show(want); hydrateView(want); }

      var csvBtn = document.getElementById('csv-btn');
      if (csvBtn) csvBtn.addEventListener('click', function () {
        var node = document.getElementById('register-csv');
        if (!node) return;
        var blob = new Blob([JSON.parse(node.textContent)], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = ${JSON.stringify(csvName)};
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      });

      var printReg = document.getElementById('print-register');
      if (printReg) printReg.addEventListener('click', function () {
        document.body.classList.add('print-register');
        window.print();
      });
      window.addEventListener('afterprint', function () {
        document.body.classList.remove('print-register');
      });

      var root = document.documentElement;
      var btn = document.getElementById('theme-toggle');
      if (!btn) return;
      var stored = null;
      try { stored = localStorage.getItem('survey-qa-report-theme'); } catch (e) {}
      if (stored === 'dark' || stored === 'light') root.setAttribute('data-theme', stored);
      function current() {
        var explicit = root.getAttribute('data-theme');
        if (explicit) return explicit;
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      function paint() {
        var mode = current();
        btn.textContent = mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
        btn.setAttribute('aria-pressed', mode === 'dark' ? 'true' : 'false');
      }
      btn.addEventListener('click', function () {
        var next = current() === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        try { localStorage.setItem('survey-qa-report-theme', next); } catch (e) {}
        paint();
      });
      paint();
    })();
  `;

  const tabs = [
    ["v-summary", "summary", "Summary"],
    ["v-full", "full", `Full check (${summary.total})`],
    ["v-audit", "audit", "Audit trail"],
  ];

  const tabMarkup = tabs
    .map(
      ([id, value, label]) =>
        `<input type="radio" name="reportview" class="sr-only viewradio" id="${id}" value="${value}"${
          id === "v-summary" ? " checked" : ""
        }><label class="tab" for="${id}">${esc(label)}</label>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="generator" content="${esc(view.viewVersion)}">
<style>
${css}
</style>
</head>
<body class="${bodyClass}">
<a class="skip-link" href="#main">Skip to the report</a>
${renderMasthead(view)}
<div class="wrap global-notices">
${renderFixtureNote(view)}
${renderFailClosed(view)}
</div>
<div class="wrap viewswitch">
  ${tabMarkup}
  <main id="main" class="views">
    <section class="view" data-view="summary" id="summary-view" aria-label="Summary">
      ${renderSummaryView(view, summary)}
      ${renderV2SummaryEnrichment(view)}
    </section>
    <section class="view" data-view="full" id="full-check" aria-label="Full check">
      ${renderV2FindingsView(view)}
      ${renderFullCheckView(view, summary)}
    </section>
    <section class="view" data-view="audit" id="audit-trail" aria-label="Audit trail">
      ${renderAuditTrailView(view, { modelCalls, toolVersions, defer })}
    </section>
  </main>
</div>
<footer class="page-foot wrap">
  <p>This page is a view generated from the signed run record. The record, not this page, is the authority. Generated ${esc(
    view.generatedAt
  )}.</p>
</footer>
<script type="application/json" id="register-csv">${JSON.stringify(csv).replace(/</g, "\\u003c")}</script>
<script>${pageScript}</script>
</body>
</html>
`;
}

// The "Full check" view — the Requirement Register, in customer language.
//
// AMENDMENT B: the register is the SYSTEM OF RECORD and moves to its own tab.
// It keeps questionnaire ordering, cross-cutting rules pinned first, groups
// that auto-expand when they hold anything needing attention and collapse when
// everything in them passed — but ALWAYS showing their counts, so a collapsed
// group can never look clean while hiding a problem.
//
// Filters are CSS-only, so they work with scripting disabled, and `All N` is
// always visibly available: an attention-only filter can never be mistaken for
// the complete denominator.
//
// Nothing is dropped relative to the previous register: per-row evidence, route
// comparisons, the reason a result is withheld, the mandatory-case breakdown
// and the exact recorded state are all still here. They are LAYERED — plain
// state and plain reason in the row, evidence behind one disclosure, technical
// provenance behind a second.

import { esc } from "./esc.mjs";
import { plainState, PLAIN_STATES, PLAIN_STATE_ORDER } from "./plain-language.mjs";
import { readableValue, requirementLabel, plainify } from "./plain-text.mjs";
import { screenShowedBlock } from "./evidence-block.mjs";

const ATTENTION = new Set(["problem", "decision", "partial", "no-browser", "not-completed"]);

const FILTERS = [
  { id: "all", label: "All", match: () => true },
  { id: "attention", label: "Needs attention", match: (p) => ATTENTION.has(p) },
  { id: "problems", label: "Problems", match: (p) => p === "problem" },
  { id: "decision", label: "Needs your decision", match: (p) => p === "decision" },
  { id: "incomplete", label: "Incomplete", match: (p) => p === "partial" || p === "no-browser" || p === "not-completed" },
];

function scoreableCases(row) {
  return (row.cases || []).filter((c) => !c.leaf);
}

/** Plain-language mixed line. Never "usually works": tested routes are not respondents. */
function mixedLine(row, colId) {
  const cases = scoreableCases(row);
  const matched = cases.filter((c) => c.cellsByColumn?.[colId]?.state === "PASS").length;
  const diverged = cases.filter((c) => {
    const s = c.cellsByColumn?.[colId]?.state;
    return s === "FAIL" || s === "MIXED";
  }).length;
  const unsettled = cases.length - matched - diverged;
  return `Inconsistent — passed on ${matched} route${matched === 1 ? "" : "s"} and failed on ${diverged} route${
    diverged === 1 ? "" : "s"
  }${unsettled > 0 ? `, with ${unsettled} route${unsettled === 1 ? "" : "s"} never finished` : ""}. It counts as a problem: a pass on one route never cancels a failure on another.`;
}

/** Failing routes first. */
function routeTable(row, colId) {
  const cases = scoreableCases(row).filter((c) => c.routeRow);
  if (!cases.length) return "";
  const rank = (c) => {
    const s = c.cellsByColumn?.[colId]?.state;
    return s === "FAIL" || s === "MIXED" ? 0 : s === "PASS" ? 2 : 1;
  };
  const sorted = [...cases].sort((a, b) => rank(a) - rank(b));
  const required = row.compiled?.expectation?.destination ?? null;
  const body = sorted
    .map((c) => {
      const cd = c.cellsByColumn?.[colId];
      const p = plainState(cd?.state);
      const observed = Object.entries(c.routeRow.destinations || {})
        .map(([d, i]) => `${d} ×${i.count ?? i}`)
        .join(", ");
      return `<tr>
        <th scope="row">${esc(c.label)}</th>
        <td>${required ? esc(required) : `<span class="muted">the questionnaire names no next screen for this route</span>`}</td>
        <td>${esc(observed || "nothing recorded")}</td>
        <td><span class="pstate pstate--${esc(p.tone)}">${esc(p.label)}</span></td>
      </tr>`;
    })
    .join("");
  return `<h4>Route by route</h4>
    <p class="muted small">One row per answer route we had to walk. This counts routes we tested — it is not a statement about how many respondents take them.</p>
    <div class="scroll-x"><table class="plain">
      <thead><tr><th scope="col">Respondent route</th><th scope="col">Questionnaire says</th><th scope="col">Survey did</th><th scope="col">Result</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}

function rowTechnicalDetails(row, colId) {
  const cell = row.cellsByColumn?.[colId] ?? null;
  const lines = [];
  lines.push(["Requirement id", row.itemId]);
  lines.push(["Recorded state", cell?.state ?? "no current cell"]);
  if (cell?.coverage) lines.push(["Coverage state", cell.coverage]);
  if (cell?.reasonCode) lines.push(["Reason code", cell.reasonCode]);
  if (cell?.claimedVerdict) lines.push(["Recorded verdict", cell.claimedVerdict]);
  if (row.identity?.versionId) lines.push(["Row version", row.identity.versionId]);
  if (row.identity?.semanticFingerprint) lines.push(["Row fingerprint", row.identity.semanticFingerprint]);
  if (row.sourceAnchor?.locator) lines.push(["Source locator", row.sourceAnchor.locator]);
  if (typeof row.extractionConfidence === "number") lines.push(["Extraction confidence", row.extractionConfidence.toFixed(2)]);
  if (row.compiled?.predicateId)
    lines.push(["Decision predicate", `${row.compiled.predicateId} → ${row.compiled.predicateOutcome ?? "no outcome"}`]);
  // STRUCTURED VALUES ARE RENDERED, NOT STRINGIFIED.
  //
  // `Predicate detail` is an object on every row that has one, so the shipped
  // build printed the literal text `[object Object]` 107 times; the other four
  // structured fields were `JSON.stringify`d, which put 346 raw JSON blobs in
  // front of anyone who opened a technical drawer. Both are inside the second
  // disclosure, which is the right LAYER — but a reader who opens a disclosure
  // is still a reader, and `[object Object]` is not information at any layer.
  // `maxItems` is raised here: this is the provenance layer, and a truncated
  // list of the screens a scope covers would be a deletion, not a summary.
  if (row.compiled?.predicateDetail) lines.push(["What the check looked at", readableValue(row.compiled.predicateDetail, { maxItems: 60 })]);
  if (row.compiled?.evidenceScope) lines.push(["Evidence scope", readableValue(row.compiled.evidenceScope, { maxItems: 60 })]);
  if (row.compiled?.compiledBy) lines.push(["Compiled by", row.compiled.compiledBy]);
  if (row.expansion)
    lines.push([
      "Mandatory-case expansion",
      readableValue({
        established: row.expansion.established,
        rule: row.expansion.rule,
        source: row.expansion.source,
        mandatoryCases: row.expansion.mandatoryCases,
      }),
    ]);
  if (cell?.publicationGate) {
    lines.push(["Publication gate", cell.publicationGate.publishable ? "passed" : `failed: ${cell.publicationGate.failed.join(", ")}`]);
    if (cell.publicationGate.reason) lines.push(["Publication gate reason", cell.publicationGate.reason]);
  }
  if (cell?.settlement) lines.push(["Settlement", readableValue(cell.settlement)]);
  if (cell?.recheck) lines.push(["Re-check", `${cell.recheck.state} — ${cell.recheck.note}`]);
  for (const n of cell?.notes || []) lines.push(["Note", n]);
  if (cell?.reasonText) lines.push(["Recorded reason", cell.reasonText]);
  for (const w of (cell?.evidence || []).slice(0, 8)) {
    lines.push([
      `Witness (${w.role})`,
      [w.artifact, w.locator, w.sha256 ? `sha256:${w.sha256}` : null, `re-verified: ${w.judgeReverified}`, w.chain?.catalogState, w.chain?.bytesState]
        .filter(Boolean)
        .join(" · "),
    ]);
  }
  for (const a of row.ambiguities || []) lines.push([`Open question ${a.ambiguityId ?? ""}`.trim(), readableValue(a)]);
  return `<details class="tech">
      <summary>Technical details</summary>
      <dl class="tech-dl">${lines
        .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd class="mono">${esc(readableValue(v))}</dd></div>`)
        .join("")}</dl>
      <p class="tech-note">The run-level machinery behind this row — signatures, the four trust statements, the flag lanes, the before/after comparison and the full evidence catalogue — is in the <a href="#audit-trail" data-goto="audit">Audit trail</a>.</p>
    </details>`;
}

function rowDrawer(row, colId, view) {
  const cell = row.cellsByColumn?.[colId] ?? null;
  const blocks = [];

  // Extraction prose: translated (a tag used as an example of "bold" becomes
  // plain), never sentence-dropped — deleting a requirement because of how it
  // illustrated a term would be worse than the illustration.
  const requirementText = plainify(row.requirement, { maxChars: 600, dropTechnical: false }).text;
  const expectedText = plainify(row.expectedObservable, { maxChars: 600, dropTechnical: false }).text;
  if (requirementText) blocks.push(`<h4>What we checked</h4><p>${esc(requirementText)}</p>`);
  if (expectedText) blocks.push(`<h4>What should be on screen</h4><p>${esc(expectedText)}</p>`);
  if (row.sourceAnchor?.quote)
    blocks.push(`<h4>What the questionnaire says</h4><blockquote class="quote">${esc(row.sourceAnchor.quote)}</blockquote>`);

  const shown = screenShowedBlock([row], colId, { perRow: 4 });
  blocks.push(shown || `<h4>What the screen showed</h4><p class="muted">No screen evidence is attached to this requirement.</p>`);

  blocks.push(routeTable(row, colId));

  const cases = scoreableCases(row);
  if (cases.length > 1) {
    const counts = new Map();
    for (const c of cases) {
      const p = plainState(c.cellsByColumn?.[colId]?.state);
      counts.set(p.label, (counts.get(p.label) || 0) + 1);
    }
    blocks.push(
      `<h4>Answer routes under this requirement</h4><p>${[...counts.entries()]
        .map(([label, n]) => `${esc(label)} ×${n}`)
        .join(" · ")}</p>`
    );
  }

  if (cell?.publicationGate && !cell.publicationGate.publishable && cell.state !== "FAIL" && cell.state !== "MIXED") {
    blocks.push(
      `<h4>Why we are not publishing a result here</h4><p>The result recorded for this requirement did not survive our own evidence check, so we withhold it rather than show you something we cannot stand behind. The full reason is in the technical details below.</p>`
    );
  }

  const findings = (row.findingRefs || [])
    .map((id) => view.findings.all.find((f) => f.findingId === id) || view.documentQuestions.ambiguities.find((f) => f.findingId === id))
    .filter(Boolean);
  if (findings.length) {
    blocks.push(
      `<h4>What a respondent experiences</h4><ul class="plain-list">${findings
        .map(
          (f) =>
            `<li>${esc(
              f.respondent?.consequence ??
                plainify(f.summary, { maxChars: 280 }).text ??
                "This record does not state a respondent consequence."
            )}</li>`
        )
        .join("")}</ul>`
    );
  }

  blocks.push(rowTechnicalDetails(row, colId));
  return `<details class="drawer"><summary>Show evidence</summary><div class="drawer-body">${blocks.filter(Boolean).join("\n")}</div></details>`;
}

function renderRow(row, colId, view) {
  const cell = row.cellsByColumn?.[colId] ?? null;
  const p = plainState(cell?.state);
  const isMixed = cell?.state === "MIXED";
  const why = isMixed ? mixedLine(row, colId) : p.why;
  return `<article class="reg-row" id="req-${esc(row.itemId)}" data-plain="${esc(p.id)}"${
    ATTENTION.has(p.id) ? ' data-attention="1"' : ""
  }>
    <div class="reg-row-head">
      <span class="pstate pstate--${esc(p.tone)}">${esc(p.label)}</span>
      <span class="reg-id">Requirement ${esc(requirementLabel(row.itemId))}</span>
    </div>
    <p class="reg-req">${esc(
      plainify(row.requirement, { maxChars: 400, dropTechnical: false }).text ?? "This requirement carries no text in the record."
    )}</p>
    <p class="reg-why">${esc(why)}</p>
    ${rowDrawer(row, colId, view)}
  </article>`;
}

function groupCounts(group, colId) {
  const counts = Object.fromEntries(PLAIN_STATE_ORDER.map((id) => [id, 0]));
  for (const row of group.rows) counts[plainState(row.cellsByColumn?.[colId]?.state).id] += 1;
  return counts;
}

function groupLabel(group) {
  if (group.pinned) return "Rules that apply across the whole survey";
  return `Section ${group.key}`;
}

export function renderFullCheckView(view, summary) {
  const reg = view.register;
  const colId = summary.currentColumnId;
  const total = reg.denominators.documentRequirements.total;

  if (!colId) {
    return `<section class="lane lane--quiet">
      <h2 class="lane-title">Full check — ${total} requirements</h2>
      <p class="lane-lede">No result on this run cleared our evidence check, so this page cannot show you a per-requirement outcome. The complete list of requirements and everything recorded against them is in the <a href="#audit-trail" data-goto="audit">Audit trail</a>.</p>
    </section>`;
  }

  const counts = Object.fromEntries(PLAIN_STATE_ORDER.map((id) => [id, 0]));
  for (const row of reg.rows) counts[plainState(row.cellsByColumn?.[colId]?.state).id] += 1;

  const filterInputs = FILTERS.map((f) => {
    const n = reg.rows.filter((r) => f.match(plainState(r.cellsByColumn?.[colId]?.state).id)).length;
    const label = f.id === "all" ? `All ${total}` : `${f.label} (${n})`;
    return `<input type="radio" name="regfilter" class="sr-only regfilter" id="f-${f.id}" value="${f.id}"${
      f.id === "all" ? " checked" : ""
    }><label class="filter-chip" for="f-${f.id}">${esc(label)}</label>`;
  }).join("");

  const showing = FILTERS.map((f) => {
    const n = reg.rows.filter((x) => f.match(plainState(x.cellsByColumn?.[colId]?.state).id)).length;
    return `<span class="showing showing--${f.id}">Showing ${n} of ${total} requirements${
      n === total ? " — the complete list" : ` · ${total - n} hidden by this filter`
    }</span>`;
  }).join("");

  const groups = reg.groups
    .map((group, gi) => {
      const gc = groupCounts(group, colId);
      const attention = PLAIN_STATE_ORDER.filter((id) => ATTENTION.has(id)).reduce((a, id) => a + gc[id], 0);
      const id = `g-${gi}`;
      const chips = PLAIN_STATES.filter((s) => gc[s.id] > 0)
        .map((s) => `<span class="pstate pstate--${esc(s.tone)} pstate--mini">${esc(s.label)} ${gc[s.id]}</span>`)
        .join("");
      return `<input type="checkbox" class="sr-only group-toggle" id="${id}"${attention ? " checked" : ""}>
      <section class="reg-group"${attention ? ' data-attention="1"' : ""}>
        <label class="group-head" for="${id}">
          <span class="group-name">${esc(groupLabel(group))}</span>
          <span class="group-count">${group.rows.length} requirement${group.rows.length === 1 ? "" : "s"}</span>
          <span class="group-chips">${chips}</span>
          <span class="group-fold-hint" aria-hidden="true"></span>
        </label>
        <div class="group-body">${group.rows.map((r) => renderRow(r, colId, view)).join("\n")}</div>
      </section>`;
    })
    .join("\n");

  return `
<section class="fc-head">
  <h2 class="lane-title">Full check — ${total} requirements</h2>
  <p class="lane-lede">Every requirement we took out of your questionnaire, in questionnaire order, with what happened to it. Rules that apply across the whole survey come first. Groups that need attention are open; groups where everything passed are folded, and always show their counts.</p>
  <div class="fc-counts">${PLAIN_STATES.map(
    (s) => `<span class="mini-count"><span class="pstate pstate--${esc(s.tone)}">${esc(s.label)}</span> ${counts[s.id]}</span>`
  ).join("")}</div>
</section>
${filterInputs}
<p class="showing-wrap">${showing}</p>
<div class="reg">
  ${groups}
</div>
<p class="fc-foot">
  <button type="button" class="cta cta--quiet" id="csv-btn">Download the full check as a CSV</button>
  <button type="button" class="cta cta--quiet" id="print-register">Print or save the full check</button>
  <noscript>Downloading and printing need the browser's scripting. Every requirement is on this page either way.</noscript>
</p>
`;
}

/* ------------------------------------------------------------------ *
 * CSV export of the register                                          *
 * ------------------------------------------------------------------ */

function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildRegisterCsv(view, summary) {
  const reg = view.register;
  const colId = summary.currentColumnId;
  const header = [
    "requirement_id",
    "section",
    "applies_across_survey",
    "result",
    "why",
    "requirement",
    "what_should_be_on_screen",
    "questionnaire_quote",
    "source_locator",
    "recorded_state",
    "recorded_reason_code",
    "evidence_files_cited",
    "evidence_rechecked",
    "related_findings",
  ];
  const lines = [header.join(",")];
  for (const row of reg.rows) {
    const cell = colId ? row.cellsByColumn?.[colId] ?? null : null;
    const p = plainState(cell?.state);
    const witnesses = cell?.evidence || [];
    lines.push(
      [
        row.itemId,
        row.section,
        row.pinned ? "yes" : "no",
        colId ? p.label : "no current result",
        cell?.state === "MIXED" ? mixedLine(row, colId) : p.why,
        row.requirement,
        row.expectedObservable,
        row.sourceAnchor?.quote,
        row.sourceAnchor?.locator,
        cell?.state ?? "",
        cell?.reasonCode ?? "",
        witnesses.map((w) => w.artifact).filter(Boolean).join(" | "),
        witnesses.length ? (witnesses.every((w) => w.judgeReverified === "verified") ? "yes" : "partly") : "no",
        (row.findingRefs || []).join(" | "),
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\r\n");
}

// Builds the non-authoritative ReportView from a signed RunRecord (+ optional
// ScorecardRecord and an attestation verification result).
//
// Design authority: docs/ui-report-redesign.md §2, §6.1, §7.5.
//
// Rules encoded here (they are the point of this module):
//   - Coverage status and verdict are two axes and are NEVER merged.
//   - Nothing is normalised: an illegal status/verdict pair becomes a record
//     integrity warning, not a silently corrected cell.
//   - Report completeness and test completeness are computed separately.
//   - No progress percentage is invented; every ratio names its denominator.
//   - Findings without evidence references are separated out as unsupported
//     assertions instead of being presented as established findings.
//   - The Requirement Register (lib/register.mjs) is the primary audit body.
//     It is a projection over the same records; it never becomes a second
//     source of truth, and its two denominators are never summed.

import { buildRegister } from "./register.mjs";
import { buildTrustStatements, collectOperationalBlockers } from "./publication.mjs";
import { respondentConsequence } from "./respondent-consequence.mjs";

export const REPORT_VIEW_VERSION = "survey-qa-report-view/2.0.0";

/* ------------------------------------------------------------------ *
 * Retired claim kinds — normalized at the boundary, once.              *
 * ------------------------------------------------------------------ *
 * The merged contract §1 retires `document-live-disagreement`: the document is
 * the sole normative authority, so a document/site divergence IS a site defect.
 * The report used to carry it in two places at once — a live findings taxonomy
 * ("Document versus live disagreements") AND a taxonomy-gap lane entry for the
 * same finding. Double-reporting one record as both a finding kind and a gap in
 * the kind registry is how a reader loses track of how many problems exist.
 *
 * It is normalized HERE, at the boundary, exactly once. The original kind is
 * preserved on the finding and disclosed, so nothing is hidden.
 */
export const RETIRED_KIND_NORMALIZATION = {
  "document-live-disagreement": {
    to: "defect",
    why:
      "Retired by the merged contract §1. Under document-is-truth a supported document/site divergence is a site defect, not a separate class of disagreement, so it is carried as a defect and its original kind is disclosed rather than reported twice.",
  },
};

function normalizeFindingKind(f) {
  const rule = RETIRED_KIND_NORMALIZATION[f?.kind];
  if (!rule) return { ...f, retiredKind: null, retiredKindNote: null };
  return {
    ...f,
    kind: rule.to,
    retiredKind: f.kind,
    retiredKindNote: rule.why,
  };
}

export const COVERAGE_ORDER = [
  "exercised",
  "not-reached",
  "proven-unreachable",
  "blocked",
  "budget-exhausted",
  "time-exhausted",
  "pending",
];

export const COVERAGE_LABEL = {
  exercised: "Exercised",
  "not-reached": "Not reached",
  "proven-unreachable": "Proven unreachable",
  blocked: "Blocked",
  "budget-exhausted": "Budget exhausted",
  "time-exhausted": "Time exhausted",
  pending: "Pending",
};

// Glyphs exist so status is legible without colour (and in monochrome print).
export const COVERAGE_GLYPH = {
  exercised: "●", // filled circle - work happened
  "not-reached": "○", // hollow circle - nothing happened
  "proven-unreachable": "⊘",
  blocked: "⛔",
  "budget-exhausted": "◑",
  "time-exhausted": "◔",
  pending: "…",
};

export const COVERAGE_MEANING = {
  exercised: "The target behaviour was actually exercised.",
  "not-reached": "The intended state was not reached.",
  "proven-unreachable": "Supported evidence establishes that the state cannot be reached.",
  blocked: "An external or technical blocker prevented exercise.",
  "budget-exhausted": "Testing stopped at the enforced monetary/resource budget.",
  "time-exhausted": "Testing stopped at the wall-clock cap.",
  pending: "No terminal disposition was reached.",
};

export const VERDICT_ORDER = ["pass", "fail", "inconclusive", "not-assessed"];

export const VERDICT_LABEL = {
  pass: "Pass",
  fail: "Fail",
  inconclusive: "Inconclusive",
  "not-assessed": "Not assessed",
};

export const VERDICT_GLYPH = {
  pass: "✓",
  fail: "✕",
  inconclusive: "?",
  "not-assessed": "—",
};

export const VERDICT_TONE = {
  pass: "pass",
  fail: "fail",
  inconclusive: "warn",
  "not-assessed": "neutral",
};

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

const KIND_LABEL = {
  defect: "Asserted defect",
  "document-live-disagreement": "Document/live disagreement",
  ambiguity: "Ambiguity",
  blocker: "Blocker",
  other: "Other",
};

const REASON_LABEL = {
  "requirement-met": "requirement met",
  "requirement-mismatch": "requirement mismatch",
  "insufficient-evidence": "insufficient evidence",
  "not-attempted": "not attempted",
  "route-not-found": "route not found",
  "proven-unreachable": "proven unreachable",
  "external-block": "external block",
  "budget-exhausted": "budget exhausted",
  "time-exhausted": "time exhausted",
  "safety-stop": "safety stop",
  "ambiguous-requirement": "ambiguous requirement",
  "execution-error": "execution error",
  other: "other",
};

const STOP_LABEL = {
  "path-complete": "path complete",
  "evidence-acquired": "evidence acquired",
  "confirmed-mismatch": "confirmed mismatch",
  "external-block": "external block",
  "repeated-state": "repeated state",
  "safety-boundary": "safety boundary",
  "time-limit": "time limit reached",
  "budget-limit": "budget limit reached",
  "provider-error": "provider error",
  "browser-error": "browser error",
  "agent-error": "agent error",
  cancelled: "cancelled",
  other: "other",
};

// Causes that mean "a browser session could not settle this question".
const NOT_VERIFIABLE_COVERAGE = new Set(["blocked", "proven-unreachable"]);
const NOT_VERIFIABLE_REASONS = new Set([
  "external-block",
  "proven-unreachable",
  "safety-stop",
  "route-not-found",
]);

function counter(keys) {
  const out = {};
  for (const k of keys) out[k] = 0;
  return out;
}

function pushWarning(warnings, code, message) {
  warnings.push({ code, message });
}

/**
 * @param {object} args
 * @param {object} args.record          parsed RunRecord
 * @param {object|null} args.scorecard  parsed ScorecardRecord or null
 * @param {object} args.attestation     { state, reason, registryPath }
 * @param {object} args.options         { confidenceFloor, sources, generatedAt, evidenceAudit, fixtureNote }
 */
export function buildReportView({ record, scorecard = null, attestation, options = {} }) {
  const warnings = [];
  const confidenceFloor = options.confidenceFloor ?? 0.8;

  const items = Array.isArray(record?.contract?.items) ? record.contract.items : [];
  const results = Array.isArray(record?.itemResults) ? record.itemResults : [];
  const rawFindings = Array.isArray(record?.findings) ? record.findings : [];
  const findings = rawFindings.map(normalizeFindingKind);
  const normalizedRetiredKinds = findings.filter((f) => f.retiredKind);
  const attempts = Array.isArray(record?.attempts) ? record.attempts : [];
  const evidence = Array.isArray(record?.evidence) ? record.evidence : [];

  /* ---------------- indexes + structural integrity (never normalise) ------ */
  const resultByItem = new Map();
  for (const r of results) {
    if (resultByItem.has(r.itemId)) {
      pushWarning(
        warnings,
        "DUPLICATE_ITEM_RESULT",
        `itemResults contains more than one disposition for item ${r.itemId}. Both are shown; neither was merged.`
      );
    } else {
      resultByItem.set(r.itemId, r);
    }
  }
  const itemIds = new Set(items.map((i) => i.itemId));
  const missingResults = items.filter((i) => !resultByItem.has(i.itemId)).map((i) => i.itemId);
  const orphanResults = results.filter((r) => !itemIds.has(r.itemId)).map((r) => r.itemId);
  if (missingResults.length) {
    pushWarning(
      warnings,
      "MISSING_ITEM_RESULT",
      `${missingResults.length} contract item(s) have no disposition: ${missingResults.join(", ")}.`
    );
  }
  if (orphanResults.length) {
    pushWarning(
      warnings,
      "ORPHAN_ITEM_RESULT",
      `${orphanResults.length} itemResult(s) reference an item that is not in the contract: ${orphanResults.join(", ")}.`
    );
  }

  const attemptIds = new Set(attempts.map((a) => a.attemptId));
  const evidenceById = new Map(evidence.map((e) => [e.evidenceId, e]));
  const findingIds = new Set(findings.map((f) => f.findingId));

  const findingsByItem = new Map();
  for (const f of findings) {
    for (const itemId of f.itemRefs || []) {
      if (!findingsByItem.has(itemId)) findingsByItem.set(itemId, []);
      findingsByItem.get(itemId).push(f.findingId);
      if (!itemIds.has(itemId)) {
        pushWarning(
          warnings,
          "DANGLING_FINDING_ITEM_REF",
          `finding ${f.findingId} references unknown item ${itemId}.`
        );
      }
    }
    for (const ref of f.evidenceRefs || []) {
      if (!evidenceById.has(ref)) {
        pushWarning(
          warnings,
          "DANGLING_EVIDENCE_REF",
          `finding ${f.findingId} references unknown evidence ${ref}.`
        );
      }
    }
    for (const ref of f.attemptRefs || []) {
      if (!attemptIds.has(ref)) {
        pushWarning(warnings, "DANGLING_ATTEMPT_REF", `finding ${f.findingId} references unknown attempt ${ref}.`);
      }
    }
  }

  /* ---------------- audit rows (canonical contract.items order) ---------- */
  const coverageCounts = counter(COVERAGE_ORDER);
  const verdictCounts = counter(VERDICT_ORDER);
  const verdictAmongExercised = counter(VERDICT_ORDER);
  const unassessedByCause = new Map();

  const rows = items.map((item) => {
    const res = resultByItem.get(item.itemId) || null;
    const coverageStatus = res?.coverageStatus ?? null;
    const verdict = res?.verdict ?? null;

    if (coverageStatus && coverageStatus in coverageCounts) coverageCounts[coverageStatus] += 1;
    else if (coverageStatus) {
      pushWarning(warnings, "UNKNOWN_COVERAGE_STATUS", `item ${item.itemId} has unknown coverage status "${coverageStatus}".`);
    }
    if (verdict && verdict in verdictCounts) verdictCounts[verdict] += 1;
    else if (verdict) {
      pushWarning(warnings, "UNKNOWN_VERDICT", `item ${item.itemId} has unknown verdict "${verdict}".`);
    }

    let combinationValid = true;
    if (res) {
      if (coverageStatus === "exercised") {
        if (!["pass", "fail", "inconclusive"].includes(verdict)) {
          combinationValid = false;
          pushWarning(
            warnings,
            "INVALID_STATUS_VERDICT_PAIR",
            `item ${item.itemId} is exercised but carries verdict "${verdict}". Shown as recorded; not normalised.`
          );
        }
        if (verdict in verdictAmongExercised) verdictAmongExercised[verdict] += 1;
        if (!(res.attemptRefs || []).length) {
          pushWarning(warnings, "EXERCISED_WITHOUT_ATTEMPT", `item ${item.itemId} is exercised with no attempt reference.`);
        }
        if (!(res.evidenceRefs || []).length) {
          pushWarning(warnings, "EXERCISED_WITHOUT_EVIDENCE", `item ${item.itemId} is exercised with no evidence reference.`);
        }
      } else {
        if (verdict !== "not-assessed") {
          combinationValid = false;
          pushWarning(
            warnings,
            "INVALID_STATUS_VERDICT_PAIR",
            `item ${item.itemId} is "${coverageStatus}" but carries verdict "${verdict}". Shown as recorded; not normalised.`
          );
        }
        const statusLabel = COVERAGE_LABEL[coverageStatus] ?? coverageStatus;
        const reasonLabel = REASON_LABEL[res.reason?.code] ?? res.reason?.code ?? "no reason code";
        const cause =
          statusLabel.toLowerCase() === reasonLabel.toLowerCase() ? statusLabel : `${statusLabel} — ${reasonLabel}`;
        unassessedByCause.set(cause, (unassessedByCause.get(cause) || 0) + 1);
      }
      for (const ref of res.evidenceRefs || []) {
        if (!evidenceById.has(ref)) {
          pushWarning(warnings, "DANGLING_EVIDENCE_REF", `item ${item.itemId} references unknown evidence ${ref}.`);
        }
      }
      for (const ref of res.attemptRefs || []) {
        if (!attemptIds.has(ref)) {
          pushWarning(warnings, "DANGLING_ATTEMPT_REF", `item ${item.itemId} references unknown attempt ${ref}.`);
        }
      }
      for (const ref of res.findingRefs || []) {
        if (!findingIds.has(ref)) {
          pushWarning(warnings, "DANGLING_FINDING_REF", `item ${item.itemId} references unknown finding ${ref}.`);
        }
      }
    } else {
      unassessedByCause.set(
        "No disposition recorded — record incomplete",
        (unassessedByCause.get("No disposition recorded — record incomplete") || 0) + 1
      );
    }

    const relatedFindings = new Set([...(res?.findingRefs || []), ...(findingsByItem.get(item.itemId) || [])]);

    return {
      item,
      result: res,
      coverageStatus,
      verdict,
      combinationValid,
      relatedFindings: [...relatedFindings],
      attemptCount: (res?.attemptRefs || []).length,
      evidenceCount: (res?.evidenceRefs || []).length,
      lowConfidenceExtraction: typeof item.confidence === "number" && item.confidence < confidenceFloor,
    };
  });

  // Obligations that carry no usable verdict, counted from the same rows that
  // populate the by-cause list so the headline and the list can never disagree.
  const unassessedTotal = [...unassessedByCause.values()].reduce((a, n) => a + n, 0);

  const total = items.length;
  const exercised = coverageCounts.exercised;
  const countsSum = COVERAGE_ORDER.reduce((a, k) => a + coverageCounts[k], 0);
  if (total > 0 && countsSum !== total) {
    pushWarning(
      warnings,
      "COVERAGE_DENOMINATOR_MISMATCH",
      `coverage buckets sum to ${countsSum} but the sealed contract holds ${total} obligations.`
    );
  }

  /* ---------------- completion: two independent outcomes ---------------- */
  const stopReasons = new Map();
  for (const a of attempts) {
    const r = a?.stop?.reason ?? "other";
    stopReasons.set(r, (stopReasons.get(r) || 0) + 1);
  }
  const limitStops = [...stopReasons.keys()].filter((r) => r === "budget-limit" || r === "time-limit");

  const reportComplete = total > 0 && missingResults.length === 0 && orphanResults.length === 0;
  const nonTerminal = total - exercised - coverageCounts["proven-unreachable"];

  let testingState;
  if (total === 0) testingState = "unknown";
  else if (coverageCounts["budget-exhausted"] > 0 || stopReasons.has("budget-limit")) testingState = "partial-budget";
  else if (coverageCounts["time-exhausted"] > 0 || stopReasons.has("time-limit")) testingState = "partial-time";
  else if (coverageCounts.blocked > 0) testingState = "partial-blocked";
  else if (nonTerminal > 0) testingState = "partial-incomplete";
  else testingState = "complete-against-contract";

  const TESTING_SENTENCE = {
    "complete-against-contract":
      "Testing complete against the extracted contract — every extracted obligation reached a terminal coverage state. This does not certify that extraction itself was complete.",
    "partial-budget": "Testing partial — the run stopped at the enforced monetary/resource budget.",
    "partial-time": "Testing partial — the run stopped at the wall-clock cap.",
    "partial-blocked": "Testing partial — one or more obligations were blocked from being exercised.",
    "partial-incomplete":
      "Testing partial — obligations remain that were never exercised and were not proven unreachable. Untested items are not passes.",
    unknown: "Testing state unknown — the contract denominator is not established.",
  };

  const stopSummary = [...stopReasons.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${STOP_LABEL[reason] ?? reason} ×${n}`)
    .join(", ");

  const totals = record?.resources?.totals ?? {};
  const limits = record?.resources?.limits ?? {};

  let stoppingReason;
  if (limitStops.length) {
    stoppingReason = `Attempts recorded an enforced-limit stop (${limitStops.map((r) => STOP_LABEL[r]).join(", ")}).`;
  } else if (attempts.length === 0) {
    stoppingReason = "No attempts are recorded in this run.";
  } else {
    stoppingReason = `No enforced limit was reached. Recorded attempt stop reasons: ${stopSummary}.`;
  }

  /* ---------------- findings ------------------------------------------- */
  const kindRank = (f) => {
    if (f.kind === "defect" && (f.severity === "critical" || f.severity === "high")) return 0;
    if (f.kind === "blocker") return 1;
    // `document-live-disagreement` had rank 2 here. It is retired and is
    // normalized to `defect` before this function ever sees a finding, so the
    // branch is gone rather than left as a rank nothing can reach.
    if (f.kind === "defect") return 3;
    if (f.kind === "other") return 4;
    return 5; // ambiguity is surfaced in its own section but stays sortable
  };
  const itemOrder = new Map(items.map((it, i) => [it.itemId, i]));
  const firstItemPos = (f) => Math.min(...(f.itemRefs || []).map((id) => itemOrder.get(id) ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);

  const decorate = (f) => ({
    ...f,
    kindLabel: KIND_LABEL[f.kind] ?? f.kind,
    supported: (f.evidenceRefs || []).length > 0,
    scorerDisposition: scorecardDispositionFor(scorecard, f.findingId),
    verificationDisposition: {
      state: "not-routed",
      note:
        "Not routed for panel review — RunRecord v1.0.0 carries no VerificationRecord, so this remains an agent-supplied assertion.",
    },
  });

  const actionable = findings
    .filter((f) => f.kind !== "ambiguity")
    .map(decorate)
    .sort(
      (a, b) =>
        kindRank(a) - kindRank(b) ||
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
        firstItemPos(a) - firstItemPos(b) ||
        a.findingId.localeCompare(b.findingId)
    );

  const supportedFindings = actionable.filter((f) => f.supported);
  const unsupportedFindings = actionable.filter((f) => !f.supported);

  const findingsByKind = {};
  const findingsBySeverity = {};
  for (const f of findings) {
    findingsByKind[f.kind] = (findingsByKind[f.kind] || 0) + 1;
    findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] || 0) + 1;
  }

  /* ---------------- document questions (ambiguity / scope) -------------- */
  const ambiguities = findings.filter((f) => f.kind === "ambiguity").map(decorate);
  // Retained as an always-empty array so a consumer reading the old field gets
  // an empty list rather than `undefined`. The kind is retired: see
  // RETIRED_KIND_NORMALIZATION and `retiredKindNormalizations` on the view.
  const disagreements = findings.filter((f) => f.kind === "document-live-disagreement").map(decorate);
  const lowConfidenceItems = rows.filter((r) => r.lowConfidenceExtraction);
  const ambiguousResultItems = rows.filter((r) => r.result?.reason?.code === "ambiguous-requirement");

  /* ---------------- not verifiable from the browser --------------------- */
  const notVerifiable = rows.filter(
    (r) =>
      NOT_VERIFIABLE_COVERAGE.has(r.coverageStatus) ||
      NOT_VERIFIABLE_REASONS.has(r.result?.reason?.code)
  );
  const blockerFindings = findings.filter((f) => f.kind === "blocker").map(decorate);

  /* ---------------- evidence catalogue ---------------------------------- */
  const evidenceRows = evidence.map((e) => ({
    ...e,
    audit: options.evidenceAudit?.get(e.evidenceId) ?? { state: "not-checked" },
  }));
  const evidenceByType = {};
  for (const e of evidence) evidenceByType[e.type] = (evidenceByType[e.type] || 0) + 1;

  /* ---------------- resources ------------------------------------------ */
  const resources = {
    totals,
    limits,
    costUsedUsd: totals.totalCostUsd ?? null,
    costCapUsd: limits.maxCostUsd ?? null,
    wallClockMs: totals.wallClockMilliseconds ?? null,
    wallClockCapMs: limits.maxWallClockMilliseconds ?? null,
    modelCalls: totals.modelCalls ?? null,
    modelCallCap: limits.maxModelCalls ?? null,
    toolCalls: totals.toolCalls ?? null,
    toolCallCap: limits.maxToolCalls ?? null,
    verificationReserveUsd: limits.verificationReserveUsd ?? null,
    reportReserveUsd: limits.reportReserveUsd ?? null,
  };

  /* ---------------- the Requirement Register ----------------------------
   * The register is the report's primary audit body. It is built from the same
   * sealed contract that feeds the flat coverage counts above, so the two can
   * never disagree about the denominator. Register-level structural problems
   * (an aggregate that contradicts its own cases, a not-browser-observable
   * declaration with no reviewed reason) are merged into the same integrity
   * warning list — they are reported, never repaired.
   */
  const register = buildRegister({
    record,
    judgement: options.judgement ?? null,
    judgementTrust: options.judgementTrust ?? null,
    flagLanes: options.flagLanes ?? null,
    evidenceAudit: options.evidenceAudit ?? new Map(),
    findings: [...actionable, ...ambiguities],
    runContext: record?.run?.configuration?.parameters ?? {},
  });
  for (const w of register.warnings) pushWarning(warnings, w.code, w.message);

  /* ---------------- D9: what, if anything, is a CURRENT result ----------
   * "Headline completion and summary metrics are calculated from original
   * itemResults; the re-derived register does not become the current result."
   *
   * A reader must not meet 112 pass / 3 fail first and discover 86 / 4 / 15
   * withheld / 14 without verdict later. Current results come from the TRUSTED
   * column and nowhere else; the as-run column is visibly historical; and when
   * no column is trusted there is no headline verdict count at all.
   */
  const mixedRowIds = new Set(
    register.rows.filter((r) => Object.values(r.cellsByColumn).some((c) => c?.state === "MIXED")).map((r) => r.itemId)
  );
  const runParams = record?.run?.configuration?.parameters ?? {};
  const operationalBlockers = collectOperationalBlockers({ findings, runContext: runParams });
  const operationalBlockerIds = new Set(operationalBlockers.entries.map((e) => e.findingId));
  for (const f of [...actionable, ...ambiguities]) {
    f.respondent = respondentConsequence(f, { operationalBlockerIds, mixedRowIds });
  }

  const columnSummary = (colId) => {
    const dr = register.denominators.documentRequirements.byColumn[colId];
    const ec = register.denominators.executionCases.byColumn[colId];
    if (!dr) return null;
    const col = register.columns.find((c) => c.id === colId);
    return {
      columnId: colId,
      label: col?.label ?? colId,
      publication: col?.publication ?? null,
      roll: dr.roll,
      states: dr.states,
      denominator: register.denominators.documentRequirements.total,
      caseRoll: ec?.roll ?? null,
      caseStates: ec?.states ?? null,
      caseDenominator: register.denominators.executionCases.total,
    };
  };

  const currentColumnId = register.publication.currentColumnId;
  const currentResults = currentColumnId
    ? {
        present: true,
        ...columnSummary(currentColumnId),
        headline: (() => {
          const s = columnSummary(currentColumnId);
          return `${s.roll.fail} failing · ${s.roll.pass} passing · ${s.roll.withheld} withheld · ${s.roll.none} without a verdict, of ${s.denominator} document requirements.`;
        })(),
        note: register.publication.statement,
      }
    : {
        present: false,
        columnId: null,
        label: null,
        headline: "No current result. Nothing on this page may be read as the answer about this survey yet.",
        note: register.publication.statement,
      };

  const asRecorded = {
    ...columnSummary("as-run"),
    historical: true,
    headline: (() => {
      const s = columnSummary("as-run");
      return `${s.roll.fail} failing · ${s.roll.pass} passing · ${s.roll.withheld} withheld · ${s.roll.none} without a verdict, of ${s.denominator} document requirements — as the executing agent recorded them.`;
    })(),
    caveat:
      "Historical. These are the verdicts the executing agent wrote in the same pass that produced the evidence, with nothing re-reading the artifacts to check them. They are shown for the audit trail and are excluded from every current count on this page.",
  };

  const deltaSummary = register.delta?.present ? register.delta.summary ?? {} : null;
  const resultReview = (() => {
    const j = register.publication.judgement;
    const changed = deltaSummary?.changed ?? null;
    if (j.state === "absent") {
      return {
        state: "not-run",
        headline: "not run — no independent stage re-derived these verdicts",
        policyVersion: null,
        changed,
      };
    }
    if (j.state === "trusted") {
      const col = register.columns.find((c) => c.id === currentColumnId);
      return {
        state: "complete",
        headline: `complete${changed !== null ? ` · ${changed} of ${register.denominators.documentRequirements.total} requirement results changed` : ""}`,
        policyVersion: col?.resultPolicyVersion ?? null,
        changed,
      };
    }
    return {
      state: "partial",
      headline: `ran, but its output is NOT publishable — ${j.problems.map((p) => p.code).join(", ") || "unbindable"}`,
      policyVersion: register.columns.find((c) => c.id === "re-derived")?.resultPolicyVersion ?? null,
      changed,
    };
  })();

  const trustStatements = buildTrustStatements({
    attestation,
    evidenceAudit: options.evidenceAudit ?? new Map(),
    evidenceCount: evidence.length,
    revision: register.publication.revision ?? { sealed: false, why: "No contract revision information was resolved for this record." },
    resultReview,
  });

  if (register.denominators.documentRequirements.total !== total) {
    pushWarning(
      warnings,
      "REGISTER_DENOMINATOR_MISMATCH",
      `the register holds ${register.denominators.documentRequirements.total} document requirements but the sealed contract holds ${total}. Neither number was adjusted.`
    );
  }

  const integritySuspect = attestation.state === "invalid" || warnings.length > 0;

  /* ---------------- run context (harness-attested configuration) --------
   * The RunRecord schema is closed: a harness that needs to publish how the
   * run was driven, what it deliberately could not observe, and what it
   * modified has exactly one legal home for it — run.configuration.parameters.
   * Those keys are optional; the report renders whichever are present and
   * says nothing when they are absent. Nothing here is invented by the view.
   */
  const params = record?.run?.configuration?.parameters ?? {};
  const asArray = (v) => (Array.isArray(v) ? v : []);
  const runContext = {
    present: Object.keys(params).length > 0,
    driver: params.driver ?? null,
    disclosedModification: params.disclosedModification ?? params.driver?.disclosed_modification ?? null,
    blindness: params.blindness ?? null,
    models: params.models ?? null,
    scale: params.scale ?? null,
    twoTierDesign: params.twoTierDesign ?? null,
    explorationValue: params.explorationValue ?? null,
    pathDependentBehaviour: params.pathDependentBehaviour ?? null,
    harnessCaveats: asArray(params.harnessCaveats),
    couldNotObserve: asArray(params.couldNotObserve),
    outOfBrowserScopeMandates: asArray(params.outOfBrowserScopeMandates),
    contractIntegrity: params.contractIntegrity ?? null,
    otherKeys: Object.keys(params).filter(
      (k) =>
        ![
          "driver",
          "disclosedModification",
          "blindness",
          "models",
          "scale",
          "twoTierDesign",
          "explorationValue",
          "pathDependentBehaviour",
          "harnessCaveats",
          "couldNotObserve",
          "outOfBrowserScopeMandates",
          "contractIntegrity",
        ].includes(k)
    ),
  };

  // Findings the record attributes to Tier 2 exploration, resolved against the
  // asserted findings so the exploration section links real, evidenced rows.
  const findingById = new Map(findings.map((f) => [f.findingId, f]));
  const resolveIds = (ids) =>
    asArray(ids).map((id) => ({ id, finding: findingById.get(id) ? decorate(findingById.get(id)) : null }));
  const exploration = runContext.explorationValue
    ? {
        present: true,
        question: runContext.explorationValue.question ?? null,
        analysis: runContext.explorationValue.analysis ?? null,
        costNote: runContext.explorationValue.cost_note ?? runContext.explorationValue.costNote ?? null,
        explorationOnly: resolveIds(runContext.explorationValue.exploration_only ?? runContext.explorationValue.explorationOnly),
        floorOnlySufficient: resolveIds(
          runContext.explorationValue.floor_only_sufficient ?? runContext.explorationValue.floorOnlySufficient
        ),
        foundBeforeAnyPath: resolveIds(
          runContext.explorationValue.found_before_any_path ?? runContext.explorationValue.foundBeforeAnyPath
        ),
      }
    : { present: false };

  return {
    viewVersion: REPORT_VIEW_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    fixtureNote: options.fixtureNote ?? null,
    sources: options.sources ?? {},
    record: {
      schemaVersion: record?.schemaVersion ?? null,
      run: record?.run ?? {},
      extraction: record?.contract?.extraction ?? {},
      assumptions: record?.contract?.assumptions ?? [],
      attestationBlock: record?.attestation ?? {},
    },
    attestation,
    integrity: {
      warnings,
      suspect: integritySuspect,
      failClosed: attestation.state === "invalid",
    },
    /* D9 / AMENDMENT A: the publication state and the current-vs-historical
       split. The renderer must lead with these, never with a verdict count. */
    publication: {
      ...register.publication,
      currentResults,
      asRecorded,
      resultReview,
      trustStatements,
      /* WHY there is no re-derived column, when a judgement document EXISTS and was
         rejected. The caller (the Worker's report builder, or the CLI) supplies this
         alongside the trust decision; it was being passed in and then dropped, so a
         rejected judgement rendered identically to a run where the judging stage never
         ran. "Rejected, and here is why" is a different fact from "not run", and the
         renderer must be able to say which. It can only ADD a caveat, never remove one. */
      judgementDiagnostic: options.judgementDiagnostic ?? null,
    },
    operationalBlockers,
    retiredKindNormalizations: normalizedRetiredKinds.map((f) => ({
      findingId: f.findingId,
      from: f.retiredKind,
      to: f.kind,
      why: f.retiredKindNote,
    })),
    completion: {
      report: {
        complete: reportComplete,
        headline: reportComplete
          ? `Report complete — the report accounts for all ${total} extracted obligations.`
          : `Report incomplete — ${missingResults.length} of ${total} extracted obligations have no recorded disposition.`,
        missingResults,
        orphanResults,
      },
      testing: {
        state: testingState,
        headline: TESTING_SENTENCE[testingState],
        stoppingReason,
        stopSummary,
        exercised,
        total,
        unassessed: total - verdictAmongExercised.pass - verdictAmongExercised.fail - verdictAmongExercised.inconclusive,
      },
      oracle: scorecard
        ? {
            present: true,
            testComplete: scorecard.completeness?.testComplete ?? null,
            accounted: scorecard.completeness?.oracleObligationsAccounted ?? null,
            total: scorecard.completeness?.oracleObligations ?? null,
            unaccounted: scorecard.completeness?.unaccountedOracleIds ?? [],
            cohort: scorecard.completeness?.cohort ?? null,
          }
        : { present: false },
    },
    coverage: {
      total,
      exercised,
      counts: coverageCounts,
      verdictCounts,
      verdictAmongExercised,
      unassessedByCause: [...unassessedByCause.entries()].map(([cause, count]) => ({ cause, count })),
      unassessedTotal,
      countsSum,
    },
    findings: {
      all: actionable,
      supported: supportedFindings,
      unsupported: unsupportedFindings,
      byKind: findingsByKind,
      bySeverity: findingsBySeverity,
      totalCount: findings.length,
    },
    documentQuestions: {
      ambiguities,
      disagreements,
      assumptions: record?.contract?.assumptions ?? [],
      lowConfidenceItems,
      ambiguousResultItems,
      rule: {
        name: "report-builder low-confidence rule",
        description: `contract item extraction confidence below ${confidenceFloor.toFixed(2)}`,
        threshold: confidenceFloor,
      },
    },
    notVerifiable: {
      items: notVerifiable,
      blockerFindings,
      outOfBrowserScopeMandates: runContext.outOfBrowserScopeMandates,
      couldNotObserve: runContext.couldNotObserve,
    },
    runContext,
    exploration,
    register,
    audit: { rows, order: "canonical contract.items order (questionnaire order)" },
    attempts,
    evidence: { rows: evidenceRows, byType: evidenceByType, count: evidence.length },
    resources,
    scorecard,
    edgeCoverage: buildEdgeCoverageSummary(options.edgeCoverage),
    labels: {
      COVERAGE_LABEL,
      COVERAGE_GLYPH,
      COVERAGE_MEANING,
      COVERAGE_ORDER,
      VERDICT_LABEL,
      VERDICT_GLYPH,
      VERDICT_TONE,
      VERDICT_ORDER,
      REASON_LABEL,
      STOP_LABEL,
      KIND_LABEL,
    },
  };
}

/**
 * Corpus-only: how the scorer classified this asserted finding against the
 * private oracle. This is scorer adjudication, NOT panel verification, and the
 * renderer labels it as such.
 */
function scorecardDispositionFor(scorecard, findingId) {
  const d = scorecard?.defects;
  if (!d) return null;
  const tp = (d.truePositives || []).find((t) => t.findingId === findingId);
  if (tp) {
    return { state: "matched-seeded-defect", detail: `matched seeded defect ${tp.defectId} (match score ${tp.score})` };
  }
  if ((d.falsePositives || []).includes(findingId)) {
    return { state: "no-seeded-match", detail: "no seeded defect matched this assertion (scorer false positive)" };
  }
  if ((d.redundant || []).includes(findingId)) {
    return { state: "redundant", detail: "duplicate of another assertion that already matched a seeded defect" };
  }
  if ((d.unsupported || []).includes(findingId)) {
    return { state: "unsupported", detail: "scorer rejected the supporting evidence for this assertion" };
  }
  return null;
}

/**
 * Project the durable EdgeCoverageResult into the view shape the renderer
 * consumes. null means unavailable (no StructureModel, no walks, or
 * pre-coverage run); the section is omitted, not zeroed.
 */
function buildEdgeCoverageSummary(raw) {
  if (!raw || typeof raw.denominator !== "number" || !Array.isArray(raw.edges)) return null;
  const untraversedEdges = raw.edges
    .filter((e) => !e.traversed)
    .map((e) => ({ from: e.from, to: e.to, trigger: e.trigger }));
  return {
    denominator: raw.denominator,
    traversed: raw.traversed,
    untouched: raw.untouched,
    untraversedEdges,
  };
}

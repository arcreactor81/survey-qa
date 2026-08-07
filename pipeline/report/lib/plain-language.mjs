// The plain-language layer: AMENDMENT B's vocabulary, computed from the same
// view model the audit trail renders.
//
// This module changes NO data semantics. It is a naming and grouping layer over
// the register that the rest of the pipeline already produced:
//
//   · every register cell state keeps its exact identity in the audit trail;
//     here it is additionally given one of the six plain names the customer
//     view is allowed to use, and a plain reason clause that preserves the
//     distinction the exact state carried;
//   · the publication gate still decides which column is current. When no
//     column is current there is no headline count, exactly as before;
//   · the evidence sentence is COMPUTED over the results actually displayed.
//     A generic green badge is forbidden, so this returns an amber
//     qualification whenever any displayed result lacks re-checked evidence.
//
// Allowed vocabulary (AMENDMENT B): Requirement · Check · Passed · Problem
// found · Needs your decision · Could not test in the browser · Not completed ·
// Evidence · Report ready · Survey ready/not ready.

/* ------------------------------------------------------------------ *
 * The six plain states                                                *
 * ------------------------------------------------------------------ */

export const PLAIN_STATES = [
  { id: "problem", label: "Problem found", glyph: "✕", tone: "fail" },
  { id: "decision", label: "Needs your decision", glyph: "?", tone: "amb" },
  { id: "partial", label: "Partially checked", glyph: "◐", tone: "warn" },
  { id: "no-browser", label: "Could not test in the browser", glyph: "⊘", tone: "nbo" },
  { id: "not-completed", label: "Not completed", glyph: "○", tone: "neutral" },
  { id: "passed", label: "Passed", glyph: "✓", tone: "pass" },
];

export const PLAIN_STATE_ORDER = PLAIN_STATES.map((s) => s.id);
export const PLAIN_STATE_BY_ID = Object.fromEntries(PLAIN_STATES.map((s) => [s.id, s]));

/**
 * Exact register state → plain state + the reason clause that keeps the
 * distinction the exact state carried. Nothing is collapsed silently: two
 * states that share a plain name always carry different reason text, and the
 * exact state is still printed in the row's technical details and in the
 * audit trail.
 */
const PLAIN_BY_CELL_STATE = {
  PASS: { id: "passed", why: "The survey did what the questionnaire says, and the evidence was re-checked." },
  FAIL: { id: "problem", why: "The survey did something different from what the questionnaire says." },
  MIXED: { id: "problem", why: "The survey did the right thing on some answer routes and the wrong thing on others." },
  AMBIGUOUS: {
    id: "decision",
    why: "The questionnaire can be read two ways here, so we have not judged the survey until you tell us which reading is right.",
  },
  INCOMPLETE: {
    id: "partial",
    why: "At least one answer route under this requirement was never finished, so it cannot be called passed.",
  },
  NOT_BROWSER_OBSERVABLE: {
    id: "no-browser",
    why: "No browser session can settle this one. It needs a different way of checking.",
  },
  BLOCKED: { id: "no-browser", why: "Something outside the questionnaire stopped us from reaching this in the browser." },
  JUDGMENT_PENDING: {
    id: "not-completed",
    why: "A result was recorded, but its evidence did not hold up when we re-checked it, so we are not publishing it.",
  },
  UNSUPPORTED: { id: "not-completed", why: "A result was recorded with no evidence attached, so we are not publishing it." },
  NOT_REACHED: { id: "not-completed", why: "The screen this requirement describes was never reached, so nothing was seen." },
  PROVEN_UNREACHABLE: { id: "not-completed", why: "The evidence shows this screen cannot be reached at all." },
  PENDING: { id: "not-completed", why: "This check did not reach a result before the run ended." },
  NOT_ASSESSED: { id: "not-completed", why: "No result was reached for this requirement." },
  BUDGET_EXHAUSTED: { id: "not-completed", why: "Testing stopped at the agreed spending limit before this was checked." },
  TIME_EXHAUSTED: { id: "not-completed", why: "Testing stopped at the agreed time limit before this was checked." },
  DOCUMENT_SILENT: { id: "not-completed", why: "The questionnaire says nothing about this, so there is nothing to check it against." },
  EXPLICIT_NEGATIVE: { id: "not-completed", why: "The questionnaire requires this behaviour to be absent; the row constrains what must not happen." },
  NOT_IN_CONTRACT: { id: "not-completed", why: "This requirement was not part of the list this run was tested against." },
};

/** @returns {{id:string,label:string,glyph:string,tone:string,why:string,exact:string}} */
export function plainState(cellState) {
  const hit = PLAIN_BY_CELL_STATE[cellState];
  if (!hit) {
    return { ...PLAIN_STATE_BY_ID["not-completed"], why: "No result was reached for this requirement.", exact: cellState ?? "(none)" };
  }
  return { ...PLAIN_STATE_BY_ID[hit.id], why: hit.why, exact: cellState };
}

/* ------------------------------------------------------------------ *
 * Evidence backing — computed per displayed result                     *
 * ------------------------------------------------------------------ */

/**
 * Is the result shown in this cell backed by evidence that was re-checked?
 *
 * Deterministic and conservative:
 *   · a result with no cited evidence at all is NOT backed;
 *   · a result carrying a witness that failed re-verification is NOT backed;
 *   · a fail the register already flagged `evidenceUnverified` is NOT backed
 *     (it stays a fail — the register keeps it — but it does not let the page
 *     claim every displayed result was re-checked).
 */
export function evidenceBacked(cell) {
  if (!cell) return false;
  const witnesses = Array.isArray(cell.evidence) ? cell.evidence : [];
  const totals = cell.evidenceTotals || {};
  const cited = (totals.supporting || 0) + (totals.counter || 0) || witnesses.length;
  if (!cited) return false;
  if (cell.evidenceUnverified) return false;
  if (witnesses.some((w) => w.judgeReverified === "failed")) return false;
  return witnesses.some((w) => w.judgeReverified === "verified");
}

/* ------------------------------------------------------------------ *
 * Finding lanes                                                        *
 * ------------------------------------------------------------------ */

const NOT_BROWSER_CATEGORIES = new Set(["not-browser-observable"]);

/**
 * `Confirmed` or `Needs review` — never a decimal confidence and never an
 * N-of-3 scoreboard. AMENDMENT B: "Preserve dissent by making the finding
 * inconclusive, not by displaying model votes."
 *
 * Confirmed requires BOTH: the finding cites evidence, AND the current column
 * independently landed on a problem for at least one requirement it names.
 * Anything less is `Needs review`.
 */
export function confirmationOf(finding, { rowsById, currentColumnId, conditioningIds = new Set() }) {
  const supported = Array.isArray(finding.evidenceRefs) && finding.evidenceRefs.length > 0;
  const refs = Array.isArray(finding.itemRefs) ? finding.itemRefs : [];
  const agreeing = refs.filter((id) => {
    const row = rowsById.get(id);
    const cell = row?.cellsByColumn?.[currentColumnId];
    return cell && (cell.state === "FAIL" || cell.state === "MIXED");
  });
  // A finding the record's own disclosed change names as the reason the run
  // was possible at all is confirmed by the run itself: the survey had to be
  // modified before a single check could be made.
  if (supported && conditioningIds.has(finding.findingId)) {
    return {
      id: "confirmed",
      label: "Confirmed",
      why: "Cited evidence, and the survey had to be changed before any check could run at all.",
    };
  }
  if (supported && agreeing.length) {
    return {
      id: "confirmed",
      label: "Confirmed",
      why: `Cited evidence, and the independent re-check reached the same problem on ${agreeing.length} requirement${agreeing.length === 1 ? "" : "s"}.`,
    };
  }
  return {
    id: "needs-review",
    label: "Needs review",
    why: !supported
      ? "This was reported without evidence attached, so it has not been confirmed."
      : "The independent re-check did not land on the same problem, so this is not confirmed.",
  };
}

/* ------------------------------------------------------------------ *
 * The decision summary                                                 *
 * ------------------------------------------------------------------ */

function pluralise(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "a, b and c" — an English list, so a computed sentence still reads as a sentence. */
function joinList(parts) {
  const list = parts.filter(Boolean);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/* ------------------------------------------------------------------ *
 * Ranking the questions the reader has to answer                       *
 * ------------------------------------------------------------------ *
 * The reader's first question about a list of nineteen is "which of these
 * actually block fielding?" — and a list in record order cannot answer it. So
 * every ambiguity is ranked by ONE test: what changes if you answer it.
 *
 * The ranks are computed from the register, not assigned by hand:
 *
 *   1 could-change-launch  a requirement's judgment is withheld here and the
 *                          evidence already recorded would make it a FAIL under
 *                          one reading. Answering it can create a defect.
 *   2 behaviour-seen       the run watched the survey do something and the
 *                          document does not settle whether it is wrong. There
 *                          is a stated respondent consequence attached.
 *   3 result-withheld      a requirement is waiting on the answer, but the
 *                          recorded behaviour satisfies BOTH readings, so the
 *                          worst case is a pass.
 *   4 wording-only         no requirement is waiting on it at all.
 *
 * Ranks 1 and 2 are the ones that can change the launch decision; 3 and 4
 * change what the report can say, not whether the survey can be fielded.
 */
export const DECISION_RANKS = [
  {
    id: "could-change-launch",
    order: 0,
    changesLaunch: true,
    label: "Could change the launch decision",
    why: "One reading of the questionnaire makes what we already recorded a programming problem. Answering this can turn a withheld result into a defect.",
  },
  {
    id: "behaviour-seen",
    order: 1,
    changesLaunch: true,
    label: "Could change the launch decision",
    why: "We watched the survey do this and the questionnaire does not settle whether it is wrong. There is a real effect on the respondent either way, so this is a judgement about your study, not about wording.",
  },
  {
    id: "result-withheld",
    order: 2,
    changesLaunch: false,
    label: "Settles a withheld result",
    why: "A requirement is waiting on your answer, but what the survey actually did satisfies both readings. The worst case here is a pass, so it does not change whether you can field.",
  },
  {
    id: "wording-only",
    order: 3,
    changesLaunch: false,
    label: "Changes the questionnaire, not the survey",
    why: "No requirement is waiting on this. It decides how the questionnaire should be read for the next round, not what the survey does today.",
  },
];

const RANK_BY_ID = Object.fromEntries(DECISION_RANKS.map((r) => [r.id, r]));

/** Consequence classes that mean "a respondent is actually affected". */
const MATERIAL_CONSEQUENCE = (cls) => Boolean(cls) && cls !== "undetermined" && cls !== "presentation-only";

export function rankDecision(finding, { rowsById, currentColumnId }) {
  const cells = (finding.itemRefs || [])
    .map((id) => rowsById.get(id)?.cellsByColumn?.[currentColumnId])
    .filter(Boolean);
  if (cells.some((c) => c.state === "AMBIGUOUS" && c.wouldHaveBeen === "fail")) return RANK_BY_ID["could-change-launch"];
  if (MATERIAL_CONSEQUENCE(finding.respondent?.class)) return RANK_BY_ID["behaviour-seen"];
  if (cells.some((c) => c.state === "AMBIGUOUS")) return RANK_BY_ID["result-withheld"];
  return RANK_BY_ID["wording-only"];
}

/**
 * Everything the Summary view needs, computed from the view model.
 * No literal counts are hard-coded anywhere: if the run changes, every number
 * and every sentence on the first screen changes with it.
 */
export function buildDecisionSummary(view) {
  const reg = view.register;
  const currentColumnId = reg.publication.currentColumnId;
  const rowsById = new Map(reg.rows.map((r) => [r.itemId, r]));
  const total = reg.denominators.documentRequirements.total;

  /* ---- the six plain buckets, from the current column only ---- */
  const counts = Object.fromEntries(PLAIN_STATE_ORDER.map((id) => [id, 0]));
  const byPlain = Object.fromEntries(PLAIN_STATE_ORDER.map((id) => [id, []]));
  if (currentColumnId) {
    for (const row of reg.rows) {
      const cell = row.cellsByColumn?.[currentColumnId];
      const p = plainState(cell?.state);
      counts[p.id] += 1;
      byPlain[p.id].push(row);
    }
  }
  const countsKnown = Boolean(currentColumnId);

  /* ---- lanes, in the ABSOLUTE first-screen order ---- */
  const blockerIds = new Set(view.operationalBlockers.entries.map((e) => e.findingId));
  const launchBlockerIds = new Set(view.operationalBlockers.conditioning.map((e) => e.findingId));

  const launchBlockers = view.findings.all.filter((f) => launchBlockerIds.has(f.findingId));
  const cannotTest = view.findings.all.filter(
    (f) => !launchBlockerIds.has(f.findingId) && (blockerIds.has(f.findingId) || NOT_BROWSER_CATEGORIES.has(f.category))
  );
  const cannotTestIds = new Set(cannotTest.map((f) => f.findingId));
  const problems = view.findings.all.filter(
    (f) => !launchBlockerIds.has(f.findingId) && !cannotTestIds.has(f.findingId)
  );
  const decisions = view.documentQuestions.ambiguities;

  const conditioningIds = new Set(view.operationalBlockers.conditioning.map((e) => e.findingId));
  const withConfirmation = (list) =>
    list.map((f) => ({ ...f, confirmation: confirmationOf(f, { rowsById, currentColumnId, conditioningIds }) }));

  /* ---- the scoped evidence sentence ----------------------------------
   * ONE derivation, ONE vocabulary. The build this replaces said "Evidence was
   * rechecked for 90 of the 95 results shown on this page" while the panel
   * below it said "90 settled · 29 still unresolved": two different 90s and a
   * 95 that appeared nowhere else on the page. `result` is not a unit this
   * report counts anywhere — REQUIREMENT and FINDING are. So the sentence now
   * counts those two, separately and by name, and its requirement total is the
   * SAME 90 the coverage line calls settled.
   */
  const settledRows = currentColumnId ? [...byPlain.problem, ...byPlain.passed] : [];
  const backedRows = settledRows.filter((row) => evidenceBacked(row.cellsByColumn[currentColumnId]));
  const unbackedRows = settledRows.filter((row) => !evidenceBacked(row.cellsByColumn[currentColumnId]));
  const shownFindings = [...launchBlockers, ...problems];
  const backedFindings = shownFindings.filter((f) => Array.isArray(f.evidenceRefs) && f.evidenceRefs.length > 0);
  const unbackedFindings = shownFindings.filter((f) => !(Array.isArray(f.evidenceRefs) && f.evidenceRefs.length > 0));
  const shownTotal = settledRows.length + shownFindings.length;
  const unbackedTotal = unbackedRows.length + unbackedFindings.length;

  const reqClause = settledRows.length
    ? unbackedRows.length === 0
      ? `all ${pluralise(settledRows.length, "settled requirement", "settled requirements")}`
      : `${backedRows.length} of the ${pluralise(settledRows.length, "settled requirement", "settled requirements")}`
    : null;
  const findingClause = shownFindings.length
    ? unbackedFindings.length === 0
      ? `all ${pluralise(shownFindings.length, "finding", "findings")} on this page`
      : `${backedFindings.length} of the ${pluralise(shownFindings.length, "findings", "findings")} on this page`
    : null;

  const evidenceLine = !shownTotal
    ? {
        tone: "warn",
        headline: "No result on this page is being shown as settled, so there is nothing to re-check yet.",
        detail: "This sentence describes the requirements and findings shown on this page. This run has none to describe.",
        scope: "nothing shown",
      }
    : unbackedTotal === 0
      ? {
          tone: "ok",
          headline: `Evidence was rechecked for ${joinList([reqClause, findingClause])}.`,
          detail:
            "Every one of them cites at least one evidence file that was re-read and re-checked after the run. “Settled” means the requirement reached Passed or Problem found; the other requirements are accounted for below.",
          scope: `${settledRows.length} settled requirements · ${shownFindings.length} findings`,
        }
      : {
          tone: "warn",
          headline: `Evidence was rechecked for ${joinList([reqClause, findingClause])}.`,
          detail: `${pluralise(unbackedTotal, "is", "are")} shown without a rechecked evidence file${
            unbackedTotal === shownTotal ? " — nothing on this page has re-checked evidence behind it" : ""
          }. They are listed in the full check with the reason beside each one.`,
          scope: `${backedRows.length} of ${settledRows.length} settled requirements · ${backedFindings.length} of ${shownFindings.length} findings`,
          unbacked: [...unbackedRows.map((r) => r.itemId), ...unbackedFindings.map((f) => f.findingId)],
        };

  /* ---- report ready vs survey ready ---- */
  const surveyReady =
    countsKnown && launchBlockers.length === 0 && counts.problem === 0 && counts.decision === 0 && counts.partial === 0;
  const reportReady = view.completion.report.complete && !view.integrity.failClosed;

  /* ---- the headline, computed ---- */
  let headline;
  let lede;
  if (!countsKnown) {
    headline = "We cannot tell you yet whether this survey is ready";
    lede =
      "No result on this run has cleared our own evidence check, so there is nothing on this page you should act on as a finding about your survey.";
  } else if (launchBlockers.length) {
    headline = "Do not launch this survey yet";
    lede =
      launchBlockers.length === 1
        ? "The survey does not open in a standard browser. Fix this launch blocker first, then rerun."
        : `${launchBlockers.length} launch blockers stop the survey opening as a respondent would see it. Fix them first, then rerun.`;
  } else if (counts.problem) {
    headline = "This survey is not ready to field";
    lede = `We found ${pluralise(counts.problem, "requirement", "requirements")} where the survey does not do what the questionnaire says.`;
  } else if (counts.decision || counts.partial) {
    headline = "This survey needs your answers before it is ready";
    lede = "We found no programming problem, but some questions are still open.";
  } else {
    headline = "This survey matches the questionnaire on every completed check";
    lede = "No problem was found on any requirement that reached a result.";
  }

  /* ---- the follow-on sentence, computed ---- */
  const followParts = [];
  if (problems.length)
    followParts.push(
      `${launchBlockers.length ? "also found" : "found"} <strong>${pluralise(
        problems.length,
        "programming problem",
        "programming problems"
      )}</strong>`
    );
  if (decisions.length)
    followParts.push(`need your decision on <strong>${pluralise(decisions.length, "questionnaire question", "questionnaire questions")}</strong>`);
  const follow = followParts.length ? `We ${followParts.join(" and ")}.` : "";

  /* ---- THE FOLD MUST ACCOUNT FOR ALL 119 -----------------------------
   * The build this replaces said "86 requirements passed the completed
   * checks" and stopped. 14 requirements were never completed and 3 were only
   * partly checked, and neither number appeared anywhere above the fold: the
   * phrase "the completed checks" hinted at unfinished work and then withheld
   * it. That is the omission failure the amendment exists to prevent, so the
   * first screen now reconciles to the full denominator or it says nothing.
   */
  const passedSentence = countsKnown ? `<strong>${counts.passed} of the ${total} requirements passed.</strong>` : "";
  const notPassed = countsKnown ? total - counts.passed : 0;
  const accountingParts = countsKnown
    ? [
        counts.problem ? `<strong>${counts.problem}</strong> ${counts.problem === 1 ? "is a programming problem" : "are programming problems"}` : null,
        counts.decision
          ? `<strong>${counts.decision}</strong> ${counts.decision === 1 ? "is waiting" : "are waiting"} on your answers below`
          : null,
        counts.partial ? `<strong>${counts.partial}</strong> ${counts.partial === 1 ? "was" : "were"} only partly checked` : null,
        counts["no-browser"]
          ? `<strong>${counts["no-browser"]}</strong> cannot be checked in a browser at all`
          : null,
        counts["not-completed"]
          ? `<strong>${counts["not-completed"]}</strong> ${counts["not-completed"] === 1 ? "was never completed" : "were never completed"}`
          : null,
      ].filter(Boolean)
    : [];
  const accountingSentence =
    countsKnown && notPassed > 0
      ? `The other ${notPassed} did not: ${joinList(accountingParts)}. None of them is a pass.`
      : countsKnown
        ? "Every requirement in the questionnaire reached a result."
        : "";

  /* ---- the run-shape explanation, only when the shape needs one ---- */
  const modification = view.runContext?.disclosedModification ?? null;
  const continuedAfterBlocker = Boolean(launchBlockers.length && modification && counts.passed > 0);
  const shapeNote = continuedAfterBlocker
    ? "After recording the launch failure, the remaining checks continued in the controlled test environment. Rerun the complete test after fixing the blocker."
    : null;

  /* ---- what was checked and what remains unresolved (GPT's pushback) ----
   * Same six buckets, same derivation, spelled out rather than summed into two
   * opaque totals. `settled` here is the SAME number the evidence sentence
   * calls settled requirements, and the parenthetical says which buckets each
   * total is made of, so no number on the page can be read as a different
   * number somewhere else.
   */
  const unresolved = counts.decision + counts.partial + counts["no-browser"] + counts["not-completed"];
  const coverageLine = countsKnown
    ? `Full check: ${total} requirements · ${counts.passed + counts.problem} settled (${counts.passed} passed, ${
        counts.problem
      } with a problem) · ${unresolved} still unresolved (${joinList(
        [
          counts.decision ? `${counts.decision} waiting on your answers` : null,
          counts.partial ? `${counts.partial} partly checked` : null,
          counts["no-browser"] ? `${counts["no-browser"]} not checkable in a browser` : null,
          counts["not-completed"] ? `${counts["not-completed"]} never completed` : null,
        ].filter(Boolean)
      )})`
    : `Full check: ${total} requirements · no settled result yet`;

  /* ---- the decision lane, ranked and reconciled -----------------------
   * 19 questions, 11 requirements. Both numbers are true and they count
   * different things, so the page states the relationship instead of leaving
   * a reader to find two totals and distrust both.
   */
  const rankedDecisions = decisions
    .map((f) => ({ ...f, rank: rankDecision(f, { rowsById, currentColumnId }) }))
    .sort((a, b) => a.rank.order - b.rank.order);
  const decisionsChangingLaunch = rankedDecisions.filter((f) => f.rank.changesLaunch).length;
  const decisionRankCounts = Object.fromEntries(
    DECISION_RANKS.map((r) => [r.id, rankedDecisions.filter((f) => f.rank.id === r.id).length])
  );
  const decisionAffectedRequirements = counts.decision;
  const decisionLaneLede = rankedDecisions.length
    ? `${
        decisionsChangingLaunch
          ? `<strong>${decisionsChangingLaunch} of these ${rankedDecisions.length} could change whether you field this survey</strong>, and ${
              rankedDecisions.length - decisionsChangingLaunch === 1 ? "the other one changes" : `the other ${rankedDecisions.length - decisionsChangingLaunch} change`
            } what we can report about it. They are ordered that way.`
          : `None of these ${rankedDecisions.length} can change whether you field this survey; they change what we can report about it.`
      } Until you answer them we are not judging the survey on <strong>${decisionAffectedRequirements} of the ${total} requirements</strong>${
        decisionAffectedRequirements ? ", which are listed as <em>Needs your decision</em> in the full check" : ""
      }.`
    : "";

  return {
    currentColumnId,
    countsKnown,
    counts,
    byPlain,
    total,
    headline,
    lede,
    follow,
    passedSentence,
    accountingSentence,
    notPassed,
    shapeNote,
    evidenceLine,
    coverageLine,
    unresolved,
    decisionsChangingLaunch,
    decisionRankCounts,
    decisionAffectedRequirements,
    decisionLaneLede,
    surveyReady,
    reportReady,
    readinessLine: `${reportReady ? "Report ready" : "Report incomplete"} · ${surveyReady ? "Survey ready" : "Survey not ready"}`,
    launchBlockers: withConfirmation(launchBlockers),
    problems: withConfirmation(problems),
    cannotTest: withConfirmation(cannotTest),
    decisions: withConfirmation(rankedDecisions).map((f, i) => ({ ...f, rank: rankedDecisions[i].rank })),
    rowsById,
  };
}

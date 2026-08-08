// The Summary view — the customer-facing decision summary (AMENDMENT B).
//
// The visual order on the first screen is ABSOLUTE and is not data-dependent:
//   1 launch blocker → 2 programming problems → 3 decisions needed →
//   4 passed checks, quietly last, never an equal green tile beside a blocker.
//
// Everything here is computed from lib/plain-language.mjs, which is computed
// from the register. No count and no sentence on this page is hard-coded.
//
// Vocabulary is restricted to AMENDMENT B's allowlist. Identifiers, hashes,
// versions, predicates and locators appear only inside the nested
// `Technical details` disclosure, which is the technical-provenance layer the
// amendment places behind a second disclosure.

import { esc } from "./esc.mjs";
import { PLAIN_STATES } from "./plain-language.mjs";
import { plainify, headline, requirementLabel, readableValue, READING_PREFIX } from "./plain-text.mjs";
import { screenShowedBlock } from "./evidence-block.mjs";

/* ----------------------------- helpers ----------------------------- */

const TOPIC = {
  "load-time-crash": "Survey will not open",
  "missing-answer-option": "Answer options",
  "wrong-answer-option-text": "Answer options",
  "routing-mismatch": "Routing",
  "wrong-skip": "Routing",
  "mobile-grid-layout": "Mobile layout",
  "mobile-scale-layout": "Mobile layout",
  "validation-message-wording": "On-screen wording",
  "line-break-fidelity": "On-screen wording",
  "orphaned-answer-retention": "Stored answers",
  "specify-box-visibility": "Question layout",
  "not-browser-observable": "Needs another way of checking",
  "document-ambiguity": "Questionnaire wording",
};

const IMPACT = {
  critical: "High impact",
  high: "High impact",
  medium: "Medium impact",
  low: "Low impact",
  info: "For information",
};

/**
 * The problem, in one plain phrase. A FIXED LOOKUP over the categories the
 * pipeline emits — the same discipline as lib/respondent-consequence.mjs, and
 * for the same reason: a record summary is written for an engineer and carries
 * row ids and internal vocabulary, so it cannot be the customer headline. When
 * a category has no entry the card falls back to the record's own words rather
 * than inventing a phrase.
 */
const PROBLEM_PHRASE = {
  "load-time-crash": "the survey does not open",
  "missing-answer-option": "an answer option is missing",
  "wrong-answer-option-text": "an answer option shows the wrong text",
  "routing-mismatch": "respondents are sent to the wrong question",
  "wrong-skip": "respondents are sent to the wrong question",
  "mobile-grid-layout": "the question is materially harder to answer on a phone",
  "mobile-scale-layout": "the scale is arranged differently on a phone",
  "validation-message-wording": "the on-screen message is not the one specified",
  "orphaned-answer-retention": "an answer is kept after it should have been cleared",
  "specify-box-visibility": "the write-in box is shown before its option is chosen",
  "line-break-fidelity": "the text is laid out differently from the questionnaire",
  "not-browser-observable": "this cannot be checked from a browser",
  "document-ambiguity": "the questionnaire can be read two ways",
};

/**
 * What the SURVEY did, in one plain phrase — the fallback for when the record's
 * own `observed` string is entirely engineering.
 *
 * The shipped build printed `finding.observed` verbatim, so the first card a
 * reader met opened with a JavaScript stack frame, a DOM container id and two
 * URL schemes. The raw string is not deleted: it is rendered under `Technical
 * details` on the same card, which is where the amendment's layer map puts it.
 */
const OBSERVED_PHRASE = {
  "load-time-crash": "The survey did not open. The page stayed blank and no question was ever shown.",
  "missing-answer-option": "That option was not on screen in any observation of the question.",
  "wrong-answer-option-text": "The option under that code showed different text on screen.",
  "routing-mismatch": "Respondents were taken to a different screen.",
  "wrong-skip": "Respondents were taken to a different screen.",
  "mobile-grid-layout": "On a phone every statement was shown at once instead of one at a time.",
  "mobile-scale-layout": "On a phone the scale points were arranged differently from the desktop layout.",
  "validation-message-wording": "A different message was shown.",
  "orphaned-answer-retention": "The earlier answer was still there.",
  "specify-box-visibility": "The write-in box was on screen before its option was chosen.",
  "line-break-fidelity": "The wording matched; the paragraph breaks did not.",
  "not-browser-observable": "A browser session cannot see this, so nothing was observed either way.",
};

/**
 * What the reader must DECIDE, in one plain phrase, for ambiguities the run
 * derived from something it watched rather than from the document's wording.
 * `document-ambiguity` is deliberately absent: those findings carry a plain
 * English sentence of their own, and `unclearPhrase` uses it.
 */
const UNCLEAR_PHRASE = {
  "mobile-scale-layout": "the questionnaire does not say how this scale should be arranged on a phone",
  "mobile-grid-layout": "the questionnaire does not say how this question should be laid out on a phone",
  "orphaned-answer-retention":
    "the questionnaire does not say whether an answer should be cleared once the respondent stops being asked the question",
  "specify-box-visibility": "the questionnaire does not say whether the write-in box should stay hidden until its option is chosen",
  "line-break-fidelity": "the questionnaire does not say whether its printed line breaks have to be reproduced on screen",
  "validation-message-wording": "the questionnaire does not say which message an empty write-in box should show",
  "not-browser-observable": "this cannot be settled from a browser, so somebody has to check it another way",
};

/** The last resort. A fixed short form, never the raw record text. */
const UNCLEAR_FALLBACK = "the questionnaire wording here can be read two ways";

const FIX_PHRASE = {
  "load-time-crash": "Fix the script error that stops the page rendering, then confirm the first screen appears in a standard browser.",
  "missing-answer-option": "Add the missing answer option to the question, under the code the questionnaire assigns it.",
  "wrong-answer-option-text": "Correct the option label so it matches the questionnaire text for that code.",
  "routing-mismatch": "Correct the next-screen rule for the answer named above so it goes where the questionnaire says.",
  "wrong-skip": "Correct the next-screen rule for the answer named above so it goes where the questionnaire says.",
  "mobile-grid-layout": "Rework the phone layout of this question so it can be answered as easily as on a desktop.",
  "mobile-scale-layout": "Present the scale points in the same arrangement on a phone as on a desktop.",
  "validation-message-wording": "Replace the on-screen message with the wording the questionnaire specifies.",
  "orphaned-answer-retention": "Clear the stored answer when the earlier answer changes so the question is skipped.",
  "specify-box-visibility": "Show the write-in box only after its option is selected.",
  "line-break-fidelity": "Match the paragraph breaks on screen to the questionnaire text.",
};

function topicOf(f) {
  return TOPIC[f.category] ?? "Other";
}

function impactOf(f) {
  return IMPACT[f.severity] ?? "Impact not classified";
}

/** The question a reader recognises, taken from the record — never invented. */
function questionLabel(f, rowsById) {
  // A finding the record classes as universal is about the whole interview, not
  // about one question, however many requirement rows it happens to name.
  if (f.respondent?.reach?.id === "universal") return "Whole survey";
  const row = (f.itemRefs || []).map((id) => rowsById.get(id)).find(Boolean);
  // A rule the contract scopes over the whole interview is about the whole
  // interview, whichever section of the document happens to state it.
  if (row?.scopeKind === "global" || row?.scopeKind === "cross-cutting" || row?.pinned) return "Whole survey";
  const haystack = [row?.requirement, row?.expectedObservable, f.summary, f.expected].filter(Boolean).join(" ");
  // Question and screen names as the questionnaire writes them: Q1…Q9, S1, S2,
  // D1. The build this replaces matched only `Q\d`, so every finding about a
  // screening or demographic screen fell through to an internal section code.
  const m = haystack.match(/\b(?:Q\d+[A-Za-z]?|[SD]\d+)\b/);
  if (m) return m[0];
  if (row?.section && row.section !== "GLOBAL") return `Section ${row.section}`;
  return "Whole survey";
}

/** The finding headline: where it is, and what is wrong, in plain words. */
function findingTitle(f, rowsById) {
  const phrase = PROBLEM_PHRASE[f.category];
  if (phrase) return `${questionLabel(f, rowsById)} · ${phrase}`;
  // No fixed phrase for this category: use the record's own words, cleaned of
  // engineering and cut at a WORD boundary. `headline` returns null rather than
  // cut inside a word, and then the card says what kind of thing it is instead
  // of dumping the record.
  const plain = plainify(f.summary, { maxChars: 400, stripMetaTail: true }).text;
  const short = plain ? headline(plain, { maxChars: 130 }) : null;
  return `${questionLabel(f, rowsById)} · ${short ?? "the survey does not match the questionnaire here"}`;
}

/**
 * What this ambiguity is about, in survey language.
 *
 * The build this replaces had no such function: the 19 decision cards fell back
 * to `finding.summary.slice(0, 150)`, which shipped titles ending "… The
 * document g" and "… Retaining the respo", with pixel coordinates in the
 * headline. Ambiguity cards now get exactly the treatment the defect cards
 * already had — a fixed phrase where the category has one, the record's own
 * plain sentence where it does not, and a fixed short form when neither can be
 * composed. Nothing is ever cut inside a word.
 */
function unclearPhrase(f) {
  const fixed = UNCLEAR_PHRASE[f.category];
  if (fixed) return fixed;
  const plain = plainify(f.summary, { maxChars: 400, stripMetaTail: true }).text;
  const short = plain ? headline(plain, { maxChars: 130 }) : null;
  return short ?? UNCLEAR_FALLBACK;
}

function badge(tone, label) {
  return `<span class="pstate pstate--${esc(tone)}">${esc(label)}</span>`;
}

/**
 * Recommended fix — a mechanical restatement of the recorded expected/observed
 * pair plus the recorded re-test step. Nothing is invented: where the record
 * carries no expectation, the card says a reviewer must write one.
 */
function recommendedFix(f) {
  const retest = f.respondent?.retest || null;
  const fix =
    FIX_PHRASE[f.category] ??
    (f.expected
      ? "Change the survey so it does what the questionnaire says above."
      : "This record does not say what the questionnaire requires here, so no fix can be stated from it. A reviewer must write the fix.");
  return retest ? `${fix} Then re-check it: ${retest}` : fix;
}

/* --------------------------- evidence drawer ------------------------ */

function evidenceRowsFor(f, view) {
  const byId = new Map(view.evidence.rows.map((e) => [e.evidenceId, e]));
  return (f.evidenceRefs || []).map((id) => byId.get(id) ?? { evidenceId: id, missing: true });
}

function attemptsFor(f, view) {
  const byId = new Map(view.attempts.map((a) => [a.attemptId, a]));
  return (f.attemptRefs || []).map((id) => byId.get(id)).filter(Boolean);
}

/**
 * The answer path, as a respondent would describe it.
 *
 * The build this replaces printed the raw action trace under the heading "The
 * answers we gave", so the first evidence drawer on the page opened with
 * `step · http://127.0.0.1:8750/index.html → step · 1280x900` — a localhost URL
 * and a viewport size, in the sentence that is supposed to say which answers
 * produced the finding. The trace is not deleted: the full ordered action list,
 * with targets, parameters and state ids, is in the Audit trail's attempt
 * ledger, and every action id is in Technical details.
 *
 * Actions are grouped by the question they touched, so a question answered with
 * three clicks and a write-in reads as one line.
 */
const FIELD_QUESTION = /^([QSD]\d+[A-Za-z]?)_/;

function stepLabel(a) {
  const op = String(a.operation ?? a.kind ?? a.type ?? "");
  const target = String(a.target ?? "");
  if (/^open-target$|^navigate$|^goto$/.test(op)) return { question: null, text: "Opened the survey" };
  if (/back/i.test(op) || /^Back$/i.test(target)) return { question: null, text: "Went back" };
  if (/^click-navigation$/.test(op)) return { question: null, text: null, advance: true };
  if (/^type-text$|^type$|^fill$/.test(op)) {
    const q = a.parameters?.question ?? (FIELD_QUESTION.exec(target) || [])[1] ?? null;
    return { question: q, text: "typed into the write-in box" };
  }
  if (/^click$|^select$|^choose$/.test(op)) {
    return { question: a.parameters?.question ?? null, text: target || "made a selection" };
  }
  return { question: null, text: null };
}

function answerSequence(attempt) {
  const actions = Array.isArray(attempt?.actions) ? attempt.actions : [];
  if (!actions.length) return null;
  const steps = [];
  for (const a of actions.slice(0, 40)) {
    const s = stepLabel(a);
    if (!s.text) continue;
    // Every label goes through the same filter as the rest of the page, so an
    // operation this function has never seen cannot smuggle a URL, a viewport
    // size or an element id into customer copy.
    const safe = plainify(s.text, { maxChars: 120 }).text;
    if (!safe) continue;
    const last = steps[steps.length - 1];
    if (last && s.question && last.question === s.question) {
      if (!last.answers.includes(safe)) last.answers.push(safe);
      continue;
    }
    steps.push({ question: s.question, answers: [safe] });
  }
  if (!steps.length) return null;
  return steps
    .slice(0, 14)
    .map((s) => `${s.question ? `${s.question}: ` : ""}${s.answers.join(", ")}`)
    .join(" → ");
}

function evidenceState(e) {
  if (e.missing) return "not in the evidence list";
  const s = e.audit?.state;
  if (s === "verified") return "file re-checked and matches";
  if (s === "mismatch") return "file does NOT match what was recorded";
  if (s === "missing") return "file not present in this copy";
  return "file not re-checked in this copy of the report";
}

function technicalDetails(f, view, rowsById) {
  const rows = (f.itemRefs || []).map((id) => rowsById.get(id)).filter(Boolean);
  const colId = view.register.publication.currentColumnId;
  const lines = [];
  lines.push(["Finding id", f.findingId]);
  lines.push(["Requirement ids", (f.itemRefs || []).join(", ") || "none"]);
  lines.push(["Attempt ids", (f.attemptRefs || []).join(", ") || "none"]);
  lines.push(["Evidence ids", (f.evidenceRefs || []).join(", ") || "none"]);
  lines.push(["Reported severity / category", `${f.severity ?? "none"} / ${f.category ?? "none"}`]);
  lines.push(["Reported confidence", typeof f.confidence === "number" ? f.confidence.toFixed(2) : "not recorded"]);
  // THE RAW RECORD TEXT, unedited — stack frames, DOM ids, viewport geometry
  // and all. The card above shows the plain-language reading of these; this is
  // the string the run actually wrote, so a reader can check the translation.
  if (f.summary) lines.push(["Recorded summary (as the run wrote it)", f.summary]);
  if (f.expected) lines.push(["Recorded expectation (as the run wrote it)", f.expected]);
  if (f.observed) lines.push(["Recorded observation (as the run wrote it)", f.observed]);
  for (const row of rows) {
    const cell = row.cellsByColumn?.[colId];
    lines.push([`${row.itemId} · register state`, cell?.state ?? "no current cell"]);
    if (row.compiled?.predicateId) {
      lines.push([`${row.itemId} · predicate`, `${row.compiled.predicateId} → ${row.compiled.predicateOutcome ?? "no outcome"}`]);
    }
    if (row.sourceAnchor?.locator) lines.push([`${row.itemId} · source locator`, row.sourceAnchor.locator]);
    if (row.identity?.versionId) lines.push([`${row.itemId} · row version`, row.identity.versionId]);
    for (const w of (cell?.evidence || []).slice(0, 6)) {
      lines.push([
        `${row.itemId} · witness`,
        [w.artifact, w.locator, w.sha256 ? `sha256:${w.sha256}` : null, `re-verified: ${w.judgeReverified}`]
          .filter(Boolean)
          .join(" · "),
      ]);
    }
  }
  const ev = evidenceRowsFor(f, view);
  for (const e of ev) {
    if (e.missing) continue;
    lines.push([`${e.evidenceId} · artifact`, `${e.artifactRef} · ${e.contentHash} · ${e.byteLength} bytes · ${e.capturedAt}`]);
  }
  return `<details class="tech">
      <summary>Technical details</summary>
      <dl class="tech-dl">
        ${lines.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd class="mono">${esc(readableValue(v))}</dd></div>`).join("")}
      </dl>
      <p class="tech-note">The complete machinery — signatures, hashes, versions, gate reason codes, raw traces and the full evidence catalogue — is in the <a href="#audit-trail" data-goto="audit">Audit trail</a>.</p>
    </details>`;
}

function evidenceDrawer(f, view, rowsById) {
  const rows = (f.itemRefs || []).map((id) => rowsById.get(id)).filter(Boolean);
  const colId = view.register.publication.currentColumnId;
  const attempts = attemptsFor(f, view);
  const evidence = evidenceRowsFor(f, view);
  const blocks = [];

  const seq = attempts.map(answerSequence).filter(Boolean)[0];
  blocks.push(
    `<h4>The answers we gave</h4><p>${
      seq
        ? `<span class="mono small">${esc(seq)}</span>`
        : attempts.length
          ? "This run recorded the session but not a step-by-step answer list for it."
          : "No session is attached to this finding."
    }</p>`
  );

  const shown = screenShowedBlock(rows, colId, { perRow: 3 });
  if (shown) blocks.push(shown);

  const quotes = rows.map((r) => r.sourceAnchor?.quote).filter(Boolean);
  if (quotes.length) {
    blocks.push(
      `<h4>What the questionnaire says</h4>${quotes
        .slice(0, 3)
        .map((q) => `<blockquote class="quote">${esc(q)}</blockquote>`)
        .join("")}`
    );
  }

  const observedPlain = plainify(f.observed, { maxChars: 600 }).text ?? OBSERVED_PHRASE[f.category] ?? null;
  if (observedPlain) blocks.push(`<h4>What the survey did</h4><p>${esc(observedPlain)}</p>`);

  if (f.respondent?.retest) blocks.push(`<h4>How to see it again</h4><p>${esc(f.respondent.retest)}</p>`);

  if (evidence.length) {
    blocks.push(
      `<h4>Evidence files</h4><ul class="plain-list">${evidence
        .map(
          (e) =>
            `<li>${esc(e.evidenceId)} — ${esc(e.type ?? "file")} · ${esc(evidenceState(e))}${
              e.audit?.href ? ` · <a href="${esc(e.audit.href)}">open</a>` : ""
            }</li>`
        )
        .join("")}</ul>`
    );
  }

  // De-duplicated: a finding naming twelve requirements printed the identical
  // re-check note once per requirement.
  const conclusions = [...new Set(rows.map((r) => r.cellsByColumn?.[colId]?.recheck?.note).filter(Boolean))].slice(0, 2);
  blocks.push(
    `<h4>Our conclusion</h4><p>${esc(f.confirmation.label)} — ${esc(f.confirmation.why)}</p>${
      conclusions.length ? conclusions.map((c) => `<p class="muted">${esc(c)}</p>`).join("") : ""
    }`
  );

  // Panel votes appear ONLY if a panel actually participated.
  if (f.verificationDisposition && f.verificationDisposition.state !== "not-routed") {
    blocks.push(`<h4>Independent review</h4><p>${esc(f.verificationDisposition.note ?? f.verificationDisposition.state)}</p>`);
  }

  blocks.push(technicalDetails(f, view, rowsById));

  return `<details class="drawer"><summary>Show evidence</summary><div class="drawer-body">${blocks.join("\n")}</div></details>`;
}

/* ----------------------------- cards -------------------------------- */

/**
 * "Questionnaire says" / "Survey did", in survey language.
 *
 * Expected text is preferred from the register row, because `expectedObservable`
 * was written to describe what a person would see on screen. Observed text is
 * the record's own words with the engineering filtered out, and a fixed phrase
 * when nothing survives the filter — which is exactly the case for the launch
 * blocker, whose every recorded sentence is a stack frame, a DOM id or a URL
 * scheme.
 */
function comparePair(f, rowsById) {
  const rows = (f.itemRefs || []).map((id) => rowsById.get(id)).filter(Boolean);
  const expected =
    plainify(f.expected, { maxChars: 320 }).text ??
    rows.map((r) => r.expectedObservable).find(Boolean) ??
    rows.map((r) => r.requirement).find(Boolean) ??
    null;
  const observed = plainify(f.observed, { maxChars: 320 }).text ?? OBSERVED_PHRASE[f.category] ?? null;
  return { expected, observed };
}

function findingCard(f, view, rowsById, { lane }) {
  const consequence = f.respondent?.consequence ?? "";
  const reach = f.respondent?.reach?.label ?? "";
  const { expected, observed } = comparePair(f, rowsById);
  return `<article class="fcard fcard--${esc(lane)}" id="finding-${esc(f.findingId)}">
    <h3 class="fcard-title">${esc(findingTitle(f, rowsById))}</h3>
    <p class="fcard-meta">${esc(impactOf(f))} · ${esc(topicOf(f))} · ${badge(
      f.confirmation.id === "confirmed" ? "ok" : "warn",
      f.confirmation.label
    )}</p>
    ${consequence ? `<p class="fcard-consequence">${esc(consequence)}</p>` : ""}
    ${reach ? `<p class="fcard-reach">${esc(reach)}</p>` : ""}
    ${
      expected || observed
        ? `<p class="fcard-compare"><strong>Questionnaire says:</strong> ${esc(expected ?? "not recorded")}<br>
           <strong>Survey did:</strong> ${esc(observed ?? "not recorded")}</p>`
        : ""
    }
    <p class="fcard-fix"><strong>Recommended fix:</strong> ${esc(recommendedFix(f))}</p>
    ${evidenceDrawer(f, view, rowsById)}
    <p class="fcard-links">
      <a href="#req-${esc((f.itemRefs || [])[0] ?? "")}" data-goto="full">View requirement</a>
      <a href="#finding-${esc(f.findingId)}" class="copy-link" data-copy="finding-${esc(f.findingId)}">Copy link</a>
    </p>
  </article>`;
}

/**
 * The full sentence describing what is unclear — longer than the title, still
 * plain, still never the raw record string.
 */
function unclearDetail(f) {
  return plainify(f.summary, { maxChars: 400, stripMetaTail: true }).text ?? UNCLEAR_FALLBACK;
}

/**
 * The two sides of the decision.
 *
 * When the record wrote `Reading A:` / `Reading B:` these are genuinely two
 * readings of the questionnaire and are labelled so. When it did not, the pair
 * is not two readings at all — it is "the document says nothing" beside "here
 * is what the survey does today", and calling that "one reading / the other
 * reading" misdescribes the decision the owner is being asked to make.
 */
function decisionSides(f) {
  const twoReadings = READING_PREFIX.test(String(f.expected ?? "")) || READING_PREFIX.test(String(f.observed ?? ""));
  const a = plainify(f.expected, { maxChars: 320 }).text;
  const b = plainify(f.observed, { maxChars: 320 }).text;
  if (!a && !b) return null;
  return twoReadings
    ? { aLabel: "One reading", a, bLabel: "The other reading", b }
    : { aLabel: "What the questionnaire says", a, bLabel: "What the survey does today", b: b ?? OBSERVED_PHRASE[f.category] ?? null };
}

function decisionCard(f, view, rowsById) {
  const rows = (f.itemRefs || []).map((id) => rowsById.get(id)).filter(Boolean);
  const quote = rows.map((r) => r.sourceAnchor?.quote).find(Boolean);
  const sides = decisionSides(f);
  const detail = unclearDetail(f);
  const title = `${questionLabel(f, rowsById)} · ${unclearPhrase(f)}`;
  const rank = f.rank ?? null;
  return `<article class="fcard fcard--decision" id="finding-${esc(f.findingId)}"${
    rank ? ` data-rank="${esc(rank.id)}"` : ""
  }>
    <h3 class="fcard-title">${esc(title)}</h3>
    <p class="fcard-meta">Needs your decision · ${esc(topicOf(f))}${
      rank ? ` · ${badge(rank.changesLaunch ? "warn" : "neutral", rank.label)}` : ""
    }</p>
    ${rank ? `<p class="fcard-rank">${esc(rank.why)}</p>` : ""}
    <p class="fcard-consequence"><strong>What is unclear:</strong> ${esc(detail)}</p>
    ${
      sides
        ? `<p class="fcard-compare"><strong>${esc(sides.aLabel)}:</strong> ${esc(sides.a ?? "not recorded")}<br>
           <strong>${esc(sides.bLabel)}:</strong> ${esc(sides.b ?? "not recorded")}</p>`
        : ""
    }
    <p class="fcard-fix"><strong>What we need from you:</strong> tell us which reading is right.</p>
    ${quote ? `<details class="drawer"><summary>Show evidence</summary><div class="drawer-body">
        <h4>What the questionnaire says</h4><blockquote class="quote">${esc(quote)}</blockquote>
        ${technicalDetails(f, view, rowsById)}
      </div></details>` : technicalDetails(f, view, rowsById)}
  </article>`;
}

/* --------------------- what the plan could not do --------------------- *
 *
 * The planner names its own shortfalls with closed codes and emits EVERY code on EVERY
 * plan, including at zero, so that "we looked and found none" cannot be confused with
 * "nobody looked" (worker-v2 stages/plan.ts). That distinction only survives if it is
 * rendered, so this block prints the zeros too.
 *
 * TWO ZONES, ON PURPOSE. A reader gets a counted sentence in survey language; the plan's
 * own wording — which is written in stage vocabulary, because that is who it was written
 * for — is kept inside `Technical details`, the disclosure Amendment B reserves for exactly
 * that and which the vocabulary gate reports separately rather than failing on. Translating
 * the plan's sentence in prose here would either lose the fact or leak the vocabulary; this
 * loses neither.
 */
const LIMITATION_PLAIN = {
  "cases-not-assigned-to-any-walk": "checks that no run through the survey ever covered",
  "decisions-without-document-wording":
    "answers the run had to pick without the questionnaire's own wording to recognise them by",
  "route-labels-that-are-routing-conditions":
    "routing rules written as a condition rather than as an answer a respondent can choose",
  "route-answers-that-name-only-a-code":
    "routing rules that name only an answer code, with no wording anywhere to click",
  "cases-without-a-target-question": "checks that name no question to carry them out on",
  "cases-without-a-stimulus": "checks that name a question but no answer to give it",
  "cases-whose-target-is-not-on-their-walk":
    "checks whose question is not answered exactly once by the run they were attached to",
  "cases-without-a-witness-walk": "checks belonging to a requirement no run through the survey covers",
  "plan-predates-limitation-reporting":
    "this run's plan was made before we started counting what a plan could not do, so its shortfalls were never counted",
};

function planLimitationsBlock(view) {
  const block = view?.planLimitations ?? null;
  if (!block) {
    return `<p class="muted">We have no record of what this run's plan could not do. That is not a statement that it could do everything.</p>`;
  }
  const entries = Array.isArray(block.entries) ? block.entries : [];
  if (block.state !== "read" || entries.length === 0) {
    return `<p class="muted">We could not read what this run's plan was unable to do, so that is unknown. It is not a statement that it was able to do everything.</p>`;
  }
  const withCount = entries.filter((e) => Number(e?.count ?? 0) > 0);
  const lead = withCount.length
    ? `The plan for this run also reported ${withCount.length === 1 ? "one thing" : `${withCount.length} things`} it could not do:`
    : `The plan for this run reported ${entries.length} kinds of shortfall it checks for, and found none of them.`;
  return `
    <p>${esc(lead)}</p>
    ${
      withCount.length
        ? `<ul class="plain-list">${withCount
            .map(
              (e) =>
                `<li><strong>${Number(e.count)}</strong> ${esc(
                  LIMITATION_PLAIN[e.code] ?? "shortfalls of a kind this page has no plain description for",
                )} <code>${esc(String(e.code ?? "unnamed"))}</code></li>`,
            )
            .join("")}</ul>`
        : ""
    }
    <details class="tech">
      <summary>Technical details — every shortfall the plan checks for, including the ones at zero</summary>
      <ul class="plain-list">${entries
        .map(
          (e) =>
            `<li><code>${esc(String(e.code ?? "unnamed"))}</code> — <strong>${Number(e.count ?? 0)}</strong> — ${esc(
              String(e.what ?? ""),
            )}</li>`,
        )
        .join("")}</ul>
    </details>`;
}

/* ----------------------------- the view ----------------------------- */

export function renderSummaryView(view, summary) {
  const s = summary;
  const rowsById = s.rowsById;

  const actions = [];
  if (s.launchBlockers.length)
    actions.push(`<a class="cta cta--danger" href="#lane-blocker">Review launch blocker${s.launchBlockers.length === 1 ? "" : "s"}</a>`);
  if (s.problems.length)
    actions.push(
      `<a class="cta" href="#lane-problems">Review ${s.problems.length} programming problem${s.problems.length === 1 ? "" : "s"}</a>`
    );
  if (s.decisions.length)
    actions.push(
      `<a class="cta" href="#lane-decisions">Answer ${s.decisions.length} questionnaire question${s.decisions.length === 1 ? "" : "s"}</a>`
    );
  actions.push(`<a class="cta cta--quiet" href="#full-check" data-goto="full">Open full check register — ${s.total} requirements</a>`);

  const pill = (id) => {
    const st = PLAIN_STATES.find((x) => x.id === id);
    return `<span class="mini-count"><span class="pstate pstate--${esc(st.tone)}">${esc(st.label)}</span> ${
      s.countsKnown ? s.counts[id] : "—"
    }</span>`;
  };

  /* A standing statement about the SERVICE, above the verdict because it changes how
     the verdict should be read. Absent by default — see `serviceNote` in view-model.mjs
     for why this is not `fixtureNote`. Rendered inside the Summary view on purpose, so
     the customer-copy gates scan it like every other sentence a reader meets. */
  const serviceNote =
    view.serviceNote && view.serviceNote.body
      ? `<p class="service-note" role="note">${
          view.serviceNote.flag ? `<strong>${esc(view.serviceNote.flag)}</strong> ` : ""
        }${esc(view.serviceNote.body)}</p>`
      : "";

  return `
<section class="hero" aria-labelledby="verdict">
  <p class="eyebrow">${esc(s.readinessLine)}</p>
  ${serviceNote}
  <h2 id="verdict" class="verdict">${esc(s.headline)}</h2>
  <p class="lede">${esc(s.lede)}</p>
  ${s.follow || s.passedSentence ? `<p class="follow">${s.follow} ${s.passedSentence}</p>` : ""}
  ${s.accountingSentence ? `<p class="follow follow--accounting">${s.accountingSentence}</p>` : ""}
  <div class="cta-row">${actions.join("")}</div>
  <p class="evidence-line evidence-line--${esc(s.evidenceLine.tone)}">
    <span class="glyph" aria-hidden="true">${s.evidenceLine.tone === "ok" ? "✓" : "!"}</span>
    <span><strong>${esc(s.evidenceLine.headline)}</strong> ${esc(s.evidenceLine.detail)}</span>
  </p>
  ${s.shapeNote ? `<p class="shape-note">${esc(s.shapeNote)}</p>` : ""}
  ${
    /* NEVER SILENTLY SHORTER THAN THE RECORD. If the run derived more failing
       requirements than this page has cards for, the difference is stated here rather
       than left for a reader to find by comparing two totals in the audit trail. */
    s.undescribedLine ? `<p class="shape-note">${esc(s.undescribedLine)}</p>` : ""
  }
</section>

${
  s.launchBlockers.length
    ? `<section class="lane lane--blocker" id="lane-blocker" aria-labelledby="lane-blocker-h">
        <h2 id="lane-blocker-h" class="lane-title">Launch blocker</h2>
        <p class="lane-lede">Nobody can take this survey until this is fixed. Every other result on this page describes a survey a respondent cannot currently reach.</p>
        ${s.launchBlockers.map((f) => findingCard(f, view, rowsById, { lane: "blocker" })).join("\n")}
      </section>`
    : `<section class="lane lane--quiet" id="lane-blocker">
        <h2 class="lane-title">Launch blocker</h2>
        <p class="lane-lede">${
          /* "The survey opened in a standard browser in this run" is a POSITIVE claim
             about what happened, and it was printed whenever no launch blocker was
             recorded — including on a run whose first load threw and rendered nothing.
             The honest empty state says what the record does and does not contain. */
          esc(
            s.everExercised > 0
              ? "None recorded. The run reached and drove the survey in a standard browser."
              : "None recorded. This run did not reach the survey in a standard browser either, so that is a statement about the record and not about the survey.",
          )
        }</p>
      </section>`
}

${
  s.problems.length
    ? `<section class="lane lane--problems" id="lane-problems" aria-labelledby="lane-problems-h">
        <h2 id="lane-problems-h" class="lane-title">${s.problems.length} programming problem${s.problems.length === 1 ? "" : "s"}</h2>
        <p class="lane-lede">The survey does something different from what the questionnaire says. Each one states what a respondent experiences and what to change.</p>
        ${
          /* WHERE THESE SENTENCES CAME FROM. When the run wrote its own descriptions the
             page shows those and says nothing extra. When it recorded failing requirements
             and no descriptions, the words below are the checking step's own, read back
             off the artifacts — a reader is owed that distinction before acting on them. */
          view.findings?.source === "verifier-observations"
            ? `<p class="lane-lede lane-lede--rank">${esc(
                view.findings.derivedFromObservations === s.problems.length
                  ? "This run recorded which requirements failed but wrote no description of them. The wording below is taken from the checks that read the saved screens, and no one has reviewed it."
                  : `${view.findings.derivedFromObservations} of the problems below have no description in this run's own record. Their wording is taken from the checks that read the saved screens, and no one has reviewed it.`,
              )}</p>`
            : ""
        }
        ${s.problems.map((f) => findingCard(f, view, rowsById, { lane: "problem" })).join("\n")}
      </section>`
    : `<section class="lane lane--quiet" id="lane-problems">
        <h2 class="lane-title">Programming problems</h2>
        <p class="lane-lede">${
          /* "None found" IS A CLAIM, and it is only true of what was checked. On a run
             that tried 2 of 227 requirements it read as a clean survey. The empty lane
             now carries the same denominator the panel below does. */
          esc(
            s.countsKnown
              ? "None found on the checks that reached a result."
              : s.neverExercised > 0
                ? `None described on this page. ${s.neverExercised} of the ${s.total} requirements were never tried on the live survey, so this is not a statement that the survey has no problems.`
                : "None described on this page. No result on this run has been re-checked independently, so this is not a statement that the survey has no problems.",
          )
        }</p>
      </section>`
}

${
  s.decisions.length
    ? `<section class="lane lane--decisions" id="lane-decisions" aria-labelledby="lane-decisions-h">
        <h2 id="lane-decisions-h" class="lane-title">${s.decisions.length} question${
          s.decisions.length === 1 ? "" : "s"
        } for you</h2>
        <p class="lane-lede">The questionnaire can be read two ways in these places. We have not judged the survey on them, because guessing your intent would be worse than asking.</p>
        <p class="lane-lede lane-lede--rank">${s.decisionLaneLede}</p>
        <details class="group-fold">
          <summary>Open the ${s.decisions.length} question${
            s.decisions.length === 1 ? "" : "s"
          } to answer — most consequential first</summary>
          ${s.decisions.map((f) => decisionCard(f, view, rowsById)).join("\n")}
        </details>
      </section>`
    : `<section class="lane lane--quiet" id="lane-decisions">
        <h2 class="lane-title">Questions for you</h2>
        <p class="lane-lede">None. Nothing in the questionnaire needed a decision from you.</p>
      </section>`
}

${
  s.cannotTest.length
    ? `<section class="lane lane--quiet" id="lane-nobrowser">
        <h2 class="lane-title">${s.cannotTest.length} thing${s.cannotTest.length === 1 ? "" : "s"} we could not test in the browser</h2>
        <p class="lane-lede">A browser session cannot settle these. They need a different way of checking, and they are not counted as passed.</p>
        <ul class="plain-list">
          ${s.cannotTest
            .map((f) => {
              // The REQUIREMENT is what the reader needs here — which promise
              // could not be checked — and the record's own summary of why is
              // written in DOM terms. The requirement text is extraction prose
              // about the questionnaire, so it is translated, not filtered.
              const rows = (f.itemRefs || []).map((id) => rowsById.get(id)).filter(Boolean);
              const what =
                rows.map((r) => plainify(r.requirement, { maxChars: 300, dropTechnical: false }).text).find(Boolean) ??
                plainify(f.summary, { maxChars: 260 }).text ??
                "This one cannot be settled from a browser session.";
              const why = OBSERVED_PHRASE[f.category] ?? null;
              return `<li><strong>${esc(questionLabel(f, rowsById))}</strong> — ${esc(what)}${why ? ` <span class="muted">${esc(why)}</span>` : ""}</li>`;
            })
            .join("")}
        </ul>
      </section>`
    : ""
}

<section class="lane lane--passed" id="lane-passed">
  <h2 class="lane-title">${s.countsKnown ? `${s.counts.passed} of the ${s.total} requirements passed` : "No settled results"}</h2>
  <p class="lane-lede">${
    s.countsKnown
      ? "These matched the questionnaire and their evidence was re-checked. Nothing here needs your attention."
      : "Nothing on this run cleared our evidence check, so no requirement is being reported as passed."
  }</p>
  <details class="group-fold" ${s.countsKnown ? "" : "open"}>
    <summary>What was checked, and what is still unresolved</summary>
    ${
      /* WHEN NOTHING SETTLED, SHOW WHAT WAS TRIED — NOT SIX EM DASHES.
       *
       * The six plain pills are read off the current column, so without one they were
       * "Passed —, Problem found —, …" and a reader could not tell a run that tried two
       * of 227 requirements from a run that tried all of them and found nothing. The
       * seven coverage buckets are derived from the record itself and are available on
       * every run, so that is what is shown instead, in the vocabulary the buckets are
       * declared in. The panel is also OPEN in this case: a reader who has just been
       * told nothing settled must not have to go looking for how much was attempted. */
      s.countsKnown
        ? `<div class="mini-counts">${["passed", "problem", "decision", "partial", "no-browser", "not-completed"]
            .map(pill)
            .join("")}</div>
    <p class="muted">${esc(s.coverageLine)}. <a href="#full-check" data-goto="full">Open the full check</a> to see every requirement, including the ones with no result.</p>`
        : `<div class="mini-counts">${s.coverageBuckets
            .map(
              (b) =>
                `<span class="mini-count"><span class="pstate pstate--neutral">${esc(b.label)}</span> ${b.count}</span>`,
            )
            .join("")}</div>
    <p>${esc(s.attemptLine)}</p>
    <p class="muted">${esc(s.untestedLine)} <a href="#full-check" data-goto="full">Open the full check</a> to see every requirement, including the ones with no result.</p>`
    }
    ${planLimitationsBlock(view)}
  </details>
</section>
`;
}

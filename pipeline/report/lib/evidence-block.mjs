// "What the screen showed" — evidence samples that say what they demonstrate.
//
// WHY THIS EXISTS
// ---------------
// The build this replaces listed witness notes verbatim, in order, with no
// de-duplication and no statement of purpose. A reader who opened `Show
// evidence` on a survey-wide rule met six consecutive lines reading
//
//     scope sample: one question stem in this capture: "Thank you very much…"
//     scope sample: one question stem in this capture: "Thank you very much…"
//     …
//
// under the heading "What the screen showed". Every word of that is true and
// none of it tells the reader what the samples PROVE — which is that the run
// searched 1,374 screen captures across 15 screens and found nothing breaking
// the rule, and these are examples of what it read.
//
// So a witness list now carries three things: the claim its samples support,
// the samples themselves de-duplicated with a count, and nothing else. Where
// the record does not say what kind of claim was being made, the block falls
// back to listing the witnesses plainly rather than inventing a purpose.

import { esc } from "./esc.mjs";
import { plainify } from "./plain-text.mjs";

const nf = (n) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-GB") : null);

/**
 * What a set of samples is evidence OF, by the claim kind the compiler
 * recorded. Each entry is a fixed sentence over recorded numbers — it never
 * asserts an outcome, only what was looked at.
 */
const CLAIM_PURPOSE = {
  "scoped-absence": (s) => {
    const caps = nf(s.capturesScanned ?? s.memberCount);
    const screens = nf(s.screensScanned);
    if (!caps) return "We searched every screen the run captured for anything that would break this rule.";
    return `We searched ${caps} screen captures${screens ? ` across ${screens} screens` : ""} for anything that would break this rule.`;
  },
  "scoped-inventory": () => "We compared what was on screen against the list the questionnaire gives.",
  "scoped-capture-set": (s) => {
    const caps = nf(s.capturesScanned ?? s.memberCount);
    return caps ? `We read ${caps} captures of this screen.` : "We read every capture of this screen.";
  },
  "scoped-eligible-sessions": (s) => {
    const n = nf(s.eligibleSessions ?? s.memberCount);
    return n ? `We used all ${n} interview sessions that reached this point.` : "We used every interview session that reached this point.";
  },
  "scoped-route-edges": () => "We followed every answer route the questionnaire defines out of this question.",
  "scoped-occurrence-set": () => "We collected every place this text appears.",
};

/** What the run concluded from that search, when the predicate recorded it. */
function outcomeSentence(detail) {
  if (!detail || typeof detail !== "object") return null;
  if (typeof detail.violations === "number") {
    return detail.violations === 0
      ? "Nothing in what we read broke it."
      : `${detail.violations} place${detail.violations === 1 ? "" : "s"} broke it.`;
  }
  if (typeof detail.matches === "number" && detail.matches > 0) {
    return `We found it ${detail.matches} time${detail.matches === 1 ? "" : "s"}.`;
  }
  return null;
}

const SAMPLE_NOTE = /^scope sample:\s*/i;

/**
 * @param {Array} rows      register rows this block covers
 * @param {string} colId    the current column
 * @param {object} [opts]
 * @param {number} [opts.perRow] how many witnesses to take from each row
 */
export function screenShowedBlock(rows, colId, { perRow = 4 } = {}) {
  const claims = [];
  const items = new Map(); // key → { note, value, count, sample }

  for (const row of rows) {
    const cell = row?.cellsByColumn?.[colId];
    const witnesses = (cell?.evidence || []).slice(0, perRow);
    if (!witnesses.length) continue;
    const scope = row?.compiled?.evidenceScope ?? null;
    const purpose = scope && CLAIM_PURPOSE[scope.claimKind] ? CLAIM_PURPOSE[scope.claimKind](scope) : null;
    const outcome = outcomeSentence(row?.compiled?.predicateDetail);
    // De-duplicated on the SEARCH, not on the sentence: a finding that names
    // twelve requirements produced twelve near-identical "we searched 1,374
    // captures" sentences, which is the same dumping this block exists to stop.
    if (purpose && !claims.some((c) => c.purpose === purpose)) claims.push({ purpose, outcome });
    for (const w of witnesses) {
      const note = String(w.note ?? "").trim();
      const isSample = SAMPLE_NOTE.test(note);
      const rawLabel = isSample ? note.replace(SAMPLE_NOTE, "") : note;
      // A witness note is written by the judging engine and is sometimes a
      // serialised probe result — `kinds=["radio"] names=["S1"]`. That is a
      // locator, not a description of what was on screen, so it does not go in
      // customer copy. It survives verbatim in Technical details, where the
      // witness is printed with its artifact, locator and hash.
      const label = plainify(rawLabel, { maxChars: 140 }).text ?? "what was on screen at this point";
      const value = Array.isArray(w.value) && w.value.length ? plainify(w.value.slice(0, 4).join(", "), { maxChars: 200 }).text ?? "" : "";
      const key = `${isSample ? "S" : "W"}|${label}|${value}`;
      const seen = items.get(key);
      if (seen) {
        seen.count += 1;
        if (w.judgeReverified === "failed") seen.failed = true;
        continue;
      }
      items.set(key, { label, value, count: 1, sample: isSample, failed: w.judgeReverified === "failed", verified: w.judgeReverified === "verified" });
    }
  }

  if (!items.size) return "";

  const samples = [...items.values()].filter((i) => i.sample);
  const direct = [...items.values()].filter((i) => !i.sample);

  // `true` / `false` are the recorded reading of a yes-or-no observation.
  // Printed raw they read as debris — "progress on CLOSING: true".
  const valueOf = (v) => (v === "true" ? "yes" : v === "false" ? "no" : v);

  const li = (i) => {
    const value = valueOf(i.value);
    const inline = value === "yes" || value === "no";
    return `<li>${esc(i.label)}${
      value ? (inline ? ` — ${esc(value)}` : `: <span class="quote">${esc(value)}</span>`) : ""
    }${i.count > 1 ? ` <span class="muted">— seen ${i.count} times</span>` : ""}${
      i.failed ? " — evidence did NOT re-check" : i.verified ? " — evidence re-checked" : ""
    }</li>`;
  };

  const parts = ["<h4>What the screen showed</h4>"];
  if (claims.length) {
    const shown = claims.slice(0, 2).map((c) => [c.purpose, c.outcome].filter(Boolean).join(" "));
    const rest = claims.length - shown.length;
    parts.push(
      `<p>${shown.map((c) => esc(c)).join(" ")}${
        rest > 0 ? ` <span class="muted">${rest} other check${rest === 1 ? "" : "s"} under this finding searched their own evidence the same way.</span>` : ""
      }</p>`
    );
  }
  if (direct.length) parts.push(`<ul class="plain-list">${direct.map(li).join("")}</ul>`);
  if (samples.length) {
    parts.push(
      `<p class="muted small">${
        claims.length
          ? "These are examples of what we read while doing that — they are samples of the search, not the finding itself."
          : "These are samples of what was on screen when we checked."
      }</p><ul class="plain-list">${samples.map(li).join("")}</ul>`
    );
  }
  return parts.join("");
}

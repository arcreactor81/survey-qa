/**
 * judge/lib/document-model.mjs — D9. WHO WAS ELIGIBLE, ACCORDING TO THE DOCUMENT.
 *
 * THE HOLE THIS CLOSES.
 *
 * `screen-universal@1` ("Q3 must be displayed to all respondents") decided who
 * was ELIGIBLE to see the screen from `routeTable.screenRank`, which is the
 * MEDIAN OF `controls_state.progress.now` — a number reported by the survey
 * under test. So the thing being tested supplied the yardstick used to grade it.
 * A survey that both skips a required screen AND mis-reports its progress
 * control moves the skipped screen's rank past the sessions that missed it,
 * those sessions stop counting as eligible, and "shown to everyone" passes on
 * the strength of the second defect hiding the first.
 *
 * THE FIX. Eligibility and order come from the SIGNED ContractRevision — the
 * document side — and from nothing else:
 *
 *   terminalScreens   screens the signed contract types as `terminal`, split
 *                     into COMPLETION and SCREENOUT by the document's own
 *                     wording. A respondent who reached a completion screen
 *                     without being screened out completed the survey, and
 *                     therefore was eligible for every universal screen. That
 *                     statement needs no progress bar and no rank.
 *   screenOrder       the order in which screens are first named across the
 *                     signed items, in signed order. Used only as corroboration
 *                     and reported; it never decides eligibility on its own.
 *
 * When the run has no verified authority there is no document model, and the
 * predicates that need one FAIL CLOSED (`ELIGIBILITY_NOT_DOCUMENT_DERIVED`)
 * rather than falling back to the implementation's own numbers.
 */

import { normLine } from './normalize.mjs';

export const DOCUMENT_MODEL_VERSION = '1.0.0';

const SCREEN_TOKEN_RE = /\b(S\d|Q\d+|D\d+)\b/g;

const NAMED_SCREENS = [
  [/screen[-‑\s]?out screen|screened out|screen[-‑\s]?out/i, 'SCREENOUT'],
  [/closing screen|thank[-\s]?you screen|completion screen|final screen/i, 'CLOSING'],
  [/welcome screen/i, 'WELCOME'],
];

/** Screens named by one signed item's requirement + quote, in order of mention. */
function screensNamedBy(item) {
  const text = `${item.statement || ''}\n${item.doc_quote || ''}`;
  const t = normLine(text);
  const out = [];
  const seen = new Set();
  for (const m of t.match(SCREEN_TOKEN_RE) || []) {
    const s = m.toUpperCase();
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  for (const [re, name] of NAMED_SCREENS) {
    if (re.test(t) && !seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

/**
 * The terminal screens named IN WORDS by one item. Only the document's own names
 * for its terminal screens count. A bare `S2`/`Q7` token in a terminal item is
 * almost always the ROUTE SOURCE ("...after routing from S2 code 6"), and
 * treating it as a terminal screen would classify an ordinary question screen as
 * a screen-out — excluding every session that answered it.
 */
function terminalScreensNamedBy(text) {
  const t = normLine(text);
  const out = [];
  for (const [re, name] of NAMED_SCREENS) {
    if (name !== 'WELCOME' && re.test(t)) out.push(name);
  }
  return out;
}

/**
 * Build the document model from the BOUND (signed) obligation projections.
 *
 * @param {object} docIndex the compiler's document index (carries `bound`)
 * @returns {{available:boolean, why:string|null, screenOrder:string[], rankOf:object,
 *            completionScreens:string[], screenoutScreens:string[], source:string}}
 */
export function buildDocumentModel(docIndex) {
  const bound = docIndex && docIndex.bound ? docIndex.bound : null;
  if (!bound || !bound.signedSource) {
    return {
      version: DOCUMENT_MODEL_VERSION,
      available: false,
      why: 'no verified signature covers the contract, so no document-derived screen order or terminal set exists',
      screenOrder: [], rankOf: {}, completionScreens: [], screenoutScreens: [],
      source: 'none',
    };
  }

  const screenOrder = [];
  const seen = new Set();
  const completion = new Set();
  const screenout = new Set();

  for (const item of bound.list) {
    if (item.fieldsBound !== true) continue; // an unbound item is not document evidence
    const named = screensNamedBy(item);
    for (const s of named) if (!seen.has(s)) { seen.add(s); screenOrder.push(s); }
    if (item.category !== 'terminal') continue;
    const t = normLine(`${item.statement || ''} ${item.doc_quote || ''}`);
    // The document distinguishes the two terminal kinds by its own names for
    // them. A terminal item that names both (or neither) is deliberately NOT
    // used to classify anything: an unresolved terminal cannot decide who
    // completed the survey.
    for (const s of terminalScreensNamedBy(t)) {
      if (s === 'SCREENOUT') screenout.add('SCREENOUT');
      else if (s === 'CLOSING') completion.add('CLOSING');
    }
  }

  const rankOf = {};
  screenOrder.forEach((s, i) => { rankOf[s] = i; });

  const available = completion.size > 0;
  return {
    version: DOCUMENT_MODEL_VERSION,
    available,
    why: available ? null : 'the signed contract names no terminal COMPLETION screen, so "completed the survey" is not a document-derived fact',
    screenOrder,
    rankOf,
    completionScreens: [...completion].sort(),
    screenoutScreens: [...screenout].sort(),
    source: 'signed ContractRevision items (type=terminal + first-mention order)',
  };
}

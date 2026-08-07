/**
 * judge/lib/normalize.mjs — canonical text normalization.
 *
 * Deliberately conservative. There is NO similarity score, NO threshold and NO
 * "near match" anywhere in this engine (merged contract §1). Normalization only
 * removes representational noise that carries no meaning: unicode form,
 * dash/quote variants, invisible spacing characters, and runs of whitespace.
 */

const SMART = new Map([
  ['‘', "'"], ['’', "'"], ['‚', "'"], ['‛', "'"],
  ['“', '"'], ['”', '"'], ['„', '"'], ['‟', '"'],
  ['‐', '-'], ['‑', '-'], ['‒', '-'], ['–', '-'],
  ['—', '-'], ['―', '-'], ['−', '-'],
  [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '],
  ['​', ''], ['­', ''], ['﻿', ''],
]);

// Built from the map itself, so adding an entry can never leave it unreachable
// because a hand-written character class forgot it. That exact bug (U+2010
// HYPHEN present in the data, U+2011 NON-BREAKING HYPHEN in the class) silently
// broke every "screen-out screen" lookup.
const SMART_RE = new RegExp(`[${[...SMART.keys()].join('')}]`, 'g');

/** Canonical form used for every string comparison in the engine. */
export function norm(s) {
  if (s === null || s === undefined) return '';
  let t = String(s).normalize('NFKC');
  t = t.replace(SMART_RE, (c) => (SMART.has(c) ? SMART.get(c) : c));
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\s*\n\s*/g, '\n');
  return t.trim();
}

/** Single-line canonical form: newlines collapse to spaces. Used for labels. */
export function normLine(s) {
  return norm(s).replace(/\s+/g, ' ').trim();
}

/** Case-insensitive canonical form. Used ONLY where the document is itself
 *  case-insensitive about the fact (e.g. screen identifiers), never for copy. */
export function normFold(s) {
  return normLine(s).toLowerCase();
}

export function eqLine(a, b) {
  return normLine(a) === normLine(b);
}

/** Does `haystack` contain `needle` as an exact normalized substring? */
export function containsLine(haystack, needle) {
  const h = norm(haystack).replace(/\n/g, ' ').replace(/\s+/g, ' ');
  const n = normLine(needle);
  return n.length > 0 && h.includes(n);
}

/** Split a visible-text blob into normalized lines. */
export function lines(s) {
  return norm(s).split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

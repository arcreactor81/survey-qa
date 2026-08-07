// Turning RECORD text into CUSTOMER text.
//
// WHY THIS EXISTS
// ---------------
// Every string in `finding.summary`, `finding.expected` and `finding.observed`
// was written by the stage that found the thing, for the engineer who would fix
// it. That is the right audience for the record and the wrong audience for the
// report. Rendered unchanged, the first card a reader met opened with
//
//     TypeError: Cannot set property history of #<Window> which has only a
//     getter … survey.js:236 … The #screen container is never populated …
//     Reproduced over http:// and file:// … a one-line harness shim …
//
// which is the owner's standing complaint ("too much jargon, info is just
// dumped on user") reproduced verbatim inside the lane he is told to read
// first.
//
// So this module is a DETERMINISTIC, AUDITABLE filter — not a summariser and
// not a rewriter. It does exactly three things, in order:
//
//   1. strips the record's own addressing prefixes and provenance suffixes
//      (`OBL-B1-09:`, `GLOBAL (blocks …):`, `[found by exploration, …]`);
//   2. TRANSLATES a fixed dictionary of engineering phrases into the survey
//      vocabulary a researcher already uses (a viewport size becomes "a phone
//      screen", a requirement id becomes "requirement B3C-11");
//   3. DROPS any remaining sentence that still carries a technical marker —
//      a stack frame, a CSS declaration, a tag name, a URL scheme, a DOM id.
//
// Nothing is deleted from the artifact: the untouched original is rendered in
// the `Technical details` disclosure on the same card, which is where
// AMENDMENT B's layer map puts it. This module only decides what reaches the
// FIRST paragraph a reader sees.
//
// It is a fixed table, deliberately. A model-written paraphrase of a defect
// report is a new claim about the survey, and this page is not allowed to make
// claims the record does not carry.

/* ------------------------------------------------------------------ *
 * 1. Record addressing                                                *
 * ------------------------------------------------------------------ */

/** `[found by exploration, exploration (EXP-010 @Q1)]` and friends. */
const PROVENANCE_SUFFIX = /\s*\[found by [^\]]*\]\s*$/i;

/** `OBL-B1-09:` · `OBL-B1-13 / OBL-B1-25 / OBL-B1-38 (and General instruction 4):` · `GLOBAL (blocks …):` */
const RECORD_PREFIX = /^\s*(?:GLOBAL|OBL-[A-Z0-9-]+)(?:\s*[/,]\s*OBL-[A-Z0-9-]+)*\s*(?:\([^)]*\))?\s*:\s*/i;

/** The extraction stage's own label on an ambiguity. */
const AMBIGUITY_PREFIX = /^\s*Extraction-time document ambiguity:\s*/i;

/** `Reading A: ` / `Reading B: ` — the card supplies its own framing for these. */
export const READING_PREFIX = /^\s*Reading\s+[AB]\s*:\s*/i;

/**
 * Some findings carry BOTH a measurement and the ambiguity it raised, joined by
 * the run's own marker. Everything before the marker is the measurement (and is
 * written in pixels); everything after it is the question a human must answer,
 * and is the only half a decision card is about.
 */
const AMBIGUITY_MARKER = /^[\s\S]*?\bAMBIGUOUS\s*[—–-]\s*recorded,\s*not judged\s*:\s*/i;

/**
 * Trailing clauses that say only "and therefore there are two readings" — which
 * is what the lane this text appears in already says, in its heading. Stripping
 * them is what turns a 165-character record sentence into a title.
 */
const META_TAIL = [
  /,?\s*leading to [^.]*interpretations?\.?\s*$/i,
  /,?\s*leaving [^.]*interpretations?\.?\s*$/i,
  /;?\s*both [^.]*are plausible(?: interpretations)?\.?\s*$/i,
  /,?\s*so different implementations [^.]*\.?\s*$/i,
  /,?\s*(?:which|and this) (?:would )?leav(?:es|ing) [^.]*open\.?\s*$/i,
];

/**
 * A requirement id as a reader should see it. The id itself never changes —
 * anchors, permalinks, the CSV and the audit trail all keep `OBL-B3C-11`,
 * because it is the identifier the signed record uses. Only the DISPLAY drops
 * the `OBL` prefix, which is the abbreviation of the single most-banned word in
 * AMENDMENT B's list.
 */
export function requirementLabel(itemId) {
  return String(itemId ?? "").replace(/^OBL-/i, "");
}

/* ------------------------------------------------------------------ *
 * 2. The translation dictionary                                       *
 * ------------------------------------------------------------------ */

/**
 * Viewport geometry → the two words a survey researcher uses. A width at or
 * under 500 CSS pixels is a phone; anything wider is a desktop screen. The
 * threshold is stated rather than inferred so a reader of this file can check
 * it against the run's own probes (390x844 and 1280x900).
 */
const PHONE_MAX_WIDTH = 500;

function screenWords(width) {
  return Number(width) <= PHONE_MAX_WIDTH ? "a phone screen" : "a desktop screen";
}

/**
 * Ordered replacements. Each is a fixed pattern with a fixed survey-language
 * result; none of them invents a fact that is not already in the sentence.
 */
const TRANSLATIONS = [
  // "At a 390x844 mobile viewport" / "At 1280x900" / "a 390x844 viewport"
  [/\bat\s+(?:a\s+)?(\d{3,4})x(\d{3,4})(?:\s*(?:px|css px))?(?:\s+(?:mobile|phone|desktop|tablet))?(?:\s+viewport)?\b/gi, (_m, w) => `on ${screenWords(w)}`],
  [/\b(?:a\s+)?(\d{3,4})x(\d{3,4})(?:\s*(?:px|css px))?(?:\s+(?:mobile|phone|desktop|tablet))?\s+viewport\b/gi, (_m, w) => screenWords(w)],
  // "a 390px viewport" / "at 1280px"
  [/\b(?:at\s+)?(?:a\s+)?(\d{3,4})\s*px(?:\s+(?:wide|mobile|phone|desktop|tablet))?(?:\s+viewport)?\b/gi, (_m, w) => screenWords(w)],
  // Requirement ids, wherever they appear mid-sentence.
  [/\bOBL-([A-Z0-9]+(?:-[A-Z0-9]+)*)\b/g, (_m, rest) => `requirement ${rest}`],
  // Input controls, named as a questionnaire names them.
  [/\bradios\b/gi, "radio buttons"],
  [/\bcheckboxes\b/gi, "tick boxes"],
  // Banned vocabulary that has a plain equivalent is TRANSLATED rather than
  // dropped, so the sentence around it survives. Anything on the ban list with
  // no faithful plain equivalent falls through to the backstop below and takes
  // its sentence with it.
  [/\bnot[\s-]browser[\s-]observable\b/gi, "not something a browser can see"],
  [/\bbrowser[\s-]observable\b/gi, "visible in a browser"],
  [/\bobligations\b/gi, "requirements"],
  [/\bobligation\b/gi, "requirement"],
  [/\badjudicated\b/gi, "decided by a person"],
  [/\badjudication\b/gi, "a decision by a person"],
  [/\badjudicates?\b/gi, "decides"],
  // Parenthesised engineering asides are removed outright rather than
  // translated: "(display:none)", "(all y=221, x ascending 327->944)",
  // "(e.g., HTML <b>ONE</b>)". Removing the aside lets the SENTENCE survive the
  // technical-marker filter, which would otherwise drop a whole requirement
  // because it illustrated "bold" with a tag.
  [/\s*\((?:e\.g\.,?\s*)?(?:HTML\s*)?(?:[^()]*(?:display\s*:|y=\d|x ascending|\.js:\d|px\b|z-index|aria-|<\/?[a-z][a-z0-9]*\s*\/?>)[^()]*)\)/gi, ""],
];

function translate(text) {
  let out = text;
  for (const [pattern, replacement] of TRANSLATIONS) out = out.replace(pattern, replacement);
  return out.replace(/\s{2,}/g, " ").replace(/\s+([.,;:])/g, "$1").trim();
}

/* ------------------------------------------------------------------ *
 * The vocabulary AMENDMENT B bans from every customer-facing view      *
 * ------------------------------------------------------------------ *
 * This list lives here, beside the filter that enforces it, and `jargon-scan.mjs`
 * imports it — one list, one meaning. It used to live only in the scanner,
 * which meant the renderer had no way to know what it must not emit and the
 * gate could only report the leak after the fact.
 */
export const BANNED = [
  "obligation",
  "facet",
  "assertion status",
  "certification blocker",
  "certification facet",
  "derived verdict",
  "publication gate",
  "coverage axis",
  "attestation",
  "attested",
  "sealed revision",
  "contract revision",
  "revision id",
  "matcher version",
  "registry version",
  "compiler version",
  "not-browser-observable",
  "not browser-observable",
  "adjudication",
  "adjudicated",
  "tripwire",
  "scope digest",
];

const BANNED_RE = new RegExp(`(?:${BANNED.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "i");

/* ------------------------------------------------------------------ *
 * 3. The technical markers                                            *
 * ------------------------------------------------------------------ */

/**
 * A sentence carrying any of these is engineering, not survey work, and does
 * not reach the customer copy. Each entry names what it catches so a future
 * reader can tell whether a new false positive is the pattern's fault.
 */
export const TECHNICAL_MARKERS = [
  { id: "stack-frame", re: /\b\w+\.(?:js|ts|mjs|css|html)\s*:\s*\d+/i },
  { id: "exception", re: /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|Uncaught|stack trace)\b/i },
  { id: "js-api", re: /\bwindow\.[A-Za-z]|\bdocument\.[A-Za-z]|\bgetter\b|\bproperty descriptor\b/i },
  { id: "markup-tag", re: /<\/?[a-z][a-z0-9]*\s*\/?>/i },
  { id: "css-declaration", re: /\b(?:display|visibility|position|z-index|overflow)\s*:\s*[a-z-]+/i },
  { id: "dom-locator", re: /#[a-z][\w-]*\s+(?:container|element|node)|\bDOM\b|\bselector\b|\bcss selector\b/i },
  { id: "url-scheme", re: /\b(?:https?|file|data|blob):\/\//i },
  { id: "harness", re: /\bshim\b|\bharness\b|\bChromium\b|\bheadless\b|\bdriver\b/i },
  { id: "pixel-geometry", re: /\b[xy]\s*=\s*\d+|\b\d{3,4}\s*x\s*\d{3,4}\b|\b\d+\s*px\b/i },
  { id: "record-id", re: /\b(?:EXP|FLOOR|EV|AT|RUN|CR|JR)-[A-Z0-9]/ },
  // A serialised probe result rather than a sentence: `kinds=["radio"]
  // names=["S1"]`, `{"screen":"Q1"}`. The judging engine writes these as witness
  // notes, and they are locators, not descriptions of what was on screen.
  { id: "serialised-value", re: /[A-Za-z_][\w.]*\s*=\s*[[{"]|[[{]"|"\s*:\s*"/ },
  // THE BACKSTOP. Record prose is written by engineers and reaches for the
  // engineering vocabulary; a sentence still carrying a banned term after
  // translation does not go in front of a customer at all. Before this rule the
  // gate could only report the leak — one shipped as soon as a card body stopped
  // truncating the record at 150 characters.
  { id: "banned-vocabulary", re: BANNED_RE },
];

/** Split on sentence ends, keeping abbreviations and decimals intact. */
function sentences(text) {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'(\[])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function technicalReason(sentence) {
  for (const m of TECHNICAL_MARKERS) if (m.re.test(sentence)) return m.id;
  return null;
}

/* ------------------------------------------------------------------ *
 * The public filter                                                   *
 * ------------------------------------------------------------------ */

/**
 * @param {string|null|undefined} raw   text as the record wrote it
 * @param {object} [opts]
 * @param {number} [opts.maxChars]      budget; only ever cut at a SENTENCE end
 * @returns {{ text: string|null, dropped: Array<{sentence:string, marker:string}>, changed: boolean }}
 *
 * `text` is null when nothing survived. A caller that gets null must fall back
 * to a fixed phrase — it must NOT print the raw string, which is the failure
 * this module exists to stop.
 */
export function plainify(raw, { maxChars = 420, stripMetaTail = false, dropTechnical = true } = {}) {
  const source = String(raw ?? "").trim();
  if (!source) return { text: null, dropped: [], changed: false };

  let stripped = source
    .replace(PROVENANCE_SUFFIX, "")
    .replace(AMBIGUITY_MARKER, "")
    .replace(AMBIGUITY_PREFIX, "")
    .replace(RECORD_PREFIX, "")
    .replace(READING_PREFIX, "")
    .trim();
  if (stripMetaTail) {
    for (const re of META_TAIL) stripped = stripped.replace(re, "");
    // Removing "…, so both meanings are plausible." leaves "…, so" hanging.
    stripped = trimDangling(stripped);
    if (stripped && !/[.!?]$/.test(stripped)) stripped += ".";
  }
  stripped = stripped.trim();

  const kept = [];
  const dropped = [];
  for (const sentence of sentences(stripped)) {
    const translated = translate(sentence);
    // `dropTechnical: false` is for EXTRACTION prose — the requirement and the
    // expected-observable text, which describe the questionnaire rather than
    // the run. Those are already written for a person; they occasionally
    // illustrate a term with a tag, and dropping the sentence over the
    // illustration would delete the requirement itself. Run diagnostics
    // (`finding.observed`, attempt traces) always use the full filter.
    const marker = dropTechnical ? technicalReason(translated) : null;
    if (marker) {
      dropped.push({ sentence, marker });
      continue;
    }
    kept.push(translated);
  }

  if (!kept.length) return { text: null, dropped, changed: true };

  // Budget is applied at sentence boundaries ONLY. A title or a paragraph is
  // never cut mid-word: either a whole sentence fits or it is not shown.
  const out = [];
  let used = 0;
  for (const s of kept) {
    if (out.length && used + s.length + 1 > maxChars) break;
    out.push(s);
    used += s.length + 1;
  }
  const text = out.join(" ").trim();
  return {
    text: text || null,
    dropped,
    changed: text !== source,
  };
}

/** Convenience: the plain text, or a fixed fallback phrase. Never the raw record. */
export function plainOr(raw, fallback, opts) {
  const { text } = plainify(raw, opts);
  return text ?? fallback;
}

/* ------------------------------------------------------------------ *
 * Headlines                                                           *
 * ------------------------------------------------------------------ */

/**
 * A card headline, cut at a WORD boundary and never inside a word.
 *
 * The build this replaces called `.slice(0, 150)` on the record summary, which
 * shipped titles ending `… The document g` and `… Retaining the respo`. A
 * budget that cannot be met at a word boundary returns null so the caller can
 * use its fixed short form instead.
 */
export function headline(text, { maxChars = 120 } = {}) {
  const s = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  if (s.length <= maxChars) return s.replace(/[.,;:]$/, "");

  // A cut is only allowed at a boundary that leaves a phrase worth reading.
  // `minKeep` stops the old failure in the other direction: a comma 30
  // characters in produced the title "Screen-out wording is verbatim", which is
  // grammatical, short, and says nothing.
  const minKeep = Math.floor(maxChars * 0.5);
  const window = s.slice(0, maxChars + 1);
  const boundaries = [", ", "; ", " — ", " – ", " and ", " but ", " or ", " while ", " without ", " because "].map((b) =>
    window.lastIndexOf(b)
  );
  const clause = Math.max(...boundaries);
  if (clause >= minKeep) return trimDangling(s.slice(0, clause));
  const word = window.lastIndexOf(" ");
  if (word >= minKeep) return `${trimDangling(s.slice(0, word))}…`;
  return null;
}

/**
 * A cut must not leave the title hanging on a conjunction or an article —
 * "… presentation and answer requirement, so" is a sentence fragment that reads
 * as a rendering bug even though every word in it is whole.
 */
// Verbs are NOT dangling: "…which screens those are" is a complete clause and
// trimming it produced "…which screens those".
const DANGLING = /[\s,;:—–-]+(?:so|and|but|or|the|a|an|of|to|in|on|for|with|that|which|as|at|by|from|its|their|while|without|because)$/i;

function trimDangling(text) {
  let out = text.replace(/[.,;:\s]+$/, "");
  for (let i = 0; i < 3 && DANGLING.test(out); i += 1) out = out.replace(DANGLING, "");
  return out.replace(/[.,;:\s]+$/, "");
}

/* ------------------------------------------------------------------ *
 * Structured values, rendered as text                                 *
 * ------------------------------------------------------------------ */

/**
 * Render a recorded value as a readable line instead of `[object Object]` or a
 * raw JSON blob.
 *
 * The shipped build printed `[object Object]` 107 times (every `Predicate
 * detail`, which is an object) and 346 `JSON.stringify` blobs (evidence scope,
 * case expansion, settlement, ambiguity entries). Both are inside the
 * `Technical details` disclosure, which is the right LAYER — but a reader who
 * opens that disclosure is still a reader, and `[object Object]` is not
 * information at any layer.
 *
 * Scalars render as themselves. Objects render as `key: value` pairs joined by
 * `·`. Arrays render as a comma list, with a count once they get long. Nesting
 * is followed one level and then summarised, so a deep structure degrades to a
 * description rather than to a wall of braces.
 */
export function readableValue(value, { depth = 0, maxItems = 8 } = {}) {
  if (value === null || value === undefined) return "not recorded";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (!value.length) return "none";
    const shown = value.slice(0, maxItems).map((v) => readableValue(v, { depth: depth + 1, maxItems }));
    const extra = value.length - shown.length;
    return shown.join(", ") + (extra > 0 ? `, and ${extra} more (${value.length} in total)` : "");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== "");
    if (!entries.length) return "none recorded";
    if (depth >= 2) return `${entries.length} field(s): ${entries.map(([k]) => humanKey(k)).join(", ")}`;
    return entries
      .slice(0, maxItems)
      .map(([k, v]) => `${humanKey(k)}: ${readableValue(v, { depth: depth + 1, maxItems })}`)
      .join(" · ");
  }
  return String(value);
}

/** `capturesScanned` → `captures scanned`; `membersDigest` → `members digest`. */
export function humanKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

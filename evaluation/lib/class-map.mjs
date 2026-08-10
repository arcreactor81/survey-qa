/**
 * PINNED VOCABULARY — survey-qa evaluation ablation
 *
 * Everything in this file is pre-registered in PRE-REGISTRATION.md §2 and §3.2 and is
 * hashed into FREEZE.json. Changing any table here after the first scored run changes
 * what "found the defect" means, so it requires an --amend with a written reason.
 *
 * Three tables live here:
 *   1. REQUIREMENT_CLASSES  — the owner's 16 tokens; shared vocabulary with GPT-5.6-sol.
 *   2. KEY_CLASS_MAP        — corpus-key taxonomy -> requirement classes (the eligibility gate).
 *   3. CLASS_PREDICATES     — requirement class -> admissible observable predicates.
 *
 * Plus `pinned-locator-rules/1`, lifted verbatim from scorer/docs/threat-model.md §5.1
 * rather than reinvented, so a locator means the same thing here as it does in the scorer.
 */

export const VOCAB_VERSION = "survey-qa-eval-vocab/1.0.0";
export const LOCATOR_RULES_VERSION = "pinned-locator-rules/1";

/** §2.1 — the 16 requirement classes. Order is stable; the report prints them in it. */
export const REQUIREMENT_CLASSES = [
  "routing",
  "terminate",
  "base-filter",
  "question-presence-order",
  "wording",
  "option-list",
  "option-order",
  "scale-labels",
  "randomisation-anchors",
  "exclusive-options",
  "validation",
  "progress-bar",
  "piping",
  "carry-forward",
  "back-navigation-state",
  "quotas",
];

/**
 * §4.6 — the PREDICTED seam, written down so it can be falsified.
 * A class whose predicted owner does not outperform the other component is a finding
 * about the architecture, and the report says so.
 */
export const PREDICTED_OWNER = {
  routing: "graph",
  terminate: "graph",
  "base-filter": "graph",
  "question-presence-order": "graph",
  quotas: "graph",
  wording: "model",
  "option-list": "model",
  "option-order": "model",
  "scale-labels": "model",
  "randomisation-anchors": "model",
  "exclusive-options": "model",
  validation: "model",
  "progress-bar": "model",
  piping: "model",
  "carry-forward": "model",
  "back-navigation-state": "model",
};

/** §3.2 — the closed predicate enum. Free text is never a matcher. */
export const PREDICATES = [
  "element-absent",
  "element-present-unexpected",
  "text-differs",
  "option-absent",
  "option-present-unexpected",
  "option-order-differs",
  "route-destination-differs",
  "route-fired-unexpectedly",
  "route-not-fired",
  "terminate-not-triggered",
  "terminate-triggered-unexpectedly",
  "constraint-not-enforced",
  "constraint-over-enforced",
  "exclusivity-not-enforced",
  "randomisation-absent",
  "randomisation-present-unexpected",
  "anchor-moved",
  "value-differs",
  "set-differs",
  "set-order-differs",
  "raw-code-displayed",
  "denominator-differs",
  "monotonicity-violated",
  "state-retained-unexpectedly",
  "state-cleared-unexpectedly",
  "base-population-differs",
];

/** requirementClass -> admissible predicates. A predicate outside its class is a SCHEMA error. */
export const CLASS_PREDICATES = {
  routing: ["route-destination-differs", "route-fired-unexpectedly", "route-not-fired"],
  terminate: [
    "terminate-not-triggered",
    "terminate-triggered-unexpectedly",
    "route-destination-differs",
  ],
  "base-filter": ["base-population-differs", "element-present-unexpected", "element-absent"],
  "question-presence-order": [
    "element-absent",
    "element-present-unexpected",
    "set-order-differs",
  ],
  wording: ["text-differs"],
  "option-list": ["option-absent", "option-present-unexpected", "text-differs", "set-differs"],
  "option-order": ["option-order-differs", "set-order-differs"],
  "scale-labels": ["text-differs", "set-differs", "set-order-differs"],
  "randomisation-anchors": [
    "randomisation-absent",
    "randomisation-present-unexpected",
    "anchor-moved",
    "option-order-differs",
  ],
  "exclusive-options": ["exclusivity-not-enforced", "constraint-not-enforced"],
  validation: ["constraint-not-enforced", "constraint-over-enforced"],
  "progress-bar": ["denominator-differs", "monotonicity-violated", "value-differs"],
  piping: ["value-differs", "raw-code-displayed", "text-differs"],
  "carry-forward": ["set-differs", "set-order-differs"],
  "back-navigation-state": ["state-retained-unexpectedly", "state-cleared-unexpectedly"],
  quotas: [
    "constraint-not-enforced",
    "constraint-over-enforced",
    "value-differs",
    "route-destination-differs",
  ],
};

/**
 * §2.2 — corpus-key `class` -> eligible requirementClass set.
 * Where a key class maps to more than one, BOTH are admissible at the gate and the
 * discrimination is done by the observable predicate, never by the class token.
 * Class agreement is a GATE, never a matcher.
 */
export const KEY_CLASS_MAP = {
  routing: ["routing"],
  terminate: ["terminate"],
  "option-list": ["option-list", "option-order"],
  wording: ["wording", "scale-labels"],
  "missing-extra": ["question-presence-order"],
  missing: ["question-presence-order"],
  extra: ["question-presence-order"],
  randomisation: ["randomisation-anchors"],
  randomization: ["randomisation-anchors"],
  "exclusive-options": ["exclusive-options"],
  validation: ["validation"],
  "base-filter": ["base-filter"],
  "carry-forward": ["carry-forward"],
  piping: ["piping"],
  "progress-bar": ["progress-bar"],
  "state-on-re-entry": ["back-navigation-state"],
  quota: ["quotas"],
  quotas: ["quotas"],
};

/** §2.3 — continuity with docs/structured-claim-contract-merged.md §4 (the 10 claim kinds). */
export const CLAIM_KIND_OF = {
  routing: "routing-mismatch",
  terminate: "routing-mismatch",
  "base-filter": "visibility-mismatch",
  "question-presence-order": "visibility-mismatch",
  wording: "rendered-state-mismatch",
  "option-list": "rendered-state-mismatch",
  "option-order": "ordering-mismatch",
  "scale-labels": "rendered-state-mismatch",
  "randomisation-anchors": "ordering-mismatch",
  "exclusive-options": "validation-mismatch",
  validation: "validation-mismatch",
  "progress-bar": "rendered-state-mismatch",
  piping: "piping-mismatch",
  "carry-forward": "carry-forward-mismatch",
  // The registry has no state-persistence kind. Recorded, not papered over (§2.3).
  "back-navigation-state": "rendered-state-mismatch",
  quotas: "calculation-mismatch",
};

/** Registry precedence for duplicate symptoms (merged-contract §4), kept for report ordering. */
export const REGISTRY_PRECEDENCE = [
  "visibility-mismatch",
  "condition-mismatch",
  "routing-mismatch",
  "ordering-mismatch",
  "rendered-state-mismatch",
];

// ---------------------------------------------------------------------------
// pinned-locator-rules/1
// ---------------------------------------------------------------------------

/** Structural word -> canonical prefix. Longest-token-first is handled by exact lookup. */
const STRUCTURAL = {
  question: "q", ques: "q", qn: "q", q: "q",
  screener: "s", scr: "s", s: "s",
  section: "sec", sect: "sec", sec: "sec",
  loop: "l", l: "l",
  block: "b", blk: "b", b: "b",
  page: "p", pg: "p", p: "p",
  grid: "grid",
  item: "item", itm: "item",
  rule: "rule",
};

const GLOBAL_TOKENS = new Set([
  "global", "all", "survey", "document", "throughout", "various", "multiple",
  "everywhere", "n/a", "na", "site-wide", "sitewide", "whole survey",
]);

/**
 * Canonicalise one atomic locator.
 *   Q12 === Question 12 === q 12      -> "q12"
 *   S3  === Screener 3                -> "s3"
 *   Loop L1 (Q2-Q3)                   -> "l1-q2-q3"
 */
export function normaliseLocator(raw) {
  if (raw === null || raw === undefined) return "";
  let s = String(raw).normalize("NFKC").toLowerCase();
  s = s.replace(/[‐-―−]/g, "-"); // unicode dashes -> ascii hyphen
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  if (!s) return "";

  const tokens = s.split(/\s+/);
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    // "question" + "12"  ->  "q12"
    if (STRUCTURAL[t] && i + 1 < tokens.length && /^\d+[a-z]?$/.test(tokens[i + 1])) {
      out.push(STRUCTURAL[t] + tokens[i + 1]);
      i += 1;
      continue;
    }
    // "q12" / "screener3" -> canonical prefix + number
    const glued = /^([a-z]+)(\d+[a-z]?)$/.exec(t);
    if (glued && STRUCTURAL[glued[1]]) {
      out.push(STRUCTURAL[glued[1]] + glued[2]);
      continue;
    }
    out.push(t);
  }
  // drop a leading structural word that already precedes a canonical token
  while (out.length > 1 && STRUCTURAL[out[0]] && /^[a-z]+\d/.test(out[1])) out.shift();
  return out.join("-");
}

/**
 * Parse a key `location` field, which is prose and may be atomic, a set, a range, or global.
 * Returns { kind: "atomic"|"set"|"global", values: string[] }.
 *
 * §5.2: a `global` spec WAIVES the location gate and sends the pair straight to
 * adjudication. It is never auto-credited — a waived gate that awards credit is how
 * "checked everything" becomes true by fiat.
 */
export function parseLocationSpec(raw) {
  const r = String(raw ?? "").trim();
  if (!r) return { kind: "global", values: [] };
  if (GLOBAL_TOKENS.has(r.toLowerCase())) return { kind: "global", values: [] };
  if (/\b(all|every|global|throughout|multiple|various)\b/i.test(r)) {
    return { kind: "global", values: [] };
  }

  // explicit set: "Q3, Q7" / "Q3 and Q7" / "Q3 & Q7"
  const parts = r.split(/\s*(?:,|;|&|\band\b)\s*/i).filter(Boolean);
  if (parts.length > 1) {
    return { kind: "set", values: dedupe(parts.flatMap((p) => expandOne(p))) };
  }

  const expanded = expandOne(r);
  return {
    kind: expanded.length > 1 ? "set" : "atomic",
    values: dedupe(expanded),
  };
}

/** Expand a single part, which may itself be a range like "Q4-Q9". */
function expandOne(part) {
  const m = /^\s*([a-z]+)?\s*(\d+)\s*[-–—]\s*([a-z]+)?\s*(\d+)\s*$/i.exec(part);
  if (m) {
    const prefixRaw = (m[1] || m[3] || "q").toLowerCase();
    const prefix = STRUCTURAL[prefixRaw] ?? prefixRaw;
    const lo = Number(m[2]);
    const hi = Number(m[4]);
    // A range must ascend and stay small. Anything else is a code (e.g. "T-14"), not a range.
    if (hi > lo && hi - lo <= 50) {
      const outs = [];
      for (let n = lo; n <= hi; n += 1) outs.push(`${prefix}${n}`);
      return outs;
    }
  }
  const one = normaliseLocator(part);
  return one ? [one] : [];
}

function dedupe(xs) {
  return [...new Set(xs)];
}

/** Normalise a corpus-key `class` token to a KEY_CLASS_MAP key. */
export function normaliseKeyClass(raw) {
  return String(raw ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The eligibility gate's class half (§5.2 M1.2).
 * Returns { classes: string[], taxonomyGap: boolean }.
 * A key class outside the map is a TAXONOMY_GAP — never forced into the nearest token.
 */
export function eligibleClasses(keyClassRaw) {
  const k = normaliseKeyClass(keyClassRaw);
  if (KEY_CLASS_MAP[k]) return { classes: KEY_CLASS_MAP[k], taxonomyGap: false };
  // Tolerate a direct requirement-class token in the key (some authors will write one).
  if (REQUIREMENT_CLASSES.includes(k)) return { classes: [k], taxonomyGap: false };
  return { classes: [], taxonomyGap: true };
}

/** Is this predicate admissible for this requirement class? (§3.2) */
export function predicateAdmissible(requirementClass, predicate) {
  const allowed = CLASS_PREDICATES[requirementClass];
  return Array.isArray(allowed) && allowed.includes(predicate);
}

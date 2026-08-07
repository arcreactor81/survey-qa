/**
 * MODEL OUTPUT → TYPED EXTRACTION INPUT.
 *
 * A model returns JSON that is nearly the schema it was given. This module turns "nearly"
 * into "exactly", and it DROPS what it cannot bind rather than filling in a default:
 * a requirement with no statement, no quote or no block id is not a requirement with empty
 * fields, it is an item the merge cannot check, cite or expand — so it never enters the
 * denominator. Every drop is counted so the diff can say how many there were.
 */

import { CONSTRUCT_CLASSES, type ConstructVerdict, type BlockDisposition, type RawAmbiguity, type RawExpansion, type RawRequirement, type RawUnverifiable } from "./types";

export const asArray = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)) : [];

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strOrNull = (v: unknown): string | null => {
  const s = str(v);
  return s.length > 0 && s.toLowerCase() !== "null" ? s : null;
};
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x)).filter((s) => s.length > 0) : [];

const QUANTIFIERS = new Set(["every", "each", "only", "any", "none", "specific"]);
const OBSERVABLE = new Set(["full", "partial", "none"]);
const EXPANSION_KINDS = new Set(["route", "boundary", "option-set", "rendered-state", "copy", "configuration"]);

/** Drops that this module performed, for the diff's "what was unusable" line. */
export const dropCounts = { noStatement: 0, noQuote: 0, noBlockId: 0 };
export const resetDrops = (): void => {
  dropCounts.noStatement = 0;
  dropCounts.noQuote = 0;
  dropCounts.noBlockId = 0;
};

export function coerceRequirement(
  raw: Record<string, unknown>,
  pass: "A" | "B",
  origin: string,
  defaultScope: string,
): RawRequirement | null {
  const statement = str(raw["statement"]);
  const docQuote = typeof raw["doc_quote"] === "string" ? raw["doc_quote"] : "";
  const blockIds = strList(raw["block_ids"]);
  if (statement.length === 0) {
    dropCounts.noStatement += 1;
    return null;
  }
  if (docQuote.trim().length === 0) {
    dropCounts.noQuote += 1;
    return null;
  }
  if (blockIds.length === 0) {
    dropCounts.noBlockId += 1;
    return null;
  }
  const q = str(raw["quantifier"]).toLowerCase();
  const obs = str(raw["browser_observable"]).toLowerCase();
  const confidence = typeof raw["confidence"] === "number" && Number.isFinite(raw["confidence"]) ? raw["confidence"] : 0.5;
  return {
    id: str(raw["id"]) || `${pass}-${blockIds[0]}`,
    construct: str(raw["construct"]).toLowerCase() || "other",
    scope: strOrNull(raw["scope"]) ?? defaultScope,
    quantifier: QUANTIFIERS.has(q) ? q : "specific",
    selector: strOrNull(raw["selector"]),
    exceptions: strList(raw["exceptions"]),
    statement,
    docQuote,
    blockIds,
    browserObservable: (OBSERVABLE.has(obs) ? obs : "full") as RawRequirement["browserObservable"],
    confidence: Math.min(1, Math.max(0, confidence)),
    expansion: coerceExpansion(raw["expansion"]),
    pass,
    origin,
  };
}

function coerceExpansion(v: unknown): RawExpansion | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const kind = str(o["kind"]).toLowerCase();
  if (!EXPANSION_KINDS.has(kind)) return null;
  const answers = asArray(o["route_answers"])
    .map((a) => ({
      code: strOrNull(a["code"]),
      label: strOrNull(a["label"]),
      destination: strOrNull(a["destination"]),
    }))
    // An answer with neither a code nor a label names nothing a browser could click.
    .filter((a) => a.code !== null || a.label !== null);
  const numOrNull = (x: unknown): number | null =>
    typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : null;
  return {
    kind: kind as RawExpansion["kind"],
    routeAnswers: answers,
    maxLength: numOrNull(o["max_length"]),
    minSelections: numOrNull(o["min_selections"]),
    maxSelections: numOrNull(o["max_selections"]),
  };
}

export function coerceAmbiguities(v: unknown, pass: "A" | "B"): RawAmbiguity[] {
  const out: RawAmbiguity[] = [];
  for (const a of asArray(v)) {
    const readingA = str(a["reading_a"]);
    const readingB = str(a["reading_b"]);
    if (readingA.length === 0 || readingB.length === 0) continue; // one reading is not an ambiguity
    out.push({
      id: str(a["id"]) || `AMB-${pass}-${out.length + 1}`,
      docQuote: typeof a["doc_quote"] === "string" ? a["doc_quote"] : "",
      readingA,
      readingB,
      whyAmbiguous: str(a["why_ambiguous"]),
      affects: strList(a["affects"]),
      pass,
    });
  }
  return out;
}

export function coerceUnverifiable(v: unknown, pass: "A" | "B"): RawUnverifiable[] {
  const out: RawUnverifiable[] = [];
  for (const u of asArray(v)) {
    const mandate = str(u["mandate"]);
    if (mandate.length === 0) continue;
    out.push({
      id: str(u["id"]) || `UNV-${pass}-${out.length + 1}`,
      docQuote: typeof u["doc_quote"] === "string" ? u["doc_quote"] : "",
      mandate,
      whyNotObservable: str(u["why_not_observable"]),
      browserProxyEvidence: str(u["browser_proxy_evidence"]) || "none stated",
      pass,
    });
  }
  return out;
}

const DISPOSITIONS = new Set(["normative", "mapped-context", "non-normative", "ambiguous"]);

export function coerceDispositions(v: unknown, allowed: Set<string>): BlockDisposition[] {
  const out: BlockDisposition[] = [];
  const seen = new Set<string>();
  for (const d of asArray(v)) {
    const blockId = str(d["block_id"]);
    // A disposition for a block that was not in the chunk is a hallucinated id, not
    // coverage of anything: accepting it would let a pass "account for" blocks it never saw.
    if (!allowed.has(blockId) || seen.has(blockId)) continue;
    const disposition = str(d["disposition"]).toLowerCase();
    seen.add(blockId);
    out.push({
      blockId,
      disposition: (DISPOSITIONS.has(disposition) ? disposition : "unresolved") as BlockDisposition["disposition"],
      reason: str(d["reason"]),
    });
  }
  return out;
}

export function coerceConstructs(v: unknown): ConstructVerdict[] {
  const out: ConstructVerdict[] = [];
  const seen = new Set<string>();
  for (const c of asArray(v)) {
    const construct = str(c["construct"]).toLowerCase();
    if (!CONSTRUCT_CLASSES.includes(construct as never) || seen.has(construct)) continue;
    seen.add(construct);
    out.push({
      construct: construct as ConstructVerdict["construct"],
      present: c["present"] === true,
      blockIds: strList(c["block_ids"]),
    });
  }
  return out;
}

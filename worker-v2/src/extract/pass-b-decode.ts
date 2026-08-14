/**
 * Strict decoder for one Pass-B provider answer.
 *
 * A provider response is an all-or-nothing unit of evidence. Dropping one malformed
 * row while retaining its neighbours silently shortens the document reading, so every
 * array and every row is validated before any typed output is returned.
 */

import {
  CONSTRUCT_CLASSES,
  type BlockDisposition,
  type ConstructVerdict,
  type RawAmbiguity,
  type RawExpansion,
  type RawRequirement,
  type RawUnverifiable,
  type SourceBlock,
} from "./types";

export const PASS_B_DECODER_VERSION = "pass-b-strict-output/1.1.0";

export class PassBOutputInvalid extends Error {
  constructor(detail: string) {
    super(`PASS_B_OUTPUT_INVALID: ${detail}`);
    this.name = "PassBOutputInvalid";
  }
}

export interface DecodedPassBOutput {
  obligations: RawRequirement[];
  dispositions: BlockDisposition[];
  constructs: ConstructVerdict[];
  ambiguities: RawAmbiguity[];
  unverifiable: RawUnverifiable[];
}

const QUANTIFIERS = new Set(["every", "each", "only", "any", "none", "specific"]);
const OBSERVABILITY = new Set(["full", "partial", "none"]);
const DISPOSITIONS = new Set(["normative", "mapped-context", "non-normative", "ambiguous"]);
const EXPANSION_KINDS = new Set([
  "route", "boundary", "option-set", "rendered-state", "copy", "configuration",
]);
const CONSTRUCTS = new Set<string>(CONSTRUCT_CLASSES);

function fail(detail: string): never {
  throw new PassBOutputInvalid(detail);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(row).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} has unknown or missing fields (expected ${wanted.join(", ")}; got ${actual.join(", ")})`);
  }
}

function rows(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value.map((entry, index) => object(entry, `${label}[${index}]`));
}

function evidenceQuotes(
  value: unknown,
  label: string,
  blockIds: readonly string[],
  sourceById: ReadonlyMap<string, SourceBlock>,
): Array<{ blockId: string; quote: string }> {
  const seen = new Set<string>();
  const evidence = rows(value, label).map((raw, index) => {
    const rowLabel = `${label}[${index}]`;
    exactKeys(raw, ["block_id", "quote"], rowLabel);
    const blockId = nonempty(raw["block_id"], `${rowLabel}.block_id`);
    const quote = nonempty(raw["quote"], `${rowLabel}.quote`);
    const source = sourceById.get(blockId);
    if (!source || !blockIds.includes(blockId)) fail(`${rowLabel}.block_id is outside this row's cited source blocks`);
    if (seen.has(blockId)) fail(`${rowLabel}.block_id is duplicated`);
    if (!source.text.includes(quote)) fail(`${rowLabel}.quote is not an exact span of source block ${blockId}`);
    seen.add(blockId);
    return { blockId, quote };
  });
  if (seen.size !== blockIds.length || blockIds.some((id) => !seen.has(id))) {
    fail(`${label} must contain exactly one grounded quote for every cited source block`);
  }
  return evidence;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be a non-empty string`);
  return value.trim();
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return nonempty(value, label);
}

function stringList(value: unknown, label: string, unique = false): string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const out = value.map((entry, index) => nonempty(entry, `${label}[${index}]`));
  if (unique && new Set(out).size !== out.length) fail(`${label} contains duplicate values`);
  return out;
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`${label} must be a positive integer or null`);
  }
  return value as number;
}

function expansion(value: unknown, label: string): RawExpansion | null {
  if (value === null) return null;
  const row = object(value, label);
  exactKeys(row, ["kind", "route_answers", "max_length", "min_selections", "max_selections"], label);
  const kind = nonempty(row["kind"], `${label}.kind`);
  if (!EXPANSION_KINDS.has(kind)) fail(`${label}.kind is not a closed expansion kind`);
  const routeAnswers = rows(row["route_answers"], `${label}.route_answers`).map((answer, index) => {
    const answerLabel = `${label}.route_answers[${index}]`;
    exactKeys(answer, ["code", "label", "destination"], answerLabel);
    const code = nullableString(answer["code"], `${answerLabel}.code`);
    const text = nullableString(answer["label"], `${answerLabel}.label`);
    const destination = nullableString(answer["destination"], `${answerLabel}.destination`);
    if (code === null && text === null) fail(`${answerLabel} must name a code or label`);
    return { code, label: text, destination };
  });
  const maxLength = nullablePositiveInteger(row["max_length"], `${label}.max_length`);
  const minSelections = nullablePositiveInteger(row["min_selections"], `${label}.min_selections`);
  const maxSelections = nullablePositiveInteger(row["max_selections"], `${label}.max_selections`);
  if (minSelections !== null && maxSelections !== null && minSelections > maxSelections) {
    fail(`${label}.min_selections exceeds max_selections`);
  }
  return {
    kind: kind as RawExpansion["kind"],
    routeAnswers,
    maxLength,
    minSelections,
    maxSelections,
  };
}

function obligation(
  raw: Record<string, unknown>,
  index: number,
  unitId: string,
  sourceById: ReadonlyMap<string, SourceBlock>,
): RawRequirement {
  const label = `obligations[${index}]`;
  exactKeys(raw, [
    "id", "construct", "scope", "quantifier", "selector", "exceptions", "statement",
    "doc_quote", "block_ids", "evidence_quotes", "browser_observable", "confidence", "expansion",
  ], label);
  const construct = nonempty(raw["construct"], `${label}.construct`);
  if (!CONSTRUCTS.has(construct)) fail(`${label}.construct is not a closed construct class`);
  const scope = nonempty(raw["scope"], `${label}.scope`);
  if (scope !== "survey" && !/^(?:section|question):.+/u.test(scope)) {
    fail(`${label}.scope must be survey, section:<name>, or question:<id>`);
  }
  const quantifier = nonempty(raw["quantifier"], `${label}.quantifier`);
  if (!QUANTIFIERS.has(quantifier)) fail(`${label}.quantifier is not a closed quantifier`);
  const observable = nonempty(raw["browser_observable"], `${label}.browser_observable`);
  if (!OBSERVABILITY.has(observable)) fail(`${label}.browser_observable is not closed`);
  const blockIds = stringList(raw["block_ids"], `${label}.block_ids`, true);
  if (blockIds.length === 0 || blockIds.some((id) => !sourceById.has(id))) {
    fail(`${label}.block_ids must be a non-empty subset of this unit's source blocks`);
  }
  const evidence = evidenceQuotes(raw["evidence_quotes"], `${label}.evidence_quotes`, blockIds, sourceById);
  const docQuote = nonempty(raw["doc_quote"], `${label}.doc_quote`);
  if (!evidence.some((row) => row.quote === docQuote)) {
    fail(`${label}.doc_quote must equal one exact per-block evidence quote`);
  }
  if (typeof raw["confidence"] !== "number" || !Number.isFinite(raw["confidence"]) ||
      (raw["confidence"] as number) < 0 || (raw["confidence"] as number) > 1) {
    fail(`${label}.confidence must be a finite number within 0..1`);
  }
  return {
    id: nonempty(raw["id"], `${label}.id`),
    construct,
    scope,
    quantifier,
    selector: nullableString(raw["selector"], `${label}.selector`),
    exceptions: stringList(raw["exceptions"], `${label}.exceptions`),
    statement: nonempty(raw["statement"], `${label}.statement`),
    docQuote,
    blockIds,
    browserObservable: observable as RawRequirement["browserObservable"],
    confidence: raw["confidence"] as number,
    expansion: expansion(raw["expansion"], `${label}.expansion`),
    pass: "B",
    origin: unitId,
    evidenceQuotes: evidence,
  };
}

function dispositions(value: unknown, allowed: Set<string>): BlockDisposition[] {
  const seen = new Set<string>();
  const out = rows(value, "block_dispositions").map((raw, index) => {
    const label = `block_dispositions[${index}]`;
    exactKeys(raw, ["block_id", "disposition", "reason"], label);
    const blockId = nonempty(raw["block_id"], `${label}.block_id`);
    const disposition = nonempty(raw["disposition"], `${label}.disposition`);
    if (!allowed.has(blockId)) fail(`${label}.block_id is outside this unit`);
    if (seen.has(blockId)) fail(`${label}.block_id is duplicated`);
    if (!DISPOSITIONS.has(disposition)) fail(`${label}.disposition is not closed`);
    seen.add(blockId);
    return {
      blockId,
      disposition: disposition as BlockDisposition["disposition"],
      reason: nonempty(raw["reason"], `${label}.reason`),
    };
  });
  if (seen.size !== allowed.size || [...allowed].some((id) => !seen.has(id))) {
    fail(`block_dispositions must contain exactly one row for every source block in this unit`);
  }
  return out;
}

function constructs(value: unknown, allowed: Set<string>): ConstructVerdict[] {
  const seen = new Set<string>();
  const out = rows(value, "construct_checklist").map((raw, index) => {
    const label = `construct_checklist[${index}]`;
    exactKeys(raw, ["construct", "present", "block_ids"], label);
    const construct = nonempty(raw["construct"], `${label}.construct`);
    if (!CONSTRUCTS.has(construct) || seen.has(construct)) fail(`${label}.construct is unknown or duplicated`);
    if (typeof raw["present"] !== "boolean") fail(`${label}.present must be boolean`);
    const blockIds = stringList(raw["block_ids"], `${label}.block_ids`, true);
    if (blockIds.some((id) => !allowed.has(id))) fail(`${label}.block_ids contains a foreign block`);
    if ((raw["present"] === true) !== (blockIds.length > 0)) {
      fail(`${label}.present must agree with whether evidence block_ids are present`);
    }
    seen.add(construct);
    return { construct: construct as ConstructVerdict["construct"], present: raw["present"], blockIds };
  });
  if (seen.size !== CONSTRUCT_CLASSES.length || CONSTRUCT_CLASSES.some((name) => !seen.has(name))) {
    fail(`construct_checklist must contain each closed construct class exactly once`);
  }
  return out;
}

function ambiguities(value: unknown, sourceById: ReadonlyMap<string, SourceBlock>): RawAmbiguity[] {
  return rows(value, "ambiguities").map((raw, index) => {
    const label = `ambiguities[${index}]`;
    exactKeys(raw, [
      "id", "block_ids", "evidence_quotes", "doc_quote", "reading_a", "reading_b",
      "why_ambiguous", "affects",
    ], label);
    const readingA = nonempty(raw["reading_a"], `${label}.reading_a`);
    const readingB = nonempty(raw["reading_b"], `${label}.reading_b`);
    if (readingA === readingB) fail(`${label} must contain two distinct readings`);
    const blockIds = stringList(raw["block_ids"], `${label}.block_ids`, true);
    if (blockIds.length === 0 || blockIds.some((id) => !sourceById.has(id))) {
      fail(`${label}.block_ids must be a non-empty subset of this unit's source blocks`);
    }
    const evidence = evidenceQuotes(raw["evidence_quotes"], `${label}.evidence_quotes`, blockIds, sourceById);
    const docQuote = nonempty(raw["doc_quote"], `${label}.doc_quote`);
    if (!evidence.some((row) => row.quote === docQuote)) fail(`${label}.doc_quote is not exact source evidence`);
    return {
      id: nonempty(raw["id"], `${label}.id`),
      docQuote,
      readingA,
      readingB,
      whyAmbiguous: nonempty(raw["why_ambiguous"], `${label}.why_ambiguous`),
      affects: stringList(raw["affects"], `${label}.affects`),
      pass: "B",
      blockIds,
      evidenceQuotes: evidence,
    };
  });
}

function unverifiable(value: unknown, sourceById: ReadonlyMap<string, SourceBlock>): RawUnverifiable[] {
  return rows(value, "unverifiable_from_browser").map((raw, index) => {
    const label = `unverifiable_from_browser[${index}]`;
    exactKeys(raw, [
      "id", "block_ids", "evidence_quotes", "doc_quote", "mandate",
      "why_not_observable", "browser_proxy_evidence",
    ], label);
    const blockIds = stringList(raw["block_ids"], `${label}.block_ids`, true);
    if (blockIds.length === 0 || blockIds.some((id) => !sourceById.has(id))) {
      fail(`${label}.block_ids must be a non-empty subset of this unit's source blocks`);
    }
    const evidence = evidenceQuotes(raw["evidence_quotes"], `${label}.evidence_quotes`, blockIds, sourceById);
    const docQuote = nonempty(raw["doc_quote"], `${label}.doc_quote`);
    if (!evidence.some((row) => row.quote === docQuote)) fail(`${label}.doc_quote is not exact source evidence`);
    return {
      id: nonempty(raw["id"], `${label}.id`),
      docQuote,
      mandate: nonempty(raw["mandate"], `${label}.mandate`),
      whyNotObservable: nonempty(raw["why_not_observable"], `${label}.why_not_observable`),
      browserProxyEvidence: nonempty(raw["browser_proxy_evidence"], `${label}.browser_proxy_evidence`),
      pass: "B",
      blockIds,
      evidenceQuotes: evidence,
    };
  });
}

export function decodePassBOutput(
  value: unknown,
  unitId: string,
  sourceBlocks: readonly SourceBlock[],
  evidenceSourceBlocks: readonly SourceBlock[] = sourceBlocks,
): DecodedPassBOutput {
  const root = object(value, "root");
  exactKeys(root, [
    "chunk_id", "obligations", "block_dispositions", "construct_checklist",
    "ambiguities", "unverifiable_from_browser",
  ], "root");
  if (root["chunk_id"] !== unitId) fail(`chunk_id must equal ${JSON.stringify(unitId)}`);
  const allowedBlockIds = sourceBlocks.map((block) => block.blockId);
  if (allowedBlockIds.length === 0 || new Set(allowedBlockIds).size !== allowedBlockIds.length) {
    fail(`decoder source-block ownership must be non-empty and duplicate-free`);
  }
  const allowed = new Set(allowedBlockIds);
  const sourceById = new Map(sourceBlocks.map((block) => [block.blockId, block]));
  const evidenceById = new Map([
    ...sourceBlocks.map((block) => [block.blockId, block] as const),
    ...evidenceSourceBlocks.map((block) => [block.blockId, block] as const),
  ]);
  const decoded: DecodedPassBOutput = {
    obligations: rows(root["obligations"], "obligations").map((raw, index) =>
      obligation(raw, index, unitId, sourceById)),
    dispositions: dispositions(root["block_dispositions"], allowed),
    constructs: constructs(root["construct_checklist"], allowed),
    // The prompt explicitly permits ambiguity evidence from read-only context blocks.
    // Obligations, dispositions, constructs and unverifiable mandates remain owned-block only.
    ambiguities: ambiguities(root["ambiguities"], evidenceById),
    unverifiable: unverifiable(root["unverifiable_from_browser"], sourceById),
  };
  for (const requirement of decoded.obligations) {
    if (requirement.browserObservable !== "none") continue;
    const linked = decoded.unverifiable.some((row) =>
      row.docQuote === requirement.docQuote &&
      (row.blockIds ?? []).some((blockId) => requirement.blockIds.includes(blockId)));
    if (!linked) {
      fail(
        `obligation ${requirement.id} declares browser_observable none but has no unverifiable row ` +
        `with the same exact quote and an overlapping source block`,
      );
    }
  }
  return decoded;
}

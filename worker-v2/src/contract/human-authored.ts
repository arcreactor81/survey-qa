/**
 * HUMAN-AUTHORED CONTRACT INPUT.
 *
 * This is a deliberately narrow sprint seam, not an extraction shortcut. A caller supplies
 * requirements, but never supplies authority-bearing ids, source atoms, cases, certificates,
 * gates, or verdicts. This module binds every quote to exact spans in the submitted DOCX,
 * derives identities with the extraction pipeline's identity function, and hands the rows to
 * the real floor expander. The resulting ContractRevision still goes through `sealContract`.
 *
 * LIMITATION, NAMED: this validates the rows the human supplied. It cannot mechanically prove
 * that the human found every normative statement in the document. Provenance therefore says
 * `authored-requirements-only`; nothing here claims full-document extraction coverage.
 */

import type { Env } from "../types/env";
import type {
  ContractRevision,
  HumanContractApproval,
  ScopedRequirement,
  SourceAtom,
} from "../types/record";
import type { DocumentCoverage, ParsedDocument, RawExpansion, SourceBlock } from "../extract/types";
import { parseDocxBlocks } from "../extract/docx-blocks";
import { deriveRequirementIdentity, type IdentitySeed } from "../extract/merge";
import { sourceAtomRole } from "../extract/source-role";
import { EXPANDER_VERSION, expandFloor, type ExpandableRequirementRow } from "../extract/expand";
import { canonicalHash, canonicalJson, sha256Hex } from "../store/hash";
import {
  humanContractPreparedKey,
  humanExpansionPreviewKey,
  humanRequirementsNormalizedKey,
  humanRequirementsValidationKey,
} from "../keys";
import { gatePass, type GateProof } from "../workflow/gates";

export const HUMAN_REQUIREMENTS_KIND = "survey-qa-v2-human-requirements" as const;
export const HUMAN_REQUIREMENTS_SCHEMA = "v2-human-requirements/1.0.0" as const;
export const HUMAN_REQUIREMENTS_VALIDATOR_VERSION = "v2-human-requirements-validator/1.1.0" as const;
export const HUMAN_TRANSCRIPTION_ASSUMPTION =
  "authored-statements-and-expansion-hints-are-trusted-transcriptions-not-mechanically-proven-entailments" as const;

const MAX_REQUIREMENTS = 10_000;
const MAX_SPANS_PER_REQUIREMENT = 100;
const ASSERTION_STATUSES = new Set(["entailed", "explicit-negative", "document-silent", "ambiguous", "disputed"]);
const QUANTIFIERS = new Set(["every", "each", "only", "any", "none", "specific"]);
const TESTABILITIES = new Set(["browser-observable", "not-browser-observable"]);
const EXPANSION_KINDS = new Set(["route", "boundary", "option-set", "rendered-state", "copy", "configuration"]);

type JsonObject = Record<string, unknown>;

export interface HumanSourceSpan {
  blockId: string;
  /** UTF-16 offsets into the parser's exact block text, matching JavaScript `slice`. */
  start: number;
  end: number;
}

export interface HumanRequirementInput {
  id: string;
  normativeStatement: string;
  displayQuote: string;
  sourceSpans: HumanSourceSpan[];
  scope: string;
  facet: string;
  quantifier: ScopedRequirement["quantifier"];
  selector: string | null;
  exceptions: string[];
  assertionStatus: ScopedRequirement["assertionStatus"];
  testability: ScopedRequirement["testability"];
  notBrowserObservableReason: string | null;
  expansion: RawExpansion | null;
}

export interface HumanRequirementsInput {
  schemaVersion: typeof HUMAN_REQUIREMENTS_SCHEMA;
  kind: typeof HUMAN_REQUIREMENTS_KIND;
  documentSha256: string;
  authoredBy: string;
  authoredAt: string;
  requirements: HumanRequirementInput[];
}

interface NormalizedHumanRow extends ExpandableRequirementRow {
  authorId: string;
}

interface NormalizedHumanPayload {
  schemaVersion: "v2-human-requirements-normalized/1.0.0";
  documentSha256: string;
  rawInputSha256: string;
  normalizedInputHash: string;
  authoredBy: string;
  authoredAt: string;
  rows: NormalizedHumanRow[];
}

export interface PreparedHumanContract {
  schemaVersion: "v2-human-contract-prepared/1.0.0";
  documentSha256: string;
  normalizedInputHash: string;
  authoredBy: string;
  authoredAt: string;
  documentCoverage: DocumentCoverage;
  limitations: string[];
  requirements: ScopedRequirement[];
  facetInstances: ContractRevision["facetInstances"];
  approval: HumanContractApproval;
  validationHash: string;
  previewHash: string;
}

export interface HumanValidationSummary {
  normalizedInputHash: string;
  normalizedArtifactHash: string;
  validationHash: string;
  requirementCount: number;
  documentCoverage: DocumentCoverage;
  limitations: string[];
}

export interface HumanExpansionSummary {
  preparedHash: string;
  previewHash: string;
  requirementCount: number;
  executionCaseCount: number;
  typedCaseCount: number;
  expectationGapCount: number;
}

export class HumanRequirementsError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`HUMAN_REQUIREMENTS_INVALID[${code}]: ${detail}`);
    this.name = "HumanRequirementsError";
  }
}

function invalid(code: string, detail: string): never {
  throw new HumanRequirementsError(code, detail);
}

const object = (value: unknown, path: string): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("INVALID_OBJECT", `${path} must be an object`);
  return value as JsonObject;
};

const exactKeys = (value: JsonObject, allowed: readonly string[], path: string): void => {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    invalid(
      "UNKNOWN_FIELD",
      `${path} contains unsupported field(s) [${extras.sort().join(", ")}]. Derived ids, gates, cases, and certificates are server-owned.`,
    );
  }
  const missing = allowed.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) invalid("MISSING_FIELD", `${path} is missing required field(s) [${missing.join(", ")}]`);
};

const string = (value: unknown, path: string, max = 100_000): string => {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    invalid("INVALID_STRING", `${path} must contain non-whitespace text of at most ${max} characters`);
  }
  return value;
};

const nullableString = (value: unknown, path: string, max = 100_000): string | null =>
  value === null ? null : string(value, path, max);

const integerOrNull = (value: unknown, path: string): number | null => {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid("INVALID_INTEGER", `${path} must be null or a non-negative safe integer`);
  }
  return value as number;
};

const stringArray = (value: unknown, path: string): string[] => {
  if (!Array.isArray(value)) invalid("INVALID_ARRAY", `${path} must be an array`);
  return value.map((entry, index) => string(entry, `${path}[${index}]`, 10_000));
};

const isStrictRfc3339 = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[9]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[10]);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    return false;
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= lastDay && Number.isFinite(Date.parse(value));
};

const parseExpansion = (value: unknown, path: string): RawExpansion | null => {
  if (value === null) return null;
  const raw = object(value, path);
  exactKeys(raw, ["kind", "routeAnswers", "maxLength", "minSelections", "maxSelections"], path);
  const kind = string(raw.kind, `${path}.kind`, 40);
  if (!EXPANSION_KINDS.has(kind)) invalid("INVALID_EXPANSION", `${path}.kind is not a supported expansion kind`);
  if (!Array.isArray(raw.routeAnswers)) invalid("INVALID_EXPANSION", `${path}.routeAnswers must be an array`);
  const routeAnswers = raw.routeAnswers.map((entry, index) => {
    const answer = object(entry, `${path}.routeAnswers[${index}]`);
    exactKeys(answer, ["code", "label", "destination"], `${path}.routeAnswers[${index}]`);
    const parsed = {
      code: nullableString(answer.code, `${path}.routeAnswers[${index}].code`, 1_000),
      label: nullableString(answer.label, `${path}.routeAnswers[${index}].label`, 10_000),
      destination: nullableString(answer.destination, `${path}.routeAnswers[${index}].destination`, 10_000),
    };
    if (parsed.code === null && parsed.label === null) {
      invalid("INVALID_EXPANSION", `${path}.routeAnswers[${index}] must name the answer by code, label, or both`);
    }
    return parsed;
  });
  const maxLength = integerOrNull(raw.maxLength, `${path}.maxLength`);
  const minSelections = integerOrNull(raw.minSelections, `${path}.minSelections`);
  const maxSelections = integerOrNull(raw.maxSelections, `${path}.maxSelections`);
  if (minSelections !== null && maxSelections !== null && minSelections > maxSelections) {
    invalid("INVALID_EXPANSION", `${path}.minSelections cannot exceed maxSelections`);
  }
  const answerKeys = new Set<string>();
  for (let index = 0; index < routeAnswers.length; index++) {
    const answer = routeAnswers[index]!;
    const key = `${answer.code?.trim().toLocaleLowerCase() ?? ""}\u0000${answer.label?.trim().toLocaleLowerCase() ?? ""}`;
    if (answerKeys.has(key)) invalid("DUPLICATE_ROUTE_ANSWER", `${path}.routeAnswers[${index}] duplicates an earlier answer`);
    answerKeys.add(key);
  }
  const hasLength = maxLength !== null;
  const hasSelections = minSelections !== null || maxSelections !== null;
  if (kind === "route") {
    if (hasLength || hasSelections) {
      invalid("INCOHERENT_EXPANSION", `${path} kind route cannot carry boundary fields`);
    }
  } else if (kind === "boundary") {
    if (routeAnswers.length > 0) invalid("INCOHERENT_EXPANSION", `${path} kind boundary cannot carry route answers`);
    if (!hasLength && !hasSelections) {
      invalid("INCOHERENT_EXPANSION", `${path} kind boundary must state maxLength or a selection bound`);
    }
    if (hasLength && hasSelections) {
      invalid("INCOHERENT_EXPANSION", `${path} cannot mix text-length and selection-count boundaries`);
    }
  } else if (routeAnswers.length > 0 || hasLength || hasSelections) {
    invalid("INCOHERENT_EXPANSION", `${path} kind ${kind} cannot carry route or boundary fields`);
  }
  return { kind: kind as RawExpansion["kind"], routeAnswers, maxLength, minSelections, maxSelections };
};

/**
 * `JSON.parse` silently keeps the last spelling of a duplicate object key. At an authority
 * boundary that makes the bytes a reviewer read differ from the value the validator sealed.
 * This small recursive scanner runs after syntax validation and rejects duplicates by their
 * decoded key, so `"authoredBy"` and `"authored\u0042y"` collide too.
 */
function assertNoDuplicateJsonKeys(text: string): void {
  let index = 0;
  const whitespace = () => {
    while (index < text.length && /\s/.test(text[index]!)) index += 1;
  };
  const jsonString = (): string => {
    const start = index;
    if (text[index] !== '"') invalid("INVALID_JSON", `expected a JSON string at offset ${index}`);
    index += 1;
    while (index < text.length) {
      const ch = text[index]!;
      if (ch === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      if (ch === '"') return JSON.parse(text.slice(start, index)) as string;
    }
    invalid("INVALID_JSON", `unterminated JSON string at offset ${start}`);
  };
  const literal = (token: string) => {
    if (!text.startsWith(token, index)) invalid("INVALID_JSON", `invalid JSON token at offset ${index}`);
    index += token.length;
  };
  const value = (): void => {
    whitespace();
    const ch = text[index];
    if (ch === '"') {
      jsonString();
      return;
    }
    if (ch === "{") {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < text.length) {
        whitespace();
        const key = jsonString();
        if (keys.has(key)) invalid("DUPLICATE_JSON_KEY", `object repeats decoded key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (text[index] !== ":") invalid("INVALID_JSON", `expected ':' at offset ${index}`);
        index += 1;
        value();
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") invalid("INVALID_JSON", `expected ',' at offset ${index}`);
        index += 1;
      }
      invalid("INVALID_JSON", "unterminated JSON object");
    }
    if (ch === "[") {
      index += 1;
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (index < text.length) {
        value();
        whitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") invalid("INVALID_JSON", `expected ',' at offset ${index}`);
        index += 1;
      }
      invalid("INVALID_JSON", "unterminated JSON array");
    }
    if (ch === "t") return literal("true");
    if (ch === "f") return literal("false");
    if (ch === "n") return literal("null");
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    if (!number) invalid("INVALID_JSON", `invalid JSON value at offset ${index}`);
    index += number[0].length;
  };
  value();
  whitespace();
  if (index !== text.length) invalid("INVALID_JSON", `unexpected trailing JSON content at offset ${index}`);
}

/** Strict UTF-8 + strict schema. This cheap pass is also used by the submission endpoint. */
export function parseHumanRequirementsInput(bytes: Uint8Array): HumanRequirementsInput {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    invalid("INVALID_UTF8", "the human requirements file is not strict UTF-8");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text!);
  } catch (err) {
    invalid("INVALID_JSON", `the human requirements file is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  assertNoDuplicateJsonKeys(text!);
  const root = object(decoded, "input");
  exactKeys(root, ["schemaVersion", "kind", "documentSha256", "authoredBy", "authoredAt", "requirements"], "input");
  if (root.schemaVersion !== HUMAN_REQUIREMENTS_SCHEMA) {
    invalid("UNSUPPORTED_SCHEMA", `input.schemaVersion must be ${HUMAN_REQUIREMENTS_SCHEMA}`);
  }
  if (root.kind !== HUMAN_REQUIREMENTS_KIND) invalid("INVALID_KIND", `input.kind must be ${HUMAN_REQUIREMENTS_KIND}`);
  const documentSha256 = string(root.documentSha256, "input.documentSha256", 71).replace(/^sha256:/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(documentSha256)) invalid("INVALID_DOCUMENT_HASH", "input.documentSha256 must be a SHA-256 hex digest");
  const authoredBy = string(root.authoredBy, "input.authoredBy", 500);
  const authoredAt = string(root.authoredAt, "input.authoredAt", 100);
  if (!isStrictRfc3339(authoredAt)) {
    invalid("INVALID_TIMESTAMP", "input.authoredAt must be an RFC 3339 timestamp with an explicit timezone");
  }
  if (!Array.isArray(root.requirements) || root.requirements.length === 0 || root.requirements.length > MAX_REQUIREMENTS) {
    invalid("INVALID_REQUIREMENT_COUNT", `input.requirements must contain 1..${MAX_REQUIREMENTS} rows`);
  }
  const seenAuthorIds = new Set<string>();
  const requirements = root.requirements.map((entry, index): HumanRequirementInput => {
    const path = `input.requirements[${index}]`;
    const row = object(entry, path);
    exactKeys(
      row,
      [
        "id",
        "normativeStatement",
        "displayQuote",
        "sourceSpans",
        "scope",
        "facet",
        "quantifier",
        "selector",
        "exceptions",
        "assertionStatus",
        "testability",
        "notBrowserObservableReason",
        "expansion",
      ],
      path,
    );
    const id = string(row.id, `${path}.id`, 500);
    if (seenAuthorIds.has(id)) invalid("DUPLICATE_AUTHOR_ID", `${path}.id duplicates ${JSON.stringify(id)}`);
    seenAuthorIds.add(id);
    if (!Array.isArray(row.sourceSpans) || row.sourceSpans.length === 0 || row.sourceSpans.length > MAX_SPANS_PER_REQUIREMENT) {
      invalid("INVALID_SOURCE_SPANS", `${path}.sourceSpans must contain 1..${MAX_SPANS_PER_REQUIREMENT} spans`);
    }
    const sourceSpans = row.sourceSpans.map((entry2, spanIndex): HumanSourceSpan => {
      const spanPath = `${path}.sourceSpans[${spanIndex}]`;
      const span = object(entry2, spanPath);
      exactKeys(span, ["blockId", "start", "end"], spanPath);
      const start = integerOrNull(span.start, `${spanPath}.start`);
      const end = integerOrNull(span.end, `${spanPath}.end`);
      if (start === null || end === null) invalid("INVALID_SOURCE_SPAN", `${spanPath} offsets may not be null`);
      return { blockId: string(span.blockId, `${spanPath}.blockId`, 500), start, end };
    });
    const quantifier = string(row.quantifier, `${path}.quantifier`, 20);
    if (!QUANTIFIERS.has(quantifier)) invalid("INVALID_QUANTIFIER", `${path}.quantifier is unsupported`);
    const assertionStatus = string(row.assertionStatus, `${path}.assertionStatus`, 40);
    if (!ASSERTION_STATUSES.has(assertionStatus)) invalid("INVALID_ASSERTION_STATUS", `${path}.assertionStatus is unsupported`);
    const testability = string(row.testability, `${path}.testability`, 40);
    if (!TESTABILITIES.has(testability)) invalid("INVALID_TESTABILITY", `${path}.testability is unsupported`);
    const notReason = nullableString(row.notBrowserObservableReason, `${path}.notBrowserObservableReason`, 10_000);
    if (testability === "not-browser-observable" && notReason === null) {
      invalid("MISSING_NOT_OBSERVABLE_REASON", `${path}.notBrowserObservableReason is required when the row is not browser-observable`);
    }
    if (testability === "browser-observable" && notReason !== null) {
      invalid("UNEXPECTED_NOT_OBSERVABLE_REASON", `${path}.notBrowserObservableReason must be null for browser-observable rows`);
    }
    return {
      id,
      normativeStatement: string(row.normativeStatement, `${path}.normativeStatement`),
      displayQuote: string(row.displayQuote, `${path}.displayQuote`),
      sourceSpans,
      scope: string(row.scope, `${path}.scope`, 10_000),
      facet: string(row.facet, `${path}.facet`, 1_000),
      quantifier: quantifier as ScopedRequirement["quantifier"],
      selector: nullableString(row.selector, `${path}.selector`, 10_000),
      exceptions: stringArray(row.exceptions, `${path}.exceptions`),
      assertionStatus: assertionStatus as ScopedRequirement["assertionStatus"],
      testability: testability as ScopedRequirement["testability"],
      notBrowserObservableReason: notReason,
      expansion: parseExpansion(row.expansion, `${path}.expansion`),
    };
  });
  return {
    schemaVersion: HUMAN_REQUIREMENTS_SCHEMA,
    kind: HUMAN_REQUIREMENTS_KIND,
    documentSha256,
    authoredBy,
    authoredAt,
    requirements,
  };
}

const atomKind = (block: SourceBlock): SourceAtom["kind"] => block.kind;

async function mintRow(
  authored: HumanRequirementInput,
  doc: ParsedDocument,
  level: number,
): Promise<NormalizedHumanRow> {
  const blockIndex = new Map(doc.blocks.map((block, index) => [block.blockId, { block, index }]));
  let previous: { blockIndex: number; start: number; end: number } | null = null;
  const excerpts: string[] = [];
  const atoms: SourceAtom[] = [];
  const seenSpan = new Set<string>();
  for (let i = 0; i < authored.sourceSpans.length; i++) {
    const span = authored.sourceSpans[i]!;
    const held = blockIndex.get(span.blockId);
    if (!held) invalid("SOURCE_BLOCK_MISSING", `requirement ${JSON.stringify(authored.id)} cites absent block ${JSON.stringify(span.blockId)}`);
    if (span.start < 0 || span.end <= span.start || span.end > held.block.text.length) {
      invalid(
        "SOURCE_SPAN_OUT_OF_RANGE",
        `requirement ${JSON.stringify(authored.id)} span ${i} is [${span.start}, ${span.end}) but block ${span.blockId} is ${held.block.text.length} characters`,
      );
    }
    const key = `${span.blockId}:${span.start}:${span.end}`;
    if (seenSpan.has(key)) invalid("DUPLICATE_SOURCE_SPAN", `requirement ${JSON.stringify(authored.id)} repeats source span ${key}`);
    seenSpan.add(key);
    if (
      previous &&
      (held.index < previous.blockIndex ||
        (held.index === previous.blockIndex && span.start < previous.end))
    ) {
      invalid(
        "SOURCE_SPANS_OVERLAP_OR_OUT_OF_ORDER",
        `requirement ${JSON.stringify(authored.id)} has overlapping or document-order-reversing spans`,
      );
    }
    previous = { blockIndex: held.index, start: span.start, end: span.end };
    const excerpt = held.block.text.slice(span.start, span.end);
    excerpts.push(excerpt);
    atoms.push({
      blockId: span.blockId,
      kind: atomKind(held.block),
      coords: held.block.coords,
      role: sourceAtomRole(held.block, authored.facet),
      atomTextHash: `sha256:${await sha256Hex(excerpt)}`,
    });
  }
  const reconstructedQuote = excerpts.join(" ");
  if (authored.displayQuote !== reconstructedQuote) {
    invalid(
      "DISPLAY_QUOTE_MISMATCH",
      `requirement ${JSON.stringify(authored.id)} displayQuote does not equal the exact text selected by sourceSpans`,
    );
  }
  const seed: IdentitySeed = {
    statement: authored.normativeStatement,
    docQuote: reconstructedQuote,
    scope: authored.scope,
    quantifier: authored.quantifier,
    construct: authored.facet,
    selector: authored.selector,
    blockIds: [...new Set(authored.sourceSpans.map((span) => span.blockId))].sort(),
  };
  const identity = await deriveRequirementIdentity(seed, level);
  return {
    authorId: authored.id,
    requirement: {
      requirementLineageId: identity.requirementLineageId,
      requirementVersionId: identity.requirementVersionId,
      semanticFingerprint: identity.semanticFingerprint,
      scope: authored.scope,
      quantifier: authored.quantifier,
      selector: authored.selector,
      exceptions: [...new Set(authored.exceptions)].sort(),
      facet: authored.facet,
      assertionStatus: authored.assertionStatus,
      testability: authored.testability,
      notBrowserObservableReason: authored.notBrowserObservableReason,
      sourceAtoms: atoms,
      composition: null,
      normativeStatement: authored.normativeStatement,
      displayQuote: reconstructedQuote,
      displayQuoteHash: `sha256:${await sha256Hex(reconstructedQuote)}`,
      retiredAt: null,
    },
    expansion: authored.expansion,
  };
}

async function deriveUniqueRows(input: HumanRequirementsInput, doc: ParsedDocument): Promise<NormalizedHumanRow[]> {
  const authored = [...input.requirements].sort((a, b) => a.id.localeCompare(b.id));
  const levels = new Array(authored.length).fill(0) as number[];
  let rows = await Promise.all(authored.map((row, index) => mintRow(row, doc, levels[index]!)));
  for (let round = 0; round < 2; round++) {
    const byLineage = new Map<string, number[]>();
    rows.forEach((row, index) => {
      const held = byLineage.get(row.requirement.requirementLineageId) ?? [];
      held.push(index);
      byLineage.set(row.requirement.requirementLineageId, held);
    });
    const colliding = [...byLineage.values()].filter((indexes) => indexes.length > 1).flat();
    if (colliding.length === 0) break;
    for (const index of colliding) {
      levels[index] = levels[index]! + 1;
      rows[index] = await mintRow(authored[index]!, doc, levels[index]!);
    }
  }
  const lineage = new Set<string>();
  const versions = new Set<string>();
  for (const row of rows) {
    if (lineage.has(row.requirement.requirementLineageId) || versions.has(row.requirement.requirementVersionId)) {
      invalid(
        "DUPLICATE_DERIVED_IDENTITY",
        `human rows still share derived identity ${row.requirement.requirementLineageId}/${row.requirement.requirementVersionId} after maximum disambiguation`,
      );
    }
    lineage.add(row.requirement.requirementLineageId);
    versions.add(row.requirement.requirementVersionId);
  }
  return rows.sort((a, b) => a.requirement.requirementVersionId.localeCompare(b.requirement.requirementVersionId));
}

/** Validate raw bytes and bind every source span before any case is materialized. */
export async function stageValidateHumanRequirements(
  env: Env,
  runId: string,
  documentKey: string,
  expectedDocumentSha256: string,
  humanRequirementsKey: string,
  expectedHumanRequirementsSha256: string,
): Promise<HumanValidationSummary> {
  const [documentObject, humanObject] = await Promise.all([
    env.EVIDENCE.get(documentKey),
    env.EVIDENCE.get(humanRequirementsKey),
  ]);
  if (!documentObject) invalid("DOCUMENT_MISSING", `the submitted document is absent at ${documentKey}`);
  if (!humanObject) invalid("INPUT_MISSING", `the human requirements file is absent at ${humanRequirementsKey}`);
  const documentBytes = new Uint8Array(await documentObject.arrayBuffer());
  const humanBytes = new Uint8Array(await humanObject.arrayBuffer());
  const [actualDocumentSha256, actualHumanSha256] = await Promise.all([
    sha256Hex(documentBytes),
    sha256Hex(humanBytes),
  ]);
  if (actualDocumentSha256 !== expectedDocumentSha256.replace(/^sha256:/, "")) {
    invalid("DOCUMENT_OBJECT_HASH_MISMATCH", "the stored DOCX bytes no longer match the run envelope");
  }
  if (actualHumanSha256 !== expectedHumanRequirementsSha256.replace(/^sha256:/, "")) {
    invalid("INPUT_OBJECT_HASH_MISMATCH", "the stored human requirements bytes no longer match the run envelope");
  }
  const input = parseHumanRequirementsInput(humanBytes);
  if (input.documentSha256 !== actualDocumentSha256) {
    invalid("DOCUMENT_HASH_MISMATCH", "the human requirements file is bound to different document bytes");
  }
  const doc = parseDocxBlocks(documentBytes);
  const rows = await deriveUniqueRows(input, doc);
  const normalizedForHash = {
    schemaVersion: HUMAN_REQUIREMENTS_SCHEMA,
    documentSha256: input.documentSha256,
    authoredBy: input.authoredBy,
    // Author-facing row ids and JSON ordering are transport/audit facts. The normalized
    // identity is the server-derived row content that can actually reach the seal.
    requirements: rows.map(({ authorId: _authorId, requirement, expansion }) => ({ requirement, expansion })),
  };
  const normalizedInputHash = `sha256:${await canonicalHash(normalizedForHash)}`;
  const payload: NormalizedHumanPayload = {
    schemaVersion: "v2-human-requirements-normalized/1.0.0",
    documentSha256: actualDocumentSha256,
    rawInputSha256: actualHumanSha256,
    normalizedInputHash,
    authoredBy: input.authoredBy,
    authoredAt: input.authoredAt,
    rows,
  };
  const normalizedBytes = canonicalJson(payload);
  const normalizedArtifactHash = `sha256:${await sha256Hex(normalizedBytes)}`;
  const limitations = [
    "coverage is limited to authored requirements; this validator cannot detect a requirement the author omitted",
    "exact source-span binding proves provenance, not that each authored statement or expansion hint is semantically entailed by its quote",
    ...doc.coverage.problems,
    ...doc.coverage.partsSkipped.map(
      ({ part, reason }) => `document part ${JSON.stringify(part)} was not read: ${reason}`,
    ),
  ].filter((value, index, all) => all.indexOf(value) === index);
  const validationSemantic = {
    schemaVersion: "v2-human-requirements-validation/1.0.0",
    valid: true,
    validatorVersion: HUMAN_REQUIREMENTS_VALIDATOR_VERSION,
    documentSha256: actualDocumentSha256,
    normalizedInputHash,
    requirementCount: rows.length,
    sourceSpanCount: input.requirements.reduce((sum, row) => sum + row.sourceSpans.length, 0),
    parserCoverage: doc.coverage,
    limitations,
  };
  const validation = {
    ...validationSemantic,
    // Audit-only carrier. Whitespace/key/array ordering may move the raw hash without
    // changing the normalized contract the validator approved.
    rawInputSha256: actualHumanSha256,
    validatedAt: new Date().toISOString(),
  };
  const validationBytes = canonicalJson(validation);
  // The report keeps the clock; identity does not. Re-running the same mechanical checks
  // over the same bytes is the same validation, regardless of when it ran.
  const validationHash = `sha256:${await canonicalHash(validationSemantic)}`;
  await Promise.all([
    env.EVIDENCE.put(humanRequirementsNormalizedKey(runId), normalizedBytes, {
      httpMetadata: { contentType: "application/json" },
    }),
    env.EVIDENCE.put(humanRequirementsValidationKey(runId), validationBytes, {
      httpMetadata: { contentType: "application/json" },
    }),
  ]);
  return {
    normalizedInputHash,
    normalizedArtifactHash,
    validationHash,
    requirementCount: rows.length,
    documentCoverage: doc.coverage,
    limitations: validation.limitations,
  };
}

const proof = (evaluatorId: string, inputHash: string): GateProof => ({
  evaluatorId,
  evaluatorVersion: HUMAN_REQUIREMENTS_VALIDATOR_VERSION,
  inputHash,
  observedAt: new Date().toISOString(),
});

/** Run the same floor expander used by model extraction and persist the pre-seal payload. */
export async function stageExpandHumanRequirements(
  env: Env,
  runId: string,
  expectedDocumentSha256: string,
  locale: string,
  viewports: string[],
  validationHash: string,
  expectedNormalizedArtifactHash: string,
): Promise<HumanExpansionSummary> {
  const [normalizedObject, validationObject] = await Promise.all([
    env.EVIDENCE.get(humanRequirementsNormalizedKey(runId)),
    env.EVIDENCE.get(humanRequirementsValidationKey(runId)),
  ]);
  if (!normalizedObject) invalid("NORMALIZED_INPUT_MISSING", "validation did not leave a normalized human requirements artifact");
  if (!validationObject) invalid("VALIDATION_ARTIFACT_MISSING", "validation did not leave its coverage/limitation artifact");
  const normalizedBytes = new Uint8Array(await normalizedObject.arrayBuffer());
  const normalizedArtifactHash = `sha256:${await sha256Hex(normalizedBytes)}`;
  if (normalizedArtifactHash !== `sha256:${expectedNormalizedArtifactHash.replace(/^sha256:/, "")}`) {
    invalid(
      "NORMALIZED_ARTIFACT_HASH_MISMATCH",
      "the normalized human requirements artifact changed after the durable validation step",
    );
  }
  let normalized: NormalizedHumanPayload;
  try {
    const root = object(
      JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(normalizedBytes)),
      "normalized",
    );
    exactKeys(
      root,
      [
        "schemaVersion",
        "documentSha256",
        "rawInputSha256",
        "normalizedInputHash",
        "authoredBy",
        "authoredAt",
        "rows",
      ],
      "normalized",
    );
    if (
      root.schemaVersion !== "v2-human-requirements-normalized/1.0.0" ||
      typeof root.documentSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(root.documentSha256) ||
      typeof root.rawInputSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(root.rawInputSha256) ||
      typeof root.normalizedInputHash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(root.normalizedInputHash) ||
      !Array.isArray(root.rows) ||
      root.rows.length === 0
    ) {
      invalid("NORMALIZED_INPUT_INVALID", "the normalized human requirements artifact has invalid authority fields");
    }
    string(root.authoredBy, "normalized.authoredBy", 500);
    if (!isStrictRfc3339(string(root.authoredAt, "normalized.authoredAt", 100))) {
      invalid("NORMALIZED_INPUT_INVALID", "normalized.authoredAt is not strict RFC 3339");
    }
    root.rows.forEach((entry, index) => {
      const row = object(entry, `normalized.rows[${index}]`);
      exactKeys(row, ["authorId", "requirement", "expansion"], `normalized.rows[${index}]`);
      string(row.authorId, `normalized.rows[${index}].authorId`, 500);
      const requirement = object(row.requirement, `normalized.rows[${index}].requirement`);
      string(requirement.requirementLineageId, `normalized.rows[${index}].requirement.requirementLineageId`, 500);
      string(requirement.requirementVersionId, `normalized.rows[${index}].requirement.requirementVersionId`, 500);
      if (!ASSERTION_STATUSES.has(requirement.assertionStatus as string)) {
        invalid("NORMALIZED_INPUT_INVALID", `normalized.rows[${index}] has an invalid assertionStatus`);
      }
    });
    normalized = root as unknown as NormalizedHumanPayload;
  } catch (err) {
    if (err instanceof HumanRequirementsError) throw err;
    invalid("NORMALIZED_INPUT_INVALID", "the normalized human requirements artifact is not strict UTF-8 JSON");
  }
  if (normalized.documentSha256 !== expectedDocumentSha256.replace(/^sha256:/, "")) {
    invalid("NORMALIZED_DOCUMENT_HASH_MISMATCH", "normalized requirements name different document bytes");
  }
  let validation: JsonObject;
  try {
    validation = object(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          new Uint8Array(await validationObject.arrayBuffer()),
        ),
      ),
      "validation",
    );
  } catch (err) {
    if (err instanceof HumanRequirementsError) throw err;
    invalid("VALIDATION_ARTIFACT_INVALID", "the stored validation artifact is not strict UTF-8 JSON");
  }
  const { rawInputSha256: _rawInputSha256, validatedAt: _validatedAt, ...validationSemantic } = validation!;
  const actualValidationHash = `sha256:${await canonicalHash(validationSemantic)}`;
  if (actualValidationHash !== `sha256:${validationHash.replace(/^sha256:/, "")}`) {
    invalid("VALIDATION_ARTIFACT_HASH_MISMATCH", "document coverage or limitations changed after the durable validation step");
  }
  if (
    validation!.schemaVersion !== "v2-human-requirements-validation/1.0.0" ||
    validation!.valid !== true ||
    validation!.normalizedInputHash !== normalized.normalizedInputHash
  ) {
    invalid("VALIDATION_ARTIFACT_INVALID", "the validation artifact does not describe the normalized requirements being expanded");
  }
  const coverageRoot = object(validation!.parserCoverage, "validation.parserCoverage");
  exactKeys(
    coverageRoot,
    [
      "archiveParts",
      "partsRead",
      "partsSkipped",
      "images",
      "imagesWithAltText",
      "unresolvedFieldCodes",
      "symbolRuns",
      "autoNumberedParagraphs",
      "problems",
    ],
    "validation.parserCoverage",
  );
  for (const field of [
    "archiveParts",
    "images",
    "imagesWithAltText",
    "unresolvedFieldCodes",
    "symbolRuns",
    "autoNumberedParagraphs",
  ] as const) {
    if (!Number.isSafeInteger(coverageRoot[field]) || (coverageRoot[field] as number) < 0) {
      invalid("VALIDATION_ARTIFACT_INVALID", `validation.parserCoverage.${field} must be a non-negative integer`);
    }
  }
  const partsRead = stringArray(coverageRoot.partsRead, "validation.parserCoverage.partsRead");
  if (!Array.isArray(coverageRoot.partsSkipped)) {
    invalid("VALIDATION_ARTIFACT_INVALID", "validation.parserCoverage.partsSkipped must be an array");
  }
  const partsSkipped = coverageRoot.partsSkipped.map((entry, index) => {
    const skipped = object(entry, `validation.parserCoverage.partsSkipped[${index}]`);
    exactKeys(skipped, ["part", "reason"], `validation.parserCoverage.partsSkipped[${index}]`);
    return {
      part: string(skipped.part, `validation.parserCoverage.partsSkipped[${index}].part`),
      reason: string(skipped.reason, `validation.parserCoverage.partsSkipped[${index}].reason`),
    };
  });
  const documentCoverage: DocumentCoverage = {
    archiveParts: coverageRoot.archiveParts as number,
    partsRead,
    partsSkipped,
    images: coverageRoot.images as number,
    imagesWithAltText: coverageRoot.imagesWithAltText as number,
    unresolvedFieldCodes: coverageRoot.unresolvedFieldCodes as number,
    symbolRuns: coverageRoot.symbolRuns as number,
    autoNumberedParagraphs: coverageRoot.autoNumberedParagraphs as number,
    problems: stringArray(coverageRoot.problems, "validation.parserCoverage.problems"),
  };
  const limitations = validation!.limitations;
  if (!Array.isArray(limitations)) {
    invalid("VALIDATION_ARTIFACT_INVALID", "the validation artifact lacks structured parser coverage or limitations");
  }
  const limitationStrings = limitations.map((entry, index) => string(entry, `validation.limitations[${index}]`));
  const expanded = await expandFloor(normalized.rows, { locale, viewport: viewports[0] ?? null });
  if (expanded.unpreviewed.length > 0) {
    invalid(
      "UNPREVIEWED_REQUIREMENTS",
      `${expanded.unpreviewed.length} human-authored requirement(s) have no expansion preview`,
    );
  }
  const previewBytes = canonicalJson({
    expanderVersion: EXPANDER_VERSION,
    configuration: { locale, viewport: viewports[0] ?? null },
    coverage: expanded.coverage,
    preview: expanded.preview,
    unpreviewed: expanded.unpreviewed,
  });
  const previewHash = `sha256:${await sha256Hex(previewBytes)}`;
  const approval: HumanContractApproval = {
    kind: "human-authored",
    gates: {
      inputSchemaValid: gatePass(proof("human-input-schema", normalized.normalizedInputHash)),
      documentHashBound: gatePass(proof("human-document-binding", `sha256:${normalized.documentSha256}`)),
      allSourceSpansBound: gatePass(proof("human-source-span-binding", validationHash)),
      identitiesUnique: gatePass(proof("human-requirement-identity", normalized.normalizedInputHash)),
      allScopedExpansionsPreviewed: gatePass(proof("floor-expansion-preview", previewHash)),
    },
  };
  const prepared: PreparedHumanContract = {
    schemaVersion: "v2-human-contract-prepared/1.0.0",
    documentSha256: normalized.documentSha256,
    normalizedInputHash: normalized.normalizedInputHash,
    authoredBy: normalized.authoredBy,
    authoredAt: normalized.authoredAt,
    documentCoverage,
    limitations: limitationStrings,
    requirements: normalized.rows.map((row) => row.requirement),
    facetInstances: expanded.facetInstances,
    approval,
    validationHash,
    previewHash,
  };
  const preparedBytes = canonicalJson(prepared);
  const preparedHash = `sha256:${await sha256Hex(preparedBytes)}`;
  await Promise.all([
    env.EVIDENCE.put(humanExpansionPreviewKey(runId), previewBytes, {
      httpMetadata: { contentType: "application/json" },
    }),
    env.EVIDENCE.put(humanContractPreparedKey(runId), preparedBytes, {
      httpMetadata: { contentType: "application/json" },
    }),
  ]);
  return {
    preparedHash,
    previewHash,
    requirementCount: prepared.requirements.length,
    executionCaseCount: prepared.facetInstances.length,
    typedCaseCount: expanded.coverage.typedCases,
    expectationGapCount: expanded.coverage.untypedCases,
  };
}

export async function loadPreparedHumanContract(
  env: Env,
  runId: string,
  expectedPreparedHash: string,
): Promise<PreparedHumanContract | null> {
  const [preparedObject, previewObject] = await Promise.all([
    env.EVIDENCE.get(humanContractPreparedKey(runId)),
    env.EVIDENCE.get(humanExpansionPreviewKey(runId)),
  ]);
  if (!preparedObject) return null;
  if (!previewObject) invalid("PREVIEW_ARTIFACT_MISSING", "the prepared contract cites an expansion preview that is absent");
  try {
    const bytes = new Uint8Array(await preparedObject.arrayBuffer());
    const actualPreparedHash = `sha256:${await sha256Hex(bytes)}`;
    if (actualPreparedHash !== `sha256:${expectedPreparedHash.replace(/^sha256:/, "")}`) {
      invalid(
        "PREPARED_ARTIFACT_HASH_MISMATCH",
        "the prepared human contract artifact changed after the durable expansion step",
      );
    }
    const parsedValue = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    const root = object(parsedValue, "prepared");
    exactKeys(
      root,
      [
        "schemaVersion",
        "documentSha256",
        "normalizedInputHash",
        "authoredBy",
        "authoredAt",
        "documentCoverage",
        "limitations",
        "requirements",
        "facetInstances",
        "approval",
        "validationHash",
        "previewHash",
      ],
      "prepared",
    );
    if (root.schemaVersion !== "v2-human-contract-prepared/1.0.0") {
      invalid("PREPARED_ARTIFACT_INVALID", "the prepared contract has an unsupported schema");
    }
    if (typeof root.documentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(root.documentSha256)) {
      invalid("PREPARED_ARTIFACT_INVALID", "prepared.documentSha256 must be a bare SHA-256 digest");
    }
    for (const [name, value] of [
      ["normalizedInputHash", root.normalizedInputHash],
      ["validationHash", root.validationHash],
      ["previewHash", root.previewHash],
    ] as const) {
      if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
        invalid("PREPARED_ARTIFACT_INVALID", `prepared.${name} must be a canonical SHA-256 digest`);
      }
    }
    string(root.authoredBy, "prepared.authoredBy", 500);
    if (!isStrictRfc3339(string(root.authoredAt, "prepared.authoredAt", 100))) {
      invalid("PREPARED_ARTIFACT_INVALID", "prepared.authoredAt is not strict RFC 3339");
    }
    if (!Array.isArray(root.requirements) || !Array.isArray(root.facetInstances)) {
      invalid("PREPARED_ARTIFACT_INVALID", "prepared requirements and facetInstances must be arrays");
    }
    for (const [index, requirement] of root.requirements.entries()) {
      const row = object(requirement, `prepared.requirements[${index}]`);
      string(row.requirementLineageId, `prepared.requirements[${index}].requirementLineageId`, 500);
      string(row.requirementVersionId, `prepared.requirements[${index}].requirementVersionId`, 500);
      if (!ASSERTION_STATUSES.has(row.assertionStatus as string) || !Array.isArray(row.sourceAtoms)) {
        invalid("PREPARED_ARTIFACT_INVALID", `prepared.requirements[${index}] has invalid authority fields`);
      }
    }
    for (const [index, facet] of root.facetInstances.entries()) {
      const row = object(facet, `prepared.facetInstances[${index}]`);
      string(row.facetInstanceId, `prepared.facetInstances[${index}].facetInstanceId`, 500);
      string(row.requirementVersionId, `prepared.facetInstances[${index}].requirementVersionId`, 500);
      if (row.floorCase !== true || !row.case || typeof row.case !== "object") {
        invalid("PREPARED_ARTIFACT_INVALID", `prepared.facetInstances[${index}] is not a typed floor case`);
      }
    }
    if (!root.documentCoverage || typeof root.documentCoverage !== "object" || !Array.isArray(root.limitations)) {
      invalid("PREPARED_ARTIFACT_INVALID", "prepared documentCoverage and limitations are required");
    }
    root.limitations.forEach((entry, index) => string(entry, `prepared.limitations[${index}]`));
    const approval = object(root.approval, "prepared.approval");
    if (approval.kind !== "human-authored" || !approval.gates || typeof approval.gates !== "object") {
      invalid("PREPARED_ARTIFACT_INVALID", "prepared human approval block is malformed");
    }
    const parsed = root as unknown as PreparedHumanContract;
    const previewBytes = new Uint8Array(await previewObject.arrayBuffer());
    const actualPreviewHash = `sha256:${await sha256Hex(previewBytes)}`;
    if (actualPreviewHash !== parsed.previewHash) {
      invalid("PREVIEW_ARTIFACT_HASH_MISMATCH", "the expansion preview changed after the durable expansion step");
    }
    return parsed;
  } catch (err) {
    if (err instanceof HumanRequirementsError) throw err;
    return null;
  }
}

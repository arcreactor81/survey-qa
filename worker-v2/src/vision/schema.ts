import type {
  JsonValue,
  ModelControlRegion,
  ModelMessageRegion,
  ModelOptionGroup,
  ModelOptionRegion,
  ModelQuestionRegion,
  ModelTextReading,
  ModelVisualInventory,
  ModelVisualLimitation,
  NormalizedBounds,
} from "./types";

export const VISUAL_RESPONSE_SCHEMA_VERSION = "survey-qa-visual-inventory-response/1.0.0";
export const VISUAL_OBSERVATION_SCHEMA_VERSION = "survey-qa-visual-observation/1.0.0";
export const VISUAL_PAIR_SCHEMA_VERSION = "survey-qa-visual-evidence-pair/1.0.0";
export const VISUAL_CACHE_KEY_SCHEMA_VERSION = "survey-qa-visual-cache-key/1.0.0";
export const VISUAL_PROMPT_VERSION = "survey-qa-visual-inventory-prompt/1.0.0";

/**
 * A fixed, target-neutral prompt. Provider adapters may change transport syntax, but may not
 * append questionnaire requirements or candidate answers. Doing so would make perception a
 * self-fulfilling comparison instead of an independent observation.
 */
export const VISUAL_INVENTORY_PROMPT = `Inspect only the supplied screenshot pixels and inventory what a respondent can see.

Return only the supplied JSON schema. Record question regions, visually grouped options, visible controls, messages, and visual reading limitations. Quote text exactly as it appears. Use normalized screenshot coordinates in [0,1]. If text is uncertain, use alternatives or abstain with readability "unreadable". Pixel appearance may be described only with the schema's "appears-*" values; do not infer semantic checked, disabled, required, clickable, or navigation state from pixels.

Do not compare against a document, requirement, expected label, platform convention, or proposed answer. Do not state correctness, compliance, a defect, or any conclusion. Do not claim that the screenshot covers content outside its pixels.`;

const boundsSchema: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y", "width", "height"],
  properties: {
    x: { type: "number", minimum: 0, maximum: 1 },
    y: { type: "number", minimum: 0, maximum: 1 },
    width: { type: "number", exclusiveMinimum: 0, maximum: 1 },
    height: { type: "number", exclusiveMinimum: 0, maximum: 1 },
  },
};

const readingSchema: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: ["quote", "alternatives", "readability", "modelConfidence", "bounds"],
  properties: {
    quote: { type: ["string", "null"], maxLength: 4000 },
    alternatives: { type: "array", maxItems: 5, items: { type: "string", minLength: 1, maxLength: 4000 } },
    readability: { enum: ["read", "uncertain", "unreadable"] },
    modelConfidence: { type: "number", minimum: 0, maximum: 1 },
    bounds: boundsSchema,
  },
};

/** Closed schema passed to providers that support structured output. */
export const VISUAL_RESPONSE_JSON_SCHEMA: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "questionRegions", "optionGroups", "controls", "messages", "visualLimitations"],
  properties: {
    schemaVersion: { const: VISUAL_RESPONSE_SCHEMA_VERSION },
    questionRegions: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["localId", "text"],
        properties: {
          localId: { type: "string", minLength: 1, maxLength: 200 },
          text: readingSchema,
        },
      },
    },
    optionGroups: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["localId", "questionRegionId", "selectionAppearance", "bounds", "options"],
        properties: {
          localId: { type: "string", minLength: 1, maxLength: 200 },
          questionRegionId: { type: ["string", "null"], maxLength: 200 },
          selectionAppearance: { enum: ["appears-single", "appears-multiple", "unknown"] },
          bounds: boundsSchema,
          options: {
            type: "array",
            maxItems: 200,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["localId", "text", "markAppearance"],
              properties: {
                localId: { type: "string", minLength: 1, maxLength: 200 },
                text: readingSchema,
                markAppearance: {
                  enum: ["appears-selected", "appears-unselected", "appears-indeterminate", "unknown"],
                },
              },
            },
          },
        },
      },
    },
    controls: {
      type: "array",
      maxItems: 300,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["localId", "kind", "text", "availabilityAppearance", "selectionAppearance", "bounds"],
        properties: {
          localId: { type: "string", minLength: 1, maxLength: 200 },
          kind: { enum: ["button", "text-entry", "select", "link", "option-control", "other"] },
          text: { anyOf: [readingSchema, { type: "null" }] },
          availabilityAppearance: {
            enum: ["appears-enabled", "appears-disabled", "unknown"],
          },
          selectionAppearance: {
            enum: ["appears-selected", "appears-unselected", "appears-indeterminate", "not-applicable", "unknown"],
          },
          bounds: boundsSchema,
        },
      },
    },
    messages: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["localId", "kind", "text"],
        properties: {
          localId: { type: "string", minLength: 1, maxLength: 200 },
          kind: { enum: ["instruction", "validation", "progress", "other"] },
          text: readingSchema,
        },
      },
    },
    visualLimitations: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "count", "bounds"],
        properties: {
          kind: {
            enum: ["clipped", "occluded", "blurred", "too-small", "unreadable", "offscreen-indicator", "ambiguous-grouping"],
          },
          count: { type: "integer", minimum: 1, maximum: 1000000 },
          bounds: { anyOf: [boundsSchema, { type: "null" }] },
        },
      },
    },
  },
};

export interface VisualSchemaIssue {
  path: string;
  code: string;
}

export type VisualSchemaResult =
  | { ok: true; value: ModelVisualInventory }
  | { ok: false; issue: VisualSchemaIssue };

const DECISION_KEYS = new Set([
  "verdict",
  "decision",
  "pass",
  "passed",
  "fail",
  "failed",
  "correct",
  "incorrect",
  "matches",
  "defect",
  "compliance",
  "conclusion",
]);

export function forbiddenDecisionFields(value: unknown): string[] {
  const found: string[] = [];
  const visit = (current: unknown, path: string): void => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}/${index}`));
      return;
    }
    if (!isObject(current)) return;
    for (const [key, child] of Object.entries(current)) {
      const childPath = `${path}/${escapePointer(key)}`;
      if (DECISION_KEYS.has(key.toLowerCase())) found.push(childPath);
      visit(child, childPath);
    }
  };
  visit(value, "$");
  return found;
}

export function validateModelVisualInventory(value: unknown): VisualSchemaResult {
  const top = asObject(value, "$", [
    "schemaVersion",
    "questionRegions",
    "optionGroups",
    "controls",
    "messages",
    "visualLimitations",
  ]);
  if (!top.ok) return top;
  if (top.value.schemaVersion !== VISUAL_RESPONSE_SCHEMA_VERSION) return bad("$/schemaVersion", "literal");

  const questionRegions = parseArray(top.value.questionRegions, "$/questionRegions", 200, parseQuestion);
  if (!questionRegions.ok) return questionRegions;
  const optionGroups = parseArray(top.value.optionGroups, "$/optionGroups", 200, parseOptionGroup);
  if (!optionGroups.ok) return optionGroups;
  const controls = parseArray(top.value.controls, "$/controls", 300, parseControl);
  if (!controls.ok) return controls;
  const messages = parseArray(top.value.messages, "$/messages", 200, parseMessage);
  if (!messages.ok) return messages;
  const visualLimitations = parseArray(
    top.value.visualLimitations,
    "$/visualLimitations",
    200,
    parseVisualLimitation,
  );
  if (!visualLimitations.ok) return visualLimitations;

  const duplicate = firstDuplicate(questionRegions.value.map((item) => item.localId));
  if (duplicate !== null) return bad("$/questionRegions", "duplicate-local-id");
  for (let index = 0; index < optionGroups.value.length; index++) {
    const group = optionGroups.value[index]!;
    if (firstDuplicate(group.options.map((item) => item.localId)) !== null) {
      return bad(`$/optionGroups/${index}/options`, "duplicate-local-id");
    }
  }
  if (firstDuplicate(optionGroups.value.map((item) => item.localId)) !== null) {
    return bad("$/optionGroups", "duplicate-local-id");
  }
  if (firstDuplicate(controls.value.map((item) => item.localId)) !== null) {
    return bad("$/controls", "duplicate-local-id");
  }
  if (firstDuplicate(messages.value.map((item) => item.localId)) !== null) {
    return bad("$/messages", "duplicate-local-id");
  }

  return {
    ok: true,
    value: {
      schemaVersion: VISUAL_RESPONSE_SCHEMA_VERSION,
      questionRegions: questionRegions.value,
      optionGroups: optionGroups.value,
      controls: controls.value,
      messages: messages.value,
      visualLimitations: visualLimitations.value,
    },
  };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; issue: VisualSchemaIssue };

function parseQuestion(value: unknown, path: string): Parsed<ModelQuestionRegion> {
  const obj = asObject(value, path, ["localId", "text"]);
  if (!obj.ok) return obj;
  const localId = shortString(obj.value.localId, `${path}/localId`, 200);
  if (!localId.ok) return localId;
  const text = parseReading(obj.value.text, `${path}/text`);
  if (!text.ok) return text;
  return { ok: true, value: { localId: localId.value, text: text.value } };
}

function parseOptionGroup(value: unknown, path: string): Parsed<ModelOptionGroup> {
  const obj = asObject(value, path, ["localId", "questionRegionId", "selectionAppearance", "bounds", "options"]);
  if (!obj.ok) return obj;
  const localId = shortString(obj.value.localId, `${path}/localId`, 200);
  if (!localId.ok) return localId;
  const questionRegionId = nullableShortString(obj.value.questionRegionId, `${path}/questionRegionId`, 200);
  if (!questionRegionId.ok) return questionRegionId;
  const selectionAppearance = literal(
    obj.value.selectionAppearance,
    `${path}/selectionAppearance`,
    ["appears-single", "appears-multiple", "unknown"] as const,
  );
  if (!selectionAppearance.ok) return selectionAppearance;
  const bounds = parseBounds(obj.value.bounds, `${path}/bounds`);
  if (!bounds.ok) return bounds;
  const options = parseArray(obj.value.options, `${path}/options`, 200, parseOption);
  if (!options.ok) return options;
  return {
    ok: true,
    value: {
      localId: localId.value,
      questionRegionId: questionRegionId.value,
      selectionAppearance: selectionAppearance.value,
      bounds: bounds.value,
      options: options.value,
    },
  };
}

function parseOption(value: unknown, path: string): Parsed<ModelOptionRegion> {
  const obj = asObject(value, path, ["localId", "text", "markAppearance"]);
  if (!obj.ok) return obj;
  const localId = shortString(obj.value.localId, `${path}/localId`, 200);
  if (!localId.ok) return localId;
  const text = parseReading(obj.value.text, `${path}/text`);
  if (!text.ok) return text;
  const markAppearance = literal(
    obj.value.markAppearance,
    `${path}/markAppearance`,
    ["appears-selected", "appears-unselected", "appears-indeterminate", "unknown"] as const,
  );
  if (!markAppearance.ok) return markAppearance;
  return { ok: true, value: { localId: localId.value, text: text.value, markAppearance: markAppearance.value } };
}

function parseControl(value: unknown, path: string): Parsed<ModelControlRegion> {
  const obj = asObject(value, path, ["localId", "kind", "text", "availabilityAppearance", "selectionAppearance", "bounds"]);
  if (!obj.ok) return obj;
  const localId = shortString(obj.value.localId, `${path}/localId`, 200);
  if (!localId.ok) return localId;
  const kind = literal(
    obj.value.kind,
    `${path}/kind`,
    ["button", "text-entry", "select", "link", "option-control", "other"] as const,
  );
  if (!kind.ok) return kind;
  const text = obj.value.text === null ? ({ ok: true, value: null } as const) : parseReading(obj.value.text, `${path}/text`);
  if (!text.ok) return text;
  const availabilityAppearance = literal(
    obj.value.availabilityAppearance,
    `${path}/availabilityAppearance`,
    ["appears-enabled", "appears-disabled", "unknown"] as const,
  );
  if (!availabilityAppearance.ok) return availabilityAppearance;
  const selectionAppearance = literal(
    obj.value.selectionAppearance,
    `${path}/selectionAppearance`,
    ["appears-selected", "appears-unselected", "appears-indeterminate", "not-applicable", "unknown"] as const,
  );
  if (!selectionAppearance.ok) return selectionAppearance;
  const bounds = parseBounds(obj.value.bounds, `${path}/bounds`);
  if (!bounds.ok) return bounds;
  return {
    ok: true,
    value: {
      localId: localId.value,
      kind: kind.value,
      text: text.value,
      availabilityAppearance: availabilityAppearance.value,
      selectionAppearance: selectionAppearance.value,
      bounds: bounds.value,
    },
  };
}

function parseMessage(value: unknown, path: string): Parsed<ModelMessageRegion> {
  const obj = asObject(value, path, ["localId", "kind", "text"]);
  if (!obj.ok) return obj;
  const localId = shortString(obj.value.localId, `${path}/localId`, 200);
  if (!localId.ok) return localId;
  const kind = literal(obj.value.kind, `${path}/kind`, ["instruction", "validation", "progress", "other"] as const);
  if (!kind.ok) return kind;
  const text = parseReading(obj.value.text, `${path}/text`);
  if (!text.ok) return text;
  return { ok: true, value: { localId: localId.value, kind: kind.value, text: text.value } };
}

function parseVisualLimitation(value: unknown, path: string): Parsed<ModelVisualLimitation> {
  const obj = asObject(value, path, ["kind", "count", "bounds"]);
  if (!obj.ok) return obj;
  const kind = literal(
    obj.value.kind,
    `${path}/kind`,
    ["clipped", "occluded", "blurred", "too-small", "unreadable", "offscreen-indicator", "ambiguous-grouping"] as const,
  );
  if (!kind.ok) return kind;
  const count = integer(obj.value.count, `${path}/count`, 1, 1_000_000);
  if (!count.ok) return count;
  const bounds = obj.value.bounds === null ? ({ ok: true, value: null } as const) : parseBounds(obj.value.bounds, `${path}/bounds`);
  if (!bounds.ok) return bounds;
  return { ok: true, value: { kind: kind.value, count: count.value, bounds: bounds.value } };
}

function parseReading(value: unknown, path: string): Parsed<ModelTextReading> {
  const obj = asObject(value, path, ["quote", "alternatives", "readability", "modelConfidence", "bounds"]);
  if (!obj.ok) return obj;
  const quote = obj.value.quote === null ? ({ ok: true, value: null } as const) : shortString(obj.value.quote, `${path}/quote`, 4000);
  if (!quote.ok) return quote;
  const alternatives = parseArray(obj.value.alternatives, `${path}/alternatives`, 5, (item, itemPath) =>
    shortString(item, itemPath, 4000),
  );
  if (!alternatives.ok) return alternatives;
  if (firstDuplicate(alternatives.value) !== null) return bad(`${path}/alternatives`, "duplicate-value");
  const readability = literal(obj.value.readability, `${path}/readability`, ["read", "uncertain", "unreadable"] as const);
  if (!readability.ok) return readability;
  if (readability.value === "read" && quote.value === null) return bad(`${path}/quote`, "required-when-readable");
  if (readability.value === "unreadable" && quote.value !== null) return bad(`${path}/quote`, "must-abstain-when-unreadable");
  const modelConfidence = finiteNumber(obj.value.modelConfidence, `${path}/modelConfidence`, 0, 1);
  if (!modelConfidence.ok) return modelConfidence;
  const bounds = parseBounds(obj.value.bounds, `${path}/bounds`);
  if (!bounds.ok) return bounds;
  return {
    ok: true,
    value: {
      quote: quote.value,
      alternatives: alternatives.value,
      readability: readability.value,
      modelConfidence: modelConfidence.value,
      bounds: bounds.value,
    },
  };
}

function parseBounds(value: unknown, path: string): Parsed<NormalizedBounds> {
  const obj = asObject(value, path, ["x", "y", "width", "height"]);
  if (!obj.ok) return obj;
  const x = finiteNumber(obj.value.x, `${path}/x`, 0, 1);
  if (!x.ok) return x;
  const y = finiteNumber(obj.value.y, `${path}/y`, 0, 1);
  if (!y.ok) return y;
  const width = finiteNumber(obj.value.width, `${path}/width`, 0, 1);
  if (!width.ok) return width;
  const height = finiteNumber(obj.value.height, `${path}/height`, 0, 1);
  if (!height.ok) return height;
  if (width.value === 0 || height.value === 0) return bad(path, "zero-area");
  if (x.value + width.value > 1) return bad(path, "horizontal-overflow");
  if (y.value + height.value > 1) return bad(path, "vertical-overflow");
  return { ok: true, value: { x: x.value, y: y.value, width: width.value, height: height.value } };
}

function parseArray<T>(
  value: unknown,
  path: string,
  maxItems: number,
  parse: (item: unknown, path: string) => Parsed<T>,
): Parsed<T[]> {
  if (!Array.isArray(value)) return bad(path, "array");
  if (value.length > maxItems) return bad(path, "too-many-items");
  const output: T[] = [];
  for (let index = 0; index < value.length; index++) {
    const parsed = parse(value[index], `${path}/${index}`);
    if (!parsed.ok) return parsed;
    output.push(parsed.value);
  }
  return { ok: true, value: output };
}

function asObject(value: unknown, path: string, exactKeys: string[]): Parsed<Record<string, unknown>> {
  if (!isObject(value)) return bad(path, "object");
  const keys = Object.keys(value);
  const allowed = new Set(exactKeys);
  const extra = keys.find((key) => !allowed.has(key));
  if (extra !== undefined) return bad(`${path}/${escapePointer(extra)}`, "unknown-field");
  const missing = exactKeys.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing !== undefined) return bad(`${path}/${escapePointer(missing)}`, "missing-field");
  return { ok: true, value };
}

function shortString(value: unknown, path: string, maxLength: number): Parsed<string> {
  if (typeof value !== "string") return bad(path, "string");
  if (value.length === 0 || value.length > maxLength || value.trim().length === 0) return bad(path, "string-length");
  if (!wellFormed(value)) return bad(path, "unicode");
  return { ok: true, value };
}

function nullableShortString(value: unknown, path: string, maxLength: number): Parsed<string | null> {
  return value === null ? { ok: true, value: null } : shortString(value, path, maxLength);
}

function finiteNumber(value: unknown, path: string, min: number, max: number): Parsed<number> {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return bad(path, "number-range");
  return { ok: true, value };
}

function integer(value: unknown, path: string, min: number, max: number): Parsed<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return bad(path, "integer-range");
  return { ok: true, value };
}

function literal<const T extends readonly string[]>(value: unknown, path: string, allowed: T): Parsed<T[number]> {
  return typeof value === "string" && allowed.includes(value)
    ? { ok: true, value: value as T[number] }
    : bad(path, "enum");
}

function firstDuplicate(values: string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function bad(path: string, code: string): { ok: false; issue: VisualSchemaIssue } {
  return { ok: false, issue: { path, code } };
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

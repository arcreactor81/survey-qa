/**
 * Memory-bounded SourceBlock JSONL construction.
 *
 * The extraction wire guard measures an exact, already-serialized provider body. That is
 * deliberately the final authority, but constructing a JSONL string containing one hostile
 * 50 MiB source value could exhaust a Worker before that guard gets a chance to refuse it.
 * This builder therefore proves a cheap lower bound over the raw values first, then performs
 * the canonical serialization one row at a time and joins only after the complete JSONL is
 * known to fit.
 *
 * Both phases consume `sourceBlockModelProjection`, the same schema as the canonical encoder.
 * Formatting is intentionally absent because that projection does not send it to the model.
 */

import { utf8ByteLength } from "../llm/extraction-wire";
import { encodeSourceBlocksJsonl, sourceBlockModelProjection } from "./docx-blocks";
import type { SourceBlock } from "./types";

export const SOURCE_BLOCK_JSONL_BYTE_CEILING_EXCEEDED =
  "source-block-jsonl-byte-ceiling-exceeded" as const;

export type BoundedSourceBlocksJsonlResult =
  | {
      ok: true;
      text: string;
      utf8Bytes: number;
    }
  | {
      ok: false;
      reasonCode: typeof SOURCE_BLOCK_JSONL_BYTE_CEILING_EXCEEDED;
      phase: "raw-value-lower-bound" | "canonical-row-bytes";
      maxBytes: number;
      /**
       * A conservative lower bound on the UTF-8 bytes the complete canonical JSONL would
       * occupy. This is always greater than `maxBytes`; it is not source text or a partial
       * serialization.
       */
      provenUtf8ByteLowerBound: number;
      blockCount: number;
    };

export type BoundedJsonTextResult =
  | { ok: true; text: string; utf8Bytes: number }
  | {
      ok: false;
      reasonCode: typeof SOURCE_BLOCK_JSONL_BYTE_CEILING_EXCEEDED;
      phase: "raw-value-lower-bound" | "canonical-json-bytes";
      maxBytes: number;
      provenUtf8ByteLowerBound: number;
    };

interface SaturatingLowerBound {
  value: number;
  /** `maxBytes + 1`, the first value that proves refusal. */
  refusalAt: number;
}

function addLowerBound(counter: SaturatingLowerBound, amount: number): void {
  if (counter.value >= counter.refusalAt || amount <= 0) return;
  const remaining = counter.refusalAt - counter.value;
  counter.value = amount >= remaining ? counter.refusalAt : counter.value + amount;
}

/**
 * Count a projected JSON value without allocating escaped strings, copied values or a
 * traversal collection. `sourceBlockModelProjection` itself is one fixed-size shallow object
 * containing the original nested references; the hostile strings are never copied.
 *
 * Each raw string code unit contributes at least one UTF-8 byte to its JSON string value:
 * ASCII stays one byte, non-ASCII expands, surrogate pairs use four bytes for two code units,
 * and JSON escaping expands quotes, controls, backslashes and lone surrogates. Omitting
 * punctuation and null literals makes this an underestimate, never an overestimate.
 */
function addProjectedJsonLowerBound(
  counter: SaturatingLowerBound,
  value: unknown,
): void {
  if (counter.value >= counter.refusalAt) return;
  if (value === null) {
    addLowerBound(counter, 4); // null
    return;
  }
  const kind = typeof value;
  if (kind === "string") {
    addLowerBound(counter, (value as string).length + 2); // surrounding quotes; escapes only add
    return;
  }
  if (kind === "boolean") {
    addLowerBound(counter, value ? 4 : 5);
    return;
  }
  if (kind === "number") {
    // Every JSON number spelling has at least one byte; non-finite values become `null`.
    addLowerBound(counter, 1);
    return;
  }
  if (kind !== "object") return;

  if (Array.isArray(value)) {
    addLowerBound(counter, 2); // []
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) addLowerBound(counter, 1); // comma
      const child = value[index];
      const childKind = typeof child;
      // JSON array holes and non-serializable values become the four-byte literal `null`.
      if (child === undefined || childKind === "function" || childKind === "symbol") {
        addLowerBound(counter, 4);
      } else {
        addProjectedJsonLowerBound(counter, child);
      }
      if (counter.value >= counter.refusalAt) return;
    }
    return;
  }

  const record = value as Record<string, unknown>;
  addLowerBound(counter, 2); // {}
  let included = 0;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const child = record[key];
    const childKind = typeof child;
    // JSON.stringify omits these values in object properties, so their key bytes cannot enter
    // a safe lower bound. The canonical projection is typed JSON data; this also fails safely
    // for a legacy/synthetic caller that carries an unexpected optional value.
    if (child === undefined || childKind === "function" || childKind === "symbol") continue;
    if (included > 0) addLowerBound(counter, 1); // comma
    included += 1;
    addLowerBound(counter, key.length + 3); // quoted key + colon; escaping only adds
    addProjectedJsonLowerBound(counter, child);
    if (counter.value >= counter.refusalAt) return;
  }
}

function validateMaxBytes(maxBytes: number): void {
  // Reserving `maxBytes + 1` as a saturating proof sentinel avoids unsafe arithmetic even
  // when a hostile document repeats the same large source value across many blocks.
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
    throw new Error("SourceBlock JSONL maxBytes must be a non-negative safe integer below Number.MAX_SAFE_INTEGER");
  }
}

/**
 * Build byte-exact canonical SourceBlock JSONL without ever returning a truncated prefix.
 *
 * Phase one visits every raw value included by `encodeSourceBlocksJsonl` and refuses before
 * `JSON.stringify` when its allocation-free byte lower bound already exceeds the ceiling.
 * Phase two delegates each row to that canonical encoder, exact-counts it, and stops before
 * the final join as soon as the complete output is proven too large.
 */
export function buildBoundedSourceBlocksJsonl(
  blocks: readonly SourceBlock[],
  maxBytes: number,
): BoundedSourceBlocksJsonlResult {
  validateMaxBytes(maxBytes);

  const rawLowerBound: SaturatingLowerBound = { value: 0, refusalAt: maxBytes + 1 };
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block === undefined) throw new Error("SourceBlock JSONL input changed during lower-bound walk");
    addProjectedJsonLowerBound(rawLowerBound, sourceBlockModelProjection(block));
    if (rawLowerBound.value >= rawLowerBound.refusalAt) {
      return {
        ok: false,
        reasonCode: SOURCE_BLOCK_JSONL_BYTE_CEILING_EXCEEDED,
        phase: "raw-value-lower-bound",
        maxBytes,
        provenUtf8ByteLowerBound: rawLowerBound.value,
        blockCount: blocks.length,
      };
    }
  }

  const rows: string[] = [];
  let utf8Bytes = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block === undefined) throw new Error("SourceBlock JSONL input changed during serialization");
    const row = encodeSourceBlocksJsonl([block]);
    const separatorBytes = index === 0 ? 0 : 1;
    const rowBytes = utf8ByteLength(row);
    const remaining = maxBytes - utf8Bytes;
    if (separatorBytes > remaining || rowBytes > remaining - separatorBytes) {
      // `utf8Bytes` is exact for prior canonical rows, the separator is one ASCII byte and
      // `rowBytes` is exact for this row. Later rows can only increase the complete size.
      const provenUtf8ByteLowerBound = utf8Bytes + separatorBytes + rowBytes;
      if (!Number.isSafeInteger(provenUtf8ByteLowerBound)) {
        throw new Error("SourceBlock JSONL exceeds the safe UTF-8 byte-count range");
      }
      return {
        ok: false,
        reasonCode: SOURCE_BLOCK_JSONL_BYTE_CEILING_EXCEEDED,
        phase: "canonical-row-bytes",
        maxBytes,
        provenUtf8ByteLowerBound,
        blockCount: blocks.length,
      };
    }
    rows.push(row);
    utf8Bytes += separatorBytes + rowBytes;
  }

  return { ok: true, text: rows.join("\n"), utf8Bytes };
}

/**
 * Memory-bounded canonical JSON for compact, acyclic model-input catalogues.
 *
 * Unlike SourceBlock JSONL there is no independent row boundary, but the raw-value proof
 * caps every source string/key before the one final JSON.stringify allocation. The exact
 * UTF-8 count remains authoritative whenever construction is allowed.
 */
export function buildBoundedJsonText(value: unknown, maxBytes: number): BoundedJsonTextResult {
  validateMaxBytes(maxBytes);
  const rawLowerBound: SaturatingLowerBound = { value: 0, refusalAt: maxBytes + 1 };
  addProjectedJsonLowerBound(rawLowerBound, value);
  if (rawLowerBound.value >= rawLowerBound.refusalAt) {
    return {
      ok: false,
      reasonCode: SOURCE_BLOCK_JSONL_BYTE_CEILING_EXCEEDED,
      phase: "raw-value-lower-bound",
      maxBytes,
      provenUtf8ByteLowerBound: rawLowerBound.value,
    };
  }
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("bounded canonical JSON root is not serializable");
  const utf8Bytes = utf8ByteLength(text);
  return utf8Bytes > maxBytes
    ? {
        ok: false,
        reasonCode: SOURCE_BLOCK_JSONL_BYTE_CEILING_EXCEEDED,
        phase: "canonical-json-bytes",
        maxBytes,
        provenUtf8ByteLowerBound: utf8Bytes,
      }
    : { ok: true, text, utf8Bytes };
}

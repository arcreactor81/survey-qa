// Step 1 + step 2 of the threat-model §4 order:
//  - strictParse(): full JSON parse that REJECTS duplicate object keys
//    (JSON.parse silently keeps the last one) and non-JSON values.
//  - buildValidators(): ajv (draft 2020-12) validators for the pinned
//    RunRecord / OracleRecord 1.0.0 schemas, loaded fresh from disk.
//
// Objects are built with Object.create(null) + defineProperty so that a raw
// "__proto__" (or "constructor"/"prototype") member injected into a signed
// record becomes an ORDINARY OWN KEY instead of mutating a prototype. With
// `obj[key] = value` on a normal object, a "__proto__" member would invoke the
// Object.prototype setter: it would silently disappear from Object.keys(), so
// canonical.mjs would recompute the attestation payload WITHOUT it and the
// tampered record would still verify (attestation bypass).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
const addFormats = addFormatsModule.default ?? addFormatsModule;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(HERE, "..", "..", "schemas");

/* ------------------------- strict JSON parser ------------------------- */

const WS = new Set([" ", "\t", "\n", "\r"]);

/**
 * Parse JSON text strictly. Throws SyntaxError on any invalid JSON and on
 * duplicate object keys anywhere in the document.
 */
export function strictParse(text) {
  if (typeof text !== "string") throw new SyntaxError("input is not text");
  let i = 0;
  const n = text.length;

  const err = (msg) => {
    throw new SyntaxError(`${msg} at offset ${i}`);
  };
  const ws = () => {
    while (i < n && WS.has(text[i])) i++;
  };

  const parseString = () => {
    // text[i] === '"'
    i++;
    let out = "";
    while (true) {
      if (i >= n) err("unterminated string");
      const c = text[i];
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\\") {
        i++;
        if (i >= n) err("unterminated escape");
        const e = text[i];
        if (e === '"') out += '"';
        else if (e === "\\") out += "\\";
        else if (e === "/") out += "/";
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "n") out += "\n";
        else if (e === "r") out += "\r";
        else if (e === "t") out += "\t";
        else if (e === "u") {
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) err("invalid \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else err(`invalid escape \\${e}`);
        i++;
      } else {
        const code = c.charCodeAt(0);
        if (code < 0x20) err("unescaped control character in string");
        out += c;
        i++;
      }
    }
  };

  const NUM_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

  const parseNumber = () => {
    const m = NUM_RE.exec(text.slice(i));
    if (!m) err("invalid number");
    i += m[0].length;
    const v = Number(m[0]);
    if (!Number.isFinite(v)) err("number out of range");
    return v;
  };

  const parseValue = () => {
    ws();
    if (i >= n) err("unexpected end of input");
    const c = text[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    err(`unexpected token '${c}'`);
  };

  const defineOwn = (obj, key, val) => {
    // NEVER `obj[key] = val`: that routes "__proto__" through the prototype
    // setter and drops it from the record's own properties.
    Object.defineProperty(obj, key, {
      value: val,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  };

  const parseObject = () => {
    // text[i] === '{'
    i++;
    const obj = Object.create(null);
    const seen = new Set();
    ws();
    if (text[i] === "}") {
      i++;
      return obj;
    }
    while (true) {
      ws();
      if (text[i] !== '"') err("expected string key");
      const key = parseString();
      if (seen.has(key)) err(`duplicate object key "${key}"`);
      seen.add(key);
      ws();
      if (text[i] !== ":") err("expected ':'");
      i++;
      const val = parseValue();
      defineOwn(obj, key, val);
      ws();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return obj;
      }
      err("expected ',' or '}'");
    }
  };

  const parseArray = () => {
    // text[i] === '['
    i++;
    const arr = [];
    ws();
    if (text[i] === "]") {
      i++;
      return arr;
    }
    while (true) {
      arr.push(parseValue());
      ws();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return arr;
      }
      err("expected ',' or ']'");
    }
  };

  const value = parseValue();
  ws();
  if (i !== n) err("trailing characters after JSON value");
  return value;
}

/* --------------------------- ajv validators --------------------------- */

let cached = null;

export function buildValidators() {
  if (cached) return cached;
  const runSchema = JSON.parse(
    readFileSync(path.join(SCHEMAS_DIR, "run-record.schema.json"), "utf8")
  );
  const oracleSchema = JSON.parse(
    readFileSync(path.join(SCHEMAS_DIR, "oracle-record.schema.json"), "utf8")
  );
  const ajv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  const validateRun = ajv.compile(runSchema);
  const validateOracle = ajv.compile(oracleSchema);
  cached = { validateRun, validateOracle };
  return cached;
}

/** Render ajv errors into a short deterministic message. */
export function formatAjvErrors(errors, limit = 5) {
  if (!errors || errors.length === 0) return "unknown schema violation";
  const parts = errors
    .slice(0, limit)
    .map((e) => `${e.instancePath || "/"} ${e.message}`);
  const more = errors.length > limit ? ` (+${errors.length - limit} more)` : "";
  return parts.join("; ") + more;
}

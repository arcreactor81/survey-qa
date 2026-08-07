// RFC 8785 (JSON Canonicalization Scheme) implementation for the scorer.
//
// Properties relied upon (verified by conformance vectors in scorer/test/selftest.mjs):
//  - Object properties are sorted by UTF-16 code units of the property name
//    (JavaScript's default string comparison), NOT by Unicode code points.
//  - Numbers serialize per ECMAScript Number::toString (shortest round-trip),
//    which is exactly what JSON.stringify produces for finite numbers in V8,
//    with -0 serializing as "0".
//  - Strings use minimal escaping: the two-character escapes \" \\ \b \t \n \f \r,
//    \u00xx (lowercase hex) for remaining control characters, and everything else
//    (including non-ASCII and lone-surrogate-free text) emitted literally.
//    JSON.stringify implements exactly this.
//  - No whitespace; array/object element order as produced.
//  - RFC 8785 requires FAILURE on strings that are not well-formed Unicode.
//    V8's JSON.stringify happily serializes lone surrogates (as \udXXX escapes
//    since ES2019 "well-formed JSON.stringify"), so every string - object KEYS
//    included - is validated recursively before it is emitted.
//  - Own "__proto__" members are ordinary keys here: the strict parser builds
//    null-prototype objects with defineProperty, so a raw __proto__ member in
//    the document survives into Object.keys() and into the canonical form
//    (otherwise it would vanish from the recomputed attestation payload).

import { createHash } from "node:crypto";

/**
 * RFC 8785 §3.2.2.2 / JSON serialization of "not well-formed" strings must
 * fail. Throws on an unpaired high or low surrogate anywhere in `s`.
 */
export function assertWellFormedUnicode(s, where) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(
          `RFC 8785: lone high surrogate U+${c.toString(16).toUpperCase()} at index ${i} in ${where}`
        );
      }
      i++; // valid pair
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new TypeError(
        `RFC 8785: lone low surrogate U+${c.toString(16).toUpperCase()} at index ${i} in ${where}`
      );
    }
  }
  return s;
}

export function canonicalize(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("RFC 8785: non-finite numbers cannot be canonicalized");
    }
    return JSON.stringify(value); // ES ToString for finite numbers; -0 -> "0"
  }
  if (t === "string") {
    assertWellFormedUnicode(value, "string value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  if (t === "object") {
    // Default Array.prototype.sort() on strings compares UTF-16 code units,
    // which is the ordering RFC 8785 requires.
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      const v = value[k];
      if (v === undefined) continue; // undefined properties are absent in JSON
      assertWellFormedUnicode(k, "object key");
      parts.push(JSON.stringify(k) + ":" + canonicalize(v));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new TypeError(`RFC 8785: unsupported type ${t}`);
}

export function sha256HexOfUtf8(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256OfBytes(buf) {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

/** sha256:<hex> of the RFC 8785 canonical form of a JSON value. */
export function jcsHash(value) {
  return "sha256:" + sha256HexOfUtf8(canonicalize(value));
}

/** Raw 32-byte SHA-256 digest of the RFC 8785 canonical form. */
export function jcsDigestBytes(value) {
  return createHash("sha256").update(canonicalize(value), "utf8").digest();
}

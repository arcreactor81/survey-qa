/** Canonical JSON + sha-256. Used for content addressing, ETags and contract sealing. */

// THE CANONICALIZER IS IMPORTED, NOT WRITTEN HERE.
//
// This module used to canonicalize by assigning sorted keys into a fresh `{}`:
//
//     const out: Record<string, unknown> = {};
//     for (const key of Object.keys(src).sort()) out[key] = sortDeep(src[key]);
//
// An own `__proto__` member of `src` is an ORDINARY key to `Object.keys`, but the
// assignment `out["__proto__"] = ...` invokes the legacy Object.prototype setter instead
// of defining a property. The member therefore VANISHES from the canonical form, so two
// documents that differ only in a `__proto__` payload hash identically — a signed digest
// that a chosen field can be smuggled past. The scorer had exactly this hole and it was
// fixed there yesterday by building the canonical STRING directly rather than a second
// object; `scorer/src/lib/canonical.mjs` is that hardened RFC 8785 implementation and it
// is covered by the scorer's conformance vectors.
//
// A second implementation in the Worker is precisely the defect class this project
// exists to delete: two canonicalizers that can disagree about whether the same bytes
// are the same bytes. So there is one, it lives in the scorer, and this module imports
// it. The digest is computed with WebCrypto rather than `canonical.mjs`'s node:crypto
// helper because the Worker has no synchronous hashing primitive; the INPUT to that
// digest — the canonical byte string — is the shared implementation's output verbatim.
// @ts-ignore -- untyped ESM shared with the scorer and the report renderer
import { canonicalize as canonicalizeUntyped } from "../../../scorer/src/lib/canonical.mjs";

const canonicalize = canonicalizeUntyped as (value: unknown) => string;

const enc = new TextEncoder();

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes =
    typeof data === "string" ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  // Copy into a fresh, exactly-sized buffer so a view over a larger pool hashes correctly.
  const buf = new Uint8Array(bytes.byteLength);
  buf.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * RFC 8785 (JSON Canonicalization Scheme) serialization, from the one shared
 * implementation. Two structurally equal records must hash identically regardless of
 * construction order — otherwise a "contract revision id IS its hash" guarantee is only
 * true by luck — AND a member that JSON can carry must never be able to disappear from
 * the digest on its way through the canonicalizer.
 *
 * It THROWS on non-finite numbers and on strings (including object keys) that are not
 * well-formed Unicode. That is deliberate: RFC 8785 requires failure there, and a
 * canonicalizer that silently repairs its input is a canonicalizer that lets two
 * different documents share a digest.
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export const canonicalHash = (value: unknown): Promise<string> => sha256Hex(canonicalJson(value));

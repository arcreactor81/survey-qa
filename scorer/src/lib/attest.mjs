// Harness attestation: Ed25519 over the SHA-256 digest of the RFC 8785
// canonical form of the entire RunRecord with `attestation` omitted
// (threat-model §8).
//
// verifyAttestation() is the scorer-side entry point.
// signRecord() is a HARNESS-SIGNER used ONLY by fixtures/tests; the private
// fixture key lives in scorer/fixtures/keys/ and is clearly test-only.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  generateKeyPairSync,
} from "node:crypto";
import { jcsDigestBytes } from "./canonical.mjs";

/** Compute "sha256:<hex>" payload hash of record-without-attestation. */
export function payloadHashOf(record) {
  const { attestation, ...rest } = record;
  return "sha256:" + jcsDigestBytes(rest).toString("hex");
}

function b64urlToBuf(s) {
  return Buffer.from(s, "base64url");
}

function bufToB64url(buf) {
  return buf.toString("base64url");
}

/** Load a key registry JSON: { note, testOnly?, keys: { <keyId>: { publicKeyPem } } } */
export function loadKeyRegistry(registryPath) {
  const raw = readFileSync(registryPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.keys !== "object" || parsed.keys === null) {
    throw new Error(`key registry ${registryPath} has no "keys" object`);
  }
  return parsed;
}

/* ------------------------------------------------------------------ */
/* TRUST-ANCHOR RESOLUTION — a test key is never a default anchor.     */
/*                                                                     */
/* The fixture registry's PRIVATE half is committed beside it, so a    */
/* published repo hands everyone the ability to mint self-consistent   */
/* telemetry. Two rules close that:                                    */
/*   1. no registry configured  -> refuse (never fall back silently);  */
/*   2. a registry that declares `"testOnly": true` -> refuse unless   */
/*      the caller explicitly opted in by naming it as a fixture       */
/*      registry (--fixture-keys / SURVEY_QA_ALLOW_FIXTURE_KEYS=1).    */
/* ------------------------------------------------------------------ */

// MODULE SCOPE MUST NOT ASSUME A FILESYSTEM IDENTITY.
//
// `import.meta.url` is undefined inside a bundled Cloudflare Worker, so this line threw
// `TypeError: The "path" argument must be of type string` AT STARTUP — before any handler
// ran — and every edge upload of survey-qa-v2 (which imports this module transitively via
// the judgement/record-integrity path) failed validation with code 10021. The Worker never
// reads a registry from disk; it only needs the verify/sign functions. Under Node the
// value is unchanged.
const HERE = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return ".";
  }
})();

/** The checked-in fixture trust anchor. Usable ONLY under explicit opt-in. */
export const FIXTURE_KEY_REGISTRY = path.resolve(HERE, "..", "..", "fixtures", "keys", "registry.json");

/** Env-var form of the fixture opt-in (equivalent to the --fixture-keys flag). */
export const FIXTURE_KEYS_ENV = "SURVEY_QA_ALLOW_FIXTURE_KEYS";

/** True when a registry declares itself test-only in its own data. */
export function isTestOnlyRegistry(registry) {
  return registry?.testOnly === true;
}

/** True when the caller explicitly opted in to test-only trust anchors. */
export function fixtureKeysAllowed(explicit = false) {
  if (explicit === true) return true;
  const v = process.env[FIXTURE_KEYS_ENV];
  return v === "1" || v === "true";
}

/**
 * Resolve and load the trust anchor, fail-closed.
 *
 * @param {object} o
 * @param {string|null} [o.keysPath]        registry path the caller named
 * @param {boolean} [o.allowFixtureKeys]    explicit fixture opt-in (flag)
 * @param {boolean} [o.fallbackToFixtures]  when opted in AND no path given,
 *                                          use the checked-in fixture registry
 * @returns {{ok:true, registry:object, registryPath:string, testAnchor:boolean}
 *          |{ok:false, code:string, message:string}}
 */
export function resolveKeyRegistry({
  keysPath = null,
  allowFixtureKeys = false,
  fallbackToFixtures = false,
} = {}) {
  const allowed = fixtureKeysAllowed(allowFixtureKeys);
  const optIn = `pass --fixture-keys (or ${FIXTURE_KEYS_ENV}=1) to accept the checked-in TEST-ONLY fixture registry`;

  let registryPath = keysPath || null;
  if (!registryPath && allowed && fallbackToFixtures && existsSync(FIXTURE_KEY_REGISTRY)) {
    registryPath = FIXTURE_KEY_REGISTRY;
  }
  if (!registryPath) {
    return {
      ok: false,
      code: "KEY_REGISTRY_MISSING",
      message: `no key registry configured; a RunRecord cannot be authenticated without one — pass --keys <registry.json>, or ${optIn}`,
    };
  }
  if (!existsSync(registryPath)) {
    return { ok: false, code: "KEY_REGISTRY_MISSING", message: `key registry not found: ${registryPath}` };
  }

  let registry;
  try {
    registry = loadKeyRegistry(registryPath);
  } catch (e) {
    return { ok: false, code: "KEY_REGISTRY_UNUSABLE", message: `key registry unavailable: ${e.message}` };
  }

  const testAnchor = isTestOnlyRegistry(registry);
  if (testAnchor && !allowed) {
    return {
      ok: false,
      code: "KEY_REGISTRY_TEST_ONLY",
      message: `key registry ${registryPath} declares "testOnly": true and its private half is published; refusing to use a test key as a trust anchor — ${optIn}`,
    };
  }
  return { ok: true, registry, registryPath, testAnchor };
}

/**
 * Verify the harness attestation on a RunRecord.
 * Returns { ok: true } or { ok: false, code: "ATTESTATION_INVALID", message }.
 * Fail-closed: any structural problem, unknown key, hash mismatch, or bad
 * signature is ATTESTATION_INVALID.
 */
export function verifyAttestation(record, keyRegistry) {
  const att = record?.attestation;
  const fail = (message) => ({ ok: false, code: "ATTESTATION_INVALID", message });
  if (!att || typeof att !== "object") return fail("attestation block missing");
  if (att.algorithm !== "Ed25519") return fail(`unsupported algorithm ${att.algorithm}`);
  if (att.canonicalization !== "RFC8785") return fail(`unsupported canonicalization ${att.canonicalization}`);
  if (att.scope !== "entire-record-excluding-attestation") return fail(`unsupported scope ${att.scope}`);

  let expectedHash;
  try {
    expectedHash = payloadHashOf(record);
  } catch (e) {
    return fail(`payload canonicalization failed: ${e.message}`);
  }
  if (att.payloadHash !== expectedHash) {
    return fail(
      `payloadHash mismatch: attested ${att.payloadHash} but recomputed ${expectedHash} (record modified after signing?)`
    );
  }

  const keyEntry = keyRegistry?.keys?.[att.keyId];
  if (!keyEntry || !keyEntry.publicKeyPem) {
    return fail(`keyId ${att.keyId} not present in the pinned key registry`);
  }
  let publicKey;
  try {
    publicKey = createPublicKey(keyEntry.publicKeyPem);
  } catch (e) {
    return fail(`registry public key unusable: ${e.message}`);
  }

  let sig;
  try {
    sig = b64urlToBuf(att.signature);
  } catch {
    return fail("signature is not valid base64url");
  }
  if (sig.length !== 64) return fail(`signature must be 64 bytes, got ${sig.length}`);

  const digest = Buffer.from(expectedHash.slice("sha256:".length), "hex");
  let verified = false;
  try {
    verified = edVerify(null, digest, publicKey, sig);
  } catch (e) {
    return fail(`signature verification error: ${e.message}`);
  }
  if (!verified) return fail("Ed25519 signature does not verify over the payload digest");
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* HARNESS-SIGNER — fixtures/tests ONLY. The production harness owns   */
/* its own signing key; the scorer never signs records it scores.      */
/* ------------------------------------------------------------------ */

/**
 * Sign a record (attestation field ignored/replaced). Returns a complete
 * attestation object. `signedAt` must be supplied for determinism.
 */
export function signRecord(record, privateKeyPem, keyId, signedAt) {
  const { attestation, ...rest } = record;
  const digest = jcsDigestBytes(rest);
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = edSign(null, digest, privateKey);
  return {
    algorithm: "Ed25519",
    canonicalization: "RFC8785",
    scope: "entire-record-excluding-attestation",
    keyId,
    signedAt,
    payloadHash: "sha256:" + digest.toString("hex"),
    signature: bufToB64url(signature),
  };
}

/** Generate a fixture-only Ed25519 keypair as PEM strings. */
export function generateFixtureKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

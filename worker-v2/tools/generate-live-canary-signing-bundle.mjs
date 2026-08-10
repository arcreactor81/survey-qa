#!/usr/bin/env node

/**
 * Create one reusable, local-only signing identity for the isolated live-canary series.
 *
 * Generate this bundle once and reuse it for every semantic arm. Regenerating between arms would
 * make earlier canary judgements unverifiable by later generated configs. The bundle never leaves
 * `.test-tmp`; only its judgement public key is injected into an isolated generated Wrangler
 * config, while the two private keys are projected into the Worker's secret upload file.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertPrivateLocalPath, hardenPrivateLocalDirectory } from "./private-local-output.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const CANARY_SIGNING_OUTPUT_ROOT = path.join(REPO_ROOT, ".test-tmp");
export const CANARY_SIGNING_BUNDLE_FILE = "canary-signing-bundle.json";
export const CANARY_SIGNING_BUNDLE_SCHEMA_VERSION =
  "survey-qa-live-canary-signing-bundle/1.0.0";

const MAX_BUNDLE_BYTES = 256 * 1024;
const BUNDLE_KEYS = ["schemaVersion", "record", "judgement"];
const ENTRY_KEYS = [
  "keyId",
  "privateKeyPkcs8Pem",
  "publicKeySpki",
  "publicKeySpkiSha256",
];
const PURPOSES = new Set(["record", "judgement"]);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await generateCanarySigningBundle(parseArgs(process.argv.slice(2)).outputDir);
    // Key ids are public identities. Private/public key bytes never enter stdout or diagnostics.
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `live canary signing bundle refused: ${error instanceof Error ? error.message : "operation failed"}\n`,
    );
    process.exitCode = 1;
  }
}

/** Claim a fresh direct child of `.test-tmp` and write one mode-0600 JSON bundle. */
export async function generateCanarySigningBundle(outputDirectory) {
  const outputDir = checkedSigningOutputDirectory(outputDirectory);
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  hardenPrivateLocalDirectory(outputDir, REPO_ROOT);

  const bundle = createCanarySigningBundle();
  const bundlePath = path.join(outputDir, CANARY_SIGNING_BUNDLE_FILE);
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(bundlePath, 0o600);
  assertPrivateLocalPath(bundlePath, REPO_ROOT);

  return {
    schemaVersion: CANARY_SIGNING_BUNDLE_SCHEMA_VERSION,
    bundlePath,
    recordKeyId: bundle.record.keyId,
    judgementKeyId: bundle.judgement.keyId,
  };
}

/** Create two independent fresh Ed25519 identities without writing or printing their bytes. */
export function createCanarySigningBundle() {
  return {
    schemaVersion: CANARY_SIGNING_BUNDLE_SCHEMA_VERSION,
    record: generateEntry("record"),
    judgement: generateEntry("judgement"),
  };
}

/** Read only the fixed bundle file beneath a direct `.test-tmp` child and validate every byte. */
export async function loadCanarySigningBundle(bundleFile) {
  const resolved = await checkedSigningBundleFile(bundleFile);
  const source = await readFile(resolved, "utf8");
  return parseCanarySigningBundle(source);
}

/** Parse exact-schema JSON and prove each declared public key is the private key's Ed25519 pair. */
export function parseCanarySigningBundle(source) {
  if (typeof source !== "string" || source.length === 0 || Buffer.byteLength(source, "utf8") > MAX_BUNDLE_BYTES) {
    throw new Error("signing bundle is empty or too large");
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("signing bundle is not valid JSON");
  }
  exactObject(parsed, BUNDLE_KEYS, "signing bundle");
  if (parsed.schemaVersion !== CANARY_SIGNING_BUNDLE_SCHEMA_VERSION) {
    throw new Error("signing bundle schema is missing or unsupported");
  }
  return {
    schemaVersion: CANARY_SIGNING_BUNDLE_SCHEMA_VERSION,
    record: validateEntry(parsed.record, "record", true),
    judgement: validateEntry(parsed.judgement, "judgement", false),
  };
}

/** Exact four-secret upload projection. Public keys and DEV_SEED are structurally absent. */
export function canarySigningSecretsJson(bundle) {
  const validated = parseCanarySigningBundle(JSON.stringify(bundle));
  return `${JSON.stringify({
    JUDGEMENT_SIGNING_KEY: validated.judgement.privateKeyPkcs8Pem,
    JUDGEMENT_SIGNING_KEY_ID: validated.judgement.keyId,
    RECORD_SIGNING_KEY: validated.record.privateKeyPkcs8Pem,
    RECORD_SIGNING_KEY_ID: validated.record.keyId,
  }, null, 2)}\n`;
}

/** Full SPKI fingerprint binding; truncation is deliberately avoided for canary identities. */
export function canarySigningKeyId(purpose, publicKeySpki) {
  if (!PURPOSES.has(purpose)) throw new Error("signing key purpose is unsupported");
  const der = decodeCanonicalBase64(publicKeySpki, `${purpose} public key`);
  return canaryKeyIdFromDer(purpose, der);
}

function generateEntry(purpose) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPkcs8Pem = String(
    privateKey.export({ type: "pkcs8", format: "pem" }),
  ).replace(/\r\n/g, "\n").trimEnd();
  const publicDer = Buffer.from(publicKey.export({ type: "spki", format: "der" }));
  const publicKeySpki = publicDer.toString("base64");
  const publicKeySpkiSha256 = sha256(publicDer);
  return {
    keyId: canaryKeyIdFromDer(purpose, publicDer),
    privateKeyPkcs8Pem,
    publicKeySpki,
    publicKeySpkiSha256,
  };
}

function validateEntry(value, purpose, requireCanaryId) {
  exactObject(value, ENTRY_KEYS, `${purpose} signing entry`);
  if (typeof value.keyId !== "string" || !/^[a-z0-9][a-z0-9-]{2,199}$/.test(value.keyId)) {
    throw new Error(`${purpose} signing key id is invalid`);
  }
  if (
    typeof value.privateKeyPkcs8Pem !== "string" ||
    value.privateKeyPkcs8Pem.length === 0 ||
    value.privateKeyPkcs8Pem.length > 16 * 1024 ||
    value.privateKeyPkcs8Pem.includes("\u0000")
  ) {
    throw new Error(`${purpose} signing private key is empty or invalid`);
  }

  let privateKey;
  try {
    privateKey = createPrivateKey(value.privateKeyPkcs8Pem);
    if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") throw new Error();
  } catch {
    throw new Error(`${purpose} signing private key is not valid Ed25519 PKCS8`);
  }
  const canonicalPrivatePem = String(
    privateKey.export({ type: "pkcs8", format: "pem" }),
  ).replace(/\r\n/g, "\n").trimEnd();
  if (value.privateKeyPkcs8Pem.replace(/\r\n/g, "\n").trimEnd() !== canonicalPrivatePem) {
    throw new Error(`${purpose} signing private key is not canonical PKCS8 PEM`);
  }

  const declaredPublicDer = decodeCanonicalBase64(value.publicKeySpki, `${purpose} public key`);
  let declaredPublicKey;
  try {
    declaredPublicKey = createPublicKey({ key: declaredPublicDer, format: "der", type: "spki" });
    if (declaredPublicKey.asymmetricKeyType !== "ed25519") throw new Error();
  } catch {
    throw new Error(`${purpose} signing public key is not valid Ed25519 SPKI`);
  }
  const canonicalDeclaredDer = Buffer.from(
    declaredPublicKey.export({ type: "spki", format: "der" }),
  );
  if (!canonicalDeclaredDer.equals(declaredPublicDer)) {
    throw new Error(`${purpose} signing public key is not canonical Ed25519 SPKI`);
  }
  const derivedPublicDer = Buffer.from(
    createPublicKey(privateKey).export({ type: "spki", format: "der" }),
  );
  if (!derivedPublicDer.equals(declaredPublicDer)) {
    throw new Error(`${purpose} signing public/private key pair does not match`);
  }

  const publicKeySpkiSha256 = sha256(derivedPublicDer);
  if (value.publicKeySpkiSha256 !== publicKeySpkiSha256) {
    throw new Error(`${purpose} signing public-key fingerprint does not match`);
  }
  const expectedCanaryId = canaryKeyIdFromDer(purpose, derivedPublicDer);
  if (requireCanaryId && value.keyId !== expectedCanaryId) {
    throw new Error(`${purpose} signing key id is not bound to its public-key fingerprint`);
  }

  return {
    keyId: value.keyId,
    privateKeyPkcs8Pem: canonicalPrivatePem,
    publicKeySpki: derivedPublicDer.toString("base64"),
    publicKeySpkiSha256,
  };
}

function decodeCanonicalBase64(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4 * 1024 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`${label} is not canonical base64`);
  return bytes;
}

function exactObject(value, expectedKeys, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly ${expectedKeys.join(", ")}`);
  }
}

function canaryKeyIdFromDer(purpose, publicDer) {
  return `canary-${purpose}-ed25519-${sha256(publicDer)}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkedSigningOutputDirectory(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("--output-dir is required");
  }
  const resolved = path.resolve(value);
  const relative = path.relative(CANARY_SIGNING_OUTPUT_ROOT, resolved);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    path.dirname(relative) !== "."
  ) {
    throw new Error(`--output-dir must be a new direct child of ${CANARY_SIGNING_OUTPUT_ROOT}`);
  }
  return resolved;
}

async function checkedSigningBundleFile(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("--signing-bundle is required");
  }
  const resolved = path.resolve(value);
  const relative = path.relative(CANARY_SIGNING_OUTPUT_ROOT, resolved);
  const parts = relative.split(path.sep);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    parts.length !== 2 ||
    parts[1] !== CANARY_SIGNING_BUNDLE_FILE
  ) {
    throw new Error(`signing bundle must be ${CANARY_SIGNING_BUNDLE_FILE} under a direct child of ${CANARY_SIGNING_OUTPUT_ROOT}`);
  }
  const [rootReal, fileReal] = await Promise.all([
    realpath(CANARY_SIGNING_OUTPUT_ROOT),
    realpath(resolved),
  ]);
  const realRelative = path.relative(rootReal, fileReal);
  const realParts = realRelative.split(path.sep);
  if (
    realRelative.startsWith("..") ||
    path.isAbsolute(realRelative) ||
    realParts.length !== 2 ||
    realParts[1] !== CANARY_SIGNING_BUNDLE_FILE
  ) {
    throw new Error("signing bundle resolved outside the allowed local root");
  }
  return resolved;
}

function parseArgs(args) {
  if (args.length !== 2 || args[0] !== "--output-dir" || typeof args[1] !== "string") usage();
  return { outputDir: args[1] };
}

function usage() {
  throw new Error(
    `usage: node tools/generate-live-canary-signing-bundle.mjs --output-dir <new direct child of ${CANARY_SIGNING_OUTPUT_ROOT}>`,
  );
}

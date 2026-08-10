/**
 * THE JUDGEMENT BOUNDARY — where a stored judgement document either becomes this run's
 * current results or becomes a labelled diagnostic, with nothing in between.
 *
 * WHAT WAS WRONG. `report/build.ts` read `judgement.json` with `readOptionalJson`:
 * unreadable or malformed degraded to `null`, and ANYTHING that parsed as JSON was handed
 * to the renderer as the re-derived column. That gave two silent failures with the same
 * shape as the defect v2 exists to delete:
 *
 *   - DELETE the object and the report is rebuilt from the run's own prose verdicts, with
 *     no trace that a second, independent column ever existed. Removing evidence made the
 *     page MORE confident.
 *   - COPY another run's bundle in — obligation ids overlap across runs of the same
 *     document — and its verdicts render as this run's, against this run's evidence.
 *
 * Neither needed a signature to defeat, because nothing checked one.
 *
 * WHAT THIS MODULE DOES. Four gates, each of which can only ever DEMOTE:
 *   1. present            — absent is `absent`, and absent is loud, not blank.
 *   2. schema-valid       — via the SHARED validator, so the Worker and the offline
 *                           renderer cannot disagree about what a JudgementRecord is.
 *   3. attested           — Ed25519 over the RFC 8785 canonical digest, against a PINNED
 *                           key registry supplied as configuration. No registry ⇒
 *                           `unavailable` ⇒ not trusted. "Could not check" is never "fine".
 *   4. bound to THIS run  — every binding is recomputed from the Worker's own durable
 *                           state (the stored RunRecord, the sealed contract revision on
 *                           the checkpoint, the envelope's target build, the evidence
 *                           catalogue), never read back out of the judgement itself.
 *
 * Gate 4 is the one that kills the substitution attack, and it is stronger here than a
 * pure record-vs-record comparison precisely because the Worker knows independently which
 * contract revision this run sealed and which build it targeted.
 */

import type { Env } from "../types/env";
import { judgementKey } from "../keys";
import { canonicalHash } from "./hash";
import {
  JUDGEMENT_RECORD_KIND,
  type BindingCheck,
  type JudgementLoad,
  type JudgementProblem,
  type JudgementRecord,
} from "../types/judgement";

// THE SCHEMA AND THE MANIFEST DEFINITION ARE IMPORTED, NOT RESTATED.
// `pipeline/report/lib/judgement-record.mjs` is the cross-track contract module: the
// offline renderer validates with this function and computes the evidence-manifest root
// with this function, so a record the Worker calls valid is a record the renderer calls
// valid, and a manifest root the judge binds to is the root the Worker recomputes. A
// second copy of either rule in this file would be a second source of truth about what
// counts as the same evidence set.
// @ts-ignore -- untyped ESM, shared with the offline report renderer
import * as judgementContract from "../../../pipeline/report/lib/judgement-record.mjs";

const { evidenceManifestRoot: evidenceManifestRootUntyped, validateJudgementRecordShape: validateShapeUntyped } =
  judgementContract as unknown as {
    evidenceManifestRoot: (record: unknown) => string;
    validateJudgementRecordShape: (candidate: unknown) => JudgementProblem[];
  };

const validateJudgementRecordShape = validateShapeUntyped as (candidate: unknown) => JudgementProblem[];
/** sha256:<hex> over the run's evidence catalogue as the RunRecord itself declares it. */
export const evidenceManifestRoot = evidenceManifestRootUntyped as (record: unknown) => string;

// ---------------------------------------------------------------------------
// Pinned key registry
// ---------------------------------------------------------------------------

export interface JudgementKeyEntry {
  /** SPKI DER, base64. Preferred: it carries the algorithm identifier with the key. */
  publicKeySpki?: string;
  /** PEM wrapper around the same SPKI DER. */
  publicKeyPem?: string;
  /** Raw 32-byte Ed25519 public key, base64 or base64url. */
  publicKeyRaw?: string;
  /**
   * `production` keys are honoured anywhere. Anything else — `fixture` for the test-only
   * keypair the smoke suite signs with — is honoured ONLY in local dev, i.e. when
   * DEV_SEED is enabled, which cannot be true on a deployed build because DEV_SEED is
   * absent from wrangler.jsonc. A committed fixture private key must never be able to
   * publish current results in production.
   */
  trust?: string;
  note?: string;
}

export interface JudgementKeyRegistry {
  keys: Record<string, JudgementKeyEntry>;
}

export function parseKeyRegistry(raw: string | undefined): { registry: JudgementKeyRegistry | null; reason: string } {
  if (!raw || raw.trim().length === 0) {
    return {
      registry: null,
      reason:
        "No JUDGEMENT_KEY_REGISTRY is configured, so no judgement signature can be checked. " +
        "Until a pinned public key is configured, derived verdicts are operational diagnostics only.",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      registry: null,
      reason: `JUDGEMENT_KEY_REGISTRY is not parseable JSON (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  const keys = (parsed as JudgementKeyRegistry | null)?.keys;
  if (!keys || typeof keys !== "object") {
    return { registry: null, reason: 'JUDGEMENT_KEY_REGISTRY has no "keys" object.' };
  }
  return { registry: { keys }, reason: "" };
}

// ---------------------------------------------------------------------------
// Ed25519 verification (WebCrypto — the Worker has no node:crypto key objects)
// ---------------------------------------------------------------------------

const b64ToBytes = (b64: string): Uint8Array => {
  const norm = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const pad = norm.length % 4 === 0 ? norm : norm + "=".repeat(4 - (norm.length % 4));
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** SPKI DER prefix for an Ed25519 public key; a raw 32-byte key is wrapped with it. */
const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

async function importVerifyKey(entry: JudgementKeyEntry): Promise<CryptoKey> {
  const alg = { name: "Ed25519" };
  if (entry.publicKeySpki) {
    return crypto.subtle.importKey("spki", b64ToBytes(entry.publicKeySpki), alg, false, ["verify"]);
  }
  if (entry.publicKeyPem) {
    const body = entry.publicKeyPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    return crypto.subtle.importKey("spki", b64ToBytes(body), alg, false, ["verify"]);
  }
  if (entry.publicKeyRaw) {
    const raw = b64ToBytes(entry.publicKeyRaw);
    if (raw.byteLength !== 32) throw new Error(`publicKeyRaw must decode to 32 bytes, got ${raw.byteLength}`);
    const der = new Uint8Array(ED25519_SPKI_PREFIX.byteLength + 32);
    der.set(ED25519_SPKI_PREFIX, 0);
    der.set(raw, ED25519_SPKI_PREFIX.byteLength);
    return crypto.subtle.importKey("spki", der, alg, false, ["verify"]);
  }
  throw new Error("registry entry carries no public key");
}

/**
 * Verify the attestation block. Fail-closed on every structural problem: an unknown key,
 * a payload hash that does not recompute, a malformed signature and a bad signature all
 * produce the same answer — not trusted — with a reason that says which.
 */
export async function verifyJudgementAttestation(
  record: JudgementRecord,
  registry: JudgementKeyRegistry,
  opts: { allowFixtureKeys: boolean },
): Promise<{ ok: boolean; reason: string }> {
  const att = record.attestation;
  const entry = registry.keys[att.keyId];
  if (!entry) {
    return { ok: false, reason: `keyId ${JSON.stringify(att.keyId)} is not in the pinned key registry.` };
  }
  const trust = entry.trust ?? "production";
  if (trust !== "production" && !opts.allowFixtureKeys) {
    return {
      ok: false,
      reason:
        `keyId ${JSON.stringify(att.keyId)} is registered with trust ${JSON.stringify(trust)}, which is honoured only in ` +
        `local development. A fixture key may never sign current results.`,
    };
  }

  // Recompute the payload hash over the SAME scope the signer used: the whole record with
  // `attestation` omitted, RFC 8785 canonical, sha-256.
  const { attestation: _drop, ...rest } = record as Record<string, unknown>;
  let computed: string;
  try {
    computed = `sha256:${await canonicalHash(rest)}`;
  } catch (err) {
    return { ok: false, reason: `the judgement could not be canonicalized: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (computed !== att.payloadHash) {
    return {
      ok: false,
      reason: `payloadHash mismatch: attested ${att.payloadHash}, recomputed ${computed} (record modified after signing?).`,
    };
  }

  let sig: Uint8Array;
  try {
    sig = b64ToBytes(att.signature);
  } catch {
    return { ok: false, reason: "attestation.signature is not valid base64url." };
  }
  if (sig.byteLength !== 64) {
    return { ok: false, reason: `attestation.signature must decode to 64 bytes, got ${sig.byteLength}.` };
  }

  let key: CryptoKey;
  try {
    key = await importVerifyKey(entry);
  } catch (err) {
    return { ok: false, reason: `registry public key unusable: ${err instanceof Error ? err.message : String(err)}` };
  }

  // The signature is over the RAW 32-BYTE DIGEST, exactly as scorer/src/lib/attest.mjs
  // signs it (`edSign(null, jcsDigestBytes(rest), key)`), not over the canonical text.
  const digest = hexToBytes(computed.slice("sha256:".length));
  let ok = false;
  try {
    ok = await crypto.subtle.verify({ name: "Ed25519" }, key, sig, digest);
  } catch (err) {
    return { ok: false, reason: `signature verification error: ${err instanceof Error ? err.message : String(err)}` };
  }
  return ok
    ? { ok: true, reason: "Ed25519 signature verifies over the RFC 8785 canonical payload digest of this JudgementRecord." }
    : { ok: false, reason: "Ed25519 signature does not verify over the payload digest." };
}

// ---------------------------------------------------------------------------
// Binding — recomputed from durable state, never read out of the judgement
// ---------------------------------------------------------------------------

export interface RunBindingFacts {
  runId: string;
  /** The stored RunRecord, exactly as the report will render it. */
  record: unknown;
  /** The sealed revision id the CHECKPOINT carries. null when nothing was sealed. */
  contractRevisionId: string | null;
  contractHash: string | null;
  /** From the run envelope. Mixed-build runs are invalid, so null cannot bind. */
  targetBuildId: string | null;
}

/** sha256:<hex> over the RunRecord with `attestation` omitted — the signed payload scope. */
export async function runRecordPayloadHash(record: unknown): Promise<string> {
  const { attestation: _drop, ...rest } = (record ?? {}) as Record<string, unknown>;
  return `sha256:${await canonicalHash(rest)}`;
}

export async function checkJudgementBinding(
  record: JudgementRecord,
  facts: RunBindingFacts,
): Promise<BindingCheck[]> {
  const b = record.binding ?? ({} as JudgementRecord["binding"]);
  const checks: BindingCheck[] = [];
  const add = (id: string, label: string, ok: boolean, expected: string | null, actual: string | null, detail: string | null) =>
    checks.push({ id, label, ok, expected, actual, detail });

  add(
    "run-id",
    "Run id",
    typeof b.runId === "string" && b.runId === facts.runId,
    facts.runId,
    (b.runId as string) ?? null,
    "A judgement stored under a run must name that run. Without it, one run's bundle copied over another's would render as the second run's results.",
  );

  let expectedPayload: string | null = null;
  try {
    expectedPayload = await runRecordPayloadHash(facts.record);
  } catch (err) {
    add(
      "run-payload-hash",
      "RunRecord payload hash",
      false,
      null,
      b.runRecordPayloadHash ?? null,
      `The stored RunRecord could not be canonicalized: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (expectedPayload !== null) {
    // A JUDGEMENT BINDS TO THE REVISION IT JUDGED, AND A RUN HAS MORE THAN ONE.
    //
    // The judge READS the record and binds to its payload hash, so revision 1 must be signed
    // before the judgement exists and can never contain the judgement's own outcome. Whatever is
    // learned after that — the judgement's result, the test-axis gate — lands in a SUPERSEDING
    // revision, and `record.json` then names that one (`assemble-record.mjs#supersedeRunRecord`).
    //
    // Recomputing the hash of the CURRENT record and demanding the judgement name it would
    // therefore fail every run the moment closure was recorded, and every re-derived column would
    // demote to `unusable`. So a judgement also binds when it names the revision this one
    // supersedes — `originalRecordHash`, which every later revision carries forward, so a chain
    // of any depth still resolves.
    //
    // THIS IS NOT A WEAKENING. Both values come from the run's own signed record, whose
    // attestation covers `recordRevision`; a supersede adds `recordRevision` and `closure` and
    // changes nothing else (asserted by D41); and a judgement naming a hash that appears NOWHERE
    // in this record's chain still fails, which is the case the gate exists for.
    const ancestry = ((facts.record ?? {}) as { recordRevision?: { originalRecordHash?: unknown; supersedes?: { recordHash?: unknown } } })
      .recordRevision;
    const supersededHashes = [ancestry?.originalRecordHash, ancestry?.supersedes?.recordHash].filter(
      (h): h is string => typeof h === "string" && h.length > 0,
    );
    const matchesCurrent = b.runRecordPayloadHash === expectedPayload;
    const matchesSuperseded = supersededHashes.includes(b.runRecordPayloadHash as string);
    add(
      "run-payload-hash",
      "RunRecord payload hash",
      matchesCurrent || matchesSuperseded,
      expectedPayload,
      b.runRecordPayloadHash ?? null,
      matchesSuperseded
        ? "The judgement names the revision this record supersedes, which is the revision the judge could bind to: " +
          "the judgement runs before closure is recorded, so it can only ever have judged an earlier revision."
        : "The judgement must name the exact record it re-read, or a revision the stored record supersedes. " +
          "A mismatch means it judged a different record.",
    );
  }

  add(
    "contract-revision",
    "Sealed contract revision",
    facts.contractRevisionId !== null && b.contractRevisionId === facts.contractRevisionId,
    facts.contractRevisionId,
    b.contractRevisionId ?? null,
    facts.contractRevisionId === null
      ? "This run has no sealed ContractRevision on its checkpoint, so no judgement can be bound to a reviewed denominator."
      : "The judgement must name the sealed revision it judged against.",
  );

  add(
    "target-build",
    "Target build id",
    facts.targetBuildId !== null && b.targetBuildId === facts.targetBuildId,
    facts.targetBuildId,
    b.targetBuildId ?? null,
    facts.targetBuildId === null
      ? "This run recorded no target build id. Mixed-build results are invalid, so a run without a coherent target identity cannot carry current results."
      : "A judgement of a different build can never be this run's current result.",
  );

  let expectedManifest: string | null = null;
  try {
    expectedManifest = evidenceManifestRoot(facts.record);
  } catch (err) {
    add(
      "evidence-manifest",
      "Evidence-manifest root",
      false,
      null,
      b.evidenceManifestRoot ?? null,
      `The evidence manifest could not be computed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (expectedManifest !== null) {
    add(
      "evidence-manifest",
      "Evidence-manifest root",
      b.evidenceManifestRoot === expectedManifest,
      expectedManifest,
      b.evidenceManifestRoot ?? null,
      "A hash over the record's evidence catalogue. A mismatch means the judgement read a different evidence set.",
    );
  }

  // THE THIRD WRITTEN-DOWN DENOMINATOR IDENTITY (D4). The checkpoint and the RunRecord
  // each name the revision hash; a judgement that does not is bound to an id whose bytes
  // nothing re-checked at this layer.
  add(
    "contract-revision-hash",
    "Sealed contract revision hash",
    facts.contractHash !== null && b.contractRevisionHash === facts.contractHash,
    facts.contractHash,
    b.contractRevisionHash ?? null,
    facts.contractHash === null
      ? "This run's checkpoint carries no contract hash, so a judgement cannot be bound to the revision BYTES — only to its id."
      : "A revision id names bytes. The judgement must name the same bytes this run resolved, or it judged a different denominator under the same name.",
  );

  for (const [id, field, label] of [
    ["engine-version", "engineVersion", "Engine version"],
    ["predicate-version", "predicateVersion", "Predicate version"],
    // MANDATORY, not optional (see types/judgement.ts#JudgementBinding). A judgement that
    // does not say which compiler turned requirements into predicates, or which ambiguity
    // policy decided what to withhold, is not reproducible — and an unreproducible
    // judgement can never be a current result.
    ["compiler-version", "compilerVersion", "Compiler version"],
    ["ambiguity-policy-version", "ambiguityPolicyVersion", "Ambiguity policy version"],
  ] as const) {
    const v = b[field];
    add(id, label, typeof v === "string" && v.length > 0, "a non-empty version string", (v as string) ?? null, null);
  }

  return checks;
}

// ---------------------------------------------------------------------------
// The loader the report builder calls
// ---------------------------------------------------------------------------

const absent = (reason: string): JudgementLoad => ({
  state: "absent",
  record: null,
  attestation: { state: "absent", reason },
  problems: [],
  bindingChecks: [],
  summary: "absent",
});

const unusable = (
  problems: JudgementProblem[],
  attestation: JudgementLoad["attestation"],
  bindingChecks: BindingCheck[],
): JudgementLoad => ({
  state: "unusable",
  record: null,
  attestation,
  problems,
  bindingChecks,
  summary: `unusable: ${problems.map((p) => p.code).join(", ") || "unknown"}`,
});

/**
 * Load the run's judgement and decide what it may drive. NEVER throws for a bad document:
 * a malformed judgement is a reportable state, not a reason to fail the report — but it
 * is also never silently absorbed, which is what `readOptionalJson` used to do.
 */
export async function loadJudgement(env: Env, facts: RunBindingFacts): Promise<JudgementLoad> {
  const key = judgementKey(facts.runId);
  const obj = await env.EVIDENCE.get(key);
  if (!obj) {
    return absent(
      "No judgement document exists for this run, so there are no re-derived verdicts. " +
        "The run's own prose verdicts are historical and are not current results.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await obj.text());
  } catch (err) {
    return unusable(
      [{ code: "JUDGEMENT_UNPARSEABLE", message: `The stored judgement at ${key} is not parseable JSON: ${err instanceof Error ? err.message : String(err)}` }],
      { state: "unsigned", reason: "The stored judgement could not be parsed, so nothing about it was verified." },
      [],
    );
  }

  const problems: JudgementProblem[] = [];
  const shapeProblems = validateJudgementRecordShape(parsed);
  problems.push(...shapeProblems);

  const looksLikeRecord = (parsed as { kind?: unknown } | null)?.kind === JUDGEMENT_RECORD_KIND;
  if (!looksLikeRecord) {
    problems.push({
      code: "NO_JUDGEMENT_RECORD",
      message:
        "The stored document is a derived-verdict bundle, not a JudgementRecord. A bundle carries no schema identity, " +
        "no signature and no binding to this run, so nothing in it can be a current result.",
    });
    return unusable(problems, { state: "unsigned", reason: "A derived-verdict bundle carries no attestation block." }, []);
  }

  const record = parsed as JudgementRecord;

  // ATTESTATION. A shape-invalid record is not signature-checked (its attestation block
  // may not even be well formed), but it is still reported as unusable below.
  let attestation: JudgementLoad["attestation"];
  const { registry, reason: registryReason } = parseKeyRegistry(env.JUDGEMENT_KEY_REGISTRY);
  if (!registry) {
    attestation = { state: "unavailable", reason: registryReason };
    problems.push({ code: "JUDGEMENT_SIGNATURE_UNCHECKED", message: registryReason });
  } else if (shapeProblems.some((p) => p.code === "MISSING_ATTESTATION" || p.code === "BAD_ATTESTATION")) {
    attestation = { state: "unsigned", reason: "The judgement's attestation block is missing or malformed." };
  } else {
    const v = await verifyJudgementAttestation(record, registry, { allowFixtureKeys: env.DEV_SEED === "enabled" });
    attestation = { state: v.ok ? "verified" : "invalid", reason: v.reason };
    if (!v.ok) problems.push({ code: "JUDGEMENT_SIGNATURE_INVALID", message: v.reason });
  }

  // BINDING, recomputed from durable state.
  const bindingChecks = await checkJudgementBinding(record, facts);
  for (const c of bindingChecks) {
    if (c.ok) continue;
    problems.push({
      code: "JUDGEMENT_BINDING_FAILED",
      message:
        `${c.label} does not bind: the judgement says ${JSON.stringify(c.actual)} and this run resolves ` +
        `${JSON.stringify(c.expected)}.${c.detail ? ` ${c.detail}` : ""}`,
    });
  }

  if (problems.length > 0) return unusable(problems, attestation, bindingChecks);

  return {
    state: "attested",
    record,
    attestation,
    problems: [],
    bindingChecks,
    summary: `attested by ${record.attestation.keyId}`,
  };
}

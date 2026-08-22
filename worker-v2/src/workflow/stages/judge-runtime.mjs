/**
 * THE JUDGE, RUNNING INSIDE THE WORKER ISOLATE.
 *
 * ========================== WHERE THE JUDGE RUNS, AND WHY ==========================
 *
 * `pipeline/judge/` is dependency-free ESM, but it is not portable-by-accident: three of
 * its modules are bound to SYNCHRONOUS node built-ins.
 *
 *   - `lib/evidence-store.mjs` and `lib/authority.mjs` open the run directory with
 *     `readFileSync` / `existsSync` / `readdirSync` / `statSync` / `realpathSync`;
 *   - `scorer/src/lib/attest.mjs` signs and verifies with node:crypto's SYNCHRONOUS
 *     Ed25519 `sign` / `verify` and `createPrivateKey` / `createPublicKey`.
 *
 * Both were, until recently, reasons to run it out-of-process. They are not any more, and
 * this was PROBED before a line of this file was written rather than assumed:
 *
 *   1. workerd with `nodejs_compat` ships a real, writable, in-isolate `node:fs`.
 *      `mkdirSync` / `writeFileSync` / `readFileSync` (returning a Buffer) / `readdirSync` /
 *      `statSync().isFile()` / `realpathSync` all behave. So the judge can be handed a run
 *      DIRECTORY it recognises, materialized from R2, and it never learns the difference.
 *   2. node:crypto's Ed25519 `sign`/`verify` and `createHash` work in the same isolate:
 *      a 64-byte signature round-tripped and verified.
 *
 * So the judge runs HERE, and that matters for the product: the owner uploads a document
 * and a URL and gets a report, with no second machine in the loop and no step that only a
 * developer can perform. The alternative — a local runner — would have made every run
 * depend on someone's laptop being awake.
 *
 * NOT ONE LINE OF THE TRUST LOGIC IS MODIFIED OR SHIMMED. There is no fake `fs`, no
 * bundler alias, no monkey-patched hash. Every integrity check the judge makes — the
 * SHA-256 of each artifact against the signed catalogue, the Ed25519 attestation on the
 * RunRecord, the re-derivation of the sealed contract-revision id, the checklist binding,
 * the second uncached re-read in `attest()` — runs exactly as it does under node, against
 * the same bytes. What this module does is strictly I/O: pull bytes out of R2, put them
 * where the judge looks, and delete them afterwards.
 *
 * ============================ WHAT IT REFUSES TO DO =============================
 *
 * It never invents a key, a checklist or an artifact. If the run has no signing key the
 * record is unsigned, `authority.signatureVerified` is false, and the judgement is
 * `diagnostic-only` — which is what the report then says. Supplying a key the Worker
 * generated on the spot would turn "nobody attested this" into "something attested this",
 * and that is the one substitution this whole track exists to prevent.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEvidenceAuthority } from "../../../../pipeline/judge/lib/authority.mjs";
import { judgeRun } from "../../../../pipeline/judge/lib/engine.mjs";
import { signRecord } from "../../../../scorer/src/lib/attest.mjs";

/**
 * Where a run is materialized. Per-invocation so two concurrent judgements cannot mix.
 *
 * It MUST live under the runtime's declared temporary directory: workerd's virtual filesystem
 * mounts the root read-only and reports `/tmp` here, while Node reports its OS-specific writable
 * scratch root. Hard-coding the POSIX spelling made Windows interpret it as `<drive>:\tmp`, which
 * is unrelated to Node's configured temp root and can be unwritable even when `tmpdir()` is not.
 */
const MOUNT_ROOT = join(tmpdir(), "v2-judge");

let mountSeq = 0;

/**
 * Materialize a run directory the judge recognises, judge it, then remove it.
 *
 * @param {object}   o
 * @param {string}   o.runId
 * @param {object}   o.checklist        the run's checklist (obligations + ambiguities)
 * @param {object}   o.record           the assembled RunRecordV2 (signed, or not)
 * @param {object}   o.revision         the SEALED ContractRevision the record names
 * @param {Array<{name: string, bytes: Uint8Array}>} o.artifacts  evidence blobs, by the
 *                   BASENAME the record's `evidence[].artifactRef` cites them by
 * @param {object|null} o.keyRegistry   pinned public keys for the RECORD's attestation
 * @param {object|null} o.signer        `{ privateKeyPem, keyId, signedAt }` for the
 *                                      JudgementRecord. Absent ⇒ nothing is signed.
 * @param {object|null} o.priorObservations  diagnostic cross-check only; never an input
 *                                      to a verdict.
 * @param {Map<string,{contentHash:string,byteLength:number}>|null} o.preVerifiedArtifacts
 *                   A3 — MEMORY-SAFE JUDGING: hashes of artifacts that were verified
 *                   upstream and are NOT in the `artifacts` array (not written to tmpdir).
 *                   Passed through to `loadEvidenceAuthority` so the manifest check covers
 *                   the full set without requiring every blob to be on disk.
 */
export function judgeRunInIsolate({
  runId,
  checklist,
  record,
  revision,
  artifacts,
  keyRegistry = null,
  signer = null,
  priorObservations = null,
  preVerifiedArtifacts = null,
}) {
  const runDir = join(MOUNT_ROOT, `${runId}-${mountSeq++}`);
  const artifactsDir = join(runDir, "artifacts");
  const recordPath = join(runDir, "run-record.v2.json");
  const revisionPath = join(runDir, "contract-revision.json");
  const registryPath = join(runDir, "key-registry.json");

  try {
    mkdirSync(artifactsDir, { recursive: true });
    // `checklist.json` is what the judge's CLI contract calls the obligation set, and
    // `loadEvidenceAuthority` is handed the parsed object as well — both are written so
    // the directory is self-describing if it is ever dumped for a human.
    writeFileSync(join(runDir, "checklist.json"), JSON.stringify(checklist), "utf8");
    writeFileSync(recordPath, JSON.stringify(record), "utf8");
    writeFileSync(revisionPath, JSON.stringify(revision), "utf8");
    if (keyRegistry) writeFileSync(registryPath, JSON.stringify(keyRegistry), "utf8");

    // A3 — MEMORY-SAFE MOUNT: only ENGINE-READ artifacts (JSON) are written to tmpdir.
    // The pre-A3 code wrote ALL artifacts to the memory-backed tmpdir, which was the
    // second copy of ~530MB of blobs (9,000 step PNGs + observation JSONs). The third
    // copy happened when authority.mjs readFileSync'd each one back to hash it.
    //
    // Now: the `artifacts` array contains only the engine-read set (JSON files), and
    // `preVerifiedArtifacts` carries the hashes of everything else. The authority's
    // manifest check uses both, so `manifestComplete` is computed over the FULL set.

    // A basename is all the judge resolves by, so two artifacts sharing one is not a
    // cosmetic problem: the second write DESTROYS the first walk's evidence and the run
    // then judges a smaller evidence set without saying so. It used to happen on every v2
    // run, because each walk's artifactRef ended in `observation.json`. Refuse, loudly.
    const written = new Set();
    for (const a of artifacts) {
      // Anything with a separator in it would escape the artifacts directory. The judge's
      // own store re-checks this; refusing here means a malformed catalogue never reaches
      // the filesystem at all.
      const base = String(a.name).split("/").pop();
      if (!base || base === "." || base === ".." || base.includes("\\")) continue;
      if (written.has(base)) {
        throw new Error(
          `two catalogued artifacts both mount as ${base}; a basename is the judge's whole `
          + 'identity for an artifact, so writing the second would silently delete the first',
        );
      }
      written.add(base);
      writeFileSync(join(artifactsDir, base), Buffer.from(a.bytes));
    }

    const authority = loadEvidenceAuthority({
      runDir,
      checklist,
      runRecordPath: recordPath,
      keyRegistryPath: keyRegistry ? registryPath : null,
      contractRevisionPath: revisionPath,
      // A3: pre-verified hashes for artifacts not written to disk.
      preVerifiedArtifacts: preVerifiedArtifacts || null,
    });

    const judged = judgeRun({ runDir, checklist, priorObservations, authority, signer });
    return { judged, authority };
  } finally {
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch {
      // A leaked mount costs isolate memory until the isolate dies; it is not a reason to
      // lose a judgement that was already computed.
    }
  }
}

/**
 * Sign a RunRecordV2 with the run's configured record key, and hand back the PINNED
 * REGISTRY the judge must verify that signature against.
 *
 * The registry is DERIVED from the private key rather than configured separately, which is
 * the honest description of what a self-attesting producer can prove: this record's bytes
 * are the ones this Worker's key signed, and nothing more. It does NOT prove an independent
 * party saw them. The `trust` marker says `producer`, not `production`, for exactly that
 * reason — nothing downstream may read it as third-party review.
 *
 * With no key: the record goes out unsigned and the judge's authority reports
 * `signatureVerified: false`. That is a true statement about a run nobody attested.
 */
export function signRecordWithProducerKey(record, { privateKeyPem, keyId, signedAt }) {
  const attestation = signRecord(record, privateKeyPem, keyId, signedAt);
  return { record: { ...record, attestation }, keyRegistry: publicRegistryFor(privateKeyPem, keyId) };
}

/** The pinned registry for a private key, derived from the key itself. */
export function publicRegistryFor(privateKeyPem, keyId) {
  const publicKeyPem = createPublicKey(createPrivateKey(privateKeyPem))
    .export({ type: "spki", format: "pem" })
    .toString();
  return {
    note: "derived from the producer signing key; proves record integrity, not third-party review",
    keys: { [keyId]: { publicKeyPem, trust: "producer" } },
  };
}

/** True when a PEM string is a usable Ed25519 private key. Cheap, and fails closed. */
export function usablePrivateKey(pem) {
  if (typeof pem !== "string" || !pem.includes("PRIVATE KEY")) return false;
  try {
    createPrivateKey(pem);
    return true;
  } catch {
    return false;
  }
}

export const judgeMountExists = (runId) => existsSync(join(MOUNT_ROOT, runId));

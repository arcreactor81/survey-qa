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
 * THE TRUST CHECKS ARE UNCHANGED AND NOW ENUMERATED:
 *   1. Signed-manifest membership: the artifact name must be in the Ed25519-attested
 *      RunRecord's evidence catalogue BEFORE any bytes are fetched.
 *   2. Hash-at-read: fetched bytes are SHA-256'd and compared against the SIGNED
 *      contentHash from the catalogue. A mismatch raises EvidenceIntegrityError.
 *   3. Fresh attest re-fetch: attest() re-fetches bytes through the source (fresh,
 *      never from the main cache) and re-hashes against the signed catalogue.
 *
 * The bytes arrive through an INJECTED SOURCE instead of a materialized directory because
 * a 128 MB isolate cannot hold a 112.8 MB run twice. The source is dumb transport:
 * name -> catalogue entry -> evidenceBlobKey(contentHash) -> R2 bucket get -> bytes.
 * The store does all verification.
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
 * A3b: ASYNC. The judge engine is fully async now — the store fetches artifact
 * bytes through an injected source rather than reading them from a materialized
 * directory. No artifacts directory is created. No artifact blobs are written to
 * the memory-backed tmpdir. Only the metadata files (checklist, record, revision,
 * registry) are materialized.
 *
 * @param {object}   o
 * @param {string}   o.runId
 * @param {object}   o.checklist        the run's checklist (obligations + ambiguities)
 * @param {object}   o.record           the assembled RunRecordV2 (signed, or not)
 * @param {object}   o.revision         the SEALED ContractRevision the record names
 * @param {Map<string,{contentHash:string,byteLength:number}>} o.catalogueDescriptors
 *                   Names and catalogue-level metadata for every evidence entry. The
 *                   authority uses these so manifestComplete covers the full set. The
 *                   engine reads actual bytes through the injected source.
 * @param {{names():string[],fetch(name:string):Promise<Uint8Array|null>}} o.source
 *                   The async byte source the engine reads artifacts through. For the
 *                   Worker this is the R2-backed source; for tests it may be a memory
 *                   map.
 * @param {object|null} o.keyRegistry   pinned public keys for the RECORD's attestation
 * @param {object|null} o.signer        `{ privateKeyPem, keyId, signedAt }` for the
 *                                      JudgementRecord. Absent means nothing is signed.
 * @param {object|null} o.priorObservations  diagnostic cross-check only; never an input
 *                                      to a verdict.
 */
export async function judgeRunInIsolate({
  runId,
  checklist,
  record,
  revision,
  catalogueDescriptors,
  source,
  keyRegistry = null,
  signer = null,
  priorObservations = null,
}) {
  const runDir = join(MOUNT_ROOT, `${runId}-${mountSeq++}`);
  const recordPath = join(runDir, "run-record.v2.json");
  const revisionPath = join(runDir, "contract-revision.json");
  const registryPath = join(runDir, "key-registry.json");
  // A3b: create the artifacts directory as an EMPTY directory. The authority's
  // manifest check uses catalogueDescriptors (passed as preVerifiedArtifacts)
  // instead of reading from disk, so no blobs need to be on disk. The empty
  // directory satisfies existsSync checks in authority.mjs.
  const artifactsDir = join(runDir, "artifacts");

  try {
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(runDir, "checklist.json"), JSON.stringify(checklist), "utf8");
    writeFileSync(recordPath, JSON.stringify(record), "utf8");
    writeFileSync(revisionPath, JSON.stringify(revision), "utf8");
    if (keyRegistry) writeFileSync(registryPath, JSON.stringify(keyRegistry), "utf8");

    // A3b: ALL catalogue entries become preVerifiedArtifacts for the authority.
    // The authority validates the manifest against this map. The engine then
    // verifies actual bytes at read time through the injected source.
    const authority = loadEvidenceAuthority({
      runDir,
      checklist,
      runRecordPath: recordPath,
      keyRegistryPath: keyRegistry ? registryPath : null,
      contractRevisionPath: revisionPath,
      preVerifiedArtifacts: catalogueDescriptors,
    });

    const judged = await judgeRun({ runDir, checklist, priorObservations, authority, signer, source });
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

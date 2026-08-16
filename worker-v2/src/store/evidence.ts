/**
 * CONTENT-ADDRESSED EVIDENCE.
 *
 * The blob is keyed by the sha-256 of its own bytes, so:
 *   - the same screenshot witnessing four obligations is stored once;
 *   - "verify stored bytes against contentHash" (§7.5 step 2) is not an extra field to
 *     keep in sync, it is a re-hash of what was fetched;
 *   - a corrupted or substituted object is detectable, and the endpoint FAILS CLOSED
 *     rather than rendering it (§7.5 step 6).
 *
 * The per-run CATALOG entry is a separate small object holding the metadata and the
 * witness list. That indirection is what makes retention reference-aware: an evidence
 * blob may outlive the run that first captured it because another run still cites it.
 */

import type { Env } from "../types/env";
import type { EvidenceCatalogEntry } from "../types/record";
import { evidenceBlobKey, evidenceCatalogKey, evidenceCatalogPrefix } from "../keys";
import { assertV2RunId, evidenceIdFor } from "../ids";
import { sha256Hex } from "./hash";

export class EvidenceIntegrityFailure extends Error {
  constructor(evidenceId: string, expected: string, actual: string) {
    super(
      `evidence ${evidenceId} failed integrity check: catalog declares sha256 ${expected}, stored bytes hash to ${actual}. ` +
        `Refusing to serve possibly-corrupted evidence.`,
    );
    this.name = "EvidenceIntegrityFailure";
  }
}

/**
 * The catalogue entry does not describe the blob its own id names.
 *
 * THE ATTACK THIS CLOSES. Re-hashing on read proves that the bytes at
 * `evidence/sha256/<h>` hash to `<h>` — which is a tautology, not a check — and that they
 * match `entry.contentHash`. But `entry.contentHash` lived in a MUTABLE per-run object.
 * Repoint one evidence id from signed hash A to a different, perfectly valid CAS blob B
 * and every downstream check still passes: the bytes agree with the modified catalogue,
 * so the citation in the signed record now resolves to an artifact it never named. The
 * cited proof changes and nothing fails closed.
 *
 * Two changes make that unrepresentable rather than merely detectable: the evidence id is
 * DERIVED from (runId, sourceEvidenceId, contentHash), so an entry that points somewhere
 * else no longer matches its own id; and the catalogue object is written ONCE, so the
 * repoint cannot be performed through this module at all.
 */
export class EvidenceCatalogTampered extends Error {
  constructor(runId: string, evidenceId: string, expectedId: string) {
    super(
      `evidence catalogue entry ${evidenceId} in run ${runId} does not match its own citation binding ` +
        `(its metadata derives id ${expectedId}). The mapping from evidence id to content hash is immutable and ` +
        `content-derived; this entry has been altered. Refusing to serve it.`,
    );
    this.name = "EvidenceCatalogTampered";
  }
}

export class EvidenceCatalogImmutable extends Error {
  constructor(runId: string, evidenceId: string) {
    super(
      `refusing to rewrite evidence catalogue entry ${evidenceId} in run ${runId}: per-run evidence mappings are ` +
        `write-once. A second entry under the same id would silently repoint a signed citation.`,
    );
    this.name = "EvidenceCatalogImmutable";
  }
}

export interface PutEvidenceInput {
  runId: string;
  bytes: ArrayBuffer | Uint8Array;
  mediaType: string;
  type: EvidenceCatalogEntry["type"];
  attemptId?: string | null;
  routeId?: string | null;
  witnesses?: string[];
  /** Record-side evidence id, when the RunRecord names this blob differently. */
  sourceEvidenceId?: string | null;
  /** The path the RunRecord cites this blob by. The offline judge resolves by its basename. */
  artifactRef?: string | null;
}

/**
 * Store bytes (deduped) + write the run's catalog entry. Returns the catalog entry.
 * The blob write is conditional on absence, so re-capturing identical bytes costs a
 * HEAD-shaped no-op rather than an overwrite.
 */
export async function putEvidence(env: Env, input: PutEvidenceInput): Promise<EvidenceCatalogEntry> {
  assertV2RunId(input.runId);
  const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
  const contentHash = await sha256Hex(bytes);
  const blobKey = evidenceBlobKey(contentHash);

  const existing = await env.EVIDENCE.head(blobKey);
  if (!existing) {
    // Content-addressed: if two writers race, they are writing identical bytes.
    await env.EVIDENCE.put(blobKey, bytes, {
      httpMetadata: { contentType: input.mediaType },
    });
  }

  // THE ID IS DERIVED FROM THE CITATION, NOT MINTED AT RANDOM. `ev_<12>` used to be
  // entropy, so the id said nothing about what it pointed at and the pointer could be
  // moved. Deriving it from (runId, sourceEvidenceId, contentHash) makes "this id names
  // these bytes for this citation in this run" checkable by anyone holding the entry.
  const evidenceId = await evidenceIdFor(
    input.runId,
    input.sourceEvidenceId ?? null,
    contentHash,
    input.artifactRef ?? null,
  );

  const entry: EvidenceCatalogEntry = {
    evidenceId,
    sourceEvidenceId: input.sourceEvidenceId ?? null,
    artifactRef: input.artifactRef ?? null,
    contentHash,
    mediaType: input.mediaType,
    size: bytes.byteLength,
    type: input.type,
    capturedAt: new Date().toISOString(),
    attemptId: input.attemptId ?? null,
    routeId: input.routeId ?? null,
    witnesses: input.witnesses ?? [],
  };

  // WRITE-ONCE. Re-capturing the identical citation of identical bytes is a no-op (the id
  // is the same, and only `capturedAt` would differ); anything else attempting to reuse
  // the id is a repoint, and it fails here rather than downstream where it would look
  // like a successful integrity check.
  const written = await env.EVIDENCE.put(evidenceCatalogKey(input.runId, evidenceId), JSON.stringify(entry), {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written === null) {
    const existing = await getCatalogEntry(env, input.runId, evidenceId);
    if (!existing) throw new EvidenceCatalogImmutable(input.runId, evidenceId);
    if (
      existing.contentHash !== contentHash ||
      (existing.sourceEvidenceId ?? null) !== (input.sourceEvidenceId ?? null) ||
      (existing.artifactRef ?? null) !== (input.artifactRef ?? null)
    ) {
      throw new EvidenceCatalogImmutable(input.runId, evidenceId);
    }
    return existing;
  }
  return entry;
}

/** Recompute the citation binding. An entry that fails this is not served, ever. */
export async function assertCatalogBinding(runId: string, entry: EvidenceCatalogEntry): Promise<EvidenceCatalogEntry> {
  const expected = await evidenceIdFor(
    runId,
    entry.sourceEvidenceId ?? null,
    entry.contentHash,
    entry.artifactRef ?? null,
  );
  if (expected !== entry.evidenceId) throw new EvidenceCatalogTampered(runId, entry.evidenceId, expected);
  return entry;
}

export async function getCatalogEntry(env: Env, runId: string, evidenceId: string): Promise<EvidenceCatalogEntry | null> {
  assertV2RunId(runId);
  if (!/^ev_[0-9a-hjkmnp-tv-z]{12}$/.test(evidenceId)) return null;
  const obj = await env.EVIDENCE.get(evidenceCatalogKey(runId, evidenceId));
  if (!obj) return null;
  return JSON.parse(await obj.text()) as EvidenceCatalogEntry;
}

/** The read path every SERVING caller uses: parsed, then bound, then returned. */
export async function getBoundCatalogEntry(
  env: Env,
  runId: string,
  evidenceId: string,
): Promise<EvidenceCatalogEntry | null> {
  const entry = await getCatalogEntry(env, runId, evidenceId);
  if (!entry) return null;
  return assertCatalogBinding(runId, entry);
}

export async function listCatalog(env: Env, runId: string): Promise<EvidenceCatalogEntry[]> {
  assertV2RunId(runId);
  const out: EvidenceCatalogEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.EVIDENCE.list({ prefix: evidenceCatalogPrefix(runId), cursor, limit: 1000 });
    for (const obj of page.objects) {
      const body = await env.EVIDENCE.get(obj.key);
      if (body) out.push(await assertCatalogBinding(runId, JSON.parse(await body.text()) as EvidenceCatalogEntry));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/**
 * Fetch + VERIFY. Never returns unverified bytes: the caller cannot forget the check
 * because there is no code path that skips it.
 */
export async function getVerifiedEvidence(
  env: Env,
  entry: EvidenceCatalogEntry,
): Promise<{ bytes: Uint8Array; entry: EvidenceCatalogEntry }> {
  const obj = await env.EVIDENCE.get(evidenceBlobKey(entry.contentHash));
  if (!obj) throw new EvidenceIntegrityFailure(entry.evidenceId, entry.contentHash, "<missing>");
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const actual = await sha256Hex(bytes);
  if (actual !== entry.contentHash) throw new EvidenceIntegrityFailure(entry.evidenceId, entry.contentHash, actual);
  return { bytes, entry };
}

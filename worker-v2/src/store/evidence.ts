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
import { evidenceBlobKey, evidenceCatalogKey, evidenceCatalogPrefix, catalogListingKey, captureRefGuardKey } from "../keys";
import { assertV2RunId, evidenceIdFor } from "../ids";
import { sha256Hex } from "./hash";
import { mapConcurrent, R2_READ_CONCURRENCY } from "./concurrent-pool";

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

  // REF GUARD — a re-execution of the same Workflow step must not create a second catalogue
  // entry for the same (sourceEvidenceId, artifactRef) pair with different bytes.
  //
  // The step retry replays the SAME attemptId and ordinals, so the capture's observationRef
  // names repeat by construction. Without this guard, the catalogue carries two entries for
  // the same ref, the collision check fires, and the run mints no judgement.
  //
  // The guard records which evidenceId first claimed each (sourceEvidenceId, artifactRef)
  // pair. A subsequent capture at the same pair with different bytes finds the guard and
  // returns the ORIGINAL entry — the capture is idempotent at the ref level. A capture with
  // IDENTICAL bytes produces the same evidenceId and lands on the existing catalogue entry's
  // write-once guard below, which is already idempotent.
  //
  // COST: one conditional PUT per capture (typically a no-op on first execution since the
  // guard does not exist yet). On a re-execution, one GET to read the original evidenceId
  // plus one GET for the original catalogue entry.
  if (input.sourceEvidenceId && input.artifactRef) {
    const guardInput = `${input.sourceEvidenceId}\0${input.artifactRef}`;
    const guardHash = await sha256Hex(guardInput);
    const guardKey = captureRefGuardKey(input.runId, guardHash);
    // Try to claim this ref. The onlyIf guard makes the first writer win.
    const guardPayload = JSON.stringify({ evidenceId: "__pending__", contentHash });
    const guardWritten = await env.EVIDENCE.put(guardKey, guardPayload, {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (guardWritten === null) {
      // Guard already exists — a previous capture claimed this ref.
      const existingGuard = await env.EVIDENCE.get(guardKey);
      if (existingGuard) {
        const guard = JSON.parse(await existingGuard.text()) as { evidenceId: string; contentHash: string };
        if (guard.contentHash !== contentHash) {
          // Different bytes at the same ref: return the original entry without creating a
          // new catalogue row. The new bytes are NOT written to the CAS — no orphaned blob.
          const original = await getCatalogEntry(env, input.runId, guard.evidenceId);
          if (original) return original;
          // Guard points to an entry that no longer exists — fall through to normal write.
        }
        // Same contentHash: same bytes, same evidenceId — fall through to the write-once
        // catalogue guard below, which handles this idempotently.
      }
    }
  }

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

  // Update the ref guard with the REAL evidenceId now that the catalogue entry is committed.
  // The guard was written with "__pending__" before the evidenceId was known. This overwrites
  // the pending guard unconditionally — only the first writer reaches this point, so the
  // overwrite is safe.
  if (input.sourceEvidenceId && input.artifactRef) {
    const guardInput = `${input.sourceEvidenceId}\0${input.artifactRef}`;
    const guardHash = await sha256Hex(guardInput);
    const guardKey = captureRefGuardKey(input.runId, guardHash);
    await env.EVIDENCE.put(guardKey, JSON.stringify({ evidenceId, contentHash }), {
      httpMetadata: { contentType: "application/json" },
    });
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

/**
 * BOUNDED-CONCURRENT CATALOGUE LISTING.
 *
 * The listing is an R2 LIST (paginated) followed by one R2 GET per entry. The GETs are
 * I/O-bound and independent, so they overlap at R2_READ_CONCURRENCY. The LIST itself is
 * sequential (cursor-chained) but typically exhausts in 1-10 pages of 1 000.
 *
 * SUBREQUEST BUDGET: one LIST per page (ceil(N/1000)) + one GET per entry (N). For a
 * 9 340-entry catalogue that is ~10 + 9 340 ≈ 9 350 subrequests, well within the
 * wrangler.jsonc ceiling of 100 000. Concurrency does not increase the COUNT — it
 * overlaps the I/O wait.
 */
export async function listCatalog(env: Env, runId: string): Promise<EvidenceCatalogEntry[]> {
  assertV2RunId(runId);

  // Phase 1: collect all keys (LIST is cursor-chained, must be sequential).
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.EVIDENCE.list({ prefix: evidenceCatalogPrefix(runId), cursor, limit: 1000 });
    for (const obj of page.objects) keys.push(obj.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // Phase 2: fetch + bind entries at bounded concurrency.
  // mapConcurrent preserves input order (contract §1) and propagates the first failure
  // (contract §3), so a tampered entry still fails the whole listing loudly.
  const entries = await mapConcurrent(keys, R2_READ_CONCURRENCY, async (key) => {
    const body = await env.EVIDENCE.get(key);
    if (!body) return null;
    return assertCatalogBinding(runId, JSON.parse(await body.text()) as EvidenceCatalogEntry);
  });
  return entries.filter((e): e is EvidenceCatalogEntry => e !== null);
}

/**
 * CATALOG LISTING VERSION — increment when `assertCatalogBinding` or the entry schema
 * changes. Any materialised listing at a different version is silently ignored, forcing a
 * live re-list that applies the new binding logic.
 */
const CATALOG_LISTING_VERSION = 1;

interface PersistedCatalogListing {
  version: typeof CATALOG_LISTING_VERSION;
  entries: EvidenceCatalogEntry[];
  materializedAt: string;
}

/**
 * PERSIST THE CATALOGUE LISTING so subsequent tail stages pay one R2 GET instead of a
 * full fan-out.
 *
 * THE CONSISTENCY ASSUMPTION (stated, not silent): the catalogue is APPEND-ONLY after
 * execution closes. Captures happen during the execute-batch steps; by the time the first
 * tail stage materialises this listing, no new captures can arrive because the execution
 * cursor is exhausted and the Workflow has moved past the batch loop. A second execution
 * (recovery instance) would re-list from scratch because the listing's version key
 * includes the run id — and the recovery instance starts a new workflow, not a new step
 * inside this one.
 */
export async function persistCatalogListing(
  env: Env,
  runId: string,
  entries: EvidenceCatalogEntry[],
): Promise<void> {
  const payload: PersistedCatalogListing = {
    version: CATALOG_LISTING_VERSION,
    entries,
    materializedAt: new Date().toISOString(),
  };
  await env.EVIDENCE.put(catalogListingKey(runId), JSON.stringify(payload), {
    httpMetadata: { contentType: "application/json" },
  });
}

/**
 * READ A PREVIOUSLY MATERIALISED CATALOGUE LISTING.
 *
 * Returns null when:
 *   - no materialised listing exists (old runs, bench replay, first tail stage),
 *   - the listing is at a different version (code changed since materialisation),
 *   - the listing fails to parse (corrupt object).
 *
 * In ALL three cases the caller falls through to the live `listCatalog` path. The
 * materialised listing is a PERFORMANCE CACHE, not a source of truth — the truth is
 * always the individual per-entry objects that `listCatalog` reads and re-binds.
 */
export async function loadCachedCatalogListing(
  env: Env,
  runId: string,
): Promise<EvidenceCatalogEntry[] | null> {
  try {
    const obj = await env.EVIDENCE.get(catalogListingKey(runId));
    if (!obj) return null;
    const parsed = JSON.parse(await obj.text()) as PersistedCatalogListing;
    if (parsed.version !== CATALOG_LISTING_VERSION) return null;
    if (!Array.isArray(parsed.entries)) return null;
    return parsed.entries;
  } catch {
    return null;
  }
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

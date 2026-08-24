/**
 * EVERYTHING THE JUDGING STAGES READ, LOADED ONCE, FROM THE RUN'S OWN DURABLE STATE.
 *
 * Three stages need overlapping slices of the same run: the aggregator needs the sealed
 * revision and the observations, the assembler needs those plus the envelope and the
 * evidence catalogue, and the judge needs all of it plus the artifact BYTES. Loading them
 * separately in each stage would let two stages disagree about which revision the run
 * sealed — which is the disagreement `report/build.ts` already refuses to render over.
 *
 * The evidence bytes come back through `getVerifiedEvidence`, so every artifact handed to
 * the judge has already been re-hashed against the catalogue entry that names it. The judge
 * then hashes them AGAIN, against the SIGNED manifest in the record. That is not redundant:
 * the first check says storage did not corrupt the blob, the second says the blob is the one
 * the record committed to. They are different claims and both are wanted.
 */

import type { Env } from "../../types/env";
import { observationsKey } from "../../keys";
import { getEnvelope } from "../../store/envelope";
import { loadCheckpoint } from "../../store/checkpoint";
import { getContractRevision } from "../../store/contract-revision";
import {
  EvidenceCatalogTampered,
  EvidenceIntegrityFailure,
  getVerifiedEvidence,
  listCatalog,
  loadCachedCatalogListing,
  persistCatalogListing,
} from "../../store/evidence";
import { retryRecencyOrder } from "../../store/committed-evidence";
import { evidenceBlobKey } from "../../keys";
import { sha256Hex } from "../../store/hash";
import { mapConcurrent, R2_READ_CONCURRENCY } from "../../store/concurrent-pool";
import type { ContractRevision, EvidenceCatalogEntry, Observation, RunEnvelopeV2 } from "../../types/record";
import type { RunCheckpoint } from "../../types/contracts";

export interface RunInputs {
  runId: string;
  envelope: RunEnvelopeV2 | null;
  checkpoint: RunCheckpoint | null;
  revision: ContractRevision | null;
  contractHash: string | null;
  observations: Observation[];
  evidence: EvidenceCatalogEntry[];
}

/** A reason the stage cannot proceed, phrased as the sentence the report will print. */
export type InputProblem = string;

/**
 * WHETHER TO PAY FOR THE CATALOGUE.
 *
 * `listCatalog` is the most expensive thing this loader does by an order of magnitude: one
 * R2 LIST plus one R2 GET **per catalogue entry**, and a real run catalogues one entry per
 * screen read and per screenshot of every walk (1,707 for
 * v2r_01kzfb6py8pbxznqv022p2qkhb). A Worker invocation has a bounded subrequest budget and
 * Workflow steps SHARE it, so a stage that loads the catalogue it does not need is not
 * merely slow — it spends budget the stages after it still need.
 *
 * `catalog: false` therefore exists for the stages that only ever look artifacts up BY ID
 * (`getBoundCatalogEntry` is the keyed read, and it runs the same binding assertion
 * `listCatalog` runs). Stages that genuinely need the whole set — the assembler's signed
 * manifest, the judge's evidence mount — must keep the default and pay for it.
 *
 * It defaults to TRUE so that adding this option changed no existing caller's behaviour.
 */
export interface LoadRunInputsOptions {
  /** Load the full evidence catalogue. Default true; false yields `evidence: []`. */
  catalog?: boolean;
}

export async function loadRunInputs(
  env: Env,
  runId: string,
  opts: LoadRunInputsOptions = {},
): Promise<RunInputs> {
  const loaded = await loadCheckpoint(env, runId);
  const checkpoint = loaded?.checkpoint ?? null;
  const envelope = await getEnvelope(env, runId).catch(() => null);

  const contractRevisionId = checkpoint?.contract.contractRevisionId ?? envelope?.contractRevisionId ?? null;
  const contractHash = checkpoint?.contract.contractHash ?? null;
  const revision = contractRevisionId
    ? await getContractRevision(env, contractRevisionId, { contractHash })
    : null;

  // EVIDENCE CATALOGUE LOADING STRATEGY — three tiers, cheapest first.
  //
  // 1. `catalog: false` → `[]`. The caller does not need the catalogue at all. The
  //    aggregator (`deriveItemResults`) uses this: its job is arithmetic over 16
  //    observations and a sealed revision, and loading 9,340 catalogue entries cost
  //    19 minutes across three attempts on the real v100 run (bench-measured 22 Aug).
  //
  // 2. SHARED LISTING → one R2 GET. The first tail stage that lists the catalogue
  //    persists the result under `catalogListingKey(runId)`. Subsequent stages read
  //    that single object instead of the full fan-out.
  //    THE CONSISTENCY ASSUMPTION (stated, not silent): the catalogue is APPEND-ONLY
  //    after execution closes. No new captures can arrive because the Workflow has
  //    moved past the batch loop by the time any tail stage runs.
  //
  // 3. LIVE LIST → the full fan-out. First tail stage on a fresh run, or old runs /
  //    bench replays where no materialised listing exists. The first stage that pays
  //    this cost persists the result so the next stage hits tier 2.
  let evidence: EvidenceCatalogEntry[];
  if (opts.catalog === false) {
    // EMPTY BECAUSE IT WAS NOT ASKED FOR — NOT BECAUSE THE RUN HAS NO EVIDENCE. Any
    // caller that reads `evidence` must therefore not pass `catalog: false`.
    evidence = [];
  } else {
    const cached = await loadCachedCatalogListing(env, runId);
    if (cached) {
      evidence = cached;
    } else {
      evidence = await listCatalog(env, runId);
      // Persist for the stages that follow. Fire-and-forget: a failed persist means
      // the next stage re-lists, which is the same cost as before this optimisation.
      await persistCatalogListing(env, runId, evidence).catch(() => {});
    }
  }

  return {
    runId,
    envelope,
    checkpoint,
    revision,
    contractHash,
    observations: await readObservations(env, runId),
    evidence,
  };
}

/**
 * The observations the execution stage committed.
 *
 * ABSENT IS EMPTY, AND EMPTY IS NOT AN ERROR — it is a run that observed nothing, which the
 * aggregator turns into `pending` cases and `incomplete` requirements. An unparseable
 * observations document IS an error, because silently reading it as "no observations" would
 * turn a corrupt file into a clean-looking incomplete run.
 */
async function readObservations(env: Env, runId: string): Promise<Observation[]> {
  const obj = await env.EVIDENCE.get(observationsKey(runId));
  if (!obj) return [];
  const text = await obj.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `the observations document for ${runId} is not parseable JSON (${err instanceof Error ? err.message : String(err)}); ` +
        `refusing to read a corrupt file as "this run observed nothing"`,
    );
  }
  if (Array.isArray(parsed)) return parsed as Observation[];
  const inner = (parsed as { observations?: unknown }).observations;
  return Array.isArray(inner) ? (inner as Observation[]) : [];
}

/**
 * Fetch every catalogued artifact's bytes, keyed by the basename the record cites.
 *
 * THE BASENAME IS THE IDENTITY, SO TWO ARTIFACTS MAY NOT SHARE ONE.
 *
 * `pipeline/judge/lib/authority.mjs` builds the signed allowlist with the same
 * `basename(artifactRef)` rule, so a colliding pair is not merely a mount problem — it
 * raises MANIFEST_DUPLICATE_ARTIFACT, clears `manifestComplete`, and leaves the authority
 * unverified, which means the run mints no judgement and the report shows no current
 * results. This loop used to hand the collision downstream in silence and let the mount
 * overwrite one walk's evidence with another's.
 *
 * `capture.ts` now emits unique basenames, so this is a guard against regression rather
 * than the primary fix. It is a REFUSAL and not a rename: renaming here would desynchronise
 * the mount from the signed catalogue, which names artifacts by the ref the record carries.
 */
/**
 * HOW MANY COLLISION PAIRS TO PRINT IN THE ERROR MESSAGE.
 *
 * The old constructor enumerated EVERY pair, which at 588 collisions produced a ~120KB
 * message. Workflow step state has a 1 MiB platform cap, and step outputs carry this
 * message as the `detail` field of a `stageNotEvaluated` result. Truncating to the
 * first 10 + a count preserves diagnosability without risking the cap.
 */
const COLLISION_SAMPLE_SIZE = 10;

export class ArtifactNameCollision extends Error {
  readonly collisions: Array<{ name: string; refs: string[] }>;
  readonly totalCollisions: number;

  constructor(collisions: Array<{ name: string; refs: string[] }>) {
    const total = collisions.length;
    const sample = collisions.slice(0, COLLISION_SAMPLE_SIZE);
    const sampleText = sample
      .map((c) => `${c.name} <- ${c.refs.join(", ")}`)
      .join(" | ");
    const truncationNote =
      total > COLLISION_SAMPLE_SIZE
        ? ` (showing ${COLLISION_SAMPLE_SIZE} of ${total}; ${total - COLLISION_SAMPLE_SIZE} more omitted)`
        : "";
    super(
      `the evidence catalogue names ${total} artifact(s) ambiguously: ` +
        sampleText +
        truncationNote +
        `. A basename is the judge's whole identity for an artifact, so this would both ` +
        `overwrite evidence on the mount and duplicate entries in the signed manifest.`,
    );
    this.name = "ArtifactNameCollision";
    this.collisions = collisions;
    this.totalCollisions = total;
  }
}

/**
 * A SINGLE EVIDENCE ENTRY THAT COULD NOT BE LOADED, NAMED SO THE REPORT CAN SAY WHICH.
 *
 * Tamper signals (`EvidenceCatalogTampered`) are NOT demoted — they represent a security
 * boundary violation and must stay loud. Everything else — missing blobs, hash mismatches,
 * transient R2 failures — becomes a per-item limitation. The caller carries these into the
 * judgement/report so a reader can see "4 of 1 707 artifacts could not be read" instead
 * of the whole run dying at its last step.
 */
export interface EvidenceLimitation {
  /** The basename the record would have mounted this artifact under. */
  name: string;
  /** The evidence id from the catalogue. */
  evidenceId: string;
  /** A one-sentence explanation of why the entry could not be loaded. */
  reason: string;
}

export interface LoadArtifactBytesResult {
  artifacts: Array<{ name: string; bytes: Uint8Array }>;
  /** How many duplicate catalogue rows were collapsed (retried steps record their captures twice). */
  duplicatesCollapsed: number;
  /**
   * HOW MANY CATALOGUE ROWS WERE SUPERSEDED BY A LIVE RECORDING.
   *
   * A retried Workflow step re-captures the same screens, so the catalogue may carry two
   * entries with the same (basename, artifactRef) but DIFFERENT contentHash values. v100's
   * dedupe only collapses identical triples. These entries differ in contentHash, so both
   * survive dedupe and the collision check fires.
   *
   * Resolution: fetch the stored blob for each competing contentHash, hash it, and keep
   * the entry whose hash matches — that is the LIVE recording. The rest are superseded
   * recordings of retried steps: their bytes may still exist in the CAS but the catalogue
   * row no longer names them for judging.
   *
   * null when no superseded recordings were found. Absence of this field is distinguishable
   * from zero: null means the resolution pass was never needed, 0 would mean it ran and
   * found nothing (which is a different fact about the catalogue's shape).
   */
  supersededRecordings: number | null;
  /**
   * Surfaced on MintedJudgement alongside duplicatesCollapsed. null when no superseded
   * recordings exist, so the report can distinguish "no retries" from "zero superseded."
   */
  supersededNote: string | null;
  /**
   * EVIDENCE ENTRIES THAT COULD NOT BE LOADED — named limitations, not silent drops.
   *
   * ABSENCE vs ZERO: an empty array means every entry loaded successfully; the array is
   * always present so a reader never has to guess whether limitations were checked.
   * Tamper signals (`EvidenceCatalogTampered`) are NEVER demoted to a limitation — they
   * propagate as thrown errors because they represent a security boundary violation.
   */
  limitations: EvidenceLimitation[];
}

/**
 * A3 — MEMORY-SAFE JUDGING: pre-verified artifact hash.
 *
 * An artifact whose bytes were fetched, hashed, verified against the catalogue, and RELEASED.
 * The authority uses these to verify the manifest without requiring every blob to be written
 * to the memory-backed tmpdir. Only the "engine-read" set (JSON files the judge's engine
 * actually opens) goes to disk; everything else is hash-verified from memory and released.
 *
 * `contentHash` uses the `sha256:hex` format (with algorithm prefix) because the authority's
 * manifest entries use that format — `shared/v2-record.mjs#legacyEvidenceEntry` adds the
 * prefix when projecting to the legacy shape the authority reads.
 */
export interface PreVerifiedArtifact {
  /** The content hash with algorithm prefix (`sha256:hex`), matching the authority's manifest format. */
  contentHash: string;
  /** Byte length of the verified blob. */
  byteLength: number;
}

/** Ensure a content hash carries the `sha256:` prefix the authority's manifest uses. */
function withSha256Prefix(hash: string): string {
  return hash.startsWith("sha256:") ? hash : `sha256:${hash}`;
}

/**
 * A3 — MEMORY-SAFE RESULT: the streaming loader's output splits artifacts into two sets.
 *
 * `engineRead`: JSON artifacts the judge's engine will read from disk (sessions, probes).
 *   These are written to the mount tmpdir. Measured: observation JSONs are 3-12MB each,
 *   and a run has ~10-20 of them — well within the 128MB isolate.
 *
 * `preVerifiedHashes`: every OTHER artifact (PNGs, PDFs, accessibility JSONs per step) was
 *   hash-verified in memory and released. The authority uses this map so that
 *   `manifestComplete` is set correctly without requiring ~9,000 step artifacts on disk.
 *
 * WHY THIS SPLIT IS SAFE. The engine reads artifacts through `EvidenceStore.read()`, which
 * calls `readFileSync` from the artifacts directory. `loadSessions` iterates all JSON files
 * and only keeps PRIMARY_SESSION artifacts; `attest()` re-reads specific named artifacts.
 * Non-JSON files (PNGs) are classified as IMAGE by `classifyArtifact` and refused by
 * `attest()` as non-primary evidence. So the engine never opens a non-JSON file for
 * anything beyond hash verification — which the authority already does up front.
 */
/**
 * A3b — ENGINE-READ DESCRIPTOR.
 *
 * An engine-read artifact contributes only its catalogue-level metadata to the
 * loader's output. The actual bytes are fetched on demand through the R2-backed
 * source the engine's EvidenceStore is given. This descriptor carries enough
 * information for the authority's manifest check (contentHash, byteLength) and
 * for constructing the R2-backed source (the catalogue entry itself).
 */
export interface EngineReadDescriptor {
  name: string;
  contentHash: string;
  byteLength: number;
  entry: EvidenceCatalogEntry;
}

export interface StreamingArtifactResult extends Omit<LoadArtifactBytesResult, "artifacts"> {
  /**
   * A3b — descriptors for engine-read artifacts (sessions, probes).
   * NO BYTES: the engine fetches them through its async source at read time.
   * The descriptors carry catalogue metadata for the authority's manifest check.
   */
  engineRead: EngineReadDescriptor[];
  /** Hash-verified but not retained in memory — PNGs, PDFs, etc. */
  preVerifiedHashes: Map<string, PreVerifiedArtifact>;
  /** Total artifacts verified (engineRead + preVerifiedHashes + limitations). */
  totalVerified: number;
  /** Peak simultaneously-resident artifact count during the streaming fetch. */
  peakResident: number;
}

/**
 * A3 — BOUNDED-RESIDENCY STREAMING BYTE BUDGET.
 *
 * The isolate has 128MB. The judge needs room for the record, the checklist, the authority
 * structures, and the engine's own working memory. The byte budget bounds how much of the
 * 128MB is occupied by artifact bytes waiting to be written or hashed at any given moment.
 *
 * Math: 128MB total - ~40MB for the engine's runtime overhead = ~88MB available for artifact
 * bytes. The streaming window processes R2_READ_CONCURRENCY (24) entries at a time; each
 * batch's bytes are released before the next batch starts. The budget is a STATEMENT, not
 * a tuned constant — it exists so the comment is load-bearing rather than decorative.
 *
 * With the engine-read/hash-verify split, the resident set at any moment is:
 *   - The engine-read artifacts (JSON observations, ~3-12MB each, ~10-20 total = ~60-200MB)
 *   - One batch of hash-verify-only artifacts being processed (~24 * 59KB = ~1.4MB)
 *
 * The JSON observations MUST be resident because the engine reads them from disk (tmpdir),
 * which is memory-backed. They are the actual memory constraint, not the PNGs.
 *
 * IF THE ENGINE-READ SET ALONE EXCEEDS THE BUDGET, the loader cannot help — the engine
 * genuinely needs those files, and the authority needs to verify them on disk. In that case
 * the run reports partial verification honestly (see authority.mjs `manifestComplete`).
 */
export const STREAMING_BATCH_SIZE = R2_READ_CONCURRENCY;

/**
 * A3 — IS THIS ARTIFACT ONE THE ENGINE ACTUALLY READS FROM DISK?
 *
 * DETERMINED BY READING THE ACTUAL ACCESS PATTERNS in the judge engine:
 *
 *   evidence-store.mjs  `classifyArtifact` classifies by filename pattern, then `read()`
 *                        promotes by SHAPE (capture spine). Only PRIMARY_SESSION class is
 *                        kept by any consumer.
 *
 *   sessions.mjs        `loadSessions` iterates `store.listArtifacts()`, calls `store.read()`
 *                        on every `.json` file. ONLY artifacts whose evidenceClass ===
 *                        PRIMARY_SESSION (filename match OR shape promotion with a well-
 *                        formed capture spine) are normalized into sessions. Everything else
 *                        is either skipped (`continue`) or quarantined.
 *
 *   scope-attest.mjs    `ScopeAttestor.index()` and `.edges()` iterate all `.json` files the
 *                        same way. They keep only PRIMARY_SESSION artifacts (`continue` on
 *                        everything else). Files missing from disk return `ok: false` and are
 *                        harmlessly skipped.
 *
 *   engine.mjs          `attestAll` re-reads CITED witnesses from disk via `store.attest()`.
 *                        Witnesses are produced by predicates that iterate SESSIONS — so the
 *                        cited artifacts are always session observation files that are already
 *                        in the engine-read set.
 *
 *   engine.mjs          `crossCheckPriorClaim` reads prior-observation citations. This is
 *                        DIAGNOSTIC ONLY (`status: 'neutral-historical-claim'`). A missing
 *                        file returns `ok: false` and is reported as CITED_ARTIFACT_MISSING.
 *                        This never feeds a verdict.
 *
 * THE ENGINE-READ SET IS THEREFORE:
 *   1. Session observation files: names matching (FLOOR|EXP|TD|T\d)[-\w]*.json — the
 *      filename pattern `classifyArtifact` uses for PRIMARY_SESSION. These are ~35 for
 *      v100, 3–12 MB each.
 *   2. Primary probes: _targeted.json, _scale-probes.json — classified as PRIMARY_PROBE
 *      by `classifyArtifact`, potentially cited by answer-requirement predicates.
 *
 * EVERYTHING ELSE — step-XXX-slot.json (~4,650 per run), .accessibility.json (~4,650 per
 * run), derived summaries — is hash-verify-only. Those files reach the authority's manifest
 * via `preVerifiedArtifacts` so `manifestComplete` covers the full evidence set, but they
 * are never mounted to tmpdir.
 *
 * Files that COULD be sessions by shape but have non-standard names will be listed by the
 * authority's manifest, read by `loadSessions`, and get `CITED_ARTIFACT_MISSING` (quarantined
 * harmlessly). If such a file were the run's only session, the run would produce no sessions
 * and the verdicts would be NOT_ASSESSED — the honest outcome when evidence is not available,
 * and a NAMED limitation rather than an OOM crash.
 *
 * Byte math for the narrowed resident set (v100, 35 sessions):
 *   35 sessions x 12 MB worst-case = 420 MB — exceeds isolate budget
 *   35 sessions x  3 MB typical    = 105 MB — fits with engine overhead
 *   2 probes    x  1 MB            =   2 MB — negligible
 * A separate ENGINE_READ_BYTE_BUDGET check refuses runs whose session-only mount exceeds
 * a stated ceiling, with a NAMED limitation rather than an OOM crash.
 */
function isEngineReadArtifact(name: string): boolean {
  const b = name.split("/").pop() ?? name;
  // PRIMARY_SESSION filename pattern — from classifyArtifact (evidence-store.mjs). This
  // covers legacy v1 refs (`runs/<id>/artifacts/EXP-07.json`) and any capture whose pathId
  // family the engine names directly.
  if (/^(FLOOR|EXP|TD|T\d)[-\w]*\.json$/i.test(b)) return true;
  // WALKER SESSION LEAF — capture.ts writes every session observation as
  // `<artifactSlug(pathId)>-observation.json` (retries: `<slug>-retry-<n>-observation.json`),
  // so the `-observation.json` suffix identifies sessions INDEPENDENTLY of the pathId
  // prefix convention the pattern above keys on. Without this disjunct, a path family the
  // plan generator names outside (FLOOR|EXP|TD|T\d) — or a pathId carrying a `.` (legal in
  // the artifactSlug alphabet but unmatched by `[-\w]`) — would pass the engine's
  // shape-promotion yet never reach the mount, and the loss would surface as a misleading
  // CITED_ARTIFACT_MISSING quarantine. The walker owns this leaf name, so the suffix is a
  // codebase invariant, not a corpus convention.
  if (/-observation\.json$/i.test(b)) return true;
  // PRIMARY_PROBE — potentially cited by answer-requirement predicates
  if (b === "_targeted.json" || b === "_scale-probes.json") return true;
  return false;
}

/**
 * DEDUPLICATE identical catalogue entries before the collision check.
 *
 * A Workflow step that retries re-records its captures, so the catalogue may contain N
 * entries whose (basename, artifactRef, contentHash) triple is byte-identical. Those are
 * ONE artifact recorded N times, not N ambiguous artifacts. Collapse them (keep one) and
 * count the collapse.
 *
 * A basename that maps to two DIFFERENT artifactRefs or two different contentHashes is a
 * TRUE collision — the refusal fires exactly as before.
 */
function deduplicateEvidence(evidence: EvidenceCatalogEntry[]): { deduped: EvidenceCatalogEntry[]; collapsed: number } {
  const seen = new Map<string, EvidenceCatalogEntry>();
  let collapsed = 0;
  for (const entry of evidence) {
    const ref = String(entry.artifactRef ?? entry.sourceEvidenceId ?? entry.evidenceId);
    const name = ref.split("/").pop() ?? entry.evidenceId;
    const dedupeKey = `${name}\0${ref}\0${entry.contentHash}`;
    if (seen.has(dedupeKey)) {
      collapsed += 1;
    } else {
      seen.set(dedupeKey, entry);
    }
  }
  return { deduped: [...seen.values()], collapsed };
}

/**
 * RESOLVE SUPERSEDED RECORDINGS — same (basename, artifactRef), different contentHash.
 *
 * A Workflow step retry re-captures the same screens with different pixel content, so the
 * catalogue carries two entries whose (basename, ref) pair is identical but whose contentHash
 * differs. v100's dedupe collapses identical triples; these survive it and the collision
 * check fires on what is actually a retried recording, not an ambiguous identity.
 *
 * Resolution: for each conflicting group, fetch the stored blob for each unique contentHash,
 * hash it, and keep the entry whose blob exists and verifies. That entry is the LIVE recording.
 * Entries whose blob is missing or whose stored bytes hash to something other than their
 * declared contentHash are SUPERSEDED — excluded from the mount and counted.
 *
 * If the stored bytes match NONE of the entries, this is a genuine integrity failure and the
 * existing collision error fires with extended detail naming the ref and the fact that the
 * stored object matches no signed recording.
 *
 * A basename that maps to two DIFFERENT refs keeps the existing refusal untouched — that is
 * a true collision (two different artifacts sharing a name), not a retry.
 *
 * SUBREQUEST COST: one R2 GET per conflicting ref per unique contentHash. In the worst
 * observed run (588 conflicting refs), that is at most 588 GETs when each ref has exactly
 * two competing hashes and the first one verifies. The step runs under the 10-minute
 * PROJECTION_POLICY. Bytes are hashed and discarded unless the entry is the live one that
 * will be mounted, in which case they are kept and reused for the mount to avoid a double
 * fetch.
 */
interface SupersededResolution {
  resolved: EvidenceCatalogEntry[];
  superseded: number;
  /** Bytes already fetched for live entries whose blob was verified during resolution. */
  prefetchedBytes: Map<string, Uint8Array>;
  /** Refs whose stored bytes matched no competing entry — a genuine integrity failure. */
  integrityFailures: Array<{ name: string; ref: string; triedHashes: string[] }>;
}

async function resolveSupersededRecordings(
  env: Env,
  deduped: EvidenceCatalogEntry[],
): Promise<SupersededResolution> {
  // Group entries by (basename, artifactRef).
  const groups = new Map<string, EvidenceCatalogEntry[]>();
  for (const entry of deduped) {
    const ref = String(entry.artifactRef ?? entry.sourceEvidenceId ?? entry.evidenceId);
    const name = ref.split("/").pop() ?? entry.evidenceId;
    const groupKey = `${name}\0${ref}`;
    const group = groups.get(groupKey);
    if (group) group.push(entry);
    else groups.set(groupKey, [entry]);
  }

  // Groups of size 1 have no conflict. Groups where all entries share the same contentHash
  // were already collapsed by deduplicateEvidence. Conflict groups have 2+ entries with
  // at least two distinct contentHash values AND the same artifactRef.
  const conflictGroups: Array<{ name: string; ref: string; entries: EvidenceCatalogEntry[] }> = [];
  for (const [groupKey, entries] of groups) {
    if (entries.length < 2) continue;
    const hashes = new Set(entries.map((e) => e.contentHash));
    if (hashes.size < 2) continue;
    // All entries in this group share the same ref (by construction of the groupKey).
    const refs = new Set(entries.map((e) => String(e.artifactRef ?? e.sourceEvidenceId ?? e.evidenceId)));
    if (refs.size > 1) continue; // different refs -> true collision, handled by the caller
    const parts = groupKey.split("\0");
    conflictGroups.push({ name: parts[0]!, ref: parts[1]!, entries });
  }

  if (conflictGroups.length === 0) {
    return { resolved: deduped, superseded: 0, prefetchedBytes: new Map(), integrityFailures: [] };
  }

  // Resolve each conflict group by fetching the stored blob and comparing hashes.
  const supersededIds = new Set<string>();
  const prefetchedBytes = new Map<string, Uint8Array>();
  const integrityFailures: SupersededResolution["integrityFailures"] = [];

  for (const group of conflictGroups) {
    // SURVIVOR ORDER IS THE SHARED RULE, NOT ITERATION ORDER. Under content-addressed
    // storage BOTH competing blobs exist and verify, so "first hash that verifies"
    // degenerates to catalogue-listing order — which need not match the survivor the
    // record assembler kept (resolveRetryRecordings: latest capture wins), and a
    // record/mount disagreement is a hash-mismatch refusal at judge time. Trying the
    // shared rule's survivor FIRST keeps this resolver's blob-existence semantics
    // (a survivor whose blob is genuinely missing still falls through to the next)
    // while agreeing with the record in every healthy case.
    const ordered = [...group.entries].sort(retryRecencyOrder);
    const uniqueHashes = [...new Set(ordered.map((e) => e.contentHash))];
    let liveEntry: EvidenceCatalogEntry | null = null;
    let liveBytes: Uint8Array | null = null;

    for (const hash of uniqueHashes) {
      const obj = await env.EVIDENCE.get(evidenceBlobKey(hash));
      if (!obj) continue;
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const actualHash = await sha256Hex(bytes);
      if (actualHash === hash) {
        // This blob exists and verifies. The entry citing this hash is live.
        liveEntry = group.entries.find((e) => e.contentHash === hash) ?? null;
        liveBytes = bytes;
        break; // "Fetch the stored object ONCE" — stop at the first that verifies.
      }
    }

    if (!liveEntry) {
      // No blob matched any entry. Genuine integrity failure.
      integrityFailures.push({ name: group.name, ref: group.ref, triedHashes: uniqueHashes });
      continue;
    }

    // Keep the live entry, mark the rest as superseded.
    for (const entry of group.entries) {
      if (entry.evidenceId !== liveEntry.evidenceId) {
        supersededIds.add(entry.evidenceId);
      }
    }
    // Stash the bytes so the mount loop can reuse them instead of fetching twice.
    if (liveBytes) {
      prefetchedBytes.set(liveEntry.evidenceId, liveBytes);
    }
  }

  if (integrityFailures.length > 0) {
    // Convert integrity failures into a collision error with extended detail.
    const collisions = integrityFailures.map((f) => ({
      name: f.name,
      refs: [f.ref],
    }));
    throw new ArtifactNameCollision(
      collisions.map((c) => ({
        ...c,
        refs: [
          ...c.refs,
          `(stored bytes match none of ${integrityFailures.find((f) => f.name === c.name)?.triedHashes.length ?? 0} signed recording(s))`,
        ],
      })),
    );
  }

  const resolved = deduped.filter((e) => !supersededIds.has(e.evidenceId));
  return { resolved, superseded: supersededIds.size, prefetchedBytes, integrityFailures };
}

/**
 * BOUNDED-CONCURRENT ARTIFACT LOADING WITH PER-ENTRY DEMOTION.
 *
 * CONCURRENCY: R2_READ_CONCURRENCY (24) overlapping GETs. The subrequest COUNT is unchanged
 * from serial — the same number of GETs are issued, just overlapped. With 1 707 entries at
 * ~46ms per GET, serial takes ~78s; at 24-wide it is ~3.3s.
 * Math: 1 707 entries × 1 GET each = 1 707 subrequests for this phase. The full step
 * budget (wrangler.jsonc limits.subrequests = 100 000) also covers the LIST phase (~10
 * pages), the superseded-resolution GETs (~588 worst case), and the other stages' work.
 * 1 707 + 10 + 588 = 2 305, well within budget.
 *
 * DEMOTION (A4): a `getVerifiedEvidence` failure for ONE entry — missing blob, hash
 * mismatch, transient R2 error — records that entry as a NAMED per-item limitation
 * carried to the caller (and ultimately the judgement/report), never an uncaught throw
 * that fails the step. EXCEPT: `EvidenceCatalogTampered` signals stay loud because they
 * represent a security boundary violation (a catalogue entry whose derived id no longer
 * matches its own metadata — meaning somebody altered the mapping from citation to
 * content hash).
 */
export async function loadArtifactBytes(
  env: Env,
  evidence: EvidenceCatalogEntry[],
): Promise<LoadArtifactBytesResult> {
  const { deduped, collapsed } = deduplicateEvidence(evidence);

  // SUPERSEDED RECORDING RESOLUTION: same (basename, artifactRef), different contentHash.
  // Runs AFTER dedupe (which removes identical triples) and BEFORE the collision check
  // (which refuses any basename with 2+ entries). A retried step's re-capture produces
  // entries that survive dedupe but are not true collisions — one is the live recording
  // and the rest are superseded.
  const {
    resolved,
    superseded,
    prefetchedBytes,
  } = await resolveSupersededRecordings(env, deduped);

  // The collision check now runs on the resolved list, which no longer contains superseded
  // entries. A basename mapping to two DIFFERENT refs keeps the existing refusal.
  const byName = new Map<string, string[]>();
  for (const entry of resolved) {
    const ref = String(entry.artifactRef ?? entry.sourceEvidenceId ?? entry.evidenceId);
    const name = ref.split("/").pop() ?? entry.evidenceId;
    const refs = byName.get(name);
    if (refs) refs.push(ref);
    else byName.set(name, [ref]);
  }
  const collisions = [...byName.entries()]
    .filter(([, refs]) => refs.length > 1)
    .map(([name, refs]) => ({ name, refs }));
  if (collisions.length > 0) throw new ArtifactNameCollision(collisions);

  // BOUNDED-CONCURRENT FETCH + PER-ENTRY DEMOTION.
  //
  // Each entry's result is either { ok: true, artifact } or { ok: false, limitation }.
  // Tamper signals (`EvidenceCatalogTampered`) propagate through `mapConcurrent`'s
  // contract §3 (one rejection → whole pool rejects). Every other failure is caught
  // and recorded as a limitation.
  const results = await mapConcurrent(resolved, R2_READ_CONCURRENCY, async (entry) => {
    const ref = entry.artifactRef ?? entry.sourceEvidenceId ?? entry.evidenceId;
    const name = String(ref).split("/").pop() ?? entry.evidenceId;

    // Reuse bytes that were already fetched and verified during superseded resolution,
    // avoiding a second R2 GET for the same blob.
    const cached = prefetchedBytes.get(entry.evidenceId);
    if (cached) {
      return { ok: true as const, artifact: { name, bytes: cached } };
    }

    try {
      const { bytes } = await getVerifiedEvidence(env, entry);
      return { ok: true as const, artifact: { name, bytes } };
    } catch (err) {
      // TAMPER SIGNALS STAY LOUD — they are a security boundary violation, not a
      // recoverable data problem. Re-throw so `mapConcurrent` propagates them.
      if (err instanceof EvidenceCatalogTampered) throw err;

      // EVERYTHING ELSE IS DEMOTED to a per-item limitation. Missing blobs, hash
      // mismatches (`EvidenceIntegrityFailure`), transient R2 errors — each becomes
      // a named entry the caller carries to the report. The run proceeds over the
      // artifacts it CAN read rather than dying at its last step because one of
      // 9 340 blobs was missing.
      const reason =
        err instanceof EvidenceIntegrityFailure
          ? err.message
          : `failed to load evidence ${entry.evidenceId}: ${err instanceof Error ? err.message : String(err)}`;
      return {
        ok: false as const,
        limitation: { name, evidenceId: entry.evidenceId, reason } satisfies EvidenceLimitation,
      };
    }
  });

  const artifacts: Array<{ name: string; bytes: Uint8Array }> = [];
  const limitations: EvidenceLimitation[] = [];
  for (const r of results) {
    if (r.ok) artifacts.push(r.artifact);
    else limitations.push(r.limitation);
  }

  return {
    artifacts,
    duplicatesCollapsed: collapsed,
    supersededRecordings: superseded > 0 ? superseded : null,
    supersededNote: superseded > 0
      ? `${superseded} earlier recording(s) of retried steps were superseded by the bytes now in storage`
      : null,
    limitations,
  };
}

/**
 * A3 — MEMORY-SAFE ARTIFACT LOADING WITH BOUNDED RESIDENCY.
 *
 * The original `loadArtifactBytes` fetches every artifact's bytes into ONE in-memory array,
 * which `judge-runtime.mjs` then writes to a memory-backed tmpdir, and `authority.mjs`
 * reads back a THIRD time. Real run: ~9,000 step artifacts (~59KB PNGs) + observation JSONs
 * (3-12MB each) = far more than the isolate's 128MB.
 *
 * This function splits the load into two sets:
 *   - ENGINE-READ: JSON files the judge's engine opens via `readFileSync`. These stay in
 *     memory because they must be written to tmpdir. They are the small set.
 *   - HASH-VERIFY-ONLY: PNGs, PDFs, etc. Fetched in bounded batches (STREAMING_BATCH_SIZE),
 *     hashed, verified against the catalogue, and RELEASED — never written to tmpdir, never
 *     accumulated in a global array.
 *
 * The authority receives the pre-verified hashes for the hash-verify-only set so it can
 * set `manifestComplete` correctly without needing the blobs on disk.
 *
 * CONCURRENCY: same R2_READ_CONCURRENCY (24) as before, but the RESIDENT SET is bounded:
 * at most one batch of hash-verify-only artifacts is in memory at any time, plus the
 * engine-read set which accumulates (but is small — only JSON files).
 *
 * @param residencyHook — TEST HOOK for proving bounded residency. Called with the current
 *   simultaneously-resident artifact count each time a batch completes. Tests assert on the
 *   peak value to prove that the release step works. Not called in production (default no-op).
 */
export async function loadArtifactBytesStreaming(
  env: Env,
  evidence: EvidenceCatalogEntry[],
  residencyHook: (currentResident: number) => void = () => {},
): Promise<StreamingArtifactResult> {
  const { deduped, collapsed } = deduplicateEvidence(evidence);

  const {
    resolved,
    superseded,
    prefetchedBytes,
  } = await resolveSupersededRecordings(env, deduped);

  // Collision check — identical to loadArtifactBytes.
  const byName = new Map<string, string[]>();
  for (const entry of resolved) {
    const ref = String(entry.artifactRef ?? entry.sourceEvidenceId ?? entry.evidenceId);
    const name = ref.split("/").pop() ?? entry.evidenceId;
    const refs = byName.get(name);
    if (refs) refs.push(ref);
    else byName.set(name, [ref]);
  }
  const collisions = [...byName.entries()]
    .filter(([, refs]) => refs.length > 1)
    .map(([name, refs]) => ({ name, refs }));
  if (collisions.length > 0) throw new ArtifactNameCollision(collisions);

  // SPLIT: classify each entry as engine-read or hash-verify-only.
  const engineEntries: Array<{ entry: EvidenceCatalogEntry; name: string }> = [];
  const hashOnlyEntries: Array<{ entry: EvidenceCatalogEntry; name: string }> = [];
  for (const entry of resolved) {
    const ref = entry.artifactRef ?? entry.sourceEvidenceId ?? entry.evidenceId;
    const name = String(ref).split("/").pop() ?? entry.evidenceId;
    if (isEngineReadArtifact(name)) {
      engineEntries.push({ entry, name });
    } else {
      hashOnlyEntries.push({ entry, name });
    }
  }

  const engineRead: EngineReadDescriptor[] = [];
  const preVerifiedHashes = new Map<string, PreVerifiedArtifact>();
  const limitations: EvidenceLimitation[] = [];
  let peakResident = 0;

  // --- PHASE 1: Engine-read artifacts contribute DESCRIPTORS ONLY. ---
  //
  // A3b: the engine-read set (sessions, probes) is NOT fetched here. Instead,
  // each entry contributes a descriptor with its catalogue-level metadata. The
  // engine's async byte source fetches actual bytes on demand at read time,
  // streaming one session at a time through the R2-backed source. This is the
  // fix for the OOM: 112.8 MB of raw sessions never needs to be in memory at
  // once — only the ~1.89 MB projection of each session is retained, and the
  // raw buffer is released after each read.
  for (const { entry, name } of engineEntries) {
    engineRead.push({
      name,
      contentHash: withSha256Prefix(entry.contentHash),
      byteLength: entry.size ?? 0,
      entry,
    });
  }

  // Track residency: engine-read descriptors are lightweight (no bytes).
  let currentResident = engineRead.length;
  if (currentResident > peakResident) peakResident = currentResident;
  residencyHook(currentResident);

  // --- PHASE 2: Hash-verify-only artifacts in bounded batches. ---
  // Each batch's bytes are fetched, hashed, verified, and RELEASED before the next batch.
  // The batch size is STREAMING_BATCH_SIZE (24) — the same R2 concurrency bound.
  for (let batchStart = 0; batchStart < hashOnlyEntries.length; batchStart += STREAMING_BATCH_SIZE) {
    const batch = hashOnlyEntries.slice(batchStart, batchStart + STREAMING_BATCH_SIZE);

    // Fetch this batch concurrently.
    const batchResults = await mapConcurrent(batch, batch.length, async ({ entry, name }) => {
      const cached = prefetchedBytes.get(entry.evidenceId);
      if (cached) {
        // Already verified during superseded resolution — record the hash, release.
        return {
          ok: true as const,
          verified: { name, contentHash: withSha256Prefix(entry.contentHash), byteLength: cached.byteLength },
        };
      }
      try {
        const { bytes } = await getVerifiedEvidence(env, entry);
        // RELEASE: we only need the hash verification fact, not the bytes.
        const byteLength = bytes.byteLength;
        return {
          ok: true as const,
          verified: { name, contentHash: withSha256Prefix(entry.contentHash), byteLength },
        };
      } catch (err) {
        if (err instanceof EvidenceCatalogTampered) throw err;
        const reason =
          err instanceof EvidenceIntegrityFailure
            ? err.message
            : `failed to load evidence ${entry.evidenceId}: ${err instanceof Error ? err.message : String(err)}`;
        return {
          ok: false as const,
          limitation: { name, evidenceId: entry.evidenceId, reason } satisfies EvidenceLimitation,
        };
      }
    });

    // Process results: record verified hashes, accumulate limitations.
    let batchResident = 0;
    for (const r of batchResults) {
      if (r.ok) {
        preVerifiedHashes.set(r.verified.name, {
          contentHash: r.verified.contentHash,
          byteLength: r.verified.byteLength,
        });
        batchResident++;
      } else {
        limitations.push(r.limitation);
      }
    }

    // Track peak: engine-read set + this batch's in-flight count.
    const snapshot = engineRead.length + batchResident;
    if (snapshot > peakResident) peakResident = snapshot;
    residencyHook(snapshot);
    // RELEASE: the batch's bytes are now out of scope (getVerifiedEvidence's Uint8Array
    // goes unreachable once the closure exits). The next batch starts fresh.
  }

  return {
    engineRead,
    preVerifiedHashes,
    totalVerified: engineRead.length + preVerifiedHashes.size,
    peakResident,
    duplicatesCollapsed: collapsed,
    supersededRecordings: superseded > 0 ? superseded : null,
    supersededNote: superseded > 0
      ? `${superseded} earlier recording(s) of retried steps were superseded by the bytes now in storage`
      : null,
    limitations,
  };
}

/**
 * SIGNING KEYS ARE CONFIGURATION AND THEY ARE OPTIONAL, LOUDLY.
 *
 * `RECORD_SIGNING_KEY` attests the RunRecord this Worker assembled; `JUDGEMENT_SIGNING_KEY`
 * attests the JudgementRecord the judge mints, and its key id must appear in the pinned
 * `JUDGEMENT_KEY_REGISTRY` or the Worker's own trust boundary will reject the result it
 * just produced — deliberately, because a producer that could certify itself by existing is
 * not a trust boundary.
 *
 * Missing keys never fail a run. They downgrade it: unsigned record ⇒ unverified authority
 * ⇒ diagnostic-only judgement ⇒ a report with no current-results column, saying why.
 */
export interface SigningKeys {
  recordKeyPem: string | null;
  recordKeyId: string;
  judgementKeyPem: string | null;
  judgementKeyId: string;
}

interface SigningEnv {
  RECORD_SIGNING_KEY?: string;
  RECORD_SIGNING_KEY_ID?: string;
  JUDGEMENT_SIGNING_KEY?: string;
  JUDGEMENT_SIGNING_KEY_ID?: string;
}

export function signingKeys(env: Env): SigningKeys {
  const e = env as unknown as SigningEnv;
  // PEM through a `--var` or a secret arrives with literal "\n" escapes as often as not.
  const pem = (v: string | undefined) => (v && v.includes("PRIVATE KEY") ? v.replace(/\\n/g, "\n") : null);
  return {
    recordKeyPem: pem(e.RECORD_SIGNING_KEY),
    recordKeyId: e.RECORD_SIGNING_KEY_ID ?? "v2-producer-key-1",
    judgementKeyPem: pem(e.JUDGEMENT_SIGNING_KEY),
    judgementKeyId: e.JUDGEMENT_SIGNING_KEY_ID ?? "v2-judge-key-1",
  };
}

/**
 * A3b — BUILD AN R2-BACKED BYTE SOURCE FOR THE JUDGE ENGINE.
 *
 * The source is dumb transport: name -> catalogue entry -> evidenceBlobKey(contentHash)
 * (keys.ts:265, sharded two levels) -> env.EVIDENCE.get -> bytes. The store does all
 * verification (signed-manifest membership, hash-at-read, fresh attest re-fetch).
 *
 * @param env         The Worker env with the EVIDENCE R2 bucket binding.
 * @param descriptors The engine-read descriptors from loadArtifactBytesStreaming.
 *                    Maps artifact name -> catalogue entry with contentHash.
 */
export function buildR2Source(
  env: Env,
  descriptors: EngineReadDescriptor[],
): { names(): string[]; fetch(name: string): Promise<Uint8Array | null> } {
  const byName = new Map<string, EngineReadDescriptor>();
  for (const d of descriptors) byName.set(d.name, d);

  return {
    names() {
      return [...byName.keys()].sort();
    },
    async fetch(name: string): Promise<Uint8Array | null> {
      const d = byName.get(name);
      if (!d) return null;
      // The contentHash carries the sha256: prefix. Strip it to get the raw hex
      // digest that evidenceBlobKey expects.
      const hex = d.contentHash.replace(/^sha256:/, "");
      const key = evidenceBlobKey(hex);
      const obj = await env.EVIDENCE.get(key);
      if (!obj) return null;
      return new Uint8Array(await obj.arrayBuffer());
    },
  };
}

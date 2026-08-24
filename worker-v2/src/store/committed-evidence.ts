/**
 * THE COMMITTED-ATTEMPT EVIDENCE FILTER.
 *
 * WHY THIS EXISTS. Two production runs (v99, v100) refused at the judge stage because their
 * evidence catalogues carried rows written by Workflow step-retry-killed attempts that never
 * committed a walk to the execution ledger (progress.walks). The signed record, the judge's
 * manifest, and everything downstream inherited ~1,429 orphan rows that duplicated real
 * evidence under different attempt ids — and when the judge saw two rows with the same
 * artifactRef but different contentHashes, it refused with EVIDENCE_NAME_COLLISION over what
 * was actually a dead attempt's stale capture.
 *
 * THE RULE. An evidence row is KEPT if and only if:
 *
 *   1. Its `attemptId` is null — it is document-side evidence (extraction artefacts, source
 *      material) and carries no attempt provenance at all. These are exempt by definition:
 *      they were never produced by a walk.
 *
 *   2. Its `attemptId` appears in the committed walk ledger (`progress.walks[].attemptId`).
 *      The ledger is the durable record of every walk that ran to completion inside an
 *      attempt the executor acknowledged. An attempt id that is NOT in the ledger belongs
 *      to a Workflow step that was killed, retried, or abandoned — its evidence exists in
 *      storage but must not reach the record, the manifest, or the judge.
 *
 * SAME-REF DIFFERENT-HASH PAIRS. When two rows share the same artifactRef but come from
 * different attempts — one committed, one not — this filter keeps exactly the committed
 * attempt's row, deterministically, without fetching any bytes. This supersedes the
 * byte-fetching `resolveSupersededRecordings` path in `run-inputs.ts` for the retry-
 * duplicate case (that code remains for same-attempt collisions the other builder owns).
 *
 * MISSING LEDGER. A missing ledger is NOT treated as "no walks crashed" — it is treated as
 * "we cannot tell which attempts committed". The filter REFUSES LOUDLY: it throws rather
 * than silently passing everything through, because passing uncommitted evidence into a
 * signed record is the defect this module exists to prevent.
 *
 * COUNTED, NEVER SILENT. The return value carries exact counts and a plain-language sentence
 * suitable for the record and the judgement: "N evidence rows from uncommitted attempts
 * excluded; M document-side rows (no attemptId) retained." Absence (zero drops) is
 * distinguishable from "never looked" (the function was never called).
 */

import type { EvidenceCatalogEntry } from "../types/record";
import type { WalkRecord } from "../workflow/stages/execute-batch";

// ---------------------------------------------------------------------------
// PUBLIC INTERFACE
// ---------------------------------------------------------------------------

export interface CommittedEvidenceResult {
  /** Evidence rows whose attemptId is in the committed walk ledger, plus document-side rows. */
  kept: EvidenceCatalogEntry[];

  /**
   * Evidence rows whose attemptId is NOT null and NOT in the committed walk ledger.
   * These are orphans from killed/retried attempts.
   */
  droppedOrphans: EvidenceCatalogEntry[];

  /**
   * Evidence rows dropped because their attemptId was uncommitted AND another row with the
   * same artifactRef exists from a committed attempt. This is a strict subset of
   * `droppedOrphans` — the rows are counted in BOTH. The distinction exists so the report
   * sentence can say "of which K were superseded recordings of the same artifact".
   */
  droppedByRef: EvidenceCatalogEntry[];

  /**
   * A plain sentence for the record/judgement, always present. Examples:
   *   - "0 evidence rows from uncommitted attempts excluded; 12 document-side rows retained."
   *   - "47 evidence rows from uncommitted attempts excluded (3 were superseded recordings
   *     of the same artifact); 4 document-side rows retained."
   */
  sentence: string;
}

/**
 * AN EVIDENCE ROW IS MISSING ITS WALK LEDGER AND THE FILTER REFUSES TO GUESS.
 *
 * The message names what is missing, why guessing is dangerous, and what to do about it.
 * This is the fail-loud arm: the alternative — silently passing everything — is exactly
 * the behaviour that contaminated v99's signed manifest with 1,429 orphan rows.
 */
export class MissingWalkLedgerError extends Error {
  constructor() {
    super(
      "the committed-evidence filter requires the walk ledger (progress.walks) but it is " +
        "missing or null. Passing all evidence through without filtering would allow orphan " +
        "rows from killed attempts into the signed record — the exact defect this filter " +
        "exists to prevent. The caller must load the ledger before invoking this filter.",
    );
    this.name = "MissingWalkLedgerError";
  }
}

// ---------------------------------------------------------------------------
// THE FILTER
// ---------------------------------------------------------------------------

/**
 * Filter evidence rows to only those whose attemptId appears in the committed walk ledger,
 * plus document-side rows that carry no attemptId (null).
 *
 * @param evidence  The full evidence catalogue for the run.
 * @param walks     The committed walk ledger. null/undefined triggers a loud refusal.
 * @returns         The kept rows, the dropped rows, and a human-readable sentence.
 * @throws {MissingWalkLedgerError} when `walks` is null or undefined.
 */
export function filterCommittedEvidence(
  evidence: EvidenceCatalogEntry[],
  walks: WalkRecord[] | null | undefined,
): CommittedEvidenceResult {
  // -----------------------------------------------------------------------
  // MISSING LEDGER = REFUSE LOUDLY. "We cannot tell" is not "everything is fine."
  // A null ledger could mean the run never executed (legitimate — but then there should be
  // no walk-produced evidence either) or that the progress object was lost. Either way,
  // silently passing through is the wrong answer.
  // -----------------------------------------------------------------------
  if (walks == null) {
    throw new MissingWalkLedgerError();
  }

  // -----------------------------------------------------------------------
  // BUILD THE SET OF COMMITTED ATTEMPT IDS from the walk ledger. This is the ONLY source
  // of truth for which attempts completed and were acknowledged by the executor.
  // -----------------------------------------------------------------------
  const committedAttemptIds = new Set<string>();
  for (const walk of walks) {
    if (walk.attemptId) {
      committedAttemptIds.add(walk.attemptId);
    }
  }

  // -----------------------------------------------------------------------
  // BUILD AN INDEX OF COMMITTED ARTIFACT REFS so we can identify superseded recordings:
  // rows from uncommitted attempts that duplicate a committed attempt's artifact.
  // -----------------------------------------------------------------------
  const committedRefs = new Set<string>();
  for (const row of evidence) {
    if (row.attemptId != null && committedAttemptIds.has(row.attemptId) && row.artifactRef) {
      committedRefs.add(row.artifactRef);
    }
  }

  // -----------------------------------------------------------------------
  // PARTITION: kept vs dropped, with the superseded-by-ref subset tracked separately.
  // -----------------------------------------------------------------------
  const kept: EvidenceCatalogEntry[] = [];
  const droppedOrphans: EvidenceCatalogEntry[] = [];
  const droppedByRef: EvidenceCatalogEntry[] = [];
  let documentSideCount = 0;

  for (const row of evidence) {
    // RULE 1: document-side evidence (no attemptId) is always kept.
    if (row.attemptId == null) {
      kept.push(row);
      documentSideCount++;
      continue;
    }

    // RULE 2: walk-produced evidence is kept only if its attemptId is committed.
    if (committedAttemptIds.has(row.attemptId)) {
      kept.push(row);
      continue;
    }

    // This row's attempt is NOT in the ledger — it is an orphan.
    droppedOrphans.push(row);

    // Is this orphan also a superseded recording? (Same artifactRef exists from a committed attempt.)
    if (row.artifactRef && committedRefs.has(row.artifactRef)) {
      droppedByRef.push(row);
    }
  }

  // -----------------------------------------------------------------------
  // THE SENTENCE. Always present, distinguishable from "never ran the filter".
  // -----------------------------------------------------------------------
  const refDetail =
    droppedByRef.length > 0
      ? ` (${droppedByRef.length} were superseded recordings of the same artifact)`
      : "";
  const sentence =
    `${droppedOrphans.length} evidence rows from uncommitted attempts excluded${refDetail}; ` +
    `${documentSideCount} document-side rows (no attemptId) retained.`;

  return { kept, droppedOrphans, droppedByRef, sentence };
}

// ---------------------------------------------------------------------------
// RETRY-RECORDING SURVIVORS — one deterministic rule, used by BOTH the record
// assembler and the judge's load path.
// ---------------------------------------------------------------------------

export interface RetryRecordingResolution {
  /** The input minus every superseded retry recording. */
  resolved: EvidenceCatalogEntry[];
  /** The rows that lost — same (basename, artifactRef), different contentHash. */
  superseded: EvidenceCatalogEntry[];
  /** Plain sentence for the record: counted, never silent. */
  sentence: string;
}

/**
 * ORDER TWO RECORDINGS OF THE SAME REF: the survivor sorts FIRST.
 *
 * A COMMITTED Workflow-step retry re-captures the same screens under the same
 * refs with different bytes (both rows carry a committed attemptId, so the
 * committed-attempt filter rightly keeps both). Exactly one row may enter the
 * signed record — under content-addressed storage BOTH blobs exist and verify,
 * so bytes cannot adjudicate (gate attempt #4, measured: 20 such pairs reached
 * the signed catalogue and the authority refused with MANIFEST_DUPLICATE_ARTIFACT
 * x20). The rule that CAN adjudicate, deterministically and without a fetch:
 * the LATER capture supersedes the earlier (the retry exists because the first
 * write was interrupted); equal timestamps fall back to the lexicographically
 * greater contentHash — arbitrary but stable, and stated here rather than
 * hidden in iteration order.
 */
export function retryRecencyOrder(a: EvidenceCatalogEntry, b: EvidenceCatalogEntry): number {
  const at = String(a.capturedAt ?? "");
  const bt = String(b.capturedAt ?? "");
  if (at !== bt) return at > bt ? -1 : 1;
  const ah = String(a.contentHash ?? "");
  const bh = String(b.contentHash ?? "");
  if (ah !== bh) return ah > bh ? -1 : 1;
  return 0;
}

/**
 * Drop the superseded half of every retry-recording pair. Pure — no fetches,
 * no environment. Groups rows by (basename, artifactRef); a group is a retry
 * conflict when it has 2+ rows with 2+ distinct contentHashes and ONE ref.
 * Rows whose basename collides across DIFFERENT refs are left untouched —
 * that is a true collision and the existing refusal owns it.
 */
export function resolveRetryRecordings(entries: EvidenceCatalogEntry[]): RetryRecordingResolution {
  const groups = new Map<string, EvidenceCatalogEntry[]>();
  for (const entry of entries) {
    const ref = String(entry.artifactRef ?? entry.sourceEvidenceId ?? entry.evidenceId);
    const name = ref.split("/").pop() ?? entry.evidenceId;
    const key = `${name}\0${ref}`;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }

  const supersededIds = new Set<string>();
  const superseded: EvidenceCatalogEntry[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    if (new Set(group.map((e) => e.contentHash)).size < 2) continue;
    const ordered = [...group].sort(retryRecencyOrder);
    for (const loser of ordered.slice(1)) {
      if (!supersededIds.has(loser.evidenceId)) {
        supersededIds.add(loser.evidenceId);
        superseded.push(loser);
      }
    }
  }

  const resolved = supersededIds.size === 0 ? entries : entries.filter((e) => !supersededIds.has(e.evidenceId));
  const sentence =
    superseded.length === 0
      ? "0 superseded retry recordings excluded."
      : `${superseded.length} superseded retry recording(s) excluded — a committed step retry re-captured ` +
        `the same ref(s); the latest capture is the one the record carries.`;
  return { resolved, superseded, sentence };
}

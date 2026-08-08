/**
 * ONE VALIDATED INTERFACE AT THE RENDERER BOUNDARY.
 *
 * WHAT WAS WRONG (D12). Three components each had their own idea of what a RunRecord is:
 *
 *   - `types/record.ts` declared RunRecordV2 with no top-level `attempts` and no
 *     `findings`, and with `resources.modelCalls` / `resources.toolCalls` as NUMBERS;
 *   - `report/render.ts` refused to render anything missing `attempts` or `findings`, and
 *     passed `record.resources.modelCalls` straight into a parameter the shared renderer
 *     iterates as an ARRAY of per-call telemetry;
 *   - the shared view model reads `record.contract.items` for the register, which
 *     RunRecordV2 does not have at all — its requirements live in the sealed
 *     ContractRevision, by id.
 *
 * So a perfectly conforming RunRecordV2 could be assembled, stored, served by `/record`
 * with a verified integrity header — and then fail at render time, or render an empty
 * provenance table and a zero-row register. The smoke suite missed all of it because it
 * only ever seeded the legacy t1-easy record, which happens to satisfy the renderer.
 *
 * THE FIX IS A SINGLE DECLARED INTERFACE — `RenderableRecord` — that says exactly what
 * the shared renderer consumes, plus:
 *
 *   - `assertRenderable`, the ONE guard, replacing the ad-hoc "these nine keys are not
 *     undefined" list. It checks types, not merely presence, because `attempts: 4` passed
 *     the old check and broke the renderer;
 *   - `projectRunRecordV2`, a total, non-fabricating projection from RunRecordV2. Where
 *     v2 genuinely holds no counterpart it emits `null` and says so; it never invents a
 *     severity, a confidence or a count. Where the data lives in the sealed
 *     ContractRevision rather than the record, the projection takes it from the revision —
 *     which is the correct source, since §0 forbids a run from carrying its own
 *     denominator.
 *
 * Both shapes converge here, and `renderRunReport` accepts nothing else.
 */

import type { ContractRevision, RunRecordV2 } from "../types/record";
import { RUN_RECORD_KIND } from "../types/record";
// THE PROJECTION IS SHARED WITH THE JUDGE, NOT DUPLICATED HERE (D1).
//
// This module used to own the only RunRecordV2 -> legacy mapping in the repo, and
// `pipeline/judge/lib/authority.mjs` had no mapping at all — which is why a genuine signed
// v2 record could be RENDERED but never JUDGED, and why the only end-to-end fixture was a
// hand-authored hybrid carrying both spellings. One projection, two call sites.
// Typed by shared/v2-record.d.ts — the call sites are checked, not ignored.
import {
  projectV2ToLegacy as projectV2ToLegacyUntyped,
  ContractRevisionMismatch,
} from "../../shared/v2-record.mjs";

const projectV2ToLegacy = projectV2ToLegacyUntyped as (record: RunRecordV2, revision: ContractRevision) => RenderableRecord;

export interface RenderableItem {
  itemId: string;
  type: string | null;
  requirement: string | null;
  sourceAnchor: {
    locator: string | null;
    quote: string | null;
    aliases: string[];
    /**
     * Digests of the sealed revision's source atoms. A v2 ContractRevision carries no
     * source TEXT (merged-contract §A2 gives the stitched display quote zero identity
     * weight), so the checklist binder verifies the digest of a quote against these
     * instead of comparing display strings. See shared/v2-record.mjs.
     */
    quoteHashes?: string[] | null;
  } | null;
  expectedObservable: string | null;
  stimulus: string | null;
  preconditions: unknown[] | null;
  /**
   * null on a v2 record ON PURPOSE. AMENDMENT A retires renderer-chosen confidence
   * thresholds as a scope-integrity signal; v2 carries `assertionStatus` instead, and
   * inventing a number here would put a fabricated quantity in front of a reviewer.
   */
  confidence: number | null;
  assertionStatus?: string | null;
  testability?: string | null;
}

export interface RenderableItemResult {
  itemId: string;
  verdict: string;
  coverageStatus: string;
  reason: { code: string; summary: string } | null;
  evidenceRefs: string[];
  attemptRefs: string[];
  /**
   * The per-case results, carried through from the v2 record. This is the ONLY exact link
   * between a requirement the aggregator settled as failing and the observation that failed
   * it, and the report needs it to say what the survey actually did rather than only how
   * many requirements failed. Optional because the legacy harness shape has no cases.
   */
  facetResults?: Array<{ facetInstanceId?: string; routeId?: string; status?: string; observationIds?: string[] }>;
  pathConsistency?: string;
  divergenceSet?: string[];
  derivedBy?: string;
}

export interface RenderableFinding {
  findingId: string;
  kind: string;
  /** null when the source document does not carry one. Never defaulted to a value. */
  severity: string | null;
  supported: boolean | null;
  summary: string | null;
  itemRefs: string[];
  evidenceRefs: string[];
  attemptRefs: string[];
}

export interface RenderableRecord {
  schemaVersion: string;
  run: Record<string, unknown>;
  contract: {
    items: RenderableItem[];
    facetInstances?: unknown[];
    floorCases?: unknown[];
    assumptions?: unknown[];
    extraction?: unknown;
  };
  attempts: Array<Record<string, unknown>>;
  itemResults: RenderableItemResult[];
  findings: RenderableFinding[];
  evidence: Array<Record<string, unknown>>;
  resources: {
    modelCalls: unknown[];
    toolVersions: unknown[];
    totals?: Record<string, unknown>;
    limits?: Record<string, unknown>;
    [k: string]: unknown;
  };
  attestation: Record<string, unknown> | null;
  [k: string]: unknown;
}

export class NotRenderable extends Error {
  constructor(public readonly problems: string[]) {
    super(`not a renderable RunRecord: ${problems.join("; ")}`);
    this.name = "NotRenderable";
  }
}

export class ContractRevisionUnavailable extends Error {
  constructor(id: string | null) {
    super(
      id === null
        ? "this RunRecordV2 names no contract revision, so its requirement rows cannot be resolved"
        : `contract revision ${id} could not be read, so the register has no requirement rows to render`,
    );
    this.name = "ContractRevisionUnavailable";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * THE guard. Type-checked, not presence-checked: the previous version accepted any
 * defined value, so `attempts: 4` and `findings: "none"` both passed and then broke the
 * renderer at a point where the failure looks like a render bug rather than a bad record.
 */
export function assertRenderable(record: unknown): asserts record is RenderableRecord {
  const problems: string[] = [];
  if (!isObj(record)) throw new NotRenderable(["the document is not a JSON object"]);

  if (typeof record.schemaVersion !== "string") problems.push("schemaVersion must be a string");
  if (!isObj(record.run)) problems.push("run must be an object");
  if (!isObj(record.contract)) problems.push("contract must be an object");
  else if (!Array.isArray((record.contract as Record<string, unknown>).items)) {
    problems.push("contract.items must be an array (the register has one row per contract item)");
  }
  for (const k of ["attempts", "itemResults", "findings", "evidence"]) {
    if (!Array.isArray(record[k])) problems.push(`${k} must be an array`);
  }
  if (!isObj(record.resources)) problems.push("resources must be an object");
  else {
    const res = record.resources as Record<string, unknown>;
    if (!Array.isArray(res.modelCalls)) {
      problems.push("resources.modelCalls must be an ARRAY of per-call telemetry (the scalar count belongs in resources.totals)");
    }
    if (!Array.isArray(res.toolVersions)) problems.push("resources.toolVersions must be an array");
  }
  if (record.attestation !== null && !isObj(record.attestation)) {
    problems.push("attestation must be an object or null");
  }
  if (problems.length) throw new NotRenderable(problems);
}

// ---------------------------------------------------------------------------
// RunRecordV2 -> RenderableRecord
// ---------------------------------------------------------------------------

export const isRunRecordV2 = (record: unknown): record is RunRecordV2 =>
  isObj(record) && record.kind === RUN_RECORD_KIND;

/**
 * Project a RunRecordV2 onto the render interface.
 *
 * THE MAPPING IS NOT DEFINED HERE. It lives in `worker-v2/shared/v2-record.mjs` because
 * `pipeline/judge/lib/authority.mjs` needs the identical mapping to bind, allowlist and
 * judge the same record. Two mappings is D1: the report grew one, the judge never did, and
 * a genuine signed RunRecordV2 could therefore be rendered but never judged.
 *
 * The sealed ContractRevision is REQUIRED, because §0 forbids a run from carrying its own
 * denominator — the requirement rows live in the revision, and resolving them anywhere
 * else would re-create the run-regenerates-its-own-contract failure the seal prevents.
 */
export function projectRunRecordV2(record: RunRecordV2, revision: ContractRevision | null): RenderableRecord {
  if (!revision) throw new ContractRevisionUnavailable(record.contract?.contractRevisionId ?? null);
  try {
    return projectV2ToLegacy(record, revision);
  } catch (err) {
    if (err instanceof ContractRevisionMismatch) {
      throw new ContractRevisionUnavailable(record.contract?.contractRevisionId ?? null);
    }
    throw err;
  }
}

/**
 * The single entry point the report builder uses. A v2 record is projected; anything else
 * must already satisfy the render interface. Both paths end at `assertRenderable`, so
 * there is exactly one definition of "renderable" in the worker.
 */
export function toRenderable(record: unknown, revision: ContractRevision | null): RenderableRecord {
  const renderable = isRunRecordV2(record) ? projectRunRecordV2(record, revision) : (record as RenderableRecord);
  assertRenderable(renderable);
  return renderable;
}

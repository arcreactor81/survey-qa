/**
 * BUILD-AND-PUBLISH the report for a run.
 *
 * This is the function the Workflow's `report` step calls and the only writer of a run's
 * report artifacts. `GET /api/v2/runs/:id/report` serves the exact bytes this published;
 * it renders nothing itself, so what an owner reads in the browser is byte-identical to
 * what was committed at report time.
 *
 * TWO RULES THAT USED TO BE MISSING, AND THE FAILURES THEY ADMIT
 *
 * 1. THE RE-DERIVED COLUMN COMES FROM AN ATTESTED, RUN-BOUND JudgementRecord OR IT DOES
 *    NOT COME AT ALL. This used to be `readOptionalJson(judgementKey)`: any JSON that
 *    parsed drove the column, and a missing file degraded to `null` in silence. Deleting
 *    the object republished the run's own prose verdicts as the only column — the exact
 *    verdicts the first run's debrief caught asserting MATCHES_DOCUMENT over an artifact
 *    that proved the opposite — and copying another run's bundle in published its verdicts
 *    against this run's evidence. Both are now `unusable`, and `unusable` renders as a
 *    non-final operational diagnostic, never as results.
 *
 * 2. PUBLICATION IS ONE POINTER WRITE. The HTML and the ReportView used to be written to
 *    two fixed keys in sequence while the endpoint served any HTML it found before
 *    consulting completion. See store/publish.ts.
 *
 * FAILURE IS AN OUTCOME, NOT AN EXCEPTION. If there is no RunRecord to render, this
 * returns `{ ok: false, reasonCode }` and the caller marks `report: failed` with that
 * code. It must never mark `report: complete` with no artifact behind it.
 */

import type { Env } from "../types/env";
import { edgeCoverageKey, flagLanesKey, judgementKey, recordKey } from "../keys";
import { EvidenceIntegrityFailure, getVerifiedEvidence, listCatalog } from "../store/evidence";
import { loadCheckpoint } from "../store/checkpoint";
import { getEnvelope } from "../store/envelope";
import { ContractRevisionTampered, getContractRevision } from "../store/contract-revision";
import { loadJudgement } from "../store/judgement";
import { publishReport } from "../store/publish";
import { isRunRecordV2, NotRenderable, toRenderable } from "./renderable";
import { attestationFromRecordHash, judgementTrustFromLoad, renderRunReport, type RenderedReport } from "./render";
import type { JudgementLoad } from "../types/judgement";
import type { RunRecordV2 } from "../types/record";

export type BuildReportResult =
  | {
      ok: true;
      summary: RenderedReport["summary"] & {
        /**
         * TRUE ONLY for an attested, run-bound JudgementRecord. False means the register
         * has ONE column — the run's own prose verdicts — and those are historical, not
         * current.
         */
        derivedVerdicts: boolean;
        judgementState: JudgementLoad["state"];
        judgementSummary: string;
        flagLanes: boolean;
        buildId: string;
        final: boolean;
        /** Mirrors `rendered.summary`; carried so a caller can check agreement without re-rendering. */
        currentColumnId: string | null;
        hasCurrentResults: boolean;
      };
      bytes: number;
    }
  | { ok: false; reasonCode: string; detail: string };

export async function buildAndStoreReport(env: Env, runId: string): Promise<BuildReportResult> {
  const obj = await env.EVIDENCE.get(recordKey(runId));
  if (!obj) {
    return {
      ok: false,
      reasonCode: "no-run-record",
      detail: `no RunRecord at ${recordKey(runId)} — nothing to render a report from`,
    };
  }

  let record: unknown;
  try {
    record = JSON.parse(await obj.text());
  } catch (err) {
    return {
      ok: false,
      reasonCode: "run-record-unparseable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const loaded = await loadCheckpoint(env, runId);
  const cp = loaded?.checkpoint ?? null;
  const envelope = await getEnvelope(env, runId).catch(() => null);

  // THE DENOMINATOR IS RESOLVED FROM THREE AGREEING SOURCES, NOT FROM WHICHEVER ONE IS
  // PRESENT FIRST (D4).
  //
  // This was `cp?.contract.contractRevisionId ?? record.contract?.contractRevisionId`. The
  // `??` MASKS a disagreement: a record naming revision B under a checkpoint that sealed
  // revision A silently rendered A's requirement rows against B's results, and no check
  // anywhere compared them. The sealed revision is where a v2 run's requirement rows live
  // (§0: a run may not carry its own denominator), so a run whose own two records
  // disagree about which revision that is has no denominator at all.
  const cpRevisionId = cp?.contract.contractRevisionId ?? null;
  const recordRevisionId = isRunRecordV2(record) ? (record.contract?.contractRevisionId ?? null) : null;
  if (cpRevisionId !== null && recordRevisionId !== null && cpRevisionId !== recordRevisionId) {
    return {
      ok: false,
      reasonCode: "contract-revision-disagreement",
      detail:
        `the checkpoint for ${runId} sealed contract revision ${JSON.stringify(cpRevisionId)} and the stored ` +
        `RunRecord names ${JSON.stringify(recordRevisionId)}. One run cannot have two denominators; refusing to ` +
        `render one set of requirement rows against the other's results.`,
    };
  }
  const contractRevisionId = cpRevisionId ?? recordRevisionId;
  // The hash the record/checkpoint resolved the revision THROUGH, re-checked against the
  // hash its stored bytes actually produce. `getContractRevision` throws rather than
  // returning null when they disagree: altered bytes are not an absent revision.
  const expectedContractHash =
    cp?.contract.contractHash ?? (isRunRecordV2(record) ? (record.contract?.contractHash ?? null) : null);
  if (
    cp?.contract.contractHash != null &&
    isRunRecordV2(record) &&
    record.contract?.contractHash != null &&
    cp.contract.contractHash !== record.contract.contractHash
  ) {
    return {
      ok: false,
      reasonCode: "contract-revision-disagreement",
      detail:
        `the checkpoint for ${runId} carries contractHash ${JSON.stringify(cp.contract.contractHash)} and the ` +
        `stored RunRecord carries ${JSON.stringify(record.contract.contractHash)} for the same revision id.`,
    };
  }
  let revision;
  try {
    revision = contractRevisionId
      ? await getContractRevision(env, contractRevisionId, { contractHash: expectedContractHash })
      : null;
  } catch (err) {
    if (err instanceof ContractRevisionTampered) {
      return { ok: false, reasonCode: "contract-revision-tampered", detail: err.message };
    }
    throw err;
  }

  let renderable;
  try {
    renderable = toRenderable(record, revision);
  } catch (err) {
    if (err instanceof NotRenderable) return { ok: false, reasonCode: "run-record-invalid", detail: err.message };
    return {
      ok: false,
      reasonCode: "run-record-unrenderable",
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }

  const evidenceAudit = await auditEvidence(env, runId);

  // THE SECOND COLUMN, GATED. Four checks — present, schema-valid, attested against a
  // pinned key, bound to THIS run's durable state — and only `attested` may be rendered
  // as results. See store/judgement.ts for why each one exists.
  const judgement = await loadJudgement(env, {
    runId,
    record,
    contractRevisionId,
    contractHash: cp?.contract.contractHash ?? null,
    targetBuildId:
      envelope?.input.targetBuildId ?? (isRunRecordV2(record) ? (record as RunRecordV2).run?.targetBuildId ?? null : null),
  });
  if (judgement.state === "unusable") {
    console.error(
      `report: judgement for ${runId} is NOT usable as current results — ${judgement.problems
        .map((p) => `${p.code}: ${p.message}`)
        .join(" | ")}`,
    );
  }

  const flagLanes = await readOptionalJson(env, flagLanesKey(runId), "flag-lane sidecar");
  const edgeCoverage = await readOptionalJson(env, edgeCoverageKey(runId), "edge-coverage");
  const attestation = await attestationFromRecordHash(record);

  // THE DECISION, IN THE SHAPE THE RENDERER READS. The four gates above already decided
  // what this judgement may drive; this hands that decision to `buildRegister` instead of
  // letting it re-infer one from the presence of a payload. Without it an attested,
  // run-bound record was capped at `diagnostic`, the page said "there are NO current
  // results for this run", and the manifest for those same bytes said `final: true`.
  const judgementTrust = judgementTrustFromLoad(judgement, renderable, judgementKey(runId));

  let rendered: RenderedReport;
  try {
    rendered = renderRunReport({
      record: renderable,
      attestation,
      evidenceAudit,
      judgementTrust,
      // The record's own results are the only input when the judgement is not trusted.
      judgement:
        judgement.state === "attested"
          ? {
              judgementRecord: judgement.record,
              verdicts: judgement.record,
              routeTable: (judgement.record as { routeTable?: unknown }).routeTable ?? null,
              delta: null,
              summary: (judgement.record as { summary?: unknown }).summary ?? null,
            }
          : null,
      judgementDiagnostic:
        judgement.state === "absent"
          ? null
          : { state: judgement.state, summary: judgement.summary, problems: judgement.problems },
      flagLanes,
      edgeCoverage: edgeCoverage ?? undefined,
      downloads: [
        {
          label: "Signed RunRecord (canonical source)",
          href: `/api/v2/runs/${runId}/record`,
          note: "the authority for everything on this page",
        },
        {
          label: "Export manifest (every artifact + hash)",
          href: `/api/v2/runs/${runId}/export`,
          note: "built on demand from durable state",
        },
        {
          label: "Evidence catalog",
          href: `/api/v2/runs/${runId}/evidence`,
          note: "bytes are re-hashed on every fetch and fail closed on mismatch",
        },
      ],
    });
  } catch (err) {
    if (err instanceof NotRenderable) {
      return { ok: false, reasonCode: "run-record-invalid", detail: err.message };
    }
    return {
      ok: false,
      reasonCode: "render-failed",
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }

  const encoder = new TextEncoder();
  const htmlBytes = encoder.encode(rendered.html);
  // The Worker adds one field to the non-authoritative view: WHY there is no re-derived
  // column. A client that renders report-data must be able to say that in words rather
  // than showing a page that looks like it simply had nothing to compare against.
  const dataBytes = encoder.encode(
    JSON.stringify({
      ...(rendered.view as Record<string, unknown>),
      operationalDiagnostics: {
        judgement: {
          state: judgement.state,
          summary: judgement.summary,
          attestation: judgement.attestation,
          problems: judgement.problems,
          bindingChecks: judgement.bindingChecks,
          note:
            "Derived verdicts may drive current results only when a JudgementRecord is schema-valid, attested " +
            "against a pinned key, and bound to this run. Anything else is shown as a non-final diagnostic.",
        },
      },
    }),
  );

  // THE MANIFEST MAY NOT CONTRADICT THE PAGE IT NAMES.
  //
  // `final` used to be computed from the INPUTS (judgement state + completion) while the
  // page's own current-results claim was computed by the renderer. When the two came
  // apart — an attested judgement that never reached the register — the manifest said
  // `final: true` over a page that said "There are NO current results for this run".
  // A component reporting success about an artifact that contradicts it is the exact
  // failure this contract exists to delete, so the flag is now read OUT OF THE RENDERED
  // VIEW as well: a report is final only when the test axis closed, the verdicts are the
  // attested re-derived ones, AND the page itself says it carries current results.
  // ONE OBJECT DECIDES ALL THREE FACTS (D14b). `hasCurrentResults`, `currentColumnId` and
  // `final` used to be three independently-computed values that a reader had to correlate,
  // and the correlation was incomplete: the guard compared the judgement state against
  // `hasCurrentResults` but never against `currentColumnId`, so "attested / current /
  // column null" and "absent / no current results / column re-derived" both passed.
  const decision = decidePublication(runId, judgement.state, rendered.summary);
  if (!decision.ok) return decision;
  const publication = decision.publication;
  const final = publication.kind === "attested-current" && cp?.completion.test === "complete";

  let manifest;
  try {
    manifest = await publishReport(env, runId, {
      html: htmlBytes,
      data: dataBytes,
      summary: rendered.summary,
      judgement: { state: judgement.state, summary: judgement.summary },
      final,
    });
  } catch (err) {
    return {
      ok: false,
      reasonCode: "report-publication-failed",
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }

  return {
    ok: true,
    summary: {
      ...rendered.summary,
      derivedVerdicts: judgement.state === "attested",
      judgementState: judgement.state,
      judgementSummary: judgement.summary,
      flagLanes: flagLanes !== null,
      buildId: manifest.buildId,
      final,
    },
    bytes: htmlBytes.byteLength,
  };
}

/**
 * THE AGREEMENT CHECK — a component may not report success about an artifact that
 * contradicts it.
 *
 * An attested, run-bound judgement that does NOT become current results on the rendered
 * page means the report path dropped the trust decision somewhere between the judgement
 * boundary and the register. That is not a degraded report, it is two components
 * disagreeing about the same run: the Worker saying "attested, final" while the bytes it
 * is about to publish say "there are NO current results for this run". Publishing it
 * silently is exactly what happened, and it survived a full green suite either side.
 *
 * Exported so it can be tested for what it is — a rule — rather than only through the
 * happy path that can no longer reach it.
 */
export const RE_DERIVED_COLUMN_ID = "re-derived";

/**
 * THE PUBLICATION STATE, AS ONE DISCRIMINATED VALUE.
 *
 * There are exactly two publishable states and no third. `attested-current` carries a
 * column id that is always `re-derived` and `hasCurrentResults: true`; `no-current-results`
 * carries `null` and `false`. There is no representable value with a column and no current
 * results, or current results and no column, so the contradiction shapes D14(b) named
 * cannot be constructed — they are not merely rejected downstream.
 */
export type Publication =
  | { kind: "attested-current"; currentColumnId: typeof RE_DERIVED_COLUMN_ID; hasCurrentResults: true }
  | { kind: "no-current-results"; currentColumnId: null; hasCurrentResults: false };

/**
 * Decide it from the judgement state and what the RENDERED PAGE says about itself, failing
 * closed on any disagreement.
 *
 * `attested` IFF the page carries current results AND its current column is exactly the
 * re-derived one. A page that claims current results from some OTHER column while the
 * judgement is attested is not a happy path with a cosmetic difference: it means the
 * register published something that is not the attested re-derivation as this run's
 * current answer, which is the substitution failure wearing the right state name.
 */
export function decidePublication(
  runId: string,
  judgementState: JudgementLoad["state"],
  summary: Pick<RenderedReport["summary"], "hasCurrentResults" | "currentColumnId">,
): { ok: true; publication: Publication } | { ok: false; reasonCode: string; detail: string } {
  const said = `(hasCurrentResults=${summary.hasCurrentResults}, currentColumnId=${JSON.stringify(
    summary.currentColumnId,
  )})`;

  if (judgementState === "attested") {
    if (!summary.hasCurrentResults || summary.currentColumnId === null) {
      return {
        ok: false,
        reasonCode: "judgement-not-reflected-in-report",
        detail:
          `the judgement for ${runId} is attested and run-bound, but the rendered report claims no current results ` +
          `(currentColumnId=${JSON.stringify(summary.currentColumnId)}). The report path lost the trust decision; ` +
          `publishing would put a manifest that says final over a page that says nothing on it is current.`,
      };
    }
    if (summary.currentColumnId !== RE_DERIVED_COLUMN_ID) {
      return {
        ok: false,
        reasonCode: "current-column-is-not-the-re-derivation",
        detail:
          `the judgement for ${runId} is attested, and the rendered report names ` +
          `${JSON.stringify(summary.currentColumnId)} as its current column rather than ` +
          `${JSON.stringify(RE_DERIVED_COLUMN_ID)}. Only the attested re-derivation may be this run's current ` +
          `answer; publishing another column under an attested state would present unreviewed verdicts as reviewed.`,
      };
    }
    return {
      ok: true,
      publication: { kind: "attested-current", currentColumnId: RE_DERIVED_COLUMN_ID, hasCurrentResults: true },
    };
  }

  if (summary.hasCurrentResults || summary.currentColumnId !== null) {
    return {
      ok: false,
      reasonCode: "unattested-judgement-published-as-current",
      detail:
        `the judgement for ${runId} is ${judgementState}, but the rendered report claims current results from column ` +
        `${JSON.stringify(summary.currentColumnId)} ${said}. Only an attested, run-bound JudgementRecord may be current.`,
    };
  }
  return { ok: true, publication: { kind: "no-current-results", currentColumnId: null, hasCurrentResults: false } };
}

/**
 * The rule, in the boolean shape earlier callers and tests use. It is a projection of
 * `decidePublication`, not a second implementation — there is one decision.
 */
export function reportClaimsAgree(
  runId: string,
  judgementState: JudgementLoad["state"],
  summary: Pick<RenderedReport["summary"], "hasCurrentResults" | "currentColumnId">,
): { ok: true } | { ok: false; reasonCode: string; detail: string } {
  const d = decidePublication(runId, judgementState, summary);
  return d.ok ? { ok: true } : d;
}

/** Optional sidecar. Unreadable or malformed degrades to `null` and is logged, never thrown. */
async function readOptionalJson(env: Env, key: string, label: string): Promise<unknown> {
  const obj = await env.EVIDENCE.get(key);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text());
  } catch (err) {
    console.error(`report: ${label} at ${key} is not parseable JSON:`, err);
    return null;
  }
}

/**
 * EVIDENCE AUDIT — the in-Worker equivalent of the CLI renderer's `--artifacts-dir`
 * re-hash, and the same fail-closed rule: a link is offered only for bytes that were
 * fetched and re-hashed to the digest the catalog declares.
 *
 * "verified" here is not a claim copied out of the catalog. `getVerifiedEvidence` reads
 * the blob and re-computes its sha-256; anything that throws is recorded as `mismatch`
 * and the register renders the citation WITHOUT a link. Writing "verified" from metadata
 * alone would reproduce the t1-easy failure in a new place: a page asserting that a
 * cited artifact supports it, with nothing having actually looked at the artifact.
 */
export interface EvidenceAuditState {
  state: string;
  href?: string;
  note?: string;
}

/**
 * A Map whose entries can be found by EVERY id an evidence entry legitimately answers to,
 * while still enumerating one entry per artifact.
 *
 * D14(a) is exactly the gap between those two requirements. The register's resolver looks
 * an audit up by the STORAGE-side `evidenceId`; the record cites RECORD-side ids
 * (`EV-EXP-049.json`) and paths; and the trust card counts `values()` against the evidence
 * COUNT. Key it one way and the rows say "not checked" under a card that says "verified";
 * key it every way with plain `set` and the card says "partial" over a clean catalogue.
 * Aliasing on read satisfies both, and no alias can name an artifact it did not come from.
 */
export class EvidenceAuditMap extends Map<string, EvidenceAuditState> {
  private readonly aliases = new Map<string, string>();

  /** Point extra ids at a canonical entry. Empty/duplicate/self aliases are ignored. */
  alias(canonical: string, ...others: Array<string | null | undefined>): void {
    for (const other of others) {
      if (!other || other === canonical) continue;
      this.aliases.set(other, canonical);
      const base = other.split("/").pop();
      if (base && base !== canonical) this.aliases.set(base, canonical);
    }
  }

  override get(key: string): EvidenceAuditState | undefined {
    const direct = super.get(key);
    if (direct !== undefined) return direct;
    const canonical = this.aliases.get(key);
    return canonical === undefined ? undefined : super.get(canonical);
  }

  override has(key: string): boolean {
    return super.has(key) || (this.aliases.has(key) && super.has(this.aliases.get(key)!));
  }
}

async function auditEvidence(env: Env, runId: string): Promise<EvidenceAuditMap> {
  const audit = new EvidenceAuditMap();
  let catalog: Awaited<ReturnType<typeof listCatalog>>;
  try {
    catalog = await listCatalog(env, runId);
  } catch (err) {
    console.error(`report: evidence catalog unreadable for ${runId}:`, err);
    return audit;
  }

  let budget = AUDIT_BYTE_BUDGET;
  for (const e of catalog) {
    // D14(a): KEY UNDER EVERY NAMESPACE THE ENTRY ANSWERS TO.
    //
    // This map was keyed by `sourceEvidenceId ?? evidenceId` while the register's
    // evidence resolver looks the audit up by `catalogued.evidenceId` — the STORAGE-side
    // id — and the trust card counts `audit.values()`. When the two namespaces differ (a
    // record citing `EV-EXP-049.json` against a store minting `ev_<12>`), every value in
    // the map is present, so the card said "103 of 103 hash-verified", while every single
    // row resolved to nothing and rendered "not checked". Two truthful-looking components
    // contradicting each other about the same artifacts, which is the whole failure class.
    //
    // One entry, every id it can legitimately be cited by. No entry can be reached by a
    // key that does not name it, because both keys come from the same catalog entry.
    // The aliases resolve on `get`; `values()` and `size` stay ONE ENTRY PER ARTIFACT,
    // because the trust card compares `verified` against the evidence COUNT and a map
    // with three keys per artifact would report "partial" over a fully verified catalogue
    // — the same contradiction in the opposite direction.
    audit.alias(e.evidenceId, e.sourceEvidenceId ?? null, e.artifactRef ?? null);
    const put = (v: { state: string; href?: string; note?: string }) => audit.set(e.evidenceId, v);
    const href = `/api/v2/runs/${runId}/evidence/${e.evidenceId}/content`;
    if (e.size > budget) {
      // Say "not audited", never "verified". An unchecked artifact is not a checked one.
      put({ state: "missing", note: "not audited at render time: byte budget exhausted" });
      continue;
    }
    budget -= e.size;
    try {
      await getVerifiedEvidence(env, e);
      put({ state: "verified", href });
    } catch (err) {
      put({
        state: err instanceof EvidenceIntegrityFailure ? "mismatch" : "missing",
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return audit;
}

/** Bounds one report build's evidence re-hash so a huge run cannot OOM the isolate. */
const AUDIT_BYTE_BUDGET = 96 * 1024 * 1024;

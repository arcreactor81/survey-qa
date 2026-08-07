/**
 * Report, record and export endpoints.
 *
 * The status codes here are the contract from ui-report-redesign §7.6, and each one
 * encodes a decision worth keeping:
 *
 *   200 — ready report, INCLUDING a partial one. A partial run is a reportable outcome.
 *   202 — still building. `Retry-After` is polling guidance, NOT an ETA.
 *   200 + labelled failure summary — no final report exists but operational state does.
 *   409 ATTESTATION_INVALID — a purported final record fails verification. Fail closed.
 *   404 — only when the run is unknown or inaccessible.
 */

import type { Env } from "../types/env";
import { fail, json } from "./http";
import { isV2RunId } from "../ids";
import { exportManifestKey, flagLanesKey, judgementKey, recordKey, reportPointerKey } from "../keys";
import { loadCheckpoint } from "../store/checkpoint";
import { listCatalog } from "../store/evidence";
import { getContractRevision } from "../store/contract-revision";
import { checkRecordIntegrity } from "../store/record-integrity";
import { readReportPointer } from "../store/publish";
import type { RunRecordV2 } from "../types/record";

/**
 * GET /api/v2/runs/:id/report
 *
 * THE POINTER IS CONSULTED FIRST AND NOTHING ELSE IS ENUMERATED. This endpoint used to
 * fetch a fixed `report.html` key and serve whatever was there BEFORE looking at
 * completion state, so a half-written rebuild, or a stale report from a previous build
 * whose replacement had failed, was served as though it were the current final report.
 * `current.json` is written last by `store/publish.ts` and names one immutable version;
 * if it is absent, no report has been published, whatever bytes may be lying around.
 */
export async function getReport(_req: Request, env: Env, runId: string): Promise<Response> {
  if (!isV2RunId(runId)) return fail(404, "NOT_A_V2_RUN", `${runId} is not a survey-qa-v2 run id`);
  const loaded = await loadCheckpoint(env, runId);
  if (!loaded) return fail(404, "RUN_NOT_FOUND", `no v2 run ${runId}`);
  const cp = loaded.checkpoint;

  const pointer = await readReportPointer(env, runId);
  if (pointer) {
    const html = await env.EVIDENCE.get(pointer.artifacts.html.key);
    if (!html) {
      // The pointer names a version whose bytes are gone. Fail closed and say exactly
      // that, rather than falling back to some other build's HTML.
      return json(
        {
          state: "report-artifact-missing",
          final: false,
          label: `Published report ${pointer.buildId} names an artifact that is no longer stored`,
          pointer,
          completion: cp.completion,
        },
        { status: 200 },
      );
    }
    return new Response(html.body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-report-build-id": pointer.buildId,
        "x-report-final": String(pointer.final),
        // The one-word answer to "may the re-derived column be believed", available
        // without parsing the page.
        "x-judgement-state": pointer.judgement.state,
      },
    });
  }

  if (cp.completion.report === "building" || cp.completion.report === "not-started") {
    return json(
      {
        state: "building",
        message: "the report is being built",
        progressRevision: cp.revision,
        completion: cp.completion,
      },
      { status: 202, headers: { "retry-after": "10" } },
    );
  }

  // No final report, but there IS operational state. Return it, clearly labelled
  // non-final, rather than a bare 404 that hides everything the run did learn.
  //
  // A run whose checkpoint claims `report: complete` while no report artifact exists is
  // NOT a normal partial outcome — it is an internal inconsistency, and it gets its own
  // reasonCode so it can never be mistaken for an honest "the run stopped early".
  const inconsistent = cp.completion.report === "complete";
  return json(
    {
      state: inconsistent ? "report-artifact-missing" : "no-final-report",
      final: false,
      label: inconsistent
        ? "Report recorded complete but no report artifact is stored — operational snapshot only"
        : "Operational snapshot — not a final report",
      completion: cp.completion,
      phases: cp.phases,
      contract: cp.contract,
      counts: cp.counts,
      error: cp.error,
    },
    { status: 200 },
  );
}

/**
 * GET /api/v2/runs/:id/report-data — the non-authoritative ReportView.
 *
 * Resolved through the SAME pointer as the HTML, so the page and its data are always the
 * same build. Serving them from two independent fixed keys is what let them drift apart.
 */
export async function getReportData(_req: Request, env: Env, runId: string): Promise<Response> {
  if (!isV2RunId(runId)) return fail(404, "NOT_A_V2_RUN", `${runId} is not a survey-qa-v2 run id`);
  const pointer = await readReportPointer(env, runId);
  if (!pointer) return fail(404, "REPORT_DATA_NOT_FOUND", `no published report for ${runId}`);
  const obj = await env.EVIDENCE.get(pointer.artifacts.data.key);
  if (!obj) {
    return fail(
      409,
      "REPORT_ARTIFACT_MISSING",
      `published report ${pointer.buildId} names ${pointer.artifacts.data.key}, which is no longer stored`,
    );
  }
  return new Response(obj.body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-report-build-id": pointer.buildId,
      "x-judgement-state": pointer.judgement.state,
    },
  });
}

/**
 * GET /api/v2/runs/:id/record — the canonical RunRecord v2.
 *
 * Verified before it is served. A record whose stored hash does not match its bytes is a
 * 409, not a 200 with a warning: downstream (the scorer, the report, an auditor) treats
 * this document as authoritative, so serving an unverified one is worse than serving none.
 */
export async function getRecord(_req: Request, env: Env, runId: string): Promise<Response> {
  if (!isV2RunId(runId)) return fail(404, "NOT_A_V2_RUN", `${runId} is not a survey-qa-v2 run id`);
  const obj = await env.EVIDENCE.get(recordKey(runId));
  if (!obj) return fail(404, "RECORD_NOT_FOUND", `no run record for ${runId}`);
  const text = await obj.text();
  let record: RunRecordV2;
  try {
    record = JSON.parse(text) as RunRecordV2;
  } catch {
    return fail(409, "ATTESTATION_INVALID", "run record is not parseable JSON");
  }
  // ONE integrity checker, shared with the report header (store/record-integrity.ts).
  // Previously this compared only against `recordHash`, so a harness record carrying
  // `payloadHash` over the identical scope 409'd here while the report said "verified".
  const integrity = await checkRecordIntegrity(record);
  if (integrity.state === "invalid") {
    return fail(409, "ATTESTATION_INVALID", integrity.reason);
  }
  // `unavailable` is served with the reason in a header rather than refused: a record
  // with no digest to check is not a record that failed a check, and conflating the two
  // would make "unattested" indistinguishable from "tampered".
  return json(record, {
    headers: {
      "cache-control": "no-store",
      "x-record-integrity": integrity.state,
      "x-record-integrity-reason": integrity.reason.replace(/[^\x20-\x7e]/g, " ").slice(0, 300),
    },
  });
}

/**
 * GET /api/v2/runs/:id/export — the export manifest: everything needed to reproduce the
 * verdicts offline, listed with its hashes. Built on demand from durable state so an
 * export can never claim an artifact the bucket does not actually hold.
 */
export async function getExport(_req: Request, env: Env, runId: string): Promise<Response> {
  if (!isV2RunId(runId)) return fail(404, "NOT_A_V2_RUN", `${runId} is not a survey-qa-v2 run id`);
  const loaded = await loadCheckpoint(env, runId);
  if (!loaded) return fail(404, "RUN_NOT_FOUND", `no v2 run ${runId}`);
  const cp = loaded.checkpoint;

  const evidence = await listCatalog(env, runId);
  const contract = cp.contract.contractRevisionId
    ? await getContractRevision(env, cp.contract.contractRevisionId)
    : null;
  const pointer = await readReportPointer(env, runId);

  const manifest = {
    schemaVersion: "v2-export-manifest/1.0.0",
    runId,
    generatedAt: new Date().toISOString(),
    contract: {
      contractRevisionId: cp.contract.contractRevisionId,
      contractHash: cp.contract.contractHash,
      sealed: contract !== null,
      requirements: cp.contract.requirements.total,
      executionCases: cp.contract.total,
    },
    completion: cp.completion,
    counts: cp.counts,
    usage: cp.usage,
    artifacts: {
      record: recordKey(runId),
      // The published version, by pointer. Naming a fixed `report.html` key in an export
      // would promise an artifact whose contents depend on when the reader fetches it.
      reportPointer: reportPointerKey(runId),
      reportHtml: pointer?.artifacts.html.key ?? null,
      reportData: pointer?.artifacts.data.key ?? null,
      reportBuildId: pointer?.buildId ?? null,
      // Named even when absent: an export that silently omits the derived-verdict bundle
      // hides the fact that the report had only one column.
      judgement: judgementKey(runId),
      flagLanes: flagLanesKey(runId),
    },
    /** What the published report was allowed to claim. See store/judgement.ts. */
    judgement: pointer?.judgement ?? { state: "absent", summary: "no report has been published" },
    evidence: evidence.map((e) => ({
      evidenceId: e.evidenceId,
      // The id the RunRecord itself uses, when it differs — an offline reproducer needs
      // to match a cited artifact to a stored blob without guessing.
      sourceEvidenceId: e.sourceEvidenceId ?? null,
      contentHash: e.contentHash,
      mediaType: e.mediaType,
      size: e.size,
      type: e.type,
    })),
  };
  await env.EVIDENCE.put(exportManifestKey(runId), JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  return json(manifest);
}

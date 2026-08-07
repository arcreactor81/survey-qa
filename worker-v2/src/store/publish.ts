/**
 * ATOMIC REPORT PUBLICATION.
 *
 * A report is two artifacts — the HTML a person reads and the ReportView JSON a client
 * reads — and they must never be observable in disagreement. Writing them to two fixed
 * keys in sequence makes disagreement not just possible but ROUTINE: an isolate that dies
 * between the two puts of a rebuild leaves new HTML beside the previous build's data, and
 * `GET /report` served the HTML without ever consulting whether the build finished.
 *
 * The publication protocol here has exactly one commit point:
 *
 *   1. write the HTML under a content-derived, immutable version key;
 *   2. write the ReportView JSON under the same version's key;
 *   3. READ BOTH BACK and re-hash them — a report published without checking that its own
 *      bytes landed is the same "asserted, never verified" shape the evidence audit
 *      already refuses;
 *   4. write `current.json`, naming that version. THIS is publication.
 *
 * Everything before step 4 is invisible to the endpoint. Step 4 is a single object write,
 * so it either happened or it did not; there is no partial state to observe. A build that
 * fails at any earlier step leaves the previously published report exactly as it was,
 * which is the correct outcome — a failed rebuild must not delete a good report, and must
 * not silently replace it either.
 */

import type { Env } from "../types/env";
import { reportPointerKey, reportVersionDataKey, reportVersionHtmlKey } from "../keys";
import { sha256Hex } from "./hash";

export const REPORT_MANIFEST_KIND = "survey-qa-v2-report-manifest" as const;
export const REPORT_MANIFEST_SCHEMA = "v2-report-manifest/1.0.0" as const;

export interface ReportArtifactRef {
  key: string;
  sha256: string;
  bytes: number;
}

export interface ReportManifest {
  schemaVersion: typeof REPORT_MANIFEST_SCHEMA;
  kind: typeof REPORT_MANIFEST_KIND;
  runId: string;
  /** sha-256 over (html || data). Two identical builds publish the same version. */
  buildId: string;
  publishedAt: string;
  artifacts: { html: ReportArtifactRef; data: ReportArtifactRef };
  /** What the renderer said it rendered. Carried so a reader need not re-render to know. */
  summary: unknown;
  /**
   * Whether the derived verdicts could be trusted for this build. A report published with
   * `judgement.state !== "attested"` is explicitly NOT a certified result set.
   */
  judgement: { state: string; summary: string };
  /** false when the report describes a run whose test axis never closed. */
  final: boolean;
}

export class PublicationVerificationFailure extends Error {
  constructor(what: string, expected: string, actual: string) {
    super(`report publication aborted: ${what} read back as ${actual}, expected ${expected}. Nothing was published.`);
    this.name = "PublicationVerificationFailure";
  }
}

export interface PublishInput {
  html: Uint8Array;
  data: Uint8Array;
  summary: unknown;
  judgement: { state: string; summary: string };
  final: boolean;
}

export async function publishReport(env: Env, runId: string, input: PublishInput): Promise<ReportManifest> {
  const htmlHash = await sha256Hex(input.html);
  const dataHash = await sha256Hex(input.data);
  const buildId = (await sha256Hex(`${htmlHash}:${dataHash}`)).slice(0, 32);

  const htmlKey = reportVersionHtmlKey(runId, buildId);
  const dataKey = reportVersionDataKey(runId, buildId);

  await env.EVIDENCE.put(htmlKey, input.html, {
    httpMetadata: { contentType: "text/html; charset=utf-8", cacheControl: "no-store" },
  });
  await env.EVIDENCE.put(dataKey, input.data, {
    httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "no-store" },
  });

  // Read back and re-hash BEFORE publishing. This is the same rule the evidence endpoint
  // applies to a cited artifact: a claim that bytes are stored is not evidence that they
  // are, and the pointer is a claim the whole report path trusts afterwards.
  for (const [what, key, expected] of [
    ["report.html", htmlKey, htmlHash],
    ["report-data.json", dataKey, dataHash],
  ] as const) {
    const obj = await env.EVIDENCE.get(key);
    if (!obj) throw new PublicationVerificationFailure(what, expected, "<missing>");
    const actual = await sha256Hex(new Uint8Array(await obj.arrayBuffer()));
    if (actual !== expected) throw new PublicationVerificationFailure(what, expected, actual);
  }

  const manifest: ReportManifest = {
    schemaVersion: REPORT_MANIFEST_SCHEMA,
    kind: REPORT_MANIFEST_KIND,
    runId,
    buildId,
    publishedAt: new Date().toISOString(),
    artifacts: {
      html: { key: htmlKey, sha256: htmlHash, bytes: input.html.byteLength },
      data: { key: dataKey, sha256: dataHash, bytes: input.data.byteLength },
    },
    summary: input.summary,
    judgement: input.judgement,
    final: input.final,
  };

  // THE COMMIT. One object, written last.
  await env.EVIDENCE.put(reportPointerKey(runId), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
  });
  return manifest;
}

export async function readReportPointer(env: Env, runId: string): Promise<ReportManifest | null> {
  const obj = await env.EVIDENCE.get(reportPointerKey(runId));
  if (!obj) return null;
  try {
    const parsed = JSON.parse(await obj.text()) as ReportManifest;
    if (parsed.kind !== REPORT_MANIFEST_KIND) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Routing. Every path is under `/api/v2/` so that v2 and v1 could, if it ever became
 * desirable, sit behind one hostname without either shadowing the other's routes — even
 * though the deploy plan gives v2 its own hostname and its own Access application.
 */

import type { Env } from "../types/env";
import { fail, json } from "./http";
import { effectivePolicy } from "../types/env";
import {
  getCoverage,
  getExecutionActivity,
  getRunSummary,
  getStatus,
  getVisualStatus,
  submitRun,
} from "./runs";
import { getExport, getRecord, getReport, getReportData } from "./report";
import { getEvidenceContent, listEvidence } from "./evidence";
import { getScreens } from "./screens";
import { devSeed } from "./devseed";
import { devJudge } from "./devrun";
import { devDrive } from "../workflow/stages/dev-drive";
import { devExtract, devExtractResult } from "../workflow/stages/dev-extract";
import { NotAV2Run } from "../ids";
import { NamespaceViolation } from "../keys";
import { scopeEvidenceEnv } from "../store/evidence-keyspace";

const RUN_PATH = /^\/api\/v2\/runs\/([^/]+)(?:\/(.*))?$/;

/**
 * `ctx` is optional and used by exactly one route: the dev-only extraction trigger, which
 * runs two model passes over a whole document and cannot finish inside one HTTP response.
 * It returns immediately and continues under `waitUntil`.
 */
export async function route(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  try {
    // This is the HTTP storage boundary. Arm deployments share the physical bucket with
    // production, so every route receives a prefix-scoped binding before it can read or write.
    env = scopeEvidenceEnv(env);
    if (path === "/api/v2/health") {
      return json({
        ok: true,
        service: "survey-qa-v2",
        // Deliberately advertises the contract versions it speaks, so a client can tell
        // v1 and v2 apart from the response alone, not just from the hostname.
        contracts: [
          "run-status/2.0.0",
          "coverage-snapshot/1.0.0",
          "survey-qa-execution-activity/1.0.0",
          "run-record/2.0.0",
          "survey-qa-visual-status/1.0.0",
          "survey-qa-screen-evidence-page/1.0.0",
        ],
      });
    }

    if (path === "/api/v2/policy" && method === "GET") {
      // §4.2: the run form renders SERVER policy. It never displays what it asked for.
      return json({ policy: effectivePolicy(env, "standard", false) });
    }

    if (path === "/api/v2/runs" && method === "POST") return submitRun(req, env);

    // Local-dev fixture seeding. 404s (indistinguishably from any unknown path) unless
    // DEV_SEED === "enabled", which is NOT set in wrangler.jsonc and can only arrive via
    // `wrangler dev --var DEV_SEED:enabled`. See api/devseed.ts.
    if (path === "/api/v2/dev/seed" && method === "POST") return devSeed(req, env);
    // Same gate, same reason: drives the REAL judging stages over a seeded run so the
    // in-Worker judge can be exercised before extraction/planning/execution exist.
    if (path === "/api/v2/dev/judge" && method === "POST") return devJudge(req, env);
    // Same gate, same reason: seals a SUPPLIED coverage contract through the real sealer
    // and starts the real Workflow, so planning + browser execution can be driven against
    // a live survey before extraction exists. See workflow/stages/dev-drive.ts.
    if (path === "/api/v2/dev/drive" && method === "POST") return devDrive(req, env);
    // Same gate, same reason, opposite end of the pipeline: runs the REAL extraction stage
    // functions (pass A, pass B, merge/diff/ledger/expansion, seal) over an uploaded .docx
    // WITHOUT the Workflow. It exists because the Secrets Store bindings the two model legs
    // need resolve only under `wrangler dev --remote`, where the Workflow (undeployed) does
    // not — so this is the one way to exercise extraction against the real providers.
    if (path === "/api/v2/dev/extract" && method === "POST") return devExtract(req, env, ctx);
    if (path === "/api/v2/dev/extract" && method === "GET") return devExtractResult(req, env);

    const m = RUN_PATH.exec(path);
    if (m) {
      const runId = m[1] ?? "";
      const rest = m[2] ?? "";
      if (method !== "GET") return fail(405, "METHOD_NOT_ALLOWED", `${method} not allowed on ${path}`);

      if (rest === "") return getRunSummary(req, env, runId);
      if (rest === "status") return getStatus(req, env, runId);
      if (rest === "coverage") return getCoverage(req, env, runId);
      if (rest === "execution-activity") return getExecutionActivity(req, env, runId);
      if (rest === "visual-status") return getVisualStatus(req, env, runId);
      if (rest === "screens") return getScreens(req, env, runId);
      if (rest === "report") return getReport(req, env, runId);
      if (rest === "report-data") return getReportData(req, env, runId);
      if (rest === "record") return getRecord(req, env, runId);
      if (rest === "export") return getExport(req, env, runId);
      if (rest === "evidence") return listEvidence(req, env, runId);

      const ev = /^evidence\/([^/]+)\/content$/.exec(rest);
      if (ev) return getEvidenceContent(req, env, runId, ev[1] ?? "");

      return fail(404, "NOT_FOUND", `unknown run sub-resource: ${rest}`);
    }

    if (path.startsWith("/api/v2/")) return fail(404, "NOT_FOUND", `unknown endpoint ${path}`);
    return fail(404, "NOT_FOUND", `unknown endpoint ${path}`);
  } catch (err) {
    // These two are namespace guards, and a 500 would bury them. They mean a caller
    // tried to reach across the v1/v2 boundary, which is worth naming explicitly.
    if (err instanceof NotAV2Run) return fail(404, "NOT_A_V2_RUN", err.message);
    if (err instanceof NamespaceViolation) return fail(500, "NAMESPACE_VIOLATION", err.message);
    console.error("unhandled error:", err);
    return fail(500, "INTERNAL", err instanceof Error ? err.message : String(err));
  }
}

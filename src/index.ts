import { buildComparePrompt } from "./prompt";
import { verifyFindings, buildScorecard } from "./verify";
import { buildHtmlReport } from "./report";
import { getRun, putRun, shotKey, pagePdfKey, docxKey } from "./store";
import canon from "../spec/canon.json";
import type { Env, Finding, ModelRunStats, RunReport } from "./types";

export { RunWorkflow } from "./workflow";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function handleCreateRun(req: Request, env: Env): Promise<Response> {
  const origin = new URL(req.url).origin;
  let surveyUrl = "";
  let useSample = true;
  let docxBytes: ArrayBuffer | null = null;
  let docxName = "";

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    surveyUrl = String(form.get("surveyUrl") ?? "");
    useSample = String(form.get("useSample") ?? "true") === "true";
    const file = form.get("docx");
    if (!useSample && file && typeof file === "object" && "arrayBuffer" in file) {
      const f = file as File;
      if (f.size > 0) {
        docxBytes = await f.arrayBuffer();
        docxName = f.name;
      }
    }
  } else {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    surveyUrl = String(body.surveyUrl ?? "");
    useSample = body.useSample !== false;
  }

  if (!surveyUrl) return json({ error: "surveyUrl is required" }, 400);
  const resolvedUrl = surveyUrl.startsWith("http") ? surveyUrl : origin + surveyUrl;

  if (!docxBytes) {
    const res = await env.ASSETS.fetch(new Request(origin + "/sample/questionnaire.docx"));
    if (!res.ok) return json({ error: "bundled sample questionnaire.docx not found" }, 500);
    docxBytes = await res.arrayBuffer();
    docxName = "questionnaire.docx (bundled sample)";
    useSample = true;
  }

  // The seeded-error scorecard only applies to the bundled sample pair.
  const seeded = useSample && resolvedUrl.includes("/survey.html");

  const runId = crypto.randomUUID().slice(0, 8);
  const report: RunReport = {
    runId,
    surveyUrl: resolvedUrl,
    docxName,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    specText: "",
    pages: [],
    findings: [],
    stats: [],
    scorecard: null,
  };
  await env.ARTIFACTS.put(docxKey(runId), docxBytes, {
    httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  });
  await putRun(env, runId, { status: "processing", seeded, report });
  await env.RUN_WORKFLOW.create({ id: runId, params: { runId, surveyUrl: resolvedUrl, docxName, seeded } });

  return json({
    runId,
    status: "processing",
    reportUrl: `${origin}/reports/${runId}`,
    apiUrl: `${origin}/api/runs/${runId}`,
    next: `Poll the report URL; once the walk finishes, run the local Claude runner: node runner/claude-runner.mjs --worker-url ${origin} --run ${runId}`,
  });
}

async function handleSubmitFindings(req: Request, env: Env, runId: string): Promise<Response> {
  const envelope = await getRun(env, runId);
  if (!envelope) return json({ error: "run not found" }, 404);
  if (envelope.status === "processing") return json({ error: "run still processing" }, 409);

  const body = (await req.json().catch(() => null)) as {
    model?: string;
    modelId?: string;
    findings?: Array<Record<string, unknown>>;
    stats?: Partial<ModelRunStats>;
  } | null;
  if (!body || body.model !== "claude" || !Array.isArray(body.findings)) {
    return json({ error: "expected { model: 'claude', findings: [...], stats: {...} }" }, 400);
  }

  const report = envelope.report;
  // Replace any previous claude results (idempotent re-runs).
  report.findings = report.findings.filter((f) => f.model !== "claude");
  report.stats = report.stats.filter((s) => s.model !== "claude");

  const incoming: Finding[] = body.findings.map((f) => ({
    model: "claude",
    pageIndex: Number(f.pageIndex ?? 0),
    questionId: typeof f.questionId === "string" ? f.questionId : null,
    category: (f.category as Finding["category"]) ?? "other",
    severity: (f.severity as Finding["severity"]) ?? "medium",
    description: String(f.description ?? ""),
    specQuote: String(f.specQuote ?? ""),
    siteQuote: String(f.siteQuote ?? ""),
    quoteVerified: false,
  }));

  const verified = verifyFindings(incoming, report.specText, report.pages);
  report.findings.push(...verified);
  report.stats.push({
    model: "claude",
    modelId: String(body.stats?.modelId ?? body.modelId ?? "claude-code (subscription)"),
    calls: Number(body.stats?.calls ?? 0),
    inputTokens: Number(body.stats?.inputTokens ?? 0),
    outputTokens: Number(body.stats?.outputTokens ?? 0),
    costUsd: Number(body.stats?.costUsd ?? 0),
    latencyMsTotal: Number(body.stats?.latencyMsTotal ?? 0),
    errors: Number(body.stats?.errors ?? 0),
  });
  report.scorecard = envelope.seeded ? buildScorecard(report.findings, canon.seededErrors) : null;
  envelope.status = "complete";
  await putRun(env, runId, envelope);

  const claudeVerified = verified.filter((f) => f.quoteVerified).length;
  return json({ ok: true, accepted: verified.length, verified: claudeVerified, status: envelope.status });
}

const PROCESSING_PAGE = (runId: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5">
<title>Run ${runId} — processing</title>
<style>body{font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f6f7f9}
.card{background:#fff;padding:2rem 3rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center}</style>
</head><body><div class="card"><h2>Run ${runId} is processing&hellip;</h2>
<p>Walking the survey and running the model comparison.<br>This page refreshes automatically.</p></div></body></html>`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === "/api/run" && req.method === "POST") {
        return await handleCreateRun(req, env);
      }

      let m = path.match(/^\/api\/runs\/([\w-]+)$/);
      if (m && req.method === "GET") {
        const envelope = await getRun(env, m[1]);
        if (!envelope) return json({ error: "run not found" }, 404);
        // Flattened shape: the local runner reads .pages/.specText directly.
        return json({ ...envelope.report, status: envelope.status, seeded: envelope.seeded, error: envelope.error });
      }

      m = path.match(/^\/api\/runs\/([\w-]+)\/prompt\/(\d+)$/);
      if (m && req.method === "GET") {
        const envelope = await getRun(env, m[1]);
        if (!envelope) return json({ error: "run not found" }, 404);
        const pageIndex = Number(m[2]);
        const page = envelope.report.pages.find((p) => p.pageIndex === pageIndex);
        if (!page) return json({ error: `page ${pageIndex} not found` }, 404);
        return new Response(buildComparePrompt(envelope.report.specText, page.text, pageIndex), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      m = path.match(/^\/api\/runs\/([\w-]+)\/findings$/);
      if (m && req.method === "POST") {
        return await handleSubmitFindings(req, env, m[1]);
      }

      m = path.match(/^\/reports\/([\w-]+)$/);
      if (m && req.method === "GET") {
        const envelope = await getRun(env, m[1]);
        if (!envelope) return html("<h1>Run not found</h1>", 404);
        if (envelope.status === "processing") return html(PROCESSING_PAGE(m[1]));
        if (envelope.status === "failed") {
          return html(`<h1>Run ${m[1]} failed</h1><pre>${(envelope.error ?? "unknown").replace(/</g, "&lt;")}</pre>`, 500);
        }
        return html(buildHtmlReport(envelope.report));
      }

      m = path.match(/^\/reports\/([\w-]+)\/shot\/(\d+)\.png$/);
      if (m && req.method === "GET") {
        const obj = await env.ARTIFACTS.get(shotKey(m[1], Number(m[2])));
        if (!obj) return new Response("not found", { status: 404 });
        return new Response(obj.body, { headers: { "content-type": "image/png", "cache-control": "public, max-age=3600" } });
      }

      m = path.match(/^\/reports\/([\w-]+)\/pdf\/(\d+)\.pdf$/);
      if (m && req.method === "GET") {
        const obj = await env.ARTIFACTS.get(pagePdfKey(m[1], Number(m[2])));
        if (!obj) return new Response("not found", { status: 404 });
        return new Response(obj.body, { headers: { "content-type": "application/pdf", "cache-control": "public, max-age=3600" } });
      }

      if (path === "/api/health") return json({ ok: true, name: "survey-qa" });

      // Everything else falls through to static assets.
      return env.ASSETS.fetch(req);
    } catch (err) {
      console.error("unhandled error:", err);
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

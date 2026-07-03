import { buildComparePrompt } from "./prompt";
import { verifyFindings, buildScorecard } from "./verify";
import { buildHtmlReport } from "./report";
import { processingPage } from "./processing";
import { getRun, putRun, shotKey, pagePdfKey, docxKey } from "./store";
import { workersaiCompare } from "./llm/workersai";
import { isBlockedHostname } from "./net-guard";
import { MANIFESTS, SUPPORTED_LANGS } from "./manifests";
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

// ---------------------------------------------------------------------------
// Request hardening: rate limiting, SSRF validation, input sanitizing.
// Limits are deliberately demo-safe — the bundled same-origin sample survey
// and the local Claude runner must always keep working.
// ---------------------------------------------------------------------------

const MAX_UPLOAD_BODY_BYTES = 25 * 1024 * 1024; // whole multipart body
const MAX_DOCX_BYTES = 10 * 1024 * 1024; // generous for a questionnaire .docx
const MAX_FINDINGS_PER_SUBMISSION = 500;
const MAX_TEXT_FIELD_CHARS = 4000;

// Generous per-IP sliding windows: a human clicking around the demo stays far
// below these; only a runaway curl loop trips them.
const RUN_RATE = { windowMs: 60_000, max: 10 };
const HEALTH_RATE = { windowMs: 60_000, max: 6 };

// Per-isolate, KV-less counters. Reset on isolate recycle — fine, the goal is
// stopping denial-of-wallet loops, not perfect global accounting.
const rateHits = new Map<string, number[]>();

function allowRequest(key: string, limit: { windowMs: number; max: number }): boolean {
  const now = Date.now();
  if (rateHits.size > 5000) {
    // Opportunistic prune so the map cannot grow without bound.
    rateHits.forEach((hits, k) => {
      if ((hits[hits.length - 1] ?? 0) < now - 10 * 60_000) rateHits.delete(k);
    });
  }
  const cutoff = now - limit.windowMs;
  const hits = (rateHits.get(key) ?? []).filter((t) => t >= cutoff);
  if (hits.length >= limit.max) {
    rateHits.set(key, hits);
    return false;
  }
  hits.push(now);
  rateHits.set(key, hits);
  return true;
}

const clientIp = (req: Request): string => req.headers.get("cf-connecting-ip") ?? "unknown";

// Host validation (isBlockedHostname/isBlockedUrl) lives in ./net-guard so the
// walker's per-request interception applies the exact same rules to every
// redirect hop and subresource — not just the URL submitted here.

/**
 * Resolve and validate the requested survey URL. Same-origin targets (the
 * bundled demo survey, including relative paths like "/survey.html") are
 * always allowed; external targets must be public http(s) hosts.
 */
function resolveSurveyUrl(
  surveyUrl: string,
  origin: string
): { ok: true; url: string } | { ok: false; error: string } {
  const raw = surveyUrl.startsWith("http") ? surveyUrl : origin + surveyUrl;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "surveyUrl is not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "surveyUrl must be an http(s) URL" };
  }
  if (parsed.origin === origin) return { ok: true, url: raw }; // same-origin demo/sample path
  if (parsed.username || parsed.password) {
    return { ok: false, error: "surveyUrl must not embed credentials" };
  }
  if (isBlockedHostname(parsed.hostname)) {
    return { ok: false, error: "surveyUrl host is not allowed (private, loopback, and link-local addresses are blocked)" };
  }
  return { ok: true, url: raw };
}

/** Strip stack frames from a stored error: clients get the message line only. */
function firstLine(detail: string | undefined): string | undefined {
  if (!detail) return detail;
  const line = detail.split("\n", 1)[0] ?? "";
  return line.trim() || "run failed (see server logs)";
}

async function handleCreateRun(req: Request, env: Env): Promise<Response> {
  const origin = new URL(req.url).origin;
  let surveyUrl = "";
  let useSample = true;
  let lang = "en";
  let docxBytes: ArrayBuffer | null = null;
  let docxName = "";

  const declaredBytes = Number(req.headers.get("content-length") ?? "0");
  if (declaredBytes > MAX_UPLOAD_BODY_BYTES) {
    return json({ error: `request body too large (max ${MAX_UPLOAD_BODY_BYTES / (1024 * 1024)} MB)` }, 413);
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    surveyUrl = String(form.get("surveyUrl") ?? "");
    useSample = String(form.get("useSample") ?? "true") === "true";
    lang = String(form.get("lang") ?? "en").toLowerCase() || "en";
    const file = form.get("docx");
    if (file && typeof file === "object" && "arrayBuffer" in file) {
      const f = file as File;
      if (f.size > MAX_DOCX_BYTES) {
        return json({ error: `docx too large (max ${MAX_DOCX_BYTES / (1024 * 1024)} MB)` }, 413);
      }
      if (f.size > 0) {
        docxBytes = await f.arrayBuffer();
        docxName = f.name;
        useSample = false; // an attached docx always means "use my upload"
      }
    }
  } else {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    surveyUrl = String(body.surveyUrl ?? "");
    useSample = body.useSample !== false;
    lang = String(body.lang ?? "en").toLowerCase() || "en";
  }

  if (!surveyUrl) return json({ error: "surveyUrl is required" }, 400);
  if (!SUPPORTED_LANGS.includes(lang)) {
    return json({ error: `unsupported lang "${lang}" (supported: ${SUPPORTED_LANGS.join(", ")})` }, 400);
  }
  const resolved = resolveSurveyUrl(surveyUrl, origin);
  if (!resolved.ok) return json({ error: resolved.error }, 400);
  const resolvedUrl = resolved.url;

  if (!docxBytes) {
    const samplePath = lang === "en" ? "/sample/questionnaire.docx" : `/sample/questionnaire.${lang}.docx`;
    const res = await env.ASSETS.fetch(new Request(origin + samplePath));
    if (!res.ok) return json({ error: `bundled sample ${samplePath} not found` }, 500);
    docxBytes = await res.arrayBuffer();
    docxName = `questionnaire${lang === "en" ? "" : "." + lang}.docx (bundled sample)`;
    useSample = true;
  }

  // The seeded-error scorecard only applies to the bundled sample pair.
  const seeded = useSample && resolvedUrl.includes("/survey.html");

  const runId = crypto.randomUUID();
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
  await putRun(env, runId, { status: "processing", seeded, lang, report });
  try {
    await env.RUN_WORKFLOW.create({ id: runId, params: { runId, surveyUrl: resolvedUrl, docxName, seeded, lang } });
  } catch (err) {
    // Don't strand the run in "processing" — mark it failed so the report
    // page and the findings endpoint reflect reality.
    console.error(`RUN_WORKFLOW.create failed for run ${runId}:`, err);
    await putRun(env, runId, {
      status: "failed",
      seeded,
      lang,
      error: "the analysis workflow could not be started",
      report,
    });
    return json({ error: "failed to start the analysis workflow; please retry" }, 500);
  }

  return json({
    runId,
    status: "processing",
    reportUrl: `${origin}/reports/${runId}`,
    apiUrl: `${origin}/api/runs/${runId}`,
    next: `Poll the report URL; once the walk finishes, run the local Claude runner: node runner/claude-runner.mjs --worker-url ${origin} --run ${runId}`,
  });
}

const VALID_CATEGORIES: ReadonlySet<string> = new Set([
  "typo", "missing-option", "wrong-option-label", "broken-piping",
  "scale-mislabel", "reordered-options", "wrong-numbering",
  "encoding-artifact", "duplicated-word", "missing-instruction",
  "missing-question", "other",
]);
const VALID_SEVERITIES: ReadonlySet<string> = new Set(["high", "medium", "low"]);

const finiteNumber = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const boundedText = (v: unknown, max = MAX_TEXT_FIELD_CHARS): string =>
  typeof v === "string" ? v.slice(0, max) : "";

async function handleSubmitFindings(req: Request, env: Env, runId: string): Promise<Response> {
  const envelope = await getRun(env, runId);
  if (!envelope) return json({ error: "run not found" }, 404);
  if (envelope.status === "processing") return json({ error: "run still processing" }, 409);
  if (envelope.status === "failed") {
    return json({ error: "run failed before analysis completed; findings are not accepted" }, 409);
  }

  const body = (await req.json().catch(() => null)) as {
    model?: string;
    modelId?: string;
    findings?: Array<Record<string, unknown>>;
    stats?: Partial<ModelRunStats>;
  } | null;
  if (!body || body.model !== "claude" || !Array.isArray(body.findings)) {
    return json({ error: "expected { model: 'claude', findings: [...], stats: {...} }" }, 400);
  }
  if (body.findings.length > MAX_FINDINGS_PER_SUBMISSION) {
    return json({ error: `too many findings (max ${MAX_FINDINGS_PER_SUBMISSION})` }, 400);
  }

  const report = envelope.report;
  // Replace any previous claude results (idempotent re-runs).
  report.findings = report.findings.filter((f) => f.model !== "claude");
  report.stats = report.stats.filter((s) => s.model !== "claude");

  const maxPageIndex = Math.max(report.pages.length - 1, 0);
  const incoming: Finding[] = body.findings.map((f) => {
    const rawPage = Number(f.pageIndex ?? 0);
    return {
      model: "claude" as const,
      pageIndex: Number.isInteger(rawPage) ? Math.min(Math.max(rawPage, 0), maxPageIndex) : 0,
      questionId: typeof f.questionId === "string" ? f.questionId.slice(0, 200) : null,
      category:
        typeof f.category === "string" && VALID_CATEGORIES.has(f.category)
          ? (f.category as Finding["category"])
          : "other",
      severity:
        typeof f.severity === "string" && VALID_SEVERITIES.has(f.severity)
          ? (f.severity as Finding["severity"])
          : "medium",
      description: boundedText(f.description),
      specQuote: boundedText(f.specQuote),
      siteQuote: boundedText(f.siteQuote),
      quoteVerified: false,
    };
  });

  const verified = verifyFindings(incoming, report.specText, report.pages);
  report.findings.push(...verified);
  report.stats.push({
    model: "claude",
    modelId: String(body.stats?.modelId ?? body.modelId ?? "claude-code (subscription)").slice(0, 200),
    calls: finiteNumber(body.stats?.calls),
    inputTokens: finiteNumber(body.stats?.inputTokens),
    outputTokens: finiteNumber(body.stats?.outputTokens),
    costUsd: finiteNumber(body.stats?.costUsd),
    latencyMsTotal: finiteNumber(body.stats?.latencyMsTotal),
    errors: finiteNumber(body.stats?.errors),
  });
  report.scorecard = envelope.seeded
    ? buildScorecard(report.findings, MANIFESTS[envelope.lang ?? "en"] ?? MANIFESTS.en)
    : null;
  envelope.status = "complete";
  await putRun(env, runId, envelope);

  const claudeVerified = verified.filter((f) => f.quoteVerified).length;
  return json({ ok: true, accepted: verified.length, verified: claudeVerified, status: envelope.status });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === "/api/run" && req.method === "POST") {
        if (!allowRequest(`run:${clientIp(req)}`, RUN_RATE)) {
          return json({ error: "rate limit exceeded; wait a minute and retry" }, 429);
        }
        return await handleCreateRun(req, env);
      }

      let m = path.match(/^\/api\/runs\/([\w-]+)$/);
      if (m && req.method === "GET") {
        const envelope = await getRun(env, m[1]);
        if (!envelope) return json({ error: "run not found" }, 404);
        // Flattened shape: the local runner reads .pages/.specText directly.
        // envelope.error is trimmed to its message line (no stack traces).
        return json({
          ...envelope.report,
          status: envelope.status,
          seeded: envelope.seeded,
          error: firstLine(envelope.error),
        });
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
        if (envelope.status === "processing") return html(processingPage(m[1]));
        if (envelope.status === "failed") {
          console.error(`run ${m[1]} failed:`, envelope.error);
          const detail = (firstLine(envelope.error) ?? "unknown").replace(/</g, "&lt;");
          return html(`<h1>Run ${m[1]} failed</h1><pre>${detail}</pre>`, 500);
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

      // Cheap end-to-end probe of the Workers AI leg (no key required).
      // Rate-limited: each hit runs one real (billable) inference.
      if (path === "/api/health/workersai" && req.method === "GET") {
        if (!allowRequest(`health:${clientIp(req)}`, HEALTH_RATE)) {
          return json({ error: "rate limit exceeded; wait a minute and retry" }, 429);
        }
        try {
          const fakePage = {
            pageIndex: 0,
            text: "S1. Which option do you prefer?\nOption A\nOptoin B",
            navOk: true,
          };
          const r = await workersaiCompare(
            env,
            "S1. Which option do you prefer?\n- Option A\n- Option B",
            fakePage
          );
          return json({
            ok: true,
            model: env.WORKERSAI_MODEL ?? "@cf/zai-org/glm-4.7-flash",
            findings: r.findings,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            latencyMs: r.latencyMs,
          });
        } catch (err) {
          console.error("workersai health probe failed:", err);
          return json({ ok: false, error: "workers ai probe failed (see server logs)" }, 500);
        }
      }

      // Everything else falls through to static assets.
      return env.ASSETS.fetch(req);
    } catch (err) {
      console.error("unhandled error:", err);
      return json({ error: "internal error (see server logs)" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
